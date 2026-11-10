// 北冥仓库 · 命令约定库：docs/CLI.md 的实现，给 tools/ 与 engine/ 下所有新命令用。
//
// 一个命令 = 一份声明（名字、参数、选项、示例、退出码）+ 一个 run(ctx)。库负责：
//   - 严格解析：未知选项、缺值、非法数值、多余或缺少的位置参数一律退出 2，并给出「是不是想写 --xxx」的建议；
//     位置参数可以出现在任意位置；`--` 之后全部当位置参数；支持 --name value 与 --name=value。
//   - -h / --help：帮助打印到 stdout，退出 0，不执行 run（无副作用）；--version 同理。
//   - --json：stdout 只输出一个 JSON 对象（信封，字段见 envelope()），成功、失败、用法错误都输出；
//     供人阅读的日志一律走 stderr；--quiet 只关掉进度日志，警告与错误照常打印。
//   - 退出码（docs/CLI.md 第 1 节，附录 C1）：EXIT 常量；错误类 CliError {code, message, hint}，
//     code 的前缀决定退出码（usage.* → 2、env.* → 3、contract.* → 4、busy.* → 5、timeout.* → 124）。
//   - SIGINT / SIGTERM：依次执行 ctx.onCleanup 登记的清理，再以 130 / 143 退出（--json 时照样输出信封）。
//
// 用法：
//   import { defineCommand, runCli, CliError, EXIT } from './lib/cli.mjs';
//   const cmd = defineCommand({ name: 'new-film', summary: '…', usage: ['node tools/new-film.mjs <路线> <名字> [选项]'],
//     positionals: [{ name: 'route', label: '<路线>', describe: '…', required: true }],
//     options: { title: { type: 'string', arg: '<标题>', describe: '…' }, 'dry-run': { type: 'boolean', describe: '…' } },
//     run: async ctx => ({ data: {…}, outputs: [{ path, sha256, kind }] }) });
//   if (isMain(import.meta.url)) runCli(cmd);
// run(ctx) 返回 { exitCode?, error?, data?, outputs?, warnings?, runJson? }，或抛 CliError；exitCode 缺省为 0。
// 选项类型：boolean、string、integer、number、list（可重复，也可用 split 指定分隔符一次给多个）；string 可带 choices。
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 退出码（附录 C1）。改动前先改 docs/CLI.md 并通知所有命令的属主。 */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,       // 运行失败：页面异常、着色器错误、编码失败、读写失败、内部错误
  USAGE: 2,         // 用法错误：未知选项、缺参数、非法数值、目标已存在
  ENVIRONMENT: 3,   // 环境或依赖缺失、不合格：缺运行时、缺 Python 包、要求 GPU 却落到软件渲染
  CONTRACT: 4,      // 契约、验收或闸门不通过：页面契约、规格不符、QA 硬门、规范检查、拒绝终渲
  BUSY: 5,          // 资源忙：输出锁、渲染槽位、共享 GPU
  TIMEOUT: 124,
  SIGINT: 130,
  SIGTERM: 143,
});

export const EXIT_MEANING = Object.freeze({
  0: '成功', 1: '运行失败', 2: '用法错误', 3: '环境或依赖缺失', 4: '契约、验收或闸门不通过',
  5: '资源忙', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
});

const CODE_PREFIX_EXIT = [
  ['usage.', EXIT.USAGE], ['env.', EXIT.ENVIRONMENT], ['contract.', EXIT.CONTRACT],
  ['busy.', EXIT.BUSY], ['timeout', EXIT.TIMEOUT], ['signal.sigint', EXIT.SIGINT], ['signal.sigterm', EXIT.SIGTERM],
];

/** 由错误码前缀推出退出码；没有已知前缀时是 1（运行失败）。 */
export function exitCodeFor(code) {
  for (const [prefix, exit] of CODE_PREFIX_EXIT) if (String(code).startsWith(prefix)) return exit;
  return EXIT.FAILURE;
}

/**
 * 命令的预期错误：一定带「原因」和「下一步怎么做」。
 *   code    点分的机器码，前缀决定退出码，例如 usage.unknown-option、contract.template、failure.io
 *   message 一句话说清出了什么问题（中文）
 *   hint    下一步怎么做（命令、文件或文档位置）；确实没有时写 null
 * 第三个参数可以直接写 hint 字符串，也可以写 { hint, exitCode, data, cause }。
 */
export class CliError extends Error {
  constructor(code, message, opts = {}) {
    const { hint = null, exitCode, data, cause } = typeof opts === 'string' || opts === null ? { hint: opts } : opts;
    super(message, cause ? { cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode ?? exitCodeFor(code);
    if (data !== undefined) this.data = data;
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

export const usageError = (code, message, hint) => new CliError(`usage.${code}`, message, { hint });

// ───────────────────────── 声明 ─────────────────────────

const GLOBAL_OPTIONS = {
  json: { type: 'boolean', describe: 'stdout 只输出一个 JSON 对象（信封字段见 docs/CLI.md），日志走 stderr' },
  quiet: { type: 'boolean', describe: '不打印进度日志（警告和错误照常打印到 stderr）' },
  help: { type: 'boolean', short: 'h', describe: '打印本帮助并退出（退出码 0，不执行任何操作）' },
  version: { type: 'boolean', describe: '打印版本并退出' },
};
const OPTION_TYPES = new Set(['boolean', 'string', 'integer', 'number', 'list']);
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 校验并补全命令声明；声明本身写错时直接抛普通 Error（这是程序员错误，不是用户错误）。 */
export function defineCommand(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineCommand 需要一个对象');
  for (const k of ['name', 'summary']) if (typeof spec[k] !== 'string' || !spec[k]) throw new Error(`命令声明缺少 ${k}`);
  if (typeof spec.run !== 'function') throw new Error(`命令 ${spec.name} 缺少 run(ctx)`);
  const options = {};
  for (const [name, o] of Object.entries({ ...(spec.options || {}), ...GLOBAL_OPTIONS })) {
    if (!NAME_RE.test(name)) throw new Error(`选项名 --${name} 不合规：小写 kebab-case`);
    if (!OPTION_TYPES.has(o.type)) throw new Error(`选项 --${name} 的类型 ${o.type} 不认识`);
    options[name] = { ...o, name };
  }
  for (const g of Object.keys(GLOBAL_OPTIONS)) if (spec.options?.[g]) throw new Error(`--${g} 是全局选项，命令不要自己声明`);
  const positionals = (spec.positionals || []).map((p, i) => {
    if (!p.name) throw new Error(`第 ${i + 1} 个位置参数缺少 name`);
    return { required: true, label: `<${p.name}>`, ...p };
  });
  if (positionals.some((p, i) => p.variadic && i !== positionals.length - 1)) throw new Error('只有最后一个位置参数可以是 variadic');
  const shorts = new Map();
  for (const o of Object.values(options)) if (o.short) {
    if (shorts.has(o.short)) throw new Error(`短选项 -${o.short} 重复`);
    shorts.set(o.short, o.name);
  }
  return Object.freeze({ ...spec, options, positionals, shorts });
}

// ───────────────────────── 解析 ─────────────────────────

/** Damerau–Levenshtein 距离（限制在短字符串，给「是不是想写」用）。 */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** 在候选里找最像的一个；差太多返回 null。 */
export function suggest(input, candidates) {
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const dist = editDistance(input, c);
    if (dist < bestD || (dist === bestD && c.length < best.length)) { best = c; bestD = dist; }
  }
  if (best === null) return null;
  if (bestD <= Math.max(2, Math.floor(best.length / 3))) return best;
  if (best.startsWith(input) || input.startsWith(best)) return best;
  return null;
}

/** 在严格解析之前先看有没有 --help / -h / --version / --json（只看 `--` 之前）。 */
function scanGlobals(argv) {
  const found = { help: false, version: false, json: false };
  for (const a of argv) {
    if (a === '--') break;
    if (a === '--help' || a === '-h') found.help = true;
    else if (a === '--version') found.version = true;
    else if (a === '--json' || a === '--json=true' || a === '--json=1') found.json = true;
  }
  return found;
}

function convert(opt, raw, flag) {
  if (opt.type === 'integer' || opt.type === 'number') {
    const ok = opt.type === 'integer' ? /^[+-]?\d+$/.test(raw) : /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw);
    const v = Number(raw);
    if (!ok || !Number.isFinite(v)) {
      throw usageError('bad-value', `${flag} 需要${opt.type === 'integer' ? '整数' : '数字'}，收到「${raw}」`, `例：${flag} ${opt.example ?? (opt.min ?? 1)}`);
    }
    if (opt.min !== undefined && v < opt.min) throw usageError('bad-value', `${flag} 不能小于 ${opt.min}，收到 ${raw}`, null);
    if (opt.max !== undefined && v > opt.max) throw usageError('bad-value', `${flag} 不能大于 ${opt.max}，收到 ${raw}`, null);
    return v;
  }
  if (opt.choices && !opt.choices.includes(raw)) {
    const s = suggest(raw, opt.choices);
    throw usageError('bad-value', `${flag} 只能取 ${opt.choices.join(' / ')}，收到「${raw}」`, s ? `是不是想写 ${flag} ${s}？` : null);
  }
  return raw;
}

/**
 * 按声明严格解析 argv。返回 { opts, args, positionals }；任何用法问题抛 CliError（usage.*，退出码 2）。
 * opts 里每个声明过的选项都有值：boolean 默认 false，list 默认 []，其他默认 opt.default ?? null。
 */
export function parseArgs(cmd, argv) {
  const opts = {};
  for (const o of Object.values(cmd.options)) opts[o.name] = o.type === 'boolean' ? false : o.type === 'list' ? [] : (o.default ?? null);
  const seen = new Set();
  const positionals = [];
  const longNames = Object.keys(cmd.options);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const inline = eq > 0 ? a.slice(eq + 1) : undefined;
      const opt = cmd.options[name];
      if (!opt) {
        const s = suggest(name, longNames);
        throw usageError('unknown-option', `不认识的选项 --${name}`, s ? `是不是想写 --${s}？全部选项见 --help` : '全部选项见 --help');
      }
      const flag = `--${name}`;
      if (opt.type === 'boolean') {
        if (inline === undefined) opts[name] = true;
        else if (['true', '1'].includes(inline)) opts[name] = true;
        else if (['false', '0'].includes(inline)) opts[name] = false;
        else throw usageError('bad-value', `${flag} 是开关，不带值（收到「${inline}」）`, `直接写 ${flag}`);
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2) || next === '--') {
          throw usageError('missing-value', `${flag} 后面要跟${opt.arg ? ` ${opt.arg}` : '一个值'}`, opt.example ? `例：${flag} ${opt.example}` : '见 --help');
        }
        raw = next; i++;
      }
      if (opt.type === 'list') {
        const parts = opt.split ? raw.split(opt.split).map(s => s.trim()).filter(Boolean) : [raw];
        opts[name].push(...parts.map(p => convert(opt, p, flag)));
      } else {
        if (seen.has(name)) throw usageError('repeated-option', `${flag} 给了不止一次`, '只保留一个');
        opts[name] = convert(opt, raw, flag);
      }
      seen.add(name);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const long = cmd.shorts.get(a.slice(1));
      if (long && cmd.options[long].type === 'boolean') { opts[long] = true; continue; }
      throw usageError('unknown-option', `不认识的选项 ${a}`, '短选项只有 -h；其他选项写全名，见 --help');
    }
    positionals.push(a);
  }
  // 位置参数
  const args = {};
  const decl = cmd.positionals;
  const variadic = decl.at(-1)?.variadic;
  if (!variadic && positionals.length > decl.length) {
    const extra = positionals.slice(decl.length);
    throw usageError('extra-argument', `多余的参数：${extra.map(x => `「${x}」`).join(' ')}`, `用法：${(cmd.usage || [])[0] ?? cmd.name}`);
  }
  decl.forEach((p, i) => {
    const v = p.variadic ? positionals.slice(i) : positionals[i];
    const missing = p.variadic ? !v.length : v === undefined;
    if (missing && p.required) throw usageError('missing-argument', `缺少参数 ${p.label}`, `用法：${(cmd.usage || [])[0] ?? cmd.name}`);
    args[p.name] = missing ? (p.variadic ? [] : (p.default ?? null)) : v;
  });
  return { opts, args, positionals };
}

// ───────────────────────── 帮助 ─────────────────────────

function pad(s, n) { const w = [...s].reduce((k, ch) => k + (/[ᄀ-￿]/.test(ch) ? 2 : 1), 0); return s + ' '.repeat(Math.max(1, n - w)); }

/** 生成帮助文字。description / examples 可以是函数（只读，不得有副作用）。 */
export function formatHelp(cmd) {
  const lines = [];
  lines.push(`${cmd.name}：${cmd.summary}`, '');
  const usage = cmd.usage?.length ? cmd.usage : [`${cmd.name} [选项]`];
  usage.forEach((u, i) => lines.push(`${i ? '      ' : '用法：'}${u}`));
  const desc = typeof cmd.description === 'function' ? cmd.description() : cmd.description;
  if (desc) lines.push('', ...[].concat(desc));
  if (cmd.positionals.length) {
    lines.push('', '参数：');
    for (const p of cmd.positionals) lines.push(`  ${pad(p.label, 22)}${p.describe ?? ''}${p.required ? '' : '（可省略）'}`);
  }
  lines.push('', '选项：');
  const own = Object.values(cmd.options).filter(o => !(o.name in GLOBAL_OPTIONS));
  for (const o of [...own, ...Object.values(cmd.options).filter(o => o.name in GLOBAL_OPTIONS)]) {
    const head = `${o.short ? `-${o.short}, ` : ''}--${o.name}${o.type === 'boolean' ? '' : ` ${o.arg ?? '<值>'}`}`;
    const extra = o.choices ? `（${o.choices.join(' / ')}）` : '';
    lines.push(`  ${pad(head, 22)}${o.describe ?? ''}${extra}`);
  }
  const ex = typeof cmd.examples === 'function' ? cmd.examples() : cmd.examples;
  if (ex?.length) { lines.push('', '示例：'); for (const e of ex) lines.push(`  ${e}`); }
  const codes = cmd.exitCodes ?? { 0: EXIT_MEANING[0], 2: EXIT_MEANING[2] };
  lines.push('', `退出码：${Object.entries(codes).map(([k, v]) => `${k} ${v}`).join('；')}。完整约定见 docs/CLI.md。`);
  return lines.join('\n') + '\n';
}

// ───────────────────────── 信封与运行 ─────────────────────────

/** 规范化一条警告：字符串或 {code, message, hint} 都行。 */
export function normalizeWarning(w) {
  if (typeof w === 'string') return { code: 'warning', message: w, hint: null };
  return { code: w.code ?? 'warning', message: String(w.message ?? ''), hint: w.hint ?? null };
}

/**
 * --json 信封（附录 C2，schemaVersion 1）：
 *   { schemaVersion, ok, exitCode, command, error: {code, message, hint} | null,
 *     outputs: [{path, sha256, kind}], runJson: 路径 | null, warnings: [{code, message, hint}], data: 命令自己的结果 | null }
 * path 一律是仓库相对、正斜杠；不写本机绝对路径。
 */
export function envelope({ command, exitCode = 0, error = null, outputs = [], runJson = null, warnings = [], data = null }) {
  return {
    schemaVersion: 1,
    ok: exitCode === 0,
    exitCode,
    command,
    error: error ? { code: error.code ?? 'failure', message: String(error.message ?? error), hint: error.hint ?? null } : null,
    outputs: outputs.map(o => ({ path: o.path, sha256: o.sha256 ?? null, kind: o.kind ?? 'file' })),
    runJson,
    warnings: warnings.map(normalizeWarning),
    data,
  };
}

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** 本文件是不是被 node 直接执行（而不是被 import）。按真实路径比较：经符号链接或 /tmp 这类别名路径调用也认得出。 */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(metaUrl);
    const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
    return real(resolve(process.argv[1])) === real(self);
  } catch { return false; }
}

let pkgVersion;
function repoVersion() {
  if (pkgVersion !== undefined) return pkgVersion;
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { pkgVersion = '0.0.0'; }
  return pkgVersion;
}

function writeSafe(stream, text) {
  try { stream.write(text); } catch (e) { if (e?.code !== 'EPIPE') throw e; }
}

/**
 * 运行一个命令：解析 → run(ctx) → 输出 → 返回退出码（并设 process.exitCode）。
 * io 可注入 { stdout, stderr, env, exit, signals } 以便测试；默认用 process 的。
 */
export async function runCli(cmd, argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const signals = io.signals ?? true;
  const g = scanGlobals(argv);
  const warnings = [];
  const cleanups = [];
  let finished = false;

  const finish = (code, { error = null, data = null, outputs = [], runJson = null, humanError = true } = {}) => {
    finished = true;
    if (error && humanError) {
      writeSafe(stderr, `错误[${error.code}]：${error.message}\n`);
      if (error.hint) writeSafe(stderr, `提示：${error.hint}\n`);
    }
    if (g.json) writeSafe(stdout, JSON.stringify(envelope({ command: cmd.name, exitCode: code, error, outputs, runJson, warnings, data }), null, 2) + '\n');
    if (io.setExitCode !== false) process.exitCode = code;
    return code;
  };

  if (g.help) { writeSafe(stdout, formatHelp(cmd)); if (io.setExitCode !== false) process.exitCode = 0; return 0; }
  if (g.version) { writeSafe(stdout, `${cmd.name} ${cmd.version ?? repoVersion()}\n`); if (io.setExitCode !== false) process.exitCode = 0; return 0; }

  let parsed;
  try { parsed = parseArgs(cmd, argv); } catch (e) {
    if (e instanceof CliError) {
      if (!g.json) writeSafe(stderr, `用法：${(cmd.usage || [cmd.name])[0]}（完整说明：--help）\n`);
      return finish(e.exitCode, { error: e });
    }
    throw e;
  }
  const quiet = parsed.opts.quiet;
  const log = {
    info: msg => { if (!quiet) writeSafe(stderr, `${msg}\n`); },
    warn: (code, message, hint = null) => {
      const w = normalizeWarning(typeof code === 'object' ? code : (message === undefined ? code : { code, message, hint }));
      warnings.push(w);
      writeSafe(stderr, `警告[${w.code}]：${w.message}\n${w.hint ? `提示：${w.hint}\n` : ''}`);
    },
  };
  const ctx = {
    command: cmd.name,
    opts: parsed.opts,
    args: parsed.args,
    json: parsed.opts.json,
    quiet,
    env,
    log,
    warn: log.warn,
    /** 主结果（给人看的）：普通模式写 stdout，--json 模式不写（结果在信封的 data 里）。 */
    out: text => { if (!parsed.opts.json) writeSafe(stdout, text.endsWith('\n') ? text : `${text}\n`); },
    /** 登记异常退出时的清理（信号、抛错）；返回取消登记的函数。清理按登记的倒序执行。 */
    onCleanup: fn => { cleanups.push(fn); return () => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); }; },
  };

  const runCleanups = async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      let timer;
      try {
        await Promise.race([Promise.resolve().then(fn), new Promise(r => { timer = setTimeout(r, 5000); })]);
      } catch (e) { writeSafe(stderr, `清理失败：${e?.message ?? e}\n`); }
      finally { clearTimeout(timer); }
    }
  };

  const handlers = [];
  if (signals) {
    for (const [sig, code] of [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM]]) {
      const h = async () => {
        if (finished) return;
        await runCleanups();
        finish(code, { error: new CliError(`signal.${sig.toLowerCase()}`, `收到 ${sig}，已停止并清理`, { hint: null }) });
        // 管道上的 stdout 在 macOS 是异步写：等信封写完再退出，最多等 1 秒
        const bye = () => process.exit(code);
        setTimeout(bye, 1000);
        try { stdout.write('', bye); } catch { bye(); }
      };
      process.once(sig, h);
      handlers.push([sig, h]);
    }
  }
  try {
    const r = (await cmd.run(ctx)) ?? {};
    for (const w of r.warnings ?? []) warnings.push(normalizeWarning(w));
    const code = r.exitCode ?? (r.error ? exitCodeFor(r.error.code) : 0);
    return finish(code, { error: r.error ?? null, data: r.data ?? null, outputs: r.outputs ?? [], runJson: r.runJson ?? null });
  } catch (e) {
    await runCleanups();
    if (e instanceof CliError) return finish(e.exitCode, { error: e, data: e.data ?? null });
    const err = new CliError('failure.internal', `内部错误：${e?.message ?? e}`, {
      hint: env.BEIMING_DEBUG ? null : '设环境变量 BEIMING_DEBUG=1 重跑可看到堆栈；仍出错请把命令与输出一起报告',
    });
    if (env.BEIMING_DEBUG && e?.stack) writeSafe(stderr, `${e.stack}\n`);
    return finish(EXIT.FAILURE, { error: err });
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  }
}
