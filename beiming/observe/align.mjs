// 对齐与拟合：切点对齐、20ms 能量包络互相关时间偏移与拉伸比求解、构图包围盒对位、7 参数最小二乘相机拟合。
//   align(request)  可单独或组合提供 { cuts?, stretch?, music?, composition?, camera? }（兼容别名 audioEnvelope/media、boxes、cameraFit）
//     cuts         { reference: number[], actual: number[], maxDeltaFrames = 3 } → 单调最优匹配 pairs、meanAbsDelta、maxAbsDelta、missed、extra、missedCount、extraCount
//     stretch      { filmEnvelope, trackEnvelope, stepSec = 0.02, fps = 24, stretchRange = [0.97, 1.03], stretchStep = 0.001, maxOffsetSec = 8.0 }
//                  或 { filmPath, trackPath, ... }（经 ffmpeg 抽单声道 s16le PCM 算 20ms RMS 包络，不经 shell）
//     music        { filmPath, trackPath, fps?, stretchRange?, stretchStep?, maxOffsetSec? } → metric:music.align（8 kHz 单声道、150 Hz 低通、20ms RMS）
//     composition  { reference: bbox2d, actual: bbox2d, size: [w, h] } → centerShiftPx、centerShiftNorm、areaRatio、iou
//     camera       { points: [{ world: [x,y,z], screen: [u,v] }], size: [w, h], initial?: { pos?, target?, fovY?, near?, far? } }
//                  7 参数（pos[3] + 轴角 rotation[3] + fovY[5..140]）阻尼高斯-牛顿（LM）拟合；world/proj 4x4 列主序对齐 meta/0.1（双精度），rmsePx 由返回矩阵复算，另给 converged 与 degenerate
//                  （点集重合、独立世界点不足 4 个、共线或共面且正对相机，或解处归一化雅可比 J^T J 的最小与最大特征值之比 < 1e-7，
//                  即 7 个自由度局部不可唯一辨识，此时 converged 恒为 false）；near/far 使 proj 溢出时报错。
//                  长度量都按点集半径（各点到质心的最大距离）归一；半径 1e-9 到 1e9 有回归测试，超出不保证收敛（如实给 converged: false）。
//   预算：返回值 JSON 严格满足 withinBudget(json, 500)；非法参数返回 { ok: false, error: { code, message } }，不抛异常。

import { resolve } from 'node:path';
import { fail } from './curves.mjs';
import { withinBudget } from './query.mjs';
import { runFfmpeg } from './sheet.mjs';

export const ALIGN_TOKEN_LIMIT = 500;
const PCM_MAX_BYTES = 256 * 1024 * 1024;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- 1. 切点对齐 ----------

function alignCuts(spec) {
  if (!isPlain(spec)) throw new Error('cuts 必须是对象：{ reference, actual, maxDeltaFrames? }');
  const { reference, actual, maxDeltaFrames = 3 } = spec;
  if (!Array.isArray(reference) || !reference.every((f) => Number.isInteger(f) && f >= 0)) {
    throw new Error('cuts.reference 必须是非负整数帧号数组');
  }
  if (!Array.isArray(actual) || !actual.every((f) => Number.isInteger(f) && f >= 0)) {
    throw new Error('cuts.actual 必须是非负整数帧号数组');
  }
  if (!Number.isInteger(maxDeltaFrames) || maxDeltaFrames < 0) {
    throw new Error('cuts.maxDeltaFrames 必须是非负整数');
  }

  const ref = [...reference].sort((a, b) => a - b);
  const act = [...actual].sort((a, b) => a - b);
  const m = ref.length;
  const n = act.length;
  // 单调最优匹配 DP：优先最大化配对数，平手时最小化绝对帧差之和
  const cnt = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  const err = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const actOp = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1)); // 1=skipRef, 2=skipAct, 3=match

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      let bestC = cnt[i + 1][j];
      let bestE = err[i + 1][j];
      let op = 1;
      if (cnt[i][j + 1] > bestC || (cnt[i][j + 1] === bestC && err[i][j + 1] < bestE)) {
        bestC = cnt[i][j + 1];
        bestE = err[i][j + 1];
        op = 2;
      }
      const d = Math.abs(act[j] - ref[i]);
      if (d <= maxDeltaFrames) {
        const mc = 1 + cnt[i + 1][j + 1];
        const me = d + err[i + 1][j + 1];
        if (mc > bestC || (mc === bestC && me < bestE)) {
          bestC = mc;
          bestE = me;
          op = 3;
        }
      }
      cnt[i][j] = bestC;
      err[i][j] = bestE;
      actOp[i][j] = op;
    }
  }

  const pairs = [];
  const missed = [];
  const extra = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const op = actOp[i][j];
    if (op === 3) {
      pairs.push({ ref: ref[i], actual: act[j], delta: act[j] - ref[i] });
      i++;
      j++;
    } else if (op === 1) {
      missed.push(ref[i++]);
    } else {
      extra.push(act[j++]);
    }
  }
  while (i < m) missed.push(ref[i++]);
  while (j < n) extra.push(act[j++]);

  let sumAbs = 0;
  let maxAbs = 0;
  for (const p of pairs) {
    const ad = Math.abs(p.delta);
    sumAbs += ad;
    if (ad > maxAbs) maxAbs = ad;
  }
  return {
    pairs,
    meanAbsDelta: pairs.length ? r(sumAbs / pairs.length, 3) : null,
    maxAbsDelta: pairs.length ? maxAbs : null,
    missed,
    extra,
    missedCount: missed.length,
    extraCount: extra.length,
  };
}

// ---------- 2. 20ms 包络互相关时间偏移与拉伸求解 ----------

function extractEnvelopeFromMedia(filePath, stepSec, sampleRate, audioFilter) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('音视频路径不能为空');
  const filterArgs = audioFilter ? ['-af', audioFilter] : [];
  const pcm = runFfmpeg([
    '-nostdin', '-v', 'error', '-i', resolve(filePath), '-vn', '-ac', '1',
    '-ar', String(sampleRate), ...filterArgs, '-f', 's16le', '-',
  ], PCM_MAX_BYTES);
  const totalSamples = Math.floor(pcm.length / 2);
  const win = Math.max(1, Math.round(sampleRate * stepSec));
  const frames = Math.floor(totalSamples / win);
  if (frames < 2) throw new Error('音频过短，无法提取 20ms 能量包络');
  const env = new Float64Array(frames);
  for (let w = 0; w < frames; w++) {
    let sq = 0;
    const base = w * win;
    for (let k = 0; k < win; k++) {
      const s = pcm.readInt16LE((base + k) * 2) / 32768;
      sq += s * s;
    }
    env[w] = Math.sqrt(sq / win);
  }
  return env;
}

function toEnvelope(arr, label) {
  if (!(Array.isArray(arr) || ArrayBuffer.isView(arr)) || arr.length < 2) {
    throw new Error(`${label} 必须是长度 >= 2 的有限数数组`);
  }
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} 包含非有限数`);
    out[i] = v;
  }
  return out;
}

function alignStretch(spec, { audioFilter, wholeTrackCorrelation = false } = {}) {
  if (!isPlain(spec)) throw new Error('stretch 必须是对象');
  const stepSec = spec.stepSec ?? 0.02;
  const fps = spec.fps ?? 24;
  const stretchRange = spec.stretchRange ?? [0.97, 1.03];
  const stretchStep = spec.stretchStep ?? 0.001;
  const maxOffsetSec = spec.maxOffsetSec ?? 8.0;
  const sampleRate = spec.sampleRate ?? 24000;

  if (!(typeof stepSec === 'number' && Number.isFinite(stepSec) && stepSec > 0)) throw new Error('stepSec 必须是正数');
  if (!(typeof fps === 'number' && Number.isFinite(fps) && fps > 0)) throw new Error('fps 必须是正数');
  if (!Array.isArray(stretchRange) || stretchRange.length !== 2 || !stretchRange.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) || stretchRange[0] > stretchRange[1]) {
    throw new Error('stretchRange 必须是 [min, max] 正数区间');
  }
  if (!(typeof stretchStep === 'number' && Number.isFinite(stretchStep) && stretchStep > 0)) throw new Error('stretchStep 必须是正数');
  if (!(typeof maxOffsetSec === 'number' && Number.isFinite(maxOffsetSec) && maxOffsetSec >= 0)) throw new Error('maxOffsetSec 必须是非负数');
  if (!Number.isInteger(sampleRate) || sampleRate < 1000) throw new Error('sampleRate 必须是 >= 1000 的整数');

  let film;
  let track;
  if (spec.filmPath !== undefined || spec.trackPath !== undefined) {
    film = extractEnvelopeFromMedia(spec.filmPath, stepSec, sampleRate, audioFilter);
    track = extractEnvelopeFromMedia(spec.trackPath, stepSec, sampleRate, audioFilter);
  } else {
    film = toEnvelope(spec.filmEnvelope, 'filmEnvelope');
    track = toEnvelope(spec.trackEnvelope, 'trackEnvelope');
  }

  const m = track.length;
  const n = film.length;
  const minSeg = Math.max(2, Math.ceil(0.9 * m));
  // 预计算 track 前缀和，区间方差 O(1)
  const prefT = new Float64Array(m + 1);
  const prefT2 = new Float64Array(m + 1);
  for (let k = 0; k < m; k++) {
    prefT[k + 1] = prefT[k] + track[k];
    prefT2[k + 1] = prefT2[k] + track[k] * track[k];
  }
  // 配乐量测以整首参考曲的中心化能量为分母，重叠段仍沿用相同的插值和协方差。
  const wholeTrackEnergy = wholeTrackCorrelation ? prefT2[m] - prefT[m] ** 2 / m : 0;

  const maxOi = Math.round(maxOffsetSec / stepSec);
  const sSteps = Math.max(0, Math.round((stretchRange[1] - stretchRange[0]) / stretchStep));
  let bestCorr = -Infinity;
  let bestOi = 0;
  let bestS = stretchRange[0];
  let bestLen = 0;

  for (let si = 0; si <= sSteps; si++) {
    const s = Number((stretchRange[0] + si * stretchStep).toFixed(6));
    if (s > stretchRange[1] + 1e-9) break;
    // 对正负偏移只遍历能满足 segLen >= minSeg 的有效区间
    const loOi = Math.max(-maxOi, Math.floor(-(m - minSeg) * s));
    const hiOi = Math.min(maxOi, Math.ceil((n - 1) - (minSeg - 1) * s));
    for (let oi = loOi; oi <= hiOi; oi++) {
      const kStart = oi >= 0 ? 0 : Math.ceil(-oi / s);
      const kEnd = Math.min(m - 1, Math.floor((n - 1 - oi) / s));
      const len = kEnd - kStart + 1;
      if (len < minSeg) continue;

      const sumT = prefT[kEnd + 1] - prefT[kStart];
      const sumT2 = prefT2[kEnd + 1] - prefT2[kStart];
      const varT = len * sumT2 - sumT * sumT;
      if (varT <= 1e-10 * Math.max(1, len * sumT2)) continue;

      let sumF = 0;
      let sumF2 = 0;
      let sumFT = 0;
      for (let k = kStart; k <= kEnd; k++) {
        const idx = oi + k * s;
        const i0 = Math.floor(idx);
        const fv = i0 + 1 < n ? film[i0] + (film[i0 + 1] - film[i0]) * (idx - i0) : film[i0];
        sumF += fv;
        sumF2 += fv * fv;
        sumFT += fv * track[k];
      }
      const varF = len * sumF2 - sumF * sumF;
      if (varF <= 1e-10 * Math.max(1, len * sumF2)) continue;
      const trackVariance = wholeTrackCorrelation ? len * wholeTrackEnergy : varT;
      const corr = (len * sumFT - sumF * sumT) / Math.sqrt(varF * trackVariance);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOi = oi;
        bestS = s;
        bestLen = len;
      }
    }
  }

  if (!Number.isFinite(bestCorr)) {
    return { stretch: null, offsetSec: null, offsetFrames: null, corr: 0, reliable: false };
  }
  const offsetSec = Number((bestOi * stepSec).toFixed(4));
  return {
    stretch: bestS,
    offsetSec,
    offsetFrames: r(offsetSec * fps, 2),
    corr: r(bestCorr, 4),
    reliable: bestCorr >= 0.5,
    overlapRatio: r(bestLen / m, 4),
  };
}

function alignMusic(spec) {
  if (!isPlain(spec)) throw new Error('music 必须是对象');
  const { filmPath, trackPath, fps, stretchRange = [0.99, 1.03], stretchStep, maxOffsetSec } = spec;
  if (![filmPath, trackPath].every(path => typeof path === 'string' && path.length > 0)) {
    throw new Error('music.filmPath 与 music.trackPath 必须是非空路径');
  }
  return { metric: 'metric:music.align', ...alignStretch({
    filmPath, trackPath, fps, stretchRange, stretchStep, maxOffsetSec, stepSec: 0.02, sampleRate: 8000,
  }, { audioFilter: 'lowpass=f=150', wholeTrackCorrelation: true }) };
}

// ---------- 3. 构图包围盒对位 ----------

const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)) && b[0] <= b[2] && b[1] <= b[3];

function alignComposition(spec) {
  if (!isPlain(spec)) throw new Error('composition 必须是对象：{ reference, actual, size }');
  const ref = spec.reference ?? spec.ref ?? spec.a;
  const act = spec.actual ?? spec.b;
  const size = spec.size;
  if (!isBox(ref) || !isBox(act)) throw new Error('composition 的 reference 与 actual 必须是合法 bbox2d [x0, y0, x1, y1]');
  if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new Error('composition.size 必须是正数 [width, height]');
  }
  const [w, h] = size;
  const dx = (act[0] + act[2]) / 2 - (ref[0] + ref[2]) / 2;
  const dy = (act[1] + act[3]) / 2 - (ref[1] + ref[3]) / 2;
  const areaRef = (ref[2] - ref[0]) * (ref[3] - ref[1]);
  const areaAct = (act[2] - act[0]) * (act[3] - act[1]);
  const ix = Math.max(0, Math.min(ref[2], act[2]) - Math.max(ref[0], act[0]));
  const iy = Math.max(0, Math.min(ref[3], act[3]) - Math.max(ref[1], act[1]));
  const inter = ix * iy;
  const union = areaRef + areaAct - inter;
  return {
    centerShiftPx: [r(dx, 2), r(dy, 2)],
    centerShiftNorm: [r(dx / w, 4), r(dy / h, 4)],
    areaRatio: areaRef > 0 ? r(areaAct / areaRef, 4) : (areaAct === 0 ? 1 : null),
    iou: union > 0 ? r(inter / union, 4) : (areaRef === 0 && areaAct === 0 ? 1 : 0),
  };
}

// ---------- 4. 7 参数最小二乘相机拟合（LM） ----------

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; // 归一化无量纲，只有零向量才回退
};

// 3x3 旋转矩阵按行存储（长度 9）：列 0 = xAxis, 列 1 = yAxis, 列 2 = zAxis（相机到世界 R_cw）
function lookAtR(pos, target, upHint = [0, 1, 0]) {
  const z = norm3(sub3(pos, target));
  const up = Math.abs(dot3(z, upHint)) > 0.99 ? [1, 0, 0] : upHint;
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function rodrigues(rx, ry, rz) {
  const theta = Math.hypot(rx, ry, rz);
  if (theta < 1e-12) return [1, -rz, ry, rz, 1, -rx, -ry, rx, 1];
  const kx = rx / theta;
  const ky = ry / theta;
  const kz = rz / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    c + kx * kx * t, kx * ky * t - kz * s, kx * kz * t + ky * s,
    ky * kx * t + kz * s, c + ky * ky * t, ky * kz * t - kx * s,
    kz * kx * t - ky * s, kz * ky * t + kx * s, c + kz * kz * t,
  ];
}

function mul3(A, B) {
  const C = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      C[row * 3 + col] = A[row * 3] * B[col] + A[row * 3 + 1] * B[3 + col] + A[row * 3 + 2] * B[6 + col];
    }
  }
  return C;
}

// Shepperd 四元数法：与 rodrigues 互逆，θ≈π（含轴分量为 0）也无符号歧义
export function matToAxisAngle(R) {
  const tr = R[0] + R[4] + R[8];
  let w, x, y, z;
  if (tr > 0) {
    const S = 2 * Math.sqrt(1 + tr);
    w = 0.25 * S; x = (R[7] - R[5]) / S; y = (R[2] - R[6]) / S; z = (R[3] - R[1]) / S;
  } else if (R[0] >= R[4] && R[0] >= R[8]) {
    const S = 2 * Math.sqrt(Math.max(1e-32, 1 + R[0] - R[4] - R[8]));
    w = (R[7] - R[5]) / S; x = 0.25 * S; y = (R[1] + R[3]) / S; z = (R[2] + R[6]) / S;
  } else if (R[4] >= R[8]) {
    const S = 2 * Math.sqrt(Math.max(1e-32, 1 + R[4] - R[0] - R[8]));
    w = (R[2] - R[6]) / S; x = (R[1] + R[3]) / S; y = 0.25 * S; z = (R[5] + R[7]) / S;
  } else {
    const S = 2 * Math.sqrt(Math.max(1e-32, 1 + R[8] - R[0] - R[4]));
    w = (R[3] - R[1]) / S; x = (R[2] + R[6]) / S; y = (R[5] + R[7]) / S; z = 0.25 * S;
  }
  const n = Math.hypot(w, x, y, z) * (w < 0 ? -1 : 1);
  w /= n; x /= n; y /= n; z /= n;
  const v = Math.hypot(x, y, z);
  if (v < 1e-15) return [0, 0, 0];
  const theta = 2 * Math.atan2(v, w);
  return [(x * theta) / v, (y * theta) / v, (z * theta) / v];
}

// 解 7x7 线性方程组 A * x = b（部分主元高斯消元）
function solve7(A, b) {
  const n = 7;
  const M = Array.from({ length: n }, (_, i) => [...A[i], b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
    const diag = M[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / diag;
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

// scale 为点集半径：深度是否为正、相机后方的罚项都按它归一，不用绝对长度
function projectResiduals(points, width, height, pos, R, fovY, scale) {
  const aspect = width / height;
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  const fx = f / aspect;
  const res = new Float64Array(points.length * 2);
  let sse = 0;
  let valid = true;
  for (let i = 0; i < points.length; i++) {
    const w = points[i].world;
    const dx = w[0] - pos[0];
    const dy = w[1] - pos[1];
    const dz = w[2] - pos[2];
    // c = R^T * (w - pos)
    const cx = R[0] * dx + R[3] * dy + R[6] * dz;
    const cy = R[1] * dx + R[4] * dy + R[7] * dz;
    const cz = R[2] * dx + R[5] * dy + R[8] * dz;
    const depth = -cz;
    if (depth <= 1e-9 * scale) {
      valid = false;
      const pen = 1e4 * (1 - depth / scale);
      res[i * 2] = pen;
      res[i * 2 + 1] = pen;
      sse += 2 * pen * pen;
      continue;
    }
    const u = ((cx * fx) / depth * 0.5 + 0.5) * width;
    const v = (0.5 - ((cy * f) / depth) * 0.5) * height;
    const du = u - points[i].screen[0];
    const dv = v - points[i].screen[1];
    res[i * 2] = du;
    res[i * 2 + 1] = dv;
    sse += du * du + dv * dv;
  }
  return { res, sse, valid };
}

// 重投影残差对 7 个自由度的数值雅可比（中心差分，按列存）：位置三列以点集半径为单位（步长与导数都按它归一，
// 所以求解时的阻尼下限、主元阈值与场景尺度无关），旋转用局部切空间 R * exp([dw]_x) 避开万向节奇异
function numericJacobian(points, width, height, pos, R, fovY, scale) {
  const m = points.length * 2;
  const steps = [1e-5 * scale, 1e-5 * scale, 1e-5 * scale, 1e-5, 1e-5, 1e-5, 1e-3];
  const at = (p, rot, fv) => projectResiduals(points, width, height, p, rot, fv, scale).res;
  const J = Array.from({ length: 7 }, () => new Float64Array(m));
  for (let k = 0; k < 7; k++) {
    const h = steps[k];
    let plus;
    let minus;
    let span = 2 * h;
    if (k < 3) {
      const p1 = [...pos]; p1[k] += h;
      const p2 = [...pos]; p2[k] -= h;
      plus = at(p1, R, fovY);
      minus = at(p2, R, fovY);
    } else if (k < 6) {
      const d1 = [0, 0, 0]; d1[k - 3] = h;
      const d2 = [0, 0, 0]; d2[k - 3] = -h;
      plus = at(pos, mul3(R, rodrigues(...d1)), fovY);
      minus = at(pos, mul3(R, rodrigues(...d2)), fovY);
    } else {
      const f1 = clamp(fovY + h, 5, 140);
      const f2 = clamp(fovY - h, 5, 140);
      span = Math.max(1e-6, f1 - f2);
      plus = at(pos, R, f1);
      minus = at(pos, R, f2);
    }
    const unit = k < 3 ? scale : 1;
    for (let row = 0; row < m; row++) J[k][row] = ((plus[row] - minus[row]) / span) * unit;
  }
  return J;
}

// 7 参数在解处是否局部可唯一辨识：位置按点集半径、角度与视场角按弧度归一后取 H = J^T J（7x7 对称半正定），
// 用循环 Jacobi 旋转求全部特征值；最小与最大之比低于 1e-7（或秩亏）说明存在重投影误差不变的方向。
// 例：正对平面的四角加光轴上一点，三维点不共面，但相机沿光轴前后移动可由 fovY 完全补偿。
const IDENT_EIG_RATIO = 1e-7;
function unidentifiable(points, width, height, pos, R, fovY, scale) {
  const J = numericJacobian(points, width, height, pos, R, fovY, scale);
  const unit = [1, 1, 1, 1, 1, 1, 180 / Math.PI]; // 位置列已按半径归一，fovY 从度换成弧度
  const A = Array.from({ length: 7 }, (_, a) => Array.from({ length: 7 }, (_, b) => {
    let s = 0;
    for (let row = 0; row < J[a].length; row++) s += J[a][row] * J[b][row];
    return s * unit[a] * unit[b];
  }));
  if (!A.every((row) => row.every(Number.isFinite))) return true;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 6; p++) {
      for (let q = p + 1; q < 7; q++) {
        if (A[p][q] === 0) continue;
        off += A[p][q] ** 2;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.hypot(theta, 1));
        const c = 1 / Math.hypot(t, 1);
        const s = t * c;
        for (let k = 0; k < 7; k++) { // A <- A * G
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 7; k++) { // A <- G^T * A
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
    if (off === 0) break;
  }
  const eig = A.map((row, i) => row[i]);
  const max = Math.max(...eig);
  return !(max > 0) || !(Math.min(...eig) >= IDENT_EIG_RATIO * max);
}

// scale 为点集半径：位置差分步长与收敛步长按场景尺度归一，微小尺度场景也能收敛
function lmOptimize(points, width, height, initPos, initR, initFovY, scale) {
  let pos = [...initPos];
  let R = [...initR];
  let fovY = clamp(initFovY, 5, 140);
  let cur = projectResiduals(points, width, height, pos, R, fovY, scale);
  let lambda = 1e-3;
  const m = points.length * 2;
  let converged = false;

  for (let iter = 0; iter < 80; iter++) {
    const rmse = Math.sqrt(cur.sse / points.length);
    if (cur.valid && rmse < 1e-6) {
      converged = true;
      break;
    }
    const J = numericJacobian(points, width, height, pos, R, fovY, scale);

    const H = Array.from({ length: 7 }, () => new Float64Array(7));
    const g = new Float64Array(7);
    for (let a = 0; a < 7; a++) {
      for (let b = a; b < 7; b++) {
        let s = 0;
        for (let row = 0; row < m; row++) s += J[a][row] * J[b][row];
        H[a][b] = H[b][a] = s;
      }
      let sg = 0;
      for (let row = 0; row < m; row++) sg += J[a][row] * cur.res[row];
      g[a] = -sg;
    }

    let accepted = false;
    for (let tries = 0; tries < 10; tries++) {
      const damped = Array.from({ length: 7 }, (_, a) => {
        const row = Array.from(H[a]);
        row[a] += lambda * Math.max(H[a][a], 1e-6);
        return row;
      });
      const delta = solve7(damped, g);
      if (!delta) {
        lambda = Math.min(1e8, lambda * 10);
        continue;
      }
      const nPos = [pos[0] + delta[0] * scale, pos[1] + delta[1] * scale, pos[2] + delta[2] * scale];
      const nR = mul3(R, rodrigues(delta[3], delta[4], delta[5]));
      const nFov = clamp(fovY + delta[6], 5, 140);
      const next = projectResiduals(points, width, height, nPos, nR, nFov, scale);
      if (next.sse < cur.sse) {
        const rel = (cur.sse - next.sse) / Math.max(cur.sse, 1e-12);
        const stepNorm = Math.hypot(...delta);
        pos = nPos;
        R = nR;
        fovY = nFov;
        cur = next;
        lambda = Math.max(1e-7, lambda * 0.3);
        accepted = true;
        if (cur.valid && (rel < 1e-11 || stepNorm < 1e-8)) converged = true;
        break;
      }
      lambda = Math.min(1e8, lambda * 8);
    }
    if (!accepted || converged) break;
  }

  let maxErr = 0;
  for (let i = 0; i < points.length; i++) {
    const e = Math.hypot(cur.res[i * 2], cur.res[i * 2 + 1]);
    if (e > maxErr) maxErr = e;
  }
  return {
    pos,
    R,
    fovY,
    rmsePx: Math.sqrt(cur.sse / points.length),
    maxErrPx: maxErr,
    valid: cur.valid,
    converged: cur.valid && (converged || cur.sse / points.length < 0.25),
  };
}

function buildCameraMatrices(pos, R, fovY, width, height, near, far) {
  // 列主序 4x4，对齐 meta/0.1 §5.1
  const world = [
    R[0], R[3], R[6], 0,
    R[1], R[4], R[7], 0,
    R[2], R[5], R[8], 0,
    pos[0], pos[1], pos[2], 1,
  ];
  const f = 1 / Math.tan((fovY * Math.PI) / 360);
  const fx = f * (height / width);
  const proj = [
    fx, 0, 0, 0,
    0, f, 0, 0,
    0, 0, -(1 + near / far) / (1 - near / far), -1,
    0, 0, -(2 * near) / (1 - near / far), 0, // 与 -2fn/(f-n) 等价，far 极大时不溢出
  ];
  return { world, proj };
}

// 用将要返回给调用方的 world（相机到世界，列主序）与 proj 复算重投影误差
function reproject(points, world, proj, width, height) {
  let sse = 0;
  let maxErr = 0;
  let behind = false;
  for (const { world: p, screen } of points) {
    const d = [p[0] - world[12], p[1] - world[13], p[2] - world[14]];
    const c = [0, 1, 2].map((k) => world[k * 4] * d[0] + world[k * 4 + 1] * d[1] + world[k * 4 + 2] * d[2]);
    const cw = proj[3] * c[0] + proj[7] * c[1] + proj[11] * c[2] + proj[15];
    if (!(cw > 0)) behind = true;
    const u = ((proj[0] * c[0] + proj[4] * c[1] + proj[8] * c[2] + proj[12]) / cw * 0.5 + 0.5) * width;
    const v = (0.5 - ((proj[1] * c[0] + proj[5] * c[1] + proj[9] * c[2] + proj[13]) / cw) * 0.5) * height;
    const e = Math.hypot(u - screen[0], v - screen[1]);
    sse += e * e;
    if (e > maxErr) maxErr = e;
  }
  return { rmse: Math.sqrt(sse / points.length), maxErr, behind };
}

// 点集协方差特征值：共线（λ2≈0），或共面且平面正对相机（法向∥视线，fovY 与距离不可分）时 7 参数不可辨识。
// 先减质心、除以点集半径再算：阈值全落在无量纲坐标上，判定与场景尺度无关。
// 导出只为单测直接覆盖这道门（解处雅可比那道门会盖住它的大部分情形），不进 index.mjs
export function isDegenerate(points, centroid, radius, R) {
  if (!(radius > 0)) return true; // 全部重合
  // 独立世界点不足 4 个时方程少于 7 个：同一世界点重复给不增加约束，屏幕点相同或略有出入都一样，所以只按世界坐标判重
  const eps = 1e-9 * radius;
  const uniq = [];
  for (const p of points) {
    if (uniq.length < 4 && !uniq.some((q) => Math.hypot(...sub3(p.world, q)) <= eps)) uniq.push(p.world);
  }
  if (uniq.length < 4) return true;
  const n = points.length;
  const C = new Array(9).fill(0);
  for (const p of points) {
    const d = sub3(p.world, centroid).map((v) => v / radius);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += (d[i] * d[j]) / n;
  }
  const q = (C[0] + C[4] + C[8]) / 3;
  const p = Math.sqrt(((C[0] - q) ** 2 + (C[4] - q) ** 2 + (C[8] - q) ** 2 + 2 * (C[1] ** 2 + C[2] ** 2 + C[5] ** 2)) / 6);
  if (!(p > 0)) return false; // 各向同性
  const B = C.map((v, i) => (v - (i % 4 === 0 ? q : 0)) / p);
  const det = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
  const phi = Math.acos(clamp(det / 2, -1, 1)) / 3;
  const l1 = q + 2 * p * Math.cos(phi);
  const l3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  if (3 * q - l1 - l3 <= 1e-6 * l1) return true;
  if (l3 > 1e-6 * l1) return false;
  const M = C.map((v, i) => v - (i % 4 === 0 ? l3 : 0));
  const rows = [M.slice(0, 3), M.slice(3, 6), M.slice(6, 9)];
  const normal = [cross3(rows[0], rows[1]), cross3(rows[0], rows[2]), cross3(rows[1], rows[2])]
    .reduce((a, b) => (Math.hypot(...b) > Math.hypot(...a) ? b : a));
  return Math.abs(dot3(norm3(normal), [R[2], R[5], R[8]])) > 0.99;
}

function alignCamera(spec) {
  if (!isPlain(spec)) throw new Error('camera 必须是对象：{ points, size, initial? }');
  const { points, size, initial = {} } = spec;
  if (!Array.isArray(points) || points.length < 4) {
    throw new Error('camera.points 至少需要 4 组对应点以求解 7 参数相机');
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!isPlain(p) || !Array.isArray(p.world) || p.world.length !== 3 || !p.world.every(Number.isFinite)
      || !Array.isArray(p.screen) || p.screen.length !== 2 || !p.screen.every(Number.isFinite)) {
      throw new Error(`camera.points[${i}] 需要有限数 world[3] 与 screen[2]`);
    }
  }
  if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new Error('camera.size 必须是正数 [width, height]');
  }
  if (!isPlain(initial)) throw new Error('camera.initial 必须是对象');
  const [width, height] = size;
  const near = initial.near ?? 0.1;
  const far = initial.far ?? 1000;
  if (!(typeof near === 'number' && Number.isFinite(near) && near > 0 && typeof far === 'number' && Number.isFinite(far) && far > near)) {
    throw new Error('camera.initial 的 near、far 必须满足 0 < near < far');
  }

  const centroid = [0, 0, 0];
  for (const p of points) {
    centroid[0] += p.world[0];
    centroid[1] += p.world[1];
    centroid[2] += p.world[2];
  }
  centroid[0] /= points.length;
  centroid[1] /= points.length;
  centroid[2] /= points.length;
  // 求解与两道门都在质心局部坐标里做：世界坐标整体平移很大时（如 z≈262144、半径 1e-6），
  // 绝对坐标上的差分步长 1e-5*半径 会被双精度尾数吞掉，位置导数列变成全 0 而误判退化；最后再把质心加回 pos
  const local = points.map((p) => ({ world: sub3(p.world, centroid), screen: p.screen }));
  const origin = [0, 0, 0];
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

  let radius = 0;
  for (const p of local) {
    const d = Math.hypot(...p.world);
    if (d > radius) radius = d;
  }
  const scale = radius > 0 ? radius : 1;
  const dist = radius * 4 || 2.0;
  const seeds = [];
  if (initial.pos || initial.target || initial.fovY !== undefined) {
    const t = vec3(initial.target) ? sub3(initial.target, centroid) : origin;
    const p = vec3(initial.pos) ? sub3(initial.pos, centroid) : [t[0], t[1] + dist * 0.3, t[2] + dist];
    const fv = typeof initial.fovY === 'number' && Number.isFinite(initial.fovY) ? clamp(initial.fovY, 5, 140) : 40;
    seeds.push({ pos: p, R: lookAtR(p, t), fovY: fv });
  }
  const dirs = [
    [0.5, 0.3, 1], [-0.5, 0.3, 1], [0, 0.25, 1], [1, 0.4, 1], [-1, 0.4, 1],
    [0, 0.25, -1], [1, 0.4, -1], [-1, 0.4, -1], [1, 0.2, 0], [-1, 0.2, 0],
    [0, 1, 0.25], [0, -1, 0.25],
  ];
  for (const d of dirs) {
    const u = norm3(d);
    const p = [u[0] * dist, u[1] * dist, u[2] * dist];
    seeds.push({ pos: p, R: lookAtR(p, origin), fovY: 40 });
  }

  let best = null;
  for (const s of seeds) {
    const cand = lmOptimize(local, width, height, s.pos, s.R, s.fovY, scale);
    if (!best || (cand.valid && !best.valid) || (cand.valid === best.valid && cand.rmsePx < best.rmsePx)) {
      best = cand;
    }
    if (best.valid && best.rmsePx < 0.05) break;
  }
  if (best && (!best.valid || best.rmsePx >= 0.5)) {
    for (const fv of [25, 65]) {
      const cand = lmOptimize(local, width, height, best.pos, best.R, fv, scale);
      if (cand.valid && cand.rmsePx < best.rmsePx) best = cand;
    }
  }

  // 公开的 pos/rotation/fovY 与 world/proj 一样保留双精度、不截断有效位：
  // 大平移下截到 9 位有效数字会丢掉相对点集的位移（262144.0048828125 -> 262144.005，重建误差数像素）
  const pos = [best.pos[0] + centroid[0], best.pos[1] + centroid[1], best.pos[2] + centroid[2]];
  const { world, proj } = buildCameraMatrices(pos, best.R, best.fovY, width, height, near, far);
  const rep = reproject(points, world, proj, width, height);
  // 不把 Infinity/NaN（JSON 里是 null）放进 ok: true 的回答
  if (!proj.every(Number.isFinite)) throw new Error('相机裁剪参数超出可表示浮点范围');
  if (!world.every(Number.isFinite)) throw new Error('相机点坐标超出可表示浮点范围');
  // 两道门：点集协方差（重合、重复、共线、近共面正对）与解处的雅可比条件数（7 个自由度是否局部可唯一辨识）
  const degenerate = isDegenerate(local, origin, radius, best.R)
    || (best.valid && unidentifiable(local, width, height, best.pos, best.R, best.fovY, scale));
  return {
    pos,
    rotation: matToAxisAngle(best.R),
    fovY: best.fovY,
    world,
    proj,
    rmsePx: r(rep.rmse, 4),
    maxErrPx: r(rep.maxErr, 4),
    converged: best.converged && !degenerate && !rep.behind && rep.rmse <= 1,
    degenerate,
  };
}

// ---------- 预算守卫 ----------

function fitAlign(payload) {
  if (withinBudget(JSON.stringify(payload), ALIGN_TOKEN_LIMIT)) return payload;
  const caps = [12, 6, 3, 1, 0];
  for (const cap of caps) {
    const next = { ...payload, truncated: true };
    if (next.cuts) {
      next.cuts = {
        ...next.cuts,
        pairs: next.cuts.pairs.slice(0, cap),
        missed: next.cuts.missed.slice(0, cap),
        extra: next.cuts.extra.slice(0, cap),
      };
    }
    if (withinBudget(JSON.stringify(next), ALIGN_TOKEN_LIMIT)) return next;
  }
  return { ok: true, truncated: true };
}

/** 对齐与拟合入口；非法输入返回结构化错误，不抛异常。 */
export function align(request) {
  try {
    if (!isPlain(request)) throw new Error('request 必须是对象，包含 cuts、stretch、music、composition 或 camera 至少一项');
    const stretchSpec = request.stretch ?? request.audioEnvelope ?? request.media;
    const compSpec = request.composition ?? request.boxes;
    const camSpec = request.camera ?? request.cameraFit;
    const hasAny = request.cuts !== undefined || stretchSpec !== undefined || request.music !== undefined
      || compSpec !== undefined || camSpec !== undefined;
    if (!hasAny) throw new Error('request 至少提供 cuts、stretch、music、composition 或 camera 之一');

    const out = { ok: true };
    if (request.cuts !== undefined) out.cuts = alignCuts(request.cuts);
    if (stretchSpec !== undefined) out.stretch = alignStretch(stretchSpec);
    if (request.music !== undefined) out.music = alignMusic(request.music);
    if (compSpec !== undefined) out.composition = alignComposition(compSpec);
    if (camSpec !== undefined) out.camera = alignCamera(camSpec);
    out.truncated = false;
    return fitAlign(out);
  } catch (error) {
    return fail(error);
  }
}
