// 成片探测与取帧（ffprobe / ffmpeg），供 H1 的任务规格核对、评审素材与自动参考指标使用。
//
// 接口：
//   probeVideo(file) → { width, height, fps, frames, duration, pixFmt, color{range,space,transfer,primaries},
//                        audio{codec,sampleRate,channels}|null } 或 { error }
//   extractFrames(file, frames[], { width, outDir }) → [{ frame, file }]（PNG，按帧号精确选帧）
//   readFrameRGB(file, frame, { width, height }) → { width, height, data: Uint8Array(RGB) }
//   readImageRGB(png, { width, height }) → 同上（用 ffmpeg 解码，任何格式）
// 依赖 FFmpeg ≥ 7（D09）；不可用时返回 { error }，由调用方判「不可用」。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runTool } from './exec.mjs';

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const rate = s => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(s ?? ''));
  if (!m) return null;
  const v = Number(m[1]) / Number(m[2] ?? 1);
  return Number.isFinite(v) && v > 0 ? v : null;
};

export async function probeVideo(file, { timeoutMs = 5 * 60 * 1000 } = {}) {
  const res = await runTool(FFPROBE, ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs });
  if (res.error) return { error: `无法运行 ffprobe（${res.error.code ?? res.error.message}）` };
  if (res.timedOut) return { error: 'ffprobe 超时' };
  if (res.exitCode !== 0) return { error: `ffprobe 读不了这个文件（exit ${res.exitCode}）：${res.stderr.trim().split('\n')[0] ?? ''}` };
  let data;
  try { data = JSON.parse(res.stdout); } catch { return { error: 'ffprobe 输出不是 JSON' }; }
  const v = (data.streams ?? []).find(s => s.codec_type === 'video');
  const a = (data.streams ?? []).find(s => s.codec_type === 'audio');
  if (!v) return { error: '文件里没有视频流' };
  const fps = rate(v.avg_frame_rate) ?? rate(v.r_frame_rate);
  return {
    width: v.width ?? null,
    height: v.height ?? null,
    fps: fps === null ? null : Math.round(fps * 1000) / 1000,
    rFrameRate: v.r_frame_rate ?? null,
    frames: v.nb_read_packets !== undefined ? Number(v.nb_read_packets) : (v.nb_frames !== undefined ? Number(v.nb_frames) : null),
    duration: data.format?.duration !== undefined ? Number(data.format.duration) : null,
    codec: v.codec_name ?? null,
    pixFmt: v.pix_fmt ?? null,
    color: { range: v.color_range ?? null, space: v.color_space ?? null, transfer: v.color_transfer ?? null, primaries: v.color_primaries ?? null },
    audio: a ? { codec: a.codec_name ?? null, sampleRate: a.sample_rate ? Number(a.sample_rate) : null, channels: a.channels ?? null } : null,
  };
}

/** 按帧号精确取帧到 PNG（select=eq(n,…)，帧号从 0 开始）。 */
export async function extractFrames(file, frames, { width = 960, outDir, prefix = 'f' } = {}) {
  const wanted = [...new Set(frames.filter(n => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
  if (!wanted.length) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const expr = wanted.map(n => `eq(n\\,${n})`).join('+');
  const pattern = path.join(outDir, `${prefix}-tmp-%04d.png`);
  const res = await runTool(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vf', `select='${expr}',scale=${width}:-2:flags=lanczos`, '-fps_mode', 'passthrough', '-y', pattern], { timeoutMs: 10 * 60 * 1000 });
  if (res.error || res.exitCode !== 0) throw new Error(`ffmpeg 取帧失败：${res.error?.message ?? res.stderr.trim().split('\n')[0]}`);
  const out = [];
  wanted.forEach((n, i) => {
    const tmp = path.join(outDir, `${prefix}-tmp-${String(i + 1).padStart(4, '0')}.png`);
    if (!fs.existsSync(tmp)) return;
    const dst = path.join(outDir, `${prefix}${String(n).padStart(5, '0')}.png`);
    fs.renameSync(tmp, dst);
    out.push({ frame: n, file: dst });
  });
  return out;
}

/** 解码一帧为 RGB（缩放到 width×height），二进制直接从 ffmpeg 的 stdout 读。 */
export async function readFrameRGB(file, frame, { width = 320, height = 180 } = {}) {
  return decodeBinary(['-i', file, '-vf', `select='eq(n\\,${frame})',scale=${width}:${height}:flags=area`], width, height);
}

export async function readImageRGB(file, { width = 320, height = 180 } = {}) {
  return decodeBinary(['-i', file, '-vf', `scale=${width}:${height}:flags=area`], width, height);
}

function decodeBinary(inputArgs, width, height) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => reject(new Error(`无法运行 ffmpeg（${e.code ?? e.message}）`)));
    child.on('close', code => {
      const data = Buffer.concat(chunks);
      if (code !== 0 || data.length < width * height * 3) reject(new Error(`ffmpeg 解码失败：${err.trim().split('\n')[0] || `只得到 ${data.length} 字节`}`));
      else resolve({ width, height, data: new Uint8Array(data.buffer, data.byteOffset, width * height * 3) });
    });
  });
}

