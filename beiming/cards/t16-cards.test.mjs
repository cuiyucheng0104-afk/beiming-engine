// T16：四张 M3 桥接与后处理/音频/机制技术卡（asset.glb-bridge、overlay.anchored、audio.drums、blur.subframe）的汇总验收：
//   一、C1 契约校验与零泄漏扫描：四张卡的 card.json 全部通过 validateCard，卡目录内所有文件及本测试通过 scanCardLeaks；
//   二、C2 注册表、可见性、默认参数 schema 与五项成卡标准：前三张对做题代理可见且摘要零截断，blur.subframe（mechanism，visibleToAgent=false）对 searchCards 隐藏但 getCard 可取；
//   三、M3 跨卡端到端桥接链路（01-2 / 27-1 / 07-1）：
//       1) asset.glb-bridge 生成并解析多零件 GLB（body / fan_L / fan_R），装入 three 层级且 100% 保留零件名与右手 Y 向上米制；
//       2) overlay.anchored 从每帧 meta/0.1 的实体锚点与包围盒排版引线与标签框，相机运动时标注自动跟随而不改一行二维代码；
//       3) audio.drums 以纯函数在 48000 Hz 下合成底鼓、军鼓、踩镲与机械重音立体声，零外部音频素材且峰值严守 ceilingDb；
//       4) blur.subframe 在场景线性光空间做子帧累积，并在镜头切点后首帧硬钳制快门窗口，跨镜头重影严格为 0（未钳制负对照测出 50% 重影）；
//   四、L2 纯函数门（顺序 / 逆序 / 单帧逐位一致）与零陷阱防御（Proxy / getter / 稀疏数组 / NaN 一律报 usage.bad-argument 且 0 陷阱触发）。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSyntheticGlb, create as createGlbBridge, inspectGlb, verifyPartNames } from './asset/glb-bridge/index.mjs';
import { create as createDrums, SAMPLE_RATE, synthesizeVoice, VOICE_NAMES } from './audio/drums/index.mjs';
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

    // getCard 对所有已注册卡（含 mechanism）均能按 id 与主版本引用取回
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

test('T16-3 M3 端到端桥接链路：GLB 零件桥 -> 随相机移动的锚点引线标注 + 48kHz 程序化鼓点重音 + 切点零重影线性子帧模糊', () => {
  // 1. asset.glb-bridge：合成并装载含 body、fan_L、fan_R 的显卡拆解 GLB
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

  const assetHandle = createGlbBridge({}, {
    glb: glbBytes,
    spec: resolveParams(readCard('asset.glb-bridge')).spec,
  });
  assert.deepEqual(Object.keys(assetHandle.object.parts), ['body', 'fan_L', 'fan_R']);

  // 2. overlay.anchored：相机从第 0 帧到第 24 帧环绕平移时，不改任何二维参数，标注严格跟随零件屏幕锚点
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

  // 3. audio.drums：48000 Hz 立体声鼓组与拆解卡点机械重音
  const drumsHandle = createDrums(
    { fps: '24/1', frames: 48, seed: 20261123, shot: { in: 0, frames: 48 } },
    {
      pattern: {
        bpm: 120,
        stepsPerBeat: 4,
        hits: [
          { id: 'start-kick', voice: 'kick', frame: 0, sub: 0, velocity: 1.0, pan: 0 },
          { id: 'unscrew-rim-l', voice: 'rim', frame: 8, sub: 0.25, velocity: 0.85, pan: -0.45 },
          { id: 'unscrew-rim-r', voice: 'rim', frame: 16, sub: 0.5, velocity: 0.85, pan: 0.45 },
          { id: 'cut-accent', voice: 'accent', frame: 24, sub: 0, velocity: 1.25, pan: 0 },
          { id: 'spin-hihat', voice: 'hihat', frame: 30, sub: 0, velocity: 0.7, pan: -0.2 },
          { id: 'lock-snare', voice: 'snare', frame: 36, sub: 0, velocity: 0.95, pan: 0.15 },
        ],
      },
      gainDb: -2,
      ceilingDb: -1,
    },
  );
  assert.equal(drumsHandle.object.sampleRate, SAMPLE_RATE);
  assert.equal(drumsHandle.object.channels[0].length, 96000);
  assert.ok(drumsHandle.object.peakDb <= -1 + 1e-5);
  assert.equal(drumsHandle.meta(24).readings.hitCount, 1);

  // 4. blur.subframe：第 24 帧切镜头（Shot 2: [24, 48)）时，开启钳制跨镜头重影为 0，关闭钳制负对照测出 50% 重影
  const shot2 = { in: 24, frames: 24 };
  const shot1Linear = new Float32Array([10.0, 0.2, 0.1, 1.0, 10.0, 0.2, 0.1, 1.0]);
  const shot2Linear = new Float32Array([0.1, 1.8, 4.2, 1.0, 0.1, 1.8, 4.2, 1.0]);
  const renderShotTimeline = (t) => (t < 24 ? shot1Linear : shot2Linear);

  const blurClamped = createBlurSubframe({ shot: shot2 }, { shutterAngleDeg: 180, samples: 8, clampToShot: true });
  const frame24Clamped = blurClamped.object.renderFrame(24, renderShotTimeline);
  const ghostClamped = measureCutGhosting(frame24Clamped.rgba, shot1Linear, shot2Linear);
  assert.equal(ghostClamped.ghostRatio, 0);
  assert.equal(ghostClamped.maxGhostDelta, 0);

  const frame24Unclamped = renderSubframeBlur(24, shot2, renderShotTimeline, {
    shutterAngleDeg: 180,
    samples: 8,
    alignment: 'centered',
    clampToShot: false,
  });
  const ghostUnclamped = measureCutGhosting(frame24Unclamped.rgba, shot1Linear, shot2Linear);
  assert.ok(Math.abs(ghostUnclamped.ghostRatio - 0.5) < 1e-6);
});

test('T16-4 四张卡全部满足 L2 纯函数确定性（顺序 / 逆序 / 单帧一致）与零陷阱防御（0 陷阱触发）', () => {
  // 1. L2 顺序 vs 逆序 vs 单帧
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
  const blH = createBlurSubframe({ shot: { in: 0, frames: 24 } }, resolveParams(readCard('blur.subframe')));

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

  // 2. audio.drums 双次独立实例化通道 SHA-256 逐位一致
  const drH2 = createDrums({ fps: '24/1', frames: 24, seed: 99 }, resolveParams(readCard('audio.drums')));
  assert.equal(sha256Bytes(drH.object.channels[0]), sha256Bytes(drH2.object.channels[0]));
  assert.equal(sha256Bytes(drH.object.channels[1]), sha256Bytes(drH2.object.channels[1]));

  // 3. 四张卡全部公开入口零陷阱拒绝 Proxy 与 getter
  let traps = 0;
  const makePoisonProxy = () =>
    new Proxy(
      {},
      {
        get() {
          traps++;
          return null;
        },
        ownKeys() {
          traps++;
          return [];
        },
      },
    );

  const makePoisonGetter = (key) => {
    const obj = {};
    Object.defineProperty(obj, key, {
      enumerable: true,
      get() {
        traps++;
        return null;
      },
    });
    return obj;
  };

  for (const call of [
    () => buildSyntheticGlb(makePoisonProxy()),
    () => inspectGlb(makePoisonGetter('asset')),
    () => verifyPartNames(glbBytesSample(), makePoisonProxy()),
    () => createGlbBridge(makePoisonProxy(), {}),
    () => resolveAnchorPoint(makePoisonProxy(), { entity: 'gpu.body' }, [640, 360]),
    () => createOverlayAnchored(makePoisonGetter('size'), {}),
    () => synthesizeVoice('kick', makePoisonProxy()),
    () => createDrums(makePoisonProxy(), {}),
    () => subframeTimes(0, makePoisonProxy()),
    () => accumulateLinear(makePoisonProxy()),
    () => createBlurSubframe(makePoisonGetter('shot'), {}),
  ]) {
    assert.throws(call, (err) => err?.code === 'usage.bad-argument');
  }
  assert.equal(traps, 0, '所有公开入口在拒绝 Proxy 与 getter 时必须零触发陷阱');
  assert.equal(VOICE_NAMES.length, 5);
});

function glbBytesSample() {
  return buildSyntheticGlb({ alias: 'gpu', expectedParts: ['body'] });
}
