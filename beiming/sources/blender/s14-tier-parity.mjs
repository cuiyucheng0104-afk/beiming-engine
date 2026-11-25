// S14：同一 Blender 镜头的跨档证据对拍。亮度取正式 AgX 显示变换之后、编码之前的 RGB。
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bakeAgxLut, SHAPER } from '../../comp/lut/bake-agx.mjs';
import { escapeFilterValue, runTool, shaperFilter, tools } from '../../comp/stitch.mjs';
import { clipHighlightRatio } from '../../observe/metrics/energy-rulers.mjs';
import { lumaPercentile } from '../../observe/metrics/luma-ghost.mjs';
import { writeExr } from '../../verify/exr/exr.mjs';
import { checkAssertion, evaluateAssertion } from '../../verify/predicates.mjs';
import { findBlender, SourceError, startSource } from './host.mjs';

const PERCENTILES = ['p01', 'p50', 'p99'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const frameId = value => Number.isSafeInteger(value) && value >= 0;
const dimension = value => Number.isSafeInteger(value) && value > 0;
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;

function requireValue(ok, message) {
  if (!ok) throw new SourceError('usage.bad-argument', message);
}

function checkSize(size, label) {
  requireValue(Array.isArray(size) && size.length === 2 && dimension(size[0]) && dimension(size[1]),
    `${label} size 必须是 [宽, 高] 两个正整数`);
}

function normalizedBox(box, size, label) {
  requireValue(Array.isArray(box) && box.length === 4 && [...box].every(Number.isFinite),
    `${label} bbox2d 必须包含四个有限的像素坐标`);
  const [x0, y0, x1, y1] = box, [w, h] = size;
  requireValue(0 <= x0 && x0 <= x1 && x1 <= w && 0 <= y0 && y0 <= y1 && y1 <= h,
    `${label} bbox2d 坐标次序错误或超出画幅 ${w}×${h}`);
  return [x0 / w, y0 / h, x1 / w, y1 / h];
}

function iou(a, b) {
  const [ax0, ay0, ax1, ay1] = a, [bx0, by0, bx1, by1] = b;
  const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) *
    Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  return overlap === 0 ? 0 : overlap / ((ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - overlap);
}

/** 两个画内像素包围盒各按自己的 [宽, 高] 归一。零面积或无交集返回 0。 */
export function normalizedBboxIou(bboxA, sizeA, bboxB, sizeB) {
  checkSize(sizeA, 'A');
  checkSize(sizeB, 'B');
  return iou(normalizedBox(bboxA, sizeA, 'A'), normalizedBox(bboxB, sizeB, 'B'));
}

function roleNames(roles = {}, label) {
  requireValue(record(roles), `${label} roles 必须是对象`);
  const { hero, mustSee = [] } = roles;
  requireValue(hero === undefined || nonempty(hero), `${label} roles.hero 必须是非空实体名`);
  requireValue(Array.isArray(mustSee) && [...mustSee].every(nonempty), `${label} roles.mustSee 必须是实体名数组`);
  return hero === undefined ? [...mustSee] : [hero, ...mustSee];
}

function frameEvidence(row, tier, index, previous) {
  const meta = row?.meta, frame = meta?.frame;
  requireValue(frameId(frame) && frame > previous, `${tier}.frames[${index}] meta.frame 帧号须为严格递增的非负整数`);
  const label = `${tier} 第 ${frame} 帧`;
  checkSize(meta.size, label);
  requireValue(Array.isArray(meta.entities), `${label} 缺 meta.entities 数组`);
  const entities = new Map();
  for (const entity of meta.entities) {
    requireValue(nonempty(entity?.name) && !entities.has(entity.name), `${label} 实体名缺失或重复`);
    entities.set(entity.name, entity);
  }
  for (const key of PERCENTILES) requireValue(unit(row.luma?.[key]), `${label} luma.${key} 必须是 [0, 1] 内的有限数`);
  return { frame, label, entities, size: meta.size };
}

function predicateParity(draft, final) {
  for (const [tier, list] of Object.entries({ draft, final })) {
    requireValue(Array.isArray(list) && list.length > 0, `${tier}.predicates 必须是非空结果数组`);
    const seen = new Set();
    for (const [i, result] of list.entries()) {
      requireValue(nonempty(result?.id) && !seen.has(result.id) && typeof result.pass === 'boolean',
        `${tier}.predicates[${i}] 需要唯一的 id 和布尔 pass`);
      seen.add(result.id);
    }
  }
  requireValue(draft.length === final.length, 'draft 与 final 的基础谓词数量不匹配');
  const diffs = [];
  for (const [index, a] of draft.entries()) {
    const b = final[index];
    if (a.id !== b.id || a.pass !== b.pass) diffs.push({ index, draft: a, final: b });
  }
  return { pass: diffs.length === 0, diffs, draft, final };
}

/**
 * 各档交 { predicates: [{ id, pass, … }], frames: [{ meta, luma, … }], roles?: { hero?, mustSee? } }。
 * meta 带全片帧号、像素尺寸、实体名和 bbox2d。luma 带 p01、p50、p99 的显示亮度。
 * 帧与谓词按顺序配对。两档任一帧标注角色的实体及显式绑定，在每帧两档都须具备包围盒。
 */
export function compareDraftFinalTiers({ draft, final, minBboxIou = 0.95, maxLumaPctDiff = 0.05 } = {}) {
  requireValue(unit(minBboxIou), 'minBboxIou 必须是 [0, 1] 内的有限数');
  requireValue(unit(maxLumaPctDiff), 'maxLumaPctDiff 必须是 [0, 1] 内的有限数');
  requireValue(Array.isArray(draft?.frames) && Array.isArray(final?.frames), 'draft.frames 和 final.frames 必须是数组');
  requireValue(draft.frames.length > 0 && draft.frames.length === final.frames.length, 'draft 与 final 的帧数必须相同且大于 0');
  const predicates = predicateParity(draft.predicates, final.predicates);
  const names = new Set([...roleNames(draft.roles, 'draft'), ...roleNames(final.roles, 'final')]);
  let hasHero = Boolean(draft.roles?.hero ?? final.roles?.hero), previous = -1;
  const pairs = Array.from(draft.frames, (d, index) => {
    const f = final.frames[index];
    const a = frameEvidence(d, 'draft', index, previous), b = frameEvidence(f, 'final', index, previous);
    requireValue(a.frame === b.frame, `第 ${index + 1} 项帧号不匹配：draft ${a.frame}，final ${b.frame}`);
    previous = a.frame;
    for (const { entities } of [a, b]) for (const entity of entities.values()) {
      if (nonempty(entity.role)) names.add(entity.name);
      if (entity.role === 'hero') hasHero = true;
    }
    return { a, b, d, f };
  });
  requireValue(hasHero, '缺 hero 实体或 roles.hero 绑定');
  const selected = [...names].sort();
  const bboxViolations = [], lumaViolations = [], maxDiffs = { p01: 0, p50: 0, p99: 0 };
  let worst;
  const frames = pairs.map(({ a, b, d, f }) => {
    const { frame } = a;
    const boxFor = (e, name) => {
      requireValue(e.entities.has(name), `${e.label} 缺角色实体 ${name}`);
      return normalizedBox(e.entities.get(name).bbox2d, e.size, `${e.label} 实体 ${name}`);
    };
    const bbox = selected.map(entity => {
      const value = iou(boxFor(a, entity), boxFor(b, entity));
      const result = { frame, entity, iou: value };
      if (!worst || value < worst.iou) worst = result;
      if (value < minBboxIou) bboxViolations.push(result);
      return { entity, iou: value };
    });
    const lumaDiffs = {};
    for (const percentile of PERCENTILES) {
      const x = d.luma[percentile], y = f.luma[percentile], diff = Math.abs(x - y);
      lumaDiffs[percentile] = diff;
      maxDiffs[percentile] = Math.max(maxDiffs[percentile], diff);
      // 比较值本身和上界，避免 0.55 − 0.50 因二进制舍入变成略大于 0.05。
      if (Math.max(x, y) > Math.min(x, y) + maxLumaPctDiff) {
        lumaViolations.push({ frame, percentile, draft: x, final: y, diff });
      }
    }
    return { frame, draft: d, final: f, bbox, lumaDiffs };
  });
  const bbox = { pass: bboxViolations.length === 0, minBboxIou, minIou: worst.iou, worstFrame: worst.frame,
    worstEntity: worst.entity, violations: bboxViolations };
  const luma = { pass: lumaViolations.length === 0, maxLumaPctDiff, maxDiffs, violations: lumaViolations };
  return { pass: predicates.pass && bbox.pass && luma.pass, predicates, bbox, luma, frames };
}

/** 场景线性 EXR → 显示编码 RGB24。保留原帧尺寸，返回 lumaPercentile 的内存帧形状。 */
export function exrToDisplayLumaFrame(exrPath, { lutPath, shaper, width, height } = {}) {
  checkSize([width, height], 'EXR');
  requireValue(nonempty(exrPath) && nonempty(lutPath), '必须给出 EXR 与 AgX LUT 的路径');
  const filter = ['format=gbrpf32le', shaperFilter(shaper),
    `lut3d=file=${escapeFilterValue(resolve(lutPath))}:interp=tetrahedral`, 'format=rgb24'].join(',');
  const { stdout } = runTool(tools().ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'image2',
    '-pattern_type', 'none', '-i', resolve(exrPath), '-vf', filter, '-frames:v', '1', '-c:v', 'ppm', '-f', 'image2pipe', '-'],
  { what: 'EXR 经 AgX 转显示 RGB' });
  // PPM 头同时核实宽高，避免相同像素数的错尺寸被当作有效 RGB。
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  if (stdout.length !== header.length + width * height * 3 || !stdout.subarray(0, header.length).equals(header)) {
    throw new SourceError('contract.bad-value', `EXR 显示帧尺寸或字节数与 ${width}×${height} RGB24 不符`);
  }
  return { width, height, channels: 3, data: stdout.subarray(header.length) };
}

async function fileInside(dir, path) {
  requireValue(nonempty(path) && !isAbsolute(path), '镜头入口及层引用必须是相对路径');
  const check = (target) => {
    const rel = relative(dir, target);
    requireValue(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `路径 ${path} 越出工作目录`);
  };
  const target = resolve(dir, path);
  check(target);
  const actual = await realpath(target);
  check(actual);
  return actual;
}

async function wrapLinearExr(workspace, color, meta, exrPath) {
  const [width, height] = meta.size, n = width * height;
  const bytes = await readFile(await fileInside(workspace, color.file));
  if (bytes.length !== n * 16) throw new SourceError('contract.bad-value', `第 ${meta.frame} 帧线性 RGBA 层的字节数不符`);
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  const planes = [R, G, B, A];
  for (let i = 0, offset = 0; i < n; i++) for (const plane of planes) {
    const value = bytes.readFloatLE(offset);
    if (!Number.isFinite(value)) throw new SourceError('contract.bad-value', `第 ${meta.frame} 帧线性 RGBA 层含非有限数`);
    plane[i] = value;
    offset += 4;
  }
  await writeFile(exrPath, writeExr({ width, height, channels: { R, G, B, A }, compression: 2 }));
}

function checkPredicates(predicates) {
  requireValue(Array.isArray(predicates) && predicates.length > 0, 'predicates 必须是非空断言数组');
  const ids = new Set();
  for (const spec of predicates) {
    requireValue(nonempty(spec?.id) && !ids.has(spec.id), 'predicates 的每一项需要唯一的 id');
    ids.add(spec.id);
    if (spec.expr === undefined) {
      requireValue(spec.query?.kind === 'belowGround', `谓词 ${spec.id} 需要 expr 或 belowGround 查询`);
      continue;
    }
    const check = checkAssertion(spec.expr);
    requireValue(check.ok, `谓词 ${spec.id}：${check.errors.map(error => error.message).join('；')}`);
  }
}

async function renderTier(source, input, { tier, opts, dir, frames, lutPath, shaper, predicates }) {
  const workspace = join(dir, tier);
  await mkdir(workspace);
  const session = await source.open(input, { lock: null, tier, filmDir: dir, workspace });
  const film = { ...input, output: { ...input.output, frames: input.shot.out }, shots: [input.shot] };
  const shotFrames = [];
  const evidence = predicates.map(() => []);
  for (const f of frames) {
    const { meta, layers } = await session.render(f, opts, ['color', 'meta']);
    const [width, height] = meta.size;
    const exrPath = join(workspace, `${f}.exr`);
    await wrapLinearExr(workspace, layers.color, meta, exrPath);
    const display = exrToDisplayLumaFrame(exrPath, { lutPath, shaper, width, height });
    const [luma] = lumaPercentile([{ ...display, frame: meta.frame }]).perFrame;
    const highlightClipRatio = clipHighlightRatio(display).ratio;
    shotFrames.push({ meta, luma, highlightClipRatio });
    for (const [i, { query }] of predicates.entries()) if (query) {
      evidence[i].push({ frame: meta.frame, result: await session.query(f, query) });
    }
  }
  await session.close();
  const measured = {
    frames: shotFrames.map(({ meta }) => ({ frame: meta.frame, meta: { ...meta, stats: { ...meta.stats, luma: undefined } } })),
    lumaPercentile: { perFrame: shotFrames.map(row => row.luma) },
    highlightClipRatio: { perFrame: shotFrames.map(row => ({ frame: row.meta.frame, value: row.highlightClipRatio })) },
  };
  const results = predicates.map(({ id, expr }, i) => {
    const queries = evidence[i];
    if (expr === undefined) return { id, pass: queries.every(({ result }) => result.items.length === 0), queries };
    const verdict = evaluateAssertion(expr, film, { ...measured, queries });
    if (verdict.status === 'skipped') throw new SourceError('contract.bad-value', `${tier} 谓词 ${id} 缺量测：${verdict.reason}`);
    return { id, pass: verdict.ok, verdict };
  });
  return { frames: shotFrames, predicates: results, roles: input.shot.roles };
}

/**
 * shotBuilder({ workDir }) 只调用一次：在独立工作目录准备 build-script，返回 Blender 宿主的 ShotInput。
 * frames 是严格递增的镜头局部帧号。roles 覆盖镜头里的角色绑定，档位选项传给宿主 render。
 * predicates 按顺序给 { id, expr, query? }，或给 { id, query: { kind: 'belowGround', … } } 直接检查 S12 查询。
 * 返回 compareDraftFinalTiers 的报告。保留 meta/0.1 和量测读数，渲染文件随工作目录清理。
 */
export async function runBlenderTierParity({ blenderBin = findBlender(), shotBuilder, frames, draftRenderOpts = {}, finalRenderOpts = {}, predicates, roles, workDir } = {}) {
  requireValue(typeof shotBuilder === 'function' && nonempty(workDir), '需要 shotBuilder 函数和 workDir 路径');
  requireValue(Array.isArray(frames) && frames.length > 0 && [...frames].every((f, i) => frameId(f) && (!i || f > frames[i - 1])),
    'frames 必须是非空且严格递增的镜头局部帧号数组');
  checkPredicates(predicates);
  await mkdir(workDir, { recursive: true });
  const dir = await mkdtemp(join(await realpath(workDir), 's14-'));
  let source;
  try {
    const built = await shotBuilder({ workDir: dir });
    const shot = built?.shot, renderer = shot?.renderer ?? shot;
    requireValue(renderer?.source === 'blender' && renderer.host === 'cycles' && renderer.mode === 'build-script' && shot.colorRef === 'scene',
      'shotBuilder 须交 Blender Cycles build-script 镜头，colorRef 为 scene');
    requireValue(frameId(shot.in) && frameId(shot.out) && frames.at(-1) < shot.out - shot.in, 'frames 含超出镜头 [in, out) 的局部帧号');
    await fileInside(dir, renderer.entry);
    checkSize(built.output?.size, 'shotBuilder.output');
    const bindings = { ...shot.roles, ...roles };
    roleNames(bindings, 'shotBuilder');
    const input = { ...built, shot: { ...shot, roles: bindings } };

    source = await startSource({ blenderBin, device: 'cpu', limitMs: 120000 });
    const { version } = source.caps();
    if (!/^5\.2\.\d+\b/.test(version)) throw new SourceError('contract.unsupported-input', `S14 需要 Blender 5.2，实际 ${version}`);
    const lutPath = join(dir, 'agx-mhc.cube');
    await bakeAgxLut({ blenderBin, outPath: lutPath });
    const shaper = { minEv: SHAPER.minStops, maxEv: SHAPER.maxStops, mid: SHAPER.midGray };
    const common = { dir, frames, lutPath, shaper, predicates };
    const draft = await renderTier(source, input, { ...common, tier: 'draft', opts: draftRenderOpts });
    const final = await renderTier(source, input, { ...common, tier: 'final', opts: finalRenderOpts });
    return compareDraftFinalTiers({ draft, final });
  } finally {
    try { await source?.stop(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
