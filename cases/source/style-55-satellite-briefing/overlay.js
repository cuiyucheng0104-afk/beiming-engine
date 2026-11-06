// The analyst's layer: hairlines, brackets, labels, the reading, and the text registry for window.TEXTS.
// Everything on the ground goes through project() from engine.js.
import { project } from './engine.js';

export const C = {
  ink: '#F2F5F6', amber: '#FFBE55', halo: 'rgba(3,6,8,.82)',
  mapInk: '#1F3F6B', mapPale: '#D6EAFF', mapLine: '#A9D2FF',
};
let TX = null;
export function beginTexts() { TX = []; }
export function endTexts() { const r = TX; TX = null; return r; }

export function text(ctx, s, x, y, { font = '500 30px SC', col = C.ink, align = 'left', track = 0, halo = 7, alpha = 1, id = null, rep = null, seen = null, scale = 1 } = {}) {
  if (alpha <= 0.003 || !s) return 0;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, alpha);
  ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.letterSpacing = track + 'px';
  if (scale !== 1) { ctx.translate(x, y); ctx.scale(scale, scale); ctx.translate(-x, -y); }
  const m = ctx.measureText(s), w = m.width;
  if (halo) { ctx.shadowColor = C.halo; ctx.shadowBlur = halo; }
  ctx.fillStyle = col; ctx.fillText(s, x, y);
  if (halo) { ctx.shadowBlur = halo * 0.35; ctx.fillText(s, x, y); }
  ctx.restore();
  if (id && TX && (seen ?? alpha) > 0.5) {
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const asc = m.actualBoundingBoxAscent || 20, des = m.actualBoundingBoxDescent || 6;
    TX.push({ id, text: rep ?? s, x0, y0: y - asc, x1: x0 + w, y1: y + des });
  }
  return w;
}
export function hair(ctx, path, { w = 1.4, col = C.ink, alpha = 1, halo = 3.2, haloCol = 'rgba(3,6,8,.5)', dash = null, off = 0, cap = 'butt' } = {}) {
  if (alpha <= 0.003) return;
  ctx.save(); ctx.globalAlpha *= Math.min(1, alpha); ctx.lineJoin = 'round'; ctx.lineCap = cap;
  if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = off; }
  if (halo) { ctx.beginPath(); path(); ctx.strokeStyle = haloCol; ctx.lineWidth = w + halo; ctx.stroke(); }
  ctx.beginPath(); path(); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
  ctx.restore();
}
// lon/lat polyline -> screen path; keep(lon, lat) hides parts (printing behind a scan)
export function pathLL(ctx, cam, line, { keep = null, close = false, first = true } = {}) {
  let pen = !first;
  for (const [lo, la] of line) {
    if (keep && !keep(lo, la)) { pen = false; continue; }
    const [x, y, vis] = project(cam, la, lo);
    if (!vis) { pen = false; continue; }
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  if (close) ctx.closePath();
}
export function brackets(ctx, x0, y0, x1, y1, { len = 30, w = 1.8, alpha = 1, col = C.ink, join = 0 } = {}) {
  hair(ctx, () => {
    const L = Math.min(len + join * Math.max(x1 - x0, y1 - y0), (x1 - x0) / 2, (y1 - y0) / 2);
    const Lx = Math.min(len + join * (x1 - x0) / 2, (x1 - x0) / 2), Ly = Math.min(len + join * (y1 - y0) / 2, (y1 - y0) / 2);
    ctx.moveTo(x0, y0 + Ly); ctx.lineTo(x0, y0); ctx.lineTo(x0 + Lx, y0);
    ctx.moveTo(x1 - Lx, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + Ly);
    ctx.moveTo(x1, y1 - Ly); ctx.lineTo(x1, y1); ctx.lineTo(x1 - Lx, y1);
    ctx.moveTo(x0 + Lx, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - Ly);
    void L;
  }, { w, alpha, col, halo: 2.6 });
}
export function cross(ctx, x, y, r, { alpha = 1, w = 1.4, gap = 0 } = {}) {
  hair(ctx, () => {
    ctx.moveTo(x - r, y); ctx.lineTo(x - gap, y); ctx.moveTo(x + gap, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y - gap); ctx.moveTo(x, y + gap); ctx.lineTo(x, y + r);
  }, { w, alpha });
}
// the one reading: label line, the amber value, unit, rule, source note; left aligned at (x, y)
export function readout(ctx, x, y, { label, value, unit, note, alpha = 1, dim = 1, pop = 1, rep = null, id = 'reading', size = 124 } = {}) {
  if (alpha <= 0.003) return;
  text(ctx, label, x + 3, y - size * 0.88, { font: '500 32px SC', track: 2, alpha: alpha * 0.95, id: id + '-label' });
  const w = text(ctx, value, x, y, { font: `300 ${size}px BC`, col: C.amber, track: -1, alpha: alpha * dim, halo: 14, id: id + '-value', rep, seen: alpha, scale: pop });
  text(ctx, unit, x + w * pop + 14, y, { font: `500 40px SC`, col: C.amber, alpha: alpha * dim, halo: 8, id: id + '-unit' });
  hair(ctx, () => { ctx.moveTo(x + 3, y + 24); ctx.lineTo(x + 3 + Math.max(300, w + 110), y + 24); }, { w: 1, alpha: alpha * 0.6, halo: 0 });
  text(ctx, note, x + 3, y + 62, { font: '400 24px SC', col: 'rgba(242,245,246,.86)', alpha, track: 0.5, id: id + '-note' });
}
