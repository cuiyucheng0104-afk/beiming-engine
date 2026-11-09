// 北冥引擎 · 原生层 · 确定性数学与随机：直接复用 engine/core 的同一份源码，不在原生端另抄一套。
// 原生运行时能解析作品目录之外的相对 import（.js / .ts / .tsx / .json 均已实测），所以这里是 re-export，
// A 路（浏览器）与 B 路（原生）调用的是同一个文件里的同一个公式，数值逐位一致。
//
//   clamp lerp seg ss ei eo eio ss5 hashi mulberry monotone TAU DEG   见 engine/core/math.js
//   frameOf hold heldTime tick snapTime                              见 engine/core/clock.js（一拍二 / 一拍三的量化）
//   sinHash(n, offset = 311.7)   着色器式正弦哈希 fract(sin(n·127.1 + offset)·43758.5453)，与 engine/overlay/brush.js 的
//                                hash1、src/ferry.js 的 h1 同式；offset 可改，以便沿用已有作品的布局种子
//   ease(name)                   按名字取缓动函数：'linear' | 'ss' | 'ss5' | 'ei' | 'eo' | 'eio'

export { clamp, lerp, seg, ss, ei, eo, eio, ss5, hashi, mulberry, monotone, TAU, DEG } from '../core/math.js';
export { frameOf, hold, heldTime, tick, snapTime } from '../core/clock.js';
import { ss, ei, eo, eio, ss5 } from '../core/math.js';

export const sinHash = (n: number, offset = 311.7) => { const x = Math.sin(n * 127.1 + offset) * 43758.5453; return x - Math.floor(x); };

const EASES: Record<string, (t: number) => number> = { linear: (t: number) => t, ss, ss5, ei, eo, eio };
export function ease(name: string = 'linear'): (t: number) => number {
  const f = EASES[name];
  if (!f) throw new TypeError(`ease: 未知缓动 ${JSON.stringify(name)}，可用 ${Object.keys(EASES).join(' / ')}`);
  return f;
}
