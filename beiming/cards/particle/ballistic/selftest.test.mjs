import assert from 'node:assert/strict';
import test from 'node:test';
import { ballisticPoint, evaluate, replayBirthFrame, shapeStep } from './index.mjs';

const particle = { position: [0, 1, -2], velocity: [2, -1, 0], life: 2, gravity: -4 };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const camera = { matrixWorldInverse: identity, projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.1, 0] };
const ctx = { fps: '24/1', camera, viewport: [400, 300] };
const params = { particles: [particle], stepFps: 12 };
const close = (x, wanted) => assert.ok(Math.abs(x - wanted) < 1e-12, `${x} ≠ ${wanted}`);

test('零阻尼、弱阻尼的级数分支与切换后的重力积分', () => {
  assert.deepEqual(ballisticPoint(particle, 0.5), [1, 0, -2]);
  const weak = ballisticPoint({ ...particle, drag: 0.01 }, 1);
  const drift = 1 - 0.005 + 0.0001 / 6;
  close(weak[0], 2 * drift);
  close(weak[1], 1 - drift - 4 * (0.5 - 0.01 / 6));
  for (const drag of [0.02, 0.5, 2.7]) {
    const point = ballisticPoint({ ...particle, drag }, 1);
    const integral = (1 - Math.exp(-drag)) / drag;
    close(point[0], 2 * integral);
    close(point[1], 1 - integral - 4 * (1 - integral) / drag);
  }
});

test('地面反弹保留切向位移，反射深度受恢复系数控制', () => {
  const free = ballisticPoint(particle, 1);
  assert.deepEqual(free, [2, -2, -2]);
  assert.deepEqual(ballisticPoint({ ...particle, groundY: 0, restitution: 0.25 }, 1), [2, 0.5, -2]);
  assert.deepEqual(ballisticPoint({ ...particle, groundY: 0.3, restitution: 0 }, 1), [2, 0.3, -2]);
});

test('全局形状节拍、单精度判活、镜头局部子帧与任意帧重入', () => {
  const born = { ...params, particles: [{ ...particle, birth: 0.5, life: 0.5 }] };
  const frame = f => evaluate(ctx, born, f, 0.25);
  const order = [3, 12, 16, 25];
  const frames = order.map(frame);
  for (const i of [2, 3, 0, 1]) assert.deepEqual(frame(order[i]), frames[i]);
  assert.deepEqual(frames.map(out => out.readings.alive), [0, 1, 1, 0]);
  assert.deepEqual(evaluate({ ...ctx, time: 0.999999999 }, born).particles, []);
  assert.equal(shapeStep({ uTime: 5 / 12 - 1e-10 }), 5);
  assert.deepEqual(evaluate({ ...ctx, frame: 12.25 }, born), frame(12));
  assert.equal(evaluate({ ...ctx, shot: { in: 6 } }, born, 12, 0).readings.shapeStep, 9);
  assert.deepEqual(frame(12).particles[0].world, ballisticPoint(born.particles[0], Math.fround(12.25 / 24) - 0.5));
});

test('扇出沿视平面改变中心，拉近改变透视缩放，环池覆盖与清空遵守写入顺序', () => {
  const raw = Array(24).fill(0);
  Object.assign(raw, { 0: 0.4, 2: -4, 3: 0.321, 6: -1, 7: 2, 23: 1 });
  const records = ['soft', 'glow', 'smoke', 'soft'].map((pool, slot) => ({ frame: 2, slot, pool, raw }));
  records.push({ frame: 3, slot: 9, pool: 'flame', raw });
  const events = [{ type: 'clear', pool: 'soft', frame: 2, births_before: 3 }];
  const meta = { ...ctx, frame: 2, uTime: 1 };
  const run = options => replayBirthFrame({ records, events }, meta, options);
  const got = run({});
  assert.deepEqual(got.map(r => r.slot), [3, 2, 1]);
  const [soft, smoke, glow] = got;
  assert.deepEqual(soft.world, smoke.world);
  assert.deepEqual(run({ noFan: true })[0].px, smoke.px);
  assert.notDeepEqual(soft.px, smoke.px);
  close(glow.px[0], 220);
  close(smoke.px[0], 216);
  const changed = { ...particle, position: [0.4, 0, -4], velocity: [0, 0, -1], gravity: 0, fan: 1, seed: 0.321 };
  assert.deepEqual(evaluate({ ...ctx, time: 1 }, { particles: [changed] }).particles[0].px, soft.px);
  assert.deepEqual(replayBirthFrame({ records: [...records, { ...records[1], frame: 3, raw: [...raw.slice(0, 7), 0, ...raw.slice(8)] }], events }, { ...meta, frame: 3 }).map(p => p.slot), [9, 3, 2]);
});

test('非法输入统一报告 usage.bad-argument', () => {
  for (const call of [
    () => ballisticPoint(particle, -1), () => ballisticPoint({ ...particle, drag: NaN }, 1),
    () => ballisticPoint({ ...particle, velocity: [0] }, 1),
    () => ballisticPoint({ ...particle, restitution: 1.1 }, 1),
    () => evaluate(ctx, { particles: [null] }), () => evaluate(ctx, { ...params, stepFps: 0 }),
    () => evaluate({ ...ctx, fps: '25/0' }, params), () => evaluate({ ...ctx, camera: {} }, params),
    () => replayBirthFrame({}, { ...ctx, frame: 3, uTime: 0 }), () => shapeStep(Infinity),
  ]) assert.throws(call, { code: 'usage.bad-argument' });
});
