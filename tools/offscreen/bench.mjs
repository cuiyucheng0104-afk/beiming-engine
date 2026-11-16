#!/usr/bin/env node
// 北冥仓库 · 离屏出片 · 同进程多部片并发基准：一个 Node 进程、一个 GPUDevice 里同时出 N 部片，量总吞吐，并核对并发不改变像素。
//   node tools/offscreen/bench.mjs <作品.mjs> [--films 1,2,4,8] [--frames 96] [--size 1920x1080] [--fps 24] [--inflight 3] [--encode] [--json]
// 每一档：第一个宿主建 GPUDevice，其余用 createHost({ device }) 共用它；每部片各自一个渲染器、渲染目标和作品实例，同时 renderFrames。
// 「确定」的判据：独立验证遍的每部片每一帧 sha256 前 16 位与单部片基线相同；计时遍不算哈希，避免测量自身卡住主线程。
// --encode：每部片各接一个 FFmpeg（输出到临时目录），量带编码的吞吐；CPU 编码会先成为瓶颈，所以不带与带各测一次。
// 信封 data：{ work, size, fps, frames, encode, adapter, runs: [{ films, totalFrames, seconds, totalFps, perFilmFps, deterministic }] }
// 计时用 process.hrtime；这个文件不在渲染路径上。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { defineCommand, isMain, runCli, usageError } from '../lib/cli.mjs';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { renderFrames } from '../../engine/offscreen/frames.mjs';
import { startEncoder } from '../../engine/offscreen/encode.mjs';
import { resolveWork, parseSize } from '../../engine/offscreen/cli.mjs';

const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const elapsed = since => Number(process.hrtime.bigint() - since) / 1e9;

export function parseFilms(s) {
  const parts = String(s ?? '').split(',').map(x => x.trim());
  if (!parts.length || parts.some(x => !/^[1-9]\d*$/.test(x))) throw usageError('bad-value', `--films 要写成逗号分隔的正整数，收到「${s}」`, '例如 --films 1,2,4,8');
  return parts.map(Number);
}

/** 一个进程里同时出 n 部片；返回 { seconds, hashes: string[][]（每部片的逐帧哈希） } */
export async function runFilms({ gpu, n, file, width, height, fps, frames, inflight, encode, tmp, verify = false }) {
  const first = await createHost({ gpu, width, height, fps });
  const hosts = [first];
  for (let i = 1; i < n; i++) hosts.push(await createHost({ gpu, width, height, fps, device: first.device }));
  const works = [];
  for (const h of hosts) works.push(await h.load(file));
  const encoders = encode ? hosts.map((_, i) => startEncoder({ width, height, fps, out: path.join(tmp, `film-${n}-${i}.mp4`) })) : [];
  const hashes = hosts.map(() => []);
  const t0 = process.hrtime.bigint();
  try {
    await Promise.all(hosts.map((host, i) => renderFrames({
      host, work: works[i], from: 0, to: frames, inflight,
      onFrame: async (f, px) => { if (verify) hashes[i][f] = sha16(px); if (encode) await encoders[i].write(px); },
    })));
    if (encode) await Promise.all(encoders.map(e => e.finish()));
  } catch (e) {
    await Promise.all(encoders.map(x => x.abort().catch(() => {})));
    throw e;
  } finally {
    // 先放掉后建的、共用 first 的设备的宿主，最后放 first（它的 dispose 会销毁自己建的设备）
    for (const h of hosts.slice(1)) h.dispose();
    first.dispose();
  }
  return { seconds: elapsed(t0), hashes, adapter: first.device.adapterInfo };
}

export const command = defineCommand({
  name: 'offscreen-bench',
  summary: '离屏出片的单卡并发基准：同一进程、同一 GPUDevice 里同时出 N 部片，量总吞吐并核对并发不改变像素',
  usage: ['node tools/offscreen/bench.mjs <作品.mjs> [--films 1,2,4,8] [--frames 96] [--size 1920x1080] [--fps 24] [--inflight 3] [--encode] [--json]'],
  positionals: [{ name: 'work', label: '<作品.mjs>', describe: '作品模块（仓库内）', required: true }],
  options: {
    films: { type: 'string', default: '1,2,4,8', arg: '<n,n,…>', describe: '要测的并发部数（默认 1,2,4,8）' },
    frames: { type: 'integer', default: 96, arg: '<n>', describe: '每部片的帧数（默认 96）' },
    size: { type: 'string', default: '1920x1080', arg: '<WxH>', describe: '画幅（默认 1920x1080）' },
    fps: { type: 'integer', default: 24, arg: '<n>', describe: '帧率（默认 24）' },
    inflight: { type: 'integer', default: 3, arg: '<n>', describe: '每部片同时在途的读回帧数（默认 3）' },
    encode: { type: 'boolean', describe: '每部片各接一个 FFmpeg 编码器（输出到临时目录，测完删掉）' },
  },
  exitCodes: { 0: '成功', 1: '渲染失败', 2: '用法错误', 3: '缺可选依赖或拿不到 GPU' },
  examples: ['node tools/offscreen/bench.mjs lab/offscreen/ink.mjs --films 1,2,4,8 --frames 96'],
  async run(ctx) {
    const file = resolveWork(ctx.args.work);
    const [width, height] = parseSize(ctx.opts.size);
    const films = parseFilms(ctx.opts.films);
    const { frames, fps, inflight, encode } = ctx.opts;
    if (!(frames >= 1)) throw usageError('bad-value', `--frames 要是正整数，收到 ${frames}`, null);
    if (!(inflight >= 1)) throw usageError('bad-value', `--inflight 要 ≥ 1，收到 ${inflight}`, null);
    const gpu = await loadGpu();
    const tmp = encode ? fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-offscreen-bench-')) : null;
    ctx.onCleanup(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
    const common = { gpu, file, width, height, fps, frames, inflight, encode, tmp };
    let baseline, adapter;
    const runs = [];
    try {
      // 预热一次（着色器编译、管线创建），并取「单部片」的逐帧哈希当基线；不计入结果
      const warm = await runFilms({ ...common, n: 1, encode: false, verify: true });
      baseline = warm.hashes[0];
      const info = warm.adapter ?? {};
      adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
      for (const n of films) {
        const r = await runFilms({ ...common, n });
        const total = n * frames;
        // 验证遍单独跑，不把逐帧 sha256 的 CPU 成本算进渲染吞吐
        const verified = await runFilms({ ...common, n, encode: false, verify: true });
        const deterministic = verified.hashes.every(h => h.length === frames && h.every((x, f) => x === baseline[f]));
        const row = { films: n, totalFrames: total, seconds: +r.seconds.toFixed(2), totalFps: +(total / r.seconds).toFixed(1), perFilmFps: +(frames / r.seconds).toFixed(1), deterministic };
        runs.push(row);
        ctx.out(`${String(n).padStart(2)} 部并发：${total} 帧 ${row.seconds}s  总 ${row.totalFps} 帧/秒（每部 ${row.perFilmFps}）${deterministic ? '' : '  ⚠ 像素与单部片不同'}`);
      }
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { data: { work: path.relative(process.cwd(), file), size: `${width}x${height}`, fps, frames, encode, adapter, runs } };
  },
});

if (isMain(import.meta.url)) runCli(command);
