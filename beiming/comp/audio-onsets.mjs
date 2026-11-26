const db = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);

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

// 复合音效的感知中心（P-Center / Perceptual Attack Time，Morton 1976 / Scott 1998）：
// 与 engine/audio/library.py sync_anchor、cuecheck.py measure_pcenter 同口径（宽频 + 1.2 kHz 高频瞬态加权包络的正斜率平方质心）。
// 用于带前导破空风声（pre-whoosh）+ 实际撞击瞬态的音效事件（syncMode: "pcenter"），避免把风声起振误判为撞击超前。
export function findPCenter(x, sr, t, { early = 0.15, late = 0.25, minRiseDb = 7.5 } = {}) {
  const a = Math.max(0, Math.floor((t - early - 0.025) * sr));
  const b = Math.min(x.length, Math.ceil((t + late + 0.025) * sr));
  const win = Math.max(8, Math.round(sr * 0.0025)), hop = Math.max(1, Math.round(sr * 0.0005));
  if (b - a <= win + 8) return null;
  const n = b - a;
  const hfScale = sr / (2 * Math.PI * 1200);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = x[a + i];
    const dv = i > 0 ? v - x[a + i - 1] : 0;
    cs[i + 1] = cs[i] + 0.35 * v * v + 0.65 * (dv * hfScale) * (dv * hfScale);
  }
  const kCnt = Math.floor((n - win) / hop) + 1;
  const env = new Float64Array(kCnt);
  for (let k = 0; k < kCnt; k++) {
    const st = k * hop;
    env[k] = Math.sqrt(Math.max(0, cs[st + win] - cs[st]) / win);
  }
  const hs = hop / sr;
  const k0 = Math.max(1, Math.round(((t - early) * sr - a) / hop));
  const k1 = Math.min(kCnt - 2, Math.round(((t + late) * sr - a) / hop));
  if (k1 <= k0) return null;
  let emax = 0;
  for (let k = k0; k <= k1; k++) if (env[k] > emax) emax = env[k];
  const sorted = Array.from(env).sort((p, q) => p - q);
  const fl = sorted[Math.floor(sorted.length * 0.20)] ?? 0;
  const rise = db(emax + 1e-12) - db(fl + 1e-12);
  if (emax < 1e-6 || rise < minRiseDb) return null;
  const lookNb = Math.max(1, Math.round(0.008 / hs));
  let kPk = k0;
  for (let k = k0; k <= k1; k++) if (env[k] > env[kPk]) kPk = k;
  for (let k = k0; k <= k1; k++) {
    if (env[k] >= 0.72 * emax) {
      let localMax = env[k];
      for (let j = k + 1; j <= Math.min(kCnt - 1, k + lookNb); j++) if (env[j] > localMax) localMax = env[j];
      if (env[k] >= localMax - 1e-12) { kPk = k; break; }
    }
  }
  const sLo = Math.max(1, kPk - Math.round(0.045 / hs));
  let kMs = sLo, maxSlope = 0;
  for (let k = sLo; k <= kPk; k++) {
    const sl = Math.max(0, env[k] - env[k - 1]);
    if (sl > maxSlope) { maxSlope = sl; kMs = k; }
  }
  if (maxSlope <= 1e-15) return { t: Number(((a + kPk * hop + 0.5 * win) / sr).toFixed(5)), riseDb: +rise.toFixed(1), band: 'P-Center' };
  const rad = Math.max(2, Math.round(0.010 / hs));
  const lo = Math.max(1, kMs - rad), hi = Math.min(kPk, kMs + rad);
  let wSum = 0, wkSum = 0;
  for (let k = lo; k <= hi; k++) {
    const sl = Math.max(0, env[k] - env[k - 1]);
    const w = sl * sl;
    wSum += w;
    wkSum += k * w;
  }
  const kAnchor = wSum > 0 ? wkSum / wSum : kMs;
  return {
    t: Number(((a + kAnchor * hop + 0.85 * win) / sr).toFixed(5)),
    riseDb: +rise.toFixed(1),
    floorDb: +db(fl + 1e-9).toFixed(1),
    peakDb: +db(emax + 1e-9).toFixed(1),
    band: 'P-Center',
    candidates: 1,
  };
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
