// 面包店的早晨 — picture. render(g, t) is deterministic: everything is a function of t and timeline.js.
import { iso, tri, C, TOPS, LEGS, W, H, mix, hex, css, clamp, lerp, seg, ss, eo, eio, TAU, onPlane, fillPoly, facet, rect, quad,
  phraseLayout, floorType, drawPerson } from './kit.js';
import { T, DUR, STEPS, EVENTS } from './timeline.js';
export { DUR };

const ei = x => { x = clamp(x); return x * x * x; };
const ei2 = x => { x = clamp(x); return x * x; };
const P = (x, y, z = 0) => iso.P(x, y, z);

// ---------- palette (STYLE §3, warm) ----------
const K = {
  ground: '#EFE6D5', yard: '#ECE3D1', walk: '#E7DECD', road: '#DED3C1', curb: '#D3C7B3',
  floor: '#F2E5CE', grid: '#E2D2B6', wall: '#EFE3CB', wallTop: '#F8F0E1', trim: C.green,
  glassDark: '#4A504C', glass: '#CFDDD5', wood: '#C9A57A', woodDk: '#A97F55', oven: '#5B5650', dough: '#F7EFE0',
  bread: '#C68A48', chimney: '#9A7A5E', lampOn: '#F8E8B4', lampOff: '#A8B2AA', post: '#3F4A44',
};

// ---------- world layout (metres) ----------
const WH = 3.2, PARA = .9;                         // wall height, near walls cut to a parapet
const DOOR = [1.6, 3.2], DOORH = 2.6;               // door gap in the facade (x = 12), frame height
const BX = 2.4;                                      // the baker's lane
const ST = [7.2, 4.8, 2.2];                          // station stops along -y: table, oven, shelf
const CHAIR_X = 8.75, CHAIR_Y = [0, 1, 2, 3, 4, 5, 6, 7].map(i => 7.6 - .55 * i);
export const TREE1 = [13.6, -0.7];                 // the street tree beside the door
const SPOT = [10.2, 2.4], GUEST0 = [12.827, 2.4];   // crosses x = 12 exactly on the chime beat
const F1 = 1 / 30 - 1e-4;   // things that appear on a beat start one frame early, so the beat frame is the first one that shows them

// ---------- camera: keys [t, x, y, z, k], eased between keys ----------
const CAM = [
  [0.0, 9.6, 5.6, 1.2, 62, 'lin'],
  [2.4, 9.6, 5.5, 1.2, 67, 'ss'],      // slow push on the dark corner
  [3.6, 5.6, 1.6, 2.2, 54, 'eio'],     // rise and pull back while the lid opens
  [4.8, 5.4, 2.2, 1.6, 55, 'ss'],
  [6.6, 3.9, 4.9, .6, 100, 'eio'],     // push in: the work line
  [7.2, 3.6, 5.6, .6, 118, 'ss'],
  [8.1, 3.4, 6.2, .6, 126, 'ss'],      // follow the baker
  [9.6, 3.4, 4.4, .6, 130, 'eio'],
  [10.2, 3.4, 4.2, .6, 130, 'ss'],
  [11.7, 3.6, 2.6, .6, 132, 'eio'],
  [12.3, 5.59, 3.59, .5, 110, 'eio'],   // the stop: step back and hold; the shelf words, the baker and the fallen chairs whole in one view
  [T.chairs[2], 5.64, 3.64, .5, 112, 'lin'],    // held while the first two chairs stand (a near-locked frame)
  [T.chairs[2], 10.0, 6.2, .45, 142, 'lin'],   // cut on the downbeat (same angle) as chair 3 lands and the row speeds up: in on the row
  [15.6, 9.45, 4.55, .45, 170, 'eio'],    // ride the domino toward the far end; the waiting guest at the right edge
  [16.8, 11.7, 2.6, 1.3, 165, 'eio'],  // over to the door: the guest still waiting
  [17.4, 11.6, 2.6, 1.3, 162, 'ss'],
  [19.2, 8.6, 5.0, 1.2, 60, 'q5'],    // pull out to the whole corner
  [DUR, 8.6, 5.0, 1.2, 60, 'lin'],
];
const sine = x => (1 - Math.cos(Math.PI * clamp(x))) / 2;
const q5 = x => { x = clamp(x); return x < .5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2; };
const EASE = { lin: x => x, ss, eio, sine, q5 };
export const CUTS = CAM.filter((k, i) => i && k[0] === CAM[i - 1][0]).map(k => k[0]);
export function camAt(t) {
  let i = 0; while (i < CAM.length - 2 && t >= CAM[i + 1][0]) i++;
  const a = CAM[i], b = CAM[i + 1], f = EASE[b[5]](seg(t, a[0], b[0]));
  return { x: lerp(a[1], b[1], f), y: lerp(a[2], b[2], f), z: lerp(a[3], b[3], f), k: a[4] * Math.pow(b[4] / a[4], f) };
}

// ---------- motion functions ----------
// walk position fraction with short accel/decel ramps (constant cadence in the middle)
function walkF(t, a, b, r = .18) {
  if (t <= a) return 0; if (t >= b) return 1;
  const L = b - a, v = 1 / (L - r);            // area under trapezoid = 1
  const u = t - a;
  if (u < r) return .5 * v * u * u / r;
  if (u > L - r) { const w = L - u; return 1 - .5 * v * w * w / r; }
  return .5 * v * r + v * (u - r);
}
const gait = (t, a, b) => {                      // leg phase so strikes land on a + 0.3k
  const amp = ss(seg(t, a, a + .15)) * (1 - ss(seg(t, b - .05, b + .12)));
  return { walking: amp > .01, phase: Math.PI / 2 + Math.PI * (t - a - .3) / .3, amp };
};
function bakerAt(t) {
  let y = ST[0];
  if (t >= T.walk1[0]) y = lerp(ST[0], ST[1], walkF(t, ...T.walk1));
  if (t >= T.walk2[0]) y = lerp(ST[1], ST[2], walkF(t, ...T.walk2));
  let g = { walking: false, phase: 0, amp: 0 };
  if (t > T.walk1[0] && t < T.walk1[1] + .15) g = gait(t, ...T.walk1);
  if (t > T.walk2[0] && t < T.walk2[1] + .15) g = gait(t, ...T.walk2);
  // kneading dips land on the beat
  let dip = 0; for (const k of T.knead) { const u = t - k; if (u > -.22 && u < .3) dip = Math.max(dip, u < 0 ? ss(1 + u / .22) : 1 - ss(u / .3)); }
  // tray: on the table until lifted, then carried; dough → bread at the ding; empty after the shelf
  const lift = ss(seg(t, T.walk1[0] - .12, T.walk1[0] + .1));
  const inOven = t >= T.ovenOpen + .08 && t < T.ovenDing;
  const load = t < T.ovenDing ? 'dough' : (t < T.shelf - .05 ? 'bread' : null);
  return { x: BX, y, ...g, dip, lift, inOven, load };
}
function guestAt(t) {
  const f = walkF(t, ...T.walk3);
  const x = lerp(GUEST0[0], SPOT[0], f);
  let g = { walking: false, phase: 0, amp: 0 }; if (t > T.walk3[0] && t < T.walk3[1] + .15) g = gait(t, ...T.walk3);
  const sway = t < T.walk3[0] ? Math.sin(t * 1.3) * .004 : 0;
  return { x, y: SPOT[1], ...g, sway };
}
// lid: unstick, flip on the far hinge (y = -0.3, z = 3.2) to paper side up, then glide away (-y, up)
function lidState(t) {
  const pre = .04 * Math.sin(Math.PI * seg(t, T.lid0 - .25, T.lid0));
  const f = seg(t, T.lid0, T.lidFlat);
  let rot = pre + Math.PI * eio(f);
  if (t > T.lidFlat) rot = Math.PI - .05 * Math.sin(Math.PI * seg(t, T.lidFlat, T.lidFlat + .22));   // paper flap settles
  const gl = ei2(seg(t, T.lidFlat + .12, T.lidGone - .1));
  return { rot, dy: -20 * gl, dz: 7 * gl, on: t < T.lidGone };
}
const wallH = t => lerp(WH, PARA, eio(seg(t, T.wall0, T.wall1)));
// chair angle (rad): lying on its back (pi/2) → upright (0) at its hit, rising like a domino played backwards
export function chairPhi(t, i) {
  const hit = T.chairs[i], D = i < 2 ? .42 : i < 4 ? .34 : .28;
  if (t >= hit) { const u = t - hit; return u < .2 ? .06 * Math.sin(Math.PI * u / .2) * (1 - u / .2) : 0; }   // a small rattle back
  let sh = .025 * Math.sin(Math.PI * seg(t, hit - D - .14, hit - D));    // anticipation shiver
  if (i === 0) { const u = seg(t, ...T.twitch); sh = -.2 * 4 * u * (1 - u); }   // the first chair hops once in the silence and drops back on the triplet
  return Math.PI / 2 - (Math.PI / 2) * ei(seg(t, hit - D, hit)) + sh;
}
const signTheta = t => {
  const a = T.flip - .3; if (t < a) return -.08 * Math.sin(Math.PI * seg(t, a - .18, a));
  const f = seg(t, a, T.flip); let th = Math.PI * eio(f);
  if (t > T.flip) { const u = t - T.flip; th = Math.PI + .22 * Math.sin(u * 14) * Math.exp(-u * 6); }
  return th;
};

// ---------- floor type ----------
let PH = null;
function buildType() {
  const title = { x: 14.15, y: 8.4, z: 0, t0: T.title[0], t1: T.lidGone - .3, step: .2, scale: .78, lines: [[['清晨', 'B'], ['6:00', 'n']]] };
  const mk = (i, word) => {
    const N = { x: 3.45, y: ST[i] + .2, z: 0, t0: 0, t1: 1e9, step: .2, scale: .42, lines: [[[String(i + 1), 'n']]] };   // ink: the word's accent character carries the rule
    const Wd = { x: 4.55, y: ST[i] + .7, z: 0, t0: 0, t1: 1e9, step: .2, scale: .58, lines: [word] };
    const NL = phraseLayout(N), WL = phraseLayout(Wd);
    NL[0].tc = T.lights[i] - F1;                                     // the number lands with its light
    const w = [T.w1, T.w2, T.w3][i]; WL[0].tc = w[0] - F1; WL[1].tc = w[1] - F1;   // the word lands when the baker arrives
    return { N: { P: N, L: NL }, W: { P: Wd, L: WL } };
  };
  const TL = phraseLayout(title); TL.forEach((c, i) => c.tc = T.title[i] - F1);
  PH = { title: { P: title, L: TL }, s: [mk(0, [['和', 'B'], ['面', 'A']]), mk(1, [['烘', 'B'], ['烤', 'A']]), mk(2, [['上', 'B'], ['架', 'A']])] };
}
function glyphBox(Pp, list) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const c of list) for (const [du, dv] of [[0, 0], [c.cw, 0], [0, -c.size], [c.cw, -c.size]]) {
    const [sx, sy] = P(Pp.x + c.v + dv, Pp.y - c.u - du, 0); x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
  }
  return { x0, y0, x1, y1 };
}

// ---------- drawing helpers ----------
const T3 = c => tri(c);
function boxNow(x, y, z, w, d, h, c, o) { iso.boxNow(x, y, z, w, d, h, T3(c), o); }
function q(depth, fn) { iso.add(depth, fn); }
function vcyl(x, y, z, r, h, c, n = 12) { const pts = []; for (let i = 0; i < n; i++) { const a = i / n * TAU; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); } iso.prismNow(pts, z, h, T3(c)); }
function floorPoly(g, pts, col, a = 1, z = 0) { fillPoly(g, pts.map(p => P(p[0], p[1], z)), col, a); }
function strokePoly(g, pts, col, lw, a = 1, z = .01, close = true) {
  g.save(); g.globalAlpha *= a; g.beginPath(); pts.forEach((p, i) => { const s = P(p[0], p[1], z); i ? g.lineTo(s[0], s[1]) : g.moveTo(s[0], s[1]); });
  if (close) g.closePath(); g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); g.restore();
}
// rotated box (local corners mapped by M) drawn as facets
function rbox(g, M, R, x0, x1, y0, y1, z0, z1, c) {
  const v = (x, y, z) => M(x, y, z), t3 = T3(c);
  const F = [
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    [[[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1]],
    [[[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]],
    [[[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]], [0, -1, 0]],
    [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]],
    [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]],
  ];
  for (const [pts, n] of F) facet(g, pts.map(p => v(...p)), t3, { out: R(n) });
}

// ---------- the place ----------
function ground(g) {
  g.fillStyle = K.yard; g.fillRect(0, 0, W, H);
  const BIG = 80;
  floorPoly(g, rect(12, 14.6, -BIG, BIG), K.walk);
  floorPoly(g, rect(-BIG, 14.6, 9, 11.6), K.walk);
  floorPoly(g, rect(14.6, BIG, -BIG, BIG), K.road);
  floorPoly(g, rect(-BIG, BIG, 11.6, BIG), K.road);
  // kerbs
  strokePoly(g, [[14.6, -BIG], [14.6, 11.6], [-BIG, 11.6]], K.curb, Math.max(1, .1 * iso.cam.k), 1, .005, false);
  // sidewalk slabs
  g.save(); g.globalAlpha = .55; g.strokeStyle = '#DCD2BF'; g.lineWidth = Math.max(.6, .018 * iso.cam.k);
  for (let y = -30; y <= 30; y += 1.3) { const a = P(12, y), b = P(14.6, y); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  for (let x = -30; x <= 14.6; x += 1.3) { const a = P(x, 9), b = P(x, 11.6); if (x > 12) continue; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  g.restore();
  // lane lines (marking ginger, dashed) and a zebra crossing at the corner
  for (let y = -40; y < 40; y += 3) floorPoly(g, rect(17.45, 17.6, y, y + 1.6), C.ginger, .9, .005);
  for (let x = -40; x < 40; x += 3) floorPoly(g, rect(x, x + 1.6, 14.45, 14.6), C.ginger, .9, .005);
  for (let i = 0; i < 6; i++) { const x = 12.3 + i * .42; floorPoly(g, rect(x, x + .24, 11.9, 14.2), '#F7F0E2', .95, .005); }
  for (let i = 0; i < 6; i++) { const y = 9.3 + i * .42; floorPoly(g, rect(14.9, 17.2, y, y + .24), '#F7F0E2', .95, .005); }
  // back yard slabs behind the shop
  g.save(); g.globalAlpha = .35; g.strokeStyle = '#DED4C2'; g.lineWidth = Math.max(.6, .016 * iso.cam.k);
  for (let v = -30; v <= 0; v += 2) { let a = P(-30, v), b = P(12, v); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); a = P(v, -30); b = P(v, 9); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  g.restore();
  // shop floor + tile grid
  floorPoly(g, rect(0, 12, 0, 9), K.floor);
  g.save(); g.globalAlpha = .5; g.strokeStyle = K.grid; g.lineWidth = Math.max(.5, .014 * iso.cam.k);
  for (let x = .6; x < 12; x += .6) { const a = P(x, 0, .002), b = P(x, 9, .002); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  for (let y = .6; y < 9; y += .6) { const a = P(0, y, .002), b = P(12, y, .002); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  g.restore();
}
function farWalls(g) {
  boxNow(0, 0, 0, .2, 9, WH, K.wall, { faceColor: { 0: K.wallTop } });
  boxNow(.2, 0, 0, 11.8, .2, WH, K.wall, { faceColor: { 0: K.wallTop } });
  // windows on the inner faces (the far walls keep them)
  const win = (pl, x, y, z, w, h) => onPlane(g, x, y, z, pl, g2 => {
    g2.fillStyle = K.glass; g2.fillRect(0, 0, w, h);
    g2.fillStyle = hex(mix(K.wall, '#5B4434', .18)); g2.fillRect(w / 2 - .03, 0, .06, h); g2.fillRect(0, h / 2 - .03, w, .06);
  });
  win('yz', .2, 8.1, 2.6, 1.3, 1.2);       // u = -y: starts at y and runs toward -y
  win('yz', .2, 4.0, 2.6, 1.0, 1.0);
  for (const x of [2.6, 6.2, 9.6]) win('xz', x, .2, 2.6, 1.4, 1.2);
}
// station 1: kneading table with dough and a tray
function table(g, t, B) {
  const top = .9;
  for (const [x, y] of [[.65, 6.55], [1.8, 6.55], [.65, 7.8], [1.8, 7.8]]) boxNow(x, y, 0, .07, .07, top - .07, K.woodDk);
  boxNow(.6, 6.5, top - .07, 1.3, 1.4, .07, K.wood);
  // dough mound, squashed on every knead
  const sq = 1 + .25 * B.dip;
  vcyl(1.2, 7.3, top, .26 * Math.sqrt(sq), .1 / sq, K.dough, 14);
  // tray resting on the table until it is lifted
  if (B.lift < 1) { const a = 1 - B.lift; g.save(); g.globalAlpha *= a; trayOnTable(g, 1.55, 6.85, top); g.restore(); }
}
function trayOnTable(g, x, y, z) {
  boxNow(x - .22, y - .32, z, .44, .64, .03, K.woodDk);
  for (let i = 0; i < 5; i++) vcyl(x, y - .24 + i * .12, z + .03, .05, .05, K.dough, 10);
}
// station 2: deck oven with a door that opens to an accent glow, flue pipe up through the (absent) roof
function oven(g, t, B) {
  const lit = t >= T.lights[1], open = ss(seg(t, T.ovenOpen - .1, T.ovenOpen)) * (1 - ss(seg(t, T.ovenDing + .25, T.ovenDing + .4)));
  vcyl(.85, 4.8, 1.4, .13, 1.7, '#6D6760');
  boxNow(.4, 4.35, 0, 1.5, .9, 1.4, K.oven);
  // door on the +x face: glass that glows when it bakes
  const glow = clamp((lit ? .25 : 0) + open * .75 + (t > T.ovenOpen && t < T.ovenDing + .4 ? .2 : 0));
  onPlane(g, 1.905, 5.15, 1.15, 'yz', g2 => {
    g2.fillStyle = '#3B3734'; g2.fillRect(0, 0, .7, .65);
    g2.fillStyle = css(mix('#4A4440', C.accent, glow)); g2.fillRect(.08, .08, .54, .4);
    g2.fillStyle = '#C9B89C'; g2.fillRect(.08, .53, .54, .05);
  });
  // knob row
  onPlane(g, 1.905, 5.15, .3, 'yz', g2 => { g2.fillStyle = '#7C756C'; for (let i = 0; i < 3; i++) g2.fillRect(.12 + i * .2, 0, .09, .09); });
}
// station 3: open shelf, bread slides onto the middle tier
function shelf(g, t) {
  const x0 = .3, x1 = .9, y0 = 1.3, y1 = 3.0;
  boxNow(x0, y0, 0, .06, y1 - y0, 1.5, K.woodDk);                      // back panel
  boxNow(x0, y0, 0, x1 - x0, .06, 1.5, K.woodDk); boxNow(x0, y1 - .06, 0, x1 - x0, .06, 1.5, K.woodDk);
  for (const z of [.12, .7, 1.45]) {
    boxNow(x0 + .06, y0 + .06, z, x1 - x0 - .06, y1 - y0 - .12, .05, K.wood);
    if (z === .7) {
      const n = 6;
      for (let i = 0; i < n; i++) {
        const f = eo(seg(t, T.shelf - .18 + i * .025, T.shelf + i * .025));
        if (f <= 0) continue;
        const yy = y1 - .3 - i * .24, xx = lerp(BX - .2, .62, f), zz = lerp(1.35, z + .05, f);
        iso.cylNow(xx - .17, yy, zz + .07, .07, .34, T3(K.bread), { axis: 'x', n: 10 });
      }
    }
  }
}
// the long café table (drawn before the chairs, which all sit on its camera side)
function longTable(g) {
  const top = .74;
  for (const [x, y] of [[7.35, 3.45], [8.0, 3.45], [7.35, 7.8], [8.0, 7.8], [7.35, 5.6], [8.0, 5.6]]) boxNow(x, y, 0, .06, .06, top - .05, K.woodDk);
  boxNow(7.3, 3.4, top - .05, .8, 4.5, .05, K.wood);
}
// a chair, rotated about its rear-feet line (x = .21, z = 0) by phi
function chair(g, cx, cy, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const M = (x, y, z) => { const dx = x - .21; return [cx + .21 + dx * c + z * s, cy + y, -dx * s + z * c]; };
  const R = n => [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c];
  const col = C.green, dk = hex(mix(C.green, '#1E2A22', .35));
  const parts = [];
  for (const [lx, ly] of [[-.19, -.19], [.15, -.19], [-.19, .15], [.15, .15]]) parts.push([lx, lx + .04, ly, ly + .04, 0, .44, dk]);
  parts.push([-.21, .21, -.21, .21, .44, .48, col]);
  parts.push([.17, .21, -.21, -.17, .48, .9, dk]); parts.push([.17, .21, .17, .21, .48, .9, dk]);
  parts.push([.175, .205, -.21, .21, .64, .88, col]);
  const dep = p => { const m = M((p[0] + p[1]) / 2, (p[2] + p[3]) / 2, (p[4] + p[5]) / 2); return m[0] + m[1] + m[2]; };
  parts.sort((a, b) => dep(a) - dep(b));
  for (const p of parts) rbox(g, M, R, p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
}
// near walls (facade x = 12 with the door, side y = 9), cut to a parapet after the lid lifts
function nearWalls(g, t) {
  const h = wallH(t), dh = lerp(2.4, 0, eio(seg(t, T.wall0, T.wall1)));
  const wc = { 0: K.wallTop };
  boxNow(0, 8.8, 0, 12, .2, h, K.wall, { faceColor: wc });
  boxNow(11.8, 0, 0, .2, DOOR[0], h, K.wall, { faceColor: wc });
  boxNow(11.8, DOOR[1], 0, .2, 8.8 - DOOR[1], h, K.wall, { faceColor: wc });
  if (h > DOORH + .12) boxNow(11.8, DOOR[0], DOORH + .12, .2, DOOR[1] - DOOR[0], h - DOORH - .12, K.wall, { faceColor: wc });
  // dark windows and the green band while the walls stand
  const clipH = (z0, z1) => [Math.min(z0, h), Math.min(z1, h)];
  const winX = (y, w, z0, z1) => { const [a, b] = clipH(z0, z1); if (b - a < .02) return; onPlane(g, 12.001, y, b, 'yz', g2 => { g2.fillStyle = K.glassDark; g2.fillRect(0, 0, w, b - a); g2.fillStyle = K.wall; for (let u = w / 3; u < w - .01; u += w / 3) g2.fillRect(u - .03, 0, .06, b - a); }); };
  const winY = (x, w, z0, z1) => { const [a, b] = clipH(z0, z1); if (b - a < .02) return; onPlane(g, x, 9.001, b, 'xz', g2 => { g2.fillStyle = K.glassDark; g2.fillRect(0, 0, w, b - a); g2.fillStyle = K.wall; g2.fillRect(w / 2 - .03, 0, .06, b - a); }); };
  winX(7.8, 3.8, 1.0, 2.4); winX(1.4, 1.0, 1.0, 2.4);
  winY(2.0, 3.0, 1.1, 2.4); winY(6.6, 3.0, 1.1, 2.4);
  const band = (z0, z1) => { const [a, b] = clipH(z0, z1); if (b - a < .02) return;
    onPlane(g, 12.002, 8.8, b, 'yz', g2 => { g2.fillStyle = C.green; g2.fillRect(0, 0, 8.8, b - a); });
    onPlane(g, 0, 9.002, b, 'xz', g2 => { g2.fillStyle = C.green; g2.fillRect(0, 0, 12, b - a); }); };
  band(2.7, 2.9);
  // the closed door sinks with the walls
  if (dh > .02) boxNow(11.82, DOOR[0] + .06, 0, .1, DOOR[1] - DOOR[0] - .12, dh, C.green, { faceColor: { 0: C.greenLt } });
  if (dh > .9) onPlane(g, 11.925, 2.95, dh - .25, 'yz', g2 => { g2.fillStyle = K.glassDark; g2.fillRect(0, 0, 1.1, Math.min(1.1, dh - .9)); });
}
function doorFrame(g) {
  boxNow(11.86, DOOR[0] - .1, 0, .14, .12, DOORH, C.green);
  boxNow(11.86, DOOR[1] - .02, 0, .14, .12, DOORH, C.green);
  boxNow(11.86, DOOR[0] - .1, DOORH, .14, DOOR[1] - DOOR[0] + .2, .12, C.green);
}
// the hanging sign: dark night side (a crescent), accent day side 营业中; spins about its vertical axis
let FONT_OK = false;
function signGeom(t) {
  const th = signTheta(t), c = [12.2, 2.4, 2.12], hw = .62, hh = .27;
  const cs = Math.cos(th), sn = Math.sin(th);
  const wv = [-sn, cs, 0];                 // width direction (local +u of the night face is -wv)
  const corner = (u, v) => [c[0] + wv[0] * u, c[1] + wv[1] * u, c[2] + v];
  const n = [cs, sn, 0];
  return { th, c, hw, hh, wv, corner, n };
}
function sign(g, t) {
  const S = signGeom(t), { hw, hh, corner, n, wv } = S;
  // strings
  g.save(); g.strokeStyle = '#4A4E4B'; g.lineWidth = Math.max(1, .02 * iso.cam.k);
  for (const u of [-.42, .42]) { const a = P(...corner(u, hh)), b = P(12.0, 2.4 + u, DOORH); g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); }
  g.restore();
  const pts = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
  const front = n[0] + n[1] > 0;          // which side faces the camera
  const T3s = front ? tri(C.ink) : tri(C.accent);
  facet(g, pts, T3s, { out: front ? n : n.map(v => -v), both: true, color: front ? C.ink : C.accent });
  // thickness edge
  const e = .03, off = n.map(v => v * e);
  const pts2 = pts.map(p => [p[0] - off[0], p[1] - off[1], p[2]]);
  facet(g, [pts[3], pts[2], pts2[2], pts2[3]], tri(C.ink), { out: [0, 0, 1] });
  // face content via an affine map: local (u, v) metres → screen; u along reading direction, v down
  const ud = front ? wv.map(v => -v) : wv;   // night face reads along -wv, day face along +wv (both up-right when square on)
  const o = corner(front ? hw : -hw, hh);
  const O = P(...o), U = P(o[0] + ud[0], o[1] + ud[1], o[2]), V = P(o[0], o[1], o[2] - 1);
  g.save(); g.setTransform(U[0] - O[0], U[1] - O[1], V[0] - O[0], V[1] - O[1], O[0], O[1]);
  if (front) {
    g.strokeStyle = '#8E8676'; g.lineWidth = .025; g.strokeRect(.05, .05, 2 * hw - .1, 2 * hh - .1);
    g.fillStyle = '#E9DDBF'; g.beginPath(); g.arc(hw, hh, .14, 0, TAU); g.fill();
    g.fillStyle = C.ink; g.beginPath(); g.arc(hw + .07, hh - .05, .13, 0, TAU); g.fill();
  } else {
    g.strokeStyle = '#F6D7C7'; g.lineWidth = .02; g.strokeRect(.05, .05, 2 * hw - .1, 2 * hh - .1);
    g.fillStyle = '#FFF7EA'; g.font = '700 0.36px NotoSerifSC'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('营业中', hw, hh + .02);
  }
  g.restore();
}
function signBox(t) {
  const S = signGeom(t); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [u, v] of [[-S.hw, -S.hh], [S.hw, -S.hh], [S.hw, S.hh], [-S.hw, S.hh]]) { const [sx, sy] = P(...S.corner(u, v)); x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy); }
  return { x0, y0, x1, y1 };
}
function lamp(g, t) {
  const on = t < T.lampOff, x = 14.25, y = -4.0;
  vcyl(x, y, 0, .07, 3.9, K.post, 10);
  boxNow(x - .9, y - .05, 3.82, .95, .1, .08, K.post);
  boxNow(x - 1.15, y - .22, 3.7, .5, .44, .14, K.post, { faceColor: { 0: tri(K.post)[0] } });
  // the lamp's glass (a box below the cap): warm while it is on, grey once it is off
  const lc = on ? '#FFE08A' : K.lampOff;
  boxNow(x - 1.08, y - .16, 3.42, .36, .32, .28, lc, { faceColor: on ? { 0: '#FFF0B8', 1: '#FFE08A', 2: '#F2CB6A' } : undefined });
}
function tree(g, x, y) {
  vcyl(x, y, 0, .09, 1.6, '#7B6048', 8);
  iso.sphereNow(x, y, 2.3, .95, T3('#6E8F63'), { hi: false });
}
// roof lid: a gable with its ridge along x; paper underside; hinge on the far eave (y = -0.3, z = 3.2)
function lid(g, t) {
  const L = lidState(t); if (!L.on) return;
  const hy = -.3, hz = WH, c = Math.cos(L.rot), s = Math.sin(L.rot);
  const M = (x, y, z) => [x, hy + (y - hy) * c - (z - hz) * s + L.dy, hz + (y - hy) * s + (z - hz) * c + L.dz];
  const R = n => [n[0], n[1] * c - n[2] * s, n[1] * s + n[2] * c];
  const x0 = -.3, x1 = 12.3, ya = -.3, yb = 9.3, ym = 4.5, zr = 5.4;
  const zAt = y => WH + (zr - WH) * (1 - Math.abs(y - ym) / (ym - ya));
  const G = tri(C.green);
  const F = [
    { p: [[x0, ya, WH], [x1, ya, WH], [x1, ym, zr], [x0, ym, zr]], n: [0, -1, 1.6], col: hex(mix(G[0], G[1], .2)) },
    { p: [[x0, ym, zr], [x1, ym, zr], [x1, yb, WH], [x0, yb, WH]], n: [0, 1, 1.6], col: G[1] },
    { p: [[12, 0, WH], [12, 9, WH], [12, ym, zAt(ym) - .12]], n: [1, 0, 0], col: tri(K.wall)[2] },
    { p: [[0, 0, WH], [0, ym, zAt(ym) - .12], [0, 9, WH]], n: [-1, 0, 0], col: tri(K.wall)[2] },
    { p: [[x0, ya, WH], [x0, yb, WH], [x1, yb, WH], [x1, ya, WH]], n: [0, 0, -1], col: '#F6EEDD' },   // paper side
  ];
  const parts = F.map(f => ({ ...f, w: f.p.map(p => M(...p)) }));
  const dep = f => f.w.reduce((a, p) => a + p[0] + p[1] + p[2], 0) / f.w.length;
  parts.sort((a, b) => dep(a) - dep(b));
  for (const f of parts) facet(g, f.w, null, { out: R(f.n), color: f.col });
  // chimney on the near slope (flips with the lid)
  const ch = [1.2, 1.8, 6.0, 6.6, zAt(6.6) - .05, zAt(6.6) + 1.1];
  if (Math.cos(L.rot) > -.1) rbox(g, M, R, ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], K.chimney);
  // gable decoration while it faces the camera: a round dark window
  if (Math.cos(L.rot) > .2) {
    const o = M(12.005, ym, WH + 1.0), U = M(12.005, ym - 1, WH + 1.0), V = M(12.005, ym, WH);
    const Os = P(...o), Us = P(...U), Vs = P(...V);
    g.save(); g.setTransform(Us[0] - Os[0], Us[1] - Os[1], Vs[0] - Os[0], Vs[1] - Os[1], Os[0], Os[1]);
    g.fillStyle = K.glassDark; g.beginPath(); g.arc(0, 0, .42, 0, TAU); g.fill(); g.fillStyle = K.wall; g.fillRect(-.42, -.03, .84, .06); g.fillRect(-.03, -.42, .06, .84);
    g.restore();
  }
}
// ---------- people ----------
const BAKER = { h: 1.74, top: TOPS[3], legs: LEGS[1] }, GUEST = { h: 1.7, top: TOPS[1], legs: LEGS[0], hairLong: true };
function drawBaker(gg, B) {
  const h = BAKER.h, sw = B.walking ? Math.sin(B.phase) * B.amp : 0;
  const Bt = tri(BAKER.top, .18, .26), Lg = BAKER.legs, Ld = hex(mix(Lg, '#15171A', .25));
  const leg = (hx, fx, col) => { gg.beginPath(); gg.moveTo(hx - .034 * h, -.49 * h); gg.lineTo(hx + .034 * h, -.49 * h); gg.lineTo(fx + .028 * h, -.02 * h); gg.lineTo(fx - .028 * h, -.02 * h); gg.closePath(); gg.fillStyle = col; gg.fill(); gg.beginPath(); gg.ellipse(fx - .008 * h, -.012 * h, .04 * h, .016 * h, 0, 0, TAU); gg.fillStyle = '#232524'; gg.fill(); };
  const bob = B.walking ? Math.abs(Math.cos(B.phase)) * .012 * h * B.amp : 0;
  gg.save(); gg.translate(0, -bob);
  leg(.04 * h, .045 * h - sw * .1 * h, Ld); leg(-.04 * h, -.045 * h + sw * .1 * h, Lg);
  gg.translate(0, B.dip * .045 * h);
  // tray carried high in front (drawn first: it is farther from the camera than the back)
  if (B.lift > 0 && !B.inOven && B.load !== undefined) {
    gg.save(); gg.globalAlpha *= B.lift;
    const ty = -.79 * h;
    gg.fillStyle = K.woodDk; gg.fillRect(-.33, ty, .66, .035);
    if (B.load) for (let i = 0; i < 5; i++) {
      const x = -.27 + i * .135; gg.fillStyle = B.load === 'bread' ? K.bread : K.dough;
      gg.beginPath(); gg.ellipse(x, ty - .025, .055, .035, 0, 0, TAU); gg.fill();
      if (B.load === 'bread') { gg.fillStyle = hex(mix(K.bread, '#5B4434', .25)); gg.fillRect(x - .02, ty - .035, .04, .008); }
    }
    gg.restore();
  }
  // apron strings + back
  gg.beginPath(); gg.moveTo(-.105 * h, -.5 * h); gg.lineTo(-.12 * h, -.78 * h); gg.quadraticCurveTo(-.12 * h, -.81 * h, -.09 * h, -.815 * h); gg.lineTo(.09 * h, -.815 * h); gg.quadraticCurveTo(.12 * h, -.81 * h, .12 * h, -.78 * h); gg.lineTo(.105 * h, -.5 * h); gg.closePath(); gg.fillStyle = Bt[1]; gg.fill();
  gg.beginPath(); gg.moveTo(.03 * h, -.5 * h); gg.lineTo(.03 * h, -.815 * h); gg.lineTo(.09 * h, -.815 * h); gg.quadraticCurveTo(.12 * h, -.81 * h, .12 * h, -.78 * h); gg.lineTo(.105 * h, -.5 * h); gg.closePath(); gg.fillStyle = Bt[2]; gg.fill();
  gg.fillStyle = '#F7F1E4'; gg.fillRect(-.1 * h, -.6 * h, .2 * h, .025 * h);       // apron tie across the back
  // arms forward (only the shoulder caps show from behind)
  gg.fillStyle = Bt[2]; gg.beginPath(); gg.roundRect(.1 * h, -.8 * h, .05 * h, .12 * h, .02 * h); gg.fill();
  gg.fillStyle = Bt[1]; gg.beginPath(); gg.roundRect(-.15 * h, -.8 * h, .05 * h, .12 * h, .02 * h); gg.fill();
  // head + toque
  gg.fillStyle = hex(mix(C.skin, '#5A3A2A', .15)); gg.fillRect(-.022 * h, -.85 * h, .044 * h, .05 * h);
  gg.beginPath(); gg.arc(0, -.885 * h, .066 * h, 0, TAU); gg.fillStyle = C.hair; gg.fill();
  gg.beginPath(); gg.ellipse(-.058 * h, -.872 * h, .012 * h, .02 * h, 0, 0, TAU); gg.fillStyle = C.skin; gg.fill();
  const P1 = '#FBF6EC', P2 = '#E6DCCB';
  gg.fillStyle = P1; gg.fillRect(-.062 * h, -1.0 * h, .124 * h, .09 * h);
  gg.fillStyle = P2; gg.fillRect(.025 * h, -1.0 * h, .037 * h, .09 * h);
  gg.fillStyle = P1; gg.beginPath(); gg.ellipse(0, -1.03 * h, .085 * h, .055 * h, 0, 0, TAU); gg.fill();
  gg.fillStyle = P2; gg.beginPath(); gg.ellipse(.045 * h, -1.025 * h, .04 * h, .045 * h, 0, 0, TAU); gg.fill();
  gg.restore();
}

// ---------- marks on the floor: lit squares, arrows, the spot ----------
function square(g, x, y, s, a, fillA, lw) {
  const pts = rect(x - s / 2, x + s / 2, y - s / 2, y + s / 2);
  floorPoly(g, pts, C.accentLt, a * fillA, .004);
  strokePoly(g, pts, C.accent, lw, a, .006);
}
function marks(g, t, B) {
  const k = iso.cam.k;
  ST.forEach((y, i) => {
    const t0 = T.lights[i], a = eo(seg(t, t0 - F1, t0 + .2)); if (a <= 0) return;
    const sz = lerp(.45, .82, eo(seg(t, t0 - F1, t0 + .22)));
    const here = Math.abs(B.y - y) < .25 ? 1 : 0;
    const pulse = 1 - ss(seg(t, t0, t0 + .9));
    const fillA = .25 + .45 * pulse + .35 * here;
    square(g, BX, y, sz, a * typeAlpha(t), fillA, Math.max(1.5, .05 * k));
  });
  // order arrows: grow ahead of the walker, fade behind
  const arrow = (t0, t1, yA, yB, walk) => {
    const grow = eo(seg(t, t0, t1)); if (grow <= 0) return;
    const out = 1 - ss(seg(t, walk[1] - .05, walk[1] + .45)); if (out <= 0) return;
    const head = lerp(yA, yB, grow), x = BX, w = .09, hw = .26, hl = .42;
    const tailY = Math.min(yA, B.y + .1);
    if (tailY - head < hl + .05) { if (grow < 1) return; }
    g.save(); g.globalAlpha *= out;
    const Ps = P(x, tailY, .006), Pe = P(x, tailY - .9, .006);
    const gr = g.createLinearGradient(Ps[0], Ps[1], Pe[0], Pe[1]); gr.addColorStop(0, 'rgba(208,87,58,0)'); gr.addColorStop(1, C.accent);
    const body = [[x - w, tailY], [x + w, tailY], [x + w, head + hl], [x - w, head + hl]];
    if (tailY > head + hl) { g.beginPath(); body.map(p => P(p[0], p[1], .006)).forEach((q2, j) => j ? g.lineTo(...q2) : g.moveTo(...q2)); g.closePath(); g.fillStyle = gr; g.fill(); }
    fillPoly(g, [[x - hw, head + hl], [x + hw, head + hl], [x, head]].map(p => P(p[0], p[1], .006)), C.accent);
    g.restore();
  };
  arrow(T.arrow1[0], T.arrow1[1], ST[0] - .45, ST[1] + .42, T.walk1);
  arrow(T.arrow2[0], T.arrow2[1], ST[1] - .45, ST[2] + .42, T.walk2);
  // the guest's spot: traced in the accent, then lit when they step on it
  const sp = seg(t, T.spot - F1, T.spot + .4);
  if (sp > 0) {
    const s = .8, [x, y] = SPOT, pts = [[x - s / 2, y - s / 2], [x + s / 2, y - s / 2], [x + s / 2, y + s / 2], [x - s / 2, y + s / 2], [x - s / 2, y - s / 2]];
    const lit = ss(seg(t, T.arrive - .1, T.arrive + .15)), pulse = 1 - ss(seg(t, T.arrive + .1, T.arrive + .6));
    floorPoly(g, pts.slice(0, 4), C.accentLt, .2 + .5 * lit * (.6 + .4 * pulse), .004);
    g.save(); g.strokeStyle = C.accent; g.lineWidth = Math.max(1.5, .06 * k); g.lineCap = 'round'; g.lineJoin = 'round';
    const sc = pts.map(p => P(p[0], p[1], .006));
    let L = 0; const d = []; for (let i = 1; i < sc.length; i++) { d.push(Math.hypot(sc[i][0] - sc[i - 1][0], sc[i][1] - sc[i - 1][1])); L += d[i - 1]; }
    let rem = L * eo(sp); g.beginPath(); g.moveTo(...sc[0]);
    for (let i = 1; i < sc.length && rem > 0; i++) { const f = Math.min(1, rem / d[i - 1]); g.lineTo(lerp(sc[i - 1][0], sc[i][0], f), lerp(sc[i - 1][1], sc[i][1], f)); rem -= d[i - 1]; }
    g.stroke(); g.restore();
  }
}

// the painted lane in front of the chairs: each stretch lights as its chair lands; at the last one the whole lane flares, holds, and goes
const LANE = [9.12, 9.44];
export const laneState = t => {
  const flare = ss(seg(t, T.climax - 2 / 30, T.climax + .02)), out = 1 - ss(seg(t, T.climax + .6, T.climax + 1.0));
  return { seg: T.chairs.map(h => eo(seg(t, h - F1, h + .12))), flare, out };
};
function lane(g, t) {
  const L = laneState(t); if (L.out <= 0 || L.seg[0] <= 0) return;
  const k = iso.cam.k, w = .1 * L.flare;
  CHAIR_Y.forEach((y, i) => {
    const a = L.seg[i]; if (a <= 0) return;
    const x0 = LANE[0] - w, x1 = LANE[1] + w, y0 = y - .275, y1 = y + .275;
    const land = 1 - ss(seg(t, T.chairs[i], T.chairs[i] + .35));        // each stretch lands bright, then settles
    floorPoly(g, rect(x0, x1, y0 + .02, y1 - .02), C.accent, L.out * a * (.42 + .3 * land + .58 * L.flare), .004);
  });
  if (L.flare > 0) strokePoly(g, rect(LANE[0] - .1, LANE[1] + .1, CHAIR_Y[7] - .3, CHAIR_Y[0] + .3), C.accent, Math.max(1.5, .045 * k), L.out * L.flare, .006);
}
const typeAlpha = t => clamp(1 - ss(seg(t, 13.5, 13.9)) + ss(seg(t, T.arrive - .45, T.arrive)));
// ---------- the frame ----------
export function render(g, t) {
  if (!PH) buildType();
  iso.g = g; iso.cam = camAt(t);
  const B = bakerAt(t), Gs = guestAt(t);
  g.setTransform(1, 0, 0, 1, 0, 0);
  ground(g);
  // floor marks and type (all on clear ground)
  marks(g, t, B);
  lane(g, t);
  floorType(g, t, PH.title.P, PH.title.L);
  const wa = typeAlpha(t);   // the work words step aside for the domino and come back for the last wide frame
  for (const s of PH.s) { floorType(g, t, s.N.P, s.N.L, wa); floorType(g, t, s.W.P, s.W.L, wa); }
  // the shop: far walls, then the inside sorted by footprint, then the near walls
  farWalls(g);
  q(2.75, () => shelf(g, t));
  q(5.9, () => oven(g, t, B));
  q(8.4, () => table(g, t, B));
  q(10.7, () => longTable(g));
  CHAIR_Y.forEach((y, i) => q(CHAIR_X + y, () => chair(g, CHAIR_X, y, chairPhi(t, i))));
  q(B.x + B.y, () => { iso.bill(B.x, B.y, 0, gg => drawBaker(gg, B), { cull: false }); });
  const guestIn = Gs.x < 11.9;
  if (guestIn) q(Gs.x + Gs.y, () => iso.bill(Gs.x, Gs.y, 0, gg => drawPerson(gg, GUEST, Gs), { cull: false }));
  iso.flush(); iso.flush();
  nearWalls(g, t);
  // outside and on the threshold
  q(11.86 + DOOR[0] - .1 + .1, () => boxNow(11.86, DOOR[0] - .1, 0, .14, .12, DOORH, C.green));
  q(11.86 + DOOR[1] + .1, () => boxNow(11.86, DOOR[1] - .02, 0, .14, .12, DOORH, C.green));
  q(14.3, () => { boxNow(11.86, DOOR[0] - .1, DOORH, .14, DOOR[1] - DOOR[0] + .2, .12, C.green); sign(g, t); });
  if (!guestIn) q(Gs.x + Gs.y, () => iso.bill(Gs.x, Gs.y, 0, gg => { gg.translate(Gs.sway || 0, 0); drawPerson(gg, GUEST, Gs); }, { cull: false }));
  q(14.25 - 4.0, () => lamp(g, t));
  q(TREE1[0] + TREE1[1], () => tree(g, ...TREE1));
  q(13.6 - 6.8, () => tree(g, 13.6, -6.8));
  iso.flush(); iso.flush();
  lid(g, t);
  // motion check hook
  globalThis.__POS?.push({ i: 0, k: 'w', x: B.x, y: B.y, a: 1 }, { i: 1, k: 'w', x: Gs.x, y: Gs.y, a: 1 });
}

// ---------- texts (for readcheck) ----------
export function texts(t) {
  if (!PH) buildType();
  iso.cam = camAt(t); const out = [];
  if (t >= T.title[0] - F1 + .01 && t < T.lidGone) out.push({ id: 'title', text: '清晨6:00', ...glyphBox(PH.title.P, PH.title.L) });
  if (typeAlpha(t) > .5) PH.s.forEach((s, i) => {
    if (t >= T.lights[i] - F1 + .01) out.push({ id: 'n' + (i + 1), text: String(i + 1), ...glyphBox(s.N.P, s.N.L) });
    if (t >= [T.w1, T.w2, T.w3][i][0] - F1 + .01) out.push({ id: 'w' + (i + 1), text: ['和面', '烘烤', '上架'][i], ...glyphBox(s.W.P, s.W.L) });
  });
  const th = signTheta(t);
  if (Math.cos(th) + Math.sin(th) < 0 && t > T.flip - .3) out.push({ id: 'sign', text: '营业中', ...signBox(t) });
  return out;
}
// ---------- probe (for the cue check): the picture's own state at t ----------
export function probe(t) {
  if (!PH) buildType();
  const L = lidState(t), B = bakerAt(t);
  return {
    chairs: CHAIR_Y.map((_, i) => chairPhi(t, i)), lid: L.rot, lidOn: L.on, wall: wallH(t), lamp: t < T.lampOff ? 1 : 0,
    lights: T.lights.map(t0 => eo(seg(t, t0 - F1, t0 + .2))), dip: B.dip, bakerAmp: B.amp, guestAmp: guestAt(t).amp, guestPhase: guestAt(t).phase,
    oven: ss(seg(t, T.ovenOpen - .1, T.ovenOpen)), shelfF: eo(seg(t, T.shelf - .18, T.shelf)), spot: seg(t, T.spot - F1, T.spot + .4), lift: B.lift,
    sign: signTheta(t), bakerY: B.y, bakerLoad: B.load, bakerPhase: B.phase, bakerWalk: B.walking, guestX: guestAt(t).x,
    glyphs: [PH.title, ...PH.s.flatMap(s => [s.N, s.W])].flatMap((s, j) => s.L.map((c, i) => ({ w: j, i, a: clamp((t - c.tc) / .3) }))),
  };
}
export const events = EVENTS;
