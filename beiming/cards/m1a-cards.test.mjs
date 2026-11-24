// 首批 11 张基础卡和「卡加数据」这条路的自检：
//   一、11 张卡的卡文件过契约校验和泄露扫描，目录、落点、形状和任务书的表一致，每份实现只有一个卡入口；
//   二、纯函数门：同一个时刻单独求、乱序求、顺序求，摘要相同；
//   三、卡运行库（cards/runtime.mjs）和装载前的检查；
//   四、起无头浏览器实渲：例子片子 film-min 的片名镜头 s02，和一部探针片子（带入口文件的探针镜头、两个「卡加数据」镜头），
//       把看到的写成核对记录交给契约的校验器。这台机器起不了浏览器时第四部分跳过，不算失败。
// 来历：请求是这里自己传的、从片子描述读的；量的是这里读层文件、自己算摘要得出的；旁观是探针镜头和观测点经读数交出来的；
// 自报是帧源交回的元数据里写的（装载的账在 ext["page.load"]）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three-webgpu';
import { getList } from '../host/page/cards-probe.shot.js';
import { loadCards, startSource } from '../host/page/host.mjs';
import { readObservation } from '../kernel/conformance/fixtures/observe.js';
import { metaCheck, shotCheck, sourceCheck, timeCheck } from '../kernel/conformance/records.mjs';
import { scanFiles, shotFiles, sourceFiles } from '../kernel/conformance/scan.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { eventsTable, renderingOf, shotInput } from '../kernel/eval/input.mjs';
import { stream, streamName } from '../kernel/eval/rng.mjs';
import { hold } from '../kernel/eval/time.mjs';
import { caps } from '../sources/three/caps.mjs';
import { planOpen } from '../sources/three/plan.mjs';
import {
  OVERLAY_CARD, checkInstanceNames, createOrder, expandOverlays, hashCardContents, implFor, localFrame, mergeEntities, mergeMeta, orderPairs,
  parseCardRef, resolveParams, scanCardLeaks, unfitReason, validateCard, verifyCardLock,
} from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEIMING = resolve(HERE, '..'), REPO = resolve(BEIMING, '..');
const FILM_MIN_DIR = join(BEIMING, 'kernel/contracts/examples/film-min');
const PROBE_DIR = join(BEIMING, 'host/page');
const rel = (p) => relative(REPO, p).split(sep).join('/');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// 任务书的表：目录、卡名、类别、落点、形状
const CARDS = [
  ['time/timeline', 'time.timeline', 'time', 'data', 'evaluate'],
  ['time/envelope', 'time.envelope', 'time', 'data', 'evaluate'],
  ['time/events', 'time.events', 'time', 'data', 'evaluate'],
  ['time/seeded', 'time.seeded', 'time', 'data', 'evaluate'],
  ['camera/spline', 'camera.spline', 'camera', 'data', 'evaluate'],
  ['post/hdr-chain', 'post.hdr-chain', 'post', 'source:three', 'create'],
  ['post/comp-display', 'comp.display', 'post', 'comp', 'create'],
  ['post/comp-finish', 'comp.finish', 'post', 'comp', 'create'],
  ['delivery/encode', 'deliver.encode', 'delivery', 'comp', 'create'],
  ['audio/master', 'audio.master', 'audio', 'comp', 'create'],
  ['two-d/overlay-title', 'overlay.title', 'two-d', 'source:three', 'create'],
].map(([dir, id, kind, livesIn, shape]) => ({ dir, id, kind, livesIn, shape, abs: join(HERE, dir) }));
const DIRS = CARDS.map((c) => `cards/${c.dir}`);
// 交给 three 帧源的卡：落点在 three 的两张，加数据卡（相机样条有地方写；时间线没有，留着验「装不了」）
const THREE_DIRS = ['cards/two-d/overlay-title', 'cards/post/hdr-chain', 'cards/camera/spline', 'cards/time/timeline'];

const contracts = await loadContracts();
const library = await loadCards(DIRS);
const judged = (obj, schema) => {
  const v = contracts.validate(obj, 'source', schema);
  return { schemaErrors: v.schemaErrors, violations: v.violations };
};
const CLEAN = { schemaErrors: [], violations: {} };
/** 卡目录下的全部文件（相对卡目录，正斜杠） */
const filesOf = (abs) => readdirSync(abs, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(abs, join(e.parentPath, e.name)).split(sep).join('/')).sort();
/** 一份实现对外的卡入口：读模块数它导出了 create、evaluate 里的哪几个 */
const entriesOf = async (entry) => Object.keys(await import(pathToFileURL(join(BEIMING, entry)))).filter((k) => ['create', 'evaluate'].includes(k));

/**
 * 测试自己照本机锁的写法现算的锁：卡的版本和落点从卡文件读，内容哈希由这里算，验证记录取卡文件 status 的第一项。
 * 不是完整的全片锁：只写了 three 帧源和它出的镜头（seeds 是 { 镜头: 种子 }）。
 */
function localLock(film, seeds, lib = library) {
  return {
    format: 'lock/1.0', issuer: 'local', film: film.id, contracts: '0.1.0',
    seeds: { film: 20261121, ...seeds },
    shots: Object.fromEntries(Object.keys(seeds).map((id) => [id, { shutterSamples: 1 }])),
    sources: { three: { version: '0.187.0', host: 'page' } },
    cards: Object.fromEntries(Object.entries(lib).map(([name, { card, sha256 }]) => {
      const { level, host, source, gpu } = card.status[0];
      return [name, { version: card.version, impl: [...card.livesIn], sha256, verified: { level, host, source, gpu } }];
    })),
    assets: {}, templates: {}, view: {},
  };
}

// ---------- 一、卡文件 ----------

test('cards/ 下面包含首批 11 张 M1a 基础卡，每张卡（连后来加的）都在 cards/<kind>/<目录名>/，基础卡带卡文件、入口和自测', () => {
  const found = readdirSync(HERE, { recursive: true }).filter((p) => p.endsWith('card.json')).map((p) => dirname(p).split(sep).join('/')).filter((d) => !d.startsWith('mechanism/')).sort();
  // 后来的里程碑往 cards/ 里加卡，这里不数总数：只要求这 11 张都在，所有卡的目录都是两层
  assert.equal(CARDS.length, 11);
  assert.deepEqual(CARDS.map((c) => c.dir).filter((d) => !found.includes(d)), []);
  assert.deepEqual(found.filter((d) => !/^[^/]+\/[^/]+$/.test(d)), []);
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json')), [impl] = card.impl;
    assert.deepEqual([card.id, card.kind, card.livesIn, card.impl.length, impl.livesIn, impl.shape], [c.id, c.kind, [c.livesIn], 1, c.livesIn, c.shape], c.dir);
    assert.ok(impl.entry.startsWith(`cards/${c.dir}/`) && impl.selftest === `cards/${c.dir}/selftest.test.mjs`, `${c.dir} 的入口和自测在卡目录里`);
    assert.ok(existsSync(join(BEIMING, impl.entry)) && existsSync(join(BEIMING, impl.selftest)), `${c.dir} 的入口和自测文件在`);
  }
});

test('每张卡的卡文件过契约校验（结构加 CF 各条）；卡目录下的每个文件过泄露扫描', () => {
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json'));
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, c.dir);
    assert.deepEqual(judged(card), CLEAN, c.dir);
    for (const f of filesOf(c.abs)) assert.deepEqual(scanCardLeaks(readFileSync(join(c.abs, f), 'utf8')), [], `${c.dir}/${f}`);
  }
});

test('每张卡：给模型看、版本 1.0.0、状态里有 reproduced、挂着 cal:<卡名>、参数的默认值过得了自己的检查', () => {
  for (const c of CARDS) {
    const card = readJson(join(c.abs, 'card.json'));
    assert.deepEqual([card.visibleToAgent, card.version], [true, '1.0.0'], c.dir);
    assert.ok(card.status.some((s) => s.level === 'reproduced'), c.dir);
    assert.ok(card.exams.includes(`cal:${c.id}`), c.dir);
    assert.deepEqual(Object.keys(resolveParams(card, {})), Object.keys(card.params), c.dir);
  }
});

test('每份实现对外正好一个卡入口，就是卡文件声明的形状（CR1）', async () => {
  for (const c of CARDS) assert.deepEqual(await entriesOf(readJson(join(c.abs, 'card.json')).impl[0].entry), [c.shape], c.dir);
});

test('卡的内容哈希：照锁文件的算法从卡目录的文件算，和宿主读进来的一致；现算的本机锁过锁文件的结构和 LK 各条', () => {
  const lock = localLock({ id: 'f_min' }, { s02: 7803 });
  for (const c of CARDS) {
    const hashes = Object.fromEntries(filesOf(c.abs).map((f) => [f, sha(readFileSync(join(c.abs, f)))]));
    assert.equal(hashCardContents(hashes), library[c.id].sha256, c.dir);
    assert.equal(verifyCardLock(library[c.id].card, hashes, lock.cards[c.id]).ok, true, c.dir);
    hashes['card.json'] = sha('改过的卡文件');
    assert.equal(verifyCardLock(library[c.id].card, hashes, lock.cards[c.id]).ok, false, `${c.dir} 改了内容锁就对不上`);
  }
  assert.deepEqual(judged(lock), CLEAN);
});

// ---------- 二、纯函数门 ----------

/** 用命名随机流打乱；打乱后和原来一样就再来 */
function shuffled(list, s) {
  const out = [...list];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.length > 1 && out.every((v, i) => v === list[i]));
  return out;
}
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const MOMENTS = [{ f: 0, sub: 0 }, { f: 3, sub: 0 }, { f: 3, sub: 0.5 }, { f: 12, sub: 0 }, { f: 12, sub: 0.25 }, { f: 13, sub: 0 }, { f: 23, sub: 0.75 }];
const DATA_INPUTS = deepFreeze({
  fps: '24/1', size: [640, 360], seed: 4102, shot: { id: 'p02', in: 24, frames: 24 },
  events: [{ id: 'hit', kind: 'named', f: 12, sub: 0 }, { id: 'cut.24', kind: 'cut', f: 0, sub: 0 }],
});
const SPLINE_KEYS = [{ f: 0, pos: [0, 0.5, 4], look: [0, 0.5, 0], fovDeg: 30 }, { f: 12, pos: [2, 0.5, 4], look: [0, 0.5, 0] }, { f: 23, pos: [2, 2, 4], look: [0, 0.5, 0], fovDeg: 50 }];
const DATA_PARAMS = {
  'time.timeline': { holdFrames: 2 }, 'time.envelope': { at: 36, attackFrames: 2, releaseFrames: 6 }, 'time.events': { kind: 'any' },
  'time.seeded': { count: 3 }, 'camera.spline': { keys: SPLINE_KEYS },
};

/** 一张数据卡在 MOMENTS 上三种求法的观测：每项 { f, sub, mode, digest }，摘要是返回值写成 JSON 之后的 SHA-256 */
async function dataEvaluations(id) {
  const { card } = library[id], { evaluate } = await import(pathToFileURL(join(BEIMING, card.impl[0].entry)));
  const params = deepFreeze(resolveParams(card, DATA_PARAMS[id], { events: [], shotIn: DATA_INPUTS.shot.in }));
  const digest = (m) => sha(JSON.stringify(evaluate(DATA_INPUTS, params, m.f, m.sub)));
  const orders = { single: MOMENTS, sequential: MOMENTS, shuffled: shuffled(MOMENTS, stream(streamName(4102, 'p02', `gate/${id}`))) };
  return Object.entries(orders).flatMap(([mode, list]) => list.map((m) => ({ ...m, mode, digest: digest(m) })));
}

test('五张数据卡的纯函数门：同一个时刻单独求、乱序求、顺序求摘要相同，不改传进去的输入和参数；不同时刻的摘要不全相同', async () => {
  for (const id of Object.keys(DATA_PARAMS)) {
    const evaluations = await dataEvaluations(id);
    assert.equal(evaluations.length, MOMENTS.length * 3, id);
    for (const m of MOMENTS) assert.equal(new Set(evaluations.filter((e) => e.f === m.f && e.sub === m.sub).map((e) => e.digest)).size, 1, `${id} f=${m.f} sub=${m.sub}`);
    assert.ok(new Set(evaluations.map((e) => e.digest)).size > 1, `${id} 随时刻变`);
  }
});

test('create 形状的卡的纯函数门：片名的摆法、成片修饰出的画面只由时刻定，先摆别的帧再回来结果相同', async () => {
  const { create: title } = await import('./two-d/overlay-title/three.js'), { create: finish } = await import('./post/comp-finish/comp.mjs');
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  const t = title({ THREE, size: [640, 360] }, resolveParams(library['overlay.title'].card, { text: 'M1A', enter: 2, settleFrames: 12 }));
  camera.add(t.object);
  const image = Uint8ClampedArray.from({ length: 16 * 9 * 4 }, (_, i) => (i * 7) % 256);
  const fin = finish({ rng: (arg) => stream(streamName(1, 'film', arg)) }, { grain: 0.04, vignette: 0.2 });
  const states = {
    'overlay.title': (m) => { t.apply(m.f, m.sub); return sha(JSON.stringify([t.object.visible, t.object.position.toArray(), t.object.scale.toArray(), t.object.material.opacity, t.meta(m.f)])); },
    'comp.finish': (m) => { fin.apply(m.f, m.sub); return sha(fin.object.process(image, [16, 9])); },
  };
  for (const [id, state] of Object.entries(states)) {
    const first = MOMENTS.map(state), again = shuffled(MOMENTS, stream(streamName(1, 'film', `gate/${id}`))).map((m) => [m, state(m)]);
    for (const [m, digest] of again) assert.equal(digest, first[MOMENTS.indexOf(m)], `${id} f=${m.f} sub=${m.sub}`);
    assert.ok(new Set(first).size > 1, `${id} 随时刻变`);
  }
});

// ---------- 三、卡运行库和装载前的检查 ----------

const coded = (code) => (e) => e.code === code;

test('卡的引用和落点：<卡名>@<主版本>；先取帧源一侧的实现，没有再取数据一侧的', () => {
  assert.deepEqual(parseCardRef('overlay.title@1'), { name: 'overlay.title', major: 1 });
  for (const bad of ['overlay.title', 'overlay.title@1.0', 'Title@1', 7]) assert.throws(() => parseCardRef(bad), coded('usage.bad-argument'));
  assert.equal(implFor(library['overlay.title'].card, 'three').livesIn, 'source:three');
  assert.equal(implFor(library['camera.spline'].card, 'three').livesIn, 'data');
  assert.equal(implFor(library['comp.display'].card, 'three'), undefined);
});

test('一张卡装不装得了：没提供、主版本不符、锁里没有、哈希对不上、没有落点实现，各说得出原因', () => {
  const lock = localLock({ id: 'x' }, { s: 1 }), reason = (use, l = lock, lib = library) => unfitReason(lib, l, use, 'three');
  assert.equal(reason('overlay.title@1'), null);
  assert.equal(reason('camera.spline@1'), null);
  for (const use of ['nobody.here@1', 'overlay.title@2', 'comp.display@1', 'not a ref']) assert.equal(typeof reason(use), 'string', use);
  const { 'overlay.title': gone, ...rest } = lock.cards;
  assert.equal(typeof reason('overlay.title@1', { ...lock, cards: rest }), 'string');
  assert.equal(typeof reason('overlay.title@1', { ...lock, cards: { ...lock.cards, 'overlay.title': { ...gone, sha256: sha('别的内容') } } }), 'string');
  assert.equal(typeof reason('overlay.title@1', { ...lock, cards: { ...lock.cards, 'overlay.title': { ...gone, version: '1.0.1' } } }), 'string');
  assert.equal(typeof reason('overlay.title@1', { ...lock, cards: { ...lock.cards, 'overlay.title': { ...gone, impl: ['source:blender'] } } }), 'string');
});

test('时刻换成镜头局部帧号：整数减起始帧，算式查事件表；参数没写用默认值，写了不认识的、类型不对的、出范围的都报错', () => {
  const events = [{ id: 'title', kind: 'named', frame: 192 }, { id: 'cut.180', kind: 'cut', frame: 180 }];
  assert.deepEqual([localFrame(200, events, 180), localFrame('event(title)', events, 180), localFrame('event(title) - 2', events, 180), localFrame('cut(180) + 12', events, 180)], [20, 12, 10, 12]);
  for (const bad of ['event(nobody)', 'cut(7)', 'title', 1.5]) assert.throws(() => localFrame(bad, events, 180), coded('usage.bad-argument'));
  const { card } = library['overlay.title'];
  assert.deepEqual(resolveParams(card, { text: 'RTX 5090', enter: 'event(title)' }, { events, shotIn: 180 }), { text: 'RTX 5090', enter: 12, settleFrames: 24, ink: '#F4F0E9', heightFrac: 0.12, distance: 1, motion: 'rise' });
  for (const bad of [{ size: 3 }, { settleFrames: 2.5 }, { heightFrac: 0.9 }, { text: 5 }, { distance: '1' }]) assert.throws(() => resolveParams(card, bad), coded('usage.bad-argument'), JSON.stringify(bad));
});

test('叠加层各展开成一个卡实例；实例名不得是 tracks、host，不得重复', () => {
  assert.deepEqual(expandOverlays([{ id: 'cap', shot: 's01', anchor: 'screen', pos: [0.5, 0.9], text: '你好', in: 3, out: 9 }]), [{ as: 'cap', use: OVERLAY_CARD, params: { anchor: 'screen', pos: [0.5, 0.9], text: '你好', in: 3, out: 9 } }]);
  assert.deepEqual(expandOverlays(undefined), []);
  checkInstanceNames(['a', 'b']);
  for (const bad of [['tracks'], ['a', 'host'], ['a', 'b', 'a']]) assert.throws(() => checkInstanceNames(bad), coded('usage.bad-argument'));
});

test('create 的次序：照先后要求排，没有要求的照书写顺序；成环或者提到镜头里没有的实例报 contract.order-cycle', () => {
  const inst = (as, id) => ({ as, card: library[id].card });
  // 合成一侧的三张卡之间写了先后：显示变换在成片修饰和编码之前，成片修饰在编码之前
  const instances = [inst('enc', 'deliver.encode'), inst('fin', 'comp.finish'), inst('view', 'comp.display'), inst('title', 'overlay.title')];
  const pairs = orderPairs(instances);
  assert.deepEqual(pairs.map((p) => p.join('>')).sort(), ['fin>enc', 'view>enc', 'view>fin']);
  assert.deepEqual(createOrder(instances.map((i) => i.as), pairs), ['view', 'fin', 'enc', 'title']);
  assert.deepEqual(orderPairs([inst('fin', 'comp.finish'), inst('title', 'overlay.title')]), []);
  assert.deepEqual(createOrder(['sky', 'hdr', 'particles', 'title'], [['particles', 'hdr']]), ['sky', 'particles', 'hdr', 'title']);
  assert.throws(() => createOrder(['hdr', 'particles'], [['hdr', 'particles'], ['particles', 'hdr']]), coded('contract.order-cycle'));
  assert.throws(() => createOrder(['hdr'], [['ghost', 'hdr']]), coded('contract.order-cycle'));
});

test('并进镜头的名字：实体加实例前缀，带 root 的就叫实例名；文字框的 id 和读数的名字加实例前缀', () => {
  const a = {}, b = {};
  assert.deepEqual(mergeEntities('title', { plane: { object: a, root: true }, shadow: b }).map((m) => [m.rel, m.name, m.root, m.object === (m.root ? a : b)]), [['plane', 'title', true, true], ['shadow', 'title.shadow', false, true]]);
  assert.deepEqual(mergeEntities('title', undefined), []);
  assert.throws(() => mergeEntities('t', { a: { object: a, root: true }, b: { object: b, root: true } }));
  assert.throws(() => mergeEntities('t', { 'bad name': a }));
  const m = mergeMeta('title', { texts: [{ id: 'line', text: 'A', bbox2d: [0, 0, 1, 1] }, { text: 'B', bbox2d: [0, 0, 1, 1] }], readings: { opacity: 1 } });
  assert.deepEqual([m.texts.map((t) => t.id), m.readings, m.ids, m.merged], [['title.line', undefined], { 'title.opacity': 1 }, ['line', 'opacity'], ['title.line', 'title.opacity']]);
  assert.throws(() => mergeMeta('title', { stats: {} }));
});

test('装载之前：提供了卡才声明「卡加数据」；没有锁报 env.lock-required；带锁时卡没提供、哈希不符、数据卡的轨道没地方写、带叠加层或资产都报 contract.unsupported-input', async () => {
  const film = readJson(join(FILM_MIN_DIR, 'film.json')), input = shotInput(film, 's02', eventsTable(film));
  const lib = await loadCards(THREE_DIRS), lock = localLock(film, { s02: 7803 }), env = { lock, tier: 'final' };
  assert.deepEqual([caps().modes, caps(lib).modes], [['native-code'], ['cards-data', 'native-code']]);
  assert.deepEqual([judged(caps()), judged(caps(lib))], [CLEAN, CLEAN]);
  assert.deepEqual(planOpen(caps(lib), input, env, lib), { seed: 7803, shutterSamples: 1 });
  assert.throws(() => planOpen(caps(lib), input, { lock: null, tier: 'final' }, lib), coded('env.lock-required'));
  assert.throws(() => planOpen(caps(), input, env), coded('contract.unsupported-mode'));
  const { 'overlay.title': title, ...others } = lib;
  assert.throws(() => planOpen(caps(others), input, env, others), coded('contract.unsupported-input'));
  const tampered = { ...lock, cards: { ...lock.cards, 'overlay.title': { ...lock.cards['overlay.title'], sha256: sha('别的内容') } } };
  assert.throws(() => planOpen(caps(lib), input, { lock: tampered, tier: 'final' }, lib), coded('contract.unsupported-input'));
  const withCards = (cards) => ({ ...input, shot: { ...input.shot, cards } });
  assert.throws(() => planOpen(caps(lib), withCards([{ as: 'clock', use: 'time.timeline@1', params: {} }]), env, lib), coded('contract.unsupported-input'));
  assert.throws(() => planOpen(caps(lib), { ...input, overlays: [{ id: 'cap', shot: 's02', anchor: 'screen', pos: [0.5, 0.5], text: 'x', in: 180, out: 181 }] }, env, lib), coded('contract.unsupported-input'));
  assert.throws(() => planOpen(caps(lib), { ...input, shot: { ...input.shot, assets: { kit: 'asset:kit@1' } } }, env, lib), coded('contract.unsupported-input'));
  assert.throws(() => planOpen(caps(lib), withCards([{ as: 'tracks', use: 'overlay.title@1', params: {} }]), env, lib), coded('usage.bad-argument'));
});

// ---------- 四、实渲 ----------

// 探针片子：p01 是带入口文件的探针镜头，经 ctx.cards.use 装片名卡；p02、p03 是「卡加数据」镜头，相机走样条、片名同样的参数，
// p02 多一条恒等的后期链。640 × 360 像素，每秒 24 帧。
const probeShot = (id, start, extra) => ({ id, in: start, out: start + 24, source: 'three', host: 'page', colorRef: 'display', seed: 4100 + start / 24 + 1, ...extra });
const dataCards = (start, more = []) => [
  { as: 'cam', use: 'camera.spline@1', params: { keys: SPLINE_KEYS } },
  { as: 'title', use: 'overlay.title@1', params: { text: 'CAM 02', enter: start + 2, settleFrames: 4, heightFrac: 0.2 } },
  ...more,
];
const PROBE_FILM = {
  format: 'film/3.0', id: 'm1a-cards-probe', title: '卡加数据这条路的探针片子',
  output: { size: [640, 360], fps: '24/1', frames: 72 },
  shots: [
    probeShot('p01', 0, {
      mode: 'native-code', entry: 'cards-probe.shot.js', params: { uses: ['title'] },
      cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'M1A', enter: 'event(hit)', settleFrames: 6, heightFrac: 0.2 } }],
      roles: { hero: 'cube', mustSee: ['title'] },
    }),
    probeShot('p02', 24, { mode: 'cards-data', cards: dataCards(24, [{ as: 'hdr', use: 'post.hdr-chain@1', params: {} }]), roles: { hero: 'title' } }),
    probeShot('p03', 48, { mode: 'cards-data', cards: dataCards(48), roles: { hero: 'title' } }),
  ],
  events: [{ id: 'hit', frame: 4, shot: 'p01' }],
  style: { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#1A1A1A', paper: '#F2EBDD' } },
  predicates: { base: ['floor@1'] },
  delivery: { master: 'h264-crf14-bt709' },
};
const P01_MOMENTS = [{ f: 2, sub: 0 }, { f: 5, sub: 0 }, { f: 5, sub: 0.5 }, { f: 7, sub: 0.25 }, { f: 12, sub: 0 }];
const WANT = ['color', 'meta', 'depth', 'objectId', 'normal'];

/**
 * 一部片子的出帧记账：照一致性入口（kernel/conformance/run.mjs）的做法，把每次 open、render 看到的攒成 records.mjs 认的形状。
 * 只经帧源接口取东西；层文件的哈希自己读文件重算。
 */
function ledger({ film, lock, filmDir, root }) {
  const events = eventsTable(film), named = events.events.filter((e) => e.kind === 'named');
  const shots = film.shots.filter((s) => renderingOf(s).source === 'three').map((shot) => {
    const { entry } = renderingOf(shot);
    // 这个镜头的实现文件（镜头契约 5.1 的数法）：入口文件和顺着引用追到的，加上片子描述里这个镜头列出的、形状是 create 的卡的实现；
    // evaluate 形状的卡在求值核里跑，不计入。没有入口文件的镜头，本镜头文件的扫描扫的就是这些卡的实现
    const created = (shot.cards ?? []).map((c) => implFor(library[parseCardRef(c.use).name].card, 'three')).filter((i) => i.shape === 'create').map((i) => `beiming/${i.entry}`);
    const own = entry ? shotFiles(REPO, rel(join(filmDir, entry))) : { files: [], scan: scanFiles(REPO, created) };
    const files = [...new Set([...own.files, ...created])];
    return { shot, input: shotInput(film, shot.id, events), files, scan: own.scan, languages: [...new Set(files.map((f) => ({ '.js': 'js', '.mjs': 'js', '.py': 'python' })[extname(f)]).filter(Boolean))], renders: [], opens: [], loads: [], evaluations: [], queries: [], rng: [], localized: [], metaFrames: [], manifest: null };
  });
  const one = (id) => shots.find((s) => s.shot.id === id);

  /**
   * 调一次 open。expect 给了错误码就是故意造的装不了的输入，交回抛出的错；成功时交回会话。
   * brokenEntry：这次是让入口文件故意做错事，不是合乎结构的夹具输入，不进帧源核对记录的 opens（帧源接口契约第 6 节：入口文件自己出错不归 F25 管）
   */
  async function open(source, id, label, { inp, withLock = true, usedLock = lock, tier = 'final', expect, unfitInput = [], brokenEntry = false } = {}) {
    const o = one(id), input = inp ?? o.input, { host, mode } = renderingOf(input.shot);
    const usesCards = (input.shot.cards ?? []).length > 0 || (input.overlays ?? []).length > 0;
    // plain：片子描述原样的镜头输入，带着这部片子的锁
    const rec = { plain: input === o.input && withLock && usedLock === lock, hasLock: withLock, hasSeed: Number.isInteger(input.shot.seed), usesCards, usesAssets: Object.keys(input.shot.assets ?? {}).length > 0 || Object.keys(input.assets ?? {}).length > 0, host, mode, unfitInput };
    if (!brokenEntry) o.opens.push(rec);
    const workspace = join(root, film.id, id, label);
    try {
      const session = await source.open(input, { lock: withLock ? usedLock : null, tier, workspace, filmDir });
      rec.status = 'ok';
      o.loads.push({ session: label, locked: withLock, tier, input });
      o.manifest ??= session.manifest();
      return { session, workspace, label, locked: withLock, tier, one: o };
    } catch (e) {
      Object.assign(rec, { status: 'error', ...(e.code ? { code: e.code } : {}) });
      if (!expect) throw e;
      assert.equal(e.code, expect, `${id}（${label}）该报 ${expect}：${e.message}`);
      return e;
    }
  }

  async function render(s, f, opts, want, more = {}) {
    const rec = { call: s.one.renders.length, session: s.label, locked: s.locked, tier: s.tier, f, opts, want, unsupportedOpts: [], unfitOutputs: [], ...more };
    s.one.renders.push(rec);
    const res = await s.session.render(f, opts, want);
    Object.assign(rec, { status: 'ok', layers: Object.keys(res.layers), refs: res.layers, layerRefs: [], fileBytes: {}, bytes: {} });
    for (const [output, ref] of Object.entries(res.layers)) {
      const bytes = await readFile(join(s.workspace, ref.file));
      rec.fileBytes[output] = bytes.length;
      rec.bytes[output] = bytes;
      rec.layerRefs.push({ output, shape: ref.shape, hash: ref.hash, fileHash: `sha256:${sha(bytes)}`, fileBytes: bytes.length });
    }
    rec.metas = res.meta ? 1 : 0;
    if (res.meta) Object.assign(rec, { meta: res.meta, metaBytes: Buffer.byteLength(JSON.stringify(res.meta)), seen: readObservation(res.meta.readings) });
    return rec;
  }

  /** 纯函数门：只取一个子帧采样就是要一个时刻的状态，它落在「快门角 ÷ 720」；状态摘要取颜色层的哈希。观测点看到的时刻就是要的那个才记 */
  async function evaluate(s, moments, mode) {
    for (const m of moments) {
      const r = await render(s, m.f, { shutter: { angleDeg: m.sub * 720, samples: 1 } }, ['color', 'meta'], { mode });
      const at = (r.seen?.states ?? []).filter((x) => x.color > 0);
      if (at.length === 1 && at[0].f === m.f && at[0].sub === m.sub) s.one.evaluations.push({ f: m.f, sub: m.sub, mode, digest: r.layerRefs.find((x) => x.output === 'color').fileHash.replace('sha256:', '') });
    }
  }

  /** 出完帧之后：把观测点交出来的随机流、事件帧号、meta 收到的帧号整理进去，写出各份核对记录 */
  function records(source) {
    for (const o of shots) {
      const ok = o.renders.filter((r) => r.status === 'ok'), first = ok.find((r) => r.seen);
      for (const x of first?.seen.rng ?? []) o.rng.push({ run: `${first.session}/${x.run}`, arg: x.arg, name: x.name, digest: sha(Buffer.from(Uint32Array.from(x.values).buffer)) });
      for (const x of first?.seen.events ?? []) o.localized.push({ frame: named.find((e) => e.id === x.id).frame, f: x.f });
      for (const r of ok.filter((x) => x.seen)) o.metaFrames.push({ frame: r.f + o.shot.in, f: r.seen.metaF });
    }
    const holds = [];
    for (let f = 0; f < 8; f++) for (let n = 1; n <= 3; n++) holds.push({ f, n, result: hold(f, n) });
    const path = scanFiles(REPO, [...new Set([...sourceFiles(REPO, ['beiming/kernel/eval', 'beiming/sources/three', 'beiming/host/page', 'beiming/cards']), ...shots.flatMap((o) => o.files)])], [{ path: 'beiming/host/page/clock.js', call: ['performance', 'now'].join('.') }]);
    const obs = { film, caps: source.caps(), lock, holds, scans: { path }, shots };
    const out = { 'time-check': timeCheck(obs), 'events-check': { format: 'events-check/0.1', events, film } };
    for (const o of shots) Object.assign(out, { [`${o.shot.id}.shot-check`]: shotCheck(obs, o), [`${o.shot.id}.source-check`]: sourceCheck(obs, o), [`${o.shot.id}.meta-check`]: metaCheck(obs, o) });
    return { out, path };
  }

  return { events, one, open, render, evaluate, records };
}

/** 装载核对记录：cards、overlays 从片子描述读（请求），别的照元数据 ext["page.load"] 里宿主自己记的账抄（自报） */
function loadCheck(input, account) {
  return {
    format: 'load-check/0.1', shot: input.shot.id, build: 'ok', steps: account.steps,
    cards: (input.shot.cards ?? []).map((c) => c.as),
    ...(input.overlays?.length ? { overlays: input.overlays.map((o) => o.id) } : {}),
    orderPairs: account.orderPairs, createOrder: account.createOrder, applyOrder: account.applyOrder, metaOrder: account.metaOrder,
    ...(account.camera ? { camera: account.camera } : {}),
  };
}

/** 一层浮点 RGBA 里透明度大于 0 的像素的外框 [x0, y0, x1, y1]（像素，右下不含）和个数 */
function inkBox(bytes, [h, w]) {
  const px = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) { count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  return { box: [x0, y0, x1, y1], count };
}
/** 编号层上某个编号的像素的外框 [x0, y0, x1, y1] 和个数 */
function idBox(bytes, [h, w], id) {
  const ids = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ids[y * w + x] === id) { count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  return { box: [x0, y0, x1, y1], count };
}
const colorHash = (r) => r.layerRefs.find((x) => x.output === 'color').fileHash;
const edgesOff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('实渲：片名镜头零手写镜头脚本出帧，探针片子的三个镜头，核对记录过契约的校验器', async (t) => {
  let source;
  // 这台机器起不了浏览器（比如只跑单元测试的 CI 没装）时跳过，不算失败
  try { source = await startSource({ cards: THREE_DIRS }); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'beiming-m1a-cards-'));
  try {
    const threeLib = await loadCards(THREE_DIRS);
    assert.deepEqual(judged(source.caps()), CLEAN);
    assert.deepEqual(source.caps().modes, ['cards-data', 'native-code']);

    // ----- 例子片子 film-min 的 s02：一张片名卡，没有入口文件 -----
    const film = readJson(join(FILM_MIN_DIR, 'film.json')), lock = localLock(film, { s02: 7803 });
    assert.deepEqual([judged(film), judged(lock)], [CLEAN, CLEAN]);
    const min = ledger({ film, lock, filmDir: FILM_MIN_DIR, root }), s02 = min.one('s02');
    assert.deepEqual(judged(s02.input, 'shot-input.schema.json'), CLEAN);
    // 事件 title 在全片第 192 帧，就是这个镜头的局部第 12 帧
    assert.equal(min.events.events.find((e) => e.id === 'title').frame, 192);

    await t.test('s02：没有锁文件报 env.lock-required；锁里片名卡的哈希对不上报 contract.unsupported-input', async () => {
      await min.open(source, 's02', 'no-lock', { withLock: false, expect: 'env.lock-required' });
      const tampered = { ...lock, cards: { ...lock.cards, 'overlay.title': { ...lock.cards['overlay.title'], sha256: sha('别的内容') } } };
      await min.open(source, 's02', 'tampered', { usedLock: tampered, expect: 'contract.unsupported-input', unfitInput: ['cards'] });
      await min.open(source, 's02', 'wrong-film', { usedLock: { ...lock, film: 'other_film' }, expect: 'usage.bad-argument', brokenEntry: true });
      await min.open(source, 's02', 'wrong-ver', { usedLock: { ...lock, sources: { ...lock.sources, three: { ...lock.sources.three, version: '0.186.0' } } }, expect: 'contract.unsupported-input', brokenEntry: true });
    });

    const session = await min.open(source, 's02', 'main');
    await t.test('s02：实体清单里是片名实体 title；入场之后的帧元数据过结构和 M 各条，带真实透视相机和 RTX 5090 的文字框', async () => {
      assert.deepEqual(s02.manifest, { frames: 120, entities: [{ id: 1, name: 'title', class: 'part' }] });
      for (const f of [20, 60]) {
        const r = await min.render(session, f, {}, WANT, { order: 'sequential' }), { meta } = r;
        assert.deepEqual(judged(meta), CLEAN, `第 ${f} 帧的元数据`);
        assert.deepEqual([meta.shot, meta.frame, meta.shotFrame, meta.seed, meta.size, meta.source.renderer, meta.source.host], ['s02', 180 + f, f, 7803, [1920, 1080], 'three', 'page']);
        // 相机：竖直视场角 40 度的透视相机，投影矩阵的四个数对得上（宽高比 16:9，近 0.1 米、远 100 米）
        const { camera } = meta, k = 1 / Math.tan((20 * Math.PI) / 180);
        assert.deepEqual([camera.fovYDeg, camera.near, camera.far, camera.world.length, camera.proj.length], [40, 0.1, 100, 16, 16]);
        for (const [i, want] of [[0, k / (16 / 9)], [5, k], [10, -100.1 / 99.9], [14, -20 / 99.9]]) assert.ok(Math.abs(camera.proj[i] - want) < 1e-6, `proj[${i}]`);
        assert.equal(camera.proj[11], -1);
        // 文字框
        assert.equal(meta.texts.length, 1);
        assert.deepEqual([meta.texts[0].id, meta.texts[0].text], ['title.line', 'RTX 5090']);
        // 片名实体：屏幕包围盒、屏占、可见比例、深度都是量出来的数，深度是离相机 1 米的平面
        const [title] = meta.entities;
        assert.deepEqual([title.name, title.role, title.visible, title.depth], ['title', 'hero', 1, [1, 1]]);
        assert.ok(title.bbox2d.every(Number.isFinite) && title.pxArea > 0.04 && title.pxArea < 0.07);
        // 颜色层上墨迹（透明度大于 0 的像素）的外框，对文字框、对实体的屏幕包围盒，四边都不超过 8 像素
        const ink = inkBox(r.bytes.color, r.refs.color.shape);
        assert.ok(ink.count > 20000, `墨迹像素 ${ink.count} 个`);
        assert.ok(edgesOff(meta.texts[0].bbox2d, ink.box) <= 8, `第 ${f} 帧文字框 ${meta.texts[0].bbox2d} 对墨迹外框 ${ink.box}`);
        assert.ok(edgesOff(title.bbox2d, ink.box) <= 8);
        // 编号层上片名的像素和颜色层的墨迹是同一批；深度层上这些像素是 1 米
        const ids = new Uint32Array(r.bytes.objectId.buffer, r.bytes.objectId.byteOffset, r.bytes.objectId.length / 4), depth = new Float32Array(r.bytes.depth.buffer, r.bytes.depth.byteOffset, r.bytes.depth.length / 4);
        assert.deepEqual(idBox(r.bytes.objectId, r.refs.objectId.shape, title.id), ink);
        assert.ok(depth.every((d, i) => (ids[i] === title.id ? Math.abs(d - 1) < 1e-5 : d === 1e10)));
      }
      // 落定之后字高是画面高的 0.12：129.6 像素，上下居中
      const settled = s02.renders.find((r) => r.f === 60).meta.texts[0].bbox2d;
      assert.ok(Math.abs(settled[3] - settled[1] - 129.6) < 1e-6 && Math.abs((settled[1] + settled[3]) / 2 - 540) < 1e-6 && Math.abs((settled[0] + settled[2]) / 2 - 960) < 1e-6);
    });

    await t.test('s02：入场的事件帧（局部第 12 帧）之前画面是空的、不交文字框；元数据照样过校验', async () => {
      for (const f of [0, 12]) {
        const r = await min.render(session, f, {}, ['color', 'meta']);
        assert.deepEqual(judged(r.meta), CLEAN);
        assert.deepEqual([r.meta.texts, inkBox(r.bytes.color, r.refs.color.shape).count, r.meta.entities[0].visible], [[], 0, 0]);
      }
      assert.deepEqual(s02.renders.at(-1).meta.events, [{ id: 'title', frame: 192 }]);
    });

    await t.test('s02：定住不动的那一段（局部第 42 到 119 帧，78 帧）每一帧的颜色层逐位相同；同一帧重渲、换一个新会话渲也逐位相同', async () => {
      const [freeze] = film.shots[1].deliberate, hashes = [];
      assert.deepEqual([freeze.in - 180, freeze.out - 180], [42, 120]);
      for (let f = 42; f < 120; f++) hashes.push(colorHash(await min.render(session, f, {}, ['color'])));
      assert.equal(hashes.length, 78);
      assert.equal(new Set(hashes).size, 1);
      const again = await min.render(session, 60, {}, ['color', 'meta'], { order: 'repeat' });
      assert.equal(colorHash(again), hashes[0]);
      assert.equal(again.meta.hash.color, hashes[0]);
      // 入场当中的帧和落定之后的不一样：不是每一帧都渲成了同一张
      assert.notEqual(colorHash(s02.renders.find((r) => r.f === 20)), hashes[0]);
      const fresh = await min.open(source, 's02', 'fresh');
      assert.equal(colorHash(await min.render(fresh, 60, {}, ['color', 'meta'], { order: 'single' })), hashes[0]);
      await fresh.session.close();
    });
    await session.session.close();

    await t.test('s02：草稿档（960×540）及改变宽高比的缩放（710×400）下，元数据过 M15 且文字框对墨迹外框四边误差不超过 8 像素', async () => {
      const draft = await min.open(source, 's02', 'draft', { tier: 'draft' });
      try {
        for (const f of [20, 60]) {
          const r = await min.render(draft, f, {}, WANT), { meta } = r;
          assert.deepEqual(judged(meta), CLEAN, `草稿档第 ${f} 帧的元数据`);
          assert.deepEqual([meta.size, r.refs.color.shape], [[960, 540], [540, 960, 4]]);
          const ink = inkBox(r.bytes.color, r.refs.color.shape);
          assert.ok(ink.count > 5000);
          assert.ok(edgesOff(meta.texts[0].bbox2d, ink.box) <= 8, `草稿档第 ${f} 帧文字框 ${meta.texts[0].bbox2d} 对墨迹外框 ${ink.box}`);
          assert.ok(edgesOff(meta.entities[0].bbox2d, ink.box) <= 8);
          if (f === 60) {
            const box = meta.texts[0].bbox2d;
            assert.ok(Math.abs(box[3] - box[1] - 64.8) < 1e-6 && Math.abs((box[1] + box[3]) / 2 - 270) < 1e-6 && Math.abs((box[0] + box[2]) / 2 - 480) < 1e-6);
          }
        }
        for (const scale of [0.37, 0.333]) {
          for (const f of [20, 60]) {
            const r = await min.render(draft, f, { scale }, ['color', 'meta']), { meta } = r;
            assert.deepEqual(judged(meta), CLEAN, `scale=${scale} 第 ${f} 帧元数据（含 M15）`);
            const ink = inkBox(r.bytes.color, r.refs.color.shape);
            assert.ok(edgesOff(meta.texts[0].bbox2d, ink.box) <= 8, `scale=${scale} 第 ${f} 帧文字框对墨迹`);
            assert.ok(edgesOff(meta.entities[0].bbox2d, ink.box) <= 8);
          }
        }
      } finally { await draft.session.close(); }
    });

    await t.test('s02：装载的账是固定装载的四步，片名卡经 create 装上；装载、镜头、帧源、元数据、时间各份核对记录过校验', () => {
      const account = s02.renders.find((r) => r.f === 60).meta.ext['page.load'];
      const check = loadCheck(s02.input, account);
      assert.deepEqual(check, { format: 'load-check/0.1', shot: 's02', build: 'ok', steps: ['assets', 'tracks', 'create', 'collect'], cards: ['title'], orderPairs: [], createOrder: ['title'], applyOrder: ['tracks', 'title'], metaOrder: ['host', 'title'] });
      assert.deepEqual(judged(check), CLEAN);
      const { out } = min.records(source);
      assert.deepEqual(Object.keys(out), ['time-check', 'events-check', 's02.shot-check', 's02.source-check', 's02.meta-check']);
      for (const [name, rec] of Object.entries(out)) assert.deepEqual(judged(rec), CLEAN, name);
      assert.deepEqual([out['s02.shot-check'].mode, out['s02.shot-check'].build, out['s02.shot-check'].declaredCards, out['s02.shot-check'].entities], ['cards-data', 'ok', ['title'], ['title']]);
      assert.equal(out['s02.meta-check'].renders.length, s02.renders.length);
    });

    // ----- 探针片子 -----
    const probeLock = localLock(PROBE_FILM, { p01: 4101, p02: 4102, p03: 4103 });
    assert.deepEqual([judged(PROBE_FILM), judged(probeLock)], [CLEAN, CLEAN]);
    const probe = ledger({ film: PROBE_FILM, lock: probeLock, filmDir: PROBE_DIR, root });
    const p01 = probe.one('p01'), p02 = probe.one('p02'), p03 = probe.one('p03');
    for (const o of [p01, p02, p03]) assert.deepEqual(judged(o.input, 'shot-input.schema.json'), CLEAN, o.shot.id);

    await t.test('p01：镜头代码经 ctx.cards.use 装卡；没声明过的实例报 contract.undeclared-card，runtime 和卡参数同名报 contract.runtime-shadows-param', async () => {
      const misused = (misuse) => ({ ...p01.input, shot: { ...p01.input.shot, params: { ...p01.input.shot.params, misuse } } });
      await probe.open(source, 'p01', 'undeclared', { inp: misused('undeclared'), expect: 'contract.undeclared-card', brokenEntry: true });
      await probe.open(source, 'p01', 'shadow', { inp: misused('shadow'), expect: 'contract.runtime-shadows-param', brokenEntry: true });
      // 没有锁文件时用了卡，装载之前就报错
      await probe.open(source, 'p01', 'no-lock', { withLock: false, expect: 'env.lock-required' });

      const seq = await probe.open(source, 'p01', 'sequential');
      assert.deepEqual(p01.manifest.entities.map((e) => [e.name, e.class]), [['cube', 'part'], ['title', 'part']]);
      for (const f of [2, 5, 12]) await probe.render(seq, f, {}, WANT, { order: 'sequential' });
      await probe.render(seq, 12, {}, WANT, { order: 'repeat' });
      await probe.evaluate(seq, P01_MOMENTS, 'sequential');
      await seq.session.close();
      for (const [i, m] of P01_MOMENTS.entries()) {
        const s = await probe.open(source, 'p01', `moment-${i}`);
        await probe.evaluate(s, [m], 'single');
        await s.session.close();
      }
      const mixed = await probe.open(source, 'p01', 'shuffled');
      await probe.evaluate(mixed, shuffled(P01_MOMENTS, stream(streamName(4101, 'p01', 'gate/shuffle'))), 'shuffled');
      await probe.render(mixed, 12, {}, WANT, { order: 'shuffled' });
      await mixed.session.close();

      // 纯函数门：每个时刻三种求法各记到一项，颜色层的哈希相同
      assert.equal(p01.evaluations.length, P01_MOMENTS.length * 3);
      for (const m of P01_MOMENTS) assert.equal(new Set(p01.evaluations.filter((e) => e.f === m.f && e.sub === m.sub).map((e) => e.digest)).size, 1, `f=${m.f} sub=${m.sub}`);
      assert.ok(new Set(p01.evaluations.map((e) => e.digest)).size >= 4);
      assert.equal(new Set(p01.renders.filter((r) => r.f === 12 && r.order).map(colorHash)).size, 1);

      // 第 12 帧：事件 hit 在第 4 帧，片名入场 6 帧，早已落定。元数据过校验；片名并进镜头叫 title，文字框叫 title.line
      const r = p01.renders.find((x) => x.f === 12 && x.order === 'sequential'), { meta, seen } = r;
      assert.deepEqual(judged(meta), CLEAN);
      assert.deepEqual([seen.builds, seen.cardUses], [1, [{ as: 'title', runtimeKeys: [] }, { as: 'title', runtimeKeys: [] }]]);
      assert.deepEqual([meta.readings['probe.title.same'], meta.readings['probe.hasTracksCamera']], [1, 0]);
      assert.deepEqual(meta.texts.map((x) => [x.id, x.text]), [['title.line', 'M1A']]);
      const [cube, title] = meta.entities;
      assert.deepEqual([cube.name, cube.role, title.name, title.role], ['cube', 'hero', 'title', 'mustSee']);
      // 两个实体互不遮挡，都有角色：可见比例量出来都是 1
      assert.deepEqual([cube.visible, title.visible], [1, 1]);
      const titleBox = idBox(r.bytes.objectId, r.refs.objectId.shape, title.id);
      assert.ok(titleBox.count > 0 && edgesOff(meta.texts[0].bbox2d, titleBox.box) <= 2, `文字框 ${meta.texts[0].bbox2d} 对编号层上片名的外框 ${titleBox.box}`);
    });

    await t.test('p01：片名卡的卡核对记录（Handle 上有什么是探针镜头旁观到的，并进来叫什么是宿主自报的）过 CR 各条', async () => {
      const { meta } = p01.renders.find((x) => x.f === 12 && x.order === 'sequential'), list = (key) => getList(meta.readings, `probe.title.${key}`);
      const [row] = meta.ext['page.load'].cards, { card } = threeLib['overlay.title'];
      const check = {
        format: 'card-check/0.1', card: 'overlay.title@1', impl: card.impl[0].entry, shape: card.impl[0].shape, entries: await entriesOf(card.impl[0].entry), calledVia: row.calledVia,
        handle: { members: list('members'), prefix: 'title', entities: list('entities'), roots: list('roots'), merged: row.merged, metaKeys: list('metaKeys'), metaIds: list('metaIds'), mergedMetaIds: row.mergedMetaIds },
        evaluations: p01.evaluations,
      };
      assert.deepEqual(check.handle, { members: ['object', 'entities', 'apply', 'meta', 'dispose'], prefix: 'title', entities: ['plane'], roots: ['plane'], merged: ['title'], metaKeys: ['texts'], metaIds: ['line'], mergedMetaIds: ['title.line'] });
      assert.deepEqual([row.as, row.card, row.impl, row.members], ['title', 'overlay.title@1', check.impl, check.handle.members]);
      assert.deepEqual(judged(check), CLEAN);
    });

    await t.test('p02、p03：相机取自数据轨道，逐帧就是样条卡在 node 里求出来的；加了恒等后期链的颜色层和没加的逐位相同', async () => {
      const { evaluate } = await import('./camera/spline/evaluate.mjs'), params = resolveParams(threeLib['camera.spline'].card, { keys: SPLINE_KEYS });
      const a = await probe.open(source, 'p02', 'main'), b = await probe.open(source, 'p03', 'main');
      assert.deepEqual([p02.manifest.entities, p03.manifest.entities], [[{ id: 1, name: 'title', class: 'part' }], [{ id: 1, name: 'title', class: 'part' }]]);
      for (const f of [0, 3, 6, 12, 18, 23]) {
        const ra = await probe.render(a, f, {}, WANT, { order: 'sequential' }), rb = await probe.render(b, f, {}, WANT, { order: 'sequential' });
        assert.deepEqual([judged(ra.meta), judged(rb.meta)], [CLEAN, CLEAN], `第 ${f} 帧`);
        // 相机：位置、朝向、视场角
        const want = evaluate({}, params, f, 0).camera, world = new THREE.Matrix4().compose(new THREE.Vector3(...want.pos), new THREE.Quaternion(...want.quat), new THREE.Vector3(1, 1, 1)).elements;
        assert.ok(ra.meta.camera.world.every((v, i) => Math.abs(v - world[i]) < 1e-9), `第 ${f} 帧相机到世界的矩阵`);
        assert.ok(Math.abs(ra.meta.camera.fovYDeg - want.fovDeg) < 1e-9 && Math.abs(ra.meta.camera.proj[5] - 1 / Math.tan((want.fovDeg * Math.PI) / 360)) < 1e-6);
        assert.deepEqual(rb.meta.camera.world, ra.meta.camera.world);
        // 恒等链：颜色层逐位相同
        assert.equal(colorHash(ra), colorHash(rb), `第 ${f} 帧`);
        const ink = inkBox(ra.bytes.color, ra.refs.color.shape);
        if (f < 3) { assert.equal(ink.count, 0); continue; }
        // 过了后期链读回来的不是一张空图；片名挂在相机下面，相机怎么走它都在画面正中，文字框对得上墨迹
        assert.ok(ink.count > 1000 && edgesOff(ra.meta.texts[0].bbox2d, ink.box) <= 2, `第 ${f} 帧文字框 ${ra.meta.texts[0]?.bbox2d} 对墨迹外框 ${ink.box}`);
        assert.deepEqual([ra.meta.texts[0].id, ra.meta.texts[0].text, ra.meta.entities[0].visible], ['title.line', 'CAM 02', 1]);
        // 三角形数只数场景那一遍，不算后期链的全屏通道
        assert.equal(ra.meta.stats.tris, rb.meta.stats.tris);
      }
      // 相机确实在走：首尾两帧的位置不一样
      assert.notDeepEqual(p02.renders[0].meta.camera.world.slice(12, 15), p02.renders.at(-1).meta.camera.world.slice(12, 15));
      // 带快门的一帧：子帧上相机和片名都按 f + sub 求值，过不过后期链结果一样
      const blur = { shutter: { angleDeg: 180, samples: 4 } };
      assert.equal(colorHash(await probe.render(a, 4, blur, ['color', 'meta'])), colorHash(await probe.render(b, 4, blur, ['color', 'meta'])));
      assert.notEqual(colorHash(p02.renders.at(-1)), colorHash(await probe.render(a, 4, {}, ['color'])));
      await a.session.close();
      await b.session.close();
    });

    await t.test('p02、p03：装载核对记录（相机取自 tracks，create 的次序是书写顺序）和样条卡、后期链卡的卡核对记录过 CR 各条', async () => {
      const accounts = [p02, p03].map((o) => o.renders.at(-1).meta.ext['page.load']);
      const checks = [p02, p03].map((o, i) => loadCheck(o.input, accounts[i]));
      const want = (id, cards, appliers) => ({
        format: 'load-check/0.1', shot: id, build: 'ok', steps: ['assets', 'tracks', 'create', 'collect'], cards, orderPairs: [], createOrder: cards,
        applyOrder: ['tracks', ...appliers], metaOrder: ['host', 'title'], camera: { tracksHasCamera: true, from: 'tracks' },
      });
      assert.deepEqual(checks, [want('p02', ['cam', 'title', 'hdr'], ['title']), want('p03', ['cam', 'title'], ['title'])]);
      for (const c of checks) assert.deepEqual(judged(c), CLEAN, c.shot);

      const rows = Object.fromEntries(accounts[0].cards.map((r) => [r.as, r]));
      const spline = threeLib['camera.spline'].card.impl[0], hdr = threeLib['post.hdr-chain'].card.impl[0];
      const cardChecks = [
        // 样条卡：谁调的是宿主自报的；三种求法的摘要是这里在 node 里对同一份实现量的
        { format: 'card-check/0.1', card: 'camera.spline@1', impl: spline.entry, shape: spline.shape, entries: await entriesOf(spline.entry), calledVia: rows.cam.calledVia, evaluations: await dataEvaluations('camera.spline') },
        // 后期链卡：这个镜头没有入口文件，放不了探针，Handle 的成员取的是宿主自报的
        { format: 'card-check/0.1', card: 'post.hdr-chain@1', impl: hdr.entry, shape: hdr.shape, entries: await entriesOf(hdr.entry), calledVia: rows.hdr.calledVia, handle: { members: rows.hdr.members } },
      ];
      assert.deepEqual([rows.cam.calledVia, rows.cam.impl, rows.hdr.calledVia, rows.hdr.members, rows.title.merged], ['tracks', spline.entry, 'cards.use', ['object', 'dispose'], ['title']]);
      for (const c of cardChecks) assert.deepEqual(judged(c), CLEAN, c.card);
    });

    await t.test('探针片子：镜头、帧源、元数据、时间各份核对记录过校验；渲染路径（求值核、帧源、宿主、卡）里没有墙钟和不带种子的随机', () => {
      const { out, path } = probe.records(source);
      assert.equal(Object.keys(out).length, 2 + 3 * 3);
      for (const [name, rec] of Object.entries(out)) assert.deepEqual(judged(rec), CLEAN, name);
      const shot = out['p01.shot-check'];
      assert.deepEqual([shot.mode, shot.entry, shot.buildCalls, shot.build, shot.entities, shot.declaredCards, shot.cardUses, shot.metaKeys], ['native-code', 'cards-probe.shot.js', 1, 'ok', ['cube', 'title'], ['title'], [{ as: 'title', runtimeKeys: [] }, { as: 'title', runtimeKeys: [] }], ['readings']]);
      assert.deepEqual(shot.ctx[0].seen, shot.ctx[0].want);
      assert.deepEqual([out['p02.shot-check'].mode, out['p02.shot-check'].declaredCards, 'buildCalls' in out['p02.shot-check']], ['cards-data', ['cam', 'title', 'hdr'], false]);
      // 时间：p01 的每次出了颜色层的调用都有一项逐帧采样观测；事件 hit 交给镜头代码的是局部第 4 帧
      const time = out['time-check'];
      assert.equal(time.frames.length, p01.renders.filter((r) => r.layers.includes('color')).length);
      assert.deepEqual(time.localized.find((x) => x.shot === 'p01'), { shot: 'p01', frame: 4, f: 4 });
      assert.equal(time.rng.length, 5);
      assert.deepEqual([path.wallClock, path.unseededRandom, path.allowed.length], [[], [], 1]);
      assert.ok(path.files.includes('beiming/cards/two-d/overlay-title/three.js') && path.files.includes('beiming/host/page/cards-probe.shot.js'));
    });

    await t.test('真字体实渲：RTX 5090、小写 Hello World（含大字号裁切）与中文「北冥」、fade/settle 动效、透明区零误标与 page.det2d 双卡兼容', async () => {
      const aaCount = (bytes) => {
        const px = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
        let aa = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0.02 && px[i] < 0.95) aa++;
        return aa;
      };
      // s02 的 RTX 5090 实渲帧具备真字体平滑抗锯齿边缘像素
      const s02Settled = s02.renders.find((r) => r.f === 60);
      assert.ok(aaCount(s02Settled.bytes.color) > 1000, 'RTX 5090 应有真字体抗锯齿边缘');

      for (const [idx, [text, heightFrac]] of [['Hello World', 0.2], ['Hello World', 0.35], ['北冥', 0.2]].entries()) {
        const customFilm = {
          ...PROBE_FILM,
          id: `t4-true-font-${idx}`,
          output: { ...PROBE_FILM.output, size: [640, 360], frames: 24 },
          shots: [probeShot('t01', 0, {
            mode: 'cards-data',
            cards: [{ as: 'title', use: 'overlay.title@1', params: { text, enter: 2, settleFrames: 6, heightFrac } }],
            roles: { hero: 'title' },
          })],
          events: [],
        };
        const customLock = localLock(customFilm, { t01: 8801 + idx }, threeLib);
        const inp = shotInput(customFilm, 't01', eventsTable(customFilm));
        const s1 = await source.open(inp, { lock: customLock, tier: 'final', workspace: root, filmDir: PROBE_DIR });
        const s2 = await source.open(inp, { lock: customLock, tier: 'final', workspace: root, filmDir: PROBE_DIR });
        try {
          const rPre = await s1.render(1, {}, ['color', 'meta']);
          const preBytes = await readFile(join(root, rPre.layers.color.file));
          assert.deepEqual([rPre.meta.texts, inkBox(preBytes, rPre.layers.color.shape).count], [[], 0]);

          const rMid = await s1.render(4, {}, ['color', 'meta']);
          const midBytes = await readFile(join(root, rMid.layers.color.file));
          const midInk = inkBox(midBytes, rMid.layers.color.shape);
          assert.ok(midInk.count > 500);
          assert.deepEqual(rMid.meta.texts[0].bbox2d.map(Math.round), midInk.box);

          const r1 = await s1.render(12, {}, ['color', 'objectId', 'meta']);
          const r1Next = await s1.render(15, {}, ['color', 'meta']);
          const r2 = await s2.render(12, {}, ['color', 'meta']);
          assert.equal(r1.layers.color.hash, r2.layers.color.hash, `${text} 同机两遍会话渲染哈希一致`);
          assert.equal(r1.layers.color.hash, r1Next.layers.color.hash, `${text} 落定后静止帧哈希一致`);
          assert.notEqual(rMid.layers.color.hash, r1.layers.color.hash, `${text} 入场中与落定后不同`);
          assert.equal(r1.meta.texts[0].text, text);
          const bytes = await readFile(join(root, r1.layers.color.file));
          const idBytes = await readFile(join(root, r1.layers.objectId.file));
          const ink = inkBox(bytes, r1.layers.color.shape);
          const titleId = r1.meta.entities.find((e) => e.name === 'title').id;
          assert.ok(ink.count > 1000 && aaCount(bytes) > 150, `${text} 墨迹像素与抗锯齿边缘充足`);
          assert.deepEqual(r1.meta.texts[0].bbox2d.map(Math.round), ink.box, `${text} (${heightFrac}) 文字框精确匹配墨迹外框`);
          assert.deepEqual(idBox(idBytes, r1.layers.objectId.shape, titleId), ink, `${text} (${heightFrac}) 透明像素零误标 objectId`);
          assert.ok(rMid.meta.texts[0].bbox2d[1] > r1.meta.texts[0].bbox2d[1], `${text} 入场从下往上升到位`);
        } finally {
          await s1.close();
          await s2.close();
        }
      }

      // motion: fade 与 settle 在 film.json 中可正常声明并实渲
      for (const [mIdx, motion] of ['fade', 'settle'].entries()) {
        const motionFilm = {
          ...PROBE_FILM,
          id: `t4-motion-${motion}`,
          output: { ...PROBE_FILM.output, size: [640, 360], frames: 24 },
          shots: [probeShot('tm', 0, {
            mode: 'cards-data',
            cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX 5090', enter: 2, settleFrames: 6, motion } }],
            roles: { hero: 'title' },
          })],
          events: [],
        };
        const sMotion = await source.open(shotInput(motionFilm, 'tm', eventsTable(motionFilm)), {
          lock: localLock(motionFilm, { tm: 8850 + mIdx }, threeLib), tier: 'final', workspace: root, filmDir: PROBE_DIR,
        });
        try {
          const r = await sMotion.render(8, {}, ['color', 'objectId', 'meta']);
          const bytes = await readFile(join(root, r.layers.color.file));
          const idBytes = await readFile(join(root, r.layers.objectId.file));
          const ink = inkBox(bytes, r.layers.color.shape);
          const titleId = r.meta.entities.find((e) => e.name === 'title').id;
          assert.deepEqual(r.meta.texts[0].bbox2d.map(Math.round), ink.box);
          assert.deepEqual(idBox(idBytes, r.layers.objectId.shape, titleId), ink);
        } finally {
          await sMotion.close();
        }
      }

      // 小字号合法下限 heightFrac=0.02：文字框按像素中心命中与实测墨迹外框精确一致；透明底白色 ink="#ffffff" 半透明边缘严格满足线性预乘 R=G=B=A
      for (const [sIdx, sText] of ['Hello World', 'RTX 5090', '北冥'].entries()) {
        const smallFilm = {
          ...PROBE_FILM,
          id: `t4-small-${sIdx}`,
          output: { ...PROBE_FILM.output, size: [640, 360], frames: 24 },
          shots: [probeShot('ts', 0, {
            mode: 'cards-data',
            cards: [{ as: 'title', use: 'overlay.title@1', params: { text: sText, enter: 2, settleFrames: 6, heightFrac: 0.02 } }],
            roles: { hero: 'title' },
          })],
          events: [],
        };
        const sSmall = await source.open(shotInput(smallFilm, 'ts', eventsTable(smallFilm)), {
          lock: localLock(smallFilm, { ts: 8860 + sIdx }, threeLib), tier: 'final', workspace: root, filmDir: PROBE_DIR,
        });
        try {
          const r = await sSmall.render(8, {}, ['color', 'objectId', 'meta']);
          const bytes = await readFile(join(root, r.layers.color.file));
          const idBytes = await readFile(join(root, r.layers.objectId.file));
          const ink = inkBox(bytes, r.layers.color.shape);
          const titleId = r.meta.entities.find((e) => e.name === 'title').id;
          assert.ok(ink.count > 0);
          assert.deepEqual(r.meta.texts[0].bbox2d.map(Math.round), ink.box, `小字号 ${sText} 文字框匹配实测墨迹外框`);
          assert.deepEqual(idBox(idBytes, r.layers.objectId.shape, titleId), ink);
        } finally {
          await sSmall.close();
        }
      }

      const whiteFilm = {
        ...PROBE_FILM,
        id: 't4-white-premul',
        output: { ...PROBE_FILM.output, size: [640, 360], frames: 24 },
        shots: [probeShot('tw', 0, {
          mode: 'cards-data',
          cards: [{ as: 'title', use: 'overlay.title@1', params: { text: 'RTX 5090', enter: 2, settleFrames: 6, ink: '#ffffff' } }],
          roles: { hero: 'title' },
        })],
        events: [],
      };
      const sWhite = await source.open(shotInput(whiteFilm, 'tw', eventsTable(whiteFilm)), {
        lock: localLock(whiteFilm, { tw: 8870 }, threeLib), tier: 'final', workspace: root, filmDir: PROBE_DIR,
      });
      try {
        let sampled = 0, wrong = 0;
        for (const f of [4, 8]) {
          const r = await sWhite.render(f, {}, ['color']);
          const rgba = await readFile(join(root, r.layers.color.file));
          for (let i = 0; i < 640 * 360; i++) {
            const a = rgba.readFloatLE(16 * i + 12);
            if (a <= 0.04 || a >= 0.95) continue;
            sampled++;
            if (
              Math.abs(rgba.readFloatLE(16 * i) - a) > 0.01
              || Math.abs(rgba.readFloatLE(16 * i + 4) - a) > 0.01
              || Math.abs(rgba.readFloatLE(16 * i + 8) - a) > 0.01
            ) wrong++;
          }
        }
        assert.ok(sampled > 1000, `半透明抗锯齿样本数 ${sampled}`);
        assert.equal(wrong, 0, '透明底白色 ink 半透明边缘不应变暗');
      } finally {
        await sWhite.close();
      }

      // 与 page.det2d@1 同镜头并存：临时装卸 FontFace 不污染 document.fonts
      const dualDirs = ['cards/two-d/overlay-title', 'cards/mechanism/page-det2d'];
      const dualLib = await loadCards(dualDirs);
      const dualSource = await startSource({ cards: dualDirs });
      try {
        const dualFilm = {
          ...PROBE_FILM,
          id: 't4-dual-det2d',
          output: { ...PROBE_FILM.output, size: [640, 360], frames: 24 },
          shots: [probeShot('td', 0, {
            mode: 'cards-data',
            cards: [
              { as: 'page', use: 'page.det2d@1', params: {} },
              { as: 'title', use: 'overlay.title@1', params: { text: 'RTX 5090', enter: 2, settleFrames: 6 } },
            ],
            roles: { hero: 'title' },
          })],
          events: [],
        };
        const sDual = await dualSource.open(shotInput(dualFilm, 'td', eventsTable(dualFilm)), {
          lock: localLock(dualFilm, { td: 8880 }, dualLib), tier: 'final', workspace: root, filmDir: PROBE_DIR,
        });
        try {
          const r = await sDual.render(8, {}, ['color', 'objectId', 'meta']);
          assert.equal(r.meta.texts.find((x) => x.id === 'title.line')?.text, 'RTX 5090');
        } finally {
          await sDual.close();
        }
      } finally {
        await dualSource.stop();
      }

      // 超出锁定字库覆盖的字符在页面宿主装载时明确报错，不回退系统字体
      const badFilm = {
        ...PROBE_FILM,
        id: 't4-bad-glyph',
        output: { ...PROBE_FILM.output, frames: 24 },
        shots: [probeShot('tbad', 0, {
          mode: 'cards-data',
          cards: [{ as: 'title', use: 'overlay.title@1', params: { text: '北冥𪚥' } }],
          roles: { hero: 'title' },
        })],
        events: [],
      };
      await assert.rejects(
        source.open(shotInput(badFilm, 'tbad', eventsTable(badFilm)), {
          lock: localLock(badFilm, { tbad: 8899 }, threeLib), tier: 'final', workspace: root, filmDir: PROBE_DIR,
        }),
        /字形表/,
      );
    });
  } finally {
    await source.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('实渲：没提供卡的帧源照旧不声明「卡加数据」，片名镜头报 contract.unsupported-mode', async (t) => {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'beiming-m1a-cards-'));
  try {
    const film = readJson(join(FILM_MIN_DIR, 'film.json'));
    assert.deepEqual(source.caps().modes, ['native-code']);
    await assert.rejects(source.open(shotInput(film, 's02', eventsTable(film)), { lock: localLock(film, { s02: 7803 }), tier: 'final', workspace: root, filmDir: FILM_MIN_DIR }), coded('contract.unsupported-mode'));
  } finally {
    await source.stop();
    await rm(root, { recursive: true, force: true });
  }
});
