// SPDX-License-Identifier: MIT
// Portions Copyright (c) 2026 LemoLab — lemo-opuscar@bebbbe1 styles/scifi-toon/demo/toon.js（MIT），许可原文见本注释末尾
// 北冥引擎 · 曲线：平面折线（样条、圆旋涡、方旋涡）、路径 → THREE.Shape，以及沿空间曲线的变径管。
//   catmull(pts, per, closed)                 Catmull-Rom 样条把 [[x, y], ...] 加密成折线，每段 per 个点
//   spiral(cx, cy, r0, turns, dir, a0, pitch) 圆旋涡：从外半径 r0、角度 a0 起向内卷 turns 圈；dir = 1 逆时针；pitch 圈距（默认铺满）
//   withSpiral(pts, c, turns, pitch)          折线收尾卷进以 c 为心的旋涡，旋向按行进方向自动定（顺着走不打折）
//   squareSpiral(L, R, B, T, p)               方旋涡（回纹）：盒子 [L, R] × [B, T] 从左上角起往下、逐圈向内，圈距 p
//   pathShape(cmds, sx, sy)                   [['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y], ...] → THREE.Shape（x、y 分别缩放）
//   taperTube(curve, seg, radial, radiusAt)   沿曲线的管，半径 radiusAt(a)（a = 沿程 0..1）；返回 { g, along }，along 是每个顶点的 a
//
// 来源：catmull 改编自 cases/vendor/lemo-opuscar/styles/scifi-toon/demo/toon.js@bebbbe1 的 spline（结构与逐段求值相同；
//   同样的写法也见于该库的 rubber-hose、urban-sketch 示例）；其余函数是本仓库自己写的。
// @provenance lemo-opuscar@bebbbe1 styles/scifi-toon/demo/toon.js
// LemoLab 部分的许可（MIT 原文，按其要求随这些部分一起分发）：
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
import * as THREE from 'three';
import { clamp, TAU } from '../core/math.js';

export function catmull(pts, per = 8, closed = false) {
  const n = pts.length, out = [];
  const P = i => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}

export function spiral(cx, cy, r0, turns, dir = 1, a0 = 0, pitch = null) {
  const pr = pitch ?? r0 / (turns + 0.55), pts = [], Nn = Math.ceil(turns * 56);
  for (let i = 0; i <= Nn; i++) {
    const t = i / Nn * turns * TAU, r = r0 - pr * t / TAU;
    if (r < pr * 0.3) break;
    pts.push([cx + r * Math.cos(a0 + dir * t), cy + r * Math.sin(a0 + dir * t)]);
  }
  return pts;
}

export function withSpiral(pts, c, turns, pitch = null) {
  const e = pts[pts.length - 1], p = pts[pts.length - 2];
  const rx = e[0] - c[0], ry = e[1] - c[1], tx = e[0] - p[0], ty = e[1] - p[1];
  const dir = rx * ty - ry * tx > 0 ? 1 : -1;
  return pts.concat(spiral(c[0], c[1], Math.hypot(rx, ry), turns, dir, Math.atan2(ry, rx), pitch).slice(1));
}

export function squareSpiral(L, Rt, B, T, p) {
  const pts = [[L, T]];
  let l = L, r = Rt, b = B, t = T - p, x = L, y = T, dir = 0;
  for (let it = 0; it < 40; it++) {
    if (dir === 0) { y = b; l += p; } else if (dir === 1) { x = r; b += p; } else if (dir === 2) { y = t; r -= p; } else { x = l; t -= p; }
    pts.push([x, y]); dir = (dir + 1) % 4;
    if (r - l < p * 0.55 || t - b < p * 0.55) break;
  }
  return pts;
}

export function pathShape(cmds, sx = 1, sy = 1) {
  const sh = new THREE.Shape();
  for (const [op, ...a] of cmds) {
    const p = a.map((v, i) => v * (i % 2 ? sy : sx));
    if (op === 'M') sh.moveTo(p[0], p[1]); else if (op === 'L') sh.lineTo(p[0], p[1]); else if (op === 'C') sh.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
  }
  return sh;
}

// TubeGeometry 先按半径 1 生成，顶点按 (分段+1)×(径向+1) 排列：用段号算沿程，再沿法线推到 radiusAt(a)
export function taperTube(curve, seg, radial, radiusAt) {
  const g = new THREE.TubeGeometry(curve, seg, 1, radial, false);
  const p = g.attributes.position, nrm = g.attributes.normal, along = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const a = Math.floor(i / (radial + 1)) / seg, r = radiusAt(a) - 1; along[i] = a;
    p.setXYZ(i, p.getX(i) + nrm.getX(i) * r, p.getY(i) + nrm.getY(i) * r, p.getZ(i) + nrm.getZ(i) * r);
  }
  return { g, along };
}
