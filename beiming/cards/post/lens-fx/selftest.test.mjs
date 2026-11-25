// post.lens-fx 自测：全零强度精确恒等（maxAbs = 0）、冲击波环形折射扭曲、径向缩放拖影能量守恒与边缘色散。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import {
  computeLensUv,
  create,
  evaluateLensFx,
  FRAGMENT_SHADER,
  isLensFxActive,
} from './three.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('post.lens-fx：card.json 通过 validateCard 与 scanCardLeaks', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'post.lens-fx');
  assert.equal(card.kind, 'post');
  assert.deepEqual(card.livesIn, ['source:three']);
});

test('post.lens-fx：所有强度为 0 时精确恒等（maxAbs === 0）', () => {
  const w = 24, h = 16;
  const src = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      src[i] = (x + 1) / w;
      src[i + 1] = (y + 1) / h;
      src[i + 2] = ((x ^ y) & 7) / 7;
      src[i + 3] = 1;
    }
  }
  const zeroState = { ringStrength: 0, kick: 0, fringe: 0, shake: 0 };
  assert.equal(isLensFxActive(zeroState), false);
  const out = evaluateLensFx(src, w, h, zeroState);
  let maxAbs = 0;
  for (let i = 0; i < src.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(out[i] - src[i]));
  }
  assert.equal(maxAbs, 0, `零强度必须逐位恒等，maxAbs=${maxAbs}`);
});

test('post.lens-fx：冲击波环形折射扭曲在波前内外产生反向径向偏移并随距离衰减', () => {
  const aspect = 16 / 9;
  const state = {
    ringCenterX: 0.5,
    ringCenterY: 0.5,
    ringRadius: 0.25,
    ringWidth: 0.06,
    ringStrength: 0.04,
    ringSquash: 1.0,
    ringAngleDeg: 0,
    kick: 0,
  };
  assert.equal(isLensFxActive(state), true);
  // 沿 +X 轴取环内、环上、环外三点（距中心屏幕高度坐标分别 0.20, 0.25, 0.30）
  const uIn = 0.5 + 0.20 / aspect;
  const uOn = 0.5 + 0.25 / aspect;
  const uOut = 0.5 + 0.30 / aspect;
  const uFar = 0.5 + 0.70 / aspect;
  const dIn = computeLensUv(uIn, 0.5, aspect, state)[0] - uIn;
  const dOn = computeLensUv(uOn, 0.5, aspect, state)[0] - uOn;
  const dOut = computeLensUv(uOut, 0.5, aspect, state)[0] - uOut;
  const dFar = computeLensUv(uFar, 0.5, aspect, state)[0] - uFar;
  assert.ok(dIn > 1e-4, `波前内侧应向外拉伸: ${dIn}`);
  assert.ok(Math.abs(dOn) < 1e-9, `波前中心偏移为 0: ${dOn}`);
  assert.ok(dOut < -1e-4, `波前外侧应向内挤压: ${dOut}`);
  assert.ok(Math.abs(dFar) < 1e-6, `远离波前衰减至近零: ${dFar}`);
});

test('post.lens-fx：径向拖影对均匀场精确能量守恒，在边缘产生可测径向位移与色差', () => {
  const w = 32, h = 24;
  // 1) 均匀常值场验证径向拖影 + 冲击波 + 色散严格能量守恒
  const flat = new Float32Array(w * h * 4);
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = 1.25; flat[i + 1] = 0.75; flat[i + 2] = 0.40; flat[i + 3] = 1.0;
  }
  const active = {
    ringCenterX: 0.5, ringCenterY: 0.5, ringRadius: 0.22, ringWidth: 0.05, ringStrength: 0.025,
    kick: 1.2, fringe: 0.9, shake: 0.4,
  };
  const flatOut = evaluateLensFx(flat, w, h, active);
  let maxEnergyErr = 0;
  for (let i = 0; i < flat.length; i += 4) {
    maxEnergyErr = Math.max(
      maxEnergyErr,
      Math.abs(flatOut[i] - 1.25),
      Math.abs(flatOut[i + 1] - 0.75),
      Math.abs(flatOut[i + 2] - 0.40),
    );
  }
  assert.ok(maxEnergyErr < 1e-5, `均匀场能量守恒误差过大: ${maxEnergyErr}`);

  // 2) 高对比条纹场验证色散与径向拖影可测（使用 160x90 使边缘 0.005 UV 色差跨越近 1 像素）
  const sw = 160, sh = 90;
  const stripe = new Float32Array(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const v = x >= 140 ? 2.0 : 0.0;
      stripe[i] = v; stripe[i + 1] = v; stripe[i + 2] = v; stripe[i + 3] = 1.0;
    }
  }
  const stripeOut = evaluateLensFx(stripe, sw, sh, active);
  let maxChroma = 0, maxDelta = 0;
  for (let i = 0; i < stripe.length; i += 4) {
    maxChroma = Math.max(maxChroma, Math.abs(stripeOut[i] - stripeOut[i + 2]));
    maxDelta = Math.max(maxDelta, Math.abs(stripeOut[i + 1] - stripe[i + 1]));
  }
  assert.ok(maxChroma > 0.05, `开启 fringe 应产生可测红蓝色散: ${maxChroma}`);
  assert.ok(maxDelta > 0.1, `开启 kick+ring 应产生可测径向位移/拖影: ${maxDelta}`);
});

test('post.lens-fx：create 返回全屏网格通道、支持 setState/apply 与 isActive 判定', () => {
  const handle = create({ THREE, size: [1280, 720] }, {});
  assert.ok(handle.object.isMesh);
  assert.equal(handle.isActive(), false);
  assert.match(FRAGMENT_SHADER, /uRing/);
  assert.match(FRAGMENT_SHADER, /uKick/);
  assert.match(FRAGMENT_SHADER, /uFringe/);
  handle.setState({ kick: 0.85, fringe: 0.6, ringStrength: 0.02, ringRadius: 0.3 });
  assert.equal(handle.isActive(), true);
  assert.equal(handle.uniforms.uKick.value, 0.85);
  assert.equal(handle.uniforms.uFringe.value, 0.6);
  assert.equal(handle.uniforms.uRing.value.w, 0.02);
  handle.dispose();
});
