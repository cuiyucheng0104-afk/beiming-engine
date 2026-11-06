// Nature pieces for 一伞三景: pine, rock, rain, wave claws, willow, plovers
import { clamp, lerp, mulberry, hash, vnoise, TAU } from '/core/lib.js';
import { PAL, smooth, poly, carve, wob, rgba } from './print.js';

// —— Pine: bent trunk + flat-topped needle pads (fan of needles on the upper edge, flat underside) ——
function pinePad(x, cx, cy, r, o, R, lw) {
  const n = Math.max(3, Math.round(r / 16)), top = [], wdt = r * 1.35, ht = r * .42;
  for (let i = 0; i <= n; i++) { const u = i / n, X = cx - wdt + u * 2 * wdt; top.push([X, cy - ht * Math.pow(Math.sin(u * Math.PI), .7) * (.8 + R() * .3)]); }
  const bot = [[cx + wdt, cy + ht * .12], [cx + wdt * .3, cy + ht * .22], [cx - wdt * .4, cy + ht * .18], [cx - wdt, cy + ht * .1]];
  if (o.fills !== false) {
    x.fillStyle = o.needle || PAL.pine; x.beginPath(); x.moveTo(top[0][0], top[0][1]);
    for (let i = 1; i <= n; i++) { const p0 = top[i - 1], p1 = top[i]; x.quadraticCurveTo((p0[0] + p1[0]) / 2, Math.min(p0[1], p1[1]) - r * .16, p1[0], p1[1]); }
    bot.forEach(q => x.lineTo(q[0], q[1])); x.closePath(); x.fill();
  }
  if (o.lines !== false) {
    x.strokeStyle = PAL.sumi; x.lineCap = 'round';
    for (let i = 1; i <= n; i++) {
      const p0 = top[i - 1], p1 = top[i], mx = (p0[0] + p1[0]) / 2, my = Math.min(p0[1], p1[1]) - r * .16, base = [mx, my + r * .34];
      x.lineWidth = lw * .5;
      for (let k = 0; k <= 8; k++) { const u = k / 8, ex = lerp(p0[0], p1[0], u), ey = lerp(p0[1], p1[1], u) - Math.sin(u * Math.PI) * r * .16; x.beginPath(); x.moveTo(base[0], base[1]); x.lineTo(lerp(base[0], ex, .92), lerp(base[1], ey, .92)); x.stroke(); }
    }
    x.lineWidth = lw * .9; x.beginPath(); x.moveTo(bot[3][0], bot[3][1]); bot.slice().reverse().forEach(q => x.lineTo(q[0], q[1])); x.stroke();
  }
}
export function pine(x, bx, by, sc, o = {}) {
  const R = mulberry(o.seed || 7), lean = o.lean ?? -.3, lw = o.lw || 2.4, seed = o.seed || 0;
  const trunk = [];
  for (let i = 0; i <= 7; i++) { const s = i / 7; trunk.push([bx + Math.sin(s * 3.1 + seed) * 26 * sc + lean * s * 170 * sc, by - s * 270 * sc]); }
  const th = i => (15 - i * 1.5) * sc;
  const tl = trunk.map(([a, b], i) => [a - th(i), b]), tr = trunk.map(([a, b], i) => [a + th(i), b]);
  if (o.fills !== false) { x.fillStyle = o.bark || PAL.woodD; x.beginPath(); poly(x, tl.concat(tr.slice().reverse())); x.fill(); }
  const pads = [];
  trunk.forEach(([a, b], i) => {
    if (i < (o.minI || 2)) return; const side = (i + seed) % 2 ? 1 : -1, len = (60 + R() * 70) * sc, ex = a + side * len, ey = b - (10 + R() * 25) * sc;
    if (o.fills !== false) { x.strokeStyle = o.bark || PAL.woodD; x.lineWidth = 7 * sc; x.lineCap = 'round'; x.beginPath(); x.moveTo(a, b); x.quadraticCurveTo(a + side * len * .5, b + 8 * sc, ex, ey); x.stroke(); }
    if (o.lines !== false) { x.strokeStyle = PAL.sumi; x.lineWidth = lw * .7; x.beginPath(); x.moveTo(a, b - 3 * sc); x.quadraticCurveTo(a + side * len * .5, b + 5 * sc, ex, ey - 3 * sc); x.stroke(); }
    pads.push([ex, ey, (34 + R() * 18) * sc]);
  });
  pads.push([trunk[7][0], trunk[7][1] - 6 * sc, 48 * sc]);
  pads.sort((p, q) => p[1] - q[1]).forEach(([cx, cy, r]) => pinePad(x, cx, cy, r, o, R, lw));
  if (o.lines !== false) {
    x.fillStyle = PAL.sumi;
    carve(x, tl, lw * 1.2, { taper: [0, .3], seed: 8 }); carve(x, tr, lw * 1.2, { taper: [0, .3], seed: 9 });
    x.strokeStyle = PAL.sumi; x.lineWidth = lw * .45;
    for (let i = 0; i < 7; i++) for (let k = 0; k < 3; k++) { const a = trunk[i], b = trunk[i + 1], u = (k + .5) / 3, px = lerp(a[0], b[0], u) + (R() - .5) * th(i), py = lerp(a[1], b[1], u); x.beginPath(); x.arc(px, py, 4 * sc, Math.PI * .1, Math.PI * .9); x.stroke(); }
  }
}

// —— Rock: faceted planes + texture strokes ——
export function rock(x, pts, o = {}) {
  const lw = o.lw || 2.6;
  if (o.fill) { x.fillStyle = o.fill; x.beginPath(); poly(x, pts); x.fill(); }
  if (o.face) { x.save(); x.beginPath(); poly(x, pts); x.clip(); x.fillStyle = o.face; o.facets.forEach(f => { x.beginPath(); poly(x, f); x.fill(); }); x.restore(); }
  if (o.lines) {
    x.fillStyle = PAL.sumi; carve(x, wob(pts, 2, o.seed || 1), lw * 1.2, { closed: true, jit: .35, seed: o.seed || 1 });
    if (o.facets) o.facets.forEach((f, i) => carve(x, f.slice(0, 3), lw * .8, { taper: [.2, .6], seed: i + 3 }));
  }
}

// —— Rain: two sets of straight lines at slightly different angles, re-drawn at 12 fps (frozen when `frame` is fixed) ——
export function rain(x, frame, rect, o = {}) {
  const R = mulberry(1000 + frame), [x0, y0, x1, y1] = rect, dens = o.dens ?? 1, tilt = o.tilt || 0;
  const sets = o.sets || [[-1.36, 230, 2.0, PAL.sumi, .5], [-1.24, 120, 1.4, PAL.greyD, .45], [-1.3, 90, 1.6, '#c9c4b2', .42]];
  x.save(); x.lineCap = 'butt';
  for (const [ang0, n0, lw, col, a] of sets) {
    const ang = ang0 + tilt, n = Math.round(n0 * dens);
    x.strokeStyle = rgba(col, a); x.lineWidth = lw; x.beginPath();
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const L = 60 + R() * 170, px = x0 - 200 + R() * (x1 - x0 + 400), py = y0 + R() * (y1 - y0 + L);
      x.moveTo(px, py); x.lineTo(px - dx * L, py - dy * L);
    }
    x.stroke();
  }
  x.restore();
}

// —— Wave claws: a big claw splits into fingers that split again, every tip hooking inward ——
export function fclaw(x, bx, by, ang, len, wid, curl, depth, st, R) {
  const n = 12, split = depth > 0 ? .55 + R() * .15 : 1, sp = [[bx, by]]; let a = ang, px = bx, py = by;
  const cv = depth === 2 ? curl * .3 : depth === 1 ? curl * .75 : curl * 1.25;
  const angAt = s => ang + cv * Math.pow(s, 2.2) * 3.2;
  for (let i = 1; i <= n; i++) { const s = i / n * split; a = angAt(s); px += Math.cos(a) * len * split / n; py += Math.sin(a) * len * split / n; sp.push([px, py]); }
  const Lp = [], Rp = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n * split, q = sp[i], q2 = sp[Math.min(n, i + 1)], q1 = sp[Math.max(0, i - 1)];
    let dx = q2[0] - q1[0], dy = q2[1] - q1[1]; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    const w = wid * .5 * (depth === 2 ? (s < .16 ? .4 + s / .16 * .6 : 1 - (s - .16) * .6) : depth > 0 ? (1 - s * .55) : (s < .2 ? .8 + s : Math.pow((1 - s) / .8, .9)));
    Lp.push([q[0] - dy * w, q[1] + dx * w]); Rp.push([q[0] + dy * w, q[1] - dx * w]);
  }
  const ol = Lp.concat(Rp.reverse());
  x.fillStyle = st.fill; x.beginPath(); poly(x, ol); x.fill();
  x.strokeStyle = st.ink; x.lineWidth = st.lw * (depth > 0 ? 1 : .85); x.lineJoin = 'round'; x.beginPath(); poly(x, ol); x.stroke();
  if (depth > 0) {
    const kids = depth === 2 ? 3 : 2 + (R() < .5 ? 1 : 0), aS = angAt(split);
    for (let k = 0; k < kids; k++) {
      const off = (k - (kids - 1) / 2) * .5 + .2 + (R() - .5) * .15;
      fclaw(x, px, py, aS + off, len * (.62 + R() * .14), wid * .66, curl * (1.1 + R() * .3), depth - 1, st, R);
    }
    x.fillStyle = st.fill; x.beginPath(); x.arc(px, py, wid * .5 * .48, 0, TAU); x.fill();
  }
}
// spray: clusters of one big dot, a few medium, many small (left as paper, blue key line)
export function spray(x, cx, cy, sc, R, ink = PAL.prusD) {
  const dots = [[0, 0, 7 + R() * 4]]; for (let i = 0; i < 4; i++) dots.push([(R() - .5) * 40, (R() - .5) * 34, 3.5 + R() * 2.5]); for (let i = 0; i < 8; i++) dots.push([(R() - .5) * 70, (R() - .5) * 60, 1.4 + R() * 1.6]);
  for (const [dx, dy, r] of dots) { x.fillStyle = PAL.white; x.beginPath(); x.arc(cx + dx * sc, cy + dy * sc, r * sc, 0, TAU); x.fill(); x.strokeStyle = ink; x.lineWidth = r > 3 ? 1.6 : 1; x.stroke(); }
}

// —— Willow strands hanging from the top edge; `wind` pushes them right, `ph` is the 8 fps sway phase ——
export function willow(x, strands, wind, ph, pass) {
  for (const s of strands) {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10, sway = (Math.sin(ph * 1.7 + s.seed * 3 + u * 2) * 10 + wind * 120 * Math.pow(u, 1.5)) * u;
      pts.push([s.x + s.bend * u * u + sway, s.y0 + u * s.len]);
    }
    if (pass === 'wood') {
      x.strokeStyle = '#6b7f45'; x.lineWidth = 2.2; x.lineCap = 'round'; x.beginPath(); smooth(x, pts); x.stroke();
      x.fillStyle = s.seed % 2 ? PAL.greenD : '#7b9a4c';
      for (let i = 2; i < 10; i++) for (const side of [-1, 1]) {
        const [px, py] = pts[i], [qx, qy] = pts[i + 1], a = Math.atan2(qy - py, qx - px) + side * .55;
        x.save(); x.translate((px + qx) / 2, (py + qy) / 2); x.rotate(a); x.beginPath(); x.ellipse(7, 0, 9, 2.4, 0, 0, TAU); x.fill(); x.restore();
      }
    }
    if (pass === 'key') { x.strokeStyle = PAL.sumi; x.lineWidth = .9; x.beginPath(); smooth(x, pts); x.stroke(); }
  }
}

// —— Plover (chidori): a small round bird, wings beating at 8 fps ——
export function plover(x, px, py, s, flap) {
  x.save(); x.translate(px, py); x.scale(s, s);
  const up = Math.sin(flap * TAU);
  x.fillStyle = PAL.white; x.strokeStyle = PAL.sumi; x.lineWidth = 1.6; x.lineJoin = 'round';
  x.beginPath(); x.moveTo(-14, 0); x.quadraticCurveTo(-4, -10 - up * 12, 8, -16 - up * 18); x.quadraticCurveTo(2, -2, -2, 2); x.closePath(); x.fill(); x.stroke();
  x.beginPath(); x.ellipse(0, 2, 9, 5.5, -.15, 0, TAU); x.fill(); x.stroke();
  x.beginPath(); x.moveTo(-14, 0); x.quadraticCurveTo(-6, 10 + up * 8, 6, 14 + up * 14); x.quadraticCurveTo(0, 6, -2, 4); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = PAL.sumi; x.beginPath(); x.arc(-7, 0, 1.4, 0, TAU); x.fill();
  x.beginPath(); x.moveTo(-9, 1.5); x.lineTo(-14, 2.5); x.stroke();
  x.restore();
}
