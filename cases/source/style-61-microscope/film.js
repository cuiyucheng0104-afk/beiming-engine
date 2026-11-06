// 一滴池塘水 · Microscope Story
// One camera from a drop of pond water on a glass slide down to a diatom's glass shell and back.
// The bench, the slide and the drop are drawn (staging); the two fields of view are real CC0 photomicrographs
// (plates/A.jpg, plates/B.jpg), different samples joined on focus breaths. Every number is counted from the
// photos (tools/striae.py, tools/marks_A.py). World units: millimetres on the slide.
import { clamp, lerp, seg, ss, eio, eo, ei, hash } from '/core/lib.js';
import { T, B as BT, DUR, BEAT, b } from './timeline.js';

const W = 1920, H = 1080, M = 72;
const Q = new URLSearchParams(location.search);
window.DUR = DUR;
const j = async f => (await fetch(f)).json();
const META = await j('plates/meta.json');
const STRIAE = await j('plates/striae.json');
const COUNT = await j('plates/count_A.json');
const loadImg = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('missing ' + src)); im.src = src; });
const IM = { A: await loadImg('plates/A.jpg'), B: await loadImg('plates/B.jpg') };
await Promise.all(Object.values(IM).map(im => im.decode()));
await Promise.all(['300 40px BC', '400 40px BC', '400 20px PM', '500 20px PM', '400 20px SC', '500 20px SC', '600 20px SS']
  .map(f => document.fonts.load(f, '滴视野0×')));

// ------------------------------------------------------------------ canvases
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const base = mk(W + 2 * M, H + 2 * M), bx = base.getContext('2d');
const tmp = mk(W, H), tx = tmp.getContext('2d');
const snap = mk(W, H), sx = snap.getContext('2d');
for (const c of [ctx, bx, tx, sx]) { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; }

// ------------------------------------------------------------------ the world
const K1 = 20;                                    // screen px per mm at ×1
const SLIDE = { x0: -37.5, y0: -12.5, x1: 37.5, y1: 12.5, lab: 15 };     // 75 × 25 mm, frosted label from x = 15 (22.5 mm)
const D = [-13, 1.2], DR = 2.2;                   // the drop: centre and radius (mm)
const A = META.A, Bm = META.B;
const sA = 0.27 / A.r;                            // plate A: mm per pixel (staging scale: its ring is 0.54 mm wide)
const Ac = [D[0] + 0.55, D[1] - 0.35];            // where A's ring sits inside the drop
const ROT_A = 0;                                  // plate A world rotation (deg)
const sB = 1 / (400 * K1);                        // plate B: 1 screen px per B pixel at ×400
const ROT_B = -20;                                // plate B world rotation (deg): level when the camera has rolled 20°
const BTARGET_A = [1400, 1500];                   // the point of A the dive heads for (open glass)
const plateToW = (pl, px, py) => {                // plate pixel -> world mm
  if (pl === 'A') { return [Ac[0] + (px - A.cx) * sA, Ac[1] + (py - A.cy) * sA]; }
  const r = ROT_B * Math.PI / 180, dx = (px - NUC[0]) * sB, dy = (py - NUC[1]) * sB;
  return [Bc[0] + dx * Math.cos(r) - dy * Math.sin(r), Bc[1] + dx * Math.sin(r) + dy * Math.cos(r)];
};
const NUC = [1372, 1800];                         // B: the central nodule (plate px)
const Bc = plateToW('A', ...BTARGET_A);           // the central nodule of B sits where the dive heads in A

// ------------------------------------------------------------------ camera: similarity keys, log-spiral interpolation
const cmul = (p, q) => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const cdiv = (p, q) => { const d = q[0] * q[0] + q[1] * q[1]; return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d]; };
const csub = (p, q) => [p[0] - q[0], p[1] - q[1]], cadd = (p, q) => [p[0] + q[0], p[1] + q[1]];
function key(t, p, s, Z, rollDeg, ease = 'mix') {
  const k = K1 * Z, th = rollDeg * Math.PI / 180, a = [k * Math.cos(th), k * Math.sin(th)];
  return { t, a, b: csub(s, cmul(a, p)), lk: Math.log(k), th, ease };
}
const Bw = (px, py) => plateToW('B', px, py);
const KEYS = [
  key(0, [0, 0.4], [960, 540], 1.0, 0, 'lin'),
  key(T.dive, [-1.2, 0.5], [960, 540], 1.035, 0, 'mix'),
  key(T.x10, D, [960, 540], 10, 7, 'mix'),
  key(b(7.25), Ac, [960, 540], 93, 12.5, 'eio'),                        // plunge: the field stop already fills the frame when it closes
  key(T.x100, Ac, [960, 540], 100, 14, 'mix'),
  key(T.x400, Bw(1290, 1800), [1150, 560], 400, 20, 'lin'),             // land; truck along the valve while the plane sweeps
  key(T.sweep1, Bw(1290, 1800), [1085, 560], 408, 20.4, 'lin'),
  key(T.hush, Bw(1290, 1800), [1070, 560], 418, 20.7, 'lin'),
  key(T.first, Bw(1290, 1800), [1066, 560], 421, 20.8, 'eio'),
  key(T.count0, Ac, [930, 540], 100, 14, 'lin'),                          // pull back B -> A
  key(T.climb, Ac, [930, 540], 103.5, 14.4, 'climb'),
  key(T.x1, [1.6, 0.6], [960, 560], 1.0, 0, 'eio'),                       // the climb back
  key(DUR, [4.2, 0.5], [960, 560], 1.3, -0.3, 'lin'),                   // a slow push onto the label
];
const EASE = { lin: u => u, eio: u => eio(u), mix: u => 0.55 * eio(u) + 0.45 * u, climb: u => 0.7 * eio(u) + 0.3 * ei(u) };
function camAt(t) {
  let i = 0; while (i < KEYS.length - 2 && t >= KEYS[i + 1].t) i++;
  const k1 = KEYS[i], k2 = KEYS[i + 1];
  const u = EASE[k1.ease](clamp((t - k1.t) / (k2.t - k1.t), 0, 1));
  const Aq = cdiv(k2.a, k1.a), Bq = csub(k2.b, cmul(Aq, k1.b));
  const lA = k2.lk - k1.lk, tA = k2.th - k1.th;
  const Au = [Math.exp(lA * u) * Math.cos(tA * u), Math.exp(lA * u) * Math.sin(tA * u)];
  let a, bb;
  if (Math.hypot(Aq[0] - 1, Aq[1]) < 1e-9) { a = k1.a; bb = cadd(k1.b, [Bq[0] * u, Bq[1] * u]); }
  else { const zs = cdiv(Bq, csub([1, 0], Aq)); a = cmul(Au, k1.a); bb = cadd(cmul(Au, csub(k1.b, zs)), zs); }
  const k = Math.hypot(a[0], a[1]);
  return { a, b: bb, k, Z: k / K1, th: Math.atan2(a[1], a[0]) };
}
const toS = (c, p) => cadd(cmul(c.a, p), c.b);
const setW = (g, c, off = M) => g.setTransform(c.a[0], c.a[1], -c.a[1], c.a[0], c.b[0] + off, c.b[1] + off);

// ------------------------------------------------------------------ which field is on the glass
const pulse = (t, c, w) => Math.exp(-Math.pow((t - c) / w, 2));
const mixA = t => ss(seg(t, T.breath1 - 0.2, T.breath1 + 0.15)) * (1 - ss(seg(t, b(11.62), b(11.92))))
  + ss(seg(t, b(20.12), b(20.42))) * (1 - ss(seg(t, b(24.55), b(24.95))));
const mixB = t => ss(seg(t, b(11.62), b(11.92))) * (1 - ss(seg(t, b(20.12), b(20.42))));
function focus(t) {
  let g = 11 * (1 - eo(seg(t, 0.0, T.drop)));                           // rack in, sharp as the drop lands
  g += 13 * pulse(t, T.breath1, 0.17) + 11 * pulse(t, b(11.77), 0.15) + 9 * pulse(t, b(20.27), 0.14) + 6 * pulse(t, b(24.75), 0.12);
  g += 2.5 * pulse(t, T.x10, 0.08) + 2 * pulse(t, T.x100, 0.08);
  const soft = 5.5 * ss(seg(t, b(11.8), b(12.2))) * (t < T.sweep1 + 0.2 ? 1 : 0);
  const front = lerp(-420, W + 560, eio(seg(t, T.sweep0, T.sweep1)));
  return { g, soft, front };
}

// ------------------------------------------------------------------ drawing the bench, the slide and the drop
const GLASS = 'rgb(244,241,236)', INK = 'rgb(24,27,31)', WHITE_T = 'rgb(248,247,244)';
const CY = 'rgb(120,215,255)', CY_D = 'rgb(0,104,150)';
function dropRadius(t) {                                                 // splash, retract, settle into a dome
  if (t < T.drop) return 0;
  const u = t - T.drop;
  return DR * (1 + 0.32 * Math.exp(-4.2 * u) * Math.cos(10.5 * u) + 0.12 * Math.exp(-14 * u));
}
const SAT = [0, 1, 2].map(i => ({ ang: -2.3 + i * 1.9 + hash(i + 3) * 0.6, dist: DR * (2.0 + hash(i + 7) * 0.9), r: 0.16 + hash(i + 11) * 0.12 }));
function scene(c, t) {
  bx.setTransform(1, 0, 0, 1, 0, 0);
  const lx = lerp(520, 1380, ss(seg(t, 0, DUR))) + M, ly = 280 + M;   // a slow pool of light
  const g = bx.createRadialGradient(lx, ly, 40, lx, ly, 1550);
  g.addColorStop(0, '#2c3238'); g.addColorStop(0.5, '#161a1d'); g.addColorStop(1, '#0b0d0f');
  bx.fillStyle = g; bx.fillRect(0, 0, base.width, base.height);
  const Z = c.Z;
  if (Z > 220) return;                                                   // the bench is long gone at these scales
  // the slide's soft shadow
  bx.save(); setW(bx, c); bx.filter = `blur(${Math.min(40, 0.9 * c.k).toFixed(1)}px)`;
  bx.fillStyle = 'rgba(0,0,0,0.6)'; bx.fillRect(SLIDE.x0 + 0.5, SLIDE.y0 + 0.9, 75, 25); bx.restore();
  // glass: warm white sheen catching the light, bright bevel
  bx.save(); setW(bx, c);
  const lw = toW(c, [lx - M, ly - M]);
  const sg = bx.createRadialGradient(lw[0], lw[1], 2, lw[0], lw[1], 70);
  sg.addColorStop(0, 'rgba(244,241,236,0.42)'); sg.addColorStop(0.6, 'rgba(244,241,236,0.24)'); sg.addColorStop(1, 'rgba(244,241,236,0.16)');
  bx.fillStyle = sg; bx.fillRect(SLIDE.x0, SLIDE.y0, 75, 25);
  // frosted label end
  bx.fillStyle = 'rgba(236,232,224,0.94)'; bx.fillRect(SLIDE.lab, SLIDE.y0, SLIDE.x1 - SLIDE.lab, 25);
  for (let i = 0; i < 260; i++) {                                         // frost grain (seeded)
    const x = SLIDE.lab + hash(i * 3.1) * (SLIDE.x1 - SLIDE.lab), y = SLIDE.y0 + hash(i * 7.7 + 1) * 25;
    bx.fillStyle = `rgba(${hash(i) > .5 ? '255,255,255' : '190,184,174'},0.35)`; bx.fillRect(x, y, 0.12, 0.12);
  }
  bx.lineWidth = Math.max(0.05, 1.6 / c.k); bx.strokeStyle = 'rgba(255,253,248,0.75)'; bx.strokeRect(SLIDE.x0, SLIDE.y0, 75, 25);
  bx.strokeStyle = 'rgba(255,253,248,0.25)'; bx.lineWidth = Math.max(0.05, 4 / c.k); bx.strokeRect(SLIDE.x0 + 0.25, SLIDE.y0 + 0.25, 74.5, 24.5);
  bx.restore();
  // the falling drop (screen space: it comes from above the lens)
  const sD = toS(c, D);
  if (t > T.drop - BEAT / 2 && t < T.drop) {
    const u = ei(seg(t, T.drop - BEAT / 2, T.drop)), y = lerp(-260, sD[1], u), r = DR * c.k * 0.62, st = 1 + 2.4 * u;
    bx.save(); bx.translate(sD[0] + M, y + M); bx.scale(1, st);
    const fg = bx.createRadialGradient(-r * .3, -r * .3, 1, 0, 0, r);
    fg.addColorStop(0, 'rgba(255,255,250,0.85)'); fg.addColorStop(0.5, 'rgba(170,190,176,0.45)'); fg.addColorStop(1, 'rgba(40,56,50,0.7)');
    bx.fillStyle = fg; bx.beginPath(); bx.arc(0, 0, r, 0, 2 * Math.PI); bx.fill(); bx.restore();
  }
  if (t < T.drop) return;
  // ripples on the glass
  const u = t - T.drop;
  bx.save(); setW(bx, c);
  for (let i = 0; i < 3; i++) {
    const uu = u - i * 0.11; if (uu <= 0) continue;
    const rr = DR * (1.05 + 2.6 * eo(clamp(uu / 1.2, 0, 1))), al = 0.5 * (1 - clamp(uu / 1.2, 0, 1));
    if (al <= 0) continue;
    bx.strokeStyle = `rgba(255,253,246,${al})`; bx.lineWidth = Math.max(0.02, 2 / c.k);
    bx.beginPath(); bx.arc(D[0], D[1], rr, 0, 2 * Math.PI); bx.stroke();
  }
  // satellites flung by the splash
  for (const s of SAT) {
    const f = eo(seg(u, 0, 0.5)); if (f <= 0) continue;
    const p = [D[0] + Math.cos(s.ang) * s.dist * f, D[1] + Math.sin(s.ang) * s.dist * f];
    drawDome(bx, p, s.r * Math.min(1, f * 3), c, 0.9);
  }
  drawDome(bx, D, dropRadius(t), c, 1);
  bx.restore();
}
function toW(c, q) { return cdiv(csub(q, c.b), c.a); }
function drawDome(g, p, r, c, al) {                                      // a water dome on glass, lit from the light pool
  if (r <= 0) return;
  // caustic on the glass (light focused by the dome), offset away from the light
  const cg = g.createRadialGradient(p[0] + r * .32, p[1] + r * .38, r * .05, p[0] + r * .32, p[1] + r * .38, r * .9);
  cg.addColorStop(0, `rgba(255,252,236,${0.55 * al})`); cg.addColorStop(1, 'rgba(255,252,236,0)');
  g.fillStyle = cg; g.beginPath(); g.arc(p[0] + r * .32, p[1] + r * .38, r * .9, 0, 2 * Math.PI); g.fill();
  // the body: clear water with a faint pond tint, a dark refracting rim
  const bg = g.createRadialGradient(p[0] - r * .15, p[1] - r * .15, r * .1, p[0], p[1], r);
  bg.addColorStop(0, `rgba(214,226,206,${0.30 * al})`); bg.addColorStop(0.72, `rgba(120,140,122,${0.30 * al})`);
  bg.addColorStop(0.93, `rgba(28,36,32,${0.78 * al})`); bg.addColorStop(1, `rgba(220,230,220,${0.6 * al})`);
  g.fillStyle = bg; g.beginPath(); g.arc(p[0], p[1], r, 0, 2 * Math.PI); g.fill();
  // inner bright crescent (light through the far wall)
  g.save(); g.beginPath(); g.arc(p[0], p[1], r * .97, 0, 2 * Math.PI); g.clip();
  const ig = g.createRadialGradient(p[0] + r * .55, p[1] + r * .55, r * .05, p[0] + r * .5, p[1] + r * .5, r * .75);
  ig.addColorStop(0, `rgba(250,248,226,${0.5 * al})`); ig.addColorStop(1, 'rgba(250,248,226,0)');
  g.fillStyle = ig; g.fillRect(p[0] - r, p[1] - r, 2 * r, 2 * r);
  // specular: a soft window highlight and a hard pin
  g.save(); g.translate(p[0] - r * .38, p[1] - r * .42); g.rotate(-0.6); g.scale(1, 0.55);
  const hg = g.createRadialGradient(0, 0, 0, 0, 0, r * .36);
  hg.addColorStop(0, `rgba(255,255,255,${0.9 * al})`); hg.addColorStop(0.5, `rgba(255,255,255,${0.35 * al})`); hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg; g.beginPath(); g.arc(0, 0, r * .36, 0, 2 * Math.PI); g.fill(); g.restore();
  g.fillStyle = `rgba(255,255,255,${0.95 * al})`; g.beginPath(); g.arc(p[0] - r * .5, p[1] - r * .5, r * .045, 0, 2 * Math.PI); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ the two fields of view
function fields(c, t) {
  const ma = mixA(t), mb = mixB(t);
  const irisOn = t > b(6.125) && t < T.breath1 + 0.3;              // the first field stop: darkness closes in from the frame edges
  if (ma <= 0.002 && mb <= 0.002 && !irisOn) return;
  bx.save(); bx.setTransform(1, 0, 0, 1, 0, 0);
  if (irisOn) {
    const sc = toS(c, Ac), Rs = Math.min(A.r, A.cx - 3, A.W - A.cx - 3) * sA * c.k;
    const e = eio(seg(t, b(6.25), T.breath1 + 0.06)), ri = lerp(1500, Rs, e), soft = lerp(420, 30, e);
    const ig = bx.createRadialGradient(sc[0] + M, sc[1] + M, Math.max(1, ri - soft), sc[0] + M, sc[1] + M, ri);
    ig.addColorStop(0, 'rgba(6,7,8,0)'); ig.addColorStop(1, 'rgba(6,7,8,1)');
    bx.fillStyle = ig; bx.fillRect(0, 0, base.width, base.height);
  } else { bx.globalAlpha = Math.max(ma, mb); bx.fillStyle = '#060708'; bx.fillRect(0, 0, base.width, base.height); }
  bx.restore();
  if (ma <= 0.002 && mb <= 0.002) return;
  if (ma > 0.002 && mb < 0.999) {                                        // field A inside its own ring
    bx.save(); setW(bx, c); bx.globalAlpha = ma;
    const R = A.r * sA;
    const Rc = Math.min(A.r, A.cx - 3, A.W - A.cx - 3) * sA;               // stay inside the photo (its ring is cropped on the left)
    bx.beginPath(); bx.arc(Ac[0], Ac[1], Rc, 0, 2 * Math.PI); bx.clip();
    bx.drawImage(IM.A, Ac[0] - A.cx * sA, Ac[1] - A.cy * sA, A.W * sA, A.H * sA);
    bx.restore();
    // the ring's soft edge (the field stop)
    bx.save(); setW(bx, c); bx.globalAlpha = ma;
    const R2 = Math.min(A.r, A.cx - 3, A.W - A.cx - 3) * sA, rg = bx.createRadialGradient(Ac[0], Ac[1], R2 * 0.93, Ac[0], Ac[1], R2 * 1.01);
    rg.addColorStop(0, 'rgba(6,7,8,0)'); rg.addColorStop(1, 'rgba(6,7,8,0.85)');
    bx.fillStyle = rg; bx.beginPath(); bx.arc(Ac[0], Ac[1], R2 * 1.01, 0, 2 * Math.PI); bx.fill(); bx.restore();
  }
  if (mb > 0.002) {
    bx.save(); setW(bx, c); bx.globalAlpha = mb;
    const r = ROT_B * Math.PI / 180;
    bx.translate(Bc[0], Bc[1]); bx.rotate(r); bx.scale(sB, sB);
    bx.drawImage(IM.B, -NUC[0], -NUC[1]);
    bx.restore();
  }
}

function composite(c, t) {
  const { g, soft, front } = focus(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = (g + soft) > 0.25 ? `blur(${(g + soft).toFixed(2)}px)` : 'none';
  ctx.drawImage(base, -M, -M);
  ctx.filter = 'none';
  if (soft > 0.25 && t > T.sweep0 - 0.1) {                               // the focal plane: a tilted sharp front
    tx.globalCompositeOperation = 'source-over'; tx.clearRect(0, 0, W, H);
    tx.filter = g > 0.25 ? `blur(${g.toFixed(2)}px)` : 'none'; tx.drawImage(base, -M, -M); tx.filter = 'none';
    tx.globalCompositeOperation = 'destination-in';
    const ang = 14 * Math.PI / 180, dx = Math.cos(ang), dy = Math.sin(ang), band = 260;
    const gr = tx.createLinearGradient(front - dx * band, H / 2 - dy * band, front + dx * band, H / 2 + dy * band);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    tx.fillStyle = gr; tx.fillRect(0, 0, W, H); tx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.15);
  vg.addColorStop(0, 'rgba(14,12,16,0)'); vg.addColorStop(1, 'rgba(14,12,16,0.2)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  sx.drawImage(cv, 0, 0);
}

// ------------------------------------------------------------------ drawing kit
let TX = [];
function reg(id, text, x0, y0, x1, y1) { TX.push({ id, text, x0, y0, x1, y1 }); }
function text(s, x, y, font, color, { align = 'left', alpha = 1, halo = null, id = null, full = null } = {}) {
  if (alpha <= 0.003) return 0;
  ctx.save(); ctx.globalAlpha = alpha; ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  if (halo) { ctx.shadowColor = halo; ctx.shadowBlur = 8; }
  ctx.fillStyle = color; ctx.fillText(s, x, y);
  if (halo) { ctx.shadowBlur = 0; ctx.fillText(s, x, y); }
  const m = ctx.measureText(full ?? s), w = m.width; ctx.restore();
  if (id && alpha > 0.5) {
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    reg(id, full ?? s, x0, y - m.actualBoundingBoxAscent, x0 + w, y + m.actualBoundingBoxDescent);
  }
  return w;
}
function line(pts, color, halo, w = 1.8, alpha = 1) {
  if (alpha <= 0.003) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
  if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = w + 3; ctx.stroke(); }
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); ctx.restore();
}
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function panel(x, y, w, h, alpha = 1, r = 14) {
  if (alpha <= 0.003) return;
  ctx.save(); ctx.globalAlpha = alpha; rr(ctx, x, y, w, h, r); ctx.clip();
  ctx.filter = 'blur(18px)'; ctx.drawImage(snap, 0, 0); ctx.filter = 'none';
  ctx.fillStyle = 'rgba(12,14,17,0.74)'; ctx.fillRect(x, y, w, h); ctx.restore();
  ctx.save(); ctx.globalAlpha = alpha * 0.9; rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
}

// ------------------------------------------------------------------ instruments (bottom left) and source (bottom right)
const MAGSEG = [[0, 1], [T.dive, 10], [T.breath1, 100], [b(10.5), 400], [T.first, 100], [T.climb, 1]];
const SCALESEG = [[0, '10 mm'], [T.dive, '1 mm'], [T.breath1, '原片无标尺'], [b(24.75), '10 mm']];   // landing values (for TEXTS)
const BAR125 = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
const fmtBar = mm => mm >= 1 ? mm + ' mm' : Math.round(mm * 1000) + ' µm';
const segVal = (S, t) => { let v = S[0]; for (const s of S) if (t >= s[0]) v = s; return v; };
const LEVELS = [[T.x10, 10, 1], [T.x100, 100, 1], [T.x400, 400, 1], [b(20.6), 100, -1]];
const fmtZ = Z => Z >= 9.5 ? String(Math.round(Z)) : Z.toFixed(1).replace(/\.0$/, '');
function instruments(c, t) {
  const a = ss(seg(t, 0.25, 0.75));
  const x0 = 56, y0 = 878, pw = 352, ph = 148;
  panel(x0, y0, pw, ph, a);
  // scale bar: only where the world has a known scale (the drawn standard slide)
  const sc = segVal(SCALESEG, t)[1], xb = x0 + 26, yb = y0 + 74;
  if (sc.endsWith('mm')) {                                               // 1-2-5: the longest bar that fits 300 px, dive and climb alike
    const mm = BAR125.find(v => v * c.k <= 300) ?? BAR125[BAR125.length - 1], L = mm * c.k;
    line([[xb, yb - 10], [xb, yb], [xb + L, yb], [xb + L, yb - 10]], WHITE_T, null, 2, a);
    text(fmtBar(mm), xb, y0 + 50, '300 40px BC', WHITE_T, { alpha: a, id: 'scale', full: sc });
  } else {
    text(sc, xb, y0 + 50, '400 26px SC', 'rgba(248,247,244,0.86)', { alpha: a, id: 'scale' });
    line([[xb, yb - 4], [xb + 220, yb - 4]], 'rgba(248,247,244,0.35)', null, 1.4, a);
  }
  // magnification: the camera's zoom on the opening frame, rolling; reported by its landing value
  const land = segVal(MAGSEG, t)[1];
  text('放大', xb, y0 + 124, '400 22px SC', 'rgba(248,247,244,0.7)', { alpha: a, id: 'maglab' });
  let flash = 0; for (const [tl] of LEVELS) if (t >= tl) flash = Math.max(flash, 1 - ss(seg(t, tl, tl + 0.7)));
  const col = `rgb(${[248, 247, 244].map((x, i) => Math.round(lerp(x, [120, 215, 255][i], flash))).join(',')})`;
  text('×' + fmtZ(c.Z), xb + 56, y0 + 124, '500 22px PM', col, { alpha: a, id: 'mag', full: '×' + land });
  // the nosepiece glyph turns a quarter on every level change
  let turns = 0; for (const [tl, , dir] of LEVELS) turns += dir * eo(seg(t, tl, tl + 0.28));
  for (const tc of CLIMB_CLICKS) turns -= eo(seg(t, tc, tc + 0.2));
  const ix = x0 + pw - 40, iy = y0 + 116, ang = turns * Math.PI / 2;
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(ix, iy, 11, 0, 2 * Math.PI); ctx.stroke();
  for (let i = 0; i < 4; i++) { const q = ang + i * Math.PI / 2; ctx.beginPath(); ctx.arc(ix + Math.cos(q) * 6.5, iy + Math.sin(q) * 6.5, i === 0 ? 3 : 1.8, 0, 2 * Math.PI); ctx.fill(); }
  ctx.restore();
  // each new magnification said once, large
  for (const [tl, z, dir] of LEVELS) {
    if (dir < 0) continue;
    const fa = ss(seg(t, tl - 0.02, tl + 0.12)) * (1 - ss(seg(t, tl + 1.75, tl + 1.95)));
    if (fa <= 0.003) continue;
    const dy = 12 * (1 - eo(seg(t, tl, tl + 0.25)));
    ctx.save(); ctx.font = '400 64px BC'; const fw = ctx.measureText('×' + z).width; ctx.restore();
    panel(x0, y0 - 104 + dy, fw + 48, 86, fa, 14);
    text('×' + z, x0 + 24, y0 - 38 + dy, '400 64px BC', CY, { alpha: fa, id: 'flash' + z });
  }
  // source
  const src = t < T.breath1 ? '示意绘制' : t < b(11.77) ? '视野 A · CC0' : t < b(20.27) ? '视野 B · CC0' : t < b(24.75) ? '视野 A · CC0' : '示意绘制';
  ctx.save(); ctx.font = '400 22px SC'; const cw = Math.ceil(ctx.measureText(src).width) + 48; ctx.restore();
  panel(W - 56 - cw, 972, cw, 50, a, 12);
  text(src, W - 56 - cw / 2, 1005, '400 22px SC', 'rgba(248,247,244,0.84)', { align: 'center', alpha: a, id: 'src' });
}

// ------------------------------------------------------------------ the ring round the central nodule, and the striae count
const RING_R = 205;                                                     // B px
function nodule(c, t) {
  const show = ss(seg(t, T.ring0, T.ring0 + 0.1)) * (1 - ss(seg(t, b(20.0), b(20.3))));
  if (show <= 0.003) return;
  const s = toS(c, Bw(...NUC)), rad = RING_R * sB * c.k;
  const drawn = eio(seg(t, T.ring0, T.ring1));
  const halo = 'rgba(255,253,250,0.85)';
  ctx.save(); ctx.globalAlpha = show; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(s[0], s[1], rad, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * drawn);
  ctx.strokeStyle = halo; ctx.lineWidth = 5.5; ctx.stroke(); ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.stroke();
  for (let i = 0; i < 4; i++) {
    if (drawn < (i + 1) / 4 - 0.001) continue;
    const an = -Math.PI / 2 + i * Math.PI / 2;
    const p0 = [s[0] + Math.cos(an) * rad, s[1] + Math.sin(an) * rad], p1 = [s[0] + Math.cos(an) * (rad + 14), s[1] + Math.sin(an) * (rad + 14)];
    ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.strokeStyle = halo; ctx.lineWidth = 5; ctx.stroke(); ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.stroke();
  }
  ctx.restore();
  text('中央节', s[0], s[1] + rad + 52, '500 30px SC', INK, { align: 'center', alpha: show * ss(seg(t, T.ring1 - 0.25, T.ring1 + 0.05)), halo, id: 'nodule' });
}
const SP = STRIAE.pts;                                                  // peaks along the band (B px)
const SCAN_E = u => Math.pow(u, 1.7);                                   // the scan accelerates
const scanF = t => SCAN_E(clamp((t - T.scan0) / (T.land1 - 0.12 - T.scan0), 0, 1));
const P0s = STRIAE.p0, P1s = STRIAE.p1, SL = Math.hypot(P1s[0] - P0s[0], P1s[1] - P0s[1]);
const peakF = SP.map(p => ((p[0] - P0s[0]) * (P1s[0] - P0s[0]) + (p[1] - P0s[1]) * (P1s[1] - P0s[1])) / (SL * SL));
const STRIA_T = peakF.map(f => T.scan0 + Math.pow(f, 1 / 1.7) * (T.land1 - 0.12 - T.scan0));
function striae(c, t) {
  const on = ss(seg(t, T.scan0 - 0.15, T.scan0 + 0.1)) * (1 - ss(seg(t, b(20.0), b(20.3))));
  if (on <= 0.003) return;
  const f = scanF(t);
  const n = STRIA_T.filter(x => x <= t).length;
  const r = ROT_B * Math.PI / 180 + c.th;
  // dashes at every counted stria, kept as a faint trace
  ctx.save(); ctx.lineCap = 'round';
  SP.forEach((p, i) => {
    if (STRIA_T[i] > t) return;
    const s = toS(c, Bw(p[0], p[1])), age = t - STRIA_T[i];
    const al = on * lerp(1, 0.55, ss(seg(age, 0.1, 0.6)));
    const nx = -Math.sin(r), ny = Math.cos(r), L = 22 + 8 * Math.exp(-age * 12);
    ctx.globalAlpha = al; ctx.strokeStyle = 'rgba(255,253,250,0.8)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(s[0] - nx * L, s[1] - ny * L); ctx.lineTo(s[0] - nx * (L - 12), s[1] - ny * (L - 12)); ctx.stroke();
    ctx.strokeStyle = CY_D; ctx.lineWidth = 2.4; ctx.stroke();
  });
  ctx.restore();
  // the scan front, perpendicular to the band
  if (t < T.land1 + 0.15) {
    const p = [lerp(P0s[0], P1s[0], f), lerp(P0s[1], P1s[1], f)], s = toS(c, Bw(...p));
    const nx = -Math.sin(r), ny = Math.cos(r), fa = on * (1 - ss(seg(t, T.land1 - 0.12, T.land1 + 0.1)));
    ctx.save(); ctx.globalAlpha = fa; ctx.shadowColor = CY; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.moveTo(s[0] - nx * 70, s[1] - ny * 70); ctx.lineTo(s[0] + nx * 30, s[1] + ny * 30);
    ctx.strokeStyle = CY_D; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
  }
  // the reading, joined by a leader with one elbow
  const ra = ss(seg(t, T.scan0 - 0.1, T.scan0 + 0.2)) * (1 - ss(seg(t, b(20.0), b(20.3))));
  const px = 1258, py = 92, pw = 400, ph = 196;
  const anchor = toS(c, Bw(...SP[Math.floor(SP.length * 0.62)]));
  const nx = -Math.sin(r), ny = Math.cos(r);
  const a0 = [anchor[0] - nx * 34, anchor[1] - ny * 34];
  line([a0, [a0[0], py + ph + 26], [px + 40, py + ph + 26], [px + 40, py + ph]], WHITE_T, 'rgba(10,8,10,0.5)', 1.6, ra);
  panel(px, py, pw, ph, ra);
  text('扫描段 · 肋纹', px + 26, py + 44, '500 26px SC', 'rgba(248,247,244,0.88)', { alpha: ra, id: 'stlab' });
  const done = t >= T.land1;
  const pop = done ? 1 + 0.07 * Math.exp(-(t - T.land1) * 9) * Math.sin((t - T.land1) * 30) : 1;
  ctx.save(); ctx.translate(px + 26, py + 128); ctx.scale(pop, pop);
  const nw = text(String(n), 0, 0, '300 84px BC', done ? CY : 'rgba(120,215,255,0.62)', { alpha: ra });
  text('条', nw + 10, 0, '400 28px SC', 'rgba(248,247,244,0.8)', { alpha: ra });
  ctx.restore();
  if (ra > 0.5) reg('stnum', STRIAE.n + ' 条', px + 26, py + 64, px + 180, py + 130);
  text('灰度剖面 · 峰计数', px + 26, py + 172, '400 21px SC', 'rgba(248,247,244,0.66)', { alpha: ra, id: 'stm' });
}

// ------------------------------------------------------------------ counting in field A
const MK = COUNT.marks.map(m => ({ w: plateToW('A', m[0], m[1]), r: m[2] * sA }));
const cRef = () => camAt(b(22));
const order = (() => { const c = cRef(); return MK.map((m, i) => [toS(c, m.w)[0], i]).sort((p, q) => p[0] - q[0]).map(p => p[1]); })();
// tick times: an accelerando from count0 to just before land2 (each interval 0.86 × the one before)
const MARK_T = (() => {
  const n = order.length, r = 0.93, span = T.land2 - BEAT / 8 - T.count0;
  const w = []; let s = 0; for (let i = 0; i < n - 1; i++) { w.push(Math.pow(r, i)); s += Math.pow(r, i); }
  const out = [T.count0]; let acc = T.count0; for (const x of w) { acc += x / s * span; out.push(acc); }
  const tt = new Array(n); order.forEach((mi, k) => { tt[mi] = out[k]; }); return tt;
})();
function counting(c, t) {
  const on = ss(seg(t, b(20.2), b(20.5))) * (1 - ss(seg(t, b(24.75), b(25.0))));
  if (on <= 0.003) return;
  const cr = cRef(), xs = order.map(i => toS(cr, MK[i].w)[0]), ts = order.map(i => MARK_T[i]);
  let fx;                                                                // the front passes each mark at its tick
  if (t <= ts[0]) fx = lerp(xs[0] - 160, xs[0], ss(seg(t, ts[0] - 0.3, ts[0])));
  else if (t >= ts[ts.length - 1]) fx = xs[xs.length - 1] + 200 * eo(seg(t, ts[ts.length - 1], ts[ts.length - 1] + 0.3));
  else { let k = 0; while (ts[k + 1] < t) k++; fx = lerp(xs[k], xs[k + 1], (t - ts[k]) / (ts[k + 1] - ts[k])); }
  const sc = toS(c, Ac), R = Math.min(A.r, A.cx - 3) * sA * c.k;
  ctx.save();
  MK.forEach((m, i) => {
    if (MARK_T[i] > t) return;
    const s = toS(c, m.w), age = t - MARK_T[i], rad = Math.max(16, m.r * c.k * 0.92);
    const drawn = eo(seg(age, 0, 0.16)), al = on * lerp(1, 0.6, ss(seg(age, 0.2, 0.8))) * (1 - ss(seg(t, b(24.05), b(24.5))));
    ctx.globalAlpha = al; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(s[0], s[1], rad, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * drawn);
    ctx.strokeStyle = 'rgba(255,253,250,0.8)'; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = CY_D; ctx.lineWidth = 2.2; ctx.stroke();
    if (age < 0.25) { ctx.globalAlpha = on * (1 - age / 0.25) * 0.45; ctx.fillStyle = CY; ctx.beginPath(); ctx.arc(s[0], s[1], rad, 0, 2 * Math.PI); ctx.fill(); }
  });
  ctx.restore();
  if (t > T.count0 - 0.3 && t < T.land2 + 0.35) {                       // the front, clipped to the ring
    const fa = on * (1 - ss(seg(t, T.land2, T.land2 + 0.3))) * ss(seg(t, T.count0 - 0.3, T.count0));
    const h = Math.sqrt(Math.max(0, R * R - (fx - sc[0]) ** 2));
    if (h > 0) {
      ctx.save(); ctx.globalAlpha = fa; ctx.shadowColor = CY; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.moveTo(fx, sc[1] - h); ctx.lineTo(fx, sc[1] + h); ctx.strokeStyle = CY_D; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
    }
  }
  const n = MARK_T.filter(x => x <= t).length;
  const ra = on;
  const px = sc[0] + R + 70, py = sc[1] - 120, pw = 300, ph = 200;
  line([[sc[0] + R * 0.94, sc[1] - 20], [px, sc[1] - 20]], WHITE_T, 'rgba(10,8,10,0.5)', 1.6, ra);
  panel(px, py, pw, ph, ra);
  text('视野内硅藻壳', px + 26, py + 46, '500 26px SC', 'rgba(248,247,244,0.88)', { alpha: ra, id: 'cntlab' });
  const done = t >= T.land2;
  const pop = done ? 1 + 0.08 * Math.exp(-(t - T.land2) * 9) * Math.sin((t - T.land2) * 30) : 1;
  ctx.save(); ctx.translate(px + 26, py + 132); ctx.scale(pop, pop);
  const nw = text(String(n), 0, 0, '300 88px BC', done ? CY : 'rgba(120,215,255,0.62)', { alpha: ra });
  text('个', nw + 10, 0, '400 28px SC', 'rgba(248,247,244,0.8)', { alpha: ra });
  ctx.restore();
  if (ra > 0.5) reg('cntnum', COUNT.n + ' 个', px + 26, py + 64, px + 180, py + 134);
  text('人工圈点', px + 26, py + 176, '400 21px SC', 'rgba(248,247,244,0.66)', { alpha: ra, id: 'cntm' });
}

// ------------------------------------------------------------------ the title, written on the frosted label
const TITLE = '一滴池塘水', TSTEP = BEAT / 4;          // written in 16ths: whole by 17.9 s
function title(c, t) {
  if (t < T.title - 0.05) return;
  const p = toS(c, [(SLIDE.lab + SLIDE.x1) / 2, -2.2]), sz = Math.round(3.6 * c.k);
  const halo = 'rgba(255,253,250,0.5)';
  ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(c.th);
  ctx.font = `600 ${sz}px SS`; ctx.textAlign = 'center';
  const wTot = ctx.measureText(TITLE).width; let x = -wTot / 2;
  [...TITLE].forEach((ch, i) => {
    const w = ctx.measureText(ch).width, a = ss(seg(t, T.title + i * TSTEP, T.title + i * TSTEP + 0.22));
    if (a > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(x - 4, -sz * 1.2, (w + 8) * a, sz * 1.6); ctx.clip();
      ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.fillText(ch, x, sz * 0.36); ctx.restore();
    }
    x += w;
  });
  // a rule drawn left to right under it, and a small line of method below
  const ra = eo(seg(t, T.final, T.final + 0.4));
  ctx.strokeStyle = INK; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(-wTot / 2, sz * 0.75); ctx.lineTo(-wTot / 2 + wTot * ra, sz * 0.75); ctx.stroke();
  ctx.restore();
  if (t >= T.title) reg('title', TITLE, p[0] - wTot / 2, p[1] - sz, p[0] + wTot / 2, p[1] + sz * 0.5);
}

// ------------------------------------------------------------------ climb clicks (where the zoom crosses back through ×10 and ×1)
const CLIMB_CLICKS = [b(24.5), b(25)];                                // ×100 → ×10 → ×1, on the 8ths

// ------------------------------------------------------------------ events for the mixer and the cue check
const EV = [
  { t: b(0.5), type: 'fall', dur: BEAT / 2 }, { t: T.drop, type: 'drop' }, { t: b(1.5), type: 'satellite' },
  { t: T.dive, type: 'dive' }, { t: T.x10, type: 'level', z: 10 }, { t: T.breath1, type: 'breath' },
  { t: T.x100, type: 'level', z: 100 }, { t: T.breath2, type: 'breath' }, { t: T.x400, type: 'level', z: 400 },
  { t: T.sweep0, type: 'sweep', dur: T.sweep1 - T.sweep0 }, { t: T.ring0, type: 'ring', dur: T.ring1 - T.ring0 },
  { t: T.scan0, type: 'scan', dur: T.land1 - T.scan0 }, ...STRIA_T.map(x => ({ t: +x.toFixed(4), type: 'stria' })),
  { t: T.land1, type: 'land', v: STRIAE.n }, { t: T.hush, type: 'hush' }, { t: T.first, type: 'first' },
  { t: T.count0, type: 'count', dur: T.land2 - T.count0 }, ...MARK_T.map(x => ({ t: +x.toFixed(4), type: 'mark' })),
  { t: T.land2, type: 'land2', v: COUNT.n }, { t: T.climb, type: 'climb', dur: T.x1 - T.climb },
  ...CLIMB_CLICKS.map(x => ({ t: x, type: 'objective', up: false })),
  { t: T.title, type: 'title', n: [...TITLE].length, step: TSTEP }, { t: T.final, type: 'final' },
].sort((p, q) => p.t - q.t);
window.EV = EV;

// ------------------------------------------------------------------ render
window.render = t => {
  TX = [];
  const c = camAt(t);
  scene(c, t);
  fields(c, t);
  composite(c, t);
  if (mixB(t) > 0.5) { nodule(c, t); striae(c, t); }
  if (mixA(t) > 0.15 && t > T.first) counting(c, t);
  title(c, t);
  instruments(c, t);
};
window.TEXTS = t => { window.render(t); return TX; };
window.READY = true;
