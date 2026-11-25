import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import {
  PREMULT_FRAGMENT_GLSL,
  PREMULT_VERTEX_GLSL,
  applyPremultBlending,
  blendPremultChain,
  blendPremultStep,
  composePremultFragment,
  create,
} from './three.js';

const close = (actual, expected, eps = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
};

test('particle.premult：纯加光（alpha_occ=0）完全保留背景且线性叠加自发光能量', () => {
  const frag = composePremultFragment([1.8, 0.9, 0.3], [0.2, 0.2, 0.2], 0);
  assert.deepEqual(frag, [1.8, 0.9, 0.3, 0]);
  const bg = [0.4, 0.5, 0.6, 1.0];
  const out = blendPremultStep(bg, frag);
  close(out[0], 2.2);
  close(out[1], 1.4);
  close(out[2], 0.9);
  close(out[3], 1.0);
});

test('particle.premult：纯烟尘遮挡（emit=0, alpha_occ>0）按 Porter-Duff 线性衰减背景', () => {
  const frag = composePremultFragment([0, 0, 0], [0.2, 0.25, 0.3], 0.6);
  close(frag[0], 0.12);
  close(frag[1], 0.15);
  close(frag[2], 0.18);
  close(frag[3], 0.6);
  const bg = [1.0, 1.0, 1.0, 1.0];
  const out = blendPremultStep(bg, frag);
  // out = smoke * 0.6 + bg * (1 - 0.6)
  close(out[0], 0.52);
  close(out[1], 0.55);
  close(out[2], 0.58);
  close(out[3], 1.0);
});

test('particle.premult：同批次混合加光与烟尘遮挡（rgb_emit + rgb_smoke * alpha_occ, alpha_occ）', () => {
  const fSmoke = composePremultFragment([0, 0, 0], [0.1, 0.1, 0.1], 0.5);
  const fFireGlow = composePremultFragment([2.0, 0.8, 0.2], [0.2, 0.1, 0.1], 0.25);
  const fSpark = composePremultFragment([3.0, 1.5, 0.5], [0, 0, 0], 0);
  const out = blendPremultChain([0.6, 0.6, 0.6, 0.0], [fSmoke, fFireGlow, fSpark]);
  // Step 1 (smoke a=0.5): rgb = 0.05 + 0.6*0.5 = 0.35, a = 0.5
  // Step 2 (fire+smoke a=0.25): src = [2.05, 0.825, 0.225, 0.25], dst*0.75 = [0.2625, 0.2625, 0.2625] -> [2.3125, 1.0875, 0.4875], a = 0.25 + 0.5*0.75 = 0.625
  // Step 3 (spark a=0): +[3.0, 1.5, 0.5, 0] -> [5.3125, 2.5875, 0.9875, 0.625]
  close(out[0], 5.3125);
  close(out[1], 2.5875);
  close(out[2], 0.9875);
  close(out[3], 0.625);
});

test('particle.premult：Three.js ShaderMaterial 构造器与预乘混合状态核对', () => {
  const handle = create({ THREE }, {
    emitColor: '#ff8822',
    smokeColor: '#22262b',
    alphaOcc: 0.35,
    gain: 1.5,
  });
  const { object, material } = handle;
  assert.ok(object.isMesh);
  assert.equal(object.material, material);
  assert.equal(material.premultipliedAlpha, true);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  assert.equal(material.blending, THREE.CustomBlending);
  assert.equal(material.blendSrc, THREE.OneFactor);
  assert.equal(material.blendDst, THREE.OneMinusSrcAlphaFactor);
  assert.equal(material.blendEquation, THREE.AddEquation);
  assert.ok(PREMULT_VERTEX_GLSL.includes('gl_Position'));
  assert.ok(PREMULT_FRAGMENT_GLSL.includes('uEmitColor'));
  assert.ok(PREMULT_FRAGMENT_GLSL.includes('uSmokeColor'));
  const m0 = handle.meta(0);
  const m5 = handle.meta(5);
  assert.deepEqual(m0, m5);
  assert.ok(m0.readings.alphaOcc === 0.35);
  const customMat = applyPremultBlending({}, THREE);
  assert.equal(customMat.premultipliedAlpha, true);
  assert.equal(customMat.blendSrc, THREE.OneFactor);
  assert.equal(customMat.blendDst, THREE.OneMinusSrcAlphaFactor);
  handle.dispose();
});

test('particle.premult：非法参数统一报告 usage.bad-argument', () => {
  for (const badCall of [
    () => composePremultFragment([-1, 0, 0], [0, 0, 0], 0.5),
    () => composePremultFragment([0, 0, 0], [0, 0], 0.5),
    () => composePremultFragment([0, 0, 0], [0, 0, 0], 1.2),
    () => composePremultFragment([0, 0, 0], [0, 0, 0], -0.1),
    () => blendPremultStep([0, 0, 0], [0, 0, 0, 0]),
    () => create({}, { alphaOcc: 2 }),
  ]) {
    assert.throws(badCall, { code: 'usage.bad-argument' });
  }
});
