// T5 卡级验收。读数来自合成后的字节或实际相机投影，判分用题库的 read*/score；
// 不把这些卡级读数冒充编码成片的交付规格，也不为未跑的基础谓词填 pass。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three-webgpu';
import { argsOf, readClosure, readFraming, readLayout, readNearest, readPixelBoxes, score as scoreB2 } from '../bench/questions/level-1/evaluate-b2.mjs';
import { readCameraStatic, readLock, score as scoreB4 } from '../bench/questions/level-2-b/evaluate-b4.mjs';
import { checkScene } from '../calib/check.mjs';
import { resolveCalibScene } from '../calib/index.mjs';
import { calibShot } from '../calib/shot-three.js';
import { evaluate as drift } from './camera/drift/evaluate.mjs';
import { evaluate as fit } from './camera/fit/evaluate.mjs';
import { evaluate as orbit } from './camera/orbit/evaluate.mjs';
import { createCardRegistry } from './registry.mjs';
import { resolveParams } from './runtime.mjs';
import { dataValidators } from './sweep-schema.mjs';
import { create as layout } from './two-d/layout-panels/comp.mjs';
import { scanCardLeaks, validateCard } from './validate-card.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), BM = dirname(HERE);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const question = (id, level = 'level-1') => json(join(BM, 'bench/questions', level, `${id}.json`));
const spec = [
  ['layout.panels', 'two-d/layout-panels', 'comp', ['29-1']],
  ['camera.orbit', 'camera/orbit', 'data', ['28-1', '23-1']],
  ['camera.drift', 'camera/drift', 'data', ['15-2']],
  ['camera.fit', 'camera/fit', 'data', ['28-1']],
];
const cards = Object.fromEntries(spec.map(([id, dir]) => [id, json(join(HERE, dir, 'card.json'))]));
const params = (id, given = {}) => resolveParams(cards[id], given);
const shot = (size, frames) => ({ size, shot: { id: 's01', in: 0, frames } });
const range = n => Array.from({ length: n }, (_, i) => i);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} 对 ${b}（容差 ${eps}）`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };

test('四张卡：C1、全目录零泄漏、自测与唯一入口、校准场景、题号和 M2 窗口内检索', async () => {
  const registry = createCardRegistry(Object.values(cards), { nowDate: '2026-11-23', allowReproducedUntilDate: '2026-11-30' });
  for (const [id, dir, where, exams] of spec) {
    const card = cards[id], raw = readFileSync(join(HERE, dir, 'card.json'), 'utf8');
    // C1 的结构入口收对象；原文的词元泄漏扫描另外保留重复键中的内容。
    assert.deepEqual(scanCardLeaks(raw), []);
    assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, id);
    for (const name of readdirSync(join(HERE, dir))) assert.deepEqual(scanCardLeaks(readFileSync(join(HERE, dir, name), 'utf8')), [], name);
    assert.equal(card.id, id); assert.equal(card.version, '1.0.0'); assert.equal(card.kind, dir.split('/')[0]);
    assert.deepEqual(card.status.map(s => s.level), ['reproduced']);
    assert.ok(exams.every(exam => card.exams.includes(exam)));
    assert.deepEqual(card.livesIn, [where]); assert.equal(card.impl.length, 1);
    const [impl] = card.impl, shape = where === 'data' ? 'evaluate' : 'create';
    assert.equal(impl.livesIn, where); assert.equal(impl.shape, shape);
    assert.equal(impl.selftest, `cards/${dir}/selftest.test.mjs`); assert.ok(existsSync(join(BM, impl.selftest)));
    assert.equal(impl.entry, `cards/${dir}/${shape === 'evaluate' ? 'evaluate' : 'comp'}.mjs`);
    assert.deepEqual(Object.keys(await import(pathToFileURL(join(BM, impl.entry)).href)), [shape]);
    assert.ok(registry.searchCards({ kind: card.kind, q: card.title }).some(c => c.id === id));
    const scene = resolveCalibScene(card.calibration, { allowProbes: true });
    assert.deepEqual(checkScene(scene.scene, scene.id), []);
    for (const [key, check] of dataValidators(card)) assert.ok(check(params(id)[key]), `${id}.${key}`);
  }
  assert.deepEqual(scanCardLeaks(readFileSync(fileURLToPath(import.meta.url), 'utf8')), []);
});

const source = (width, height, level) => ({ width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(level) });

test('L2：顺序、乱序、隔离单帧取相同姿态或相同的合成字节；含子帧和运动', () => {
  const ctx = freeze({ ...shot([32, 24], 8), fps: '30/1', seed: 1, events: [] });
  const moments = [[0, 0], [1, 0.25], [3, 0.75], [4, 0], [7, 0]];
  const data = (fn, id, p) => () => { const resolved = freeze(params(id, p)); return (f, sub) => fn(ctx, resolved, f, sub); };
  const runners = [
    data(orbit, 'camera.orbit', { frames: 8 }), data(drift, 'camera.drift', { mode: 'linear', pushMeters: 0.25 }), data(fit, 'camera.fit', {}),
    () => { const h = layout(ctx, freeze(params('layout.panels', { direction: 'vertical', margin: 2, gap: 2, dividerPx: 2 })));
      return (f, sub) => hash(h.object.compose(h.object.panels.map(([, , w, h], i) => source(w, h, 20 + 30 * i + f * 10 + sub * 4)))); },
  ];
  for (const make of runners) {
    const sequential = make(), shuffled = make(), reference = moments.map(m => sequential(...m));
    for (const i of [3, 1, 4, 0, 2]) {
      assert.deepEqual(shuffled(...moments[i]), reference[i]);
      assert.deepEqual(make()(...moments[i]), reference[i]);
    }
  }
});

test('29-1：从 1080×1350 RGBA 回读全部十二条沿与分隔线颜色；偏移一像素或偏色五级分别失分', t => {
  const q = question('29-1'), size = q.deliverable.size, args = argsOf(q, 'layout.edges');
  function measure(p) {
    const { object } = layout({ size }, params('layout.panels', { direction: 'vertical', margin: 44, gap: 46, dividerPx: 4, dividerColor: '#CBFB03', background: '#090906', ...p }));
    const rgba = object.compose(object.panels.map(([, , w, h], i) => source(w, h, 110 + i * 100)));
    return readLayout({ width: size[0], height: size[1], rgba }, args, size);
  }
  const reading = measure({});
  assert.deepEqual(reading.bands, [[44, 652], [673, 677], [698, 1306]]);
  assert.deepEqual([...reading.edgeErrorsPx, ...reading.sideErrorsPx], Array(12).fill(0));
  assert.equal(reading.lineColorError, 0);
  const judge = r => scoreB2(q, { 'layout.edges': r });
  assert.equal(judge(reading).score, 1);
  assert.deepEqual(judge(measure({ margin: 45 })).items.map(i => i.pass), [false, true]);
  assert.deepEqual(judge(measure({ dividerColor: '#C6FB03' })).items.map(i => i.pass), [true, false]);
  t.diagnostic(`29-1：区段 ${JSON.stringify(reading.bands)}，十二条沿误差 0 px，线色误差 0 级`);
});

// 把公开校准场景定格在第 0 帧，真正动的是相机，不把物体自转叠加到运镜上。
// 从 three 网格取世界顶点；元数据由顶点投影求极值，像素另用三角网格边的扫描线画剪影。
function subject(ref, size) {
  const stage = calibShot(resolveCalibScene(ref).scene)({ THREE, size });
  stage.state(0, 0); stage.scene.updateMatrixWorld(true);
  const meshes = Object.values(stage.entities).map((m, i) => {
    const attr = m.geometry.attributes.position;
    return { vertices: range(attr.count).map(j => new THREE.Vector3().fromBufferAttribute(attr, j).applyMatrix4(m.matrixWorld)),
      indices: m.geometry.index.array, center: m.position.clone(), gray: 55 + i * 27 % 196 };
  });
  const box = new THREE.Box3().setFromObject(stage.scene, true);
  stage.dispose();
  return { meshes, bbox: { min: box.min.toArray(), max: box.max.toArray() } };
}
function projectMeshes({ meshes }, pose, [w, h]) {
  const camera = new THREE.PerspectiveCamera(pose.fovDeg, w / h, 0.1, 100);
  camera.position.fromArray(pose.pos); camera.quaternion.fromArray(pose.quat); camera.updateMatrixWorld();
  return meshes.map(m => ({ ...m, depth: m.center.clone().project(camera).z,
    points: m.vertices.map(v => { const p = v.clone().project(camera); return [(1 + p.x) * w / 2, (1 - p.y) * h / 2]; }) }));
}
const bounds = meshList => meshList.reduce((b, m) => {
  for (const [x, y] of m.points) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}, [Infinity, Infinity, -Infinity, -Infinity]);

// 校准体均为凸体；各行在外沿之间着同一灰度，按零件深度从远到近覆盖，不模拟灯光或材质。
function silhouette(meshList, [w, h]) {
  const gray = new Uint8Array(w * h);
  for (const { points, indices, gray: level } of [...meshList].sort((a, b) => b.depth - a.depth)) {
    const lo = new Float64Array(h).fill(w), hi = new Float64Array(h).fill(-1);
    for (let j = 0; j < indices.length; j++) {
      let a = points[indices[j]], b = points[indices[j % 3 === 2 ? j - 2 : j + 1]];
      if (a[1] > b[1]) [a, b] = [b, a];
      const end = Math.min(h, Math.ceil(b[1] - 0.5));
      for (let y = Math.max(0, Math.ceil(a[1] - 0.5)); y < end; y++) {
        const x = a[0] + (b[0] - a[0]) * (y + 0.5 - a[1]) / (b[1] - a[1]);
        lo[y] = Math.min(lo[y], x); hi[y] = Math.max(hi[y], x);
      }
    }
    for (let y = 0; y < h; y++) if (lo[y] < hi[y]) gray.fill(level, y * w + Math.max(0, Math.ceil(lo[y] - 0.5)), y * w + Math.min(w, Math.ceil(hi[y] - 0.5)));
  }
  return gray;
}
function image(meshes, size) {
  const [width, height] = size, gray = silhouette(meshes, size), rgba = new Uint8Array(gray.length * 4);
  for (let i = 0; i < gray.length; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = gray[i]; rgba[4 * i + 3] = 255; }
  return { width, height, rgba };
}

const poses = (ctx, p) => { const config = params('camera.orbit', { ...p, frames: ctx.shot.frames }); return range(ctx.shot.frames).map(f => orbit(ctx, config, f, 0).camera); };

test('23-1：72/60 帧的轨道与校准体剪影闭环，N−1 不复制首帧，末帧跳走会失分', t => {
  const q = question('23-1'), size = q.deliverable.size, model = subject('mech-head-proxy@1', size);
  // 72 帧直接用原题；60 帧按题目 controls 的约定换算帧号，保留相同误差门限。
  const short = structuredClone(q);
  short.deliverable.frames = 60;
  Object.assign(short.scoring[0].args, { search: [30, 60], expect: 59 });
  short.scoring[1].args.b = 59;
  for (const variant of [q, short]) {
    const n = variant.deliverable.frames;
    const track = poses(shot(size, n), { target: [0, 0.02, 0], distance: 0.7, elevationDeg: 4 });
    // 从位置而非自报的角度逐步解卷；包含跨缝的那一步，每一步都应为 2π/N。
    const angles = track.map(({ pos: [x, , z] }) => Math.atan2(x, z));
    for (const i of range(n)) {
      const step = angles[(i + 1) % n] - angles[i];
      near(Math.atan2(Math.sin(step), Math.cos(step)), 2 * Math.PI / n, 1e-12);
    }
    const frame = f => image(projectMeshes(model, track[f], size), size);
    const [a, b, last] = [0, 1, n - 1].map(frame);
    const reading = { ...readNearest(frame, variant.scoring[0].args.search), ...readClosure(a, last, b) };
    const judge = r => scoreB2(variant, { 'loop.closure-psnr': r });
    const ratio = 10 ** ((reading.adjacentPsnr - reading.closurePsnr) / 20);
    assert.ok(ratio > 0 && ratio <= 1.1, `接缝误差比 ${ratio}`); assert.equal(reading.nearest, n - 1);
    assert.equal(judge(reading).score, 1);
    assert.equal(judge({ ...reading, ...readClosure(a, frame(n / 2), b) }).scoringPass, false);
    t.diagnostic(`23-1 ${n} 帧：最像首帧的是 ${reading.nearest}，接缝/相邻 RMS = ${ratio.toFixed(4)}`);
  }
});

test('28-1：对机械头的静态世界盒只解一次，288 个不同机位逐一投影；移近机位或放宽余量会失分', t => {
  const q = question('28-1'), { size, frames } = q.deliverable, ctx = shot(size, frames);
  const model = subject('mech-head-proxy@1', size), { bbox } = model;
  const corners = range(8).map(mask => new THREE.Vector3(...bbox.min.map((v, i) => mask & (1 << i) ? bbox.max[i] : v)));
  const boxMesh = { meshes: [{ vertices: corners, center: corners[0] }] };
  const config = { bbox, fovYDeg: 40, elevationDeg: 5, aspect: size[0] / size[1], view: 'orbit', margin: 0.7 };
  function run(margin, distanceFactor, verifyCorners) {
    const { target, distance } = fit(ctx, params('camera.fit', { ...config, margin }), 0, 0);
    const track = poses(ctx, { target, distance: distance * distanceFactor, elevationDeg: config.elevationDeg, fovYDeg: config.fovYDeg });
    const boxes = track.map(cam => {
      if (verifyCorners) for (const [x, y] of projectMeshes(boxMesh, cam, size)[0].points) {
        assert.ok(Math.abs(2 * x / size[0] - 1) <= margin + 1e-12 && Math.abs(2 * y / size[1] - 1) <= margin + 1e-12);
      }
      return bounds(projectMeshes(model, cam, size));
    });
    const frame = f => image(projectMeshes(model, track[f], size), size);
    const readings = { 'meta.bbox-limits': readFraming(boxes, size), 'loop.closure-psnr': readClosure(frame(0), frame(frames - 1), frame(1)),
      'pixel.bbox': readPixelBoxes([0, 72, 144, 216].map(f => ({ frame: frame(f), box: boxes[f] })), '#000000', 5) };
    return { distance, readings, verdict: scoreB2(q, readings) };
  }
  const good = run(0.7, 1, true);
  assert.equal(good.verdict.score, 1, JSON.stringify(good.readings));
  for (const alt of [run(0.98, 1, false), run(0.7, 0.7, false)]) {
    assert.equal(alt.verdict.items.find(i => i.metric === 'meta.bbox-limits').pass, false);
  }
  t.diagnostic(`28-1：距离 ${good.distance.toFixed(6)} m，${JSON.stringify(good.readings['meta.bbox-limits'])}，像素框最大误差 ${good.readings['pixel.bbox'].maxDiffPx.toFixed(3)} px`);
});

test('15-2：逐帧矩阵和两对影棚校准体灰度帧过原判分器，解锁缓推会失分', t => {
  const q = question('15-2', 'level-2-b'), { size, frames } = q.deliverable, ctx = shot(size, frames);
  const model = subject('studio-balls@1', size), args = argsOf(q, 'motion.zoom-pan');
  function run(mode) {
    const p = params('camera.drift', { mode, pos: [0, 0.8, 3], pitchDeg: -8.53, pushMeters: 0.25, zoom: 1.05 });
    const cameras = range(frames).map(f => drift(ctx, p, f, 0).camera);
    const gray = f => silhouette(projectMeshes(model, cameras[f], size), size);
    const lock = readLock(args.pairs.map(pair => pair.map(gray)), size, args);
    return { matrices: readCameraStatic(cameras), pairs: lock.pairs, verdict: scoreB4(q, { 'meta.camera-static': { cameras }, 'motion.zoom-pan': lock }) };
  }
  const good = run('locked');
  assert.deepEqual(good.matrices, { frames: 300, changedAt: null }); assert.equal(good.verdict.score, 1);
  assert.deepEqual(good.pairs.map(p => [p.scale, p.dx, p.dy]), [[1, 0, 0], [1, 0, 0]]);
  const moving = run('linear'); assert.equal(moving.matrices.changedAt, 1);
  assert.deepEqual(moving.verdict.items.map(i => i.pass), [false, false]);
  t.diagnostic('15-2：300/300 帧矩阵不变，两对画面的缩放均为 1.00、平移为 0 px');
});
