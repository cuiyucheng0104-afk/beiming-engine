// 北冥引擎 · 离屏出片 · 单卡异构多作业并发调度器：
// 在同一个 Node 进程、同一个 GPUDevice 上并发执行一批不同作品、画幅、帧率、查询串的出片或静帧任务。
//   parseBatchJobs(input, { cwd, defaults }) → NormalizedJob[]   只读校验全部作业（路径在仓库内、画幅偶数、输出不重名），有问题抛 usage.*
//   runBatch(jobs, { gpu, device, concurrency = 4, maxEncoders = 4, failFast = false, onJobDone, onCleanup })
//     → Promise<{ ok, total, succeeded, failed, seconds, adapter, results, outputs }>
//     每个作业独享一个 Host（共用同一个 GPUDevice），编码器由独立信号量限流（防止消费级显卡并发开过多 NVENC 会话报错）；
//     单个作业报错自动中止其编码器并清理半成品，不污染共用设备与其他作业。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError, usageError } from '../../tools/lib/cli.mjs';
import { encodePng } from '../../tools/plates/png.mjs';
import { probe } from '../render/lib/ffmpeg.mjs';
import { loadGpu } from './load.mjs';
import { createHost } from './host.mjs';
import { renderFrames, renderFrameList } from './frames.mjs';
import { ENCODERS, PIX_FMTS, startEncoder } from './encode.mjs';
import { parseFrameList, parseSize, resolveWork } from './cli.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const shaHex = buf => createHash('sha256').update(buf).digest('hex');
const elapsed = since => Number(process.hrtime.bigint() - since) / 1e9;
const repoRel = p => {
  const r = path.relative(ROOT, p);
  return r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/');
};

function createSemaphore(limit) {
  const max = Math.max(1, limit | 0);
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < max) { active++; return; }
      await new Promise(r => waiters.push(r));
      active++;
    },
    release() {
      active--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

export function parseBatchJobs(input, { cwd = process.cwd(), manifestDir = null, defaults = {} } = {}) {
  const rawList = Array.isArray(input) ? input : (input && typeof input === 'object' && Array.isArray(input.jobs) ? input.jobs : null);
  if (!rawList) throw usageError('bad-manifest', '批量清单必须是作业数组或 { jobs: [...] } 对象', '见 offscreen batch --help');
  if (!rawList.length) throw usageError('empty-batch', '批量清单没有作业（jobs 为空）', '至少给 1 个作业');

  const seenOuts = new Set();
  return rawList.map((item, i) => {
    if (!item || typeof item !== 'object') throw usageError('bad-manifest', `第 ${i + 1} 项作业不是对象`, null);
    const id = String(item.id ?? `job-${i + 1}`);
    const mode = String(item.mode ?? defaults.mode ?? 'render');
    if (mode !== 'render' && mode !== 'stills') throw usageError('bad-value', `作业 ${id} 的 mode 只能是 render 或 stills，收到「${mode}」`, null);
    if (!item.work) throw usageError('missing-work', `作业 ${id} 缺少 work（作品模块路径）`, null);
    const workStr = String(item.work);
    const workBase = manifestDir && !path.isAbsolute(workStr) && fs.existsSync(path.resolve(manifestDir, workStr)) ? manifestDir : cwd;
    const file = resolveWork(workStr, workBase);
    if (!item.out) throw usageError('missing-out', `作业 ${id} 缺少 out（输出路径）`, null);
    const out = path.resolve(manifestDir || cwd, String(item.out));
    const outKey = process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out;
    if (seenOuts.has(outKey)) throw usageError('duplicate-out', `批量清单存在重复输出路径：${item.out}（作业 ${id}）`, '每个作业的 out 必须互不重叠');
    seenOuts.add(outKey);

    const [width, height] = parseSize(String(item.size ?? defaults.size ?? '1920x1080'));
    const fps = Number(item.fps ?? defaults.fps ?? 24);
    const inflight = Number(item.inflight ?? defaults.inflight ?? 3);
    if (!(Number.isInteger(fps) && fps >= 1)) throw usageError('bad-value', `作业 ${id} 的 fps 要是 ≥ 1 的整数，收到 ${item.fps}`, null);
    if (!(Number.isInteger(inflight) && inflight >= 1)) throw usageError('bad-value', `作业 ${id} 的 inflight 要是 ≥ 1 的整数，收到 ${item.inflight}`, null);

    const query = String(item.query ?? defaults.query ?? '');
    const framesSpec = item.frames ?? defaults.frames;
    if (!framesSpec) throw usageError('missing-frames', `作业 ${id} 缺少 frames`, mode === 'render' ? '例如 "0:96"' : '例如 "0,48,95"');

    if (mode === 'stills') {
      return { id, mode, file, out, frameList: parseFrameList(framesSpec), width, height, fps, inflight, query };
    }
    const fm = /^(\d+):(\d+)$/.exec(String(framesSpec).trim());
    if (!fm || +fm[2] <= +fm[1]) throw usageError('bad-value', `作业 ${id} 的 render frames 要写成 a:b 且止 > 起，收到「${framesSpec}」`, '例如 "0:96"');
    const encoder = String(item.encoder ?? defaults.encoder ?? 'x264');
    const pixFmt = String(item.pixFmt ?? item['pix-fmt'] ?? defaults.pixFmt ?? 'rgba');
    if (!ENCODERS.includes(encoder)) throw usageError('bad-value', `作业 ${id} 的 encoder 只能是 ${ENCODERS.join(' 或 ')}，收到「${encoder}」`, null);
    if (!PIX_FMTS.includes(pixFmt)) throw usageError('bad-value', `作业 ${id} 的 pixFmt 只能是 ${PIX_FMTS.join(' 或 ')}，收到「${pixFmt}」`, null);
    const crf = Number(item.crf ?? defaults.crf ?? 14);
    const cq = Number(item.cq ?? defaults.cq ?? 18);
    const preset = String(item.preset ?? defaults.preset ?? 'medium');
    return { id, mode, file, out, from: +fm[1], to: +fm[2], width, height, fps, inflight, query, encoder, pixFmt, crf, cq, preset };
  });
}

export async function runBatch(jobs, {
  gpu = null, device = null, concurrency = 4, maxEncoders = 4, failFast = false, onJobDone = null, onCleanup = null,
} = {}) {
  if (!(concurrency >= 1)) throw usageError('bad-value', `--concurrency 要 ≥ 1，收到 ${concurrency}`, null);
  if (!(maxEncoders >= 1)) throw usageError('bad-value', `--max-encoders 要 ≥ 1，收到 ${maxEncoders}`, null);
  const tBatch = process.hrtime.bigint();
  const loadedGpu = gpu || await loadGpu();
  let ownerHost = null;
  if (!device) {
    ownerHost = await createHost({ gpu: loadedGpu, width: 16, height: 16, fps: 24 });
    device = ownerHost.device;
  }
  const info = device.adapterInfo ?? {};
  const adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
  const encSem = createSemaphore(maxEncoders);

  const activeHosts = new Set();
  const activeEncoders = new Set();
  const activePartials = new Set();
  let aborted = false;

  const abortAll = async () => {
    aborted = true;
    await Promise.all([...activeEncoders].map(e => e.abort().catch(() => {})));
    activeEncoders.clear();
    for (const p of activePartials) fs.rmSync(p, { force: true });
    activePartials.clear();
    for (const h of activeHosts) { try { h.dispose(); } catch { /* 尽力清理 */ } }
    activeHosts.clear();
    if (ownerHost) { try { ownerHost.dispose(); } catch { /* 尽力清理 */ } ownerHost = null; }
  };
  const undo = onCleanup ? onCleanup(abortAll) : null;

  const results = new Array(jobs.length);
  const allOutputs = [];
  let nextIdx = 0, stopNew = false;

  async function executeOne(j, idx) {
    const t0 = process.hrtime.bigint();
    let host = null, enc = null, encHeld = false;
    const jobPartials = new Set();
    const addPartial = p => { jobPartials.add(p); activePartials.add(p); };
    const delPartial = p => { jobPartials.delete(p); activePartials.delete(p); };

    try {
      host = await createHost({ gpu: loadedGpu, width: j.width, height: j.height, fps: j.fps, device, query: j.query });
      activeHosts.add(host);
      const work = await host.load(j.file);

      if (j.mode === 'stills') {
        fs.mkdirSync(j.out, { recursive: true });
        const hashes = [], outs = [];
        const t1 = process.hrtime.bigint();
        await renderFrameList({
          host, work, frames: j.frameList, inflight: j.inflight,
          onFrame: async (f, px) => {
            hashes.push(sha16(px));
            const base = `f${String(f).padStart(6, '0')}.png`;
            const partial = path.join(j.out, `.${base}.partial-${process.pid}-${idx}`);
            const dst = path.join(j.out, base);
            addPartial(partial);
            const png = encodePng({ width: j.width, height: j.height, data: px, channels: 4 });
            fs.writeFileSync(partial, png);
            fs.renameSync(partial, dst);
            delPartial(partial);
            outs.push({ path: dst, sha256: shaHex(png), kind: 'image', job: j.id });
          },
        });
        const renderS = elapsed(t1);
        const res = {
          id: j.id, ok: true, mode: 'stills', work: repoRel(j.file), out: j.out,
          frames: j.frameList.length, width: j.width, height: j.height, fps: j.fps,
          seconds: +elapsed(t0).toFixed(2), renderFps: +(j.frameList.length / Math.max(renderS, 1e-6)).toFixed(1),
          frameHashes: hashes, outputs: outs,
        };
        return res;
      }

      fs.mkdirSync(path.dirname(j.out), { recursive: true });
      const partial = path.join(path.dirname(j.out), `.${path.basename(j.out, path.extname(j.out))}.partial-${process.pid}-${idx}.mp4`);
      addPartial(partial);
      await encSem.acquire();
      encHeld = true;
      enc = startEncoder({ width: j.width, height: j.height, fps: j.fps, out: partial, crf: j.crf, preset: j.preset, encoder: j.encoder, cq: j.cq, pixFmt: j.pixFmt });
      activeEncoders.add(enc);

      const total = j.to - j.from, hashes = [];
      const t1 = process.hrtime.bigint();
      await renderFrames({
        host, work, from: j.from, to: j.to, inflight: j.inflight, format: j.pixFmt,
        onFrame: async (_f, px) => {
          hashes.push(sha16(px));
          await enc.write(px);
        },
      });
      await enc.finish();
      activeEncoders.delete(enc);
      enc = null;
      encSem.release();
      encHeld = false;

      const renderS = elapsed(t1);
      const gotFrames = (await probe(partial)).video?.frames;
      if (gotFrames !== total) throw new CliError('contract.frame-count', `作业 ${j.id} 编出来是 ${gotFrames} 帧，应为 ${total} 帧`, null);
      fs.renameSync(partial, j.out);
      delPartial(partial);
      const outEntry = { path: j.out, sha256: shaHex(fs.readFileSync(j.out)), kind: 'video', job: j.id };
      return {
        id: j.id, ok: true, mode: 'render', work: repoRel(j.file), out: j.out,
        frames: total, from: j.from, to: j.to, width: j.width, height: j.height, fps: j.fps, pixFmt: j.pixFmt, encoder: j.encoder,
        seconds: +elapsed(t0).toFixed(2), renderFps: +(total / Math.max(renderS, 1e-6)).toFixed(1),
        frameHashes: hashes, outputs: [outEntry],
      };
    } catch (e) {
      if (enc) {
        activeEncoders.delete(enc);
        await enc.abort().catch(() => {});
        enc = null;
      }
      for (const p of jobPartials) {
        fs.rmSync(p, { force: true });
        activePartials.delete(p);
      }
      jobPartials.clear();
      if (failFast) stopNew = true;
      return {
        id: j.id, ok: false, mode: j.mode, work: repoRel(j.file), out: j.out,
        seconds: +elapsed(t0).toFixed(2),
        error: { code: e?.code || 'failure.job', message: String(e?.message ?? e) },
        outputs: [],
      };
    } finally {
      if (encHeld) encSem.release();
      if (host) {
        activeHosts.delete(host);
        try { host.dispose(); } catch { /* 已销毁 */ }
      }
    }
  }

  try {
    const workerCount = Math.min(concurrency, jobs.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!stopNew && !aborted) {
        const idx = nextIdx++;
        if (idx >= jobs.length) break;
        const r = await executeOne(jobs[idx], idx);
        results[idx] = r;
        if (r.ok && r.outputs?.length) allOutputs.push(...r.outputs);
        onJobDone?.(r, idx);
      }
    }));
  } finally {
    undo?.();
    for (const h of activeHosts) { try { h.dispose(); } catch { /* 忽略 */ } }
    activeHosts.clear();
    if (ownerHost) { ownerHost.dispose(); ownerHost = null; }
  }

  const validResults = results.filter(Boolean);
  const succeeded = validResults.filter(r => r.ok).length;
  const failed = validResults.length - succeeded;
  const totalFrames = validResults.filter(r => r.ok).reduce((s, r) => s + (r.frames || 0), 0);
  const secs = +elapsed(tBatch).toFixed(2);
  return {
    ok: failed === 0 && validResults.length === jobs.length,
    total: jobs.length,
    completed: validResults.length,
    succeeded,
    failed,
    totalFrames,
    seconds: secs,
    totalFps: +(totalFrames / Math.max(secs, 1e-6)).toFixed(1),
    adapter,
    results: validResults,
    outputs: allOutputs.map(({ path: p, sha256, kind }) => ({ path: p, sha256, kind })),
  };
}
