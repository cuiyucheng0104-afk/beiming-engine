// 空间真值查询：从每帧元数据（meta/0.1）回答代理检视时问的四类空间问题，回答压在固定的 token 预算里。
//   query(metas, request)   metas 是 meta/0.1 对象、它们的数组，或「帧号 → 对象」的映射；request.type 是下面四种之一：
//     entities  某一帧各实体的归一化边距、屏幕包围盒、屏占、可见比例、三维包围盒、平面深度范围
//     framing   按角色（hero、mustSee）或实体名，跨帧统计最小边距、屏占峰谷、出画、遮挡风险
//     texts     某一帧的文字框：像素与归一化位置、相邻文字框最小间距、越界
//     stats     画面亮度分位数、溢出与压死比例、明暗对比摘要
//   成功返回 { ok: true, query, ... }；参数不对返回 { ok: false, error: { code, message } }，码取自错误码表，不抛异常。
// 口径：像素坐标原点在左上；边距 margins 按 [左, 上, 右, 下] 排，是到画边的距离除以画宽或画高，负数表示伸出画面；
//   屏占、可见比例照抄元数据；bbox3d 和 depth 单位是米；亮度是元数据 stats 里的线性编码值，不另换算。
// 预算：回答序列化成 JSON 后 estimateTokens ≤ 400 且字符数 ≤ 1400；超了就逐级去细节、从尾部丢条目，最后保底只留计数。

import Ajv2020 from 'ajv/dist/2020.js';
import metaSchema from '../kernel/contracts/meta/schema/meta.schema.json' with { type: 'json' };
import { checks } from '../kernel/contracts/meta/check.mjs';

const validateMeta = new Ajv2020({ strict: false, strictNumbers: true, ownProperties: true }).compile(metaSchema);
export const QUERY_TYPES = Object.freeze(['entities', 'framing', 'texts', 'stats']);
export const TOKEN_LIMIT = 400;
export const CHAR_LIMIT = 1400;
// 实体数超过这个数时先按异常严重度排序再截断
export const ENTITY_CAP = 20;
// 可见比例低于它算遮挡风险；屏占低于它算过小（无单位，占画面面积的比例）
export const LOW_VISIBLE = 0.5;
export const SMALL_AREA = 0.001;

/** 保守的 token 估算：UTF-8 字节数除以 3.5 向上取整 */
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') / 3.5);
}

/** 文本是否同时满足 token 和字符两条上限 */
export function withinBudget(text, tokens = TOKEN_LIMIT, chars = Math.round(tokens * 3.5)) {
  return estimateTokens(text) <= tokens && String(text).length <= chars;
}

function fail(message, hint) {
  return { ok: false, error: { code: 'usage.bad-argument', message, ...(hint ? { hint } : {}) } };
}

const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : v ?? null);
// 只在完整字符串装不下时使用，按 Unicode 码点保留首尾。
function clip(s, limit) {
  if (s.length <= limit) return s;
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  const left = Math.floor(limit / 2);
  return chars.slice(0, left).join('') + '…' + chars.slice(left + 1 - limit).join('');
}
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 把输入整理成按帧号排好的 meta/0.1 数组；不合格返回字符串说明 */
export function normalizeMetas(input) {
  let list;
  if (Array.isArray(input)) list = input;
  else if (isPlain(input) && Object.hasOwn(input, 'format')) list = [input];
  else if (isPlain(input)) list = Object.keys(input).map((k) => input[k]);
  else return '元数据必须是 meta/0.1 对象、数组或帧号映射';
  if (list.length === 0) return '元数据是空的';
  for (const [i, m] of list.entries()) {
    if (!validateMeta(m)) {
      const { instancePath, message } = validateMeta.errors[0];
      return `第 ${i} 项 ${instancePath || '/'} ${message}`;
    }
    for (const [rule, check] of Object.entries(checks)) {
      const issues = check(m);
      if (issues.length) return `第 ${i} 项违反 ${rule}：${clip(issues[0], 100)}`;
    }
    for (const e of [...(m.entities ?? []), ...(m.texts ?? [])]) {
      if (!isBox(e.bbox2d)) return `第 ${m.frame} 帧的 bbox2d 边界顺序有误`;
    }
  }
  return [...list].sort((a, b) => a.frame - b.frame);
}

/** 归一化边距 [左, 上, 右, 下]：到画边的距离除以画宽或画高，负数表示伸出画面 */
export function margins(bbox, [w, h]) {
  return [bbox[0] / w, bbox[1] / h, (w - bbox[2]) / w, (h - bbox[3]) / h];
}

/** 一个实体在一帧里的异常：出画（含部分伸出）、可见比例低、屏占过小 */
export function entityFlags(e, size) {
  const m = margins(e.bbox2d, size);
  const flags = [];
  if (m.some((v) => v < 0)) flags.push('outsideFrame');
  if (typeof e.visible === 'number' && e.visible < LOW_VISIBLE) flags.push('lowVisible');
  if (typeof e.pxArea === 'number' && e.pxArea < SMALL_AREA) flags.push('small');
  return flags;
}

/** 严重度：出画 3 > 可见度低 2 > 屏占过小 1 > 正常 0 */
export function severity(flags) {
  if (flags.includes('outsideFrame')) return 3;
  if (flags.includes('lowVisible')) return 2;
  if (flags.includes('small')) return 1;
  return 0;
}

function pickFrame(metas, frame) {
  if (frame === undefined) return metas[0];
  return metas.find((m) => m.frame === frame) ?? null;
}

// 依次加入排序后的证据，最终序列化（含标记、引用表）的大小决定边界。
function fitList(build, items) {
  let best = build([], items.length > 0);
  for (let n = 1; n <= items.length; n++) {
    const candidate = build(items.slice(0, n), n < items.length);
    if (!withinBudget(JSON.stringify(candidate))) break;
    best = candidate;
  }
  return best;
}

// 空间观测相同的实体可共享 values 表中的一行，通过 valueIndex 解引用。
function fitEntities(head, rows, slim, countAnomalies) {
  const fit = (list, shared, shortened) => fitList((prefix, cut) => {
    const result = { ...head(prefix.length, cut || shortened), entities: prefix };
    if (!shared) return result;
    const indices = new Map();
    result.values = [];
    result.entities = prefix.map(({ name, ...value }) => {
      const key = JSON.stringify(value);
      if (!indices.has(key)) {
        indices.set(key, result.values.length);
        result.values.push(value);
      }
      return { name, valueIndex: indices.get(key) };
    });
    return result;
  }, list);
  let best = fit(rows, false, false);
  const reduced = rows.map(slim);
  for (const [list, shared] of [[rows, true], [reduced, false], [reduced, true]]) {
    if (best.returnedEntities === rows.length) break;
    const candidate = fit(list, shared, false);
    if (candidate.returnedEntities > best.returnedEntities) best = candidate;
  }
  const fitGroups = (list, shortened) => fitList((prefix, cut) => {
    const groups = new Map();
    for (const { name, ...value } of prefix) {
      const key = JSON.stringify(value);
      if (!groups.has(key)) groups.set(key, { names: [], ...value });
      groups.get(key).names.push(name);
    }
    return { ...head(prefix.length, cut || shortened), entityGroups: [...groups.values()] };
  }, list);
  // 先压缩重复读数，其次只列异常种类。名字最后才压缩。
  const evidence = rows.map(({ name, flags, out, small, occlusionRisk }) =>
    out === undefined ? { name, flags: flags ?? [] } : { name, out, small, occlusionRisk });
  for (const list of [rows, reduced, evidence]) {
    if (best.returnedEntities >= countAnomalies) break;
    const candidate = fitGroups(list, list !== rows);
    if (candidate.returnedEntities > best.returnedEntities) best = candidate;
  }
  if (best.returnedEntities < Math.min(rows.length, Math.max(countAnomalies, 1))) {
    const names = new Map();
    for (const [index, row] of rows.entries()) {
      const name = clip(row.name, 32);
      // 长名字的中段可能是唯一差异，用排序序号消除同一摘要内的歧义。
      names.set(row.name, name === row.name ? name : name.replace('…', `…${index}…`));
    }
    for (const list of [rows, reduced, evidence]) {
      const compact = list.map(row => ({ ...row, name: names.get(row.name) }));
      for (const candidate of [fit(compact, false, true), fitGroups(compact, true)]) {
        if (candidate.returnedEntities > best.returnedEntities) best = candidate;
      }
      if (best.returnedEntities === rows.length) break;
    }
  }
  return best;
}

function queryEntities(metas, req) {
  const m = pickFrame(metas, req.frame);
  if (!m) return fail(`没有第 ${req.frame} 帧的元数据`);
  const omitted = m.omittedParts === undefined ? {} : { omittedParts: m.omittedParts };
  if (m.entities === null) return { ok: true, query: 'entities', frame: m.frame, entities: null, ...omitted, note: '这一帧的帧源交不出实体' };
  const rows = m.entities.map((e, i) => {
    const flags = entityFlags(e, m.size);
    return { i, sev: severity(flags), e, flags };
  });
  rows.sort((a, b) => b.sev - a.sev || a.i - b.i);
  const total = rows.length;
  const anomalies = rows.filter(r => r.sev > 0).length;
  const capped = rows.slice(0, Math.max(ENTITY_CAP, anomalies));
  const head = (returned, cut) => ({
    ok: true, query: 'entities', frame: m.frame, size: m.size, marginOrder: 'ltrb',
    totalEntities: total, returnedEntities: returned, truncated: cut || returned < total,
    anomalies, ...omitted,
  });
  const views = capped.map(({ e, flags }) => ({
    name: e.name, ...(e.role && { role: e.role }), ...(flags.length && { flags }),
    margins: margins(e.bbox2d, m.size).map(v => round(v, 3)), bbox2d: e.bbox2d.map(v => round(v, 1)),
    pxArea: round(e.pxArea, 5), visible: round(e.visible, 3),
    ...(e.depth && { depth: e.depth.map(v => round(v, 3)) }), ...(e.bbox3d && { bbox3d: e.bbox3d.map(v => round(v, 3)) }),
  }));
  const slim = ({ name, flags, margins, pxArea, visible }) => ({ name, ...(flags && { flags }), minMargin: Math.min(...margins), pxArea, visible });
  return fitEntities(head, views, slim, anomalies);
}

function queryFraming(metas, req) {
  if (typeof req.target !== 'string' || req.target === '') return fail('framing 要给 target：角色（hero、mustSee）或实体名');
  const byRole = ['hero', 'mustSee'].includes(req.target);
  const matching = metas.map(m => new Map((m.entities ?? [])
    .filter(e => (byRole ? e.role : e.name) === req.target).map(e => [e.name, e])));
  const names = [...new Set(matching.flatMap(frame => [...frame.keys()]))].sort();
  const results = names.map((name) => {
    const r = { name, frames: 0, missing: 0, minMargin: null, minMarginFrame: null,
      maxPxArea: null, peakFrame: null, minPxArea: null, minPxAreaFrame: null, outsideFrames: 0, firstOutside: null,
      minVisible: null, minVisibleFrame: null };
    for (const [i, m] of metas.entries()) {
      const e = matching[i].get(name);
      if (!e) { r.missing++; continue; }
      r.frames++;
      const mm = Math.min(...margins(e.bbox2d, m.size));
      if (r.minMargin === null || mm < r.minMargin) { r.minMargin = mm; r.minMarginFrame = m.frame; }
      if (r.maxPxArea === null || e.pxArea > r.maxPxArea) { r.maxPxArea = e.pxArea; r.peakFrame = m.frame; }
      if (r.minPxArea === null || e.pxArea < r.minPxArea) { r.minPxArea = e.pxArea; r.minPxAreaFrame = m.frame; }
      if (mm < 0) { r.outsideFrames++; if (r.firstOutside === null) r.firstOutside = m.frame; }
      if (typeof e.visible === 'number' && (r.minVisible === null || e.visible < r.minVisible)) { r.minVisible = e.visible; r.minVisibleFrame = m.frame; }
    }
    return { ...r, minMargin: round(r.minMargin, 3), maxPxArea: round(r.maxPxArea, 5), minPxArea: round(r.minPxArea, 5),
      minVisible: round(r.minVisible, 3), out: r.outsideFrames > 0,
      small: r.minPxArea < SMALL_AREA, occlusionRisk: r.minVisible === null ? null : r.minVisible < LOW_VISIBLE };
  });
  results.sort((a, b) => Number(b.out) - Number(a.out) || Number(b.occlusionRisk) - Number(a.occlusionRisk) || Number(b.small) - Number(a.small) || (a.minMargin ?? 0) - (b.minMargin ?? 0));
  let target = req.target;
  const head = (n, cut) => ({ ok: true, query: 'framing', target, framesScanned: metas.length,
    frameRange: [metas[0].frame, metas.at(-1).frame], totalEntities: results.length, returnedEntities: n, truncated: cut || target !== req.target });
  if (!withinBudget(JSON.stringify({ ...head(0, true), entities: results.slice(0, 1) }))) target = clip(target, 120);
  const slim = ({ name, out, occlusionRisk, minMargin, peakFrame, minPxArea, maxPxArea, firstOutside }) => ({ name, out, occlusionRisk, minMargin, peakFrame, minPxArea, maxPxArea, firstOutside });
  return fitEntities(head, results, slim, results.filter(r => r.out || r.occlusionRisk || r.small).length);
}

/** 两个轴对齐矩形之间的最短距离，像素；相交时是 0 */
export function boxGap(a, b) {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

function queryTexts(metas, req) {
  const m = pickFrame(metas, req.frame);
  if (!m) return fail(`没有第 ${req.frame} 帧的元数据`);
  if (!Array.isArray(m.texts)) return { ok: true, query: 'texts', frame: m.frame, texts: null, note: '这一帧没有文字框数据' };
  const [w, h] = m.size;
  const items = m.texts.map((t, i) => {
    const b = t.bbox2d;
    const rawId = t.id ?? `#${i}`;
    const clippedId = clip(rawId, 32);
    return { id: rawId, shortId: clippedId === rawId ? rawId : clippedId.replace('…', `…${i}…`),
      text: t.text, bbox2d: b.map(v => round(v, 1)),
      norm: [b[0] / w, b[1] / h, b[2] / w, b[3] / h].map(v => round(v, 3)),
      outside: b[0] < 0 || b[1] < 0 || b[2] > w || b[3] > h };
  });
  let minGap = null;
  let minPair = null;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const px = boxGap(m.texts[i].bbox2d, m.texts[j].bbox2d);
    if (minGap === null || px < minGap.px) {
      minGap = { px, pair: [items[i].id, items[j].id], overlap: px === 0 };
      minPair = [items[i], items[j]];
    }
  }
  if (minGap) minGap.px = round(minGap.px, 2);
  const order = [...items].sort((a, b) => Number(b.outside) - Number(a.outside));
  const outsideCount = items.filter(t => t.outside).length;
  const fit = limit => fitList((rows, cut) => {
    const short = s => clip(s, limit);
    const texts = rows.map(({ shortId, ...t }) => ({ ...t, id: limit === Infinity ? t.id : shortId, text: short(t.text) }));
    const gap = minGap && { ...minGap, pair: minPair.map(p => (limit === Infinity ? p.id : p.shortId)) };
    return { ok: true, query: 'texts', frame: m.frame, size: m.size, totalTexts: items.length, returnedTexts: texts.length,
      truncated: cut || texts.some((t, i) => t.text !== rows[i].text || t.id !== rows[i].id) || Boolean(gap?.pair.some((id, i) => id !== minGap.pair[i])),
      minGap: gap, minGapPx: gap?.px ?? null, outsideCount, outside: texts.filter(t => t.outside).map(t => t.id), texts };
  }, order);
  const full = fit(Infinity);
  if (full.returnedTexts || items.length === 0) return full;
  return fit(32);
}

/** 一帧的画面统计摘要；stats 是 null 时返回 null */
export function statsSummary(s) {
  if (!isPlain(s) || !isPlain(s.luma)) return null;
  const { p1, p50, p99 } = s.luma;
  return { p1: round(p1), p50: round(p50), p99: round(p99),
    clipHigh: round(s.clipHigh ?? null), clipLow: round(s.clipLow ?? null),
    // 明暗对比：p99 比 p1 的档数（以 2 为底），p1 取不小于 1e-4 防止除零
    dynamicRangeStops: round(Math.log2(Math.max(p99, 1e-4) / Math.max(p1, 1e-4)), 2) };
}

function statsGroup(rows) {
  const have = rows.filter(r => !r.missing);
  const pick = (key, op) => rows.reduce((value, row) => row[key] == null ? value : value === null ? row[key] : op(value, row[key]), null);
  return { framesWithStats: have.length, framesWithoutStats: rows.length - have.length,
    p50Min: pick('p50', Math.min), p50Max: pick('p50', Math.max), p99Max: pick('p99', Math.max), p1Min: pick('p1', Math.min),
    clipHighMax: pick('clipHigh', Math.max), clipLowMax: pick('clipLow', Math.max), dynamicRangeStopsMax: pick('dynamicRangeStops', Math.max),
    keyFillRatioMax: pick('keyFillRatio', Math.max) };
}

function queryStats(metas, req) {
  const chosen = req.frame === undefined ? metas : metas.filter(m => m.frame === req.frame);
  if (!chosen.length) return fail(`没有第 ${req.frame} 帧的元数据`);
  const rows = chosen.map(m => ({ frame: m.frame, colorRef: m.colorRef, ...(statsSummary(m.stats) ?? { missing: true }),
    keyFillRatio: m.readings?.keyFillRatio ?? null }));
  const refs = [...new Set(rows.map(r => r.colorRef))];
  const byColorRef = Object.fromEntries(refs.map(ref => [ref, statsGroup(rows.filter(r => r.colorRef === ref))]));
  const colorRef = refs.length === 1 ? refs[0] : null;
  const summary = colorRef ? byColorRef[colorRef] : { byColorRef };
  const order = rows.sort((a, b) => (b.clipHigh ?? 0) - (a.clipHigh ?? 0) || (b.dynamicRangeStops ?? 0) - (a.dynamicRangeStops ?? 0) || a.frame - b.frame);
  return fitList((frames, truncated) => ({ ok: true, query: 'stats', colorRef, totalFrames: rows.length,
    returnedFrames: frames.length, truncated, summary, frames }), order);
}

const HANDLERS = { entities: queryEntities, framing: queryFraming, texts: queryTexts, stats: queryStats };

/** 查询入口；任何非法输入都返回结构化错误，不抛异常 */
export function query(metas, request) {
  try {
    if (!isPlain(request) || typeof request.type !== 'string' || !Object.hasOwn(HANDLERS, request.type)) {
      return fail(`查询类型必须是 ${QUERY_TYPES.join('、')} 之一`);
    }
    if (request.frame !== undefined && !(Number.isInteger(request.frame) && request.frame >= 0)) return fail('frame 必须是非负整数帧号');
    const list = normalizeMetas(metas);
    if (typeof list === 'string') return fail(clip(list, 160));
    const out = HANDLERS[request.type](list, request);
    return withinBudget(JSON.stringify(out)) ? out : { ok: true, query: request.type, truncated: true };
  } catch (error) {
    return fail(`元数据结构不合 meta/0.1：${clip(String(error?.message ?? error), 80)}`);
  }
}
