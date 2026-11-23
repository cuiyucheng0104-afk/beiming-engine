import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Quaternion, Vector3 } from 'three-webgpu';
import { evaluate } from './evaluate.mjs';

const p = { target: [1, 2, -3], distance: 4, startAzimuthDeg: 27, elevationDeg: 19, fovYDeg: 53 };
const point = (pos) => new Vector3(...pos);

test('camera.orbit：60、72 帧含首尾的每一步都等长，完整转一圈；子帧和反向也按相位求', () => {
  for (const frames of [60, 72]) for (const turns of [-1, 1]) {
    const cam = (f, sub = 0) => evaluate({}, { ...p, frames, turns }, f, sub).camera;
    const chord = (step) => 2 * p.distance * Math.cos(p.elevationDeg * Math.PI / 180) * Math.sin(Math.PI * step / frames);
    for (let f = 0; f < frames; f++) {
      const now = cam(f), pos = point(now.pos), next = point(cam((f + 1) % frames).pos);
      assert.ok(Math.abs(next.distanceTo(pos) - chord(1)) < 1e-12);
      assert.ok(Math.abs(point(cam(f, 0.25).pos).distanceTo(pos) - chord(0.25)) < 1e-12);
      const q = new Quaternion(...now.quat);
      assert.ok(Math.abs(q.length() - 1) < 1e-12);
      const look = pos.clone().addScaledVector(new Vector3(0, 0, -1).applyQuaternion(q), p.distance);
      assert.ok(look.distanceTo(point(p.target)) < 1e-12);
      assert.equal(now.fovDeg, p.fovYDeg);
    }
    // 排除一条反向走或中途折返、弦长却一样的轨道。
    const bearing = p.startAzimuthDeg + turns * 90;
    assert.ok(Math.abs(cam(frames / 4).pos[0] - (p.target[0] + p.distance * Math.cos(19 * Math.PI / 180) * Math.sin(bearing * Math.PI / 180))) < 1e-12);
    assert.deepEqual(cam(frames), cam(0));
  }
});

test('camera.orbit：直接调用拒收未声明参数、不合法时刻、稀疏向量、访问器、代理；陷阱调用次数为零', () => {
  let calls = 0;
  const trap = () => { calls++; throw Error('不该调用'); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  for (const invalid of [proxy, { target: proxy }, { target: [1, , 3] }, { target: [1, 2, NaN] }, { get distance() { return trap(); } },
    { fovYDeg: Infinity }, { frames: 1.5 }, { distance: 0 }, { unknown: true }]) {
    assert.throws(() => evaluate({}, invalid, 1, 0), { code: 'usage.bad-argument' });
  }
  for (const [input, f, sub] of [[proxy, 0, 0], [{ events: [proxy] }, 0, 0], [{}, 1.5, 0], [{}, 1, -0.1], [{}, 0, 1]]) {
    assert.throws(() => evaluate(input, {}, f, sub), { code: 'usage.bad-argument' });
  }
  assert.equal(calls, 0);
});
