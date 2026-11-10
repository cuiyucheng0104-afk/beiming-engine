// 北冥引擎 · 作品状态机与闸门判定（决策 D08）：draft → look-approved → animatic-approved → rendered → qa-passed → accepted。
// 状态不写进任何文件，每次由三样东西现算：film.json、review/ 里的审片记录、最近一次运行 out/latest → <run-id>/run.json 与 qa/report.json。
// 只有连续满足的阶段才算数：没过 animatic 就出的终渲、QA 报告对不上成片的、用户认可的不是这一版成片的，都不往上走。
//
//   filmStatus(target)               → { state, label, film, gates, run, qa, canFinal, diagnostics, next }
//   assertFinalAllowed(target)       终渲前调用：look 与 animatic 都已认可或豁免才放行，否则抛 GateError（退出码 4）
//   assertDelivered(target)          只有 accepted 才放行（生成「已交付」字样之前调用）
//   recordReview(target, input)      记一条审片结论：拼记录、算所看文件 sha256、校验，合格才原子地写 review/<闸>-<日期>.json
//   deliveryLabel(state)             状态 → 对外文字；只有 accepted 得到「已交付 · 用户已认可」
//   findUnbackedClaims(text, state)  在说明文字里找没有 accepted 撑腰的「已交付」「用户已认可」一类说法
//   validateRunRecord(run, { film, runDir }) / validateQaReport(report, { film, runShas })   运行记录（附录 C8）与 QA 报告的最小校验
//   readLatestRun(loaded)            按 latest 指针文件找最近一次运行（不跟符号链接）
// 运行目录：普通作品 films/<名>/out/<run-id>/；镜像作品用 film.json 的 mirror.outDir（如 out/beiming/<run-id>/）。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FilmError, loadFilm } from './film.js';
import { REPO_ROOT, readJsonFile } from './io.js';
import { validateRenderResult } from './project.js';
import { GATES, buildReview, gateVerdict, readReviews, validateReview, writeReview } from './review.js';

export const STATES = Object.freeze(['draft', 'look-approved', 'animatic-approved', 'rendered', 'qa-passed', 'accepted']);
export const STATE_LABELS = Object.freeze({
  invalid: '作品描述不合格（先修 film.json）',
  draft: '制作中：风格帧还没有用户认可',
  'look-approved': '风格已认可，待动态预演认可',
  'animatic-approved': '动态预演已认可，可以终渲',
  rendered: '已终渲，待机器 QA',
  'qa-passed': '技术检查通过，待用户审看成片',
  accepted: '已交付 · 用户已认可',
});
/** 只能由 accepted 生成的说法。 */
export const RESERVED_CLAIMS = Object.freeze(['已交付', '用户已认可', '用户认可', '已获认可', '客户已认可', '已验收', '交付完成']);
export const RUN_KINDS = Object.freeze(['final', 'animatic', 'preview', 'still']);
/** 出片已完成的运行状态（rendered = 待 QA，passed = 技术验收通过，accepted = 创作验收也通过）。 */
const DONE_STATUSES = Object.freeze(['rendered', 'passed', 'accepted']);
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{7,40}(-dirty)?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.trim().length > 0;

export class GateError extends FilmError {
  constructor(message, { hint = '', status = null } = {}) {
    super('gate-closed', message, { hint, exitCode: 4 });
    this.name = 'GateError';
    this.status = status;
  }
}

export function deliveryLabel(state) {
  return STATE_LABELS[typeof state === 'string' ? state : state?.state] ?? STATE_LABELS.invalid;
}

/** 引号里的词是在说这个词本身（「已交付」只能由 accepted 生成），不是声称已交付。 */
const QUOTE_PAIRS = { '「': '」', '『': '』', '“': '”', '"': '"', "'": "'", '`': '`', '《': '》', '‘': '’' };

export function findUnbackedClaims(text, state) {
  if ((typeof state === 'string' ? state : state?.state) === 'accepted') return [];
  const s = String(text), out = [];
  for (const claim of RESERVED_CLAIMS) {
    let i = s.indexOf(claim);
    while (i >= 0) {
      const before = s.slice(Math.max(0, i - 2), i), open = s[i - 1], close = s[i + claim.length];
      const negated = /[未不没非]$/.test(before);                       // 「未交付」「不算已验收」这类否定说法放行
      const quoted = Object.hasOwn(QUOTE_PAIRS, open ?? '') && QUOTE_PAIRS[open] === close;   // 「已交付」这样提到词本身也放行
      // 「用户认可」被更长的「用户已认可」覆盖时只报一次
      const covered = out.some(o => o.index <= i && i + claim.length <= o.index + o.claim.length);
      if (!negated && !quoted && !covered) out.push({ claim, index: i });
      i = s.indexOf(claim, i + claim.length);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ───────────────────────── 运行记录与 QA 报告 ─────────────────────────

/**
 * 运行记录（附录 C8：RenderResult v1 扩展）。按 project.js 的 validateRenderResult 的 strict 口径校验：
 * accepted 必须有人工认可的评审，技术验收 passed 必须指向运行目录里一份 ok = true 的 QA 报告；另查 kind 与作品是否对得上。
 */
export function validateRunRecord(run, { film = null, runDir = null } = {}) {
  const diagnostics = [];
  const err = (code, path, message, hint = '') => diagnostics.push({ level: 'error', code, path, message, hint });
  const warn = (code, path, message, hint = '') => diagnostics.push({ level: 'warning', code, path, message, hint });
  if (!isObj(run)) { err('run-invalid', '$', 'run.json 必须是 JSON 对象'); return { ok: false, diagnostics }; }
  if (run.schemaVersion === 1) {
    const expectedFrameCount = film && run.kind === 'final' ? film.output.frameCount : undefined;
    for (const d of validateRenderResult(run, { strict: true, runDir, expectedFrameCount }).diagnostics) {
      err(d.code, d.path, d.message, d.code === 'technical-evidence-not-qa' ? 'QA 判定由 tools/qa 写进 <run-id>/qa/report.json；渲染器只写 not-run' : '');
    }
  } else err('run-schema', 'schemaVersion', `run.json 的 schemaVersion 必须是 1（RenderResult v1 扩展），收到 ${JSON.stringify(run.schemaVersion)}`);
  if (run.kind === undefined) warn('run-kind-missing', 'kind', 'run.json 没有 kind，无法确认是终渲', `写 kind：${RUN_KINDS.join(' / ')}（终渲写 final）`);
  else if (!RUN_KINDS.includes(run.kind)) err('run-kind', 'kind', `kind 只能是 ${RUN_KINDS.join(' / ')}`);
  if (film && run.projectId !== undefined && run.projectId !== null && run.projectId !== film.id) err('run-film', 'projectId', `run.json 属于 ${run.projectId}，不是 ${film.id}`);
  const o = run.output ?? {};
  if (film && run.kind === 'final' && DONE_STATUSES.includes(run.status)) {
    const want = { width: film.output.width, height: film.output.height, fps: film.output.fps, frames: film.output.frameCount };
    for (const [k, v] of Object.entries(want)) if (o[k] !== v) err('run-output-mismatch', `output.${k}`, `终渲 ${k}=${JSON.stringify(o[k])}，作品要求 ${v}`);
  }
  if (o.sha256 !== undefined && o.sha256 !== null && !SHA.test(o.sha256)) err('run-output-sha', 'output.sha256', 'output.sha256 是 64 位小写十六进制');
  return { ok: !diagnostics.some(d => d.level === 'error'), diagnostics };
}

/** QA 报告（附录 C8）：{ schemaVersion: 1, film, input: { path, sha256 }, profile, checks: [{ id, status, value, expected, evidence, waiver? }], ok } */
export function validateQaReport(report, { film = null, runShas = null } = {}) {
  const diagnostics = [];
  const err = (code, path, message, hint = '') => diagnostics.push({ level: 'error', code, path, message, hint });
  if (!isObj(report)) { err('qa-invalid', '$', 'qa/report.json 必须是 JSON 对象'); return { ok: false, diagnostics }; }
  if (report.schemaVersion !== 1) err('qa-schema', 'schemaVersion', 'QA 报告的 schemaVersion 必须是 1');
  if (film && report.film !== film.id) err('qa-film', 'film', `报告属于 ${JSON.stringify(report.film)}，不是 ${film.id}`);
  if (!isObj(report.input) || !isStr(report.input.path) || !SHA.test(report.input.sha256 ?? '')) err('qa-input', 'input', 'input 是 { path, sha256 }：QA 查的是哪个文件');
  else if (runShas && !runShas.has(report.input.sha256)) err('qa-input-stale', 'input.sha256', 'QA 报告查的文件不是这次运行的产物（sha256 对不上）', '对最新成片重跑 QA');
  if (film && !film.deliveries.includes(report.profile)) err('qa-profile', 'profile', `报告用的档位 ${JSON.stringify(report.profile)} 不在作品的 deliveries 里`);
  if (!Array.isArray(report.checks)) err('qa-checks', 'checks', 'checks 是检查项数组');
  else report.checks.forEach((c, i) => {
    if (!isObj(c) || !isStr(c.id) || !['pass', 'fail', 'warn', 'waived'].includes(c.status)) err('qa-check', `checks[${i}]`, '每项写 { id, status: pass | fail | warn | waived, value, expected, evidence }');
    else if (c.status === 'waived' && !(isStr(c.waiver) || isObj(c.waiver))) err('qa-waiver', `checks[${i}].waiver`, `检查 ${c.id} 标成 waived 却没写豁免依据`);
  });
  const failed = Array.isArray(report.checks) && report.checks.some(c => c?.status === 'fail');
  if (typeof report.ok !== 'boolean') err('qa-ok', 'ok', 'ok 必须是布尔值');
  else if (report.ok && failed) err('qa-ok-inconsistent', 'ok', '有 fail 的检查项，ok 却是 true');
  return { ok: !diagnostics.some(d => d.level === 'error'), diagnostics, passed: report.ok === true && !failed };
}

/** 最近一次运行：<outRoot>/latest 是指针文件（内容是 run-id 一行，或 { "runId": "…" }），不跟符号链接。 */
export function readLatestRun(loaded) {
  const raw = loaded.raw ?? {};
  const outRoot = isObj(raw.mirror) && raw.mirror.paths === 'repo' && isStr(raw.mirror.outDir) ? resolve(REPO_ROOT, raw.mirror.outDir) : join(loaded.filmDir, 'out');
  const pointer = join(outRoot, 'latest');
  const diagnostics = [];
  if (!existsSync(pointer)) return { outRoot, runId: null, runDir: null, run: null, qa: null, diagnostics };
  if (statSync(pointer).isDirectory()) {
    diagnostics.push({ level: 'error', code: 'latest-not-pointer', path: 'out/latest', message: 'out/latest 应是指针文件（写 run-id），不是目录或符号链接', hint: 'Windows 上符号链接不可靠：写一行 run-id' });
    return { outRoot, runId: null, runDir: null, run: null, qa: null, diagnostics };
  }
  let text = readFileSync(pointer, 'utf8').replace(/^﻿/, '').trim(), runId = text;
  if (text.startsWith('{')) { try { runId = JSON.parse(text).runId; } catch { runId = null; } }
  if (!isStr(runId) || !SAFE_NAME.test(runId) || runId.includes('..')) {
    diagnostics.push({ level: 'error', code: 'latest-invalid', path: 'out/latest', message: `latest 指针内容不合格：${JSON.stringify(text.slice(0, 80))}` });
    return { outRoot, runId: null, runDir: null, run: null, qa: null, diagnostics };
  }
  if (!RUN_ID.test(runId)) diagnostics.push({ level: 'warning', code: 'run-id-format', path: 'out/latest', message: `run-id ${runId} 不是 YYYYMMDD-HHMMSS-<短提交>[-dirty] 格式（附录 C4）` });
  const runDir = join(outRoot, runId);
  const r = readJsonFile(join(runDir, 'run.json'));
  const run = r.ok ? r.value : null;
  if (!r.ok) diagnostics.push({ level: 'error', code: `run-${r.code}`, path: `${runId}/run.json`, message: r.message });
  const q = readJsonFile(join(runDir, 'qa', 'report.json'));
  const qa = q.ok ? q.value : null;
  if (!q.ok && q.code !== 'not-found') diagnostics.push({ level: 'error', code: `qa-${q.code}`, path: `${runId}/qa/report.json`, message: q.message });
  return { outRoot, runId, runDir, run, qa, diagnostics };
}

const runShasOf = run => new Set([run?.output?.sha256, ...(Array.isArray(run?.outputs) ? run.outputs.map(x => x?.sha256) : [])].filter(s => typeof s === 'string' && SHA.test(s)));

// ───────────────────────── 状态 ─────────────────────────

export function filmStatus(target, { loaded = null } = {}) {
  const L = loaded ?? loadFilm(target);
  const diagnostics = [...L.diagnostics];
  const film = L.film;
  const reviews = readReviews(L.filmDir, { film });
  diagnostics.push(...reviews.diagnostics);
  for (const r of reviews.records) if (!r.valid) diagnostics.push(...r.diagnostics.filter(d => d.level === 'error').map(d => ({ ...d, path: `review/${r.name}:${d.path}` })));
  const gates = {};
  for (const g of ['structure', ...GATES]) gates[g] = gateVerdict(reviews.records, g, film);
  const next = [];
  if (!L.ok) {
    return { state: 'invalid', label: STATE_LABELS.invalid, film: null, filmDir: L.filmDir, gates, run: null, qa: null, canFinal: false, diagnostics, next: ['node engine/production/film.js check <作品> 看诊断并修好 film.json'] };
  }
  const passed = g => ['approved', 'waived'].includes(gates[g].status);
  const lookOk = passed('look'), animaticOk = lookOk && passed('animatic');
  if (gates.animatic.status === 'approved' && !lookOk) diagnostics.push({ level: 'warning', code: 'gate-order', path: 'review', message: 'animatic 已认可，但 look 没有认可或豁免：状态停在 draft', hint: '先补 look 的认可记录（或用户原话的豁免）' });

  const latest = readLatestRun(L);
  diagnostics.push(...latest.diagnostics);
  let rendered = false, qaPassed = false, accepted = false, runInfo = null, qaInfo = null;
  if (latest.run) {
    const rv = validateRunRecord(latest.run, { film, runDir: latest.runDir });
    diagnostics.push(...rv.diagnostics.map(d => ({ ...d, path: `${latest.runId}/run.json:${d.path}` })));
    const shas = runShasOf(latest.run);
    runInfo = { runId: latest.runId, kind: latest.run.kind ?? null, status: latest.run.status ?? null, valid: rv.ok, outputs: [...shas] };
    rendered = rv.ok && latest.run.kind === 'final' && DONE_STATUSES.includes(latest.run.status) && shas.size > 0;
    if (rendered && !animaticOk) {
      diagnostics.push({ level: 'warning', code: 'render-bypassed-gate', path: `${latest.runId}/run.json`, message: '有终渲产物，但出片时 look / animatic 没有认可或豁免：这次终渲绕过了闸门，不计入状态', hint: '补齐认可后重新终渲' });
      rendered = false;
    }
    if (latest.qa) {
      const qv = validateQaReport(latest.qa, { film, runShas: shas });
      diagnostics.push(...qv.diagnostics.map(d => ({ ...d, path: `${latest.runId}/qa/report.json:${d.path}` })));
      qaInfo = { ok: latest.qa.ok ?? null, valid: qv.ok, failed: (latest.qa.checks ?? []).filter(c => c?.status === 'fail').map(c => c.id) };
      qaPassed = rendered && qv.ok && qv.passed;
    }
    if (qaPassed && gates.final.status === 'approved') {
      const seen = (gates.final.reviewed ?? []).map(x => x.sha256);
      if (seen.some(s => shas.has(s))) accepted = true;
      else {
        gates.final = { ...gates.final, status: 'stale', reason: '用户认可的不是这次运行的成片（sha256 对不上）：把最新成片给用户看并记录' };
      }
    }
  } else if (gates.final.status === 'approved') {
    gates.final = { ...gates.final, status: 'stale', reason: '找不到最近一次运行，无法核对用户认可的是哪一版成片' };
  }
  const state = accepted ? 'accepted' : qaPassed ? 'qa-passed' : rendered ? 'rendered' : animaticOk ? 'animatic-approved' : lookOk ? 'look-approved' : 'draft';

  const cmd = `node engine/production/film.js review ${L.filmDir === resolve(L.filmDir) ? '<作品>' : L.filmDir}`;
  if (gates.structure.status === 'missing') next.push('（建议）⛔1 结构确认：把一句话、三候选结构与对标表给用户，记录原话（--gate structure）');
  if (!lookOk) next.push(`⛔2 风格：出风格帧 / 色彩脚本条给用户看，记录认可：${cmd} --gate look --decision approve --file <风格帧> --quote "<原话>" --source-ref "<出处>"`);
  else if (!animaticOk) next.push(`⛔3 动态预演：按正片时间轴出半分辨率预演给用户看，记录认可：${cmd} --gate animatic --decision approve --file <预演片> --quote "<原话>" --source-ref "<出处>"`);
  else if (!rendered) next.push('终渲：npm run film -- render <作品> --final（工具接入前用 engine/render）；run.json 写 kind: "final"、status: "rendered"');
  else if (!qaPassed) next.push('机器 QA：对这次成片跑 tools/qa，报告写到 <run-id>/qa/report.json');
  else if (!accepted) next.push(`⛔4 成片：把这次的成片给用户全速带声看完，记录认可：${cmd} --gate final --decision approve --file <成片> --quote "<原话>" --source-ref "<出处>"`);

  return { state, label: STATE_LABELS[state], film: { id: film.id, title: film.title, frameCount: film.output.frameCount, fps: film.output.fps, profile: film.output.profile }, filmDir: L.filmDir, gates, run: runInfo, qa: qaInfo, canFinal: animaticOk, diagnostics, next };
}

/**
 * 记一条审片结论（命令行 film.js review 与 tools/film 共用）：按作品拼记录、算所看文件的 sha256、校验，合格才写文件。
 * input 同 review.js 的 buildReview（不含 film / pathBase）；所看文件 reviewed[].path 相对作品的路径基准（镜像作品是仓库根）。
 * 不合格时抛 FilmError（code 是第一条错误的 code，exitCode 4，diagnostics 是全部诊断），不写任何文件。
 * @returns {{ record: object, path: string | null, sha256: string | null, diagnostics: object[], status: object | null }}
 */
export function recordReview(target, input, { dryRun = false, now = new Date() } = {}) {
  const L = loadFilm(target);
  if (!L.ok) {
    const e = L.diagnostics.find(d => d.level === 'error');
    throw new FilmError('contract', `film.json 不合格，不能记录审片：[${e.code}] ${e.path}：${e.message}`, { exitCode: 4, hint: e.hint || 'node engine/production/film.js check <作品>', diagnostics: L.diagnostics });
  }
  const record = buildReview({ ...input, film: L.film, pathBase: L.pathBase }, { now });
  const v = validateReview(record, { film: L.film });
  const errors = v.diagnostics.filter(d => d.level === 'error');
  if (errors.length) throw new FilmError(errors[0].code, `审片记录不合格，没有写文件：${errors[0].message}`, { exitCode: 4, hint: errors[0].hint, diagnostics: v.diagnostics });
  if (dryRun) return { record, path: null, sha256: null, diagnostics: v.diagnostics, status: null };
  const w = writeReview(L.filmDir, record);
  return { record, path: w.path, sha256: w.sha256, diagnostics: v.diagnostics, status: filmStatus(L.filmDir) };
}

export function assertFinalAllowed(target, opts = {}) {
  const s = filmStatus(target, opts);
  if (s.state === 'invalid') throw new GateError('film.json 不合格，不能终渲', { hint: s.next[0], status: s });
  if (s.canFinal) return s;
  const missing = ['look', 'animatic'].filter(g => !['approved', 'waived'].includes(s.gates[g].status)).map(g => `${g}（${s.gates[g].status}：${s.gates[g].reason}）`);
  throw new GateError(`拒绝终渲：${missing.join('；')}`, {
    hint: '先把风格帧 / 动态预演给用户看并记录认可；用户明确说跳过时，记录豁免：node engine/production/film.js review <作品> --gate <look|animatic> --decision waive --quote "<用户原话>" --source-ref "<出处>"',
    status: s,
  });
}

export function assertDelivered(target, opts = {}) {
  const s = filmStatus(target, opts);
  if (s.state === 'accepted') return s;
  throw new GateError(`还不能写「已交付」：当前状态 ${s.state}（${s.label}）`, { hint: s.next[0] ?? '', status: s });
}
