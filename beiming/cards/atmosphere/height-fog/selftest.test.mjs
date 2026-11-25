// atmo.height-fog 自测：解析指数高度雾积分、水平射线泰勒防除零连续性、单调衰减、高度分层与太阳内散射着色。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import {
  create,
  evaluateHeightFog,
  GLSL_HEIGHT_FOG,
  henyeyGreenstein,
  opticalDepth,
} from './three.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('atmo.height-fog：card.json 通过 validateCard 与 scanCardLeaks', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'atmo.height-fog');
  assert.equal(card.kind, 'atmosphere');
  assert.deepEqual(card.livesIn, ['source:three']);
});

test('atmo.height-fog：水平射线 |k*dy| -> 0 泰勒展开无奇异且与解析极限连续一致', () => {
  const params = { heightScale: 28, mistDensity: 0.0023, airDensity: 0.0006 };
  const exact = opticalDepth([0, 20, 0], [0, 20, -200], params);
  const expectedMist = 0.0023 * 200 * Math.exp(-20 / 28);
  assert.ok(Number.isFinite(exact.mist) && Math.abs(exact.mist - expectedMist) < 1e-12);

  // 极小俯仰角（±1e-6, ±1e-4, ±1e-2）应平滑逼近水平极限，无 NaN 或跳变
  for (const eps of [-1e-6, -1e-4, -1e-2, 1e-6, 1e-4, 1e-2]) {
    const res = opticalDepth([0, 20, 0], [0, 20 + eps, -200], params);
    assert.ok(Number.isFinite(res.total) && res.total > 0);
    assert.ok(Math.abs(res.mist - expectedMist) < 1e-3, `eps=${eps} 处连续性超差: ${res.mist} vs ${expectedMist}`);
  }
});

test('atmo.height-fog：随距离严格单调增强、低海拔雾浓于高海拔，且与数值积分吻合', () => {
  const params = { heightScale: 28, mistDensity: 0.0023, airDensity: 0.0006 };
  const cam = [0, 15, 0];
  const near = opticalDepth(cam, [0, 25, -30], params);
  const mid = opticalDepth(cam, [0, 45, -180], params);
  const far = opticalDepth(cam, [0, 90, -600], params);
  assert.ok(near.factor < mid.factor && mid.factor < far.factor, '雾因子必须随距离严格单调递增');
  assert.ok(near.factor >= 0 && far.factor < 1);

  // 低谷雾浓度 > 高空雾浓度
  const low = opticalDepth([0, 5, 0], [0, 5, -200], params);
  const high = opticalDepth([0, 120, 0], [0, 120, -200], params);
  assert.ok(low.mist > high.mist * 10, `低谷雾应远浓于高空: low=${low.mist} high=${high.mist}`);

  // 与中点黎曼数值积分核对解析解精度
  const p0 = [0, 12, 0], p1 = [0, 68, -240];
  const analytic = opticalDepth(p0, p1, params).mist;
  const N = 2000;
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  let numeric = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const y = p0[1] + (p1[1] - p0[1]) * t;
    numeric += 0.0023 * Math.exp(-y / 28) * (L / N);
  }
  assert.ok(Math.abs(analytic - numeric) / analytic < 1e-6, `解析积分与数值积分偏差过大: ${analytic} vs ${numeric}`);
});

test('atmo.height-fog：迎太阳前向散射比背光方向更暖更亮（power 与 HG 双相位）', () => {
  const sunDir = [0, 0.3, -0.953939];
  const base = [0.05, 0.05, 0.05];
  const cam = [0, 20, 0];
  const towardSun = evaluateHeightFog(base, [0, 80, -200], cam, { sunDir, phaseMode: 'power' });
  const awaySun = evaluateHeightFog(base, [0, 80, 200], cam, { sunDir, phaseMode: 'power' });
  assert.ok(towardSun.color[0] > awaySun.color[0] + 0.05, '迎太阳方向雾色红通道应显著更亮');
  assert.ok(towardSun.color[0] / towardSun.color[2] > awaySun.color[0] / awaySun.color[2], '迎太阳方向雾色应更暖');

  assert.ok(henyeyGreenstein(0.95, 0.65) > henyeyGreenstein(-0.5, 0.65) * 10);
  const hgToward = evaluateHeightFog(base, [0, 80, -200], cam, { sunDir, phaseMode: 'hg', hgG: 0.65 });
  const hgAway = evaluateHeightFog(base, [0, 80, 200], cam, { sunDir, phaseMode: 'hg', hgG: 0.65 });
  assert.ok(hgToward.color[0] > hgAway.color[0], 'HG 相位迎太阳前向散射应更亮');
});

test('atmo.height-fog：create 提供 uniforms、GLSL 片段与材质 patchMaterial 能力', () => {
  const handle = create({ THREE }, { heightScale: 30, mistDensity: 0.0025, airDensity: 0.0005 });
  assert.ok(handle.uniforms.uFogParams);
  assert.match(GLSL_HEIGHT_FOG, /atmoHeightFog/);
  const mat = new THREE.MeshStandardMaterial();
  handle.patchMaterial(mat);
  assert.equal(typeof mat.onBeforeCompile, 'function');
  handle.dispose();
  mat.dispose();
});
