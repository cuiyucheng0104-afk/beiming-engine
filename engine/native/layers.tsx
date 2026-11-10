// 北冥引擎 · 原生层 · 底板分层、视差与整幅叠层：二维背景层、三维场景里的绘画面片、序列帧面片，以及盖在整幅画面上的纸纹与暗角。
// 所有位置都是时间 / 帧号的纯函数：任意帧可单独重渲。
//
//   drift(p, v, t)                         基准 p + t·v（逐分量）；三维面片与二维层共用
//   <Backdrop src t x y width height drift? style? />
//                                          二维底板（在 Canvas3D 之后的页面层里，画在三维之下）：像素坐标，drift=[每秒 dx, dy]
//   <PlateCard name src t position width height? drift? shadow? rotation? />
//                                          三维场景里的不受光图片面片（ImagePlane，朝 +Z）；drift=[每秒 dx, dy, dz] 产生真实视差。
//                                          透明底板的截断边在 film.json 的 images[].edge 里烘有机软边（engine/native/edge.mjs），
//                                          摆位时让截断边始终在画外（Node 侧用 view.js 的 cardOnScreen / edgeVisible 核对）
//   <SequencePlane name src sheet t start? fps? loop? position width … />
//                                          序列帧面片：src 是 engine/native/sequence.mjs 生成的图集 PNG，sheet 是同名 .json 的内容
//                                          { grid:[列,行], frames, fps }；第 n 帧 = floor((t − start)·fps)，loop 时取模，否则停在首尾帧
//   sequenceFrame(sheet, t, start, fps, loop)   只算帧号
//   <FrameSequence dir sheet t start? fps? hold? style? />
//                                          逐帧 PNG 序列（sequence.mjs 的 output: "frames"，例如 A 路页面渲出的书法片名）叠在页面层：
//                                          t < start 不画；播完后 hold（默认）停在最后一帧，否则消失
//   <PaperOverlay src f width height opacity? scale? tile? boil? seed? />
//                                          整幅纸纹：把一张可平铺的纸纹（例：assets/plates/paper.png，1024²、灰度）铺满画面，
//                                          multiply 叠在三维与页面底板之上（放在片名、字幕之前）。scale 按设计高 1040 换算（H/1040），
//                                          分辨率变了纸纹观感不变；boil 帧换一张「纸」（默认 2：一拍二，与画的节拍一致），
//                                          所以纸纹不是钉在屏幕上的一层脏点；boil=0 才静止。opacity 0.10–0.16 合适（A 路正片取 0.12–0.14）
//   <Vignette width height strength? reach? color? />
//                                          整幅暗角（页面层径向渐变），盖住天空底板与三维两层，不像 FramePass 只作用在三维上
//   <Glow x y radius color? strength? core? />
//                                          页面层光晕（径向渐变，普通叠加）：灯、窗、发光体在天空前的晕。Canvas3D layered 时
//                                          三维的 Bloom 只落在三维物体自己的像素上，透明处（下面是页面层天空）看不到光晕（2026-11-10 实测），
//                                          所以用 view.js 的 project 把发光点投到屏幕，在页面层贴晕。radius 是像素，color 是十六进制色。
//                                          不用 mix-blend-mode：canary.2 的页面层里「径向渐变 + mix-blend-mode」整块不出图（实测），
//                                          纯色块加 blend 才生效；所以晕用浅暖色低透明度普通叠加

import { staticFile } from 'raea';
import { ImagePlane } from 'raea/3d';
import { sinHash } from './math.ts';
import { rgb } from './palette.ts';

type V = number[];
export const drift = (p: V, v: V | undefined, t: number): V => v ? p.map((x, i) => x + t * (v[i] ?? 0)) : p;

export function Backdrop({ src, t, x, y, width, height, drift: v, style }: { src: string, t: number, x: number, y: number, width: number, height: number, drift?: V, style?: Record<string, unknown> }) {
  const [left, top] = drift([x, y], v, t);
  return <img src={src} style={{ position: 'absolute', left, top, width, height, ...style }} />;
}

export function PlateCard({ t, position, drift: v, shadow = false, ...rest }: { name: string, src: string, t: number, position: V, width: number, height?: number, drift?: V, shadow?: boolean, rotation?: V }) {
  return <ImagePlane {...rest} position={drift(position, v, t)} shadow={shadow} />;
}

export interface Sheet { grid?: [number, number], frames: number, fps: number }

export function sequenceFrame(sheet: Sheet, t: number, start = 0, fps = sheet.fps, loop = false) {
  const n = Math.floor((t - start) * fps + 1e-6);
  if (loop) return ((n % sheet.frames) + sheet.frames) % sheet.frames;
  return Math.max(0, Math.min(sheet.frames - 1, n));
}

export function SequencePlane({ sheet, t, start = 0, fps, loop = false, shadow = false, ...rest }: { name: string, src: string, sheet: Sheet, t: number, start?: number, fps?: number, loop?: boolean, position: V, width: number, height?: number, rotation?: V, shadow?: boolean }) {
  return <ImagePlane {...rest} grid={sheet.grid} frame={sequenceFrame(sheet, t, start, fps ?? sheet.fps, loop)} shadow={shadow} />;
}

export function FrameSequence({ dir, sheet, t, start = 0, fps, hold = true, style }: { dir: string, sheet: Sheet, t: number, start?: number, fps?: number, hold?: boolean, style?: Record<string, unknown> }) {
  const rate = fps ?? sheet.fps;
  if (t < start || (!hold && t >= start + sheet.frames / rate)) return null;
  const n = sequenceFrame(sheet, t, start, rate, false);
  return <img src={staticFile(`${dir}/${String(n).padStart(6, '0')}.png`)} style={{ position: 'absolute', left: 0, top: 0, ...style }} />;
}

export function PaperOverlay({ src, f, width, height, opacity = 0.14, scale = height / 1040, tile = 1024, boil = 2, seed = 1 }: { src: string, f: number, width: number, height: number, opacity?: number, scale?: number, tile?: number, boil?: number, seed?: number }) {
  const T = tile * scale, k = boil > 0 ? Math.floor(f / boil) : 0;
  const ox = -T * sinHash(k * 1.731 + seed), oy = -T * sinHash(k * 3.117 + seed, 97.3);
  const cols = Math.ceil((width - ox) / T), rows = Math.ceil((height - oy) / T), tiles = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) tiles.push([i, j]);
  return <>{tiles.map(([i, j]) => <img key={`${i}-${j}`} src={src} style={{ position: 'absolute', left: ox + i * T, top: oy + j * T, width: T, height: T, opacity, mixBlendMode: 'multiply' }} />)}</>;
}

export function Vignette({ width, height, strength = 0.22, reach = 0.55, color = '20,16,48' }: { width: number, height: number, strength?: number, reach?: number, color?: string }) {
  return <div style={{ position: 'absolute', left: 0, top: 0, width, height, background: `radial-gradient(ellipse at center, rgba(${color},0) ${Math.round(reach * 100)}%, rgba(${color},${strength}) 100%)` }} />;
}

export function Glow({ x, y, radius, color = '#FFD6A0', strength = 0.55, core = 0.14 }: { x: number, y: number, radius: number, color?: string, strength?: number, core?: number }) {
  const c = rgb(color).map(v => Math.round(v * 255)).join(',');
  return <div style={{ position: 'absolute', left: x - radius, top: y - radius, width: 2 * radius, height: 2 * radius,
    background: `radial-gradient(circle at center, rgba(${c},${strength}) 0%, rgba(${c},${(strength * 0.42).toFixed(3)}) ${Math.round(core * 100)}%, rgba(${c},0) 70%)` }} />;
}
