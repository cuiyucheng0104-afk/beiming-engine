// 天为什么是蓝的 — one glossy whiteboard, 19.5 s, locked to the 120 BPM grid in timeline.js
import * as W from './engine/wb.js';
import { clamp, lerp, mulberry, TAU } from '/core/lib.js';
import { TL, W as T, b, S16, DUR, FPS, KEY } from './timeline.js';

const INK = W.INK, BLACK = INK.black, BLUE = INK.blue, RED = INK.red;
const ss = u => { u = clamp(u); return u * u * (3 - 2 * u); };

export async function build() {
  await W.loadHanzi('fonts/glyphs.json');
  const tl = new W.Timeline();
  const K1 = new W.Pen('K1', BLACK, { park: [2250, 1250] });
  const K2 = new W.Pen('K2', BLACK, { park: [-350, 1300] });
  const R = new W.Pen('R', RED, { park: [2300, -250] });
  const B1 = new W.Pen('B1', BLUE, { park: [2300, 1350] });
  const B2 = new W.Pen('B2', BLUE, { park: [2350, 300] });
  const PENS = [K1, K2, R, B1, B2];
  const LAND = {};                                   // visual landing times, measured from the scheduled strokes

  // place one stroke at an exact window (bypasses the scheduler's 0.05 s hop so beat-locked strokes start on the grid)
  function place(pen, s, t0, t1, kind) {
    s.color = s.color || pen.color; s.t0 = t0; s.t1 = t1; s.pen = pen; s.epoch = tl.erasers.length;
    tl.strokes.push(s); pen.segs.push({ s, t0, t1 });
    tl.ev.push({ t: +t0.toFixed(4), type: kind || (s.len < 16 ? 'tap' : s.kind === 'text' ? 'write' : 'stroke'), dur: +(t1 - t0).toFixed(4), len: Math.round(s.len), pen: pen.id, x: Math.round(s.start[0]), y: Math.round(s.start[1]) });
    return t1;
  }
  const drawBy = (pen, strokes, t0, t1, name) => { const e = tl.draw(pen, strokes, t0, { by: t1, maxGap: .06, minGap: .02 }); if (name) LAND[name] = e; return e; };
  const texts = [];                                  // for readcheck: {id, text, box, t0}
  const harp = (x0, y0, x1, y1, o = {}) => {        // fast hand arrow: shaft + one barb in one stroke
    const a = Math.atan2(y1 - y0, x1 - x0), h = o.head ?? 42, n = 14, p = [];
    const bow = (o.bow ?? 0) * Math.hypot(x1 - x0, y1 - y0), nx = -Math.sin(a), ny = Math.cos(a);
    for (let i = 0; i <= n; i++) { const u = i / n, k = Math.sin(Math.PI * u) * bow; p.push(lerp(x0, x1, u) + nx * k, lerp(y0, y1, u) + ny * k); }
    p.push(x1 - h * Math.cos(a - .5), y1 - h * Math.sin(a - .5));
    return new W.Stroke(p, { w: o.w ?? 9, jitter: .5, wav: 160, ...o });
  };

  // ───────── A. the question, written in stroke order (0 – 3.5 s)
  const TX = 450, TY = 430;
  const title = W.hanzi('天为什么是蓝的？', TX, TY, { h: 180, seed: 5 });
  const G = title.glyphs;
  drawBy(K1, G[0].strokes, T.tian[0], T.tian[1], '天');
  drawBy(K1, [1, 2, 3, 4].flatMap(i => G[i].strokes), T.weishenmeshi[0], T.weishenmeshi[1], '为什么是');
  drawBy(K1, G[5].strokes, T.lan[0], T.lan[1], '蓝(题)');
  drawBy(K1, [6, 7].flatMap(i => G[i].strokes), T.deq[0], T.deq[1], '？');
  texts.push({ id: 'title', text: '天为什么是蓝的？', box: title.box, t0: 0 });

  // ───────── B. sun → white light → seven waves (3.5 – 8 s)
  const SX = 650, SY = 1180, SR = 150;
  LAND['太阳'] = place(K1, W.circle(SX, SY, SR, { w: 10, a0: -2.4, lap: .3 }), T.sun[0], T.sun[1]);
  const rays = [];
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU - Math.PI / 2 + .2; rays.push(W.line(SX + Math.cos(a) * (SR + 38), SY + Math.sin(a) * (SR + 38), SX + Math.cos(a) * (SR + 105), SY + Math.sin(a) * (SR + 105), { w: 9, bow: 0 })); }
  drawBy(K1, rays, T.rays[0], T.rays[1]);
  const AX0 = 870, AX1 = 1660, AY = SY;
  const hollow = W.poly([[AX0, AY - 40], [AX1 - 170, AY - 42], [AX1 - 172, AY - 95], [AX1, AY + 2], [AX1 - 168, AY + 96], [AX1 - 166, AY + 44], [AX0 + 4, AY + 40]], { w: 10, jitter: .6 });
  LAND['白光箭头'] = place(K1, hollow, T.arrow[0], T.arrow[1]);
  const bg = W.hanzi('白光', 1265, 1030, { h: 92, align: 'center', seed: 9 });
  drawBy(K1, bg, T.baiguang[0], T.baiguang[1], '白光');
  texts.push({ id: 'baiguang', text: '白光', box: bg.box, t0: T.baiguang[0] });
  const PX = 1700, PY = SY, WX = 2780;
  const waveEnd = k => [WX, 800 + 128 * k];        // 1.35× the old spacing: still seven lines at 0.4× zoom
  const lam = [150, 128, 110, 95, 82, 70, 58];
  const wavePts = k => {
    const [ex, ey] = waveEnd(k), L = Math.hypot(ex - PX, ey - PY), ux = (ex - PX) / L, uy = (ey - PY) / L, p = [];
    for (let s = 0; s <= L; s += 5) { const A = 30 * ss(s / (.75 * L)), d = A * Math.sin(TAU * s / lam[k]); p.push(PX + ux * s - uy * d, PY + uy * s + ux * d); }   // straight rays at the split, waves once they have room
    return p;
  };
  const wavePen = k => k === 0 ? R : k === 5 ? B1 : K1;
  T.waves.forEach(([t0, t1], k) => {
    const hero = k === 0 || k === 5;
    place(wavePen(k), new W.Stroke(wavePts(k), { w: hero ? 10 : 5.5, alpha: hero ? .94 : .8, jitter: .35, wav: 260 }), t0, t1, 'wave');
  });
  LAND['波0'] = T.waves[0][0];

  // ───────── C. air molecules; red goes straight, blue bounces everywhere (8 – 12 s)
  const D = [[3000, 1330], [3260, 1010], [3480, 1300], [3350, 880], [3700, 1080], [3900, 1400], [3150, 1180], [3640, 1420]];
  D.forEach(([x, y], k) => {
    const p = []; for (let i = 0; i <= 28; i++) { const u = i / 28, a = u * TAU * 1.7 + k, r = 3 + 13 * u; p.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    place(K1, new W.Stroke(p, { w: 12, jitter: 0, smooth: 0 }), T.dots[k], T.dots[k] + 2 / FPS, 'dot');
  });
  const kq = W.hanzi('空气分子', 3420, 700, { h: 80, align: 'center', seed: 21 });
  drawBy(K1, kq, T.kongqi[0], T.kongqi[1], '空气分子');
  texts.push({ id: 'kongqi', text: '空气分子', box: kq.box, t0: T.kongqi[0] });
  // red: one straight arrow through the dots
  const [rx, ry] = waveEnd(0);
  const redShaft = W.line(rx, ry, 4380, ry, { w: 10, bow: .002 });
  place(R, redShaft, T.red[0], T.red[1] - 3 / FPS);
  place(R, harp(4300, ry - 52, 4384, ry + 2, { w: 10, head: 0 }), T.red[1] - 3 / FPS + .02, T.red[1] - 1.5 / FPS);
  place(R, W.line(4384, ry + 2, 4300, ry + 56, { w: 10, bow: 0 }), T.red[1] - 1.5 / FPS + .01, T.red[1]);
  LAND['红箭头'] = T.red[1];
  // blue: zig-zag from molecule to molecule, faster and faster
  const path = [waveEnd(5), D[0], D[1], D[2], D[4], D[7], D[5], D[3], [2480, 300]];
  const ping = [], bounceS = [], sprayS = [];
  for (let k = 0; k < 8; k++) {
    const [x0, y0] = path[k], [x1, y1] = path[k + 1], t0 = T.bounce[k], t1 = T.bounce[k + 1];
    const last = k === 7, gapIn = k ? 1 / FPS * .5 : 0;
    const L = Math.hypot(x1 - x0, y1 - y0), sh = last ? 0 : 20;            // stop just short of the dot
    const st = harp(x0 + (x1 - x0) / L * (k ? 18 : 0), y0 + (y1 - y0) / L * (k ? 18 : 0), x1 - (x1 - x0) / L * sh, y1 - (y1 - y0) / L * sh, { w: 9, head: last ? 60 : 34, bow: (k % 2 ? .05 : -.05) });
    place(B1, st, t0 + gapIn, t1, 'bounce'); bounceS.push(st);
    if (!last) ping.push({ t: t1, x: x1, y: y1 });
  }
  LAND['蓝弹'] = T.bounce.slice(1, 8);
  LAND['全板'] = T.full;
  // second blue pen sprays from the molecules in every direction (16ths)
  const spray = [[2, 3620, 1980], [1, 3020, 430], [5, 4480, 1980], [0, 2560, 1990], [4, 4520, 920], [7, 3260, 2280], [6, 2280, 2160], [3, 3960, 360]];
  spray.forEach(([di, x1, y1], k) => {
    const [x0, y0] = D[di], t0 = T.spray[k];
    const st = harp(x0 + (x1 - x0) * .04, y0 + (y1 - y0) * .04, x1, y1, { w: 9, head: 50, bow: (k % 2 ? .04 : -.04) });
    place(B2, st, t0, t0 + 2 / FPS, 'spray'); sprayS.push(st);
  });

  // ───────── D. the eraser rewinds: right → left across the lower half (12 – 13 s)
  // Time runs backwards: board time τ in [10, 12] plays at 12 + (12 − τ)/2, exactly like the score, which is the 10–12 s cue
  // reversed and squeezed into 12–13 s. Every blue stroke retracts from its tip back to where it started (a 9 % ghost stays,
  // as with a real eraser); the felt eraser rides the bounce trail backwards, on the retracting tip.
  const rwT = tau => T.erase[0] + (T.erase[0] - tau) * (T.erase[1] - T.erase[0]) / 2;      // 12 + (12 − τ)/2
  const RW = [];                                     // {s, a, b}: retract window
  const retract = (st, kind) => {
    const a = rwT(st.t1), bb = rwT(st.t0), fwd = st.prog.bind(st);
    st.prog = t => t < a ? fwd(t) : 1 - clamp((t - a) / (bb - a));
    st.hide = t => t >= bb;
    const g = Object.assign(Object.create(Object.getPrototypeOf(st)), st, { alpha: st.alpha * .09, t0: a - .002, t1: a - .001, hide: null });
    delete g.prog; g.epoch = st.epoch; tl.strokes.push(g);
    RW.push({ s: st, a, b: bb });
    tl.ev.push({ t: +a.toFixed(4), type: 'unwrite', dur: +(bb - a).toFixed(4), len: Math.round(st.len), pen: st.pen.id, kind, x: Math.round(st.end[0]), y: Math.round(st.end[1]) });
  };
  bounceS.forEach(st => retract(st, 'bounce')); sprayS.forEach(st => retract(st, 'spray'));
  const trail = RW.filter(r => r.s.pen === B1).sort((p, q) => p.a - q.a);
  const ePos = t => {                                // eraser = the tip of the bounce stroke being undone
    const r = trail.find(r => t < r.b) || trail[trail.length - 1];
    if (t <= r.a) return r.s.end;
    return r.s.at(r.s.len * (1 - clamp((t - r.a) / (r.b - r.a))));
  };
  const ERASER = { t0: T.erase[0], t1: T.erase[1], width: 140,
    path: { len: 1, start: ePos(T.erase[0]), end: ePos(T.erase[1]), at: u => ePos(T.erase[0] + u * (T.erase[1] - T.erase[0])) } };
  { const env = []; for (let t = T.erase[0]; t <= T.erase[1] + 1e-9; t += 1 / 96) { const a = ePos(t), c = ePos(Math.min(T.erase[1], t + 1 / 96)); env.push([+t.toFixed(4), Math.round(Math.hypot(c[0] - a[0], c[1] - a[1]) * 96)]); }
    tl.ev.push({ t: T.erase[0], type: 'erase', dur: T.erase[1] - T.erase[0], env }); }

  // ───────── E. the answer: two black pens, then the blue pen circles 蓝 (13 – 17 s)
  const CX = 1000, L1 = 1790, L2 = 2045, CH = 165;
  const a1 = W.hanzi('蓝光波长短，', CX, L1, { h: CH, seed: 31 }), a2 = W.hanzi('最容易被散射', CX, L2, { h: CH, seed: 37 });
  drawBy(K1, [0, 1].flatMap(i => a1.glyphs[i].strokes), T.whip[0], T.lanGuang[1], '蓝光');   // the pen is already writing as the whip lands
  drawBy(K1, [2, 3, 4, 5].flatMap(i => a1.glyphs[i].strokes), T.boChangDuan[0], T.boChangDuan[1], '波长短');
  drawBy(K2, [0, 1, 2, 3].flatMap(i => a2.glyphs[i].strokes), T.zuiRongYiBei[0], T.zuiRongYiBei[1], '最容易被');
  drawBy(K2, [4, 5].flatMap(i => a2.glyphs[i].strokes), T.sanShe[0], T.sanShe[1], '散射');
  texts.push({ id: 'ans1', text: '蓝光波长短，', box: a1.box, t0: T.lanGuang[0] });
  texts.push({ id: 'ans2', text: '最容易被散射', box: a2.box, t0: T.zuiRongYiBei[0] });
  const g0 = a1.glyphs[0], ccx = (g0.x0 + g0.x1) / 2 + 2, ccy = L1 + 4;
  const ring = []; for (let i = 0; i <= 120; i++) { const u = i / 120, a = -2.5 + u * (TAU * 2 + .35), r = 1 + .07 * u; ring.push(ccx + Math.cos(a) * 118 * r, ccy + Math.sin(a) * 124 * r); }
  LAND['圈蓝'] = place(B1, new W.Stroke(ring, { w: 10, jitter: .5, wav: 300 }), T.circle[0], T.circle[1], 'circle');

  // ───────── cues for sound
  tl.cue(T.erase[0], 'rewind', { dur: T.erase[1] - T.erase[0] });
  tl.cue(T.whip[0], 'whip', { dur: T.whip[1] - T.whip[0] });
  tl.cue(T.capOn, 'capOn');
  tl.cue(T.slap, 'magnet', { big: 1 });
  ping.forEach(p => tl.cue(p.t, 'ping', { x: p.x, y: p.y }));
  tl.end();

  // ───────── ghosts of old lessons (5–10 %), deterministic
  const ghosts = [], RG = mulberry(4242), chars = '光分子气空白长短波';
  for (let i = 0; i < 44; i++) {
    const x = 150 + RG() * 4700, y = 150 + RG() * 2500, kind = RG(), col = RG() < .7 ? '#9aa0a8' : '#8aa0c8', al = .05 + RG() * .05;
    let ss_ = [];
    if (kind < .38) ss_ = W.hanzi(chars[(RG() * chars.length) | 0], x, y, { h: 90 + RG() * 140, seed: 900 + i });
    else if (kind < .58) ss_ = [W.circle(x, y, 40 + RG() * 140, { w: 8, lap: .3 })];
    else if (kind < .78) ss_ = W.arrow(x, y, x + (RG() - .5) * 600, y + (RG() - .5) * 300, { w: 8 });
    else ss_ = [W.line(x, y, x + 200 + RG() * 500, y + (RG() - .5) * 120, { w: 8 })];
    for (const s of ss_) { s.color = col; s.alpha = al; ghosts.push(s); }
  }

  // ───────── camera (world → screen goes through one function: cam.at)
  const base = new W.Camera([
    [0.00, 560, 440, 2.0],
    [1.00, 1290, 520, .95, 0, 'io'],               // ride with the pen and pull back to the whole question
    [3.50, 1300, 560, .95, 0, 'l'],                // hold: read it
    [4.50, 1250, 800, .88, 0, 'io'],               // drift down: question and sun together
    [5.50, 1640, 1080, 1.0, 0, 'io'],              // the pen leads: ride the white light to the right
    [7.00, 2050, 1150, 1.0, 0, 'l'],
    [8.00, 3300, 1130, 1.1, 0, 'io'],              // track along the waves into the molecules
    [10.0, 3330, 1130, 1.1, 0, 'l'],               // hold while the label is written
    [12.0, 3060, 1270, .64, -.03, 'o'],            // pull back with a little roll as blue fills the sky
    [T.whip[0], 2990, 1255, .66, 0, 's'],          // near-still while the rewind plays: the lines visibly un-draw
    [T.whip[1], 1255, 1835, 1.55, 0, 'io'],        // whip down-left onto the answer patch: the first strokes of 蓝 are already big
    [14.0, 1330, 1900, 1.36, 0, 'io'],             // ease back as the sentence grows
    [16.0, 1640, 1905, 1.05, 0, 'io'],
    [17.0, 1560, 1880, 1.32, 0, 'io'],             // slow push into 蓝
    [17.95, 1350, 1540, .85, 0, 'io'],             // return to the sun for the magnet
    [18.25, 1350, 1540, .85, 0, 'l'],              // hold on the slap
    [T.full, 2500, 1406, .40, 0, 'io'],            // the whole board as one picture (lands 18.875 on the kalimba E5)…
    [DUR, 2500, 1406, .40, 0, 'l'],                // …and holds dead still to the end
  ]);
  const cam = {
    at(t) {
      const c = base.at(t);
      if (t >= T.slap && t < T.slap + .45) {        // impact jolt
        const u = t - T.slap, a = Math.exp(-u / .07) * 9 / c.z;
        return { ...c, x: c.x + Math.sin(u * 97) * a * .6, y: c.y + Math.sin(u * 131 + 1) * a };
      }
      return c;
    },
    toWorld(sx, sy, t) { const c = this.at(t), dx = (sx - 960) / c.z, dy = (sy - 540) / c.z, cs = Math.cos(-c.r), sn = Math.sin(-c.r); return [c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs]; },
  };

  // ───────── props: sun magnet, eraser, markers
  const MAG = T.slap, mIn = T.magnetIn;
  function magnet(t) {
    if (t < mIn) return null;
    if (t < MAG) {
      const u = (t - mIn) / (MAG - mIn);
      const ent = ss(clamp(u / .55));                  // float in from upper left
      const x = lerp(SX - 700, SX + 6, ent), y = lerp(SY - 650, SY - 6, ent);
      let lift = lerp(1.25, .8, ent);
      if (u > .62) lift = lerp(.8, .98, ss((u - .62) / .2));   // wind-up: a little rise…
      if (u > .84) lift = .98 * (1 - Math.pow((u - .84) / .16, 2.2));   // …then the slam
      return { x, y, lift, rot: (1 - ent) * -.25 };
    }
    const u = t - MAG, sq = Math.exp(-u / .08) * Math.cos(u * 70);
    return { x: SX + 6, y: SY - 6, lift: 0, squash: sq, rot: 0 };
  }
  const pose = (p, t) => {
    if (p === B1 && t > T.circle[1] && t < T.circle[1] + .75) {   // lift, cap it, fly off
      const [ex, ey] = p.segs[p.segs.length - 1].s.end, u = t - T.circle[1];
      const up = ss(u / .12), cap = ss((u - .03) / .095), out = ss((u - .26) / .45);
      const [px, py] = cam.toWorld(p.park[0], p.park[1], t);
      return { x: lerp(ex + 20, px, out), y: lerp(ey - 30, py, out), lift: Math.min(1, .6 * up + out), on: false, cap };
    }
    if (p === B1 && t >= T.circle[1] + .75) return null;
    return W.penPose(p, t, cam);
  };
  const board = new W.Board(tl, { ghosts, W: 5000, H: 2812 });
  board.objs.push({ draw: (ctx, t, c) => W.drawEraser(ctx, ERASER, t, c) });
  board.objs.push({ draw: (ctx, t, c) => { const m = magnet(t); if (m) W.drawSunMagnet(ctx, m.x, m.y, c, { r: 205, lift: m.lift, squash: m.squash, rot: m.rot }); } });
  board.objs.push({ draw: (ctx, t, c) => { for (const p of PENS) W.drawMarker(ctx, p, pose(p, t), c, t); } });

  // ───────── frame render with camera motion blur when the camera moves fast
  const off = new OffscreenCanvas(1920, 1080), oc = off.getContext('2d');
  const q = new URLSearchParams(location.search);
  function render(ctx, t) {
    const dt = 1 / FPS, a = cam.at(t), bb = cam.at(Math.max(0, t - dt));
    let sp = 0;                                       // largest screen motion of the frame corners over one frame
    for (const [sx, sy] of [[0, 0], [1920, 0], [0, 1080], [1920, 1080], [960, 540]]) {
      const w = cam.toWorld(sx, sy, Math.max(0, t - dt)), p = W.toScreen(a, w[0], w[1]); sp = Math.max(sp, Math.hypot(p[0] - sx, p[1] - sy));
    }
    const N = sp > 12 && !q.has('noblur') ? Math.min(160, Math.ceil(sp * .5 / 4) + 1) : 1;
    if (N === 1) { board.render(ctx, t, cam); return; }
    for (let i = 0; i < N; i++) {                   // camera-only blur: the board's content stays at t, only the camera is smeared (no strobing pens)
      const o = dt * .5 * i / (N - 1), cs = { at: tt => cam.at(tt - o), toWorld: (sx, sy, tt) => cam.toWorld(sx, sy, tt - o) };
      board.render(oc, t, cs);
      ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(off, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  // ───────── events for the mixer: screen pan and zoom at each event
  const ev = tl.ev.slice();
  for (const e of ev) if (e.x != null) { const c = cam.at(e.t), [px, py] = W.toScreen(c, e.x, e.y); e.pan = +clamp((px - 960) / 1400, -.75, .75).toFixed(2); e.z = +c.z.toFixed(2); e.on = px > -100 && px < 2020 && py > -100 && py < 1180 ? 1 : 0; }
  ev.push({ t: 0, type: 'timeline', TL, LAND });

  // ───────── on-screen texts for readcheck (screen boxes)
  const TEXTS = t => texts.filter(x => t >= x.t0).map(x => {
    const c = cam.at(t), [x0, y0] = W.toScreen(c, x.box[0], x.box[1]), [x1, y1] = W.toScreen(c, x.box[2], x.box[3]);
    return { id: x.id, text: x.text, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }).filter(r => r.x1 > 0 && r.x0 < 1920 && r.y1 > 0 && r.y0 < 1080);

  return { dur: DUR, render, ev, TEXTS, LAND };
}
