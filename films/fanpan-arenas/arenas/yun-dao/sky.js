// 《云上浮岛》天上的东西：一朵朵像素云、最远处的天幕（天色渐变 + 云山 + 卷云）、上层的碎云毯，
// 以及一套“软”的光片（光晕、水雾、光柱、彩虹、贴镜头的云丝）。前面几样是 Pix，软片直接是 canvas。
import { Pix, hash, hash2, fbm, cell, rgb, mix, pick, bayer, ball, heap } from './paint.js';

// 云的色阶：底下是天光染的蓝，往上雪白，最亮一级是太阳镶的金
const CLOUD = ['#5f93dc', '#8db6ec', '#bcd6f6', '#e6effa', '#ffffff', '#fff3cc'].map(rgb);
const GOLD = rgb('#ffe08a');

// 一朵云：一排大小不一的球堆出来，底边压平。w、h 是像素，seed 换形状
export function cloud(w, h, seed) {
  const p = new Pix(w, h), bs = [], n = Math.max(4, Math.round(w / 13)), base = h - 3;
  for (let i = 0; i < n; i++) { const u = (i + .5) / n, bell = Math.sin(u * 3.1416), r = (h * .2 + h * .34 * bell) * (.7 + hash(i, seed) * .5); bs.push(ball(w * (.1 + u * .8) + (hash(i, seed + 1) - .5) * 5, base - r * .78, r * 1.2, r, 1.1)); }
  for (let i = 0; i < n; i++) { const u = hash(i, seed + 2); bs.push(ball(w * (.2 + u * .6), base - h * (.3 + hash(i, seed + 3) * .42), h * .2, h * .18, 1.1)); }   // 顶上再鼓几个小云头
  const f = heap(bs);
  p.relief((x, y) => (y > base ? 0 : f(x, y)), CLOUD, { k: 1.5, soft: 1, bias: .12, shade: (x, y) => -Math.max(0, y / h - .45) * .9 + (fbm(x / 6, y / 5, seed + 5) - .5) * .22 });
  for (let x = 0; x < w; x++) if (p.has(x, base) && hash(x, seed + 6) > .55) p.clear(x, base);   // 底边咬掉几颗，别太齐
  return p.rim(GOLD, .7);
}
// 一缕薄云：扁扁长长，边上是抖动出来的
export function wispPix(w, h, seed) {
  const p = new Pix(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const u = x / w, v = (y + .5) / h - .5, d = 1 - Math.abs(v) * 2.2 / Math.sin(Math.max(.02, u) * 3.1416) ** .6, n = fbm(x / 9, y / 3, seed) - .42; if (d + n * 1.2 > .5 + (bayer(x, y) - .5) * .5) p.set(x, y, pick(CLOUD, .62 + d * .3 - v * .5, x, y, 1)); }
  return p.rim(GOLD, .5);
}

// 上层的碎云毯：能平铺，只有云头是实的，其余镂空（底下露出更深处的云海）
export function puffLayerPix(N = 256) {
  const H0 = new Float32Array(N * N), p = new Pix(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const a = 1 - cell(x / (N / 4), y / (N / 4), 201, 4), b = 1 - cell(x / (N / 9) + .4, y / (N / 9), 202, 9), c = fbm(x / 32, y / 32, 203, 8); H0[y * N + x] = Math.max(0, a * .7 + b * .28 + (c - .5) * .5 - .7) * 34; }
  const at = (i, j) => H0[((j + N) % N) * N + (i + N) % N];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const z = at(x, y); if (z <= .2 + bayer(x, y) * .5) continue; const dx = at(x + 1, y) - at(x - 1, y), dy = at(x, y + 1) - at(x, y - 1); p.set(x, y, pick(CLOUD, .5 + Math.min(1, z / 5) * .3 - (dx + dy) * .16, x, y, 1)); }
  return p;
}

// 天幕：钉在画面最上面的一条远景。上面是饱和的天蓝，往下变浅、变桃金，地平线上一排镶金边的云山；地平线以下抖动着淡出，接到远处的云海上。
// 太阳在左后方：左边暖、亮，右边（对局记录面板后面）留成干净的蓝。
export function curtainPix(W = 640, H = 192, mt = 1) {   // mt：云山的大小（天幕矮的时候把它们缩小）
  const p = new Pix(W, H), HZ = Math.round(H * .72);   // 地平线在这一行
  const SKY = [[0, '#2a66d6'], [.3, '#3f8cea'], [.55, '#7fbcf4'], [.78, '#c8e0f6'], [.9, '#ffe2b8'], [1, '#fff2d0']].map(([t, c]) => [t, rgb(c)]);
  const sky = t => { for (let i = 1; i < SKY.length; i++) if (t <= SKY[i][0]) return mix(SKY[i - 1][1], SKY[i][1], (t - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0])); return SKY[SKY.length - 1][1]; };
  const WARM = rgb('#ffcf8a'), sunU = .13;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / HZ;
    if (y > HZ) { const fade = (y - HZ) / (H - HZ); if (fade > bayer(x, y) * .9 + .05) continue; p.set(x, y, mix(rgb('#fff2d0'), rgb('#dcebfb'), Math.min(1, fade * 2))); continue; }
    const q = Math.min(1, Math.max(0, v + (bayer(x, y) - .5) * .09));                                     // 抖一下，渐变不出条带
    let c = sky(q); const glow = Math.exp(-(((u - sunU) / .3) ** 2)) * Math.exp(-(((1 - v) / .62) ** 2));   // 太阳那一侧的暖晕
    c = mix(c, WARM, Math.min(.85, glow * .9 + (bayer(x + 2, y + 1) - .5) * .06));
    const ci = fbm(x / 70, y / (5 * mt), 301) * fbm(x / 160 + 3, y / (30 * mt), 302);                                   // 高处的卷云丝
    if (v < .6 && ci > .33 - (1 - u) * .02) c = mix(c, [255, 250, 240], Math.min(.6, (ci - .33) * 5));
    p.set(x, y, c);
  }
  // 云山：越靠右越矮、越少
  const towers = []; for (let i = 0; i < 26; i++) { const u = hash(i, 311), big = (1 - u * .62) * (.45 + hash(i, 312) * .75); towers.push({ x: u * W, w: (26 + big * 60) * (.5 + mt * .5), h: (10 + big * 54) * mt, s: i }); }
  towers.sort((a, b) => b.h - a.h);
  const MT = ['#8fb2e8', '#b6cdf2', '#dbe6f8', '#fff6e6', '#ffeab0'].map(rgb), MTW = ['#d99a8e', '#f2bea0', '#ffdcb4', '#fff2d6', '#fff8c8'].map(rgb);
  for (const t of towers) { const bs = []; for (let k = 0; k < 7; k++) { const a = hash(k, t.s + 320), r = t.w * (.16 + hash(k, t.s + 321) * .16); bs.push(ball(t.x + (a - .5) * t.w * .8, HZ - (1 - Math.abs(a - .5) * 1.7) * t.h * (.35 + hash(k, t.s + 322) * .65), r, r * .8, 1.2)); }
    bs.push(ball(t.x, HZ, t.w * .55, t.h * .35, 1)); const f = heap(bs), warm = Math.exp(-(((t.x / W - sunU) / .34) ** 2));
    p.relief((x, y) => (y > HZ + 2 ? 0 : f(x, y)), warm > .35 ? MTW : MT, { x0: Math.floor(t.x - t.w), x1: Math.ceil(t.x + t.w), y0: Math.floor(HZ - t.h * 1.3), y1: HZ + 3, k: 2, soft: 1, bias: .14, shade: (x, y) => -Math.max(0, (y - (HZ - t.h * .5)) / t.h) * .5 }); }
  // 地平线上一条发亮的雾带，把云山的脚吃掉
  for (let y = HZ - 5; y <= HZ; y++) for (let x = 0; x < W; x++) if ((y - (HZ - 5)) / 6 > bayer(x, y) * .9) p.set(x, y, rgb('#fff4dc'));
  return p;
}

// —— 软的光片：都是白的，用的时候再染色。返回 { 名字: canvas } ——
export function softs() {
  const mk = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), im = g.createImageData(w, h), d = im.data; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = Math.max(0, Math.min(1, fn((x + .5) / w, (y + .5) / h, x, y))), i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a * 255; } g.putImageData(im, 0, 0); return c; };
  const S = {};
  S.halo = mk(64, 64, (u, v) => { const r = Math.hypot(u - .5, v - .5) * 2; return (1 - r) ** 2 * (r < 1 ? 1 : 0); });                                   // 圆的光晕
  S.core = mk(32, 32, (u, v) => { const r = Math.hypot(u - .5, v - .5) * 2; return r < 1 ? (1 - r) ** .7 : 0; });                                         // 实一点的亮心
  S.mist = mk(64, 64, (u, v, x, y) => { const r = Math.hypot(u - .5, v - .5) * 2; return Math.max(0, 1 - r) * (.35 + fbm(x / 9, y / 9, 401) * 1.1) * .9; });   // 一团水雾
  S.wisp = mk(128, 48, (u, v, x, y) => { const e = Math.sin(u * 3.1416) ** .7 * Math.max(0, 1 - Math.abs(v - .5) * 2.1); return e * (.2 + fbm(x / 20, y / 8, 402) * 1.3) * .9; });   // 贴镜头飘过的云丝
  S.ray = mk(32, 96, (u, v) => Math.sin(u * 3.1416) ** 2 * Math.sin(Math.min(1, v * 1.15) * 3.1416) ** .8);                                                // 一道斜下来的光柱
  S.star = mk(32, 32, (u, v) => { const x = Math.abs(u - .5) * 2, y = Math.abs(v - .5) * 2; return Math.max(0, 1 - x * 9 - y * .9) + Math.max(0, 1 - y * 9 - x * .9) + Math.max(0, .5 - Math.hypot(x, y) * 3); });   // 十字的闪光
  // 彩虹：半个圆弧，七道色，两头和底下淡出（它不是白的：自己带颜色）
  { const w = 192, h = 96, c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), im = g.createImageData(w, h), d = im.data, band = ['#ff5a6a', '#ff9a4a', '#ffe060', '#7ae07a', '#5ac8f0', '#6a8af0', '#a070e8'].map(rgb);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x + .5 - w / 2, y + .5 - h) / h, t = (1 - r) / .16, i = (y * w + x) * 4; if (t < 0 || t >= 1) continue; const k = t * 6.999, c0 = band[Math.floor(k)], c1 = band[Math.min(6, Math.floor(k) + 1)], cc = mix(c0, c1, k % 1), a = Math.sin(t * 3.1416) * Math.min(1, (h - y) / (h * .55)); d[i] = cc[0]; d[i + 1] = cc[1]; d[i + 2] = cc[2]; d[i + 3] = a * 255; }
    g.putImageData(im, 0, 0); S.rainbow = c; }
  return S;
}

// 所有的云片（拼进小件图集）
export function clouds() {
  const C = {};
  C.cloudA = cloud(150, 60, 501); C.cloudB = cloud(112, 46, 502); C.cloudC = cloud(84, 36, 503); C.cloudD = cloud(60, 26, 504); C.cloudE = cloud(132, 44, 505); C.cloudF = cloud(40, 18, 506);
  C.wispA = wispPix(120, 16, 511); C.wispB = wispPix(84, 12, 512);
  return C;
}
