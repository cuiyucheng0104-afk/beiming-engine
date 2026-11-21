#!/usr/bin/env node
// 北冥引擎 · 离屏出片 · 命令行：在 Node + Dawn 里渲作品模块（视频 render、无损静帧 stills、契约只读探测 probe）。
//   node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size 1920x1080] [--fps 24] [--inflight 3]
//                                       [--mode pro|fast] [--encoder auto|x264|nvenc] [--crf 14] [--preset medium] [--cq 7] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs stills <作品.mjs> --out <目录> --frames 0,48,96|a:b[:step] [--size 1920x1080] [--fps 24] [--inflight 3] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs probe  <作品.mjs> [--size 1920x1080] [--fps 24] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs profile <作品.mjs> --frames 0,48,96|a:b[:step] [--size 1920x1080] [--fps 24] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs daemon  [--socket <路径>] [--idle-timeout 600] [--max-cached-works 4] [--action start|status|stop] [--json]
// 退出码：0 · 1 渲染或编码失败 · 2 用法错误 · 3 缺可选依赖（webgpu、three-webgpu）· 4 契约或成片帧数不符 · 5 资源忙。
// 计时用 process.hrtime（这个文件在确定性扫描的范围里，渲染路径之外也不用 performance.now）。
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli, usageError } from '../../tools/lib/cli.mjs';
import { loadGpu } from './load.mjs';
import { createHost } from './host.mjs';
import { ENCODER_CHOICES, MASTER_CQ, MODES, resolveEncodeAsync } from './encode.mjs';
import { parseBatchJobs, runBatch } from './batch.mjs';
import { createDaemonServer, defaultSocketPath, executeOffscreenJob, resolveDaemonTarget, sendDaemonRequest } from './daemon.mjs';

// --socket：命名管道原样用，文件路径按当前目录解析
const socketArg = (s, cwd = process.cwd()) => (s.startsWith('\\\\.\\pipe\\') ? s : path.resolve(cwd, s));
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));

/** 解析静帧列表（支持 0,48,96 与 a:b[:step] 混写，按出现顺序去重） */
export function parseFrameList(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw usageError('missing-frames', 'stills 需要 --frames <帧列表或区间>', '例如 --frames 0,48,96 或 --frames 0:24');
  const seen = new Set(), out = [];
  for (const tok of raw.split(',')) {
    const s = tok.trim();
    if (/^\d+$/.test(s)) {
      const f = +s;
      if (!seen.has(f)) { seen.add(f); out.push(f); }
      continue;
    }
    const rm = /^(\d+):(\d+)(?::(\d+))?$/.exec(s);
    if (rm) {
      const a = +rm[1], b = +rm[2], step = rm[3] ? +rm[3] : 1;
      if (b <= a || step < 1) throw usageError('bad-value', `--frames 区间要满足 止 > 起 且步长 ≥ 1，收到「${s}」`, '例如 --frames 0:24 或 0:96:24');
      for (let f = a; f < b; f += step) if (!seen.has(f)) { seen.add(f); out.push(f); }
      continue;
    }
    throw usageError('bad-value', `--frames 格式不合法：收到「${spec}」`, '例如 --frames 0,48,96 或 --frames 0:24');
  }
  if (!out.length) throw usageError('bad-value', `--frames 为空：收到「${spec}」`, '例如 --frames 0,48,96');
  return out;
}

/** 校验参数（只读文件系统，不执行作品）；返回解析好的值，有问题抛用法错误 */
export function resolveArgs({ sub, work, extra = [] }, opts, cwd = process.cwd()) {
  if (!['render', 'stills', 'probe', 'profile', 'batch', 'daemon'].includes(sub)) throw usageError('bad-subcommand', `未知子命令 ${sub}`, '可用：render、stills、probe、profile、batch、daemon');
  if (sub === 'daemon') {
    const items = [work, ...extra].filter(Boolean);
    if (items.length) throw usageError('extra-argument', `daemon 不接受多余位置参数：${items.map(x => `「${x}」`).join(' ')}`, '用法：node engine/offscreen/cli.mjs daemon [--socket <路径>] [--idle-timeout 600] [--max-cached-works 4] [--action start|status|stop]');
    const action = opts.action || 'start';
    if (!['start', 'status', 'stop'].includes(action)) throw usageError('bad-value', `--action 只能是 start、status 或 stop，收到「${action}」`, null);
    const idleTimeout = opts['idle-timeout'] ?? 600;
    if (!(idleTimeout >= 0)) throw usageError('bad-value', `--idle-timeout 要 ≥ 0，收到 ${idleTimeout}`, '0 表示永不超时');
    const maxCachedWorks = opts['max-cached-works'] ?? 4;
    if (!(maxCachedWorks >= 0)) throw usageError('bad-value', `--max-cached-works 要 ≥ 0，收到 ${maxCachedWorks}`, null);
    const socket = opts.socket ? socketArg(opts.socket, cwd) : defaultSocketPath();
    return { sub: 'daemon', action, socket, idleTimeout, maxCachedWorks };
  }
  if (sub === 'batch') {
    const items = [work, ...extra].filter(Boolean);
    if (!items.length) throw usageError('missing-work', 'batch 需要 <清单.json> 或至少一个 <作品.mjs>', '例如 offscreen batch jobs.json，或 offscreen batch a.mjs b.mjs --out-dir out/batch --frames 0:48');
    const defaults = {
      size: opts.size, fps: opts.fps, inflight: opts.inflight, query: opts.query,
      frames: opts.frames, encoder: opts.encoder, encodeMode: opts.mode, pixFmt: opts['pix-fmt'], crf: opts.crf, cq: opts.cq, preset: opts.preset,
    };
    if (items.length === 1 && items[0].toLowerCase().endsWith('.json')) {
      const mf = path.resolve(cwd, items[0]);
      if (!fs.existsSync(mf)) throw usageError('manifest-not-found', `找不到批量清单：${items[0]}`, null);
      let raw;
      try { raw = JSON.parse(fs.readFileSync(mf, 'utf8')); }
      catch (e) { throw usageError('bad-manifest', `批量清单不是合法 JSON：${e.message}`, null); }
      return { sub: 'batch', jobs: parseBatchJobs(raw, { cwd, manifestDir: path.dirname(mf), defaults }) };
    }
    if (!opts['out-dir']) throw usageError('missing-out', '多作品直接调用 batch 需要 --out-dir <输出目录>', '或把每项的 out 写进清单 JSON');
    const outDir = path.resolve(cwd, opts['out-dir']);
    const stems = items.map(w => {
      const base = path.basename(w, path.extname(w));
      return base === 'offscreen' ? path.basename(path.dirname(path.resolve(cwd, w))) || base : base;
    });
    const counts = new Map();
    for (const s of stems) counts.set(s, (counts.get(s) || 0) + 1);
    const seq = new Map();
    const specs = items.map((w, idx) => {
      const s = stems[idx];
      const n = (seq.get(s) || 0) + 1;
      seq.set(s, n);
      const name = counts.get(s) > 1 ? `${s}-${n}` : s;
      return { id: name, mode: 'render', work: w, out: path.join(outDir, `${name}.mp4`) };
    });
    return { sub: 'batch', jobs: parseBatchJobs(specs, { cwd, defaults }) };
  }
  if (extra.length) throw usageError('extra-argument', `多余的参数：${extra.map(x => `「${x}」`).join(' ')}`, `用法：node engine/offscreen/cli.mjs ${sub} <作品.mjs> [选项]`);
  if (!work) throw usageError('missing-work', `${sub} 需要 <作品.mjs>`, '例如 lab/offscreen/ink.mjs');
  const [width, height] = parseSize(opts.size);
  if (!(opts.fps >= 1)) throw usageError('bad-value', `--fps 要 ≥ 1，收到 ${opts.fps}`, null);
  if (!(opts.inflight >= 1)) throw usageError('bad-value', `--inflight 要 ≥ 1，收到 ${opts.inflight}`, null);
  const file = resolveWork(work, cwd);
  if (sub === 'probe') return { sub, file, width, height, fps: opts.fps, inflight: opts.inflight };
  if (sub === 'profile') {
    if (!opts.frames) throw usageError('missing-frames', 'profile 需要 --frames <帧列表或区间>', '例如 --frames 0,48,96（不同镜头各取几帧）');
    return { sub, file, frameList: parseFrameList(opts.frames), width, height, fps: opts.fps };
  }
  if (!opts.out) throw usageError('missing-out', `${sub} 需要 --out ${sub === 'render' ? '<文件.mp4>' : '<目录>'}`, null);
  const out = path.resolve(cwd, opts.out);
  if (sub === 'stills') {
    if (!opts.frames) throw usageError('missing-frames', 'stills 需要 --frames <帧列表或区间>', '例如 --frames 0,48,96');
    return { sub, file, out, frameList: parseFrameList(opts.frames), width, height, fps: opts.fps, inflight: opts.inflight };
  }
  if (!opts.frames) throw usageError('missing-frames', 'render 需要 --frames a:b（含 a 不含 b 的整数帧号）', '例如 --frames 0:96');
  const fm = /^(\d+):(\d+)$/.exec(opts.frames);
  if (!fm || +fm[2] <= +fm[1]) throw usageError('bad-value', `--frames 要写成 a:b，且止必须大于起，收到「${opts.frames}」`, '例如 --frames 0:96');
  return { sub, file, out, from: +fm[1], to: +fm[2], width, height, fps: opts.fps, inflight: opts.inflight };
}

/** 作品模块的真实路径（解析符号链接）；不存在 → usage.work-not-found，不在仓库里 → usage.work-outside-repo。只读，不执行作品 */
export function resolveWork(work, cwd = process.cwd()) {
  let file;
  try { file = fs.realpathSync(path.resolve(cwd, work)); } catch { throw usageError('work-not-found', `找不到作品模块：${work}`, '路径相对当前目录；演示作品是 lab/offscreen/ink.mjs'); }
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw usageError('work-outside-repo', `作品模块不在仓库里：${file}（解析符号链接之后）`, '离屏出片只执行仓库里的作品；把它放进 films/<名字>/ 或 lab/offscreen/');
  return file;
}

/** --size WxH → [w, h]：都是 ≥ 16 的偶数（yuv420p 的要求），否则 usage.bad-value */
export function parseSize(size) {
  const sm = /^(\d+)x(\d+)$/.exec(size ?? '');
  if (!sm || +sm[1] % 2 || +sm[2] % 2 || +sm[1] < 16 || +sm[2] < 16) throw usageError('bad-value', `--size 要写成 WxH，宽高都是 ≥ 16 的偶数（yuv420p 的要求），收到「${size}」`, '例如 --size 1920x1080');
  return [+sm[1], +sm[2]];
}

export const command = defineCommand({
  name: 'offscreen',
  summary: '离屏出片：在 Node + Dawn 里渲作品模块，不经过浏览器（视频 render、静帧 stills、探测 probe、GPU 分段计时 profile、单卡并发 batch、常驻守护进程 daemon）',
  usage: [
    'node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size WxH] [--fps 24] [--inflight 3] [--mode pro|fast] [--encoder auto|x264|nvenc] [--pix-fmt rgba|yuv420p] [--crf 14] [--preset medium] [--cq 7] [--query k=v&…] [--daemon off|auto|on|<socket>] [--json]',
    'node engine/offscreen/cli.mjs stills <作品.mjs> --out <目录> --frames 0,48,96|a:b[:step] [--size WxH] [--fps 24] [--inflight 3] [--query k=v&…] [--daemon off|auto|on|<socket>] [--json]',
    'node engine/offscreen/cli.mjs probe  <作品.mjs> [--size WxH] [--fps 24] [--query k=v&…] [--daemon off|auto|on|<socket>] [--json]',
    'node engine/offscreen/cli.mjs profile <作品.mjs> --frames 0,48,96|a:b[:step] [--size WxH] [--fps 24] [--query k=v&…] [--daemon off|auto|on|<socket>] [--json]',
    'node engine/offscreen/cli.mjs batch  <清单.json | 作品.mjs…> [--out-dir <目录>] [--concurrency 4] [--max-encoders 4] [--fail-fast] [--json]',
    'node engine/offscreen/cli.mjs daemon [--socket <路径>] [--idle-timeout 600] [--max-cached-works 4] [--action start|status|stop] [--json]',
  ],
  description: [
    '  offscreen render <作品.mjs>：逐帧流水线渲染并经 FFmpeg 编成有限范围 BT.709 的 H.264',
    '  offscreen stills <作品.mjs>：按帧号列表输出无损 PNG（f000048.png），不依赖 FFmpeg',
    '  offscreen probe  <作品.mjs>：只读校验作品 build(ctx) 契约与 GPU 适配器，不渲帧、不写盘',
    '  offscreen profile <作品.mjs>：GPU 时间戳把每帧切成主场景、墨线各遍、雾、辉光、调色、Kuwahara、纸纹、合成等段，报各段中位数与占比；先把这些帧整遍渲一次预热，计时不含读回，不写盘',
    '  offscreen batch  <清单.json | 作品.mjs…>：单进程共用一个 GPUDevice 并发调度多作业（含编码限流与故障隔离）',
    '  offscreen daemon：启动或管理常驻渲染守护进程（本机 IPC：类 Unix 为私有 0700 目录里的 0600 socket，Windows 为命名管道且只有系统默认访问控制；复用 GPUDevice 与作品缓存，客户端用 --daemon 显式接入；改了 engine/ 要重启守护进程）',
    '  需要可选依赖 webgpu 与 three-webgpu（npm install --include=optional --ignore-scripts）',
  ],
  positionals: [
    { name: 'sub', label: '<render|stills|probe|profile|batch|daemon>', describe: '子命令', required: true },
    { name: 'work', label: '<作品.mjs | 清单.json>', describe: '作品模块（仓库内）或批量清单', required: false },
    { name: 'extra', label: '[更多作品…]', describe: 'batch 模式下直接列出多个作品模块', required: false, variadic: true },
  ],
  options: {
    out: { type: 'string', arg: '<路径>', describe: 'render 输出文件（.mp4）或 stills 输出目录' },
    'out-dir': { type: 'string', arg: '<目录>', describe: 'batch 多作品模式下的输出目录' },
    'events-out': { type: 'string', arg: '<目录>', describe: 'probe 时把模块导出的 EV / TIMELINE 写成 events.json 与 timeline.json' },
    frames: { type: 'string', arg: '<帧>', describe: 'render/batch 用 a:b；stills、profile 用 0,48,96 或 a:b[:step]' },
    size: { type: 'string', arg: '<WxH>', default: '1920x1080', describe: '画幅（偶数，默认 1920x1080）' },
    fps: { type: 'integer', default: 24, arg: '<n>', describe: '帧率（默认 24）' },
    inflight: { type: 'integer', default: 3, arg: '<n>', describe: '同时在途的读回帧数（默认 3；不改变成片）' },
    concurrency: { type: 'integer', default: 4, arg: '<n>', describe: 'batch 同时并发的渲染作业数（默认 4，共用一个 GPUDevice）' },
    'max-encoders': { type: 'integer', default: 4, arg: '<n>', describe: 'batch 同时打开的 FFmpeg / NVENC 编码会话上限（默认 4）' },
    'fail-fast': { type: 'boolean', describe: 'batch 遇到首个失败作业后不再启动后续作业' },
    mode: { type: 'string', default: 'pro', choices: MODES, arg: '<档>', describe: '离屏母版编码档（默认 pro）：pro 为 x264 High + rgba 读回，终渲交付、跨机器确定；fast 为 NVENC 预览档（High、cq 7、合规 bufsize），无 NVENC 或小画幅时退回 pro' },
    encoder: { type: 'string', default: 'auto', choices: ENCODER_CHOICES, arg: '<名字>', describe: '编码器（默认 auto：跟随 --mode；可显式指定 x264 或 nvenc。显式 nvenc 缺卡时不回退，由 FFmpeg 报错）' },
    'pix-fmt': { type: 'string', choices: ['rgba', 'yuv420p'], arg: '<格式>', describe: '读回与管道像素格式（不写则跟随 --mode：pro 为 rgba，与合入前相同；fast 为 yuv420p，GPU 侧打包免 CPU swscale）' },
    'frame-hashes': { type: 'string', default: 'auto', choices: ['auto', 'on', 'off'], arg: '<模式>', describe: '逐帧 sha256（默认 auto：--json 时 on，人读模式 off；on 总是计算，off 返回 frameHashes=null）' },
    crf: { type: 'integer', default: 14, arg: '<n>', describe: 'x264 crf（默认 14，与页面渲染器相同）' },
    cq: { type: 'integer', default: MASTER_CQ, arg: '<n>', describe: `nvenc 恒定质量 cq（默认 ${MASTER_CQ}，Fast 档；数字小画质高；勿用 6，真实画面外的纯噪声在 cq 6 出过坏流）` },
    query: { type: 'string', default: '', arg: '<k=v&…>', describe: '交给作品 build 的查询串（同页面的 location.search，不带 ?；出片链的 --query 与预演的 previs=1 原样转来）' },
    preset: { type: 'string', default: 'medium', choices: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], arg: '<名字>', describe: 'x264 preset（默认 medium）' },
    daemon: { type: 'string', arg: '<目标>', describe: '常驻守护进程接入（默认 off；可选 off、auto、on 或 socket 路径；未传时读取 BEIMING_OFFSCREEN_DAEMON）' },
    socket: { type: 'string', arg: '<路径>', describe: 'daemon 监听或连接的本机 IPC 路径（默认 $XDG_RUNTIME_DIR/beiming-offscreen.sock，否则 <临时目录>/beiming-offscreen-<uid>/daemon.sock；父目录须本人所有且 0700）；render/stills/probe/profile 上要与 --daemon on|auto 一起用' },
    'idle-timeout': { type: 'number', default: 600, arg: '<秒>', describe: 'daemon 空闲自动退出时长（秒，默认 600；0 表示不超时）' },
    'max-cached-works': { type: 'integer', default: 4, arg: '<n>', describe: 'daemon LRU 缓存的作品实例上限（默认 4）' },
    action: { type: 'string', default: 'start', choices: ['start', 'status', 'stop'], arg: '<动作>', describe: 'daemon 子命令动作：start（启动前台守护进程）、status（查统计）、stop（优雅停止）' },
  },
  exitCodes: { 0: '成功', 1: '渲染或编码失败', 2: '用法错误', 3: '缺可选依赖或守护进程不可用', 4: '契约或成片帧数不符', 5: '资源忙' },
  examples: [
    'node engine/offscreen/cli.mjs render lab/offscreen/ink.mjs --out out/offscreen/ink.mp4 --frames 0:96',
    'node engine/offscreen/cli.mjs stills lab/offscreen/ink.mjs --out out/offscreen/stills --frames 0,48,95',
    'node engine/offscreen/cli.mjs probe  lab/offscreen/ink.mjs',
    'node engine/offscreen/cli.mjs profile films/chendu/offscreen.mjs --frames 0,48,96 --size 3840x2160',
    'node engine/offscreen/cli.mjs batch  films/chendu/offscreen.mjs lab/offscreen/ink.mjs --out-dir out/batch --frames 0:48 --mode fast',
    'node engine/offscreen/cli.mjs daemon --idle-timeout 600 --max-cached-works 4',
  ],
  async run(ctx) {
    const a = resolveArgs(ctx.args, ctx.opts);
    const t0 = process.hrtime.bigint();

    if (a.sub === 'daemon') {
      if (a.action === 'status') {
        const res = await sendDaemonRequest(a.socket, 'stats', {}, { timeoutMs: 5000 });
        if (!res.ok) return { exitCode: res.exitCode ?? 1, error: res.error, data: res.data ?? null, outputs: [] };
        const d = res.data;
        ctx.out(`离屏守护进程运行中 ${d.socket}  pid=${d.pid}  已运行 ${d.uptimeSeconds}s  缓存 ${d.cachedWorks}/${d.maxCachedWorks}（命中 ${d.cacheHits} / 未中 ${d.cacheMisses}）  已完成 ${d.jobsCompleted} 作业`);
        return { data: d, outputs: [] };
      }
      if (a.action === 'stop') {
        const res = await sendDaemonRequest(a.socket, 'shutdown', {}, { timeoutMs: 5000 });
        if (!res.ok) return { exitCode: res.exitCode ?? 1, error: res.error, data: res.data ?? null, outputs: [] };
        ctx.out(`已请求停止离屏守护进程 ${a.socket}`);
        return { data: res.data, outputs: [] };
      }
      const srv = await createDaemonServer({
        socketPath: a.socket,
        idleTimeoutSec: a.idleTimeout,
        maxCachedWorks: a.maxCachedWorks,
        onLog: msg => ctx.log.info(msg),
      });
      const undo = ctx.onCleanup(() => srv.close());
      ctx.log.info(`离屏守护进程已就绪 ${srv.socketPath}（pid=${process.pid}，idle=${a.idleTimeout}s，cache=${a.maxCachedWorks}）`);
      try {
        await srv.closed;
      } finally {
        undo();
      }
      const d = srv.stats();
      ctx.out(`离屏守护进程已退出 ${d.socket}  共完成 ${d.jobsCompleted} 作业`);
      return { data: d, outputs: [] };
    }

    const hashMode = ctx.opts['frame-hashes'];
    const hashFrames = hashMode === 'on' || (hashMode === 'auto' && ctx.json);

    if (a.sub === 'batch') {
      const gpu = await loadGpu();
      const res = await runBatch(a.jobs, {
        gpu,
        concurrency: ctx.opts.concurrency,
        maxEncoders: ctx.opts['max-encoders'],
        failFast: !!ctx.opts['fail-fast'],
        frameHashes: hashFrames,
        onCleanup: fn => ctx.onCleanup(fn),
        onJobDone: r => ctx.log.info(`作业 ${r.id}：${r.ok ? `完成（${r.frames} 帧，${r.seconds}s）` : `失败（${r.error.message}）`}`),
      });
      const software = /swiftshader|llvmpipe|lavapipe|microsoft basic render|\bwarp\b/i.test(`${res.adapter.vendor} ${res.adapter.description}`);
      if (software) ctx.warn('env.software-gpu', `Dawn 落在软件适配器上（${res.adapter.vendor} ${res.adapter.description}），会很慢`, '检查 NVIDIA 驱动与 Vulkan ICD');
      ctx.out(`批量完成 ${res.succeeded}/${res.total} 个作业（共 ${res.totalFrames} 帧，${res.seconds}s，总吞吐 ${res.totalFps} 帧/秒）`);
      if (!res.ok) {
        const firstErr = res.results.find(r => !r.ok)?.error;
        const exitCode = String(firstErr?.code || '').startsWith('contract.') ? 4 : 1;
        return {
          exitCode,
          error: { code: firstErr?.code || 'failure.batch', message: `${res.failed}/${res.total} 个作业失败（首个：${firstErr?.message}）`, hint: '查看 data.results 里每个失败作业的 error' },
          data: res,
          outputs: res.outputs,
        };
      }
      return { data: res, outputs: res.outputs };
    }

    const jobParams = {
      file: a.file,
      width: a.width,
      height: a.height,
      fps: a.fps,
      inflight: a.inflight,
      query: ctx.opts.query,
      hashFrames,
      ...(a.out ? { out: a.out } : {}),
      ...(a.frameList ? { frameList: a.frameList } : {}),
      ...(a.sub === 'render' ? {
        from: a.from, to: a.to, mode: ctx.opts.mode, encoder: ctx.opts.encoder,
        pixFmt: ctx.opts['pix-fmt'], crf: ctx.opts.crf, cq: ctx.opts.cq, preset: ctx.opts.preset,
      } : {}),
      ...(ctx.opts['events-out'] ? { eventsOut: path.resolve(ctx.opts['events-out']) } : {}),
    };

    const cwd = process.cwd();
    const sockOpt = ctx.opts.socket ? socketArg(ctx.opts.socket, cwd) : null;
    const daemonTarget = resolveDaemonTarget(ctx.opts.daemon, { socket: sockOpt, cwd });
    if (sockOpt && daemonTarget.mode === 'off') {
      throw usageError('socket-without-daemon', `--socket ${sockOpt} 只在接入守护进程时有用，当前 --daemon 为 off`, '加 --daemon on（连不上就失败）或 --daemon auto（连不上退回冷启动）');
    }
    if (daemonTarget.mode !== 'off') {
      try {
        const res = await sendDaemonRequest(daemonTarget.socket, a.sub, jobParams);
        for (const w of res.warnings || []) ctx.warn(w.code, w.message, w.hint ?? null);
        if (!res.ok) {
          return { exitCode: res.exitCode ?? 1, error: res.error, data: res.data ?? null, outputs: res.outputs ?? [] };
        }
        for (const line of res.humanLines || []) ctx.out(line);
        return { data: res.data, outputs: res.outputs ?? [] };
      } catch (e) {
        if (daemonTarget.mode === 'auto' && e?.daemonConnectError) {
          ctx.log.info(`未连上常驻守护进程（${daemonTarget.socket}），自动回退冷启动`);
        } else {
          throw e;
        }
      }
    }

    const gpu = await loadGpu();
    const encodePending = a.sub === 'render' ? resolveEncodeAsync({
      mode: ctx.opts.mode, encoder: ctx.opts.encoder, pixFmt: ctx.opts['pix-fmt'],
      width: a.width, height: a.height,
    }) : null;
    const host = await createHost({ gpu, width: a.width, height: a.height, fps: a.fps, query: ctx.opts.query });
    const info = host.device.adapterInfo ?? {};
    const adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
    const software = /swiftshader|llvmpipe|lavapipe|microsoft basic render|\bwarp\b/i.test(`${adapter.vendor} ${adapter.description}`);
    const undoHost = ctx.onCleanup(() => host.dispose());
    try {
      const [work] = a.sub === 'render'
        ? [await (await Promise.all([host.load(a.file), encodePending]))[0]]
        : [await host.load(a.file)];
      const res = await executeOffscreenJob({
        method: a.sub,
        params: jobParams,
        host,
        work,
        adapter,
        software,
        t0,
        encodePending,
        onCleanup: fn => ctx.onCleanup(fn),
        onLog: msg => ctx.log.info(msg),
      });
      for (const w of res.warnings) ctx.warn(w.code, w.message, w.hint ?? null);
      for (const line of res.humanLines) ctx.out(line);
      return { data: res.data, outputs: res.outputs };
    } finally {
      undoHost();
      host.dispose();
    }
  },
});

if (isMain(import.meta.url)) runCli(command);
