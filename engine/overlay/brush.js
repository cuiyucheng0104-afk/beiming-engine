// 北冥引擎 · 毛笔写字：用字体里的字形当"墨"，按手标的笔画骨架把字一笔一笔揭开，收笔快的笔画带飞白（枯笔露白）。
// 骨架 = 按笔顺排列的笔画中线，每笔是 [[x, y], ...]，单位 em，原点在字的中心（textAlign center / textBaseline middle）。
//   buildBrushGlyph(ch, o) → glyph    预计算（每个字号一次，约 30–50 ms）。o：
//       font    画字形用的 CSS font 串；size 字号（像素）；strokes 骨架；span [t0, t1] 整个字的书写区间（秒）
//               字体必须已经就绪：document.fonts 里登记了这个字族、却还在下载时直接报错，免得把后备字体的字形算进 glyph
//               （调用方常按字号缓存 glyph，后备字形一旦缓存就再也不会重算）。从没登记过的字族浏览器当系统字体，这里查不出来，
//               调用方要自己先等 loadFonts 完成
//       dry     每笔的飞白强度（0 = 不露白），dryScale 整体倍数（默认 1）
//       gap     笔与笔之间的提笔间隙（秒，默认 0.012）；hold 每笔的顿笔常数（em，默认 0.14，短笔也有起收的时间）
//     做法：距离变换估每一笔的半宽；字形每个像素归给"笔身包含它的、最先写的那一笔"（都不含就归最近的一笔），
//           记下它在该笔上的弧长位置与飞白系数；总时长按"笔画长度 + 顿笔常数"分给各笔。
//     glyph = { size, out（size × size 的画布）, strokes: [{ L, t0, t1 }], ... }
//   paintBrushGlyph(glyph, t, { edge, rgb }) → 是否有像素露出
//     把时刻 t 已经写到的部分画进 glyph.out：每笔的笔锋沿骨架按缓入缓出推进，edge 是笔锋前沿的柔边宽（em，默认 0.035），rgb 墨色
//   chamfer(inside, W, H)              倒角距离变换：inside（Uint8Array，1 = 在形内）每个像素到形状边缘的距离（像素）
//
// 来源：chamfer() 的两趟倒角距离写法改写自 LemoLab 的 lemo-opuscar（cases/vendor/lemo-opuscar/styles/chalkboard/demo/js/chalk.js，
// 固定提交 bebbbe1），「字形当蒙版、按笔画中线给每个像素定揭开顺序」的做法也取自该文件的 bakeOutline；hash1 / vnoise 与同库
// core/lib.js 的 hash / vnoise 相同；按其 MIT 许可使用并保留版权声明，许可全文见 cases/licenses/LemoLab-MIT.txt；骨架、笔画归属、
// 飞白、时间分配与绘制为北冥引擎原创。
// @provenance lemo-opuscar@bebbbe1:styles/chalkboard/demo/js/chalk.js
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

import { clamp, lerp, ss, seg } from '../core/math.js';
import { catmullRom, project } from '../paint/curve.js';

// 一维值噪声：给飞白分出一道道"笔毛"
const hash1 = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const vnoise = x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash1(i), hash1(i + 1), u); };

export function chamfer(inside, W, H) {
  const d = new Float32Array(W * H), D = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) { v = Math.min(v, d[i - W] + 1); if (x > 0) v = Math.min(v, d[i - W - 1] + D); if (x < W - 1) v = Math.min(v, d[i - W + 1] + D); }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < H - 1) { v = Math.min(v, d[i + W] + 1); if (x < W - 1) v = Math.min(v, d[i + W + 1] + D); if (x > 0) v = Math.min(v, d[i + W - 1] + D); }
    d[i] = v;
  }
  return d;
}

export function buildBrushGlyph(ch, { font, size: F, strokes, span, dry = [], dryScale = 1, gap = 0.012, hold = 0.14 }) {
  if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(font, ch))
    throw new Error(`buildBrushGlyph：字体还没加载好（${font}，“${ch}”）；先等 loadFonts / document.fonts.load 完成再预计算字形`);
  const sks = strokes.map(P => catmullRom(P, 8));
  const size = Math.ceil(F * 1.12), cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
  c.fillText(ch, size / 2, size / 2);
  const src = c.getImageData(0, 0, size, size).data;
  const inside = new Uint8Array(size * size); for (let i = 0; i < inside.length; i++) inside[i] = src[i * 4 + 3] > 127 ? 1 : 0;
  const dt = chamfer(inside, size, size);
  // 每一笔的半宽（em）：沿骨架采样距离变换取 70 分位
  const hw = sks.map(sk => {
    const v = [];
    for (const [u, w2] of sk.pts) { const x = Math.round(u * F + size / 2), y = Math.round(w2 * F + size / 2); if (x >= 0 && y >= 0 && x < size && y < size && dt[y * size + x] > 0) v.push(dt[y * size + x]); }
    v.sort((a, b) => a - b); return (v.length ? v[Math.floor(v.length * 0.7)] : 0.03 * F) / F;
  });
  const idx = [], ks = [], sv = [], al = [], dr = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const A = src[(y * size + x) * 4 + 3]; if (!A) continue;
    const ex = (x + 0.5 - size / 2) / F, ey = (y + 0.5 - size / 2) / F;
    const res = sks.map(sk => project(sk, ex, ey));
    // 像素落在哪几笔的笔身里，就归给其中最先写的那一笔（交叉处由先落笔的一画盖住）；都不在就归最近的一笔
    let k = res.findIndex((r, i) => r[0] <= hw[i] * 1.12 + 1.2 / F);
    if (k < 0) { let m = 1e9; res.forEach((r, i) => { if (r[0] < m) { m = r[0]; k = i; } }); }
    idx.push(y * size + x); ks.push(k); sv.push(res[k][1]); al.push(A);
    // 飞白：笔画收尾处，沿笔势方向出现几道断续的露白。垂直偏移归一到笔宽 [-1, 1]，按"笔毛"分道取值噪声
    const amt = (dry[k] || 0) * dryScale;
    if (amt > 0) {
      const sk = sks[k], u = res[k][1] / sk.total, pv = res[k][2] * res[k][0] / Math.max(hw[k], 1e-3);
      const dr0 = amt * ss(seg(u, 0.5, 0.97)) * (0.65 + 0.35 * vnoise(res[k][1] * F / 26 + k * 3.1));
      const n = vnoise(pv * 4.6 + k * 7.3 + 11), thr = dr0 * 0.62;
      dr.push(Math.round(255 * ss(seg(n, thr - 0.07, thr + 0.07))));
    } else dr.push(255);
  }
  const n = sks.length, wts = sks.map(sk => sk.total + hold), sw = wts.reduce((a, b) => a + b, 0);
  const avail = (span[1] - span[0]) - gap * (n - 1);
  let tt = span[0];
  const timing = sks.map((sk, i) => { const d = avail * wts[i] / sw, r = { L: sk.total, t0: tt, t1: tt + d }; tt += d + gap; return r; });
  const out = document.createElement('canvas'); out.width = out.height = size;
  const octx = out.getContext('2d');
  return { size, idx: Int32Array.from(idx), k: Uint8Array.from(ks), s: Float32Array.from(sv), a: Uint8Array.from(al), dry: Uint8Array.from(dr), strokes: timing, out, octx, img: octx.createImageData(size, size) };
}

export function paintBrushGlyph(G, t, { edge = 0.035, rgb = [255, 252, 246] } = {}) {
  const d = G.img.data; d.fill(0);
  const front = G.strokes.map(st => t <= st.t0 ? -1 : t >= st.t1 ? st.L + 1 : st.L * ss((t - st.t0) / (st.t1 - st.t0)));
  let any = false;
  for (let j = 0; j < G.idx.length; j++) {
    const f = front[G.k[j]]; if (f < 0) continue;
    const v = clamp((f - G.s[j]) / edge + 0.5); if (v <= 0) continue;
    const o = G.idx[j] * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = G.a[j] * v * G.dry[j] / 255; any = true;
  }
  if (any) G.octx.putImageData(G.img, 0, 0);
  return any;
}
