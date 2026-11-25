import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import {
  MINPX_VERTEX_GLSL,
  compareMinPxStrategies,
  computeMinPxClamp,
  create,
  pixelWorldFactor,
} from './three.js';

const close = (actual, expected, eps = 1e-11) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

test('particle.minpx：透视投影正确最小像素尺寸公式与远距能量守恒 (origPx/clampedPx)^2', () => {
  const fovYDeg = 40;
  const viewportHeight = 1080;
  const minPx = 1.5;
  const pxK = pixelWorldFactor(fovYDeg, viewportHeight);
  close(pxK, (2 * Math.tan((40 * Math.PI) / 360)) / 1080);

  // 近处（depth = 5m，worldSize = 0.2m）：投影像素远大于 1.5px，不触发钳制，能量补偿系数为 1
  const near = computeMinPxClamp({ worldSize: 0.2, depth: 5, minPx, fovYDeg, viewportHeight });
  assert.equal(near.clamped, false);
  close(near.clampedPx, near.origPx);
  close(near.clampedWorldSize, 0.2);
  close(near.energyScale, 1.0);

  // 远处（depth = 400m，worldSize = 0.05m）：原始像素 < 1.5px，触发最小像素护栏且总辐射能量严格守恒
  const far = computeMinPxClamp({ worldSize: 0.05, depth: 400, minPx, fovYDeg, viewportHeight });
  assert.equal(far.clamped, true);
  assert.ok(far.origPx < minPx);
  close(far.clampedPx, minPx);
  close(far.minWorldSize, minPx * 400 * pxK);
  close(far.clampedWorldSize, far.minWorldSize);
  close(far.energyScale, (far.origPx / far.clampedPx) ** 2);
  // 面积 × 衰减后的单位面积亮度 === 原始面积 × 1.0（严格守恒，防止远处一片白雾过曝）
  close(far.conservedEnergy, far.origPx ** 2);
});

test('particle.minpx：对比错误反例写法（写死深度常数 + 未补偿或仅一维线性衰减导致远距过曝与分辨率失配）', () => {
  const cmp = compareMinPxStrategies({
    worldSize: 0.04,
    depth: 500,
    minPx: 1.5,
    fovYDeg: 75,
    viewportHeight: 2160,
    magicDepthRatio: 0.00062,
  });
  // 正确写法屏幕尺寸恒等于 minPx = 1.5 px，且能量过曝比 = 1.0
  close(cmp.correct.clampedPx, 1.5);
  close(cmp.correct.energyInflationRatio, 1.0);
  // 未补偿写法在 500m 处能量暴涨 (clampedPx / origPx)^2 >> 10 倍
  assert.ok(cmp.uncompensated.energyInflationRatio > 10, `uncompensated inflation=${cmp.uncompensated.energyInflationRatio}`);
  // 仅一维线性衰减 (origPx / clampedPx)^1 在二维粒子上仍过曝 clampedPx / origPx > 3 倍
  assert.ok(cmp.linearOnly.energyInflationRatio > 3, `linearOnly inflation=${cmp.linearOnly.energyInflationRatio}`);
  // 写死 -mv.z * 0.00062 常数在 65° FOV、4K 视口下偏离目标 minPx
  assert.ok(Math.abs(cmp.hardcodedMagic.actualPx - 1.5) > 0.5);
});

test('particle.minpx：Three.js 材质构造器、GLSL 函数与视口自适应更新', () => {
  const handle = create({ THREE, size: [1920, 1080] }, {
    minPx: 1.25,
    fovYDeg: 45,
    baseSizeM: 0.08,
  });
  const { object, material } = handle;
  assert.ok(object.isMesh);
  assert.equal(object.material, material);
  assert.ok(MINPX_VERTEX_GLSL.includes('minPxWorldSize'));
  assert.equal(material.uniforms.uMinPx.value, 1.25);
  close(material.uniforms.uPxK.value, pixelWorldFactor(45, 1080));
  assert.deepEqual(handle.meta(3), handle.meta(0));
  handle.dispose();
});

test('particle.minpx：非法参数统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => pixelWorldFactor(0, 1080),
    () => pixelWorldFactor(180, 1080),
    () => pixelWorldFactor(40, 0),
    () => computeMinPxClamp({ worldSize: -1, depth: 10, minPx: 1, fovYDeg: 40, viewportHeight: 1080 }),
    () => computeMinPxClamp({ worldSize: 0.1, depth: 0, minPx: 1, fovYDeg: 40, viewportHeight: 1080 }),
    () => create({ THREE }, { minPx: -0.5 }),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
