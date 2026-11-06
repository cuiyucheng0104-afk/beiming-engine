// 制图引擎：图纸坐标 → 相机 → 屏幕；一切几何都是折线，便于"按长度描出"。
// ink 画布：白 = 曝光线条，黑 = 纸（黑色填充 = 消隐）。fx 画布：R 投影 / B 印章（lighter 叠加）。
export const W = 1920, H = 1080, TAU = Math.PI * 2;
export const inkC = document.createElement('canvas'); inkC.width = W; inkC.height = H;
export const fxC = document.createElement('canvas'); fxC.width = W; fxC.height = H;
export const g = inkC.getContext('2d'), f = fxC.getContext('2d');
export const cam = { x: 1000, y: 1000, z: 1 };
export const LW = { out: 3.2, det: 2.0, thin: 1.25, hair: .9 };
let zp = 1;
export function setCam(c) { Object.assign(cam, c); zp = Math.pow(cam.z, .65); }
export const lw = w => w * zp;
export const REG = [];            // 本帧可读文字（readcheck）
export function clear() {
  for (const c of [g, f]) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.filter = 'none'; c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
  REG.length = 0; NIBS.length = 0;
}
export function S(x, y) { return [(x - cam.x) * cam.z + W / 2, (y - cam.y) * cam.z + H / 2]; }
export function camMatrix(ctx, x = 0, y = 0, rot = 0, sx = 1, sy = 1) {
  const [px, py] = S(x, y), c = Math.cos(rot) * cam.z, s = Math.sin(rot) * cam.z;
  ctx.setTransform(c * sx, s * sx, -s * sy, c * sy, px, py);
}
export function plen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; }
export function trunc(p, u) {
  if (u >= 1) return [p, null]; if (u <= 0) return [[], null];
  const L = plen(p) * u; let acc = 0; const out = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (acc + l >= L) { const k = (L - acc) / (l || 1); const q = [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * k, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * k]; out.push(q); return [out, q]; }
    acc += l; out.push(p[i]);
  }
  return [out, p[p.length - 1]];
}
const DASH = { center: [34, 7, 6, 7], hidden: [11, 7], phantom: [30, 6, 5, 6, 5, 6], dot: [2, 7] };
export function pathScreen(ctx, pts, closed, move = true) {
  if (move) ctx.beginPath();
  for (let i = 0; i < pts.length; i++) { const [x, y] = S(pts[i][0], pts[i][1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  if (closed) ctx.closePath();
}
export const NIBS = [];
const gv = v => { const k = Math.max(0, Math.min(255, v * 255 | 0)); return `rgb(${k},${k},${k})`; };
// 描线：o = {w, dash, closed, u(描出进度), v(亮度), nib, ctx}
export function line(pts, o = {}) {
  if (!pts || pts.length < 2) return;
  const u = o.u ?? 1; if (u <= 0) return;
  let P = pts, closed = o.closed;
  if (u < 1) { const [tp, nib] = trunc(closed ? [...pts, pts[0]] : pts, u); P = tp; closed = false; if (nib && o.nib !== false) NIBS.push(nib); }
  if (P.length < 2) return;
  const c = o.ctx || g;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.strokeStyle = o.color || gv(o.v ?? 1);
  c.lineWidth = lw(o.w ?? LW.det); c.lineCap = o.cap || 'round'; c.lineJoin = 'round';
  if (o.dash) { c.setLineDash((DASH[o.dash] || o.dash).map(x => x * cam.z)); c.lineDashOffset = (o.dashOff || 0) * cam.z; } else c.setLineDash([]);
  pathScreen(c, P, closed); c.stroke(); c.setLineDash([]);
}
export function knock(pts, ctx = g) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; pathScreen(ctx, pts, true); ctx.fill(); }
export function fillV(pts, v, ctx = g) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = gv(v); pathScreen(ctx, pts, true); ctx.fill(); }
// 多子路径（外轮廓 + 窗孔）的纸色填充（evenodd）
export function knockMulti(paths, ctx = g, style = '#000') {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = style; ctx.beginPath();
  for (const p of paths) pathScreen(ctx, p, true, false);
  ctx.fill('evenodd');
}
export function clipMulti(ctx, paths) { ctx.beginPath(); for (const p of paths) pathScreen(ctx, p, true, false); ctx.clip('evenodd'); }
// 剖面线：多边形内 45° 平行线，u = 已排出的比例（按线序）
export function hatch(pts, o = {}) {
  const sp = o.sp ?? 12, ang = o.ang ?? Math.PI / 4, u = o.u ?? 1;
  if (u <= 0) return 0;
  const paths = Array.isArray(pts[0][0]) ? pts : [pts];
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); clipMulti(g, paths);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of paths[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2 + sp;
  const c = Math.cos(ang), s = Math.sin(ang), n = Math.ceil(2 * R / sp);
  g.strokeStyle = gv(o.v ?? .85); g.lineWidth = lw(o.w ?? LW.hair); g.setLineDash([]); g.lineCap = 'butt';
  g.beginPath(); let k = 0;
  for (let i = 0; i <= n; i++) {
    const tt = -R + i * sp; if (i / n > u) break; k++;
    const A = S(cx - s * tt - c * R, cy + c * tt - s * R), Bp = S(cx - s * tt + c * R, cy + c * tt + s * R);
    g.moveTo(A[0], A[1]); g.lineTo(Bp[0], Bp[1]);
  }
  g.stroke(); g.restore(); g.lineCap = 'round';
  return k;
}
export const circ = (cx, cy, r, n = 72, a0 = 0, a1 = TAU) => { const p = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; };
export const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const rot = (pts, cx, cy, a) => { const c = Math.cos(a), s = Math.sin(a); return pts.map(([x, y]) => [cx + c * (x - cx) - s * (y - cy), cy + s * (x - cx) + c * (y - cy)]); };
// 梯形齿近似渐开线
export function gearPts(cx, cy, T, m, a0 = 0) {
  const r = m * T / 2, ra = r + m, rf = r - 1.25 * m, p = [], h = TAU / T;
  for (let i = 0; i < T; i++) {
    const a = a0 + i * h;
    for (const [rr, fa] of [[rf, -.30], [ra, -.15], [ra, .15], [rf, .30]]) { const aa = a + fa * h; p.push([cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr]); }
    for (let k = 1; k <= 3; k++) { const aa = a + (.30 + .4 * k / 4) * h; p.push([cx + Math.cos(aa) * rf, cy + Math.sin(aa) * rf]); }
  }
  return p;
}
// 文字（字号为图纸单位）；u = 书写进度（从左到右露出）
export const FONT = { hand: "Arch, LongCang", cjk: "LongCang, Arch", tech: "B612M, NotoSC", sc: "NotoSC, B612M", sign: "LJMC" };
export function text(str, x, y, o = {}) {
  const size = o.size ?? 32, u = o.u ?? 1; if (u <= 0 || !str) return 0;
  const ctx = o.ctx || g;
  camMatrix(ctx, x, y, o.rot || 0, 1, o.sy ?? 1);
  ctx.font = `${o.weight || 400} ${size}px ${o.font || FONT.hand}`;
  ctx.textAlign = o.align || 'left'; ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = (o.ls || 0) + 'px';
  const wdt = ctx.measureText(str).width;
  ctx.fillStyle = o.color || gv(o.v ?? 1);
  const x0 = o.align === 'center' ? -wdt / 2 : o.align === 'right' ? -wdt : 0;
  if (u < 1) {
    ctx.save(); ctx.beginPath(); ctx.rect(x0 - 4, -size * 1.4, wdt * u + 4, size * 2.2); ctx.clip();
    ctx.fillText(str, 0, 0); ctx.restore();
    const nx = x0 + wdt * u, ny = -size * .35, c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
    if (o.nib !== false) NIBS.push([x + c * nx - s * ny, y + s * nx + c * ny]);
  } else ctx.fillText(str, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.letterSpacing = '0px';
  if (o.id && !o.rot && (o.sy ?? 1) > .99) {     // 登记可读文字（屏幕字高 ≥ 16 px 才算"给人读的"）
    const [a, b] = S(x + x0, y - size * .9), [c2, d] = S(x + x0 + wdt, y + size * .25);
    if (size * cam.z >= 16) REG.push({ id: o.id, text: o.full || str, x0: a, y0: b, x1: c2, y1: d });
  }
  return wdt;
}
export function textW(str, size, font = FONT.hand, ls = 0) { g.font = `400 ${size}px ${font}`; g.letterSpacing = ls + 'px'; const w = g.measureText(str).width; g.letterSpacing = '0px'; return w; }
export function arrow(p, dir, len = 18, wid = 5, v = 1, ctx = g) {
  const [tx, ty] = dir, nx = -ty, ny = tx;
  fillV([p, [p[0] + tx * len + nx * wid, p[1] + ty * len + ny * wid], [p[0] + tx * len - nx * wid, p[1] + ty * len - ny * wid]], v, ctx);
}
// 尺寸线：p1-p2，沿法向偏 off；label 可以是函数(u)→字符串（数字实时跑）
export function dim(p1, p2, off, label, o = {}) {
  const u = o.u ?? 1; if (u <= 0) return;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L = Math.hypot(dx, dy) || 1, tx = dx / L, ty = dy / L, nx = -ty, ny = tx;
  const gap = 8, ext = 14, sg = Math.sign(off) || 1;
  const a = [p1[0] + nx * off, p1[1] + ny * off], b = [p2[0] + nx * off, p2[1] + ny * off];
  const ue = Math.min(1, u * 3);
  if (Math.abs(off) > 1) {
    line([[p1[0] + nx * gap * sg, p1[1] + ny * gap * sg], [a[0] + nx * ext * sg, a[1] + ny * ext * sg]], { w: LW.hair, u: ue, nib: false });
    line([[p2[0] + nx * gap * sg, p2[1] + ny * gap * sg], [b[0] + nx * ext * sg, b[1] + ny * ext * sg]], { w: LW.hair, u: ue, nib: false });
  }
  const ug = Math.max(0, Math.min(1, (u - .15) / .6));      // 尺寸线从一端"量"到另一端
  if (ug > 0) {
    const e = o.grow === 'mid' ? null : [a[0] + (b[0] - a[0]) * ug, a[1] + (b[1] - a[1]) * ug];
    if (e) { line([a, e], { w: LW.hair, nib: ug < 1 }); arrow(a, [tx, ty]); if (ug >= 1) arrow(b, [-tx, -ty]); else arrow(e, [-tx, -ty], 14, 4, .9); }
  }
  if (label && u > .15) {
    let ang = Math.atan2(ty, tx); if (ang > Math.PI / 2 + .01) ang -= Math.PI; if (ang < -Math.PI / 2 - .01) ang += Math.PI;
    const tsz = o.size ?? 32, s = typeof label === 'function' ? label(ug) : label;
    const mid = o.at ?? .5;
    const m = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid], up = [Math.sin(ang), -Math.cos(ang)];
    const lo = o.labelOff ?? 10;
    text(s, m[0] + up[0] * lo, m[1] + up[1] * lo, { size: tsz, align: 'center', rot: ang, font: o.font || FONT.hand, nib: false });
    if (o.id && Math.abs(ang) < .01 && tsz * cam.z >= 16) {
      const full = typeof label === 'function' ? label(1) : label, w2 = textW(full, tsz, o.font || FONT.hand) / 2, cx = m[0] + up[0] * lo, cy = m[1] + up[1] * lo;
      const [x0, y0] = S(cx - w2, cy - tsz * .9), [x1, y1] = S(cx + w2, cy + tsz * .25); REG.push({ id: o.id, text: full, x0, y0, x1, y1 });
    }
  }
}
// 零件气球：引线 + 圆圈 + 编号
export function balloon(from, to, num, o = {}) {
  const u = o.u ?? 1; if (u <= 0) return;
  const r = o.r ?? 26;
  const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy) || 1;
  const end = [to[0] - dx / L * r, to[1] - dy / L * r];
  line([from, end], { w: LW.hair, u: Math.min(1, u * 1.8), nib: u < .55 });
  const dot = S(from[0], from[1]); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#fff'; g.beginPath(); g.arc(dot[0], dot[1], lw(3.6), 0, TAU); g.fill();
  if (u > .55) {
    const uu = Math.min(1, (u - .55) / .3);
    knock(circ(to[0], to[1], r, 32));
    line(circ(to[0], to[1], r, 40, -Math.PI / 2, -Math.PI / 2 + TAU), { w: LW.thin, u: uu, nib: false });
    if (uu > .4) text(String(num), to[0], to[1] + r * .38, { size: r * 1.1, align: 'center', font: FONT.hand });
  }
}
// 笔尖光点
export function nibs(a = 1) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter';
  for (const [x, y] of NIBS) { const [sx, sy] = S(x, y); const R = 18 * zp; const gr = g.createRadialGradient(sx, sy, 0, sx, sy, R); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(.22, `rgba(255,255,255,${.5 * a})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(sx - R, sy - R, 2 * R, 2 * R); }
  g.globalCompositeOperation = 'source-over'; NIBS.length = 0;
}
// fx：投影 / 去自投影 / 印章
export function fxShadow(paths, a, blur, dx, dy) {
  f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'lighter'; f.filter = blur ? `blur(${blur * cam.z}px)` : 'none';
  f.fillStyle = `rgba(255,0,0,${a})`; f.beginPath();
  for (const p of paths) pathScreen(f, p.map(([x, y]) => [x + dx, y + dy]), true, false);
  f.fill('nonzero'); f.filter = 'none';
}
export function fxUnshadow(paths) {
  f.setTransform(1, 0, 0, 1, 0, 0); f.globalCompositeOperation = 'multiply'; f.filter = 'none'; f.fillStyle = 'rgb(0,255,255)';
  f.beginPath(); for (const p of paths) pathScreen(f, p, true, false); f.fill('evenodd'); f.globalCompositeOperation = 'lighter';
}
