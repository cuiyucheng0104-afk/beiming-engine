// comp.finish 的自测：两样都关时不变，暗角的中心和四角，颗粒的幅度和可重现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stream, streamName } from '../../../kernel/eval/rng.mjs';
import { create } from './comp.mjs';

const W = 64, H = 36;
const ctx = { rng: (arg) => stream(streamName(7803, 'film', arg)) };
const gray = (v) => new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : v));
function finished(params, f, image = gray(200)) {
  const handle = create(ctx, params);
  handle.apply(f, 0);
  return handle.object.process(image, [W, H]);
}
const px = (image, x, y) => [...image.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

test('comp.finish：颗粒和暗角都是 0 时画面逐字节不变，交回的是新的一份', () => {
  const image = gray(200), out = finished({ grain: 0, vignette: 0 }, 5, image);
  assert.deepEqual(out, image);
  assert.notEqual(out, image);
});

test('comp.finish：暗角 0.2：画面正中不变，四角的像素乘 0.8 上下，透明度不动', () => {
  const out = finished({ grain: 0, vignette: 0.2 }, 0);
  assert.deepEqual(px(out, W / 2, H / 2), [200, 200, 200, 255]);
  // 角上那个像素的中心离角半个像素：d² = (31.5² + 17.5²) ÷ (32² + 18²) = 0.9634，200 × (1 − 0.2 × 0.9634) = 161.5
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) assert.deepEqual(px(out, x, y), [161, 161, 161, 255]);
  // 暗角左右、上下对称
  assert.deepEqual(px(out, 10, 7), px(out, W - 11, H - 8));
});

test('comp.finish：颗粒 0.04 时每个像素偏离不超过 ±0.02 × 255，三个通道偏得一样；确实动了画面', () => {
  const out = finished({ grain: 0.04, vignette: 0 }, 7);
  let moved = 0;
  for (let i = 0; i < out.length; i += 4) {
    assert.ok(Math.abs(out[i] - 200) <= Math.ceil(0.02 * 255) && out[i] === out[i + 1] && out[i] === out[i + 2] && out[i + 3] === 255);
    if (out[i] !== 200) moved++;
  }
  assert.ok(moved > (W * H) / 2);
});

test('comp.finish：同一帧的颗粒算几次、先算哪一帧都一样，不同帧不一样', () => {
  const params = { grain: 0.04, vignette: 0.2 }, handle = create(ctx, params), image = gray(128);
  const at = (f) => { handle.apply(f, 0); return handle.object.process(image, [W, H]); };
  const seven = at(7), eight = at(8);
  assert.deepEqual(at(7), seven);
  assert.deepEqual(finished(params, 7, image), seven);
  assert.notDeepEqual(eight, seven);
});

test('comp.finish：没定帧、画面大小对不上都报错', () => {
  assert.throws(() => create(ctx, { grain: 0.04, vignette: 0 }).object.process(gray(0), [W, H]), /apply/);
  assert.throws(() => finished({ grain: 0, vignette: 0 }, 0, new Uint8ClampedArray(8)), RangeError);
});
