// 灯塔守夜 · 世界：海、天、雨、悬崖、灯塔、码头、船、人物
import * as WC from './engine/index.js';
import { clamp, lerp, mulberry, hash, seg, ss } from '/core/lib.js';
import { PW, PH } from './stage.js';

const PI = Math.PI;
export const HOR = 330;                 // 宽景地平线
export const LAMP = [300, 104];         // 宽景灯芯

// ------------------------------------------------------------------ 海：一行一行的浪，刀宽随浪峰（亮）变化
// 远处密而细、近处疏而粗；浪峰尖、浪谷平（刀在峰上最宽）
export function makeSea(o) {
  const r = mulberry(o.seed ?? 7), rows = [];
  for (let k = 0; k < o.nr; k++) {
    const v = k / (o.nr - 1), y0 = o.hor + (o.gap0 ?? 6) + (o.bot - o.hor) * Math.pow(v, o.pw ?? 1.7);
    const row = {
      k, v, y0, amp: lerp(o.a0, o.a1, Math.pow(v, 1.3)), lam: lerp(o.l0, o.l1, v) * (.82 + .36 * r()),
      ph: r() * 10, ph2: r() * 6.28, sp: (o.sp ?? .3) * (.75 + .5 * r()), wb: lerp(o.w0, o.w1, Math.pow(v, 1.15)),
      seed: (o.seed ?? 7) * 1000 + k * 37, brk: [],
    };
    let x = -80 - r() * 80;
    while (x < (o.xw ?? PW) + 80) { const L = lerp(o.s0 ?? 46, o.s1 ?? 170, r()) * (.6 + .9 * v); const gp = 2 + r() * (3 + 7 * v); row.brk.push([x, x + L]); x += L + gp; }
    rows.push(row);
  }
  return rows;
}
export function crestOf(row, x, t) { const u = x / row.lam + row.ph - t * row.sp; return 1 - Math.pow(Math.abs(Math.sin(PI * u)), .7); }
export function surf(row, x, t, A = 1) {
  const cr = crestOf(row, x, t);
  return row.y0 - row.amp * A * (cr - .45) + .35 * row.amp * A * Math.sin(x * 2 * PI / (row.lam * 2.3) + row.ph2 + t * .6);
}
// 一行浪 → 刀痕。o: {t, A, lit(x,y)→倍数, x0, x1, desc (从右往左排点，S1 镜像里刀从左往右走), wk}
export function rowStrokes(row, o = {}) {
  const t = o.t ?? 0, A = o.A ?? 1, x0 = o.x0 ?? -60, x1 = o.x1 ?? PW + 60, wk = o.wk ?? 1, step = o.step ?? 5;
  const out = [], wmin = o.wmin ?? .9;
  row.brk.forEach(([a, b], bi) => {
    const lo = Math.max(a, x0), hi = Math.min(b, x1); if (hi - lo < 8) return;
    let pts = [], ws = [], sub = 0;
    const flush = () => {
      if (pts.length >= 3) {
        if (o.desc) { pts.reverse(); ws.reverse(); }
        out.push(WC.mkStroke(pts, ws, { kind: row.wb * wk > 6 ? 'u' : 'v', seed: row.seed + bi * 13 + sub * 5, chip: .15 }));
      }
      pts = []; ws = []; sub++;
    };
    for (let x = lo; x <= hi; x += step) {
      const y = surf(row, x, t, A), cr = crestOf(row, x, t);
      let w = row.wb * wk * (.3 + .7 * Math.pow(cr, 1.3));
      if (o.lit) w *= o.lit(x, y);
      w = Math.min(w, row.wb * 3.2 + 6);
      if (w < wmin) { flush(); continue; }
      pts.push([x, y]); ws.push(w);
    }
    flush();
  });
  return out;
}
// 近处浪峰上的浪花（刺刀白点）
export function foam(rows, t, o = {}) {
  const pts = [], vmin = o.vmin ?? .55, A = o.A ?? 1;
  for (const row of rows) {
    if (row.v < vmin) continue;
    const n0 = Math.floor((-80) / row.lam + row.ph - t * row.sp) - 1, n1 = Math.ceil(((o.xw ?? PW) + 80) / row.lam + row.ph - t * row.sp) + 1;
    for (let n = n0; n <= n1; n++) {
      const xc = (n - row.ph + t * row.sp) * row.lam, yc = surf(row, xc, t, A);
      const r = mulberry(row.seed + n * 101 + 7), cnt = Math.floor((2 + r() * 6) * (o.k ?? 1) * row.v);
      for (let i = 0; i < cnt; i++) pts.push([xc + (r() - .5) * row.lam * .22, yc - (3 + r() * 26) * row.v * A * (o.up ?? 1), (1.6 + r() * 3.4) * row.v * (o.rk ?? 1)]);
    }
  }
  return WC.flecks(pts, { seed: 3, angle: -.3 });
}

// ------------------------------------------------------------------ 天：U 刀扫出的风暴云带
export function makeSky(o) {
  const r = mulberry(o.seed ?? 21), bands = [];
  for (let b = 0; b < o.n; b++) {
    const y = lerp(o.y0, o.y1, (b + .5) / o.n) + (r() - .5) * 18;
    bands.push({ y, a1: 10 + r() * 22, a2: 4 + r() * 10, f1: .0025 + r() * .003, f2: .009 + r() * .006, p1: r() * 6.28, p2: r() * 6.28, p3: r() * 6.28, wb: lerp(o.w0, o.w1, r()), seed: 500 + b * 17 });
  }
  return bands;
}
export function skyStrokes(bands, o = {}) {
  const out = [], dx = o.dx ?? 0, k = o.wk ?? 1, x0 = o.x0 ?? -60, x1 = o.x1 ?? PW + 60;
  for (const B of bands) {
    const pts = [];
    for (let x = x0; x <= x1; x += 6) pts.push([x, B.y + B.a1 * Math.sin((x + dx) * B.f1 + B.p1) + B.a2 * Math.sin((x + dx) * B.f2 + B.p2)]);
    if (o.desc) pts.reverse();
    const s = WC.cutAlong(pts, { w: (u, p) => B.wb * k * Math.max(0, Math.pow(.5 + .5 * Math.sin((p[0] + dx) * .0045 + B.p3), 2.2) - .08) + .6, kind: 'u', seg: [90, 320], gap: [6, 30], seed: B.seed });
    out.push(...s);
  }
  return out;
}
// 雨：斜向的短 V 刀，按二拍（12 fps）重刻
export function rain(t, o) {
  const r = mulberry(o.seed ?? 9), out = [], tq = Math.floor(t * 12) / 12, a = o.angle ?? 1.95, ca = Math.cos(a), sa = Math.sin(a);
  const [bx0, by0, bx1, by1] = o.box;
  for (let i = 0; i < o.n; i++) {
    const x = bx0 + r() * (bx1 - bx0), y = by0 + r() * (by1 - by0), v = o.v * (.7 + .6 * r()), L = o.len * (.6 + .8 * r());
    const d = (tq * v + r() * 1000) % ((by1 - by0) / Math.max(.2, sa));
    let px = x + ca * d, py = by0 + ((y - by0 + sa * d) % (by1 - by0));
    px = bx0 + (((px - bx0) % (bx1 - bx0)) + (bx1 - bx0)) % (bx1 - bx0);
    if (o.keep && !o.keep(px, py)) continue;
    out.push(WC.mkStroke([[px, py], [px + ca * L * .5, py + sa * L * .5], [px + ca * L, py + sa * L]], (o.w ?? 2.4) * (.7 + .6 * r()), { kind: 'v', seed: 77 + i, chip: .1 }));
  }
  return out;
}
// 静态刺刀点（S1 的雨、S6 的星）
export function stabField(n, box, o = {}) {
  const r = mulberry(o.seed ?? 31), pts = [];
  for (let i = 0; i < n; i++) { const x = box[0] + r() * (box[2] - box[0]), y = box[1] + Math.pow(r(), o.pow ?? 1) * (box[3] - box[1]); if (o.keep && !o.keep(x, y)) continue; pts.push([x, y, (o.r0 ?? 2) + r() * (o.r1 ?? 3)]); }
  return WC.flecks(pts, { seed: (o.seed ?? 31) + 1, angle: o.angle ?? 1.2 });
}

// ------------------------------------------------------------------ 光束：从灯芯放射的一束 U 刀
export function beam(cx, cy, th, o = {}) {
  const r = mulberry(o.seed ?? 41), n = o.n ?? 15, half = o.half ?? .075, out = [];
  for (let i = 0; i < n; i++) {
    const u = (i + .5) / n * 2 - 1, a = th + u * half + (r() - .5) * half * .25;
    const r0 = (o.r0 ?? 26) * (.8 + .4 * r()), r1 = (o.len ?? 1900) * (.75 + .35 * r()) * (1 - .25 * Math.abs(u));
    const pts = [], N = Math.ceil((r1 - r0) / 10), wv = (o.w ?? 13) * (1 - .55 * Math.abs(u)) * (.75 + .5 * r());
    for (let k = 0; k <= N; k++) { const rr = r0 + (r1 - r0) * k / N; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
    const ws = pts.map((_, k) => wv * (1 - .6 * k / N) + .8);
    const s = WC.mkStroke(pts, ws, { kind: 'u', seed: (o.seed ?? 41) * 10 + i, chip: .2 });
    if (o.t0 !== undefined) { s.t0 = o.t0 + r() * .05; s.dur = (o.dur ?? .25) * (.7 + .3 * r()); }
    out.push(s);
  }
  return out;
}
export function inBeam(cx, cy, th, half) {
  return (x, y) => {
    const a = Math.atan2(y - cy, x - cx); let d = Math.abs(((a - th + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI);
    const k = clamp(1 - d / (half * 1.6)); return k * k * (3 - 2 * k);
  };
}

// ------------------------------------------------------------------ 人物：黑剪影 + 白刀晕 + 受光边几刀；皮肤刻白、五官留黑
// parts: [{a:[x,y], b:[x,y], r0, r1}] 胶囊；画在局部坐标（随肢体动，不沸腾）
export function capsule(a, b, r0, r1 = r0, n = 10) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, ang = Math.atan2(uy, ux), P = [];
  for (let i = 0; i <= n; i++) { const q = ang + PI / 2 + PI * i / n; P.push([b[0] + Math.cos(q) * r1 * -1 * -1, b[1] + Math.sin(q) * r1]); }
  const P2 = [];
  for (let i = 0; i <= n; i++) { const q = ang - PI / 2 + PI * i / n; P2.push([a[0] + Math.cos(q + PI) * r0 * -1 * -1, a[1] + Math.sin(q + PI) * r0]); }
  // b 端半圆（朝外）+ a 端半圆（朝外）
  const out = [];
  for (let i = 0; i <= n; i++) { const q = ang - PI / 2 + PI * i / n; out.push([b[0] + Math.cos(q) * r1, b[1] + Math.sin(q) * r1]); }
  for (let i = 0; i <= n; i++) { const q = ang + PI / 2 + PI * i / n; out.push([a[0] + Math.cos(q) * r0, a[1] + Math.sin(q) * r0]); }
  return out;
}
const pathPoly = (g, P) => { g.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) g.lineTo(P[i][0], P[i][1]); g.closePath(); };
function inPoly(P, x, y) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
// 外法线 (ty,-tx)*sg：用最长边中点往里/往外试一下
function outSign(P) { let bi = 0, bl = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > bl) { bl = l; bi = i; } } const a = P[bi], b = P[(bi + 1) % P.length], tx = (b[0] - a[0]) / bl, ty = (b[1] - a[1]) / bl, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; return inPoly(P, mx + ty * 1.5, my - tx * 1.5) ? -1 : 1; }
// 画一个剪影人物：polys = 黑块，halo 宽，lit = 受光方向 [lx,ly]（屏幕局部），cuts 每块几刀
export function figure(g, polys, o = {}) {
  const halo = o.halo ?? 6;
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = '#fff'; g.lineWidth = halo * 2; g.beginPath(); for (const P of polys) pathPoly(g, P); g.stroke();
  g.fillStyle = '#000'; g.beginPath(); for (const P of polys) pathPoly(g, P); g.fill('nonzero');
  g.restore();
  // 受光边：沿多边形边、法线朝光的那段，往里偏移刻 2–3 刀
  if (o.lit) {
    const [lx, ly] = o.lit, list = [];
    polys.forEach((P, pi) => {
      if (P.noCut) return;
      for (let k = 1; k <= (o.cuts ?? 2); k++) {
        const d = (o.inset ?? 4) + (k - 1) * (o.sp ?? 5), run = [];
        const sg = outSign(P);
        const push = () => { if (run.length > 3) list.push(WC.mkStroke(run.map(p => p.p), run.map(p => p.w), { kind: 'v', seed: pi * 31 + k * 7 + list.length, chip: .12 })); run.length = 0; };
        for (let i = 0; i < P.length; i++) {
          const a = P[(i - 1 + P.length) % P.length], b = P[(i + 1) % P.length];
          let tx = b[0] - a[0], ty = b[1] - a[1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
          const nx = ty * sg, ny = -tx * sg;           // 外法线
          const dt = nx * lx + ny * ly;
          if (dt > (o.th ?? .35)) run.push({ p: [P[i][0] - nx * d, P[i][1] - ny * d], w: (o.cw ?? 2.6) * (dt - .2) * (1 - (k - 1) * .3) + .6 });
          else push();
        }
        push();
      }
    });
    WC.drawStrokes(g, list, { color: '#fff' });
  }
}
// 两段 IK：肩 s → 手 h，上臂 l1、前臂 l2，bend = ±1 选肘的朝向
export function ik(s, h, l1, l2, bend = 1) {
  let dx = h[0] - s[0], dy = h[1] - s[1], d = Math.hypot(dx, dy); const dd = clamp(d, Math.abs(l1 - l2) + 1, l1 + l2 - .5);
  const a = Math.atan2(dy, dx), c = clamp((l1 * l1 + dd * dd - l2 * l2) / (2 * l1 * dd), -1, 1), e = a - bend * Math.acos(c);
  const el = [s[0] + Math.cos(e) * l1, s[1] + Math.sin(e) * l1];
  const hx = s[0] + dx / d * dd, hy = s[1] + dy / d * dd;
  return [el, [hx, hy]];
}
// 白脸（刻白）+ 黑色保留线 + 黑五官。侧脸朝 dir（+1 右 / -1 左），look = 抬头角
export function face(g, cx, cy, R, dir = 1, look = 0, o = {}) {
  g.save(); g.translate(cx, cy); g.rotate(-look * dir); g.scale(dir, 1);
  // 头的白面（侧脸：一个略长的椭圆 + 鼻子）
  g.fillStyle = '#fff'; g.beginPath();
  g.moveTo(-R * .2, -R * 1.0); g.bezierCurveTo(R * .7, -R * 1.05, R * .95, -R * .5, R * .92, -R * .12);
  g.lineTo(R * 1.18, R * .1); g.lineTo(R * .9, R * .25);                    // 鼻
  g.bezierCurveTo(R * .95, R * .6, R * .7, R * 1.0, R * .1, R * 1.05);
  g.bezierCurveTo(-R * .5, R * 1.0, -R * .7, R * .3, -R * .55, -R * .3); g.closePath(); g.fill();
  // 五官：黑
  g.fillStyle = '#000';
  g.beginPath(); g.ellipse(R * .5, -R * .18, R * .12, R * .09, 0, 0, PI * 2); g.fill();      // 眼
  g.beginPath(); g.moveTo(R * .28, -R * .44); g.lineTo(R * .78, -R * (.38 + (o.brow ?? 0))); g.lineTo(R * .76, -R * .3); g.lineTo(R * .3, -R * .36); g.closePath(); g.fill();   // 眉
  g.beginPath(); g.moveTo(R * .55, R * .55); g.lineTo(R * .85, R * .52); g.lineTo(R * .8, R * .6); g.closePath(); g.fill();   // 嘴
  if (o.beard) {   // 胡子：白脸上的黑块，下缘刻几刀
    g.beginPath(); g.moveTo(R * .95, R * .4); g.bezierCurveTo(R * 1.0, R * 1.0, R * .5, R * 1.35, -R * .1, R * 1.15); g.lineTo(-R * .2, R * .55); g.bezierCurveTo(R * .2, R * .7, R * .5, R * .65, R * .95, R * .4); g.fill();
    g.fillStyle = '#fff'; for (let i = 0; i < 4; i++) { const x = R * (.0 + i * .22); g.fillRect(x, R * (.75 + i * .05), R * .06, R * .3); }
    g.fillStyle = '#000';
  }
  g.restore();
}

// ------------------------------------------------------------------ 船（局部坐标：甲板 y=0，船宽约 560）
export function boatPolys(s = 1) {
  const S = P => P.map(([x, y]) => [x * s, y * s]);
  const hull = S([[-300, -46], [-250, -20], [-120, -6], [60, -4], [210, -14], [262, -30], [250, 6], [200, 52], [60, 78], [-120, 76], [-230, 46]]);
  const cabin = S([[110, -6], [110, -64], [200, -64], [214, -10]]);
  return { hull, cabin };
}
export function buildBoat(s = 1, o = {}) {
  const { hull, cabin } = boatPolys(s);
  const L = o.light || WC.light(-.55, -.7, .4);
  const hullS = WC.shape([hull], { light: L, sp: o.sp ?? 7 * s + 2, halo: Math.max(2.5, 7 * s), R: 40 * s + 6, dir: 0.05, lo: o.lo ?? .22, hi: .95, seed: 61, seg: [30 * s + 10, 120 * s + 20] });
  const cabS = WC.shape([cabin], { light: L, sp: o.sp ?? 7 * s + 2, halo: Math.max(2, 5 * s), R: 20 * s + 4, dir: PI / 2, lo: .3, seed: 62 });
  // 船板：几道沿船身的长刀
  const planks = [];
  for (let i = 0; i < 3; i++) planks.push(...WC.cutAlong([[-240 * s, (8 + i * 20) * s], [-100 * s, (18 + i * 20) * s], [80 * s, (20 + i * 20) * s], [210 * s, (10 + i * 18) * s]], { w: Math.max(1.2, 3.2 * s), kind: 'v', seg: [60 * s + 20, 200 * s + 20], gap: [3, 10], seed: 70 + i }));
  return { hullS, cabS, planks, s };
}
// 破帆：跟桅杆一起，帆面每二拍抖一次
export function sailPoly(s, t, A = 1) {
  const tq = Math.floor(t * 12) / 12, f = k => Math.sin(tq * 9 + k * 1.7) * 14 * A * s;
  return [[-34 * s, -300 * s], [-34 * s + f(1) * .3, -60 * s], [-150 * s + f(2), -80 * s], [-210 * s + f(3), -170 * s], [-160 * s + f(4), -230 * s], [-120 * s + f(5) * .6, -270 * s]];
}
export function drawBoat(g, B, t, o = {}) {
  const s = B.s;
  B.hullS.draw(g); WC.drawStrokes(g, B.planks, { color: '#fff' }); B.cabS.draw(g);
  // 桅杆 + 帆 + 一根后支索（渔人抓着它）
  const mast = [[-44 * s, 0], [-30 * s, 0], [-30 * s, -320 * s], [-44 * s, -320 * s]];
  const sail = sailPoly(s, t, o.flap ?? 1);
  const stay = [[-34 * s, -316 * s], [-34 * s, -308 * s], [246 * s, -12 * s], [238 * s, -12 * s]];
  figure(g, [stay], { halo: Math.max(1.5, 3 * s) });
  figure(g, [mast, sail], { halo: Math.max(2, 5 * s), lit: [-.7, -.7], cuts: s > .8 ? 5 : 2, inset: 3 * s + 1, sp: 5 * s + 1, cw: 2.6 * s + .6, th: .2 });
  // 帆面：掠射光下的 V 刀排线，顺着帆的鼓起方向（从桅杆往帆脚），只在受光的上半
  const folds = [];
  const P0 = [-38 * s, 0], tipX = sail[3][0], tipY = sail[3][1];
  for (let i = 0; i < (s > .8 ? 6 : 3); i++) {
    const u = (i + .5) / (s > .8 ? 6 : 3), y0 = lerp(-292, -110, u) * s;
    const ex = lerp(sail[5][0], sail[2][0], u) * .92, ey = lerp(sail[5][1], sail[2][1], u) + 6 * s;
    const mx = (P0[0] + ex) / 2 + (tipX - ex) * .18, my = (y0 + ey) / 2 - 16 * s;
    folds.push(...WC.cutAlong([[-40 * s, y0], [mx, my], [ex, ey]], { w: (uu) => (2.6 * s + .5) * (1.1 - .7 * u) * (1 - .6 * uu), kind: 'v', seg: [70 * s + 10, 160 * s + 10], gap: [3, 9], seed: 80 + i }));
  }
  WC.drawStrokes(g, folds, { color: '#fff' });
  if (s > .8) {
    // 船身受光边（船舷上沿）3–5 道顺船形的 V 刀
    const rim = []; for (let k = 0; k < 4; k++) { const d = 6 + k * 7; rim.push(...WC.cutAlong([[-292 * s, (-40 + d) * s], [-240 * s, (-14 + d * .9) * s], [-120 * s, (-1 + d * .8) * s], [60 * s, (1 + d * .8) * s], [200 * s, (-8 + d * .85) * s], [250 * s, (-22 + d) * s]], { w: (uu) => (3.2 - k * .6) * s * (0.5 + .5 * Math.sin(PI * uu)) + .5, kind: 'v', seg: [80 * s, 200 * s], gap: [4, 14], seed: 120 + k })); }
    WC.drawStrokes(g, rim, { color: '#fff' });
  }
  if (o.fisher !== false) drawFisher(g, s, t, o);
}
// 船上的渔人（站在船尾，双手抓后支索）。look 0 → 抬头 1
export function drawFisher(g, s, t, o = {}) {
  const look = o.look ?? 0, sway = o.sway ?? 0;
  const sh = [118 * s + sway * 8 * s, -150 * s], head = [124 * s + sway * 10 * s, -190 * s];
  const coat = [[84 * s, -6 * s], [88 * s, -60 * s], [92 * s, -110 * s], [98 * s, -160 * s], [142 * s, -164 * s], [154 * s, -120 * s], [158 * s, -60 * s], [166 * s, -6 * s]];
  const stayY = x => -316 * s + (x + 34 * s) / (280 * s) * 304 * s;   // 支索上 x 处的 y
  const hx1 = 42 * s + sway * 4 * s, hx2 = 80 * s + sway * 3 * s;
  const sh2 = [134 * s + sway * 8 * s, -146 * s];
  const [el1, hd1] = ik(sh, [hx1, stayY(hx1) + 4 * s], 60 * s, 56 * s, 1);
  const [el2, hd2] = ik(sh2, [hx2, stayY(hx2) + 4 * s], 60 * s, 56 * s, 1);
  const arms = [capsule(sh, el1, 14 * s, 11 * s), capsule(el1, hd1, 11 * s, 9 * s), capsule(hd1, hd1, 10 * s),
                capsule(sh2, el2, 14 * s, 11 * s), capsule(el2, hd2, 11 * s, 9 * s), capsule(hd2, hd2, 10 * s)];
  // 油布雨衣：下摆两道褶
  figure(g, [coat], { halo: Math.max(2, 5 * s), lit: [-.75, -.65], cuts: s > .8 ? 4 : 2, inset: 4 * s + 1, sp: 4.5 * s + 1, cw: 2.6 * s + .6, th: .25 });
  figure(g, arms, { halo: Math.max(2, 4 * s), lit: [-.75, -.65], cuts: 1, inset: 3 * s + 1, cw: 2.2 * s + .5, th: .4 });
  if (s > .8) WC.drawStrokes(g, [WC.mkStroke([[100 * s, -100 * s], [104 * s, -50 * s], [102 * s, -12 * s]], 2.4 * s, { kind: 'v', seed: 141 }), WC.mkStroke([[118 * s, -120 * s], [122 * s, -60 * s], [124 * s, -14 * s]], 1.8 * s, { kind: 'v', seed: 142 })], { color: '#fff' });
  // 头（刻白的脸）+ 黑色保留线
  g.fillStyle = '#000'; g.beginPath(); g.arc(head[0], head[1], 30 * s, 0, PI * 2); g.fill();
  face(g, head[0], head[1] + 2 * s, 23 * s, -1, look * .55, { beard: true, brow: look * .12 });
  // 西南风帽：圆顶，前檐短而上翘，后檐长长垂到后颈（他朝左看，后檐在右）
  const [cx, cy] = head, a = -look * .3, R = 30 * s;
  const hp = (x, y) => [cx + (x * Math.cos(a) - y * Math.sin(a)) * R, cy + (x * Math.sin(a) + y * Math.cos(a)) * R];
  const hat = [[-1.55, -.42], [-1.0, -.55], [-.85, -1.1], [-.4, -1.45], [.3, -1.45], [.85, -1.05], [1.0, -.5], [1.22, -.18], [1.45, .4], [1.42, 1.18], [1.12, 1.02], [.98, .25], [.7, -.35], [-.9, -.38]].map(([x, y]) => hp(x, y));
  figure(g, [hat], { halo: Math.max(1.5, 4 * s), lit: [-.75, -.65], cuts: s > .8 ? 2 : 0, inset: 3 * s, sp: 4 * s, cw: 2 * s + .5, th: .3 });
  if (s > .8) WC.drawStrokes(g, [WC.mkStroke([hp(-.8, -.6), hp(-.2, -.7), hp(.6, -.55)], 2 * s, { kind: 'k', seed: 151 })], { color: '#fff' });
}

// ------------------------------------------------------------------ 宽景：悬崖、灯塔、码头（世界 = 版面 1848×912）
let WIDE = null;
export function cliffPoly() {
  return [[-20, 300], [80, 318], [180, 340], [236, 372], [262, 386], [338, 386], [372, 404], [410, 440], [430, 480], [444, 520], [470, 560], [520, 610], [560, 700], [640, 800], [700, 940], [-20, 940]];
}
export function buildWide() {
  if (WIDE) return WIDE;
  const Lc = WC.light(.65, -.55, .3);
  const cliff = WC.shape([cliffPoly()], { light: Lc, sp: 8, halo: 6, R: 70, dir: 'contour', a0: .9, lo: .38, hi: .95, seed: 91, seg: [30, 110], gap: [3, 10] });
  // 塔身：微收分；两道白带
  const tw = y => lerp(36, 26, (386 - y) / (386 - 150));
  const tower = [[300 - tw(386), 386], [300 - tw(150), 150], [300 + tw(150), 150], [300 + tw(386), 386]];
  const towerS = WC.shape([tower], { light: WC.light(.7, -.4, .25), sp: 5, halo: 5, R: 16, dir: PI / 2, lo: .35, seed: 92, seg: [16, 60] });
  const bands = [[318, 344], [232, 256]].map(([a, b]) => [[300 - tw(b), b], [300 - tw(a), a], [300 + tw(a), a], [300 + tw(b), b]]);
  const bandLines = []; bands.forEach(([p0, p1, p2, p3], i) => { for (let k = 0; k < 3; k++) { const y = lerp(p0[1], p1[1], (k + .5) / 3); bandLines.push(WC.mkStroke([[300 - tw(y) - 2, y], [300 + tw(y) + 2, y]], 1.6, { kind: 'k', seed: 300 + i * 3 + k })); } });
  const gallery = [[258, 150], [258, 140], [342, 140], [342, 150]];
  const rail = [[262, 140], [262, 128], [338, 128], [338, 140], [334, 140], [334, 132], [266, 132], [266, 140]];
  const room = [[274, 128], [274, 82], [326, 82], [326, 128]];
  const cap = [[268, 84], [300, 58], [332, 84]];
  const spire = [[298, 60], [300, 40], [302, 60]];
  // 码头：从崖脚伸出去的木栈桥
  const deck = [[430, 520], [880, 530], [880, 540], [430, 532]];
  const posts = []; for (let x = 450; x <= 880; x += 54) posts.push([[x - 4, 532], [x + 4, 532], [x + 4, 590], [x - 4, 590]]);
  WIDE = { cliff, towerS, bands, bandLines, gallery, rail, room, cap, spire, deck, posts, tw };
  return WIDE;
}
// 画宽景的陆地部分。o: {lit(灯亮 0/1), keeper(小人), plateLamp}
export function drawLand(g, c, o = {}) {
  const Wd = buildWide();
  Wd.cliff.draw(g);
  Wd.towerS.draw(g);
  g.fillStyle = '#fff'; g.beginPath(); for (const P of Wd.bands) { g.moveTo(...P[0]); for (const p of P.slice(1)) g.lineTo(...p); g.closePath(); } g.fill();
  WC.drawStrokes(g, Wd.bandLines, { color: '#000' });
  figure(g, [Wd.gallery, Wd.rail, Wd.cap, Wd.spire], { halo: 3 });
  // 灯室：未亮 = 黑玻璃；亮 = 刻白，套红
  g.fillStyle = '#000'; g.beginPath(); pathPoly(g, Wd.room); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); pathPoly(g, Wd.room); g.stroke();
  if (o.lit) {
    g.fillStyle = '#fff'; g.fillRect(278, 86, 44, 38);
    g.fillStyle = '#000'; for (const x of [289, 300, 311]) g.fillRect(x - 1.2, 86, 2.4, 38); g.fillRect(278, 104, 44, 2.4);
    if (c) { const gr = c.createRadialGradient(300, 104, 2, 300, 104, 30); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,.85)'); c.fillStyle = gr; c.fillRect(276, 84, 48, 42); }
  } else {
    WC.drawStrokes(g, [WC.mkStroke([[280, 120], [292, 92]], 2, { kind: 'v', seed: 401 }), WC.mkStroke([[304, 122], [318, 90]], 2, { kind: 'v', seed: 402 })]);
  }
  // 小守夜人（站在回廊上）
  if (o.keeper) { const k = o.keeper; figure(g, [[[k - 4, 140], [k - 4, 118], [k + 4, 118], [k + 4, 140]], capsule([k, 113], [k, 113], 5)], { halo: 2.5 }); }
  // 码头
  figure(g, [Wd.deck, ...Wd.posts], { halo: 3.5, lit: [.3, -.95], cuts: 1, inset: 2, cw: 2.2 });
}

// ------------------------------------------------------------------ S3 近景塔身（世界 1848 × 2600）
export const TW = { x0: 714, x1: 1134, gal: 700, ladA: 640, ladB: 684, rung: 54, base: 2600 };
let TOWER = null;
export function buildTower() {
  if (TOWER) return TOWER;
  const body = [[TW.x0, TW.gal + 14], [TW.x1, TW.gal + 14], [TW.x1 + 70, TW.base], [TW.x0 - 70, TW.base]];
  const bodyS = WC.shape([body], { light: WC.light(-.8, -.35, .22), sp: 9, halo: 8, R: 260, dir: PI / 2, lo: .34, hi: .95, seed: 501, seg: [40, 150], gap: [3, 12] });
  const courses = []; for (let y = TW.gal + 80; y < TW.base; y += 66) courses.push(...WC.cutAlong([[TW.x0 - (y - TW.gal) * .04 + 30, y], [TW.x1 + (y - TW.gal) * .04 - 10, y + 4]], { w: 1.6, kind: 'k', seg: [50, 160], gap: [6, 30], seed: 600 + y }));
  const gallery = [[600, TW.gal + 22], [600, TW.gal - 2], [1250, TW.gal - 2], [1250, TW.gal + 22]];
  const railPosts = []; for (let x = 610; x <= 1240; x += 70) railPosts.push([[x - 4, TW.gal - 2], [x - 4, TW.gal - 96], [x + 4, TW.gal - 96], [x + 4, TW.gal - 2]]);
  const railTop = [[600, TW.gal - 92], [600, TW.gal - 104], [1250, TW.gal - 104], [1250, TW.gal - 92]];
  const room = [[760, TW.gal - 2], [760, 380], [1088, 380], [1088, TW.gal - 2]];
  const roof = [[730, 392]]; for (let i = 1; i < 24; i++) { const a = PI * i / 24; roof.push([924 - Math.cos(a) * 194, 392 - Math.sin(a) * 120]); } roof.push([1118, 392]);
  const vent = WC.ellipse(924, 262, 26, 24, 24); vent.push(...[]);
  const spike = [[918, 242], [924, 180], [930, 242]];
  const rungs = []; for (let y = TW.gal + 40; y < TW.base; y += TW.rung) rungs.push([[TW.ladA - 2, y - 4], [TW.ladB + 2, y - 4], [TW.ladB + 2, y + 4], [TW.ladA - 2, y + 4]]);
  const rails = [[[TW.ladA - 9, TW.gal - 60], [TW.ladA - 1, TW.gal - 60], [TW.ladA - 1, TW.base], [TW.ladA - 9, TW.base]], [[TW.ladB + 1, TW.gal - 60], [TW.ladB + 9, TW.gal - 60], [TW.ladB + 9, TW.base], [TW.ladB + 1, TW.base]]];
  const brackets = []; for (let y = TW.gal + 150; y < TW.base; y += 320) brackets.push([[TW.ladB, y - 5], [TW.x0 + 6, y - 5], [TW.x0 + 6, y + 5], [TW.ladB, y + 5]]);
  TOWER = { bodyS, courses, gallery, railPosts, railTop, room, roof, vent, spike, rungs, rails, brackets };
  return TOWER;
}
export const LAMP3 = [924, 545];
export function drawTower(g, c, o = {}) {
  const T = buildTower();
  T.bodyS.draw(g); WC.drawStrokes(g, T.courses, { color: '#fff' });
  // 灯室（框中框）：玻璃 + 窗棂
  g.fillStyle = '#000'; g.beginPath(); pathPoly(g, T.room); g.fill();
  const panes = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) panes.push([778 + i * 80, 398 + j * 146, 66, 132]);
  if (o.lit > 0) {
    g.fillStyle = '#fff'; for (const [x, y, w, h] of panes) g.fillRect(x, y, w, h);
    // 透镜：同心横棱（黑线压在白上）
    g.fillStyle = '#000';
    for (let k = 0; k < 9; k++) { const y = LAMP3[1] - 100 + k * 25, hw = 70 * Math.sqrt(Math.max(0, 1 - ((y - LAMP3[1]) / 118) ** 2)); g.fillRect(LAMP3[0] - hw, y - 2, hw * 2, 4); }
    g.fillRect(LAMP3[0] - 3, LAMP3[1] - 110, 6, 220);
    if (c) { const R = 60 + 50 * (o.glow ?? 0); const gr = c.createRadialGradient(LAMP3[0], LAMP3[1], 4, LAMP3[0], LAMP3[1], R * 1.9); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(.5, 'rgba(0,0,0,.92)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.fillRect(LAMP3[0] - R * 2, LAMP3[1] - R * 2, R * 4, R * 4); }
  } else {
    // 黑玻璃上的反光：几道斜 V 刀
    const refl = []; panes.forEach(([x, y, w, h], i) => { refl.push(WC.mkStroke([[x + 10, y + h - 20], [x + w * .55, y + 18]], 3, { kind: 'v', seed: 700 + i })); refl.push(WC.mkStroke([[x + w * .5, y + h - 12], [x + w - 8, y + h * .45]], 1.8, { kind: 'v', seed: 720 + i })); });
    WC.drawStrokes(g, refl, { color: '#fff' });
    g.strokeStyle = '#fff'; g.lineWidth = 3; for (const [x, y, w, h] of panes) g.strokeRect(x + 2, y + 2, w - 4, h - 4);
    // 透镜轮廓（暗）
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.ellipse(LAMP3[0], LAMP3[1], 70, 118, 0, 0, PI * 2); g.stroke();
  }
  g.fillStyle = '#000'; for (let i = 0; i <= 4; i++) g.fillRect(770 + i * 80, 380, 8, TW.gal - 382); g.fillRect(760, 532, 328, 10);
  figure(g, [T.roof, T.vent, T.spike], { halo: 6, lit: [-.7, -.7], cuts: 3, inset: 6, sp: 9, cw: 4 });
  g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); pathPoly(g, T.room); g.stroke();
  figure(g, [...T.rails, ...T.rungs, ...T.brackets], { halo: 3.5 });
  figure(g, [T.gallery, T.railTop, ...T.railPosts], { halo: 4.5, lit: [-.3, -.95], cuts: 1, inset: 3, cw: 2.6 });
}
