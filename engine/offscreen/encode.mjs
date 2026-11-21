// 北冥引擎 · 离屏出片 · FFmpeg 编码器：读回的裸帧（RGBA8 或 GPU 打包的 YUV420p）经管道交给 FFmpeg，编成有限范围 BT.709 yuv420p 的 H.264。
// 色彩换算与 x264 参数沿用页面渲染器（engine/render/lib/ffmpeg.mjs 的 COLOR.png、TAGS、x264Args），两条链路出的片标记一致。
//
// 两档编码（离屏母版；页面渲染器、D 路线、网页版不走这里）：
//   Pro（默认）  libx264 High + 合入前默认像素格式 rgba（FFmpeg swscale）→ 跨机器（含 CI）确定，终渲交付
//   Fast（可选） h264_nvenc High、cq 7、合规 VBV；没有 NVENC 或画幅过小时自动退回 Pro
//
//   MODES = ['pro', 'fast']     DEFAULT_MODE = 'pro'
//   MASTER_CQ = 7               Fast / 显式 nvenc 的 cq：三部作品上 PSNR-Y、最差帧、SSIM、VMAF 都不低于 x264 crf14 的最高 cq
//                               （见 docs/offscreen/README.md 7.19）；避开会出坏流的 cq 6
//   NVENC_MAXRATE / NVENC_BUFSIZE = 240M / 240M
//     High@5.1 的 MaxCPB 至多 300000 kbit（表值 240000×High 1.25）；原先 480M 超了规格。240M 与 maxrate 同量级、≤ 两种口径的上限。
//   resolveEncode({ mode, encoder, pixFmt, width, height, probe })
//     → { mode: 'pro'|'fast', encoder: 'x264'|'nvenc', pixFmt, profile: 'high', reason }
//     encoder 缺省或 auto：跟随 mode；显式 x264 / nvenc 照用、不探测（显式 nvenc 缺卡时由 FFmpeg 失败，不回退）
//     Fast 在 NVENC 不可用或画幅 < 145×49 时退回 Pro（reason 说明原因）；退回时未显式指定的 pixFmt 也回到 rgba
//   probeNvencAsync(bin) / resolveEncodeAsync(options)   Fast 的异步探测与解析；并发探测共用 Promise，可与宿主初始化、作品加载重叠
//   resolveEncoder(requested = 'auto', { width, height, probe, mode }) → { encoder, reason }
//     兼容旧调用：默认 mode=pro，所以 auto 不再选 NVENC
//   encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium', encoder = 'x264', cq = MASTER_CQ, pixFmt = 'rgba' }) → string[]
//     FFmpeg 参数（不含 -y、-loglevel）；x264 与 nvenc 都带 -profile:v high
//   startEncoder(同上) → { write(pixels) → Promise<void>, finish() → Promise<void>, abort() → Promise<void> }
//     write：写一帧（Uint8Array 或 Buffer）；管道满时等它腾出来（背压）
//     finish：关上输入、等 FFmpeg 编完；abort：杀掉 FFmpeg、删掉输出
//     找不到 FFmpeg（没装、FFMPEG 指错）时抛 CliError('env.ffmpeg')（退出码 3）；启动后中途退出抛 CliError('failure.ffmpeg')（退出码 1，消息里带 FFmpeg 最后一行报错），并删掉输出，不挂住
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { COLOR, TAGS, x264Args, FFMPEG } from '../render/lib/ffmpeg.mjs';
import { CliError } from '../../tools/lib/cli.mjs';

export const MODES = ['pro', 'fast'];
export const DEFAULT_MODE = 'pro';
export const ENCODERS = ['x264', 'nvenc'];
export const ENCODER_CHOICES = ['auto', ...ENCODERS];
export const PIX_FMTS = ['rgba', 'yuv420p'];
export const PRO_PIX_FMT = 'rgba';
export const FAST_PIX_FMT = 'yuv420p';
export const H264_PROFILE = 'high';
export const MASTER_CQ = 7;
export const NVENC_MIN_WIDTH = 145;
export const NVENC_MIN_HEIGHT = 49;
export const NVENC_MAXRATE = '240M';
export const NVENC_BUFSIZE = '240M';
const YUV_SETPARAMS = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

const NVENC_PROBE_ARGS = [
  '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256',
  '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'h264_nvenc', '-f', 'null', '-',
];
const nvencProbeCache = new Map();
/** 试编一帧探测当前机器与 FFmpeg 是否可用 h264_nvenc（按 FFMPEG 路径缓存） */
export function probeNvenc(bin = FFMPEG()) {
  const cached = nvencProbeCache.get(bin);
  if (typeof cached === 'boolean') return cached;
  const ok = spawnSync(bin, NVENC_PROBE_ARGS, { stdio: 'ignore', timeout: 10000 }).status === 0;
  nvencProbeCache.set(bin, ok);
  return ok;
}

/** 异步版探测：并发调用复用同一个 Promise；失败/超时只表示 NVENC 不可用，由 Fast 按原语义退回 Pro。 */
export function probeNvencAsync(bin = FFMPEG()) {
  const cached = nvencProbeCache.get(bin);
  if (typeof cached === 'boolean') return Promise.resolve(cached);
  if (cached) return cached;
  const pending = new Promise(resolve => {
    let child;
    try { child = spawn(bin, NVENC_PROBE_ARGS, { stdio: 'ignore' }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 10000);
    timer.unref?.();   // 渲染先失败时不让探测的超时 timer 拖住进程退出
    const done = ok => { clearTimeout(timer); resolve(ok); };
    child.once('error', () => done(false));
    child.once('close', code => done(code === 0));
  }).then(ok => { nvencProbeCache.set(bin, ok); return ok; });
  nvencProbeCache.set(bin, pending);
  return pending;
}

function asMode(mode) {
  const m = mode == null || mode === '' ? DEFAULT_MODE : String(mode);
  if (!MODES.includes(m)) {
    throw new CliError('usage.bad-value', `--mode 只能是 ${MODES.join('、')}，收到「${mode}」`, {
      hint: 'pro（默认）是 x264 High 终渲档，跨机器确定；fast 是 NVENC 预览档，没有 NVENC 时退回 pro',
    });
  }
  return m;
}

function asEncoderChoice(encoder) {
  const choice = encoder == null || encoder === '' ? 'auto' : String(encoder);
  if (!ENCODER_CHOICES.includes(choice)) {
    throw new CliError('usage.bad-value', `--encoder 只能是 ${ENCODER_CHOICES.join('、')}，收到「${encoder}」`, {
      hint: '不写或 auto 跟随 --mode（pro→x264，fast→nvenc 并在缺卡时退回 pro）；显式 x264 / nvenc 照用、不探测',
    });
  }
  return choice;
}

function asPixFmt(pixFmt) {
  if (pixFmt == null || pixFmt === '') return null;
  const fmt = String(pixFmt);
  if (!PIX_FMTS.includes(fmt)) {
    throw new CliError('usage.bad-value', `--pix-fmt 只能是 ${PIX_FMTS.join(' 或 ')}，收到「${pixFmt}」`, {
      hint: 'rgba 走 FFmpeg swscale（Pro 默认，与合入前相同）；yuv420p 由 GPU 直接输出 BT.709 限范围平面字节（Fast 默认）',
    });
  }
  return fmt;
}

/** 解析离屏母版编码档：Pro 默认 x264 High + rgba；Fast 选 NVENC，缺卡或小画幅时退回 Pro。 */
export function resolveEncode({ mode = DEFAULT_MODE, encoder = null, pixFmt = null, width, height, probe = probeNvenc } = {}) {
  const m = asMode(mode);
  const choice = asEncoderChoice(encoder);
  const given = asPixFmt(pixFmt);
  const pickPix = fallback => given ?? fallback;
  const pro = (reason = null) => ({
    mode: 'pro', encoder: 'x264', pixFmt: pickPix(PRO_PIX_FMT), profile: H264_PROFILE, reason,
  });
  const nvenc = (resolvedMode, reason = null) => ({
    mode: resolvedMode, encoder: 'nvenc', pixFmt: pickPix(FAST_PIX_FMT), profile: H264_PROFILE, reason,
  });

  if (choice === 'x264') {
    return { mode: m, encoder: 'x264', pixFmt: pickPix(m === 'fast' ? FAST_PIX_FMT : PRO_PIX_FMT), profile: H264_PROFILE, reason: null };
  }
  if (choice === 'nvenc') return nvenc(m);

  if (m === 'pro') return pro();
  if ((width != null && width < NVENC_MIN_WIDTH) || (height != null && height < NVENC_MIN_HEIGHT)) {
    return pro(`画幅 ${width}×${height} 小于 NVENC 最小尺寸 ${NVENC_MIN_WIDTH}×${NVENC_MIN_HEIGHT}，Fast 退回 Pro`);
  }
  if (!probe()) return pro('未检测到可用的 NVENC，Fast 退回 Pro');
  return nvenc('fast');
}

/** 异步解析：只有 Fast + auto 的大画幅需要探测，其余分支与同步版一样立即给出结果。 */
export function resolveEncodeAsync(opts = {}) {
  let needsProbe = false;
  const early = resolveEncode({ ...opts, probe: () => { needsProbe = true; return false; } });
  if (!needsProbe) return Promise.resolve(early);
  const probe = opts.probe ?? probeNvencAsync;
  return Promise.resolve().then(() => probe()).then(ok => resolveEncode({ ...opts, probe: () => ok }));
}

/** 兼容旧调用：默认 mode=pro，所以 auto 选 x264。Fast 请走 resolveEncode({ mode: 'fast' })。 */
export function resolveEncoder(requested = 'auto', { width, height, probe = probeNvenc, mode = DEFAULT_MODE } = {}) {
  const r = resolveEncode({ mode, encoder: requested, width, height, probe });
  return { encoder: r.encoder, reason: r.reason };
}

export function nvencArgs({ cq = MASTER_CQ } = {}) {
  return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0',
    '-profile:v', H264_PROFILE, '-maxrate', NVENC_MAXRATE, '-bufsize', NVENC_BUFSIZE];
}

// nvenc（Fast / 显式 --encoder nvenc）：恒定质量（-rc vbr -cq N -b:v 0），preset p5。
//   cq 默认 MASTER_CQ=7（三部作品画质均不低于 x264 crf14；纯随机噪声在 cq 6 时 NVENC 出过解码报错的码流，真实画面没出现，见 7.18–7.19）。
//   必须显式给 -maxrate：不给时 NVENC 按分辨率自动选 Level（1080p24 是 4.0），再按这个 Level 的最大码率封顶（约 25 Mbps），
//   cq 低于约 18 时全被截住，--cq 18 与 --cq 10 输出相同。240M 让 Level 升到 5.1，在 master-1080p24（Level ≤ 5.1）与 uhd-2160p24（≤ 5.2）允许的范围内。
//   -bufsize 必须 ≤ High@5.1 的 MaxCPB（表值 240000 kbit，High 1.25× 为 300000 kbit）。原先 480M 超标；现与 maxrate 同为 240M。
//   Fast 母版因此是 H.264 High@5.1：web-1080p24（maxLevel 4.1）的 qa delivery.codec 给软告警（warn，不阻断）；
//   master-1080p24（maxLevel 5.1）不告警。web.mp4 另经 encodeWeb 重编为 High@4.1。Pro（默认 x264 High）不走这条。
// pixFmt：rgba（走 COLOR.png 的 swscale；Pro 默认）或 yuv420p（GPU 已转好有限范围 BT.709，只过零拷贝 setparams 打标记；Fast 默认）
export function encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium', encoder = 'x264', cq = MASTER_CQ, pixFmt = PRO_PIX_FMT } = {}) {
  if (!ENCODERS.includes(encoder)) throw new CliError('usage.bad-value', `--encoder 只能是 ${ENCODERS.join(' 或 ')}，收到「${encoder}」`, { hint: `可选 x264 或 nvenc（命令行默认 --mode pro → x264 High）` });
  if (!PIX_FMTS.includes(pixFmt)) throw new CliError('usage.bad-value', `--pix-fmt 只能是 ${PIX_FMTS.join(' 或 ')}，收到「${pixFmt}」`, { hint: 'rgba 走 FFmpeg swscale；yuv420p 由 GPU 直接输出 BT.709 限范围平面字节' });
  const video = encoder === 'nvenc' ? nvencArgs({ cq }) : [...x264Args({ crf, preset }), '-profile:v', H264_PROFILE];
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
