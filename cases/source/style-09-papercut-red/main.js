// 鲤鱼跃龙门 — one continuous take: fold → cut → unfold → peel → climb → silence → leap → dragon → 福
import { canvas, piece, fill, trace, fillPaper, paperShadow, noShadow, transmitOf, Pl } from './engine/paper.js';
import { mul, T, R, S, ap, scaleOf } from './engine/rig.js';
import * as PC from './engine/pieces.js';
import { COL, FR, FLOWER_CARP, carpMatrix, RR, FUR } from './engine/pieces.js';
import { sawRow, sawEdge, crescentRows, swirl, cloudCut } from './engine/motifs.js';
import { DUR, H, B, FPS, b as beat } from './timeline.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash, track } from '/core/lib.js';

const qs = new URLSearchParams(location.search);
const cv = document.getElementById('cv'), G0 = cv.getContext('2d'); let g = G0;
await document.fonts.load('900 80px "Noto Serif SC"', '龙门福');
const TEST = qs.get('test');
if (TEST) { const m = await import('./test.js'); window.DUR = 1; window.render = t => m.test(g, TEST, t); window.READY = true; }
else await film();

async function film() {
const W = 1920, HH = 1080, TAU = Math.PI * 2;
const st = t => Math.floor(t * 12 + 1e-6) / 12;          // 12 fps steps for figure poses
const cam = (cx, cy, z, r = 0) => { const c = Math.cos(r) * z, s = Math.sin(r) * z; return [c, s, -s, c, 960 - (c * cx - s * cy), 540 - (s * cx + c * cy)]; };
const put = (p, M, o = {}) => { g.save(); g.setTransform(...M); if (o.alpha != null) g.globalAlpha = o.alpha; if (o.shadow) paperShadow(g, scaleOf(M), o.shadow); else noShadow(g); if (o.op) g.globalCompositeOperation = o.op; g.drawImage(o.img || p.c, p.x0, p.y0, p.w, p.h); g.restore(); };
const shade = (M, poly, a, col = '40,0,6') => { if (a <= 0.002) return; g.save(); g.setTransform(...M); g.beginPath(); trace(g, poly); g.fillStyle = `rgba(${col},${a})`; g.fill(); g.restore(); };
const Mx = (s, a, x, y, fx = 1) => { const M = mul(T(fx === 1 ? x : -x, y), mul(R(a), S(s))); return fx === 1 ? M : [-M[0], M[1], -M[2], M[3], -M[4], M[5]]; };

// ------------------------------------------------------------ sprites ------------------------------------------------------------
const SHEET = PC.sheetPieces(400), FL = PC.flowerPieces(2.6), CARP = PC.carpPiece(COL.red, .55, 11, 2.4);
const ROS = PC.rosettePieces(2.0), FU = PC.fuPieces(2.6), SC = PC.scissorsPieces(2.2), GATE = PC.gatePieces('"Noto Serif SC"', 1.6);
function tinted(p, col) { const [c, q] = canvas(p.c.width, p.c.height); q.drawImage(p.c, 0, 0); q.globalCompositeOperation = 'source-in'; q.fillStyle = col; q.fillRect(0, 0, c.width, c.height); return c; }
// backlit composite: warm light inside the outline, paper shows as glowing red, holes at full light
function litOf(p, solidCanvas, tcol, gcx = .5, gcy = .5) {
  const Wc = p.c.width, Hc = p.c.height, [c, q] = canvas(Wc, Hc);
  q.drawImage(solidCanvas, 0, 0); q.globalCompositeOperation = 'source-in';
  const gr = q.createRadialGradient(Wc * gcx, Hc * gcy, 0, Wc * gcx, Hc * gcy, Math.max(Wc, Hc) * .62);
  gr.addColorStop(0, '#ffeec4'); gr.addColorStop(.5, '#ffbb66'); gr.addColorStop(1, '#e2662c'); q.fillStyle = gr; q.fillRect(0, 0, Wc, Hc);
  q.globalCompositeOperation = 'source-over'; q.drawImage(transmitOf(p, tcol), 0, 0); return c;
}
CARP.lit = litOf(CARP, CARP.solid.c, '#b8231a');
// the ladder: alternate a lighter and a deeper paper (STYLE §9 red-on-red), each with a carved inner contour and a dark ground gap round it
const LT = [PC.carpPiece('#e4503a', .55, 17, 2.4, { line: [10, 5] }), PC.carpPiece('#a3121a', .55, 19, 2.4, { line: [10, 5] })];
LT[0].lit = litOf(LT[0], LT[0].solid.c, '#d33a24'); LT[1].lit = litOf(LT[1], LT[1].solid.c, '#8e0e14');
const HALO_W = 18, HALO = piece([-260 - HALO_W - 4, -175 - HALO_W - 4, 220 + HALO_W + 4, 180 + HALO_W + 4], q => {
  const G = PC.carpGeom(.55); q.beginPath(); for (const pl of [G.body, G.tail, G.dorsalPoly, G.pelvic, G.anal]) trace(q, pl);
  q.fillStyle = '#0c1130'; q.fill(); q.lineWidth = 2 * HALO_W; q.lineJoin = 'round'; q.strokeStyle = '#0c1130'; q.stroke();
}, { ss: 1.2, tex: false, edge: 0 });
const [Lc, Lg] = canvas(W, HH);
const rosSolid = piece(PC.ROS_BOX, q => fill(q, qq => { qq.moveTo(RR, 0); qq.arc(0, 0, RR, 0, TAU); }, '#fff'), { ss: 2.0, tex: false, edge: 0 });
ROS.lit = litOf(ROS.front, rosSolid.c, '#ae1c17');
{ const [c, q] = canvas(ROS.back.c.width, ROS.back.c.height); q.filter = 'brightness(.55)'; q.drawImage(ROS.back.c, 0, 0); ROS.dark = c; }
const gateDark = tinted(GATE.solid, '#080a1e');
const gateWarm = { plaque: tinted(GATE.plaque, '#ffd48c'), lattice: tinted(GATE.lattice, '#ffc36e'), windows: tinted(GATE.windows, '#f0a050') };
const GR_ = FUR + 22, GOLD = piece([-GR_ - 4, -GR_ - 4, GR_ + 4, GR_ + 4], q => fill(q, qq => trace(qq, [[0, -GR_], [GR_, 0], [0, GR_], [-GR_, 0]]), COL.gold), { ss: 2.6, seed: 31, col: COL.gold, edge: .6 });
// night scenery pieces
const RIDGE = piece([-2600, -260, 2600, 900], q => {
  const top = []; for (let k = 0; k <= 60; k++) { const x = -2600 + 5200 * k / 60; top.push([x, -120 - 110 * Math.abs(Math.sin(k * 1.31)) - 60 * Math.sin(k * .37)]); }
  fill(q, qq => trace(qq, Pl(top.concat([[2600, 900], [-2600, 900]]), true, .5, 3)), COL.far);
  sawRow(q, top.map(([x, y]) => [x, y + 30]), 22, 16, 1, .6);
}, { ss: .5, seed: 41, col: COL.far });
const RIDGE2 = piece([-2600, -200, 2600, 900], q => {
  const top = []; for (let k = 0; k <= 40; k++) { const x = -2600 + 5200 * k / 40; top.push([x, -60 - 90 * Math.abs(Math.sin(k * 2.17 + 1)) ]); }
  fill(q, qq => trace(qq, Pl(top.concat([[2600, 900], [-2600, 900]]), true, .5, 5)), COL.mid);
  crescentRows(q, -2600, 40, 2600, 700, 26, 7, 0, .7);
}, { ss: .5, seed: 42, col: COL.mid });
const CLOUD = piece([-260, -120, 260, 120], q => {
  fill(q, qq => { for (const [x, y, r] of [[-150, 30, 70], [-40, -20, 96], [90, 10, 80], [180, 50, 54], [0, 60, 70]]) { qq.moveTo(x + r, y); qq.arc(x, y, r, 0, TAU); } }, COL.cloud);
  cloudCut(q, -40, -10, 46, 6, 0, 1); cloudCut(q, 110, 20, 34, 5, 2, -1); swirl(q, -160, 40, 30, 1.5, 5, 0, 1);
}, { ss: 1, seed: 43, col: COL.cloud });
const WAVES = piece([-2200, -90, 2200, 900], q => {
  const crest = []; for (let k = 0; k <= 160; k++) { const x = -2200 + 4400 * k / 160; crest.push([x, -40 * Math.pow(Math.abs(Math.sin(k * Math.PI / 8)), .7)]); }
  fill(q, qq => trace(qq, Pl(crest.concat([[2200, 900], [-2200, 900]]), true, .5, 7)), COL.river2);
  crescentRows(q, -2200, 40, 2200, 900, 22, 6, 0, .75);
  for (let k = 0; k < 20; k++) swirl(q, -2090 + k * 220, -6, 16, 1.5, 5, 0, k % 2 ? 1 : -1);
}, { ss: .9, seed: 44, col: COL.river2 });

// ------------------------------------------------------------ fold flap ------------------------------------------------------------
// a sheet swinging about a line through the origin (normal n): s = 1 flat in place, s = -1 folded over (mirrored). 16 strips with fake perspective.
const [Fc, Fg] = canvas(W, HH);
const flapMat = (n, s, sc = 1) => { const tv = [-n[1], n[0]]; return [1 + (s - 1) * n[0] * n[0] + (sc - 1) * tv[0] * tv[0], (s - 1) * n[0] * n[1] + (sc - 1) * tv[0] * tv[1], (s - 1) * n[0] * n[1] + (sc - 1) * tv[0] * tv[1], 1 + (s - 1) * n[1] * n[1] + (sc - 1) * tv[1] * tv[1], 0, 0]; };
function flap(C, front, backP, poly, n, s, D) {
  const tv = [-n[1], n[0]], lift = Math.sqrt(Math.max(0, 1 - s * s)), N = 16, p = s >= 0 ? front : backP, z = scaleOf(C);
  const sg = Math.sign(poly.reduce((a, q) => a + q[0] * n[0] + q[1] * n[1], 0)) || 1;
  Fg.setTransform(1, 0, 0, 1, 0, 0); Fg.clearRect(0, 0, W, HH);
  for (let i = 0; i < N; i++) {
    const d0 = sg * D * i / N - sg * .8, d1 = sg * D * (i + 1) / N + sg * .8, dm = (d0 + d1) / 2, sc = 1 + .28 * Math.abs(dm) / D * lift;
    const strip = [[d0 * n[0] - 4000 * tv[0], d0 * n[1] - 4000 * tv[1]], [d0 * n[0] + 4000 * tv[0], d0 * n[1] + 4000 * tv[1]], [d1 * n[0] + 4000 * tv[0], d1 * n[1] + 4000 * tv[1]], [d1 * n[0] - 4000 * tv[0], d1 * n[1] - 4000 * tv[1]]];
    Fg.save(); Fg.setTransform(...mul(C, flapMat(n, s, sc))); Fg.beginPath(); trace(Fg, poly); Fg.clip(); Fg.beginPath(); trace(Fg, strip); Fg.clip();
    Fg.drawImage(p.c, p.x0, p.y0, p.w, p.h);
    Fg.globalCompositeOperation = 'source-atop'; Fg.fillStyle = s > 0 ? `rgba(40,0,6,${.4 * lift})` : `rgba(255,225,205,${.08 + .1 * lift})`; Fg.fillRect(-5000, -5000, 10000, 10000);
    Fg.restore();
  }
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.shadowColor = `rgba(50,8,6,${.3 + .25 * lift})`; g.shadowBlur = (6 + 26 * lift) * z; g.shadowOffsetX = (3 + 18 * lift) * z; g.shadowOffsetY = (4 + 24 * lift) * z;
  g.drawImage(Fc, 0, 0); g.restore();
}
const foldS = u => Math.cos(Math.PI * Math.pow(clamp(u), 1.8));   // 1 → -1, accelerating so it slaps down on the hit
const unfoldS = u => -Math.cos(Math.PI * eo(u));         // -1 → 1, snaps flat ("pa!")
const crease = (C, a, b2, alpha = .4) => { g.save(); g.setTransform(...C); g.strokeStyle = `rgba(80,6,10,${alpha})`; g.lineWidth = 1.4 / scaleOf(C); g.beginPath(); g.moveTo(...a); g.lineTo(...b2); g.stroke(); g.restore(); };
function stack(C, poly, n, col1 = '#9c1418', col2 = '#b51a1c') { for (let i = n; i >= 1; i--) { g.save(); g.setTransform(...mul(C, T(i * 1.3, i * 1.6))); g.beginPath(); trace(g, poly); g.fillStyle = i % 2 ? col1 : col2; g.fill(); g.restore(); } }

// ------------------------------------------------------------ cut path ------------------------------------------------------------
function pathOf(pts) { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return { pts, L, tot: L[L.length - 1] }; }
function pathAt(P, s) { s = clamp(s, 0, P.tot); let i = 0; while (i < P.L.length - 2 && P.L[i + 1] < s) i++; const f = (s - P.L[i]) / ((P.L[i + 1] - P.L[i]) || 1), a = P.pts[i], b2 = P.pts[i + 1]; return { p: [lerp(a[0], b2[0], f), lerp(a[1], b2[1], f)], ang: Math.atan2(b2[1] - a[1], b2[0] - a[0]) }; }
const CUT = pathOf([[-30, -150], [-62, -110], [-100, -62], [-150, -12], [-196, 44], [-236, 104], [-262, 160], [-300, 200], [-246, 206], [-196, 140], [-146, 80], [-96, 18], [-56, -46], [-28, -196], [-8, -244], [-60, -300], [-160, -330], [-262, -262], [-334, -168], [-372, -56], [-374, 62], [-344, 174], [-290, 262], [-200, 322], [-100, 356], [-8, 372]]);
// cumulative cut length at each snip: short careful snips first, long sweeping ones at the end (the acceleration)
const SNW = [1, 1, 1, 1.8, 1.8, 1.8, 1.8, 1.8, 3.2, 3.2, 3.2, 3.2], SNS = (() => { const tot = SNW.reduce((a, b2) => a + b2, 0) + .6; let acc = .6; return SNW.map(w => (acc += w) / tot * CUT.tot); })();
function snipState(t, times, S0) {   // → {s: cut length, open: blade angle}
  let s = 0, open = .55;
  for (let i = 0; i < times.length; i++) {
    const ti = times[i], prev = i ? times[i - 1] : ti - .5, dc = Math.min(.12, .55 * (ti - prev)), ro = Math.min(.1, .4 * ((times[i + 1] ?? ti + .5) - ti));
    const sPrev = i ? S0[i - 1] : 0;
    if (t < ti - dc) { s = i ? S0[i - 1] : 0; break; }
    if (t <= ti) { const u = ei((t - (ti - dc)) / dc); s = lerp(sPrev, S0[i], u); open = .55 * (1 - u) + .02; break; }
    s = S0[i]; if (t < ti + ro) { open = .02 + .53 * eo((t - ti) / ro); break; }
  }
  return { s, open };
}
function drawScissors(C, tip, ang, open, sc = 1.1, sh = 2.5) {
  const base = mul(C, mul(T(tip[0] - Math.cos(ang) * 120 * sc, tip[1] - Math.sin(ang) * 120 * sc), mul(R(ang), S(sc))));
  put(SC.B, mul(base, R(open / 2)), { shadow: sh }); put(SC.A, mul(base, R(-open / 2)), { shadow: sh });
  g.save(); g.setTransform(...base); g.beginPath(); g.arc(0, 0, 5, 0, TAU); g.fillStyle = '#1d1f28'; g.fill(); g.restore();
}
// scraps: one per snip, flying off the blade tip and settling on the table; they come back as confetti at the end
const SCRAPS = H.snips.slice(0, 10).map((ts, k) => { const sn = snipState(ts, H.snips, SNS), tp = pathAt(CUT, sn.s).p; return { ts, tp, dir: hash(k * 3.1) * TAU, dist: 70 + hash(k * 7.7) * 140, sz: 9 + hash(k * 5.3) * 12, k }; });
function drawScraps(C, t) {
  for (const q of SCRAPS) {
    if (t < q.ts) continue;
    const u = Math.min(1, (t - q.ts) / .6), x = q.tp[0] + Math.cos(q.dir) * q.dist * eo(u) - 30 * eo(u), y = q.tp[1] + Math.sin(q.dir) * q.dist * eo(u) + 70 * eo(u);
    g.save(); g.setTransform(...mul(C, mul(T(x, y), mul(R(q.k + (hash(q.k) - .5) * 6 * eo(u)), S(1 + .4 * Math.sin(u * Math.PI)))))); paperShadow(g, scaleOf(C), 1 + 3 * Math.sin(u * Math.PI));
    g.beginPath(); g.moveTo(-q.sz, -q.sz * .3); g.lineTo(q.sz * .8, -q.sz * .6); g.lineTo(q.sz * .3, q.sz * .7); g.closePath(); g.fillStyle = q.k % 3 ? COL.back : COL.red; g.fill(); g.restore();
  }
}

// ------------------------------------------------------------ cameras ------------------------------------------------------------
const tipCut = t => { const sn = snipState(t, H.snips, SNS); return pathAt(CUT, sn.s); };
const camDay = track([[0, [0, 0, .9]], [H.land, [0, 0, .95]], [H.fold, [-150, 0, 1.2]], [H.scissorsIn, [-190, -80, 1.7]], [H.snips[0] - .1, [-60, -150, 2.5]],
  [H.offcut, [-150, 120, 2.3]], [H.flapLift, [-120, 40, 1.55]], [H.unfold, [0, 0, 1.17]], [H.peel, [0, 0, 1.22]]]);
function camDayAt(t) {
  let [x, y, z] = camDay(t);
  const k = Math.min(ss(seg(t, H.scissorsIn, H.snips[0])), 1 - ss(seg(t, H.offcut - .05, H.flapLift)));
  if (k > 0) { let ax = 0, ay = 0, wsum = 0; for (let i = 0; i < 6; i++) { const w = 6 - i, p = tipCut(t - i * .045).p; ax += p[0] * w; ay += p[1] * w; wsum += w; } x = lerp(x, ax / wsum + 40, k); y = lerp(y, ay / wsum + 20, k); z = lerp(z, 2.5, k); }
  if (t > H.unfold - .02) { const u = t - H.unfold; z *= 1 + .05 * Math.exp(-u * 6) * Math.sin(Math.min(u * 16, Math.PI)); }
  return cam(x, y, z);
}
// the hero hangs high above the gate roof so the 龙门 plaque stays readable under it all through the silence
const HERO_Y = -1720, CAM_APEX = -1200, CAM_HANG = HERO_Y + 40, Z_HANG = 1.25;
// crane: the gate lands on b18 with its roof already in frame (whole gate seen standing up), then a slow rise with the ladder
const camNight = track([[H.peel, [0, 0, 1.22]], [H.settle, [0, -60, 1.08]], [H.gateUp, [0, -680, .62]], [H.copies[3], [0, -700, .6]], [H.launch, [0, -820, .58]], [H.apex, [0, CAM_APEX, .6]],
  [H.burst - .02, [0, CAM_HANG, Z_HANG]], [H.burst + .55, [0, HERO_Y, .8]], [H.fuLand, [0, HERO_Y, .86]], [DUR, [0, HERO_Y, .86]]]);
function camNightAt(t) {
  let [x, y, z] = camNight(t);
  if (t > H.apex && t < H.burst) { const u = ss(seg(t, H.apex + .1, H.burst - .02)); [x, y, z] = [0, lerp(CAM_APEX, CAM_HANG, u), lerp(.6, Z_HANG, u * u * (1.2 - .2 * u))]; }
  let r = 0; if (t >= H.burst) r = .16 * (1 - eio(seg(t, H.burst, H.fuLand)));
  if (t >= H.burst) { const u = t - H.burst; z *= 1 + .06 * Math.exp(-u * 5) * Math.sin(Math.min(u * 14, Math.PI)); }
  if (t >= H.gateUp && t < H.gateUp + .25) y -= 7 * (1 - (t - H.gateUp) / .25) ** 2;   // weight: the frame dips when the gate lands
  return { x, y, z, r, C: cam(x, y, z, r) };
}
const layerC = (N, f) => cam(N.x * f, N.y * f, N.z, N.r);

// ------------------------------------------------------------ ladder ------------------------------------------------------------
const LAD = H.copies.map((tk, k) => { const side = k % 2 ? -1 : 1; return { t: tk, x: side * (330 - 8 * k), y: -300 - 66 * k, a: -1.05 - .015 * k, s: .6, fx: side === 1 ? -1 : 1, tone: (k >> 1) & 1 }; });
const L0 = { x: FLOWER_CARP.x, y: FLOWER_CARP.y, a: FLOWER_CARP.a, s: FLOWER_CARP.s, fx: 1, t: H.settle };
function ladderM(k, t) {
  const c = LAD[k], p = k ? LAD[k - 1] : L0, prevT = k ? LAD[k - 1].t : c.t - .5, d = Math.min(.3, .85 * (c.t - prevT));
  const u = eo(seg(t, c.t - d, c.t)), fxp = p.fx === 1 ? 1 : -1;
  const m = fxp * Math.cos(Math.PI * u), lift = Math.sin(Math.PI * u);
  const x = lerp(p.x * (p.fx === 1 ? 1 : 1), c.x, u), y = lerp(p.y, c.y, u) - 40 * lift, sc = lerp(p.s, c.s, u) * (1 + .12 * lift), a = lerp(p.a, c.a, u);
  const M = mul(T(x, y), mul(S(m, 1), mul(R(a), S(sc))));
  return { M, u, lift, on: t >= c.t - d };
}
function ladderXY(k) { const c = LAD[k]; return [c.x, c.y]; }

// ------------------------------------------------------------ 福 cut path (left triangle) ------------------------------------------------------------
const FUCUT = pathOf([[-4, -140], [-70, -76], [-140, -6], [-74, 70], [-6, 140], [-30, 80], [-70, 20], [-40, -40], [-10, -90]]);
const FUS = H.fuSnips.map((_, i) => FUCUT.tot * (i + 1) / H.fuSnips.length);

// ------------------------------------------------------------ light ------------------------------------------------------------
const [FGc, FG] = canvas(W, HH);
const [Ec, E] = canvas(W, HH), [Bc, Bg] = canvas(W / 2, HH / 2), [B2c, B2] = canvas(W / 2, HH / 2);
const putE = (img, p, M, a = 1) => { if (a <= .002) return; E.save(); E.setTransform(...M); E.globalAlpha = a; E.drawImage(img, p.x0, p.y0, p.w, p.h); E.restore(); };
function bloom(a) {
  Bg.setTransform(1, 0, 0, 1, 0, 0); Bg.clearRect(0, 0, W / 2, HH / 2); Bg.filter = 'blur(9px)'; Bg.drawImage(Ec, 0, 0, W / 2, HH / 2); Bg.filter = 'none';
  B2.setTransform(1, 0, 0, 1, 0, 0); B2.clearRect(0, 0, W / 2, HH / 2); B2.filter = 'blur(36px)'; B2.drawImage(Ec, 0, 0, W / 2, HH / 2); B2.filter = 'none';
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a * .45; g.drawImage(Bc, 0, 0, W, HH); g.globalAlpha = a * .6; g.drawImage(B2c, 0, 0, W, HH); g.restore();
}
function rays(cx, cy, a, maxS = 2.0) {
  B2.setTransform(1, 0, 0, 1, 0, 0); B2.globalCompositeOperation = 'source-over'; B2.clearRect(0, 0, W / 2, HH / 2); B2.globalCompositeOperation = 'lighter';
  const n = 16; for (let i = 0; i < n; i++) { const s = 1 + (maxS - 1) * i / (n - 1); B2.globalAlpha = (1 - i / n) * 1.5 / n; B2.setTransform(s / 2, 0, 0, s / 2, cx / 2 * (1 - s), cy / 2 * (1 - s)); B2.drawImage(Ec, 0, 0); }
  B2.setTransform(1, 0, 0, 1, 0, 0); B2.globalCompositeOperation = 'source-over'; B2.globalAlpha = 1;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.filter = 'blur(3px)'; g.drawImage(B2c, 0, 0, W, HH); g.restore();
}

// ------------------------------------------------------------ the day table (fold, cut, unfold) ------------------------------------------------------------
const HALF_L = [[-400, -400], [0, -400], [0, 400], [-400, 400]], HALF_R = [[0, -400], [400, -400], [400, 400], [0, 400]], FULL = [[-400, -400], [400, -400], [400, 400], [-400, 400]];
const circ = (r, n = 120) => Array.from({ length: n + 1 }, (_, k) => [Math.cos(k / n * TAU) * r, Math.sin(k / n * TAU) * r]);
const [Mc, Mg] = canvas(W, HH);
function drawTable(t, C) {
  const z = scaleOf(C);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); fillPaper(g, 'rice', 0, 0, W, HH, [z * .9, 0, 0, z * .9, C[4], C[5]]);
  const gr = g.createRadialGradient(700, 330, 80, 960, 560, 1400); gr.addColorStop(0, 'rgba(255,205,130,.10)'); gr.addColorStop(1, 'rgba(70,24,12,.42)'); g.fillStyle = gr; g.fillRect(0, 0, W, HH); g.restore();
}
function drawDay(t, C) {
  if (t < H.land) {   // the sheet floats down onto the table
    const u = ei(seg(t, -.25, H.land)), sc = 1 + .45 * (1 - u), M = mul(C, mul(T(-90 * (1 - u), -70 * (1 - u)), mul(R(.24 * (1 - u)), S(sc))));
    put(SHEET.front, M, { shadow: 1 + 9 * (1 - u) });
  } else if (t < H.foldStart) {
    const u = t - H.land, sq = 1 + .02 * Math.exp(-u * 12) * Math.sin(u * 40);
    put(SHEET.front, mul(C, S(sq)), { shadow: 1 });
  } else if (t < H.fold) {
    const s = foldS(seg(t, H.foldStart, H.fold));
    g.save(); g.setTransform(...C); g.beginPath(); trace(g, HALF_L); g.clip(); paperShadow(g, scaleOf(C), 1); g.drawImage(SHEET.front.c, SHEET.front.x0, SHEET.front.y0, SHEET.front.w, SHEET.front.h); g.restore();
    flap(C, SHEET.front, SHEET.back, HALF_R, [1, 0], s, 400);
  } else if (t < H.flapLift) {
    // folded half: cut where the mask has passed
    const sn = snipState(t, H.snips, SNS), cutAll = t >= H.offcut;
    const R0 = 64, R1 = 120;
    // below: the cut layers (both halves cut together), stack thickness offset
    g.save(); g.setTransform(...C); g.beginPath(); trace(g, HALF_L); g.clip();
    g.filter = 'brightness(.6)'; g.drawImage(FL.back.c, FL.back.x0 + 1.3, FL.back.y0 + 1.6, FL.back.w, FL.back.h); g.filter = 'none';
    paperShadow(g, scaleOf(C), 1); g.drawImage(FL.back.c, FL.back.x0, FL.back.y0, FL.back.w, FL.back.h); g.restore();
    if (!cutAll) {
      Mg.setTransform(1, 0, 0, 1, 0, 0); Mg.globalCompositeOperation = 'source-over'; Mg.clearRect(0, 0, W, HH);
      for (let i = 1; i >= 1; i--) { Mg.save(); Mg.setTransform(...mul(C, T(1.3, 1.6))); Mg.beginPath(); trace(Mg, HALF_L); Mg.fillStyle = '#9c1418'; Mg.fill(); Mg.restore(); }
      Mg.save(); Mg.setTransform(...C); Mg.beginPath(); trace(Mg, HALF_L); Mg.clip(); Mg.drawImage(SHEET.back.c, SHEET.back.x0, SHEET.back.y0, SHEET.back.w, SHEET.back.h); Mg.restore();
      Mg.setTransform(...C); Mg.globalCompositeOperation = 'destination-out'; Mg.fillStyle = '#000'; Mg.beginPath();
      if (sn.s > 0) for (let s = 0; s <= sn.s; s += 6) { const q = pathAt(CUT, s).p, r = lerp(R0, R1, s / CUT.tot) * clamp((sn.s - s) / 70 + .12, 0, 1); Mg.moveTo(q[0] + r, q[1]); Mg.arc(q[0], q[1], r, 0, TAU); }
      Mg.fill(); Mg.globalCompositeOperation = 'source-over';
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); paperShadow(g, scaleOf(C), 1); g.drawImage(Mc, 0, 0); g.restore();
    } else {
      // the waste frame drops off the table
      const u = seg(t, H.offcut, H.offcut + .5), M = mul(C, mul(T(-60 * u, 380 * ei(u)), mul(R(-.25 * u), S(1 + .05 * Math.sin(u * Math.PI)))));
      if (u < 1) { g.save(); g.setTransform(...M); g.beginPath(); trace(g, HALF_L); trace(g, circ(FR + 9)); g.clip('evenodd'); paperShadow(g, scaleOf(C), 1 + 4 * u); g.drawImage(SHEET.back.c, SHEET.back.x0, SHEET.back.y0, SHEET.back.w, SHEET.back.h); g.restore(); }
    }
    crease(C, [0, -400], [0, 400], .35);
    drawScraps(C, t);
    // scissors
    if (t > H.scissorsIn - .05 && t < H.offcut + .4) {
      const tip = tipCut(t), inU = eo(seg(t, H.scissorsIn - .05, H.snips[0] - .14)), outU = ei(seg(t, H.offcut, H.offcut + .4));
      const p = [tip.p[0] + 900 * (1 - inU) + 700 * outU, tip.p[1] + 600 * (1 - inU) - 500 * outU];
      drawScissors(C, p, tip.ang, sn.open, 1.1, 2.5 + 6 * (1 - inU) + 6 * outU);
    }
  } else {
    // unfold: the top layer swings back to the right
    drawScraps(C, t);
    const s = unfoldS(seg(t, H.flapLift, H.unfold)), pop = t >= H.unfold ? 1 + .05 * Math.exp(-(t - H.unfold) * 7) : 1;
    const Cp = mul(C, S(pop));
    g.save(); g.setTransform(...Cp); g.beginPath(); trace(g, HALF_L); g.clip(); paperShadow(g, scaleOf(Cp), 1); g.drawImage(FL.front.c, FL.front.x0, FL.front.y0, FL.front.w, FL.front.h); g.restore();
    if (t < H.unfold) flap(Cp, FL.front, FL.back, HALF_R, [1, 0], s, 400);
    else { g.save(); g.setTransform(...Cp); g.beginPath(); trace(g, HALF_R); g.clip(); paperShadow(g, scaleOf(Cp), 1); g.drawImage(FL.front.c, FL.front.x0, FL.front.y0, FL.front.w, FL.front.h); g.restore(); crease(Cp, [0, -380], [0, 380], .25); }
    if (t >= H.unfold) { const a = .32 * Math.exp(-(t - H.unfold) * 3.5); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; const gr = g.createRadialGradient(960, 520, 0, 960, 540, 760); gr.addColorStop(0, `rgba(255,205,140,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, HH); g.restore(); }
  }
}

// ------------------------------------------------------------ night ------------------------------------------------------------
function ambientAt(t) {
  let a = 1;
  if (t > H.settle) a = lerp(1, .9, seg(t, H.settle, H.settle + .6));
  if (t > H.apex) a = lerp(.9, .42, ss(seg(t, H.apex, H.apex + 1.0)));
  if (t >= H.burst) a = lerp(.95, .88, seg(t, H.burst, H.burst + .6));
  return a;
}
function gateM(N, t) {
  const C = layerC(N, .85), u = seg(t, H.gateUp - .55, H.gateUp), up = u >= 1 ? 1 : Math.sin(Math.PI / 2 * eio(u)), rec = 1 - .1 * eo(seg(t, H.burst, H.burst + .45));
  return { M: mul(C, mul(T(0, -350 - 500 * (1 - rec)), mul(S(rec), S(1, Math.max(.001, up))))), up };
}
function drawNight(t, N) {
  const C = N.C, z = N.z;
  // sky paper, far ridges, clouds
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = COL.sky; g.fillRect(0, 0, W, HH); g.restore();
  const Cs = layerC(N, .2); g.save(); g.setTransform(...Cs); g.rotate(0); g.restore();
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); fillPaper(g, 'indigo', -400, -400, W + 800, HH + 800, Cs); g.restore();
  const Cc = layerC(N, .6);
  for (const [x, y, s2] of [[-900, -1500, 1.3], [820, -1650, 1.1], [-300, -1950, .9], [1300, -1150, .8], [-1350, -1080, .9]]) put(CLOUD, mul(Cc, mul(T(x, y), S(s2))), { shadow: 1 });
  put(RIDGE, mul(layerC(N, .45), T(0, -420)), { shadow: 1 });
  put(RIDGE2, mul(layerC(N, .62), T(0, -320)), { shadow: 1 });
  // gate standing up from the far bank
  const G = gateM(N, t);
  if (G.up > .002) { put(GATE.front, G.M, { shadow: 1.5 }); if (G.up < 1) put(GATE.solid, G.M, { img: gateDark, alpha: .6 * (1 - G.up) }); if (G.up < 1) { g.save(); g.setTransform(...G.M); g.globalCompositeOperation = 'source-atop'; g.restore(); } }
  return G;
}
function gateLights(t) {
  const dim = t > H.apex ? lerp(1, .3, ss(seg(t, H.apex, H.apex + 1))) : 1, back2 = t >= H.burst ? 1 : 0;
  const k = back2 ? .6 : dim;
  return { plaque: seg(t, H.plaque, H.plaque + .15) * (back2 ? .6 : Math.max(dim, .75)), lattice: seg(t, H.copies[4], H.copies[13]) * k, windows: seg(t, H.copies[8], H.copies[13] + .2) * k };
}
function drawHeroCarp(t, N) {
  // rises from behind the near waves, flies to the apex above the gate, hangs in the silence
  if (t < H.launch || t >= H.burst) return null;
  const u = seg(t, H.launch, H.apex), y = lerp(-440, HERO_Y, eo(u)), sp = u < 1 ? (1 - eo(u)) : 0, ax = 270 * Math.sin(Math.PI * eo(u)), tilt = u < 1 ? Math.atan2(270 * Math.PI * Math.cos(Math.PI * eo(u)), 960) * (1 - ss(seg(u, .55, 1))) : 0;   // arcs past the plaque
  let hov = 0, rot = 0, sq = 1;
  if (t >= H.apex) { const ts = st(t) - H.apex; hov = 7 * Math.sin(ts * 3.4); rot = .03 * Math.sin(ts * 2.2); }
  if (t >= H.burst - .33) { const v = seg(t, H.burst - .33, H.burst); sq = 1 - .1 * Math.sin(v * Math.PI / 2); rot += .06 * v; }
  const M = mul(N.C, mul(T(ax, y + hov), mul(R(-Math.PI / 2 + rot + tilt), S(1.1 * (1 + .18 * sp) * sq, 1.1 / (1 + .1 * sp)))));
  return M;
}
const ROSC = [0, HERO_Y];
function rosetteState(t) {
  if (t < H.burst) return null;
  return { pop: t - H.burst < 1 / 12 ? 1.15 : 1, s2: t < H.unfold2 - .24 ? -1 : unfoldS(seg(t, H.unfold2 - .24, H.unfold2)), s3: t < H.unfold3 - .24 ? -1 : unfoldS(seg(t, H.unfold3 - .24, H.unfold3)) };
}
const Q_TL = [[-RR - 10, -RR - 10], [0, -RR - 10], [0, 0], [-RR - 10, 0]], Q_BL = [[-RR - 10, 0], [0, 0], [0, RR + 10], [-RR - 10, RR + 10]], H_L = [[-RR - 10, -RR - 10], [0, -RR - 10], [0, RR + 10], [-RR - 10, RR + 10]], H_R = [[0, -RR - 10], [RR + 10, -RR - 10], [RR + 10, RR + 10], [0, RR + 10]];
function clipPut(M, p, poly, o = {}) { g.save(); g.setTransform(...M); g.beginPath(); trace(g, poly); g.clip(); if (o.alpha != null) g.globalAlpha = o.alpha; if (o.shadow) paperShadow(g, scaleOf(M), o.shadow); g.drawImage(o.img || p.c, p.x0, p.y0, p.w, p.h); g.restore(); }
function clipE(M, img, p, poly, a) { if (a <= .002) return; E.save(); E.setTransform(...M); E.beginPath(); trace(E, poly); E.clip(); E.globalAlpha = a; E.drawImage(img, p.x0, p.y0, p.w, p.h); E.restore(); }

// ------------------------------------------------------------ events (sound) ------------------------------------------------------------
const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(5), type, ...o });
ev(0, 'roomtone', { dur: H.peel + .3 });
ev(H.land, 'land'); ev(H.foldStart, 'foldswish'); ev(H.fold, 'crease'); ev(H.scissorsIn, 'scissorsin');
H.snips.forEach((t, i) => ev(t, 'snip', { i, n: H.snips.length }));
SCRAPS.forEach(q => ev(q.ts + .6, 'scrapland', { k: q.k }));
ev(H.offcut, 'offcut'); ev(H.flapLift, 'flapswish'); ev(H.unfold, 'unfold');
ev(H.lift, 'lift'); ev(H.peel, 'peel'); ev(H.settle, 'settle'); ev(H.peel, 'nightbed', { dur: DUR - H.peel });
ev(H.gateUp, 'gateup'); ev(H.plaque, 'plaque');
H.copies.forEach((t, i) => ev(t, 'copy', { i }));
ev(H.launch, 'launch'); ev(H.apex, 'apex'); ev(H.burst, 'burst'); ev(H.unfold2, 'unfold2'); ev(H.unfold3, 'unfold3');
ev(H.fuIn, 'fuin'); ev(H.fuFold, 'fufold'); H.fuSnips.forEach((t, i) => ev(t, 'fusnip', { i })); ev(H.fuFlap, 'fuflapswish'); ev(H.fuLand, 'fuland');
ev(H.fuLand + .25, 'confetti', { dur: DUR - H.fuLand - .25 });
ev(DUR, 'end');
window.EV = EV; window.DUR = DUR; window.TL = { B, FPS, H };

// confetti: the cut scraps come back, falling round the dragon
const CONF = Array.from({ length: 120 }, (_, k) => ({ x: (hash(k * 1.7) - .5) * 2100, y0: HERO_Y - 640 - hash(k * 2.3) * 1500, v: 340 + hash(k * 3.9) * 300, sz: 10 + hash(k * 5.1) * 14, gold: k % 4 === 0, ph: hash(k * 9.1) * TAU }));

// ------------------------------------------------------------ render ------------------------------------------------------------
let texts = [];
window.render = t => {
  texts = []; g = G0;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; noShadow(g);
  E.setTransform(1, 0, 0, 1, 0, 0); E.globalAlpha = 1; E.clearRect(0, 0, W, HH);
  if (t < H.peel) { const C = camDayAt(t); drawTable(t, C); drawDay(t, C); return; }
  const N = camNightAt(t), C = N.C;
  const G = drawNight(t, N);
  const amb = ambientAt(t);
  const ambient = () => { if (amb < .999) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = g === FG ? 'source-atop' : 'multiply'; const v = Math.round(255 * amb), vb = Math.round(255 * (amb * .85 + .15)); if (g === FG) { g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 1; g.fillStyle = `rgba(0,0,${Math.round(30 * (1 - amb))},${1 - amb})`; } else g.fillStyle = `rgb(${v},${v},${vb})`; g.fillRect(0, 0, W, HH); g.restore(); } };
  ambient();
  // gate holes light up (behind everything in front)
  if (G.up > .5) {
    const Lg = gateLights(t);
    for (const k of ['plaque', 'lattice', 'windows']) { if (Lg[k] > .002) { put(GATE[k], G.M, { img: gateWarm[k], alpha: Lg[k] * (k === 'windows' ? .7 : 1) }); if (t < H.burst) putE(gateWarm[k], GATE[k], G.M, Lg[k] * (k === 'windows' ? .7 : 1)); } }
  }
  if (t >= H.burst) { const a = .5 * Math.exp(-(t - H.burst) * 2.4) + .16; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgba(6,8,26,${a})`; g.fillRect(0, 0, W, HH); g.restore(); }
  // ---- foreground layer (own canvas, darkened by the same ambient) ----
  g = FG; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, HH);
  const Cw = layerC(N, 1.08); put(WAVES, mul(Cw, T(0, 300)), { shadow: 1.5 });
  const lift = Math.min(ss(seg(t, H.lift, H.peel)), 1 - ss(seg(t, H.settle - .2, H.settle)));
  if (t < H.settle) {
    const u = ei(seg(t, H.peel, H.settle)), n = [-.8575, .5145], C0 = [W, 0], Dt = (W * .8575 + HH * .5145) * 1.15, p = Dt * u;
    const rect = [[0, 0], [W, 0], [W, HH], [0, HH]], dot = q => (q[0] - C0[0]) * n[0] + (q[1] - C0[1]) * n[1];
    const keep = clipHalf(rect, q => dot(q) - p), gone = clipHalf(rect, q => p - dot(q));
    const refl = gone.map(q => { const d = dot(q) - p; return [q[0] - 2 * d * n[0], q[1] - 2 * d * n[1]]; });
    const Cd = camDayAt(H.peel - .001);
    if (keep.length > 2) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); trace(g, keep); g.clip(); fillPaper(g, 'rice', 0, 0, W, HH, [Cd[0] * .9, 0, 0, Cd[0] * .9, Cd[4], Cd[5]]); const gr = g.createRadialGradient(700, 330, 80, 960, 560, 1400); gr.addColorStop(0, 'rgba(255,205,130,.10)'); gr.addColorStop(1, 'rgba(70,24,12,.42)'); g.fillStyle = gr; g.fillRect(0, 0, W, HH); g.restore(); }
    if (refl.length > 2) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.shadowColor = 'rgba(10,8,30,.55)'; g.shadowBlur = 30; g.shadowOffsetX = -14; g.shadowOffsetY = 18; g.beginPath(); trace(g, refl); g.fillStyle = '#e4d6b6'; g.fill(); noShadow(g); g.clip(); fillPaper(g, 'rice', 0, 0, W, HH, [.9, 0, 0, .9, 0, 0], 'rgba(120,90,50,.12)'); g.restore(); }
  }
  put(FL.front, C, { shadow: 1 + 5 * lift });
  // ladder of carps
  const lad = [];
  for (let k = 0; k < LAD.length; k++) { const L = ladderM(k, t); if (!L.on) continue; const M = mul(C, L.M); lad.push({ k, M, L }); put(HALO, M, { alpha: .92 * L.u }); put(LT[LAD[k].tone], M, { shadow: 1 + 4 * L.lift }); }
  // hero
  const HM = drawHeroCarp(t, N);
  if (HM) put(CARP, HM, { shadow: 2 });
  // splash: paper droplets thrown out of the river at the launch
  if (t >= H.launch && t < H.launch + .5) { const u = (t - H.launch) / .5;
    for (let k = 0; k < 12; k++) { const a = -Math.PI / 2 + (k / 11 - .5) * 2.4, r = 60 + 260 * eo(u) * (.6 + .4 * hash(k * 4.1)), x = Math.cos(a) * r, y = -300 + Math.sin(a) * r + 500 * u * u;
      g.save(); g.setTransform(...mul(C, mul(T(x, y), mul(R(a + u * 4), S(1 - u * .6))))); paperShadow(g, N.z, 1.5); g.beginPath(); g.ellipse(0, 0, 16, 7, 0, 0, TAU); g.fillStyle = k % 2 ? '#5d6fae' : '#7c8cc6'; g.fill(); g.restore(); } }
  // rosette
  const RS = rosetteState(t), RM = mul(C, mul(T(...ROSC), S(RS ? RS.pop : 1)));
  if (RS) {
    // packet: top-left quarter, stack thickness under it
    for (let i = t < H.unfold2 ? 6 : t < H.unfold3 ? 3 : 1; i >= 1; i--) clipPut(mul(RM, T(i * 3.2, i * 4)), ROS.back, Q_TL, { img: ROS.dark });
    clipPut(RM, ROS.front, Q_TL, { shadow: 1 });
    if (t < H.unfold2) flap(RM, ROS.front, ROS.back, Q_BL, [0, 1], RS.s2, RR);
    else clipPut(RM, ROS.front, Q_BL, { shadow: 1 });
    if (t >= H.unfold2) { if (t < H.unfold3) flap(RM, ROS.front, ROS.back, H_R, [1, 0], RS.s3, RR); else clipPut(RM, ROS.front, H_R, { shadow: 1 }); }
    if (t < H.unfold2) { crease(RM, [0, 0], [0, -RR], .55); crease(RM, [0, 0], [-RR, 0], .55); }
    else if (t < H.unfold3) crease(RM, [0, -RR], [0, RR], .5);
    else { crease(RM, [0, -RR], [0, RR], .3); crease(RM, [-RR, 0], [0, 0], .25); }
  }
  ambient();
  g = G0; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(FGc, 0, 0); g.restore();
  // emissive: backlit carps, rosette
  const dimC = t > H.apex ? lerp(1, .35, ss(seg(t, H.apex, H.apex + 1))) : 1;
  // ladder glow on its own layer: each nearer carp's ground gap erases the glow of the carps behind it, the rosette covers them
  if (lad.length) {
    Lg.setTransform(1, 0, 0, 1, 0, 0); Lg.globalAlpha = 1; Lg.globalCompositeOperation = 'source-over'; Lg.clearRect(0, 0, W, HH);
    for (const { k, M, L } of lad) {
      const gl = seg(t, LAD[k].t, LAD[k].t + .25) * (.25 + .75 * k / 13) * dimC * (1 - L.lift * .6) * (t >= H.burst ? .8 : 1), P = LT[LAD[k].tone];
      Lg.save(); Lg.setTransform(...M); Lg.globalCompositeOperation = 'destination-out'; Lg.globalAlpha = L.u; Lg.drawImage(HALO.c, HALO.x0, HALO.y0, HALO.w, HALO.h); Lg.restore();
      if (gl > .002) { Lg.save(); Lg.setTransform(...M); Lg.globalAlpha = gl * .85; Lg.drawImage(P.lit, P.x0, P.y0, P.w, P.h); Lg.restore(); }
    }
    if (RS) { Lg.save(); Lg.setTransform(...RM); Lg.globalCompositeOperation = 'destination-out'; Lg.drawImage(rosSolid.c, rosSolid.x0, rosSolid.y0, rosSolid.w, rosSolid.h); Lg.restore(); }
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(Lc, 0, 0); g.restore();
    E.save(); E.setTransform(1, 0, 0, 1, 0, 0); E.globalAlpha = .6; E.drawImage(Lc, 0, 0); E.restore();
  }
  if (HM) { const gl = t < H.apex ? .45 * seg(t, H.launch, H.apex) : lerp(.45, 1, ss(seg(t, H.apex, H.burst - .1))); put(CARP, HM, { img: CARP.lit, alpha: gl }); putE(CARP.lit, CARP, HM, gl); }
  if (RS) {
    const flash = 1 + 1.4 * Math.exp(-(t - H.burst) * 5);
    const flatPolys = [Q_TL]; if (t >= H.unfold2) flatPolys.push(Q_BL); if (t >= H.unfold3) flatPolys.push(H_R);
    const fk = t > H.fuLand ? 1 + .05 * Math.sin(t * 9.3) * Math.sin(t * 3.1 + 1) : 1;
    for (const poly of flatPolys) { clipPut(RM, ROS.front, poly, { img: ROS.lit, alpha: .9 * fk }); clipE(RM, ROS.lit, ROS.front, poly, Math.min(1, .55 * flash * fk)); }
    if (t < H.burst + .25) { const a = .7 * Math.exp(-(t - H.burst) * 9); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; const gr = g.createRadialGradient(960, 540, 0, 960, 540, 900); gr.addColorStop(0, `rgba(255,236,190,${a})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, HH); g.restore(); }
  }
  bloom(RS ? .6 : .7);
  if (RS) { const c = ap(C, ROSC); rays(c[0], c[1], .55 * Math.min(1.6, 1 + 1.2 * Math.exp(-(t - H.burst) * 3))); }
  // 福: arrives, folds, is cut, unfolds; gold foil shows through its holes
  if (t >= H.fuIn - .3) {
    const u = ei(seg(t, H.fuIn - .3, H.fuIn)), pop = t >= H.fuLand && t - H.fuLand < 1 / 12 ? 1.15 : 1;
    const M = mul(C, mul(T(ROSC[0], ROSC[1] - 260 * (1 - u)), S(1.2 * (1 + .5 * (1 - u)) * pop)));
    const TRI_L = [[0, -FUR - 14], [0, FUR + 14], [-FUR - 14, 0]], TRI_R = [[0, -FUR - 14], [FUR + 14, 0], [0, FUR + 14]];
    const MG = mul(C, mul(T(ROSC[0], ROSC[1] - 200 * (1 - ei(seg(t, H.fuIn - .3, H.fuIn)))), S(1.2 * (1 + .4 * (1 - ei(seg(t, H.fuIn - .3, H.fuIn)))))));
    put(GOLD, MG, { shadow: 1.4 });
    if (t >= H.fuLand) {
      // gold sheen sweeping once
      const sw = seg(t, H.fuLand, H.fuLand + .9);
      put(FU.front, M, { shadow: 1.2 });
      if (sw > 0 && sw < 1) { g.save(); g.setTransform(...M); g.beginPath(); trace(g, [[0, -FUR], [FUR, 0], [0, FUR], [-FUR, 0]]); g.clip(); g.globalCompositeOperation = 'lighter'; const x = lerp(-260, 260, sw), gr = g.createLinearGradient(x - 60, -60, x + 60, 60); gr.addColorStop(0, 'rgba(255,230,160,0)'); gr.addColorStop(.5, 'rgba(255,230,160,.35)'); gr.addColorStop(1, 'rgba(255,230,160,0)'); g.fillStyle = gr; g.fillRect(-200, -200, 400, 400); g.restore(); }
      const fl = .5 * Math.exp(-(t - H.fuLand) * 5); if (fl > .01) { const c = ap(C, ROSC); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; const gr = g.createRadialGradient(c[0], c[1], 0, c[0], c[1], 360); gr.addColorStop(0, `rgba(255,220,150,${fl})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, HH); g.restore(); }
      const box = [[-86, -88], [86, -88], [86, 98], [-86, 98]].map(q => ap(M, q));
      texts.push({ id: 'fu', text: '福', x0: Math.min(...box.map(q => q[0])), y0: Math.min(...box.map(q => q[1])), x1: Math.max(...box.map(q => q[0])), y1: Math.max(...box.map(q => q[1])) });
    } else if (t < H.fuIn) put(FU.plainF, M, { shadow: 1 + 5 * (1 - u) });
    else if (t < H.fuFold) { clipPut(M, FU.plainF, TRI_L, { shadow: 1 }); flap(M, FU.plainF, FU.plainB, TRI_R, [1, 0], foldS(seg(t, H.fuIn, H.fuFold)), FUR); }
    else if (t < H.fuFlap) {
      const sn = snipState(t, H.fuSnips, FUS);
      clipPut(M, FU.back, TRI_L, { shadow: 1 });
      Mg.setTransform(1, 0, 0, 1, 0, 0); Mg.globalCompositeOperation = 'source-over'; Mg.clearRect(0, 0, W, HH);
      Mg.save(); Mg.setTransform(...M); Mg.beginPath(); trace(Mg, TRI_L); Mg.clip(); Mg.drawImage(FU.plainB.c, FU.plainB.x0, FU.plainB.y0, FU.plainB.w, FU.plainB.h); Mg.restore();
      Mg.setTransform(...M); Mg.globalCompositeOperation = 'destination-out'; Mg.fillStyle = '#000'; Mg.beginPath();
      if (sn.s > 0) for (let s = 0; s <= sn.s; s += 4) { const q = pathAt(FUCUT, s).p, r = 52 * clamp((sn.s - s) / 50 + .12, 0, 1); Mg.moveTo(q[0] + r, q[1]); Mg.arc(q[0], q[1], r, 0, TAU); }
      Mg.fill(); Mg.globalCompositeOperation = 'source-over';
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(Mc, 0, 0); g.restore();
      const tip = pathAt(FUCUT, sn.s), inU = eo(seg(t, H.fuFold + .16, H.fuSnips[0] - .08)), outU = ei(seg(t, H.fuSnips[H.fuSnips.length - 1], H.fuFlap));
      drawScissors(M, [tip.p[0] + 500 * (1 - inU) + 500 * outU, tip.p[1] + 300 * (1 - inU) - 400 * outU], tip.ang, sn.open, .55, 2);
    } else { clipPut(M, FU.front, TRI_L, { shadow: 1 }); flap(M, FU.front, FU.back, TRI_R, [1, 0], unfoldS(seg(t, H.fuFlap, H.fuLand)), FUR); }
  }
  // confetti (the scraps' future)
  if (t > H.fuLand) {
    for (let k = 0; k < CONF.length; k++) {
      const q = CONF[k], tt = t - H.fuLand, y = q.y0 + q.v * tt, x = q.x * (1 - .3 * Math.min(1, tt / 2)) + 40 * Math.sin(tt * 2 + q.ph), M = mul(C, mul(T(x, y), mul(R(q.ph + tt * 3 * (k % 2 ? 1 : -1)), S(1, Math.cos(tt * 4 + q.ph)))));
      g.save(); g.setTransform(...M); paperShadow(g, N.z, 2); g.beginPath(); g.moveTo(-q.sz, -q.sz * .3); g.lineTo(q.sz * .8, -q.sz * .6); g.lineTo(q.sz * .3, q.sz * .7); g.closePath(); g.fillStyle = q.gold ? COL.gold : (k % 3 ? COL.back : COL.red); g.fill(); g.restore();
    }
  }
  // the plaque text, for the reading check
  if (G.up >= 1 && t < H.burst) {
    const box = [[-100, -800], [100, -800], [100, -696], [-100, -696]].map(q => ap(G.M, [q[0], q[1] + 350 - 350]));
    const bx = { x0: Math.min(...box.map(q => q[0])), y0: Math.min(...box.map(q => q[1])), x1: Math.max(...box.map(q => q[0])), y1: Math.max(...box.map(q => q[1])) };
    if (bx.x0 >= 0 && bx.y0 >= 0 && bx.x1 <= W && bx.y1 <= HH) texts.push({ id: 'plaque', text: '龙门', ...bx });
  }
};
function clipHalf(poly, f) {   // keep the part where f(q) >= 0
  const out = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], b2 = poly[(i + 1) % poly.length], fa = f(a), fb = f(b2); if (fa >= 0) out.push(a); if ((fa >= 0) !== (fb >= 0)) { const u = fa / (fa - fb); out.push([a[0] + (b2[0] - a[0]) * u, a[1] + (b2[1] - a[1]) * u]); } } return out;
}
window.TEXTS = t => { window.render(t); return texts; };
window.READY = true;
}
