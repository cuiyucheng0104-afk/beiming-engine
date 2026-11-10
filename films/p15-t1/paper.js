// 宣纸：程序化生成一张纸，加一张给墨层用的"纸齿"遮罩。只在 setup 里生成一次，之后每帧只是贴图。
//   makePaper({ w, h, s, seed }) → { paper, tooth }
//     w, h   画布像素；s 设计像素 → 画布像素的倍数（横屏 = H / 1080）。纤维长短、粗细、斑点大小都乘 s，
//            换分辨率时纸的"物理尺度"不变，4K 下不会变成一层更细的噪点（见 routes/directing/craft/video.md §3.3）
//     paper  纸本身：暖白底 + 极低对比的云絮 + 长短纤维 + 纸浆斑点 + 细颗粒 + 很轻的边缘陈旧
//     tooth  只有 alpha 的纤维与颗粒：墨层先用它做一次 destination-out，墨里就透出纸纤维（墨"吃"进纸里，不是浮在纸上）
//   PAPER_RGB  纸的底色（给 index.html 与调色参考）
// 分寸（模版的取舍，改之前先看一遍成片）：
//   · 云絮只有 ±1.2% 的明暗、两三个周期，看得出是纸，不出现"大理石色斑"；纸纹的亮度标准差约 1–2 级（8 位）
//   · 纤维七成偏白（宣纸纤维半透明、比纸面亮），三成略暗；单根不透明度 ≤ 0.3，远看是质感、近看才是纤维
//   · 全部用种子随机（mulberry），不读 Math.random，同一种子逐字节相同
// 方法参考：宣纸纹理"暖白纸 + 云絮 + 长纤维 + 纸浆斑点 + 颗粒 + 轻暗角、锚定在世界上"的配方见
//   cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md §2（lemo-opuscar@bebbbe1，MIT，LemoLab）；本文件是按该描述自己写的实现，未复制其代码。
import { clamp, mulberry } from '../../engine/core/math.js';
import { createNoise2D } from '../../engine/core/noise.js';

export const PAPER_RGB = [240, 233, 218];

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export function makePaper({ w, h, s, seed = 17 }) {
  const R = mulberry(seed), cloud = createNoise2D(mulberry(seed + 1)), dens = createNoise2D(mulberry(seed + 2));
  const paper = canvas(w, h), g = paper.getContext('2d');
  const tooth = canvas(w, h), q = tooth.getContext('2d');

  // 1) 底色 + 云絮：小图上算明暗，再平滑放大（只有两三个周期，对比 ±1.2%）
  const cw = 64, ch = Math.max(8, Math.round(64 * h / w)), small = canvas(cw, ch), sg = small.getContext('2d');
  const im = sg.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const u = x / cw * 2.6, v = y / ch * 2.6 * ch / cw;
    const k = 1 + 0.012 * (0.7 * cloud(u, v) + 0.3 * cloud(u * 2.3 + 7, v * 2.3));
    const i = (y * cw + x) * 4;
    im.data[i] = PAPER_RGB[0] * k; im.data[i + 1] = PAPER_RGB[1] * k; im.data[i + 2] = PAPER_RGB[2] * k; im.data[i + 3] = 255;
  }
  sg.putImageData(im, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, w, h);

  // 2) 纤维：密度随一层中频噪声成团（"云絮"处更密），数量按设计面积定，分辨率变了根数不变、尺寸随 s 放大
  const area = (w / s) * (h / s) / (1920 * 1080);
  const fiber = (count, lenLo, lenHi, longShare) => {
    for (let i = 0; i < count; i++) {
      const x = R() * w, y = R() * h;
      const d = 0.5 + 0.5 * dens(x / (s * 520), y / (s * 520));
      if (R() > 0.35 + 0.65 * d) continue;
      const long = R() < longShare, len = s * (long ? 60 + 110 * R() : lenLo + (lenHi - lenLo) * R() * R());
      const a = R() * Math.PI * 2, bend = (R() - 0.5) * len * 0.5;
      const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
      const mx = x - Math.sin(a) * bend, my = y + Math.cos(a) * bend;
      const light = R() < 0.7, alpha = light ? 0.08 + 0.2 * R() : 0.04 + 0.08 * R();
      const lw = Math.max(0.6, s * (0.35 + 0.55 * R()));
      for (const [ctx, col, k] of light ? [[g, '255,253,246', 1], [q, '255,255,255', 2.2]] : [[g, '128,114,88', 1]]) {
        ctx.strokeStyle = `rgba(${col},${clamp(alpha * k).toFixed(3)})`; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.quadraticCurveTo(mx, my, x + dx, y + dy); ctx.stroke();
      }
    }
  };
  fiber(Math.round(6500 * area), 6, 46, 0.05);

  // 3) 纸浆斑点与少量树皮屑（只在纸上，不进纸齿：墨盖上去照样黑）
  for (let i = 0, n = Math.round(520 * area); i < n; i++) {
    const x = R() * w, y = R() * h, r = s * (0.3 + 0.7 * R() * R());
    g.fillStyle = `rgba(112,98,74,${(0.08 + 0.22 * R()).toFixed(3)})`;
    g.beginPath(); g.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); g.fill();
  }
  for (let i = 0, n = Math.round(46 * area); i < n; i++) {
    const x = R() * w, y = R() * h, len = s * (1.6 + 3.2 * R()), a = R() * Math.PI;
    g.strokeStyle = `rgba(118,92,60,${(0.16 + 0.18 * R()).toFixed(3)})`; g.lineWidth = Math.max(0.6, s * 0.7); g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }

  // 4) 细颗粒（±2 级）同时给云絮的平滑放大"抖色"，避免 8 位色阶断层；纸齿里也放一层更稀的颗粒
  const pd = g.getImageData(0, 0, w, h), px = pd.data, td = q.getImageData(0, 0, w, h), tx = td.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (R() + R() - 1) * 2.4;
    px[i] += n; px[i + 1] += n; px[i + 2] += n * 0.9;
    const a = R();
    if (a > 0.86) tx[i + 3] = Math.max(tx[i + 3], (a - 0.86) * 360);
    tx[i] = tx[i + 1] = tx[i + 2] = 255;
  }
  g.putImageData(pd, 0, 0); q.putImageData(td, 0, 0);

  // 5) 很轻的边缘陈旧（乘法，角落约 −5%）：画在纸上，随纸一起被镜头推近
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.56);
  vg.addColorStop(0, 'rgb(255,255,255)'); vg.addColorStop(1, 'rgb(240,234,224)');
  g.globalCompositeOperation = 'multiply'; g.fillStyle = vg; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
  return { paper, tooth };
}
