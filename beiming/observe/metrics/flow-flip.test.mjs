import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const metrics = await import(pathToFileURL(resolve(here, 'index.mjs')).href);
const observe = await import(pathToFileURL(resolve(here, '../index.mjs')).href);
const { flowField, imageFlip, runFlowFlipMetric } = metrics;
const badArgument = { name: 'RangeError', code: 'usage.bad-argument' };
const flipStats = ['mean', 'weightedMedian', 'q1', 'q3', 'p95', 'max'];

function near(value, expected, tolerance, label) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${label} 读出 ${value}，期望 ${expected} ± ${tolerance}`);
}
function luma(width, height, sample) {
  return { width, height, luma: Float32Array.from({ length: width * height }, (_, i) => sample(i % width, Math.floor(i / width))) };
}
function rgb(width, height, sample, Type = Uint8Array) {
  const pixels = new Type(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = sample(x, y);
    pixels.set(typeof c === 'number' ? [c, c, c] : c, 3 * (y * width + x));
  }
  return { width, height, rgb: pixels };
}

// 对连续函数在指定位置采样。x、y 各有独立梯度，移动时无需整数取整或调用被测方的插值器。
function texture(x, y) {
  return 0.5 + 0.16 * Math.sin(0.39 * x + 0.13 * y) + 0.14 * Math.cos(0.09 * x - 0.43 * y)
    + 0.1 * Math.sin(0.22 * x + 0.32 * y);
}
const translate = (dx, dy, width = 70, height = 52) => luma(width, height, (x, y) => texture(x - dx, y - dy));

test('两个公共入口导出指标和分派器，指标名可带 metric: 前缀', () => {
  for (const name of ['flowField', 'imageFlip', 'runFlowFlipMetric']) {
    assert.equal(typeof metrics[name], 'function', name);
    assert.equal(observe[name], metrics[name], name);
  }
  assert.equal(observe.FLOW_FLIP_METRICS, metrics.FLOW_FLIP_METRICS);
  const frame = rgb(16, 12, (x, y) => 3 * x + y);
  for (const [name, fn, args] of [['flow.field', flowField, [[frame, frame]]], ['image.flip', imageFlip, [frame, frame]]]) {
    assert.equal(metrics.FLOW_FLIP_METRICS[name], fn);
    const direct = fn(...args);
    assert.equal(direct.metric, `metric:${name}`);
    for (const id of [name, `metric:${name}`]) assert.deepEqual(runFlowFlipMetric(id, ...args), direct);
  }
  for (const id of ['metric:unknown', 'constructor', null]) assert.throws(() => runFlowFlipMetric(id, frame), badArgument);
});

test('相邻帧按顺序量出 0.5、2.5 px 平移和负 y 方向，幅度单位是 px/帧', () => {
  const frames = [[0, 0], [0.5, 0], [3, 0], [3, -0.5]].map(([x, y]) => translate(x, y));
  const result = flowField(frames, { fps: 24, roi: { x: 13, y: 11, width: 44, height: 30 } });
  assert.equal(result.curve.length, 3);
  assert.equal(result.fields, undefined);
  for (const [i, [dx, dy]] of [[0.5, 0], [2.5, 0], [0, -0.5]].entries()) {
    const p = result.curve[i];
    near(p.meanDx, dx, 0.10, `第 ${i} 对 dx`);
    near(p.meanDy, dy, 0.10, `第 ${i} 对 dy`);
    near(p.meanMag, Math.hypot(dx, dy), 0.10, `第 ${i} 对幅度`);
    near(Math.cos(p.coherentAngleRad), dx / Math.hypot(dx, dy), 0.12, `第 ${i} 对方向 x`);
    near(Math.sin(p.coherentAngleRad), dy / Math.hypot(dx, dy), 0.12, `第 ${i} 对方向 y`);
    assert.ok(p.p95Mag >= 0 && p.maxMag >= p.p95Mag && p.maxMag >= p.meanMag);
  }
});

test('同一帧对的左右区域向两个方向独立移动，按 ROI 行优先取每个向量并核算曲线', () => {
  const width = 96, height = 56, seam = 48;
  const left = [1.25, 0.5], right = [-0.75, -1.25];
  const before = translate(0, 0, width, height);
  const after = luma(width, height, (x, y) => {
    const [dx, dy] = x < seam ? left : right;
    return texture(x - dx, y - dy);
  });
  const roi = { x: 12, y: 9, width: 71, height: 37 };
  const { fields, curve } = flowField([before, after], { roi, includeFields: true, windowRadius: 3, iterations: 5, pyramidLevels: 3 });
  assert.equal(fields.length, 1);
  const { dx, dy } = fields[0], n = roi.width * roi.height;
  assert.equal(dx.length, n);
  assert.equal(dy.length, n);
  const mag = [], total = [0, 0], matched = [0, 0];
  let sumX = 0, sumY = 0, sumMag = 0;
  for (let i = 0; i < n; i++) {
    const x = i % roi.width, y = Math.floor(i / roi.width), globalX = roi.x + x;
    const m = Math.hypot(dx[i], dy[i]);
    mag.push(m);
    sumMag += m;
    sumX += dx[i];
    sumY += dy[i];
    if (Math.min(x, y, roi.width - 1 - x, roi.height - 1 - y, Math.abs(globalX - seam)) < 7) continue;
    const side = Number(globalX >= seam), expected = side ? right : left;
    total[side]++;
    if (Math.hypot(dx[i] - expected[0], dy[i] - expected[1]) <= 0.30) matched[side]++;
  }
  for (const side of [0, 1]) assert.ok(matched[side] >= 0.9 * total[side], `区域 ${side} 的正确向量 ${matched[side]}/${total[side]}`);
  mag.sort((a, b) => a - b);
  near(curve[0].meanDx, sumX / n, 1e-5, '从 ROI 核算 meanDx');
  near(curve[0].meanDy, sumY / n, 1e-5, '从 ROI 核算 meanDy');
  near(curve[0].meanMag, sumMag / n, 1e-5, '从 ROI 核算 meanMag');
  const rank = 0.95 * (n - 1);
  assert.ok(curve[0].p95Mag >= mag[Math.floor(rank)] - 1e-5 && curve[0].p95Mag <= mag[Math.ceil(rank)] + 1e-5);
  near(curve[0].maxMag, mag.at(-1), 1e-5, '从 ROI 核算 maxMag');
});

test('静止的纹理序列逐对、逐像素、逐频点为零', () => {
  const frames = Array.from({ length: 9 }, () => translate(0, 0, 24, 18));
  const { curve, fields, spectrum, mean, p95, max } = flowField(frames, { fps: 24, includeFields: true });
  assert.deepEqual([mean, p95, max], [0, 0, 0]);
  assert.equal(curve.length, frames.length - 1);
  assert.equal(fields.length, curve.length);
  for (const p of curve) {
    assert.deepEqual([p.meanMag, p.p95Mag, p.maxMag, p.meanDx, p.meanDy], [0, 0, 0, 0, 0]);
    assert.equal(p.coherentAngleRad, null);
  }
  for (const { dx, dy } of fields) for (const plane of [dx, dy]) {
    assert.equal(plane.length, 24 * 18);
    assert.ok(plane.every(v => v === 0));
  }
  assert.equal(spectrum.spectralEnergy, 0);
  assert.ok(spectrum.bins.length > 0 && spectrum.bins.every(b => b.amplitude === 0));
});

test('2 Hz 正弦位置产生 4 Hz 速度幅度峰，同组帧以 48 fps 解释时峰在 6 Hz', () => {
  const n = 32, position = t => 2.5 * Math.sin(2 * Math.PI * 2 * t / n);
  const frames = Array.from({ length: n + 1 }, (_, t) => translate(position(t), 0, 50, 38));
  for (const fps of [32, 48]) {
    const { curve, spectrum } = flowField(frames, { fps, roi: { x: 9, y: 7, width: 32, height: 24 } });
    assert.equal(curve.length, n);
    curve.forEach(({ meanMag }, t) => near(meanMag, Math.abs(position(t + 1) - position(t)), 0.11, `第 ${t} 对速度幅度`));
    const bins = spectrum.bins.filter(b => b.index > 0);
    assert.ok(bins.length >= 4 && spectrum.spectralEnergy > 0 && Number.isFinite(spectrum.spectralEnergy));
    for (const b of bins) {
      near(b.freqHz, b.index * fps / n, 1e-10, `频点 ${b.index}`);
      assert.ok(Number.isFinite(b.amplitude) && b.amplitude >= 0);
    }
    const peak = bins.reduce((a, b) => a.amplitude > b.amplitude ? a : b);
    assert.ok(peak.amplitude > 0);
    assert.equal(peak.index, 4);
    near(spectrum.dominantFreqHz, peak.freqHz, 1e-10, '幅度谱主频');
    // 对理想的 32 个 |Δ位置| 样本直接求和，8/4 频点幅值比在矩形窗为 0.17958、Hann 窗为 0.17706。
    const harmonic = bins.find(b => b.index === 8);
    assert.ok(harmonic);
    near(harmonic.amplitude / peak.amplitude, 0.178, 0.035, '幅度谱的二次谐波');
  }
});

// Andersson 等，HPG 2020；公式与参数见 NVlabs/flip 固定版本的 compute_ldrflip：
// https://github.com/NVlabs/flip/blob/d3ab02a4425eb167d8a4021b382a2bafc6e6c838/src/pytorch/flip_loss.py#L169-L228
// 下列常数由独立双精度求和得到。均匀场的特征差为零，令 t=(HyAB/203.30165459)^0.7，
// 绿/蓝给出 Hunt 调整后的分母；以 (0,0)、(0.4,0.95)、(1,1) 分段线性映射 t。
const uniformOracle = [
  [[128, 128, 128], [160, 160, 160], 0.33302217],
  [[70, 130, 180], [110, 108, 192], 0.41975735],
  [[255, 0, 0], [0, 255, 255], 0.97990650],
];

test('标准 LDR-FLIP 纯色数值覆盖两段 HyAB 映射、sRGB 解码及线性浮点入口', () => {
  const decode = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  for (const [a, b, expected] of uniformOracle) {
    const [ref, target] = [a, b].map(c => rgb(19, 15, () => c));
    const bytes = imageFlip(ref, target, { includeMap: true });
    assert.ok(bytes.map instanceof Float32Array && bytes.map.length === 19 * 15);
    for (const stat of flipStats) near(bytes[stat], expected, 0.0003, `${a} 对 ${b} 的 ${stat}`);
    assert.ok(bytes.map.every(v => Math.abs(v - expected) <= 0.0003));
    for (const transfer of ['srgb', 'linear']) {
      const [r, t] = [a, b].map(c => rgb(19, 15, () => c.map(v => transfer === 'srgb' ? v / 255 : decode(v / 255)), Float32Array));
      near(imageFlip(r, t, { transfer }).mean, expected, 0.0003, `${transfer} 帧`);
      if (transfer === 'srgb') near(imageFlip(r, t).mean, expected, 0.0003, '浮点帧默认 sRGB');
    }
  }
});

function patchPair() {
  const bg = [80, 90, 100], fg = [236, 198, 36];
  return [rgb(41, 31, () => bg), rgb(41, 31, (x, y) => Math.abs(x - 17) <= 1 && Math.abs(y - 14) <= 1 ? fg : bg)];
}

test('标准 LDR-FLIP 空间数值，3×3 彩色斑点区分一阶边缘、二阶特征和观察距离', () => {
  const [a, b] = patchPair();
  // 对 3×3 支持域直接累加归一化的二维 A/RG/BY CSF 和两阶导数核。导数正、负半核各归一；
  // σ=0.041·ppd，最终取 Ec^(1−sqrt(max(边缘差,点差)/√2))。中心的一阶响应正好为零。
  const samples = [[0, 0], [2, 1], [4, 3]];
  for (const [ppd, expected] of [[36, [0.98061673, 0.69789917, 0.05066550]], [60, [0.91992306, 0.62359458, 0.15773258]]]) {
    const result = imageFlip(a, b, { ppd, includeMap: true });
    assert.equal(result.ppd, ppd);
    assert.equal(result.map.length, a.width * a.height);
    samples.forEach(([dx, dy], i) => near(result.map[(14 + dy) * a.width + 17 + dx], expected[i], 0.001, `${ppd} ppd 偏移 (${dx},${dy})`));
    assert.ok(result.map.every(v => v >= 0 && v <= 1));
    const sorted = result.map.slice().sort(), sum = sorted.reduce((s, v) => s + v, 0);
    near(result.mean, sum / sorted.length, 1e-6, '整图均值');
    near(result.max, sorted.at(-1), 1e-6, '整图最大值');
    for (const [key, fraction] of [['q1', 0.25], ['weightedMedian', 0.5], ['q3', 0.75]]) {
      let cumulative = 0;
      const quantile = sorted.find(v => (cumulative += v) >= fraction * sum);
      near(result[key], quantile, 1e-6, `按像素误差加权的 ${key}`);
    }
    near(result.p95, sorted[Math.ceil(0.95 * sorted.length) - 1], 1e-6, '按像素数取 nearest-rank p95');
  }
  const geometry = { distanceM: 0.8, monitorWidthM: 0.64, resolutionX: 2560 };
  const physical = imageFlip(a, b, geometry), ppd = (0.8 * 2560 / 0.64) * Math.PI / 180;
  near(physical.ppd, ppd, 1e-4, '物理观看参数');
  near(physical.mean, imageFlip(a, b, { ppd }).mean, 1e-6, '直接指定相同 ppd');
  near(imageFlip(a, b).ppd, 3840 * Math.PI / 180, 1e-4, '默认 ppd');
});

test('恒等图的每个像素及汇总均严格为零，交换参照与候选逐位对称', () => {
  const [a, b] = patchPair();
  const equal = imageFlip(b, { ...b, rgb: b.rgb.slice() }, { includeMap: true, threshold: 0 });
  for (const stat of flipStats) assert.equal(equal[stat], 0, stat);
  assert.ok(equal.map instanceof Float32Array && equal.map.length === b.width * b.height);
  assert.ok(equal.map.every(v => Object.is(v, 0)));
  assert.equal(equal.pass, true);
  const opts = { includeMap: true, ppd: 48 };
  const ab = imageFlip(a, b, opts), ba = imageFlip(b, a, opts);
  assert.ok(ab.mean > 0);
  for (const stat of flipStats) assert.equal(ab[stat], ba[stat], stat);
  assert.deepEqual(ab.map, ba.map);
  assert.equal(imageFlip(a, b).map, undefined);
});

test('逐级加大亮度、等亮度色偏、盒滤波模糊和轮廓锯齿，四组均值各自严格递增', () => {
  function increasing(label, ref, variants, opts) {
    const means = [0, ...variants.map(v => imageFlip(ref, v, opts).mean)];
    for (let i = 1; i < means.length; i++) assert.ok(means[i] > means[i - 1], `${label} 各级均值 ${means}`);
  }
  const gray = code => rgb(40, 32, () => code);
  increasing('亮度', gray(96), [100, 112, 144].map(gray));
  // 线性 Rec.709 里补偿绿分量，保持 Y 不变。
  const tint = d => rgb(40, 32, () => [0.25 + d, 0.25 - d * 0.2126 / 0.7152, 0.25], Float32Array);
  increasing('色度', tint(0), [0.015, 0.06, 0.16].map(tint), { transfer: 'linear' });
  const bar = x => Math.floor(x / 10) % 2 ? 210 : 42;
  const blur = radius => rgb(60, 32, x => {
    let sum = 0;
    for (let u = -radius; u <= radius; u++) sum += bar(Math.max(0, Math.min(59, x + u)));
    return Math.round(sum / (2 * radius + 1));
  });
  increasing('模糊', blur(0), [1, 2, 4].map(blur));
  const edge = amount => rgb(48, 40, (x, y) => x < 24 + amount * (Math.floor(y / 4) % 2 ? 1 : -1) ? 42 : 210);
  increasing('边缘锯齿', edge(0), [1, 2, 4].map(edge));
});

test('合成跨 GPU 门槛，局部 1 码舍入通过，材质亮度回归失败，阈值等于 mean 时通过', () => {
  const sample = offset => rgb(48, 32, (x, y) => 92 + Math.floor(x / 2) + Math.floor(y / 3) + (x >= 24 ? offset : 0));
  const ref = sample(0), rounding = sample(1), material = sample(28), threshold = 0.05;
  const good = imageFlip(ref, rounding, { threshold }), bad = imageFlip(ref, material, { threshold });
  assert.ok(0 < good.mean && good.mean < threshold && threshold < bad.mean, `舍入 ${good.mean}，材质回归 ${bad.mean}`);
  assert.equal(good.pass, true);
  assert.equal(bad.pass, false);
  assert.equal(imageFlip(ref, material, { threshold: bad.mean }).pass, true);
  assert.equal(imageFlip(ref, material, { threshold: bad.mean - 1e-7 }).pass, false);
});

test('非零光流场、频谱及 FLIP 图连同标量五次逐位复现', () => {
  const sequence = [0, 0.5, 1.75, 0.75, 0].map(x => translate(x, 0, 35, 27));
  const [ref, target] = patchPair();
  for (const run of [() => flowField(sequence, { fps: 24, includeFields: true }), () => imageFlip(ref, target, { includeMap: true })]) {
    // 定型数组的 strict deepEqual 比较视图字节；保存快照也能发现后一次调用覆写前次缓冲区。
    const first = structuredClone(run());
    for (let i = 1; i < 5; i++) assert.deepEqual(run(), first);
  }
});

test('帧、像素、ROI、序列索引和选项遇到 Proxy/getter/原型空洞时均按错误码拒绝，陷阱计数为零', () => {
  const f = translate(0, 0, 12, 10), frames = [f, f], roi = { x: 1, y: 1, width: 8, height: 6 };
  let hits = 0;
  function trap() { hits++; throw new Error('执行了输入陷阱'); }
  const handler = Object.fromEntries(Object.getOwnPropertyNames(Reflect).map(name => [name, trap]));
  const proxy = value => new Proxy(value, handler);
  const getter = (object, key) => Object.defineProperty(object, key, { get: trap, configurable: true });
  function reject(label, run) {
    assert.throws(run, badArgument, label);
    assert.equal(hits, 0, label);
  }
  const sparse = [f, f, f];
  delete sparse[1];
  const inherited = sparse.slice();
  Object.setPrototypeOf(inherited, getter(Object.create(Array.prototype), 1));
  for (const list of [proxy(frames), sparse, inherited, getter([f, f], 1)]) reject('帧序列', () => flowField(list));
  for (const key of ['length', 'buffer', 'constructor', Symbol.iterator, Symbol.toStringTag]) {
    const pixels = getter(f.luma.slice(), key);
    reject('像素视图成员', () => imageFlip({ ...f, luma: pixels }, f));
  }
  reject('分派名不隐式转字符串', () => runFlowFlipMetric(proxy({}), f));
  for (const bad of [proxy(f), getter({ ...f }, 'width'), getter({ ...f }, 'luma'), { ...f, luma: proxy(f.luma) }]) {
    reject('光流帧', () => flowField([f, bad]));
    reject('参照帧', () => imageFlip(bad, f));
    reject('候选帧', () => imageFlip(f, bad));
  }
  for (const bad of [proxy(roi), ...Object.keys(roi).map(k => getter({ ...roi }, k))]) reject('ROI', () => flowField(frames, { roi: bad }));
  for (const [run, keys] of [
    [opts => flowField(frames, opts), ['fps', 'roi', 'includeFields', 'windowRadius', 'iterations', 'pyramidLevels']],
    [opts => imageFlip(f, f, opts), ['ppd', 'transfer', 'includeMap', 'threshold', 'distanceM', 'monitorWidthM', 'resolutionX']],
  ]) {
    reject('选项对象', () => run(proxy({})));
    for (const key of keys) {
      reject(`${key} 访问器`, () => run(getter({}, key)));
      reject(`${key} 代理值`, () => run({ [key]: proxy({}) }));
    }
  }
});

test('维度、非有限像素、非法 ROI、数值和未知选项均抛 usage.bad-argument', () => {
  const f = translate(0, 0, 12, 10), frames = [f, f];
  for (const sequence of [[], [f], [f, null], [f, translate(0, 0, 10, 12)]]) assert.throws(() => flowField(sequence), badArgument);
  const malformed = [{ ...f, width: 0 }, { ...f, luma: new Float32Array(119) }, { ...f, luma: new Array(120) }];
  for (const value of [NaN, -Infinity, Infinity]) {
    const pixels = f.luma.slice();
    pixels[pixels.length - 1] = value;
    malformed.push({ ...f, luma: pixels });
  }
  for (const bad of malformed) {
    assert.throws(() => flowField([f, bad]), badArgument);
    assert.throws(() => imageFlip(f, bad), badArgument);
  }
  assert.throws(() => imageFlip(f, translate(0, 0, 10, 12)), badArgument);
  for (const opts of [null, { fps: 0 }, { fps: Infinity }, { fps: '24' }, { includeFields: 1 }, { pyramidLevels: -1 },
    { iterations: 1.5 }, { windowRadius: -1 }, { roi: { x: 8, y: 2, width: 5, height: 4 } }, { fsp: 24 }]) {
    assert.throws(() => flowField(frames, opts), badArgument);
  }
  for (const opts of [null, { ppd: NaN }, { ppd: 0 }, { ppd: '60' }, { transfer: 'pq' }, { includeMap: 1 },
    { threshold: -1 }, { threshold: 1.01 }, { distanceM: -1 }, { monitorWidthM: 0 }, { resolutionX: Infinity }, { pdp: 60 }]) {
    assert.throws(() => imageFlip(f, f, opts), badArgument);
  }
});
