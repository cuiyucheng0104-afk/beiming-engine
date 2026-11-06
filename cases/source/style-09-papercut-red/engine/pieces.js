// Pieces for 鲤鱼跃龙门: carp, window flower, dragon gate, dragon rosette, 福 diamond, scissors, plain sheets.
// Every piece is a pre-rendered paper sprite (see paper.js piece()); geometry lives in its own unit coordinates.
import { PAL, canvas, piece, fill, cut, cutTaper, cutLine, inset, within, trace, curve, wob, Pl, P, ellipsePoly, finishPaper, transmitOf, rnd } from './paper.js';
import { along, sawRow, sawEdge, crescent, crescentPts, crescentRows, swirl, cloudCut, plum, rosette, dots, taper } from './motifs.js';

const TAU = Math.PI * 2;
export const COL = {
  red: '#d2201f', back: '#de3b30', deep: '#b8161c', near: '#dc2a22',
  rice: '#f2e8d0', gold: '#d9a93f',
  sky: '#1b2448', far: '#25315e', mid: '#2c3a6c', cloud: '#34457c', gate: '#121730', gateEdge: '#1a2142', river: '#18224a', river2: '#202c5c',
  steel: '#3b3f4f',
};
const lerp = (a, b, u) => a + (b - a) * u;
const interp = (tab, s) => { for (let i = 0; i < tab.length - 1; i++) { const [a, va] = tab[i], [b, vb] = tab[i + 1]; if (s <= b) { const u = (s - a) / (b - a); return lerp(va, vb, u * u * (3 - 2 * u)); } } return tab[tab.length - 1][1]; };
const offs = (pts, d) => pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [p[0] - dy / l * d, p[1] + dx / l * d]; });
const xf = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
const Mx = (s, a, x, y, fx = 1) => { const c = Math.cos(a), n = Math.sin(a); return [c * s * fx, n * s * fx, -n * s, c * s, x, y]; };  // mirror x first, then rotate, scale, translate

// =========================================================== CARP ===========================================================
// head toward +x; spine from tail base (s=0) to snout (s=1); bend arches the back
const WUP = [[0, 9], [.06, 13], [.22, 40], [.42, 58], [.6, 60], [.76, 52], [.88, 40], [.95, 26], [1, 5]];
const WLO = [[0, 9], [.06, 13], [.22, 38], [.42, 60], [.6, 66], [.76, 56], [.88, 42], [.95, 26], [1, 5]];
export function carpSpine(bend = .35, n = 60) {
  const L = 300, out = []; let x = 0, y = 0, a0 = 0;
  const ang = s => bend * (s - .5) * -1.2;
  // integrate from s = .5 both ways so the middle sits at the origin
  const pts = new Array(n + 1); const mid = n / 2; pts[mid] = [0, 0];
  for (let i = mid + 1; i <= n; i++) { const s = (i - .5) / n, a = ang(s); pts[i] = [pts[i - 1][0] + Math.cos(a) * L / n, pts[i - 1][1] + Math.sin(a) * L / n]; }
  for (let i = mid - 1; i >= 0; i--) { const s = (i + .5) / n, a = ang(s); pts[i] = [pts[i + 1][0] - Math.cos(a) * L / n, pts[i + 1][1] - Math.sin(a) * L / n]; }
  return pts.map(p => [p[0] + 15, p[1]]);
}
function frameAt(sp, s) {
  const n = sp.length - 1, f = Math.min(n - 1e-6, Math.max(0, s * n)), i = Math.floor(f), u = f - i, a = sp[i], b = sp[i + 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return { p: [lerp(a[0], b[0], u), lerp(a[1], b[1], u)], t: [dx / l, dy / l], n: [dy / l, -dx / l] };   // n = up (toward the back)
}
export function carpGeom(bend = .35, shrink = 0) {
  const sp = carpSpine(bend), N = 70, up = [], lo = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N, F = frameAt(sp, s), wu = Math.max(0, interp(WUP, s) - shrink), wl = Math.max(0, interp(WLO, s) - shrink);
    up.push([F.p[0] + F.n[0] * wu, F.p[1] + F.n[1] * wu]); lo.push([F.p[0] - F.n[0] * wl, F.p[1] - F.n[1] * wl]);
  }
  const body = up.concat(lo.reverse());
  const at = (s, d, along = 0) => { const F = frameAt(sp, s); return [F.p[0] + F.n[0] * d + F.t[0] * along, F.p[1] + F.n[1] * d + F.t[1] * along]; };
  const F0 = frameAt(sp, 0), T0 = F0.t, N0 = F0.n;
  const tl = (u, v) => [F0.p[0] - T0[0] * u + N0[0] * v, F0.p[1] - T0[1] * u + N0[1] * v];   // tail frame: u backward, v up
  const tail = curve([tl(-4, 12), tl(30, 34), tl(70, 66), tl(92, 70), tl(70, 30), tl(50, 0), tl(70, -30), tl(92, -72), tl(70, -68), tl(30, -36), tl(-4, -12)], true, 3);
  const dorsal = curve([at(.3, 50), at(.36, 80), at(.44, 94), at(.52, 88), at(.62, 70), at(.68, 54)], false, 3);
  const dorsalPoly = dorsal.concat([at(.66, 30), at(.32, 30)]);
  const fin = (s, side, len, sweep) => { const a = at(s, side * 30), b = at(s - .05, side * (30 + len), -sweep), c = at(s - .1, side * (30 + len * .7), -sweep * 1.4), d = at(s - .08, side * 30); return curve([a, b, c, d], true, 3); };
  return { sp, body, at, tail, tl, dorsal, dorsalPoly, pelvic: fin(.56, -1, 46, 20), anal: fin(.3, -1, 34, 18), pect: fin(.72, -1, 40, 30) };
}
// draw a carp into g (in carp units), col = paper colour
export function drawCarp(g, col = COL.red, bend = .55, opt = {}) {
  const G = carpGeom(bend), red = col;
  const solid = q => { trace(q, wob(G.body, .4, 3)); trace(q, wob(G.tail, .4, 4)); trace(q, wob(G.dorsalPoly, .4, 5)); trace(q, G.pelvic); trace(q, G.anal); };
  fill(g, solid, red);
  if (opt.solidOnly) return G;
  // tail rays and fin rays (tapered slits)
  for (const v of [46, 26, -26, -46]) taper(g, [G.tl(10, v * .3), G.tl(40, v * .8), G.tl(76, v * 1.18)], 6);
  for (let k = 0; k < 6; k++) { const s = .34 + k * .055; taper(g, [G.at(s, 64), G.at(s + .01, 72 + 18 * Math.sin(k / 5 * 3)), G.at(s + .02, 72 + 16 * Math.sin(k / 5 * 3))], 5); }
  // scales: crescent rows clipped to a shrunken body
  const inner = carpGeom(bend, 15).body;
  within(g, inner, () => {
    const s0 = .17, s1 = .74;
    cut(g, q => {
      for (let r = 0; r < 9; r++) for (let c = -3; c <= 3; c++) {
        const s = s0 + (s1 - s0) * (r + (c & 1) * .5) / 8.5, F = frameAt(G.sp, s), d = c * 15;
        const cx = F.p[0] + F.n[0] * d, cy = F.p[1] + F.n[1] * d, ang = Math.atan2(F.t[1], F.t[0]);
        const pts = crescentPts(0, 0, 13, Math.PI * .5 - 1.05, Math.PI * .5 + 1.05, 4.2, 10).map(([u, v]) => { const x = -v, y = u; return [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]; });
        trace(q, pts);
      }
    });
  });
  // gill arc, eye (two lids + pupil hole), mouth, pectoral swirl
  { const F = frameAt(G.sp, .79), a = Math.atan2(F.t[1], F.t[0]); cut(g, q => trace(q, crescentPts(F.p[0] - F.t[0] * 26, F.p[1] - F.t[1] * 26, 40, a - .85, a + .85, 5.5, 18))); }
  { const e = G.at(.885, 14), F = frameAt(G.sp, .885), a = Math.atan2(F.t[1], F.t[0]);
    cut(g, q => trace(q, crescentPts(e[0], e[1], 12, a + Math.PI + .5, a + TAU - .5, 3.6, 12)));
    cut(g, q => trace(q, crescentPts(e[0], e[1], 12, a + .5, a + Math.PI - .5, 3, 12)));
    cut(g, q => { q.moveTo(e[0] + 4.6, e[1]); q.arc(e[0], e[1], 4.6, 0, TAU); }); }
  taper(g, [G.at(1.0, -2, 4), G.at(.965, -6), G.at(.93, -4)], 4);
  swirl(g, ...G.at(.62, -22), 15, 1.6, 3.4, 0, 1);
  swirl(g, ...G.at(.12, 0), 8, 1.3, 2.6, 2, -1);
  inset(g, wob(G.body, .4, 3), 4, 1.5, red);
  // barbels: two fine red strands from the mouth
  g.save(); g.strokeStyle = red; g.lineCap = 'round';
  for (const [d, k] of [[-4, 1], [4, -1]]) { const p0 = G.at(.985, d), pts = curve([p0, G.at(1.02, d - 14 * k, 18), G.at(.96, d - 34 * k, 28), G.at(.9, d - 38 * k, 16)], false, 2); g.lineWidth = 3.2; g.beginPath(); trace(g, pts, false); g.stroke(); }
  g.restore();
  return G;
}
export const CARP_BOX = [-260, -175, 220, 180];
export function carpPiece(col = COL.red, bend = .55, seed = 11, ss = 2.4, opt = {}) {
  // opt.line = [inset, width]: an extra carved contour just inside the outline (separates overlapping red carps)
  const p = piece(CARP_BOX, g => { const G = drawCarp(g, col, bend); if (opt.line) inset(g, wob(G.body, .4, 3), opt.line[0], opt.line[1], col); }, { ss, seed, col });
  p.solid = piece(CARP_BOX, g => drawCarp(g, '#fff', bend, { solidOnly: true }), { ss, tex: false, edge: 0 });
  return p;
}

// ====================================================== WINDOW FLOWER ======================================================
// round window flower, radius 380, fold axis x = 0: two carps kissing a pearl, waves below, sawtooth ring
export const FR = 380;
export const FLOWER_CARP = { x: -128, y: 34, a: -1.05, s: 1.02 };    // left carp; the right one is its mirror
export function carpMatrix(c, fx = 1) { const M = Mx(c.s, c.a, c.x, c.y); return fx === 1 ? M : [-M[0], M[1], -M[2], M[3], -M[4], M[5]]; }
function drawFlowerCarps(g, col, mirrorOnly = 0) {
  for (const fx of [1, -1]) { if (mirrorOnly && fx !== mirrorOnly) continue; g.save(); g.transform(...carpMatrix(FLOWER_CARP, fx)); drawCarp(g, col); g.restore(); }
}
function flowerOuter(i = 0) { const o = []; for (let k = 0; k <= 240; k++) { const a = k / 240 * TAU, r = FR + 8 * Math.pow(Math.abs(Math.cos(a * 12)), .6) - i; o.push([Math.cos(a) * r, Math.sin(a) * r]); } return o; }
export function drawFlower(g, col = COL.red) {
  // whole disc, then cut the field away and keep ring + waves + pearl + carps
  fill(g, q => trace(q, wob(flowerOuter(), .4, 21)), col);
  const field = [];
  for (let k = 0; k <= 120; k++) { const a = k / 120 * TAU; field.push([Math.cos(a) * 326, Math.sin(a) * 326]); }
  cut(g, q => trace(q, field));
  // ring: crescents + small round holes on the band, inner sawtooth teeth pointing into the field
  cut(g, q => { for (let k = 0; k < 24; k++) { const a = (k + .5) / 24 * TAU; trace(q, crescentPts(Math.cos(a) * 354, Math.sin(a) * 354, 14, a + Math.PI - 1.2, a + Math.PI + 1.2, 5, 10)); } });
  dots(g, Array.from({ length: 24 }, (_, k) => { const a = k / 24 * TAU; return [Math.cos(a) * 356, Math.sin(a) * 356]; }), 3.4);
  g.save(); g.fillStyle = col; g.beginPath();
  const S = along(field.concat([field[0]]), 18);
  for (let i = 0; i < S.length - 1; i++) { const A = S[i], B = S[i + 1], m = [(A.x + B.x) / 2, (A.y + B.y) / 2], d = Math.hypot(...m); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.lineTo(m[0] * (1 - 16 / d), m[1] * (1 - 16 / d)); g.closePath(); }
  g.fill(); g.restore();
  // waves: a band along the bottom of the field with scalloped crests, crescent rows and curls
  const crest = []; for (let k = 0; k <= 80; k++) { const x = -330 + 660 * k / 80, ph = (x + 330) / 110 * TAU; crest.push([x, 188 - 22 * Math.pow(Math.abs(Math.sin(ph / 2)), .7)]); }
  const wave = crest.concat([[330, 330], [-330, 330]]);
  within(g, field, () => {
    fill(g, q => trace(q, wob(wave, .4, 31)), col);
    crescentRows(g, -340, 214, 340, 330, 15, 4.6, 0, .75);
    for (let k = 0; k < 6; k++) { const x = -275 + k * 110; swirl(g, x, 182, 14, 1.5, 4, 0, k % 2 ? 1 : -1); }
    // a second crest line inside the band (cut)
    const c2 = crest.map(([x, y]) => [x, y + 30]);
    cutTaper(g, c2.slice(4, 77), 5);
  });
  // pearl with flame tips, held up by a cloud stem from the ring
  const pr = [0, -214];
  fill(g, q => { q.moveTo(pr[0] + 40, pr[1]); q.arc(pr[0], pr[1], 40, 0, TAU); }, col);
  fill(g, q => trace(q, wob(curve([[-24, -244], [-16, -280], [0, -316], [16, -280], [24, -244]], true, 3), .4, 41)), col);
  fill(g, q => trace(q, curve([[-9, -334], [9, -334], [7, -280], [-7, -280]], true, 3)), col);
  swirl(g, pr[0], pr[1], 26, 1.8, 4.4, -1.2, 1);
  for (const sx of [-1, 1]) { taper(g, [[sx * 4, -282], [sx * 11, -292], [sx * 5, -302]], 3.2); }
  // carps
  drawFlowerCarps(g, col);
  // bridges: carp tails into the waves, chins to the pearl
  g.save(); g.strokeStyle = col; g.lineCap = 'round'; g.lineWidth = 7;
  for (const sx of [-1, 1]) { const m = xf(carpMatrix(FLOWER_CARP, sx), [168, 0]); g.beginPath(); g.moveTo(m[0], m[1]); g.quadraticCurveTo((m[0] + sx * 30) / 2, m[1] - 30, sx * 30, -196); g.stroke(); }
  g.restore();
}
export const FLOWER_BOX = [-FR - 12, -FR - 12, FR + 12, FR + 12];
export function flowerPieces(ss = 2.6) {
  const front = piece(FLOWER_BOX, g => drawFlower(g, COL.red), { ss, seed: 3, col: COL.red });
  const back = piece(FLOWER_BOX, g => drawFlower(g, COL.back), { ss, seed: 4, col: COL.back });
  return { front, back };
}

// ======================================================= DRAGON GATE =======================================================
// world units, x centred, base at y = 0 (caller translates). Dark indigo paper; lattice, plaque letters and windows are holes.
export const GATE = { w: 1240, h: 920 };
function roofPoly(x0, x1, yEave, yRidge, curl = 26, over = 40) {
  const w = x1 - x0, cx = (x0 + x1) / 2;
  return curve([[x0 - over, yEave - curl], [x0 - over * .4, yEave + 4], [x0 + w * .15, yEave + 10], [cx, yEave + 12], [x1 - w * .15, yEave + 10], [x1 + over * .4, yEave + 4], [x1 + over, yEave - curl],
    [x1 + over * .4, yEave - 16], [x1 - w * .1, yRidge + 22], [x1 - w * .06, yRidge - 6], [cx, yRidge + 2], [x0 + w * .06, yRidge - 6], [x0 + w * .1, yRidge + 22], [x0 - over * .4, yEave - 16]], true, 3);
}
export const GATE_HOLES = { plaque: [], lattice: [], windows: [] };
export function drawGate(g, col = COL.gate, groups = null) {
  const R = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const sol = [];
  // pillars
  for (const sx of [-1, 1]) {
    sol.push(R(sx * 250 - 34, -860, 68, 860), R(sx * 540 - 28, -640, 56, 640));
    sol.push(R(sx * 250 - 54, -70, 108, 70), R(sx * 540 - 44, -56, 88, 56));   // bases
  }
  // beams
  sol.push(R(-300, -700, 600, 46), R(-300, -840, 600, 52), R(-590, -560, 340, 40), R(250, -560, 340, 40), R(-590, -660, 340, 30), R(250, -660, 340, 30));
  // plaque
  sol.push(R(-150, -800, 300, 104));
  const roofs = [roofPoly(-310, 310, -862, -980, 34, 70), roofPoly(-600, -240, -666, -760, 24, 40), roofPoly(240, 600, -666, -760, 24, 40)];
  const solid = q => { for (const p of sol) trace(q, Pl(p, true, .35, 7)); for (const r of roofs) trace(q, wob(r, .35, 9)); };
  if (groups === 'solid') { fill(g, solid, col); return; }
  const only = groups;   // when drawing hole masks, draw only one group's holes in white
  if (!only) fill(g, solid, col);
  const H = (grp, fn) => { if (only) { if (only === grp) { g.save(); g.fillStyle = '#fff'; g.beginPath(); fn(g); g.fill(); g.restore(); } } else cut(g, fn); };
  // roof tiles: sawtooth rows along the eaves, ridge curls
  if (!only) {
    for (const [x0, x1, ye, yr] of [[-310, 310, -862, -980], [-600, -240, -666, -760], [240, 600, -666, -760]]) {
      sawRow(g, curve([[x0 - 30, ye - 20], [(x0 + x1) / 2, ye - 4], [x1 + 30, ye - 20]], false, 2), 26, 12, -1, .7);
      sawRow(g, curve([[x0, ye - 50], [(x0 + x1) / 2, ye - 36], [x1, ye - 50]], false, 2), 18, 10, -1, .6);
      for (const sx of [-1, 1]) swirl(g, (x0 + x1) / 2 + sx * (x1 - x0) * .42, yr + 12, 11, 1.4, 3.6, 0, sx);
    }
    // pillar couplet slits and joint swirls
    for (const sx of [-1, 1]) { cutTaper(g, [[sx * 250, -640], [sx * 250, -360], [sx * 250, -120]], 8); swirl(g, sx * 540, -600, 12, 1.5, 3.4, 0, sx); }
  }
  // plaque letters: cut-out characters (holes)
  H('plaque', q => { });
  // lattice holes in the beams: rows of coin and diamond holes
  H('lattice', q => {
    for (let k = 0; k < 9; k++) { const x = -260 + k * 65, y = -677; q.moveTo(x + 12, y); q.lineTo(x, y + 12); q.lineTo(x - 12, y); q.lineTo(x, y - 12); q.closePath(); }
    for (let k = 0; k < 8; k++) { const x = -228 + k * 65, y = -814; q.moveTo(x + 10, y); q.arc(x, y, 10, 0, TAU); }
    for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) { const x = sx * (300 + 40 + k * 56), y = -540; q.rect(x - 14, y - 2, 28, 22); }
  });
  // side bay windows: lattice squares (the "window flowers" of the gate)
  H('windows', q => {
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const x = sx * 395 + (i - 1) * 62, y = -630 + j * 0; q.rect(x - 22, y - 14, 44, 28); }
  });
  return { solid, roofs };
}
// plaque glyphs are drawn by the caller with the CJK font (needs document.fonts), so they live in their own helper
export function cutText(g, txt, x, y, size, family, mode = 'cut', col = '#fff') {
  g.save(); g.font = `900 ${size}px ${family}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (mode === 'cut') { g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; } else g.fillStyle = col;
  g.fillText(txt, x, y); g.restore();
}

// ====================================================== DRAGON ROSETTE ======================================================
// radius 600; two mirrored dragons coil round the centre disc; field cut away (holes = light)
export const RR = 600;
// left dragon: tail low near the axis, body waving up the left side, head at the top facing the pearl (+x)
const DCTRL = [[-40, 470], [-170, 455], [-262, 372], [-200, 268], [-262, 168], [-420, 120], [-440, -10], [-318, -92], [-268, -190], [-380, -262], [-326, -322], [-205, -326]];
function resample(pts, n) { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); const tot = L[L.length - 1], o = []; let j = 0; for (let k = 0; k <= n; k++) { const s = tot * k / n; while (j < pts.length - 2 && L[j + 1] < s) j++; const u = (s - L[j]) / ((L[j + 1] - L[j]) || 1); o.push([lerp(pts[j][0], pts[j + 1][0], u), lerp(pts[j][1], pts[j + 1][1], u)]); } return o; }
function dragonSpine(n = 160) { return resample(curve(DCTRL, false, 2), n); }
const DW = [[0, 4], [.1, 20], [.3, 40], [.55, 46], [.8, 44], [.93, 36], [1, 30]];
function dragonBody(shrink = 0) {
  const sp = dragonSpine(), n = sp.length - 1, a = [], b = [];
  for (let i = 0; i <= n; i++) { const s = i / n, p = sp[i], q = sp[Math.min(n, i + 1)], r = sp[Math.max(0, i - 1)], dx = q[0] - r[0], dy = q[1] - r[1], l = Math.hypot(dx, dy) || 1, w = Math.max(1, interp(DW, s) - shrink);
    a.push([p[0] - dy / l * w, p[1] + dx / l * w]); b.push([p[0] + dy / l * w, p[1] - dx / l * w]); }
  return { sp, poly: a.concat(b.slice().reverse()) };
}
function drawDragon(g, col) {
  const D = dragonBody(), sp = D.sp, n = sp.length - 1;
  const fr = s => { const i = Math.min(n - 1, Math.max(0, Math.floor(s * n))), p = sp[i], q = sp[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; let o = [-dy / l, dx / l]; if (o[0] * p[0] + o[1] * p[1] < 0) o = [-o[0], -o[1]]; return { p, t: [dx / l, dy / l], o }; };   // o = away from the centre
  const at = (s, d, al = 0) => { const F = fr(s); return [F.p[0] + F.o[0] * d + F.t[0] * al, F.p[1] + F.o[1] * d + F.t[1] * al]; };
  const solid = [wob(D.poly, .45, 51)];
  // dorsal flames on the outer side: a row of curved spikes
  for (let k = 0; k < 15; k++) {
    const s = .12 + k * .052, w = interp(DW, s), h = 26 + 10 * Math.sin(k * 1.7);
    solid.push(curve([at(s - .016, w - 4), at(s - .004, w + h * .6, -4), at(s + .01, w + h, -10), at(s + .006, w + h * .45, 2), at(s + .018, w - 4)], true, 2));
  }
  // legs: thick bent limbs with three hooked talons
  const leg = (s, side) => {
    const F = fr(s), o = [F.o[0] * side, F.o[1] * side], t = F.t, w = interp(DW, s);
    const L = (u, v) => [F.p[0] + o[0] * u + t[0] * v, F.p[1] + o[1] * u + t[1] * v];   // u away from body, v along body
    const poly = curve([L(w - 6, -24), L(w + 34, -34), L(w + 70, -14), L(w + 92, 18), L(w + 80, 30), L(w + 56, 8), L(w + 30, 2), L(w - 6, 18)], true, 2);
    solid.push(wob(poly, .4, 61 + s * 9));
    const foot = L(w + 88, 24);
    for (let k = -1; k <= 1; k++) { const dir = [o[0] * .55 + t[0] * .85 + o[0] * k * .5, o[1] * .55 + t[1] * .85 + o[1] * k * .5], dl = Math.hypot(...dir), d = [dir[0] / dl, dir[1] / dl], nn = [-d[1], d[0]];
      const P0 = [foot[0] + nn[0] * 7, foot[1] + nn[1] * 7], P1 = [foot[0] + d[0] * 28 + nn[0] * 6, foot[1] + d[1] * 28 + nn[1] * 6], P2 = [foot[0] + d[0] * 40 - nn[0] * 6, foot[1] + d[1] * 40 - nn[1] * 6], P3 = [foot[0] + d[0] * 22 - nn[0] * 2, foot[1] + d[1] * 22 - nn[1] * 2], P4 = [foot[0] - nn[0] * 7, foot[1] - nn[1] * 7];
      solid.push(curve([P0, P1, P2, P3, P4], true, 2)); }
    return L(w + 50, 6);
  };
  const joints = [leg(.24, -1), leg(.40, 1), leg(.66, -1), leg(.8, 1)];
  // head (profile facing +x, up = -y), anchored at the end of the spine, tilted up toward the pearl.
  // wedge skull with a curled nose bulb, open jaw with teeth, flame brow, antler horns ending in cloud curls, jagged beard and mane
  const E = sp[n], ang = -.2;
  const HS = 1.2, hp = (x, y) => { x *= HS; y *= HS; const c = Math.cos(ang), s = Math.sin(ang); return [E[0] + (x * c - y * s), E[1] + (x * s + y * c)]; };
  const H = pts => pts.map(([x, y]) => hp(x, y));
  const head = curve(H([[-46, -28], [-32, -48], [-12, -58], [4, -72], [14, -60], [30, -56], [42, -48], [70, -44], [98, -44], [112, -54], [124, -66], [140, -62], [148, -46],
    [138, -32], [114, -28], [86, -26], [60, -22], [42, -10], [62, -4], [92, -2], [116, 0], [128, 8], [116, 18], [84, 22], [54, 28], [30, 40], [4, 46], [-22, 40], [-42, 22], [-52, -2]]), true, 2);
  solid.push(wob(head, .35, 71));
  // teeth: upper row hanging from the lip, one lower fang
  for (const x of [56, 70, 84, 98]) solid.push(H([[x - 6, -24], [x + 6, -25], [x + 1, -13]]));
  solid.push(H([[104, -1], [114, 0], [110, -12]]));
  // antler horns: tapered bands sweeping back, each ending in a cloud curl (the curl is cut later)
  const band = (pts, w0, w1) => { const c = curve(H(pts), false, 2), m = c.length, L = [], R = [];
    for (let i = 0; i < m; i++) { const p0 = c[Math.max(0, i - 1)], p1 = c[Math.min(m - 1, i + 1)], dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1, w = lerp(w0, w1, i / (m - 1)) * HS;
      L.push([c[i][0] - dy / l * w, c[i][1] + dx / l * w]); R.push([c[i][0] + dy / l * w, c[i][1] - dx / l * w]); }
    return L.concat(R.reverse()); };
  const horns = [[[-4, -54], [-24, -70], [-48, -76], [-66, -70]], [[14, -62], [6, -80], [-12, -92], [-32, -92]]];
  const curls = [];
  for (const hn of horns) { solid.push(band(hn, 8, 5)); const e = hp(...hn[hn.length - 1]); curls.push(e); solid.push(ellipsePoly(e[0], e[1], 12 * HS, 12 * HS, 0, 24)); }
  solid.push(band([[-30, -64], [-36, -84], [-30, -96]], 5, 2.5));   // tine on the first horn
  // flame brow over the eye
  solid.push(curve(H([[14, -52], [24, -66], [32, -80], [36, -66], [46, -72], [48, -58], [40, -48]]), true, 2));
  // jagged beard hanging back from the chin, and a flame mane behind the skull
  const beard = sawEdge(curve(H([[48, 24], [28, 50], [2, 72], [-28, 88]]), false, 2), 11 * HS, 13 * HS, -1);
  solid.push(beard.concat(H([[-20, 62], [0, 44], [24, 30]])));
  const mane = sawEdge(curve(H([[-40, -36], [-70, -30], [-92, -6], [-100, 26]]), false, 2), 22 * HS, 20 * HS, -1);
  solid.push(mane.concat(H([[-62, 34], [-36, 18], [-24, -10]])));
  solid.push(curve(H([[-56, -14], [-84, 30], [-62, 64], [-24, 58], [-6, 30], [-20, 0]]), true, 2));   // neck: closes the gap between mane, jaw and body
  fill(g, q => { for (const p of solid) trace(q, p); }, col);
  // whiskers: curling strands from the nose bulb and the jaw tip
  g.save(); g.strokeStyle = col; g.lineCap = 'round';
  g.lineWidth = 5.5; g.beginPath(); trace(g, curve(H([[140, -60], [150, -84], [168, -94], [182, -86], [178, -72]]), false, 2), false); g.stroke();
  g.lineWidth = 5; g.beginPath(); trace(g, curve(H([[124, 10], [146, 30], [166, 32], [174, 16]]), false, 2), false); g.stroke();
  g.restore();
  // scales along the body, spine slit, joint swirls, face cuts
  const inner = dragonBody(12).poly;
  within(g, inner, () => cut(g, q => {
    for (let i = 0; i < 30; i++) for (const d of [-16, 0, 16]) { const s = .06 + .9 * (i + (d === 0 ? .5 : 0)) / 30, F = fr(s), c = [F.p[0] + F.o[0] * d, F.p[1] + F.o[1] * d], a = Math.atan2(F.t[1], F.t[0]);
      const pts = crescentPts(0, 0, 12, Math.PI * .5 - 1.1, Math.PI * .5 + 1.1, 4, 10).map(([u, v]) => { const x = -v, y = u; return [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)]; });
      trace(q, pts); }
  }));
  cutTaper(g, Array.from({ length: 60 }, (_, i) => at(.05 + i / 59 * .9, 30 * Math.min(1, (i + 4) / 14))), 4.4);
  for (const j of joints) swirl(g, j[0], j[1], 13, 1.5, 3.4, 0, 1);
  // crescent eye (upper lid, lower lid, pupil), nostril curl, mouth line, cheek swirl, horn cloud curls, beard slits
  const eye = hp(34, -36);
  cut(g, q => trace(q, crescentPts(eye[0], eye[1], 14, Math.PI + .25 + ang, TAU - .25 + ang, 5, 14)));
  cut(g, q => trace(q, crescentPts(eye[0], eye[1], 14, .5 + ang, Math.PI - .5 + ang, 3.2, 12)));
  cut(g, q => { q.moveTo(eye[0] + 5.5, eye[1]); q.arc(eye[0], eye[1], 5.5, 0, TAU); });
  swirl(g, ...hp(130, -50), 8, 1.4, 2.6, 0, 1);
  cutTaper(g, H([[66, -36], [90, -36], [110, -42]]), 3.6);
  cutTaper(g, H([[-28, -2], [-16, 22], [4, 36]]), 4);
  swirl(g, ...hp(-8, -14), 13, 1.5, 3.2, 0, -1);
  for (const c of curls) swirl(g, c[0], c[1], 9 * HS, 1.4, 2.6, ang, -1);
  for (let k = 0; k < 3; k++) cutTaper(g, H([[30 - k * 18, 40 + k * 10], [16 - k * 18, 56 + k * 10], [2 - k * 18, 64 + k * 10]]), 3);
  return { D, at, fr };
}
function rosOuter(i = 0) { const o = []; for (let k = 0; k <= 320; k++) { const a = k / 320 * TAU, r = RR - 18 + 18 * Math.pow(Math.abs(Math.cos(a * 8)), .6) - i; o.push([Math.cos(a) * r, Math.sin(a) * r]); } return o; }
export function drawRosette(g, col = COL.red) {
  fill(g, q => trace(q, wob(rosOuter(), .45, 81)), col);
  const field = []; for (let k = 0; k <= 160; k++) { const a = k / 160 * TAU; field.push([Math.cos(a) * 506, Math.sin(a) * 506]); }
  cut(g, q => trace(q, field));
  // ring band yin cuts: crescents, plum holes, lobe veins
  cut(g, q => { for (let k = 0; k < 32; k++) { const a = (k + .5) / 32 * TAU; trace(q, crescentPts(Math.cos(a) * 546, Math.sin(a) * 546, 17, a + Math.PI - 1.15, a + Math.PI + 1.15, 6, 10)); } });
  for (let k = 0; k < 16; k++) { const a = k / 16 * TAU + TAU / 32; plum(g, Math.cos(a) * 568, Math.sin(a) * 568, 9, a); }
  // inner sawtooth teeth into the field
  g.save(); g.fillStyle = col; g.beginPath();
  { const S = along(field.concat([field[0]]), 20); for (let i = 0; i < S.length - 1; i++) { const A = S[i], B = S[i + 1], m = [(A.x + B.x) / 2, (A.y + B.y) / 2], d = Math.hypot(...m); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.lineTo(m[0] * (1 - 20 / d), m[1] * (1 - 20 / d)); g.closePath(); } }
  g.fill(); g.restore();
  // centre disc for the 福, with a sawtooth halo and petal holes
  fill(g, q => { q.moveTo(196, 0); q.arc(0, 0, 196, 0, TAU); }, col);
  cut(g, q => { for (let k = 0; k < 20; k++) { const a = (k + .5) / 20 * TAU; trace(q, crescentPts(Math.cos(a) * 178, Math.sin(a) * 178, 11, a + Math.PI - 1.1, a + Math.PI + 1.1, 4, 8)); } });
  sawRow(g, ellipsePoly(0, 0, 160, 160, 0, 96), 14, 10, -1, .7);
  // radial cloud bridges between the disc, the dragons and the ring (no floating islands)
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU + TAU / 16;
    g.save(); g.strokeStyle = col; g.lineCap = 'round'; g.lineWidth = 12; g.beginPath(); g.moveTo(Math.cos(a) * 190, Math.sin(a) * 190); g.lineTo(Math.cos(a) * 300, Math.sin(a) * 300); g.stroke();
    g.lineWidth = 9; g.beginPath(); g.moveTo(Math.cos(a) * 400, Math.sin(a) * 400); g.lineTo(Math.cos(a) * 512, Math.sin(a) * 512); g.stroke(); g.restore();
    const c = [Math.cos(a) * 252, Math.sin(a) * 252];
    fill(g, q => { for (const [dx, dy, r] of [[0, 0, 34], [26, 14, 22], [-26, 14, 22], [0, -22, 20]]) { const x = c[0] + dx * Math.cos(a + Math.PI / 2) - dy * Math.sin(a + Math.PI / 2), y = c[1] + dx * Math.sin(a + Math.PI / 2) + dy * Math.cos(a + Math.PI / 2); q.moveTo(x + r, y); q.arc(x, y, r, 0, TAU); } }, col);
    cloudCut(g, c[0], c[1], 16, 3.6, a, k % 2 ? 1 : -1);
  }
  // dragons (left, then mirrored right)
  drawDragon(g, col);
  g.save(); g.scale(-1, 1); drawDragon(g, col); g.restore();
  // flaming pearl at the top, between the heads
  const pr = [0, -440];
  fill(g, q => { q.moveTo(pr[0] + 36, pr[1]); q.arc(pr[0], pr[1], 36, 0, TAU); }, col);
  fill(g, q => trace(q, curve([[-22, -470], [-34, -500], [-12, -490], [0, -520], [12, -490], [34, -500], [22, -470]], true, 2)), col);
  swirl(g, pr[0], pr[1], 22, 1.8, 4.2, -1.2, 1);
}
export const ROS_BOX = [-RR - 6, -RR - 6, RR + 6, RR + 6];
export function rosettePieces(ss = 1.6) {
  const front = piece(ROS_BOX, g => drawRosette(g, COL.red), { ss, seed: 5, col: COL.red });
  const back = piece(ROS_BOX, g => drawRosette(g, COL.back), { ss, seed: 6, col: COL.back });
  return { front, back };
}

// ========================================================= 福 DIAMOND =========================================================
export const FUR = 150;   // half-diagonal
export function drawFu(g, col = COL.red, family = '"Noto Serif SC"') {
  const D = [[0, -FUR], [FUR, 0], [0, FUR], [-FUR, 0]];
  const edge = []; for (let i = 0; i < 4; i++) { const a = D[i], b = D[(i + 1) % 4]; edge.push(...sawEdge([a, b], 9, 14, -1)); }
  fill(g, q => trace(q, wob(edge, .35, 91)), col);
  // inner border slit and corner plums
  const k = .82; cutTaper(g, [[0, -FUR * k], [FUR * k, 0], [0, FUR * k], [-FUR * k, 0], [0, -FUR * k]], 4, true);
  for (const [x, y] of D) plum(g, x * .9, y * .9, 6, 0);
  cutText(g, '福', 0, 6, 170, family, 'cut');
}
export const FU_BOX = [-FUR - 14, -FUR - 14, FUR + 14, FUR + 14];
export function fuPieces(ss = 2.4) {
  return {
    front: piece(FU_BOX, g => drawFu(g, COL.red), { ss, seed: 7, col: COL.red }),
    back: piece(FU_BOX, g => drawFu(g, COL.back), { ss, seed: 8, col: COL.back }),
    plainF: piece(FU_BOX, g => fill(g, q => trace(q, [[0, -FUR], [FUR, 0], [0, FUR], [-FUR, 0]]), COL.red), { ss, seed: 9, col: COL.red, edge: .8 }),
    plainB: piece(FU_BOX, g => fill(g, q => trace(q, [[0, -FUR], [FUR, 0], [0, FUR], [-FUR, 0]]), COL.back), { ss, seed: 10, col: COL.back, edge: .8 }),
  };
}

// ========================================================= SCISSORS =========================================================
// pivot (rivet) at the origin, blades along +x; blade A above the axis, B below; each with a finger ring behind
function drawBlade(g, side, col) {
  const s = side;
  const blade = curve([[-14, -9 * s], [40, -10 * s], [120, -7 * s], [176, -1.5 * s], [182, 0], [150, 4 * s], [60, 7 * s], [0, 8 * s], [-14, 6 * s]], true, 2);
  const shank = curve([[-10, -6 * s], [-40, 6 * s], [-64, 20 * s], [-76, 30 * s], [-58, 36 * s], [-30, 16 * s], [-4, 6 * s]], true, 2);
  fill(g, q => { trace(q, blade); trace(q, shank); q.moveTo(-84 + 34, 40 * s); q.arc(-84, 40 * s, 34, 0, TAU); }, col);
  cut(g, q => { q.moveTo(-84 + 21, 40 * s); q.arc(-84, 40 * s, 21, 0, TAU); });
  cutTaper(g, [[20, -2 * s], [90, -2 * s], [150, -1 * s]], 2.4);
}
export function scissorsPieces(ss = 2.4) {
  return { A: piece([-125, -80, 186, 80], g => drawBlade(g, 1, COL.steel), { ss, seed: 12, col: COL.steel }), B: piece([-125, -80, 186, 80], g => drawBlade(g, -1, COL.steel), { ss, seed: 13, col: COL.steel }) };
}

// plain square sheet (fold & cut stage)
export function sheetPieces(half = 400, ss = 2.2) {
  const sq = col => piece([-half, -half, half, half], g => fill(g, q => trace(q, Pl([[-half, -half], [half, -half], [half, half], [-half, half]], true, .3, 2)), col), { ss, seed: 14, col, edge: .8 });
  return { front: sq(COL.red), back: sq(COL.back) };
}

// gate sprite + one white mask per group of holes (lit separately)
export function gatePieces(family = '"Noto Serif SC"', ss = 1.6) {
  const BOX = [-680, -1010, 680, 10];
  const plaqueText = (g, mode) => { g.save(); cutText(g, '龙门', 0, -746, 84, family, mode, '#fff'); g.restore(); };
  const front = piece(BOX, g => { drawGate(g, COL.gate); plaqueText(g, 'cut'); }, { ss, seed: 15, col: COL.gate, texScale: 1 });
  const mask = grp => piece(BOX, g => { if (grp === 'plaque') plaqueText(g, 'fill'); else drawGate(g, COL.gate, grp); }, { ss, tex: false, edge: 0 });
  const solid = piece(BOX, g => drawGate(g, '#fff', 'solid'), { ss, tex: false, edge: 0 });
  return { front, solid, plaque: mask('plaque'), lattice: mask('lattice'), windows: mask('windows') };
}
