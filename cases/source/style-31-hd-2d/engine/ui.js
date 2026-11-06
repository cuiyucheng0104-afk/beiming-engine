// 画面内文字：章节牌（左上）与收尾横幅（下方居中）。一种金属（金）+ 一种纸白，压在半透明暗底板上。
import { T, DUR } from '../timeline.js';

const cv = document.getElementById('ov'), g = cv.getContext('2d');
const W = 1920, H = 1080;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const F = '"Noto Serif SC"';
export async function overlayReady() { await Promise.all([`600 40px ${F}`, `900 40px ${F}`].map(f => document.fonts.load(f, '第一章港口集市启航—'))); }

function spaced(text, x, y, sp, align = 'center') {
  const ws = [...text].map(c => g.measureText(c).width), tot = ws.reduce((a, b) => a + b, 0) + sp * (ws.length - 1);
  let cx = align === 'center' ? x - tot / 2 : x; [...text].forEach((c, i) => { g.fillText(c, cx + ws[i] / 2, y); cx += ws[i] + sp; });
  return tot;
}
function diamond(cx, cy, r, fill) { g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); fill ? g.fill() : g.stroke(); }
function plate(x, y, w, h) {
  const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, 'rgba(16,14,30,.80)'); gr.addColorStop(1, 'rgba(8,6,16,.86)');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(214,190,130,.92)'; g.lineWidth = 2; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
  g.strokeStyle = 'rgba(214,190,130,.32)'; g.lineWidth = 1; g.strokeRect(x + 7.5, y + 7.5, w - 15, h - 15);
  g.fillStyle = '#e2c989'; for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) diamond(cx, cy, 7, true);
}

// 章节牌：0.000 起滑入，第 0.5 拍（0.333 s）落定；第 6 拍（4.000 s）开始淡出
const CARD = { x: 84, y: 76, w: 452, h: 176 };
function card(t) {
  const a = ss(seg(t, 0, T.cardIn)) * (1 - ss(seg(t, T.cloudGo, T.cloudGo + .4)));
  if (a <= 0) return null;
  const dx = (1 - ss(seg(t, 0, T.cardIn))) * -26;
  g.save(); g.globalAlpha = a; g.translate(dx, 0);
  const { x, y, w, h } = CARD; plate(x, y, w, h);
  g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillStyle = '#d8c28e'; g.font = `600 30px ${F}`; spaced('第一章', x + 40 + 70, y + 50, 14);
  g.strokeStyle = 'rgba(226,201,137,.8)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x + 190, y + 50); g.lineTo(x + w - 40, y + 50); g.stroke(); diamond(x + w - 40, y + 50, 4, true);
  g.fillStyle = '#f3ead6'; g.font = `900 70px ${F}`; g.shadowColor = 'rgba(255,190,110,.35)'; g.shadowBlur = 18;
  spaced('港口集市', x + w / 2, y + 116, 18);
  g.restore();
  return a >= .999 ? [{ id: 'ch', text: '第一章', x0: x, y0: y + 30, x1: x + 180, y1: y + 70 }, { id: 'ti', text: '港口集市', x0: x + 40, y0: y + 76, x1: x + w - 40, y1: y + 156 }] : [];
}
// 收尾横幅：第 25 拍（16.667 s）落定，一直留到片尾
function banner(t) {
  const a = ss(seg(t, T.beamHit - .3, T.beamHit));
  if (a <= 0) return null;
  const cy = H - 132 + (1 - a) * 12;
  g.save(); g.globalAlpha = a;
  const band = g.createLinearGradient(0, cy - 90, 0, cy + 90); band.addColorStop(0, 'rgba(6,4,14,0)'); band.addColorStop(.5, 'rgba(6,4,14,.42)'); band.addColorStop(1, 'rgba(6,4,14,0)');
  g.fillStyle = band; g.fillRect(0, cy - 90, W, 180);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#f6f0e2'; g.font = `900 64px ${F}`; g.shadowColor = 'rgba(255,200,120,.45)'; g.shadowBlur = 22;
  const tw = spaced('启航', W / 2, cy, 46);
  g.shadowBlur = 0; g.strokeStyle = 'rgba(226,201,137,.9)'; g.fillStyle = '#e2c989'; g.lineWidth = 1.5;
  for (const s of [-1, 1]) { const x0 = W / 2 + s * (tw / 2 + 34), x1 = W / 2 + s * (tw / 2 + 34 + 150 * a);
    const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, 'rgba(226,201,137,1)'); gr.addColorStop(1, 'rgba(226,201,137,0)'); g.strokeStyle = gr;
    g.beginPath(); g.moveTo(x0, cy); g.lineTo(x1, cy); g.stroke(); g.strokeStyle = 'rgba(226,201,137,.9)'; diamond(x0 - s * 4, cy, 6, false); diamond(x0 - s * 4, cy, 2.5, true); }
  g.restore();
  return a >= .999 ? [{ id: 'qh', text: '启航', x0: W / 2 - tw / 2, y0: cy - 40, x1: W / 2 + tw / 2, y1: cy + 40 }] : [];
}

export function drawOverlay(t) {
  g.clearRect(0, 0, W, H);
  const out = [];
  for (const f of [card, banner]) { const r = f(t); if (r) out.push(...r); }
  return out;
}
export { DUR };
