// {{TITLE}} · 片名题写：任何片名都能用，不需要笔画骨架。墨色片名题在亮的晨空上，像山水画的题款（墨与山石的墨线同色）。
// 做法：把字形画进离屏画布，求「离笔画边缘多远」的距离场（engine/overlay/brush.js 的 chamfer）；每个像素的显影门槛
// = 0.62 ×（1 − √归一距离）+ 0.38 × 纸纤维噪声，进度推进时墨先从笔画中线洇开、再漫到笔画边缘，边缘带纤维感的毛边；
// 墨刚落纸时整字先透出一层淡墨，笔画再洇满（淡墨 → 浓墨，宣纸上的墨就是这样走的）。显完后墨色留一点浓淡不匀（吸墨不均），不是平涂。
// 时钟：显影进度一拍二（画出来的墨，一张一张地洇开；craft/animation.md §2），显完后字静止、永远锐利（显示层不过后期）。
// 可读性：墨色字压在亮天上，对比度远高于 3:1（QA 的 texts.contrast，VISUAL-DESIGN §6.3）；换成浅色字压亮天就读不出来，
// 那时要给字找暗的落点或在场景里垫一块暗的云影，不要靠字自己的光晕（光晕不算背景，QA 照样判不过）。
// 要逐笔「书写」时，用 engine/overlay/brush.js（需要按笔顺的骨架，现有只有《北冥》两个字；tools/title 说明怎么为新字做骨架）。
//   createTitle({ text, font, size, x, y, ls, color, feather }) → { glyphs, draw(ctx, p), box() }
//     text 片名；font CSS 字体串（字族必须在本片字体子集里）；size 字号（像素）；x 左缘、y 字的中线（像素）；ls 字距（em）
//     color 墨色 [r, g, b]（默认画风的墨 #2A2D52）；feather 洇边强度（墨渗进纸纤维的一圈淡墨，0 = 不要）
//     draw(ctx, p) 按进度 p（0..1，可以是每个字各自的进度数组）把字画到显示层；box() → [x, y, w, h] 字的外框（给 window.TEXTS）
import { chamfer } from '../../engine/overlay/brush.js';
import { shadowOnly } from '../../engine/paint/canvas.js';
import { clamp, mulberry } from '../../engine/core/math.js';

export function createTitle({ text, font, size, x, y, ls = 0.08, color = [42, 45, 82], feather = 0.22 }) {
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
    const R = mulberry(7919 + i * 131), ph = [R() * 6.28, R() * 6.28, R() * 6.28, R() * 6.28];
    const idx = [], thr = [], alpha = [], dry = [];
    for (let k = 0; k < n; k++) {
      const a = src[k * 4 + 3]; if (!a) continue;
      const px = k % S, py = (k / S) | 0;
      const fib = 0.5 + 0.25 * Math.sin(px * 0.21 + py * 0.03 + ph[0]) + 0.15 * Math.sin(px * 0.047 - py * 0.11 + ph[1]) + 0.1 * Math.sin((px + py) * 0.6 + ph[2]);
      const d = inside[k] ? Math.min(dt[k], dmax) / dmax : 0;
      idx.push(k); thr.push(0.62 * (1 - Math.sqrt(d)) + 0.38 * fib); alpha.push(a);   // 开方：细笔画的中线也早早出现，不只是最粗那一笔先冒出来
      // 显完后的浓淡：沿运笔方向（斜 30°）的细纹 + 团块，最多淡 16%（吸墨不匀），笔画中线最浓
      const streak = 0.5 + 0.5 * Math.sin((px * 0.87 + py * 0.5) * 0.9 + 2.3 * Math.sin(py * 0.05 + ph[3]));
      dry.push(1 - 0.16 * streak * (1 - 0.6 * d) * fib);
    }
    const out = document.createElement('canvas'); out.width = out.height = S;
    const octx = out.getContext('2d');
    glyphs.push({ ch, x: cx - pad, y: y - S / 2, S, idx: Int32Array.from(idx), thr: Float32Array.from(thr), a: Uint8Array.from(alpha), dry: Float32Array.from(dry), out, octx, img: octx.createImageData(S, S), lastP: -1, w: c.measureText(ch).width });
    cx += glyphs.at(-1).w + ls * size;
  }
  const totalW = cx - x - ls * size;

  function paint(g, p) {
    if (g.lastP === p) return;
    g.lastP = p;
    const d = g.img.data; d.fill(0);
    if (p > 0) {
      const edge = 0.07 + 0.32 * (1 - p) * (1 - p), front = p * (1 + edge);   // 起初边很软（墨刚渗进纸、一片淡影），显完时收成清楚的笔画边
      const ghost = 0.3 * clamp(p / 0.2) * (1 - p);   // 墨刚落纸：整个字先透出一层淡墨，笔画再从中线洇满
      for (let j = 0; j < g.idx.length; j++) {
        const v = Math.max(ghost, clamp((front - g.thr[j]) / edge)); if (v <= 0) continue;
        const o = g.idx[j] * 4; d[o] = color[0]; d[o + 1] = color[1]; d[o + 2] = color[2];
        d[o + 3] = g.a[j] * v * (1 - (1 - g.dry[j]) * clamp((p - 0.6) / 0.4));   // 浓淡在洇满之后才显出来
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
        // 洇边：墨渗进纸纤维的一圈淡墨，只画投影不画图（engine/paint/canvas.js 的 shadowOnly），字边不会被叠画两遍变粗
        if (feather > 0) shadowOnly(ctx, g.out, g.x, g.y, `rgba(${color[0]},${color[1]},${color[2]},${(feather * pi).toFixed(3)})`, size * 0.035, 4 * ctx.canvas.width);
        ctx.drawImage(g.out, g.x, g.y);
      });
      ctx.restore();
    },
    box: () => [x, y - size * 0.55, totalW, size * 1.1],
  };
}
