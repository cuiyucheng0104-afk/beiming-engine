// 北冥仓库 · 合规工具的命令行约定：严格参数解析、退出码（计划书附录 C1）、--json 信封（附录 C2）。
// 接口：EXIT（退出码常量）、UsageError / EnvError / FailError（带退出码的错误）、
//       parseCli(argv, spec) → { values, positionals }，未知参数抛 UsageError（退出码 2）；
//       用法错误的码与 tools/lib/cli.mjs 同名（docs/CLI.md 第 4 节）：usage.unknown-option（「不认识的选项 --xxx」）、
//       usage.missing-value、usage.bad-value、usage.extra-argument；
//       envelope({ command, exitCode, error, outputs, warnings, result }) → 附录 C2 的对象（schemaVersion 1）；
//       runMain(command, fn, { json }) 统一收尾：--json 时 stdout 只输出一个对象，人读日志走 stderr。
// P02 的 tools/lib/cli.mjs 合入后可以改为转调它；这里只依赖 Node 自带模块，保证本目录能独立运行。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { parseArgs } from 'node:util';

export const EXIT = Object.freeze({
  OK: 0,          // 成功
  FAIL: 1,        // 运行失败（工具自身出错）
  USAGE: 2,       // 用法错误
  ENV: 3,         // 环境或依赖缺失（不在 git 仓库、读不到必需文件）
  CONTRACT: 4,    // 检查不通过（有阻断级发现、生成物过期）
  BUSY: 5,
  TIMEOUT: 124,
  SIGINT: 130,
  SIGTERM: 143,
});

class CliError extends Error {
  constructor(message, { code, hint = '', exitCode }) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
export class UsageError extends CliError {
  constructor(message, hint = '加 --help 查看用法', code = 'usage.bad-value') { super(message, { code, hint, exitCode: EXIT.USAGE }); }
}
export class EnvError extends CliError {
  constructor(message, hint = '') { super(message, { code: 'env', hint, exitCode: EXIT.ENV }); }
}
export class FailError extends CliError {
  constructor(message, hint = '') { super(message, { code: 'fail', hint, exitCode: EXIT.FAIL }); }
}

// spec：{ options: { name: { type: 'boolean'|'string', short?, multiple? } }, allowPositionals, maxPositionals }
export function parseCli(argv, spec) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: spec.options, allowPositionals: !!spec.allowPositionals, strict: true });
  } catch (e) {
    const known = Object.keys(spec.options).map(k => `--${k}`).join(' ');
    const hint = `可用参数：${known}；加 --help 查看用法`;
    const flag = /'(-{1,2}[^' ]+)/.exec(e.message)?.[1] ?? '';
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw new UsageError(`不认识的选项 ${flag || e.message}`, hint, 'usage.unknown-option');
    if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      if (/does not take an argument/.test(e.message)) throw new UsageError(`${flag} 是开关，不带值`, hint, 'usage.bad-value');
      throw new UsageError(`${flag} 后面要跟一个值`, hint, 'usage.missing-value');
    }
    if (e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') throw new UsageError(`不接受位置参数：${/'([^']*)'/.exec(e.message)?.[1] ?? ''}`, hint, 'usage.extra-argument');
    throw new UsageError(`参数不对：${e.message}`, hint);
  }
  if (spec.maxPositionals != null && parsed.positionals.length > spec.maxPositionals) {
    throw new UsageError(`多余的位置参数：${parsed.positionals.slice(spec.maxPositionals).join(' ')}`, '加 --help 查看用法', 'usage.extra-argument');
  }
  return parsed;
}

export function envelope({ command, exitCode = EXIT.OK, error = null, outputs = [], warnings = [], result = null }) {
  return {
    schemaVersion: 1,
    ok: exitCode === EXIT.OK,
    exitCode,
    command,
    error: error ? { code: error.code || 'fail', message: error.message, hint: error.hint || '' } : null,
    outputs,
    runJson: null,
    warnings,
    result,
  };
}

// fn 返回 { exitCode, result, outputs, warnings, text }；text 是人读报告（非 --json 时写到 stdout）。
export async function runMain(command, fn, { json = false } = {}) {
  let out;
  try {
    out = await fn();
  } catch (e) {
    const err = e instanceof CliError ? e : Object.assign(new FailError(`工具内部错误：${e && e.message ? e.message : e}`,
      '这是工具自身的问题，不是仓库内容的问题；带上完整输出报告给 tools/compliance 的维护者'), { stack: e && e.stack });
    if (json) process.stdout.write(JSON.stringify(envelope({ command, exitCode: err.exitCode, error: err })) + '\n');
    else {
      process.stderr.write(`错误：${err.message}\n`);
      if (err.hint) process.stderr.write(`下一步：${err.hint}\n`);
      if (!(e instanceof CliError) && e && e.stack && process.env.BEIMING_DEBUG) process.stderr.write(e.stack + '\n');
    }
    process.exitCode = err.exitCode;
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify(envelope({ command, exitCode: out.exitCode, error: out.error || null,
      outputs: out.outputs || [], warnings: out.warnings || [], result: out.result ?? null })) + '\n');
  } else if (out.text) {
    process.stdout.write(out.text.endsWith('\n') ? out.text : out.text + '\n');
  }
  process.exitCode = out.exitCode;
}

// 只要 argv 里有 -h / --help 就只打印用法：在解析其余参数之前判断，保证 --help 无副作用。
export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}
