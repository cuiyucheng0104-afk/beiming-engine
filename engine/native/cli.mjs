// 北冥引擎 · 原生层 · 命令行公共件：B 路线所有 Node 入口（prepare / sequence / bridge / runtime / 渲染入口）共用的
// 子进程（流式输出 + 超时 + 进程组清理）、清理登记与日志。参数解析、--help、--json 信封、退出码一律用仓库的命令约定库
// tools/lib/cli.mjs（docs/CLI.md，附录 C1 / C2），这里只做薄封装，不另造一套。
//
//   EXIT                      退出码（数值与 tools/lib/cli.mjs 的 EXIT 相同，名字短一些）：0 成功 · 1 运行失败 · 2 用法错误
//                             · 3 环境或依赖缺失 · 4 契约 / 验收不通过 · 5 资源忙 · 124 超时 · 130 / 143 收到 SIGINT / SIGTERM（已清理）
//   fail(exit, name, message, hint)   → tools/lib/cli.mjs 的 CliError，错误码 = <前缀>.<name>（usage / env / contract / busy /
//                             timeout / failure，前缀决定退出码）；message 说原因，hint 说下一步怎么做
//   bind(ctx)                 命令的 run(ctx) 第一行调用：日志与警告转给 ctx（--quiet、--json 信封的 warnings 都照约定走），
//                             并登记清理——收到 SIGINT / SIGTERM 或抛错时整组终止子进程、执行 onCleanup 登记的清理
//   log(msg) / warn(msg)      给人看的日志（stderr）；warn 同时进 --json 信封的 warnings 与 getWarnings()（渲染入口写进 run.json）
//   onCleanup(fn) / offCleanup(fn)   库函数（不拿 ctx）登记 / 取消清理
//   spawnStream(cmd, args, o) 异步子进程：逐行回调、可写日志文件、超时（exit 124）、独立进程组，信号到来时整组终止
//   runQuick(cmd, args, o)    短命令（版本探测、ffprobe）：同步执行、必带超时；找不到程序抛 exit 3
//   sha256File(path)          流式 SHA-256（大文件不整读进内存）
//   exitWith(codePromise)     直接执行时的出口：等 stdout / stderr 写完再退出（管道里的 JSON 不被截断，也不因残留句柄挂住）
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { CliError, EXIT as LIB_EXIT, defineCommand, envelope, isMain, runCli } from '../../tools/lib/cli.mjs';

export { CliError, defineCommand, envelope, isMain, runCli };

export const EXIT = Object.freeze({
  OK: LIB_EXIT.OK, FAIL: LIB_EXIT.FAILURE, USAGE: LIB_EXIT.USAGE, ENV: LIB_EXIT.ENVIRONMENT, CONTRACT: LIB_EXIT.CONTRACT,
  BUSY: LIB_EXIT.BUSY, TIMEOUT: LIB_EXIT.TIMEOUT, SIGINT: LIB_EXIT.SIGINT, SIGTERM: LIB_EXIT.SIGTERM,
});
const PREFIX = { [EXIT.FAIL]: 'failure', [EXIT.USAGE]: 'usage', [EXIT.ENV]: 'env', [EXIT.CONTRACT]: 'contract', [EXIT.BUSY]: 'busy', [EXIT.TIMEOUT]: 'timeout' };

export function fail(exit, name, message, hint = null) {
  return new CliError(`${PREFIX[exit] ?? 'failure'}.${name}`, message, { hint: hint || null, exitCode: exit });
}

// ── 日志：绑定了命令上下文就交给它（--quiet、信封 warnings），否则直接写 stderr（库函数被单测直接调用时） ──
let current = null;
const warnings = [];
export const log = msg => { if (current) current.log.info(String(msg)); else process.stderr.write(`${msg}\n`); };
export const warn = msg => {
  warnings.push(String(msg));
  if (current) current.warn('native.warning', String(msg)); else process.stderr.write(`提示：${msg}\n`);
};
export const getWarnings = () => [...warnings];

// ── 子进程与清理登记：信号到来或命令抛错时整组终止，再跑清理钩子（后登记先执行） ──
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
export async function cleanupAll() {
  for (const c of [...children]) killTree(c, 'SIGKILL');
  for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* 清理尽力而为 */ } }
}

export function bind(ctx) {
  current = ctx;
  ctx.onCleanup(cleanupAll);
  return ctx;
}

export function spawnStream(cmd, args, { cwd, env, timeoutMs = 0, onLine, logFile, quiet = false, label = cmd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) { reject(fail(EXIT.ENV, 'spawn', `无法启动 ${label}：${e.message}`)); return; }
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
        ? fail(EXIT.ENV, 'missing-program', `找不到可执行文件：${cmd}`, '检查路径或 PATH；Windows 上要写到 .exe')
        : fail(EXIT.ENV, 'spawn', `无法启动 ${label}：${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      for (const k of ['stdout', 'stderr']) if (rest[k]) { onLine?.(rest[k], k); if (!quiet) log(`  │ ${rest[k]}`); }
      const done = () => {
        if (timedOut) reject(fail(EXIT.TIMEOUT, 'process', `${label} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`, '确认没有卡死后用 --timeout 放宽，或先用 --at 渲几帧定位'));
        else resolve({ code, signal, stdout: buf.stdout, stderr: buf.stderr });
      };
      if (sink) sink.end(done); else done();
    });
  });
}

export function runQuick(cmd, args, { cwd, env, timeoutMs = 20000, label = cmd, input } = {}) {
  const p = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (p.error?.code === 'ENOENT') throw fail(EXIT.ENV, 'missing-program', `找不到 ${label}（${cmd}）`, '装好后放进 PATH，或用对应环境变量指定完整路径');
  if (p.error?.code === 'ETIMEDOUT') throw fail(EXIT.TIMEOUT, 'process', `${label} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`);
  if (p.error) throw fail(EXIT.ENV, 'spawn', `${label} 无法运行：${p.error.message}`);
  return p;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

export async function exitWith(codePromise) {
  const code = await codePromise;
  if (code === EXIT.SIGINT || code === EXIT.SIGTERM) {
    // 收到信号：命令约定库的信号处理还在收尾（清理、写 --json 信封），由它退出进程；这里不抢先退出，10 秒兜底
    setTimeout(() => process.exit(code), 10000);
    return;
  }
  await new Promise(r => process.stdout.write('', r));
  await new Promise(r => process.stderr.write('', r));
  process.exit(code);
}
