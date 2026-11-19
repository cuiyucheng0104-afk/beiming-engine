// 《彩窗圣堂》的画法库（只给这个文件夹用，不和别的擂台共用）。
// 画法是「距离场 + 镶嵌格」：
//   · 每个形体先写成一个距离函数（点到边缘有多远，里面为负），上色时顺手算出边缘朝哪边，
//     朝光的斜边亮、背光的斜边暗，像金工的錾边、石头的倒角；
//   · 彩窗、马赛克、地砖这类「一格一格」的东西用格子编号上色，格子之间留铅条 / 勾缝；
//   · 颜色一律走七级色阶：给一个本色，暗部往冷紫转、亮部往暖黄转；两级之间用斜纹抖动（像版画的排线）。
// 全部逐像素算，不用任何外部图片。只有 Plate.canvas() 和 soft() 用到浏览器的 canvas。
export const PPM = 48;                                   // 每米 48 像素，和棋子的像素密度一致

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const rgbOf = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function toHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return [0, 0, l];
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
}
function fromHSL(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const swing = (h, to, k) => (h + (((to - h + 540) % 360) - 180) * k + 360) % 360;   // 色相沿近的那一边往 to 转 k 成

// 七级色阶：0 最暗 … 3 本色 … 6 最亮。cool / warm：暗部、亮部各往哪个色相偏；deep：最暗一级留多少亮度；peak：最亮一级的亮度
export function ramp(base, { cool = 262, warm = 44, deep = .13, peak = null, n = 7 } = {}) {
  const [h, s, l] = toHSL(...rgbOf(base)), mid = (n - 1) / 2, top = peak ?? clamp(l * 1.9 + .12, 0, .95), out = [];
  for (let i = 0; i < n; i++) {
    const k = (i - mid) / mid, a = Math.abs(k);
    if (k <= 0) out.push(fromHSL(s < .08 ? cool : swing(h, cool, a * .42), clamp(Math.max(s * (1 + .2 * a), .24 * a), 0, 1), l + (l * deep - l) * a ** .9));
    else out.push(fromHSL(s < .08 ? warm : swing(h, warm, a * .3), Math.max(s * (1 - .5 * a), .12 * a), l + (top - l) * a ** 1.25));
  }
  return out;
}

// 这座圣堂用到的全部颜色
export const C = {
  // 石头：偏紫的冷灰大理石
  marble: ramp('#8f88ae'), marbleDk: ramp('#5d5682'), stone: ramp('#7a7399'), stoneDk: ramp('#4b4569'), basalt: ramp('#332d4b', { peak: .5 }), pale: ramp('#a5a6c9', { warm: 200 }),
  slate: ramp('#37325a', { peak: .52 }), slateB: ramp('#2f2b50', { peak: .5 }), night: ramp('#221d3c', { peak: .4 }),
  ownTile: ramp('#1b4f70', { peak: .55, warm: 180 }), foeTile: ramp('#6c1c38', { peak: .55 }),
  // 金属
  gold: ramp('#e2a21e', { cool: 12, peak: .9 }), brass: ramp('#9c7430', { cool: 300, peak: .7 }), iron: ramp('#2b2540', { peak: .46 }), silver: ramp('#a9b9da', { warm: 190 }),
  // 布、木、蜡、纸
  crimson: ramp('#b01a32', { cool: 300 }), wine: ramp('#6e1030', { cool: 290, peak: .6 }), royal: ramp('#1c58b8', { warm: 185 }), tealCloth: ramp('#0a8c98', { warm: 165 }),
  oak: ramp('#6c3e2e', { cool: 300 }), oakDk: ramp('#40242c', { cool: 285, peak: .55 }), linen: ramp('#d9d2c6'), wax: ramp('#eadcae'), parchment: ramp('#d6c69c'),
  // 彩窗的宝石色
  ruby: ramp('#ff2448', { cool: 330 }), sapphire: ramp('#2a62ff', { warm: 190 }), emerald: ramp('#12c868', { warm: 80 }), amber: ramp('#ffaa18', { cool: 10 }),
  amethyst: ramp('#9a3cf0', { warm: 320 }), cyan: ramp('#20d0f0', { warm: 170 }), rosy: ramp('#ff5ca0'), white: ramp('#dfe8f4', { warm: 60 }),
  // 队伍色
  teal: ramp('#00c098', { warm: 150 }), red: ramp('#f84850'),
  // 火、烟、叶
  flame: ramp('#ff9a20', { cool: 6, deep: .5, peak: .97 }), cold: ramp('#56e6ff', { cool: 226, deep: .5, warm: 180, peak: .97 }), smoke: ramp('#9a94b8'), leaf: ramp('#3e9a50', { warm: 80 }),
  lead: [10, 7, 22],                                     // 铅条 / 墨线：不是纯黑，带一点紫
};

// —— 确定性的随机与噪声 ——
export function hash(x, y, s = 0) {
  let n = Math.imul(x | 0, 0x1b873593) ^ Math.imul(y | 0, 0xcc9e2d51) ^ Math.imul((s | 0) + 77, 0x2545f491);
  n ^= n >>> 15; n = Math.imul(n, 0x2c1b3c6d); n ^= n >>> 12; n = Math.imul(n, 0x297a2d39);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}
const wrap = (a, p) => p ? ((a % p) + p) % p : a;
// 平滑值噪声；给了周期 (px, py) 就能无缝平铺
export function noise(x, y, s = 0, px = 0, py = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash(wrap(xi, px), wrap(yi, py), s), b = hash(wrap(xi + 1, px), wrap(yi, py), s), c = hash(wrap(xi, px), wrap(yi + 1, py), s), d = hash(wrap(xi + 1, px), wrap(yi + 1, py), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// 几层噪声叠起来（云纹、石纹）
export function cloud(x, y, s = 0, oct = 3, px = 0, py = 0) {
  let sum = 0, amp = .5, tot = 0;
  for (let i = 0, f = 1; i < oct; i++, f *= 2, amp *= .5) { sum += amp * noise(x * f, y * f, s + i * 31, px * f, py * f); tot += amp; }
  return sum / tot;
}
// 碎格（Voronoi）：结果写进 CELL = [最近那颗种子的编号, 到它的距离, 到第二近的距离]
export const CELL = [0, 0, 0];
export function cell(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y); let d1 = 9, d2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, d = Math.hypot(cx + hash(cx, cy, s) - x, cy + hash(cx, cy, s + 9) - y);
    if (d < d1) { d2 = d1; d1 = d; id = cx * 7919 + cy * 104729; } else if (d < d2) d2 = d;
  }
  CELL[0] = id; CELL[1] = d1; CELL[2] = d2; return CELL;
}

// —— 色阶取色：lv 可以是小数，两级之间用斜纹抖动 ——
const HATCH = [.14, .62, .38, .86];
export function tone(rp, lv, x, y, band = .6) {
  const n = rp.length - 1, f = clamp(lv, 0, n), i = Math.floor(f);
  return rp[i < n && f - i > .5 + (HATCH[(x + y * 2) & 3] - .5) * band ? i + 1 : i];
}

// —— 距离函数（坐标是像素，y 向下；里面为负）——
export const S = {
  disc: (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r,
  oval: (cx, cy, rx, ry) => (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry),
  rect: (x0, y0, w, h, r = 0) => (x, y) => { const qx = Math.abs(x - x0 - w / 2) - w / 2 + r, qy = Math.abs(y - y0 - h / 2) - h / 2 + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; },
  bar: (ax, ay, bx, by, r) => (x, y) => { const ex = bx - ax, ey = by - ay, t = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1), 0, 1); return Math.hypot(x - ax - ex * t, y - ay - ey * t) - r; },
  // 尖拱：底边在 yb、半宽 hw、总高 H，拱的部分高 rise（比 hw 大才是尖的）
  ogive: (cx, yb, hw, H, rise = hw * 1.5) => { const ys = yb - H + rise, c = (rise * rise - hw * hw) / (2 * hw), R = hw + c; return (x, y) => y < ys ? Math.max(Math.hypot(x - cx - c, y - ys), Math.hypot(x - cx + c, y - ys)) - R : Math.max(Math.abs(x - cx) - hw, y - yb); },
  // 任意多边形
  poly: pts => (x, y) => {
    let d = Infinity, sgn = 1;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], ex = pts[j][0] - xi, ey = pts[j][1] - yi, wx = x - xi, wy = y - yi, t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1), bx = wx - ex * t, by = wy - ey * t;
      d = Math.min(d, bx * bx + by * by);
      const c1 = y >= yi, c2 = y < pts[j][1], c3 = ex * wy > ey * wx; if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sgn = -sgn;
    }
    return sgn * Math.sqrt(d);
  },
  // 一圈圆瓣（三叶、四叶、玫瑰瓣）：n 个半径 pr 的圆，圆心在半径 r 的圈上
  foils: (cx, cy, r, n, pr, a0 = -Math.PI / 2) => (x, y) => { let d = Infinity; for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n; d = Math.min(d, Math.hypot(x - cx - Math.cos(a) * r, y - cy - Math.sin(a) * r) - pr); } return d; },
  any: (...f) => (x, y) => { let d = Infinity; for (const g of f) d = Math.min(d, g(x, y)); return d; },      // 并
  all: (...f) => (x, y) => { let d = -Infinity; for (const g of f) d = Math.max(d, g(x, y)); return d; },     // 交
  cut: (a, b) => (x, y) => Math.max(a(x, y), -b(x, y)),                                                        // a 挖掉 b
  ring: (f, t) => (x, y) => Math.abs(f(x, y)) - t,                                                             // 只留边缘一圈
  grow: (f, r) => (x, y) => f(x, y) - r,
};

const LIGHT = [-.56, -.83];                              // 画里的光从左上来
// 一张像素画布
export class Plate {
  constructor(w, h) { this.w = Math.round(w); this.h = Math.round(h); this.d = new Uint8ClampedArray(this.w * this.h * 4); }
  has(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  dot(x, y, c, a = 255) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this; const i = (y * this.w + x) * 4; this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a; return this; }
  ink(x, y, rp, lv, band) { return this.dot(x, y, tone(rp, lv, x, y, band)); }
  wipe(x, y) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[(y * this.w + x) * 4 + 3] = 0; return this; }
  // 整幅逐点：fn(x, y) → [色阶, 级数, 抖动带宽?]；返回空就不动这一点
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const r = fn(x, y); if (r) this.ink(x, y, r[0], r[1], r[2]); } return this; }
  // 按距离函数填一个形体。lv 本色的级数；round 斜边有多宽（像素）；lift 斜边明暗差几级；
  // grain(x, y, d) 再加一层纹理（返回级数的增减）；rp 也可以是 (x, y, d) → 色阶；line 给了就把最外一圈压到这一级（自带的描边）
  form(dist, rp, { lv = 3, round = 2.5, lift = 1.5, grain = null, line = null, band = .6 } = {}) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const d = dist(x + .5, y + .5); if (d >= 0) continue;
      const gx = dist(x + 1.5, y + .5) - d, gy = dist(x + .5, y + 1.5) - d, g = Math.hypot(gx, gy) || 1, e = Math.min(1, -d / round);
      let L = lv + lift * (1 - e * e) * ((gx * LIGHT[0] + gy * LIGHT[1]) / g);
      if (grain) L += grain(x, y, d);
      if (line !== null && d > -1) L = Math.min(L, line);
      this.ink(x, y, typeof rp === 'function' ? rp(x, y, d) : rp, L, band);
    }
    return this;
  }
  // 实心矩形：lv 可以是数，也可以是 (u, v, x, y) → 级数（u、v 是 0..1 的相对位置）
  block(x0, y0, w, h, rp, lv = 3, band = .5) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.ink(x0 + i, y0 + j, rp, typeof lv === 'function' ? lv(w > 1 ? i / (w - 1) : .5, h > 1 ? j / (h - 1) : .5, x0 + i, y0 + j) : lv, band);
    return this;
  }
  // 车出来的回转体（烛台、杯、瓶、柱脚）：rOf(t) 给每一行的半径（t 从上到下 0..1）。左亮右暗，偏左一道高光
  turn(cx, y0, y1, rOf, rp, { lv = 3, lift = 2.2, band = .6 } = {}) {
    for (let y = y0; y <= y1; y++) {
      const r = rOf(y1 > y0 ? (y - y0) / (y1 - y0) : 0); if (r <= 0) continue;
      for (let x = Math.floor(cx - r); x < Math.ceil(cx + r); x++) {
        const u = (x + .5 - cx) / r; if (Math.abs(u) > 1) continue;
        this.ink(x, y, rp, lv + lift * (-.62 * u + .5 * Math.sqrt(1 - u * u) - .3) + (Math.abs(u + .4) < .17 ? .7 : 0), band);
      }
    }
    return this;
  }
  // 一道线（铁条、链、茎）：th 是粗细，lv 可以是 (t) → 级数
  seg(x0, y0, x1, y1, rp, lv = 3, th = 1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) || 1;
    for (let i = 0; i <= n; i++) { const x = Math.floor(x0 + (x1 - x0) * i / n), y = Math.floor(y0 + (y1 - y0) * i / n); for (let a = 0; a < th; a++) for (let b = 0; b < th; b++) this.ink(x + a, y + b, rp, typeof lv === 'function' ? lv(i / n) : lv, .3); }
    return this;
  }
  // 挖掉一个形体（变透明）
  bore(dist) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (dist(x + .5, y + .5) < 0) this.wipe(x, y); return this; }
  // 给整张图描一圈深色外轮廓（挨着不透明点的透明点）
  edge(c = C.lead) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.has(x, y) && (this.has(x - 1, y) || this.has(x + 1, y) || this.has(x, y - 1) || this.has(x, y + 1))) add.push(x, y);
    for (let i = 0; i < add.length; i += 2) this.dot(add[i], add[i + 1], c);
    return this;
  }
  // 把另一张贴上来（透明的地方不盖）
  paste(src, ox = 0, oy = 0, flip = false) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const i = (y * src.w + (flip ? src.w - 1 - x : x)) * 4; if (src.d[i + 3]) this.dot(ox + x, oy + y, [src.d[i], src.d[i + 1], src.d[i + 2]]); }
    return this;
  }
  // 整张压暗 / 提亮（k 是倍数），做剪影用
  dim(k, tint = [1, 1, 1]) { for (let i = 0; i < this.d.length; i += 4) { this.d[i] *= k * tint[0]; this.d[i + 1] *= k * tint[1]; this.d[i + 2] *= k * tint[2]; } return this; }
  canvas() { const c = document.createElement('canvas'); c.width = this.w; c.height = this.h; c.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0); return c; }
}

// 回转体的轮廓：给几个 [t, 半径] 的点，中间直线连
export const prof = (...pts) => t => { for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0] || 1); } return pts[pts.length - 1][1]; };

// 一张柔的加色光图（灯晕、光柱、地上的色光）：fn(u, v) → [r, g, b]（0..1），不走色阶、不抖动
export function soft(w, h, fn) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), im = g.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { const q = fn((x + .5) / w, (y + .5) / h); im.data[i] = q[0] * 255; im.data[i + 1] = q[1] * 255; im.data[i + 2] = q[2] * 255; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0); return c;
}
