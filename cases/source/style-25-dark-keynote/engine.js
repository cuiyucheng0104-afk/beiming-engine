// engine.js — 暗色科技发布 的绘制原语（Canvas 2D）。舞台 / 发丝网格 / 柔光 / 面板 / 光扫揭示 / 2.5D 摄影机。
import { clamp, lerp, seg, ss, eo, ei, eio, back, mulberry, hash, TAU } from '/core/lib.js';
export { clamp, lerp, seg, ss, eo, ei, eio, back, mulberry, hash, TAU };

export const W = 1920, H = 1080;
export const PAL = {
  bg0: '#0A0B10', bg1: '#161923', surf: '#12151C', surf2: '#1A1E28', surf3: '#232837',
  line: 'rgba(255,255,255,.08)', text: '#E8EAF0', dim: '#8A90A0', mute: '#5C6272',
  accent: '#FF7A1A', light: '#DCE5FF', cool: '#3A4FD0',
};
export const FONT = { ui: 'Inter', disp: 'InterTight', mono: 'JBMono', cjk: 'NotoSC' };
export const font = (px, wt = 500, fam = 'ui') => `${wt} ${px}px ${FONT[fam] || fam}`;
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
export function mixc(h1, h2, t) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const c = s => Math.round(lerp(a >> s & 255, b >> s & 255, clamp(t)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}
const _pool = {};
export function buf(name, w = W, h = H) {
  let c = _pool[name];
  if (!c || c.width !== w || c.height !== h) { c = _pool[name] = document.createElement('canvas'); c.width = w; c.height = h; }
  const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  return [c, g];
}
export function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); }

// 舞台：近黑底 + 上中部径向抬亮 + 偏心大冷光（个位数不透明度）+ 暗角
export function stage(g) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = PAL.bg0; g.fillRect(0, 0, W, H);
  const gr = g.createRadialGradient(W * 0.5, H * 0.3, 0, W * 0.5, H * 0.3, W * 0.72);
  gr.addColorStop(0, rgba(PAL.bg1, 0.95)); gr.addColorStop(1, rgba(PAL.bg0, 0));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  glow(g, W * 0.2, H * 0.86, 1000, PAL.cool, 0.06);
}
export function vignette(g, a = 0.55) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  const gr = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.08);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${a})`);
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
export function glow(g, x, y, r, color, a) {
  if (a <= 0.001 || r <= 0) return;
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, rgba(color, a)); gr.addColorStop(0.42, rgba(color, a * 0.34)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
}
// 发丝网格（48 px 模数，白 3%，每第 4 条 6%）；ox/oy = 世界原点的屏幕位置，scale = 缩放；clipR 用于从中心展开/收回
export function grid(g, o = {}) {
  const { ox = W / 2, oy = H / 2, scale = 1, module = 48, alpha = 1, clipR = 1e5, cx = ox, cy = oy } = o;
  const step = module * scale; if (step < 3 || alpha <= 0 || clipR <= 0) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath(); g.arc(cx, cy, clipR, 0, TAU); g.clip(); g.lineWidth = 1;
  const i0 = Math.floor(-ox / step), i1 = Math.ceil((W - ox) / step), j0 = Math.floor(-oy / step), j1 = Math.ceil((H - oy) / step);
  for (let pass = 0; pass < 2; pass++) {
    g.strokeStyle = `rgba(255,255,255,${(pass ? 0.06 : 0.032) * alpha})`; g.beginPath();
    for (let i = i0; i <= i1; i++) { if ((((i % 4) + 4) % 4 === 0) !== !!pass) continue; const x = Math.round(ox + i * step) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
    for (let j = j0; j <= j1; j++) { if ((((j % 4) + 4) % 4 === 0) !== !!pass) continue; const y = Math.round(oy + j * step) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
  }
  g.restore();
}
// 圆角面板：柔影 + 顶光渐变 + 1px 边 + 1px 内顶高光（在当前变换下绘制；px = 当前每世界单位的屏幕像素，用来保证 1 px）
export function panel(g, x, y, w, h, o = {}) {
  const { r = 20, fill = PAL.surf, px = 1, shadow = 1 } = o; const lw = 1 / px;
  g.save();
  if (shadow > 0) { g.shadowColor = `rgba(0,0,0,${0.55 * shadow})`; g.shadowBlur = Math.min(90, (18 + h * 0.12) * px); g.shadowOffsetY = Math.min(36, (6 + h * 0.04) * px); g.fillStyle = fill; rr(g, x, y, w, h, r); g.fill(); g.shadowColor = 'transparent'; }
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, mixc(fill, '#2A3040', 0.3)); gr.addColorStop(Math.min(1, 90 / Math.max(h, 1)), fill); gr.addColorStop(1, fill);
  g.fillStyle = gr; rr(g, x, y, w, h, r); g.fill();
  g.lineWidth = lw; g.strokeStyle = PAL.line; rr(g, x + lw / 2, y + lw / 2, w - lw, h - lw, r); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(x + r, y + 1.5 * lw); g.lineTo(x + w - r, y + 1.5 * lw); g.stroke();
  g.restore();
}
// 光扫揭示：src 是一张整屏图层；p 0..1 光带位置；被扫过的像素保持亮，未扫过的只有 base；前沿柔和，高光 ≤ 20%
export function lightReveal(g, src, p, o = {}) {
  const { base = 0.05, angle = 0.62, soft = 300, band = 120, glint = 0.18, rect = [0, 0, W, H] } = o;
  const [rx, ry, rw, rh] = rect;
  const [c, t] = buf('reveal', W, H);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const L = Math.abs(rw * ca) + Math.abs(rh * sa);
  const front = -soft + p * (L + soft * 2);
  const cx = rx + rw / 2, cy = ry + rh / 2, p0 = [cx - ca * L / 2, cy - sa * L / 2], at = d => [p0[0] + ca * d, p0[1] + sa * d];
  t.drawImage(src, 0, 0); t.globalCompositeOperation = 'destination-in';
  const A = at(front - soft), B = at(front);
  const gr = t.createLinearGradient(A[0], A[1], B[0], B[1]); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  t.fillStyle = gr; t.fillRect(0, 0, W, H);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = base; g.drawImage(src, 0, 0); g.globalAlpha = 1; g.drawImage(c, 0, 0); g.restore();
  if (glint > 0 && p > 0 && p < 1) {
    const [c2, t2] = buf('reveal2', W, H);
    t2.drawImage(src, 0, 0); t2.globalCompositeOperation = 'source-in';
    const A2 = at(front - band * 1.6), B2 = at(front + band * 0.4);
    const g2 = t2.createLinearGradient(A2[0], A2[1], B2[0], B2[1]);
    g2.addColorStop(0, 'rgba(255,255,255,0)'); g2.addColorStop(0.7, `rgba(235,240,255,${glint})`); g2.addColorStop(1, 'rgba(255,255,255,0)');
    t2.fillStyle = g2; t2.fillRect(0, 0, W, H);
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'lighter'; g.drawImage(c2, 0, 0); g.restore();
  }
}
// 摄影机：看向世界点 (x,y)，zoom，rot。唯一的 世界→屏幕 函数
export function camera({ x = 0, y = 0, zoom = 1, rot = 0, sx = 0, sy = 0 }) {
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const proj = (px, py) => { const X = (px - x) * zoom, Y = (py - y) * zoom; return [W / 2 + X * cr - Y * sr + sx, H / 2 + X * sr + Y * cr + sy]; };
  const apply = g => { g.setTransform(1, 0, 0, 1, 0, 0); g.translate(W / 2 + sx, H / 2 + sy); g.rotate(rot); g.scale(zoom, zoom); g.translate(-x, -y); };
  return { x, y, zoom, rot, proj, apply };
}
// 预渲染的辉光精灵（加色叠加）
const _spr = {};
export function sprite(color, size = 128) {
  const k = color + size; if (_spr[k]) return _spr[k];
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(0.18, rgba(color, 0.55)); gr.addColorStop(0.5, rgba(color, 0.12)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.fillRect(0, 0, size, size); return (_spr[k] = c);
}
