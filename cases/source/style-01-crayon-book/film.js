// 小纸船遇上大雨 — one page, one continuous camera, a page turn at the end.
// World = a 3200×1800 page (full page on screen = scale 0.6). All timing comes from timeline.js.
import { layer, clear, line, fill, dab, text, handCircle, ellipse, smooth, xf, CAM, BOIL, W, H, sx, sy } from './crayon.js';
import { group, clearGroup, part, erase, knock } from './rig.js';
import { clamp, lerp, hash, track, ss, eio, eo, ei, back } from '/core/lib.js';
import { T, DUR } from './timeline.js';
export { DUR };

// ——— the crayon box (11 sticks) + one watercolour ———
export const K = {
  ink: '#2d3263', sky: '#79acd9', cloud: '#8d88b4', yellow: '#f5c63c', orange: '#ec8a3c', coral: '#e0604c',
  green: '#62a24c', violet: '#6a5aa6', pink: '#ee8ea4', sand: '#efd7a2', white: '#fbfaf4',
};
const PAPER = [0.957, 0.937, 0.890];
const WASH_T = [0.40, 0.47, 0.63];            // storm grey-blue (transmission colour)
const RB = [K.coral, K.orange, K.yellow, K.green, K.sky, K.violet];
const pr = (t, a, b) => clamp((t - a) / (b - a));
const q12 = t => Math.floor(t * 12 + 1e-6) / 12;   // drawn things step on twos

// ——— world layout ———
const BOAT0 = { x: 1500, y: 1300 };
const SUN = { x: 2780, y: 330, r: 170 };
const RBC = { x: 2050, y: 1330, r0: 820, dr: 46 };
const CLOUDS = [
  { x: 1700, y: 300, w: 330, h: 150, seed: 11, t: T.cloud0, away: -2300 },
  { x: 820, y: 360, w: 260, h: 120, seed: 23, t: T.cloud1, away: -1500 },
  { x: 2330, y: 500, w: 240, h: 112, seed: 37, t: T.cloud2, away: -250, awayY: -1150 },
];
const DROPS = [[300, 700], [500, 910], [660, 620], [850, 860], [1020, 640], [1180, 905]].map(([x, y], i) => ({ x, y, i }));
// puddle: a lumpy oval
const PUD = (() => { const pts = []; for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const r = 1 + (hash(i * 3.7 + 1) - .5) * 0.12; pts.push([1750 + Math.cos(a) * 1380 * r, 1425 + Math.sin(a) * 205 * r]); } return smooth(pts, 6, true); })();
// white-wax rain streaks, on the page from the first frame (invisible until the wash)
const STREAKS = Array.from({ length: 95 }, (_, i) => { const x = hash(i * 1.31 + .2) * 3500 - 250, y = hash(i * 2.77 + .9) * 1050 + 60, L = 120 + hash(i * 5.1) * 170; return { x, y, L }; });

// ——— camera: world centre + scale; one track, every move starts and ends on a cue ———
const camT = track([
  [0, [1500, 1290, 2.6]], [T.sail, [1500, 1215, 2.2]], [T.flag, [1500, 1090, 1.75]], [T.eyes, [1510, 1110, 1.45]], [T.cloud0, [1560, 1130, 1.15]],
  [T.cloud2, [1650, 600, 0.95]], [T.wash, [1660, 590, 0.95]],
  [T.rock2, [1600, 960, 0.72]], [T.silence, [1510, 1180, 1.5]], [T.sun, [1505, 1172, 1.55]],
]);
function cam(t) {
  if (t < T.sun) return camT(t);
  // whip-pan up-right to the sun (fast out of the cut, settles on the beat)
  const C0 = [1505, 1172, 1.55], C1 = [2720, 420, 1.25], C2 = [2700, 430, 1.32], FULL = [1600, 900, 0.6], END = [2100, 1000, 0.75];
  const L = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
  if (t < T.sw0) return L(C0, C1, eo(pr(t, T.sun, T.sw0)));
  if (t < T.pull) return L(C1, C2, pr(t, T.sw0, T.pull));
  if (t < T.col2) return L(C2, FULL, eio(pr(t, T.pull, T.col2)));
  if (t < T.band0) return FULL;
  if (t < T.lift) return L(FULL, END, eio(pr(t, T.band0, T.lift)));
  return END;
}

// ——— layers ———
const WAX = layer(), BG = { f: layer(), l: layer() }, CL = group(), WASH = layer(), WF = layer();
const SUNG = group(), DR = group(), RBL = layer(), BOAT = group(), FRONT = { f: layer(), l: layer() }, RAIN = layer(), TOOL = group();
const PB = layer(), PBL = layer(), SCR = layer(), SCR2 = layer(), SCR3 = layer(), WMASK = layer();

// screen ↔ world
const wpt = ([X, Y]) => [(X - W / 2) / CAM.s + CAM.x, (Y - H / 2) / CAM.s + CAM.y];
const pan = X => clamp((X / W) * 2 - 1, -0.85, 0.85);

// ——— the crayon stick (the tool that does the drawing) ———
// tip at screen (X,Y); ang = direction from the tip back along the stick
function stick(C, X, Y, ang, col, k = 1, seed = 1) {
  const L = 300 * k, Wd = 44 * k, tipL = 52 * k;
  const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
  const P = (a, b) => wpt([X + ux * a + nx * b, Y + uy * a + ny * b]);
  const tip = [P(0, -3 * k), P(tipL, -Wd / 2), P(tipL, Wd / 2), P(0, 3 * k)];
  const body = [P(tipL - 2, -Wd / 2), P(L, -Wd / 2), P(L + 4 * k, 0), P(L, Wd / 2), P(tipL - 2, Wd / 2)];
  const wrap = [P(tipL + 40 * k, -Wd / 2 - 2), P(L - 30 * k, -Wd / 2 - 2), P(L - 30 * k, Wd / 2 + 2), P(tipL + 40 * k, Wd / 2 + 2)];
  const sc = Math.pow(CAM.s, 0.45);
  part(C, body, { col, p: 1.05, gap: 5 / sc, w: 7 / sc, over: 1, seed: seed + 1, ang: ang + 1.57 }, { w: 4.5 / sc, p: .95, seed: seed + 2, wob: .5 });
  part(C, wrap, { col: K.white, p: .5, gap: 7 / sc, w: 7 / sc, over: 0, seed: seed + 3, ang: ang + 1.57 }, { w: 3.5 / sc, p: .9, seed: seed + 4, wob: .4 });
  // two stripes on the wrapper
  for (const a of [tipL + 70 * k, L - 60 * k]) line(C.l, [P(a, -Wd / 2), P(a, Wd / 2)], { w: 4 / sc, col, p: 1, seed: seed + a });
  part(C, tip, { col, p: 1.1, gap: 4 / sc, w: 6 / sc, over: 1, seed: seed + 5 }, { w: 4 / sc, p: .9, seed: seed + 6, wob: .3 });
}

// ——— the paper boat ———
const HULL = [[-240, -120], [240, -120], [178, -8], [150, 12], [-150, 12], [-178, -8]];
const SAIL = [[-128, -120], [128, -120], [0, -418]];
function drawBoat(t, o) {
  const C = BOAT; clearGroup(C);
  const at = pts => xf(pts, { x: o.x, y: o.y, r: o.rot, s: o.s ?? 1 });
  const sp = o.puff ?? 1;
  const sail = at(SAIL.map(([x, y]) => [x * sp, -120 + (y + 120) * (1 + (sp - 1) * .6)]));
  const hull = at(HULL);
  const bw = 7.5, sd = 91;
  // sail (behind the hull)
  if (o.dSail > 0) {
    if (o.dSail >= 1) knock(C, sail);
    if (o.fSail > 0) fill(C.f, sail, { col: K.sand, p: 1.2, gap: 8.5, w: 11, over: 5, seed: sd + 1, ang: -0.5, draw: o.fSail, cross: o.fSail >= 1, crossP: .7 });
    line(C.l, [...sail, sail[1]], { w: bw, seed: sd + 2, draw: o.dSail, taper: .1 });
    if (o.dSail >= 1) line(C.l, at([[0, -418], [4, -270], [0, -122]]), { w: 4.5, p: .7, seed: sd + 3 });   // the fold
  }
  // mast and flag
  if (o.dMast > 0) {
    const m = at([[0, -418], [0, -505]]), fl = at([[0, -505], [64, -482], [0, -458]]);
    if (o.dMast >= 1) { fill(C.f, fl, { col: K.coral, p: 1, gap: 6, w: 8, over: 3, seed: sd + 4, draw: o.fFlag ?? 1 }); }
    line(C.l, m, { w: 6, seed: sd + 5, draw: clamp(o.dMast * 2) });
    if (o.dMast > .5) line(C.l, [...fl, fl[0]], { w: 5.5, seed: sd + 6, draw: clamp(o.dMast * 2 - 1), taper: .1 });
  }
  // hull (in front: hides the sail's lines inside it)
  if (o.dHull > 0) {
    if (o.dHull >= 1) { erase(C.l, hull); erase(C.f, hull); knock(C, hull); }
    if (o.fHull > 0) fill(C.f, hull, { col: K.coral, p: 1.0, gap: 9.5, w: 11, over: 6, seed: sd + 7, ang: 0.55, draw: o.fHull, cross: o.fHull >= 1, crossP: .5 });
    line(C.l, [...hull, hull[1]], { w: bw + 1, seed: sd + 8, draw: o.dHull, taper: .08 });
  }
  // face
  if (o.face) face(C, at, o);
  return { hull, sail };
}
function face(C, at, o) {
  const e = o.face, sc = o.eyeS ?? 1, sd = 140;
  const P = (x, y) => at([[x, y]])[0];
  const E = [[-64, -70], [64, -70]];
  const look = o.look || [0, 0];
  // cheeks
  for (const [x] of E) { const c = P(x * 1.62, -42); dab(C.f, c[0], c[1], 22 * sc, { col: K.pink, p: .75, seed: sd + x }); }
  for (let k = 0; k < 2; k++) {
    const [ex, ey] = E[k]; const c = P(ex, ey);
    if (e === 'joy') {   // closed happy eyes ^ ^
      line(C.l, at([[ex - 20, ey + 6], [ex, ey - 12], [ex + 20, ey + 6]]), { w: 6.5, seed: sd + 3 + k });
    } else {
      const big = e === 'scared' ? 1.35 : 1;
      if (e === 'scared') line(C.l, handCircle(c[0], c[1], 25 * sc, sd + 9 + k, .1, 30), { w: 4.5, seed: sd + 11 + k, closed: true });
      const pc = P(ex + look[0] * 9, ey + look[1] * 9);
      dab(C.l, pc[0], pc[1], 13 * sc * big, { col: K.ink, p: 1.1, seed: sd + 5 + k, gap: 3.5, w: 5 });
      dab(C.l, pc[0] - 4 * sc, pc[1] - 5 * sc, 4.2 * sc, { col: K.white, p: 1.2, seed: sd + 7 + k, gap: 2.5, w: 3.5 });
      // brows: worried / scared = inner ends raised (inner end is the one nearer the middle)
      if (e === 'worried' || e === 'scared' || e === 'lookup') {
        const lift = e === 'lookup' ? 8 : 0, s = k ? 1 : -1;
        const inner = [ex - s * 12, ey - 44 - (e === 'lookup' ? 6 : 14) - lift], outer = [ex + s * 22, ey - 34 - lift];
        line(C.l, at([outer, inner]), { w: 5.5, seed: sd + 13 + k, taper: .3 });
      }
    }
  }
  // mouth
  if (e === 'happy') line(C.l, at([[-22, -30], [0, -18], [22, -30]]), { w: 5.5, seed: sd + 20 });
  else if (e === 'joy') { const m = at(ellipse(0, -30, 26, 15, 18, 0, Math.PI)); fill(C.f, [...m], { col: K.pink, p: .9, gap: 4, w: 5, seed: sd + 21 }); line(C.l, [...at([[-28, -30], [28, -30]]), ...m.slice().reverse()], { w: 5.5, seed: sd + 22, closed: true }); }
  else if (e === 'worried' || e === 'lookup') line(C.l, at([[-16, -24], [-6, -29], [6, -24], [16, -28]]), { w: 5, seed: sd + 23 });
  else if (e === 'scared') line(C.l, handCircle(...P(0, -24), 11 * (o.eyeS ?? 1), sd + 24, .1, 24), { w: 5, seed: sd + 25, closed: true });
}

// ——— boat performance (poses snap in on the beat over two frames, with a little overshoot) ———
const ROCK = [[T.rock0, .10, 0], [T.rock1, -.13, 5], [T.rock2, .16, 10], [T.sink, -.24, 26], [T.rock3, .13, 28]];
function boatPose(t) {
  const tq = q12(t);
  let x = BOAT0.x, y = BOAT0.y, rot = 0;
  // calm bobbing (on twos)
  const bob = Math.sin(tq * Math.PI * 2 / 1.333) * 6;
  if (t < T.wash) { y += t > T.eyes ? bob : 0; rot = t > T.eyes ? Math.sin(tq * 4.7) * .025 : 0; }
  else if (t < T.sun + 1.333) {
    let pr0 = [0, 0];
    for (let i = 0; i < ROCK.length; i++) {
      const [tc, r, dy] = ROCK[i]; if (t < tc) break;
      const u = back(pr(t, tc, tc + 0.084), 2.2); pr0 = [lerp(pr0[0], r, u), lerp(pr0[1], dy, u)];
      if (i + 1 < ROCK.length && t >= ROCK[i + 1][0]) pr0 = [r, dy];
    }
    rot = pr0[0]; y += pr0[1];
    if (t >= T.wash && t < T.rock0) { rot = Math.sin(tq * 9) * .04; }
    if (t >= T.silence) { rot = lerp(.13, .07, ss(pr(t, T.silence, T.sun))) + Math.sin(tq * 3) * .01; }
    // rescued: the boat pops back up after the sun opens its eyes
    if (t >= T.sunface) { const u = back(pr(t, T.sunface, T.pull), 1.6); y = lerp(BOAT0.y + 28, BOAT0.y, u); rot = lerp(.07, 0, u); }
  } else {
    y += bob; rot = Math.sin(tq * 4.7) * .03;
    if (t > T.sailaway) x += (t - T.sailaway) * 275;
  }
  // face
  let face = null, look = [0, 0], eyeS = 1;
  if (t >= T.eyes) { face = 'happy'; eyeS = back(pr(t, T.eyes, T.eyes + .17), 2.4); }
  if (t >= T.cloud0) { face = 'lookup'; look = [.2, -.8]; }
  if (t >= T.wash) { face = 'worried'; look = [0, -.3]; }
  if (t >= T.sink) { face = 'scared'; look = [0, 0]; }
  if (t >= T.lookup) { face = 'lookup'; look = [.55, -.75]; }
  if (t >= T.sunface + .5) face = 'joy';
  // the sail puffs out under the rainbow
  const puff = t >= T.under ? 1 + 0.1 * Math.max(0, 1 - pr(t, T.under, T.under + .9)) * Math.cos(pr(t, T.under, T.under + .9) * 7) : 1;
  return { x, y, rot, face, look, eyeS, puff };
}

// ——— clouds ———
function cloudPoly(c, dx = 0, dy = 0) {
  const pts = []; const n = 60;
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2; const top = Math.sin(a) < 0;
    const bump = top ? 0.2 * Math.abs(Math.sin(a * 3.5 + c.seed)) : 0.06 * Math.abs(Math.sin(a * 6 + c.seed));
    pts.push([c.x + dx + Math.cos(a) * c.w * (1 + bump * .6), c.y + dy + Math.sin(a) * c.h * (top ? 1 + bump : 0.72)]);
  }
  return pts;
}
function drawClouds(t) {
  clearGroup(CL);
  const tq = q12(t);
  for (const c of CLOUDS) {
    if (t < c.t) continue;
    const d = pr(t, c.t, c.t + 0.42);
    const ua = t > T.sunface ? ei(pr(tq, T.sunface, T.col2)) : 0, dx = c.away * ua, dy = (c.awayY || 0) * ua;
    const poly = cloudPoly(c, dx, dy);
    if (d >= 1) knock(CL, poly);
    fill(CL.f, poly, { col: K.cloud, p: .95, gap: 10, w: 12, over: 8, seed: c.seed, draw: d, ang: .4, cross: d >= 1, crossP: .55, boil: .6 });
    line(CL.l, poly, { w: 7, seed: c.seed + 1, draw: d, boil: .6 });
    if (t >= T.frown) {   // grumpy faces: inner brow ends pushed DOWN (angry), mouth turned down
      const f = (x, y) => [c.x + dx + x * c.w / 300, c.y + dy + y];
      const surprised = t > T.sunface;
      for (const s of [-1, 1]) {
        const ex = s * 70;
        dab(CL.l, ...f(ex, 0), surprised ? 13 : 10, { col: K.ink, p: 1.1, seed: c.seed + 4 + s, gap: 3.5, w: 5 });
        if (!surprised) line(CL.l, [f(ex + s * 34, -40), f(ex - s * 10, -24)], { w: 6, seed: c.seed + 6 + s });
      }
      if (surprised) line(CL.l, handCircle(...f(0, 44), 14, c.seed + 9, .1, 24), { w: 5, seed: c.seed + 10, closed: true });
      else line(CL.l, [f(-30, 52), f(0, 38), f(30, 52)], { w: 6, seed: c.seed + 8 });
    }
  }
}

// ——— the watercolour (one tube: storm grey-blue) ———
function washBands(L, t) {
  const g = L.g; clear(L);
  if (t < T.wash) return;
  // the bottom band runs well past the page's bottom edge (≥ 60 px on screen at every camera): no strip of bare paper under the wash
  const BANDS = [[-160, 700, 0], [560, 1300, .06], [1160, 1990, .12]];
  const geo = [];
  for (const [ya, yb, dl] of BANDS) {
    const u = pr(t, T.wash + dl, T.wash + dl + .9), xe = lerp(-300, 3600, eio(u));
    if (u <= 0) continue;
    const P = new Path2D(), N = 40;
    for (let i = 0; i <= N; i++) { const x = lerp(-400, xe, i / N); const y = ya + Math.sin(x / 37 + ya) * 9 + Math.sin(x / 13) * 4; i ? P.lineTo(sx(x), sy(y)) : P.moveTo(sx(x), sy(y)); }
    for (let k = 0; k <= 16; k++) { const y = lerp(ya, yb, k / 16); P.lineTo(sx(xe + Math.sin(y / 23 + ya) * 26 + Math.sin(y / 7) * 8 - Math.sin(k / 16 * Math.PI) * 60), sy(y)); }
    for (let i = N; i >= 0; i--) { const x = lerp(-400, xe, i / N); const y = yb + Math.sin(x / 41 + yb) * 9 + Math.sin(x / 11) * 4; P.lineTo(sx(x), sy(y)); }
    P.closePath(); geo.push({ P, ya, yb, u, xe });
  }
  // one fill for all bands: overlaps are not painted twice (no dark seams between bands)
  const U = new Path2D(); geo.forEach(b => U.addPath(b.P));
  g.fillStyle = 'rgba(0,0,0,0.86)'; g.fill(U, 'nonzero');
  for (const { P, ya, yb, u, xe } of geo) {
    // bristle streaks along the stroke: short, hair-thin, faint (α ≤ 0.07) and jittery, so none of them reads as a horizon or a hill
    g.save(); g.clip(P);
    for (let k = 0; k < 90; k++) {
      const y = lerp(ya, yb, hash(k * 3.3 + ya)), x0 = lerp(-400, 3500, hash(k * 7.13 + ya * .01)), x1 = Math.min(xe, x0 + 140 + hash(k * 2.9 + ya) * 300);
      if (x1 <= x0 + 20) continue;
      g.beginPath();
      for (let i = 0; i <= 14; i++) { const x = lerp(x0, x1, i / 14), yy = y + Math.sin(x / 8.5 + k) * 2.2 + Math.sin(x / 3.7 + k * 2.1) * 1.3 + (i / 14) * (hash(k * 4.4) - .5) * 14; i ? g.lineTo(sx(x), sy(yy)) : g.moveTo(sx(x), sy(yy)); }
      const dark = hash(k * 9.1 + ya) > .5;
      g.lineWidth = (0.7 + hash(k * 1.7) * 1.3) * Math.max(CAM.s, .6); g.strokeStyle = dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
      g.globalCompositeOperation = dark ? 'source-over' : 'destination-out'; g.stroke();
    }
    // darker wet leading edge while moving
    if (u < 1) { const gx = sx(xe); const gr = g.createLinearGradient(gx - 120 * CAM.s, 0, gx + 20 * CAM.s, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.16)'); g.globalCompositeOperation = 'source-over'; g.fillStyle = gr; g.fillRect(gx - 120 * CAM.s, sy(ya - 30), 150 * CAM.s, (yb - ya + 60) * CAM.s); }
    g.restore();
  }
  // the sun dries the page: the wash dries patch by patch (a world-anchored noise field of "drying times", nearest the sun first),
  // each patch leaving a faint tide line that then dries too. The GL wash pass pools pigment along every receding edge.
  if (t > T.sunface) {
    const P = ei(pr(t, T.sunface, T.sunface + 2.0)) * 1.35 - .26;
    const a = DRY.a, d = DRY.img.data;
    for (let i = 0; i < a.length; i++) {
      const e = a[i] - P;                                   // > 0 still wet, < 0 dried
      const wet = ss(clamp(e / .014 + .5));
      const rim = e < 0 ? .22 * Math.exp(-((e / .022) ** 2)) : 0;   // the dried edge keeps a little pigment (tide line / dry mark)
      d[i * 4 + 3] = Math.round(255 * Math.max(wet, rim));
    }
    DRY.g.putImageData(DRY.img, 0, 0);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in'; g.imageSmoothingEnabled = true;
    g.drawImage(DRY.c, sx(DRY.x0), sy(DRY.y0), (DRY.x1 - DRY.x0) * CAM.s, (DRY.y1 - DRY.y0) * CAM.s); g.restore();
  }
}
// drying-time field (world-anchored, 1 cell = 8 world px): distance from the sun + four octaves of value noise
const DRY = (() => {
  const x0 = -500, y0 = -300, x1 = 3700, y1 = 2100, cs = 8, nx = Math.round((x1 - x0) / cs), ny = Math.round((y1 - y0) / cs);
  const c = document.createElement('canvas'); c.width = nx; c.height = ny; const g = c.getContext('2d');
  const img = g.createImageData(nx, ny); for (let i = 0; i < nx * ny; i++) { img.data[i * 4] = 0; img.data[i * 4 + 1] = 0; img.data[i * 4 + 2] = 0; }
  const h2 = (i, j) => hash(i * 12.9898 + j * 78.233);
  const vn2 = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return lerp(lerp(h2(i, j), h2(i + 1, j), u), lerp(h2(i, j + 1), h2(i + 1, j + 1), u), v); };
  const a = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const wx = x0 + (i + .5) * cs, wy = y0 + (j + .5) * cs;
    const dist = Math.hypot(wx - SUN.x, (wy - SUN.y) * 1.15) / 3900;
    const n = vn2(wx / 420, wy / 420) * .56 + vn2(wx / 150 + 7, wy / 150 + 3) * .28 + vn2(wx / 60 + 1, wy / 60 + 9) * .11 + vn2(wx / 24 + 5, wy / 24 + 2) * .05;
    a[j * nx + i] = dist * .78 + (n - .5) * .5;
  }
  return { c, g, img, a, x0, y0, x1, y1 };
})();

// ——— background: white-wax rain, the puddle, ripples ———
const pudFill = (L, t) => fill(L, PUD, { col: K.sky, p: .95, gap: 10, w: 12, over: 9, seed: 301, ang: .18, draw: eio(pr(t, T.pud0, T.ripple)), boil: 0, cross: t >= T.ripple, crossP: .6 });
function drawBG(t) {
  clear(WAX); clear(BG.f); clear(BG.l);
  for (let i = 0; i < STREAKS.length; i++) { const s = STREAKS[i]; line(WAX, [[s.x, s.y], [s.x - s.L * .36, s.y + s.L]], { col: K.white, w: 7, p: 1.0, seed: 500 + i, boil: 0, streak: 1 }); }
  if (t >= T.pud0) pudFill(BG.f, t);
  if (t >= T.pud0) line(BG.l, PUD, { w: 5, p: .7, seed: 302, draw: pr(t, T.pud0, T.ripple), boil: .6 });
  if (t >= T.ripple) {
    const rp = [[1150, 1335, 70], [1830, 1338, 80], [1080, 1420, 55], [1950, 1430, 60]];
    rp.forEach(([x, y, w], i) => line(BG.l, [[x - w, y], [x - w * .3, y - 9], [x + w * .3, y - 9], [x + w, y]], { w: 5, p: .8, seed: 310 + i, draw: pr(t, T.ripple + i * .06, T.ripple + i * .06 + .3), boil: .6 }));
  }
}

// ——— front water: the strip that sits in front of the boat's lower hull ———
const storm = t => t < T.wash ? 0 : t < T.rock3 ? pr(t, T.wash, T.sink) : t < T.sun ? lerp(1, .4, pr(t, T.rock3, T.sun)) : lerp(.4, 0, pr(t, T.sun, T.pull));
function frontPoly(t, bx) {
  const tq = q12(t), pts = [], x0 = bx - 430, x1 = bx + 430;
  const amp = 7 + 15 * storm(t);
  for (let i = 0; i <= 30; i++) { const x = lerp(x0, x1, i / 30); pts.push([x, BOAT0.y - 18 + Math.sin(x / 48 + tq * (5 + 6 * storm(t))) * amp]); }
  pts.push([x1, BOAT0.y + 110], [x0, BOAT0.y + 110]);
  return pts;
}
function drawFront(t, bx) {
  clear(FRONT.f); clear(FRONT.l);
  if (t < T.pud0) return null;
  const poly = frontPoly(t, bx), top = poly.slice(4, 27);
  const d = eio(pr(t, T.pud0, T.ripple));
  // the same puddle hatching (same seed, same rows), kept only in front of the hull: seamless with the puddle behind
  pudFill(FRONT.f, t);
  const g = FRONT.f.g; g.save(); g.globalCompositeOperation = 'destination-in'; g.beginPath(); poly.forEach(([x, y], i) => i ? g.lineTo(sx(x), sy(y)) : g.moveTo(sx(x), sy(y))); g.closePath(); g.fill(); g.restore();
  line(FRONT.l, top, { w: 6, p: .9, seed: 321, draw: d, taper: .2 });
  return poly;
}

// ——— rain dashes (blue and white crayon, falling on twos) ———
function rainAmt(t) {
  if (t < T.wash) return 0;
  if (t < T.rock3) return pr(t, T.wash, T.wash + .25);
  if (t < T.silence) return lerp(1, .3, pr(t, T.rock3, T.silence));
  if (t < T.sun) return .3;
  return lerp(.3, 0, pr(t, T.sun, T.sunface));
}
function drawRain(t) {
  clear(RAIN);
  const a = rainAmt(t); if (a <= 0) return;
  const tq = q12(t);
  for (let i = 0; i < 170; i++) {
    if (hash(i * 7.7 + .3) > a) continue;
    const x0 = hash(i * 1.9 + .1) * 3800 - 300, ph = hash(i * 3.1 + .5) * 1900;
    const y = ((ph + tq * 2100) % 1900) - 100, x = x0 - (y + 100) * .36;
    const Lr = 60 + hash(i) * 40;
    line(RAIN, [[x, y], [x - Lr * .36, y + Lr]], { col: hash(i * 5.3) > .3 ? K.sky : K.white, w: 5, p: 1, seed: 700 + i, streak: 0, taper: .4 });
  }
}

// ——— teardrops (drawn in the storm, coloured in by the sun) ———
function dropPoly(d, s = 1) {
  const pts = []; const n = 26;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + i / n * Math.PI * 2; const r = 1; let x = Math.cos(a) * 42 * s, y = Math.sin(a) * 42 * s + 14 * s; if (Math.sin(a) < -.2) { const k = (-Math.sin(a) - .2) / .8; x *= 1 - k * .85; y -= k * 48 * s; } pts.push([d.x + x, d.y + y]); }
  return pts;
}
function drawDrops(t) {
  clearGroup(DR);
  for (const d of DROPS) {
    const tc = T['drop' + d.i]; if (t < tc) continue;
    const pop = back(pr(t, tc, tc + .125), 2.4);
    const bobY = Math.sin(q12(t) * 3 + d.i) * 5;
    const dd = { x: d.x, y: d.y + bobY };
    const poly = dropPoly(dd, pop);
    knock(DR, poly);
    const tcol = T['col' + d.i];
    if (t >= tcol) fill(DR.f, poly, { col: RB[d.i], p: 1.05, gap: 6, w: 8, over: 4, seed: 600 + d.i, ang: .5, draw: eo(pr(t, tcol, tcol + .3)) });
    else fill(DR.f, poly, { col: K.sky, p: .45, gap: 9, w: 7, over: 2, seed: 610 + d.i, ang: .5 });
    line(DR.l, poly, { w: 5.5, seed: 620 + d.i, closed: true });
    if (t >= tcol + .3) {   // coloured drops wake up
      for (const s of [-1, 1]) dab(DR.l, dd.x + s * 13, dd.y + 12, 5.5, { col: K.ink, p: 1.1, seed: 630 + d.i + s, gap: 3, w: 4 });
      line(DR.l, [[dd.x - 11, dd.y + 30], [dd.x, dd.y + 37], [dd.x + 11, dd.y + 30]], { w: 4.5, seed: 640 + d.i });
    }
  }
}

// ——— the sun ———
const SUNP = handCircle(SUN.x, SUN.y, SUN.r, 77, 0.06, 64);
function sunFillD(t) { return clamp(pr(t, T.sun, T.sunface - .04)); }
function drawSun(t) {
  clearGroup(SUNG);
  if (t < T.sun) return null;
  const d = sunFillD(t);
  if (d >= 1) knock(SUNG, SUNP);
  // the colouring is the action: zig-zag rows, then a second pass
  const tip = fill(SUNG.f, SUNP, { col: K.yellow, p: 1.05, gap: 13, w: 16, over: 10, seed: 801, ang: .5, draw: d });
  if (d >= 1) fill(SUNG.f, SUNP, { col: K.orange, p: .55, gap: 18, w: 10, over: 6, seed: 802, ang: 2.1 });
  if (t >= T.sunface) {
    line(SUNG.l, [...SUNP], { col: K.orange, w: 7, seed: 803, draw: pr(t, T.sunface, T.sunface + .3) });
    // rays, drawn one after another (on the beat and its "and")
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + i / 12 * Math.PI * 2, t0 = T.sunface + i * .055;
      if (t < t0) break;
      const r0 = SUN.r + 32, r1 = SUN.r + 105 + (i % 2) * 30;
      line(SUNG.l, [[SUN.x + Math.cos(a) * r0, SUN.y + Math.sin(a) * r0], [SUN.x + Math.cos(a) * r1, SUN.y + Math.sin(a) * r1]], { col: K.orange, w: 9, p: 1.05, seed: 810 + i, draw: pr(t, t0, t0 + .12) });
    }
    // face: closed happy eyes + a big smile + cheeks
    const P = (x, y) => [SUN.x + x, SUN.y + y];
    for (const s of [-1, 1]) {
      line(SUNG.l, [P(s * 55 - 22, -18), P(s * 55, -40), P(s * 55 + 22, -18)], { w: 7, seed: 830 + s });
      dab(SUNG.f, SUN.x + s * 100, SUN.y + 30, 24, { col: K.pink, p: .9, seed: 835 + s });
    }
    line(SUNG.l, [P(-55, 30), P(-25, 62), P(25, 62), P(55, 30)], { w: 7.5, seed: 840 });
  }
  return tip;
}

// ——— rainbow: one crayon per band, drawn left to right ———
function arc(r) { const pts = []; for (let i = 0; i <= 60; i++) { const a = Math.PI + i / 60 * Math.PI; pts.push([RBC.x + Math.cos(a) * r, RBC.y + Math.sin(a) * r]); } return pts; }
const BAND_D = .5;
function drawRainbow(t) {
  clear(RBL); const heads = [];
  for (let i = 0; i < 6; i++) {
    const t0 = T['band' + i]; if (t < t0) continue;
    const d = eo(pr(t, t0, t0 + BAND_D)), r = RBC.r0 - i * RBC.dr;
    let h;
    for (const [k, off, pp] of [[0, -14, .95], [1, 0, 1.08], [2, 14, .9]]) {
      const hh = line(RBL, arc(r + off), { col: RB[i], w: 19, p: pp, seed: 900 + i * 7 + k, draw: d, streak: 2, boil: .8 });
      if (k === 1) h = hh;
    }
    if (d < 1 && h) heads.push([h, i, d]);
  }
  return heads;
}

// ——— the end page ———
// 完 is crayon, not type: the glyph is only a mask. The yellow crayon that was just set down colours it in row by row
// (zig-zag hatching, A = pressure, so wax only takes on the tooth), overshooting a little; then the indigo outline goes over it.
const WAN = { x: 960, y: 690, size: 400 };
function glyph(g, x, y, size, seed) {   // the same hand-placed transform as crayon.text(): tilted, boiling on twos
  const st = BOIL.step, ba = BOIL.amp;
  g.font = `400 ${size}px "ZCOOL KuaiLe"`; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  const jx = (hash(seed + st * 1.1) - .5) * 1.4 * ba, jy = (hash(seed + st * 2.3) - .5) * 1.4 * ba;
  g.translate(x + jx, y + jy); g.rotate((hash(seed * 1.9) - .5) * 0.07 + (hash(seed + st * .7) - .5) * 0.02 * ba);
}
function drawPageB(t) {
  clear(PB); clear(PBL);
  CAM.x = 960; CAM.y = 540; CAM.s = 1;
  const u = pr(t, T.land - 1 / 12, T.wan);   // the first rows are already on the page when it lands
  if (u <= 0 || t < T.land) return u;
  const s = WAN.size, top = WAN.y - s * .95, bot = WAN.y + s * .2;
  // mask: the glyph, dilated a little (colouring spills past the line)
  const M = SCR; clear(M); { const g = M.g; g.save(); glyph(g, WAN.x, WAN.y, s, 951); g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 9; g.lineJoin = 'round'; g.fillText('完', 0, 0); g.strokeText('完', 0, 0); g.restore(); }
  // yellow hatching over the glyph's box, rows top → bottom; the cross pass lands on the "written" beat
  const F = SCR2; clear(F);
  const box = [[WAN.x - s * .6, top], [WAN.x + s * .6, top], [WAN.x + s * .6, bot], [WAN.x - s * .6, bot]];
  fill(F, box, { col: K.yellow, p: 1.2, gap: 7.5, w: 10, over: 0, seed: 952, ang: .14, draw: u, cross: u >= 1, crossP: .65, crossAng: 1.1 });
  if (u >= 1) fill(F, box, { col: K.orange, p: .45, gap: 15, w: 8, over: 0, seed: 953, ang: 2.0 });   // a light warm second pass on the "written" beat gives it body
  F.g.save(); F.g.globalCompositeOperation = 'destination-in'; F.g.drawImage(M.c, 0, 0); F.g.restore();
  PB.g.drawImage(F.c, 0, 0);
  // indigo outline over the colour (crayon pressure ~0.9 → speckled on the tooth), revealed with the colouring
  // its own pressure layer (pure indigo RGB, A = pressure), so it is not mixed into the yellow; two slightly offset passes = a hand going round twice
  const O = PBL; { const g = O.g; g.save(); glyph(g, WAN.x, WAN.y, s, 951); g.strokeStyle = K.ink; g.lineJoin = 'round';
    g.globalAlpha = .42; g.lineWidth = 10; g.strokeText('完', 0, 0);
    g.globalAlpha = .34; g.lineWidth = 6; g.strokeText('完', 1.6, -1.2);
    g.globalAlpha = .3; g.lineWidth = 3.5; g.strokeText('完', -.8, .9); g.restore(); }
  { const g = O.g, yC = lerp(top - 40, bot + 60, ss(u)); g.save(); g.globalCompositeOperation = 'destination-in'; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, yC - 90); g.lineTo(0, yC + 90); g.closePath(); g.fill(); g.restore(); }
  return u;
}

// ——— frame ———
const ov = () => document.getElementById('ov');
const glc = () => document.getElementById('gl');
const OVC = { a: null, b: null };
function snap() { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(glc(), 0, 0); return c; }

function drawPage(comp, t, camOverride) {
  const [cx, cy, s] = camOverride || cam(t); CAM.x = cx; CAM.y = cy; CAM.s = s;
  BOIL.amp = (t >= T.silence && t < T.sun) ? 0.5 : 1;
  drawBG(t); drawClouds(t); washBands(WASH, t);
  // the white wax is on the page from frame one but only shows where the wash lies on it: outside the wash it holds the tooth
  // with zero visible difference (no lift, no emboss change), so it is masked by the wash density (×3 so a full wash keeps full wax)
  { clear(WMASK); if (t >= T.wash) for (let k = 0; k < 3; k++) WMASK.g.drawImage(WASH.c, 0, 0);
    const g = WAX.g; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(WMASK.c, 0, 0); g.restore(); }
  const bp = boatPose(t);
  const dHull = pr(t, T.hull, T.sail - .02), dSail = pr(t, T.sail, T.flag - .02), dMast = pr(t, T.flag, T.flag + .33);
  const fHull = eio(pr(t, T.flag, T.eyes)), fSail = eio(pr(t, T.flag + .17, T.eyes));
  const B = drawBoat(t, { ...bp, dHull, dSail, dMast, fHull, fSail, fFlag: pr(t, T.flag + .33, T.eyes) });
  const fp = drawFront(t, bp.x);
  drawRain(t);
  const sunTip = drawSun(t);
  drawDrops(t);
  const heads = drawRainbow(t);
  // tools
  clearGroup(TOOL);
  const k = Math.pow(CAM.s, .6) * .78;
  if (t < T.eyes) {   // the indigo crayon drawing the boat, lifting away at the end
    let head = null;
    const hullS = xf(HULL, { x: bp.x, y: bp.y, r: bp.rot }), sailS = xf(SAIL, { x: bp.x, y: bp.y, r: bp.rot });
    const tmp = SCR; clear(tmp);
    if (t < T.sail) head = line(tmp, [...hullS, hullS[1]], { w: 1, draw: dHull, taper: .08, seed: 99 });
    else if (t < T.flag) head = line(tmp, [...sailS, sailS[1]], { w: 1, draw: dSail, taper: .1, seed: 98 });
    else { const m = xf([[0, -418], [0, -505], [64, -482], [0, -458]], { x: bp.x, y: bp.y, r: bp.rot }); head = line(tmp, m, { w: 1, draw: clamp(dMast), seed: 97 }); }
    if (!head) head = [sx(hullS[0][0]), sy(hullS[0][1])];   // frame 0: the tip touching down
    if (head) { const lift = ei(pr(t, T.flag + .36, T.eyes)); stick(TOOL, head[0] + lift * 700, head[1] - lift * 900, -0.95, K.ink, k, 3); }
  }
  if (t >= T.sun - .001 && t < T.pull) {   // the yellow crayon colouring the sun, then drawing rays, then leaving
    let X, Y;
    if (t < T.sunface && sunTip) { [X, Y] = sunTip; const fly = 1 - eo(pr(t, T.sun, T.sun + .1)); X += fly * 900; Y -= fly * 700; }
    else { const a = -Math.PI / 2 + clamp((t - T.sunface) / (12 * .055)) * Math.PI * 2 * 11 / 12, r = SUN.r + 120; X = sx(SUN.x + Math.cos(a) * r); Y = sy(SUN.y + Math.sin(a) * r); }
    const lift = ei(pr(t, T.ray + .2, T.pull)); stick(TOOL, X + lift * 600, Y - lift * 800, -0.9, K.yellow, k, 5);
  }
  for (const d of DROPS) {   // a little crayon for each drop
    const tc = T['col' + d.i]; if (t < tc || t >= tc + .5) continue;
    const u = pr(t, tc, tc + .3), lift = ei(pr(t, tc + .3, tc + .5));
    const X = sx(d.x + Math.sin(u * 28) * 22), Y = sy(d.y + lerp(-20, 30, u)) - lift * 500;
    stick(TOOL, X, Y, -1.05, RB[d.i], k * .8, 20 + d.i);
  }
  for (const [h, i, d] of heads) stick(TOOL, h[0], h[1], -1.2, RB[i], k * .85, 40 + i);

  // the front-water strip gets the same wash where the storm is
  clear(WF);
  if (fp && t >= T.wash) { WF.g.drawImage(WASH.c, 0, 0); WF.g.save(); WF.g.globalCompositeOperation = 'destination-in'; WF.g.beginPath(); fp.forEach(([x, y], i) => i ? WF.g.lineTo(sx(x), sy(y)) : WF.g.moveTo(sx(x), sy(y))); WF.g.closePath(); WF.g.fill(); WF.g.restore(); }

  // composite
  comp.paperCam(CAM.x * 0.6, CAM.y * 0.6, CAM.s / 0.6);
  comp.begin(PAPER);
  comp.crayon(WAX.c, { soft: .05 });
  comp.crayon(BG.f.c); comp.crayon(BG.l.c);
  comp.group(CL);
  if (t >= T.wash) comp.wash(WASH.c, { color: WASH_T, resist: .93, edge: 1.5, gran: .6 });
  comp.group(SUNG); comp.group(DR);
  comp.crayon(RBL.c);
  comp.group(BOAT);
  comp.crayon(FRONT.f.c); comp.crayon(FRONT.l.c);
  if (fp && t >= T.wash) comp.wash(WF.c, { color: WASH_T, resist: .93, edge: 1.2, gran: .6 });
  comp.crayon(RAIN.c);
  comp.group(TOOL);
}

// yellow crayon set down on the new page
function drawEndPage(comp, t) {
  drawPageB(t);
  clearGroup(TOOL);
  const fall = 1 - ei(pr(t, T.land - .17, T.land)), bounce = t > T.land ? Math.sin(pr(t, T.land, T.land + .25) * Math.PI) * 18 : 0;
  CAM.x = 960; CAM.y = 540; CAM.s = 1;
  if (t >= T.land - .17) stick(TOOL, 1330 + fall * 160, 860 - fall * 1100 - bounce, -0.32 + fall * .5, K.yellow, .95, 7);
  comp.paperCam(4100, 700, 1); comp.begin(PAPER);
  comp.crayon(PB.c, { soft: .06 }); comp.crayon(PBL.c, { soft: .06 });
  comp.group(TOOL);
}

// page turn: the bottom-right corner is peeled up and carried over to the top left.
// Fold line = perpendicular bisector of the corner and where it is carried; the flap is the page's back, mirrored over the fold.
function halfPlane(poly, M, n, keepPos) {   // Sutherland–Hodgman against (X-M)·n ≥ 0 (keepPos) or ≤ 0
  const side = P => ((P[0] - M[0]) * n[0] + (P[1] - M[1]) * n[1]) * (keepPos ? 1 : -1);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length], sa = side(A), sb = side(B);
    if (sa >= 0) out.push(A);
    if ((sa >= 0) !== (sb >= 0)) { const k = sa / (sa - sb); out.push([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k]); }
  }
  return out;
}
const pathOf = (g, P) => { g.beginPath(); P.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
function turnOverlay(t) {
  const c = ov(); const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  g.drawImage(OVC.b, 0, 0);
  const u = pr(t, T.lift, T.land), e = Math.pow(u, 1.7);
  const C = [W, H], D = [W - 2.35 * W * e, H - 1.2 * H * e - Math.sin(Math.PI * e) * .22 * H];
  if (Math.hypot(C[0] - D[0], C[1] - D[1]) < 2) { g.drawImage(OVC.a, 0, 0); return; }
  const M = [(C[0] + D[0]) / 2, (C[1] + D[1]) / 2], L = Math.hypot(C[0] - D[0], C[1] - D[1]), n = [(C[0] - D[0]) / L, (C[1] - D[1]) / L];
  const R = [[0, 0], [W, 0], [W, H], [0, H]];
  const keep = halfPlane(R, M, n, false), lifted = halfPlane(R, M, n, true);
  const refl = P => { const d = (P[0] - M[0]) * n[0] + (P[1] - M[1]) * n[1]; return [P[0] - 2 * d * n[0], P[1] - 2 * d * n[1]]; };
  // shadow on the next page beside the fold
  const sa = .34 * Math.sin(Math.PI * Math.min(1, u * 1.1));
  { const g0 = [M[0], M[1]], g1 = [M[0] + n[0] * 260, M[1] + n[1] * 260]; const gr = g.createLinearGradient(...g0, ...g1); gr.addColorStop(0, `rgba(45,35,25,${sa})`); gr.addColorStop(1, 'rgba(45,35,25,0)'); g.save(); pathOf(g, lifted); g.clip(); g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore(); }
  // the part of this page still lying flat (a little darker as it bends up near the fold)
  if (keep.length > 2) {
    g.save(); pathOf(g, keep); g.clip(); g.drawImage(OVC.a, 0, 0);
    const gr = g.createLinearGradient(M[0] - n[0] * 140, M[1] - n[1] * 140, M[0], M[1]); gr.addColorStop(0, 'rgba(50,38,28,0)'); gr.addColorStop(1, 'rgba(50,38,28,0.22)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.restore();
  }
  // the flap: the back of the page (bare paper, the picture faintly showing through, mirrored)
  const flap = lifted.map(refl);
  if (flap.length > 2) {
    g.save(); pathOf(g, flap); g.clip();
    g.fillStyle = '#efe8da'; g.fillRect(0, 0, W, H);
    // show-through: the page's own picture mirrored across the fold, very faint
    const a = Math.atan2(n[1], n[0]);
    g.save(); g.globalAlpha = .1; g.translate(M[0], M[1]); g.rotate(a); g.scale(-1, 1); g.rotate(-a); g.translate(-M[0], -M[1]); g.drawImage(OVC.a, 0, 0); g.restore();
    const gr = g.createLinearGradient(M[0], M[1], M[0] - n[0] * 420, M[1] - n[1] * 420);
    gr.addColorStop(0, 'rgba(60,45,30,0.30)'); gr.addColorStop(.25, 'rgba(255,250,240,0.10)'); gr.addColorStop(1, 'rgba(60,45,30,0.10)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.restore();
    g.save(); pathOf(g, flap); g.strokeStyle = 'rgba(70,55,40,0.35)'; g.lineWidth = 1.5; g.stroke(); g.restore();
  }
}

export function frame(comp, t) {
  const o = ov();
  if (t < T.lift) { o.style.display = 'none'; drawPage(comp, t); comp.finish({ vig: .3, emb: .55 }); return; }
  if (t >= T.land) { o.style.display = 'none'; drawEndPage(comp, t); comp.finish({ vig: .3, emb: .55 }); return; }
  // page turn: snapshot this page and the next one, then turn the first over the second
  drawPage(comp, t); comp.finish({ vig: .3, emb: .55 }); OVC.a = snap();
  drawEndPage(comp, t); comp.finish({ vig: .3, emb: .55 }); OVC.b = snap();
  o.style.display = 'block'; turnOverlay(t);
}

// ——— events for the mixer (and for cuecheck: every entry with `cue` is a visual hit on the grid) ———
export const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(6), type, ...o });
function sp(wx, wy, c) { CAM.x = c[0]; CAM.y = c[1]; CAM.s = c[2]; return pan(sx(wx)); }
{
  const c = t => cam(t);
  ev(T.hull, 'scratch', { cue: 'hull', dur: T.sail - T.hull, speed: .9, pan: 0 });
  ev(T.sail, 'scratch', { cue: 'sail', dur: T.flag - T.sail, speed: .8, pan: 0 });
  ev(T.flag, 'scratch', { cue: 'flag', dur: .33, speed: .6, pan: .05 });
  ev(T.flag, 'scribble', { dur: T.eyes - T.flag, pan: -.1, heavy: .6 });
  ev(T.eyes, 'pop', { cue: 'eyes', pan: 0 });
  ['pud0', 'pud1', 'pud2', 'pud3'].forEach((k, i) => ev(T[k], 'swish', { cue: k, dur: .3, pan: -.5 + i * .33, v: .8 }));
  ev(T.ripple, 'scratch', { cue: 'ripple', dur: .45, speed: .5, pan: .2 });
  CLOUDS.forEach((cl, i) => ev(cl.t, 'scribble', { cue: 'cloud' + i, dur: .42, pan: sp(cl.x, cl.y, c(cl.t + .3)), heavy: 1 }));
  ev(T.frown, 'scratch', { cue: 'frown', dur: .25, speed: .7, pan: 0 });
  ev(T.wash, 'brush', { cue: 'wash', dur: 1.15, pan0: -.8, pan1: .8 });
  ev(T.wash, 'thunder', { v: .9 });
  ev(T.wash, 'rain', { t1: T.sunface, keys: [[T.wash, 0], [T.wash + .4, 1], [T.rock3, 1], [T.silence, .03], [T.sun, .02], [T.sunface, 0]] });
  DROPS.forEach(d => ev(T['drop' + d.i], 'plink', { cue: 'drop' + d.i, pan: sp(d.x, d.y, c(T['drop' + d.i])) }));
  ['rock0', 'rock1', 'rock2', 'rock3'].forEach((k, i) => ev(T[k], 'creak', { cue: k, pan: (i % 2 ? -.2 : .2), v: .6 + i * .1 }));
  ev(T.sink, 'splash', { cue: 'sink', pan: 0 });
  ev(T.drip, 'drip', { cue: 'drip', pan: .1 });
  ev(T.lookup, 'blink', { cue: 'lookup', pan: 0 });
  ev(T.sun, 'zip', { cue: 'sun', pan: .6 });
  ['sun', 'sw0', 'sw1', 'sw2'].forEach((k, i) => ev(T[k], 'swish', { cue: k === 'sun' ? undefined : k, dur: .3, pan: .1 * (i % 2 ? 1 : -1), v: 1.1, heavy: 1 }));
  ev(T.sunface, 'pop', { cue: 'sunface', pan: 0, v: 1 });
  ev(T.ray, 'scratch', { cue: 'ray', dur: .5, speed: 1, pan: 0 });
  ev(T.sunface, 'rise', { pan: -.4 });
  ev(T.pull, 'birds', { cue: 'pull', t1: DUR });
  DROPS.forEach(d => ev(T['col' + d.i], 'tick', { cue: 'col' + d.i, pan: sp(d.x, d.y, c(T['col' + d.i])), dur: .3 }));
  for (let i = 0; i < 6; i++) ev(T['band' + i], 'swipe', { cue: 'band' + i, dur: BAND_D, pan0: -.6, pan1: .6 });
  ev(T.sailaway, 'paddle', { cue: 'sailaway', t1: T.lift });
  ev(T.under, 'puff', { cue: 'under', pan: .1 });
  ev(T.lift, 'lift', { cue: 'lift', pan: .6 });
  ev(T.lift + (T.land - T.lift) * .45, 'whoosh', { dur: .5, pan: -.2 });
  ev(T.land, 'flap', { cue: 'land', pan: -.3 });
  ev(T.land, 'setdown', { pan: .3 });
  ev(T.land, 'write', { dur: T.wan - T.land, pan: 0 });
  ev(T.wan, 'written', { cue: 'wan' });
}
// texts on screen (for readcheck)
export function TEXTS(t) {
  if (t < T.land) return [];
  const s = WAN.size; return [{ id: 'wan', text: '完', x0: WAN.x - s / 2, y0: WAN.y - s * .9, x1: WAN.x + s / 2, y1: WAN.y + s * .2 }];
}
