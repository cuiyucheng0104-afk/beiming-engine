// 北冥引擎 · 平滑曲线与弧长：稀疏折线 → Catmull-Rom 平滑曲线，并支持按弧长取点、求最近点。
// 曲线对象 sp = { pts: [[x, y], ...], L: 每点的累计弧长, total: 总长 }
//   catmullRom(P, steps)              P = [[x, y], ...]（至少 2 个点），每段细分 steps 份
//   pointAt(sp, d)                    弧长 d 处的点（两端夹住）
//   spanPoints(sp, d0, d1, step, f)   从弧长 d0 到 d1 每 step 取一点 [x, y, f(d)]，末点落在 d1（给 engine/core/stroke.js 当带笔压的中心线）
//   project(sp, x, y)                 → [到曲线的最近距离, 最近点的弧长, 在曲线哪一侧 ±1]

import { clamp, lerp } from '../core/math.js';

export function catmullRom(P, steps) {
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < steps; k++) {
      const u = k / steps, u2 = u * u, u3 = u2 * u;
      out.push([0, 1].map(d => 0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3)));
    }
  }
  out.push(P[P.length - 1]);
  const L = [0]; for (let i = 1; i < out.length; i++) L.push(L[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { pts: out, L, total: L[L.length - 1] };
}

export function pointAt(sp, d) {
  const { pts, L } = sp; if (d <= 0) return pts[0]; if (d >= sp.total) return pts[pts.length - 1];
  let i = 1; while (L[i] < d) i++;
  const u = (d - L[i - 1]) / (L[i] - L[i - 1] || 1);
  return [lerp(pts[i - 1][0], pts[i][0], u), lerp(pts[i - 1][1], pts[i][1], u)];
}

export function spanPoints(sp, d0, d1, step, f) {
  const pts = [];
  for (let d = d0; d < d1; d += step) { const q = pointAt(sp, d); pts.push([q[0], q[1], f(d)]); }
  const q1 = pointAt(sp, d1); pts.push([q1[0], q1[1], f(d1)]);
  return pts;
}

export function project(sp, x, y) {
  let best = 1e9, bs = 0, side = 1;
  const { pts, L } = sp;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    const u = clamp(((x - ax) * dx + (y - ay) * dy) / l2);
    const px = ax + u * dx - x, py = ay + u * dy - y, d = px * px + py * py;
    if (d < best) { best = d; bs = L[i] + u * (L[i + 1] - L[i]); side = dx * (y - ay) - dy * (x - ax) >= 0 ? 1 : -1; }
  }
  return [Math.sqrt(best), bs, side];
}
