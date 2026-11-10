// 北冥引擎 · engine/production/film.js 的命令行实现（由 film.js 在直接运行时加载；库调用方不需要它）。
// 约定（计划附录 C1–C2）：未知参数、缺参数 → 退出码 2；--help 输出到 stdout、退出码 0、不读写任何作品文件；
// --json 时 stdout 只有一个对象 { ok, exitCode, command, error: { code, message, hint } | null, outputs, runJson, warnings, result }；
// 契约 / 闸门不通过 → 4；文件读不出等运行失败 → 1；收到 SIGINT / SIGTERM 时删掉未写完的临时文件，以 130 / 143 退出。
// 面向用户的统一入口是 tools/film（npm run film -- …）；这里是库自己的入口，给检查、调试与 tools/film 调用。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  FilmError, assertValidFilm, filmSummary, loadFilm, loadProfiles, qaExpectations, retime, upgradeFilm, validateFilm, writeFilmJson,
} from './film.js';
import { cleanupTemps, formatJson, readJsonFile, repoRelative, toPosix, writeJsonAtomic } from './io.js';
import { DECISIONS, RECORD_GATES, REVIEWER_KINDS, SOURCE_KINDS, buildReview, isoLocal, validateReview, writeReview } from './review.js';
import { GateError, assertDelivered, assertFinalAllowed, filmStatus, validateQaReport, validateRunRecord } from './state.js';
import { cutList, legacyEvents, legacyTimeline } from './timeline.js';

const PROG = 'node engine/production/film.js';
const COMMON = { json: 'bool', help: 'bool' };
const COMMANDS = {
  check: {
    args: ['作品目录|film.json'], flags: { template: 'bool', strict: 'bool', 'no-files': 'bool' },
    summary: '校验 film.json（v1 自动升级读取）：镜头表、事件、档位、闸门、署名、AIGC、路线专属段',
    help: `${PROG} check <作品目录|film.json> [--template] [--strict] [--no-files] [--json]
  --template   按模版校验：允许 {{NAME}} / {{TITLE}}，仓库资源按复制后的 films/<名>/ 解析
  --strict     提示也算失败
  --no-files   不检查引用的文件是否存在
退出码：0 通过；4 不合格；2 用法错误或找不到 film.json`,
  },
  'validate-result': {
    args: ['run.json'], flags: { film: 'string' },
    summary: '校验一次运行的 run.json（附录 C8），同目录有 qa/report.json 时一并校验',
    help: `${PROG} validate-result <run.json> [--film <作品目录>] [--json]
  --film   对照作品的帧数、尺寸、帧率与档位
退出码：0 通过；4 不合格；2 文件不存在`,
  },
  status: {
    args: ['作品目录'], flags: {},
    summary: '现算作品状态：draft → look-approved → animatic-approved → rendered → qa-passed → accepted',
    help: `${PROG} status <作品目录> [--json]
状态由 film.json、review/ 的审片记录、out/latest 指向的 run.json 与 qa/report.json 现算，不存档。
退出码：0 已算出状态；4 film.json 不合格`,
  },
  gate: {
    args: ['作品目录', 'final|deliver'], flags: {},
    summary: '闸门判定：final = 能否终渲（look 与 animatic 认可或豁免）；deliver = 能否写「已交付」（accepted）',
    help: `${PROG} gate <作品目录> final|deliver [--json]
退出码：0 放行；4 拒绝（附原因与下一步）`,
  },
  review: {
    args: ['作品目录'],
    flags: {
      gate: 'string', decision: 'string', quote: 'string', 'quote-file': 'string', 'source-kind': 'string', 'source-ref': 'string', 'source-at': 'string',
      reviewer: 'string', 'reviewer-kind': 'string', 'recorded-by': 'string', 'recorded-by-kind': 'string', file: 'list', shot: 'list',
      'rejected-on': 'string', 'must-change': 'string', summary: 'string', notes: 'string', 'dry-run': 'bool',
    },
    summary: '记录一条审片结论到 review/<闸>-<日期>.json（只增不改）',
    help: `${PROG} review <作品目录> --gate <structure|look|animatic|final> --decision <approve|reject|waive|comment> [选项] [--json]
  --quote <原话> | --quote-file <UTF-8 文本文件>   用户原话（approve / reject / waive 必填，原样照录）
  --source-ref <出处>        能找回这句话的地方，例如「Claude Code 会话 2026-11-10 用户第 14 条消息」（approve / reject / waive 必填）
  --source-kind <类型>       ${SOURCE_KINDS.join(' / ')}（默认 session）
  --source-at <时间>         用户说这句话的时间，ISO 8601（默认现在）
  --file <路径>              用户看过的文件（风格帧、预演片、成片），可重复；approve 必填，自动记 sha256
  --reviewer <名字>          审阅人（默认「用户」）；--reviewer-kind ${REVIEWER_KINDS.join(' | ')}（默认 human；ai 只能 comment）
  --recorded-by <名字>       谁录入（默认 agent）；--recorded-by-kind ${REVIEWER_KINDS.join(' | ')}（默认 ai）
  --shot <镜头=pass|fail|note[:说明]>   逐镜结论，可重复
  --rejected-on <维度,…>     reject 时否定的维度（style,subject,camera,motion,rhythm,text）；--must-change <下次必须改什么>
  --summary <文字>           comment（代理审片）的结论；--notes <文字> 备注
  --dry-run                  只打印记录，不写文件
agent 不能自己批准：没有用户原话的 approve / reject / waive 记录无效。final 不能豁免。
退出码：0 已记录；4 记录不合格（没写文件）；2 用法错误`,
  },
  retime: {
    args: ['作品目录'], flags: { shot: 'string', out: 'int', length: 'int', mode: 'string', write: 'bool' },
    summary: '改一个镜头的出点：ripple（后面整体顺延，总长变）或 roll（只挪切点，总长不变）',
    help: `${PROG} retime <作品目录> --shot <镜头 id> (--out <帧> | --length <帧数>) [--mode ripple|roll] [--write] [--json]
默认只预览改动；加 --write 原子地写回 film.json（稳定排版）。事件、停顿、海报帧、角色起点跟着镜头走。
退出码：0 成功；4 冲突（事件会落到镜头外等，没写文件）；2 用法错误`,
  },
  expect: {
    args: ['作品目录'], flags: {},
    summary: '打印 QA 的全部期望值（档位规格、帧数、切点、事件、停顿、安全区、AIGC 标识）',
    help: `${PROG} expect <作品目录> [--json]\n退出码：0；4 film.json 不合格`,
  },
  export: {
    args: ['作品目录'], flags: { out: 'string' },
    summary: '导出旧消费者读的 timeline.json / events.json（engine/audio/cues.py、cuecheck.py 的外形）',
    help: `${PROG} export <作品目录> [--out <目录>] [--json]
  --out   写到哪个目录（默认 <作品目录>/out/；给旧的 cuecheck 读时用 --out <作品目录>）
退出码：0；4 film.json 不合格`,
  },
  upgrade: {
    args: ['作品目录'], flags: { template: 'bool', write: 'bool', 'keep-v1-fields': 'bool' },
    summary: 'v1 film.json → v2 草稿（credits、aigc、style 要人补）',
    help: `${PROG} upgrade <作品目录> [--template] [--keep-v1-fields] [--write] [--json]
  --keep-v1-fields   保留 dur / fps / size 兼容镜像（过渡期给旧版 repo-check 读）
  --write            写回 film.json（v1 原文在版本库里）；不加时只打印草稿
退出码：0；2 用法错误；4 读不出 v1 记录`,
  },
  profiles: {
    args: [], flags: {},
    summary: '列出交付档位（engine/production/profiles.json）',
    help: `${PROG} profiles [--json]\n退出码：0`,
  },
};

function generalHelp() {
  const w = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  return `北冥引擎 · 作品描述 film.json v2 与创作闸门

用法：${PROG} <子命令> [参数] [--json]
${Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(w)}  ${c.summary}`).join('\n')}

每个子命令都有 --help。退出码：0 成功 · 1 运行失败 · 2 用法错误 · 4 契约 / 闸门不通过 · 130 / 143 收到中断信号。
说明：engine/production/README.md；闸门与审片：docs/creative-review/README.md`;
}

class UsageError extends Error {
  constructor(message, hint = '') { super(message); this.code = 'usage'; this.hint = hint; this.exitCode = 2; }
}

function parse(argv, spec, name) {
  const types = { ...COMMON, ...spec.flags }, flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq < 0 ? undefined : eq);
      let val = eq < 0 ? undefined : a.slice(eq + 1);
      const type = types[key];
      if (!type) throw new UsageError(`未知参数 --${key}`, `${name} 可用：${Object.keys(types).map(k => `--${k}`).join(' ')}；看 --help`);
      if (type === 'bool') {
        if (val !== undefined) throw new UsageError(`--${key} 不带值`);
        flags[key] = true;
        continue;
      }
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || (val.startsWith('--') && val.length > 2)) throw new UsageError(`--${key} 后面要跟一个值`);
      }
      if (type === 'int') {
        if (!/^\d+$/.test(val)) throw new UsageError(`--${key} 要非负整数（帧），收到 ${JSON.stringify(val)}`);
        val = Number(val);
      }
      if (type === 'list') { (flags[key] ??= []).push(val); continue; }
      if (flags[key] !== undefined) throw new UsageError(`--${key} 只能给一次`);
      flags[key] = val;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) throw new UsageError(`未知参数 ${a}`, '看 --help');
    pos.push(a);
  }
  if (pos.length !== spec.args.length) throw new UsageError(`${name} 要 ${spec.args.length} 个位置参数（${spec.args.map(x => `<${x}>`).join(' ') || '无'}），收到 ${pos.length} 个`, spec.help.split('\n')[0]);
  return { pos, flags };
}

const fmtDiag = d => `${d.level === 'error' ? '✗' : '!'} [${d.code}] ${d.path}：${d.message}${d.hint ? `\n    → ${d.hint}` : ''}`;
const warnStrings = diags => diags.filter(d => d.level === 'warning').map(d => `[${d.code}] ${d.path}：${d.message}`);
const shown = p => repoRelative(resolve(p)) ?? toPosix(p);

// ───────────────────────── 子命令 ─────────────────────────

function cmdCheck({ pos, flags }) {
  const L = loadFilm(pos[0], { template: Boolean(flags.template), checkFiles: !flags['no-files'] });
  const errors = L.diagnostics.filter(d => d.level === 'error'), warnings = L.diagnostics.filter(d => d.level === 'warning');
  const ok = errors.length === 0 && !(flags.strict && warnings.length);
  const lines = [];
  if (L.film) {
    const s = filmSummary(L.film);
    lines.push(`${ok ? '✓' : '✗'} ${shown(L.file)}：${L.upgraded ? 'v1（已自动升级读取）' : 'v2'}，路线 ${s.route} / ${s.backend}，档位 ${s.profile}，${s.size.replace('x', '×')}@${s.fps}，${s.frameCount} 帧（${+s.seconds.toFixed(3)} 秒），${s.shots} 镜，${s.events} 个事件`);
  } else lines.push(`✗ ${shown(L.file)}：不合格`);
  for (const d of [...errors, ...warnings]) lines.push(fmtDiag(d));
  lines.push(`${errors.length} 个错误，${warnings.length} 个提示${flags.strict && warnings.length ? '（--strict：提示也算失败）' : ''}`);
  return { ok, exitCode: ok ? 0 : 4, text: lines.join('\n'), warnings: warnStrings(L.diagnostics), result: { file: shown(L.file), upgraded: L.upgraded, summary: L.film ? filmSummary(L.film) : null, diagnostics: L.diagnostics },
    error: ok ? null : { code: 'contract', message: errors[0] ? `[${errors[0].code}] ${errors[0].path}：${errors[0].message}` : '有提示（--strict）', hint: errors[0]?.hint ?? '' } };
}

function cmdValidateResult({ pos, flags }) {
  const file = resolve(pos[0]);
  const r = readJsonFile(file);
  if (!r.ok) throw new FilmError(r.code, r.message, { exitCode: r.code === 'not-found' ? 2 : r.code === 'json-invalid' ? 4 : 1 });
  let film = null;
  if (flags.film) film = assertValidFilm(loadFilm(flags.film), 'film.json');
  const runDir = dirname(file);
  const v = validateRunRecord(r.value, { film, runDir });
  const diags = [...v.diagnostics];
  const q = readJsonFile(resolve(runDir, 'qa', 'report.json'));
  if (q.ok && film) {
    const shas = new Set([r.value?.output?.sha256, ...(r.value?.outputs ?? []).map(x => x?.sha256)].filter(Boolean));
    diags.push(...validateQaReport(q.value, { film, runShas: shas }).diagnostics.map(d => ({ ...d, path: `qa/report.json:${d.path}` })));
  }
  const errors = diags.filter(d => d.level === 'error');
  const ok = !errors.length;
  return { ok, exitCode: ok ? 0 : 4, text: [`${ok ? '✓' : '✗'} ${shown(file)}`, ...diags.map(fmtDiag)].join('\n'), warnings: warnStrings(diags), result: { file: shown(file), diagnostics: diags },
    error: ok ? null : { code: 'contract', message: `[${errors[0].code}] ${errors[0].path}：${errors[0].message}`, hint: errors[0].hint } };
}

function statusText(s) {
  const mark = { approved: '✓', waived: '≈', rejected: '✗', stale: '↺', missing: '·' };
  const lines = [`${s.film ? `${s.film.id}「${s.film.title}」` : shown(s.filmDir)}：${s.state} — ${s.label}`];
  for (const [g, v] of Object.entries(s.gates)) lines.push(`  ${mark[v.status] ?? '?'} ${g.padEnd(9)} ${v.status.padEnd(8)} ${v.reason}${v.record ? `（${v.record.file}）` : ''}`);
  if (s.run) lines.push(`  运行 ${s.run.runId}：kind ${s.run.kind ?? '未写'}，status ${s.run.status ?? '未写'}${s.qa ? `；QA ${s.qa.ok === true ? '通过' : `未通过${s.qa.failed.length ? `（${s.qa.failed.join('、')}）` : ''}`}` : '；没有 QA 报告'}`);
  for (const n of s.next) lines.push(`  下一步：${n}`);
  for (const d of s.diagnostics.filter(d => d.level === 'error' || ['render-bypassed-gate', 'gate-order', 'run-kind-missing'].includes(d.code))) lines.push(`  ${fmtDiag(d)}`);
  return lines.join('\n');
}

function cmdStatus({ pos }) {
  const s = filmStatus(pos[0]);
  const ok = s.state !== 'invalid';
  return { ok, exitCode: ok ? 0 : 4, text: statusText(s), warnings: warnStrings(s.diagnostics), result: s,
    error: ok ? null : { code: 'contract', message: 'film.json 不合格', hint: s.next[0] } };
}

function cmdGate({ pos }) {
  const [target, stage] = pos;
  if (!['final', 'deliver'].includes(stage)) throw new UsageError(`gate 的第二个参数只能是 final 或 deliver，收到 ${JSON.stringify(stage)}`);
  const s = stage === 'final' ? assertFinalAllowed(target) : assertDelivered(target);
  return { ok: true, exitCode: 0, text: `✓ ${stage === 'final' ? '可以终渲' : '可以写「已交付」'}：${s.state} — ${s.label}`, warnings: warnStrings(s.diagnostics), result: s };
}

function parseShotVerdicts(list = []) {
  return list.map(x => {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)=(pass|fail|note)(?::(.*))?$/s.exec(x);
    if (!m) throw new UsageError(`--shot 写成 <镜头>=pass|fail|note[:说明]，收到 ${JSON.stringify(x)}`);
    return { id: m[1], verdict: m[2], ...(m[3] ? { note: m[3] } : {}) };
  });
}

function cmdReview({ pos, flags }) {
  for (const k of ['gate', 'decision']) if (!flags[k]) throw new UsageError(`review 缺少 --${k}`, COMMANDS.review.help.split('\n')[0]);
  if (!RECORD_GATES.includes(flags.gate)) throw new UsageError(`--gate 只能是 ${RECORD_GATES.join(' / ')}`);
  if (!DECISIONS.includes(flags.decision)) throw new UsageError(`--decision 只能是 ${DECISIONS.join(' / ')}`);
  if (flags.quote !== undefined && flags['quote-file'] !== undefined) throw new UsageError('--quote 与 --quote-file 只给一个');
  if (flags['source-kind'] && !SOURCE_KINDS.includes(flags['source-kind'])) throw new UsageError(`--source-kind 只能是 ${SOURCE_KINDS.join(' / ')}`);
  for (const k of ['reviewer-kind', 'recorded-by-kind']) if (flags[k] && !REVIEWER_KINDS.includes(flags[k])) throw new UsageError(`--${k} 只能是 ${REVIEWER_KINDS.join(' / ')}`);
  const quote = flags['quote-file'] !== undefined ? readQuoteFile(flags['quote-file']) : flags.quote;
  const L = loadFilm(pos[0]);
  const film = assertValidFilm(L, 'film.json');
  const reviewed = (flags.file ?? []).map(p => {
    const abs = resolve(p);
    const rel = relative(L.pathBase, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`所看文件要在${L.pathBase === L.filmDir ? '作品目录' : '仓库'}里：${p}`);
    return { path: toPosix(rel) };
  });
  const human = ['approve', 'reject', 'waive'].includes(flags.decision);
  const input = {
    film, pathBase: L.pathBase, gate: flags.gate, decision: flags.decision, quote,
    source: human || flags['source-ref'] ? { kind: flags['source-kind'] ?? 'session', ref: flags['source-ref'], at: flags['source-at'] ?? isoLocal() } : undefined,
    reviewer: { kind: flags['reviewer-kind'] ?? (human ? 'human' : 'ai'), name: flags.reviewer ?? (human ? '用户' : 'agent') },
    recordedBy: { kind: flags['recorded-by-kind'] ?? 'ai', name: flags['recorded-by'] ?? 'agent' },
    reviewed,
    shots: flags.shot ? parseShotVerdicts(flags.shot) : undefined,
    rejectedOn: flags['rejected-on'] ? flags['rejected-on'].split(',').map(s => s.trim()).filter(Boolean) : undefined,
    mustChange: flags['must-change'], summary: flags.summary, notes: flags.notes,
  };
  let record;
  try { record = buildReview(input); } catch (error) {
    if (error.code === 'review-files') throw new UsageError(error.message);
    throw error;
  }
  const v = validateReview(record, { film });
  const errors = v.diagnostics.filter(d => d.level === 'error');
  if (errors.length) {
    return { ok: false, exitCode: 4, text: ['✗ 记录不合格，没有写文件：', ...v.diagnostics.map(fmtDiag)].join('\n'), warnings: warnStrings(v.diagnostics), result: { record, diagnostics: v.diagnostics },
      error: { code: errors[0].code, message: errors[0].message, hint: errors[0].hint } };
  }
  if (flags['dry-run']) return { ok: true, exitCode: 0, text: `（--dry-run，没有写文件）\n${formatJson(record).trimEnd()}`, warnings: warnStrings(v.diagnostics), result: { record, diagnostics: v.diagnostics } };
  const w = writeReview(L.filmDir, record);
  const s = filmStatus(L.filmDir);
  return { ok: true, exitCode: 0, text: `✓ 已记录 ${shown(w.path)}\n${statusText(s)}`, outputs: [{ path: shown(w.path), sha256: w.sha256, kind: 'review' }], warnings: warnStrings(v.diagnostics), result: { record, file: shown(w.path), status: { state: s.state, label: s.label } } };
}

function readQuoteFile(p) {
  let text;
  try { text = readFileSync(p, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') throw new UsageError(`--quote-file 文件不存在：${p}`);
    throw new FilmError('unreadable', `--quote-file 读不出来（${error.code ?? error.message}）：${p}`, { exitCode: 1 });
  }
  return text.replace(/^\uFEFF/, '').trim();
}

function cmdRetime({ pos, flags }) {
  if (!flags.shot) throw new UsageError('retime 缺少 --shot <镜头 id>');
  if ((flags.out === undefined) === (flags.length === undefined)) throw new UsageError('--out 与 --length 给且只给一个');
  if (flags.mode && !['ripple', 'roll'].includes(flags.mode)) throw new UsageError('--mode 只能是 ripple 或 roll');
  const L = loadFilm(pos[0]);
  assertValidFilm(L, 'film.json');
  if (flags.write && L.raw?.mirror?.frozen === true) {
    throw new FilmError('mirror-frozen', `${shown(L.file)} 是冻结样片的镜像（mirror.frozen = true），不能改写切点`, { exitCode: 4, hint: '镜像只描述样片现状：样片本身改了切点（src/timeline.js）之后，再同步镜像并跑它的 mirror.check；新作品的切点在新作品里改' });
  }
  const before = { frameCount: L.film.output.frameCount, cuts: cutList(L.film).map(c => c.frame) };
  const res = retime(L.raw, flags.shot, flags.out !== undefined ? { out: flags.out } : { length: flags.length }, { mode: flags.mode ?? 'ripple', filmDir: L.filmDir });
  const after = { frameCount: res.normalized.output.frameCount, cuts: cutList(res.normalized).map(c => c.frame) };
  const lines = [`${res.mode} ${flags.shot}：${res.delta >= 0 ? '+' : ''}${res.delta} 帧；整片 ${before.frameCount} → ${after.frameCount} 帧；切点 [${before.cuts.join(', ')}] → [${after.cuts.join(', ')}]`];
  for (const s of res.moved.shots) lines.push(`  镜头 ${s.id}${s.in ? ` in ${s.in[0]}→${s.in[1]}` : ''}${s.out ? ` out ${s.out[0]}→${s.out[1]}` : ''}`);
  if (res.moved.events.length) lines.push(`  事件跟着走 ${res.moved.events.length} 个：${res.moved.events.slice(0, 8).map(e => `${e.id}${e.frame ? ` ${e.frame[0]}→${e.frame[1]}` : ` end ${e.end[0]}→${e.end[1]}`}`).join('，')}${res.moved.events.length > 8 ? '…' : ''}`);
  const outputs = [];
  if (flags.write && res.delta !== 0) {
    const w = writeFilmJson(L.file, res.film);
    outputs.push({ path: shown(w.path), sha256: w.sha256, kind: 'film.json' });
    lines.push(`✓ 已写回 ${shown(w.path)}`);
  } else if (res.delta !== 0) lines.push('（预览：加 --write 写回 film.json）');
  return { ok: true, exitCode: 0, text: lines.join('\n'), outputs, warnings: warnStrings(res.diagnostics), result: { delta: res.delta, mode: res.mode, before, after, moved: res.moved, written: outputs.length > 0 } };
}

function cmdExpect({ pos }) {
  const L = loadFilm(pos[0]);
  const film = assertValidFilm(L, 'film.json');
  const e = qaExpectations(film);
  return { ok: true, exitCode: 0, text: formatJson(e).trimEnd(), warnings: warnStrings(L.diagnostics), result: e };
}

function cmdExport({ pos, flags }) {
  const L = loadFilm(pos[0]);
  const film = assertValidFilm(L, 'film.json');
  const dir = resolve(flags.out ?? resolve(L.filmDir, 'out'));
  if (!existsSync(dir)) throw new UsageError(`--out 目录不存在：${flags.out ?? 'out/'}（先建好目录）`);
  const outputs = [];
  for (const [name, value] of [['timeline.json', legacyTimeline(film)], ['events.json', legacyEvents(film)]]) {
    const w = writeJsonAtomic(resolve(dir, name), value);
    outputs.push({ path: shown(w.path), sha256: w.sha256, kind: name.replace('.json', '') });
  }
  return { ok: true, exitCode: 0, text: outputs.map(o => `✓ ${o.path}`).join('\n'), outputs, warnings: warnStrings(L.diagnostics), result: { dir: shown(dir) } };
}

function cmdUpgrade({ pos, flags }) {
  const L = loadFilm(pos[0], { template: Boolean(flags.template) });
  if (L.raw?.schemaVersion === 2) return { ok: true, exitCode: 0, text: `${shown(L.file)} 已经是 v2，不需要升级`, warnings: [], result: { upgraded: false } };
  if (!L.upgraded) {
    const e = L.diagnostics.find(d => d.level === 'error');
    throw new FilmError(e?.code ?? 'contract', `读不出 v1 记录：${e?.message ?? ''}`, { exitCode: 4, hint: e?.hint });
  }
  const has = rel => existsSync(resolve(L.filmDir, rel));
  const { film, notes } = upgradeFilm(L.raw, { dirName: L.filmDir.split(/[\\/]/).pop(), template: Boolean(flags.template), has });
  if (flags['keep-v1-fields']) Object.assign(film, { dur: L.raw.dur, fps: L.raw.fps, size: L.raw.size });
  const check = validateFilm(film, { filmDir: L.filmDir, template: Boolean(flags.template) });
  const todo = check.diagnostics.filter(d => d.level === 'error');
  const lines = [...notes.map(n => `· ${n}`)];
  if (todo.length) lines.push(`还要人补 ${todo.length} 项（写进 film.json 前不会通过 check）：`, ...todo.map(fmtDiag));
  const outputs = [];
  if (flags.write) {
    const w = writeFilmJson(L.file, film);
    outputs.push({ path: shown(w.path), sha256: w.sha256, kind: 'film.json' });
    lines.push(`✓ 已写回 ${shown(w.path)}${todo.length ? '（不完整：按上面补齐）' : ''}`);
  } else lines.push('', formatJson(film).trimEnd(), '', '（预览：加 --write 写回 film.json）');
  return { ok: true, exitCode: 0, text: lines.join('\n'), outputs, warnings: [...warnStrings(check.diagnostics), ...todo.map(d => `[${d.code}] ${d.path}：${d.message}`)], result: { film, notes, remaining: todo } };
}

function cmdProfiles() {
  const P = loadProfiles();
  const rows = Object.entries(P.profiles).map(([id, p]) => `  ${id.padEnd(22)} ${`${p.video.width}×${p.video.height}@${p.video.fps}`.padEnd(15)} ${String(p.audio.loudness.integratedLUFS).padStart(3)} ±${p.audio.loudness.toleranceLU} LUFS  真峰值 ≤ ${p.audio.truePeakMaxDbTP} dBTP  ${p.label}${id === P.default ? '（默认）' : ''}`);
  return { ok: true, exitCode: 0, text: ['交付档位（engine/production/profiles.json）：', ...rows].join('\n'), warnings: [], result: P };
}

const HANDLERS = { check: cmdCheck, 'validate-result': cmdValidateResult, status: cmdStatus, gate: cmdGate, review: cmdReview, retime: cmdRetime, expect: cmdExpect, export: cmdExport, upgrade: cmdUpgrade, profiles: cmdProfiles };

// ───────────────────────── 入口 ─────────────────────────

export async function main(argv) {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { cleanupTemps(); process.exit(code); });
  const json = argv.includes('--json');
  const emit = r => {
    if (json) {
      const env = { ok: r.ok, exitCode: r.exitCode, command: r.command, error: r.error ?? null, outputs: r.outputs ?? [], runJson: null, warnings: r.warnings ?? [], result: r.result ?? null };
      process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
    } else if (r.text) process.stdout.write(`${r.text}\n`);
    return r.exitCode;
  };
  const [name, ...rest] = argv;
  if (!name || name === '--json') {
    if (json) return emit({ ok: false, exitCode: 2, command: 'film.js', error: { code: 'usage', message: '缺少子命令', hint: `${PROG} --help` }, text: '' });
    process.stderr.write(`${generalHelp()}\n`);
    return 2;
  }
  if (name === '--help' || name === '-h' || name === 'help') { process.stdout.write(`${generalHelp()}\n`); return 0; }
  const spec = COMMANDS[name];
  const command = `film.js ${name}`;
  if (!spec) {
    const msg = `未知子命令 ${name}`, hint = `可用：${Object.keys(COMMANDS).join(' / ')}；${PROG} --help`;
    if (json) return emit({ ok: false, exitCode: 2, command: 'film.js', error: { code: 'usage', message: msg, hint } });
    process.stderr.write(`${msg}\n${hint}\n`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) { process.stdout.write(`${spec.help}\n`); return 0; }
  try {
    const parsed = parse(rest, spec, name);
    const r = HANDLERS[name](parsed);
    return emit({ ...r, command });
  } catch (error) {
    const known = error instanceof UsageError || error instanceof FilmError || error instanceof GateError;
    const exitCode = known ? error.exitCode : 1;
    const payload = { ok: false, exitCode, command, error: { code: known ? error.code : 'internal', message: error.message, hint: error.hint ?? '' }, warnings: [], result: error.status ? { status: error.status } : (error.diagnostics?.length ? { diagnostics: error.diagnostics } : null) };
    if (json) return emit(payload);
    process.stderr.write(`${known ? '' : '内部错误：'}${error.message}${error.hint ? `\n→ ${error.hint}` : ''}\n`);
    if (!known) process.stderr.write(`${error.stack}\n`);
    if (error.diagnostics?.length) process.stderr.write(`${error.diagnostics.filter(d => d.level === 'error').map(fmtDiag).join('\n')}\n`);
    return exitCode;
  }
}

