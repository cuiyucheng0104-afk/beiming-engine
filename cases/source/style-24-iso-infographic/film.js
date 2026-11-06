// 一封信的旅程 — story state, camera, overlays. Everything is a pure function of t.
import { Iso, PAL, tri, hex, mix, clamp, lerp, seg, ss, eo, eio, back, hash, TAU, C30, S30, cutLine, ring, inset, ICON, haloText, person, FONT } from './engine.js';
import { T, DUR, BEAT, STAGES, NISO, KM_PER_ICON, isoT, events } from './timeline.js';
import * as W from './world.js';
const { COL, TR, ENV } = W;
export { DUR, events };

const ei2 = u => clamp(u) * clamp(u);
const hopP = (a, b2, u, h) => [lerp(a[0], b2[0], u), lerp(a[1], b2[1], u), lerp(a[2], b2[2], u) + 4 * h * u * (1 - u)];
const bounce = (t, t0, amp = .22) => { const u = (t - t0) / .3; return u > 0 && u < 1 ? amp * Math.abs(Math.sin(u * Math.PI * 2)) * (1 - u) : 0; };
const toWorld = (o, rot, p) => { const c = Math.cos(rot), s = Math.sin(rot); return [o[0] + p[0] * c - p[1] * s, o[1] + p[0] * s + p[1] * c, (o[2] || 0) + p[2]]; };

// ---------- vehicles ----------
export function truckAt(t) {
  if (t < T.TRUCKGO) { const p = W.polyAt(W.TRUCK_PATH, W.TRUCK_L, 0); return { x: p[0], y: p[1], rot: 0 }; }
  const u = eio(seg(t, T.TRUCKGO, T.TRUCKARR)), p = W.polyAt(W.TRUCK_PATH, W.TRUCK_L, u), q = W.polyAt(W.TRUCK_PATH, W.TRUCK_L, Math.min(1, u + .04));
  const rot = u > .97 ? W.polyAt(W.TRUCK_PATH, W.TRUCK_L, .97)[3] : Math.atan2(q[1] - p[1], q[0] - p[0]);
  return { x: p[0], y: p[1], rot };
}
const L = W.FLIGHT_L, LT = L[L.length - 1];
const sAt = (pt) => { let best = 0, bd = 1e9; for (let i = 0; i < W.FLIGHT.length; i++) { const d = Math.hypot(W.FLIGHT[i][0] - pt[0], W.FLIGHT[i][1] - pt[1]); if (d < bd) { bd = d; best = i; } } return L[best]; };
const S_LIFT = sAt([57, 35.5]), S_TOUCH = sAt([113, -27]);
export function planeAt(t) {
  let s;
  if (t < T.ROLL) s = 0;
  else if (t < T.LIFT) s = S_LIFT * ei2(seg(t, T.ROLL, T.LIFT));
  else if (t < T.TOUCH) { const u = seg(t, T.LIFT, T.TOUCH); s = lerp(S_LIFT, S_TOUCH, u * .82 + ss(u) * .18); }
  else s = lerp(S_TOUCH, LT, eo(seg(t, T.TOUCH, T.TOUCH + .3)));
  const u = s / LT, p = W.polyAt(W.FLIGHT, L, u), q = W.polyAt(W.FLIGHT, L, Math.min(1, u + .01));
  let rot = Math.atan2(q[1] - p[1], q[0] - p[0]); if (u > .985) rot = 0;
  const gear = t < T.LIFT + .15 ? 1 : t > T.TOUCH - .35 ? 1 : clamp(1 - (t - T.LIFT - .15) / .25) + clamp((t - (T.TOUCH - .6)) / .25);
  return { x: p[0], y: p[1], z: p[2], rot, gear: clamp(gear) };
}
export const BIKE_OFF = [T.CLACK + BEAT / 4, T.CLACK + BEAT / 4 + .75];   // 13.125–13.875: job done, the courier turns and rides away before the wall slides off
export function bikeAt(t) {
  if (t >= BIKE_OFF[0]) {
    const v = seg(t, BIKE_OFF[0], BIKE_OFF[1]), u = 1 - .5 * (.35 * v + .65 * v * v), p = W.polyAt(W.BIKE_PATH, W.BIKE_L, u);
    return { x: p[0], y: p[1], dir: -1, pedal: (1 - u) * W.BIKE_L[W.BIKE_L.length - 1] / 2.2, leaving: v < 1 };
  }
  const u = t < T.BASKET ? 0 : ss(seg(t, T.BASKET, T.BRAKE)) * .9 + seg(t, T.BASKET, T.BRAKE) * .1;
  const p = W.polyAt(W.BIKE_PATH, W.BIKE_L, u), q = W.polyAt(W.BIKE_PATH, W.BIKE_L, Math.min(1, u + .03));
  const dx = q[0] - p[0], dy = q[1] - p[1], sdir = (dx - dy) >= 0 ? 1 : -1;
  return { x: p[0], y: p[1], dir: u > .97 ? 1 : sdir, pedal: u * W.BIKE_L[W.BIKE_L.length - 1] / 2.2 };
}
// recipient: walks from the cupboard to the mat, stoops, lifts the letter
export function recipAt(t) {
  const A = [148.4, -37.4], B = [146.0, -34.7];
  const u = seg(t, T.STEP0 - BEAT / 2, T.PICK - BEAT / 4), p = [lerp(A[0], B[0], ss(u)), lerp(A[1], B[1], ss(u))];
  const walking = u > 0 && u < 1;
  const step = walking ? Math.floor(t * 12) % 2 : 0;
  // arm: down while walking, reaches down at PICK-0.15, lifts to chest after PICK
  const arm = t < T.PICK - .2 ? .15 : t < T.PICK ? lerp(.15, .5, seg(t, T.PICK - .2, T.PICK)) : lerp(.5, 1.45, eo(seg(t, T.PICK, T.PICK + .3)));
  const stoop = t > T.PICK - .25 && t < T.PICK + .2 ? Math.sin(seg(t, T.PICK - .25, T.PICK + .2) * Math.PI) * .25 : 0;
  return { x: p[0], y: p[1], step, arm, stoop, face: -1, h: 3.0 };
}
const handWorld = (r) => { const h = r.h, ax = .12 * h, ay = -.6 * h, al = .34 * h, ex = (ax + Math.sin(r.arm) * al) * r.face, ey = ay + Math.cos(r.arm) * al; const f = 1 / (2 * C30); return [r.x + ex * f, r.y - ex * f, -ey + .08]; };

// ---------- the letter ----------
const MBP = { x: W.MB.x, y: W.MB.y }, MB_FRONT = W.MB.y + 1.0;
const P_SLOT0 = [MBP.x, MB_FRONT + .55 + .28, 3.12], P_SLOT1 = [MBP.x, MBP.y + .1, 3.12], P_PILE = [MBP.x - .1, MBP.y - .15, .96];
const P_A = [10.3, 34.4, .04], P_B = [12.9, 30.7, .04], P_BELT = [15.6, W.PO.beltY, W.PO.beltZ];
const SACK_L = [-1.4, .2, .75], ENV_ON_SACK = [0, 0, .98];
const HOLD_L = [-1.1, .1, .85];
const D_Y = W.HOUSE.y1, P_DOOR0 = [W.HOUSE.doorX, D_Y + ENV.d / 2 + .2, W.HOUSE.slotZ], P_DOOR1 = [W.HOUSE.doorX, D_Y - ENV.d / 2 - .1, W.HOUSE.slotZ], P_MAT = [W.HOUSE.doorX, D_Y - .9, .03];
const basketOff = (dir) => { const bx = 1.08 * dir, f = 1 / (2 * C30); return [bx * f, -bx * f, 1.66]; };

// returns {x,y,z,rot, in, frame, clipY, pm}
export function letter(t) {
  const pm = t >= T.STAMP ? clamp((t - T.STAMP) / .06) : 0;
  const base = { rot: 0, pm, clipY: null, in: null, frame: null };
  if (t < T.DROP0) return { ...base, x: P_SLOT0[0], y: P_SLOT0[1], z: P_SLOT0[2] + Math.sin(t * 5) * .06, rot: Math.sin(t * 3) * .03, clipY: MB_FRONT };
  if (t < T.SLOT) { const u = eio(seg(t, T.DROP0, T.SLOT)); return { ...base, x: lerp(P_SLOT0[0], P_SLOT1[0], u), y: lerp(P_SLOT0[1], P_SLOT1[1], u), z: P_SLOT0[2], clipY: MB_FRONT }; }
  if (t < T.PILE) { const u = ei2(seg(t, T.SLOT, T.PILE)); return { ...base, x: lerp(P_SLOT1[0], P_PILE[0], u), y: lerp(P_SLOT1[1], P_PILE[1], u), z: lerp(P_SLOT1[2], P_PILE[2], u), rot: u * .2, in: 'mb' }; }
  if (t < T.HOP1) { const u = seg(t, T.PILE, T.HOP1); if (u < .25) return { ...base, x: P_PILE[0], y: P_PILE[1], z: P_PILE[2] + bounce(t, T.PILE, .12), rot: .2, in: 'mb' }; const v = seg(u, .25, 1), p = hopP(P_PILE, P_A, v, 1.3); return { ...base, x: p[0], y: p[1], z: p[2], rot: lerp(.2, -.3, v), in: p[1] < MB_FRONT - .2 && v < .5 ? 'mb' : null }; }
  if (t < T.HOP2) { const p = hopP(P_A, P_B, seg(t, T.HOP1, T.HOP2), 1.4); return { ...base, x: p[0], y: p[1], z: p[2], rot: lerp(-.3, .25, seg(t, T.HOP1, T.HOP2)) }; }
  if (t < T.POIN) { const u = seg(t, T.HOP2, T.POIN), p = hopP(P_B, P_BELT, u, 2.4); return { ...base, x: p[0], y: p[1], z: p[2], rot: lerp(.25, 0, u), in: p[1] < W.PO.y1 - .1 ? 'po' : null }; }
  const vB = (22 - P_BELT[0]) / (T.STAMP - T.POIN);
  if (t < T.FLIP) { const x = P_BELT[0] + vB * (t - T.POIN); return { ...base, x, y: P_BELT[1], z: P_BELT[2] + bounce(t, T.POIN, .15), in: 'po' }; }
  if (t < T.TRUCKIN) {
    const tr = truckAt(T.TRUCKIN), end = toWorld([tr.x, tr.y], tr.rot, [SACK_L[0], SACK_L[1], SACK_L[2] + ENV_ON_SACK[2]]);
    const x0 = P_BELT[0] + vB * (T.FLIP - T.POIN), u = seg(t, T.FLIP, T.TRUCKIN), uu = .55 * u + .45 * u * u;
    const x = lerp(x0, end[0], uu), y = lerp(P_BELT[1], end[1], uu), z = lerp(P_BELT[2] - .3, end[2], uu) + (u < .1 ? .3 * (1 - u / .1) : 0);
    return { ...base, x, y, z, rot: uu * .15, in: x < W.PO.x1 - .25 ? 'po' : x > tr.x - 2.85 ? 'truck' : 'hidden' };
  }
  if (t < T.TRUCKARR) { const tr = truckAt(t), p = toWorld([tr.x, tr.y], tr.rot, [SACK_L[0], SACK_L[1], SACK_L[2] + ENV_ON_SACK[2] + bounce(t, T.TRUCKIN, .18)]); return { ...base, x: p[0], y: p[1], z: p[2], rot: tr.rot + .15, in: 'truck', frame: 'truck', lx: SACK_L[0], ly: SACK_L[1], lz: SACK_L[2] + ENV_ON_SACK[2] + bounce(t, T.TRUCKIN, .18), lrot: .15 }; }
  if (t < T.HOLD) {
    const tr = truckAt(t), pl = planeAt(t), a = toWorld([tr.x, tr.y], tr.rot, SACK_L), bq = toWorld([pl.x, pl.y, pl.z], pl.rot, HOLD_L);
    const u = seg(t, T.TRUCKARR, T.HOLD), p = hopP(a, bq, eio(u), 2.6);
    return { ...base, x: p[0], y: p[1], z: p[2] + ENV_ON_SACK[2], rot: .15, sack: [p[0], p[1], p[2]], in: u > .78 ? 'hold' : null, sackOut: u <= .78 };
  }
  if (t < T.BASKET - BEAT / 2) { const pl = planeAt(t), p = toWorld([pl.x, pl.y, pl.z], pl.rot, [HOLD_L[0], HOLD_L[1], HOLD_L[2] + ENV_ON_SACK[2] + bounce(t, T.HOLD, .14)]); return { ...base, x: p[0], y: p[1], z: p[2], rot: pl.rot + .15, in: 'hold', frame: 'plane', lx: HOLD_L[0], ly: HOLD_L[1], lz: HOLD_L[2] + ENV_ON_SACK[2] + bounce(t, T.HOLD, .14), lrot: .15 }; }
  if (t < T.BASKET) {
    const pl = planeAt(t), a = toWorld([pl.x, pl.y, pl.z], pl.rot, [HOLD_L[0], HOLD_L[1], HOLD_L[2] + ENV_ON_SACK[2]]), bk = bikeAt(T.BASKET), o = basketOff(bk.dir), bq = [bk.x + o[0], bk.y + o[1], o[2]];
    const u = seg(t, T.BASKET - BEAT / 2, T.BASKET), p = hopP(a, bq, u, 2.2);
    return { ...base, x: p[0], y: p[1], z: p[2], rot: lerp(.15, -.2, u), in: u < .25 ? 'hold' : null };
  }
  if (t < T.BRAKE) { const bk = bikeAt(t), o = basketOff(bk.dir); return { ...base, x: bk.x + o[0], y: bk.y + o[1], z: o[2] + bounce(t, T.BASKET, .14), rot: -.2, bias: .6 }; }
  if (t < T.SIL) { const bk = bikeAt(t), o = basketOff(bk.dir), a = [bk.x + o[0], bk.y + o[1], o[2]], u = eio(seg(t, T.BRAKE, T.SIL)), p = hopP(a, P_DOOR0, u, .6); return { ...base, x: p[0], y: p[1], z: p[2], rot: lerp(-.2, 0, u), bias: .6 }; }
  if (t < T.CLACK) { const u = seg(t, T.SIL, T.CLACK), v = .55 * u + .45 * Math.pow(u, 3); return { ...base, x: P_DOOR0[0], y: lerp(P_DOOR0[1], P_DOOR1[1], v), z: P_DOOR0[2], clipY: D_Y, in: 'house' }; }
  if (t < T.MAT) { const u = ei2(seg(t, T.CLACK, T.MAT)); return { ...base, x: P_DOOR1[0], y: lerp(P_DOOR1[1], P_MAT[1], u), z: lerp(P_DOOR1[2], P_MAT[2], u), rot: u * .35, in: 'house' }; }
  if (t < T.PICK) return { ...base, x: P_MAT[0], y: P_MAT[1], z: P_MAT[2] + bounce(t, T.MAT, .14), rot: .35, in: 'house' };
  const r = recipAt(t), hw = handWorld(r), u = eo(seg(t, T.PICK - .05, T.PICK + .3));
  return { ...base, x: lerp(P_MAT[0], hw[0], u), y: lerp(P_MAT[1], hw[1], u), z: lerp(P_MAT[2], hw[2], u), rot: lerp(.35, .1, u), in: 'house' };
}

// ---------- the route: the letter's own trajectory (ground projection, air for the flight) ----------
const ROUTE = (() => {
  const pts = [];
  for (let t = T.DROP0 + .4; t <= T.PICK + .001; t += 1 / 48) {
    const e = letter(t); if (e.in === 'hidden') continue;
    let z = .07; if (t > T.LIFT && t < T.TOUCH) { const p = planeAt(t); z = p.z + 1.6; }
    if (t > T.TRUCKARR && t < T.HOLD) z = .07;
    pts.push({ t, p: [e.x, e.y, z] });
  }
  let s = 0; pts[0].s = 0; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1].p, b = pts[i].p; s += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); pts[i].s = s; }
  return { pts, len: s };
})();
const routeAtS = s => { const P = ROUTE.pts; let i = 1; while (i < P.length - 1 && P[i].s < s) i++; const a = P[i - 1], b = P[i], f = clamp((s - a.s) / ((b.s - a.s) || 1)); return [lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f), lerp(a.p[2], b.p[2], f)]; };

// ---------- camera ----------
const MBC = [W.MB.x, W.MB.y + .6, 2.5];
const SLOTC = [W.HOUSE.doorX - .15, W.HOUSE.y1 + .2, 1.45];   // door centre, slot just above
function camKeys() {
  const env = t => { const e = letter(t); return [e.x, e.y, Math.min(e.z, 2.5) * .5 + .8]; };
  const trk = t => { const tr = truckAt(t); return [tr.x + 1, tr.y + 1, 1.8]; };
  const pln = t => { const p = planeAt(t); return [p.x + 2, p.y + .5, p.z * .8 + 1.8]; };
  const bike = t => { const b2 = bikeAt(t); return [b2.x + 1, b2.y, 1.4]; };
  const F = (x, y, z) => () => [x, y, z];
  return [
    { t: 0, c: F(MBC[0], MBC[1], 2.55), k: 104 },
    { t: 1.45, c: F(MBC[0], MBC[1], 2.35), k: 118, e: 'lin' },
    { t: T.HOP1, c: t => { const p = env(t); return [p[0] + 2, p[1] - 1.5, 2.2]; }, k: 64 },
    { t: T.POIN, c: F(20.5, 25.4, 2.4), k: 56 },
    { t: T.STAMP - .25, c: F(21.0, 25.2, 2.4), k: 60, e: 'lin' },
    { t: T.STAMP, c: F(22.0, 25.0, 2.35), k: 104, e: 'in' },
    { t: T.FLIP, c: F(24.6, 25.0, 2.2), k: 66, e: 'out' },
    { t: T.TRUCKIN, c: F(31.0, 25.4, 2.0), k: 60 },
    { t: T.TRUCKGO, c: trk, k: 60 },
    { t: T.TRUCKARR - .3, c: trk, k: 50 },
    { t: T.TRUCKARR, c: F(49.6, 33.6, 1.9), k: 52 },
    { t: T.ROLL, c: F(50.2, 34.0, 1.9), k: 56, e: 'lin' },
    { t: T.LIFT, c: pln, k: 40 },
    { t: 9.0, c: pln, k: 16, e: 'out' },            // highest point of the crane: both boards and the gap between them
    { t: 9.5, c: pln, k: 48 },                       // push back early: the jet fills ≥ 1/4 of frame height from 9.4 s on
    { t: T.TOUCH, c: pln, k: 42, e: 'lin' },
    { t: T.BASKET, c: bike, k: 48 },
    { t: T.BRAKE, c: F(144.2, -31.2, 1.8), k: 56 },
    { t: T.SIL, c: F(SLOTC[0], SLOTC[1], SLOTC[2]), k: 60 },
    { t: T.CLACK, c: F(SLOTC[0], SLOTC[1], SLOTC[2]), k: 240, e: 'lin' },   // log-linear push: door ≈ 64 % of frame height at the clack
    { t: T.CLACK + 1.25, c: F(145.4, -35.4, 2.1), k: 64, e: 'out' },   // pulls back on the clack, settling slowly
    { t: T.PULL, c: F(146.4, -35.8, 2.1), k: 70, e: 'lin' },
    { t: T.PULL + 1.0, c: F(W.MAPC.x, W.MAPC.y, W.MAPC.z), k: 7.7, e: 'logout' },
    { t: DUR, c: F(W.MAPC.x + .5, W.MAPC.y - .5, W.MAPC.z), k: 7.85, e: 'lin' },
  ];
}
const KEYS = camKeys();
export function camAt(t) {
  let i = 0; while (i < KEYS.length - 2 && KEYS[i + 1].t <= t) i++;
  const A = KEYS[i], B = KEYS[i + 1], u = seg(t, A.t, B.t);
  const e = B.e === 'lin' ? u : B.e === 'in' ? u * u * u : B.e === 'out' ? eo(u) : B.e === 'slow' ? ss(u) : B.e === 'logout' ? 1 - Math.pow(1 - u, 4) : eio(u);
  const a = A.c(t), b2 = B.c(t);
  const ez = B.e === 'logout' ? 1 - Math.pow(1 - u, 2.2) : e;   // position settles a touch later than zoom in the pull-out
  return { x: lerp(a[0], b2[0], ez), y: lerp(a[1], b2[1], ez), z: lerp(a[2], b2[2], ez), k: Math.exp(lerp(Math.log(A.k), Math.log(B.k), e)) };
}

// ---------- text registry for readcheck ----------
let TXT = [];
export const texts = () => TXT;
function pinT(iso, x, y, z, o) {
  const g = iso.g, a = o.a ?? 1; if (a <= 0) return;
  const [ax, ay] = iso.P(x, y, z), up = o.up ?? 120, dir = o.dir ?? 1, len = o.len ?? 56, ts = o.ts || 38;
  const s1 = eo(seg(a, 0, .18)), s2 = eo(seg(a, .12, .42)), s3 = eo(seg(a, .36, .55)), s4 = seg(a, .45, 1);
  g.save(); g.globalAlpha = o.fade ?? 1; g.strokeStyle = COL.ink; g.lineWidth = 2.2; g.lineCap = 'round';
  if (s2 > 0) { g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax, ay - up * s2); if (s3 > 0) g.lineTo(ax + dir * len * s3, ay - up); g.stroke(); }
  const R = 8 * back(s1, 2.2); g.beginPath(); g.arc(ax, ay, Math.max(0, R), 0, TAU); g.fillStyle = COL.paper; g.fill(); g.stroke();
  g.beginPath(); g.arc(ax, ay, Math.max(0, R * .42), 0, TAU); g.fillStyle = o.dot || COL.ink; g.fill();
  if (s4 > 0) {
    const tx = ax + dir * (len + 12), ty = ay - up + ts * .36, font = `700 ${ts}px ${FONT}`;
    g.font = font; g.letterSpacing = '4px'; const w = g.measureText(o.title).width; g.letterSpacing = '0px';
    g.save(); g.beginPath(); const wv = (w + 30) * ss(s4); if (dir > 0) g.rect(tx - 6, ty - ts * 1.4, wv, ts * 2); else g.rect(tx + 6 - wv, ty - ts * 1.4, wv, ts * 2); g.clip();
    haloText(g, o.title, tx, ty, { font, track: 4, align: dir > 0 ? 'left' : 'right', hw: 8 });
    g.restore();
    if (o.sub) haloText(g, o.sub, dir > 0 ? tx : tx - w, ty + ts * .95, { font: `500 ${Math.round(ts * .5)}px ${FONT}`, track: 2, align: 'left' });
    TXT.push({ id: o.id || o.title, text: o.title, x0: dir > 0 ? tx - 4 : tx - w - 4, y0: ty - ts, x1: dir > 0 ? tx + w + 4 : tx + 4, y1: ty + ts * .3 });
  }
  g.restore();
}

// ---------- render ----------
let iso = null;
export function render(g, t) {
  TXT = [];
  if (!iso) iso = new Iso(g, 1920, 1080);
  iso.items = []; iso.T = null; iso.stack = []; iso.alpha = 1; iso.keep = false;
  const cam = camAt(t); iso.cam = cam; const k = cam.k;
  iso.desat = Math.max(clamp((t - (T.STAMP - .3)) / .2) * (1 - clamp((t - (T.STAMP + .15)) / .3)) * .95, t >= T.SIL && t < T.CLACK ? ss(seg(t, T.SIL, T.SIL + .35)) * .95 : 0);
  iso.treeA = Math.min(1 - clamp(iso.desat / .6), clamp((160 - k) / 30));
  W.drawBackground(iso);
  W.drawBoard(iso, W.BN); W.drawBoard(iso, W.BS);
  W.dressNorth(iso); W.dressSouth(iso);
  const E = letter(t);

  // route line on the ground: travelled + a short lead ahead of the letter
  const routeEnd = t < T.DROP0 + .4 ? -1 : t >= T.PULL ? ROUTE.len : (() => { const P = ROUTE.pts; let i = 0; while (i < P.length - 1 && P[i].t < t + .45) i++; return P[i].s; })();
  const fullA = t >= T.PULL ? 1 : 0;

  // envelope as a queued item (in a container's sub-queue when inside)
  const envItem = (where) => {
    if (E.in !== where) return;
    if (E.frame && (where === 'truck' || where === 'hold')) iso.add(where === 'truck' ? E.x + E.y + E.z + .3 : E.lx + E.ly + E.lz + .3, () =>   // sort in world space, like the sacks around it
      W.drawEnvelopeNow(iso, E.lx, E.ly, E.lz, E.lrot, { pm: E.pm }));
    else iso.add(E.x + E.y + E.z + .3 + (where === 'po' ? 6.5 : 0), () => W.drawEnvelopeNow(iso, E.x, E.y, E.z, E.rot, { pm: E.pm }));
  };
  // mailbox
  const mbSt = { line: seg(t, T.MBLINE, T.MBSKIN), skin: seg(t, T.MBSKIN, T.MBSKIN + .35) };
  W.mailbox(iso, mbSt, () => { W.letterPile(iso); envItem('mb'); });
  // post office
  const poSt = { line: seg(t, T.POLINE, T.POSKIN), skin: seg(t, T.POSKIN, T.POSKIN + .35) };
  const beltPhase = t * 6.4 % 13.6;
  const whites = []; for (let i = 0; i < 9; i++) { const sp = 2.8; whites.push(14.6 + ((i * sp + (t - T.POIN) * 6.4 + 1.4) % (sp * 9) + sp * 9) % (sp * 9)); }
  const stampZ = 2.0 + .9 * (1 - Math.max(seg(t, T.STAMP - .18, T.STAMP) * (1 - seg(t, T.STAMP + .05, T.STAMP + .3)), 0)) * 1;
  const flipA = t < T.FLIP - .1 ? 0 : t < T.FLIP ? lerp(0, -.9, seg(t, T.FLIP - .1, T.FLIP)) : lerp(-.9, 0, seg(t, T.FLIP + .2, T.FLIP + .5));
  W.postOffice(iso, t, poSt, () => { W.poInside(iso, t, beltPhase, stampZ, flipA, whites.filter(x => Math.abs(x - E.x) > 1.7 || E.in !== 'po')); envItem('po'); });
  // truck
  const tr = truckAt(t), trSt = { line: seg(t, T.TRUCKLINE, T.TRUCKIN), skin: seg(t, T.TRUCKIN - .2, T.TRUCKIN + .15) };
  W.truck(iso, tr.x, tr.y, tr.rot, trSt, () => {
    W.sack(iso, 1.1, -.85, .75, 1); W.sack(iso, 2.0, .45, .75, .9); W.sack(iso, -2.3, -.4, .75, .9);
    if (!(t >= T.TRUCKARR && t < T.HOLD) && t < T.HOLD) W.sack(iso, SACK_L[0], SACK_L[1], SACK_L[2], 1);
    envItem('truck');
  }, t);
  // the travelling sack between truck and hold
  if (E.sack && E.sackOut) { W.sack(iso, E.sack[0], E.sack[1], E.sack[2], 1); iso.add(E.x + E.y + E.z + .3, () => W.drawEnvelopeNow(iso, E.x, E.y, E.z, E.rot, { pm: E.pm })); }
  else if (E.sack && E.in === 'hold') { /* drawn in hold below */ }
  // belt loader
  iso.prism([[48.4, 32.2], [49.0, 32.2], [49.0, 34.4], [48.4, 34.4]], 1.1, .18, TR.road, { bias: -.5 });
  // plane
  const pl = planeAt(t), plSt = { line: seg(t, T.HOLDLINE, T.TRUCKARR), skin: seg(t, T.TRUCKARR, T.TRUCKARR + .35) };
  if (t > T.ROLL && pl.z < 3) { // ground shadow of the plane
    iso.add(-5e5, () => { const [sx, sy] = iso.P(pl.x, pl.y, 0); const r = 5.2 * k; g.save(); g.globalAlpha = clamp(.22 - pl.z * .012); g.fillStyle = '#5A4B3C'; g.beginPath(); g.ellipse(sx, sy, r, r * .42, 0, 0, TAU); g.fill(); g.restore(); }, 0);
  }
  W.plane(iso, pl.x, pl.y, pl.z, pl.rot, plSt, () => {
    if (t >= T.HOLD || (E.in === 'hold')) { W.sack(iso, HOLD_L[0], HOLD_L[1], HOLD_L[2], 1); }
    W.sack(iso, -2.0, -.3, .85, .8); envItem('hold');
  }, pl.gear);
  // bike + courier
  const bk = bikeAt(t);
  iso.bill(bk.x, bk.y, 0, (gg, I) => W.bikeBill(gg, t, k, bk.dir, (t > T.BASKET && t < T.BRAKE) || bk.leaving ? bk.pedal : 0, t > T.BRAKE && t < T.BRAKE + .25 ? -.15 * Math.sin(seg(t, T.BRAKE, T.BRAKE + .25) * Math.PI) : 0, c => I.col(c)), { r: 3, bias: .2 });
  // house
  const hSt = { line: seg(t, T.HLINE, T.HSKIN), skin: seg(t, T.HSKIN, T.HSKIN + .35) };
  W.house(iso, t, hSt, () => W.houseInside(iso, t, () => envItem('house'), () => {
    if (t < T.HSKIN - .3) return; const r = recipAt(t);
    iso.bill(r.x, r.y, 0, (gg) => { gg.rotate(r.stoop * -1); person(gg, { body: COL.lav, hair: '#3A2F3F', skin: '#D3A27E', h: r.h, arm: r.arm, face: r.face, bob: r.step * .06, legs: '#4A4458' }); }, { cull: false });
  }));
  // free-flying letter (outside containers)
  if (E.in === null && !E.sackOut && E.clipY == null) iso.add(E.x + E.y + E.z + .3 + (E.bias || 0), () => W.drawEnvelopeNow(iso, E.x, E.y, E.z, E.rot, { pm: E.pm }));
  if (E.clipY != null) iso.add(E.x + E.y + E.z + 2.4, () => drawClipped(E));
  // clouds (only when wide)
  const ca = clamp((30 - k) / 12);
  for (const c of W.CLOUDS) W.cloud(iso, c[0], c[1], c[2], c[3], ca * (t >= T.PULL ? .8 : 1));

  // ground route (under objects) during the journey
  if (routeEnd > 0) {
    const P = ROUTE.pts, gnd = []; let seg0 = [];
    for (const q of P) { if (q.s > routeEnd) break; if (q.p[2] > .2) { if (seg0.length) gnd.push(seg0); seg0 = []; continue; } seg0.push(q.p); }
    if (seg0.length) gnd.push(seg0);
    for (const s of gnd) if (s.length > 1 && !fullA) iso.line3(s, COL.ink, 2.2, { dash: [9, 8], layer: 0, depth: -7e5, a: .75 });
  }
  iso.flush();
  if (iso.desat > 0) { /* colour drain handled per item */ }

  // ---------- screen-space overlays ----------
  // route in the air (flight) + full route in the final map
  if (routeEnd > 0) {
    const P = ROUTE.pts; g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    const path = (filter) => { g.beginPath(); let on = false; for (const q of P) { if (q.s > routeEnd) break; if (!filter(q)) { on = false; continue; } const s = iso.P(...q.p); on ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]); on = true; } };
    const air = q => q.p[2] > .2;
    const sel = fullA ? (() => true) : air;
    const fa = fullA ? seg(t, T.PULL + .2, T.PULL + .8) : 1;
    if (fa > 0) {
      path(sel); g.strokeStyle = `rgba(251,246,234,${.85 * fa})`; g.lineWidth = fullA ? 8 : 6; g.setLineDash([]); g.stroke();
      path(sel); g.strokeStyle = `rgba(43,36,51,${.85 * fa})`; g.lineWidth = fullA ? 3 : 2.4; g.setLineDash(fullA ? [12, 9] : [10, 8]); g.lineDashOffset = -t * 30; g.stroke();
    }
    g.restore();
  }
  // tracked ring
  const ePx = ENV.w * k, es = iso.P(E.x, E.y, E.z + .05);
  const ringA = (t > T.PILE && t < T.SIL ? 1 : 0) * clamp((86 - k) / 16) * (t > T.STAMP - .3 && t < T.STAMP + .3 ? 0 : 1);
  if (ringA > 0 && E.in !== 'hidden') ring(g, es[0], es[1], Math.max(34, ePx * .85), ringA, t, null, { lw: 2.4 });
  if (t >= T.ISO0) { ring(g, es[0], es[1], 30, clamp((t - T.ISO0) / .3), t, null, { lw: 2.4 }); }

  // stage pins
  for (const S of STAGES) {
    if (t < S.t0 || t >= S.t1) continue;
    const a = S.instant ? 1 : clamp((t - S.t0) / .25), out = 1 - clamp((t - (S.t1 - .12)) / .12);
    const anchor = stageAnchor(S.text, t, E);
    if (anchor) pinT(iso, anchor[0], anchor[1], anchor[2], { title: S.text, a, fade: out, dir: anchor[3], up: anchor[4], id: 'stage' });
  }
  // inset: opening the letter
  if (t >= T.OPENL - .25 && t < T.PULL + .3) {
    const a = t < T.PULL ? seg(t, T.OPENL - .25, T.OPENL + .2) : 1 - seg(t, T.PULL, T.PULL + .25);
    const s2 = iso.P(E.x, E.y, E.z + .1);
    inset(iso, s2[0], s2[1], 1430, 380, 250, a, (gg, cx, cy, R) => letterClose(gg, cx, cy, R, t), { bg: '#F4ECDC' });
  }
  // final map: city pins, Isotype distance, days, legend, arrival postmark
  if (t >= T.PULL) finalMap(g, t, E);
}
// part of the letter still outside a slot (mailbox / door), drawn above the wall face
function drawClipped(E) {
  const g = iso.g, { w, d, h } = ENV;
  const yFront = E.y + d / 2; if (yFront <= E.clipY) return;
  const y0 = Math.max(E.y - d / 2, E.clipY);
  iso.keep = true; iso.boxNow(E.x - w / 2, y0, E.z, w, yFront - y0, h, TR.red, {}); iso.keep = false;
  W.onPlane(iso, [E.x - w / 2, y0, E.z + h + .001], [1, 0, 0], [0, 1, 0], gg => { gg.strokeStyle = iso.col('#A92A22'); gg.lineWidth = .06; gg.beginPath(); const dd = yFront - y0; gg.moveTo(.05, dd - .05); gg.lineTo(w * .5, dd - d * .5); gg.lineTo(w - .05, dd - .05); gg.stroke(); });
}
function stageAnchor(text, t, E) {
  const k = iso.cam.k;
  if (text === '寄出') return [W.MB.x + .9, W.MB.y - .6, 5.1, 1, 70];
  if (text === '分拣') return [22, 23, 4.1, -1, 46];
  if (text === '陆运') { const tr = truckAt(t); return [tr.x, tr.y, 3.7, 1, 80]; }
  if (text === '航空') { const p = planeAt(t); return [p.x - 3.5, p.y, p.z + 4.8, -1, 60]; }
  if (text === '投递') { const b2 = bikeAt(t); return [b2.x, b2.y, 2.3, -1, 70]; }
  if (text === '送达') return [W.HOUSE.doorX + 2.2, W.HOUSE.y0 + 1.2, W.HOUSE.h, 1, 50];
}

// close-up inside the inset: two hands holding the opened letter, a heart pops
function letterClose(g, cx, cy, R, t) {
  const u = seg(t, T.OPENL - .1, T.OPENL + .35), hp = back(seg(t, T.HEART, T.HEART + .3), 2.4);
  g.save(); g.translate(cx, cy + 20);
  // envelope body (red, opened flap)
  const E3 = tri(COL.red);
  g.fillStyle = E3[1]; g.fillRect(-150, -20, 300, 170);
  g.fillStyle = E3[2]; g.beginPath(); g.moveTo(-150, 150); g.lineTo(0, 55); g.lineTo(150, 150); g.closePath(); g.fill();
  g.fillStyle = E3[0]; g.beginPath(); g.moveTo(-150, -20); g.lineTo(0, -20 - 95 * u); g.lineTo(150, -20); g.closePath(); g.fill();
  // card rising out
  const cyc = lerp(40, -95, eo(u));
  g.save(); g.beginPath(); g.rect(-160, -400, 320, 400 + 30 + (u > .5 ? 200 : 0)); g.clip();
  g.fillStyle = '#FBF6EA'; g.fillRect(-120, cyc - 90, 240, 190); g.fillStyle = '#E9DFCC'; g.fillRect(40, cyc - 90, 80, 190);
  g.strokeStyle = 'rgba(43,36,51,.7)'; g.lineWidth = 5; g.lineCap = 'round';
  for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-90, cyc - 50 + i * 30); for (let j = 0; j <= 10; j++) g.lineTo(-90 + j * (i === 2 ? 9 : 16), cyc - 50 + i * 30 + Math.sin(j * 1.7 + i) * 3); g.stroke(); }
  if (hp > 0) { g.save(); g.translate(60, cyc + 40); g.scale(hp, hp); g.fillStyle = COL.red; g.beginPath(); g.moveTo(0, 28); g.bezierCurveTo(-46, -4, -26, -40, 0, -16); g.bezierCurveTo(26, -40, 46, -4, 0, 28); g.fill(); g.fillStyle = '#E86A5F'; g.beginPath(); g.ellipse(-13, -14, 8, 5, -.6, 0, TAU); g.fill(); g.restore(); }
  g.restore();
  // postmark on the envelope front
  W.postmarkMark(g, -95, 95, 38, 1, ['北城', '10·31'], null, { rot: -.25 });
  // hands (faceted, three skin tones) + lavender sleeves
  const S = ['#E4B796', '#D3A27E', '#B5825F'], sleeve = tri(COL.lav);
  const hand = (sx) => {
    g.save(); g.translate(sx * 165, 70); g.scale(sx, 1);
    g.fillStyle = sleeve[1]; g.beginPath(); g.moveTo(30, 60); g.lineTo(120, 40); g.lineTo(140, 150); g.lineTo(50, 170); g.closePath(); g.fill();
    g.fillStyle = sleeve[2]; g.beginPath(); g.moveTo(85, 50); g.lineTo(120, 40); g.lineTo(140, 150); g.lineTo(105, 158); g.closePath(); g.fill();
    g.fillStyle = S[1]; g.beginPath(); g.moveTo(-20, -40); g.lineTo(40, -50); g.lineTo(60, 60); g.lineTo(0, 70); g.closePath(); g.fill();
    g.fillStyle = S[2]; g.beginPath(); g.moveTo(30, -48); g.lineTo(40, -50); g.lineTo(60, 60); g.lineTo(40, 64); g.closePath(); g.fill();
    g.fillStyle = S[0]; for (let i = 0; i < 3; i++) { g.beginPath(); g.roundRect(-34, -40 + i * 26, 46, 20, 10); g.fill(); }
    g.fillStyle = S[1]; g.beginPath(); g.roundRect(-12, 6 + 52, 34, 22, 11); g.fill();
    g.restore();
  };
  hand(-1); hand(1);
  g.restore();
}

// ---------- the finished infographic ----------
function finalMap(g, t, E) {
  // city pins
  pinT(iso, 26, 14, 8.5, { title: W.BN.name, a: seg(t, T.CITYN - .2, T.CITYN + .3), dir: -1, up: 110, ts: 46, id: 'cityN' });
  pinT(iso, 128, -50, 7.5, { title: W.BS.name, a: seg(t, T.CITYS - .2, T.CITYS + .3), dir: -1, up: 120, ts: 46, id: 'cityS' });
  // Isotype: 12 letters along the route, one per sixteenth
  const n = clamp(Math.floor((t - T.ISO0) / (BEAT / 4) + 1e-6) + 1, 0, NISO);
  for (let i = 0; i < NISO; i++) {
    const ti = isoT(i); if (t < ti) continue;
    const p = routeAtS(ROUTE.len * (i + .5) / NISO), s = iso.P(...p), sc = back(clamp((t - ti) / .18), 2.6);
    g.save(); g.translate(s[0], s[1] - 6); g.scale(sc, sc); isoEnvIcon(g, 0, 0, 50); g.restore();
  }
  // legend block (top-left)
  const la = seg(t, T.ISO0, T.ISO0 + .12);
  if (la > 0) {
    const x0 = 120, y0 = 790;
    g.save(); g.globalAlpha = la;
    const km = Math.min(n, NISO) * KM_PER_ICON, kmS = km.toLocaleString('en-US');
    g.font = `400 104px Jost`; const wn = g.measureText('1,200').width;
    haloText(g, kmS, x0 + wn, y0 + 92, { font: `400 104px Jost`, align: 'right', hw: 9 });
    haloText(g, '公里', x0 + wn + 14, y0 + 92, { font: `700 44px NotoSC`, hw: 8 });
    TXT.push({ id: 'km', text: '1,200 公里', x0, y0: y0 + 10, x1: x0 + wn + 110, y1: y0 + 100 });
    // key: one icon = 100 km
    isoEnvIcon(g, x0 + 22, y0 + 142, 34);
    haloText(g, '= 100 公里', x0 + 52, y0 + 154, { font: `500 30px ${FONT}`, hw: 7 });
    TXT.push({ id: 'key', text: '= 100 公里', x0: x0 + 2, y0: y0 + 120, x1: x0 + 220, y1: y0 + 164 });
    g.restore();
  }
  // days: two suns
  const da = seg(t, T.SUN1 - .1, T.SUN1 + .15);
  if (da > 0) {
    const x0 = 1470, y0 = 150;
    for (let i = 0; i < 2; i++) { const ti = i ? T.SUN2 : T.SUN1; if (t < ti) continue; const sc = back(clamp((t - ti) / .2), 2.4); g.save(); g.translate(x0 + i * 104, y0 + 40); g.scale(sc, sc); ICON.sun(g, 0, 0, 84, 1); g.restore(); }
    g.save(); g.globalAlpha = da;
    haloText(g, '2', x0 + 200, y0 + 74, { font: `400 104px Jost`, hw: 9 });
    haloText(g, '天', x0 + 264, y0 + 74, { font: `700 44px NotoSC`, hw: 8 });
    g.restore();
    TXT.push({ id: 'days', text: '2 天', x0: x0 + 196, y0: y0 - 6, x1: x0 + 314, y1: y0 + 84 });
  }
  // not to scale
  const na = seg(t, T.CITYN, T.CITYN + .3);
  if (na > 0) { g.save(); g.globalAlpha = na; haloText(g, '示意 · 不按比例', 1800, 1030, { font: `500 24px ${FONT}`, align: 'right', track: 3, color: '#6B6272' }); g.restore(); TXT.push({ id: 'nts', text: '示意 · 不按比例', x0: 1600, y0: 1004, x1: 1802, y1: 1036 }); }
  // arrival postmark lands on the map
  if (t >= T.ARRIVE) {
    const hs = iso.P(W.HOUSE.x1, W.HOUSE.y0, 6), a = clamp((t - T.ARRIVE) / .08);
    g.save(); W.postmarkMark(g, 1120, 950, 88, a, ['南港', '11·02'], null, { pop: true, rot: -.2, wave: .6, ink: 'rgba(43,36,51,.9)' }); g.restore();
  }
}
// tiny isometric red letter for the Isotype row
function isoEnvIcon(g, x, y, s) {
  const t3 = TR.red, w = s * .5, d = s * .34, hh = s * .1, P = (a, b2, c) => [x + (a - b2) * C30, y + (a + b2) * S30 - c];
  const f = (pts, c) => { g.beginPath(); pts.forEach((p, i) => { const q = P(...p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath(); g.fillStyle = c; g.fill(); };
  const X = w / 2, Y = d / 2;
  f([[-X, Y, 0], [X, Y, 0], [X, Y, hh], [-X, Y, hh]], t3[1]); f([[X, -Y, 0], [X, Y, 0], [X, Y, hh], [X, -Y, hh]], t3[2]); f([[-X, -Y, hh], [X, -Y, hh], [X, Y, hh], [-X, Y, hh]], t3[0]);
  g.strokeStyle = '#A92A22'; g.lineWidth = Math.max(1.2, s * .05); g.beginPath(); const a = P(-X * .9, -Y * .9, hh), b2 = P(0, Y * .1, hh), c = P(X * .9, -Y * .9, hh); g.moveTo(...a); g.lineTo(...b2); g.lineTo(...c); g.stroke();
}
