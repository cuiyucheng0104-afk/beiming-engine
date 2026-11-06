// 《叮咚》 — one continuous camera over one doorbell board and the die nested in its chip.
// render(t) depends on t only. All times come from timeline.js.
import { Board, setSize, camFor, camMatrix, toScreen } from './render.js';
import * as WB from './world.js';
import * as DI from './die.js';
import { makeLevels, toChild, toParent, baseOf, drawLevel } from './levels.js';
import { makePost } from './post.js';
import { at, sub, measure } from './geo.js';
import { PAL, rgb } from './palette.js';
import { T, PLOT, DUR, FPS, CUES } from './timeline.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, monotone } from '/core/lib.js';

const W = 1920, H = 1080;
setSize(W, H);
const cv = document.getElementById('c'); cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');
const LV = makeLevels([
  { name: 'board', world: WB, unit: 0.6 },
  { name: 'die', world: DI, unit: 3, parent: 'board', at: WB.CHILD.at, s: WB.CHILD.s },
], W, H);
const post = makePost(W, H);
const LN = Math.log, logLerp = (a, b, e) => Math.exp(lerp(LN(a), LN(b), e));
const SIL = { g: PAL.water.g, h: PAL.water.h }, CUR = PAL.cur;

// ---------- triggers: every visual onset goes through hit(), so the cue check can read the picture ----------
const HITS = {};
const hit = (name, t0) => { HITS[name] = t0; return t0; };
const fl = (t, t0, tau = 0.18) => t < t0 ? 0 : Math.exp(-(t - t0) / tau);          // a flash: instant on, decays
const stay = (t, t0, floor = 0.45, tau = 0.25) => t < t0 ? 0 : floor + (1 - floor) * Math.exp(-(t - t0) / tau);
for (const [n, t0] of CUES) hit(n, t0);
T.bounce.forEach((t0, i) => hit('bounce' + i, t0));

// ======================= the signal path on the board =======================
const tr = WB.byId;
const PATH = ['sw_r1', '#r1', 'r1_c1', 'c1_v1', 'v1_v2', 'v2_u1'];
const R1BODY = { pts: [[38.8, 66.25], [41.2, 66.25]] }; R1BODY.m = measure(R1BODY.pts);
const segs = []; { let s = 0; for (const id of PATH) { const t = id === '#r1' ? { id, ...R1BODY, w: 0.8 } : tr(id); segs.push({ t, s0: s }); s += t.m.len; } }
const sOf = id => segs.find(q => q.t.id === id).s0;
const S_R1 = sOf('#r1') + 1.2, S_C1 = sOf('r1_c1') + tr('r1_c1').m.len, S_V1 = sOf('v1_v2'), S_V2 = sOf('v2_u1'), S_END = sOf('v2_u1') + tr('v2_u1').m.len;
const headS = monotone([[T.launch, 0], [T.r1, S_R1], [T.c1, S_C1], [T.viaDn, S_V1], [T.viaUp, S_V2], [T.u1, S_END]]);
const headPos = t => { const s = clamp(headS(clamp(t, T.launch, T.u1)), 0, S_END); for (let i = segs.length - 1; i >= 0; i--) if (s >= segs[i].s0) return at(segs[i].t.m, s - segs[i].s0); return at(segs[0].t.m, 0); };
// after U1: the OUT trace (silver) along the base bus, then the drive bus (amber) to the coil
const OUTT = tr('out'), DRIVE = tr('drive'), COIL = tr('coil');
const JN = WB.QX.map(x => OUTT.m.len - (WB.QX[2] - x));
const T_PIN = T.out + 0.4;                                             // the silver leaves the OUT pin (after its bond wire)
const outS = monotone([[T_PIN, 0], [T.q[0], JN[0]], [T.q[1], JN[1]], [T.q[2], JN[2]]]);
const DJ = [0, 8, 16];
const driveS = monotone([[T.q[0] + 0.12, 0], [T.q[1] + 0.12, DJ[1]], [T.q[2] + 0.12, DJ[2]], [T.coil, DRIVE.m.len]]);

// ======================= cameras (board units; the die section is held in die units) =======================
const DS = WB.CHILD.s, DA = WB.CHILD.at;
const dieToBoard = (c) => toParent(c, { at: DA, s: DS });
const C_S1 = [25.2, 64.2];
function cam(t) {
  if (t < T.launch) {                                                  // 1: macro on SW1, slow push in, a tiny kick at contact
    const z = lerp(70, 80, eio(seg(t, 0, 1.5))) * (1 + (t >= T.press ? 0.014 * Math.exp(-(t - T.press) * 7) : 0));
    return { x: C_S1[0], y: C_S1[1], z, r: 0 };
  }
  if (t < T.u1) {                                                      // 2: ride the pulse, rising until both ends are in frame
    const z = monotone([[T.launch, 80], [2.7, 60], [T.r1, 46], [T.viaDn, 34], [6.4, 26], [T.u1, 22]])(t);
    const e = eio(seg(t, T.launch, 3.0)), h = headPos(t);
    const p0 = toScreen(camMatrix({ x: C_S1[0], y: C_S1[1], z: 80, r: 0 }), headPos(T.launch));
    const ride = camFor(h, [lerp(p0[0], 760, e), lerp(p0[1], 540, e)], z);
    const f = eio(seg(t, 6.1, T.u1));
    return { x: lerp(ride.x, 55, f), y: lerp(ride.y, 55.5, f), z, r: 0 };
  }
  if (t < T.plunge) {                                                  // 3: crash zoom onto U1, then hold on the hole
    const a = { x: 55, y: 55.5 }, e = eo(seg(t, T.u1, T.u1 + 0.32)), k = eo(seg(t, T.u1, T.u1 + 0.26));
    const z = t < T.u1 + 0.32 ? logLerp(22, 62, e) : lerp(62, 66, seg(t, T.u1 + 0.32, T.plunge));
    return { x: lerp(a.x, WB.U1[0], k), y: lerp(a.y, WB.U1[1], k), z, r: 0 };
  }
  if (t < T.inside) return plunge(t);
  if (t < T.out) return dieToBoard(dieCam(t));
  if (t < T.q[0]) return exitCam(t);
  if (t < T.q[2]) { const e = seg(t, T.q[0], T.q[2]); return { x: lerp(113, 115, e), y: lerp(42.6, 43.2, e), z: lerp(31, 34, e), r: 0 }; }
  if (t < T.coil) {                                                    // whip along the drive bus to the coil
    const e = ei(seg(t, T.q[2], T.coil)) * 0.6 + 0.4 * ss(seg(t, T.q[2], T.coil));
    return { x: lerp(115, WB.LS[0], e), y: lerp(43.2, WB.LS[1], e), z: lerp(34, 29, Math.sin(Math.PI * e) * 0.9 + e * 0.1) + 0 * e, r: 0 };
  }
  if (t < T.ding) {                                                    // crash in, hold on the coil
    const z = t < T.coil + 0.33 ? lerp(29.4, 38, back(seg(t, T.coil, T.coil + 0.33), 1.4)) : lerp(38, 39.5, seg(t, T.coil + 0.33, T.ding));
    return { x: WB.LS[0], y: WB.LS[1], z, r: 0 };
  }
  const e = eo(seg(t, T.ding, 19.3)), z = logLerp(39.5, 9.8, e), k = ss(seg(t, 18.4, 19.3));     // pull out to the whole board
  const cx = clamp(176.5 - 960 / z, 88, WB.LS[0]), cy = clamp(WB.LS[1], 540 / z, 104 - 540 / z);   // keep the board filling the frame until the end
  return { x: lerp(cx, 88, k), y: lerp(cy, 52, k), z, r: lerp(0, -0.012, ss(seg(t, 17.0, 19.5))) };
}
const DIE0 = { x: -80, y: -6, z: 11.4, r: 0.035 };
function plunge(t) {
  const a = { x: WB.U1[0], y: WB.U1[1], z: 66 }, b = dieToBoard(DIE0), e = eio(seg(t, T.plunge, T.inside));
  const z = logLerp(a.z, b.z, e), k = (1 / a.z - 1 / z) / (1 / a.z - 1 / b.z);
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z, r: lerp(0, DIE0.r, e) };
}
const dieX = monotone([[T.inside, -80], [T.dff, -74], [10.0, -58], [T.rom1, 8], [T.rom2, 40], [T.stop, 66]]);
const dieY = monotone([[T.inside, -6], [10.0, -8], [T.rom1, 0], [T.stop, 4]]);
// the stop: locked 12.0–12.45; a slow push toward the driver and the OUT pad (叮 / 咚 stay in frame); held there 12.85–13.0 (the hole we leave by)
const PUSH0 = 12.45, PUSH1 = 12.85, DIE_OUTV = { x: 90, y: 16, z: 12.4 };
function dieCam(t) {
  const tt = Math.min(t, T.stop);
  const c = { x: dieX(tt), y: dieY(tt), z: lerp(11.4, 10.2, ss(seg(tt, T.inside, T.stop))), r: lerp(0.035, 0.02, seg(tt, T.inside, T.stop)) };
  if (t <= PUSH0) return c;
  const e = eio(seg(t, PUSH0, PUSH1));
  return { x: lerp(c.x, DIE_OUTV.x, e), y: lerp(c.y, DIE_OUTV.y, e), z: logLerp(c.z, DIE_OUTV.z, e), r: c.r };
}
// reverse out of the other hole: the zoom is anchored on the die's OUT pad, the anchor then runs up the OUT bond wire
// to the package pin, and the pin glides to where the next shot holds it. Zoom on a smoothstep in log space
// (≈0.15 of the scale per frame at most), so the 180° shutter blur stays a short radial streak.
const OD = [DA[0] + DI.OUT[0] * DS, DA[1] + DI.OUT[1] * DS];
const PINI = [WB.PIN_OUT[0] - 0.8, WB.PIN_OUT[1]];
const EXIT_END = { x: 113, y: 42.6, z: 31, r: 0 };
const T_WIRE0 = T.out + 0.16, T_WIRE1 = T.out + 0.4;                   // silver runs the bond wire after the die's OUT pad
function exitCam(t) {
  const a = dieToBoard(dieCam(T.out));
  const S0 = toScreen(camMatrix(a), OD), S1 = toScreen(camMatrix(EXIT_END), PINI);
  const ez = ss(seg(t, T.out, T.q[0])), u = ss(seg(t, T_WIRE0, T_WIRE1 + 0.05));
  const A = [lerp(OD[0], PINI[0], u), lerp(OD[1], PINI[1], u)], S = [lerp(S0[0], S1[0], ez), lerp(S0[1], S1[1], ez)];
  return camFor(A, S, logLerp(a.z, EXIT_END.z, ez), lerp(a.r, 0, ez));
}

// ======================= scenes =======================
const labelsAt = (t, ids) => { const o = {}; for (const id of ids) { const p = PLOT[id]; o[id] = p ? clamp((t - p[0]) / p[1]) : 0; } return o; };
const BOARD_LABELS = ['push', 'pushE', 'chip', 'chipE', 'spk', 'spkE', 'ding', 'dingE', 'dong'];
const DIE_LABELS = ['rom1', 'rom2'];
// every point on the board's copper, for the sound-wave rings (sampled once)
const SAMPLES = []; for (const t of WB.TRACES) { if (t.layer === 'bottom') continue; const n = Math.max(2, Math.ceil(t.m.len / 0.7)); for (let i = 0; i < n; i++) { const a0 = t.m.len * i / n, a1 = t.m.len * (i + 1) / n, p = at(t.m, (a0 + a1) / 2); SAMPLES.push({ a: at(t.m, a0), b: at(t.m, a1), d: Math.hypot(p[0] - WB.LS[0], p[1] - WB.LS[1]), w: t.w }); } }
const RING_V = 64;
const SIGNAL = new Set(['out', 'b0', 'b1', 'b2']);
const MAIN = new Set(['bat', 'sw_r1', 'r1_c1', 'c1_v1', 'v1_v2', 'v2_u1', 'out', 'b0', 'b1', 'b2', 'c0', 'c1', 'c2', 'drive']);

function sceneBoard(t) {
  const sc = { t, labels: labelsAt(t, BOARD_LABELS), ac: [], dc: [], glow: [], flashes: [] };
  const tf = t >= T.stop && t < T.out ? T.stop : t;                       // the stop freezes every moving light
  sc.t = tf;
  // battery waiting: a low steady glow up to the switch
  sc.dc.push({ trace: tr('bat'), head: 1e9, a: 0.32 + 0.4 * stay(t, T.press, 0.6, 0.6), floor: 1, decay: 1e9, v: 6 });
  // the contact: bounces, then closes
  let contact = 0; T.bounce.forEach((b, i) => { const off = T.bounceOff[i] ?? 1e9; if (t >= b && t < off) contact = 1; });
  if (contact) {
    sc.glow.push({ pts: [[20.75, 61.75], [22.6, 61.75], [25.4, 66.25], [27.25, 66.25]], w: 0.5, a: 0.85, c: CUR.g });
    sc.flashes.push({ p: [24, 64], r: 3.5, a: 0.5, maxPx: 160 });
  }
  T.bounce.forEach((b, i) => { const a = fl(t, b, 0.07); if (a > 0.01) sc.flashes.push({ p: [27.25, 66.25], r: 2.2, a: a * 0.9, maxPx: 120 }); });
  { const a = fl(t, T.press, 0.3); if (a > 0.01) sc.flashes.push({ p: [24, 64], r: 6, a, maxPx: 300 }); }
  // the current runs SW1 -> U1 (DC: a stream behind a travelling head)
  if (t >= T.launch) {
    const S = clamp(headS(Math.min(tf, T.u1)), 0, S_END);
    for (const { t: q, s0 } of segs) {
      const head = S - s0; if (head <= 0) continue;
      const thin = s0 >= sOf('r1_c1'), bottom = q.layer === 'bottom';
      if (q.id === '#r1') { sc.glow.push({ pts: sub(q.m, 0, Math.min(q.m.len, head)), w: 0.55, a: 0.9, c: CUR.g }); continue; }
      sc.dc.push({ trace: q, head: Math.min(q.m.len, head), a: (bottom ? 0.42 : thin ? 0.8 : 1) * (t >= T.plunge ? 0.75 : 1), decay: 9, floor: 0.4, v: thin ? 5 : 8, minPx: thin ? 2.4 : 3.6, maxPx: 60, headGlow: head < q.m.len });
    }
    sc.flashes.push({ p: headPos(Math.min(tf, T.u1)), r: 1.4, a: t < T.u1 ? 0.6 : 0, maxPx: 70 });
  }
  { const a = fl(t, T.launch, 0.2); if (a > 0.01) sc.flashes.push({ p: [27.25, 66.25], r: 2.4, a, maxPx: 150 }); }
  { const a = fl(t, T.r1, 0.22); if (a > 0.01) sc.flashes.push({ p: WB.R1, r: 2.2, a, maxPx: 140 }); }
  { const a = fl(t, T.c1, 0.25); if (a > 0.01) { sc.flashes.push({ p: [50, 66.25], r: 2.6, a, maxPx: 160 }); sc.glow.push({ pts: [[50, 66.25], [50, 70.25]], w: 0.5, a: a * 0.8, c: CUR.g }); } }
  { const a = fl(t, T.viaDn, 0.2); if (a > 0.01) sc.flashes.push({ p: WB.V1, r: 2.0, a, maxPx: 120 }); }
  { const a = fl(t, T.viaUp, 0.2); if (a > 0.01) sc.flashes.push({ p: WB.V2, r: 2.0, a, maxPx: 120 }); }
  { const a = fl(t, T.u1, 0.3); if (a > 0.01) sc.flashes.push({ p: WB.PIN_IN, r: 3, a, maxPx: 200 }); }
  // U1 "conducts" while the signal is inside: its outline glows softly
  { const a = t >= T.u1 && t < T.out + 1 ? 0.18 + 0.5 * fl(t, T.u1, 0.4) : 0; if (a > 0) sc.glow.push({ pts: [[81.2, 42.2], [91.2, 42.2], [91.2, 53.8], [80.8, 53.8], [80.8, 42.6], [81.2, 42.2]], w: 0.14, a, c: SIL.g }); }
  // OUT (silver) -> the bases; each base on its beat; amber leaves each collector
  if (t >= T.out) {
    const s = t < T_PIN ? 0 : Math.min(OUTT.m.len, outS(Math.min(t, T.q[2]))), mv = sub(OUTT.m, 0, s);
    if (s > 0.01 && mv.length > 1) silverStream(sc, OUTT, s, t);
    sc.flashes.push({ p: [WB.PIN_OUT[0], WB.PIN_OUT[1]], r: 3.2, a: fl(t, T_PIN, 0.3), c: SIL, maxPx: 220 });
    WB.QX.forEach((x, k) => {
      const q = T.q[k];
      if (t < q - 0.06) return;
      const b = tr('b' + k), u = seg(t, q - 0.06, q);
      sc.glow.push({ pts: sub(b.m, 0, b.m.len * u), w: 0.3, a: 0.85, c: SIL.g });
      if (t < q) return;
      sc.flashes.push({ p: [x, WB.QY - 2.6], r: 2.2, a: 0.35 + fl(t, q, 0.2), c: SIL, maxPx: 130 });
      const c = tr('c' + k), e = seg(t, q, q + 0.12);
      sc.dc.push({ trace: c, head: c.m.len * e, a: 1, decay: 1e9, floor: 1, v: 6, minPx: 3, maxPx: 70 });
      sc.flashes.push({ p: [x + 1.6, WB.QY + 2.6], r: 2.2, a: 0.3 + fl(t, q, 0.2), maxPx: 130 });
      sc.glow.push({ pts: [[x, WB.QY - 2.6], [x, WB.QY], [x + 1.6, WB.QY + 2.6]], w: 0.22, a: 0.55 * stay(t, q, 0.5), c: CUR.g });   // the transistor conducts
    });
    if (t >= T.q[0] + 0.12) { const n = T.q.filter(q => t >= q).length; sc.dc.push({ trace: DRIVE, head: Math.min(DRIVE.m.len, driveS(t)), a: 0.55 + 0.15 * n, decay: 12, floor: 0.6, v: 10, minPx: 4, maxPx: 90 }); }
  }
  // the voice coil: alternating current rocks back and forth, faster and fuller until the hush
  if (t >= T.coil) {
    const fill = eo(seg(t, T.coil, T.coil + 0.45));
    const f = t < T.hush ? lerp(2.2, 7, seg(t, T.coil, T.hush)) : t < T.ding ? 0.7 : lerp(3, 0, seg(t, T.ding, 18.8));
    const ph = acPhase(t);
    const aAC = t < 18.8 ? 1 : 1 - seg(t, 18.8, 19.3);
    if (aAC > 0) sc.ac.push({ trace: COIL, s0: 0, s1: COIL.m.len * fill, a: aAC * (t < T.hush ? lerp(0.6, 1, seg(t, T.coil, T.hush)) : 1), lam: 3.4, amp: 0.34, phase: ph });
    const dcA = stay(t, T.dong, 0.0, 1) * 0 + ss(seg(t, 18.2, 19.2));
    if (dcA > 0) sc.dc.push({ trace: COIL, head: 1e9, a: dcA * 0.75, decay: 1e9, floor: 1, v: 3, minPx: 3, maxPx: 40, headGlow: false });
    sc.flashes.push({ p: WB.LS, r: 3.5, a: (t < T.hush ? 0.25 * fill : 0.4) + 0.9 * fl(t, T.ding, 0.35) + 0.9 * fl(t, T.dong, 0.35), maxPx: 260 });
  }
  // 叮: the first ring; 咚: the second ring and every trace on the board lights at once
  sc.myLight = (g, z, tt, vb) => rings(g, z, t);
  if (t >= T.dong) {
    // every trace takes one amber DC stream at once (0.35 s from its start to its end), held at 0.8, easing to 0.4 by 19.0;
    // the path the press took (BT1 -> SW1 -> U1 -> Q1–Q3 -> LS1) keeps full brightness and a near-white core
    const lvl = lerp(0.8, 0.4, ss(seg(t, 18.0, 19.0))), kick = 0.35 * fl(t, T.dong, 0.3), head = eo(seg(t, T.dong, T.dong + 0.35)), zz = cam(t).z;
    for (const q of WB.TRACES) {
      if (q.id === 'coil') continue;
      const bottom = q.layer === 'bottom', main = MAIN.has(q.id), a = (main ? 1 : lvl) * (bottom ? 0.5 : 1) + kick;
      if (SIGNAL.has(q.id)) sc.glow.push({ pts: sub(q.m, 0, q.m.len * head), w: Math.max(q.w * 0.7, 4 / zz), a: Math.min(1, a) * 0.8, c: SIL.g });
      else sc.dc.push({ trace: q, head: q.m.len * head, a, decay: 1e9, floor: 1, v: 5, minPx: main ? 4.6 : 3.6, maxPx: 40, headGlow: head < 1 });
      if (main && head > 0) sc.glow.push({ pts: sub(q.m, 0, q.m.len * head), w: Math.max(q.w * 0.25, 1.6 / zz), a: 0.85, c: SIGNAL.has(q.id) ? SIL.h : CUR.h });
    }
    const pa = 0.5 * lvl + 0.5 * kick;
    for (const p of WB.PADS) sc.flashes.push({ p: [p.x, p.y], r: Math.min(2.2, (p.r ?? Math.max(p.w, p.h) / 2) * 1.8), a: pa * 0.55, maxPx: 24 });
  }
  return sc;
}
// AC phase: integrated from the changing frequency so the dashes never jump
const acF = t => t < T.hush ? lerp(2.2, 7, seg(t, T.coil, T.hush)) : t < T.ding ? lerp(7, 0.6, seg(t, T.hush, T.hush + 0.15)) : lerp(3, 0, seg(t, T.ding, 18.8));
function acPhase(t) { let p = 0; const dt = 1 / 240; for (let x = T.coil; x < t; x += dt) p += 2 * Math.PI * acF(x) * Math.min(dt, t - x); return p; }
function silverStream(sc, q, head, t) {
  // a second flow made of glow pieces: a faint line, a lit tail, dashes moving at signal speed, a bright head
  if (head <= 0.01) return;
  const m = q.m, tail = sub(m, Math.max(0, head - 30), head);
  sc.glow.push({ pts: sub(m, 0, head), w: q.w * 0.55, a: 0.32, c: SIL.g });
  if (tail.length > 1) sc.glow.push({ pts: tail, w: q.w * 0.8, a: 0.55, c: SIL.g });
  for (let s = (t * 26) % 4; s < head; s += 4) { const p = sub(m, s, Math.min(head, s + 1.3)); if (p.length > 1) sc.glow.push({ pts: p, w: q.w * 0.5, a: 0.75, c: SIL.h }); }
  sc.flashes.push({ p: at(m, head), r: 1.3, a: head < m.len - 0.05 ? 0.9 : 0.25, c: SIL, maxPx: 70 });
}
function rings(g, z, t) {
  for (const [t0, k] of [[T.ding, 0], [T.dong, 1]]) {
    if (t < t0) continue;
    const r = WB.COIL_R + RING_V * (t - t0), A = Math.exp(-(t - t0) / 1.5), band = 2.6 + 0.8 * (t - t0);
    g.lineCap = 'round';
    g.beginPath(); g.arc(WB.LS[0], WB.LS[1], r, 0, 6.2832); g.strokeStyle = rgb(k ? CUR.g : [255, 222, 160], 0.5 * A); g.lineWidth = Math.min(band * 0.5, 24 / z); g.stroke();
    g.beginPath(); g.arc(WB.LS[0], WB.LS[1], r, 0, 6.2832); g.strokeStyle = `rgba(255,250,235,${0.4 * A})`; g.lineWidth = Math.min(band * 0.12, 5 / z); g.stroke();
    for (const s of SAMPLES) {
      const d = Math.abs(s.d - r); if (d > band) continue;
      const a = A * Math.exp(-(d * d) / (band * band * 0.25));
      g.beginPath(); g.moveTo(s.a[0], s.a[1]); g.lineTo(s.b[0], s.b[1]); g.strokeStyle = `rgba(255,236,190,${0.9 * a})`; g.lineWidth = s.w * 0.9; g.stroke();
    }
  }
}

function sceneDie(t) {
  const sc = { t, labels: labelsAt(t, DIE_LABELS), ac: [], dc: [], glow: [], flashes: [] };
  const tf = t >= T.stop && t < T.out ? T.stop : t; sc.t = tf;
  const D = DI.byId;
  const stream = (id, t0, t1, a = 1) => { if (tf < t0) return; const q = D(id), s = q.m.len * clamp((tf - t0) / (t1 - t0)); silverStream(sc, q, s, tf); };
  stream('in', 8.55, T.sch); stream('sch', T.sch, T.dff - 0.05); stream('dff', T.dff, T.seq[0]);
  // cells conduct: their symbol edges glow
  const cell = (polys, t0, w = 0.9) => { if (t < t0) return; const a = stay(t, t0, 0.42, 0.3); for (const p of polys) sc.glow.push({ pts: p, w, a, c: SIL.g }); };
  cell(DI.SCH_SYM, T.sch); cell(DI.DFF_SYM, T.dff);
  if (t >= T.sch) sc.flashes.push({ p: DI.SCH, r: 16, a: fl(t, T.sch, 0.25), c: SIL, maxPx: 200 });
  if (t >= T.dff) sc.flashes.push({ p: DI.DFF, r: 16, a: fl(t, T.dff, 0.25), c: SIL, maxPx: 200 });
  // the oscillator starts and clocks the sequencer, faster and faster
  if (tf >= T.seq[0]) {
    cell(DI.OSC_SYM, T.seq[0]);
    const clk = D('clk'), n = T.seq.filter(x => tf >= x).length, last = T.seq[n - 1];
    const ph = n * Math.PI + Math.PI * clamp((tf - last) / 0.12);
    sc.glow.push({ pts: clk.pts, w: clk.w * 0.5, a: 0.22, c: SIL.g });
    const lam = 9, off = (Math.sin(ph) * 0.35) * lam;
    for (let s = off; s < clk.m.len; s += lam) { const p = sub(clk.m, Math.max(0, s), Math.min(clk.m.len, s + lam * 0.36)); if (p.length > 1) sc.glow.push({ pts: p, w: clk.w * 0.7, a: 0.7, c: SIL.h }); }
  }
  const scan = D('scan');
  T.seq.forEach((t0, i) => {
    if (tf < t0) return;
    const p = DI.SEQ[i];
    sc.glow.push({ pts: DI.SEQ_SYM[i], w: 0.9, a: stay(t, t0, 0.5, 0.2), c: SIL.g });
    sc.flashes.push({ p, r: 7, a: 0.25 + 0.8 * fl(t, t0, 0.12), c: SIL, maxPx: 120 });
  });
  { const n = T.seq.filter(x => tf >= x).length; if (n) silverStream(sc, scan, Math.min(scan.m.len, (DI.SEQ[n - 1][0] - DI.SEQ[0][0]) + 4.5), tf); }
  // the two tone cells
  stream('addr', T.rom1 - 0.42, T.rom1);
  stream('r12', T.rom1 + 0.05, T.rom2);
  [[T.rom1, 0], [T.rom2, 1]].forEach(([t0, k]) => {
    if (t < t0) return;
    sc.glow.push({ pts: DI.ROM_SYM[k], w: 1.1, a: stay(t, t0, 0.5, 0.3), c: SIL.g });
    sc.flashes.push({ p: k ? DI.ROM2 : DI.ROM1, r: 26, a: 0.1 + 0.55 * fl(t, t0, 0.2), c: SIL, maxPx: 170 });
  });
  // the output fires (13.0): ROM -> driver -> OUT pad
  if (t >= T.out) {
    stream('r2d', T.out - 0.06, T.out + 0.08); stream('outp', T.out + 0.08, T.out + 0.16);
    cell(DI.DRV_SYM, T.out);
    sc.flashes.push({ p: DI.DRV, r: 18, a: fl(t, T.out, 0.25), c: SIL, maxPx: 240 });
  }
  return sc;
}
const SCENES = { board: sceneBoard, die: sceneDie };

// ======================= the finger: never drawn as an object (STYLE: nothing in perspective, nothing realistic) =======================
// Only what the board would show: a defocused dark occlusion coming in from the lower left and the soft shadow it
// throws, both tightening as it nears the board; the contact flash lights its underside amber. It waits lower-left
// of SW1 while 按下 / PUSH plots (0.25–1.0 s), so the label is never covered, then presses in half a second.
const TIP = [24.4, 63.6], FDIR = [-0.62, 0.78];                              // finger comes in from the lower left
const fingerK = monotone([[0, 1.26], [0.55, 1.3], [1.0, 1.34], [T.press, 1.03], [T.launch - 0.1, 1.035], [2.3, 1.3], [2.7, 2.0]]);
const fingerIn = monotone([[0, 9.6], [0.6, 8.8], [1.0, 7.6], [T.press, 0], [T.launch, 0]]);
function finger(t, M) {
  if (t > 2.7) return;
  const k = fingerK(t), C = [W / 2, H / 2], lift = seg(t, T.launch - 0.1, 2.7), fi = fingerIn(Math.min(t, T.launch)), slide = [-26 * ei(lift) + FDIR[0] * fi, 30 * ei(lift) + FDIR[1] * fi];
  const P = p => { const q = toScreen(M, [p[0] + slide[0], p[1] + slide[1]]); return [C[0] + (q[0] - C[0]) * k, C[1] + (q[1] - C[1]) * k]; };
  const tip = P(TIP), base = P([TIP[0] + FDIR[0] * 46, TIP[1] + FDIR[1] * 46]), zpx = M[0] * k;
  const wPx = 10 * zpx, ang = Math.atan2(base[1] - tip[1], base[0] - tip[0]), len = Math.hypot(base[0] - tip[0], base[1] - tip[1]);
  const near = clamp((1.34 - k) / 0.31);                                       // 0 = hovering high, 1 = on the button
  // the shadow on the board: key light from the upper left, so it falls down and a little right; darker and tighter as it nears
  const so = (k - 1) * 7 * M[0];
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'multiply';
  ctx.filter = `blur(${(14 + (k - 1) * 90).toFixed(1)}px)`; ctx.translate(tip[0] + so * 0.3, tip[1] + so * 0.95); ctx.rotate(ang);
  ctx.fillStyle = `rgba(8,26,17,${(0.42 + 0.3 * near).toFixed(3)})`; ctx.beginPath(); ctx.roundRect(-wPx * 0.5 / k, -wPx * 0.5 / k, len / k * 1.2, wPx / k, wPx * 0.5 / k); ctx.fill();
  ctx.restore();
  // the occlusion itself: one flat, low-saturation dark tone (no skin, no nail, no highlight), far out of focus
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = `blur(${Math.max(7, (k - 1) * 95).toFixed(1)}px)`;
  ctx.translate(tip[0], tip[1]); ctx.rotate(ang);
  ctx.fillStyle = `rgba(4,13,9,${(0.4 + 0.22 * near).toFixed(3)})`; ctx.beginPath(); ctx.roundRect(-wPx * 0.5, -wPx * 0.5, len + wPx, wPx, wPx * 0.5); ctx.fill();
  // the contact flash lights its underside from the button
  const fa = fl(t, T.press, 0.25) * 0.5 + (t >= T.press && t < T.launch ? 0.1 : 0);
  if (fa > 0.01) { ctx.globalCompositeOperation = 'lighter'; const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, wPx * 0.8); rg.addColorStop(0, rgb(CUR.g, fa)); rg.addColorStop(1, rgb(CUR.g, 0)); ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, wPx * 0.8, 0, 6.2832); ctx.fill(); }
  ctx.restore();
}

// ======================= U1's bond wires (gold, drawn over the die: they sit above it in the package) =======================
// 15 of the QFN's 16 pins are bonded (one NC) to pads on the die's edge; IN and OUT are the ones the story uses.
const dpb = (x, y) => [DA[0] + x * DS, DA[1] + y * DS];
const PINL = d => [WB.PIN_IN[0] + 0.8, WB.U1[1] + d], PINR = d => [WB.PIN_OUT[0] - 0.8, WB.U1[1] + d];
const PINT = d => [WB.U1[0] + d, 42.0], PINB = d => [WB.U1[0] + d, 54.0];
const WIRES = [
  [dpb(-152, -50), PINL(-3.6)], [dpb(-152, -30), PINL(1.2), 'in'], [dpb(-152, 30), PINL(3.6)],
  [dpb(152, -50), PINR(-3.6)], [dpb(152, 30), PINR(-1.2), 'out'], [dpb(152, 50), PINR(1.2)], [dpb(140, 64), PINR(3.6)],
  [dpb(-120, -64), PINT(-3.6)], [dpb(-40, -64), PINT(-1.2)], [dpb(40, -64), PINT(1.2)], [dpb(120, -64), PINT(3.6)],
  [dpb(-120, 64), PINB(-3.6)], [dpb(-40, 64), PINB(-1.2)], [dpb(40, 64), PINB(1.2)], [dpb(100, 64), PINB(3.6)],
];
function bondWires(t, M, z) {
  const vis = ss(seg(z, 14, 26)); if (vis <= 0) return;
  ctx.save(); ctx.setTransform(...M); ctx.lineCap = 'round';
  const w = Math.max(0.028, 0.9 / z);
  for (const [p, q] of WIRES) {
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.strokeStyle = `rgba(150,112,46,${0.85 * vis})`; ctx.lineWidth = w * 1.5; ctx.stroke();
    ctx.strokeStyle = `rgba(232,200,120,${0.9 * vis})`; ctx.lineWidth = w; ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], w * 1.6, 0, 6.2832); ctx.arc(q[0], q[1], w * 1.2, 0, 6.2832); ctx.fillStyle = `rgba(232,200,120,${0.9 * vis})`; ctx.fill();
  }
  // lit wires: IN carries the pulse into the die (7.0), OUT carries the silver back out (13.16–13.4)
  ctx.globalCompositeOperation = 'lighter';
  const lit = (p, q, t0, t1, hold) => {
    if (t < t0) return; const u = ss(seg(t, t0, t1)), e = [lerp(p[0], q[0], u), lerp(p[1], q[1], u)], a = (t < t1 ? 1 : hold + (1 - hold) * Math.exp(-(t - t1) / 0.3)) * vis;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(e[0], e[1]);
    ctx.strokeStyle = rgb(SIL.g, 0.22 * a); ctx.lineWidth = 12 / z; ctx.stroke();
    ctx.strokeStyle = rgb(SIL.h, 0.9 * a); ctx.lineWidth = Math.max(w * 1.2, 2.2 / z); ctx.stroke();
    if (t < t1 + 0.1) { const rg = ctx.createRadialGradient(e[0], e[1], 0, e[0], e[1], 40 / z); rg.addColorStop(0, rgb(SIL.h, 0.8 * vis)); rg.addColorStop(1, rgb(SIL.g, 0)); ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(e[0], e[1], 40 / z, 0, 6.2832); ctx.fill(); }
  };
  const wi = WIRES.find(x => x[2] === 'in'), wo = WIRES.find(x => x[2] === 'out');
  if (t < T.stop) lit(wi[1], wi[0], T.u1 + 0.05, T.u1 + 0.3, 0.45);
  lit(wo[0], wo[1], T_WIRE0, T_WIRE1, 0.5);
  ctx.restore();
}

// ======================= frame =======================
function stackAt(t) {
  const c = cam(t), kid = LV.die, cd = toChild(c, kid);
  const b = baseOf(LV, 'die', cd, W, H);
  return { base: b.l, cam: b.cam, boardCam: c };
}
function drawAt(t) {
  const { base, cam: c, boardCam } = stackAt(t);
  drawLevel(LV, base, c, n => SCENES[n](t), W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(base.cv, 0, 0);
  if (t > 6.0 && t < 16.0) bondWires(t, camMatrix(boardCam), boardCam.z);
  if (t < 2.8) finger(t, camMatrix(boardCam));
}
const DOF = [[0, 2.0, 0.55], [2.0, 5.6, 0.35], [5.6, 8.0, 0.12], [8.0, 9.0, 0.8], [9.0, 13.0, 0.2], [13.0, 14.0, 0.4], [14.0, 15.0, 0.2], [15.0, 16.5, 0.35], [16.5, 99, 0.06]];
function postFor(t, st) {
  const d = DOF.find(q => t >= q[0] && t < q[1]);
  const c = st.boardCam;
  return { t, dof: d[2], motes: t > 17.0 ? 1 - 0.5 * seg(t, 17, 19) : 1, px: c.x * c.z, py: c.y * c.z };
}
const acc = new OffscreenCanvas(W, H), actx = acc.getContext('2d');
const SHUT = 0.5 / FPS;                                                   // 180° shutter
function motionPx(t) {
  const a = Math.max(0, t - SHUT / 2), b = Math.min(DUR, t + SHUT / 2);
  const ca = cam(a), cb = cam(b);
  const Ma = camMatrix(ca), Mb = camMatrix(cb);
  const inv = (M, p) => { const det = M[0] * M[3] - M[1] * M[2], x = p[0] - M[4], y = p[1] - M[5]; return [(M[3] * x - M[2] * y) / det, (-M[1] * x + M[0] * y) / det]; };
  let m = 0; for (const p of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]]) { const w = inv(Ma, p), q = toScreen(Mb, w); m = Math.max(m, Math.hypot(q[0] - p[0], q[1] - p[1])); }
  return m;
}
window.DUR = DUR;
window.render = t => {
  const N = Math.min(12, Math.max(1, Math.ceil(motionPx(t) / 3)));
  if (N <= 1) drawAt(t);
  else {
    for (let i = 0; i < N; i++) { const ti = clamp(t + (i / (N - 1) - 0.5) * SHUT, 0, DUR); drawAt(ti); actx.globalAlpha = 1 / (i + 1); actx.drawImage(cv, 0, 0); }
    actx.globalAlpha = 1; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(acc, 0, 0);
  }
  post(ctx, postFor(t, stackAt(t)));
};
window.TEXTS = t => {
  const { base, cam: c } = stackAt(t), out = [];
  const walk = (l, cc, clip) => {
    for (const b of l.board.texts(cc, SCENES[l.name](t), l.name + ':')) { if (clip && (b.x0 < clip[0] || b.x1 > clip[2] || b.y0 < clip[1] || b.y1 > clip[3])) continue; out.push(b); }
    const M = camMatrix(cc);
    for (const k of l.kids) {
      const B = k.world.BOARD, p0 = toScreen(M, [k.at[0] + B.x0 * k.s, k.at[1] + B.y0 * k.s]), p1 = toScreen(M, [k.at[0] + B.x1 * k.s, k.at[1] + B.y1 * k.s]);
      const r = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
      if (r[2] - r[0] > 3) walk(k, toChild(cc, k), r);
    }
  };
  walk(base, c, null);
  return out;
};
// the picture's own onsets, for tools/cuecheck.mjs: every hit() name and whether its light has started at t
window.PROBE = t => { const o = {}; for (const [n, t0] of Object.entries(HITS)) o[n] = t >= t0 - 1e-9 ? 1 : 0; return o; };
window.HITS = HITS;

// ======================= sound events (events.mjs -> events.json -> mix.py) =======================
const EV = [{ t: 0, type: 'start' }];
EV.push({ t: 0, type: 'hover' }, { t: 1.0, type: 'pressdown' }, { t: T.press, type: 'press' });
T.bounce.forEach((b, i) => EV.push({ t: b, type: 'bounce', i }));
EV.push({ t: T.launch, type: 'launch' }, { t: T.launch, type: 'lift' }, { t: T.r1, type: 'r1' }, { t: T.c1, type: 'c1' }, { t: T.viaDn, type: 'viaDn' }, { t: T.viaUp, type: 'viaUp' },
  { t: T.u1, type: 'u1' }, { t: T.plunge, type: 'plunge' }, { t: T.sch, type: 'sch' }, { t: T.dff, type: 'dff' });
T.seq.forEach((s, i) => EV.push({ t: s, type: 'seq', i }));
EV.push({ t: T.rom1, type: 'rom', i: 0 }, { t: T.rom2, type: 'rom', i: 1 }, { t: T.stop, type: 'stop' }, { t: T.out, type: 'out' });
T.q.forEach((q, i) => EV.push({ t: q, type: 'q', i }));
EV.push({ t: T.q[2], type: 'whip' }, { t: T.coil, type: 'coil' }, { t: T.hush, type: 'hush' }, { t: T.ding, type: 'ding' }, { t: T.dong, type: 'dong' }, { t: DUR, type: 'end' });
for (const [id, [t0, d]] of Object.entries(PLOT)) EV.push({ t: t0, type: 'plot', id, d, big: ['ding', 'dong', 'rom1', 'rom2'].includes(id) });
window.EV = EV.map(e => ({ ...e, t: Math.round(e.t * 1e6) / 1e6 })).sort((a, b) => a.t - b.t);
window.READY = true;
