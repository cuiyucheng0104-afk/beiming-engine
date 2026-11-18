import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { caps } from '../../sources/three/caps.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { boundsOf, centroid, classifyAverage, diffLayers, dist, expectedLayers, measurePixelOffset } from './compare.mjs';
import { observed, readObservation, RNG_RUNS } from './fixtures/observe.js';
import { effectiveShutter, metaCheck, shotCheck, sourceCheck, timeCheck } from './records.mjs';
import { scanFiles, scanText, sourceFiles, withDirectImports } from './scan.mjs';

const REPO = new URL('../../../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, REPO), 'utf8'));
const FIXTURES = 'beiming/kernel/conformance/fixtures';
const film = readJson(`${FIXTURES}/film.json`);
const scene = readJson('beiming/calib/probe-moving-cube/scene.json');
const IDS = { cube: 7, highlight: 9 }; // 故意不用规格里的 idIndex：编号要经名字查
const { validate } = await loadContracts();
const violations = (obj) => { const v = validate(obj); assert.deepEqual(v.schemaErrors, []); return Object.keys(v.violations); };

test('最小片子描述和例子锁过校验：三个镜头首尾相接，后两个不从第 0 帧起；旁边的规格文件和校准场景一致', () => {
  assert.deepEqual(violations(film), []);
  const lock = readJson(`${FIXTURES}/lock.json`);
  assert.deepEqual(violations(lock), []);
  let at = 0;
  for (const shot of film.shots) {
    const name = shot.entry.replace('.shot.js', ''), calib = readJson(`beiming/calib/probe-${name}/scene.json`);
    // 规格是两份：镜头代码只能引用自己目录里的文件，答案在校准目录里。这里盯着两份一致
    assert.deepEqual(readJson(`${FIXTURES}/${name}.scene.json`), { camera: calib.camera, backgroundLinear: calib.backgroundLinear, objects: calib.objects });
    assert.deepEqual([shot.in, shot.out, shot.source, shot.host, shot.shutter.angleDeg], [at, at + calib.frameRange.endFrame + 1, 'three', 'page', calib.camera.shutterAngleDeg]);
    assert.deepEqual([film.output.size, film.output.fps], [[calib.camera.widthPx, calib.camera.heightPx], `${calib.frameRateFps}/1`]);
    assert.deepEqual([lock.seeds[shot.id], lock.shots[shot.id].shutterSamples], [shot.seed, shot.shutter.samples ?? caps().motionBlur.samples]);
    at = shot.out;
  }
  assert.equal(film.output.frames, at);
  assert.equal(new Set(film.shots.map((x) => x.seed)).size, film.shots.length);
  assert.equal(lock.film, film.id);
});

test('静态扫描认得出墙钟和不带种子的随机，白名单只放行点名的那一处', () => {
  // 被找的调用名拆开写：这个目录也会被同样的规则搜
  const clock = ['Date', 'now'].join('.'), perf = ['performance', 'now'].join('.'), random = ['Math', 'random'].join('.');
  const hits = scanText(`const a = ${clock}(); const b = new ${'Date'}(); const c = ${perf}() + ${random}() + ${random}();\nconst ok = new ${'Date'}(0);`);
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['unseededRandom', 'unseededRandom', 'wallClock', 'wallClock', 'wallClock']);
  assert.deepEqual(scanText('const now = performanceNow; const r = rng.next();'), []);

  const root = new URL('.', REPO).pathname;
  const files = sourceFiles(root, ['beiming/host/page']);
  assert.ok(files.includes('beiming/host/page/clock.js') && !files.some((f) => f.includes('.test.')));
  const strict = scanFiles(root, files), lenient = scanFiles(root, files, [{ path: 'beiming/host/page/clock.js', call: perf }]);
  assert.deepEqual(strict.wallClock, [{ path: 'beiming/host/page/clock.js', call: perf }]);
  assert.deepEqual([lenient.wallClock, lenient.allowed], [[], strict.wallClock]);
  assert.deepEqual(withDirectImports(root, 'beiming/kernel/conformance/compare.mjs'), ['beiming/kernel/conformance/compare.mjs', 'beiming/calib/check.mjs']);
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

test('量像素内位置：照哪个位置求交出的编号层，就量出哪个位置；解释不了或者没东西时不给数', () => {
  for (const offset of [[0.5, 0.5], [0.25, 0.75]]) assert.deepEqual(measurePixelOffset(expectedLayers(scene, 24, IDS, offset).id, scene, 24, IDS), offset);
  // 取的是快门中点那一刻：哪个位置都解释不了
  assert.equal(measurePixelOffset(expectedLayers(scene, 24.25, IDS).id, scene, 24, IDS), null);
  assert.equal(measurePixelOffset(new Uint32Array(scene.camera.widthPx * scene.camera.heightPx), scene, 24, IDS), null);
});

test('判平均方式：线性平均、编码值上平均各认得出，都对不上或分不出时不给结论', () => {
  // 四个像素：前两个各子帧相同（分不出两种平均），后两个是拖影边缘（一半子帧有东西）
  const A = new Float32Array([0.18, 0.18, 0.18, 1, 0, 0, 0, 1, 0.18, 0.18, 0.18, 1, 50, 50, 50, 1]);
  const B = new Float32Array([0.18, 0.18, 0.18, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const singles = [A, A, B, B];
  const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055), dec = (y) => (y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4);
  const mix = (fn) => Float32Array.from(A, (a, i) => fn(a, B[i], i));
  const linear = classifyAverage(mix((a, b) => (a + b) / 2), singles);
  assert.deepEqual([linear.average, linear.distinguishing], ['linear', 6]);
  assert.equal(classifyAverage(mix((a, b, i) => (i % 4 === 3 ? 1 : dec((enc(a) + enc(b)) / 2))), singles).average, 'encoded');
  // 2.2 次幂上平均：既不是线性平均，也不是 sRGB 编码值上的平均
  assert.equal(classifyAverage(mix((a, b) => ((a ** (1 / 2.2) + b ** (1 / 2.2)) / 2) ** 2.2), singles).average, null);
  assert.equal(classifyAverage(A, [A, A]).average, null);
});

test('观测点：记下 build 跑了几次、state 收到的每个时刻和那一刻被画的是哪一种、meta(f) 交回的键、随机流的名字和数', async () => {
  const mat = {}, mesh = { isMesh: true, material: mat };
  const scene = { traverse: (fn) => fn(mesh), onBeforeRender: null };
  const streams = {};
  const ctx = {
    seed: 7, shot: { id: 's02', in: 10, frames: 5 }, cards: { use: () => ({}) },
    rng: (arg) => { let n = 0; streams[arg] = (streams[arg] ?? 0) + 1; return { name: arg === 'probe/extra' ? 'wrong' : `7/s02/${arg}`, u32: () => arg.length * 100 + n++ }; },
  };
  const got = [];
  const build = observed((c) => { c.cards.use('x'); return { scene, state: (f, sub) => got.push([f, sub]), meta: () => ({ texts: [], camera: {}, readings: { own: 3 } }) }; });
  const shot = await build(ctx);
  shot.state(3, 0.125); scene.onBeforeRender();
  shot.state(3, 0.375); scene.onBeforeRender();
  shot.state(3, 0); mesh.material = {}; scene.onBeforeRender(); scene.onBeforeRender(); mesh.material = mat;
  const meta = shot.meta(3);
  assert.equal(meta.readings.own, 3);
  for (const v of Object.values(meta.readings)) assert.equal(typeof v, 'number');
  const seen = readObservation(meta.readings);
  assert.deepEqual([seen.builds, seen.shotIn, seen.cardUses, seen.metaKeys], [1, 10, 1, ['texts', 'readings', 'unknown']]);
  assert.deepEqual(seen.states, [{ f: 3, sub: 0.125, color: 1, aux: 0 }, { f: 3, sub: 0.375, color: 1, aux: 0 }, { f: 3, sub: 0, color: 0, aux: 2 }]);
  assert.deepEqual(got, [[3, 0.125], [3, 0.375], [3, 0]]);
  assert.deepEqual(seen.rng.map((x) => [x.run, x.arg, x.nameOk]), [['a', 'probe/alpha', true], ['a', 'probe/beta', true], ['b', 'probe/beta', true], ['b', 'probe/extra', false], ['b', 'probe/alpha', true]]);
  assert.deepEqual(seen.rng[0].values.slice(0, 3), [1100, 1101, 1102]);
  assert.equal(Object.keys(RNG_RUNS).length, 2);
  // 交出去就清：下一次 meta(f) 只有新的时刻
  shot.state(4, 0);
  assert.deepEqual(readObservation(shot.meta(4).readings).states, [{ f: 4, sub: 0, color: 0, aux: 0 }]);
  await build(ctx);
  assert.equal(readObservation(shot.meta(4).readings).builds, 2);
  assert.equal(readObservation({ own: 3 }), null);
});

// 一次像样的观测：两个镜头，第二个从全片第 10 帧起、没写子帧采样数；各渲了局部第 3 帧（两个子帧采样加辅助层），第一个镜头外加一次只要元数据、一次报错、一次没有锁文件又没写种子的 open
function observation() {
  const sha = `sha256:${'ab'.repeat(32)}`, CAPS = { ...caps(), motionBlur: { mode: 'accumulate', auxAt: 'sub0', samples: 2 } };
  const one = (id, start, shutter) => {
    const meta = { frame: start + 3, shotFrame: 3, colorRef: 'scene', camera: { shutterAngleDeg: 180 }, entities: [{ id: 1, name: 'cube', class: 'part' }], source: { renderer: 'three' }, hash: { color: sha } };
    const seen = (states) => ({ builds: 1, shotIn: start, cardUses: 0, metaKeys: [], states });
    const ref = (output, n) => ({ output, shape: [360, 640, n], sha256: sha, fileSha256: sha });
    const full = (call, order) => ({
      call, f: 3, opts: {}, want: ['color', 'meta', 'depth'], locked: false, status: 'ok', metas: 1, meta, metaBytes: 900, layers: ['color', 'depth'], layerRefs: [ref('color', 4), ref('depth', 1)], order,
      unsupportedOpts: [], unfitOutputs: [], average: 'linear', pixelOffset: [0.5, 0.5],
      seen: seen([{ f: 3, sub: 0.125, color: 1, aux: 0 }, { f: 3, sub: 0.375, color: 1, aux: 0 }, { f: 3, sub: 0, color: 0, aux: 1 }]),
    });
    const opened = (more) => ({ plain: true, hasLock: false, hasSeed: true, usesCards: false, usesAssets: false, host: 'page', mode: 'native-code', status: 'ok', ...more });
    return {
      shot: { id, in: start, out: start + 10, mode: 'native-code', entry: 'shot.js', seed: 7, colorRef: 'scene', shutter },
      languages: ['js'],
      manifest: { frames: 10, entities: [{ id: 1, name: 'cube', class: 'part' }] },
      opens: [opened({ plain: false, hasSeed: false, status: 'error', code: 'env.lock-required' }), opened(), opened()],
      renders: [
        full(0, 'sequential'),
        { call: 1, f: 3, opts: {}, want: ['meta'], locked: false, status: 'ok', metas: 1, meta: { ...meta, hash: { color: null } }, metaBytes: 800, layers: [], layerRefs: [], unsupportedOpts: [], unfitOutputs: [], seen: seen([{ f: 3, sub: 0, color: 0, aux: 0 }]) },
        { call: 2, f: 3, opts: {}, want: ['color', 'motion'], locked: false, status: 'error', code: 'contract.unsupported-output', unsupportedOpts: [], unfitOutputs: [] },
        full(3, 'single'),
      ],
      evaluations: [{ f: 3, sub: 0, mode: 'single', digest: '0123abcd' }, { f: 3, sub: 0, mode: 'shuffled', digest: '0123abcd' }],
      rng: [{ run: 'a', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }, { run: 'b', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }],
      queries: [{ kind: 'bbox3d', status: 'error', code: 'contract.unsupported-query' }],
    };
  };
  const shots = [one('s01', 0, { angleDeg: 180, samples: 2 }), one('s02', 10, { angleDeg: 180 })];
  return {
    film: { output: { fps: '24/1', size: [640, 360] }, shots: shots.map((x) => x.shot) }, caps: CAPS, lock: { shots: { s01: { shutterSamples: 2 }, s02: { shutterSamples: 2 } } },
    holds: [{ f: 5, n: 2, result: 4 }], scans: { path: { wallClock: [], unseededRandom: [] }, shot: { wallClock: [], unseededRandom: [] } }, shots,
  };
}
const build = (obs) => [timeCheck(obs), ...obs.shots.flatMap((one) => [shotCheck(obs, one), sourceCheck(obs, one), metaCheck(one)])];

test('像样的观测写出的核对记录一条不违反', () => {
  const obs = observation(), r = build(obs);
  assert.equal(r.length, 7);
  for (const rec of r) assert.deepEqual(violations(rec), []);
  // 第二个镜头：帧号换成了全片帧号，观测点看到交给镜头代码的还是局部帧号
  const time = r[0];
  assert.deepEqual(time.shots.map((x) => [x.id, x.start]), [['s01', 0], ['s02', 10]]);
  assert.deepEqual(time.frames[2], {
    frame: 13, shot: 's02', f: 3, samples: [{ frame: 13, sub: 0.125, shot: 's02' }, { frame: 13, sub: 0.375, shot: 's02' }],
    accumulation: { average: 'linear' }, aux: { frame: 13, sub: 0 }, auxSample: { shutterAngleDeg: 0, samples: 1, pixelOffset: [0.5, 0.5] },
  });
  // 只要元数据的那次不进逐帧采样；元数据核对记录里是工具重算的层文件哈希对元数据里的哈希
  assert.equal(time.frames.length, 4);
  assert.deepEqual(r[6].start, 10);
  assert.deepEqual(r[3].renders.slice(0, 2), [
    { call: 0, shotFrame: 3, metas: 1, metaBytes: 900, metaFrame: 3, metaShotFrame: 3, colorFileSha256: r[3].renders[0].metaHashColor, metaHashColor: r[3].renders[0].metaHashColor },
    { call: 1, shotFrame: 3, metas: 1, metaBytes: 800, metaFrame: 3, metaShotFrame: 3 },
  ]);
  assert.deepEqual(r[2].orderRuns.map((o) => o.mode), ['sequential', 'single']);
  assert.deepEqual([r[2].shot, r[2].opens.length, 'plain' in r[2].opens[0], r[2].renders[0].size, r[2].renders[0].layerRefs.length], ['s01', 3, false, [640, 360], 2]);
  // 生效的子帧采样数：第一个镜头写在条目里，第二个没写、用能力声明的默认值
  assert.deepEqual([r[2].renders[0].shutterSamples, r[5].renders[0].shutterSamples], [2, 2]);
  assert.deepEqual(effectiveShutter({ opts: { shutter: { angleDeg: 0, samples: 1 } } }, obs.shots[1].shot, obs.caps, obs.lock), { angleDeg: 0, samples: 1 });
  assert.deepEqual(effectiveShutter({ opts: {} }, { id: 's09' }, obs.caps, obs.lock), { angleDeg: 0, samples: 1 });
});

test('没量到的不写：没量平均方式时 accumulation 是空的，没量像素内位置就不写那个字段，观测点没交东西那一帧整项不写', () => {
  const obs = observation();
  delete obs.shots[0].renders[0].average;
  delete obs.shots[0].renders[0].pixelOffset;
  delete obs.shots[0].renders[3].seen;
  const { frames } = timeCheck(obs);
  assert.equal(frames.length, 3);
  assert.deepEqual([frames[0].accumulation, frames[0].auxSample], [{}, { shutterAngleDeg: 0, samples: 1 }]);
  const shot = shotCheck({ ...obs, shots: [{ ...obs.shots[0], renders: [obs.shots[0].renders[2]] }] }, { ...obs.shots[0], renders: [obs.shots[0].renders[2]] });
  assert.deepEqual(['metaKeys' in shot, 'cardUses' in shot, shot.buildCalls], [false, false, 0]);
});

test('观测里的毛病原样进记录，被对应的条文判出来', () => {
  const state = (o, shot, call, i) => o[shot].renders[call].seen.states[i];
  const cases = {
    // 第二个镜头把全片帧号交给了镜头代码：采样和辅助层的时刻跟着跑出镜头和快门窗口，四条一起判出来
    'T4,T5,T8,T9': (o) => { for (const s of o[1].renders[0].seen.states) s.f = 13; },
    'T5,T14': (o) => { state(o, 0, 0, 1).sub = 0.5; },                      // 采样落到快门窗口外
    T14: (o) => { state(o, 0, 0, 0).sub = 0.0625; state(o, 0, 0, 1).sub = 0.1875; },   // 采样挤在窗口前半
    T6: (o) => { o[0].renders[0].average = 'encoded'; },                    // 量出来是在编码值上取的平均
    T8: (o) => { state(o, 0, 0, 2).sub = 0.25; },                           // 辅助层没取 sub = 0
    'T8 ': (o) => { o[0].renders[0].pixelOffset = [0.25, 0.5]; },           // 量出来辅助层没取像素中心
    'T8  ': (o) => { o[0].renders[0].seen.states.push({ f: 3, sub: 0, color: 0, aux: 1 }); },   // 辅助层写了两次状态
    'T1,S1': (o) => { o[0].evaluations[1].digest = '0123abce'; },           // 同一时刻两种求法摘要不同：时间和镜头两份记录都带着这批观测
    T13: (o) => { o[0].rng[1].digest = 'deadbeee'; },                       // 同名的流换了序列
    T2: (o, obs) => { obs.scans.path.wallClock.push({ path: 'x.js', call: 'clock' }); },
    S2: (o) => { o[0].renders[3].seen.builds = 2; },
    'S7,S7': (o, obs) => { obs.scans.shot.unseededRandom.push({ path: 'shot.js', call: 'random' }); },   // 两个镜头同一份镜头代码
    S8: (o) => { o[0].renders[0].seen.metaKeys.push('unknown'); },
    F1: (o) => { o[0].renders[0].layers = ['color']; },                     // 要了深度没交
    F3: (o) => { Object.assign(o[0].renders[2], { status: 'ok', metas: 1, meta: o[0].renders[0].meta, metaBytes: 900, layers: ['color'], layerRefs: [] }); },   // 没声明的输出没报错
    F4: (o) => { o[0].renders[3].layerRefs[0].fileSha256 = `sha256:${'cd'.repeat(32)}`; o[0].renders[3].layerRefs[0].sha256 = `sha256:${'cd'.repeat(32)}`; o[0].renders[3].meta = { ...o[0].renders[3].meta, hash: { color: `sha256:${'cd'.repeat(32)}` } }; },   // 另一个进程渲出的不一样
    F12: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, camera: { shutterAngleDeg: 90 } }; },
    F14: (o) => { Object.assign(o[0].opens[0], { status: 'ok' }); delete o[0].opens[0].code; },   // 没有锁文件又没写种子，却装上了
    F16: (o) => { o[0].opens[1].mode = 'cards-data'; },                     // 作者模式不在能力声明里，却装上了
    F17: (o) => { o[0].renders[0].layerRefs[1].fileSha256 = `sha256:${'cd'.repeat(32)}`; },   // 深度层的层引用里的哈希不是文件的
    'F17 ': (o) => { o[0].renders[0].layerRefs[1].shape = [180, 320, 1]; }, // 层的形状不是这次输出的尺寸
    F18: (o) => { o[0].renders[0].unsupportedOpts = ['samples']; },         // 要了交不出的每像素采样数，却出了帧
    F19: (o) => { o[0].renders[0].unfitOutputs = ['depth']; },              // 场景里有深度层放不进的对象，却出了帧
    M1: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, hash: { color: `sha256:${'cd'.repeat(32)}` } }; },   // 元数据里的哈希不是这次交回的颜色层的
    M3: (o) => { o[0].renders[1].metaBytes = 70000; },
    M11: (o) => { o[1].renders[0].meta = { ...o[1].renders[0].meta, frame: 3 }; },   // 元数据的全片帧号没加镜头的起始帧
  };
  for (const [id, mutate] of Object.entries(cases)) {
    const obs = observation();
    mutate(obs.shots, obs);
    assert.deepEqual(build(obs).flatMap(violations), id.trim().split(','), `改坏之后应该只判出 ${id}`);
  }
});
