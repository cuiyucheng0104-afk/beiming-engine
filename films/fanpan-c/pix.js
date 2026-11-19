// 《林间寨擂》· C 版的像素画工具：所有贴图都在这里逐像素画出来，没有外部图片，也不和 B 版共用。
//   D            每米多少像素。场景贴图和棋子序列帧用同一个密度：棋子的一个像素和石板的一个像素一样大
//   RAMP         各材料的 6 级色阶：最暗一级是带紫味或青味的墨色，不是纯黑；最亮一级留给受光的边
//   Pix          一张像素画布：put 按色阶落一个点（4×4 Bayer 抖动只在两级交界处起作用），
//                ell / box / line 画带明暗的基本形，outline 给透明边描一圈最暗色
export const D = 40;

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ramp = (...l) => l.map(hex);
export const RAMP = {
  dirt: ramp('#22141e', '#462a22', '#70482a', '#9a6c38', '#c2944c', '#e8c070'),
  slab: ramp('#1c1e30', '#30364c', '#48546a', '#647688', '#8698a0', '#b4c4bc'),
  rock: ramp('#1c1a2c', '#33304a', '#524e68', '#787488', '#a09ca4', '#ccc8c0'),
  grass: ramp('#0a2a22', '#12482a', '#1f6e2c', '#3f9a2e', '#7cc430', '#c4e84c'),
  leaf: ramp('#061c1c', '#0c3424', '#14542a', '#22782c', '#4ca42e', '#9cd43c'),
  wood: ramp('#22101a', '#40201c', '#683620', '#905228', '#b87834', '#dca850'),
  bamboo: ramp('#1c2410', '#3a4414', '#646c1c', '#94982c', '#c4c048', '#ece480'),
  thatch: ramp('#2c1a14', '#52321a', '#80541e', '#ac7c2a', '#d4a83e', '#f4d870'),
  teal: ramp('#042c34', '#065c5c', '#00908a', '#00c8a8', '#6cf4d4', '#dcfff4'),
  red: ramp('#34081c', '#701030', '#b81c38', '#f04048', '#ff8c78', '#ffdcc8'),
  gold: ramp('#3c2008', '#7c4810', '#c47c14', '#f4ac28', '#ffd868', '#fff4c0'),
  bone: ramp('#2c2434', '#5c5060', '#8c8078', '#bcb098', '#e0d8b8', '#fffce0'),
  violet: ramp('#1c0c2c', '#3c1850', '#682880', '#9c44b0', '#cc78d8', '#f0c0f4'),
  clay: ramp('#2c0c14', '#5c1c1c', '#943020', '#c44c28', '#e87c40', '#ffb878'),
};

// 整数哈希 → [0, 1)
export function hash2(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
// 值噪声；给了周期就能无缝平铺
export function vnoise(x, y, s = 0, px = 0, py = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const w = (i, j) => hash2(px ? ((i % px) + px) % px : i, py ? ((j % py) + py) % py : j, s);
  const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y, s = 0, oct = 3, px = 0, py = 0) {
  let v = 0, amp = .5, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f, s + i * 17, px * f, py * f); sum += amp; amp *= .5; f *= 2; }
  return v / sum;
}
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export class Pix {
  constructor(w, h) { this.w = w | 0; this.h = h | 0; this.d = new Uint8ClampedArray(this.w * this.h * 4); }
  put(x, y, rp, lvl, band = .5, a = 255) {
    x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    const t = lvl + ((BAYER[(y & 3) * 4 + (x & 3)] + .5) / 16 - .5) * band, c = rp[Math.max(0, Math.min(rp.length - 1, Math.round(t)))], i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a; return this;
  }
  has(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  // 整幅逐点：fn(x, y) → [色阶, 级数, 抖动带宽?, 不透明度?]，返回空就不动这一点
  fill(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const r = fn(x, y); if (r) this.put(x, y, r[0], r[1], r[2], r[3]); } return this; }
  // 带球面明暗的椭圆：左上受光，右下背光；gain 是明暗跨几级
  ell(cx, cy, rx, ry, rp, base, gain = 2.4, band = .5) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry, q = nx * nx + ny * ny; if (q > 1) continue;
      this.put(x, y, rp, base + gain * (-.5 * nx - .62 * ny + .5 * Math.sqrt(1 - q) - .32), band);
    }
    return this;
  }
  // 矩形：lvl 可以是数，也可以是 (u, v) → 级数（u、v 是 0–1 的相对位置）
  box(x0, y0, w, h, rp, lvl, band = .4) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.put(x0 + x, y0 + y, rp, typeof lvl === 'function' ? lvl(w > 1 ? x / (w - 1) : 0, h > 1 ? y / (h - 1) : 0, x, y) : lvl, band);
    return this;
  }
  line(x0, y0, x1, y1, rp, lvl, thick = 1, band = .3) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5));
    for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; for (let a = 0; a < thick; a++) for (let b = 0; b < thick; b++) this.put(x + a, y + b, rp, typeof lvl === 'function' ? lvl(i / n) : lvl, band); }
    return this;
  }
  // 给形体描边：挨着不透明点的透明点涂成最暗一级（像素画的外轮廓线）
  outline(rp, lvl = 0) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.has(x, y) && (this.has(x - 1, y) || this.has(x + 1, y) || this.has(x, y - 1) || this.has(x, y + 1))) add.push(x, y);
    for (let i = 0; i < add.length; i += 2) this.put(add[i], add[i + 1], rp, lvl, 0);
    return this;
  }
  // 把另一张画布贴上来（透明的地方不盖）
  stamp(p, x0, y0) {
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const i = (y * p.w + x) * 4; if (!p.d[i + 3]) continue; const X = x0 + x, Y = y0 + y; if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue; const j = (Y * this.w + X) * 4; this.d[j] = p.d[i]; this.d[j + 1] = p.d[i + 1]; this.d[j + 2] = p.d[i + 2]; this.d[j + 3] = p.d[i + 3]; }
    return this;
  }
  canvas() { const c = document.createElement('canvas'); c.width = this.w; c.height = this.h; c.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0); return c; }
}

// 3×5 点阵数字和像素心（血量牌、战力牌用）
export const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
export const HEART = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
export function digits(p, text, x0, y0, rp, lvl, k = 1) {
  [...String(text)].forEach((ch, n) => { for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (DIGITS[+ch][j * 3 + i] === '1') p.box(x0 + (n * 4 + i) * k, y0 + j * k, k, k, rp, lvl, 0); });
  return String(text).length * 4 * k - k;
}
