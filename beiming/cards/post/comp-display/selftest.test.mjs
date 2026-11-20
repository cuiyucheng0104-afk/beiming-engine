// comp.display 的自测：几个算得出标准答案的线性光值编成 8 位。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const display = () => create({}, { scene: 'agx-mhc', display: 'srgb' }).object;

test('comp.display：显示参考的线性光过 sRGB 传递函数：0 是 0，0.18 是 118，0.5 是 188，1 是 255；超出 [0, 1] 的压回去', () => {
  const rgba = Float32Array.from([0, 0.18, 0.5, 1, 1, 2, -0.5, 1, 0.0031308, 0.002, 0.2140, 1]);
  assert.deepEqual([...display().encode(rgba, [3, 1], 'display')], [0, 118, 188, 255, 255, 255, 0, 255, 10, 7, 127, 255]);
});

test('comp.display：半透明的像素按预乘值叠在黑底上，交出去的画面不透明', () => {
  // 白色、透明度 0.5，预乘之后是 0.5
  assert.deepEqual([...display().encode(Float32Array.from([0.5, 0.5, 0.5, 0.5]), [1, 1], 'display')], [188, 188, 188, 255]);
});

test('comp.display：场景参考的画面、别的显示空间、大小对不上的画面都报错', () => {
  assert.throws(() => display().encode(new Float32Array(4), [1, 1], 'scene'), /agx-mhc/);
  assert.throws(() => create({}, { scene: 'agx-mhc', display: 'p3' }), /srgb/);
  assert.throws(() => display().encode(new Float32Array(4), [2, 1], 'display'), RangeError);
});
