// t -> scene state. Every time comes from timeline.js. Glass figures step at 8 fps (re-anchored on every beat);
// light and camera move on ones.
import { clamp, lerp, seg, ss, eio, eo, ei, mulberry } from '/core/lib.js';
import { BEAT, DUR, T, b, CUE } from './timeline.js';
import { POSE, lerpPose, FLAMES } from './engine/phoenix.js';
import { PETAL_GROUPS, R_IN, CARVE_Y, CARVE_BOX, CARVE_TEXT } from './engine/rose.js';
import { toScreen } from './engine/scene.js';

export { DUR };
const EPS = 1e-6;
// 8 fps stepped clock, restarted on every beat so stepped actions land exactly on the grid
const stepT = t => { const k = Math.floor(t / BEAT + EPS) * BEAT; return k + Math.floor((t - k) * 8 + EPS) / 8; };
const key = (t, ks) => { if (t <= ks[0][0]) return ks[0][1]; for (let i = 0; i < ks.length - 1; i++) { const [t0, v0, e] = ks[i], [t1, v1] = ks[i + 1]; if (t < t1) { const u = (e || eio)(seg(t, t0, t1)); return Array.isArray(v0) ? v0.map((x, j) => lerp(x, v1[j], u)) : lerp(v0, v1, u); } } return ks[ks.length - 1][1]; };
const lin = u => u;
// a light that arrives on the beat: snaps to 45 % on the cue frame, then swells
const arrive = (t, tb, d = .14) => t + EPS < tb ? 0 : .45 + .55 * ss((t - tb) / d);
const H = BEAT / 2, Q = BEAT / 4;

// ---------------- re-leading schedule ----------------
export const WL = [T.firstWeld, ...T.welds];                    // 8 welds
const GW = { tail: 1, body: 2, wingF: 3, wingN: 4, head: 5, crest: 6, flames: 7 };
const DISP = { tail: [-24, 18, -.12], body: [10, 16, .06], wingF: [28, -20, .14], wingN: [-30, -16, -.15], head: [20, -24, .16], crest: [16, -28, .22] };
const FIRE_ON = { flames: b(11), tail: b(11.5), body: b(12), wingF: b(12.5), wingN: b(13), head: b(13.5), crest: b(14) };
export const PHX = { x: 0, y: 34, s: .8 };
// world anchors of each group (weld sparks), medallion space
const ANCH = { centre: [0, 10], tail: [-60, 92], body: [8, 38], wingF: [96, -120], wingN: [-108, -112], head: [62, -78], crest: [30, -112], flames: [-30, 168] };

// ---------------- cracks (precomputed in medallion space) ----------------
const IMP = [[58, -74], [-96, -92], [-22, 160], [86, -122], [10, 40], [-120, 108]];
function network(seed, c, nb, L0, L1, w) {
  const rnd = mulberry(seed), out = [];
  for (let i = 0; i < nb; i++) {
    let a = i / nb * Math.PI * 2 + rnd() * .55, x = c[0], y = c[1]; const pts = [[x, y]], L = L0 + rnd() * (L1 - L0);
    for (let l = 0; l < L; l += 11) { a += (rnd() - .5) * .75; x += Math.cos(a) * 11; y += Math.sin(a) * 11; if (Math.hypot(x, y) > R_IN - 2) break; pts.push([x, y]); }
    if (pts.length > 2) out.push({ pts, delay: rnd() * .3, w: w * (.7 + rnd() * .6) });
    if (rnd() < .55 && pts.length > 5) { const j = 2 + Math.floor(rnd() * (pts.length - 4)); let [bx, by] = pts[j], ba = a + (rnd() > .5 ? 1 : -1) * (.7 + rnd() * .5); const bp = [[bx, by]];
      for (let l = 0; l < L * .5; l += 10) { ba += (rnd() - .5) * .6; bx += Math.cos(ba) * 10; by += Math.sin(ba) * 10; if (Math.hypot(bx, by) > R_IN - 2) break; bp.push([bx, by]); }
      if (bp.length > 2) out.push({ pts: bp, delay: .35 + rnd() * .3, w: w * .55 }); }
  }
  return out;
}
const CRACKS = [];
IMP.forEach((c, i) => network(100 + i * 7, c, 6, 40, 110, 2.6).forEach(k => CRACKS.push({ ...k, t0: T.cracks[i], wi: i + 1 })));
// the break's own web is re-leaded in the weld order too (branch k -> weld k mod 8), not all at once
network(999, [0, 10], 10, 120, 230, 3.4).forEach((k, j) => CRACKS.push({ ...k, t0: T.shatter, wi: j % 8 }));
// rings of the spider web at the break
for (const r of [96]) { const rnd = mulberry(r); const pts = []; for (let k = 0; k <= 36; k++) { const a = k / 36 * Math.PI * 2, rr = r + (rnd() - .5) * 12; pts.push([Math.cos(a) * rr, 10 + Math.sin(a) * rr]); } CRACKS.push({ pts, delay: .4, w: 2.2, t0: T.shatter, wi: 7 }); }

function crackState(t) {
  return CRACKS.map(c => {
    const g = t + EPS < c.t0 ? 0 : clamp((t - c.t0 + 1 / 24 - c.delay * .1) / .25);
    const w0 = WL[c.wi], m0 = c.wi === 0 ? w0 : w0 - H, m1 = c.wi === 0 ? w0 + H : w0;
    const mend = t + EPS < m0 ? 0 : clamp((stepT(t) - m0) / (m1 - m0) + .06);
    return { pts: c.pts, w: c.w, grow: g, mend, lw: 2.5 };   // repair leads ~60 % of the old width: the bird must read through them
  });
}

// ---------------- phoenix ----------------
function groupU(t, g) { const w = WL[GW[g]]; return t + EPS < w - H ? 0 : ss(seg(stepT(t), w - H, w)); }
function mixPose(a, bb, U) {
  const o = { ...a };
  const W = k => ({ a: lerp(a[k].a, bb[k].a, U[k]), fan: lerp(a[k].fan, bb[k].fan, U[k]), len: lerp(a[k].len, bb[k].len, U[k]) });
  o.wingN = W('wingN'); o.wingF = W('wingF');
  o.tail = { a: lerp(a.tail.a, bb.tail.a, U.tail), fan: lerp(a.tail.fan, bb.tail.fan, U.tail) };
  o.neck = a.neck.map((v, i) => lerp(v, bb.neck[i], U.head)); o.head = lerp(a.head, bb.head, U.head); o.beak = lerp(a.beak, bb.beak, U.head);
  o.face = U.head > .5 ? bb.face : a.face; o.crest = lerp(a.crest, bb.crest, U.crest);
  return o;
}
function phoenix(t) {
  const ts = stepT(t);
  let p = POSE.rest;
  for (const F of T.flaps) {   // lift (anticipation) -> down-stroke lands on the beat -> recover
    p = lerpPose(p, POSE.up, ss(seg(ts, F - H, F - Q * .9)));
    p = lerpPose(p, POSE.down, ss(seg(ts, F - Q * .9, F)));
    p = lerpPose(p, POSE.rest, ss(seg(ts, F + Q, F + BEAT * .6)));
  }
  // fire: rears up into the blaze
  if (t + EPS >= T.ignite) p = lerpPose(p, POSE.blaze, ss(seg(ts, T.ignite, T.ignite + BEAT * .75)));
  const off = {};
  // each crack jolts the bird for two frames
  const hitG = ['head', 'wingN', 'tail', 'wingF', 'body', 'tail'];
  T.cracks.forEach((tc, i) => { const kf = Math.round((t - tc) * 24); if (kf >= 0 && kf < 2) { const g = hitG[i]; off[g] = [(i % 2 ? -1 : 1) * 4, 3, (i % 2 ? .03 : -.03)]; } });
  // shatter: groups jump off their leads, then slide back into the new picture one per half beat
  const U = { tail: 0, body: 0, wingF: 0, wingN: 0, head: 0, crest: 0 };
  if (t + EPS >= T.shatter) {
    for (const g in DISP) {
      const u = groupU(t, g); U[g] = u;
      const d = DISP[g], bump = Math.sin(u * Math.PI) * 9, n = Math.hypot(d[0], d[1]) || 1;
      off[g] = [d[0] * (1 - u) + d[0] / n * bump, d[1] * (1 - u) + d[1] / n * bump, d[2] * (1 - u)];
    }
    p = mixPose(POSE.blaze, POSE.reborn, U);
  }
  // light per group: sun (medallion lit), story fire (rising from the flames), none through cracks
  const med = Math.max(.17, arrive(t, T.reveal, .2));
  const fire = g => (t + EPS >= FIRE_ON[g] && t + EPS < T.shatter) ? .4 + .6 * ss((t - FIRE_ON[g]) / .12) : 0;
  const glow = g => { const w = WL[GW[g]]; return t + EPS < w ? 0 : Math.exp(-(t - w) / .55); };
  const lit = {}; for (const g of ['tail', 'body', 'wingF', 'wingN', 'head', 'crest']) { const k = glow(g), done = t + EPS >= WL[GW[g]] ? 1 : 0; lit[g] = [med, fire(g), .36 * k + .08 * done]; }   // mask channels clamp at 1: the boost rides the white crack channel (~1.5x backlight on the weld)
  const nb = t + EPS >= WL[7] ? .5 + .3 * ss(seg(t, WL[7], b(21))) : t + EPS >= T.firstWeld ? .42 : .22;
  const o = {
    off, lit, extraLit: [med, 0, nb],
    tailExtra: t + EPS >= WL[GW.tail] - H, tailSlide: U.tail,
    wingExtraF: t + EPS >= WL[GW.wingF] - H ? 1 : 0, wingSlideF: U.wingF,
    wingExtraN: t + EPS >= WL[GW.wingN] - H ? 1 : 0, wingSlideN: U.wingN,
    crestExtra: t + EPS >= WL[GW.crest] - H, crestSlide: U.crest,
  };
  return { ...PHX, pose: p, o };
}
function flames(t) {
  const off = {};
  if (t + EPS >= T.shatter) {
    const u = groupU(t, 'flames'), rnd = mulberry(5);
    FLAMES.forEach((f, k) => { const dx = (rnd() - .5) * 14, dy = 4 + rnd() * 6, da = (rnd() - .5) * .16, bump = Math.sin(u * Math.PI) * 6; off[k] = [dx * (1 - u), (dy) * (1 - u) - bump, da * (1 - u)]; });
  }
  const med = Math.max(.17, arrive(t, T.reveal, .2));
  const on = t + EPS >= T.ignite && t + EPS < T.shatter;
  const fs = t + EPS >= WL[7] ? lerp(.3, 1, ss(seg(stepT(t), WL[7] - H, WL[7]))) : .3;
  return { off, lit: k => [med * fs, on ? clamp(.5 + .5 * ss((t - T.ignite - k * .02) / .15)) : 0, t + EPS >= WL[7] ? .18 * ss(seg(t, WL[7], b(21))) : 0] };
}

// ---------------- light ----------------
const DAWN = [.7, .83, 1.0], MORN = [1, .93, .8], FIRE = [1, .84, .62], COLD = [.6, .68, .88], NOON = [1, .98, .94];
function light(t) {
  const sunI = key(t, [[0, 1.9], [T.reveal, 2.0], [b(9), 2.2], [b(10.5), 2.2], [T.ignite, 1.05], [T.shatter - EPS, .95, lin], [T.shatter + .1, .3], [T.firstWeld, .6], [b(19), 1.7], [T.blaze - EPS, 2.3, lin], [T.blaze, 3.2], [b(22), 2.6], [DUR, 2.6]]);
  const sunCol = key(t, [[0, DAWN], [T.reveal, [.86, .9, .97]], [b(9), MORN], [T.ignite, FIRE], [T.shatter - EPS, FIRE, lin], [T.shatter + .1, COLD], [T.firstWeld, COLD], [T.blaze, NOON]]);
  const skyI = key(t, [[0, .17], [T.reveal, .11], [T.ignite, .13], [T.shatter - EPS, .13, lin], [T.shatter + .1, .05], [T.firstWeld, .05], [T.blaze, .2]]);
  const amb = key(t, [[0, .24], [b(1), .2], [T.reveal, .16], [b(9), .15], [T.ignite, .17], [T.shatter - EPS, .17, lin], [T.shatter + .1, .06], [T.firstWeld, .06], [T.blaze - EPS, .17, lin], [T.blaze, .36], [DUR, .3]]);
  const ambCol = key(t, [[0, [.7, .76, .9]], [T.reveal, [.82, .82, .84]], [T.ignite, [.95, .78, .62]], [T.shatter - EPS, [.95, .78, .62], lin], [T.shatter + .1, [.62, .68, .82]], [T.firstWeld, [.62, .68, .82]], [T.blaze, [.92, .9, .86]]]);
  const fireI = t + EPS < T.ignite || t + EPS >= T.shatter ? 0 : key(t, [[T.ignite, 2.6], [b(12), 3.0], [b(14.75), 4.0]]);
  // the sun moves: patch long and slanted in the morning, shorter toward noon
  const sx = key(t, [[0, .4], [T.patchMove, .4], [b(11), .2], [T.shatter, .16], [T.blaze, .04], [DUR, .03]]);
  const sz = key(t, [[0, 1.3], [T.patchMove, 1.3], [b(11), 1.05], [T.shatter, .95], [T.blaze, .6], [DUR, .54]]);   // noon: the sun is high, the patch short and close to the wall (stays in the tighter end frame)
  return { sunI, sunCol, skyI, skyCol: [.55, .65, .92], amb, ambCol, fireI, fireCol: [1, .52, .18], sx, sz };
}

// ---------------- camera ----------------
const CUTS = [   // fire section: one framing per crack (shots shorten: 1 beat, 1/2, 1/2, 1/2, 1/4, 1/4)
  [T.ignite, [0, 10, 2.3], [0, 4, 2.42]],
  [T.cracks[0], [58, -70, 3.5], [58, -72, 3.62]],
  [T.cracks[1], [-96, -88, 3.2], [-100, -90, 3.28]],
  [T.cracks[2], [-14, 140, 3.3], [-10, 138, 3.38]],
  [T.cracks[3], [84, -112, 3.3], [86, -114, 3.36]],
  [T.cracks[4], [6, 34, 3.0], [6, 34, 3.06]],
  [T.cracks[5], [0, 12, 1.95], [0, 12, 1.96]],
];
function camera(t) {
  if (t < T.reveal) return key(t, [[0, [-110, 470, .72], lin], [b(1), [-120, 400, .76], eo], [b(4), [0, 40, .96]], [T.reveal, [0, 20, 1.05]]]);
  if (t < T.tiltDown) return key(t, [[T.reveal, [0, 20, 1.05]], [T.tiltDown, [6, 6, 2.15]]]);
  if (t < T.topdown) return key(t, [[T.tiltDown, [6, 6, 2.15]], [T.topdown, [260, 1400, .74]]], ei);
  if (t < T.whip) return null;   // top-down floor
  if (t < T.ignite) return key(t, [[T.whip, [300, 1460, .66]], [T.ignite, [0, 10, 2.3]]], eio);
  if (t < T.shatter) { let c = CUTS[0]; for (const k of CUTS) if (t + EPS >= k[0]) c = k; const nx = CUTS[CUTS.indexOf(c) + 1]; const t1 = nx ? nx[0] : T.shatter; return key(t, [[c[0], c[1], lin], [t1, c[2]]]); }
  if (t < T.firstWeld) return key(t, [[T.shatter, [0, 12, 1.96]], [T.firstWeld, [0, 14, 1.8]]], lin);
  if (t < T.carve) return key(t, [[T.firstWeld, [0, 14, 1.96], lin], [b(19), [0, 22, 1.74]], [T.carve, [0, 200, .88]]]);
  if (t < T.blaze) return key(t, [[T.carve, [0, 200, .88]], [T.blaze, [0, 250, .8]]], lin);
  return key(t, [[T.blaze, [0, 250, .8]], [DUR, [0, 440, .73]]], eio);   // tighter end: the reborn bird still reads
}

// ---------------- events (foley + cues) ----------------
export const EV = [];
T.petals.forEach((tt, i) => EV.push({ t: tt, type: 'pane', i }));
EV.push({ t: T.reveal, type: 'reveal' });
T.flaps.forEach(F => EV.push({ t: F - H, type: 'lift' }, { t: F, type: 'flap' }));
EV.push({ t: T.tiltDown, type: 'air', d: BEAT }, { t: T.topdown, type: 'glare' }, { t: T.patchMove, type: 'patch', d: BEAT }, { t: T.whip, type: 'whip', d: H });
EV.push({ t: T.ignite, type: 'ignite' }, { t: T.ignite, type: 'fire', d: T.shatter - T.ignite });
T.cracks.forEach((tc, i) => EV.push({ t: tc, type: 'crack', i }));
EV.push({ t: T.shatter, type: 'shatter' });
// the rain of shards is over within ~0.35 s of the break; inside the silence only one shard and one iron tick, both very faint
[b(15.3), b(16.3)].forEach((tt, i) => EV.push({ t: tt, type: 'tinkle', i }));
EV.push({ t: b(15.9), type: 'tick' });
EV.push({ t: T.firstWeld, type: 'weld0' }, { t: T.firstWeld, type: 'creak', d: H });
T.welds.forEach((w, i) => EV.push({ t: w - H, type: 'slide', d: H, i: i + 1 }, { t: w, type: 'weld', i: i + 1 }));
EV.push({ t: T.carve, type: 'sweep', d: BEAT * 1.2 }, { t: T.blaze, type: 'blaze' }, { t: b(21.6), type: 'birds' });

// visual cue list for the beat check: name, time, kind
export const VCUES = [
  ...T.petals.map((tt, i) => ({ name: 'pane' + i, t: tt })), { name: 'reveal', t: T.reveal }, { name: 'topdown-cut', t: T.topdown },
  { name: 'ignite', t: T.ignite }, ...T.cracks.map((tt, i) => ({ name: 'crack' + (i + 1), t: tt })), { name: 'shatter', t: T.shatter },
  ...WL.map((w, i) => ({ name: 'weld' + i, t: w })), { name: 'carve', t: T.carve }, { name: 'blaze', t: T.blaze },
];
VCUES.forEach(c => EV.push({ t: c.t, type: 'cue', name: c.name }));
EV.sort((a, c) => a.t - c.t);

// ---------------- state ----------------
export function state(t) {
  const Lt = light(t);
  let cam = camera(t), floorMode = 1, topCam = null;
  if (!cam) {   // top-down: the phoenix on the flagstones
    floorMode = 2; const z = key(t, [[T.topdown, 1.0], [T.whip, 1.12]], lin);
    const cx = 1000 * Lt.sx + key(t, [[T.topdown, -40], [T.whip, 10]], lin), cz = 1000 * Lt.sz + 30;
    topCam = [cx, cz, z]; cam = [0, 0, 1];
  }
  // two-frame shake on every crack
  const hits = [...T.cracks, T.shatter];
  for (const h of hits) { const k = Math.round((t - h) * 24); if (k >= 0 && k < 2) cam = [cam[0] + (k ? -5 : 7) / cam[2], cam[1] + (k ? 4 : -6) / cam[2], cam[2]]; }
  const petal = PETAL_GROUPS.map((_, gi) => arrive(t, T.petals[gi]));
  const pre = .17;   // pre-dawn: every pane faintly lit by a cold sky
  const petalLit = gi => [Math.max(pre, petal[gi]), 0, 0];
  const med = Math.max(pre, arrive(t, T.reveal, .2));
  const st = {
    ...Lt, cam, time: t, floorMode, topCam, floor: { camD: 2600, eyeH: 300 },
    petalLit, groupOf: i => PETAL_GROUPS.findIndex(g => g.includes(i)), outerAvg: petal.reduce((a, c) => a + c, 0) / petal.length,
    medLit: [med, Lt.fireI > 0 ? .3 : 0, 0], bgLit: [med, Lt.fireI > 0 ? .22 : 0, 0],
    phoenix: phoenix(t), flames: flames(t), cracks: crackState(t),
    pm: [-700, 0, 2000, 2300], pmBlur: 2.6, pmSoft: .55,   // patch map is 2x finer now: 2.6 px = half the old blur on the stones
  };
  // crack light: steady glow + a flash on every hit; dimmer in the silence
  let ci = t + EPS < T.shatter ? 2.6 : t + EPS < T.firstWeld ? 1.6 : 1.4;
  for (const h of hits) { const f = Math.max(0, (t - h + EPS) / .3); if (t + EPS >= h && f < 1) ci += (h === T.shatter ? 9 : 5) * (1 - f) * (1 - f); }
  st.crackI = ci; st.crackSun = .3;
  // point lights: fire glow, crack flashes, weld sparks
  const pts = [];
  if (Lt.fireI > 0) pts.push([0, 70, 150, Lt.fireI * .3 * (1 + .12 * Math.sin(t * 19) * Math.sin(t * 7.3)), [1, .5, .18]]);
  [...T.cracks.map((h, i) => [h, IMP[i], 1]), [T.shatter, [0, 10], 2.2]].forEach(([h, p, k]) => { const f = Math.max(0, (t - h + EPS) / .45); if (t + EPS >= h && f < 1) pts.push([p[0], p[1], (40 + 110 * f) * k, 7 * k * (1 - f) * (1 - f), [1, .96, .88]]); });
  const wa = [ANCH.centre, ANCH.tail, ANCH.body, ANCH.wingF, ANCH.wingN, ANCH.head, ANCH.crest, ANCH.flames];
  st.sparks = [];
  WL.forEach((w, i) => { const u = Math.max(0, (t - w + EPS) / .45); if (t + EPS >= w && u < 1) { pts.unshift([wa[i][0], wa[i][1], 30, 9 * (1 - u) * (1 - u), [1, .8, .45]]); st.sparks.push({ x: wa[i][0], y: wa[i][1], u, seed: i }); } });
  st.pts = pts.slice(0, 8);
  // exposure, bloom: the flash and the noon blaze
  let expo = 1.0; for (const h of hits) if (Math.round((t - h) * 24) >= 0 && Math.round((t - h) * 24) < 2) expo += h === T.shatter ? .9 : .45;
  st.expo = expo + .12 * ss(seg(t, T.blaze, T.blaze + .5));
  st.bloom = .5 + .22 * ss(seg(t, T.blaze, T.blaze + .2)) + .25 * (t + EPS >= T.blaze ? Math.exp(-(t - T.blaze) / .5) : 0) + (Lt.fireI > 0 ? .15 : 0);
  st.patchK = floorMode === 2 ? 2.6 : 1.9;
  st.sat = 1.1 + .15 * ss(seg(t, T.blaze, T.blaze + .5));
  st.raysK = 1 + (t + EPS >= T.blaze ? .7 + .6 * Math.exp(-(t - T.blaze) / .6) : 0);
  if (floorMode === 2) { st.vign = .5; st.bloom = .65; st.thr = .45; st.pmBlur = 3.1; st.pmSoft = .6; }   // top-down: ~0.6x the old blur
  // carved inscription: lit by a band of light from the carve cue on
  const gu = seg(t, T.carve, T.carve + BEAT * 1.2);
  st.carve = { gild: ss(gu), sx: t + EPS < T.carve ? -9999 : lerp(-760, 900, eio(gu)) };
  if (t + EPS >= T.carve) st.sweep = gu < 1 ? [lerp(-700, 700, eio(gu)), 360, 1.7 * Math.sin(Math.PI * Math.min(1, gu * 1.2)) + .8 * ss(gu), CARVE_Y] : [0, 900, .8, CARVE_Y];
  return st;
}
// every carved text visible at t, for readcheck
export function texts(t) {
  if (t + EPS < T.carve) return [];
  const s = state(t), c = s.cam; if (s.floorMode === 2) return [];
  const a = toScreen(c, CARVE_BOX[0], CARVE_BOX[1]), z = toScreen(c, CARVE_BOX[2], CARVE_BOX[3]);
  return [{ id: 'carve', text: CARVE_TEXT, x0: a[0], y0: a[1], x1: z[0], y1: z[1] }];
}

// the variable each picture cue switches, for the frame-exact beat check (tools/statecheck.mjs)
export function cueState(t) {
  const st = state(t), cs = crackState(t), grow = t0 => Math.max(0, ...CRACKS.map((c, i) => Math.abs(c.t0 - t0) < 1e-9 ? cs[i].grow : 0));
  const o = {};
  T.petals.forEach((tt, i) => { o['pane' + i] = arrive(t, tt); });
  o.reveal = arrive(t, T.reveal, .2); o['topdown-cut'] = st.floorMode === 2 ? 1 : 0; o.ignite = st.fireI;
  T.cracks.forEach((tc, i) => { o['crack' + (i + 1)] = grow(tc); }); o.shatter = grow(T.shatter);
  WL.forEach((w, i) => { o['weld' + i] = (st.sparks || []).some(sp => sp.seed === i) ? 1 : 0; });
  o.carve = st.carve.sx > -9999 ? 1 : 0; o.blaze = st.sunI > 3 ? 1 : 0;
  return o;
}
