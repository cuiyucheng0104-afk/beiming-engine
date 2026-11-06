// 整片：镜头、描线日程、标注、翻转、变真、声音事件。一切时间来自 timeline.js 的拍网格。
import { FPS, BF, END_F, DUR, B, Bs, SPB } from './timeline.js';
import { g, f, cam, setCam, clear, LW, line, knock, text, dim, balloon, arrow, nibs, circ, rect, fxShadow, fxUnshadow, FONT, REG, S, TAU, textW } from './engine.js';
import { E, P, R, LP, BOBR, A0, W3C, X2, T15, kin, bobAt, arcPts, ARC_R, fig1, ghost, fig2, imprint } from './mech.js';
import { SW, SH, border, header, notes, partsList, titleBlock, signature, stamp } from './sheet.js';
const D = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const eo = x => 1 - Math.pow(1 - clamp(x), 3);
const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// 拍 b0 起、持续 db 拍的进度（起点取整到帧，保证起笔落在拍上）
// 起点那一帧已经落笔（进度 = 1 帧），所以画面第一笔与声音同帧
const pr = (t, b0, db, e = x => x) => { const t0 = B(b0) - 1 / FPS, t1 = Bs(b0 + db); return t < t0 + 1e-6 ? 0 : e(clamp((t - t0) / (t1 - t0))); };
const lerp = (a, b, x) => a + (b - a) * x;
const lcam = (A, Bc, x) => ({ x: lerp(A.x, Bc.x, x), y: lerp(A.y, Bc.y, x), z: Math.exp(lerp(Math.log(A.z), Math.log(Bc.z), x)) });
const BOB = bobAt(0);

// —— 镜头 ——
const C = {
  s1a: { x: 1270, y: 1060, z: .80 }, s1b: { x: 1292, y: 1078, z: 1.0 },
  // S2：先停在擒纵轮上（叉顶、跨角字留足上边距）→ 沿摆杆下移 → 拉回中景并停住，让所有标注读完
  s2a: { x: 1300, y: 795, z: 1.55 }, s2a2: { x: 1290, y: 805, z: 1.62 },
  s2b: { x: 1180, y: 1320, z: 1.45 }, s2b2: { x: 1175, y: 1335, z: 1.47 },
  s2c: { x: 1360, y: 1072, z: .92 }, s2c2: { x: 1355, y: 1072, z: .95 },
  s3a: { x: 1255, y: 1712, z: 2.3 }, s3b: { x: 1262, y: 1712, z: 2.45 }, s4: { x: 1470, y: 1110, z: .86 },
  // S5：近到摆锤 + 摆角弧占画高四成，第一下"嗒"之后再沿摆杆上摇到擒纵叉
  s5a: { x: 1335, y: 1428, z: 2.3 }, s5a2: { x: 1335, y: 1425, z: 2.45 }, s5b: { x: 1250, y: 930, z: 1.32 },
  s6a: { x: 1175, y: 772, z: 3.3 }, s6b: { x: 1330, y: 778, z: 3.45 },
  s7: { x: 1700, y: 1000, z: .505 },
};
export function camAt(t) {
  if (t < B(6)) return lcam(C.s1a, C.s1b, eio(t / B(6)));
  if (t < B(12)) {
    if (t < B(7.5)) return lcam(C.s2a, C.s2a2, (t - B(6)) / (B(7.5) - B(6)));
    if (t < B(9)) return lcam(C.s2a2, C.s2b, eio((t - B(7.5)) / (B(9) - B(7.5))));
    if (t < B(9.5)) return lcam(C.s2b, C.s2b2, (t - B(9)) / (B(9.5) - B(9)));
    if (t < B(10.5)) return lcam(C.s2b2, C.s2c, eio((t - B(9.5)) / (B(10.5) - B(9.5))));
    return lcam(C.s2c, C.s2c2, (t - B(10.5)) / (B(12) - B(10.5)));
  }
  if (t < B(14)) {
    if (t < B(13)) return lcam(C.s3a, C.s3b, (t - B(12)) / (B(13) - B(12)));
    if (t < B(13.25)) return C.s3b;                       // 新图号先落定一个十六分，再起飞
    return lcam(C.s3b, C.s4, eio((t - B(13.25)) / (B(14) - B(13.25))));
  }
  if (t < B(15)) return C.s4;
  if (t < B(16)) return lcam(C.s5a, C.s5a2, ss((t - B(15)) / (B(16) - B(15))));
  if (t < B(19)) return lcam(C.s5a2, C.s5b, eio((t - B(16)) / (B(19) - B(16))));
  if (t < B(23)) return lcam(C.s6a, C.s6b, ss((t - B(19)) / (B(23) - B(19))));
  const c = lcam(C.s6b, C.s7, eio((t - B(23)) / (Bs(24.25) - B(23))));
  // 落章时的一震
  const k = t - B(26); if (k >= 0 && k < .35) { const a = Math.exp(-k * 16) * Math.sin(k * 90) * 7; c.y += a; }
  return c;
}
export const CUTS = [6, 12, 15, 19];

// —— 描线日程（每层在拍上起笔）——
function progress(t) {
  return {
    rod: pr(t, 4.25, .75, eio), bob: pr(t, 1.5, .5), bobHatch: pr(t, 5, 1), bracket: pr(t, 4.5, .5),
    wheel: pr(t, 2, 1, eio), wheelWin: pr(t, 3, .5), w3: pr(t, 3, 1, eio), w3Win: pr(t, 4, .5), pinion: pr(t, 3.5, .5),
    anchor: pr(t, 4, .75, eio), arbors: pr(t, 5.5, .25), hubHatch: pr(t, 5.25, .5),
  };
}
// 中心线（最后画在最上面）
const CL = [
  { p: [[760, E[1]], [1720, E[1]]], b: 0, d: .6 },
  { p: [[E[0], 590], [E[0], 1580]], b: .25, d: .75 },
  { p: [[1120, BOB[1]], [1380, BOB[1]]], b: .5, d: .4 },
  { p: [[W3C[0] - 175, W3C[1]], [W3C[0] + 175, W3C[1]]], b: .5, d: .4 },
  { p: [[W3C[0], W3C[1] - 175], [W3C[0], W3C[1] + 175]], b: .75, d: .4 },
  { p: [[P[0] - 120, P[1]], [P[0] + 120, P[1]]], b: .75, d: .25 },
];
const CIRC = [
  { c: E, r: 139, b: 1, d: .5 }, { c: W3C, r: 144, b: 1.25, d: .5 }, { c: E, r: 24, b: 1.75, d: .25 },
];
// —— 标注 ——
const nf = (n, k) => x => k.replace('#', String(Math.round(n * x)));
function annotations(t) {
  // Ø174：擒纵轮直径（数字随尺寸线"量"出来而跑）
  const dd = [Math.cos(-32 * D), Math.sin(-32 * D)];
  dim([E[0] - R * dd[0], E[1] - R * dd[1]], [E[0] + R * dd[0], E[1] + R * dd[1]], 0, nf(174, 'Ø#'), { u: pr(t, 6, 1), at: 1.32, size: 36 });
  // 叉瓦跨角
  const ua = pr(t, 6.5, .75);
  if (ua > 0) {
    const r = 300, a0 = -135 * D, a1 = a0 + 90 * D * clamp(ua / .8);
    for (const a of [-135 * D, -45 * D]) line([[E[0] + Math.cos(a) * (R + 40), E[1] + Math.sin(a) * (R + 40)], [E[0] + Math.cos(a) * (r + 16), E[1] + Math.sin(a) * (r + 16)]], { w: LW.hair, u: clamp(ua * 3) });
    const arc = []; for (let i = 0; i <= 40; i++) { const a = a0 + (a1 - a0) * i / 40; arc.push([E[0] + Math.cos(a) * r, E[1] + Math.sin(a) * r]); }
    line(arc, { w: LW.hair, nib: ua < .8 });
    if (ua >= .8) { arrow(arc[0], tang(arc, 0), 16, 4.5); arrow(arc[40], tang(arc, 40), 16, 4.5); }
    text('90° · 7.5 齿', E[0] + 120, E[1] - r - 22, { size: 34, u: clamp((ua - .5) / .5), id: 'span' });
  }
  // 叉轴距 123
  dim([E[0] - 300, P[1]], [E[0] - 300, E[1]], 0, '123', { u: pr(t, 7, .5), size: 30, labelOff: 12 });
  line([[P[0] - 40, P[1]], [E[0] - 314, P[1]]], { w: LW.hair, u: pr(t, 7, .25), nib: false });
  // 摆长 L=442（相机沿着它往下走）
  const XL = 900;
  dim([XL, P[1]], [XL, BOB[1]], 0, nf(442, 'L=#'), { u: pr(t, 7.5, 1.5), size: 38, labelOff: 14, at: .5 });
  line([[P[0] - 120, P[1]], [XL - 16, P[1]]], { w: LW.hair, u: pr(t, 7.5, .3), nib: false });
  line([[BOB[0] - BOBR - 10, BOB[1]], [XL - 16, BOB[1]]], { w: LW.hair, u: pr(t, 8.5, .3), nib: false });
  // 摆锤 Ø84
  const db = [Math.cos(-40 * D), Math.sin(-40 * D)];
  dim([BOB[0] - BOBR * db[0], BOB[1] - BOBR * db[1]], [BOB[0] + BOBR * db[0], BOB[1] + BOBR * db[1]], 0, nf(84, 'Ø#'), { u: pr(t, 8.5, .75), at: 1.55, size: 34 });
}
// 摆角弧 ±6°（全片唯一"变真"的符号）
function swingArc(t) {
  const u = pr(t, 9, .5);
  if (u <= 0) return;
  const tl = t - T15;
  if (tl < 0) {
    // 还在纸上：描出 + 静默里慢慢浮起（影子先出现）
    const lift = clamp((t - 10.3) / .7) * .5;
    const arc = arcPts();
    if (lift > 0) fxShadow([thick(arc, 7)], .9 * lift, 6, 14 * lift, 24 * lift);
    line(arc, { w: LW.det, u });
    if (u >= 1) { arrow(arc[0], tang(arc, 0), 22, 6.5); arrow(arc[40], tang(arc, 40), 22, 6.5); }
    text('±6°', P[0], P[1] + ARC_R + 50, { size: 40, align: 'center', u: clamp((u - .4) / .6), id: 'swing' });
  } else {
    // 变真：箭尾沿弧追上箭头，推着摆锤走；纸上留下淡印
    imprint([thick(arcPts(), 3)], .9);
    text('±6°', P[0], P[1] + ARC_R + 50, { size: 40, align: 'center', v: .3 });
    const fr = tl * FPS + 1, k = eo(fr / 12);
    if (k < 1) {
      const a1 = A0, a0 = lerp(-A0, A0 - .4 * D, k);
      const arc = arcPts(a0, a1), sh = thick(arc, 8);
      const sh2 = thick(arc, 10);
      fxShadow([sh2], .55, 8, 18, 30); fxUnshadow([sh2]);
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; g.filter = `blur(${10 * Math.pow(cam.z, .65)}px)`;
      line(arc, { w: 22, v: 1 - k * .5 }); g.restore(); g.filter = 'none';
      line(arc, { w: 8.5, v: 1 }); arrow(arc[40], tang(arc, 40), 40, 13);
    }
  }
}
function tang(arc, i) { const j = i === 0 ? 1 : i - 1, a = arc[i], b = arc[j]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; }
function thick(pts, w) { const L = [], Rr = []; for (let i = 0; i < pts.length; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; L.push([pts[i][0] - dy / l * w, pts[i][1] + dx / l * w]); Rr.push([pts[i][0] + dy / l * w, pts[i][1] - dx / l * w]); } return L.concat(Rr.reverse()); }
// 气球与零件名
// 拉回中景时每四分之一拍落一个，由下往上（跟着镜头露出的方向）；名字 3/8 拍写完
const BAL = [
  { from: [BOB[0] + 50, BOB[1] - 52], to: [1580, 1380], n: 3, name: '摆锤', b: 9.5 },
  { from: [W3C[0] + 118 * Math.cos(120 * D), W3C[1] + 118 * Math.sin(120 * D)], to: [1020, 1265], n: 4, name: '三轮', b: 9.75 },
  { from: [E[0] + R * Math.cos(-10 * D), E[1] + R * Math.sin(-10 * D)], to: [1640, 820], n: 1, name: '擒纵轮', b: 10 },
  { from: [P[0] + 92, P[1] + 52], to: [1600, 640], n: 2, name: '擒纵叉', b: 10.25 },
];
function balloons(t) {
  for (const o of BAL) {
    const u = pr(t, o.b, .5); if (u <= 0) continue;
    balloon(o.from, o.to, o.n, { u, r: 28 });
    text(o.name, o.to[0] + 44, o.to[1] + 14, { size: 42, font: FONT.cjk, u: pr(t, o.b + .25, .375), id: 'bal' + o.n });
  }
}
// 图号：图 1 · 正视 → 翻面 → 图 2 · A–A 剖视（随图形滑到右侧）
const FIG1 = '图 1 · 正视', FIG2 = '图 2 · A–A 剖视';
function figLabel(str, x, y, o = {}) {
  const wdt = text(str, x, y, { size: 58, font: FONT.cjk, align: 'center', ls: 4, ...o });
  if ((o.sy ?? 1) > 0 && (o.u ?? 1) > 0) {
    const k = o.sy ?? 1, hw = Math.max(wdt, 10) / 2 + 10, uu = o.u ?? 1;
    line([[x - hw, y + 18 * k], [x - hw + 2 * hw * uu, y + 18 * k]], { w: LW.det, nib: false });
  }
}
function labels(t) {
  const tf = B(12), tl = B(13), tg = B(14);
  if (t < tf) { figLabel(FIG1, E[0], 1715, { id: 'fig1', u: pr(t, 5, 1) }); return; }
  if (t < tl) {
    const u = (t - tf) / (Bs(13) - tf), c = Math.cos(Math.PI * u);
    if (c >= 0) figLabel(FIG1, E[0], 1715, { sy: Math.max(.02, c), id: 'fig1' }); else figLabel(FIG2, E[0], 1715, { sy: Math.max(.02, -c), full: FIG2 });
    return;
  }
  const tgo = B(13.25), u = t < tgo ? 0 : eio((t - tgo) / (tg - tgo));
  figLabel(FIG2, lerp(E[0], X2 + 10, u), 1715, { id: 'fig2' });
  // 静默里：图 1 的图号被轻轻重新写上
  const ur = clamp((t - 10.0) / .5);
  if (ur > 0) figLabel(FIG1, E[0], 1715, { u: ur, id: 'fig1b', full: FIG1 });
}
// 剖切位置 A–A（图 1 上）+ 投影线
function sectionMarks(t) {
  const u = pr(t, 13, .4); if (u <= 0) return;
  for (const [y0, y1, ya] of [[560, 604, 548], [1590, 1634, 1660]]) {
    line([[E[0], y0], [E[0], y1]], { w: LW.out * 1.3, u, nib: false });
    if (u >= 1) { line([[E[0] - 70, (y0 + y1) / 2], [E[0] - 8, (y0 + y1) / 2]], { w: LW.thin }); arrow([E[0] - 72, (y0 + y1) / 2], [1, 0], 18, 5); text('A', E[0] - 50, ya + 4, { size: 36, align: 'center', font: FONT.hand }); }
  }
  const uj = pr(t, 13, 1, eio);
  for (const y of [P[1], E[1] - R, E[1], E[1] + R, BOB[1] - BOBR, BOB[1] + BOBR]) line([[1400, y], [1400 + (X2 + 160 - 1400) * uj, y]], { w: LW.hair, v: .42, nib: false, dash: [6, 10] });
  if (t >= B(14)) text('A–A', X2 - 20, 570, { size: 44, align: 'center', font: FONT.hand, u: clamp((t - B(14)) / .25), id: 'aa' });
}
// 活体标注：摆角实时读数（变真之后）
function liveAngle(t, th) {
  if (t < B(16)) return;
  const r = 560, a0 = Math.PI / 2, a1 = Math.PI / 2 + th, arc = [];
  for (let i = 0; i <= 20; i++) { const a = a0 + (a1 - a0) * i / 20; arc.push([P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r]); }
  line(arc, { w: LW.thin });
  const deg = Math.abs(th / D).toFixed(1) + '°';
  text(deg, P[0] + 74, P[1] + r + 24, { size: 34, align: 'left' });
}

// —— 主渲染 ——
export function renderFilm(t) {
  t = Math.min(t, DUR - 1e-6);
  setCam(camAt(t)); clear();
  border(); header(); notes(); partsList(); titleBlock();
  // 图 1
  const real = t >= T15 ? eo(((t - T15) * FPS + 1) / 8) : 0;
  const paperLines = () => {
    for (const c of CL) line(c.p, { w: LW.hair, dash: 'center', u: pr(t, c.b, c.d) });
    for (const c of CIRC) line(circ(c.c[0], c.c[1], c.r, 96), { w: LW.hair, dash: 'center', closed: true, u: pr(t, c.b, c.d) });
    annotations(t);
  };
  // 变真之后，纸上的线留在纸上（被浮起的零件盖住）
  if (real > 0) { paperLines(); fig1(t, progress(t), real); } else { fig1(t, progress(t), real); paperLines(); }
  swingArc(t); balloons(t); labels(t); sectionMarks(t);
  if (real > 0) liveAngle(t, kin(t).th);
  // 翻转中的影图 → 图 2
  // 新图号先落定 5 帧（这一拍被拉长后的一个十六分），影图再起飞
  if (t >= B(13.25) && t < B(14)) { const u = eio((t - B(13.25)) / (B(14) - B(13.25))); ghost(Math.PI / 2 * u, lerp(E[0], X2, u)); }
  if (t >= B(14)) { const uh = clamp(((t - B(14)) * FPS + 1) / 6); fig2(1, uh); }
  // 标题栏签名、红章
  signature(pr(t, 24, 1, x => x));
  // 落章：第一帧从 1.18 倍压下来，3 帧落定
  if (t >= B(26)) { const k = (t - B(26)) * FPS; stamp(Math.min(1, .6 + k * .2), 1 + .18 * Math.exp(-k * 1.1)); }
  nibs();
  return { sheet: [SW, SH], cam: { ...cam }, seed: 4 };
}

// —— 声音事件（mix.py 读 events.json）——
export const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(5), type, ...o });
(function buildEV() {
  EV.push({ t: 0, type: 'grid', bf: BF, fps: FPS, end: END_F });
  // A：制图
  ev(B(0), 'tsq', { dur: Bs(.6) - B(0) });
  for (const c of CL) ev(B(c.b), 'pen', { dur: Bs(c.b + c.d) - B(c.b), len: 1, v: .7 });
  for (const c of CIRC) ev(B(c.b), 'compass', { dur: Bs(c.b + c.d) - B(c.b) });
  ev(B(1.5), 'compass', { dur: Bs(2) - B(1.5) });                         // 摆锤圆
  ev(B(2), 'pen', { dur: Bs(3) - B(2), len: 2.2, v: 1, teeth: 30 });       // 擒纵轮 30 齿
  ev(B(3), 'pen', { dur: Bs(4) - B(3), len: 2.2, v: .9, teeth: 48 });      // 三轮
  ev(B(3), 'pen', { dur: Bs(3.5) - B(3), len: .8, v: .6 });                // 窗孔
  ev(B(3.5), 'pen', { dur: Bs(4) - B(3.5), len: .6, v: .6, teeth: 8 });
  ev(B(4), 'pen', { dur: Bs(4.75) - B(4), len: 1.2, v: .9 });              // 擒纵叉
  ev(B(4.25), 'pen', { dur: Bs(5) - B(4.25), len: 1.6, v: .8 });           // 摆杆
  ev(B(4.5), 'pen', { dur: Bs(5) - B(4.5), len: .5, v: .5 });
  ev(B(5), 'hatch', { dur: Bs(6) - B(5), n: 12 });
  ev(B(5.25), 'hatch', { dur: Bs(5.75) - B(5.25), n: 6, v: .6 });
  ev(B(5.5), 'pen', { dur: Bs(5.75) - B(5.5), len: .3, v: .5 });
  // B：标注
  ev(B(6), 'cut'); ev(B(6), 'pen', { dur: Bs(7) - B(6), len: 1, v: .7 }); ev(Bs(6.15), 'count', { dur: Bs(6.75) - Bs(6.15) }); ev(B(6.25), 'letter', { dur: .45, n: 4 });
  ev(B(6.5), 'pen', { dur: Bs(7.25) - B(6.5), len: 1.1, v: .7 }); ev(B(6.875), 'letter', { dur: Bs(7.25) - B(6.875), n: 6 });
  ev(B(7), 'pen', { dur: Bs(7.5) - B(7), len: .5, v: .5 });
  ev(B(7.5), 'pen', { dur: Bs(9) - B(7.5), len: 2, v: .8 }); ev(Bs(7.725), 'count', { dur: Bs(8.625) - Bs(7.725) }); ev(B(7.75), 'letter', { dur: .6, n: 5 });
  ev(B(8.5), 'pen', { dur: Bs(9.25) - B(8.5), len: .6, v: .6 }); ev(Bs(8.6125), 'count', { dur: Bs(9.0625) - Bs(8.6125) });
  ev(B(9), 'pen', { dur: Bs(9.5) - B(9), len: 1.2, v: .8 }); ev(B(9.25), 'letter', { dur: .4, n: 3 });
  for (const o of BAL) { ev(B(o.b), 'dot'); ev(B(o.b), 'pen', { dur: Bs(o.b + .3) - B(o.b), len: .5, v: .5 }); ev(B(o.b + .25), 'letter', { dur: Bs(o.b + .625) - B(o.b + .25), n: o.name.length }); }
  // C：图号翻面 + 投影翻转（影图在 b13.25 起飞）
  ev(B(12), 'cut'); ev(B(12) - 2 / FPS, 'flip', { dur: Bs(13) - B(12) + 2 / FPS });
  ev(B(13), 'flipland'); ev(B(13.25), 'whoosh', { dur: B(14) - B(13.25) }); ev(B(13), 'pen', { dur: Bs(13.4) - B(13), len: .6, v: .6 });
  ev(B(14), 'slap'); ev(B(14), 'hatch', { dur: 6 / FPS, n: 6, v: .9 }); ev(B(14), 'letter', { dur: .25, n: 3, v: .5 });
  // 静默：只有纸声
  ev(10.0, 'letter', { dur: .5, n: 6, v: .28 }); ev(10.4, 'peel', { dur: .6 });
  // E/F：擒纵每拍一下
  ev(B(15), 'cut'); ev(B(19), 'cut');
  for (let b = 15; b <= 27; b++) ev(B(b), 'tick', { n: b - 15, first: b === 15 });
  ev(B(15), 'release');
  ev(B(23), 'whoosh', { dur: B(25) - B(23), v: .5 });
  ev(B(24), 'sign', { dur: Bs(25) - B(24) });
  ev(B(26), 'stamp');
})();
// 画面实测事件（逐帧求值真实状态），供 cuecheck.py 与音乐拍点对比
(function vhits() {
  const prevCam = { x: 0, y: 0, z: 0 }; let lastSteps = 0;
  const layerFirst = { 0: 'CL', 1: 'CIRC', 2: 'wheel', 3: 'w3', 4: 'anchor', 5: 'bobHatch' };
  const seen = {};
  for (let i = 0; i < END_F; i++) {
    const t = i / FPS, c = camAt(t);
    // 剪切 = 相机位移远大于前一帧的位移（二阶差分），平滑推拉不算
    if (i > 1) {
      const c1 = camAt((i - 1) / FPS), c2 = camAt((i - 2) / FPS);
      const jump = Math.hypot(c.x - c1.x, c.y - c1.y) * c.z + Math.abs(Math.log(c.z / c1.z)) * 1000;
      const prev = Math.hypot(c1.x - c2.x, c1.y - c2.y) * c1.z + Math.abs(Math.log(c1.z / c2.z)) * 1000;
      if (jump > 40 && jump > 4 * prev + 10) EV.push({ t, type: 'vhit', name: 'cut', beat: BF.indexOf(i) });
    }
    Object.assign(prevCam, c);
    const p = progress(t);
    for (const [b, k] of [[2, 'wheel'], [3, 'w3'], [4, 'anchor'], [5, 'bobHatch']]) if (!seen[k] && p[k] > 0) { seen[k] = 1; EV.push({ t, type: 'vhit', name: 'layer:' + k, beat: b }); }
    if (!seen.CL && pr(t, 0, .6) > 0) { seen.CL = 1; EV.push({ t, type: 'vhit', name: 'layer:centre', beat: 0 }); }
    if (!seen.CI && pr(t, 1, .5) > 0) { seen.CI = 1; EV.push({ t, type: 'vhit', name: 'layer:circles', beat: 1 }); }
    if (!seen.dim && pr(t, 6, 1) > 0) { seen.dim = 1; EV.push({ t, type: 'vhit', name: 'dim:wheel', beat: 6 }); }
    if (!seen.span && pr(t, 6.5, .75) > 0) { seen.span = 1; EV.push({ t, type: 'vhit', name: 'dim:span', beat: 6.5 }); }
    if (!seen.L && pr(t, 7.5, 1.5) > 0) { seen.L = 1; EV.push({ t, type: 'vhit', name: 'dim:L', beat: 7.5 }); }
    if (!seen.bob && pr(t, 8.5, .75) > 0) { seen.bob = 1; EV.push({ t, type: 'vhit', name: 'dim:bob', beat: 8.5 }); }
    if (!seen.arc && pr(t, 9, .5) > 0) { seen.arc = 1; EV.push({ t, type: 'vhit', name: 'symbol', beat: 9 }); }
    for (const o of BAL) if (!seen['bal' + o.n] && pr(t, o.b, .5) > 0) { seen['bal' + o.n] = 1; EV.push({ t, type: 'vhit', name: 'balloon', beat: o.b }); }
    if (!seen.flip && t >= B(13)) { seen.flip = 1; EV.push({ t, type: 'vhit', name: 'fig2:label', beat: 13 }); }
    if (!seen.ghost && t >= B(13.25)) { seen.ghost = 1; EV.push({ t, type: 'vhit', name: 'ghost:go', beat: 13.25 }); }
    if (!seen.land && t >= B(14)) { seen.land = 1; EV.push({ t, type: 'vhit', name: 'fig2:land', beat: 14 }); }
    const st = kin(t).steps;
    if (st > lastSteps + 1e-6 && Math.floor(st + .3) > Math.floor(lastSteps + .3)) { EV.push({ t, type: 'vhit', name: 'tick', beat: BF.indexOf(i) }); }
    lastSteps = st;
    if (!seen.sign && pr(t, 24, 1) > 0) { seen.sign = 1; EV.push({ t, type: 'vhit', name: 'sign', beat: 24 }); }
    if (!seen.stamp && t >= B(26)) { seen.stamp = 1; EV.push({ t, type: 'vhit', name: 'stamp', beat: 26 }); }
  }
})();
export { DUR };
