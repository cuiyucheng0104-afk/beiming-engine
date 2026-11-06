// 北冥引擎 · 路径小语言：SVG 风格的路径字符串 → 命令数组，再做变换、转 Path2D、采样成折线。
// 命令数组：[['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y], ['Q', x1, y1, x, y], ['Z']]，只支持绝对坐标。
//   parsePath(str)               字符串 → 命令数组（M 之后省略命令字母的坐标按 L 读）
//   scalePath(cmds, cx, cy, k)   绕 (cx, cy) 整体缩放（设计时微调大小用）
//   mapPath(cmds, m, warp)       所有点（含控制点）先过可选形变 warp(x, y) → [x, y]，再乘仿射矩阵 m
//   toPath2D(cmds, p)            追加到 Path2D p（不给就新建）并返回它
//   samplePath(cmds, step = 3)   每个子路径采样成一条折线，点距约 step
//   polyPath(pts)                折线 → 闭合命令数组
//   smoothClosed(pts, p)         点列 → 平滑闭合 Path2D（相邻中点之间走二次贝塞尔）
//   fillPoly(ctx, pts)           直接填充一个多边形（少于 3 个点不画）

import { apply } from './affine.js';

export function parsePath(str) {
  const tk = str.match(/[MLCQZ]|-?\d*\.?\d+/gi); const out = []; let i = 0, c = 'M';
  while (i < tk.length) {
    const t = tk[i];
    if (/^[MLCQZ]$/i.test(t)) { c = t.toUpperCase(); i++; if (c === 'Z') { out.push(['Z']); continue; } }
    const n = c === 'C' ? 6 : c === 'Q' ? 4 : 2, v = [c];
    for (let k = 0; k < n; k++) v.push(+tk[i++]);
    out.push(v); if (c === 'M') c = 'L';
  }
  return out;
}

export const scalePath = (cmds, cx, cy, k) => cmds.map(c => c[0] === 'Z' ? c : [c[0], ...c.slice(1).map((v, i) => i % 2 ? cy + (v - cy) * k : cx + (v - cx) * k)]);

export function mapPath(cmds, m, warp) {
  return cmds.map(c => {
    if (c[0] === 'Z') return c;
    const o = [c[0]];
    for (let k = 1; k < c.length; k += 2) { const p = apply(m, warp ? warp(c[k], c[k + 1]) : [c[k], c[k + 1]]); o.push(p[0], p[1]); }
    return o;
  });
}

export function toPath2D(cmds, p = new Path2D()) {
  for (const c of cmds) {
    if (c[0] === 'M') p.moveTo(c[1], c[2]);
    else if (c[0] === 'L') p.lineTo(c[1], c[2]);
    else if (c[0] === 'C') p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'Q') p.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else p.closePath();
  }
  return p;
}

export function samplePath(cmds, step = 3) {
  const polys = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { cur = [[c[1], c[2]]]; polys.push(cur); x = sx = c[1]; y = sy = c[2]; continue; }
    if (!cur) { cur = [[x, y]]; polys.push(cur); }
    if (c[0] === 'L' || c[0] === 'Z') {
      const ex = c[0] === 'Z' ? sx : c[1], ey = c[0] === 'Z' ? sy : c[2];
      const n = Math.max(1, Math.ceil(Math.hypot(ex - x, ey - y) / step));
      for (let i = 1; i <= n; i++) cur.push([x + (ex - x) * i / n, y + (ey - y) * i / n]);
      x = ex; y = ey;
    } else if (c[0] === 'C') {
      const L = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4]);
      const n = Math.max(2, Math.ceil(L / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
        cur.push([a * x + b * c[1] + d * c[3] + e * c[5], a * y + b * c[2] + d * c[4] + e * c[6]]);
      }
      x = c[5]; y = c[6];
    } else if (c[0] === 'Q') {
      const L = Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]);
      const n = Math.max(2, Math.ceil(L / step));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; cur.push([u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]]); }
      x = c[3]; y = c[4];
    }
  }
  return polys;
}

export const polyPath = pts => [['M', pts[0][0], pts[0][1]], ...pts.slice(1).map(p => ['L', p[0], p[1]]), ['Z']];

export function smoothClosed(pts, p = new Path2D()) {
  const n = pts.length; if (n < 3) return p;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(pts[n - 1], pts[0]); p.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], m = mid(a, b); p.quadraticCurveTo(a[0], a[1], m[0], m[1]); }
  p.closePath(); return p;
}

export function fillPoly(ctx, pts) {
  if (pts.length < 3) return;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath(); ctx.fill();
}
