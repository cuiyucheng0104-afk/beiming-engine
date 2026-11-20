// 北冥引擎 · 离屏出片 · FFmpeg 编码器：读回的裸帧（RGBA8 或 GPU 打包的 YUV420p）经管道交给 FFmpeg，编成有限范围 BT.709 yuv420p 的 H.264。
// 色彩换算与 x264 参数沿用页面渲染器（engine/render/lib/ffmpeg.mjs 的 COLOR.png、TAGS、x264Args），两条链路出的片标记一致。
//   MASTER_CQ = 7    NVENC 母版档 cq：三部作品上 PSNR-Y、最差帧、SSIM、VMAF 都不低于 x264 crf14 的最高 cq（见 docs/offscreen/README.md 7.19）
//   resolveEncoder(requested = 'auto', { width, height, probe }) → { encoder: 'x264' | 'nvenc', reason: string | null }
//     auto：NVENC 可用且画幅 ≥ 145×49 时选 nvenc，否则退回 x264 并给出原因；显式指定 x264 / nvenc 时照用、不探测
//   encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium', encoder = 'x264', cq = MASTER_CQ, pixFmt = 'rgba' }) → string[]   FFmpeg 参数（不含 -y、-loglevel）
//     encoder：x264（crf + preset）或 nvenc（h264_nvenc，cq；crf、preset 不用）；别的值抛 usage.bad-value
//   startEncoder(同上) → { write(pixels) → Promise<void>, finish() → Promise<void>, abort() → Promise<void> }
//     write：写一帧（Uint8Array 或 Buffer）；管道满时等它腾出来（背压）
//     finish：关上输入、等 FFmpeg 编完；abort：杀掉 FFmpeg、删掉输出
//     找不到 FFmpeg（没装、FFMPEG 指错）时抛 CliError('env.ffmpeg')（退出码 3）；启动后中途退出抛 CliError('failure.ffmpeg')（退出码 1，消息里带 FFmpeg 最后一行报错），并删掉输出，不挂住
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { COLOR, TAGS, x264Args, FFMPEG } from '../render/lib/ffmpeg.mjs';
import { CliError } from '../../tools/lib/cli.mjs';

export const ENCODERS = ['x264', 'nvenc'];
export const ENCODER_CHOICES = ['auto', ...ENCODERS];
export const PIX_FMTS = ['rgba', 'yuv420p'];
export const MASTER_CQ = 7;
export const NVENC_MIN_WIDTH = 145;
export const NVENC_MIN_HEIGHT = 49;
const YUV_SETPARAMS = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

const nvencProbeCache = new Map();
/** 试编一帧探测当前机器与 FFmpeg 是否可用 h264_nvenc（按 FFMPEG 路径缓存） */
export function probeNvenc(bin = FFMPEG()) {
  if (nvencProbeCache.has(bin)) return nvencProbeCache.get(bin);
  const ok = spawnSync(bin, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256',
    '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ], { stdio: 'ignore', timeout: 10000 }).status === 0;
  nvencProbeCache.set(bin, ok);
  return ok;
}

/** 解析用户请求的编码器：auto 在 NVENC 可用且画幅 ≥ 145×49 时选 nvenc，否则退回 x264；显式指定时不探测 */
export function resolveEncoder(requested = 'auto', { width, height, probe = probeNvenc } = {}) {
  const choice = requested == null || requested === '' ? 'auto' : String(requested);
  if (!ENCODER_CHOICES.includes(choice)) {
    throw new CliError('usage.bad-value', `--encoder 只能是 ${ENCODER_CHOICES.join('、')}，收到「${choice}」`, {
      hint: `auto 自动优先 nvenc（母版档 cq ${MASTER_CQ}），无 NVENC 或小画幅时退回 x264`,
    });
  }
  if (choice !== 'auto') return { encoder: choice, reason: null };
  if ((width != null && width < NVENC_MIN_WIDTH) || (height != null && height < NVENC_MIN_HEIGHT)) {
    return { encoder: 'x264', reason: `画幅 ${width}×${height} 小于 NVENC 最小尺寸 ${NVENC_MIN_WIDTH}×${NVENC_MIN_HEIGHT}，退回 x264` };
  }
  if (!probe()) return { encoder: 'x264', reason: '未检测到可用的 NVENC，退回 x264' };
  return { encoder: 'nvenc', reason: null };
}

// nvenc：恒定质量（-rc vbr -cq N -b:v 0），preset p5；母版默认 cq 7（三部作品画质均不低于 x264 crf14，同输入码流逐字节确定，见 docs/offscreen/README.md 7.18–7.19）。
//   必须显式给 -maxrate：不给时 NVENC 按分辨率自动选 Level（1080p24 是 4.0），再按这个 Level 的最大码率封顶（约 25 Mbps），
//   cq 低于约 18 时全被截住，--cq 18 与 --cq 10 输出相同。240M 让 Level 升到 5.1，在 master-1080p24（Level ≤ 5.1）与 uhd-2160p24（≤ 5.2）允许的范围内。
// pixFmt：rgba（走 COLOR.png 的 swscale）或 yuv420p（GPU 已转好有限范围 BT.709，只过零拷贝 setparams 打标记，免 CPU swscale）
export function encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium', encoder = 'x264', cq = MASTER_CQ, pixFmt = 'rgba' }) {
  if (!ENCODERS.includes(encoder)) throw new CliError('usage.bad-value', `--encoder 只能是 ${ENCODERS.join(' 或 ')}，收到「${encoder}」`, { hint: `可选 x264 或 nvenc（默认命令行走 auto，母版档 cq ${MASTER_CQ}）` });
  if (!PIX_FMTS.includes(pixFmt)) throw new CliError('usage.bad-value', `--pix-fmt 只能是 ${PIX_FMTS.join(' 或 ')}，收到「${pixFmt}」`, { hint: 'rgba 走 FFmpeg swscale；yuv420p 由 GPU 直接输出 BT.709 限范围平面字节' });
  const video = encoder === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-maxrate', '240M', '-bufsize', '480M'] : x264Args({ crf, preset });
  if (pixFmt === 'yuv420p') {
    return ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', ...TAGS, '-s', `${width}x${height}`, '-framerate', String(fps), '-i', '-',
      '-vf', YUV_SETPARAMS, ...video, ...TAGS, out];
  }
  return ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', '-',
    '-vf', COLOR.png, ...video, ...TAGS, out];
}

const describe = r => (r.error ? `没能启动（${r.error.code ?? r.error.message}）` : r.signal ? `被信号 ${r.signal} 结束` : `退出码 ${r.code}`);
// 机器上没装 FFmpeg（或 FFMPEG 指错了）是环境问题，退出码 3；CI 的 windows-paths 任务就没有 FFmpeg
const noFfmpeg = (bin, error) => new CliError('env.ffmpeg', `FFmpeg 没能启动（${error.code ?? error.message}）：${bin}`, {
  hint: '装带 libx264 的 FFmpeg（npm run setup，或见 docs/ENVIRONMENT.md）；FFMPEG 环境变量可指定可执行文件',
  cause: error,
});

export function startEncoder(opts) {
  const { out } = opts;
  const bin = FFMPEG();
  let ff;
  try {
    ff = spawn(bin, ['-y', '-loglevel', 'error', ...encoderArgs(opts)], { stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (e) { throw noFfmpeg(bin, e); }
  let tail = '';
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
  const exited = new Promise(r => { ff.once('close', (code, signal) => r({ code, signal })); ff.once('error', error => r({ error })); });
  ff.stdin.on('error', () => {});   // 中途退出时的 EPIPE：由 exited 报告
  const removeOut = () => { try { fs.rmSync(out, { force: true }); } catch { /* 删不掉也不掩盖原来的错误 */ } };
  const failure = async () => {
    const r = await exited;
    removeOut();
    if (r.error) return noFfmpeg(bin, r.error);
    const last = tail.trim().split('\n').at(-1);
    return new CliError('failure.ffmpeg', `FFmpeg 编码 ${out} 时${describe(r)}${last ? `：${last}` : ''}`, {
      hint: '运行 ffmpeg -version 确认可用（要带 libx264）；常见原因还有磁盘满、输出目录不可写',
    });
  };
  const gone = () => ff.exitCode !== null || ff.signalCode !== null || ff.stdin.destroyed || !ff.stdin.writable;
  return {
    async write(px) {
      const buf = Buffer.isBuffer(px) ? px : Buffer.from(px.buffer, px.byteOffset, px.byteLength);
      if (gone()) throw await failure();
      if (ff.stdin.write(buf)) return;
      let onDrain;
      const why = await Promise.race([new Promise(r => { onDrain = () => r('drain'); ff.stdin.once('drain', onDrain); }), exited.then(() => 'exit')]);
      ff.stdin.off('drain', onDrain);
      if (why === 'exit') throw await failure();
    },
    async finish() {
      ff.stdin.end();
      const r = await exited;
      if (r.error || r.code !== 0) throw await failure();
    },
    async abort() {
      try { ff.stdin.destroy(); } catch { /* 已关 */ }
      try { ff.kill('SIGKILL'); } catch { /* 已退出 */ }
      await exited;
      removeOut();
    },
  };
}
