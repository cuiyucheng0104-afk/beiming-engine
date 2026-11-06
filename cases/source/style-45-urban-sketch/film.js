// 早餐铺开门 — picture: camera, walkers, bicycle, the shop's event (lid, steam, lanterns, sign), handwriting, sound events.
import { rng, n2, hex, mix3, lerp, clamp, ellipse, rough, penStroke, drawPen, drawPrims, wash, dab, figure, bike, handwrite, compositor, rgba, INK, PAPER, TAU, R3 } from './engine.js';
import { buildWorld, arrival, W, H, HOUSES, SHOP, NOTE, TITLE, SUBTITLE, GROUND, CURB, STREET } from './world.js';
import { H as HIT, DUR, BEAT, beats } from './timeline.js';
import { cycle } from './poses.js';
import { seg, ss, eio, eo, ei, track } from '/core/lib.js';

const q = new URLSearchParams(location.search);
await document.fonts.load('64px "Long Cang"', NOTE.text + TITLE.text + SUBTITLE.text);
await document.fonts.load('170px "Ma Shan Zheng"', '早点');

const world = buildWorld();
// colour arrival: each region gets its own moment (source times sit ~0.22 s after the hit so the shader's front jitter never leads the beat)
const LEAD = .22;
const SRC = {
  sky:    { x: 4300, y: 250, t: HIT.sky + LEAD, v: 1700 },
  wall:   { x: 1500, y: 1700, t: HIT.wall + LEAD, v: 2000 },
  ground: { x: 1500, y: 2350, t: HIT.wall + .333 + LEAD, v: 2400 },
  roof:   { x: 1800, y: 1000, t: HIT.roof + LEAD, v: 2400 },
  shop:   { x: 3060, y: 1640, t: HIT.lantern2 + .12, v: 3400, amp: 110 },   // after B1.2: 13.0–13.83 belongs to the first lantern's red alone
};
const GW = 1280, GH = 720;
const arr = q.get('full') ? new Float32Array(GW * GH).fill(0) : arrival(GW, GH, SRC);

const cvs = document.getElementById('c'), ctx = cvs.getContext('2d');
const glc = document.createElement('canvas'); glc.width = 1920; glc.height = 1080;
const comp = compositor(glc, { ...world, arr, gw: GW, gh: GH, calm: SRC.shop.t - .05 });
const tooth = (() => { const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d'); const im = x.createImageData(512, 512); const R = rng(77);
  for (let j = 0; j < 512; j++) for (let i = 0; i < 512; i++) { const v = n2(i * .35, j * .35, 3) * .6 + n2(i * .09, j * .09, 5) * .4; const g = 255 - Math.max(0, (v - .55)) * 55 - (R() < .004 ? 25 : 0); const k = (j * 512 + i) * 4; im.data[k] = g; im.data[k + 1] = g * .995; im.data[k + 2] = g * .985; im.data[k + 3] = 255; }
  x.putImageData(im, 0, 0); return c; })();
const toothPat = ctx.createPattern(tooth, 'repeat');

// silence freezes everything, the boil included
const frozen = t => (t >= HIT.silence && t < HIT.lid) ? HIT.silence - 1e-4 : t;
const boilOf = t => Math.floor(frozen(t) * 12);
const bloomClip = (cx, cy, R, seed) => c2 => { c2.beginPath(); const n = 28; for (let i = 0; i <= n; i++) { const a = i / n * TAU, r = R * (.8 + .4 * n2(Math.cos(a) * 2 + seed, Math.sin(a) * 2, seed)); const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? c2.lineTo(x, y) : c2.moveTo(x, y); } c2.closePath(); };
function inkProgress(prims, t, t0, t1) { const inks = prims.filter(p => p.k === 'ink'), n = inks.length, u = clamp((t - t0) / (t1 - t0)); const m = new Map(); inks.forEach((p, i) => m.set(p, clamp(u * n - i * .75))); return p => m.get(p) ?? 1; }

// ---------------- the bicycle ----------------
const BIKE = { t0: 5.6, x0: -60, v: 1250, y: STREET + 20, S: 500 };
const bikeX = t => BIKE.x0 + (t - BIKE.t0) * BIKE.v;
const RIDER = { skin: hex('#e2b394'), top: hex('#eeebe2'), bottom: hex('#3a3f4c'), hair: hex('#2e2622'), shoe: hex('#333') };

// ---------------- camera ----------------
const K = {
  k0: [1100, 900, .92], k1: [1300, 935, .93], wide: [2290, 1470, .455],
  crane: [2700, 1000, .58], shop: [3290, 1560, .86], punch: [3250, 1490, 1.06], sign: [3310, 1330, 1.62], margin: [4330, 1400, 1.12], end: [4310, 1396, 1.075],
};
const L3 = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
// spring follow of the bike: critically damped, on a lead-ahead target, starting from the wide shot
const SPR = []; { let p = [K.wide[0], K.wide[1]], v = [0, 0]; const dt = 1 / 240, k = 22, d = 2 * Math.sqrt(k);
  for (let t = HIT.bikeIn; t <= HIT.wall + .01; t += dt) { const bx = bikeX(t + .35) + 60, cap = 3080, g = [bx < cap - 300 ? bx : cap - 300 * Math.exp(-(bx - cap + 300) / 300), 2060]; for (let j = 0; j < 2; j++) { const a = k * (g[j] - p[j]) - d * v[j]; v[j] += a * dt; p[j] += v[j] * dt; } SPR.push([p[0], p[1]]); } }
const spring = t => SPR[clamp(Math.round((t - HIT.bikeIn) * 240), 0, SPR.length - 1)];
function camera(t) {
  let c;
  if (t < HIT.full) c = L3(K.k0, K.k1, eio(t / HIT.full));
  else if (t < HIT.bikeIn) c = L3(K.k1, K.wide, eio(seg(t, HIT.full, HIT.full + 1.55)));
  else if (t < HIT.bikeOut) { const s = spring(t); c = [s[0], s[1], lerp(K.wide[2], .74, eio(seg(t, HIT.bikeIn, HIT.bikeIn + .9)))]; }
  else if (t < HIT.wall) { const s = spring(t); c = L3([s[0], s[1], .74], K.crane, eio(seg(t, HIT.bikeOut, HIT.wall - .1))); }
  else if (t < HIT.lid) c = L3(K.crane, K.shop, eio(seg(t, HIT.wall, HIT.land)));
  else if (t < HIT.lid + .12) c = L3(K.shop, K.punch, eo(seg(t, HIT.lid, HIT.lid + .12)));
  else if (t < HIT.push) c = L3(K.punch, K.sign, eio(seg(t, HIT.lid + .12, HIT.push)));
  else if (t < HIT.margin) c = L3(K.sign, K.margin, eio(seg(t, HIT.push, HIT.margin)));
  else c = L3(K.margin, K.end, ss(seg(t, HIT.margin, DUR)));
  let rot = 0;
  // punch-in shake (0.35 s) when the lid pops
  if (t >= HIT.lid && t < HIT.lid + .35) { const u = t - HIT.lid, a = 16 * Math.exp(-u / .09); c = [c[0] + a * Math.sin(u * 95), c[1] + a * .8 * Math.sin(u * 71 + 1.3), c[2]]; rot = .004 * Math.exp(-u / .1) * Math.sin(u * 60); }
  // B2.1 (push): a soft zoom accent on the downbeat frame, echoing the lid's punch at a fraction of its size
  if (t >= HIT.push && t < HIT.push + .6) c = [c[0], c[1], c[2] * (1 + .014 * Math.exp(-(t - HIT.push) / .12))];
  // the crane gets a breath of roll
  if (t >= HIT.bikeOut && t < HIT.land) rot += .006 * Math.sin(Math.PI * seg(t, HIT.bikeOut, HIT.land));
  return { cx: c[0], cy: c[1], z: c[2], rot };
}
const toScreen = (cam, x, y) => { const c = Math.cos(cam.rot), s = Math.sin(cam.rot), dx = (x - cam.cx) * cam.z, dy = (y - cam.cy) * cam.z; return [960 + c * dx - s * dy, 540 + s * dx + c * dy]; };

// ---------------- walkers (carrot people) ----------------
const TOPS = ['#8ea6c4', '#d9d2c2', '#c9a27a', '#9fb3a0', '#b59fb6', '#e8e2d2', '#7d8aa6', '#c7b48c', '#a8b8c8'].map(hex);
const HAIRS = ['#3a2e28', '#2a2320', '#5a4636', '#231c1a'].map(hex);
const WALKERS = [];
{ const R = rng(2024); const spots = [[420, 1], [760, -1], [1180, 1], [1490, 1], [1900, -1], [2230, 1], [2620, -1], [3350, -1], [3900, -1], [4060, 1]];
  spots.forEach(([x, dir], i) => WALKERS.push({ x0: x, dir, y: GROUND + 50 + R() * 80, S: 330 + R() * 50, top: TOPS[i % TOPS.length], hair: HAIRS[i % HAIRS.length], seed: 300 + i * 13, tDraw: HIT.full + .02 + i * .085, stride: .26 + R() * .06, ph: R() < .5 ? 0 : 1 })); }
// beats walked since the walkers started (A tempo, frozen through the silence, B tempo after)
const walkBeats = t => { const tf = frozen(t); if (tf < HIT.full) return 0; if (tf < HIT.lid) return (Math.min(tf, HIT.silence) - HIT.full) / BEAT.A; return (HIT.silence - HIT.full) / BEAT.A + (tf - HIT.lid) / BEAT.B; };
function walkerAt(w, t) { const b = walkBeats(t); return { x: w.x0 + w.dir * b * w.stride * w.S, b }; }
const xAtWall = w => walkerAt(w, HIT.wall).x;
function drawWalker(w, t) {
  if (t < w.tDraw) return;
  const { x, b } = walkerAt(w, t), S = w.S, y = w.y, bo = boilOf(t), R = rng(w.seed + bo * 7);
  const inkP = clamp((t - w.tDraw) / .3);
  const col = clamp((t - (SRC.wall.t + Math.abs(xAtWall(w) - SRC.wall.x) / SRC.wall.v) - .05) / .45);
  const sw = Math.cos(Math.PI * (b + w.ph)), bob = Math.abs(Math.sin(Math.PI * (b + w.ph))) * S * .018;
  const hipY = y - S * .47 - bob, shY = y - S * .8 - bob, hw = S * .075, lean = w.dir * S * .02;
  const j = () => (R() - .5) * 1.2;
  const body = [[x - hw * .8 + lean * .3, hipY + S * .04], [x - hw + lean, shY + S * .02], [x - hw * .5 + lean, shY - S * .02], [x + hw * .5 + lean, shY - S * .02], [x + hw + lean, shY + S * .02], [x + hw * .8 + lean * .3, hipY + S * .04]];
  const st = sw * S * .1;
  const legs = [[[x - hw * .35, hipY], [x - hw * .45 - st, y]], [[x + hw * .35, hipY], [x + hw * .45 + st, y]]];
  const hy = shY - S * .075, hr = S * .05;
  const GREY = hex('#bdb5a8'), head = ellipse(x + lean, hy, hr, hr * 1.1, 12);
  const base = [{ k: 'knock', poly: body, a: .85 }, { k: 'wash', poly: body, col: GREY, a: .32, seed: w.seed + 5, dx: 1.5, j: 1.4, edge: .3 }];
  for (const l of legs) base.push({ k: 'ink', st: penStroke(l.map(([a, c]) => [a + j(), c]), { w: 2, wob: .4, over: 0, seed: w.seed + bo * 3 + (l[1][0] | 0), smooth: false }) });
  base.push({ k: 'ink', st: penStroke([body[0], body[1], body[2]], { w: 1.8, wob: .5, over: 1, seed: w.seed * 3 + bo, smooth: false }) });
  base.push({ k: 'ink', st: penStroke([body[3], body[4], body[5]], { w: 1.9, wob: .5, over: 1, seed: w.seed * 5 + bo, smooth: false }) });
  base.push({ k: 'knock', poly: head, a: .9 }, { k: 'ink', st: penStroke(head.slice(1, 11), { w: 1.7, wob: .3, over: 0, seed: w.seed + bo * 11, smooth: false }) });
  drawPrims(ctx, base, { color: 1, ink: inkProgress(base, t, w.tDraw, w.tDraw + .3) });
  if (col <= 0) return;
  const colour = [
    { k: 'fn', fn: c2 => { c2.save(); c2.globalCompositeOperation = 'multiply'; c2.fillStyle = rgba(hex('#8a8aa0'), .22); c2.beginPath(); c2.ellipse(x + S * .06, y + 3, S * .13, S * .025, 0, 0, TAU); c2.fill(); c2.restore(); } },
    { k: 'wash', poly: body, col: w.top, a: .62, seed: w.seed + bo, dx: 1.5, j: 1.4 },
    { k: 'wash', poly: [[x - hw * .8, hipY], [x + hw * .8, hipY], [x + hw * .6, hipY + S * .16], [x - hw * .6, hipY + S * .16]], col: mix3(w.top, [80, 80, 96], .55), a: .4, seed: w.seed + 1 },
    { k: 'wash', poly: head, col: hex('#e2b394'), a: .5, seed: w.seed + 2 }, { k: 'wash', poly: ellipse(x + lean, hy - hr * .3, hr * 1.05, hr * .8, 10), col: w.hair, a: .75, seed: w.seed + 3 }];
  drawPrims(ctx, colour, { color: 1, clip: col < 1 ? bloomClip(x, y - S * .5, S * 1.1 * eo(col), w.seed) : null });
}

// ---------------- the bicycle and its bell ----------------
function drawBike(t) {
  if (t < BIKE.t0 || t > HIT.wall) return;
  const x = bikeX(t), place = { x, y: BIKE.y, S: BIKE.S, yaw: Math.PI / 2, pitch: .2 }, bo = boilOf(t);
  const dist = x - BIKE.x0, wheel = dist / (BIKE.S * .19), crank = dist / (BIKE.S * .19 * 2.4);
  const prims = [...bike(place, wheel, hex('#7d8aa6'), { seed: 40 + bo * 7 }), ...figure(RIDER, { ...cycle(crank), nod: -.25 }, place, { seed: 90, boil: bo })];
  // a paper halo behind the rider so the line drawing reads over the street ink
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = rgba(PAPER, .55);
  ctx.beginPath(); for (const [i, p] of rough(ellipse(x, BIKE.y - BIKE.S * .5, BIKE.S * .55, BIKE.S * .55, 24), 18, bo).entries()) i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); ctx.closePath(); ctx.fill(); ctx.restore();
  drawPrims(ctx, prims, { color: 0 });
  // speed: two ink flicks trailing the rear wheel
  for (let k = 0; k < 2; k++) { const yy = BIKE.y - BIKE.S * (.12 + k * .1); drawPen(ctx, penStroke([[x - BIKE.S * .55 - k * 30, yy], [x - BIKE.S * .95 - k * 40, yy + 3]], { w: 1.8, wob: .8, over: 2, seed: 600 + bo * 5 + k }), 1, INK, .7); }
  // the bell: sound drawn as ink arcs from the handlebar
  const bell = [x + BIKE.S * .24, BIKE.y - BIKE.S * .78];
  for (const tb of [HIT.bell1, HIT.bell2]) {
    const u = t - tb; if (u < 0 || u > .45) continue;
    // a paper-white halo so the arcs read over the street ink
    const ha = .6 * ss(u / .05) * (1 - ss((u - .25) / .2));
    ctx.save(); ctx.fillStyle = rgba(PAPER, ha); ctx.beginPath();
    rough(ellipse(bell[0] + 70, bell[1] - 20, 175, 150, 22), 14, 31 + bo).forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); ctx.restore();
    for (let k = 0; k < 3; k++) { const r = 86 + k * 24, p = eo(clamp((u - k * .03) / .09)), f = ei(clamp((u - .14 - k * .03) / .2));
      const arc = [...Array(11)].map((_, i) => { const a = -1.25 + i / 10 * 1.9; return [bell[0] + Math.cos(a) * r, bell[1] + Math.sin(a) * r]; });
      drawPen(ctx, penStroke(arc, { w: 3.4, wob: .7, over: 2, seed: 700 + k + bo }), p, INK, .95, f); }
  }
}

// ---------------- the shop's event ----------------
const RED = hex('#c62f28'), RED_D = hex('#8f1f22'), GLOW = hex('#eda15a'), BAMBOO = hex('#d6b679');
const shopCol = t => clamp((t - SRC.shop.t) / .5);
const LID = track([[0, [0, 0, 0]], [HIT.lid, [0, 0, 0]], [HIT.lid + .15, [-12, -170, -.28]], [HIT.lid + .45, [22, -196, -.36]], [HIT.lantern2, [46, -2, .07]], [HIT.lantern2 + .07, [47, -12, .05]], [HIT.lantern2 + .16, [48, -3, .07]], [99, [48, -3, .07]]]);
function lidPose(t) { if (t < HIT.lid) return [0, 0, 0]; return LID(t); }
function drawLid(t) {
  const sm = SHOP.steamer, [dx, dy, a] = lidPose(t), cx0 = sm.x + dx, cy0 = sm.top + dy, moving = t >= HIT.lid && t < HIT.lantern2 + .3;
  const tf = ([x, y]) => [cx0 + x * Math.cos(a) - y * Math.sin(a), cy0 + x * Math.sin(a) + y * Math.cos(a)];
  const hw = sm.w / 2 + 4, dome = [...Array(15)].map((_, i) => { const u = i / 14, x = lerp(-hw, hw, u); return tf([x, -62 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), 3)), .45)]); });
  const poly = [...dome, tf([hw, 4]), tf([-hw, 4])];
  const bo = moving ? boilOf(t) : 0, sd = 800 + bo * 9;
  const prims = [{ k: 'knock', poly, a: .95 }, { k: 'wash', poly, col: BAMBOO, a: .55, seed: sd, dx: 3, dy: 2 },
    { k: 'ink', st: penStroke(dome, { w: 2.8, wob: .8, over: 4, seed: sd }) }, { k: 'ink', st: penStroke([tf([-hw - 4, 4]), tf([hw + 4, 5])], { w: 2.6, wob: .6, over: 3, seed: sd + 1 }) },
    { k: 'ink', st: penStroke([tf([-26, -64]), tf([-20, -82]), tf([20, -82]), tf([26, -64])], { w: 2.4, wob: .5, over: 1, seed: sd + 2 }) }];
  for (let k = -3; k <= 3; k++) prims.push({ k: 'ink', st: penStroke([tf([k * 36, -58 * Math.cos(k / 4)]), tf([k * 42, 0])], { w: 1.1, wob: .4, over: 0, seed: sd + 10 + k }), alpha: .6 });
  drawPrims(ctx, prims, { color: shopCol(t), ink: inkProgress(prims, t, 5.27, 5.42) });
}
// steam: paper-white puffs (reserves) that rise and fade + ink curls drawn on and erased from the tail
const PUFFS = []; { const R = rng(55); let tt = HIT.lid; while (tt < DUR) { const burst = tt < HIT.lid + .35; PUFFS.push({ t0: tt, dx: (R() - .5) * (burst ? 260 : 120), side: R() - .5, life: 1.8 + R() * .9, r0: burst ? 50 : 30, seed: (R() * 1e4) | 0, burst }); tt += burst ? .04 : .11 + R() * .08; }
  // B2.1 (push): the steamer breathes out once more, a second, smaller burst
  for (let k = 0; k < 6; k++) PUFFS.push({ t0: HIT.push - .042 + k * .035, dx: (R() - .5) * 200, side: R() - .5, life: 1.6 + R() * .6, r0: 44, seed: (R() * 1e4) | 0, burst: true, b0: HIT.push }); }
function drawSteam(t) {
  if (t < HIT.lid) return;
  const sm = SHOP.steamer, top = sm.top - 30, bo = boilOf(t);
  for (const p of PUFFS) {
    const age = t - p.t0; if (age < 0 || age > p.life) continue;
    const u = age / p.life, x = sm.x + p.dx * (p.burst ? eo(clamp(age / .4)) : 1) + Math.sin(age * 1.7 + p.seed) * 40 - age * 90, y = top - (p.burst ? 60 * eo(age / .3) : 0) - 230 * age - 30 * age * age;
    const r = p.r0 + 110 * Math.pow(age, .7), a = .46 * Math.pow(1 - u, 1.6) * ss(age / .1) * clamp((y - 1060) / 260);
    const poly = rough(ellipse(x, y, r * 1.15, r * .85, 20, p.seed), r * .14, p.seed + bo, Math.max(5, r * .2), .03);
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = rgba(PAPER, a); ctx.beginPath(); poly.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  // curls: one on every half beat after the lid, rising and erasing from the tail
  for (let k = 0; k < 16; k++) {
    const t0 = HIT.lid + k * BEAT.B / 2, age = t - t0; if (age < 0 || age > 1.4) continue;
    const R = rng(900 + k), x0 = sm.x + (R() - .5) * 220, y0 = top - 20, amp = 26 + R() * 20, ph = R() * TAU, hgt = 300 + R() * 160;
    const pts = [...Array(16)].map((_, i) => { const u = i / 15; return [x0 + Math.sin(u * 3.2 * Math.PI + ph) * amp * (1 - u * .3) - u * 70, y0 - u * hgt]; });
    const e = pts[15]; for (let i = 1; i <= 6; i++) { const a = ph + i / 6 * 4.2; pts.push([e[0] + Math.cos(a) * 20 - 20, e[1] - Math.sin(a) * 18]); }
    drawPen(ctx, penStroke(pts, { w: 2.3, wob: .7, over: 0, seed: 950 + k + bo }), eo(age / .55), INK, .82, ei(clamp((age - .45) / .9)));
  }
  // heat over the fire mouth: short wavy strokes
  for (let k = 0; k < 3; k++) { const ph = (t * 1.6 + k / 3) % 1, x = 3020 + k * 40, y = 1930 - ph * 90;
    const pts = [...Array(6)].map((_, i) => [x + Math.sin(i * 1.4 + k) * 7, y - i * 10]); drawPen(ctx, penStroke(pts, { w: 1.6, wob: .3, over: 0, seed: 990 + k + bo }), 1, INK, .55 * Math.sin(Math.PI * ph)); }
}
function drawLantern(L, t0, t) {
  const u = t - t0; if (u < 0) return;
  const c = eo(clamp(u / .55)), poly = ellipse(L.x, L.y, L.rx + 4, L.ry + 2, 26), clip = c < 1 ? bloomClip(L.x, L.y + 8, Math.max(L.rx, L.ry) * 1.45 * c, L.x | 0) : null;
  ctx.save(); if (clip) { clip(ctx); ctx.clip(); }
  // glow: a ring of warm dabs around it, arriving a little after the red
  ctx.globalCompositeOperation = 'multiply';
  const g = clamp((u - .15) / .6), R = rng(L.x | 0);
  for (let i = 0; i < 70; i++) { const a = R() * TAU, rr = (1.15 + R() * .6), x = L.x + Math.cos(a) * L.rx * rr, y = L.y + Math.sin(a) * L.ry * rr * .95; dab(ctx, x, y, 6 + R() * 12, R() * TAU, GLOW, (.1 + R() * .14) * g, i + (L.x | 0)); }
  wash(ctx, poly, RED, { a: .82, j: 3, layers: 3, edge: .45, seed: L.x | 0, dx: 3, dy: 2 });
  wash(ctx, poly.filter(([x]) => x > L.x + L.rx * .2), RED_D, { a: .35, j: 3, layers: 2, edge: .1, seed: (L.x | 0) + 1 });
  ctx.restore();
  // the lit core: a soft reserve lifted out of the red
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = rgba(hex('#f7e3c2'), .42 * c); const core = rough(ellipse(L.x - L.rx * .22, L.y - L.ry * .1, L.rx * .32, L.ry * .5, 16), 4, 7);
  ctx.beginPath(); core.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill(); ctx.restore();
}
const SIGN_TXT = '早点';
function drawSign(t) {
  const g = SHOP.sign, cx0 = (g.x0 + g.x1) / 2;
  const u = t - HIT.sign;
  if (u >= 0) { const c = eo(clamp(u / .6)), poly = [[g.x0 + 4, g.y0 + 4], [g.x1 - 4, g.y0 + 4], [g.x1 - 4, g.y1 - 4], [g.x0 + 4, g.y1 - 4]];
    ctx.save(); if (c < 1) { bloomClip(cx0, (g.y0 + g.y1) / 2, 420 * c, 21)(ctx); ctx.clip(); } wash(ctx, poly, RED, { a: .72, j: 4, layers: 3, edge: .4, seed: 23, dx: 3, dy: 3 }); ctx.restore(); }
  // B2.1 (push): the red wash dries and its pigment pools along the rim, popping in on the downbeat frame and settling over three frames
  const up = t - HIT.push;
  if (up >= 0) { const k = .7 + .3 * eo(clamp(up / .125)), R = rng(29); ctx.save(); ctx.globalCompositeOperation = 'multiply';
    const per = [[g.x0 + 8, g.y0 + 8], [g.x1 - 8, g.y0 + 8], [g.x1 - 8, g.y1 - 8], [g.x0 + 8, g.y1 - 8]];
    for (let e = 0; e < 4; e++) { const [a0, a1] = [per[e], per[(e + 1) % 4]], n = e % 2 ? 26 : 60;
      for (let i = 0; i < n; i++) { const u = (i + R()) / n, x = lerp(a0[0], a1[0], u) + (R() - .5) * 10, y = lerp(a0[1], a1[1], u) + (R() - .5) * 10;
        dab(ctx, x, y, 9 + R() * 14, R() * TAU, RED_D, (.22 + R() * .2) * k, 400 + e * 97 + i); } }
    ctx.restore(); }
  // the shop name, written by the pen as the camera lands
  handwrite(ctx, SIGN_TXT, cx0 - 2, g.y1 - 52, 168, clamp((t - HIT.land) / (HIT.silence - .05 - HIT.land)), { font: '"Ma Shan Zheng"', align: 'center', col: INK, alpha: .94 });
}

// ---------------- handwriting ----------------
let measured = null;
function measure() { if (measured) return measured; const m = (txt, size, font) => { ctx.save(); ctx.font = `400 ${size}px ${font}`; const w = ctx.measureText(txt).width; ctx.restore(); return w; };
  measured = { note: m(NOTE.text, NOTE.size, '"Long Cang"'), title: m(TITLE.text, TITLE.size, '"Long Cang"'), sub: m(SUBTITLE.text, SUBTITLE.size, '"Long Cang"'), sign: m(SIGN_TXT, 168, '"Ma Shan Zheng"') }; return measured; }
const T_NOTE = [HIT.open - 2 / 24, HIT.eave - .03], T_TITLE = [HIT.margin, HIT.title], T_SUB = [HIT.title, HIT.title + .45];
function notes(t) {
  handwrite(ctx, NOTE.text, NOTE.x, NOTE.y, NOTE.size, seg(t, ...T_NOTE), { font: '"Long Cang"', col: INK, alpha: .9, rot: -.02 });
  handwrite(ctx, TITLE.text, TITLE.x, TITLE.y, TITLE.size, seg(t, ...T_TITLE), { font: '"Long Cang"', col: INK, alpha: .93 });
  handwrite(ctx, SUBTITLE.text, SUBTITLE.x, SUBTITLE.y, SUBTITLE.size, seg(t, ...T_SUB), { font: '"Long Cang"', col: INK, alpha: .85 });
  // a small ink underline under the title, drawn with the last stroke
  if (t > HIT.title - .2) drawPen(ctx, penStroke([[TITLE.x - 6, TITLE.y + 34], [TITLE.x + measure().title * .55, TITLE.y + 40], [TITLE.x + measure().title + 12, TITLE.y + 30]], { w: 2.4, wob: 1, over: 6, seed: 61 }), eo(clamp((t - HIT.title + .2) / .3)), INK, .85);
}
window.TEXTS = t => {
  const cam = camera(t), m = measure(), out = [];
  const box = (id, text, x, y, size, w) => { const a = toScreen(cam, x, y - size * 1.0), b = toScreen(cam, x + w, y + size * .3); out.push({ id, text, x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) }); };
  if (t >= T_NOTE[0]) box('note', NOTE.text, NOTE.x, NOTE.y, NOTE.size, m.note);
  const g = SHOP.sign; if (t >= HIT.land) box('sign', SIGN_TXT, (g.x0 + g.x1) / 2 - m.sign / 2, g.y1 - 52, 168, m.sign);
  if (t >= T_TITLE[0]) box('title', TITLE.text, TITLE.x, TITLE.y, TITLE.size, m.title);
  if (t >= T_SUB[0]) box('sub', SUBTITLE.text, SUBTITLE.x, SUBTITLE.y, SUBTITLE.size, m.sub);
  return out.filter(o => o.x1 > 0 && o.x0 < 1920 && o.y1 > 0 && o.y0 < 1080);
};

// ---------------- render ----------------
window.DUR = DUR;
window.render = t => {
  const cam = camera(t);
  comp(cam, frozen(t));
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(glc, 0, 0);
  const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
  ctx.setTransform(cam.z * c, cam.z * s, -cam.z * s, cam.z * c, 960 - cam.z * (c * cam.cx - s * cam.cy), 540 - cam.z * (s * cam.cx + c * cam.cy));
  // the shop: lanterns, sign, lid, steam
  drawLantern(SHOP.lanterns[0], HIT.lid, t); drawLantern(SHOP.lanterns[1], HIT.lantern2, t);
  drawSign(t);
  drawSteam(t);
  drawLid(t);
  // walkers back to front, then the bicycle in front of them
  for (const w of [...WALKERS].sort((a, b) => a.y - b.y)) drawWalker(w, t);
  drawBike(t);
  notes(t);
  // paper tooth over everything
  ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = toothPat;
  ctx.setTransform(cam.z * c * .8, cam.z * s * .8, -cam.z * s * .8, cam.z * c * .8, 960 - cam.z * (c * cam.cx - s * cam.cy), 540 - cam.z * (s * cam.cx + c * cam.cy));
  const iz = 1 / (cam.z * .8); ctx.fillRect((cam.cx - 1300 / cam.z) / .8, (cam.cy - 800 / cam.z) / .8, 2600 * iz, 1600 * iz); ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
};

// ---------------- sound events (window.EV → events.json → mix.py) ----------------
const EV = [];
const hit = (name, type, extra = {}) => EV.push({ t: HIT[name], type, hit: name, ...extra });
hit('open', 'write', { d: T_NOTE[1] - T_NOTE[0], pan: -.5 });
for (const [t0, d, len, b] of world.strokes) EV.push({ t: t0, type: 'pen', d, len, b });
hit('eave', 'cue'); hit('tiles', 'cue'); hit('wire', 'cue'); hit('pole', 'cue'); hit('clothes', 'cue'); hit('full', 'cue');
for (const b of beats()) if ((b.sec === 'A' && b.t >= HIT.full - 1e-6) || b.sec === 'B') EV.push({ t: b.t, type: 'step', soft: b.sec === 'B' ? 1 : 0 });
EV.push({ t: BIKE.t0, type: 'bike', t1: HIT.wall });
hit('bikeIn', 'cue'); hit('bell1', 'bell'); hit('bell2', 'bell'); hit('bikeOut', 'cue');
hit('sky', 'wet', { size: 1.4 }); hit('wall', 'wet', { size: 1 }); hit('roof', 'wet', { size: .8 });
EV.push({ t: 11.0, type: 'rinse' });
hit('land', 'write', { d: HIT.silence - .05 - HIT.land, pan: .1 });
hit('silence', 'silence', { t1: HIT.lid });
hit('lid', 'lid'); hit('lid', 'steam', { t1: DUR }); hit('lid', 'punch'); hit('lid', 'lantern');
hit('lantern2', 'lidLand'); hit('lantern2', 'lantern');
hit('sign', 'wet', { size: .9 }); hit('push', 'cue'); hit('push', 'breath'); hit('push', 'wet', { size: .45 });
hit('margin', 'write', { d: T_TITLE[1] - T_TITLE[0], pan: .4 }); hit('title', 'write', { d: T_SUB[1] - T_SUB[0], pan: .45 });
hit('end', 'cue');
EV.sort((a, b) => a.t - b.t);
window.EV = EV;
window.TRACK = () => { const out = []; for (let t = BIKE.t0; t <= HIT.wall; t += .02) { const cam = camera(t), sx = (bikeX(t) - cam.cx) * cam.z / 960; out.push([+t.toFixed(2), +clamp(sx, -1, 1).toFixed(3)]); } return out; };
EV.push({ t: BIKE.t0, type: 'track', pts: window.TRACK() });
window.READY = true;
