import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ROLL_BANK_CONFIG,
  buildRailRollBankFields,
  evaluate,
  measureMaxTwistJumpDeg,
  parallelTransportFrames,
  referenceUpAt,
  rollLimitStep,
  solveRollBankFrames,
} from './index.mjs';

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps=${eps})`);

test('过竖直攀升/俯冲路径平行输运标架正交单位且无 180 度翻转', () => {
  // Smooth vertical loop passing straight through +Y and -Y tangents
  const n = 120;
  const tangents = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * Math.PI * 2;
    tangents.push([0, Math.sin(th), Math.cos(th)]);
  }
  const frames = parallelTransportFrames(tangents, [0, 1, 0]);
  assert.equal(frames.length, n + 1);
  for (const f of frames) {
    close(norm3(f.tangent), 1, 1e-9);
    close(norm3(f.normal), 1, 1e-9);
    close(norm3(f.binormal), 1, 1e-9);
    close(dot3(f.tangent, f.normal), 0, 1e-9);
    const c = cross3(f.tangent, f.normal);
    close(dot3(c, f.binormal), 1, 1e-9);
  }
  const maxJump = measureMaxTwistJumpDeg(frames);
  assert.ok(maxJump < 0.05, `平行输运相邻扭转跳变应接近 0，实测 ${maxJump} deg`);

  const upVert = referenceUpAt([0, 50, 0], [0, 1, 0]);
  close(norm3(upVert), 1, 1e-9);
  assert.ok(upVert[2] > 0.9, '近竖直切线应平滑切换至防奇异备用轴');
});

test('rollLimitStep 将参考法向突变限制在步进上限内，避免 180 度跳变', () => {
  const prev = [0, 1, 0];
  const tan = [0, 0, 1];
  const maxStep = (5 * Math.PI) / 180;
  // Flip reference almost 180 degrees
  const res = rollLimitStep(1, tan, [0.01, -1, 0], prev, maxStep);
  const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot3([0, 1, 0], res.normal)))) * 180) / Math.PI;
  close(angleDeg, 5, 1e-5);
});

test('曲率向心倾斜随速度增大并平滑饱和，脚本翻滚角精确旋转法向与副法向', () => {
  // Circular arc in XZ plane of radius 30 m
  const R = 30;
  const ds = 0.25;
  const n = 400;
  const railPoints = [];
  for (let i = 0; i <= n; i++) {
    const th = (i * ds) / R;
    railPoints.push([R * Math.cos(th), 20, R * Math.sin(th)]);
  }
  const fields = buildRailRollBankFields(railPoints, ds, { bodyLength: 80, segments: 160, maxRollStepDeg: 5 });
  const stations = [];
  for (let i = 100; i <= 260; i += 4) {
    const p0 = railPoints[i - 1];
    const p1 = railPoints[i + 1];
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const l = norm3(d);
    stations.push({
      pos: railPoints[i],
      tan: [d[0] / l, d[1] / l, d[2] / l],
      railNormal: [fields.railN[i * 3], fields.railN[i * 3 + 1], fields.railN[i * 3 + 2]],
      railCurvature: [fields.railK[i * 3], fields.railK[i * 3 + 1], fields.railK[i * 3 + 2]],
      arclength: (i - 100) * ds,
    });
  }

  const slow = solveRollBankFrames(stations, { speed: 0, scriptedRollDeg: 0 });
  const fast = solveRollBankFrames(stations, { speed: 35, scriptedRollDeg: 0 });
  const rolled = solveRollBankFrames(stations, { speed: 0, scriptedRollDeg: 45 });

  const mid = Math.floor(stations.length / 2);
  close(slow[mid].bankRad, 0, 1e-6);
  assert.ok(fast[mid].bankRad > 0.3 && fast[mid].bankRad < 1.2, `高速转弯倾斜角应显著且饱和，实测 ${fast[mid].bankRad} rad`);
  close(rolled[mid].rollRad, Math.PI / 4, 1e-6);
  const angleBetween = Math.acos(Math.max(-1, Math.min(1, dot3(slow[mid].normal, rolled[mid].normal))));
  close(angleBetween, Math.PI / 4, 1e-5);
  assert.ok(measureMaxTwistJumpDeg(fast) < 0.5);
});

test('纯函数 evaluate 乱序抽帧逐位一致', () => {
  const params = {
    config: DEFAULT_ROLL_BANK_CONFIG,
    maxRollStepDeg: 5,
    maxTwistStepDeg: 6,
    scriptedRollDeg: 20,
    speed: 28,
    viewRollWeight: 0.6,
  };
  const run = (f) => evaluate({ fps: 60, observerPos: [0, 15, 65] }, params, f, 0);
  const frames = [0, 10, 25, 60];
  const baseline = frames.map(run);
  for (const idx of [2, 3, 0, 1]) assert.deepEqual(run(frames[idx]), baseline[idx]);
  assert.ok(baseline[0].readings.maxTwistStepDeg < 6.01);
});

test('非法参数统一报告 usage.bad-argument', () => {
  for (const call of [
    () => parallelTransportFrames([], [0, 1, 0]),
    () => solveRollBankFrames([], {}),
    () => buildRailRollBankFields([[0, 0, 0]], 0.25),
    () => evaluate(null, { config: DEFAULT_ROLL_BANK_CONFIG }),
    () => evaluate({ fps: 60 }, { config: DEFAULT_ROLL_BANK_CONFIG, maxRollStepDeg: 0 }),
  ]) {
    assert.throws(call, { code: 'usage.bad-argument' });
  }
});
