// 《丰收麦场》的小件像素画：全部透明底，做成立着（或躺着）的像素片，由 arena.js 拼进一张图集。
// sprites() 返回 { 名字: canvas }。画的时候光从后上方来：亮面在上沿，最后统一描一圈靛蓝的边、顶上勾一道金边（见 paint.js 的 ink / rim）。
import { C, Sheet, rnd2, vn, cloud, clamp, seq, soft, dusk } from './paint.js';
const S = (w, h) => new Sheet(w, h), INK = C.night, PI = Math.PI;
const done = (s, rim = .55, bd = C.glow, lv = 4) => s.ink().rim(bd, lv, rim).canvas();     // 收尾：描边 + 顶上的金边
const MOON = dusk('#ffac52', { cool: 14, warm: 50, deep: .45, lift: .8 });

// —— 植物 ——
// 一段麦子（横向能接上）：后中前三排麦秆，每根顶上一个带芒的麦穗；下半截填实，越往下越暗
function wheat(seed, w = 48, h = 44, clump = false) {
  const s = S(w, h), r = seq(seed);
  s.each((x, y) => y > h * .5 + rnd2(x, 0, seed) * 6 ? [C.hay, 2.2 - (y - h * .5) / h * 3 + rnd2(x, y, seed) * 1.2 - (x % 3 === 0 ? .7 : 0)] : null);
  for (let layer = 0; layer < 3; layer++) for (let i = 0; i < w / 2; i++) {
    const x = i * 2 + Math.floor(r() * 2), top = 5 + layer * 5 + Math.floor(r() * 6), lean = (r() - .5) * 6, bd = layer ? C.wheat : C.hay;
    for (let y = top; y < h; y++) { const k = (y - top) / (h - top); s.px((Math.round(x + lean * (1 - k) ** 2) + w) % w, y, bd, 1.4 + layer * .7 + (1 - k) * 1.5 - k); }
    const ex = Math.round(x + lean);
    for (let k = 0; k < 6; k++) { s.px((ex + w) % w, top - 3 + k, C.wheat, 3.3 + layer * .9 - k * .22); if (k > 0 && k < 5) s.px((ex + (k & 1 ? 1 : -1) + w) % w, top - 3 + k, C.wheat, 2.6 + layer * .9); }
    s.px((ex - 1 + w) % w, top - 4, C.husk, 3.6 + layer * .7).px((ex + 1 + w) % w, top - 5, C.husk, 3.2 + layer * .8);
  }
  // 单独立着的一丛（不和左右拼接）：两侧收成参差的弧形，不然就是一块方砖
  if (clump) for (let x = 0; x < w; x++) { const e = Math.min(x, w - 1 - x) / (w * .42), cutTo = e >= 1 ? 0 : h * (1 - e) ** 1.3 + (rnd2(x, 3, seed) - .5) * 9 * (1 - e); for (let y = 0; y < cutTo; y++) s.cut(x, y); }
  return s.canvas();
}
// 一团树叶：很多个小圆球叠出来的树冠。mix 是掺进去的另一种叶色
function crown(s, cx, cy, rx, ry, band, mix, seed, n = 16, base = 2.6) {
  const r = seq(seed), blobs = [];
  for (let i = 0; i < n; i++) { const a = r() * 2 * PI, d = Math.sqrt(r()); blobs.push([cx + Math.cos(a) * d * rx * .68, cy + Math.sin(a) * d * ry * .62, Math.min(rx, ry) * (.34 + r() * .24), r()]); }
  blobs.sort((a, b) => b[1] - a[1]);                                         // 先画下面的，上面的压住它
  for (const [bx, by, br, pick] of blobs) for (let y = Math.floor(by - br); y <= by + br; y++) for (let x = Math.floor(bx - br); x <= bx + br; x++) {
    const nx = (x - bx) / br, ny = (y - by) / br, q = nx * nx + ny * ny; if (q > 1 || (q > .72 && rnd2(x, y, seed) < .4)) continue;
    const leafy = rnd2(x >> 1, (y >> 1) + (x >> 2), seed + 3);
    s.px(x, y, leafy < .24 || pick < .2 ? mix : band, base - ny * 1.9 - nx * .4 + (leafy - .5) * 1.7 - (q > .8 ? .8 : 0) - (by - cy) / ry * .7);
  }
}
// 树干：下粗上细，分两三根杈
function trunk(s, x, y0, y1, w, band = C.bark, forks = []) {
  for (let y = y0; y <= y1; y++) { const k = (y - y0) / (y1 - y0), ww = w * (.62 + k * .5); for (let i = Math.round(-ww / 2); i <= ww / 2; i++) s.px(x + i, y, band, 2.2 - i / ww * 2.4 + (rnd2(x + i, y >> 2, 5) - .5) * 1.4); }
  for (const [dx, dy] of forks) s.line(x, y0 + 4, x + dx, y0 + dy, band, 1.9, 2);
}
function maple(band, mix, seed) {
  const s = S(112, 136); trunk(s, 56, 70, 135, 11, C.bark, [[-26, -14], [24, -20], [6, -30]]);
  crown(s, 56, 50, 52, 46, band, mix, seed, 24); crown(s, 30, 74, 22, 16, band, mix, seed + 1, 7, 2.2); crown(s, 84, 70, 22, 16, band, mix, seed + 2, 7, 2.2);
  return done(s, .7, C.glow, 5);
}
function appleTree(seed) {
  const s = S(104, 112); trunk(s, 52, 62, 111, 10, C.bark, [[-22, -8], [22, -10]]);
  crown(s, 52, 42, 48, 38, C.leaf, C.olive, seed, 22, 2.4);
  const r = seq(seed + 9);
  for (let i = 0; i < 26; i++) { const x = 12 + Math.floor(r() * 80), y = 16 + Math.floor(r() * 56); if (!s.has(x, y) || !s.has(x + 2, y + 2)) continue; s.orb(x, y, 2.2, 2.2, C.apple, 3.6, 2.4); s.px(x, y - 3, C.bark, 1.5); }
  return done(s, .6, C.husk, 4);
}
function bush(band, mix, seed, w = 44, h = 30) { const s = S(w, h); crown(s, w / 2, h * .58, w / 2 - 2, h * .5, band, mix, seed, 9, 2.5); return done(s, .6); }
// 草丛：一把往外散的叶片
function tuft(band, seed, w = 20, h = 14, n = 9) {
  const s = S(w, h), r = seq(seed);
  for (let i = 0; i < n; i++) { const x0 = w / 2 + (r() - .5) * w * .35, lean = (r() - .5) * w * .8, len = h * (.5 + r() * .5); for (let k = 0; k <= len; k++) { const t = k / len; s.px(x0 + lean * t * t, h - 1 - k, band, 1.6 + t * 2.6 + (i % 3) * .3); } }
  return s.canvas();
}
// 一丛花：茎叶 + 几朵花头
function flowers(band, seed, w = 20, h = 18, big = 1.6) {
  const s = S(w, h), r = seq(seed);
  for (let i = 0; i < 5; i++) { const x = 3 + Math.floor(r() * (w - 6)), top = 3 + Math.floor(r() * 7); s.line(x, h - 1, x + (r() < .5 ? 1 : -1), top, C.leaf, 2.2); s.px(x + 1, top + 5, C.leaf, 3); s.orb(x, top, big, big, band, 3.8, 2); s.px(x, top, C.glow, 3.5); }
  return s.ink().canvas();
}
function sunflower(seed) {
  const s = S(22, 46); s.line(11, 45, 10, 12, C.leaf, 2.2, 2);
  for (const [x, y, d] of [[10, 30, -1], [12, 24, 1], [10, 38, 1]]) s.poly([x, y, x + d * 8, y - 3, x + d * 7, y + 2], C.leaf, (px, py) => 2.6 - (py - y) * .4);
  for (let a = 0; a < 12; a++) s.line(11, 10, 11 + Math.cos(a / 12 * 2 * PI) * 8.5, 10 + Math.sin(a / 12 * 2 * PI) * 8.5, C.mapleY, a < 7 ? 4.2 : 3, 2);
  s.orb(11.5, 10.5, 4.5, 4.5, C.soil, 3, 2.4); return done(s, .4);
}
function cattail(seed) {
  const s = S(18, 38), r = seq(seed);
  for (let i = 0; i < 4; i++) { const x = 3 + i * 4 + Math.floor(r() * 2), top = 4 + Math.floor(r() * 8); s.line(x, 37, x + (i - 1.5) * .6, top, C.olive, 2.4 + i * .3); if (i % 2 === 0) s.box(Math.round(x + (i - 1.5) * .6) - 1, top + 2, 3, 8, C.soil, (u, v) => 3 - u * 1.2); }
  for (let i = 0; i < 5; i++) s.line(2 + i * 3.5, 37, 1 + i * 4 + (r() - .5) * 6, 16 + r() * 10, C.leaf, 2 + r() * 1.6);
  return s.ink().canvas();
}
function mushroom() { const s = S(14, 10); s.box(3, 5, 2, 5, C.cream, 3).box(9, 6, 2, 4, C.cream, 2.6); s.orb(4, 4, 3.6, 2.6, C.barn, 3.6).orb(10, 5.5, 2.6, 2, C.pumpkin, 3.4); s.px(3, 3, C.white, 4).px(5, 4, C.white, 4); return s.ink().canvas(); }
function rock(seed, w = 22, h = 14) {
  const s = S(w, h);
  s.each((x, y) => { const nx = (x - w / 2) / (w / 2 - 1), ny = (y - h * .62) / (h * .6), q = nx * nx + ny * ny + (cloud(x / 4, y / 4, seed, 2) - .5) * .5; return q < 1 && y < h - 1 ? [rnd2(x >> 2, y >> 2, seed) < .2 ? C.moss : C.stone, 3 - ny * 2 - nx * .5 + (cloud(x / 3, y / 3, seed + 2, 2) - .5) * 1.6] : null; });
  return done(s, .5, C.husk, 4);
}

// —— 南瓜 ——
function faceOn(s, cx, cy, w, h, bd, lv) {                                    // 刻出来的脸：两只三角眼、一个小鼻子、一张带牙的嘴
  const e = w * .13;
  for (const d of [-1, 1]) s.poly([cx + d * w * .2 - e, cy - h * .06, cx + d * w * .2 + e, cy - h * .06, cx + d * w * .2 + d * e * .3, cy - h * .06 - e * 1.5], bd, lv);
  s.poly([cx - 1.2, cy + h * .09, cx + 1.2, cy + h * .09, cx, cy + h * .01], bd, lv);
  const mw = w * .29, my = cy + h * .19, mh = Math.max(2, h * .13);
  for (let x = -mw; x <= mw; x++) { const k = Math.abs(x) / mw, top = my - k * mh * .9, tooth = (Math.round(x + mw) % Math.max(3, Math.round(w / 8))) === 0; for (let y = top + (tooth ? 1.5 : 0); y <= top + mh; y++) s.px(cx + x, y, bd, lv); }
}
function pumpkin(w, h, band = C.pumpkin, jack = false, seed = 1) {
  const s = S(w, h + 4), cx = (w - 1) / 2, cy = 4 + (h - 1) / 2, ribs = w > 30 ? 3.2 : w > 18 ? 2.6 : 2;
  for (let y = 4; y < h + 4; y++) for (let x = 0; x < w; x++) {
    const nx = (x - cx) / (w / 2 - .5), ny = (y - cy) / (h / 2 - .5), q = nx * nx + ny * ny; if (q > 1) continue;
    const a = Math.asin(clamp(nx / Math.sqrt(Math.max(.05, 1 - ny * ny * .8)), -1, 1));
    s.px(x, y, band, 3.2 + Math.cos(a * ribs * 2) * .8 - ny * 1.7 - nx * .45 - (q > .82 ? .9 : 0) + (rnd2(x, y, seed) - .5) * .5);
  }
  s.box(Math.round(cx) - 1, 1, 3, 4, C.olive, (u, v) => 3.4 - u * 1.4).px(Math.round(cx) + 2, 1, C.olive, 2.6);
  if (jack) faceOn(s, cx, cy, w, h, C.fire, .2);
  return done(s, .7, C.glow, 4.4);
}
function jackFace(w, h) { const s = S(w, h + 4); faceOn(s, (w - 1) / 2, 4 + (h - 1) / 2, w, h, C.glow, 5.4); return s.canvas(); }

// —— 麦、草、农具 ——
// 麦捆：中间一道草绳扎着，上面炸开一把穗
function sheaf(seed, w = 22, h = 40) {
  const s = S(w, h), r = seq(seed), cx = w / 2;
  for (let i = 0; i < 26; i++) {
    const k = (i / 25 - .5) * 2, bx = cx + k * 6, tx = cx + k * (w / 2 - 2) + (r() - .5) * 3, ty = 3 + Math.abs(k) * 7 + r() * 5;
    s.line(bx, h - 1, cx + k * 2.4, h * .55, C.hay, 2.3 - Math.abs(k) + r()); s.line(cx + k * 2.4, h * .55, tx, ty, C.wheat, 2.6 - k * .8 + r());
    for (let e = 0; e < 5; e++) s.px(tx + (e & 1), ty - 2 + e, C.wheat, 4.4 - e * .3 - k * .5);
  }
  s.box(Math.round(cx) - 4, Math.round(h * .55) - 1, 9, 3, C.dark, (u, v, x, y) => 2.4 + (x % 2));
  return done(s, .6, C.husk, 4.4);
}
// 几捆麦子头靠头立成一堆
function shock(seed) { const s = S(46, 46), a = new Sheet(22, 40); a.d.set(new Uint8ClampedArray(sheafRaw(seed).d)); s.stamp(a, 0, 6).stamp(sheafRaw(seed + 1), 24, 6, true).stamp(sheafRaw(seed + 2), 12, 2); return done(s, .6, C.husk, 4.4); }
function sheafRaw(seed) { const s = S(22, 40), r = seq(seed), cx = 11; for (let i = 0; i < 26; i++) { const k = (i / 25 - .5) * 2, tx = cx + k * 9 + (r() - .5) * 3, ty = 3 + Math.abs(k) * 7 + r() * 5; s.line(cx + k * 6, 39, cx + k * 2.4, 22, C.hay, 2.3 - Math.abs(k) + r()); s.line(cx + k * 2.4, 22, tx, ty, C.wheat, 2.6 - k * .8 + r()); for (let e = 0; e < 5; e++) s.px(tx + (e & 1), ty - 2 + e, C.wheat, 4.4 - e * .3 - k * .5); } s.box(7, 21, 9, 3, C.dark, (u, v, x) => 2.4 + (x % 2)); return s; }
// 尖顶的大草垛：一层压一层的草帘，顶上插一根杆
function haystack(seed) {
  const w = 76, h = 68, s = S(w, h);
  s.each((x, y) => {
    const t = (y - 8) / (h - 8), half = t < .55 ? 6 + t / .55 * 30 : 36 - (t - .55) * 6; if (y < 8 || Math.abs(x - w / 2) > half) return null;
    const nx = (x - w / 2) / half, row = (y + Math.floor(rnd2(x, 0, seed) * 4)) % 9;
    return [rnd2(x >> 1, y, seed) < .25 ? C.straw : C.hay, 2.6 + (row / 9) * 1.5 - (row === 0 ? 1.6 : 0) - nx * .9 - t * .6 + (rnd2(x, y, seed + 1) < .06 ? 1.4 : 0)];
  });
  s.box(37, 0, 2, 9, C.dark, 2.4); return done(s, .8, C.husk, 4.6);
}
function sack(band = C.straw, open = false, seed = 1) {
  const s = S(22, 26);
  s.each((x, y) => { const nx = (x - 10.5) / 9.5, ny = (y - 16) / 9.5, q = Math.abs(nx) ** 2.6 + Math.abs(ny) ** 2.6; return q < 1 ? [band, 3 - ny * 1.5 - nx * .8 + ((x + y) % 4 === 0 ? -.6 : 0) + (rnd2(x, y, seed) - .5) * .6] : null; });
  if (open) { s.box(5, 5, 12, 3, band, 3.6); s.orb(11, 6, 5, 2.4, C.wheat, 4.2, 1.2); } else { s.box(8, 2, 6, 5, band, (u, v) => 3.2 - u); s.box(7, 6, 8, 1, C.dark, 2.4); }
  return done(s, .5, C.husk, 4.2);
}
// 长柄的农具：干草叉、镰刀、耙
function tool(kind) {
  const s = S(kind === 1 ? 32 : 14, 54), x = kind === 1 ? 8 : 6;
  s.line(x, 53, x + (kind === 1 ? 5 : 1), 6, C.wood, k => 3.4 - k * 1.2, 2);
  if (kind === 0) for (const d of [-4, 0, 4]) { s.line(x + 2 + d, 0, x + 2 + d, 9, C.iron, 4.2); s.line(x - 2, 9, x + 6, 9, C.iron, 3.2); }
  if (kind === 1) for (let a = 0; a < 22; a++) { const t = a / 21, px = 13 + Math.sin(t * 1.9) * 16, py = 6 - Math.sin(t * PI) * 5 + t * 6; s.px(px, py, C.iron, 5 - t).px(px, py + 1, C.iron, 3).px(px, py + 2, C.iron, t < .7 ? 2.2 : 3); }
  if (kind === 2) { s.box(1, 4, 12, 2, C.wood, 3); for (let i = 0; i < 6; i++) s.box(1 + i * 2 + (i > 2 ? 1 : 0), 6, 1, 4, C.iron, 3.6); }
  return s.ink().canvas();
}
function ladder() { const s = S(16, 86); s.box(1, 0, 2, 86, C.wood, (u, v) => 3.6 - u).box(13, 0, 2, 86, C.wood, (u, v) => 3 - u); for (let y = 6; y < 84; y += 9) s.box(3, y, 10, 2, C.wood, (u, v) => 3.4 - v * 1.4); return s.ink().canvas(); }
// 车轮：木辐条、铁箍
function wheel(n = 30) {
  const s = S(n, n), c = (n - 1) / 2;
  s.each((x, y) => { const d = Math.hypot(x - c, y - c), a = Math.atan2(y - c, x - c); if (d > c) return null; if (d > c - 2) return [C.iron, 3 - (y - c) / c * 1.6]; if (d > c - 5) return [C.wood, 3.2 - (y - c) / c * 1.3]; if (d < 3.4) return [C.iron, 3.6 - d * .4]; const sp = Math.abs(((a / (PI / 4)) % 1 + 1) % 1 - .5); return sp > .5 - 1.6 / d ? [C.wood, 2.8] : null; });
  return s.ink().canvas();
}
function bucket() { const s = S(14, 16); s.poly([1, 5, 12, 5, 10, 15, 3, 15], C.wood, (x, y) => 3.4 - (x - 1) / 11 * 1.8 - (x % 3 === 0 ? .8 : 0)); s.box(1, 6, 12, 1, C.iron, 3).box(2, 12, 10, 1, C.iron, 2.6).box(2, 4, 10, 1, C.water, 4.2); s.line(2, 5, 6, 0, C.iron, 2.6).line(6, 0, 11, 5, C.iron, 2.6); return s.ink().canvas(); }
function milkCan() { const s = S(14, 24); s.box(2, 8, 10, 15, C.stone, (u, v) => 4.4 - u * 2.4).poly([2, 8, 11, 8, 9, 3, 4, 3], C.stone, (x, y) => 4.6 - (x - 2) / 9 * 2.4).box(4, 1, 6, 2, C.stone, 3.6).box(2, 12, 10, 1, C.iron, 2.4).box(2, 20, 10, 1, C.iron, 2.4); return s.ink().canvas(); }
function beehive() { const s = S(22, 24); for (let k = 0; k < 6; k++) { const hw = 10 - (5 - k) * (5 - k) * .3 - 0; s.box(Math.round(11 - hw), 2 + k * 3 + (k ? 0 : 1), Math.round(hw * 2), 3, C.straw, (u, v) => 3.8 - u * 1.6 - v * 1.2); } s.box(9, 16, 4, 3, C.dark, 1).box(1, 21, 20, 3, C.wood, (u, v) => 3 - v); return done(s, .5, C.husk, 4.4); }
function stump() { const s = S(24, 18); s.box(3, 5, 18, 12, C.bark, (u, v, x) => 3 - u * 1.8 + (x % 3 === 0 ? -.7 : 0)); s.orb(11.5, 5, 9.5, 3.6, C.wood, 4, 1.4); s.line(8, 5, 15, 5, C.wood, 2.8); return done(s, .3); }
function logPile() { const s = S(44, 26); for (const [x, y] of [[7, 20], [18, 20], [29, 20], [38, 20], [12, 12], [23, 12], [34, 12], [18, 5], [28, 5]]) { s.orb(x, y, 5.4, 4.4, C.bark, 2.6, 1.6); s.orb(x, y, 3.6, 3, C.wood, 4, 1.4); s.px(x, y, C.wood, 2.4); } return done(s, .6); }
function signpost() { const s = S(34, 46); s.box(15, 8, 3, 38, C.wood, (u, v) => 3.4 - u * 1.4); s.poly([2, 10, 28, 10, 33, 14, 28, 18, 2, 18], C.wood, (x, y) => 3.9 - (y - 10) * .2 - (x % 9 === 0 ? 1 : 0)); s.poly([32, 22, 8, 22, 3, 26, 8, 30, 32, 30], C.old, (x, y) => 3.6 - (y - 22) * .2); for (let i = 0; i < 5; i++) { s.box(7 + i * 4, 13, 2, 2, C.dark, 1.4); s.box(10 + i * 4, 25, 2, 2, C.dark, 1.4); } return done(s, .4); }

// —— 集市和宴席上的东西 ——
// 斜放的一箱果子
function fruitCrate(band, seed, round = 2.2) {
  const s = S(30, 22), r = seq(seed); s.poly([0, 8, 29, 8, 27, 21, 2, 21], C.wood, (x, y) => 3.2 - (y - 8) * .12 - (y % 5 === 2 ? 1.6 : 0) - (x % 10 === 0 ? .8 : 0));
  for (let j = 0; j < 2; j++) for (let i = 0; i < 6; i++) s.orb(3.5 + i * 4.6 + j * 2, 6.5 - j * 3 + r(), round, round, band, 3.6, 2.6);
  return done(s, .5, C.husk, 4.6);
}
function basket(band, seed) { const s = S(22, 20), r = seq(seed); s.poly([1, 9, 20, 9, 17, 19, 4, 19], C.straw, (x, y) => 3 - (x - 1) / 19 * 1.4 + ((x + y) % 3 === 0 ? -1 : 0)); s.box(1, 8, 20, 2, C.hay, 4); for (let i = 0; i < 5; i++) s.orb(4 + i * 3.6, 6 - (i % 2) * 2.4, 2.3, 2.3, band, 3.7, 2.4); s.line(3, 8, 10, 0, C.hay, 2.6).line(10, 0, 18, 8, C.hay, 2.6); return done(s, .4, C.husk, 4.4); }
function bread() { const s = S(26, 16); s.poly([1, 8, 24, 8, 21, 15, 4, 15], C.straw, (x, y) => 2.8 + ((x + y) % 3 === 0 ? -1 : 0)); for (const [x, y, rx] of [[7, 6, 5.5], [17, 5, 6], [12, 3, 5]]) { s.orb(x, y, rx, 3.2, C.bread, 3.6, 2.2); s.line(x - 2, y - 1, x + 2, y - 2, C.husk, 4); } return done(s, .5, C.husk, 4.8); }
function pie() { const s = S(18, 10); s.poly([1, 5, 16, 5, 14, 9, 3, 9], C.iron, 2.6); s.orb(8.5, 4.5, 7.5, 3, C.bread, 3.8, 1.8); for (let i = 0; i < 4; i++) s.px(4 + i * 3, 4, C.barn, 3.4); return done(s, .5, C.husk, 4.8); }
function cheese() { const s = S(16, 11); s.poly([1, 4, 14, 2, 14, 10, 1, 10], C.mapleY, (x, y) => 3.8 - (y - 3) * .25); s.px(5, 7, C.mapleO, 2).px(10, 6, C.mapleO, 2).px(8, 9, C.mapleO, 2); return s.ink().canvas(); }
function jars() { const s = S(24, 13); [C.barn, C.mapleY, C.purple, C.mapleO].forEach((b, i) => { s.box(1 + i * 6, 4, 5, 9, b, (u, v) => 3.9 - u * 1.8).box(2 + i * 6, 2, 3, 2, C.cream, 3.4).px(2 + i * 6, 6, C.white, 4.5); }); return s.ink().canvas(); }
function mug() { const s = S(10, 10); s.box(1, 2, 6, 8, C.wood, (u, v) => 3.8 - u * 1.8).box(1, 4, 6, 1, C.iron, 2.6).box(1, 0, 6, 2, C.white, 4.2).box(7, 4, 2, 1, C.wood, 2.6).box(8, 5, 1, 3, C.wood, 2.6).box(7, 8, 2, 1, C.wood, 2.4); return s.ink().canvas(); }
function jug() { const s = S(12, 16); s.orb(5.5, 10, 5, 5.5, C.bread, 3.2, 2.4).box(4, 1, 4, 5, C.bread, (u, v) => 3.4 - u).box(3, 0, 6, 1, C.bread, 4).line(9, 4, 11, 7, C.bread, 2.4).line(11, 7, 9, 10, C.bread, 2.4); return s.ink().canvas(); }
function roast() { const s = S(22, 13); s.poly([0, 8, 21, 8, 18, 12, 3, 12], C.iron, 3); s.orb(10, 6, 7.5, 4.5, C.bread, 3, 2.6); s.line(17, 4, 21, 2, C.cream, 4, 2); s.px(6, 5, C.leaf, 3).px(13, 3, C.leaf, 3); return done(s, .5, C.husk, 4.6); }
// 挂着晾的一串：玉米、辣椒、蒜
function strand(kind, seed) {
  const s = S(12, 36), r = seq(seed); s.line(6, 0, 6, 30, C.dark, 2);
  for (let i = 0; i < 6; i++) { const y = 4 + i * 5, d = i % 2 ? 1 : -1;
    if (kind === 0) { s.orb(6 + d * 2.4, y + 2, 2.4, 3.4, C.mapleY, 3.8, 2).px(6 + d * 2, y - 1, C.husk, 4); }
    if (kind === 1) { s.line(6, y, 6 + d * 4, y + 5, C.red, 3.6 - i * .15, 2).px(6, y - 1, C.leaf, 3); }
    if (kind === 2) { s.orb(6 + d * 2, y + 2, 2.6, 2.6, C.cream, 4, 2); } }
  return s.ink().canvas();
}
function herbs() { const s = S(12, 18); for (let i = 0; i < 7; i++) s.line(6, 0, 1 + i * 1.6, 12 + (i % 3) * 2, i % 2 ? C.olive : C.purple, 3 - Math.abs(i - 3) * .3); s.box(4, 1, 4, 2, C.dark, 2.4); return s.ink().canvas(); }

// —— 灯 ——
// 纸灯笼（自发光的）：鼓肚子、几道竹篾、上下两个盖、底下一条穗
function paperLantern(band, seed) {
  const s = S(16, 24);
  s.each((x, y) => { const nx = (x - 7.5) / 7, ny = (y - 10) / 7.5, q = nx * nx + ny * ny; return q < 1 ? [band, 5.4 - q * 2.6 - (y % 3 === 0 ? .9 : 0)] : null; });
  s.box(5, 1, 6, 2, C.dark, 2.6).box(5, 17, 6, 2, C.dark, 2.4).box(7, 19, 2, 5, C.red, (u, v) => 3.8 - v * 1.4).box(7, 0, 2, 1, C.dark, 2);
  return s.canvas();
}
// 带玻璃罩的铁皮提灯
function lamp(band) { const s = S(12, 18); s.box(3, 0, 6, 1, C.iron, 2.4).poly([1, 5, 10, 5, 8, 2, 3, 2], C.iron, 2.8).box(2, 5, 8, 9, band, (u, v) => 5.6 - Math.abs(u - .5) * 3 - Math.abs(v - .5) * 1.6).box(1, 14, 10, 2, C.iron, 2.6).box(1, 5, 1, 9, C.iron, 2).box(10, 5, 1, 9, C.iron, 2).box(5, 5, 1, 9, C.iron, 1.8); return s.canvas(); }
function windowGlow(w = 14, h = 18, round = false) {
  const s = S(w, h);
  s.each((x, y) => { if (round && Math.hypot(x - w / 2 + .5, y - h / 2 + .5) > w / 2) return null; const e = Math.min(x, y, w - 1 - x, h - 1 - y); if (!round && e === 0) return [C.dark, 2.2]; if (x === (w >> 1) || y === (h >> 1)) return [C.dark, 2.6]; return [C.glow, 5.6 - Math.hypot((x - w / 2) / w, (y - h * .6) / h) * 4]; });
  return s.canvas();
}
// 火：一帧。k 是第几拍；形状用噪声算，火心白黄、往外橙、最外一圈红
function flame(k, w = 40, h = 56, seed = 7) {
  const s = S(w, h);
  s.each((x, y) => {
    const v = 1 - y / (h - 1), u = (x - w / 2 + .5) / (w / 2), sway = Math.sin(v * 5 + k * 1.3) * .2 * v + Math.sin(v * 11 + k * 2.9) * .08 * v;
    const wd = Math.pow(1 - v, .55) * (.74 + .2 * Math.sin(v * 8 - k * 1.57)) * (.75 + .5 * vn(x / 5, y / 6 + k * 1.7, seed)), d = Math.abs(u - sway) / Math.max(.02, wd);
    if (d > 1 || (v > .5 && vn(x / 3, y / 4 + k * 2.3, seed + 2) < (v - .5) * 1.1)) return null;
    const heat = (1 - d) * (1.15 - v * .8);
    return heat > .58 ? [C.husk, 6] : heat > .36 ? [C.glow, 4.6] : heat > .16 ? [C.fire, 3.6] : [C.barn, 3.2];
  });
  return s.canvas();
}
function candle(k) { const s = S(6, 10); s.orb(2.5 + (k % 2 ? .5 : -.3), 5.5, 2.2, 3.4 + (k % 3) * .4, C.glow, 5, 1.6).px(2 + (k & 1), 1 + (k % 3), C.fire, 4).px(2, 7, C.husk, 6).px(3, 6, C.husk, 6); return s.canvas(); }
// 篝火的柴堆：一圈石头，几根搭成尖塔的木头，底下一摊炭火
function fireLogs() {
  const s = S(56, 30);
  for (const [x0, x1] of [[8, 30], [48, 26], [18, 34], [38, 22], [28, 28]]) s.line(x0, 26, x1, 2, C.bark, k => 2.6 - k * 1.2, 4);
  for (let i = 0; i < 9; i++) s.px(18 + i * 2.4, 22 + (i % 3), C.fire, 4 + (i % 2));
  for (let i = 0; i < 9; i++) s.orb(4 + i * 6, 25 + (i % 2) * 1.5, 3.6, 3, i % 3 ? C.stone : C.warmStone, 3, 2.4);
  return done(s, .5, C.fire, 4);
}
// 一团烟（像素的，疏密用棋盘点）
function puff(n, seed) { const s = S(n, n); s.each((x, y) => { const d = Math.hypot(x - n / 2 + .5, y - n / 2 + .5) / (n / 2) + (cloud(x / 5, y / 5, seed, 2) - .5) * .8; return d < .95 && (d < .55 || (x + y) % 2 === 0) ? [C.stone, 3.6 - d * 1.6 - (y - n / 2) / n * 2] : null; }); return s.canvas(); }

// —— 人造的大件 ——
// 稻草人：木杆十字架、麻袋头、草帽、打补丁的格子衫。f = -1 / 0 / 1：袖子和衣角被风吹起的三个样子
function scarecrow(f) {
  const s = S(52, 86);
  s.box(25, 26, 3, 60, C.wood, (u, v) => 3.2 - u * 1.4).box(5, 35, 43, 3, C.wood, (u, v) => 3 - v * 1.2);
  for (const d of [-1, 1]) {                                                 // 袖子：从肩到手，手上一把草
    const hx = 26 + d * 21, hy = 37 + (d > 0 ? f : -f) * 4 + 2;
    for (let k = 0; k <= 20; k++) { const t = k / 20, x = 26 + d * (6 + t * 15), y = 33 + (hy - 35) * t * t; s.box(Math.round(x) - 1, Math.round(y), 3, Math.round(8 - t * 2 + Math.abs(f) * t * 2), C.barn, (u, v) => 3.2 - v * 1.6 + (k % 5 === 0 ? -.8 : 0)); }
    for (let k = 0; k < 6; k++) s.line(hx, hy + 2, hx + d * (3 + (k % 3)), hy - 2 + k * 2 + f, C.straw, 3.4 + (k % 2));
  }
  s.poly([17, 32, 36, 32, 39 + f, 60, 14 + f, 60], C.barn, (x, y) => 3 - (y - 32) * .05 - ((x >> 2) + (y >> 2)) % 2 * .9 - (x - 26) * .04);   // 格子衫
  s.box(20, 44, 6, 6, C.mapleY, 3.2).box(30, 38, 5, 5, C.teal, 2.6).box(25, 32, 3, 28, C.dark, 1.8);
  for (let i = 0; i < 12; i++) s.line(15 + i * 2 + f, 60, 14 + i * 2.1 + f * 2, 64 + (i % 3) * 2, C.straw, 3 + (i % 2));                        // 衣角下露出来的草
  s.orb(26, 22, 8, 8.5, C.straw, 3.2, 1.8); s.box(22, 20, 2, 3, C.dark, .6).box(29, 20, 2, 3, C.dark, .6); for (let i = 0; i < 7; i++) s.px(22 + i * 1.4, 26 + (i % 2), C.dark, .8);
  s.box(21, 29, 11, 2, C.dark, 2.4);
  s.poly([11, 15, 41, 15, 38, 12, 14, 12], C.hay, 3.4).poly([18, 12, 34, 12, 31, 3, 21, 3], C.hay, (x, y) => 4 - (y - 3) * .15 - (x - 18) * .05).box(19, 10, 15, 2, C.barn, 3.4);
  for (let i = 0; i < 5; i++) s.px(11 + i * 7 + f, 16, C.straw, 4);
  return done(s, .6, C.husk, 4.6);
}
// 乌鸦：蹲着的、飞着的两拍
function crow(k) {
  if (k < 0) { const s = S(14, 13); s.orb(7, 7, 5, 4, C.night, 1.6, 2).orb(10, 3.5, 2.6, 2.6, C.night, 1.8, 2).px(13, 4, C.mapleY, 3).px(10, 3, C.glow, 4).line(1, 9, 3, 7, C.night, 1).box(6, 11, 1, 2, C.mapleY, 2).box(8, 11, 1, 2, C.mapleY, 2); return s.canvas(); }
  const s = S(24, 14); s.orb(12, 8, 4.5, 2.4, C.night, 1.8, 2).px(17, 7, C.mapleY, 3).px(16, 7, C.night, 2);
  for (const d of [-1, 1]) s.poly(k ? [12, 7, 12 + d * 11, 11, 12 + d * 7, 12, 12 + d * 3, 9] : [12, 8, 12 + d * 10, 1, 12 + d * 11, 4, 12 + d * 4, 9], C.night, (x, y) => 1.4 + (y < 5 ? 1 : 0));
  return s.canvas();
}
function hen(k) { const s = S(18, 16); s.orb(8, 9, 6, 4.6, C.white, 3.2, 2.2).poly([1, 4, 5, 6, 4, 10], C.white, 3.6); const hx = k ? 14 : 13, hy = k ? 9 : 4; s.orb(hx, hy, 2.6, 2.6, C.white, 3.6, 2).px(hx + 3, hy, C.mapleY, 3.4).px(hx, hy - 3, C.red, 3.4).px(hx + 1, hy - 3, C.red, 3.4).px(hx + 1, hy, C.night, 0).box(7, 13, 1, 3, C.mapleY, 2.6).box(10, 13, 1, 3, C.mapleY, 2.6); return s.ink().canvas(); }
// 风向鸡：k = 0 / 1 / 2 三个朝向（侧 / 斜 / 正）
function weathercock(k) {
  const s = S(26, 30), w = [1, .55, .16][k];
  s.box(12, 12, 2, 18, C.iron, 2.6).box(5, 20, 16, 1, C.iron, 2.4).box(12, 16, 2, 1, C.iron, 3.6);
  s.poly([13 - 9 * w, 8, 13 + 5 * w, 11, 13 + 9 * w, 5, 13 + 6 * w, 2, 13 + 2 * w, 7, 13 - 6 * w, 3], C.mapleY, (x, y) => 4 - (y - 2) * .22);
  s.px(13 + 9 * w, 3, C.red, 3.6).px(13 + 10 * w, 6, C.pumpkin, 3.4); return s.ink().canvas();
}
// 小旗（三角的彩旗）和屋脊上的队旗（三拍飘动）
function pennant(band) { const s = S(10, 14); for (let y = 0; y < 14; y++) { const hw = 5 * (1 - y / 14); for (let x = Math.ceil(5 - hw); x < 5 + hw; x++) s.px(x, y, band, 3.9 - y * .09 - (x - 5) * .16 - (y === 0 ? 1.4 : 0)); } return s.canvas(); }
function teamFlag(band, k) {
  const s = S(34, 24);
  for (let x = 0; x < 32; x++) { const dy = Math.round(Math.sin(x * .42 - k * 2.1) * (1 + x * .07)), notch = x > 24 ? (x - 24) * .9 : 0; for (let y = 0; y < 16; y++) { if (Math.abs(y - 7.5) < notch * .5) continue; s.px(x + 1, 4 + y + dy, y === 3 || y === 12 ? C.husk : band, 3.4 + Math.cos(x * .42 - k * 2.1) * 1 - y * .05); } }
  return s.ink().canvas();
}
// 铺在门槛上的队伍色毯子（躺着的）：朝棋盘那一头一个箭头
function mat(band, dir) {
  const w = 30, h = 42, s = S(w, h);
  s.each((x, y) => { const e = Math.min(x, y, w - 1 - x, h - 1 - y); if (e === 0) return (x + y) % 2 ? [C.husk, 3.4] : null; if (e < 3) return [band, e === 1 ? 4.2 : 1.8]; const ax = dir > 0 ? x - 8 : w - 9 - x, ay = Math.abs(y - h / 2 + .5); if (ax >= 0 && ax < 13 && Math.abs(ay - (13 - ax) * .8) < 1.6) return [C.husk, 4]; return [band, 2.7 + ((x >> 1) + (y >> 1)) % 2 * .7]; });
  return s.canvas();
}
// 石磨盘
function millstone() { const s = S(28, 28); s.each((x, y) => { const d = Math.hypot(x - 13.5, y - 13.5), a = Math.atan2(y - 13.5, x - 13.5); return d > 13.5 ? null : d < 2.4 ? [C.dark, 1] : [C.stone, 3.6 - (y - 13.5) / 13 * 1.8 - (Math.abs(((a * 4 / PI) % 1 + 1) % 1 - .5) < .1 && d > 5 ? 1.3 : 0) - (d > 12 ? .9 : 0)]; }); return done(s, .5, C.husk, 4.4); }
// 谷仓的门扇（白边 + 白色斜撑）和阁楼的小门
function barnDoor(w = 22, h = 52) { const s = S(w, h); s.each((x, y) => { const e = Math.min(x, y, w - 1 - x, h - 1 - y), cross = Math.abs((x / w) - (y % (h / 2)) / (h / 2)) < .09 || Math.abs((1 - x / w) - (y % (h / 2)) / (h / 2)) < .09 || Math.abs(y - h / 2) < 1.5; return e < 2 || cross ? [C.cream, 3.6 - (e === 0 ? 1.4 : 0)] : [C.barn, 2.8 - (x % 5 === 0 ? 1.2 : 0) + (rnd2(x, y, 3) - .5) * .6]; }); return s.canvas(); }
// 月亮：橙色的大圆盘，上亮下暗，几块暗斑
function moon(n = 96) { const s = S(n, n), c = n / 2 - .5; s.each((x, y) => { const d = Math.hypot(x - c, y - c); if (d > c) return null; const sea = cloud(x / 16, y / 16, 77, 3); return [MOON, 4.6 - (y - c) / c * 1.2 - (sea > .56 ? 1.2 : 0) - (d > c - 3 ? .8 : 0)]; }); return s.canvas(); }
// 木栅栏的一段：两根桩 + 两道横杆（往旁边接得上）
function fence(seed, w = 48, h = 26) {
  const s = S(w, h);
  for (const y of [7, 15]) s.box(0, y, w, 3, C.old, (u, v, x) => 3.6 - v * 1.2 + (vn(x / 6, y, seed) - .5) * 1.2);
  for (const x of [4, 28]) { s.box(x, 1, 4, h - 1, C.wood, (u, v) => 3.4 - u * 1.4 - v * .6); s.px(x + 1, 0, C.wood, 4).px(x + 2, 0, C.wood, 4); }
  return done(s, .5, C.husk, 4.4);
}
// 流下来的水：四拍，一道道亮纹往下走；水花两拍
function fall(k, w = 16, h = 48) { const s = S(w, h); s.each((x, y) => { const st = rnd2(x, 0, 5), ph = ((y - k * 4 + st * 16) % 16 + 16) % 16; return [C.water, (ph < 3 ? 5.4 : ph < 8 ? 4 : 2.8) + (x === 0 || x === w - 1 ? -1 : 0) + (st < .25 ? .8 : 0)]; }); return s.canvas(); }
function foam(k) { const s = S(30, 11); for (let i = 0; i < 9; i++) { const x = 3 + i * 3 + ((i + k) % 2), y = 6 - Math.round(Math.sin(i * 1.3 + k * PI) * 2.5 + 2); s.orb(x, y + 2, 2.4, 2.2, C.white, 4.2, 1.2); if ((i + k) % 3 === 0) s.px(x, y - 3, C.white, 5); } return s.canvas(); }

export function sprites() {
  const O = {};
  O.wheatA = wheat(3); O.wheatB = wheat(9); O.wheatFg = wheat(17, 72, 60, true); O.wheatC = wheat(23, 48, 44, true);
  O.mapleR = maple(C.mapleR, C.mapleO, 11); O.mapleO = maple(C.mapleO, C.mapleY, 23); O.mapleY = maple(C.mapleY, C.mapleO, 37); O.apple = appleTree(5);
  O.bushR = bush(C.mapleR, C.mapleO, 3); O.bushO = bush(C.mapleO, C.mapleY, 5); O.bushG = bush(C.leaf, C.olive, 7, 52, 32);
  O.tuftD0 = tuft(C.straw, 1); O.tuftD1 = tuft(C.hay, 2, 24, 16, 11); O.tuftG = tuft(C.moss, 3); O.tuftW = tuft(C.wheat, 4, 18, 20, 8);
  O.aster = flowers(C.purple, 1); O.marigold = flowers(C.mapleO, 2); O.daisy = flowers(C.white, 3, 18, 14, 1.4);
  O.sunflower = sunflower(1); O.cattail = cattail(2); O.mushroom = mushroom(); O.rock0 = rock(1); O.rock1 = rock(4, 14, 10); O.rock2 = rock(7, 32, 20);
  O.pumpS = pumpkin(14, 11, C.pumpkin, false, 1); O.pumpM = pumpkin(22, 17, C.pumpkin, false, 2); O.pumpL = pumpkin(32, 25, C.mapleO, false, 3); O.pumpW = pumpkin(18, 13, C.cream, false, 4); O.pumpG = pumpkin(20, 14, C.olive, false, 5);
  O.jackM = pumpkin(24, 19, C.pumpkin, true, 6); O.jackL = pumpkin(42, 34, C.pumpkin, true, 7); O.jackFaceM = jackFace(24, 19); O.jackFaceL = jackFace(42, 34);
  O.sheaf = sheaf(1); O.sheafB = sheaf(5); O.shock = shock(2); O.haystack = haystack(3);
  O.sack = sack(C.straw, false, 1); O.sackOpen = sack(C.straw, true, 2); O.flour = sack(C.cream, false, 3);
  O.fork = tool(0); O.scythe = tool(1); O.rake = tool(2); O.ladder = ladder(); O.wheel = wheel(); O.bucket = bucket(); O.milk = milkCan(); O.hive = beehive(); O.stump = stump(); O.logs = logPile(); O.sign = signpost(); O.millstone = millstone();
  O.crApple = fruitCrate(C.apple, 1); O.crPear = fruitCrate(C.moss, 2); O.crOrange = fruitCrate(C.mapleO, 3); O.crGrape = fruitCrate(C.purple, 4, 1.8);
  O.bskApple = basket(C.apple, 1); O.bskPear = basket(C.mapleY, 2); O.bread = bread(); O.pie = pie(); O.cheese = cheese(); O.jars = jars(); O.mug = mug(); O.jug = jug(); O.roast = roast();
  O.corn = strand(0, 1); O.chili = strand(1, 2); O.garlic = strand(2, 3); O.herbs = herbs();
  O.plO = paperLantern(C.paper, 1); O.plR = paperLantern(C.red, 2); O.plC = paperLantern(C.glow, 3); O.lampW = lamp(C.glow); O.lampT = lamp(C.teal); O.lampR = lamp(C.red);
  O.win = windowGlow(); O.winS = windowGlow(10, 12); O.winRound = windowGlow(14, 14, true);
  for (let k = 0; k < 6; k++) O['flame' + k] = flame(k); for (let k = 0; k < 4; k++) O['cand' + k] = candle(k);
  O.fireLogs = fireLogs(); O.puff0 = puff(16, 1); O.puff1 = puff(24, 2); O.puff2 = puff(32, 3);
  for (const f of [-1, 0, 1]) O['scare' + (f + 1)] = scarecrow(f);
  O.crowSit = crow(-1); O.crow0 = crow(0); O.crow1 = crow(1); O.hen0 = hen(0); O.hen1 = hen(1); for (let k = 0; k < 3; k++) O['cock' + k] = weathercock(k);
  [C.teal, C.red, C.mapleY, C.cream, C.pumpkin, C.purple].forEach((b, i) => { O['pen' + i] = pennant(b); });
  for (let k = 0; k < 3; k++) { O['flagOwn' + k] = teamFlag(C.teal, k); O['flagFoe' + k] = teamFlag(C.red, k); }
  O.matOwn = mat(C.teal, 1); O.matFoe = mat(C.red, -1); O.barnDoor = barnDoor(); O.loftDoor = barnDoor(26, 22); O.moon = moon();
  O.fenceA = fence(1); O.fenceB = fence(2); for (let k = 0; k < 4; k++) O['fall' + k] = fall(k); O.foam0 = foam(0); O.foam1 = foam(1);
  // 最小的那些：灯泡、火星 / 萤火 / 烟花的点、落叶两拍
  { const b = S(6, 7); b.orb(2.5, 3.5, 2.6, 3, C.white, 5, 1).box(2, 0, 2, 1, C.dark, 2); O.bulb = b.canvas(); }
  { const d = S(2, 2); d.box(0, 0, 2, 2, C.white, 6); O.dot = d.canvas(); const e = S(5, 5); e.box(1, 1, 3, 3, C.white, 5).px(2, 0, C.white, 4).px(2, 4, C.white, 4).px(0, 2, C.white, 4).px(4, 2, C.white, 4).px(2, 2, C.white, 6); O.star = e.canvas(); }
  [C.mapleR, C.mapleO, C.mapleY].forEach((b, i) => { const a = S(7, 6); a.poly([0, 3, 3, 0, 6, 2, 4, 5, 1, 5], b, (x, y) => 4 - y * .4).px(3, 3, b, 2); O['leaf' + i + 'a'] = a.canvas(); const c = S(7, 4); c.poly([0, 2, 3, 0, 6, 1, 3, 3], b, (x, y) => 3.4 - y * .5); O['leaf' + i + 'b'] = c.canvas(); });
  return O;
}
// 软光斑（叠加用，白的，颜色由顶点色给）
export function halo(n = 64) { return soft(n, (u, v) => { const d = Math.hypot(u, v), a = Math.max(0, 1 - d); return [1, 1, 1, a * a * (.6 + .4 * a)]; }); }
