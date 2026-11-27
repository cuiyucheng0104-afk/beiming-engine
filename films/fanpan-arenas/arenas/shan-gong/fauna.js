// 《珊瑚龙宫》· 小件：珊瑚、海葵、海带、鱼、水母、贝、沉船、宝箱、珍珠灯……每一种都是一张（或几帧）逐像素算出来的小图。
// sprites() 返回 { 名字: 画布 或 [画布, …]（序列帧） }，arena.js 把它们排进一张图集，再按「立着 / 躺着」的片摆进场景。
// 画法都来自 tide.js：球、锥柱、逐像素函数，光从上面来，暗部偏蓝紫。
import { Cel, K, hx, swell, cells, dice, mist } from './tide.js';

const TAU = Math.PI * 2;
const done = c => c.rim().bake();

// —— 枝状珊瑚：从根往上分叉，越分越细；tip 给了就在枝头点一颗亮珠（荧光的珊瑚虫）——
function growInto(c, R, m, x, y, a, len, r, d, tip, spread, sh) {
  const nx = x + Math.sin(a) * len, ny = y - Math.cos(a) * len;
  c.limb(x, y, nx, ny, r, Math.max(.7, r * .74), m, sh);
  if (d <= 0 || r < .95) { if (tip) c.orb(nx, ny, 1.5, 1.5, tip, { lo: 3.6, hi: 5 }); return; }
  const n = R() < .3 ? 3 : 2;
  for (let i = 0; i < n; i++) growInto(c, R, m, nx, ny, a + (i - (n - 1) / 2) * spread * R.in(.8, 1.35) + R.in(-.16, .16), len * R.in(.66, .86), r * .74, d - 1, tip, spread, sh);
}
function branch(seed, m, w, h, { tip = 0, thick = 3, spread = .62, depth = 4, sh } = {}) {
  const c = new Cel(w, h), R = dice(seed);
  growInto(c, R, m, w / 2, h - 2, R.in(-.08, .08), h * .25, thick, depth, tip, spread, sh);
  return done(c);
}
// —— 脑珊瑚：一颗半球，上面是迷宫一样的沟 ——
function brain(seed, m, w, h) {
  const c = new Cel(w, h); c.orb(w / 2, h, w / 2 - 1, h - 2, m, { lo: 1, hi: 4.5 });
  c.tint((x, y, mm, v) => [mm, v + (Math.abs(Math.sin(swell(x / 8, y / 8, seed) * 24)) < .34 ? -1.4 : .25)]);
  return done(c);
}
// —— 扇形珊瑚（海扇）：一片镂空的网，放射的筋 + 一圈圈的横丝 ——
function fan(seed, m, w, h, sh = [1.5, 2.6]) {
  const c = new Cel(w, h), Rm = h - 6;
  c.each((x, y) => {
    const dx = x + .5 - w / 2, dy = h - 3 - y, r = Math.hypot(dx, dy), a = Math.atan2(dx, dy);
    if (dy < 0) return; if (r < 8) return Math.abs(dx) < 2.2 ? [m, sh[0]] : null;
    if (Math.abs(a) > 1.22 || r > Rm * (.8 + .2 * Math.cos(a * 5 + seed) + .06 * Math.cos(a * 17))) return;
    const rib = Math.abs((((a * 8.5 + swell(r / 16, a * 2, seed) * 1.3) % 1) + 1) % 1 - .5) < .13 + 1.4 / (r + 4), ring = (r + swell(x / 9, y / 9, seed + 1) * 7) % 6 < 1.35;
    if (rib || ring) return [m, sh[0] + r / Rm * sh[1] + (rib && ring ? .7 : 0)];
  });
  return done(c);
}
// —— 筒状海绵：几根粗筒，顶上一个黑洞 ——
function tubes(seed, m, w, h) {
  const c = new Cel(w, h), R = dice(seed), n = 3 + (seed & 1);
  for (let i = 0; i < n; i++) { const x = w * (.2 + .6 * i / (n - 1)) + R.in(-1, 1), top = R.in(3, h * .45), r = R.in(3, 4.4); c.limb(x, h - 2, x + R.in(-2, 2), top + r, r * .8, r, m); c.orb(x, top + r - 1, r * .62, r * .42, K.grout, { lo: .6, hi: 1.4 }); }
  return done(c);
}
// —— 桌状珊瑚：短柄托着一张平盘 ——
function table(m, w, h) {
  const c = new Cel(w, h); c.limb(w / 2, h - 1, w / 2, h * .45, 3.5, 5, m, { lo: .6, hi: 2.4 });
  c.orb(w / 2, h * .32, w / 2 - 1, h * .28, m, { lo: 1.4, hi: 4.8, grain: .8, s: 3 });
  c.tint((x, y, mm, v) => y > h * .36 && y < h * .62 ? [mm, v - 1.4] : null);
  return done(c);
}
// —— 海葵（4 帧）：短柱 + 一圈会摆的触手，触手尖发亮 ——
function anemone(f, m, tipM, w = 36, h = 30) {
  const c = new Cel(w, h), n = 9, order = [...Array(n).keys()].sort((a, b) => Math.abs(b - 4) - Math.abs(a - 4));
  c.limb(w / 2, h - 1, w / 2, h - 9, 6, 4.6, m, { lo: .7, hi: 2.8 });
  for (const i of order) {
    const a0 = (i / (n - 1) - .5) * 2.3, sway = Math.sin(f / 4 * TAU + i * .9) * .3; let x = w / 2 + (i - 4) * 1.15, y = h - 10, a = a0 * .45;
    for (let s = 0; s < 4; s++) { a += a0 * .2 + sway * (s + 1) * .3; const nx = x + Math.sin(a) * 4.4, ny = y - Math.cos(a) * 4.4; c.limb(x, y, nx, ny, 1.8 - s * .28, 1.5 - s * .28, m, { lo: 1.6, hi: 4.4 }); x = nx; y = ny; }
    c.orb(x, y, 1.4, 1.4, tipM, { lo: 4, hi: 5 });
  }
  return done(c);
}
// —— 海带（4 帧）：一根弯来弯去的茎，两边交替长叶片；整条随水流左右摆 ——
function kelp(f, m, w, h, seed, sh = { lo: 1, hi: 3.6 }) {
  const c = new Cel(w, h), n = Math.floor((h - 4) / 8); let x = w / 2, y = h - 1;
  for (let s = 0; s < n; s++) {
    const ph = f / 4 * TAU - s * .5 + seed, k = (s + 1) / n, nx = w / 2 + Math.sin(ph) * w * .2 * k + Math.sin(s * 1.7 + seed) * 2, ny = y - 8, side = s & 1 ? 1 : -1;
    c.limb(nx, ny + 3, nx + side * w * .27 * (1.1 - k * .5), ny - 4 + Math.sin(ph + 1) * 2.5, 2.6, .7, m, { lo: sh.lo + .5, hi: sh.hi + .8 });
    c.limb(x, y, nx, ny, 1.7, 1.5, m, sh); x = nx; y = ny;
  }
  return done(c);
}
// —— 海草丛（4 帧）：一把细长的叶子 ——
function grass(f, m, w, h, seed) {
  const c = new Cel(w, h), R = dice(seed);
  for (let i = 0; i < 7; i++) {
    const a0 = (i / 6 - .5) * 1.2, len = h * R.in(.6, .95) / 4; let x = w / 2 + (i - 3) * 1.2, y = h - 1, a = a0 * .5;
    for (let s = 0; s < 4; s++) { a += a0 * .12 + Math.sin(f / 4 * TAU + i * 1.3 + s * .6) * .16; const nx = x + Math.sin(a) * len, ny = y - Math.cos(a) * len; c.limb(x, y, nx, ny, 1.2 - s * .15, 1 - s * .15, m, { lo: 1.2, hi: 4 }); x = nx; y = ny; }
  }
  return done(c);
}
// —— 小鱼（2 帧，头朝右）：身子 + 会甩的尾巴 + 两道竖纹 + 眼睛 ——
function fish(f, m, m2) {
  const c = new Cel(14, 9); c.orb(8, 4.5, 5.2, 3.3, m, { lo: 2, hi: 5 });
  for (let y = 1; y < 8; y++) { const k = Math.abs(y - 4 + (f ? .7 : -.7)); if (k < 3.4) for (let x = 0; x < 3.4 - k * .7; x++) c.put(x + (f ? 0 : .6), y, m, 2.6 + x * .5); }
  c.tint((x, y) => (x === 6 || x === 9) && m2 ? [m2, 4.2] : null); c.put(11, 3, K.grout, 1); c.put(8, 0, m, 3); c.put(7, 0, m, 2.4);
  return done(c);
}
// —— 水母（3 帧）：钟罩一张一缩，下面拖着几缕须 ——
function jelly(f, m) {
  const w = 30, h = 42, c = new Cel(w, h), rx = 11 + [0, 2, -1.5][f], ry = 10 - [0, 1.5, -1.5][f], cy = 13;
  c.orb(w / 2, cy, rx, ry, m, { lo: 2.6, hi: 5 });
  c.tint((x, y, mm, v) => y > cy + 2 + Math.sin(x * 1.3) * 1.2 ? 0 : [mm, v + (Math.hypot(x - w / 2, y - cy + 2) < 4.5 ? 1 : 0) - (y > cy ? .8 : 0)]);
  for (let i = 0; i < 5; i++) { const bx = w / 2 + (i - 2) * rx * .36, len = 18 + (i & 1) * 6 + f * 1.5; for (let k = 0; k < len; k++) c.put(bx + Math.sin(k * .45 + i * 1.7 + f * 2.1) * (1 + k * .06), cy + 3 + k, m, 3.6 - k / len * 2.2); }
  for (let i = 0; i < 2; i++) { const bx = w / 2 + (i - .5) * 5; for (let k = 0; k < 11; k++) { c.put(bx + Math.sin(k * .7 + i * 3 + f) * 1.4, cy + 3 + k, m, 4.6 - k * .12); c.put(bx + 1 + Math.sin(k * .7 + i * 3 + f) * 1.4, cy + 3 + k, m, 3.4); } }
  return c.bake();
}
// —— 海星（俯视，躺着摆）——
function star(m, seed) {
  const N = 22, c = new Cel(N, N);
  c.each((x, y) => { const dx = x + .5 - N / 2, dy = y + .5 - N / 2, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + seed, d = Math.abs((((a / (TAU / 5)) % 1) + 1) % 1 - .5) * (TAU / 5), Rr = 3 + 7.4 * Math.max(0, 1 - d * 1.75) ** 1.6; if (r < Rr) return [m, 2 + (1 - r / Rr) * 2.2 + (hx(x, y, seed) > .8 ? 1 : 0) - d * .6]; });
  return done(c);
}
// —— 海胆：一颗暗紫的球，往外扎满刺 ——
function urchin() {
  const w = 24, h = 20, c = new Cel(w, h);
  for (let i = 0; i < 15; i++) { const a = -Math.PI * (.04 + .92 * i / 14), L = 8.5 + (i % 3); for (let k = 3; k < L; k++) c.put(w / 2 + Math.cos(a) * k, h - 6 + Math.sin(a) * k, K.urchin, 2.2 + k / L * 2.6); }
  c.orb(w / 2, h - 6, 5.6, 5, K.urchin, { lo: .8, hi: 3.6 }); c.put(w / 2 - 2, h - 9, K.mag, 4); c.put(w / 2 + 1, h - 8, K.mag, 3.4);
  return done(c);
}
// —— 贝：扇贝、海螺、鹦鹉螺 ——
function scallop(m) {
  const w = 18, h = 15, c = new Cel(w, h);
  c.each((x, y) => { const dx = x + .5 - w / 2, dy = h - 2 - y, r = Math.hypot(dx, dy), a = Math.atan2(dx, dy); if (dy >= 0 && r < 12 && Math.abs(a) < 1.25) return [m, 2.4 + Math.sin(a * 10) * 1.2 + r / 12 * 1.2]; if (dy < 0 && Math.abs(dx) < 4) return [m, 2]; });
  return done(c);
}
function conch(m) {
  const w = 24, h = 16, c = new Cel(w, h); c.limb(5, 9, 21, 7, 6, 1, m, { lo: 1.4, hi: 4.6 });
  c.tint((x, y, mm, v) => [mm, v + ((x + y * .5) % 4 < 1.2 ? -1 : .2)]); c.orb(6, 10, 3.2, 3.6, K.pink, { lo: 2.4, hi: 4.6 });
  for (const x of [9, 13, 17]) c.put(x, 3 + (x - 9) * .25, m, 4.6);
  return done(c);
}
function nautilus() {
  const w = 26, h = 22, c = new Cel(w, h); c.orb(12, 11, 10, 9.5, K.white, { lo: 2, hi: 5 });
  c.tint((x, y, mm, v) => { const a = Math.atan2(y - 11, x - 12), r = Math.hypot(x - 12, y - 11); return Math.sin(a * 5 + r * .5) > .25 && r > 2.5 ? [K.orange, v - .6] : [mm, v]; });
  c.orb(20, 15, 5, 5.5, K.nacre, { lo: 2, hi: 4.6 }); c.orb(21, 16, 2.6, 3.2, K.grout, { lo: 1, hi: 2 });
  return done(c);
}
// —— 藤壶：一小堆火山口 ——
function barnacle(seed) {
  const w = 22, h = 13, c = new Cel(w, h), R = dice(seed);
  for (let i = 0; i < 5; i++) { const x = 3.5 + i * 3.8 + R.in(-1, 1), r = R.in(2.4, 3.6); c.orb(x, h - 1, r, r * 1.5, K.white, { lo: 1.6, hi: 4.6 }); c.orb(x, h - 1 - r * 1.25, r * .5, r * .34, K.grout, { lo: 1, hi: 1.6 }); }
  return done(c);
}
// —— 石像：站在基座上、披袍执三叉戟的龙宫卫士，断了一条胳膊，身上挂着绿藻 ——
function statue() {
  const w = 46, h = 108, c = new Cel(w, h);
  c.limb(37, 92, 37, 9, 1.3, 1.3, K.stone); c.limb(37, 15, 32, 5, 1.1, .8, K.stone); c.limb(37, 15, 42, 5, 1.1, .8, K.stone); c.limb(37, 15, 37, 2, 1.1, .8, K.stone);
  c.limb(22, 90, 22, 42, 12, 7.5, K.stone, { lo: 1, hi: 4.2 }); c.limb(13, 42, 31, 42, 5.5, 5.5, K.stone, { lo: 1.2, hi: 4.4 });
  c.limb(31, 43, 37, 56, 3.2, 2.6, K.stone); c.limb(13, 43, 10, 50, 3, 2.4, K.stone); c.orb(22, 29, 6.5, 7.5, K.stone, { lo: 1.4, hi: 4.6 });
  c.limb(16, 23, 28, 23, 2, 2, K.stone, { lo: 2, hi: 4.8 }); for (const x of [17, 22, 27]) c.limb(x, 22, x, 17, 1.2, .6, K.stone, { lo: 2.4, hi: 5 });
  c.each((x, y) => y >= 90 && x >= 5 && x < 40 ? [K.stone, y === 90 || y === 99 ? 4.2 : y > 99 ? (x < 3 || x > 41 ? 1 : 2.2) : 2.9 - (x > 30 ? .9 : 0)] : null);
  c.each((x, y) => y >= 100 && x >= 2 && x < 43 ? [K.stone, y === 100 ? 4.4 : 2.4 - (x > 32 ? .9 : 0)] : null);
  c.tint((x, y, m, v) => { if (y > 44 && y < 90 && x < 34) v += Math.sin(x * 1.1 + y * .08) * .55; if (swell(x / 9, y / 9, 7) > .63) return [K.kelp, v - .5]; return [m, v + (cells(x / 7, y / 7, 3)[1] - cells(x / 7, y / 7, 3)[0] < .05 ? -1.2 : 0)]; });
  return done(c);
}
// —— 沉船剪影：斜插在海床上的船壳，中段烂得只剩肋骨，一根断桅、一根带破帆的桅杆，舷窗里有几点冷光 ——
function wreck() {
  const w = 420, h = 200, c = new Cel(w, h), ca = Math.cos(-.11), sa = Math.sin(-.11);
  c.each((x, y) => {
    const u = (x - 210) * ca - (y - 120) * sa + 210, v = (x - 210) * sa + (y - 120) * ca + 120, t = (u - 205) / 180;
    let hit = 0, lv = 1.4;
    const deck = 92 - t * t * 30 - (u > 330 ? (u - 330) * .5 : 0), keel = 168 - Math.max(0, (u - 290) / 95) ** 2 * 82 - Math.max(0, (70 - u) / 50) ** 2 * 60;
    if (u > 22 && u < 388 && v > deck && v < keel) {
      const rot = swell(u / 46, v / 46, 5) > .55 && u > 120 && u < 250 && v < keel - 9 && v > deck + 5;
      if (!rot) { hit = 1; lv = 1.3 + ((v - deck) % 9 < 1.2 ? -.6 : 0) + (v - deck < 4 ? 1.1 : 0) + swell(u / 30, v / 12, 9) * .9; }
      else if (u % 15 < 3.2) { hit = 1; lv = 1; }
      if (hit && !rot && Math.hypot((u % 44) - 22, v - deck - 20) < 3.2 && u > 250) return [K.cyan, 3.4];
    }
    if (Math.abs(u - 118 - (v - 90) * -.1) < 3.4 && v > 14 && v <= deck + 2) { hit = 1; lv = 1.5; }                // 断桅
    if (Math.abs(u - 282) < 3.8 && v > -30 && v <= deck + 2) { hit = 1; lv = 1.6; }                                 // 主桅
    if (Math.abs(v - 8) < 2.6 && u > 226 && u < 338) { hit = 1; lv = 1.7; }                                         // 帆桁
    if (u > 232 && u < 332 && v > 10 && v < 66 - Math.abs(u - 282) * .25 && swell(u / 22, v / 22, 12) > .46) { hit = 1; lv = 1.1 + swell(u / 9, v / 30, 4) * .8; }   // 破帆
    if (u > 380 && u < 420 && Math.abs(v - (deck + 6) + (u - 380) * .45) < 2.4) { hit = 1; lv = 1.5; }              // 船首斜桅
    if (Math.abs(u - 282) < 9 && Math.abs(v - -12) < 5) { hit = 1; lv = 1.3; }
    if (hit) return [K.far, lv];
  });
  return c.bake();
}
// —— 藏宝箱：掀开盖的木箱，包金边，里面一堆金币和宝石 ——
function chest() {
  const w = 42, h = 36, c = new Cel(w, h);
  c.each((x, y) => { if (x >= 4 && x < 38 && y >= 3 && y < 16) { const d = Math.hypot((x - 21) / 17, (y - 16) / 13); if (d < 1) return [x % 11 === 4 || d > .86 ? K.gold : K.wood, (x % 11 === 4 || d > .86 ? 3 : 1.6) + (16 - y) * .12]; } });
  for (let i = 0; i < 16; i++) { const x = 8 + hx(i, 1, 3) * 26, y = 14 + hx(i, 2, 3) * 5; c.orb(x, y, 2.4, 1.8, K.gold, { lo: 3, hi: 5 }); }
  c.put(14, 14, K.mag, 4.6); c.put(15, 14, K.mag, 3.6); c.put(26, 13, K.cyan, 4.8); c.put(27, 14, K.cyan, 3.6); c.orb(20, 12, 2, 2, K.pearl, { lo: 3.6, hi: 5 });
  c.each((x, y) => { if (x >= 3 && x < 39 && y >= 18 && y < 34) { const band = x < 6 || x >= 36 || y < 20 || y >= 32 || Math.abs(x - 21) < 2; return [band ? K.gold : K.wood, band ? 3.3 - (y > 26 ? .8 : 0) : 2.6 - (y - 18) * .08 + ((y % 5) === 0 ? -.8 : 0)]; } });
  c.orb(21, 24, 2.4, 2.8, K.gold, { lo: 3, hi: 5 }); c.put(21, 25, K.grout, 1);
  return done(c);
}
function coins(seed) {                                                    // 散落的金币（躺着摆）
  const w = 34, h = 22, c = new Cel(w, h), R = dice(seed);
  for (let i = 0; i < 9; i++) { const x = R.in(3, w - 3), y = R.in(3, h - 3); c.orb(x, y, 2.3, 1.7, K.gold, { lo: 3, hi: 5 }); if (R() < .3) c.orb(x + 3, y + 1, 1.2, 1.2, R.pick([K.mag, K.cyan, K.pearl]), { lo: 3.4, hi: 5 }); }
  return done(c);
}
// —— 珍珠灯：珊瑚石的扭纹灯柱，顶上一只贝托着一颗大珍珠（珍珠另画一张，放进发光层）——
function lampPost() {
  const w = 22, h = 60, c = new Cel(w, h); c.orb(11, h - 2, 8, 4, K.stone, { lo: 1.2, hi: 3.8 }); c.limb(11, h - 4, 11, 22, 2.8, 2.1, K.stone, { lo: 1, hi: 4 });
  c.tint((x, y, m, v) => y < h - 6 && y > 22 ? [m, v + ((x + y) % 6 < 2 ? -1 : .2)] : null);
  c.each((x, y) => { const dx = (x + .5 - 11) / 9, dy = (y - 16) / 7; if (dy > 0 && dx * dx + dy * dy < 1) return [K.nacre, 2 + Math.cos(dx * 9) * .8 + (1 - dy) * 1.2]; });
  return done(c);
}
const pearlOrb = r => { const c = new Cel(r * 2 + 2, r * 2 + 2); c.orb(r + 1, r + 1, r, r, K.pearl, { lo: 3, hi: 5.4 }); return done(c); };
// —— 远景的大鱼剪影：蝠鲼（2 帧，翅膀一上一下）、海龟（2 帧，前鳍划水）——
function manta(f) {
  const w = 100, h = 46, c = new Cel(w, h);
  c.each((x, y) => { const dx = x - 56, k = Math.abs(dx) / 42, lift = (f ? -1 : 1) * 7 * k * k, dy = y - 24 - lift; if (k < 1 && Math.abs(dy) < 9 * (1 - k) ** .8 + .6) return [K.far, 1.6 - dy * .08]; if (x < 20 && Math.abs(y - 24 - Math.sin(x * .3) * 1.5) < 1) return [K.far, 1.2]; if (dx > 4 && dx < 12 && Math.abs(Math.abs(y - 24) - 6) < 1.6 && dx < 9) return [K.far, 1.4]; });
  return c.bake();
}
function turtle(f) {
  const w = 62, h = 36, c = new Cel(w, h), sw = f ? .5 : -.4;
  c.limb(30, 18, 40 + sw * 6, 30 + sw * 3, 4.6, 1.2, K.far, { lo: 1, hi: 1.8 }); c.limb(16, 20, 8, 27 - sw * 4, 3, 1, K.far, { lo: 1, hi: 1.8 });
  c.orb(27, 16, 15, 8.5, K.far, { lo: 1, hi: 2.4 }); c.orb(47, 14, 5.2, 4, K.far, { lo: 1.2, hi: 2.4 }); c.limb(34, 12, 44, 3 - sw * 5, 4, 1.2, K.far, { lo: 1.2, hi: 2 });
  c.tint((x, y, m, v) => [m, v + (Math.hypot((x - 27) / 15, (y - 16) / 8.5) < .9 && cells(x / 6, y / 6, 2)[1] - cells(x / 6, y / 6, 2)[0] < .1 ? -.5 : 0)]);
  return c.bake();
}
// —— 船锚和锁链 ——
function anchor() {
  const w = 42, h = 62, c = new Cel(w, h);
  c.each((x, y) => { const r1 = Math.hypot(x + .5 - 21, y - 7), r2 = Math.hypot(x + .5 - 21, y - 36); if (Math.abs(r1 - 5) < 1.5) return [K.iron, 3.2 - (y - 7) * .2]; if (Math.abs(r2 - 16) < 2.4 && y > 40) return [K.iron, 3.4 - (x - 21) * .06]; });
  c.limb(21, 12, 21, 54, 2.3, 2.6, K.iron); c.limb(10, 17, 32, 17, 1.7, 1.7, K.iron); c.limb(4, 36, 9, 46, 3.4, 1, K.iron); c.limb(38, 36, 33, 46, 3.4, 1, K.iron);
  c.tint((x, y, m, v) => swell(x / 6, y / 6, 4) > .62 ? [K.orange, v - 1.2] : hx(x, y, 3) > .93 ? [K.white, 3.6] : null);
  return done(c);
}
function chain() {
  const w = 60, h = 12, c = new Cel(w, h);
  c.each((x, y) => { const i = Math.floor(x / 7), cx = i * 7 + 3.5, yy = 6 + Math.sin(i * .9) * 1.5, even = i & 1, d = Math.hypot((x + .5 - cx) / (even ? 4.6 : 2), (y + .5 - yy) / (even ? 2.6 : 4)); if (d < 1 && d > (even ? .5 : .42)) return [K.iron, 3.4 - (y - yy) * .4]; });
  return done(c);
}
// —— 陶罐：双耳细颈罐；broken = 上半截摔没了 ——
function amphora(broken) {
  const w = 28, h = 40, c = new Cel(w, h);
  c.each((x, y) => { for (const sx of [-1, 1]) { const r = Math.hypot(x + .5 - 14 - sx * 7.5, (y - 12) * .8); if (Math.abs(r - 4) < 1.2) return [K.clay, 2.4]; } });
  c.orb(14, 23, 9.5, 12.5, K.clay, { lo: 1, hi: 4.8 }); c.limb(14, 13, 14, 6, 3.6, 3.2, K.clay); c.limb(10, 4, 18, 4, 1.6, 1.6, K.clay, { lo: 2, hi: 5 }); c.limb(14, 36, 14, 38, 3, 4, K.clay, { lo: 1, hi: 3 });
  c.tint((x, y, m, v) => { if (broken && y < 17 + Math.sin(x * 1.1) * 3) return 0; if (y === 19 || y === 22) return [K.grout, 2]; if (y > 19 && y < 22) return [K.pearl, 2.6 + ((x & 3) < 2 ? 1 : 0)]; return swell(x / 7, y / 7, 6) > .66 ? [K.kelp, v - .6] : null; });
  return done(c);
}
// —— 巨蚌（3 帧：合、半开、全开）：两片波浪口的壳，开的时候露出里面青紫的外套膜和一颗珍珠 ——
function clam(f) {
  const w = 48, h = 36, c = new Cel(w, h), open = [0, 5, 11][f], cy = 23, zig = x => Math.sin(x * .8) * 1.6;
  if (open) c.each((x, y) => { const dx = (x + .5 - 24) / 19; if (Math.abs(dx) < 1 && y < cy + zig(x) + 1 && y > cy - open + zig(x) - 1) { const s = Math.sin(x * .7 + y); return [s > 0 ? K.teal : K.violet, 3.2 + s * .9 + (1 - dx * dx) * .6]; } });
  c.each((x, y) => { const dx = (x + .5 - 24) / 22, lo = (y - cy) / 11, up = (y - (cy - open)) / (13 + open * .3); if (dx * dx + lo * lo < 1 && y >= cy + zig(x)) return [K.shell, 2.6 + Math.cos(x * .8) * .9 - lo * 1.6]; if (dx * dx + up * up < 1 && y <= cy - open + zig(x)) return [K.shell, 3 + Math.cos(x * .8) * 1 + up * 1.4 + (f ? .3 : 0)]; });
  if (f === 2) c.orb(24, cy - 4, 4, 4, K.pearl, { lo: 3.4, hi: 5.2 });
  c.tint((x, y, m, v) => m === K.shell && hx(Math.floor(x / 2), Math.floor(y / 2), 8) > .92 ? [K.white, 3.4] : m === K.shell && swell(x / 8, y / 8, 9) > .66 ? [K.kelp, v - .4] : null);
  return done(c);
}
// —— 珍珠串：一条垂下来的弧线 ——
function garland() {
  const w = 66, h = 26, c = new Cel(w, h);
  for (let i = 0; i <= 15; i++) { const t = i / 15 * 2 - 1; c.orb(3 + i * 4, 4 + 17 * (1 - t * t), 2.3, 2.3, i % 5 === 2 ? K.teal : K.pearl, { lo: 2.6, hi: 5 }); }
  return done(c);
}
// —— 石头：小石子、长着珊瑚虫的礁石堆 ——
function pebble(seed, w, h) {
  const c = new Cel(w, h), R = dice(seed); c.orb(w / 2, h, w / 2 - 1, h - 2, K.reef, { lo: .8, hi: 4.2 });
  if (w > 24) { c.orb(w * .28, h, w * .26, h * .6, K.reef, { lo: .8, hi: 4 }); c.orb(w * .76, h, w * .22, h * .5, K.reef, { lo: .8, hi: 3.8 }); }
  c.tint((x, y, m, v) => { const f = cells(x / 9, y / 9, seed); return [m, v + (f[1] - f[0] < .08 ? -1.1 : f[2] * .8 - .3)]; });
  for (let i = 0; i < w / 5; i++) { const x = R.int(3, w - 4), y = R.int(h * .4, h - 2); if (c.at(x, y)) c.put(x, y, R.pick([K.pink, K.teal, K.violet, K.orange, K.lemon]), 3.8); }
  return done(c);
}
function mound(seed) {                                                    // 礁石堆：几块石头垒起来，上面长满各色小珊瑚
  const w = 96, h = 62, c = new Cel(w, h), R = dice(seed);
  for (let i = 0; i < 6; i++) { const x = R.in(18, w - 18), ry = R.in(18, h - 8); c.orb(x, h, R.in(16, 26), ry, K.reef, { lo: .7, hi: 3.8 }); }
  c.tint((x, y, m, v) => { const f = cells(x / 10, y / 10, seed); return [m, v + (f[1] - f[0] < .07 ? -1.2 : f[2] * .9 - .3)]; });
  for (let i = 0; i < 16; i++) { const x = R.int(8, w - 8), y = R.int(10, h - 4); if (!c.at(x, y)) continue; const m = R.pick([K.pink, K.orange, K.violet, K.teal, K.mag, K.lemon]); if (R() < .5) c.orb(x, y, R.in(2.4, 4.4), R.in(2, 3.4), m, { lo: 2, hi: 4.8 }); else growInto(c, R, m, x, y, R.in(-.3, .3), R.in(4, 7), 1.6, 2, 0, .8); }
  return done(c);
}
// —— 远景：龙宫残墙的剪影（一排拱门、两座塔、一个带尖顶的穹顶）和一长条珊瑚林的剪影 ——
function palace() {
  const w = 330, h = 236, c = new Cel(w, h);
  c.each((x, y) => {
    let hit = 0;
    if (y > 150 - (x > 96 && x < 234 ? 18 : 0)) { const ph = ((x - 15) % 44 + 44) % 44 - 22, top = 176 - (x > 96 && x < 234 ? 14 : 0); hit = !(Math.abs(ph) < 12 && y > top && (y > top + 12 || Math.hypot(ph, y - top - 12) < 12)); }
    if (Math.hypot((x - 165) / 62, (y - 134) / 58) < 1 && y < 136) hit = 1; if (Math.abs(x - 165) < 3 + (y - 40) * .14 && y > 40 && y < 84) hit = 1; if (Math.hypot(x - 165, y - 40) < 5) hit = 1;
    for (const [tx, top] of [[44, 58], [286, 86]]) { if (Math.abs(x - tx) < 19 && y > top + 20 + (tx > 200 ? swell(x / 9, 0, 3) * 26 : 0)) hit = !(Math.abs(x - tx) < 5 && (y - top) % 46 > 28 && (y - top) % 46 < 42); if (tx < 200 && y <= top + 20 && y > top - 16 && Math.abs(x - tx) < (y - top + 18) * .62) hit = 1; }
    if (hit) return [K.far, 1.3 + ((y % 12) < 1 || ((x + (Math.floor(y / 12) & 1) * 11) % 22) < 1 ? -.5 : 0) + swell(x / 40, y / 40, 8) * 1.1 + (y < 150 ? .3 : 0)];
  });
  return c.bake();
}
function forest(seed) {
  const w = 256, h = 110, c = new Cel(w, h), R = dice(seed), sh = { lo: 1, hi: 2.2 };
  for (let i = 0; i < 13; i++) { const x = 10 + i * 19.5 + R.in(-5, 5); if (R() < .3) for (let k = 0, y = h; k < 9; k++, y -= 9) c.limb(x + Math.sin(k + i) * 4, y, x + Math.sin(k + 1 + i) * 4, y - 9, 2.6, 2.2, K.far, sh); else growInto(c, R, K.far, x, h, R.in(-.1, .1), R.in(16, 30), R.in(2.4, 4), 4, 0, .6, sh); }
  for (let i = 0; i < 9; i++) c.orb(R.in(0, w), h, R.in(14, 30), R.in(8, 20), K.far, { lo: 1, hi: 2 });
  return c.bake();
}
// —— 其它小件 ——
function tubeworm(m) {                                                    // 羽毛管虫：细管顶上一把羽毛
  const w = 22, h = 28, c = new Cel(w, h);
  for (let i = 0; i < 11; i++) { const a = -Math.PI * (.1 + .8 * i / 10); for (let k = 2; k < 9; k++) c.put(11 + Math.cos(a) * k, 11 + Math.sin(a) * k * .9, m, 2.4 + k * .3 + (i & 1)); }
  c.limb(11, h - 1, 11, 11, 1.6, 1.3, K.white, { lo: 1.4, hi: 4 });
  return done(c);
}
function bulb(m) {                                                        // 荧光球藻：细茎上顶着一颗发光的小球
  const w = 16, h = 26, c = new Cel(w, h); c.limb(8, h - 1, 7, 12, 1, .8, K.weed); c.limb(8, h - 6, 12, h - 12, .9, .6, K.weed);
  c.orb(7.5, 8, 4.6, 5, m, { lo: 3.2, hi: 5.4 }); c.orb(12.5, h - 14, 2.2, 2.4, m, { lo: 3.4, hi: 5.2 });
  return done(c);
}
function whip(seed, m, tip) {                                             // 鞭珊瑚：一根细长弯曲的枝，上面一排亮点
  const w = 16, h = 56, c = new Cel(w, h); let x = 8, y = h - 1;
  for (let s = 0; s < 9; s++) { const nx = 8 + Math.sin(s * .7 + seed) * 4 * (s / 9), ny = y - 6; c.limb(x, y, nx, ny, 1.4 - s * .08, 1.3 - s * .08, m, { lo: 1.6, hi: 4.2 }); if (s > 1) c.put(nx + 1, ny + 2, tip, 5); x = nx; y = ny; }
  return done(c);
}
function crab(f) {                                                        // 小螃蟹（2 帧）
  const w = 22, h = 14, c = new Cel(w, h);
  for (const s of [-1, 1]) { for (let i = 0; i < 3; i++) c.limb(11 + s * 4, 8, 11 + s * (8 + i * 1.2), 12 - ((i + f) & 1) * 2, .8, .6, K.red, { lo: 1.4, hi: 3 }); c.limb(11 + s * 5, 6, 11 + s * 8.5, 3 + (f ? s * .6 : 0), 1.3, 1.9, K.red, { lo: 2, hi: 4.4 }); }
  c.orb(11, 8, 6, 4, K.red, { lo: 1.6, hi: 4.8 }); c.put(9, 5, K.white, 5); c.put(13, 5, K.white, 5);
  return done(c);
}
function fishbone() {                                                     // 鱼骨
  const w = 46, h = 18, c = new Cel(w, h); c.limb(8, 9, 40, 9, .9, .7, K.bone, { lo: 2, hi: 4.4 });
  for (let x = 14; x < 36; x += 4) { const L = 6 - Math.abs(x - 22) * .22; c.limb(x, 9, x - 2, 9 - L, .7, .5, K.bone, { lo: 2, hi: 4 }); c.limb(x, 9, x - 2, 9 + L, .7, .5, K.bone, { lo: 1.6, hi: 3.4 }); }
  c.orb(7, 9, 5.5, 4.5, K.bone, { lo: 1.8, hi: 4.6 }); c.put(6, 8, K.grout, 1); c.put(5, 8, K.grout, 1); c.limb(40, 9, 45, 3, .9, .6, K.bone); c.limb(40, 9, 45, 15, .9, .6, K.bone);
  return done(c);
}
function wheel() {                                                        // 半埋在沙里的舵轮
  const N = 42, c = new Cel(N, 32);
  c.each((x, y) => { const dx = x + .5 - 21, dy = y + .5 - 21, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx), sp = Math.abs((((a / (TAU / 8)) % 1) + 1) % 1 - .5) * (TAU / 8) * r; if (Math.abs(r - 13.5) < 2.2 || r < 3.4 || (sp < 1.2 && r < 20)) return [K.wood, 3 - dy * .09 + (r < 3.4 ? .8 : 0)]; });
  return done(c);
}
function barrel() {
  const w = 26, h = 30, c = new Cel(w, h);
  c.each((x, y) => { const k = 1 - ((y - 15) / 15) ** 2 * .28, dx = (x + .5 - 13) / (11.5 * k); if (Math.abs(dx) < 1 && y > 1 && y < h - 1) { const band = y === 5 || y === 6 || y === 23 || y === 24; return [band ? K.iron : K.wood, (band ? 3.4 : 3) - dx * 1.2 + (!band && x % 5 === 0 ? -.9 : 0)]; } });
  c.tint((x, y, m, v) => swell(x / 6, y / 6, 2) > .68 ? [K.kelp, v - .4] : null);
  return done(c);
}
function planks() {                                                       // 散落的船板（躺着摆）
  const w = 52, h = 22, c = new Cel(w, h);
  for (const [x0, y0, L, k] of [[2, 3, 40, .08], [8, 10, 42, -.05], [0, 16, 30, .04]]) c.each((x, y) => { const yy = y0 + (x - x0) * k; if (x >= x0 && x < x0 + L && y >= yy && y < yy + 4) return [K.wood, 2.4 + (y - yy < 1 ? 1 : 0) + (hx(x >> 2, y0, 5) - .5) * .8]; });
  return done(c);
}
function column(broken, seed) {                                           // 远一点的断柱（片）：带凹槽的柱身 + 柱头，或一截歪茬
  const w = 30, h = broken ? 70 : 132, c = new Cel(w, h);
  c.each((x, y) => { const dx = (x + .5 - 15) / 10; if (Math.abs(dx) >= 1) return; if (broken && y < 12 + swell(x / 5, 0, seed) * 16) return; if (y % 30 === 29) return [K.stone, 1.2]; return [K.stone, 2.3 - dx * 1.4 + Math.sin((x - 5) / 20 * Math.PI * 5) * .7 + (swell(x / 8, y / 14, seed) - .5) * 1.2]; });
  c.each((x, y) => { if (y >= h - 8 && Math.abs(x + .5 - 15) < 14) return [K.stone, y === h - 8 ? 4.2 : 2.6 - (x - 15) * .06]; if (!broken && y < 10 && Math.abs(x + .5 - 15) < 11 + (10 - y) * .35) return [K.stone, y === 0 ? 4.4 : 3 - (x - 15) * .06 + (y % 3 === 0 ? -.7 : 0)]; });
  c.tint((x, y, m, v) => swell(x / 8, y / 10, seed + 4) > .64 ? [K.kelp, v - .5] : hx(x >> 1, y >> 1, seed) > .95 ? [K.pink, 3.4] : null);
  return done(c);
}
const bubble = r => { const N = r * 2 + 2, c = new Cel(N, N); c.each((x, y) => { const d = Math.hypot(x + .5 - N / 2, y + .5 - N / 2); if (d < r && d > r - 1.3) return [K.cyan, 3.6 + (y < N / 2 ? 1.2 : 0)]; if (r > 2 && Math.hypot(x + .5 - N / 2 + r * .35, y + .5 - N / 2 + r * .35) < .8) return [K.white, 5]; }); return c.bake(); };

export function sprites() {
  const ink = { lo: .5, hi: 1.9 }, S = {};
  // 珊瑚：枝状 7 色（三种带荧光枝头）、脑状 3、扇形 4、筒状 3、桌状 2、鞭状 2
  [['Pink', K.pink, 0], ['Orange', K.orange, 0], ['Red', K.red, 0], ['Violet', K.violet, K.mag], ['White', K.white, K.cyan], ['Teal', K.teal, K.cyan], ['Mag', K.mag, K.lemon]].forEach(([n, m, tip], i) => { S['branch' + n] = branch(40 + i * 7, m, 54 + (i % 3) * 8, 58 + (i % 2) * 12, { tip, thick: 3 + (i % 2) * .6 }); });
  S.branchRedBig = branch(131, K.red, 110, 140, { thick: 5.4, depth: 5, spread: .56 }); S.branchRedTall = branch(137, K.red, 84, 150, { thick: 4.6, depth: 5, spread: .42 });
  S.branchPinkBig = branch(151, K.pink, 104, 112, { thick: 4.8, depth: 5, spread: .6 }); S.branchTealBig = branch(157, K.teal, 90, 104, { thick: 4.2, depth: 5, tip: K.cyan });
  S.brainOrange = brain(3, K.orange, 40, 26); S.brainPink = brain(8, K.pink, 52, 32); S.brainLemon = brain(12, K.lemon, 34, 22);
  S.fanPink = fan(1, K.pink, 70, 62); S.fanViolet = fan(4, K.violet, 84, 74); S.fanOrange = fan(7, K.orange, 60, 54); S.fanMag = fan(9, K.mag, 96, 86);
  S.tubeOrange = tubes(2, K.orange, 34, 36); S.tubeViolet = tubes(5, K.violet, 30, 40); S.tubeLemon = tubes(9, K.lemon, 30, 30);
  S.tablePink = table(K.pink, 58, 30); S.tableTeal = table(K.teal, 46, 26);
  S.whipMag = whip(1, K.mag, K.lemon); S.whipCyan = whip(4, K.weed, K.cyan);
  // 会动的：海葵 4 种、海带 2 色、海草、鱼 5 种、水母 3 色、巨蚌、螃蟹、蝠鲼、海龟
  S.anemTeal = [0, 1, 2, 3].map(f => anemone(f, K.teal, K.cyan)); S.anemPink = [0, 1, 2, 3].map(f => anemone(f, K.pink, K.pearl)); S.anemRed = [0, 1, 2, 3].map(f => anemone(f, K.red, K.orange)); S.anemViolet = [0, 1, 2, 3].map(f => anemone(f, K.violet, K.mag));
  S.kelpA = [0, 1, 2, 3].map(f => kelp(f, K.kelp, 44, 150, 1)); S.kelpB = [0, 1, 2, 3].map(f => kelp(f, K.weed, 40, 112, 4)); S.kelpC = [0, 1, 2, 3].map(f => kelp(f, K.kelp, 48, 220, 7));
  S.grassA = [0, 1, 2, 3].map(f => grass(f, K.kelp, 30, 30, 3)); S.grassB = [0, 1, 2, 3].map(f => grass(f, K.teal, 26, 24, 8));
  [['fishOrange', K.orange, K.white], ['fishTeal', K.cyan, 0], ['fishLemon', K.lemon, K.grout], ['fishPink', K.pink, K.white], ['fishSilver', K.white, K.cyan]].forEach(([n, m, m2]) => { S[n] = [0, 1].map(f => fish(f, m, m2)); });
  S.jellyCyan = [0, 1, 2].map(f => jelly(f, K.cyan)); S.jellyMag = [0, 1, 2].map(f => jelly(f, K.mag)); S.jellyViolet = [0, 1, 2].map(f => jelly(f, K.violet));
  S.clam = [0, 1, 2].map(clam); S.crab = [0, 1].map(crab); S.manta = [0, 1].map(manta); S.turtle = [0, 1].map(turtle);
  S.bubble = [2, 3, 4].map(bubble);
  // 海床上的零碎
  S.starOrange = star(K.orange, 1); S.starPink = star(K.pink, 2.2); S.starViolet = star(K.violet, 3.1); S.urchin = urchin();
  S.scallopPink = scallop(K.pink); S.scallopWhite = scallop(K.pearl); S.scallopOrange = scallop(K.orange); S.conch = conch(K.pearl); S.conchOrange = conch(K.orange); S.nautilus = nautilus();
  S.barnacleA = barnacle(1); S.barnacleB = barnacle(6); S.pebbleS = pebble(2, 16, 10); S.pebbleM = pebble(5, 30, 19); S.pebbleL = pebble(9, 50, 30); S.moundA = mound(3); S.moundB = mound(11);
  S.tubewormPink = tubeworm(K.pink); S.tubewormWhite = tubeworm(K.pearl); S.bulbCyan = bulb(K.cyan); S.bulbMag = bulb(K.mag);
  // 沉下来的人造物
  S.statue = statue(); S.chest = chest(); S.coinsA = coins(2); S.coinsB = coins(7); S.lampPost = lampPost(); S.lampOrb = pearlOrb(7); S.pearl = pearlOrb(3); S.garland = garland();
  S.anchor = anchor(); S.chain = chain(); S.amphora = amphora(false); S.amphoraBroken = amphora(true); S.fishbone = fishbone(); S.wheel = wheel(); S.barrel = barrel(); S.planks = planks();
  S.columnTall = column(false, 2); S.columnBroken = column(true, 5); S.columnStub = column(true, 9);
  // 远景剪影
  S.wreck = wreck(); S.palace = palace(); S.forestA = forest(3); S.forestB = forest(17);
  // 贴镜头的前景剪影（墨蓝）
  S.fgKelp = [0, 1, 2, 3].map(f => kelp(f, K.ink, 120, 330, 2, ink)); S.fgFan = fan(6, K.ink, 250, 220, [.6, 1.2]); S.fgBranch = branch(71, K.ink, 220, 210, { thick: 8, depth: 5, sh: ink });
  return S;
}
// 软光图集（线性过滤，加色叠层用）：一团光晕、一道光柱、一颗微粒。返回画布和三块的 uv
export function glowSheet(mk) {
  const cv = mk(256, 128), g = cv.getContext('2d');
  g.drawImage(mist(96, 96, (u, v) => { const d = Math.hypot(u - .5, v - .5) * 2; return Math.max(0, 1 - d) ** 2.2; }), 2, 2);
  g.drawImage(mist(96, 124, (u, v) => (.25 + .75 * Math.abs(Math.sin(u * 9 + Math.sin(u * 23) * 1.2)) ** 3) * Math.sin(Math.min(1, u * 1.02) * Math.PI) ** 1.5 * (1 - v) ** .55 * Math.min(1, v * 5)), 104, 2);
  g.drawImage(mist(24, 24, (u, v) => Math.max(0, 1 - Math.hypot(u - .5, v - .5) * 2) ** 1.2), 206, 2);
  const uv = (x, y, w, h) => [(x + .5) / 256, 1 - (y + h - .5) / 128, (x + w - .5) / 256, 1 - (y + .5) / 128];
  return { cv, halo: uv(2, 2, 96, 96), shaft: uv(104, 2, 96, 124), mote: uv(206, 2, 24, 24) };
}
