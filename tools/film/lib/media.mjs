// 北冥仓库 · 出片编排 · 媒体工具（全部经 FFmpeg / ffprobe，路径与参数都不经 shell）：
//   probe(file)                  ffprobe 完整解码计数：{ width, height, fps, frames, duration, pixFmt, color{range,space,transfer,primaries}, audio{codec,rate,channels}|null }
//   framemd5(file)               解码后逐帧 md5（写进 run.json 的 frameHashes，复现时逐帧比对）
//   extractFrames(file, frames, dir)   一次解码按帧号取出 PNG（联系表、海报只用本次运行的帧）
//   encodeWeb({ src, audioFrom, out, fps })   网页版：H.264 High@4.1、GOP 2 秒、faststart；色彩一次性转成 BT.709 有限范围并写全四个标签；
//                                声音直接复制母版的 AAC（不做 AAC→AAC 二次编码，响度与母版一致）
//   muxSimple({ video, audio, out, duration })   画面逐位复制 + 声音编 AAC 48 kHz 立体声（预演与无声片用；不做响度归一）
//   clickTrack({ file, frames, fps, marks })     预演用的临时声：事件处短促提示音、切点处高一个八度（纯 Node 生成 16-bit WAV）
//   encoderInfo(file)            从 H.264 码流里 x264 自报的参数串读出实际编码器与 crf / 预设（写进 run.json 的 actualEncoder；读不到返回 null）
// FFMPEG / FFPROBE 环境变量可指定可执行文件。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';

export const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
export const FFPROBE = () => process.env.FFPROBE || 'ffprobe';

const rate = s => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a; };

// PNG / JPEG 的宽高（只读文件头，不解码）；认不出返回 { width: null, height: null }
export function imageSize(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return { width: null, height: null }; }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return { width: null, height: null };
}

// x264 在第一个关键帧前写一段 SEI：「x264 - core 164 r3108 … - options: … crf=14.0 …」。只读文件头 4 MB。
export function encoderInfo(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try { buf = Buffer.alloc(Math.min(4 << 20, fs.fstatSync(fd).size)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }
  const s = buf.toString('latin1');
  const i = s.indexOf('x264 - core ');
  if (i < 0) return null;
  const sei = s.slice(i, i + 3000).split('\0')[0];
  const core = /x264 - core (\d+)/.exec(sei)?.[1];
  const opt = k => new RegExp(`(?:^| )${k}=([^ ]+)`).exec(sei)?.[1];
  const parts = [`libx264 core ${core}`];
  if (opt('rc') === 'crf' && opt('crf')) parts.push(`crf ${Number(opt('crf'))}`);
  else if (opt('rc') && opt('bitrate')) parts.push(`${opt('rc')} ${opt('bitrate')} kb/s`);
  if (opt('ref')) parts.push(`ref ${opt('ref')}`);
  if (opt('keyint')) parts.push(`keyint ${opt('keyint')}`);
  return parts.join(' · ');
}

export async function probe(exec, file, { count = true } = {}) {
  const a = ['-v', 'error'];
  if (count) a.push('-count_frames');
  a.push('-show_entries', 'stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames,sample_rate,channels:format=duration,size', '-of', 'json', file);
  const r = await exec(FFPROBE(), a, { label: `ffprobe ${path.basename(file)}`, quiet: true, timeoutSec: 600, sweep: false });
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new FilmError(EXIT.RUN, 'probe-failed', `ffprobe 读不懂 ${file}`); }
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const au = (j.streams || []).find(s => s.codec_type === 'audio');
  if (!v) throw new FilmError(EXIT.CONTRACT, 'no-video-stream', `${path.basename(file)} 里没有视频流`);
  return {
    width: v.width, height: v.height, fps: rate(v.r_frame_rate), avgFps: rate(v.avg_frame_rate), fpsRaw: v.r_frame_rate,
    frames: Number(v.nb_read_frames ?? v.nb_frames), duration: Number(j.format?.duration), size: Number(j.format?.size),
    codec: v.codec_name, profile: v.profile ?? null, level: v.level ?? null, pixFmt: v.pix_fmt,
    color: { range: v.color_range || 'unknown', space: v.color_space || 'unknown', transfer: v.color_transfer || 'unknown', primaries: v.color_primaries || 'unknown' },
    audio: au ? { codec: au.codec_name, rate: Number(au.sample_rate), channels: au.channels } : null,
  };
}

export async function framemd5(exec, file) {
  const r = await exec(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { label: 'framemd5', quiet: true, timeoutSec: 1800, sweep: false });
  return r.stdout.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim()).filter(h => /^[0-9a-f]{32}$/.test(h));
}

// 帧号从 0 起；输出 <dir>/f000123.png；select 表达式过长时分批
export async function extractFrames(exec, file, frames, dir, { logFile } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const uniq = [...new Set(frames)].sort((a, b) => a - b);
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 60) {
    const batch = uniq.slice(i, i + 60);
    const tmp = path.join(dir, `.batch-${i}`);
    fs.mkdirSync(tmp, { recursive: true });
    const sel = batch.map(f => `eq(n\\,${f})`).join('+');
    await exec(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-vf', `select='${sel}'`, '-fps_mode', 'passthrough', '-f', 'image2', path.join(tmp, '%06d.png')],
      { label: '取帧', quiet: true, timeoutSec: 1800, logFile, sweep: false });
    const got = fs.readdirSync(tmp).filter(n => n.endsWith('.png')).sort();
    if (got.length !== batch.length) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new FilmError(EXIT.CONTRACT, 'extract-frames', `从 ${path.basename(file)} 取帧只得到 ${got.length}/${batch.length} 张：成片帧数可能少于预期`);
    }
    got.forEach((n, k) => {
      const dst = path.join(dir, `f${String(batch[k]).padStart(6, '0')}.png`);
      fs.renameSync(path.join(tmp, n), dst);
      out.set(batch[k], dst);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

const COLOR_IN = { range: { pc: 'pc', jpeg: 'pc', tv: 'tv', mpeg: 'tv' }, space: { bt470bg: 'bt470bg', smpte170m: 'smpte170m', bt709: 'bt709' } };

// 网页版色彩链：输入已是 BT.709 tv 就只补标签；否则用 colorspace 滤镜一次性换矩阵与范围（4:2:0 上中性灰无偏差，实测色块最大误差 1.6 级）
export function colorChain(color) {
  const range = COLOR_IN.range[color.range] || 'pc';
  const space = COLOR_IN.space[color.space] || (range === 'pc' ? 'bt470bg' : 'bt709');
  if (range === 'tv' && space === 'bt709') return 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,format=yuv420p';
  return `colorspace=space=bt709:ispace=${space}:range=tv:irange=${range}:primaries=bt709:iprimaries=bt709:trc=bt709:itrc=bt709:format=yuv420p`;
}

export async function encodeWeb(exec, { src, srcInfo, audioFrom, out, fps, logFile, timeoutSec }) {
  // 长边超过 1920 时缩到 1920（竖屏按高），宽高保持偶数
  const long = Math.max(srcInfo.width, srcInfo.height);
  const scale = long > 1920 ? (srcInfo.width >= srcInfo.height ? 'scale=1920:-2:flags=lanczos,' : 'scale=-2:1920:flags=lanczos,') : '';
  const vf = `${colorChain(srcInfo.color)},${scale}setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709`;
  const tmp = `${out}.partial.mp4`;
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  if (audioFrom) a.push('-i', audioFrom);
  a.push('-map', '0:v:0');
  if (audioFrom) a.push('-map', '1:a:0?');
  a.push('-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-maxrate', '14M', '-bufsize', '18M',
    '-profile:v', 'high', '-level:v', '4.1', '-g', String(2 * fps), '-keyint_min', String(fps), '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  if (audioFrom) a.push('-c:a', 'copy');
  a.push('-movflags', '+faststart', tmp);
  try {
    await exec(FFMPEG(), a, { label: '网页版编码', logFile, timeoutSec, stallSec: 600 });
    fs.renameSync(tmp, out);
  } finally { fs.rmSync(tmp, { force: true }); }
  return out;
}

export async function muxSimple(exec, { video, audio, out, duration, logFile }) {
  const tmp = `${out}.partial.mp4`;
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video];
  if (audio) a.push('-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'apad', '-t', String(duration));
  else a.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', String(duration));
  a.push('-movflags', '+faststart', tmp);
  try {
    await exec(FFMPEG(), a, { label: '封装（复制画面）', logFile, timeoutSec: 900, stallSec: 300 });
    fs.renameSync(tmp, out);
  } finally { fs.rmSync(tmp, { force: true }); }
  return out;
}

// 48 kHz 16-bit 立体声 WAV；marks = [{ frame, kind: 'event' | 'cut' }]
export function clickTrack({ file, frames, fps, marks }) {
  const sr = 48000, n = Math.round(frames / fps * sr);
  const pcm = new Int16Array(n * 2);
  const amp = 0.18 * 32767;   // 约 −15 dBFS 峰值：听得清，不刺耳
  for (const m of marks) {
    const f0 = m.kind === 'cut' ? 1760 : 880, len = Math.round(sr * (m.kind === 'cut' ? 0.05 : 0.035));
    const start = Math.round(m.frame / fps * sr);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp(-i / (len / 5)) * Math.min(1, i / 48);
      const v = Math.round(amp * env * Math.sin(2 * Math.PI * f0 * i / sr));
      pcm[(start + i) * 2] = Math.max(-32768, Math.min(32767, pcm[(start + i) * 2] + v));
      pcm[(start + i) * 2 + 1] = Math.max(-32768, Math.min(32767, pcm[(start + i) * 2 + 1] + v));
    }
  }
  const data = Buffer.from(pcm.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28);
  h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

export const timecode = (frame, fps) => {
  const f = frame % fps, s = Math.floor(frame / fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
};
