// 《沉水擂台》B 版 · 自己的像素画法（不与 C 版共用任何代码或素材）。
// 画法：每张图先写「每个像素有多高、用哪一组颜色」，再按左上方来光算明暗，量化成六级色阶，半级用 2×2 棋盘抖动。
// 色阶不是手填的：给一个本色，暗部往深紫拉、亮部往暖金拉（参考图的暗部偏品红紫、高光偏金）。
// 只在浏览器里跑，依赖 document 的 canvas；没有外部图片。
export const PPM = 48;                                                   // 场景贴图密度：每米 48 像素

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// 六级色阶：0 最暗 … 3 本色 … 5 最亮
export function tones(base, { dark = '#210a36', light = '#ffe8a6' } = {}) {
  const b = rgb(base), d = rgb(dark), l = rgb(light);
  return [mix(b, d, .88), mix(b, d, .64), mix(b, d, .34), b, mix(b, l, .36), mix(b, l, .7)];
}
export const INK = {
  rust: tones('#a85a38'), mauve: tones('#84586c', { dark: '#1a0830', light: '#ffd8a0' }), night2: tones('#4a3058', { dark: '#0c0418', light: '#c8a0d8' }), sand: tones('#c89250'), clay: tones('#8a3f34'),
  slate: tones('#3e3e7c', { dark: '#120a2c', light: '#c4ceff' }),
  slateOwn: tones('#3c6c98', { dark: '#0c1030', light: '#bff4ff' }),
  slateFoe: tones('#6a3058', { dark: '#1c0624', light: '#ffc8b0' }),
  night: tones('#2c1a44', { dark: '#0a0314', light: '#8a78c8' }),
  moss: tones('#7aa62c', { light: '#f6ff8c' }), pad: tones('#3cb43c', { light: '#ecff7c' }),
  leaf: tones('#2c8c50', { light: '#d8ff80' }), fern: tones('#58a030', { light: '#fff08a' }),
  wood: tones('#92502c'), plank: tones('#b06c34'), bark: tones('#6c3c30'),
  lacquer: tones('#cc2a20', { light: '#ffb878' }), ice: tones('#54c4e0', { dark: '#141c50', light: '#f4ffff' }),
  gold: tones('#eaa820', { light: '#fff8c0' }), bone: tones('#dccca4', { light: '#fffbe6' }),
  water: tones('#3a2c70', { dark: '#0c0422', light: '#70e4d4' }),
  petal: tones('#f068a8', { light: '#fff2e4' }), koi: tones('#ff7a20', { light: '#fff4d0' }),
  teal: tones('#14ccb4', { dark: '#06243c', light: '#e8fff8' }), red: tones('#f23c3c', { dark: '#30061c', light: '#ffe0a0' }),
  paper: tones('#f6dca4', { light: '#ffffee' }), rope: tones('#c09c58'), fire: tones('#ff8a1c', { dark: '#a01c10', light: '#fff8b0' }),
  frost: tones('#a8e8f8', { dark: '#1c4c8c', light: '#ffffff' }),
};

// —— 确定性的随机与噪声 ——
export function h2(x, y, s = 0) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((s | 0) + 1013, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b); n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
export function rng(seed) { let i = 0; return () => h2(i++, seed, 77); }
const ease = t => t * t * (3 - 2 * t);
// 平滑值噪声；给了周期 (px, py) 就能无缝平铺
export function vn(x, y, s = 0, px = 0, py = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), u = ease(x - xi), v = ease(y - yi);
  const w = (a, p) => p ? ((a % p) + p) % p : a;
  const g = (a, b) => h2(w(a, px), w(b, py), s);
  return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
}
export const fbm = (x, y, s = 0) => vn(x, y, s) * .56 + vn(x * 2.1, y * 2.1, s + 1) * .29 + vn(x * 4.3, y * 4.3, s + 2) * .15;

// —— 浮雕着色 ——
// fn(x, y) → null（透明）或 { z 高度（像素）, ink 色阶, add 明暗偏移, lv 直接给明度（不算浮雕） }
// 选项：wrap 无缝平铺；rim 给透明图描一圈深色边（传色阶）；base 基准明度；k 浮雕强度；edge 边缘外侧当作多低
export function relief(w, h, fn, { wrap = false, rim = null, base = 2.7, k = 1.1, edge = 1.8 } = {}) {
  const N = w * h, Z = new Float32Array(N), A = new Float32Array(N), L = new Float32Array(N).fill(-9), I = new Array(N), O = new Uint8Array(N);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const p = fn(x, y); if (!p) continue;
    O[i] = 1; Z[i] = p.z ?? 0; A[i] = p.add ?? 0; I[i] = p.ink; if (p.lv !== undefined) L[i] = p.lv;
  }
  const zAt = (x, y, z0) => {
    if (wrap) return Z[((y + h) % h) * w + (x + w) % w];
    if (x < 0 || y < 0 || x >= w || y >= h || !O[y * w + x]) return z0 - edge;
    return Z[y * w + x];
  };
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (!O[i]) continue;
    const z = Z[i];
    let lv = L[i] > -9 ? L[i] : base + A[i] + k * (zAt(x + 1, y + 1, z) - zAt(x - 1, y - 1, z)) * .5;
    const f = Math.floor(lv), q = Math.max(0, Math.min(5, f + (lv - f > (((x ^ y) & 1) ? .7 : .3) ? 1 : 0)));
    const col = I[i][q]; d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
  }
  if (rim) for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (O[i]) continue;
    const near = (x > 0 && O[i - 1]) || (x < w - 1 && O[i + 1]) || (y > 0 && O[i - w]) || (y < h - 1 && O[i + w]);
    if (near) { const col = rim[0]; d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255; }
  }
  g.putImageData(img, 0, 0); c.px = d;
  return c;
}

// —— 常用形状（返回 0…1 的鼓起高度，形状外返回 -1）——
export const dome = (x, y, cx, cy, rx, ry) => { const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; return q >= 1 ? -1 : Math.sqrt(1 - q); };
export const seg = (x, y, ax, ay, bx, by) => {                            // 点到线段的距离
  const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x - ax - vx * t, y - ay - vy * t);
};
// 3×5 点阵数字
const FONT = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111' };
export function glyphAt(text, x, y, x0, y0, k = 2) {                      // (x, y) 是否落在 text 的笔画上
  const u = Math.floor((x - x0) / k), v = Math.floor((y - y0) / k); if (x < x0 || y < y0 || v > 4) return false;
  const n = Math.floor(u / 4), cu = u % 4; if (n >= text.length || cu > 2) return false;
  return FONT[text[n]][v * 3 + cu] === '1';
}
export const textWidth = (text, k = 2) => (text.length * 4 - 1) * k;
// 透明度渐变图（光晕、光柱、水汽）：不是像素画，是给半透明叠层用的软边
export function soft(w, h, fn, tint = [255, 255, 255]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    img.data[i] = tint[0]; img.data[i + 1] = tint[1]; img.data[i + 2] = tint[2];
    img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, fn(x / (w - 1), y / (h - 1)))));
  }
  g.putImageData(img, 0, 0); return c;
}
