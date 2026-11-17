#!/usr/bin/env node
// 北冥引擎 · 离屏出片 · 命令行：在 Node + Dawn 里渲作品模块（视频 render、无损静帧 stills、契约只读探测 probe）。
//   node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size 1920x1080] [--fps 24] [--inflight 3]
//                                       [--encoder x264|nvenc] [--crf 14] [--preset medium] [--cq 18] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs stills <作品.mjs> --out <目录> --frames 0,48,96|a:b[:step] [--size 1920x1080] [--fps 24] [--inflight 3] [--query k=v&…] [--json]
//   node engine/offscreen/cli.mjs probe  <作品.mjs> [--size 1920x1080] [--fps 24] [--query k=v&…] [--json]
// 退出码：0 · 1 渲染或编码失败 · 2 用法错误 · 3 缺可选依赖（webgpu、three-webgpu）· 4 契约或成片帧数不符。
// 计时用 process.hrtime（这个文件在确定性扫描的范围里，渲染路径之外也不用 performance.now）。
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, usageError } from '../../tools/lib/cli.mjs';
import { encodePng } from '../../tools/plates/png.mjs';
import { probe } from '../render/lib/ffmpeg.mjs';
import { loadGpu } from './load.mjs';
import { createHost } from './host.mjs';
import { renderFrames, renderFrameList } from './frames.mjs';
import { startEncoder } from './encode.mjs';
import { parseBatchJobs, runBatch } from './batch.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const shaHex = buf => createHash('sha256').update(buf).digest('hex');
const seconds = since => Number(process.hrtime.bigint() - since) / 1e9;
const repoRel = p => path.relative(ROOT, p).split(path.sep).join('/');

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
  if (!['render', 'stills', 'probe', 'batch'].includes(sub)) throw usageError('bad-subcommand', `未知子命令 ${sub}`, '可用：render、stills、probe、batch');
  if (sub === 'batch') {
    const items = [work, ...extra].filter(Boolean);
    if (!items.length) throw usageError('missing-work', 'batch 需要 <清单.json> 或至少一个 <作品.mjs>', '例如 offscreen batch jobs.json，或 offscreen batch a.mjs b.mjs --out-dir out/batch --frames 0:48');
    const defaults = {
      size: opts.size, fps: opts.fps, inflight: opts.inflight, query: opts.query,
      frames: opts.frames, encoder: opts.encoder, pixFmt: opts['pix-fmt'], crf: opts.crf, cq: opts.cq, preset: opts.preset,
    };
    if (items.length === 1 && items[0].toLowerCase().endsWith('.json')) {
      const mf = path.resolve(cwd, items[0]);
      if (!fs.existsSync(mf)) throw usageError('manifest-not-found', `找不到批量清单：${items[0]}`, null);
      let raw;
      try { raw = JSON.parse(fs.readFileSync(mf, 'utf8')); }
      catch (e) { throw usageError('bad-manifest', `批量清单不是合法 JSON：${e.message}`, null); }
      return { sub: 'batch', jobs: parseBatchJobs(raw, { cwd: path.dirname(mf), defaults }) };
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
  summary: '离屏出片：在 Node + Dawn 里渲作品模块，不经过浏览器（视频 render、静帧 stills、探测 probe、单卡并发 batch）',
  usage: [
    'node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size WxH] [--fps 24] [--inflight 3] [--encoder x264|nvenc] [--pix-fmt rgba|yuv420p] [--crf 14] [--preset medium] [--cq 18] [--query k=v&…] [--json]',
    'node engine/offscreen/cli.mjs stills <作品.mjs> --out <目录> --frames 0,48,96|a:b[:step] [--size WxH] [--fps 24] [--inflight 3] [--query k=v&…] [--json]',
    'node engine/offscreen/cli.mjs probe  <作品.mjs> [--size WxH] [--fps 24] [--query k=v&…] [--json]',
    'node engine/offscreen/cli.mjs batch  <清单.json | 作品.mjs…> [--out-dir <目录>] [--concurrency 4] [--max-encoders 4] [--fail-fast] [--json]',
  ],
  description: [
    '  offscreen render <作品.mjs>：逐帧流水线渲染并经 FFmpeg 编成有限范围 BT.709 的 H.264',
    '  offscreen stills <作品.mjs>：按帧号列表输出无损 PNG（f000048.png），不依赖 FFmpeg',
    '  offscreen probe  <作品.mjs>：只读校验作品 build(ctx) 契约与 GPU 适配器，不渲帧、不写盘',
    '  offscreen batch  <清单.json | 作品.mjs…>：单进程共用一个 GPUDevice 并发调度多作业（含编码限流与故障隔离）',
    '  需要可选依赖 webgpu 与 three-webgpu（npm install --include=optional --ignore-scripts）',
  ],
  positionals: [
    { name: 'sub', label: '<render|stills|probe|batch>', describe: '子命令', required: true },
    { name: 'work', label: '<作品.mjs | 清单.json>', describe: '作品模块（仓库内）或批量清单', required: false },
    { name: 'extra', label: '[更多作品…]', describe: 'batch 模式下直接列出多个作品模块', required: false, variadic: true },
  ],
  options: {
    out: { type: 'string', arg: '<路径>', describe: 'render 输出文件（.mp4）或 stills 输出目录' },
    'out-dir': { type: 'string', arg: '<目录>', describe: 'batch 多作品模式下的输出目录' },
    frames: { type: 'string', arg: '<帧>', describe: 'render/batch 用 a:b；stills 用 0,48,96 或 a:b[:step]' },
    size: { type: 'string', arg: '<WxH>', default: '1920x1080', describe: '画幅（偶数，默认 1920x1080）' },
    fps: { type: 'integer', default: 24, arg: '<n>', describe: '帧率（默认 24）' },
    inflight: { type: 'integer', default: 3, arg: '<n>', describe: '同时在途的读回帧数（默认 3；不改变成片）' },
    concurrency: { type: 'integer', default: 4, arg: '<n>', describe: 'batch 同时并发的渲染作业数（默认 4，共用一个 GPUDevice）' },
    'max-encoders': { type: 'integer', default: 4, arg: '<n>', describe: 'batch 同时打开的 FFmpeg / NVENC 编码会话上限（默认 4）' },
    'fail-fast': { type: 'boolean', describe: 'batch 遇到首个失败作业后不再启动后续作业' },
    encoder: { type: 'string', default: 'x264', choices: ['x264', 'nvenc'], arg: '<名字>', describe: '编码器（默认 x264；nvenc 走显卡，快一倍多，画质略低，母版不建议）' },
    'pix-fmt': { type: 'string', default: 'rgba', choices: ['rgba', 'yuv420p'], arg: '<格式>', describe: '读回与管道像素格式（默认 rgba；yuv420p 在 GPU 侧转有限范围 BT.709，省 62.5% 读回与 CPU swscale）' },
    crf: { type: 'integer', default: 14, arg: '<n>', describe: 'x264 crf（默认 14，与页面渲染器相同）' },
    cq: { type: 'integer', default: 18, arg: '<n>', describe: 'nvenc 恒定质量 cq（默认 18，数字小画质高）' },
    query: { type: 'string', default: '', arg: '<k=v&…>', describe: '交给作品 build 的查询串（同页面的 location.search，不带 ?；出片链的 --query 与预演的 previs=1 原样转来）' },
    preset: { type: 'string', default: 'medium', choices: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], arg: '<名字>', describe: 'x264 preset（默认 medium）' },
  },
  exitCodes: { 0: '成功', 1: '渲染或编码失败', 2: '用法错误', 3: '缺可选依赖', 4: '契约或成片帧数不符' },
  examples: [
    'node engine/offscreen/cli.mjs render lab/offscreen/ink.mjs --out out/offscreen/ink.mp4 --frames 0:96',
    'node engine/offscreen/cli.mjs stills lab/offscreen/ink.mjs --out out/offscreen/stills --frames 0,48,95',
    'node engine/offscreen/cli.mjs probe  lab/offscreen/ink.mjs',
    'node engine/offscreen/cli.mjs batch  films/chendu/offscreen.mjs lab/offscreen/ink.mjs --out-dir out/batch --frames 0:48 --encoder nvenc --pix-fmt yuv420p',
  ],
  async run(ctx) {
    const a = resolveArgs(ctx.args, ctx.opts);
    const t0 = process.hrtime.bigint();
    const gpu = await loadGpu();
    if (a.sub === 'batch') {
      const res = await runBatch(a.jobs, {
        gpu,
        concurrency: ctx.opts.concurrency,
        maxEncoders: ctx.opts['max-encoders'],
        failFast: !!ctx.opts['fail-fast'],
        onCleanup: fn => ctx.onCleanup(fn),
        onJobDone: r => ctx.log.info(`作业 ${r.id}：${r.ok ? `完成（${r.frames} 帧，${r.seconds}s）` : `失败（${r.error.message}）`}`),
      });
      const software = /swiftshader|llvmpipe|lavapipe/i.test(`${res.adapter.vendor} ${res.adapter.description}`);
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
    const host = await createHost({ gpu, width: a.width, height: a.height, fps: a.fps, query: ctx.opts.query });
    const info = host.device.adapterInfo ?? {};
    const adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
    const software = /swiftshader|llvmpipe|lavapipe/i.test(`${adapter.vendor} ${adapter.description}`);
    if (software) ctx.warn('env.software-gpu', `Dawn 落在软件适配器上（${adapter.vendor} ${adapter.description}），会很慢`, '检查 NVIDIA 驱动与 Vulkan ICD');

    if (a.sub === 'probe') {
      const undo = ctx.onCleanup(() => host.dispose());
      try {
        const work = await host.load(a.file);
        const hasTexts = typeof work.texts === 'function';
        const data = { width: a.width, height: a.height, fps: a.fps, adapter, software, hasTexts, seconds: +seconds(t0).toFixed(2) };
        ctx.out(`离屏契约通过 ${repoRel(a.file)}  ${a.width}×${a.height} ${a.fps} fps  TEXTS:${hasTexts ? '有' : '无'}`);
        return { data, outputs: [] };
      } finally {
        undo();
        host.dispose();
      }
    }

    if (a.sub === 'stills') {
      fs.mkdirSync(a.out, { recursive: true });
      const partials = new Set();
      const undo = ctx.onCleanup(() => {
        for (const p of partials) fs.rmSync(p, { force: true });
        host.dispose();
      });
      try {
        const work = await host.load(a.file);
        const hashes = [], outputs = [];
        const t1 = process.hrtime.bigint();
        await renderFrameList({
          host, work, frames: a.frameList, inflight: a.inflight,
          onFrame: async (f, px) => {
            hashes.push(sha16(px));
            const base = `f${String(f).padStart(6, '0')}.png`;
            const partial = path.join(a.out, `.${base}.partial-${process.pid}`);
            const dst = path.join(a.out, base);
            partials.add(partial);
            const png = encodePng({ width: a.width, height: a.height, data: px, channels: 4 });
            fs.writeFileSync(partial, png);
            fs.renameSync(partial, dst);
            partials.delete(partial);
            outputs.push({ path: dst, sha256: shaHex(png), kind: 'image' });
          },
        });
        const renderS = seconds(t1);
        const total = a.frameList.length;
        const data = {
          frames: total, frameNumbers: a.frameList, width: a.width, height: a.height, fps: a.fps,
          seconds: +seconds(t0).toFixed(2), renderFps: +(total / Math.max(renderS, 1e-6)).toFixed(1), adapter, frameHashes: hashes,
        };
        ctx.out(`完成静帧 ${repoRel(a.out).startsWith('..') ? a.out : repoRel(a.out)}  ${total} 帧  ${a.width}×${a.height}  ${data.seconds}s`);
        return { data, outputs };
      } finally {
        undo();
        host.dispose();
      }
    }

    fs.mkdirSync(path.dirname(a.out), { recursive: true });
    const partial = path.join(path.dirname(a.out), `.${path.basename(a.out, path.extname(a.out))}.partial-${process.pid}.mp4`);
    let enc = null, settled = false;
    const undo = ctx.onCleanup(async () => {
      if (enc && !settled) await enc.abort();
      fs.rmSync(partial, { force: true });
      host.dispose();
    });
    const pixFmt = ctx.opts['pix-fmt'] || 'rgba';
    const work = await host.load(a.file);
    enc = startEncoder({ width: a.width, height: a.height, fps: a.fps, out: partial, crf: ctx.opts.crf, preset: ctx.opts.preset, encoder: ctx.opts.encoder, cq: ctx.opts.cq, pixFmt });
    const total = a.to - a.from, hashes = [];
    const t1 = process.hrtime.bigint();
    await renderFrames({
      host, work, from: a.from, to: a.to, inflight: a.inflight, format: pixFmt,
      onFrame: async (f, px) => {
        hashes.push(sha16(px));
        await enc.write(px);
        if (hashes.length % 48 === 0 || hashes.length === total) ctx.log.info(`渲染 ${hashes.length}/${total} 帧`);
      },
    });
    await enc.finish();
    settled = true;
    const renderS = seconds(t1);
    const frames = (await probe(partial)).video?.frames;
    if (frames !== total) throw new CliError('contract.frame-count', `编出来是 ${frames} 帧，应为 ${total} 帧`, { hint: '编码器丢帧或重复帧：带上日志报告' });
    fs.renameSync(partial, a.out);
    undo();
    host.dispose();
    const data = {
      frames: total, from: a.from, to: a.to, width: a.width, height: a.height, fps: a.fps, pixFmt,
      seconds: +seconds(t0).toFixed(2), renderFps: +(total / renderS).toFixed(1), adapter, frameHashes: hashes,
    };
    ctx.out(`完成 ${repoRel(a.out).startsWith('..') ? a.out : repoRel(a.out)}  ${total} 帧（${a.from}–${a.to - 1}）  ${a.width}×${a.height} ${a.fps} fps  ${data.seconds}s（渲染+编码 ${data.renderFps} 帧/秒）`);
    return { data, outputs: [{ path: a.out, sha256: shaHex(fs.readFileSync(a.out)), kind: 'video' }] };
  },
});

if (isMain(import.meta.url)) runCli(command);
