import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import {
  SOFT_DEPTH_GLSL,
  computeSoftDepthFade,
  computeSoftViewZ,
  create,
  linearizePerspectiveDepth,
  sampleSoftViewZ,
} from './three.js';

const close = (actual, expected, eps = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

test('particle.soft：正线性深度与负视图 Z 下的软粒子淡出严格等价且在近界平滑归零', () => {
  // 粒子在表面前 3m，softness=3m -> 满透明度 1.0
  close(computeSoftDepthFade(15, 12, 3), 1.0);
  close(computeSoftViewZ(-12, -15, 3), 1.0);
  // 粒子在表面前 1.2m，softness=3m -> 0.4
  close(computeSoftDepthFade(15, 13.8, 3), 0.4);
  close(computeSoftViewZ(-13.8, -15, 3), 0.4);
  // 粒子与表面重合 -> 0
  close(computeSoftDepthFade(15, 15, 3), 0.0);
  close(computeSoftViewZ(-15, -15, 3), 0.0);
  // 粒子穿入表面后方 -> 钳制为 0
  close(computeSoftDepthFade(15, 17, 3), 0.0);
  close(computeSoftViewZ(-17, -15, 3), 0.0);
});

test('particle.soft：透视深度缓冲 [0, 1] 反解线性深度与二维视口软深度采样', () => {
  const near = 0.3;
  const far = 4000;
  const atNear = linearizePerspectiveDepth(0, near, far);
  const atFar = linearizePerspectiveDepth(1, near, far);
  close(atNear.sceneDepth, near, 1e-9);
  close(atNear.sceneViewZ, -near, 1e-9);
  close(atFar.sceneDepth, far, 1e-9);
  close(atFar.sceneViewZ, -far, 1e-9);

  // 4x4 视图 Z 缓冲采样（负值）
  const vz = new Float32Array(16).fill(-20);
  vz[1 * 4 + 2] = -10; // (x=2, y=1) 处有近景遮挡物 viewZ = -10
  close(sampleSoftViewZ(vz, 0, 4, 4, 2.3, 1.7, -8.5, 3.0), 0.5);
  close(sampleSoftViewZ(vz, 0, 4, 4, 2.3, 1.7, -11.0, 3.0), 0.0);
  close(sampleSoftViewZ(vz, 0, 4, 4, 0.5, 0.5, -8.5, 3.0), 1.0);
});

test('particle.soft：Three.js 材质构造器、GLSL 模块与乱序帧求值一致', () => {
  const handle = create({ THREE, size: [1920, 1080] }, {
    softnessM: 2.5,
    nearM: 0.3,
    farM: 4000,
  });
  const { object, material } = handle;
  assert.ok(object.isMesh);
  assert.equal(object.material, material);
  assert.ok(SOFT_DEPTH_GLSL.includes('softZ'));
  assert.ok(SOFT_DEPTH_GLSL.includes('sceneZ'));
  assert.equal(material.uniforms.uSoftness.value, 2.5);
  assert.equal(material.uniforms.uNear.value, 0.3);
  assert.equal(material.uniforms.uFar.value, 4000);
  assert.deepEqual(handle.meta(10), handle.meta(0));
  handle.dispose();
});

test('particle.soft：非法参数统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => computeSoftDepthFade(10, 8, 0),
    () => computeSoftDepthFade(10, 8, -1),
    () => computeSoftViewZ(-8, -10, NaN),
    () => linearizePerspectiveDepth(0.5, 10, 5),
    () => linearizePerspectiveDepth(1.5, 0.1, 100),
    () => create({ THREE }, { softnessM: 0 }),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
