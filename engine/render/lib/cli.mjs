// 北冥引擎 · 渲染器命令行约定（still / video / shots / serve / mux / gpucheck 共用）：退出码、错误、参数、--help、--json 信封、日志、信号。
// 约定见 engine/render/README.md「命令约定」，与加固计划附录 C1（退出码）、C2（--json 信封）一致。
//
//   EXIT                       退出码：0 成功 · 1 运行失败 · 2 用法错误 · 3 环境或依赖不合格 · 4 契约/规格/验收不通过 ·
//                              5 资源忙（输出锁、渲染槽位、共享 GPU）· 124 超时 · 129/130/143 收到 SIGHUP/SIGINT/SIGTERM（已清理）
//   RenderError(code, message, { exitCode, hint })   可预期的失败：code 是稳定的英文标识（写进 --json 与 run.json），
//                              message 说清原因，hint 说下一步怎么做
//   UsageError(message, hint)  用法错误（退出码 2）
//   parseArgs(argv, spec)      严格解析：不认识的选项、缺值、类型不对、位置参数个数不对都抛 UsageError；同一选项写两次以后一次为准
//                              （npm run x -- --out y 会追加到脚本自带的参数后面）；支持 --k v 与 --k=v，-- 之后都算位置参数
//   helpText(spec)             --help 的文字（写到 stdout，不产生任何副作用）
//   runCli(spec, main)         命令外壳：解析参数 → --help → main({ opts, args, log, signal, cleanup, emit, … }) → 统一出错与退出码；
//                              长时间运行的命令（serve）用 emit(extra) 一启动就发信封，结束时不再发第二个；
//                              --json 时 stdout 只输出一个信封对象 { ok, exitCode, command, error, outputs, runJson, warnings }，
//                              人看的日志一律走 stderr；收到信号时先中止 signal、等 main 收尾，再以 130/143/129 退出
//   createLog({ ndjson })      stderr 日志：info / warn（同时收进 warnings）/ progress；--progress ndjson 时每行一个 JSON 事件
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });

/** 退出码表（README 与 repo-check 规则 render.exit-table 据此核对，改这里要同步改 README）。 */
export const EXIT_TABLE = Object.freeze([
  [EXIT.OK, '成功'],
  [EXIT.FAIL, '运行失败：页面报错、render 抛错、着色器编译失败、WebGL 上下文丢失、缺素材、FFmpeg 出错'],
  [EXIT.USAGE, '用法错误：不认识的选项、缺值、取值不合法、找不到影片目录'],
  [EXIT.ENV, '环境或依赖不合格：要求 GPU 却落到软件渲染、没有 WebGL、缺 FFmpeg / 浏览器、磁盘不够'],
  [EXIT.CONTRACT, '契约或验收不通过：页面约定（DUR / render / READY / FPS）、帧数或规格不符、响度不达标'],
  [EXIT.BUSY, '资源忙：同一输出正在被另一次渲染写、渲染槽位已满、共享 GPU 正忙'],
  [EXIT.TIMEOUT, '超时：等 READY、单帧 render(t)、等槽位'],
  [EXIT.SIGINT, '收到 SIGINT（Ctrl-C），已停下并清理'],
  [EXIT.SIGTERM, '收到 SIGTERM，已停下并清理'],
]);

export class RenderError extends Error {
  /**
   * @param {string} code 稳定标识，例如 'page-error'、'software-gl'、'contract-dur'
   * @param {string} message 中文：出了什么事
   * @param {{ exitCode?: number, hint?: string|null, detail?: unknown }} [o]
   */
  constructor(code, message, { exitCode = EXIT.FAIL, hint = null, detail } = {}) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
    if (detail !== undefined) this.detail = detail;
  }
}

export class UsageError extends RenderError {
  constructor(message, hint = null) {
    super('usage', message, { exitCode: EXIT.USAGE, hint });
    this.name = 'UsageError';
  }
}

/** 任意异常 → { code, message, hint, exitCode }（信封与 run.json 用） */
export function describeError(e) {
  if (e instanceof RenderError) return { code: e.code, message: e.message, hint: e.hint ?? null, exitCode: e.exitCode };
  // 别处定义的同类错误（例如 engine/render/args.mjs 的 UsageError）：有数字退出码就照用
  if (e && Number.isInteger(e.exitCode)) return { code: e.code ?? (e.name === 'UsageError' ? 'usage' : 'error'), message: String(e.message), hint: e.hint ?? null, exitCode: e.exitCode };
  const message = String(e?.message ?? e).split('\n')[0];
  return { code: 'internal', message: `内部错误：${message}`, hint: '这是渲染器自身的问题：带上完整日志与命令行报告', exitCode: EXIT.FAIL };
}

// ── 参数 ──

const SIZE = /^(\d+)x(\d+)$/;
/** --size WxH：宽高为 16–8192 的偶数（H.264 yuv420p 的要求） */
export function parseSize(text, name = '--size') {
  const m = SIZE.exec(String(text).trim());
  const w = m && +m[1], h = m && +m[2];
  if (!m || [w, h].some(n => n < 16 || n > 8192 || n % 2)) {
    throw new UsageError(`${name} 要写成 宽x高，宽高都是 16–8192 的偶数（收到 ${text}）`, '例如 --size 1920x1080、--size 3840x2160、--size 1080x1920');
  }
  return { w, h };
}

/** --frames a:b（整数帧，含头不含尾，a < b）；allowStep 时还接受 a:b:step（step 为正整数） */
export function parseFrames(text, { name = '--frames', allowStep = false } = {}) {
  const parts = String(text).trim().split(':');
  const ok = (allowStep ? [2, 3] : [2]).includes(parts.length) && parts.every(p => /^\d+$/.test(p.trim()));
  if (!ok) {
    throw new UsageError(`${name} 要写成 起:止${allowStep ? '[:步长]' : ''}（整数帧号，含起不含止），收到 ${text}`,
      allowStep ? '例如 --frames 72:120（第 72–119 帧）或 --frames 0:240:24（每秒一帧）' : '例如 --frames 72:120 渲第 72–119 帧，共 48 帧');
  }
  const [a, b, step = 1] = parts.map(p => Number(p.trim()));
  if (!(b > a)) throw new UsageError(`${name} 的止必须大于起（收到 ${text}）`, '区间含起不含止：--frames 72:73 只渲第 72 帧');
  if (!(step >= 1)) throw new UsageError(`${name} 的步长必须是正整数（收到 ${text}）`);
  return { a, b, step };
}

function convert(name, def, raw) {
  const s = String(raw).trim();
  const bad = (what, hint) => new UsageError(`${name} ${what}（收到 ${raw}）`, hint ?? def.hint ?? null);
  switch (def.type) {
    case 'string': return s;
    case 'int': {
      if (!/^-?\d+$/.test(s)) throw bad('必须是整数');
      const v = Number(s);
      if (def.min !== undefined && v < def.min) throw bad(`不能小于 ${def.min}`);
      if (def.max !== undefined && v > def.max) throw bad(`不能大于 ${def.max}`);
      return v;
    }
    case 'number': {
      const v = s === '' ? NaN : Number(s);
      if (!Number.isFinite(v)) throw bad('必须是有限的数');
      if (def.min !== undefined && v < def.min) throw bad(`不能小于 ${def.min}`);
      if (def.positive && !(v > 0)) throw bad('必须大于 0');
      return v;
    }
    case 'enum':
      if (!def.choices.includes(s)) throw bad(`只能是 ${def.choices.join(' | ')}`);
      return s;
    case 'size': return parseSize(s, name);
    case 'frames': return parseFrames(s, { name, allowStep: def.allowStep });
    case 'list': {
      const items = s.split(',').map(x => x.trim()).filter(Boolean);
      if (!items.length) throw bad('至少要写一项（逗号分隔）');
      return items;
    }
    default: throw new Error(`参数类型未定义：${def.type}`);
  }
}

/**
 * @param {string[]} argv
 * @param {{ options: Record<string, any>, positionals?: { min?: number, max?: number } }} spec
 *   options：'--名字': { type: 'flag'|'string'|'int'|'number'|'enum'|'size'|'frames'|'list', … }；'-h' 与 '--help' 自动支持
 * @returns {{ opts: Record<string, any>, args: string[], help: boolean, explicit: Set<string> }}
 */
export function parseArgs(argv, spec) {
  const opts = {}, args = [], explicit = new Set();
  const names = Object.keys(spec.options);
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (!a.startsWith('-') || a === '-' || /^-\d/.test(a)) { args.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const def = spec.options[name];
    if (!def) {
      const near = names.filter(n => n.replace(/^--/, '').startsWith(name.replace(/^--?/, '').slice(0, 3)));
      throw new UsageError(`不认识的选项 ${name}`, near.length ? `是不是 ${near.join(' / ')}？完整列表见 --help` : '完整列表见 --help');
    }
    if (def.type === 'flag') {
      if (eq > 0) throw new UsageError(`${name} 是开关，不带取值（收到 ${a}）`);
      opts[def.key ?? name] = true; explicit.add(name);
      continue;
    }
    let v;
    if (eq > 0) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new UsageError(`选项 ${name} 缺少取值`, def.hint ?? null);
      i++;
    }
    opts[def.key ?? name] = convert(name, def, v);
    explicit.add(name);
  }
  if (!help) {
    const { min = 0, max = Infinity } = spec.positionals ?? {};
    if (args.length < min) throw new UsageError(`缺少参数：${spec.positionals?.names?.slice(args.length).join('、') || '位置参数'}`, '用法见 --help');
    if (args.length > max) throw new UsageError(`多余的参数：${args.slice(max).join(' ')}`, '选项要以 -- 开头；完整列表见 --help');
  }
  for (const [name, def] of Object.entries(spec.options)) {
    const k = def.key ?? name;
    if (opts[k] === undefined && def.default !== undefined) opts[k] = def.default;
  }
  return { opts, args, help, explicit };
}

/** --help 的文字：用法、说明、选项、退出码、例子 */
export function helpText(spec) {
  const lines = [`用法：${spec.usage}`, ''];
  if (spec.summary) lines.push(...[].concat(spec.summary), '');
  const rows = Object.entries(spec.options).filter(([, d]) => !d.hidden);
  if (rows.length) {
    lines.push('选项：');
    const width = Math.min(28, Math.max(...rows.map(([n, d]) => (n + (d.arg ? ' ' + d.arg : '')).length)));
    for (const [n, d] of rows) {
      const left = n + (d.arg ? ' ' + d.arg : '');
      lines.push(`  ${left.padEnd(width)}  ${d.desc ?? ''}`);
    }
    lines.push(`  ${'-h, --help'.padEnd(width)}  打印本说明并退出（不渲染、不写文件）`, '');
  }
  if (spec.examples?.length) lines.push('例子：', ...spec.examples.map(e => `  ${e}`), '');
  lines.push('退出码：' + EXIT_TABLE.map(([c, d]) => `${c} ${d.split('：')[0]}`).join(' · '));
  lines.push('详见 engine/render/README.md');
  return lines.join('\n') + '\n';
}

// ── 日志 ──

/** 人看的日志都写 stderr；ndjson 模式下每行一个 JSON 事件（{event:'log'|'progress'|…}），便于调度器解析 */
export function createLog({ ndjson = false, quiet = false } = {}) {
  const warnings = [];
  const write = obj => process.stderr.write(JSON.stringify(obj) + '\n');
  const log = {
    warnings,
    ndjson,
    info(message) {
      if (quiet) return;
      if (ndjson) write({ event: 'log', level: 'info', message });
      else process.stderr.write(message + '\n');
    },
    warn(message, code = 'warning') {
      warnings.push({ code, message });
      if (ndjson) write({ event: 'log', level: 'warn', code, message });
      else process.stderr.write(`[提示] ${message}\n`);
    },
    error(message) {
      if (ndjson) write({ event: 'log', level: 'error', message });
      else process.stderr.write(message + '\n');
    },
    /** 进度：{ done, total, etaSec, … }；文本模式下由调用方给出 text */
    progress(data, text) {
      if (ndjson) write({ event: 'progress', ...data });
      else if (text && !quiet) process.stderr.write(text + '\n');
    },
    event(obj) { if (ndjson) write(obj); },
  };
  return log;
}

// ── 命令外壳 ──

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

/** 仓库根（engine/render/lib 往上三级），只用于把路径写成相对仓库的形式 */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 统一的命令外壳。main 返回 { outputs?, runJson?, extra? }；抛 RenderError 表示可预期的失败。
 * main 收到 ctx.cleanup(fn)：登记收尾函数（出错、收到信号、正常结束都会按登记的逆序执行一次）。
 * @param {object} spec  parseArgs 的 spec 再加 { command, usage, summary, examples }
 * @param {(c: {opts, args, explicit, log, signal, cleanup, setRunJson}) => Promise<any>} main
 */
export async function runCli(spec, main, argv = process.argv.slice(2)) {
  let parsed;
  const jsonMode = argv.includes('--json');
  const ndjson = argv.some((a, i) => a === '--progress=ndjson' || (a === '--progress' && argv[i + 1] === 'ndjson'));
  const log = createLog({ ndjson });
  let emitted = false;   // 长时间运行的命令已经先发过信封：结束时不再发第二个（stdout 始终只有一个对象）
  const envelope = (exitCode, error, result = {}) => ({
    ok: exitCode === 0, exitCode, command: spec.command, error,
    outputs: result.outputs ?? [], runJson: result.runJson ?? null, warnings: log.warnings, ...(result.extra ?? {}),
  });
  const finish = (exitCode, error, result) => {
    if (jsonMode && !emitted) process.stdout.write(JSON.stringify(envelope(exitCode, error, result)) + '\n');
    else if (error) {
      log.error(`失败（${error.code}，退出码 ${exitCode}）：${error.message}`);
      if (error.hint) log.error(`  下一步：${error.hint}`);
    }
    process.exitCode = exitCode;
    // 正常情况下所有句柄都已关闭、进程自然退出；万一还有东西挂着，3 秒后强制退出（定时器 unref，不拖住正常退出）
    sleep(3000).then(() => process.exit(exitCode));
  };
  try {
    parsed = parseArgs(argv, spec);
  } catch (e) {
    const d = describeError(e);
    if (!jsonMode) process.stderr.write(`${d.message}\n${d.hint ? `  ${d.hint}\n` : ''}用法：${spec.usage}\n`);
    return finish(d.exitCode, jsonMode ? { code: d.code, message: d.message, hint: d.hint } : null, {});
  }
  if (parsed.help) { process.stdout.write(helpText(spec)); process.exitCode = 0; return; }

  const ac = new AbortController();
  const cleanups = [];
  let cleaned = false;
  const runCleanups = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { log.warn(`收尾时出错：${e?.message ?? e}`, 'cleanup'); } }
  };
  let signalCode = 0;
  const onSignal = (sig, code) => () => {
    if (signalCode) { process.exit(signalCode); }   // 第二次信号：立即退出（同步收尾已在 exit 钩子里）
    signalCode = code;
    log.error(`\n收到 ${sig}：停下手头的工作并收尾（关浏览器与 FFmpeg、删临时文件、释放锁）…再按一次 Ctrl-C 立即退出`);
    ac.abort(new RenderError(sig === 'SIGINT' ? 'sigint' : sig === 'SIGTERM' ? 'sigterm' : 'sighup', `收到 ${sig}，已中止`, { exitCode: code }));
    sleep(20000).then(() => process.exit(code));   // 收尾卡住时的兜底
  };
  const handlers = [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM], ['SIGHUP', EXIT.SIGHUP]].map(([s, c]) => [s, onSignal(s, c)]);
  for (const [s, h] of handlers) process.on(s, h);
  let runJson = null;
  let result = {}, error = null, exitCode = 0;
  try {
    result = (await main({
      opts: parsed.opts, args: parsed.args, explicit: parsed.explicit, log, signal: ac.signal, json: jsonMode,
      cleanup: fn => cleanups.push(fn), setRunJson: p => { runJson = p; },
      emit: extra => { if (jsonMode && !emitted) { emitted = true; process.stdout.write(JSON.stringify(envelope(0, null, { extra })) + '\n'); } },
    })) ?? {};
    if (signalCode) throw ac.signal.reason;
  } catch (e) {
    const reason = signalCode ? ac.signal.reason : e;
    const d = describeError(reason);
    error = { code: d.code, message: d.message, hint: d.hint };
    if (reason?.extra) result = { ...result, extra: reason.extra };   // 失败时也带上已经测到的东西（例如 gpucheck 的逐后端结果）
    exitCode = signalCode || d.exitCode;
    if (d.code === 'internal' && !jsonMode) process.stderr.write(`${e?.stack ?? e}\n`);
  } finally {
    await runCleanups();
  }
  result.runJson ??= runJson;
  return finish(exitCode, error, result);
}
