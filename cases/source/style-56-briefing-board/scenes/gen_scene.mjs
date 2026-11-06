// The film as data: timeline.js → scenes/film.json (world + camera + sound events) and audio/timeline.json.
//   node scenes/gen_scene.mjs
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import * as T from '../timeline.js';
const HERE = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(HERE, '..');
const { b, H, HIT, BOARD, WL, XL, XR, XM, TT, DK, LOW, XAL, XAR, cableY, DUR } = T;
const r1 = v => Math.round(v * 10) / 10;
const els = [], ev = [];
const E = (o) => { els.push(o); return o; };
const sfx = (t, type, o = {}) => ev.push({ t: +t.toFixed(4), type, ...o });

// ------------------------------------------------------------ prints (evidence), top band
// drop: lands at arrive.t + land·d  →  arrive.t = hit − 0.55·d
const drop = (hit, d = .6, lift = 320) => ({ t: hit - .55 * d, kind: 'drop', d, lift, land: .55 });
const snap = (hit, lift = 80) => ({ t: hit - Math.PI / 44, kind: 'snap', d: .45, lift });   // contact = first zero of the settle
E({ type: 'print', id: 'tower', src: 'print_tower', xy: [1150, 1050], w: 800, z: 8, rot: -1.2, arrive: drop(H.landTower, .62, 360) });
E({ type: 'print', id: 'bay', src: 'print_bay', xy: [2380, 1135], w: 1150, z: 8, rot: 1.4, arrive: drop(H.landBay) });
E({ type: 'print', id: 'cable', src: 'cable', xy: [3480, 1050], w: 940, z: 12, rot: -2, arrive: drop(H.landCable, .6, 300) });
E({ type: 'print', id: 'elev', src: 'print_elev', xy: [5010, 1000], w: 1500, z: 8, rot: .8 });   // secondary layer: seen only in the reveal
sfx(H.landTower, 'land', { w: 1.0 }); sfx(H.landBay, 'land', { w: .85 }); sfx(H.landCable, 'land', { w: .7, metal: 1 });
const pins = [
  [H.pinTower1, [800, 560]], [H.pinTower2, [1505, 575]],
  [H.pinBay1, [1860, 745]], [H.pinBay2, [2905, 760]],
  [H.pinCable, [3720, 862]],
];
pins.forEach(([t, xy], i) => { E({ type: 'magnet', xy, r: 34, color: 'graphite', z: 16, arrive: snap(t) }); sfx(t, 'pin', { i }); });
// pre-placed magnets on the secondary print (no sound: they were there before the film)
E({ type: 'magnet', xy: [4300, 760], r: 32, color: 'graphite', z: 16 }); E({ type: 'magnet', xy: [5700, 1240], r: 32, color: 'graphite', z: 16 });

// title: the question
E({ type: 'ink', kind: 'write', id: 'title', text: '为何不倒？', xy: [1600, 640], size: 140, color: 'graphite', t: H.title, d: 1.0 });
sfx(H.title, 'write', { d: 1.0, n: 5 });

// ------------------------------------------------------------ elevation (pre-existing graphite drawing)
const line = (points, o = {}) => E({ type: 'ink', kind: 'line', points: points.map(p => [r1(p[0]), r1(p[1])]), lw: 9, color: 'graphite', ...o });
const erasable = [];
const keep = [];
// towers: tapered columns on piers, saddle on top
for (const X of [XL, XR]) {
  keep.push(line([[X - 20, WL], [X - 13, TT - 6], [X + 13, TT - 6], [X + 20, WL]], { lw: 9 }));
  keep.push(line([[X - 24, TT - 6], [X + 24, TT - 6]], { lw: 12 }));
  keep.push(line([[X - 42, WL - 24], [X - 42, WL + 70], [X + 42, WL + 70], [X + 42, WL - 24], [X - 42, WL - 24]], { lw: 8 }));
  for (const y of [TT + 110, TT + 250, TT + 390]) keep.push(line([[X - 15, y], [X + 15, y]], { lw: 5, color: 'grey' }));
}
// main cable (one polyline, side spans included)
const cab = []; for (let x = XAL; x <= XAR; x += 25) cab.push([x, cableY(x)]); cab.push([XAR, cableY(XAR)]);
const cabEl = line(cab, { lw: 10 }); cabEl.haze = .035; cabEl.ghostA = .24; erasable.push(cabEl);
// deck
erasable.push(line([[XAL - 60, DK], [XAR + 60, DK]], { lw: 8 }));
erasable.push(line([[XAL - 60, DK + 18], [XAR + 60, DK + 18]], { lw: 6 }));
// suspenders (drafting grey, every 64 m): the ride along the span always has structure in frame
for (let x = XAL + 150; x < XAR - 100; x += 150) {
  if (Math.abs(x - XL) < 60 || Math.abs(x - XR) < 60) continue;
  const yc = cableY(x); if (DK - yc < 24) continue;
  erasable.push(line([[x, DK - 4], [x, yc + 6]], { lw: 3.5, color: 'grey', alpha: .6 }));
}
// anchorages and shores
for (const [xa, sg] of [[XAL, -1], [XAR, 1]]) {
  erasable.push(line([[xa - 70, DK - 30], [xa + 70, DK - 30], [xa + 90, DK + 90], [xa - 90, DK + 90], [xa - 70, DK - 30]], { lw: 8 }));
  const sh = sg < 0 ? [[250, DK + 90], [XAL + 260, DK + 95], [1180, WL]] : [[6150, DK + 90], [XAR - 260, DK + 95], [5820, WL]];
  erasable.push(line(sh, { lw: 7, color: 'grey' }));
}
// water: blue hatching under the water line (blue = water)
{
  const strokes = []; let k = 0;
  for (let x = 1200; x < 5800; x += 90) for (const dy of [22, 58]) { const xo = x + (dy > 30 ? 45 : 0) + ((k * 37) % 23); strokes.push({ points: [[xo, WL + dy], [xo + 55, WL + dy]], t: -5, d: .1 }); k++; }
  erasable.push(E({ type: 'ink', kind: 'hatch', strokes, lw: 5, color: 'water', alpha: .7 }));
  erasable.push(line([[1180, WL], [5820, WL]], { lw: 6, color: 'water' }));
}

// ------------------------------------------------------------ projection: a dashed blue line carries the photographed tower down to the drawn one
const PJ0 = 3.75, PJ1 = b(6.5);
const proj = line([[XL, 1650], [XL, TT - 70]], { lw: 6, color: 'blue', dash: [34, 26], t: PJ0, d: +(PJ1 - PJ0).toFixed(4), ea: 2.2, eb: 1.6 });
keep.push(proj); sfx(PJ0, 'write', { d: PJ1 - PJ0, n: 2 }); sfx(PJ1, 'tap', { soft: 1 });
// ------------------------------------------------------------ ride the dimension line (blue = measurement)
const DY = 3300, HIT_DIM0 = HIT.dimStart;
const extL = line([[XL, WL + 85], [XL, DY + 45]], { lw: 5, color: 'blue', t: +(H.extL - .14).toFixed(4), d: .14, ease: 'linear' });
const extR = line([[XR, WL + 85], [XR, DY + 45]], { lw: 5, color: 'blue', t: +(H.extR - .14).toFixed(4), d: .14, ease: 'linear' });
sfx(H.extL, 'tap'); sfx(H.extR, 'tap', { soft: 1 });
const RIDE = { a: 1.5, b: 1.5, lead: .2, d: 3.8 }, STEPS = 5, REST = .3;   // the pen steps off 5 × 256 m, one step per beat (with the walking bass)
const dim = E({ type: 'ink', kind: 'dim', from: [XL, DY], to: [XR, DY], lw: 10, color: 'blue', t: H.dimStart, d: +(H.dimEnd - H.dimStart).toFixed(4), steps: STEPS, rest: REST, ea: 2, eb: 2.4 });
sfx(H.dimStart, 'draw', { d: H.dimEnd - H.dimStart, len: 3000, steps: STEPS, rest: REST }); sfx(H.dimEnd, 'arrow', { ring: 1 });
const label = E({ type: 'ink', kind: 'write', id: 'span', text: '1280 米', xy: [XM, 3492], size: 140, align: 'center', color: 'blue', t: H.label, d: .55 });
sfx(H.label + .02, 'write', { d: .55, n: 5 });
// a tick lands on the line at every beat where the pen arrives (every 256 m): something drops each beat of the ride
const ticks = [];
for (let k = 1; k < STEPS; k++) {
  const tx = XL + k * 3000 / STEPS, tb = b(HIT_DIM0 + k);
  ticks.push(line([[tx, DY - 44], [tx, DY + 44]], { lw: 6, color: 'blue', t: +(tb - .1).toFixed(4), d: .1, ease: 'linear' }));
  sfx(tb, 'tap', { tick: k });
}
dim.haze = .03; erasable.push(extL, extR, dim, label, ...ticks);

// ------------------------------------------------------------ magnets as countable loads, hung on the cable
const loads = [];
H.loads.forEach((t, i) => {
  const x = XL + 300 * (i + .5);
  const m = E({ type: 'magnet', id: 'load' + i, xy: [x, DK + 9], r: 44, color: 'graphite', z: 16, arrive: snap(t, 110) });
  loads.push(m);
  sfx(t, 'load', { i, x });
  const hg = line([[x, DK - 40], [x, cableY(x) + 5]], { lw: 6, t: +(t + .05).toFixed(4), d: .16, ea: 1.5, eb: 2 });
  erasable.push(hg);
});
// force flow: along the cable to both tower tops, then down the towers
const flowL = [], flowR = [];
for (let x = XM - 60; x >= XL + 40; x -= 30) flowL.push([x, cableY(x) - 48]);
for (let x = XM + 60; x <= XR - 40; x += 30) flowR.push([x, cableY(x) - 48]);
const fd = +(H.tops - H.flow).toFixed(4);
erasable.push(line(flowL, { lw: 18, arrow: true, t: H.flow, d: fd, ea: 2.6, eb: 1.6 }));
erasable.push(line(flowR, { lw: 18, arrow: true, t: H.flow, d: fd, ea: 2.6, eb: 1.6 }));
sfx(H.flow, 'flow', { d: fd }); sfx(H.tops, 'arrow');
const dd = +(H.base - H.tops).toFixed(4);
keep.push(line([[XL + 62, TT + 30], [XL + 62, WL - 20]], { lw: 18, arrow: true, t: H.tops, d: dd, ea: 2.4, eb: 1.4 }));
keep.push(line([[XR - 62, TT + 30], [XR - 62, WL - 20]], { lw: 18, arrow: true, t: H.tops, d: dd, ea: 2.4, eb: 1.4 }));
sfx(H.tops, 'down', { d: dd }); sfx(H.base, 'base');

// ------------------------------------------------------------ verdict: after the silence two red magnets slam onto the tower tops
for (const X of [XL, XR]) E({ type: 'magnet', id: 'verdict' + X, xy: [X, TT - 34], r: 58, color: 'red', z: 18, arrive: snap(H.verdict, 420),
  jolts: [] });
sfx(H.verdict, 'verdict');

// ------------------------------------------------------------ erase to a ghost: one left→right sweep, constant speed
const X0 = 380, X1 = 5900, SW = .95, v = (X1 - X0) / SW;
function bbox(e) {
  let P = [];
  if (e.kind === 'line') P = e.points; else if (e.kind === 'hatch') P = e.strokes.flatMap(s => s.points);
  else if (e.kind === 'dim') P = [e.from, e.to]; else if (e.kind === 'write') { const w = 140 * 4.3; P = [[e.xy[0] - w / 2, e.xy[1] - 120], [e.xy[0] + w / 2, e.xy[1] + 20]]; }
  const xs = P.map(p => p[0]); return [Math.min(...xs) - 60, Math.max(...xs) + 60];
}
for (const e of erasable) {
  const [bx0, bx1] = bbox(e);
  e.erase = { t: +(H.erase + Math.max(0, bx0 - 120 - X0) / v).toFixed(4), d: +((bx1 - bx0 + 240) / v).toFixed(4), ghost: e.ghostA ?? .15, haze: e.haze ?? 0 }; delete e.haze; delete e.ghostA;
}
sfx(H.erase, 'erase', { d: SW });
for (const m of loads) {
  const tp = +(H.erase + (m.xy[0] - X0) / v).toFixed(4);
  m.leave = { t: tp, kind: 'pop', d: .4, lift: 900, to: [0, -160], spin: 30 };
  sfx(tp, 'pop', { x: m.xy[0] });
}

// ------------------------------------------------------------ the conclusion (marker, 270 px; key word red)
const CS = 270, adv = CS * 1.02, A = '重量全部流进', B = '两座塔';
const x0 = Math.round(XM - (A.length + B.length) * adv / 2);
E({ type: 'ink', kind: 'write', id: 'verdictA', text: A, xy: [x0, 2420], size: CS, color: 'graphite', t: H.writeA, d: +(H.writeB - H.writeA).toFixed(4) });
E({ type: 'ink', kind: 'write', id: 'verdictB', text: B, xy: [Math.round(x0 + A.length * adv), 2420], size: CS, color: 'red', t: H.writeB, d: .625 });
sfx(H.writeA, 'write', { d: H.writeB - H.writeA, n: 6, big: 1 }); sfx(H.writeB, 'write', { d: .625, n: 3, big: 1 });

// ------------------------------------------------------------ secondary layer (only in the reveal): notes and source card
const note = (id, xy, rot, text) => E({ type: 'card', id, xy, w: 640, h: 300, rot, z: 6, paper: '#F4E7A1',
  lines: [{ text, font: 'marker', size: 96, x: 48, y: 62, color: 'blue' }], magnets: [[0, -118, 'graphite']], magnetR: 26 });
note('noteSpan', [5975, 2640], -2.5, '主跨 1280 米');
note('noteTower', [5950, 3090], 2, '塔高 227 米');
E({ type: 'card', id: 'src', xy: [4500, 1640], w: 760, h: 330, rot: -1.5, z: 6,
  lines: [{ text: 'HAER CA-31', font: 'mono', size: 76, x: 56, y: 6, weight: 600 }, { text: 'PUBLIC DOMAIN', font: 'mono', size: 56, x: 56, y: 96 }],
  magnets: [[-318, -128, 'graphite']], magnetR: 28 });

// ------------------------------------------------------------ camera: absolute keys → overlapping eased moves
const cam = { x: 1500, y: 960, z: 1.10, roll: 0, moves: [], shakes: [] };
let cur = { x: cam.x, y: cam.y, z: cam.z, roll: 0 };
const key = (t, d, to, a = 2, bb = 2) => {
  const nx = { ...cur, ...to };
  cam.moves.push({ t: +t.toFixed(4), d: +d.toFixed(4), dx: r1(nx.x - cur.x), dy: r1(nx.y - cur.y), dl: +Math.log(nx.z / cur.z).toFixed(5), dr: +(nx.roll - cur.roll).toFixed(3), a, b: bb });
  cur = nx;
};
key(0, 1.7, { z: 1.15 }, 2, 2.6);                                   // slow push on the landing (tower print on the left third)
key(1.55, 1.95, { x: 2690, y: 1010, z: .82 }, 2.4, 2.6);            // truck right as the wall fills
key(3.62, .9, { x: 1760 }, 2.2, 2.4);                                // slide left onto the projection line …
key(3.70, .62, { y: 2180, z: .64 }, 2.4, 2.2);                        // … tilt down along it and open up: photo above, drawn tower below, the pen between
key(4.10, .72, { y: 2990, z: 1.06 }, 2.2, 2.4);                       // … then drop to the tower foot where the dimension starts
key(H.dimStart - RIDE.lead, RIDE.d, { x: 1760 + 2800, z: 1.0 }, RIDE.a, RIDE.b);   // ride the dimension line: the pen steps, the camera glides with it (fitted, ≤ 320 px off the tip)
key(H.dimEnd, .95, { x: XM, y: 2900 }, 1.8, 3);                     // slide back left first …
key(H.dimEnd + .12, 1.0, { z: .6 }, 2.6, 2.2);                        // … then pull out: judgement frame, whole span
key(8.95, 3.1, { x: 3720, y: 2880, z: .82, roll: -1.6 }, 3, 1.6);    // push in with the loads, Dutch tilt (accelerating)
key(H.flow - .15, 1.15, { x: XM, y: 2840, z: .6, roll: 0 }, 2, 2.4);   // pull back and level: the flow, both towers
key(H.base + .05, 1.2, { z: .555 }, 2, 2);                           // the silence: a slow breath out, both towers clear of the edges
cam.shakes.push({ t: H.verdict, amp: 9, f: 8, k: 6, dir: [0, 1] });
key(H.erase, .95, { y: 2660, z: .66 }, 2, 2.2);                      // rise toward the conclusion
key(H.pull, H.settle - H.pull, { x: 3200, y: 1800, z: .285 }, 2, 3);    // the whole wall, once
key(H.settle, DUR - H.settle, { z: .292 }, 2, 2);                           // settle

const scene = {
  dur: DUR, t: DUR - .01, hand: 1,
  board: { w: BOARD.w, h: BOARD.h, seed: 56, texScale: .45, ghosts: 110 },
  light: { x: -1800, y: -2400, r: 15000, min: .8 }, sheen: .07,
  cam, elements: els, subs: [],
  tray: [{ x: 900, color: 'graphite', rot: 2 }, { x: 1350, color: 'blue', rot: -3 }, { x: 1750, color: 'red', rot: 1 }, { x: 4700, kind: 'eraser', rot: -2 }],
  mb: [{ t0: H.landTower - .3, t1: H.landTower + .05, n: 4 }],
  ev: ev.sort((p, q) => p.t - q.t),
};
fs.writeFileSync(path.join(P, 'scenes/film.json'), JSON.stringify(scene));
fs.mkdirSync(path.join(P, 'audio'), { recursive: true });
fs.writeFileSync(path.join(P, 'audio/timeline.json'), JSON.stringify({ BPM: T.BPM, BEAT: T.BEAT, OFF: T.OFF, DUR, SECS: T.SECS, HIT: T.HIT, H }, null, 1));
console.log('film.json', els.length, 'elements,', ev.length, 'events, dur', DUR);
