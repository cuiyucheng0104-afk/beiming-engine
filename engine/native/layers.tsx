// 北冥引擎 · 原生层 · 底板分层与视差：二维背景层、三维场景里的绘画面片、序列帧面片（页面作品 / 视频 → 图集）。
// 所有位置都是 t 的纯函数：基准位置 + t × 漂移速度，任意帧可单独重渲。
//
//   drift(p, v, t)                         基准 p + t·v（逐分量）；三维面片与二维层共用
//   <Backdrop src t x y width height drift? style? />
//                                          二维底板（在 Canvas3D 之后的页面层里，画在三维之下）：像素坐标，drift=[每秒 dx, dy]
//   <PlateCard name src t position width height? drift? shadow? rotation? />
//                                          三维场景里的不受光图片面片（ImagePlane）；drift=[每秒 dx, dy, dz] 产生真实视差
//   <SequencePlane name src sheet t start? fps? loop? position width … />
//                                          序列帧面片：src 是 engine/native/sequence.mjs 生成的图集 PNG，sheet 是同名 .json 的内容
//                                          { grid:[列,行], frames, fps }；第 n 帧 = floor((t − start)·fps)，loop 时取模，否则停在首尾帧
//   sequenceFrame(sheet, t, start, fps, loop)   只算帧号

import { ImagePlane } from 'raea/3d';

type V = number[];
export const drift = (p: V, v: V | undefined, t: number): V => v ? p.map((x, i) => x + t * (v[i] ?? 0)) : p;

export function Backdrop({ src, t, x, y, width, height, drift: v, style }: { src: string, t: number, x: number, y: number, width: number, height: number, drift?: V, style?: Record<string, unknown> }) {
  const [left, top] = drift([x, y], v, t);
  return <img src={src} style={{ position: 'absolute', left, top, width, height, ...style }} />;
}

export function PlateCard({ t, position, drift: v, shadow = false, ...rest }: { name: string, src: string, t: number, position: V, width: number, height?: number, drift?: V, shadow?: boolean, rotation?: V }) {
  return <ImagePlane {...rest} position={drift(position, v, t)} shadow={shadow} />;
}

export interface Sheet { grid: [number, number], frames: number, fps: number }

export function sequenceFrame(sheet: Sheet, t: number, start = 0, fps = sheet.fps, loop = false) {
  const n = Math.floor((t - start) * fps + 1e-6);
  if (loop) return ((n % sheet.frames) + sheet.frames) % sheet.frames;
  return Math.max(0, Math.min(sheet.frames - 1, n));
}

export function SequencePlane({ sheet, t, start = 0, fps, loop = false, shadow = false, ...rest }: { name: string, src: string, sheet: Sheet, t: number, start?: number, fps?: number, loop?: boolean, position: V, width: number, height?: number, rotation?: V, shadow?: boolean }) {
  return <ImagePlane {...rest} grid={sheet.grid} frame={sequenceFrame(sheet, t, start, fps ?? sheet.fps, loop)} shadow={shadow} />;
}
