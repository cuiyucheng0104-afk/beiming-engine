// 北冥引擎 · 原生层 · 命令行公共件：B 路线所有 Node 入口（prepare / sequence / bridge / runtime / 渲染入口）共用的
// 参数解析、退出码、--json 信封、子进程（流式输出 + 超时 + 进程组清理）与信号处理。约定见加固计划附录 C1/C2。
//
//   EXIT                      退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 环境或依赖缺失 · 4 契约 / 验收不通过 · 5 资源忙
//                             · 124 超时 · 130 / 143 收到 SIGINT / SIGTERM（已清理）
//   CliError(exit, code, message, hint)   抛出它就按 exit 退出；message 说原因，hint 说下一步怎么做
//   parseArgs(argv, spec)     spec = { '--json': 'bool', '--at': 'string', … }；未知参数、缺值都抛 CliError(2)
//   runCli({ command, usage, spec, main })
//                             入口包装：--help 只打印用法到 stdout 并 exit 0（无副作用）；--json 时 stdout 只输出一个信封
//                             { ok, exitCode, command, error: {code, message, hint} | null, outputs, runJson, warnings }；
//                             给人看的日志一律走 stderr（log / warn）；SIGINT / SIGTERM 时先跑登记的清理再退出
//   isMain(import.meta.url)   是否被直接执行（比较 realpath，经符号链接、/tmp 别名、Windows 目录联接调用也成立）
//   spawnStream(cmd, args, o) 异步子进程：逐行回调、可写日志文件、超时（exit 124）、独立进程组，信号到来时整组终止
//   runQuick(cmd, args, o)    短命令（版本探测、ffprobe）：同步执行、必带超时；找不到程序抛 CliError(3)
//   sha256File(path)          流式 SHA-256（大文件不整读进内存）
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });

export class CliError extends Error {
  constructor(exitCode, code, message, hint = '') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.hint = hint;
  }
}
export const usageError = (message, hint = '加 --help 看用法') => new CliError(EXIT.USAGE, 'usage', message, hint);

// 给人看的输出：一律 stderr。--json 时 stdout 只留信封。
export const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const warnings = [];
export const warn = msg => { warnings.push(msg); log(`提示：${msg}`); };
export const getWarnings = () => [...warnings];

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

// spec：'bool' 开关；'string' 带一个值（--k v 或 --k=v）。返回 { _: 位置参数[], 各开关 }
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('='), key = eq > 0 ? a.slice(0, eq) : a;
    const kind = spec[key];
    if (!kind) throw usageError(`不认识的参数 ${key}`, `可用参数：${Object.keys(spec).join(' ')}`);
    if (kind === 'bool') {
      if (eq > 0) throw usageError(`${key} 是开关，不带值`);
      out[key.slice(2)] = true;
    } else {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq < 0 && v.startsWith('--'))) throw usageError(`${key} 后面要跟一个值`);
      out[key.slice(2)] = v;
    }
  }
  return out;
}

// ── 子进程登记：信号到来时整组终止，再跑清理钩子 ──
const children = new Set();
const cleanups = [];
export const onCleanup = fn => { cleanups.push(fn); return fn; };
export const offCleanup = fn => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); };

function killTree(child, signal = 'SIGTERM') {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10000, windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch { try { child.kill(signal); } catch { /* 已退出 */ } }
}
async function runCleanups() {
  for (const c of [...children]) killTree(c, 'SIGKILL');
  for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* 清理尽力而为 */ } }
}

export function spawnStream(cmd, args, { cwd, env, timeoutMs = 0, onLine, logFile, quiet = false, label = cmd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) { reject(new CliError(EXIT.ENV, 'spawn', `无法启动 ${label}：${e.message}`)); return; }
    children.add(child);
    const sink = logFile ? createWriteStream(logFile) : null;
    const buf = { stdout: '', stderr: '' }, rest = { stdout: '', stderr: '' };
    let timedOut = false, timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => {
      timedOut = true; killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref();
    }, timeoutMs);
    const feed = (stream, chunk) => {
      const s = chunk.toString('utf8');
      sink?.write(s);
      if (buf[stream].length < 8 * 1024 * 1024) buf[stream] += s;
      const lines = (rest[stream] + s).split(/\r?\n/);
      rest[stream] = lines.pop();
      for (const l of lines) { onLine?.(l, stream); if (!quiet) log(`  │ ${l}`); }
    };
    child.stdout.on('data', c => feed('stdout', c));
    child.stderr.on('data', c => feed('stderr', c));
    child.on('error', e => {
      clearTimeout(timer); children.delete(child); sink?.end();
      reject(e.code === 'ENOENT'
        ? new CliError(EXIT.ENV, 'missing-program', `找不到可执行文件：${cmd}`, '检查路径或 PATH；Windows 上要写到 .exe')
        : new CliError(EXIT.ENV, 'spawn', `无法启动 ${label}：${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      for (const k of ['stdout', 'stderr']) if (rest[k]) { onLine?.(rest[k], k); if (!quiet) log(`  │ ${rest[k]}`); }
      const done = () => {
        if (timedOut) reject(new CliError(EXIT.TIMEOUT, 'timeout', `${label} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`, '确认没有卡死后用 --timeout 放宽，或先用 --at 渲几帧定位'));
        else resolve({ code, signal, stdout: buf.stdout, stderr: buf.stderr });
      };
      if (sink) sink.end(done); else done();
    });
  });
}

export function runQuick(cmd, args, { cwd, env, timeoutMs = 20000, label = cmd, input } = {}) {
  const p = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (p.error?.code === 'ENOENT') throw new CliError(EXIT.ENV, 'missing-program', `找不到 ${label}（${cmd}）`, '装好后放进 PATH，或用对应环境变量指定完整路径');
  if (p.error?.code === 'ETIMEDOUT') throw new CliError(EXIT.TIMEOUT, 'timeout', `${label} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`);
  if (p.error) throw new CliError(EXIT.ENV, 'spawn', `${label} 无法运行：${p.error.message}`);
  return p;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ── 入口包装 ──
export async function runCli({ command, usage, spec, main, argv = process.argv.slice(2) }) {
  const wantsJson = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage.trimEnd() + '\n'); return EXIT.OK; }
  let interrupted = 0;
  const onSignal = sig => {
    if (interrupted) return;
    interrupted = sig === 'SIGINT' ? EXIT.SIGINT : EXIT.SIGTERM;
    log(`收到 ${sig}，正在停止子进程并清理……`);
    runCleanups().finally(() => {
      if (wantsJson) process.stdout.write(JSON.stringify(envelope({ command, exitCode: interrupted, error: { code: 'interrupted', message: `收到 ${sig}，已清理`, hint: '' } })) + '\n');
      process.exit(interrupted);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let result = {}, exitCode = EXIT.OK, error = null, failedRunJson = null;
  try {
    const args = parseArgs(argv, { ...spec, '--json': 'bool', '--help': 'bool' });
    result = (await main(args)) || {};
    exitCode = result.exitCode ?? EXIT.OK;
    error = result.error ?? null;
  } catch (e) {
    if (interrupted) return interrupted;
    failedRunJson = e?.runJson ?? null;
    if (e instanceof CliError) { exitCode = e.exitCode; error = { code: e.code, message: e.message, hint: e.hint || '' }; }
    else { exitCode = EXIT.FAIL; error = { code: 'internal', message: e?.stack || String(e), hint: '这是工具自身的错误：保留输出与日志，报告给维护者' }; }
    await runCleanups();
  }
  // 一行：原因 + 下一步（agent 与 CI 日志按行读；内部错误的调用栈才多行）
  if (error) log(`失败（exit ${exitCode}）：${error.message}${error.hint ? `。下一步：${error.hint}` : ''}`);
  if (wantsJson) process.stdout.write(JSON.stringify(envelope({ command, exitCode, error, outputs: result.outputs, runJson: result.runJson ?? failedRunJson })) + '\n');
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  return exitCode;
}

export function envelope({ command, exitCode = 0, error = null, outputs = [], runJson = null }) {
  return { ok: exitCode === 0, exitCode, command, error, outputs: outputs || [], runJson: runJson ?? null, warnings: [...warnings] };
}

// 直接执行时的统一出口：等 stdout / stderr 写完再退出（管道里的 JSON 不被截断，也不因残留句柄挂住）
export async function exitWith(codePromise) {
  const code = await codePromise;
  await new Promise(r => process.stdout.write('', r));
  await new Promise(r => process.stderr.write('', r));
  process.exit(code);
}
