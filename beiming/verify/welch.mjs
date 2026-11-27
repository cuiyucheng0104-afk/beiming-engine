// 双样本 Welch t 检验加 Benjamini–Hochberg 校正：判两组带噪渲染（每边 K 个独立种子）是否收敛到同一期望。
import { readFileSync } from 'node:fs';
import { readExr } from './exr/exr.mjs';

function check(condition, reason) {
  if (!condition) throw new Error(`welch: ${reason}`);
}

// length 只读一次，且须是原始非负安全整数：Array 的 Proxy 能让 length 返回带 valueOf 的同一个对象，
// 骗过 === 比较，又在循环里对两边读出不同的数。
function lengthOf(list, name) {
  const length = list.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`welch: ${name} 的 length 须为非负安全整数`);
  return length;
}

// 把普通数组逐下标只读一次拷成快照，之后只用快照：空洞会让种子被悄悄少算，
// 带 getter 的元素能在读取中途删项、改长度或第二次读出别的值：空洞抛 TypeError，长度变了抛 RangeError。
function snapshot(list, name) {
  const length = lengthOf(list, name);
  const sameLength = () => {
    if (list.length !== length) throw new RangeError(`welch: ${name} 的长度在读取中途被改了`);
  };
  sameLength();
  const copy = new Array(length);
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(list, i)) throw new TypeError(`welch: ${name} 第 ${i} 项是空洞（稀疏数组）`);
    copy[i] = list[i];
    sameLength();
  }
  return copy;
}

// 不触发元素 getter 地取种子组每个槽位的属性描述符。空洞当场抛，超长的稀疏数组走不到头。
function slotsOf(group, length, name) {
  const slots = [];
  for (let i = 0; i < length; i++) {
    const slot = Object.getOwnPropertyDescriptor(group, i);
    if (!slot) throw new TypeError(`welch: ${name} 组第 ${i} 项是空洞（稀疏数组，或在读取中途被删了）`);
    slots.push(slot);
  }
  return slots;
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

// 2 的整数次幂表（下标 = 指数 + 1074），从最小次正规数逐次乘 2 得到，每一项都精确。
const POW2 = new Float64Array(2098);
POW2[0] = Number.MIN_VALUE;
for (let i = 1; i < POW2.length; i++) POW2[i] = POW2[i - 1] * 2;

// 最大绝对值的二进制指数（-1074 到 1024），0 记 0。log2 贴着 2 的幂时差 1 无妨：只要乘的是 2 的幂就不舍入。
const exponentOf = maxAbs => (maxAbs === 0 ? 0 : Math.floor(Math.log2(maxAbs)));

// x 乘 2 的 e 次幂（|e| <= 1074）：只移指数，不溢出、不落进次正规就没有舍入。
// 拆两步乘，因为 e 超出 ±1023 时 2^e 本身不可表示。
function scale2(x, e) {
  const half = e >> 1;
  return x * POW2[1074 + half] * POW2[1074 + e - half];
}

// Shewchuk 精确求和（同 Python 的 math.fsum）：partials 是互不重叠的浮点展开，每加一个数都用两数和把舍入误差留在低位，
// 最后只舍入一次。结果是精确和的最近双精度数，只取决于这批数的多重集，与次序无关，大数相消后的小余量也不丢。
// 调用方保证 n >= 1 且 n 个数的绝对值之和小于 2^1023（中间和不溢出）。
const SAFE_SUM = 2 ** 1023;
const partials = [];
function exactSum(values, n) {
  let count = 0;
  for (let k = 0; k < n; k++) {
    let x = values[k];
    let kept = 0;
    for (let j = 0; j < count; j++) {
      let y = partials[j];
      if (Math.abs(x) < Math.abs(y)) {
        const swap = x;
        x = y;
        y = swap;
      }
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[kept++] = lo;
      x = hi;
    }
    partials[kept] = x;
    count = kept + 1;
  }
  // 从高位往低位加，加到第一次出现舍入为止。
  let i = count - 1;
  let hi = partials[i];
  let lo = 0;
  while (i > 0) {
    const x = hi;
    const y = partials[--i];
    hi = x + y;
    lo = y - (hi - x);
    if (lo !== 0) break;
  }
  // 余量恰好是半个末位、更低位还有同号的余量时，最近偶数舍入可能舍错方向，补回去。
  if (i > 0 && ((lo < 0 && partials[i - 1] < 0) || (lo > 0 && partials[i - 1] > 0))) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi;
}

// 有限双精度数写成 2^-1074 的整数倍。
const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
function toBig(v) {
  F64[0] = v;
  const bits = U64[0];
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const magnitude = exponent ? (fraction | 0x10000000000000n) << BigInt(exponent - 1) : fraction;
  return bits >> 63n ? -magnitude : magnitude;
}

// 精确和除以 divisor 的商，按最近偶数只舍入一次。BigInt 把和写成 2^-1074 的整数倍，取 s 使它除以 divisor·2^s 的商不超过 53 位
// （商落在次正规区时 s = 0，末位就是 2^-1074），按余数舍入，再乘回 2^(s-1074)：这一步只移指数，超出双精度范围就是 ±Infinity。
function bigMean(values, n, divisor) {
  let sum = 0n;
  for (let i = 0; i < n; i++) sum += toBig(values[i]);
  const magnitude = sum < 0n ? -sum : sum;
  const d = BigInt(divisor);
  let s = BigInt(Math.max(0, magnitude.toString(2).length - d.toString(2).length - 53));
  if (magnitude >= d << (53n + s)) s += 1n;
  const denominator = d << s;
  let q = magnitude / denominator;
  const twice = (magnitude % denominator) << 1n;
  if (twice > denominator || (twice === denominator && (q & 1n) === 1n)) q += 1n;
  const result = scale2(Number(q), Number(s) - 1074);
  return sum < 0n ? -result : result;
}

// 精确和除以 divisor 的商，只舍入一次。sum 是 exactSum 对这 n 个数的结果（和会溢出、算不了时传 NaN）。
// 先把和舍入成 53 位再除是舍入两次：除数是 3、5（尾块、非 2 的幂的 K）或商落进次正规区时会差 1 个末位，把本来不等的均值并成相等。
// 只有除以 2 的幂且商是正规数时除法才只减指数，其余走 BigInt。和为 0 时精确和就是 0，商也是 0。
function exactQuotient(sum, values, n, divisor) {
  const shiftOnly = POW2[1074 + Math.round(Math.log2(divisor))] === divisor && Math.abs(sum) >= divisor * POW2[53];
  return sum === 0 || shiftOnly ? sum / divisor : bigMean(values, n, divisor);
}

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
  const block = new Float64Array(Math.min(blockSize, width) * Math.min(blockSize, height));
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      // 边缘不足整块的尾块按实际像素数平均。
      const x1 = Math.min(width, (bx + 1) * blockSize);
      const y1 = Math.min(height, (by + 1) * blockSize);
      let count = 0;
      let maxAbs = 0;
      for (let y = by * blockSize; y < y1; y++) {
        for (let x = bx * blockSize; x < x1; x++) {
          const p = y * width + x;
          let v = 0;
          for (let s = 0; s < weights.length; s++) v += weights[s] * sources[s][0][sources[s][1] + p * sources[s][2]];
          if (!Number.isFinite(v)) throw new RangeError(`welch: 样本含非有限值（像素 ${x},${y}）`);
          block[count++] = v;
          maxAbs = Math.max(maxAbs, Math.abs(v));
        }
      }
      // 块均值 = 块内像素的精确和除以像素数，只舍入一次：同一批像素怎么排列都逐位相同，
      // [-2^54, 2^54, 100] 这种大数相消后剩下的 100 也不丢，3、5 个像素的尾块也不多舍一次。
      values[by * gw + bx] = count === 1 ? block[0]
        : exactQuotient(maxAbs * count < SAFE_SUM ? exactSum(block, count) : NaN, block, count, count);
    }
  }
  return { width, height, gw, gh, values, components: weights.length };
}

// groupA、groupB：每边至少 2 个（建议 16 个）独立种子的样本。blockSize 为 1 逐像素，为 8 按 8×8 块。
// channel 为 'luma'（三通道取线性亮度）、通道序号，或 EXR 的通道名。
// shortcut: 亮度检验看不到亮度相抵的纯色偏，要查色偏时按 channel 0、1、2 各跑一次。
export function welchTest(groupA, groupB, options = {}) {
  // 碰 options 之前先记下入口长度：options 的 getter（比如 alpha）也能把 4 帧的 B 缩成 3 帧，让 3 对 4 蒙混成 3 对 3。
  check(Array.isArray(groupA) && Array.isArray(groupB), '每边至少要 2 个种子样本（须为数组）');
  const lengthA = lengthOf(groupA, 'A 组');
  const lengthB = lengthOf(groupB, 'B 组');
  // 同时记下每个槽位的描述符：数据槽位的帧此刻就定了，之后只认它，谁再把 B[2] 原地换掉都进不了统计。
  const entry = [[groupA, lengthA, 'A'], [groupB, lengthB, 'B']]
    .map(([group, length, name]) => [group, length, name, slotsOf(group, length, name)]);
  check(options !== null && typeof options === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(options)), 'options 须为普通对象');
  // 复查原种子组与入口是否一致：只比长度和槽位描述符，不读元素，合法 getter 不会被触发第二次。
  const intact = () => entry.forEach(([group, length, name, slots]) => {
    if (group.length !== length) throw new RangeError(`welch: ${name} 组的长度在读取中途被改了`);
    slotsOf(group, length, name).forEach((slot, i) => {
      if (!Object.is(slot.value, slots[i].value) || slot.get !== slots[i].get) {
        throw new RangeError(`welch: ${name} 组第 ${i} 项在读取中途被换了`);
      }
    });
  });
  // 每读一个属性就复查：alpha 的 getter 把 B 缩短、blockSize 的再补回，等五个都读完才查就漏了。
  const option = (key, fallback) => {
    const value = options[key];
    intact();
    return value === undefined ? fallback : value;
  };
  const alpha = option('alpha', 0.05);
  const blockSize = option('blockSize', 1);
  const bins = option('bins', 20);
  const histogramAlpha = option('histogramAlpha', 0.001);
  const channel = option('channel', 'luma');
  const equivalence = option('equivalence', 0);
  check([alpha, histogramAlpha].every(v => typeof v === 'number' && v > 0 && v < 1), 'alpha 与 histogramAlpha 须在 (0, 1) 内');
  check(typeof equivalence === 'number' && equivalence >= 0 && equivalence < 1, 'equivalence 须在 [0, 1) 内');
  check(Number.isInteger(blockSize) && blockSize >= 1, 'blockSize 须为正整数');
  check(Number.isInteger(bins) && bins >= 1 && bins <= 10000, 'bins 须为 1 到 10000 的整数');
  // 快照：数据槽位直接用入口记下的值，带 getter 的槽位这时才读、只读一次，读完立刻复查（它可能改了任何一边）。
  const snapshots = entry.map(([group, , , slots]) => slots.map((slot, i) => {
    if ('value' in slot) return slot.value;
    const sample = group[i];
    intact();
    return sample;
  }));
  // 稠密的 0 个、1 个与两边不等同属个数不对，都是 RangeError；空洞在入口就抛了 TypeError。
  if (lengthA < 2 || lengthB < 2) throw new RangeError('welch: 每边至少要 2 个种子样本');
  if (lengthA !== lengthB) throw new RangeError(`welch: 两边种子数须相等（A ${lengthA} 个，B ${lengthB} 个）`);
  const k = lengthA; // 两边共用这一个入口种子数：之后的平面数、每组的样本数和自由度都只认它
  // 两边全部帧先解析、校验完，再做统计：最后一帧坏了也在任何累加之前抛。
  // shortcut: 2K 个平面同时在内存里（每单元 8 字节），4K 逐像素 K=16 约 2 GB；吃紧时用 blockSize 8 或改成两遍读。
  const groups = snapshots.map(group => {
    const planes = new Array(k);
    for (let i = 0; i < k; i++) {
      planes[i] = loadPlane(group[i], channel, blockSize);
      intact(); // 帧的 data、像素 getter 也能改种子组：每帧查一次，改短后又补回也逃不掉；末帧这次就是统计前的复查
    }
    return planes;
  });
  const grid = groups[0][0];
  for (const plane of groups.flat()) {
    check(plane.width === grid.width && plane.height === grid.height, '样本尺寸不一致');
    check(plane.components === grid.components, '样本通道形态不一致（三通道亮度对单通道）');
  }
  const totalUnits = grid.gw * grid.gh;
  const biasMap = new Float64Array(totalUnits);
  const pMap = new Float64Array(totalUnits).fill(1);
  const tested = [];
  const [planesA, planesB] = groups;
  const samples = new Float64Array(2 * k); // 一个单元的 2K 个样本：前 K 个是 A，后 K 个是 B 取负
  const centered = new Float64Array(k);
  const guardBits = Math.ceil(Math.log2(2 * k)) + 1;
  let equivalentUnits = 0;
  for (let j = 0; j < totalUnits; j++) {
    let maxAbs = 0;
    for (let i = 0; i < k; i++) {
      samples[i] = planesA[i].values[j];
      samples[k + i] = -planesB[i].values[j];
      maxAbs = Math.max(maxAbs, Math.abs(samples[i]), Math.abs(samples[k + i]));
    }
    // A 减 B 的均值差 = 2K 个带符号样本的精确和除以 K，只舍入一次：两边共有的大数精确相消，不吞真实偏差，也与种子次序无关。
    // 样本贴近双精度上限、2K 个相加会溢出时，偏差走 BigInt（不可表示就是 ±Infinity），检验用的样本先右移几位：
    // 这时丢的只是与 1e300 量级样本同处一个单元的次正规数低位，对 t 的影响不到 2^-1900。
    const guard = maxAbs * 2 * k < SAFE_SUM ? 0 : guardBits;
    if (guard) {
      biasMap[j] = bigMean(samples, 2 * k, k);
      for (let i = 0; i < 2 * k; i++) samples[i] = scale2(samples[i], -guard);
    }
    const sum = exactSum(samples, 2 * k);
    if (!guard) biasMap[j] = exactQuotient(sum, samples, 2 * k, k);
    // 等价下限：均值差不超过 equivalence 乘较大一边的均值绝对值，就算数值上相等，不参检（与无噪声的相等单元同样处理）。
    // 被比的两边是单精度渲染器：运算次序、乘加融合不同，近乎无噪声的块会差零点几个末位，t 检验分不出这是舍入还是偏差。
    // 差恰好是 0 的单元照旧走下面的路（无噪声的记不参检，有噪声的照常检验），等价下限只管不为 0 的差。
    if (equivalence > 0 && sum !== 0) {
      let sa = 0;
      let sb = 0;
      for (let i = 0; i < k; i++) {
        sa += samples[i];
        sb -= samples[k + i];
      }
      const scale = scale2(Math.max(Math.abs(sa), Math.abs(sb)) / k, guard);
      if (Math.abs(biasMap[j]) <= equivalence * scale) {
        equivalentUnits++;
        continue;
      }
    }
    // 每组减去组内最小值，样本变成非负的离差（两个相近的数相减没有舍入）。离差全为 0 才是零方差：
    // Welford 这类边读边更新的算法会把 1 与 1 + 2^-52 的中点舍到端点上，算出假的零方差，结果还随种子次序变。
    const spreads = [0, k].map(start => {
      let low = Infinity;
      let high = -Infinity;
      for (let i = start; i < start + k; i++) {
        low = Math.min(low, samples[i]);
        high = Math.max(high, samples[i]);
      }
      for (let i = start; i < start + k; i++) samples[i] -= low;
      return high - low;
    });
    if (spreads[0] === 0 && spreads[1] === 0) {
      // 两边都无噪声：相等的单元不是随机检验，不进校正和直方图；不等的单元必然有偏。
      if (sum === 0) continue;
      pMap[j] = 0;
    } else {
      // 离差按较大一组的量级除掉 2 的幂再平方：1e-170 的离差直接平方会下溢成 0、1e160 的会上溢。
      // 乘 2 的幂不舍入，样本整体乘 2 的幂时结果逐位不变。和都用精确求和，同一组样本换次序逐位相同。
      const e = exponentOf(Math.max(spreads[0], spreads[1]));
      const [va, vb] = [0, k].map(start => {
        for (let i = 0; i < k; i++) centered[i] = scale2(samples[start + i], -e);
        const mean = exactSum(centered, k) / k;
        for (let i = 0; i < k; i++) centered[i] = (centered[i] - mean) ** 2;
        return exactSum(centered, k) / (k - 1) / k; // 无偏方差再除以 K：均值标准误的平方
      });
      // 自由度只取决于两边方差之比：先除以较大的一边，四次方项才不会下溢成 0/0。
      const top = Math.max(va, vb);
      const ra = va / top;
      const rb = vb / top;
      const df = (ra + rb) ** 2 * (k - 1) / (ra * ra + rb * rb);
      // 均值差远大于离差时 t 溢出成 ±Infinity，p 记 0。
      pMap[j] = studentTwoSidedP(scale2(sum, -e) / k / Math.sqrt(va + vb), df);
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
  const effectiveAlpha = Math.max(alpha, Math.min(0.25, alpha * (1 + 0.5 / Math.max(2, k - 1))));
  const lowTailP = rawSignificant
    ? incompleteBeta(effectiveAlpha, 1 - effectiveAlpha, rawSignificant, tested.length - rawSignificant + 1) : 1;
  const flat = lowTailP >= histogramAlpha;
  const significantRatio = tested.length ? bh.significantCount / tested.length : 0;
  return {
    alpha, blockSize, equivalence, kA: k, kB: k, gridSize: [grid.gw, grid.gh],
    totalUnits, testedUnits: tested.length, deterministicUnits: totalUnits - tested.length - equivalentUnits, equivalentUnits,
    significantCount: bh.significantCount, significantRatio,
    rawSignificantRatio: tested.length ? rawSignificant / tested.length : 0,
    pHistogram: { bins, counts, effectiveAlpha, lowTailP, flat },
    pass: significantRatio <= alpha && flat,
    biasMap, pMap, qMap, significantMask,
  };
}
