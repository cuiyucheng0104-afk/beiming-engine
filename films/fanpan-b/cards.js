// 《沉水擂台》B 版 · 小件：一张张平的像素片（莲叶、蕨、旗、冰晶、灯笼、火、瀑布、交手的光效……），逐像素算出来。
// sprites() 返回 { 名字: canvas }；bake.mjs 把它们拼成一张图集 cards/atlas.png，film.tsx 按名字取格子。
// 受光的片（植物、旗、木桩）按浮雕着色；发光的片（火、冰晶、符文、数字）直接给明度。密度每米 48 像素。
import { INK, relief, soft, h2, vn, fbm, dome, seg, glyphAt, textWidth } from './ink.js';
import { UNITS, HP } from './plan.js';

const RIM = { rim: INK.night };
// 点 (x, y) 相对线段 a→b：d 垂直距离，t 沿线位置 0…1（线段外为 -1）
function along(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy, t = ((x - ax) * vx + (y - ay) * vy) / L2;
  if (t < 0 || t > 1) return { d: 99, t: -1 };
  return { d: Math.abs((x - ax) * vy - (y - ay) * vx) / Math.sqrt(L2), t };
}
const heart = (x, y, cx, cy, s) => { const a = (x - cx) / s, b = -(y - cy) / s; return (a * a + b * b - 1) ** 3 - a * a * b * b * b < 0; };
// 一组从 (bx, by) 散开的叶片：n 片，角度 a0…a1（度，0 向右、-90 向上），长 len，最宽处 wid
function blades(x, y, bx, by, n, a0, a1, len, wid, seed, serr = 0) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = (a0 + (a1 - a0) * (i + .5 * h2(i, 1, seed)) / Math.max(1, n - 1)) * Math.PI / 180, l = len * (.65 + .35 * h2(i, 2, seed));
    const droop = l * .25 * Math.cos(a), tx = bx + Math.cos(a) * l, ty = by + Math.sin(a) * l + Math.abs(droop) * .6;
    const { d, t } = along(x, y, bx, by, tx, ty); if (t < 0) continue;
    const w = wid * Math.sin(Math.PI * Math.min(1, t * 1.08)) ** .8 * (serr && Math.floor(t * l) % 2 ? serr : 1) + .45;
    if (d < w && (!best || i > best.i)) best = { i, z: (1 - d / w) * 2 + t, t, d };
  }
  return best;
}
// 一堆鼓包（树丛、树冠）：返回最上面那个鼓包的高度和编号
function blobs(x, y, list) {
  let best = null;
  for (let i = 0; i < list.length; i++) { const [cx, cy, rx, ry] = list[i], d = dome(x, y, cx, cy, rx, ry); if (d > 0 && (!best || d + i * .02 > best.k)) best = { k: d + i * .02, d, i }; }
  return best;
}
const scatter = (n, w, h, seed, r0, r1, fit = (u, v) => true) => { const L = []; for (let i = 0, j = 0; L.length < n && j < n * 30; j++) { const u = h2(j, 1, seed), v = h2(j, 2, seed); if (!fit(u, v)) continue; const r = r0 + (r1 - r0) * h2(j, 3, seed); L.push([r + u * (w - 2 * r), r + v * (h - 2 * r), r, r * (.75 + .2 * h2(j, 4, seed))]); i++; } return L; };

function pad(w, h, seed) {
  const a0 = h2(seed, 9) * 6.28;
  return relief(w, h, (x, y) => {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, d = dome(x, y, cx, cy, w / 2 - .5, h / 2 - .5); if (d <= 0) return null;
    const an = Math.atan2(y - cy, x - cx), da = Math.abs(((an - a0 + 9.42) % 6.28) - 3.14), r = Math.hypot((x - cx) / (w / 2), (y - cy) / (h / 2));
    if (da < .3 && r > .18) return null;                                    // 缺口
    const vein = Math.abs(((an - a0 + 6.28) % .7) - .35) < .07 / Math.max(r, .2) * .5 && r > .15;
    return { z: d * 1.6, ink: h2(seed, 3) > .7 ? INK.moss : INK.pad, add: (vein ? -.9 : 0) + (r > .82 ? .8 : 0) + (h2(x, y, seed) > .9 ? .5 : 0) + .3 };
  }, { ...RIM, base: 3 });
}
const lotus = () => relief(16, 15, (x, y) => {
  let z = -1; for (const a of [-160, -125, -90, -55, -20]) { const r = a * Math.PI / 180, l = a === -90 ? 11 : 9, { d, t } = along(x, y, 8, 13, 8 + Math.cos(r) * l, 13 + Math.sin(r) * l * .9); if (t >= 0 && d < 2.6 * Math.sin(Math.PI * t) + .4) z = Math.max(z, t * 3 - d); }
  if (dome(x, y, 8, 11.5, 2.2, 1.6) > 0) return { ink: INK.gold, lv: 4.6 };
  return z < -.9 ? null : { z, ink: INK.petal, add: 1 + z * .25 };
}, RIM);
const koi = () => relief(22, 10, (x, y) => {
  const body = dome(x, y, 9, 5, 8, 3), tail = x > 14 && Math.abs(y - 5) < (x - 14) * .55 && x < 21;
  if (body <= 0 && !tail) return null;
  return { ink: vn(x / 3, y / 2, 5) > .55 ? INK.bone : INK.koi, lv: 3.4 + (body > 0 ? body * 1.4 : 0) };
});
const reed = seed => relief(16, 40, (x, y) => {
  const b = blades(x, y, 8, 39, 6, -112, -68, 37, 1.25, seed);
  const head = dome(x, y, 5 + (seed % 3) * 2.5, 7, 1.7, 4.5);
  if (head > 0) return { z: head * 2, ink: INK.bark, add: .6 };
  return b ? { z: b.z, ink: b.i % 2 ? INK.fern : INK.leaf, add: .3 + b.t * .9 } : null;
}, RIM);
const fern = seed => relief(30, 22, (x, y) => {
  const b = blades(x, y, 15, 21, 8, -168, -12, 17, 2.6, seed, .45);
  return b ? { z: b.z, ink: b.i % 3 ? INK.fern : INK.moss, add: .1 + b.t * 1.1 - (b.d < .6 ? .8 : 0) } : null;
}, RIM);
const tuft = seed => relief(18, 14, (x, y) => { const b = blades(x, y, 9, 13, 9, -150, -30, 12, 1.0, seed); return b ? { z: b.z, ink: b.i % 2 ? INK.moss : INK.fern, add: .4 + b.t } : null; }, RIM);
const shroom = () => relief(16, 14, (x, y) => {
  for (const [cx, cy, r, sh] of [[5, 6, 4.5, 6], [11.5, 9, 3, 4]]) {
    const cap = dome(x, y, cx, cy, r, r * .75); if (cap > 0 && y <= cy) return { ink: INK.teal, lv: 3 + cap * 2 + (h2(x, y, 3) > .8 ? 1 : 0) };
    if (Math.abs(x - cx) < 1.2 && y > cy && y < cy + sh) return { ink: INK.bone, lv: 3.2 };
  }
  return null;
}, RIM);
function bush(w, h, seed, inks) {
  const list = scatter(13, w, h - 4, seed, w * .13, w * .22, (u, v) => Math.abs(u - .5) < .15 + v * .4).sort((a, b) => a[1] - b[1]);
  return relief(w, h, (x, y) => {
    const b = blobs(x, y, list); if (!b) return null;
    const leafy = h2(x >> 1, y >> 1, seed + b.i) > .52, fl = h2(x, y, seed + 9);
    if (fl > .985 && b.d > .5) return { ink: seed % 2 ? INK.petal : INK.gold, lv: 4.7 };
    return { z: b.d * 5 + (leafy ? 1.2 : 0), ink: inks[b.i % inks.length], add: (leafy ? .35 : -.35) + b.d * .4 - (list[b.i][1] / h) * .7 };
  }, RIM);
}
const bigplant = seed => relief(36, 30, (x, y) => {
  const b = blades(x, y, 18, 29, 6, -165, -15, 24, 5.2, seed);
  return b ? { z: b.z * 1.5, ink: b.i % 2 ? INK.leaf : INK.pad, add: b.t * .9 - (b.d < .7 ? 1 : 0) + (Math.floor(b.t * 18) % 3 === 0 ? -.35 : 0) } : null;
}, RIM);
const vine = seed => relief(16, 72, (x, y) => {
  const sx = 8 + Math.sin(y / 9 + seed) * 3.6, fade = y > 62 ? (72 - y) / 10 : 1;
  const k = Math.floor(y / 7), ly = y % 7, side = k % 2 ? 1 : -1, leaf = dome(x, ly, sx + side * 3.2, 3, 3.2 * fade, 2.4);
  if (leaf > 0) return { z: leaf * 2, ink: h2(k, seed) > .6 ? INK.moss : INK.leaf, add: .4 + leaf * .5 };
  if (h2(k, seed + 4) > .86 && Math.hypot(x - sx + side * 2, ly - 5) < 1.3) return { ink: INK.petal, lv: 4.6 };
  return Math.abs(x - sx) < .9 * fade ? { z: 1, ink: INK.bark, add: 0 } : null;
}, RIM);
// 垂下来的气根：几股粗细不一的根，挂着苔和零星发亮的小花
const root = (w, h, n, seed) => relief(w, h, (x, y) => {
  let hit = null;
  for (let i = 0; i < n; i++) {
    const len = h * (.55 + .45 * h2(i, 1, seed)); if (y > len) continue;
    const cx = (i + .5) * w / n + Math.sin(y / (11 + i * 3) + i * 2 + seed) * (2 + y / h * 3), th = (1.7 + 1.5 * h2(i, 2, seed)) * (1 - y / len * .75);
    const d = Math.abs(x - cx); if (d < th) hit = { z: (1 - d / th) * 2.4, i, tip: y > len - 3 };
  }
  if (!hit) { const n2 = h2(x >> 1, y >> 1, seed + 5); return y < 10 && vn(x / 5, y / 4, seed) > .45 ? { z: 1, ink: INK.leaf, add: n2 - .3 } : null; }
  if (hit.tip && h2(hit.i, 6, seed) > .45) return { ink: INK.gold, lv: 5 };
  const mossy = vn(x / 3, y / 6, seed + 2) > .7;
  return { z: hit.z, ink: mossy ? INK.moss : INK.bark, add: mossy ? .7 : .1 };
}, RIM);
const glyph = ink => relief(16, 22, (x, y) => {
  const on = seg(x, y, 8, 2, 8, 19) < 1 || seg(x, y, 3, 6, 13, 6) < 1 || seg(x, y, 3, 6, 8, 12) < .9 || seg(x, y, 13, 6, 8, 12) < .9 || seg(x, y, 4, 17, 12, 17) < 1 || Math.abs(Math.hypot(x - 8, y - 17) - 3.4) < .8;
  return on ? { ink, lv: 4.3 + (h2(x, y, 2) > .6 ? .7 : 0) } : null;
});
const flake = (x, y, cx, cy, r) => { for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3 + .52; if (seg(x, y, cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r) < .8) return true; } return Math.abs(Math.hypot(x - cx, y - cy) - r * .55) < .6; };
const drop = (x, y, cx, cy, r) => dome(x, y, cx, cy + r * .35, r * .8, r * .8) > 0 || (y < cy + r * .4 && y > cy - r * 1.1 && Math.abs(x - cx - Math.sin((y - cy) * .5) * .8) < (y - (cy - r * 1.1)) * .45);
const banner = team => relief(22, 62, (x, y) => {
  if (y < 3) return { z: 2, ink: INK.wood, add: .4 };
  if (x < 1 || x > 20 || y > 49 + Math.abs(x - 10.5) * 1.15) return null;
  const fold = Math.sin(x / 3.3 + y / 26) * 1.5, edge = x < 3 || x > 18 || y < 6;
  if (edge) return { z: fold + 1, ink: INK.gold, add: .2 };
  const own = team === 'own', mark = own ? flake(x, y, 10.5, 24, 6.5) : drop(x, y, 10.5, 25, 6.5);
  if (mark) return { z: fold + .6, ink: INK.bone, add: 1.2 };
  if (y % 14 > 11) return { z: fold, ink: own ? INK.ice : INK.gold, add: .3 };
  return { z: fold, ink: own ? INK.teal : INK.lacquer, add: own ? -.5 : .1 };
}, { ...RIM, base: 3 });
// 血量碑：圆头石碑，一颗心加一个数。数字和心是亮的
const stele = (team, hp) => relief(46, 32, (x, y) => {
  const inside = y >= 9 ? x >= 1 && x <= 44 : dome(x, y, 22.5, 9, 21.6, 9) > 0; if (!inside) return null;
  const e = Math.min(x - 1, 44 - x, 31 - y, y < 9 ? dome(x, y, 22.5, 9, 21.6, 9) * 9 : 99), ink = team === 'own' ? INK.teal : INK.red;
  if (e < 2) return { ink, lv: 4.2 };
  if (heart(x, y, 13, 17.5, 5.6)) return { ink: INK.red, lv: heart(x, y, 12, 16, 2.2) ? 5 : 4 };
  const tx = 24 + (17 - textWidth(String(hp), 3)) / 2;
  if (glyphAt(String(hp), x, y, tx, 10, 3)) return { ink: INK.bone, lv: 5 };
  if (glyphAt(String(hp), x - 1, y - 1, tx, 10, 3)) return { ink: INK.night, lv: 0 };
  return { ink: INK.night, lv: 1.2 + fbm(x / 5, y / 5, 4) * 1.4 };
}, RIM);
const crystal = () => relief(26, 40, (x, y) => {
  const shard = (cx, top, bot, hw) => { const t = (y - top) / (bot - top); if (t < 0 || t > 1) return null; const w = hw * Math.min(1, t / .28, (1 - t) / .16 + .15); const dx = x - cx; return Math.abs(dx) <= w ? dx / (w || 1) : null; };
  const s = shard(13, 0, 39, 7.5) ?? shard(4.5, 17, 39, 3.6) ?? shard(21.5, 21, 39, 3.6);
  if (s === null) return null;
  const spark = h2(x, y, 6) > .93;
  return { ink: INK.ice, lv: spark ? 5 : s < -.35 ? 4.6 : s < .25 ? 3.5 : 2.2 + (y % 9 < 1 ? 1 : 0) };
}, { rim: INK.slateOwn });
const lantern = () => relief(16, 26, (x, y) => {
  if (y < 3) return Math.abs(x - 7.5) < 3.5 ? { ink: INK.night, lv: 1.5 } : null;
  if (y >= 21) return Math.abs(x - 7.5) < (y < 23 ? 3.5 : .8) ? { ink: y < 23 ? INK.night : INK.lacquer, lv: y < 23 ? 1.5 : 4 } : null;
  const d = dome(x, y, 7.5, 12, 7.4, 9.6); if (d <= 0) return null;
  if (y < 6 || y > 18) return { ink: INK.lacquer, lv: 3.6 + d };
  return { ink: INK.paper, lv: (y % 3 === 0 ? 3.3 : 4.2) + d * .9 };
}, RIM);
const rune = team => relief(42, 36, (x, y) => {
  const own = team === 'own', ink = own ? INK.teal : INK.red, cx = 20.5, cy = 17.5, r = Math.hypot((x - cx) / 19, (y - cy) / 16), an = Math.atan2(y - cy, x - cx);
  if (Math.abs(r - .95) < .06 && Math.floor((an + 3.15) * 5) % 2 === 0) return { ink, lv: 3.4 };
  if (Math.abs(r - .72) < .035) return { ink, lv: 2.6 };
  const mark = own ? flake(x, y, cx, cy, 8) : drop(x, y, cx, cy, 7) && !drop(x, y, cx, cy + 2, 3.6);
  return mark ? { ink, lv: 4.2 } : null;
});
const pick = () => relief(60, 52, (x, y) => {
  const ex = Math.min(x, 59 - x), ey = Math.min(y, 51 - y);
  if ((ex < 3 && ey < 15) || (ey < 3 && ex < 15)) return { ink: INK.gold, lv: 5 };
  if ((ex === 5 || ey === 5) && ex >= 5 && ey >= 5 && (x + y) % 4 < 2) return { ink: INK.gold, lv: 3.6 };
  return null;
});
const ring = team => relief(46, 26, (x, y) => {
  const r = Math.hypot((x - 22.5) / 22.5, (y - 12.5) / 12.5), ink = team === 'own' ? INK.teal : INK.red, an = Math.atan2(y - 12.5, x - 22.5);
  if (r > 1) return null;
  if (r > .84) return { ink, lv: Math.floor((an + 3.15) * 3.2) % 2 ? 5 : 3.8 };
  if (r > .7 && r < .76) return { ink, lv: 3 };
  return (x + y) % 2 === 0 && r > .25 ? { ink, lv: 1.6 + r * 1.2 } : null;
});
// 战力牌：圆牌，金边，队色底，亮的数字
const badge = (team, n) => relief(19, 19, (x, y) => {
  const r = Math.hypot(x - 9, y - 9); if (r > 9.4) return null;
  if (r > 7.4) return { ink: INK.gold, lv: r > 8.5 ? 2.6 : 4.6 };
  const t = String(n), tx = 9.5 - textWidth(t, 2) / 2;
  if (glyphAt(t, x, y, tx, 4, 2)) return { ink: INK.bone, lv: 5 };
  return { ink: team === 'own' ? INK.teal : INK.red, lv: glyphAt(t, x - 1, y - 1, tx, 4, 2) ? .4 : 1.9 + (y < 8 ? .6 : 0) };
});
function canopy(w, h, seed) {
  const list = scatter(46, w, h, seed, w * .09, w * .17, (u, v) => (u - .5) ** 2 + (v - .45) ** 2 < .23).sort((a, b) => b[1] - a[1]);
  return relief(w, h, (x, y) => {
    const b = blobs(x, y, list); if (!b) return null;
    const leafy = h2(x >> 1, y >> 1, seed + b.i) > .5;
    return { z: b.d * 6 + (leafy ? 1.4 : 0), ink: [INK.leaf, INK.leaf, INK.fern, INK.pad][b.i % 4], add: (leafy ? .3 : -.5) + b.d * .5 - .5 };
  }, { ...RIM, base: 2.2 });
}
const bigleaf = () => relief(64, 64, (x, y) => {
  const b = blades(x, y, 32, 63, 5, -160, -20, 58, 11, 21);
  if (!b) return null;
  const slit = Math.floor(b.t * 22) % 4 === 0 && b.d > 3;
  return slit ? null : { z: b.z * 2, ink: b.i % 2 ? INK.leaf : INK.fern, add: b.t * .6 - .9 - (b.d < 1 ? .8 : 0) };
}, { ...RIM, base: 2 });
const post = () => relief(22, 96, (x, y) => {
  if (x < 4 || x > 17) return null;
  const rope = (y > 14 && y < 26), cap = y < 5;
  if (rope) return { z: 3 + ((y + (x >> 1)) % 4 < 2 ? 1.2 : 0), ink: INK.rope, add: .3 };
  return { z: (cap ? 3 : 0) + (1 - Math.abs(x - 10.5) / 7) * 3 + vn(x / 2, y / 9, 8) * 1.4, ink: vn(x / 4, y / 7, 9) > .75 ? INK.moss : INK.wood, add: cap ? .5 : -.4 };
}, { ...RIM, base: 2.2 });
// 火（四格）：水滴形，往上收尖、左右摆，芯最亮
const flame = (f, ink, core) => relief(18, 28, (x, y) => {
  const t = (27 - y) / 27, cx = 8.5 + Math.sin(t * 5 + f * 1.57) * 2.2 * t, half = 7.2 * (1 - t) ** .75 * Math.min(1, t * 6 + .45) * (.8 + .35 * vn(x / 2, y / 3 + f * 3.3, 7));
  const dx = Math.abs(x - cx);
  if (dx > half) return h2(x, y + f * 7, 5) > .985 && t > .5 ? { ink, lv: 4 } : null;
  const k = dx / (half || 1);
  return k < .42 && t < .62 ? { ink: core, lv: 5 } : { ink, lv: k < .75 ? 4 - t * 1.2 : 2.6 - t };
});
// 瀑布（四格）：一道道往下走的亮纹
const fall = f => relief(28, 72, (x, y) => {
  const half = 7.5 + 5 * y / 72 + vn(y / 5, x > 14 ? 1 : 2, 3) * 1.6, dx = Math.abs(x - 13.5); if (dx > half) return null;
  const streak = vn(x / 1.6, (y - f * 18) / 15, 4, 0, 0), edge = dx > half - 1.6;
  return { ink: streak > .62 || edge ? INK.frost : INK.ice, lv: 2.2 + streak * 2.6 + (edge ? .8 : 0) };
});
const foam = f => relief(40, 12, (x, y) => {
  let d = 0; for (let i = 0; i < 9; i++) d = Math.max(d, dome(x, y, 2.5 + i * 4.4 + h2(i, f, 2) * 2, 9 - h2(i, f, 3) * 4, 3 + h2(i, f, 4) * 2, 2.5 + h2(i, f, 5) * 2));
  return d > 0 ? { ink: INK.frost, lv: 3.6 + d * 1.5 } : null;
});
const ripple = k => relief(28, 14, (x, y) => {
  const r = Math.hypot((x - 13.5) / 13.5, (y - 6.5) / 6.5), R = .45 + k * .25;
  return Math.abs(r - R) < .09 - k * .02 && h2(x, y, k) > k * .22 ? { ink: INK.water, lv: 4.8 - k * .6 } : null;
});
const frostb = k => relief(30, 30, (x, y) => {
  const cx = 14.5, cy = 14.5, r = Math.hypot(x - cx, y - cy), R = 6 + k * 4; if (r > R + 1) return null;
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + .26, c = Math.cos(a), s = Math.sin(a);
    if (seg(x, y, cx + c * (k * 2), cy + s * (k * 2), cx + c * R, cy + s * R) < .9) return k === 2 && (x + y) % 3 === 0 ? null : { ink: INK.frost, lv: 5 };
    const bx = cx + c * R * .6, by = cy + s * R * .6;
    for (const sg of [-1, 1]) if (seg(x, y, bx, by, bx + Math.cos(a + sg * .9) * 3, by + Math.sin(a + sg * .9) * 3) < .7) return { ink: INK.ice, lv: 4.4 };
  }
  return r < 3 - k ? { ink: INK.frost, lv: 5 } : null;
});
const ember = k => relief(30, 30, (x, y) => {
  const cx = 14.5, cy = 14.5, r = Math.hypot(x - cx, y - cy), an = Math.atan2(y - cy, x - cx), R = 5 + k * 4, wob = Math.sin(an * 7 + k) * 1.4;
  const d = Math.abs(r - R - wob), th = 2.8 - k * .8;
  if (d < th) return k === 2 && h2(x, y, 3) > .7 ? null : { ink: INK.fire, lv: d < th * .45 ? 5 : 3.6 };
  return k === 0 && r < 3 ? { ink: INK.fire, lv: 5 } : null;
});
const dot = (w, h, ink, fn) => relief(w, h, (x, y) => { const lv = fn(x, y); return lv ? { ink, lv } : null; });

export function sprites() {
  const S = {
    pad0: pad(20, 19, 1), pad1: pad(15, 14, 2), pad2: pad(25, 22, 3), lotus: lotus(), koi: koi(),
    reed: reed(4), fern: fern(5), tuft: tuft(6), shroom: shroom(), bushA: bush(42, 34, 7, [INK.leaf, INK.fern, INK.leaf, INK.moss]), bushB: bigplant(8),
    vine: vine(9), root0: root(28, 128, 5, 10), root1: root(40, 96, 6, 11), glyph: glyph(INK.teal), glyphFoe: glyph(INK.fire),
    bannerOwn: banner('own'), bannerFoe: banner('foe'), steleOwn: stele('own', HP.own), steleFoe: stele('foe', HP.foe),
    crystal: crystal(), lantern: lantern(), runeOwn: rune('own'), runeFoe: rune('foe'), pick: pick(), ringOwn: ring('own'), ringFoe: ring('foe'),
    canopy: canopy(96, 72, 12), bigleaf: bigleaf(), post: post(),
    glint: dot(6, 3, INK.water, (x, y) => (y === 1 ? 5 : x > 0 && x < 5 ? 4 : 0)),
    spark: dot(5, 5, INK.gold, (x, y) => (x === 2 || y === 2 ? (x === 2 && y === 2 ? 5 : 4.4) : 0)),
    shard: dot(5, 9, INK.frost, (x, y) => (Math.abs(x - 2) <= Math.min(y, 8 - y) * .6 ? (x < 2 ? 5 : 3.6) : 0)),
    petal: dot(5, 4, INK.petal, (x, y) => (dome(x, y, 2, 1.5, 2.6, 2.1) > 0 ? (x < 2 ? 4.8 : 3.6) : 0)),
    firefly: dot(3, 3, INK.moss, (x, y) => (x === 1 || y === 1 ? (x === 1 && y === 1 ? 5 : 4.2) : 0)),
  };
  for (let f = 0; f < 4; f++) { S[`flame${f}`] = flame(f, INK.fire, INK.paper); S[`wisp${f}`] = flame(f + 1.3, INK.teal, INK.frost); S[`fall${f}`] = fall(f); }
  for (let k = 0; k < 3; k++) { S[`ripple${k}`] = ripple(k); S[`frostb${k}`] = frostb(k); S[`ember${k}`] = ember(k); }
  S.foam0 = foam(0); S.foam1 = foam(1);
  for (const u of UNITS) S[`badge-${u.team}-${u.str}`] ??= badge(u.team, u.str);
  return S;
}

// 半透明的软边图（叠加用，不是像素画）：灯晕四种颜色、光柱、水汽
export function glows() {
  const halo = tint => soft(64, 64, (u, v) => { const r = Math.hypot(u - .5, v - .5) * 2; return r >= 1 ? 0 : (1 - r) ** 2.2; }, tint);
  return {
    haloTeal: halo([70, 240, 225]), haloFire: halo([255, 130, 50]), haloGold: halo([255, 214, 130]), haloIce: halo([130, 235, 255]),
    shaft: soft(64, 128, (u, v) => Math.sin(Math.PI * u) ** 2 * Math.sin(Math.PI * Math.min(1, v / .8)) ** .7 * (.75 + .25 * Math.sin(u * 40)), [255, 206, 120]),
    mist: soft(96, 48, (u, v) => Math.sin(Math.PI * u) ** 1.5 * Math.sin(Math.PI * v) ** 1.5 * (.6 + .4 * Math.sin(u * 19 + v * 7)), [150, 240, 235]),
  };
}

// 棋子序列帧加描边：贴身一圈深色，外面再一圈队色。暗的盘面上轮廓先读出来
export function outline(img, team) {
  const w = img.width, h = img.height, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, w, h), d = im.data, lvl = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) lvl[i] = d[i * 4 + 3] > 96 ? 3 : 0;
  for (let pass = 2; pass >= 1; pass--) {
    const next = lvl.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (lvl[i]) continue;
      if ((x > 0 && lvl[i - 1] > pass) || (x < w - 1 && lvl[i + 1] > pass) || (y > 0 && lvl[i - w] > pass) || (y < h - 1 && lvl[i + w] > pass)) next[i] = pass;
    }
    lvl.set(next);
  }
  const edge = team === 'own' ? [60, 255, 235] : [255, 96, 60], dark = [16, 6, 30];
  for (let i = 0; i < w * h; i++) {
    if (lvl[i] === 3) { d[i * 4 + 3] = 255; continue; }
    const col = lvl[i] === 2 ? dark : lvl[i] === 1 ? edge : null;
    if (col) { d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255; } else d[i * 4 + 3] = 0;
  }
  g.putImageData(im, 0, 0); return c;
}
