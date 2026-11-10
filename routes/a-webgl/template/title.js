// {{TITLE}} · 片名显影：任何片名都能用，不需要笔画骨架。
// 做法：把字形画进离屏画布，求「离笔画边缘多远」的距离场（engine/overlay/brush.js 的 chamfer）；每个像素的显影门槛
// = 0.7 ×（1 − 归一距离）+ 0.3 × 纸纤维噪声，进度推进时墨色先从笔画中线洇开、再漫到笔画边缘，边缘带纤维感的毛边。
// 时钟：显影进度一拍二（画出来的墨，一张一张地洇开；craft/animation.md §2），显影完成后字静止、永远锐利（显示层不过后期）。
// 要逐笔「书写」时，用 engine/overlay/brush.js（需要按笔顺的骨架，现有只有《北冥》两个字；tools/title 说明怎么为新字做骨架）。
//   createTitle({ text, font, size, x, y, ls, color, glow }) → { draw(ctx, p), box(), ready }
//     text 片名；font CSS 字体串（字族必须在本片字体子集里）；size 字号（像素）；x 左缘、y 字的中线（像素）；ls 字距（em）
//     draw(ctx, p) 按进度 p（0..1，可以是每个字各自的进度数组）把字画到显示层；box() → [x, y, w, h] 字的外框（给 window.TEXTS）
import { chamfer } from '../../engine/overlay/brush.js';
import { shadowOnly } from '../../engine/paint/canvas.js';
import { clamp, mulberry } from '../../engine/core/math.js';

export function createTitle({ text, font, size, x, y, ls = 0.08, color = [255, 250, 242], glow = [255, 190, 140] }) {
  const chars = [...text], S = Math.ceil(size * 1.25), pad = Math.round((S - size) / 2);
  const glyphs = [];
  let cx = x;
  for (const [i, ch] of chars.entries()) {
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
    c.fillText(ch, S / 2, S / 2);
    const src = c.getImageData(0, 0, S, S).data, n = S * S;
    const inside = new Uint8Array(n); for (let k = 0; k < n; k++) inside[k] = src[k * 4 + 3] > 96 ? 1 : 0;
    const dt = chamfer(inside, S, S);
    let dmax = 1; for (let k = 0; k < n; k++) if (dt[k] < 1e8 && dt[k] > dmax) dmax = dt[k];
    // 纸纤维噪声：低频团块 + 横向纤维，种子按字序固定
    const R = mulberry(7919 + i * 131), ph = [R() * 6.28, R() * 6.28, R() * 6.28];
    const idx = [], thr = [], alpha = [];
    for (let k = 0; k < n; k++) {
      const a = src[k * 4 + 3]; if (!a) continue;
      const px = k % S, py = (k / S) | 0;
      const fib = 0.5 + 0.25 * Math.sin(px * 0.21 + py * 0.03 + ph[0]) + 0.15 * Math.sin(px * 0.047 - py * 0.11 + ph[1]) + 0.1 * Math.sin((px + py) * 0.6 + ph[2]);
      const d = inside[k] ? Math.min(dt[k], dmax) / dmax : 0;
      idx.push(k); thr.push(0.7 * (1 - d) + 0.3 * fib); alpha.push(a);
    }
    const out = document.createElement('canvas'); out.width = out.height = S;
    const octx = out.getContext('2d');
    const m = measure(c, ch);
    glyphs.push({ ch, x: cx - pad, y: y - S / 2, S, idx: Int32Array.from(idx), thr: Float32Array.from(thr), a: Uint8Array.from(alpha), out, octx, img: octx.createImageData(S, S), lastP: -1, w: m });
    cx += m + ls * size;
  }
  const totalW = cx - x - ls * size;

  function paint(g, p) {
    if (g.lastP === p) return;
    g.lastP = p;
    const d = g.img.data; d.fill(0);
    if (p > 0) {
      const edge = 0.08, front = p * (1 + edge);
      for (let j = 0; j < g.idx.length; j++) {
        const v = clamp((front - g.thr[j]) / edge); if (v <= 0) continue;
        const o = g.idx[j] * 4; d[o] = color[0]; d[o + 1] = color[1]; d[o + 2] = color[2]; d[o + 3] = g.a[j] * v;
      }
    }
    g.octx.putImageData(g.img, 0, 0);
  }
  return {
    glyphs,
    // p：一个数（整行同步）或每个字一个进度
    draw(ctx, p) {
      const ps = Array.isArray(p) ? p : glyphs.map(() => p);
      ctx.save();
      glyphs.forEach((g, i) => {
        const pi = clamp(ps[i] ?? 0); if (pi <= 0) return;
        paint(g, pi);
        // 光晕只画投影不画图（engine/paint/canvas.js 的 shadowOnly），字边不会被叠画两遍变粗：外圈大而淡、内圈小，再画字本身
        const far = 4 * ctx.canvas.width;
        shadowOnly(ctx, g.out, g.x, g.y, `rgba(${glow[0]},${glow[1]},${glow[2]},${(0.5 * pi).toFixed(3)})`, size * 0.24, far);
        shadowOnly(ctx, g.out, g.x, g.y, `rgba(${glow[0]},${glow[1]},${glow[2]},${(0.4 * pi).toFixed(3)})`, size * 0.06, far);
        ctx.drawImage(g.out, g.x, g.y);
      });
      ctx.restore();
    },
    box: () => [x, y - size * 0.55, totalW, size * 1.1],
  };
}

function measure(c, ch) { return c.measureText(ch).width; }
