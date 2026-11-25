import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import { dataValidators } from './sweep-schema.mjs';
import {
  blendPremultChain,
  composePremultFragment,
  create as createPremult,
} from './particle/premult/three.js';
import {
  computeSoftDepthFade,
  computeSoftViewZ,
  create as createSoft,
} from './particle/soft/three.js';
import {
  compareMinPxStrategies,
  computeMinPxClamp,
  create as createMinPx,
} from './particle/minpx/three.js';
import {
  NOMINAL_DRAG,
  evaluate as evaluateBreath,
  evaluateEmberParticles,
  evaluateFireParticles,
  evaluateSmokeParticles,
} from './particle/fx-breath/index.mjs';
import { create as createBreath } from './particle/fx-breath/three.js';
import { evaluate as evaluateEmitPool, poolEmitters } from './lighting/emit-pool/index.mjs';
import { create as createEmitPool } from './lighting/emit-pool/three.js';
import {
  bakeTrajectory,
  evaluate as evaluateTimeBake,
  queryBakedTable,
  simulateSequentialAt,
} from './time/bake/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = dirname(HERE);

const T20_CARDS = [
  {
    id: 'particle.premult',
    dir: 'particle/premult',
    kind: 'particle',
    livesIn: ['source:three'],
    files: ['card.json', 'selftest.test.mjs', 'three.js'],
  },
  {
    id: 'particle.soft',
    dir: 'particle/soft',
    kind: 'particle',
    livesIn: ['source:three'],
    files: ['card.json', 'selftest.test.mjs', 'three.js'],
  },
  {
    id: 'particle.minpx',
    dir: 'particle/minpx',
    kind: 'particle',
    livesIn: ['source:three'],
    files: ['card.json', 'selftest.test.mjs', 'three.js'],
  },
  {
    id: 'fx.breath',
    dir: 'particle/fx-breath',
    kind: 'particle',
    livesIn: ['data', 'source:three'],
    files: ['card.json', 'index.mjs', 'schema.json', 'selftest.test.mjs', 'three.js'],
  },
  {
    id: 'light.emit-pool',
    dir: 'lighting/emit-pool',
    kind: 'lighting',
    livesIn: ['data', 'source:three'],
    files: ['card.json', 'index.mjs', 'selftest.test.mjs', 'three.js'],
  },
  {
    id: 'time.bake',
    dir: 'time/bake',
    kind: 'time',
    livesIn: ['data'],
    files: ['card.json', 'index.mjs', 'schema.json', 'selftest.test.mjs'],
  },
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('T20-1 全部 6 张技术卡通过 validateCard、scanCardLeaks、createCardRegistry 与 schema 校验', () => {
  const loadedCards = [];
  for (const spec of T20_CARDS) {
    const base = join(HERE, spec.dir);
    assert.ok(existsSync(base), `缺少卡目录: ${spec.dir}`);
    assert.deepEqual(readdirSync(base).sort(), spec.files, `${spec.id} 目录文件集不匹配`);
    for (const file of spec.files) {
      const raw = readFileSync(join(base, file), 'utf8');
      assert.deepEqual(scanCardLeaks(raw), [], `${spec.dir}/${file} 存在泄露`);
    }
    const card = readJson(join(base, 'card.json'));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, spec.id);
    assert.equal(card.id, spec.id);
    assert.equal(card.kind, spec.kind);
    assert.equal(card.visibleToAgent, true);
    assert.deepEqual(card.livesIn, spec.livesIn);
    assert.deepEqual(card.exams, [`cal:${spec.id}`]);
    assert.equal(card.status[0].level, 'reproduced');
    assert.equal(readJson(join(BEIMING, 'calib', card.calibration, 'scene.json')).id, card.calibration);

    const resolved = resolveParams(card, {});
    for (const [paramName, validate] of dataValidators(card)) {
      assert.ok(validate(resolved[paramName]), `${spec.id}.${paramName} 默认值未过 schema: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate({ unexpectedProperty: true }), false, `${spec.id}.${paramName} schema 应拒绝多余字段`);
    }
    loadedCards.push(card);
  }

  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), []);

  const registry = createCardRegistry(loadedCards, { allowReproduced: true });
  for (const spec of T20_CARDS) {
    const diagnostics = [];
    assert.equal(registry.getCard(`${spec.id}@1`)?.id, spec.id);
    const hits = registry.searchCards({ q: spec.id, onDiagnostic: (d) => diagnostics.push(d) });
    assert.ok(hits.some((h) => h.id === spec.id), `检索不到 ${spec.id}`);
    assert.deepEqual(diagnostics, [], `${spec.id} 摘要超出 token 预算`);
  }
});

test('T20-2 全部 6 张技术卡的独立离线自测子进程全部通过', () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  for (const spec of T20_CARDS) {
    const selftestPath = join(HERE, spec.dir, 'selftest.test.mjs');
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', selftestPath], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(run.status, 0, `${spec.id} selftest failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /pass [1-9]/);
  }
});

test('T20-3 fx.breath 闭式重放精度 < 1.0 px 且阻力系数 ±10% 负对照必红（>> 1.0 px）', () => {
  // 构造确定性 1100 粒子主射流、620 余烬、170 烟尘与 7 个代表帧相机序列
  const makeAr = (count, seedOffset) => {
    const arr = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) {
      const x = Math.sin((i + 1 + seedOffset * 997) * 127.1 + 311.7) * 43758.5453;
      arr[i] = x - Math.floor(x);
    }
    return arr;
  };
  const fireAr = makeAr(1100, 11);
  const embAr = makeAr(620, 14);
  const smokeAr = makeAr(170, 114);

  const emP = new Float32Array(12 * 3);
  const emD = new Float32Array(12 * 3);
  const emB = new Float32Array(12);
  for (let k = 0; k < 12; k++) {
    emP[k * 3] = -14 + k * 0.55;
    emP[k * 3 + 1] = 1.8 - k * 0.04;
    emP[k * 3 + 2] = -2.0 + k * 0.12;
    emD[k * 3] = 0.94;
    emD[k * 3 + 1] = 0.14;
    emD[k * 3 + 2] = 0.31;
    emB[k] = k >= 1 && k <= 10 ? 0.92 : 0.25;
  }

  const viewMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -12, -4.5, -52, 1,
  ];
  const projMatrix = [
    1.54, 0, 0, 0,
    0, 2.74, 0, 0,
    0, 0, -1.0002, -1,
    0, 0, -0.60006, 0,
  ];
  const checkFrames = [2796, 2808, 2820, 2838, 2856, 2874, 2882];

  for (const frame of checkFrames) {
    const uTime = frame / 60;
    const state = {
      uTime,
      uRoar: 0.88,
      uLen: 10000.0,
      uBeam: 0.0,
      uReach: 1.95,
      uMouth: [-11.5, 1.8, -1.2],
      uDir: [0.94, 0.14, 0.31],
      aR: fireAr,
      viewMatrix,
      projMatrix,
      viewport: [1920, 1080],
    };

    // 正对照：同批出生属性闭式重放与参考点云（含 float32 属性量化对比）屏幕位置误差 < 1.0 px
    const refCloud = evaluateFireParticles(state, { dragScale: 1.0 });
    const replayCloud = evaluateFireParticles({ ...state, aR: new Float32Array(fireAr) }, { dragScale: 1.0 });
    const posErrPx = Math.hypot(replayCloud.cx - refCloud.cx, replayCloud.cy - refCloud.cy);
    assert.ok(posErrPx < 1.0, `Frame ${frame} positive control error ${posErrPx} >= 1.0 px`);
    assert.equal(posErrPx, 0);

    // 负对照：将阻力系数 k (2.6) 分别改 -10% 与 +10%，全部 7 帧偏移显著突破 1.0 px 门限（必红）
    const dragMinus10 = evaluateFireParticles(state, { dragScale: 0.9 });
    const dragPlus10 = evaluateFireParticles(state, { dragScale: 1.1 });
    const errMinus10 = Math.hypot(dragMinus10.cx - refCloud.cx, dragMinus10.cy - refCloud.cy);
    const errPlus10 = Math.hypot(dragPlus10.cx - refCloud.cx, dragPlus10.cy - refCloud.cy);
    assert.ok(errMinus10 > 20.0, `Frame ${frame} drag -10% shift ${errMinus10} did not trip 1.0 px gate`);
    assert.ok(errPlus10 > 18.0, `Frame ${frame} drag +10% shift ${errPlus10} did not trip 1.0 px gate`);

    // 成熟帧（>= 2820）下余烬 (k=1.1) 与浓烟 (k=2.2) 阻力 ±10% 同样突破 1.0 px
    if (frame >= 2820) {
      const wakeBase = {
        uTime,
        uT0: 46.4,
        uSpan: 2.1,
        uSR: 1.55,
        uSK: [1.2, 0.9, 1.0],
        uFall: [0.6, 1.25],
        emP,
        emD,
        emB,
        viewMatrix,
        projMatrix,
        viewport: [1920, 1080],
      };
      const embStd = evaluateEmberParticles({ ...wakeBase, aR: embAr }, { dragScale: 1.0 });
      const embM10 = evaluateEmberParticles({ ...wakeBase, aR: embAr }, { dragScale: 0.9 });
      const embP10 = evaluateEmberParticles({ ...wakeBase, aR: embAr }, { dragScale: 1.1 });
      assert.ok(Math.hypot(embM10.cx - embStd.cx, embM10.cy - embStd.cy) > 1.5);
      assert.ok(Math.hypot(embP10.cx - embStd.cx, embP10.cy - embStd.cy) > 1.5);

      const smkStd = evaluateSmokeParticles({ ...wakeBase, aR: smokeAr }, { dragScale: 1.0 });
      const smkM10 = evaluateSmokeParticles({ ...wakeBase, aR: smokeAr }, { dragScale: 0.9 });
      const smkP10 = evaluateSmokeParticles({ ...wakeBase, aR: smokeAr }, { dragScale: 1.1 });
      assert.ok(Math.hypot(smkM10.cx - smkStd.cx, smkM10.cy - smkStd.cy) > 10.0);
      assert.ok(Math.hypot(smkP10.cx - smkStd.cx, smkP10.cy - smkStd.cy) > 10.0);
    }
  }
  assert.equal(NOMINAL_DRAG.fire, 2.6);
});

test('T20-4 六张技术卡协同链路：预乘加光遮挡 + 深度软粒子 + 最小像素能量守恒 + 吐息粒子 + 点光池 + 预演烘焙表', () => {
  // 1. time.bake 预演烘焙吐息与风场包络，乱序抽帧逐位一致
  const table = bakeTrajectory({
    t0: 0,
    duration: 2.0,
    sampleHz: 60,
    substeps: 2,
    warmupSteps: 10,
    initialState: [0, 0],
    step([x, v], t, dt) {
      const target = t >= 0.2 && t <= 1.6 ? 1.0 : 0.0;
      const a = 32.0 * (target - x) - 8.5 * v;
      const nv = v + a * dt;
      return [x + nv * dt, nv];
    },
  });
  const tSample = 0.85;
  assert.deepEqual(queryBakedTable(table, tSample, { interpolation: 'linear' }), simulateSequentialAt({
    t0: 0,
    duration: 2.0,
    sampleHz: 60,
    substeps: 2,
    warmupSteps: 10,
    initialState: [0, 0],
    step([x, v], t, dt) {
      const target = t >= 0.2 && t <= 1.6 ? 1.0 : 0.0;
      const a = 32.0 * (target - x) - 8.5 * v;
      const nv = v + a * dt;
      return [x + nv * dt, nv];
    },
  }, tSample));

  // 2. particle.minpx 远距护栏与能量守恒 + particle.soft 软深度衰减 + particle.premult 同批次混合
  const minPxInfo = computeMinPxClamp({ worldSize: 0.03, depth: 300, minPx: 1.5, fovYDeg: 40, viewportHeight: 1080 });
  assert.equal(minPxInfo.clamped, true);
  const strategies = compareMinPxStrategies({ worldSize: 0.03, depth: 300, minPx: 1.5, fovYDeg: 40, viewportHeight: 1080 });
  assert.ok(strategies.uncompensated.energyInflationRatio > 15);
  assert.ok(Math.abs(strategies.correct.energyInflationRatio - 1.0) < 1e-12);

  const softFactor = computeSoftDepthFade(25.0, 23.5, 3.0);
  assert.equal(softFactor, 0.5);
  assert.equal(computeSoftViewZ(-23.5, -25.0, 3.0), 0.5);

  const fireFrag = composePremultFragment([18.0 * softFactor * minPxInfo.energyScale, 8.0 * softFactor * minPxInfo.energyScale, 0.3], [0, 0, 0], 0);
  const smokeFrag = composePremultFragment([0, 0, 0], [0.18, 0.16, 0.15], 0.4 * softFactor);
  const composited = blendPremultChain([0.5, 0.5, 0.5, 1.0], [smokeFrag, fireFrag]);
  assert.ok(composited[0] > 0.5 && composited[3] === 1.0);

  // 3. light.emit-pool 合成多路射流发光体为单盏点光
  const pooled = poolEmitters([
    { position: [-5, 3, 0], color: [1.0, 0.4, 0.1], intensity: 1200, distance: 180 },
    { position: [7, 3, 0], color: [0.4, 0.7, 1.0], intensity: 600, distance: 120 },
  ]);
  assert.equal(pooled.intensity, 1800);
  assert.deepEqual(pooled.position, [-1, 3, 0]);
  assert.equal(pooled.distance, 160);

  // 4. 全部 Three.js 落点 create/apply/meta/dispose 生命周期完备
  const ctx = {
    THREE,
    fps: 60,
    size: [1920, 1080],
    camera: {
      matrixWorldInverse: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -25, 1],
      projectionMatrix: [1.5, 0, 0, 0, 0, 2.6, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0],
    },
  };
  const hPremult = createPremult(ctx, resolveParams(readJson(join(HERE, 'particle/premult/card.json'))));
  const hSoft = createSoft(ctx, resolveParams(readJson(join(HERE, 'particle/soft/card.json'))));
  const hMinPx = createMinPx(ctx, resolveParams(readJson(join(HERE, 'particle/minpx/card.json'))));
  const hBreath = createBreath(ctx, resolveParams(readJson(join(HERE, 'particle/fx-breath/card.json'))));
  const hLight = createEmitPool(ctx, resolveParams(readJson(join(HERE, 'lighting/emit-pool/card.json'))));

  for (const h of [hPremult, hSoft, hMinPx, hBreath, hLight]) {
    h.apply?.(12, 0);
    assert.ok(h.meta(12).readings);
    h.dispose();
  }
  assert.ok(evaluateBreath(ctx, resolveParams(readJson(join(HERE, 'particle/fx-breath/card.json'))), 12, 0).readings.alive >= 0);
  assert.ok(evaluateEmitPool(ctx, resolveParams(readJson(join(HERE, 'lighting/emit-pool/card.json'))), 12, 0).readings);
  assert.ok(evaluateTimeBake(ctx, resolveParams(readJson(join(HERE, 'time/bake/card.json'))), 12, 0).readings.trackCount >= 1);
});
