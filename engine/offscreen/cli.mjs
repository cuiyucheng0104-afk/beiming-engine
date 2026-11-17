#!/usr/bin/env node
// 北冥引擎 · 离屏出片 · 命令行：在 Node + Dawn 里渲作品模块的一段帧，流水线读回，经 FFmpeg 编成 H.264（实验阶段，不进 npm run film 出片链）。
//   node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size 1920x1080] [--fps 24] [--inflight 3]
//                                       [--encoder x264|nvenc] [--crf 14] [--preset medium] [--cq 18] [--json]
//     作品模块契约见 docs/offscreen/README.md 2.1；作品必须在仓库里（解析符号链接之后），仓库外的文件不执行。
//     先写到 <输出目录>/.<名>.partial-<pid>.mp4，核对帧数后再改名；失败、收到信号都删掉半成品。
//     信封 data：{ frames, from, to, width, height, fps, seconds, renderFps, adapter, frameHashes }（frameHashes 是每帧 RGBA 的 sha256 前 16 位）
// 退出码：0 · 1 渲染或编码失败 · 2 用法错误 · 3 缺可选依赖（webgpu、three-webgpu）· 4 成片帧数不符。
// 计时用 process.hrtime（这个文件在确定性扫描的范围里，渲染路径之外也不用 performance.now）。
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, usageError } from '../../tools/lib/cli.mjs';
import { probe } from '../render/lib/ffmpeg.mjs';
import { loadGpu } from './load.mjs';
import { createHost } from './host.mjs';
import { renderFrames } from './frames.mjs';
import { startEncoder } from './encode.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const seconds = since => Number(process.hrtime.bigint() - since) / 1e9;
const repoRel = p => path.relative(ROOT, p).split(path.sep).join('/');

/** 校验参数（只读文件系统，不执行作品）；返回解析好的值，有问题抛用法错误 */
export function resolveArgs({ sub, work }, opts, cwd = process.cwd()) {
  if (sub !== 'render') throw usageError('bad-subcommand', `未知子命令 ${sub}`, '可用：render');
  if (!work) throw usageError('missing-work', 'render 需要 <作品.mjs>', '例如 lab/offscreen/ink.mjs');
  if (!opts.out) throw usageError('missing-out', 'render 需要 --out <文件.mp4>', null);
  if (!opts.frames) throw usageError('missing-frames', 'render 需要 --frames a:b（含 a 不含 b 的整数帧号）', '例如 --frames 0:96');
  const fm = /^(\d+):(\d+)$/.exec(opts.frames);
  if (!fm || +fm[2] <= +fm[1]) throw usageError('bad-value', `--frames 要写成 a:b，且止必须大于起，收到「${opts.frames}」`, '例如 --frames 0:96');
  const sm = [null, ...parseSize(opts.size)];
  if (!(opts.fps >= 1)) throw usageError('bad-value', `--fps 要 ≥ 1，收到 ${opts.fps}`, null);
  if (!(opts.inflight >= 1)) throw usageError('bad-value', `--inflight 要 ≥ 1，收到 ${opts.inflight}`, null);
  return { file: resolveWork(work, cwd), out: path.resolve(cwd, opts.out), from: +fm[1], to: +fm[2], width: +sm[1], height: +sm[2], fps: opts.fps, inflight: opts.inflight };
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
  summary: '离屏出片（实验）：在 Node + Dawn 里渲作品模块，不经过浏览器，编成有限范围 BT.709 的 H.264',
  usage: ['node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> --frames a:b [--size WxH] [--fps 24] [--inflight 3] [--encoder x264|nvenc] [--crf 14] [--preset medium] [--cq 18] [--query k=v&…] [--json]'],
  description: [
    '  offscreen render <作品.mjs>：作品模块契约见 docs/offscreen/README.md；只执行仓库里的作品',
    '  需要可选依赖 webgpu 与 three-webgpu（npm install --include=optional --ignore-scripts）',
  ],
  positionals: [
    { name: 'sub', label: '<render>', describe: '子命令', required: true },
    { name: 'work', label: '<作品.mjs>', describe: '作品模块（仓库内）', required: false },
  ],
  options: {
    out: { type: 'string', arg: '<文件.mp4>', describe: '输出成片' },
    frames: { type: 'string', arg: '<a:b>', describe: '帧区间，含 a 不含 b' },
    size: { type: 'string', arg: '<WxH>', default: '1920x1080', describe: '画幅（偶数，默认 1920x1080）' },
    fps: { type: 'integer', default: 24, arg: '<n>', describe: '帧率（默认 24）' },
    inflight: { type: 'integer', default: 3, arg: '<n>', describe: '同时在途的读回帧数（默认 3；不改变成片）' },
    encoder: { type: 'string', default: 'x264', choices: ['x264', 'nvenc'], arg: '<名字>', describe: '编码器（默认 x264；nvenc 走显卡，快一倍多，画质略低，母版不建议）' },
    crf: { type: 'integer', default: 14, arg: '<n>', describe: 'x264 crf（默认 14，与页面渲染器相同）' },
    cq: { type: 'integer', default: 18, arg: '<n>', describe: 'nvenc 恒定质量 cq（默认 18，数字小画质高）' },
    query: { type: 'string', default: '', arg: '<k=v&…>', describe: '交给作品 build 的查询串（同页面的 location.search，不带 ?；出片链的 --query 与预演的 previs=1 原样转来）' },
    preset: { type: 'string', default: 'medium', choices: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], arg: '<名字>', describe: 'x264 preset（默认 medium）' },
  },
  exitCodes: { 0: '成功', 1: '渲染或编码失败', 2: '用法错误', 3: '缺可选依赖', 4: '成片帧数不符' },
  examples: ['node engine/offscreen/cli.mjs render lab/offscreen/ink.mjs --out out/offscreen/ink.mp4 --frames 0:96'],
  async run(ctx) {
    const a = resolveArgs(ctx.args, ctx.opts);
    const t0 = process.hrtime.bigint();
    const gpu = await loadGpu();
    const host = await createHost({ gpu, width: a.width, height: a.height, fps: a.fps, query: ctx.opts.query });
    const info = host.device.adapterInfo ?? {};
    const adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
    if (/swiftshader|llvmpipe|lavapipe/i.test(`${adapter.vendor} ${adapter.description}`)) ctx.warn('env.software-gpu', `Dawn 落在软件适配器上（${adapter.vendor} ${adapter.description}），会很慢`, '检查 NVIDIA 驱动与 Vulkan ICD');
    fs.mkdirSync(path.dirname(a.out), { recursive: true });
    const partial = path.join(path.dirname(a.out), `.${path.basename(a.out, path.extname(a.out))}.partial-${process.pid}.mp4`);
    let enc = null, settled = false;
    const undo = ctx.onCleanup(async () => {
      if (enc && !settled) await enc.abort();
      fs.rmSync(partial, { force: true });
      host.dispose();
    });
    const work = await host.load(a.file);
    enc = startEncoder({ width: a.width, height: a.height, fps: a.fps, out: partial, crf: ctx.opts.crf, preset: ctx.opts.preset, encoder: ctx.opts.encoder, cq: ctx.opts.cq });
    const total = a.to - a.from, hashes = [];
    const t1 = process.hrtime.bigint();
    await renderFrames({
      host, work, from: a.from, to: a.to, inflight: a.inflight,
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
      frames: total, from: a.from, to: a.to, width: a.width, height: a.height, fps: a.fps,
      seconds: +seconds(t0).toFixed(2), renderFps: +(total / renderS).toFixed(1), adapter, frameHashes: hashes,
    };
    ctx.out(`完成 ${repoRel(a.out).startsWith('..') ? a.out : repoRel(a.out)}  ${total} 帧（${a.from}–${a.to - 1}）  ${a.width}×${a.height} ${a.fps} fps  ${data.seconds}s（渲染+编码 ${data.renderFps} 帧/秒）`);
    return { data, outputs: [{ path: a.out, sha256: createHash('sha256').update(fs.readFileSync(a.out)).digest('hex'), kind: 'video' }] };
  },
});

if (isMain(import.meta.url)) runCli(command);
