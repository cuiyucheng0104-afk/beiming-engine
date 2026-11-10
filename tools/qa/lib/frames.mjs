// 北冥 QA · 解码取帧：一次完整解码把视频缩成小尺寸亮度流（按标签换算成 0–255 全范围，即观众看到的明暗），逐帧交给分析器；
// 另有按帧号取缩略图（RGB）和取原尺寸 Y 平面（不换算，用来核对「标签与像素是否一致」）。
//
//   analysisSize(w, h, maxW)          → { w, h }：等比缩到不超过 maxW 宽，宽高取偶数
//   streamLuma(file, { w, h, onFrame, timeoutMs })   onFrame(Uint8Array(w*h), index)；返回帧数
//   grabRgb(file, frames, { w, h })  → Map<帧号, Uint8Array(w*h*3)>（frames 升序去重后一次取完）
//   grabRawY(file, frames, { w, h }) → Map<帧号, Uint8Array(w*h)>（Y 平面原码值，有限范围应在 16–235）
import { run, tool, tail } from './proc.mjs';
import { QaError, EXIT } from './cli-kit.mjs';

export function analysisSize(w, h, maxW = 480) {
  const s = Math.min(1, maxW / w);
  const ow = Math.max(2, Math.round((w * s) / 2) * 2);
  const oh = Math.max(2, Math.round((h * s) / 2) * 2);
  return { w: ow, h: oh };
}

function framer(size, onFrame) {
  let buf = Buffer.alloc(0), n = 0;
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= size) {
        onFrame(new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size)), n++);
        buf = buf.subarray(size);
      }
    },
    get count() { return n; },
    get rest() { return buf.length; },
  };
}

export async function streamLuma(file, { w, h, onFrame, timeoutMs }) {
  const fr = framer(w * h, onFrame);
  const r = await run(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-vf', `scale=${w}:${h}:flags=area,format=gray`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { timeoutMs, onStdout: c => fr.push(c) });
  if (r.code !== 0) throw new QaError('input.decode', `解码画面失败：${tail(r.stderr)}`, { hint: '先跑 qa delivery 看完整解码一项', exitCode: EXIT.GATE });
  return fr.count;
}

const selectExpr = frames => frames.map(f => `eq(n\\,${f})`).join('+');

async function grab(file, frames, { w, h, vf, pixFmt, bpp, timeoutMs }) {
  const list = [...new Set(frames.filter(f => Number.isInteger(f) && f >= 0))].sort((a, b) => a - b);
  const out = new Map();
  if (!list.length) return out;
  // 帧多时分批，免得滤镜表达式过长（Windows 命令行上限 32 KB）
  for (let i = 0; i < list.length; i += 120) {
    const part = list.slice(i, i + 120);
    let k = 0;
    const fr = framer(w * h * bpp, buf => { out.set(part[k++], buf); });
    const r = await run(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0',
      '-vf', `select='${selectExpr(part)}',${vf}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1'],
    { timeoutMs, onStdout: c => fr.push(c) });
    if (r.code !== 0) throw new QaError('input.decode', `取帧失败：${tail(r.stderr)}`, { exitCode: EXIT.GATE });
  }
  return out;
}

export const grabRgb = (file, frames, { w, h, timeoutMs } = {}) =>
  grab(file, frames, { w, h, vf: `scale=${w}:${h}:flags=bicubic,format=rgb24`, pixFmt: 'rgb24', bpp: 3, timeoutMs });

export const grabRawY = (file, frames, { w, h, timeoutMs } = {}) =>
  grab(file, frames, { w, h, vf: 'extractplanes=y', pixFmt: 'gray', bpp: 1, timeoutMs });
