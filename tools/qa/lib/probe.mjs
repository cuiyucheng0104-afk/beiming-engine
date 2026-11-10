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
import { QaError, EXIT } from './cli-kit.mjs';
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
