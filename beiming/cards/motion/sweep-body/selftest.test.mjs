import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CentripetalCatmullRom,
  compileRail,
  evaluate,
  monotoneCubic,
  sampleSpineFrameAt,
  sweepSpineAt,
} from './index.mjs';
import { measureMaxTwistJumpDeg } from '../roll-bank/index.mjs';

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps=${eps})`);

function makeHelixTrajectory() {
  const controlPoints = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    const th = u * Math.PI * 3;
    controlPoints.push([18 * Math.cos(th), 10 + 48 * u, 18 * Math.sin(th)]);
  }
  return {
    controlPoints,
    timeKeys: [[0, 0], [4, 8], [8, 16], [12, 24]],
    timeKeyMode: 'cpIndex',
    arcLengthDivisions: 4000,
    railSampleSpacing: 0.25,
    impulses: [
      { t0: 4.5, duration: 2.0, dir: [0.3, 0.9, 0.2], amp: 3.5, reach: 16, whip: 35, tailFade: 0.3, envelope: 'smooth-window' },
    ],
  };
}

test('单调三次插值与向心 Catmull-Rom 精确过关键点且单调无过冲', () => {
  const fn = monotoneCubic([0, 2, 5, 10], [0, 30, 80, 200]);
  close(fn(0), 0);
  close(fn(2), 30);
  close(fn(5), 80);
  close(fn(10), 200);
  let prev = -Infinity;
  for (let t = 0; t <= 10; t += 0.25) {
    const v = fn(t);
    assert.ok(v >= prev, `单调三次插值出现回退: t=${t}, ${v} < ${prev}`);
    prev = v;
  }

  const pts = [[0, 0, 0], [10, 5, 0], [20, 0, 10], [30, 10, 10]];
  const curve = new CentripetalCatmullRom(pts, 1000);
  const p0 = curve.getPoint(0);
  const p1 = curve.getPoint(1);
  close(p0[0], 0, 1e-9);
  close(p1[0], 30, 1e-9);
  assert.ok(curve.totalLength > 34);
});

test('扫掠脊线标架正交单位、无扭转翻折且弧长插值准确', () => {
  const traj = makeHelixTrajectory();
  const rail = compileRail(traj, { bodyLength: 40, segments: 100 });
  const res = sweepSpineAt(rail, 6.0, {
    bodyLength: 40,
    segments: 100,
    sampleArclengths: Array.from({ length: 41 }, (_, i) => i),
    swimAmplitude: 1,
    impulses: traj.impulses,
  });

  assert.equal(res.nodes.length, 41);
  for (const node of res.nodes) {
    close(norm3(node.tan), 1, 1e-6);
    close(norm3(node.nor), 1, 1e-6);
    close(norm3(node.bin), 1, 1e-6);
    close(dot3(node.tan, node.nor), 0, 1e-6);
    close(dot3(cross3(node.tan, node.nor), node.bin), 1, 1e-6);
  }
  const railPt = compileRail(traj, { bodyLength: 40, segments: 100, frameMode: 'parallel-transport' });
  const ptRes = sweepSpineAt(railPt, 6.0, {
    bodyLength: 40,
    segments: 100,
    sampleArclengths: Array.from({ length: 41 }, (_, i) => i),
    swimAmplitude: 0,
    bankGain: 0,
    impulses: [],
  });
  const twistJump = measureMaxTwistJumpDeg(ptRes.nodes.map((n) => ({ tangent: n.tan, normal: n.nor, binormal: n.bin })));
  assert.ok(twistJump < 0.5, `平行输运相邻弧长扭转跳变应 < 0.5 deg，实测 ${twistJump}`);

  const mid = sampleSpineFrameAt(res.rawFrames, 40, 20.5);
  close(norm3(mid.tan), 1, 1e-6);
  close(norm3(mid.nor), 1, 1e-6);
});

test('纯函数乱序抽帧逐位一致', () => {
  const traj = makeHelixTrajectory();
  const params = {
    trajectory: traj,
    bodyLength: 40,
    segments: 80,
    sampleCount: 41,
    swimAmplitude: 1,
    swimCalm: 1,
    swimStir: 0.25,
    swimPhaseDeg: 15,
    bankGain: 0.42,
    scriptedRollDeg: 10,
    maxRollStepDeg: 5,
    maxTwistStepDeg: 6,
  };
  const ctx = { fps: 60 };
  const frames = [180, 300, 360, 480, 600];
  const baseline = frames.map((f) => evaluate(ctx, params, f, 0));
  for (const idx of [3, 1, 4, 0, 2]) {
    assert.deepEqual(evaluate(ctx, params, frames[idx], 0), baseline[idx]);
  }
});

test('清空脉冲与关闭游动波可干净切换对应动力学层', () => {
  const traj = makeHelixTrajectory();
  const rail = compileRail(traj, { bodyLength: 40, segments: 100 });
  const base = sweepSpineAt(rail, 5.5, { bodyLength: 40, segments: 100, swimAmplitude: 1, impulses: traj.impulses });
  const noImp = sweepSpineAt(rail, 5.5, { bodyLength: 40, segments: 100, swimAmplitude: 1, impulses: [] });
  const noSwim = sweepSpineAt(rail, 5.5, { bodyLength: 40, segments: 100, swimAmplitude: 0, impulses: traj.impulses });

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(dist(base.nodes[0].pos, noImp.nodes[0].pos) > 1.0, '清空脉冲应在激活时刻显著改变头部位置');
  assert.ok(dist(base.nodes.at(-1).pos, noSwim.nodes.at(-1).pos) > 0.2, '关闭游动波应显著改变躯干尾部位置');
});

test('非法参数统一报告 usage.bad-argument', () => {
  for (const call of [
    () => monotoneCubic([0], [0]),
    () => monotoneCubic([0, 2, 1], [0, 1, 2]),
    () => new CentripetalCatmullRom([[0, 0, 0]]),
    () => compileRail({ controlPoints: [[0, 0, 0]] }),
    () => evaluate(null, { trajectory: makeHelixTrajectory() }),
  ]) {
    assert.throws(call, { code: 'usage.bad-argument' });
  }
});
