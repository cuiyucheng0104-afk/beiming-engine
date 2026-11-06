// px.js — 索引色像素引擎：320×180 帧缓冲存调色板索引，经查找表（index→RGB）输出，×6 最近邻放大。
export const W = 320, H = 180, SCALE = 6;
export const T = 255;   // 透明

// ENDESGA-32（0–31）+ 受保护 / 特殊索引（32+）
const HEX = [
  '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
  '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
  '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
  '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
  // 32–36 金（受保护：钥匙、宝箱金边、金光）
  '#fff3b0', '#fee761', '#feae34', '#d77643', '#ffffff',
  // 37–38 腮红（受保护；平时映射成木色，脸红时换成粉）
  '#f6757a', '#b55088',
  // 39 爱心粉（受保护）
  '#f6757a',
];
export const C = {
  rust: 0, clay: 1, sand: 2, tan: 3, brown: 4, dbrown: 5, umber: 6, crimson: 7, red: 8, orange: 9, amber: 10, yellow: 11,
  lime: 12, green: 13, dgreen: 14, teal: 15, navy: 16, blue: 17, cyan: 18, white: 19, silver: 20, steel: 21, slate: 22,
  dslate: 23, night: 24, ink: 25, hot: 26, plum: 27, rose: 28, pink: 29, skin: 30, skinS: 31,
  g0: 32, g1: 33, g2: 34, g3: 35, gw: 36, bl1: 37, bl2: 38, heart: 39,
};
export const NPAL = HEX.length;
export const PROTECT = new Set([32, 33, 34, 35, 36, 37, 38, 39]);
const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const RGB = HEX.map(rgb);
export const lum = ([r, g, b]) => .299 * r + .587 * g + .114 * b;
const pack = ([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r;
function lutFrom(fn) { const L = new Uint32Array(256); for (let i = 0; i < NPAL; i++) L[i] = pack(fn(i)); return L; }

// 亮度阶梯：每个索引沿自己的色阶上 / 下一步（光 = 索引步进）
const RAMPS = [
  [25, 24, 23, 22, 21, 20, 19], [6, 5, 4, 31, 3, 2, 19], [7, 8, 29, 30, 2], [0, 1, 9, 10, 11, 19],
  [15, 14, 13, 12, 11], [16, 17, 18, 19], [27, 28, 29, 30], [26, 29], [31, 30, 2],
];
export const LIGHT = new Uint8Array(256).map((_, i) => i), DARK = new Uint8Array(256).map((_, i) => i);
for (const r of RAMPS) for (let k = 0; k < r.length; k++) {
  if (k + 1 < r.length && LIGHT[r[k]] === r[k]) LIGHT[r[k]] = r[k + 1];
  if (k > 0 && DARK[r[k]] === r[k]) DARK[r[k]] = r[k - 1];
}
LIGHT[19] = 19; DARK[25] = 25;

export const LUT = {};
// 平时：腮红索引显示为宝箱木色
const BASE = i => i === C.bl1 ? RGB[C.brown] : i === C.bl2 ? RGB[C.dbrown] : RGB[i];
LUT.full = lutFrom(BASE);
// 脸红三步（调色板换色，不是叠透明）
LUT.blush1 = lutFrom(i => i === C.bl1 ? rgb('#c28569') : i === C.bl2 ? RGB[C.dbrown] : RGB[i]);
LUT.blush2 = lutFrom(i => i === C.bl1 ? rgb('#e8836c') : i === C.bl2 ? rgb('#a2525a') : RGB[i]);
LUT.blush = lutFrom(i => RGB[i]);
// 升级：金色洪流（按亮度映射到暖金阶，保护色不动）
const GOLD = ['#3e2731', '#733e39', '#b86f50', '#e4a672', '#feae34', '#fee761', '#fff3b0'];
LUT.gold = lutFrom(i => PROTECT.has(i) ? RGB[i] : rgb(GOLD[Math.min(6, Math.floor(Math.pow(lum(RGB[i]) / 255, .75) * 7.4))]));
// 升级波前沿：只用调色板里最亮的两级金 / 黄（不再按亮度落到橙棕）
LUT.goldHi = lutFrom(i => PROTECT.has(i) ? RGB[i] : rgb('#fff3b0'));
LUT.goldY = lutFrom(i => PROTECT.has(i) ? RGB[i] : (lum(RGB[i]) > 150 ? rgb('#fff3b0') : rgb('#fee761')));
// 升级后：全画面亮一步（腮红保持粉色）
LUT.light = lutFrom(i => PROTECT.has(i) ? RGB[i] : RGB[LIGHT[i]]);
// 白（漩涡溶白用）
export function whiten(L, q) {
  q = Math.round(q * 4) / 4; const O = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { const v = L[i]; if (!v) continue; const r = v & 255, g = v >> 8 & 255, b = v >> 16 & 255; O[i] = pack([r + (255 - r) * q | 0, g + (255 - g) * q | 0, b + (255 - b) * q | 0]); }
  return O;
}

// 4×4 Bayer
const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (B4[(((y % 4) + 4) % 4) * 4 + (((x % 4) + 4) % 4)] + .5) / 16;
export function hash(x, y = 0, z = 0) { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const eo = t => 1 - (1 - clamp(t, 0, 1)) ** 2;
export const eo3 = t => 1 - (1 - clamp(t, 0, 1)) ** 3;
export const eio = t => { t = clamp(t, 0, 1); return t < .5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); };
export const mod = (n, m) => ((n % m) + m) % m;

export class FB {
  constructor(w = W, h = H) { this.w = w; this.h = h; this.d = new Uint8Array(w * h); }
  clear(c = 0) { this.d.fill(c); }
  px(x, y, c) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h || c === T) return; this.d[y * this.w + x] = c; }
  get(x, y) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return T; return this.d[y * this.w + x]; }
  rect(x, y, w, h, c) { x = Math.round(x); y = Math.round(y); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  hline(x0, x1, y, c) { for (let x = Math.round(x0); x <= Math.round(x1); x++) this.px(x, y, c); }
  vline(x, y0, y1, c) { for (let y = Math.round(y0); y <= Math.round(y1); y++) this.px(x, y, c); }
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
    for (;;) { this.px(x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  }
  disc(cx, cy, r, c) { for (let y = Math.floor(-r); y <= r; y++) for (let x = Math.floor(-r); x <= r; x++) if (x * x + y * y <= r * r + r * .8) this.px(cx + x, cy + y, c); }
  gradV(x0, y0, w, h, cols) {
    const n = cols.length - 1;
    for (let y = 0; y < h; y++) { const v = y / Math.max(1, h - 1) * n, b = Math.min(n - 1, Math.floor(v)), f = v - b; for (let x = 0; x < w; x++) this.px(x0 + x, y0 + y, cols[bayer(x0 + x, y0 + y) < f ? b + 1 : b]); }
  }
  blit(src, dx, dy, flip = false, map = null) {
    dx = Math.round(dx); dy = Math.round(dy);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      let c = src.d[y * src.w + (flip ? src.w - 1 - x : x)]; if (c === T) continue;
      if (map) { c = map[c] ?? c; if (c === T) continue; }
      this.px(dx + x, dy + y, c);
    }
  }
  // 整数倍放大贴图：把 src 中以 (fx,fy) 为中心的区域放大 k 倍，(fx,fy) 落到本帧 (sx,sy)
  zoomFrom(src, k, fx, fy, sx, sy) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const X = Math.floor((x - sx) / k + fx), Y = Math.floor((y - sy) / k + fy);
      const c = src.get(X, Y); this.d[y * this.w + x] = c === T ? C.ink : c;
    }
  }
}
export function sprFromRows(rows, map) {
  const h = rows.length, w = Math.max(...rows.map(r => r.length)), d = new Uint8Array(w * h).fill(T);
  rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) { const ch = r[x]; if (ch === '.' || ch === ' ') continue; const c = map[ch]; if (c === undefined) throw new Error('sprite char ' + ch); d[y * w + x] = c; } });
  return { w, h, d };
}

// 输出：索引 → RGB（可逐像素选表）→ ×6 最近邻
export function makeOut(canvas) {
  const lo = document.createElement('canvas'); lo.width = W; lo.height = H;
  const g = lo.getContext('2d'); const img = g.createImageData(W, H); const u32 = new Uint32Array(img.data.buffer);
  const o = canvas.getContext('2d'); o.imageSmoothingEnabled = false;
  return {
    u32,
    present(fb, lut, pick = null) {
      const d = fb.d;
      if (!pick) for (let i = 0; i < d.length; i++) u32[i] = lut[d[i]];
      else for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) u32[i] = (pick(x, y) || lut)[d[i]];
    },
    show() { g.putImageData(img, 0, 0); o.drawImage(lo, 0, 0, W * SCALE, H * SCALE); },
  };
}
// RGB 级马赛克（以画面中心对齐）
export function mosaic(u32, n) {
  if (n <= 1) return; const src = u32.slice(); const ox = (W / 2) % n, oy = (H / 2) % n;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bx = Math.max(0, Math.floor((x - ox) / n) * n + ox), by = Math.max(0, Math.floor((y - oy) / n) * n + oy);
    u32[y * W + x] = src[Math.min(H - 1, by) * W + Math.min(W - 1, bx)];
  }
}
