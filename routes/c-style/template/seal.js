// 白文朱印：略不规整的朱红方块，字"阴刻"露出纸白；印泥不匀（细小白点、轻微的浓淡起伏），四边有几处残缺。
//   makeSeal({ text, family, px, seed, rgb }) → { cv, size, pad }
//     text    印文（一到四个字：一字居中，两字上下，三四字按右起竖读排成两列）
//     family  印文字体（main.js 已加载）；px 印面边长（画布像素）；rgb 印泥颜色（全片唯一的强调色，只给印）
//     cv      画布，边长 size = px + 2·pad（留出残缺与晕边的余量），贴图时按 size 对齐中心
// 只在 setup 里生成一次；贴到纸上时用 multiply，印泥透出纸纹。全部用种子随机，逐字节可复现。
// 方法参考："白文印：不规整的朱红方块里刻出白线，印泥带斑点"见 cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md §4
//   （lemo-opuscar@bebbbe1，MIT，LemoLab）；本文件是按该描述自己写的实现，未复制其代码。
import { mulberry, clamp } from '../../engine/core/math.js';
import { createNoise2D } from '../../engine/core/noise.js';

export function makeSeal({ text, family, px, seed = 23, rgb = [176, 46, 34] }) {
  const pad = Math.ceil(px * 0.08), size = Math.ceil(px + pad * 2);
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const R = mulberry(seed), nz = createNoise2D(mulberry(seed + 1));
  // 印面轮廓：沿四边取点，法向用低频噪声抖一点（≤ 1.5%），四角略圆
  const pts = [], N = 22, j = px * 0.015, r0 = pad, r1 = pad + px;
  const edge = (x, y, nx, ny, k) => pts.push([x + nx * j * nz(k * 0.37, seed), y + ny * j * nz(k * 0.37, seed)]);
  for (let i = 0; i < N; i++) edge(r0 + px * (i + 0.5) / N, r0, 0, -1, i);
  for (let i = 0; i < N; i++) edge(r1, r0 + px * (i + 0.5) / N, 1, 0, N + i);
  for (let i = 0; i < N; i++) edge(r1 - px * (i + 0.5) / N, r1, 0, 1, 2 * N + i);
  for (let i = 0; i < N; i++) edge(r0, r1 - px * (i + 0.5) / N, -1, 0, 3 * N + i);
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= pts.length; i++) { const a = pts[i % pts.length], b = pts[(i + 1) % pts.length]; g.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
  g.closePath(); g.fillStyle = `rgb(${rgb.join(',')})`; g.fill();

  // 印文：阴刻（destination-out），两字上下排，三四字右起竖读两列
  const chars = [...text].slice(0, 4), n = chars.length;
  const cells = n === 1 ? [[0.5, 0.5, 0.78]] : n === 2 ? [[0.5, 0.27, 0.46], [0.5, 0.73, 0.46]]
    : n === 3 ? [[0.73, 0.27, 0.44], [0.73, 0.73, 0.44], [0.27, 0.5, 0.6]]
      : [[0.73, 0.27, 0.42], [0.73, 0.73, 0.42], [0.27, 0.27, 0.42], [0.27, 0.73, 0.42]];
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    const [cx, cy, k] = cells[i];
    g.font = `400 ${(px * k).toFixed(1)}px "${family}", serif`;
    g.fillText(ch, r0 + px * cx, r0 + px * cy + px * 0.01);
  });
  // 印泥不匀：细小白点 + 边上的几处残缺
  for (let i = 0; i < 90; i++) {
    const x = r0 + R() * px, y = r0 + R() * px, rr = px * (0.004 + 0.012 * R() * R());
    g.globalAlpha = 0.35 + 0.65 * R(); g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 7; i++) {
    const side = Math.floor(R() * 4), u = R(), rr = px * (0.012 + 0.025 * R());
    const x = side === 0 ? r0 + u * px : side === 1 ? r1 : side === 2 ? r1 - u * px : r0;
    const y = side === 0 ? r0 : side === 1 ? r0 + u * px : side === 2 ? r1 : r1 - u * px;
    g.globalAlpha = 0.9; g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  // 浓淡起伏：按低频噪声把 alpha 压掉 0–14%
  const im = g.getImageData(0, 0, size, size), d = im.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4 + 3; if (!d[i]) continue;
    d[i] = Math.round(d[i] * clamp(0.93 + 0.07 * nz(x / (px * 0.22), y / (px * 0.22) + 9), 0.86, 1));
  }
  g.putImageData(im, 0, 0);
  return { cv, size, pad };
}
