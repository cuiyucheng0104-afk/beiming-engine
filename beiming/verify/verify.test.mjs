// 验收核心的测试：L1 写入即检、L2 两道门、floor 1 版六条、limited 减免、五种削弱企图。
// 被扫的调用名在这里一律拆开拼，本文件自己不出现字面量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { checks } from '../kernel/contracts/patch/check.mjs';
import {
  scanShot, guardPredicates, boundsOf, boxOfIds, iou, checkL1, runPureFunctionGate, verifySampledBboxes, parseAssertion, checkAssertion, evaluateAssertion, evaluateItem,
  evaluateFloor, enforcePredicateFloor, toVerdict, FLOOR, REGISTRY, IOU_MIN, GPU_SECONDS_PER_MEGAPIXEL_SAMPLE,
  DEFAULT_MAX_NOISE_RESIDUAL, DEFAULT_MAX_ALIAS_EDGE,
} from './index.mjs';

const call = (...parts) => parts.join('.');
const entityEvidence = { entities: { s01: ['kit'], s02: ['kit'] } };
const W = 1920, H = 1080;

function makeFilm(over = {}) {
  return {
    format: 'film/3.0',
    id: 'verify-demo',
    output: { size: [W, H], fps: '24/1', frames: 240 },
    shots: [
      { id: 's01', in: 0, out: 120, source: 'three', host: 'page', mode: 'build-script', entry: 'shots/s01.mjs', colorRef: 'scene', roles: { hero: 'kit' } },
      { id: 's02', in: 120, out: 240, source: 'three', host: 'page', mode: 'build-script', entry: 'shots/s02.mjs', colorRef: 'scene', roles: { hero: 'kit' } },
    ],
    overlays: [{ id: 'title', shot: 's02', anchor: 'screen', pos: [0.5, 0.8], text: 'BEIMING', in: 150, out: 200 }],
    style: { view: { scene: 'filmic', display: 'srgb' }, tokens: { ink: '#1A2B3C' } },
    audio: { mode: 'script' },
    predicates: { base: ['floor@1'] },
    delivery: { master: 'h264-high' },
    ...over,
  };
}

/** 一帧元数据：hero 名叫 kit，bbox 像素；pxArea 照每帧元数据契约 5.4 算 */
function meta(frame, { bbox = [600, 300, 1300, 800], visible = 0.9, texts = [], size = [W, H] } = {}) {
  const [w, h] = size;
  const c = [Math.max(0, bbox[0]), Math.max(0, bbox[1]), Math.min(w, bbox[2]), Math.min(h, bbox[3])];
  const pxArea = Math.max(0, c[2] - c[0]) * Math.max(0, c[3] - c[1]) / (w * h);
  return { frame, size, colorRef: 'scene', entities: [{ id: 1, name: 'kit', class: 'assembly', role: 'hero', bbox2d: bbox, visible, pxArea }], texts };
}

function goodMeasured() {
  const textBox = { text: 'BEIMING', bbox2d: [800, 820, 1120, 900] };
  return {
    output: { size: [W, H], fps: '24/1', frames: 240, colorTag: 'bt709' },
    blackFrames: [], freezes: [],
    audio: { loudnessLufs: -14, truePeakDbtp: -1.5 },
    cuts: [120],
    frames: [
      { frame: 0, meta: meta(0) },
      { frame: 60, meta: meta(60, { visible: 0.8 }) },
      { frame: 130, meta: meta(130) },
      { frame: 160, meta: meta(160, { texts: [textBox] }), ocr: [textBox] },
    ],
  };
}

/* ---------------- L1 ---------------- */

test('L1：合规的片子描述通过，成本粗估按帧数、像素、采样数算', () => {
  const r = checkL1(makeFilm());
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.cost.frames, 240);
  assert.equal(r.cost.estimatedGpuSeconds, 240 * (W * H / 1e6) * GPU_SECONDS_PER_MEGAPIXEL_SAMPLE);
  const r2 = checkL1(makeFilm({ shots: makeFilm().shots.map((s) => ({ ...s, tiers: { final: { samples: 4, scale: 0.5 } } })) }));
  assert.equal(r2.cost.estimatedGpuSeconds, 240 * (960 * 540 / 1e6) * 4 * GPU_SECONDS_PER_MEGAPIXEL_SAMPLE);
});

test('L1：margn 拼错给出整数组的 set 修法，applyFixes 是 none 时不动片子', () => {
  const film = makeFilm({ predicates: { base: ['floor@1'], extra: ['inside_frame(hero, margn=0.05) @ shot(s01)'] } });
  const r = checkL1(film);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fixes, [{ op: 'set', path: 'predicates/extra', value: ['inside_frame(hero, margin=0.05) @ shot(s01)'], applicability: 'machine' }]);
  assert.equal(r.rev, 0);
  assert.equal(r.film, film);
});

test('L1：applyFixes 是 machine 时自动改名、重查通过、rev 加 1，原件不变', () => {
  const film = makeFilm({ predicates: { base: ['floor@1'], extra: ['inside_frame(hero, margn=0.05)'] } });
  const r = checkL1(film, { applyFixes: 'machine', rev: 41 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.rev, 42);
  assert.equal(r.applied.length, 1);
  assert.deepEqual(r.film.predicates.extra, ['inside_frame(hero, margin=0.05)']);
  assert.deepEqual(film.predicates.extra, ['inside_frame(hero, margn=0.05)']);
});

test('L1：结构里的未知键 frams 改名成 frames，路径照 5.4，键的次序不变', () => {
  const film = makeFilm();
  film.output = { size: [W, H], fps: '24/1', frams: 240 };
  const r = checkL1(film, { applyFixes: 'machine' });
  assert.deepEqual(r.fixes, [{ op: 'rename', path: 'output/frams', to: 'frames', applicability: 'machine' }]);
  assert.deepEqual(Object.keys(r.film.output), ['size', 'fps', 'frames']);
  assert.equal(r.ok, true);
  assert.equal(r.rev, 1);
  // 镜头里的键：按 id 寻址
  const f2 = makeFilm();
  f2.shots[1] = { ...f2.shots[1], colorRf: 'scene' };
  delete f2.shots[1].colorRef;
  const r2 = checkL1(f2);
  assert.equal(r2.fixes[0].path, 'shots/s02/colorRf');
  assert.equal(r2.fixes[0].to, 'colorRef');
});

test('L1：离得远或有两个候选的未知键不给修法', () => {
  const film = makeFilm();
  film.output.zzzzzz = 1;
  const r = checkL1(film, { applyFixes: 'machine' });
  const d = r.diagnostics.find((x) => x.at === 'output/zzzzzz');
  assert.equal(d.code, 'contract.unknown-key');
  assert.equal(d.fix, undefined);
  assert.equal(r.rev, 0);
});

test('L1：单位与色彩空间：小数帧、非有理数帧率、小写色值、镜头区间断开都拦下', () => {
  const film = makeFilm({ output: { size: [W, H], fps: '29.97', frames: 240 } });
  film.shots[0].out = 119.5;
  film.style.tokens.ink = '#1a2b3c';
  const r = checkL1(film);
  assert.ok(r.diagnostics.every((d) => d.code === 'contract.bad-value'));
  const codes = r.diagnostics.map((d) => `${d.evidence}@${d.at}`);
  assert.ok(codes.includes('l1.unit@output/fps'), codes.join(' '));
  assert.ok(codes.includes('l1.unit@shots/s01/out'), codes.join(' '));
  assert.ok(codes.includes('l1.color@style/tokens/ink'), codes.join(' '));
  const gap = makeFilm();
  gap.shots[1].in = 121;
  assert.ok(checkL1(gap).diagnostics.some((d) => d.code === 'contract.bad-value' && d.evidence === 'l1.shots'));
});

test('L1：JS 源码里的墙钟被拦下', () => {
  const src = `export function build(ctx){ const t = ${call('Date', 'now')}(); return t; }`;
  const r = checkL1(makeFilm(), { shotSources: { s01: { 'shots/s01.mjs': src } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.scan.s01.wallClock, [{ path: 'shots/s01.mjs', call: call('Date', 'now'), line: 1 }]);
  assert.ok(r.diagnostics.some((d) => d.code === 'contract.bad-value' && d.evidence === 'l1.wall-clock'));
  const other = [`${call('performance', 'now')}()`, `new ${'Da'}${'te'}()`, `${'Ma'}${'th'}['random']()`];
  const r2 = checkL1(makeFilm(), { shotSources: { s01: { 'shots/s01.mjs': other.join('\n') } } });
  assert.equal(r2.scan.s01.wallClock.length + r2.scan.s01.unseededRandom.length, 3);
});

test('L1：JS 源码里的无种子随机被拦下', () => {
  const src = `const x = ${call('Math', 'random')}();`;
  const r = checkL1(makeFilm(), { shotSources: { s02: { 'shots/s02.mjs': src } } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.scan.s02.unseededRandom.map((h) => h.call), [call('Math', 'random')]);
});

test('L1：Python 源码里的 time.time 和 random 模块被拦下，带种子的 Random 实例放过', () => {
  const py = [
    'import time, random',
    `t = ${call('time', 'time')}()`,
    `x = ${call('random', 'random')}()`,
    `rng = ${call('random', 'Random')}(42)`,
    'y = rng.random()',
    `z = ${call('random', 'Random')}()`,
  ].join('\n');
  const r = checkL1(makeFilm(), { shotSources: { s01: { 'shots/s01.py': py } } });
  assert.deepEqual(r.scan.s01.wallClock.map((h) => [h.call, h.line]), [[call('time', 'time'), 2]]);
  assert.deepEqual(r.scan.s01.unseededRandom.map((h) => [h.call, h.line]), [[call('random', 'random'), 3], [call('random', 'Random()'), 6]]);
});

test('L1：显式豁免按文件、调用名（和行号）生效，别的行照拦', () => {
  const pn = call('performance', 'now');
  const src = [`const a = ${pn}();`, `const b = ${pn}();`].join('\n');
  const files = { 'shots/s01.mjs': src };
  const r = checkL1(makeFilm(), { shotSources: { s01: files }, allowed: [{ path: 'shots/s01.mjs', call: pn, line: 1 }] });
  assert.equal(r.scan.s01.allowed.length, 0);
  assert.deepEqual(r.scan.s01.wallClock.map((h) => h.line), [1, 2]);
  assert.equal(r.ok, false);
  const host = scanShot(files, [{ path: 'shots/s01.mjs', call: pn, line: 1 }], { scope: 'host' });
  assert.deepEqual(host.allowed.map((h) => h.line), [1]);
  assert.deepEqual(host.wallClock.map((h) => h.line), [2]);
});

test('L1：limited 合规档镜头（ext.<名字>）的第三方源码不做静态扫描', () => {
  const film = makeFilm();
  film.shots[0] = { ...film.shots[0], source: 'ext.legacy', mode: 'native-code', params: { piece: 'p' } };
  delete film.shots[0].entry;
  const r = checkL1(film, { shotSources: { s01: { 'piece.js': `${call('Math', 'random')}()` } } });
  assert.equal(r.scan.s01, undefined);
  assert.ok(r.diagnostics.some((d) => d.code === 'contract.bad-value' && d.evidence === 'l1.scan-skipped'));
});

test('L1：未登记的谓词名、未登记的模板、引号外的分号都被拒', () => {
  const r = checkL1(makeFilm({ predicates: { base: ['floor@1', 'template:nope@1'], extra: ['insde_frame(hero) @ all', 'no_cut ;visible(hero)', 'text_matches("a;b")'] } }));
  const codes = r.diagnostics.map((d) => d.evidence);
  assert.ok(r.diagnostics.every((d) => d.code === 'contract.bad-value'));
  assert.equal(codes.filter((c) => c === 'predicate.unregistered').length, 2);
  assert.equal(codes.filter((c) => c === 'predicate.semicolon').length, 1);
  assert.equal(checkAssertion('fancy_glow(hero) >= 1').errors[0].evidence, 'predicate.unregistered');
  assert.equal(checkAssertion('fancy_glow(hero) >= 1').errors[0].code, 'contract.bad-value');
  assert.equal(checkAssertion('visible(hero) >= 0.6 @ [150,181)').ok, true);
});

/* ---------------- L2 纯函数门 ---------------- */

const pureAdapter = { open: () => ({ render: (f) => Float32Array.from([f * 0.25, f / 7, 1]) }) };
const statefulAdapter = {
  open() {
    let acc = 0; // 植入的跨帧状态：每渲一帧累加一次
    return { render: (f) => { acc += f; return Float32Array.from([acc, 0, 1]); } };
  },
};

test('L2 纯函数门：纯函数的帧源三种方式逐字节相同', async () => {
  const r = await runPureFunctionGate(pureAdapter, [0, 3, 7, 12, 5]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.frames, [0, 3, 5, 7, 12]);
  assert.notDeepEqual(r.orders.shuffled, r.orders.sequential);
});

test('L2 纯函数门：植入跨帧状态被判红，乱序和单帧都抓到', async () => {
  const r = await runPureFunctionGate(statefulAdapter, [1, 2, 3, 4]);
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some((m) => m.mode === 'shuffled'));
  assert.ok(r.mismatches.some((m) => m.mode === 'single'));
});

test('L2 纯函数门：relTol 档放过浮点噪声、hash 档不放过；超过容差判红', async () => {
  let n = 0;
  const noisy = { open: () => ({ render: (f) => Float64Array.from([1 + f + (n++ % 2) * 1e-12]) }) };
  assert.equal((await runPureFunctionGate(noisy, [1, 2, 3], { compare: 'relTol', relTol: 1e-9 })).ok, true);
  assert.equal((await runPureFunctionGate(noisy, [1, 2, 3], { compare: 'hash' })).ok, false);
  assert.equal((await runPureFunctionGate(statefulAdapter, [1, 2, 3], { compare: 'relTol', relTol: 1e-3 })).ok, false);
});

/* ---------------- L2 包围盒核对门 ---------------- */

/** 64×36 的编号层：kit.body 编号 2 占 [10,5,30,25)，kit 自己（编号 1）占 [30,10,34,20) */
function idFrame(frame, reportedKit) {
  const w = 64, h = 36, data = new Uint32Array(w * h);
  for (let y = 5; y < 25; y++) for (let x = 10; x < 30; x++) data[y * w + x] = 2;
  for (let y = 10; y < 20; y++) for (let x = 30; x < 34; x++) data[y * w + x] = 1;
  const m = {
    frame, size: [w, h], colorRef: 'scene', texts: [],
    entities: [
      { id: 1, name: 'kit', class: 'assembly', role: 'hero', bbox2d: reportedKit, visible: 1, pxArea: 0.2 },
      { id: 2, name: 'kit.body', class: 'part', bbox2d: [10, 5, 30, 25], visible: null, pxArea: 0.2 },
    ],
  };
  return { frame, meta: m, objectId: { width: w, height: h, data } };
}

test('L2 核对门：编号层反算的包围盒（含子实体像素）和报的一致时通过', () => {
  const r = verifySampledBboxes([idFrame(10, [10, 5, 34, 25]), idFrame(20, [10, 5, 34, 25])]);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.minIou, 1);
});

test('L2 核对门：篡改元数据包围盒，任一抽样帧 IoU < 0.95 整次判不过', () => {
  const r = verifySampledBboxes([idFrame(10, [10, 5, 34, 25]), idFrame(20, [10, 5, 30, 25])]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => [f.frame, f.kind, f.name]), [[20, 'iou', 'kit']]);
  assert.ok(r.failures[0].iou < IOU_MIN);
  // 门限是 0.95：差一列（IoU = 23 / 24 ≈ 0.958）还过，差两列（22 / 24 ≈ 0.917）不过
  assert.equal(verifySampledBboxes([idFrame(1, [10, 5, 33, 25])]).ok, true);
  assert.equal(verifySampledBboxes([idFrame(1, [10, 5, 32, 25])]).ok, false);
});

test('L2 核对门：没有编号层的三维镜头判不过（缺编号层）', () => {
  const { frame, meta: m } = idFrame(5, [10, 5, 34, 25]);
  const r = verifySampledBboxes([{ frame, meta: m }]);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'missing-object-id');
});

/** 二维镜头：墨迹掩膜里文字占 [100,40,180,60) */
function textFrame(reported, ocrText = 'HELLO') {
  const w = 320, h = 180, data = new Uint8Array(w * h);
  for (let y = 40; y < 60; y++) for (let x = 100; x < 180; x++) data[y * w + x] = 1;
  return {
    frame: 30, conformance: 'limited',
    meta: { frame: 30, size: [w, h], colorRef: 'display', entities: null, texts: [{ text: 'HELLO', bbox2d: reported }] },
    ocr: [{ text: ocrText, bbox2d: [100, 40, 180, 60] }],
    inkMask: { width: w, height: h, data },
  };
}

test('L2 核对门：二维镜头文字框内容和像素包围盒在 8 像素内通过', () => {
  assert.equal(verifySampledBboxes([textFrame([100, 40, 180, 60])]).ok, true);
  assert.equal(verifySampledBboxes([textFrame([96, 36, 186, 64])]).ok, true);
});

test('L2 核对门：篡改文字框位置或文字内容判不过', () => {
  const moved = verifySampledBboxes([textFrame([100, 40, 200, 60])]);
  assert.equal(moved.ok, false);
  assert.ok(moved.failures.some((f) => f.kind === 'text-bbox'));
  const far = verifySampledBboxes([textFrame([250, 120, 300, 150])]);
  assert.ok(far.failures.some((f) => f.kind === 'text-no-pixels'));
  const wrong = verifySampledBboxes([textFrame([100, 40, 180, 60], 'HELL0')]);
  assert.deepEqual(wrong.failures.map((f) => f.kind).sort(), ['text-content', 'text-unreported']);
});

/* ---------------- 谓词 ---------------- */

test('谓词解析：契约里的例子都解得出，范围和比较都认', () => {
  for (const t of ['inside_frame(hero, margin=0.05) @ shot(s01)', 'visible(kit.fan_L) >= 0.6 @ [150,181)', 'no_intersect(kit.*, kit.*, tol=0.3mm) @ shot(s01)', 'at_rest(kit.*) @ event(lock) + 6', 'text_matches("BEIMING") @ shot(s02)', 'delivery(width=1920, height=1080, fps=24, frames=240)']) {
    assert.equal(parseAssertion(t).ok, true, t);
  }
  const p = parseAssertion('loudness(film) in [-15,-13]').assertion;
  assert.deepEqual(p.cmp, { op: 'in', lo: -15, hi: -13 });
  assert.equal(parseAssertion('visible(hero) >= 0.5 @ [10,5)').ok, false);
  assert.equal(checkAssertion('inside_frame(hero, margn=0.05)').errors[0].rename.to, 'margin');
});

test('floor 1 版六条从登记表读，和契约 5.6 的次序一致；合规片六条全过', () => {
  assert.deepEqual(FLOOR.items.map((i) => i.expr.split('(')[0].split(' ')[0]), ['delivery', 'loudness', 'cut_at', 'inside_frame', 'visible', 'text_matches']);
  const r = evaluateFloor(makeFilm(), goodMeasured());
  assert.deepEqual(r.map((x) => x.status), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'], JSON.stringify(r, null, 1));
});

test('floor 第 1 条 delivery：尺寸、帧数、色彩标签不符，或有没声明的黑帧都判不过', () => {
  const film = makeFilm();
  const m = goodMeasured();
  assert.equal(evaluateAssertion('delivery(output)', film, m).ok, true);
  const bad = evaluateAssertion('delivery(output)', film, { ...m, output: { ...m.output, frames: 239, colorTag: 'bt601' } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.measured.mismatched, ['frames', 'colorTag']);
  assert.equal(evaluateAssertion('delivery(width=1280, height=720, fps=24, frames=240)', film, m).ok, false);
  assert.equal(evaluateAssertion('delivery(output)', film, { ...m, blackFrames: [50] }).counterexampleFrame, 50);
  const declared = makeFilm();
  declared.shots[0].deliberate = [{ kind: 'black', in: 40, out: 60, why: '黑场转场' }];
  assert.equal(evaluateAssertion('delivery(output)', declared, { ...m, blackFrames: [50] }).ok, true);
  assert.equal(evaluateAssertion('delivery(output)', film, { ...m, freezes: [{ in: 10, out: 22 }] }).ok, false);
  assert.equal(evaluateAssertion('delivery(output)', film, { ...m, freezes: [{ in: 10, out: 21 }] }).ok, true);
});

test('floor 第 2 条 loudness / true_peak：在区间里过，超出不过，无声片不判', () => {
  const item = FLOOR.items[1];
  assert.equal(evaluateItem(item, makeFilm(), goodMeasured()).status, 'pass');
  assert.equal(evaluateItem(item, makeFilm(), { ...goodMeasured(), audio: { loudnessLufs: -10, truePeakDbtp: -1.5 } }).status, 'fail');
  assert.equal(evaluateItem(item, makeFilm(), { ...goodMeasured(), audio: { loudnessLufs: -14, truePeakDbtp: -0.2 } }).status, 'fail');
  const silent = makeFilm();
  delete silent.audio;
  assert.equal(evaluateItem(item, silent, goodMeasured()).status, 'skipped');
});

test('floor 第 3 条 cut_at / no_cut：漏切和多切都判不过，反例帧是那个切点', () => {
  const item = FLOOR.items[2];
  const miss = evaluateItem(item, makeFilm(), { ...goodMeasured(), cuts: [] });
  assert.equal(miss.status, 'fail');
  assert.equal(miss.results[0].counterexampleFrame, 120);
  const extra = evaluateItem(item, makeFilm(), { ...goodMeasured(), cuts: [120, 77] });
  assert.equal(extra.status, 'fail');
  assert.equal(extra.results[1].counterexampleFrame, 77);
});

test('floor 第 4 条 inside_frame(hero)：贴边越过 5% 判不过', () => {
  const m = goodMeasured();
  m.frames[1] = { frame: 60, meta: meta(60, { bbox: [20, 300, 700, 800] }) };
  const r = evaluateAssertion(FLOOR.items[3].expr, makeFilm(), m);
  assert.equal(r.ok, false);
  assert.equal(r.counterexampleFrame, 60);
  assert.ok(r.measured.margin < 0.05);
});

test('floor 第 5 条 visible(hero)：峰值帧可见比例不足或屏占峰值 < 0.05 判不过', () => {
  const m = goodMeasured();
  m.frames[0] = { frame: 0, meta: meta(0, { visible: 0.3 }) };
  const low = evaluateAssertion(FLOOR.items[4].expr, makeFilm(), m);
  assert.equal(low.ok, false);
  assert.equal(low.measured.visible, 0.3);
  const tiny = goodMeasured();
  tiny.frames = tiny.frames.map((f) => ({ ...f, meta: meta(f.frame, { bbox: [900, 500, 1000, 580], texts: f.meta.texts }) }));
  const small = evaluateAssertion(FLOOR.items[4].expr, makeFilm(), tiny);
  assert.equal(small.ok, false);
  assert.ok(small.measured.peakArea < 0.05);
});

test('floor 第 6 条 text_matches(copy)：文案、文字框、文字识别有一方不同就判不过', () => {
  const m = goodMeasured();
  m.frames[3] = { ...m.frames[3], ocr: [{ text: 'BEIMlNG', bbox2d: [800, 820, 1120, 900] }] };
  const r = evaluateAssertion('text_matches(copy)', makeFilm(), m);
  assert.equal(r.ok, false);
  assert.equal(r.counterexampleFrame, 160);
  const noText = makeFilm();
  delete noText.overlays;
  assert.equal(evaluateItem(FLOOR.items[5], noText, goodMeasured()).status, 'skipped');
});

test('失败结果的结构：ok、predicate、measured、counterexampleFrame、fixes 都在；判定条目不带 null', () => {
  const r = evaluateAssertion('visible(hero) >= 0.95', makeFilm(), goodMeasured());
  assert.equal(r.ok, false);
  for (const k of ['ok', 'predicate', 'measured', 'counterexampleFrame', 'fixes']) assert.ok(Object.hasOwn(r, k), k);
  assert.ok(Array.isArray(r.fixes));
  const v = toVerdict(r);
  assert.deepEqual([v.id, v.layer, v.status, v.atFrames[0]], ['pred.visible', 'L3', 'fail', 0]);
  const s = toVerdict(evaluateAssertion('loudness(film) in [-15,-13]', makeFilm(), {}));
  assert.equal(s.status, 'skipped');
  assert.ok(s.reason);
  assert.ok(!JSON.stringify(s).includes('null'));
});

test('limited 合规档：只判第 1、2、3、6 条，第 4、5 条判 skipped', () => {
  const m = { ...goodMeasured(), conformance: { s01: 'limited', s02: 'limited' } };
  m.frames = m.frames.map((f) => ({ ...f, meta: { ...f.meta, entities: null } }));
  const r = evaluateFloor(makeFilm(), m);
  assert.deepEqual(r.map((x) => x.status), ['pass', 'pass', 'pass', 'skipped', 'skipped', 'pass']);
  // 只有一个镜头是 limited：另一个照判
  const half = { ...goodMeasured(), conformance: { s01: 'limited' } };
  half.frames[2] = { frame: 130, meta: meta(130, { bbox: [0, 0, 1900, 1000] }) };
  assert.equal(evaluateFloor(makeFilm(), half)[3].status, 'fail');
});

/* ---------------- 防削弱守卫 ---------------- */

test('守卫正例：合规片子不报违规，floor@1 原样在 base 里', () => {
  const r = enforcePredicateFloor(makeFilm(), null, { entities: { s01: ['kit', 'kit.body'], s02: ['kit'] } });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.film.predicates.base, ['floor@1']);
  assert.equal(r.items.length, 6);
});

test('削弱 (a)：从 base 删掉 floor@1 被拦下并自动注入', () => {
  const r = enforcePredicateFloor(makeFilm({ predicates: { base: [] } }));
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'base-removed'));
  assert.deepEqual(r.film.predicates.base, ['floor@1']);
  // 题目自带的 floor 副本删了一条也拦
  const tpl = { ...FLOOR, items: FLOOR.items.slice(0, 5) };
  assert.ok(enforcePredicateFloor(makeFilm(), tpl).violations.some((v) => v.code === 'base-removed'));
});

test('削弱 (b)：用 extra 或改过的 floor 副本放宽阈值被拦下', () => {
  for (const x of ['visible(hero) >= 0.2', 'inside_frame(hero, margin=0.01)', 'loudness(film) in [-20,-10]', 'true_peak(film) <= 0', 'visible(hero)']) {
    const r = enforcePredicateFloor(makeFilm({ predicates: { base: ['floor@1'], extra: [x] } }));
    assert.ok(r.violations.some((v) => v.code === 'threshold-loosened'), x);
  }
  // 收紧不算
  assert.equal(enforcePredicateFloor(makeFilm({ predicates: { base: ['floor@1'], extra: ['visible(hero) >= 0.8'] } }), null, entityEvidence).ok, true);
  const tpl = structuredClone(FLOOR);
  tpl.items[4].expr = 'visible(hero) >= 0.1';
  assert.ok(enforcePredicateFloor(makeFilm(), tpl).violations.some((v) => v.code === 'threshold-loosened'));
});

test('削弱 (c)：hero 绑到空值或不存在的实体被拦下', () => {
  const empty = makeFilm();
  empty.shots[0].roles.hero = '';
  assert.ok(enforcePredicateFloor(empty).violations.some((v) => v.code === 'hero-unbound' && v.path === 'shots/s01/roles/hero'));
  const ghost = makeFilm();
  ghost.shots[1].roles.hero = 'nobody';
  const r = enforcePredicateFloor(ghost, null, { entities: { s01: ['kit'], s02: ['kit', 'kit.body'] } });
  assert.deepEqual(r.violations.map((v) => [v.code, v.path]), [['hero-unbound', 'shots/s02/roles/hero']]);
});

test('削弱 (d)：镜头缺 hero、模板必填角色留空被拦下', () => {
  const film = makeFilm();
  delete film.shots[0].roles;
  assert.ok(enforcePredicateFloor(film).violations.some((v) => v.code === 'role-missing' && v.path === 'shots/s01/roles'));
  const q = { base: ['visible(hero) >= 0.6'], roles: ['mustSee'] };
  const f2 = makeFilm();
  f2.shots[1].roles.mustSee = [];
  const r = enforcePredicateFloor(f2, q);
  assert.ok(r.violations.some((v) => v.code === 'role-missing' && v.path === 'shots/s01/roles'));
  assert.ok(r.violations.some((v) => v.code === 'role-missing' && v.path === 'shots/s02/roles/mustSee'));
});

test('削弱 (e)：换用没有空间断言的模板绕过第 4、5 条被拦下', () => {
  const noSpace = { base: ['delivery(output)', 'text_matches(copy)'] };
  const r = enforcePredicateFloor(makeFilm({ predicates: { base: [] } }), noSpace);
  assert.ok(r.violations.some((v) => v.code === 'spatial-bypass'));
  assert.ok(r.film.predicates.base.includes('floor@1'));
  // 换成不存在的 floor 版本
  const r2 = enforcePredicateFloor(makeFilm({ predicates: { base: ['floor@2'] } }));
  assert.ok(r2.violations.some((v) => v.code === 'spatial-bypass'));
  assert.deepEqual(r2.film.predicates.base, ['floor@1']);
  // floor@1 还在、另加一个题目：不是绕过
  assert.equal(enforcePredicateFloor(makeFilm(), noSpace, entityEvidence).ok, true);
});

test('用冻结 PA1、PA5 和 fix.schema.json 检查 L1 与守卫交出的每种修法', () => {
  const schema = JSON.parse(readFileSync(new URL('../kernel/contracts/patch/schema/fix.schema.json', import.meta.url)));
  const validate = new Ajv2020().compile(schema);
  const film = makeFilm();
  film.output.frams = film.output.frames;
  delete film.output.frames;
  film.predicates = { base: [], extra: ['inside_frame(hero, margn=0.05)', 'visible(hero) >= 0.1', 'inside_frame(kit, margn=0.1)'] };
  const l1 = checkL1(film, { applyFixes: 'machine' });
  const guard = guardPredicates(l1.film, null, entityEvidence);
  const extra = guard.violations.find((v) => v.path === 'predicates/extra');
  assert.deepEqual(extra.fixes[0].value, ['inside_frame(hero, margin=0.05)', 'inside_frame(kit, margin=0.1)']);
  assert.ok(guard.violations.filter((v) => v.path === 'predicates/base').every((v) => v.hint && !v.fixes.length));
  const fixes = [...l1.applied, ...guard.violations.flatMap((v) => v.fixes)];
  assert.deepEqual(fixes.map((f) => f.op).sort(), ['rename', 'set', 'set']);
  for (const fix of fixes) {
    assert.ok(validate(fix), JSON.stringify(validate.errors));
    assert.deepEqual(checks.PA5(fix, { schema: 'fix.schema.json' }), []);
    const { applicability, ...op } = fix;
    assert.deepEqual(checks.PA1({ format: 'patch/0.1', ops: [op] }), []);
  }
  film.predicates = { bas: ['floor@1'] };
  assert.equal(checkL1(film).fixes.some((f) => f.to === 'base'), false);
});

test('未知键只在可唯一寻址的位置发修法，hint 标明候选和项号', () => {
  const film = makeFilm();
  film.shots[0].deliberate = [{ kind: 'freeze', in: 1, out: 20, whyy: '静止' }];
  film.shots[1].colorRf = 'scene';
  delete film.shots[1].colorRef;
  delete film.shots[1].id;
  film.output['fra mes'] = 240;
  delete film.output.frames;
  const unknown = checkL1(film).diagnostics.filter((d) => d.code === 'contract.unknown-key');
  for (const [path, hint] of [['shots/s01/deliberate', /第 1 项.*why/], ['shots', /第 2 项.*colorRef/], ['output', /fra mes.*frames/]]) {
    const d = unknown.find((x) => x.at === path);
    assert.match(d.hint, hint);
    assert.equal(d.fix, undefined);
  }
  film.shots[1].id = film.shots[0].id;
  film.shots.reverse();
  assert.equal(checkL1(film).fixes.length, 0);
});

test('JS 成员别名、Python 模块及具名导入均按规范调用名和行号报告', () => {
  const py = ['from random import random as roll; roll()', 'import random as rnd; rnd.random()',
    'from random import SystemRandom as R; R(42)', 'from time import time as tick; tick()',
    'from random import Random as Seeded; Seeded(42)', 'Seeded(None)', 'rnd.weibullvariate(1, 2)'].join('\n');
  const js = `const M = Math; ${call('M', 'random')}();\nconst { random: roll } = M; roll();`;
  const report = scanShot({ 's.py': py, 's.js': js });
  assert.deepEqual(report.unseededRandom.filter((x) => x.path === 's.py').map((x) => x.line), [1, 2, 3, 6, 7]);
  assert.deepEqual(report.wallClock.map((x) => x.line), [4]);
  assert.deepEqual(report.unseededRandom.filter((x) => x.path === 's.js').map((x) => x.line), [1, 2, 2]);
});

test('宿主豁免也必须是单调时钟，随机和日历时钟始终命中', () => {
  const calls = [call('Date', 'now'), call('Math', 'random'), call('performance', 'now'), call('performance', 'timeOrigin')];
  const files = { 'host.js': calls.join('; ') };
  const allowed = calls.map((c) => ({ path: 'host.js', call: c }));
  const r = scanShot(files, allowed, { scope: 'host' });
  assert.deepEqual(r.allowed.map((h) => h.call), [calls[2]]);
  assert.deepEqual(r.wallClock.map((h) => h.call), [calls[0], calls[3]]);
  assert.deepEqual(r.unseededRandom.map((h) => h.call), [calls[1]]);
});

test('L1 非法输入和 planned 断言各有诊断', () => {
  for (const film of [null, makeFilm({ shots: [null] }), makeFilm({ shots: {} }), makeFilm({ predicates: { base: [], extra: [null] } })]) {
    const result = checkL1(film);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length);
  }
  const film = makeFilm({ predicates: { base: ['floor@1'], extra: ['key_fill_ratio(hero) >= 2', 'orbit_total(camera, hero) >= 90'] } });
  const r = checkL1(film);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.filter((d) => d.code === 'contract.bad-value' && d.evidence === 'predicate.planned' && d.hint).length, 2);
});

test('D 3.x 值域逐项拒绝并指出原因', () => {
  const cases = [
    [(f) => { delete f.shots[0].entry; }, 'l1.entry'],
    [(f) => { f.shots[0].id = 'film'; }, 'l1.value'],
    [(f) => { f.shots[0].cards = [{ as: 'tracks', use: 'demo.card@1', params: {} }]; }, 'l1.value'],
    [(f) => { delete f.overlays[0].pos; }, 'l1.missing'],
    [(f) => { Object.assign(f.shots[0], { source: 'ext.replay', mode: 'native-code' }); delete f.shots[0].entry; }, 'l1.ext'],
    [(f) => { f.shots[0].host = 'cycles'; }, 'l1.source'],
    [(f) => { f.delivery.layers = ['lightgroup:INVALID']; }, 'l1.value'],
    [(f) => { f.output.size[0] = 2 ** 53; }, 'l1.unit'],
    [(f) => { f.output.fps = ['24/1']; }, 'l1.unit'],
  ];
  for (const [edit, evidence] of cases) {
    const film = makeFilm(); edit(film);
    const r = checkL1(film);
    assert.ok(r.diagnostics.some((d) => d.code === 'contract.bad-value' && d.evidence === evidence), JSON.stringify(r.diagnostics));
  }
  const film = makeFilm();
  film.output.fps = '9007199254740993/2';
  assert.equal(checkL1(film).ok, true);
  film.output.fps = '9007199254740996/2';
  assert.equal(checkL1(film).ok, false);
  const lit = makeFilm();
  lit.delivery.layers = ['color', 'diffuseDirect', 'transmissionIndirect', 'environment', 'lightgroup:key'];
  assert.equal(checkL1(lit).ok, true, '输出通道契约 3.1 的光路通道名照收');
});

test('纯函数门拒绝单帧、非法容差、无颜色与渲染异常', async () => {
  for (const frames of [[], [5], [5, 5]]) assert.equal((await runPureFunctionGate(pureAdapter, frames)).ok, false);
  for (const relTol of [Infinity, NaN, -1]) assert.equal((await runPureFunctionGate(pureAdapter, [0, 1], { compare: 'relTol', relTol })).ok, false);
  for (const render of [() => undefined, () => { throw new Error('bad frame'); }]) {
    let closed = 0;
    const r = await runPureFunctionGate({ open: () => ({ render, close: () => { closed++; } }) }, [0, 1]);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches[0].error);
    assert.ok(closed > 0);
  }
});

test('像素外沿、背景、裁边与交并比遵循同一几何口径', () => {
  assert.deepEqual(boundsOf(4, 2, (i) => [2, 6].includes(i), 1), { x0: 1, x1: 3, y0: 0, y1: 1 });
  assert.deepEqual(boxOfIds(2, 2, [0, 2, 1, 0], [1, 2]), [0, 0, 2, 2]);
  assert.equal(boxOfIds(2, 2, [0, 0, 0, 0], [1]), null);
  assert.equal(iou([0, 0, 2, 2], [1, 0, 3, 2]), 1 / 3);
});

test('包围盒门在任一抽样帧缺证据时失败', () => {
  assert.equal(verifySampledBboxes([]).ok, false);
  const missing = [
    [(f) => { delete f.meta.size; }, 'bad-input'],
    [(f) => { delete f.meta.entities[0].bbox2d; }, 'bad-entity'],
    [(f) => { f.objectId.data.fill(0); }, 'no-pixels'],
    [(f) => { f.objectId.data = [0]; }, 'object-id-size'],
    [(f) => { f.meta.entities = null; }, 'no-entities'],
    [(f) => { f.meta.omittedParts = 1; f.objectId.data[0] = 3; }, 'unregistered-id'],
  ];
  for (const [edit, kind] of missing) {
    const f = idFrame(2, [10, 5, 34, 25]); edit(f);
    const r = verifySampledBboxes([idFrame(1, [10, 5, 34, 25]), f]);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((x) => x.frame === 2 && x.kind === kind));
  }
  const f = textFrame([100, 40, 180, 60]);
  delete f.ocr;
  assert.equal(verifySampledBboxes([f]).ok, false);
  f.meta.texts = null;
  assert.equal(verifySampledBboxes([f]).ok, false);
  f.ocr = [];
  assert.equal(verifySampledBboxes([f]).ok, false);
});

test('相邻文字独占各自的墨迹，识别顺序可以不同', () => {
  const f = textFrame([100, 40, 140, 60]);
  f.inkMask.data.fill(0);
  f.meta.texts.push({ text: 'NEXT', bbox2d: [150, 40, 190, 60] });
  f.ocr = structuredClone(f.meta.texts).reverse();
  for (const { bbox2d: [left, top, right, bottom] } of f.meta.texts) {
    for (let y = top; y < bottom; y++) f.inkMask.data.fill(1, y * 320 + left, y * 320 + right);
  }
  assert.equal(verifySampledBboxes([f]).ok, true);
  f.ocr.reverse();
  [f.ocr[0].text, f.ocr[1].text] = [f.ocr[1].text, f.ocr[0].text];
  assert.equal(verifySampledBboxes([f]).ok, false);
});

test('floor 用未声明的连续冻结长度、full 镜头主角和峰值帧判定', () => {
  const film = makeFilm();
  film.shots[0].deliberate = [{ kind: 'freeze', in: 10, out: 40, why: '停留' }];
  const m = goodMeasured();
  m.freezes = [{ in: 10, out: 45 }];
  assert.equal(evaluateFloor(film, m)[0].status, 'pass');
  m.freezes[0].out = 52;
  assert.equal(evaluateFloor(film, m)[0].results[0].counterexampleFrame, 40);
  m.frames[0].meta.entities[0].visible = null;
  m.frames[1].meta.entities[0].pxArea /= 2;
  const peak = evaluateFloor(film, m)[4].results[0];
  assert.equal(peak.status, 'fail');
  assert.equal(peak.counterexampleFrame, 0);
  for (const f of m.frames) f.meta.entities = [];
  assert.equal(evaluateFloor(film, m)[3].status, 'fail');
});

test('守卫冻结原表，逐项核对副本及 hero 存在证据', () => {
  assert.throws(() => { FLOOR.items[3].limited = true; }, TypeError);
  const tpl = structuredClone(FLOOR);
  tpl.roles = [];
  tpl.items[3].limited = true;
  tpl.items[4].when = 'has-audio';
  const r = guardPredicates(makeFilm(), tpl, entityEvidence);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 3);
  assert.deepEqual(r.items.map((x) => x.limited), FLOOR.items.map((x) => x.limited));
  const missing = guardPredicates(makeFilm());
  assert.equal(missing.ok, false);
  assert.equal(missing.unverified.length, 2);
});

test('二审 N1 & N2：完全在画外或被完全遮挡的实体不误判 no-pixels，L1 诊断装入 envelope/0.1 全过 EN1–EN4', async () => {
  // N1：画外实体（pxArea: 0，裁边面积为 0）及被完全遮挡实体（visible: 0）在编号层无像素时判过
  const f = idFrame(1, [10, 5, 34, 25]);
  f.meta.entities.push(
    { id: 10, name: 'prop_offscreen', class: 'part', bbox2d: [400, 200, 460, 240], pxArea: 0, visible: null },
    { id: 11, name: 'hero_occluded', class: 'part', role: 'mustSee', bbox2d: [12, 8, 24, 18], pxArea: 0.02, visible: 0 },
  );
  const res = verifySampledBboxes([f]);
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.frames[0].entities.find((e) => e.name === 'prop_offscreen').status, 'offscreen');
  assert.equal(res.frames[0].entities.find((e) => e.name === 'hero_occluded').status, 'occluded');

  // N2：制造多类 L1 与谓词错误及告警，装入 envelope/0.1 跑冻结契约校验（含 EN4）
  const { loadContracts } = await import('../kernel/contracts/validate.mjs');
  const { validate } = await loadContracts();
  const badFilm = makeFilm({
    output: { size: [W, H], fps: '29.97', frames: 240 },
    predicates: { base: ['floor@1', 'template:nope@1'], extra: ['key_fill_ratio(hero) >= 2', 'no_cut ;visible(hero)', 'unknown_pred(hero)'] },
  });
  badFilm.shots[0].out = 119.5;
  badFilm.style.tokens.ink = '#1a2b3c';
  badFilm.extraRootKey = 1;
  const l1 = checkL1(badFilm, {
    shotSources: { s01: { 'shots/s01.mjs': `const x = ${call('Math', 'random')}();` } },
    allowed: [{ path: 'shots/s01.mjs', call: call('performance', 'now') }],
  });
  assert.equal(l1.ok, false);
  assert.ok(l1.diagnostics.length >= 7);
  const env = {
    format: 'envelope/0.1',
    ok: false,
    exitCode: 4,
    error: { code: 'contract.bad-value', message: 'L1 未通过' },
    outputs: [],
    data: {},
    diagnostics: l1.diagnostics,
    cost: { tokens: 100, gpuSeconds: 0, wallMs: 5 },
    next: [],
  };
  assert.deepEqual(validate(env), { contract: 'envelope', schemaErrors: [], violations: {} });
});

test('noise_residual 与 alias_edge：登记为 0.1 谓词、不改 floor@1 六条、求值覆盖过门/越界/缺测/退化跳过', async () => {
  assert.equal(FLOOR.items.length, 6);
  assert.ok(Number.isFinite(DEFAULT_MAX_NOISE_RESIDUAL) && DEFAULT_MAX_NOISE_RESIDUAL > 0);
  assert.ok(Number.isFinite(DEFAULT_MAX_ALIAS_EDGE) && DEFAULT_MAX_ALIAS_EDGE > 0);

  for (const name of ['noise_residual', 'alias_edge']) {
    const entry = REGISTRY.predicates.find((p) => p.name === name);
    assert.ok(entry, `${name} 应已登记`);
    assert.deepEqual(entry.params, [{ name: 'target', type: 'ref', required: true }]);
    assert.deepEqual(entry.reads, ['film']);
    assert.deepEqual(entry.requires, []);
    assert.equal(entry.since, '0.1');
  }

  assert.equal(checkAssertion(`noise_residual(film) <= ${DEFAULT_MAX_NOISE_RESIDUAL}`).ok, true);
  assert.equal(checkAssertion(`alias_edge(film) <= ${DEFAULT_MAX_ALIAS_EDGE}`).ok, true);
  assert.equal(checkAssertion('noise_residual() <= 4').ok, false);
  assert.equal(checkAssertion('alias_edge(123) <= 1').ok, false);

  const film = makeFilm({
    predicates: {
      base: ['floor@1'],
      extra: ['noise_residual(film) <= 3', 'alias_edge(film) <= 0.5'],
    },
  });
  assert.equal(checkL1(film).ok, true);

  // noise_residual：数值与对象形态、过门/越界/跳过
  assert.equal(evaluateAssertion('noise_residual(film) <= 4.5', film, { noiseResidual: 0.35 }).status, 'pass');
  assert.equal(evaluateAssertion('noise_residual(film) <= 4.5', film, { noiseResidual: { value: 2.1, status: 'ok' } }).status, 'pass');
  assert.equal(evaluateAssertion('noise_residual(film)', film, { noiseResidual: DEFAULT_MAX_NOISE_RESIDUAL }).status, 'pass');

  const noisyFail = evaluateAssertion('noise_residual(film) <= 4.5', film, { noiseResidual: { value: 5.125, status: 'ok' } });
  assert.equal(noisyFail.status, 'fail');
  assert.equal(noisyFail.ok, false);
  assert.equal(noisyFail.measured, 5.125);
  assert.match(noisyFail.expected, /4\.5/);
  assert.match(noisyFail.expected, /5\.125/);
  assert.ok(noisyFail.hint);

  const bareNoisyFail = evaluateAssertion('noise_residual(film)', film, { noiseResidual: DEFAULT_MAX_NOISE_RESIDUAL + 1 });
  assert.equal(bareNoisyFail.status, 'fail');

  for (const measured of [
    {},
    { noiseResidual: null },
    { noiseResidual: { value: null, status: 'no-static-region' } },
    { noiseResidual: { value: null, status: 'insufficient-frames' } },
    { noiseResidual: { value: null, status: 'insufficient-resolution' } },
    { noiseResidual: { value: null, details: { code: 'tool-missing', tool: 'ffmpeg' } } },
  ]) {
    const r = evaluateAssertion('noise_residual(film) <= 4.5', film, measured);
    assert.equal(r.status, 'skipped', JSON.stringify(measured));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }

  // alias_edge：数值与对象形态、过门/越界/跳过（默认上限 0.6 px，拦住 0.727 px 1x 点采样斜边）
  assert.equal(DEFAULT_MAX_ALIAS_EDGE, 0.6);
  assert.equal(evaluateAssertion('alias_edge(film) <= 0.6', film, { aliasEdge: 0.12 }).status, 'pass');
  assert.equal(evaluateAssertion('alias_edge(film) <= 0.6', film, { aliasEdge: { value: 0.45, status: 'ok' } }).status, 'pass');
  assert.equal(evaluateAssertion('alias_edge(film)', film, { aliasEdge: DEFAULT_MAX_ALIAS_EDGE }).status, 'pass');

  const aliasFail = evaluateAssertion('alias_edge(film) <= 0.6', film, { aliasEdge: { value: 0.727, status: 'ok' } });
  assert.equal(aliasFail.status, 'fail');
  assert.equal(aliasFail.ok, false);
  assert.equal(aliasFail.measured, 0.727);
  assert.match(aliasFail.expected, /0\.6/);
  assert.match(aliasFail.expected, /0\.727/);
  assert.ok(aliasFail.hint);

  const bareAliasFail = evaluateAssertion('alias_edge(film)', film, { aliasEdge: 0.727 });
  assert.equal(bareAliasFail.status, 'fail');

  // R1 回归：非 film 目标不得借视频读数通过；局部帧区间 @ [0,2) 无分段证据时返回 skipped 不得凭全片读数误判
  assert.equal(evaluateAssertion('noise_residual(audio) <= 4', film, { noiseResidual: 0.05 }).status, 'fail');
  assert.equal(evaluateAssertion('alias_edge(audio) <= 1', film, { aliasEdge: 0.05 }).status, 'fail');
  assert.equal(evaluateAssertion('alias_edge(film) <= 1 @ [0,2)', film, { aliasEdge: { value: 2, status: 'ok' } }).status, 'skipped');
  assert.equal(evaluateAssertion('noise_residual(film) <= 1 @ [0,2)', film, { noiseResidual: { value: 6, status: 'ok' } }).status, 'skipped');

  for (const measured of [
    {},
    { aliasEdge: null },
    { aliasEdge: { value: 0, status: 'no-edges' } },
    { aliasEdge: { value: null, status: 'ok' } },
    { aliasEdge: { value: null, details: { code: 'tool-missing', tool: 'ffprobe' } } },
  ]) {
    const r = evaluateAssertion('alias_edge(film) <= 0.6', film, measured);
    assert.equal(r.status, 'skipped', JSON.stringify(measured));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }

  // toVerdict 过 verdict.schema.json 与 PR7
  const verdictSchema = JSON.parse(readFileSync(new URL('../kernel/contracts/predicates/schema/verdict.schema.json', import.meta.url)));
  const fixSchema = JSON.parse(readFileSync(new URL('../kernel/contracts/patch/schema/fix.schema.json', import.meta.url)));
  const validateVerdict = new Ajv2020({ strict: false }).addSchema(fixSchema).compile(verdictSchema);
  for (const res of [
    evaluateAssertion('noise_residual(film) <= 4.5', film, { noiseResidual: 0.2 }),
    noisyFail,
    evaluateAssertion('noise_residual(film) <= 4.5', film, { noiseResidual: { value: null, status: 'no-static-region' } }),
    evaluateAssertion('alias_edge(film) <= 0.6', film, { aliasEdge: 0.1 }),
    aliasFail,
    evaluateAssertion('alias_edge(film) <= 0.6', film, { aliasEdge: { value: 0, status: 'no-edges' } }),
    evaluateAssertion('alias_edge(film) <= 1 @ [0,2)', film, { aliasEdge: { value: 2, status: 'ok' } }),
  ]) {
    const v = toVerdict(res, { base: true });
    assert.ok(validateVerdict(v), JSON.stringify(validateVerdict.errors));
  }
});

