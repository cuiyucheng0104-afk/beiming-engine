// 明日早晨 — a 1950s kitchen prints itself, runs its three morning steps, stops, races, and freezes into a textile.
// Deterministic: everything is a function of t (timeline.js is the only clock).
import { PAL, setClock, reg, REG, shape, ink, plane, text, measure, star, sparkle, rays, starPts, spline, ellipse, rect, rrect,
  move, xform, path, bbox, subpath, dashed, arrow, kidney, boomerang, paperFinish, hash, clamp, lerp, seg, ss, eo, eio, back, TAU } from './engine/toon.js';
import { drawHand } from './engine/hand.js';
import { HIT, bt, beatAt, twosB, SEC, FPS, DUR, BEAT_F } from './timeline.js';

export const W = 1920, H = 1080;
const P = {
  paper: '#EFE3C8', paperD: '#E0D1B0', paperDD: '#C9B892', cream: '#FAF3E3', ink: '#2B2420',
  tomato: '#D9573B', tomatoD: '#AE4129', tomatoL: '#EE9277',
  olive: '#8E8C3A', oliveD: '#6E6C27', oliveL: '#C2C07C',
  blue: '#9CC2C6', blueT: '#C6DEDD', blueD: '#7FA7AC', blueDD: '#628A90',
  mustard: '#E2A93A', mustardD: '#B9831E', mustardL: '#F2D58E',
  coffee: '#5A3925', coffeeL: '#86573A', toast: '#E8C07A', crust: '#B5763A',
  chrome: '#D9D3C3', chromeD: '#ABA593',
};
const C0 = [960, 540];                // rosette centre in kitchen world
let LS = 1;                            // native line scale (1 / zoom)
let REC = null;                        // text recorder for TEXTS()
let ST = null;                         // per-frame state
const tb = n => bt(HIT[n]);
const B = b => bt(b);
const F = 1 / FPS;
const D0 = SEC.D, E0 = SEC.E;          // first beat of the accelerando / ornament

// ------------------------------------------------------------------ events (sound + cue)
const EVS = [];
const ev = (t, type, o = {}) => EVS.push({ t: +t.toFixed(5), type, ...o });
export function events() {
  if (EVS.length) return EVS;
  ev(0, 'pen', { dur: B(2) });
  ['plateWall', 'plateFloor', 'plateCounter', 'plateMachine'].forEach((k, i) => ev(tb(k), 'stamp', { i }));
  ev(tb('sun'), 'sun');
  for (let b = 6; b < 24; b++) ev(B(b), 'tick', { b });
  ev(tb('leverUp'), 'lever_up');
  ev(tb('lever'), 'lever'); ev(tb('lever'), 'heat', { dur: B(10) - B(8) });
  ev(tb('pop'), 'pop'); ev(tb('pop'), 'callout'); ev(tb('pop'), 'tagpop');
  ev(tb('medal1'), 'land'); ev(tb('medal1'), 'medal', { n: 1 });
  ev(tb('knob'), 'knob'); ev(tb('pour'), 'pour', { dur: B(15) - B(13) });
  ev(tb('call2'), 'callout'); ev(tb('call2'), 'tagpop');
  ev(tb('medal2'), 'clink'); ev(tb('medal2'), 'medal', { n: 2 });
  ev(tb('hatch'), 'hatch'); ev(tb('arm'), 'arm', { dur: B(18) - B(17) });
  ev(tb('paper'), 'paper'); ev(tb('paper'), 'callout'); ev(tb('paper'), 'tagpop');
  ev(tb('medal3'), 'medal', { n: 3 }); ev(tb('medal3'), 'retract');
  ev(tb('wide'), 'swish'); ev(tb('wide'), 'arrow'); ev(B(21), 'arrow');
  ev(B(22), 'hop', { n: 1 }); ev(B(22.6), 'hop', { n: 2 }); ev(B(23), 'hop', { n: 3 });
  ev(tb('ready'), 'ready');
  ev(tb('stop'), 'stop');
  ev(B(25), 'silence', { dur: B(28) - B(25) });
  ev(tb('ding'), 'ding');
  for (let i = 0; i < 16; i++) ev(B(D0 + i), 'cyc', { i, dur: B(D0 + i + 1) - B(D0 + i), last: i === 15 });
  ev(tb('freeze'), 'freeze'); ev(tb('freeze'), 'wipe', { dur: tb('fold') - B(44) });
  ev(tb('fold'), 'fold', { dur: B(45) - tb('fold') });   // swung off-beat b44.6 = frame 405
  ev(tb('petals'), 'fan', { dur: B(46) - B(45) });
  ev(tb('lock'), 'lock'); ev(tb('lock'), 'title');
  ev(tb('ring1'), 'ring', { n: 1 }); ev(tb('ring2'), 'ring', { n: 2 });
  ev(tb('button'), 'button');
  EVS.sort((a, b) => a.t - b.t);
  return EVS;
}

// ------------------------------------------------------------------ helpers
const pop = (t, t0, d = 0.26) => back(seg(t, t0, t0 + d), 1.9);
function keys(t, K) {          // piecewise eased keyframes [[t, [v...], ease?], ...]
  if (t <= K[0][0]) return K[0][1];
  for (let i = 0; i < K.length - 1; i++) {
    const [ta, va] = K[i], [tb2, vb, e] = K[i + 1];
    if (t <= tb2) { const u = (e || eio)(seg(t, ta, tb2)); return va.map((v, j) => lerp(v, vb[j], u)); }
  }
  return K[K.length - 1][1];
}
const pol = (r, deg) => { const a = deg * Math.PI / 180; return [C0[0] + r * Math.sin(a), C0[1] - r * Math.cos(a)]; };
function resample(pts, n) { const out = []; for (let i = 0; i < n; i++) { const s = subpath(pts, i / (n - 1)); out.push(s[s.length - 1]); } return out; }
const lerpPts = (A, Bp, m) => A.map((p, i) => [lerp(p[0], Bp[i][0], m), lerp(p[1], Bp[i][1], m)]);
function rec(ctx, id, str, x0, y0, x1, y1) {
  if (!REC) return;
  const M = ctx.getTransform(), c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f]);
  const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  REC.push({ id, text: str, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
}

// ------------------------------------------------------------------ camera (one world → screen function)
function camAt(t) {
  if (t < B(SEC.B)) { const u = ss(seg(t, 0, B(8))); return { cx: 960, cy: lerp(540, 548, u), s: lerp(1, 1.07, u), r: 0 }; }
  if (t < B(SEC.C)) {
    const v = keys(t, [[B(8), [960, 548, 1.07]], [B(9), [860, 560, 1.1]], [B(11.4), [860, 560, 1.1]], [B(12), [960, 560, 1.1]],
      [B(15.4), [960, 560, 1.1]], [B(16), [1060, 560, 1.1]], [B(20), [1060, 560, 1.1]], [B(21), [960, 540, 1.0]]]);
    return { cx: v[0], cy: v[1], s: v[2], r: 0 };
  }
  if (t < B(D0)) {   // creep in on the hanging drop during the silence
    const u = 1 - Math.pow(1 - seg(t, B(24), B(28)), 2.2);   // b25 ≈ 1.9×, b27 ≈ 2.9×, then settles for the bell
    const v = [lerp(960, DROP_CAM[0], u), lerp(540, DROP_CAM[1], u), lerp(1.0, DROP_CAM[2], u)];
    return { cx: v[0], cy: v[1], s: v[2], r: 0 };
  }
  if (t < B(E0)) {   // stepped pull-back: one notch per beat, the stand rocks tick-tock
    const i = Math.min(15, Math.floor(beatAt(t) + 1e-9) - D0), t0 = B(D0 + i);
    const tgt = j => j < 0 ? [...DROP_CAM, 0] : j < 8 ? [lerp(DROP_CAM[0], 960, (j + 1) / 8), lerp(DROP_CAM[1], 540, (j + 1) / 8), lerp(DROP_CAM[2], 1.0, (j + 1) / 8), j >= 4 ? (j % 2 ? 1 : -1) * 0.012 : 0]
      : [960, 540, 1.0 + 0.018 * Math.max(0, j - 11), (j % 2 ? 1 : -1) * 0.014];
    const a = tgt(i - 1), b = tgt(i), u = eo(seg(t, t0, t0 + 3 * F));
    const pulse = 0.022 * Math.exp(-(t - t0) * 16);
    return { cx: lerp(a[0], b[0], u), cy: lerp(a[1], b[1], u), s: lerp(a[2], b[2], u) * (1 + pulse), r: lerp(a[3], b[3], u) };
  }
  // ornament: hold → pull-back with counter-rotation → slow pull to the wallpaper, then dead still
  const rEnd = 0.014 * -1;   // D ends on an even j=15 → +0.014; continue from there
  const v = keys(t, [[B(44), [1.072, 0.014]], [B(45), [1.0, 0.014], eo], [B(46), [0.82, -0.0], u => eio(u)], [B(50), [0.5, 0.0], easeLand]]);
  const rr = t >= B(45) && t < B(46) ? -0.32 * Math.sin(Math.PI * eio(seg(t, B(45), B(46)))) * 1 : 0;
  return { cx: 960, cy: 540, s: v[0], r: v[1] + rr + rEnd * 0 };
}
const ei3 = u => u * u * u;
// front-loaded with a long, soft landing: zero speed at both ends, peak at 1/3 → the wallpaper visibly brakes into b50
const easeLand = u => { u = clamp(u); return 1 - Math.pow(1 - u, 3) * (1 + 3 * u); };
const DROP_CAM = [1082, 566, 3.0];   // shot 4 ends here: spout + the hanging drop centred; at b27 (2.9×) the drop is ≈ 1/10 frame height
const T_HOLD = () => B(50);           // from the last note on: a dead-still frame (camera, cel jitter, twinkles, stars)
function applyCam(ctx, c) { ctx.translate(W / 2, H / 2); ctx.scale(c.s, c.s); ctx.rotate(c.r); ctx.translate(-c.cx, -c.cy); }

// ------------------------------------------------------------------ style wrappers
// plates: colour cels stamp in one by one in the opening; offset settles from wide to registered
function plateK(name) { const k = ST.plates[name]; return k; }
function sh(ctx, pts, o = {}) {
  const seed = o.seed ?? 1, pk = o.plate === false ? 1 : plateK(o.plate || 'machine');
  if (o.fill && pk != null) {
    const r0 = reg(seed), e = 1 - eo(pk);
    shape(ctx, pts, { fill: o.fill, line: 0, off: [r0[0] + e * 40 * LS, r0[1] + e * 30 * LS], shade: o.shade, grain: o.grain ?? 0.3, alpha: o.alpha ?? 1 });
  }
  if ((o.line ?? 4) > 0) {
    let up = 1;
    if (ST.inkU < 1) { const bb = bbox(pts); up = clamp((ST.inkU - ((bb[0] + bb[2]) / 2 / 1920) * 0.5) / 0.5); }
    if (up > 0) ink(ctx, pts, (o.line ?? 4) * LS, { closed: o.closed ?? true, upto: up, breaks: o.breaks ?? 0.16, seed, wob: 0.4, color: o.lineColor || P.ink, alpha: o.alpha ?? 1 });
  }
}
function ln(ctx, pts, w, o = {}) {   // open ink stroke that respects the opening draw-on
  let up = o.upto ?? 1;
  if (ST.inkU < 1) { const bb = bbox(pts); up = Math.min(up, clamp((ST.inkU - ((bb[0] + bb[2]) / 2 / 1920) * 0.5) / 0.5)); }
  if (up > 0) ink(ctx, pts, w * LS, { upto: up, breaks: o.breaks ?? 0.15, seed: o.seed ?? 3, color: o.color || P.ink, taper: o.taper ?? true, wob: o.wob ?? 0.4, alpha: o.alpha ?? 1 });
}
function txt(ctx, id, str, x, y, o) {   // two-plate lettering + record its box
  text(ctx, str, x, y, o);
  if (REC) {
    const w = measure(ctx, str, o.font, o.track || 0), px = parseFloat(o.font.match(/(\d+(\.\d+)?)px/)[1]);
    const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    rec(ctx, id, str, x0, y - px * 0.88, x0 + w, y + px * 0.18);
  }
}

// ------------------------------------------------------------------ props
function toastSlice(ctx, x, y, rot, s = 1, seed = 40, o = {}) {
  const base = [[-50, 52], [-50, -18], [-63, -36], [-52, -58], [-22, -66], [0, -60], [22, -66], [52, -58], [63, -36], [50, -18], [50, 52]];
  const pts = xform(spline(base, true, 6), x, y, rot, s);
  const inner = xform(spline(base.map(([a, b]) => [a * 0.8, b * 0.8 + 3]), true, 6), x, y, rot, s);
  sh(ctx, pts, { fill: P.crust, line: 3.6, seed, plate: o.plate ?? 'machine', shade: [{ pts: inner, color: o.light ? P.mustardL : P.toast }], grain: 0.4 });
}
function toastSlab(ctx, x, y, w, seed) { sh(ctx, rrect(x - w / 2, y - 13, w, 13, 6), { fill: P.toast, line: 2.8, seed, plate: 'machine', shade: [{ pts: rect(x - w / 2, y - 4, w, 4), color: P.crust }] }); }
function paperSlab(ctx, x, y, seed) { sh(ctx, rrect(x - 80, y - 16, 160, 16, 5), { fill: P.cream, line: 2.8, seed, plate: 'counter', breaks: 0.1, shade: [{ pts: rect(x - 80, y - 6, 160, 6), color: P.paperD }] }); ln(ctx, [[x - 68, y - 10], [x - 18, y - 10]], 4, { seed, taper: false }); }
function newspaper(ctx, x, y, rot, s = 1, seed = 60) {   // folded paper held by its edge
  const pts = xform(rect(-70, -46, 140, 92), x, y, rot, s);
  sh(ctx, pts, { fill: P.cream, line: 3.4, seed, plate: 'counter', shade: [{ pts: xform(rect(-70, 20, 140, 26), x, y, rot, s), color: P.paperD }] });
  for (let i = 0; i < 3; i++) ln(ctx, xform([[-56, -24 + i * 14], [i ? 52 : 6, -24 + i * 14]], x, y, rot, s), i ? 2.2 : 5, { seed: seed + i, taper: false });
}
function cup(ctx, x, y, s = 1, seed = 80, rot = 0) {   // (x, y) = bottom centre
  const body = xform(spline([[-40, -46], [40, -46], [34, -6], [22, 0], [-22, 0], [-34, -6]], true, 5), x, y, rot, s);
  ink(ctx, xform(ellipse(44, -26, 13, 13, 20), x, y, rot, s), 6 * LS * s, { closed: true, seed: seed + 1 });
  sh(ctx, body, { fill: P.cream, line: 3.6, seed, plate: 'counter', shade: [{ pts: xform(rect(-40, -34, 80, 10), x, y, rot, s), color: P.olive }] });
}

function clockAt(ctx, t, x, y, k = 1) {
  sh(ctx, starPts(x, y, 80 * k, 12, 0.72, 0), { fill: P.olive, line: 3.6, seed: 120, plate: 'counter' });
  sh(ctx, ellipse(x, y, 46 * k, 46 * k, 36), { fill: P.cream, line: 3.4, seed: 121, plate: 'counter' });
  const bAt = beatAt(t);
  let sec = 0, min = 0;
  if (bAt >= 6) sec = Math.floor(Math.min(bAt, 28) - 6 + 1e-9) * TAU / 12;   // ticks on the beat
  if (bAt >= 28) { const q = Math.min(bAt, 44) - 28; sec += q * TAU; min = q * TAU / 8; }
  if (t >= B(44)) sec = 16 * TAU + 22 * TAU / 12, min = 2 * TAU;
  const hand = (a, L, w, col) => ln(ctx, [[x, y], [x + Math.sin(a) * L * k, y - Math.cos(a) * L * k]], w, { color: col, taper: false, seed: 122 });
  hand(TAU * 7 / 12 + min / 12, 24, 6, P.ink); hand(min, 36, 4.5, P.ink); hand(sec, 40, 2.6, P.tomato);
  shape(ctx, ellipse(x, y, 5 * k, 5 * k, 10), { fill: P.ink, line: 0, off: [0, 0], grain: 0 });
}

function windowSun(ctx, t) {
  sh(ctx, rrect(1110, 100, 240, 300, 70), { fill: P.cream, line: 4, seed: 130, plate: 'counter' });
  const glass = rrect(1132, 122, 196, 256, 52);
  sh(ctx, glass, { fill: P.mustardL, line: 0, seed: 131, plate: 'wall' });
  if (plateK('machine') != null) {
    const u = eo(seg(twosB(t), tb('sun'), tb('sun') + 0.55));
    const sy = lerp(430, 268, u);
    ctx.save(); path(ctx, glass); ctx.clip();
    rays(ctx, 1230, sy, 26, 260, P.cream, { alpha: 0.6 * u, rot: t * 0.25 });
    sh(ctx, ellipse(1230, sy, 52, 52, 30), { fill: P.mustard, line: 3.4, seed: 132, plate: 'machine' });
    ctx.restore();
  }
  ink(ctx, glass, 3.4 * LS, { closed: true, seed: 133, breaks: 0.2, upto: ST.inkU < 1 ? clamp((ST.inkU - 0.32) / 0.5) : 1 });
  ln(ctx, [[1230, 124], [1230, 376]], 3.4, { seed: 134, taper: false }); ln(ctx, [[1134, 262], [1326, 262]], 3.4, { seed: 135, taper: false });
}

function counter(ctx) {
  sh(ctx, rect(-1600, 690, 5120, 46), { fill: P.olive, line: 0, seed: 140, plate: 'counter', shade: [{ pts: rect(-1600, 722, 5120, 14), color: P.oliveD }] });
  ln(ctx, [[-300, 690], [2220, 690]], 4.5, { breaks: 0.28, seed: 141, taper: false });
  ln(ctx, [[-300, 736], [2220, 736]], 4, { breaks: 0.32, seed: 142, taper: false });
  for (const x of [205, 705, 1215, 1715]) ln(ctx, [[x, 750], [x, 1180]], 3, { breaks: 0.3, seed: 143 + x, taper: false });
  [455, 960, 1465].forEach((x, i) => sh(ctx, boomerang(x, 790, 30, 0.1 * (i - 1)), { fill: P.cream, line: 3, seed: 150 + i, plate: 'counter' }));
}

// toaster: body held, only the lever and the toast move
function toaster(ctx, t, s) {
  // toasts in the slots (behind the body)
  for (const ty of s.inSlot) { toastSlice(ctx, ty.x, 500 - ty.up, 0, 0.92, 41 + ty.x); }
  const body = rrect(250, 450, 360, 240, 84);
  sh(ctx, body, { fill: P.tomato, line: 4.6, seed: 160, shade: [{ pts: rect(470, 430, 160, 280), color: P.tomatoD, alpha: 0.5 }] });
  sh(ctx, rrect(262, 636, 336, 32, 14), { fill: P.chrome, line: 3.2, seed: 161, plate: 'counter' });
  for (const x of [300, 460]) sh(ctx, rrect(x, 444, 100, 13, 6), { fill: P.ink, line: 0, seed: 162 + x, plate: 'machine' });
  ln(ctx, [[624, 506], [624, 640]], 5, { seed: 165, taper: false });
  const ly = lerp(508, 620, s.lever);
  sh(ctx, rrect(606, ly - 10, 46, 22, 9), { fill: P.mustard, line: 3.2, seed: 166 });
  sh(ctx, ellipse(318, 545, 20, 20, 24), { fill: P.cream, line: 3, seed: 167, plate: 'counter' });
  ln(ctx, [[318, 545], [318 + 12 * Math.cos(-0.6), 545 + 12 * Math.sin(-0.6)]], 3, { seed: 168, taper: false });
  for (const x of [292, 568]) sh(ctx, rrect(x - 16, 686, 32, 10, 4), { fill: P.ink, line: 0, seed: 169 + x });
  if (s.heat > 0) {   // heat shimmer on twos
    const f = Math.floor(twosB(t) * 12);
    for (const x of [350, 510]) for (let j = 0; j < 2; j++) {
      const pts = []; for (let k = 0; k <= 10; k++) pts.push([x - 18 + j * 36 + Math.sin(k * 0.9 + f * 1.7 + j) * 7, 430 - k * 8]);
      ln(ctx, pts, 3, { color: P.tomatoL, seed: 170 + j + f, alpha: s.heat, taper: true });
    }
  }
}
function toastPlate(ctx, n) {
  sh(ctx, ellipse(690, 686, 78, 13, 30), { fill: P.cream, line: 3.4, seed: 175, plate: 'counter' });
  for (let j = 0; j < n; j++) toastSlab(ctx, 690 + (hash(j, 3) - 0.5) * 16, 684 - j * 13, 116, 176 + j);
}

// coffee percolator on a stand: tank held, the valve knob turns, the spout pours
function coffeeMachine(ctx, t, s) {
  sh(ctx, rrect(850, 646, 290, 44, 16), { fill: P.chrome, line: 3.6, seed: 180, plate: 'counter', shade: [{ pts: rect(850, 676, 290, 14), color: P.chromeD }] });
  sh(ctx, rect(934, 574, 52, 76), { fill: P.chrome, line: 3.4, seed: 181, plate: 'counter' });
  // spout
  sh(ctx, spline([[1036, 500], [1076, 500], [1092, 518], [1092, 552], [1072, 552], [1072, 524], [1036, 524]], true, 4), { fill: P.chrome, line: 3.4, seed: 182, plate: 'counter' });
  const tank = rrect(866, 330, 188, 252, 46);
  sh(ctx, tank, { fill: P.tomato, line: 4.6, seed: 183, shade: [{ pts: rect(990, 320, 80, 270), color: P.tomatoD, alpha: 0.5 }] });
  sh(ctx, ellipse(960, 334, 96, 64, 40, Math.PI, TAU), { fill: P.chrome, line: 4, seed: 184, plate: 'counter' });
  sh(ctx, ellipse(960, 266, 17, 17, 20), { fill: P.mustard, line: 3.4, seed: 185 });
  sparkle(ctx, 960, 236, 16, { fill: P.cream, rot: 0 });
  // level window
  sh(ctx, rrect(896, 372, 22, 150, 11), { fill: P.coffeeL, line: 3, seed: 186, plate: 'counter' });
  // valve knob (left): turns a quarter on its beat
  ctx.save(); ctx.translate(858, 458); ctx.rotate(s.knob * Math.PI / 2);
  sh(ctx, xform(rrect(-34, -9, 68, 18, 9), 0, 0), { fill: P.mustard, line: 3.2, seed: 187 });
  ctx.restore();
  sh(ctx, ellipse(858, 458, 10, 10, 14), { fill: P.ink, line: 0, seed: 188 });
}
function stream(ctx, t, y0, y1, w, seed = 190) {
  if (y1 <= y0 + 1) return;
  const f = Math.floor(twosB(t) * 12), pts = [];
  for (let k = 0; k <= 8; k++) { const y = lerp(y0, y1, k / 8); pts.push([1082 + Math.sin(k * 1.3 + f) * 2.5, y]); }
  ink(ctx, pts, (w + 6) * LS * 0 + w + 5 * LS, { color: P.ink, taper: false, seed, wob: 0.2 });
  ink(ctx, move(pts, reg(seed)[0] * 0.5, reg(seed)[1] * 0.5), w, { color: P.coffee, taper: false, seed: seed + 1, wob: 0.2 });
}

// newspaper delivery arm: lazy tongs out of a wall hatch, a glove at the tip
function hatch(ctx, s) {
  sh(ctx, rrect(1570, 330, 140, 140, 26), { fill: P.tomato, line: 4.4, seed: 200, shade: [{ pts: rect(1660, 320, 60, 160), color: P.tomatoD, alpha: 0.5 }] });
  sh(ctx, rrect(1594, 354, 92, 92, 14), { fill: P.ink, line: 0, seed: 201 });
  // door flips down from its bottom hinge (scaleY 1 → -0.35)
  const k = lerp(1, -0.3, s.door);
  const door = rrect(1594, 354, 92, 92, 14).map(([x, y]) => [x, 446 - (446 - y) * k]);
  sh(ctx, door, { fill: P.cream, line: 3.4, seed: 202, plate: 'counter' });
}
function tongs(ctx, P0, tip, o = {}) {
  const n = 4, Lh = o.Lh ?? 62, dx = tip[0] - P0[0], dy = tip[1] - P0[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const sg = L / n, hw = Math.sqrt(Math.max(36, Lh * Lh - (sg / 2) * (sg / 2)));
  const pts = []; // zigzag rails
  const top = [], bot = [];
  for (let i = 0; i <= n; i++) {
    const ax = P0[0] + ux * sg * i, ay = P0[1] + uy * sg * i;
    top.push([ax, ay]); bot.push([ax, ay]);
    if (i < n) { const mx = ax + ux * sg / 2, my = ay + uy * sg / 2; top.push([mx + nx * hw, my + ny * hw]); bot.push([mx - nx * hw, my - ny * hw]); }
  }
  const col = o.ghost ? null : P.chrome;
  for (const rail of [top, bot]) {
    if (o.ghost) { ink(ctx, rail, 2.6 * LS, { color: o.ghost, taper: false, seed: 210, wob: 0.2, alpha: o.alpha ?? 1, breaks: 0.15 }); continue; }
    ink(ctx, rail, 12 * LS, { color: P.ink, taper: false, seed: 211, wob: 0.1 });
    const r0 = reg(212); ink(ctx, move(rail, r0[0] * 0.5, r0[1] * 0.5), 6 * LS, { color: col, taper: false, seed: 213, wob: 0.05 });
  }
  if (!o.ghost) for (const p of [...top, ...bot]) shape(ctx, ellipse(p[0], p[1], 4.5 * LS, 4.5 * LS, 10), { fill: P.ink, line: 0, off: [0, 0], grain: 0 });
  return Math.atan2(dy, dx);
}
function armAt(ctx, P0, tip, kind, paper, paperRot) {
  const a = tongs(ctx, P0, tip);
  if (paper) newspaper(ctx, tip[0] + Math.cos(a) * 40, tip[1] + Math.sin(a) * 40 + 30, paperRot ?? 0, 0.9, 61);
  drawHand(ctx, tip[0], tip[1], a, kind, 1, 1.5, { lw: LS });
}

// ------------------------------------------------------------------ manual graphics
function medallion(ctx, t, tS, x, y, n, r = 52) {
  let k = pop(t, tS, 0.24); if (k <= 0) return;
  const hop = [B(22), B(22.6), B(23)][n - 1];   // swung off-beat: 60 % of the beat = 6 frames
  k *= 1 + 0.16 * Math.sin(Math.PI * seg(t, hop, hop + 0.2));
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.rotate((1 - Math.min(1, k)) * 0.5);
  star(ctx, 0, 0, r * 1.24, { n: 16, inner: 0.82, fill: P.cream, rot: n * 0.2 });
  ink(ctx, starPts(0, 0, r * 1.24, 16, 0.82, n * 0.2), 3 * LS, { closed: true, seed: 300 + n, breaks: 0.2 });
  shape(ctx, ellipse(0, 0, r, r, 48), { fill: P.mustard, line: 4.5 * LS, seed: 310 + n, grain: 0.3 });
  txt(ctx, 'medal' + n, String(n), 0, r * 0.4, { font: `${Math.round(r * 1.12)}px Slab`, fill: P.ink, plate: P.cream, off: [4 * LS, 4 * LS], align: 'center' });
  ctx.restore();
}
function callout(ctx, t, t0, t1, cx, cy, r, bgc, leader, inner) {
  let k = back(seg(t, t0, t0 + 0.3), 1.5); if (t1 != null && t >= t1) k *= 1 - eo(seg(t, t1, t1 + 3 * F));
  if (k <= 0.002) return 0;
  const R = r * k;
  if (leader) {
    const a = Math.atan2(leader[1] - cy, leader[0] - cx);
    dashed(ctx, [[cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16)], leader], 4 * LS, 14, 10, -t * 40, P.ink, clamp(k));
    shape(ctx, ellipse(leader[0], leader[1], 8, 8, 12), { fill: P.ink, line: 0, off: [0, 0], grain: 0 });
  }
  shape(ctx, ellipse(cx, cy, R + 15, R + 15, 72), { fill: P.cream, line: 4.5 * LS, seed: 320, grain: 0.15, breaks: 0.05 });
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  ctx.fillStyle = bgc; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  ctx.translate(cx, cy); ctx.scale(k, k); inner(ctx); ctx.restore();
  ink(ctx, ellipse(cx, cy, R, R, 72), 4 * LS, { closed: true, seed: 321, breaks: 0.1 });
  return k;
}
function tag(ctx, t, t0, t1, id, str, x, y) {
  let k = pop(t, t0); if (t1 != null && t >= t1) k *= 1 - eo(seg(t, t1, t1 + 3 * F)); if (k <= 0.002) return;
  const font = '700 44px NotoSC', w = measure(ctx, str, font) + 92, h = 70;
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.scale(k, k); ctx.translate(-(x + w / 2), -(y + h / 2));
  shape(ctx, rrect(x, y, w, h, 14), { fill: P.cream, line: 3.6 * LS, seed: 330, grain: 0.15, off: [6 * LS, 5 * LS] });
  star(ctx, x + 36, y + h / 2, 16, { n: 8, inner: 0.42, fill: P.mustard, off: [0, 0], rot: t * 0.6 });
  txt(ctx, id, str, x + 62, y + h / 2 + 16, { font, fill: P.ink });
  ctx.restore();
}

// ------------------------------------------------------------------ the accelerando cycles (deterministic paths)
const DC = [];   // per cycle: start, end, toast path, curl path, arm target
for (let i = 0; i < 16; i++) {
  const t0 = bt(D0 + i), t1 = bt(D0 + i + 1), last = i === 15;
  const x0 = i % 2 ? 510 : 350, y0 = 448, x1 = 690 + (hash(i, 3) - 0.5) * 16, y1 = 684 - 13 * (i + 1) + 6;
  const Hh = last ? 0 : 170 + 110 * hash(i, 9);
  const toast = []; for (let k = 0; k <= 30; k++) { const u = k / 30; toast.push([lerp(x0, x1, u), lerp(y0, y1, u) - 4 * Hh * u * (1 - u)]); }
  if (last) { toast.length = 0; for (let k = 0; k <= 30; k++) { const u = k / 30; toast.push([lerp(510, 640, u), 448 - (448 - 128) * (1 - (1 - u) * (1 - u))]); } }
  const curl = []; const cx0 = 1080 + (hash(i, 5) - 0.5) * 14, drift = (hash(i, 6) - 0.5) * 150, amp = 14 + 10 * hash(i, 7);
  for (let k = 0; k <= 28; k++) { const u = k / 28; curl.push([cx0 + amp * Math.sin(u * 2.6 * Math.PI + i * 1.3) + u * drift, 590 - 250 * u]); }
  const end = curl[curl.length - 1], dir = drift >= 0 ? 1 : -1;
  for (let k = 1; k <= 14; k++) { const a = -Math.PI / 2 + dir * k / 14 * TAU * 0.9, rr = 22 * (1 - k / 20); curl.push([end[0] + dir * 18 + Math.cos(a + Math.PI) * rr * dir, end[1] + Math.sin(a) * rr + 18]); }
  const tgt = last ? [1236, 452] : [1400 + (hash(i, 8) - 0.5) * 30, 684 - 12 * i - 40];
  DC.push({ t0, t1, d: t1 - t0, toast, curl, tgt, last });
}
const HATCH = [1640, 400];
const tPaperDrop = c => c.t0 + 0.45 * c.d;

// ------------------------------------------------------------------ petal targets (rosette, right half of petal 0, axis up)
const PT = (() => {
  const toast = DC.map((c, i) => { const Ri = 250 + 11.5 * i, Bi = 9 + 1.2 * i, pts = []; for (let k = 0; k < 40; k++) { const u = k / 39; pts.push(pol(105 + (Ri - 105) * u, 3 + Bi * Math.sin(Math.PI * u))); } return pts; });
  const dots = DC.map((c, i) => pol(452, 3.5 + 1.65 * i));
  const splash = []; for (let k = 0; k < 40; k++) { const u = k / 39; splash.push(pol(150 + 190 * u, 3.2 * Math.sin(u * 3 * Math.PI))); }
  return { toast, dots, splash, armP0: pol(150, 23), armTip: pol(392, 23), bigToast: pol(290, 13.5), cup: pol(112, 0), news: pol(430, 11) };
})();

// ------------------------------------------------------------------ per-frame state of the kitchen
function stateAt(t) {
  const tw = twosB(t), s = { inSlot: [], lever: 0, heat: 0, knob: 0, door: 0, flying: [], toastN: 0, paperN: 0, arm: null };
  // lever: anticipation lift at b7, press lands on b8, springs up on the pop
  const t7 = B(7), t8 = B(8), t10 = B(10);
  if (tw >= t7 && tw < t8 - 4 * F) s.lever = -0.14 * eo(seg(tw, t7, t7 + 0.2));
  else if (tw >= t8 - 4 * F && tw < t10) s.lever = lerp(-0.14, 1, ei3(seg(tw, t8 - 4 * F, t8))) - 0.06 * Math.sin(Math.PI * seg(tw, t8, t8 + 0.16));
  else if (tw >= t10 && tw < B(23)) s.lever = 1 - back(seg(tw, t10, t10 + 0.2), 2.2);
  s.heat = tw >= t8 && tw < t10 ? 1 : 0;
  // toasts in the slots
  if (tw < t8) s.inSlot = [{ x: 350, up: 16 }, { x: 510, up: 16 }];
  else if (tw < t10) s.inSlot = [{ x: 350, up: lerp(16, -30, ss(seg(tw, t8 - 4 * F, t8))) }, { x: 510, up: lerp(16, -30, ss(seg(tw, t8 - 4 * F, t8))) }];
  // the pop: two slices arc onto the plate, land on b11
  const t11 = B(11);
  if (tw >= t10 && tw < t11) {
    const u = seg(tw, t10, t11);
    [[350, 690, 250, -1], [510, 700, 215, 1]].forEach(([x0, x1, hh, dirr], j) => s.flying.push({ x: lerp(x0, x1, u), y: lerp(450, 674 - 13 * j, u) - 4 * hh * u * (1 - u), rot: dirr * u * Math.PI * 0.5 * (1 + j), sc: 0.92 }));
  }
  if (tw >= t11) s.toastN = 2;
  // coffee
  const t12 = B(12), t13 = B(13), t15 = B(15);
  s.knob = tw < t12 - 3 * F ? -0.12 * seg(tw, B(11.5), t12 - 3 * F) : tw < B(24) ? lerp(-0.12, 1, eo(seg(tw, t12 - 3 * F, t12))) : 1;
  if (tw >= B(15.6)) s.knob = 1 - eo(seg(tw, B(15.6), B(16))) ;
  s.pour = tw >= t13 && tw < t15 ? 1 : 0; s.pourHead = seg(tw, t13, t13 + 2 * F);
  // arm
  const t16 = B(16), t17 = B(17), t18 = B(18), t19 = B(19);
  s.door = tw < t16 - 3 * F ? 0 : tw < B(20) ? back(seg(tw, t16 - 3 * F, t16), 1.6) : 1 - eo(seg(tw, B(20), B(20) + 4 * F));
  if (tw >= t17 && tw < t19 + 0.3) {
    let e = tw < t18 ? eio(seg(tw, t17, t18)) : 1 - eio(seg(tw, t19, t19 + 0.3));
    const tgt = [1400, 646];
    s.arm = { tip: [lerp(HATCH[0] - 20, tgt[0], e), lerp(HATCH[1] + 10, tgt[1], e)], kind: tw < t18 ? 'grip' : 'open', paper: tw < t18 };
  }
  if (tw >= t18) s.paperN = 1;
  // the stop: everything jerks into its next action and locks at b24
  const t23 = B(23), t24 = B(24), t28 = B(28);
  if (tw >= t23 && tw < t28) {
    const a = tw < t24 ? eo(seg(tw, t23, t24)) : 1;
    s.inSlot = [{ x: 350, up: lerp(-30, 10, a) }, { x: 510, up: lerp(-30, 44, a) }];
    s.lever = lerp(0.0, 1, ei3(seg(tw, t23, t23 + 6 * F))) ;
    s.knob = lerp(0, 1, a);
    s.door = Math.min(1, back(seg(tw, t23, t23 + 5 * F), 1.4));
    s.arm = { tip: [lerp(HATCH[0] - 20, 1500, a), lerp(HATCH[1] + 10, 520, a)], kind: 'grip', paper: true };
    s.drop = tw >= t24 ? 1 : 0;
  }
  // accelerando: every beat all three machines fire
  if (t >= t28) {
    s.inSlot = []; s.lever = 1; s.door = 1; s.knob = 1;
    s.toastN = 2; s.paperN = 1;
    const tf = t >= B(44) ? B(44) : tw;
    for (let i = 0; i < 16; i++) {
      const c = DC[i]; if (tf < c.t0) break;
      if (!c.last && tf >= c.t1) s.toastN++;
      if (!c.last && tf >= tPaperDrop(c)) s.paperN++;
    }
    const i = Math.min(15, Math.floor(beatAt(tf) + 1e-9) - D0), c = DC[i];
    const u = c.last ? seg(tf, c.t0, c.t1) : seg(tf, c.t0, c.t1);
    const k = c.last ? Math.floor(u * 30 * 0.999999 + 1e-6) : Math.floor(u * 30);
    const p = c.toast[Math.min(30, Math.round(u * 30))];
    s.flying.push({ x: p[0], y: p[1], rot: (i % 2 ? 1 : -1) * u * Math.PI * (c.last ? 0.7 : 1), sc: 0.92 });
    s.inSlot = [{ x: i % 2 ? 350 : 510, up: lerp(-30, 12, seg(tf, c.t0, c.t0 + c.d * 0.5)) }];
    // arm
    let e;
    if (c.last) e = eo(seg(tf, c.t0, c.t1));
    else { const a1 = c.t0 + 0.45 * c.d, a2 = c.t0 + 0.6 * c.d; e = tf < a1 ? eo(seg(tf, c.t0, a1)) : tf < a2 ? 1 : 1 - eio(seg(tf, a2, c.t1)); }
    s.arm = { tip: [lerp(HATCH[0] - 20, c.tgt[0], e), lerp(HATCH[1] + 10, c.tgt[1], e)], kind: (c.last || tf < tPaperDrop(c)) ? 'grip' : 'open', paper: c.last || tf < tPaperDrop(c) };
    s.pour = c.last ? 0 : (tf < c.t0 + 0.5 * c.d ? 1 : 0); s.pourHead = 1;
    s.cyc = i; s.cycU = u; s.tf = tf;
  }
  return s;
}

// ------------------------------------------------------------------ the kitchen
function kitchen(ctx, t, s) {
  plane(ctx, rect(-1600, -1600, 5120, 2296), P.blueT, { off: plateK('wall') != null ? [0, 0] : [0, 0], alpha: plateK('wall') != null ? 1 : 0 });
  if (plateK('floor') != null) { const e = 1 - eo(plateK('floor')); plane(ctx, rect(-1600, 736, 5120, 1800), P.blueD, { off: [e * 40 * LS, e * 30 * LS] }); }
  // wall ornaments: atomic sparkles + a boomerang, printed with the wall plate
  if (plateK('wall') != null) {
    [[250, 160, 20], [560, 320, 14], [1480, 170, 18], [1820, 560, 16], [140, 540, 13]].forEach(([x, y, r], i) => sparkle(ctx, x, y, r, { fill: P.cream, alpha: 0.85, rot: 0 }));
    sh(ctx, kidney(1820, 230, 70, 0.3), { fill: P.blue, line: 0, seed: 101, plate: 'wall' });
  }
  windowSun(ctx, t);
  clockAt(ctx, t, 700, 175);
  counter(ctx);
  toastPlate(ctx, s.toastN);
  toaster(ctx, t, s);
  // paper stack + delivery
  for (let j = 0; j < s.paperN; j++) paperSlab(ctx, 1400 + (hash(j, 11) - 0.5) * 22, 690 - j * 12, 220 + j);
  hatch(ctx, s);
  // coffee
  cup(ctx, 1082, 646, 1, 80);
  if (s.pour) stream(ctx, t, 552, lerp(552, 604, s.pourHead), 9);
  if (s.drop) {   // hangs from the spout lip by a neck: 551 → 588 (37 px world), clear air above the cup rim (600)
    const dp = spline([[1078, 551], [1086, 551], [1087, 560], [1095, 572], [1093, 583], [1082, 588], [1071, 583], [1069, 572], [1077, 560]], true, 6);
    sh(ctx, dp, { fill: P.coffee, line: 3, seed: 230, shade: [{ pts: spline([[1077, 563], [1082, 568], [1079, 578], [1073, 572]], true, 4), color: P.coffeeL }] });
    sparkle(ctx, 1089, 567, 5, { fill: P.cream, rot: 0 });
  }
  coffeeMachine(ctx, t, s);
}

// trails of the accelerando: toast arcs (dashed mustard), steam curls (cream), arm ghosts
function trails(ctx, t, s, m = 0) {
  const tf = s.tf ?? t;
  DC.forEach((c, i) => {
    if (tf < c.t0) return;
    const u = c.last ? seg(tf, c.t0, c.t1) : seg(tf, c.t0, c.t1);
    let pts = subpath(c.toast, u); if (pts.length < 2) return;
    if (m > 0) pts = lerpPts(resample(pts, 40), PT.toast[i].slice(0, 40), m);
    dashed(ctx, pts, 4 * LS, 16, 11, 0, m > 0.5 ? P.cream : P.mustard);
  });
  DC.forEach((c, i) => {
    if (tf < c.t0) return;
    const u = clamp(seg(tf, c.t0, c.t0 + Math.max(0.42, c.d * 1.6)));
    let pts = subpath(c.curl, u); if (pts.length < 2) return;
    if (m > 0) { const d = PT.dots[i]; pts = pts.map(p => [lerp(p[0], d[0], m), lerp(p[1], d[1], m)]); }
    if (m < 0.97) ink(ctx, pts, 3.2 * LS, { color: P.cream, seed: 400 + i, taper: true, alpha: 1 - m * 0.5 });
    if (m > 0) { const d = PT.dots[i]; shape(ctx, ellipse(d[0], d[1], 9 * m, 9 * m, 14), { fill: P.mustard, line: 2.6 * LS * m, seed: 420 + i, grain: 0.1 }); }
  });
  DC.forEach((c, i) => {
    if (c.last || tf < tPaperDrop(c)) return;
    const P0 = [HATCH[0] - 20, HATCH[1] + 10];
    const a = m > 0 ? lerpPts([P0, c.tgt], [PT.armP0, PT.armTip], m) : [P0, c.tgt];
    tongs(ctx, a[0], a[1], { ghost: P.tomatoL, alpha: 0.85 * (1 - m) });
  });
}

// ------------------------------------------------------------------ the ornament
function halfLeaf() { const pts = []; for (let k = 0; k <= 24; k++) { const r = 92 + 380 * k / 24; pts.push(pol(r, 29 * Math.pow(Math.sin(Math.PI * (r - 92) / 380), 0.75))); } for (let k = 24; k >= 0; k--) pts.push(pol(92 + 380 * k / 24, 0)); return pts; }
const LEAF = halfLeaf();
// right half of petal 0 at morph m (0 = frozen kitchen positions, 1 = ornament)
function halfPetal(ctx, t, s, m, leafK) {
  if (leafK > 0) {
    const sc = leafK, Lp = LEAF.map(([x, y]) => [C0[0] + (x - C0[0]) * sc, C0[1] + (y - C0[1]) * sc]);
    shape(ctx, Lp, { fill: P.tomato, line: 0, seed: 500, grain: 0.3, shade: [{ pts: Lp.map(([x, y]) => [C0[0] + (x - C0[0]) * 0.75, C0[1] + (y - C0[1]) * 0.75]), color: P.tomatoL, alpha: 0.55 }] });
  }
  trails(ctx, t, s, m);
  // the splash of the last pour becomes the petal's spine
  const sp0 = []; for (let k = 0; k < 40; k++) { const u = k / 39; sp0.push([lerp(1082, 1006, u), 596 - 200 * Math.sin(u * Math.PI * 0.62) - 40 * u]); }
  const sp = lerpPts(sp0, PT.splash, m);
  ink(ctx, sp, 13 * LS + 0, { color: P.ink, taper: true, seed: 510, wob: 0.2 });
  ink(ctx, move(sp, 2 * LS, 2 * LS), 7.5 * LS, { color: P.coffee, taper: true, seed: 511, wob: 0.2 });
  for (let j = 0; j < 3; j++) { const q = lerp(1, 0, 0) ; const p0 = [1000 - j * 26, 380 - j * 14], p1 = pol(358 + j * 22, 0); const p = [lerp(p0[0], p1[0], m), lerp(p0[1], p1[1], m)]; shape(ctx, ellipse(p[0], p[1], 7 - j, 9 - j, 12), { fill: P.coffee, line: 2.6 * LS, seed: 512 + j }); }
  // cup → centre of the petal
  const cp = [lerp(1082, PT.cup[0], m), lerp(646, PT.cup[1], m)];
  cup(ctx, cp[0], cp[1], lerp(1, 0.72, m), 80, 0);
  // the big last toast
  const bt0 = DC[15].toast[30], bp = [lerp(bt0[0], PT.bigToast[0], m), lerp(bt0[1], PT.bigToast[1], m)];
  toastSlice(ctx, bp[0], bp[1], lerp(0.7 * Math.PI, TAU + 13.5 * Math.PI / 180, m), lerp(0.92, 0.72, m), 45, { plate: false });
  // the arm → the petal's edge
  const P0 = [lerp(HATCH[0] - 20, PT.armP0[0], m), lerp(HATCH[1] + 10, PT.armP0[1], m)];
  const tip = [lerp(DC[15].tgt[0], PT.armTip[0], m), lerp(DC[15].tgt[1], PT.armTip[1], m)];
  const a = tongs(ctx, P0, tip, { Lh: lerp(62, 44, m) });
  const nr = lerp(0, 11 * Math.PI / 180 - Math.PI / 2 - a + a, m);
  newspaper(ctx, tip[0] + Math.cos(a) * 40, tip[1] + Math.sin(a) * 40 + 30 * (1 - m), lerp(0, 11 * Math.PI / 180, m), lerp(0.9, 0.7, m), 61);
  drawHand(ctx, tip[0], tip[1], a, 'grip', 1, lerp(1.5, 1.1, m), { lw: LS });
}
function between(ctx, k) {   // ornaments between petals: sparkles + polka dots on the 30° lines
  const a = 30 + k * 60, p = pol(330, a), q = pol(470, a), d = pol(220, a);
  sparkle(ctx, p[0], p[1], 34, { fill: P.cream, rot: 0 });
  shape(ctx, ellipse(q[0], q[1], 14, 14, 16), { fill: P.olive, line: 2.6 * LS, seed: 600 + k });
  shape(ctx, ellipse(d[0], d[1], 9, 9, 14), { fill: P.olive, line: 0, seed: 610 + k });
}
function hub(ctx, t, k = 1) { clockAt(ctx, t, C0[0], C0[1], 1.55 * k); }
function rosette(ctx, t, s, opts) {   // full rosette, all petals mirrored, around C0
  const { fan = 1, mirror = 1 } = opts;
  rays(ctx, C0[0], C0[1], 30, 560, P.cream, { alpha: 0.55, rot: 0, r0: 60 });
  for (let k = 0; k < 6; k++) {
    const ang = k * Math.PI / 3 * fan;
    ctx.save(); ctx.translate(C0[0], C0[1]); ctx.rotate(ang); ctx.translate(-C0[0], -C0[1]);
    for (const side of [1, -1]) {
      if (side < 0 && mirror <= -1.5) continue;
      ctx.save();
      if (side < 0) { ctx.translate(C0[0], 0); ctx.scale(-1 * (mirror < 0 ? 1 : 1), 1); ctx.translate(-C0[0], 0); }
      halfPetal(ctx, t, s, 1, 1);
      ctx.restore();
    }
    if (fan >= 1) between(ctx, k);
    ctx.restore();
  }
  hub(ctx, t);
}

// screen-space title banner
function titleBanner(ctx, t) {
  const t0 = tb('lock'), k = pop(t, t0, 0.3); if (k <= 0) return;
  const tt = Math.min(t, T_HOLD());
  ctx.save(); ctx.translate(W / 2, H / 2 + 8); ctx.scale(k, k);
  const w = 660, h = 158;
  shape(ctx, rrect(-w / 2, -h / 2, w, h, 26), { fill: P.cream, line: 4.6, seed: 700, grain: 0.15, off: [7, 6] });
  ink(ctx, rrect(-w / 2 + 12, -h / 2 + 12, w - 24, h - 24, 18), 2.4, { closed: true, seed: 701, breaks: 0.25 });
  for (const sd of [-1, 1]) {   // small turning stars at both ends of the card (colour cel off its ink)
    const sx = sd * (w / 2 - 46), rr = sd * tt * 0.7;
    star(ctx, sx + 3, 3, 21, { n: 8, inner: 0.42, fill: P.mustard, off: [0, 0], rot: rr });
    ink(ctx, starPts(sx, 0, 21, 8, 0.42, rr), 2.6, { closed: true, seed: 704 + sd, breaks: 0.15 });
  }
  txt(ctx, 'title', '明日早晨', 0, 40, { font: '900 112px SerifSC', fill: P.ink, plate: P.tomato, off: [3, 3], align: 'center', track: 6 });
  ctx.restore();
}

// ------------------------------------------------------------------ render
let OFF = null;
export function renderFilm(ctx, t, rec = null) {
  REC = rec;
  t = Math.min(t, DUR - 1e-6);
  const hold = t >= T_HOLD();
  const tw = hold ? T_HOLD() : twosB(t);
  setClock(tw);
  const c = camAt(t);
  LS = 1 / c.s; REG.dx = 6 * LS; REG.dy = 4 * LS; REG.jit = 1.6 * LS;
  // plates and draw-on
  const plates = {}; for (const [n, h] of [['wall', 'plateWall'], ['floor', 'plateFloor'], ['counter', 'plateCounter'], ['machine', 'plateMachine']]) plates[n] = tw >= tb(h) ? seg(tw, tb(h), tb(h) + 4 * F) : null;
  ST = { plates, inkU: lerp(0.24, 1, seg(t, 0, B(2) - 2 * F)) };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = P.paper; ctx.fillRect(0, 0, W, H);
  ctx.save(); applyCam(ctx, c);
  const s = stateAt(t);
  const tE = B(44), tE1 = B(45), tE2 = B(46);
  if (t < tE) {
    kitchen(ctx, t, s);
    if (t >= B(28)) trails(ctx, t, s, 0);
    for (const f of s.flying) toastSlice(ctx, f.x, f.y, f.rot, f.sc, 44);
    if (s.arm) armAt(ctx, [HATCH[0] - 20, HATCH[1] + 10], s.arm.tip, s.arm.kind, s.arm.paper, s.arm.paper ? -0.25 : 0);
    // medallions stay stamped on the machines
    medallion(ctx, t, tb('medal1'), 430, 578, 1);
    medallion(ctx, t, tb('medal2'), 960, 452, 2);
    medallion(ctx, t, tb('medal3'), 1702, 458, 3);
    if (t >= B(20) - 6 * F && t < B(24) + 3 * F) {
      const fade = 1 - eo(seg(t, B(24), B(24) + 3 * F));
      if (fade > 0) {
        arrow(ctx, [470, 510], [905, 395], { u: clamp(seg(t, B(20) - 6 * F, B(20))) * fade, bend: -0.28, w: 6 * LS, head: 30, fill: P.tomato, bob: (beatAt(t) % 1) });
        if (t >= B(21) - 6 * F) arrow(ctx, [1010, 395], [1640, 330], { u: clamp(seg(t, B(21) - 6 * F, B(21))) * fade, bend: -0.22, w: 6 * LS, head: 30, fill: P.tomato, bob: (beatAt(t) % 1) });
      }
    }
    // call-outs: the manual's magnifier, drawn at native line weight
    const tStop = B(24);
    callout(ctx, t, tb('pop'), tStop, 430, 892, 128, P.blueT, [690, 676], g => {
      toastSlice(g, 0, 8, -0.08, 1.75, 47, { plate: false });
      sh(g, rrect(-34, -34, 62, 40, 9), { fill: P.mustardL, line: 3.2, seed: 48, plate: false });
      sparkle(g, 62, -64, 22, { fill: P.cream, rot: t * 1.2 }); sparkle(g, -70, 64, 14, { fill: P.cream, rot: -t });
    });
    tag(ctx, t, tb('pop'), tStop, 'tag1', '吐司', 574, 860);
    callout(ctx, t, tb('call2'), tStop, 960, 892, 128, P.mustardL, [1082, 606], g => {
      const lvl = clamp(seg(t, B(14), B(15))) * 0.85 + 0.1;
      const body = spline([[-84, -60], [84, -60], [72, 40], [46, 70], [-46, 70], [-72, 40]], true, 5);
      ink(g, ellipse(96, 0, 26, 30, 20), 10 * LS, { closed: true, seed: 81 });
      sh(g, body, { fill: P.cream, line: 4, seed: 82, plate: false, shade: [{ pts: rect(-90, 10, 180, 18), color: P.olive }] });
      sh(g, ellipse(0, -60, 84, 20, 30), { fill: P.paperD, line: 3.4, seed: 83, plate: false });
      sh(g, ellipse(0, -60 + 26 * (1 - lvl), 72 * (0.9 + 0.1 * lvl), 15, 30), { fill: P.coffee, line: 2.4, seed: 84, plate: false });
      if (t < B(15)) ink(g, [[0, -140], [3, -110], [-2, -80], [0, -60 + 26 * (1 - lvl)]], 14, { color: P.coffee, taper: false, seed: 85 });
      else for (let j = 0; j < 2; j++) { const pts = []; for (let k = 0; k <= 12; k++) pts.push([-20 + j * 40 + Math.sin(k * 0.8 + tw * 6 + j) * 9, -80 - k * 7]); ink(g, pts, 4, { color: P.cream, seed: 86 + j }); }
    });
    tag(ctx, t, tb('call2'), tStop, 'tag2', '咖啡', 1104, 860);
    callout(ctx, t, tb('paper'), tStop, 1460, 892, 128, P.oliveL, [1400, 682], g => {
      sh(g, rect(-88, -104, 176, 208), { fill: P.cream, line: 4, seed: 90, plate: false });
      txt(g, 'mast', '晨报', 0, -36, { font: '900 64px SerifSC', fill: P.ink, plate: P.tomato, off: [3, 3], align: 'center' });
      ln(g, [[-74, -18], [74, -18]], 4, { seed: 91, taper: false }); ln(g, [[-74, -10], [74, -10]], 2, { seed: 92, taper: false });
      sh(g, ellipse(-40, 30, 26, 26, 20), { fill: P.mustard, line: 3, seed: 93, plate: false });
      for (let j = 0; j < 5; j++) ln(g, [[0, 6 + j * 14], [72, 6 + j * 14]], 2.4, { seed: 94 + j, taper: false });
      for (let j = 0; j < 2; j++) ln(g, [[-74, 70 + j * 14], [72, 70 + j * 14]], 2.4, { seed: 99 + j, taper: false });
    });
    tag(ctx, t, tb('paper'), tStop, 'tag3', '报纸', 1606, 860);
  } else {
    // ---- the ornament
    const sf = stateAt(tE - 1e-4); sf.tf = tE;
    const ground = P.mustardL;
    if (t < tE1) {
      // colour-block wipe rises from the bottom over the frozen kitchen
      // the wipe is a screen-space page: a horizontal edge rising from the bottom
      const tWe = tb('fold'), uw = seg(t, tE - F, tWe),   // the page's edge is already in on the b44 frame
        yw = lerp(H + 24, -60, 1 - (1 - uw) * (1 - uw)), M0 = ctx.getTransform();
      const clipScreen = (y0, y1) => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(-10, y0, W + 20, y1 - y0); ctx.clip(); ctx.setTransform(M0); };
      ctx.save(); clipScreen(-10, yw);
      ST.inkU = 1; kitchen(ctx, tE - 1e-4, sf);
      medallion(ctx, t, tb('medal1'), 430, 578, 1); medallion(ctx, t, tb('medal2'), 960, 452, 2); medallion(ctx, t, tb('medal3'), 1702, 458, 3);
      ctx.restore();
      ctx.save(); clipScreen(yw, H + 10);
      ctx.fillStyle = ground; ctx.fillRect(-2000, -2000, 6000, 6000);
      rays(ctx, C0[0], C0[1], 30, 1100, P.cream, { alpha: 0.5, r0: 60 });
      ctx.restore();
      if (uw < 1) {   // the page's leading edge: a darker cel band printed off its ink lip, a paper shadow on the kitchen above
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.35; ctx.fillStyle = P.paperDD; ctx.fillRect(-10, yw - 16, W + 20, 16); ctx.globalAlpha = 1;
        const r0 = reg(802); ctx.fillStyle = P.mustard; ctx.fillRect(-10, yw + r0[1], W + 20, 22);
        ink(ctx, [[-40, yw], [W + 40, yw]], 6, { taper: false, seed: 801, breaks: 0.18 });
        ink(ctx, [[-40, yw + 26], [W + 40, yw + 26]], 2.4, { taper: false, seed: 803, breaks: 0.35 });
        ctx.restore();
      }
      const m = eio(seg(tw, tE + 2 * F, tE1 - 2 * F));
      const clk = [lerp(700, C0[0], m), lerp(175, C0[1], m)];
      // mirror half folds out like a paper cut-out
      // the mirror half opens out of the fold line like a paper cut-out: half open on the swung off-beat (frame 405), settled by b45
      const fold = eo(seg(t, tb('fold') - F, tE1));
      if (fold > 0) { ctx.save(); ctx.translate(C0[0], 0); ctx.scale(-fold, 1); ctx.translate(-C0[0], 0); halfPetal(ctx, t, sf, m, ss(seg(tw, tE + 4 * F, tE1))); ctx.restore(); }
      halfPetal(ctx, t, sf, m, ss(seg(tw, tE + 4 * F, tE1)));
      clockAt(ctx, t, clk[0], clk[1], lerp(1, 1.55, m));
    } else if (t < tE2) {
      ctx.fillStyle = ground; ctx.fillRect(-4000, -4000, 9000, 9000);
      const u = seg(tw, tE1, tE2), fan = back(u, 1.3);
      rays(ctx, C0[0], C0[1], 30, 1100, P.cream, { alpha: 0.5, r0: 60 });
      for (let k = 5; k >= 0; k--) {
        ctx.save(); ctx.translate(C0[0], C0[1]); ctx.rotate(k * Math.PI / 3 * fan); ctx.translate(-C0[0], -C0[1]);
        for (const sd of [-1, 1]) { ctx.save(); if (sd < 0) { ctx.translate(C0[0], 0); ctx.scale(-1, 1); ctx.translate(-C0[0], 0); } halfPetal(ctx, t, sf, 1, 1); ctx.restore(); }
        ctx.restore();
      }
      for (let k = 0; k < 6; k++) { const a = ss(seg(u, 0.6, 1)); if (a > 0) { ctx.save(); ctx.globalAlpha = a; between(ctx, k); ctx.restore(); } }
      hub(ctx, t);
    } else {
      // static wallpaper: render one rosette into an offscreen sheet at screen scale, stamp it on a hex lattice
      ctx.restore(); ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = ground; ctx.fillRect(0, 0, W, H);
      rays(ctx, W / 2, H / 2, 30, 1100 * Math.max(c.s, 0.82), P.cream, { alpha: 0.5, r0: 60 * c.s });
      const R = 540, sz = Math.ceil(2 * R * c.s) + 8;
      if (!OFF || OFF.width < sz) OFF = new OffscreenCanvas(sz, sz);
      const g = OFF.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, OFF.width, OFF.height);
      g.translate(sz / 2, sz / 2); g.scale(c.s, c.s); g.translate(-C0[0], -C0[1]);
      rosette(g, t, sf, {});
      const dd = 1060, cells = [];
      for (let row = -3; row <= 3; row++) for (let col = -4; col <= 4; col++) {
        const wx = col * dd + (row % 2 ? dd / 2 : 0), wy = row * dd * 0.866, ring = Math.max(Math.abs(row), Math.abs(col) + (row % 2 && col < 0 ? 0 : 0));
        const dist = Math.hypot(wx, wy) / dd;
        cells.push({ wx, wy, ring: dist < 0.1 ? 0 : dist < 1.1 ? 1 : 2, i: row * 9 + col });
      }
      const discs = [P.cream, P.blueT, P.oliveL, P.tomatoL];
      for (const cl of cells) {
        let k = 1;
        if (cl.ring === 1) k = pop(t, tb('ring1'), 0.3); if (cl.ring === 2) k = pop(t, tb('ring2') + (hash(cl.i, 2)) * 3 * F, 0.3);
        if (k <= 0.001) continue;
        const sx = W / 2 + cl.wx * c.s, sy = H / 2 + cl.wy * c.s, rr = 500 * c.s;
        if (sx < -rr - 40 || sx > W + rr + 40 || sy < -rr - 40 || sy > H + rr + 40) continue;
        ctx.save(); ctx.translate(sx, sy); ctx.scale(k, k);
        shape(ctx, ellipse(0, 0, rr, rr, 80), { fill: discs[cl.ring === 0 ? 0 : 1 + ((cl.i % 3) + 3) % 3], line: 4, seed: 900 + cl.i, grain: 0.2, off: [7, 5] });
        ctx.drawImage(OFF, -sz / 2, -sz / 2);
        ctx.restore();
      }
      // interstitial sparkles twinkle on twos
      const f = Math.floor(tw * 12);   // tw is frozen at b50 → the twinkle stops with the camera
      for (const cl of cells) {
        const sx = W / 2 + (cl.wx + dd / 2) * c.s, sy = H / 2 + (cl.wy + dd * 0.29) * c.s;
        const tw2 = 0.75 + 0.25 * Math.sin(f * 1.3 + cl.i);
        if (t >= tb('ring1')) sparkle(ctx, sx, sy, 26 * tw2 * Math.min(1, pop(t, tb('ring1'))), { fill: P.cream });
      }
      // the button: eight sparkles leave the card on the swung G (b49.6) and land on the final C (b50), then hold
      if (t >= B(49.6)) { const u = seg(t, B(49.6), tb('button')); for (let j = 0; j < 8; j++) { const a = j * TAU / 8 + Math.PI / 8, r = lerp(200, 380, eo(u)); sparkle(ctx, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r * 0.62, lerp(16, 36, eo(u)), { fill: P.cream, rot: 0 }); } }
    }
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  titleBanner(ctx, t);
  paperFinish(ctx, W, H, 0.9);
}
