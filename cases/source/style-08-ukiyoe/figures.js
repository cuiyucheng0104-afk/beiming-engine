// Figures for 一伞三景: the janome umbrella, the woman on the bridge, the fisher child.
// Every draw function takes a `pass`: 'red' | 'blue' | 'wood' | 'skin' | 'pale' | 'key' | 'all', so the opening print can lay each colour block separately.
import { clamp, lerp, TAU } from '/core/lib.js';
import { PAL, smooth, poly } from './print.js';

const INK = PAL.sumi;
const BENI_D = '#8a2e22', BAMBOO = '#c9a45c', KIMONO = '#2c4a70', KIMONO_D = '#1f3656', OBI = '#cf9f4a', HAIR = '#1b1816';
const has = (pass, k) => pass === 'all' || pass === k;
function shape(x, pts, fill, lw, closed = true, sm = true) {
  x.beginPath(); sm ? smooth(x, pts, closed) : poly(x, pts);
  if (fill) { x.fillStyle = fill; x.fill(); }
  if (lw) { x.lineWidth = lw; x.strokeStyle = INK; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke(); }
}
function limb(pts, ws) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    L.push([pts[i][0] - dy * ws[i] / 2, pts[i][1] + dx * ws[i] / 2]); R.push([pts[i][0] + dy * ws[i] / 2, pts[i][1] - dx * ws[i] / 2]);
  }
  return L.concat(R.reverse());
}
// two-bone arm from shoulder to hand, elbow bent to side `bend` (+1 / −1)
function arm2(sh, hand, len, bend = 1) {
  const dx = hand[0] - sh[0], dy = hand[1] - sh[1], d = Math.min(Math.hypot(dx, dy), len * 1.98), m = [(sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2];
  const h = Math.sqrt(Math.max(0, len * len - d * d / 4)), nx = -dy / (Math.hypot(dx, dy) || 1), ny = dx / (Math.hypot(dx, dy) || 1);
  return [sh, [m[0] + nx * h * bend, m[1] + ny * h * bend], hand];
}

// ————————————————— Janome umbrella —————————————————
// local frame: canopy rim centre at (0,0), handle down +y. R = canopy radius. inv: 1 = open dome, −1 = blown inside out.
// spin: rib phase (radians), the canopy turning about its handle. flap: 0–1 squash of the canopy.
export const UMB = { R: 70, H: 40, L: 84 };
export function umbrella(x, cx, cy, rot, sc, o = {}, pass = 'all') {
  const { inv = 1, spin = 0, flap = 0, lw = 2.2, view = 0 } = o;
  // view: 0 = seen from the side, 1 = seen from well below (rim opens into an ellipse, the ribbed underside shows)
  const R = UMB.R, Hs = UMB.H * inv * (inv < 0 ? 1.35 + .55 * Math.min(1, -inv) : 1) * (1 - .25 * flap) * (1 - .5 * view), e = R * (.2 + .62 * view) * (1 - .35 * flap), L = UMB.L;
  x.save(); x.translate(cx, cy); x.rotate(rot); x.scale(sc * (1 + .06 * flap), sc);
  const LW = lw / sc * Math.max(.75, Math.min(1.25, sc));
  const dome = (r, s) => [r * R * Math.cos(s), -Hs * Math.pow(Math.max(0, 1 - r * r), .8) + e * r * Math.sin(s)];
  // silhouette: upper dome curve + lower rim half-ellipse
  const top = []; for (let i = 0; i <= 24; i++) { const u = -1 + 2 * i / 24; top.push([u * R, -Hs * Math.pow(Math.max(0, 1 - u * u), .8)]); }
  const rimLow = []; for (let i = 0; i <= 24; i++) { const a = Math.PI * i / 24; rimLow.push([R * Math.cos(a), e * Math.sin(a)]); }
  const rimUp = rimLow.map(([a, b]) => [a, -b]);
  const outer = top.concat(rimLow.slice(1, -1));
  // handle (behind the canopy when open)
  const handle = () => {
    if (has(pass, 'wood')) { x.fillStyle = BAMBOO; x.fillRect(-2.6, -Hs * .9, 5.2, L + Hs * .9); x.fillStyle = INK; x.fillRect(-3.2, L * .72, 6.4, L * .28); }
    if (has(pass, 'key')) { x.strokeStyle = INK; x.lineWidth = LW * .8; x.strokeRect(-2.6, -Hs * .9, 5.2, L * .72 + Hs * .9); }
  };
  if (inv > 0) handle();
  if (has(pass, 'red')) {
    x.fillStyle = inv > 0 ? PAL.beni : BENI_D; x.beginPath(); poly(x, outer); x.fill();
    // the underside seen from below: the strip between the upper and lower rim arcs
    x.fillStyle = inv > 0 ? BENI_D : PAL.beni; x.beginPath(); poly(x, rimUp.concat(rimLow.slice().reverse())); x.fill();
  }
  if (has(pass, 'pale')) {
    // janome ring (paper left bare): band between r1 and r2 on the front half of the dome
    const r1 = .5, r2 = .66, A = [], B = [];
    for (let i = 0; i <= 20; i++) { const s = Math.PI * i / 20; A.push(dome(r1, s)); B.push(dome(r2, s)); }
    if (inv > 0) { x.fillStyle = '#f1e6cb'; x.beginPath(); poly(x, A.concat(B.slice().reverse())); x.fill(); }
  }
  if (has(pass, 'wood')) {
    // underside ribs (bamboo) radiating from the handle top
    x.strokeStyle = '#d9b46a'; x.lineWidth = LW * .55;
    if (inv > 0) for (let k = 0; k < 14; k++) { const a = spin + k / 14 * TAU, s = Math.sin(a); if (s > 0) continue; x.beginPath(); x.moveTo(0, -Hs * .55); x.lineTo(R * Math.cos(a) * .98, e * s * .98); x.stroke(); }
    else for (let k = 0; k < 14; k++) { const a = spin + k / 14 * TAU; if (Math.sin(a) < 0) continue; x.lineWidth = LW * .9; x.beginPath(); for (let i = 0; i <= 8; i++) { const q = dome(i / 8, a); i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); } x.stroke(); }
  }
  if (has(pass, 'key')) {
    x.strokeStyle = INK; x.lineJoin = 'round'; x.lineCap = 'round';
    x.lineWidth = LW; x.beginPath(); poly(x, outer); x.stroke();
    x.lineWidth = LW * .7; x.beginPath(); rimUp.forEach((q, i) => i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1])); x.stroke();
    // ribs over the dome, turning with `spin`
    x.lineWidth = LW * .5;
    for (let k = 0; k < 14; k++) {
      const a = spin + k / 14 * TAU; if (Math.sin(a) < 0 && inv > -.6) continue;
      x.lineWidth = LW * (inv < -.6 ? (Math.sin(a) < 0 ? .55 : .95) : .5);
      x.beginPath(); for (let i = 0; i <= 8; i++) { const q = dome(i / 8, a); i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); } x.stroke();
      // blown inside out: the bamboo rib tips spring out past the torn rim
      if (inv < -.6) { const q = dome(1, a); x.lineWidth = LW * .8; x.beginPath(); x.moveTo(q[0], q[1]); x.lineTo(q[0] * 1.16, q[1] * 1.16 - 7); x.stroke(); }
    }
    if (inv > 0) { // ring edges
      for (const r of [.5, .66]) { x.beginPath(); for (let i = 0; i <= 20; i++) { const q = dome(r, Math.PI * i / 20); i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); } x.stroke(); }
    }
    x.fillStyle = INK; x.beginPath(); x.ellipse(0, -Hs - 3 * Math.sign(inv), 4.5, 3.4, 0, 0, TAU); x.fill();
  }
  if (inv <= 0) handle();
  x.restore();
}
// where the hand grips the handle, in the umbrella's local frame
export const GRIP = () => [0, UMB.L * .82];

// ————————————————— The woman on the bridge —————————————————
// feet at (px,py), ~132 px tall at s=1, facing left. p = pose:
//  lean (rad, + = forward/left), hand (front hand, body-local), hand2 (back hand), sleeve (wind 0–1), step (0–1 walk phase), hem (wind on the hem)
export function woman(x, px, py, s, p, pass = 'all') {
  const lw = 2.1;
  x.save(); x.translate(px, py); x.scale(s, s); x.rotate(-p.lean * .55);
  const w = p.sleeve || 0, hem = p.hem || 0, st = p.step || 0;
  const k1 = Math.sin(st * TAU) * 3.2, k2 = -k1;
  // geta and feet
  if (has(pass, 'wood')) {
    x.fillStyle = PAL.woodD; x.fillRect(-10 + k1, -4, 12, 4); x.fillRect(1 + k2, -4, 12, 4);
    x.fillStyle = PAL.skin; x.fillRect(-9 + k1, -7, 9, 3.4); x.fillRect(2 + k2, -7, 9, 3.4);
  }
  if (has(pass, 'key')) { x.strokeStyle = INK; x.lineWidth = lw * .7; x.strokeRect(-10 + k1, -4, 12, 4); x.strokeRect(1 + k2, -4, 12, 4); }
  // kimono body: front edge nearly straight, back hem trailing in the wind
  const body = [[-11, -97], [-14, -70], [-13, -40], [-12, -8], [-4 + k1 * .5, -5], [8, -5], [18 + hem * 10, -7 - hem * 4], [15 + hem * 5, -32], [14, -60], [12, -92], [3, -100]];
  if (has(pass, 'blue')) {
    shape(x, body, KIMONO, 0, true, false);
    // overlap line + dark lining at the hem
    x.fillStyle = KIMONO_D; x.beginPath(); x.moveTo(-12, -9); x.lineTo(18 + hem * 10, -7 - hem * 4); x.lineTo(17 + hem * 9, -14 - hem * 3); x.lineTo(-12, -15); x.closePath(); x.fill();
    // kasuri dots on the kimono
    x.fillStyle = '#4d6f98';
    for (let i = 0; i < 16; i++) { const yy = -88 + (i % 8) * 10, xx = -8 + Math.floor(i / 8) * 12 + (i % 2) * 4; x.fillRect(xx, yy, 2.4, 2.4); }
  }
  if (has(pass, 'wood')) { // obi with the taiko knot on the back
    x.fillStyle = OBI; x.beginPath(); poly(x, [[-14, -69], [14.5, -66], [14.2, -55], [-13.6, -57]]); x.fill();
    x.beginPath(); poly(x, [[12, -71], [24, -72], [25, -52], [13, -54]]); x.fill();
  }
  if (has(pass, 'key')) {
    shape(x, body, null, lw, true, false);
    x.lineWidth = lw * .7; x.beginPath(); x.moveTo(-11, -96); x.quadraticCurveTo(-4, -60, -6, -6); x.stroke();
    x.beginPath(); poly(x, [[-14, -69], [14.5, -66], [14.2, -55], [-13.6, -57]]); x.stroke();
    x.beginPath(); poly(x, [[12, -71], [24, -72], [25, -52], [13, -54]]); x.stroke();
  }
  // collar (paper white) — left bare in the blue block
  if (has(pass, 'pale')) { x.fillStyle = '#f1e6cb'; x.beginPath(); poly(x, [[-9, -98], [-3, -86], [1, -98]]); x.fill(); }
  // head
  const hx = -2, hy = -110;
  if (has(pass, 'skin')) { shape(x, [[hx - 8, hy - 2], [hx - 9.5, hy + 4], [hx - 7, hy + 9], [hx - 2, hy + 11], [hx + 5, hy + 9], [hx + 6, hy], [hx + 2, hy - 7]], PAL.skin, 0, true, true); x.fillRect(hx - 3, hy + 8, 6, 6); }
  if (has(pass, 'key')) {
    shape(x, [[hx - 8, hy - 2], [hx - 9.5, hy + 4], [hx - 7, hy + 9], [hx - 2, hy + 11], [hx + 5, hy + 9]], null, lw * .7, false, true);
    x.fillStyle = HAIR;
    // shimada: front roll, crown, big bun at the back-top, nape
    x.beginPath(); x.ellipse(hx - 2, hy - 6, 9.5, 6.5, -.2, 0, TAU); x.fill();
    x.beginPath(); x.ellipse(hx + 6, hy - 11, 7, 5.5, .3, 0, TAU); x.fill();
    x.beginPath(); x.ellipse(hx + 7, hy + 2, 5.5, 7, .2, 0, TAU); x.fill();
    x.lineWidth = lw * .55; x.beginPath(); x.moveTo(hx - 7.2, hy + 1.5); x.lineTo(hx - 4.2, hy + 1.2); x.stroke();
  }
  if (has(pass, 'wood')) { x.fillStyle = OBI; x.fillRect(hx + 2, hy - 17, 2, 9); x.beginPath(); x.arc(hx + 3, hy - 17, 2.2, 0, TAU); x.fill(); }
  // arms with hanging sleeves (blown back by the wind)
  const arm = (sh, hand, back) => {
    const a = arm2(sh, hand, 21, back ? 1 : -1), el = a[1];
    const sl = [[sh[0] - 3, sh[1] - 1], [el[0], el[1] - 2], [el[0] + 4 + w * 15, el[1] + 26 - w * 8], [sh[0] + 8 + w * 18, sh[1] + 32 - w * 10], [sh[0] + 4, sh[1] + 10]];
    if (has(pass, 'blue')) { shape(x, sl, back ? KIMONO_D : KIMONO, 0, true, true); }
    if (has(pass, 'skin')) shape(x, limb([el, a[2]], [5, 4.2]), PAL.skin, 0, true, false);
    if (has(pass, 'key')) { shape(x, sl, null, lw * .85, true, true); shape(x, limb([el, a[2]], [5, 4.2]), null, lw * .6, true, false); }
  };
  arm([2, -92], p.hand2 || [10, -70], true);
  arm([-4, -92], p.hand, false);
  x.restore();
}
// body-local point → world, matching woman()'s transform
export function womanPoint(px, py, s, p, q) {
  const a = -p.lean * .55, c = Math.cos(a), sn = Math.sin(a);
  return [px + s * (q[0] * c - q[1] * sn), py + s * (q[0] * sn + q[1] * c)];
}
export function womanLocal(px, py, s, p, w) {
  const a = -p.lean * .55, c = Math.cos(a), sn = Math.sin(a), dx = (w[0] - px) / s, dy = (w[1] - py) / s;
  return [dx * c + dy * sn, -dx * sn + dy * c];
}

// ————————————————— The fisher child —————————————————
// feet at (px,py), ~112 px tall at s=1, facing left. p: handL, handR (body-local), look (0 = ahead, 1 = up), joy (0–1)
export function child(x, px, py, s, p, pass = 'all', part = 'body') {
  const lw = 2;
  x.save(); x.translate(px, py); x.scale(s, s);
  const STRIPE = '#bcd0d6', CL = '#2f4f73';
  if (part === 'body') {
    // legs + straw sandals
    if (has(pass, 'skin')) { shape(x, limb([[-6, -36], [-7, -18], [-8, -3]], [6, 5, 4.4]), PAL.skin, 0, true, false); shape(x, limb([[5, -36], [6, -18], [7, -3]], [6, 5, 4.4]), PAL.skin, 0, true, false); }
    if (has(pass, 'wood')) { x.fillStyle = PAL.straw; x.fillRect(-15, -3, 12, 3); x.fillRect(2, -3, 12, 3); }
    if (has(pass, 'key')) { shape(x, limb([[-6, -36], [-7, -18], [-8, -3]], [6, 5, 4.4]), null, lw * .6, true, false); shape(x, limb([[5, -36], [6, -18], [7, -3]], [6, 5, 4.4]), null, lw * .6, true, false); x.lineWidth = lw * .6; x.strokeRect(-15, -3, 12, 3); x.strokeRect(2, -3, 12, 3); }
    // short kimono with indigo stripes
    const kim = [[-10, -78], [-14, -60], [-15, -34], [14, -32], [13, -60], [9, -78], [0, -82]];
    if (has(pass, 'blue')) {
      shape(x, kim, STRIPE, 0, true, false);
      x.save(); x.beginPath(); poly(x, kim); x.clip(); x.fillStyle = CL; for (let i = -16; i < 16; i += 6) x.fillRect(i, -84, 2.6, 56); x.restore();
      x.fillStyle = CL; x.beginPath(); poly(x, [[-14.6, -55], [13.5, -54], [13.4, -47], [-14.8, -48]]); x.fill();
    }
    if (has(pass, 'key')) { shape(x, kim, null, lw, true, false); x.lineWidth = lw * .7; x.beginPath(); x.moveTo(-9, -78); x.lineTo(2, -55); x.stroke(); }
    // fish basket (biku) on the back hip
    if (has(pass, 'wood')) { x.fillStyle = PAL.ochre; x.beginPath(); x.ellipse(17, -42, 8, 10, .1, 0, TAU); x.fill(); }
    if (has(pass, 'key')) {
      x.lineWidth = lw * .7; x.beginPath(); x.ellipse(17, -42, 8, 10, .1, 0, TAU); x.stroke();
      x.lineWidth = lw * .4; for (let i = -2; i <= 2; i++) { x.beginPath(); x.moveTo(11, -42 + i * 4); x.lineTo(23, -42 + i * 4 + 1); x.stroke(); }
      x.beginPath(); x.moveTo(13, -51); x.quadraticCurveTo(6, -66, 2, -76); x.stroke();
    }
    // head: shaved pate with karako tufts, tilting up with `look`
    x.save(); x.translate(-1, -86); x.rotate(-.42 * (p.look || 0));
    if (has(pass, 'skin')) { x.fillStyle = PAL.skin; x.beginPath(); x.ellipse(0, -9, 12.5, 12, 0, 0, TAU); x.fill(); x.fillStyle = '#c5ccc8'; x.beginPath(); x.ellipse(2, -15, 10, 6.4, .2, Math.PI * .95, Math.PI * 2.05); x.fill(); }
    if (has(pass, 'key')) {
      x.strokeStyle = INK; x.lineWidth = lw * .75; x.beginPath(); x.ellipse(0, -9, 12.5, 12, 0, 0, TAU); x.stroke();
      x.fillStyle = HAIR; x.beginPath(); x.ellipse(-8, -18, 4.4, 3.4, -.5, 0, TAU); x.fill(); x.beginPath(); x.ellipse(8, -6, 4.2, 5.4, .2, 0, TAU); x.fill(); x.beginPath(); x.ellipse(5, -21, 3.2, 2.6, .4, 0, TAU); x.fill();
      x.lineWidth = lw * .6; const j = p.joy || 0;
      x.beginPath(); x.moveTo(-9.6, -10); x.quadraticCurveTo(-7.4, -11.6 - j * 1.4, -5.2, -10); x.stroke();     // eye (curves up with joy)
      x.beginPath(); x.ellipse(-8.2, -3.5, 1.4 + j * .5, .8 + j * 1.1, 0, 0, TAU); x.stroke();                   // mouth: small o of delight
      x.fillStyle = 'rgba(184,65,47,.35)'; x.beginPath(); x.arc(-5, -5.5, 2.6, 0, TAU); x.fill();
    }
    x.restore();
  }
  // arms (drawn in front of the umbrella handle when part === 'hands')
  const armDraw = (sh, hand, back) => {
    const a = arm2(sh, hand, 17, back ? 1 : -1);
    const sl = [sh, a[1]];
    if (has(pass, 'blue')) shape(x, limb(sl, [9, 7.5]), back ? '#9fb7c1' : STRIPE, 0, true, false);
    if (has(pass, 'skin')) { shape(x, limb([a[1], a[2]], [5, 4.2]), PAL.skin, 0, true, false); x.fillStyle = PAL.skin; x.beginPath(); x.arc(a[2][0], a[2][1], 3.4, 0, TAU); x.fill(); }
    if (has(pass, 'key')) { shape(x, limb(sl, [9, 7.5]), null, lw * .7, true, false); shape(x, limb([a[1], a[2]], [5, 4.2]), null, lw * .55, true, false); x.lineWidth = lw * .55; x.beginPath(); x.arc(a[2][0], a[2][1], 3.4, 0, TAU); x.stroke(); }
  };
  if (part === 'body') armDraw([4, -74], p.handR, true);
  if (part === 'hands') armDraw([-3, -74], p.handL, false);
  x.restore();
}
