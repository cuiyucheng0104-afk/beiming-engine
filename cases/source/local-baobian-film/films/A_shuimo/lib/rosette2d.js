// 《豹变》A 水墨 · 母型 R 的 Canvas 2D 版（与 glsl.js 里的 rosette() 同一套字形参数）
// 用在书页：补纸上的新墨斑（S1 两枚、S6 补齐）。种子决定块数、缺口、角度与大小。
import { hashi } from './core.js';

const hS = (s, k) => hashi(Math.floor(s) * 131 + Math.floor(k) * 7 + 1013);

// 定形后的环斑：n 块沿切向拉长的弯椭圆，1–2 个缺口放宽到 1.6 倍；外沿深 15%
export function drawRosette(g, x, y, R, seed, color, alpha = 1, centre = null) {
  const n = 4 + (hS(seed, 0) < 0.6 ? 1 : 0) + (hS(seed, 1) < 0.3 ? 1 : 0);
  const th0 = 2 * Math.PI * hS(seed, 7);
  const g1 = Math.floor(hS(seed, 3) * n), g2 = hS(seed, 4) < 0.5 ? (g1 + 2) % n : -1;
  let tot = 0; for (let i = 0; i < n; i++) tot += (i === g1 || i === g2) ? 1.6 : 1;
  const rc = 0.62 * R;
  g.save(); g.translate(x, y);
  if (centre) { g.fillStyle = centre; g.beginPath(); g.arc(0, 0, 0.42 * R, 0, 6.283); g.fill(); }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const th = th0 + 2 * Math.PI * (acc + 0.5 + 0.18 * (hS(seed, 10 + i) - 0.5)) / tot;
    acc += (i === g1 || i === g2) ? 1.6 : 1;
    const a = 0.42 * R * (0.8 + 0.4 * hS(seed, 20 + i)) * (6 / (n + 1.5)) * 0.78;
    const b = 0.20 * R * (0.8 + 0.4 * hS(seed, 30 + i));
    // 弯椭圆：沿半径 rc 的圆弧取点，宽度按 b 收尖
    const span = a / rc, steps = 14;
    g.beginPath();
    for (let k = 0; k <= steps; k++) { const u = k / steps, ang = th - span + 2 * span * u, w = b * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)); g.lineTo(Math.cos(ang) * (rc + w), Math.sin(ang) * (rc + w)); }
    for (let k = steps; k >= 0; k--) { const u = k / steps, ang = th - span + 2 * span * u, w = b * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)); g.lineTo(Math.cos(ang) * (rc - w), Math.sin(ang) * (rc - w)); }
    g.closePath();
    g.fillStyle = color; g.globalAlpha = alpha * 0.85; g.fill();
    g.globalAlpha = alpha * 0.25; g.lineWidth = Math.max(0.6, b * 0.25); g.strokeStyle = color; g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
}
