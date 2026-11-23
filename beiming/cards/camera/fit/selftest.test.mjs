import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three-webgpu';
import { evaluate } from './evaluate.mjs';

// 用实际相机的投影矩阵回读八角的 NDC，不复抄求解器的八个约束。
function occupancy({ camera }, { bbox, aspect }) {
  const c = new PerspectiveCamera(camera.fovDeg, aspect, 0.0001, 10000);
  c.position.fromArray(camera.pos); c.quaternion.fromArray(camera.quat); c.updateMatrixWorld();
  let largest = 0;
  for (const x of [bbox.min[0], bbox.max[0]]) for (const y of [bbox.min[1], bbox.max[1]]) for (const z of [bbox.min[2], bbox.max[2]]) {
    const v = new Vector3(x, y, z).project(c);
    assert.ok(v.z > -1 && v.z < 1, '角点在相机前方');
    largest = Math.max(largest, Math.abs(v.x), Math.abs(v.y));
  }
  return largest;
}

test('camera.fit：三个解析真值（深度、横竖极值、斜对角与非原点中心）；斜仰视的极值角也精确贴框', () => {
  const trials = [
    [{ min: [-2, -0.5, -1], max: [2, 0.5, 1] }, 0, 2, 0.8, 1 + 2 / 1.6],
    [{ min: [2, 4, -3], max: [4, 10, -1.5] }, 90, 1, 0.9, 1 + 3 / 0.9],
    [{ min: [-1, -0.5, -1], max: [1, 0.5, 1] }, 45, 0.5, 0.7, Math.SQRT2 / 0.35],
  ];
  for (const [bbox, azimuthDeg, aspect, margin, truth] of trials) {
    const p = { bbox, azimuthDeg, aspect, margin, fovYDeg: 90 };
    const out = evaluate({}, p, 0);
    assert.ok(Math.abs(out.distance - truth) < 1e-6);
    assert.ok(Math.abs(occupancy(out, p) - margin) < 1e-12);
    for (const e of [-33, 17, 85]) assert.ok(Math.abs(occupancy(evaluate({}, { ...p, elevationDeg: e }, 14, 0.25), p) - margin) < 1e-12);
  }
});

test('camera.fit：全周固定距离不逐帧缩放；轴向看不出的侧面在环绕模式也不裁，半径不保守放大', () => {
  const p = { bbox: { min: [-2, -1, -4], max: [3, 2, 1] }, aspect: 1.8, margin: 0.91, fovYDeg: 47, elevationDeg: -23, view: 'orbit' };
  const { distance } = evaluate({}, p, 0);
  let worst = 0;
  for (let k = 0; k < 720; k++) {
    const out = evaluate({}, { ...p, azimuthDeg: k / 2 - 180 }, k);
    assert.equal(out.distance, distance);
    worst = Math.max(worst, occupancy(out, p));
  }
  assert.ok(worst <= p.margin + 1e-12 && worst > p.margin - 1e-5);
});

test('camera.fit：数值不变的设置跨帧结果相同，改掉输出不会污染下次求值，同一输入对象当场改盒子也要重新取景', () => {
  const p = { bbox: { min: [-1, -1, -1], max: [1, 1, 1] }, azimuthDeg: 0 };
  const first = evaluate({}, p, 37, 0.5);
  const fresh = evaluate({}, structuredClone(p), 100);
  first.target.fill(100); first.camera.pos.fill(-100); first.camera.quat.fill(9);
  assert.deepEqual(evaluate({}, p, 0), fresh);
  p.bbox.max[1] = 20;
  assert.ok(evaluate({}, p, 0).distance > fresh.distance);
});

test('camera.fit：无最小正深度解、盒轴反向、参数越界、代理、访问器、空槽、未知键全拒且陷阱零调用', () => {
  let calls = 0;
  const trap = () => { calls++; throw Error('不该调用'); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  for (const invalid of [{ bbox: { min: [1, 2, 3], max: [1, 2, 3] } }, { bbox: { min: [0, 3, 0], max: [1, 2, 3] } },
    proxy, { bbox: proxy }, { bbox: { min: proxy, max: [1, 2, 3] } }, { bbox: { min: [0, , 0], max: [1, 2, 3] } },
    { bbox: { get min() { return trap(); } } }, { bbox: { min: [1, 2, 3], max: [4, 5, 6], extra: 0 } },
    { margin: 0.99 }, { aspect: 0 }, { view: 'pan' }, { fovYDeg: NaN }, { odd: 1 }]) {
    assert.throws(() => evaluate({}, invalid, 0), { code: 'usage.bad-argument' });
  }
  assert.equal(calls, 0);
});
