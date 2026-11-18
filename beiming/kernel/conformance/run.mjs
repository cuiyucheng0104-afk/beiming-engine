#!/usr/bin/env node
// 最小出帧链路的一致性入口：一份片子描述（三个镜头）→ 求值核算出镜头输入 → three 帧源（页面宿主起无头浏览器）出帧、落层文件 →
// 把这次运行里看到的写成核对记录 → 全部交给契约的校验器 → 对校准场景的标准答案。
// 用法：node beiming/kernel/conformance/run.mjs。产物在 out/skeleton/，每次运行先清空。
// 只经帧源接口（caps、open、manifest、render、query、close）取东西；帧源里面发生了什么，靠夹具里的观测点和读回的像素看。
// 先写出核对记录再去对答案；对答案出错只算那一步不过，不影响记录。退出码 0 要每一道门都过，门的清单见本目录 README。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSource } from '../../host/page/host.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { shotInput } from '../eval/input.mjs';
import { stream, streamName } from '../eval/rng.mjs';
import { hold } from '../eval/time.mjs';
import { centroid, classifyAverage, diffLayers, dist, expectedLayers, measurePixelOffset, readLayer } from './compare.mjs';
import { readObservation } from './fixtures/observe.js';
import { effectiveShutter, metaCheck, shotCheck, sourceCheck, timeCheck } from './records.mjs';
import { scanFiles, sourceFiles, withDirectImports } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = join(REPO, 'out/skeleton');
const FIXTURES = join(HERE, 'fixtures');
const WANT = ['color', 'meta', 'depth', 'objectId', 'normal'];
const AUX = ['depth', 'objectId', 'normal'];
// 辅助样本什么都没打到时深度层该写的数，米
const NO_HIT_DEPTH = 1e10;
// 宿主量耗时的单调时钟：全链路只许这一处
const CLOCK = [{ path: 'beiming/host/page/clock.js', call: ['performance', 'now'].join('.') }];
const LANGUAGES = { '.js': 'js', '.mjs': 'js', '.py': 'python' };

const rel = (p) => relative(REPO, p).split(sep).join('/');
const pad = (n, width) => String(n).padStart(width, '0');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const px4 = (p) => (p ? p.map(r4) : null);
const within = (diff, tol) => diff !== null && diff <= tol;
const ok = (one) => one.renders.filter((r) => r.status === 'ok');
/** 观测点看到的：这次调用里场景停在哪些时刻被画过颜色 */
const colorSubs = (r) => (r.seen?.states ?? []).filter((s) => s.color > 0).map((s) => s.sub);

/** 用命名随机流打乱；打乱后和原来一样就再来，保证真的换了次序 */
function shuffled(list, s) {
  const out = [...list];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.length > 1 && out.every((v, i) => v === list[i]));
  return out;
}

const loaded = await loadContracts();
const film = await readJson(join(FIXTURES, 'film.json'));
const lock = await readJson(join(FIXTURES, 'lock.json'));
const [W, H] = film.output.size;
const problems = [];
const attempt = (what, fn) => { try { return fn(); } catch (e) { problems.push(`${what}：${e.message}`); return undefined; } };

/** 这个镜头对的是哪个校准场景（入口文件名去掉 .shot.js 就是校准目录里的 probe-<名字>），以及从它的答案里读出的要渲哪些帧、对哪些时刻 */
async function planOf(shot) {
  const scene = await readJson(join(REPO, 'beiming/calib', `probe-${shot.entry.replace('.shot.js', '')}`, 'scene.json'));
  const points = scene.expected.filter((e) => e.kind === 'projectPoint').map((e) => ({ ...e, sub: e.sampleAt === 'shutterMid' ? scene.camera.shutterAngleDeg / 720 : e.subFrameRatio }));
  const mid = points.find((e) => e.sampleAt === 'shutterMid');
  // 单独一个子帧采样落在「快门角 ÷ 720」，所以相位到了 0.5 的时刻从帧源接口要不到，不排进去
  const moments = [...new Map(points.filter((e) => e.sub < 0.5).map((e) => [`${e.atFrame}/${e.sub}`, { f: e.atFrame, sub: e.sub }])).values()].sort((x, y) => x.f - y.f || x.sub - y.sub);
  return {
    scene, mid, moments,
    frames: [...new Set(points.filter((e) => e.sub === 0).map((e) => e.atFrame))].sort((x, y) => x - y),
    main: scene.objects.find((o) => o.id === mid.objectId),
    tolPx: mid.tolerancePx,
    depthTol: scene.expected.find((x) => x.kind === 'pixelHits').toleranceRatio,
  };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'checks'), { recursive: true });

// ---------- 出帧：每个镜头两个帧源进程（两个浏览器） ----------
let caps;
async function runShot(shot) {
  const plan = await planOf(shot), input = shotInput(film, shot.id);
  const files = withDirectImports(REPO, rel(join(FIXTURES, shot.entry)));
  const one = { shot, plan, input, files, languages: [...new Set(files.map((f) => LANGUAGES[extname(f)]).filter(Boolean))], renders: [], opens: [], evaluations: [], queries: [], rng: [], manifest: null };
  const midF = plan.mid.atFrame, frames = shot.out - shot.in;
  const shuffle = stream(streamName(shot.seed, shot.id, 'conformance/shuffle'));
  const patched = (patch) => ({ ...input, shot: { ...structuredClone(input.shot), ...patch } });

  /** 调一次 open。expect 给了错误码就是故意造的装不了的输入；成功时交回会话和它的产物目录 out/skeleton/<镜头>/<label>/ */
  async function open(source, label, { inp = input, withLock = false, expect } = {}) {
    const rec = {
      plain: inp === input, hasLock: withLock, hasSeed: Number.isInteger(inp.shot.seed),
      usesCards: (inp.shot.cards ?? []).length > 0, usesAssets: Object.keys(inp.shot.assets ?? {}).length > 0, host: inp.shot.host, mode: inp.shot.mode,
    };
    one.opens.push(rec);
    Object.defineProperty(rec, 'expect', { value: expect }); // 不进记录，只给「报的错对不对」那道门用
    const workspace = join(OUT, shot.id, label);
    try {
      const session = await source.open(inp, { lock: withLock ? lock : null, tier: 'final', workspace, filmDir: FIXTURES });
      rec.status = 'ok';
      return { session, workspace, label, locked: withLock };
    } catch (e) {
      if (!e.code) throw e;
      Object.assign(rec, { status: 'error', code: e.code });
      return null;
    }
  }

  /** 调一次 render。more 里是这次调用的标记：order（按哪种次序渲的）、expect（故意造的错）、unsupportedOpts、unfitOutputs…… */
  async function render(s, f, opts, want, more = {}) {
    const rec = { call: one.renders.length, session: s.label, locked: s.locked, f, opts, want, unsupportedOpts: [], unfitOutputs: [], ...more };
    one.renders.push(rec);
    try {
      const res = await s.session.render(f, opts, want);
      rec.status = 'ok';
      rec.layers = Object.keys(res.layers);
      rec.refs = res.layers;
      // 层文件的哈希自己读文件重算，不抄层引用里写的
      rec.layerRefs = [];
      for (const [output, ref] of Object.entries(res.layers)) rec.layerRefs.push({ output, shape: ref.shape, sha256: ref.sha256, fileSha256: `sha256:${hex(await readFile(join(s.workspace, ref.file)))}` });
      rec.metas = Array.isArray(res.meta) ? res.meta.length : res.meta ? 1 : 0;
      if (rec.metas === 1) {
        const text = `${JSON.stringify(res.meta, null, 2)}\n`;
        Object.assign(rec, { meta: res.meta, metaBytes: Buffer.byteLength(text), seen: readObservation(res.meta.readings) });
        rec.dir = join(s.workspace, res.layers.color ? dirname(res.layers.color.file) : `meta-only-c${pad(rec.call, 3)}`);
        await mkdir(rec.dir, { recursive: true });
        await writeFile(join(rec.dir, 'meta.json'), text);
      }
    } catch (e) {
      if (!e.code) throw e;
      Object.assign(rec, { status: 'error', code: e.code });
      // 报错的那次调用可能已经写过几次状态，观测点还攒着；只要元数据渲一次把它们清掉，不然会算到下一次调用头上
      await s.session.render(midF, {}, ['meta']);
    }
    return rec;
  }

  /** 纯函数门：对一批时刻各求一次状态。从帧源接口要一个时刻的办法是只取一个子帧采样，它落在「快门角 ÷ 720」；状态摘要取那张颜色层的哈希 */
  async function evaluate(s, moments, mode) {
    for (const m of moments) {
      const r = await render(s, m.f, { shutter: { angleDeg: m.sub * 720, samples: 1 } }, ['color', 'meta'], { moment: m });
      const at = (r.seen?.states ?? []).filter((x) => x.color > 0);
      // 观测点看到的时刻必须就是要的那一个，不然这张图不是这个时刻的状态，不记
      r.landed = r.status === 'ok' && at.length === 1 && at[0].f === m.f && at[0].sub === m.sub;
      if (r.landed) one.evaluations.push({ f: m.f, sub: m.sub, mode, digest: r.layerRefs.find((x) => x.output === 'color').fileSha256.replace('sha256:', '') });
    }
  }

  // 第一个帧源进程：装不了的输入、顺序出帧、同会话重复、各种探测、带锁文件装一次
  const a = await startSource();
  try {
    caps = a.caps();
    const noSeed = structuredClone(input);
    delete noSeed.shot.seed;
    const rejected = [
      [noSeed, 'env.lock-required'],
      [patched({ cards: [{ card: 'probe.card@1', as: 'probe' }] }), 'env.lock-required'],
      [patched({ assets: { probe: 'asset:probe@1' } }), 'env.lock-required'],
      [patched({ mode: 'cards-data' }), 'contract.unsupported-mode'],
      [patched({ host: 'offscreen' }), 'contract.unsupported-mode'],
    ];
    for (const [inp, expect] of rejected) await (await open(a, 'a-rejected', { inp, expect }))?.session.close();

    const seq = await open(a, 'a-sequential');
    one.manifest = seq.session.manifest();
    for (const f of plan.frames) await render(seq, f, {}, WANT, { order: 'sequential' });
    await render(seq, midF, {}, WANT, { order: 'repeat' });
    // 这次调用自己给快门：只有一个子帧采样，颜色层就是 sub 不为 0 的一个清晰时刻
    await render(seq, midF, { shutter: { angleDeg: shot.shutter.angleDeg, samples: 1 } }, ['color', 'meta'], { probe: 'single-sample' });
    // 量平均方式要用：把顺序渲的每一帧的各个子帧单独渲一遍
    for (const r of one.renders.filter((x) => x.order === 'sequential')) {
      r.singles = [];
      for (const sub of colorSubs(r)) r.singles.push(await render(seq, r.f, { shutter: { angleDeg: sub * 720, samples: 1 } }, ['color', 'meta'], { singleOf: r.call }));
    }
    await render(seq, midF, {}, ['meta']);
    await render(seq, midF, {}, ['color', 'motion'], { expect: 'contract.unsupported-output' });
    await render(seq, midF, { shutter: { angleDeg: 0, samples: 4 } }, ['color', 'meta'], { expect: 'contract.shutter-conflict' });
    await render(seq, midF, { samples: 2 }, ['color', 'meta'], { expect: 'contract.unsupported-option', unsupportedOpts: ['samples'] });
    await render(seq, frames, {}, ['meta'], { expect: 'usage.bad-argument' });
    try {
      const res = await seq.session.query(midF, { kind: 'bbox3d', of: [one.manifest.entities[0].name] });
      one.queries.push({ kind: 'bbox3d', status: 'ok', total: res.items.length, returned: res.items.length });
    } catch (e) {
      if (!e.code) throw e;
      one.queries.push({ kind: 'bbox3d', status: 'error', code: e.code });
    }
    await evaluate(seq, plan.moments, 'sequential');
    await seq.session.close();
    for (const [i, m] of plan.moments.entries()) {
      const s = await open(a, `a-moment-${i}`);
      await evaluate(s, [m], 'single');
      await s.session.close();
    }
    const locked = await open(a, 'a-locked', { withLock: true });
    await render(locked, midF, {}, WANT, { probe: 'locked' });
    await locked.session.close();
    // 场景里多一条线：辅助层画不了它，要辅助层必须报错；不要辅助层照常出
    const odd = await open(a, 'a-stranger', { inp: patched({ params: { ...input.shot.params, stranger: 'line' } }) });
    await render(odd, midF, {}, ['color', 'objectId'], { expect: 'contract.unsupported-object', unfitOutputs: AUX });
    await render(odd, midF, {}, ['color', 'meta'], { unfitOutputs: AUX });
    await odd.session.close();
  } finally {
    await a.stop();
  }

  // 第二个帧源进程：新会话只渲一帧、再开会话乱序渲
  const b = await startSource();
  try {
    const single = await open(b, 'b-single');
    await render(single, midF, {}, WANT, { order: 'single' });
    await single.session.close();
    const mixed = await open(b, 'b-shuffled');
    for (const f of shuffled(plan.frames, shuffle)) await render(mixed, f, {}, WANT, { order: 'shuffled' });
    await evaluate(mixed, shuffled(plan.moments, shuffle), 'shuffled');
    await mixed.session.close();
  } finally {
    await b.stop();
  }
  return one;
}
const shots = [];
for (const shot of film.shots) shots.push(await runShot(shot));

// ---------- 量：这些读数要进核对记录。量不出来就不写那一段，对应的门算不过 ----------
const layerOf = (one, r, name) => readLayer(join(OUT, one.shot.id, r.session, r.refs[name].file), caps.outputs[name].type);
const shaOf = (r, name) => r.layerRefs.find((x) => x.output === name)?.fileSha256;
const averages = [], offsets = [], streams = [];
const diffs = new Map(); // 编号层、深度层对逐像素求交的结果，同一张编号层只算一次，对答案时接着用
const auxKey = (one, r) => `${one.shot.id}/${r.f}/${shaOf(r, 'objectId')}/${shaOf(r, 'depth')}`;
for (const one of shots) {
  const { scene } = one.plan;
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  for (const r of ok(one).filter((x) => x.order === 'sequential')) {
    // 平均方式：各个子帧单独渲的结果自己算两种平均，看帧源交回的累积结果对得上哪一种。单独渲的那几次必须正好落在同一批时刻上
    const subs = colorSubs(r), got = r.singles.map((x) => (x.status === 'ok' ? colorSubs(x) : []));
    const same = subs.length > 0 && got.length === subs.length && got.every((g, i) => g.length === 1 && g[0] === subs[i]);
    const c = same ? attempt(`${one.shot.id} 第 ${r.f} 帧判平均方式`, () => classifyAverage(layerOf(one, r, 'color'), r.singles.map((x) => layerOf(one, x, 'color')))) : undefined;
    if (c?.average) r.average = c.average;
    averages.push({ shot: one.shot.id, frame: r.f, subFrames: subs.length, renderedAlone: same, ...(c ?? { average: null }) });
    // 单独渲的那些颜色层用完就删，不留在产物里
    for (const x of r.singles.filter((y) => y.status === 'ok')) { await rm(x.dir, { recursive: true }); x.removed = true; }
  }
  // 辅助层取的是像素里的哪个位置：同一张编号层只量一次
  const measured = new Map();
  for (const r of ok(one).filter((x) => AUX.every((n) => x.layers.includes(n)))) {
    const key = auxKey(one, r);
    if (!measured.has(key)) {
      measured.set(key, attempt(`${one.shot.id} 第 ${r.f} 帧量像素内位置`, () => {
        const id = layerOf(one, r, 'objectId');
        const d = diffLayers({ id, depth: layerOf(one, r, 'depth') }, scene, r.f, ids);
        diffs.set(key, d);
        return measurePixelOffset(id, scene, r.f, ids);
      }) ?? null);
    }
    if (measured.get(key)) r.pixelOffset = measured.get(key);
    if (r.order === 'sequential') offsets.push({ shot: one.shot.id, frame: r.f, pixelOffset: measured.get(key) });
  }
  // 命名随机流：观测点两轮取数，各条流的名字对不对由它当场比，取到的数交出来由这里算摘要、对参考序列
  for (const x of ok(one).find((r) => r.seen)?.seen.rng ?? []) {
    const name = streamName(one.shot.seed, one.shot.id, x.arg), ref = stream(name);
    const row = { shot: one.shot.id, run: x.run, arg: x.arg, nameAsExpected: x.nameOk, matchesReference: x.values.every((v) => v === ref.u32()) };
    streams.push(row);
    // 名字是帧源里的宿主展开的，这里只在观测点确认过它等于期望的名字时才写进记录
    if (x.nameOk) one.rng.push({ run: x.run, arg: x.arg, name, digest: hex(Buffer.from(Uint32Array.from(x.values).buffer)) });
  }
}

// ---------- 静态扫描 ----------
const shotFiles = [...new Set(shots.flatMap((one) => one.files))];
const scans = {
  path: scanFiles(REPO, [...sourceFiles(REPO, ['beiming/kernel/eval', 'beiming/sources/three', 'beiming/host/page']), ...shotFiles], CLOCK),
  shot: scanFiles(REPO, shotFiles),
};

// ---------- 核对记录：先写出来，再交给校验器 ----------
const holds = [];
for (let f = 0; f < 8; f++) for (let n = 1; n <= 3; n++) holds.push({ f, n, result: hold(f, n) });
const obs = { film, caps, lock, holds, scans, shots };
const records = { 'time-check': timeCheck(obs) };
for (const one of shots) {
  records[`${one.shot.id}.shot-check`] = shotCheck(obs, one);
  records[`${one.shot.id}.source-check`] = sourceCheck(obs, one);
  records[`${one.shot.id}.meta-check`] = metaCheck(one);
}
for (const [name, rec] of Object.entries(records)) await writeFile(join(OUT, 'checks', `${name}.json`), `${JSON.stringify(rec, null, 2)}\n`);

const judge = (name, obj, schema) => {
  const v = loaded.validate(obj, 'source', schema);
  return { name, format: obj.format ?? schema, ok: v.schemaErrors.length === 0 && Object.keys(v.violations).length === 0, schemaErrors: v.schemaErrors, violations: v.violations };
};
const all = shots.flatMap((one) => one.renders.map((r) => ({ ...r, shot: one.shot })));
const metaName = (r) => (r.removed ? `${r.shot.id} call ${r.call}（单独渲的子帧，没留盘）` : rel(join(r.dir, 'meta.json')).replace('out/skeleton/', ''));
const objects = [
  judge(rel(join(FIXTURES, 'film.json')), film),
  judge(rel(join(FIXTURES, 'lock.json')), lock),
  judge('caps()', caps),
  ...shots.flatMap((one) => [judge(`${one.shot.id} 镜头输入`, one.input, 'shot-input.schema.json'), judge(`${one.shot.id} manifest()`, one.manifest, 'manifest.schema.json')]),
  ...all.filter((r) => r.meta && !r.removed).map((r) => judge(metaName(r), r.meta)),
  ...Object.entries(records).map(([name, rec]) => judge(`checks/${name}.json`, rec)),
];
// 数量多、不逐个列的：单独渲的子帧的元数据，和每一个层引用
const quiet = [
  ...all.filter((r) => r.meta && r.removed).map((r) => judge(metaName(r), r.meta)),
  ...all.filter((r) => r.refs).flatMap((r) => Object.entries(r.refs).map(([n, ref]) => judge(`${r.shot.id} call ${r.call} 层引用 ${n}`, ref, 'layer-ref.schema.json'))),
];

// ---------- 两个帧源进程、几种渲法：同一帧的每一层逐位相同吗，元数据去掉 timing 之后相同吗 ----------
const determinism = shots.flatMap((one) => one.plan.frames.flatMap((f) => {
  const runs = one.renders.filter((r) => r.order && r.f === f);
  const processes = new Set(runs.map((r) => r.session[0])).size;
  const layers = WANT.filter((n) => n !== 'meta').map((layer) => {
    const got = runs.map((r) => ({ session: r.session, order: r.order, sha256: shaOf(r, layer) }));
    return { shot: one.shot.id, frame: f, layer, same: new Set(got.map((x) => x.sha256)).size === 1, processes, runs: got };
  });
  return [...layers, { shot: one.shot.id, frame: f, layer: 'meta', same: new Set(runs.map((r) => JSON.stringify({ ...r.meta, timing: null }))).size === 1, processes }];
}));

// ---------- 对校准场景的标准答案 ----------
function calibrate(one) {
  const { plan } = one, { scene, mid, main } = plan;
  const out = { shot: one.shot.id, scene: scene.id, idLayer: [], trail: [], probe: [], pixelHits: [], normal: [] };
  // 编号经实体清单按名字查
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  for (const o of scene.objects) if (!ids[o.id]) throw new Error(`实体清单里没有规格里的物体 ${o.id}`);
  const emission = Object.fromEntries(scene.objects.map((o) => [ids[o.id], o.emissionLinear[0]]));
  for (const r of ok(one).filter((x) => x.order === 'sequential')) {
    const got = { id: layerOf(one, r, 'objectId'), depth: layerOf(one, r, 'depth') }, normal = layerOf(one, r, 'normal');
    const { want, ...d } = diffs.get(auxKey(one, r)) ?? diffLayers(got, scene, r.f, ids);
    const c = centroid(W, H, (i) => got.id[i] === ids[main.id]), cw = centroid(W, H, (i) => want.id[i] === ids[main.id]);
    // 两边都说什么都没打到的像素：深度必须是约定的那个数，法线必须是 (0, 0, 0)
    let noHit = 0, noHitWrong = 0;
    for (let i = 0; i < want.id.length; i++) {
      if (want.id[i] !== 0 || got.id[i] !== 0) continue;
      noHit++;
      if (got.depth[i] !== NO_HIT_DEPTH || normal[i * 3] !== 0 || normal[i * 3 + 1] !== 0 || normal[i * 3 + 2] !== 0) noHitWrong++;
    }
    out.idLayer.push({ frame: r.f, object: main.id, pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)), ...d, noHit, noHitWrong });
    // 真正累积出来的颜色层：拖影按线性亮度加权的重心，对「快门中点那一刻的画面」按自发光值加权的重心
    const color = layerOf(one, r, 'color'), midIds = expectedLayers(scene, r.f + mid.sub, ids).id;
    const t = centroid(W, H, (i) => Math.max(0, color[i * 4])), tw = centroid(W, H, (i) => emission[midIds[i]] ?? 0);
    out.trail.push({ frame: r.f, midSub: mid.sub, samples: colorSubs(r).length, centroidPx: px4(t.px), expectedPx: px4(tw.px), diffPx: r4(dist(t.px, tw.px)) });
    // 规格点名的像素：最先打到谁、平面深度多少；点名的是背景时编号是 0、深度是约定的那个数
    for (const h of scene.expected.filter((x) => x.kind === 'pixelHits' && x.atFrame === r.f)) {
      const i = Math.floor(h.pixelPx[1]) * W + Math.floor(h.pixelPx[0]);
      out.pixelHits.push({ frame: r.f, pixelPx: h.pixelPx, wantId: h.hits[0] ? ids[h.hits[0].objectId] : 0, gotId: got.id[i], wantDepthM: h.hits[0]?.planeDepthM ?? NO_HIT_DEPTH, gotDepthM: got.depth[i], toleranceRatio: h.toleranceRatio });
    }
    // 规格里的面都正对相机：重心那个像素的法线应该是 (0, 0, 1)
    if (c.px) {
      const at = (Math.floor(c.px[1]) * W + Math.floor(c.px[0])) * 3;
      out.normal.push({ frame: r.f, pixelPx: c.px.map(Math.floor), got: [normal[at], normal[at + 1], normal[at + 2]].map(r4), want: [0, 0, 1] });
    }
  }
  {
    // sub 不为 0 的一个清晰时刻：单子帧采样的颜色层里那个物体的重心，对快门中点的答案。采样没落在答案的时刻就算不过，不换别的比法
    const r = one.renders.find((x) => x.probe === 'single-sample');
    const sub = colorSubs(r)[0], onAnswer = sub === mid.sub;
    const row = { frame: r.f, object: main.id, sampleSub: sub ?? null, answerSub: mid.sub, onAnswer };
    if (onAnswer) {
      const color = layerOf(one, r, 'color'), level = main.emissionLinear[0];
      const want = expectedLayers(scene, r.f + sub, ids).id;
      const c = centroid(W, H, (i) => Math.abs(color[i * 4] - level) <= level * 0.01), cw = centroid(W, H, (i) => want[i] === ids[main.id]);
      Object.assign(row, { pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)), projectPointPx: mid.pixelPx, vsProjectPointPx: r4(dist(c.px, mid.pixelPx)) });
    }
    out.probe.push(row);
  }
  return { ...out, tolPx: plan.tolPx, depthTol: plan.depthTol };
}
const calibration = shots.map((one) => attempt(`${one.shot.id} 对答案`, () => calibrate(one))).filter(Boolean);
const cal = (key) => calibration.flatMap((c) => c[key].map((x) => ({ ...x, tolPx: c.tolPx, depthTol: c.depthTol })));

// ---------- 结论 ----------
const expected = [
  ...shots.flatMap((one) => one.opens.map((o) => ({ shot: one.shot.id, what: 'open', want: o.expect ?? 'ok', got: o.code ?? o.status }))),
  ...all.map((r) => ({ shot: r.shot.id, what: `render call ${r.call}`, want: r.expect ?? 'ok', got: r.code ?? r.status })),
  ...shots.flatMap((one) => one.queries.map((q) => ({ shot: one.shot.id, what: `query ${q.kind}`, want: 'contract.unsupported-query', got: q.code ?? q.status }))),
];
const sampleCounts = all.filter((r) => r.status === 'ok' && r.layers.includes('color')).map((r) => ({ shot: r.shot.id, call: r.call, want: effectiveShutter(r, r.shot, caps, lock).samples, got: colorSubs(r).length }));
const lockedRuns = shots.map((one) => {
  const withLock = one.renders.find((r) => r.probe === 'locked'), without = one.renders.find((r) => r.order === 'sequential' && r.f === withLock.f);
  return { shot: one.shot.id, same: withLock.status === 'ok' && WANT.filter((n) => n !== 'meta').every((n) => shaOf(withLock, n) === shaOf(without, n)) };
});
const moments = all.filter((r) => r.moment);
const gates = {
  'objects valid': [...objects, ...quiet].every((o) => o.ok),
  'every open, render and query ended as intended (ok, or the intended error code)': expected.every((x) => x.want === x.got),
  'layers and meta identical across processes and orders': determinism.every((d) => d.same && d.processes === 2),
  'opening with the example lock gives the same layers': lockedRuns.every((x) => x.same),
  'sub-frame sample count as requested': sampleCounts.every((x) => x.want === x.got),
  'every single-moment render landed on the requested moment': moments.length > 0 && moments.every((r) => r.landed),
  'random streams drawn by the shot code have the expected names and equal the reference sequences': streams.length > 0 && streams.every((x) => x.nameAsExpected && x.matchesReference),
  'accumulation average measured on every delivered frame': averages.every((x) => x.average),
  'aux pixel offset measured on at least one delivered frame per shot': shots.every((one) => offsets.some((x) => x.shot === one.shot.id && x.pixelOffset)),
  'no error while measuring or comparing': problems.length === 0 && calibration.length === shots.length,
  'id layer vs per-pixel raycast: centroid within tolerance, mismatches only on sub-pixel edges': cal('idLayer').every((x) => within(x.vsRaycastPx, x.tolPx) && x.offEdge === 0),
  'depth layer within calibration tolerance of raycast': cal('idLayer').every((x) => x.depthMaxRatio <= x.depthTol),
  'pixels that hit nothing: id 0, depth 1e10, normal (0, 0, 0)': cal('idLayer').every((x) => x.noHit > 0 && x.noHitWrong === 0),
  'accumulated trail centroid at shutter midpoint': cal('trail').every((x) => within(x.diffPx, x.tolPx)),
  'single-sample probe lands on the answer moment and matches it': cal('probe').every((x) => x.onAnswer && within(x.vsRaycastPx, x.tolPx)),
  'named pixels hit expected object at expected depth': cal('pixelHits').every((x) => x.gotId === x.wantId && Math.abs(x.gotDepthM / x.wantDepthM - 1) <= x.toleranceRatio),
  'normal at the object centroid faces the camera': cal('normal').every((x) => x.got.every((v, i) => v === x.want[i])),
};
const kept = all.filter((r) => r.refs && !r.removed);
const hashes = Object.fromEntries(kept.flatMap((r) => r.layerRefs.map((x) => [`${r.shot.id}/${r.session}/${r.refs[x.output].file}`, x.fileSha256])));
const summary = {
  ok: Object.values(gates).every(Boolean),
  gates, problems, objects, quietObjects: { count: quiet.length, bad: quiet.filter((o) => !o.ok) }, expected, determinism, lockedRuns, sampleCounts, averages, auxPixelOffsets: offsets, randomStreams: streams,
  calibration,
  scan: { files: scans.path.files, wallClock: scans.path.wallClock, unseededRandom: scans.path.unseededRandom, allowedClock: scans.path.allowed },
  machine: { gpu: all.find((r) => r.meta)?.meta.source.gpu, platform: process.platform },
  hashes,
};
await writeFile(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const mark = (v) => (v ? '✓' : '✗');
for (const o of [...objects, ...quiet.filter((x) => !x.ok)]) {
  console.log(`${mark(o.ok)} ${o.format}  ${o.name}：${o.ok ? '结构合法，违反 0 条' : [...o.schemaErrors, ...Object.entries(o.violations).map(([id, p]) => `${id}：${p[0]}`)].join('；')}`);
}
console.log(`  另有 ${quiet.length} 个对象不逐个列（单独渲的子帧的元数据、每一个层引用），${quiet.filter((x) => x.ok).length} 个结构合法、违反 0 条`);
for (const c of calibration) {
  for (const x of c.idLayer) console.log(`  ${c.shot} 第 ${x.frame} 帧 编号层：${x.object} ${x.pixels} 像素；对逐像素求交 重心差 ${x.vsRaycastPx} 像素、编号不同 ${x.idMismatch} 个（上限 ${x.edgeLimit}，不在边上的 ${x.offEdge} 个）、深度最大差 ${x.depthMaxDiff.toExponential(2)} 米；什么都没打到的 ${x.noHit} 个像素里写得不对的 ${x.noHitWrong} 个`);
  for (const x of c.trail) console.log(`  ${c.shot} 第 ${x.frame} 帧 ${x.samples} 个子帧累积的颜色层：拖影重心 (${x.centroidPx})，快门中点的期望 (${x.expectedPx})，差 ${x.diffPx} 像素`);
  for (const x of c.probe) console.log(`  ${c.shot} 第 ${x.frame} 帧 单子帧采样落在 sub ${x.sampleSub}（答案时刻 ${x.answerSub}）${x.onAnswer ? `：${x.object} ${x.pixels} 像素，对逐像素求交差 ${x.vsRaycastPx} 像素` : '：没落在答案时刻，不比'}`);
  console.log(`  ${c.shot} 点名的像素 ${c.pixelHits.length} 个，对上 ${c.pixelHits.filter((x) => x.gotId === x.wantId).length} 个`);
}
for (const x of averages) console.log(`  ${x.shot} 第 ${x.frame} 帧 平均方式：${x.average ?? '量不出'}（${x.subFrames} 个子帧${x.renderedAlone ? '都单独渲到了' : '没能单独渲到同一批时刻'}；分得出两种平均的数 ${x.distinguishing ?? 0} 个，对线性平均最大差 ${(x.maxErrLinear ?? NaN).toExponential(2)}，对编码值平均最大差 ${(x.maxErrEncoded ?? NaN).toExponential(2)}）`);
for (const x of offsets) console.log(`  ${x.shot} 第 ${x.frame} 帧 辅助层的像素内位置：${x.pixelOffset ? `(${x.pixelOffset})` : '这一帧分不出，不写'}`);
for (const x of expected.filter((y) => y.want !== y.got)) console.log(`  ${x.shot} ${x.what}：期望 ${x.want}，实际 ${x.got}`);
for (const p of problems) console.log(`  出错：${p}`);
for (const [name, v] of Object.entries(gates)) console.log(`${mark(v)} ${name}`);
console.log(`产物在 ${rel(OUT)}/：${Object.keys(hashes).length} 个层文件，${objects.filter((o) => o.format === 'meta/0.1').length} 份落盘的元数据，${Object.keys(records).length} 份核对记录，summary.json`);
process.exit(summary.ok ? 0 : 1);
