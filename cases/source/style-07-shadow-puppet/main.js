// 渔夫还珠 — render(t): lamps × carved hide × cloth. Deterministic; every time comes from timeline.js.
import { makeGL } from './gl.js';
import { canvas, DYE } from './carve.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back, vnoise, hash } from '/core/lib.js';
import * as PU from './puppets.js';
import { T, DUR, at, timelineJSON } from './timeline.js';
import { drawFrame, drawAudience, CLOTH } from './stage.js';

const qs = new URLSearchParams(location.search);
const W = 1920, H = 1080;
const [trc, tr] = canvas(W, H), [frc, fr] = canvas(W, H), [lyc, ly] = canvas(W, H);
const GL = makeGL(document.getElementById('gl'));
await document.fonts.load('900 104px "Noto Serif SC"', '渔夫还珠');
const P = PU.buildPieces();
const { chain, Tm, Rm, Sm, ap, put } = PU;

const E = (t, a, b) => ss(seg(t, a, b));
const BEAT = .75, FB = .375;
const lerp2 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];

// ============================== Lamps ==============================
export const LAMPS = [[650, 380], [1250, 350], [1850, 380]];
const ON = [T.lamp1, T.lamp2, T.lamp3], OFF = [1e9, T.snuff2, T.snuff3];
function lampI(k, t) {
  const wind = 1 + 1.6 * E(t, T.surge, T.surge + .4) * (1 - E(t, T.gong, T.gong + .2));
  const fl = 1 + wind * (.06 * (vnoise(t * 7 + k * 13) - .5) * 2 + .03 * Math.sin(t * 23 + k * 2));
  const u = t - ON[k];
  // the first lamp already shows a small pilot flame on frame 0, and catches over ~4 frames (no one-frame flash)
  const pre = k === 0 ? .42 : 0, rise = k === 0 ? .42 : .3;
  let I = u < 0 ? pre : u < rise ? lerp(pre, 1, eo(u / rise)) + (k === 0 ? .4 : .55) * Math.sin(u / rise * Math.PI) : 1;
  if (t > OFF[k]) { const v = (t - OFF[k]) / .35; I *= v < 1 ? (1 - v) * (.65 + .35 * Math.sin(v * 44)) : 0; }
  // the pearl steals the light, one lamp per half-beat (centre lamp → left → right), down to ~35–40 %;
  // the breach gust brings them back to ~90 %, the gong restores them fully
  I *= 1 - .72 * E(t, STEAL[k], STEAL[k] + .2) * (1 - .85 * E(t, T.breach, T.breach + .25)) * (1 - E(t, T.gong, T.gong + .05));
  if (k === 2) I *= 1 - .55 * E(t, T.offscreen, T.crash) * (1 - E(t, T.gong, T.gong + .05));   // the dragon, near the lamp, shades it
  if (k === 0) {                                                  // the last lamp gutters: lower, then a real fight after the clapper
    I *= 1 - .22 * E(t, T.snuff2, T.clap) - .22 * E(t, T.clap, DUR);
    const g = E(t, T.clap, T.clap + .2);
    I *= 1 + g * (.22 * (vnoise(t * 13) - .5) * 2 + .12 * Math.sin(t * 31)) - .45 * Math.exp(-((t - T.gutter - .06) ** 2) / .004);
  }
  return Math.max(0, I * fl);
}
const STEAL = [T.steal2, T.pearl, T.surge];

// ============================== Boat & fisherman ==============================
const OARS = [T.oar1, T.oar2, T.oar3, T.oar4, T.oar5];
function surgeAmt(t) { return back(seg(t, T.surge, T.surge + FB), 1.2) * (1 - .7 * E(t, T.gong - .02, T.gong)) * (1 - E(t, T.gong, T.swap)); }
function boatAt(t) {
  let x = 520 + 24 * eo(seg(t, 0, BEAT));
  for (const o of OARS) x += 80 * eo(seg(t, o, o + .7));
  const s = surgeAmt(t);
  const y = 900 + 5 * Math.sin(t * 2.6) - s * (78 + 16 * Math.sin(t * 2 * Math.PI / BEAT * 2));
  const r = .014 * Math.sin(t * 2.1 + .5) + s * .05 * Math.sin(t * 2 * Math.PI / (BEAT * 2) + 1);
  return { x, y, r };
}
const OARLOCK = [-232, -40], WAIST = [-96, -142];
const local = (b, x, y) => ap(chain(Tm(b.x, b.y), Rm(b.r)), x, y);
function oarGrip(t, b) {      // hand position on the yuloh handle (boat-local), pushed forward on every beat
  if (t >= T.oarDown) return lerp2([-30, -112], [-150, -62], E(t, T.oarDown, T.oarDown + FB));   // lands on the next half-beat
  let push = 0;
  for (const o of OARS) if (t >= o - .1) { const u = t - o; push = u < .34 ? eo(u / .34) : 1 - E(u, .34, .75); }
  return lerp2([-108, -206], [-52, -200], push);
}
function pearlHeld(p) { return add2(lerp2(p.hF, p.hB, .5), [6, -10]); }
function fisherPose(t) {
  const b = boatAt(t), w = local(b, ...WAIST);
  const L = (dx, dy) => local(b, WAIST[0] + dx, WAIST[1] + dy);
  let p = { x: w[0], y: w[1], rot: b.r, head: 0, legF: -.06, legB: .08 };
  let tens = 1;
  if (t < T.oarDown) {
    const g = local(b, ...oarGrip(t, b));
    let lean = 0; for (const o of OARS) if (t >= o - .1) { const u = t - o; lean = u < .34 ? eo(u / .34) : 1 - E(u, .34, .75); }
    p.rot += -.04 + .12 * lean; p.head = -.04 - .06 * lean; p.hF = g; p.hB = add2(g, [-16, 8]);
    p.legF = -.12 * lean; p.legB = .08 + .06 * lean;
  } else if (t < T.cast) {
    const pick = E(t, T.oarDown, T.netUp - .08), up = E(t, T.netUp, T.netUp + .3), wind = E(t, T.cast - .3, T.cast);
    const rest = [L(30, -60), L(16, -56)], low = [L(48, 30), L(30, 34)], high = [L(-52, -196 - 14 * wind), L(-30, -176)];
    p.hF = lerp2(lerp2(rest[0], low[0], pick), high[0], up); p.hB = lerp2(lerp2(rest[1], low[1], pick), high[1], up);
    p.rot += .12 * pick * (1 - up) - (.16 + .06 * wind) * up; p.head = -.12 * up; p.legF = -.2 * up; p.legB = .14 * up;
    p.y += 10 * pick * (1 - up);
  } else if (t < T.splash) {
    const u = eo(seg(t, T.cast, T.cast + .18)), f = E(t, T.cast + .3, T.splash);
    p.hF = lerp2(lerp2(L(-52, -210), L(118, -126), u), L(86, -96), f); p.hB = lerp2(lerp2(L(-30, -176), L(96, -104), u), L(70, -86), f);
    p.rot += lerp(-.22, .2, u) - .1 * f; p.head = lerp(-.12, .04, u); p.legF = lerp(-.2, .1, u);
  } else if (t < T.surge) {
    const k = (t - T.splash) / (FB * .5), a = Math.sin(k * Math.PI), pull = E(t, T.splash, T.pearl);
    const reel = E(t, T.pearl, T.surge);
    p.hF = lerp2(add2(L(80 - 26 * pull, -96), [0, 14 * a]), L(40, -84), reel); p.hB = lerp2(add2(L(56 - 26 * pull, -84), [0, -14 * a]), L(24, -78), reel);
    p.rot += -.08 * pull + .06 * reel; p.head = .05 - .08 * reel;
  } else if (t < T.gong) {
    const rec = E(t, T.breach, T.breach + .2), cow = E(t, T.liang, T.liang + .25), deep = E(t, T.offscreen, T.crash);
    const stag = .07 * Math.sin((t - T.surge) * 2 * Math.PI / (BEAT)) * (1 - cow);
    p.hF = L(40 - 6 * cow, -84 + 14 * cow); p.hB = L(24 - 6 * cow, -78 + 14 * cow);
    p.rot += stag - .16 * rec * (1 - cow) + .14 * cow + .06 * deep; p.head = -.28 * rec * (1 - cow) - .32 * cow; p.y += 14 * cow + 10 * deep;
    p.legF = -.14 * cow; p.legB = .16 * cow;
    tens = 1 + 1.4 * rec + 1.0 * deep;
  } else {
    const raise = E(t, T.ting, T.ting + .5), give = E(t, T.handover, T.handover + .3), ret = E(t, T.jaw, T.swap);
    const look = E(t, T.swap + .1, T.swap + .5), bow = back(seg(t, T.bow, T.bow + .45), 1.1);
    let hF = lerp2(L(40, -86), L(98, -152), raise), hB = lerp2(L(26, -80), L(84, -142), raise);
    hF = lerp2(hF, L(130, -150), give); hB = lerp2(hB, L(116, -142), give);
    hF = lerp2(hF, L(44, -92), ret); hB = lerp2(hB, L(28, -86), ret);
    hF = lerp2(hF, L(56, -50), bow); hB = lerp2(hB, L(44, -46), bow);
    p.hF = hF; p.hB = hB;
    p.rot += .05 * raise * (1 - ret) + .03 * give * (1 - ret) + .5 * bow; p.bend = .5 * bow; p.head = -.14 * raise * (1 - ret) - .3 * look * (1 - bow) + .32 * bow;
    p.legF = -.08 - .1 * bow; p.legB = .1 + .06 * bow;
    tens = t < T.ting ? 1.3 : 1;
  }
  // hand tremor (the puppet is alive in the hand)
  p.x += (vnoise(t * 2.1) - .5) * 3 * tens; p.y += (vnoise(t * 2.7 + 9) - .5) * 2.4 * tens; p.rot += (vnoise(t * 1.7 + 4) - .5) * .018 * tens;
  if (tens > 1.5) { const j = (vnoise(t * 11) - .5) * 2.2 * tens; p.hF = add2(p.hF, [j, -j * .6]); p.hB = add2(p.hB, [j * .8, j * .5]); }
  return p;
}

// ============================== Net & pearl ==============================
const NET_LAND = [1560, 925];
function netState(t, p) {
  if (t < T.cast + .05) return null;
  if (t < T.splash) {              // flying arc, opening as it turns
    const u = seg(t, T.cast + .05, T.splash), h = p ? p.hF : [0, 0];
    const a = h, b = NET_LAND, pos = [lerp(a[0], b[0], eo(u * .9 + .1 * u)), lerp(a[1], b[1], u) - Math.sin(u * Math.PI) * 230];
    return { kind: 'net', pos, rot: lerp(-1.1, .05, eo(u)), sc: lerp(.55, 1, eo(u)) };
  }
  if (t < T.pearl) { const u = seg(t, T.splash, T.pearl); return { kind: 'net', pos: [NET_LAND[0] - 20 * u, NET_LAND[1] + 26 * eo(u)], rot: .05, sc: 1 }; }
  if (t < T.surge) {               // bag lifted out with the pearl, reeled to the hand
    const u = eo(seg(t, T.pearl, T.pearl + .3)), r = E(t, T.pearl + .3, T.surge);
    const up = [NET_LAND[0] - 70, NET_LAND[1] - 190 * u], hand = add2(p.hF, [6, 4]);
    return { kind: 'bag', pos: lerp2(up, hand, r), rot: .1 * Math.sin((t - T.pearl) * 9) * (1 - r), sc: 1 };
  }
  if (t < T.gong) return { kind: 'bag', pos: add2(p.hF, [6, 4]), rot: .12 * Math.sin(t * 5), sc: 1 };
  return null;
}
function pearlPos(t, p, n, D, C) {
  if (t < T.pearl) return null;
  if (n && n.kind === 'bag') return ap(chain(Tm(...n.pos), Rm(n.rot)), 0, 88);
  if (t < T.handover) return pearlHeld(p);
  const mouth = D ? PU.dragonGeom(D).mouth : null;
  if (t < T.swap) { const u = eio(seg(t, T.handover, T.jaw)); return lerp2(pearlHeld(p), mouth || pearlHeld(p), u); }
  return C ? C.win : null;
}

// ============================== Dragon ==============================
const RISE = [[1560, 380], [1650, 510], [1710, 650], [1640, 810], [1730, 945], [1920, 1030], [2150, 1080]];
const FACE = [[1580, 512], [1720, 432], [1880, 506], [1900, 700], [1800, 870], [1940, 1000], [2180, 1080]];
const LAMP3 = LAMPS[2], OFFC = LAMPS[2];
function writhe(pts, t, a) { return pts.map(([x, y], i) => [x + Math.sin(t * 3.1 + i * 1.3) * a * (i ? 1 : .4), y + Math.cos(t * 2.7 + i * 1.1) * a * .8 * (i ? 1 : .4)]); }
function dragonState(t) {
  if (t < T.surge || t >= T.swap) return null;
  let spine, head = 0, jaw = .08, off = null, alpha = 1;
  if (t < T.gong) {
    const u = back(seg(t, T.breach - FB * .5, T.liang), 1.05), dy = (1 - u) * 720, dx = (1 - u) * 90;
    spine = writhe(RISE, t, 10 + 6 * E(t, T.offscreen, T.crash)).map(([x, y]) => [x + dx, y + dy]);
    head = lerp(-.05, -.3, u) - .12 * E(t, T.liang - .05, T.liang + .1) + .1 * E(t, T.offscreen, T.offscreen + .6);
    jaw = .1 + .32 * E(t, T.liang - .1, T.liang + .1) * (1 - .5 * E(t, T.offscreen + .4, T.crash));
    const o = seg(t, T.offscreen, T.gong);
    if (o > 0) {
      off = { s: 1 + 1.5 * ss(o) + .3 * ei(seg(t, T.crash, T.gong)), blur: 24 * Math.pow(o, .75), dark: o };
      const dv = ss(o); spine = spine.map(([x, y], i) => [x - [60, 30, 10, 0, 0, 0, 0][i] * dv, y + [130, 70, 30, 0, 0, 0, 0][i] * dv]);
      head += .25 * dv;
    }
  } else {
    const lower = E(t, T.handover - .2, T.handover + .3);
    spine = writhe(FACE, t, 5).map(([x, y], i) => i === 0 ? [x - 50 * lower, y + 36 * lower] : [x, y]);
    head = .1 + .16 * lower; jaw = .3 * (1 - E(t, T.jaw, T.jaw + .15)) + .02;
    const sn = seg(t, T.gong, T.gong + .125);
    if (sn < 1) off = { s: 1 + .22 * (1 - back(sn, 1.6)), blur: 12 * (1 - sn), about: FACE[0] };
  }
  return { spine, head, jaw, off, alpha };
}
// whisker pendulums, pre-simulated (deterministic)
const WSIM = (() => {
  const dt = 1 / 120, n = Math.ceil(DUR / dt) + 2, A = new Float32Array(n), B = new Float32Array(n);
  let ph = 0, om = 0, pv = null, vv = 0, pb = 0, ob = 0, px = null, vx = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt, d = dragonState(t);
    if (!d) { A[i] = ph *= .98; pv = null; continue; }
    const hx = d.spine[0][0], hy = d.spine[0][1];
    const v = pv == null ? 0 : (hy - pv) / dt, a = (v - vv) / dt; pv = hy; vv = v;
    const vxx = px == null ? 0 : (hx - px) / dt, ax = (vxx - vx) / dt; px = hx; vx = vxx;
    om += (-40 * ph - 3 * om - .0009 * clamp(a, -5000, 5000)) * dt; ph += om * dt;
    ob += (-22 * pb - 2.2 * ob - .0012 * clamp(ax, -5000, 5000)) * dt; pb += ob * dt;
    A[i] = clamp(ph, -.6, .6); B[i] = clamp(pb, -.5, .5);
  }
  return t => { const i = clamp(Math.round(t * 120), 0, n - 1); return [A[i], B[i]]; };
})();
// beard of the fisherman swings with the body
const BSIM = (() => {
  const dt = 1 / 120, n = Math.ceil(DUR / dt) + 2, A = new Float32Array(n);
  let ph = 0, om = 0, pr = null, vr = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt, p = fisherPose(t), r = p.rot + p.head;
    const v = pr == null ? 0 : (r - pr) / dt, a = (v - vr) / dt; pr = r; vr = v;
    om += (-50 * ph - 4 * om - .5 * clamp(a, -300, 300)) * dt; ph += om * dt; A[i] = clamp(ph, -.5, .5);
  }
  return t => A[clamp(Math.round(t * 120), 0, n - 1)];
})();

// ============================== Rain cloud ==============================
const CLOUD_WIN = [-150, 70];
function cloudState(t, mouth) {
  if (t < T.swap) return null;
  const u = E(t, T.swap + .12, T.bow), drift = E(t, T.swap + .4, T.bow + .5);
  const c0 = [mouth[0] - CLOUD_WIN[0], mouth[1] - CLOUD_WIN[1]];
  const c = [c0[0] - 330 * drift, c0[1] - 200 * u + Math.sin(t * 1.3) * 4];
  const jolt = Math.sin((t - T.swap) * 40) * 6 * (1 - seg(t, T.swap, T.swap + .3));
  return { c: [c[0], c[1] + jolt], win: [c[0] + CLOUD_WIN[0], c[1] + CLOUD_WIN[1] + jolt], veil: E(t, T.swap, T.swap + .25) };
}
const FACE_MOUTH = (() => PU.dragonGeom({ spine: writhe(FACE, T.swap, 5).map(([x, y], i) => i === 0 ? [x - 50, y + 36] : [x, y]), head: .26, jaw: .02 }).mouth)();

// ============================== Camera ==============================
function headWorld(t) { const p = fisherPose(t); return ap(chain(Tm(p.x, p.y), Rm(p.rot)), 30, -190); }
function camRaw(t) {
  const b = boatAt(t);
  if (t < T.oar4) {      // pull back from the carved face to the cloth
    const u = eio(seg(t, 0, T.oar4)), h = headWorld(t);
    return [lerp(h[0], b.x + 300, u), lerp(h[1] + 30, 590, u), lerp(2.3, 1.0, u)];
  }
  if (t < T.cast) return [b.x + 300 + 40 * E(t, T.oar4, T.cast), 560, lerp(1.0, 1.08, E(t, T.oar4, T.cast))];
  if (t < T.splash) { const w = eio(seg(t, T.cast + .04, T.cast + .42)); return [lerp(b.x + 340, 1430, w), lerp(590, 660, w), lerp(1.08, 1.22, w)]; }
  if (t < T.surge) return shot4(t);
  if (t < T.breach) { const u = eo(seg(t, T.surge, T.surge + FB)), s = shot4(T.surge - 1e-4); return [lerp(s[0], 1350, u), lerp(s[1], 560, u), lerp(s[2], 1.0, u)]; }
  if (t < T.offscreen) { const u = E(t, T.breach, T.liang); return [lerp(1350, 1400, u), lerp(620, 500, u), lerp(1.06, 1.14, u)]; }
  if (t < T.crash) { const u = E(t, T.offscreen, T.crash); return [lerp(1400, 1260, u), lerp(500, 540, u), lerp(1.14, 1.0, u)]; }
  if (t < T.gong) { const u = eo(seg(t, T.crash, T.crash + 5 / 24)); const D = dragonState(t), e = dragonScreenEye(D); return [lerp(1260, e[0], u), lerp(540, e[1], u), lerp(1.0, 1.75, u)]; }
  if (t < T.ting) { const u = seg(t, T.gong, T.ting); return [1190, 610, lerp(1.27, 1.33, u)]; }
  if (t < T.swap) { const u = E(t, T.ting, T.swap); return [lerp(1190, 1220, u), lerp(610, 600, u), lerp(1.33, 1.38, u)]; }
  if (t < T.snuff3) { const u = E(t, T.swap, T.swap + .6); return [lerp(1220, 1160, u), lerp(600, 540, u), lerp(1.38, 1.0, u)]; }
  const u = eio(seg(t, T.snuff3, DUR)); return [lerp(1160, 1200, u), lerp(540, 600, u), lerp(1.0, .62, u)];
}
// shot 4 (net in → pearl reeled to the hand): push in, and keep the frame centred between the fisherman and the net/pearl,
// with the whole fisherman held at least 8 % inside the left edge, so the cause (his pull) and the effect (the pearl) share the frame
function shot4(t) {
  const z = lerp(1.22, 1.46, E(t, T.splash, T.pearl + .2));
  const p = fisherPose(t), n = netState(t, p);
  const q = n && n.kind === 'bag' ? ap(chain(Tm(...n.pos), Rm(n.rot)), 0, 88) : NET_LAND;
  const left = p.x - 95, mid = (p.x + 30 + q[0]) / 2;
  const cx = Math.min(mid + 60, left + (960 - .08 * 1920) / z);
  const cy = lerp(660, 720, E(t, T.splash, T.pearl + .2));
  const into = E(t, T.splash, T.splash + .45);   // ease out of the whip pan's resting frame
  return [lerp(1430, cx, into), lerp(660, cy, into), z];
}
function dragonScreenEye(D) { if (!D) return [1400, 450]; const G = PU.dragonGeom(D); let e = G.eye; if (D.off) e = offPt(e, D.off); return e; }
function offPt(p, o) { const c = o.about || OFFC; return [c[0] + (p[0] - c[0]) * o.s, c[1] + (p[1] - c[1]) * o.s]; }
function shake(t) {
  const a = 5 * E(t, T.breach, T.breach + .2) + 9 * E(t, T.offscreen, T.crash) + 10 * E(t, T.crash, T.crash + .1);
  const k = t < T.gong ? a : 0;
  return [(vnoise(t * 9) - .5) * 2 * k, (vnoise(t * 8 + 7) - .5) * 2 * k];
}
function camAt(t) {
  const c = camRaw(t), s = shake(t); c[0] += s[0]; c[1] += s[1];
  if (c[2] >= 1) { c[0] = clamp(c[0], 960 / c[2], CLOTH[2] - 960 / c[2]); c[1] = clamp(c[1], 540 / c[2], CLOTH[3] - 540 / c[2]); }
  return c;
}
const camM = ([cx, cy, z]) => [z, 0, 0, z, 960 - cx * z, 540 - cy * z];

// ============================== Title plaque ==============================
const PLQ = [1260, 175];
function plaqueState(t) {
  if (t < T.titleIn || t > T.titleOut + .8) return null;
  const inn = eo(seg(t, T.titleIn, T.titleSet)), off = seg(t, T.titleOut, T.titleOut + .75);
  return { sc: lerp(2.3, 1, inn) * (1 + ei(off) * .8), blur: 30 * (1 - inn) + 32 * off, alpha: (.35 + .65 * inn) * (1 - ei(off)), y: PLQ[1] - 30 * off };
}

// ============================== Drawing ==============================
// a blurred layer: draw pieces with multiply onto a white canvas, then multiply that onto the cloth with blur
function layer(fn, blur, alpha = 1, umbra = 0) {
  if (blur < .3 && alpha >= 1 && !umbra) { fn(tr); return; }
  ly.setTransform(1, 0, 0, 1, 0, 0); ly.filter = 'none'; ly.globalAlpha = 1; ly.globalCompositeOperation = 'source-over'; ly.fillStyle = '#fff'; ly.fillRect(0, 0, W, H);
  fn(ly);
  tr.save(); tr.setTransform(1, 0, 0, 1, 0, 0); tr.globalCompositeOperation = 'multiply'; tr.globalAlpha = alpha; if (blur >= .3) tr.filter = `blur(${blur.toFixed(1)}px)`;
  tr.drawImage(lyc, 0, 0);
  if (umbra > 0) { tr.globalAlpha = umbra; tr.drawImage(lyc, 0, 0); }
  tr.restore();
}
function waveRows(t) {
  const s = surgeAmt(t), calm = 1 - s;
  return [0, 1, 2].map(r => {
    const v = s > .05 ? (Math.floor(t * 12) + r) % 3 : 0;
    const x = 30 * Math.sin(t * .6 + r * 2) * calm + (r - 1) * 20 * Math.sin(t * 1.4) + (s > .05 ? Math.sin(t * 30 + r) * 6 : 0);
    const y = [905, 948, 992][r] + 5 * Math.sin(t * 1.9 + r) - s * [60, 100, 130][r] + (s > .05 ? Math.sin(t * 24 + r * 2) * 7 : 0);
    return { r, v, x, y };
  });
}
function drawScreen(t, C) {
  tr.setTransform(1, 0, 0, 1, 0, 0); tr.filter = 'none'; tr.globalAlpha = 1; tr.globalCompositeOperation = 'source-over';
  tr.fillStyle = '#fff'; tr.fillRect(0, 0, W, H);
  const k = C[0];
  const p = fisherPose(t), b = boatAt(t), n = netState(t, p), D = dragonState(t);
  const wh = WSIM(t);
  if (D) { D.wh = Array.from({ length: 8 }, (_, i) => .2 + wh[0] * (.12 + i * .03) + .06 * Math.sin(t * 4 + i)); D.wh2 = Array.from({ length: 7 }, (_, i) => .26 + wh[1] * (.14 + i * .03) + .05 * Math.sin(t * 4.6 + i)); }
  const mouth = t >= T.swap ? FACE_MOUTH : null;
  const Cl = cloudState(t, FACE_MOUTH);
  const pp = pearlPos(t, p, n, D, Cl);
  const drawPearl = g => { if (pp) put(g, chain(C, Tm(...pp), Rm(t * .4), Sm(.9)), P.pearl); };
  const rows = waveRows(t);
  const rowDraw = (g, w) => put(g, chain(C, Tm(w.x, w.y)), P.waves[w.r][w.v]);
  // back wave row
  rowDraw(tr, rows[0]);
  // dragon (behind the mid row while it is on the cloth; off the screen it is a blurred, swelling shadow)
  if (D) {
    const ab = D.off ? (D.off.about || OFFC) : null;
    const Cd = D.off ? chain(C, Tm(...ab), Sm(D.off.s), Tm(-ab[0], -ab[1])) : C;
    const inMouth = t >= T.gong && pp ? (() => drawPearl) : null;
    layer(g => {
      PU.drawDragon(g, Cd, D, t >= T.handover ? (G => { if (pp) put(g, chain(C, Tm(...pp), Rm(t * .4), Sm(.9)), P.pearl); }) : null);
      const G = PU.dragonGeom(D);
      PU.rods(g, [[ap(Cd, ...G.segs[1].p), ap(Cd, G.segs[1].p[0] + 160, G.segs[1].p[1] + 1200), 4], [ap(Cd, ...G.segs[4].p), ap(Cd, G.segs[4].p[0] + 220, G.segs[4].p[1] + 1100), 4]], k * (D.off ? D.off.s : 1), .55);
    }, (D.off ? D.off.blur : 0) * k, 1, D.off && D.off.dark ? .95 * D.off.dark : 0);   // umbra: near the lamp it blocks more light
  }
  // spray at the breach: carved crests, swapped at 12 fps, lifted off
  if (t >= T.breach - .05 && t < T.offscreen + .4) {
    const u = eo(seg(t, T.breach - .05, T.breach + .2)), o = seg(t, T.liang + .1, T.offscreen + .4);
    const v = Math.floor(t * 12) % 2;
    layer(g => put(g, chain(C, Tm(1660, 905 - 40 * u), Sm(lerp(.5, 1.15, u) * (1 + o * .6))), P.spray[v]), o * 26 * k, 1 - ei(o));
  }
  // the net lands: a small carved splash, swapped at 12 fps, lifted off
  if (t >= T.splash - .04 && t < T.splash + .6) {
    const u = eo(seg(t, T.splash - .04, T.splash + .12)), o = seg(t, T.splash + .25, T.splash + .6);
    layer(g => put(g, chain(C, Tm(NET_LAND[0], NET_LAND[1] + 10), Sm(lerp(.25, .55, u) * (1 + o * .5))), P.spray[Math.floor(t * 12) % 2]), o * 18 * k, 1 - ei(o));
  }
  rowDraw(tr, rows[1]);
  // rain cloud + veil (after the swap)
  if (Cl) {
    put(tr, chain(C, Tm(...Cl.c), Tm(0, 40)), P.veil[Math.floor(t * 12) % 2], .85 * Cl.veil);
    put(tr, chain(C, Tm(...Cl.c)), P.cloud);
    PU.rods(tr, [[ap(C, Cl.c[0] + 300, Cl.c[1] + 100), ap(C, Cl.c[0] + 420, Cl.c[1] + 1300), 4.2]], k, .55);
    drawPearl(tr);
  }
  // boat, oar, fisherman, net, pearl
  const Mb = chain(C, Tm(b.x, b.y), Rm(b.r));
  if (t < T.oarDown + .4 || true) {   // yuloh: handle in the hands (or resting), through the stern oarlock into the water
    const gp = t < T.oarDown ? p.hF : local(b, ...oarGrip(t, b)), ol = local(b, ...OARLOCK);
    const d = [ol[0] - gp[0], ol[1] - gp[1]], L = Math.hypot(...d), u = [d[0] / L, d[1] / L], bl = [ol[0] + u[0] * 120, ol[1] + u[1] * 120];
    tr.save(); tr.globalCompositeOperation = 'multiply'; tr.setTransform(1, 0, 0, 1, 0, 0); tr.strokeStyle = '#4a2612'; tr.lineWidth = 5 * k; tr.lineCap = 'round';
    tr.beginPath(); tr.moveTo(...ap(C, ...gp)); tr.lineTo(...ap(C, ...bl)); tr.stroke(); tr.restore();
    put(tr, chain(C, Tm(...bl), Rm(Math.atan2(u[1], u[0]) - Math.PI / 2)), P.blade);
  }
  put(tr, Mb, P.boat);
  PU.rivet(tr, Mb, ...OARLOCK, 5);
  p.beard = BSIM(t);
  const holdPearl = t >= T.gong && t < T.handover;
  PU.drawFisher(tr, C, p, () => { if (holdPearl) drawPearl(tr); });
  if (n) {
    if (n.kind === 'net') {
      put(tr, chain(C, Tm(...n.pos), Rm(n.rot), Sm(n.sc)), P.net);
    } else {
      put(tr, chain(C, Tm(...n.pos), Rm(n.rot)), P.bag);
      drawPearl(tr);
    }
    // rope from the hand to the knot
    const h = ap(C, ...p.hF), q = ap(C, ...n.pos), m = [(h[0] + q[0]) / 2, Math.max(h[1], q[1]) + 40 * k];
    tr.save(); tr.globalCompositeOperation = 'multiply'; tr.setTransform(1, 0, 0, 1, 0, 0); tr.strokeStyle = '#2a1a10'; tr.lineWidth = 2.4 * k;
    tr.beginPath(); tr.moveTo(...h); tr.quadraticCurveTo(...m, ...q); tr.stroke(); tr.restore();
  }
  if (t >= T.netUp - .1 && t < T.cast + .05) {   // the bundled net in the hands
    put(tr, chain(C, Tm(...lerp2(p.hF, p.hB, .5)), Rm(-.4)), P.bundle);
  }
  // rods: neck rod and two hand rods, going down toward the puppeteer
  const F = PU.fisherFrame(p);
  PU.rods(tr, [[ap(C, ...ap(F.Mt, ...PU.FJ.rod)), ap(C, p.x - 140, p.y + 1000), 4.2], [ap(C, ...p.hF), ap(C, p.hF[0] - 40, p.hF[1] + 1000), 2.8], [ap(C, ...p.hB), ap(C, p.hB[0] - 90, p.hB[1] + 1000), 2.8]], k, .6);
  // front wave row (over the hull)
  rowDraw(tr, rows[2]);
  // title plaque
  const q = plaqueState(t);
  if (q) {
    layer(g => {
      put(g, chain(C, Tm(PLQ[0], q.y), Sm(q.sc)), P.plaque);
      PU.rods(g, [[ap(C, PLQ[0] - 230, q.y + 92), ap(C, PLQ[0] - 300, q.y + 1200), 3.4], [ap(C, PLQ[0] + 230, q.y + 92), ap(C, PLQ[0] + 170, q.y + 1200), 3.4]], k, .55);
    }, q.blur * k, q.alpha);
  }
  return { p, pp };
}

// the dragon off the screen: its umbra presses the whole cloth down (beat-locked: falls from the leap, held, eased by the crash zoom,
// lifted by the gong flash)
function umbraAt(t) { return E(t, T.offscreen, T.offscreen + 4 * FB / 2) * (1 - .45 * E(t, T.crash, T.crash + 5 / 24)) * (1 - E(t, T.gong, T.gong + .05)); }
function lampsAt(t, pp, p) {
  const L = LAMPS.map(([x, y], k) => [x, y + 8 * Math.sin(t * 1.1 + k), lampI(k, t), k === 0 ? lerp(.95, 2.4, E(t, T.clap, DUR)) : .95, k === 0 ? lerp(125, 58, E(t, T.clap, DUR)) : 0]);
  if (pp) {
    const glow = eo(seg(t, T.pearl, T.pearl + .35)) * (1 + .5 * Math.exp(-((t - T.ting) ** 2) / .02) * (t > T.ting - .2 ? 1 : 0)) * (1 - E(t, T.snuff2, DUR) * .7);
    const steal = E(t, T.pearl, T.pearl + .3) * (1 - E(t, T.breach, T.breach + .25)) * .6;   // the pearl is the brightest thing while it holds the light
    L.push([pp[0], pp[1], (.2 + .16 * steal + .12 * umbraAt(t)) * glow * (1 + .08 * Math.sin(t * 19)), 9, 44 + 20 * steal]);
  }
  const um = umbraAt(t);
  if (um > 0 && p) {   // warm rim: a small lamp held close behind the fisherman, so he keeps an edge of light under the dragon
    const c = ap(chain(Tm(p.x, p.y), Rm(p.rot)), 10, -110);
    L.push([c[0], c[1], .5 * um * (1 + .06 * Math.sin(t * 17)), 1.6, 150]);
  }
  return L;
}

function render(t) {
  fr.setTransform(1, 0, 0, 1, 0, 0); fr.clearRect(0, 0, W, H); fr.globalAlpha = 1; fr.filter = 'none';
  const cam = camAt(t), C = camM(cam);
  const { pp, p } = drawScreen(t, C);
  const L = lampsAt(t, pp, p), nEff = L.slice(0, 3).reduce((a, l) => a + l[2], 0);
  // exposure follows the lamps only while they are being lit; after that it is fixed, so every lamp stolen, shaded or snuffed
  // really darkens the cloth (灯即世界)
  const nRef = lerp(Math.max(1, nEff), 3, E(t, T.lamp3 + .3, T.lamp3 + .75));
  drawFrame(fr, C, clamp(nEff, 0, 3) / 1.8);   // always: the valance tassels never pop in or out with the zoom
  drawAudience(fr, E(t, T.snuff3 + .3, T.clap) * .95, t);
  const flash = t >= T.gong ? .85 * (1 - eo(seg(t, T.gong, T.gong + .32))) : 0;
  const end = E(t, T.clap, DUR), um = umbraAt(t);
  const o = { lamps: L, cam, rect: CLOTH, sigB: lerp(720, 560, end), sigC: 125, amb: .3 * (1 - .35 * um), time: t, vign: .48 + .5 * end + .25 * um, sat: 1.12, contrast: .15 + .08 * um,
    expo: 1.55 / Math.sqrt(nRef) * (1 - .45 * um), bloom: .3 + .25 * (t < T.lamp3 + .3 ? 1 : 0), fade: flash, fadeCol: [1, .86, .62],
    tint: [1, lerp(1, .9, end), lerp(1, .74, end)] };
  GL.render(trc, frc, o);
}

// ============================== Events (for the mixer and cue check) ==============================
function events() {
  const ev = [], add = (type, t, o = {}) => ev.push({ type, t: +t.toFixed(4), ...o });
  [T.lamp1, T.lamp2, T.lamp3].forEach((t, i) => add('ignite', t, { i }));
  OARS.forEach((t, i) => add('oar', t, { i }));
  add('press', T.titleIn); add('rodtap', T.titleSet, { v: .5 });
  add('oardown', T.oarDown); add('netup', T.netUp); add('cast', T.cast); add('liftoff', T.titleOut, { v: .7 });
  add('splash', T.splash); add('rope', T.splash + FB, { d: T.pearl - T.splash - FB }); add('pearlup', T.pearl);
  add('dim', T.pearl, { i: 1 }); add('dim', T.steal2, { i: 0 }); add('dim', T.surge, { i: 2 });   // the pearl takes the lamps, one per half-beat
  add('gutter', T.gutter);
  add('surge', T.surge, { d: T.gong - T.surge });
  for (let t = T.surge, i = 0; t < T.gong - .01; t += FB, i++) add('flap', t, { v: .35 + .15 * (i % 2) });   // wave pieces swapped
  add('breach', T.breach); add('creak', T.breach, { d: T.liang - T.breach }); add('roar', T.liang);
  add('offwhoosh', T.offscreen, { d: T.gong - T.offscreen }); add('crashzoom', T.crash);
  add('slam', T.gong); add('silence', T.silence); add('sizzle', T.sizzle);
  add('ting', T.ting); add('rustle', T.handover); add('jaw', T.jaw); add('swap', T.swap); add('rain', T.swap, { d: DUR - T.swap });
  add('bow', T.bow); add('snuff', T.snuff3, { i: 2 }); add('snuff', T.snuff2, { i: 1 }); add('clap', T.clap);
  add('room', 0, { d: T.silence }); add('room', T.ting, { d: DUR - T.ting }); add('water', 0, { d: T.surge });
  add('water', T.ting, { d: DUR - T.ting, v: .5 });
  return ev.sort((a, b) => a.t - b.t);
}
window.EV = events();
window.TL = timelineJSON();
window.TEXTS = t => {
  const q = plaqueState(t);
  if (!q || t < T.titleSet || t >= T.titleOut) return [];
  const C = camM(camAt(t)), a = ap(C, PLQ[0] - 300, q.y - 90), b = ap(C, PLQ[0] + 300, q.y + 90);
  return [{ id: 'title', text: '渔夫还珠', x0: a[0], y0: a[1], x1: b[0], y1: b[1] }];
};
window.render = render; window.DUR = DUR;
render(parseFloat(qs.get('t') ?? '12.9'));
window.READY = true;
