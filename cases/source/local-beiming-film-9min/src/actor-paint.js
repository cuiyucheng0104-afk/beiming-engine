// Shared local-space brushes. No paper pass, random state, or destination clearing.
import { GIRL_PAL } from './girl.js';
import { createNoise2D } from '../engine/core/noise.js';
import { mulberry } from '../engine/core/math.js';
import { createInk } from '../engine/paint/ink.js';
import { parsePath, toPath2D, samplePath } from '../engine/paint/path.js';

export const C = GIRL_PAL;
// Exact existing toon.js / ferry.js colors, not a replacement or mutation of PAL.
export const MATERIAL = Object.freeze({ shell: '#E9DCC9', shellShade: '#9A8FA8',
  lavender: '#9C8FD8', pink: '#F2A0A6', window: '#FFC46B',
  red: '#FF3B3B', green: '#3BFF8A', hull: '#C8463C' });
export const clamp01 = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
export const ease = (x, a = 0, b = 1) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
export const frameTime = t => Math.floor(Math.max(0, Number.isFinite(t) ? t : 0) * 12 + 1e-6) / 12;
const brush = createInk(createNoise2D(mulberry(52511)));
const commands = p => typeof p === 'string' ? parsePath(p) : p;

export function stage(ctx, W, H, x, y, paint) {
  ctx.save();
  try { ctx.translate(W * x, H * y); ctx.scale(H / 1040, H / 1040); paint(); }
  finally { ctx.restore(); }
}

export function ink(g, p, t, { color = C.ink, size = 2.2, seed = 3, alpha = 1, ...rest } = {}) {
  g.save();
  try { brush.path(g, commands(p), { px: v => v, step: Math.floor(t * 12 + 1e-6),
    size, seed, color, alpha: alpha * g.globalAlpha, jit: 0.7, t0: 2, t1: 3, ...rest }); }
  finally { g.restore(); }
}

export function shape(g, p, color, t, { outline = true, ...style } = {}) {
  const cmds = commands(p);
  g.fillStyle = color; g.fill(toPath2D(cmds));
  if (outline) ink(g, cmds, t, style);
}

export function line(g, p, color, width = 2, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = width;
  g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(toPath2D(commands(p))); g.restore();
}

export function ellipse(g, x, y, rx, ry, color, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.fillStyle = color; g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.restore();
}

export function screw(g, x, y, t, r = 6) {
  ellipse(g, x, y, r, r * 0.8, C.hairLift);
  ink(g, `M ${x - r * 0.5} ${y + r * 0.25} L ${x + r * 0.5} ${y - r * 0.25}`, t,
    { size: 1.5, t0: 0, t1: 0 });
}

// A closed anatomical grip, with thumb pad, curled phalanges and wrist/cuff.
// Anchor is the object contact point. Palm/wrist extend down, not a stick limb.
export function grip(g, t, x, y, scale = 1, angle = 0, flip = false, sleeveEnd = 310) {
  g.save(); g.translate(x, y); g.rotate(angle); g.scale(flip ? -scale : scale, scale);
  shape(g, `M -59 126 C -17 117 20 123 42 138 L 62 ${sleeveEnd} L -99 ${sleeveEnd} Z`, C.cloth, t);
  shape(g, `M -49 145 C -51 116 -70 89 -73 56 C -77 29 -62 8 -47 6
    C -38 -13 -21 -18 -9 -8 C 5 -20 23 -14 28 1 C 43 -8 58 0 60 16
    C 65 30 61 43 52 50 C 57 63 51 76 38 78 C 30 81 21 77 16 70
    L -4 46 C -13 42 -23 45 -26 53 C -29 63 -18 76 -7 82
    C 8 73 13 54 17 43 C 23 31 36 33 42 42 C 49 53 39 80 31 95
    C 23 112 23 132 27 149 C 1 155 -25 151 -49 145 Z`, C.hand, t, { seed: 231 });
  shape(g, 'M -49 145 C -54 116 -66 87 -67 59 C -57 75 -47 86 -36 92 L -24 148 Z', C.skinDeep, t, { outline: false });
  for (const p of ['M -47 6 C -43 19 -36 28 -23 32', 'M -9 -8 C -9 10 2 23 16 32',
    'M 28 1 C 26 16 34 27 48 33', 'M -7 82 C -23 92 -27 109 -21 123',
    'M 18 45 C 24 42 30 44 32 49 L 28 58 C 23 58 18 55 18 45']) ink(g, p, t, { size: 1.4, alpha: 0.7, seed: 251 });
  ink(g, 'M -55 143 C -27 151 4 157 31 149', t, { size: 3, color: C.clothLift, seed: 260 });
  ink(g, 'M 57 10 C 64 22 59 39 50 44', t, { size: 2.8, color: C.rim, alpha: 0.85 });
  g.restore();
}

// Braided fibre follows the actual cord tangent, including moving loose ends.
export function cord(g, p, t, width = 17, reveal = 1) {
  const points = samplePath(commands(p), 4)[0];
  const count = Math.max(2, Math.ceil(points.length * clamp01(reveal)));
  const pts = points.slice(0, count);
  if (reveal <= 0) return points[0];
  const cmds = [['M', ...pts[0]], ...pts.slice(1).map(v => ['L', ...v])];
  line(g, cmds, C.ink, width + 4);
  line(g, cmds, MATERIAL.shellShade, width);
  line(g, cmds, MATERIAL.shell, width * 0.55, 0.85);
  for (let i = 2; i < pts.length - 2; i += 4) {
    const a = pts[i - 1], b = pts[i + 1], q = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, w = width * 0.42;
    line(g, [['M', q[0] - ty * w - tx * 3, q[1] + tx * w - ty * 3],
      ['Q', q[0] + tx * 1.5, q[1] + ty * 1.5, q[0] + ty * w + tx * 3, q[1] - tx * w + ty * 3]], C.ink, 1.2, 0.56);
  }
  return pts[pts.length - 1];
}
