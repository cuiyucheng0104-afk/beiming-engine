// 《那一脚》 the "match footage": one attack choreographed in pitch metres (x 0→105 toward the goal we attack, y 0 = near touchline), source time s in seconds.
// Players, ball and four broadcast cameras are pure functions of s, so every replay of the same moment is the same moment.
import { track, clamp, lerp } from '/core/lib.js';
import { SRC } from './timeline.js';

const eo = k => 1 - Math.pow(1 - clamp(k), 3);
const eio = k => { k = clamp(k); return k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const ss = k => { k = clamp(k); return k * k * (3 - 2 * k); };

export const KIT = {
  W: { shirt: '#F2F2EE', shirt2: '#C9CBC9', shorts: '#1B1E24', socks: '#F2F2EE', trim: '#1B1E24', num: '#1B1E24' },   // 城南 (we follow: yellow overlays)
  N: { shirt: '#22305E', shirt2: '#141D3E', shorts: '#22305E', socks: '#22305E', trim: '#E9E9E9', num: '#E9E9E9' },   // 港湾 (opponents: cyan overlays)
  G: { shirt: '#9BD13A', shirt2: '#6E9A22', shorts: '#1A1A1A', socks: '#9BD13A', trim: '#1A1A1A', num: '#1A1A1A' },   // 港湾 keeper
};
const SKIN = ['#C98E66', '#8D5A3B', '#E0B08C', '#B97A52', '#5E3A26', '#D9A27C'];

// —— players: [s, [x, y]] keyframes ——
export const PLAYERS = [
  { id: 'w8', team: 'W', num: 8, skin: 0, hair: '#2A1C14', keys: [[-1, [64.0, 38.4]], [0, [65.6, 37.6]], [.467, [67.4, 36.5]], [1.2, [69.2, 36.0]], [2.4, [72.4, 36.4]], [4, [76.2, 37.2]], [6, [80.0, 36.0]], [8, [82.0, 35.0]]],
    kicks: [{ s: SRC.pass1, pow: .7 }] },
  { id: 'w10', team: 'W', num: 10, skin: 1, hair: '#120C08', keys: [[-1, [71.6, 24.6]], [0, [72.6, 25.4]], [1.0, [73.9, 27.0]], [1.4, [74.5, 27.4]], [2.2, [76.6, 27.0]], [3.4, [80.6, 26.2]], [4.4, [84.0, 25.4]], [5.6, [88.6, 23.2]], [7, [92.0, 21.0]], [8, [93.5, 20.0]]],
    kicks: [{ s: SRC.thru, pow: .8 }], celebrate: 4.9 },
  { id: 'w9', team: 'W', num: 9, skin: 2, hair: '#3B2416', keys: [[-1, [79.6, 42.4]], [0, [80.0, 41.6]], [.9, [81.2, 40.6]], [1.6, [83.6, 38.1]], [2.4, [86.6, 34.6]], [3.1, [89.5, 31.6]], [3.55, [91.3, 30.9]], [3.78, [91.95, 30.65]], [4.05, [92.5, 30.5]], [4.4, [93.2, 30.1]], [5.0, [95.0, 26.6]], [5.8, [97.3, 21.0]], [6.6, [99.2, 15.6]], [7.4, [100.6, 11.4]], [8.4, [101.8, 8.0]]],
    kicks: [{ s: SRC.strike, pow: 1.0, shot: true }, { s: SRC.recv9, pow: .25 }], celebrate: 4.55, hero: true },
  { id: 'w11', team: 'W', num: 11, skin: 3, hair: '#1B120C', keys: [[-1, [76.6, 58.6]], [0, [78.0, 58.0]], [2, [83.0, 55.6]], [4, [89.4, 51.6]], [6, [93.0, 47.0]], [8, [95.0, 44.0]]] },
  { id: 'w7', team: 'W', num: 7, skin: 4, hair: '#0E0A08', keys: [[-1, [80.0, 11.6]], [0, [81.4, 12.0]], [2, [85.4, 12.8]], [4, [90.6, 14.0]], [6, [94.0, 15.6]], [8, [96.0, 14.0]]] },
  { id: 'w6', team: 'W', num: 6, skin: 5, hair: '#2A1C14', keys: [[-1, [59.0, 30.4]], [0, [59.8, 30.6]], [3, [63.6, 31.0]], [6, [68.0, 31.4]], [8, [70.0, 31.4]]] },
  { id: 'n4', team: 'N', num: 4, skin: 1, hair: '#100A06', keys: [[-1, [86.6, 36.2]], [0, [87.0, 36.0]], [1.06, [87.5, 35.5]], [2.0, [89.0, 35.0]], [2.6, [91.4, 33.8]], [3.1, [93.9, 32.6]], [3.78, [96.5, 31.85]], [4.3, [97.4, 31.9]], [5.2, [98.0, 32.6]], [8, [98.4, 33.0]]] },
  { id: 'n5', team: 'N', num: 5, skin: 2, hair: '#6B4A2A', keys: [[-1, [86.2, 27.8]], [0, [86.5, 27.5]], [1.06, [86.8, 27.2]], [2.0, [86.9, 27.6]], [3.1, [86.6, 28.6]], [3.78, [87.6, 29.3]], [4.5, [89.0, 29.8]], [6, [90.4, 30.6]], [8, [91.0, 31.0]]] },
  { id: 'n2', team: 'N', num: 2, skin: 3, hair: '#1B120C', keys: [[-1, [84.4, 48.6]], [0, [85.0, 48.4]], [2, [87.4, 48.0]], [4, [91.4, 47.0]], [6, [93.4, 45.0]], [8, [94.6, 43.0]]] },
  { id: 'n3', team: 'N', num: 3, skin: 0, hair: '#3B2416', keys: [[-1, [83.4, 14.4]], [0, [84.0, 14.4]], [2, [86.6, 14.6]], [4, [91.0, 15.2]], [6, [93.4, 16.4]], [8, [94.6, 17.0]]] },
  { id: 'n6', team: 'N', num: 6, skin: 4, hair: '#0E0A08', keys: [[-1, [70.0, 33.4]], [0, [71.0, 33.0]], [1.2, [73.4, 31.0]], [2.2, [76.4, 29.8]], [3.4, [80.4, 29.4]], [5, [84.0, 29.0]], [8, [86.0, 28.6]]] },
  { id: 'n8', team: 'N', num: 8, skin: 5, hair: '#2A1C14', keys: [[-1, [67.4, 44.6]], [0, [68.2, 44.0]], [2, [71.4, 42.4]], [4, [75.4, 41.0]], [8, [79.0, 40.0]]] },
  { id: 'gk', team: 'G', num: 1, skin: 2, hair: '#2A1C14', gk: true, keys: [[-1, [101.6, 33.6]], [0, [101.8, 33.5]], [1.4, [102.2, 33.2]], [3.1, [102.9, 33.0]], [3.78, [103.2, 32.9]], [8, [103.2, 32.9]]],
    dive: { s0: 4.05, s1: SRC.gkLand, dy: 2.0 } },
];

// —— ball: [s, [x, y, z]] piecewise, with the dribble and the passes ——
const BALL = [
  [-1, [64.6, 38.0, .11]], [0, [66.2, 37.3, .11]], [.3, [67.2, 36.8, .11]], [SRC.pass1, [68.0, 36.3, .11]],
  [1.0, [74.15, 27.2, .11]], [1.2, [74.5, 27.35, .11]], [SRC.thru, [74.9, 27.55, .11]],
];
function ballAt(s) {
  if (s <= SRC.pass1) return lerp3(BALL, s);
  if (s <= 1.0) return passPath([68.0, 36.3], [74.15, 27.2], SRC.pass1, 1.0, s, 1.15);
  if (s <= SRC.thru) return lerp3(BALL.slice(4), s);
  if (s <= SRC.recv9) return passPath([74.9, 27.55], [89.62, 31.5], SRC.thru, SRC.recv9, s, 1.32);
  if (s <= SRC.strike) { const k = (s - SRC.recv9) / (SRC.strike - SRC.recv9); const u = k * (1.25 - .25 * k); return [lerp(89.62, 92.2, u), lerp(31.5, 30.62, u), .11]; }
  const gl = SRC.goal, hit = gl + .085;
  if (s <= hit) { const k = (s - SRC.strike) / (hit - SRC.strike); const a = [92.2, 30.62], c = [107.0, 37.75]; return [lerp(a[0], c[0], k), lerp(a[1], c[1], k), .11 + .34 * Math.sin(k * 2.2) / Math.sin(2.2) + .05 * k]; }
  const k = clamp((s - hit) / .5);   // drops out of the back of the net, then rolls a little
  const z = .45 * (1 - k) * Math.abs(Math.cos(k * 4.4)) + .11 * k + .11 * (1 - k) * k * 0;
  return [107.0 - .7 * eo(clamp((s - hit) / 1.2)), 37.75 - .25 * eo(clamp((s - hit) / 1.2)), Math.max(.11, z)];
}
function lerp3(keys, s) {
  if (s <= keys[0][0]) return keys[0][1].slice();
  for (let i = 1; i < keys.length; i++) if (s <= keys[i][0]) { const a = keys[i - 1], c = keys[i], u = (s - a[0]) / (c[0] - a[0]); return a[1].map((v, j) => lerp(v, c[1][j], u)); }
  return keys[keys.length - 1][1].slice();
}
function passPath(a, c, s0, s1, s, v0) { const k = clamp((s - s0) / (s1 - s0)); const u = k * (v0 - (v0 - 1) * k); return [lerp(a[0], c[0], u), lerp(a[1], c[1], u), .11]; }
export const ball = s => ballAt(s);
export function ballSpin(s) { let d = 0; for (let x = -1; x < s; x += .02) { const p = ballAt(x), q = ballAt(x + .02); d += Math.hypot(q[0] - p[0], q[1] - p[1]); } return d / .11; }

// —— precomputed tracks: position, velocity, heading, gait phase ——
const DT = .01, S0 = -1, S1 = 8.6;
for (const P of PLAYERS) {
  const tr = track(P.keys), n = Math.round((S1 - S0) / DT) + 1;
  const pos = [], vel = [], hd = [], ph = [];
  for (let i = 0; i < n; i++) pos.push(tr(S0 + i * DT));
  let phase = (P.num * 1.7) % 6.28, h = 0;
  for (let i = 0; i < n; i++) {
    const a = pos[Math.max(0, i - 3)], c = pos[Math.min(n - 1, i + 3)], dt = (Math.min(n - 1, i + 3) - Math.max(0, i - 3)) * DT;
    const vx = (c[0] - a[0]) / dt, vy = (c[1] - a[1]) / dt, sp = Math.hypot(vx, vy);
    vel.push([vx, vy, sp]);
    const s = S0 + i * DT, bl = ballAt(s);
    const toBall = Math.atan2(bl[1] - pos[i][1], bl[0] - pos[i][0]);
    const run = Math.atan2(vy, vx), w = clamp((sp - .6) / 2.2);
    let target = P.gk ? Math.PI : angBlend(toBall, run, w);
    if (i === 0) h = target; else h = h + angDiff(target, h) * .18;
    hd.push(h);
    const stride = 1.5 + .26 * sp;
    if (i > 0) phase += sp * DT / stride * Math.PI * 2;
    ph.push(phase);
  }
  P.pos = pos; P.vel = vel; P.hd = hd; P.ph = ph; P.n = n;
  P.kit = KIT[P.team]; P.skinC = SKIN[P.skin];
}
function angDiff(a, c) { let d = a - c; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function angBlend(a, c, w) { return a + angDiff(c, a) * w; }
function sample(P, arr, s) { const f = clamp((s - S0) / DT, 0, P.n - 1.001), i = Math.floor(f), u = f - i; const A = arr[i], B = arr[i + 1]; return Array.isArray(A) ? A.map((v, j) => lerp(v, B[j], u)) : lerp(A, B, u); }

// —— skeleton: joints in world metres ——
const Lth = .45, Lsh = .45, Lua = .29, Lfa = .27;
export function skeleton(P, s) {
  const [x, y] = sample(P, P.pos, s), [, , sp0] = sample(P, P.vel, s);
  let hd = sample(P, P.hd, s), ph = sample(P, P.ph, s), sp = sp0;
  const a = clamp(sp / 7.5);
  // gait
  let aL = (.12 + .58 * a) * Math.sin(ph), aR = (.12 + .58 * a) * Math.sin(ph + Math.PI);
  let kL = .14 + (.15 + 1.15 * a) * Math.pow(.5 + .5 * Math.cos(ph), 1.6), kR = .14 + (.15 + 1.15 * a) * Math.pow(.5 + .5 * Math.cos(ph + Math.PI), 1.6);
  let sL = -(.08 + .62 * a) * Math.sin(ph), sR = -(.08 + .62 * a) * Math.sin(ph + Math.PI);
  let eL = .35 + 1.05 * a, eR = .35 + 1.05 * a, abL = .12, abR = .12;
  let lean = .04 + .2 * a, bob = .035 * a * Math.cos(2 * ph), headUp = 0;
  // kicks (right foot)
  for (const K of P.kicks || []) {
    const u = (s - K.s) / (.24 + .08 * K.pow), w = ss(clamp((u + 1.5) / .5)) * (1 - ss(clamp((u - 1.0) / .7)));
    if (w <= 0) continue;
    const P0 = K.pow;
    const back = u < -.35 ? lerp(-.1, -.4 - .25 * P0, ss((u + 1.2) / .85)) : u < 0 ? lerp(-.4 - .25 * P0, .3, ss((u + .35) / .35)) : lerp(.3, .3 + .95 * P0, eo(u / .7)) - (u > .7 ? .6 * (u - .7) : 0);
    const knee = u < -.35 ? lerp(.3, 1.2 + .8 * P0, ss((u + 1.2) / .85)) : u < 0 ? lerp(1.2 + .8 * P0, .4, ss((u + .35) / .35)) : lerp(.4, .15, clamp(u / .6));
    aR = lerp(aR, back, w); kR = lerp(kR, knee, w);
    aL = lerp(aL, .1, w); kL = lerp(kL, .62, w);
    sL = lerp(sL, .2 + 1.0 * P0, w); abL = lerp(abL, .45, w); eL = lerp(eL, .7, w);
    sR = lerp(sR, -.95 * P0, w); abR = lerp(abR, .55, w); eR = lerp(eR, .5, w);
    lean = lerp(lean, K.shot ? .28 - .14 * clamp(u) : .14, w);
  }
  // celebration: arms out wide like wings, head up
  if (P.celebrate && s > P.celebrate && P.hero) {
    // No. 9: one fist punched to the sky (right arm up, elbow bent), the other arm pulled in tight at the hip, chest out, head back
    const w = ss((s - P.celebrate) / .45), pump = .08 * Math.sin((s - P.celebrate) * 7);
    sR = lerp(sR, 2.55 + pump, w); abR = lerp(abR, .32, w); eR = lerp(eR, .75, w);
    sL = lerp(sL, -.55, w); abL = lerp(abL, .22, w); eL = lerp(eL, 1.95, w);
    lean = lerp(lean, -.08, w); headUp = .32 * w;
  } else if (P.celebrate && s > P.celebrate) {
    // No. 10: both arms up, running in
    const w = ss((s - P.celebrate) / .45);
    sL = lerp(sL, 2.7 + .06 * Math.sin(ph), w); sR = lerp(sR, 2.7 - .06 * Math.sin(ph), w);
    abL = lerp(abL, .45, w); abR = lerp(abR, .45, w); eL = lerp(eL, .35, w); eR = lerp(eR, .35, w);
    lean = lerp(lean, -.02, w); headUp = .2 * w;
  }
  // keeper: crouched set position, then the dive
  let roll = 0, lift = 0, slide = 0;
  if (P.gk) {
    const crouch = clamp((s - 2.6) / .8);
    aL = lerp(aL, .42, crouch); aR = lerp(aR, .42, crouch); kL = lerp(kL, .85, crouch); kR = lerp(kR, .85, crouch);
    sL = lerp(sL, .55, crouch); sR = lerp(sR, .55, crouch); abL = lerp(abL, .55, crouch); abR = lerp(abR, .55, crouch); eL = lerp(eL, .6, crouch); eR = lerp(eR, .6, crouch);
    lean = lerp(lean, .32, crouch);
    const D = P.dive, d = clamp((s - D.s0) / (D.s1 - D.s0));
    if (s > D.s0) {
      const air = ss(d);
      roll = 1.3 * eo(d * 1.4);            // body rolls toward the far post
      lift = .45 * Math.sin(Math.PI * Math.min(1, d * 1.05)) - .55 * ss((d - .55) / .45);
      slide = D.dy * eo(d);
      sL = lerp(sL, 2.9, air); sR = lerp(sR, 2.75, air); abL = lerp(abL, .15, air); abR = lerp(abR, .25, air); eL = lerp(eL, .1, air); eR = lerp(eR, .1, air);
      aL = lerp(aL, .1, air); aR = lerp(aR, -.15, air); kL = lerp(kL, .3, air); kR = lerp(kR, .5, air); lean = lerp(lean, .05, air);
    }
  }
  const f = [Math.cos(hd), Math.sin(hd)], l = [-f[1], f[0]];
  // local frame (fwd, left, up) → world
  const J = {};
  const pel = [0, 0, .95 + bob];
  const L = (fw, lf, up) => [fw, lf, up];
  const rot = (v, ang) => [v[0] * Math.cos(ang) + v[2] * Math.sin(ang), v[1], -v[0] * Math.sin(ang) + v[2] * Math.cos(ang)];   // pitch about the left axis (+ang leans forward)
  const add = (p, v) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
  const mul = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
  J.pel = pel;
  for (const [side, sg, al, kn] of [['L', 1, aL, kL], ['R', -1, aR, kR]]) {
    const hip = add(pel, [0, .1 * sg, -.04]);
    const th = [Math.sin(al), -.03 * sg, -Math.cos(al)], knee = add(hip, mul(th, Lth));
    const sa = al - kn, sh = [Math.sin(sa), .01 * sg, -Math.cos(sa)], ank = add(knee, mul(sh, Lsh));
    const toe = add(ank, [.19 * Math.cos(sa * .6), 0, .19 * Math.sin(sa * .6) - .03]);
    J['hip' + side] = hip; J['knee' + side] = knee; J['ank' + side] = ank; J['toe' + side] = toe;
  }
  const spine = rot([0, 0, .5], lean), chest = add(pel, spine), neck = add(chest, rot([0, 0, .11], lean * .6 - headUp)), head = add(neck, rot([0, 0, .14], lean * .4 - headUp));
  J.chest = chest; J.neck = neck; J.head = head;
  for (const [side, sg, sh_, el, ab] of [['L', 1, sL, eL, abL], ['R', -1, sR, eR, abR]]) {
    const shd = add(chest, add(rot([0, 0, -.03], lean), [0, .19 * sg, 0]));
    const ca = Math.cos(ab), sa_ = Math.sin(ab);
    const ua = [Math.sin(sh_) * ca, sa_ * sg, -Math.cos(sh_) * ca], elb = add(shd, mul(ua, Lua));
    const fa = [Math.sin(sh_ + el) * ca, sa_ * sg * (1 - .4 * Math.sin(el) * 0), -Math.cos(sh_ + el) * ca], wr = add(elb, mul(fa, Lfa));
    J['sho' + side] = shd; J['elb' + side] = elb; J['wri' + side] = wr;
  }
  // keeper roll (about the forward axis, around the pelvis) toward his right (−left)
  if (roll) for (const k in J) { const v = J[k]; const vy = v[1], vz = v[2] - .5; const c = Math.cos(-roll), sn = Math.sin(-roll); J[k] = [v[0], vy * c - vz * sn, vy * sn + vz * c + .5]; }
  // feet on the ground (unless airborne)
  let minz = 1e9; for (const k of ['ankL', 'ankR', 'toeL', 'toeR']) minz = Math.min(minz, J[k][2]);
  let dz = P.gk && roll ? Math.max(.02 - minz, lift) : .03 - minz;
  if (P.gk && roll) { let mz = 1e9; for (const k in J) mz = Math.min(mz, J[k][2]); dz = Math.max(dz, .06 - mz); }
  const out = {};
  const lat = P.gk ? slide : 0;   // keeper's dive moves toward +y (the far post)
  for (const k in J) { const v = J[k]; out[k] = [x + f[0] * v[0] + l[0] * v[1], y + f[1] * v[0] + l[1] * v[1] + lat, v[2] + dz]; }
  out.base = [x, y + lat, 0]; out.f = f; out.sp = sp;
  return out;
}
export function feet(P, s) { const [x, y] = sample(P, P.pos, s); let lat = 0; if (P.gk && s > P.dive.s0) lat = P.dive.dy * eo(clamp((s - P.dive.s0) / (P.dive.s1 - P.dive.s0))); return [x, y + lat, 0]; }
export const byId = id => PLAYERS.find(p => p.id === id);

// —— cameras ——
// A: main camera, high on the near side, panning and gently zooming with the ball.  T: tight iso camera from the same gantry (wide = A until the
// through ball, then zooms in on No. 9, whips with the shot and widens to the goal).  B: high reverse behind the goal.  H: low hero camera by the corner flag.
const A_POS = [52.5, -36, 22];
function aTarget(s) {
  const k = [[-1, [72.0, 34.0]], [0, [73.2, 33.4]], [1.0, [79.2, 32.0]], [2.0, [82.4, 31.6]], [3.1, [86.6, 31.8]], [3.78, [89.6, 32.2]], [4.4, [93.0, 33.0]], [6, [95, 30]], [8, [96, 28]]];
  return lerp3(k, s);
}
const aF = s => lerp(4100, 4400, ss((s - .5) / 3));
export function camera(id, s) {
  if (id === 'A') { const t = aTarget(s); return mk(A_POS, [t[0], t[1], .6], aF(s)); }
  if (id === 'T') {
    const t0 = aTarget(s), w9 = feet(byId('w9'), s);
    if (s <= 1.06) return mk(A_POS, [t0[0], t0[1], .6], aF(s));
    if (s <= SRC.strike) {
      const k = eio((s - 1.06) / (SRC.strike - 1.06)), kz = ss((s - 1.06) / (SRC.strike - 1.06 - .1));
      const tg = [lerp(t0[0], w9[0] + .35, k), lerp(t0[1], w9[1] + .2, k), lerp(.6, .95, k)];
      return mk(A_POS, tg, aF(s) * Math.pow(17000 / aF(s), kz));
    }
    // ball flight: whip with the ball and widen until the goal mouth is in frame; then hold on the celebration
    const bl = ballAt(Math.min(s, SRC.goal + .05));
    const k = clamp((s - SRC.strike) / (SRC.goal - SRC.strike));
    const lag = eio(clamp(k * 1.15));
    const st = [w9[0] + .35, w9[1] + .2, .95];
    const gm = [lerp(bl[0], 103.6, .35), lerp(bl[1], 35.0, .4), .9];
    let tg = [lerp(st[0], gm[0], lag), lerp(st[1], gm[1], lag), lerp(.95, .9, lag)];
    let f = lerp(17000, 7000, eio(clamp(k * 1.05)));
    if (s > SRC.goal) { const c = ss((s - SRC.goal - .25) / 1.2), w = feet(byId('w9'), s); tg = [lerp(tg[0], w[0] + 1.5, c), lerp(tg[1], w[1] + 2, c), .9]; f = lerp(f, 4400, c); }
    return mk(A_POS, tg, f);
  }
  if (id === 'B') { const k = ss((s - 2.8) / 1.0); return mk([123.5, 40.5, 12.5], [lerp(93, 95.5, k), lerp(32.6, 32.2, k), .6], 2350); }
  if (id === 'H') {
    const w = feet(byId('w9'), s), k = ss((s - 5.45) / 1.2);
    return mk([109.5, -4.5, 1.45], [w[0] - .5, w[1] + .2, 1.18], lerp(6400, 7000, k));
  }
}
function mk(pos, tgt, f) {
  const F = norm([tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]]);
  const R = norm([F[1], -F[0], 0]);           // right = F × up
  const U = [R[1] * F[2] - R[2] * F[1], R[2] * F[0] - R[0] * F[2], R[0] * F[1] - R[1] * F[0]];
  const cam = { pos, F, R, U, f, cx: 960, cy: 540 };
  cam.P = p => { const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]]; const z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2]; const x = d[0] * R[0] + d[1] * R[1] + d[2] * R[2], y = d[0] * U[0] + d[1] * U[1] + d[2] * U[2]; return [cam.cx + f * x / z, cam.cy - f * y / z, z]; };
  return cam;
}
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
