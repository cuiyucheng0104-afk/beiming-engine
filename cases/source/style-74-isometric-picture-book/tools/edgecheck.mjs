// Edge check: which props sit half-cut at the frame edge, and for how long (STYLE §9).
//   node tools/edgecheck.mjs [t0] [t1]     — prints runs of frames where an object is partly in frame
import { camAt, TREE1 } from '../film.js';
import { T } from '../timeline.js';
const W = 1920, H = 1080, C30 = Math.cos(Math.PI / 6), S30 = .5, FPS = 30;
const P = (c, x, y, z) => [W / 2 + ((x - c.x) - (y - c.y)) * C30 * c.k, H / 2 + (((x - c.x) + (y - c.y)) * S30 - (z - c.z)) * c.k];
const bakerY = t => t < T.walk1[0] ? 7.2 : t < T.walk2[0] ? 4.8 : t < T.walk2[1] ? null : 2.2;
const OBJ = {
  baker: t => { const y = bakerY(t); return y == null ? null : [2.1, 2.7, y - .3, y + .3, 0, 1.95]; },
  oven: () => [.4, 1.9, 4.35, 5.25, 0, 3.1],
  shelf: () => [.3, .9, 1.3, 3.0, 0, 1.5],
  table: () => [.6, 1.9, 6.5, 7.9, 0, 1.0],
  longTable: () => [7.3, 8.1, 3.4, 7.9, 0, .74],
  chairs: () => [8.5, 9.2, 3.5, 7.85, 0, .9],
  guest: t => { const f = Math.min(1, Math.max(0, (t - T.walk3[0]) / (T.walk3[1] - T.walk3[0]))), x = 12.827 + (10.2 - 12.827) * f; return [x - .27, x + .27, 2.15, 2.65, 0, 1.9]; },
  tree1: () => ({ sphere: [TREE1[0], TREE1[1], 2.3, .95], trunk: [TREE1[0], TREE1[1], 0] }),
  lamp: () => [13.1, 14.35, -4.25, -3.75, 0, 3.95],
};
const a = +(process.argv[2] ?? 0), b = +(process.argv[3] ?? 19.8);
const runs = {};
for (let f = Math.round(a * FPS); f <= Math.round(b * FPS); f++) {
  const t = f / FPS, c = camAt(t);
  for (const [name, fn] of Object.entries(OBJ)) {
    const bx = fn(t); if (!bx) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    if (bx.sphere) { const [cx, cy, cz, r] = bx.sphere, [sx, sy] = P(c, cx, cy, cz), [tx, ty] = P(c, ...bx.trunk); x0 = sx - r * c.k; x1 = sx + r * c.k; y0 = sy - r * c.k; y1 = Math.max(ty, sy + r * c.k); }
    else for (const x of bx.slice(0, 2)) for (const y of bx.slice(2, 4)) for (const z of bx.slice(4, 6)) { const [sx, sy] = P(c, x, y, z); x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
    const ix = Math.max(0, Math.min(W, x1) - Math.max(0, x0)), iy = Math.max(0, Math.min(H, y1) - Math.max(0, y0));
    const fr = ix * iy / ((x1 - x0) * (y1 - y0));
    const cut = fr > .02 && fr < .98;
    const r = runs[name] ??= [];
    if (cut) { const l = r[r.length - 1]; if (l && l.f1 === f - 1) { l.f1 = f; l.min = Math.min(l.min, fr); } else r.push({ f0: f, f1: f, min: fr }); }
  }
}
for (const [n, r] of Object.entries(runs)) for (const x of r) console.log(`${n.padEnd(9)} ${(x.f0 / FPS).toFixed(2)}–${(x.f1 / FPS).toFixed(2)} s  ${x.f1 - x.f0 + 1} frames  (min ${Math.round(x.min * 100)}% in)`);
