// 跳水 — shots, camera, registration, plates, events. Every time comes from timeline.js.
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash } from '/core/lib.js';
import * as D from './draw.js';
import { W, H, clear, layer, over, rect, circle, ellipse, poly, blob, line, ring, ink, text } from './draw.js';
import { BEAT, DUR, bt, SHOTS, STEPS, HIT, SPINS, shotAt } from './timeline.js';
import { figure, joints, STAND, runPose, divePose, ENTRY, KO } from './diver.js';

export { DUR };
const PK = [1, 0, 0], CY = [0, 1, 0], VI = [1, 1, 0], WATER = [.25, 1, 0], CON = [.4, 0, 0], PK60 = [.6, 0, 0],
  CY20 = [0, .2, 0], CY40 = [0, .4, 0], CY60 = [0, .6, 0], PAPER = 'rgb(0,0,0)';
const FONT = '"Noto Sans SC"';
const g = () => D.g;
const camM = (z, wx, wy, sx = W / 2, sy = H / 2, rot = 0) => new DOMMatrix().translateSelf(sx, sy).rotateSelf(rot * 180 / Math.PI).scaleSelf(z).translateSelf(-wx, -wy);
const setM = m => g().setTransform(m);

// ───────── events for the mixer (window.EV) ─────────
export const EV = [];
const ev = (b, type, o = {}) => EV.push({ t: +bt(b).toFixed(6), beat: b, type, ...o });
ev(HIT.feed, 'feed'); ev(HIT.plateIn, 'plateIn'); ev(HIT.title, 'title');
SHOTS.slice(1).forEach(([n, b]) => ev(b, 'cut', { shot: n }));
STEPS.forEach((b, i) => ev(b, 'step', { i, dt: (STEPS[i + 1] ?? HIT.takeoff) - b }));
ev(HIT.takeoff, 'takeoff'); SPINS.forEach(b => ev(b, 'spin'));
ev(HIT.violet, 'violet'); ev(HIT.freeze, 'freeze'); ev(HIT.drip, 'drip'); ev(HIT.entry, 'entry');
HIT.drops.forEach((b, i) => ev(b, 'drop', { i })); HIT.rings.forEach((b, i) => ev(b, 'ring', { i }));
ev(HIT.headUp, 'headUp'); ev(HIT.plateOut, 'plateOut'); ev(HIT.final, 'final');
EV.sort((a, b) => a.t - b.t);

// ───────── registration: fixed per shot, kicks on accents, drift through the slow fall, snap on the entry ─────────
const KICKS = [[HIT.plateIn, 11], [HIT.title, 8], ...STEPS.map((b, i) => [b, i < 4 ? 9 : i < 9 ? 7 : 5.5]), [HIT.takeoff, 14],
  [HIT.violet, 10], ...HIT.drops.map(b => [b, 4.5]), ...HIT.rings.map(b => [b, 5]), [HIT.headUp, 7], [HIT.final, 10]];
function regist(t) {
  const k = shotAt(t)[2];
  const off = [[(hash(k * 3.1) - .5) * 2, (hash(k * 5.7) - .5) * 2], [2.5 + (hash(k * 7.3) - .5) * 3, -2 + (hash(k * 9.1) - .5) * 3], [0, 0]];
  for (const [b, amp] of KICKS) {
    const x = Math.max(0, t - bt(b)); if (t < bt(b) - 1e-6 || x > .5) continue;
    const e = Math.exp(-x * 11) * Math.cos(x * 34), a = hash(b * 13.7) * 6.283;
    off[0][0] += Math.cos(a) * amp * e * .5; off[0][1] += Math.sin(a) * amp * e * .5;
    off[1][0] -= Math.cos(a) * amp * e; off[1][1] -= Math.sin(a) * amp * e;
  }
  // drift: grows through the slow-motion flight (≤ 10 px), keeps growing in the frozen bar (≤ 23 px), snaps at the entry
  const E = 1e-6, tf = bt(HIT.takeoff) - E, tz = bt(HIT.freeze) - E, te = bt(HIT.entry) - E;
  let d = 0;
  if (t >= tf && t < tz) d = 10 * ss(seg(t, tf + .4, tz));
  else if (t >= tz && t < te) d = 10 + 13 * ss(seg(t, tz, te - .05));
  else if (t >= te && t < te + .5) d = 23 * Math.exp(-(t - te) * 30) * Math.cos((t - te) * 52) * .25;   // the snap: one small overshoot
  off[0][0] -= 1.0 * d * .7; off[0][1] += .55 * d * .7;
  off[1][0] += 1.0 * d; off[1][1] -= .55 * d;
  return off;
}
// plates: cyan rolled on in the first beat, lifted off at plateOut
function plates(t) {
  const sw = (a, d) => lerp(-60, W + 200, eio(seg(t, a, a + d)));
  return {
    gate: [1, 1, 0],
    sweep: [1e5, !on(t, HIT.plateIn) ? sw(bt(HIT.feed), bt(HIT.plateIn) - bt(HIT.feed)) : 1e5, 1e5],
    sweepOut: [-1e5, on(t, HIT.plateOut) ? sw(bt(HIT.plateOut), BEAT * .75) : -1e5, -1e5],
  };
}

// ───────── helpers ─────────
const twos = t => Math.floor(t * 12 + 1e-6) / 12;
const on = (t, b) => t >= bt(b) - 1e-6;   // has beat b arrived at time t (frame times are exact multiples of 1/24)
// draw the diver: halo = paper knockout ring (pink stays pink); overprint = added onto the plates (pink over cyan → violet)
function diver(P, s, x, y, flip, mode = 'halo') {
  const base = g().getTransform();
  const draw = () => { const G = D.g; G.save(); G.translate(x, y); if (flip) G.scale(-1, 1); figure(P, s); G.restore(); };
  if (mode === 'halo') layer(draw, 5);
  else if (mode === 'over') { layerOver(draw); }
  g().setTransform(base);
}
// a layer composited with 'lighter' (true overprint); the cap (zero ink) adds nothing
const LC = document.createElement('canvas'); LC.width = W; LC.height = H; const LX = LC.getContext('2d');
// the paper cap is collected on KC and knocked out of both plates first, so the head stays solid paper + pink rim on any ground
const KC = document.createElement('canvas'); KC.width = W; KC.height = H; const KX = KC.getContext('2d');
function layerOver(fn) {
  LX.setTransform(1, 0, 0, 1, 0, 0); LX.globalCompositeOperation = 'source-over'; LX.fillStyle = '#000'; LX.fillRect(0, 0, W, H);
  KX.setTransform(1, 0, 0, 1, 0, 0); KX.clearRect(0, 0, W, H);
  LX.setTransform(D.g.getTransform());
  KO.ctx = KX; D.swapG(LX); try { fn(); } finally { D.swapG(null); KO.ctx = null; }
  const G = D.g; G.save(); G.setTransform(1, 0, 0, 1, 0, 0);
  G.globalCompositeOperation = 'source-over'; G.drawImage(KC, 0, 0);    // knockout: zero ink on every plate under the cap
  G.globalCompositeOperation = 'lighter'; G.drawImage(LC, 0, 0); G.restore();
}
// per-plate drawing (each plate its own picture): fn draws white = ink on a black canvas; the result is masked to one channel and added
const PC = document.createElement('canvas'); PC.width = W; PC.height = H; const PX = PC.getContext('2d');
function plateDraw(ch, fn) {
  const m = D.g.getTransform();
  PX.setTransform(1, 0, 0, 1, 0, 0); PX.globalCompositeOperation = 'source-over'; PX.fillStyle = '#000'; PX.fillRect(0, 0, W, H);
  PX.setTransform(m); D.swapG(PX); try { fn(); } finally { D.swapG(null); }
  PX.setTransform(1, 0, 0, 1, 0, 0); PX.globalCompositeOperation = 'multiply'; PX.fillStyle = ch === 0 ? '#f00' : '#0f0'; PX.fillRect(0, 0, W, H);
  const G = D.g; G.save(); G.setTransform(1, 0, 0, 1, 0, 0); G.globalCompositeOperation = 'lighter'; G.drawImage(PC, 0, 0); G.restore();
}
const grey = v => ink(v, v, v);   // inside plateDraw: a density as grey

const VIS = {};   // visual state of the current frame, for the cue check (window.PROBE)
const TXT = [];

// ───────── A · print: the sheet gets printed, pedestal up the tower ─────────
const A = { disc: [1150, 330, 300] };
function shotPrint(t) {
  const k = eio(seg(t, .1, bt(HIT.runCut) - .05));
  const cy = lerp(720, 0, k), z = lerp(1, 1.07, k);
  setM(camM(z, 960, cy + 540));
  // sky bands, bleachers, disc
  rect(-200, 1130, 2400, 90, CY20); rect(-200, 1220, 2400, 80, CY40);
  for (let i = 0; i < 6; i++) rect(-200, 1300 + i * 24, 980 - i * 60, 24, i % 2 ? CY60 : CY40);   // bleachers, stepped
  circle(...A.disc, CY);
  rect(-200, 1440, 2400, 44, CON);                             // deck
  rect(-200, 1484, 2400, 600, WATER);                          // pool
  for (let i = 0; i < 26; i++) { const x = hash(i * 3.3) * 2000 - 40, y = 1520 + hash(i * 7.1) * 250, w = 40 + hash(i * 1.7) * 140; D.rrect(x, y, w, 7, 3.5, PAPER); }
  // tower
  rect(1180, 440, 150, 1000, CON); rect(1292, 440, 38, 1000, PK);
  for (let y = 520; y < 1420; y += 46) rect(1196, y, 30, 7, PAPER);   // ladder rungs
  rect(760, 440, 600, 42, PK); poly([[1180, 482], [1180, 600], [1020, 482]], PK);   // 10 m platform + bracket
  rect(900, 960, 300, 34, PK); poly([[1180, 994], [1180, 1080], [1080, 994]], PK);  // 5 m platform
  for (const x of [1250, 1310]) rect(x, 372, 7, 70, PK); rect(1250, 368, 110, 8, PK);  // railing
  // the diver, small, at the back of the platform, head against the sun
  const s = 150, J = joints(STAND, s), foot = Math.max(...J.legs.map(l => Math.max(l.ank[1], l.toe[1])));
  diver(STAND, s, 1215, 440 - foot - 2, true, 'halo');
  // title on the pink plate, printed on the beat (screen space)
  g().setTransform(1, 0, 0, 1, 0, 0);
  VIS.title = on(t, HIT.title);
  if (VIS.title) {
    text('跳水', 120, 340, `900 230px ${FONT}`, PK, 'left', 'alphabetic', 18);
    TXT.push({ id: 'title', text: '跳水', x0: 120, y0: 340 - 210, x1: 120 + 2 * 248, y1: 360 });
  }
}

// ───────── B · run: lateral tracking along the platform, footfalls accelerate ─────────
const RUN = (() => {
  const tt = [...STEPS, HIT.takeoff].map(bt), X = [0];
  for (let i = 1; i < tt.length; i++) { const dt = tt[i] - tt[i - 1]; X.push(X[i - 1] - (dt > .5 ? 235 : dt > .25 ? 270 : 250)); }
  return { tt, X, edge: X[X.length - 1] - 70 };
})();
function runAt(t) {   // → {x, ph} : hip x, near-leg phase (each footfall = half a cycle)
  const { tt, X } = RUN;
  if (t <= tt[0]) return { x: X[0] + (t - tt[0]) * 200, ph: 0, dt: tt[1] - tt[0] };
  for (let i = 0; i < tt.length - 1; i++) if (t < tt[i + 1] - 1e-6) { const f = (t - tt[i]) / (tt[i + 1] - tt[i]); return { x: lerp(X[i], X[i + 1], f), ph: (i + f) * .5, dt: tt[i + 1] - tt[i], i }; }
  return { x: X[X.length - 1], ph: (tt.length - 1) * .5, dt: .17, i: tt.length - 1 };
}
function shotRun(t) {
  const t0 = bt(HIT.runCut), t1 = bt(HIT.takeoff), k = seg(t, t0, t1);
  let ax = 0; for (let i = 0; i <= 10; i++) ax += runAt(t - .25 + i * .05).x; ax /= 11;   // smoothed follow
  // push in on b10.5 (the sixteenth-note sprint): a hard push on the beat, then a creep into the takeoff — the runner fills ~2/3 of the frame
  const tp = bt(10.5), tq = tp + BEAT * .5;
  const sx = lerp(1180, 980, eio(k)), z = lerp(1, 1.1, ei(k)) * (1 + .42 * eo(seg(t, tp, tq)) + .2 * ss(seg(t, tq, t1)));
  VIS.push = on(t, 10.5);
  const camX = ax - (sx - 960) / z;
  // background (parallax), screen-ish space
  g().setTransform(1, 0, 0, 1, 0, 0);
  const px = -camX * .08;
  rect(0, 560, W, 130, CY20); rect(0, 690, W, 120, CY40); rect(0, 810, W, 90, CY60);
  circle(620 + px, 400, 300, CY);
  setM(camM(z, camX, 0, 960, 900 - 0));
  // far railing along the platform
  for (let x = Math.floor((camX + 1400) / 360) * 360; x > camX - 1500; x -= 360) if (x > RUN.edge + 160) rect(x - 7, -200, 14, 200, PK);
  rect(Math.max(RUN.edge + 150, camX - 1400), -212, (camX + 1500) - Math.max(RUN.edge + 150, camX - 1400), 14, PK);
  // deck slab + the far pool seen below
  rect(camX - 1500, 100, 3000, 400, WATER);
  for (let i = 0; i < 18; i++) { const x = Math.floor(camX / 600) * 600 + (i - 9) * 190 + hash(i) * 60; D.rrect(x, 125 + hash(i * 3) * 50, 60 + hash(i * 5) * 90, 6, 3, PAPER); }
  const R0 = Math.max(RUN.edge, camX - 1500);
  rect(R0, 0, camX + 1500 - R0, 100, PK);
  for (let x = Math.ceil(R0 / 180) * 180; x < camX + 1500; x += 180) rect(x, 8, 5, 84, PAPER);   // slab seams = speed
  // the runner
  const st = runAt(t), ptime = st.dt > .3 ? twos(t) : t, ps = runAt(ptime);
  const s = 470, P = runPose(ps.ph, lerp(.18, .42, ss(k)));
  const J = joints(P, s), foot = Math.max(...J.legs.map(l => Math.max(l.ank[1], l.toe[1])));
  diver(P, s, st.x, -foot - 2, true, 'halo');
  VIS.step = st.i ?? 0;
}

// ───────── C · flight: low angle, takeoff then slow motion, the tuck crosses the sun ─────────
const C = { disc: [860, 470, 380], s: 780, x0: 1440, vx: 763, vy: 535, G: 2141 };
function tauOf(u) {   // action time with the time ramp (real speed, then ≈ 0.24×)
  const sp = v => v < .12 ? 1 : lerp(1, .24, ss(seg(v, .12, .7)));
  const n = 48, h = u / n; let a = 0; for (let i = 0; i < n; i++) a += sp((i + .5) * h) * h; return a;
}
function shotFlight(t) {
  const u = Math.max(0, t - bt(HIT.takeoff));
  const tau = tauOf(u), tp = tauOf(twos(u));
  const y0 = 640 - .49 * C.s;
  const pos = ta => [C.x0 - C.vx * ta, y0 - C.vy * ta + .5 * C.G * ta * ta];
  const [x, y] = pos(tau);
  // camera: starts wide on the platform, then pushes in and rides with the tuck (centre = the waist), rolls a few degrees;
  // eases back out as the body opens, so the straight line still fits
  const Jc = joints(divePose(tp), C.s), wc = [x - Jc.waist[0], y + Jc.waist[1]];
  const w = ss(seg(u, .15, 1.3)) * (1 - .35 * ss(seg(u, 2.7, 3.9)));
  const z = lerp(.78, 1.62, eio(seg(u, .15, 1.9))) - .5 * eio(seg(u, 2.6, 3.95));
  setM(camM(z, lerp(1150, wc[0], w), lerp(420, wc[1], w), 960, 540, lerp(0, .075, eio(seg(u, 0, 4)))));
  rect(-2600, -2600, 7200, 7200, [0, 0, 0]);
  const [dx, dy, r] = C.disc;
  circle(dx, dy, r + 190, CY20); circle(dx, dy, r + 95, CY40); circle(dx, dy, r, CY);
  // platform seen from below (top right)
  poly([[1380, 640], [2600, 640], [2600, 735], [1395, 735]], PK); poly([[1395, 735], [2600, 735], [2600, 790], [1450, 790]], PK60);
  VIS.violet = on(t, HIT.violet);
  diver(divePose(tp), C.s, x, y, true, VIS.violet ? 'over' : 'halo');
  VIS.tau = tau;
}

// ───────── D · freeze: locked composition, horizon + sun + the diver a hand above the water ─────────
const HZ = 760;
function horizonScene(sunR = 430) {
  rect(-800, 590, 3600, 80, CY20); rect(-800, 670, 3600, 90, CY40);
  if (sunR > 0) circle(960, HZ, sunR, CY);
  rect(-800, HZ, 3600, 900, WATER);
  for (let i = 0; i < 30; i++) { const x = hash(i * 2.3) * 2600 - 340, y = HZ + 30 + hash(i * 5.1) ** 1.6 * 300, w = 50 + hash(i * 1.3) * 160; D.rrect(x, y, w, 7, 3.5, PAPER); }
}
function shotFreeze(t) {
  setM(camM(1, 960, 540));
  horizonScene();
  const s = 540, J = joints(ENTRY, s);
  const tip = Math.max(...J.arms.map(a => a.hand[1]));
  diver(ENTRY, s, 960, HZ - 26 - tip, true, 'over');
  VIS.frozen = true;
  return { water: { y: HZ, amp: 5, t: 3.1, sep: .8, refl: .55 } };
}

// ───────── E · entry: snap, violet splash, knockout 「扑通」 ─────────
function splashShape(u) {
  // the crown: a jagged fan of solid violet, and the jet; returns its height for the text
  const gr = eo(seg(u, -.07, .26)), H0 = 640 * gr * (1 - .28 * ss(seg(u, 1.6, 2.7))), Wd = 1000 * Math.sqrt(Math.max(.05, gr)) * (1 + .12 * ss(seg(u, .3, 2.6)));
  if (H0 < 2) return 0;
  const pts = [], N = 90;
  for (let i = 0; i <= N; i++) {
    const f = i / N, xx = (f - .5) * Wd, q = Math.abs(xx) / (Wd / 2);
    const prof = Math.pow(Math.max(0, 1 - q * q), .62);
    let sp = 0;
    for (let j = 0; j < 11; j++) { const c = .06 + .88 * hash(j * 9.7 + 2), w = .016 + .03 * hash(j * 4.4), hgt = (.08 + .26 * hash(j * 2.2)) * (1 - Math.abs(c - .5) * .8); sp += hgt * Math.exp(-Math.pow((f - c) / w, 2)); }
    const jag = (hash(i * 1.37) - .5) * .06;
    const lift = 1 + .08 * ss(seg(u, .3, 2.2)) * (1 - q);
    pts.push([960 + xx, HZ - H0 * prof * (.82 + sp + jag) * lift]);
  }
  pts.push([960 + Wd / 2 + 30, HZ + 20], [960 - Wd / 2 - 30, HZ + 20]);
  poly(pts, VI);
  for (let j = 0; j < 11; j++) {   // a bead of water leaving each tip
    const c = .06 + .88 * hash(j * 9.7 + 2), i = Math.round(c * N), tip = pts[i], q = Math.abs(c - .5) * 2;
    const rise = (60 + 120 * hash(j * 3.1)) * ss(seg(u, .12, .6)) - 40 * ss(seg(u, 1.2, 2.6)), dxj = (c - .5) * 160 * ss(seg(u, .12, 1.4));
    circle(tip[0] + dxj, tip[1] - rise, (9 + 13 * hash(j * 7.7)) * (1 - q * .4) * gr, VI);
  }
  // base foam ellipse
  ellipse(960, HZ + 6, Wd * .62, 34 * gr, 0, VI);
  // jets and droplets on slow parabolas
  for (let i = 0; i < 22; i++) {
    const a = (hash(i * 4.1) - .5) * 2.6, v = 520 + hash(i * 2.9) * 520, uu = Math.max(0, u - .05 - hash(i * 8.3) * .12);
    if (uu <= 0) continue;
    const sl = uu * (uu < .3 ? 1 : .55) + (uu < .3 ? 0 : .3 * .45);   // fast burst, then slow
    const x = 960 + Math.sin(a) * v * sl * 1.1, y = HZ - H0 * .55 - Math.cos(a) * v * sl + 520 * sl * sl;
    if (y > HZ + 10) continue;
    const r = 8 + hash(i * 6.7) * 18;
    circle(x, y, r * (1 - .3 * seg(uu, 1, 2.5)), VI);
  }
  // bubbles of paper inside the crown edges
  for (let i = 0; i < 9; i++) {
    const side = i % 2 ? 1 : -1, xx = 960 + side * (Wd * (.33 + hash(i * 3.9) * .12)), yy = HZ - H0 * (.18 + hash(i * 5.3) * .3);
    circle(xx, yy, (6 + hash(i) * 12) * gr, PAPER);
  }
  return H0;
}
function shotSplash(t) {
  const u = Math.max(0, t - bt(HIT.entry));
  const z = 1 + .13 * Math.exp(-u * 7) - .12 * ss(seg(u, .3, 2.667));
  const sh = Math.exp(-u * 6), dx = 24 * sh * Math.sin(u * 61), dy = 18 * sh * Math.cos(u * 47);
  const M = camM(z, 960, 640, 960 + dx, 640 + dy);
  setM(M);
  // the cyan sun is swallowed on the entry beat: the pink splash lands on it as a solid violet dome (pink × cyan = the third ink),
  // which the crown overtakes by u ≈ .26; after that the sun is gone for good (no sliver can reappear as the crown settles)
  const dome = u < .3;
  horizonScene(dome ? 430 : 0);
  if (dome) { g().beginPath(); g().arc(960, HZ + 2, 452, Math.PI, 0); g().closePath(); D.fill(VI); }
  // the drop rings where droplets land back (cyan knocked out → paper rings in the water)
  HIT.drops.forEach((b, i) => {
    if (!on(t, b)) return; const a = Math.max(0, t - bt(b));
    const x = 960 + (i % 2 ? 1 : -1) * (380 + i * 90), r = 20 + a * 160;
    if (a < 1.5) { g().save(); g().beginPath(); g().ellipse(x, HZ + 40 + i * 18, r, r * .22, 0, 0, Math.PI * 2); g().lineWidth = 7 * (1 - a / 1.5) + 1; g().strokeStyle = PAPER; g().stroke(); g().restore(); }
    if (a < .35) circle(x, HZ + 30 + i * 18 - 70 * Math.sin(Math.PI * a / .35), 10, VI);   // the plink
  });
  const H0 = splashShape(u);
  VIS.splash = H0 > 0; VIS.drops = HIT.drops.filter(b => on(t, b)).length;
  // knockout text: no ink on either plate
  if (H0 > 0) {
    const sc = .62 + .38 * eo(seg(u, -.07, .26)), fs = 245 * sc;
    const ty = HZ - H0 * .46 + 95 * sc;
    text('扑通', 960, ty, `900 ${fs.toFixed(1)}px ${FONT}`, PAPER, 'center', 'alphabetic', 10 * sc);
    const p0 = M.transformPoint({ x: 960 - 265 * sc, y: ty - 225 * sc }), p1 = M.transformPoint({ x: 960 + 265 * sc, y: ty + 30 * sc });
    TXT.push({ id: 'splash', text: '扑通', x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
  }
  // the water line in screen space, for the reflection
  const wy = M.transformPoint({ x: 0, y: HZ }).y;
  return { water: { y: wy, amp: 6, t: u * 2, sep: .25, refl: .35 } };
}

// ───────── F · ripple: straight top-down, rings printed on separate plates, the plate lifts away ─────────
function wob(x, y, r, w, ph, amp) {
  const G = D.g; G.beginPath();
  for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2, rr = r + Math.sin(a * 5 + ph) * amp + Math.sin(a * 3 - ph * 1.3) * amp * .6; const X = x + Math.cos(a) * rr, Y = y + Math.sin(a) * rr; i ? G.lineTo(X, Y) : G.moveTo(X, Y); }
  G.closePath(); G.lineWidth = w; G.stroke();
}
function shotRipple(t) {
  const u = Math.max(0, t - bt(HIT.rippleCut)), k = eio(seg(u, 0, 3.1));
  setM(camM(lerp(1.38, 1.0, k), 960, 540, 960, 540, lerp(.06, 0, k)));
  const tH = bt(HIT.headUp), tF = bt(HIT.final);
  const head = on(t, HIT.headUp) ? Math.max(.08, back(seg(t, tH, tH + .3), 2.2)) : 0;
  const arm = on(t, HIT.final) ? Math.max(.12, back(seg(t, tF, tF + .25), 1.6)) : 0;
  const rings = HIT.rings.filter(b => on(t, b)).map(b => Math.max(0, t - bt(b)));
  const ropes = cb => { for (const yy of [190, 890]) for (let x = -900; x < 2900; x += 46) cb(x, yy); };
  const swimmer = (c, grow = 0) => {   // grow > 0: the paper halo
    if (head <= 0) return;
    const G = D.g; G.fillStyle = grey(c);
    G.beginPath(); G.ellipse(960, 572, (112 + grow) * head, (46 + grow) * head, 0, 0, Math.PI * 2); G.fill();     // shoulders
    G.lineCap = 'round'; G.lineJoin = 'round'; G.strokeStyle = grey(c);
    for (const sd of [-1, 1]) {   // arms: sculling out to the sides, then a V on the final beat
      const sc = Math.sin(t * 5.2 + (sd > 0 ? 0 : 1.3)) * .12, a0 = Math.PI / 2 + .35 + sc, a1 = .55;
      const a = lerp(a0, a1, arm), L1 = 120 * head, L2 = 110 * head;
      const sx = 960 + sd * 98 * head, sy = 572;
      const ex = sx + sd * Math.sin(a) * L1, ey = sy - Math.cos(a) * L1, hx = ex + sd * Math.sin(a - .35 * (1 - arm)) * L2, hy = ey - Math.cos(a - .35 * (1 - arm)) * L2;
      G.lineWidth = (34 + grow * 2) * head; G.beginPath(); G.moveTo(sx, sy); G.lineTo(ex, ey); G.lineTo(hx, hy); G.stroke();
      G.beginPath(); G.arc(hx, hy, (22 + grow) * head, 0, Math.PI * 2); G.fill();
    }
    G.beginPath(); G.arc(960, 545, (54 + grow) * head, 0, Math.PI * 2); G.fill();                                  // head
  };
  // cyan plate: the water, minus paper rings, minus the floats' and swimmer's halos
  plateDraw(1, () => {
    const G = D.g; G.fillStyle = grey(1); G.fillRect(-1200, -1200, 4400, 3600);
    G.strokeStyle = grey(0);
    rings.forEach(a => { if (a < 3.2) wob(960, 540, 60 + 420 * Math.pow(a, .7), 16 * (1 - a / 3.4) + 3, a * 2.1, 6); });
    if (u < .9) { G.lineWidth = 1; }
    ropes((x, y) => circle(x, y, 19, grey(0)));
    swimmer(0, 9);
  });
  // pink plate: a tint over the whole water, the lane line, the rings on their own phase, the floats, the swimmer
  plateDraw(0, () => {
    const G = D.g; G.fillStyle = grey(.25); G.fillRect(-1200, -1200, 4400, 3600);
    G.fillStyle = grey(.55); G.fillRect(-1200, 515, 4400, 50); G.fillRect(1640, 430, 50, 220); G.fillRect(230, 430, 50, 220);
    G.strokeStyle = grey(1);
    rings.forEach(a => { if (a < 3.2) wob(960, 540, 72 + 420 * Math.pow(a, .7), 11 * (1 - a / 3.4) + 2, a * 2.1 + 2.4, 9); });
    ropes((x, y) => circle(x, y, 13, grey(1)));
    swimmer(0, 9); swimmer(1);
    if (head > 0) { G.fillStyle = grey(0); G.beginPath(); G.ellipse(958, 538, 44 * head, 40 * head, 0, 0, Math.PI * 2); G.fill(); }   // the cap from above
  });
  // the crown that came from the splash: both plates, solid, shrinking into the first ring (shape match)
  if (u < .7) { const r = 300 + u * 260, w = 150 * (1 - u / .7); D.g.lineWidth = w; D.g.strokeStyle = ink(...VI); D.g.beginPath(); D.g.arc(960, 540, r, 0, Math.PI * 2); D.g.stroke(); }
  VIS.rings = rings.length; VIS.head = head > 0; VIS.arm = arm > 0;
}

const SHOT = { print: shotPrint, run: shotRun, flight: shotFlight, freeze: shotFreeze, splash: shotSplash, ripple: shotRipple };

export function renderFilm(t) {
  for (const k in VIS) delete VIS[k]; TXT.length = 0;
  clear();
  const [name, , si] = shotAt(t);
  g().setTransform(1, 0, 0, 1, 0, 0);
  const o = SHOT[name](t) || {};
  g().setTransform(1, 0, 0, 1, 0, 0);
  const p = plates(t);
  VIS.shot = name; VIS.cyanIn = p.sweep[1] >= W + 199; VIS.cyanOut = p.sweepOut[1] > -1e4;
  const off = regist(t);
  VIS.reg = Math.hypot(off[1][0] - off[0][0], off[1][1] - off[0][1]);
  return {
    seed: Math.floor(t * 12 + 1e-6), sheet: si * 3.7 + 1.1,
    off, rot: [0, .0005, 0], period: 7, grain: .6, boil: .33,
    gate: p.gate, sweep: p.sweep, sweepOut: p.sweepOut, water: o.water || null,
  };
}
export const probe = () => ({ ...VIS });
export const texts = () => TXT.map(x => ({ ...x }));
