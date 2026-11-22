import test from 'node:test';
import assert from 'node:assert/strict';
import * as observe from '../index.mjs';
import { clipHighlightRatio, noiseResidual, aliasEdge, colorPaletteDe00, shapeIou,
  ENERGY_METRICS, runEnergyMetric } from './index.mjs';
import { deltaE00 } from '../../../tools/eval/lib/metrics.mjs';

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
function uniform(seed) {
  let s = seed >>> 0;
  return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function gaussian(seed) {
  const next = uniform(seed);
  return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
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

// 以下三条是一审（G_REV-R1）给的反例。
test('noise.residual：平移的条纹块和纹理块不读成噪声，静止的散粒噪声不判成运动', () => {
  // 144×112 黑底上 64×64 的方块，里面是 4 像素宽的 0.2 / 0.8 竖条纹，每帧右移 2 像素，没有噪声。
  const stripes = [0, 1, 2, 3].map(t => luma(144, 112, (x, y) => {
    const u = x - 18 - 2 * t, v = y - 22;
    return u >= 0 && u < 64 && v >= 0 && v < 64 ? (u & 4 ? 0.8 : 0.2) : 0;
  }));
  const moved = repeat5(() => noiseResidual(stripes));
  assert.deepEqual([moved.value, moved.status], [0, 'ok']);
  assert.ok(moved.staticRatio > 0.2 && moved.staticRatio < 1, `staticRatio ${moved.staticRatio}`);

  // 96×72 静止平场 0.25 上叠稀疏散粒噪声 Poisson(0.02) / 8，没有运动：整幅都是静止区，读数接近真实标准差 √0.02 / 8。
  const next = uniform(20261122);
  const poisson = lambda => { let k = 0, p = next(); while (p > Math.exp(-lambda)) { k++; p *= next(); } return k; };
  const shot = [0, 1, 2, 3].map(() => luma(96, 72, () => 0.25 + poisson(0.02) / 8));
  const grain = repeat5(() => noiseResidual(shot));
  assert.equal(grain.status, 'ok');
  assert.ok(grain.staticRatio > 0.9, `staticRatio ${grain.staticRatio}`);
  assert.ok(Math.abs(grain.value / (Math.sqrt(0.02) / 8) - 1) < 0.15, `散粒噪声读数 ${grain.value}`);

  // 白噪声纹理块每帧平移 (3, 1)：帧间差不成片，靠整数位移配准认出来；关掉位移搜索就读成噪声。
  const texture = Float32Array.from({ length: 40 * 40 }, uniform(7));
  const drift = [0, 1, 2, 3].map(t => luma(96, 72, (x, y) => {
    const u = x - 20 - 3 * t, v = y - 12 - t;
    return u >= 0 && u < 40 && v >= 0 && v < 40 ? texture[v * 40 + u] : 0.1;
  }));
  const rigid = repeat5(() => noiseResidual(drift));
  assert.deepEqual([rigid.value, rigid.status, rigid.maxShift], [0, 'ok', 6]);
  assert.ok(noiseResidual(drift, { maxShift: 0 }).value > 0.01);
});

test('alias.edge：1 像素交替条纹的逐帧反相读成强闪烁', () => {
  // L(x, p) = 0.5 + 0.5 · (−1)^x · cos(πp)，p 在 0.25 与 0.75 之间来回：周期 2 像素，Sobel 的隔一像素差分正好是 0。
  const nyquist = p => luma(W, H, x => 0.5 + 0.5 * (x % 2 ? -1 : 1) * Math.cos(Math.PI * p));
  const strobe = repeat5(() => aliasEdge([0.25, 0.75, 0.25, 0.75, 0.25].map(nyquist)));
  assert.ok(strobe.detailPixels > 1000, `detailPixels ${strobe.detailPixels}`);
  assert.ok(Math.abs(strobe.flicker - Math.SQRT1_2) < 1e-6, `flicker ${strobe.flicker}`);
  assert.equal(aliasEdge([0.25, 0.25, 0.25].map(nyquist)).flicker, 0);
  // 横条纹、棋盘同理。
  const checker = flip => luma(W, H, (x, y) => (x + y + flip) % 2 ? 0.8 : 0.2);
  assert.ok(Math.abs(aliasEdge([0, 1, 0, 1].map(checker)).flicker - 0.6) < 1e-6);
});

test('clip.highlight-ratio 与 color.palette-de00：外部掩码、稀疏数组与极大 share', () => {
  // 外部掩码收定型数组或普通数组，元素是布尔或非负有限数。
  const frame = rgba(4, 2, x => x < 2 ? 255 : 40), keep = [1, 0, 1, 0, 1, 0, 1, 0];
  const byBytes = clipHighlightRatio(frame, { alphaMask: Uint8Array.from(keep) });
  assert.deepEqual([byBytes.ratio, byBytes.totalPixels], [0.5, 4]);
  assert.deepStrictEqual(clipHighlightRatio(frame, { alphaMask: keep }), byBytes);
  assert.deepStrictEqual(clipHighlightRatio(frame, { alphaMask: keep.map(Boolean) }), byBytes);
  const holed = [...keep]; delete holed[3];
  for (const alphaMask of [Float32Array.from(keep, (v, i) => i === 5 ? NaN : v), Float64Array.from(keep, (v, i) => i ? v : Infinity),
    Float32Array.from(keep, (v, i) => i ? v : -Infinity), Float32Array.from(keep, (v, i) => i ? v : -1), holed, new Array(8),
    keep.map((v, i) => i === 2 ? NaN : v), keep.map(String), keep.map((v, i) => i ? v : null), new Uint16Array(8)]) {
    assert.throws(() => clipHighlightRatio(frame, { alphaMask }), badArgument);
  }

  // 稀疏数组的空洞不能混过校验。
  const red = [[200, 40, 40]];
  for (const [a, b] of [[[{ lab: [50, , 0] }], red], [[[1, , 3]], red], [[{ rgb: [, 2, 3] }], red], [[, [1, 2, 3]], red], [red, [{ lab: [50, 0, '0'] }]]]) {
    assert.throws(() => colorPaletteDe00(a, b), badArgument);
  }
  assert.throws(() => noiseResidual([frame, , frame]), badArgument);
  assert.throws(() => shapeIou(frame, frame, { background: [0, , 0] }), badArgument);
  // share 只看比例：1e307、1e308 和 1 读数相同，不溢出。
  const pair = share => [{ rgb: [20, 200, 60], share }, { rgb: [40, 90, 200], share }];
  const unit = colorPaletteDe00(pair(1), red);
  assert.ok(unit.maxDe00 > 18 && Number.isFinite(unit.weightedDe00) && unit.weightedDe00 > 18);
  for (const share of [1e307, 1e308]) assert.deepStrictEqual(colorPaletteDe00(pair(share), red), unit);
  assert.deepStrictEqual(colorPaletteDe00(red, pair(1e308)), colorPaletteDe00(red, pair(1)));
});

// 以下四条是二审（G_REV-R2）给的反例。
test('noise.residual：平移的稀疏点阵不读成噪声，静止的稀疏散粒噪声仍整幅算静止', () => {
  // 底色 0.2 的点阵：每个 8×8 单元左上角一块 2×2、亮度 0.8 的亮斑。一块里只有 8 / 64 个像素在变，帧间差不成片。
  const dots = (u, v) => (u & 7) < 2 && (v & 7) < 2 ? 0.8 : 0.2;
  const lattice = (sx, sy, ox = 18, oy = 22) => [0, 1, 2, 3, 4].map(t => luma(144, 112, (x, y) => {
    const u = x - ox - sx * t, v = y - oy - sy * t;
    return u >= 0 && u < 64 && v >= 0 && v < 64 ? dots(u, v) : 0;
  }));
  assert.deepEqual([noiseResidual(lattice(0, 0)).value, noiseResidual(lattice(0, 0)).staticRatio], [0, 1]);
  // 二审原例每帧右移 2 像素；换位移、换点阵对块网格的相位（亮斑跨在块边上）读数都得是 0。
  for (const [sx, sy, ox, oy] of [[2, 0], [1, 0], [3, 1], [-2, 2], [0, 5], [2, 0, 23, 23], [1, 0, 23, 19], [1, 1, 15, 31]]) {
    const moved = repeat5(() => noiseResidual(lattice(sx, sy, ox, oy)));
    assert.deepEqual([moved.value, moved.status], [0, 'ok'], `点阵位移 (${sx}, ${sy})、原点 (${ox ?? 18}, ${oy ?? 22})`);
    assert.ok(moved.staticRatio > 0.2 && moved.staticRatio < 1, `staticRatio ${moved.staticRatio}`);
  }
  // 整幅点阵一起平移：贴着画面边的块也认得出来，没有静止区。
  const pan = noiseResidual([0, 1, 2, 3].map(t => luma(96, 72, (x, y) => dots(x - 2 * t, y - t))));
  assert.deepEqual([pan.value, pan.status, pan.staticRatio], [null, 'no-static-region', 0]);
  // 关掉位移搜索就读成噪声。
  assert.ok(noiseResidual(lattice(2, 0), { maxShift: 0 }).value > 0.03);

  // 静止平场上的泊松散粒噪声：稀疏脉冲偶尔能凑上位移，但不能因此把静止区判成运动；读数随 λ 严格上升并贴着真实标准差。
  const lambdas = [0.001, 0.0025, 0.005, 0.02, 0.08, 0.32];
  const readings = lambdas.map((lambda, n) => {
    const next = uniform(20261122 + n);
    const poisson = () => { let k = 0, p = next(); while (p > Math.exp(-lambda)) { k++; p *= next(); } return k; };
    const shot = [0, 1, 2, 3, 4].map(() => luma(192, 144, () => 0.25 + poisson() / 8));
    const grain = repeat5(() => noiseResidual(shot));
    assert.ok(grain.staticRatio >= 0.99, `λ=${lambda} staticRatio ${grain.staticRatio}`);
    assert.ok(Math.abs(grain.value / (Math.sqrt(lambda) / 8) - 1) < 0.12, `λ=${lambda} 读数 ${grain.value}`);
    return grain.value;
  });
  readings.forEach((value, i) => assert.ok(i === 0 || value > readings[i - 1], `读数应随 λ 上升：${readings}`));
});

test('color.palette-de00：任何有限 Lab 都读出有限非负数，常规范围与参考实现一致', () => {
  const big = [{ lab: [50, 1e50, 0] }];
  const self = repeat5(() => colorPaletteDe00(big, big));
  assert.deepEqual([self.value, self.weightedDe00, self.maxDe00, self.pairs[0].de00, self.reverse.meanDe00], [0, 0, 0, 0, 0]);
  // share 为 0 的极端色不把加权色差带成 NaN。
  const mixed = colorPaletteDe00([{ lab: [50, 1e50, 0], share: 0 }, { rgb: [0, 0, 0], share: 1e307 }], [[0, 0, 0]]);
  assert.equal(mixed.weightedDe00, 0);
  assert.ok(Number.isFinite(mixed.value) && mixed.value > 0);
  // 双精度能到的任何角落：结果有限、非负，同色为 0，对称。
  const M = Number.MAX_VALUE, extremes = [[50, 1e50, 0], [50, -1e50, 0], [50, 1e200, 0], [50, 1e300, 0], [50, 0, 1e160], [1e300, 0, 0], [-1e300, 5, 5],
    [M, M, M], [-M, -M, -M], [M, -M, M], [0, M, -M], [50, 5e-324, -5e-324], [50, -0, 0], [1e-200, 1e-200, 1e-200], [50, 20, -30]];
  for (const p of extremes) for (const q of extremes) {
    const r = colorPaletteDe00([{ lab: p }], [{ lab: q }]);
    for (const v of [r.value, r.meanDe00, r.maxDe00, r.weightedDe00, r.pairs[0].de00, r.reverse.meanDe00, r.reverse.weightedDe00]) {
      assert.ok(Number.isFinite(v) && v >= 0, `Lab(${p}) 对 Lab(${q}) 读出 ${v}`);
    }
    assert.equal(r.meanDe00, r.reverse.meanDe00, `Lab(${p}) 对 Lab(${q}) 应对称`);
    if (p === q) assert.equal(r.value, 0);
  }
  // 色度差的折算值有界：彩度相差 100 个数量级的两个色不是同色，也不是无穷远。
  const apart = colorPaletteDe00([{ lab: [50, 1e200, 0] }], [{ lab: [50, 1e300, 0] }]).value;
  assert.ok(Math.abs(apart - 2 / 0.045) < 1e-6, `Lab(50, 1e200, 0) 对 Lab(50, 1e300, 0) 读出 ${apart}`);
  const all = extremes.map(lab => ({ lab }));
  const whole = colorPaletteDe00(all, all.slice(0, 8));
  for (const v of [whole.value, whole.meanDe00, whole.weightedDe00, whole.reverse.weightedDe00]) assert.ok(Number.isFinite(v) && v >= 0, `整板读出 ${v}`);

  // 常规范围：与 tools/eval/lib/metrics.mjs 的 deltaE00 对到 1e-9（含无彩色、色相跨 0° 与 180° 对角）。
  const next = uniform(2000), grid = [[50, 0, 0], [60, 0, 0], [50, -0, 0], [50, 30, 0], [50, -30, 0], [50, 0, 30], [50, 0, -30], [50, 30, -1e-9], [50, 30, 1e-9],
    [50, 2.5, 0], [50, -2.5, 0], [0, 0, 0], [100, 0, 0], ...Array.from({ length: 40 }, () => [100 * next(), 256 * next() - 128, 256 * next() - 128])];
  let worst = 0;
  for (const p of grid) for (const q of grid) {
    const got = colorPaletteDe00([{ lab: p }], [{ lab: q }]).pairs[0].de00;
    worst = Math.max(worst, Math.abs(got - deltaE00(p, q)));
  }
  assert.ok(worst < 1e-9, `与参考实现最大相差 ${worst}`);
});

test('帧序列与色板的外层数组：只挂在原型上的索引不算数', () => {
  const frame = luma(W, H, x => 0.2 + x / 256);
  // 长度够、自己却没有那个索引的数组：值是从私有原型上继承来的。
  const inherited = (length, proto, own = {}) => { const list = Object.assign(new Array(length), own); Object.setPrototypeOf(list, Object.assign(Object.create(Array.prototype), proto)); return list; };
  assert.equal(inherited(2, { 0: frame }, { 1: frame })[0], frame);
  assert.ok(Array.isArray(inherited(2, { 0: frame })));
  const black = { rgb: [0, 0, 0] };
  for (const run of [
    () => noiseResidual(inherited(2, { 0: frame }, { 1: frame })), () => noiseResidual(inherited(2, { 0: frame, 1: frame })),
    () => noiseResidual(inherited(3, { 1: frame }, { 0: frame, 2: frame })),
    () => aliasEdge(inherited(1, { 0: frame })), () => aliasEdge(inherited(3, { 2: frame }, { 0: frame, 1: frame })),
    () => colorPaletteDe00(inherited(2, { 0: black }, { 1: black }), [black]), () => colorPaletteDe00([black], inherited(1, { 0: black })),
    () => colorPaletteDe00(inherited(2, { 1: [1, 2, 3] }, { 0: [1, 2, 3] }), [black]),
    () => colorPaletteDe00([black], new Array(3)), () => noiseResidual(new Array(2)), () => aliasEdge(new Array(4294967295)),
    () => clipHighlightRatio(rgba(2, 1, () => 255), { alphaMask: inherited(2, { 0: 1 }, { 1: 1 }) }),
    () => shapeIou(rgba(2, 2, () => 0), rgba(2, 2, () => 0), { background: inherited(3, { 1: 0 }, { 0: 0, 2: 0 }) }),
  ]) assert.throws(run, badArgument);
  // 自有索引齐全的照常量，换了原型也一样。
  assert.equal(noiseResidual(inherited(2, {}, { 0: frame, 1: frame })).value, 0);
  assert.equal(colorPaletteDe00(inherited(1, {}, { 0: black }), [black]).value, 0);
});

test('noise.residual：maxShift 须为安全整数，搜索半径不超过量测区', () => {
  const frames = [0, 1, 2].map(t => luma(72, 56, (x, y) => x >= 8 + 2 * t && x < 24 + 2 * t && y >= 8 && y < 24 ? ((x - 2 * t) * 7 + y * 13) % 5 / 5 : 0.1));
  for (const maxShift of [1e20, Number.MAX_SAFE_INTEGER + 1, 2 ** 53, Infinity, NaN, '6', null, 6n, -0.5]) {
    assert.throws(() => noiseResidual(frames, { maxShift }), badArgument, `maxShift ${String(maxShift)}`);
  }
  // 再大的安全整数也只搜到量测区容得下的位移：结果与刚好够大的半径相同，不空转。
  const wide = repeat5(() => noiseResidual(frames, { maxShift: 80 }));
  assert.deepEqual([wide.value, wide.status], [0, 'ok']);
  const started = performance.now();
  for (const maxShift of [1e6, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    assert.deepStrictEqual(noiseResidual(frames, { maxShift }), { ...wide, maxShift });
  }
  assert.ok(performance.now() - started < 5000, '超大 maxShift 不应拖慢');
  assert.equal(noiseResidual(frames, { maxShift: 0 }).maxShift, 0);
});

test('极大极小的有限输入：色差、残差、闪烁不溢出也不下溢，读数随 2 的幂严格成比例', () => {
  const near = (got, want, label) => assert.ok(Math.abs(got / want - 1) < 1e-12, `${label} 读出 ${got}，应为 ${want}`);
  // 明度、色相相同，彩度贴着双精度上限的两个色：只剩彩度项，极限是 ΔC / (0.045 · 平均彩度)。
  const p = { lab: [50, 1.3e308, 1.3e308] }, q = { lab: [50, 1.7e308, 1.7e308] };
  near(repeat5(() => colorPaletteDe00([p], [q])).value, 0.4 / (0.045 * 1.5), 'p 对 q');
  near(colorPaletteDe00([q], [p]).value, 0.4 / (0.045 * 1.5), 'q 对 p');
  const pick = colorPaletteDe00([p], [q, p]).pairs[0];
  assert.deepEqual([pick.index, pick.de00], [1, 0]);
  // 极小一端：彩度修正 G 是 0.5，彩度差 2e-200 读 3e-200；不同的色不读 0。
  near(colorPaletteDe00([{ lab: [50, 1e-200, 0] }], [{ lab: [50, 3e-200, 0] }]).value, 3e-200, '极小彩度差');
  assert.ok(colorPaletteDe00([{ lab: [5e-324, 0, 0] }], [{ lab: [0, 0, 0] }]).value > 0);

  // 16×16 全黑上一个幅度 A 的单像素脉冲：拉普拉斯是一个 4A 加四个 −A，摊到 14×14 个内部像素，读数 A / √392。
  const impulse = A => [0, A].map(v => luma(16, 16, (x, y) => x === 8 && y === 8 ? v : 0, Float64Array));
  for (const A of [1, 1e155, 1e300, 1.7e308, 1e-160, 1e-300]) {
    const got = repeat5(() => noiseResidual(impulse(A)));
    assert.deepEqual([got.status, got.staticRatio], ['ok', 1]);
    near(got.value, A / Math.sqrt(392), `脉冲 ${A}`);
  }

  // 整个序列乘 2 的幂、阈值跟着乘：判定不变，带量纲的读数严格成比例。
  const times = (frames, n) => frames.map(f => ({ ...f, luma: f.luma.map(v => v * 2 ** n) }));
  const next = gaussian(11), moving = [0, 1, 2].map(t => luma(W, H, (x, y) =>
    (x >= 8 + 6 * t && x < 24 + 6 * t && y >= 16 && y < 32 ? 0.9 : 0.2 + x / 256) + 0.01 * next(), Float64Array));
  const rods = [0, 0.5, 0].map(phase => { const f = rod(1, phase); return { ...f, luma: Float64Array.from(f.luma) }; });
  const noise = noiseResidual(moving, { motionThreshold: 2 / 255 }), alias = aliasEdge(rods, { edgeThreshold: 32 / 255 });
  assert.ok(noise.value > 0 && noise.staticRatio < 1 && alias.jaggedness > 0 && alias.flicker > 0);
  for (const n of [-960, -400, 400, 1000]) {
    const s = 2 ** n;
    assert.deepStrictEqual(noiseResidual(times(moving, n), { motionThreshold: 2 / 255 * s }),
      { ...noise, value: noise.value * s, motionThreshold: 2 / 255 * s }, `noise.residual 乘 2^${n}`);
    assert.deepStrictEqual(aliasEdge(times(rods, n), { edgeThreshold: 32 / 255 * s }),
      { ...alias, flicker: alias.flicker * s, edgeThreshold: 32 / 255 * s }, `alias.edge 乘 2^${n}`);
  }

  // 幅度贴着上限、正负都有的白噪声：读数仍是它的标准差（均匀分布，幅度 / √3），和缩小 2^1000 倍再量的逐位成比例。
  const draw = uniform(5), wild = [0, 1, 2, 3].map(() => luma(W, H, () => 1.7e308 * (2 * draw() - 1), Float64Array));
  const loud = repeat5(() => noiseResidual(wild)), sharp = repeat5(() => aliasEdge(wild));
  assert.ok(Math.abs(loud.value / (1.7e308 / Math.sqrt(3)) - 1) < 0.15 && loud.staticRatio > 0.9, `读出 ${loud.value}，静止占比 ${loud.staticRatio}`);
  assert.equal(loud.value, noiseResidual(times(wild, -1000)).value * 2 ** 1000);
  assert.ok(Number.isFinite(sharp.value) && sharp.flicker > 1e306 && sharp.flicker < Infinity, `锯齿度 ${sharp.value}，闪烁 ${sharp.flicker}`);
  assert.equal(sharp.flicker, aliasEdge(times(wild, -1000)).flicker * 2 ** 1000);
  // 每个像素逐帧在上下限之间翻转：真值超出双精度，封顶在 Number.MAX_VALUE。
  const flip = [0, 1, 2].map(t => luma(W, H, (x, y) => (x + y + t) % 2 ? 1.7e308 : -1.7e308, Float64Array));
  assert.equal(aliasEdge(flip).flicker, Number.MAX_VALUE);

  // 一个 1e308 的静止坏点不拖累旁边正常噪声的读数。
  const spot = hot => { const g = gaussian(3); return [0, 1, 2].map(() => luma(W, H, (x, y) => x === 40 && y === 20 ? hot : 0.5 + 0.01 * g(), Float64Array)); };
  const hot = noiseResidual(spot(1e308)).value, plain = noiseResidual(spot(0.5)).value;
  assert.ok(Math.abs(hot / plain - 1) < 0.05, `带坏点 ${hot}，不带 ${plain}`);
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
      () => noiseResidual([ok, ok], { maxShift: -1 }), () => noiseResidual([ok, ok], { maxShift: 1.5 }),
      () => colorPaletteDe00([[1, 2, 3]], [[1, 2, 3]], { k: 0 }), () => colorPaletteDe00([[1, 2, 300]], [[1, 2, 3]]), () => colorPaletteDe00([{}], [[1, 2, 3]]),
      () => colorPaletteDe00([{ rgb: [1, 2, 3], share: 0 }], [[1, 2, 3]]), () => shapeIou(mask, mask, { id: 1.5 }), () => shapeIou(color3, color3, { id: 1 }),
      () => shapeIou(mask, mask, { background: [0, 0] }), () => shapeIou(mask, mask, { background: [0, 0, 0] }),
      () => shapeIou({ width: 2, height: 2, rgb: new Uint8Array(12) }, { width: 2, height: 2, rgb: new Uint8Array(12) })],
  };
  for (const [group, list] of Object.entries(cases)) list.forEach((run, i) => assert.throws(run, badArgument, `${group} 第 ${i} 条`));
});

test('color.palette-de00：只差一个浮点步长的色照样分得开，平均色差不下溢成 0', () => {
  const near = (got, want, label) => assert.ok(Math.abs(got / want - 1) < 1e-12, `${label} 读出 ${got}，应为 ${want}`);
  // 正数的下 n 个可表示的双精度数。
  const up = (x, n = 1) => { const f = new Float64Array([x]); new BigUint64Array(f.buffer)[0] += BigInt(n); return f[0]; };
  const one = (p, q) => colorPaletteDe00([{ lab: p }], [{ lab: q }]).value;

  // 四审反例：对角彩度贴着上限、每对只差一个步长。明度色相相同，只剩彩度项 |y − x| / (0.045 · (x + y) / 2)。
  const xs = [1.3000000000000003e308, 1.7000000000000001e308], ys = [1.3000000000000005e308, 1.7000000000000003e308];
  assert.deepEqual(ys, xs.map(x => up(x)));
  const diagonal = list => list.map(x => ({ lab: [50, x, x] }));
  const r = repeat5(() => colorPaletteDe00(diagonal(xs), diagonal(ys)));
  const want = [3.4116928368114857e-15, 2.6089415810911365e-15];
  xs.forEach((x, i) => {
    near(want[i], (ys[i] - x) / (0.045 * (x / 2 + ys[i] / 2)), `第 ${i} 对的期望值`);
    near(r.pairs[i].de00, want[i], `第 ${i} 对`);
    near(r.reverse.pairs[i].de00, want[i], `反向第 ${i} 对`);
    assert.equal(r.pairs[i].index, i);
  });
  for (const v of [r.meanDe00, r.reverse.meanDe00, r.value, r.weightedDe00]) near(v, 3.0103172089513113e-15, '平均色差');

  // 彩度极小时修正系数是 1.5、各权重是 1、没有旋转项，色差就是 hypot(1.5·Δa, Δb)：只挪 b 一个步长，彩度差和色相差都比彩度自己的步长小。
  const t = 1e-200;
  near(one([50, t, t], [50, t, up(t)]), up(t) - t, '极小彩度挪 b 一步');
  near(one([50, t, t], [50, up(t), t]), 1.5 * (up(t) - t), '极小彩度挪 a 一步');
  near(one([50, t, t], [50, up(t, 3), up(t, 4)]), Math.hypot(4.5, 4) * (up(t) - t), '极小彩度斜着挪');

  // 常规范围和贴着上限：挪 8 步的色差是挪 1 步的 8 倍，两个方向读数逐位相同。
  for (const [L, a, b] of [[50, 20, 30], [50, 1, 1], [62, 41.5, 3.25], [50, 1.3e308, 0.9e308], [50, 3e-320, 2e-320]]) {
    const step = one([L, a, b], [L, a, up(b)]);
    assert.ok(step > 0 && (step > 5e-324 || a < 1e-300), `Lab(${L}, ${a}, ${b}) 挪 b 一步读出 ${step}`);
    assert.equal(step, one([L, a, up(b)], [L, a, b]), `Lab(${L}, ${a}, ${b}) 应对称`);
    if (step > 1e-300) for (const [da, db] of [[0, 8], [8, 0], [8, 8]]) {
      const unit = one([L, a, b], [L, up(a, da / 8), up(b, db / 8)]);
      assert.ok(Math.abs(one([L, a, b], [L, up(a, da), up(b, db)]) / unit - 8) < 1e-9, `Lab(${L}, ${a}, ${b}) 挪 (${da}, ${db}) 步应是 8 倍`);
    }
  }

  // 每对色差都是最小正数：平均数不能先除以色数再加（各自下溢成 0），share 再小也不把不同的色板读成 0。
  const floor = colorPaletteDe00([{ lab: [50, 0, 0] }, { lab: [60, 0, 0], share: 1e-300 }], [{ lab: [50, 0, 5e-324] }, { lab: [60, 0, 5e-324] }]);
  assert.deepEqual([floor.pairs[0].de00, floor.pairs[1].de00, floor.meanDe00, floor.reverse.meanDe00, floor.value], [5e-324, 5e-324, 5e-324, 5e-324, 5e-324]);
  assert.equal(floor.weightedDe00, 5e-324);
  const tiny = colorPaletteDe00([{ lab: [50, 0, 0], share: 0 }, { lab: [60, 0, 0], share: 1e-300 }], [{ lab: [50, 0, 0] }, { lab: [60, 0, 5e-324] }]);
  assert.deepEqual([tiny.meanDe00, tiny.weightedDe00], [5e-324, 5e-324]);
  // share 为 0 的色不算进加权色差，全同的色板还是 0。
  const off = colorPaletteDe00([{ lab: [50, 0, 0], share: 1 }, { lab: [60, 0, 0], share: 0 }], [{ lab: [50, 0, 0] }, { lab: [60, 0, 5e-324] }]);
  assert.deepEqual([off.weightedDe00, off.meanDe00], [0, 5e-324]);
  // 亚正规数的色差平均后还是它自己，不多不少。
  const same = colorPaletteDe00([{ lab: [50, 0, 0] }, { lab: [60, 0, 0] }, { lab: [70, 0, 0] }], [{ lab: [50, 0, 1.5e-322] }, { lab: [60, 0, 1.5e-322] }, { lab: [70, 0, 1.5e-322] }]);
  assert.deepEqual([same.meanDe00, same.weightedDe00], [same.pairs[0].de00, same.pairs[0].de00]);
});

test('color.palette-de00：share 为 0 的色不参与加权，添上它 weightedDe00 逐位不变', () => {
  const near = (got, want, label) => assert.ok(Math.abs(got / want - 1) < 1e-12, `${label} 读出 ${got}，应为 ${want}`);
  // 五审反例：零权重色离参考极远（色差贴着双精度上限），唯一有权重的色只差 1.5e-16，加权读数只该是后者。
  const ref = [{ lab: [1e308, 0, 0] }], keep = { lab: [1e308, 1e-16, 0], share: 1 }, unused = { lab: [-1e308, 0, 0], share: 0 };
  const alone = colorPaletteDe00([keep], ref);
  near(alone.weightedDe00, 1.5e-16, '单色加权');
  for (const padded of [[keep, unused], [unused, keep], [unused, keep, unused, unused]]) {
    const r = repeat5(() => colorPaletteDe00(padded, ref));
    assert.ok(r.maxDe00 > 1e308 && r.meanDe00 > 1e307, '不加权的读数照旧把零权重色算进去');
    assert.equal(r.weightedDe00, alone.weightedDe00);
    assert.equal(r.reverse.weightedDe00, alone.reverse.weightedDe00);
    // 色板放在参考一侧，反向的加权读数同样不变。
    assert.equal(colorPaletteDe00(ref, padded).reverse.weightedDe00, alone.weightedDe00);
  }
  // 常规色板同理，零权重色放在哪都不改加权读数。
  const base = [{ rgb: [200, 40, 40], share: 0.5 }, { rgb: [40, 90, 200], share: 0.3 }, { rgb: [240, 240, 235], share: 0.2 }];
  const goal = [[190, 60, 50], [50, 80, 190], [230, 235, 240]], extra = { rgb: [20, 200, 60], share: 0 };
  const plain = colorPaletteDe00(base, goal).weightedDe00;
  assert.ok(plain > 1);
  for (const padded of [[extra, ...base], [...base, extra], [base[0], extra, base[1], extra, base[2]]]) assert.equal(colorPaletteDe00(padded, goal).weightedDe00, plain);

  // 权重从 0 挪到最小正数，读数只多出「权重 × 它的色差」，不跳变：极小权重乘极大色差与另一个色的小色差同量级，两项都要留住。
  const far = colorPaletteDe00([{ ...unused, share: 1 }], ref).maxDe00;
  near(colorPaletteDe00([keep, { ...unused, share: 5e-324 }], ref).weightedDe00, alone.weightedDe00 + far * 5e-324, '最小正数权重');
});
