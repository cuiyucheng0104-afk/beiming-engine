// The red bicycle and its rider, side view, facing right. Rebuilt every frame from fixed seeds.
// Local units: ground = 0, up = negative y; hubs at x = ±105, wheel radius 60.
import { KNIFE, BRUSH, DAB, LINE, hex } from './engine/impasto.js';

const RED = hex('#d8261c'), RED2 = hex('#a3141a'), REDL = hex('#ff5a3c');
const TIRE = hex('#2a2422'), SPOKE = hex('#b4aca2'), STEEL = hex('#6a6460');
const COAT = hex('#47505e'), COAT2 = hex('#363c48'), TROU = hex('#2e2a2a'), SKIN = hex('#c69a7c'), CAP = hex('#3a3430'), SHOE = hex('#1c1816'), SADDLE = hex('#3a2a22');
const mix3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

function ik(a, t, l1, l2, bend) {     // two-bone IK, bend = +1/-1 side of the knee/elbow
  const dx = t[0] - a[0], dy = t[1] - a[1];
  let d = Math.hypot(dx, dy); d = Math.min(d, l1 + l2 - .01); d = Math.max(d, Math.abs(l1 - l2) + .01);
  const base = Math.atan2(dy, dx), k = Math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d));
  const ang = base - bend * k, j = [a[0] + Math.cos(ang) * l1, a[1] + Math.sin(ang) * l1];
  const e = [j[0] + Math.cos(Math.atan2(t[1] - j[1], t[0] - j[0])) * l2, j[1] + Math.sin(Math.atan2(t[1] - j[1], t[0] - j[0])) * l2];
  return [j, e];
}

// st: {wheel, crank, stand, foot, head, lean, dark, greyRider}
export function drawBike(out, X, Y, s, st, rev = { bike: 0, rider: 1e6 }) {
  const lean = st.lean || 0, cl = Math.cos(lean), sl = Math.sin(lean);
  const T = (x, y) => [X + (x * cl - y * sl) * s, Y + (x * sl + y * cl) * s];
  const dk = st.dark || 0;
  const col = c => mix3(c, [c[0] * .2 + .04, c[1] * .16 + .02, c[2] * .2 + .04], dk);
  const red = c => mix3(c, [c[0] * .42, c[1] * .2, c[2] * .2], dk * .85);   // the red keeps a little glow against the sun
  const push = (o, rv) => out.push({ ...o, rev: rv, run: 0 });
  const segK = (a, b, wid, c, c2, seed, o = {}, rv = rev.bike) => {
    const A = T(...a), B = T(...b), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    push({ x: (A[0] + B[0]) / 2, y: (A[1] + B[1]) / 2, ang: Math.atan2(B[1] - A[1], B[0] - A[0]), len: L + wid * s * .35, wid: wid * s, c, c2: c2 || c, type: KNIFE, seed, hgt: 1.15, skew: .2, ...o }, rv);
  };
  const dab = (p, r, c, seed, o = {}, rv = rev.bike) => { const A = T(...p); push({ x: A[0], y: A[1], ang: o.ang ?? 0, len: r * 2 * s * (o.ax ?? 1), wid: r * 2 * s, c, c2: o.c2 || c, type: DAB, seed, hgt: o.hgt ?? 1.1, alpha: o.alpha ?? 1 }, rv); };
  const line = (a, b, wid, c, seed, alpha = 1) => { const A = T(...a), B = T(...b); push({ x: (A[0] + B[0]) / 2, y: (A[1] + B[1]) / 2, ang: Math.atan2(B[1] - A[1], B[0] - A[0]), len: Math.hypot(B[0] - A[0], B[1] - A[1]), wid: Math.max(1.2, wid * s), c, type: LINE, seed, alpha, hgt: .6 }, rev.bike); };

  const RH = [-105, -60], FH = [105, -60], BB = [-20, -56];
  const SC = [-48, -168], HT = [76, -160], HB = [84, -124], BAR = [70, -192], GRIP = [36, -190];
  const sitHip = [-50, -196];

  // ---- wheels (behind everything): tyre ring that turns, spokes, hub
  const wheel = (c, k) => {
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a = st.wheel + i * Math.PI * 2 / n, a2 = a + Math.PI * 2 / n;
      const p = [c[0] + Math.cos((a + a2) / 2) * 56, c[1] + Math.sin((a + a2) / 2) * 56];
      const A = T(...p);
      push({ x: A[0], y: A[1], ang: (a + a2) / 2 + Math.PI / 2 + lean, len: 22 * s, wid: 10 * s, c: col(TIRE), c2: col(hex('#4a403a')), type: KNIFE, seed: k * 50 + i, hgt: 1.2 }, rev.bike);
    }
    for (let i = 0; i < 12; i++) { const a = st.wheel * 1 + i * Math.PI / 6; line(c, [c[0] + Math.cos(a) * 51, c[1] + Math.sin(a) * 51], 1.6, col(SPOKE), k * 70 + i, .75); }
    // rim highlight + hub
    for (let i = 0; i < 18; i++) { const a = i * Math.PI * 2 / 18; line([c[0] + Math.cos(a) * 50, c[1] + Math.sin(a) * 50], [c[0] + Math.cos(a + .36) * 50, c[1] + Math.sin(a + .36) * 50], 2.2, col(hex('#cfc6b8')), k * 90 + i, .8); }
    dab(c, 7, col(STEEL), k * 3 + 1);
  };
  wheel(RH, 1); wheel(FH, 2);

  // ---- rider pose
  const stand = st.stand || 0, foot = st.foot || 0;
  const bob = stand * Math.sin(st.crank * 2) * 6;
  let hip = [sitHip[0] + stand * 30 + foot * 14, sitHip[1] - stand * 44 + bob + foot * 4];
  const lean2 = stand * .22 + foot * -.05;
  const ca = st.crank, pedN = [BB[0] + Math.cos(ca) * 34, BB[1] + Math.sin(ca) * 34], pedF = [BB[0] - Math.cos(ca) * 34, BB[1] - Math.sin(ca) * 34];
  // near (left) foot goes down to the ground when he stops
  const ground = [BB[0] + 52, -4];
  const footN = [pedN[0] + (ground[0] - pedN[0]) * foot, pedN[1] + (ground[1] - pedN[1]) * foot];
  const footF = foot > 0 ? [BB[0] + (pedF[0] - BB[0]) * (1 - foot) + 30 * foot, BB[1] + (pedF[1] - BB[1]) * (1 - foot) - 34 * foot] : pedF;
  const shoulder = [hip[0] + 48 + lean2 * 60 + foot * -8 - (st.head || 0) * 12, hip[1] - 120 + lean2 * 24 + foot * -6 + Math.max(0, st.head || 0) * 3];
  const rc = st.greyRider ? 1 : 0;   // (rider drawn by the caller's grey setting)
  const C1 = col(COAT), C2 = col(COAT2), TR = col(TROU);

  // far leg (darker), behind the frame
  const [kF, aF] = ik(hip, footF, 98, 96, -1);
  segK(hip, kF, 26, TR.map(v => v * .62), null, 401, { taper: -.25 }, rev.rider); segK(kF, aF, 20, TR.map(v => v * .62), null, 402, {}, rev.rider);
  dab([aF[0] + 9, aF[1] + 2], 11, col(SHOE), 403, { ax: 1.7 }, rev.rider);
  // far crank
  line(BB, pedF, 5, col(STEEL), 404);

  // ---- frame (the one coloured thing)
  const R1 = red(RED), R2 = red(RED2), RL = red(REDL);
  segK(RH, BB, 9, R1, R2, 11); segK(RH, [-52, -150], 9, R1, R2, 12);
  segK(BB, SC, 12, R1, R2, 13); segK(BB, HB, 13, R1, R2, 14); segK([-46, -150], [78, -150], 11, RL, R1, 15);
  segK(HB, HT, 13, R1, R2, 16); segK(HB, FH, 9, R1, R2, 17, { bend: .08 });
  // fenders: red arcs over both wheels
  for (const [c, k] of [[RH, 0], [FH, 1]]) for (let i = 0; i < 7; i++) {
    const a0 = (k ? -2.6 : -2.9) + i * .32, a1 = a0 + .34, r = 66;
    segK([c[0] + Math.cos(a0) * r, c[1] + Math.sin(a0) * r], [c[0] + Math.cos(a1) * r, c[1] + Math.sin(a1) * r], 7, i < 3 ? RL : R1, R2, 30 + k * 10 + i);
  }
  // chain guard + chainring
  segK([-100, -64], [-14, -64], 10, R1, R2, 20); dab(BB, 19, col(hex('#3e3834')), 21);
  // stem, bars, saddle, basket-free city bike
  segK(HT, BAR, 6, col(STEEL), null, 22); segK(BAR, GRIP, 6, col(STEEL), null, 23, { bend: -.2 }); dab(GRIP, 7, col(hex('#3a2c24')), 24, { ax: 1.6 });
  segK(SC, [-50, -182], 5, col(STEEL), null, 25); dab([-52, -186], 13, col(SADDLE), 26, { ax: 2.1 });
  dab([86, -150], 7, col(hex('#fff2c8')), 27, { alpha: .9, hgt: 1.4 });   // lamp
  line(BB, pedN, 6, col(STEEL), 28); dab(pedN, 6, col(hex('#2a2422')), 29, { ax: 2 });

  // ---- rider body
  const neck = [shoulder[0] + 10, shoulder[1] - 14];
  // torso: a coat that flares at the hip, a rounded back, a lit front edge (toward the sun side)
  const mid = [(hip[0] + shoulder[0]) / 2, (hip[1] + shoulder[1]) / 2];
  segK([hip[0] - 14, hip[1] + 26], [hip[0] + 6, hip[1] - 20], 46, C2, C1, 500, { taper: -.35 }, rev.rider);          // coat tail over the saddle
  segK([hip[0] + 2, hip[1] + 4], [shoulder[0] - 2, shoulder[1] + 4], 54, C1, C2, 501, { taper: .48, bend: -.12 }, rev.rider);   // narrow waist, broad shoulders
  segK([mid[0] - 22, mid[1] + 6], [shoulder[0] - 16, shoulder[1] + 12], 24, C2, C2, 502, { bend: -.2 }, rev.rider);    // the curve of the back
  segK([hip[0] + 22, hip[1] - 6], [shoulder[0] + 18, shoulder[1] + 16], 13, mix3(C1, [.86, .82, .74], .35), C1, 503, {}, rev.rider);   // lit edge
  dab([shoulder[0] - 2, shoulder[1] + 8], 21, C1, 504, { ax: 1.1, c2: C2 }, rev.rider);
  segK([shoulder[0] - 16, shoulder[1] - 2], [shoulder[0] + 14, shoulder[1] + 2], 10, mix3(C1, [.9, .86, .78], .42), C1, 517, { taper: .5 }, rev.rider);   // shoulder catching the light
  // near leg
  const [kN, aN] = ik(hip, footN, 98, 96, -1);
  segK(hip, kN, 28, TR, col(hex('#3e3836')), 520, { taper: -.25 }, rev.rider); segK(kN, aN, 21, TR, null, 521, { taper: -.2 }, rev.rider);
  dab([aN[0] + 10, aN[1] + 2], 12, col(SHOE), 505, { ax: 1.7 }, rev.rider);
  // near arm to the grip
  const [eN, hN] = ik([shoulder[0] + 4, shoulder[1] + 10], GRIP, 74, 72, 1);
  segK([shoulder[0] + 4, shoulder[1] + 10], eN, 20, C1, C2, 506, {}, rev.rider); segK(eN, hN, 16, C1, null, 507, { taper: -.3 }, rev.rider);
  dab(hN, 9, col(SKIN), 508, {}, rev.rider);
  // head: rotates back to look up
  const hu = st.head || 0, ha = -hu * .8, ch = Math.cos(ha), sh = Math.sin(ha);
  const hc = [neck[0] + 10 + Math.sin(ha) * 8 - hu * 10, neck[1] - 30 + hu * 6];
  const rp = (dx, dy) => [hc[0] + dx * ch - dy * sh, hc[1] + dx * sh + dy * ch];   // point in head space (x = where he looks)
  const SK = col(SKIN), SKD = col(hex('#9c7460')), SKL = col(hex('#e6c2a2'));
  segK([neck[0] - 2, neck[1] + 8], [hc[0] - 4, hc[1] + 14], 16, SK, SKD, 509, {}, rev.rider);
  dab(rp(-4, -1), 23, SK, 510, { ax: 1.08, ang: ha, c2: SKD }, rev.rider);                 // skull
  dab(rp(10, 11), 14, SK, 518, { ax: 1.35, ang: ha + .35 }, rev.rider);                     // jaw and chin, forward
  segK(rp(-8, 19), rp(14, 21), 7, SKD, null, 519, { taper: .4 }, rev.rider);                // shadow under the jaw
  segK(rp(18, -16), rp(21, 6), 3.5, mix3(SK, SKL, .6), SK, 530, { taper: .4 }, rev.rider);                 // lit profile edge
  dab(rp(24, 1), 5.5, mix3(SK, SKL, .5), 514, { ax: 1.5, ang: ha + .5, c2: SK }, rev.rider);             // nose
  dab(rp(11, -6), 2.6, col(hex("#2a2220")), 531, { hgt: .8 }, rev.rider);                  // eye
  dab(rp(-7, 2), 6.5, col(hex('#a8785e')), 511, { ax: .7, ang: ha, c2: col(hex('#c99a7a')) }, rev.rider);   // ear
  if (hu > .35) dab(rp(6, 19), 6, col(hex('#dea074')), 522, { ax: 2.1, ang: ha - .1, c2: col(hex('#f4c08e')) }, rev.jaw ?? rev.rider);   // warm light under the chin as he looks up   // warm light on the jaw as he looks up
  // cap: crown + brim, tipped back with the head
  const cr = [hc[0] - 3 - hu * 6, hc[1] - 19 + hu * 3];
  dab(cr, 14, col(CAP), 512, { ax: 1.75, ang: ha * .8 }, rev.rider);
  dab([hc[0] - 15, hc[1] - 4], 8, col(hex('#4a3a30')), 516, { ax: 1.3, ang: 1.2 }, rev.rider);   // hair at the nape
  const bA = [hc[0] + 8, hc[1] - 16 + hu * 2], bB = [hc[0] + 30 + hu * -10, hc[1] - 13 - hu * 28];
  segK(bA, bB, 8, col(CAP), null, 513, {}, rev.rider);
  // scarf knot catching the wind (rider's only movement in the stillness)
  const flap = Math.sin((st.time || 0) * 5.3) * .25 + Math.sin((st.time || 0) * 8.1) * .1;
  segK([neck[0] - 4, neck[1] + 6], [neck[0] - 42 - (st.speed || 0) * .03, neck[1] + 8 + flap * 18], 13, col(hex('#7a7068')), col(hex('#5a524c')), 515, { taper: -.4 }, rev.rider);
  return { head: T(...hc), hip: T(...hip) };
}

// wheel spray: the rear tyre flicks gold paint behind it (motion paints the picture)
export function spray(out, t, bikeX, groundY, t0, t1, rate = 24) {
  const h = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
  const life = .55, first = Math.ceil((t - life - t0) * rate);
  for (let i = Math.max(0, first); i / rate + t0 <= Math.min(t, t1); i++) {
    const te = t0 + i / rate, a = t - te; if (a < 0 || a > life) continue;
    for (let j = 0; j < 2; j++) {
      const s = i * 7 + j * 3.3, ex = bikeX(te) - 105 - 40 - h(s) * 20;
      const vx = -120 - h(s + 1) * 260, vy = -260 - h(s + 2) * 300;
      const x = ex + vx * a, y = groundY - 6 + vy * a + 1300 * a * a;
      if (y > groundY + 30 + h(s + 3) * 50) continue;
      const k = a / life;
      out.push({ x, y, ang: Math.atan2(vy + 2600 * a, vx), len: 16 - k * 6, wid: 12 - k * 5, c: hex(h(s + 4) < .5 ? '#f2c050' : '#e09a30'), c2: hex('#ffd97a'), type: DAB, seed: s, alpha: 1 - k * .6, hgt: 1.3, rev: 0 });
    }
  }
}
