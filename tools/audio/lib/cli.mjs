// 北冥仓库 · 声音工具的命令约定（tools/audio/*.mjs 共用）：退出码按计划附录 C1、--json 信封按附录 C2、
// 严格参数（未知选项 exit 2 并给「是不是想写」）、--help 打到 stdout 且无副作用、Ctrl+C / SIGTERM 时执行登记的清理。
// 与 tools/lib/cli.mjs、engine/audio/_cli.py 是同一套约定；这里只放声音工具用到的最小部分。
//
//   EXIT                                   { OK 0, FAIL 1, USAGE 2, ENV 3, CONTRACT 4, BUSY 5, TIMEOUT 124, SIGINT 130, SIGTERM 143 }
//   CliError(code, message, { hint, exitCode, data })   code 前缀决定退出码：usage.→2 env.→3 contract.→4 busy.→5 timeout→124
//   parseArgs(argv, spec) → { opts, positionals }       spec = { options: { name: { type: 'boolean'|'string', alias } }, positionals: n }
//   runCli({ command, help, spec, run })                解析 → run(ctx) → 打印 → process.exitCode；ctx = { opts, positionals, log, warn, out, onCleanup }
//   envelope({...}) / sha256File(path)
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });
const PREFIX = [['usage.', EXIT.USAGE], ['env.', EXIT.ENV], ['contract.', EXIT.CONTRACT], ['busy.', EXIT.BUSY], ['timeout', EXIT.TIMEOUT]];
export const exitCodeFor = code => (PREFIX.find(([p]) => String(code).startsWith(p)) ?? [null, EXIT.FAIL])[1];

export class CliError extends Error {
  constructor(code, message, { hint = null, exitCode, data = null } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode ?? exitCodeFor(code);
    this.data = data;
  }
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const isMain = url => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', b => h.update(b)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function closest(word, list) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let best = null;
  for (const c of list) { const s = dist(word, c); if (s <= Math.max(2, Math.floor(c.length / 3)) && (!best || s < best[1])) best = [c, s]; }
  return best?.[0] ?? null;
}

const GLOBAL = { help: { type: 'boolean', alias: 'h' }, json: { type: 'boolean' }, quiet: { type: 'boolean' } };

export function parseArgs(argv, spec = {}) {
  const options = { ...GLOBAL, ...(spec.options || {}) };
  const alias = Object.fromEntries(Object.entries(options).filter(([, o]) => o.alias).map(([k, o]) => [o.alias, k]));
  const opts = Object.fromEntries(Object.entries(options).map(([k, o]) => [k, o.type === 'boolean' ? false : (o.default ?? null)]));
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') {
      const short = !a.startsWith('--');
      const [rawName, inline] = short ? [a.slice(1), undefined] : a.slice(2).split(/=(.*)/s, 2);
      const name = short ? alias[rawName] : rawName;
      const o = name && options[name];
      if (!o) {
        const near = closest(rawName, Object.keys(options));
        throw new CliError('usage.unknown-option', `不认识的参数：${a}`, { hint: near ? `是不是想写 --${near}？全部选项见 --help` : '全部选项见 --help' });
      }
      if (o.type === 'boolean') {
        if (inline !== undefined) throw new CliError('usage.bad-value', `--${name} 是开关，不带值`, { hint: `写 --${name}` });
        opts[name] = true;
      } else {
        const v = inline ?? argv[++i];
        if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new CliError('usage.missing-value', `--${name} 后面要跟一个值`, { hint: o.arg ? `写 --${name} ${o.arg}` : '全部选项见 --help' });
        if (o.choices && !o.choices.includes(v)) throw new CliError('usage.bad-value', `--${name} 的取值 ${v} 不在允许范围内（${o.choices.join(' / ')}）`);
        opts[name] = v;
      }
    } else positionals.push(a);
  }
  const [min, max] = Array.isArray(spec.positionals) ? spec.positionals : [spec.positionals ?? 0, spec.positionals ?? 0];
  if (!opts.help && positionals.length < min) throw new CliError('usage.missing-argument', `缺少参数（要 ${min} 个，给了 ${positionals.length} 个）`, { hint: spec.usage || '见 --help' });
  if (!opts.help && positionals.length > max) throw new CliError('usage.unknown-argument', `多出参数：${positionals.slice(max).join(' ')}`, { hint: spec.usage || '见 --help' });
  return { opts, positionals };
}

export function envelope({ command, exitCode = 0, error = null, outputs = [], runJson = null, warnings = [], data = null }) {
  return {
    schemaVersion: 1, ok: exitCode === 0, exitCode, command,
    error: error ? { code: error.code ?? 'failure', message: String(error.message ?? ''), hint: error.hint ?? null } : null,
    outputs: outputs.map(o => ({ path: o.path, sha256: o.sha256 ?? null, kind: o.kind ?? 'file' })),
    runJson, warnings: warnings.map(w => (typeof w === 'string' ? { code: 'warning', message: w, hint: null } : { code: w.code ?? 'warning', message: w.message, hint: w.hint ?? null })),
    data,
  };
}

export async function runCli({ command, help, spec, run, argv = process.argv.slice(2) }) {
  const wantJson = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length).includes('--json');
  const warnings = [];
  const cleanups = [];
  const runCleanups = () => { while (cleanups.length) { try { cleanups.pop()(); } catch (e) { process.stderr.write(`清理失败：${e.message}\n`); } } };
  const finish = (exitCode, { error = null, data = null, outputs = [], runJson = null } = {}) => {
    if (error) {
      process.stderr.write(`错误[${error.code}]：${error.message}\n`);
      if (error.hint) process.stderr.write(`提示：${error.hint}\n`);
    }
    if (wantJson) process.stdout.write(JSON.stringify(envelope({ command, exitCode, error, outputs, runJson, warnings, data }), null, 2) + '\n');
    process.exitCode = exitCode;
    return exitCode;
  };
  let parsed;
  try {
    parsed = parseArgs(argv, spec);
  } catch (e) {
    if (!wantJson) process.stderr.write(`用法：${spec.usage || command}（完整说明：--help）\n`);
    return finish(e.exitCode ?? EXIT.USAGE, { error: e });
  }
  if (parsed.opts.help) { process.stdout.write(typeof help === 'function' ? help() : help); process.exitCode = 0; return 0; }
  const ctx = {
    opts: parsed.opts, positionals: parsed.positionals, json: parsed.opts.json,
    log: m => { if (!parsed.opts.quiet) process.stderr.write(m + '\n'); },
    warn: (code, message, hint = null) => { warnings.push({ code, message, hint }); process.stderr.write(`警告[${code}]：${message}\n${hint ? `提示：${hint}\n` : ''}`); },
    out: t => { if (!parsed.opts.json) process.stdout.write(t + '\n'); },
    onCleanup: fn => { cleanups.push(fn); return () => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); }; },
  };
  const onSig = (sig, code) => () => { runCleanups(); finish(code, { error: { code: `signal.${sig.toLowerCase()}`, message: `收到 ${sig}，已停止并清理` } }); process.exit(code); };
  const hInt = onSig('SIGINT', EXIT.SIGINT), hTerm = onSig('SIGTERM', EXIT.SIGTERM);
  process.once('SIGINT', hInt);
  process.once('SIGTERM', hTerm);
  try {
    const r = (await run(ctx)) ?? {};
    const code = r.exitCode ?? (r.error ? exitCodeFor(r.error.code) : EXIT.OK);
    if (code !== 0) runCleanups();
    return finish(code, r);
  } catch (e) {
    runCleanups();
    if (e instanceof CliError) return finish(e.exitCode, { error: e, data: e.data });
    if (process.env.BEIMING_DEBUG) process.stderr.write(`${e.stack}\n`);
    return finish(EXIT.FAIL, { error: { code: 'failure.internal', message: `内部错误：${e.message}`, hint: process.env.BEIMING_DEBUG ? null : '设 BEIMING_DEBUG=1 重跑可看到堆栈' } });
  } finally {
    process.removeListener('SIGINT', hInt);
    process.removeListener('SIGTERM', hTerm);
  }
}
