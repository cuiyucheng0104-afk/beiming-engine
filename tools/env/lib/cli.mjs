// 北冥仓库 · 环境工具共用的命令行外壳：严格参数、统一退出码（附录 C1）、--json 信封（附录 C2）、信号清理。
//
// 接口：
//   EXIT                              退出码表：OK 0、FAIL 1、USAGE 2、ENV 3、CONTRACT 4、BUSY 5、TIMEOUT 124、SIGINT 130、SIGTERM 143
//   CliError(exitCode, code, message, hint)   带退出码的错误；hint 写「下一步怎么做」
//   usageError(message, hint)         用法错误（exit 2）
//   envelope({command, exitCode, error, outputs, runJson, warnings, ...extra})   C2 信封；extra 是各命令自己的数据字段
//   onCleanup(fn)                     注册清理函数（收到 SIGINT/SIGTERM、出错或正常结束时都执行，后注册先执行）
//   isMain(import.meta.url)          本文件是否被直接运行（按真实路径比较，兼容符号链接与目录联接）
//   runCli({command, help, options, maxPositionals, run})
//       --help / -h：把 help 打到 stdout，exit 0，不执行 run（无副作用）
//       未知参数：exit 2；--json 时 stdout 只有一个信封对象，人读的日志走 stderr
//       run(values, positionals, ctx) 返回 {exitCode?, error?, warnings?, outputs?, ...extra}；抛 CliError 按其退出码结束
//
// tools/lib/cli.mjs（P02）合入后，这里的实现可以换成对它的薄包装；对外行为（退出码、信封字段）不变。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });

export class CliError extends Error {
  constructor(exitCode, code, message, hint = null) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
  }
}

export const usageError = (message, hint = '加 --help 查看用法') => new CliError(EXIT.USAGE, 'usage', message, hint);

export function envelope({ command, exitCode, error = null, outputs = [], runJson = null, warnings = [], ...extra }) {
  return { ok: exitCode === 0, exitCode, command, error, outputs, runJson, warnings, ...extra };
}

const cleanups = [];
export function onCleanup(fn) {
  cleanups.push(fn);
  return () => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); };
}
export async function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { await fn(); } catch { /* 清理尽力而为，不覆盖原始错误 */ }
  }
}

// 写完再退出：管道上 stdout 可能是异步的，直接 process.exit 会截断 JSON
export function writeAndExit(text, code) {
  const done = () => process.exit(code);
  if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n', done);
  else done();
}

export const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// 本模块是否被直接运行（比较真实路径：经 /tmp 这类符号链接或 Windows 目录联接调用时也成立）
export function isMain(metaUrl) {
  const a = process.argv[1];
  if (!a) return false;
  try { return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(a); } catch { return false; }
}

function errorObject(e) {
  if (e instanceof CliError) return { code: e.code, message: e.message, hint: e.hint };
  return { code: 'internal', message: e?.message ?? String(e), hint: '这是工具自身的错误：带上完整输出与平台信息报告给维护者' };
}

export async function runCli({ command, argv = process.argv.slice(2), help, options = {}, maxPositionals = 0, run }) {
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) return writeAndExit(help.trimEnd(), EXIT.OK);

  let finished = false;
  const finish = async (exitCode, { error = null, warnings = [], outputs = [], extra = {}, human = '' } = {}) => {
    if (finished) return;
    finished = true;
    await runCleanups();
    if (json) return writeAndExit(JSON.stringify(envelope({ command, exitCode, error, outputs, warnings, ...extra })), exitCode);
    if (error) log(`${command}：${error.message}${error.hint ? `\n下一步：${error.hint}` : ''}`);
    return writeAndExit(human, exitCode);
  };
  for (const [sig, code] of [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM]]) {
    process.on(sig, () => {
      if (finished) process.exit(code);          // 清理途中再按一次：立即退出
      finish(code, { error: { code: 'interrupted', message: `收到 ${sig}，已停止并清理`, hint: '重新运行同一条命令即可，已完成的步骤会跳过' } });
    });
  }

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { json: { type: 'boolean' }, ...options }, allowPositionals: true, strict: true });
    if (parsed.positionals.length > maxPositionals) {
      throw usageError(maxPositionals ? `多余的参数：${parsed.positionals.slice(maxPositionals).join(' ')}` : `不接受位置参数：${parsed.positionals.join(' ')}`);
    }
  } catch (e) {
    const err = e instanceof CliError ? e : usageError(e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      ? `不认识的参数：${/'([^']+)'/.exec(e.message)?.[1] ?? e.message}` : e.message);
    return finish(err.exitCode, { error: errorObject(err) });
  }

  try {
    const r = (await run(parsed.values, parsed.positionals, { json })) || {};
    const { exitCode = EXIT.OK, error = null, warnings = [], outputs = [], human = '', ...extra } = r;
    return finish(exitCode, { error, warnings, outputs, extra, human });
  } catch (e) {
    // e.extra：失败时仍要带回的数据（例如 setup 已完成的步骤）
    return finish(e instanceof CliError ? e.exitCode : EXIT.FAIL, { error: errorObject(e), extra: e?.extra || {} });
  }
}

// 枚举值校验：返回规范化后的值，不合法时抛用法错误并列出合法取值
export function choice(name, value, allowed) {
  if (value === undefined) return undefined;
  const v = String(value).toLowerCase();
  if (!allowed.includes(v)) throw usageError(`${name} 只能是 ${allowed.join(' / ')}，收到 ${value}`);
  return v;
}
