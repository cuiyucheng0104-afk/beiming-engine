// 北冥引擎 · 离屏出片 · 常驻渲染守护进程与客户端（WP1.2）：
//   进程级常驻单个 GPUDevice、编码器探测缓存与 LRU 作品缓存，把单次短片 / 迭代出片的冷启动压到亚秒级；
//   只走本机 IPC，不开放 TCP 端口：
//     类 Unix：Unix Domain Socket 放在当前用户专属、非符号链接、权限 0700 的目录里（$XDG_RUNTIME_DIR，或 <临时目录>/beiming-offscreen-<uid>/），
//              先校验目录再 listen，socket 再 chmod 0600；客户端连接前校验 socket 与父目录属主是当前用户。
//     Windows：Named Pipe，名字带仓库与用户名的哈希；Node 不能给命名管道设 ACL，访问控制只靠 Windows 默认安全描述符，
//              不保证「仅限同用户」，多用户共用的 Windows 机器上不要开守护进程。
//   协议：行分隔 JSON-RPC（render / stills / probe / profile / stats / shutdown），返回与 CLI --json 一致的信封结构。
//
//   defaultSocketPath(opts?)                          默认本机 IPC 路径（尊重 BEIMING_OFFSCREEN_SOCKET）
//   resolveDaemonTarget(flagValue, opts?)             解析 --daemon、--socket（opts.socket）与 BEIMING_OFFSCREEN_DAEMON → { mode, socket }
//   assertPrivateSocketDir(dir, opts?)                服务端：父目录必须本人所有、非符号链接、0700（opts.create 时按 0700 新建）
//   assertTrustedSocket(socketPath, opts?)            客户端：socket 与父目录属主必须是当前用户（不存在时放行，由连接报 ENOENT）
//   computeWorkSignature(workFile)                    计算作品及本地依赖的 mtime+size 签名（文件改动即热失效）
//   executeOffscreenJob({ method, params, ... })      冷启动与常驻进程共用的单套渲染/写盘/编码/校验实现（保障 T0 逐字节一致）
//   createDaemonServer(opts)                          启动守护进程 IPC 服务（含陈旧 socket 清理、防重入、device.lost 自愈、空闲超时）
//   sendDaemonRequest(socketPath, method, params)     客户端发一次行分隔 JSON-RPC 请求
//   计时一律用 process.hrtime.bigint()（渲染链路范围内不用 performance.now / Date.now / Math.random）。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import nodeModule from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError, exitCodeFor, usageError } from '../../tools/lib/cli.mjs';
import { encodePng } from '../../tools/plates/png.mjs';
import { probe } from '../render/lib/ffmpeg.mjs';
import { setFilmFps } from '../core/clock.js';
import { loadGpu } from './load.mjs';
import { createHost } from './host.mjs';
import { renderFrames, renderFrameList } from './frames.mjs';
import { MASTER_CQ, resolveEncodeAsync, startEncoder } from './encode.mjs';
import { createGpuTimer, attachGpuTimer, detachGpuTimer } from './gputimer.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const FILMS_DIR = path.join(ROOT, 'films');
const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const shaHex = buf => createHash('sha256').update(buf).digest('hex');
const seconds = since => Number(process.hrtime.bigint() - since) / 1e9;
const repoRel = p => path.relative(ROOT, p).split(path.sep).join('/');
const median = xs => { const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const r3 = x => Math.round(x * 1000) / 1000;
const SOFTWARE_RE = /swiftshader|llvmpipe|lavapipe|microsoft basic render|\bwarp\b/i;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const SIG_EXTS = new Set(['.mjs', '.js', '.json', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.ttf', '.otf', '.wgsl']);
const SIG_SKIP_DIRS = new Set(['out', 'stills', 'frames', 'node_modules', '.git']);

let hotReloadHookInstalled = false;
let reqSeq = 0;
// 共享模块不透传 ?v：gputimer 的计时器表、clock 的影片帧率、canvas 的字体去重都是模块级状态，必须与守护进程用的是同一份。
// 代价：改了 engine/ 等共享代码要重启守护进程（作品签名也不扫这些目录）。
const SHARED_DIRS = ['engine', 'tools', 'src', 'cases', 'node_modules'].map(d => path.join(ROOT, d) + path.sep);

/** 为仓库内带 ?v=<sig> 的热重载入口，向作品侧的本地相对子模块透传同一版本参数（共享模块除外），避免陈旧子模块缓存 */
function installHotReloadHook() {
  if (hotReloadHookInstalled) return;
  hotReloadHookInstalled = true;
  if (typeof nodeModule.registerHooks !== 'function') return;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const res = nextResolve(specifier, context);
      if (!context.parentURL || (!specifier.startsWith('./') && !specifier.startsWith('../'))) return res;
      if (!res?.url || !res.url.startsWith('file:')) return res;
      try {
        const parent = new URL(context.parentURL);
        const v = parent.searchParams.get('v');
        if (!v) return res;
        const child = new URL(res.url);
        if (child.searchParams.has('v')) return res;
        const childPath = fileURLToPath(child);
        if (childPath.startsWith(ROOT + path.sep) && !SHARED_DIRS.some(d => childPath.startsWith(d))) {
          child.searchParams.set('v', v);
          return { ...res, url: child.href };
        }
      } catch { /* 非标准 URL 原样放行 */ }
      return res;
    },
  });
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
const currentUser = () => { try { return os.userInfo().username; } catch { return 'user'; } };
const isPipePath = p => process.platform === 'win32' && String(p).startsWith('\\\\.\\pipe\\');
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** 默认本机 IPC 路径（不走 TCP）：类 Unix 落在当前用户专属目录里；Windows 命名管道名带仓库与用户名的哈希 */
export function defaultSocketPath({ env = process.env, platform = process.platform, root = ROOT, tmpdir = os.tmpdir(), uid = currentUid(), user = currentUser() } = {}) {
  const explicit = String(env.BEIMING_OFFSCREEN_SOCKET ?? '').trim();
  if (explicit) return explicit;
  if (platform === 'win32') {
    const h = createHash('sha256').update(`${root}\0${user}`).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\beiming-offscreen-${h}`;
  }
  const runtimeDir = String(env.XDG_RUNTIME_DIR ?? '').trim();
  if (runtimeDir) return path.posix.join(runtimeDir, 'beiming-offscreen.sock');   // XDG 只在类 Unix 上有，按 POSIX 拼
  return path.posix.join(tmpdir, `beiming-offscreen-${uid ?? 'user'}`, 'daemon.sock');   // 只在类 Unix 上走到；不直接放在公共临时目录根下
}

/** 服务端：socket 的父目录必须是当前用户所有、非符号链接、权限 0700；create 时按 0700 新建（已存在的不改权限） */
export function assertPrivateSocketDir(dir, { uid = currentUid(), create = false } = {}) {
  if (uid === null) return;   // Windows：没有 POSIX 属主与权限位
  const bad = why => usageError('unsafe-socket-dir', `守护进程 socket 的目录 ${dir} ${why}，拒绝监听`,
    '换到当前用户专属、权限 0700 的目录（默认 $XDG_RUNTIME_DIR 或 <临时目录>/beiming-offscreen-<uid>/），或 chmod 700 该目录');
  let st = lstatOrNull(dir);
  if (!st && create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatOrNull(dir);
  }
  if (!st) throw bad('不存在');
  if (st.isSymbolicLink()) throw bad('是符号链接');
  if (!st.isDirectory()) throw bad('不是目录');
  if (st.uid !== uid) throw bad(`的属主 uid ${st.uid} 不是当前用户 ${uid}`);
  if (st.mode & 0o077) throw bad(`的权限是 ${(st.mode & 0o777).toString(8)}，要求 700`);
}

/** 客户端：连接前确认 socket 与父目录都属于当前用户（不存在时放行，交给连接报 ENOENT，--daemon auto 据此退回冷启动） */
export function assertTrustedSocket(socketPath, { uid = currentUid() } = {}) {
  if (uid === null || isPipePath(socketPath)) return;
  const st = lstatOrNull(socketPath);
  if (!st) return;
  const bad = why => new CliError('env.daemon-untrusted', `不信任守护进程 socket ${socketPath}：${why}`, {
    hint: '可能是别的用户伪造或抢占的路径；确认后删掉它，用默认路径重启守护进程',
  });
  if (!st.isSocket()) throw bad('不是 socket');
  if (st.uid !== uid) throw bad(`属主 uid ${st.uid} 不是当前用户 ${uid}`);
  const dir = path.dirname(socketPath), ds = lstatOrNull(dir);
  if (!ds || ds.isSymbolicLink() || ds.uid !== uid) throw bad(`父目录 ${dir} 不是当前用户所有的真实目录`);
}

/** 解析客户端 --daemon 与环境变量 BEIMING_OFFSCREEN_DAEMON → { mode: 'off'|'auto'|'required', socket } */
export function resolveDaemonTarget(flagValue, { env = process.env, platform = process.platform, root = ROOT, socket = null, cwd = process.cwd() } = {}) {
  const fromFlag = flagValue !== undefined && flagValue !== null && String(flagValue).trim() !== '';
  const raw = fromFlag ? String(flagValue).trim() : String(env.BEIMING_OFFSCREEN_DAEMON ?? '').trim();
  const low = raw.toLowerCase();
  if (!raw || low === 'off' || low === '0' || low === 'false' || low === 'none') {
    return { mode: 'off', socket: null };
  }
  const resolvePath = platform === process.platform ? path.resolve : (platform === 'win32' ? path.win32.resolve : path.posix.resolve);
  const normSock = s => (!s || String(s).startsWith('\\\\.\\pipe\\') ? s : resolvePath(cwd, s));
  const sockNorm = socket ? normSock(socket) : null;
  const defSock = sockNorm || defaultSocketPath({ env, platform, root });   // --socket 优先于默认路径
  if (low === 'auto' || low === '1' || low === 'true') {
    return { mode: 'auto', socket: defSock };
  }
  if (low === 'on' || low === 'required') {
    return { mode: 'required', socket: defSock };
  }
  const rawNorm = normSock(raw);
  if (sockNorm && sockNorm !== rawNorm) throw usageError('conflicting-socket', `--daemon ${raw} 与 --socket ${socket} 指向不同路径`, '只写一个：--daemon on --socket <路径>，或 --daemon <路径>');
  return { mode: 'required', socket: rawNorm };
}

/** 校验作品模块路径位于仓库内（防止外部路径经 RPC 执行） */
function ensureRepoWorkFile(file) {
  let real;
  try { real = fs.realpathSync(path.resolve(file)); } catch {
    throw usageError('work-not-found', `找不到作品模块：${file}`, '路径须指向仓库内存在的作品模块');
  }
  const rel = path.relative(ROOT, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw usageError('work-outside-repo', `作品模块不在仓库里：${real}`, '离屏出片只执行仓库里的作品');
  }
  return real;
}

/** 收集一个作品目录或入口及其直接本地依赖文件的签名（路径 + 大小 + mtimeMs） */
export function computeWorkSignature(workFile) {
  const abs = path.resolve(workFile);
  const hash = createHash('sha256');
  const entries = [];
  const addFile = f => {
    try {
      const st = fs.statSync(f);
      if (st.isFile()) entries.push(`${f}\0${st.size}\0${st.mtimeMs}`);
    } catch { /* 文件消失时自然会改变签名 */ }
  };

  // 若在 films/<name>/ 下，递归扫该作品目录（排除输出目录），捕获 story.js / shots/*.js / film.json / 本地素材改动
  const relToFilms = path.relative(FILMS_DIR, abs);
  if (relToFilms && !relToFilms.startsWith('..') && !path.isAbsolute(relToFilms)) {
    const filmName = relToFilms.split(path.sep)[0];
    const filmRoot = path.join(FILMS_DIR, filmName);
    const walk = dir => {
      let dirents;
      try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (!SIG_SKIP_DIRS.has(d.name)) walk(full);
        } else if (d.isFile()) {
          if (SIG_EXTS.has(path.extname(d.name).toLowerCase())) addFile(full);
        }
      }
    };
    walk(filmRoot);
  } else {
    addFile(abs);
    // 非 films/ 独立模块：补充统计源码里直接引用的相对路径文件
    try {
      const src = fs.readFileSync(abs, 'utf8');
      const dir = path.dirname(abs);
      const re = /(?:from\s+|import\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;
      const seen = new Set([abs]);
      let m;
      while ((m = re.exec(src)) !== null) {
        const dep = path.resolve(dir, m[1]);
        if (!seen.has(dep)) { seen.add(dep); addFile(dep); }
      }
    } catch { /* 读失败由后续加载报出 */ }
  }

  entries.sort();
  for (const e of entries) hash.update(e).update('\n');
  return hash.digest('hex').slice(0, 16);
}

/** 冷启动与守护进程共用的单套作业执行器（确保输出文件、像素、JSON 信封字段逐字节一致） */
export async function executeOffscreenJob({
  method,
  params,
  host,
  work,
  adapter,
  software,
  t0,
  encodePending = null,
  onCleanup = () => () => {},
  onLog = () => {},
}) {
  const warnings = [];
  const humanLines = [];
  if (software) {
    warnings.push({
      code: 'env.software-gpu',
      message: `Dawn 落在软件适配器上（${adapter.vendor} ${adapter.description}），会很慢`,
      hint: '检查 NVIDIA 驱动与 Vulkan ICD',
    });
  }

  // 复用缓存宿主时确保全局帧率与本次作业一致
  setFilmFps(params.fps);

  if (method === 'probe') {
    const mod = work.__module || {};
    const hasTexts = typeof work.texts === 'function';
    const dur = work.dur ?? mod.DUR ?? null;
    const rawEv = work.events ?? mod.EV ?? mod.events ?? null;
    const rawTl = work.timeline ?? mod.TIMELINE ?? mod.timeline ?? null;
    const evList = Array.isArray(rawEv) ? rawEv : [];
    const hasTimeline = Boolean(rawTl && typeof rawTl === 'object');
    const outputs = [];
    if (params.eventsOut) {
      const evDir = path.resolve(params.eventsOut);
      fs.mkdirSync(evDir, { recursive: true });
      const evFile = path.join(evDir, 'events.json');
      const evJson = JSON.stringify({ dur: dur ?? +(params.frameCount / params.fps).toFixed(6), ev: evList }, null, 2) + '\n';
      fs.writeFileSync(evFile, evJson);
      outputs.push({ path: evFile, sha256: shaHex(Buffer.from(evJson)), kind: 'events' });
      if (hasTimeline) {
        const tlFile = path.join(evDir, 'timeline.json');
        const tlJson = JSON.stringify(rawTl, null, 2) + '\n';
        fs.writeFileSync(tlFile, tlJson);
        outputs.push({ path: tlFile, sha256: shaHex(Buffer.from(tlJson)), kind: 'timeline' });
      }
    }
    const data = {
      width: params.width, height: params.height, fps: params.fps, adapter, software,
      hasTexts, dur, evCount: evList.length, hasTimeline, seconds: +seconds(t0).toFixed(2),
    };
    humanLines.push(`离屏契约通过 ${repoRel(params.file)}  ${params.width}×${params.height} ${params.fps} fps  TEXTS:${hasTexts ? '有' : '无'}`);
    return { data, outputs, warnings, humanLines };
  }

  if (method === 'profile') {
    const timers = [createGpuTimer(host.device)];
    try {
      if (!timers[0]) {
        throw new CliError('env.timestamp-query', `适配器不支持 timestamp-query（${adapter.vendor ?? '未知'} ${adapter.description ?? ''}），没法分段计时`, {
          hint: '换支持时间戳查询的显卡或驱动；软件适配器通常不支持',
        });
      }
      while (timers.length < params.frameList.length) timers.push(createGpuTimer(host.device));
      for (const f of params.frameList) host.stepFrame(work, f);
      await host.device.queue.onSubmittedWorkDone();
      params.frameList.forEach((f, i) => {
        attachGpuTimer(host.renderer, timers[i]);
        timers[i].mark('pre');
        host.stepFrame(work, f);
        timers[i].end();
      });
      detachGpuTimer(host.renderer);
      const frames = (await Promise.all(timers.map(t => t.read()))).map((r, i) => (
        { frame: params.frameList[i], totalMs: r3(r.totalMs), clamped: r.clamped, spans: r.spans.map(s => ({ label: s.label, ms: r3(s.ms) })) }
      ));
      const labels = [...new Set(frames.flatMap(fr => fr.spans.map(s => s.label)))];
      const med = labels.map(label => ({ label, medianMs: median(frames.map(fr => fr.spans.find(s => s.label === label)?.ms ?? 0)) }));
      const sum = med.reduce((x, p) => x + p.medianMs, 0) || 1;
      const passes = med.map(p => ({ ...p, medianMs: r3(p.medianMs), share: r3(p.medianMs / sum) })).sort((x, y) => y.medianMs - x.medianMs);
      const medianFrameMs = r3(median(frames.map(fr => fr.totalMs)));
      humanLines.push(`GPU 分段计时 ${repoRel(params.file)}  ${params.width}×${params.height}  ${frames.length} 帧（${params.frameList.join(',')}）  每帧中位数 ${medianFrameMs} ms`);
      for (const p of passes) humanLines.push(`  ${p.label.padEnd(12)} ${p.medianMs.toFixed(2).padStart(8)} ms  ${(p.share * 100).toFixed(1).padStart(5)}%`);
      humanLines.push('  pre = look 之前（镜头更新等）；overlay = GPU 等 CPU 画显示层；compose = 叠显示层并输出。各段含 GPU 等 CPU 提交的空闲');
      if (frames.some(fr => fr.clamped)) {
        warnings.push({ code: 'profile.non-monotonic', message: '有时间戳倒退，对应段记 0', hint: '多跑几次看是否稳定' });
      }
      return {
        data: { width: params.width, height: params.height, fps: params.fps, adapter, software, frames, passes, medianFrameMs, seconds: +seconds(t0).toFixed(2) },
        outputs: [],
        warnings,
        humanLines,
      };
    } finally {
      detachGpuTimer(host.renderer);
      for (const t of timers) t?.dispose();
    }
  }

  if (method === 'stills') {
    fs.mkdirSync(params.out, { recursive: true });
    const partials = new Set();
    const undo = onCleanup(() => {
      for (const p of partials) fs.rmSync(p, { force: true });
    });
    try {
      const hashes = params.hashFrames ? [] : null;
      const outputs = [];
      const t1 = process.hrtime.bigint();
      await renderFrameList({
        host, work, frames: params.frameList, inflight: params.inflight,
        onFrame: async (f, px) => {
          if (params.hashFrames) hashes.push(sha16(px));
          const base = `f${String(f).padStart(6, '0')}.png`;
          const partial = path.join(params.out, `.${base}.partial-${process.pid}-${++reqSeq}`);
          const dst = path.join(params.out, base);
          partials.add(partial);
          const png = encodePng({ width: params.width, height: params.height, data: px, channels: 4 });
          fs.writeFileSync(partial, png);
          fs.renameSync(partial, dst);
          partials.delete(partial);
          outputs.push({ path: dst, sha256: shaHex(png), kind: 'image' });
        },
      });
      const renderS = seconds(t1);
      const total = params.frameList.length;
      const data = {
        frames: total, frameNumbers: params.frameList, width: params.width, height: params.height, fps: params.fps,
        seconds: +seconds(t0).toFixed(2), renderFps: +(total / Math.max(renderS, 1e-6)).toFixed(1), adapter, frameHashes: hashes,
      };
      humanLines.push(`完成静帧 ${repoRel(params.out).startsWith('..') ? params.out : repoRel(params.out)}  ${total} 帧  ${params.width}×${params.height}  ${data.seconds}s`);
      return { data, outputs, warnings, humanLines };
    } finally {
      undo();
    }
  }

  if (method === 'render') {
    fs.mkdirSync(path.dirname(params.out), { recursive: true });
    const partial = path.join(path.dirname(params.out), `.${path.basename(params.out, path.extname(params.out))}.partial-${process.pid}-${++reqSeq}.mp4`);
    let enc = null, settled = false;
    const undo = onCleanup(async () => {
      if (enc && !settled) await enc.abort();
      fs.rmSync(partial, { force: true });
    });
    try {
      const encPick = encodePending
        ? await encodePending
        : await resolveEncodeAsync({
          mode: params.mode, encoder: params.encoder, pixFmt: params.pixFmt,
          width: params.width, height: params.height,
        });
      if (encPick.reason) onLog(encPick.reason);
      const { encoder, pixFmt, mode: encodeMode } = encPick;
      const cq = encoder === 'nvenc' ? (params.cq ?? MASTER_CQ) : null;
      enc = startEncoder({
        width: params.width, height: params.height, fps: params.fps, out: partial,
        crf: params.crf ?? 14, preset: params.preset ?? 'medium', encoder, cq: params.cq ?? MASTER_CQ, pixFmt,
        gop: params.gop ?? null, timescale: params.timescale ?? null,
      });
      const total = params.to - params.from;
      const hashes = params.hashFrames ? [] : null;
      let done = 0;
      const t1 = process.hrtime.bigint();
      await renderFrames({
        host, work, from: params.from, to: params.to, inflight: params.inflight, format: pixFmt,
        onFrame: async (f, px) => {
          if (params.hashFrames) hashes.push(sha16(px));
          await enc.write(px);
          done++;
          if (done % 48 === 0 || done === total) onLog(`渲染 ${done}/${total} 帧`);
        },
      });
      await enc.finish();
      settled = true;
      const renderS = seconds(t1);
      const frames = (await probe(partial)).video?.frames;
      if (frames !== total) {
        throw new CliError('contract.frame-count', `编出来是 ${frames} 帧，应为 ${total} 帧`, { hint: '编码器丢帧或重复帧：带上日志报告' });
      }
      fs.renameSync(partial, params.out);
      const data = {
        frames: total, from: params.from, to: params.to, width: params.width, height: params.height, fps: params.fps,
        pixFmt, encoder, mode: encodeMode, cq, profile: encPick.profile, reason: encPick.reason,
        seconds: +seconds(t0).toFixed(2), renderFps: +(total / Math.max(renderS, 1e-6)).toFixed(1), adapter, frameHashes: hashes,
      };
      humanLines.push(`完成 ${repoRel(params.out).startsWith('..') ? params.out : repoRel(params.out)}  ${total} 帧（${params.from}–${params.to - 1}）  ${params.width}×${params.height} ${params.fps} fps  ${data.seconds}s（渲染+编码 ${data.renderFps} 帧/秒）`);
      return {
        data,
        outputs: [{ path: params.out, sha256: shaHex(fs.readFileSync(params.out)), kind: 'video' }],
        warnings,
        humanLines,
      };
    } catch (e) {
      if (enc && !settled) { try { await enc.abort(); } catch { /* 忽略清理错误 */ } }
      fs.rmSync(partial, { force: true });
      throw e;
    } finally {
      undo();
    }
  }

  throw usageError('bad-method', `守护进程不支持的 RPC 方法：${method}`, '可用：render、stills、probe、profile、stats、shutdown');
}

// ───────────────────────── 常驻 GPU 运行时与 LRU 作品池 ─────────────────────────

function createGpuRuntime({
  maxCachedWorks = 4,
  loadGpuFn = loadGpu,
  requestDeviceFn = null,
  createHostFn = createHost,
  execJobFn = null,
} = {}) {
  installHotReloadHook();
  let gpu = null;
  let device = null;
  let deviceHealthy = false;
  let deviceLostReason = null;
  let adapter = { vendor: null, architecture: null, description: null };
  let software = false;
  let deviceResets = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let jobsCompleted = 0;
  let jobsFailed = 0;
  const cache = new Map();   // key → { key, file, width, height, fps, query, sig, host, work, hits }
  const onUncaptured = () => { /* 具体宿主会经自身的 uncapturederror 感知并触发淘汰 */ };

  const clearCache = () => {
    for (const entry of cache.values()) {
      try { entry.host.dispose(); } catch { /* 忽略单个宿主释放失败 */ }
    }
    cache.clear();
  };

  const resetDevice = (reason = 'device-reset') => {
    deviceHealthy = false;
    deviceLostReason = reason;
    clearCache();
    if (device) {
      try { device.removeEventListener?.('uncapturederror', onUncaptured); } catch { /* ignore */ }
      try { device.destroy?.(); } catch { /* ignore */ }
      device = null;
    }
    deviceResets++;
  };

  async function ensureDevice() {
    if (device && deviceHealthy) return device;
    if (device && !deviceHealthy) {
      resetDevice(deviceLostReason || 'unhealthy');
    }
    if (!gpu) gpu = await loadGpuFn();
    let dev;
    if (requestDeviceFn) {
      dev = await requestDeviceFn(gpu);
    } else {
      const adp = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adp) throw new CliError('env.webgpu-unavailable', 'Dawn 拿不到 WebGPU 适配器', { hint: '检查显卡驱动与 Vulkan / Metal 支持；离屏出片不回退到 WebGL' });
      try { dev = await adp.requestDevice({ requiredFeatures: [...adp.features] }); }
      catch (e) { throw new CliError('env.webgpu-unavailable', `Dawn 创建 GPU 设备失败：${e.message}`, { hint: '检查显卡驱动与当前 GPU 资源' }); }
    }
    device = dev;
    deviceHealthy = true;
    deviceLostReason = null;
    const info = dev.adapterInfo ?? {};
    adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
    software = SOFTWARE_RE.test(`${adapter.vendor ?? ''} ${adapter.description ?? ''}`);
    dev.addEventListener?.('uncapturederror', onUncaptured);
    if (dev.lost && typeof dev.lost.then === 'function') {
      dev.lost.then(lostInfo => {
        if (device !== dev) return;   // 旧设备的延迟回调
        if (lostInfo?.reason === 'destroyed') return;   // 主动销毁不算异常丢失
        deviceHealthy = false;
        deviceLostReason = lostInfo?.message || lostInfo?.reason || 'device-lost';
        clearCache();
        deviceResets++;
      }).catch(() => {});
    }
    return dev;
  }

  function evictIfNeeded() {
    if (maxCachedWorks <= 0) {
      clearCache();
      return;
    }
    while (cache.size >= maxCachedWorks) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      try { oldest.host.dispose(); } catch { /* ignore */ }
    }
  }

  async function acquireWork(params) {
    const dev = await ensureDevice();
    const file = ensureRepoWorkFile(params.file);
    const sig = computeWorkSignature(file);
    const key = JSON.stringify([file, params.width, params.height, params.fps, params.query ?? '']);
    const existing = cache.get(key);
    if (existing) {
      const faulted = typeof existing.host.isFaulted === 'function' && existing.host.isFaulted();
      if (existing.sig === sig && !faulted && deviceHealthy) {
        // LRU 置顶
        cache.delete(key);
        cache.set(key, existing);
        existing.hits++;
        cacheHits++;
        return { entry: existing, ephemeral: false, cacheHit: true };
      }
      cache.delete(key);
      try { existing.host.dispose(); } catch { /* ignore */ }
    }
    cacheMisses++;
    if (maxCachedWorks > 0) evictIfNeeded();
    const host = await createHostFn({
      gpu, device: dev, width: params.width, height: params.height, fps: params.fps, query: params.query ?? '',
    });
    let work;
    try {
      // 总是带 ?v=<sig>，一旦文件变更即可避开 ESM 模块缓存拿到新代码
      work = await host.load(file, { cacheBust: sig });
    } catch (e) {
      try { host.dispose(); } catch { /* ignore */ }
      throw e;
    }
    const entry = { key, file, width: params.width, height: params.height, fps: params.fps, query: params.query ?? '', sig, host, work, hits: 0 };
    if (maxCachedWorks > 0) {
      cache.set(key, entry);
      return { entry, ephemeral: false, cacheHit: false };
    }
    return { entry, ephemeral: true, cacheHit: false };
  }

  async function execute(method, params) {
    const t0 = process.hrtime.bigint();
    const encodePending = method === 'render'
      ? resolveEncodeAsync({
        mode: params.mode, encoder: params.encoder, pixFmt: params.pixFmt,
        width: params.width, height: params.height,
      })
      : null;
    const { entry, ephemeral, cacheHit } = await acquireWork(params);
    try {
      const res = execJobFn
        ? await execJobFn({ method, params: { ...params, file: entry.file }, host: entry.host, work: entry.work, adapter, software, t0, encodePending })
        : await executeOffscreenJob({ method, params: { ...params, file: entry.file }, host: entry.host, work: entry.work, adapter, software, t0, encodePending });
      if (!deviceHealthy) {
        throw new CliError('failure.gpu', `GPU 设备已丢失（${deviceLostReason || 'unknown'}）`, { hint: '守护进程已清理失效设备，下次请求将自动重建' });
      }
      jobsCompleted++;
      return { ...res, cacheHit };
    } catch (e) {
      jobsFailed++;
      const faulted = typeof entry.host.isFaulted === 'function' && entry.host.isFaulted();
      if (!deviceHealthy) {
        resetDevice(deviceLostReason || e.message);
        if (!(e instanceof CliError) || e.code !== 'failure.gpu') {
          throw new CliError('failure.gpu', `GPU 设备丢失：${e.message || deviceLostReason}`, { hint: '守护进程已重置设备，重试即可恢复' });
        }
      } else if (faulted) {
        cache.delete(entry.key);
        try { entry.host.dispose(); } catch { /* ignore */ }
      }
      throw e;
    } finally {
      if (ephemeral) {
        try { entry.host.dispose(); } catch { /* ignore */ }
      }
    }
  }

  return {
    get adapter() { return adapter; },
    get software() { return software; },
    execute,
    stats() {
      const mem = process.memoryUsage();
      return {
        cachedWorks: cache.size,
        maxCachedWorks,
        cacheHits,
        cacheMisses,
        jobsCompleted,
        jobsFailed,
        deviceResets,
        deviceReady: Boolean(device && deviceHealthy),
        adapter,
        software,
        memoryMB: {
          rss: +(mem.rss / 1048576).toFixed(1),
          heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
        },
        works: [...cache.values()].map(e => ({
          file: repoRel(e.file), width: e.width, height: e.height, fps: e.fps, query: e.query, sig: e.sig, hits: e.hits,
        })),
      };
    },
    dispose() {
      clearCache();
      if (device) {
        try { device.removeEventListener?.('uncapturederror', onUncaptured); } catch { /* ignore */ }
        try { device.destroy?.(); } catch { /* ignore */ }
        device = null;
      }
      deviceHealthy = false;
    },
  };
}

// ───────────────────────── 本机 IPC 服务（Unix Socket / Named Pipe） ─────────────────────────

function probeSocketAlive(socketPath, timeoutMs = 400) {
  return new Promise(resolve => {
    let settled = false;
    const done = alive => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(alive);
    };
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function serializeError(err) {
  if (err instanceof CliError) {
    return {
      exitCode: err.exitCode,
      error: { code: err.code, message: err.message, hint: err.hint ?? null },
    };
  }
  const code = typeof err?.code === 'string' && err.code.includes('.') ? err.code : 'failure.internal';
  return {
    exitCode: exitCodeFor(code),
    error: { code, message: String(err?.message ?? err), hint: err?.hint ?? null },
  };
}

let startupLockSeq = 0;

/** 类 Unix 守护进程启动短锁：串行化 probe → 删陈旧 socket → listen，避免 ext4 等文件系统 inode 复用导致并发抢启动误删胜方活 socket */
async function acquireStartupLock(lockPath, busyError, { timeoutMs = 5000 } = {}) {
  const started = process.hrtime.bigint();
  const payload = `${process.pid}:${++startupLockSeq}\n`;
  let brokenIno = null;
  let brokenSince = null;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
      const myIno = lstatOrNull(lockPath)?.ino ?? null;
      return () => {
        const cur = lstatOrNull(lockPath);
        if (!cur || cur.isSymbolicLink() || !cur.isFile()) return;
        if (myIno !== null && cur.ino !== myIno) return;
        try {
          if (fs.readFileSync(lockPath, 'utf8') === payload) fs.rmSync(lockPath, { force: true });
        } catch { /* 已被清理 */ }
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const st = lstatOrNull(lockPath);
      if (st) {
        if (st.isSymbolicLink() || !st.isFile()) {
          throw usageError('bad-socket-path', `守护进程启动锁路径 ${lockPath} 已存在且不是普通文件，拒绝启动，也不会删除它`,
            '换一个不存在的 socket 路径，或确认后自己处理这个文件');
        }
        let raw = null;
        try { raw = fs.readFileSync(lockPath, 'utf8'); } catch { /* 锁刚被释放，下一轮重试即可 */ }
        if (raw !== null) {
          const m = /^(\d+):\d+\n$/.exec(raw);
          let stale = false;
          if (m) {
            brokenIno = null;
            brokenSince = null;
            const pid = Number(m[1]);
            if (pid > 0 && pid !== process.pid) {
              try { process.kill(pid, 0); } catch (ke) { if (ke?.code === 'ESRCH') stale = true; }
            }
          } else {
            if (brokenIno !== st.ino) { brokenIno = st.ino; brokenSince = process.hrtime.bigint(); }
            if (seconds(brokenSince) * 1000 >= 1000) stale = true;   // 进程在 open 与 write 之间被强杀留下的残锁
          }
          if (stale) {
            const cur = lstatOrNull(lockPath);
            try {
              if (cur && !cur.isSymbolicLink() && cur.isFile() && cur.ino === st.ino && fs.readFileSync(lockPath, 'utf8') === raw) {
                fs.rmSync(lockPath, { force: true });
              }
            } catch { /* ignore */ }
            continue;
          }
        }
      }
      if (seconds(started) * 1000 >= timeoutMs) throw busyError();
      await new Promise(r => setTimeout(r, 15));
    }
  }
}

export async function createDaemonServer({
  socketPath = defaultSocketPath(),
  idleTimeoutSec = 600,
  maxCachedWorks = 4,
  runtime = null,
  loadGpuFn,
  requestDeviceFn,
  createHostFn,
  execJobFn,
  onLog = () => {},
} = {}) {
  const isPipe = isPipePath(socketPath);
  const busyError = () => new CliError('busy.daemon', `已有离屏守护进程正在监听 ${socketPath}`, {
    hint: `复用现有守护进程，或先运行 node engine/offscreen/cli.mjs daemon --socket ${socketPath} --action stop`,
  });
  const checkSocketPathType = () => {
    const st = isPipe ? null : lstatOrNull(socketPath);
    if (st && !st.isSocket()) {
      throw usageError('bad-socket-path', `${socketPath} 已存在且不是 socket（${st.isSymbolicLink() ? '符号链接' : st.isDirectory() ? '目录' : '普通文件'}），拒绝启动，也不会删除它`,
        '换一个不存在的路径，或确认后自己处理这个文件');
    }
    return st;
  };
  if (!isPipe) {
    assertPrivateSocketDir(path.dirname(socketPath), { create: true });   // 先校验私有目录再建锁与 bind：没有暴露窗口
    checkSocketPathType();
  }

  let rt;
  let server;
  let listenedIno = null;
  const startedAt = process.hrtime.bigint();
  let closing = false;
  let activeJobs = 0;
  let queueDepth = 0;
  let jobChain = Promise.resolve();
  let idleTimer = null;
  let resolveClosed;
  const closed = new Promise(r => { resolveClosed = r; });
  const sockets = new Set();

  const clearIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    if (closing || !(idleTimeoutSec > 0) || activeJobs > 0 || queueDepth > 0) return;
    idleTimer = setTimeout(() => {
      onLog(`空闲超过 ${idleTimeoutSec}s，自动关闭守护进程`);
      close();
    }, Math.max(10, Math.round(idleTimeoutSec * 1000)));
  };

  const enqueue = fn => {
    queueDepth++;
    clearIdleTimer();
    const run = jobChain.then(async () => {
      queueDepth--;
      activeJobs++;
      try { return await fn(); }
      finally {
        activeJobs--;
        armIdleTimer();
      }
    });
    jobChain = run.catch(() => {});
    return run;
  };

  const buildStats = () => ({
    socket: socketPath,
    pid: process.pid,
    uptimeSeconds: +seconds(startedAt).toFixed(2),
    activeJobs,
    queueDepth,
    idleTimeoutSec,
    ...rt.stats(),
  });

  const releaseLock = isPipe ? null : await acquireStartupLock(`${socketPath}.lock`, busyError);
  try {
    const existing = checkSocketPathType();
    if (isPipe || existing) {
      if (await probeSocketAlive(socketPath)) {
        throw busyError();
      }
      if (!isPipe && existing) {
        const cur = lstatOrNull(socketPath);
        if (cur?.isSocket() && cur.ino === existing.ino) fs.rmSync(socketPath, { force: true });   // 上次崩溃残留的 socket（持启动锁且核对同 inode）
      }
    }

    rt = runtime ?? createGpuRuntime({ maxCachedWorks, loadGpuFn, requestDeviceFn, createHostFn, execJobFn });
    server = net.createServer(conn => {
      sockets.add(conn);
      conn.setEncoding('utf8');
      let buf = '';
      const writeMsg = obj => {
        if (!conn.destroyed && conn.writable) {
          try { conn.write(JSON.stringify(obj) + '\n'); } catch { /* 对端已断 */ }
        }
      };
      const handleLine = async line => {
        let req;
        try { req = JSON.parse(line); } catch {
          writeMsg({ id: null, ok: false, exitCode: 2, error: { code: 'usage.bad-rpc', message: '请求不是合法 JSON', hint: null } });
          return;
        }
        const { id = null, method, params = {} } = req ?? {};
        if (method === 'stats') {
          writeMsg({ id, ok: true, exitCode: 0, data: buildStats(), outputs: [], warnings: [], humanLines: [] });
          return;
        }
        if (method === 'shutdown') {
          writeMsg({ id, ok: true, exitCode: 0, data: { stopping: true, ...buildStats() }, outputs: [], warnings: [], humanLines: [`已停止守护进程 ${socketPath}`] });
          setImmediate(() => { close(); });
          return;
        }
        if (closing) {
          writeMsg({ id, ok: false, exitCode: 5, error: { code: 'busy.daemon-closing', message: '守护进程正在关闭，不再接收新作业', hint: '稍后重试或改用冷启动' } });
          return;
        }
        if (!['render', 'stills', 'probe', 'profile'].includes(method)) {
          writeMsg({ id, ok: false, exitCode: 2, error: { code: 'usage.bad-method', message: `未知 RPC 方法：${method}`, hint: null } });
          return;
        }
        try {
          const res = await enqueue(() => rt.execute(method, params));
          writeMsg({
            id, ok: true, exitCode: 0,
            data: res.data,
            outputs: res.outputs ?? [],
            warnings: res.warnings ?? [],
            humanLines: res.humanLines ?? [],
            cacheHit: Boolean(res.cacheHit),
          });
        } catch (e) {
          const { exitCode, error } = serializeError(e);
          writeMsg({ id, ok: false, exitCode, error, outputs: [], warnings: [], humanLines: [] });
        }
      };

      conn.on('data', chunk => {
        buf += chunk;
        if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
          writeMsg({ id: null, ok: false, exitCode: 2, error: { code: 'usage.payload-too-large', message: '单条 RPC 消息超过 4 MiB 上限', hint: null } });
          conn.destroy();
          return;
        }
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) handleLine(line);
        }
      });
      conn.on('close', () => sockets.delete(conn));
      conn.on('error', () => sockets.delete(conn));
    });

    await new Promise((resolve, reject) => {
      const onError = err => {
        try { rt.dispose(); } catch { /* ignore */ }
        reject(err?.code === 'EADDRINUSE' ? busyError() : err);
      };
      server.once('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        if (!isPipe && process.platform !== 'win32') {
          try { fs.chmodSync(socketPath, 0o600); } catch { /* 某些虚拟文件系统可能不支持 chmod */ }
          listenedIno = lstatOrNull(socketPath)?.ino ?? null;
        }
        resolve();
      });
    });
  } finally {
    releaseLock?.();
  }

  armIdleTimer();

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearIdleTimer();
    closePromise = (async () => {
      try { await jobChain; } catch { /* ignore */ }
      for (const s of sockets) { try { s.end(); } catch { /* ignore */ } }
      await new Promise(resolve => server.close(() => resolve()));
      try { rt.dispose(); } catch { /* ignore */ }
      // libuv 关闭监听时自己会 unlink 这个路径；这里只补删仍是我们那个 socket（同 inode）的残留，绝不删别的文件。
      // 别的用户换不了这个路径，靠的是父目录 0700（assertPrivateSocketDir）。
      const st = isPipe ? null : lstatOrNull(socketPath);
      if (st?.isSocket() && st.ino === listenedIno) {
        try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ }
      }
      resolveClosed();
    })();
    return closePromise;
  }

  return {
    socketPath,
    closed,
    stats: buildStats,
    close,
  };
}

// ───────────────────────── 客户端 RPC ─────────────────────────

export function sendDaemonRequest(socketPath, method, params = {}, { timeoutMs = 0, uid } = {}) {
  try { assertTrustedSocket(socketPath, { uid }); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const id = ++reqSeq;
    let settled = false;
    let connected = false;
    let buf = '';
    const sock = net.createConnection(socketPath);
    sock.setEncoding('utf8');

    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const err = new CliError('timeout.daemon', `离屏守护进程响应超时（${timeoutMs} ms）：${socketPath}`, { hint: '检查守护进程状态或增大超时后重试' });
      if (!connected) err.daemonConnectError = true;
      reject(err);
    }, timeoutMs) : null;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sock.destroy();
      fn(val);
    };

    sock.once('connect', () => {
      connected = true;
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });

    sock.on('data', chunk => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx).trim();
      try {
        const msg = JSON.parse(line);
        finish(resolve, msg);
      } catch (e) {
        finish(reject, new CliError('failure.daemon-protocol', `守护进程返回了无法解析的响应：${e.message}`, null));
      }
    });

    sock.once('error', err => {
      const e = new CliError('env.daemon-unavailable', `连不上离屏守护进程 ${socketPath}（${err.code ?? err.message}）`, {
        hint: `先运行 node engine/offscreen/cli.mjs daemon --socket ${socketPath}，或改用 --daemon auto 自动退回冷启动`,
        cause: err,
      });
      if (!connected) e.daemonConnectError = true;
      finish(reject, e);
    });

    sock.once('end', () => {
      if (!settled) {
        finish(reject, new CliError('failure.daemon-closed', `守护进程在返回结果前断开连接：${socketPath}`, { hint: '检查守护进程日志，或重试（守护进程崩溃后重启即可自动清理旧 socket）' }));
      }
    });
  });
}
