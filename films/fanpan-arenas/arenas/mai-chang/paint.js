// 《丰收麦场》的像素画法（这个文件夹自己的一套，不和别的擂台共用任何代码或素材）。
// 思路：
//   · 暮色色带 dusk()：只给一个本色，在 HSL 里自动出 7 级——往暗处色相转向靛蓝、往亮处转向暖黄。
//     所以每种材料的暗部都带夜色、亮部都带灯火色，整个场景的冷暖关系是色带里自带的。
//   · Sheet：一张像素画布。级数可以带小数，两级之间用「斜纹」抖动（每 5 个像素一条斜线，像木刻的排线）。
//   · 背光金边 rim()：主光从后方来，所以每个小件画完后，把「上面是空的」那一圈像素提亮——剪影顶上一道金边。
// 只在浏览器里跑（用 document 的 canvas），没有外部图片。
export const PPM = 48;                                             // 每米多少像素，和棋子的像素密度一致

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l];
}
function unhsl(h, s, l) {
  s = clamp(s, 0, 1); l = clamp(l, 0, 1); const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const turn = (h, to, k) => h + (((to - h + 540) % 360) - 180) * k;   // 色相沿最短的弧往 to 转 k 成
// 暮色色带：7 级，中间一级（3）是本色。deep 暗部压多深，lift 亮部提多高，cool / warm 暗亮两头各往哪个色相偏
export function dusk(hex, { cool = 250, warm = 42, deep = .84, lift = .7, n = 7 } = {}) {
  const [h, s, l] = hsl(rgb(hex)), mid = (n - 1) / 2, out = [];
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / mid;
    out.push(t < 0 ? unhsl(turn(h, cool, -t * .46), s * (1 - t * .12), l * (1 + t * deep)) : unhsl(turn(h, warm, t * .4), s * (1 - t * .22), l + (.93 - l) * t * lift));
  }
  return out;
}
// 全场的颜色都从这里出：麦金、南瓜橙、枫红是主调，靛蓝和紫压暗部，青只留给水和本方
export const C = {
  wheat: dusk('#dca02c'), straw: dusk('#cfae54'), hay: dusk('#b98826'), husk: dusk('#e8d48c'),
  pumpkin: dusk('#f0761a', { warm: 48 }), mapleR: dusk('#d8301e'), mapleO: dusk('#f0841c'), mapleY: dusk('#f2bc2a'),
  leaf: dusk('#4c8a2e', { warm: 70 }), olive: dusk('#8a8632', { warm: 56 }), moss: dusk('#6e9a34', { warm: 64 }),
  wood: dusk('#8c5630'), old: dusk('#746058'), dark: dusk('#4c3028'), bark: dusk('#5e4038'),
  barn: dusk('#b62a22', { warm: 28 }), cream: dusk('#e6d8b6'), plaster: dusk('#cfc4a6'),
  stone: dusk('#6c6c8a'), warmStone: dusk('#8c7a6a'), flag: dusk('#6a6480', { deep: .8 }), flagOwn: dusk('#3f7480', { deep: .8 }), flagFoe: dusk('#8c4c5a', { deep: .8 }),
  soil: dusk('#5e3e2c'), dirt: dusk('#80603c'),
  teal: dusk('#10bca8', { cool: 215 }), tealRoof: dusk('#1e828c', { cool: 235 }), red: dusk('#ea3c3a', { warm: 30 }), redRoof: dusk('#7c2c2c'),
  water: dusk('#2a92a8', { cool: 240, warm: 170 }), iron: dusk('#4c4c60'), night: dusk('#2c2c62'),
  fire: dusk('#ff8e1e', { cool: 8, warm: 56, deep: .6 }), glow: dusk('#ffd06a', { cool: 24, warm: 56, deep: .5 }),
  apple: dusk('#e02a2a'), bread: dusk('#c88c42'), purple: dusk('#8c4cb4'), paper: dusk('#f2a23a', { cool: 10, warm: 54, deep: .55 }),
  white: dusk('#f4f0e0'), sky: dusk('#3a2c74', { cool: 245, warm: 20, deep: .7, lift: .5 }),
};

// —— 确定性的随机与噪声 ——
export function rnd2(x, y, s = 0) {
  let n = (Math.imul(x | 0, 0x1f123bb5) + Math.imul(y | 0, 0x5f356495) + Math.imul((s | 0) + 91, 0x2545f491)) | 0;
  n = Math.imul(n ^ (n >>> 14), 0x45d9f3b); n = Math.imul(n ^ (n >>> 15), 0x119de1f3);
  return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
}
export function seq(seed) { let i = 0; return () => rnd2(i++, seed, 313); }      // 一串随机数
const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
// 平滑值噪声；给了周期 (px, py) 就能无缝平铺
export function vn(x, y, s = 0, px = 0, py = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), u = ease(x - xi), v = ease(y - yi);
  const g = (i, j) => rnd2(px ? ((i % px) + px) % px : i, py ? ((j % py) + py) % py : j, s);
  return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
}
// 几层叠起来的云纹噪声（0..1）
export function cloud(x, y, s = 0, oct = 3, px = 0, py = 0) {
  let v = 0, a = .5, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) { v += a * vn(x * f, y * f, s + i * 29, px * f, py * f); sum += a; a *= .5; f *= 2; }
  return v / sum;
}
// 碎石格：把平面分成 gw × gh 像素一格的抖动格点，返回 [到最近格点的距离, 到第二近的距离差, 石头编号, 朝石心的方向 x, y]（nx × ny 格一个周期）
const CELL = [0, 0, 0, 0, 0];
export function cells(x, y, gw, gh, nx, ny, s = 0) {
  const cx = Math.floor(x / gw), cy = Math.floor(y / gh); let d1 = 1e9, d2 = 1e9, id = 0, ox = 0, oy = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const a = cx + i, b = cy + j, wa = ((a % nx) + nx) % nx, wb = ((b % ny) + ny) % ny;
    const px = (a + .5 + (rnd2(wa, wb, s) - .5) * .8) * gw, py = (b + .5 + (rnd2(wa, wb, s + 1) - .5) * .8) * gh, dx = (x - px) / gw, dy = (y - py) / gh, d = dx * dx + dy * dy;
    if (d < d1) { d2 = d1; d1 = d; id = wa + wb * nx; ox = dx; oy = dy; } else if (d < d2) d2 = d;
  }
  CELL[0] = Math.sqrt(d1); CELL[1] = Math.sqrt(d2) - Math.sqrt(d1); CELL[2] = id; CELL[3] = ox; CELL[4] = oy; return CELL;
}

export class Sheet {
  constructor(w, h) { this.w = Math.round(w); this.h = Math.round(h); this.d = new Uint8ClampedArray(this.w * this.h * 4); }
  // 落一个点。lv 的小数部分 < .3 取下一级、> .7 取上一级，中间用斜纹决定
  px(x, y, bd, lv, a = 255) {
    x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    const f = Math.floor(lv), k = lv - f, c = bd[clamp(k > .3 + .4 * (((x + y * 2) % 5) + .5) / 5 ? f + 1 : f, 0, bd.length - 1)], i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a; return this;
  }
  has(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  cut(x, y) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[(Math.round(y) * this.w + Math.round(x)) * 4 + 3] = 0; return this; }
  // 整幅逐点：fn(x, y) → [色带, 级数]，返回空就不动这一点
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const r = fn(x, y); if (r) this.px(x, y, r[0], r[1]); } return this; }
  // 矩形。lv 是数，或者 (u, v, x, y) → 级数（u、v 是 0..1 的相对位置）
  box(x0, y0, w, h, bd, lv) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.px(x0 + x, y0 + y, bd, typeof lv === 'function' ? lv(w > 1 ? x / (w - 1) : 0, h > 1 ? y / (h - 1) : 0, x, y) : lv);
    return this;
  }
  // 圆鼓鼓的椭圆：左上受光，右下背光，gain 是明暗跨几级
  orb(cx, cy, rx, ry, bd, base, gain = 2.2) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry, q = nx * nx + ny * ny; if (q > 1) continue;
      this.px(x, y, bd, base + gain * (-.42 * nx - .66 * ny + .4 * Math.sqrt(1 - q) - .3));
    }
    return this;
  }
  // 凸或凹多边形（扫描线填充）。pts = [x0, y0, x1, y1, …]；lv 是数或 (x, y) → 级数
  poly(pts, bd, lv) {
    let y0 = 1e9, y1 = -1e9; for (let i = 1; i < pts.length; i += 2) { y0 = Math.min(y0, pts[i]); y1 = Math.max(y1, pts[i]); }
    for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
      const xs = [];
      for (let i = 0, n = pts.length / 2; i < n; i++) { const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1]; if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (bx - ax) * (y - ay) / (by - ay)); }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - .01); x <= Math.floor(xs[k + 1] + .01); x++) this.px(x, y, bd, typeof lv === 'function' ? lv(x, y) : lv);
    }
    return this;
  }
  // 线。lv 是数或 (k) → 级数，k 是沿线 0..1
  line(x0, y0, x1, y1, bd, lv, thick = 1) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n, l = typeof lv === 'function' ? lv(i / n) : lv; for (let a = 0; a < thick; a++) for (let b = 0; b < thick; b++) this.px(x + a, y + b, bd, l); }
    return this;
  }
  // 描边：挨着不透明点的透明点涂成 bd 的第 lv 级（一般是最暗的靛蓝）
  ink(bd = C.night, lv = 0) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.has(x, y) && (this.has(x - 1, y) || this.has(x + 1, y) || this.has(x, y - 1) || this.has(x, y + 1))) add.push(x, y);
    for (let i = 0; i < add.length; i += 2) this.px(add[i], add[i + 1], bd, lv);
    return this;
  }
  // 背光金边：上面是空的不透明点，按几率换成 bd 的第 lv 级。主光在后上方，剪影顶上亮一道
  rim(bd = C.glow, lv = 4, chance = 1, seed = 1) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.has(x, y) && !this.has(x, y - 1) && rnd2(x, y, seed) < chance) add.push(x, y);
    for (let i = 0; i < add.length; i += 2) this.px(add[i], add[i + 1], bd, lv);
    return this;
  }
  // 把另一张画布贴上来（透明的地方不盖），可以左右翻
  stamp(p, x0, y0, flip = false) {
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + (flip ? p.w - 1 - x : x)) * 4; if (!p.d[i + 3]) continue; const X = Math.round(x0 + x), Y = Math.round(y0 + y); if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
      const j = (Y * this.w + X) * 4; this.d[j] = p.d[i]; this.d[j + 1] = p.d[i + 1]; this.d[j + 2] = p.d[i + 2]; this.d[j + 3] = p.d[i + 3];
    }
    return this;
  }
  canvas() { const c = document.createElement('canvas'); c.width = this.w; c.height = this.h; c.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0); return c; }
}
// 软的光斑一类（光晕、烟团、地上的灯影）：fn(u, v) → [r, g, b, a]，都是 0..1，u、v 以中心为 0、边为 ±1
export function soft(n, fn) {
  const c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d'), im = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const r = fn((x + .5) / n * 2 - 1, (y + .5) / n * 2 - 1), i = (y * n + x) * 4; im.data[i] = r[0] * 255; im.data[i + 1] = r[1] * 255; im.data[i + 2] = r[2] * 255; im.data[i + 3] = clamp(r[3], 0, 1) * 255; }
  g.putImageData(im, 0, 0); return c;
}
