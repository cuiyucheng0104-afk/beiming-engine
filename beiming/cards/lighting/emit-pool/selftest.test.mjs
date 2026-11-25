import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import { evaluate, poolEmitters } from './index.mjs';
import { applyPooledLight, create } from './three.js';

const close = (actual, expected, eps = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

test('light.emit-pool：多发光体按辐射强度加权合成质心位置、线性颜色、总强度与作用距离', () => {
  const emitters = [
    { position: [0, 10, 0], color: [1.0, 0.4, 0.1], intensity: 600, distance: 150 },
    { position: [30, 40, -15], color: [0.4, 1.0, 0.7], intensity: 300, distance: 240 },
  ];
  const pooled = poolEmitters(emitters);
  assert.equal(pooled.activeCount, 2);
  close(pooled.intensity, 900);
  // 权重 2/3 与 1/3
  close(pooled.position[0], 10);
  close(pooled.position[1], 20);
  close(pooled.position[2], -5);
  close(pooled.color[0], 0.8);
  close(pooled.color[1], 0.6);
  close(pooled.color[2], 0.3);
  close(pooled.distance, 180);
});

test('light.emit-pool：零发光或负强度输入安全退化为零强度且不产生 NaN', () => {
  for (const list of [
    [],
    [{ position: [5, 6, 7], color: [1, 0.5, 0.2], intensity: 0, distance: 120 }],
    [{ position: [5, 6, 7], color: [1, 0.5, 0.2], intensity: 1e-7, distance: 120 }],
  ]) {
    const out = poolEmitters(list, { fallbackPosition: [1, 2, 3], fallbackColor: [1, 0.38, 0.1], defaultRangeM: 150 });
    assert.equal(out.intensity, 0);
    assert.equal(out.activeCount, 0);
    assert.deepEqual(out.position, [1, 2, 3]);
    assert.deepEqual(out.color, [1, 0.38, 0.1]);
    assert.equal(out.distance, 150);
  }
});

test('light.emit-pool：data 落点 evaluate 与 source:three 落点 PointLight 状态同步', () => {
  const ctx = {
    fps: 60,
    emitters: [
      { position: [4, 2, -6], color: [1.0, 0.5, 0.1], intensity: 400, distance: 160 },
      { position: [8, 6, -2], color: [0.6, 0.9, 1.0], intensity: 400, distance: 200 },
    ],
  };
  const params = {
    defaultRangeM: 150,
    decay: 1.7,
    minIntensity: 1e-4,
    intensityScale: 1.0,
    baseColor: '#ff611a',
  };
  const ev0 = evaluate(ctx, params, 10, 0);
  const ev1 = evaluate(ctx, params, 10, 0);
  assert.deepEqual(ev0, ev1);
  close(ev0.light.intensity, 800);
  assert.deepEqual(ev0.light.position, [6, 4, -4]);
  close(ev0.light.distance, 180);

  const handle = create({ THREE, ...ctx }, params);
  assert.ok(handle.object.isPointLight);
  handle.apply(10, 0);
  close(handle.object.intensity, 800);
  close(handle.object.distance, 180);
  close(handle.object.decay, 1.7);
  close(handle.object.position.x, 6);
  close(handle.object.position.y, 4);
  close(handle.object.position.z, -4);
  const m10 = handle.meta(10);
  assert.equal(m10.readings.activeCount, 2);
  assert.equal(m10.readings.intensity, 800);

  // 切换到静默无光帧时安全归零
  applyPooledLight(handle.object, poolEmitters([]), THREE);
  assert.equal(handle.object.intensity, 0);
  handle.dispose();
});

test('light.emit-pool：非法参数统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => poolEmitters('not-an-array'),
    () => poolEmitters([{ position: [0, 0], color: [1, 1, 1], intensity: 10 }]),
    () => poolEmitters([{ position: [0, 0, 0], color: [-1, 1, 1], intensity: 10 }]),
    () => poolEmitters([{ position: [0, 0, 0], color: [1, 1, 1], intensity: -5 }]),
    () => create({ THREE }, { defaultRangeM: 0 }),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
