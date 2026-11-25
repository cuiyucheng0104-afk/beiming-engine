import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bakeTrajectory,
  evaluate,
  queryBakedTable,
  simulateSequentialAt,
} from './index.mjs';

const close = (actual, expected, eps = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

test('time.bake：带记忆阻尼振子系统在固定步长 dt 预演烘焙后，任意乱序抽帧与从头顺序推演逐位一致', () => {
  const config = {
    t0: 0,
    duration: 4.0,
    sampleHz: 60,
    substeps: 2,
    warmupSteps: 30,
    initialState: [0.4, 0.0, -0.2, 0.1],
    step(state, t, dt) {
      const [x, vx, z, vz] = state;
      const windX = 2.3 + 1.5 * Math.sin(t * 2.1) + (t >= 1.2 && t <= 1.8 ? 6.0 * Math.exp(-(t - 1.2) * 3.0) : 0);
      const windZ = -1.1 + 0.8 * Math.cos(t * 1.7);
      const ax = -9.81 * x + 0.088 * (windX - vx) - 0.35 * vx;
      const az = -9.81 * z + 0.088 * (windZ - vz) - 0.35 * vz;
      const nvx = vx + ax * dt;
      const nvz = vz + az * dt;
      return [x + nvx * dt, nvx, z + nvz * dt, nvz];
    },
  };

  const table = bakeTrajectory(config);
  assert.equal(table.sampleCount, 241);
  assert.equal(table.channels, 4);
  assert.ok(Object.isFrozen(table));

  // 随机乱序访问采样时刻，与从头顺序积分到该时刻的结果逐位一致
  const randomSteps = [180, 12, 240, 0, 95, 180, 47, 12];
  for (const k of randomSteps) {
    const t = k / config.sampleHz;
    const fromTable = queryBakedTable(table, t, { interpolation: 'linear' });
    const sequential = simulateSequentialAt(config, t);
    assert.deepEqual(fromTable, sequential, `step ${k} mismatch`);
  }
});

test('time.bake：线性插值与三次 Catmull-Rom 插值在网格点精确吻合，在子帧间平滑收敛', () => {
  // 烘焙精确三次多项式 f(t) = t^3 - 2*t^2 + 0.5*t + 1
  const poly = (t) => [t * t * t - 2 * t * t + 0.5 * t + 1];
  const table = bakeTrajectory({
    t0: 0,
    duration: 2.0,
    sampleHz: 20,
    substeps: 1,
    warmupSteps: 0,
    initialState: poly(0),
    step(_state, t, dt) {
      return poly(t + dt);
    },
  });

  // 网格点上 linear 与 cubic 完全等于真值
  for (const k of [0, 5, 17, 40]) {
    const t = k / 20;
    close(queryBakedTable(table, t, { interpolation: 'linear' })[0], poly(t)[0], 1e-12);
    close(queryBakedTable(table, t, { interpolation: 'cubic' })[0], poly(t)[0], 1e-12);
  }

  // 非网格中点处：三次插值误差远小于线性插值误差
  const tMid = 0.725;
  const exact = poly(tMid)[0];
  const linErr = Math.abs(queryBakedTable(table, tMid, { interpolation: 'linear' })[0] - exact);
  const cubErr = Math.abs(queryBakedTable(table, tMid, { interpolation: 'cubic' })[0] - exact);
  assert.ok(cubErr < linErr * 0.01, `cubic error ${cubErr} should be << linear error ${linErr}`);
});

test('time.bake：data 落点 evaluate 任意帧与子帧乱序求值逐位一致', () => {
  const ctx = { fps: 60 };
  const params = {
    spec: {
      durationS: 3.0,
      sampleHz: 30,
      substeps: 2,
      warmupSteps: 15,
      interpolation: 'cubic',
      tracks: [
        { id: 'lantern-a', lengthM: 1.4, drag: 0.088, damping: 0.3, windBase: [2.3, -1.0], gustAmp: 4.5, gustTimeS: 0.8 },
        { id: 'banner-b', lengthM: 2.1, drag: 0.075, damping: 0.45, windBase: [1.8, 0.6], gustAmp: 5.2, gustTimeS: 1.1 },
      ],
    },
  };

  const seq = [0, 15, 33, 72, 120, 33, 15, 0];
  const res = seq.map((f) => evaluate(ctx, params, f, 0.25));
  assert.deepEqual(res[0], res[7]);
  assert.deepEqual(res[1], res[6]);
  assert.deepEqual(res[2], res[5]);
  assert.notDeepEqual(res[1].baked.values, res[2].baked.values);
  assert.equal(res[2].readings.trackCount, 2);
});

test('time.bake：非法输入统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => bakeTrajectory({ duration: 0, sampleHz: 30, initialState: [0], step: (s) => s }),
    () => bakeTrajectory({ duration: 1, sampleHz: -10, initialState: [0], step: (s) => s }),
    () => bakeTrajectory({ duration: 1, sampleHz: 30, initialState: [], step: (s) => s }),
    () => queryBakedTable(null, 0.5),
    () => evaluate({ fps: 60 }, { spec: { durationS: -1, sampleHz: 30, tracks: [] } }, 0, 0),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
