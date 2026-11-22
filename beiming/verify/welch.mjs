// 双样本 Welch t 检验加 Benjamini–Hochberg 校正：判两组带噪渲染（每边 K 个独立种子）是否收敛到同一期望。
import { readFileSync } from 'node:fs';
import { readExr } from './exr/exr.mjs';

function check(condition, reason) {
  if (!condition) throw new Error(`welch: ${reason}`);
}

// 把普通数组逐下标只读一次拷成快照，之后只用快照：空洞会让种子被悄悄少算，
// 带 getter 的元素能在读取中途删项、改长度或第二次读出别的值，这里一律 TypeError。
function snapshot(list, name) {
  const length = list.length;
  const copy = new Array(length);
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(list, i)) throw new TypeError(`welch: ${name} 第 ${i} 项是空洞（稀疏数组）`);
    copy[i] = list[i];
    if (list.length !== length) throw new TypeError(`welch: ${name} 的长度在读取中途被改了`);
  }
  return copy;
}

// Lanczos（g=7，9 项），只用于 x >= 0.5。
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(x) {
  let sum = LANCZOS[0];
  for (let i = 1; i < 9; i++) sum += LANCZOS[i] / (x - 1 + i);
  const t = x + 6.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(sum);
}

// 正则不完全 Beta I_x(a, b)，Lentz 连分数；x 过大时用对称式保证收敛。
// y = 1 - x 由调用方直接给出，免得 x 贴近 1 时相减丢精度。
function incompleteBeta(x, y, a, b) {
  if (x <= 0) return 0;
  if (y <= 0) return 1;
  const flip = x > (a + 1) / (a + b + 2);
  if (flip) [x, y, a, b] = [y, x, b, a];
  const tiny = 1e-300;
  const guard = v => (Math.abs(v) < tiny ? tiny : v);
  let c = 1;
  let d = 1 / guard(1 - (a + b) * x / (a + 1));
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / guard(1 + even * d);
    c = guard(1 + even / c);
    h *= d * c;
    const odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / guard(1 + odd * d);
    c = guard(1 + odd / c);
    h *= d * c;
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  const value = Math.exp(a * Math.log(x) + b * Math.log(y) + lgamma(a + b) - lgamma(a) - lgamma(b)) * h / a;
  return flip ? 1 - value : value;
}

// 互补误差函数（x >= 0）：x < 2.5 用全正项级数，以上用连分数，保住小尾部的相对精度。
function erfc(x) {
  if (x < 2.5) {
    let term = x;
    let sum = x;
    for (let n = 1; term > sum * 1e-17; n++) {
      term *= 2 * x * x / (2 * n + 1);
      sum += term;
    }
    return 1 - 2 / Math.sqrt(Math.PI) * Math.exp(-x * x) * sum;
  }
  let f = x;
  for (let n = 100; n >= 1; n--) f = x + n / 2 / f;
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}

// Student t 分布的双侧 p 值，自由度可为非整数。
export function studentTwoSidedP(t, df) {
  check(typeof t === 'number' && typeof df === 'number' && df > 0 && !Number.isNaN(t), '无效的 t 或自由度');
  if (!Number.isFinite(t)) return 0;
  // 自由度很大（含无穷）时 lgamma 相减丢精度，这时 t 分布与正态的相对差不到 1e-6，直接用正态。
  if (df > 1e7) return erfc(Math.abs(t) / Math.SQRT2);
  return incompleteBeta(df / (df + t * t), t * t / (df + t * t), df / 2, 0.5);
}

// BH 校正：返回每个检验的调整后 p 值（q 值）与 q <= alpha 的显著标记。
export function benjaminiHochberg(pValues, alpha = 0.05) {
  check(typeof alpha === 'number' && alpha > 0 && alpha < 1, 'alpha 须在 (0, 1) 内');
  check(Array.isArray(pValues) || ArrayBuffer.isView(pValues), 'p 值须为数组');
  if (Array.isArray(pValues)) pValues = snapshot(pValues, 'p 值');
  const m = pValues.length;
  const order = Uint32Array.from(pValues, (_, i) => i).sort((i, j) => pValues[i] - pValues[j]);
  const qValues = new Float64Array(m);
  const significant = new Uint8Array(m);
  let q = 1;
  let significantCount = 0;
  for (let rank = m; rank >= 1; rank--) {
    const i = order[rank - 1];
    check(typeof pValues[i] === 'number' && pValues[i] >= 0 && pValues[i] <= 1, 'p 值须在 [0, 1] 内');
    q = Math.min(q, pValues[i] * m / rank);
    qValues[i] = q;
    if (q <= alpha) {
      significant[i] = 1;
      significantCount++;
    }
  }
  return { qValues, significant, significantCount };
}

const LUMA = [0.2126, 0.7152, 0.0722];

// 把一个样本（帧对象、readExr 的返回、EXR 字节或路径）取成标量平面，再按块求均值。
function loadPlane(sample, channel, blockSize) {
  if (typeof sample === 'string') sample = readFileSync(sample);
  if (sample instanceof Uint8Array) sample = readExr(sample);
  check(sample !== null && typeof sample === 'object', '样本须为帧对象、EXR 字节或路径');
  const { width, height, channels, data } = sample; // 各字段只读一次
  check(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, '无效尺寸');
  const pixels = width * height;
  let sources; // 每个通道一项：[数组, 起点, 步长]
  if (channels !== null && typeof channels === 'object') {
    const read = new Map(); // 每个通道属性只读一次
    const isFloat = name => {
      if (!read.has(name)) read.set(name, channels[name]);
      return read.get(name) instanceof Float32Array && read.get(name).length === pixels;
    };
    let names;
    if (typeof channel === 'string' && channel !== 'luma') {
      check(isFloat(channel), `EXR 没有浮点通道 ${channel}`);
      names = [channel];
      channel = 0;
    } else {
      // 不按「恰好三个浮点通道」兜底：normal.X/Y/Z 或灯光组不是颜色。
      const rgb = ['color.', ''].map(prefix => ['R', 'G', 'B'].map(c => prefix + c)).find(set => set.every(isFloat));
      names = rgb ?? Object.keys(channels).filter(isFloat);
      check(rgb || names.length === 1, 'EXR 须含 color.R/G/B、R/G/B 或唯一的浮点通道，否则用 channel 给通道名');
    }
    sources = names.map(name => [read.get(name), 0, 1]);
  } else {
    const count = channels ?? 1;
    let raw = data;
    if (Array.isArray(data)) {
      raw = snapshot(data, 'data'); // 先于长度检查：空洞一律 TypeError
      // 不做隐式转换：null 乘权重会变成 0、'1' 会变成 1，统计就悄悄错了。
      if (!raw.every(v => typeof v === 'number')) throw new TypeError('welch: data 的元素须全为 number');
    } else if (!ArrayBuffer.isView(data) || data instanceof DataView) {
      throw new TypeError('welch: data 须为 TypedArray 或普通数组');
    }
    check(Number.isInteger(count) && count >= 1 && raw.length === pixels * count, '数据长度与尺寸、通道数不符');
    // 全部分量都查，不只查当前 channel 用到的：别的通道有 NaN 说明这帧本身就坏了。
    for (let i = 0; i < raw.length; i++) {
      if (!Number.isFinite(raw[i])) throw new RangeError(`welch: 样本含非有限值（data 第 ${i} 项）`);
    }
    sources = Array.from({ length: count }, (_, c) => [raw, c, count]);
  }
  let weights = LUMA;
  if (channel !== 'luma') {
    check(Number.isInteger(channel) && channel >= 0 && channel < sources.length, `无效通道 ${channel}`);
    sources = [sources[channel]];
  }
  if (sources.length < 3) {
    sources = [sources[0]];
    weights = [1];
  }
  const gw = Math.ceil(width / blockSize);
  const gh = Math.ceil(height / blockSize);
  const values = new Float64Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / blockSize) * gw;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let v = 0;
      for (let s = 0; s < weights.length; s++) v += weights[s] * sources[s][0][sources[s][1] + p * sources[s][2]];
      if (!Number.isFinite(v)) throw new RangeError(`welch: 样本含非有限值（像素 ${x},${y}）`);
      values[row + Math.floor(x / blockSize)] += v;
    }
  }
  // 边缘不足整块的尾块按实际像素数平均。
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      values[by * gw + bx] /= Math.min(blockSize, width - bx * blockSize) * Math.min(blockSize, height - by * blockSize);
    }
  }
  return { width, height, gw, gh, values, components: weights.length };
}

// groupA、groupB：每边至少 2 个（建议 16 个）独立种子的样本。blockSize 为 1 逐像素，为 8 按 8×8 块。
// channel 为 'luma'（三通道取线性亮度）、通道序号，或 EXR 的通道名。
// shortcut: 亮度检验看不到亮度相抵的纯色偏，要查色偏时按 channel 0、1、2 各跑一次。
export function welchTest(groupA, groupB, options = {}) {
  check(options !== null && typeof options === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(options)), 'options 须为普通对象');
  const { alpha = 0.05, blockSize = 1, bins = 20, histogramAlpha = 0.001, channel = 'luma' } = options;
  check([alpha, histogramAlpha].every(v => typeof v === 'number' && v > 0 && v < 1), 'alpha 与 histogramAlpha 须在 (0, 1) 内');
  check(Number.isInteger(blockSize) && blockSize >= 1, 'blockSize 须为正整数');
  check(Number.isInteger(bins) && bins >= 1 && bins <= 10000, 'bins 须为 1 到 10000 的整数');
  // 先拍快照再查长度：new Array(1) 这种单槽稀疏数组也统一抛 TypeError，之后调用方再改种子组也影响不到统计。
  if (Array.isArray(groupA)) groupA = snapshot(groupA, 'A 组');
  if (Array.isArray(groupB)) groupB = snapshot(groupB, 'B 组');
  check([groupA, groupB].every(g => Array.isArray(g) && g.length >= 2), '每边至少要 2 个种子样本');
  if (groupA.length !== groupB.length) throw new RangeError(`welch: 两边种子数须相等（A ${groupA.length} 个，B ${groupB.length} 个）`);
  // 两边全部帧先解析、校验完，再做统计：最后一帧坏了也在任何累加之前抛。
  // shortcut: 2K 个平面同时在内存里（每单元 8 字节），4K 逐像素 K=16 约 2 GB；吃紧时用 blockSize 8 或改成两遍读。
  const groups = [groupA, groupB].map(group => group.map(sample => loadPlane(sample, channel, blockSize)));
  const grid = groups[0][0];
  for (const plane of groups.flat()) {
    check(plane.width === grid.width && plane.height === grid.height, '样本尺寸不一致');
    check(plane.components === grid.components, '样本通道形态不一致（三通道亮度对单通道）');
  }
  const [a, b] = groups.map(group => {
    const mean = new Float64Array(grid.values.length);
    const m2 = new Float64Array(grid.values.length);
    group.forEach((plane, i) => {
      // Welford 在线均值与平方和，避免大数相减。
      for (let j = 0; j < mean.length; j++) {
        const delta = plane.values[j] - mean[j];
        mean[j] += delta / (i + 1);
        m2[j] += delta * (plane.values[j] - mean[j]);
      }
    });
    return { mean, m2, k: group.length };
  });

  const totalUnits = grid.gw * grid.gh;
  const biasMap = new Float64Array(totalUnits);
  const pMap = new Float64Array(totalUnits).fill(1);
  const tested = [];
  for (let j = 0; j < totalUnits; j++) {
    const delta = a.mean[j] - b.mean[j];
    const va = a.m2[j] / (a.k - 1) / a.k;
    const vb = b.m2[j] / (b.k - 1) / b.k;
    biasMap[j] = delta;
    if (va === 0 && vb === 0) {
      // 两边都无噪声：相等的单元不是随机检验，不进校正和直方图；不等的单元必然有偏。
      if (delta === 0) continue;
      pMap[j] = 0;
    } else {
      const se2 = va + vb;
      const df = se2 * se2 / (va * va / (a.k - 1) + vb * vb / (b.k - 1));
      pMap[j] = studentTwoSidedP(delta / Math.sqrt(se2), df);
    }
    tested.push(j);
  }

  const testedP = Float64Array.from(tested, j => pMap[j]);
  const bh = benjaminiHochberg(testedP, alpha);
  const qMap = new Float64Array(totalUnits).fill(1);
  const significantMask = new Uint8Array(totalUnits);
  const counts = new Array(bins).fill(0);
  let rawSignificant = 0;
  tested.forEach((j, i) => {
    qMap[j] = bh.qValues[i];
    significantMask[j] = bh.significant[i];
    counts[Math.min(bins - 1, Math.floor(testedP[i] * bins))]++;
    if (testedP[i] <= alpha) rawSignificant++;
  });
  // 平坦性只判小 p 端有没有堆高：p <= alpha 的单元数对 Binomial(n, effectiveAlpha) 做单侧精确检验，
  // P(X >= count) = I_rate(count, n - count + 1)。有偏必然让小 p 变多。p 偏向 1（Welch 近似偏保守）不判不过。
  // 噪声非高斯时小 p 的实际比例会略高于 alpha（K=16 均匀噪声实测约 0.0504），全高清的单元数下这点膨胀也显著，
  // 所以名义率按 K 留余量：K=16 时为 alpha 的 1 + 0.5/15 倍。
  const effectiveAlpha = Math.max(alpha, Math.min(0.25, alpha * (1 + 0.5 / Math.max(2, a.k - 1))));
  const lowTailP = rawSignificant
    ? incompleteBeta(effectiveAlpha, 1 - effectiveAlpha, rawSignificant, tested.length - rawSignificant + 1) : 1;
  const flat = lowTailP >= histogramAlpha;
  const significantRatio = tested.length ? bh.significantCount / tested.length : 0;
  return {
    alpha, blockSize, kA: a.k, kB: b.k, gridSize: [grid.gw, grid.gh],
    totalUnits, testedUnits: tested.length, deterministicUnits: totalUnits - tested.length,
    significantCount: bh.significantCount, significantRatio,
    rawSignificantRatio: tested.length ? rawSignificant / tested.length : 0,
    pHistogram: { bins, counts, effectiveAlpha, lowTailP, flat },
    pass: significantRatio <= alpha && flat,
    biasMap, pMap, qMap, significantMask,
  };
}
