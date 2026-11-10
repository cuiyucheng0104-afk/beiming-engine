// 北冥引擎 · 路径小语言：SVG 风格的路径字符串 → 命令数组，再做变换、转 Path2D、采样成折线。
// 命令数组：[['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y], ['Q', x1, y1, x, y], ['Z']]，全部是绝对坐标。
//   parsePath(str)               字符串 → 命令数组。认 SVG 的 M L H V C S Q T Z（大写绝对、小写相对），H/V/S/T 和小写命令
//                                都展开成上面五种绝对命令；同一命令连写多组坐标就重复这条命令，M 之后省略命令字母的坐标按 L 读，
//                                开头省略 M 也按 M 读。数字支持正负号、省略整数部分（.5）和指数（1e-7）；逗号、空白都是分隔。
//                                A（弧线）、别的字母、认不出的字符、坐标个数不够都直接报错（不再静默画出错的形状）；空串返回 []。
//   scalePath(cmds, cx, cy, k)   绕 (cx, cy) 整体缩放（设计时微调大小用）
//   mapPath(cmds, m, warp)       所有点（含控制点）先过可选形变 warp(x, y) → [x, y]，再乘仿射矩阵 m
//   toPath2D(cmds, p)            追加到 Path2D p（不给就新建）并返回它
//   samplePath(cmds, step = 3)   每个子路径采样成一条折线，点距约 step
//   polyPath(pts)                折线 → 闭合命令数组
//   smoothClosed(pts, p)         点列 → 平滑闭合 Path2D（相邻中点之间走二次贝塞尔）
//   fillPoly(ctx, pts)           直接填充一个多边形（少于 3 个点不画）

import { apply } from './affine.js';

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
const LEX = /[\s,]+|([A-Za-z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;

export function parsePath(str) {
  if (str == null) throw new TypeError('parsePath：没有给路径字符串');
  const src = String(str), tk = [];
  for (let i = 0; i < src.length;) {
    LEX.lastIndex = i;
    const m = LEX.exec(src);
    if (!m) throw new SyntaxError(`parsePath：第 ${i + 1} 个字符“${src[i]}”认不出来：${src.slice(0, 80)}`);
    if (m[1]) tk.push(m[1]); else if (m[2] !== undefined) tk.push(Number(m[2]));
    i = LEX.lastIndex;
  }
  const out = [];
  let k = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, prev = null;   // prev = [上一段的类型 'C'/'Q', 控制点 x, y]（S/T 取它的反射）
  while (k < tk.length) {
    if (typeof tk[k] === 'string') {
      cmd = tk[k++];
      const U = cmd.toUpperCase();
      if (U === 'A') throw new SyntaxError(`parsePath：不支持 ${cmd}（弧线）命令，请先换成 C 贝塞尔：${src.slice(0, 80)}`);
      if (!(U in ARGS)) throw new SyntaxError(`parsePath：不认识的命令 ${cmd}（只认 M L H V C S Q T Z，大小写都可以）：${src.slice(0, 80)}`);
      if (U === 'Z') { out.push(['Z']); cx = sx; cy = sy; prev = null; continue; }
    } else if (cmd === null) cmd = 'M';
    else if (cmd === 'Z' || cmd === 'z') throw new SyntaxError(`parsePath：Z 后面的坐标缺少命令字母：${src.slice(0, 80)}`);
    const U = cmd.toUpperCase(), rel = cmd !== U, n = ARGS[U], a = [];
    for (let j = 0; j < n; j++, k++) {
      if (typeof tk[k] !== 'number') throw new SyntaxError(`parsePath：${cmd} 要 ${n} 个数，第 ${j + 1} 个缺了：${src.slice(0, 80)}`);
      a.push(tk[k]);
    }
    const X = v => (rel ? cx + v : v), Y = v => (rel ? cy + v : v);
    if (U === 'M') { cx = sx = X(a[0]); cy = sy = Y(a[1]); out.push(['M', cx, cy]); prev = null; cmd = rel ? 'l' : 'L'; }
    else if (U === 'L') { const x = X(a[0]), y = Y(a[1]); out.push(['L', x, y]); cx = x; cy = y; prev = null; }
    else if (U === 'H') { cx = X(a[0]); out.push(['L', cx, cy]); prev = null; }
    else if (U === 'V') { cy = Y(a[0]); out.push(['L', cx, cy]); prev = null; }
    else if (U === 'C' || U === 'S') {
      const c1 = U === 'C' ? [X(a[0]), Y(a[1])] : prev && prev[0] === 'C' ? [2 * cx - prev[1], 2 * cy - prev[2]] : [cx, cy];
      const r = U === 'C' ? 2 : 0, c2 = [X(a[r]), Y(a[r + 1])], e = [X(a[r + 2]), Y(a[r + 3])];
      out.push(['C', ...c1, ...c2, ...e]); prev = ['C', c2[0], c2[1]]; cx = e[0]; cy = e[1];
    } else {   // Q / T
      const c1 = U === 'Q' ? [X(a[0]), Y(a[1])] : prev && prev[0] === 'Q' ? [2 * cx - prev[1], 2 * cy - prev[2]] : [cx, cy];
      const r = U === 'Q' ? 2 : 0, e = [X(a[r]), Y(a[r + 1])];
      out.push(['Q', ...c1, ...e]); prev = ['Q', c1[0], c1[1]]; cx = e[0]; cy = e[1];
    }
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
