// 博物志·鹦鹉螺 — picture. render(t) is a pure function of t; every time comes from timeline.js.
import * as B from './engine/burin.js';
import { drawSheet, drawPaper, borderInk, roundelFrame, PAL } from './engine/plate.js';
import { Wash } from './engine/wash.js';
import { buildShell, buildSection } from './nautilus.js';
import { T, C, DUR, LABELS, FPS } from './timeline.js';
const { clamp } = B;
const W = 1920, H = 1080;
const lerp = (a, b, t) => a + (b - a) * t, seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const Tb = ([a, b]) => [T(a), T(b)];
const FONT = { zh: '"Noto Serif SC"', la: '"Bodoni Moda"' };

export function makeFilm({ ss: SSF = 1 } = {}) {   // SSF: supersampling factor of the canvas render() draws into
  const PLATE = [70, 44, 1850, 1036], BORDER = [100, 72, 1820, 1008];
  const S = buildShell({ cx: 700, cy: 520, r1: 505, psi0: 0.32 });
  const ink = S.ink;
  // ---- cut windows: the outline runs one by one, then the passes sweeping from the light toward the shadow
  const win = (g, [a, b]) => { for (const s of ink.S) if (s.g === g) { s.s0 = T(a); s.s1 = T(b); } };
  win('runA', C.runA); win('runB', C.runB); win('runC', C.runC); win('runD', C.runD); win('runE', C.runE);
  const sweep = s => { const cx = (s.bb[0] + s.bb[2]) / 2, cy = (s.bb[1] + s.bb[3]) / 2; return cx * 0.74 + cy * 0.67; };
  ink.schedule('h1', ...Tb(C.h1), { conc: 46, key: sweep });
  ink.schedule('h2', ...Tb([C.h2[0], C.h2[1] - 0.5]), { conc: 40, key: sweep });
  ink.schedule('h3', ...Tb(C.h3), { conc: 30, key: sweep });
  ink.build();
  const frame = new B.Ink(); borderInk(frame, BORDER); frame.instant('main', -10); frame.build();
  // the engraver's construction drawn on the plate before cutting: rays from the pole and the growth spiral (sepia, not ink)
  const guide = new Path2D(); { const g = S.g;
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; let th = a - g.psi0; while (th > 0) th -= Math.PI * 2; const L = g.R(th) * 1.06; guide.moveTo(g.px + Math.cos(a) * g.r1 * 0.02, g.py + Math.sin(a) * g.r1 * 0.02); guide.lineTo(g.px + Math.cos(a) * L, g.py + Math.sin(a) * L); }
    for (let i = 0; i <= 900; i++) { const th = -4 * Math.PI + 4 * Math.PI * i / 900, p = g.S(th); i ? guide.lineTo(...p) : guide.moveTo(...p); } }

  // ---- the section in the roundel (local units, radius 500)
  const X = buildSection({ septa: C.septa.length });
  const xi = X.ink;
  for (const s of xi.S) if (s.g === 'ground') {}
  xi.schedule('ground', ...Tb(C.ground), { conc: 14, key: s => s.bb[1] });
  xi.schedule('wall', ...Tb(C.wall), { conc: 2 });
  const SEP = C.septa.map(T);
  // chamber 0 (the apex whorls) is cut with the wall; chamber k with septum k-1; the living chamber with the wall too
  xi.schedule('c0', T(C.wall[0] + 0.25), T(C.wall[1]), { conc: 30 });
  xi.schedule('c' + X.septa, T(C.wall[0] + 0.25), T(C.wall[1]), { conc: 40 });
  SEP.forEach((t, k) => {
    const nxt = k + 1 < SEP.length ? SEP[k + 1] : t + T(0.25), d = Math.max(T(0.12), Math.min(T(0.5), nxt - t));
    xi.schedule('s' + k, t, t + d * 0.9, { conc: 3 });
    if (k + 1 < X.septa) xi.schedule('c' + (k + 1), t + d * 0.2, Math.min(t + Math.max(d, T(0.35)), T(C.stop)), { conc: 40 });
  });
  xi.build();

  // ---- hand colouring: madder on the siphuncle, raw sienna in the chambers, burnt sienna flames on the shell
  const secWash = new Wash({ scale: 1.0 });
  X.chambers.forEach((ch, k) => {
    const o = ch.polys[0][Math.floor(ch.polys[0].length / 3)];
    secWash.add({ path: ch.path, polys: ch.polys, color: k === X.septa ? '#c9a873' : (k % 2 ? '#cfa066' : '#c99a5e'), alpha: k === X.septa ? 0.42 : 0.5, origin: o, t0: T(C.chambers.t0 + k * C.chambers.step), dur: T(1.0), spill: 2.6, seed: 5 + k, lift: 0.5, pool: 0.55 });
  });
  const wash = new Wash({ scale: 1.3 });
  wash.add({ ...S.regions.shell, color: '#e2c595', alpha: 0.42, origin: [S.pole[0] - 120, S.pole[1] - 160], t0: T(C.shellWash), dur: T(2.0), spill: 3, seed: 2, lift: 0.55, backruns: 1 });
  S.regions.stripes.forEach((st, k) => {
    const pts = st.polys[0], o = pts[Math.floor(pts.length * 0.12)];
    wash.add({ ...st, color: '#9a4b25', alpha: 0.72, origin: o, t0: T(C.stripes.t0 + k * C.stripes.step), dur: T(0.75), spill: 2.6, seed: 11 + k, lift: 0.45, pool: 0.6 });
  });

  // ---- roundel
  const F = S.focus, SLOT = { x: 1480, y: 470 }, RR = 235;
  const roundelAt = t => {
    if (t < T(C.ring[0])) return null;
    const u = eio(seg(t, ...Tb(C.flight)));
    return { x: lerp(F.x, SLOT.x, u), y: lerp(F.y, SLOT.y, u) - Math.sin(u * Math.PI) * 42, r: Math.exp(lerp(Math.log(F.r), Math.log(RR), u)),
      ring: seg(t, ...Tb(C.ring)), burn: seg(t, ...Tb(C.burnish)), travel: u };
  };
  const loc2w = (r, [x, y]) => [r.x + x * r.r / 500, r.y + y * r.r / 500];

  // ---- camera: a loupe over the sheet. One world→screen function for everything.
  const tipOf = (g, t) => { const s = ink.S.filter(x => x.g === g).sort((a, b) => b.len - a.len)[0];
    const f = (s.n - 1) * clamp((t - s.s0) / (s.s1 - s.s0)), j = Math.min(s.n - 2, Math.floor(f)), u = f - j, xy = s.xy;
    return [xy[2 * j] + (xy[2 * j + 2] - xy[2 * j]) * u, xy[2 * j + 1] + (xy[2 * j + 3] - xy[2 * j + 1]) * u]; };
  const RUNS = ['runA', 'runB', 'runC'].map(g => [g, ...Tb(C[g])]);
  const rawTarget = t => {
    for (let i = 0; i < RUNS.length; i++) {
      const [g, a, b] = RUNS[i], nx = RUNS[i + 1];
      if (t <= b || !nx) return tipOf(g, Math.min(t, b));
      if (t < nx[1]) { const p0 = tipOf(g, b), p1 = tipOf(nx[0], nx[1]), u = ss(seg(t, b, nx[1])); return [lerp(p0[0], p1[0], u), lerp(p0[1], p1[1], u)]; }
    }
  };
  const follow = t => { let x = 0, y = 0; const N = 12; for (let i = 0; i < N; i++) { const p = rawTarget(t - 0.28 * i / (N - 1)); x += p[0]; y += p[1]; }
    return { cx: x / N, cy: y / N, z: 5.2 - 0.6 * ss(seg(t, 0, T(3))), rot: -0.035 + 0.012 * ss(seg(t, 0, T(3))) }; };
  const PL = { cx: 712, cy: 532, z: 1.12, rot: 0 }, ROUND = { cx: 1292, cy: 515, z: 1.7, rot: 0 }, FIN = { cx: 960, cy: 540, z: 1.0, rot: 0 };
  const keys = [[T(6), PL], [T(12), { ...PL, z: 1.14 }], [T(13), { cx: 730, cy: 528, z: 1.165, rot: 0 }],
    [T(15), ROUND, x => x], [T(19.5), { ...ROUND, z: 1.76 }, x => x], [T(21), { ...ROUND, z: 1.76 }], [T(23), { ...ROUND, z: 1.78 }, x => x],
    [T(24.5), FIN], [DUR + 0.5, { ...FIN, z: 1.012 }, x => x]];
  const between = (ca, cb, u, linear = false) => {
    const za = Math.log(ca.z), zb = Math.log(cb.z), z = Math.exp(lerp(za, zb, u));
    const wa = 1 / ca.z, wb = 1 / cb.z, v = Math.abs(wb - wa) > 1e-6 ? (1 / z - wa) / (wb - wa) : u, k = Math.abs(za - zb) > 0.2 ? clamp(v) : u;
    return { cx: lerp(ca.cx, cb.cx, k), cy: lerp(ca.cy, cb.cy, k), z, rot: lerp(ca.rot || 0, cb.rot || 0, u) };
  };
  const camAt = t => {
    const [p0, p1] = Tb(C.pullout);
    if (t < p0) return follow(t);
    if (t < p1) return between(follow(t), PL, eio(seg(t, p0, p1)));
    const [f0, f1] = Tb(C.flight);
    if (t >= f0 && t < f1) {   // ride with the roundel as it lifts off the shell and flies to the margin
      const u = seg(t, f0, f1), r = roundelAt(t), st = keys[2][1];
      const z = Math.exp(lerp(Math.log(st.z), Math.log(ROUND.z), eio(u))), k0 = 0.55 * ss(seg(t, f0, f0 + 0.45)), w = Math.pow(ss(u), 1.5);
      const fx = lerp(st.cx, r.x - 80, k0), fy = lerp(st.cy, r.y + 35, k0);
      return { cx: lerp(fx, ROUND.cx, w), cy: lerp(fy, ROUND.cy, w), z, rot: 0 };
    }
    let i = 0; while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
    const [ta, ca] = keys[i], nx = keys[i + 1]; if (!nx) return ca;
    const [tb, cb, e = eio] = nx; return between(ca, cb, e(seg(t, ta, tb)));
  };
  const applyCam = (ctx, c) => { ctx.setTransform(SSF, 0, 0, SSF, 0, 0); ctx.translate(W / 2, H / 2); ctx.rotate(c.rot || 0); ctx.scale(c.z, c.z); ctx.translate(-c.cx, -c.cy); };
  const toScreen = (c, x, y) => { const dx = (x - c.cx) * c.z, dy = (y - c.cy) * c.z, cs = Math.cos(c.rot || 0), sn = Math.sin(c.rot || 0); return [W / 2 + dx * cs - dy * sn, H / 2 + dx * sn + dy * cs]; };

  // ---- lettering: cut glyph by glyph (each glyph wipes in as the burin travels), never faded
  const mctx = document.createElement('canvas').getContext('2d');
  const fontOf = o => `${o.italic ? 'italic ' : ''}${o.weight || 500} ${o.size}px ${o.zh ? FONT.zh : FONT.la}`;
  const layout = (str, o) => { mctx.font = fontOf(o); const ch = [...str], ws = ch.map(c => mctx.measureText(c).width), tw = ws.reduce((a, b) => a + b, 0) + (o.track || 0) * o.size * (ch.length - 1); return { ch, ws, tw }; };
  const glyphTimes = (str, t0, step) => { const out = []; let k = 0; for (const c of str) { out.push(c === ' ' ? null : T(t0 + k * step)); if (c !== ' ') k++; } return out; };
  const TXT = [];   // {id, str, x, y, o, times}
  const addText = (id, str, x, y, o, t0, step) => TXT.push({ id, str, x, y, o, times: glyphTimes(str, t0, step) });
  const L1 = { zh: { x: 1385, y: 760 }, la: { x: 1385, y: 790 } }, L2 = { zh: { x: 1585, y: 760 }, la: { x: 1585, y: 790 } };
  addText('lab1zh', LABELS.lab1.zh, L1.zh.x, L1.zh.y, { size: 25, zh: true, weight: 600, track: 0.3 }, C.lab1.zh, C.lab1.zhStep);
  addText('lab1la', LABELS.lab1.la, L1.la.x, L1.la.y, { size: 21, italic: true, weight: 400 }, C.lab1.la, C.lab1.laStep);
  addText('lab2zh', LABELS.lab2.zh, L2.zh.x, L2.zh.y, { size: 25, zh: true, weight: 600, track: 0.3 }, C.lab2.zh, C.lab2.zhStep);
  addText('lab2la', LABELS.lab2.la, L2.la.x, L2.la.y, { size: 21, italic: true, weight: 400 }, C.lab2.la, C.lab2.laStep);
  addText('latin', LABELS.latin, 700, 968, { size: 27, italic: true, weight: 400, track: 0.02 }, C.latin.t0, C.latin.step);
  addText('title', LABELS.title, 700, 928, { size: 46, zh: true, weight: 600, track: 0.42 }, C.title.t0, C.title.step);
  addText('plate', LABELS.plate, 1788, 122, { size: 30, weight: 600, track: 0.08, align: 'right' }, C.plate.t0, C.plate.step);
  const GD = 0.08;    // seconds to cut one glyph
  const drawText = (ctx, tx, t) => {
    if (t < tx.times.find(x => x != null)) return;
    const { ch, ws, tw } = layout(tx.str, tx.o); ctx.save(); ctx.font = fontOf(tx.o); ctx.fillStyle = PAL.ink; ctx.textBaseline = 'alphabetic';
    let x = tx.o.align === 'right' ? tx.x - tw : tx.x - tw / 2;
    for (let i = 0; i < ch.length; i++) { const t0 = tx.times[i];
      if (t0 != null && t >= t0) { const f = clamp((t - t0) / GD); if (f < 1) { ctx.save(); ctx.beginPath(); ctx.rect(x - 2, tx.y - tx.o.size * 1.25, (ws[i] + 4) * f, tx.o.size * 1.7); ctx.clip(); ctx.fillText(ch[i], x, tx.y); ctx.restore(); } else ctx.fillText(ch[i], x, tx.y); }
      x += ws[i] + (tx.o.track || 0) * tx.o.size; }
    ctx.restore();
  };
  const textBox = (tx, cam) => { const { tw } = layout(tx.str, tx.o), x0 = tx.o.align === 'right' ? tx.x - tw : tx.x - tw / 2;
    const a = toScreen(cam, x0, tx.y - tx.o.size * 0.95), b = toScreen(cam, x0 + tw, tx.y + tx.o.size * 0.3); return [a[0], a[1], b[0], b[1]]; };

  // ---- leaders from a part inside the roundel to its label
  const LEAD = [{ id: 'lab1', a: X.anchors.chamber, to: [L1.zh.x, L1.zh.y - 32], t: T(C.lab1.zh) }, { id: 'lab2', a: X.anchors.siph, to: [L2.zh.x, L2.zh.y - 32], t: T(C.lab2.zh) }];

  // ---- the red along the siphuncle: a transparent madder wash (spill, tide-line, lift, granulation) in a ribbon that
  //      ends at the last septum; the brush lays it from the apex outward, so it is revealed along its length
  const redLen = []; { let L = 0; redLen.push(0); for (let i = 1; i < X.red.length; i++) { L += Math.hypot(X.red[i][0] - X.red[i - 1][0], X.red[i][1] - X.red[i - 1][1]); redLen.push(L); } }
  const redNrm = X.red.map((p, i) => { const a = X.red[Math.max(0, i - 1)], b = X.red[Math.min(X.red.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const ribbon = (n, grow = 0) => { const L = [], R = []; for (let i = 0; i <= n; i++) { const h = X.redW[i] / 2 + grow, [x, y] = X.red[i], [nx, ny] = redNrm[i]; L.push([x + nx * h, y + ny * h]); R.push([x - nx * h, y - ny * h]); } return [...L, ...R.reverse()]; };
  const polyPath = pts => { const p = new Path2D(); pts.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath(); return p; };
  const RIB = ribbon(X.red.length - 1);
  const redWash = new Wash({ scale: 1.6 });
  redWash.add({ path: polyPath(RIB), polys: [RIB], color: '#b0442f', alpha: 0.86, origin: X.red[0], spill: 1.2, offset: [1.1, 0.8], seed: 71, pool: 0.95, lift: 0.32, backruns: 0 });
  const RIT = redWash.items[0];
  const drawRed = (ctx, t) => {
    const [a, b] = Tb(C.red); if (t < a) return;
    if (!RIT.cache) redWash._paint(RIT);
    const p = eio(seg(t, a, b)) * 0.985 + 0.015 * seg(t, a, a + 0.05), Lp = p * redLen[redLen.length - 1];
    let n = 1; while (n < X.red.length - 1 && redLen[n] < Lp) n++;
    ctx.save();
    if (n < X.red.length - 1) ctx.clip(polyPath(ribbon(n, 4)));
    ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = RIT.alpha;
    ctx.drawImage(RIT.cache.c, RIT.cache.x0, RIT.cache.y0, RIT.cache.w, RIT.cache.h);
    ctx.restore();
    // the loaded brush: a wetter, darker bead at the head while it travels, drying out after the stroke ends
    if (t < b + 0.3) { const h = X.red[n], wet = 1 - seg(t, b, b + 0.3); ctx.save(); ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.3 * wet; ctx.fillStyle = '#a5503f'; ctx.beginPath(); ctx.arc(h[0], h[1], X.redW[n] * 0.62, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.35 * wet; ctx.strokeStyle = '#8e3e30'; ctx.lineWidth = Math.max(0.8, X.redW[n] * 0.08); ctx.stroke(); ctx.restore(); }
  };

  // ---- the section's construction, traced in sepia inside the burnished roundel while it flies (cut over later)
  const prefix = (ctx, pts, p) => { if (p <= 0) return; const f = (pts.length - 1) * clamp(p), j = Math.floor(f), u = f - j; ctx.beginPath(); ctx.moveTo(...pts[0]);
    for (let i = 1; i <= j; i++) ctx.lineTo(...pts[i]); if (j < pts.length - 1) ctx.lineTo(pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u); ctx.stroke(); };
  const drawSectionGuide = (ctx, t) => {
    const fadeWall = 1 - ss(seg(t, T(C.wall[0]), T(C.wall[1] + 0.5)));
    ctx.save(); ctx.strokeStyle = 'rgb(128,96,62)'; ctx.lineCap = 'round'; ctx.setLineDash([12, 8]); ctx.lineWidth = 2.6;
    if (fadeWall > 0) { ctx.globalAlpha = 0.5 * fadeWall;
      prefix(ctx, X.guide.spiral.slice().reverse(), eio(seg(t, T(C.flight[0]), T(C.flight[0] + 1.5))));
      prefix(ctx, X.guide.inner.slice().reverse(), eio(seg(t, T(C.flight[0] + 0.25), T(C.flight[0] + 1.75)))); }
    ctx.setLineDash([3, 7]); ctx.lineWidth = 2.2;
    const sipFade = 1 - ss(seg(t, T(C.septa[0]), T(C.stop)));
    if (sipFade > 0) { ctx.globalAlpha = 0.45 * sipFade; prefix(ctx, X.guide.sip, eio(seg(t, T(C.flight[0] + 0.5), T(C.land)))); }
    ctx.setLineDash([8, 6]); ctx.lineWidth = 2.2;
    X.guide.septa.forEach((sp, k) => { const t0 = T(C.flight[0] + 0.75 + k * 0.0625), cut = 1 - seg(t, SEP[k], SEP[k] + T(0.25)); if (t < t0 || cut <= 0) return;
      ctx.globalAlpha = 0.5 * cut; prefix(ctx, sp, seg(t, t0, t0 + T(0.25))); });
    ctx.restore();
  };

  // ---- render
  function render(ctx, t) {
    const cam = camAt(t); const r = roundelAt(t);
    applyCam(ctx, cam);
    drawSheet(ctx, { W, H, plate: PLATE });
    const ga = 1 - ss(seg(t, T(9), T(12)));
    if (ga > 0) { ctx.save(); ctx.strokeStyle = `rgba(128,96,62,${0.3 * ga})`; ctx.lineWidth = Math.max(0.5, 0.75 / Math.sqrt(cam.z)); ctx.setLineDash([7, 5]); ctx.stroke(guide); ctx.restore(); }
    wash.draw(ctx, t);
    const tips = ink.draw(ctx, t);
    frame.draw(ctx, t);
    if (t < T(C.runE[1])) for (const [x, y, w] of tips) { if (w < 1.0) continue; ctx.save(); ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.ellipse(x, y, w * 0.85, w * 0.75, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,248,232,0.85)'; ctx.beginPath(); ctx.arc(x - w * 0.3, y - w * 0.3, Math.max(0.35, w * 0.18), 0, 7); ctx.fill(); ctx.restore(); }
    if (r) {
      // leader from the shell to the roundel
      if (r.travel > 0) { const dx = r.x - F.x, dy = r.y - F.y, L = Math.hypot(dx, dy); if (L > r.r + 6) {
        const e = [r.x - dx / L * r.r, r.y - dy / L * r.r];
        ctx.save(); ctx.strokeStyle = PAL.ink; ctx.lineWidth = 0.95; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(F.x, F.y); ctx.lineTo(...e); ctx.stroke();
        ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(F.x, F.y, 2.1, 0, 7); ctx.fill(); ctx.restore(); } }
      ctx.save(); ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.clip();
      const bu = ss(r.burn);
      if (bu > 0) {
        ctx.globalAlpha = bu; ctx.fillStyle = PAL.paper; ctx.fillRect(r.x - r.r, r.y - r.r, r.r * 2, r.r * 2);
        ctx.globalCompositeOperation = 'multiply'; drawPaper(ctx, W, H);
        ctx.globalAlpha = 0.55 * bu; ctx.fillStyle = PAL.plateTone; ctx.fillRect(r.x - r.r, r.y - r.r, r.r * 2, r.r * 2);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        // burnishing marks: soft circular strokes while the ground is rubbed clean
        if (r.burn < 1) { ctx.globalAlpha = 0.18 * Math.sin(Math.PI * r.burn); ctx.strokeStyle = '#fffaf0'; ctx.lineWidth = 6; for (let k = 0; k < 7; k++) { ctx.beginPath(); ctx.arc(r.x + Math.cos(k * 2.1 + r.burn * 9) * r.r * 0.3, r.y + Math.sin(k * 2.1 + r.burn * 9) * r.r * 0.3, r.r * (0.25 + 0.08 * k), 0, 5); ctx.stroke(); } ctx.globalAlpha = 1; }
        ctx.translate(r.x, r.y); const k = r.r / 500; ctx.scale(k, k);
        drawSectionGuide(ctx, t);
        secWash.draw(ctx, t);
        drawRed(ctx, t);
        xi.draw(ctx, t, { wScale: Math.max(1, 0.62 / (k * cam.z)) ** 0.6 });
      }
      ctx.restore();
      roundelFrame(ctx, r.x, r.y, r.r, { p: r.ring, w: 2.1 });
      // label leaders, cut toward the label
      for (const ld of LEAD) { const p = seg(t, ld.t, ld.t + T(0.25)); if (p <= 0 || r.travel < 1) continue;
        const a = loc2w(r, ld.a), b = [lerp(a[0], ld.to[0], p), lerp(a[1], ld.to[1], p)];
        ctx.save(); ctx.strokeStyle = PAL.ink; ctx.lineWidth = 0.8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        ctx.fillStyle = PAL.ink; ctx.beginPath(); ctx.arc(a[0], a[1], 1.8, 0, 7); ctx.fill(); ctx.restore(); }
    }
    for (const tx of TXT) drawText(ctx, tx, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- events for the mixer and the checks (each carries its beat)
  const EV = [];
  const E = (b, type, o = {}) => EV.push({ t: T(b), b, type, ...o });
  E(0, 'burin', { t1: T(C.runA[1]), run: 'A', pan: -0.1 }); E(C.runA[1], 'lift');
  for (const g of ['runB', 'runC', 'runD', 'runE']) { E(C[g][0], 'burin', { t1: T(C[g][1]), run: g, pan: 0.15 }); E(C[g][1], 'lift'); }
  E(C.pullout[0], 'air', { t1: T(C.pullout[1]) });
  E(C.h1[0], 'hatch', { t1: T(C.h1[1]), pass: 1 }); E(C.h2[0], 'hatch', { t1: T(C.h2[1]), pass: 2 }); E(C.h3[0], 'hatch', { t1: T(C.h3[1]), pass: 3 });
  E(C.h3[0], 'stipple', { t1: T(C.h3[1]) }); E(C.h3[1], 'lift');
  E(C.ring[0], 'scribe', { t1: T(C.ring[1]) }); E(C.ring[0], 'ting');
  E(C.burnish[0], 'burnish', { t1: T(C.burnish[1]) });
  E(C.flight[0], 'whoosh', { t1: T(C.flight[1]) }); E(C.flight[0], 'trace', { t1: T(C.flight[0] + 1.75) }); E(C.ground[0], 'ruling', { t1: T(C.ground[1]) });
  E(C.land, 'land');
  E(C.wall[0], 'burin', { t1: T(C.wall[1]), run: 'wall', pan: 0.3 });
  C.septa.forEach((b, i) => E(b, 'septum', { i, n: C.septa.length, pan: 0.15 + 0.3 * i / C.septa.length }));
  for (const tx of TXT) tx.times.forEach((tt, i) => { if (tt != null) EV.push({ t: tt, b: tt / T(1), type: 'glyph', id: tx.id, zh: !!tx.o.zh }); });
  E(C.lab1.zh, 'leader'); E(C.lab2.zh, 'leader');
  E(C.stop, 'stop', { until: T(C.first) });
  E(C.clock, 'clock');
  E(C.first, 'drop'); E(C.red[0], 'brush', { t1: T(C.red[1]) });
  X.chambers.forEach((_, k) => E(C.chambers.t0 + k * C.chambers.step, 'dab', { soft: 1 }));
  E(C.pullback[0], 'air', { t1: T(C.pullback[1]) });
  E(C.shellWash, 'wash', { t1: T(C.shellWash + 3) });
  for (let k = 0; k < C.stripes.n; k++) E(C.stripes.t0 + k * C.stripes.step, 'dab', { soft: 0 });
  E(C.cadence, 'cadence');
  EV.sort((a, b) => a.t - b.t);

  // ---- every on-screen text at t, in screen pixels (for readcheck)
  const TEXTS = t => { const cam = camAt(t), out = []; for (const tx of TXT) { const t0 = tx.times.find(x => x != null); if (t < t0) continue; const [x0, y0, x1, y1] = textBox(tx, cam); out.push({ id: tx.id, text: tx.str, x0, y0, x1, y1 }); } return out; };
  return { DUR, EV, render, TEXTS, camAt };
}
