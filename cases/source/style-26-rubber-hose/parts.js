// parts.js — shared rubber-hose parts: pie eyes, brows, mouths, four-finger gloves, round shoes, hose limbs
// Coordinates are character-local, y positive downwards
import * as T from './toon.js';
import { clamp, lerp, TAU, hash } from '/core/lib.js';
const { shape, stroke, ell, arc, spline, noodle, quad, push, pop, translate, rotate, scale, transform, dot, tx, S } = T;

// 6 grey levels + character white
export const P = { white: '#FAFBFC', paper: '#E8EBED', pale: '#D6DADD', light: '#BCC1C5', mid: '#8C9297', dmid: '#60656A', dark: '#34383B', ink: '#0B0C0E' };   // cool silver-nitrate grey ramp
const D2R = Math.PI / 180;

// ———————————————————— Utilities ————————————————————
// Build a closed outline with width along a centre line (tapering ribbons: steam, fingers, towel edge)
export function ribbon(c, w0, w1 = w0, caps = true) {
  const n = c.length, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const w = lerp(w0, w1, i / (n - 1)) / 2;
    L.push([c[i][0] - dy * w, c[i][1] + dx * w]); R.push([c[i][0] + dy * w, c[i][1] - dx * w]);
  }
  if (!caps) return [...L, ...R.reverse()];
  const e = c[n - 1], e2 = c[n - 2], s0 = c[0], s1 = c[1];
  const aE = Math.atan2(e[1] - e2[1], e[0] - e2[0]), aS = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
  return [...L, ...arc(e[0], e[1], w1 / 2, w1 / 2, aE + Math.PI / 2, aE - Math.PI / 2, 6), ...R.reverse(), ...arc(s0[0], s0[1], w0 / 2, w0 / 2, aS - Math.PI / 2, aS - Math.PI * 1.5, 6)];
}
// "Union outline" of several shapes: stroke all of them thick first, then fill all of them → only the outer contour remains
export function union(list, fill, lw = S.lw) {
  const ps = list.map(pts => shape(pts, { stroke: false }));
  ps.forEach(p => T.outline(p, lw * 2));
  T.g.setTransform(1, 0, 0, 1, 0, 0); T.g.fillStyle = fill; ps.forEach(p => T.g.fill(p));
  return ps;
}
// Draw a local polygon inside a clip, in screen space
export function fillLocal(pts, col) { const s = pts.map(p => tx(p[0], p[1])); const g = T.g; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = col; g.beginPath(); g.moveTo(s[0][0], s[0][1]); for (const q of s) g.lineTo(q[0], q[1]); g.closePath(); g.fill(); }
// Rounded polygon (convex)
export function roundPoly(pts, r) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ra = Math.min(r, la * .45), rc = Math.min(r, lc * .45);
    const p0 = [b[0] + (a[0] - b[0]) / la * ra, b[1] + (a[1] - b[1]) / la * ra], p1 = [b[0] + (c[0] - b[0]) / lc * rc, b[1] + (c[1] - b[1]) / lc * rc];
    out.push(...quad(p0, b, p1, 5));
  }
  return out;
}
function hull(ps) {
  const p = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// ———————————————————— Parts ————————————————————
// Pie-cut eye: white eye socket + big black pupil (a triangular "pie" slice cut out as the highlight)
// o = { lx, ly gaze -1..1, lid 0..1 upper eyelid, lidCol, type: open|wide|happy|squeeze|shut|sad, side: ±1 squint direction }
export function pieEye(cx, cy, rx, ry, o = {}) {
  const type = o.type || 'open', lw = S.lw * (o.lwk ?? .85);
  if (type === 'happy') { stroke(arc(cx, cy + ry * .35, rx * .95, ry * .55, Math.PI * 1.08, Math.PI * 1.92, 14), lw * 1.25); return; }
  if (type === 'shut') { stroke(arc(cx, cy - ry * .15, rx * .95, ry * .4, Math.PI * .1, Math.PI * .9, 12), lw * 1.2); return; }
  if (type === 'squeeze') { const s = o.side ?? 1; stroke([[cx - rx * s, cy - ry * .6], [cx + rx * .8 * s, cy], [cx - rx * s, cy + ry * .6]], lw * 1.35); return; }
  const big = type === 'wide' ? 1.18 : 1;
  const eR = rx * big, eY = ry * big;
  const lx = clamp(o.lx ?? 0, -1, 1), ly = clamp(o.ly ?? 0, -1, 1);
  const pr = type === 'wide' ? .42 : .64, pry = type === 'wide' ? .48 : .74;
  const pcx = cx + lx * eR * (1 - pr) * .95, pcy = cy + ly * eY * (1 - pry) * .9 + eY * .05;
  shape(ell(cx, cy, eR, eY), {
    fill: P.white, lw, shade: () => {
      // pupil: pie shape (a triangle missing towards the upper right)
      const w0 = -100 * D2R, w1 = -40 * D2R, prx = eR * pr, pry2 = eY * pry, pts = [];
      const apx = pcx + Math.cos((w0 + w1) / 2) * prx * .16, apy = pcy + Math.sin((w0 + w1) / 2) * pry2 * .16;
      for (let i = 0; i <= 28; i++) { const a = w1 + i / 28 * (TAU - (w1 - w0)); pts.push([pcx + Math.cos(a) * prx, pcy + Math.sin(a) * pry2]); }
      pts.push([apx, apy]);
      fillLocal(pts, P.ink);
      if (o.lid) { const yl = cy - eY + o.lid * 2 * eY; fillLocal([[cx - eR * 1.2, cy - eY * 1.3], [cx + eR * 1.2, cy - eY * 1.3], [cx + eR * 1.2, yl + (o.lidTilt || 0) * eR], [cx - eR * 1.2, yl - (o.lidTilt || 0) * eR]], o.lidCol || P.white); }
    }
  });
  if (o.lid) { const yl = cy - eY + o.lid * 2 * eY, hw = Math.sqrt(Math.max(0, 1 - Math.pow((yl - cy) / eY, 2))) * eR; if (hw > 2) stroke([[cx - hw, yl - (o.lidTilt || 0) * hw], [cx + hw, yl + (o.lidTilt || 0) * hw]], lw * 1.05); }
}
// Eyebrows: short thick arcs, type: up (surprised) sad (slanting down at the outer ends) angry determined
export function brow(cx, cy, w, type, side = 1) {
  // side = -1 left eye / +1 right eye; inner = the end near the bridge of the nose
  const s = side, lw = S.lw * 1.15, ix = cx - s * w * .5, ox = cx + s * w * .5;
  if (type === 'up') stroke(arc(cx, cy + w * .5, w * .55, w * .4, Math.PI * 1.15, Math.PI * 1.85, 10), lw);
  else if (type === 'sad') stroke(quad([ix, cy - w * .36], [cx, cy - w * .14], [ox, cy + w * .06]), lw);
  else if (type === 'angry') stroke(quad([ix, cy + w * .14], [cx, cy - w * .06], [ox, cy - w * .3]), lw);
  else if (type === 'flat') stroke([[cx - w * .45, cy], [cx + w * .45, cy]], lw);
}
// Mouth: smile / grin / open / o / frown / wavy / pucker / beam / yawn / flat
export function mouth(cx, cy, w, type = 'smile', o = {}) {
  const lw = S.lw * .95, h = w * (o.open ?? .6);
  const tongue = (pts) => () => { fillLocal(pts, P.dmid); };
  if (type === 'smile') { stroke(quad([cx - w / 2, cy - w * .08], [cx, cy + w * .32], [cx + w / 2, cy - w * .08]), lw * 1.1); stroke(arc(cx - w / 2 - 2, cy - w * .08, w * .09, w * .09, Math.PI * .6, Math.PI * 1.4, 6), lw * .8); stroke(arc(cx + w / 2 + 2, cy - w * .08, w * .09, w * .09, -Math.PI * .4, Math.PI * .4, 6), lw * .8); return; }
  if (type === 'frown') { stroke(quad([cx - w / 2, cy + w * .12], [cx, cy - w * .22], [cx + w / 2, cy + w * .12]), lw * 1.1); return; }
  if (type === 'flat') { stroke([[cx - w * .4, cy], [cx + w * .4, cy + 2]], lw * 1.1); return; }
  if (type === 'pucker') { // bitter: a small mouth scrunched up + two wrinkles
    stroke(spline([[cx - w * .28, cy], [cx - w * .14, cy - w * .1], [cx, cy + w * .06], [cx + w * .14, cy - w * .1], [cx + w * .28, cy]], false, 6), lw * 1.1);
    stroke(arc(cx - w * .42, cy - w * .02, w * .1, w * .16, Math.PI * .55, Math.PI * 1.45, 6), lw * .7); stroke(arc(cx + w * .42, cy - w * .02, w * .1, w * .16, -Math.PI * .45, Math.PI * .45, 6), lw * .7); return;
  }
  if (type === 'wavy') { // scared: wavy open mouth
    const top = [], bot = []; for (let i = 0; i <= 12; i++) { const u = i / 12, x = cx - w / 2 + u * w; top.push([x, cy - h * .25 + Math.sin(u * TAU * 2) * w * .05]); bot.push([x, cy + h * .35 + Math.sin(u * TAU * 2 + 1) * w * .05]); }
    shape([...top, ...bot.reverse()], { fill: P.ink, lw }); return;
  }
  if (type === 'o') { const r = w * .22; shape(ell(cx, cy + r * .2, r, r * 1.25 * (o.open ?? 1)), { fill: P.ink, lw, shade: tongue(ell(cx, cy + r * 1.25, r * .75, r * .55)) }); return; }
  if (type === 'bleh') { // blech: open mouth + tongue hanging out
    mouth(cx, cy, w, 'open', { open: .45 });
    shape(spline([[cx - w * .16, cy + w * .14], [cx - w * .2, cy + w * .42], [cx, cy + w * .58], [cx + w * .2, cy + w * .42], [cx + w * .16, cy + w * .14]], true, 6), { fill: P.dmid, lw: lw * .9 });
    stroke([[cx, cy + w * .2], [cx, cy + w * .42]], lw * .6); return;
  }
  if (type === 'yawn') { const r = w * .3; shape(ell(cx, cy + r * .5, r, r * 1.5), { fill: P.ink, lw, shade: tongue(ell(cx, cy + r * 1.6, r * .8, r * .6)) }); return; }
  // grin / open / beam: slightly curved top edge, big U bottom edge
  const up = type === 'beam' ? .1 : (type === 'grin' ? .04 : -.02);
  const pts = [...quad([cx - w / 2, cy - w * up], [cx, cy + w * (up * .6)], [cx + w / 2, cy - w * up], 10), ...quad([cx + w / 2, cy - w * up], [cx, cy + h * 1.55], [cx - w / 2, cy - w * up], 14).slice(1)];
  shape(pts, {
    fill: P.ink, lw, shade: () => {
      fillLocal(ell(cx, cy + h * .95, w * .26, h * .42), P.dmid);
      if (type === 'grin' || type === 'beam') fillLocal([[cx - w / 2, cy - w * up - 20], [cx + w / 2, cy - w * up - 20], [cx + w / 2, cy + h * .18], [cx - w / 2, cy + h * .18]], P.white);
    }
  });
  if (type === 'grin' || type === 'beam') { stroke(arc(cx - w / 2 - 3, cy - w * up, w * .08, w * .1, Math.PI * .5, Math.PI * 1.5, 6), lw * .8); stroke(arc(cx + w / 2 + 3, cy - w * up, w * .08, w * .1, -Math.PI * .5, Math.PI * .5, 6), lw * .8); }
}

// White glove: in local coordinates the wrist is at the origin, fingers point +x; type: open fist point grab wave thumb
export function glove(x, y, ang, type = 'open', k = 1, o = {}) {
  push(); translate(x, y); rotate(ang); scale(k, k * (o.flip ? -1 : 1));
  const fw = 13.5, parts = [];
  const finger = (a, len, w = fw, curl = 0) => { const b = [22 + Math.cos(a * D2R) * len, Math.sin(a * D2R) * len]; const c = [22 + Math.cos(a * D2R) * len * .55 + Math.cos((a + 90) * D2R) * curl, Math.sin(a * D2R) * len * .55 + Math.sin((a + 90) * D2R) * curl]; parts.push(ribbon(quad([22, 0], c, b, 8), w, w * .96)); };
  if (type === 'open' || type === 'wave') { finger(-34, 30); finger(-4, 33); finger(27, 29); finger(-88, 22, fw * 1.05); }
  else if (type === 'point') { finger(-6, 44, fw * .95); finger(-95, 18, fw * 1.05); }
  else if (type === 'grab') { finger(-26, 24, fw, 9); finger(2, 26, fw, 9); finger(28, 22, fw, 9); finger(-88, 19, fw * 1.05); }
  else if (type === 'thumb') { finger(-90, 26, fw * 1.1); }
  else if (type === 'fist') { finger(-90, 14, fw * 1.1); }
  const palmR = type === 'fist' || type === 'point' || type === 'thumb' ? 19 : 17;
  parts.push(ell(22, 0, palmR, palmR * .95, 26));
  const cuff = spline([[-6, -12], [4, -20], [11, -15], [11, 15], [4, 20], [-6, 12], [-8, 0]], true, 5);
  union([...parts, cuff], P.white);
  // stitching on the back of the hand + cuff fold
  const lw = S.lw * .6;
  if (type !== 'fist' && type !== 'point' && type !== 'thumb') { for (const dy of [-6, 0, 6]) stroke([[14, dy * 1.1], [25, dy * 1.4]], lw, { boil: .5 }); }
  else { stroke(arc(30, 0, 9, 13, -1.2, 1.2, 8), lw); stroke([[31, -6], [38, -7]], lw); stroke([[31, 6], [38, 7]], lw); }
  stroke(quad([2, -16], [6, 0], [2, 16]), lw);
  pop();
}
// Big round-toed shoe (black): in local coordinates the heel is at the origin, toe points +x (dir = ±1)
export function shoe(x, y, dir = 1, k = 1, ang = 0) {
  push(); translate(x, y); rotate(ang); scale(dir * k, k);
  shape(spline([[-15, 0], [-17, -12], [-6, -19], [10, -21], [27, -18], [37, -8], [34, 3], [12, 5], [-8, 4]], true, 6), { fill: P.ink, lw: S.lw * .9 });
  shape(ell(22, -12, 7, 3.6, 12, 0), { fill: P.white, stroke: false, boil: .3 });
  pop();
}
// Rubber-hose limbs: constant-width hose (a→b, bend = amount of bend)
export const hose = (a, b, bend, w, col = P.ink) => shape(noodle(a, b, bend, w, w), { fill: col, lw: S.lw * .8 });

// Steam: a few wisps rising from (x,y); type: lazy bitter up heart sad none; t drives the drift
export function steam(x, y, type = 'lazy', t = 0, k = 1) {
  if (type === 'none') return;
  const lw = S.lw * .8, col = type === 'bitter' ? P.mid : P.white;
  if (type === 'sad') { // one wisp of steam droops like a wilted flower
    const c = spline([[x - 8 * k, y], [x - 14 * k, y - 42 * k], [x + 4 * k, y - 76 * k], [x + 36 * k, y - 70 * k], [x + 46 * k, y - 44 * k + Math.sin(t * 4) * 3 * k]], false, 6);
    shape(ribbon(c, 14 * k, 4 * k), { fill: col, lw }); return;
  }
  const wisps = type === 'heart' ? [] : [[-26, 0, .9], [2, .4, 1.1], [28, .8, .85]];
  for (const [dx, ph, sc] of wisps) {
    const c = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16, hgt = 110 * sc * k;
      let px = x + dx * k, py = y - u * hgt;
      if (type === 'lazy') { px += Math.sin(u * 5 + t * 5 + ph * 7) * 10 * u * k; py += u * u * 30 * k; px += u * u * 22 * k * Math.sign(dx || 1); }
      if (type === 'bitter') { px += ((i % 4 < 2) ? 1 : -1) * 13 * k * (.5 + u); }
      if (type === 'blown') { px = x + dx * .4 * k - u * hgt * 1.1; py = y - u * 36 * k + Math.sin(u * 7 + t * 16 + ph * 5) * 7 * k * u + dx * .3 * k; }
      if (type === 'up') { px += Math.sin(i * 2.7 + t * 30) * 2 * k; py -= u * 20 * k; }
      if (type === 'sad') { const sd = dx > 5 ? 1 : dx < -5 ? -1 : 0; px = x + dx * .6 * k + sd * Math.sin(u * 2.2) * 46 * k * sc + (sd ? 0 : Math.sin(u * 4) * 6 * k); py = y - (sd ? Math.sin(u * 2.6) * 44 : u * 50) * k * sc; }
      c.push([px, py]);
    }
    const pts = type === 'bitter' ? c.filter((_, i) => i % 2 === 0) : spline(c.filter((_, i) => i % 2 === 0), false, 5);
    shape(ribbon(pts, (type === 'bitter' ? 16 : 13) * k, (type === 'bitter' ? 5 : 3) * k), { fill: col, lw });
  }
  if (type === 'heart') {
    // two wisps rise from the rim and curl into a heart at the top
    const hy = y - 95 * k, r = 26 * k;
    const L = [[x, y - 4 * k], [x - 8 * k, y - 30 * k], [x - 34 * k, hy + 34 * k], [x - 2 * r, hy], [x - r * 1.4, hy - r * 1.05], [x - r * .4, hy - r * .95], [x, hy - r * .35]];
    const R = L.map(p => [2 * x - p[0], p[1]]);
    shape(ribbon(spline(L, false, 6), 12 * k, 8 * k), { fill: P.white, lw });
    shape(ribbon(spline(R, false, 6), 12 * k, 8 * k), { fill: P.white, lw });
  }
}

