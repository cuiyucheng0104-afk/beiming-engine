import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { caps } from '../../sources/three/caps.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { boundsOf, centroid, classifyAverage, diffLayers, dist, expectedLayers, measurePixelOffset } from './compare.mjs';
import { metaCheck, shotCheck, sourceCheck, timeCheck } from './records.mjs';
import { scanFiles, scanText, sourceFiles, withDirectImports } from './scan.mjs';

const REPO = new URL('../../../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, REPO), 'utf8'));
const film = readJson('beiming/kernel/conformance/fixtures/film.json');
const scene = readJson('beiming/calib/probe-moving-cube/scene.json');
const IDS = { cube: 7, highlight: 9 }; // 故意不用规格里的 idIndex：编号要经名字查
const { validate } = await loadContracts();
const violations = (obj) => { const v = validate(obj); assert.deepEqual(v.schemaErrors, []); return Object.keys(v.violations); };

test('最小片子描述过校验：两个镜头，帧率、帧数、画幅和场景规格照校准场景，第二个不从第 0 帧起、不给背景色', () => {
  assert.deepEqual(violations(film), []);
  const n = scene.frameRange.endFrame + 1, [a, b] = film.shots;
  assert.deepEqual(film.output, { size: [scene.camera.widthPx, scene.camera.heightPx], fps: `${scene.frameRateFps}/1`, frames: 2 * n });
  assert.deepEqual(a.params, { camera: scene.camera, backgroundLinear: scene.backgroundLinear, objects: scene.objects });
  assert.deepEqual(b.params, { camera: scene.camera, objects: scene.objects });
  assert.deepEqual([a.in, a.out, b.in, b.out], [0, n, n, 2 * n]);
  for (const shot of film.shots) assert.deepEqual([shot.source, shot.host, shot.entry, shot.shutter.angleDeg], ['three', 'page', a.entry, scene.camera.shutterAngleDeg]);
  assert.notEqual(a.seed, b.seed);
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

test('量像素内位置：照哪个位置求交出的编号层，就量出哪个位置；分不出时不给数', () => {
  // 方块在画面正中的时刻，四条边都压在能区分这几个位置的地方
  for (const offset of [[0.5, 0.5], [0.25, 0.75]]) {
    const got = expectedLayers(scene, 24, IDS, offset).id;
    assert.deepEqual(measurePixelOffset(got, scene, 24, IDS, 2), offset);
    assert.equal(measurePixelOffset(got, scene, 24, IDS, 1e6), null);
  }
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

// 一次像样的观测：两个镜头，第二个从全片第 10 帧起；各渲了局部第 3 帧（两个子帧采样加辅助层），第一个镜头外加一次只要元数据、一次报错
function observation() {
  const sha = 'ab'.repeat(32);
  const one = (id, start) => {
    const meta = { shotFrame: 3, colorRef: 'scene', camera: { shutterAngleDeg: 180 }, entities: [{ id: 1, name: 'cube', class: 'part' }], source: { renderer: 'three' } };
    const full = (run, order) => ({
      run, call: 0, f: 3, opts: {}, want: ['color', 'meta', 'depth'], status: 'ok', metas: 1, meta, metaBytes: 900, layers: ['color', 'depth'], colorSha: sha, colorCall: 0, colorTransfer: 'linear', order,
      average: 'linear', pixelOffset: [0.5, 0.5],
      applies: [{ f: 3, sub: 0.125, purpose: 'color' }, { f: 3, sub: 0.375, purpose: 'color' }, { f: 3, sub: 0, purpose: 'aux' }],
    });
    return {
      shot: { id, in: start, out: start + 10, mode: 'native-code', entry: 'shot.js', seed: 7, colorRef: 'scene', shutter: { angleDeg: 180, samples: 2 } },
      manifest: { frames: 10, entities: [{ id: 1, name: 'cube', class: 'part' }] },
      renders: [
        full('a', 'sequential'),
        { run: 'a', call: 1, f: 3, opts: {}, want: ['meta'], status: 'ok', metas: 1, meta, metaBytes: 800, layers: [], applies: [{ f: 3, sub: 0, purpose: 'meta' }] },
        { run: 'a', call: 2, f: 3, opts: {}, want: ['color', 'motion'], status: 'error', code: 'contract.unsupported-output', applies: [] },
        full('b', 'single'),
      ],
      loads: [{ buildCalls: 1 }, { buildCalls: 1 }],
      evaluations: [{ f: 3, sub: 0, mode: 'single', digest: '0123abcd' }, { f: 3, sub: 0, mode: 'shuffled', digest: '0123abcd' }],
      rng: [{ run: 'a', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }, { run: 'b', arg: 'probe/x', name: `7/${id}/probe/x`, digest: 'deadbeef' }],
      queries: [{ kind: 'bbox3d', status: 'error', code: 'contract.unsupported-query' }],
      cardUses: [], metaKeys: [],
    };
  };
  return {
    film: { output: { fps: '24/1' } }, caps: caps(), holds: [{ f: 5, n: 2, result: 4 }],
    scans: { path: { wallClock: [], unseededRandom: [] }, shot: { wallClock: [], unseededRandom: [] } },
    shots: [one('s01', 0), one('s02', 10)],
  };
}
const build = (obs) => [timeCheck(obs), ...obs.shots.flatMap((one) => [shotCheck(obs, one), sourceCheck(obs, one), metaCheck(one, 'a')])];

test('像样的观测写出的核对记录一条不违反', () => {
  const obs = observation(), r = build(obs);
  assert.equal(r.length, 7);
  for (const rec of r) assert.deepEqual(violations(rec), []);
  // 第二个镜头：帧号换成了全片帧号，交给镜头代码的还是局部帧号
  const time = r[0];
  assert.deepEqual(time.shots.map((x) => [x.id, x.start]), [['s01', 0], ['s02', 10]]);
  assert.deepEqual(time.frames[2], {
    frame: 13, shot: 's02', f: 3, samples: [{ frame: 13, sub: 0.125, shot: 's02' }, { frame: 13, sub: 0.375, shot: 's02' }],
    accumulation: { average: 'linear' }, aux: { frame: 13, sub: 0 }, auxSample: { apertureM: 0, shutterAngleDeg: 0, samples: 1, pixelOffset: [0.5, 0.5] },
  });
  // 只要元数据的那次不进逐帧采样；另一次运行的调用不进这一份元数据核对记录；帧源核对记录里没有 auxUses
  assert.equal(time.frames.length, 4);
  assert.deepEqual(r[3].renders, [{ call: 0, shotFrame: 3, metas: 1, metaBytes: 900, colorCall: 0 }, { call: 1, shotFrame: 3, metas: 1, metaBytes: 800 }]);
  assert.deepEqual(r[2].orderRuns.map((o) => o.mode), ['sequential', 'single']);
  assert.equal('auxUses' in r[2], false);
});

test('没量到的不写：没量平均方式就没有 accumulation，没量像素内位置就没有 auxSample', () => {
  const obs = observation();
  delete obs.shots[0].renders[0].average;
  delete obs.shots[0].renders[0].pixelOffset;
  const frame = timeCheck(obs).frames[0];
  assert.deepEqual(Object.keys(frame), ['frame', 'shot', 'f', 'samples', 'aux']);
});

test('观测里的毛病原样进记录，被对应的条文判出来', () => {
  const cases = {
    // 第二个镜头把全片帧号交给了镜头代码：采样的时刻跟着跑出镜头和快门窗口，三条一起判出来
    'T4,T5,T9': (o) => { o[1].renders[0].applies[0].f = 13; },
    T5: (o) => { o[0].renders[0].applies[1].sub = 0.5; },                   // 采样落到快门窗口外
    T6: (o) => { o[0].renders[0].average = 'encoded'; },                    // 量出来是在编码值上取的平均
    T8: (o) => { o[0].renders[0].applies[2].sub = 0.25; },                  // 辅助层没取 sub = 0
    'T8 ': (o) => { o[0].renders[0].pixelOffset = [0.25, 0.5]; },           // 量出来辅助层没取像素中心
    'T8  ': (o) => { o[0].renders[0].applies.push({ f: 3, sub: 0, purpose: 'aux' }); },   // 辅助层写了两次状态
    'T1,S1': (o) => { o[0].evaluations[1].digest = '0123abce'; },           // 同一时刻两种求法摘要不同：时间和镜头两份记录都带着这批观测
    T13: (o) => { o[0].rng[1].digest = 'deadbeee'; },                       // 同名的流换了序列
    T2: (o, obs) => { obs.scans.path.wallClock.push({ path: 'x.js', call: 'clock' }); },
    S2: (o) => { o[0].loads[1].buildCalls = 2; },
    'S7,S7': (o, obs) => { obs.scans.shot.unseededRandom.push({ path: 'shot.js', call: 'random' }); },   // 两个镜头同一份镜头代码
    S8: (o) => { o[0].metaKeys.push('camera'); },
    F1: (o) => { o[0].renders[0].layers = ['color']; },                     // 要了深度没交
    F3: (o) => { Object.assign(o[0].renders[2], { status: 'ok', metas: 1, metaBytes: 900, layers: ['color'] }); },   // 没声明的输出没报错
    F4: (o) => { o[0].renders[3].colorSha = 'cd'.repeat(32); },             // 另一个浏览器渲出的不一样
    F12: (o) => { o[0].renders[0].meta = { ...o[0].renders[0].meta, camera: { shutterAngleDeg: 90 } }; },
    M1: (o) => { o[0].renders[0].colorCall = 1; },                          // 元数据里的哈希对上的是另一次调用的颜色层
    M3: (o) => { o[0].renders[1].metaBytes = 70000; },
  };
  for (const [id, mutate] of Object.entries(cases)) {
    const obs = observation();
    mutate(obs.shots, obs);
    assert.deepEqual(build(obs).flatMap(violations), id.trim().split(','), `改坏之后应该只判出 ${id}`);
  }
});
