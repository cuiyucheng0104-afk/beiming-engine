// The four prints of 一伞三景. Each print = cached colour blocks (drawn once) + a few live pieces.
// Sheet coordinates 0..1920 × 0..1080, picture inside FR.
import { clamp, lerp, mulberry, hash, vnoise, TAU } from '/core/lib.js';
import { W, H, FR, PAL, mk, inkify, bokashi, kasumi, carve, wob, smooth, poly, rgba, mix, dense } from './print.js';
import { pine, rock, fclaw, spray } from './nature.js';

const SUMI = PAL.sumi;
const NIGHT = '#16223a';
// ———————————————————————————— helpers ————————————————————————————
function nightSky(x, yb, seed) {
  x.save(); x.beginPath(); x.rect(0, 0, W, yb); x.clip();
  bokashi(x, 0, FR.y0, W, yb, PAL.prusD, .98, .5, { rough: 24, seed, col2: PAL.ai });
  bokashi(x, 0, FR.y0, W, FR.y0 + (yb - FR.y0) * .62, SUMI, .9, 0, { rough: 28, seed: seed + 7, ease: .8 });
  x.restore();
}
function bands(x, y0, y1, seed) {   // horizontal light/dark water bands with wandering edges
  const R = mulberry(seed);
  for (let y = y0; y < y1; y += 46 + R() * 40) {
    x.strokeStyle = rgba(PAL.skyL, .55 + R() * .25); x.lineWidth = 2 + R() * 1.5; x.lineCap = 'round';
    for (let k = 0; k < 9; k++) {
      const cx = R() * W, len = 40 + R() * 160, yy = y + (R() - .5) * 18;
      x.beginPath(); x.moveTo(cx - len / 2, yy); x.quadraticCurveTo(cx, yy - 3 - R() * 3, cx + len / 2, yy); x.stroke();
    }
  }
}
const deckY = X => 612 + .000034 * (X - 900) * (X - 900);

// ———————————————————————————— S0 · 雨夜木桥 (the opening print) ————————————————————————————
const PILES = [150, 480, 810, 1140, 1470, 1800];
const POSTS = Array.from({ length: 13 }, (_, k) => 70 + k * 150);
const S0 = {
  id: 's0', K: 2,
  cart: { x: 1778, y: 74, title: '一伞三景', series: '', w: 96, size: 58, seal: '伞' },
  blocks: {
    sky: { g: 4, grain: .07, baren: .3, speck: .12, draw(x) {
      nightSky(x, 486, 3);
      // far bank: low roofs, a grey silhouette with no key line
      x.fillStyle = '#2a3346'; x.beginPath(); x.moveTo(0, 486); const R = mulberry(8); let X = 0;
      while (X < W) { const w = 60 + R() * 110, h = 14 + R() * 22; x.lineTo(X, 470 - h * .4); x.lineTo(X + w * .25, 470 - h); x.lineTo(X + w * .75, 470 - h); x.lineTo(X + w, 470 - h * .4); X += w; }
      x.lineTo(W, 486); x.closePath(); x.fill();
    } },
    water: { g: 1, grain: .1, baren: .38, draw(x) {
      x.save(); x.beginPath(); x.rect(0, 482, W, H); x.clip();
      x.fillStyle = PAL.prus; x.fillRect(0, 482, W, H);
      bokashi(x, 0, 482, W, 600, PAL.sky, .8, 0, { rough: 16, seed: 21 });
      bokashi(x, 0, 760, W, 1042, PAL.prusD, 0, .9, { rough: 26, seed: 22 });
      bands(x, 500, 1040, 23);
      x.restore();
    } },
    wood: { g: 2, grain: .1, baren: .22, draw(x) {
      // pilings + braces (night-dark wood), girder face, far lantern lights and their broken reflections
      for (const px of PILES) {
        x.fillStyle = PAL.woodD; for (const s of [-24, 24]) x.fillRect(px + s - 9, deckY(px) + 30, 18, H);
        x.strokeStyle = PAL.woodD; x.lineWidth = 9; x.beginPath(); x.moveTo(px - 24, deckY(px) + 70); x.lineTo(px + 24, deckY(px) + 250); x.moveTo(px + 24, deckY(px) + 70); x.lineTo(px - 24, deckY(px) + 250); x.stroke();
      }
      x.fillStyle = '#6a5038'; x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X) + 64); for (let X = W; X >= 0; X -= 20) x.lineTo(X, deckY(X) + 74); x.fill();
      x.fillStyle = PAL.wood; x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X)); for (let X = W; X >= 0; X -= 20) x.lineTo(X, deckY(X) + 38); x.fill();
      const R = mulberry(31);
      for (const lx of [210, 460, 1010, 1290, 1620]) {
        x.fillStyle = PAL.ochreL; x.fillRect(lx, 458 + R() * 8, 7, 6);
        x.fillStyle = rgba(PAL.ochre, .55); for (let k = 0; k < 7; k++) x.fillRect(lx - 4 + (R() - .5) * 10, 500 + k * 15, 12 + R() * 10, 3);
      }
    } },
    key: { g: 0, speck: .12, draw(x) {
      x.fillStyle = SUMI;
      const top = [], bot = [], mid = [];
      for (let X = -10; X <= W + 10; X += 60) { top.push([X, deckY(X)]); bot.push([X, deckY(X) + 38]); mid.push([X, deckY(X) + 64]); }
      carve(x, wob(top, 1.2, 1), 3.4, { taper: [0, 0], seed: 2 }); carve(x, wob(bot, 1.2, 2), 3, { taper: [0, 0], seed: 3 }); carve(x, wob(mid, 1, 4), 2.2, { taper: [0, 0], seed: 4 });
      x.strokeStyle = SUMI; x.lineWidth = 2.2;
      for (const px of PILES) for (const s of [-24, 24]) { x.beginPath(); x.moveTo(px + s - 9, deckY(px) + 38); x.lineTo(px + s - 9, H); x.moveTo(px + s + 9, deckY(px) + 38); x.lineTo(px + s + 9, H); x.stroke(); }
      x.lineWidth = 1.6; for (const px of PILES) { x.beginPath(); x.moveTo(px - 24, deckY(px) + 70); x.lineTo(px + 24, deckY(px) + 250); x.moveTo(px + 24, deckY(px) + 70); x.lineTo(px - 24, deckY(px) + 250); x.stroke(); }
      // plank seams on the girder face
      x.lineWidth = 1.2; for (let X = 40; X < W; X += 95) { x.beginPath(); x.moveTo(X, deckY(X) + 4); x.lineTo(X + 2, deckY(X) + 34); x.stroke(); }
      // water: a few dark ripple strokes in the river (key block, blue-black)
      const R = mulberry(41); x.strokeStyle = PAL.prusD; x.lineWidth = 2;
      for (let i = 0; i < 26; i++) { const cx = R() * W, cy = 700 + R() * 320, l = 30 + R() * 80; x.beginPath(); x.moveTo(cx - l, cy); x.quadraticCurveTo(cx, cy + 5, cx + l, cy); x.stroke(); }
    } },
    rail: { g: 2, grain: .08, baren: .2, draw(x) {
      x.fillStyle = PAL.wood;
      for (const px of POSTS) x.fillRect(px - 6, deckY(px) - 58, 12, 58);
      x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X) - 60); for (let X = W; X >= 0; X -= 20) x.lineTo(X, deckY(X) - 48); x.fill();
      x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X) - 30); for (let X = W; X >= 0; X -= 20) x.lineTo(X, deckY(X) - 24); x.fill();
      x.fillStyle = PAL.woodD; for (const px of POSTS) { x.beginPath(); x.ellipse(px, deckY(px) - 66, 7, 9, 0, 0, TAU); x.fill(); }
    } },
    railKey: { g: 0, speck: .1, draw(x) {
      x.strokeStyle = SUMI; x.lineWidth = 1.8; x.lineJoin = 'round';
      for (const px of POSTS) { x.strokeRect(px - 6, deckY(px) - 58, 12, 58); x.beginPath(); x.ellipse(px, deckY(px) - 66, 7, 9, 0, 0, TAU); x.stroke(); }
      for (const [a, b] of [[-60, -48], [-30, -24]]) { x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X) + a); x.stroke(); x.beginPath(); for (let X = 0; X <= W; X += 20) x.lineTo(X, deckY(X) + b); x.stroke(); }
    } },
  },
  order: ['sky', 'water', 'wood', 'key'],
  front: ['rail', 'railKey'],
};
export const WILLOW = Array.from({ length: 15 }, (_, i) => { const R = mulberry(500 + i); return { x: 70 + i * 34 + R() * 20, y0: 20, len: 230 + R() * 230 - Math.abs(i - 6) * 9, bend: 20 + R() * 40, seed: i }; });

// ———————————————————————————— S1 · 檐雨 (rooftops in the rain) ————————————————————————————
const ROWS = [
  { ridge: 336, eave: 386, wall: 100, scale: .45, grey: '#8a8a82', seed: 1 },
  { ridge: 440, eave: 516, wall: 130, scale: .62, grey: '#77776f', seed: 2 },
  { ridge: 590, eave: 702, wall: 230, scale: .85, grey: '#66665f', seed: 3 },
  { ridge: 880, eave: 1090, wall: 0, scale: 1.3, grey: '#55554f', seed: 4 },
];
function houses(row) {
  const R = mulberry(row.seed * 13), out = []; let X = -40 - R() * 80;
  while (X < W + 40) { const w = (190 + R() * 220) * row.scale * 1.4; out.push({ x0: X, x1: X + w, dy: (R() - .5) * 46 * row.scale - (R() < .3 ? 26 * row.scale : 0), firewall: R() < .5, lit: .25 + R() * .3 }); X += w + (R() < .25 ? 26 * row.scale : 0); }
  return out;
}
const HOUSES = ROWS.map(houses);
function roofRow(x, row, hs, pass) {
  const sc = row.scale;
  for (const h of hs) {
    const r0 = row.ridge + h.dy, e = row.eave, ov = 10 * sc;
    const pts = [[h.x0 - ov, e], [h.x0 + 6 * sc, r0], [h.x1 - 6 * sc, r0], [h.x1 + ov, e]];
    if (pass === 'wall') {
      // shopfront below the eave: dark posts, lit shoji, an indigo noren
      x.fillStyle = '#a99a7a'; x.fillRect(h.x0, e, h.x1 - h.x0, row.wall);
    }
    if (pass === 'wood') {
      const R = mulberry(h.x0 * 3 + row.seed);
      x.fillStyle = '#4b3a2a'; x.fillRect(h.x0, e, h.x1 - h.x0, 12 * sc);
      for (let X = h.x0 + 10 * sc; X < h.x1 - 10 * sc; X += 64 * sc) {
        const lit = R() < h.lit; x.fillStyle = lit ? PAL.ochreL : '#3e3024'; x.fillRect(X, e + 18 * sc, 48 * sc, Math.min(row.wall - 22 * sc, 74 * sc));
        x.fillStyle = '#4b3a2a'; x.fillRect(X - 6 * sc, e + 12 * sc, 6 * sc, row.wall);
      }
    }
    if (pass === 'blue') {
      const R = mulberry(h.x0 * 7 + row.seed);
      if (sc > .7) for (let X = h.x0 + 30 * sc; X < h.x1 - 60 * sc; X += 150 * sc) if (R() < .5) { x.fillStyle = PAL.ai; x.fillRect(X, e + 12 * sc, 70 * sc, 34 * sc); x.fillStyle = PAL.paper; x.fillRect(X + 34 * sc, e + 12 * sc, 2 * sc, 34 * sc); }
    }
    if (pass === 'roof') { x.fillStyle = row.grey; x.beginPath(); poly(x, pts); x.fill(); x.fillStyle = mix(row.grey, SUMI, .45); x.fillRect(h.x0, r0 - 7 * sc, h.x1 - h.x0, 12 * sc); }
    if (pass === 'key') {
      x.strokeStyle = SUMI; x.lineWidth = 2.4 * Math.max(.6, sc); x.lineJoin = 'round'; x.beginPath(); poly(x, pts); x.stroke();
      // tiles: parallel slanted lines from ridge to eave (never converging)
      x.lineWidth = 1.1 * Math.max(.7, sc); const sl = .3, step = 15 * sc, hgt = e - r0;
      for (let X = h.x0 + 8 * sc; X < h.x1; X += step) { x.beginPath(); x.moveTo(X, r0 + 5 * sc); x.lineTo(X - sl * hgt, e - 2); x.stroke(); }
      x.lineWidth = .8; for (let Y = r0 + 18 * sc; Y < e - 6; Y += 22 * sc) { x.beginPath(); x.moveTo(h.x0, Y); x.lineTo(h.x1, Y); x.stroke(); }
      x.lineWidth = 2 * Math.max(.6, sc); x.strokeRect(h.x0, r0 - 7 * sc, h.x1 - h.x0, 12 * sc);
      x.fillStyle = SUMI; x.beginPath(); x.arc(h.x0 + 4 * sc, r0 - 2 * sc, 7 * sc, 0, TAU); x.fill(); x.beginPath(); x.arc(h.x1 - 4 * sc, r0 - 2 * sc, 7 * sc, 0, TAU); x.fill();
      x.lineWidth = 1.4 * Math.max(.6, sc); x.beginPath(); x.moveTo(h.x0, e + 12 * sc); x.lineTo(h.x1, e + 12 * sc); x.stroke();
    }
    if (h.firewall) { // udatsu: a white plaster firewall rising above the roof at the house edge
      const fx = h.x1 - 4 * sc, fw = 18 * sc, top = r0 - 34 * sc;
      if (pass === 'wall') { x.fillStyle = '#c9bc9c'; x.fillRect(fx - fw / 2, top, fw, e - top); }
      if (pass === 'roof') { x.fillStyle = mix(row.grey, SUMI, .35); x.fillRect(fx - fw / 2 - 4 * sc, top - 8 * sc, fw + 8 * sc, 9 * sc); }
      if (pass === 'key') { x.strokeStyle = SUMI; x.lineWidth = 1.8 * Math.max(.6, sc); x.strokeRect(fx - fw / 2, top, fw, e - top); x.strokeRect(fx - fw / 2 - 4 * sc, top - 8 * sc, fw + 8 * sc, 9 * sc); }
    }
  }
}
function tower(x, pass) {   // fire-watch tower (hinomi-yagura) with a bell
  const X = 1500, b = 540, top = 168;
  const legs = [[X - 60, b], [X - 34, top + 40], [X + 34, top + 40], [X + 60, b]];
  if (pass === 'wood') {
    x.strokeStyle = PAL.woodD; x.lineWidth = 9; x.lineCap = 'round';
    x.beginPath(); x.moveTo(...legs[0]); x.lineTo(...legs[1]); x.moveTo(...legs[3]); x.lineTo(...legs[2]); x.stroke();
    x.lineWidth = 4; for (let y = b - 40; y > top + 50; y -= 46) { const u = (b - y) / (b - top - 40), hw = lerp(60, 34, u); x.beginPath(); x.moveTo(X - hw, y); x.lineTo(X + hw, y); x.stroke(); }
    x.fillStyle = PAL.wood; x.fillRect(X - 48, top + 24, 96, 18);
    x.fillStyle = '#5f5e58'; x.beginPath(); poly(x, [[X - 62, top + 6], [X, top - 32], [X + 62, top + 6]]); x.fill();
    x.fillStyle = '#9a7a3c'; x.beginPath(); x.moveTo(X - 9, top + 22); x.quadraticCurveTo(X, top - 2, X + 9, top + 22); x.fill();
  }
  if (pass === 'key') {
    x.strokeStyle = SUMI; x.lineWidth = 1.8;
    for (const s of [-1, 1]) { const a = legs[s < 0 ? 0 : 3], c = legs[s < 0 ? 1 : 2]; x.beginPath(); x.moveTo(a[0] - 4.5 * s, a[1]); x.lineTo(c[0] - 4.5 * s, c[1]); x.moveTo(a[0] + 4.5 * s, a[1]); x.lineTo(c[0] + 4.5 * s, c[1]); x.stroke(); }
    x.strokeRect(X - 48, top + 24, 96, 18); x.beginPath(); poly(x, [[X - 62, top + 6], [X, top - 32], [X + 62, top + 6]]); x.stroke();
    x.beginPath(); x.moveTo(X - 9, top + 22); x.quadraticCurveTo(X, top - 2, X + 9, top + 22); x.closePath(); x.stroke();
  }
}
function temple(x) {   // a great temple roof far behind the town: grey silhouette, no key line
  x.fillStyle = '#3b4456'; const cx = 980, y = 300;
  x.beginPath(); x.moveTo(cx - 330, y + 70); x.quadraticCurveTo(cx - 250, y + 52, cx - 190, y + 6); x.lineTo(cx + 190, y + 6); x.quadraticCurveTo(cx + 250, y + 52, cx + 330, y + 70); x.lineTo(cx + 300, y + 76); x.lineTo(cx - 300, y + 76); x.fill();
  x.fillRect(cx - 200, y - 14, 400, 22); x.beginPath(); x.moveTo(cx - 230, y - 4); x.quadraticCurveTo(cx - 150, y - 60, cx - 110, y - 80); x.lineTo(cx + 110, y - 80); x.quadraticCurveTo(cx + 150, y - 60, cx + 230, y - 4); x.fill();
  x.fillRect(cx - 250, y + 70, 500, 60);
}
const S1 = {
  id: 's1', K: 1,
  cart: { x: 130, y: 74, title: '檐雨', series: '其一', w: 84, size: 54, seal: '伞' },
  // drawn back to front, row by row, so nearer roofs cover farther walls; each step is printed as its own textured block
  steps: [{ g: 4, grain: .07, baren: .3, speck: .12, draw(x) { nightSky(x, 460, 51); temple(x); } }].concat(...ROWS.map((row, r) => [
    { g: 0, speck: .05, draw(x) { roofRow(x, row, HOUSES[r], 'wall'); } },
    { g: 2, grain: .08, baren: .2, draw(x) { roofRow(x, row, HOUSES[r], 'wood'); if (r === 2) tower(x, 'wood'); } },
    { g: 3, grain: .06, baren: .2, draw(x) { roofRow(x, row, HOUSES[r], 'blue'); } },
    { g: 1, grain: .1, baren: .3, draw(x) { roofRow(x, row, HOUSES[r], 'roof'); } },
    { g: 0, speck: .12, draw(x) { roofRow(x, row, HOUSES[r], 'key'); if (r === 2) tower(x, 'key'); } },
  ])),
};

// ———————————————————————————— S2 · 浪尖 (the crest) ————————————————————————————
export const CREST = dense([[-60, 960], [160, 800], [380, 650], [600, 532], [840, 450], [1080, 398], [1300, 374], [1480, 380], [1620, 420], [1720, 500], [1760, 590], [1742, 664]], 8);
const offsetLine = (pts, d) => pts.map((p, i) => { const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)]; let dx = q[0] - o[0], dy = q[1] - o[1]; const L = Math.hypot(dx, dy) || 1; return [p[0] - dy / L * d, p[1] + dx / L * d]; });
export const BODY = CREST.concat([[1700, 700], [1610, 760], [1590, 872], [1900, 872], [1900, 1080], [-60, 1080]]);
const HOLLOW = [[1742, 664], [1700, 700], [1640, 730], [1600, 800], [1592, 872], [1700, 880], [1780, 820], [1800, 720]];
function waveBody(x) {
  x.save(); x.beginPath(); poly(x, BODY); x.clip();
  x.fillStyle = PAL.prusD; x.fillRect(-100, 300, W + 200, H);
  x.filter = 'blur(16px)';
  x.fillStyle = PAL.prus; x.beginPath(); poly(x, CREST.concat(offsetLine(CREST, 300).reverse())); x.fill();
  x.fillStyle = PAL.prusL; x.beginPath(); poly(x, CREST.concat(offsetLine(CREST, 150).reverse())); x.fill();
  x.fillStyle = PAL.sky; x.beginPath(); poly(x, CREST.concat(offsetLine(CREST, 62).reverse())); x.fill();
  x.filter = 'none';
  x.restore();
}
const S2 = {
  id: 's2', K: 1,
  cart: { x: 130, y: 74, title: '浪尖', series: '其二', w: 84, size: 54, seal: '伞' },
  blocks: {
    sky: { g: 4, grain: .07, baren: .3, speck: .14, draw(x) {
      x.save(); x.beginPath(); x.rect(0, 0, W, 566); x.clip();
      x.fillStyle = '#9a9a90'; x.fillRect(0, 0, W, 566);
      bokashi(x, 0, FR.y0, W, 470, SUMI, .92, .05, { rough: 30, seed: 61, ease: .9 });
      bokashi(x, 0, 470, W, 566, PAL.paper, 0, .6, { rough: 12, seed: 62 });
      x.restore();
    } },
    sea: { g: 1, grain: .1, baren: .38, draw(x) {
      x.fillStyle = PAL.prusL; x.fillRect(0, 562, W, H);
      bokashi(x, 0, 562, W, 760, PAL.prus, 0, .8, { rough: 18, seed: 63 });
      bands(x, 580, 1040, 64);
      // front water beyond the breaking wave, then the hollow under the lip, then the wave body
      x.fillStyle = PAL.prusL; x.fillRect(1500, 860, 420, 220); bands(x, 880, 1040, 66);
      x.fillStyle = PAL.prusD; x.beginPath(); smooth(x, HOLLOW, true); x.fill();
      waveBody(x);
    } },
    flow: { g: 0, speck: .08, draw(x) {
      // grouped white flow lines following the back slope (paper left bare)
      x.save(); x.beginPath(); poly(x, BODY); x.clip();
      x.strokeStyle = PAL.white; x.lineCap = 'round';
      for (const [d, a0, a1] of [[84, .1, .5], [96, .12, .47], [108, .15, .44], [170, .04, .42], [182, .07, .38], [194, .1, .35], [270, .0, .3], [282, .02, .27], [294, .04, .24], [120, .52, .82], [132, .54, .8], [144, .56, .78], [210, .45, .7], [222, .47, .68], [234, .5, .66]]) {
        const o = offsetLine(CREST, d), n = o.length; x.lineWidth = 3.2; x.beginPath(); smooth(x, o.slice(Math.floor(a0 * n), Math.floor(a1 * n))); x.stroke();
      }
      x.restore();
      x.fillStyle = PAL.prusD; carve(x, CREST, 4, { taper: [.1, .02], seed: 5 });
      // boats near the horizon: two tiny oshiokuri boats with rowers
      for (const [bx, by] of [[1300, 600], [1480, 612]]) {
        x.fillStyle = PAL.paper; x.beginPath(); x.moveTo(bx - 60, by); x.quadraticCurveTo(bx, by + 12, bx + 64, by - 6); x.lineTo(bx + 50, by + 6); x.quadraticCurveTo(bx, by + 16, bx - 52, by + 6); x.fill();
        x.strokeStyle = SUMI; x.lineWidth = 1.6; x.stroke();
        x.fillStyle = SUMI; for (let k = 0; k < 4; k++) { x.beginPath(); x.arc(bx - 34 + k * 22, by - 4, 3.4, 0, TAU); x.fill(); }
      }
    } },
  },
};
S2.steps = S2.order = null; S2.steps = ['sky', 'sea', 'flow'].map(k => S2.blocks[k]);

// ———————————————————————————— S3 · 远岳初晴 (the mountain and the shore) ————————————————————————————
export const PEAK = [820, 214];
function mtnPts() {
  const p = [], base = 660;
  for (let i = 0; i <= 16; i++) { const s = i / 16; p.push([130 + 620 * s, base - (base - 236) * Math.pow(s, 1.7)]); }
  p.push([772, 222], [800, 214], [826, 226], [846, 216], [880, 230]);
  for (let i = 1; i <= 8; i++) { const s = i / 8; p.push([880 + 240 * s, 230 + 200 * Math.pow(s, 1.35)]); }
  p.push([1150, 438], [1186, 432], [1220, 448]);
  for (let i = 1; i <= 10; i++) { const s = i / 10; p.push([1220 + 400 * s, 448 + (base - 448) * Math.pow(s, .9)]); }
  return p;
}
const MTN = mtnPts();
function snowShape() {
  // the snow cap: everything above y≈340, its lower edge pulled down into narrow pointed drips
  const yl = 345, R = mulberry(77), top = MTN.filter(q => q[1] < yl - 2);
  const xl = 130 + 620 * Math.pow((660 - yl) / (660 - 236), 1 / 1.7), xr = 880 + 240 * Math.pow((yl - 230) / 200, 1 / 1.35);
  const edge = [[xr, yl]], nf = 11, span = xr - xl;
  for (let f = nf - 1; f >= 0; f--) {
    const u = (f + .5 + (R() - .5) * .5) / nf, X = xl + span * u, r = R(), depth = r < .3 ? 70 + R() * 50 : r < .7 ? 32 + R() * 20 : 12, fw = span * (.014 + R() * .016);
    edge.push([X + fw * 2.4, yl - 4 - R() * 6], [X + fw, yl + depth * .35], [X + fw * .15, yl + depth], [X - fw * .5, yl + depth * .4], [X - fw * 2.2, yl - 3 - R() * 8]);
  }
  edge.push([xl, yl]);
  for (let i = 1; i < edge.length; i++) if (edge[i][0] > edge[i - 1][0] - 2) edge[i][0] = edge[i - 1][0] - 2;
  return [[xl, yl]].concat(top, edge);
}
const SNOW = snowShape();
const ROCKS = [[1010, 1080], [1050, 990], [1110, 936], [1240, 912], [1380, 906], [1470, 900], [1560, 888], [1660, 910], [1760, 898], [1890, 904], [1890, 1080]];
const ROCK_FACETS = [[[1110, 936], [1240, 912], [1210, 1000], [1090, 1040]], [[1470, 900], [1560, 888], [1600, 980], [1480, 1010]], [[1660, 910], [1760, 898], [1790, 990]]];
export const CHILD_AT = [1452, 902];
const S3 = {
  id: 's3', K: 2,
  cart: { x: 1790, y: 74, title: '远岳初晴', series: '其三', w: 84, size: 50, seal: '伞' },
  blocks: {
    skyRain: { g: 4, grain: .06, baren: .3, speck: .14, K: 1, draw(x) {
      x.save(); x.beginPath(); x.rect(0, 0, W, 668); x.clip();
      x.fillStyle = '#8f9493'; x.fillRect(0, 0, W, 668);
      bokashi(x, 0, FR.y0, W, 520, SUMI, .95, .08, { rough: 30, seed: 81, ease: .85 });
      bokashi(x, 0, 520, W, 668, PAL.paper, 0, .55, { rough: 14, seed: 82 });
      x.restore();
    } },
    skyDawn: { g: 4, grain: .06, baren: .32, K: 1, draw(x) {
      // the reprint: paper first (it covers the rain sky), then a blue top bokashi and a pale beni horizon
      x.save(); x.beginPath(); x.rect(0, 0, W, 668); x.clip();
      x.fillStyle = PAL.paper; x.fillRect(0, 0, W, 668);
      bokashi(x, 0, FR.y0, W, 360, PAL.prus, .95, 0, { rough: 26, seed: 83, col2: PAL.prusL });
      bokashi(x, 0, 380, W, 668, PAL.beniP, 0, .85, { rough: 20, seed: 84 });
      x.restore();
    } },
    mtn: { g: 1, grain: .035, baren: .32, draw(x) {
      x.save(); x.beginPath(); poly(x, MTN.concat([[1640, 668], [120, 668]])); x.clip();
      const g = x.createLinearGradient(0, 214, 0, 660); g.addColorStop(0, PAL.prusD); g.addColorStop(.5, PAL.prus); g.addColorStop(1, PAL.prusL);
      x.fillStyle = g; x.fillRect(0, 200, W, 480);
      x.fillStyle = rgba(PAL.prusD, .55); x.beginPath(); x.moveTo(846, 216);
      for (let i = 0; i <= 10; i++) { const s = i / 10; x.lineTo(860 + 150 * s + Math.sin(s * 9) * 10, 230 + 430 * s); }
      x.lineTo(1700, 680); x.lineTo(1700, 200); x.closePath(); x.fill();
      bokashi(x, 0, 520, W, 668, PAL.skyL, 0, .9, { rough: 16, seed: 85 });
      x.restore();
      x.fillStyle = PAL.paper; x.beginPath(); poly(x, SNOW); x.fill();
      // sea / bay
      x.fillStyle = PAL.sky; x.fillRect(0, 660, W, H);
      bokashi(x, 0, 760, W, 1042, PAL.prus, 0, .85, { rough: 22, seed: 86 });
      bands(x, 680, 1040, 87);
    } },
    mist: { g: 0, speck: .05, draw(x) {
      kasumi(x, 700, 600, 1240, 58, PAL.paper, .95, .7); kasumi(x, 1380, 560, 760, 40, PAL.paper, .9, .7); kasumi(x, 420, 520, 520, 34, PAL.paper, .85, .7);
    } },
    shore: { g: 2, grain: .1, baren: .24, draw(x) {
      rock(x, ROCKS, { fill: '#6d7a5e', face: '#55644a', facets: ROCK_FACETS });
      { const R = mulberry(301); x.save(); x.beginPath(); poly(x, ROCKS); x.clip(); x.fillStyle = '#3e5a3a';
        for (let i = 0; i < 70; i++) { const px = 1060 + R() * 830, py = 900 + R() * 160; x.beginPath(); x.ellipse(px, py, 4 + R() * 7, 2 + R() * 3, 0, 0, TAU); x.fill(); } x.restore(); }
      // net drying on two poles
      x.fillStyle = PAL.woodD; x.fillRect(1700, 690, 8, 220); x.fillRect(1830, 676, 8, 230);
      x.fillStyle = rgba('#5e4631', .55); x.beginPath(); x.moveTo(1704, 700); x.quadraticCurveTo(1770, 760, 1834, 690); x.lineTo(1834, 860); x.quadraticCurveTo(1770, 900, 1704, 870); x.closePath(); x.fill();
      pine(x, 236, 1080, 1.85, { seed: 3, lean: .55, lines: false, needle: '#3e5a3a' });
      // far left shore strip under the mountain
      x.fillStyle = '#50703c'; x.beginPath(); x.moveTo(44, 672); x.quadraticCurveTo(300, 650, 560, 672); x.lineTo(560, 684); x.lineTo(44, 684); x.fill();
    } },
    key: { g: 0, speck: .12, draw(x) {
      x.fillStyle = SUMI;
      carve(x, wob(MTN.slice(0, 19), 1.4, 2), 3.4, { taper: [.35, .02], seed: 4 });
      carve(x, wob(MTN.slice(18), 1.4, 3), 3.2, { taper: [.02, .4], seed: 5 });
      x.strokeStyle = PAL.prusD; x.lineWidth = 1.6; x.lineJoin = 'round'; x.beginPath(); SNOW.slice(1 + MTN.filter(q => q[1] < 343).length).forEach((q, i) => i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])); x.stroke();
      rock(x, ROCKS, { lines: true, facets: ROCK_FACETS, seed: 9 });
      { const R = mulberry(302); x.save(); x.beginPath(); poly(x, ROCKS); x.clip(); x.strokeStyle = SUMI; x.lineCap = 'round';
        for (let i = 0; i < 46; i++) { const px = 1080 + R() * 800, py = 925 + R() * 130, l = 14 + R() * 26; x.lineWidth = 1.2 + R() * 1.2; x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + l * .5, py - 6, px + l, py + 4 + R() * 6); x.stroke(); } x.restore(); }
      x.strokeStyle = SUMI; x.lineWidth = 1.4; x.strokeRect(1700, 690, 8, 220); x.strokeRect(1830, 676, 8, 230);
      x.lineWidth = .9; for (let k = 0; k <= 8; k++) { const u = k / 8, X = lerp(1704, 1834, u); x.beginPath(); x.moveTo(X, lerp(700, 690, u) + Math.sin(u * Math.PI) * 42); x.lineTo(X, 860 + Math.sin(u * Math.PI) * 30); x.stroke(); }
      for (let k = 0; k <= 7; k++) { const v = k / 7; x.beginPath(); for (let i = 0; i <= 12; i++) { const u = i / 12, X = lerp(1704, 1834, u), Y = lerp(lerp(700, 690, u) + Math.sin(u * Math.PI) * 42, 860 + Math.sin(u * Math.PI) * 30, v); i ? x.lineTo(X, Y) : x.moveTo(X, Y); } x.stroke(); }
      pine(x, 236, 1080, 1.85, { seed: 3, lean: .55, fills: false });
      // foam where the bay meets the rocks (paper), and tiny far sails
      x.strokeStyle = PAL.prusD; x.lineWidth = 1.8; for (const [a, b] of [[1000, 1040], [1060, 960], [1150, 925]]) { x.beginPath(); x.arc(a, b, 26, Math.PI * 1.05, Math.PI * 1.9); x.stroke(); }
      for (const [sx, sy] of [[1290, 700], [1380, 688], [470, 704]]) { x.fillStyle = PAL.paper; x.beginPath(); poly(x, [[sx, sy - 34], [sx + 16, sy], [sx - 3, sy]]); x.fill(); x.lineWidth = 1.3; x.strokeStyle = SUMI; x.stroke(); x.beginPath(); x.moveTo(sx - 12, sy + 2); x.lineTo(sx + 20, sy + 2); x.stroke(); }
    } },
  },
};
S3.steps = ['mtn', 'mist', 'shore', 'key'].map(k => S3.blocks[k]);

export const SHEETS = [S0, S1, S2, S3];
export { deckY, HOUSES, ROWS };
