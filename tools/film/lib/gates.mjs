// 北冥仓库 · 出片编排 · 创作闸门记录（决定 D08：look → animatic → final）。
// 记录格式以作品描述包为准（engine/production/review.js，P05）：一条记录一个文件，只增不改，随作品源码提交：
//   films/<名>/review/<闸>-<YYYY-MM-DD>[-n].json
//   { schemaVersion: 1, film, gate: structure|look|animatic|final, decision: approve|reject|waive|comment,
//     reviewer: { kind: human|ai, name }, quote（用户原话）, source: { kind, ref, at }, recordedBy: { kind, name }, recordedAt,
//     reviewed: [{ path, sha256, kind }]（用户看过的文件，路径相对作品的路径基准）, timing（animatic 认可冻结的镜头表）,
//     style（look 认可冻结的风格 id / version）, summary, notes, evidenceFrames, mustChange … }
// 规则（与 review.js 的 validateReview 同口径）：
//   - approve / reject / waive 只能由人做：reviewer.kind = human，带用户原话 quote 与出处 source { kind, ref, at }；原话是占位符或自评口吻的无效。
//   - agent 只能写 decision = comment（代理审片、内部豁免说明），永远推不动闸门。
//   - approve 必须列出用户看过的文件与 sha256；animatic 认可冻结镜头表，之后切点改了这条认可自动失效（stale）；look 认可冻结风格版本。
//   - waive 只能用于 look / animatic；final 不能豁免。没有用户原话的 --waive 只记一条 comment（内部豁免说明），不放行终渲。
//   - 每道闸取最后一条有效的人工决定：approved / waived / rejected / stale / missing。
// 作品描述包（engine/production/review.js + film.js）在仓库里时，生成、校验、读取与判定全部转调它；还没合入时用下面同格式的内置实现
// （FILM_REVIEW_LIB=builtin 可强制用内置实现，测试用）。签名公式与 engine/production/timeline.js 的 timingSignature / eventsSignature 相同。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT, rel, sha256File } from './repo.mjs';
import { formatFilmJson } from '../../lib/filmspec.mjs';

export const GATES = ['look', 'animatic', 'final'];
export const RECORD_GATES = ['structure', ...GATES];
export const DECISIONS = ['approve', 'reject', 'waive', 'comment'];
export const HUMAN_DECISIONS = ['approve', 'reject', 'waive'];
export const SOURCE_KINDS = ['session', 'chat', 'im', 'email', 'meeting', 'document', 'other'];
export const GATE_KIND = { look: 'stills', animatic: 'animatic', final: 'build' };
export const GATE_LABEL = { look: '风格关键帧（look）', animatic: '动态预演（animatic）', final: '终渲成片（final）' };
export const STATE_LABEL = { approved: '已认可', waived: '已豁免（用户原话）', rejected: '要修改', stale: '认可已失效', missing: '待审' };

// ───────────────────────── 作品描述包的库（有就用） ─────────────────────────

let lib = undefined;
export async function productionLib() {
  if (lib !== undefined) return lib;
  lib = null;
  if (process.env.FILM_REVIEW_LIB === 'builtin') return lib;
  const rv = path.join(ROOT, 'engine/production/review.js'), fj = path.join(ROOT, 'engine/production/film.js');
  if (!fs.existsSync(rv) || !fs.existsSync(fj)) return lib;
  try {
    const review = await import(pathToFileURL(rv).href), film = await import(pathToFileURL(fj).href);
    if (['buildReview', 'validateReview', 'writeReview', 'readReviews', 'gateVerdict'].every(k => typeof review[k] === 'function') && typeof film.loadFilm === 'function') lib = { review, film };
  } catch { /* 坏模块按未提供处理 */ }
  return lib;
}

// 作品描述包看到的作品对象（它的 loadFilm 读不懂时退回 null：判定照常，只是不比镜头表与风格）
async function p05Film(L, film) {
  try { const r = L.film.loadFilm(film.dir); return r?.ok ? r.film : null; } catch { return null; }
}

// ───────────────────────── 内置实现（与 review.js 同格式） ─────────────────────────

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const SHA = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const PLACEHOLDER_QUOTES = [
  /\{\{[^}]*\}\}/, /^<[^>]*>$/, /^[（(\[【].*[）)\]】]$/,
  /^(todo|tbd|tbc|n\/a|na|null|none|undefined|placeholder|xxx+|-+|—+|…+|\.{3,}|待补|待填|待定|略|无|空|示例|样例|原话|用户原话|用户的原话)$/i,
  /^(代理检查通过|代理审片通过|自检通过|ai\s*审片通过|agent\s*(approved|checked))[。.!！]?$/i,
];
export const isPlaceholderQuote = t => typeof t !== 'string' || !t.trim() || PLACEHOLDER_QUOTES.some(re => re.test(t.trim()));

// 编排器视角的作品 → 签名要用的最小视图（output、shots、events、style）
export function filmView(film) {
  const raw = film.raw || {};
  const output = isObj(raw.output) ? { fps: raw.output.fps, frameCount: raw.output.frameCount } : { fps: film.fps, frameCount: film.frameCount };
  const shots = Array.isArray(raw.shots) && raw.shots.length ? raw.shots : [{ id: 'S1', in: 0, out: film.frameCount }];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const style = isObj(raw.style) && isStr(raw.style.id) ? { id: raw.style.id, version: raw.style.version } : null;
  return { id: film.id, output, shots, events, style };
}
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sha256Text = t => crypto.createHash('sha256').update(t).digest('hex');
const timingSignature = f => stableStringify({ fps: f.output.fps, frameCount: f.output.frameCount, shots: (f.shots ?? []).map(s => [s.id, s.in, s.out, s.transition ?? 'cut']) });
const eventsSignature = f => stableStringify([...(f.events ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(e => [e.id, e.frame, e.shot, e.end ?? null, e.audio ?? null, e.beat ?? null]));
export function timingSnapshot(view) {
  return { fps: view.output.fps, frameCount: view.output.frameCount, shots: view.shots.map(s => [s.id, s.in, s.out]), timingSha256: sha256Text(timingSignature(view)), eventsSha256: sha256Text(eventsSignature(view)) };
}

const pad = n => String(n).padStart(2, '0');
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const dateStamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const REVIEW_FILE = /^(structure|look|animatic|final)-\d{4}-\d{2}-\d{2}(-\d+)?\.json$/;

/** 一条记录的问题（error 级，与 review.js 的 validateReview 同口径的核心规则）；空数组 = 合格。 */
export function reviewProblems(r, { filmId = null } = {}) {
  const p = [];
  if (!isObj(r)) return ['审片记录必须是 JSON 对象'];
  if (r.schemaVersion !== 1) p.push('schemaVersion 必须是 1');
  if (!isStr(r.film)) p.push('film 写作品 id');
  else if (filmId && r.film !== filmId) p.push(`记录属于作品 ${r.film}，不是 ${filmId}`);
  if (!RECORD_GATES.includes(r.gate)) p.push(`gate 只能是 ${RECORD_GATES.join(' / ')}`);
  if (!DECISIONS.includes(r.decision)) p.push(`decision 只能是 ${DECISIONS.join(' / ')}`);
  const human = HUMAN_DECISIONS.includes(r.decision);
  const rv = r.reviewer;
  if (!isObj(rv) || !['human', 'ai'].includes(rv.kind) || !isStr(rv.name)) p.push('reviewer 是 { kind: human | ai, name }');
  else if (human && rv.kind !== 'human') p.push(`${r.decision} 只能由用户或指定审片人做（reviewer.kind = human）；agent 不能自己批准、否决或豁免`);
  if (human) {
    if (isPlaceholderQuote(r.quote)) p.push('没有用户原话（quote 缺失、是占位符或自评口吻）');
    const s = r.source;
    if (!isObj(s)) p.push('没有出处：source 写 { kind, ref, at }');
    else {
      if (!SOURCE_KINDS.includes(s.kind)) p.push(`source.kind 只能是 ${SOURCE_KINDS.join(' / ')}`);
      if (!isStr(s.ref) || isPlaceholderQuote(s.ref)) p.push('source.ref 写能找回这句话的出处（会话、消息、邮件、会议纪要）');
      if (!(isStr(s.at) && ISO.test(s.at) && !Number.isNaN(Date.parse(s.at)))) p.push('source.at 写用户说这句话的时间（ISO 8601）');
    }
  } else if (r.decision === 'comment' && !isStr(r.summary) && !isStr(r.quote) && !Array.isArray(r.issues)) p.push('comment 记录要写 summary、issues 或 quote 之一');
  if (!isObj(r.recordedBy) || !isStr(r.recordedBy.name) || !['human', 'ai'].includes(r.recordedBy.kind)) p.push('recordedBy 是 { kind: human | ai, name }');
  if (!(isStr(r.recordedAt) && ISO.test(r.recordedAt) && !Number.isNaN(Date.parse(r.recordedAt)))) p.push('recordedAt 写录入时间（ISO 8601）');
  if (r.decision === 'waive' && r.gate === 'final') p.push('final 不能豁免：「已交付 · 用户已认可」必须有用户对成片的认可原话');
  if (r.decision === 'waive' && r.gate === 'structure') p.push('structure 只记录、不阻断，不需要豁免');
  if (r.reviewed !== undefined && !(Array.isArray(r.reviewed) && r.reviewed.every(x => isObj(x) && isStr(x.path) && SHA.test(x.sha256 ?? '')))) p.push('reviewed 是 [{ path, sha256, kind }]');
  if (r.decision === 'approve' && GATES.includes(r.gate) && !(Array.isArray(r.reviewed) && r.reviewed.length)) p.push(`${r.gate} 的认可必须列出用户看过的文件（路径与 sha256）`);
  if (r.gate === 'animatic' && r.decision === 'approve') {
    const t = r.timing;
    if (!isObj(t) || !Number.isInteger(t.fps) || !Number.isInteger(t.frameCount) || !Array.isArray(t.shots) || !SHA.test(t.timingSha256 ?? '') || !SHA.test(t.eventsSha256 ?? '')) p.push('animatic 认可必须冻结当时的镜头表 timing');
  }
  return p;
}

function builtinRead(film) {
  const dir = path.join(film.dir, 'review');
  const records = [], diagnostics = [];
  if (!fs.existsSync(dir)) return { records, diagnostics };
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    if (!REVIEW_FILE.test(name)) { diagnostics.push({ level: 'warning', code: 'review-file-name', path: `review/${name}`, message: `review/${name} 不是 <闸>-<YYYY-MM-DD>[-n].json，状态计算不读它` }); continue; }
    let rec = null, problems;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')); problems = reviewProblems(rec, { filmId: film.id }); } catch (e) { problems = [`不是合法 JSON（${e.message}）`]; }
    if (rec?.gate && rec.gate !== name.split('-')[0]) problems.push(`文件名是 ${name.split('-')[0]}，记录里写的是 ${rec.gate}`);
    records.push({ file: path.join(dir, name), name, record: rec, valid: !problems.length, diagnostics: problems.map(m => ({ level: 'error', code: 'review-invalid', path: `review/${name}`, message: m })) });
  }
  const seq = n => { const m = /-(\d+)\.json$/.exec(n.replace(/^[a-z]+-\d{4}-\d{2}-\d{2}/, '')); return m ? Number(m[1]) : 1; };
  const day = n => (/\d{4}-\d{2}-\d{2}/.exec(n) ?? [''])[0];
  records.sort((a, b) => (Date.parse(a.record?.recordedAt ?? '') || 0) - (Date.parse(b.record?.recordedAt ?? '') || 0) || day(a.name).localeCompare(day(b.name)) || seq(a.name) - seq(b.name) || a.name.localeCompare(b.name));
  return { records, diagnostics };
}

function builtinVerdict(records, gate, view) {
  const mine = records.filter(r => r.record?.gate === gate);
  const invalid = mine.filter(r => !r.valid);
  const decisions = mine.filter(r => r.valid && HUMAN_DECISIONS.includes(r.record.decision));
  const base = { gate, records: mine.length, invalid: invalid.map(r => r.name), comments: mine.filter(r => r.valid && r.record.decision === 'comment').length };
  const last = decisions.at(-1);
  if (!last) return { ...base, status: 'missing', record: null, reason: invalid.length ? `有 ${invalid.length} 条无效记录（${invalid.map(r => r.name).join('、')}），不算数` : '没有记录' };
  const rec = last.record, at = { file: last.name, quote: rec.quote, source: rec.source, recordedAt: rec.recordedAt };
  if (rec.decision === 'reject') return { ...base, status: 'rejected', record: at, reason: `用户否定：${rec.quote}` };
  if (rec.decision === 'waive') return { ...base, status: 'waived', record: at, reason: `用户豁免：${rec.quote}` };
  if (gate === 'animatic' && view) {
    const now = timingSnapshot(view);
    if (rec.timing?.timingSha256 !== now.timingSha256) return { ...base, status: 'stale', record: at, reason: '认可之后镜头表改过（切点、帧率或总帧数变了）：把新的预演给用户看' };
  }
  if (gate === 'look' && view?.style && rec.style && (rec.style.id !== view.style.id || String(rec.style.version) !== String(view.style.version))) {
    return { ...base, status: 'stale', record: at, reason: `认可的是风格 ${rec.style.id}@${rec.style.version}，现在是 ${view.style.id}@${view.style.version}` };
  }
  return { ...base, status: 'approved', record: at, reason: `用户认可：${rec.quote}`, reviewed: rec.reviewed ?? [] };
}

function builtinWrite(film, record) {
  const dir = path.join(film.dir, 'review');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date(Date.parse(record.recordedAt));
  const stem = `${record.gate}-${dateStamp(Number.isNaN(d.getTime()) ? new Date() : d)}`;
  const text = formatFilmJson(record);
  const tmp = path.join(dir, `.new-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    for (let i = 1; i < 100; i++) {
      const target = path.join(dir, i === 1 ? `${stem}.json` : `${stem}-${i}.json`);
      try { fs.linkSync(tmp, target); return target; } catch (e) {
        if (e.code === 'EEXIST') continue;
        try { fs.writeFileSync(target, text, { flag: 'wx' }); return target; } catch (e2) { if (e2.code === 'EEXIST') continue; throw e2; }
      }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
  throw new FilmError(EXIT.BUSY, 'review-name', `review/ 下 ${stem} 的记录过多`);
}

// ───────────────────────── 对外接口（编排器只用这几个） ─────────────────────────

/** 路径基准：普通作品是作品目录；镜像作品（film.json 的 mirror.paths = "repo"，如 films/beiming-10s）是仓库根。 */
export const pathBaseOf = film => film.pathBase || film.dir;

/**
 * 拼一条记录（还没写盘）。input = { gate, decision, reviewer?: {kind,name}, quote?, source?: {kind,ref,at}, recordedBy?, reviewed?: [绝对路径或 {path,sha256,kind}], summary?, notes?, evidenceFrames?, mustChange? }
 */
export async function buildRecord(film, input, { now = new Date() } = {}) {
  const base = pathBaseOf(film);
  const reviewed = (input.reviewed || []).map(x => {
    if (typeof x === 'string') return { path: path.relative(base, x).split(path.sep).join('/'), sha256: sha256File(x), kind: kindOfFile(x) };
    return x;
  });
  const L = await productionLib();
  const extra = {};
  for (const k of ['summary', 'notes', 'evidenceFrames', 'mustChange', 'rejectedOn', 'issues', 'shots', 'scores', 'vetoes']) if (input[k] !== undefined) extra[k] = input[k];
  if (L) {
    const pf = await p05Film(L, film);
    if (pf) {
      return L.review.buildReview({ film: pf, pathBase: base, gate: input.gate, decision: input.decision, quote: input.quote, source: input.source,
        reviewer: input.reviewer, recordedBy: input.recordedBy, reviewed, ...extra }, { now });
    }
  }
  const view = filmView(film);
  const rec = {
    schemaVersion: 1, film: film.id, gate: input.gate, decision: input.decision,
    reviewer: input.reviewer ?? { kind: 'human', name: '用户' }, quote: input.quote, source: input.source,
    recordedBy: input.recordedBy ?? { kind: 'ai', name: 'agent' }, recordedAt: isoLocal(now),
    reviewed: reviewed.length ? reviewed : undefined,
    timing: input.gate === 'animatic' ? timingSnapshot(view) : undefined,
    style: input.gate === 'look' && view.style ? view.style : undefined,
    ...extra,
  };
  return JSON.parse(JSON.stringify(rec));
}

const kindOfFile = f => (/\.(mp4|mov)$/i.test(f) ? 'video' : /\.(jpe?g|png|webp)$/i.test(f) ? 'image' : /\.html?$/i.test(f) ? 'page' : 'file');

/** 校验并写一条记录（只增不改）；不合格抛 FilmError(4)。返回仓库相对路径。 */
export async function writeRecord(film, record) {
  const L = await productionLib();
  if (L) {
    const pf = await p05Film(L, film);
    const v = L.review.validateReview(record, { film: pf });
    const errs = v.diagnostics.filter(d => d.level === 'error');
    if (errs.length) throw new FilmError(EXIT.CONTRACT, 'review-invalid', `审片记录不合格，没有写入：${errs.map(d => d.message).join('；')}`, errs.find(d => d.hint)?.hint || '按 npm run film -- review --help 的写法补全');
    const r = L.review.writeReview(film.dir, record);
    return rel(r.path);
  }
  const problems = reviewProblems(record, { filmId: film.id });
  if (problems.length) throw new FilmError(EXIT.CONTRACT, 'review-invalid', `审片记录不合格，没有写入：${problems.join('；')}`, '按 npm run film -- review --help 的写法补全');
  return rel(builtinWrite(film, record));
}

/** 各道闸的现状：{ look, animatic, final }，每道 { required, state, record, quote, source, at, reason, invalid[], comments }；另有不可枚举的 diagnostics。 */
export async function gateStatus(film) {
  const L = await productionLib();
  let records, diagnostics, judge;
  if (L) {
    const pf = await p05Film(L, film);
    ({ records, diagnostics } = L.review.readReviews(film.dir, { film: pf }));
    judge = g => L.review.gateVerdict(records, g, pf);
  } else {
    ({ records, diagnostics } = builtinRead(film));
    const view = filmView(film);
    judge = g => builtinVerdict(records, g, view);
  }
  const out = {};
  for (const g of GATES) {
    const v = judge(g);
    out[g] = {
      required: g === 'final' || film.gates?.[g] !== 'optional', state: v.status, label: STATE_LABEL[v.status] || v.status,
      record: v.record?.file ? rel(path.join(film.dir, 'review', v.record.file)) : null, quote: v.record?.quote ?? null,
      source: v.record?.source ?? null, at: v.record?.recordedAt ?? null, reason: v.reason ?? null,
      invalid: v.invalid || [], comments: v.comments || 0, reviewed: v.reviewed || [],
    };
  }
  const invalid = records.filter(r => !r.valid).map(r => ({ file: rel(r.file), problems: r.diagnostics.filter(d => d.level === 'error').map(d => d.message) }));
  Object.defineProperty(out, 'invalid', { value: invalid, enumerable: false });
  Object.defineProperty(out, 'diagnostics', { value: diagnostics, enumerable: false });
  Object.defineProperty(out, 'by', { value: L ? 'engine/production/review.js' : 'tools/film/lib/gates.mjs（内置，同格式）', enumerable: false });
  return out;
}

export const passes = s => s.state === 'approved' || s.state === 'waived';

// 终渲前的闸门检查：返回放行依据；不满足时抛 FilmError(4)，信息里给出补记录的确切命令
export function assertFinalAllowed(film, status) {
  const blockers = ['look', 'animatic'].filter(g => status[g].required && !passes(status[g]));
  if (!blockers.length) return ['look', 'animatic'].map(g => ({ gate: g, state: status[g].state, record: status[g].record || null }));
  const desc = blockers.map(g => {
    const s = status[g];
    const why = s.state === 'missing' ? (s.invalid.length ? `只有不合格的记录（${s.invalid.join('、')}）` : s.comments ? '只有代理审片或内部豁免说明（不放行）' : '没有用户认可的记录')
      : s.state === 'rejected' ? `用户要求修改（${s.at}）` : s.state === 'stale' ? `认可已失效：${s.reason}` : s.state;
    return `${GATE_LABEL[g]}：${why}`;
  }).join('；');
  const d = film.relDir;
  const first = blockers[0];
  const make = first === 'look' ? `npm run film -- stills ${d}` : `npm run film -- animatic ${d}`;
  throw new FilmError(EXIT.CONTRACT, 'gate-blocked', `拒绝终渲：${desc}`,
    `按顺序过闸：先 ${make}，把产物给用户看，用户认可后按原话记录 npm run film -- review approve ${first} ${d} --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>"` +
    `${blockers.length > 1 ? `，再过 ${blockers.slice(1).join('、')}` : ''}；` +
    `用户明确说不用看时记豁免：npm run film -- review waive ${blockers.join(',')} ${d} --reason "<理由>" --quote "<用户原话>" --source "<出处>"。agent 不得自己批准，也不得替用户写原话`);
}

/** --source 的文字 → { kind, ref, at }。kind 缺省 session；at 缺省是录入时间（用户刚在会话里说的）。 */
export function sourceOf(ref, { kind = 'session', at = null } = {}, now = new Date()) {
  if (!SOURCE_KINDS.includes(kind)) throw new FilmError(EXIT.USAGE, 'source-kind', `--source-kind 只能是 ${SOURCE_KINDS.join(' / ')}，收到「${kind}」`);
  if (at && (!ISO.test(at) || Number.isNaN(Date.parse(at)))) throw new FilmError(EXIT.USAGE, 'said-at', `--said-at 要写 ISO 8601 时间（如 2026-11-10T15:32:00+08:00），收到「${at}」`);
  return { kind, ref, at: at || isoLocal(now) };
}

/** 用户看过的文件 → [{ path（相对路径基准）, sha256, kind }] */
export function hashFiles(film, files) {
  const base = pathBaseOf(film);
  return files.filter(f => f && fs.existsSync(f)).map(f => ({ path: path.relative(base, f).split(path.sep).join('/'), sha256: sha256File(f), kind: kindOfFile(f) }));
}

/**
 * 出片时一并记豁免（build --waive）：有用户原话 → 每道闸一条 waive 记录（reviewer = human）；
 * 没有 → 每道闸一条 comment（内部豁免说明，不放行终渲）。返回 { files, kind: user|internal }。
 */
export async function recordWaivers(film, gates, { reason, quote = null, source = null, sourceKind, saidAt, reviewer = null, recordedBy = null }) {
  const user = !!(quote && source);
  const files = [];
  for (const gate of gates) {
    const rec = user
      ? await buildRecord(film, { gate, decision: 'waive', reviewer: { kind: 'human', name: reviewer || '用户' }, quote, source: sourceOf(source, { kind: sourceKind || 'session', at: saidAt || null }), recordedBy: recordedBy || { kind: 'ai', name: 'agent' }, summary: `豁免理由：${reason}` })
      : await buildRecord(film, { gate, decision: 'comment', reviewer: { kind: 'ai', name: 'agent' }, recordedBy: recordedBy || { kind: 'ai', name: 'agent' }, summary: `内部豁免说明（没有用户原话，不放行终渲）：${reason}` });
    files.push(await writeRecord(film, rec));
  }
  return { files, kind: user ? 'user' : 'internal' };
}
