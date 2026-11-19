// 《云上浮岛》的小件：一件一张小像素图（Pix），arena.js 把它们拼成一张图集。
// 这里只画地上、岛上、天上的“东西”（树、屋、旗、风筝、飞艇、鸟、水晶……）；云和光晕在 sky.js。
import { Pix, hash, hash2, fbm, rgb, mix, tone, ramp, pick, ball, heap, INK } from './paint.js';

const P = (w, h, fn) => { const p = new Pix(w, h); fn(p); return p; };
const R = (base, n = 5, lo = -1, hi = .9) => ramp(base, n, lo, hi);
const GOLD = '#ffe08a';                                 // 朝阳那一侧的金边
const STONE = R('#d6cfc0', 6, -1, .8), WOOD = R('#a8703f', 6), DARKW = R('#6a4436', 5), BRASS = R('#e0a83c', 5), ROPE = R('#c9a46c', 4), IRON = R('#56608a', 5), PLASTER = R('#f0e2c2', 6, -1, .7);
const flat = (p, x, y, w, h, rp, t0 = .55, k = 0) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p.set(x + i, y + j, pick(rp, t0 - i / w * .25 + (hash2(x + i, y + j, k) - .5) * .14, x + i, y + j)); };   // 一块左亮右暗的面

// —— 树、灌木、花草 ——
function tree(w, h, leaf, seed, bloom) {   // 圆冠的树；bloom 给颜色就开一树花
  return P(w, h, p => {
    const ch = Math.round(h * .74), tw = Math.max(4, Math.round(w * .13)), tx = (w - tw) >> 1, rp = R(leaf, 6);
    for (let y = Math.round(ch * .6); y < h; y++) { const fl = y > h - 4 ? h - y < 2 ? 2 : 1 : 0; for (let x = tx - fl; x < tx + tw + fl; x++) p.set(x, y, pick(DARKW, .8 - (x - tx) / tw * .7 + (hash2(x, y >> 1, seed) - .5) * .25, x, y)); }
    const bs = [ball(w / 2, ch * .52, w * .3, ch * .3)];
    for (let i = 0; i < 9; i++) { const a = i / 9 * 6.283 + hash(i, seed) * .5; bs.push(ball(w / 2 + Math.cos(a) * w * .27, ch * .5 + Math.sin(a) * ch * .25, w * (.17 + hash(i, seed + 1) * .07), ch * (.17 + hash(i, seed + 2) * .07))); }
    p.relief(heap(bs), rp, { y1: ch + 2, k: 1, grit: .3, seed, soft: 1, bias: .04, shade: (x, y) => (fbm(x / 5, y / 5, seed + 5) - .5) * .5 });
    if (bloom) { const rb = R(bloom, 5, -.5, .8); for (let i = 0; i < w * h * .16; i++) { const x = Math.floor(hash(i, seed + 9) * w), y = Math.floor(hash(i, seed + 10) * ch); if (p.has(x, y)) { const t = .5 + hash(i, seed + 11) * .5 - (x / w + y / ch) * .25; p.set(x, y, pick(rb, t, x, y)); if (hash(i, seed + 12) > .5) p.set(x + 1, y, pick(rb, t - .1, x, y)); } } }
    p.outline().rim(GOLD, .55);
  });
}
function cypress(w, h, seed) {   // 细高的塔柏
  return P(w, h, p => { const rp = R('#2f8a5c', 6);
    p.rect((w >> 1) - 1, h - 6, 3, 6, DARKW[1]);
    p.relief((x, y) => { const v = y / (h - 5), half = (w / 2 - 1) * Math.sin(Math.min(1, v * 1.15) * 1.6) * (.85 + fbm(x / 3, y / 4, seed) * .3); const d = Math.abs(x + .5 - w / 2) / Math.max(.5, half); return v > 1 || d >= 1 ? 0 : Math.sqrt(1 - d * d) * 7; }, rp, { k: 1.1, grit: .35, seed, soft: 1 });
    p.outline().rim(GOLD, .5); });
}
function bush(w, h, leaf, seed, dots) {
  return P(w, h, p => { const bs = []; for (let i = 0; i < 5; i++) bs.push(ball(w * (.2 + i * .15), h - h * (.3 + hash(i, seed) * .15), w * .2, h * (.36 + hash(i, seed + 1) * .2)));
    p.relief(heap(bs), R(leaf, 6), { k: 1, grit: .3, seed, soft: 1, bias: .05 });
    if (dots) for (let i = 0; i < w * .5; i++) { const x = Math.floor(hash(i, seed + 3) * w), y = Math.floor(hash(i, seed + 4) * h); if (p.has(x, y)) { p.set(x, y, rgb(dots)); if (i % 3 === 0) p.set(x + 1, y, tone(dots, .6)); } }
    p.outline().rim(GOLD, .45); });
}
function tuft(seed, tall) {   // 一撮草：几根往右歪的叶子
  const w = 13, h = tall ? 13 : 9;
  return P(w, h, p => { const g = ['#2a7c50', '#44a548', '#7cc844', '#c2e65a'].map(rgb);
    for (let i = 0; i < 6; i++) { const x0 = 2 + i * 1.7 + hash(i, seed) * 1.5, len = h * (.5 + hash(i, seed + 1) * .5), lean = (hash(i, seed + 2) - .25) * 3; for (let k = 0; k < len; k++) { const u = k / len; p.set(x0 + lean * u * u, h - 1 - k, g[u > .75 ? 3 : u > .4 ? 2 : i % 2 ? 1 : 0]); } } });
}
function flower(seed, petal, heart) {   // 一小丛花：三四朵
  return P(13, 12, p => { const g = ['#2a7c50', '#44a548', '#7cc844'].map(rgb), c = rgb(petal), c2 = tone(petal, .5), hc = rgb(heart);
    for (let i = 0; i < 4; i++) { const x = 2 + i * 3 + Math.round(hash(i, seed) * 1), top = 1 + Math.round(hash(i, seed + 1) * 4); for (let y = top + 2; y < 12; y++) p.set(x + (y > 9 ? 0 : 0), y, g[y % 2]); if (i % 2) p.set(x + 1, 8, g[2]);
      p.set(x - 1, top + 1, c); p.set(x + 1, top + 1, c); p.set(x, top, c2); p.set(x, top + 2, c); p.set(x, top + 1, hc); } });
}
function reed(seed) {   // 水边的蒲草
  return P(11, 18, p => { const g = ['#2a7c50', '#44a548', '#8fd246'].map(rgb); for (let i = 0; i < 4; i++) { const x = 1 + i * 3, l = 9 + hash(i, seed) * 8; for (let k = 0; k < l; k++) p.set(x + (k > l * .6 ? 1 : 0), 17 - k, g[k > l * .7 ? 2 : 1]); if (i % 2 === 0) p.rect(x + 1, 17 - l - 1, 1, 4, rgb('#8a5a3a')); } });
}
function rock(w, h, seed, moss) {
  return P(w, h, p => { const bs = []; for (let i = 0; i < 4; i++) bs.push(ball(w * (.25 + i * .17), h - h * (.3 + hash(i, seed) * .2), w * (.2 + hash(i, seed + 1) * .1), h * (.4 + hash(i, seed + 2) * .25)));
    p.relief(heap(bs), STONE, { k: .9, grit: .25, seed, soft: .9 });
    if (moss) p.each((x, y) => (fbm(x / 4, y / 3, seed + 4) > .56 && y < h * .6 ? pick(R('#4aa848', 4), .6 - y / h * .5, x, y) : null));
    p.outline().rim(GOLD, .5); });
}

// —— 石头的小件 ——
function rail() {   // 一段栏杆：扶手、宝瓶柱、底石。左右能接上
  return P(48, 21, p => { p.slab(0, 0, 48, 4, '#e2dccc'); p.slab(0, 17, 48, 4, '#cfc7b6');
    for (let i = 0; i < 6; i++) { const x = i * 8 + 2; for (let y = 4; y < 17; y++) { const v = (y - 4) / 13, hw = v < .15 ? 1 : v < .7 ? 1 + Math.round(Math.sin((v - .15) / .55 * 3.14) * 1.2) : 1; for (let dx = -hw; dx <= hw; dx++) p.set(x + 1 + dx, y, pick(STONE, .72 - (dx + hw) / (hw * 2 + 1) * .5, x + dx, y)); } }
    for (let x = 0; x < 48; x++) if (x % 8 === 7) p.set(x, 2, rgb('#b8ae9a')); });
}
function post(h = 30, lamp) {   // 栏杆的望柱，顶上一颗铜球（lamp：顶上换成一盏小灯）
  return P(12, h, p => { p.slab(1, 8, 10, h - 8, '#dcd5c5'); p.slab(0, h - 4, 12, 4, '#cfc7b6'); p.slab(0, 7, 12, 3, '#e6e0d0'); p.rect(4, 13, 4, h - 20, tone('#d6cfc0', -.25)); p.rect(4, 13, 1, h - 20, tone('#d6cfc0', -.5));
    if (lamp) { p.slab(3, 1, 6, 6, lamp); p.rect(4, 2, 3, 3, tone(lamp, .9)); p.rect(4, 0, 4, 1, BRASS[2]); } else p.relief(ball(6, 4, 3.6), BRASS, { y1: 8, k: .7 });
    p.outline(); });
}
function arch() {   // 白石拱门：两根柱子托一道拱，拱心一块铜的风纹，底下挂一口小钟
  const W = 104, H = 112, cx = 52, cy = 54, ro = 46, ri = 31;
  return P(W, H, p => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x + .5 - cx, dy = y + .5 - cy, r = Math.hypot(dx, dy); let on = false, t = .62, joint = false;
      if (y < cy && r < ro && r > ri) { on = true; const a = Math.atan2(-dy, dx), seg = a / 3.1416 * 9; joint = Math.abs(seg - Math.round(seg)) < .045; t += (ro - r) / (ro - ri) * -.22 + .1 + (Math.floor(seg) % 2 ? .05 : -.03); if (r > ro - 2) t += .22; if (r < ri + 2) t -= .28; }
      else if (y >= cy && (Math.abs(dx) < ro && Math.abs(dx) > ri)) { on = true; const lx = Math.abs(dx) - ri; joint = (y - cy) % 14 === 0; t += (dx < 0 ? 1 : -1) * 0 - lx / 15 * .3 * (dx < 0 ? 1 : -1) * -1 - .1; if (lx < 1.5) t += dx < 0 ? -.3 : .2; if (lx > 13.5) t += dx < 0 ? .25 : -.3; }
      if (!on) continue; t += (fbm(x / 6, y / 6, 7) - .5) * .25; if (joint) t = .16; p.set(x, y, pick(STONE, t, x, y, .8)); }
    for (const sx of [cx - ro - 2, cx + ri - 2]) { p.slab(sx, H - 7, 19, 7, '#cfc7b6'); p.slab(sx, cy - 3, 19, 5, '#e6e0d0'); }   // 柱础、柱头
    p.relief(ball(cx, 9, 8, 9, 1.2), BRASS, { x0: cx - 9, x1: cx + 9, y0: 0, y1: 19, k: .9 });                                      // 拱心的铜牌
    for (let a = 0; a < 7; a += .2) p.set(cx + Math.cos(a) * (1 + a * .7), 9 + Math.sin(a) * (1 + a * .7), BRASS[0]);
    p.line(cx, cy - ri, cx, cy - ri + 9, ROPE[1]); p.relief(ball(cx, cy - ri + 15, 6, 7, 1.2), BRASS, { x0: cx - 7, x1: cx + 7, y0: cy - ri + 9, y1: cy - ri + 21, k: .9 }); p.rect(cx - 7, cy - ri + 20, 14, 2, BRASS[1]); p.rect(cx - 1, cy - ri + 22, 2, 3, BRASS[0]);
    for (let i = 0; i < 26; i++) { const a = hash(i, 5) * 3.14, r = ro - 1, x = cx + Math.cos(a) * r, y = cy - Math.sin(a) * r; if (hash(i, 6) > .5) { p.set(x, y, rgb('#4aa848')); p.set(x + 1, y + 1, rgb('#2f8a54')); p.set(x, y + 2, rgb('#62bd44')); } }   // 拱背上的青苔
    p.outline().rim(GOLD, .5); });
}
function lantern() {   // 小石灯：亮的那格另有一张光片叠在上面
  return P(16, 30, p => { p.slab(3, 25, 10, 5, '#cfc7b6'); p.slab(6, 15, 4, 10, '#d6cfc0'); p.slab(2, 7, 12, 8, '#dcd5c5'); p.rect(5, 9, 6, 5, rgb('#ffd870')); p.rect(6, 10, 4, 3, rgb('#fff6c8')); p.rect(8, 9, 1, 5, tone('#d6cfc0', -.3));
    p.poly([[0, 7], [16, 7], [11, 2], [5, 2]], rgb('#b9b2a4')); for (let x = 1; x < 15; x++) p.set(x, 6, tone('#d6cfc0', -.5)); p.rect(6, 0, 4, 2, BRASS[2]); p.outline().rim(GOLD, .5); });
}
function stepStone(seed) { return P(18, 12, p => { p.relief(ball(9, 6, 8.5, 5.5, .5), STONE, { k: 1.4, grit: .2, seed, bias: .02 }); p.each((x, y) => (fbm(x / 3, y / 3, seed) > .62 ? rgb('#62bd44') : null)); }); }
function well() {   // 泉眼的石盆：一圈石沿，里面是水
  return P(34, 26, p => { for (let y = 0; y < 26; y++) for (let x = 0; x < 34; x++) { const u = (x + .5 - 17) / 17, v = (y + .5 - 11) / 10.5, d = u * u + v * v, v2 = (y + .5 - 15) / 10.5, d2 = u * u + v2 * v2; if (d < 1) { if (d > .58) p.set(x, y, pick(STONE, .8 - (u + v) * .22 + (hash2(x, y, 3) - .5) * .12, x, y)); else p.set(x, y, pick(['#2c7ed0', '#58b4ee', '#a8e0fa', '#ffffff'].map(rgb), .3 + (fbm(x / 3, y / 2, 4) - .4) * 1.1 - v * .2, x, y)); } else if (d2 < 1) p.set(x, y, pick(STONE, .42 - u * .25 - (y - 15) / 22 + ((x >> 2) % 2) * .06, x, y)); }
    p.outline().rim(GOLD, .45); });
}

// —— 木头、货物、码头上的东西 ——
function crate(w, h, seed, band) {
  return P(w, h, p => { flat(p, 0, 0, w, h, WOOD, .62, seed); for (let y = 0; y < h; y += 6) p.rect(0, y, w, 1, DARKW[1]); p.slab(0, 0, w, h, '#a8703f'); flat(p, 1, 1, w - 2, h - 2, WOOD, .6, seed);
    for (let y = 5; y < h - 2; y += 5) p.rect(1, y, w - 2, 1, WOOD[1]); p.rect(0, 0, w, 3, WOOD[4]); p.rect(0, h - 3, w, 3, WOOD[1]); p.rect(0, 0, 3, h, WOOD[4]); p.rect(w - 3, 0, 3, h, WOOD[1]);
    for (let i = 3; i < w - 3; i++) p.set(i, Math.round(3 + (i - 3) / (w - 6) * (h - 7)), WOOD[2]);
    if (band) p.rect(4, (h >> 1) - 2, w - 8, 4, rgb(band)); for (const [x, y] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]]) p.set(x, y, IRON[1]); p.outline(); });
}
function barrel(seed, band = '#56608a') {
  return P(16, 22, p => { for (let y = 0; y < 22; y++) { const hw = 6 + Math.round(Math.sin(y / 21 * 3.14) * 1.6); for (let x = 8 - hw; x < 8 + hw; x++) p.set(x, y, pick(WOOD, .78 - (x - 8 + hw) / (hw * 2) * .6 + ((x + 1) % 3 === 0 ? -.12 : 0), x, y)); }
    for (const y of [3, 4, 17, 18]) for (let x = 0; x < 16; x++) if (p.has(x, y)) p.set(x, y, pick(R(band, 4), .8 - x / 16 * .6, x, y)); p.rect(3, 0, 10, 1, WOOD[5]); p.outline().rim(GOLD, .4); });
}
function sack(seed) { return P(18, 15, p => { p.relief(heap([ball(9, 9, 8.5, 6.5), ball(9, 3, 3, 3)]), R('#e0cfa0', 5), { k: .9, grit: .2, seed }); p.rect(7, 4, 4, 1, ROPE[0]); p.outline().rim(GOLD, .4); }); }
function coil() { return P(16, 9, p => { for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) { const u = (x + .5 - 8) / 8, v = (y + .5 - 4.5) / 4.5, d = u * u + v * v; if (d < 1 && d > .12) p.set(x, y, pick(ROPE, .7 - u * .3 - v * .2 + (Math.floor(Math.sqrt(d) * 5) % 2) * -.18, x, y)); } p.outline(); }); }
function bollard() { return P(11, 17, p => { p.slab(3, 4, 5, 13, '#56608a'); p.slab(1, 1, 9, 4, '#6a74a0'); p.rect(0, 15, 11, 2, IRON[1]); p.line(2, 8, 8, 9, ROPE[2]); p.line(2, 10, 8, 11, ROPE[1]); p.outline().rim(GOLD, .4); }); }
function scope() {   // 三脚架上的黄铜望远镜，镜筒朝左上（朝着太阳和远处的岛）
  return P(30, 40, p => { p.line(15, 18, 5, 39, DARKW[2]); p.line(15, 18, 24, 39, DARKW[1]); p.line(15, 18, 15, 39, DARKW[3]); p.line(8, 32, 22, 32, DARKW[1]);
    for (let i = 0; i < 24; i++) { const x = 3 + i, y = 6 + i * .55, r = i < 8 ? 3 : i < 17 ? 2.4 : 1.8; for (let k = -r; k <= r; k++) p.set(x, y + k, pick(BRASS, .85 - (k + r) / (2 * r) * .7, x, Math.round(y + k))); }
    p.rect(10, 8, 1, 6, BRASS[0]); p.rect(19, 13, 1, 5, BRASS[0]); p.rect(2, 3, 2, 7, rgb('#a8e0fa')); p.set(2, 4, rgb('#ffffff')); p.rect(26, 18, 3, 3, IRON[1]); p.outline().rim(GOLD, .4); });
}
function ladder() { return P(12, 64, p => { for (let y = 0; y < 64; y++) { const s = Math.round(Math.sin(y * .12) * 1); p.set(1 + s, y, ROPE[y % 3 ? 2 : 1]); p.set(10 + s, y, ROPE[y % 3 ? 1 : 0]); if (y % 7 === 3) for (let x = 2; x < 10; x++) { p.set(x + s, y, WOOD[4]); p.set(x + s, y + 1, WOOD[1]); } } }); }
function anchor() { return P(18, 24, p => { p.rect(8, 3, 2, 18, IRON[2]); p.rect(4, 7, 10, 2, IRON[3]); for (let a = 0; a <= 3.15; a += .12) { p.set(9 + Math.cos(a) * 7, 15 + Math.sin(a) * 7, IRON[2]); p.set(9 + Math.cos(a) * 6, 15 + Math.sin(a) * 6, IRON[1]); } p.disc(9, 2.5, 2.5, IRON[3]); p.set(8, 2, rgb('#1a2042')); p.set(9, 2, rgb('#1a2042')); p.outline().rim(GOLD, .4); }); }
function cart() {   // 运货的小推车
  return P(36, 22, p => { p.slab(4, 4, 26, 9, '#a8703f'); for (let x = 9; x < 30; x += 5) p.rect(x, 5, 1, 7, WOOD[1]); p.line(30, 9, 35, 4, DARKW[2]); p.relief(heap([ball(12, 5, 6, 4), ball(21, 5, 6, 5)]), R('#e0cfa0', 5), { y1: 7, k: .9 });
    for (let y = 9; y < 22; y++) for (let x = 6; x < 20; x++) { const d = Math.hypot(x + .5 - 13, y + .5 - 15); if (d < 6.5) p.set(x, y, d > 4.8 ? DARKW[1] : d < 1.5 ? BRASS[2] : (Math.abs(x - 13) < 1 || Math.abs(y - 15) < 1) ? DARKW[2] : WOOD[2]); }
    p.rect(26, 13, 2, 9, DARKW[1]); p.outline().rim(GOLD, .4); });
}
function fence() {   // 码头边的绳栏：木桩之间垂着两道绳
  return P(48, 18, p => { for (let x = 0; x < 48; x++) { const u = (x % 24) / 24, sag = Math.round(Math.sin(u * 3.14) * 3); p.set(x, 3 + sag, ROPE[2]); p.set(x, 4 + sag, ROPE[0]); p.set(x, 9 + sag, ROPE[1]); } for (const x of [0, 24]) { p.slab(x, 0, 4, 18, '#8a5a3a'); p.rect(x, 0, 4, 2, WOOD[5]); } p.outline(); });
}
function signpost() {   // 岔路口的路牌
  return P(26, 34, p => { p.rect(12, 4, 3, 30, DARKW[2]); p.set(12, 5, DARKW[4]); p.slab(2, 6, 20, 7, '#b88050'); p.poly([[22, 6], [26, 9.5], [22, 13]], WOOD[2]); p.slab(6, 16, 18, 6, '#a8703f'); p.poly([[6, 16], [2, 19], [6, 22]], WOOD[3]); for (let x = 5; x < 20; x += 3) p.set(x, 9, DARKW[0]); for (let x = 9; x < 22; x += 3) p.set(x, 19, DARKW[0]); p.outline().rim(GOLD, .4); });
}
function bench() { return P(28, 14, p => { p.slab(0, 5, 28, 4, '#b88050'); p.slab(1, 0, 26, 3, '#a8703f'); p.rect(3, 3, 2, 11, DARKW[2]); p.rect(23, 3, 2, 11, DARKW[1]); p.outline(); }); }

// —— 屋子、风车、灯塔（都是给卫星小岛用的，比例比主岛的小一号） ——
function roofRows(p, pts, base, seed) {   // 一片梯形的瓦顶：pts = [左下, 右下, 右上, 左上]
  const rp = R(base, 6), [a, b, c, d] = pts, y0 = Math.min(c[1], d[1]), y1 = Math.max(a[1], b[1]);
  for (let y = y0; y <= y1; y++) { const v = (y - y0) / Math.max(1, y1 - y0), xl = d[0] + (a[0] - d[0]) * v, xr = c[0] + (b[0] - c[0]) * v; for (let x = Math.round(xl); x < Math.round(xr); x++) { const u = (x - xl) / (xr - xl), row = (y - y0) % 4, col = (x + (Math.floor((y - y0) / 4) % 2) * 2) % 4; let t = .7 - u * .32 + (hash2(x >> 2, (y - y0) >> 2, seed) - .5) * .22; if (row === 3) t -= .28; if (col === 0 && row !== 0) t -= .12; if (y === y0) t += .25; p.set(x, y, pick(rp, t, x, y)); } }
}
function hut(seed, roof = '#d8683a', tall) {
  const w = 46, h = tall ? 54 : 42, rb = tall ? 24 : 20;
  return P(w, h, p => { flat(p, 6, rb, w - 12, h - rb, PLASTER, .66, seed);
    for (const x of [6, w - 8, w >> 1]) p.rect(x, rb, 2, h - rb, DARKW[x === 6 ? 3 : 1]); p.rect(6, rb + 8, w - 12, 2, DARKW[2]); if (tall) p.rect(6, rb + 19, w - 12, 2, DARKW[2]); p.rect(6, h - 3, w - 12, 3, STONE[2]);
    p.slab(11, h - 15, 8, 12, '#7a4d34'); p.set(17, h - 9, BRASS[3]); p.slab(28, rb + 12, 8, 8, '#2c4a8a'); p.rect(29, rb + 13, 3, 3, rgb('#ffd870')); p.rect(32, rb + 12, 1, 8, DARKW[1]);
    p.slab(31, 2, 6, 12, '#b8ae9a'); p.rect(30, 1, 8, 2, STONE[4]);
    roofRows(p, [[0, rb + 2], [w, rb + 2], [w - 9, 5], [9, 5]], roof, seed); p.rect(9, 4, w - 18, 2, tone(roof, .7));
    p.outline().rim(GOLD, .5); });
}
function millBody(roof = '#3a7ac8') {   // 小岛上的小风车：只画塔身，叶子另画（会转）
  return P(34, 62, p => { for (let y = 16; y < 62; y++) { const v = (y - 16) / 46, hw = 8 + v * 7; for (let x = Math.round(17 - hw); x < Math.round(17 + hw); x++) { const u = (x - (17 - hw)) / (hw * 2); let t = .82 - u * .6 + (fbm(x / 5, y / 5, 3) - .5) * .2; if ((y - 16) % 9 === 0) t -= .2; p.set(x, y, pick(STONE, t, x, y)); } }
    p.slab(13, 50, 8, 12, '#7a4d34'); p.slab(14, 30, 6, 7, '#2c4a8a'); p.rect(15, 31, 2, 2, rgb('#ffd870'));
    roofRows(p, [[5, 18], [29, 18], [19, 1], [15, 1]], roof, 4); p.rect(8, 37, 18, 2, DARKW[2]); p.outline().rim(GOLD, .5); });
}
function millSail(f) {   // 小风车的四片叶子，转过 f/4 个四分之一圈
  const S = 54, c = S / 2;
  return P(S, S, p => { for (let b = 0; b < 4; b++) { const a = f / 4 * 1.5708 + b * 1.5708, ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
      p.poly([[c + ca * 6, c + sa * 6], [c + ca * 25, c + sa * 25], [c + ca * 25 + px * 7, c + sa * 25 + py * 7], [c + ca * 6 + px * 5, c + sa * 6 + py * 5]], b % 2 ? rgb('#f4ecd8') : rgb('#dfe9f4'));
      for (let k = 9; k < 25; k += 4) p.line(c + ca * k, c + sa * k, c + ca * k + px * 6, c + sa * k + py * 6, rgb('#b9a88a'));
      p.line(c, c, c + ca * 26, c + sa * 26, DARKW[2]); }
    p.disc(c, c, 2.6, BRASS[3]); p.set(c - 1, c - 1, BRASS[4]); p.outline(); });
}
function beacon() {   // 灯塔：白石塔身、陶红的腰线、铜的灯室；灯光另有光片
  return P(30, 84, p => { for (let y = 20; y < 84; y++) { const v = (y - 20) / 64, hw = 6 + v * 6; for (let x = Math.round(15 - hw); x < Math.round(15 + hw); x++) { const u = (x - (15 - hw)) / (hw * 2); let t = .84 - u * .62 + (fbm(x / 5, y / 6, 8) - .5) * .18; const band = Math.floor((y - 20) / 13) % 2; p.set(x, y, pick(band ? R('#d8683a', 6) : STONE, t, x, y)); } }
    p.slab(4, 17, 22, 4, '#e0a83c'); p.slab(8, 8, 14, 9, '#56608a'); p.rect(10, 9, 10, 7, rgb('#fff2b0')); p.rect(14, 9, 1, 7, IRON[1]); p.rect(11, 10, 3, 3, rgb('#ffffff'));
    roofRows(p, [[6, 8], [24, 8], [16, 1], [14, 1]], '#d8683a', 2); p.rect(14, 0, 2, 2, BRASS[3]); p.slab(12, 70, 6, 14, '#7a4d34'); p.slab(13, 40, 4, 6, '#2c4a8a'); p.outline().rim(GOLD, .5); });
}
function farIsle(w, h, seed) {   // 很远的小浮岛：整座画成一张片（上面草、下面倒锥的石头），之后整体染淡
  return P(w, h, p => { const top = Math.round(h * .34), rockR = ['#3a3a78', '#5a5490', '#7c6a94', '#a88486', '#d2a67a'].map(rgb), g = R('#4fae4c', 5);
    for (let y = top; y < h; y++) { const v = (y - top) / (h - top), hw = (w / 2 - 1) * Math.pow(1 - v, .7) * (.9 + fbm(y / 5, seed, seed) * .2); for (let x = Math.round(w / 2 - hw); x < Math.round(w / 2 + hw); x++) { const u = (x - (w / 2 - hw)) / (hw * 2 + .01); p.set(x, y, pick(rockR, .85 - u * .7 - v * .2 + (fbm(x / 3, y / 5, seed + 1) - .5) * .5, x, y)); } }
    for (let x = 1; x < w - 1; x++) { const u = (x - w / 2) / (w / 2), up = Math.round((1 - u * u) * 3 + fbm(x / 4, 0, seed + 2) * 3); for (let y = top - up; y < top + 2 + (hash(x, seed) > .6 ? 2 : 0); y++) p.set(x, y, pick(g, .75 - (x / w) * .4 - (y - top + up) * .08, x, y)); }
    for (let i = 0; i < 3; i++) { const tx = w * (.25 + i * .22 + hash(i, seed + 3) * .1), th = 6 + hash(i, seed + 4) * 7; p.relief(ball(tx, top - th * .6 - 2, 4 + hash(i, seed + 5) * 2, th * .6), R('#3f9e4c', 5), { x0: Math.floor(tx - 7), x1: Math.ceil(tx + 7), y0: 0, y1: top, k: .9, grit: .3, seed }); }
    p.outline(rgb('#3a4a8a')).rim(GOLD, .5); });
}

// —— 旗、飘带、风向袋、风筝：都按帧画，风从左往右吹 ——
function flagWave(w, h, f, n, colorAt, taper = 0, amp = 2.2) {   // 一面旗的第 f 帧（共 n 帧）；colorAt(u, v) 给旗面上的颜色；taper：尾巴收多尖
  return P(w, h + 8, p => { for (let x = 0; x < w; x++) { const u = x / (w - 1), ph = u * 5.2 - f / n * 6.283, dy = Math.round(Math.sin(ph) * amp * (.25 + u * .75)) + Math.round(u * 2), hh = h * (1 - taper * u), y0 = 4 + dy + (h - hh) / 2, sl = Math.cos(ph);
      for (let y = 0; y < hh; y++) { const c = colorAt(u, y / hh); if (c) p.set(x, Math.round(y0) + y, tone(c, sl * .45 - (y / hh > .8 ? .25 : 0) + (y === 0 ? .3 : 0))); } } });
}
const pennant = (c, c2, f) => flagWave(30, 13, f, 4, (u, v) => (Math.abs(v - .5) < .16 ? c2 : c), .86);
const banner = (c, c2, f) => flagWave(34, 18, f, 4, (u, v) => (u > .78 && Math.abs(v - .5) < (u - .78) * 2.2 ? null : v > .36 && v < .64 ? c2 : c), 0, 2);
const streamer = (c, c2, f) => flagWave(72, 6, f, 4, (u, v) => (u > .93 && Math.abs(v - .5) < .2 ? null : Math.floor(u * 9) % 3 === 2 ? c2 : c), .35, 3.4);
const sock = f => flagWave(34, 13, f, 4, (u, v) => (Math.floor(u * 5) % 2 ? '#f6f0e0' : '#f08030'), .55, 1.6);
function bunting(f) {   // 一串三角小旗（挂在两根杆之间）
  return P(64, 16, p => { const cs = ['#ffd24a', '#40d0c0', '#f6f0e0', '#ff7a5a', '#ffd24a', '#7ab8ff', '#f6f0e0', '#ff9ac0'];
    for (let x = 0; x < 64; x++) { const sag = Math.round(Math.sin(x / 63 * 3.14) * 5); p.set(x, 1 + sag, ROPE[1]); const i = Math.floor(x / 8), lx = x % 8, sw = Math.round(Math.sin(i * 1.7 + f * 1.57) * 1), len = 7 - Math.abs(lx - 3.5) * 1.9; for (let y = 0; y < len; y++) p.set(x + (y > 3 ? sw : 0), 2 + sag + y, tone(cs[i], .2 - lx / 8 * .5)); } });
}
function kite(kind) {
  if (kind === 2) return P(30, 16, p => {   // 鱼形的风筝
    for (let y = 0; y < 16; y++) for (let x = 0; x < 30; x++) { const u = (x - 12) / 12, v = (y - 8) / 6.5; if (u * u + v * v < 1) p.set(x, y, pick(R('#ff8a3c', 5), .8 - (x + y) / 46 + ((x + (y % 2) * 2) % 4 === 0 ? -.2 : 0), x, y)); else if (x > 22 && Math.abs(y - 8) < (x - 21) * .9) p.set(x, y, tone('#ffd24a', -(Math.abs(y - 8) / 8) * .6)); }
    p.rect(5, 6, 2, 2, rgb('#ffffff')); p.set(6, 7, INK); p.outline(); });
  const [a, b] = kind === 0 ? ['#ff5a6a', '#ffd24a'] : ['#40d0c0', '#f6f0e0'];
  return P(22, 28, p => { p.poly([[11, 0], [22, 10], [11, 28], [0, 10]], rgb(a)); p.poly([[11, 0], [22, 10], [11, 10]], tone(b, -.1)); p.poly([[11, 10], [0, 10], [11, 28]], tone(a, -.4)); p.poly([[11, 0], [0, 10], [11, 10]], tone(a, .5)); p.line(11, 0, 11, 27, DARKW[1]); p.line(0, 10, 21, 10, DARKW[1]); p.outline(); });
}
const kiteBow = c => P(7, 5, p => { p.poly([[0, 0], [3, 2.5], [0, 5]], rgb(c)); p.poly([[7, 0], [3, 2.5], [7, 5]], tone(c, -.3)); });
function vane(f) {   // 风向标：铜箭头，f 帧稍微摆一摆
  return P(22, 24, p => { p.rect(10, 8, 2, 16, IRON[2]); p.rect(6, 19, 10, 1, IRON[1]); p.rect(10, 15, 2, 1, BRASS[3]); const s = f ? 1 : 0; p.rect(2, 5 + s, 17, 2, BRASS[3]); p.poly([[16, 2 + s], [22, 6 + s], [16, 10 + s]], BRASS[2]); p.poly([[0, 2 + s], [5, 6 + s], [0, 10 + s]], BRASS[1]); p.disc(11, 6 + s, 2.3, BRASS[4]); p.outline(); });
}
function chime() {   // 风铃：一个铜罩下面挂几根管子和一片签
  return P(13, 24, p => { p.line(6, 0, 6, 3, ROPE[1]); p.slab(1, 3, 11, 3, '#e0a83c'); for (let i = 0; i < 4; i++) { const x = 2 + i * 3, l = 7 + (i * 5) % 6; p.rect(x, 6, 1, l, i % 2 ? rgb('#a8e0fa') : BRASS[3]); p.set(x, 6 + l, BRASS[1]); } p.line(6, 6, 6, 17, ROPE[0]); p.rect(4, 17, 5, 6, rgb('#f6f0e0')); p.rect(4, 22, 5, 1, rgb('#40d0c0')); p.outline(); });
}

// —— 天上的：飞艇、热气球、鸟 ——
function ship(f, hull = '#f0d8a0', band = '#e0603c') {   // 远处的飞艇：艇头朝右；f 是螺旋桨的帧
  return P(112, 56, p => { const rh = R(hull, 6), rb = R(band, 5);
    p.poly([[4, 8], [22, 17], [22, 23], [2, 20]], rgb(band)); p.poly([[4, 34], [22, 25], [22, 19], [2, 22]], tone(band, -.4)); p.rect(2, 19, 22, 3, rgb(band));   // 尾舵
    for (let y = 0; y < 42; y++) for (let x = 8; x < 112; x++) { const u = (x - 60) / 52, v = (y - 21) / 20, sh = u < 0 ? 1 : 1 - u * u * .35, d = u * u + (v * v) / (sh * sh); if (d >= 1) continue; const z = Math.sqrt(1 - d), gore = Math.abs(((x - 8) % 13) - 6) < .6;
      let t = .46 + z * .22 - v * .34 - u * .05; if (gore) t -= .14; const stripe = Math.abs(v + .05) < .2; p.set(x, y, pick(stripe ? rb : rh, t, x, y, .8)); }
    p.rect(104, 19, 6, 4, BRASS[3]);
    p.slab(44, 44, 34, 9, '#8a5a3a'); p.rect(44, 44, 34, 2, WOOD[5]); for (let x = 48; x < 76; x += 6) p.rect(x, 47, 3, 3, rgb('#ffe08a')); for (const x of [46, 56, 66, 76]) p.line(x, 44, x + (x - 61) * .25, 38, ROPE[0]);
    p.rect(40, 48, 4, 2, IRON[2]); if (f) p.rect(38, 43, 2, 12, IRON[1]); else p.rect(36, 48, 6, 2, IRON[3]);
    p.outline(rgb('#3a3a70')).rim(GOLD, .6); });
}
function balloon(seed, a, b) {   // 远处的小热气球
  return P(24, 36, p => { const ra = R(a, 5), rb = R(b, 5);
    for (let y = 0; y < 25; y++) for (let x = 0; x < 24; x++) { const v = (y - 11) / 11.5, wR = v < 0 ? 11.5 : 11.5 * (1 - v * v * .62), u = (x + .5 - 12) / wR; if (Math.abs(v) >= 1.2 || u * u + (v < 0 ? v * v : 0) >= 1 || y > 23) continue; const g = Math.floor((u + 1) * 3.2), t = .68 - u * .28 - v * .2; p.set(x, y, pick(g % 2 ? rb : ra, t, x, y)); }
    p.line(8, 24, 10, 30, ROPE[0]); p.line(15, 24, 13, 30, ROPE[0]); p.slab(9, 30, 6, 5, '#a8703f'); p.outline(rgb('#3a3a70')).rim(GOLD, .6); });
}
function bird(f) {   // 海鸥：三帧扇翅
  return P(15, 9, p => { const w = rgb('#ffffff'), g = rgb('#a8b8d8'), k = rgb('#3a4270'), dy = [-3, 0, 2][f];
    for (let i = 1; i <= 6; i++) { const y = 4 + Math.round(dy * i / 6 * (i > 3 ? 1.2 : .8)); p.set(7 - i, y, i > 4 ? k : w); p.set(7 + i, y, i > 4 ? k : w); if (i < 5) { p.set(7 - i, y + 1, g); p.set(7 + i, y + 1, g); } }
    p.rect(6, 4, 3, 2, w); p.set(9, 4, rgb('#ffb030')); });
}
const birdFar = f => P(7, 4, p => { const k = rgb('#5a6aa0'); if (f) { p.line(0, 1, 3, 2, k); p.line(3, 2, 6, 1, k); } else { p.line(0, 3, 3, 1, k); p.line(3, 1, 6, 3, k); } });

// —— 岛底下的：浮空石的水晶、树根、垂下来的草 ——
function crystal(w, h, seed) {   // 一簇青色的浮空水晶：尖头朝下（长在岛底）
  return P(w, h, p => { const rp = ['#0f7a9a', '#18a8c0', '#40d8e0', '#90f4f0', '#e8ffff'].map(rgb), n = w > 14 ? 3 : 2;
    for (let i = 0; i < n; i++) { const cx = w * (n === 3 ? [.5, .22, .78][i] : [.4, .72][i]), hw = w * (i ? .14 : .2), len = h * (i ? .55 + hash(i, seed) * .2 : 1) - 1;
      for (let y = 0; y < len; y++) { const v = y / len, ww = v < .75 ? hw : hw * (1 - (v - .75) / .25); for (let x = Math.round(cx - ww); x <= Math.round(cx + ww); x++) { const u = (x - cx) / (hw + .01); p.set(x, y, rp[u < -.35 ? 3 : u < .25 ? 2 : 1]); } if (v < .75) p.set(Math.round(cx - hw * .35), y, rp[4]); } }
    p.outline(rgb('#0a4a78')); });
}
function root(w, h, seed, green) {   // 垂下来的树根 / 藤
  return P(w, h, p => { const c = green ? ['#2a7c50', '#44a548', '#7cc844'].map(rgb) : ['#4a2f38', '#7a4d34', '#a8703f'].map(rgb);
    for (let s = 0; s < 3; s++) { let x = w * (.25 + s * .25), l = h * (.55 + hash(s, seed) * .45); for (let y = 0; y < l; y++) { x += (hash(y + s * 50, seed + 1) - .5) * 1.3 + Math.sin(y * .2 + s) * .25; x = Math.max(1, Math.min(w - 2, x)); p.set(x, y, c[y < l * .3 ? 2 : 1]); if (y < l * .5) p.set(x + 1, y, c[0]); if (green && y % 5 === s) { p.set(x - 1, y, c[2]); p.set(x + 2, y + 1, c[1]); } } } });
}
function fringe(seed) {   // 草皮边上垂下来的一排草（贴在崖顶）
  return P(48, 14, p => { const g = ['#236f5c', '#2f8a54', '#44a548', '#62bd44', '#8fd246'].map(rgb); for (let x = 0; x < 48; x++) { const l = 3 + Math.floor(fbm(x / 3, seed, seed) * 9 + hash(x, seed) * 3); for (let y = 0; y < l; y++) p.set(x, y, g[Math.max(0, 4 - Math.floor(y / l * 4) - (x % 3 === 0 ? 1 : 0))]); } });
}

// —— 两座城堡上的：门、挂旗、徽记、窗、灯 ——
function gate(c) {   // 拱顶的双开门，门板是队伍色，铜钉铜环
  return P(40, 54, p => { for (let y = 0; y < 54; y++) for (let x = 0; x < 40; x++) { const dx = x + .5 - 20, top = y < 20 ? Math.sqrt(Math.max(0, 400 - (y - 20) * (y - 20))) : 20; if (Math.abs(dx) >= top) continue; const r = y < 20 ? Math.hypot(dx, y - 20) : Math.abs(dx); if (r > 15.5 && (y < 20 || true)) { const seg = y < 20 ? Math.floor(Math.atan2(20 - y, dx) * 4) : Math.floor(y / 8); p.set(x, y, pick(STONE, .7 - dx / 40 * .5 + (seg % 2) * .1 - (r > 19 ? .2 : 0), x, y)); } else { let t = .6 - (dx + 16) / 32 * .4 - (Math.abs(dx) < 1 ? .5 : 0) + ((x % 5 === 0) ? -.15 : 0); p.set(x, y, pick(R(c, 6), t, x, y)); } }
    for (const y of [24, 40]) { p.rect(5, y, 30, 2, BRASS[2]); for (let x = 7; x < 34; x += 5) p.set(x, y, BRASS[4]); } p.rect(16, 31, 2, 3, BRASS[4]); p.rect(22, 31, 2, 3, BRASS[4]); p.outline(); });
}
function hanging(c, emblem) {   // 挂在墙上的长旗：队伍色的底，奶白的徽（0 风涡 / 1 气球），下摆燕尾
  return P(18, 42, p => { const rp = R(c, 5), cr = rgb('#fff2d0');
    for (let y = 2; y < 42; y++) for (let x = 1; x < 17; x++) { if (y > 35 && Math.abs(x - 8.5) < (y - 35) * 1.1) continue; p.set(x, y, pick(rp, .66 - x / 18 * .3 + Math.sin(y * .5) * .08 - (x === 1 || x === 16 ? .25 : 0), x, y)); }
    p.rect(0, 0, 18, 2, BRASS[3]); p.rect(1, 4, 16, 1, BRASS[2]); p.rect(1, 30, 16, 1, BRASS[2]);
    if (emblem === 0) for (let a = 0; a < 8; a += .15) p.set(8.5 + Math.cos(a) * (.6 + a * .62), 17 + Math.sin(a) * (.6 + a * .62), cr); else { p.disc(9, 15, 4.6, cr); p.rect(7, 21, 4, 1, cr); p.rect(8, 23, 2, 2, cr); }
    p.outline(); });
}
function crest(c, emblem) { return P(18, 20, p => { p.poly([[1, 1], [17, 1], [17, 11], [9, 20], [1, 11]], rgb(c)); p.poly([[9, 1], [17, 1], [17, 11], [9, 20]], tone(c, -.35)); p.poly([[1, 1], [17, 1], [17, 3], [1, 3]], BRASS[3]); const cr = rgb('#fff2d0'); if (emblem === 0) { for (let a = 0; a < 6; a += .2) p.set(9 + Math.cos(a) * (.5 + a * .6), 10 + Math.sin(a) * (.5 + a * .6), cr); } else { p.disc(9, 9, 3.4, cr); p.rect(8, 14, 2, 2, cr); } p.outline(); }); }
function windowLit(c) { return P(12, 16, p => { p.slab(0, 0, 12, 16, '#b8ae9a'); for (let y = 2; y < 14; y++) for (let x = 2; x < 10; x++) if (y > 4 || Math.hypot(x - 5.5, y - 5) < 4) p.set(x, y, tone(c, .9 - y / 16 * .9)); p.rect(5, 2, 2, 12, tone(c, -.7)); p.rect(2, 8, 8, 1, tone(c, -.7)); }); }
function lampGem(c) { return P(12, 18, p => { p.rect(5, 0, 2, 3, BRASS[2]); p.poly([[6, 3], [11, 9], [6, 17], [1, 9]], tone(c, .5)); p.poly([[6, 3], [1, 9], [6, 9]], tone(c, 1)); p.poly([[6, 9], [11, 9], [6, 17]], tone(c, -.2)); p.set(4, 7, rgb('#ffffff')); p.outline(BRASS[1]); }); }

// —— 飘的小东西 ——
const petal = k => P(4, 3, p => { const c = rgb(k ? '#fff0f4' : '#ffa8c8'); p.set(0, 1, c); p.set(1, 0, c); p.set(1, 1, tone(k ? '#fff0f4' : '#ffa8c8', .4)); p.set(2, 1, c); p.set(2, 2, c); });
const seed = () => P(5, 7, p => { const w = rgb('#ffffff'); p.set(2, 0, w); p.set(0, 1, w); p.set(4, 1, w); p.set(1, 2, w); p.set(3, 2, w); p.set(2, 2, w); p.set(2, 3, rgb('#d8e4f4')); p.set(2, 4, rgb('#d8e4f4')); p.set(2, 5, rgb('#b8946a')); });
const leafBit = () => P(4, 3, p => { p.set(0, 1, rgb('#8fd246')); p.set(1, 1, rgb('#c2e65a')); p.set(2, 0, rgb('#8fd246')); p.set(2, 2, rgb('#62bd44')); });
const smoke = f => P(10, 10, p => { p.relief(heap([ball(5, 5, 3.5 + f, 3.5 + f), ball(3 + f, 6, 2.5, 2.5)]), ['#b8c4e0', '#dce4f4', '#ffffff'].map(rgb), { k: .8 }); });
const dot = c => P(2, 2, p => p.rect(0, 0, 2, 2, rgb(c)));
// 桥板、绳子：一小块能横着接的图
const plankBit = () => P(12, 8, p => { p.slab(0, 0, 12, 8, '#b88050'); p.rect(0, 0, 1, 8, DARKW[0]); p.rect(5, 2, 4, 1, WOOD[1]); p.set(2, 1, IRON[1]); p.set(2, 6, IRON[1]); });
const ropeBit = () => P(8, 2, p => { for (let x = 0; x < 8; x++) { p.set(x, 0, ROPE[x % 3 ? 3 : 2]); p.set(x, 1, ROPE[x % 3 ? 1 : 0]); } });
const poleBit = () => P(3, 24, p => { p.rect(0, 0, 1, 24, DARKW[4]); p.rect(1, 0, 1, 24, DARKW[2]); p.rect(2, 0, 1, 24, DARKW[0]); });   // 旗杆：一截能竖着接的木杆
// 贴镜头的前景剪影：深蓝的旗杆和栏杆，只留一条金边
function shade(p) { return p.each((x, y, c) => { const l = (c[0] * .3 + c[1] * .5 + c[2] * .2) / 255; return mix([20, 30, 72], [52, 74, 140], l); }).rim(GOLD, .75); }

// —— 全部小件 ——
export function sprites(team) {
  const [CY, RD] = team, S = {};
  S.treeA = tree(62, 84, '#3f9e4c', 1); S.treeB = tree(66, 80, '#58a84a', 2, '#ffa8c8'); S.treeC = tree(46, 60, '#4fae4c', 3); S.treeD = tree(52, 66, '#e8a23c', 4, '#ffd060'); S.cypress = cypress(24, 66, 5); S.cypressS = cypress(18, 44, 6);
  S.bushA = bush(30, 20, '#3f9e4c', 7); S.bushB = bush(28, 18, '#4fae4c', 8, '#ff7a9a'); S.bushC = bush(24, 16, '#58a84a', 9, '#fff6e0'); S.bushD = bush(40, 24, '#2f8a5c', 10);
  for (let i = 0; i < 3; i++) S['tuft' + i] = tuft(20 + i, i === 2);
  S.flowerA = flower(31, '#ff5a6a', '#ffd24a'); S.flowerB = flower(32, '#fff6e0', '#ffd24a'); S.flowerC = flower(33, '#7ab8ff', '#fff6e0'); S.flowerD = flower(34, '#ffd24a', '#f08030'); S.flowerE = flower(35, '#ff9ac0', '#fff6e0'); S.reed = reed(36);
  S.rockA = rock(26, 18, 41, true); S.rockB = rock(18, 12, 42); S.rockC = rock(34, 22, 43, true);
  S.rail = rail(); S.post = post(30); S.postLamp = post(30, '#ffd870'); S.arch = arch(); S.lantern = lantern(); S.stoneA = stepStone(51); S.stoneB = stepStone(52); S.well = well();
  S.crateA = crate(22, 20, 61); S.crateB = crate(18, 16, 62, '#f08030'); S.crateC = crate(26, 24, 63, '#40d0c0'); S.crateR = crate(22, 20, 64, RD); S.barrel = barrel(65); S.barrelR = barrel(66, RD); S.barrelC = barrel(67, CY); S.sack = sack(68); S.coil = coil(); S.bollard = bollard(); S.scope = scope(); S.ladder = ladder(); S.anchor = anchor(); S.cart = cart(); S.fence = fence(); S.signpost = signpost(); S.bench = bench();
  S.hutA = hut(71); S.hutB = hut(72, '#c85a48', true); S.hutC = hut(73, '#3a7ac8'); S.millBody = millBody(); for (let f = 0; f < 4; f++) S['millSail' + f] = millSail(f); S.beacon = beacon(); S.farIsleA = farIsle(64, 52, 81); S.farIsleB = farIsle(44, 40, 82); S.farIsleC = farIsle(84, 60, 83);
  for (let f = 0; f < 4; f++) { S['pennC' + f] = pennant(CY, '#e8fff8', f); S['pennR' + f] = pennant(RD, '#ffe6c0', f); S['pennG' + f] = pennant('#ffc83c', '#fff6e0', f); S['bannC' + f] = banner(CY, '#e8fff8', f); S['bannR' + f] = banner(RD, '#ffe6c0', f); S['bannW' + f] = banner('#f6f0e0', '#4a90e8', f);
    S['strmA' + f] = streamer('#ff7a5a', '#ffd24a', f); S['strmB' + f] = streamer('#f6f0e0', '#40d0c0', f); S['strmC' + f] = streamer('#ffd24a', '#f6f0e0', f); S['sock' + f] = sock(f); }
  S.bunting0 = bunting(0); S.bunting1 = bunting(1); S.kite0 = kite(0); S.kite1 = kite(1); S.kite2 = kite(2); S.bowA = kiteBow('#ffd24a'); S.bowB = kiteBow('#ff7a5a'); S.bowC = kiteBow('#f6f0e0'); S.vane0 = vane(0); S.vane1 = vane(1); S.chime = chime();
  S.ship0 = ship(0); S.ship1 = ship(1); S.shipB0 = ship(0, '#dfe9f4', '#3a8ad8'); S.shipB1 = ship(1, '#dfe9f4', '#3a8ad8'); S.balloonA = balloon(1, '#ffb030', '#fff0c8'); S.balloonB = balloon(2, '#8a6ae0', '#f6f0e0'); S.balloonC = balloon(3, '#58c060', '#ffe08a');
  for (let f = 0; f < 3; f++) S['bird' + f] = bird(f); S.birdFar0 = birdFar(0); S.birdFar1 = birdFar(1);
  S.crystalS = crystal(10, 16, 91); S.crystalM = crystal(16, 26, 92); S.crystalL = crystal(22, 40, 93); S.rootA = root(12, 44, 94); S.rootB = root(16, 62, 95); S.vineA = root(12, 36, 96, true); S.vineB = root(14, 52, 97, true); S.fringeA = fringe(98); S.fringeB = fringe(99);
  S.gateC = gate(CY); S.gateR = gate(RD); S.hangC = hanging(CY, 0); S.hangR = hanging(RD, 1); S.crestC = crest(CY, 0); S.crestR = crest(RD, 1); S.winC = windowLit('#40e0d0'); S.winR = windowLit('#ff7060'); S.winW = windowLit('#ffd060'); S.gemC = lampGem('#30e0d0'); S.gemR = lampGem('#ff5060');
  S.petal0 = petal(0); S.petal1 = petal(1); S.seed = seed(); S.leaf = leafBit(); S.smoke0 = smoke(0); S.smoke1 = smoke(1); S.white = dot('#ffffff'); S.plank = plankBit(); S.rope = ropeBit(); S.pole = poleBit();
  // 前景剪影：一根挂着长旗的高杆、一段栏杆带望柱
  S.fgRail = shade(P(108, 30, p => { const r = rail(), po = post(30); p.blit(po, 0, 0); p.blit(r, 12, 9); p.blit(r, 60, 9); }));
  S.fgPost = shade(post(30)); for (let f = 0; f < 4; f++) S['fgFlag' + f] = shade(banner('#40d0c0', '#f6f0e0', f)); S.fgPole = shade(poleBit());
  return S;
}
// 把 #rrggbb 或 0xrrggbb 都认成 #rrggbb
export const hex = n => (typeof n === 'string' ? n : '#' + n.toString(16).padStart(6, '0'));
