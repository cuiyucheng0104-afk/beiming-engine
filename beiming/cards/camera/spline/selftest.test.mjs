// camera.spline 的自测：位置过关键帧、朝向对着看向点、视场角线性过渡、定不出朝向时报错。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evaluate } from './evaluate.mjs';

const near = (a, b, eps = 1e-12) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
/** 用四元数 [x, y, z, w] 转一个向量 */
function rotate([x, y, z, w], v) {
  const u = [x, y, z], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const t = cross(u, v).map((c) => 2 * c), k = cross(u, t);
  return v.map((c, i) => c + w * t[i] + k[i]);
}
const cam = (keys, f, sub = 0, inputs = {}) => evaluate(inputs, { keys, fovDeg: 40 }, f, sub).camera;

test('camera.spline：两个关键帧之间位置是直线，首尾之外保持不动', () => {
  const keys = [{ f: 10, pos: [0, 1, 4], look: [0, 1, 0] }, { f: 20, pos: [2, 1, 4], look: [0, 1, 0] }];
  assert.ok(near(cam(keys, 15).pos, [1, 1, 4]));
  assert.ok(near(cam(keys, 12, 0.5).pos, [0.5, 1, 4]));
  assert.deepEqual(cam(keys, 0).pos, [0, 1, 4]);
  assert.deepEqual(cam(keys, 30).pos, [2, 1, 4]);
});

test('camera.spline：三个关键帧时每个关键帧上位置正好是写的那个点，中间是光滑的曲线不是折线', () => {
  const keys = [{ f: 0, pos: [0, 0, 4], look: [0, 0, 0] }, { f: 10, pos: [2, 0, 4], look: [0, 0, 0] }, { f: 20, pos: [2, 2, 4], look: [0, 0, 0] }];
  for (const k of keys) assert.ok(near(cam(keys, k.f).pos, k.pos));
  // 第 5 帧：折线上是 (1, 0, 4)；样条在中间那个关键帧的切线是 (0.1, 0.1, 0) 米每帧，这一点被往 −Y 拉了 0.125 米
  assert.ok(near(cam(keys, 5).pos, [1.125, -0.125, 4]));
});

test('camera.spline：相机的 −Z 轴指向看向点，Y 轴朝上，四元数长度是 1', () => {
  for (const [pos, look] of [[[0, 0, 5], [0, 0, 0]], [[3, 2, -1], [0.5, 0, 0.25]], [[-4, 0.2, 0], [0, 1, 0]], [[0.1, 3, 0.1], [0, 0, 0]]]) {
    const { quat } = cam([{ f: 0, pos, look }], 0), want = look.map((v, i) => v - pos[i]), n = Math.hypot(...want);
    assert.ok(Math.abs(Math.hypot(...quat) - 1) < 1e-12);
    assert.ok(near(rotate(quat, [0, 0, -1]), want.map((v) => v / n), 1e-12), `朝向 ${pos}`);
    assert.ok(rotate(quat, [0, 1, 0])[1] > 0 && Math.abs(rotate(quat, [1, 0, 0])[1]) < 1e-12, `不歪头 ${pos}`);
  }
  // 在 +Z 上看原点：不用转
  assert.ok(near(cam([{ f: 0, pos: [0, 0, 5], look: [0, 0, 0] }], 0).quat, [0, 0, 0, 1]));
});

test('camera.spline：视场角关键帧写了用写的，没写用参数的，中间线性过渡', () => {
  const keys = [{ f: 0, pos: [0, 0, 4], look: [0, 0, 0], fovDeg: 20 }, { f: 10, pos: [0, 0, 2], look: [0, 0, 0] }];
  assert.deepEqual([0, 5, 10].map((f) => cam(keys, f).fovDeg), [20, 30, 40]);
});

test('camera.spline：看向实体时取它这一帧世界包围盒的中心；没有包围盒报错', () => {
  const keys = [{ f: 0, pos: [0, 0, 5], look: 'kit' }];
  const bbox = { kit: [[-1, -1, -1, 1, 1, 1], [-1, 1, -1, 1, 3, 1]] };
  assert.ok(near(rotate(cam(keys, 0, 0, { bbox }).quat, [0, 0, -1]), [0, 0, -1]));
  assert.ok(rotate(cam(keys, 1, 0, { bbox }).quat, [0, 0, -1])[1] > 0.3);
  assert.throws(() => cam(keys, 0), /包围盒/);
});

test('camera.spline：关键帧没按 f 递增、相机和看向点重合、相机在看向点正上方都报错', () => {
  assert.throws(() => cam([{ f: 5, pos: [0, 0, 1], look: [0, 0, 0] }, { f: 5, pos: [0, 0, 2], look: [0, 0, 0] }], 0), RangeError);
  assert.throws(() => cam([{ f: 0, pos: [0, 0, 0], look: [0, 0, 0] }], 0), RangeError);
  assert.throws(() => cam([{ f: 0, pos: [0, 5, 0], look: [0, 0, 0] }], 0), RangeError);
  assert.throws(() => cam([], 0), RangeError);
});

test('camera.spline：卡文件里 keys 的默认值求得出相机', async () => {
  const card = JSON.parse(await readFile(new URL('./card.json', import.meta.url), 'utf8'));
  assert.deepEqual(cam(card.params.keys.default, 0), { pos: [0, 0, 1], quat: [0, 0, 0, 1], fovDeg: 40 });
});
