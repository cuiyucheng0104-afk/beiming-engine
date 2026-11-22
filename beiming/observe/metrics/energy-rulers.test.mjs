import test from 'node:test';
import assert from 'node:assert/strict';
import * as observe from '../index.mjs';
import { clipHighlightRatio, noiseResidual, aliasEdge, colorPaletteDe00, shapeIou,
  ENERGY_METRICS, runEnergyMetric } from './index.mjs';

// 合成帧都照 beiming/calib 的校准场景搭：灰阶卡（probe-gray-chart）、静止背景上匀速平移的方块（probe-moving-cube）、
// 斜细杆（probe-thin-geometry）。噪声用固定种子，同一份夹具每次生成逐位相同。
const W = 64, H = 48;

function rgba(width, height, pixel) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = pixel(x, y), [r, g, b, a = 255] = Array.isArray(v) ? v : [v, v, v];
    out.set([r, g, b, a], (y * width + x) * 4);
  }
  return { width, height, rgba: out };
}
function luma(width, height, pixel, Type = Float32Array) {
  const out = new Type(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = pixel(x, y);
  return { width, height, luma: out };
}
function gaussian(seed) {
  let s = seed >>> 0;
  const uniform = () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}
const badArgument = { name: 'RangeError', code: 'usage.bad-argument' };
const repeat5 = (run) => { const first = run(); for (let i = 0; i < 4; i++) assert.deepStrictEqual(run(), first); return first; };

// 八级灰阶卡，最亮一级码值 224，没有削顶。
const grayChart = gain => rgba(W, H, x => Math.min(255, Math.round((Math.floor(x / 8) + 1) * 28 * gain)));
// 斜细杆：宽 2.4 像素，每行横移 0.3 像素。samples 是每轴子采样数，1 是点采样。
const rod = (samples, phase = 0) => luma(W, H, (x, y) => {
  let hit = 0;
  for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) {
    const u = x + (i + 0.5) / samples, v = y + (j + 0.5) / samples;
    if (Math.abs(u - (20.37 + phase + 0.3 * v)) < 1.2) hit++;
  }
  return 0.1 + 0.8 * hit / samples ** 2;
});
const disc = (cx, cy, r = 10) => ({ width: W, height: H, mask: Uint8Array.from({ length: W * H }, (_, p) => Math.hypot(p % W - cx, Math.floor(p / W) - cy) <= r ? 1 : 0) });
const empty = () => ({ width: W, height: H, mask: new Uint8Array(W * H) });

test('五个指标与分派器从 metrics 和 observe 两级入口导出，标准名带不带前缀都认', () => {
  for (const name of ['clipHighlightRatio', 'noiseResidual', 'aliasEdge', 'colorPaletteDe00', 'shapeIou', 'runEnergyMetric']) {
    assert.equal(typeof observe[name], 'function', name);
  }
  assert.equal(observe.ENERGY_METRICS, ENERGY_METRICS);
  assert.deepEqual(Object.keys(ENERGY_METRICS), ['clip.highlight-ratio', 'noise.residual', 'alias.edge', 'color.palette-de00', 'shape.iou']);
  assert.ok(Object.isFrozen(ENERGY_METRICS));
  const frame = grayChart(1);
  assert.deepStrictEqual(runEnergyMetric('metric:clip.highlight-ratio', frame), clipHighlightRatio(frame));
  assert.deepStrictEqual(runEnergyMetric('shape.iou', disc(30, 24), disc(30, 24)), shapeIou(disc(30, 24), disc(30, 24)));
  for (const [name, fn] of Object.entries(ENERGY_METRICS)) assert.equal(typeof fn, 'function', name);
  for (const name of ['metric:nope', 'toString', '', null, undefined]) assert.throws(() => runEnergyMetric(name, frame), badArgument);
});

test('clip.highlight-ratio：灰阶卡读 0，加过曝单调升高，8 位与线性浮点都认', () => {
  const normal = repeat5(() => clipHighlightRatio(grayChart(1)));
  assert.equal(normal.metric, 'metric:clip.highlight-ratio');
  assert.equal(normal.ratio, 0);
  assert.equal(normal.clippedPixels, 0);
  assert.equal(normal.totalPixels, W * H);
  assert.equal(normal.peakMax, 224);
  assert.deepEqual(normal.channelRatios, [0, 0, 0]);
  // 增益 1.2 削掉最亮一级，1.6 削掉三级，4 削掉六级。
  const ratios = [1.2, 1.6, 4].map(gain => repeat5(() => clipHighlightRatio(grayChart(gain))).ratio);
  assert.deepEqual(ratios, [1 / 8, 3 / 8, 6 / 8]);
  const over = clipHighlightRatio(grayChart(1.6));
  assert.equal(over.peakMax, 255);
  assert.equal(over.plateauRatio, 3 / 8);
  // 边界：阈值是闭区间，254 计入、253 不计。
  assert.equal(clipHighlightRatio(rgba(4, 4, () => 254)).ratio, 1);
  assert.equal(clipHighlightRatio(rgba(4, 4, () => 253)).ratio, 0);
  assert.equal(clipHighlightRatio(rgba(4, 4, () => 253), { threshold: 253 }).ratio, 1);
  // 只有红通道削顶。
  assert.deepEqual(clipHighlightRatio(rgba(4, 4, x => x < 2 ? [255, 10, 10] : [10, 10, 10])).channelRatios, [0.5, 0, 0]);
  // 线性浮点：1 是显示白，默认阈值 1；HDR 峰值照原样报。
  const hdr = gain => ({ width: W, height: H, rgb: Float32Array.from({ length: W * H * 3 }, (_, i) => (Math.floor((Math.floor(i / 3) % W) / 8) + 1) / 9 * gain) });
  assert.equal(repeat5(() => clipHighlightRatio(hdr(1))).ratio, 0);
  const hot = repeat5(() => clipHighlightRatio(hdr(4)));
  assert.equal(hot.ratio, 6 / 8);
  assert.ok(Math.abs(hot.peakMax - 32 / 9) < 1e-6);
  assert.equal(clipHighlightRatio(hdr(4), { threshold: 3.5 }).ratio, 1 / 8);
  // roi 与 alphaMask：透明背景不进分母。
  assert.equal(clipHighlightRatio(grayChart(1.2), { roi: { x: 56, y: 0, width: 8, height: H } }).ratio, 1);
  const cutout = rgba(8, 8, x => x < 4 ? [255, 255, 255, 0] : x < 6 ? [255, 255, 255, 255] : [40, 40, 40, 255]);
  assert.equal(clipHighlightRatio(cutout).ratio, 0.75);
  const masked = clipHighlightRatio(cutout, { alphaMask: true });
  assert.equal(masked.ratio, 0.5);
  assert.equal(masked.totalPixels, 32);
  const none = clipHighlightRatio(rgba(4, 4, () => [255, 255, 255, 0]), { alphaMask: true });
  assert.deepEqual([none.ratio, none.totalPixels, none.peakMax], [0, 0, null]);
});

test('noise.residual：静止无噪读 0，随噪声标准差单调上升，运动方块不污染背景读数', () => {
  const still = [0, 1, 2, 3].map(() => luma(W, H, x => 0.2 + x / 256));
  const clean = repeat5(() => noiseResidual(still));
  assert.equal(clean.metric, 'metric:noise.residual');
  assert.deepEqual([clean.value, clean.status, clean.staticRatio], [0, 'ok', 1]);

  const noisy = (sigma, cube) => {
    const next = gaussian(20261122);
    return [0, 1, 2, 3].map(t => luma(W, H, (x, y) => {
      const inCube = cube && x >= 8 + 6 * t && x < 24 + 6 * t && y >= 16 && y < 32;
      return (inCube ? 0.9 : 0.2 + x / 256) + sigma * next();
    }));
  };
  const sigmas = [0.005, 0.01, 0.02, 0.04];
  const readings = sigmas.map(sigma => repeat5(() => noiseResidual(noisy(sigma))).value);
  readings.forEach((value, i) => {
    assert.ok(i === 0 || value > readings[i - 1], `读数应随噪声上升：${readings}`);
    assert.ok(Math.abs(value / sigmas[i] - 1) < 0.15, `读数应折算成单帧噪声标准差：${value} 对 ${sigmas[i]}`);
  });

  // 每帧右移 6 像素的方块：无噪时背景读 0，方块所在与相邻的块被排除。
  const cube = repeat5(() => noiseResidual(noisy(0, true)));
  assert.equal(cube.value, 0);
  assert.ok(cube.staticRatio > 0.3 && cube.staticRatio < 1, `staticRatio ${cube.staticRatio}`);
  // 有噪时带方块与不带方块的读数差不到一成，直接把运动算进去会高出一个量级。
  const withCube = noiseResidual(noisy(0.01, true)).value, without = noiseResidual(noisy(0.01)).value;
  assert.ok(Math.abs(withCube / without - 1) < 0.1, `${withCube} 对 ${without}`);

  // 8 位输入同口径，单位是码值。
  const bytes = sigma => { const next = gaussian(7); return [0, 1, 2].map(() => rgba(W, H, x => Math.max(0, Math.min(255, Math.round(96 + x / 2 + sigma * next()))))); };
  assert.deepEqual([noiseResidual(bytes(0)).value, noiseResidual(bytes(0)).unit], [0, 'code8']);
  assert.ok(noiseResidual(bytes(6)).value > noiseResidual(bytes(3)).value && noiseResidual(bytes(3)).value > 1);

  // 全画幅剧烈运动：没有静止像素，显式报状态，不出 NaN。
  const flash = repeat5(() => noiseResidual([0, 1, 2].map(t => luma(W, H, () => t % 2 ? 0.9 : 0.1))));
  assert.deepEqual([flash.value, flash.status, flash.staticRatio, flash.staticPixels], [null, 'no-static-region', 0, 0]);
});

test('alias.edge：点采样斜细杆的锯齿度显著高于 4 倍超采样盒滤波，边缘来回跳读成闪烁', () => {
  const jagged = repeat5(() => aliasEdge(rod(1))), smooth = repeat5(() => aliasEdge(rod(4)));
  assert.equal(jagged.metric, 'metric:alias.edge');
  assert.equal(jagged.status, 'ok');
  assert.ok(jagged.edgePixels > 50 && smooth.edgePixels > 50);
  assert.ok(jagged.jaggedness > 0.3, `点采样 ${jagged.jaggedness}`);
  assert.ok(smooth.jaggedness < 0.1, `盒滤波 ${smooth.jaggedness}`);
  assert.ok(jagged.jaggedness > 4 * smooth.jaggedness);
  // 超采样越细读数越低。
  const two = aliasEdge(rod(2)).jaggedness;
  assert.ok(jagged.jaggedness > two && two > smooth.jaggedness, `${jagged.jaggedness} ${two} ${smooth.jaggedness}`);
  assert.equal(jagged.flicker, null);

  // 平场没有边缘：读 0 并报状态。
  const flat = aliasEdge(luma(W, H, () => 0.5));
  assert.deepEqual([flat.value, flat.status, flat.edgePixels], [0, 'no-edges', 0]);

  // 闪烁：细杆在两个子像素相位之间来回跳；静止序列读 0；点采样跳得比盒滤波狠。
  const jitter = samples => [0, 0.5, 0, 0.5, 0].map(phase => rod(samples, phase));
  const steady = repeat5(() => aliasEdge([rod(1), rod(1), rod(1)]));
  assert.equal(steady.flicker, 0);
  assert.equal(steady.frames, 3);
  const point = repeat5(() => aliasEdge(jitter(1))), box = aliasEdge(jitter(4));
  assert.ok(point.flicker > 0.05 && point.flicker > box.flicker && box.flicker > 0, `${point.flicker} ${box.flicker}`);
  // 8 位输入：码值量纲。
  const bytes = samples => { const f = rod(samples); return rgba(W, H, (x, y) => Math.round(255 * f.luma[y * W + x])); };
  assert.ok(aliasEdge(bytes(1)).jaggedness > 4 * aliasEdge(bytes(4)).jaggedness);
  assert.equal(aliasEdge([bytes(1), bytes(1), bytes(1)]).flickerUnit, 'code8');
});

test('color.palette-de00：相同色板读 0，色相偏移单调升高，CIEDE2000 对得上已知值', () => {
  const target = [{ rgb: [200, 40, 40], share: 0.5 }, { rgb: [40, 90, 200], share: 0.3 }, { rgb: [240, 240, 235], share: 0.2 }];
  const same = repeat5(() => colorPaletteDe00(target, target));
  assert.equal(same.metric, 'metric:color.palette-de00');
  assert.deepEqual([same.value, same.meanDe00, same.maxDe00, same.weightedDe00, same.reverse.meanDe00], [0, 0, 0, 0, 0]);
  assert.deepEqual(same.pairs.map(p => p.index), [0, 1, 2]);

  // 把红往橙推：色差单调升高，另外两色不动。
  const shifted = green => [{ rgb: [200, green, 40], share: 0.5 }, ...target.slice(1)];
  const steps = [60, 90, 130].map(green => repeat5(() => colorPaletteDe00(shifted(green), target)));
  steps.forEach((r, i) => assert.ok(r.value > (i ? steps[i - 1].value : 1), `色差应升高：${steps.map(s => s.value)}`));
  const far = steps[2];
  assert.ok(far.maxDe00 > 10);
  assert.equal(far.pairs[1].de00, 0);
  assert.ok(Math.abs(far.meanDe00 - far.maxDe00 / 3) < 1e-12);
  assert.ok(Math.abs(far.weightedDe00 - far.maxDe00 / 2) < 1e-12);

  // Sharma 2005 测试数据第 1 对：Lab(50, 2.6772, -79.7751) 对 Lab(50, 0, -82.7485)，ΔE00 = 2.0425。
  const sharma = colorPaletteDe00([{ lab: [50, 2.6772, -79.7751] }], [{ lab: [50, 0, -82.7485] }]);
  assert.ok(Math.abs(sharma.value - 2.0425) < 1e-4, `Sharma ${sharma.value}`);

  // 候选多出一个参考里没有的主色、或少了一个参考色，两个方向取大的。
  const extra = colorPaletteDe00([...target, { rgb: [20, 200, 60], share: 0.2 }], target);
  assert.ok(extra.value > 5 && extra.reverse.meanDe00 === 0);
  const missing = colorPaletteDe00(target.slice(0, 2), target);
  assert.ok(missing.meanDe00 === 0 && missing.value === missing.reverse.meanDe00 && missing.value > 5);

  // 直接给帧：三色色卡，8 位与线性浮点读同一份色板。
  const srgb = [[200, 40, 40], [40, 90, 200], [240, 240, 235]];
  const card = hue => rgba(W, H, x => x < 32 ? (hue ? [200, 130, 40] : srgb[0]) : x < 52 ? srgb[1] : srgb[2]);
  const fromFrame = repeat5(() => colorPaletteDe00(card(false), target, { k: 3 }));
  assert.ok(fromFrame.value < 1, `色卡对自己的色板 ${fromFrame.value}`);
  assert.ok(colorPaletteDe00(card(true), card(false), { k: 3 }).value > 5);
  const decode = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const linear = { width: W, height: H, rgb: Float32Array.from(card(false).rgba.filter((_, i) => i % 4 !== 3), decode) };
  assert.ok(colorPaletteDe00(linear, card(false), { k: 3 }).value < 0.5);
});

test('shape.iou：重合读 1，错位单调下降，空集按约定处理且不出 NaN', () => {
  const same = repeat5(() => shapeIou(disc(30, 24), disc(30, 24)));
  assert.equal(same.metric, 'metric:shape.iou');
  assert.deepEqual([same.iou, same.precision, same.recall, same.bboxIou, same.emptyBoth], [1, 1, 1, 1, false]);
  assert.equal(same.intersection, same.union);

  const ious = [0, 2, 5, 10, 15, 25].map(dx => repeat5(() => shapeIou(disc(30 + dx, 24), disc(30, 24))).iou);
  ious.forEach((iou, i) => assert.ok(i === 0 || iou < ious[i - 1], `错位越大交并比越低：${ious}`));
  assert.deepEqual([ious[0], ious.at(-1)], [1, 0]);

  // 已知值：4×4 方块对右移 2 列的同样方块。
  const box = x0 => ({ width: 12, height: 8, mask: Uint8Array.from({ length: 96 }, (_, p) => p % 12 >= x0 && p % 12 < x0 + 4 && p >= 24 && p < 72 ? 255 : 0) });
  const half = shapeIou(box(4), box(2));
  assert.deepEqual([half.intersection, half.union, half.iou, half.precision, half.recall, half.bboxIou, half.areaA, half.areaB],
    [8, 24, 1 / 3, 0.5, 0.5, 1 / 3, 16, 16]);
  // 候选是参考的一半：precision 1、recall 0.5。
  const inner = { width: 12, height: 8, mask: box(2).mask.map((v, p) => p % 12 < 4 ? v : 0) };
  assert.deepEqual([shapeIou(inner, box(2)).precision, shapeIou(inner, box(2)).recall, shapeIou(inner, box(2)).iou], [1, 0.5, 0.5]);

  // 空集：两边都空默认 1 并置 emptyBoth，可改 emptyValue；只有一边空必为 0。
  const both = repeat5(() => shapeIou(empty(), empty()));
  assert.deepEqual([both.iou, both.precision, both.recall, both.bboxIou, both.emptyBoth, both.union], [1, 1, 1, 1, true, 0]);
  assert.equal(shapeIou(empty(), empty(), { emptyValue: 0 }).iou, 0);
  for (const one of [shapeIou(empty(), disc(30, 24)), shapeIou(disc(30, 24), empty())]) {
    assert.deepEqual([one.iou, one.precision, one.recall, one.bboxIou, one.emptyBoth], [0, 0, 0, 0, false]);
  }

  // 掩码来源：alpha 通道、编号层、背景色分割，都和二值掩码读数一致。
  const reference = shapeIou(disc(35, 24), disc(30, 24));
  const alpha = cx => rgba(W, H, (x, y) => [9, 9, 9, Math.hypot(x - cx, y - 24) <= 10 ? 255 : 0]);
  const ids = cx => ({ width: W, height: H, ids: Uint16Array.from({ length: W * H }, (_, p) => Math.hypot(p % W - cx, Math.floor(p / W) - 24) <= 10 ? 700 : p % W < 4 ? 3 : 0) });
  const color = cx => rgba(W, H, (x, y) => Math.hypot(x - cx, y - 24) <= 10 ? [220, 30, 30] : [16, 16, 16]);
  assert.deepStrictEqual(shapeIou(alpha(35), alpha(30)), reference);
  assert.deepStrictEqual(shapeIou(ids(35), ids(30), { id: 700 }), reference);
  assert.deepStrictEqual(shapeIou(color(35), color(30), { background: [16, 16, 16], tol: 8 }), reference);
  assert.equal(shapeIou(ids(35), ids(30), { id: 3 }).iou, 1);
  assert.equal(shapeIou(ids(35), ids(30), { id: 999 }).emptyBoth, true);
  // alpha 阈值：半透明边默认按半幅分。
  const soft = a => rgba(4, 4, x => [0, 0, 0, x < 2 ? 255 : a]);
  assert.equal(shapeIou(soft(100), soft(200)).iou, 0.5);
  assert.equal(shapeIou(soft(100), soft(200), { threshold: 50 }).iou, 1);
  // roi：只看右半边时两个圆盘都只剩一部分。
  const cropped = shapeIou(disc(35, 24), disc(30, 24), { roi: { x: 32, y: 0, width: 32, height: H } });
  assert.ok(cropped.union < reference.union && cropped.iou > reference.iou);
});

test('非法入参一律抛带冻结错误码 usage.bad-argument 的 RangeError', () => {
  const ok = luma(W, H, () => 0.5), small = luma(8, 8, () => 0.5), mask = empty();
  const withNaN = luma(W, H, (x, y) => x === 3 && y === 3 ? NaN : 0.5), withInf = luma(W, H, (x) => x ? 0.5 : Infinity);
  const color3 = { width: 2, height: 2, rgb: new Uint8Array(12) };
  const cases = {
    空帧: [() => clipHighlightRatio(null), () => clipHighlightRatio({}), () => clipHighlightRatio({ width: 0, height: 0, luma: new Float32Array(0) }),
      () => noiseResidual([]), () => noiseResidual([ok]), () => aliasEdge([]), () => shapeIou(undefined, mask), () => colorPaletteDe00([], [[1, 2, 3]])],
    尺寸不一致: [() => clipHighlightRatio({ width: W, height: H, luma: new Float32Array(7) }), () => noiseResidual([ok, small]),
      () => aliasEdge([ok, small, ok]), () => shapeIou(mask, { width: 8, height: 8, mask: new Uint8Array(64) }),
      () => noiseResidual([ok, rgba(W, H, () => 9)]), () => clipHighlightRatio({ width: W, height: H, rgba: new Uint8Array(W * H * 3) }),
      () => clipHighlightRatio(ok, { alphaMask: new Uint8Array(5) })],
    非有限数: [() => clipHighlightRatio(withNaN), () => noiseResidual([ok, withNaN]), () => aliasEdge(withInf), () => colorPaletteDe00(withNaN, [[1, 2, 3]]),
      () => clipHighlightRatio(ok, { threshold: NaN }), () => noiseResidual([ok, ok], { motionThreshold: -1 }), () => aliasEdge(ok, { edgeThreshold: Infinity }),
      () => shapeIou(mask, mask, { emptyValue: NaN }), () => shapeIou(mask, mask, { emptyValue: 2 }), () => colorPaletteDe00([[1, 2, NaN]], [[1, 2, 3]]),
      () => colorPaletteDe00([{ lab: [50, 0, Infinity] }], [[1, 2, 3]]), () => colorPaletteDe00([{ rgb: [1, 2, 3], share: -1 }], [[1, 2, 3]])],
    越界ROI: [{ x: -1, y: 0, width: 4, height: 4 }, { x: 0, y: 0, width: W + 1, height: 4 }, { x: 60, y: 0, width: 8, height: 4 },
      { x: 0, y: 0, width: 0, height: 4 }, { x: 0.5, y: 0, width: 4, height: 4 }, null, [0, 0, 4, 4]].flatMap(roi => [
      () => clipHighlightRatio(ok, { roi }), () => noiseResidual([ok, ok], { roi }), () => aliasEdge(ok, { roi }), () => shapeIou(mask, mask, { roi })]),
    选项与类型: [() => clipHighlightRatio(ok, { thresold: 1 }), () => clipHighlightRatio(ok, null), () => clipHighlightRatio({ width: W, height: H, luma: new Array(W * H).fill(0) }),
      () => clipHighlightRatio({ width: W, height: H, luma: ok.luma, mask: mask.mask }), () => clipHighlightRatio(ok, { alphaMask: true }),
      () => clipHighlightRatio(rgba(4, 4, () => 0), { threshold: 256 }), () => noiseResidual([ok, ok], { block: 3 }), () => noiseResidual([ok, ok], { block: 64 }),
      () => colorPaletteDe00([[1, 2, 3]], [[1, 2, 3]], { k: 0 }), () => colorPaletteDe00([[1, 2, 300]], [[1, 2, 3]]), () => colorPaletteDe00([{}], [[1, 2, 3]]),
      () => colorPaletteDe00([{ rgb: [1, 2, 3], share: 0 }], [[1, 2, 3]]), () => shapeIou(mask, mask, { id: 1.5 }), () => shapeIou(color3, color3, { id: 1 }),
      () => shapeIou(mask, mask, { background: [0, 0] }), () => shapeIou(mask, mask, { background: [0, 0, 0] }),
      () => shapeIou({ width: 2, height: 2, rgb: new Uint8Array(12) }, { width: 2, height: 2, rgb: new Uint8Array(12) })],
  };
  for (const [group, list] of Object.entries(cases)) list.forEach((run, i) => assert.throws(run, badArgument, `${group} 第 ${i} 条`));
});
