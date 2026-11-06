// 锚式擒纵机构：几何、运动学与绘制。坐标 = 图纸单位（y 向下，角度顺时针为正）。
import { TAU, g, f, cam, S, LW, lw, line, knock, knockMulti, clipMulti, hatch, circ, rect, rot, gearPts, fxShadow, fxUnshadow, pathScreen, trunc, NIBS } from './engine.js';
import { B, Bs, SPB } from './timeline.js';
const D = Math.PI / 180;
export const E = [1250, 900], R = 150, RR = 128, NT = 30, PITCH = TAU / NT;
export const P = [1250, 900 - R * Math.SQRT2];          // 叉轴：距轮心 R√2，叉臂与轮相切
export const LP = 760, BOBR = 72, A0 = 6 * D;           // 摆长（图上）、摆锤半径、摆幅 ±6°
export const ALPHA = 155 * D;                            // 三轮方向
export const PIN = { T: 8, m: 6 }, W3 = { T: 40, m: 6 };
export const W3C = [E[0] + Math.cos(ALPHA) * 144, E[1] + Math.sin(ALPHA) * 144];
export const W_STATIC = -1.8 * D;                        // 静止时左叉瓦落在齿隙里
const H3 = TAU / W3.T;
export const T15 = B(15);
const eo = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
// —— 运动学 ——（擒纵每拍放过半齿：轮在拍点起步，3 帧缓出）
export function kin(t) {
  let th = 0, w = W_STATIC, steps = 0;
  if (t >= T15) {
    const x = (t - T15) / SPB;
    const A = A0 * (1 - .28 * Math.exp(-x / .9));
    th = A * Math.sin(Math.PI * x);
    const k = Math.floor(x + 1e-9);                       // 已过的拍
    const e = eo(((t - (T15 + k * SPB)) * 24 + 1) / 3);   // 拍点那一帧轮已落下大半（落齿 = 滴答）
    steps = k + e;
    w = W_STATIC + 6 * D * steps;
  }
  const dw = w - W_STATIC;
  return { th, w, rp: ALPHA + dw, r3: ALPHA + Math.PI - .5 * H3 - dw * PIN.T / W3.T, steps };
}
export const bobAt = th => [P[0] - Math.sin(th) * LP, P[1] + Math.cos(th) * LP];
// —— 几何 ——
export function wheelOuter(w) {
  const p = [];
  for (let i = 0; i < NT; i++) {
    const a = w + i * PITCH;
    for (const [r, fa] of [[RR, 0], [R, .58], [R, .64], [RR + 1, .72], [RR, .86]]) p.push([E[0] + Math.cos(a + fa * PITCH) * r, E[1] + Math.sin(a + fa * PITCH) * r]);
  }
  return p;
}
function windows(c, ri, rh, n, a0, half) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = a0 + k * TAU / n, e = a0 + (k + 1) * TAU / n, w = [];
    const dO = Math.asin(half / ri), dI = Math.asin(half / rh);
    for (let i = 0; i <= 14; i++) { const a = s + dO + (e - s - 2 * dO) * i / 14; w.push([c[0] + Math.cos(a) * ri, c[1] + Math.sin(a) * ri]); }
    for (let i = 0; i <= 6; i++) { const a = e - dI - (e - s - 2 * dI) * i / 6; w.push([c[0] + Math.cos(a) * rh, c[1] + Math.sin(a) * rh]); }
    out.push(w);
  }
  return out;
}
export const wheelWin = w => windows(E, 104, 36, 4, w + 20 * D, 8);
export const w3Outer = r3 => gearPts(W3C[0], W3C[1], W3.T, W3.m, r3);
export const w3Win = r3 => windows(W3C, 96, 28, 5, r3, 7);
export const pinion = rp => gearPts(E[0], E[1], PIN.T, PIN.m, rp);
// 擒纵叉（未旋转，绝对坐标），绕 P 旋转 th
const nR = [Math.SQRT1_2, -Math.SQRT1_2], tR = [Math.SQRT1_2, Math.SQRT1_2];
const at = (n, t, rn, rt) => [E[0] + n[0] * rn + t[0] * rt, E[1] + n[1] * rn + t[1] * rt];
const mx = p => [2 * E[0] - p[0], p[1]];
const ANCH0 = (() => {
  const hubR = 30, p = [];
  for (let i = 0; i <= 10; i++) { const a = (170 + 200 * i / 10) * D; p.push([P[0] + Math.cos(a) * hubR, P[1] + Math.sin(a) * hubR]); }
  const BRo = at(nR, tR, R + 36, 10), TRo = at(nR, tR, R - 9, 6), TRi = at(nR, tR, R - 1, -6), BRi = at(nR, tR, R + 34, -9);
  p.push(BRo, TRo, TRi, BRi);
  const inner = [[E[0] + 96, P[1] + 56], [E[0] + 48, P[1] + 44], [E[0], P[1] + 41]];
  p.push(...inner, ...inner.slice(0, 2).reverse().map(mx));
  p.push(mx(BRi), mx(TRi), mx(TRo), mx(BRo));
  return p;
})();
export const anchor = th => rot(ANCH0, P[0], P[1], th);
export const rodPts = th => rot(rect(P[0] - 6, P[1] + 20, P[0] + 6, P[1] + LP - BOBR + 4), P[0], P[1], th);
export const bobPts = th => { const b = bobAt(th); return circ(b[0], b[1], BOBR, 72); };
export const bracket = () => [[P[0] - 40, P[1] - 64], [P[0] + 40, P[1] - 64], [P[0] + 40, P[1] - 44], [P[0] + 12, P[1] - 44], [P[0] + 12, P[1] - 18], [P[0] - 12, P[1] - 18], [P[0] - 12, P[1] - 44], [P[0] - 40, P[1] - 44]];
// 摆角弧（之后变真的那个符号）
export const ARC_R = 860;
export const arcPts = (a0 = -A0, a1 = A0) => { const p = []; for (let i = 0; i <= 40; i++) { const a = Math.PI / 2 + a0 + (a1 - a0) * i / 40; p.push([P[0] + Math.cos(a) * ARC_R, P[1] + Math.sin(a) * ARC_R]); } return p; };

// —— 绘制工具 ——
const sectorKnock = (c, pts, u) => { if (u <= 0) return; const [tp] = trunc([...pts, pts[0]], Math.min(1, u)); knock([c, ...tp]); };
function drawPart(outer, wins, c, u, uw = 1, o = {}) {
  if (u <= 0) return;
  if (u < 1) sectorKnock(c, outer, u); else knockMulti(uw >= 1 && wins ? [outer, ...wins] : [outer]);
  line(outer, { w: o.w ?? LW.out, closed: true, u });
  if (wins && u >= 1) wins.forEach((p, i) => line(p, { w: LW.det, closed: true, u: Math.max(0, Math.min(1, uw * wins.length - i)) }));
}
// 真实化：一层渐变 + 微光 + 落在纸上的影子
function realFill(paths, lift, bb) {
  knockMulti(paths);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); clipMulti(g, paths);
  const [ax, ay] = S(bb[0], bb[1]), [bx, by] = S(bb[2], bb[3]);
  const gr = g.createLinearGradient(ax, ay, bx, by);
  const k = lift;
  gr.addColorStop(0, `rgb(${96 * k | 0},${96 * k | 0},${96 * k | 0})`); gr.addColorStop(.55, `rgb(${40 * k | 0},${40 * k | 0},${40 * k | 0})`); gr.addColorStop(1, `rgb(${14 * k | 0},${14 * k | 0},${14 * k | 0})`);
  g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080); g.restore();
  for (const p of paths) line(p, { w: LW.out, closed: true });
  g.save(); g.globalCompositeOperation = 'lighter'; g.filter = `blur(${6 * Math.pow(cam.z, .65)}px)`; g.globalAlpha = .38 * k;
  for (const p of paths) line(p, { w: LW.out * 1.6, closed: true });
  g.restore(); g.filter = 'none'; g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
}
const bbOf = (c, r) => [c[0] - r, c[1] - r, c[0] + r, c[1] + r];

// 图 1（正视，拆去夹板）。pr = 各描线层进度；real = 变真程度（0..1）；t 供运动学
export function fig1(t, pr, real) {
  const K = kin(t), live = real > 0;
  const th = live ? K.th : 0, w = live ? K.w : W_STATIC;
  const rp = live ? K.rp : ALPHA, r3 = live ? K.r3 : ALPHA + Math.PI - .5 * H3;
  // 影子（只有真实化之后）
  if (live) {
    const sh = [rodPts(th), bobPts(th), anchor(th), wheelOuter(w), w3Outer(r3), pinion(rp)];
    fxShadow(sh, .5 * real, 9, 16 * real, 28 * real);
    f.globalCompositeOperation = 'lighter';
    fxUnshadow([rodPts(th)]); fxUnshadow([bobPts(th)]); fxUnshadow([anchor(th)]); fxUnshadow([wheelOuter(w)]); fxUnshadow([w3Outer(r3)]);
    // 淡印：摆杆与摆锤原本画的位置
    imprint([rodPts(0), bobPts(0)]);
  }
  // —— 由后到前 ——
  // 悬挂支架
  if (pr.bracket > 0) { if (pr.bracket >= 1) knock(bracket()); line(bracket(), { w: LW.det, closed: true, u: pr.bracket }); }
  // 摆杆 + 摆锤（最后面）
  if (live) {
    realFill([rodPts(th)], real, [P[0] - 30, P[1], P[0] + 30, P[1] + LP]);
    const b = bobAt(th); realFill([bobPts(th)], real, bbOf(b, BOBR));
    bobSpec(b, real);
  } else {
    if (pr.rod > 0) { const rp0 = rodPts(0); if (pr.rod >= 1) knock(rp0); line([rp0[0], rp0[3]], { w: LW.out, u: pr.rod }); line([rp0[1], rp0[2]], { w: LW.out, u: pr.rod }); }
    if (pr.bob > 0) { if (pr.bob >= 1) knock(bobPts(0)); line(bobPts(0), { w: LW.out, closed: true, u: pr.bob }); }
    if (pr.bobHatch > 0) hatch(bobPts(0), { u: pr.bobHatch, sp: 11, w: LW.hair });
  }
  // 擒纵轮
  if (live) realFill([wheelOuter(w), ...wheelWin(w)], real, bbOf(E, R));
  else drawPart(wheelOuter(w), wheelWin(w), E, pr.wheel, pr.wheelWin);
  // 擒纵叉
  if (live) realFill([anchor(th)], real, [P[0] - 160, P[1] - 40, P[0] + 160, P[1] + 140]);
  else if (pr.anchor > 0) { if (pr.anchor >= 1) knock(anchor(0)); line(anchor(0), { w: LW.out, closed: true, u: pr.anchor }); }
  // 三轮（在擒纵轮前面一层）+ 擒纵小齿轮
  if (live) { realFill([w3Outer(r3), ...w3Win(r3)], real, bbOf(W3C, 126)); realFill([pinion(rp)], real, bbOf(E, 30)); }
  else { drawPart(w3Outer(r3), w3Win(r3), W3C, pr.w3, pr.w3Win); drawPart(pinion(rp), null, E, pr.pinion, 1, { w: LW.det }); }
  // 轴端
  if (pr.arbors > 0) for (const [c, r] of [[E, 9], [P, 10], [W3C, 9]]) { knock(circ(c[0], c[1], r, 24)); line(circ(c[0], c[1], r, 24), { w: LW.det, closed: true, u: pr.arbors }); }
  if (!live && pr.hubHatch > 0) { hatch(circ(P[0], P[1], 30, 36), { u: pr.hubHatch, sp: 9, ang: -Math.PI / 4 }); }
}
function bobSpec(b, k) {
  const [sx, sy] = S(b[0] - 26, b[1] - 28), R0 = 40 * cam.z;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter';
  const gr = g.createRadialGradient(sx, sy, 0, sx, sy, R0); gr.addColorStop(0, `rgba(255,255,255,${.55 * k})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(sx - R0, sy - R0, 2 * R0, 2 * R0); g.restore();
}
export function imprint(paths, a = 1) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter';
  g.fillStyle = `rgba(13,13,13,${a})`; g.beginPath(); for (const p of paths) pathScreen(g, p, true, false); g.fill('nonzero');
  g.globalCompositeOperation = 'source-over';
  for (const p of paths) line(p, { w: LW.det, closed: true, v: .26 * a });
}

// —— 投影翻转：零件的三维描述（正视轮廓 + 深度区间 z0..z1，z 指向观者）——
export function model() {
  const w = W_STATIC, rp = ALPHA, r3 = ALPHA + Math.PI - .5 * H3;
  return [
    { id: 'rod', pts: rodPts(0), z0: -124, z1: -118, cut: false },
    { id: 'bob', pts: bobPts(0), z0: -141, z1: -101, cut: true },
    { id: 'arbA', pts: circ(P[0], P[1], 7, 20), z0: -132, z1: 95, cut: false },
    { id: 'arbE', pts: circ(E[0], E[1], 6, 20), z0: -103, z1: 95, cut: false },
    { id: 'arb3', pts: circ(W3C[0], W3C[1], 6, 20), z0: -103, z1: 95, cut: false },
    { id: 'wheel', pts: wheelOuter(w), holes: wheelWin(w), z0: 0, z1: 10, cut: true, face: true },
    { id: 'anchor', pts: anchor(0), z0: -3, z1: 13, cut: true, face: true },
    { id: 'pin', pts: pinion(rp), z0: 12, z1: 40, cut: false, face: true },
    { id: 'w3', pts: w3Outer(r3), holes: w3Win(r3), z0: 16, z1: 26, cut: false, face: true },
  ];
}
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop(); return lo.concat(up);
}
// phi：绕竖轴转过的角度（0 = 正视，90° = 右侧视）；xg：图形中心落点 x；v 亮度
export function ghost(phi, xg, v = 1) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const pj = (pts, z) => pts.map(([x, y]) => [xg + (x - E[0]) * c - z * s, y]);
  const parts = model().map(m => ({ ...m, depth: ((m.z0 + m.z1) / 2) * c + (m.pts.reduce((a, q) => a + q[0], 0) / m.pts.length - E[0]) * s }));
  parts.sort((a, b) => a.depth - b.depth);
  const ac = Math.abs(c);
  for (const m of parts) {
    const F0 = pj(m.pts, m.z0), F1 = pj(m.pts, m.z1);
    const front = c >= 0 ? F1 : F0, back = c >= 0 ? F0 : F1;
    // 有齿形/窗孔的零件：翻转途中画真实外轮廓（前后两个面，按 cos 压扁），齿形保留；
    // 只有接近 90° 侧视、面已压成一条竖线时，才淡入外包轮廓（侧视的矩形）
    const wF = m.face ? Math.max(0, Math.min(1, (ac - .06) / .22)) : 0;
    if (wF < 1) {
      const hl = hull(F0.concat(F1));
      knock(hl); line(hl, { w: LW.out, closed: true, v: v * (1 - wF) });
      if (!m.face && ac > .04) line(front, { w: LW.det, closed: true, v });
    }
    if (wF > 0) {
      const zf = c >= 0 ? m.z1 : m.z0, zb = c >= 0 ? m.z0 : m.z1;
      const hf = (m.holes || []).map(h => pj(h, zf)), hb = (m.holes || []).map(h => pj(h, zb));
      knockMulti([back, ...hb]); line(back, { w: LW.det, closed: true, v: v * .5 * wF });
      knockMulti([front, ...hf]);
      line(front, { w: LW.out, closed: true, v: v * wF });
      for (const h of hf) line(h, { w: LW.det, closed: true, v: v * wF });
    }
  }
}
// 图 2（A–A 剖视 = 右侧视 + 夹板 + 剖面线）。u = 夹板/剖面线进度
export const X2 = 1950;
export function fig2(uPlate, uHatch) {
  const zx = z => X2 - z;
  // 夹板（只在剖视里出现）
  const plates = [rect(zx(87), 600, zx(75), 1140), rect(zx(-83), 600, zx(-95), 1140)];
  const pillars = [rect(zx(75), 614, zx(-83), 630), rect(zx(75), 1110, zx(-83), 1126)];
  if (uPlate > 0) { for (const p of pillars) { knock(p); line(p, { w: LW.det, closed: true, u: uPlate }); } }
  ghost(Math.PI / 2, X2);
  if (uPlate > 0) {
    for (const p of plates) { knock(p); line(p, { w: LW.out, closed: true, u: uPlate }); }
    // 支架（后夹板上）
    const br = [[zx(-95), 600], [zx(-130), 600], [zx(-130), 640], [zx(-95), 640]];
    line(br, { w: LW.det, u: uPlate });
  }
  if (uHatch > 0) {
    hatch(plates[0], { u: uHatch, sp: 10 }); hatch(plates[1], { u: uHatch, sp: 10 });
    hatch(rect(zx(10), E[1] - R, zx(0), E[1] + R), { u: uHatch, sp: 9, ang: -Math.PI / 4 });
    hatch(rect(zx(13), P[1] - 30, zx(-3), P[1] + 44), { u: uHatch, sp: 9, ang: Math.PI / 4 });
    hatch(rect(zx(-101), bobAt(0)[1] - BOBR, zx(-141), bobAt(0)[1] + BOBR), { u: uHatch, sp: 11, ang: -Math.PI / 4 });
  }
}
