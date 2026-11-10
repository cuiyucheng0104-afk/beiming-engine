// 北冥仓库 · 基线工具的命令约定（退出码、--json 信封、严格参数、信号收尾）。
// 按加固计划附录 C1/C2 写：P02 的 tools/lib/cli.mjs 落地后，本文件改为从那里转出，接口不变。
//
//   EXIT                      退出码枚举（C1）
//   CliError(code, message, { hint, exitCode })   可预期的失败：code 是机器可读的短名
//   parseArgs(argv, spec)     严格解析：未知参数、缺值、重复的单值参数 → 用法错误（exit 2）
//     spec = { flags: { '--json': 'bool', '--set': 'list', '--size': 'string', '--workers': 'int' }, positionals: [min, max] }
//   runMain({ command, json, help, main })   跑主函数：--help 打到 stdout 并 exit 0；出错按 C1 退出；
//                              --json 时 stdout 只输出一个信封对象，人读日志一律走 stderr
//   onCleanup(fn)             登记收尾动作（删临时目录、关子进程）；正常结束、出错、SIGINT/SIGTERM 都会执行一次
//   log(...)                  人读日志（stderr）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXIT = Object.freeze({
  OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143,
});

export class CliError extends Error {
  constructor(code, message, { hint = '', exitCode = EXIT.FAIL } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
export const usage = (message, hint = '') => new CliError('usage', message, { hint, exitCode: EXIT.USAGE });

export const log = (...a) => console.error(...a);

// ── 严格参数解析 ──
// 类型：bool（不带值）、string、int、number、list（可重复，也接受逗号分隔）
export function parseArgs(argv, spec) {
  const flags = spec.flags || {};
  const opts = {}, positionals = [];
  for (const [k, type] of Object.entries(flags)) opts[key(k)] = type === 'bool' ? false : type === 'list' ? [] : undefined;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--') || a === '-') {
      if (/^-[a-zA-Z]$/.test(a) && a !== '-') {
        if (a === '-h') { opts.help = true; continue; }
        throw usage(`不认识的参数 ${a}`, '用 --help 看全部参数');
      }
      positionals.push(a); continue;
    }
    let name = a, val = null;
    const eq = a.indexOf('=');
    if (eq > 0) { name = a.slice(0, eq); val = a.slice(eq + 1); }
    if (name === '--help') { opts.help = true; continue; }
    const type = flags[name];
    if (!type) throw usage(`不认识的参数 ${name}`, `可用参数：${Object.keys(flags).join(' ')}（--help 看说明）`);
    if (type === 'bool') {
      if (val !== null) throw usage(`${name} 不带值`);
      opts[key(name)] = true; continue;
    }
    if (val === null) {
      val = argv[i + 1];
      if (val === undefined || (val.startsWith('--') && val.length > 2)) throw usage(`${name} 后面要跟一个值`);
      i++;
    }
    if (type === 'list') { opts[key(name)].push(...val.split(',').map(s => s.trim()).filter(Boolean)); continue; }
    if (seen.has(name)) throw usage(`${name} 只能写一次`);
    seen.add(name);
    if (type === 'int') {
      if (!/^-?\d+$/.test(val)) throw usage(`${name} 要写整数，现在是 ${JSON.stringify(val)}`);
      opts[key(name)] = Number(val);
    } else if (type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) throw usage(`${name} 要写数字，现在是 ${JSON.stringify(val)}`);
      opts[key(name)] = n;
    } else opts[key(name)] = val;
  }
  const [min = 0, max = Infinity] = spec.positionals || [];
  if (!opts.help && (positionals.length < min || positionals.length > max)) {
    throw usage(max === 0 ? `这个命令不接受位置参数（收到 ${positionals.join(' ')}）` : `位置参数个数不对（收到 ${positionals.length} 个）`, '用 --help 看用法');
  }
  return { opts, positionals };
}
function key(flag) { return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// --size WxH：偶数宽高（H.264 yuv420p 的要求），16 以上
export function parseSize(s, name = '--size') {
  const m = /^(\d+)x(\d+)$/.exec(String(s || ''));
  const w = m && +m[1], h = m && +m[2];
  if (!m || w % 2 || h % 2 || w < 16 || h < 16) throw usage(`${name} 要写成 WxH，宽高都是 ≥16 的偶数，例如 1920x1040`);
  return [w, h];
}

// ── 收尾 ──
const cleanups = [];
let cleaned = false;
export function onCleanup(fn) { cleanups.push(fn); return fn; }
export function offCleanup(fn) { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); }
async function runCleanups() {
  if (cleaned) return;
  cleaned = true;
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch (e) { log(`[收尾] ${e.message}`); }
  }
}
// 进程被 process.exit 直接结束时只能做同步收尾：登记的函数如果有 .sync 版本就调用
process.on('exit', () => {
  if (cleaned) return;
  for (const fn of cleanups.slice().reverse()) { try { fn.sync?.(); } catch { /* 退出途中，忽略 */ } }
});

// ── 主函数 ──
// main(ctx) 返回 { exitCode = 0, outputs = [], runJson = null, warnings = [], result }；
// 抛 CliError 按它的 exitCode 退出；其它异常按 1（运行失败）。
export async function runMain({ command, argv = process.argv.slice(2), spec, help, main }) {
  const wantJson = argv.includes('--json');
  let finished = false;
  const envelope = { ok: false, exitCode: EXIT.FAIL, command, error: null, outputs: [], runJson: null, warnings: [] };
  const emit = () => {
    if (wantJson) process.stdout.write(JSON.stringify(envelope) + '\n');
  };
  const onSignal = (sig, code) => async () => {
    if (finished) return;
    finished = true;
    log(`收到 ${sig}，正在收尾（关浏览器、删临时目录）……`);
    await runCleanups();
    Object.assign(envelope, { ok: false, exitCode: code, error: { code: 'signal', message: `收到 ${sig}，已清理`, hint: '' } });
    emit();
    process.exit(code);
  };
  process.on('SIGINT', onSignal('SIGINT', EXIT.SIGINT));
  process.on('SIGTERM', onSignal('SIGTERM', EXIT.SIGTERM));
  let parsed;
  try {
    parsed = parseArgs(argv, spec);
  } catch (e) {
    finished = true;
    Object.assign(envelope, { exitCode: e.exitCode ?? EXIT.USAGE, error: { code: e.code || 'usage', message: e.message, hint: e.hint || '' } });
    if (!wantJson) log(`用法错误：${e.message}${e.hint ? `\n  ${e.hint}` : ''}`);
    emit();
    process.exit(envelope.exitCode);
  }
  if (parsed.opts.help) {
    finished = true;
    process.stdout.write(help.trimEnd() + '\n');
    process.exit(EXIT.OK);
  }
  try {
    const r = (await main(parsed)) || {};
    await runCleanups();
    finished = true;
    const exitCode = r.exitCode ?? EXIT.OK;
    Object.assign(envelope, {
      ok: exitCode === EXIT.OK, exitCode, outputs: r.outputs || [], runJson: r.runJson ?? null, warnings: r.warnings || [],
      error: exitCode === EXIT.OK ? null : (r.error || { code: 'failed', message: '检查未通过', hint: '' }),
    });
    if (r.result !== undefined) envelope.result = r.result;
    emit();
    process.exit(exitCode);
  } catch (e) {
    await runCleanups();
    finished = true;
    const exitCode = e instanceof CliError ? e.exitCode : EXIT.FAIL;
    Object.assign(envelope, {
      ok: false, exitCode,
      error: { code: e.code && typeof e.code === 'string' ? e.code : 'internal', message: e.message, hint: e.hint || '' },
    });
    log(`${exitCode === EXIT.USAGE ? '用法错误' : exitCode === EXIT.FAIL && !(e instanceof CliError) ? '运行失败' : '失败'}：${e.message}${e.hint ? `\n  下一步：${e.hint}` : ''}`);
    if (!(e instanceof CliError) && process.env.BEIMING_DEBUG) log(e.stack);
    emit();
    process.exit(exitCode);
  }
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
