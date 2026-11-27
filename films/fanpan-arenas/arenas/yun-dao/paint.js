// 《云上浮岛》的像素画小库：定噪、冷暖色阶（朝阳面偏金、背阴面偏蓝）、有序抖动、按高度场做浮雕着色。
// 这个文件只管“怎么上色”，不认识任何具体的东西；贴图在 tex.js，小件在 props.js。

export const PPM = 48;                       // 每米 48 像素，和棋子一致
export const INK = [26, 32, 66];             // 描边用的墨色：深蓝紫，白天场景里比纯黑柔和

// —— 定噪：同样的输入永远得到同样的数，场景每次打开都一样 ——
export function hash(i, k = 0) {
  let n = (Math.imul(i | 0, 374761393) + Math.imul(k | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export const hash2 = (x, y, k = 0) => hash(Math.imul(x | 0, 7919) + Math.imul(y | 0, 104729), k);
// 值噪声：px / py 不为 0 时按这个周期首尾相接（给能平铺的贴图用）
export function vnoise(x, y, k = 0, px = 0, py = px) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const wx = px ? v => ((v % px) + px) % px : v => v, wy = py ? v => ((v % py) + py) % py : v => v;
  const a = hash2(wx(xi), wy(yi), k), b = hash2(wx(xi + 1), wy(yi), k), c = hash2(wx(xi), wy(yi + 1), k), d = hash2(wx(xi + 1), wy(yi + 1), k);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// 叠三层的值噪声，结果大致在 0..1
export const fbm = (x, y, k = 0, px = 0, py = px) => vnoise(x, y, k, px, py) * .55 + vnoise(x * 2, y * 2, k + 7, px * 2, py * 2) * .3 + vnoise(x * 4, y * 4, k + 13, px * 4, py * 4) * .15;
// 蜂窝噪声：到最近一颗种子的距离（0 在种子上，约 1 在格子边上），用来堆云头、卵石
export function cell(x, y, k = 0, px = 0, py = px) {
  const xi = Math.floor(x), yi = Math.floor(y); let m = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const cx = xi + i, cy = yi + j, wx = px ? ((cx % px) + px) % px : cx, wy = py ? ((cy % py) + py) % py : cy, dx = cx + hash2(wx, wy, k) - x, dy = cy + hash2(wx, wy, k + 1) - y, d = dx * dx + dy * dy; if (d < m) m = d; }
  return Math.sqrt(m);
}

// —— 颜色 ——
export const rgb = h => { if (typeof h !== 'string') return h; const n = parseInt(h.slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; };
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const SHADE = rgb('#1f2c74'), GLINT = rgb('#fff0b0');   // 影子往这种蓝里掉，亮面往这种金里走
// 冷暖调子：t = -1 最深的影子，0 原色，+1 朝阳的亮边
export function tone(base, t) {
  const c = rgb(base);
  if (t >= 0) { const m = mix(c, GLINT, t * .5), k = 1 + t * .25; return [Math.min(255, m[0] * k), Math.min(255, m[1] * k), Math.min(255, m[2] * k)]; }
  const k = -t, d = mix(c, SHADE, k * .52), s = 1 - k * .36; return [d[0] * s, d[1] * s, d[2] * s];
}
// 一条色阶：从影子到亮边 n 级
export const ramp = (base, n = 5, lo = -1, hi = 1) => Array.from({ length: n }, (_, i) => tone(base, lo + (hi - lo) * i / (n - 1)));

// —— 有序抖动：4×4 的拜耳阵 ——
const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (B4[(y & 3) * 4 + (x & 3)] + .5) / 16;
// 在色阶里取一级：t 是 0..1，级与级之间用抖动过渡（soft 越大过渡带越宽）
export function pick(rp, t, x, y, soft = .7) {
  const f = Math.max(0, Math.min(.9999, t)) * (rp.length - 1), i = Math.floor(f), fr = f - i;
  return rp[Math.min(rp.length - 1, i + (fr > .5 + (bayer(x, y) - .5) * soft ? 1 : 0))];
}

// —— 高度场的零件：球、几个取最高 ——
export const ball = (cx, cy, rx, ry = rx, h = 1) => (x, y) => { const u = (x + .5 - cx) / rx, v = (y + .5 - cy) / ry, d = 1 - u * u - v * v; return d > 0 ? Math.sqrt(d) * h * Math.min(rx, ry) : 0; };
export const heap = fs => (x, y) => { let m = 0; for (const f of fs) { const z = f(x, y); if (z > m) m = z; } return m; };

// —— 一张像素图：直接在 RGBA 数组上画，最后转成 canvas ——
export class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  set(x, y, c, a = 255) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this; const i = (y * this.w + x) * 4, d = this.d; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a; return this; }
  has(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  get(x, y) { const i = (y * this.w + x) * 4, d = this.d; return [d[i], d[i + 1], d[i + 2]]; }
  clear(x, y) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[(Math.floor(y) * this.w + Math.floor(x)) * 4 + 3] = 0; return this; }
  rect(x, y, w, h, c, a = 255) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a); return this; }
  // 一块带明暗的板：左、上一圈亮，右、下一圈暗（朝阳面在左上）
  slab(x, y, w, h, base, lift = .45, drop = .55) { this.rect(x, y, w, h, rgb(base)); const hi = tone(base, lift), lo = tone(base, -drop); for (let i = 0; i < w; i++) { this.set(x + i, y, hi); this.set(x + i, y + h - 1, lo); } for (let j = 0; j < h; j++) { this.set(x, y + j, hi); this.set(x + w - 1, y + j, lo); } return this; }
  line(x0, y0, x1, y1, c) { x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1); const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy; for (let n = 0; n < 4096; n++) { this.set(x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } } return this; }
  disc(cx, cy, r, c) { for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r) this.set(x, y, c); return this; }
  // 凸多边形填色（顺、逆时针都行）
  poly(pts, c) {
    let y0 = Infinity, y1 = -Infinity; for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) { let a = Infinity, b = -Infinity;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length], yy = y + .5; if ((p[1] <= yy && q[1] > yy) || (q[1] <= yy && p[1] > yy)) { const x = p[0] + (yy - p[1]) / (q[1] - p[1]) * (q[0] - p[0]); a = Math.min(a, x); b = Math.max(b, x); } }
      for (let x = Math.round(a); x < Math.round(b); x++) this.set(x, y, c); }
    return this;
  }
  // 浮雕着色：hf(x, y) 给出高度（<= 0 是空），按“光从左上来”在色阶里取色；轮廓的左上自然亮、右下自然暗
  relief(hf, rp, o = {}) {
    const { x0 = 0, y0 = 0, x1 = this.w, y1 = this.h } = o, w = x1 - x0 + 2, h = y1 - y0 + 2, H = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) H[j * w + i] = hf(x0 + i - 1, y0 + j - 1);
    return this.emboss(H, w, rp, { ...o, x0, y0, pad: 1 });
  }
  // 同上，但高度已经算在数组里了（wrap：左右上下首尾相接；shade(x, y) 可以再给每个像素加减一点明暗）
  emboss(H, w, rp, o = {}) {
    const { x0 = 0, y0 = 0, k = 1.3, soft = .7, grit = 0, seed = 0, wrap = false, bias = 0, pad = 0, shade = null } = o, h = H.length / w;
    const at = wrap ? (i, j) => H[((j + h) % h) * w + (i + w) % w] : (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : H[j * w + i]);
    for (let j = pad; j < h - pad; j++) for (let i = pad; i < w - pad; i++) { const z = H[j * w + i]; if (z <= 0) continue;
      const dx = at(i + 1, j) - at(i - 1, j), dy = at(i, j + 1) - at(i, j - 1), l = 1 / Math.hypot(dx, dy, k), x = x0 + i - pad, y = y0 + j - pad;
      let t = .5 + .56 * (dx * .64 + dy * .62 + k * .45) * l - .25 + bias; if (grit) t += (hash2(x, y, seed) - .5) * grit; if (shade) t += shade(x, y);
      this.set(x, y, pick(rp, t, x, y, soft)); }
    return this;
  }
  // 给不透明的部分外面描一圈
  outline(c = INK, a = 255) { const add = []; for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.has(x, y) && (this.has(x - 1, y) || this.has(x + 1, y) || this.has(x, y - 1) || this.has(x, y + 1))) add.push(x, y); for (let i = 0; i < add.length; i += 2) this.set(add[i], add[i + 1], c, a); return this; }
  // 朝阳的金边：不透明的像素里，左边或上边是空的那些，染亮
  rim(c, amt = .6) { const g = rgb(c), hit = []; for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.has(x, y) && (!this.has(x - 1, y) || !this.has(x, y - 1))) hit.push(x, y); for (let i = 0; i < hit.length; i += 2) this.set(hit[i], hit[i + 1], mix(this.get(hit[i], hit[i + 1]), g, amt)); return this; }
  // 在不透明的地方随机撒点
  speck(n, c, seed = 0, a = 255) { for (let i = 0; i < n; i++) { const x = Math.floor(hash(i, seed) * this.w), y = Math.floor(hash(i, seed + 1) * this.h); if (this.has(x, y)) this.set(x, y, c, a); } return this; }
  // 逐像素改色：fn(x, y, [r, g, b]) 返回新颜色或 null（不动）
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.has(x, y)) { const c = fn(x, y, this.get(x, y)); if (c) this.set(x, y, c); } return this; }
  blit(src, x, y, flip = false) { for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) { const k = (j * src.w + (flip ? src.w - 1 - i : i)) * 4; if (src.d[k + 3] > 0) this.set(x + i, y + j, [src.d[k], src.d[k + 1], src.d[k + 2]], src.d[k + 3]); } return this; }
  canvas() { const c = document.createElement('canvas'); c.width = this.w; c.height = this.h; const g = c.getContext('2d'), im = g.createImageData(this.w, this.h); im.data.set(this.d); g.putImageData(im, 0, 0); return c; }
}
