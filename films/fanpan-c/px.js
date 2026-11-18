// 《林间擂台》· 像素贴图：全部用 Canvas 2D 逐像素画，没有外部图片。B、C 两版共用这一份（B 版经资产桥在浏览器里跑）。
// 做法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab）：贴图按固定的像素密度画，
// 每种材料 5–6 级色阶，级与级之间只留很窄的 4×4 Bayer 抖动带，最暗一级是带暖味的墨色而不是纯黑。代码是自己写的。
//   D                         每米多少像素（全场一致，角色像素和场景像素才是同一把尺子）
//   RAMP                      各材料的色阶
//   paint(w, h, fn)           fn(x, y) → [色阶, 级数（小数）, 抖动带宽?, 不透明度?]；返回 null 就留透明
//   brick / slab / ground …   各种贴图，返回 canvas；种子相同画出来就相同
export const D = 40;

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ramp = (...list) => list.map(hex);
export const RAMP = {
  stone: ramp('#1b1a24', '#2e2c38', '#4a4650', '#6f6a6a', '#9a9484', '#c9c3a8'),
  moss: ramp('#0f1f1a', '#1c3a2a', '#2f5a34', '#4f8040', '#86a84c', '#b8cc66'),
  dirt: ramp('#1a1210', '#2a1c16', '#42291c', '#5e3c26', '#805636', '#a37848'),
  wood: ramp('#1a0f0e', '#2e1a14', '#4a2b1b', '#6b4226', '#8f5f34', '#b98848'),
  thatch: ramp('#2a1c12', '#4a3118', '#70501f', '#9a7630', '#c8a048', '#e8cc78'),
  leaf: ramp('#07130f', '#0d241a', '#143a24', '#1f5a2e', '#3a8038', '#74a83e'),
  teal: ramp('#053a35', '#07685a', '#00a080', '#00c098', '#7af0cf', '#d8fff2'),
  red: ramp('#3a0a1c', '#7a1030', '#c02040', '#f84850', '#ff9a8a', '#ffe0d0'),
  gold: ramp('#3a2408', '#7a4a10', '#c07818', '#f0a830', '#ffd070', '#fff2c0'),
};

// 整数哈希 → [0, 1)：同一组 (x, y, 种子) 永远得到同一个数
export function hash2(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
// 值噪声；给了周期 (px, py) 就能无缝平铺
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
export function paint(w, h, fn) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = fn(x, y); if (!r) continue;
    const [rp, level, band = .55, alpha = 255] = r;
    const t = level + ((BAYER[(y & 3) * 4 + (x & 3)] + .5) / 16 - .5) * band;   // 抖动带很窄：只在两级交界附近起作用
    const col = rp[Math.max(0, Math.min(rp.length - 1, Math.round(t)))], i = (y * w + x) * 4;
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = alpha;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// 砌石：错缝的石块，缝是最暗一级，每块自己偏亮或偏暗一点，上沿提亮、下沿压暗；moss > 0 时缝里和角上长青苔。可平铺
export function brick({ w = 64, h = 64, bw = 16, bh = 8, seed = 1, moss = 0, base = 2.4, rampName = 'stone' } = {}) {
  const R = RAMP[rampName];
  return paint(w, h, (x, y) => {
    const row = Math.floor(y / bh), ox = (row & 1) * (bw >> 1), bx = Math.floor((x + ox) / bw), lx = (x + ox) % bw, ly = y % bh;
    const n = fbm(x / 9, y / 9, seed, 3, w / 9, h / 9);
    if (moss && n * 1.15 + (lx === 0 || ly === 0 ? .25 : 0) > 1.02 - moss * .42) return [RAMP.moss, 1.2 + n * 3.2];
    if (lx === 0 || ly === 0) return [R, .2];
    let v = base + (hash2(bx % (w / bw), row % (h / bh), seed) - .5) * 1.5 + (n - .5) * 1.4;
    if (ly === 1) v += .9; if (ly === bh - 1) v -= .8; if (lx === 1) v += .4; if (lx === bw - 1) v -= .5;
    return [R, v];
  });
}

// 一块棋格石板：四周一圈缝，左上受光、右下背光的倒角，面上有裂纹和磨痕。
// team 给了（'teal' / 'red'）就在四角嵌一段本方颜色的角线，mark 再加中心的菱形（出兵那一排用）
export function slab({ w = 46, h = 44, seed = 1, team = null, mark = false, mossy = .3 } = {}) {
  const rnd = mulberry(seed * 7919 + 13), cracks = new Set();
  for (let k = 0; k < 2; k++) {                       // 两条随机游走的裂纹
    let x = 4 + rnd() * (w - 8), y = 4 + rnd() * (h - 8), dx = rnd() < .5 ? 1 : -1;
    for (let i = 0, n = 6 + rnd() * 12; i < n; i++) { cracks.add((x | 0) + ',' + (y | 0)); x += dx * (rnd() < .7 ? 1 : 0); y += rnd() < .6 ? 1 : 0; }
  }
  const tone = (hash2(seed, 3, 5) - .5) * .7;
  return paint(w, h, (x, y) => {
    const e = Math.min(x, y, w - 1 - x, h - 1 - y), n = fbm(x / 7, y / 7, seed, 3);
    if (e === 0) return [RAMP.stone, .1];
    if (mossy && e < 5 && fbm(x / 5, y / 5, seed + 40, 2) > .78 - mossy * .25) return [RAMP.moss, 1.4 + n * 2.6];
    if (team) {
      const a = Math.min(x, w - 1 - x), b = Math.min(y, h - 1 - y);
      if ((a === 4 && b >= 4 && b < 11) || (b === 4 && a >= 4 && a < 11)) return [RAMP[team], 3.2, .3];
      if (mark) { const m = Math.abs(x - (w - 1) / 2) + Math.abs(y - (h - 1) / 2); if (m > 4.6 && m < 6.6) return [RAMP[team], 3, .3]; if (m <= 2) return [RAMP[team], 4, .3]; }
    }
    if (cracks.has(x + ',' + y)) return [RAMP.stone, 1];
    let v = 3.15 + tone + (n - .5) * 1.7;
    if (e === 1) v += (x === 1 || y === 1) ? 1.1 : -1.1;
    return [RAMP.stone, v];
  });
}

// 整片林间空地的地面（一张大图，不平铺）：擂台周围是踩实的土，往外长草，前面一条亮一点的土路；零星石子和落叶。
// (wm, hm) 是地面的米数，(cx, cz) 是擂台中心在地面上的位置（米，从左上角量）
export function ground({ wm = 24, hm = 18, cx = 12, cz = 10, seed = 7 } = {}) {
  const w = wm * D, h = hm * D;
  return paint(w, h, (x, y) => {
    const X = x / D - cx, Z = y / D - cz;
    const n = fbm(x / 26, y / 26, seed, 4), fine = fbm(x / 5, y / 5, seed + 9, 2);
    const r = Math.hypot(X / 7.4, (Z - .4) / 4.9);                      // 空地是个扁椭圆
    const path = Math.exp(-((X + Z * .25) ** 2) / 2.6) * (Z > 2 ? 1 : 0); // 通到前景的小路
    const grass = r + (n - .5) * .55 - path * .5;
    const p = hash2(x, y, seed + 3);
    if (grass > 1.02) {
      const v = 1.3 + n * 2.2 + (fine - .5) * 1.6 - Math.min(1.6, (grass - 1.02) * 1.6);
      if (p < .006) return [RAMP.moss, 4.6];                             // 草尖的亮点
      return [RAMP.moss, v];
    }
    if (p < .0035) return [RAMP.stone, 3 + p * 300];                     // 石子
    if (p > .9975) return [RAMP.thatch, 3.4];                            // 落叶
    let v = 2.3 + (n - .5) * 2.2 + (fine - .5) * 1.1 + path * .9 - Math.max(0, grass - .8) * 2.5;
    return [RAMP.dirt, v];
  });
}

// 木板：竖着排（vertical）或横着排；板缝最暗，木纹顺着板长方向拉丝，偶尔一颗钉。可平铺
export function planks({ w = 64, h = 64, pw = 8, seed = 3, vertical = true, base = 2.6 } = {}) {
  return paint(w, h, (x, y) => {
    const a = vertical ? x : y, b = vertical ? y : x, k = Math.floor(a / pw), la = a % pw;
    if (la === 0) return [RAMP.wood, .3];
    const grain = vnoise(a / 1.6, b / 14 + k * 3.1, seed, 0, 0);
    let v = base + (hash2(k % (w / pw), 1, seed) - .5) * 1.3 + (grain - .5) * 1.5;
    if (la === 1) v += .6; if (la === pw - 1) v -= .6;
    if (la === (pw >> 1) && b % 32 === 5) return [RAMP.stone, 1];
    return [RAMP.wood, v];
  });
}

// 树皮：竖向的深沟和亮脊。可平铺
export function bark({ w = 64, h = 64, seed = 5 } = {}) {
  return paint(w, h, (x, y) => {
    const ridge = fbm(x / 3.2, y / 22, seed, 3, w / 3.2, h / 22), knot = fbm(x / 10, y / 10, seed + 2, 2, w / 10, h / 10);
    return [RAMP.wood, .6 + ridge * 3.4 + (knot - .5) * 1.2];
  });
}

// 茅草顶：一层压一层的草帘，每层下沿亮、被上一层压住的地方暗，草丝竖向。可平铺
export function thatch({ w = 64, h = 64, rh = 10, seed = 11 } = {}) {
  return paint(w, h, (x, y) => {
    const jag = Math.floor(hash2(x, 0, seed) * 3), yy = (y + jag) % rh;
    const strand = vnoise(x / 1.3, y / 9, seed, w / 1.3 | 0, 0);
    let v = 1.2 + (yy / rh) * 3 + (strand - .5) * 1.6;
    if (yy === 0) v = .6;
    return [RAMP.thatch, v];
  });
}

// 树叶：一团一团的叶簇，每簇左上亮、右下暗。可平铺；dark 压暗几级（远处的树墙用）
export function leaves({ w = 64, h = 64, seed = 21, dark = 0 } = {}) {
  return paint(w, h, (x, y) => {
    const a = fbm(x / 8, y / 8, seed, 3, w / 8, h / 8), b = fbm((x - 2) / 8, (y - 2) / 8, seed, 3, w / 8, h / 8);
    const speck = hash2(x, y, seed);
    let v = .8 + a * 3.6 + (a - b) * 9 - dark;
    if (speck < .03) v += 1.2;
    return [RAMP.leaf, v, .7];
  });
}

// 旗：本方颜色的布，竖向褶皱，深色镶边，中间一个浅色的菱形徽记，下摆剪成燕尾（透明；cut: false 时不剪，由几何体自己剪）
export function cloth({ w = 28, h = 60, team = 'teal', seed = 2, cut: doCut = true } = {}) {
  const R = RAMP[team];
  return paint(w, h, (x, y) => {
    const cut = h - 7 + Math.abs(x - (w - 1) / 2) * .5;
    if (y > cut && doCut) return null;
    if (x === 0 || x === w - 1 || y === 0 || y > cut - 1) return [R, .4];
    const fold = Math.sin(x * .85 + seed) * .7 + Math.sin(y * .22 + x * .3) * .35;
    const m = Math.abs(x - (w - 1) / 2) + Math.abs(y - h * .4) * .8;
    if (m < 3) return [R, 5, .3];
    if (m > 6 && m < 8) return [R, 4.4, .3];
    if (y < 3) return [RAMP.gold, 3 + fold * .5];
    return [R, 2.6 + fold - (y / h) * .5];
  });
}

// 城门血量牌：木牌 + 像素心 + 数字（3×5 点阵）
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
const HEART = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
export function plaque({ hp = 10, team = 'teal', w = 40, h = 20 } = {}) {
  const text = String(hp), tw = text.length * 4 - 1, x0 = Math.floor((w - (8 + 2 + tw * 2)) / 2), y0 = 5;
  return paint(w, h, (x, y) => {
    const e = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (e === 0) return [RAMP.wood, .2];
    if (e === 1) return [RAMP[team], 3, .3];
    const hx = x - x0, hy = y - y0 - 2;
    if (hx >= 0 && hx < 7 && hy >= 0 && hy < 6 && HEART[hy][hx] === '1') return [RAMP.red, hy < 2 && hx < 3 ? 4 : 3, .2];
    const dx = Math.floor((x - x0 - 10) / 2), dy = Math.floor((y - y0) / 2);
    if (dx >= 0 && dy >= 0 && dy < 5 && dx < tw + 1) { const k = Math.floor(dx / 4), c = dx % 4; if (c < 3 && k < text.length && DIGITS[+text[k]][dy * 3 + c] === '1') return [RAMP.gold, 5, .2]; }
    return [RAMP.wood, 1.6 + vnoise(x / 2, y / 9, 31) * 1.4];
  });
}

// 草丛（透明底的小卡片）：几根高矮不一的草叶
export function tuft({ w = 20, h = 14, seed = 1 } = {}) {
  const rnd = mulberry(seed * 131 + 7), blades = [];
  for (let i = 0; i < 9; i++) blades.push({ x: 2 + rnd() * (w - 4), top: 1 + rnd() * (h * .55), lean: (rnd() - .5) * .6, lvl: 2 + rnd() * 2.6 });
  return paint(w, h, (x, y) => {
    for (const b of blades) { const bx = Math.round(b.x + (h - 1 - y) * b.lean); if (x === bx && y >= b.top) return [RAMP.moss, b.lvl + (y < b.top + 2 ? 1 : 0) - (y / h) * 1.2, .3]; }
    return null;
  });
}

// 窗：暖色的亮格子（做成自发光用），十字窗棂是暗的
export function windowGlow({ w = 12, h = 14 } = {}) {
  return paint(w, h, (x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 || x === (w >> 1) || y === (h >> 1)) ? [RAMP.wood, 1] : [RAMP.gold, 4 + (1 - y / h) * 1.2, .4]);
}

// 木箱的一面：边框 + 斜撑
export function crate({ w = 20, h = 20, seed = 4 } = {}) {
  return paint(w, h, (x, y) => {
    const e = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (e === 0) return [RAMP.wood, .3];
    if (e < 3) return [RAMP.wood, 3.6 + (e === 1 ? .6 : 0)];
    if (Math.abs(x - y) < 2) return [RAMP.wood, 3.4];
    return [RAMP.wood, 2 + vnoise(x / 1.5, y / 8, seed) * 1.3 - (x % 5 === 0 ? 1 : 0)];
  });
}

// 整片的布（可平铺）：做屋顶和挂帘用，横向一道一道的缝线
export function fabric({ w = 32, h = 32, team = 'teal', seed = 6 } = {}) {
  const R = RAMP[team];
  return paint(w, h, (x, y) => {
    if (y % 16 === 0) return [R, .6];
    if (y % 16 === 8 && x % 4 < 2) return [RAMP.gold, 3];
    return [R, 2.3 + Math.sin(x * Math.PI / 8 + seed) * .6 + (vnoise(x / 3, y / 3, seed, w / 3 | 0, h / 3 | 0) - .5) * 1.2 + (y % 16 === 1 ? .8 : 0)];
  });
}

// 棋子脚边的战力牌：本方颜色的小菱形牌 + 数字
export function badge({ n = 1, team = 'teal', s = 13 } = {}) {
  const c = (s - 1) / 2, text = String(n), tw = text.length * 4 - 1;
  return paint(s, s, (x, y) => {
    const m = Math.abs(x - c) + Math.abs(y - c);
    if (m > c) return null;
    if (m > c - 1) return [RAMP.stone, 0];
    const dx = x - Math.round(c - tw / 2 + .5), dy = y - (c - 2);
    if (dx >= 0 && dy >= 0 && dy < 5 && dx < tw) { const k = Math.floor(dx / 4), q = dx % 4; if (q < 3 && DIGITS[+text[k]][dy * 3 + q] === '1') return [RAMP.gold, 5, .1]; }
    if (m > c - 2) return [RAMP[team], 4, .2];
    return [RAMP[team], 1.4 - (y - c) * .12, .4];
  });
}

// 脚下的影子和本方颜色的圈（透明底，贴在石板上）
export function ring({ w = 34, h = 18, team = 'teal' } = {}) {
  return paint(w, h, (x, y) => {
    const r = Math.hypot((x - (w - 1) / 2) / (w / 2 - 1), (y - (h - 1) / 2) / (h / 2 - 1));
    if (r > 1) return null;
    if (r > .84) return [RAMP[team], 3.4, .3, 235];
    return [RAMP.stone, 0, 0, r < .62 ? 150 : ((x + y) & 1 ? 150 : 0)];
  });
}

// 光晕：中心亮、往外按平方衰减的圆（加色叠在灯上）；不抖动，返回 canvas
export function halo(s = 64) {
  const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const r = Math.hypot(x - (s - 1) / 2, y - (s - 1) / 2) / (s / 2), v = Math.max(0, 1 - r) ** 2.2, i = (y * s + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
