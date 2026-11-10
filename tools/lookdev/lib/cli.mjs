// A 路线工具（tools/fonts、tools/plates、tools/lookdev）共用的命令约定：退出码、--json 信封、参数解析、清理与信号。
// 按加固计划附录 C 写：C1 退出码、C2 --json 信封（stdout 只输出一个对象，给人看的日志一律走 stderr）、--help 输出到 stdout、
// 退出码 0 且没有任何副作用。治理骨架的公共命令库（tools/lib）合入后，可以把这里换成它，接口按同一份约定。
//
//   EXIT                         { OK 0, RUN 1, USAGE 2, ENV 3, CONTRACT 4, BUSY 5, TIMEOUT 124, INT 130, TERM 143 }
//   new CliError(exit, code, message, hint)   业务代码里 throw 它，runCli 统一转成退出码与信封
//   parseArgs(argv, spec)        spec = { 名字: 'bool' | 'string' | 'number' | 'list' | 'list-raw' }；未知参数 → 用法错误（退出码 2）
//                                list 按逗号拆开累加；list-raw 每次出现整段累加（取值里本身带逗号时用）
//   runCli({ command, usage, spec, main })    main({ opts, args, out, warn, log }) 返回 data；out(path, kind) 登记产物（自动算 sha256）
//   onCleanup(fn)                登记清理函数：正常结束、出错、Ctrl-C、SIGTERM 都会执行（删临时目录、关浏览器）
//   sha256File(path) / sha256(buf)   ROOT（仓库根）/ rel(path)（相对仓库根、正斜杠）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const EXIT = { OK: 0, RUN: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, INT: 130, TERM: 143 };

export class CliError extends Error {
  constructor(exit, code, message, hint = '') { super(message); this.name = 'CliError'; this.exit = exit; this.code = code; this.hint = hint; }
}

export const rel = p => path.relative(ROOT, path.resolve(p)).split(path.sep).join('/');
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export function sha256File(file) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), b = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, b, 0, b.length, null)) > 0;) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function parseArgs(argv, spec) {
  const opts = {}, args = [];
  for (const [k, t] of Object.entries(spec)) opts[k] = t === 'bool' ? false : (t === 'list' || t === 'list-raw') ? [] : null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { args.push(a); continue; }
    const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq), t = spec[name];
    if (!t) throw new CliError(EXIT.USAGE, 'unknown-flag', `不认识的参数 ${a}`, '用 --help 看可用参数');
    if (t === 'bool') { if (eq >= 0) throw new CliError(EXIT.USAGE, 'bad-flag', `${name} 是开关，不带值`); opts[name] = true; continue; }
    let v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || (eq < 0 && v.startsWith('--'))) throw new CliError(EXIT.USAGE, 'missing-value', `--${name} 后面要跟值`);
    if (t === 'number') { const n = Number(v); if (!Number.isFinite(n)) throw new CliError(EXIT.USAGE, 'bad-number', `--${name} 要一个数，现在是 ${v}`); v = n; }
    if (t === 'list') opts[name].push(...v.split(',').map(s => s.trim()).filter(Boolean));
    else if (t === 'list-raw') opts[name].push(v);
    else opts[name] = v;
  }
  return { opts, args };
}

const cleanups = [];
export const onCleanup = fn => { cleanups.push(fn); return fn; };
async function runCleanups() {
  while (cleanups.length) { const fn = cleanups.pop(); try { await fn(); } catch (e) { process.stderr.write(`[清理] ${e.message}\n`); } }
}

export async function runCli({ command, usage, spec = {}, main }) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage.trim() + '\n'); process.exitCode = 0; return; }
  const outputs = [], warnings = [];
  const finish = (exitCode, error, data) => {
    if (json) process.stdout.write(JSON.stringify({ ok: exitCode === 0, exitCode, command, error, outputs, runJson: null, warnings, data: data ?? null }) + '\n');
    else if (error) process.stderr.write(`错误：${error.message}${error.hint ? `\n下一步：${error.hint}` : ''}\n`);
    process.exitCode = exitCode;
  };
  let stopping = false;
  const onSignal = (sig, code) => async () => {
    if (stopping) return; stopping = true;
    process.stderr.write(`收到 ${sig}，清理后退出\n`);
    await runCleanups();
    finish(code, { code: 'interrupted', message: `收到 ${sig}，已清理`, hint: '' });
    process.exit(code);
  };
  const hInt = onSignal('SIGINT', EXIT.INT), hTerm = onSignal('SIGTERM', EXIT.TERM);
  process.on('SIGINT', hInt); process.on('SIGTERM', hTerm);
  try {
    const { opts, args } = parseArgs(argv, { json: 'bool', ...spec });
    const out = (file, kind) => { outputs.push({ path: rel(file), sha256: sha256File(file), kind }); return file; };
    const warn = m => { warnings.push(m); if (!json) process.stderr.write(`提示：${m}\n`); };
    const log = m => process.stderr.write(m + '\n');
    const data = await main({ opts, args, out, warn, log, json });
    await runCleanups();
    finish(EXIT.OK, null, data);
  } catch (e) {
    await runCleanups();
    if (e instanceof CliError) finish(e.exit, { code: e.code, message: e.message, hint: e.hint }, e.data);
    else finish(EXIT.RUN, { code: 'internal', message: e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e), hint: '这是工具自身的错误，带上这行信息报给维护者' });
  } finally {
    process.off('SIGINT', hInt); process.off('SIGTERM', hTerm);
  }
}
