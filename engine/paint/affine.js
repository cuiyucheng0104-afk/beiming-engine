// 北冥引擎 · 2D 仿射矩阵：[a, b, c, d, e, f]，与 Canvas 2D 的 setTransform 同序。
//   mul(m, n)              m·n（先作用 n，再作用 m）
//   translate(x, y) / scale(k) / rotate(弧度)
//   chain(m1, m2, ...)     依次相乘：chain(A, B, C) = A·B·C
//   zoomAt(x, y, k)        以 (x, y) 为中心缩放 k 倍（推镜）
//   apply(m, [x, y])       → [x', y']
//   asMatrix(m)            → [a, b, c, d, e, f]：数组（含类型化数组）原样返回；DOMMatrix（ctx.getTransform() 的结果）
//                            或 { a, b, c, d, e, f } 取出六个数；别的类型直接报错。mul / apply 的参数两种都收。
//
// 来源：mul、translate、rotate、scale、apply 与矩阵约定（[a, b, c, d, e, f]，与 Canvas 2D setTransform 同序）改写自 LemoLab 的
// lemo-opuscar（cases/vendor/lemo-opuscar/styles/papercut-red/demo/rig.js 的 mul / T / R / S / ap，固定提交 bebbbe1），按其 MIT 许可
// 使用并保留版权声明，许可全文见 cases/licenses/LemoLab-MIT.txt；asMatrix、chain、zoomAt 为北冥引擎原创。
// @provenance lemo-opuscar@bebbbe1:styles/papercut-red/demo/rig.js
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

export function asMatrix(m) {
  if (m && m.length >= 6) return m;
  if (m && typeof m.a === 'number' && typeof m.f === 'number') return [m.a, m.b, m.c, m.d, m.e, m.f];
  throw new TypeError(`矩阵要么是 [a, b, c, d, e, f] 数组，要么是 DOMMatrix：${m}`);
}
const M6 = m => (m.length >= 6 ? m : asMatrix(m));

export const mul = (m, n) => { m = M6(m); n = M6(n); return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; };
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = k => [k, 0, 0, k, 0, 0];
export const rotate = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };
export const apply = (m, p) => { m = M6(m); return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; };
export const chain = (...ms) => ms.reduce((a, b) => mul(a, b));
export const zoomAt = (x, y, k) => chain(translate(x, y), scale(k), translate(-x, -y));
