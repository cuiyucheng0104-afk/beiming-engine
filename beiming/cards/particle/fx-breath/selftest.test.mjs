import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import {
  NOMINAL_DRAG,
  closedFormDragDistance,
  evaluate,
  evaluateEmberParticles,
  evaluateFireParticles,
  evaluateSmokeParticles,
  jetBasis,
} from './index.mjs';
import { BREATH_FRAGMENT_GLSL, BREATH_VERTEX_GLSL, create } from './three.js';

const close = (actual, expected, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

const sampleViewMatrix = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  -12, -4.5, -52, 1,
];
const sampleProjMatrix = [
  1.5, 0, 0, 0,
  0, 2.6666667, 0, 0,
  0, 0, -1.0002, -1,
  0, 0, -0.60006, 0,
];

test('fx.breath：闭式指数阻尼位移公式、正交基构造与弱阻尼连续性', () => {
  assert.deepEqual(NOMINAL_DRAG, { fire: 2.6, emb: 1.1, smoke: 2.2 });
  const v0 = 70;
  const age = 0.5;
  const k = 2.6;
  close(closedFormDragDistance(v0, age, k), (v0 * (1 - Math.exp(-age * k))) / k, 1e-12);
  close(closedFormDragDistance(v0, 0, k), 0, 1e-12);
  close(closedFormDragDistance(v0, age, 0), v0 * age, 1e-12);

  const basis = jetBasis([0, 0, 1]);
  close(Math.hypot(...basis.dir), 1);
  close(Math.hypot(...basis.up), 1);
  close(Math.hypot(...basis.right), 1);
  close(basis.dir[0] * basis.up[0] + basis.dir[1] * basis.up[1] + basis.dir[2] * basis.up[2], 0, 1e-6);
});

test('fx.breath：主射流、余烬与烟尘三层闭式粒子求值与阻力 ±10% 质心偏移显著突破 1.0 px', () => {
  const n = 120;
  const aR = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    aR[i * 4] = ((i * 17 + 3) % n) / n;
    aR[i * 4 + 1] = ((i * 29 + 7) % n) / n;
    aR[i * 4 + 2] = ((i * 43 + 11) % n) / n;
    aR[i * 4 + 3] = ((i * 61 + 19) % n) / n;
  }
  const baseState = {
    uTime: 47.2,
    uRoar: 0.85,
    uLen: 33.0,
    uBeam: 0.0,
    uReach: 1.95,
    uMouth: [-12.0, 2.0, 0.0],
    uDir: [0.96, 0.12, 0.25],
    aR,
    viewMatrix: sampleViewMatrix,
    projMatrix: sampleProjMatrix,
    viewport: [1920, 1080],
  };

  const std = evaluateFireParticles(baseState, { dragScale: 1.0 });
  const replay = evaluateFireParticles(baseState, { dragScale: 1.0 });
  assert.ok(std.count > 80);
  // 同参数复算屏幕误差严格为 0 (< 1.0 px)
  close(Math.hypot(std.cx - replay.cx, std.cy - replay.cy), 0, 1e-12);

  // 阻力系数 -10% 与 +10% 负对照：屏幕质心偏移远大于 1.0 px 门限
  const minus10 = evaluateFireParticles(baseState, { dragScale: 0.9 });
  const plus10 = evaluateFireParticles(baseState, { dragScale: 1.1 });
  const shiftMinus = Math.hypot(minus10.cx - std.cx, minus10.cy - std.cy);
  const shiftPlus = Math.hypot(plus10.cx - std.cx, plus10.cy - std.cy);
  assert.ok(shiftMinus > 15.0, `Expected -10% drag shift > 15px, got ${shiftMinus}`);
  assert.ok(shiftPlus > 12.0, `Expected +10% drag shift > 12px, got ${shiftPlus}`);

  // 尾流采样表（12 段）驱动余烬与烟尘
  const emP = new Float32Array(12 * 3);
  const emD = new Float32Array(12 * 3);
  const emB = new Float32Array(12);
  for (let k = 0; k < 12; k++) {
    emP[k * 3] = -12 + k * 0.4;
    emP[k * 3 + 1] = 2.0;
    emP[k * 3 + 2] = 0.0;
    emD[k * 3] = 0.96;
    emD[k * 3 + 1] = 0.12;
    emD[k * 3 + 2] = 0.25;
    emB[k] = 0.9;
  }
  const wakeState = {
    uTime: 47.6,
    uT0: 46.4,
    uSpan: 2.1,
    uSR: 1.55,
    uSK: [1.2, 0.9, 1.0],
    uFall: [0.6, 1.25],
    emP,
    emD,
    emB,
    aR,
    viewMatrix: sampleViewMatrix,
    projMatrix: sampleProjMatrix,
    viewport: [1920, 1080],
  };
  const emb = evaluateEmberParticles(wakeState);
  const smk = evaluateSmokeParticles(wakeState);
  assert.ok(emb.count > 0 && Number.isFinite(emb.cx));
  assert.ok(smk.count > 0 && Number.isFinite(smk.cx));
});

test('fx.breath：data 落点 evaluate 随机帧序逐位一致与 source:three 落点 create 组合三张子卡', () => {
  const ctx = {
    fps: 60,
    size: [1920, 1080],
    camera: {
      matrixWorldInverse: sampleViewMatrix,
      projectionMatrix: sampleProjMatrix,
    },
  };
  const params = {
    spec: {
      count: 64,
      seed: 11,
      mouth: [-8, 1.5, 0],
      direction: [0.95, 0.1, 0.29],
      roar: 0.9,
      beam: 0,
      beamLengthM: 30,
      reach: 1.4,
      drag: 2.6,
      speedMps: 70,
    },
  };
  const order = [24, 5, 48, 0, 24, 5];
  const outputs = order.map((f) => evaluate(ctx, params, f, 0));
  assert.deepEqual(outputs[0], outputs[4]);
  assert.deepEqual(outputs[1], outputs[5]);
  assert.notDeepEqual(outputs[0].particles[0].world, outputs[1].particles[0].world);

  const handle = create({ THREE, size: [1920, 1080], fps: 60 }, params);
  assert.ok(handle.object.isGroup || handle.object.isMesh);
  assert.ok(BREATH_VERTEX_GLSL.includes('minPxWorldSize'));
  assert.ok(BREATH_FRAGMENT_GLSL.includes('softZ'));
  assert.equal(handle.material.premultipliedAlpha, true);
  handle.apply(24, 0);
  const m24 = handle.meta(24);
  handle.apply(5, 0);
  handle.apply(24, 0);
  assert.deepEqual(handle.meta(24), m24);
  handle.dispose();
});

test('fx.breath：非法输入统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => closedFormDragDistance(10, -1, 2.6),
    () => closedFormDragDistance(10, 1, -0.5),
    () => jetBasis([0, 0, 0]),
    () => evaluate({ fps: 60, size: [1920, 1080] }, { spec: { count: 0 } }, 0, 0),
    () => create({ THREE }, { spec: { drag: -1 } }),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
