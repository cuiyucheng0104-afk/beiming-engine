// four-finger cartoon glove (one union outline, thin finger separations), line width in screen px via lw
import { ellipse, xform, path, move, reg, TAU } from './toon.js';
export function drawHand(ctx, x, y, a, kind = 'open', side = 1, k = 1, o = {}) {
  const { lw = 1, fill = '#FAF3E3', ink = '#2B2420' } = o;
  const parts = [], seps = [];
  const E = (cx, cy, rx, ry, rot = 0) => parts.push(ellipse(cx, cy, rx, ry, 18, 0, TAU, rot));
  E(12, 0, 15, 13.5);
  if (kind === 'open') {
    [-0.62, 0, 0.62].forEach(r => E(12 + Math.cos(r) * 25, Math.sin(r) * 25, 12, 5, r));
    E(4, -15 * side, 10, 5, -1.35 * side);
  } else if (kind === 'point') {
    E(38, -5 * side, 19, 4.8); E(25, 5 * side, 7, 6); E(20, 11 * side, 6, 5.5); E(8, -14 * side, 8.5, 5, -1.0 * side);
  } else {
    E(26, -8, 6.5, 6.5); E(28, 1, 6.5, 6.5); E(25, 10, 6, 6); E(12, -14 * side, 9, 5.5, -0.4 * side);
    seps.push([[22, -3.5], [30, -3.5]], [[22, 5.5], [29, 5.5]]);
  }
  // cuff
  parts.push(xform(ellipse(0, 0, 7, 15, 14), -4, 0, 0, 1));
  const P = parts.map(p => xform(p, x, y, a, k));
  ctx.save(); ctx.strokeStyle = ink; ctx.lineWidth = 6 * lw; ctx.lineJoin = 'round';
  for (const p of P) { path(ctx, p); ctx.stroke(); }
  const of = reg(77, 0.6); ctx.fillStyle = fill;
  for (const p of P) { path(ctx, move(p, of[0] * 0.5, of[1] * 0.5)); ctx.fill(); }
  ctx.lineWidth = 2.4 * lw; ctx.lineCap = 'round';
  for (const s2 of seps) { const q = xform(s2, x, y, a, k); ctx.beginPath(); ctx.moveTo(...q[0]); ctx.lineTo(...q[1]); ctx.stroke(); }
  ctx.restore();
}
