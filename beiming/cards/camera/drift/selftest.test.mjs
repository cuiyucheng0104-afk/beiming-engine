import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera } from 'three-webgpu';
import { evaluate } from './evaluate.mjs';

const inputs = { size: [1080, 608], shot: { id: 'locked', in: 60, frames: 300 } };
const origin = { pos: [-0, 2, 5], yawDeg: 90, pitchDeg: -30, fovYDeg: 52 };
const motion = { zoom: 1.25, pan: [0.3, 0.08], pushMeters: 1.2 };
const at = (params, f, sub = 0) => evaluate(inputs, { ...origin, ...params }, f, sub).camera;
const close = (actual, want, eps = 1e-12) => assert.ok(Math.abs(actual - want) < eps, `${actual} 对 ${want}`);

// deepStrictEqual 区分 −0；另用实际宿主用的 three 相机从四元数和视场角独立生成矩阵。
test('15-2：显式锁机位及零漂移在 300 帧各两个子帧、镜头外烘焙样本上都逐位不变', () => {
  const fixed = at({ mode: 'locked' }, 0);
  for (const p of [{ ...motion, mode: 'locked' }, { mode: 'linear', zoom: 1, pan: [0, 0], pushMeters: 0 }]) {
    for (let f = -1; f <= 300; f++) for (const sub of [0, 0.375]) assert.deepEqual(at(p, f, sub), fixed);
  }
  const a = at({}, 2); a.world.fill(7); a.pos.fill(9);
  assert.deepEqual(at({}, 2), fixed);
});

test('线性推进、平移沿相机局部轴，焦距线性，末帧与单帧语义', () => {
  const p = { ...motion, mode: 'linear' }, first = at(p, 0);
  for (const [f, sub] of [[0, 0], [81, 0.5], [299, 0], [299, 0.8]]) {
    const c = at(p, f, sub), u = Math.min(1, (f + sub) / 299);
    // yaw=90°、pitch=−30°：右向 −Z，视线向 −X 并向下。
    const s = 0.5, h = Math.sqrt(3) / 2;
    [-(s * 0.08 + h * 1.2) * u, 2 + (h * 0.08 - s * 1.2) * u, 5 - 0.3 * u].forEach((want, i) => close(c.pos[i], want));
    close(c.proj[5] / first.proj[5], 1 + 0.25 * u);
    const camera = new PerspectiveCamera(c.fovDeg, 1080 / 608, 0.1, 100);
    camera.position.fromArray(c.pos); camera.quaternion.fromArray(c.quat); camera.updateMatrixWorld();
    c.world.forEach((v, i) => close(v, camera.matrixWorld.elements[i]));
    c.proj.forEach((v, i) => close(v, camera.projectionMatrix.elements[i]));
  }
  assert.deepEqual(evaluate({ ...inputs, shot: { frames: 1 } }, { ...origin, ...p }, 0, 0.5).camera, first);
});

test('不合法的入参报 usage.bad-argument，取值器和 Proxy 陷阱均未执行', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('不应调用'); };
  const poison = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const bad = { code: 'usage.bad-argument' };
  for (const p of [poison, { pos: poison }, { get pan() { return trap(); } }, { pan: Object.defineProperty([1, 2], 0, { get: trap }) },
    { pan: Array(2) }, { pan: [NaN, 0] }, { pos: [1, 2, 3, 4] }, { foo: 2 }, { zoom: Infinity }, { mode: 'slow' }, { fovYDeg: 180 }, { pan: null }]) {
    assert.throws(() => evaluate(inputs, p, 0, 0), bad);
  }
  for (const ctx of [poison, { ...inputs, shot: poison }, { ...inputs, shot: { get frames() { return trap(); } } }, { ...inputs, size: Array(2) }, { ...inputs, other: 1 }]) {
    assert.throws(() => evaluate(ctx, {}, 0, 0), bad);
  }
  assert.throws(() => at({}, 0, NaN), bad);
  assert.throws(() => at({}, null), bad);
  assert.equal(calls, 0);
});
