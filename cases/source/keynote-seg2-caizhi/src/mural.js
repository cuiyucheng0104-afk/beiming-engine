// 壁画边饰：卷草纹（S 形主茎 + 交替卷须 + 半叶）与如意云纹，沿画框中线从右边中点向上下两路"逐笔生长"，
// 生长到哪里画到哪里；半拍后按石青、石绿、朱砂点染。纹样全部程序化，镜像对称（上下两路）。
import { cv } from './assets.js';
import { clamp, mulberry } from '/core/lib.js';

export const PIG = { sq: [58, 118, 172], sl: [78, 156, 128], zs: [184, 88, 48], bai: [238, 228, 204] };   // 石青 石绿 朱砂（风化） 白粉
export const GROUND = { vine: 'rgb(44,98,84)', cloud: 'rgb(40,78,120)' };   // 地色：深石绿 / 深石青
const WHITE = 'rgba(240,230,206,.95)';
const LINE = 'rgba(56,34,20,.92)';

// 画框中线（局部坐标，外框 W×H，带宽 b）：上路从右边中点 → 右上角 → 上边 → 左上角 → 左边中点
function makePath(W, H, b) {
  const x0 = b / 2, x1 = W - b / 2, y0 = b / 2, ym = H / 2;
  const segs = [[x1, ym, x1, y0], [x1, y0, x0, y0], [x0, y0, x0, ym]];
  const lens = segs.map(s => Math.hypot(s[2] - s[0], s[3] - s[1])), L = lens.reduce((a, c) => a + c, 0);
  const at = s => {
    s = clamp(s, 0, L);
    for (let i = 0; i < 3; i++) {
      if (s <= lens[i] || i === 2) {
        const [ax, ay, bx, by] = segs[i], u = clamp(s / lens[i]), tx = (bx - ax) / lens[i], ty = (by - ay) / lens[i];
        return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, tx, ty, nx: -ty, ny: tx };   // n 指向框内侧（上路）
      }
      s -= lens[i];
    }
  };
  return { L, at, segs };
}

function spiral(cx, cy, r0, turns, a0, dir, n = 40) {
  const P = [];
  for (let i = 0; i <= n; i++) { const u = i / n, a = a0 + dir * u * turns * Math.PI * 2, r = r0 * (1 - .82 * u); P.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return P;
}

// 构建一条边饰：type 'vine' | 'cloud'
export function buildBorder(W, H, b, type, seed = 1) {
  const path = makePath(W, H, b), R = mulberry(seed);
  const els = [];
  const cols = ['sq', 'sl', 'zs'];
  if (type === 'vine') {
    const lam = 124, A = b * .19;
    const stem = [];
    for (let s = 0; s <= path.L; s += 2) { const p = path.at(s), off = A * Math.sin(2 * Math.PI * s / lam); stem.push([p.x + p.nx * off, p.y + p.ny * off, s]); }
    let k = 0;
    for (let s = lam * .25; s < path.L - 10; s += lam / 2, k++) {
      const p = path.at(s), side = (k % 2 ? -1 : 1), off = A * side;
      const sx = p.x + p.nx * off, sy = p.y + p.ny * off;
      // 卷须：从波峰向外侧卷起
      const cx = sx + p.nx * side * b * .17 + p.tx * b * .06, cy = sy + p.ny * side * b * .17 + p.ty * b * .06;
      const a0 = Math.atan2(sy - cy, sx - cx);
      els.push({ s, kind: 'curl', pts: spiral(cx, cy, b * .2, 1.3, a0, side, 40), col: ['zs', 'sq', 'bai'][k % 3], c: [cx, cy], r: b * .1 });
      // 半叶：在另一侧，沿切向张开
      const lx = sx - p.nx * side * b * .04, ly = sy - p.ny * side * b * .04;
      const tipx = lx - p.nx * side * b * .3 + p.tx * b * .22, tipy = ly - p.ny * side * b * .3 + p.ty * b * .22;
      els.push({ s: s + 6, kind: 'leaf', p0: [lx, ly], p1: [tipx, tipy], w: b * .19, side, col: ['sq', 'zs', 'bai'][(k + 1) % 3], tx: p.tx, ty: p.ty });
    }
    return { W, H, b, type, path, stem, els };
  }
  // 云纹：每 ~96px 一个如意云头，朝外（-n 方向）
  const step = 96, stem = [];
  for (let s = 0; s <= path.L; s += 2) { const p = path.at(s), off = b * .22 * Math.sin(2 * Math.PI * s / step); stem.push([p.x + p.nx * (b * .18 + off * .3), p.y + p.ny * (b * .18 + off * .3), s]); }
  let k = 0;
  for (let s = step * .5; s < path.L - 20; s += step, k++) {
    const p = path.at(s);
    els.push({ s, kind: 'ruyi', x: p.x + p.nx * b * .12, y: p.y + p.ny * b * .12, ux: -p.nx, uy: -p.ny, tx: p.tx, ty: p.ty, r: b * .3, col: ['sl', 'bai'][k % 2], dot: 'zs' });
  }
  return { W, H, b, type, path, stem, els };
}

function ruyiPath(g, e, k) {
  const r = e.r * k, ux = e.ux, uy = e.uy, tx = e.tx, ty = e.ty;
  const P = (a, c) => [e.x + tx * a * r + ux * c * r, e.y + ty * a * r + uy * c * r];
  g.beginPath();
  const pts = [P(0, -.55), P(-1.05, .05), P(-.85, .8), P(-.3, .75), P(0, 1.25), P(.3, .75), P(.85, .8), P(1.05, .05)];
  g.moveTo(...pts[0]);
  g.quadraticCurveTo(...P(-.9, -.45), ...pts[1]);
  g.quadraticCurveTo(...P(-1.25, .7), ...pts[2]);
  g.quadraticCurveTo(...P(-.5, 1.05), ...pts[3]);
  g.quadraticCurveTo(...P(-.35, 1.35), ...pts[4]);
  g.quadraticCurveTo(...P(.35, 1.35), ...pts[5]);
  g.quadraticCurveTo(...P(.5, 1.05), ...pts[6]);
  g.quadraticCurveTo(...P(1.25, .7), ...pts[7]);
  g.quadraticCurveTo(...P(.9, -.45), ...pts[0]);
  g.closePath();
  return P;
}

// 绘制：front = 每路生长到的弧长；colorAt(el) → 0..1 上色程度
export function drawBorder(g, B, front, colorAt, speck) {
  const { W, H, b } = B;
  const mirror = fn => { fn(false); g.save(); g.translate(0, H); g.scale(1, -1); fn(true); g.restore(); };
  g.lineCap = 'round'; g.lineJoin = 'round';
  const fr = Math.min(front, B.path.L);
  // 地色带（随笔生长）+ 双边线
  mirror(() => {
    if (fr <= 0) return;
    const inner = [], outer = [];
    for (let s = 0; s <= fr; s += 4) { const p = B.path.at(s); inner.push([p.x + p.nx * (b / 2 - 5), p.y + p.ny * (b / 2 - 5)]); outer.push([p.x - p.nx * (b / 2 - 5), p.y - p.ny * (b / 2 - 5)]); }
    const pe = B.path.at(fr); inner.push([pe.x + pe.nx * (b / 2 - 5), pe.y + pe.ny * (b / 2 - 5)]); outer.push([pe.x - pe.nx * (b / 2 - 5), pe.y - pe.ny * (b / 2 - 5)]);
    g.beginPath(); inner.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); for (let i = outer.length - 1; i >= 0; i--) g.lineTo(outer[i][0], outer[i][1]); g.closePath();
    g.fillStyle = GROUND[B.type]; g.fill();
    for (const L of [inner, outer]) { g.beginPath(); L.forEach((q, i) => i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.strokeStyle = LINE; g.lineWidth = 3; g.stroke(); }
  });
  // 主茎（白粉线，暗边）
  mirror(() => {
    g.beginPath(); let n = 0;
    for (const [x, y, s] of B.stem) { if (s > front) break; n++ ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = 'rgba(30,20,12,.5)'; g.lineWidth = B.type === 'vine' ? 6.5 : 4.2; g.stroke();
    g.strokeStyle = WHITE; g.lineWidth = B.type === 'vine' ? 4 : 2.4; g.stroke();
  });
  // 填色
  mirror(() => {
    for (const e of B.els) {
      const grow = clamp((front - e.s) / 40); if (grow <= 0) continue;
      const ck = colorAt(e); if (ck <= 0) continue;
      const c = PIG[e.col];
      g.fillStyle = `rgba(${c.join(',')},${.95 * ck})`;
      if (e.kind === 'leaf') { leafPath(g, e, grow * (.75 + .25 * ck)); g.fill(); }
      else if (e.kind === 'curl') { g.beginPath(); g.arc(e.c[0], e.c[1], e.r * grow * (.7 + .3 * ck), 0, 7); g.fill(); }
      else if (e.kind === 'ruyi') { ruyiPath(g, e, grow * (.85 + .15 * ck)); g.fill(); const z = PIG[e.dot]; g.fillStyle = `rgba(${z.join(',')},${.95 * ck})`; g.beginPath(); g.arc(e.x + e.ux * e.r * .45, e.y + e.uy * e.r * .45, e.r * .22 * ck, 0, 7); g.fill(); }
    }
  });
  // 勾线（白粉）
  mirror(() => {
    g.strokeStyle = WHITE;
    for (const e of B.els) {
      const grow = clamp((front - e.s) / 40); if (grow <= 0) continue;
      if (e.kind === 'curl') {
        const n = Math.max(2, Math.floor(e.pts.length * grow));
        g.beginPath(); e.pts.slice(0, n).forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.lineWidth = 3.4; g.stroke();
      } else if (e.kind === 'leaf') { leafPath(g, e, grow); g.lineWidth = 2.4; g.stroke(); }
      else if (e.kind === 'ruyi') {
        const P = ruyiPath(g, e, grow); g.lineWidth = 2.6; g.stroke();
        if (grow > .5) for (const sd of [-1, 1]) {
          const c = P(sd * .62, .55), sp = spiral(c[0], c[1], e.r * .32 * grow, 1.1, Math.atan2(e.uy, e.ux) + sd * 1.2, sd, 26);
          g.beginPath(); sp.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.lineWidth = 2; g.stroke();
        }
      }
    }
  });
  // 剥落的颜料颗粒
  if (speck) { g.save(); g.globalCompositeOperation = 'destination-out'; g.globalAlpha = .4; g.drawImage(speck, 0, 0, W, H); g.restore(); }
}
function leafPath(g, e, k) {
  const [x0, y0] = e.p0, x1 = x0 + (e.p1[0] - x0) * k, y1 = y0 + (e.p1[1] - y0) * k;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, w = e.w * k;
  g.beginPath(); g.moveTo(x0, y0);
  g.quadraticCurveTo(mx + nx * w, my + ny * w, x1, y1);
  g.quadraticCurveTo(mx - nx * w * .35, my - ny * w * .35, x0, y0); g.closePath();
}

// 颜料剥落斑点（局部 alpha）
export function speckles(W, H, seed = 3) {
  const c = cv(W, H), g = c.getContext('2d'), R = mulberry(seed);
  g.fillStyle = '#000';
  for (let i = 0; i < W * H / 900; i++) { const x = R() * W, y = R() * H, r = .6 + 2.2 * R() * R(); g.globalAlpha = .3 + .7 * R(); g.beginPath(); g.ellipse(x, y, r * (1 + R()), r, R() * 3, 0, 7); g.fill(); }
  return c;
}
