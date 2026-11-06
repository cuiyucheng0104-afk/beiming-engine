// The rose window of a secular stone hall: a centre medallion (the phoenix), twelve feather petals,
// an outer ring of roundels, stone tracery, a splayed wall, a sill and a carved band. World units, y down.
import { mulberry, hash } from '/core/lib.js';
import { COL, smooth, circle, brush, softPoly, INK } from './glass.js';

export const FLOOR = 1000;                 // wall base (floor line)
export const R_OUT = 470, R_PET0 = 236, R_PET1 = 398, R_MED = 214, R_IN = 192;
export const SILL = 540, CARVE_Y = 668;    // sill top; carved inscription centre line
export const NPET = 12;
export const petalAng = i => Math.PI - i * Math.PI * 2 / NPET;      // petal 0 points left (9 o'clock), then clockwise over the top
// order in which the morning light reaches the petals (left to right): groups of petal indices
export const PETAL_GROUPS = [[0], [1, 11], [2, 10], [3, 9], [4, 8], [5, 7], [6]];

// ---------- precomputed geometry ----------
function petalPts(a, r0, r1, half) {
  const c = Math.cos, s = Math.sin, a0 = a - half, a1 = a + half;
  return [[c(a0) * r0, s(a0) * r0, 1], [c(a0 - .02) * (r0 + (r1 - r0) * .45), s(a0 - .02) * (r0 + (r1 - r0) * .45)], [c(a - half * .55) * r1 * .95, s(a - half * .55) * r1 * .95],
    [c(a) * r1, s(a) * r1, 1], [c(a + half * .55) * r1 * .95, s(a + half * .55) * r1 * .95], [c(a1 + .02) * (r0 + (r1 - r0) * .45), s(a1 + .02) * (r0 + (r1 - r0) * .45)], [c(a1) * r0, s(a1) * r0, 1]];
}
export function lozenges(box, d, seed, keep) {
  const J = (k, m) => [k * d + (hash(k * 12.9 + m * 78.2 + seed) - .5) * d * .34, m * d + (hash(k * 39.3 + m * 11.1 + seed * 3) - .5) * d * .34];
  const out = [];
  for (let b = Math.floor(box[1] / d) - 1; b <= Math.ceil(box[3] / d) + 1; b++)
    for (let a = Math.floor(box[0] / d) - 1; a <= Math.ceil(box[2] / d) + 1; a++) {
      if ((a + b) & 1) continue;
      const c = [a * d, b * d]; if (keep && !keep(c)) continue;
      const pts = [J(a - 1, b), J(a, b - 1), J(a + 1, b), J(a, b + 1)];
      const h = hash(a * 3.3 + b * 7.9 + seed);
      out.push({ pts, path: softPoly(pts, .12), c, col: h < .12 ? COL.blue2 : h < .24 ? COL.deepblue : COL.cobalt, id: seed * 1000 + (a + 500) * 97 + b, curl: hash(a * 5.1 + b * 2.3 + seed) });
    }
  return out;
}
export function vineCurl(g, c, d, h) {
  const [x, y] = c, s = h > .5 ? 1 : -1, r = d * .32;
  brush(g, [[x - r * s, y + r * .6], [x - r * .2 * s, y - r * .4], [x + r * .5 * s, y - r * .2], [x + r * .35 * s, y + r * .35], [x, y + r * .15]], d * .09, { w0: .3, w1: .15, color: 'rgba(30,24,40,.42)' });
  g.fillStyle = 'rgba(30,24,40,.38)'; g.beginPath(); g.arc(x - r * s, y + r * .6, d * .06, 0, 7); g.fill();
}
const GEO = (() => {
  const petals = [];
  for (let i = 0; i < NPET; i++) {
    const a = petalAng(i), half = Math.PI / NPET * .86;
    const outer = smooth(petalPts(a, R_PET0, R_PET1, half)), inner = smooth(petalPts(a, R_PET0 + 12, R_PET1 - 14, half * .8));
    // a single feather inside each petal (the phoenix's hours)
    const fl = (R_PET1 - R_PET0) * .78, fc = (R_PET0 + R_PET1) / 2 + 2, c = Math.cos, s = Math.sin, px = -s(a), py = c(a);
    const P = (u, v) => [c(a) * (fc + u) + px * v, s(a) * (fc + u) + py * v];
    const feather = smooth([P(-fl * .5, 0), P(-fl * .3, 9), P(0, 15), P(fl * .3, 11), P(fl * .5, 0)]);
    const eye = circle(...P(fl * .18, 0), 9);
    petals.push({ a, outer, inner, feather, eye, P, fl, ground: i % 2 ? COL.ruby : COL.cobalt, fcol: i % 2 ? COL.gold : COL.gold2, id: 6000 + i * 10 });
  }
  const ring = [];
  for (let k = 0; k < 24; k++) { const a = Math.PI - (k + .5) * Math.PI * 2 / 24, r = (R_PET1 + R_OUT) / 2 + 2; ring.push({ a, p: circle(Math.cos(a) * r, Math.sin(a) * r, 21), q: circle(Math.cos(a) * r, Math.sin(a) * r, 9), c: k % 2 ? COL.white : COL.gold, c2: k % 3 ? COL.ruby : COL.green, id: 7000 + k * 3 }); }
  const pearls = []; for (let k = 0; k < 64; k++) { const a = k / 64 * Math.PI * 2; pearls.push([Math.cos(a) * (R_MED - 6), Math.sin(a) * (R_MED - 6)]); }
  const quarry = lozenges([-R_IN - 30, -R_IN - 30, R_IN + 30, R_IN + 30], 30, 41, c => Math.hypot(c[0], c[1]) < R_IN + 30);
  const outerFill = lozenges([-R_OUT - 20, -R_OUT - 20, R_OUT + 20, R_OUT + 20], 26, 53, c => { const r = Math.hypot(c[0], c[1]); return r > R_PET0 - 30 && r < R_OUT + 20; });
  return { petals, ring, pearls, quarry, outerFill };
})();
export const PETALS = GEO.petals;

// which lighting group an angle belongs to (for the outer ring and the filler between petals)
export function groupOfAngle(a) {
  let best = 0, bd = 9;
  for (let i = 0; i < NPET; i++) { let d = Math.abs(((a - petalAng(i)) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); if (d < bd) { bd = d; best = i; } }
  return PETAL_GROUPS.findIndex(g => g.includes(best));
}

// ---------- the outer window (everything except the medallion contents) ----------
// lit(gi) -> [sun, fire, crack] for petal group gi
export function drawOuter(P, lit, o = {}) {
  const ang = q => Math.atan2(q[1], q[0]);
  // filler quarries behind the petals (one network)
  P.save(); const ann = new Path2D(); ann.arc(0, 0, R_OUT, 0, Math.PI * 2); ann.arc(0, 0, R_PET0 - 4, 0, Math.PI * 2, true); P.clip(ann);
  for (const c of GEO.outerFill) P.piece(c.path, c.col, { id: c.id, lead: 3.6, mat: false, edge: 5, lit: lit(groupOfAngle(ang(c.c))), paint: g => vineCurl(g, c.c, 40, c.curl) });
  P.restore();
  // outer ring of roundels
  for (const q of GEO.ring) {
    const L = lit(groupOfAngle(q.a));
    P.piece(q.p, q.c, { id: q.id, lead: 4.5, matW: 7, lit: L });
    P.piece(q.q, q.c2, { id: q.id + 1, lead: 3, matW: 4, lit: L });
  }
  // petals: coloured ground, white fillet, a feather with an eye
  GEO.petals.forEach((p, i) => {
    const gi = PETAL_GROUPS.findIndex(g => g.includes(i)), L = lit(gi);
    P.piece(p.outer, COL.white, { id: p.id, lead: 5.5, mat: false, edge: 4, lit: L });
    P.piece(p.inner, p.ground, { id: p.id + 1, lead: 5, matW: 12, lit: L, wash: .18 });
    P.piece(p.feather, p.fcol, { id: p.id + 2, lead: 4.5, matW: 7, lit: L, paint: g => {
      const n = 9; for (let k = 1; k < n; k++) { const u = -p.fl * .45 + k / n * p.fl * .9; brush(g, [p.P(u, 0), p.P(u + 6, 9), p.P(u + 12, 13)], 1.6, { color: 'rgba(60,30,10,.55)' }); brush(g, [p.P(u, 0), p.P(u + 6, -9), p.P(u + 12, -13)], 1.6, { color: 'rgba(60,30,10,.55)' }); }
      brush(g, [p.P(-p.fl * .5, 0), p.P(0, 0), p.P(p.fl * .5, 0)], 2.4, { color: INK });
      brush(g, [p.P(-p.fl * .3, -6), p.P(p.fl * .2, -9)], 1.8, { color: g.__col, w0: .1, w1: .1 });
    } });
    P.piece(p.eye, i % 2 ? COL.green : COL.ruby, { id: p.id + 3, lead: 3.5, matW: 4, lit: L, paint: g => { const c = p.P(p.fl * .18, 0); g.fillStyle = INK; g.beginPath(); g.arc(c[0], c[1], 3.2, 0, 7); g.fill(); } });
  });
  // the medallion's border: ruby band with gold pearls, white fillet with a vine
  const ML = o.medLit || [0, 0, 0];
  const band = new Path2D(); band.arc(0, 0, R_MED, 0, Math.PI * 2); band.arc(0, 0, R_IN + 9, 0, Math.PI * 2, true);
  P.piece(band, COL.ruby, { id: 7900, lead: 5, mat: false, edge: 4, lit: ML });
  const fil = new Path2D(); fil.arc(0, 0, R_IN + 9, 0, Math.PI * 2); fil.arc(0, 0, R_IN, 0, Math.PI * 2, true);
  P.piece(fil, COL.white, { id: 7901, lead: 4, mat: false, edge: 3, lit: ML, paint: g => {
    g.strokeStyle = 'rgba(44,26,12,.7)'; g.lineWidth = 1.4; g.beginPath();
    for (let k = 0; k <= 180; k++) { const a = k / 180 * Math.PI * 2, r = R_IN + 4.5 + Math.sin(k * 1.2) * 2.6; k ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); } g.stroke(); } });
  for (const [x, y] of GEO.pearls) P.piece(circle(x, y, 3.6), COL.gold, { id: 7910 + x + y * 3, lead: 2.4, mat: false, lit: ML });
}
export function medallionClip() { const p = new Path2D(); p.arc(0, 0, R_IN, 0, Math.PI * 2); return p; }
export function drawQuarries(P, L) {
  for (const c of GEO.quarry) P.piece(c.path, c.col, { id: c.id, lead: 3.8, mat: false, edge: 6, lit: L, paint: g => vineCurl(g, c.c, 44, c.curl) });
}

// ---------- stone ----------
let stoneTex = null;
function stonePattern(ctx) {
  if (!stoneTex) {
    const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d'); const im = x.createImageData(512, 512);
    const rnd = mulberry(9);
    const N = (u, v, f) => { const X = u * f, Y = v * f; const i = Math.floor(X), j = Math.floor(Y), a = X - i, b = Y - j; const h = (p, q) => hash((p % f + f) % f * 57.1 + (q % f + f) % f * 131.7); const s = t => t * t * (3 - 2 * t);
      return (h(i, j) * (1 - s(a)) + h(i + 1, j) * s(a)) * (1 - s(b)) + (h(i, j + 1) * (1 - s(a)) + h(i + 1, j + 1) * s(a)) * s(b); };
    for (let j = 0; j < 512; j++) for (let i = 0; i < 512; i++) {
      const u = i / 512, v = j / 512; const n = N(u, v, 4) * .45 + N(u, v, 16) * .3 + N(u, v, 64) * .17 + rnd() * .08;
      const k = (i + j * 512) * 4, val = 150 + (n - .5) * 120; im.data[k] = val; im.data[k + 1] = val * .96; im.data[k + 2] = val * .9; im.data[k + 3] = 255;
    }
    x.putImageData(im, 0, 0); stoneTex = c;
  }
  return ctx.createPattern(stoneTex, 'repeat');
}
export function drawStone(S, M, view, o = {}) {
  S.setTransform(M);
  const pat = stonePattern(S); pat.setTransform(new DOMMatrix().scale(.55));
  const [vx0, vy0, vx1, vy1] = view;
  for (let row = -40; row < 40; row++) {   // ashlar courses
    const CH = 92, y0 = FLOOR - (row + 1) * CH, y1 = y0 + CH; if (y1 < vy0 - 10 || y0 > vy1 + 10 || y0 >= FLOOR) continue;
    let x = -3200 + hash(row * 7.3) * 160;
    while (x < 3200) {
      const w = 150 + hash(row * 13.1 + x * .01) * 140;
      if (x + w > vx0 - 10 && x < vx1 + 10) { const t = .78 + hash(row * 3.7 + x * .13) * .3; S.fillStyle = `rgb(${(128 * t) | 0},${(118 * t) | 0},${(104 * t) | 0})`; S.fillRect(x + 2, y0 + 2, w - 4, CH - 4); }
      x += w;
    }
  }
  S.globalCompositeOperation = 'destination-over'; S.fillStyle = '#403a33'; S.fillRect(vx0 - 20, vy0 - 20, vx1 - vx0 + 40, Math.min(FLOOR, vy1 + 20) - vy0 + 20);
  S.globalCompositeOperation = 'source-over';
  // splayed embrasure: moulded rings, lighter toward the glass
  const rings = [[R_OUT + 92, '#6c6354'], [R_OUT + 76, '#958a76'], [R_OUT + 58, '#7a705f'], [R_OUT + 44, '#a39883'], [R_OUT + 26, '#8c826f'], [R_OUT + 12, '#b3a892']];
  for (const [r, col] of rings) { S.fillStyle = col; S.beginPath(); S.arc(0, 0, r, 0, 7); S.fill(); }
  // voussoir joints on the outer ring
  S.strokeStyle = 'rgba(40,34,28,.45)'; S.lineWidth = 3;
  for (let k = 0; k < 36; k++) { const a = k / 36 * Math.PI * 2; S.beginPath(); S.moveTo(Math.cos(a) * (R_OUT + 44), Math.sin(a) * (R_OUT + 44)); S.lineTo(Math.cos(a) * (R_OUT + 92), Math.sin(a) * (R_OUT + 92)); S.stroke(); }
  // sill and carved band
  S.fillStyle = '#a39883'; S.fillRect(-780, SILL, 1560, 40); S.fillStyle = '#6e6556'; S.fillRect(-780, SILL + 40, 1560, 9);
  S.fillStyle = '#756c5d'; S.fillRect(-560, CARVE_Y - 66, 1120, 132);   // the band is ~30 % darker than the sill so the gilt reads S.fillStyle = '#6e6556'; S.fillRect(-560, CARVE_Y + 66, 1120, 9); S.fillRect(-560, CARVE_Y - 72, 1120, 6);
  S.fillStyle = '#9d927d'; S.fillRect(-2400, FLOOR - 46, 4800, 46); S.fillStyle = 'rgba(30,26,22,.5)'; S.fillRect(-2400, FLOOR - 8, 4800, 8);   // plinth
  S.globalCompositeOperation = 'multiply'; S.globalAlpha = .55; S.fillStyle = pat; S.fillRect(vx0, vy0, vx1 - vx0, Math.min(FLOOR, vy1) - vy0);
  S.globalAlpha = 1; S.globalCompositeOperation = 'source-over';
  if (o.carve) carve(S, o.carve);
  S.globalCompositeOperation = 'destination-out'; S.fillStyle = '#000'; S.beginPath(); S.arc(0, 0, R_OUT, 0, 7); S.fill(); S.globalCompositeOperation = 'source-over';
}
export const CARVE_TEXT = '浴火重生', CARVE_SIZE = 92, CARVE_GAP = 150;
function carve(S, c) {
  S.font = `900 ${CARVE_SIZE}px "Noto Serif SC"`; S.textAlign = 'center'; S.textBaseline = 'middle';
  [...CARVE_TEXT].forEach((ch, i) => {
    const x = (i - 1.5) * CARVE_GAP, al = Math.max(0, Math.min(1, (c.sx - x + 60) / 160)); if (al <= 0) return;
    S.globalAlpha = al;
    S.fillStyle = 'rgba(255,240,205,.62)'; S.fillText(ch, x + 1, CARVE_Y + 4);   // bright lower lip
    S.lineJoin = 'round'; S.strokeStyle = 'rgba(16,12,8,.95)'; S.lineWidth = 7; S.strokeText(ch, x, CARVE_Y);   // the deep cut: a dark groove around each stroke
    S.fillStyle = 'rgba(16,12,8,.95)'; S.fillText(ch, x, CARVE_Y);
    if (c.gild > 0) { S.fillStyle = `rgba(246,196,92,${c.gild})`; S.fillText(ch, x - 1, CARVE_Y - 1); }
  });
  S.globalAlpha = 1;
}
// the carved text box in world units (for TEXTS / readcheck)
export const CARVE_BOX = [-1.5 * CARVE_GAP - CARVE_SIZE * .55, CARVE_Y - CARVE_SIZE * .55, 1.5 * CARVE_GAP + CARVE_SIZE * .55, CARVE_Y + CARVE_SIZE * .55];

// ---------- tracery (stone over the glass) ----------
export function drawTracery(S, M, proj = false) {
  S.setTransform(M);
  const stone = (w, col) => { S.lineWidth = w; S.strokeStyle = proj ? '#000' : col; };
  for (let i = 0; i < NPET; i++) {   // spokes between the petals
    const a = petalAng(i) + Math.PI / NPET;
    S.save(); S.rotate(a); S.fillStyle = proj ? '#000' : '#a3987f'; S.fillRect(R_MED + 6, -7, R_PET1 - R_MED + 4, 14); if (!proj) { S.fillStyle = 'rgba(40,34,28,.35)'; S.fillRect(R_MED + 6, 3, R_PET1 - R_MED + 4, 4); } S.restore();
  }
  stone(16, '#a99e86'); S.beginPath(); S.arc(0, 0, R_MED + 8, 0, 7); S.stroke();
  if (!proj) { stone(4, 'rgba(40,34,28,.4)'); S.beginPath(); S.arc(0, 0, R_MED + 14, 0, 7); S.stroke(); }
  stone(14, '#a3987f'); S.beginPath(); S.arc(0, 0, R_PET1 + 8, 0, 7); S.stroke();
  stone(12, '#ada28a'); S.beginPath(); S.arc(0, 0, R_OUT - 2, 0, 7); S.stroke();
  // iron saddle bars across the outer rings (they stop at the medallion's stone ring)
  S.fillStyle = proj ? '#000' : '#17181b';
}
