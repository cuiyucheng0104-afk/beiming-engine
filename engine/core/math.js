// 北冥引擎 · 基础数学：区间、插值、缓动、确定性随机、单调样条。
// 除 mulberry 外都是纯函数：同样的输入永远得到同样的输出，任意一帧都能单独重渲。
// mulberry(seed) 本身是纯的，但它返回的生成器每调用一次都改写内部状态——只能在构建期（建场景、撒实例、
// 交给 createNoise2D/3D 洗牌）用；放进 render(t) 里逐帧取值，结果会依赖渲染顺序，分段并行时在段边界跳变。
// 逐帧随机一律用 hashi(帧号或拍号)。
//
// 来源：clamp、lerp、seg、ss、ei、eo、eio 与 monotone（Fritsch–Carlson 单调样条）改写自 LemoLab 的 lemo-opuscar
// （cases/vendor/lemo-opuscar/core/lib.js，固定提交 bebbbe1），按其 MIT 许可使用并保留版权声明，许可全文见
// cases/licenses/LemoLab-MIT.txt；mulberry 为公开的 mulberry32 算法；hashi 的乘法与移位常数是公开流传的整数哈希写法
// （同库 styles/hd-2d/demo/px.js 的 h2 用的是同一组）；其余部分为北冥引擎原创。
// @provenance lemo-opuscar@bebbbe1:core/lib.js
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: 2026 LemoLab
// LemoLab 部分的许可原文（作品站按文件分发这些模块，许可声明随文件走；与 cases/licenses/LemoLab-MIT.txt 相同）：
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions
//   of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// t 在 [a, b] 里的进度，夹到 0..1
export const seg = (t, a, b) => clamp((t - a) / (b - a));
// smoothstep 与三次缓入
export const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
export const ei = t => Math.pow(clamp(t), 3);
export const eo = t => 1 - Math.pow(1 - clamp(t), 3);
export const eio = t => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2; };
// 五次 smootherstep：起止的速度和加速度都为零，镜头推拉用它更柔
export const ss5 = t => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };

// 整数 → [0, 1) 的确定性哈希（帧号、实例号取随机值用）
export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// 32 位整数种子的伪随机数发生器（Mulberry32）：返回 () => [0, 1)。返回的生成器有状态，只在构建期用（见文件头）
export function mulberry(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 单调三次插值（Fritsch–Carlson）：keys = [[t, v], ...]，返回 t => v。
// 关键帧之间不会过冲，适合镜头、速度、亮度这类不许"回弹"的曲线。
export function monotone(keys) {
  const n = keys.length, X = keys.map(k => k[0]), Y = keys.map(k => k[1]);
  if (n === 1) return () => Y[0];
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((Y[i + 1] - Y[i]) / (X[i + 1] - X[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], r = a * a + b * b;
    if (r > 9) { const k = 3 / Math.sqrt(r); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return t => {
    if (t <= X[0]) return Y[0];
    if (t >= X[n - 1]) return Y[n - 1];
    let i = 0; while (t > X[i + 1]) i++;
    const h = X[i + 1] - X[i], u = (t - X[i]) / h, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * Y[i] + (u3 - 2 * u2 + u) * h * m[i]
      + (-2 * u3 + 3 * u2) * Y[i + 1] + (u3 - u2) * h * m[i + 1];
  };
}
