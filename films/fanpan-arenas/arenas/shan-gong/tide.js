// 《珊瑚龙宫》· 自己的一套像素画法（不和别的擂台共用代码或素材，没有外部图片）。
// 思路：一张「胶片」(Cel) 上每个像素只记两样东西 —— 用哪条色带、亮到第几级（带小数）。
//   画的时候用球 (orb)、锥柱 (limb)、逐像素函数 (each / tint) 往上写；光一律从正上偏左打下来（水面漏下的天光）。
//   最后 bake()：把带小数的亮度按「斜纹」阈值量化到六级色带，描边用所在色带最暗的一级（彩色描边，不是纯黑）。
// 色带不是手填的：给一个本色，暗部把色相往蓝紫拧、压暗；亮部把色相往珍珠青白拧、提亮褪色 —— 水下的冷暗、暖亮就靠这个。
export const PPM = 48;                                                    // 每米 48 像素，和棋子一致
export const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;

// —— 确定性的随机：整数哈希 → [0, 1) ——
export function hx(x, y, s = 0) {
  let n = Math.imul((x | 0) + 0x7f4a7c15, 0x2c1b3c6d) ^ Math.imul((y | 0) ^ 0x51ed270b, 0x297a2d39) ^ Math.imul((s | 0) + 91, 0x632be5ab);
  n ^= n >>> 14; n = Math.imul(n, 0x45d9f3b); n ^= n >>> 16; n = Math.imul(n, 0x119de1f3); n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
// 一串随机数：R() 取 [0,1)，R.in(a,b) 取区间，R.pick(arr) 抽一个，R.int(a,b) 取整数（含两头）
export function dice(seed) {
  let i = 0; const f = () => hx(i++, seed, 5);
  f.in = (a, b) => a + (b - a) * f(); f.pick = arr => arr[Math.floor(f() * arr.length)]; f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  return f;
}
// —— 噪声：p 是周期（格数），给了就能无缝平铺 ——
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const wrap = (a, p) => p ? ((a % p) + p) % p : a;
export function wave(x, y, s = 0, p = 0) {                                 // 平滑值噪声
  const xi = Math.floor(x), yi = Math.floor(y), u = fade(x - xi), v = fade(y - yi);
  const a = hx(wrap(xi, p), wrap(yi, p), s), b = hx(wrap(xi + 1, p), wrap(yi, p), s), c = hx(wrap(xi, p), wrap(yi + 1, p), s), d = hx(wrap(xi + 1, p), wrap(yi + 1, p), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export const swell = (x, y, s = 0, p = 0) => wave(x, y, s, p) * .5 + wave(x * 2, y * 2, s + 7, p * 2) * .3 + wave(x * 4, y * 4, s + 13, p * 4) * .2;   // 三层叠起来的起伏
const CELL = [0, 0, 0];
export function cells(x, y, s = 0, p = 0) {                                // 碎片格（Worley）：返回 [最近距离, 次近距离, 这一片的随机号]；注意返回的是同一个数组
  const xi = Math.floor(x), yi = Math.floor(y); let a = 9, b = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, wx = wrap(cx, p), wy = wrap(cy, p), d = Math.hypot(x - cx - hx(wx, wy, s), y - cy - hx(wx, wy, s + 31));
    if (d < a) { b = a; a = d; id = hx(wx, wy, s + 77); } else if (d < b) b = d;
  }
  CELL[0] = a; CELL[1] = b; CELL[2] = id; return CELL;
}

// —— 色带 ——
const hex3 = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
function toHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * clamp(s), k = n => { const t = (n + h / 30) % 12; return l - c / 2 * Math.max(-1, Math.min(t - 3, 9 - t, 1)); };
  return [k(0), k(8), k(4)].map(v => Math.round(clamp(v) * 255));
}
const bend = (h, to, f) => (h + (((to - h + 540) % 360) - 180) * f + 360) % 360;   // 色相沿近的那一边往 to 拧 f 成
const STOPS = [-1, -.64, -.32, 0, .42, .82];
// 六级色带：0 最暗 … 3 本色 … 5 最亮。dk / lt：暗部、亮部往哪个色相拧；dkT / ltT：拧多少；pale：亮部褪色多少
export function ramp(hex, { dk = 250, lt = 176, dkT = .5, ltT = .34, pale = .4, deep = .85 } = {}) {
  const [h, s, l] = toHsl(hex3(hex));
  return STOPS.map(t => t < 0
    ? fromHsl(bend(h, dk, -t * dkT), s * (1 - t * .12), l * (1 + t * deep))
    : fromHsl(bend(h, lt, t * ltT), s * (1 - t * pale), l + (1 - l) * t * .8));
}
const LIST = [null];
export const K = {};                                                      // 色带名 → 编号（Cel 里每个像素记的就是这个编号）
const warm = { dk: 292, lt: 44, dkT: .42, ltT: .4, pale: .3 }, hot = { dk: 318, lt: 38, dkT: .34, ltT: .5, pale: .25 };
Object.entries({
  // 底：海床、礁石、宫殿石料（深青、群青，暗部偏蓝紫）
  sand: ['#2f6686', { lt: 168 }], reef: ['#2e3f78', { dk: 268 }], stone: ['#4a6aa2', { lt: 184, dk: 258 }], slab: ['#2a3566', { dk: 266, lt: 196 }], grout: ['#101440', { dk: 252 }],
  // 盘面螺钿：三种中性片 + 本方偏青两种 + 对面偏红两种，都压得很暗
  nA: ['#232f66', { lt: 190 }], nB: ['#31286c', { lt: 280, dk: 262 }], nC: ['#1b3f68', { lt: 172 }],
  oA: ['#0f5462', { lt: 160 }], oB: ['#16406c', { lt: 176 }], fA: ['#5c1f4a', { ...hot, lt: 350 }], fB: ['#4a2264', { dk: 270, lt: 330 }],
  // 亮色：珍珠白、珊瑚粉 / 橙 / 红、金
  pearl: ['#cfe0e6', { dk: 232, lt: 60, ltT: .2, pale: .7 }], pink: ['#f0588a', warm], orange: ['#ff7a34', hot], red: ['#e0283e', hot], gold: ['#f0aa28', hot], white: ['#dce6ee', { dk: 236 }],
  // 荧光：青、品红、紫、柠黄
  teal: ['#16cdb6', { dk: 226, lt: 150, pale: .55 }], cyan: ['#2ad8f0', { dk: 236, lt: 168, pale: .6 }], mag: ['#e23cc6', { dk: 276, lt: 320, pale: .5 }], violet: ['#8450de', { dk: 258, lt: 300 }], lemon: ['#f0d840', hot],
  // 活物与杂项
  kelp: ['#1c7a58', { dk: 222, lt: 96 }], weed: ['#2c5aa0', { dk: 258, lt: 170 }], shell: ['#2c8088', { dk: 240, lt: 150 }], nacre: ['#8cbccc', { dk: 262, lt: 330, ltT: .25, pale: .6 }],
  bone: ['#b08c98', { dk: 290, lt: 40, dkT: .3 }], clay: ['#a8584c', { dk: 300, lt: 36, dkT: .4 }], wood: ['#55405a', { dk: 262, lt: 30 }], iron: ['#34406a', { dk: 250, lt: 190 }], urchin: ['#3c2470', { dk: 262, lt: 300 }], turtle: ['#2c7c62', { dk: 226, lt: 90 }],
  // 剪影：前景压角用的墨蓝、远景用的淡蓝
  ink: ['#0c1a40', { dk: 252, lt: 200, deep: .7 }], far: ['#2c5c9c', { dk: 236, lt: 190, deep: .55 }],
}).forEach(([k, [h, o]]) => { K[k] = LIST.push(ramp(h, o)) - 1; });
export const rgbOf = (m, lv) => LIST[m][clamp(Math.round(lv), 0, 5)];       // 取某条色带某一级的颜色（给直接画 canvas 的地方用）
export const css = (m, lv, a = 1) => { const c = rgbOf(m, lv); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

// —— 胶片 ——
const LX = -.4, LY = -.74, LZ = .54;                                       // 光的方向（图上 y 朝下，所以 LY 为负 = 从上面来）
export class Cel {
  constructor(w, h) { this.w = w = Math.max(1, Math.round(w)); this.h = h = Math.max(1, Math.round(h)); this.m = new Uint8Array(w * h); this.v = new Float32Array(w * h); }
  put(x, y, m, v) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = y * this.w + x; this.m[i] = m; this.v[i] = v; }
  at(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.m[y * this.w + x]; }
  // 逐像素：fn(x, y) 返回 [色带, 亮度] 就落笔，返回空就跳过
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const r = fn(x, y); if (r) { const i = y * this.w + x; this.m[i] = r[0]; this.v[i] = r[1]; } } return this; }
  // 只改已经画过的像素：fn(x, y, 色带, 亮度) 返回 [色带, 亮度]；返回 0 就擦掉
  tint(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const i = y * this.w + x; if (!this.m[i]) continue; const r = fn(x, y, this.m[i], this.v[i]); if (r === 0) this.m[i] = 0; else if (r) { this.m[i] = r[0]; this.v[i] = r[1]; } } return this; }
  // 一颗球（椭球）：按球面法线算明暗。lo / hi：背光、受光的亮度；grain：表面的颗粒
  orb(cx, cy, rx, ry, m, { lo = .7, hi = 4.7, grain = 0, s = 0 } = {}) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const nx = (x + .5 - cx) / rx, ny = (y + .5 - cy) / ry, q = nx * nx + ny * ny; if (q >= 1) continue;
      this.put(x, y, m, lo + (hi - lo) * Math.max(0, nx * LX + ny * LY + Math.sqrt(1 - q) * LZ) + (grain ? (hx(x, y, s) - .5) * grain : 0));
    }
    return this;
  }
  // 一段锥柱（两头半径不同的胶囊）：按圆柱面算明暗。枝、茎、触手、骨头都用它
  limb(ax, ay, bx, by, ra, rb, m, { lo = .8, hi = 4.5 } = {}) {
    const R = Math.max(ra, rb) + 1, vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
    for (let y = Math.floor(Math.min(ay, by) - R); y <= Math.max(ay, by) + R; y++) for (let x = Math.floor(Math.min(ax, bx) - R); x <= Math.max(ax, bx) + R; x++) {
      const t = clamp(((x + .5 - ax) * vx + (y + .5 - ay) * vy) / L2), r = Math.max(.5, ra + (rb - ra) * t), nx = (x + .5 - ax - vx * t) / r, ny = (y + .5 - ay - vy * t) / r, q = nx * nx + ny * ny;
      if (q >= 1) continue;
      this.put(x, y, m, lo + (hi - lo) * Math.max(0, nx * LX + ny * LY + Math.sqrt(1 - q) * LZ));
    }
    return this;
  }
  // 描边：透明像素只要挨着画过的像素，就用那个像素所在色带的最暗一级补上（lv 可以指定级数）
  rim(lv = 0) {
    const { w, h, m } = this, add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (m[y * w + x]) continue; const n = this.at(x - 1, y) || this.at(x + 1, y) || this.at(x, y - 1) || this.at(x, y + 1); if (n) add.push(y * w + x, n); }
    for (let i = 0; i < add.length; i += 2) { m[add[i]] = add[i + 1]; this.v[add[i]] = lv; }
    return this;
  }
  // 量化成画布。斜纹阈值：小数部分落在 .3–.7 之间时按 (x + y) 的斜线交替取上下两级，别处直接取整 —— 抖动只出现在两级交界的一窄条上
  bake() {
    const { w, h } = this, c = mk(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      if (!this.m[i]) continue;
      const v = this.v[i], f = Math.floor(v), col = LIST[this.m[i]][clamp(f + (v - f > .3 + ((x + y) % 3) * .2 ? 1 : 0), 0, 5)];
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  }
}
// 软边透明图（光晕、光柱、微粒）：白色，透明度 = fn(u, v)。不是像素画，是给加色叠层用的
export function mist(w, h, fn) {
  const c = mk(w, h), g = c.getContext('2d'), img = g.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(255 * clamp(fn((x + .5) / w, (y + .5) / h))); }
  g.putImageData(img, 0, 0); return c;
}
