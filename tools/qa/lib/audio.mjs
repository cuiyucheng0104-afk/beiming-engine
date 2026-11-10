// 北冥 QA · 声音测量：对最终文件的音轨跑 EBU R128（ffmpeg ebur128，ITU-R BS.1770 门限积分、4 倍过采样真峰值），
// 以及给声画同步用的起音检测。
//
//   measureLoudness(file)   → { integrated, lra, truePeak, maxMomentary, maxShortTerm, threshold }（LUFS / LU / dBTP）
//   decodeMono(file, sr)    → Float32Array（声道平均，sr 默认 48000）
//   findOnset(x, sr, t, { early, late, minRiseDb })   在 [t−early, t+late] 里找最像「这一下」的起音，返回
//        { t: 起音秒, riseDb, floorDb, peakDb, band, candidates } 或 null
//
// 起音的定义（docs/quality/QA-GATE.md「sync」）：把这一段分成全频带、150–1000 Hz、1–4 kHz、4–12 kHz 四路（RBJ 带通各串两级），
// 每路取 2 ms 窗、0.5 ms 步长的 RMS 包络；候选点是包络比此前 5–20 ms 的底噪抬高 ≥ minRiseDb（默认 8 dB）的局部峰；
// 四路的候选放在一起，取抬升最大的，若另一个候选抬升不低于它的 70% 且更靠近事件时刻，取那一个（混音里低频很满时，
// 界面提示音这类高频短音只在它自己的频带里看得出抬升）。起音时刻取峰前包络首次越过「底噪 + 20%×(峰 − 底噪)」的位置（线性插值）。
// 用合成点击、短音与「低频垫底上的弱提示音」实测，误差在 ±1.5 ms 内（tests/qa/sync.test.mjs）。
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
    '-f', 'f32le', 'pipe:1'], { timeoutMs, maxStdout: 2 ** 31 });
  if (r.code !== 0) throw new QaError('input.decode', `解码音轨失败：${tail(r.stderr)}`, { exitCode: EXIT.GATE });
  const b = r.stdout;
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + (b.length - (b.length % 4)));
  return new Float32Array(ab);
}

// RBJ 带通（0 dB 峰值增益），对 x[a..b) 原地生成新数组；两级串联让带外衰减更陡
function bandpass(x, sr, lo, hi, a, b) {
  const f0 = Math.sqrt(lo * hi), Q = f0 / (hi - lo), w0 = 2 * Math.PI * f0 / sr, al = Math.sin(w0) / (2 * Q);
  const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w0) / a0, a2 = (1 - al) / a0;
  let y = Float32Array.from(x.subarray(a, b));
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; out[i] = v;
    }
    y = out;
  }
  return y;
}

// 2 ms 窗 RMS 包络，步长 0.5 ms；sig 是从样本 base 开始的一段
function envelope(sig, sr, base) {
  const win = Math.max(8, Math.round(sr * 0.002)), hop = Math.max(1, Math.round(sr * 0.0005));
  const n = Math.max(0, Math.floor((sig.length - win) / hop));
  const env = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    const st = k * hop;
    for (let i = st; i < st + win; i++) s += sig[i] * sig[i];
    env[k] = Math.sqrt(s / win);
  }
  // 包络第 k 点代表窗中心；win 用于把「越过阈值的窗中心」换算回信号起点（见 onsetIn 的偏差修正）
  return { env, t0: (base + win / 2) / sr, hop: hop / sr, win: win / sr };
}

export const ONSET_BANDS = [['全频带', null, null], ['150–1000 Hz', 150, 1000], ['1–4 kHz', 1000, 4000], ['4–12 kHz', 4000, 12000]];

export function findOnset(x, sr, t, { early = 0.15, late = 0.25, minRiseDb = 8 } = {}) {
  const warm = 0.05, pre = 0.03;
  const a = Math.max(0, Math.floor((t - early - pre - warm) * sr)), b = Math.min(x.length, Math.ceil((t + late + 0.03) * sr));
  if (b - a < sr * 0.02) return null;
  const all = [];
  for (const [band, lo, hi] of ONSET_BANDS) {
    if (hi && hi >= sr / 2) continue;
    const sig = lo ? bandpass(x, sr, lo, hi, a, b) : x.subarray(a, b);
    const skip = lo ? Math.round(warm * sr) : 0;   // 带通的起振段不用
    for (const c of onsetIn(sig.subarray(skip), sr, a + skip, t, { early, late, minRiseDb })) all.push({ ...c, band });
  }
  if (!all.length) return null;
  all.sort((p, q) => q.rise - p.rise);
  let best = all[0];
  for (const c of all.slice(1)) if (c.rise >= 0.7 * best.rise && Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
  return { t: best.t, riseDb: +best.rise.toFixed(1), floorDb: +best.floorDb.toFixed(1), peakDb: +best.peakDb.toFixed(1), band: best.band, candidates: all.length };
}

// 一路包络里的全部候选：{ t: 起音秒, rise, floorDb, peakDb }
function onsetIn(sig, sr, base, t, { early, late, minRiseDb }) {
  const { env, t0, hop, win } = envelope(sig, sr, base);
  if (env.length < 8) return [];
  const k0 = Math.max(1, Math.round((t - early - t0) / hop)), k1 = Math.min(env.length - 2, Math.round((t + late - t0) / hop));
  const fl0 = Math.round(0.005 / hop), fl1 = Math.round(0.02 / hop);
  const floorAt = k => {
    const lo = Math.max(0, k - fl1), hi = Math.max(0, k - fl0);
    if (hi <= lo) return env[0];
    const seg = Array.from(env.subarray(lo, hi)).sort((p, q) => p - q);
    return seg[Math.floor(seg.length / 2)];
  };
  // 太轻的「抬升」不算：峰值低于 −70 dBFS（正常监听电平下听不见），或比这一路搜索窗里最响处低 30 dB 以上（底噪起伏）
  let loud = 0;
  for (let k = k0; k <= k1; k++) if (env[k] > loud) loud = env[k];
  const audible = Math.max(10 ** (-70 / 20), loud * 10 ** (-30 / 20));
  const out = [];
  for (let k = k0; k <= k1; k++) {
    if (!(env[k] >= env[k - 1] && env[k] >= env[k + 1]) || env[k] < audible) continue;
    // 峰：往后 10 ms 内的最大值
    let pk = k;
    for (let j = k; j <= Math.min(env.length - 1, k + Math.round(0.01 / hop)); j++) if (env[j] > env[pk]) pk = j;
    if (pk !== k) continue;
    const fl = floorAt(k);
    const rise = db(env[k] + 1e-9) - db(fl + 1e-9);
    if (rise < minRiseDb) continue;
    const thr = fl + 0.2 * (env[k] - fl);
    let j = k;
    while (j > 0 && env[j - 1] >= thr) j--;
    const jj = j > 0 ? j - 1 + (thr - env[j - 1]) / Math.max(1e-12, env[j] - env[j - 1]) : 0;
    // 阶跃信号的 RMS 窗只进了 4% 时才到 20% 阈值：那时窗中心 = 起点 − 0.46×窗长，所以起点 = 越线时的窗中心 + 0.46×窗长
    out.push({ t: Number((t0 + jj * hop + 0.46 * win).toFixed(5)), rise, floorDb: db(fl + 1e-9), peakDb: db(env[k] + 1e-9) });
  }
  return out;
}
