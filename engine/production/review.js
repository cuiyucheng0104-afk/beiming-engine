// 北冥引擎 · 创作闸门的审片记录（决策 D08）：films/<名>/review/<闸>-<日期>[-n].json，一条记录一个文件，只增不改。
// 三道阻断闸 look（风格关键帧）→ animatic（动态预演）→ final（终渲成片），另有只记录、不阻断的 structure（导演方法 ⛔1 结构确认）。
// 对应 routes/directing/DIRECTING.md 的关口：⛔1 = structure、⛔2 = look、⛔3 = animatic、⛔4 = final。
//
// 规则（validateReview 逐条检查，不合格的记录在状态计算里当作不存在）：
//   - approve / reject / waive 只能由人做：reviewer.kind 必须是 human，并带用户原话 quote 与出处 source { kind, ref, at }。
//     记录里没有原话（或原话是占位符）就无效。agent 只能写 decision = comment 的代理审片记录，永远推不动状态。
//   - approve 必须列出用户看过的文件 reviewed[{ path, sha256 }]；animatic 认可同时冻结当时的镜头表（timing），
//     之后切点改了，这条认可自动失效（status 显示 stale 与差异）；look 认可冻结 style 的 id / version。
//   - waive 只能用于 look / animatic（用户明确说跳过，原话入档）；final 不能豁免：没有用户对成片的认可，就没有「已交付」。
//   - reject 要写 rejectedOn（否定的维度，取 RUBRIC 的维度 id）与 mustChange（下次必须改什么）。
//
// 接口：
//   buildReview(input, { now })        由命令行参数拼出记录：算所看文件的 sha256、冻结镜头表 / 风格版本
//   validateReview(record, { film })   → { ok, diagnostics }
//   writeReview(filmDir, record)       原子地新建 review/<闸>-<YYYY-MM-DD>[-n].json，不覆盖已有记录，返回 { path, sha256 }
//   readReviews(filmDir, { film })     → { records: [{ file, name, record, valid, diagnostics }], diagnostics }
//   gateVerdict(records, gate, film)   某道闸的当前结论：approved / waived / rejected / stale / missing，附依据记录
//   validateCreativeAcceptance(c)      RenderResult.creativeAcceptance 的 v2 规则：accepted 至少要一条人工认可（带原话与出处）
//   常量：GATES、RECORD_GATES、DECISIONS、REVIEWER_KINDS、SOURCE_KINDS、RUBRIC_DIMENSIONS、VETOES、ISSUE_LAYERS、ISSUE_PRIORITIES
// 评分维度与一票否决项的含义见 docs/creative-review/RUBRIC.md（两边的 id 由测试保持一致）。
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeRelativePath, validateCreativeAcceptance as validateCreativeContract } from './project.js';
import { createExclusive, formatJson, readJsonFile, sha256File, sha256Text } from './io.js';
import { eventsSignature, timingSignature } from './timeline.js';
import {
  DECISIONS, HUMAN_DECISIONS, ISSUE_LAYERS, ISSUE_PRIORITIES, ISSUE_STATUSES, REVIEWER_KINDS, RUBRIC_DIMENSIONS, SOURCE_KINDS, VERDICTS, VETOES, isPlaceholderQuote,
} from './vocab.js';

// 取值表在 vocab.js（project.js 的 RenderResult 校验也用它）；这里转出，保持 review.js 的接口不变
export { DECISIONS, HUMAN_DECISIONS, ISSUE_LAYERS, ISSUE_PRIORITIES, ISSUE_STATUSES, REVIEWER_KINDS, RUBRIC_DIMENSIONS, SOURCE_KINDS, VERDICTS, VETOES, isPlaceholderQuote };

export const REVIEW_SCHEMA_VERSION = 1;
export const GATES = Object.freeze(['look', 'animatic', 'final']);
export const RECORD_GATES = Object.freeze(['structure', ...GATES]);

const FIELDS = ['schemaVersion', 'film', 'gate', 'decision', 'reviewer', 'quote', 'source', 'recordedBy', 'recordedAt', 'reviewed', 'timing', 'style',
  'shots', 'issues', 'scores', 'vetoes', 'evidenceFrames', 'rejectedOn', 'mustChange', 'summary', 'notes'];
const SHA = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;

const PRIVATE_PATH = /(\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\|~\/\.)/;

// ───────────────────────── 校验 ─────────────────────────

export function validateReview(record, { film = null } = {}) {
  const diagnostics = [];
  const err = (code, path, message, hint = '') => diagnostics.push({ level: 'error', code, path, message, hint });
  const warn = (code, path, message, hint = '') => diagnostics.push({ level: 'warning', code, path, message, hint });
  if (!isObj(record)) { err('review-invalid', '$', '审片记录必须是 JSON 对象'); return { ok: false, diagnostics }; }
  for (const k of Object.keys(record)) if (!FIELDS.includes(k)) warn('review-unknown-field', k, `未知字段 ${k}`);
  if (record.schemaVersion !== REVIEW_SCHEMA_VERSION) err('review-schema', 'schemaVersion', `schemaVersion 必须是 ${REVIEW_SCHEMA_VERSION}`);
  if (!isStr(record.film)) err('review-film', 'film', 'film 写作品 id');
  else if (film && record.film !== film.id) err('review-film', 'film', `记录属于作品 ${record.film}，不是 ${film.id}`);
  if (!RECORD_GATES.includes(record.gate)) err('review-gate', 'gate', `gate 只能是 ${RECORD_GATES.join(' / ')}`);
  if (!DECISIONS.includes(record.decision)) err('review-decision', 'decision', `decision 只能是 ${DECISIONS.join(' / ')}`);
  const human = HUMAN_DECISIONS.includes(record.decision);

  const rv = record.reviewer;
  if (!isObj(rv) || !REVIEWER_KINDS.includes(rv.kind) || !isStr(rv.name)) err('review-reviewer', 'reviewer', 'reviewer 是 { kind: human | ai, name }');
  else if (human && rv.kind !== 'human') {
    err('review-ai-decision', 'reviewer.kind', `${record.decision} 只能由用户或指定审片人做；agent 不能自己批准、否决或豁免`, '代理审片写 decision = comment；用户的结论由他说、你照原话记录');
  }

  if (human) {
    if (!isStr(record.quote)) err('review-quote-missing', 'quote', '没有用户原话：这条记录无效', '把用户说的话原样写进 quote（含标点），不要改写、不要概括');
    else if (isPlaceholderQuote(record.quote)) err('review-quote-placeholder', 'quote', `quote 是占位符或自评口吻（${JSON.stringify(record.quote)}）：这条记录无效`, '只能写用户的原话');
    const s = record.source;
    if (!isObj(s)) err('review-source-missing', 'source', '没有出处：source 写 { kind, ref, at }', '例：{ "kind": "session", "ref": "Claude Code 会话，2026-11-10 用户第 14 条消息", "at": "2026-11-10T15:32:00+08:00" }');
    else {
      if (!SOURCE_KINDS.includes(s.kind)) err('review-source-kind', 'source.kind', `source.kind 只能是 ${SOURCE_KINDS.join(' / ')}`);
      if (!isStr(s.ref)) err('review-source-ref', 'source.ref', 'source.ref 写能找回这句话的出处（会话、消息、邮件、会议纪要）');
      else if (isPlaceholderQuote(s.ref)) err('review-source-ref', 'source.ref', `source.ref 是占位符：${JSON.stringify(s.ref)}`);
      if (!(isStr(s.at) && ISO.test(s.at) && !Number.isNaN(Date.parse(s.at)))) err('review-source-at', 'source.at', 'source.at 写用户说这句话的时间（ISO 8601，如 2026-11-10T15:32:00+08:00）');
      for (const k of ['ref']) if (isStr(s[k]) && PRIVATE_PATH.test(s[k])) warn('review-private-path', `source.${k}`, '出处里有本机路径：记录随作品入库，改写成不含用户名的说法');
    }
    if (isStr(record.quote) && PRIVATE_PATH.test(record.quote)) warn('review-private-path', 'quote', '原话里有本机路径：记录会入库，确认可以公开');
  } else if (record.decision === 'comment' && !isStr(record.summary) && !isStr(record.quote) && !Array.isArray(record.issues)) {
    err('review-comment-empty', 'summary', 'comment 记录要写 summary（代理审片结论"代理检查通过 / 未通过"）、issues 或 quote 之一');
  }

  const rb = record.recordedBy;
  if (!isObj(rb) || !isStr(rb.name) || !REVIEWER_KINDS.includes(rb.kind)) err('review-recorded-by', 'recordedBy', 'recordedBy 是录入这条记录的人或 agent：{ kind: human | ai, name }');
  if (!(isStr(record.recordedAt) && ISO.test(record.recordedAt) && !Number.isNaN(Date.parse(record.recordedAt)))) err('review-recorded-at', 'recordedAt', 'recordedAt 写录入时间（ISO 8601）');

  if (record.decision === 'waive') {
    if (record.gate === 'final') err('review-final-waive', 'gate', 'final 不能豁免：「已交付 · 用户已认可」必须有用户对成片的认可原话', '用户不看片就要交，状态停在 qa-passed，对外写「技术检查通过，未经用户审看」');
    if (record.gate === 'structure') err('review-structure-waive', 'gate', 'structure 只记录、不阻断，不需要豁免');
  }

  const files = record.reviewed;
  if (files !== undefined && !Array.isArray(files)) err('review-files', 'reviewed', 'reviewed 是 [{ path, sha256, kind }]');
  else if (Array.isArray(files)) files.forEach((x, i) => {
    const p = `reviewed[${i}]`;
    if (!isObj(x)) { err('review-files', p, '必须是对象'); return; }
    const n = normalizeRelativePath(x.path);
    if (!n.ok) err('review-files', `${p}.path`, `路径相对作品的路径基准：${n.message}`);
    if (!(typeof x.sha256 === 'string' && SHA.test(x.sha256))) err('review-files', `${p}.sha256`, 'sha256 是 64 位小写十六进制');
  });
  if (record.decision === 'approve' && GATES.includes(record.gate) && !(Array.isArray(files) && files.length)) {
    err('review-files-missing', 'reviewed', `${record.gate} 的认可必须列出用户看过的文件（路径与 sha256）`, '认可针对的是具体版本：风格帧 / 预演片 / 成片，换了文件就要重新给用户看');
  }

  if (record.gate === 'animatic' && record.decision === 'approve') {
    const t = record.timing;
    if (!isObj(t) || !Number.isInteger(t.fps) || !Number.isInteger(t.frameCount) || !Array.isArray(t.shots) || !SHA.test(t.timingSha256 ?? '') || !SHA.test(t.eventsSha256 ?? '')) {
      err('review-timing', 'timing', 'animatic 认可必须冻结当时的镜头表：timing { fps, frameCount, shots, timingSha256, eventsSha256 }（buildReview 会自动生成）');
    }
  }
  if (record.gate === 'look' && record.decision === 'approve' && film?.style && !(isObj(record.style) && isStr(record.style.id) && record.style.version !== undefined)) {
    err('review-style', 'style', 'look 认可必须冻结当时的风格：style { id, version }（buildReview 会自动生成）');
  }

  if (record.shots !== undefined) {
    if (!Array.isArray(record.shots)) err('review-shots', 'shots', 'shots 是逐镜结论 [{ id, verdict, note }]');
    else record.shots.forEach((s, i) => {
      if (!isObj(s) || !isStr(s.id) || !VERDICTS.includes(s.verdict)) err('review-shots', `shots[${i}]`, `每镜写 { id, verdict: ${VERDICTS.join(' | ')}, note }`);
      else if (film && !film.shots.some(x => x.id === s.id)) err('review-shots', `shots[${i}].id`, `作品里没有镜头 ${s.id}`);
    });
  }
  if (record.issues !== undefined) {
    if (!Array.isArray(record.issues)) err('review-issues', 'issues', 'issues 是问题条目数组（见 docs/creative-review/issue.schema.json）');
    else record.issues.forEach((x, i) => diagnostics.push(...validateIssue(x, { film, path: `issues[${i}]` })));
  }
  if (record.scores !== undefined) {
    if (!isObj(record.scores)) err('review-scores', 'scores', 'scores 是 { 维度 id: 1–10 }');
    else for (const [k, v] of Object.entries(record.scores)) {
      if (!Object.hasOwn(RUBRIC_DIMENSIONS, k)) err('review-scores', `scores.${k}`, `没有评分维度 ${k}；可用：${Object.keys(RUBRIC_DIMENSIONS).join(' / ')}`);
      else if (!(Number.isInteger(v) && v >= 1 && v <= 10)) err('review-scores', `scores.${k}`, '分数是 1–10 的整数（锚点见 docs/creative-review/RUBRIC.md）');
    }
  }
  if (record.vetoes !== undefined) {
    if (!Array.isArray(record.vetoes) || record.vetoes.some(v => !Object.hasOwn(VETOES, v))) err('review-vetoes', 'vetoes', `vetoes 取值：${Object.keys(VETOES).join(' / ')}`);
  }
  if (record.evidenceFrames !== undefined && !(Array.isArray(record.evidenceFrames) && record.evidenceFrames.every(f => Number.isInteger(f) && f >= 0))) {
    err('review-evidence-frames', 'evidenceFrames', 'evidenceFrames 是非负整数帧号数组');
  }
  if (record.decision === 'reject') {
    if (!(Array.isArray(record.rejectedOn) && record.rejectedOn.length)) warn('review-reject-dimensions', 'rejectedOn', '否定要写清维度（rejectedOn：取 RUBRIC 的维度 id），下一轮才知道改哪里');
    else if (record.rejectedOn.some(d => !Object.hasOwn(RUBRIC_DIMENSIONS, d))) err('review-reject-dimensions', 'rejectedOn', `rejectedOn 取值：${Object.keys(RUBRIC_DIMENSIONS).join(' / ')}`);
    if (!isStr(record.mustChange)) warn('review-reject-must-change', 'mustChange', '写下"下次必须改什么"（从用户原话里提炼，原话照样保留在 quote）');
  }
  return { ok: !diagnostics.some(d => d.level === 'error'), diagnostics };
}

/** 问题条目：定位到帧与层，才能返修（T16：失败镜头可定位到动作 / 模型 / 灯光 / 后期层）。 */
export function validateIssue(issue, { film = null, path = 'issue' } = {}) {
  const out = [];
  const err = (code, p, message) => out.push({ level: 'error', code, path: p, message, hint: '' });
  if (!isObj(issue)) { err('issue-invalid', path, '问题条目必须是对象'); return out; }
  const n = film?.output?.frameCount;
  const hasFrame = issue.frame !== undefined, hasRange = issue.frames !== undefined;
  if (hasFrame === hasRange) err('issue-frames', path, '写 frame（单帧）或 frames: [in, out)（区间）之一');
  if (hasFrame && !(Number.isInteger(issue.frame) && issue.frame >= 0 && (n === undefined || issue.frame < n))) err('issue-frames', `${path}.frame`, `frame 是 [0, ${n ?? 'frameCount'}) 里的整数帧`);
  if (hasRange && !(Array.isArray(issue.frames) && issue.frames.length === 2 && issue.frames.every(Number.isInteger) && issue.frames[0] >= 0 && issue.frames[1] > issue.frames[0] && (n === undefined || issue.frames[1] <= n))) {
    err('issue-frames', `${path}.frames`, 'frames 是半开区间 [in, out)，整数帧，在片长之内');
  }
  if (issue.shot !== undefined && film && !film.shots.some(s => s.id === issue.shot)) err('issue-shot', `${path}.shot`, `作品里没有镜头 ${issue.shot}`);
  if (!Object.hasOwn(ISSUE_LAYERS, issue.layer)) err('issue-layer', `${path}.layer`, `layer 取值：${Object.keys(ISSUE_LAYERS).join(' / ')}`);
  if (issue.dimension !== undefined && !Object.hasOwn(RUBRIC_DIMENSIONS, issue.dimension)) err('issue-dimension', `${path}.dimension`, `dimension 取值：${Object.keys(RUBRIC_DIMENSIONS).join(' / ')}`);
  if (!isStr(issue.problem)) err('issue-problem', `${path}.problem`, 'problem 写看到了什么问题（现象，不写猜测的原因）');
  if (!ISSUE_PRIORITIES.includes(issue.priority)) err('issue-priority', `${path}.priority`, `priority 取值：${ISSUE_PRIORITIES.join(' / ')}`);
  if (issue.status !== undefined && !ISSUE_STATUSES.includes(issue.status)) err('issue-status', `${path}.status`, `status 取值：${ISSUE_STATUSES.join(' / ')}`);
  if (issue.region !== undefined && !(Array.isArray(issue.region) && issue.region.length === 4 && issue.region.every(v => typeof v === 'number' && v >= 0 && v <= 1))) {
    err('issue-region', `${path}.region`, 'region 是画面比例坐标 [x, y, w, h]，都在 0–1 之间');
  }
  if (issue.evidence !== undefined && !(Array.isArray(issue.evidence) && issue.evidence.every(isStr))) err('issue-evidence', `${path}.evidence`, 'evidence 是证据文件路径数组');
  return out;
}

// ───────────────────────── 生成与写入 ─────────────────────────

const dateStamp = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export function isoLocal(d = new Date()) {
  const p = n => String(n).padStart(2, '0'), off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

export function timingSnapshot(film) {
  return {
    fps: film.output.fps,
    frameCount: film.output.frameCount,
    shots: film.shots.map(s => [s.id, s.in, s.out]),
    timingSha256: sha256Text(timingSignature(film)),
    eventsSha256: sha256Text(eventsSignature(film)),
  };
}

/**
 * 拼出一条记录。reviewed 里只给 path 时，从 pathBase 读文件算 sha256（文件必须存在）。
 * @param {{ film: object, pathBase: string, gate: string, decision: string, quote?: string, source?: object, reviewer?: object,
 *           recordedBy?: object, reviewed?: Array<{path: string, sha256?: string, kind?: string}>, [k: string]: unknown }} input
 */
export function buildReview(input, { now = new Date() } = {}) {
  const { film, pathBase, gate, decision } = input;
  const reviewed = (input.reviewed ?? []).map(x => {
    if (x.sha256) return { path: x.path, sha256: x.sha256, ...(x.kind ? { kind: x.kind } : {}) };
    const n = normalizeRelativePath(x.path);
    if (!n.ok) throw Object.assign(new Error(`所看文件的路径不合格：${x.path}（${n.message}）`), { code: 'review-files', exitCode: 2 });
    const abs = resolve(pathBase, ...n.segments);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw Object.assign(new Error(`所看文件不存在：${x.path}（相对 ${pathBase}）`), { code: 'review-files', exitCode: 2 });
    return { path: n.path, sha256: sha256File(abs), ...(x.kind ? { kind: x.kind } : {}) };
  });
  const record = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    film: film.id,
    gate,
    decision,
    reviewer: input.reviewer ?? { kind: 'human', name: '用户' },
    quote: input.quote,
    source: input.source,
    recordedBy: input.recordedBy ?? { kind: 'ai', name: 'agent' },
    recordedAt: isoLocal(now),
    reviewed: reviewed.length ? reviewed : undefined,
    timing: gate === 'animatic' ? timingSnapshot(film) : undefined,
    style: gate === 'look' && film.style ? { id: film.style.id, version: film.style.version } : undefined,
  };
  for (const k of ['shots', 'issues', 'scores', 'vetoes', 'evidenceFrames', 'rejectedOn', 'mustChange', 'summary', 'notes']) {
    if (input[k] !== undefined) record[k] = input[k];
  }
  return JSON.parse(JSON.stringify(record));   // 去掉 undefined 字段
}

export function reviewDir(filmDir) {
  return join(resolve(filmDir), 'review');
}

export function writeReview(filmDir, record) {
  const dir = reviewDir(filmDir);
  mkdirSync(dir, { recursive: true });
  const d = new Date(Date.parse(record.recordedAt));
  const stem = `${record.gate}-${dateStamp(Number.isNaN(d.getTime()) ? new Date() : d)}`;
  const names = [`${stem}.json`, ...Array.from({ length: 98 }, (_, i) => `${stem}-${i + 2}.json`)];
  const text = formatJson(record);
  const path = createExclusive(dir, names, text);
  return { path, sha256: sha256Text(text) };
}

const REVIEW_FILE = /^(structure|look|animatic|final)-\d{4}-\d{2}-\d{2}(-\d+)?\.json$/;

export function readReviews(filmDir, { film = null } = {}) {
  const dir = reviewDir(filmDir);
  const records = [], diagnostics = [];
  if (!existsSync(dir)) return { records, diagnostics };
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const file = join(dir, name);
    if (!REVIEW_FILE.test(name)) {
      diagnostics.push({ level: 'warning', code: 'review-file-name', path: `review/${name}`, message: `review/${name} 不是 <闸>-<YYYY-MM-DD>[-n].json，状态计算不读它`, hint: '用 film.js review 生成记录' });
      continue;
    }
    const r = readJsonFile(file);
    if (!r.ok) {
      records.push({ file, name, record: null, valid: false, diagnostics: [{ level: 'error', code: r.code, path: `review/${name}`, message: r.message, hint: '' }] });
      continue;
    }
    const v = validateReview(r.value, { film });
    const gateFromName = name.split('-')[0];
    if (r.value?.gate && r.value.gate !== gateFromName) v.diagnostics.push({ level: 'error', code: 'review-gate-name', path: `review/${name}`, message: `文件名是 ${gateFromName}，记录里写的是 ${r.value.gate}`, hint: '' });
    const valid = !v.diagnostics.some(d => d.level === 'error');
    records.push({ file, name, record: r.value, valid, diagnostics: v.diagnostics });
  }
  // 先按录入时间，同一秒内按文件序号（<闸>-<日期>.json 是第 1 条，-2、-3… 依次往后）：最后一条才是现行结论
  const seq = name => { const m = /-(\d+)\.json$/.exec(name.replace(/^[a-z]+-\d{4}-\d{2}-\d{2}/, '')); return m ? Number(m[1]) : 1; };
  const day = name => (/\d{4}-\d{2}-\d{2}/.exec(name) ?? [''])[0];
  records.sort((a, b) => (Date.parse(a.record?.recordedAt ?? '') || 0) - (Date.parse(b.record?.recordedAt ?? '') || 0)
    || day(a.name).localeCompare(day(b.name)) || seq(a.name) - seq(b.name) || a.name.localeCompare(b.name));
  return { records, diagnostics };
}

/**
 * 某道闸的结论：取这道闸最后一条有效的人工决定（comment 不算）。
 * approve 还要核对它冻结的内容与现在一致：animatic 比镜头表，look 比风格版本；final 的成片比对在 state.js 做。
 */
export function gateVerdict(records, gate, film) {
  const mine = records.filter(r => r.record?.gate === gate);
  const invalid = mine.filter(r => !r.valid);
  const decisions = mine.filter(r => r.valid && HUMAN_DECISIONS.includes(r.record.decision));
  const comments = mine.filter(r => r.valid && r.record.decision === 'comment');
  const base = { gate, records: mine.length, invalid: invalid.map(r => r.name), comments: comments.length };
  const last = decisions.at(-1);
  if (!last) return { ...base, status: 'missing', record: null, reason: invalid.length ? `有 ${invalid.length} 条无效记录（${invalid.map(r => r.name).join('、')}），不算数` : '没有记录' };
  const rec = last.record, at = { file: last.name, quote: rec.quote, source: rec.source, recordedAt: rec.recordedAt };
  if (rec.decision === 'reject') return { ...base, status: 'rejected', record: at, reason: `用户否定：${rec.quote}` };
  if (rec.decision === 'waive') return { ...base, status: 'waived', record: at, reason: `用户豁免：${rec.quote}` };
  if (gate === 'animatic' && film) {
    const now = timingSnapshot(film), was = rec.timing;
    if (was?.timingSha256 !== now.timingSha256) {
      const diff = shotDiff(was?.shots ?? [], now.shots);
      return { ...base, status: 'stale', record: at, reason: `认可之后镜头表改过：${diff.join('；') || '帧率或总帧数变了'}`, diff };
    }
    if (was?.eventsSha256 !== now.eventsSha256) return { ...base, status: 'approved', record: at, reason: '认可之后事件表改过（切点没变）：建议把改动告诉用户', eventsChanged: true };
  }
  if (gate === 'look' && film?.style && rec.style && (rec.style.id !== film.style.id || String(rec.style.version) !== String(film.style.version))) {
    return { ...base, status: 'stale', record: at, reason: `认可的是风格 ${rec.style.id}@${rec.style.version}，现在是 ${film.style.id}@${film.style.version}` };
  }
  return { ...base, status: 'approved', record: at, reason: `用户认可：${rec.quote}`, reviewed: rec.reviewed ?? [] };
}

function shotDiff(before, after) {
  const out = [];
  const b = new Map(before.map(([id, i, o]) => [id, [i, o]])), a = new Map(after.map(([id, i, o]) => [id, [i, o]]));
  for (const [id, [i, o]] of a) {
    const old = b.get(id);
    if (!old) out.push(`新增镜头 ${id} [${i}, ${o})`);
    else if (old[0] !== i || old[1] !== o) out.push(`${id} [${old[0]}, ${old[1]}) → [${i}, ${o})`);
  }
  for (const id of b.keys()) if (!a.has(id)) out.push(`删掉了镜头 ${id}`);
  return out;
}

// ───────────────────────── RenderResult.creativeAcceptance（v2 规则） ─────────────────────────

/**
 * creativeAcceptance: { status, reviews: [{ reviewerKind, reviewer, decision, quote, source, scores, vetoes, evidenceFrames }] }
 * 规则实现在 project.js 的 validateCreativeAcceptance；这里按 strict（运行记录口径）包一层，返回带 level 的诊断：
 * accepted 至少要一条 reviewerKind = human、decision = approve、带原话与出处的评审；只有 AI 评审时最多是 ai-reviewed。
 */
export function validateCreativeAcceptance(creative, { path = 'creativeAcceptance' } = {}) {
  const r = validateCreativeContract(creative, { path });
  const out = r.diagnostics.map(d => ({ level: 'error', hint: '', ...d }));
  if (creative && typeof creative === 'object' && creative.status === 'accepted' && !r.humanApproved) {
    out.push({ level: 'error', code: 'creative-accepted-without-human', path: `${path}.status`, message: 'accepted 至少要一条人工认可（reviewerKind = human、decision = approve、带原话与出处）', hint: '只有 AI 评审时最多写 ai-reviewed' });
  }
  return out;
}
