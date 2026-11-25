import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attackDecayPulse,
  evalEventEnvelope,
  evaluate,
  evaluateImpulseStations,
  impulseDisplacementAt,
  impulseVelocityAt,
  smoothstep,
} from './index.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps=${eps})`);

test('空事件列表返回精确零位移与零速度', () => {
  const disp = impulseDisplacementAt([], 1.5, 10, 100);
  assert.deepEqual(disp, { offset: [0, 0, 0], activeCount: 0 });
  assert.deepEqual(impulseVelocityAt([], 1.5, 10, 100), [0, 0, 0]);
  const out = evaluate({ time: 1.5, fps: 60 }, { events: [], arclength: 10, bodyLength: 100, velocityDt: 5e-4 });
  assert.deepEqual(out.impulse.offset, [0, 0, 0]);
  assert.deepEqual(out.impulse.velocity, [0, 0, 0]);
  assert.equal(out.readings.activeCount, 0);
  assert.equal(out.readings.offsetNormM, 0);
  assert.equal(out.readings.speedMps, 0);
});

test('平滑窗脉冲边界归零、峰值准确、速度导数方向正确', () => {
  const ev = {
    t0: 1.0,
    duration: 2.0,
    dir: [0, 3, 4],
    amp: 5.0,
    reach: 20,
    whip: 0,
    envelope: 'smooth-window',
    riseStart: 1.0,
    riseEnd: 1.5,
    fallStart: 2.5,
    fallEnd: 3.0,
  };
  assert.deepEqual(impulseDisplacementAt([ev], 0.99, 0).offset, [0, 0, 0]);
  assert.deepEqual(impulseDisplacementAt([ev], 3.01, 0).offset, [0, 0, 0]);

  const peak = impulseDisplacementAt([ev], 2.0, 0);
  assert.equal(peak.activeCount, 1);
  close(peak.offset[0], 0);
  close(peak.offset[1], 3.0);
  close(peak.offset[2], 4.0);

  const vRise = impulseVelocityAt([ev], 1.25, 0);
  const vTop = impulseVelocityAt([ev], 2.0, 0);
  const vFall = impulseVelocityAt([ev], 2.75, 0);
  assert.ok(vRise[1] > 0 && vRise[2] > 0, '上升段速度应沿推力正方向');
  close(vTop[1], 0, 1e-6);
  close(vTop[2], 0, 1e-6);
  assert.ok(vFall[1] < 0 && vFall[2] < 0, '回落段速度应沿推力反方向');
});

test('支持攻放脉冲、余弦窗、多段叠加、弧长高斯衰减与鞭打传播延迟', () => {
  const pulseVal = attackDecayPulse(1.5, 1.0, 0.2, 0.5);
  close(pulseVal, Math.exp(-0.3 / 0.5));
  assert.equal(attackDecayPulse(0.9, 1.0, 0.2, 0.5), 0);

  const cosEv = { t0: 0, duration: 2, dir: [1, 0, 0], amp: 4, reach: 10, whip: 20, envelope: 'cosine' };
  close(evalEventEnvelope(cosEv, 1.0), 4.0);
  close(evalEventEnvelope(cosEv, 0.0), 0.0);

  // At arclength a = 10 with whip = 20 m/s, delay is 0.5 s so peak arrives at t = 1.5 s
  const atHead = impulseDisplacementAt([cosEv], 1.0, 0);
  const atBody = impulseDisplacementAt([cosEv], 1.5, 10);
  close(atHead.offset[0], 4.0);
  close(atBody.offset[0], 4.0 * Math.exp(-1));

  // Multi-term event (e.g. pull-back then strike along same axis)
  const twoPhase = {
    t0: 0,
    t1: 2,
    dir: [1, 0, 0],
    reach: 15,
    terms: [
      { amp: -2, envelope: 'smooth-window', riseStart: 0.0, riseEnd: 0.4, fallStart: 0.6, fallEnd: 0.8 },
      { amp: 5, envelope: 'smooth-window', riseStart: 0.8, riseEnd: 1.2, fallStart: 1.5, fallEnd: 1.9 },
    ],
  };
  assert.ok(impulseDisplacementAt([twoPhase], 0.5, 0).offset[0] < -1.5);
  assert.ok(impulseDisplacementAt([twoPhase], 1.35, 0).offset[0] > 4.5);

  const stations = evaluateImpulseStations([cosEv, twoPhase], 1.35, [0, 10, 20]);
  assert.equal(stations.length, 3);
  assert.ok(Math.abs(stations[0].offset[0]) > Math.abs(stations[2].offset[0]));
});

test('纯函数乱序抽帧逐位一致', () => {
  const params = {
    events: [
      { t0: 0.5, duration: 1.5, dir: [0.3, 0.9, -0.2], amp: 3.2, reach: 18, whip: 40, tailFade: 0.3, envelope: 'smooth-window' },
      { t0: 1.2, duration: 1.8, dir: [-0.6, 0.4, 0.7], amp: 2.1, reach: 25, whip: 0, envelope: 'attack-decay', attack: 0.15, release: 0.4 },
    ],
    arclength: 8,
    bodyLength: 100,
    velocityDt: 5e-4,
  };
  const ctx = { fps: 60 };
  const frames = [15, 45, 75, 110, 150];
  const baseline = frames.map((f) => evaluate(ctx, params, f, 0.25));
  for (const idx of [4, 1, 3, 0, 2]) {
    assert.deepEqual(evaluate(ctx, params, frames[idx], 0.25), baseline[idx]);
  }
  close(smoothstep(0, 1, 0.5), 0.5);
});

test('非法参数统一报告 usage.bad-argument', () => {
  const ctx = { fps: 60 };
  for (const call of [
    () => evaluate(null, { events: [] }),
    () => evaluate(ctx, { events: 'bad' }),
    () => impulseDisplacementAt([{ t0: 0, duration: -1, dir: [1, 0, 0] }], 0.5),
    () => impulseDisplacementAt([{ t0: 0, duration: 1, dir: [0, 0, 0] }], 0.5),
    () => impulseDisplacementAt([{ t0: 0, duration: 1, dir: [1, 0, 0], reach: 0 }], 0.5),
    () => impulseDisplacementAt([{ t0: 0, duration: 1, dir: [1, 0, 0], whip: -5 }], 0.5),
    () => evaluate(ctx, { events: [], arclength: -1 }),
  ]) {
    assert.throws(call, { code: 'usage.bad-argument' });
  }
});
