// M4 T18 汇总验收测试：6 张观感/大气/着色技术卡契约、零泄露、注册表、架构守卫、跨卡联调及 WebGL2 GPU/CPU 对拍。
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { launchBrowser } from '../host/page/gpu.mjs';
import { startServer } from '../host/page/host.mjs';
import { checkArchitecture } from '../kernel/guard.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { evaluateHeightFog, opticalDepth } from './atmosphere/height-fog/three.js';
import { evaluate as evaluateGradeComp } from './post/grade-cl/comp.mjs';
import { create as createGradeThree } from './post/grade-cl/three.js';
import { create as createLensFx, evaluateLensFx } from './post/lens-fx/three.js';
import { evaluatePxLod } from './shading/px-lod/three.js';
import { evaluateThinLine } from './shading/thin-line/three.js';
import { evaluate as evaluatePostStateCard } from './time/fx-post-state/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const T18_CARDS = [
  { id: 'post.grade-cl', dir: 'post/grade-cl', kind: 'post', livesIn: ['source:three', 'comp'] },
  { id: 'post.lens-fx', dir: 'post/lens-fx', kind: 'post', livesIn: ['source:three'] },
  { id: 'fx.post-state', dir: 'time/fx-post-state', kind: 'time', livesIn: ['data'] },
  { id: 'atmo.height-fog', dir: 'atmosphere/height-fog', kind: 'atmosphere', livesIn: ['source:three'] },
  { id: 'shade.px-lod', dir: 'shading/px-lod', kind: 'shading', livesIn: ['source:three'] },
  { id: 'shade.thin-line', dir: 'shading/thin-line', kind: 'shading', livesIn: ['source:three'] },
];

const readCard = (dir) => JSON.parse(readFileSync(join(HERE, dir, 'card.json'), 'utf8'));

test('T18-1：6 张卡全部通过 validateCard、scanCardLeaks、dataValidators、createCardRegistry 与架构守卫', () => {
  const loaded = [];
  for (const spec of T18_CARDS) {
    const absDir = join(HERE, spec.dir);
    assert.ok(existsSync(join(absDir, 'card.json')), `缺少 ${spec.dir}/card.json`);
    for (const file of readdirSync(absDir)) {
      const text = readFileSync(join(absDir, file), 'utf8');
      assert.deepEqual(scanCardLeaks(text), [], `${spec.id}/${file} 命中泄露门禁`);
    }
    const card = readCard(spec.dir);
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${spec.id} 未过 validateCard`);
    assert.equal(card.id, spec.id);
    assert.equal(card.kind, spec.kind);
    assert.deepEqual(card.livesIn, spec.livesIn);
    assert.ok(card.status.every((s) => ['reproduced', 'measured'].includes(s.level)), `${spec.id} status 应为 reproduced 或 measured`);
    for (const [name, validate] of dataValidators(card)) {
      assert.equal(validate(card.params[name].default), true, `${spec.id} 默认 data 参数 ${name} 未过 schema`);
    }
    resolveParams(card, {});
    loaded.push(card);
  }
  const registry = createCardRegistry(loaded, { nowDate: '2026-11-25', allowReproducedUntilDate: '2026-11-30' });
  for (const spec of T18_CARDS) {
    assert.equal(registry.getCard(spec.id)?.id, spec.id);
    const hit = registry.searchCards({ q: spec.id }).find((r) => r.id === spec.id);
    assert.ok(hit, `注册表应检索到 ${spec.id}`);
  }
  const arch = checkArchitecture(REPO);
  assert.equal(arch.ok, true, `架构守卫发现违例: ${JSON.stringify(arch.problems)}`);
});

test('T18-2：fx.post-state 驱动 post.grade-cl 与 post.lens-fx 全链路联调（静息恒等 vs 撞击激活）', () => {
  const w = 32, h = 24;
  const hdr = new Float32Array(w * h * 4);
  const bloom = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const band = x >= 22 ? 2.4 : 0.25;
      hdr[i] = band; hdr[i + 1] = band * 0.85; hdr[i + 2] = band * 0.7; hdr[i + 3] = 1;
      bloom[i] = 0.6; bloom[i + 1] = 0.35; bloom[i + 2] = 0.15; bloom[i + 3] = 1;
    }
  }
  const stateParams = {
    exposure: 1.0,
    bloom: 0.06,
    ao: 0.9,
    shaft: 1.0,
    god: 0.55,
    ca: 0.006,
    vignette: 0.42,
    fadeInSec: 0.5,
    fadeOutStartSec: 9.0,
    durationSec: 10.0,
    events: [
      { kind: 'pulse', at: 3.0, attack: 0.03, release: 0.25, flash: 1.0, exposure: 0.35, bloom: 0.10, shake: 0.9, kick: 1.1 },
      { kind: 'hit', at: 3.0, amp: 1.0 },
      { kind: 'ring', at: 3.0, duration: 1.2, center: [0.5, 0.5], radius0: 0.08, radiusMax: 0.55, rate: 2.8, strength: 0.024, decay: 0.3, attack: 0.02, widthMin: 0.02, widthFactor: 0.12, squash: 0.9, angleDeg: 10 },
    ],
  };
  const inputs = { fps: '60/1', shot: { in: 0 } };

  // 静息帧 t = 1.5s (帧 90)：lens-fx 精确恒等
  const calm = evaluatePostStateCard(inputs, stateParams, 90, 0).postState;
  const calmLens = evaluateLensFx(hdr, w, h, {
    kick: calm.lens.kick,
    fringe: calm.lens.fringe,
    shake: calm.shake,
    ringStrength: calm.lens.ring.strength,
  });
  let maxCalmDiff = 0;
  for (let i = 0; i < hdr.length; i++) maxCalmDiff = Math.max(maxCalmDiff, Math.abs(calmLens[i] - hdr[i]));
  assert.equal(maxCalmDiff, 0, '静息帧 post.lens-fx 必须精确恒等');

  const calmDisplay = evaluateGradeComp({ color: calmLens, bloom }, {
    exposure: calm.exposure, bloom: calm.bloom, flash: calm.flash, fade: calm.fade,
    vignette: calm.vignette, caBase: calm.ca, shake: calm.shake, grain: 0,
  }, [w, h]);

  // 撞击帧 t = 3.05s (帧 183)：lens-fx 激活 + grade-cl 抬升曝光与泛光闪光
  const impact = evaluatePostStateCard(inputs, stateParams, 183, 0).postState;
  assert.ok(impact.flash > 0.8 && impact.lens.kick > 0.8 && impact.lens.ring.strength > 0.01);
  const impactLens = evaluateLensFx(hdr, w, h, {
    kick: impact.lens.kick,
    fringe: impact.lens.fringe,
    shake: impact.shake,
    ringCenterX: impact.lens.ring.x,
    ringCenterY: impact.lens.ring.y,
    ringRadius: impact.lens.ring.radius,
    ringWidth: impact.lens.ring.width,
    ringStrength: impact.lens.ring.strength,
    ringSquash: impact.lens.ring.squash,
    ringAngleDeg: impact.lens.ring.angleDeg,
  });
  let maxImpactDiff = 0;
  for (let i = 0; i < hdr.length; i++) maxImpactDiff = Math.max(maxImpactDiff, Math.abs(impactLens[i] - hdr[i]));
  assert.ok(maxImpactDiff > 0.05, '撞击帧 post.lens-fx 应产生显著径向扭曲与拖影');

  const impactDisplay = evaluateGradeComp({ color: impactLens, bloom }, {
    exposure: impact.exposure, bloom: impact.bloom, flash: impact.flash, fade: impact.fade,
    vignette: impact.vignette, caBase: impact.ca, shake: impact.shake, grain: 0,
  }, [w, h]);

  let sumCalm = 0, sumImpact = 0;
  for (let i = 0; i < calmDisplay.length; i += 4) {
    sumCalm += calmDisplay[i] + calmDisplay[i + 1] + calmDisplay[i + 2];
    sumImpact += impactDisplay[i] + impactDisplay[i + 1] + impactDisplay[i + 2];
  }
  assert.ok(sumImpact > sumCalm * 1.15, `撞击帧显示亮度应明显高于静息帧: ${sumCalm} -> ${sumImpact}`);

  // Three.js 通道句柄均能接收 fx.post-state 输出
  const gradeHandle = createGradeThree({ THREE, size: [w, h] }, {});
  const lensHandle = createLensFx({ THREE, size: [w, h] }, {});
  gradeHandle.setState(impact);
  lensHandle.setState(impact);
  assert.equal(lensHandle.isActive(), true);
  assert.equal(gradeHandle.uniforms.uExp.value, impact.exposure);
  gradeHandle.dispose();
  lensHandle.dispose();
});

test('T18-3：atmo.height-fog + shade.px-lod + shade.thin-line 近/中/远三距单调行为与能量守恒协同', () => {
  const cam = [0, 18, 0];
  const fovYDeg = 42, viewportHeight = 1080;
  const distances = [8, 90, 420];
  const fogFactors = [];
  const lodWeights = [];
  const lineResults = [];

  for (const d of distances) {
    const wp = [0, 22, -d];
    const fog = evaluateHeightFog([0.8, 0.3, 0.15], wp, cam, { heightScale: 28, mistDensity: 0.0023, airDensity: 0.0006 });
    const lod = evaluatePxLod(0.22, d, { fovYDeg, viewportHeight, fadeStartPx: 1.2, fadeEndPx: 4.5 });
    const line = evaluateThinLine(0.035, d, { fovYDeg, viewportHeight, minPx: 1.24, baseAlpha: 0.85, coveragePower: 1.0 });
    fogFactors.push(opticalDepth(cam, wp, { heightScale: 28, mistDensity: 0.0023, airDensity: 0.0006 }).factor);
    lodWeights.push(lod.weight);
    lineResults.push(line);
    assert.ok(fog.color.every((v) => Number.isFinite(v) && v >= 0));
    assert.ok(Math.abs(line.integratedFlux - line.originalFlux) < 1e-12, `距离 ${d}m 细线通量必须守恒`);
  }

  // 雾效单调增强
  assert.ok(fogFactors[0] < fogFactors[1] && fogFactors[1] < fogFactors[2]);
  // 细节 LOD 近处全显、中距过渡、远处归零
  assert.equal(lodWeights[0], 1.0);
  assert.ok(lodWeights[1] > 0 && lodWeights[1] < 1);
  assert.equal(lodWeights[2], 0.0);
  // 细线近处不夹紧，远距夹紧至 minPx 且 coverage 单调衰减但 > 0（不断线）
  assert.equal(lineResults[0].coverage, 1.0);
  assert.equal(lineResults[2].clampedPx, 1.24);
  assert.ok(lineResults[2].coverage > 0 && lineResults[2].coverage < lineResults[1].coverage);
});

test('T18-4：WebGL2 实渲核验 post.grade-cl（three.js GPU vs comp.mjs CPU <= 1/255）与 post.lens-fx 零强度恒等', async (t) => {
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    t.skip(`无头浏览器不可用，跳过 WebGL2 核验: ${err?.message ?? err}`);
    return;
  }
  const server = await startServer(REPO);
  try {
    const page = await browser.newPage();
    await page.goto(`${server.origin}/`);
    const gpuResult = await page.evaluate(async () => {
      const THREE = await import('three');
      const gradeMod = await import('/beiming/cards/post/grade-cl/three.js');
      const lensMod = await import('/beiming/cards/post/lens-fx/three.js');
      const w = 64, h = 48;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
      if (!gl) return { noWebgl2: true };
      const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
      renderer.setSize(w, h, false);

      // 构造确定性 HDR 渐变 + 边缘图案（bottom-left origin 与 WebGL readPixels 对齐）
      const hdr = new Float32Array(w * h * 4);
      const bloom = new Float32Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const u = (x + 0.5) / w, v = (y + 0.5) / h;
          hdr[i] = 0.05 + 2.8 * u * u;
          hdr[i + 1] = 0.04 + 1.4 * v;
          hdr[i + 2] = 0.08 + 0.9 * (1 - u);
          hdr[i + 3] = 1.0;
          bloom[i] = 0.4 * u; bloom[i + 1] = 0.25 * v; bloom[i + 2] = 0.12; bloom[i + 3] = 1.0;
        }
      }
      const mkTex = (data) => {
        const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
      };
      const tColor = mkTex(hdr);
      const tBloom = mkTex(bloom);

      const grade = gradeMod.create({ THREE, size: [w, h] }, {
        exposure: 1.12, bloom: 0.12, vignette: 0.42, flash: 0.2, fade: 0.95,
        caBase: 0.006, shake: 0.04, grain: 0, time: 0,
      });
      grade.uniforms.tC.value = tColor;
      grade.uniforms.tB.value = tBloom;

      const scene = new THREE.Scene();
      scene.add(grade.object);
      const cam = new THREE.Camera();
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false });
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      const gradePixels = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, gradePixels);

      // 同时验证 post.lens-fx 零强度在 GPU 上恒等
      const lens = lensMod.create({ THREE, size: [w, h] }, { ringStrength: 0, kick: 0, fringe: 0, shake: 0 });
      lens.uniforms.tC.value = tColor;
      const lensScene = new THREE.Scene();
      lensScene.add(lens.object);
      const rtF = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      renderer.setRenderTarget(rtF);
      renderer.render(lensScene, cam);
      const lensOut = new Float32Array(w * h * 4);
      renderer.readRenderTargetPixels(rtF, 0, 0, w, h, lensOut);
      let lensIdentityMax = 0;
      for (let i = 0; i < hdr.length; i++) lensIdentityMax = Math.max(lensIdentityMax, Math.abs(lensOut[i] - hdr[i]));

      grade.dispose(); lens.dispose(); tColor.dispose(); tBloom.dispose(); rt.dispose(); rtF.dispose(); renderer.dispose();
      return { w, h, hdr: Array.from(hdr), bloom: Array.from(bloom), gradePixels: Array.from(gradePixels), lensIdentityMax };
    });

    if (gpuResult.noWebgl2) {
      t.skip('页面环境无 WebGL2 上下文');
      return;
    }
    assert.ok(gpuResult.lensIdentityMax < 1e-5, `GPU post.lens-fx 零强度应恒等: ${gpuResult.lensIdentityMax}`);

    const cpuPixels = evaluateGradeComp(
      { color: new Float32Array(gpuResult.hdr), bloom: new Float32Array(gpuResult.bloom) },
      {
        exposure: 1.12, bloom: 0.12, vignette: 0.42, flash: 0.2, fade: 0.95,
        caBase: 0.006, shake: 0.04, grain: 0, time: 0, origin: 'bottom-left',
      },
      [gpuResult.w, gpuResult.h],
    );
    let maxDiff = 0;
    for (let i = 0; i < cpuPixels.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        maxDiff = Math.max(maxDiff, Math.abs(cpuPixels[i + c] - gpuResult.gradePixels[i + c]));
      }
    }
    assert.ok(maxDiff <= 1, `post.grade-cl CPU vs WebGL2 GPU 最大偏差应 <= 1/255，实测 ${maxDiff}/255`);
  } finally {
    await browser.close();
    await server.close();
  }
});
