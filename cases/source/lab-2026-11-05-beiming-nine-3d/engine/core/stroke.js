// 北冥引擎 · 手绘笔触：把一串带笔压的中心线点 [x, y, pressure] 变成一条有粗细起伏的墨线轮廓。
// 返回闭合多边形的顶点数组 [[x, y], ...]，交给 Canvas 2D 填充即可。
//
//   size       笔宽（直径，像素）
//   thinning   笔压对粗细的影响：0 = 等宽，1 = 笔压为 0 时线宽收到 0
//   streamline 中心线跟手的迟滞：0 = 紧贴输入点，越大越"稳"、越圆顺
//   start / end { taper: 像素 } 起笔、收笔的出锋长度；不给 taper 时两端是圆头

const EPS = 1e-6;

export function inkStroke(points, { size = 8, thinning = 0.5, streamline = 0.3, start = {}, end = {} } = {}) {
  if (!points.length) return [];
  // 1) 迟滞：每个点向上一个结果点只走一部分，抖动被吃掉
  const k = 0.15 + 0.85 * (1 - streamline);
  const P = [];
  let px = points[0][0], py = points[0][1];
  for (const q of points) {
    px += (q[0] - px) * k; py += (q[1] - py) * k;
    const last = P[P.length - 1];
    if (last && Math.hypot(px - last[0], py - last[1]) < 0.25) { last[2] = Math.max(last[2], q[2] ?? 0.5); continue; }
    P.push([px, py, q[2] ?? 0.5]);
  }
  const lastIn = points[points.length - 1];
  P.push([lastIn[0], lastIn[1], lastIn[2] ?? 0.5]);   // 收笔落在最后一个输入点上
  const n = P.length;
  if (n === 1) return circle(P[0][0], P[0][1], radius(size, thinning, P[0][2]));

  // 2) 弧长、笔压平滑（笔压不会瞬间跳变）
  const L = [0];
  for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = L[n - 1];
  let pr = P[0][2];
  const R = P.map((p, i) => {
    pr += (p[2] - pr) * (i ? 0.35 : 1);
    let r = radius(size, thinning, pr);
    const t0 = start.taper || 0, t1 = end.taper || 0;
    if (t0 > 0) { const u = Math.min(1, L[i] / t0); r *= u * (2 - u); }
    if (t1 > 0) { const u = Math.min(1, (total - L[i]) / t1); r *= 1 - Math.pow(1 - u, 3); }
    return Math.max(r, EPS);
  });

  // 3) 沿法线向两侧偏移
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    left.push([P[i][0] - ty * R[i], P[i][1] + tx * R[i]]);
    right.push([P[i][0] + ty * R[i], P[i][1] - tx * R[i]]);
  }

  // 4) 两端：有出锋就是尖头，否则补半圆
  const out = [...left];
  if (!(end.taper > 0)) out.push(...arc(P[n - 1], P[n - 2], R[n - 1]));
  out.push(...right.reverse());
  if (!(start.taper > 0)) out.push(...arc(P[0], P[1], R[0]));
  return out;
}

function radius(size, thinning, p) {
  return Math.max(size * (0.5 - thinning * (0.5 - p)), size * 0.01);
}

// 以 c 为圆心、从"左侧"转到"右侧"的半圆，方向背离邻点 o
function arc(c, o, r, steps = 10) {
  const dir = Math.atan2(c[1] - o[1], c[0] - o[0]);
  const pts = [];
  for (let s = 1; s < steps; s++) {
    const a = dir + Math.PI / 2 - (Math.PI * s) / steps;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

function circle(x, y, r, steps = 16) {
  return Array.from({ length: steps }, (_, s) => {
    const a = (Math.PI * 2 * s) / steps;
    return [x + Math.cos(a) * r, y + Math.sin(a) * r];
  });
}
