import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three-webgpu';
import { dataValidators } from '../../sweep-schema.mjs';
import { evaluateAssertion } from '../../../verify/predicates.mjs';
import card from './card.json' with { type: 'json' };
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

test('camera.fit：与视线共线的线段没有最小正深度解，侧视线段仍能精确取景', () => {
  const x = { min: [-1, 0, 0], max: [1, 0, 0] };
  const y = { min: [0, -1, 0], max: [0, 1, 0] };
  const z = { min: [0, 0, -1], max: [0, 0, 1] };
  const rejects = p => assert.throws(() => evaluate({}, p, 0), { code: 'usage.bad-argument' });
  for (const sign of [-1, 1]) {
    for (const view of ['fixed', 'orbit']) rejects({ bbox: y, elevationDeg: sign * 90, view });
    rejects({ bbox: z, azimuthDeg: sign * 180 });
    rejects({ bbox: x, azimuthDeg: sign * 90, fovYDeg: 20 });
  }
  rejects({ bbox: z, azimuthDeg: 1e-12 }); // 近端深度只剩舍入量级
  const side = { bbox: z, azimuthDeg: 90, aspect: 1, margin: 0.8 };
  assert.ok(Math.abs(occupancy(evaluate({}, side, 0), side) - side.margin) < 1e-12);
  const tiny = { min: [0, 0, -1e-15], max: [0, 0, 1e-15] };
  const unit = evaluate({}, side, 0).distance;
  const scaled = evaluate({}, { ...side, bbox: tiny }, 0).distance;
  assert.ok(Math.abs(scaled / 1e-15 - unit) < 1e-12);
});

test('camera.fit：无最小正深度解、盒轴反向、参数越界、代理、访问器、空槽、未知键全拒且陷阱零调用', () => {
  let calls = 0;
  const trap = () => { calls++; throw Error('不该调用'); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const sparse = [0, 0, 0];
  delete sparse[1];
  for (const invalid of [{ bbox: { min: [1, 2, 3], max: [1, 2, 3] } }, { bbox: { min: [0, 3, 0], max: [1, 2, 3] } },
    proxy, { bbox: proxy }, { bbox: { min: proxy, max: [1, 2, 3] } }, { bbox: { min: sparse, max: [1, 2, 3] } },
    { bbox: { get min() { return trap(); } } }, { bbox: { min: [1, 2, 3], max: [4, 5, 6], extra: 0 } },
    { margin: 0.99 }, { aspect: 0 }, { view: 'pan' }, { fovYDeg: NaN }, { odd: 1 }]) {
    assert.throws(() => evaluate({}, invalid, 0), { code: 'usage.bad-argument' });
  }
  assert.equal(calls, 0);
});

test('camera.fit：bboxes=null 保留 1.0.0 默认、固定及整圈姿态的精确数值', () => {
  const common = { bbox: { min: [2, -3, 4], max: [5, -2, 8] }, azimuthDeg: -127, elevationDeg: -23, aspect: 1.2, margin: 0.8, fovYDeg: 42 };
  const quat = [0.08895753634117314, -0.8769682899478951, 0.17842121511156875, 0.4372402602140894];
  assert.deepEqual(evaluate({}, {}, 12, 0.5), { target: [0, 0, 0], distance: 2.2227405844614756,
    camera: { pos: [1.2749116233682545, 0, 1.820762493685726], quat: [-0, 0.3007057995042731, 0, 0.9537169507482269], fovDeg: 40 } });
  for (const [view, distance, pos] of [
    ['fixed', 6.984659685039965, [-1.6347576422032537, -5.229123960849201, 2.130682582421463]],
    ['orbit', 7.359137734054774, [-1.9100543797285763, -5.375444191535219, 1.9232316108791698]],
  ]) assert.deepEqual(evaluate({}, { ...common, view, bboxes: null }, 12, 0.5), { target: [3.5, -2.5, 6], distance, camera: { pos, quat, fovDeg: 42 } });
});

const box = (r, cy = 0, cx = 0) => ({ min: [cx - r, cy - r, -r], max: [cx + r, cy + r, r] });

test('camera.fit：中心窗提前拉远，EMA 平滑，关闭滑动最大让爆炸帧 inside_frame 变红', () => {
  const p = { bboxes: [1, 1, 1, 10, 1, 1, 1].map(r => box(r)), azimuthDeg: 0,
    fovYDeg: 90, aspect: 1, margin: 0.8, windowFrames: 1, smoothAlpha: 0.5 };
  const run = options => p.bboxes.map((_, f) => evaluate({}, { ...p, ...options }, f));
  const fit = run({ useSlidingMax: true }), unsafe = run({ useSlidingMax: false });
  const expected = [2.25, 2.25, 12.375, 22.5, 19.96875, 11.109375, 6.6796875];
  fit.forEach(({ distance }, f) => assert.ok(Math.abs(distance - expected[f]) < 1e-12));
  assert.ok(unsafe[2].distance < fit[2].distance);
  assert.ok(unsafe[3].distance < fit[3].distance);
  const film = { output: { frames: p.bboxes.length }, shots: [{ id: 's01', in: 0, out: p.bboxes.length, roles: { hero: 'subject' } }] };
  const size = [200, 200];
  const verdict = track => evaluateAssertion('inside_frame(hero, margin=0.09) @ all', film, { frames: track.map((pose, frame) => {
    const extent = occupancy(pose, { bbox: p.bboxes[frame], aspect: p.aspect });
    const bbox2d = [100 - 100 * extent, 100 - 100 * extent, 100 + 100 * extent, 100 + 100 * extent];
    return { frame, meta: { size, entities: [{ name: 'subject', bbox2d, pxArea: 1 }] } };
  }) });
  assert.equal(verdict(fit).ok, true);
  assert.equal(verdict(unsafe).counterexampleFrame, 3);
  assert.deepEqual(run({ useSlidingMax: true }), fit);
});

test('camera.fit：下限逐帧约束相机高度与近裁，俯仰改变时实际光轴仍看向目标；采样顺序及端点不改结果', () => {
  const p = { bboxes: [box(0.01, -1), box(0.015, -2, 0.5), box(0.01, 0, 1)], elevationDeg: -20, azimuthDeg: 120,
    groundY: 0, groundClearanceM: 0.2, nearClipM: 1, margin: 0.7, aspect: 1.6 };
  for (const elevationDeg of [-20, 0, 30]) {
    const q = { ...p, elevationDeg }, track = p.bboxes.map((_, f) => evaluate({}, q, f));
    for (const f of [2, 1, 0, 2]) {
      const pose = evaluate({ shot: { in: 123, frames: 3 } }, structuredClone(q), f, 0.6);
      assert.deepEqual(pose, track[f]);
      assert.ok(pose.camera.pos[1] >= 0.2 - 1e-12);
      const back = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(pose.camera.quat));
      const toCamera = new Vector3().fromArray(pose.camera.pos).sub(new Vector3().fromArray(pose.target));
      assert.ok(toCamera.normalize().distanceTo(back) < 1e-12);
      for (const x of [p.bboxes[f].min[0], p.bboxes[f].max[0]]) for (const y of [p.bboxes[f].min[1], p.bboxes[f].max[1]]) for (const z of [p.bboxes[f].min[2], p.bboxes[f].max[2]]) {
        const depth = -new Vector3(x, y, z).sub(new Vector3().fromArray(pose.camera.pos)).dot(back);
        assert.ok(depth >= p.nearClipM - 1e-12);
      }
      assert.ok(occupancy(pose, { bbox: p.bboxes[f], aspect: p.aspect }) <= p.margin + 1e-12);
    }
    assert.deepEqual(evaluate({}, q, -1), track[0]);
    assert.deepEqual(evaluate({}, q, 3), track[2]);
  }
  const saved = evaluate({}, p, 0);
  const mutable = evaluate({}, p, 0);
  mutable.camera.pos.fill(500); mutable.camera.quat.fill(500); mutable.target.fill(500);
  assert.deepEqual(evaluate({}, p, 0), saved);
  p.bboxes[0].max[1] = 20;
  assert.ok(evaluate({}, p, 0).distance > saved.distance);
});

test('camera.fit：动态轨道严格校验所有帧而非只校验当前帧，拒绝访问器与错误控制量', () => {
  let traps = 0;
  const valid = box(1), getter = { get min() { traps++; return [0, 0, 0]; }, max: [1, 1, 1] };
  for (const extra of [{ bboxes: [] }, { bboxes: [valid, null] }, { bboxes: [valid, getter] }, { bboxes: [valid, { min: [1, 1, 1], max: [0, 1, 1] }] },
    { bboxes: [valid], windowFrames: 0.5 }, { bboxes: [valid], smoothAlpha: 0 }, { bboxes: [valid], nearClipM: 0 }, { bboxes: [valid], useSlidingMax: 'false' }]) {
    assert.throws(() => evaluate({}, extra, 0), { code: 'usage.bad-argument' });
  }
  assert.equal(traps, 0);
  const schema = new Map(dataValidators(card)).get('bboxes');
  for (const accepted of [null, [valid], [valid, box(2)]]) assert.equal(schema(accepted), true);
  for (const rejected of [valid, [], [null], [{ ...valid, max: [0, 0] }], [{ ...valid, extra: true }]]) assert.equal(schema(rejected), false);
});
