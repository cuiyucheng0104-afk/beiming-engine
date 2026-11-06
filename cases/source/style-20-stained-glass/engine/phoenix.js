// The glass phoenix: rigid cut pieces on a 2D FK rig. Faces right; body centre at the origin; y down.
// Groups (for crack displacement and re-leading): tail, body, wingF (far), wingN (near), head (neck+head), crest, extra (new glass).
import { COL, INK, smooth, circle, brush, sampleCurve } from './glass.js';
import { lerp } from '/core/lib.js';

const D = Math.PI / 180;
const cs = a => [Math.cos(a), Math.sin(a)];
const rot = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];

export const POSE = {
  rest:   { neck: [-78, 14, 16], head: -12, wingN: { a: -128, fan: .55, len: 1 }, wingF: { a: -62, fan: .5, len: .9 }, tail: { a: 152, fan: .5 }, crest: .5, face: 'calm', beak: 0 },
  down:   { neck: [-74, 12, 14], head: -6, wingN: { a: -168, fan: .35, len: 1 }, wingF: { a: -20, fan: .3, len: .9 }, tail: { a: 146, fan: .45 }, crest: .45, face: 'calm', beak: 0 },
  up:     { neck: [-80, 16, 18], head: -18, wingN: { a: -104, fan: .7, len: 1 }, wingF: { a: -84, fan: .65, len: .9 }, tail: { a: 158, fan: .55 }, crest: .6, face: 'calm', beak: 0 },
  blaze:  { neck: [-88, 4, -10], head: -66, wingN: { a: -100, fan: .95, len: 1.05 }, wingF: { a: -78, fan: .9, len: .95 }, tail: { a: 120, fan: .8 }, crest: .9, face: 'fierce', beak: 1 },
  reborn: { neck: [-70, 10, 12], head: -16, wingN: { a: -146, fan: 1, len: 1.12 }, wingF: { a: -34, fan: 1, len: 1.02 }, tail: { a: 140, fan: 1 }, crest: 1, face: 'serene', beak: 0 },
};
export function lerpPose(a, b, u) {
  const o = { ...a };
  o.neck = a.neck.map((v, i) => lerp(v, b.neck[i], u)); o.head = lerp(a.head, b.head, u);
  for (const w of ['wingN', 'wingF']) o[w] = { a: lerp(a[w].a, b[w].a, u), fan: lerp(a[w].fan, b[w].fan, u), len: lerp(a[w].len, b[w].len, u) };
  o.tail = { a: lerp(a.tail.a, b.tail.a, u), fan: lerp(a.tail.fan, b.tail.fan, u) };
  o.crest = lerp(a.crest, b.crest, u); o.beak = lerp(a.beak, b.beak, u);
  o.face = u < .5 ? a.face : b.face;
  return o;
}

// leaf-shaped feather from base point along angle a
function featherPts(b, a, L, W) {
  const d = cs(a), n = [-d[1], d[0]], P = (u, v) => [b[0] + d[0] * L * u + n[0] * W * v, b[1] + d[1] * L * u + n[1] * W * v];
  return { pts: [P(0, -.45, 1), P(.25, -.9), P(.6, -.85), P(.88, -.4), P(1, 0, 1), P(.88, .4), P(.6, .85), P(.25, .9), P(0, .45, 1)].map((q, i) => (i === 0 || i === 4 || i === 8) ? [q[0], q[1], 1] : q), P };
}
function featherPaint(f, L, W) {
  return g => {
    brush(g, [f.P(.02, 0), f.P(.5, 0), f.P(.95, 0)], Math.max(1.6, W * .12), { color: INK, w0: .6, w1: .2 });
    const n = Math.max(4, Math.round(L / 16));
    for (let k = 1; k < n; k++) { const u = k / n * .9; for (const s of [-1, 1]) brush(g, [f.P(u, 0), f.P(u + .06, s * .5), f.P(u + .12, s * .8)], Math.max(1, W * .07), { color: 'rgba(60,28,10,.5)', w0: .5, w1: .2 }); }
    brush(g, [f.P(.15, -.45), f.P(.5, -.55), f.P(.8, -.3)], Math.max(1.2, W * .1), { color: g.__col, w0: .1, w1: .1 });   // scraped highlight
  };
}
const FCOLS = [COL.red2, COL.gold, COL.ruby, COL.gold2, COL.red2, COL.gold, COL.ruby, COL.gold2];

// --- wing: coverts (two banded pieces) + primaries + secondaries; extra = number of new feathers (0..2) and their slide
function wing(P, side, w, lit, id, o) {
  const far = side === 'F', sh = far ? [18, -30] : [4, -24], sgn = far ? 1 : -1, len = w.len * (far ? .9 : 1);
  const a = w.a * D, armL = 92 * len, d = cs(a), tip = add(sh, d, armL), n = [-d[1] * sgn, d[0] * sgn];
  const step = (.16 + .18 * w.fan), nP = 6;
  const all = [];
  // primaries (trailing fan away from the body)
  for (let k = 0; k < nP; k++) all.push({ b: add(add(sh, d, armL * (1 - k * .07)), n, -4), ang: a + sgn * (-.18 + k * step * .62), L: (150 - k * 9) * len, W: 21 * len, col: FCOLS[k + (far ? 1 : 0)], k });
  // secondaries along the arm
  for (let k = 0; k < 4; k++) all.push({ b: add(sh, d, armL * (.62 - k * .15)), ang: a + sgn * (.25 + nP * step * .62 + k * step * .5), L: (98 - k * 12) * len, W: 19 * len, col: FCOLS[(k + 3) % 8], k: k + nP });
  // new glass (reborn): two extra long primaries beyond the old fan, sliding out from under the coverts
  const ex = o.extra || 0;
  for (let k = 0; k < 2; k++) if (ex > 0) {
    const sl = o.extraSlide ?? 1, ang = a + sgn * (-.18 - (k + 1) * step * .62);
    all.push({ b: add(add(sh, d, armL * (1.02 - k * .02)), cs(ang), -(1 - sl) * 120), ang, L: (165 - k * 6) * len, W: 22 * len, col: k ? COL.white : COL.gold2, k: 20 + k, extra: true });
  }
  // draw back to front: secondaries (rear), primaries, coverts
  const order = all.slice().sort((p, q) => (q.k >= nP && q.k < 20 ? 1 : 0) - (p.k >= nP && p.k < 20 ? 1 : 0));
  for (const f of order) {
    const fp = featherPts(f.b, f.ang, f.L, f.W);
    P.piece(smooth(fp.pts), f.col, { id: id + f.k, lead: 4, matW: 6, lit: f.extra ? (o.extraLit || lit) : lit, paint: featherPaint(fp, f.L, f.W) });
  }
  // coverts: lesser (gold) over greater (ruby), banded along the arm
  const C = (u, v) => add(add(sh, d, armL * u), n, v);
  P.piece(smooth([C(-.05, 8, 1), C(.25, -26), C(.7, -20), C(1.04, -2, 1), C(.75, 14), C(.3, 22)]), COL.ruby, { id: id + 40, lead: 5, matW: 8, lit, wash: .12, paint: g => {
    for (let k = 0; k < 5; k++) { const u = .15 + k * .17; brush(g, [C(u, 14), C(u + .08, 2), C(u + .02, -12)], 1.6, { color: 'rgba(50,10,10,.55)' }); }
  } });
  P.piece(smooth([C(-.08, 12, 1), C(.1, -14), C(.42, -18), C(.62, -4, 1), C(.35, 14)]), COL.gold, { id: id + 41, lead: 4.5, matW: 7, lit, paint: g => {
    g.strokeStyle = 'rgba(70,36,8,.55)'; g.lineWidth = 1.3; g.beginPath();
    for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) { const c = C(.06 + k * .13 + r * .06, -8 + r * 8); g.moveTo(c[0] + 5, c[1]); g.arc(c[0], c[1], 5, 0, Math.PI, false); }
    g.stroke();
  } });
  return { tip, sh };
}

// --- neck chain + head + crest
function neckChain(p) {
  const base = [44, -30], pts = [base]; let a = 0, q = base;
  const L = [32, 30, 28];
  for (let i = 0; i < 3; i++) { a = (i === 0 ? p.neck[0] : a / D + p.neck[i]) * D; q = add(q, cs(a), L[i]); pts.push(q); }
  return { pts, headA: p.head * D, head: q };
}
function drawNeckHead(P, p, lit, id, o) {
  const N = neckChain(p);
  // a smooth spine through the chain; left/right edges sampled densely, cut into three bands
  const sp = sampleCurve([add(N.pts[0], cs(N.pts[1][0] - N.pts[0][0] > 0 ? Math.PI * .75 : Math.PI * .75), 10), ...N.pts], 8), n0 = sp.length;
  const wid = i => { const u = i / (n0 - 1); return 21 - 11 * u + 4 * Math.sin(u * Math.PI); };
  const Lp = [], Rp = [];
  for (let i = 0; i < n0; i++) { const a = sp[Math.max(0, i - 1)], c = sp[Math.min(n0 - 1, i + 1)], d = [c[0] - a[0], c[1] - a[1]], l = Math.hypot(...d) || 1, nn = [-d[1] / l, d[0] / l]; Lp.push(add(sp[i], nn, wid(i))); Rp.push(add(sp[i], nn, -wid(i))); }
  const cuts = [0, Math.round(n0 * .36), Math.round(n0 * .7), n0 - 1];
  for (let k = 0; k < 3; k++) {
    const a = cuts[k], c = cuts[k + 1] + (k === 2 ? 0 : 0);
    const pts = [...Lp.slice(a, c + 1).map((q, m, A) => (m === 0 || m === A.length - 1) ? [...q, 1] : q), ...Rp.slice(a, c + 1).reverse().map((q, m, A) => (m === 0 || m === A.length - 1) ? [...q, 1] : q)];
    P.piece(smooth(pts), k % 2 ? COL.gold2 : COL.ruby, { id: id + k, lead: 4.5, matW: 6, lit, paint: g => {
      g.strokeStyle = 'rgba(60,20,8,.5)'; g.lineWidth = 1.2; g.beginPath();
      for (let m = a + 2; m < c; m += 4) for (const v of [-.45, .05, .5]) { const q = [lerp(Rp[m][0], Lp[m][0], (v + 1) / 2), lerp(Rp[m][1], Lp[m][1], (v + 1) / 2)]; g.moveTo(q[0] + 4, q[1]); g.arc(q[0], q[1], 4, 0, Math.PI, false); }
      g.stroke();
      brush(g, [Lp[a + 1], Lp[Math.round((a + c) / 2)], Lp[c - 1]].map(q => [q[0] - 3, q[1] + 2]), 1.8, { color: g.__col, w0: .1, w1: .1 });
    } });
  }
  // crest plumes (behind the head): 3 old + up to 2 new
  const hp = N.head, ha = N.headA;
  const HS = 1.25, H = (x, y) => add(hp, rot([x * HS, y * HS], ha));
  const crest = [];
  const nC = 3 + (o.crestExtra ? 2 : 0);
  for (let k = 0; k < nC; k++) {
    const isNew = k >= 3, kk = isNew ? k - 3 : k;
    const ang = ha - 2.35 + (isNew ? (kk ? -.75 : .7) : (-.42 + kk * .42)) * (.6 + .5 * p.crest), L = (isNew ? 78 : 62 - kk * 6) * (.8 + .3 * p.crest);
    const sl = isNew ? (o.crestSlide ?? 1) : 1;
    const b = add(H(-8, -10), cs(ang), -(1 - sl) * 70), d = cs(ang), n = [-d[1], d[0]];
    const Q = (u, v) => add(add(b, d, L * u), n, v);
    crest.push({ k, isNew, Q, L });
    P.piece(smooth([Q(0, -3, 1), Q(.5, -5), Q(.82, -5), Q(.86, 0), Q(.82, 5), Q(.5, 5), Q(0, 3, 1)]), isNew ? COL.white : COL.gold, { id: id + 10 + k, lead: 3.5, matW: 3, lit: isNew ? (o.extraLit || lit) : lit });
    P.piece(circle(...Q(.93, 0), 8.5), isNew ? COL.gold2 : (k % 2 ? COL.green : COL.ruby), { id: id + 20 + k, lead: 3.5, matW: 4, lit: isNew ? (o.extraLit || lit) : lit, paint: g => { const c = Q(.93, 0); g.fillStyle = INK; g.beginPath(); g.arc(c[0], c[1], 3, 0, 7); g.fill(); } });
  }
  // wattle, beak, head
  const bo = p.beak * .22;
  P.piece(smooth([H(10, 8, 1), H(24, 10), H(20, 22), H(10, 20)]), COL.ruby, { id: id + 30, lead: 3.5, matW: 4, lit });
  P.piece(smooth([H(16, -9, 1), H(32, -9), H(44, -2), H(42, 4, 1), H(30, 0), H(16, 1, 1)].map(q => q)), COL.white, { id: id + 31, lead: 3.5, matW: 4, lit });   // upper beak
  const hinge = H(16, 4), lb = q => [...add(hinge, rot(rot([(q[0] - 16) * HS, (q[1] - 4) * HS], bo), ha)), q[2] || 0];
  P.piece(smooth([lb([16, 3, 1]), lb([34, 4]), lb([40, 7, 1]), lb([26, 10]), lb([16, 8, 1])]), COL.white, { id: id + 32, lead: 3.5, matW: 3, lit });   // lower beak
  P.piece(smooth([H(-16, -6), H(-6, -16), H(10, -16), H(20, -8), H(22, 4), H(12, 13), H(-4, 14), H(-16, 8)]), COL.gold2, { id: id + 33, lead: 4.5, matW: 6, lit, paint: g => {
    // almond eye, heavy upper lid, big pupil; brow carries the expression
    const face = p.face;
    g.fillStyle = 'rgba(236,236,220,.0)';
    brush(g, [H(-1, -3), H(5, -7), H(12, -4)], 2.6, { color: INK, w0: .4, w1: .3 });                 // upper lid
    brush(g, [H(0, -2), H(6, 1), H(11, -3)], 1.4, { color: INK });                                   // lower lid
    g.fillStyle = INK; g.beginPath(); const e = H(6, -3); g.arc(e[0], e[1], 2.8, 0, 7); g.fill();
    const brow = face === 'fierce' ? [H(-4, -13), H(4, -11), H(13, -6)] : face === 'serene' ? [H(-4, -9), H(4, -13), H(13, -11)] : [H(-4, -11), H(4, -12), H(13, -9)];
    brush(g, brow, 2.8, { color: INK, w0: .3, w1: .5 });
    brush(g, [H(13, -6), H(17, -2), H(18, 3)], 1.6, { color: INK });   // brow flowing into the beak
    brush(g, [H(-12, 4), H(0, 9), H(12, 9)], 1.6, { color: g.__col, w0: .1, w1: .1 });
  } });
  return N;
}

// --- tail plumes (banded: base + tip + eye)
function drawTail(P, p, lit, id, o) {
  const root = [-44, 40], nT = 3 + (o.tailExtra ? 2 : 0);
  for (let k = 0; k < nT; k++) {
    const isNew = k >= 3, kk = isNew ? k - 3 : k;
    const off = isNew ? (kk ? -.62 : .62) : (kk - 1) * .3;
    const a = (p.tail.a * D) + off * (.45 + .6 * p.tail.fan), L = isNew ? 228 : 205 - Math.abs(kk - 1) * 26;
    const sl = isNew ? (o.tailSlide ?? 1) : 1;
    const b = add(root, cs(a), -(1 - sl) * 150), d = cs(a), n = [-d[1], d[0]], curl = (kk % 2 ? -1 : 1) * (isNew ? 1.2 : .8);
    const Q = (u, v) => { const bend = Math.sin(u * Math.PI * .9) * 28 * curl; return add(add(b, d, L * u), n, v + bend); };
    const col = isNew ? COL.gold2 : [COL.ruby, COL.gold, COL.red2][kk];
    const L1 = isNew ? (o.extraLit || lit) : lit;
    P.piece(smooth([Q(0, -5, 1), Q(.25, -9), Q(.5, -12, 1), Q(.5, 12, 1), Q(.25, 9), Q(0, 5, 1)]), col, { id: id + k * 4, lead: 4, matW: 6, lit: L1, paint: g => { for (let j = 1; j < 6; j++) brush(g, [Q(j * .09, 0), Q(j * .09 + .05, 7)], 1.3, { color: 'rgba(60,28,10,.5)' }); brush(g, [Q(0, 0), Q(.5, 0)], 1.8, { color: INK }); } });
    P.piece(smooth([Q(.5, -12, 1), Q(.66, -16), Q(.8, -15), Q(.86, 0), Q(.8, 15), Q(.66, 16), Q(.5, 12, 1)]), isNew ? COL.white : (kk === 1 ? COL.ruby : COL.gold2), { id: id + k * 4 + 1, lead: 4, matW: 6, lit: L1, paint: g => { brush(g, [Q(.5, 0), Q(.8, 0)], 1.6, { color: INK }); } });
    const e = Q(.9, 0);
    P.piece(circle(e[0], e[1], 19), isNew ? COL.gold : COL.green, { id: id + k * 4 + 2, lead: 4, matW: 5, lit: L1 });
    P.piece(circle(e[0], e[1], 9), isNew ? COL.ruby : COL.purple, { id: id + k * 4 + 3, lead: 3.5, matW: 3, lit: L1, paint: g => { g.fillStyle = INK; g.beginPath(); g.arc(e[0], e[1], 3.4, 0, 7); g.fill(); } });
  }
}

function drawBody(P, lit, id) {
  P.piece(smooth([[42, -40], [20, -36], [-2, -16], [-28, 14], [-56, 44, 1], [-14, 34], [16, 10], [34, -16]]), COL.ruby, { id, lead: 5, matW: 9, lit, wash: .12, paint: g => {
    g.strokeStyle = 'rgba(50,10,10,.6)'; g.lineWidth = 1.4; g.beginPath();
    for (let r = 0; r < 3; r++) for (let k = 0; k < 5; k++) { const x = 28 - k * 15 - r * 6, y = -26 + k * 13 + r * 7; g.moveTo(x + 5, y); g.arc(x, y, 5, 0, Math.PI, false); }
    g.stroke();
  } });
  P.piece(smooth([[42, -40], [58, -30], [66, -6], [52, 24], [22, 46], [-18, 54], [-56, 44, 1], [-14, 34], [16, 10], [34, -16]]), COL.gold, { id: id + 1, lead: 5, matW: 10, lit, shade: [60, -30, -10, 40, .25], paint: g => {
    for (let k = 0; k < 6; k++) brush(g, [[44 - k * 10, -10 + k * 9], [36 - k * 10, 6 + k * 8], [24 - k * 10, 16 + k * 7]], 1.7, { color: 'rgba(80,40,8,.5)' });
    brush(g, [[54, -20], [56, 0], [44, 22]], 2.2, { color: g.__col, w0: .1, w1: .1 });
  } });
  // legs tucked (two short pieces) with talons
  P.piece(smooth([[10, 40, 1], [20, 40, 1], [24, 62], [14, 66, 1]]), COL.gold2, { id: id + 2, lead: 3.5, matW: 3, lit });
  P.piece(smooth([[-6, 44, 1], [4, 44, 1], [6, 64], [-4, 68, 1]]), COL.gold2, { id: id + 3, lead: 3.5, matW: 3, lit });
}

// --- draw the whole bird. base: DOMMatrix (medallion space). o.off[group] = [dx, dy, da]; o.lit[group] = [sun, fire, crack]
export function drawPhoenix(P, base, p, o = {}) {
  const off = o.off || {}, lit = g => (o.lit && o.lit[g]) || o.L || [1, 0, 0];
  const M = g => { const q = off[g] || [0, 0, 0]; return base.translate(q[0], q[1]).rotate(q[2] / D); };
  P.setTransform(M('tail')); drawTail(P, p, lit('tail'), 8100, o);
  P.setTransform(M('wingF')); wing(P, 'F', p.wingF, lit('wingF'), 8200, { extra: o.wingExtraF, extraSlide: o.wingSlideF, extraLit: o.extraLit });
  P.setTransform(M('body')); drawBody(P, lit('body'), 8300);
  P.setTransform(M('head')); drawNeckHead(P, p, lit('head'), 8400, { crestExtra: o.crestExtra, crestSlide: o.crestSlide, extraLit: o.extraLit });
  P.setTransform(M('wingN')); wing(P, 'N', p.wingN, lit('wingN'), 8500, { extra: o.wingExtraN, extraSlide: o.wingSlideN, extraLit: o.extraLit });
  P.setTransform(base);
  return { head: neckChain(p).head };
}

// flame tongues rising from the bottom of the medallion (glass that only the fire lights)
export const FLAMES = (() => {
  const out = []; const xs = [-150, -112, -76, -40, -4, 32, 68, 104, 140];
  xs.forEach((x, k) => {
    const h = 60 + ((k * 37) % 5) * 16 + (k > 2 && k < 6 ? 40 : 0), w = 24 + (k % 3) * 5, y0 = 196, lean = ((k * 13) % 7 - 3) * 4;
    out.push({ pts: [[x - w, y0, 1], [x - w * .8, y0 - h * .35], [x - w * .2 + lean * .5, y0 - h * .7], [x + lean, y0 - h, 1], [x + w * .45 + lean * .5, y0 - h * .62], [x + w * .9, y0 - h * .3], [x + w, y0, 1]], col: [COL.gold, COL.red2, COL.ruby, COL.gold2][k % 4], id: 8700 + k, x, top: [x + lean, y0 - h] });
  });
  return out;
})();
export function drawFlames(P, base, o = {}) {
  FLAMES.forEach((f, k) => {
    const q = (o.off && o.off[k]) || [0, 0, 0];
    P.setTransform(base.translate(q[0], q[1]).rotate(q[2] / D));
    P.piece(smooth(f.pts), f.col, { id: f.id, lead: 4.5, matW: 8, lit: (o.lit && o.lit(k)) || [1, 0, 0], paint: g => brush(g, [[f.x, 196], [f.x + (f.top[0] - f.x) * .5, (196 + f.top[1]) / 2 + 6], [f.top[0], f.top[1] + 18]], 2, { color: 'rgba(80,20,6,.5)' }) });
  });
  P.setTransform(base);
}
