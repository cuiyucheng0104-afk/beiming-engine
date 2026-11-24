// T16：四张 M3 桥接与后处理/音频/机制技术卡（asset.glb-bridge、overlay.anchored、audio.drums、blur.subframe）的汇总验收：
//   一、C1 契约校验与零泄漏扫描：四张卡的 card.json 全部通过 validateCard，卡目录内所有文件及本测试通过 scanCardLeaks；
//   二、C2 注册表、可见性、默认参数 schema 与五项成卡标准：前三张对做题代理可见且摘要零截断，blur.subframe（mechanism，visibleToAgent=false）对 searchCards 隐藏但 getCard 可取；
//   三、M3 跨卡端到端桥接链路（01-2 / 27-1 / 07-1）：
//       1) asset.glb-bridge 经 resolveParams(card, { glb }) 正式入口解析并装载多零件层级 GLB（mount -> blade 与 body/fan_L/fan_R），100% 保留父子层级、原始顶点、PBR 材质与世界坐标；
//       2) overlay.anchored 从每帧 meta/0.1 的实体像素锚点与包围盒排版引线与标签框，复用 overlay.title 绘制文字字形，相机运动时标注自动跟随；
//       3) audio.drums 以纯函数在 48000 Hz 下按节拍网格或帧落点合成底鼓、军鼓、踩镲与机械重音立体声，事件表严格通过 EV1 (frame, id) 校验；
//       4) blur.subframe 兼容真实页面宿主 ctx 与镜头局部首帧 apply(0, 0)、即时消费复用读回缓冲、对齐 shutterSubs 默认快门相位，且在切点后首帧硬钳制快门窗口（跨镜头重影严格为 0，关闭钳制负对照测出 50% 重影）；
//   四、L2 纯函数门（顺序 / 逆序 / 单帧逐位一致）与常规坏参数校验（非法类型、越界索引、损坏 GLB、NaN 一律报 usage.bad-argument）。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three-webgpu';
import { GLTFLoader } from 'three-webgpu/addons/loaders/GLTFLoader.js';
import { checks as eventChecks } from '../kernel/contracts/events/check.mjs';
import { shutterSubs } from '../kernel/eval/time.mjs';
import { buildSyntheticGlb, create as createGlbBridge, inspectGlb, verifyPartNames } from './asset/glb-bridge/index.mjs';
import { create as createDrums, renderDrums, SAMPLE_RATE, synthesizeVoice, VOICE_NAMES } from './audio/drums/index.mjs';
import { createCardRegistry, resolveParams, scanCardLeaks, validateCard } from './index.mjs';
import {
  accumulateLinear,
  create as createBlurSubframe,
  measureCutGhosting,
  renderSubframeBlur,
  subframeTimes,
} from './mechanism/blur-subframe/index.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { create as createOverlayAnchored, resolveAnchorPoint } from './two-d/overlay-anchored/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = dirname(HERE);

const T16_SPEC = {
  'asset.glb-bridge': {
    dir: 'asset/glb-bridge',
    kind: 'asset',
    visibleToAgent: true,
    livesIn: ['source:three'],
    calibration: 'probe-axes-turntable',
    exams: ['1-2', 'cal:asset.glb-bridge'],
  },
  'overlay.anchored': {
    dir: 'two-d/overlay-anchored',
    kind: 'two-d',
    visibleToAgent: true,
    livesIn: ['comp'],
    calibration: 'probe-thin-geometry',
    exams: ['1-2', '7-1', 'cal:overlay.anchored'],
  },
  'audio.drums': {
    dir: 'audio/drums',
    kind: 'audio',
    visibleToAgent: true,
    livesIn: ['comp'],
    calibration: 'probe-moving-cube',
    exams: ['1-2', '27-1', 'cal:audio.drums'],
  },
  'blur.subframe': {
    dir: 'mechanism/blur-subframe',
    kind: 'mechanism',
    visibleToAgent: false,
    livesIn: ['source:three'],
    calibration: 'probe-moving-cube',
    exams: ['1-2', '27-1', '7-1', 'cal:blur.subframe'],
  },
};

const readCard = (id) => JSON.parse(readFileSync(join(HERE, T16_SPEC[id].dir, 'card.json'), 'utf8'));
const sha256Bytes = (typed) => createHash('sha256').update(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).digest('hex');

test('T16-1 四张卡文件存在且全部通过 C1 validateCard 与 scanCardLeaks（0 错误、0 泄漏）', () => {
  for (const [id, spec] of Object.entries(T16_SPEC)) {
    const cardPath = join(HERE, spec.dir, 'card.json');
    assert.ok(existsSync(cardPath), `缺少卡文件: ${cardPath}`);
    const raw = readFileSync(cardPath, 'utf8');
    assert.deepEqual(scanCardLeaks(raw), [], `${id} card.json 存在泄漏`);
    assert.deepEqual(validateCard(JSON.parse(raw)), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, `${id} validateCard 未通过`);

    for (const f of readdirSync(join(HERE, spec.dir))) {
      const content = readFileSync(join(HERE, spec.dir, f), 'utf8');
      assert.deepEqual(scanCardLeaks(content), [], `${spec.dir}/${f} 存在泄漏`);
    }
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), [], 't16-cards.test.mjs 自身不得含任何泄漏');
});

test('T16-2 C2 注册表检索、visibleToAgent 过滤、默认参数 Ajv 校验、动态 import 入口与校准场景齐备', async () => {
  const cards = Object.keys(T16_SPEC).map(readCard);
  const registry = createCardRegistry(cards, { allowReproduced: true });

  for (const card of cards) {
    const spec = T16_SPEC[card.id];
    const [impl] = card.impl;
    assert.equal(card.kind, spec.kind, card.id);
    assert.equal(card.visibleToAgent, spec.visibleToAgent, card.id);
    assert.deepEqual(card.livesIn, spec.livesIn, card.id);
    assert.equal(card.calibration, spec.calibration, card.id);
    assert.deepEqual(card.exams, spec.exams, card.id);
    assert.equal(impl.shape, 'create', card.id);
    assert.deepEqual(
      [impl.entry, impl.selftest],
      [`cards/${spec.dir}/index.mjs`, `cards/${spec.dir}/selftest.test.mjs`],
      card.id,
    );

    const entryAbs = join(BEIMING, impl.entry);
    const selftestAbs = join(BEIMING, impl.selftest);
    assert.ok(existsSync(entryAbs) && existsSync(selftestAbs), `${card.id} 的入口与自测文件必须存在`);

    const mod = await import(pathToFileURL(entryAbs).href);
    assert.equal(typeof mod.create, 'function', `${card.id} 必须导出 create 函数`);

    assert.equal(registry.getCard(card.id)?.id, card.id);
    assert.equal(registry.getCard(`${card.id}@1`)?.id, card.id);

    const diagnostics = [];
    const results = registry.searchCards({
      kind: card.kind,
      livesIn: spec.livesIn[0],
      q: card.title,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    assert.deepEqual(diagnostics, [], `${card.id} 的摘要超出 token 预算`);

    if (spec.visibleToAgent) {
      const hit = results.find((r) => r.id === card.id);
      assert.ok(hit, `visibleToAgent=true 的 ${card.id} 应能被 searchCards 检索到`);
      assert.equal(hit.title, card.title, `${card.id} 的 title 不应被截断`);
      assert.equal(hit.intent, card.intent, `${card.id} 的 intent 不应被截断`);
    } else {
      assert.equal(results.some((r) => r.id === card.id), false, `visibleToAgent=false 的 ${card.id} 不得被 searchCards 暴露给做题代理`);
    }

    const resolved = resolveParams(card, {});
    assert.deepEqual(Object.keys(resolved), Object.keys(card.params), card.id);
    for (const [name, check] of dataValidators(card)) {
      assert.equal(check(resolved[name]), true, `${card.id}.${name} 默认值未通过 schema 校验: ${JSON.stringify(check.errors)}`);
      assert.equal(check({ __invalidKey: true }), false, `${card.id}.${name} schema 应拒绝非法数据`);
    }
  }
});

test('T16-3 M3 端到端桥接链路：正式参数接入 GLB 零件桥 -> 随相机移动的锚点引线标注 + 48kHz 节拍网格鼓点 + 宿主首帧切点零重影线性子帧模糊', () => {
  // 1. asset.glb-bridge：通过 resolveParams(card, { glb }) 正式入口导入含父子层级与原始三角网格的 GLB
  const assetCard = readCard('asset.glb-bridge');
  const glbBytes = buildSyntheticGlb({
    alias: 'gpu',
    expectedParts: ['body', 'fan_L', 'fan_R'],
    upAxis: 'Y',
    unitScale: 1,
    prefixAlias: true,
  });
  const glbInfo = inspectGlb(glbBytes);
  assert.deepEqual(glbInfo.partNames, ['body', 'fan_L', 'fan_R']);
  const verdict = verifyPartNames(glbInfo, ['body', 'fan_L', 'fan_R'], { throwOnError: true });
  assert.equal(verdict.ok, true);

  const assetParams = resolveParams(assetCard, { glb: glbBytes });
  const assetHandle = createGlbBridge({ THREE }, assetParams);
  assert.deepEqual(Object.keys(assetHandle.object.parts), ['body', 'fan_L', 'fan_R']);
  assetHandle.dispose();

  // 参考层级 GLB 导入对照：父组 mount（平移 [10,0,0]、绕 Z +90°、缩放 2）+ 两个 3 顶点三角网格（housing 与 blade [1,0,0]）
  const rotorGlb = buildSyntheticGlb({
    alias: 'rotor',
    prefixAlias: false,
    parts: [
      {
        name: 'mount',
        kind: 'group',
        translation: [10, 0, 0],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [2, 2, 2],
      },
      {
        name: 'housing',
        kind: 'mesh',
        parent: 'mount',
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
      {
        name: 'blade',
        kind: 'mesh',
        parent: 'mount',
        translation: [1, 0, 0],
        positions: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0],
        indices: [0, 1, 2],
        material: { baseColorFactor: [0.2, 0.6, 0.9, 1], metallicFactor: 0.8, roughnessFactor: 0.25 },
      },
    ],
  });
  const rotorHandle = createGlbBridge(
    { THREE },
    resolveParams(assetCard, {
      glb: rotorGlb,
      spec: { alias: 'rotor', expectedParts: ['housing', 'blade'], upAxis: 'Y', unitScale: 1 },
    }),
  );
  const bladeMesh = rotorHandle.object.parts.blade;
  assert.equal(bladeMesh.parent, rotorHandle.object.nodes.mount);
  assert.equal(bladeMesh.geometry.attributes.position.count, 3);
  const bladeWorld = bladeMesh.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.hypot(bladeWorld.x - 10, bladeWorld.y - 2, bladeWorld.z - 0) < 1e-5);
  rotorHandle.dispose();

  // 2. overlay.anchored：相机从第 0 帧到第 18 帧平移时，不改二维参数，标注严格跟随像素锚点且绘制真实字形
  const overlayHandle = createOverlayAnchored(
    { size: [1280, 720], shot: { in: 0, frames: 48 } },
    {
      callouts: [
        { id: 'tag-body', entity: 'gpu.body', text: 'GPU CHASSIS', dx: -84, dy: -40 },
        { id: 'tag-fan-l', entity: 'gpu.fan_L', anchor: 'hub', text: 'LEFT AXIAL FAN', dx: 76, dy: -36 },
        { id: 'tag-fan-r', entity: 'gpu.fan_R', anchor: 'hub', text: 'RIGHT AXIAL FAN', dx: 84, dy: 42 },
      ],
      safeMarginPx: 24,
    },
  );

  const makeMetaAt = (f, camShiftX, camShiftY) => ({
    format: 'meta/0.1',
    frame: f,
    shotFrame: f,
    size: [1280, 720],
    entities: [
      {
        id: 1,
        name: 'gpu.body',
        class: 'mesh',
        visible: 1,
        pxArea: 0.18,
        bbox2d: [540 + camShiftX, 300 + camShiftY, 740 + camShiftX, 420 + camShiftY],
      },
      {
        id: 2,
        name: 'gpu.fan_L',
        class: 'mesh',
        visible: 1,
        pxArea: 0.06,
        bbox2d: [440 + camShiftX, 320 + camShiftY, 520 + camShiftX, 400 + camShiftY],
        anchors: { hub: { world: [-0.06, 0, 0.027], screen: [480 + camShiftX, 360 + camShiftY] } },
      },
      {
        id: 3,
        name: 'gpu.fan_R',
        class: 'mesh',
        visible: 1,
        pxArea: 0.06,
        bbox2d: [760 + camShiftX, 320 + camShiftY, 840 + camShiftX, 400 + camShiftY],
        anchors: { hub: { world: [0.06, 0, 0.027], screen: [800 + camShiftX, 360 + camShiftY] } },
      },
    ],
  });

  const layout0 = overlayHandle.object.layout(0, makeMetaAt(0, 0, 0));
  const layout18 = overlayHandle.object.layout(18, makeMetaAt(18, 95, -35));
  assert.equal(layout0.items.length, 3);
  assert.equal(layout18.items.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(layout18.items[i].anchorPoint[0] - layout0.items[i].anchorPoint[0], 95);
    assert.equal(layout18.items[i].anchorPoint[1] - layout0.items[i].anchorPoint[1], -35);
    assert.equal(layout18.items[i].labelBox[0] - layout0.items[i].labelBox[0], 95);
    assert.equal(layout18.items[i].labelBox[1] - layout0.items[i].labelBox[1], -35);
  }

  // 3. audio.drums：48000 Hz 立体声节拍网格鼓组 + EV1 事件表排序校验
  const drumsCard = readCard('audio.drums');
  const [checkDrumsPattern] = dataValidators(drumsCard).get
    ? [dataValidators(drumsCard).get('pattern')]
    : dataValidators(drumsCard).filter(([k]) => k === 'pattern').map(([, fn]) => fn);
  const gridPattern = {
    bpm: 120,
    stepsPerBeat: 4,
    hits: [
      { id: 'start-kick', voice: 'kick', step: 0, velocity: 1.0, pan: 0 },
      { id: 'unscrew-rim-l', voice: 'rim', step: 3, velocity: 0.85, pan: -0.45 },
      { id: 'unscrew-rim-r', voice: 'rim', beat: 1.5, velocity: 0.85, pan: 0.45 },
      { id: 'cut-accent', voice: 'accent', beat: 2, velocity: 1.25, pan: 0 },
      { id: 'z-early', voice: 'hihat', frame: 30, sub: 0, velocity: 0.7, pan: -0.2 },
      { id: 'a-late-sub', voice: 'snare', frame: 30, sub: 0.5, velocity: 0.95, pan: 0.15 },
    ],
  };
  assert.equal(checkDrumsPattern(gridPattern), true, '节拍网格 pattern 必须通过 schema 校验');

  const drumsHandle = createDrums(
    { fps: '24/1', frames: 48, seed: 20261123, shot: { in: 0, frames: 48 } },
    resolveParams(drumsCard, { pattern: gridPattern, gainDb: -2, ceilingDb: -1 }),
  );
  assert.equal(drumsHandle.object.sampleRate, SAMPLE_RATE);
  assert.equal(drumsHandle.object.channels[0].length, 96000);
  assert.ok(drumsHandle.object.peakDb <= -1 + 1e-5);
  assert.equal(drumsHandle.meta(24).readings.hitCount, 1);
  assert.deepEqual(
    eventChecks.EV1({ format: 'events/0.1', film: 'test', fps: '24/1', frames: 48, events: drumsHandle.object.events }),
    [],
  );

  // 4. blur.subframe：真实页面宿主上下文 + 局部首帧 apply(0, 0) + 红蓝切点零重影 vs 负对照 50% 重影
  const blurCard = readCard('blur.subframe');
  const shot2 = Object.freeze({ id: 'shot-2', in: 31, frames: 4 });
  const hostCtx = {
    tracks: { apply() {} },
    cards: { use() {} },
    params: {},
    seed: 101,
    rng: () => () => 0.5,
    assets: { load() {} },
    anchor() {},
    tokens: {},
    size: [1280, 720],
    fps: '24/1',
    frames: 4,
    shot: shot2,
    events: Object.freeze({}),
    THREE,
    renderer: {},
  };
  const shot1Linear = new Float32Array([1.0, 0.0, 0.0, 1.0]);
  const shot2Linear = new Float32Array([0.0, 0.0, 1.0, 1.0]);
  const renderShotTimeline = (t) => (t < shot2.in ? shot1Linear : shot2Linear);

  const blurClamped = createBlurSubframe(hostCtx, resolveParams(blurCard, { shutterAngleDeg: 180, samples: 8, clampToShot: true }));
  // 页面宿主传入镜头局部首帧 f = 0（对应全片第 31 帧）
  const appLocal0 = blurClamped.apply(0, 0);
  assert.equal(appLocal0.filmFrame, 31);
  const frameLocal0Clamped = blurClamped.object.renderFrame(0, renderShotTimeline);
  assert.deepEqual([...frameLocal0Clamped.rgba], [0, 0, 1, 1]);
  const ghostClamped = measureCutGhosting(frameLocal0Clamped.rgba, shot1Linear, shot2Linear);
  assert.equal(ghostClamped.ghostRatio, 0);
  assert.equal(ghostClamped.maxGhostDelta, 0);

  // 内部第 32 帧（局部 f = 1）、180°、两采样默认时刻严格对齐 shutterSubs(180, 2) -> [32.125, 32.375]
  const sched32 = subframeTimes(32, shot2, { shutterAngleDeg: 180, samples: 2 });
  assert.deepEqual(sched32.map((s) => s.sub), shutterSubs(180, 2));
  assert.deepEqual(sched32.map((s) => s.t), [32.125, 32.375]);

  // 关闭钳制的负对照：4 个子帧落入前镜，输出 [0.5, 0, 0.5, 1]，红通道平方能量为 0.25
  const frameUnclamped = renderSubframeBlur(31, shot2, renderShotTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    clampToShot: false,
  });
  assert.deepEqual([...frameUnclamped.rgba], [0.5, 0, 0.5, 1]);
  assert.equal(frameUnclamped.rgba[0] ** 2, 0.25);
  const ghostUnclamped = measureCutGhosting(frameUnclamped.rgba, shot1Linear, shot2Linear);
  assert.ok(Math.abs(ghostUnclamped.ghostRatio - 0.5) < 1e-6);
});

test('T16-4 四张卡全部满足 L2 纯函数确定性（顺序 / 逆序 / 单帧一致）与常规坏参数校验（usage.bad-argument）', () => {
  const glbH = createGlbBridge({}, resolveParams(readCard('asset.glb-bridge')));
  const metaFrames = Object.fromEntries(
    [0, 4, 9, 15].map((f) => [
      f,
      {
        format: 'meta/0.1',
        frame: f,
        shotFrame: f,
        size: [640, 360],
        entities: [{ id: 1, name: 'gpu.body', class: 'mesh', visible: 1, pxArea: 0.1, bbox2d: [180 + f * 4, 120 + f * 2, 300 + f * 4, 220 + f * 2] }],
      },
    ]),
  );
  const ovH = createOverlayAnchored({ size: [640, 360], frames: metaFrames }, resolveParams(readCard('overlay.anchored')));
  const drH = createDrums({ fps: '24/1', frames: 24, seed: 99 }, resolveParams(readCard('audio.drums')));
  const blH = createBlurSubframe({ shot: { in: 10, frames: 24 } }, resolveParams(readCard('blur.subframe')));

  const seq = [0, 4, 9, 15];
  for (const [name, fn] of [
    ['asset.glb-bridge', (f) => glbH.apply(f, 0.125)],
    ['overlay.anchored', (f) => ovH.object.layout(f)],
    ['audio.drums', (f) => drH.meta(f)],
    ['blur.subframe', (f) => blH.apply(f, 0)],
  ]) {
    const forward = seq.map(fn);
    const reversed = [...seq].reverse().map(fn).reverse();
    const single = fn(9);
    assert.deepEqual(forward, reversed, `${name} 顺序与逆序求值不一致`);
    assert.deepEqual(single, forward[2], `${name} 单帧跳帧求值不一致`);
  }

  const drH2 = createDrums({ fps: '24/1', frames: 24, seed: 99 }, resolveParams(readCard('audio.drums')));
  assert.equal(sha256Bytes(drH.object.channels[0]), sha256Bytes(drH2.object.channels[0]));
  assert.equal(sha256Bytes(drH.object.channels[1]), sha256Bytes(drH2.object.channels[1]));

  for (const call of [
    () => buildSyntheticGlb({ expectedParts: [] }),
    () => inspectGlb(new Uint8Array([1, 2, 3])),
    () => verifyPartNames(buildSyntheticGlb({ alias: 'gpu', expectedParts: ['body'] }), ['body', 'missing_part'], { throwOnError: true }),
    () => createGlbBridge({}, { scale: -1 }),
    () => resolveAnchorPoint({ format: 'meta/0.1', size: [320, 200], entities: [{ id: 1, name: 'gpu.body', class: 'mesh', visible: 1, pxArea: 0.1, bbox2d: [0, 0, 10, 10], anchors: { p: { screen: [371, 50] } } }] }, { entity: 'gpu.body', anchor: 'p' }, [320, 200]),
    () => createOverlayAnchored({ size: [320, 200] }, { callouts: [{ id: 'c1', entity: 'gpu.body', text: 'CORE', dx: {} }] }),
    () => synthesizeVoice('unknown-voice'),
    () => renderDrums({ fps: '24/1', frames: 12, pattern: { hits: [{ id: 'h1', voice: 'kick', frame: 99 }] } }),
    () => subframeTimes(50, { in: 0, frames: 24 }),
    () => accumulateLinear([new Float32Array([1, 0, Number.NaN, 1])]),
    () => createBlurSubframe({ shot: { in: 0, frames: 12 } }, { shutterAngleDeg: -10 }),
  ]) {
    assert.throws(call, (err) => err?.code === 'usage.bad-argument');
  }
  assert.equal(VOICE_NAMES.length, 5);
});

test('T16-5 二审 7 项回归：严格零件清单拒绝拼错名与同名空组、多 primitive 几何与材质合入同一零件及越界索引拦截、默认场景可达零件、meta/0.1 ext 扩展、单采样快门相位', async () => {
  const card = readCard('asset.glb-bridge');
  const load = (glb, spec) => createGlbBridge({ THREE }, resolveParams(card, { glb, spec }));
  const spec = { alias: 'gpu', expectedParts: ['body', 'fan_L', 'fan_R'], upAxis: 'Y', unitScale: 1 };

  // 1 & 2. 严格清单拒绝拼错名与同名空组
  for (const [reason, last] of [['拼错名', 'fan_X'], ['同名空组', { name: 'fan_R', kind: 'group' }]]) {
    const glb = buildSyntheticGlb({ alias: 'gpu', parts: ['body', 'fan_L', last] });
    assert.throws(() => load(glb, spec), { code: 'usage.bad-argument' }, `严格清单应拒绝${reason}`);
  }

  // 两块分别带红、蓝材质的三角面：在 JSON 中保留一个命名 mesh，两个 primitive 共用同一个 BIN 块
  const tri = (name, x, color) => ({
    name,
    positions: [x, 0, 0, x + 1, 0, 0, x, 1, 0],
    indices: [0, 1, 2],
    material: { name, baseColorFactor: [...color, 1] },
  });
  const seed = Buffer.from(buildSyntheticGlb({
    alias: 'gpu',
    prefixAlias: false,
    parts: [tri('body', 0, [1, 0, 0]), tri('panel', 5, [0, 0, 1])],
  }));
  function fixture(change) {
    const end = 20 + seed.readUInt32LE(12);
    const doc = JSON.parse(seed.subarray(20, end));
    change(doc);
    const text = Buffer.from(JSON.stringify(doc));
    const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
    text.copy(padded);
    const out = Buffer.concat([seed.subarray(0, 20), padded, seed.subarray(end)]);
    out.writeUInt32LE(out.length, 8);
    out.writeUInt32LE(padded.length, 12);
    return Uint8Array.from(out);
  }
  function merge(d) {
    d.meshes[0].primitives.push(d.meshes[1].primitives[0]);
    d.meshes.length = 1;
    d.nodes.length = 1;
    d.scenes[0].nodes = [0];
    d.nodes[0].translation = [2, 0, 0];
  }
  const body = { alias: 'gpu', expectedParts: ['body'] };
  const bounds = (root) => new THREE.Box3().setFromObject(root, true).max.x;
  const names = (root) => {
    const seen = new Set();
    root.traverse((o) => {
      if (o.isMesh) {
        for (const m of [o.material].flat()) seen.add(m.name);
      }
    });
    return [...seen].sort();
  };

  // 3. 第二个 primitive 的几何和材质进入同一个零件
  const multiPrimGlb = fixture(merge);
  const refMulti = (await new GLTFLoader().parseAsync(multiPrimGlb.buffer, '')).scene;
  assert.equal(bounds(refMulti), 8);
  assert.deepEqual(names(refMulti), ['body', 'panel']);
  const hMulti = load(multiPrimGlb, body);
  assert.deepEqual([bounds(hMulti.object), hMulti.object.worldBbox[3], names(hMulti.object)], [8, 8, ['body', 'panel']]);
  hMulti.dispose();

  // 4. 第二个 primitive 的越界索引必须拒收
  const badPrim2Glb = fixture((d) => {
    merge(d);
    d.meshes[0].primitives[1].indices = d.accessors.length;
  });
  assert.throws(() => load(badPrim2Glb, body), { code: 'usage.bad-argument' });

  // 5. 默认场景只交付可达的零件
  const twoScenesGlb = fixture((d) => {
    d.scenes = [{ nodes: [0] }, { nodes: [1] }];
    d.scene = 0;
  });
  const refScene0 = (await new GLTFLoader().parseAsync(twoScenesGlb.buffer, '')).scene;
  assert.equal(bounds(refScene0), 1);
  const hScene0 = createGlbBridge({ THREE }, resolveParams(card, { glb: twoScenesGlb, spec: body, allowExtraParts: true }));
  assert.deepEqual([Object.keys(hScene0.object.parts), hScene0.object.worldBbox[3]], [['body'], 1]);
  hScene0.dispose();

  // 6. 标注直接消费 meta/0.1 扩展
  const fullMeta = JSON.parse(readFileSync(join(BEIMING, 'kernel/contracts/meta/examples/full.json'), 'utf8'));
  const hOverlay = createOverlayAnchored({ size: fullMeta.size }, { callouts: [{ id: 'tag', entity: 'kit', text: 'LEFT' }] });
  fullMeta.ext = { 'page.load': { steps: ['assets', 'tracks', 'create', 'collect'] } };
  assert.equal(hOverlay.object.layout(fullMeta.shotFrame, fullMeta).texts[0].text, 'LEFT');

  // 7. 非零快门单采样与求值核相位相同
  const shot = { in: 31, frames: 4 };
  const actualSubs = subframeTimes(32, shot, { shutterAngleDeg: 180, samples: 1 }).map((s) => s.sub);
  assert.deepEqual(actualSubs, shutterSubs(180, 1));
});

test('T16-6 终审 4 项回归：默认入口传非 GPU GLB 交付自身零件、严格 alias 前缀剥离、未选场景辅助线不阻断默认场景', async () => {
  const card = readCard('asset.glb-bridge');
  function load(glb, spec) {
    const given = { glb: Buffer.from(glb).toString('base64') };
    if (spec !== undefined) given.spec = spec;
    return createGlbBridge({ THREE }, resolveParams(card, given));
  }

  const rotorNames = ['housing', 'blade'];
  const rotor = buildSyntheticGlb({ alias: 'rotor', prefixAlias: false, parts: rotorNames });
  const gpuSpec = { alias: 'gpu', expectedParts: ['body', 'fan_L', 'fan_R'] };
  const gpu = (last) => buildSyntheticGlb({ alias: 'gpu', parts: ['gpu.body', 'gpu.fan_L', last] });

  function withGuideScene() {
    const parts = ['body', 'guide'].map((name) => ({
      name,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    }));
    const seed = Buffer.from(buildSyntheticGlb({ alias: 'kit', prefixAlias: false, parts }));
    const end = 20 + seed.readUInt32LE(12);
    const doc = JSON.parse(seed.subarray(20, end));
    doc.scene = 0;
    doc.scenes = [{ nodes: [0] }, { nodes: [1] }];
    const line = doc.meshes[1].primitives[0];
    line.mode = 1;
    delete line.indices;
    const pos = doc.accessors[line.attributes.POSITION];
    pos.count = 2;
    pos.max = [1, 0, 0];
    const text = Buffer.from(JSON.stringify(doc));
    const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
    text.copy(padded);
    const out = Buffer.concat([seed.subarray(0, 20), padded, seed.subarray(end)]);
    out.writeUInt32LE(out.length, 8);
    out.writeUInt32LE(padded.length, 12);
    return Uint8Array.from(out);
  }
  const twoScenes = withGuideScene();

  // 正对照：真实零件名、显式清单、正确前缀、两个有效场景
  const loader = new GLTFLoader();
  const reference = await loader.parseAsync(rotor.buffer, '');
  assert.deepEqual(reference.scene.children.map((o) => o.name), rotorNames);
  const explicit = load(rotor, { alias: 'rotor', expectedParts: rotorNames });
  assert.deepEqual(Object.keys(explicit.object.parts), rotorNames);
  explicit.dispose();
  const gpuOk = load(gpu('gpu.fan_R'), gpuSpec);
  assert.equal(gpuOk.meta(0).readings.verified, 1);
  gpuOk.dispose();
  const { scene, scenes } = await loader.parseAsync(twoScenes.buffer, '');
  assert.deepEqual(scene.children.map((o) => o.name), ['body']);
  assert.equal(scenes[1].children[0].isLineSegments, true);
  assert.equal(scenes[1].children[0].geometry.attributes.position.count, 2);

  // 甲 1：只传 GLB 的正式入口应交付转子两个零件
  const rotorDefault = load(rotor);
  assert.deepEqual(Object.keys(rotorDefault.object.parts), rotorNames);
  rotorDefault.dispose();

  // 甲 2：严格清单应拒绝其他资产的同名网格
  assert.throws(() => load(gpu('other.fan_R'), gpuSpec), { code: 'usage.bad-argument' });

  // 甲 3：未选场景的辅助线不妨碍默认场景交付 body
  const hGuide = load(twoScenes, { alias: 'kit', expectedParts: ['body'] });
  assert.deepEqual(Object.keys(hGuide.object.parts), ['body']);
  hGuide.dispose();
});
