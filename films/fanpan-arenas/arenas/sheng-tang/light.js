// 《彩窗圣堂》的加色光图：灯晕、光柱、浮尘，以及「彩窗投在地上的色光」（把彩窗那张图抹虚了当光斑用）。
// 这些图贴在加色混合的片上，黑 = 不加光；它们是柔的（线性过滤），不走色阶也不抖动。全部逐像素算。
import { Plate, cloud } from './paint.js';

const sm = v => { v = v < 0 ? 0 : v > 1 ? 1 : v; return v * v * (3 - 2 * v); };
function grey(w, h, fn) { const p = new Plate(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.max(0, Math.min(1, fn((x + .5) / w, (y + .5) / h))) * 255; p.dot(x, y, [v, v, v]); } return p; }

// 圆的灯晕：中间亮，往外很快淡掉
const halo = n => grey(n, n, (u, v) => { const r = Math.hypot(u - .5, v - .5) * 2; return r >= 1 ? 0 : (1 - r) ** 2.3; });
// 浮尘：一小颗实一点的亮点
const dot = n => grey(n, n, (u, v) => { const r = Math.hypot(u - .5, v - .5) * 2.3; return r >= 1 ? 0 : (1 - r) ** 1.1; });
// 光柱：两边虚、中间有一道道深浅不一的光条，上头淡入、落地前淡出（图的上边是光柱的上头）
const beam = (w, h) => grey(w, h, (u, v) => {
  const e = 1 - Math.abs(u * 2 - 1), streak = .45 + .55 * cloud(u * 7, v * .6, 5, 2) + .25 * (cloud(u * 19, 0, 9, 1) - .5);
  return e ** .7 * sm(e * 4) * streak * sm(v / .14) * (1 - .55 * sm((v - .7) / .3));
});
// 把一张彩窗抹虚成光斑：先铺到一张四周留黑边的图上，再做两遍方框模糊（横竖各一遍算一遍）
function glowOf(src, pad = 6, r = 2, gain = 1.3) {
  const w = src.w + pad * 2, h = src.h + pad * 2; let a = new Float32Array(w * h * 3), b = new Float32Array(w * h * 3);
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const i = (y * src.w + x) * 4, o = ((y + pad) * w + x + pad) * 3; if (src.d[i + 3]) { a[o] = src.d[i] / 255; a[o + 1] = src.d[i + 1] / 255; a[o + 2] = src.d[i + 2] / 255; } }
  for (let pass = 0; pass < 2; pass++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let s = 0; for (let k = -r; k <= r; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx >= 0 && yy >= 0 && xx < w && yy < h) s += a[(yy * w + xx) * 3 + c]; }
      b[(y * w + x) * 3 + c] = s / (r * 2 + 1);
    }
    [a, b] = [b, a];
  }
  const p = new Plate(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; p.dot(x, y, [a[o] * 255 * gain, a[o + 1] * 255 * gain, a[o + 2] * 255 * gain]); }
  return p;
}

// glass：{ rose, lancets: [六扇], own, foe }（都是 Plate）
export function lightSet(glass) {
  const o = { halo: halo(64), dot: dot(16), beam: beam(64, 128), gRose: glowOf(glass.rose, 8, 3), gOwn: glowOf(glass.own, 6, 2), gFoe: glowOf(glass.foe, 6, 2) };
  glass.lancets.forEach((p, i) => { o['gL' + i] = glowOf(p, 6, 2); });
  return o;
}
