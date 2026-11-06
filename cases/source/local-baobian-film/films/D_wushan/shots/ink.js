// 《豹变》D 雾山 · 墨甩划像（#04 → #05，f254–f266）的笔身：一笔浓墨从左上斜扫到右下
// 笔路：贝塞尔 (−180, 120) → (700, 380) → (1500, 760) → (2150, 1010)；起笔 120·K、笔腹 560·K、收笔 260·K
// 一拍二：f254 画到 38%，f256 到 82%，f258 画完；收笔前 40% 有 14 道鬃毛飞白；笔头前方甩出 40 颗溅点
import { inkStroke } from '/engine/core/stroke.js';
import { lerp, seg, ss, hashi, hash2, vn1 } from '../lib/util.js';

const B = [[-180, 120], [700, 380], [1500, 760], [2150, 1010]];
export const INK = { P0: B[0], P3: B[3], ang: Math.atan2(B[3][1] - B[0][1], B[3][0] - B[0][0]) };
const bez = s => { const u = 1 - s; return [0, 1].map(k => u * u * u * B[0][k] + 3 * u * u * s * B[1][k] + 3 * u * s * s * B[2][k] + s * s * s * B[3][k]); };
const width = s => lerp(lerp(120, 560, ss(s / .35)), 260, ss((s - .62) / .38));
// 一拍二的画到哪里
export function inkProgress(fr) { const f2 = Math.floor(fr / 2) * 2; return f2 < 254 ? 0 : f2 < 256 ? .38 : f2 < 258 ? .82 : 1; }
// 笔头沿笔路总方向的投影（给总合成的划像）
export function inkHead(fr) {
  const s = inkProgress(fr); if (s <= 0) return -1e4;
  const p = bez(s), d = [Math.cos(INK.ang), Math.sin(INK.ang)];
  return (p[0] - B[0][0]) * d[0] + (p[1] - B[0][1]) * d[1];
}
export function drawInk(OV, fr) {
  const s1 = inkProgress(fr); if (s1 <= 0) return;
  const g = OV.use(), K = OV.K, X = OV.X, Y = OV.Y;
  const N = 240, pts = [];
  for (let i = 0; i <= N; i++) { const s = s1 * i / N; const p = bez(s); pts.push([p[0], p[1], width(s) / 2240]); }
  const poly = inkStroke(pts, { size: 1120, thinning: 1, streamline: .15, start: { taper: 60 }, end: s1 >= 1 ? { taper: 0 } : {} });
  // 笔身边缘：两级噪声（8–20·K 的碎边 + 40–80·K 的大起伏）；起笔有一处压痕
  g.save();
  g.beginPath();
  poly.forEach(([x, y], i) => {
    const big = (vn1(i * .09, 5) - .5) * 34, mid = (vn1(i * .7, 3) - .5) * 16, fine = (hash2(i, 7) - .5) * 7;
    const j = big + mid + fine;
    const xx = X(x + j * .7), yy = Y(y + j);
    if (i) g.lineTo(xx, yy); else g.moveTo(xx, yy);
  });
  g.closePath();
  g.fillStyle = 'rgb(23,32,31)'; g.fill();
  g.globalCompositeOperation = 'source-atop';
  // 湿亮痕：2–3 段长短不一，只在笔腹（不再是一条连续的灰色高光线）
  // 返修 2：湿亮痕宽一点、软一点、淡一点（原来是三段细亮线，像路面上的虚线）
  g.filter = `blur(${(5 * K).toFixed(2)}px)`;
  for (const [sa, sb, off, w] of [[.3, .41, -.14, 26], [.5, .6, .06, 40], [.66, .72, -.22, 18]]) {
    if (s1 < sb) continue;
    g.strokeStyle = 'rgba(46,58,56,.55)'; g.lineWidth = w * K; g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= 24; i++) { const s = lerp(sa, sb, i / 24), p = bez(s), pn = bez(Math.min(1, s + .01)), dx = pn[0] - p[0], dy = pn[1] - p[1], L = Math.hypot(dx, dy) || 1, ww = width(s);
      const x = X(p[0] - dy / L * off * ww), y = Y(p[1] + dx / L * off * ww); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
  }
  g.filter = 'none';
  // 飞白：沿笔向的破碎长条，越接近收笔越多；横跨笔宽的条数不均匀，长短随机
  g.globalCompositeOperation = 'destination-out';
  const NB = 16;
  for (let j = 0; j < NB; j++) {
    const off = (hashi(j * 7 + 1) - .5) * .92, lw = (1.5 + 5 * Math.pow(hashi(j * 5), 1.6)) * K;
    const sStart = .5 + .3 * hashi(j * 11);
    g.lineWidth = lw; g.lineCap = 'round';
    let on = false;
    g.beginPath();
    for (let i = 0; i <= 140; i++) {
      const s = sStart + (s1 - sStart) * i / 140; if (s1 <= sStart) break;
      const p = bez(s), pn = bez(Math.min(1, s + .01)), dx = pn[0] - p[0], dy = pn[1] - p[1], L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L, w = width(s);
      const gap = vn1(s * (22 + 30 * hashi(j * 3)) + j * 3.1, j) < .18 + .5 * ss((s - sStart) / (1 - sStart));
      const x = X(p[0] + nx * off * w), y = Y(p[1] + ny * off * w);
      if (gap) { if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y); } else on = false;
    }
    g.stroke();
  }
  // 收笔分叉成 12 束鬃毛：最后 10% 沿笔向切开细缝
  if (s1 >= 1) {
    for (let j = 1; j < 12; j++) {
      const off = (j / 12 - .5) * .95 + (hashi(j * 13) - .5) * .04;
      g.lineWidth = (2 + 2.5 * hashi(j * 17)) * K;
      g.beginPath();
      for (let i = 0; i <= 20; i++) { const s = .9 + .1 * i / 20 + (hashi(j) - .5) * .02, p = bez(Math.min(1, s)), pn = bez(Math.min(1, s + .01)), dx = pn[0] - p[0], dy = pn[1] - p[1], L = Math.hypot(dx, dy) || 1, w = width(Math.min(1, s));
        const x = X(p[0] - dy / L * off * w), y = Y(p[1] + dx / L * off * w); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
  }
  g.restore();
  // 溅点：两批（f254、f256），沿笔路方向 ±20° 散开，边缘洇开（实心团）
  const f2 = Math.floor(fr / 2) * 2;
  const batches = f2 >= 256 ? 2 : 1;
  g.save();
  for (let i = 0; i < 40; i++) {
    const bt = i < 22 ? 0 : 1; if (bt >= batches) continue;
    const sAt = bt === 0 ? .38 : .82;
    const p = bez(sAt), pn = bez(Math.min(1, sAt + .02));
    const a0 = Math.atan2(pn[1] - p[1], pn[0] - p[0]) + (hashi(i * 3) - .5) * 40 * Math.PI / 180;
    const dist = 120 + 520 * hashi(i * 7);
    const r = 3 + 25 * Math.pow(hashi(i * 11), 2.2);
    const x = p[0] + Math.cos(a0) * dist, y = p[1] + Math.sin(a0) * dist;
    g.fillStyle = 'rgba(23,32,31,.95)';
    g.shadowColor = 'rgba(23,32,31,.6)'; g.shadowBlur = r * .6 * K;
    g.beginPath(); g.arc(X(x), Y(y), r * K, 0, 6.2832); g.fill();
    if (r > 10) { g.beginPath(); g.arc(X(x + r * .9 * Math.cos(a0)), Y(y + r * .9 * Math.sin(a0)), r * .45 * K, 0, 6.2832); g.fill(); }
  }
  g.restore();
}
