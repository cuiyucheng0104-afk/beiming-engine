// 北冥引擎 · 原生层 · 镜头：按时间分段的摄影机运动（每段一条机位曲线），确定性、只读当前时间。
//
//   shotAt(t, shots)        → { eye, at, fov, index, u }   t 秒落在哪一段、段内进度 u（已缓动）与插值后的机位
//   <ShotCamera t shots near far />                       同上，直接给出原生 Camera3d（透视）
//
//   shots = [{ until, eye: [起点, 终点] | 定点, at: [起点, 终点] | 定点, fov: [起, 止] | 定值, ease? }, …]
//     每段从上一段的 until（第一段从 0）开始，到自己的 until 结束；t 超过最后一段时停在最后一段的终点（u 夹到 1）
//     eye / at 是 [x, y, z]；写成 [[x0,y0,z0], [x1,y1,z1]] 表示段内从起点移到终点
//     ease：'linear'（默认）| 'ss' | 'ss5' | 'ei' | 'eo' | 'eio'，见 engine/core/math.js
//   插值公式 a + (b − a)·u 与 engine/core/math.js 的 lerp 相同。

import { Camera3d } from 'raea/camera';
import { Transform } from 'raea/transform';
import { clamp, lerp, ease as easeOf } from './math.ts';

type V3 = number[];
export interface Shot { until: number, eye: V3 | V3[], at: V3 | V3[], fov: number | number[], ease?: string }

const isPair = (v: unknown): v is V3[] => Array.isArray(v) && Array.isArray((v as unknown[])[0]);
const along = (v: V3 | V3[], u: number): V3 => isPair(v) ? v[0].map((a, i) => lerp(a, v[1][i], u)) : v;
const alongN = (v: number | number[], u: number) => Array.isArray(v) ? lerp(v[0], v[1], u) : v;

export function shotAt(t: number, shots: Shot[]) {
  if (!shots.length) throw new RangeError('shotAt: 至少要有一段镜头');
  let index = shots.findIndex(s => t < s.until);
  if (index < 0) index = shots.length - 1;
  const s = shots[index], start = index ? shots[index - 1].until : 0;
  const u = easeOf(s.ease)(clamp((t - start) / (s.until - start)));
  return { eye: along(s.eye, u), at: along(s.at, u), fov: alongN(s.fov, u), index, u };
}

export function ShotCamera({ t, shots, near = 0.1, far = 600 }: { t: number, shots: Shot[], near?: number, far?: number }) {
  const { eye, at, fov } = shotAt(t, shots);
  return <Camera3d transform={Transform.fromXyz(eye[0], eye[1], eye[2]).lookingAt(at)} projection={{ Perspective: { fov: fov * Math.PI / 180, near, far } }} />;
}
