// 《三个正方形》 Three Squares: the whole film as data. Every stroke with its time, the 25 cells and their paths,
// the one wipe, the wet streak, the camera, the texts for readcheck and the sound events.
// World units = the board's slate (x 0…6400, y 0…1700, two fixed panels, seam at x 3200).
// The proof lives on the left panel in "math" units (1 unit = one cell, U board units; y up), the conclusion on the right.
import { clamp, lerp, eio } from '/core/lib.js';
import { Stroke, catmull, arc } from './chalk.js';
import { writeChar, writeLatin, latinWidth } from './hand.js';
import { BPM, FPS, tq, B, DUR } from './timeline.js';

export const U = 130;                                 // one cell, board units
const O = [1890, 1045];                               // the right angle
const M = (x, y) => [O[0] + U * x, O[1] - U * y];      // math → board
const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };

export function build(W = 1920, H = 1080) {
  const S = [], TX = [], EV = [], T = {};
  const add = (arr, wiped = true) => { arr.forEach(s => { s.wiped = wiped; S.push(s); }); return arr; };
  const text = (id, txt, strokes, t1 = 1e9, pad = 8) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of strokes) for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    TX.push({ id, text: txt, box: [x0 - pad, y0 - pad, x1 + pad, y1 + pad], t0: strokes[0].t0, t1 });
  };
  // a chalk line through board points (a slight bow on every straight run), starting on beat b
  const bowed = (pts, k = .006) => { const o = [pts[0]]; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], c = pts[i], L = Math.hypot(c[0] - a[0], c[1] - a[1]), nx = -(c[1] - a[1]) / L, ny = (c[0] - a[0]) / L, sg = i % 2 ? 1 : -1; o.push([(a[0] + c[0]) / 2 + nx * L * k * sg, (a[1] + c[1]) / 2 + ny * L * k * sg], c); } return o; };
  const ln = (pts, b, d, o = {}) => { const s = new Stroke(o.curve ? catmull(pts, 10) : bowed(pts), { kind: 'write', w: 8, taper: .15, taperLen: .15, land: .7, skip: .12, endSpecks: true, specks: .6, ...o }); s.t0 = typeof b === 'number' && o.sec ? b : tq(b); s.t1 = s.t0 + d; return s; };

  // ───────── A · the triangle: a (vertical), b (horizontal), c (hypotenuse); the right-angle mark; a b c
  add([ln([M(0, 3), M(0, 0)], B.legA, .40, { w: 9 })]);
  add([ln([M(0, 0), M(4, 0)], B.legB, .44, { w: 9 })]);
  add([ln([M(4, 0), M(0, 3)], B.hyp, .50, { w: 9 })]);
  add([ln([M(0, .4), M(.4, .4), M(.4, 0)], B.rightAngle, .18, { w: 5.5 })]);
  const lab = (ch, x, y, b, seed) => { const st = add(writeLatin(ch, M(x, y)[0], M(x, y)[1], 74, tq(b), { seed, lspeed: 30 })); text('lab-' + ch, ch, st, tq(B.wipe0) + .15); return st; };
  lab('a', .32, 1.25, B.labA, 3); lab('b', 2.55, .2, B.labB, 4); lab('c', 1.55, 1.0, B.labC, 5);

  // ───────── B · three squares grow out of the sides; a² and b² are filled with the orange chalk (the tracked part: area)
  add([ln([M(0, 3), M(-3, 3), M(-3, 0), M(0, 0)], B.sqA, .50)]);
  add([ln([M(0, 0), M(0, -4), M(4, -4), M(4, 0)], B.sqB, .52)]);
  add([ln([M(4, 0), M(7, 4), M(3, 7), M(0, 3)], B.sqC, .80)]);
  const SQ = { A: [M(-3, 3), M(0, 0)], B: [M(0, 0), M(4, -4)] };      // board rects [top-left, bottom-right]
  const fill = (key, y0, y1, rows, b, d, seed) => {
    const [[x0], [x1]] = SQ[key], cx = (x0 + x1) / 2, amp = (x1 - x0) / 2 + 26, L = y1 - y0;   // turns fall outside the square (clipped)
    const p = [[cx - amp * .2, y0]];
    for (let i = 0; i <= rows; i++) p.push([cx + (i % 2 ? amp : -amp), y0 + L * i / rows]);
    const s = new Stroke(catmull(p, 6), { kind: 'side', w: 30, color: 'orange', wob: 2, skip: .05, press: 1.05, sideLo: .75, specks: .4, seed });
    s.t0 = tq(b); s.t1 = s.t0 + d; s.fill = key; return s;
  };
  const yA = [M(0, 3)[1] - 14, M(0, 0)[1] + 14], yB = [M(0, 0)[1] - 14, M(0, -4)[1] + 14];
  add([fill('A', yA[0], yA[1], 12, B.fillA, .52, 41)]);
  add([fill('B', yB[0], (yB[0] + yB[1]) / 2 + 20, 9, B.fillB1, .32, 42), fill('B', (yB[0] + yB[1]) / 2 - 10, yB[1], 9, B.fillB2, .32, 43)]);

  // ───────── C · white lines crack the two orange squares into cells (pairs, on sixteenths)
  const crackA = [[M(-2, 3), M(-2, 0)], [M(-1, 3), M(-1, 0)], [M(-3, 2), M(0, 2)], [M(-3, 1), M(0, 1)]];
  const crackB = [[M(1, 0), M(1, -4)], [M(2, 0), M(2, -4)], [M(3, 0), M(3, -4)], [M(0, -1), M(4, -1)], [M(0, -2), M(4, -2)], [M(0, -3), M(4, -3)]];
  B.crack.forEach((b, i) => {
    if (crackA[i]) add([ln(crackA[i], b, .13, { w: 5.5, taper: .25 })]);
    add([ln(crackB[i], b, .15, { w: 5.5, taper: .25 })]);
  });
  T.cells = tq(B.crack[B.crack.length - 1]) + .16;

  // two chalk paths from the small squares into the big one, each with a small arrowhead
  const bez = (P, u) => { const v = 1 - u; return [0, 1].map(j => v * v * v * P[0][j] + 3 * v * v * u * P[1][j] + 3 * v * u * u * P[2][j] + u * u * u * P[3][j]); };
  const PATH = { A: [M(-1.5, 3.3), M(-1.5, 5.7), M(.2, 6.5), M(1.9, 4.9)], B: [M(4.35, -2), M(6.6, -2.2), M(7.8, 1.0), M(5.1, 2.4)] };
  for (const k of ['A', 'B']) {
    const pts = []; for (let i = 0; i <= 24; i++) pts.push(bez(PATH[k], .03 + .74 * i / 24));
    const st = new Stroke(catmull(pts, 3), { kind: 'write', w: 6, taper: .1, taperLen: .1, land: .6, skip: .1, endSpecks: true, specks: .5, seed: k === 'A' ? 61 : 62 });
    st.t0 = tq(B.paths); st.t1 = st.t0 + .4;
    const e = bez(PATH[k], .77), q = bez(PATH[k], .72), a = Math.atan2(e[1] - q[1], e[0] - q[0]), L = 44;
    const hd = new Stroke([[e[0] + Math.cos(a + 2.55) * L, e[1] + Math.sin(a + 2.55) * L], e, [e[0] + Math.cos(a - 2.55) * L, e[1] + Math.sin(a - 2.55) * L]], { kind: 'write', w: 6, taper: .2, wob: .3, seed: k === 'A' ? 63 : 64 });
    hd.t0 = st.t1 + .02; hd.t1 = hd.t0 + .1;
    add([st, hd]);
  }

  // ───────── the 25 cells: a² (9) and b² (16) → the 5 × 5 square on the hypotenuse, spiralling in to the centre
  const Qb = M(4, 0), e1 = [-.8 * U, -.6 * U], e2 = [.6 * U, -.8 * U];      // c²'s axes on the board
  const slot = (i, j) => [Qb[0] + (i + .5) * e1[0] + (j + .5) * e2[0], Qb[1] + (i + .5) * e1[1] + (j + .5) * e2[1]];
  let ANG = Math.atan2(e1[1], e1[0]); ANG = ((ANG % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); if (ANG > Math.PI / 4) ANG -= Math.PI / 2;   // the tilt of c², the shortest turn
  const spiral = []; { let x0 = 0, y0 = 0, x1 = 4, y1 = 4;
    while (x0 <= x1 && y0 <= y1) {
      for (let j = y1; j >= y0; j--) spiral.push([x0, j]); x0++;
      for (let i = x0; i <= x1; i++) spiral.push([i, y0]); y0++;
      if (x0 <= x1) { for (let j = y0; j <= y1; j++) spiral.push([x1, j]); x1--; }
      if (y0 <= y1) { for (let i = x1; i >= x0; i--) spiral.push([i, y1]); y1--; }
    } }
  // sources, nearest to their path first; the last cell of a² is kept for the peak
  const near = (k, list) => list.sort((p, q) => Math.hypot(p[0] - PATH[k][0][0], p[1] - PATH[k][0][1]) - Math.hypot(q[0] - PATH[k][0][0], q[1] - PATH[k][0][1]));
  const srcA = [], srcB = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) srcA.push(M(-2.5 + i, .5 + j));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) srcB.push(M(.5 + i, -3.5 + j));
  near('A', srcA); near('B', srcB);
  const lastSrc = srcA.splice(srcA.length - 1, 1)[0];
  const order = []; { let a = 0, b = 0; for (let k = 0; k < 24; k++) { if ((a + 1) / 8 <= (b + 1) / 16 && a < 8) order.push(['A', srcA[a++]]); else order.push(['B', srcB[b++]]); } }
  order.push(['A', lastSrc]);
  const CELLS = order.map(([from, src], k) => {
    const last = k === 24, beat = last ? B.peak : B.land[k];
    const travel = last ? B.peak - B.lastLift : k < 2 ? 1.25 : k < 6 ? 1 : k < 14 ? .85 : .7;
    return { k, from, src, dst: slot(...spiral[k]), path: PATH[from], ang: ANG, beat, ta: tq(beat), tl: tq(beat - travel), last };
  });
  // where a cell is at t: on its source, travelling along its path (lifted a little), or pressed into its slot
  const cellAt = (c, t) => {
    if (t < c.tl) return { x: c.src[0], y: c.src[1], a: 0, k: 1, moving: false, ghost: 0 };
    if (t >= c.ta) return { x: c.dst[0], y: c.dst[1], a: c.ang, k: 1, moving: false, ghost: 1 };
    const x = (t - c.tl) / (c.ta - c.tl);
    const along = (u, dst) => { const p = bez(c.path, u), w0 = (1 - u) * (1 - u), w1 = u * u;
      return [p[0] + w0 * (c.src[0] - c.path[0][0]) + w1 * (dst[0] - c.path[3][0]), p[1] + w0 * (c.src[1] - c.path[0][1]) + w1 * (dst[1] - c.path[3][1])]; };
    if (c.last) {        // glides out and slows to a stop at the door of c² (on clear slate), waits, then shoots into the centre on the beat
      const g = .62, h = .86, uH = .6, P0 = c.path[0];
      const at = u => { const p = bez(c.path, u * uH), w0 = (1 - u) * (1 - u); return [p[0] + w0 * (c.src[0] - P0[0]), p[1] + w0 * (c.src[1] - P0[1])]; };
      if (x < h) { const u = 1 - Math.pow(1 - clamp(x / g), 3), p = at(u); return { x: p[0], y: p[1], a: c.ang * .35 * u, k: 1 + .15 * ss(u * 1.6), moving: true, ghost: 1 }; }
      const d = Math.pow((x - h) / (1 - h), 2.2), p = at(1);
      return { x: lerp(p[0], c.dst[0], d), y: lerp(p[1], c.dst[1], d), a: lerp(c.ang * .35, c.ang, d), k: lerp(1.15, 1, d), moving: true, ghost: 1 };
    }
    const u = .75 * ss(x) + .25 * x, k = 1 + .13 * Math.sin(Math.PI * Math.min(1, x * 1.08)), p = along(u, c.dst);
    return { x: p[0], y: p[1], a: c.ang * ss((u - .2) / .65), k, moving: true, ghost: 1 };
  };

  // ───────── E · the conclusion on the right panel: a²+b²=c² (a², b² in the orange), the pupil's circle, the lesson's name
  const EQX = 4450, EQY = 760, CAP = 200, SUP = 112, SPC = CAP * .36;
  const glyphs = [['a', 'orange', 0, B.eqA], ['2', 'orange', 1, B.eqA + .25], ['+', 'white', 0, B.eqPlus], ['b', 'orange', 0, B.eqB], ['2', 'orange', 1, B.eqB + .25],
    ['=', 'white', 0, B.eqEq], ['c', 'white', 0, B.eqC], ['2', 'white', 1, B.eqC + .25]];
  const gw = g => latinWidth(g[0], g[2] ? SUP : CAP) + ('+='.includes(g[0]) ? 2 * SPC : 0);
  const EQW = glyphs.reduce((a, g) => a + gw(g), 0);
  let X = EQX - EQW / 2; const eq = [];
  for (const g of glyphs) {
    const cap = g[2] ? SUP : CAP, x = X + ('+='.includes(g[0]) ? SPC : 0) + (g[2] ? 6 : 0);
    const st = writeLatin(g[0], x, EQY - (g[2] ? CAP * .62 : 0), cap, tq(g[3]), { color: g[1], seed: 70 + eq.length, lspeed: 26, lw: g[2] ? .085 : .062 });
    eq.push(...st); X += gw(g);
  }
  add(eq, false); text('eq', 'a²+b²=c²', eq);
  const cir = arc(EQX + 10, EQY - CAP * .42, EQW / 2 + 150, -2.75, -2.75 + Math.PI * 2 + .55, { ry: CAP * .5 + 135, color: 'kid', w: 8.5, kind: 'write', taper: .3, land: .5, wob: 5, wav: 300, skip: .2, rwob: .045, seed: 9, endSpecks: true, specks: .5 });
  cir.t0 = tq(B.circle); cir.t1 = cir.t0 + .62;
  add([cir], false);
  // painted tian-zi grids under it, waiting for the lesson's name
  const GRIDS = [0, 1, 2, 3].map(i => ({ x: EQX + (i - 1.5) * 232, y: 1150, size: 210 }));
  // each character starts on a sixteenth (the guitar plucks it), the first one on its beat
  let bt = B.title; const ti = [], CHARB = [];
  for (const [i, ch] of [...'勾股定理'].entries()) {
    const s = writeChar(ch, GRIDS[i].x, GRIDS[i].y, 172, tq(bt), { seed: 80 + i, speed: 100, gap: .006 }); ti.push(...s); CHARB.push(bt);
    let nb = bt + .25; while (tq(nb) < s.end + .02) nb += .25; bt = nb;
  }
  let t = ti[ti.length - 1].t1;
  add(ti, false); text('title', '勾股定理', ti);
  T.titleEnd = t;

  // ───────── F · the one wipe: a damp cloth over the whole proof, row by row; the streak it leaves dries back
  const wy = [290, 650, 1010, 1380], wx0 = 1390, wx1 = 2930, WP = [];
  // the cloth comes in from the seam side (right), so it is in frame while the camera is still pulling left
  wy.forEach((y, i) => { const a = i % 2 ? wx0 : wx1, b = i % 2 ? wx1 : wx0; WP.push([a + (i % 2 ? -40 : 0), y - 10], [(a + b) / 2, y + 12 * (i % 2 ? -1 : 1)], [b, y + 6]); });
  const wipe = { t0: tq(B.wipe0), t1: tq(B.wipe1), w: 500, path: catmull(WP, 14) };
  const wet = { box: [1100, -160, 3200, 1720], t0: wipe.t0 + .55, t1: DUR + .5 };
  EV.push({ t: wipe.t0, type: 'wipe', d: +(wipe.t1 - wipe.t0).toFixed(3) });

  // ───────── camera: [t, cx, cy, s], eased between keys; one continuous take (the whip lands with a small overshoot)
  const K = [
    [0, 2075, 905, 1.06], [tq(6), 2075, 900, 1.28],               // close: push in on the triangle
    [tq(8.75), 2135, 850, .64], [tq(12), 2120, 850, .64],           // pull back: the three squares, the whole figure in frame
    [tq(21.5), 2215, 842, .655],                                    // track with the stream of cells (b² and both arrows stay in)
    [tq(24), 2345, 640, .95], [tq(B.whip), 2350, 630, .99],         // creep in through the silence; the peak
    [tq(26), 4450, 820, .86], [tq(B.pull), 4450, 820, .86],         // whip to the right panel; locked until the name is finished
    [tq(B.pullEnd), 3200, 650, .38], [DUR, 3200, 650, .372],       // the whole wall
  ];
  const camAt = tt => {
    let i = 0; while (i < K.length - 2 && tt > K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1], x = clamp((tt - a[0]) / (b[0] - a[0]));
    let u = eio(x), cx, cy, s;
    if (a[0] === tq(B.whip)) u = x < .5 ? 16 * Math.pow(x, 5) : 1 - Math.pow(-2 * x + 2, 5) / 2;   // a whip: almost all of it in the middle
    cx = lerp(a[1], b[1], u); cy = lerp(a[2], b[2], u); s = lerp(a[3], b[3], u);
    const tw = tt - tq(26); if (tw > 0 && tw < .5) cx += 46 * Math.sin(Math.PI * tw / .25) * Math.exp(-tw / .12);   // the whip's landing
    return { cx, cy, s, shot: 0 };
  };

  // ───────── sound and cue events
  const panOf = (x, y, tt) => { const c = camAt(tt); return clamp((x - c.cx) * c.s / W * 2 * .6, -.7, .7); };
  for (const st of S) {
    const c = camAt((st.t0 + st.t1) / 2), p = st.at(st.len / 2);
    if (Math.abs((p[0] - c.cx) * c.s / W * 2) > 1.3) continue;
    EV.push({ t: +st.t0.toFixed(4), type: 'chalk', d: +(st.t1 - st.t0).toFixed(3), len: Math.round(st.len * c.s), color: st.color, side: st.kind === 'side' ? 1 : 0, pan: +panOf(p[0], p[1], st.t0).toFixed(2), big: st.w > 12 ? 1 : 0 });
  }
  // landings are read off the motion itself: the first frame where a cell rests in its slot
  for (const c of CELLS) {
    let f = Math.floor(c.tl * FPS); while (f < DUR * FPS) { const q = cellAt(c, f / FPS); if (!q.moving && Math.hypot(q.x - c.dst[0], q.y - c.dst[1]) < .5) break; f++; }
    EV.push({ t: +(f / FPS).toFixed(4), type: 'land', k: c.k, beat: c.beat, last: c.last ? 1 : 0, pan: +panOf(c.dst[0], c.dst[1], c.ta).toFixed(2) });
    EV.push({ t: +c.tl.toFixed(4), type: 'lift', k: c.k, d: +(c.ta - c.tl).toFixed(3), last: c.last ? 1 : 0 });
  }
  EV.push({ t: tq(B.whip), type: 'whip', d: +(tq(26) - tq(B.whip)).toFixed(3) }, { t: tq(B.bell), type: 'bell' }, { t: tq(B.hush), type: 'hush' }, { t: tq(B.peak), type: 'peak' });
  // the cue list for cuecheck.py: every named visual hit with the beat it is meant to sit on and the time the picture puts it
  const first = (arr) => Math.min(...arr.map(s => s.t0));
  const cue = (id, beat, t) => EV.push({ type: 'cue', id, beat, t: +t.toFixed(4) });
  const byT = (b) => S.filter(s => Math.abs(s.t0 - tq(b)) < 1e-6);
  for (const [id, b] of Object.entries(B)) if (typeof b === 'number' && byT(b).length) cue(id, b, first(byT(b)));
  B.crack.forEach((b, i) => cue('crack' + i, b, first(byT(b))));
  CHARB.forEach((b, i) => { cue('char' + i, b, first(byT(b))); EV.push({ t: tq(b), type: 'char', i, beat: b }); });
  glyphs.forEach((g, i) => EV.push({ t: tq(g[3]), type: 'glyph', i, ch: g[0], beat: g[3] }));
  for (const c of CELLS) cue('land' + c.k, c.beat, EV.find(e => e.type === 'land' && e.k === c.k).t);
  cue('whipLand', 26, K[7][0]); cue('wipe0', B.wipe0, wipe.t0);
  EV.sort((a, b) => a.t - b.t);
  return { S, TX, EV, T, U, GAP: 7, SQ: { A: [...SQ.A[0], ...SQ.A[1]], B: [...SQ.B[0], ...SQ.B[1]] }, CELLS, cellAt, wipe, wet, camAt, GRIDS, DUR, BPM };
}
