// 北冥仓库 · 基线工具的命令约定小工具。参数解析、--help、--json 信封、退出码、信号收尾一律由 P02 的命令约定库
// tools/lib/cli.mjs（docs/CLI.md，附录 C1/C2）负责：golden.mjs 与 determinism.mjs 用它的 defineCommand + runCli。
// 本文件只补基线工具自己要的几样：
//
//   EXIT                      附录 C1 退出码（tools/lib/cli.mjs 的 EXIT，另加 FAIL = 1、ENV = 3 两个短名）
//   CliError(code, message, { hint, exitCode })   就是 tools/lib/cli.mjs 的 CliError；code 带前缀（usage. env. contract. busy.）
//   codeFor(exitCode, name)   给子进程报上来的短错误名补前缀：codeFor(3, 'no-browser') → 'env.no-browser'
//   usage(message, hint)      用法错误（exit 2）
//   log(...)                  人读日志，走 stderr；setQuiet(true) 后不打（--quiet）
//   onCleanup(fn) / offCleanup(fn) / runCleanups()
//                             收尾登记（删临时目录、结束截帧子进程）。命令正常结束、出错、收到 SIGINT / SIGTERM 时都执行一次；
//                             进程被直接 exit 时只能做同步收尾：登记的函数带 .sync 版本就调用它
//   bindCleanups(ctx)         把上面的收尾接到 runCli 的 ctx.onCleanup（信号与抛错时由 runCli 调用）
//   echoWarnings(result)      run 返回的 warnings 在人读模式下也打到 stderr（runCli 只把它们放进 --json 信封）
//   parseSize(s)              --size WxH（偶数宽高，≥16）
//   displayPath(root, p)      输出里写的路径：仓库内写相对路径，仓库外写绝对路径；分隔符一律 /
//   sha256File(file) / sha256(data)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT as BASE_EXIT, CliError } from '../../lib/cli.mjs';

export { CliError };
export const EXIT = Object.freeze({ ...BASE_EXIT, FAIL: BASE_EXIT.FAILURE, ENV: BASE_EXIT.ENVIRONMENT });

const PREFIX = { [EXIT.USAGE]: 'usage', [EXIT.ENV]: 'env', [EXIT.CONTRACT]: 'contract', [EXIT.BUSY]: 'busy', [EXIT.TIMEOUT]: 'timeout' };
/** 子进程（截帧 worker）报上来的短错误名 → 带前缀的错误码，前缀与退出码一致（docs/CLI.md 第 1 节）。 */
export function codeFor(exitCode, name = 'failed') {
  if (/^(usage|env|contract|busy|timeout|failure|signal)\./.test(name)) return name;
  return `${PREFIX[exitCode] || 'failure'}.${name}`;
}
export const usage = (message, hint = null) => new CliError('usage.bad-argument', message, { hint, exitCode: EXIT.USAGE });

let quiet = false;
export const setQuiet = q => { quiet = !!q; };
export const log = (...a) => { if (!quiet) console.error(...a); };

// ── 收尾 ──
const cleanups = [];
let cleaned = false;
export function onCleanup(fn) { cleanups.push(fn); return fn; }
export function offCleanup(fn) { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); }
export async function runCleanups() {
  if (cleaned) return;
  cleaned = true;
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch (e) { console.error(`[收尾] ${e.message}`); }
  }
}
process.on('exit', () => {
  if (cleaned) return;
  for (const fn of cleanups.slice().reverse()) { try { fn.sync?.(); } catch { /* 退出途中，忽略 */ } }
});
/** 在 run(ctx) 开头调用：收到信号或抛错时 runCli 会执行这里登记的收尾；返回的函数在 run 正常结束时调用。 */
export function bindCleanups(ctx) {
  const off = ctx.onCleanup(() => runCleanups());
  return async () => { await runCleanups(); off(); };
}

export function echoWarnings(result) {
  for (const w of result?.warnings || []) console.error(`警告：${typeof w === 'string' ? w : w.message}`);
  return result;
}

// --size WxH：偶数宽高（H.264 yuv420p 的要求），16 以上
export function parseSize(s, name = '--size') {
  const m = /^(\d+)x(\d+)$/.exec(String(s || ''));
  const w = m && +m[1], h = m && +m[2];
  if (!m || w % 2 || h % 2 || w < 16 || h < 16) throw usage(`${name} 要写成 WxH，宽高都是 ≥16 的偶数，例如 1920x1040`);
  return [w, h];
}

// 输出里写的路径：在仓库内写相对路径，在仓库外（--out 指到别处）写绝对路径；分隔符一律用 /，三平台一致
export function displayPath(root, p) {
  const r = path.relative(root, p);
  const outside = r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
  return (outside ? path.resolve(p) : r).split(path.sep).join('/');
}

// 文件 sha256（大文件流式读）
export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
