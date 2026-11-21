// 《彩窗圣堂》的小件：全部是像素立牌 / 贴地片，由 arena.js 拼进一张图集。
// 每个函数画一件，返回 Plate；带烛火的小件在 plate.tips 里记下每根烛芯的位置（像素，从左上算），场景据此把火苗放上去。
import { Plate, C, S, prof, cloud, hash } from './paint.js';

const TAU = Math.PI * 2;
const grainOf = (seed, amp = 1.2, sc = 9) => (x, y) => (cloud(x / sc, y / sc, seed, 2) - .5) * amp;
// 一根蜡烛：蜡身 + 烛芯，顺手记下烛芯的位置
function stick(p, cx, top, bot, r = 1.5, rp = C.wax) {
  p.turn(cx, top, bot, () => r, rp, { lv: 3.5, lift: 1.5 });
  p.ink(Math.floor(cx - r), top + 1 + (Math.floor(cx) % 3), rp, 5);                      // 一滴蜡泪
  p.dot(Math.floor(cx), top - 1, C.lead); (p.tips ||= []).push([cx, top - 1]); return p;
}
// 小烛杯：一个浅碟
const cup = (p, cx, y, rp = C.gold, r = 3) => p.turn(cx, y, y + 2, prof([0, r], [1, r - 1.6]), rp, { lv: 3.3 });

// —— 火苗：四帧，逐帧歪一歪、高一高（场景里按每秒 8 拍换帧）——
function flame(rp, w, h, f) {
  const p = new Plate(w, h), sway = [0, .9, 0, -.9][f], tall = [1, .84, 1.08, .76][f], cx = w / 2, R = w * .42, by = h - .5 - R, len = (h - R * 1.6) * tall;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const yy = y + .5, t = (by - yy) / len; let d = 9;
    if (t <= 0) d = Math.hypot(x + .5 - cx, yy - by) / R;
    else if (t < 1) d = Math.abs(x + .5 - cx - sway * t * t * w * .22) / (R * (1 - t) ** .75 + .2);
    if (d < 1) p.dot(x, y, rp[d < .36 && t < .55 ? 6 : d < .68 ? 5 : t > .55 ? 3 : 4]);
  }
  return p;
}
// 烟团：一小团抖动出来的灰紫色
function puff(n, seed) {
  const p = new Plate(n, n), c = n / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x + .5 - c, y + .5 - c) / c + (cloud(x / 3, y / 3, seed, 2) - .5) * .7;
    if (d < .62 || (d < .95 && (x + y) & 1)) p.ink(x, y, C.smoke, 3.4 - d * 1.6 + (y < c ? .8 : -.4), .8);
  }
  return p;
}

// —— 蜡烛与烛台 ——
function candles3() {                                       // 地上一簇三根，脚下一滩蜡
  const p = new Plate(24, 24);
  p.form(S.any(S.oval(12, 21, 11, 2.6), S.oval(6, 20.5, 5, 2.4)), C.wax, { lv: 2.6, round: 2, lift: 1 });
  stick(p, 6.5, 6, 20, 2); stick(p, 13.5, 11, 21, 1.5); stick(p, 19.5, 15, 21, 1.5); return p.edge();
}
function candles5() {                                       // 大一些的一簇五根
  const p = new Plate(36, 28);
  p.form(S.any(S.oval(18, 25, 17, 2.7), S.oval(9, 24, 8, 3), S.oval(28, 25.5, 6, 2)), C.wax, { lv: 2.5, round: 2, lift: 1 });
  stick(p, 5.5, 14, 24, 1.5); stick(p, 11.5, 5, 24, 2); stick(p, 18.5, 10, 25, 2); stick(p, 24.5, 16, 25, 1.5); stick(p, 30.5, 12, 25, 1.5); return p.edge();
}
function waxpool() {                                        // 贴地的一滩蜡泪
  const p = new Plate(20, 14);
  p.form(S.any(S.oval(9, 7, 7, 4.5), S.oval(14, 9, 5, 3), S.oval(4, 10, 3, 2), S.disc(17, 4, 1.6)), C.wax, { lv: 2.7, round: 2, lift: 1.2, line: 1.5 }); return p;
}
function candelabra() {                                     // 落地大烛台：车出来的金杆，一横梁五个杯
  const p = new Plate(34, 82), cx = 17, ys = [22, 17, 12, 17, 22], xs = [3.5, 10.5, 17.5, 24.5, 31.5];
  for (let i = 0; i < 5; i++) if (i !== 2) { p.seg(cx, 30, xs[i], ys[i] + 4, C.brass, 2.6, 2); p.seg(cx, 26, xs[i], ys[i] + 3, C.gold, t => 3 + t, 1); }   // S 形的枝
  p.turn(cx + .5, 16, 74, prof([0, 2], [.1, 2], [.14, 4], [.18, 1.8], [.42, 1.8], [.46, 3.6], [.5, 1.8], [.8, 2.2], [.86, 4.2], [.9, 2.4], [1, 3]), C.gold);
  p.turn(cx + .5, 74, 80, prof([0, 3], [.5, 8], [1, 12]), C.gold, { lv: 2.8 });
  for (let i = 0; i < 5; i++) { cup(p, xs[i], ys[i]); stick(p, xs[i], ys[i] - 10 + (i % 2) * 3, ys[i] - 1); }
  return p.edge();
}
function chandelier() {                                     // 枝形吊灯：一个金圈、八根蜡烛、三条链子收到顶上
  const p = new Plate(86, 48), cx = 43, cy = 30, rx = 37, ry = 7;
  for (const [x, y] of [[7, 28], [43, 36], [79, 28]]) p.seg(cx, 0, x, y, C.brass, t => 2 + ((t * 20) & 1) * 2, 1);
  const ring = (front) => { for (let a = 0; a < TAU; a += .004) { const s = Math.sin(a); if ((s > 0) !== front) continue; const x = cx + Math.cos(a) * rx, y = cy + s * ry; for (let k = 0; k < 4; k++) p.ink(Math.floor(x), Math.floor(y) + k, front ? C.gold : C.brass, front ? (k === 0 ? 5 : k === 3 ? 1.8 : 3.4 - Math.cos(a) * .9) : 1.8, .5); } };
  ring(false);
  const at = i => { const a = (i + .5) / 8 * TAU; return [Math.round(cx + Math.cos(a) * rx) + .5, Math.round(cy + Math.sin(a) * ry)]; };
  for (const i of [4, 5, 6, 7]) { const [x, y] = at(i); cup(p, x, y - 3, C.brass); stick(p, x, y - 10, y - 4); }
  ring(true);
  for (const i of [0, 1, 2, 3]) { const [x, y] = at(i); cup(p, x, y - 2); stick(p, x, y - 10 - (i % 2), y - 3); }
  p.turn(cx + .5, 37, 46, prof([0, 1.5], [.4, 4], [.7, 2], [1, .8]), C.gold);
  return p.edge();
}
function rack() {                                           // 许愿烛架：三层铁架，每层一排长短不一的小蜡烛
  const p = new Plate(54, 48);
  p.seg(4, 46, 14, 8, C.iron, 2.6, 2); p.seg(49, 46, 39, 8, C.iron, 2.6, 2);
  for (let t = 0; t < 3; t++) {
    const y = 14 + t * 11, x0 = 13 - t * 4, x1 = 41 + t * 4;
    p.block(x0, y, x1 - x0, 2, C.iron, (u, v) => v < .5 ? 4 : 2); p.block(x0, y + 2, x1 - x0, 1, C.brass, 2.5);
    for (let x = x0 + 3, i = 0; x < x1 - 2; x += 5, i++) stick(p, x + .5, y - 3 - Math.floor(hash(i, t, 3) * 6), y - 1, 1.5, hash(i, t, 8) > .6 ? C.crimson : C.wax);
  }
  return p.edge();
}
function ironTree() {                                       // 对面的烛架：黑铁的树，金杯，暗红的蜡烛
  const p = new Plate(52, 66), cx = 26, xs = [4.5, 11.5, 18.5, 26.5, 34.5, 41.5, 48.5], ys = [30, 22, 15, 9, 15, 22, 30];
  for (let i = 0; i < 7; i++) if (i !== 3) { const s = Math.sign(xs[i] - cx); p.seg(cx, 52 - Math.abs(i - 3) * 2, xs[i] - s * 2, ys[i] + 12, C.iron, 3.2, 2); p.seg(xs[i] - s * 2, ys[i] + 12, xs[i], ys[i] + 3, C.iron, 3.6, 2); }
  p.turn(cx + .5, 12, 58, prof([0, 1.6], [.5, 2], [.56, 4], [.62, 2], [1, 2.6]), C.iron, { lv: 3.2 });
  p.form(S.poly([[cx, 54], [cx + 14, 65], [cx - 13, 65]]), C.iron, { lv: 3, round: 2 }); p.block(cx - 2, 44, 5, 2, C.gold, 4);
  for (let i = 0; i < 7; i++) { cup(p, xs[i], ys[i], C.gold); stick(p, xs[i], ys[i] - 9 + (i % 3), ys[i] - 1, 1.5, C.crimson); }
  return p.edge();
}
function lampS() {                                          // 本方的银灯：细长的银杆，顶上一只蓝玻璃盏（冷火）
  const p = new Plate(16, 70), cx = 8;
  p.turn(cx, 14, 64, prof([0, 1.2], [.3, 1.2], [.34, 3], [.38, 1.2], [.9, 1.5], [1, 2.4]), C.silver);
  p.turn(cx, 64, 69, prof([0, 2.4], [1, 7]), C.silver, { lv: 2.8 });
  p.turn(cx, 6, 14, prof([0, 5], [.5, 5.6], [1, 1.5]), C.cyan, { lv: 2.6 }); p.block(2, 5, 12, 1, C.silver, 5);
  p.dot(cx - 1, 4, C.lead); p.tips = [[cx - .5, 4]]; return p.edge();
}
function brazier() {                                        // 铁火盆：三脚架上一只碗，里面是炭火
  const p = new Plate(26, 36);
  p.seg(13, 14, 3, 35, C.iron, 3, 2); p.seg(13, 14, 22, 35, C.iron, 2.4, 2); p.seg(12, 14, 12, 34, C.iron, 3.4, 2);
  p.turn(13, 6, 15, prof([0, 11], [.25, 11.5], [1, 4]), C.iron, { lv: 3 }); p.block(3, 6, 20, 2, C.gold, (u) => 4.6 - u * 2);
  for (let x = 5; x < 21; x++) p.dot(x, 5, C.flame[1 + Math.floor(hash(x, 0, 2) * 4)]);
  p.tips = [[13, 5]]; return p.edge();
}
function sconce() {                                         // 柱子上的壁烛
  const p = new Plate(12, 20); p.seg(2, 18, 6, 13, C.brass, 3, 2); p.block(0, 14, 2, 6, C.brass, 2.5); cup(p, 6.5, 11); stick(p, 6.5, 3, 10); return p.edge();
}

// —— 香炉、链子、钟绳 ——
function censer() {
  const p = new Plate(16, 26), cx = 8;
  for (const x of [3, 8, 12]) p.seg(cx, 0, x, 10, C.brass, t => 2 + ((t * 10) & 1) * 2, 1);
  p.turn(cx, 8, 14, prof([0, .8], [.4, 2], [1, 5.5]), C.gold); p.turn(cx, 14, 21, prof([0, 6], [.5, 6.6], [1, 3]), C.gold, { lv: 3 }); p.turn(cx, 21, 24, prof([0, 1.6], [1, 4]), C.gold, { lv: 2.6 });
  for (const [x, y] of [[5, 15], [8, 16], [11, 15], [6, 12], [10, 12]]) p.dot(x, y, C.flame[y > 13 ? 4 : 2]);     // 镂空里透出的火光
  p.block(7, 5, 2, 3, C.gold, 5); return p.edge();
}
function chain() { const p = new Plate(3, 96); for (let y = 0; y < 96; y++) { const k = y % 6; if (k < 4) { p.ink(1, y, C.brass, k === 0 ? 4.6 : 2.4); } else { p.ink(0, y, C.brass, 3.2); p.ink(2, y, C.brass, 1.6); } } return p; }
function rope() { const p = new Plate(4, 96); for (let y = 0; y < 96; y++) for (let x = 0; x < 4; x++) p.ink(x, y, C.parchment, 2.2 + ((x + y) % 4 < 2 ? 1.4 : 0) - x * .4); return p; }
function sally() {                                          // 钟绳末端那段红金相间的绒把
  const p = new Plate(8, 30);
  for (let y = 0; y < 22; y++) { const r = 2.2 + 1.5 * Math.sin(y / 22 * Math.PI); for (let x = 0; x < 8; x++) if (Math.abs(x + .5 - 4) < r) p.ink(x, y, (y + x) % 6 < 3 ? C.crimson : C.gold, 3.6 - (x - 2) * .5, .5); }
  p.block(3, 22, 2, 8, C.parchment, 3); return p.edge();
}

// —— 祭坛上的东西 ——
function cross() {                                          // 祭坛上的金十字，背后一圈放射的光芒
  const p = new Plate(34, 48), cx = 17, cy = 17;
  for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, r = i & 1 ? 11 : 15; p.seg(cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r, C.brass, 3.2, 1); }
  p.form(S.any(S.rect(cx - 2.5, 2, 5, 34, 1), S.rect(cx - 10, 11, 20, 5, 1), S.disc(cx, 13.5, 5)), C.gold, { lv: 3.6, round: 2, lift: 1.8 });
  p.form(S.disc(cx, 13.5, 2.4), C.ruby, { lv: 3.6, round: 1.5 });
  p.turn(cx, 36, 47, prof([0, 2], [.3, 5], [.5, 3], [1, 9]), C.gold, { lv: 3 }); return p.edge();
}
function altarFront() {                                     // 祭坛正面的布：白麻布，中间一幅红底金绣，下沿一圈花边
  const p = new Plate(98, 42);
  p.each((x, y) => {
    const e = Math.min(x, 97 - x), fold = Math.sin(x / 5.5) * .5 + (cloud(x / 12, y / 20, 3, 2) - .5);
    if (y > 35) return (x % 6 < 3) !== (y > 38) ? [C.linen, 3.6 + fold, .5] : y > 38 ? null : [C.linen, 2.4, .5];   // 花边：一齿一齿
    if (e < 3) return [C.linen, 2.6 + fold, .6];
    if (x > 30 && x < 67 && y > 4 && y < 33) {
      const u = Math.abs(x - 48.5), v = Math.abs(y - 18.5), fr = Math.min(x - 30, 67 - x, y - 4, 33 - y);
      if (fr < 2) return [C.gold, 3.4 + fold, .5];
      if ((u < 2 && v < 11) || (v < 2 && u < 8) || Math.abs(u + v - 13) < 1) return [C.gold, 4 + fold, .5];
      return [C.crimson, 2.8 + fold, .6];
    }
    if (x % 22 < 3 && y < 34) return [C.gold, 3 + fold, .5];                              // 竖的金带
    return [C.linen, 3.3 + fold - (y < 3 ? 1 : 0), .7];
  });
  return p;
}
function chalice() { const p = new Plate(10, 14); p.turn(5, 1, 6, prof([0, 4.4], [.6, 3.6], [1, 1]), C.gold, { lv: 3.6 }); p.turn(5, 6, 12, prof([0, 1], [.3, 2], [.5, 1], [1, 4]), C.gold); return p.edge(); }
function vase(k) {                                          // 一瓶花：白百合和红玫瑰
  const p = new Plate(18, 32), cx = 9;
  for (let i = 0; i < 7; i++) { const a = -Math.PI / 2 + (i - 3) * .32, x = cx + Math.cos(a) * 11, y = 20 + Math.sin(a) * 13; p.seg(cx, 20, x, y, C.leaf, 2.4, 1); p.form(S.disc(x, y, i % 2 ? 2.4 : 2.9), (i + k) % 3 === 0 ? C.crimson : (i + k) % 3 === 1 ? C.white : C.rosy, { lv: 3.6, round: 1.6, lift: 1.4 }); }
  p.form(S.oval(4, 15, 3, 1.6), C.leaf, { lv: 3 }); p.form(S.oval(14, 14, 3, 1.6), C.leaf, { lv: 2.4 });
  p.turn(cx, 19, 31, prof([0, 2], [.2, 1.6], [.55, 5], [.9, 3], [1, 3.6]), k ? C.gold : C.royal, { lv: 3.2 }); return p.edge();
}
function bookstack() {
  const p = new Plate(18, 13);
  [[1, 9, 15, C.wine], [3, 5, 13, C.royal], [2, 1, 12, C.oak]].forEach(([x, y, w, rp]) => { p.block(x, y, w, 4, rp, (u, v) => 3.6 - v * 1.6); p.block(x + w - 2, y + 1, 2, 2, C.parchment, 4); p.block(x + 3, y, 1, 4, C.gold, 4); });
  return p.edge();
}
function cushion(rp) { const p = new Plate(22, 10); p.form(S.rect(1, 1, 20, 8, 3.5), rp, { lv: 3.2, round: 3, lift: 1.6 }); for (const x of [1, 20]) p.block(x, 4, 1, 3, C.gold, 4); p.block(6, 4, 10, 1, C.gold, 3.4); return p.edge(); }
function kneeler() { const p = new Plate(34, 16); p.block(2, 6, 30, 3, C.oak, (u, v) => 3.8 - v * 1.4); p.block(3, 9, 3, 7, C.oakDk, 3); p.block(28, 9, 3, 7, C.oakDk, 2.4); p.form(S.rect(4, 2, 26, 5, 2), C.crimson, { lv: 3.2, round: 2 }); return p.edge(); }
function chest() {                                          // 奉献箱：橡木，铁箍，金锁
  const p = new Plate(24, 20);
  p.form(S.rect(1, 6, 22, 13, 1), C.oak, { lv: 3, round: 2, grain: grainOf(4) }); p.form(S.rect(1, 1, 22, 7, 3), C.oak, { lv: 3.5, round: 3 });
  for (const x of [4, 18]) p.block(x, 1, 2, 18, C.iron, 3.4); p.block(1, 7, 22, 1, C.oakDk, 1.6); p.block(10, 6, 4, 4, C.gold, (u, v) => 4.4 - v); return p.edge();
}
function hymn() { const p = new Plate(20, 30); p.form(S.rect(1, 3, 18, 26, 1), C.oakDk, { lv: 3, round: 2 }); p.form(S.poly([[10, 0], [18, 4], [2, 4]]), C.oak, { lv: 3.4 }); for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) if (hash(r, c, 6) > .25) { p.block(3 + c * 5, 6 + r * 6, 4, 4, C.linen, 4); p.dot(4 + c * 5, 7 + r * 6 + (c + r) % 2, C.lead); p.dot(5 + c * 5, 8 + r * 6, C.lead); } return p.edge(); }
function plaque() { const p = new Plate(30, 24); p.form(S.any(S.rect(1, 5, 28, 18, 1), S.disc(15, 7, 7)), C.pale, { lv: 3.2, round: 2 }); p.form(S.ring(S.rect(3, 8, 24, 13, 0), .6), C.brass, { lv: 3.4, round: 1 }); for (let r = 0; r < 4; r++) p.block(6, 10 + r * 3, 18 - (r === 3 ? 8 : (r * 5) % 4), 1, C.stoneDk, 1.4); p.form(S.disc(15, 5, 2), C.gold, { lv: 4 }); return p.edge(); }

// —— 诵经台、圣水盆、告解亭、管风琴 ——
function lectern() {                                        // 诵经台：黄铜的杆，斜的书台，摊开的大书，一条红书签
  const p = new Plate(34, 66), cx = 17;
  p.form(S.poly([[cx, 56], [cx + 12, 65], [cx - 12, 65]]), C.brass, { lv: 3, round: 2 });
  p.turn(cx + .5, 22, 58, prof([0, 1.6], [.2, 1.6], [.26, 4], [.32, 1.8], [.8, 2.2], [1, 3.4]), C.gold);
  p.form(S.poly([[2, 20], [32, 12], [33, 16], [3, 25]]), C.oak, { lv: 3, round: 2 });
  p.form(S.poly([[3, 9], [17, 6], [17, 19], [4, 22]]), C.parchment, { lv: 3.8, round: 2, lift: 1 }); p.form(S.poly([[17, 6], [31, 2], [31, 15], [17, 19]]), C.parchment, { lv: 3.2, round: 2, lift: 1 });
  for (let r = 0; r < 4; r++) { p.seg(6, 12 + r * 2.4, 14, 10.3 + r * 2.4, C.oakDk, 2, 1); p.seg(20, 8.5 + r * 2.4, 28, 6.4 + r * 2.4, C.oakDk, 2, 1); }
  p.block(6, 10, 2, 2, C.crimson, 4); p.block(16, 18, 2, 9, C.crimson, (u, v) => 4 - v); return p.edge();
}
function bowl() {                                           // 圣水盆：八角的石盆，盆里一汪发亮的水
  const p = new Plate(34, 48), cx = 17;
  p.turn(cx, 40, 47, prof([0, 5], [1, 11]), C.marble, { lv: 2.8 }); p.turn(cx, 18, 40, prof([0, 6], [.25, 3.4], [.8, 3.4], [.86, 6], [1, 5]), C.marble);
  p.turn(cx, 6, 18, prof([0, 15.6], [.25, 16], [1, 6]), C.pale, { lv: 3 });
  for (let x = 4; x < 30; x += 6) p.block(x, 9, 1, 6, C.stoneDk, 2);
  p.form(S.oval(cx, 6, 14, 3.4), C.cyan, { lv: 3, round: 1, grain: (x, y) => (Math.sin(x * .9 + y) > .6 ? 1.8 : 0) }); p.form(S.ring(S.oval(cx, 6, 15, 4.2), .9), C.pale, { lv: 4.4, round: 1 });
  return p.edge();
}
function confessional() {                                   // 告解亭：三开间的橡木亭子，中间挂帘，两边是格子窗
  const p = new Plate(76, 108), g = grainOf(11, 1.4, 5);
  p.form(S.any(S.rect(2, 26, 72, 80, 1), S.poly([[38, 2], [72, 26], [4, 26]])), C.oak, { lv: 3, round: 3, lift: 1.6, grain: g });
  p.form(S.rect(0, 100, 76, 8, 1), C.oakDk, { lv: 3, round: 2 }); p.form(S.rect(0, 24, 76, 5, 1), C.oak, { lv: 4, round: 2 });
  for (const x of [5, 53]) { p.form(S.ogive(x + 9, 92, 8, 54, 12), C.night, { lv: 1.6, round: 2, lift: 1.2 }); for (let y = 40; y < 92; y++) for (let k = 0; k < 18; k++) if (S.ogive(x + 9, 92, 8, 54, 12)(x + k + .5, y + .5) < -1 && ((k + y) % 5 === 0 || (k - y + 100) % 5 === 0)) p.ink(x + k, y, C.oak, 3.4); }   // 格子窗
  p.form(S.ogive(38, 98, 11, 64, 16), C.night, { lv: 1.4, round: 2 });
  p.form(S.cut(S.ogive(38, 98, 10, 56, 14), S.poly([[38, 60], [44, 98], [38, 98]])), C.wine, { lv: 3, round: 2, grain: (x) => Math.sin(x * 1.3) * 1.1 });   // 门帘，掀开一角
  p.form(S.foils(38, 16, 3.2, 3, 3), C.oakDk, { lv: 2, round: 1.5 }); p.block(37, 0, 2, 7, C.gold, 4); p.block(35, 2, 6, 2, C.gold, 4);
  for (const x of [26, 49]) p.block(x, 30, 2, 70, C.oakDk, 2.2);
  return p.edge();
}
function organ() {                                          // 管风琴的立面：三组长短不一的音管（金的、银的），下面是木头的琴箱和键盘
  const p = new Plate(140, 128), g = grainOf(21, 1.4, 5);
  p.form(S.rect(2, 84, 136, 43, 1), C.oak, { lv: 3, round: 3, grain: g });
  p.form(S.rect(0, 80, 140, 6, 1), C.oak, { lv: 4, round: 2 }); p.form(S.rect(0, 122, 140, 6, 1), C.oakDk, { lv: 3, round: 2 });
  for (let i = 0; i < 6; i++) if (i < 2 || i > 3) { const x = 8 + i * 22; p.form(S.rect(x, 90, 16, 28, 1), C.oakDk, { lv: 2.6, round: 2, lift: 2 }); p.form(S.foils(x + 8, 104, 3.4, 4, 3.2), C.oak, { lv: 3.4, round: 1.5 }); }
  p.block(50, 98, 40, 6, C.linen, (u, v, x) => (x % 3 === 0 ? 2 : 4.2) - v); p.block(50, 104, 40, 2, C.night, 2); p.block(52, 90, 36, 6, C.oakDk, 2); for (let x = 54; x < 88; x += 4) p.block(x, 92, 2, 2, C.gold, 4);   // 键盘和一排音栓
  p.block(56, 112, 28, 3, C.oakDk, 3.4);
  const pipe = (cx, top, r, rp) => {
    p.turn(cx, top + r, 78, () => r, rp, { lv: 3.2, lift: 2.4 }); p.turn(cx, top, top + r, prof([0, .6], [1, r]), rp, { lv: 3.6 }); p.turn(cx, 76, 81, prof([0, r], [1, 1]), rp, { lv: 2.6 });
    p.block(Math.floor(cx - r + 1), 66, Math.max(1, Math.round(r * 2 - 2)), 2, C.lead, 1);   // 管口
  };
  for (let i = 0; i < 7; i++) pipe(9 + i * 6.5, 30 + Math.abs(i - 3) * 7, 3, C.gold);                 // 左塔
  for (let i = 0; i < 7; i++) pipe(92 + i * 6.5, 30 + Math.abs(i - 3) * 7, 3, C.gold);                // 右塔
  for (let i = 0; i < 9; i++) pipe(54 + i * 4, 52 - Math.abs(i - 4) * 5 + 20 * (i % 2 ? 0 : 0), 2, i % 2 ? C.silver : C.gold);   // 中间一排细的
  for (let i = 0; i < 3; i++) pipe(63 + i * 7, 6 + Math.abs(i - 1) * 9, 3.5, C.silver);               // 顶上三根最高的
  // 管顶的木雕花檐
  for (const [x0, w, y] of [[4, 50, 24], [87, 50, 24], [50, 40, 44]]) for (let x = 0; x < w; x++) { const h = 3 + Math.round(2.5 * Math.abs(Math.sin(x / w * Math.PI * 5))); p.block(x0 + x, y - h + 4, 1, h, C.oak, 3.6 - (x % 5 === 0 ? 1.4 : 0)); }
  for (const x of [3, 53, 87, 137]) p.block(x - 2, 24, 3, 58, C.oakDk, (u) => 3 - u);
  return p.edge();
}

// —— 石像、壁龛、石棺、墓碑 ——
function knight() {                                         // 骑士石像：拄剑而立，左臂挂盾，站在墩座上
  const p = new Plate(36, 88), cx = 18, g = grainOf(5);
  p.form(S.any(S.rect(10, 30, 16, 26, 4), S.rect(11, 52, 6, 22, 1), S.rect(19, 52, 6, 22, 1), S.bar(8, 33, 7, 50, 2.6), S.bar(28, 33, 26, 48, 2.6), S.rect(9, 30, 18, 5, 2.4)), C.pale, { lv: 3, round: 3, lift: 1.9, grain: g });
  p.form(S.any(S.disc(cx, 21, 5.6), S.rect(13, 21, 10, 8, 2)), C.pale, { lv: 3.3, round: 3, lift: 1.9, grain: g }); p.block(14, 20, 8, 1, C.stoneDk, 1.2); p.block(cx, 21, 1, 5, C.stoneDk, 1.2);
  p.form(S.poly([[cx, 9], [cx + 3, 16], [cx - 2, 16]]), C.pale, { lv: 3.6, round: 1.5 });                 // 盔顶的翎
  p.block(10, 47, 16, 2, C.stoneDk, 2); p.block(17, 36, 2, 36, C.pale, (u, v) => 5 - v * 1.4); p.block(13, 38, 10, 2, C.marble, 4.4); p.block(17, 33, 2, 5, C.marble, 3.6);
  p.form(S.ogive(8, 0, 6, 0, 0) && S.poly([[2, 38], [13, 38], [13, 50], [7.5, 58], [2, 50]]), C.marble, { lv: 3.2, round: 2.5, lift: 1.8 }); p.block(7, 41, 1, 12, C.stoneDk, 2); p.block(4, 45, 7, 1, C.stoneDk, 2);
  p.form(S.rect(4, 76, 28, 11, 1), C.stone, { lv: 3, round: 2, grain: g }); p.form(S.rect(2, 73, 32, 4, 1), C.marble, { lv: 3.6, round: 2 }); return p.edge();
}
function angel() {                                          // 天使石像：长袍，合掌，一对翅膀，头上一圈金光环
  const p = new Plate(50, 92), cx = 25, g = grainOf(15);
  for (const s of [-1, 1]) { p.form(S.poly([[cx + s * 4, 30], [cx + s * 20, 10], [cx + s * 24, 26], [cx + s * 21, 52], [cx + s * 8, 58]]), C.marble, { lv: 2.8, round: 4, lift: 2, grain: g }); for (let k = 0; k < 4; k++) p.seg(cx + s * (10 + k * 3), 24 + k * 2, cx + s * (9 + k * 3.4), 50 - k * 3, C.stoneDk, 2, 1); }
  p.form(S.any(S.poly([[cx - 6, 30], [cx + 6, 30], [cx + 11, 76], [cx - 11, 76]]), S.rect(cx - 8, 29, 16, 8, 3)), C.pale, { lv: 3.2, round: 4, lift: 1.9, grain: (x, y) => g(x, y) + Math.sin(x * 1.1 + y * .12) * .5 });
  p.form(S.disc(cx, 22, 5.2), C.pale, { lv: 3.5, round: 3.5, lift: 1.8 }); p.form(S.ring(S.oval(cx, 14.5, 6.5, 2.2), .8), C.gold, { lv: 4.4, round: 1 });
  p.form(S.any(S.bar(cx - 7, 36, cx - 1, 44, 2), S.bar(cx + 7, 36, cx + 1, 44, 2)), C.pale, { lv: 3.6, round: 2 }); p.block(cx - 1, 40, 3, 5, C.pale, 4.6);
  p.form(S.rect(8, 80, 34, 11, 1), C.stone, { lv: 3, round: 2, grain: g }); p.form(S.rect(6, 76, 38, 5, 1), C.marble, { lv: 3.6, round: 2 }); return p.edge();
}
function niche() {                                          // 壁龛：墙上一个尖拱的凹洞，里面越往上越暗，外头一圈石线脚
  const p = new Plate(54, 108), out = S.ogive(27, 104, 26, 102, 40), inn = S.ogive(27, 104, 21, 96, 34);
  p.form(out, C.stone, { lv: 3.4, round: 3, lift: 2 });
  p.form(inn, C.night, { lv: 2, round: 4, lift: -1.6, grain: (x, y) => (y - 30) / 50 + (x > 27 ? .5 : -.2) });
  p.form(S.rect(0, 102, 54, 6, 1), C.marble, { lv: 3.6, round: 2 }); return p.edge();
}
function effigy() {                                         // 石棺盖上躺着的骑士像（侧面看）
  const p = new Plate(88, 24), g = grainOf(31);
  p.form(S.rect(1, 17, 86, 6, 1), C.marble, { lv: 3.4, round: 2, grain: g });
  p.form(S.any(S.rect(4, 11, 14, 7, 3), S.rect(16, 8, 46, 10, 4), S.rect(58, 10, 22, 8, 3), S.poly([[78, 18], [78, 5], [84, 8], [84, 18]])), C.pale, { lv: 3.2, round: 3.5, lift: 2, grain: g });
  p.form(S.disc(12, 8.5, 5), C.pale, { lv: 3.5, round: 3, lift: 1.8 }); p.form(S.bar(34, 6, 44, 6, 2.4), C.pale, { lv: 4, round: 2 }); p.block(40, 7, 34, 1, C.stoneDk, 2); return p.edge();
}
function sarcoSide() {                                      // 石棺的正面：一排盲拱
  const p = new Plate(98, 32);
  p.form(S.rect(1, 3, 96, 26, 0), C.stone, { lv: 3, round: 2, grain: grainOf(41) });
  for (let i = 0; i < 7; i++) { const x = 9 + i * 13.4; p.form(S.ogive(x, 27, 5, 20, 8), C.stoneDk, { lv: 2.2, round: 2, lift: -1.8 }); p.form(S.foils(x, 14, 1.6, 3, 1.5), C.night, { lv: 2 }); }
  p.form(S.rect(0, 0, 98, 4, 1), C.marble, { lv: 3.8, round: 2 }); p.form(S.rect(0, 28, 98, 4, 1), C.marble, { lv: 3.2, round: 2 }); return p.edge();
}
function tomb(k) {                                          // 墓碑地砖（贴地）：刻线的边框、十字 / 盾剑 / 骷髅，几行磨平了的字
  const p = new Plate(38, 68), g = grainOf(50 + k, 1.6, 7);
  p.form(S.rect(0, 0, 38, 68, 1), k === 1 ? C.stoneDk : C.marbleDk, { lv: 2.7, round: 2, lift: 1.2, grain: g, line: 1.4 });
  const cut = (d) => p.form(d, C.night, { lv: 1.8, round: 1, lift: -1.4 });
  cut(S.ring(S.rect(3.5, 3.5, 31, 61, 0), .6));
  if (k === 0) cut(S.any(S.rect(18, 8, 2.4, 26, 0), S.rect(11, 14, 16, 2.4, 0), S.ring(S.disc(19, 15, 5), .6)));
  if (k === 1) { cut(S.ring(S.poly([[10, 9], [28, 9], [28, 22], [19, 32], [10, 22]]), .7)); cut(S.bar(19, 12, 19, 27, .7)); cut(S.bar(14, 16, 24, 16, .7)); }
  if (k === 2) { cut(S.any(S.disc(19, 15, 6), S.rect(15, 18, 8, 6, 1))); p.form(S.any(S.disc(16.5, 14.5, 1.5), S.disc(21.5, 14.5, 1.5)), g ? C.marbleDk : C.stone, { lv: 3 }); cut(S.any(S.bar(10, 27, 28, 34, .8), S.bar(28, 27, 10, 34, .8))); }
  for (let r = 0; r < 5; r++) for (let x = 8; x < 30; x++) if (hash(x >> 1, r, 60 + k) > .35) p.ink(x, 40 + r * 4, C.night, 1.8);
  return p;
}

// —— 布：长旗、帷幔 ——
function banner(rp, dk, mark) {                             // 长旗：燕尾，金穗，中间一个徽
  const p = new Plate(30, 90), cx = 15;
  p.form(S.cut(S.rect(2, 3, 26, 86, 0), S.poly([[cx, 74], [30, 92], [0, 92]])), rp, { lv: 3, round: 2, lift: 1, grain: (x, y) => Math.sin(x * .7 + Math.sin(y / 9)) * .9 + (y > 60 ? -.3 : 0) });
  for (let y = 4; y < 90; y++) for (const x of [2, 3, 26, 27]) if (p.has(x, y)) p.ink(x, y, C.gold, 3 + (y % 3 === 0 ? 1.4 : 0));
  p.block(0, 0, 30, 3, C.brass, (u, v) => 4.4 - v * 1.4); for (const x of [0, 28]) p.block(x, 0, 2, 5, C.gold, 4);
  p.block(4, 8, 22, 2, dk, 2.4); p.block(4, 54, 22, 2, dk, 2.4);
  mark(p, cx, 31); return p.edge();
}
const markStar = (p, cx, cy) => p.each((x, y) => { const dx = x + .5 - cx, dy = y + .5 - cy, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx); return r < 3.5 + 6.5 * Math.abs(Math.cos(a * 2)) ** 4 ? [C.white, r < 3 ? 5 : 4, .4] : null; });
const markSword = (p, cx, cy) => { p.block(cx - 1, cy - 11, 3, 23, C.gold, (u, v) => 4.6 - v); p.block(cx - 6, cy - 5, 13, 3, C.gold, 4); p.form(S.disc(cx + .5, cy - 12, 2.4), C.amber, { lv: 4 }); };
const markCrown = (p, cx, cy) => { p.form(S.poly([[cx - 8, cy + 6], [cx - 9, cy - 5], [cx - 4, cy], [cx, cy - 8], [cx + 4, cy], [cx + 9, cy - 5], [cx + 8, cy + 6]]), C.gold, { lv: 3.8, round: 2 }); p.block(cx - 7, cy + 4, 14, 2, C.amber, 3); };
function drape(rp) {                                        // 帷幔：一道道竖褶，三分之二处拿金绳一扎，下面散开
  const p = new Plate(30, 104);
  p.each((x, y) => {
    const t = y / 103, tie = Math.abs(t - .62), hw = t < .62 ? 13 - 7 * (t / .62) ** 2 : 6 + 8 * ((t - .62) / .38) ** .7, u = (x + .5 - 15) / hw;
    if (Math.abs(u) > 1) return null;
    if (tie < .016) return [C.gold, 3.6 + (x & 1), .5];
    if (y > 100) return [C.gold, 3 + (x % 3 === 0 ? 1.5 : 0), .5];
    return [rp, 2.9 + Math.sin(u * 7.5 + 1) * 1.3 - u * .6 - (t < .08 ? 1 : 0), .7];
  });
  return p.edge();
}
function valance(rp) {                                      // 帷幔顶上的一条垂花
  const p = new Plate(90, 20);
  p.each((x, y) => { const k = (x % 30) / 30, sag = 9 + Math.sin(k * Math.PI) * 9; if (y > sag) return null; if (y > sag - 2) return [C.gold, 3.4 + (x & 1), .5]; return [rp, 3 + Math.sin(k * Math.PI * 2 + y * .5) * 1.1 - (y < 2 ? 1.2 : 0), .7]; });
  for (const x of [0, 29, 59, 88]) p.block(x, 8, 2, 10, C.gold, (u, v) => 4.4 - v * 1.5);
  return p.edge();
}

// —— 栏杆、盾徽、尖饰 ——
function rail(rp, tip) {                                    // 一段栏杆（48 像素一段，能左右接）
  const p = new Plate(48, 36);
  for (let x = 2; x < 48; x += 6) { p.block(x, 6, 2, 30, rp, (u) => 3.6 - u * 1.4); p.form(S.poly([[x + 1, 0], [x + 3.4, 5], [x + 1, 8], [x - 1.4, 5]]), tip, { lv: 3.8, round: 1.5 }); }
  p.block(0, 10, 48, 2, rp, (u, v) => 4 - v * 1.6); p.block(0, 28, 48, 3, rp, (u, v) => 3.8 - v * .8);
  for (let x = 5; x < 48; x += 12) p.form(S.ring(S.disc(x + 3, 20, 4), .9), rp, { lv: 3.2, round: 1 });
  return p.edge();
}
function shield(rp, mark) { const p = new Plate(24, 28); p.form(S.poly([[2, 2], [22, 2], [22, 14], [12, 27], [2, 14]]), C.gold, { lv: 3.4, round: 2 }); p.form(S.poly([[4, 4], [20, 4], [20, 13], [12, 24], [4, 13]]), rp, { lv: 3.2, round: 2 }); mark(p); return p.edge(); }
function finial() { const p = new Plate(16, 26), cx = 8; p.form(S.any(S.rect(cx - 1.5, 2, 3, 20, 0), S.rect(cx - 6, 7, 12, 3, 0), S.foils(cx, 8.5, 6, 4, 2.2, 0)), C.silver, { lv: 3.6, round: 1.6 }); p.turn(cx, 20, 25, prof([0, 2], [1, 5]), C.silver); p.form(S.disc(cx, 8.5, 1.6), C.cyan, { lv: 4.5 }); return p.edge(); }
function spikes() { const p = new Plate(96, 18); for (let x = 2; x < 96; x += 8) { const h = (x >> 3) % 3 === 1 ? 16 : 11; p.form(S.poly([[x + 2, 17 - h], [x + 5, 17], [x - 1, 17]]), C.iron, { lv: 3.2, round: 1.5 }); p.block(x + 1, 17 - h, 2, 2, C.gold, 4.6); } p.block(0, 15, 96, 3, C.iron, (u, v) => 3.8 - v); return p.edge(); }
function reliquary() {                                      // 银圣物匣：小房子形，屋脊一排尖饰，镶蓝宝石，四只小脚
  const p = new Plate(48, 48);
  p.form(S.any(S.rect(4, 22, 40, 20, 1), S.poly([[8, 22], [14, 9], [34, 9], [40, 22]])), C.silver, { lv: 3.3, round: 3, lift: 2 });
  for (let x = 15; x < 34; x += 4) p.block(x, 6, 2, 3, C.silver, 5); p.form(S.any(S.rect(23, 0, 2, 9, 0), S.rect(20, 2, 8, 2, 0)), C.silver, { lv: 4.6 });
  for (let i = 0; i < 4; i++) { const x = 10 + i * 9.4; p.form(S.ogive(x, 39, 3.2, 13, 5), C.royal, { lv: 2.6, round: 1.5, lift: -1.4 }); }
  for (const [x, y, rp] of [[24, 15.5, C.cyan], [15, 16, C.sapphire], [33, 16, C.sapphire]]) { p.form(S.disc(x, y, 2.6), rp, { lv: 4, round: 2 }); p.dot(Math.floor(x - 1), Math.floor(y - 1), C.white[6]); }
  p.block(4, 22, 40, 1, C.silver, 5.4); p.block(4, 40, 40, 2, C.silver, 2.2); for (const x of [5, 39]) p.block(x, 42, 4, 5, C.silver, (u) => 4 - u * 1.6);
  return p.edge();
}
function frontal(rp, dk) {                                  // 小龛里台子上铺的布：队伍色，金 / 银的边
  const p = new Plate(50, 30);
  p.each((x, y) => { const e = Math.min(x, 49 - x), f = Math.sin(x / 4) * .6; if (y > 26) return (x % 4 < 2) ? [C.gold, 3.4, .5] : null; if (e < 2 || y < 2) return [C.gold, 3 + f, .5]; if (Math.abs(Math.abs(x - 24.5) + Math.abs(y - 14) - 8) < 1.2) return [C.gold, 4, .5]; return [Math.abs(x - 24.5) + Math.abs(y - 14) < 8 ? dk : rp, 3 + f, .7]; });
  return p;
}
function darkNiche(rp, bars) {                              // 血量牌背后那块暗的凹龛：素、暗，只有一点点纹理
  const p = new Plate(66, 80), sh = S.ogive(33, 80, 32, 79, 30);
  p.form(sh, rp, { lv: 1.3, round: 5, lift: -1, grain: (x, y) => (cloud(x / 14, y / 14, 3, 2) - .5) * .8 + (bars && (x % 9 === 0) ? .6 : 0) + (!bars && ((x + y) % 14 === 0 || (x - y + 140) % 14 === 0) ? .5 : 0) });
  return p;
}
function glassFrame(shape, rp) { const p = new Plate(shape.w, shape.h); p.form(shape.f, rp, { lv: 3.2, round: 4, lift: 2.2 }); return p.edge(); }

// —— 散在地上的：书页、花瓣、书 ——
function pages(k) { const p = new Plate(14, 11); [[1, 2, 8, 6], [5, 4, 8, 6]].slice(0, 1 + (k & 1)).forEach(([x, y, w, h], i) => { p.block(x, y, w, h, C.parchment, 3.6 + i * .8 - k * .2); for (let r = 1; r < h - 1; r += 2) p.block(x + 1, y + r, w - 2 - (r % 3), 1, C.oak, 3.4); }); return p; }
function petals(k) { const p = new Plate(16, 12), rp = [C.crimson, C.rosy, C.white][k]; for (let i = 0; i < 9; i++) { const x = 1 + Math.floor(hash(i, k, 7) * 13), y = 1 + Math.floor(hash(i, k, 9) * 9); p.ink(x, y, rp, 3.5); p.ink(x + 1, y, rp, 4.5); if (i % 2) p.ink(x, y + 1, rp, 2.6); } return p; }
function bookOpen() { const p = new Plate(24, 16); p.form(S.rect(0, 1, 24, 14, 1), C.wine, { lv: 2.6, round: 2 }); p.block(2, 2, 10, 11, C.parchment, 4); p.block(12, 2, 10, 11, C.parchment, 3.4); p.block(11, 2, 1, 11, C.oakDk, 2); for (let r = 0; r < 4; r++) { p.block(3, 4 + r * 2, 7, 1, C.oak, 3.6); p.block(13, 4 + r * 2, 7 - r % 2, 1, C.oak, 3.2); } return p; }
function bouquet() { const p = new Plate(20, 10); p.seg(1, 6, 12, 5, C.leaf, 2.4, 2); for (const [x, y, rp] of [[13, 3, C.crimson], [16, 6, C.white], [12, 7, C.rosy], [17, 2, C.rosy]]) p.form(S.disc(x, y, 2.3), rp, { lv: 3.8, round: 1.5 }); return p.edge(); }
function rosette() {                                        // 贴地的圆形拼花：黄铜圈、红蓝相间的扇形、中间一颗八角星。颜色压着，不和彩窗抢
  const N = 72, c = N / 2, p = new Plate(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + .5 - c, dy = y + .5 - c, r = Math.hypot(dx, dy), a = (Math.atan2(dy, dx) + TAU) % TAU, v = (cloud(x / 9, y / 9, 71, 2) - .5) * 1.6;
    if (r > 35) continue;
    if (r > 33 || Math.abs(r - 24) < 1) { p.ink(x, y, C.brass, 2.6 + v + (dx + dy < 0 ? .7 : -.3)); continue; }
    if (r > 25) { const k = Math.floor(a / TAU * 16), e = Math.abs((a / TAU * 16) % 1 - .5); p.ink(x, y, e > .44 ? C.night : k & 1 ? C.wine : C.royal, e > .44 ? 1.4 : 2.3 + v); continue; }
    const star = 9 + 13 * Math.abs(Math.cos(a * 4)) ** 2.4;
    if (r < 3.5) p.ink(x, y, C.gold, 3 + v);
    else if (r < star - 1) p.ink(x, y, Math.floor(a / TAU * 16 + .5) & 1 ? C.marble : C.stone, 2.8 + v);
    else if (r < star) p.ink(x, y, C.night, 1.4);
    else p.ink(x, y, C.basalt, 2.4 + v);
  }
  return p;
}
function inlay(k) {                                         // 贴地的小方拼花：深色方砖里嵌一颗四角星 / 一个四叶
  const p = new Plate(30, 30), g = grainOf(80 + k, 1.4, 7);
  p.form(S.rect(0, 0, 30, 30, 0), k ? C.wine : C.basalt, { lv: 2.4, round: 1.5, lift: 1, grain: g, line: 1.3 });
  p.form(S.ring(S.rect(3, 3, 24, 24, 0), .6), C.brass, { lv: 3, round: 1 });
  p.form(k ? S.foils(15, 15, 4.6, 4, 3.6, Math.PI / 4) : S.poly([[15, 5], [17.5, 12.5], [25, 15], [17.5, 17.5], [15, 25], [12.5, 17.5], [5, 15], [12.5, 12.5]]), k ? C.stone : C.marble, { lv: 2.9, round: 2, lift: 1.2, grain: g });
  p.form(S.disc(15, 15, 1.7), C.gold, { lv: 3.4 });
  return p;
}
function fallPetal(k) { const p = new Plate(4, 4), rp = k & 1 ? C.rosy : C.crimson; p.ink(1, 0, rp, 5).ink(2, 1, rp, 4).ink(1, 1, rp, 4).ink(k & 2 ? 0 : 2, 2, rp, 3).ink(1, 2, rp, 3); return p; }
function fallPage(k) { const p = new Plate(9, 7); p.form(S.poly(k ? [[0, 2], [8, 0], [9, 4], [1, 6]] : [[1, 0], [9, 2], [8, 6], [0, 4]]), C.parchment, { lv: k ? 4.4 : 3.6, round: 1.5, lift: 1 }); p.block(3, 3, 4, 1, C.oak, 3.6); return p; }
function dove(k) {                                          // 飞过的鸽子：两帧，翅膀一上一下
  const p = new Plate(22, 14);
  p.form(S.any(S.oval(11, 8, 6, 2.6), S.disc(17, 7, 2), S.poly([[2, 6], [7, 7], [6, 10], [1, 10]])), C.white, { lv: 3.6, round: 2 });
  p.form(k ? S.poly([[8, 7], [12, 0], [15, 1], [14, 8]]) : S.poly([[8, 8], [10, 13], [14, 13], [14, 8]]), C.white, { lv: k ? 4.4 : 3, round: 1.5 }); p.dot(19, 7, C.amber[3]); p.dot(17, 6, C.lead); return p.edge();
}

// —— 贴镜头的前景剪影：先照常画，再整张压暗成冷紫的剪影（只留一点点轮廓光）——
function fgRail() {                                         // 铁艺栏杆：卷草和百合花尖
  const p = new Plate(160, 70);
  for (let x = 6; x < 160; x += 14) { p.block(x, 12, 3, 58, C.iron, (u) => 4 - u * 2); p.form(S.any(S.poly([[x + 1.5, 0], [x + 5, 8], [x + 1.5, 14], [x - 2, 8]]), S.disc(x - 2.5, 11, 2.4), S.disc(x + 5.5, 11, 2.4)), C.iron, { lv: 3.6, round: 2 }); }
  for (let x = 13; x < 160; x += 14) { p.form(S.ring(S.disc(x, 34, 5.5), 1.3), C.iron, { lv: 3.2, round: 1 }); p.form(S.ring(S.disc(x, 52, 4), 1.2), C.iron, { lv: 3, round: 1 }); }
  p.block(0, 20, 160, 4, C.iron, (u, v) => 4.4 - v * 2); p.block(0, 60, 160, 5, C.iron, (u, v) => 4 - v * 1.6); return p.dim(.5, [.8, .75, 1.25]);
}
function fgCandle() {                                       // 一座大烛台的剪影（火苗另外放，是亮的）
  const p = new Plate(70, 200), cx = 35, xs = [8.5, 35.5, 62.5], ys = [46, 30, 46];
  for (const i of [0, 2]) { p.seg(cx, 80, xs[i], 70, C.iron, 3.4, 4); p.seg(xs[i] - 1, 70, xs[i] - 1, ys[i] + 6, C.iron, 3.4, 4); }
  p.turn(cx + .5, 36, 180, prof([0, 3], [.1, 3], [.14, 9], [.18, 3.4], [.5, 3.6], [.54, 8], [.58, 4], [.9, 5], [1, 7]), C.iron, { lv: 3 }); p.turn(cx + .5, 180, 199, prof([0, 7], [1, 30]), C.iron, { lv: 2.6 });
  for (let i = 0; i < 3; i++) { p.turn(xs[i], ys[i], ys[i] + 6, prof([0, 8], [1, 3]), C.iron, { lv: 3.2 }); stick(p, xs[i], ys[i] - 22 + (i === 1 ? -4 : 0), ys[i] - 1, 3.5, C.oak); }
  const tips = p.tips; p.dim(.5, [.8, .75, 1.25]); p.tips = tips; return p;
}
function fgPew() {                                          // 长椅靠背的剪影：一排尖拱雕板，两头各一个罂粟头
  const p = new Plate(180, 76);
  p.form(S.rect(8, 22, 164, 54, 1), C.oakDk, { lv: 3, round: 3, lift: 2 }); p.form(S.rect(4, 16, 172, 8, 2), C.oakDk, { lv: 4, round: 3 });
  for (let x = 20; x < 164; x += 22) p.form(S.ogive(x + 6, 70, 7, 38, 11), C.night, { lv: 2, round: 2, lift: -1.4 });
  for (const x of [8, 172]) p.form(S.any(S.rect(x - 5, 14, 10, 62, 1), S.foils(x, 8, 3.6, 3, 4.4), S.rect(x - 2, 8, 4, 8, 0)), C.oakDk, { lv: 3.4, round: 3 });
  return p.dim(.5, [.85, .72, 1.2]);
}
function fgArch() {                                         // 画面上角的拱肋：两道弧，弧里一排小尖齿，垂下一条链子和一盏灯
  const p = new Plate(220, 150);
  const arc = S.cut(S.disc(230, 250, 262), S.disc(230, 250, 236)), arc2 = S.cut(S.disc(250, 300, 300), S.disc(250, 300, 290));
  p.form(S.any(arc, arc2, S.rect(0, 0, 220, 16, 0)), C.stoneDk, { lv: 2.6, round: 4, lift: 2 });
  for (let i = 0; i < 9; i++) { const a = Math.PI + .12 + i * .1, x = 230 + Math.cos(a) * 232, y = 250 + Math.sin(a) * 232; p.form(S.all(S.disc(x, y, 8), S.disc(230, 250, 238)), C.stoneDk, { lv: 2.2, round: 2 }); }
  p.block(96, 30, 2, 60, C.iron, 3); p.form(S.any(S.poly([[97, 88], [107, 100], [97, 118], [87, 100]]), S.rect(92, 86, 10, 3, 0)), C.iron, { lv: 3, round: 2 });
  return p.dim(.42, [.8, .72, 1.3]);
}

// —— 全部小件 ——
export function sprites() {
  const o = {};
  for (let f = 0; f < 4; f++) { o['fa' + f] = flame(C.flame, 7, 12, f); o['fs' + f] = flame(C.flame, 5, 8, f); o['fc' + f] = flame(C.cold, 7, 12, f); o['fb' + f] = flame(C.flame, 13, 19, f); }
  for (let k = 0; k < 3; k++) { o['smoke' + k] = puff(8 + k * 4, k * 7); o['tomb' + k] = tomb(k); o['pages' + k] = pages(k); o['petals' + k] = petals(k); }
  for (let k = 0; k < 4; k++) o['petF' + k] = fallPetal(k);
  Object.assign(o, {
    candles3: candles3(), candles5: candles5(), waxpool: waxpool(), candelabra: candelabra(), chandelier: chandelier(), rack: rack(), ironTree: ironTree(), lampS: lampS(), brazier: brazier(), sconce: sconce(),
    censer: censer(), chain: chain(), rope: rope(), sally: sally(),
    cross: cross(), altarFront: altarFront(), chalice: chalice(), vase0: vase(0), vase1: vase(1), bookstack: bookstack(), cushR: cushion(C.crimson), cushT: cushion(C.tealCloth), kneeler: kneeler(), chest: chest(), hymn: hymn(), plaque: plaque(),
    lectern: lectern(), bowl: bowl(), confessional: confessional(), organ: organ(),
    knight: knight(), angel: angel(), niche: niche(), effigy: effigy(), sarcoSide: sarcoSide(),
    banT: banner(C.tealCloth, C.royal, markStar), banR: banner(C.crimson, C.wine, markSword), banG: banner(C.amethyst, C.wine, markCrown),
    drT: drape(C.tealCloth), drR: drape(C.crimson), valT: valance(C.tealCloth), valR: valance(C.crimson),
    railI: rail(C.iron, C.gold), railS: rail(C.silver, C.cyan),
    shieldT: shield(C.teal, p => markStar(p, 12, 11)), shieldR: shield(C.red, p => { p.block(11, 5, 2, 15, C.gold, 4.6); p.block(7, 9, 10, 2, C.gold, 4.2); }),
    finial: finial(), spikes: spikes(), reliquary: reliquary(), frontT: frontal(C.tealCloth, C.royal), frontR: frontal(C.crimson, C.wine),
    darkT: darkNiche(C.ownTile, false), darkR: darkNiche(C.foeTile, true),
    frameT: glassFrame({ w: 54, h: 68, f: S.ogive(27, 68, 26, 67, 40) }, C.pale), frameR: glassFrame({ w: 64, h: 64, f: S.disc(32, 32, 31.5) }, C.iron),
    frameRose: glassFrame({ w: 132, h: 132, f: S.disc(66, 66, 65.5) }, C.marble), frameL: glassFrame({ w: 60, h: 120, f: S.ogive(30, 120, 29, 119, 48) }, C.stone),
    rosette: rosette(), inlay0: inlay(0), inlay1: inlay(1),
    bookOpen: bookOpen(), bouquet: bouquet(), pageF0: fallPage(0), pageF1: fallPage(1), dove0: dove(0), dove1: dove(1),
    fgRail: fgRail(), fgCandle: fgCandle(), fgPew: fgPew(), fgArch: fgArch(),
  });
  return o;
}
