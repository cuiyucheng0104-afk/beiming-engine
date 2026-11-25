// shade.px-lod 自测：屏幕像素覆盖尺寸公式、近处满权重 1.0、亚像素平滑归 0、多频段与 Three.js 辅助。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import {
  computePxK,
  create,
  evaluatePxLod,
  GLSL_PX_LOD,
  screenFeaturePx,
} from './three.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('shade.px-lod：card.json 通过 validateCard 与 scanCardLeaks', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'shade.px-lod');
  assert.equal(card.kind, 'shading');
  assert.deepEqual(card.livesIn, ['source:three']);
});

test('shade.px-lod：像素覆盖公式精确、近处 1.0、过渡带严格单调、亚像素归 0', () => {
  const fovYDeg = 45;
  const viewportHeight = 1080;
  const worldSize = 0.25;
  const expectedK = (2 * Math.tan((fovYDeg * Math.PI) / 360)) / viewportHeight;
  assert.ok(Math.abs(computePxK(fovYDeg, viewportHeight) - expectedK) < 1e-15);

  const pxAt10 = screenFeaturePx(worldSize, 10, fovYDeg, viewportHeight);
  const expectedPx = (worldSize * viewportHeight) / (2 * 10 * Math.tan((fovYDeg * Math.PI) / 360));
  assert.ok(Math.abs(pxAt10 - expectedPx) < 1e-12);

  const near = evaluatePxLod(worldSize, 5, { fovYDeg, viewportHeight, fadeStartPx: 1.2, fadeEndPx: 4.5 });
  const mid = evaluatePxLod(worldSize, 120, { fovYDeg, viewportHeight, fadeStartPx: 1.2, fadeEndPx: 4.5 });
  const far = evaluatePxLod(worldSize, 600, { fovYDeg, viewportHeight, fadeStartPx: 1.2, fadeEndPx: 4.5 });

  assert.equal(near.weight, 1.0, `近处像素宽 ${near.px} 应满权重保留`);
  assert.ok(mid.weight > 0 && mid.weight < 1, `中距应落在平滑过渡带: px=${mid.px} w=${mid.weight}`);
  assert.equal(far.weight, 0.0, `远距亚像素 (${far.px} px) 应平滑归 0 防摩尔纹`);

  // 过渡带随深度严格单调递减
  let prev = 1.0;
  for (const d of [20, 40, 80, 120, 180, 260, 400]) {
    const w = evaluatePxLod(worldSize, d, { fovYDeg, viewportHeight, fadeStartPx: 1.2, fadeEndPx: 4.5 }).weight;
    assert.ok(w <= prev + 1e-12, `depth=${d} 权重破坏单调性: ${w} > ${prev}`);
    prev = w;
  }
});

test('shade.px-lod：create 支持 updateCamera 同步 uniforms 与 GLSL 片段注入', () => {
  const handle = create({ THREE, size: [1920, 1080] }, { fadeStartPx: 1.2, fadeEndPx: 4.5, worldSize: 0.3 });
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 2000);
  handle.updateCamera(cam, 1080);
  assert.ok(Math.abs(handle.uniforms.uPxK.value - computePxK(40, 1080)) < 1e-12);
  assert.match(GLSL_PX_LOD, /shadePxLod/);
  const mat = new THREE.MeshStandardMaterial();
  handle.patchMaterial(mat);
  assert.equal(typeof mat.onBeforeCompile, 'function');
  handle.dispose();
  mat.dispose();
});
