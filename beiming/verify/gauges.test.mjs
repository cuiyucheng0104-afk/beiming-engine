// 第 4 级形状量具的单测：每个量具在合成图上量出算得出的数，并各有一个负对照（故意做错的图必须量出不过的数）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bevelBand, dilate, entityMask, highlightBand, highlightMask, lineMask, luma, maskCount, maskIoU, meanImage, normalAngleRms, normalMismatch, penumbraWidth, regionQuantile, relDiff } from './gauges.mjs';
import { THRESHOLDS } from './floorgate.mjs';

const G = THRESHOLDS.level4;
const W = 40, H = 30;
/** 灰度图：f(x, y) → 亮度，三个通道相同 */
const gray = (f) => { const a = new Float32Array(3 * W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.fill(f(x, y), 3 * (y * W + x), 3 * (y * W + x) + 3); return a; };
/** 法线图：f(x, y) → [x, y, z] */
const field = (f) => { const a = new Float32Array(3 * W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.set(f(x, y), 3 * (y * W + x)); return a; };
const all = new Uint8Array(W * H).fill(1);

test('亮度与均值图、编号掩膜、分位数', () => {
  assert.ok(Math.abs(luma(new Float32Array([1, 1, 1]), 0) - 1) < 1e-12);
  assert.deepEqual([...meanImage([new Float32Array([1, 2]), new Float32Array([3, 4])])], [2, 3]);
  assert.deepEqual([...entityMask(new Uint32Array([1, 2, 2, 3]), new Float32Array([1, 1, 0.5, 1]), [2, 3])], [0, 1, 0, 1]);
  assert.equal(regionQuantile(gray((x) => x), all, 0.95), 38);
  assert.equal(regionQuantile(gray(() => 1), new Uint8Array(W * H), 0.5), 0, '空区域给 0');
});

test('高光 IoU：同一个高光过门，挪开 3 个像素的高光（负对照）不过', () => {
  const spot = (cx) => gray((x, y) => Math.exp(-((x - cx) ** 2 + (y - 15) ** 2) / 8));
  const a = highlightMask(spot(20)), b = highlightMask(spot(20)), c = highlightMask(spot(23));
  assert.ok(maskCount(a) > 10);
  assert.equal(maskIoU(a, b), 1);
  assert.ok(maskIoU(a, c) < G.highlightIoU, `挪开之后 IoU ${maskIoU(a, c)}`);
  assert.equal(maskIoU(new Uint8Array(4), new Uint8Array(4)), null, '两个都空量不出');
  // 峰值只在 region 里取：region 外更亮的点不影响
  const region = new Uint8Array(W * H).fill(1); region[0] = 0;
  const lit = spot(20); lit.fill(100, 0, 3);
  assert.equal(maskIoU(highlightMask(lit, { region }), a), 1);
});

test('半影宽：同一条软边过门，宽一倍的软边（负对照）超出 ±10%', () => {
  const edge = (s) => gray((x) => 1 / (1 + Math.exp(-(x - 20) / s)));
  const a = penumbraWidth(edge(1.5), all), b = penumbraWidth(edge(1.5), all), c = penumbraWidth(edge(3), all);
  assert.ok(a > 0);
  assert.equal(relDiff(b, a), 0);
  assert.ok(relDiff(c, a) > G.penumbraRel, `宽一倍时相对差 ${relDiff(c, a)}`);
});

test('圆角法线剖面：同一个圆角过门，没有圆角的硬棱（负对照）RMS 超 3°，高光带宽对得上', () => {
  // 两块平面（法线 +Z 与 +X）在 x = 20 处相接；圆角宽 r 个像素，法线在圆角里绕 Y 轴从 +Z 转到 +X
  const rounded = (r) => field((x) => { const t = Math.max(0, Math.min(1, (x - 20 + r / 2) / r)); const a = t * Math.PI / 2; return [Math.sin(a), 0, Math.cos(a)]; });
  const ref = rounded(6), hard = rounded(0.01);
  const { band, planes } = bevelBand(ref, W, H, all);
  assert.equal(planes, 2);
  assert.ok(maskCount(band) >= 4 * H, `带状区 ${maskCount(band)} 个像素`);
  assert.ok(normalAngleRms(ref, ref, band) < 1e-5, '自己对自己只差 acos 的舍入');
  assert.ok(normalAngleRms(hard, ref, band) > G.normalAngleRmsDeg, `硬棱 RMS ${normalAngleRms(hard, ref, band)}°`);
  // 高光照在圆角上：同一张图带宽相同，高光整个挪到平面上（负对照）带宽差出 ±15%
  const hi = highlightMask(gray((x) => (x >= 19 && x <= 21 ? 1 : 0.1)));
  const off = highlightMask(gray((x) => (x >= 4 && x <= 6 ? 1 : 0.1)));
  const n = highlightBand(hi, band, W, H);
  assert.ok(n > 0);
  assert.equal(relDiff(highlightBand(hi, band, W, H), n), 0);
  assert.ok(relDiff(highlightBand(off, band, W, H), n) > G.highlightBandRel);
  assert.equal(normalAngleRms(ref, ref, new Uint8Array(W * H)), null, '带状区空时量不出');
});

test('两张法线图不一致的像素：只数掩膜里两边都有法线的', () => {
  const a = field(() => [0, 0, 1]), b = field((x) => (x === 3 ? [0, 0.1, 1] : x === 4 ? [0, 0, 0] : [0, 0, 1]));
  assert.deepEqual(normalMismatch(a, b, all, 0.05), { count: H, total: W * H - H });
  assert.deepEqual(normalMismatch(a, a, all, 0.05), { count: 0, total: W * H });
});

test('外扩一个像素', () => {
  const m = new Uint8Array(W * H); m[15 * W + 20] = 1;
  assert.equal(maskCount(dilate(m, W, H, 1)), 9);
});

test('勾线掩膜 IoU：同一条线过门，宽一倍的线（负对照）不过', () => {
  const lined = (half) => gray((x, y) => (Math.abs(y - 15) <= half ? 0.02 : 0.8));
  const a = lineMask(lined(1), all), b = lineMask(lined(1), all), c = lineMask(lined(2), all);
  assert.equal(maskCount(a), 3 * W);
  assert.equal(maskIoU(a, b), 1);
  assert.ok(maskIoU(a, c) < G.aoLineIoU, `宽一倍时 IoU ${maskIoU(a, c)}`);
});

test('阈值文件的第 4 级一段：能量比、高光 IoU、半影宽、圆角剖面、高光带宽、勾线 IoU 的线', () => {
  assert.deepEqual(G, { energy: [0.97, 1.03], highlightIoU: 0.95, highlightFraction: 0.5, penumbraRel: 0.1, normalAngleRmsDeg: 3, highlightBandRel: 0.15, aoLineIoU: 0.9 });
});
