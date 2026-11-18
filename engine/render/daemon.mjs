// 北冥引擎 · 常驻热浏览器守护进程（still --daemon 调用，亦可独立管理）：保持无头浏览器与静态服务热驻留，
// 跟踪页面实际加载过的每个本地文件指纹，源文件改动时自动热重载页面，把静帧抽检从数秒冷启动压到毫秒级。
// 借鉴 Leonxlnx/shanshui 调色预览热实例的设计思路，按北冥命令信封与错误码规范独立实现。
//
//   node engine/render/daemon.mjs start  [<影片目录>] [--state-file <文件>] [--idle-timeout 1800] [选项]
//   node engine/render/daemon.mjs status [--state-file <文件>] [--json]
//   node engine/render/daemon.mjs stop   [--state-file <文件>] [--json]
//   node engine/render/daemon.mjs serve  [<影片目录>] [--port 0] [--state-file <文件>] [--idle-timeout 1800]
//
//   defaultStateFile()                      当前仓库与用户的默认状态文件路径（系统临时目录下，mode 0600）
//   ensureDaemon(opts)                      确认守护进程存活（未启动则拉起后台进程并等就绪），返回状态描述
//   requestDaemon(stateFile, path, body)    向守护进程发带口令的本地 HTTP 请求，还原 RenderError 错误码与退出码
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain, runCli } from '../../tools/lib/cli.mjs';
import { openFilm, locateFilm, renderFrame, closeServer, ROOT } from './page.mjs';
import { RenderError, describeError } from './lib/errors.mjs';
import { renderCommand, pickOptions, positiveNumber } from './lib/command.mjs';
import { resolveAngle, resolveGpuPolicy } from './lib/gpu.mjs';
import { alive } from './lib/lock.mjs';
import { sha256 } from './lib/record.mjs';
import { captureGpuFrame } from './lib/yuv.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const userTag = () => { try { return os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_'); } catch { return 'user'; } };

export function defaultStateFile() {
  return path.join(os.tmpdir(), `beiming-render-daemon-${userTag()}-${sha256(ROOT).slice(0, 12)}.json`);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function fileStamp(rel) {
  try {
    const st = fs.statSync(path.join(ROOT, rel));
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

export function requestDaemon(state, routePath, body = null, { timeoutMs = 180000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port: state.port,
      path: routePath,
      method: body === null ? 'GET' : 'POST',
      headers: {
        'X-Beiming-Token': state.token,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (res.statusCode >= 400 || parsed.ok === false) {
            const err = parsed.error ?? {};
            return reject(new RenderError(err.code || 'failure.internal', err.message || `守护进程返回 HTTP ${res.statusCode}`, {
              hint: err.hint ?? null,
              exitCode: err.exitCode,
            }));
          }
          resolve(parsed);
        } catch (e) {
          reject(new RenderError('failure.internal', `守护进程响应无法解析：${e.message}`));
        }
      });
    });
    const onAbort = () => { try { req.destroy(); } catch {} reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => {
      req.destroy();
      reject(new RenderError('timeout.frame', '等待常驻渲染守护进程响应超时', { hint: '用 node engine/render/daemon.mjs stop 重启守护进程或调大 --frame-timeout' }));
    });
    req.on('error', e => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function probeDaemon(stateFile) {
  const st = readState(stateFile);
  if (!st || !st.pid || !st.port || !st.token) return null;
  if (!alive(st.pid)) {
    try { fs.rmSync(stateFile, { force: true }); } catch {}
    return null;
  }
  try {
    const r = await requestDaemon(st, '/status', null, { timeoutMs: 2500 });
    return { ...st, status: r };
  } catch {
    return null;
  }
}

export async function ensureDaemon({
  stateFile = defaultStateFile(), idleTimeout = 1800, warmDir = null, gpu, angle, signal,
} = {}) {
  const existing = await probeDaemon(stateFile);
  if (existing) return { ...existing, started: false };

  const args = [THIS_FILE, 'serve', ...(warmDir ? [warmDir] : []), '--state-file', stateFile, '--idle-timeout', String(idleTimeout)];
  if (gpu) args.push('--gpu', gpu);
  if (angle) args.push('--angle', angle);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const ready = await probeDaemon(stateFile);
    if (ready) return { ...ready, started: true };
    if (child.exitCode !== null) break;
    await sleep(80);
  }
  throw new RenderError('timeout.ready', '常驻渲染守护进程未能在 20 秒内就绪', {
    hint: '运行 node engine/render/daemon.mjs serve --gpu software-ok 查看前台报错',
  });
}

export const command = renderCommand({
  name: 'engine/render/daemon.mjs',
  summary: '管理常驻热 GPU 浏览器守护进程（start / status / stop / serve），供 still.mjs --daemon 秒级抽帧复用',
  usage: [
    'node engine/render/daemon.mjs start [<影片目录>] [--state-file <文件>] [--idle-timeout 1800]',
    'node engine/render/daemon.mjs status [--state-file <文件>] [--json]',
    'node engine/render/daemon.mjs stop [--state-file <文件>] [--json]',
    'node engine/render/daemon.mjs serve [<影片目录>] [--port 0] [--state-file <文件>]',
  ],
  positionals: [
    { name: 'action', label: '<start|status|stop|serve>', describe: '子动作：start 后台启动 | status 查看状态 | stop 停止 | serve 前台驻留' },
    { name: 'dir', label: '[<影片目录>]', describe: '启动时顺带预热的影片目录（可选）', required: false },
  ],
  options: {
    'state-file': { type: 'string', arg: '<文件>', describe: '守护进程状态文件（默认系统临时目录下按仓库隔离）' },
    port: { type: 'integer', min: 0, max: 65535, default: 0, arg: '<端口>', describe: 'serve 监听端口（默认 0 自动分配）' },
    'idle-timeout': { type: 'number', default: 1800, arg: '<秒>', describe: '空闲多久后自动退出（默认 1800 秒）' },
    ...pickOptions(['size', 'query', 'gpu', 'angle', 'ready-timeout', 'progress']),
  },
  examples: [
    'node engine/render/daemon.mjs start .                       后台拉起热浏览器并预热样片',
    'node engine/render/still.mjs . 0.5 --daemon --out out/s     复用热浏览器毫秒级出静帧',
    'node engine/render/daemon.mjs stop                          关闭常驻守护进程',
  ],
}, main);

async function main({ opts, args, log, life, signal }) {
  const action = args.action;
  if (!['start', 'status', 'stop', 'serve'].includes(action)) {
    throw new RenderError('usage.bad-value', `不认识的子动作「${action}」`, { hint: '子动作只能是 start、status、stop 或 serve' });
  }
  const stateFile = path.resolve(opts['state-file'] ?? defaultStateFile());
  positiveNumber(opts['idle-timeout'], '--idle-timeout');
  if (opts['ready-timeout']) positiveNumber(opts['ready-timeout'], '--ready-timeout');
  if (opts.gpu) resolveGpuPolicy(opts.gpu);
  if (opts.angle) resolveAngle(opts.angle);
  if (args.dir) locateFilm(args.dir);

  if (action === 'status') {
    const d = await probeDaemon(stateFile);
    if (!d) {
      log.info('常驻渲染守护进程：未运行');
      return { data: { running: false, stateFile } };
    }
    log.info(`常驻渲染守护进程：运行中（PID ${d.pid}，127.0.0.1:${d.port}，已渲染 ${d.status.renders} 次）`);
    return { data: { running: true, pid: d.pid, port: d.port, stateFile, ...d.status } };
  }

  if (action === 'stop') {
    const st = readState(stateFile);
    if (!st || !alive(st.pid)) {
      try { fs.rmSync(stateFile, { force: true }); } catch {}
      log.info('常驻渲染守护进程本来就没在跑');
      return { data: { stopped: false, wasRunning: false } };
    }
    try {
      await requestDaemon(st, '/stop', {}, { timeoutMs: 5000 });
    } catch {
      try { process.kill(st.pid, 'SIGTERM'); } catch {}
    }
    const end = Date.now() + 5000;
    while (Date.now() < end && alive(st.pid)) await sleep(50);
    try { fs.rmSync(stateFile, { force: true }); } catch {}
    log.info(`已停止常驻渲染守护进程（PID ${st.pid}）`);
    return { data: { stopped: true, pid: st.pid } };
  }

  if (action === 'start') {
    const d = await ensureDaemon({
      stateFile,
      idleTimeout: opts['idle-timeout'],
      warmDir: args.dir ?? null,
      gpu: opts.gpu ?? undefined,
      angle: opts.angle ?? undefined,
      signal,
    });
    log.info(`常驻渲染守护进程就绪：PID ${d.pid}，127.0.0.1:${d.port}（${d.started ? '新启动' : '复用已有进程'}）`);
    return { data: { running: true, started: d.started, pid: d.pid, port: d.port, stateFile } };
  }

  // action === 'serve'：前台驻留事件循环，直到空闲超时、收到 /stop 或信号
  return runServeLoop({ opts, args, stateFile, log, life, signal });
}

async function runServeLoop({ opts, args, stateFile, log, life, signal }) {
  const token = randomBytes(24).toString('hex');
  const idleMs = opts['idle-timeout'] * 1000;
  let lastActive = Date.now();
  let renders = 0;
  let active = null; // { key, film, stamps: Map<rel, stamp>, rel }
  let queue = Promise.resolve();

  const closeActive = async () => {
    const cur = active;
    active = null;
    if (cur?.film) await cur.film.close().catch(() => {});
  };
  life.closer(closeActive);
  life.closer(closeServer);
  life.defer(() => {
    const st = readState(stateFile);
    if (st?.pid === process.pid) {
      try { fs.rmSync(stateFile, { force: true }); } catch {}
    }
  });

  const enqueue = fn => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const ensureFilmLoaded = async spec => {
    const { rel } = locateFilm(spec.dir);
    const key = JSON.stringify({
      rel, w: spec.w, h: spec.h, query: spec.query || '',
      gpu: spec.gpu ?? null, angle: spec.angle ?? null,
      allowNetwork: Boolean(spec.allowNetwork),
      lenientAssets: Boolean(spec.lenientAssets),
      allowGlErrors: Boolean(spec.allowGlErrors),
      fps: spec.render?.fps ?? null,
      profile: spec.render?.profile ?? null,
      frameCount: spec.render?.frameCount ?? null,
    });

    let reloaded = false;
    if (active && active.key === key) {
      let healthy = true;
      try { active.film.check(); } catch { healthy = false; }
      if (healthy) {
        for (const [p, oldStamp] of active.stamps) {
          if (fileStamp(p) !== oldStamp) { healthy = false; reloaded = true; break; }
        }
      }
      if (healthy) return { film: active.film, reloaded: false };
    } else if (active) {
      reloaded = true;
    }

    await closeActive();
    const film = await openFilm(spec.dir, {
      w: spec.w, h: spec.h, query: spec.query || '',
      gpu: spec.gpu ?? undefined, angle: spec.angle ?? undefined,
      allowNetwork: Boolean(spec.allowNetwork),
      lenientAssets: Boolean(spec.lenientAssets),
      allowGlErrors: Boolean(spec.allowGlErrors),
      readyTimeoutMs: spec.readyTimeoutMs,
      render: spec.render ?? null,
      handleSignals: false,
      signal,
    });
    const stamps = new Map();
    for (const [p, status] of film.requests) {
      if (status >= 200 && status < 400) stamps.set(p, fileStamp(p));
    }
    active = { key, rel, film, stamps };
    return { film, reloaded };
  };

  let resolveExit;
  const exitPromise = new Promise(r => { resolveExit = r; });
  signal.addEventListener('abort', () => resolveExit(), { once: true });

  const server = http.createServer((req, res) => {
    lastActive = Date.now();
    const reply = (status, obj) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
      res.end(body);
    };
    const host = String(req.headers.host || '');
    if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
      return reply(403, { ok: false, error: { code: 'failure.internal', message: '只接受本机回环请求', exitCode: 1 } });
    }
    if (req.headers['x-beiming-token'] !== token) {
      return reply(403, { ok: false, error: { code: 'failure.internal', message: '守护进程口令不匹配', exitCode: 1 } });
    }
    if (req.method === 'GET' && req.url === '/status') {
      return reply(200, {
        ok: true,
        pid: process.pid,
        renders,
        loadedFilm: active?.rel ?? null,
        trackedFiles: active ? active.stamps.size : 0,
        idleSeconds: +((Date.now() - lastActive) / 1000).toFixed(1),
      });
    }
    if (req.method === 'POST' && req.url === '/stop') {
      reply(200, { ok: true, stopping: true });
      setTimeout(() => resolveExit(), 10);
      return;
    }
    if (req.method === 'POST' && req.url === '/render') {
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', () => {
        enqueue(async () => {
          lastActive = Date.now();
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
            return reply(400, { ok: false, error: { code: 'usage.bad-value', message: '请求体不是合法 JSON', exitCode: 2 } });
          }
          try {
            const { film, reloaded } = await ensureFilmLoaded(body);
            if (body.probeOnly) {
              return reply(200, { ok: true, reloaded, info: film.info, contract: film.contract, warnings: film.warnings });
            }
            const settle = body.settle === 'auto' ? (film.info.angle === 'vulkan' ? 'raf2' : 'none') : (body.settle ?? 'none');
            const samples = body.samples ?? 1;
            const shutter = body.shutter ?? 0.5;
            const format = body.format ?? 'png';
            let img;
            if (samples > 1 || format === 'yuv420') {
              img = await captureGpuFrame(film, body.t, {
                w: body.w, h: body.h, format, quality: body.quality ?? 92,
                samples, shutter, fps: body.fps ?? 24, dur: film.contract?.dur ?? Infinity,
                timeoutMs: body.frameTimeoutMs, settle, where: body.where ?? `t=${body.t}`, signal,
              });
            } else {
              await renderFrame(film, body.t, { timeoutMs: body.frameTimeoutMs, settle, where: body.where ?? `t=${body.t}`, signal });
              img = await film.capture(format, body.quality ?? 92);
              film.check();
            }
            // 更新动态加载的新文件指纹
            for (const [p, status] of film.requests) {
              if (status >= 200 && status < 400 && !active.stamps.has(p)) active.stamps.set(p, fileStamp(p));
            }
            let textsRaw = null;
            if (body.texts) {
              textsRaw = await film.page.evaluate(async x => {
                if (typeof window.TEXTS !== 'function') return { missing: true };
                try {
                  let v = window.TEXTS(x);
                  if (v && typeof v.then === 'function') v = await v;
                  return { value: JSON.parse(JSON.stringify(v ?? null)) };
                } catch (e) {
                  return { error: String(e?.message ?? e) };
                }
              }, body.t);
            }
            renders++;
            lastActive = Date.now();
            return reply(200, {
              ok: true,
              reloaded,
              info: film.info,
              contract: film.contract,
              warnings: film.warnings,
              imgB64: img.toString('base64'),
              textsRaw,
            });
          } catch (e) {
            const d = describeError(e);
            return reply(422, { ok: false, error: d });
          }
        });
      });
      return;
    }
    return reply(404, { ok: false, error: { code: 'usage.bad-value', message: `未知接口 ${req.url}`, exitCode: 2 } });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', e => {
      const code = e.code === 'EADDRINUSE' ? 'busy.port' : 'env.listen';
      reject(new RenderError(code, `守护进程无法监听 127.0.0.1:${opts.port}（${e.message}）`, { hint: '换一个 --port 或不传让系统自动分配' }));
    });
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve(server.address().port));
  });
  life.closer(() => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }));

  if (args.dir) {
    await enqueue(() => ensureFilmLoaded({
      dir: args.dir,
      w: 1920, h: 1040,
      query: opts.query || '',
      gpu: opts.gpu ?? undefined,
      angle: opts.angle ?? undefined,
      readyTimeoutMs: opts['ready-timeout'] ? opts['ready-timeout'] * 1000 : undefined,
    }));
  }

  writeState(stateFile, { pid: process.pid, port, token, root: ROOT, startedAt: new Date().toISOString() });
  log.info(`守护进程已驻留 127.0.0.1:${port}（PID ${process.pid}，空闲上限 ${opts['idle-timeout']}s）`);

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActive > idleMs) resolveExit();
  }, Math.min(5000, Math.max(500, idleMs / 4)));
  idleTimer.unref();

  try {
    await exitPromise;
  } finally {
    clearInterval(idleTimer);
  }
  return { data: { stopped: true, renders, port } };
}

if (isMain(import.meta.url)) await runCli(command);
