// 北冥 QA · 声音测量：对最终文件的音轨跑 EBU R128（ffmpeg ebur128，ITU-R BS.1770 门限积分、4 倍过采样真峰值），
// 以及给声画同步用的起音检测。
//
//   measureLoudness(file)   → { integrated, lra, truePeak, maxMomentary, maxShortTerm, threshold }（LUFS / LU / dBTP）
//   decodeMono(file, sr)    → Float32Array（声道平均，sr 默认 48000）
//   findOnset(x, sr, t, { early, late })   在 [t−early, t+late] 里找最像「这一下」的起音，返回
//        { t: 起音秒, riseDb, floorDb, peakDb, candidates } 或 null
//
// 起音的定义（docs/quality/QA-GATE.md「sync」）：先做一阶预加重突出瞬态，取 2 ms 窗、0.5 ms 步长的 RMS 包络；
// 候选点是包络比此前 5–20 ms 的底噪抬高 ≥ 9 dB 的局部峰；起音时刻取峰前包络首次越过「底噪 + 20%×(峰 − 底噪)」的位置（线性插值）。
// 用合成点击与短音实测，误差在 ±1.5 ms 内（tests/qa/sync.test.mjs）。
import { run, tool, tail } from './proc.mjs';
import { QaError, EXIT } from './cli-kit.mjs';

const db = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export async function measureLoudness(file, { timeoutMs } = {}) {
  const r = await run(tool('ffmpeg'), ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-map', '0:a:0', '-vn',
    '-af', 'ebur128=peak=true:metadata=1,ametadata=mode=print:file=-', '-f', 'null', '-'], { timeoutMs, maxStdout: 1 << 30 });
  if (r.code !== 0) throw new QaError('input.decode', `响度测量失败：${tail(r.stderr)}`, { exitCode: EXIT.GATE });
  let maxM = -Infinity, maxS = -Infinity, lastI = null, lastLRA = null, peak = 0;
  for (const line of r.stdout.toString('utf8').split(/\r?\n/)) {
    const m = /^lavfi\.r128\.(M|S|I|LRA|true_peak)=(-?[\d.]+|-?inf|nan)$/.exec(line.trim());
    if (!m) continue;
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'M' && v > -70) maxM = Math.max(maxM, v);
    else if (m[1] === 'S' && v > -70) maxS = Math.max(maxS, v);
    else if (m[1] === 'I') lastI = v;
    else if (m[1] === 'LRA') lastLRA = v;
    else if (m[1] === 'true_peak') peak = Math.max(peak, v);
  }
  const sum = /Summary:[\s\S]*?I:\s*(-?[\d.]+|-inf)\s*LUFS[\s\S]*?Threshold:\s*(-?[\d.]+|-inf)\s*LUFS[\s\S]*?LRA:\s*(-?[\d.]+)\s*LU[\s\S]*?Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(r.stderr);
  const integrated = lastI ?? (sum ? Number(sum[1]) : null);
  const tpSummary = sum ? Number(sum[4]) : null;
  return {
    integrated: Number.isFinite(integrated) ? integrated : -70,
    threshold: sum && Number.isFinite(Number(sum[2])) ? Number(sum[2]) : null,
    lra: lastLRA ?? (sum ? Number(sum[3]) : null),
    truePeak: peak > 0 ? +db(peak).toFixed(2) : (Number.isFinite(tpSummary) ? tpSummary : -Infinity),
    maxMomentary: Number.isFinite(maxM) ? +maxM.toFixed(2) : null,
    maxShortTerm: Number.isFinite(maxS) ? +maxS.toFixed(2) : null,
  };
}

export async function decodeMono(file, { sampleRate = 48000, timeoutMs } = {}) {
  const r = await run(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 'f32le', 'pipe:1'], { timeoutMs, maxStdout: 2 << 30 });
  if (r.code !== 0) throw new QaError('input.decode', `解码音轨失败：${tail(r.stderr)}`, { exitCode: EXIT.GATE });
  const b = r.stdout;
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + (b.length - (b.length % 4)));
  return new Float32Array(ab);
}

// 2 ms 窗 RMS 包络，步长 0.5 ms；emph = 预加重系数（0 = 全频带，0.97 = 突出高频瞬态）；只算 [s0, s1) 这段
function envelope(x, sr, s0, s1, emph) {
  const win = Math.max(8, Math.round(sr * 0.002)), hop = Math.max(1, Math.round(sr * 0.0005));
  const a = Math.max(1, s0), b = Math.min(x.length, s1);
  const n = Math.max(0, Math.floor((b - a - win) / hop));
  const env = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    const st = a + k * hop;
    for (let i = st; i < st + win; i++) { const y = x[i] - emph * x[i - 1]; s += y * y; }
    env[k] = Math.sqrt(s / win);
  }
  // 包络第 k 点代表窗中心；win 用于把「越过阈值的窗中心」换算回信号起点（见 onsetIn 的偏差修正）
  return { env, t0: (a + win / 2) / sr, hop: hop / sr, win: win / sr };
}

// 全频带与高频强调两路各找一次，取抬升更大的那一路（低沉的撞击与清脆的点击都能抓到）
export function findOnset(x, sr, t, opts = {}) {
  const a = onsetIn(x, sr, t, { ...opts, emph: 0 });
  const b = onsetIn(x, sr, t, { ...opts, emph: 0.97 });
  if (!a) return b;
  if (!b) return a;
  return b.riseDb > a.riseDb + 3 ? b : a;
}

function onsetIn(x, sr, t, { early = 0.15, late = 0.25, minRiseDb = 9, emph = 0 } = {}) {
  const pre = 0.03;
  const s0 = Math.floor((t - early - pre) * sr), s1 = Math.ceil((t + late + 0.03) * sr);
  const { env, t0, hop, win } = envelope(x, sr, Math.max(1, s0), s1, emph);
  if (env.length < 8) return null;
  const k0 = Math.max(0, Math.round((t - early - t0) / hop)), k1 = Math.min(env.length - 1, Math.round((t + late - t0) / hop));
  const fl0 = Math.round(0.005 / hop), fl1 = Math.round(0.02 / hop);
  const floorAt = k => {
    const a = Math.max(0, k - fl1), b = Math.max(0, k - fl0);
    if (b <= a) return env[0];
    const seg = Array.from(env.subarray(a, b)).sort((p, q) => p - q);
    return seg[Math.floor(seg.length / 2)];
  };
  const cands = [];
  for (let k = Math.max(1, k0); k <= k1; k++) {
    if (!(env[k] >= env[k - 1] && env[k] >= (env[k + 1] ?? 0))) continue;
    // 峰：往后 10 ms 内的最大值
    let pk = k;
    for (let j = k; j <= Math.min(env.length - 1, k + Math.round(0.01 / hop)); j++) if (env[j] > env[pk]) pk = j;
    if (pk !== k) continue;
    const fl = floorAt(k);
    const rise = db(env[k] + 1e-9) - db(fl + 1e-9);
    if (rise < minRiseDb) continue;
    cands.push({ k, rise, fl, pk: env[k] });
  }
  if (!cands.length) return null;
  // 先取最强的；若另一个候选的抬升不低于最强的 70% 且更靠近事件时刻，取那一个
  cands.sort((a, b) => b.rise - a.rise);
  let best = cands[0];
  for (const c of cands.slice(1)) {
    if (c.rise >= 0.7 * best.rise && Math.abs(t0 + c.k * hop - t) < Math.abs(t0 + best.k * hop - t)) best = c;
  }
  const thr = best.fl + 0.2 * (best.pk - best.fl);
  let k = best.k;
  while (k > 0 && env[k - 1] >= thr) k--;
  const kk = k > 0 ? k - 1 + (thr - env[k - 1]) / Math.max(1e-12, env[k] - env[k - 1]) : 0;
  // 窗中心越过 20% 阈值时，稳态信号只进窗 4%：起点 ≈ 中心 − 0.46×窗长，修正回去
  return {
    t: +(t0 + kk * hop + 0.46 * win).toFixed(5),
    riseDb: +best.rise.toFixed(1),
    floorDb: +db(best.fl + 1e-9).toFixed(1),
    peakDb: +db(best.pk + 1e-9).toFixed(1),
    candidates: cands.length,
  };
}
