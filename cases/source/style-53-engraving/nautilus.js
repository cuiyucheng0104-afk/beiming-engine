// The chambered nautilus, built from its own growth law: a logarithmic spiral whose whorl triples in radius per turn.
//   buildShell()   → the lateral view (outline runs, growth-line hatching, crossings, darks, colour regions)
//   buildSection() → the median section for the roundel (wall, septa, chambers, siphuncle, ruled ground)
import * as B from './engine/burin.js';
const { clamp, hatch, outline, stroke, RNG, noise1, noise2, inPoly, ring, sstep } = B;
export const LIGHT = [-0.55, -0.62];
const KB = Math.log(3) / (2 * Math.PI), TAU = Math.PI * 2;

// spiral geometry around a pole (px, py), aperture radius r1 at angle psi0; theta ≤ 0 runs back toward the apex
export function geo(px, py, r1, psi0) {
  const R = th => r1 * Math.exp(KB * th);
  const P = (th, rr) => { const a = psi0 + th; return [px + rr * Math.cos(a), py + rr * Math.sin(a)]; };
  const S = th => P(th, R(th));
  // growth line through whorl angle th: from the umbilicus (u→0) to the venter (u=1), bowed forward on the flank and
  // swept back into the hyponomic sinus at the venter. The aperture lip is the last growth line (th = 0).
  const dl = u => 0.30 * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 1.2) * (1 - 0.35 * u) - 0.10 * Math.pow(u, 4);
  const growth = (th, u) => P(th + dl(u), u * R(th + dl(u)));
  // where the lip meets the previous whorl: u·r1 = R(dl(u) − 2π)
  let uS = 1 / 3; for (let k = 0; k < 30; k++) uS = Math.exp(KB * (dl(uS) - TAU)) * (R(0) / r1) ;
  const thS = dl(uS) - TAU;
  const lip = (n = 60) => { const out = []; for (let i = 0; i <= n; i++) out.push(growth(0, 1 + (uS - 1) * i / n)); return out; };
  const outer = (a = thS, b = 0, n = 420) => { const o = []; for (let i = 0; i <= n; i++) o.push(S(a + (b - a) * i / n)); return o; };
  return { R, P, S, lip, outer, growth, dl, thS, uS, px, py, r1, psi0 };
}
// fit: choose a pole so the silhouette's bbox centre lands on (cx, cy)
export function fitPole(cx, cy, r1, psi0) {
  const g = geo(0, 0, r1, psi0), pts = [...g.outer(), ...g.lip()], bb = B.bboxOf([pts]);
  return [cx - (bb[0] + bb[2]) / 2, cy - (bb[1] + bb[3]) / 2, bb[3] - bb[1], bb[2] - bb[0]];
}

// ---------------------------------------------------------------- the lateral view
export function buildShell({ cx = 700, cy = 545, r1 = 505, psi0 = -0.2, seed = 3 } = {}) {
  const [px, py, Hh, Ww] = fitPole(cx, cy, r1, psi0), g = geo(px, py, r1, psi0), ink = new B.Ink();
  const outerPts = g.outer(g.thS, 0, 480), lipPts = g.lip(70);
  const shellPoly = [...outerPts, ...lipPts.slice(1, -1)];
  const shell = ring(shellPoly);
  // umbilical callus: a small domed boss at the pole
  const cal = B.ellipse(px, py, r1 * 0.068, r1 * 0.064, 0.4, 60);
  // the black layer: a dark crescent on the previous whorl just ahead of the aperture, where the hood rests
  const cres = [], CA = 0.8;
  for (let i = 0; i <= 40; i++) { const f = i / 40, ph = g.thS + 0.02 + CA * f; cres.push(g.P(ph, g.R(ph) * 0.992)); }
  for (let i = 40; i >= 0; i--) { const f = i / 40, ph = g.thS + 0.02 + CA * f; cres.push(g.P(ph, g.R(ph) * (1 - 0.3 * Math.pow(1 - f, 0.85) - 0.02))); }
  const crescent = ring(cres);
  // polar coordinates in the shell: whorl angle a at this direction (the body whorl inside the lip's forward bow), fraction u of its radius
  const polar = (x, y) => { const dx = x - px, dy = y - py, rr = Math.hypot(dx, dy); let a = Math.atan2(dy, dx) - psi0; while (a > 0) a -= TAU; while (a <= -TAU) a += TAU;
    if (rr / g.R(a) > 1.0 && a < -TAU + 0.45) a += TAU; return [a, rr / g.R(a), rr]; };
  // stripes: the brown flames of N. pompilius on the older part of the body whorl, umbilical shoulder → venter, zigzag edged
  const stripes = [];
  const growth = g.growth;
  const SR = RNG(seed + 40);
  for (let k = 0; k < 9; k++) {
    const th = g.thS + 0.5 + k * 0.4 + (SR() - 0.5) * 0.06, w0 = 0.045 + SR() * 0.03, w1 = 0.11 + SR() * 0.06, u0 = 0.2 + SR() * 0.14, ph = SR() * 6;
    const L = [], Rr = [];
    for (let i = 0; i <= 48; i++) { const u = u0 + (0.975 - u0) * i / 48, zz = 0.03 * Math.abs(((u * 9 + ph) % 1) - 0.5) * 2 + 0.012 * Math.sin(u * 37 + k);
      L.push(growth(th + zz, u)); Rr.push(growth(th + w0 + (w1 - w0) * Math.pow(u, 1.3) + zz * 0.7, Math.min(0.975, u))); }
    // a pointed root: the flame starts as a thin line near the umbilical shoulder
    L[0] = growth(th + w0 * 0.5, u0 - 0.05);
    stripes.push(ring([...L, ...Rr.reverse()]));
  }
  // tone: analytic. The flank is a dome across the whorl (umbilicus → venter), lit from the upper left; the umbilical funnel and
  // the black layer are deep. No texture anywhere: tone comes only from the shape.
  const Lv = (() => { const l = Math.hypot(-0.55, -0.62, 0.56); return [-0.55 / l, -0.62 / l, 0.56 / l]; })();
  const tone = (x, y) => {
    const [a, u] = polar(x, y), dir = psi0 + a, c = (u - 0.56) / 0.46, h = Math.sqrt(Math.max(0.02, 1 - c * c));
    const s = clamp(-c / 0.46 / h * 0.42, -2.6, 2.6);              // dh/dr
    const nx = -s * Math.cos(dir), ny = -s * Math.sin(dir), nl = Math.hypot(nx, ny, 1);
    const lam = clamp((nx * Lv[0] + ny * Lv[1] + Lv[2]) / nl);
    let t = 0.02 + (1 - lam) * 0.98 + 0.28 * (1 - sstep(0.1, 0.26, u));
    if (inPoly(crescent.polys, x, y)) t = Math.max(t, 0.9);
    return clamp(t);
  };
  // ---- first pass: the outline, in runs
  ink.group('runA'); outline(ink, outerPts, { closed: false, w: 2.5, light: LIGHT, taper: 30, swell: false, seed, w0: 0.6, w1: 1.15 });
  ink.group('runB'); outline(ink, lipPts, { closed: false, w: 2.6, light: LIGHT, taper: 26, seed: seed + 1 });
  ink.group('runC'); outline(ink, cres.slice(41).reverse(), { closed: false, w: 1.7, taper: 24, seed: seed + 2 });
  ink.group('runD'); outline(ink, cal.polys[0], { w: 1.5, light: LIGHT, seed: seed + 3, run: 60 });
  // run E: the inner whorl seam showing through the aperture, and the edge of the old lip line
  // run E: the lip carried on over the previous whorl to the callus (the last growth line), and a growth check on the flank
  ink.group('runE'); { const pts = []; for (let i = 0; i <= 50; i++) pts.push(growth(0, g.uS - (g.uS - 0.17) * i / 50)); stroke(ink, pts, 1.5, { taper: 26 });
    const p2 = []; for (let i = 0; i <= 50; i++) p2.push(growth(-1.15, 0.2 + 0.78 * i / 50)); stroke(ink, p2, 1.0, { taper: 40 }); }
  // ---- second pass: growth lines (the engraver's form-following family), swelling where the form turns away
  ink.group('h1');
  { const R = RNG(seed + 7); let th = g.thS + 0.004, i = 0;
    while (th < -0.012) {
      // spacing ≈ 4.1 px at the venter; lines are dropped toward the umbilicus so the arc spacing never falls below ~3 px
      // (all lines from u 0.74, half from 0.46, a quarter from 0.27, an eighth from 0.1) — no grey, no moiré at 1×
      const sp = 4.1 / (g.R(th) * 1.0), u0 = [0.1, 0.74, 0.46, 0.74, 0.27, 0.74, 0.46, 0.74][i % 8] + R() * 0.04, n = 90, pts = [], ws = [];
      for (let j = 0; j <= n; j++) { const u = u0 + (0.985 - u0) * j / n, [x, y] = growth(th, u); pts.push([x, y]);
        let w = 0; if (inPoly(shell.polys, x, y) && !inPoly(cal.polys, x, y)) { const v = (tone(x, y) - 0.12) / 0.88; if (v > 0) w = 0.2 + 1.75 * Math.min(1, v * 1.25); }
        const e = Math.min(j, n - j) / n; w *= 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * j / n), 0.7); if (e < 0.12) w *= Math.pow(e / 0.12, 0.8);
        ws.push(w); }
      ink.add(pts, ws); th += sp * (1 + (R() - 0.5) * 0.12); i++;
    } }
  // ---- third pass: the crossing family in the half-tones, the lozenge family in the deepest darks, stipple on the callus
  ink.group('h2'); hatch(ink, shell.polys, { angle: 0.62, spacing: 4.3, tone, thr: 0.5, wMax: 1.45, seed: seed + 11, excl: cal.polys });
  ink.group('h3'); hatch(ink, shell.polys, { angle: -0.42, spacing: 4.9, tone, thr: 0.77, wMax: 1.05, seed: seed + 23, excl: cal.polys });
  hatch(ink, crescent.polys, { angle: 1.2, spacing: 3.2, tone: () => 0.95, thr: 0.2, wMax: 1.6, seed: seed + 29 });
  // the callus is a low dome: contour arcs on the side away from the light, stipple where it turns
  ink.group('h2'); for (let k = 1; k <= 5; k++) { const rr = r1 * 0.068 * (1 - k * 0.16), pts = []; for (let i = 0; i <= 30; i++) { const a = -0.35 + 2.3 * i / 30; pts.push([px + Math.cos(a) * rr * 1.0, py + Math.sin(a) * rr * 0.94]); } stroke(ink, pts, 0.75 + 0.12 * (5 - k), { taper: 10 }); }
  ink.group('h3');
  B.stipple(ink, cal.polys, { density: 0.05, tone: (x, y) => 0.35 + 0.5 * clamp(((x - px) * 0.6 + (y - py) * 0.7) / (r1 * 0.09) * 0.5 + 0.5), r: 0.75, seed: seed + 31 });
  B.stipple(ink, shell.polys, { density: 0.0035, tone: (x, y) => tone(x, y) > 0.6 ? tone(x, y) : 0, r: 0.6, thr: 0.55, seed: seed + 37, excl: cal.polys });
  const mk = list => { const p = new Path2D(); for (const s of list) p.addPath(s.path); return { path: p, polys: list.flatMap(s => s.polys) }; };
  return { ink, g, shell, stripes, regions: { shell: mk([shell]), stripes: stripes.map(s => mk([s])) }, pole: [px, py], H: Hh, W: Ww,
    // the chambered part the roundel opens: a ring around the inner whorls
    focus: { x: px + r1 * 0.04, y: py + r1 * 0.02, r: r1 * 0.34 } };
}

// ---------------------------------------------------------------- the median section (local units, roundel radius 500)
export function buildSection({ septa = 16, seed = 9 } = {}) {
  const psi0 = -0.2, r1 = 548;
  const [px, py] = fitPole(0, 6, r1, psi0), g = geo(px, py, r1, psi0);
  const ink = new B.Ink();
  const thLast = -2.25, dTh = 0.6, TH = Array.from({ length: septa }, (_, k) => thLast - (septa - 1 - k) * dTh);
  const thMin = TH[0] - 3.4;                                       // innermost visible whorl
  const sil = ring([...g.outer(g.thS, 0, 300), ...g.lip(40).slice(1, -1)]);
  // ruled ground: the machine-ruled background, with a clean halo round the subject
  const halo = ring(B.offsetRing(sil.polys[0], 16));
  const circ = B.ellipse(0, 0, 492, 492, 0, 120);
  ink.group('ground'); hatch(ink, circ.polys, { angle: 0, spacing: 11, tone: () => 0.5, thr: 0.1, wMin: 1.15, wMax: 1.9, swell: 0.35, wobble: 0.15, jitter: 0.02, seed: seed + 1, excl: halo.polys });
  // septum k: from the inner wall (previous whorl) to the outer wall, bowed back toward the apex
  const sept = th => { const a = g.P(th, g.R(th - TAU)), b = g.S(th), d = g.R(th) - g.R(th - TAU);
    const tx = -Math.sin(psi0 + th), ty = Math.cos(psi0 + th);           // d/dtheta direction (forward)
    const m = [(a[0] + b[0]) / 2 - tx * d * 0.3, (a[1] + b[1]) / 2 - ty * d * 0.3], pts = [];
    for (let i = 0; i <= 24; i++) { const u = i / 24, v = 1 - u; pts.push([v * v * a[0] + 2 * u * v * m[0] + u * u * b[0], v * v * a[1] + 2 * u * v * m[1] + u * u * b[1]]); }
    return pts; };
  const spiralSeg = (a, b, f = 1, n = 40) => { const o = []; for (let i = 0; i <= n; i++) { const th = a + (b - a) * i / n; o.push(g.P(th, g.R(th) * f)); } return o; };
  // wall: the shell's spiral wall through every whorl (one long cut), its inner face, the aperture
  ink.group('wall');
  outline(ink, spiralSeg(thMin, 0, 1, 700), { closed: false, w: 5.2, taper: 40, swell: false, w0: 0.35, w1: 1.1, seed });
  outline(ink, spiralSeg(thMin + 0.4, 0, 0.965, 600), { closed: false, w: 1.6, taper: 30, swell: false, w0: 0.3, w1: 1, seed: seed + 1 });
  stroke(ink, g.lip(40), 3.2, { taper: 14 });
  stroke(ink, B.ellipsePts(...g.P(thMin, g.R(thMin) * 0.5), g.R(thMin) * 0.5, g.R(thMin) * 0.5, 0, 24), 1.6, { taper: 4 });   // the protoconch
  // chambers: between consecutive septa; a cavity, lit as a hollow (light reversed), lines run along the tube
  const chamberPoly = (a, b) => { const s0 = a == null ? null : sept(a), s1 = sept(b), pts = [];
    if (s0) pts.push(...s0); else pts.push(g.P(thMin, g.R(thMin) * 0.4));
    pts.push(...spiralSeg(a ?? thMin, b, 0.96, 30).slice(1, -1));
    pts.push(...s1.slice().reverse());
    const inner = []; for (let i = 0; i <= 30; i++) { const th = b + ((a ?? thMin) - b) * i / 30; inner.push(g.P(th, g.R(th - TAU) * 1.04)); }
    pts.push(...inner.slice(1, -1)); return ring(pts); };
  const chambers = [];
  for (let k = 0; k <= septa; k++) {
    const a = k === 0 ? null : TH[k - 1], b = k < septa ? TH[k] : null;
    let poly;
    if (b == null) {   // the living chamber: last septum → aperture
      const s0 = sept(TH[septa - 1]), pts = [...s0, ...spiralSeg(TH[septa - 1], 0, 0.965, 40).slice(1), ...g.lip(30).slice(1, -1)];
      for (let i = 0; i <= 30; i++) { const th = 0 + (TH[septa - 1] - 0) * i / 30; pts.push(g.P(th, g.R(th - TAU) * 1.04)); }
      poly = ring(pts);
    } else poly = chamberPoly(a, b);
    chambers.push(poly);
  }
  // septa and chamber linework, one group each, so they can be cut one after another
  const sip = th => g.R(th) * (2 / 3);
  chambers.forEach((ch, k) => {
    const a = k === 0 ? thMin : TH[k - 1], b = k < septa ? TH[k] : 0.0, mid = (a + b) / 2, size = g.R(mid) - g.R(mid - TAU);
    const tone = B.formTone(ch.polys, { light: [0.55, 0.62], base: 0.18, rim: 0.15, res: 70 });
    ink.group('c' + k);
    const ang = psi0 + mid + Math.PI / 2;
    hatch(ink, ch.polys, { angle: ang, spacing: Math.max(2.2, size * 0.055), tone, thr: 0.22, wMin: 0.25, wMax: Math.max(0.9, size * 0.02), seed: seed + 50 + k, bend: 0 });
    if (k < septa) hatch(ink, ch.polys, { angle: ang + 1.1, spacing: Math.max(2.5, size * 0.065), tone, thr: 0.62, wMin: 0.25, wMax: Math.max(0.8, size * 0.016), seed: seed + 90 + k });
    // the siphuncle passing through this chamber: a narrow tube
    if (k < septa) { const t0 = k === 0 ? thMin + 1.2 : a, t1 = b;
      const hw = th => g.R(th) * 0.03;
      const l1 = [], l2 = []; for (let i = 0; i <= 16; i++) { const th = t0 + (t1 - t0) * i / 16; l1.push(g.P(th, sip(th) - hw(th))); l2.push(g.P(th, sip(th) + hw(th))); }
      stroke(ink, l1, Math.max(0.7, size * 0.012), { taper: 3, swell: false }); stroke(ink, l2, Math.max(0.7, size * 0.012), { taper: 3, swell: false }); }
    if (k < septa) { ink.group('s' + k); const s = sept(TH[k]), w = Math.max(1.2, size * 0.03);
      outline(ink, s, { closed: false, w, taper: 6, swell: false, w0: 0.7, w1: 1.1, seed: seed + k });
      const s2 = s.map(([x, y], i) => { const tx = -Math.sin(psi0 + TH[k]), ty = Math.cos(psi0 + TH[k]), o = size * 0.035; return [x + tx * o, y + ty * o]; });
      stroke(ink, s2, w * 0.4, { taper: 6, swell: false });
      // septal neck: a short collar where the siphuncle pierces the septum
      const nk = g.P(TH[k], sip(TH[k])), d = size * 0.07, tx = -Math.sin(psi0 + TH[k]), ty = Math.cos(psi0 + TH[k]), nx = Math.cos(psi0 + TH[k]), ny = Math.sin(psi0 + TH[k]);
      for (const sg of [-1, 1]) stroke(ink, [[nk[0] + nx * sg * g.R(TH[k]) * 0.032, nk[1] + ny * sg * g.R(TH[k]) * 0.032], [nk[0] + nx * sg * g.R(TH[k]) * 0.032 - tx * d, nk[1] + ny * sg * g.R(TH[k]) * 0.032 - ty * d]], w * 0.6, { taper: 2, swell: false });
    }
  });
  // the siphuncle's centre line, for the red trace (apex → last septum, then a little into the living chamber)
  // the siphuncle ends at the last septum: the colour stops there and never enters the living chamber
  const thRedEnd = TH[septa - 1] - 0.03;
  const red = []; for (let i = 0; i <= 600; i++) { const th = (thMin + 1.2) + (thRedEnd - (thMin + 1.2)) * i / 600; red.push(g.P(th, sip(th))); }
  const redW = red.map((_, i) => { const th = (thMin + 1.2) + (thRedEnd - (thMin + 1.2)) * i / 600, u = i / 600; return g.R(th) * 0.062 * Math.min(1, u / 0.04 + 0.3) * Math.min(1, (1 - u) / 0.05 + 0.45); });
  // the engraver's construction for the section, in sepia: the growth spiral, the inner whorl, the septa (shown before they are cut)
  const guide = { spiral: spiralSeg(thMin, 0, 1, 500), inner: spiralSeg(thMin + 0.4, 0, 0.965, 400), septa: TH.map(sept), sip: (() => { const o = []; for (let i = 0; i <= 200; i++) { const th = (thMin + 1.2) + (thRedEnd - (thMin + 1.2)) * i / 200; o.push(g.P(th, sip(th))); } return o; })() };
  return { ink, g, chambers, sil, red, redW, TH, septa, guide,
    // label anchors (local): a mid chamber, and the siphuncle in a large chamber
    anchors: { chamber: (() => { const th = Math.PI / 2 - psi0 - TAU + 0.1; const k = TH.findIndex(x => x > th); const m = (TH[k - 1] + TH[k]) / 2; return g.P(m, (g.R(m) * 0.96 + g.R(m - TAU) * 1.04) / 2 + g.R(m) * 0.12); })(),
      siph: (() => { const th = Math.PI / 2 - psi0 - TAU - 0.5; const k = TH.findIndex(x => x > th); const m = (TH[k - 1] + TH[k]) / 2; return g.P(m, sip(m)); })() } };
}
