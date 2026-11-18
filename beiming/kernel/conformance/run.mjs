#!/usr/bin/env node
// 最小出帧链路的一致性入口：一份片子描述（两个镜头）→ 页面宿主起无头浏览器 → three 帧源出帧 →
// 各层、元数据、预览图落盘 → 把这次运行里看到的写成核对记录 → 全部交给契约的校验器 → 对校准场景的标准答案。
// 用法：node beiming/kernel/conformance/run.mjs。产物在 out/skeleton/，每次运行先清空。
// 先写出核对记录再去对答案；对答案出错只算那一步不过，不影响记录。退出码 0 要每一道门都过，门的清单见本目录 README。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openHost, sha256, writeFrame } from '../../host/page/host.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { stream, streamName } from '../eval/rng.mjs';
import { hold } from '../eval/time.mjs';
import { centroid, classifyAverage, diffLayers, dist, expectedLayers, measurePixelOffset, readLayer } from './compare.mjs';
import { metaCheck, shotCheck, sourceCheck, timeCheck } from './records.mjs';
import { scanFiles, sourceFiles, withDirectImports } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = join(REPO, 'out/skeleton');
const FILM = join(HERE, 'fixtures/film.json');
const SCENE = join(REPO, 'beiming/calib/probe-moving-cube/scene.json');
const WANT = ['color', 'meta', 'depth', 'objectId', 'normal'];
// 判颜色层是不是线性编码时，读数和已知自发光值的相对误差上限（比值）
const LINEAR_TOL = 1e-3;
// 宿主量耗时的单调时钟：全链路只许这一处
const CLOCK = [{ path: 'beiming/host/page/clock.js', call: ['performance', 'now'].join('.') }];

const rel = (p) => relative(REPO, p).split(sep).join('/');
const pad = (f) => String(f).padStart(4, '0');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const px4 = (p) => (p ? p.map(r4) : null);
const within = (diff, tol) => diff !== null && diff <= tol;
const colorApplies = (r) => r.applies.filter((x) => x.purpose === 'color');

/** 用命名随机流打乱；打乱后和原来一样就再来，保证真的换了次序 */
function shuffled(list, s) {
  const out = [...list];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.length > 1 && out.every((v, i) => v === list[i]));
  return out;
}

const loaded = await loadContracts();
const film = await readJson(FILM);
const scene = await readJson(SCENE);
const [W, H] = film.output.size;
// 校准场景的答案：帧号是镜头局部帧号，每个镜头各自从场景的第 0 帧演起
const points = scene.expected.filter((e) => e.kind === 'projectPoint').map((e) => ({ ...e, sub: e.sampleAt === 'shutterMid' ? scene.camera.shutterAngleDeg / 720 : e.subFrameRatio }));
const FRAMES = [...new Set(points.filter((e) => e.sub === 0).map((e) => e.atFrame))].sort((x, y) => x - y);
const MOMENTS = [...new Map(points.map((e) => [`${e.atFrame}/${e.sub}`, { f: e.atFrame, sub: e.sub }])).values()].sort((x, y) => x.f - y.f || x.sub - y.sub);
const MID = points.find((e) => e.sampleAt === 'shutterMid');
const TOL_PX = MID.tolerancePx;
const cube = scene.objects.find((o) => o.shape === 'box');

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'checks'), { recursive: true });

// ---------- 出帧：每个镜头两个浏览器 ----------
let caps;
async function runShot(shot) {
  const one = { shot, renders: [], loads: [], evaluations: [], rng: [], queries: [], cardUses: [], metaKeys: [], origins: [] };
  /** 调一次 render。给了 label 就落盘到 out/skeleton/<镜头>/<label>/，没给就只把颜色层留在内存里 */
  async function render(host, run, label, f, opts, want, order) {
    const res = await host.render(f, opts, want);
    const rec = { run, label, call: res.call, f, opts, want, order, status: res.ok ? 'ok' : 'error' };
    if (!res.ok) rec.code = res.code;
    else {
      Object.assign(rec, { meta: res.meta, layers: Object.keys(res.layers) });
      if (label) {
        rec.dir = join(OUT, shot.id, label);
        rec.files = await writeFrame(rec.dir, res);
        rec.metaBytes = rec.files['meta.json'].bytes;
      } else {
        rec.metaBytes = Buffer.byteLength(`${JSON.stringify(res.meta, null, 2)}\n`);
        if (res.layers.color) rec.color = new Float32Array(new Uint8Array(Buffer.from(res.layers.color.base64, 'base64')).buffer);
      }
    }
    one.renders.push(rec);
    return rec;
  }
  /** 把页面宿主记下的每次调用（状态写了哪些时刻、交了几份元数据）并到这边的记录上 */
  const merge = (run, log) => {
    for (const o of log.renders) Object.assign(one.renders.find((r) => r.run === run && r.call === o.call), { applies: o.applies, metas: o.metas });
    return log;
  };
  const note = (log) => { one.loads.push(...log.loads); one.cardUses.push(...log.cardUses); one.metaKeys = [...new Set([...one.metaKeys, ...log.metaKeys])]; };
  const shuffle = stream(streamName(shot.seed, shot.id, 'conformance/shuffle'));
  const angle = shot.shutter.angleDeg;

  // 第一个浏览器：顺序出帧、同会话重复、各种探测
  const a = await openHost({ filmPath: FILM, shotId: shot.id, tier: 'final' });
  try {
    caps = await a.caps();
    await a.openSession();
    one.manifest = await a.manifest();
    for (const f of FRAMES) await render(a, 'a', `frames/f${pad(f)}`, f, {}, WANT, 'sequential');
    await render(a, 'a', `probes/repeat-f${pad(MID.atFrame)}`, MID.atFrame, {}, WANT, 'repeat');
    // 这次调用自己给快门：只有一个子帧采样，颜色层就是 sub 不为 0 的一个清晰时刻
    const probe = await render(a, 'a', `probes/shutter1-f${pad(MID.atFrame)}`, MID.atFrame, { shutter: { angleDeg: angle, samples: 1 } }, ['color', 'meta']);
    merge('a', await a.observations());
    // 量平均方式要用：把顺序渲的每一帧的各个子帧单独渲一遍。单采样落在哪由帧源定，这里按上面那次探测看到的比例去凑快门角
    const perDegree = colorApplies(probe)[0].sub / angle;
    for (const r of one.renders.filter((x) => x.order === 'sequential')) {
      const subs = colorApplies(r).map((x) => x.sub);
      r.singles = [];
      if (!(perDegree > 0) || subs.some((s) => s / perDegree > 360)) continue;
      for (const s of subs) r.singles.push(await render(a, 'a', null, r.f, { shutter: { angleDeg: s / perDegree, samples: 1 } }, ['color']));
    }
    await render(a, 'a', `probes/meta-only-f${pad(MID.atFrame)}`, MID.atFrame, {}, ['meta']);
    const undeclared = Object.keys(caps.outputs).find((k) => caps.outputs[k] === false);
    if (undeclared) await render(a, 'a', `probes/undeclared-output-f${pad(MID.atFrame)}`, MID.atFrame, {}, ['color', undeclared]);
    await render(a, 'a', `probes/shutter-conflict-f${pad(MID.atFrame)}`, MID.atFrame, { shutter: { angleDeg: 0, samples: 4 } }, ['color', 'meta']);
    const q = await a.query(MID.atFrame, { kind: 'bbox3d', of: [one.manifest.entities[0].name] });
    if (q.ok) throw new Error('能力声明说不答场景查询，帧源却答了');
    one.queries.push({ kind: 'bbox3d', status: 'error', code: q.code });
    await a.closeSession();
    one.origins = await a.evaluate(MOMENTS, false);
    one.evaluations.push(...one.origins.map((e) => ({ f: e.f, sub: e.sub, mode: 'sequential', digest: e.digest })));
    one.evaluations.push(...(await a.evaluate(MOMENTS, true)).map((e) => ({ f: e.f, sub: e.sub, mode: 'single', digest: e.digest })));
    one.rng.push(...(await a.rngProbe(['probe/alpha', 'probe/beta'], 16)).map((r) => ({ run: 'a', ...r })));
    note(merge('a', await a.observations()));
  } finally {
    await a.close();
  }

  // 第二个浏览器：新会话只渲一帧、再开会话乱序渲
  const b = await openHost({ filmPath: FILM, shotId: shot.id, tier: 'final' });
  try {
    await b.openSession();
    await render(b, 'b', `rerun/single-f${pad(MID.atFrame)}`, MID.atFrame, {}, WANT, 'single');
    await b.closeSession();
    await b.openSession();
    for (const f of shuffled(FRAMES, shuffle)) await render(b, 'b', `rerun/shuffled-f${pad(f)}`, f, {}, WANT, 'shuffled');
    await b.closeSession();
    one.evaluations.push(...(await b.evaluate(shuffled(MOMENTS, shuffle), false)).map((e) => ({ f: e.f, sub: e.sub, mode: 'shuffled', digest: e.digest })));
    // 换一个取用次序，再多开一条流：同名的流必须还是同样的序列
    one.rng.push(...(await b.rngProbe(['probe/beta', 'probe/extra', 'probe/alpha'], 16)).map((r) => ({ run: 'b', ...r })));
    note(merge('b', await b.observations()));
  } finally {
    await b.close();
  }
  return one;
}
const shots = [];
for (const shot of film.shots) shots.push(await runShot(shot));

// ---------- 量：这些读数要进核对记录。量不出来就不写那一段，对应的门算不过 ----------
const problems = [];
const attempt = (what, fn) => { try { return fn(); } catch (e) { problems.push(`${what}：${e.message}`); return undefined; } };
const integrity = [], averages = [], linearity = [], offsets = [];
const diffs = new Map(); // 编号层、深度层对逐像素求交的结果，同一张编号层只算一次，对答案时接着用
const auxKey = (r) => `${r.f}/${r.files['objectId.u32'].sha256}/${r.files['depth.f32'].sha256}`;
for (const one of shots) {
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  const done = one.renders.filter((r) => r.status === 'ok');
  // 每次调用交回的颜色层的哈希：落了盘的从盘上读回来算
  for (const r of done) if (r.layers.includes('color')) r.colorSha = sha256(r.dir ? await readFile(join(r.dir, 'color.f32')) : Buffer.from(r.color.buffer));
  // 颜色层出自哪次调用：元数据里的哈希是页面里对帧源交给宿主的那份颜色算的，拿它去找这次运行里哪次调用交回的颜色层是这个哈希。
  // 同一帧原样渲了两遍时两次的哈希相同，分不出，算自己那次
  for (const r of done.filter((x) => x.meta.hash.color)) {
    const from = done.filter((x) => x.run === r.run && `sha256:${x.colorSha}` === r.meta.hash.color);
    if (from.length) r.colorCall = from.some((x) => x.call === r.call) ? r.call : from[0].call;
    integrity.push({ shot: one.shot.id, label: r.label ?? `call ${r.call}`, ok: from.some((x) => x.call === r.call) });
  }
  for (const r of done.filter((x) => x.order === 'sequential')) {
    // 平均方式：各个子帧单独渲的结果自己算两种平均，看帧源交回的累积结果对得上哪一种
    const subs = colorApplies(r).map((x) => x.sub), got = r.singles.map((x) => (x.status === 'ok' ? colorApplies(x).map((y) => y.sub) : []));
    const same = got.length === subs.length && got.every((g, i) => g.length === 1 && Math.abs(g[0] - subs[i]) <= 1e-9);
    const c = same ? attempt(`${one.shot.id} 第 ${r.f} 帧判平均方式`, () => classifyAverage(readLayer(join(r.dir, 'color.f32'), 'f32'), r.singles.map((x) => x.color))) : undefined;
    if (c?.average) r.average = c.average;
    averages.push({ shot: one.shot.id, frame: r.f, subFrames: subs.length, renderedAlone: same, ...(c ?? { average: null }) });
    for (const x of r.singles) delete x.color;
  }
  // 颜色层是不是线性编码：两个已知的自发光量级，读数和规格成不成比例。
  // 方块取它在编号层里占的像素的中位数；高光球被拖影抹开，取它占的像素里的最大值（被全部子帧盖住的像素）
  const brightest = Math.max(...scene.objects.map((o) => o.emissionLinear[0]));
  const byId = new Map();
  for (const r of done.filter((x) => x.dir && x.layers.includes('color') && x.layers.includes('objectId'))) {
    const id = readLayer(join(r.dir, 'objectId.u32'), 'u32'), color = readLayer(join(r.dir, 'color.f32'), 'f32');
    const readings = scene.objects.map((o) => {
      const v = [];
      for (let i = 0; i < id.length; i++) if (id[i] === ids[o.id]) v.push(color[i * 4]);
      v.sort((x, y) => x - y);
      const reading = o.emissionLinear[0] === brightest ? v.at(-1) : v[v.length >> 1];
      return { object: o.id, want: o.emissionLinear[0], got: reading ?? null, relErr: reading === undefined ? null : Math.abs(reading / o.emissionLinear[0] - 1) };
    });
    // 哪个物体在编号层里一个像素都没有，就量不了，不写
    if (readings.every((x) => x.relErr !== null)) r.colorTransfer = readings.every((x) => x.relErr <= LINEAR_TOL) ? 'linear' : 'encoded';
    if (r.order === 'sequential') linearity.push({ shot: one.shot.id, frame: r.f, readings, verdict: r.colorTransfer ?? null });
    // 辅助层取的是像素里的哪个位置：同一张编号层只量一次
    if (!r.layers.includes('depth')) continue;
    const key = `${one.shot.id}/${auxKey(r)}`;
    if (!byId.has(key)) {
      byId.set(key, attempt(`${one.shot.id} 第 ${r.f} 帧量像素内位置`, () => {
        const d = diffLayers({ id, depth: readLayer(join(r.dir, 'depth.f32'), 'f32') }, scene, r.f, ids);
        diffs.set(key, d);
        return measurePixelOffset(id, scene, r.f, ids, d.edgeLimit);
      }) ?? null);
    }
    if (byId.get(key)) r.pixelOffset = byId.get(key);
    if (r.order === 'sequential') offsets.push({ shot: one.shot.id, frame: r.f, pixelOffset: byId.get(key) });
  }
}

// ---------- 静态扫描 ----------
const shotFiles = [...new Set(film.shots.flatMap((s) => withDirectImports(REPO, rel(join(dirname(FILM), s.entry)))))];
const scans = {
  path: scanFiles(REPO, [...sourceFiles(REPO, ['beiming/kernel/eval', 'beiming/sources/three', 'beiming/host/page']), ...shotFiles], CLOCK),
  shot: scanFiles(REPO, shotFiles),
};

// ---------- 核对记录：先写出来，再交给校验器 ----------
const holds = [];
for (let f = 0; f < 8; f++) for (let n = 1; n <= 3; n++) holds.push({ f, n, result: hold(f, n) });
const obs = { film, caps, holds, scans, shots };
const records = { 'time-check': timeCheck(obs) };
for (const one of shots) {
  records[`${one.shot.id}.shot-check`] = shotCheck(obs, one);
  records[`${one.shot.id}.source-check`] = sourceCheck(obs, one);
  records[`${one.shot.id}.meta-check`] = metaCheck(one, 'a');
}
for (const [name, rec] of Object.entries(records)) await writeFile(join(OUT, 'checks', `${name}.json`), `${JSON.stringify(rec, null, 2)}\n`);

const judge = (name, obj) => {
  const v = loaded.validate(obj);
  return { name, format: obj.format, ok: v.schemaErrors.length === 0 && Object.keys(v.violations).length === 0, schemaErrors: v.schemaErrors, violations: v.violations };
};
const all = shots.flatMap((one) => one.renders.map((r) => ({ ...r, shot: one.shot })));
const objects = [
  judge(rel(FILM), film),
  judge('caps()', caps),
  ...all.filter((r) => r.meta && r.dir).map((r) => judge(`${rel(r.dir).replace('out/skeleton/', '')}/meta.json`, r.meta)),
  ...Object.entries(records).map(([name, rec]) => judge(`checks/${name}.json`, rec)),
];
const unwritten = all.filter((r) => r.meta && !r.dir).map((r) => judge(`${r.shot.id} call ${r.call}`, r.meta));

// ---------- 两个浏览器、几种渲法：同一帧的每一层逐位相同吗，元数据去掉 timing 之后相同吗 ----------
const determinism = shots.flatMap((one) => FRAMES.flatMap((f) => {
  const runs = one.renders.filter((r) => r.order && r.f === f);
  const layers = WANT.filter((n) => n !== 'meta').map((layer) => {
    const got = runs.map((r) => ({ run: r.run, order: r.order, sha256: Object.values(r.files).find((x) => x.layer === layer).sha256 }));
    return { shot: one.shot.id, frame: f, layer, same: new Set(got.map((x) => x.sha256)).size === 1, browsers: new Set(got.map((x) => x.run)).size, runs: got };
  });
  return [...layers, { shot: one.shot.id, frame: f, layer: 'meta', same: new Set(runs.map((r) => JSON.stringify({ ...r.meta, timing: null }))).size === 1, browsers: new Set(runs.map((r) => r.run)).size }];
}));

// ---------- 对校准场景的标准答案 ----------
const answer = (f, sub, sampleAt) => points.find((e) => e.objectId === cube.id && e.atFrame === f && e.sub === sub && e.sampleAt === sampleAt);
const depthTol = scene.expected.find((x) => x.kind === 'pixelHits').toleranceRatio;
function calibrate(one) {
  const out = { shot: one.shot.id, idLayer: [], trail: [], probe: [], state: [], pixelHits: [], normal: [] };
  // 编号经实体清单按名字查
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  for (const o of scene.objects) if (!ids[o.id]) throw new Error(`实体清单里没有规格里的物体 ${o.id}`);
  const emission = Object.fromEntries(scene.objects.map((o) => [ids[o.id], o.emissionLinear[0]]));
  for (const r of one.renders.filter((x) => x.order === 'sequential')) {
    const got = { id: readLayer(join(r.dir, 'objectId.u32'), 'u32'), depth: readLayer(join(r.dir, 'depth.f32'), 'f32') };
    const { want, ...d } = diffs.get(`${one.shot.id}/${auxKey(r)}`) ?? diffLayers(got, scene, r.f, ids);
    const c = centroid(W, H, (i) => got.id[i] === ids[cube.id]), cw = centroid(W, H, (i) => want.id[i] === ids[cube.id]);
    const e = answer(r.f, 0);
    out.idLayer.push({ frame: r.f, pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)), ...d, projectPointPx: e.pixelPx, vsProjectPointPx: r4(dist(c.px, e.pixelPx)) });
    // 真正累积出来的颜色层：拖影按线性亮度加权的重心，对「快门中点那一刻的画面」按自发光值加权的重心
    const color = readLayer(join(r.dir, 'color.f32'), 'f32'), mid = expectedLayers(scene, r.f + MID.sub, ids).id;
    const t = centroid(W, H, (i) => Math.max(0, color[i * 4])), tw = centroid(W, H, (i) => emission[mid[i]] ?? 0);
    out.trail.push({ frame: r.f, midSub: MID.sub, samples: colorApplies(r).length, centroidPx: px4(t.px), expectedPx: px4(tw.px), diffPx: r4(dist(t.px, tw.px)) });
    // 规格点名的像素：最先打到谁、平面深度多少
    for (const h of scene.expected.filter((x) => x.kind === 'pixelHits' && x.atFrame === r.f)) {
      const i = Math.floor(h.pixelPx[1]) * W + Math.floor(h.pixelPx[0]);
      out.pixelHits.push({ frame: r.f, pixelPx: h.pixelPx, wantId: ids[h.hits[0].objectId], gotId: got.id[i], wantDepthM: h.hits[0].planeDepthM, gotDepthM: got.depth[i], toleranceRatio: h.toleranceRatio });
    }
    // 方块正面正对相机：重心那个像素的法线应该是 (0, 0, 1)
    if (c.px) {
      const n = readLayer(join(r.dir, 'normal.f32'), 'f32'), at = (Math.floor(c.px[1]) * W + Math.floor(c.px[0])) * 3;
      out.normal.push({ frame: r.f, pixelPx: c.px.map(Math.floor), got: [n[at], n[at + 1], n[at + 2]].map(r4), want: [0, 0, 1] });
    }
  }
  {
    // sub 不为 0 的一个清晰时刻：单子帧采样的颜色层里方块的重心，对快门中点的答案。采样没落在答案的时刻就算不过，不换别的比法
    const r = one.renders.find((x) => x.label?.startsWith('probes/shutter1'));
    const sub = colorApplies(r)[0].sub, onAnswer = Math.abs(sub - MID.sub) <= 1e-9;
    const row = { frame: r.f, sampleSub: sub, answerSub: MID.sub, onAnswer };
    if (onAnswer) {
      const color = readLayer(join(r.dir, 'color.f32'), 'f32'), level = cube.emissionLinear[0];
      const want = expectedLayers(scene, r.f + sub, ids).id;
      const c = centroid(W, H, (i) => Math.abs(color[i * 4] - level) <= level * 0.01), cw = centroid(W, H, (i) => want[i] === ids[cube.id]);
      Object.assign(row, { pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)), projectPointPx: MID.pixelPx, vsProjectPointPx: r4(dist(c.px, MID.pixelPx)) });
    }
    out.probe.push(row);
  }
  // 状态本身：每个答案时刻把实体原点用相机矩阵投到屏幕上（没经过光栅化）
  for (const e of points) {
    const got = one.origins.find((o) => o.f === e.atFrame && o.sub === e.sub)?.origins[e.objectId] ?? null;
    out.state.push({ object: e.objectId, frame: e.atFrame, sub: e.sub, wantPx: e.pixelPx, gotPx: px4(got), diffPx: r4(dist(got, e.pixelPx)) });
  }
  return out;
}
const calibration = shots.map((one) => attempt(`${one.shot.id} 对答案`, () => calibrate(one))).filter(Boolean);
const cal = (key) => calibration.flatMap((c) => c[key]);

// ---------- 结论 ----------
const sampleCounts = all.filter((r) => r.status === 'ok' && r.layers.includes('color')).map((r) => ({ shot: r.shot.id, label: r.label ?? `call ${r.call}`, want: r.opts.shutter?.samples ?? r.shot.shutter.samples, got: colorApplies(r).length }));
const metas = all.filter((r) => r.meta);
const gates = {
  'objects valid': objects.every((o) => o.ok) && unwritten.every((o) => o.ok),
  'layers and meta identical across browsers and orders': determinism.every((d) => d.same && d.browsers === 2),
  'meta frame and sub are the state that was measured': metas.every((r) => r.meta.shotFrame === r.f && r.meta.frame === r.f + r.shot.in && r.meta.sub === r.applies.at(-1).sub),
  'color layer returned by each call matches its meta hash': integrity.every((x) => x.ok),
  'sub-frame sample count as requested': sampleCounts.every((x) => x.want === x.got),
  'accumulation average measured on every delivered frame': averages.every((x) => x.average),
  'aux pixel offset measured on at least one delivered frame per shot': shots.every((one) => offsets.some((x) => x.shot === one.shot.id && x.pixelOffset)),
  'no error while measuring or comparing': problems.length === 0 && calibration.length === shots.length,
  'id layer vs per-pixel raycast: centroid within tolerance, mismatches only on sub-pixel edges': cal('idLayer').every((x) => within(x.vsRaycastPx, TOL_PX) && x.offEdge === 0),
  'depth layer within calibration tolerance of raycast': cal('idLayer').every((x) => x.depthMaxRatio <= depthTol),
  'accumulated trail centroid at shutter midpoint': cal('trail').every((x) => within(x.diffPx, TOL_PX)),
  'single-sample probe lands on the answer moment and matches it': cal('probe').every((x) => x.onAnswer && within(x.vsRaycastPx, TOL_PX)),
  'state projects onto expected pixels': cal('state').every((x) => within(x.diffPx, TOL_PX)),
  'named pixels hit expected object at expected depth': cal('pixelHits').every((x) => x.gotId === x.wantId && Math.abs(x.gotDepthM / x.wantDepthM - 1) <= x.toleranceRatio),
};
// 另一种比法：编号层重心直接对「方块中心的投影」。方块不在画面中间时侧面会露出来把重心拉偏，所以单列，不进退出码
const literal = calibration.flatMap((c) => [...c.idLayer, ...c.probe.filter((x) => x.onAnswer)].map((x) => ({ shot: c.shot, frame: x.frame, sub: x.sampleSub ?? 0, vsProjectPointPx: x.vsProjectPointPx, within: within(x.vsProjectPointPx, TOL_PX) })));
const hashes = Object.fromEntries(all.filter((r) => r.files).flatMap((r) => Object.entries(r.files).filter(([, x]) => x.layer).map(([file, x]) => [`${r.shot.id}/${r.label}/${file}`, x.sha256])));
const summary = {
  ok: Object.values(gates).every(Boolean),
  gates, problems, objects, unwrittenMetas: unwritten, determinism, integrity, sampleCounts, averages, auxPixelOffsets: offsets,
  linearity: { tolerance: LINEAR_TOL, frames: linearity },
  tolerances: { centroidPx: TOL_PX, depthRatio: depthTol },
  calibration, centroidVsProjectPoint: literal,
  scan: { files: scans.path.files, wallClock: scans.path.wallClock, unseededRandom: scans.path.unseededRandom, allowedClock: scans.path.allowed },
  machine: { gpu: metas[0]?.meta.source.gpu, platform: process.platform },
  hashes,
};
await writeFile(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const mark = (v) => (v ? '✓' : '✗');
for (const o of [...objects, ...unwritten.filter((x) => !x.ok)]) {
  console.log(`${mark(o.ok)} ${o.format}  ${o.name}：${o.ok ? '结构合法，违反 0 条' : [...o.schemaErrors, ...Object.entries(o.violations).map(([id, p]) => `${id}：${p[0]}`)].join('；')}`);
}
console.log(`  没落盘的元数据 ${unwritten.length} 份（各子帧单独渲的那些），${unwritten.filter((x) => x.ok).length} 份结构合法、违反 0 条`);
for (const c of calibration) {
  for (const x of c.idLayer) console.log(`  ${c.shot} 第 ${x.frame} 帧 编号层：方块 ${x.pixels} 像素；对逐像素求交 重心差 ${x.vsRaycastPx} 像素、编号不同 ${x.idMismatch} 个（上限 ${x.edgeLimit}，不在边上的 ${x.offEdge} 个）、深度最大差 ${x.depthMaxDiff.toExponential(2)} 米`);
  for (const x of c.trail) console.log(`  ${c.shot} 第 ${x.frame} 帧 ${x.samples} 个子帧累积的颜色层：拖影重心 (${x.centroidPx})，快门中点的期望 (${x.expectedPx})，差 ${x.diffPx} 像素`);
  for (const x of c.probe) console.log(`  ${c.shot} 第 ${x.frame} 帧 单子帧采样落在 sub ${x.sampleSub}（答案时刻 ${x.answerSub}）${x.onAnswer ? `：方块 ${x.pixels} 像素，对逐像素求交差 ${x.vsRaycastPx} 像素` : '：没落在答案时刻，不比'}`);
  console.log(`  ${c.shot} 状态投影 ${c.state.length} 条，最大差 ${Math.max(...c.state.map((x) => x.diffPx ?? Infinity))} 像素`);
}
for (const x of averages) console.log(`  ${x.shot} 第 ${x.frame} 帧 平均方式：${x.average ?? '量不出'}（${x.subFrames} 个子帧${x.renderedAlone ? '都单独渲到了' : '没能单独渲到同一批时刻'}；分得出两种平均的数 ${x.distinguishing ?? 0} 个，对线性平均最大差 ${(x.maxErrLinear ?? NaN).toExponential(2)}，对编码值平均最大差 ${(x.maxErrEncoded ?? NaN).toExponential(2)}）`);
for (const x of offsets) console.log(`  ${x.shot} 第 ${x.frame} 帧 辅助层的像素内位置：${x.pixelOffset ? `(${x.pixelOffset})` : '这一帧分不出，不写'}`);
for (const p of problems) console.log(`  出错：${p}`);
for (const [name, v] of Object.entries(gates)) console.log(`${mark(v)} ${name}`);
console.log(`${mark(literal.length > 0 && literal.every((x) => x.within))} centroid vs projected center within tolerance（不进退出码）：${literal.map((x) => `${x.shot} f${x.frame}+${x.sub} ${x.vsProjectPointPx}`).join('，')}`);
console.log(`产物在 ${rel(OUT)}/：${Object.keys(hashes).length} 个层文件，${objects.filter((o) => o.format === 'meta/0.1').length} 份落盘的元数据，${Object.keys(records).length} 份核对记录，summary.json`);
process.exit(summary.ok ? 0 : 1);
