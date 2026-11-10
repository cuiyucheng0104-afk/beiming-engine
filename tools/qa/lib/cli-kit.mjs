// 北冥 QA · 命令行底座：退出码（附录 C1）、严格参数解析、--json 信封（附录 C2）、子进程与清理登记、信号处理。
// P02 的 tools/lib/cli.mjs 合入后，本文件只保留 QA 专用的部分，其余改为从那里导入（见 docs/quality/QA-GATE.md「接口」）。
//
//   EXIT                         退出码枚举：0 成功 / 1 运行失败 / 2 用法 / 3 环境 / 4 验收不通过 / 5 资源忙 / 124 超时 / 130、143 信号
//   QaError(code, message, { hint, exitCode })   带机器码与下一步提示的错误；cli.mjs 把它变成信封里的 error
//   parseArgs(argv, spec)        严格解析：未知参数、缺值、多余位置参数都抛用法错误（exit 2）
//   envelope(fields)             组装 { ok, exitCode, command, error, outputs, runJson, warnings, result }
//   onCleanup(fn) / trackChild(cp) / runCleanups()   登记清理动作与子进程；退出、出错、收到信号时统一清理
//   installSignalHandlers()      SIGINT → 清理后 exit 130；SIGTERM → 清理后 exit 143
//   log(...)                     供人阅读的日志，一律写 stderr
export const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2, ENV: 3, GATE: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });

export class QaError extends Error {
  constructor(code, message, { hint = null, exitCode = EXIT.RUNTIME, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QaError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
export const usageError = (message, hint = '用 --help 查看用法') => new QaError('usage', message, { hint, exitCode: EXIT.USAGE });

// spec = { options: { '--name': { type: 'boolean'|'string'|'number'|'list', alias?: '-x', desc } }, positionals: { min, max, names } }
// list 类型可重复出现，也接受逗号分隔；返回 { opts: { name: value }, positionals: [] }，opts 的键去掉前导 --、连字符转驼峰
export function parseArgs(argv, spec) {
  const options = spec.options || {};
  const byName = new Map();
  for (const [name, o] of Object.entries(options)) {
    byName.set(name, { name, ...o });
    if (o.alias) byName.set(o.alias, { name, ...o });
  }
  const key = n => n.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const opts = {};
  for (const [name, o] of Object.entries(options)) {
    if (o.type === 'boolean') opts[key(name)] = false;
    else if (o.type === 'list') opts[key(name)] = [];
    else if (o.default !== undefined) opts[key(name)] = o.default;
  }
  const positionals = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest || !a.startsWith('-') || a === '-') { positionals.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const o = byName.get(flag);
    if (!o) {
      const known = Object.keys(options).join(' ');
      throw usageError(`未知参数 ${flag}`, `可用参数：${known}`);
    }
    const k = key(o.name);
    if (o.type === 'boolean') {
      if (eq > 0) throw usageError(`${flag} 是开关，不带值`);
      opts[k] = true;
      continue;
    }
    let v;
    if (eq > 0) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) throw usageError(`${flag} 后面要跟一个值`);
      i++;
    }
    if (o.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw usageError(`${flag} 要一个数字，收到「${v}」`);
      if (o.min !== undefined && n < o.min) throw usageError(`${flag} 不能小于 ${o.min}`);
      opts[k] = n;
    } else if (o.type === 'list') {
      opts[k].push(...v.split(',').map(s => s.trim()).filter(Boolean));
    } else {
      if (o.choices && !o.choices.includes(v)) throw usageError(`${flag} 只能取 ${o.choices.join(' / ')}，收到「${v}」`);
      opts[k] = v;
    }
  }
  const pos = spec.positionals || { min: 0, max: 0 };
  if (positionals.length < (pos.min ?? 0)) throw usageError(`缺少参数：${(pos.names || []).slice(positionals.length).join(' ') || '位置参数'}`);
  if (pos.max !== undefined && positionals.length > pos.max) throw usageError(`多余的参数：${positionals.slice(pos.max).join(' ')}`);
  return { opts, positionals };
}

export function envelope({ ok, exitCode, command, error = null, outputs = [], runJson = null, warnings = [], result = null }) {
  return {
    ok: !!ok,
    exitCode,
    command,
    error: error ? { code: error.code || 'runtime', message: error.message || String(error), hint: error.hint ?? null } : null,
    outputs,
    runJson,
    warnings,
    result,
  };
}

let quiet = false;
export const setQuiet = v => { quiet = !!v; };
export const log = (...a) => { if (!quiet) process.stderr.write(a.join(' ') + '\n'); };

// ── 清理与子进程 ──
const cleanups = [];
const children = new Set();
export function onCleanup(fn) {
  cleanups.push(fn);
  return () => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); };
}
export function trackChild(cp) {
  children.add(cp);
  cp.once('exit', () => children.delete(cp));
  cp.once('error', () => children.delete(cp));
  return cp;
}
export async function runCleanups() {
  for (const cp of children) { try { cp.kill('SIGKILL'); } catch { /* 已退出 */ } }
  children.clear();
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { await Promise.race([fn(), new Promise(r => setTimeout(r, 5000))]); } catch { /* 清理失败不再抛 */ }
  }
}
let installed = false;
export function installSignalHandlers() {
  if (installed) return;
  installed = true;
  for (const [sig, code] of [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM]]) {
    process.once(sig, () => {
      log(`收到 ${sig}，正在清理子进程与临时文件…`);
      runCleanups().finally(() => process.exit(code));
    });
  }
}
