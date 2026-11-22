// 北冥 QA · 容器与码流探测：ffprobe 读格式与流参数、视频包时间戳；sha256；MP4 顶层 box 顺序（faststart 判定）。
//
//   probeFile(file)        → { format, streams, video, audio, audios, raw }；ffprobe 失败抛 QaError('input.unreadable')，
//                            由调用方记成「容器无法解析」的硬失败（不是用法错误：坏片本身就是验收不通过）
//   videoPackets(file)     → [{ pts, dts, duration, key }]（v:0，按 PTS 升序）
//   sha256File(file)       → 十六进制
//   topLevelBoxes(file)    → [{ type, offset, size }]；只读文件头部的 box 头，不读整个文件
import fs from 'node:fs';
import crypto from 'node:crypto';
import { run, tool, tail } from './proc.mjs';
import { QaError, EXIT, usageError } from './cli-kit.mjs';
import { videoStreamSha256 } from '../../../engine/render/lib/video-stream-hash.mjs';
import { parseFps } from './profiles.mjs';

export async function probeFile(file, { timeoutMs } = {}) {
  const r = await run(tool('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs });
  let raw = null;
  try { raw = JSON.parse(r.stdout.toString('utf8') || 'null'); } catch { raw = null; }
  if (r.code !== 0 || !raw || !raw.format) {
    throw new QaError('input.unreadable', `ffprobe 读不了这个文件：${tail(r.stderr) || '没有输出'}`,
      { hint: '文件可能被截短、还在写、或不是音视频文件；重新封装或重渲后再验', exitCode: EXIT.GATE });
  }
  const streams = raw.streams || [];
  const isCover = s => s.disposition && s.disposition.attached_pic === 1;
  const videos = streams.filter(s => s.codec_type === 'video' && !isCover(s));
  const audios = streams.filter(s => s.codec_type === 'audio');
  return { format: raw.format, streams, video: videos[0] || null, videos, audio: audios[0] || null, audios, raw };
}

export function checkRecordHash(doc, file) {
  if (typeof doc.videoStreamSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(doc.videoStreamSha256)) {
    throw usageError(`${file} 缺少有效的视频码流指纹 videoStreamSha256`);
  }
}

// 一次 report 的各组共用码流和探测结果；没有采用渲染记录时不额外读成片。
export function recordVideoVerifier(input, { timeoutMs, probe, decodedFrames } = {}) {
  let hash, video = probe?.video;
  return async (doc, file, probedVideo) => {
    checkRecordHash(doc, file);
    video ??= probedVideo ?? (await probeFile(input, { timeoutMs })).video;
    const fps = rate(video?.avg_frame_rate) || rate(video?.r_frame_rate);
    const frames = decodedFrames ?? Number(video?.nb_frames);
    if (!video || doc.width !== video.width || doc.height !== video.height || doc.frameCount !== frames ||
        !fps || !Number.isFinite(doc.fps) || Math.abs(doc.fps - fps.value) > 1e-6) {
      throw usageError(`${file} 的帧数、画幅或帧率与成片不符`);
    }
    // 页面编码器不写显示矩阵；容器旋转或镜像不会改变视频包，却会改变 QA 的像素坐标。
    if (video.side_data_list?.some(d => d.side_data_type === 'Display Matrix') || Number(video.tags?.rotate)) {
      throw usageError(`${file} 未计入被检视频的显示矩阵，不能复用页面像素坐标`);
    }
    hash ??= videoStreamSha256(input, args => run(tool('ffmpeg'), args, { timeoutMs }));
    if (doc.videoStreamSha256 !== await hash) throw usageError(`${file} 的视频码流指纹与成片不符`);
  };
}

export async function videoPackets(file, { timeoutMs } = {}) {
  const r = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,dts,duration,flags', '-of', 'csv=p=0', file], { timeoutMs, maxStdout: 1 << 30 });
  if (r.code !== 0) throw new QaError('input.unreadable', `读视频包时间戳失败：${tail(r.stderr)}`, { exitCode: EXIT.GATE });
  const out = [];
  for (const line of r.stdout.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [pts, dts, duration, flags] = line.split(',');
    out.push({ pts: pts === 'N/A' ? null : +pts, dts: dts === 'N/A' ? null : +dts, duration: duration === 'N/A' ? null : +duration, key: (flags || '').includes('K') });
  }
  out.sort((a, b) => (a.pts ?? 0) - (b.pts ?? 0));
  return out;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

export function topLevelBoxes(file, limit = 64) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const out = [];
    const head = Buffer.alloc(16);
    let off = 0;
    while (off + 8 <= size && out.length < limit) {
      fs.readSync(fd, head, 0, 16, off);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - off;
      if (len < 8) break;
      out.push({ type, offset: off, size: len });
      off += len;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

// ffprobe 字段的小工具
export const num = v => (v === undefined || v === null || v === 'N/A' || v === '' ? null : Number(v));
export const rate = v => parseFps(v);
export const sameRate = (a, b) => !!a && !!b && a.num * b.den === b.num * a.den;
