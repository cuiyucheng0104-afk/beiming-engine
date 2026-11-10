// 北冥引擎 · engine/production/film.js 的命令行（film.js 被直接运行时加载；库调用方不需要它）。
// 命令约定用治理骨架的 tools/lib/cli.mjs（docs/CLI.md，附录 C1–C2）：
//   - 每个子命令严格解析：未知选项、缺参数、非法数值、多余的位置参数一律退出 2，并给「是不是想写 --xxx」；
//   - -h / --help 打印到 stdout、退出 0、不读写任何作品文件；
//   - --json 时 stdout 只有一个信封 { schemaVersion, ok, exitCode, command, error, outputs, runJson, warnings, data }，
//     命令自己的结果在 data（例如 check 的 data.diagnostics）；给人看的结果在 stdout、日志与错误在 stderr；
//   - 错误码的前缀决定退出码：usage.* → 2、contract.* → 4（契约 / 闸门不通过）、failure.* → 1；
//   - SIGINT / SIGTERM：删掉还没改名的临时文件，再以 130 / 143 退出（仍输出一个信封）。
// 面向用户的统一入口是 tools/film（npm run film -- …，出片编排包）；这里是库自己的入口，给检查、调试与编排调用。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError, defineCommand, runCli, suggest } from '../../tools/lib/cli.mjs';
import {
  FilmError, assertValidFilm, filmSummary, loadFilm, loadProfiles, migrateV2, qaExpectations, retime, upgradeFilm, validateFilm, writeFilmJson,
} from './film.js';
import { REPO_ROOT, cleanupTemps, formatJson, readJsonFile, repoRelative, toPosix, writeJsonAtomic } from './io.js';
import { DECISIONS, RECORD_GATES, REVIEWER_KINDS, RUBRIC_DIMENSIONS, SOURCE_KINDS, VETOES, isoLocal } from './review.js';
import { assertDelivered, assertFinalAllowed, filmStatus, qaReportIds, recordReview, validateQaReport, validateRunRecord } from './state.js';
import { TimelineError, cutList, legacyEvents, legacyTimeline } from './timeline.js';

const PROG = 'node engine/production/film.js';
const PREFIX = { 1: 'failure', 2: 'usage', 3: 'env', 4: 'contract', 5: 'busy' };

// ───────────────────────── 共用 ─────────────────────────

/** 输出里的路径一律仓库相对、正斜杠（docs/CLI.md §2）。 */
const shown = p => repoRelative(resolve(p)) ?? toPosix(p);
const fmtDiag = d => `${d.level === 'error' ? '✗' : '!'} [${d.code}] ${d.path}：${d.message}${d.hint ? `\n    → ${d.hint}` : ''}`;
const diagWarnings = diags => diags.filter(d => d.level === 'warning').map(d => ({ code: d.code, message: `${d.path}：${d.message}`, hint: d.hint || null }));
const firstError = diags => diags.find(d => d.level === 'error');
const usage = (code, message, hint = null) => new CliError(`usage.${code}`, message, hint);

/** 库抛的 FilmError / GateError / TimelineError 换成命令约定的错误（code 带退出码前缀）。 */
function toCliError(e) {
  if (e instanceof CliError) return e;
  if (e instanceof FilmError) {
    const data = e.status ? { status: e.status } : e.diagnostics?.length ? { diagnostics: e.diagnostics } : undefined;
    return new CliError(`${PREFIX[e.exitCode] ?? 'failure'}.${e.code}`, e.message, { hint: e.hint || null, exitCode: e.exitCode, data });
  }
  if (e instanceof TimelineError) return new CliError(`contract.${e.code}`, e.message, { hint: e.hint || null });
  return e;
}
/** 包一层：库错误变成命令错误；其余异常交给 runCli 记为 failure.internal。 */
const guard = fn => async ctx => { try { return await fn(ctx); } catch (e) { throw toCliError(e); } };

/** 读作品：找不到 → usage.not-found（2）；坏 JSON → contract.json-invalid（4）。消息里的路径换成仓库相对。 */
function load(target, opts) {
  try { return loadFilm(target, opts); } catch (e) {
    if (e instanceof FilmError && e.code === 'not-found') {
      throw usage('not-found', `找不到作品描述：${shown(resolve(target))}${/\.json$/i.test(target) ? '' : '/film.json'}`, e.hint || null);
    }
    if (e instanceof FilmError && e.code === 'json-invalid') throw new CliError('contract.json-invalid', `film.json 不是合法 JSON：${e.message.replace(/^.*?：/, '')}`, e.hint || null);
    throw e;
  }
}
const loadValid = (target, label = 'film.json') => { const L = load(target); return { L, film: assertValidFilm(L, label) }; };

// ───────────────────────── check ─────────────────────────

const check = defineCommand({
  name: 'film.js check',
  summary: '校验 film.json v2（v1 自动升级读取）：镜头表、事件、档位、闸门、署名、AIGC、qa 段、路线专属段',
  usage: [`${PROG} check <作品目录|film.json> [--template] [--strict] [--no-files] [--json]`],
  positionals: [{ name: 'target', label: '<作品目录|film.json>', describe: '作品目录（films/<名>）或它的 film.json' }],
  options: {
    template: { type: 'boolean', describe: '按模版校验：允许 {{NAME}} / {{TITLE}}，仓库资源按复制后的 films/<名>/ 解析' },
    strict: { type: 'boolean', describe: '提示也算失败' },
    'no-files': { type: 'boolean', describe: '不核对引用的文件是否存在' },
  },
  examples: [`${PROG} check films/beiming-10s`, `${PROG} check routes/c-style/template --template --json`],
  exitCodes: { 0: '通过（可以有提示）', 2: '用法错误或找不到 film.json', 4: '不合格（--strict 时提示也算）', 1: '运行失败' },
  run: guard(ctx => {
    const L = load(ctx.args.target, { template: ctx.opts.template, checkFiles: !ctx.opts['no-files'] });
    const errors = L.diagnostics.filter(d => d.level === 'error'), warnings = L.diagnostics.filter(d => d.level === 'warning');
    const ok = !errors.length && !(ctx.opts.strict && warnings.length);
    const lines = [];
    if (L.film) {
      const s = filmSummary(L.film);
      lines.push(`${ok ? '✓' : '✗'} ${shown(L.file)}：${L.upgraded ? 'v1（已自动升级读取）' : 'v2'}，路线 ${s.route} / ${s.backend}，档位 ${s.profile}，${s.size.replace('x', '×')}@${s.fps}，${s.frameCount} 帧（${+s.seconds.toFixed(3)} 秒），${s.shots} 镜，${s.events} 个事件`);
    } else lines.push(`✗ ${shown(L.file)}：不合格`);
    for (const d of [...errors, ...warnings]) lines.push(fmtDiag(d));
    lines.push(`${errors.length} 个错误，${warnings.length} 个提示${ctx.opts.strict && warnings.length ? '（--strict：提示也算失败）' : ''}`);
    ctx.out(lines.join('\n'));
    const data = { file: shown(L.file), upgraded: L.upgraded, summary: L.film ? filmSummary(L.film) : null, diagnostics: L.diagnostics };
    if (ok) return { data, warnings: diagWarnings(L.diagnostics) };
    const e = errors[0];
    return {
      exitCode: 4, data, warnings: diagWarnings(L.diagnostics),
      error: { code: 'contract.film-invalid', message: e ? `${shown(L.file)} 有 ${errors.length} 个错误；第一个：[${e.code}] ${e.path}：${e.message}` : `${shown(L.file)} 有提示（--strict）`, hint: e?.hint || '按诊断修正 film.json' },
    };
  }),
});

// ───────────────────────── validate-result ─────────────────────────

/** run.json 所在的仓库根：往上第一个同时有 package.json 与 engine/ 的目录（被测检出与工具检出可以不同）。 */
function repoRootOf(p) {
  let d = resolve(p);
  for (;;) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'engine'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** 运行目录对应的作品：films/<名>/out/<run-id>/ → films/<名>/；镜像作品的 mirror.outDir（如 out/beiming/<run-id>/）→ 镜像目录。 */
function findFilmOfRun(runDir, root) {
  // 附录 C4 的约定位置：<作品>/out/<run-id>/run.json
  const conventional = dirname(dirname(runDir));
  if (basename(dirname(runDir)) === 'out' && existsSync(join(conventional, 'film.json'))) return conventional;
  if (!root) return null;
  for (let d = dirname(runDir); (d + sep).startsWith(root + sep) && d !== root; d = dirname(d)) {
    if (existsSync(join(d, 'film.json'))) return d;
  }
  const filmsDir = join(root, 'films');
  let names = [];
  try { names = readdirSync(filmsDir); } catch { return null; }
  const rel = toPosix(relative(root, dirname(runDir)));
  for (const name of names) {
    const r = readJsonFile(join(filmsDir, name, 'film.json'));
    if (r.ok && r.value?.mirror?.paths === 'repo' && r.value.mirror.outDir === rel) return join(filmsDir, name);
  }
  return null;
}

const validateResult = defineCommand({
  name: 'film.js validate-result',
  summary: '校验一次运行的 run.json（附录 C8，严格口径）与它的 QA 报告',
  usage: [`${PROG} validate-result <run.json> [--film <作品目录>] [--json]`],
  positionals: [{ name: 'run', label: '<run.json>', describe: '运行目录里的 run.json（films/<名>/out/<run-id>/run.json）' }],
  options: { film: { type: 'string', arg: '<作品目录>', describe: '对照作品的帧数、尺寸、帧率与档位；不给时从运行目录往上找作品' } },
  description: [
    '核对：RenderResult 严格口径（实测设备、编码器、产物 sha256、帧数、尺寸）；technicalAcceptance.evidence 指向的 QA 报告',
    '（相对运行目录或仓库根）能被机器 QA 的 validateReport 解析、ok = true、查的是这次运行的产物；运行目录的 qa/report.json 一并核对；',
    'accepted 至少要一条人工认可（reviewerKind = human、decision = approve、带原话与出处）。',
  ],
  exitCodes: { 0: '通过', 2: '找不到 run.json 或作品', 4: '不合格（含坏 JSON）', 1: '运行失败' },
  run: guard(ctx => {
    const file = resolve(ctx.args.run);
    const r = readJsonFile(file);
    if (!r.ok) {
      if (r.code === 'not-found') throw usage('not-found', `找不到运行记录：${shown(file)}`, '给 films/<名>/out/<run-id>/run.json 的路径');
      if (r.code === 'json-invalid') throw new CliError('contract.json-invalid', `${shown(file)} 不是合法 JSON`, '运行记录由渲染器写；被手改坏了就重新出片');
      throw new CliError('failure.unreadable', `${shown(file)} 读不出来`);
    }
    const runDir = dirname(file), root = repoRootOf(runDir) ?? REPO_ROOT;
    const diags = [];
    let film = null, filmSource = null;
    const filmDir = ctx.opts.film ? resolve(ctx.opts.film) : findFilmOfRun(runDir, root);
    if (filmDir) {
      const L = load(filmDir);
      if (L.ok) { film = L.film; filmSource = { path: shown(L.file), auto: !ctx.opts.film }; }
      else if (ctx.opts.film) assertValidFilm(L, shown(L.file));
      else diags.push({ level: 'warning', code: 'film-invalid', path: shown(L.file), message: '运行目录所属作品的 film.json 不合格：不对照作品的帧数与档位', hint: `${PROG} check ${shown(L.filmDir)}` });
    }
    diags.push(...validateRunRecord(r.value, { film, runDir, repoRoot: root }).diagnostics);
    // QA 报告：技术证据指向的（相对运行目录或仓库根），加上运行目录的 qa/report.json
    const outputs = Array.isArray(r.value?.outputs) ? r.value.outputs : [];
    const shas = new Set([r.value?.output?.sha256, ...outputs.map(x => x?.sha256)].filter(s => typeof s === 'string'));
    const evidence = Array.isArray(r.value?.technicalAcceptance?.evidence) ? r.value.technicalAcceptance.evidence.filter(e => typeof e === 'string' && /\.json$/i.test(e.trim())) : [];
    const reports = new Map();
    for (const ev of evidence) {
      if (isAbsolute(ev)) continue;
      const f = [resolve(runDir, ev), resolve(root, ev)].find(x => existsSync(x));
      if (f) reports.set(f, ev);
    }
    const sibling = join(runDir, 'qa', 'report.json');
    if (existsSync(sibling) && !reports.has(sibling)) reports.set(sibling, 'qa/report.json');
    const qa = [];
    for (const [f, label] of reports) {
      const q = readJsonFile(f);
      if (!q.ok) { diags.push({ level: 'error', code: `qa-${q.code}`, path: label, message: `QA 报告读不出来：${q.code === 'json-invalid' ? '不是合法 JSON' : '读取失败'}`, hint: '重跑 node tools/qa/cli.mjs report <成片>' }); continue; }
      const v = validateQaReport(q.value, { film, runShas: shas.size ? shas : null });
      diags.push(...v.diagnostics.map(d => ({ ...d, path: `${label}:${d.path}` })));
      qa.push({ path: shown(f), ok: q.value?.ok ?? null, valid: v.ok, passed: v.passed, ...qaReportIds(q.value) });
    }
    const errors = diags.filter(d => d.level === 'error');
    ctx.out([`${errors.length ? '✗' : '✓'} ${shown(file)}${film ? `（作品 ${film.id}${filmSource.auto ? '，按运行目录找到' : ''}）` : '（没有对照作品）'}`, ...diags.map(fmtDiag)].join('\n'));
    const data = { file: shown(file), film: filmSource, qaReports: qa, diagnostics: diags };
    if (!errors.length) return { data, warnings: diagWarnings(diags), runJson: shown(file) };
    return { exitCode: 4, data, warnings: diagWarnings(diags), runJson: shown(file), error: { code: 'contract.run-invalid', message: `[${errors[0].code}] ${errors[0].path}：${errors[0].message}`, hint: errors[0].hint || null } };
  }),
});

// ───────────────────────── status / gate ─────────────────────────

function statusText(s) {
  const mark = { approved: '✓', waived: '≈', rejected: '✗', stale: '↺', missing: '·' };
  const lines = [`${s.film ? `${s.film.id}「${s.film.title}」` : shown(s.filmDir)}：${s.state} — ${s.label}`];
  for (const [g, v] of Object.entries(s.gates)) lines.push(`  ${mark[v.status] ?? '?'} ${g.padEnd(9)} ${v.status.padEnd(8)} ${v.reason}${v.record ? `（${v.record.file}）` : ''}${v.comments ? `；代理审片 ${v.comments} 条（不推进状态）` : ''}`);
  if (s.run) lines.push(`  运行 ${s.run.runId}：kind ${s.run.kind ?? '未写'}，status ${s.run.status ?? '未写'}${s.qa ? `；QA ${s.qa.ok === true ? '通过' : `未通过${s.qa.failed.length ? `（${s.qa.failed.join('、')}）` : ''}`}` : '；没有 QA 报告'}`);
  for (const n of s.next) lines.push(`  下一步：${n}`);
  for (const d of s.diagnostics.filter(d => d.level === 'error' || ['render-bypassed-gate', 'gate-order', 'run-kind-missing'].includes(d.code))) lines.push(`  ${fmtDiag(d)}`);
  return lines.join('\n');
}
const statusData = s => ({ ...s, filmDir: shown(s.filmDir) });

const status = defineCommand({
  name: 'film.js status',
  summary: '现算作品状态 draft → look-approved → animatic-approved → rendered → qa-passed → accepted，并给出下一步',
  usage: [`${PROG} status <作品目录> [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' }],
  description: '状态不存档：由 film.json、review/ 的审片记录、out/latest 指向的 run.json 与 qa/report.json 现算。只有 accepted 能对外写「已交付」。',
  exitCodes: { 0: '已算出状态', 2: '找不到作品', 4: 'film.json 不合格', 1: '运行失败' },
  run: guard(ctx => {
    const s = filmStatus(load(ctx.args.target).filmDir);
    ctx.out(statusText(s));
    if (s.state !== 'invalid') return { data: statusData(s), warnings: diagWarnings(s.diagnostics) };
    return { exitCode: 4, data: statusData(s), warnings: diagWarnings(s.diagnostics), error: { code: 'contract.film-invalid', message: 'film.json 不合格，算不出状态', hint: s.next[0] ?? null } };
  }),
});

const gate = defineCommand({
  name: 'film.js gate',
  summary: '闸门判定：final = 能否终渲（look 与 animatic 已认可或豁免）；deliver = 能否写「已交付」（accepted）',
  usage: [`${PROG} gate <作品目录> final|deliver [--json]`],
  positionals: [
    { name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' },
    { name: 'stage', label: 'final|deliver', describe: 'final：能否终渲；deliver：能否写「已交付」' },
  ],
  exitCodes: { 0: '放行', 4: '拒绝（附原因与下一步）', 2: '用法错误', 1: '运行失败' },
  run: guard(ctx => {
    const { target, stage } = ctx.args;
    if (!['final', 'deliver'].includes(stage)) {
      const s = suggest(stage, ['final', 'deliver']);
      throw usage('bad-value', `gate 的第二个参数只能是 final 或 deliver，收到「${stage}」`, s ? `是不是想写 ${s}？` : null);
    }
    const dir = load(target).filmDir;
    const s = stage === 'final' ? assertFinalAllowed(dir) : assertDelivered(dir);
    ctx.out(`✓ ${stage === 'final' ? '可以终渲' : '可以写「已交付」'}：${s.state} — ${s.label}`);
    return { data: statusData(s), warnings: diagWarnings(s.diagnostics) };
  }),
});

// ───────────────────────── review ─────────────────────────

function parseShotVerdicts(list) {
  return list.map(x => {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)=(pass|fail|note)(?::(.*))?$/s.exec(x);
    if (!m) throw usage('bad-value', `--shot 写成 <镜头>=pass|fail|note[:说明]，收到「${x}」`, '例：--shot S1=pass --shot S2=note:天空再亮一点');
    return { id: m[1], verdict: m[2], ...(m[3] ? { note: m[3] } : {}) };
  });
}
function parseScores(list) {
  const out = {};
  for (const x of list) {
    const m = /^([a-z]+)=(\d+)$/.exec(x);
    if (!m) throw usage('bad-value', `--score 写成 <维度>=<1–10>，收到「${x}」`, `维度：${Object.keys(RUBRIC_DIMENSIONS).join(' / ')}`);
    if (out[m[1]] !== undefined) throw usage('repeated-option', `--score ${m[1]} 给了两次`, '每个维度只给一个分');
    out[m[1]] = Number(m[2]);
  }
  return out;
}
function readTextFile(p, flag) {
  try { return readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch (e) {
    if (e.code === 'ENOENT') throw usage('not-found', `${flag} 文件不存在：${shown(resolve(p))}`);
    throw new CliError('failure.unreadable', `${flag} 读不出来（${e.code ?? e.message}）：${shown(resolve(p))}`);
  }
}
function readIssuesFile(p) {
  const text = readTextFile(p, '--issues-file');
  let v;
  try { v = JSON.parse(text); } catch { throw new CliError('contract.issues-invalid', '--issues-file 不是合法 JSON', '格式见 docs/creative-review/issue.schema.json'); }
  if (!Array.isArray(v)) throw new CliError('contract.issues-invalid', '--issues-file 的内容要是问题条目数组', '格式见 docs/creative-review/issue.schema.json');
  return v;
}

const review = defineCommand({
  name: 'film.js review',
  summary: '记录一条审片结论到 review/<闸>-<日期>.json（只增不改）；approve / reject / waive 必须带用户原话与出处',
  usage: [`${PROG} review <作品目录> --gate <structure|look|animatic|final> --decision <approve|reject|waive|comment> [选项] [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' }],
  options: {
    gate: { type: 'string', arg: '<闸>', choices: [...RECORD_GATES], describe: '哪道闸（structure 只记录不阻断）' },
    decision: { type: 'string', arg: '<结论>', choices: [...DECISIONS], describe: 'approve / reject / waive 只能由人做；agent 的代理审片写 comment' },
    quote: { type: 'string', arg: '<原话>', describe: '用户原话，逐字照录（含标点）' },
    'quote-file': { type: 'string', arg: '<文件>', describe: '从 UTF-8 文本文件读原话（原话很长或含引号时用）' },
    'source-ref': { type: 'string', arg: '<出处>', describe: '能找回这句话的地方，如「Claude Code 会话 2026-11-10 用户第 14 条消息」' },
    'source-kind': { type: 'string', arg: '<类型>', choices: [...SOURCE_KINDS], describe: '出处类型（默认 session）' },
    'source-at': { type: 'string', arg: '<时间>', describe: '用户说这句话的时间，ISO 8601（默认现在）' },
    file: { type: 'list', arg: '<路径>', describe: '用户看过的文件（风格帧、预演片、成片），可重复；approve 必填，自动记 sha256' },
    reviewer: { type: 'string', arg: '<名字>', describe: '审阅人（默认「用户」）' },
    'reviewer-kind': { type: 'string', arg: '<类型>', choices: [...REVIEWER_KINDS], describe: '默认 human（approve / reject / waive）或 ai（comment）' },
    'recorded-by': { type: 'string', arg: '<名字>', describe: '谁录入（默认 agent）' },
    'recorded-by-kind': { type: 'string', arg: '<类型>', choices: [...REVIEWER_KINDS], describe: '默认 ai' },
    shot: { type: 'list', arg: '<镜头=结论>', describe: '逐镜结论 <镜头>=pass|fail|note[:说明]，可重复' },
    'rejected-on': { type: 'list', arg: '<维度>', split: ',', describe: `reject 时否定的维度（${Object.keys(RUBRIC_DIMENSIONS).join(',')}）` },
    'must-change': { type: 'string', arg: '<文字>', describe: 'reject 时下次必须改什么' },
    summary: { type: 'string', arg: '<文字>', describe: 'comment（代理审片）的结论' },
    notes: { type: 'string', arg: '<文字>', describe: '备注' },
    score: { type: 'list', arg: '<维度=分>', describe: '评分 1–10，可重复（docs/creative-review/RUBRIC.md）' },
    veto: { type: 'list', arg: '<否决项>', describe: `一票否决项，可重复（${Object.keys(VETOES).join(' / ')}）` },
    'evidence-frame': { type: 'list', arg: '<帧>', describe: '支撑评分的证据帧号，可重复' },
    'issues-file': { type: 'string', arg: '<JSON 文件>', describe: '问题条目数组（docs/creative-review/issue.schema.json）' },
    'dry-run': { type: 'boolean', describe: '只打印记录，不写文件' },
  },
  description: 'agent 不能自己批准：没有用户原话与出处的 approve / reject / waive 记录无效；final 不能豁免。规则见 docs/creative-review/README.md。',
  examples: [
    `${PROG} review films/chendu --gate look --decision approve --file films/chendu/stills/look_01.png --quote "就这个方向。" --source-ref "会话 2026-11-10 用户第 14 条消息"`,
    `${PROG} review films/chendu --gate animatic --decision waive --quote "预演不用给我看了，直接出全片。" --source-ref "会话第 20 条"`,
  ],
  exitCodes: { 0: '已记录（--dry-run 时只打印）', 4: '记录不合格（没写文件）', 2: '用法错误', 1: '运行失败' },
  run: guard(ctx => {
    const o = ctx.opts;
    for (const k of ['gate', 'decision']) if (!o[k]) throw usage('missing-option', `review 缺少 --${k}`, review.usage[0]);
    if (o.quote !== null && o['quote-file'] !== null) throw usage('conflict', '--quote 与 --quote-file 只给一个');
    const quote = o['quote-file'] !== null ? readTextFile(o['quote-file'], '--quote-file').trim() : (o.quote ?? undefined);
    const frames = o['evidence-frame'].map(x => { if (!/^\d+$/.test(x)) throw usage('bad-value', `--evidence-frame 要非负整数帧，收到「${x}」`); return Number(x); });
    const L = load(ctx.args.target);
    assertValidFilm(L, 'film.json');
    const reviewed = o.file.map(p => {
      const rel = relative(L.pathBase, resolve(p));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw usage('bad-path', `所看文件要在${L.pathBase === L.filmDir ? '作品目录' : '仓库'}里：${p}`);
      return { path: toPosix(rel) };
    });
    const human = ['approve', 'reject', 'waive'].includes(o.decision);
    const input = {
      gate: o.gate, decision: o.decision, quote,
      source: human || o['source-ref'] ? { kind: o['source-kind'] ?? 'session', ref: o['source-ref'] ?? undefined, at: o['source-at'] ?? isoLocal() } : undefined,
      reviewer: { kind: o['reviewer-kind'] ?? (human ? 'human' : 'ai'), name: o.reviewer ?? (human ? '用户' : 'agent') },
      recordedBy: { kind: o['recorded-by-kind'] ?? 'ai', name: o['recorded-by'] ?? 'agent' },
      reviewed,
      shots: o.shot.length ? parseShotVerdicts(o.shot) : undefined,
      rejectedOn: o['rejected-on'].length ? o['rejected-on'] : undefined,
      mustChange: o['must-change'] ?? undefined, summary: o.summary ?? undefined, notes: o.notes ?? undefined,
      scores: o.score.length ? parseScores(o.score) : undefined,
      vetoes: o.veto.length ? o.veto : undefined,
      evidenceFrames: frames.length ? frames : undefined,
      issues: o['issues-file'] !== null ? readIssuesFile(o['issues-file']) : undefined,
    };
    ctx.onCleanup(cleanupTemps);
    let r;
    try { r = recordReview(L.filmDir, input, { dryRun: o['dry-run'] }); } catch (e) {
      if (e.code === 'review-files') throw usage('bad-path', e.message);
      if (e instanceof FilmError && e.diagnostics?.length) {
        ctx.out(['✗ 记录不合格，没有写文件：', ...e.diagnostics.map(fmtDiag)].join('\n'));
        return { exitCode: 4, data: { diagnostics: e.diagnostics }, warnings: diagWarnings(e.diagnostics), error: { code: `contract.${e.code}`, message: e.message, hint: e.hint || null } };
      }
      throw e;
    }
    if (!r.path) {
      ctx.out(`（--dry-run，没有写文件）\n${formatJson(r.record).trimEnd()}`);
      return { data: { record: r.record, diagnostics: r.diagnostics }, warnings: diagWarnings(r.diagnostics) };
    }
    ctx.out(`✓ 已记录 ${shown(r.path)}\n${statusText(r.status)}`);
    return { outputs: [{ path: shown(r.path), sha256: r.sha256, kind: 'review' }], warnings: diagWarnings(r.diagnostics), data: { record: r.record, file: shown(r.path), status: { state: r.status.state, label: r.status.label } } };
  }),
});

// ───────────────────────── retime / expect / export / upgrade / profiles ─────────────────────────

const retimeCmd = defineCommand({
  name: 'film.js retime',
  summary: '改一个镜头的出点：ripple（后面整体顺延，总长变）或 roll（只挪切点，总长不变）；事件、刻意画面、豁免帧段、海报帧、角色起点跟着镜头走',
  usage: [`${PROG} retime <作品目录> --shot <镜头 id> (--out <帧> | --length <帧数>) [--mode ripple|roll] [--write] [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' }],
  options: {
    shot: { type: 'string', arg: '<镜头 id>', describe: '要改的镜头' },
    out: { type: 'integer', arg: '<帧>', min: 1, describe: '新的出点（整数帧，不含）' },
    length: { type: 'integer', arg: '<帧数>', min: 1, describe: '新的镜头长度（与 --out 二选一）' },
    mode: { type: 'string', arg: '<方式>', choices: ['ripple', 'roll'], default: 'ripple', describe: 'ripple 后面整体顺延；roll 只挪与下一镜之间的切点' },
    write: { type: 'boolean', describe: '原子地写回 film.json（稳定排版）；不加时只预览' },
  },
  exitCodes: { 0: '成功（预览或已写回）', 4: '冲突（事件会落到镜头外等，没写文件）或冻结镜像', 2: '用法错误', 1: '运行失败' },
  run: guard(ctx => {
    const o = ctx.opts;
    if (!o.shot) throw usage('missing-option', 'retime 缺少 --shot <镜头 id>', retimeCmd.usage[0]);
    if ((o.out === null) === (o.length === null)) throw usage('conflict', '--out 与 --length 给且只给一个', '例：--out 132 或 --length 60');
    const { L, film } = loadValid(ctx.args.target);
    if (!film.shots.some(s => s.id === o.shot)) {
      const s = suggest(o.shot, film.shots.map(x => x.id));
      throw usage('unknown-shot', `没有镜头 ${o.shot}`, `可用：${film.shots.map(x => x.id).join('、')}${s ? `；是不是想写 ${s}？` : ''}`);
    }
    if (o.write && L.raw?.mirror?.frozen === true) {
      throw new CliError('contract.mirror-frozen', `${shown(L.file)} 是冻结样片的镜像（mirror.frozen = true），不能改写切点`, '镜像只描述样片现状：样片本身改了切点（src/timeline.js）之后，再同步镜像并跑它的 mirror.check；新作品的切点在新作品里改');
    }
    const before = { frameCount: film.output.frameCount, cuts: cutList(film).map(c => c.frame) };
    const res = retime(L.raw, o.shot, o.out !== null ? { out: o.out } : { length: o.length }, { mode: o.mode, filmDir: L.filmDir });
    const after = { frameCount: res.normalized.output.frameCount, cuts: cutList(res.normalized).map(c => c.frame) };
    const lines = [`${res.mode} ${o.shot}：${res.delta >= 0 ? '+' : ''}${res.delta} 帧；整片 ${before.frameCount} → ${after.frameCount} 帧；切点 [${before.cuts.join(', ')}] → [${after.cuts.join(', ')}]`];
    for (const s of res.moved.shots) lines.push(`  镜头 ${s.id}${s.in ? ` in ${s.in[0]}→${s.in[1]}` : ''}${s.out ? ` out ${s.out[0]}→${s.out[1]}` : ''}`);
    if (res.moved.events.length) lines.push(`  事件跟着走 ${res.moved.events.length} 个：${res.moved.events.slice(0, 8).map(e => `${e.id}${e.frame ? ` ${e.frame[0]}→${e.frame[1]}` : ` end ${e.end[0]}→${e.end[1]}`}`).join('，')}${res.moved.events.length > 8 ? '…' : ''}`);
    if (res.moved.ranges.length) lines.push(`  区间跟着走：${res.moved.ranges.map(x => `${x.label} [${x.from.join(', ')}) → [${x.to.join(', ')})`).join('，')}`);
    const outputs = [];
    if (o.write && res.delta !== 0) {
      ctx.onCleanup(cleanupTemps);
      const w = writeFilmJson(L.file, res.film);
      outputs.push({ path: shown(w.path), sha256: w.sha256, kind: 'film.json' });
      lines.push(`✓ 已写回 ${shown(w.path)}`);
    } else if (res.delta !== 0) lines.push('（预览：加 --write 写回 film.json）');
    ctx.out(lines.join('\n'));
    return { outputs, warnings: diagWarnings(res.diagnostics), data: { delta: res.delta, mode: res.mode, before, after, moved: res.moved, written: outputs.length > 0 } };
  }),
});

const expect = defineCommand({
  name: 'film.js expect',
  summary: '打印这部片 QA 要比的全部期望值（档位叠加作品 qa 段、帧数、切点、事件、刻意画面、豁免、安全区、AIGC 标识、换成帧数的阈值）',
  usage: [`${PROG} expect <作品目录> [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' }],
  exitCodes: { 0: '成功', 2: '找不到作品', 4: 'film.json 不合格', 1: '运行失败' },
  run: guard(ctx => {
    const { L, film } = loadValid(ctx.args.target);
    const e = qaExpectations(film);
    ctx.out(formatJson(e).trimEnd());
    return { data: e, warnings: diagWarnings(L.diagnostics) };
  }),
});

const exportCmd = defineCommand({
  name: 'film.js export',
  summary: '导出旧消费者读的 timeline.json / events.json（engine/audio/cues.py、cuecheck.py 的外形），时间由 film.json 换算',
  usage: [`${PROG} export <作品目录> [--out <目录>] [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）' }],
  options: { out: { type: 'string', arg: '<目录>', describe: '写到哪个已存在的目录（默认 <作品目录>/out/）' } },
  exitCodes: { 0: '成功', 2: '找不到作品或输出目录', 4: 'film.json 不合格', 1: '运行失败' },
  run: guard(ctx => {
    const { L, film } = loadValid(ctx.args.target);
    const dir = resolve(ctx.opts.out ?? join(L.filmDir, 'out'));
    if (!existsSync(dir)) throw usage('not-found', `输出目录不存在：${shown(dir)}`, '先建好目录，或用 --out 指定');
    ctx.onCleanup(cleanupTemps);
    const outputs = [];
    for (const [name, value] of [['timeline.json', legacyTimeline(film)], ['events.json', legacyEvents(film)]]) {
      const w = writeJsonAtomic(join(dir, name), value);
      outputs.push({ path: shown(w.path), sha256: w.sha256, kind: name.replace('.json', '') });
    }
    ctx.out(outputs.map(x => `✓ ${x.path}`).join('\n'));
    return { outputs, warnings: diagWarnings(L.diagnostics), data: { dir: shown(dir) } };
  }),
});

const upgrade = defineCommand({
  name: 'film.js upgrade',
  summary: '迁到现行 film.json v2：v1 记录升级成 v2 草稿；早期 v2 草稿的旧写法（顶层 holds、sync 布尔值、cue）换成现行写法',
  usage: [`${PROG} upgrade <作品目录> [--template] [--keep-v1-fields] [--write] [--json]`],
  positionals: [{ name: 'target', label: '<作品目录>', describe: '作品目录（films/<名>）或模版目录（加 --template）' }],
  options: {
    template: { type: 'boolean', describe: '按模版处理（id 写 {{NAME}}）' },
    'keep-v1-fields': { type: 'boolean', describe: '保留 dur / fps / size 兼容镜像（过渡期给旧版出片脚本读）' },
    write: { type: 'boolean', describe: '写回 film.json（原文在版本库里）；不加时只打印草稿' },
  },
  exitCodes: { 0: '成功（已是现行写法时什么都不做）', 2: '用法错误或找不到作品', 4: '读不出可迁移的记录', 1: '运行失败' },
  run: guard(ctx => {
    const L = load(ctx.args.target, { template: ctx.opts.template });
    let film, notes;
    if (L.raw?.schemaVersion === 2) {
      ({ film, notes } = migrateV2(L.raw));
      if (!notes.length) { ctx.out(`${shown(L.file)} 已经是现行的 v2 写法，不需要迁移`); return { data: { upgraded: false, notes: [] } }; }
    } else if (L.upgraded) {
      const has = rel => existsSync(join(L.filmDir, rel));
      ({ film, notes } = upgradeFilm(L.raw, { dirName: L.filmDir.split(/[\\/]/).pop(), template: ctx.opts.template, has }));
      if (ctx.opts['keep-v1-fields']) Object.assign(film, { dur: L.raw.dur, fps: L.raw.fps, size: L.raw.size });
    } else {
      const e = firstError(L.diagnostics);
      throw new CliError(`contract.${e?.code ?? 'film-invalid'}`, `读不出可迁移的记录：${e?.message ?? ''}`, e?.hint || null);
    }
    const checked = validateFilm(film, { filmDir: L.filmDir, template: ctx.opts.template });
    const todo = checked.diagnostics.filter(d => d.level === 'error');
    const lines = notes.map(n => `· ${n}`);
    if (todo.length) lines.push(`还要人补 ${todo.length} 项（补齐前 check 不会通过）：`, ...todo.map(fmtDiag));
    const outputs = [];
    if (ctx.opts.write) {
      ctx.onCleanup(cleanupTemps);
      const w = writeFilmJson(L.file, film);
      outputs.push({ path: shown(w.path), sha256: w.sha256, kind: 'film.json' });
      lines.push(`✓ 已写回 ${shown(w.path)}${todo.length ? '（不完整：按上面补齐）' : ''}`);
    } else lines.push('', formatJson(film).trimEnd(), '', '（预览：加 --write 写回 film.json）');
    ctx.out(lines.join('\n'));
    const remaining = todo.map(d => ({ code: d.code, message: `${d.path}：${d.message}`, hint: d.hint || null }));
    return { outputs, warnings: [...diagWarnings(checked.diagnostics), ...remaining], data: { upgraded: true, film, notes, remaining: todo } };
  }),
});

const profiles = defineCommand({
  name: 'film.js profiles',
  summary: '列出交付档位（engine/production/profiles.json，决策 D07）',
  usage: [`${PROG} profiles [--json]`],
  exitCodes: { 0: '成功', 1: '档位表读不出或不合格' },
  run: guard(ctx => {
    const P = loadProfiles();
    const rows = Object.entries(P.profiles).map(([id, p]) => `  ${id.padEnd(22)} ${`${p.video.width}×${p.video.height}@${p.video.fps}`.padEnd(15)} ${String(p.audio.loudness.integrated).padStart(3)} ±${p.audio.loudness.tolerance} LUFS  真峰值 ≤ ${p.audio.loudness.truePeak} dBTP  ${p.label}${id === P.default ? '（默认）' : ''}`);
    ctx.out(['交付档位（engine/production/profiles.json）：', ...rows].join('\n'));
    return { data: P };
  }),
});

export const SUBCOMMANDS = Object.freeze({ check, 'validate-result': validateResult, status, gate, review, retime: retimeCmd, expect, export: exportCmd, upgrade, profiles });

const top = defineCommand({
  name: 'film.js',
  summary: '作品描述 film.json v2、时间轴与创作闸门（engine/production）',
  usage: [`${PROG} <子命令> [参数] [--json]`, `${PROG} <子命令> --help`],
  positionals: [
    { name: 'command', label: '<子命令>', required: false, describe: Object.keys(SUBCOMMANDS).join(' / ') },
    { name: 'rest', label: '[参数…]', required: false, variadic: true, describe: '交给子命令' },
  ],
  description: () => {
    const w = Math.max(...Object.keys(SUBCOMMANDS).map(k => k.length));
    return ['子命令：', ...Object.entries(SUBCOMMANDS).map(([k, c]) => `  ${k.padEnd(w)}  ${c.summary}`), '', '说明：engine/production/README.md；闸门与审片：docs/creative-review/README.md'];
  },
  exitCodes: { 0: '成功', 1: '运行失败', 2: '用法错误', 4: '契约 / 闸门不通过', 130: 'SIGINT', 143: 'SIGTERM' },
  run: ctx => {
    const name = ctx.args.command;
    const list = Object.keys(SUBCOMMANDS).join(' / ');
    if (!name) throw usage('missing-subcommand', '缺少子命令', `用法：${PROG} <子命令> [参数]；子命令：${list}`);
    const s = suggest(name, Object.keys(SUBCOMMANDS));
    throw usage('unknown-subcommand', `没有子命令 ${name}`, `${s ? `是不是想写 ${s}？` : ''}可用：${list}（${PROG} --help）`);
  },
});

/** 入口：第一个不是选项的参数是子命令（help 等于 --help）；其余参数原样交给子命令。返回退出码。 */
export async function main(argv) {
  const i = argv.findIndex(a => a === '--' || !a.startsWith('-'));
  const name = i >= 0 && argv[i] !== '--' ? argv[i] : null;
  if (name === 'help') return runCli(top, ['--help']);
  if (name && Object.hasOwn(SUBCOMMANDS, name)) return runCli(SUBCOMMANDS[name], [...argv.slice(0, i), ...argv.slice(i + 1)]);
  return runCli(top, argv);
}
