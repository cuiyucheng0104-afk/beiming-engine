// 评测工具的命令约定（计划书附录 C1 退出码、C2 --json 信封）。
//
// 做什么：
//   - 严格解析参数：未知参数、缺值、多余的位置参数一律 exit 2，并说明怎么改；
//   - --help / -h 只把用法写到 stdout，exit 0，不产生任何副作用（解析在任何读写之前完成）；
//   - --json 时 stdout 只输出一个 JSON 对象（信封），供人读的日志一律走 stderr；
//   - 统一捕获 EvalError（带退出码、错误码、下一步提示）；未知异常按 exit 1 报告，
//     设 BEIMING_DEBUG=1 时附堆栈；
//   - 收到 SIGINT / SIGTERM 时先执行登记的清理函数，再以 130 / 143 退出。
// 接口：
//   EXIT、EvalError、usageError(msg, hint, code)、envError(code, msg, hint)、contractError(code, msg, hint)
//   parseArgs(argv, spec) → { opts, positionals, help }
//   runCli({ command, spec | subcommands, handler }) —— handler(parsed, ctx) 返回 { exitCode?, data?, text?, error? }
// 用法错误的码与 tools/lib/cli.mjs 同名（docs/CLI.md 第 4 节）：usage.unknown-option（「不认识的选项 --xxx」）、
// usage.missing-value、usage.bad-value、usage.missing-argument、usage.extra-argument；信封带 schemaVersion 1。
// P02 的命令约定库（tools/lib）合入后，本文件改为对它的薄封装，对外行为不变。
// 还没对齐的：各命令自己的错误码（run-missing、env-missing 等）仍是扁平写法，C2 要求按退出码加 usage. / env. 前缀，改造时一并换。

export const EXIT = Object.freeze({
  OK: 0, RUN: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143,
});

export class EvalError extends Error {
  /**
   * @param {string} code 机器可读的错误码（短横线小写）
   * @param {string} message 原因（中文，一句话）
   * @param {{ exitCode?: number, hint?: string|null, details?: unknown }} [extra]
   */
  constructor(code, message, { exitCode = EXIT.RUN, hint = null, details } = {}) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

export const usageError = (message, hint = '加 --help 查看用法', code = 'usage.bad-value') => new EvalError(code, message, { exitCode: EXIT.USAGE, hint });
export const envError = (code, message, hint = null) => new EvalError(code, message, { exitCode: EXIT.ENV, hint });
export const contractError = (code, message, hint = null) => new EvalError(code, message, { exitCode: EXIT.CONTRACT, hint });

/**
 * 解析参数。spec：
 *   { options: { name: { type: 'boolean'|'string'|'number'|'list', short?, desc?, default? } },
 *     positionals: { min = 0, max = 0, names?: string[] } }
 * list 类型可重复出现，也可写成逗号分隔。
 */
export function parseArgs(argv, spec = {}) {
  const options = { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, ...(spec.options ?? {}) };
  const shorts = new Map();
  for (const [name, def] of Object.entries(options)) if (def.short) shorts.set(def.short, name);
  const opts = {};
  for (const [name, def] of Object.entries(options)) {
    if (def.default !== undefined) opts[name] = Array.isArray(def.default) ? [...def.default] : def.default;
    else if (def.type === 'boolean') opts[name] = false;
    else if (def.type === 'list') opts[name] = [];
  }
  const positionals = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest) { positionals.push(arg); continue; }
    if (arg === '--') { rest = true; continue; }
    let name = null;
    let inline = null;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) inline = arg.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(arg)) {
      name = shorts.get(arg.slice(1)) ?? null;
      if (!name) throw usageError(`不认识的选项 ${arg}`, `加 --help 查看 ${spec.command ?? ''} 支持的参数`.replace(/\s+/g, ' '), 'usage.unknown-option');
    } else {
      positionals.push(arg);
      continue;
    }
    const def = options[name];
    if (!def) throw usageError(`不认识的选项 --${name}`, `加 --help 查看 ${spec.command ?? ''} 支持的参数`.replace(/\s+/g, ' '), 'usage.unknown-option');
    if (def.type === 'boolean') {
      if (inline !== null) throw usageError(`--${name} 是开关，不带值`, `直接写 --${name}`);
      opts[name] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      value = argv[i + 1];
      if (value === undefined || (value.startsWith('--') && value.length > 2)) throw usageError(`--${name} 后面要跟一个值`, '加 --help 查看用法', 'usage.missing-value');
      i++;
    }
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw usageError(`--${name} 要求数字，收到「${value}」`);
      if (def.min !== undefined && n < def.min) throw usageError(`--${name} 不能小于 ${def.min}`);
      opts[name] = n;
    } else if (def.type === 'list') {
      for (const part of value.split(',').map(s => s.trim()).filter(Boolean)) opts[name].push(part);
    } else {
      if (def.choices && !def.choices.includes(value)) throw usageError(`--${name} 只能是 ${def.choices.join(' / ')}，收到「${value}」`);
      opts[name] = value;
    }
  }
  const help = Boolean(opts.help);
  if (!help) {
    const min = spec.positionals?.min ?? 0;
    const max = spec.positionals?.max ?? 0;
    if (positionals.length < min) throw usageError(`缺少参数：需要 ${(spec.positionals?.names ?? []).slice(positionals.length, min).join('、') || `${min} 个位置参数`}`, '加 --help 查看用法', 'usage.missing-argument');
    if (max !== Infinity && positionals.length > max) throw usageError(`多余的参数：${positionals.slice(max).join(' ')}`, '加 --help 查看用法', 'usage.extra-argument');
  }
  return { opts, positionals, help };
}

/** 生成一段用法说明（由 spec 推出，避免手写的帮助与实际参数不一致）。 */
export function formatHelp(command, spec) {
  const lines = [];
  if (spec.summary) lines.push(spec.summary, '');
  lines.push(`用法：${spec.usage ?? `node ${command}`}`);
  const options = Object.entries(spec.options ?? {});
  if (options.length) {
    lines.push('', '参数：');
    for (const [name, def] of options) {
      const flag = `--${name}${def.type === 'boolean' ? '' : ` <${def.placeholder ?? (def.type === 'list' ? '值,…' : '值')}>`}`;
      lines.push(`  ${flag.padEnd(28)} ${def.desc ?? ''}${def.default !== undefined && def.type !== 'boolean' ? `（默认 ${Array.isArray(def.default) ? def.default.join(',') : def.default}）` : ''}`);
    }
  }
  lines.push(`  ${'--json'.padEnd(28)} stdout 只输出一个 JSON 信封；日志走 stderr`);
  lines.push(`  ${'--help, -h'.padEnd(28)} 只打印本说明，不做任何事`);
  if (spec.notes) lines.push('', ...[].concat(spec.notes));
  lines.push('', '退出码：0 成功；1 运行失败；2 用法错误；3 环境或依赖缺失；4 判定不通过；5 资源忙；124 超时；130/143 被中断（已清理）');
  return lines.join('\n') + '\n';
}

function envelope({ ok, exitCode, command, error = null, outputs = [], runJson = null, warnings = [], data = null }) {
  return { schemaVersion: 1, ok, exitCode, command, error, outputs, runJson, warnings, data };
}

/**
 * 统一入口。
 *   单命令：runCli({ command, spec, handler })
 *   子命令：runCli({ command, subcommands: { name: { spec, handler } }, summary })
 * handler(parsed, ctx) → { exitCode?, data?, text?, error?: {code,message,hint}, outputs?, runJson? }
 * ctx：{ json, log(...), warn(msg), onCleanup(fn), outputs[] }
 */
export async function runCli({ command, spec, handler, subcommands, summary, argv = process.argv.slice(2) }) {
  const json = argv.includes('--json');
  const warnings = [];
  const cleanups = [];
  const ctx = {
    json,
    log: (...args) => process.stderr.write(args.map(String).join(' ') + '\n'),
    warn: msg => { warnings.push(msg); process.stderr.write(`提示：${msg}\n`); },
    onCleanup: fn => cleanups.push(fn),
    outputs: [],
  };
  let commandLabel = command;
  const emit = (env, text) => {
    if (json) process.stdout.write(JSON.stringify(env) + '\n');
    else if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  };
  const fail = (err) => {
    const exitCode = err instanceof EvalError ? err.exitCode : EXIT.RUN;
    const error = err instanceof EvalError
      ? { code: err.code, message: err.message, hint: err.hint ?? null }
      : { code: 'internal', message: `内部错误：${err?.message ?? err}`, hint: '这是评测工具自身的缺陷；设 BEIMING_DEBUG=1 重跑可看到堆栈，并把输出附在问题报告里' };
    if (json) emit(envelope({ ok: false, exitCode, command: commandLabel, error, warnings, data: err?.details ?? null }));
    process.stderr.write(`错误：${error.message}\n${error.hint ? `下一步：${error.hint}\n` : ''}`);
    if (!(err instanceof EvalError) && process.env.BEIMING_DEBUG === '1' && err?.stack) process.stderr.write(err.stack + '\n');
    process.exitCode = exitCode;
  };

  let parsed;
  let activeSpec = spec;
  let activeHandler = handler;
  try {
    if (subcommands) {
      // 子命令必须写在最前面：避免把某个参数的值误认成子命令
      const first = argv[0] !== undefined && !argv[0].startsWith('-') ? argv[0] : null;
      const wantsHelp = argv.includes('--help') || argv.includes('-h');
      if (!first) {
        if (argv.some(a => !a.startsWith('-'))) throw usageError(`子命令要写在最前面：node ${command} <${Object.keys(subcommands).join('|')}> [参数]`, '加 --help 查看用法', 'usage.missing-argument');
        if (wantsHelp) {
          const lines = [summary ?? '', '', `用法：node ${command} <子命令> [参数]`, '', '子命令：'];
          for (const [name, sub] of Object.entries(subcommands)) lines.push(`  ${name.padEnd(12)} ${sub.spec.summary ?? ''}`);
          lines.push('', `每个子命令加 --help 看详细参数，例如 node ${command} ${Object.keys(subcommands)[0]} --help`);
          process.stdout.write(lines.join('\n') + '\n');
          process.exitCode = 0;
          return;
        }
        throw usageError(`缺少子命令：可用 ${Object.keys(subcommands).join(' / ')}`, '加 --help 查看用法', 'usage.missing-argument');
      }
      const sub = subcommands[first];
      if (!sub) throw usageError(`未知子命令 ${first}：可用 ${Object.keys(subcommands).join(' / ')}`, '加 --help 查看用法', 'usage.unknown-command');
      commandLabel = `${command} ${first}`;
      activeSpec = { ...sub.spec, command: commandLabel };
      activeHandler = sub.handler;
      parsed = parseArgs(argv.slice(1), activeSpec);
    } else {
      parsed = parseArgs(argv, { ...spec, command });
    }
  } catch (err) {
    fail(err);
    return;
  }
  if (parsed.help) {
    process.stdout.write(formatHelp(commandLabel, activeSpec));
    process.exitCode = 0;
    return;
  }

  let finished = false;
  const onSignal = (signal) => {
    if (finished) return;
    finished = true;
    for (const fn of cleanups.reverse()) { try { fn(); } catch { /* 清理尽力而为 */ } }
    const exitCode = signal === 'SIGINT' ? EXIT.SIGINT : EXIT.SIGTERM;
    if (json) emit(envelope({ ok: false, exitCode, command: commandLabel, error: { code: 'interrupted', message: `收到 ${signal}，已停止并清理`, hint: '需要时重新运行同一命令' }, warnings }));
    process.exit(exitCode);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = (await activeHandler(parsed, ctx)) ?? {};
    finished = true;
    const exitCode = result.exitCode ?? EXIT.OK;
    const env = envelope({
      ok: exitCode === EXIT.OK,
      exitCode,
      command: commandLabel,
      error: exitCode === EXIT.OK ? null : (result.error ?? { code: 'failed', message: '判定未通过', hint: null }),
      outputs: result.outputs ?? ctx.outputs,
      runJson: result.runJson ?? null,
      warnings,
      data: result.data ?? null,
    });
    emit(env, result.text);
    if (!json && exitCode !== EXIT.OK && result.error) {
      process.stderr.write(`${result.error.message}\n${result.error.hint ? `下一步：${result.error.hint}\n` : ''}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    finished = true;
    for (const fn of cleanups.reverse()) { try { fn(); } catch { /* 清理尽力而为 */ } }
    fail(err);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
