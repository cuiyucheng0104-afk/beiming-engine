// 北冥引擎 · 机器级渲染槽位与共享 GPU 守卫（video / shots 调用；B 路线 native.mjs 可直接复用 checkSharedGpu / guardGpu）。
//
// 渲染槽位（可选）：设了 RENDER_SLOTS=N（或 --slots N）时，这台机器同时最多 N 个整片渲染，多出来的排队，前一个结束后自动开始。
//   方法借鉴 cases/vendor/lemo-opuscar/core/render/slot.mjs@bebbbe1（目录即槽位、心跳、过期接管、mkdir 互斥），这里是独立实现：
//   - 槽位目录：BEIMING_SLOT_DIR，默认 <系统临时目录>/beiming-render-slots-<用户>；所有检出共用（只读仓库也能用）
//   - 一个槽位 = 一个子目录 slot<i>，里面 owner.json 记持有者，持有者每 15 秒刷新它的修改时间
//   - 持有者进程已不在（同一台机器）或心跳超过 90 秒没动 → 槽位过期，可接管；所有“查看 → 接管 / 占用”都在 .mutex 目录锁里做
//   - 外层调度已经替这次渲染占了槽位（BEIMING_SLOT_HELD=1）时直接放行
//   acquireSlot({ slots, wait, timeoutMs, signal, log, label }) → release()；满了且 wait=false → 退出码 5；等超时 → 退出码 124
//
// 共享 GPU 守卫：机器上有 nvidia-smi 时（Windows / Linux 的 NVIDIA 工作站）开渲前采样一次——任一块卡占用率高于
//   BEIMING_GPU_BUSY_UTIL（默认 10%）、或空闲显存低于 BEIMING_GPU_MIN_FREE_MB（默认 2048），或 ComfyUI 队列（COMFY_URL，
//   默认 http://127.0.0.1:8188）里有任务，就算“正忙”：默认每 15 秒再看一次直到空闲（--wait-timeout 秒后放弃，退出码 124），
//   --no-wait 时直接退出码 5。从不终止别人的进程。没有 nvidia-smi（macOS）时守卫不起作用，记 available=false。
//   checkSharedGpu() → { available, busy, reasons[], gpus[], comfy }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RenderError } from './errors.mjs';
import { alive } from './lock.mjs';

const BEAT_MS = 15000, STALE_MS = 90000, MUTEX_STALE_MS = 10000;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
const user = () => { try { return os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_'); } catch { return 'user'; } };
export const slotDir = () => process.env.BEIMING_SLOT_DIR || path.join(os.tmpdir(), `beiming-render-slots-${user()}`);
const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const readOwner = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8')); } catch { return null; } };

function stale(d) {
  const o = readOwner(d);
  if (!o) return Date.now() - mtime(d) > MUTEX_STALE_MS;
  if (o.host === os.hostname() && !alive(o.pid)) return true;
  return Date.now() - mtime(path.join(d, 'owner.json')) > STALE_MS;
}

function withMutex(dir, fn) {
  const m = path.join(dir, '.mutex');
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(m); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - mtime(m) > MUTEX_STALE_MS) { try { fs.rmdirSync(m); } catch {} continue; }
      const t = Date.now() + 5 + (i % 7); while (Date.now() < t) { /* 极短的自旋：持锁者只做几次文件操作 */ }
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(m); } catch {} }
}

/** 试着占一个槽位；占到返回目录，满了返回 null（导出给测试） */
export function tryTake(dir, slots, label) {
  return withMutex(dir, () => {
    for (let i = 0; i < slots; i++) {
      const d = path.join(dir, `slot${i}`);
      if (fs.existsSync(d)) {
        if (!stale(d)) continue;
        const tomb = `${d}.stale-${process.pid}-${Date.now()}`;
        try { fs.renameSync(d, tomb); fs.rmSync(tomb, { recursive: true, force: true }); } catch { continue; }
      }
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString(), label }));
      return d;
    }
    return null;
  });
}

export function slotCount(value = process.env.RENDER_SLOTS) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new RenderError('usage.bad-value', `RENDER_SLOTS / --slots 必须是 1–256 的整数（收到 ${value}）`, { hint: '不限槽位就不设 RENDER_SLOTS' });
  return n;
}

export async function acquireSlot({ slots = slotCount(), wait = true, timeoutMs = Infinity, signal, log, label = path.basename(process.argv[1] || 'render') } = {}) {
  if (!slots || process.env.BEIMING_SLOT_HELD === '1') return Object.assign(() => {}, { info: { slots: slots ?? null, held: process.env.BEIMING_SLOT_HELD === '1' } });
  const dir = slotDir();
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    const d = tryTake(dir, slots, label);
    if (d) {
      const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(path.join(d, 'owner.json'), t, t); } catch {} }, BEAT_MS);
      beat.unref();
      let done = false;
      const release = () => {
        if (done) return; done = true; clearInterval(beat); process.removeListener('exit', release);
        if (readOwner(d)?.pid === process.pid) { const tomb = `${d}.rel-${process.pid}-${Date.now()}`; try { fs.renameSync(d, tomb); fs.rmSync(tomb, { recursive: true, force: true }); } catch {} }
      };
      process.on('exit', release);
      return Object.assign(release, { info: { slots, slot: path.basename(d), waitedSeconds: +((Date.now() - t0) / 1000).toFixed(1) } });
    }
    if (!wait) throw new RenderError('busy.slots-full', `这台机器的 ${slots} 个渲染槽位都占着（RENDER_SLOTS=${slots}）`, { hint: '等别的渲染结束后重试，或去掉 --no-wait 让它排队' });
    if (Date.now() - t0 > timeoutMs) throw new RenderError('timeout.slot', `等渲染槽位超过 ${timeoutMs / 1000} 秒`, { hint: '槽位一直满：看看是不是有渲染卡住了（槽位目录在系统临时目录的 beiming-render-slots-<用户> 下，可用 BEIMING_SLOT_DIR 改）' });
    if (n % 15 === 0) log?.info(`排队等渲染槽位（最多 ${slots} 个同时渲染）…`);
    await sleep(2000, signal);
  }
}

// ── 共享 GPU ──

function nvidiaSmi() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim().split('\n').filter(Boolean).map(l => {
    const [name, util, used, total] = l.split(',').map(s => s.trim());
    return { name, util: Number(util), memUsedMB: Number(used), memTotalMB: Number(total) };
  });
}

async function comfyQueue(url) {
  try {
    const r = await fetch(new URL('/queue', url), { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { running: (j.queue_running ?? []).length, pending: (j.queue_pending ?? []).length };
  } catch { return null; }
}

export async function checkSharedGpu({ env = process.env } = {}) {
  const gpus = nvidiaSmi();
  if (!gpus) return { available: false, busy: false, reasons: [], gpus: [], comfy: null };
  const maxUtil = Number(env.BEIMING_GPU_BUSY_UTIL ?? 10), minFree = Number(env.BEIMING_GPU_MIN_FREE_MB ?? 2048);
  const reasons = [];
  for (const g of gpus) {
    if (g.util > maxUtil) reasons.push(`${g.name} 占用率 ${g.util}%（上限 ${maxUtil}%）`);
    if (g.memTotalMB - g.memUsedMB < minFree) reasons.push(`${g.name} 空闲显存 ${g.memTotalMB - g.memUsedMB} MB（至少 ${minFree} MB）`);
  }
  const comfy = await comfyQueue(env.COMFY_URL || 'http://127.0.0.1:8188');
  if (comfy && comfy.running + comfy.pending > 0) reasons.push(`ComfyUI 队列里有 ${comfy.running} 个在跑、${comfy.pending} 个在等`);
  return { available: true, busy: reasons.length > 0, reasons, gpus, comfy };
}

/** 开渲前的守卫：忙就等（或 wait=false 时退出码 5）；返回写进 run.json 的采样 */
export async function guardGpu({ enabled = true, wait = true, timeoutMs = 30 * 60 * 1000, signal, log } = {}) {
  if (!enabled) return { checked: false };
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    const s = await checkSharedGpu();
    if (!s.available || !s.busy) return { checked: true, ...s, waitedSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
    const why = s.reasons.join('；');
    if (!wait) throw new RenderError('busy.gpu', `共享 GPU 正忙：${why}`, { hint: '等它空下来再渲（去掉 --no-wait 会自动排队），或在独占的时段渲；不要终止别人的任务' });
    if (Date.now() - t0 > timeoutMs) throw new RenderError('timeout.gpu-busy', `等共享 GPU 空闲超过 ${Math.round(timeoutMs / 1000)} 秒：${why}`, { hint: '共享 GPU 一直被占：和占用者协调时段，或加 --no-guard 明知故犯（会拖慢别人的任务）' });
    if (n % 4 === 0) log?.info(`共享 GPU 正忙（${why}），15 秒后再看…`);
    await sleep(15000, signal);
  }
}
