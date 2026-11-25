// shade.thin-line 自测：细线最小屏幕像素宽夹紧、1D 覆盖率能量守恒、远距不断线与 Three.js 材质构造。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import {
  create,
  createThinLineMaterial,
  evaluateThinLine,
  GLSL_THIN_LINE,
} from './three.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('shade.thin-line：card.json 通过 validateCard 与 scanCardLeaks', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'shade.thin-line');
  assert.equal(card.kind, 'shading');
  assert.deepEqual(card.livesIn, ['source:three']);
});

test('shade.thin-line：近处保持原始线宽且 coverage=1，远处夹紧至 minPx 并严格守恒 1D 能量', () => {
  const opts = { fovYDeg: 45, viewportHeight: 1080, minPx: 1.24, baseAlpha: 0.9, coveragePower: 1.0 };
  const worldWidth = 0.04;

  // 近处：origPx >> minPx
  const near = evaluateThinLine(worldWidth, 2, opts);
  assert.ok(near.origPx > opts.minPx);
  assert.equal(near.clampedPx, near.origPx);
  assert.equal(near.coverage, 1.0);
  assert.ok(Math.abs(near.integratedFlux - near.originalFlux) < 1e-12);

  // 中距与远距：origPx < minPx，强制夹紧到 minPx 且 coverage = origPx / minPx
  const mid = evaluateThinLine(worldWidth, 60, opts);
  const far = evaluateThinLine(worldWidth, 300, opts);
  assert.ok(mid.origPx < opts.minPx && far.origPx < mid.origPx);
  assert.equal(mid.clampedPx, opts.minPx);
  assert.equal(far.clampedPx, opts.minPx);
  assert.ok(far.coverage > 0 && far.coverage < mid.coverage && mid.coverage < 1.0);

  // 一维积分通量 clampedPx * effectiveAlpha === origPx * baseAlpha（能量守恒）
  assert.ok(Math.abs(mid.integratedFlux - mid.originalFlux) < 1e-12, `中距能量不守恒: ${mid.integratedFlux} vs ${mid.originalFlux}`);
  assert.ok(Math.abs(far.integratedFlux - far.originalFlux) < 1e-12, `远距能量不守恒: ${far.integratedFlux} vs ${far.originalFlux}`);
});

test('shade.thin-line：Three.js 材质构造器含最小像素宽护栏着色器与相机同步', () => {
  const mat = createThinLineMaterial(THREE, { minPx: 1.25, color: '#f0e0c0', baseAlpha: 0.85 });
  assert.ok(mat.isShaderMaterial);
  assert.equal(mat.uniforms.uMinPx.value, 1.25);
  assert.match(GLSL_THIN_LINE, /shadeThinLineClamp/);
  assert.match(mat.vertexShader, /shadeThinLineClamp/);
  assert.match(mat.fragmentShader, /vCoverage/);
  mat.dispose();

  const handle = create({ THREE, size: [1920, 1080] }, { minPx: 1.24, worldWidth: 0.03 });
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 2000);
  handle.updateCamera(cam, 1080);
  assert.ok(handle.uniforms.uPxK.value > 0);
  handle.dispose();
});
