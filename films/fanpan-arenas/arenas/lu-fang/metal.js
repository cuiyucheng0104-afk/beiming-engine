// 《齿轮熔炉》· 自己的像素画法：「板金法」。不和别的擂台共用任何代码或贴图。
// 一张图就是一张 Sheet（板）：每个像素只记两样——用哪种料（一条色带）和明度（0–1 的小数）。
// 画的时候像做钣金：先铺料（rect / panel / disc / bar），压边（受光的上、左边提亮，背光的下、右边压暗），
// 打铆钉（rivet），刻线和划痕（line / scuff），最后做旧（grime 煤灰、wear 锈和铜绿）。
// bake() 一次把明度量化成 8 级色带里的颜色；两级之间用「马步」排线抖动（(x + 2y) mod 5），
// 既不是棋盘格也不是 Bayer 方阵，出来是一道道很细的斜纹，像锉过的金属。
// 只在浏览器里跑（要 document 的 canvas），没有外部图片。
export const PPM = 48;                                             // 每米多少像素，和棋子的像素密度一致

const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
// 一条色带 8 级：暗、中、亮三个锚点之间插出来。暗部带蓝黑或酒红，亮部往暖黄里偏，不走纯灰
function band(lo, mid, hi) {
  const a = hex(lo), b = hex(mid), c = hex(hi), out = [];
  for (let i = 0; i < 8; i++) { const t = i / 7, p = t < .5 ? a : b, q = t < .5 ? b : c, k = t < .5 ? t * 2 : t * 2 - 1; out.push([0, 1, 2].map(j => Math.round(p[j] + (q[j] - p[j]) * k))); }
  return out;
}
export const INK = {
  iron: band('#10101e', '#4c5268', '#c4cad2'),                     // 黑铁
  steel: band('#141a2e', '#62708c', '#e2ecf2'),                    // 亮一些的钢
  soot: band('#08080f', '#2a2e3e', '#7a8292'),                     // 熏黑的铁（盘面、暗处）
  brass: band('#3c1c0a', '#c48c2a', '#fff0a0'),                    // 黄铜
  copper: band('#3a0e12', '#c85a2c', '#ffd098'),                   // 紫铜
  patina: band('#082e36', '#34a88e', '#c0f8d4'),                   // 铜绿
  rust: band('#2a0a0c', '#a04a1e', '#f4a058'),                     // 铁锈
  brick: band('#260a10', '#8e3626', '#e89058'),                    // 耐火砖
  fire: band('#6a0c02', '#ff7410', '#fffab0'),                     // 铁水、火
  teal: band('#032c38', '#0cc4ae', '#e0fff8'),                     // 本方的青
  red: band('#36040f', '#ee3038', '#ffd4b0'),                      // 对面的红
  wood: band('#22100c', '#7e4c28', '#dcae6c'),                     // 木头
  coal: band('#06060b', '#22222e', '#727888'),                     // 煤
  stone: band('#130f1a', '#4c4452', '#aca09a'),                    // 地面的石板
  hazard: band('#3a2202', '#e2a40e', '#fff4a8'),                   // 警示黄
  glass: band('#051e28', '#2a8496', '#d0fcff'),                    // 玻璃、表盘
  steam: band('#565c6a', '#b6bcc6', '#ffffff'),                    // 蒸汽
  hide: band('#280c10', '#8c3e2a', '#e49a70'),                     // 风箱的皮
  water: band('#051c38', '#1a6e98', '#a8f0f6'),                    // 冷却水
  enamel: band('#34323c', '#c8c0b0', '#fffce8'),                   // 表盘白、搪瓷牌
};
const NAMES = Object.keys(INK), ID = Object.fromEntries(NAMES.map((n, i) => [n, i + 1])), RAMP = [null, ...NAMES.map(n => INK[n])];

// —— 确定性的随机和噪声 ——
export function jit(x, y, s = 0) {
  let n = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul((s | 0) + 11, 83492791);
  n = Math.imul(n ^ (n >>> 13), 0x5bd1e995); n ^= n >>> 15; n = Math.imul(n, 0x27d4eb2f);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
// 平滑值噪声；给了周期就能无缝平铺
export function cloud(x, y, s = 0, px = 0, py = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), u = fade(x - xi), v = fade(y - yi), w = (a, p) => p ? ((a % p) + p) % p : a;
  const g = (a, b) => jit(w(a, px), w(b, py), s);
  return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v;
}
export const turb = (x, y, s = 0, px = 0, py = 0) => (cloud(x, y, s, px, py) * 4 + cloud(x * 2, y * 2, s + 5, px * 2, py * 2) * 2 + cloud(x * 4, y * 4, s + 9, px * 4, py * 4)) / 7;
// 圆管横截面上的明暗：u = -1 是受光的一侧，1 是背光的一侧
export const roll = u => Math.max(-.55, .58 - 1.08 * Math.abs(u + .36) ** 1.3);

export class Sheet {
  constructor(w, h, wrap = false) { this.w = Math.round(w); this.h = Math.round(h); this.wrap = wrap; this.m = new Uint8Array(this.w * this.h); this.v = new Float32Array(this.w * this.h); }
  at(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (this.wrap) { x = ((x % this.w) + this.w) % this.w; y = ((y % this.h) + this.h) % this.h; } else if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }
  has(x, y) { const i = this.at(x, y); return i >= 0 && this.m[i] > 0; }
  dot(x, y, ink, v) { const i = this.at(x, y); if (i >= 0) { this.m[i] = ID[ink]; this.v[i] = v; } return this; }
  add(x, y, dv) { const i = this.at(x, y); if (i >= 0 && this.m[i]) this.v[i] += dv; return this; }
  cut(x, y) { const i = this.at(x, y); if (i >= 0) this.m[i] = 0; return this; }
  // 整张逐点：fn(x, y) → [料, 明度]；返回 0 是挖掉这一点，返回空是不动
  each(fn) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) { const r = fn(x, y); if (r) this.dot(x, y, r[0], r[1]); else if (r === 0) this.cut(x, y); } return this; }
  // 只改已有像素的明度：fn(x, y) → 加多少
  tone(fn) { for (let y = 0, i = 0; y < this.h; y++) for (let x = 0; x < this.w; x++, i++) if (this.m[i]) this.v[i] += fn(x, y) || 0; return this; }
  rect(x, y, w, h, ink, v) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j, ink, typeof v === 'function' ? v(i, j) : v); return this; }
  // 一颗铆钉：左上一点高光，右下一道影
  rivet(x, y, k = .26) { this.add(x, y, k).add(x + 1, y, k * .4).add(x, y + 1, k * .4).add(x + 1, y + 1, -k * .2).add(x + 2, y + 1, -k * .6).add(x + 1, y + 2, -k * .6).add(x + 2, y + 2, -k * .5); return this; }
  // 一块压过边的板：上、左边亮，下、右边暗；rivet > 0 时沿四边每隔这么多像素打一颗铆钉，rivet < 0 只打四角
  panel(x, y, w, h, ink, v, { edge = .15, rivet = 0, pad = 3 } = {}) {
    this.rect(x, y, w, h, ink, v);
    for (let i = 0; i < w; i++) { this.add(x + i, y, edge).add(x + i, y + h - 1, -edge * 1.3); }
    for (let j = 1; j < h - 1; j++) { this.add(x, y + j, edge * .7).add(x + w - 1, y + j, -edge); }
    if (rivet) {
      const xs = [], ys = [];
      if (rivet < 0) { xs.push(pad, w - pad - 2); ys.push(pad, h - pad - 2); for (const a of xs) for (const b of ys) this.rivet(x + a, y + b); }
      else {
        const nx = Math.max(1, Math.round((w - 2 * pad) / rivet)), ny = Math.max(1, Math.round((h - 2 * pad) / rivet));
        for (let i = 0; i <= nx; i++) { const a = x + pad + Math.round((w - 2 * pad - 2) * i / nx); this.rivet(a, y + pad); this.rivet(a, y + h - pad - 2); }
        for (let j = 1; j < ny; j++) { const b = y + pad + Math.round((h - 2 * pad - 2) * j / ny); this.rivet(x + pad, b); this.rivet(x + w - pad - 2, b); }
      }
    }
    return this;
  }
  // 鼓起来的圆片（球面明暗）
  disc(cx, cy, r, ink, v, amp = .2) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const nx = (x - cx) / r, ny = (y - cy) / r, q = nx * nx + ny * ny; if (q > 1) continue;
      this.dot(x, y, ink, v + amp * (-.62 * nx - .78 * ny) * (.5 + .5 * q) + amp * .5 * (1 - q) - amp * .3);
    }
    return this;
  }
  // 圆环：外沿朝光的一侧亮，内沿反过来
  ring(cx, cy, r0, r1, ink, v, amp = .16) {
    for (let y = Math.floor(cy - r1); y <= cy + r1; y++) for (let x = Math.floor(cx - r1); x <= cx + r1; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy); if (d > r1 || d < r0) continue;
      const k = (d - r0) / Math.max(.001, r1 - r0), side = (-.62 * dx - .78 * dy) / (d || 1);
      this.dot(x, y, ink, v + amp * side * (k * 2 - 1) + (k > .25 && k < .75 ? amp * .25 : 0));
    }
    return this;
  }
  // 一根圆杆 / 圆管：两点之间、半径 r，横截面按 roll 上明暗
  bar(x0, y0, x1, y1, r, ink, v, amp = .24) {
    const vx = x1 - x0, vy = y1 - y0, L = Math.hypot(vx, vy) || 1; let nx = -vy / L, ny = vx / L; if (nx * .62 + ny * .78 > 0) { nx = -nx; ny = -ny; }   // 法线挑朝左上的那一边
    for (let y = Math.floor(Math.min(y0, y1) - r - 1); y <= Math.max(y0, y1) + r + 1; y++) for (let x = Math.floor(Math.min(x0, x1) - r - 1); x <= Math.max(x0, x1) + r + 1; x++) {
      const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (L * L))), px = x - x0 - vx * t, py = y - y0 - vy * t, d = Math.hypot(px, py); if (d > r) continue;
      this.dot(x, y, ink, v + amp * roll(-(px * nx + py * ny) / Math.max(.5, r)));
    }
    return this;
  }
  line(x0, y0, x1, y1, ink, v) { const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.4)); for (let i = 0; i <= n; i++) this.dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, ink, v); return this; }
  // 字符画：rows 是一行行字符，key 把字符对到 [料, 明度]；空格和点不画
  glyph(x0, y0, rows, key) { rows.forEach((row, j) => [...row].forEach((ch, i) => { const k = key[ch]; if (k) this.dot(x0 + i, y0 + j, k[0], k[1]); })); return this; }
  // 煤灰：按噪声压暗
  grime(amp = .12, scale = 12, seed = 0) { const px = this.wrap ? Math.max(1, Math.round(this.w / scale)) : 0, py = this.wrap ? Math.max(1, Math.round(this.h / scale)) : 0, sx = px ? this.w / px : scale, sy = py ? this.h / py : scale; return this.tone((x, y) => -amp * 2 * (turb(x / sx, y / sy, seed, px, py) - .35)); }
  // 划痕：n 道短斜线
  scuff(n, len = 5, dv = .1, seed = 0) { for (let k = 0; k < n; k++) { const x = jit(k, 1, seed) * this.w, y = jit(k, 2, seed) * this.h, a = (jit(k, 3, seed) - .5) * 1.2 + (k & 1 ? 0 : 1.57), l = len * (.4 + jit(k, 4, seed)); for (let i = 0; i < l; i++) this.add(x + Math.cos(a) * i, y + Math.sin(a) * i, k % 3 ? dv : -dv); } return this; }
  // 做旧：噪声高过门槛的地方换成另一种料（锈、铜绿、油渍）。sy 把斑往下拉成一道道流痕
  wear(ink, thr = .6, scale = 10, seed = 0, dv = 0, sy = 1) {
    const px = this.wrap ? Math.max(1, Math.round(this.w / scale)) : 0, py = this.wrap ? Math.max(1, Math.round(this.h / (scale * sy))) : 0, sx = px ? this.w / px : scale, syy = py ? this.h / py : scale * sy, id = ID[ink];
    for (let y = 0, i = 0; y < this.h; y++) for (let x = 0; x < this.w; x++, i++) { if (!this.m[i]) continue; const n = turb(x / sx, y / syy, seed, px, py); if (n > thr) { this.m[i] = id; this.v[i] += dv + (n - thr) * .5; } }
    return this;
  }
  // 给透明边描一圈暗线（小件的外轮廓）
  rim(ink = 'coal', v = .05) {
    const list = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.has(x, y) && ((x > 0 && this.has(x - 1, y)) || (x < this.w - 1 && this.has(x + 1, y)) || (y > 0 && this.has(x, y - 1)) || (y < this.h - 1 && this.has(x, y + 1)))) list.push(x, y);
    for (let i = 0; i < list.length; i += 2) this.dot(list[i], list[i + 1], ink, v);
    return this;
  }
  // 把另一张板贴上来（透明处不盖）
  paste(o, x0, y0) { for (let y = 0, i = 0; y < o.h; y++) for (let x = 0; x < o.w; x++, i++) if (o.m[i]) { const k = this.at(x0 + x, y0 + y); if (k >= 0) { this.m[k] = o.m[i]; this.v[k] = o.v[i]; } } return this; }
  // 量化成像素色
  bake() {
    const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
    const g = c.getContext('2d'), img = g.createImageData(this.w, this.h), d = img.data;
    for (let y = 0, i = 0; y < this.h; y++) for (let x = 0; x < this.w; x++, i++) {
      if (!this.m[i]) continue;
      const L = Math.max(0, Math.min(1, this.v[i])) * 7, f = Math.floor(L), fr = (L - f - .5) * 1.7 + .5, lv = Math.min(7, f + (fr > (((x + 2 * y) % 5) + .5) / 5 ? 1 : 0)), col = RAMP[this.m[i]][lv];
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  }
}

// 半透明的软边图（光晕、光柱、烟尘的底）：不是像素画，只给叠加层用
export function soft(w, h, fn, tint = [255, 255, 255]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { img.data[i] = tint[0]; img.data[i + 1] = tint[1]; img.data[i + 2] = tint[2]; img.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, fn(x / (w - 1), y / (h - 1))))); }
  g.putImageData(img, 0, 0); return c;
}
