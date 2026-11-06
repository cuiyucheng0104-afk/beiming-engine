// Sets as value-planned reference illustrations → palette-knife strokes.
// Every stroke carries its colour version (sunset harvest) and is shown as its own grey until its `rev` time.
import { Ref, paintRef, rnd, seedRng } from './engine/plate.js';
import { Strokes, KNIFE, BRUSH, DAB, LINE, hex } from './engine/impasto.js';
import { WORLD, SUN, VANISH, X_STOP, chunkTime, SCRAPES, SCRAPE_SPEED, T } from './timeline.js';

const { W, H, HZ, ROAD } = WORLD;
const P = pts => c => { c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); };
const E = (x, y, rx, ry, rot = 0) => c => c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
const lin = (x0, y0, x1, y1, stops) => c => { const g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, col]) => g.addColorStop(o, col)); return g; };
const rad = (x, y, r0, r1, stops) => c => { const g = c.createRadialGradient(x, y, r0, x, y, r1); stops.forEach(([o, col]) => g.addColorStop(o, col)); return g; };
export const hash = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const SC = .5;   // reference pixels per world unit

// when the sun reaches a point that the bike did not paint
const sunTime = (x, y) => T.scrape1 + .15 + Math.hypot(x - SUN.x, (y - SUN.y) * 1.4) / 2600;
// field reveal: behind the rear wheel, on the knife grid, spreading out from the road
export function fieldRev(x, y) {
  const d = Math.abs(y - ROAD);
  // ragged front: the knife never cuts a straight line
  const xn = x - 70 * Math.sin(y / 37 + x / 410) - 55 * Math.sin(y / 13.7) - d * .28;
  const c2 = chunkTime(xn);
  if (c2 === null) return sunTime(x, y);
  return c2 + d / 900 + hash(x * .37 + y * .11) * .09;
}
export function skyRev(x, y) {
  for (const s of SCRAPES) if (y >= s.y0 && y < s.y1) return s.t + Math.abs(x - s.x0) / SCRAPE_SPEED + hash(x * .21 + y) * .03;
  return SCRAPES[SCRAPES.length - 1].t + .4;
}

// ---------------------------------------------------------------- sky (+ far hills), parallax plate
export function buildSky() {
  const R = new Ref(W, 1240, SC);
  const c = R.ctx;
  R.fill(P([[0, -10], [W, -10], [W, 1240], [0, 1240]]),
    lin(0, 0, 0, 1180, [[0, '#2c3264'], [.28, '#5a4678'], [.5, '#a8506a'], [.7, '#e2703e'], [.86, '#f8a24a'], [1, '#ffd27c']]),
    { dir: -6, fallback: -6, group: 'sky', maxR: 44, jit: .08, detail: 2.0, aj: .7, len: 1.15 });
  // warm glow toward the sun
  R.tint(P([[0, 0], [W, 0], [W, 1240], [0, 1240]]), rad(SUN.x, SUN.y, 40, 1700, [[0, 'rgba(255,236,170,.95)'], [.25, 'rgba(255,190,100,.55)'], [1, 'rgba(255,170,90,0)']]));
  // cloud banks: violet tops, burning undersides
  const cloud = (x, y, w, h, top, und, k) => R.fill(cc => { cc.ellipse(x, y, w, h, 0, 0, 7); cc.ellipse(x - w * .55, y + h * .3, w * .55, h * .65, 0, 0, 7); cc.ellipse(x + w * .5, y + h * .25, w * .6, h * .7, 0, 0, 7); },
    lin(0, y - h, 0, y + h * 1.1, [[0, top], [.6, top], [1, und]]), { dir: -4, fallback: -4, group: 'sky', maxR: 30, detail: 1.3, aj: .55 });
  [[500, 110, 420, 60], [1700, 70, 520, 55], [3000, 120, 480, 62], [4100, 60, 380, 50],
   [900, 330, 380, 50], [2300, 300, 520, 58], [3600, 340, 420, 48],
   [300, 560, 330, 42], [1500, 540, 460, 50], [2900, 590, 500, 46], [4200, 560, 300, 40],
   [800, 790, 420, 38], [2100, 820, 380, 36], [3200, 800, 300, 30],
   [1400, 1000, 300, 24], [2700, 1010, 360, 24], [500, 1040, 260, 20]].forEach(([x, y, w, h], i) => {
    const d = y / 1100;
    const top = ['#4a3a66', '#5d4372', '#7c4a74', '#a05468', '#c4645a'][Math.min(4, Math.floor(d * 5))];
    const und = ['#e0745a', '#f08a52', '#ffa457', '#ffb860', '#ffcd78'][Math.min(4, Math.floor(d * 5))];
    cloud(x, y, w, h, top, und, i);
  });
  // the sun, low on the horizon
  // far hills on the horizon, hazy violet
  R.fill(cc => { cc.moveTo(0, 1240); cc.lineTo(0, 1110); for (let x = 0; x <= W; x += 100) cc.lineTo(x, 1102 - 28 * Math.sin(x / 520) - 16 * Math.sin(x / 190 + 1)); cc.lineTo(W, 1240); cc.closePath(); },
    lin(0, 1060, 0, 1160, [[0, '#7a5f86'], [1, '#a8708a']]), { dir: 0, fallback: 0, group: 'hills', maxR: 10, aj: .2 });
  const st = paintRef(R, { R: [40, 20, 10, 5], T: 12, seed: 5, rev: skyRev });
  return { strokes: st, ref: R, w: W, h: 1240 };
}

// the knife trails left by each scrape: long thick warm strokes laid outward from the centre (appear-timed)
export function buildScrapes() {
  const s = new Strokes(3000); seedRng(77);
  SCRAPES.forEach((sc, i) => {
    const ym = (sc.y0 + sc.y1) / 2, hb = sc.y1 - sc.y0;
    // one decisive pass per band, outward both ways; the blade wobbles and tilts, the paint thins at the ends
    for (const dirn of [1, -1]) {
      const passes = 2;
      for (let r = 0; r < passes; r++) {
        let x = sc.x0, k = 0;
        const yb = ym + (r ? (rnd() - .5) * hb * .5 : (rnd() - .5) * hb * .15), tilt = (rnd() - .5) * .16;
        while (x > -300 && x < W + 300) {
          const d = Math.abs(x - sc.x0), len = 420 + rnd() * 380;
          const y = yb + Math.sin(d / 900 + i * 2 + r) * hb * .18 + dirn * tilt * d * .06;
          const warm = y / 1150;
          const col = warm > .78 ? ['#ffe29a', '#ffb05a'] : warm > .55 ? ['#ffb064', '#f27a40'] : warm > .32 ? ['#f2805a', '#c95466'] : warm > .12 ? ['#d0606a', '#8a4a7c'] : ['#8a4a7e', '#4c3a6a'];
          const ang = (dirn > 0 ? 0 : Math.PI) + tilt + (rnd() - .5) * .1;
          s.push({ x: x + dirn * len * .45, y, ang, len, wid: hb * (r ? .16 + rnd() * .1 : .26 + rnd() * .12),
            c: hex(col[0]), c2: hex(col[1]), type: KNIFE, seed: i * 1000 + r * 100 + k, hgt: 1.5 + rnd() * .5, alpha: r ? .45 : .62, skew: (rnd() - .5) * 1.1, bend: (rnd() - .5) * .12,
            app: sc.t + d / SCRAPE_SPEED, rev: 0 });
          x += dirn * len * (.62 + rnd() * .2); k++;
        }
      }
    }
  });
  return s;
}

// the sun: a disc of near-white paint dragged brighter at its heart, inside rings of short knife rays that step
// stroke by stroke from cream to the sky's orange (a glow made of paint, not of pixels). On the final chord one
// more ring is laid outward: the light swells as the bike goes into it.
export const SUN_FLARE = () => T.last;
export function buildSun() {
  const s = new Strokes(900); seedRng(41);
  const t0 = T.scrape1 + Math.abs(SUN.x - SCRAPES[0].x0) / SCRAPE_SPEED, R = SUN.r;
  const ring = (rr, c, c2, n, app, seedBase, lenK, widK) => {
    for (let i = 0; i < n; i++) {
      const a = (i + rnd() * .7) / n * Math.PI * 2, r = R * (rr + (rnd() - .5) * .2);
      const x = SUN.x + Math.cos(a) * r, y = SUN.y + Math.sin(a) * r * .9;
      if (y > HZ + 24) continue;                                   // the field covers the rest
      s.push({ x, y, ang: a + Math.PI / 2 * (rnd() < .5 ? 1 : 0) + (rnd() - .5) * .6, len: R * lenK * (.85 + rnd() * .35), wid: R * widK * (.85 + rnd() * .3),
        c: hex(c), c2: hex(c2), type: KNIFE, seed: seedBase + i, hgt: .4, skew: (rnd() - .5) * .9, app: app + rnd() * .04 });
    }
  };
  // outer rings first so the inner ones overlap them; colour steps from the sky's own peach up to cream
  ring(2.35, '#ffd994', '#ffcf86', 64, t0 + .24, 600, .38, .24);
  ring(1.95, '#ffe2a2', '#ffd994', 58, t0 + .18, 650, .38, .25);
  ring(1.62, '#ffeab6', '#ffe2a4', 50, t0 + .12, 700, .38, .26);
  ring(1.36, '#fff1c8', '#ffe9b4', 44, t0 + .07, 750, .38, .27);
  ring(1.15, '#fff7dc', '#fff0c8', 40, t0 + .03, 800, .38, .28);
  // the flare on the final chord: one more ring of pale dabs, laid outward
  ring(2.75, '#ffdc9a', '#ffd08a', 70, SUN_FLARE(), 850, .4, .24);
  ring(3.1, '#ffd48e', '#ffca80', 64, SUN_FLARE() + .08, 920, .38, .22);
  // the disc: an edge of warm cream, then horizontal drags that get whiter toward the heart
  for (let i = 0; i < 22; i++) {
    const a = i / 22 * Math.PI * 2 + rnd() * .15;
    s.push({ x: SUN.x + Math.cos(a) * R * .8, y: SUN.y + Math.sin(a) * R * .8, ang: a + Math.PI / 2, len: R * .5, wid: R * .36,
      c: hex('#fff0c2'), c2: hex('#ffe4a4'), type: DAB, seed: 950 + i, hgt: .45, app: t0 + i * .004 });
  }
  for (let j = 0; j < 9; j++) {
    const yy = (j / 8 - .5) * 1.5 * R, hw = Math.sqrt(Math.max(0, R * R * .82 - yy * yy)), k = Math.abs(yy) / R;
    s.push({ x: SUN.x + (rnd() - .5) * 6, y: SUN.y + yy, ang: (rnd() - .5) * .08, len: hw * 2, wid: R * .3,
      c: hex(k < .25 ? '#fffcee' : k < .5 ? '#fff6dc' : '#ffefc8'), c2: hex('#ffffff'), type: KNIFE, seed: 980 + j, hgt: .4, skew: (rnd() - .5) * .6, app: t0 + .02 + j * .005 });
  }
  return s;
}

// ---------------------------------------------------------------- the field, the road, bales, a lone tree
const roadEdge = (side) => {   // polyline of the road edge: straight, then curving into the sun
  const pts = [];
  for (let x = -60; x <= X_STOP; x += 40) pts.push([x, ROAD + side * 26]);
  for (let k = 1; k <= 30; k++) {
    const u = k / 30, v = 1 - u;
    const B = [[X_STOP, ROAD], [3260, ROAD + 6], [3560, 1215], VANISH];
    const px = v * v * v * B[0][0] + 3 * v * v * u * B[1][0] + 3 * v * u * u * B[2][0] + u * u * u * B[3][0];
    const py = v * v * v * B[0][1] + 3 * v * v * u * B[1][1] + 3 * v * u * u * B[2][1] + u * u * u * B[3][1];
    const w = 26 * (1 - .92 * Math.pow(u, .8));
    pts.push([px, py + side * w]);
  }
  return pts;
};
export function buildField() {
  const R = new Ref(W, H, SC);
  const c = R.ctx;
  const Y0 = HZ - 8;
  // value plan: far = light hazy straw, mid = gold, near = deep ochre
  const fcol = lin(0, Y0, 0, H, [[0, '#d8b46c'], [.08, '#d6ad55'], [.3, '#d9a440'], [.6, '#c98d2e'], [1, '#a8701f']]);
  const bands = [[Y0, 1200, 7, 0, .3], [1200, 1320, 11, -4, .35], [1320, 1480, 16, 82, .5], [1480, 1720, 24, 86, .4], [1720, H + 10, 34, 92, .35]];
  bands.forEach(([y0, y1, r, dir, aj]) => R.fill(P([[0, y0], [W, y0], [W, y1], [0, y1]]), fcol, { dir, fallback: dir, group: 'field', maxR: r, aj, jit: .1, detail: 1.1 }));
  // wheat texture: vertical streaks of light and shadow (the strokes pick them up)
  c.save(); c.globalCompositeOperation = 'source-atop';
  seedRng(9);
  for (let i = 0; i < 2600; i++) {
    const y = Y0 + 40 + Math.pow(rnd(), .8) * (H - Y0), x = rnd() * W, depth = (y - Y0) / (H - Y0);
    const h = 8 + depth * 120, w = 2 + depth * 9;
    c.fillStyle = rnd() < .5 ? `rgba(120,70,20,${.25 + depth * .2})` : `rgba(255,226,140,${.25 + depth * .15})`;
    c.fillRect(x, y - h, w, h);
  }
  c.restore();
  // furrow rows in the far field
  c.save(); c.globalCompositeOperation = 'source-atop';
  for (let y = Y0 + 12; y < 1330; y += 10 + (y - Y0) * .12) { c.fillStyle = 'rgba(150,100,40,.28)'; c.fillRect(0, y, W, 2 + (y - Y0) * .03); }
  c.restore();
  // lone tree on the horizon
  R.fill(P([[1688, 1134], [1696, 1060], [1704, 1060], [1712, 1134]]), '#4a3a2a', { dir: 90, maxR: 3, group: 'trunk' });
  R.fill(cc => { cc.ellipse(1700, 1015, 70, 58, 0, 0, 7); cc.ellipse(1660, 1040, 46, 34, 0, 0, 7); cc.ellipse(1745, 1035, 48, 36, 0, 0, 7); },
    lin(0, 960, 0, 1075, [[0, '#7a7a3e'], [1, '#4a4a2c']]), { dir: 'edge', fallback: 70, group: 'tree', maxR: 8 });
  // a row of poplars near the bend
  [[3020, 52], [3070, 66], [3120, 58], [3180, 46], [3330, 40], [3380, 50]].forEach(([x, h], i) => R.fill(cc => cc.ellipse(x, HZ - h * .5, 12, h * .6, 0, 0, 7), '#5c5a34', { dir: 90, maxR: 4, group: 'pop' + i }));
  // round straw bales: lit on the right (sun side), shadow left
  const bale = (x, y, r, k) => {
    R.fill(E(x + r * .2, y + r * .55, r * 1.3, r * .22), 'rgba(110,70,30,.9)', { dir: 0, maxR: 6, group: 'bsh' + k });
    R.fill(cc => { cc.moveTo(x - r, y + r * .5); cc.lineTo(x - r, y - r * .3); cc.ellipse(x, y - r * .3, r, r * .5, 0, Math.PI, 0); cc.lineTo(x + r, y + r * .5); cc.ellipse(x, y + r * .5, r, r * .28, 0, 0, Math.PI); cc.closePath(); },
      lin(x - r, 0, x + r, 0, [[0, '#8a5c22'], [.55, '#d6a24a'], [1, '#f0c870']]), { dir: 90, fallback: 90, group: 'bale' + k, maxR: r * .25, hgt: 1.2 });
    R.fill(E(x + r * .55, y + r * .05, r * .42, r * .62), lin(0, y - r, 0, y + r, [[0, '#f4d07c'], [1, '#c89040']]), { dir: { radial: [x + r * .55, y + r * .05], off: 90 }, group: 'bale' + k, maxR: r * .15, hgt: 1.3 });
  };
  bale(1380, 1300, 50, 1); bale(2080, 1238, 32, 2); bale(780, 1420, 70, 3); bale(3550, 1290, 44, 4); bale(2700, 1205, 24, 5);
  // the dirt road, straight then curving up into the sun
  const top = roadEdge(-1), bot = roadEdge(1).reverse();
  R.fill(P([...top, ...bot]), lin(0, 1150, 0, ROAD + 30, [[0, '#b89068'], [1, '#8a6644']]), { dir: 0, fallback: 0, group: 'road', maxR: 9, aj: .2, jit: .08 });
  // ruts
  c.save(); c.globalCompositeOperation = 'source-atop';
  for (const off of [-9, 10]) { c.beginPath(); c.moveTo(-60, ROAD + off); c.lineTo(X_STOP, ROAD + off); c.strokeStyle = 'rgba(80,52,30,.55)'; c.lineWidth = 4; c.stroke(); }
  c.restore();
  // macro opening: the near field is laid in by the knife during the first second
  const st = paintRef(R, { R: [40, 20, 10, 5, 2.6], T: 12, seed: 3, rev: fieldRev });
  return { strokes: st, ref: R, w: W, h: H };
}

// a fringe of near stalks drawn in front of the bike (same plane, so no parallax mismatch)
export function buildFringe() {
  const s = new Strokes(4000); seedRng(31);
  for (let x = -260; x < W; x += 7 + rnd() * 6) {
    const yb = ROAD + 46 + rnd() * 40, h = 40 + rnd() * 50, a = -Math.PI / 2 + (rnd() - .5) * .35;
    const tipx = x + Math.cos(a) * h, tipy = yb + Math.sin(a) * h, rv = fieldRev(x, yb);
    const shade = .8 + rnd() * .35;
    s.push({ x: (x + tipx) / 2, y: (yb + tipy) / 2, ang: a, len: h, wid: 6 + rnd() * 3, c: hex('#c8902e').map(v => v * shade), c2: hex('#8a5a1c'), type: KNIFE, taper: .5, seed: x * .7, rev: rv, hgt: 1.1 });
    s.push({ x: tipx + Math.cos(a) * 6, y: tipy + Math.sin(a) * 6, ang: a, len: 22 + rnd() * 8, wid: 7 + rnd() * 2, c: hex('#d8a648').map(v => v * shade), c2: hex('#a87428'), type: KNIFE, taper: .6, seed: x * .3 + 5, rev: rv, hgt: 1.3 });
  }
  return s;
}
