// 主干缺陷 #1 + #4 回归测试（FIX-cache-engine-digest）：
// 1. 引擎源码、页面宿主、求值核、锁定字体、技术卡目录变更按作业实时绑定帧缓存键与锁摘要，绝不启动期缓存，绝不混入旧帧；
// 2. 缓存键纳入全片事件表（events.events），跨镜头事件变更即时失效全片缓存，单镜头参数变更仍保持无关镜头 100% 命中；
// 3. 全部改动模拟均在临时副本目录中进行，绝不脏改仓库文件。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeFrameCacheKey } from '../jobs/cache.mjs';
import { openShotCache } from '../jobs/index.mjs';
import * as pipeline from './pipeline.mjs';
import * as runtime from './runtime.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HEX = (c) => c.repeat(64);
const SIZE = [16, 8];
const noFfmpeg = !runtime.hasFfmpeg() && '缺少可执行的 FFmpeg';

let tmpRoot, lutPath;
const tempVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
const previousTemp = process.env[tempVariable];

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'beiming-cache-engine-digest-'));
  process.env[tempVariable] = tmpRoot;
  lutPath = join(tmpRoot, 'agx.cube');
  writeFileSync(lutPath, runtime.analyticAgxCube());
});

after(() => {
  if (previousTemp === undefined) delete process.env[tempVariable];
  else process.env[tempVariable] = previousTemp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeText(base, rel, text) {
  const abs = join(base, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

/** 构造隔离的最小引擎根目录副本（含 kernel/eval、fonts、three、host/page、blender 与两张技术卡），避免修改仓库文件。 */
function makeEngineRoot(name) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeText(dir, 'beiming/kernel/eval/index.mjs', 'export const EVAL_VER = 1;\n');
  writeText(dir, 'beiming/kernel/eval/events.mjs', 'export const EVENTS_VER = 1;\n');
  writeText(dir, 'beiming/kernel/eval/interp.mjs', 'export const INTERP_VER = 1;\n');
  writeText(dir, 'beiming/kernel/eval/time.mjs', 'export const TIME_VER = 1;\n');
  writeText(dir, 'routes/c-style/fonts/fonts.json', '{"version":1,"fonts":["demo"]}\n');
  writeText(dir, 'routes/c-style/fonts/mashanzheng-00.woff2', 'WOFF2-BYTES-V1');
  writeText(dir, 'routes/c-style/fonts/demo.otf', 'OTF-BYTES-V1');
  writeText(dir, 'beiming/sources/three/source.js', 'export const THREE_SRC = 1;\n');
  writeText(dir, 'beiming/sources/three/plan.mjs', 'export const THREE_PLAN = 1;\n');
  writeText(dir, 'beiming/host/page/runtime.js', 'export const PAGE_HOST = 1;\n');
  writeText(dir, 'beiming/sources/blender/worker.py', 'BLENDER_WORKER = 1\n');
  writeText(dir, 'beiming/sources/blender/runtime.py', 'BLENDER_RUNTIME = 1\n');
  writeText(dir, 'node_modules/three-webgpu/build/three.module.js', 'export const REVISION = "187";\n');
  writeText(dir, 'beiming/cards/two-d/overlay-title/card.json', JSON.stringify({ id: 'overlay.title', version: '1.0.0' }));
  writeText(dir, 'beiming/cards/two-d/overlay-title/three.js', 'export const TITLE_CARD = 1;\n');
  writeText(dir, 'beiming/cards/two-d/overlay-title/selftest.test.mjs', 'export const TEST_ONLY = 1;\n');
  writeText(dir, 'beiming/cards/mechanism/blender-cycles/card.json', JSON.stringify({ id: 'blender.cycles', version: '1.0.0' }));
  writeText(dir, 'beiming/cards/mechanism/blender-cycles/cycles.py', 'CYCLES_CARD = 1\n');
  writeText(dir, 'beiming/cards/time/events/card.json', JSON.stringify({ id: 'time.events', version: '1.0.0' }));
  writeText(dir, 'beiming/cards/time/events/evaluate.mjs', 'export const EVENTS_CARD = 1;\n');
  return dir;
}

/** 构造复现脚本 cache/engine-change.mjs 同款单镜头 three 片子。 */
function singleThreeFilm() {
  return {
    format: 'film/3.0',
    id: 'f_cache',
    output: { size: SIZE, fps: '24/1', frames: 12 },
    shots: [
      {
        id: 's02', in: 0, out: 12, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed: 1002,
        cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX', enter: 0 } }],
      },
    ],
    events: [],
    style: { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#111318', paper: '#EAE6DF' } },
  };
}

/** 双镜头片：s01 为 blender 镜头，s02 为 three 镜头，含 s02 上的命名事件。 */
function dualShotFilm() {
  return {
    format: 'film/3.0',
    id: 'f_dual',
    output: { size: SIZE, fps: '24/1', frames: 24 },
    shots: [
      {
        id: 's01', in: 0, out: 12, source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene', seed: 1001,
        cards: [{ as: 'cycles', use: 'blender.cycles@1', params: {} }],
        tiers: { draft: { samples: 16 }, final: { samples: 32 } },
      },
      {
        id: 's02', in: 12, out: 24, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed: 1002,
        cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX', enter: 0 } }],
      },
    ],
    transitions: [{ id: 'cut-a', at: 12, type: 'cut' }],
    events: [{ id: 'title', frame: 'cut(12)', shot: 's02', audio: 'hit.low', sync: 'onset' }],
    style: { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#111318', paper: '#EAE6DF' } },
  };
}

function lockOf(engineRoot) {
  return {
    format: 'lock/1.0',
    machine: { class: 'local', driver: process.platform },
    assets: {},
    cards: {
      'blender.cycles': { impl: ['source:blender'], sha256: HEX('b'), version: '1.0.0' },
      'overlay.title': { impl: ['source:three'], sha256: HEX('c'), version: '1.0.0' },
      'time.events': { impl: ['data'], sha256: HEX('d'), version: '1.0.0' },
      'comp.display': { impl: ['comp'], sha256: HEX('e'), version: '1.0.0' },
    },
    seeds: { s01: 1001, s02: 1002 },
    shots: { s01: { shutterSamples: 1 }, s02: { shutterSamples: 1 } },
    sources: {
      three: { host: 'page', image: runtime.threeImage(engineRoot ? { root: engineRoot } : undefined), version: runtime.THREE_VERSION },
      blender: { host: 'cycles', image: runtime.blenderImage('5.2.0', engineRoot ? { root: engineRoot } : undefined), version: '5.2.0' },
    },
  };
}

/** 假帧源池：engineBias 模拟同一片子与同一份锁下引擎实现变动导致的像素偏移；failBbox 模拟坏编号层。 */
function fakePool(engineBias = 0, { failBbox = false } = {}) {
  const calls = {};
  const p = { renders: 0, calls };
  p.get = async (source) => ({
    async open(input, env) {
      const id = input.shot.id;
      calls[id] ??= { open: 0, render: 0 };
      calls[id].open++;
      const [w, h] = input.output.size;
      let n = 0;
      return {
        async render(f) {
          p.renders++;
          calls[id].render++;
          const color = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 1 : 0.2 + 0.002 * f + engineBias));
          const colorBytes = Buffer.from(color.buffer);
          const ids = failBbox
            ? Buffer.from(new Uint32Array(w * h).map((_, i) => (i % w < w / 4 ? 1 : 0)).buffer)
            : Buffer.from(new Uint32Array(w * h).fill(1).buffer);
          const sub = `r${String(n++).padStart(3, '0')}-f${String(f).padStart(4, '0')}`;
          mkdirSync(join(env.workspace, sub), { recursive: true });
          writeFileSync(join(env.workspace, sub, 'color.f32'), colorBytes);
          writeFileSync(join(env.workspace, sub, 'objectId.u32'), ids);
          const meta = {
            format: 'meta/0.1',
            film: input.film,
            shot: id,
            frame: input.shot.in + f,
            shotFrame: f,
            size: [w, h],
            entities: [{ id: 1, name: 'body', bbox2d: [0, 0, w, h] }],
            events: [],
            source: { id: source, renderer: source, tier: env.tier, backend: 'fake', gpu: 'fake-gpu' },
            timing: { stateMs: 1, renderMs: 2, readbackMs: 1 },
            hash: { color: `sha256:${sha256(colorBytes)}` },
          };
          return {
            meta,
            layers: {
              color: { file: `${sub}/color.f32`, shape: [h, w, 4] },
              objectId: { file: `${sub}/objectId.u32`, shape: [h, w, 1] },
            },
          };
        },
        async close() {},
      };
    },
  });
  return p;
}

const firstRed = (res) => Number(readFileSync(res.records[0].color).readFloatLE(0).toFixed(3));
const allReds = (res) => res.records.map((r) => Number(readFileSync(r.color).readFloatLE(0).toFixed(3)));

/* ---------------- 1. engineCodeDigest 与 liveCardsDigest 单元测试 ---------------- */

test('engineCodeDigest 实时无缓存、按帧源隔离、跳过非运行时文件并防改名与空目录碰撞', () => {
  assert.equal(typeof runtime.engineCodeDigest, 'function', 'runtime.mjs 必须导出 engineCodeDigest');
  const root = makeEngineRoot('unit-digest');

  const dThree1 = runtime.engineCodeDigest('three', { root });
  const dBlender1 = runtime.engineCodeDigest('blender', { root });
  assert.match(dThree1, /^sha256:[a-f0-9]{64}$/);
  assert.match(dBlender1, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(dThree1, dBlender1);
  assert.equal(runtime.engineCodeDigest('three', { root }), dThree1, '未改动时确定性一致');

  // 跳过 *.test.*、*.md、out/、__pycache__/、.git/、node_modules/
  writeText(root, 'beiming/sources/three/extra.test.mjs', 'test content');
  writeText(root, 'beiming/sources/three/README.md', '# doc');
  writeText(root, 'beiming/sources/three/out/tmp.js', 'out');
  writeText(root, 'beiming/sources/three/__pycache__/a.pyc', 'pyc');
  writeText(root, 'beiming/sources/three/.git/HEAD', 'ref: refs/heads/main');
  writeText(root, 'beiming/sources/three/node_modules/pkg/index.js', 'pkg');
  writeText(root, 'routes/c-style/fonts/README.md', '# fonts doc');
  assert.equal(runtime.engineCodeDigest('three', { root }), dThree1, '非运行时文件与排除目录不改变摘要');

  // 改 three 仅变 three，不变 blender
  writeText(root, 'beiming/sources/three/source.js', 'export const THREE_SRC = 2;\n');
  const dThree2 = runtime.engineCodeDigest('three', { root });
  assert.notEqual(dThree2, dThree1, '改 three 源码实时改变 three 摘要（无启动期缓存）');
  assert.equal(runtime.engineCodeDigest('blender', { root }), dBlender1, '改 three 源码不改变 blender 摘要');

  // 改 host/page 仅变 three，不变 blender
  writeText(root, 'beiming/host/page/runtime.js', 'export const PAGE_HOST = 2;\n');
  const dThree3 = runtime.engineCodeDigest('three', { root });
  assert.notEqual(dThree3, dThree2, '改 host/page 实时改变 three 摘要');
  assert.equal(runtime.engineCodeDigest('blender', { root }), dBlender1, '改 host/page 不改变 blender 摘要');

  // 改 blender 仅变 blender，不变 three
  writeText(root, 'beiming/sources/blender/worker.py', 'BLENDER_WORKER = 2\n');
  const dBlender2 = runtime.engineCodeDigest('blender', { root });
  assert.notEqual(dBlender2, dBlender1, '改 blender 源码实时改变 blender 摘要');
  assert.equal(runtime.engineCodeDigest('three', { root }), dThree3, '改 blender 源码不改变 three 摘要');

  // 改 kernel/eval 同时变 three 与 blender
  writeText(root, 'beiming/kernel/eval/events.mjs', 'export const EVENTS_VER = 2;\n');
  const dThree4 = runtime.engineCodeDigest('three', { root });
  const dBlender3 = runtime.engineCodeDigest('blender', { root });
  assert.notEqual(dThree4, dThree3, '改 kernel/eval 改变 three 摘要');
  assert.notEqual(dBlender3, dBlender2, '改 kernel/eval 改变 blender 摘要');

  // 改字体文件（fonts.json 与 .woff2/.ttf/.otf）同时变 three 与 blender
  writeText(root, 'routes/c-style/fonts/mashanzheng-00.woff2', 'WOFF2-BYTES-V2');
  const dThree5 = runtime.engineCodeDigest('three', { root });
  const dBlender4 = runtime.engineCodeDigest('blender', { root });
  assert.notEqual(dThree5, dThree4, '改 .woff2 字体改变 three 摘要');
  assert.notEqual(dBlender4, dBlender3, '改 .woff2 字体改变 blender 摘要');

  writeText(root, 'routes/c-style/fonts/fonts.json', '{"version":2,"fonts":["demo"]}\n');
  const dThree6 = runtime.engineCodeDigest('three', { root });
  const dBlender5 = runtime.engineCodeDigest('blender', { root });
  assert.notEqual(dThree6, dThree5, '改 fonts.json 改变 three 摘要');
  assert.notEqual(dBlender5, dBlender4, '改 fonts.json 改变 blender 摘要');

  // 文件改名碰撞防护：内容完全相同但文件名改名后摘要必变
  const fileA = writeText(root, 'beiming/sources/three/alpha.js', 'export const SAME = 42;\n');
  const beforeRename = runtime.engineCodeDigest('three', { root });
  renameSync(fileA, join(root, 'beiming/sources/three/beta.js'));
  const afterRename = runtime.engineCodeDigest('three', { root });
  assert.notEqual(afterRename, beforeRename, '同内容文件改名摘要必须变化');

  // 其他帧源：无目录时含共用输入且区分 missing / 空目录，有目录时纳入 beiming/sources/<source>/
  const dCustomMissing = runtime.engineCodeDigest('custom', { root });
  mkdirSync(join(root, 'beiming/sources/custom'), { recursive: true });
  const dCustomEmpty = runtime.engineCodeDigest('custom', { root });
  assert.notEqual(dCustomEmpty, dCustomMissing, '空目录与目录不存在不能碰撞');
  writeText(root, 'beiming/sources/custom/render.mjs', 'export const CUSTOM = 1;\n');
  const dCustomWithFile = runtime.engineCodeDigest('custom', { root });
  assert.notEqual(dCustomWithFile, dCustomEmpty, '其他帧源目录代码进摘要');
  assert.equal(runtime.engineCodeDigest('three', { root }), afterRename, '其他帧源变动不影响 three');
});

test('liveCardsDigest 按次实时哈希指定卡的非测试文件、不扫描无关卡、合成卡名确定性标 missing', () => {
  assert.equal(typeof runtime.liveCardsDigest, 'function', 'runtime.mjs 必须导出 liveCardsDigest');
  const root = makeEngineRoot('unit-cards');

  const dTitle1 = runtime.liveCardsDigest(['overlay.title'], { root });
  const dCycles1 = runtime.liveCardsDigest(['blender.cycles'], { root });
  assert.match(dTitle1, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(dTitle1, dCycles1);
  assert.equal(
    runtime.liveCardsDigest(['overlay.title', 'time.events'], { root }),
    runtime.liveCardsDigest(['time.events', 'overlay.title'], { root }),
    '卡列表顺序不影响摘要',
  );

  // 改测试文件与文档不影响摘要
  writeText(root, 'beiming/cards/two-d/overlay-title/selftest.test.mjs', 'export const TEST_ONLY = 99;\n');
  writeText(root, 'beiming/cards/two-d/overlay-title/README.md', '# title card\n');
  assert.equal(runtime.liveCardsDigest(['overlay.title'], { root }), dTitle1);

  // 改 overlay.title 运行时实现仅改变 overlay.title，不影响 blender.cycles
  writeText(root, 'beiming/cards/two-d/overlay-title/three.js', 'export const TITLE_CARD = 2;\n');
  const dTitle2 = runtime.liveCardsDigest(['overlay.title'], { root });
  assert.notEqual(dTitle2, dTitle1, '改卡代码实时变化');
  assert.equal(runtime.liveCardsDigest(['blender.cycles'], { root }), dCycles1, '不扫描无关卡');

  // 找不到的合成测试卡名确定性标记 missing
  const dMissingA = runtime.liveCardsDigest(['synthetic.missing-a'], { root });
  const dMissingB = runtime.liveCardsDigest(['synthetic.missing-b'], { root });
  const dEmpty = runtime.liveCardsDigest([], { root });
  assert.equal(dMissingA, runtime.liveCardsDigest(['synthetic.missing-a'], { root }));
  assert.notEqual(dMissingA, dMissingB);
  assert.notEqual(dMissingA, dEmpty);
});

/* ---------------- 2. threeImage 与 blenderImage 绑定引擎代码与字体 ---------------- */

test('threeImage 与 blenderImage 实时纳入引擎代码与字体摘要，不再仅哈希上游构建或版本串', () => {
  // 真实仓库对照复现脚本 cache/engine-change.mjs 第 23-24 行
  const threeModule = join(REPO, 'node_modules/three-webgpu/build/three.module.js');
  if (existsSync(threeModule)) {
    const rawUpstreamOnly = `sha256:${sha256(readFileSync(threeModule))}`;
    assert.notEqual(runtime.threeImage(), rawUpstreamOnly, 'threeImage() 不得再仅等于 three.module.js 摘要');
  }
  const rawBlenderOnly = `sha256:${sha256(Buffer.from('blender 5.2.0 cycles'))}`;
  assert.notEqual(runtime.blenderImage('5.2.0'), rawBlenderOnly, 'blenderImage() 不得再仅等于版本字符串摘要');

  const root = makeEngineRoot('unit-images');
  const t1 = runtime.threeImage({ root });
  const b1 = runtime.blenderImage('5.2.0', { root });
  assert.match(t1, /^sha256:[a-f0-9]{64}$/);
  assert.match(b1, /^sha256:[a-f0-9]{64}$/);

  // 改 three 代码：threeImage 立即变，blenderImage 不变
  writeText(root, 'beiming/sources/three/source.js', 'export const THREE_SRC = 99;\n');
  const t2 = runtime.threeImage({ root });
  assert.notEqual(t2, t1);
  assert.equal(runtime.blenderImage('5.2.0', { root }), b1);

  // 改 blender 代码：blenderImage 立即变，threeImage 不变
  writeText(root, 'beiming/sources/blender/runtime.py', 'BLENDER_RUNTIME = 99\n');
  const b2 = runtime.blenderImage('5.2.0', { root });
  assert.notEqual(b2, b1);
  assert.equal(runtime.threeImage({ root }), t2);

  // 改字体：两者同时变
  writeText(root, 'routes/c-style/fonts/demo.otf', 'OTF-BYTES-V2');
  const t3 = runtime.threeImage({ root });
  const b3 = runtime.blenderImage('5.2.0', { root });
  assert.notEqual(t3, t2);
  assert.notEqual(b3, b2);

  // 上游 three.module.js / blender version 仍然参与哈希
  writeText(root, 'node_modules/three-webgpu/build/three.module.js', 'export const REVISION = "188";\n');
  assert.notEqual(runtime.threeImage({ root }), t3, 'three 构建产物仍进摘要');
  assert.notEqual(runtime.blenderImage('5.2.1', { root }), b3, 'blender 版本号仍进摘要');
});

/* ---------------- 3. 缺陷 #1 复现与回归：旧锁不改、仅改代码/字体/卡必重渲且不混帧 ---------------- */

test('缺陷 #1 场景 1：同一片子 + 同一份旧锁，仅改帧源/宿主/求值核/字体/卡文件，第 2 轮命中 0 帧并产出新像素', { skip: noFfmpeg }, async (t) => {
  const mutations = [
    ['three 帧源代码', 'beiming/sources/three/source.js', 'export const THREE_SRC = 2;\n'],
    ['page 页面宿主代码', 'beiming/host/page/runtime.js', 'export const PAGE_HOST = 2;\n'],
    ['kernel/eval 求值核', 'beiming/kernel/eval/time.mjs', 'export const TIME_VER = 2;\n'],
    ['字体清单 fonts.json', 'routes/c-style/fonts/fonts.json', '{"version":2,"fonts":["demo"]}\n'],
    ['字体二进制 .woff2', 'routes/c-style/fonts/mashanzheng-00.woff2', 'WOFF2-BYTES-V2'],
    ['镜头所用卡实现代码', 'beiming/cards/two-d/overlay-title/three.js', 'export const TITLE_CARD = 2;\n'],
  ];

  for (const [idx, [label, relPath, nextText]] of mutations.entries()) {
    await t.test(label, async () => {
      const engineRoot = makeEngineRoot(`sc1-${idx}`);
      const workRoot = join(tmpRoot, `sc1-work-${idx}`);
      mkdirSync(workRoot, { recursive: true });
      const film = singleThreeFilm();
      const lock = lockOf(engineRoot); // 故意保持同一份旧锁不变
      const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));
      const plan = [{ shot: film.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }];

      const oldPool = fakePool(0);
      const r1 = await pipeline.renderPlan({
        film, lock, filmDir: workRoot, tier: 'final', plan, outDir: join(workRoot, 'job-1'),
        pool: oldPool, lutPath, cache, engineRoot,
      });
      assert.deepEqual([r1.renderedFrames, r1.cachedFrames, firstRed(r1)], [12, 0, 0.2]);

      // 仅修改引擎/宿主/求值核/字体/卡文件，片子和锁一字未动
      writeText(engineRoot, relPath, nextText);

      const newPool = fakePool(0.3);
      const r2 = await pipeline.renderPlan({
        film, lock, filmDir: workRoot, tier: 'final', plan, outDir: join(workRoot, 'job-2'),
        pool: newPool, lutPath, cache, engineRoot,
      });
      assert.deepEqual([r2.renderedFrames, r2.cachedFrames, newPool.renders], [12, 0, 12], `${label} 变更后必须命中 0 帧并完整重渲 12 帧`);
      assert.equal(firstRed(r2), 0.5, `${label} 变更后必须产出新像素 0.500，不能复出旧帧 0.200`);
    });
  }
});

test('缺陷 #1 场景 2：半途中断（先渲 0..5）后改引擎代码再续渲（0..11），全部 12 帧以新版重渲绝不混帧；同作业内共享快照', { skip: noFfmpeg }, async () => {
  const engineRoot = makeEngineRoot('sc2-resume');
  const workRoot = join(tmpRoot, 'sc2-work');
  mkdirSync(workRoot, { recursive: true });
  const film = singleThreeFilm();
  const lock = lockOf(engineRoot);
  const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));

  // 半途渲染 0..5（旧代码）
  const r1 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3, 4, 5] }],
    outDir: join(workRoot, 'mix-1'),
    pool: fakePool(0), lutPath, cache, engineRoot,
  });
  assert.deepEqual([r1.renderedFrames, r1.cachedFrames], [6, 0]);

  // 改引擎代码后再续渲全镜 0..11（片子与锁未动）
  writeText(engineRoot, 'beiming/sources/three/source.js', 'export const THREE_SRC = 2;\n');
  const r2 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }],
    outDir: join(workRoot, 'mix-2'),
    pool: fakePool(0.3), lutPath, cache, engineRoot,
  });
  assert.deepEqual([r2.renderedFrames, r2.cachedFrames], [12, 0], '续渲必须命中 0 帧，整镜重渲');
  const expectedNew = Array.from({ length: 12 }, (_, f) => Number((0.5 + 0.002 * f).toFixed(3)));
  assert.deepEqual(allReds(r2), expectedNew, '全部 12 帧必须都是新版像素，严禁 0..5 混入旧版 0.20x');

  // 同一作业内共享作业开始时的引擎快照，下一作业才重算
  const cacheIntra = openShotCache(join(workRoot, 'deliver-intra', '.shot-cache'));
  let framesDone = 0;
  const rIntra1 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3] }],
    outDir: join(workRoot, 'intra-1'),
    pool: fakePool(0.3), lutPath, cache: cacheIntra, engineRoot,
    onFrame() {
      framesDone++;
      if (framesDone === 2) {
        // 作业中途改盘，本作业 0..3 应全写入同一份快照键，下一作业再重算失效
        writeText(engineRoot, 'beiming/sources/three/source.js', 'export const THREE_SRC = 3;\n');
      }
    },
  });
  assert.deepEqual([rIntra1.renderedFrames, rIntra1.cachedFrames], [4, 0]);
  // 验证下一作业立即感知到 THREE_SRC = 3，全部重渲
  const rIntra2 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3] }],
    outDir: join(workRoot, 'intra-2'),
    pool: fakePool(0.4), lutPath, cache: cacheIntra, engineRoot,
  });
  assert.deepEqual([rIntra2.renderedFrames, rIntra2.cachedFrames], [4, 0], '下一作业立即感知到磁盘变更并重渲');
});

test('缺陷 #1 场景 3：帧源与卡按依赖隔离失效，kernel/eval 与字体变动使双镜头同失效；layerL2 同步 engineRoot 失效缓存', { skip: noFfmpeg }, async () => {
  const engineRoot = makeEngineRoot('sc3-isolation');
  const workRoot = join(tmpRoot, 'sc3-work');
  mkdirSync(workRoot, { recursive: true });
  const film = dualShotFilm();
  const lock = lockOf(engineRoot);
  const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));
  const plan = film.shots.map((shot) => ({ shot, frames: Array.from({ length: shot.out - shot.in }, (_, i) => shot.in + i) }));
  let seq = 0;
  const run = (bias = 0, opts = {}) => pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final', plan,
    outDir: join(workRoot, `run-${++seq}`), pool: fakePool(bias, opts), lutPath, cache, engineRoot,
  });

  const cold = await run(0);
  assert.deepEqual(cold.shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ]);

  // 1) 改 three 代码：仅 s02 失配，s01 100% 命中
  writeText(engineRoot, 'beiming/sources/three/source.js', 'export const THREE_SRC = 2;\n');
  assert.deepEqual((await run(0.1)).shots, [
    { shot: 's01', renderedFrames: 0, cachedFrames: 12 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '改 three 仅使 three 镜头失配');

  // 2) 改 blender 代码：仅 s01 失配，s02 100% 命中
  writeText(engineRoot, 'beiming/sources/blender/worker.py', 'BLENDER_WORKER = 2\n');
  assert.deepEqual((await run(0.2)).shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 0, cachedFrames: 12 },
  ], '改 blender 仅使 blender 镜头失配');

  // 3) 改 overlay.title 卡代码：仅 s02 失配，s01 100% 命中
  writeText(engineRoot, 'beiming/cards/two-d/overlay-title/three.js', 'export const TITLE_CARD = 2;\n');
  assert.deepEqual((await run(0.25)).shots, [
    { shot: 's01', renderedFrames: 0, cachedFrames: 12 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '改 overlay.title 卡仅使使用该卡的 s02 失配');

  // 4) 改 blender.cycles 卡代码：仅 s01 失配，s02 100% 命中
  writeText(engineRoot, 'beiming/cards/mechanism/blender-cycles/cycles.py', 'CYCLES_CARD = 2\n');
  assert.deepEqual((await run(0.3)).shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 0, cachedFrames: 12 },
  ], '改 blender.cycles 卡仅使使用该卡的 s01 失配');

  // 5) 改 kernel/eval：双镜头均失配
  writeText(engineRoot, 'beiming/kernel/eval/interp.mjs', 'export const INTERP_VER = 2;\n');
  assert.deepEqual((await run(0.35)).shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '改 kernel/eval 使两类镜头均失配');

  // 6) 改字体：双镜头均失配
  writeText(engineRoot, 'routes/c-style/fonts/mashanzheng-00.woff2', 'WOFF2-BYTES-V2');
  const afterFont = await run(0.4);
  assert.deepEqual(afterFont.shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '改字体使两类镜头均失配');

  // 7) layerL2 独立核验模式（不传 versions）传 engineRoot 必须按同一键失效坏镜头缓存
  const badRes = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final', plan: [plan[1]],
    outDir: join(workRoot, `run-${++seq}`), pool: fakePool(0.4, { failBbox: true }), lutPath, cache: undefined,
  });
  const l2 = await pipeline.layerL2({
    film, lock, filmDir: workRoot, shots: [film.shots[1]], records: badRes.records,
    pool: fakePool(0.4), scratch: join(workRoot, 'l2-scratch'), cache, tier: 'final', engineRoot,
  });
  assert.equal(l2.ok, false, '坏包围盒必须判 L2 未过');
  const afterRetire = await run(0.4);
  assert.deepEqual(afterRetire.shots, [
    { shot: 's01', renderedFrames: 0, cachedFrames: 12 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], 'layerL2 传 engineRoot 必须精确作废 s02 在该 engineRoot 下的缓存而不误伤 s01');
});

/* ---------------- 4. 缺陷 #4 复现与回归：全片事件表进键 ---------------- */

test('缺陷 #4 场景 4：全片任意事件变更使全片所有镜头缓存键失效，runtimeEnv 仍严格保持 5 个 ENV_KEYS', { skip: noFfmpeg }, async () => {
  const engineRoot = makeEngineRoot('sc4-events');
  const workRoot = join(tmpRoot, 'sc4-work');
  mkdirSync(workRoot, { recursive: true });
  const film = dualShotFilm();
  const lock = lockOf(engineRoot);

  // buildShotCacheInputs 必须将完整全片事件表写入每个镜头键，且保持 5 个 ENV_KEYS 不变
  const [inS01, inS02] = film.shots.map((shot) => pipeline.buildShotCacheInputs({ film, lock, shot, filmDir: workRoot, tier: 'final', engineRoot }));
  assert.deepEqual(Object.keys(inS01.runtimeEnv).sort(), ['browserBuild', 'driver', 'gpuBackend', 'runtimeVersion', 'source']);
  assert.deepEqual(inS01.events.map((e) => [e.kind, e.frame, e.id]), [['cut', 12, 'cut.12'], ['named', 12, 'title']]);
  assert.deepEqual(inS01.events, inS02.events, 's01 与 s02 纳入同一份完整全片事件表');

  // 键输入必须能直接通过 jobs/cache.mjs computeFrameCacheKey 严格校验
  const { determinism, tier, samples, size, subs, layers, ...fiveS01 } = inS01;
  const k1 = computeFrameCacheKey({ ...fiveS01, renderSpec: { tier, samples, size, frame: 0, subs, layers } });

  const filmEventMoved = structuredClone(film);
  filmEventMoved.events[0].frame = 'cut(12) + 2';
  const { determinism: _d, tier: _t, samples: _sa, size: _sz, subs: _su, layers: _l, ...fiveS01Moved } =
    pipeline.buildShotCacheInputs({ film: filmEventMoved, lock, shot: filmEventMoved.shots[0], filmDir: workRoot, tier: 'final', engineRoot });
  const k2 = computeFrameCacheKey({ ...fiveS01Moved, renderSpec: { tier, samples, size, frame: 0, subs, layers } });
  assert.notEqual(k2.key, k1.key, '改 s02 的事件必须使 s01 缓存键变化');

  // 端到端 renderPlan：先冷渲，改 s02 的事件或新增 s02 事件均使 s01 与 s02 同时重渲；仅改 s02 参数仍命中 s01
  const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));
  let seq = 0;
  const runFilm = (f) => pipeline.renderPlan({
    film: f, lock, filmDir: workRoot, tier: 'final',
    plan: f.shots.map((shot) => ({ shot, frames: Array.from({ length: shot.out - shot.in }, (_, i) => shot.in + i) })),
    outDir: join(workRoot, `ev-${++seq}`), pool: fakePool(0), lutPath, cache, engineRoot,
  });

  await runFilm(film);
  const onlyParam = structuredClone(film);
  onlyParam.shots[1].cards[0].params.text = 'ONLY_S02';
  assert.deepEqual((await runFilm(onlyParam)).shots, [
    { shot: 's01', renderedFrames: 0, cachedFrames: 12 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '仅改 s02 参数时 s01 仍 100% 命中');

  const addedInS02 = structuredClone(onlyParam);
  addedInS02.events.push({ id: 'cue', frame: 18, shot: 's02' });
  assert.deepEqual((await runFilm(addedInS02)).shots, [
    { shot: 's01', renderedFrames: 12, cachedFrames: 0 },
    { shot: 's02', renderedFrames: 12, cachedFrames: 0 },
  ], '在 s02 新增事件必须使 s01 与 s02 缓存键全部失效重渲');
});

/* ---------------- 5. 场景 5：同进程不重启 HTTP 服务，实时签锁、交付锁与旧缓存失效 ---------------- */

test('场景 5：同一进程内不重启服务，改字体、引擎代码或卡代码后新签 film.lock 与交付锁立即变化且旧缓存失效', { skip: noFfmpeg }, async (t) => {
  // 在临时目录建立独立仓库副本，直接加载副本内的 server.mjs 与 pipeline.mjs，彻底不触碰真仓库文件
  const isoRepo = join(tmpRoot, 'iso-repo');
  mkdirSync(join(isoRepo, 'routes/c-style'), { recursive: true });
  cpSync(join(REPO, 'beiming'), join(isoRepo, 'beiming'), { recursive: true });
  cpSync(join(REPO, 'routes/c-style/fonts'), join(isoRepo, 'routes/c-style/fonts'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(isoRepo, 'package.json'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dirName of ['engine', 'tools', 'node_modules']) {
    if (existsSync(join(REPO, dirName))) {
      symlinkSync(join(REPO, dirName), join(isoRepo, dirName), linkType);
    }
  }

  const isoApi = await import(pathToFileURL(join(isoRepo, 'beiming/api/index.mjs')).href);
  const isoPipeline = await import(pathToFileURL(join(isoRepo, 'beiming/api/pipeline.mjs')).href);
  const isoJobs = await import(pathToFileURL(join(isoRepo, 'beiming/jobs/index.mjs')).href);

  const dataDir = join(tmpRoot, 'iso-data');
  // 预置 agx-mhc 查找表，避免无/有 Blender 差异拖慢测试
  mkdirSync(join(dataDir, 'view'), { recursive: true });
  writeFileSync(join(dataDir, 'view', 'agx-mhc.cube'), runtime.analyticAgxCube());

  const account = isoApi.issueAccountToken(dataDir);
  const server = await isoApi.startServer({ dataDir, port: 0, reviewer: null });
  t.after(() => server.close());

  const call = async (method, path, token, payload) => {
    const res = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { http: res.status, body: await res.json() };
  };

  // rev 1：建片签锁
  const created = await call('POST', '/v1/films', account, {
    template: 'title',
    output: { size: SIZE, fps: '24/1', frames: 12 },
  });
  assert.equal(created.http, 200, JSON.stringify(created.body));
  const { film: filmId, token } = created.body.data;
  const filmDir = join(dataDir, 'films', filmId);
  const readLock = () => JSON.parse(readFileSync(join(filmDir, 'film.lock'), 'utf8'));
  const readFilm = () => JSON.parse(readFileSync(join(filmDir, 'film.json'), 'utf8'));

  const lock1 = readLock();
  const film1 = readFilm();
  const cache = isoJobs.openShotCache(join(filmDir, 'deliver', '.shot-cache'));
  const plan1 = [{ shot: film1.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }];
  const r1 = await isoPipeline.renderPlan({
    film: film1, lock: lock1, filmDir, tier: 'final', plan: plan1,
    outDir: join(tmpRoot, 'iso-render-1'), pool: fakePool(0), lutPath, cache,
  });
  assert.deepEqual([r1.renderedFrames, r1.cachedFrames], [12, 0]);

  // 1) 不重启服务，仅改字体文件 → 同进程重签 rev 2，sources.three.image 立即变化，卡摘要不变，旧缓存失效
  const fontJsonPath = join(isoRepo, 'routes/c-style/fonts/fonts.json');
  writeFileSync(fontJsonPath, `${readFileSync(fontJsonPath, 'utf8')}\n`);
  const put2 = await call('PUT', `/v1/films/${filmId}/film`, token, {
    format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'title', value: 'Font Updated' }],
  });
  assert.equal(put2.http, 200, JSON.stringify(put2.body));
  const lock2 = readLock();
  assert.notEqual(lock2.sources.three.image, lock1.sources.three.image, '不重启服务改字体后新签 film.lock 的 sources.three.image 必须立即变化');
  assert.equal(lock2.cards['overlay.title'].sha256, lock1.cards['overlay.title'].sha256, '仅改字体不影响卡摘要');

  // 旧锁 + 旧片子在同缓存中亦因实时 engineCodeDigest 自动失效
  const rAfterFont = await isoPipeline.renderPlan({
    film: film1, lock: lock1, filmDir, tier: 'final', plan: plan1,
    outDir: join(tmpRoot, 'iso-render-2'), pool: fakePool(0.2), lutPath, cache,
  });
  assert.deepEqual([rAfterFont.renderedFrames, rAfterFont.cachedFrames], [12, 0], '改字体后旧缓存自动失效');

  // 2) 不重启服务，再改 three 引擎代码与 overlay.title 卡代码 → 同进程重签 rev 3，sources.three.image 与 cards['overlay.title'].sha256 同步变化
  const threeSrcPath = join(isoRepo, 'beiming/sources/three/source.js');
  writeFileSync(threeSrcPath, `${readFileSync(threeSrcPath, 'utf8')}\n// live-digest-probe\n`);
  const cardJsPath = join(isoRepo, 'beiming/cards/two-d/overlay-title/three.js');
  writeFileSync(cardJsPath, `${readFileSync(cardJsPath, 'utf8')}\n// live-card-probe\n`);

  const put3 = await call('PUT', `/v1/films/${filmId}/film`, token, {
    format: 'patch/0.1', rev: 2, ops: [{ op: 'set', path: 'title', value: 'Engine And Card Updated' }],
  });
  assert.equal(put3.http, 200, JSON.stringify(put3.body));
  const lock3 = readLock();
  const film3 = readFilm();
  assert.notEqual(lock3.sources.three.image, lock2.sources.three.image, '不重启服务改 three 源码后 sources.three.image 必须立即变化');
  assert.notEqual(lock3.cards['overlay.title'].sha256, lock2.cards['overlay.title'].sha256, 'commit() 必须实时 loadCardLibrary() 而非复用启动期陈旧卡库');

  // 交付锁 bundle/film.lock 同步携带最新的 sources.three.image 与卡摘要
  const plan3 = [{ shot: film3.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }];
  const r3 = await isoPipeline.renderPlan({
    film: film3, lock: lock3, filmDir, tier: 'final', plan: plan3,
    outDir: join(tmpRoot, 'iso-render-3'), pool: fakePool(0.3), lutPath, cache,
  });
  assert.deepEqual([r3.renderedFrames, r3.cachedFrames], [12, 0]);
  const bundle = isoPipeline.deliverBundle({
    film: film3,
    lock: join(filmDir, 'film.lock'),
    records: r3.records,
    lutPath,
    outDir: join(tmpRoot, 'iso-bundle'),
  });
  const deliveredLock = JSON.parse(readFileSync(join(bundle.dir, 'film.lock'), 'utf8'));
  assert.equal(deliveredLock.sources.three.image, lock3.sources.three.image, '交付锁 sources.three.image 与最新实签锁一致');
  assert.notEqual(deliveredLock.sources.three.image, lock1.sources.three.image, '交付锁已更新为最新引擎+字体摘要');
  assert.equal(deliveredLock.cards['overlay.title'].sha256, lock3.cards['overlay.title'].sha256, '交付锁卡摘要已实时更新');
});

/* ---------------- 6. R1 Astra 六项【甲】类阻断定向回归测试 ---------------- */

/** 构造带真实 loadCards + planOpen 校验、免无头浏览器启动的临时隔离仓库副本。 */
function makeIsolatedServerRepo(name) {
  const isoRepo = join(tmpRoot, name);
  mkdirSync(join(isoRepo, 'routes/c-style'), { recursive: true });
  cpSync(join(REPO, 'beiming'), join(isoRepo, 'beiming'), { recursive: true });
  cpSync(join(REPO, 'routes/c-style/fonts'), join(isoRepo, 'routes/c-style/fonts'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(isoRepo, 'package.json'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dirName of ['engine', 'tools', 'node_modules']) {
    if (existsSync(join(REPO, dirName))) {
      symlinkSync(join(REPO, dirName), join(isoRepo, dirName), linkType);
    }
  }
  // 在临时副本内替换 host.mjs 的 startSource：保留真实 loadCards、caps、planOpen、planRender 契约校验，
  // 像素颜色同时受 Node 内存 shotInput(input.tokens) 与磁盘浏览器脚本/字体影响，避免无 GPU 环境跳过。
  const hostPath = join(isoRepo, 'beiming/host/page/host.mjs');
  const origHost = readFileSync(hostPath, 'utf8');
  const cutAt = origHost.indexOf('export async function startSource');
  assert.ok(cutAt > 0, 'host.mjs 必须包含 startSource');
  const stubbedHost = `${origHost.slice(0, cutAt)}
export async function startSource({ cards = [] } = {}) {
  const library = await loadCards(cards);
  const CAPS = caps(library);
  return {
    caps: () => structuredClone(CAPS),
    async open(liveInput, liveEnv) {
      const missing = ENV_KEYS.filter((k) => liveEnv?.[k] === undefined);
      if (missing.length) throw new SourceError('usage.bad-argument', 'env 缺 ' + missing.join('、'));
      const input = structuredClone(liveInput);
      const env = structuredClone(Object.fromEntries(ENV_KEYS.map((k) => [k, liveEnv[k]])));
      const locked = planOpen(CAPS, input, env, library);
      let renders = 0;
      return {
        manifest: () => ({ format: 'manifest/0.1', frames: input.shot.out - input.shot.in, entities: [{ id: 1, name: 'title' }] }),
        async render(f, opts = {}, want = ['color', 'objectId', 'meta']) {
          const { size } = planRender(CAPS, input.shot, input.output.size, env.tier, opts, want, locked);
          const [w, h] = size;
          const diskRuntime = await readFile(join(REPO, 'beiming/host/page/runtime.js'));
          const diskFonts = await readFile(join(REPO, 'routes/c-style/fonts/fonts.json'));
          const seedHex = sha256(Buffer.concat([
            Buffer.from(JSON.stringify({ tokens: input.tokens ?? null, cards: input.shot.cards ?? null, overlays: input.overlays ?? null })),
            diskRuntime,
            diskFonts,
          ]));
          const base = (parseInt(seedHex.slice(0, 6), 16) % 600) / 1000 + 0.15;
          const x0 = Math.max(1, Math.round(w * 0.1)), y0 = Math.max(1, Math.round(h * 0.1));
          const x1 = Math.max(x0 + 1, Math.round(w * 0.9)), y1 = Math.max(y0 + 1, Math.round(h * 0.9));
          const color = new Float32Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 1 : base + 0.002 * f + 0.0001 * (i % 13)));
          const colorBytes = Buffer.from(color.buffer);
          const idArr = new Uint32Array(w * h);
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) idArr[y * w + x] = 1;
          }
          const idBytes = Buffer.from(idArr.buffer);
          const sub = 'r' + pad(renders++, 3) + '-f' + pad(f, 4);
          await mkdir(join(env.workspace, sub), { recursive: true });
          await writeFile(join(env.workspace, sub, 'color.f32'), colorBytes);
          await writeFile(join(env.workspace, sub, 'objectId.u32'), idBytes);
          const frame = input.shot.in + f;
          const areaFrac = ((x1 - x0) * (y1 - y0)) / (w * h);
          const heroName = input.shot.roles?.hero ?? input.shot.cards?.[0]?.as ?? 'title';
          const meta = {
            format: 'meta/0.1', film: input.film, shot: input.shot.id, frame, shotFrame: f, size: [w, h],
            entities: [{ id: 1, name: heroName, role: 'hero', bbox2d: [x0, y0, x1, y1], pxArea: areaFrac, visible: 1 }],
            texts: [{ id: heroName, text: input.shot.cards?.[0]?.params?.text ?? 'TITLE', bbox2d: [x0, y0, x1, y1] }],
            events: (input.events?.events ?? []).filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame })),
            stats: { luma: { p1: 0.08, p50: base, p99: base + 0.08 }, clip: { black: 0, white: 0 } },
            source: { id: 'three', renderer: 'three', tier: env.tier, backend: 'stub', gpu: 'stub-gpu' },
            timing: { stateMs: 1, renderMs: 1, readbackMs: 1 },
            hash: { color: 'sha256:' + sha256(colorBytes) },
          };
          return {
            meta,
            layers: {
              color: { file: sub + '/color.f32', shape: [h, w, 4], components: ['R', 'G', 'B', 'A'], hash: 'sha256:' + sha256(colorBytes) },
              objectId: { file: sub + '/objectId.u32', shape: [h, w, 1], components: ['id'], hash: 'sha256:' + sha256(idBytes) },
            },
          };
        },
        async query() { return {}; },
        async close() {},
      };
    },
    async stop() {},
  };
}
`;
  writeFileSync(hostPath, stubbedHost);
  return isoRepo;
}

test('R1【甲】#1：热进程静态导入的 Node ESM 走启动期有效摘要不污染新键，重启后 0 命中重渲全片新像素，浏览器脚本与字体仍实时生效', { skip: noFfmpeg }, () => {
  const isoRepo = makeIsolatedServerRepo('r1-1-effective-esm');
  const cacheDir = join(tmpRoot, 'r1-1-shot-cache');
  const workDir = join(tmpRoot, 'r1-1-work');
  mkdirSync(workDir, { recursive: true });

  const workerScript = join(tmpRoot, 'r1-1-worker.mjs');
  writeFileSync(workerScript, `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';

    const [mode, isoRepo, workDir, cacheDir, lutPath] = process.argv.slice(2);
    const runtime = await import(pathToFileURL(join(isoRepo, 'beiming/api/runtime.mjs')).href);
    const pipeline = await import(pathToFileURL(join(isoRepo, 'beiming/api/pipeline.mjs')).href);
    const { startSource } = await import(pathToFileURL(join(isoRepo, 'beiming/host/page/host.mjs')).href);
    const { openShotCache } = await import(pathToFileURL(join(isoRepo, 'beiming/jobs/index.mjs')).href);

    const lib = runtime.loadCardLibrary();
    const src = await startSource({ cards: runtime.threeCardDirs(lib) });
    const pool = { renders: {}, get: async () => src, stop: () => src.stop() };
    const cache = openShotCache(cacheDir);
    const film = JSON.parse(readFileSync(join(workDir, 'film.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(workDir, 'film.lock'), 'utf8'));

    if (mode === 'init-lock') {
      const { scaffold } = await import(pathToFileURL(join(isoRepo, 'beiming/api/films.mjs')).href);
      const built = scaffold({ id: 'f_001', template: 'title', output: { size: [16, 8], fps: '24/1', frames: 12 } }).film;
      writeFileSync(join(workDir, 'film.json'), JSON.stringify(built, null, 2));
      const ctx = runtime.lockContext({ rev: 1, library: lib, lut: { path: lutPath, sha256: 'sha256:' + 'a'.repeat(64) }, assets: {} });
      const { generateLock } = await import(pathToFileURL(join(isoRepo, 'beiming/kernel/lock-gen.mjs')).href);
      writeFileSync(join(workDir, 'film.lock'), JSON.stringify(generateLock(built, ctx), null, 2));
      console.log(JSON.stringify({
        diskDigest: runtime.engineCodeDigest('three'),
        effectiveDigest: runtime.engineCodeDigest('three', { effective: true }),
        diskImg: runtime.threeImage(),
        effectiveImg: runtime.threeImage({ effective: true }),
      }));
      process.exit(0);
    }

    if (mode === 'hot-edit-and-half-render') {
      const beforeEff = runtime.engineCodeDigest('three', { effective: true });
      // 在本进程已静态导入 input.mjs 后修改磁盘上的 input.mjs（让重启后的新进程把 ink 改成 #00ff00）
      const inputFile = join(isoRepo, 'beiming/kernel/eval/input.mjs');
      const srcText = readFileSync(inputFile, 'utf8').replace(
        "...(film.style?.tokens ? { tokens: film.style.tokens } : {}),",
        "tokens: { ...(film.style?.tokens ?? {}), ink: '#00ff00' },"
      );
      writeFileSync(inputFile, srcText);
      const afterDisk = runtime.engineCodeDigest('three');
      const afterEff = runtime.engineCodeDigest('three', { effective: true });
      const res = await pipeline.renderPlan({
        film, lock, filmDir: workDir, tier: 'final',
        plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3, 4, 5] }],
        outDir: join(workDir, 'out-hot'), pool, lutPath, cache,
      });
      console.log(JSON.stringify({
        beforeEff, afterDisk, afterEff,
        renderedFrames: res.renderedFrames, cachedFrames: res.cachedFrames,
        hashes: res.records.map((r) => r.meta.hash.color),
      }));
      process.exit(0);
    }

    if (mode === 'restarted-continue') {
      const res = await pipeline.renderPlan({
        film, lock, filmDir: workDir, tier: 'final',
        plan: [{ shot: film.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }],
        outDir: join(workDir, 'out-restarted'), pool, lutPath, cache,
      });
      // 同进程热改浏览器端脚本 runtime.js，必须立即感知并 0 命中重渲
      const pageRuntime = join(isoRepo, 'beiming/host/page/runtime.js');
      writeFileSync(pageRuntime, readFileSync(pageRuntime, 'utf8') + '\\n// browser-hot-change\\n');
      const resBrowser = await pipeline.renderPlan({
        film, lock, filmDir: workDir, tier: 'final',
        plan: [{ shot: film.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }],
        outDir: join(workDir, 'out-browser-hot'), pool, lutPath, cache,
      });
      console.log(JSON.stringify({
        restarted: {
          renderedFrames: res.renderedFrames,
          cachedFrames: res.cachedFrames,
          hashes: res.records.map((r) => r.meta.hash.color),
        },
        browserHot: {
          renderedFrames: resBrowser.renderedFrames,
          cachedFrames: resBrowser.cachedFrames,
          hashes: resBrowser.records.map((r) => r.meta.hash.color),
        },
      }));
      process.exit(0);
    }
  `);

  const film = {
    ...singleThreeFilm(),
    title: 'R1-1',
    audio: { mode: 'none' },
    delivery: { web: true, contact: true },
    predicates: { base: 'floor@1', extra: [] },
  };
  writeFileSync(join(workDir, 'film.json'), JSON.stringify(film, null, 2));
  writeFileSync(join(workDir, 'film.lock'), '{}');

  const runWorker = (mode) => {
    const r = spawnSync(process.execPath, [workerScript, mode, isoRepo, workDir, cacheDir, lutPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout.trim());
  };

  const init = runWorker('init-lock');
  assert.equal(init.effectiveDigest, init.diskDigest, '启动时未改磁盘，effective 与磁盘摘要严格一致');
  assert.equal(init.effectiveImg, init.diskImg, '启动时 threeImage({ effective: true }) 与 threeImage() 严格一致');

  const hot = runWorker('hot-edit-and-half-render');
  assert.notEqual(hot.afterDisk, hot.beforeEff, 'effective=false 实时感知磁盘 input.mjs 修改');
  assert.notEqual(hot.afterEff, hot.beforeEff, 'three 双端加载的 input.mjs 热改后，effective=true 立即脱离旧键');
  assert.notEqual(hot.afterEff, hot.afterDisk, 'three 双端加载热改后进入含 #in-process 的混合键，不污染重启后的新版缓存键');
  assert.deepEqual([hot.renderedFrames, hot.cachedFrames], [6, 0]);

  const restarted = runWorker('restarted-continue');
  assert.deepEqual(
    [restarted.restarted.renderedFrames, restarted.restarted.cachedFrames],
    [12, 0],
    '重启加载新 input.mjs 后续渲 0..11 必须 0 命中、重渲全部 12 帧，绝不出现 6 旧 + 6 新混帧',
  );
  assert.notEqual(restarted.restarted.hashes[0], hot.hashes[0], '重启后第 0 帧必须是新版 #00ff00 像素，不得复用热进程旧像素');
  assert.deepEqual(
    [restarted.browserHot.renderedFrames, restarted.browserHot.cachedFrames],
    [12, 0],
    '热进程改浏览器脚本 runtime.js 必须实时失效重渲',
  );
  assert.notEqual(restarted.browserHot.hashes[0], restarted.restarted.hashes[0]);
});

test('R1【甲】#2：deliver 拒绝为新版引擎或字体产出的像素盖上旧版修订锁（报 env.lock-required），重签锁后交付通过', { skip: noFfmpeg }, async (t) => {
  const isoRepo = makeIsolatedServerRepo('r1-2-deliver-lock');
  const isoApi = await import(pathToFileURL(join(isoRepo, 'beiming/api/index.mjs')).href);
  const isoRuntime = await import(pathToFileURL(join(isoRepo, 'beiming/api/runtime.mjs')).href);

  const dataDir = join(tmpRoot, 'r1-2-data');
  const account = isoApi.issueAccountToken(dataDir);
  const server = await isoApi.startServer({ dataDir, port: 0, reviewer: null });
  t.after(() => server.close());

  const req = async (method, path, auth, payload) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { http: res.status, body: await res.json() };
  };
  const waitJob = async (auth, init) => {
    let cur = init;
    while (['queued', 'running'].includes(cur.body?.data?.status)) {
      cur = await req('GET', `/v1/jobs/${cur.body.data.job}?wait=30`, auth);
    }
    return cur;
  };

  const created = await req('POST', '/v1/films', account, {
    template: 'title',
    output: { size: [320, 180], fps: '24/1', frames: 12 },
  });
  assert.equal(created.http, 200, JSON.stringify(created.body));
  const { film: filmId, token } = created.body.data;

  // 同版本正常交付通过
  const d1 = await waitJob(token, await req('POST', `/v1/films/${filmId}/deliver?wait=30`, token, {}));
  assert.equal(d1.body.ok, true, JSON.stringify(d1.body));

  // 修改字体文件使运行环境镜像变为新版：独立 POST /render 仍允许重渲新像素，但保持旧修订锁调 POST /deliver 必须被拒
  const fontJsonPath = join(isoRepo, 'routes/c-style/fonts/fonts.json');
  writeFileSync(fontJsonPath, `${readFileSync(fontJsonPath, 'utf8')}\n`);

  const rNew = await waitJob(token, await req('POST', `/v1/films/${filmId}/render?wait=30`, token, { tier: 'final' }));
  assert.equal(rNew.body.ok, true, JSON.stringify(rNew.body));
  assert.deepEqual([rNew.body.data.renderedFrames, rNew.body.data.cachedFrames], [12, 0]);

  const dStale = await waitJob(token, await req('POST', `/v1/films/${filmId}/deliver?wait=30`, token, {}));
  assert.equal(dStale.body.ok, false, '旧锁与当前有效引擎/字体镜像不一致时 deliver 必须拒绝封包');
  assert.equal(dStale.body.error?.code, 'env.lock-required', JSON.stringify(dStale.body));

  // 重新 PUT /film 签发正式锁后再交付：成功并附新版锁
  const put2 = await req('PUT', `/v1/films/${filmId}/film`, token, {
    format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'title', value: 'Re-locked Title' }],
  });
  assert.equal(put2.http, 200, JSON.stringify(put2.body));

  const d2 = await waitJob(token, await req('POST', `/v1/films/${filmId}/deliver?wait=30`, token, {}));
  assert.equal(d2.body.ok, true, JSON.stringify(d2.body));
  const bundleLock = JSON.parse(readFileSync(join(dataDir, 'films', filmId, 'deliver', d2.body.data.job, 'bundle', 'film.lock'), 'utf8'));
  assert.equal(bundleLock.sources.three.image, isoRuntime.threeImage({ effective: true }));

  // R2【甲】收口：热改双端加载的 sources/three/source.js，有效摘要与有效镜像立即脱离旧值且区别于重启后的干净磁盘镜像；
  // 旧缓存立即失效（重渲 12 帧），旧交付锁被 deliver 立即拒收（env.lock-required），纯 Node 的 host.mjs 热改保持启动快照
  const beforeSourceEff = isoRuntime.engineCodeDigest('three', { effective: true });
  const beforeSourceImg = isoRuntime.threeImage({ effective: true });
  const hostPath = join(isoRepo, 'beiming/host/page/host.mjs');
  writeFileSync(hostPath, `${readFileSync(hostPath, 'utf8')}\n// node-only-hot-edit\n`);
  assert.equal(isoRuntime.engineCodeDigest('three', { effective: true }), beforeSourceEff, '纯 Node 静态加载的 host.mjs 热改时 effective=true 保持启动快照');
  assert.notEqual(isoRuntime.engineCodeDigest('three'), beforeSourceEff, '纯 Node 文件热改时 effective=false 实时感知磁盘变化');

  const sourceJsPath = join(isoRepo, 'beiming/sources/three/source.js');
  writeFileSync(sourceJsPath, `${readFileSync(sourceJsPath, 'utf8')}\n// browser-dual-loaded-hot-edit\n`);
  const afterSourceDisk = isoRuntime.engineCodeDigest('three');
  const afterSourceEff = isoRuntime.engineCodeDigest('three', { effective: true });
  const afterSourceImg = isoRuntime.threeImage({ effective: true });
  assert.notEqual(afterSourceEff, beforeSourceEff, '热改双端加载的 sources/three/source.js 后，有效摘要必须立即变化');
  assert.notEqual(afterSourceEff, afterSourceDisk, '热改双端加载的 sources/three/source.js 须带 #in-process 隔离重启后的新版键');
  assert.notEqual(afterSourceImg, beforeSourceImg, '热改 sources/three/source.js 后有效镜像立即偏离旧锁');

  const rSourceHot = await waitJob(token, await req('POST', `/v1/films/${filmId}/render?wait=30`, token, { tier: 'final' }));
  assert.equal(rSourceHot.body.ok, true, JSON.stringify(rSourceHot.body));
  assert.deepEqual([rSourceHot.body.data.renderedFrames, rSourceHot.body.data.cachedFrames], [12, 0], '热改 source.js 后不得命中旧帧缓存');

  const dSourceStale = await waitJob(token, await req('POST', `/v1/films/${filmId}/deliver?wait=30`, token, {}));
  assert.equal(dSourceStale.body.ok, false, '热改 source.js 后旧交付锁不得通过 deliver 核对');
  assert.equal(dSourceStale.body.error?.code, 'env.lock-required', JSON.stringify(dSourceStale.body));

  // R3【甲】收口：热改 source.js 后同一服务进程通过正式 PUT /film 重签锁，随后正式 POST /deliver 必须通过且交付锁锚定当前有效镜像
  const put3 = await req('PUT', `/v1/films/${filmId}/film`, token, {
    format: 'patch/0.1', rev: 2, ops: [{ op: 'set', path: 'title', value: 'Re-locked After Source Hot Edit' }],
  });
  assert.equal(put3.http, 200, JSON.stringify(put3.body));
  const d3 = await waitJob(token, await req('POST', `/v1/films/${filmId}/deliver?wait=30`, token, {}));
  assert.equal(d3.body.ok, true, `热改 source.js 后重签锁再走正式 POST /deliver 必须通过: ${JSON.stringify(d3.body)}`);
  const bundleLock3 = JSON.parse(readFileSync(join(dataDir, 'films', filmId, 'deliver', d3.body.data.job, 'bundle', 'film.lock'), 'utf8'));
  assert.equal(bundleLock3.sources.three.image, isoRuntime.threeImage({ effective: true }));
  assert.notEqual(bundleLock3.sources.three.image, bundleLock.sources.three.image);
});

test('R1【甲】#3：独立 verify 的 layerL2 按失败帧索引记录的 cacheEntry 精准作废旧版坏帧，保留同镜头新版好帧', { skip: noFfmpeg }, async () => {
  const engineRootA = makeEngineRoot('r1-3-ver-a');
  const engineRootB = makeEngineRoot('r1-3-ver-b');
  writeText(engineRootB, 'beiming/host/page/runtime.js', 'export const PAGE_HOST = 2;\n');

  const workRoot = join(tmpRoot, 'r1-3-work');
  mkdirSync(workRoot, { recursive: true });
  const film = singleThreeFilm();
  const lock = lockOf(engineRootA);
  const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));
  const indexFile = join(workRoot, 'deliver', 'frames-final.json');
  mkdirSync(dirname(indexFile), { recursive: true });

  // A 版写坏 0..5 帧包围盒并写入索引
  const resA = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3, 4, 5] }],
    outDir: join(workRoot, 'job-a'), pool: fakePool(0, { failBbox: true }), lutPath, cache, engineRoot: engineRootA,
  });
  pipeline.writeIndex(indexFile, workRoot, resA.records, { rev: 1, tier: 'final' });

  // 修正为 B 版后渲好 6..11 帧，按 mergeFrames 逻辑与 0..5 合并落盘索引
  const resB = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [6, 7, 8, 9, 10, 11] }],
    outDir: join(workRoot, 'job-b'), pool: fakePool(0.1, { failBbox: false }), lutPath, cache, engineRoot: engineRootB,
  });
  const prior = pipeline.readIndex(indexFile, workRoot);
  const keep = prior.records.filter((r) => !resB.records.some((n) => n.frame === r.frame));
  pipeline.writeIndex(indexFile, workRoot, [...keep, ...resB.records].sort((a, b) => a.frame - b.frame), { rev: 1, tier: 'final' });

  // 独立 verify（不传 versions，当前为 B 版）检出 0..5 共 6 帧包围盒失败
  const merged = pipeline.readIndex(indexFile, workRoot);
  const l2 = await pipeline.layerL2({
    film, lock, filmDir: workRoot, shots: film.shots, records: merged.records,
    pool: fakePool(0.1), scratch: join(workRoot, 'l2'), cache, tier: 'final', engineRoot: engineRootB,
  });
  assert.equal(l2.ok, false);
  assert.equal(l2.bbox.failures, 6);

  // 重跑 B 版好帧 6..11：必须命中 6/6！
  const rerunB = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [6, 7, 8, 9, 10, 11] }],
    outDir: join(workRoot, 'job-b-rerun'), pool: fakePool(0.1), lutPath, cache, engineRoot: engineRootB,
  });
  assert.deepEqual([rerunB.renderedFrames, rerunB.cachedFrames], [0, 6], 'B 版好帧 6..11 不得被误作废，必须命中 6/6');

  // 切回 A 版重跑刚判坏的 0..5：必须命中 0/6！
  const rerunA = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final',
    plan: [{ shot: film.shots[0], frames: [0, 1, 2, 3, 4, 5] }],
    outDir: join(workRoot, 'job-a-rerun'), pool: fakePool(0), lutPath, cache, engineRoot: engineRootA,
  });
  assert.deepEqual([rerunA.renderedFrames, rerunA.cachedFrames], [6, 0], 'A 版坏帧缓存必须已被精准作废，命中 0/6');
});

test('R1【甲】#4：buildShotCacheInputs 与 renderPlan 纳入 film.overlays 隐式引用的 two-d.overlay 卡摘要', { skip: noFfmpeg }, async () => {
  const engineRoot = makeEngineRoot('r1-4-overlays');
  writeText(engineRoot, 'beiming/cards/two-d/overlay/card.json', JSON.stringify({ id: 'two-d.overlay', version: '1.0.0' }));
  writeText(engineRoot, 'beiming/cards/two-d/overlay/three.js', 'export const OVERLAY_IMPL = 1;\n');

  const workRoot = join(tmpRoot, 'r1-4-work');
  mkdirSync(workRoot, { recursive: true });
  const film = {
    ...singleThreeFilm(),
    shots: [{
      id: 's02', in: 0, out: 12, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed: 1002,
      cards: [],
    }],
    overlays: [{ id: 'cap', shot: 's02', anchor: 'screen', pos: [0.5, 0.9], text: 'Caption', in: 0, out: 12 }],
  };
  const lock = {
    ...lockOf(engineRoot),
    cards: {
      ...lockOf(engineRoot).cards,
      'two-d.overlay': { impl: ['source:three'], sha256: HEX('f'), version: '1.0.0' },
    },
  };

  const inputs1 = pipeline.buildShotCacheInputs({ film, lock, shot: film.shots[0], filmDir: workRoot, tier: 'final', engineRoot });
  assert.ok(inputs1.cards.some((c) => c.id === 'two-d.overlay'), 'lock.cards 中的 two-d.overlay 必须进入缓存键 cards 列表');

  const cache = openShotCache(join(workRoot, 'deliver', '.shot-cache'));
  const plan = [{ shot: film.shots[0], frames: Array.from({ length: 12 }, (_, i) => i) }];
  const r1 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final', plan,
    outDir: join(workRoot, 'ov-1'), pool: fakePool(0), lutPath, cache, engineRoot,
  });
  assert.deepEqual([r1.renderedFrames, r1.cachedFrames], [12, 0]);

  // 沿用同一片子与旧锁，仅改 two-d.overlay 的实现文件，第二轮必须 0 命中、重渲 12 帧
  writeText(engineRoot, 'beiming/cards/two-d/overlay/three.js', 'export const OVERLAY_IMPL = 2;\n');
  const r2 = await pipeline.renderPlan({
    film, lock, filmDir: workRoot, tier: 'final', plan,
    outDir: join(workRoot, 'ov-2'), pool: fakePool(0.25), lutPath, cache, engineRoot,
  });
  assert.deepEqual([r2.renderedFrames, r2.cachedFrames], [12, 0], '改 two-d.overlay 卡实现后必须使缓存失效重渲');
  assert.notEqual(firstRed(r2), firstRed(r1));
});

test('R1【甲】#5：engineCodeDigest 纳入契约合法的带点号扩展帧源目录（如 ext.demo），同时拒绝路径穿越名', () => {
  const root = makeEngineRoot('r1-5-ext-source');
  writeText(root, 'beiming/sources/ext.demo/worker.mjs', 'export const v = 1;\n');
  const d1 = runtime.engineCodeDigest('ext.demo', { root });

  writeText(root, 'beiming/sources/ext.demo/worker.mjs', 'export const v = 2;\n');
  const d2 = runtime.engineCodeDigest('ext.demo', { root });
  assert.notEqual(d2, d1, '修改 beiming/sources/ext.demo/worker.mjs 必须使 engineCodeDigest("ext.demo") 变化');

  // 拒绝 .. 与路径分隔符，不得越出 beiming/sources/
  writeText(root, 'beiming/secret.mjs', 'export const SECRET = 1;\n');
  const bad1 = runtime.engineCodeDigest('..', { root });
  const bad2 = runtime.engineCodeDigest('ext..demo', { root });
  const bad3 = runtime.engineCodeDigest('ext/demo', { root });
  writeText(root, 'beiming/secret.mjs', 'export const SECRET = 2;\n');
  assert.equal(runtime.engineCodeDigest('..', { root }), bad1, '.. 不得扫入父目录文件');
  assert.equal(runtime.engineCodeDigest('ext..demo', { root }), bad2);
  assert.equal(runtime.engineCodeDigest('ext/demo', { root }), bad3);
});

test('R1【甲】#6：服务启动后迁移卡目录并重签锁，渲染与审片补渲作业实时读取最新卡库目录而不再报 env.missing-tool', { skip: noFfmpeg }, async (t) => {
  const isoRepo = makeIsolatedServerRepo('r1-6-dynamic-cards');
  const isoApi = await import(pathToFileURL(join(isoRepo, 'beiming/api/index.mjs')).href);

  const dataDir = join(tmpRoot, 'r1-6-data');
  const account = isoApi.issueAccountToken(dataDir);
  const fakeReviewer = {
    async review() {
      return {
        verdict: { pass: true, confidence: 0.9, summary: 'ok', opinions: [] },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const server = await isoApi.startServer({ dataDir, port: 0, reviewer: fakeReviewer });
  t.after(() => server.close());

  const req = async (method, path, auth, payload) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { http: res.status, body: await res.json() };
  };
  const waitJob = async (auth, init) => {
    let cur = init;
    while (['queued', 'running'].includes(cur.body?.data?.status)) {
      cur = await req('GET', `/v1/jobs/${cur.body.data.job}?wait=30`, auth);
    }
    return cur;
  };

  const created = await req('POST', '/v1/films', account, {
    template: 'title',
    output: { size: [320, 180], fps: '24/1', frames: 12 },
  });
  assert.equal(created.http, 200, JSON.stringify(created.body));
  const { film: filmId, token } = created.body.data;

  // 服务启动后迁移 overlay.title 目录，并同步更新实现入口文件名与 card.json 清单
  const oldCardDir = join(isoRepo, 'beiming/cards/two-d/overlay-title');
  const newCardDir = join(isoRepo, 'beiming/cards/two-d/overlay-title-migrated');
  renameSync(oldCardDir, newCardDir);
  renameSync(join(newCardDir, 'three.js'), join(newCardDir, 'entry-v2.js'));
  const cardJsonFile = join(newCardDir, 'card.json');
  const cardJson = JSON.parse(readFileSync(cardJsonFile, 'utf8'));
  cardJson.impl[0].entry = 'cards/two-d/overlay-title-migrated/entry-v2.js';
  cardJson.impl[0].selftest = 'cards/two-d/overlay-title-migrated/selftest.test.mjs';
  writeFileSync(cardJsonFile, `${JSON.stringify(cardJson, null, 2)}\n`);

  // PUT /film 重签新锁成功
  const put2 = await req('PUT', `/v1/films/${filmId}/film`, token, {
    format: 'patch/0.1', rev: 1, ops: [{ op: 'set', path: 'title', value: 'Migrated Card' }],
  });
  assert.equal(put2.http, 200, JSON.stringify(put2.body));

  // 紧接着渲染第 0 帧：不得因 createWork 持有启动期旧目录报 env.missing-tool
  const renderRes = await waitJob(token, await req('POST', `/v1/films/${filmId}/render?wait=30`, token, {
    tier: 'draft', shots: ['s01'], frames: [0],
  }));
  assert.equal(renderRes.body.ok, true, `迁移卡目录后渲染不得报 env.missing-tool：${JSON.stringify(renderRes.body)}`);
  assert.equal(renderRes.body.data.renderedFrames, 1);

  // 审片补渲原尺寸关键帧（work.mjs 另一处 sourcePool 调用点）同样必须实时获取最新卡目录
  const reviewRes = await req('POST', `/v1/films/${filmId}/review`, token, { brief: '核对片名画面' });
  assert.equal(reviewRes.http, 200, `迁移卡目录后审片补渲不得报 env.missing-tool：${JSON.stringify(reviewRes.body)}`);
  assert.equal(reviewRes.body.ok, true);
});

