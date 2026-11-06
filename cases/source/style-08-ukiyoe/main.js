// 一伞三景 — main: camera, handscroll, sheets, the umbrella's flight, figures, cartouches, seals, events
import { clamp, lerp, seg, ss, eio, eo, ei, hash, mulberry, monotone, TAU } from '/core/lib.js';
import { W, H, FR, PAL, TX, mk, KMAX, buildTextures, inkify, stampLayer, stampSweep, stampFn, drawSeal, cartouche, rgba } from './print.js';
import { SHEETS, WILLOW, deckY, CREST, CHILD_AT, PEAK } from './scenes.js';
import { umbrella, UMB, GRIP, woman, womanPoint, child } from './figures.js';
import { rain, willow, fclaw, spray, plover } from './nature.js';
import { BPM, BEAT, DUR, T, BEATS, b, REVEAL, KEY_REVEAL, PRINT, CLAP, ROLL } from './timeline.js';

const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const QS = new URLSearchParams(location.search);
await document.fonts.load('400 40px MaShan', '一伞三景檐雨浪尖远岳初晴');
await document.fonts.load('600 40px NotoSerif', '其一二三'); await document.fonts.load('900 40px NotoSerif', '伞雨晴');
buildTextures();

// ————————————————————————— blocks —————————————————————————
const REG = [[0, 0], [2.2, -1.3], [-1.8, 1.9], [1.5, 2.2], [-1.4, -2.0]];
const SHIFT = [[4, -5], [-6, 4], [5, 5], [-5, -4], [6, -3]];
function blockCanvas(d, K, seed) {
  const c = mk(W * K, H * K), x = c.getContext('2d'); x.setTransform(K, 0, 0, K, 0, 0);
  d.draw(x); const hk = hash(seed * 7.31 + 1.7);
  inkify(c, { speck: d.speck ?? .3, grain: (d.grain || 0) * 1.7, gx: hk * 400 - 200, baren: d.baren ?? (d.grain ? .38 : .12), bx: (hk - .5) * 300, by: (hash(hk) - .5) * 200 });
  return c;
}
// a static sheet: all steps printed into one canvas, each with its own textures and registration offset
function composite(steps, K, seed) {
  const out = mk(W * K, H * K), o = out.getContext('2d');
  steps.forEach((d, i) => { const c = blockCanvas(d, K, seed * 31 + i); o.drawImage(c, REG[d.g][0] * K, REG[d.g][1] * K); c.width = c.height = 1; });
  return out;
}
const S0b = {};
for (const [k, d] of Object.entries(SHEETS[0].blocks)) S0b[k] = blockCanvas(d, 2, k.length * 13 + k.charCodeAt(0));
const S1c = composite(SHEETS[1].steps, 1, 2), S2c = composite(SHEETS[2].steps, 1, 3), S3c = composite(SHEETS[3].steps, 2, 4);
const S3sky = { rain: blockCanvas(SHEETS[3].blocks.skyRain, 1, 91), dawn: blockCanvas(SHEETS[3].blocks.skyDawn, 1, 92) };

// ————————————————————————— helpers —————————————————————————
const q8 = t => Math.floor(t * 8 + 1e-6) / 8;          // figures and nature step at 8 fps
const q12 = t => Math.floor(t * 12 + 1e-6);             // rain, spray, claws at 12 fps
const SX = [0, 2200, 4400, 6600];
const kf = keys => { const f = monotone(keys); return t => f(t); };
// printing reveal of the opening print's blocks: each lands exactly on its beat
function rev(name, t) {
  const land = Object.fromEntries(PRINT)[name]; if (land === undefined) return 1;
  const d = name === 'key' ? KEY_REVEAL : REVEAL, u = (t - (land - d)) / d;
  return clamp(name === 'key' ? .22 + .78 * u + 1e-7 : u + 1e-7);
}
// the S3 sky reprint (rain sky → clear dawn sky) lands on T.clear
const clearRev = t => clamp((t - (T.clear - REVEAL)) / REVEAL + 1e-7);
// seal stamp p (0→1) that "lands" (scale back to 1) exactly at t0
const sealP = (t, t0) => clamp((t - (t0 - .11)) / .2 + 1e-7);

// ————————————————————————— camera —————————————————————————
const CAM = [   // [t0, t1, [cx, cy, z] at t1, ease]
  [0, T.red, [930, 528, 1.05], ss],
  [T.red, T.tear, [740, 492, 1.9], eio],
  [T.tear, T.breakout - .5, [1110, 205, 1.3], eio],                    // tilt up after the umbrella
  [T.breakout - .5, T.breakout - .125, [1160, 118, 1.75], eio],         // push in on the frame edge it is about to tear
  [T.breakout - .125, T.breakout, [1165, 113, 1.77], t => t],          // hold through the tear
  [T.breakout, T.v1, [SX[1] + 960, 540, .92], eio],                     // handscroll to view 1 (1 beat; the cubic start lingers on the torn strip)
  [T.v1, T.bounce, [SX[1] + 800, 480, 1.32], eio],                      // push in: arrives as the umbrella hits the ridge
  [T.bounce, T.s2a, [SX[1] + 900, 510, 1.02], ss],                       // ease back a touch as it lifts toward the eave
  [T.s2a, T.v2, [SX[2] + 960, 540, .93], eio],
  [T.v2, T.s3a, [SX[2] + 930, 505, 1.0], ss],
  [T.s3a, T.v3, [SX[3] + 960, 540, 1.0], eio],
  [T.v3, T.ma, [SX[3] + 960, 540, 1.0], t => 0],
  [T.ma, T.maEnd, [SX[3] + 960, 540, 1.004], t => t],                 // ma: a breath of a push (0.25 %/s), never a frozen frame
  [T.maEnd, T.catch, [SX[3] + 1440, 790, 2.35], eio],
  [T.catch, T.pullA, [SX[3] + 1440, 792, 2.36], ss],
  [T.pullA, T.pullB, [SX[3] + 960, 540, 1.0], eio],
  [T.pullB, DUR, [SX[3] + 960, 548, .95], ss],
];
function camera(t) {
  let p = [960, 540, 1];
  for (const [t0, t1, to, e, ey = e] of CAM) {
    if (t >= t1) { p = to; continue; }
    const u = e(seg(t, t0, t1)), uy = ey(seg(t, t0, t1));
    p = [lerp(p[0], to[0], u), lerp(p[1], to[1], uy), Math.exp(lerp(Math.log(p[2]), Math.log(to[2]), uy))]; break;
  }
  let [cx, cy, z] = p, rot = 0;
  // the handscroll breathes out while it rolls (the mount and the seams show), and back in as the next view lands
  for (const [a, c, A] of [[T.breakout, T.v1, .3], [T.s2a, T.v2, .3]]) if (t > a && t < c) z *= 1 - A * Math.pow(Math.sin(Math.PI * seg(t, a, c)), 1.5);
  // the tug: the umbrella blows inside out and the camera flinches in with it
  if (t >= T.tug && t < T.breakout) z *= 1 + .07 * Math.min(1, (t - T.tug) * 10) * Math.exp(-(t - T.tug) * 2.2);
  // the gust shakes the camera a little (smooth noise, on ones)
  const sh = clamp(seg(t, T.gust, T.gust + .3)) * (1 - seg(t, T.tear + .3, T.breakout));
  if (sh > 0) { cx += (Math.sin(t * 23.1) * .6 + Math.sin(t * 41.7) * .4) * 3.5 * sh; cy += (Math.sin(t * 19.3 + 1) * .6 + Math.sin(t * 37.9) * .4) * 3 * sh; }
  // the breakout knocks the whole sheet: a short jolt
  const jo = t > T.breakout ? Math.exp(-(t - T.breakout) * 7) * Math.sin((t - T.breakout) * 55) : 0;
  cy += jo * 8 / z; cx -= jo * 3 / z;   // ~8 px on screen
  return { cx, cy, z, rot };
}
const camM = c => [c.z, 0, 0, c.z, W / 2 - c.z * c.cx, H / 2 - c.z * c.cy];
const toScreen = (M, X, Y) => [M[0] * X + M[2] * Y + M[4], M[1] * X + M[3] * Y + M[5]];

// ————————————————————————— the woman (S0) —————————————————————————
const WOM = [720, deckY(720)], WS = 1.3;
const wk = (keys) => { const fs = [0, 1].map(j => monotone(keys.map(k => [k[0], k[1][j]]))); return t => [fs[0](t), fs[1](t)]; };
const W_HAND = wk([[0, [-13, -90]], [T.gust, [-13, -90]], [T.gust + .4, [-7, -100]], [T.tug, [3, -112]], [T.tear, [9, -118]], [T.tear + .25, [22, -134]], [T.tear + 1.2, [8, -106]], [DUR, [8, -106]]]);
const W_HAND2 = wk([[0, [10, -70]], [T.gust, [10, -70]], [T.gust + .4, [-3, -92]], [T.tug, [0, -104]], [T.tear, [5, -110]], [T.tear + .3, [16, -126]], [T.tear + 1.2, [-6, -96]], [DUR, [-6, -96]]]);
const W_LEAN = kf([[0, 0], [T.gust, 0], [T.tug - .25, .3], [T.tug, .06], [T.tear - .1, .14], [T.tear + .2, -.14], [T.tear + .8, .06], [DUR, .06]]);
function womanPose(t) {
  const tq = q8(t), wind = ss(seg(tq, T.gust - .2, T.gust + .2));
  const struggle = tq > T.tug && tq < T.tear ? Math.sin(tq * 8 * 2.1) * 2.5 : 0;
  const hand = W_HAND(tq), hand2 = W_HAND2(tq);
  return {
    lean: W_LEAN(tq), hand: [hand[0] + struggle, hand[1] - Math.abs(struggle)], hand2: [hand2[0] + struggle * .6, hand2[1]],
    sleeve: .1 + .9 * wind, hem: .15 + .85 * wind, step: tq > T.red && tq < T.gust ? (tq - T.red) * 1.333 : 0,
    x: WOM[0] - 22 * ss(seg(tq, T.red, T.gust)),
  };
}

// ————————————————————————— the child (S3) —————————————————————————
const C_L = wk([[0, [-10, -44]], [T.maEnd + .3, [-10, -44]], [T.reach, [-13, -120]], [T.catch - .2, [-9, -118]], [T.catch, [-6, -114]], [T.catch + .5, [-4, -100]], [DUR, [-4, -100]]]);
const C_R = wk([[0, [9, -46]], [T.maEnd + .4, [9, -46]], [T.reach, [-1, -122]], [T.catch, [1, -110]], [T.catch + .5, [3, -92]], [DUR, [3, -92]]]);
const C_LOOK = kf([[0, 0], [T.maEnd, 0], [T.maEnd + .6, 1], [T.catch, .9], [T.catch + .6, .5], [T.clear, .55], [T.clear + .5, 1], [DUR, 1]]);
const C_JOY = kf([[0, 0], [T.catch, 0], [T.catch + .3, .6], [T.clear, .6], [T.clear + .4, 1], [DUR, 1]]);
function childPose(t) {
  const tq = q8(t), dip = tq > T.catch ? Math.exp(-(tq - T.catch) * 7) * Math.sin((tq - T.catch) * 9) * 5 : 0;
  return { handL: C_L(tq), handR: C_R(tq), look: C_LOOK(tq), joy: C_JOY(tq), dy: Math.max(0, dip) };
}
const childWorld = (p, q) => [SX[3] + CHILD_AT[0] + q[0], CHILD_AT[1] + p.dy + q[1]];

// ————————————————————————— the umbrella —————————————————————————
const rotX = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const fromGrip = (g, rot, sc) => { const o = rotX([0, GRIP()[1] * sc], rot); return [g[0] - o[0], g[1] - o[1]]; };
const HELD_ROT = kf([[0, -.08], [T.gust, -.08], [T.tug - .2, .45], [T.tug, .62], [T.tear, .78]]);
const FLY_ROT = kf([[T.tear, .78], [T.breakout, 3.3], [T.v1, 5.0], [T.bounce, 6.4], [T.s2a, 8.2], [T.v2, 9.6], [T.s3a, 10.4], [T.v3, 11.9], [T.apex, 4 * Math.PI + .1]]);
const bez = (p0, p1, p2, p3, u) => { const m = 1 - u; return [0, 1].map(j => m * m * m * p0[j] + 3 * m * m * u * p1[j] + 3 * m * u * u * p2[j] + u * u * u * p3[j]); };
function heldByWoman(t) {
  const p = womanPose(t), tq = q8(t), rot = HELD_ROT(tq);
  const g = womanPoint(p.x, WOM[1], WS, p, p.hand), c = fromGrip(g, rot, WS);
  // straining (b6.67), a flat in-between drawing (b6.83), then fully inside out on b7 — held as a bowl for ~0.5 s
  let inv = 1;
  if (tq >= T.tug - .25) inv = tq < T.tug - .125 ? .55 : tq < T.tug ? .05 : tq < T.tug + .5 ? -1 + .05 * Math.sin(tq * 8 * 2.1) : -.85 + Math.sin(tq * 8 * 1.7) * .08;
  const flap = tq > T.tug ? (tq < T.tug + .5 ? .12 : .5) * (.5 + .5 * Math.sin(tq * 8 * 2.3)) : 0;
  return { x: c[0], y: c[1], rot, sc: WS, inv, spin: .3, flap };
}
const TEAR0 = heldByWoman(T.tear);
const P_BREAK = [1160, FR.y0];
const CATCH_POSE = childPose(T.catch);
const CATCH_ROT = 4 * Math.PI - .15, CATCH_SC = .8;
const CATCH_C = fromGrip(childWorld(CATCH_POSE, CATCH_POSE.handL), CATCH_ROT, CATCH_SC);
const S3W = (u, v) => [SX[3] + u, v];
function umb(t) {
  if (t < T.tear) return { ...heldByWoman(t), held: 'woman' };
  const sp = 7 * (t - T.tear);
  if (t >= T.catch) {
    const p = childPose(t), tq = q8(t), g = childWorld(p, p.handL);
    const settle = tq > T.catch ? Math.exp(-(tq - T.catch) * 5) * Math.sin((tq - T.catch) * 11) * .16 : 0;
    const rot = CATCH_ROT + settle + .3 * eio(seg(tq, T.clear, T.clear + .5)) + .15 * ss(seg(tq, T.catch, T.catch + .5));
    const c = fromGrip(g, rot, CATCH_SC);
    return { x: c[0], y: c[1], rot, sc: CATCH_SC, inv: 1, spin: .3, flap: 0, held: 'child' };
  }
  let x, y, sc = 1, inv = 1, rot = FLY_ROT(Math.min(t, T.apex)), flap = .5 + .5 * Math.sin(t * 19);
  if (t < T.breakout) {
    const u = seg(t, T.tear, T.breakout), uu = u * (.55 + .45 * u);
    [x, y] = bez([TEAR0.x, TEAR0.y], [TEAR0.x + 70, TEAR0.y - 170], [1010, 200], P_BREAK, uu);
    inv = lerp(-.85, 1, ss(seg(t, b(9) - .14, b(9)))) + (t > b(9) ? Math.exp(-(t - b(9)) * 8) * Math.sin((t - b(9)) * 40) * .25 : 0);
    sc = lerp(WS, 1.1, u);
  } else if (t < T.v1) {
    const u = seg(t, T.breakout, T.v1);
    [x, y] = bez(P_BREAK, [1160 + 180 * 1.25, FR.y0 - 190], [SX[1] + 130, 70], [SX[1] + 380, 230], u); sc = lerp(1.1, 1.4, u);
  } else if (t < T.s2a) {
    x = monotone([[T.v1, SX[1] + 380], [T.bounce, SX[1] + 820], [T.s2a, SX[1] + 1450]])(t);
    if (t < T.bounce) { const u = seg(t, T.v1, T.bounce); y = 230 + 290 * u * u; }
    else { const v = seg(t, T.bounce, T.s2a); y = 520 - 280 * (2 * v - v * v); }
    sc = lerp(1.4, 1.8, ss(seg(t, T.v1, T.bounce))); flap = t > T.bounce ? Math.exp(-(t - T.bounce) * 9) : flap * .6;
  } else if (t < T.v2) {
    const u = eio(seg(t, T.s2a, T.v2));
    [x, y] = bez([SX[1] + 1450, 230], [SX[1] + 1900, 110], [SX[2] + 420, 230], [SX[2] + 800, 330], seg(t, T.s2a, T.v2)); sc = lerp(1.8, 3.0, u);
  } else if (t < T.s3a) {
    const u = seg(t, T.v2, T.s3a), bump = Math.max(0, Math.sin(clamp((t - (T.splash - .35)) / .7) * Math.PI));
    x = SX[2] + lerp(800, 1150, u); y = lerp(330, 292, u) - 46 * bump - 10 * Math.sin(u * 6); sc = lerp(3.0, 3.1, u); flap = .35 + .3 * Math.sin(t * 9);
  } else if (t < T.v3) {
    const u = seg(t, T.s3a, T.v3);
    [x, y] = bez([SX[2] + 1150, 292], [SX[2] + 1700, 60], [SX[3] - 260, 230], S3W(300, 380), u); sc = lerp(3.1, .8, eo(u));
  } else if (t < T.apex) {
    const u = eo(seg(t, T.v3, T.apex));
    [x, y] = bez(S3W(300, 380), S3W(620, 240), S3W(1000, 140), S3W(1180, 150), u); sc = .8; flap = .3 * (1 - u);
  } else if (t < T.maEnd) {
    const u = seg(t, T.apex, T.maEnd);
    x = SX[3] + 1180 + 12 * u; y = 150 - 5 * Math.sin(u * Math.PI); sc = .8; rot = 4 * Math.PI + .1 - .08 * Math.sin(u * Math.PI); flap = 0;
  } else {
    // falling leaf: swings that cross the centre on every beat, dying out into the child's hands
    const u = seg(t, T.maEnd, T.catch), beats = (t - T.maEnd) / BEAT, A = 110 * Math.pow(1 - u, 1.15);
    const swing = A * Math.sin(Math.PI * beats), start = [SX[3] + 1192, 150];
    x = lerp(start[0], CATCH_C[0], ss(u)) + swing; y = lerp(start[1], CATCH_C[1], eio(u)) - 26 * Math.abs(Math.sin(Math.PI * beats)) * (1 - u);
    rot = lerp(4 * Math.PI + .1, CATCH_ROT, ss(u)) + .5 * (1 - u) * Math.cos(Math.PI * beats); sc = CATCH_SC; flap = .15 * (1 - u);
  }
  const view = t < T.v3 ? .28 + .3 * Math.sin(t * 3.3) : .22 * (1 - seg(t, T.v3, T.apex));
  return { x, y, rot, sc, inv, spin: sp, flap, view: Math.max(0, view), held: 'free' };
}
function drawUmb(x, U, pass = 'all') {
  if (pass !== 'all') return umbrella(x, U.x, U.y, U.rot, U.sc, U, pass);
  for (const ps of ['wood', 'red', 'pale', 'key']) umbrella(x, U.x + (ps === 'red' ? REG[3][0] : ps === 'wood' ? REG[2][0] : 0), U.y + (ps === 'red' ? REG[3][1] : ps === 'wood' ? REG[2][1] : 0), U.rot, U.sc, U, ps);
}

// ————————————————————————— cartouches & seals —————————————————————————
const CART_T = [[T.key - .4, T.red], [b(10.25), T.v1], [b(13), T.v2], [T.v3, T.v3seal]];
function cartBox(i) { const c = SHEETS[i].cart; const size = c.size, w = c.w; const sh = c.series ? [...c.series].length * 27 * 1.06 + 20 : 0, th = [...c.title].length * size * 1.06 + 26; return { x0: c.x - w / 2, y0: c.y, w, h: sh + th }; }
function drawCart(x, i, t) {
  const c = SHEETS[i].cart, [t0, ts] = CART_T[i];
  const p = i === 0 ? rev('key', t) : clamp((t - t0) / .35);
  if (p <= 0) return;
  stampFn(x, y => cartouche(y, c.x, c.y, c.title, { series: c.series, w: c.w, size: c.size }), p, [0, -14], 1);
  const B = cartBox(i), sp = i === 0 ? rev('red', t) : sealP(t, ts);
  if (i === 0) { stampFn(x, y => drawSeal(y, c.seal, c.x, B.y0 + B.h + 44, 54, 1, { seed: 5, rot: .04, normal: true }), sp, SHIFT[3], 1); }
  else drawSeal(x, c.seal, c.x, B.y0 + B.h + 40, 50, sp, { seed: i + 5, rot: (hash(i) - .5) * .08, normal: true });
}
const FINAL_SEAL = [1640, 520];

// ————————————————————————— mount (the long scroll) —————————————————————————
const BAND = [-520, 1600], X0 = -560, X1 = SX[3] + W + 560;
function drawMount(M) {
  ctx.save(); ctx.setTransform(...M);
  ctx.fillStyle = PAL.mount; ctx.fillRect(X0, BAND[0], X1 - X0, BAND[1] - BAND[0]);
  ctx.globalAlpha = .5; ctx.globalCompositeOperation = 'multiply';
  for (let X = X0; X < X1; X += W) for (let Y = BAND[0]; Y < BAND[1]; Y += H) ctx.drawImage(TX.paper, X, Y);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = PAL.mountD; ctx.fillRect(X0, BAND[0], X1 - X0, 40); ctx.fillRect(X0, BAND[1] - 40, X1 - X0, 40);
  for (const sx of SX) { ctx.fillStyle = 'rgba(70,50,25,.16)'; ctx.fillRect(sx + 6, 8, W, H); ctx.fillStyle = 'rgba(70,50,25,.1)'; ctx.fillRect(sx + 12, 14, W, H); }
  ctx.restore();
}

// ————————————————————————— sheets —————————————————————————
function sheetM(M, i) { return [M[0], M[1], M[2], M[3], M[4] + M[0] * SX[i], M[5] + M[3] * 0]; }
const clipFrame = x => { x.beginPath(); x.rect(FR.x0, FR.y0, FR.x1 - FR.x0, FR.y1 - FR.y0); x.clip(); };
function border(x, i, t) {
  x.strokeStyle = PAL.sumi; x.lineCap = 'butt';
  const gap = i === 0 && t >= T.breakout ? [TEAR_X[0], TEAR_X[1]] : null;
  const rect = (x0, y0, x1, y1, lw) => {
    x.lineWidth = lw; x.beginPath();
    if (gap) { x.moveTo(x0, y0); x.lineTo(gap[0], y0); x.moveTo(gap[1], y0); x.lineTo(x1, y0); } else { x.moveTo(x0, y0); x.lineTo(x1, y0); }
    x.lineTo(x1, y1); x.lineTo(x0, y1); x.lineTo(x0, y0); x.stroke();
  };
  rect(FR.x0, FR.y0, FR.x1, FR.y1, 3.4); rect(FR.x0 - 9, FR.y0 - 9, FR.x1 + 9, FR.y1 + 9, 1.3);
}
function rainFor(i, t) {
  if (i === 0) { if (t < T.red - .1) return null; return { dens: clamp((t - T.red + .1) / .3), tilt: -.16 * ss(seg(t, T.gust - .1, T.gust + .3)), base: -1.68 }; }
  if (i === 1 || i === 2) return { dens: 1, tilt: 0, base: -1.86 };
  const cl = clearRev(t); if (cl >= 1) return null; return { dens: 1 - cl, tilt: 0, base: -1.7 };
}
function drawRain(x, i, t) {
  const r = rainFor(i, t); if (!r) return;
  let fr = q12(t), creep = 0; if (i === 3 && t >= T.ma && t < T.maEnd) { fr = q12(T.ma); creep = (q8(t) - T.ma) * 16; }   // ma: the rain hangs, creeping on eighths
  const a = r.base + r.tilt;
  if (creep) { x.save(); x.translate(-Math.cos(a) * creep, -Math.sin(a) * creep); }
  rain(x, fr + i * 1000, [FR.x0, FR.y0 - 40, FR.x1, FR.y1], { dens: r.dens, sets: [[a, 230, 2.0, PAL.sumi, .5], [a + .1, 120, 1.4, PAL.greyD, .45], [a + .05, 100, 1.6, '#cfc9b6', .45]] });
  if (creep) x.restore();
}
function drawSheet(M, i, t, U) {
  const Ms = sheetM(M, i);
  // cull sheets that are off screen
  const a = toScreen(Ms, 0, 0), c = toScreen(Ms, W, H); if (c[0] < -20 || a[0] > W + 20) return false;
  ctx.save(); ctx.setTransform(...Ms);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  if (i % 2) { ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(TX.paper, 0, 0); ctx.restore(); } else ctx.drawImage(TX.paper, 0, 0);
  ctx.save(); clipFrame(ctx);
  if (i === 0) paintS0(ctx, t, U);
  if (i === 1) ctx.drawImage(S1c, 0, 0, W, H);
  if (i === 2) paintS2(ctx, t, 'base');
  if (i === 3) paintS3(ctx, t, 'base');
  ctx.restore();
  border(ctx, i, t);
  drawCart(ctx, i, t);
  if (i === 3) drawSeal(ctx, '雨晴', FINAL_SEAL[0], FINAL_SEAL[1], 92, sealP(t, T.seal), { seed: 11, rot: -.03 });
  ctx.restore();
  if (i === 0 && t >= T.breakout) tornStrip(ctx, t);
  ctx.restore();
  return true;
}
function drawSheetOver(M, i, t, U) {
  const Ms = sheetM(M, i); const a = toScreen(Ms, 0, 0), c = toScreen(Ms, W, H); if (c[0] < -20 || a[0] > W + 20) return;
  ctx.save(); ctx.setTransform(...Ms);
  ctx.save(); clipFrame(ctx);
  if (i === 2) paintS2(ctx, t, 'over', U);
  if (i === 3) paintS3(ctx, t, 'over');
  if (i === 0 && t >= T.red - .2) stampFn(ctx, x => willowS0(x, t), rev('wood', t), SHIFT[2], 1);
  if (i === 1) { ctx.drawImage(EAVE, 0, 0); eaveDrips(ctx, t); lantern(ctx, t); }
  drawRain(ctx, i, t);
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); ctx.drawImage(TX.fiber, 0, 0); ctx.restore();
  ctx.restore();
}

// —— S0: the opening print, block by block ——
function willowS0(x, t) {
  const tq = q8(t), wind = ss(seg(tq, T.gust - .1, T.gust + .3)) * (1 - .4 * ss(seg(tq, T.tear, T.breakout))), ph = tq * 3;
  for (const pass of ['wood', 'key']) { x.save(); if (pass === 'wood') x.translate(...REG[2]); willow(x, WILLOW, wind + .06 * Math.sin(tq * 2), ph, pass); x.restore(); }
}
function paintS0(x, t, U) {
  const L = (name, g) => stampLayer(x, S0b[name], rev(name === 'rail' ? 'wood' : name === 'railKey' ? 'key' : name, t), REG[g], SHIFT[g]);
  L('sky', 4); L('water', 1); L('wood', 2); L('key', 0);
  // the woman (and the umbrella while the print is still being made) — each colour with its own block
  const p = womanPose(t), printing = t < T.red + .01;
  const blk = { blue: ['water', 1], wood: ['wood', 2], skin: ['wood', 2], pale: ['wood', 2], red: ['red', 3], key: ['key', 0] };
  for (const pass of ['blue', 'wood', 'skin', 'pale', 'key']) {
    const [bn, g] = blk[pass];
    stampFn(x, y => { y.save(); y.translate(...REG[g]); woman(y, p.x, WOM[1], WS, p, pass); y.restore(); }, rev(bn, t), SHIFT[g], 2);
  }
  if (printing && U.held === 'woman') for (const pass of ['wood', 'red', 'pale', 'key']) {
    const [bn, g] = blk[pass];
    stampFn(x, y => { y.save(); y.translate(...REG[g]); umbrella(y, U.x, U.y, U.rot, U.sc, U, pass); y.restore(); }, rev(bn, t), SHIFT[g], 2);
  }
  L('rail', 2); L('railKey', 0);
}
// —— S1: a paper lantern hanging from the foreground eave, swinging in the wind (8 fps) ——
function lantern(x, t) {
  const tq = q8(t), ang = .22 + .12 * Math.sin(tq * 5.1) + .05 * Math.sin(tq * 11.3), px = 1250, py = 104, L = 110;
  x.save(); x.translate(px, py); x.rotate(-ang);
  x.strokeStyle = PAL.sumi; x.lineWidth = 2; x.beginPath(); x.moveTo(0, 0); x.lineTo(0, L); x.stroke();
  x.translate(...REG[2]); x.fillStyle = PAL.ochreL; x.beginPath(); x.ellipse(0, L + 62, 46, 64, 0, 0, TAU); x.fill();
  x.translate(-REG[2][0], -REG[2][1]);
  x.fillStyle = PAL.sumi; x.fillRect(-26, L - 4, 52, 14); x.fillRect(-26, L + 116, 52, 14);
  x.lineWidth = 1.4; for (let k = 1; k < 9; k++) { const y = L + 62 - 64 + k * 14.2, w = 46 * Math.sqrt(Math.max(0, 1 - Math.pow((y - L - 62) / 64, 2))); x.beginPath(); x.moveTo(-w, y); x.quadraticCurveTo(0, y + 4, w, y); x.stroke(); }
  x.lineWidth = 2.2; x.beginPath(); x.ellipse(0, L + 62, 46, 64, 0, 0, TAU); x.stroke();
  x.restore();
}
// —— S2: the crest. Claws and spray are alive at 12 fps; a few claws sit in front of the umbrella ——
function crestAt(X) { for (let i = 1; i < CREST.length; i++) if (CREST[i][0] >= X) { const a = CREST[i - 1], c = CREST[i], u = (X - a[0]) / (c[0] - a[0] || 1); return [X, lerp(a[1], c[1], u), Math.atan2(c[1] - a[1], c[0] - a[0])]; } return CREST[CREST.length - 1]; }
function paintS2(x, t, pass, U) {
  const f = q12(t), st = { fill: PAL.white, ink: PAL.prusD, lw: 2.2 }, st2 = { fill: '#c9d9e4', ink: PAL.prusD, lw: 1.8 };
  const splash = Math.max(0, 1 - Math.abs(t - T.splash) / .45) * (t > T.splash - .2 ? 1 : 0);
  if (pass === 'base') {
    x.drawImage(S2c, 0, 0, W, H);
    // foam band and claws along the crest (x 420..1600)
    for (let k = 0; k < 17; k++) {
      const R = mulberry(710 + k * 13), X = 420 + k * 82 + (R() - .5) * 30, [px, py, ang] = crestAt(X), jig = Math.sin(f * .55 + k * 1.7) * .08;
      fclaw(x, px - 4, py - 6, ang - Math.PI / 2 + .5 + jig, (70 + R() * 40) * (1 + splash * .4 * (Math.abs(X - 960) < 260)), 22, 1.15 + R() * .3, 1, st2, R);
    }
    x.fillStyle = PAL.white; x.beginPath();
    const top = CREST.filter(q => q[0] > 380 && q[0] < 1660), inner = top.map(([a, c], i) => [a + 4, c + 16 + 8 * Math.sin(i * .9)]);
    x.moveTo(...top[0]); top.forEach(q => x.lineTo(...q)); inner.reverse().forEach(q => x.lineTo(...q)); x.closePath(); x.fill();
    x.strokeStyle = PAL.prusD; x.lineWidth = 2.6; x.stroke();
    for (let k = 0; k < 15; k++) {
      const R2 = mulberry(770 + k * 17), X = 450 + k * 92 + (R2() - .5) * 26, [px, py, ang] = crestAt(X), jig = Math.sin(f * .7 + k * 2.3) * .09;
      if (Math.abs(X - 840) < 170) continue;   // these sit in front of the umbrella (drawn in the over pass)
      fclaw(x, px, py, ang - Math.PI / 2 + .62 + jig, (60 + R2() * 46) * (1 + splash * .5 * (Math.abs(X - 960) < 260)), 17, 1.2 + R2() * .3, 2, st, R2);
    }
    // spray clusters, re-thrown every 12th of a second
    const R3 = mulberry(90 + f % 3);
    for (let c = 0; c < 7; c++) { const [px, py] = crestAt(520 + c * 190); spray(x, px + 30 + R3() * 60, py - 70 - R3() * 90, 1, R3); }
    // plovers
    for (let k = 0; k < 3; k++) { const tq = q8(t), fx = 1580 - k * 120 - (tq - T.s2a) * 60, fy = 180 + k * 46 + Math.sin(k * 2) * 20; plover(x, fx, fy, 1.6 - k * .2, tq * 1.6 + k * .33); }
  } else {
    // claws in front of the umbrella + the splash burst
    for (let k = 0; k < 15; k++) {
      const R2 = mulberry(770 + k * 17), X = 450 + k * 92 + (R2() - .5) * 26, [px, py, ang] = crestAt(X), jig = Math.sin(f * .7 + k * 2.3) * .09;
      if (Math.abs(X - 840) >= 170) continue;
      fclaw(x, px, py, ang - Math.PI / 2 + .62 + jig, (60 + R2() * 46) * (1 + splash * .6), 17, 1.2 + R2() * .3, 2, st, R2);
    }
    // fingers hanging from the curling lip, hooking back toward the wave
    for (let k = 0; k < 6; k++) { const R5 = mulberry(880 + k * 7), q = CREST[CREST.length - 1 - k * 3], jig = Math.sin(f * .8 + k) * .07; fclaw(x, q[0] - 4, q[1], 1.95 + k * .12 + jig, 70 + R5() * 40, 18, 1.2, 2, st, R5); }
    if (splash > 0) { const R4 = mulberry(300 + f); for (let c = 0; c < 9; c++) { const a = -Math.PI / 2 + (R4() - .5) * 2.2, d = 60 + R4() * 260 * splash; spray(x, 960 + Math.cos(a) * d, 390 + Math.sin(a) * d, .8 + splash * .7, R4); } }
  }
}
// —— S3: the mountain, the bay and the child ——
function paintS3(x, t, pass) {
  const p = childPose(t);
  if (pass === 'base') {
    x.drawImage(S3sky.rain, REG[4][0], REG[4][1], W, H);
    const cr = clearRev(t); if (cr > 0) stampSweep(x, S3sky.dawn, cr, REG[4], [6, -3]);
    x.drawImage(S3c, 0, 0, W, H);
    for (const ps of ['blue', 'wood', 'skin', 'key']) { x.save(); x.translate(...REG[ps === 'blue' ? 1 : ps === 'key' ? 0 : 2]); child(x, CHILD_AT[0], CHILD_AT[1] + p.dy, 1, p, ps, 'body'); x.restore(); }
  } else {
    for (const ps of ['blue', 'skin', 'key']) { x.save(); x.translate(...REG[ps === 'blue' ? 1 : ps === 'key' ? 0 : 2]); child(x, CHILD_AT[0], CHILD_AT[1] + p.dy, 1, p, ps, 'hands'); x.restore(); }
  }
}

// ————————————————————————— the torn corner (the frame is a real thing) —————————————————————————
// On the breakout the umbrella rips a strip out of the top border. The strip stays hinged at its right end and curls up off the
// sheet like a peeled paper tab, fluttering on eighths; behind it the hole shows the mount.
const TEAR_X = [1100, 1214], TEAR_Y = [FR.y0 - 17, FR.y0 + 7];   // strip centre ≈ y 33: main line at +5, outer line at −4
const TEAR_EDGE = (() => { const R = mulberry(404), top = [], bot = [];
  for (let k = 0; k <= 14; k++) { const X = lerp(TEAR_X[0], TEAR_X[1], k / 14); top.push([X, TEAR_Y[0] + (R() - .5) * 5]); bot.push([X, TEAR_Y[1] + (R() - .3) * 7]); }
  return { top, bot }; })();
function tornStrip(x, t) {
  const tq = t - T.breakout < .25 ? t : q8(t), u = tq - T.breakout;
  // lift: snaps up past 90° with an overshoot, then settles and flutters in the wind
  const lift = 1.25 * (1 - Math.exp(-u * 14) * Math.cos(u * 18)) + .1 * Math.sin(tq * 8 * 1.9) * Math.min(1, u * 3);
  // the hole: mount colour with a shadowed, fibrous edge
  x.save();
  x.fillStyle = PAL.mountD; x.beginPath(); TEAR_EDGE.top.forEach((q, k) => k ? x.lineTo(...q) : x.moveTo(...q)); TEAR_EDGE.bot.slice().reverse().forEach(q => x.lineTo(...q)); x.closePath(); x.fill();
  x.strokeStyle = '#fbf6e9'; x.lineWidth = 1.3; x.globalAlpha = .8; x.stroke(); x.globalAlpha = 1;
  // the strip: N segments from the hinge leftwards, each bent a little more (a curl)
  const N = 10, Lseg = (TEAR_X[1] - TEAR_X[0]) / N, hinge = [TEAR_X[1], (TEAR_Y[0] + TEAR_Y[1]) / 2], half = (TEAR_Y[1] - TEAR_Y[0]) / 2;
  const P = [hinge]; let th = Math.PI;
  for (let k = 0; k < N; k++) { th = Math.PI + lift * (.35 + 1.3 * (k + 1) / N); const q = P[P.length - 1]; P.push([q[0] + Math.cos(th) * Lseg, q[1] + Math.sin(th) * Lseg]); }
  const nrm = k => { const a = P[Math.max(0, k - 1)], c = P[Math.min(N, k + 1)], dx = c[0] - a[0], dy = c[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dy / L, -dx / L]; };
  const off = (w) => P.map((q, k) => { const n = nrm(k); return [q[0] + n[0] * w, q[1] + n[1] * w]; });
  const A = off(-half), B = off(half);
  // cast shadow on the sheet
  x.fillStyle = 'rgba(40,30,15,.22)'; x.beginPath(); A.forEach((q, k) => k ? x.lineTo(q[0] + 5, q[1] + 7) : x.moveTo(q[0] + 5, q[1] + 7)); B.slice().reverse().forEach(q => x.lineTo(q[0] + 5, q[1] + 7)); x.closePath(); x.fill();
  x.fillStyle = PAL.paper; x.beginPath(); A.forEach((q, k) => k ? x.lineTo(...q) : x.moveTo(...q)); B.slice().reverse().forEach(q => x.lineTo(...q)); x.closePath(); x.fill();
  x.strokeStyle = 'rgba(120,95,60,.55)'; x.lineWidth = 1; x.stroke();
  // the printed border lines carried on the strip (main line near the inner edge, the thin outer line near the outer edge)
  x.strokeStyle = PAL.sumi; x.lineCap = 'butt';
  for (const [w, lw] of [[5, 3.4], [-4, 1.3]]) { const L = off(w); x.lineWidth = lw; x.beginPath(); L.forEach((q, k) => k ? x.lineTo(...q) : x.moveTo(...q)); x.stroke(); }
  x.restore();
}

// ————————————————————————— view 1: a foreground eave cutting across the top-right corner —————————————————————————
const EA = [1080, FR.y0 - 20], EB = [FR.x1 + 20, 480];
const EU = (() => { const dx = EB[0] - EA[0], dy = EB[1] - EA[1], L = Math.hypot(dx, dy); return [dx / L, dy / L, L]; })();
const EN = [-EU[1], EU[0]];   // normal, pointing away from the eave (down-left)
const eP = (s, n) => [EA[0] + EU[0] * s + EN[0] * n, EA[1] + EU[1] * s + EN[1] * n];
const TILE_S = Array.from({ length: Math.ceil(EU[2] / 38) + 2 }, (_, k) => 12 + k * 38);
const EAVE = (() => {
  const draw = { wood(x) {   // soffit: dark boards and rafters running back from the edge
      x.fillStyle = PAL.woodD; x.beginPath(); x.moveTo(...eP(-200, 0)); x.lineTo(...eP(EU[2] + 200, 0)); x.lineTo(...eP(EU[2] + 200, -1200)); x.lineTo(...eP(-200, -1200)); x.fill();
      x.fillStyle = PAL.wood; for (let s = -10; s < EU[2] + 60; s += 52) { x.beginPath(); x.moveTo(...eP(s, -24)); x.lineTo(...eP(s + 15, -24)); x.lineTo(...eP(s + 15, -900)); x.lineTo(...eP(s, -900)); x.fill(); }
    },
    grey(x) {   // the tiled fascia band and the round tile ends
      x.fillStyle = '#6d6c66'; x.beginPath(); x.moveTo(...eP(-200, -26)); x.lineTo(...eP(EU[2] + 200, -26)); x.lineTo(...eP(EU[2] + 200, 2)); x.lineTo(...eP(-200, 2)); x.fill();
      x.fillStyle = PAL.greyL; for (const s of TILE_S) { const c = eP(s, 4); x.beginPath(); x.arc(c[0], c[1], 15, 0, TAU); x.fill(); }
    },
    key(x) {
      x.strokeStyle = PAL.sumi; x.lineWidth = 3; x.beginPath(); x.moveTo(...eP(-200, -26)); x.lineTo(...eP(EU[2] + 200, -26)); x.stroke();
      x.lineWidth = 2; x.beginPath(); x.moveTo(...eP(-200, 2)); x.lineTo(...eP(EU[2] + 200, 2)); x.stroke();
      x.lineWidth = 1.6; for (let s = -10; s < EU[2] + 60; s += 52) for (const o of [0, 15]) { x.beginPath(); x.moveTo(...eP(s + o, -26)); x.lineTo(...eP(s + o, -900)); x.stroke(); }
      for (const s of TILE_S) { const c = eP(s, 4); x.lineWidth = 2.4; x.beginPath(); x.arc(c[0], c[1], 15, 0, TAU); x.stroke(); x.fillStyle = PAL.sumi; x.beginPath(); x.arc(c[0], c[1], 4.2, 0, TAU); x.fill(); x.lineWidth = 1.2; x.beginPath(); x.arc(c[0], c[1], 9, 0, TAU); x.stroke(); }
    } };
  const out = mk(), o = out.getContext('2d');
  [['wood', 2, .14], ['grey', 1, .1], ['key', 0, 0]].forEach(([k, g, gr], i) => {
    const c = mk(), y = c.getContext('2d'); draw[k](y); inkify(c, { speck: k === 'key' ? .1 : .25, grain: gr, gx: i * 90, baren: gr ? .3 : 0, bx: i * 70 - 60, by: 40 });
    o.drawImage(c, REG[g][0], REG[g][1]);
  });
  return out;
})();
// rain running off the tile ends, re-drawn at 12 fps
function eaveDrips(x, t) {
  const f = q12(t), R = mulberry(500 + f);
  x.save(); x.strokeStyle = rgba(PAL.sumi, .55); x.lineWidth = 1.6; x.beginPath();
  for (const s of TILE_S) { const c = eP(s, 19); for (let k = 0; k < 2; k++) { const y0 = c[1] + R() * 140, L = 10 + R() * 24; x.moveTo(c[0] + (R() - .5) * 4, y0); x.lineTo(c[0] + (R() - .5) * 4, y0 + L); } }
  x.stroke(); x.restore();
}

// ————————————————————————— frame —————————————————————————
window.DUR = DUR;
window.render = t => {
  t = Math.max(0, Math.min(DUR - 1e-6, t));
  const cam = camera(t), M = camM(cam), U = umb(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#7d6c4f'; ctx.fillRect(0, 0, W, H);
  drawMount(M);
  for (let i = 0; i < 4; i++) drawSheet(M, i, t, U);
  if (!(U.held === 'woman' && t < T.red + .01)) { ctx.save(); ctx.setTransform(...M); drawUmb(ctx, U); ctx.restore(); }
  for (let i = 0; i < 4; i++) drawSheetOver(M, i, t, U);
};

// ————————————————————————— texts (for readcheck) —————————————————————————
window.TEXTS = t => {
  const M = camM(camera(t)), out = [];
  for (let i = 0; i < 4; i++) {
    const c = SHEETS[i].cart, [t0] = CART_T[i]; if (t < t0) continue;
    const B = cartBox(i), sh = c.series ? [...c.series].length * 27 * 1.06 + 20 : 0;
    const box = (y0, y1) => { const a = toScreen(sheetM(M, i), B.x0, y0), d = toScreen(sheetM(M, i), B.x0 + B.w, y1); return { x0: a[0], y0: a[1], x1: d[0], y1: d[1] }; };
    if (c.series) out.push({ id: `tab${i}`, text: c.series, ...box(B.y0, B.y0 + sh) });
    out.push({ id: `title${i}`, text: c.title, ...box(B.y0 + sh, B.y0 + B.h) });
  }
  return out;
};

// ————————————————————————— probe (for the cue check) —————————————————————————
window.PROBE = t => {
  const U = umb(t), cam = camera(t), p = childPose(t);
  const grip = childWorld(p, p.handL), cu = fromGrip(grip, U.rot, U.sc);
  return {
    rev: Object.fromEntries(PRINT.map(([k]) => [k, rev(k, t)])), held: U.held, umb: [U.x, U.y], inv: U.inv, cam: [cam.cx, cam.cy, cam.z],
    gust: ss(seg(q8(t), T.gust - .2, T.gust + .2)), frozen: t >= T.ma && t < T.maEnd, handL: p.handL, apexD: Math.hypot(U.x - SX[3] - 1180, U.y - 150), clear: clearRev(t), seal: [sealP(t, T.v1), sealP(t, T.v2), sealP(t, T.v3seal), sealP(t, T.seal)],
    catchDist: Math.hypot(U.x - cu[0], U.y - cu[1]), breakY: U.y - FR.y0, bounceY: U.y,
  };
};

// ————————————————————————— events for the mixer —————————————————————————
const EV = [{ t: 0, type: 'meta', bpm: BPM, beat: BEAT, beats: BEATS, clap: CLAP, roll: ROLL }];
const E = (t, type, o = {}) => EV.push({ t: Math.round(t * 1e4) / 1e4, type, ...o });
E(0, 'clack');
for (const [k, tl] of PRINT) { const d = k === 'key' ? KEY_REVEAL : REVEAL; E(tl - d, 'baren', { d, k }); E(tl, 'land', { k }); }
E(T.red, 'rain_on', { sheet: 0 }); E(T.gust, 'gust'); E(b(5.5), 'step'); E(b(6), 'step');
E(T.tug, 'tug'); E(T.tug + .125, 'flap', { v: .9 }); E(T.tug + .375, 'flap', { v: .75 }); E(T.tear, 'tear'); E(b(9), 'pop'); E(T.breakout, 'breakout');
for (let k = 0; k < 10; k++) E(T.tear + .1 + k * .375, 'flap', { v: 1 - k * .07 });
E(T.breakout, 'slide', { d: T.v1 - T.breakout }); E(T.breakout + .19, 'flap', { v: .55 }); E(T.s2a, 'slide', { d: T.v2 - T.s2a }); E(T.s3a, 'slide', { d: T.v3 - T.s3a });
E(CART_T[1][0], 'cart'); E(CART_T[2][0], 'cart'); E(CART_T[3][0], 'cart');
E(T.red, 'seal', { small: 1 }); E(T.v1, 'seal', { small: 1 }); E(T.v2, 'seal', { small: 1 }); E(T.v3seal, 'seal', { small: 1 });
E(T.bounce, 'bounce'); E(T.v2, 'wave'); E(T.splash, 'splash');
E(T.ma, 'ma'); E(T.maEnd, 'ma_end'); E(b(20.5), 'leaf'); E(b(21.5), 'leaf'); E(T.reach, 'reach'); E(T.catch, 'catch');
E(T.clear - REVEAL, 'baren', { d: REVEAL, k: 'dawn' }); E(T.clear, 'clear'); E(T.seal, 'seal', { big: 1 });
window.EV = EV;
if (QS.has('t')) window.render(+QS.get('t'));
window.READY = true;
