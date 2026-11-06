// 主舞台的扁平卡通笔法：7px 近黑描边 + 一道硬边阴影（阴影色填满→裁剪→基色左上偏移重填）
export const INK = '#1a0b2e';
export const PAL = {
  violet: '#2a0f5c', violet2: '#3d168f', magenta: '#ff2e88', magentaD: '#c4126a', gold: '#ffc928', goldD: '#e08a00',
  cyan: '#1fd1d1', cyanD: '#109a9e', ok: '#3fe08a', okD: '#1f9e57', fail: '#ff4a1c', failD: '#b52a07', cream: '#fff6e0', creamD: '#f0d9a8',
  night: '#0d0b2a', night2: '#191552',
};
// shape(ctx) 只建路径（不 beginPath 外的副作用）
export function toon(ctx, shape, fill, shade, { lw = 7, off = 9, stroke = true, ang = -2.36 } = {}) {
  ctx.save();
  ctx.beginPath(); shape(ctx); ctx.fillStyle = shade || fill; ctx.fill();
  if (shade) {
    ctx.save(); ctx.clip();
    ctx.translate(Math.cos(ang) * off, Math.sin(ang) * off);
    ctx.beginPath(); shape(ctx); ctx.fillStyle = fill; ctx.fill();
    ctx.restore();
  }
  if (stroke) { ctx.beginPath(); shape(ctx); ctx.lineWidth = lw; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); }
  ctx.restore();
}
export const rrect = (x, y, w, h, r) => c => { c.roundRect(x, y, w, h, r); };
export const circ = (x, y, r) => c => { c.arc(x, y, r, 0, Math.PI * 2); };
export const ell = (x, y, rx, ry, a = 0) => c => { c.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); };
export function heartPath(c, x, y, s) {
  c.moveTo(x, y + s * .35);
  c.bezierCurveTo(x - s * .1, y + s * .15, x - s * .55, y + s * .05, x - s * .5, y - s * .22);
  c.bezierCurveTo(x - s * .45, y - s * .5, x - s * .1, y - s * .5, x, y - s * .25);
  c.bezierCurveTo(x + s * .1, y - s * .5, x + s * .45, y - s * .5, x + s * .5, y - s * .22);
  c.bezierCurveTo(x + s * .55, y + s * .05, x + s * .1, y + s * .15, x, y + s * .35);
  c.closePath();
}
export function star(c, x, y, r0, r1, n, rot = 0) {
  for (let i = 0; i < n * 2; i++) { const a = rot + i * Math.PI / n, r = i % 2 ? r0 : r1; i ? c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  c.closePath();
}
