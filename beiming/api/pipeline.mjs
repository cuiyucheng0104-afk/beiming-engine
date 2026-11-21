// 渲染、核验、交付三类作业真正干活的地方。全部经各组件的公共入口：
//   帧源 sources/blender（原生 cards-data 资产镜头）和 host/page 上的 three（cards-data 镜头）；
//   kernel/eval 的事件表与镜头输入；verify 的 L1、L2（纯函数门、包围盒核对门）、L3（谓词求值、防削弱）；
//   comp 的分流拼接、混音、编码、六件套；observe 的成片量测、联系表与切点条带。
// 帧落盘的布局（每个作业一个目录，在工作区 deliver/ 下，不进修订快照）：
//   <镜头>/layers/r###-f####/{color.f32, objectId.u32}   帧源写的层文件
//   <镜头>/f<全片帧号>.meta.json                          每帧元数据 meta/0.1
//   <镜头>/exr/l<镜头局部帧号>.exr                         场景线性颜色（comp 的输入）
//   <镜头>/png/f<全片帧号>.png                             过显示变换的预览（联系表的输入）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateReview, reviewFailure } from './agents.mjs';
import { assetPaths } from './assets.mjs';
import { branchFilter, deliver as compDeliver, parseFps, runTool, tools as compTools, verifyDeliveryBundle } from '../comp/index.mjs';
import { startSource as startPage } from '../host/page/host.mjs';
import { eventsTable, shotInput } from '../kernel/eval/index.mjs';
import { audioLoudness, blackFreezeDup, buildContactSheet, buildCutStrips, cutYdif, deliverSpec } from '../observe/index.mjs';
import { startSource as startBlender } from '../sources/blender/host.mjs';
import {
  checkL1, evaluateAssertion, evaluateFloor, guardPredicates, IOU_MIN, runPureFunctionGate, toVerdict, verifySampledBboxes,
} from '../verify/index.mjs';
import { diagnostic } from './envelope.mjs';
import { BEIMING, monotonicMs, threeCardDirs, VIEW_SHAPER } from './runtime.mjs';

const pad = (n, w = 4) => String(n).padStart(w, '0');
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// cards-data 镜头不读入口文件；页面宿主只放行 beiming/ 里的目录，给它本组件的目录
const PAGE_FILM_DIR = join(BEIMING, 'api');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const coded = (code, message) => Object.assign(new Error(message), { code });

/** 一个作业里用到的帧源：按需起，作业结束 stop */
export function sourcePool({ library, blenderBin, workspace }) {
  const blenders = new Map();
  let page = null;
  return {
    async get(source, device = 'auto') {
      if (source === 'blender') {
        if (!blenderBin) throw coded('env.missing-tool', '这台服务器上没有 Blender：blender 镜头渲不了');
        if (!blenders.has(device)) {
          const cards = Object.values(library).filter(({ card }) => card.id === 'camera.spline' || card.livesIn.includes('source:blender')).map(c => c.dir);
          blenders.set(device, await startBlender({ blenderBin, assets: assetPaths(workspace), cards, device }));
        }
        return blenders.get(device);
      }
      if (source === 'three') {
        page ??= await startPage({ cards: threeCardDirs(library) }).catch((e) => { throw coded('env.missing-tool', `起不了无头浏览器：${String(e.message).split('\n')[0]}`); });
        return page;
      }
      throw coded('contract.unsupported-mode', `帧源 ${source} 这台服务器没接`);
    },
    async stop() {
      await Promise.allSettled([...Array.from(blenders.values(), b => b.stop()), page?.stop()]);
      blenders.clear();
      page = null;
    },
  };
}

const filmDirOf = (shot, filmDir) => (shot.source === 'three' ? PAGE_FILM_DIR : filmDir);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function parseHexLinear(hex) {
  if (typeof hex !== 'string' || !/^#[0-9A-F]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(hex.slice(i + 1, i + 3), 16) / 255));
}

/** 颜色层（RGBA f32 交错、预乘）→ ffmpeg 要的平面 G、B、R、A；给了 paperLinear 时把透明区域叠到纸底上 */
function planar(buf, w, h, paperLinear = null) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, w * h * 4);
  const n = w * h, out = new Float32Array(n * 4);
  if (paperLinear) {
    const [pr, pg, pb] = paperLinear;
    for (let i = 0; i < n; i++) {
      const inv = 1 - f[i * 4 + 3];
      out[i] = f[i * 4 + 1] + inv * pg; out[n + i] = f[i * 4 + 2] + inv * pb; out[2 * n + i] = f[i * 4] + inv * pr; out[3 * n + i] = 1;
    }
  } else {
    for (let i = 0; i < n; i++) {
      out[i] = f[i * 4 + 1]; out[n + i] = f[i * 4 + 2]; out[2 * n + i] = f[i * 4]; out[3 * n + i] = f[i * 4 + 3];
    }
  }
  return Buffer.from(out.buffer);
}

/** 一个镜头渲好的帧：颜色转 EXR（场景线性，comp 的输入）和 PNG（过 comp 同一条显示变换，给联系表） */
function convertShot(records, shot, { dir, fps, lutPath, paperLinear }) {
  if (!records.length) return;
  const { ffmpeg } = compTools();
  const [h, w] = records[0].shape;
  const seq = join(dir, 'seq');
  rmSync(seq, { recursive: true, force: true });
  mkdirSync(seq, { recursive: true });
  mkdirSync(join(dir, 'exr'), { recursive: true });
  mkdirSync(join(dir, 'png'), { recursive: true });
  // 按不超过 256 MiB 一批分块喂给 ffmpeg 管道，避开长镜头 1080p/4K 下 libuv spawnSync 管道上限（INT32_MAX ≈ 2 GiB）并压低内存峰值。
  const chunk = Math.max(1, Math.floor((256 * 1024 * 1024) / (w * h * 16)));
  for (let offset = 0; offset < records.length; offset += chunk) {
    const raw = Buffer.concat(records.slice(offset, offset + chunk).map((r) => planar(readFileSync(r.color), w, h, paperLinear)));
    runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gbrapf32le', '-s', `${w}x${h}`, '-i', '-',
      '-c:v', 'exr', '-compression', 'zip1', '-start_number', String(offset), join(seq, '%04d.exr')], { input: raw, what: '颜色层转 EXR' });
  }
  const filter = branchFilter({ id: shot.id, colorRef: shot.colorRef, count: records.length, transfer: 'linear' }, { size: [w, h], fps: parseFps(fps), view: { lutPath, shaper: VIEW_SHAPER } });
  runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'image2', '-framerate', fps, '-start_number', '0', '-i', join(seq, '%04d.exr'),
    '-filter_complex', `[0:v]${filter},format=rgb24[o]`, '-map', '[o]', '-start_number', '0', join(seq, '%04d.png')], { what: '预览 PNG' });
  records.forEach((r, i) => {
    r.exr = join(dir, 'exr', `l${pad(r.frame - shot.in)}.exr`);
    r.png = join(dir, 'png', `f${pad(r.frame)}.png`);
    renameSync(join(seq, `${pad(i)}.exr`), r.exr);
    renameSync(join(seq, `${pad(i)}.png`), r.png);
  });
  rmSync(seq, { recursive: true, force: true });
}

/**
 * 渲一批帧。plan：[{ shot, frames: [全片帧号] }]。交回 { records, gpuSeconds }。
 * records 每项 { frame, shot, meta, metaPath, color, objectId, shape, exr, png }（路径是绝对路径）。
 * gpuSeconds 是帧源 render 调用的耗时之和（单调时钟），帧源在显卡上出帧。
 */
export async function renderPlan({ film, lock, filmDir, tier, plan, outDir, pool, signal, lutPath, onFrame }) {
  const events = eventsTable(film);
  const records = [];
  let gpuMs = 0;
  for (const { shot, frames } of plan) {
    signal?.throwIfAborted();
    const src = await pool.get(shot.source);
    const dir = join(outDir, shot.id);
    mkdirSync(dir, { recursive: true });
    const session = await src.open(shotInput(film, shot.id, events), { lock, tier, workspace: join(dir, 'layers'), filmDir: filmDirOf(shot, filmDir) });
    const mine = [];
    try {
      for (const frame of frames) {
        signal?.throwIfAborted();
        const t0 = monotonicMs();
        const r = await session.render(frame - shot.in, {}, ['color', 'objectId', 'meta']);
        const elapsed = monotonicMs() - t0;
        gpuMs += elapsed;
        onFrame?.(elapsed / 1000);
        const metaPath = join(dir, `f${pad(frame)}.meta.json`);
        writeFileSync(metaPath, jsonBytes(r.meta));
        mine.push({ frame, shot: shot.id, meta: r.meta, metaPath, color: join(dir, 'layers', r.layers.color.file), objectId: join(dir, 'layers', r.layers.objectId.file), shape: r.layers.color.shape });
      }
    } finally {
      await session.close();
    }
    const paperLinear = shot.source === 'three' && shot.colorRef === 'display' ? parseHexLinear(film.style?.tokens?.paper) : null;
    convertShot(mine, shot, { dir, fps: film.output.fps, lutPath, paperLinear });
    records.push(...mine);
  }
  return { records, gpuSeconds: gpuMs / 1000 };
}

/** 一帧的摘要：主角的屏占、可见比例、四边留白（画幅比例）和在不在 5% 安全框里；亮度分位 */
export function frameSummary(rec, shot) {
  const m = rec.meta;
  const heroName = shot?.roles?.hero;
  const e = (m.entities ?? []).find((x) => x.name === heroName) ?? (m.entities ?? []).find((x) => x.role === 'hero');
  let hero = null;
  if (e) {
    const [w, h] = m.size;
    const margin = Math.min(e.bbox2d[0] / w, e.bbox2d[1] / h, (w - e.bbox2d[2]) / w, (h - e.bbox2d[3]) / h);
    hero = { name: e.name, pxArea: r3(e.pxArea), visible: r3(e.visible), margin: r3(margin), inside: margin >= 0.05 };
  }
  const luma = m.stats?.luma ? { p1: r3(m.stats.luma.p1), p99: r3(m.stats.luma.p99) } : null;
  return { frame: rec.frame, shot: rec.shot, hero, luma };
}

/** 渲出来的帧要给验收和观测读：存成索引（路径相对工作区） */
export function writeIndex(file, root, records, extra = {}) {
  const rel = (p) => relative(root, p).split(sep).join('/');
  const frames = records.map((r) => ({ frame: r.frame, shot: r.shot, meta: rel(r.metaPath), color: rel(r.color), objectId: rel(r.objectId), shape: r.shape, exr: rel(r.exr), png: rel(r.png) }));
  writeFileSync(file, jsonBytes({ format: 'api-render-index/0.1', ...extra, frames }));
}

/** 读回索引：records（绝对路径，带 meta） */
export function readIndex(file, root) {
  const idx = JSON.parse(readFileSync(file, 'utf8'));
  return { ...idx, records: idx.frames.map((f) => ({ ...f, metaPath: join(root, f.meta), meta: JSON.parse(readFileSync(join(root, f.meta), 'utf8')), color: join(root, f.color), objectId: join(root, f.objectId), exr: join(root, f.exr), png: join(root, f.png) })) };
}

/* ---------------- 验收 ---------------- */

/** 镜头文件：build-script / native-code 镜头的入口（相对片子目录） */
export function shotSources(film, filmDir) {
  const out = {};
  for (const s of film.shots ?? []) {
    const r = s.renderer ?? s;
    if (typeof r.entry === 'string' && existsSync(join(filmDir, r.entry))) out[s.id] = { [r.entry]: readFileSync(join(filmDir, r.entry), 'utf8') };
  }
  return out;
}

/** 考题给定的基础断言已过 question 契约，按基础项在 L3 求值。L1 的 extra 检查只针对作者追加的断言。 */
export function layerL1(film, filmDir, rev, question) {
  const required = new Set(question?.basePredicates);
  const extras = film.predicates?.extra;
  const separate = required.size && Array.isArray(extras);
  const input = separate ? { ...film, predicates: { ...film.predicates, extra: extras.filter(x => !required.has(x)) } } : film;
  const res = checkL1(input, { shotSources: filmDir ? shotSources(film, filmDir) : {}, rev });
  const diagnostics = res.diagnostics.map(d => {
    if (separate && d.fix?.op === 'set' && d.fix.path === 'predicates/extra') {
      let i = 0;
      d = { ...d, fix: { ...d.fix, value: extras.map(x => required.has(x) ? x : d.fix.value[i++]) } };
    }
    return diagnostic(d, { layer: 'L1' });
  });
  return { ok: res.ok, diagnostics, fixes: diagnostics.flatMap(d => d.fix ? [d.fix] : []), cost: res.cost };
}

/** L2：每个镜头跑纯函数门（两帧，三种出帧次序）；全部记录跑编号层包围盒核对（IoU ≥ 0.95） */
export async function layerL2({ film, lock, filmDir, shots, records, pool, scratch, signal, onGpu }) {
  const diagnostics = [];
  const gates = [];
  const events = eventsTable(film);
  let gpuMs = 0;
  for (const shot of shots) {
    signal?.throwIfAborted();
    const frames = [shot.in, shot.out - 1];
    if (frames[0] === frames[1]) { gates.push({ shot: shot.id, status: 'skipped', reason: '纯函数门至少需要两帧' }); continue; }
    const src = await pool.get(shot.source, 'cpu');
    let n = 0;
    const adapter = {
      open: async () => {
        const ws = join(scratch, `${shot.id}-gate-${n++}`);
        const s = await src.open(shotInput(film, shot.id, events), { lock, tier: 'draft', workspace: ws, filmDir: filmDirOf(shot, filmDir) });
        return {
          render: async (frame) => {
            signal?.throwIfAborted();
            const t0 = monotonicMs();
            const r = await s.render(frame - shot.in, {}, ['color']);
            const elapsed = monotonicMs() - t0;
            gpuMs += elapsed;
            onGpu?.(elapsed / 1000);
            const b = readFileSync(join(ws, r.layers.color.file));
            return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
          },
          close: () => s.close(),
        };
      },
    };
    const g = await runPureFunctionGate(adapter, frames, { compare: 'hash', seed: 1 });
    gates.push({ shot: shot.id, status: g.ok ? 'pass' : 'fail', ok: g.ok, bitExact: g.bitExact, frames: g.frames, mismatches: g.mismatches.length });
    if (!g.ok) {
      diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L2', at: `shots/${shot.id}`, message: `纯函数门没过：同一帧顺序渲、乱序渲、单独渲的颜色层不逐位相同（${g.mismatches.length} 处）`,
        atFrames: g.mismatches.map((m) => m.frame).filter(Number.isInteger), evidence: JSON.stringify(g.mismatches[0]).slice(0, 200), hint: '镜头里有跨帧状态或没带种子的随机：每帧只由时刻决定' }, { layer: 'L2' }));
    }
  }
  const framesData = records.map((r) => {
    const b = readFileSync(r.objectId);
    const [h, w] = r.shape;
    return { frame: r.frame, meta: r.meta, objectId: { width: w, height: h, data: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + w * h * 4)) } };
  });
  const bb = framesData.length ? verifySampledBboxes(framesData) : { ok: false, minIou: null, failures: [{ kind: 'no-samples' }] };
  for (const f of bb.failures.slice(0, 5)) {
    diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L2', message: `包围盒核对没过：${f.kind}${f.name ? `（${f.name}）` : ''}${Number.isFinite(f.iou) ? `，IoU ${r3(f.iou)} < ${IOU_MIN}` : ''}`,
      ...(Number.isInteger(f.frame) ? { atFrames: [f.frame] } : {}), expected: `元数据 bbox2d 和编号层反算的包围盒 IoU ≥ ${IOU_MIN}` }, { layer: 'L2' }));
  }
  return { ok: gates.length > 0 && gates.every(g => g.ok || g.status === 'skipped') && bb.ok, gates, bbox: { ok: bb.ok, minIou: r3(bb.minIou), frames: framesData.length, failures: bb.failures.length }, diagnostics, gpuSeconds: gpuMs / 1000 };
}

const finiteAudio = (v, floor = -120) => (typeof v === 'number' ? (Number.isFinite(v) ? v : v === -Infinity ? floor : undefined) : undefined);

/** 成片量测：交付规格、响度、黑帧与冻结、切点（YDIF） */
export async function measureMaster(master) {
  const [spec, loud, bfd, cuts] = await Promise.all([deliverSpec(master), audioLoudness(master).catch(() => null), blackFreezeDup(master), cutYdif(master)]);
  const loudnessLufs = finiteAudio(loud?.value);
  const truePeakDbtp = finiteAudio(loud?.details?.truePeakDbtp);
  const audio = {
    ...(loudnessLufs !== undefined ? { loudnessLufs } : {}),
    ...(truePeakDbtp !== undefined ? { truePeakDbtp } : {}),
  };
  return {
    output: spec.value ? { size: [spec.value.width, spec.value.height], fps: spec.details.frameRate, frames: spec.value.frames, colorTag: spec.value.color_space } : undefined,
    blackFrames: bfd.details?.black, freezes: bfd.details?.freezes?.map(([a, b]) => ({ in: a, out: b + 1 })),
    ...(Object.keys(audio).length ? { audio } : {}),
    cuts: cuts.value,
  };
}

const fixOfResult = (r) => (r.fixes ?? []).find((f) => f && typeof f.path === 'string');

/**
 * L3：floor@1（加题目自带的基础谓词）逐条求值、predicates.extra 逐条求值、防削弱守卫。
 * measured 是 { frames: [{ frame, meta }], ...成片量测 }。question 是考题（可以是 null）。entities 是 { 镜头: [实体名] }。
 */
export function layerL3({ film, measured, question, entities }) {
  const diagnostics = [];
  const verdicts = [];
  const add = (result, base) => {
    const v = toVerdict(result, { base });
    if (v.value === null || (typeof v.value === 'number' && !Number.isFinite(v.value))) delete v.value;
    verdicts.push(v);
    if (result.status === 'fail') {
      const fix = fixOfResult(result);
      diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L3', message: `${result.predicate} 判不过`, ...(v.atFrames ? { atFrames: v.atFrames } : {}),
        ...(v.value !== undefined ? { value: v.value } : {}), ...(result.expected ? { expected: String(result.expected) } : {}), ...(fix ? { fix, at: fix.path } : {}) }, { layer: 'L3' }));
    }
  };
  const conditionalSkips = new Set();
  for (const item of evaluateFloor(film, measured)) {
    if (item.status === 'skipped' && !item.results.length) {
      const v = { id: `pred.${item.expr.split('(')[0]}`, layer: 'L3', status: 'skipped', base: true, reason: item.reason };
      conditionalSkips.add(v);
      verdicts.push(v);
    }
    for (const r of item.results) add(r, true);
  }
  const required = new Set(question?.basePredicates ?? []);
  let requiredPass = true;
  for (const text of required) {
    const result = evaluateAssertion(text, film, measured);
    add(result, true);
    if (result.status !== 'pass') requiredPass = false;
    if (result.status === 'skipped') diagnostics.push(diagnostic({ layer: 'L3', message: `考题必验断言 ${text} 缺少证据`, hint: result.reason }));
  }
  for (const text of film.predicates?.extra ?? []) if (!required.has(text)) add(evaluateAssertion(text, film, measured), false);
  const guard = guardPredicates(film, question ? { base: question.basePredicates } : null, { entities });
  for (const v of guard.violations) {
    const fix = v.fixes?.[0];
    diagnostics.push(diagnostic({ code: v.path === 'predicates/base' ? 'auth.base-readonly' : 'contract.bad-value', layer: 'L3', at: v.path, message: `防削弱：${v.code}：${v.message}`, ...(v.hint ? { hint: v.hint } : {}), ...(fix ? { fix } : {}) }, { layer: 'L3' }));
  }
  for (const u of guard.unverified) diagnostics.push(diagnostic({ code: 'contract.bad-value', layer: 'L3', severity: 'warning', at: u.path, message: u.message }, { layer: 'L3', severity: 'warning' }));
  const base = verdicts.filter((v) => v.base);
  const count = (list, s) => list.filter((v) => v.status === s).length;
  return {
    ok: requiredPass && !verdicts.some((v) => v.status === 'fail') && guard.ok,
    basePass: requiredPass && count(base, 'fail') === 0 && guard.ok && !base.some(v => v.status === 'skipped' && !conditionalSkips.has(v)),
    summary: { base: `${count(base, 'pass')}/${base.length}`, baseFail: count(base, 'fail'), skipped: count(verdicts, 'skipped'), extra: `${count(verdicts.filter((v) => !v.base), 'pass')}/${verdicts.filter((v) => !v.base).length}`, guard: guard.ok ? 'pass' : 'fail' },
    verdicts, diagnostics,
  };
}

/** 帧元数据里每个镜头交出的实体名（给防削弱守卫核 hero） */
export const entitiesOf = (records) => {
  const out = {};
  for (const r of records) {
    out[r.shot] ??= new Set();
    for (const e of r.meta.entities ?? []) out[r.shot].add(e.name);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].filter(Boolean)]));
};

/* ---------------- 审片（L5） ---------------- */

/**
 * 审片的输入：需求原文、联系表、切点条带、声音量测表。reviewer 没配置时 status 是 not-run，写明原因；
 * 配置了就交给它，意见原样带回；L5 只是意见，不改硬门的判定。
 */
export async function layerL5({ reviewer, brief, images, loudness, film }) {
  if (!reviewer) return { status: 'not-run', reason: '服务器没有配置异族视觉审片模型（BEIMING_REVIEW_ENDPOINT、BEIMING_REVIEW_API_KEY、BEIMING_REVIEW_MODEL）', opinions: [], suggestedPredicates: [], overridesHardGates: false };
  try {
    const res = await reviewer.review({ brief, images, loudness, film: { id: film.id, output: film.output, shots: film.shots.map((s) => ({ id: s.id, in: s.in, out: s.out })) } });
    return { status: 'ok', model: res.model, ...validateReview(res, film.output.frames), usage: res.usage ?? null, overridesHardGates: false };
  } catch (e) {
    return { status: 'failed', reason: reviewFailure(e), opinions: [], suggestedPredicates: [], overridesHardGates: false };
  }
}

/** 审片材料：联系表 + 切点条带（从成片取） */
export function reviewMaterials({ master, fps, film, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const images = [];
  const sheet = buildContactSheet({ video: master, fps, out: join(outDir, 'contact.png'), count: 12, cellWidth: 160 });
  if (sheet.ok) images.push({ name: 'contact', path: sheet.outputs[0] });
  if ((film.transitions ?? []).length) {
    const strips = buildCutStrips({ video: master, fps, transitions: film.transitions, outDir: join(outDir, 'cuts') });
    if (strips.ok) for (const p of strips.outputs ?? []) images.push({ name: 'cut', path: p });
  }
  return images;
}

/* ---------------- 交付 ---------------- */

/** 六件套：final 档全部帧的 EXR 序列 → comp.deliver */
export function deliverBundle({ film, lock, records, lutPath, outDir }) {
  const frames = {};
  for (const shot of film.shots) {
    const mine = records.filter((r) => r.shot === shot.id);
    if (mine.length !== shot.out - shot.in) throw coded('contract.delivery-mismatch', `镜头 ${shot.id} 终渲帧数 ${mine.length}，应为 ${shot.out - shot.in}`);
    frames[shot.id] = { pattern: join(mine[0].exr, '..', 'l%04d.exr'), start: 0, kind: 'exr', transfer: 'linear' };
  }
  return compDeliver({ film, events: eventsTable(film), lock, frames, view: { lutPath, shaper: VIEW_SHAPER }, outDir, tier: 'final' });
}

/**
 * 把 L2–L5 的复核写进 report.json 的 verification 键，再照 comp 的完整性规则重新锚定：
 * run.json 的 reportBodySha256 换成新报告正文（不含 run.json 那一项）的摘要，报告里 run.json 的字节数与摘要跟着更新。
 * 写完用 comp 的 verifyDeliveryBundle 自查一遍。
 */
export function writeVerification(dir, verification) {
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  report.verification = verification;
  const body = { ...report, files: { ...report.files } };
  delete body.files['run.json'];
  run.reportBodySha256 = sha256(jsonBytes(body));
  const runBytes = jsonBytes(run);
  writeFileSync(join(dir, 'run.json'), runBytes);
  report.files = { ...report.files, 'run.json': { bytes: runBytes.length, sha256: sha256(runBytes) } };
  writeFileSync(join(dir, 'report.json'), jsonBytes(report));
  return verifyDeliveryBundle(dir);
}


export const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
