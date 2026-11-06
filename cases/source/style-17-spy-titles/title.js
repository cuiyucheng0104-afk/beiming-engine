// 片名「零点密码」：自制几何剪纸字（直切条 + 圆弧，笔画粗细不匀、基线错落），不用任何现成字体
// 每个字 100×100 单位，原点左上；每一笔是一块独立纸片（重叠处留剪缝）
import { g, C, piece, roughC, arcP } from './paper.js';
import { hash } from '/core/lib.js';

const D = Math.PI / 180;
// 直条：两端斜切（cut = 斜切量，单位同坐标）
function bar(x1, y1, x2, y2, w, cut = 0) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, nx = -dy / L * w / 2, ny = dx / L * w / 2;
  const ux = dx / L * cut, uy = dy / L * cut;
  return [[x1 + nx, y1 + ny], [x2 + nx + ux, y2 + ny + uy], [x2 - nx, y2 - ny], [x1 - nx - ux, y1 - ny - uy]];
}
// 圆弧带
function arcBand(cx, cy, r, w, a0, a1, n = 18) {
  return arcP(cx, cy, r + w / 2, a0 * D, a1 * D, n).concat(arcP(cx, cy, r - w / 2, a1 * D, a0 * D, n));
}
// 楔形点（剪刀两刀剪出的三角/梯形）
function wedge(x, y, len, w, ang) {
  const c = Math.cos(ang * D), s = Math.sin(ang * D);
  const P = [[0, -w * .2], [len, -w * .5], [len * .9, w * .5], [0, w * .35]];
  return P.map(([a, b]) => [x + a * c - b * s, y + a * s + b * c]);
}
function ringP(cx, cy, r, w) { return [arcP(cx, cy, r + w / 2, 0, Math.PI * 2, 36).slice(0, -1), arcP(cx, cy, r - w / 2, 0, Math.PI * 2, 30).slice(0, -1).reverse()]; }

// 每笔 {p: 多边形 或 [外轮廓, 挖洞]，ring: 标记为〇（换色）}
export const TG = {
  '零': [
    { p: bar(8, 4, 92, 3, 9, 3) },                 // 雨：首横
    { p: bar(16, 14, 86, 14, 7) },                 // 宀式横
    { p: bar(16, 13, 13, 40, 8) }, { p: bar(86, 13, 88, 40, 8) },
    { p: bar(50, 6, 50, 43, 9) },
    { p: wedge(25, 21, 16, 7, 28) }, { p: wedge(25, 32, 16, 7, 28) },
    { p: wedge(60, 21, 16, 7, 28) }, { p: wedge(60, 32, 16, 7, 28) },
    { p: bar(50, 46, 6, 74, 12, 4) }, { p: bar(50, 46, 94, 74, 10, 4) },   // 令：人字顶
    { p: bar(40, 66, 62, 66, 6) },
    { p: bar(24, 79, 78, 78, 9) }, { p: bar(77, 77, 76, 92, 8) },
    { p: bar(46, 80, 48, 100, 11, 3) },
  ],
  '点': [
    { p: bar(44, 0, 44, 34, 10, 2) }, { p: bar(44, 16, 76, 16, 8, 3) },
    { p: ringP(48, 52, 18, 9), ring: true },          // 口 → 〇（全片的圆，第四次出现）
    { p: wedge(8, 82, 16, 9, 62) }, { p: wedge(32, 82, 16, 9, 70) }, { p: wedge(56, 82, 16, 9, 70) }, { p: wedge(80, 80, 18, 9, 58) },
  ],
  '密': [
    { p: bar(50, 0, 52, 11, 9) },
    { p: bar(8, 15, 92, 15, 8, 2) }, { p: bar(9, 14, 7, 28, 8) }, { p: bar(91, 14, 88, 28, 8) },
    { p: wedge(16, 34, 13, 7, 70) },
    { p: arcBand(50, 36, 19, 8, 175, 15, 16) },        // 心：底弧
    { p: bar(66, 27, 36, 59, 8, 2) },                  // 必：斜撇
    { p: wedge(70, 32, 12, 7, 40) }, { p: wedge(80, 40, 12, 7, 55) },
    { p: bar(20, 66, 20, 98, 9) }, { p: bar(50, 60, 50, 98, 11, 2) }, { p: bar(80, 66, 80, 98, 9) }, { p: bar(16, 96, 84, 96, 9) },
  ],
  '码': [
    { p: bar(2, 13, 42, 13, 9, 2) }, { p: bar(25, 15, 5, 54, 9, 3) },
    { p: [[[13, 50], [42, 50], [42, 90], [13, 90]], [[21, 58], [34, 58], [34, 82], [21, 82]]] },
    { p: bar(53, 10, 90, 10, 8, 2) }, { p: bar(89, 9, 85, 42, 8) },
    { p: bar(61, 22, 60, 54, 9) }, { p: bar(58, 53, 97, 52, 9) }, { p: bar(96, 51, 93, 92, 9, 2) }, { p: bar(94, 90, 80, 84, 8) },
    { p: bar(51, 73, 86, 74, 8, 2) },
  ],
};

// 片名排版：返回每个字 {ch, x, y, h, rot}（像素，原点 = 片名框左上）
export function titleLayout(H = 280) {
  const chars = ['零', '点', '密', '码'], out = [];
  const dys = [-.06, .08, -.03, .1], rots = [-2.2, 1.4, -1, 2.4], gaps = [.16, .2, .14];
  let x = 0;
  chars.forEach((ch, i) => { const h = H * (i === 1 ? 1.06 : 1); out.push({ ch, x, y: dys[i] * H, h, rot: rots[i] * D, seed: 700 + i * 11, i }); x += h + (gaps[i] ?? 0) * H; });
  return { L: out, w: x - 0, h: H * 1.2 };
}

// 画一个字。fly(stroke, k) → {dx, dy, rot, hide}；col 主色，ringCol 〇 的颜色；backing = 黑墨衬底宽度（像素）
export function drawTitleChar(l, opt = {}) {
  const k = l.h / 100, strokes = TG[l.ch];
  g.save(); g.translate(l.x + l.h / 2, l.y + l.h / 2); g.rotate(l.rot); g.translate(-l.h / 2, -l.h / 2);
  strokes.forEach((st, j) => {
    const f = opt.fly ? opt.fly(l, j, strokes.length) : null; if (f?.hide) return;
    const polys = (Array.isArray(st.p[0][0]) ? st.p : [st.p]).map((p, m) => roughC('tt' + l.ch + j + m + l.h.toFixed(0), () => p.map(([x, y]) => [x * k, y * k]), l.seed * 3 + j * 7 + m, 1.1 + l.h * .004, 8));
    g.save();
    if (f) { const c = polys[0].reduce((a, q) => [a[0] + q[0] / polys[0].length, a[1] + q[1] / polys[0].length], [0, 0]); g.translate(c[0] + (f.dx || 0), c[1] + (f.dy || 0)); g.rotate(f.rot || 0); g.translate(-c[0], -c[1]); }
    const col = st.ring ? (opt.ringCol || C.paper) : (opt.col || C.mus);
    if (opt.backing) {   // 黑墨衬底：先描一圈墨，再贴纸片
      g.beginPath(); for (const p of polys) { p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); }
      g.lineJoin = 'round'; g.lineWidth = opt.backing * 2; g.strokeStyle = C.ink; g.stroke();
    }
    piece(polys, col, { gap: opt.gap ?? 2.4, shA: .38 });
    g.restore();
  });
  g.restore();
}
export function drawTitle(x, y, H, opt = {}) {
  const T = titleLayout(H);
  for (const l of T.L) drawTitleChar({ ...l, x: x + l.x, y: y + l.y }, opt);
  return T;
}
export const strokeSeed = (l, j) => hash(l.seed * 13 + j * 3.7);
