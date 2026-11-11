// 北冥引擎 · FFmpeg / ffprobe：预检、可中止的子进程、探测成片、色彩换算与编码参数（video / shots / mux 共用）。
// 可执行文件：经 tools/env/lib/ffmpeg.mjs 的 ffmpegBins(process.env) 解析（认 FFMPEG / FFPROBE 完整路径，默认 PATH 里的
// ffmpeg / ffprobe，全仓库同一口径）。所有路径参数都按 argv 传，不经 shell，Windows 上不需要 sh。
//
//   preflight()                 ffmpeg / ffprobe 能跑、带 libx264 与 aac：返回 { ffmpeg, ffprobe, version, line }；
//                               缺了 → env.ffmpeg-missing / env.ffprobe-missing / env.ffmpeg-encoder-missing（退出码 3），带安装提示（FFmpeg ≥ 7，D09）；
//                               每次调用最多等 15 秒（FFMPEG 指向卡住的程序时不会永远挂在预检里），超时同样按缺 FFmpeg 报
//   run(bin, args, { cwd, signal, input })   跑完返回 { code, stdout, stderr }；中止时 SIGKILL 并抛 signal.reason
//   probe(file)                 ffprobe JSON：{ video: {…, frames}, audio, format }；frames 按 count_packets 数（不解码）
//   COLOR.png / COLOR.jpeg      截图 → 有限范围 BT.709 yuv420p 的唯一一次换算，并写明标记（见 README「编码链」）
//   TAGS                        -colorspace / -color_primaries / -color_trc bt709 与 -color_range tv
//   x264Args({ crf, preset, web, keyint })   libx264 参数；web 时加码率上限、2 秒关键帧、High@4.1 级的参考帧数
import { spawn, spawnSync } from 'node:child_process';
import { ffmpegBins } from '../../../tools/env/lib/ffmpeg.mjs';
import { RenderError } from './errors.mjs';

export const FFMPEG = () => ffmpegBins(process.env).ffmpeg;
export const FFPROBE = () => ffmpegBins(process.env).ffprobe;

// 截图 → yuv420p 有限范围 BT.709：PNG 是 RGB（sRGB 原色），直接按 BT.709 矩阵换算；JPEG 截图是全范围 BT.601 的 4:2:0，
// 先按它自己的矩阵与范围解，再换成有限范围 BT.709。都只换算一次，并用 setparams 写明标记（只加输出参数在 FFmpeg 8 下
// 原色 / 传递特性仍是 unknown）。accurate_rnd + full_chroma_int：中性灰 128 → Y 126、Cb/Cr 128（色卡实测误差 ≤ 1 级）。
const SET = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
export const COLOR = Object.freeze({
  png: `scale=out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,${SET}`,
  jpeg: `scale=in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p,${SET}`,
});
export const TAGS = Object.freeze(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);

/** libx264 参数。master：crf + preset；web：再加 VBV 上限与 2 秒关键帧（网页拖动定位快），参考帧 ≤ 4（1080p 落在 Level 4.1） */
export function x264Args({ crf = 14, preset = 'medium', web = false, fps = 24, maxrate = '14M', bufsize = '18M' } = {}) {
  const a = ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];
  if (web) a.push('-profile:v', 'high', '-maxrate', maxrate, '-bufsize', bufsize, '-g', String(Math.round(fps * 2)), '-keyint_min', String(Math.round(fps)), '-x264-params', 'ref=4');
  return a;
}

const firstLine = s => String(s || '').split('\n').find(l => l.trim()) ?? '';

const cached = new Map();
const PREFLIGHT_TIMEOUT_MS = 15000;
export function preflight() {
  const ff = FFMPEG(), fp = FFPROBE();
  if (cached.has(`${ff}\0${fp}`)) return cached.get(`${ff}\0${fp}`);
  const hint = '装 FFmpeg ≥ 7（带 libx264、aac、ebur128）：macOS brew install ffmpeg；Windows winget install Gyan.FFmpeg；'
    + 'Linux 用发行版的 ffmpeg 包。装在别处就设 FFMPEG / FFPROBE 为可执行文件的完整路径';
  const call = (bin, args, code, what) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: PREFLIGHT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (!r.error && r.status === 0) return r.stdout ?? '';
    const stuck = r.error?.code === 'ETIMEDOUT';
    throw new RenderError(code, `找不到能运行的 ${what}（${bin}：${stuck ? `${PREFLIGHT_TIMEOUT_MS / 1000} 秒没有响应，已终止` : r.error?.code ?? `退出码 ${r.status}`}）`, {
      hint: stuck ? `${bin} 卡住了（网络盘、包装脚本？）：把 FFMPEG / FFPROBE 设成本机能直接运行的可执行文件。${hint}` : hint,
    });
  };
  const line = firstLine(call(ff, ['-hide_banner', '-version'], 'env.ffmpeg-missing', 'FFmpeg'));
  call(fp, ['-version'], 'env.ffprobe-missing', 'ffprobe');
  const enc = call(ff, ['-hide_banner', '-encoders'], 'env.ffmpeg-missing', 'FFmpeg');
  const missing = ['libx264', 'aac'].filter(e => !new RegExp(`\\s${e}\\s`).test(enc));
  if (missing.length) throw new RenderError('env.ffmpeg-encoder-missing', `这个 FFmpeg（${ff}）缺编码器：${missing.join('、')}`, { hint });
  const r = { ffmpeg: ff, ffprobe: fp, line, version: /version\s+(\S+)/.exec(line)?.[1] ?? 'unknown' };
  cached.set(`${ff}\0${fp}`, r);
  return r;
}

/** 跑一个子进程；signal 中止时 SIGKILL。stdout 只在 capture 时收集；stderr 留最后 8 KB 做报错 */
export function run(bin, args, { cwd, signal, capture = false, live } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const p = spawn(bin, args, { cwd, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    live?.add(p);
    let out = '', err = '';
    if (capture) p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-8192); });
    const onAbort = () => { try { p.kill('SIGKILL'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = r => {
      live?.delete(p); signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason);
      resolve({ ...r, stdout: out, stderr: err });
    };
    p.once('error', error => done({ code: null, error }));
    p.once('close', (code, sig) => done({ code, sig }));
  });
}

/** run() 非零就抛 RenderError：起不来 env.ffmpeg-spawn（3），非零退出 failure.ffmpeg（1） */
export async function must(bin, args, what, opts = {}) {
  const r = await run(bin, args, opts);
  if (r.error) throw new RenderError('env.ffmpeg-spawn', `${what}：无法运行 ${bin}（${r.error.message}）`, { hint: '运行 node tools/env/doctor.mjs 查 FFmpeg；装在别处就设 FFMPEG / FFPROBE 为完整路径' });
  if (r.code !== 0) throw new RenderError('failure.ffmpeg', `${what}失败：${bin} 退出码 ${r.code ?? r.sig}：${firstLine(r.stderr.split('\n').slice(-3).join('\n'))}`, { hint: 'FFmpeg 自己的报错见上面；常见原因：磁盘满、输出目录不可写、输入文件损坏' });
  return r;
}

const ratio = s => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : Number(a) || 0; };

/** 探测一个媒体文件：视频流的尺寸、帧率、像素格式、色彩标记、帧数（数包，不解码），音频流的采样率与声道 */
export async function probe(file, { signal } = {}) {
  const r = await run(FFPROBE(), ['-v', 'error', '-count_packets', '-show_entries',
    'stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,r_frame_rate,avg_frame_rate,nb_read_packets,sample_rate,channels:format=duration,size',
    '-of', 'json', file], { capture: true, signal });
  if (r.error) throw new RenderError('env.ffprobe-missing', `无法运行 ffprobe（${FFPROBE()}：${r.error.message}）`, { hint: '装 FFmpeg ≥ 7（带 ffprobe），或设 FFPROBE 为完整路径' });
  if (r.code !== 0) throw new RenderError('contract.probe', `读不出媒体信息：${file}（${firstLine(r.stderr)}）`, { hint: '文件可能不完整或不是视频；重新生成它' });
  const j = JSON.parse(r.stdout || '{}');
  const v = (j.streams ?? []).find(s => s.codec_type === 'video') ?? null;
  const a = (j.streams ?? []).find(s => s.codec_type === 'audio') ?? null;
  return {
    video: v && {
      codec: v.codec_name, profile: v.profile ?? null, level: v.level ?? null, width: v.width, height: v.height, pixFmt: v.pix_fmt,
      color: { range: v.color_range ?? 'unknown', space: v.color_space ?? 'unknown', primaries: v.color_primaries ?? 'unknown', transfer: v.color_transfer ?? 'unknown' },
      rate: v.r_frame_rate, fps: ratio(v.r_frame_rate), avgFps: ratio(v.avg_frame_rate), frames: Number(v.nb_read_packets),
    },
    audio: a && { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels },
    format: { duration: Number(j.format?.duration), size: Number(j.format?.size) },
  };
}

/**
 * 视频流的“能不能直接拼接”签名（不数包，快）：编码、档次、像素格式、画幅、帧率、时间基与色彩标记。
 * concat 复制拼接要求各段这些都相同。
 */
export async function streamSignature(file, { signal } = {}) {
  const r = await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,time_base,color_range,color_space,color_primaries,color_transfer',
    '-of', 'json', file], { capture: true, signal });
  if (r.error) throw new RenderError('env.ffprobe-missing', `无法运行 ffprobe（${FFPROBE()}：${r.error.message}）`, { hint: '装 FFmpeg ≥ 7（带 ffprobe），或设 FFPROBE 为完整路径' });
  if (r.code !== 0) throw new RenderError('contract.probe', `读不出媒体信息：${file}（${firstLine(r.stderr)}）`, { hint: '文件可能不完整或不是视频；重新生成它' });
  const v = (JSON.parse(r.stdout || '{}').streams ?? [])[0] ?? {};
  return {
    codec: v.codec_name ?? null, profile: v.profile ?? null, pixFmt: v.pix_fmt ?? null, size: `${v.width}x${v.height}`, rate: v.r_frame_rate ?? null,
    timeBase: v.time_base ?? null, range: v.color_range ?? null, space: v.color_space ?? null, primaries: v.color_primaries ?? null, transfer: v.color_transfer ?? null,
  };
}

/** framemd5 风格的逐帧解码哈希（测试与确定性核对用）：返回每帧一个 md5 字符串 */
export async function frameMd5(file, { signal } = {}) {
  const r = await run(FFMPEG(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { capture: true, signal });
  if (r.code !== 0) throw new RenderError('contract.decode', `解码失败：${file}`, { hint: '文件不完整或损坏：重新生成它' });
  return r.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
}
