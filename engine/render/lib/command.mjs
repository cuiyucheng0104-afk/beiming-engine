// 北冥引擎 · 渲染命令的外壳（still / video / shots / mux 共用）：在仓库命令约定库 tools/lib/cli.mjs（docs/CLI.md）之上，
// 补渲染器需要的三件事——收尾、日志与参数校验。命令的声明、严格解析、--help、--json 信封与退出码都交给 tools/lib/cli.mjs。
//
//   renderCommand(spec, main)   → defineCommand(...)：spec 与 defineCommand 相同（name、summary、usage、positionals、options、examples）；
//                                 main(c) 收到 c = { opts, args, ctx, log, life, signal, setRunJson }，返回 { outputs?, data? }；
//                                 抛 RenderError / CliError 表示可预期的失败：这里先收尾，再把错误连同 runJson、警告一起交回外壳
//                                 （信封里照样有 runJson），退出码由错误码前缀决定
//   Lifecycle                   一次运行的收尾：AbortController、子进程登记（中止时 SIGKILL）、异步关闭（浏览器、服务器）、
//                                 同步收尾（删临时目录、释放锁与槽位、补写失败的运行记录，按登记的逆序）。收到 SIGINT / SIGTERM 时
//                                 立刻中止并收尾，退出码 130 / 143（外壳负责）；SIGHUP 按 SIGTERM 处理；收尾时再按一次 Ctrl-C 立即退出。
//                                 进程退出（含异常）时同步杀掉还活着的子进程，不留残留。
//   renderLog(ctx, { progress })   stderr 日志：info（--quiet 时不打）、warn（同时收进信封与 run.json 的 warnings）、error、
//                                 progress（--progress ndjson 时 stderr 每行一个 JSON 事件，便于调度器解析；none 时不打）
//   parseSize / parseFrames / positiveNumber   参数取值的校验（用法错误 → usage.bad-value，退出码 2）
//   RENDER_OPTIONS              still / video / shots 共用的选项声明（tools/lib/cli.mjs 的写法）
//   pickOptions(names)          从 RENDER_OPTIONS 里挑几项
import { defineCommand } from '../../../tools/lib/cli.mjs';
import { RenderError, CliError, RENDER_EXIT_CODES, EXIT, describeError } from './errors.mjs';
import { GPU_POLICIES } from './gpu.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

// ───────────────────────── 参数取值 ─────────────────────────

const bad = (flag, what, raw, hint) => new RenderError('usage.bad-value', `${flag} ${what}（收到「${raw}」）`, { hint });

/** --size WxH：宽高为 16–8192 的偶数（H.264 yuv420p 的要求） */
export function parseSize(text, flag = '--size') {
  const m = /^(\d+)x(\d+)$/.exec(String(text).trim());
  const w = m && +m[1], h = m && +m[2];
  if (!m || [w, h].some(n => n < 16 || n > 8192 || n % 2)) {
    throw bad(flag, '要写成 宽x高，宽高都是 16–8192 的偶数', text, '例如 --size 1920x1080、--size 3840x2160、--size 1080x1920');
  }
  return { w, h };
}

/** --frames a:b（整数帧，含头不含尾，a < b）；allowStep 时还接受 a:b:step（step 为正整数） */
export function parseFrames(text, { flag = '--frames', allowStep = false } = {}) {
  const parts = String(text).trim().split(':');
  const ok = (allowStep ? [2, 3] : [2]).includes(parts.length) && parts.every(p => /^\d+$/.test(p.trim()));
  if (!ok) {
    throw bad(flag, `要写成 起:止${allowStep ? '[:步长]' : ''}（整数帧号，含起不含止）`, text,
      allowStep ? '例如 --frames 72:120（第 72–119 帧）或 --frames 0:240:24（每秒一帧）' : '例如 --frames 72:120 渲第 72–119 帧，共 48 帧');
  }
  const [a, b, step = 1] = parts.map(p => Number(p.trim()));
  if (!(b > a)) throw bad(flag, '的止必须大于起', text, '区间含起不含止：--frames 72:73 只渲第 72 帧');
  if (!(step >= 1)) throw bad(flag, '的步长必须是正整数', text);
  return { a, b, step };
}

/** 有限正数（--fps、超时秒数）；null / undefined 原样返回 */
export function positiveNumber(v, flag) {
  if (v === null || v === undefined) return v;
  if (!(Number.isFinite(v) && v > 0)) throw bad(flag, '必须大于 0', v);
  return v;
}

// ───────────────────────── 选项声明 ─────────────────────────

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
export const RENDER_OPTIONS = Object.freeze({
  profile: { type: 'string', arg: '<档位>', describe: '交付档位（engine/production/profiles.json，如 web-1080p24、vertical-1080x1920-30）：给出画幅与帧率' },
  size: { type: 'string', arg: 'WxH', describe: '画幅（偶数；默认按档位 / film.json，再默认 1920x1040）' },
  fps: { type: 'number', arg: '<n>', describe: '帧率（默认按档位 / film.json / 页面的 window.FPS，再默认 24）' },
  'any-fps': { type: 'boolean', describe: '帧率与页面声明的不一致也照渲（一拍二 / 一拍三的节奏可能不均）' },
  workers: { type: 'integer', min: 1, max: 32, default: 4, arg: '<n>', describe: '并行浏览器路数（默认 4；不影响成片内容）' },
  chunk: { type: 'integer', min: 1, max: 1000000, arg: '<帧数>', describe: '块长（默认按区间自动：总帧 / 8，夹在 1–10 秒）；改它会改变码流' },
  query: { type: 'string', default: '', arg: 'k=v&…', describe: '页面 URL 参数（例如 test=kun 渲 lab 自测页）' },
  fast: { type: 'boolean', describe: '用 JPEG 截图（预览：快、多一代有损）；默认无损 PNG' },
  crf: { type: 'integer', min: 0, max: 51, arg: '<n>', describe: '主输出的 x264 crf（默认按档位，再默认 14）' },
  preset: { type: 'string', choices: PRESETS, arg: '<名字>', describe: '主输出的 x264 preset（默认按档位，再默认 medium）' },
  gpu: { type: 'string', choices: [...GPU_POLICIES], arg: '<策略>', describe: 'required（默认，读 BEIMING_GPU）：软件渲染判失败 | any：允许并记提示 | software-ok：CI / 无 GPU 机器' },
  angle: { type: 'string', arg: '<后端>', describe: 'ANGLE 后端（默认 BEIMING_ANGLE，再默认 macOS metal / Windows vulkan / Linux default）' },
  'allow-network': { type: 'boolean', describe: '放行页面的外网请求（默认拦截并判失败；放行的地址记进运行记录）' },
  'lenient-assets': { type: 'boolean', describe: '非脚本类的本地 404 只记提示（页面自己有回退时用）' },
  'allow-gl-errors': { type: 'boolean', describe: '着色器错误只记提示（调试用，产物不能交付）' },
  'ready-timeout': { type: 'number', arg: '<秒>', describe: '等 window.READY 的上限（默认 BEIMING_READY_TIMEOUT，再默认 180）' },
  'frame-timeout': { type: 'number', arg: '<秒>', describe: '单帧 render(t) 的上限（默认 BEIMING_FRAME_TIMEOUT，再默认 120）' },
  settle: { type: 'string', choices: ['auto', 'none', 'raf2'], default: 'auto', arg: '<方式>', describe: 'render 后截图前：raf2 再等两帧（Vulkan 显示层残留的对策）；auto 只在 vulkan 时用 raf2' },
  progress: { type: 'string', choices: ['text', 'ndjson', 'none'], default: 'text', arg: '<格式>', describe: '进度：text（默认）| ndjson（stderr 每行一个 JSON 事件）| none' },
  slots: { type: 'integer', min: 1, max: 256, arg: '<n>', describe: '机器级渲染槽位（默认 RENDER_SLOTS；不设不限）' },
  'no-wait': { type: 'boolean', describe: '槽位满或共享 GPU 忙时不排队，直接退出码 5' },
  'wait-timeout': { type: 'number', arg: '<秒>', describe: '排队的上限（默认 1800 秒，超时退出码 124）' },
  'no-guard': { type: 'boolean', describe: '不查共享 GPU（nvidia-smi 占用 / ComfyUI 队列）' },
  'run-json': { type: 'string', arg: '<文件>', describe: '运行记录写到哪（默认见各命令）' },
});
export const pickOptions = names => Object.fromEntries(names.map(n => [n, RENDER_OPTIONS[n]]));

// ───────────────────────── 日志 ─────────────────────────

/** stderr 日志。warnings 收齐后由外壳放进信封；同一条警告只记一次 */
export function renderLog(ctx, { progress = 'text' } = {}) {
  const warnings = [];
  const ndjson = progress === 'ndjson';
  const write = s => { try { process.stderr.write(s); } catch {} };
  const event = obj => write(JSON.stringify(obj) + '\n');
  return {
    warnings,
    ndjson,
    info(message) {
      if (ctx.quiet) return;
      if (ndjson) event({ event: 'log', level: 'info', message }); else write(`${message}\n`);
    },
    warn(message, code = 'warning', hint = null) {
      if (warnings.some(w => w.code === code && w.message === message)) return;
      warnings.push({ code, message, hint });
      if (ndjson) event({ event: 'log', level: 'warn', code, message, hint });
      else write(`警告[${code}]：${message}\n${hint ? `提示：${hint}\n` : ''}`);
    },
    error(message) { if (ndjson) event({ event: 'log', level: 'error', message }); else write(`${message}\n`); },
    /** 进度：data = { done, total, … }；文本模式打 text */
    progress(data, text) {
      if (progress === 'none') return;
      if (ndjson) event({ event: 'progress', ...data });
      else if (text && !ctx.quiet) write(`${text}\n`);
    },
    event(obj) { if (ndjson) event(obj); },
  };
}

// ───────────────────────── 收尾 ─────────────────────────

/** 一次运行的收尾（见文件开头） */
export class Lifecycle {
  constructor(ctx, { log } = {}) {
    this.ac = new AbortController();
    this.signal = this.ac.signal;
    this.procs = new Set();
    this.closers = [];
    this.finals = [];
    this.down = null;
    this.log = log;
    const kill = () => { for (const p of this.procs) { try { p.kill('SIGKILL'); } catch {} } };
    this.killAll = kill;
    const onSignal = (sig, code) => () => {
      if (this.signalled) {
        // 收尾中又收到一次：立即杀掉子进程退出（外壳的处理器已摘掉，默认动作会直接结束进程，这里先把子进程带走）
        kill();
        process.exit(code);
      }
      this.signalled = sig;
      this.abort(new RenderError(code === EXIT.SIGINT ? 'signal.sigint' : 'signal.sigterm',
        `收到 ${sig}${sig === 'SIGHUP' ? '（终端断开，按 SIGTERM 处理）' : ''}：已停下渲染，关闭浏览器与 FFmpeg，删掉临时文件`, { hint: null }));
      log?.error(`\n收到 ${sig}：停下渲染，关闭浏览器与 FFmpeg，清理临时文件…${sig === 'SIGINT' ? '（再按一次 Ctrl-C 立即退出）' : ''}`);
      // SIGINT / SIGTERM 由命令约定库收尾并以 130 / 143 退出；SIGHUP 它不管：这里中止后，run 带着 signal.sigterm 的错误返回，
      // 外壳照常输出信封、以 143 退出（不向自己再发 SIGTERM——Windows 上那会直接结束进程，跳过收尾）
      void this.teardown();
    };
    this.handlers = [['SIGINT', EXIT.SIGINT], ['SIGTERM', EXIT.SIGTERM], ['SIGHUP', EXIT.SIGTERM]].map(([s, c]) => [s, onSignal(s, c)]);
    for (const [s, h] of this.handlers) process.on(s, h);
    process.on('exit', kill);
    this.undoExit = () => process.removeListener('exit', kill);
    // 外壳在收到信号、或 run 抛错时执行登记的清理：这里就是整套收尾
    this.undoCleanup = ctx.onCleanup(() => this.teardown());
  }

  abort(reason) { if (!this.signal.aborted) this.ac.abort(reason); }
  /** 登记子进程：中止时 SIGKILL；进程退出时自动注销 */
  track(proc) {
    this.procs.add(proc);
    const off = () => this.procs.delete(proc);
    proc.once('close', off); proc.once('error', off);
    return proc;
  }
  /** 异步关闭（浏览器、服务器）：收尾时并行执行，每个最多等 5 秒 */
  closer(fn) { this.closers.push(fn); return () => { const i = this.closers.indexOf(fn); if (i >= 0) this.closers.splice(i, 1); }; }
  /** 同步收尾（删临时目录、释放锁、补写记录）：按登记的逆序执行一次 */
  defer(fn) { this.finals.push(fn); return () => { const i = this.finals.indexOf(fn); if (i >= 0) this.finals.splice(i, 1); }; }

  /** 收尾（幂等）：先中止，杀子进程，关浏览器，再按逆序执行同步收尾 */
  teardown(reason) {
    if (reason) this.abort(reason);
    if (this.down) return this.down;
    this.down = (async () => {
      this.killAll();
      const closers = this.closers.splice(0);
      await Promise.all(closers.map(fn => Promise.race([Promise.resolve().then(fn).catch(() => {}), sleep(5000)])));
      this.killAll();
      for (const fn of this.finals.splice(0).reverse()) {
        try { await fn(); } catch (e) { this.log?.warn(`收尾时出错：${e?.message ?? e}`, 'cleanup'); }
      }
    })();
    return this.down;
  }

  dispose() {
    for (const [s, h] of this.handlers) process.removeListener(s, h);
    this.undoCleanup();
    // 进程退出钩子留到真正退出：万一还有子进程没收走，退出时一并杀掉
  }
}

/** run 返回后还被别的句柄拖住时，3 秒后按已定的退出码强制退出（定时器 unref，不拖住正常退出） */
export function exitSoon() {
  sleep(3000).then(() => process.exit(process.exitCode ?? 0));
}

// ───────────────────────── 命令外壳 ─────────────────────────

/**
 * 渲染命令：声明交给 defineCommand，执行时建 Lifecycle 与日志，收尾后交回结果。
 * @param {object} spec  defineCommand 的声明（不含 run）；exitCodes 默认 RENDER_EXIT_CODES
 * @param {(c: object) => Promise<{outputs?: object[], data?: object}>} main
 */
export function renderCommand(spec, main) {
  return defineCommand({
    exitCodes: RENDER_EXIT_CODES,
    ...spec,
    async run(ctx) {
      const log = renderLog(ctx, { progress: ctx.opts.progress ?? 'text' });
      const life = new Lifecycle(ctx, { log });
      let runJson = null;
      try {
        const r = (await main({ opts: ctx.opts, args: ctx.args, ctx, log, life, signal: life.signal, setRunJson: p => { runJson = p; } })) ?? {};
        if (life.signal.aborted) throw life.signal.reason;
        await life.teardown();
        return { data: r.data ?? null, outputs: r.outputs ?? [], runJson, warnings: log.warnings };
      } catch (e) {
        const reason = life.signal.aborted && life.signal.reason instanceof CliError ? life.signal.reason : e;
        await life.teardown(reason instanceof Error ? reason : undefined);
        if (!(reason instanceof CliError) && !Number.isInteger(reason?.exitCode) && process.env.BEIMING_DEBUG && reason?.stack) process.stderr.write(`${reason.stack}\n`);
        const err = describeError(reason);
        return { exitCode: err.exitCode, error: { code: err.code, message: err.message, hint: err.hint }, data: reason?.data ?? null, runJson, warnings: log.warnings };
      } finally {
        life.dispose();
        exitSoon();
      }
    },
  });
}
