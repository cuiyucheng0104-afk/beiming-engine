#!/usr/bin/env node
// 最小出帧链路的一致性入口：一份片子描述（三个镜头）→ 求值核展开事件表、算出镜头输入 → three 帧源（页面宿主起无头浏览器）出帧、落层文件 →
// 把这次运行里看到的写成核对记录 → 全部交给契约的校验器 → 对校准场景的标准答案。
// 用法：node beiming/kernel/conformance/run.mjs。产物在 out/skeleton/，每次运行先清空。
// 只经帧源接口（caps、open、manifest、render、query、close）取东西；帧源里面发生了什么，靠夹具里的观测点和读回的像素看。
// 先写出核对记录再去对答案；对答案出错只算那一步不过，不影响记录。退出码 0 要每一道门都过，门的清单见本目录 README。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { startSource } from '../../host/page/host.mjs';
import { loadContracts } from '../contracts/validate.mjs';
import { eventsTable, renderingOf, shotInput } from '../eval/input.mjs';
import { stream, streamName } from '../eval/rng.mjs';
import { hold } from '../eval/time.mjs';
import { boxOfIds, centroid, diffLayers, dist, expectedLayers, iou, linearError, predictAccumulation, readLayer } from './compare.mjs';
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
// 被测帧源的说明里写着还没接的三样：镜头输入带着哪一样，那次 open 的 unfitInput 就记哪一样。能力声明里没有这个字段，只能照说明填
const UNMOUNTED = ['cards', 'assets', 'overlays'];
// 备了问法的场景查询：能力声明里列了、这里却没备的种类算没验。total 是照自己问的算的「一共该有几项」
const QUERIES = { bbox3d: (of) => ({ q: { kind: 'bbox3d', of }, total: of.length }) };
// 元数据里主物体的屏幕包围盒对编号层反算出的包围盒，交并比不得低于这个数。契约里这道线还没定；这是入口自己的门：
// 这条链路在三个镜头的九个交付帧上量到的读数是 0.9628 到 0.9926（一台苹果芯片的开发机），线比最小的读数低一截留作余量。读数每次都打印、写进 summary.json
const META_BOX_IOU_MIN = 0.9;

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
// 入口就是帧源上面的那一层：事件在这里展开一次，放进每个镜头的镜头输入
const events = eventsTable(film);
const named = events.events.filter((e) => e.kind === 'named');
const [W, H] = film.output.size;
const problems = [];
const attempt = (what, fn) => { try { return fn(); } catch (e) { problems.push(`${what}：${e.message}`); return undefined; } };

/** 这个镜头对的是哪个校准场景（入口文件名去掉 .shot.js 就是校准目录里的 probe-<名字>），以及从它的答案里读出的要渲哪些帧、对哪些时刻 */
async function planOf(shot) {
  const scene = await readJson(join(REPO, 'beiming/calib', `probe-${renderingOf(shot).entry.replace('.shot.js', '')}`, 'scene.json'));
  const points = scene.expected.filter((e) => e.kind === 'projectPoint').map((e) => ({ ...e, sub: e.sampleAt === 'shutterMid' ? scene.camera.shutterAngleDeg / 720 : e.subFrameRatio }));
  const mid = points.find((e) => e.sampleAt === 'shutterMid');
  // 单独一个子帧采样落在「快门角 ÷ 720」，快门角最大 360 度：相位大于 0.5 的时刻从帧源接口要不到，不排进去
  const moments = [...new Map(points.filter((e) => e.sub <= 0.5).map((e) => [`${e.atFrame}/${e.sub}`, { f: e.atFrame, sub: e.sub }])).values()].sort((x, y) => x.f - y.f || x.sub - y.sub);
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
  const plan = await planOf(shot), input = shotInput(film, shot.id, events);
  const files = withDirectImports(REPO, rel(join(FIXTURES, renderingOf(shot).entry)));
  const one = { shot, plan, input, files, languages: [...new Set(files.map((f) => LANGUAGES[extname(f)]).filter(Boolean))], renders: [], opens: [], probes: [], loads: [], evaluations: [], queries: [], badArgs: [], rng: [], localized: [], metaFrames: [], manifest: null };
  const midF = plan.mid.atFrame, frames = shot.out - shot.in;
  const shuffle = stream(streamName(shot.seed, shot.id, 'conformance/shuffle'));
  const patched = (patch) => ({ ...structuredClone(input), shot: { ...structuredClone(input.shot), ...patch } });
  /** 改出帧用的那一套：条目带 renderer 对象时改它里面的，不带时改顶层的 */
  const rerouted = (patch) => (input.shot.renderer ? patched({ renderer: { ...input.shot.renderer, ...patch } }) : patched(patch));

  /** 调一次 open。expect 给了错误码就是故意造的装不了的输入；成功时交回会话和它的产物目录 out/skeleton/<镜头>/<label>/ */
  async function open(source, label, { inp = input, withLock = false, tier = 'final', expect } = {}) {
    const { host, mode } = renderingOf(inp.shot);
    const uses = { cards: (inp.shot.cards ?? []).length > 0, assets: Object.keys(inp.shot.assets ?? {}).length > 0 || Object.keys(inp.assets ?? {}).length > 0, overlays: (inp.overlays ?? []).length > 0 };
    const rec = { plain: inp === input, hasLock: withLock, hasSeed: Number.isInteger(inp.shot.seed), usesCards: uses.cards || uses.overlays, usesAssets: uses.assets, host, mode, unfitInput: UNMOUNTED.filter((k) => uses[k]) };
    one.opens.push(rec);
    // 改过的镜头输入也得是合乎结构的镜头输入：留着，后面逐个过结构定义
    if (inp !== input) one.probes.push({ label, input: inp });
    Object.defineProperty(rec, 'expect', { value: expect }); // 不进记录，只给「报的错对不对」那道门用
    const workspace = join(OUT, shot.id, label);
    try {
      const session = await source.open(inp, { lock: withLock ? lock : null, tier, workspace, filmDir: FIXTURES });
      rec.status = 'ok';
      one.loads.push({ session: label, locked: withLock, tier, input: inp });
      return { session, workspace, label, locked: withLock, tier };
    } catch (e) {
      // 报的错不带错误码也照记：code 不出现，由条文判
      Object.assign(rec, { status: 'error', ...uncoded(`open（${label}）`, e) });
      // 后面要在这个会话上出帧的 open 装不上，这个镜头走不下去
      if (!expect) throw e;
      return null;
    }
  }

  /** 报的错带错误码就交回 { code }；不带就把原话记进出错清单，交回空对象 */
  function uncoded(what, e) {
    if (e.code) return { code: e.code };
    problems.push(`${shot.id} ${what} 报的错不带错误码：${e.message}`);
    return {};
  }

  /** 调一次 render。more 里是这次调用的标记：order（按哪种次序渲的）、expect（故意造的错）、unsupportedOpts、unfitOutputs…… */
  async function render(s, f, opts, want, more = {}) {
    const rec = { call: one.renders.length, session: s.label, locked: s.locked, tier: s.tier, f, opts, want, unsupportedOpts: [], unfitOutputs: [], ...more };
    one.renders.push(rec);
    try {
      const res = await s.session.render(f, opts, want);
      rec.status = 'ok';
      rec.layers = Object.keys(res.layers);
      rec.refs = res.layers;
      // 层文件的哈希自己读文件重算，不抄层引用里写的
      rec.layerRefs = [];
      rec.fileBytes = {};
      for (const [output, ref] of Object.entries(res.layers)) {
        const bytes = await readFile(join(s.workspace, ref.file));
        rec.fileBytes[output] = bytes.length;
        rec.layerRefs.push({ output, shape: ref.shape, hash: ref.hash, fileHash: `sha256:${hex(bytes)}` });
      }
      rec.metas = Array.isArray(res.meta) ? res.meta.length : res.meta ? 1 : 0;
      if (rec.metas === 1) {
        // 大小量的是不带缩进、末尾不带换行的写法；落盘的文件怎么排版不影响这个数
        const text = `${JSON.stringify(res.meta, null, 2)}\n`;
        Object.assign(rec, { meta: res.meta, metaBytes: Buffer.byteLength(JSON.stringify(res.meta)), seen: readObservation(res.meta.readings) });
        rec.dir = join(s.workspace, res.layers.color ? dirname(res.layers.color.file) : `meta-only-c${pad(rec.call, 3)}`);
        await mkdir(rec.dir, { recursive: true });
        await writeFile(join(rec.dir, 'meta.json'), text);
      }
    } catch (e) {
      Object.assign(rec, { status: 'error', ...uncoded(`render call ${rec.call}`, e) });
      // 报错的那次调用可能已经写过几次状态，观测点还攒着；只要元数据渲一次把它们清掉，不然会算到下一次调用头上
      await s.session.render(midF, {}, ['meta']);
    }
    return rec;
  }

  /** 故意把一个参数传出值域的一次 render：别的参数都在值域里，要的输出都声明过。只记结局，不进 renders */
  async function badArg(s, arg, f, opts, want) {
    const rec = { call: 'render', arg };
    one.badArgs.push(rec);
    try {
      await s.session.render(f, opts, want);
      rec.status = 'ok';
    } catch (e) {
      Object.assign(rec, { status: 'error', ...uncoded(`render（${arg} 出值域）`, e) });
    }
    await s.session.render(midF, {}, ['meta']);
  }

  /** 问一次场景查询。expect 是打算的结局，不进记录 */
  async function ask(s, kind, of, expect) {
    const { q, total } = QUERIES[kind](of), rec = { kind };
    one.queries.push(rec);
    Object.defineProperty(rec, 'expect', { value: expect });
    try {
      const res = await s.session.query(midF, q);
      // 一共该有几项照自己问的算，不取帧源交回的项数
      Object.assign(rec, { status: 'ok', total, returned: res.items.length, ...(res.truncated === undefined ? {} : { truncated: res.truncated }) });
    } catch (e) {
      Object.assign(rec, { status: 'error', ...uncoded(`query ${kind}`, e) });
    }
  }

  /** 纯函数门：对一批时刻各求一次状态。从帧源接口要一个时刻的办法是只取一个子帧采样，它落在「快门角 ÷ 720」；状态摘要取那张颜色层的哈希，所以只看得见会改变颜色的状态 */
  async function evaluate(s, moments, mode) {
    for (const m of moments) {
      const r = await render(s, m.f, { shutter: { angleDeg: m.sub * 720, samples: 1 } }, ['color', 'meta'], { moment: m, mode });
      const at = (r.seen?.states ?? []).filter((x) => x.color > 0);
      // 观测点看到的时刻必须就是要的那一个，不然这张图不是这个时刻的状态，不记
      r.landed = r.status === 'ok' && at.length === 1 && at[0].f === m.f && at[0].sub === m.sub;
      if (r.landed) one.evaluations.push({ f: m.f, sub: m.sub, mode, digest: r.layerRefs.find((x) => x.output === 'color').fileHash.replace('sha256:', '') });
    }
  }

  // 第一个帧源进程：装不了的输入、顺序出帧、同会话重复、各种探测、带锁文件装一次、草稿档装一次
  const a = await startSource();
  try {
    caps = a.caps();
    const noSeed = structuredClone(input);
    delete noSeed.shot.seed;
    // 卡实例照片子描述的写法：as、use、params 三个都写
    const withCard = patched({ cards: [{ as: 'probe', use: 'probe.card@1', params: {} }] });
    const withOverlay = { ...structuredClone(input), overlays: [{ id: 'probe', shot: shot.id, anchor: 'screen', pos: [0.5, 0.5], text: 'probe', in: shot.in, out: shot.in + 1 }] };
    const rejected = [
      [noSeed, 'env.lock-required'],
      [withCard, 'env.lock-required'],
      [patched({ assets: { probe: 'asset:probe@1' } }), 'env.lock-required'],
      [{ ...structuredClone(input), assets: { probe: 'asset:probe@1' } }, 'env.lock-required'], // 全片的资产表
      [rerouted({ mode: 'cards-data' }), 'contract.unsupported-mode'],
      [rerouted({ host: 'offscreen' }), 'contract.unsupported-mode'],
      [withOverlay, 'env.lock-required'], // 叠加层展开成卡的实例，没有锁也算用了卡
      // 帧源还没接的东西：带着锁、带着叠加层；带着锁、用了卡。都得报装不了，不得少装一样照常装载
      [withOverlay, 'contract.unsupported-input', true],
      [withCard, 'contract.unsupported-input', true],
    ];
    for (const [inp, expect, withLock = false] of rejected) await (await open(a, 'a-rejected', { inp, expect, withLock }))?.session.close();

    const seq = await open(a, 'a-sequential');
    one.manifest = seq.session.manifest();
    for (const f of plan.frames) await render(seq, f, {}, WANT, { order: 'sequential' });
    // 只要元数据的这一次排在别的帧后面：场景还停在上一帧，它得自己把这一帧的状态写进去
    await render(seq, midF, {}, ['meta'], { probe: 'meta-only' });
    await render(seq, midF, {}, WANT, { order: 'repeat' });
    await render(seq, midF, {}, ['color', 'motion'], { expect: 'contract.unsupported-output' });
    await render(seq, midF, { shutter: { angleDeg: 0, samples: 4 } }, ['color', 'meta'], { expect: 'contract.shutter-conflict' });
    await render(seq, midF, { samples: 2 }, ['color', 'meta'], { expect: 'contract.unsupported-option', unsupportedOpts: ['samples'] });
    // 参数出值域：一次只把一个参数传出去
    await badArg(seq, 'f', frames, {}, ['meta']);
    await badArg(seq, 'want', midF, {}, ['color', 'color']);
    await badArg(seq, 'opts.samples', midF, { samples: 0 }, ['color', 'meta']);
    await badArg(seq, 'opts.scale', midF, { scale: 2 }, ['color', 'meta']);
    await badArg(seq, 'opts.shutter.angleDeg', midF, { shutter: { angleDeg: 400, samples: 1 } }, ['color', 'meta']);
    await badArg(seq, 'opts.shutter.samples', midF, { shutter: { angleDeg: 180, samples: 0 } }, ['color', 'meta']);
    // 场景查询：能力声明里列了的每一种各问一次，该给结果；再问一种没列的，该报不答这种查询。期望照能力声明算
    const of = [one.manifest.entities[0].name];
    for (const kind of caps.sceneQuery.filter((k) => QUERIES[k])) await ask(seq, kind, of, 'ok');
    const undeclared = Object.keys(QUERIES).find((k) => !caps.sceneQuery.includes(k));
    if (undeclared) await ask(seq, undeclared, of, 'contract.unsupported-query');
    await evaluate(seq, plan.moments, 'sequential');
    await seq.session.close();
    for (const [i, m] of plan.moments.entries()) {
      const s = await open(a, `a-moment-${i}`);
      await evaluate(s, [m], 'single');
      await s.session.close();
    }
    // 带着例子锁装载，镜头输入里故意不写种子：种子只能是从锁里取的
    const locked = await open(a, 'a-locked', { inp: noSeed, withLock: true });
    await render(locked, midF, {}, WANT, { probe: 'locked' });
    await locked.session.close();
    const draft = await open(a, 'a-draft', { tier: 'draft' });
    await render(draft, midF, {}, WANT, { probe: 'draft' });
    await draft.session.close();
    // 场景里多一条线：辅助层画不了它，要辅助层必须报错；不要辅助层照常出
    const odd = await open(a, 'a-stranger', { inp: patched({ params: { ...input.shot.params, stranger: 'line' } }) });
    await render(odd, midF, {}, ['color', 'objectId'], { expect: 'contract.unsupported-object', unfitOutputs: AUX });
    await render(odd, midF, {}, ['color', 'meta'], { unfitOutputs: AUX, offSpec: true });
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
const shaOf = (r, name) => r.layerRefs.find((x) => x.output === name)?.fileHash;
const accumulations = [], auxMismatches = [], streams = [];
const diffs = new Map(); // 编号层、深度层对逐像素求交的结果，同一张编号层只算一次，对答案时接着用；量的时候出了错记 null
const predictions = new Map(); // 同一个校准场景、同一帧、同样的快门只预言一次：前两个镜头是同一个场景
const auxKey = (one, r) => `${one.shot.id}/${r.f}/${shaOf(r, 'objectId')}/${shaOf(r, 'depth')}`;
for (const one of shots) {
  const { scene } = one.plan;
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  // 累积颜色层对「各子帧采样时刻的预言图在线性值上取算术平均」差多少：时刻照自己传的快门算，预言图照规格求交。
  // 只有一个子帧采样的调用谈不上平均；场景里多放了东西的、输出尺寸不是规格画幅的，规格预言不了，都不量。同一张颜色层只量一次
  const background = one.shot.params?.background === false ? [0, 0, 0, 0] : [...scene.backgroundLinear, 1];
  const errors = new Map();
  for (const r of ok(one).filter((x) => x.refs.color && !x.offSpec && x.refs.color.shape[0] === H && x.refs.color.shape[1] === W)) {
    const { angleDeg, samples } = effectiveShutter(r, one.shot, caps, lock);
    if (samples === 1) continue;
    const key = shaOf(r, 'color');
    if (!errors.has(key)) {
      errors.set(key, attempt(`${one.shot.id} 第 ${r.f} 帧量累积颜色层对预言图的差`, () => {
        const at = `${scene.id}/${r.f}/${angleDeg}/${samples}`;
        if (!predictions.has(at)) predictions.set(at, predictAccumulation(scene, r.f, angleDeg, samples));
        return linearError(layerOf(one, r, 'color'), scene, predictions.get(at), background);
      }) ?? null);
    }
    const m = errors.get(key);
    if (m && m.linearErr !== null) r.linearErr = m.linearErr;
    if (r.order === 'sequential') accumulations.push({ shot: one.shot.id, frame: r.f, subFrames: samples, ...(m ?? { linearErr: null }) });
  }
  // 编号层对「照规格在这一帧 sub = 0、针孔、像素中心求交」的预言图，边缘带之外对不上的像素数。编号经实体清单按名字查；同一张编号层只量一次。
  // 草稿档的尺寸不是规格的画幅，规格预言不了，不量
  for (const r of ok(one).filter((x) => AUX.every((n) => x.layers.includes(n)) && x.tier === 'final')) {
    const key = auxKey(one, r);
    if (!diffs.has(key)) diffs.set(key, attempt(`${one.shot.id} 第 ${r.f} 帧量编号层对预言图`, () => diffLayers({ id: layerOf(one, r, 'objectId'), depth: layerOf(one, r, 'depth') }, scene, r.f, ids)) ?? null);
    const d = diffs.get(key);
    if (d) r.auxMismatch = d.offEdge;
    if (r.order === 'sequential') auxMismatches.push({ shot: one.shot.id, frame: r.f, auxMismatch: d ? d.offEdge : null, idMismatch: d?.idMismatch ?? null, edgeLimit: d?.edgeLimit ?? null });
  }
  // 命名随机流：观测点两轮取数，流名是它从 ctx.rng 拿到的原文，数由这里算摘要、对参考序列。不带锁和带锁的两个会话各记一遍
  for (const r of [ok(one).find((x) => x.seen), one.renders.find((x) => x.probe === 'locked')].filter((x) => x?.seen)) {
    for (const x of r.seen.rng) {
      const want = streamName(r.locked ? lock.seeds[one.shot.id] : one.shot.seed, one.shot.id, x.arg), ref = stream(want), run = `${r.session}/${x.run}`;
      streams.push({ shot: one.shot.id, run, arg: x.arg, name: x.name, nameAsExpected: x.name === want, matchesReference: x.values.every((v) => v === ref.u32()) });
      one.rng.push({ run, arg: x.arg, name: x.name, digest: hex(Buffer.from(Uint32Array.from(x.values).buffer)) });
    }
  }
  // 事件：放进镜头输入的是全片帧号，观测点在 ctx.events 里看到的是交给镜头代码的帧号
  for (const x of ok(one).find((r) => r.seen)?.seen.events ?? []) {
    const frame = named.find((e) => e.id === x.id)?.frame;
    if (frame === undefined) problems.push(`${one.shot.id} 的 ctx.events 里有事件表里没有的 ${x.id}`);
    else one.localized.push({ frame, f: x.f });
  }
  // 每次 meta 收到的帧号：全片帧号照这次 render 请求的帧号算，收到的是观测点记的
  for (const r of ok(one).filter((x) => x.seen)) {
    if (Number.isInteger(r.seen.metaF)) one.metaFrames.push({ frame: r.f + one.shot.in, f: r.seen.metaF });
    else problems.push(`${one.shot.id} call ${r.call} 的 meta 没收到整数帧号`);
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
// 事件核对记录：这里展开的事件表对不对得上片子描述，也交给校验器判
const records = { 'time-check': timeCheck(obs), 'events-check': { format: 'events-check/0.1', events, film } };
for (const one of shots) {
  records[`${one.shot.id}.shot-check`] = shotCheck(obs, one);
  records[`${one.shot.id}.source-check`] = sourceCheck(obs, one);
  records[`${one.shot.id}.meta-check`] = metaCheck(obs, one);
}
for (const [name, rec] of Object.entries(records)) await writeFile(join(OUT, 'checks', `${name}.json`), `${JSON.stringify(rec, null, 2)}\n`);

const judge = (name, obj, schema) => {
  const v = loaded.validate(obj, 'source', schema);
  return { name, format: obj.format ?? schema, ok: v.schemaErrors.length === 0 && Object.keys(v.violations).length === 0, schemaErrors: v.schemaErrors, violations: v.violations };
};
const all = shots.flatMap((one) => one.renders.map((r) => ({ ...r, shot: one.shot })));
const objects = [
  judge(rel(join(FIXTURES, 'film.json')), film),
  judge(rel(join(FIXTURES, 'lock.json')), lock),
  judge('caps()', caps),
  judge('展开的事件表', events),
  ...shots.flatMap((one) => [judge(`${one.shot.id} 镜头输入`, one.input, 'shot-input.schema.json'), judge(`${one.shot.id} manifest()`, one.manifest, 'manifest.schema.json')]),
  ...all.filter((r) => r.meta).map((r) => judge(rel(join(r.dir, 'meta.json')).replace('out/skeleton/', ''), r.meta)),
  ...Object.entries(records).map(([name, rec]) => judge(`checks/${name}.json`, rec)),
];
// 数量多、不逐个列的：每一个层引用单独判一遍，
const refs = all.filter((r) => r.refs).flatMap((r) => Object.entries(r.refs).map(([n, ref]) => ({ r, n, ref })));
// 以及每一份改过的镜头输入（装不了的输入、带着例子锁的、多放一条线的）
const quiet = [
  ...refs.map(({ r, n, ref }) => judge(`${r.shot.id} call ${r.call} 层引用 ${n}`, ref, 'layer-ref.schema.json')),
  ...shots.flatMap((one) => one.probes.map((x, i) => judge(`${one.shot.id} 改过的镜头输入 ${i}（${x.label}）`, x.input, 'shot-input.schema.json'))),
];

// ---------- 两个帧源进程、几种渲法：同一帧的每一层逐位相同吗，元数据去掉 timing 之后相同吗 ----------
const determinism = shots.flatMap((one) => one.plan.frames.flatMap((f) => {
  const runs = one.renders.filter((r) => r.order && r.f === f);
  const processes = new Set(runs.map((r) => r.session[0])).size;
  const layers = WANT.filter((n) => n !== 'meta').map((layer) => {
    const got = runs.map((r) => ({ session: r.session, order: r.order, hash: shaOf(r, layer) }));
    return { shot: one.shot.id, frame: f, layer, same: new Set(got.map((x) => x.hash)).size === 1, processes, runs: got };
  });
  return [...layers, { shot: one.shot.id, frame: f, layer: 'meta', same: new Set(runs.map((r) => JSON.stringify({ ...r.meta, timing: null }))).size === 1, processes }];
}));

// ---------- 对校准场景的标准答案 ----------
function calibrate(one) {
  const { plan } = one, { scene, mid, main } = plan;
  const out = { shot: one.shot.id, scene: scene.id, idLayer: [], trail: [], moments: [], pixelHits: [], normal: [] };
  // 编号只在这一次装载里有意义：一律经实体清单按名字查，不拿规格里的次序当编号
  const ids = Object.fromEntries(one.manifest.entities.map((e) => [e.name, e.id]));
  for (const o of scene.objects) if (!ids[o.id]) throw new Error(`实体清单里没有规格里的物体 ${o.id}`);
  const emission = Object.fromEntries(scene.objects.map((o) => [ids[o.id], o.emissionLinear[0]]));
  for (const r of ok(one).filter((x) => x.order === 'sequential')) {
    const got = { id: layerOf(one, r, 'objectId'), depth: layerOf(one, r, 'depth') }, normal = layerOf(one, r, 'normal');
    const { want, ...d } = diffs.get(auxKey(one, r)) ?? diffLayers(got, scene, r.f, ids);
    // 主物体在编号层里占的像素：编号是它自己的，或者是名字以它的名字加点号开头的实体的
    const own = one.manifest.entities.filter((e) => e.name === main.id || e.name.startsWith(`${main.id}.`)).map((e) => e.id);
    const c = centroid(W, H, (i) => got.id[i] === ids[main.id]), cw = centroid(W, H, (i) => want.id[i] === ids[main.id]);
    // 求交说什么都没打到、编号层也写 0 的像素：深度必须是约定的那个数，法线必须是 (0, 0, 0)
    let noHit = 0, noHitWrong = 0;
    for (let i = 0; i < want.id.length; i++) {
      if (want.id[i] !== 0 || got.id[i] !== 0) continue;
      noHit++;
      if (got.depth[i] !== NO_HIT_DEPTH || normal[i * 3] !== 0 || normal[i * 3 + 1] !== 0 || normal[i * 3 + 2] !== 0) noHitWrong++;
    }
    // 用编号层核对元数据：元数据里主物体的屏幕包围盒，对从编号层反算出的包围盒，比交并比。中心对重心的距离只当辅助
    const box = r.meta.entities.find((e) => e.name === main.id)?.bbox2d;
    const metaBoxIou = r4(iou(box, boxOfIds(W, H, got.id, own)));
    const metaBoxVsIdPx = box ? r4(dist([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], c.px)) : null;
    out.idLayer.push({ frame: r.f, object: main.id, pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)), metaBoxIou, metaBoxVsIdPx, ...d, noHit, noHitWrong });
    // 真正累积出来的颜色层：拖影按线性亮度加权的重心，对「快门中点那一刻的画面」按自发光值加权的重心
    const color = layerOf(one, r, 'color'), midIds = expectedLayers(scene, r.f + mid.sub, ids).id;
    const t = centroid(W, H, (i) => Math.max(0, color[i * 4])), tw = centroid(W, H, (i) => emission[midIds[i]] ?? 0);
    out.trail.push({ frame: r.f, midSub: mid.sub, samples: colorSubs(r).length, centroidPx: px4(t.px), expectedPx: px4(tw.px), diffPx: r4(dist(t.px, tw.px)) });
    // 规格点名的像素：最先打到谁、平面深度多少；点名的像素什么都打不到时编号是 0、深度是约定的那个数
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
  // sub 不为 0 的清晰时刻（答案里点了名的）：只取一个子帧采样渲出的颜色层里主物体的重心，对那一刻的求交。没落在要的时刻就算不过，不换别的比法
  for (const r of one.renders.filter((x) => x.moment && x.mode === 'sequential' && x.moment.sub > 0)) {
    const row = { frame: r.f, sub: r.moment.sub, object: main.id, landed: r.landed };
    if (r.landed) {
      const color = layerOf(one, r, 'color'), level = main.emissionLinear[0];
      const want = expectedLayers(scene, r.f + r.moment.sub, ids).id;
      const c = centroid(W, H, (i) => Math.abs(color[i * 4] - level) <= level * 0.01), cw = centroid(W, H, (i) => want[i] === ids[main.id]);
      Object.assign(row, { pixels: c.count, centroidPx: px4(c.px), raycastCentroidPx: px4(cw.px), vsRaycastPx: r4(dist(c.px, cw.px)) });
    }
    out.moments.push(row);
  }
  return { ...out, tolPx: plan.tolPx, depthTol: plan.depthTol };
}
const calibration = shots.map((one) => attempt(`${one.shot.id} 对答案`, () => calibrate(one))).filter(Boolean);
const cal = (key) => calibration.flatMap((c) => c[key].map((x) => ({ ...x, tolPx: c.tolPx, depthTol: c.depthTol })));

// ---------- 结论 ----------
const expected = [
  ...shots.flatMap((one) => one.opens.map((o) => ({ shot: one.shot.id, what: 'open', want: o.expect ?? 'ok', got: o.code ?? o.status }))),
  ...all.map((r) => ({ shot: r.shot.id, what: `render call ${r.call}`, want: r.expect ?? 'ok', got: r.code ?? r.status })),
  ...shots.flatMap((one) => one.queries.map((q) => ({ shot: one.shot.id, what: `query ${q.kind}`, want: q.expect, got: q.code ?? q.status }))),
  ...shots.flatMap((one) => one.badArgs.map((b) => ({ shot: one.shot.id, what: `${b.call}（${b.arg} 出值域）`, want: 'usage.bad-argument', got: b.code ?? b.status }))),
];
// 能力声明里列了、这次却没验到的：没备问法的场景查询，没有夹具镜头的作者模式
const unverified = [
  ...caps.sceneQuery.filter((k) => !QUERIES[k]).map((k) => `场景查询 ${k}`),
  ...caps.modes.filter((m) => !shots.some((one) => one.opens.some((o) => o.plain && o.mode === m))).map((m) => `作者模式 ${m}`),
];
// 每次出了颜色层的成功 render 在时间核对记录的 frames 里都该有一项；观测到了却写不成一项的，不能当成没观测
const frameRows = shots.map((one) => ({ shot: one.shot.id, want: ok(one).filter((r) => r.layers.includes('color')).length, got: records['time-check'].frames.filter((x) => x.shot === one.shot.id).length }));
const sampleCounts = all.filter((r) => r.status === 'ok' && r.layers.includes('color')).map((r) => ({ shot: r.shot.id, call: r.call, want: effectiveShutter(r, r.shot, caps, lock).samples, got: colorSubs(r).length }));
const lockedRuns = shots.map((one) => {
  const withLock = one.renders.find((r) => r.probe === 'locked'), without = one.renders.find((r) => r.order === 'sequential' && r.f === withLock.f);
  return { shot: one.shot.id, same: withLock.status === 'ok' && WANT.filter((n) => n !== 'meta').every((n) => shaOf(withLock, n) === shaOf(without, n)) };
});
const draftRuns = all.filter((r) => r.probe === 'draft').map((r) => ({
  shot: r.shot.id, status: r.status, layers: r.layers ?? [], shapes: Object.values(r.refs ?? {}).map((ref) => ref.shape.slice(0, 2)),
  want: [Math.round(H * caps.draft.scale), Math.round(W * caps.draft.scale)],
}));
// 只要元数据的那次调用：排在同一个会话里别的帧后面，交回的元数据去掉 stats、hash、timing 之后等于同一帧整帧渲染交回的。
// 观测点自己记的「这次调用里 state 被调了几次、各是什么时刻」两种调用本来就不一样，也去掉
const bare = ({ stats, hash, timing, readings = {}, ...rest }) => ({ ...rest, readings: Object.fromEntries(Object.entries(readings).filter(([k]) => !/^obs\.states?(\.|$)/.test(k))) });
const metaOnly = shots.map((one) => {
  const r = one.renders.find((x) => x.probe === 'meta-only'), prev = one.renders[r.call - 1], full = one.renders.find((x) => x.order === 'sequential' && x.f === r.f);
  const [got, want] = [r.meta, full?.meta].map((m) => m && bare(m));
  return {
    shot: one.shot.id, frame: r.f, status: r.status, layers: r.layers ?? [],
    afterOtherFrame: prev?.session === r.session && prev.status === 'ok' && prev.f !== r.f,
    differs: got && want ? Object.keys({ ...got, ...want }).filter((k) => !isDeepStrictEqual(got[k], want[k])) : null,
  };
});
const moments = all.filter((r) => r.moment);
const metas = all.filter((r) => r.meta);
const eventsAt = (frame) => events.events.filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame }));
const gates = {
  'objects valid': [...objects, ...quiet].every((o) => o.ok),
  'every open, render, query and out-of-range call ended as intended (ok, or the intended error code)': expected.every((x) => x.want === x.got),
  'every declared scene query kind and author mode was exercised': unverified.length === 0,
  'every successful render with a color layer has an entry in time-check frames': frameRows.every((x) => x.want > 0 && x.want === x.got),
  'meta(f) frame number observed on every render that returned meta': shots.every((one) => one.metaFrames.length > 0 && one.metaFrames.length === ok(one).filter((r) => r.meta).length),
  'layers and meta identical across processes and orders': determinism.every((d) => d.same && d.processes === 2),
  'opening with the example lock and no seed in the shot entry gives the same layers': lockedRuns.every((x) => x.same),
  'draft tier renders every layer at the declared scale': draftRuns.length === shots.length && draftRuns.every((x) => x.status === 'ok' && x.layers.length === WANT.length - 1 && x.shapes.every((s) => s[0] === x.want[0] && s[1] === x.want[1])),
  'every layer file holds shape[0] x shape[1] x shape[2] values of 4 bytes': refs.length > 0 && refs.every(({ r, n, ref }) => r.fileBytes[n] === ref.shape[0] * ref.shape[1] * ref.shape[2] * 4),
  'meta-only render after another frame returns the same meta as the full render of that frame, minus stats, hash and timing': metaOnly.every((x) => x.status === 'ok' && x.layers.length === 0 && x.afterOtherFrame && x.differs?.length === 0),
  'sub-frame sample count as requested': sampleCounts.every((x) => x.want === x.got),
  'every single-moment render landed on the requested moment': moments.length > 0 && moments.every((r) => r.landed),
  'random streams handed to the shot code have the expected names and equal the reference sequences': streams.length > 0 && streams.every((x) => x.nameAsExpected && x.matchesReference),
  'meta source.id is the source written at the top of the shot entry, source.renderer and source.host are the ones that rendered': metas.length > 0 && metas.every((r) => r.meta.source.id === r.shot.source && r.meta.source.renderer === caps.id && r.meta.source.host === renderingOf(r.shot).host),
  'ctx.events holds every named event of the shot input': named.length > 0 && shots.every((one) => one.localized.length === named.length),
  'meta events are the events of the shot input that land on that frame': metas.every((r) => JSON.stringify(r.meta.events) === JSON.stringify(eventsAt(r.f + r.shot.in))) && metas.some((r) => r.meta.events.length > 0),
  'accumulated color vs linear average of predicted images measured on every delivered frame': accumulations.length > 0 && accumulations.every((x) => x.linearErr !== null),
  'id layer vs predicted image (aux mismatch) measured on every delivered frame': auxMismatches.length > 0 && auxMismatches.every((x) => x.auxMismatch !== null),
  'no error while measuring or comparing': problems.length === 0 && calibration.length === shots.length,
  'id layer vs per-pixel raycast: centroid within tolerance, mismatches only on sub-pixel edges': cal('idLayer').every((x) => within(x.vsRaycastPx, x.tolPx) && x.offEdge === 0),
  'meta bbox of the main object vs its bbox in the id layer: intersection over union': cal('idLayer').every((x) => x.metaBoxIou !== null && x.metaBoxIou >= META_BOX_IOU_MIN),
  'meta bbox center of the main object vs its centroid in the id layer (same moment)': cal('idLayer').every((x) => within(x.metaBoxVsIdPx, x.tolPx)),
  'depth layer within calibration tolerance of raycast': cal('idLayer').every((x) => x.depthMaxRatio <= x.depthTol),
  'pixels that hit nothing: id 0, depth 1e10, normal (0, 0, 0)': cal('idLayer').every((x) => x.noHit > 0 && x.noHitWrong === 0),
  'accumulated trail centroid at shutter midpoint': cal('trail').every((x) => within(x.diffPx, x.tolPx)),
  'single-moment renders with sub > 0 match the raycast at that moment': calibration.every((c) => c.moments.length > 0) && cal('moments').every((x) => x.landed && within(x.vsRaycastPx, x.tolPx)),
  'named pixels hit expected object at expected depth': cal('pixelHits').every((x) => x.gotId === x.wantId && Math.abs(x.gotDepthM / x.wantDepthM - 1) <= x.toleranceRatio),
  'normal at the object centroid faces the camera': cal('normal').every((x) => x.got.every((v, i) => v === x.want[i])),
};
const hashes = Object.fromEntries(all.filter((r) => r.refs).flatMap((r) => r.layerRefs.map((x) => [`${r.shot.id}/${r.session}/${r.refs[x.output].file}`, x.fileHash])));
const summary = {
  ok: Object.values(gates).every(Boolean),
  gates, problems, objects, quietObjects: { count: quiet.length, bad: quiet.filter((o) => !o.ok) }, expected, determinism, lockedRuns, draftRuns, metaOnly, sampleCounts, accumulations, auxMismatches, unverified, frameRows, metaBoxIou: { min: META_BOX_IOU_MIN, readings: cal('idLayer').map((x) => x.metaBoxIou) }, randomStreams: streams,
  calibration,
  scan: { files: scans.path.files, wallClock: scans.path.wallClock, unseededRandom: scans.path.unseededRandom, allowedClock: scans.path.allowed },
  machine: { gpu: all.find((r) => r.meta)?.meta.source.gpu, platform: process.platform },
  hashes,
};
await writeFile(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const mark = (v) => (v ? '✓' : '✗');
const sci = (v) => (v === null || v === undefined ? '量不出' : v.toExponential(2));
for (const o of [...objects, ...quiet.filter((x) => !x.ok)]) {
  console.log(`${mark(o.ok)} ${o.format}  ${o.name}：${o.ok ? '结构合法，违反 0 条' : [...o.schemaErrors, ...Object.entries(o.violations).map(([id, p]) => `${id}：${p[0]}`)].join('；')}`);
}
console.log(`  另有 ${quiet.length} 个层引用和改过的镜头输入不逐个列，${quiet.filter((x) => x.ok).length} 个结构合法、违反 0 条`);
for (const c of calibration) {
  for (const x of c.idLayer) console.log(`  ${c.shot} 第 ${x.frame} 帧 编号层：${x.object} ${x.pixels} 像素；对逐像素求交 重心差 ${x.vsRaycastPx} 像素、编号不同 ${x.idMismatch} 个（上限 ${x.edgeLimit}，不在边上的 ${x.offEdge} 个）、深度最大差 ${x.depthMaxDiff.toExponential(2)} 米；什么都没打到的 ${x.noHit} 个像素里写得不对的 ${x.noHitWrong} 个；元数据包围盒对编号层反算的包围盒 交并比 ${x.metaBoxIou}，中心对重心差 ${x.metaBoxVsIdPx} 像素`);
  for (const x of c.trail) console.log(`  ${c.shot} 第 ${x.frame} 帧 ${x.samples} 个子帧累积的颜色层：拖影重心 (${x.centroidPx})，快门中点的期望 (${x.expectedPx})，差 ${x.diffPx} 像素`);
  for (const x of c.moments) console.log(`  ${c.shot} 第 ${x.frame} 帧 sub ${x.sub} 的清晰时刻${x.landed ? `：${x.object} ${x.pixels} 像素，对逐像素求交差 ${x.vsRaycastPx} 像素` : '：没落在要的时刻，不比'}`);
  console.log(`  ${c.shot} 点名的像素 ${c.pixelHits.length} 个，对上 ${c.pixelHits.filter((x) => x.gotId === x.wantId).length} 个`);
}
for (const x of accumulations) console.log(`  ${x.shot} 第 ${x.frame} 帧 ${x.subFrames} 个子帧累积的颜色层对线性平均的预言图：边缘带之外最大差 ${sci(x.linearErr)}（进记录的数；各时刻预言不全相同的像素 ${x.moving ?? 0} 个），连边缘带的 ${x.edgePixels ?? 0} 个像素一起比是 ${sci(x.wholeFrame)}`);
for (const x of auxMismatches) console.log(`  ${x.shot} 第 ${x.frame} 帧 编号层对 sub = 0、针孔、像素中心的预言图：${x.auxMismatch === null ? '量不出' : `边缘带之外对不上 ${x.auxMismatch} 个像素（进记录的数；连边缘带一共 ${x.idMismatch} 个，边缘带 ${x.edgeLimit} 个像素）`}`);
for (const x of unverified) console.log(`  没验：能力声明里列了 ${x}，这次没有夹具`);
for (const x of frameRows.filter((y) => y.want !== y.got)) console.log(`  ${x.shot} 出了颜色层的成功 render ${x.want} 次，时间核对记录的 frames 里只有 ${x.got} 项`);
for (const x of metaOnly) console.log(`  ${x.shot} 第 ${x.frame} 帧 只要元数据（${x.afterOtherFrame ? '排在别的帧后面' : '没排在别的帧后面'}）对整帧渲染的元数据：${x.differs === null ? '没有元数据可比' : x.differs.length ? `不一样的段 ${x.differs.join('、')}` : '去掉 stats、hash、timing 之后相同'}`);
for (const x of expected.filter((y) => y.want !== y.got)) console.log(`  ${x.shot} ${x.what}：期望 ${x.want}，实际 ${x.got}`);
for (const x of streams.filter((y) => !y.nameAsExpected)) console.log(`  ${x.shot} 随机流 ${x.arg}（${x.run}）：镜头代码拿到的流名是 ${x.name}`);
for (const p of problems) console.log(`  出错：${p}`);
for (const [name, v] of Object.entries(gates)) console.log(`${mark(v)} ${name}`);
console.log(`产物在 ${rel(OUT)}/：${Object.keys(hashes).length} 个层文件，${objects.filter((o) => o.format === 'meta/0.1').length} 份落盘的元数据，${Object.keys(records).length} 份核对记录，summary.json`);
process.exit(summary.ok ? 0 : 1);
