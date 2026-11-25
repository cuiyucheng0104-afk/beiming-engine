import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SWIM_CONFIG, evaluate, evaluateSwimStations, swimOffsetAt } from './index.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (eps=${eps})`);

test('amplitude 为 0 时游动波偏移精确归零', () => {
  const state = {
    time: 42.5,
    headS: 800,
    speed: 25,
    bodyLength: 172,
    amplitude: 0,
    calm: 1,
    stir: 0.8,
  };
  for (const a of [0, 20, 60, 120, 172]) {
    const res = swimOffsetAt(a, [0, 0, -1], state);
    assert.deepEqual(res.offset, [0, 0, 0]);
    assert.equal(res.lateral, 0);
    assert.equal(res.heave, 0);
  }
  const out = evaluate({ time: 42.5, fps: 60 }, {
    config: DEFAULT_SWIM_CONFIG,
    amplitude: 0,
    calm: 1,
    stir: 0.8,
    phaseDeg: 0,
    bodyLength: 172,
    speed: 25,
    headS: 800,
    sPhase: 0,
  });
  assert.equal(out.readings.maxOffsetM, 0);
  assert.ok(out.swim.stations.every((st) => st.offset[0] === 0 && st.offset[1] === 0 && st.offset[2] === 0));
});

test('行波沿弧长向后传播、头尾包络递增且侧摆/起伏与切线正交', () => {
  const baseState = {
    time: 10,
    headS: 300,
    speed: 20,
    bodyLength: 172,
    amplitude: 1,
    calm: 1,
    stir: 0,
  };
  const tan = [0.6, 0.2, 0.7745966692414834];
  const head = swimOffsetAt(0, tan, baseState);
  assert.deepEqual(head.offset, [0, 0, 0]);

  const mid = swimOffsetAt(45, tan, baseState);
  const tail = swimOffsetAt(150, tan, baseState);
  assert.ok(tail.envelope > mid.envelope, '尾部包络应大于躯干中段');
  const dot = mid.offset[0] * tan[0] + mid.offset[1] * tan[1] + mid.offset[2] * tan[2];
  close(dot, 0, 1e-12);

  // Wave phase propagates backward: advancing time by dt shifts phase negatively
  const later = swimOffsetAt(45, tan, { ...baseState, time: 11, headS: 320 });
  assert.ok(later.phaseRad < mid.phaseRad, '行波相位应随时间与前行弧长向尾部传播');
});

test('近竖直切线与静默区平滑归零，防止奇异翻折', () => {
  const state = { time: 5, headS: 100, speed: 15, bodyLength: 172, amplitude: 1, calm: 1, stir: 0.5 };
  const vertical = swimOffsetAt(60, [0, 1, 0], state);
  assert.deepEqual(vertical.offset, [0, 0, 0]);
  assert.equal(vertical.levelFactor, 0);

  const quiet = swimOffsetAt(60, [1, 0, 0], { ...state, quiet: 1 });
  assert.deepEqual(quiet.offset, [0, 0, 0]);

  const active = swimOffsetAt(60, [1, 0, 0], { ...state, quiet: 0 });
  const activeNoStir = swimOffsetAt(60, [1, 0, 0], { ...state, quiet: 0, stir: 0 });
  assert.notDeepEqual(active.offset, activeNoStir.offset);
});

test('纯函数乱序抽帧逐位一致', () => {
  const stations = Array.from({ length: 25 }, (_, i) => ({ s: i * 6, tan: [0.3, 0.1, -0.9486832980505138] }));
  const params = {
    config: DEFAULT_SWIM_CONFIG,
    amplitude: 1,
    calm: 0.9,
    stir: 0.4,
    phaseDeg: 35,
    bodyLength: 150,
    speed: 24,
    headS: 400,
    sPhase: 12,
  };
  const run = (f) => evaluate({ fps: 60, stations }, params, f, 0.5);
  const frames = [0, 12, 37, 89, 140];
  const baseline = frames.map(run);
  for (const idx of [3, 0, 4, 2, 1]) assert.deepEqual(run(frames[idx]), baseline[idx]);

  const batch = evaluateSwimStations(stations, { time: 1.5, headS: 400, speed: 24, bodyLength: 150 });
  assert.equal(batch.length, stations.length);
});

test('非法参数统一报告 usage.bad-argument', () => {
  for (const call of [
    () => swimOffsetAt(-1, [1, 0, 0], { time: 0, headS: 0, speed: 10, bodyLength: 100 }),
    () => swimOffsetAt(10, [0, 0, 0], { time: 0, headS: 0, speed: 10, bodyLength: 100 }),
    () => swimOffsetAt(10, [1, 0, 0], { time: 0, headS: 0, speed: 10, bodyLength: 100, amplitude: -1 }),
    () => evaluate(null, { config: DEFAULT_SWIM_CONFIG }),
    () => evaluate({ fps: 60 }, { config: { ...DEFAULT_SWIM_CONFIG, wavelength: 0 } }),
  ]) {
    assert.throws(call, { code: 'usage.bad-argument' });
  }
});
