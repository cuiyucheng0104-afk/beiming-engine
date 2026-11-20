import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { caps } from '../../sources/three/caps.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { eventsTable, renderingOf } from '../eval/input.mjs';
import { boundsOf, boxOfIds, centroid, diffLayers, dist, expectedLayers, iou, linearError, predictAccumulation } from './compare.mjs';
import { observed, readObservation, RNG_RUNS } from './fixtures/observe.js';
import { effectiveShutter, linearErrBlocked, metaCheck, shotCheck, sourceCheck, timeCheck } from './records.mjs';
import { importSpecifiers, scanFiles, scanText, shotFiles, sourceFiles, withImports } from './scan.mjs';

const REPO = new URL('../../../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, REPO), 'utf8'));
const FIXTURES = 'beiming/kernel/conformance/fixtures';
const film = readJson(`${FIXTURES}/film.json`);
const scene = readJson('beiming/calib/probe-moving-cube/scene.json');
const IDS = { cube: 7, highlight: 9 }; // 故意不用规格里的 idIndex：编号要经名字查
const { validate } = await loadContracts();
const violations = (obj) => { const v = validate(obj); assert.deepEqual(v.schemaErrors, []); return Object.keys(v.violations); };

test('最小片子描述和例子锁过校验：三个镜头首尾相接，后两个不从第 0 帧起，有一个带 renderer 对象；旁边的规格文件和校准场景一致；展开的事件表对得上片子描述', () => {
  assert.deepEqual(violations(film), []);
  const lock = readJson(`${FIXTURES}/lock.json`);
  assert.deepEqual(violations(lock), []);
  let at = 0;
  for (const shot of film.shots) {
    const use = renderingOf(shot), name = use.entry.replace('.shot.js', ''), calib = readJson(`beiming/calib/probe-${name}/scene.json`);
    // 规格是两份：镜头代码只能引用自己目录里的文件，答案在校准目录里。这里盯着两份一致
    assert.deepEqual(readJson(`${FIXTURES}/${name}.scene.json`), { camera: calib.camera, backgroundLinear: calib.backgroundLinear, objects: calib.objects });
    assert.deepEqual([shot.in, shot.out, use.source, use.host, shot.shutter.angleDeg], [at, at + calib.frameRange.endFrame + 1, 'three', 'page', calib.camera.shutterAngleDeg]);
    assert.deepEqual([film.output.size, film.output.fps], [[calib.camera.widthPx, calib.camera.heightPx], `${calib.frameRateFps}/1`]);
    assert.deepEqual([lock.seeds[shot.id], lock.shots[shot.id].shutterSamples], [shot.seed, shot.shutter.samples ?? caps().motionBlur.samples]);
    at = shot.out;
  }
  assert.equal(film.output.frames, at);
  assert.equal(new Set(film.shots.map((x) => x.seed)).size, film.shots.length);
  assert.equal(lock.film, film.id);
  // 至少一个镜头顶层写的帧源和出帧的不是同一个：元数据的 source.id 和 source.renderer 才分得开
  assert.ok(film.shots.some((x) => x.renderer && x.renderer.source !== x.source));
  // 至少一个镜头的实体名按字节序和按字典序排出来不一样：编号照字节序排才对得上
  const mixed = film.shots.map((x) => [...readJson(`${FIXTURES}/${renderingOf(x).entry.replace('.shot.js', '')}.scene.json`).objects.map((o) => o.id), ...(x.params?.offscreen ?? [])]);
  assert.ok(mixed.some((names) => JSON.stringify([...names].sort()) !== JSON.stringify([...names].sort((a, b) => a.localeCompare(b)))));
  // 每个镜头里有一个事件，都落在会渲的帧上；非首镜头的事件帧号和局部帧号不同
  const table = eventsTable(film);
  assert.deepEqual(violations({ format: 'events-check/0.1', events: table, film }), []);
  assert.deepEqual(table.events.filter((e) => e.kind === 'named').map((e) => e.shot), film.shots.map((x) => x.id));
});

test('静态扫描认得出墙钟和不带种子的随机，白名单只放行点名的那一处', () => {
  // 被找的调用名拆开写：这个目录也会被同样的规则搜
  const clock = ['Date', 'now'].join('.'), perf = ['performance', 'now'].join('.'), random = ['Math', 'random'].join('.');
  const hits = scanText(`const a = ${clock}(); const b = new ${'Date'}(); const c = ${perf}() + ${random}() + ${random}();\nconst ok = new ${'Date'}(0);`);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['unseededRandom', 'unseededRandom', 'wallClock', 'wallClock', 'wallClock']);
  assert.deepEqual(scanText('const now = performanceNow; const r = rng.next();'), []);
  // 清单里别的写法：括号省掉的 new、不带 new 当函数调、时间原点、方括号取成员、另两种不带种子的随机；带参数的 new、别的对象上的同名方法不算
  const D = 'Date', M = 'Math', P = 'performance', C = 'crypto';
  const calls = (text) => scanText(text).map((h) => `${h.kind}:${h.call}`);
  assert.deepEqual(calls(`a = new ${D}; b = ${D}(); c = ${P}.timeOrigin; d = ${D}['now'](); e = ${M}["random"]();`), [`wallClock:${D}.now`, `wallClock:${P}.timeOrigin`, `wallClock:new ${D}`, `wallClock:${D}()`, `unseededRandom:${M}.random`]);
  assert.deepEqual(calls(`${C}.getRandomValues(buf); ${C}.randomUUID(); ${C}?.[\`randomUUID\`]()`), [`unseededRandom:${C}.getRandomValues`, `unseededRandom:${C}.randomUUID`, `unseededRandom:${C}.randomUUID`]);
  assert.deepEqual(calls(`new ${D}(0); new ${D}(t).getTime(); clock.${D}(); my${D}(); ${C}.subtle.digest('SHA-256', b); ${M}['random"]`), []);

  const root = fileURLToPath(REPO);
  const files = sourceFiles(root, ['beiming/host/page']);
  assert.ok(files.includes('beiming/host/page/clock.js') && !files.some((f) => f.includes('.test.')));
  const strict = scanFiles(root, files), lenient = scanFiles(root, files, [{ path: 'beiming/host/page/clock.js', call: perf }]);
  assert.deepEqual(strict.wallClock, [{ path: 'beiming/host/page/clock.js', call: perf }]);
  assert.deepEqual([lenient.wallClock, lenient.allowed], [[], strict.wallClock]);
  assert.deepEqual(withImports(root, 'beiming/kernel/conformance/compare.mjs'), ['beiming/kernel/conformance/compare.mjs', 'beiming/calib/check.mjs']);
  // 两层：run.mjs 不直接引 calib/check.mjs，经 compare.mjs 才到；每个文件只出现一次
  const deep = withImports(root, 'beiming/kernel/conformance/run.mjs');
  assert.ok(deep.includes('beiming/kernel/conformance/compare.mjs') && deep.includes('beiming/calib/check.mjs'));
  assert.equal(new Set(deep).size, deep.length);
  // 注释里、字符串里写的引用语句不算，字符串里的 // 不是注释；五种写死字符串的写法都算
  assert.deepEqual(importSpecifiers("// from './a.js'\n/* require('./b.js') */ const u = 'x://y'; import('./c.js');"), ['./c.js']);
  assert.deepEqual(importSpecifiers(`const h = "old: import './n.js'"; const t = \`from './m.js'\`; const q = 'require("./p.js")';`), []);
  assert.deepEqual(importSpecifiers(`import a from './a.js'; export { b } from "../b.js"; import './c.js'; import ( './d.js' ); require ('./e.js'); import(name); f('./g.js');`), ['./a.js', '../b.js', './c.js', './d.js', './e.js']);

  // 每个镜头各扫各的：两个入口在同一个目录，只有一个引了带随机的文件，另一个镜头的扫描是空的
  const dir = mkdtempSync(join(tmpdir(), 'conformance-scan-'));
  try {
    mkdirSync(join(dir, 'shots'));
    writeFileSync(join(dir, 'shots/noisy.shot.js'), "import { n } from './noise.js';\nexport default n;\n");
    writeFileSync(join(dir, 'shots/clean.shot.js'), "const hint = \"old version did: import './noise.js'\";\nexport default hint;\n");
    writeFileSync(join(dir, 'shots/noise.js'), `export const n = () => ${random}();\n`);
    const noisy = shotFiles(dir, 'shots/noisy.shot.js'), clean = shotFiles(dir, 'shots/clean.shot.js');
    assert.deepEqual(noisy.scan.unseededRandom, [{ path: 'shots/noise.js', call: random }]);
    assert.deepEqual([clean.files, clean.scan.unseededRandom, clean.scan.wallClock], [['shots/clean.shot.js'], [], []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重心：按像素中心算，可以加权', () => {
  assert.deepEqual(centroid(4, 2, (i) => i === 1 || i === 2), { px: [2, 0.5], count: 2 });
  assert.deepEqual(centroid(4, 1, (i) => [0, 1, 3, 0][i]), { px: [2.25, 0.5], count: 2 });
  assert.equal(centroid(4, 2, () => 0).px, null);
  assert.equal(dist([0, 0], [3, 4]), 5);
  assert.equal(dist(null, [3, 4]), null);
  assert.deepEqual(boundsOf(10, 10, (i) => i === 23 || i === 45, 1), { x0: 2, y0: 1, x1: 6, y1: 5 });
  assert.equal(boundsOf(10, 10, () => false), null);
});

test('照规格求交：编号按名字查；对求交结果的比较数得出错的像素、上限和深度差', () => {
  const w = scene.camera.widthPx, want = expectedLayers(scene, 24, IDS);
  const hit = scene.expected.find((e) => e.kind === 'pixelHits');
  const i = Math.floor(hit.pixelPx[1]) * w + Math.floor(hit.pixelPx[0]);
  assert.equal(want.id[i], IDS[hit.hits[0].objectId]);
  assert.ok(Math.abs(want.depth[i] - hit.hits[0].planeDepthM) < 1e-5);
  assert.equal(want.id[0], 0);

  const same = diffLayers(want, scene, 24, IDS);
  assert.deepEqual([same.idMismatch, same.offEdge, same.depthMaxDiff], [0, 0, 0]);
  // 方块里面改错一个像素（不在任何边上）、另一个像素的深度加半米
  const off = { id: Uint32Array.from(want.id), depth: Float32Array.from(want.depth) };
  const inside = 180 * w + 310;
  assert.equal(want.id[inside], IDS.cube);
  off.id[inside] = 0; off.depth[inside + 1] += 0.5;
  const d = diffLayers(off, scene, 24, IDS);
  assert.deepEqual([d.idMismatch, d.offEdge, d.depthMaxDiff, d.edgeLimit], [1, 1, 0.5, same.edgeLimit]);
  assert.ok(Math.abs(d.depthMaxRatio - 0.5 / want.depth[inside + 1]) < 1e-12);
});

test('从编号层反算包围盒，和另一个矩形比交并比', () => {
  // 4 × 3 的编号层：编号 5 占第 1、2 列的第 0、1 行，编号 6 占 (3, 2)
  const layer = Uint32Array.from([0, 5, 5, 0, 0, 5, 5, 0, 0, 0, 0, 6]);
  assert.deepEqual(boxOfIds(4, 3, layer, [5]), [1, 0, 3, 2]);
  assert.deepEqual(boxOfIds(4, 3, layer, [5, 6]), [1, 0, 4, 3]);
  assert.equal(boxOfIds(4, 3, layer, [9]), null);
  assert.equal(iou([1, 0, 3, 2], [1, 0, 3, 2]), 1);
  // 绕中心放大一倍：面积四倍，交并比四分之一
  assert.equal(iou([1, 0, 3, 2], [0, -1, 4, 3]), 0.25);
  assert.equal(iou([0, 0, 1, 1], [2, 2, 3, 3]), 0);
  assert.equal(iou(null, [0, 0, 1, 1]), null);
  assert.equal(iou([0, 0, 0, 0], [1, 1, 1, 1]), null);
});

test('累积颜色层对预言图：线性平均差不出来，编码值上平均差得出来；边缘带里的像素不算，没有运动时不给数', () => {
  const w = scene.camera.widthPx, n = 2, bg = [0, 0, 0, 1];
  const p = predictAccumulation(scene, 24, 180, n);
  assert.equal(p.hits.length, n);
  // 两个时刻照「(i + 0.5) ÷ 个数 × (快门角 ÷ 360)」算：0.125 和 0.375
  assert.deepEqual([...p.hits[0]], [...expectedLayers(scene, 24.125, { cube: 1, highlight: 2 }).id]);
  assert.deepEqual([...p.hits[1]], [...expectedLayers(scene, 24.375, { cube: 1, highlight: 2 }).id]);
  const value = (hit, c) => (hit === 0 ? bg[c] : c === 3 ? 1 : scene.objects[hit - 1].emissionLinear[c]);
  const mix = (fn) => Float32Array.from({ length: w * scene.camera.heightPx * 4 }, (_, j) => fn(value(p.hits[0][j >> 2], j & 3), value(p.hits[1][j >> 2], j & 3), j & 3));
  const linear = linearError(mix((a, b) => (a + b) / 2), scene, p, bg);
  assert.ok(linear.linearErr < 1e-5 && linear.moving > 0 && linear.edgePixels > 0, JSON.stringify(linear));
  const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055), dec = (y) => (y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4);
  assert.ok(linearError(mix((a, b, c) => (c === 3 ? 1 : dec((enc(a) + enc(b)) / 2))), scene, p, bg).linearErr > 1e-2);
  // 边缘带里的一个像素写错：进记录的数不变，连边缘带一起比的读数变大；边缘带外的一个像素写错：进记录的数跟着变
  const onEdge = p.edge.indexOf(1), inside = 180 * w + 320;
  assert.equal(p.edge[inside], 0);
  const edged = mix((a, b) => (a + b) / 2); edged[onEdge * 4] += 3;
  const e = linearError(edged, scene, p, bg);
  assert.ok(e.linearErr < 1e-5 && e.wholeFrame > 2.9);
  const off = mix((a, b) => (a + b) / 2); off[inside * 4 + 1] += 0.5;
  assert.ok(Math.abs(linearError(off, scene, p, bg).linearErr - 0.5) < 1e-6);
  // 快门角 0：两个时刻是同一刻，两种平均分不出来
  const still = predictAccumulation(scene, 24, 0, n);
  assert.equal(linearError(mix((a) => a), scene, still, bg).linearErr, null);
});

test('观测点：记下 build 跑了几次、state 收到的每个时刻和那一刻被画的是哪一种、meta(f) 收到的帧号和交回的键、卡的每次调用、随机流的名字原文和数、ctx.events 里的每一项', async () => {
  const mat = {}, mesh = { isMesh: true, material: mat };
  const scene = { traverse: (fn) => fn(mesh), onBeforeRender: null };
  const streams = {};
  const ctx = {
    seed: 7, fps: '24000/1001', frames: 5, size: [640, 360], shot: { id: 's02', in: 10, frames: 5 }, cards: { use: () => ({}) }, events: { mark1: -6, lock: 3 },
    rng: (arg) => { let n = 0; streams[arg] = (streams[arg] ?? 0) + 1; return { name: arg === 'probe/extra' ? 'wrong' : `7/s02/${arg}`, u32: () => arg.length * 100 + n++ }; },
  };
  const got = [];
  // 宿主把一项做成不可枚举的：转交给镜头代码时不能丢
  Object.defineProperty(ctx, 'hidden', { value: 42, enumerable: false });
  let handed;
  const metaGot = [];
  const build = observed((c) => { handed = [c.hidden, c.seed, c.size]; c.cards.use('x'); c.cards.use('title', { text: 1, onReady: 2 }); return { scene, state: (f, sub) => got.push([f, sub]), meta: (f) => { metaGot.push(f); return { texts: [], camera: {}, readings: { own: 3 } }; } }; });
  const shot = await build(ctx);
  shot.state(3, 0.125); scene.onBeforeRender();
  shot.state(3, 0.375); scene.onBeforeRender();
  shot.state(3, 0); mesh.material = {}; scene.onBeforeRender(); scene.onBeforeRender(); mesh.material = mat;
  const meta = shot.meta(3);
  assert.equal(meta.readings.own, 3);
  for (const v of Object.values(meta.readings)) assert.equal(typeof v, 'number');
  const seen = readObservation(meta.readings);
  assert.deepEqual([seen.builds, seen.shot, seen.metaF, seen.metaKeys], [1, 's02', 3, ['texts', 'readings', 'unknown']]);
  // 卡的每次调用：传进来的实例名和 runtime 的键，没传 runtime 就是没有键；meta 收到的帧号原样转给镜头代码
  assert.deepEqual(seen.cardUses, [{ as: 'x', runtimeKeys: [] }, { as: 'title', runtimeKeys: ['text', 'onReady'] }]);
  assert.deepEqual(metaGot, [3]);
  assert.deepEqual(seen.states, [{ f: 3, sub: 0.125, color: 1, aux: 0 }, { f: 3, sub: 0.375, color: 1, aux: 0 }, { f: 3, sub: 0, color: 0, aux: 2 }]);
  assert.deepEqual(got, [[3, 0.125], [3, 0.375], [3, 0]]);
  // 流名是镜头代码拿到的原文，错的也照实交出来
  assert.deepEqual(seen.rng.map((x) => [x.run, x.arg, x.name]), [['a', 'probe/alpha', '7/s02/probe/alpha'], ['a', 'probe/beta', '7/s02/probe/beta'], ['b', 'probe/beta', '7/s02/probe/beta'], ['b', 'probe/extra', 'wrong'], ['b', 'probe/alpha', '7/s02/probe/alpha']]);
  assert.deepEqual(seen.events, [{ id: 'mark1', f: -6 }, { id: 'lock', f: 3 }]);
  // ctx 里的五个值原样读出来；镜头代码拿到的是宿主给的那些项
  assert.deepEqual(seen.ctx, { seed: 7, fps: '24000/1001', frames: 5, shotIn: 10, size: [640, 360] });
  assert.deepEqual(handed, [42, 7, [640, 360]]);
  assert.deepEqual(seen.rng[0].values.slice(0, 3), [1100, 1101, 1102]);
  assert.equal(Object.keys(RNG_RUNS).length, 2);
  // 交出去就清：下一次 meta(f) 只有新的时刻
  shot.state(4, 0);
  assert.deepEqual(readObservation(shot.meta(4).readings).states, [{ f: 4, sub: 0, color: 0, aux: 0 }]);
  await build(ctx);
  assert.equal(readObservation(shot.meta(4).readings).builds, 2);
  // ctx 里没有的、类型不对的那一项不写
  const { seed: _s, fps: _f, shot: _h, ...partial } = ctx;
  const bare = await observed(() => ({ scene, state() {}, meta: () => ({}) }))({ ...partial, size: '640x360' });
  const none = readObservation(bare.meta().readings);
  assert.deepEqual([none.ctx, 'shot' in none, 'metaF' in none], [{ frames: 5 }, false, false]);
  assert.equal(readObservation({ own: 3 }), null);
});

// 一次像样的观测：两个镜头，第二个从全片第 10 帧起、没写子帧采样数；各渲了局部第 3 帧（两个子帧采样加辅助层），第一个镜头外加一次只要元数据、一次报错、一次没有锁文件又没写种子的 open
function observation() {
  const sha = `sha256:${'ab'.repeat(32)}`, CAPS = { ...caps(), motionBlur: { mode: 'accumulate', auxAt: 'sub0', samples: 2 } };
  const one = (id, start, shutter) => {
    const meta = { film: 'f_x', shot: id, fps: '24/1', frame: start + 3, shotFrame: 3, seed: 7, size: [640, 360], colorRef: 'scene', camera: { shutterAngleDeg: 180 }, entities: [{ id: 1, name: 'cube', class: 'part' }], source: { id: 'three', renderer: 'three', tier: 'final' }, hash: { color: sha } };
    const seen = (states) => ({ builds: 1, shot: id, metaF: 3, cardUses: [], metaKeys: [], states, ctx: { seed: 7, fps: '24/1', frames: 10, shotIn: start, size: [640, 360] } });
    const ref = (output, n) => ({ output, shape: [360, 640, n], hash: sha, fileHash: sha, fileBytes: 360 * 640 * n * 4 });
    const full = (call, order) => ({
      call, f: 3, opts: {}, want: ['color', 'meta', 'depth'], locked: false, tier: 'final', status: 'ok', metas: 1, meta, metaBytes: 900, layers: ['color', 'depth'], layerRefs: [ref('color', 4), ref('depth', 1)], fileBytes: { color: 360 * 640 * 4 * 4, depth: 360 * 640 * 4 }, order, session: order,
      unsupportedOpts: [], unfitOutputs: [], linearErr: 2e-6, auxMismatch: 0,
      seen: seen([{ f: 3, sub: 0.125, color: 1, aux: 0 }, { f: 3, sub: 0.375, color: 1, aux: 0 }, { f: 3, sub: 0, color: 0, aux: 1 }]),
    });
    const opened = (more) => ({ plain: true, hasLock: false, hasSeed: true, usesCards: false, usesAssets: false, host: 'page', mode: 'native-code', unfitInput: [], status: 'ok', ...more });
    const shot = { id, in: start, out: start + 10, source: 'three', mode: 'native-code', entry: 'shot.js', seed: 7, colorRef: 'scene', shutter };
    return {
      shot,
      languages: ['js'],
      scan: { wallClock: [], unseededRandom: [] },
      // 两次装上了的 open：各有一次带观测的整帧 render
      loads: ['sequential', 'single'].map((session) => ({ session, locked: false, tier: 'final', input: { film: 'f_x', output: { size: [640, 360], fps: '24/1' }, shot } })),
      manifest: { frames: 10, entities: [{ id: 1, name: 'cube', class: 'part' }] },
      // 四次 open：没有锁文件又没写种子；带着锁、带着叠加层（帧源装不了）；原样的两次
      opens: [opened({ plain: false, hasSeed: false, status: 'error', code: 'env.lock-required' }), opened({ plain: false, hasLock: true, usesCards: true, unfitInput: ['overlays'], status: 'error', code: 'contract.unsupported-input' }), opened(), opened()],
      badArgs: [{ call: 'render', arg: 'f', status: 'error', code: 'usage.bad-argument' }],
      renders: [
        full(0, 'sequential'),
        { call: 1, f: 3, opts: {}, want: ['meta'], session: 'sequential', locked: false, tier: 'final', status: 'ok', metas: 1, meta: { ...meta, hash: { color: null } }, metaBytes: 800, layers: [], layerRefs: [], unsupportedOpts: [], unfitOutputs: [], seen: seen([{ f: 3, sub: 0, color: 0, aux: 0 }]) },
        { call: 2, f: 3, opts: {}, want: ['color', 'motion'], locked: false, tier: 'final', status: 'error', code: 'contract.unsupported-output', unsupportedOpts: [], unfitOutputs: [] },
        full(3, 'single'),
      ],
      evaluations: [{ f: 3, sub: 0, mode: 'single', digest: '0123abcd' }, { f: 3, sub: 0, mode: 'shuffled', digest: '0123abcd' }],
      rng: [{ run: 'a', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }, { run: 'b', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }],
      queries: [{ kind: 'bbox3d', status: 'error', code: 'contract.unsupported-query' }],
      localized: [{ frame: start + 4, f: 4 }, { frame: 2, f: 2 - start }],
      metaFrames: [{ frame: start + 3, f: 3 }],
    };
  };
  const shots = [one('s01', 0, { angleDeg: 180, samples: 2 }), one('s02', 10, { angleDeg: 180 })];
  return {
    film: { id: 'f_x', output: { fps: '24/1', size: [640, 360] }, shots: shots.map((x) => x.shot) }, caps: CAPS, lock: { seeds: { s01: 7, s02: 7 }, shots: { s01: { shutterSamples: 2 }, s02: { shutterSamples: 2 } } },
    holds: [{ f: 5, n: 2, result: 4 }], scans: { path: { wallClock: [], unseededRandom: [] } }, shots,
  };
}
const build = (obs) => [timeCheck(obs), ...obs.shots.flatMap((one) => [shotCheck(obs, one), sourceCheck(obs, one), metaCheck(obs, one)])];
const FINAL = { metaSeed: 7, metaSize: [640, 360], metaTier: 'final', metaSourceId: 'three', metaFilm: 'f_x', metaShot: 's01', metaFps: '24/1' };

test('像样的观测写出的核对记录一条不违反', () => {
  const obs = observation(), r = build(obs);
  assert.equal(r.length, 7);
  for (const rec of r) assert.deepEqual(violations(rec), []);
  // 第二个镜头：帧号换成了全片帧号，观测点看到交给镜头代码的还是局部帧号
  const time = r[0];
  assert.deepEqual(time.shots.map((x) => [x.id, x.start]), [['s01', 0], ['s02', 10]]);
  assert.deepEqual(time.frames[2], {
    frame: 13, shot: 's02', f: 3, shutterAngleDeg: 180, samples: [{ frame: 13, sub: 0.125, shot: 's02' }, { frame: 13, sub: 0.375, shot: 's02' }],
    accumulation: { linearErr: 2e-6 }, aux: { frame: 13, sub: 0 }, auxMismatch: 0,
  });
  // 只要元数据的那次不进逐帧采样；元数据核对记录里是工具重算的层文件哈希对元数据里的哈希
  assert.equal(time.frames.length, 4);
  assert.deepEqual([r[6].film, r[6].shot, r[6].fps, r[6].start, r[6].seed, r[6].source], ['f_x', 's02', '24/1', 10, 7, 'three']);
  assert.deepEqual(r[3].renders.slice(0, 2), [
    { call: 0, shotFrame: 3, tier: 'final', metas: 1, metaBytes: 900, metaFrame: 3, metaShotFrame: 3, ...FINAL, colorFileHash: r[3].renders[0].metaHashColor, colorShape: [360, 640, 4], metaHashColor: r[3].renders[0].metaHashColor },
    { call: 1, shotFrame: 3, tier: 'final', metas: 1, metaBytes: 800, metaFrame: 3, metaShotFrame: 3, ...FINAL },
  ]);
  // 交给镜头代码的 ctx：一次装载一项，want 照传的镜头输入算
  assert.deepEqual(r[1].ctx, [0, 1].map(() => ({ want: { seed: 7, fps: '24/1', frames: 10, shotIn: 0, size: [640, 360] }, seen: { seed: 7, fps: '24/1', frames: 10, shotIn: 0, size: [640, 360] } })));
  assert.deepEqual(r[4].ctx.map((x) => [x.want.shotIn, x.seen.shotIn]), [[10, 10], [10, 10]]);
  // 观测点数的三样：build 跑了几次、meta(f) 交回的键、卡的调用（一次都没调是空数组）
  assert.deepEqual([r[1].buildCalls, r[1].metaKeys, r[1].cardUses], [1, [], []]);
  assert.deepEqual(r[2].orderRuns.map((o) => o.mode), ['sequential', 'single']);
  assert.deepEqual([r[2].shot, r[2].opens.length, 'plain' in r[2].opens[0], r[2].renders[0].size, r[2].renders[0].layerRefs.length, r[2].scenePack], ['s01', 4, false, [640, 360], 2, false]);
  assert.deepEqual([r[2].opens[1].unfitInput, r[2].badArgs], [['overlays'], [{ call: 'render', arg: 'f', status: 'error', code: 'usage.bad-argument' }]]);
  // 交给镜头代码的帧号：放进镜头输入的事件的全片帧号对观测点在 ctx.events 里看到的（镜头外的事件也在，负数），再加每次 meta 收到的
  assert.deepEqual(time.localized.slice(3), [{ shot: 's02', frame: 14, f: 4 }, { shot: 's02', frame: 2, f: -8 }, { shot: 's02', frame: 13, f: 3 }]);
  // 可以省的实体照实列：类别是 part、没有角色
  assert.deepEqual([r[1].omittable, r[1].mode, r[1].entry], [['cube'], 'native-code', 'shot.js']);
  // 生效的子帧采样数：第一个镜头写在条目里，第二个没写、用能力声明的默认值
  assert.deepEqual([r[2].renders[0].shutterSamples, r[5].renders[0].shutterSamples], [2, 2]);
  assert.deepEqual(effectiveShutter({ opts: { shutter: { angleDeg: 0, samples: 1 } } }, obs.shots[1].shot, obs.caps, obs.lock), { angleDeg: 0, samples: 1 });
  assert.deepEqual(effectiveShutter({ opts: {} }, { id: 's09' }, obs.caps, obs.lock), { angleDeg: 0, samples: 1 });
});

test('没量到的不写：没量出对预言图的差时 accumulation 是空的，没量编号层对预言图就不写那个字段，观测点没交东西、没读到镜头标识的那一帧整项不写', () => {
  const obs = observation();
  delete obs.shots[0].renders[0].linearErr;
  delete obs.shots[0].renders[0].auxMismatch;
  delete obs.shots[0].renders[3].seen;
  delete obs.shots[1].renders[0].seen.shot;
  const { frames } = timeCheck(obs);
  assert.deepEqual(frames.map((x) => x.shot), ['s01', 's02']);
  assert.deepEqual([frames[0].accumulation, 'auxMismatch' in frames[0], frames[1].auxMismatch], [{}, false, 0]);
  // 一次观测都没有：观测点数的三样和 ctx 都不写，不拿 0 充数
  const shot = shotCheck({ ...obs, shots: [{ ...obs.shots[0], renders: [obs.shots[0].renders[2]] }] }, { ...obs.shots[0], renders: [obs.shots[0].renders[2]] });
  assert.deepEqual(['metaKeys' in shot, 'cardUses' in shot, 'ctx' in shot, 'buildCalls' in shot], [false, false, false, false]);
  // 报的错不带错误码：记录里 code 不出现
  const uncoded = observation();
  delete uncoded.shots[0].renders[2].code;
  delete uncoded.shots[0].badArgs[0].code;
  const src = sourceCheck(uncoded, uncoded.shots[0]);
  assert.deepEqual(['code' in src.renders[2], 'code' in src.badArgs[0], src.renders[2].status], [false, false, 'error']);
  // 层文件的字节数对不上层引用的 shape 时不记颜色层的形状
  obs.shots[0].renders[0].fileBytes.color -= 4;
  assert.equal('colorShape' in metaCheck(obs, obs.shots[0]).renders[0], false);
  // 第二次装载的那次 render 没有观测，ctx 只剩一项；草稿档的装载不记 want.size
  assert.deepEqual(shotCheck(obs, obs.shots[0]).ctx.map((x) => 'size' in x.want), [true]);
  obs.shots[0].loads[0].tier = 'draft';
  assert.deepEqual(shotCheck(obs, obs.shots[0]).ctx.map((x) => 'size' in x.want), [false]);
});

test('观测里的毛病原样进记录，被对应的条文判出来', () => {
  const state = (o, shot, call, i) => o[shot].renders[call].seen.states[i];
  const cases = {
    // 第二个镜头把全片帧号交给了镜头代码：采样和辅助层的时刻跟着跑出镜头和快门窗口，四条一起判出来
    'T4,T5,T8,T9': (o) => { for (const s of o[1].renders[0].seen.states) s.f = 13; },
    'T5,T14': (o) => { state(o, 0, 0, 1).sub = 0.5; },                      // 采样落到快门窗口外
    T14: (o) => { state(o, 0, 0, 0).sub = 0.0625; state(o, 0, 0, 1).sub = 0.1875; },   // 采样挤在窗口前半
    T6: (o) => { o[0].renders[0].linearErr = 0.02; },                       // 累积颜色层对线性平均的预言图差得太多
    T9: (o) => { o[1].localized[0].f = 14; },                               // 交给镜头代码的事件帧号没减镜头的起始帧
    'T9 ': (o) => { o[1].metaFrames[0].f = 13; },                           // meta 收到的是全片帧号
    T4: (o) => { for (const r of o[1].renders) if (r.seen) r.seen.shot = 's01'; },   // 第二个镜头的采样求的是第一个镜头的状态
    T12: (o) => { o[0].rng[0].name = '7/probe/x'; },                        // 镜头代码拿到的流名少了镜头那一段
    F20: (o) => { o[0].manifest.entities[0].id = 2; o[0].renders[0].meta.entities[0].id = 2; },   // 编号不是名字的名次（元数据和实体清单一起错）
    'F8,F9': (o) => { o[0].queries[0] = { kind: 'bbox3d', status: 'ok', total: 1, returned: 0 }; },   // 没声明的查询却答了；问了一个实体的包围盒，一项都没交回
    T8: (o) => { state(o, 0, 0, 2).sub = 0.25; },                           // 辅助层没取 sub = 0
    'T8 ': (o) => { o[0].renders[0].auxMismatch = 37; },                    // 编号层对预言图在边缘带之外有对不上的像素
    'T1,S1': (o) => { o[0].evaluations[1].digest = '0123abce'; },           // 同一时刻两种求法摘要不同：时间和镜头两份记录都带着这批观测
    T13: (o) => { o[0].rng[1].digest = 'deadbeee'; },                       // 同名的流换了序列
    T2: (o, obs) => { obs.scans.path.wallClock.push({ path: 'x.js', call: 'clock' }); },
    S2: (o) => { o[0].renders[3].seen.builds = 2; },
    S9: (o) => { o[0].renders[1].seen.cardUses = [{ as: 'ghost', runtimeKeys: [] }]; },   // 镜头代码用了没声明的卡，装载却算成功
    'S10  ': (o) => { o[1].renders[0].seen.ctx.shotIn = 11; },                       // 交给镜头代码的起始帧多了 1
    S7: (o) => { o[0].scan.unseededRandom.push({ path: 'aux.js', call: 'random' }); },   // 只有第一个镜头的本镜头文件里有，第二个镜头不跟着红
    S8: (o) => { o[0].renders[0].seen.metaKeys.push('unknown'); },
    F1: (o) => { o[0].renders[0].layers = ['color']; },                     // 要了深度没交
    F3: (o) => { Object.assign(o[0].renders[2], { status: 'ok', metas: 1, meta: o[0].renders[0].meta, metaBytes: 900, layers: ['color'], layerRefs: [] }); },   // 没声明的输出没报错
    F4: (o) => { o[0].renders[3].layerRefs[0].fileHash = `sha256:${'cd'.repeat(32)}`; o[0].renders[3].layerRefs[0].hash = `sha256:${'cd'.repeat(32)}`; o[0].renders[3].meta = { ...o[0].renders[3].meta, hash: { color: `sha256:${'cd'.repeat(32)}` } }; },   // 另一个进程渲出的不一样
    F12: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, camera: { shutterAngleDeg: 90 } }; },
    F14: (o) => { Object.assign(o[0].opens[0], { status: 'ok' }); delete o[0].opens[0].code; },   // 没有锁文件又没写种子，却装上了
    F16: (o) => { o[0].opens[2].mode = 'cards-data'; },                     // 作者模式不在能力声明里，却装上了
    F23: (o) => { Object.assign(o[0].badArgs[0], { status: 'ok' }); delete o[0].badArgs[0].code; },   // 帧号出了值域，却出了帧
    'F23 ': (o) => { delete o[0].badArgs[0].code; },                        // 帧号出了值域，报的错不带错误码
    F25: (o) => { Object.assign(o[0].opens[2], { status: 'error', code: 'usage.bad-argument' }); },   // 声明过的宿主和作者模式，原样的镜头输入却装不上
    F26: (o) => { Object.assign(o[0].opens[1], { status: 'ok' }); delete o[0].opens[1].code; },   // 带着装不了的叠加层，却照常装上了
    'F26 ': (o) => { delete o[0].opens[1].code; },                          // 装不了，报的错不带错误码
    'F24,F24': (o, obs) => { obs.caps.sceneQuery = ['bbox3d']; },           // 声明了的查询却报错；能力声明两个镜头的记录里是同一份
    M18: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, film: 'f_y' }; },   // 元数据的片子不是这部片子
    M19: (o) => { o[1].renders[0].meta = { ...o[1].renders[0].meta, shot: 's01' }; },   // 第二个镜头的元数据写成了第一个镜头
    M20: (o) => { o[0].renders[1].meta = { ...o[0].renders[1].meta, fps: '25/1' }; },   // 元数据的帧率不是片子的
    M17: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, source: { id: 'core', renderer: 'three', tier: 'final' } }; },   // 元数据的 source.id 不是镜头条目顶层写的帧源
    F17: (o) => { o[0].renders[0].layerRefs[1].fileHash = `sha256:${'cd'.repeat(32)}`; },   // 深度层的层引用里的哈希不是文件的
    F27: (o) => { o[0].renders[0].layerRefs[1].fileBytes -= 4; },   // 层文件比 shape 算出来的少一个数
    'F17 ': (o) => { Object.assign(o[0].renders[0].layerRefs[1], { shape: [180, 320, 1], fileBytes: 180 * 320 * 4 }); }, // 层的形状不是这次输出的尺寸（文件本身照这个形状写）
    F18: (o) => { o[0].renders[0].unsupportedOpts = ['samples']; },         // 要了交不出的每像素采样数，却出了帧
    F19: (o) => { o[0].renders[0].unfitOutputs = ['depth']; },              // 场景里有深度层放不进的对象，却出了帧
    M1: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, hash: { color: `sha256:${'cd'.repeat(32)}` } }; },   // 元数据里的哈希不是这次交回的颜色层的
    M3: (o) => { o[0].renders[1].metaBytes = 70000; },
    M11: (o) => { o[1].renders[0].meta = { ...o[1].renders[0].meta, frame: 3 }; },   // 元数据的全片帧号没加镜头的起始帧
    M12: (o) => { o[0].renders[1].meta = { ...o[0].renders[1].meta, seed: 8 }; },    // 元数据的种子不是这个镜头生效的那个
    M13: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, size: [1280, 720] }; },   // 元数据的尺寸不是交回的颜色层的宽和高
    M14: (o) => { Object.assign(o[0].renders[3], { tier: 'draft' }); },              // 草稿档的会话，元数据里的档位还写着 final
    S10: (o) => { o[0].renders[0].seen.ctx.seed = 8; },                              // 交给镜头代码的种子多了 1，随机流名没跟着错
    'S10 ': (o) => { delete o[1].renders[3].seen.ctx.fps; },                         // ctx 里没有帧率
  };
  for (const [id, mutate] of Object.entries(cases)) {
    const obs = observation();
    mutate(obs.shots, obs);
    assert.deepEqual(build(obs).flatMap(violations), id.trim().split(','), `改坏之后应该只判出 ${id}`);
  }
});

test('linearErr 量不出的情形：每像素多个样本、带景深、没要元数据', () => {
  const caps = { final: { samples: 1 } }, pinhole = { camera: {} }, meta = { camera: {} };
  const r = (more = {}) => ({ tier: 'final', meta, ...more });
  assert.equal(linearErrBlocked(r(), {}, caps, pinhole), null);
  assert.equal(linearErrBlocked(r({ opts: { samples: 4 } }), {}, caps, pinhole), '每像素采样数大于 1');
  assert.equal(linearErrBlocked(r(), { tiers: { final: { samples: 2 } } }, caps, pinhole), '每像素采样数大于 1');
  assert.equal(linearErrBlocked(r({ opts: { samples: 1 } }), {}, { final: { samples: 8 } }, pinhole), null);
  assert.equal(linearErrBlocked(r(), {}, caps, { camera: { apertureDiameterM: 0.05 } }), '这一帧带景深');
  assert.equal(linearErrBlocked(r({ meta: { camera: { focusDist: 5, fstop: 2.8, sensorHeightM: 0.024 } } }), {}, caps, pinhole), '这一帧带景深');
  assert.equal(linearErrBlocked(r({ meta: undefined }), {}, caps, pinhole), '这次调用没要元数据，看不出带不带景深');
});
