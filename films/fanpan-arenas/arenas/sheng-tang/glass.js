// 《彩窗圣堂》的彩窗：后墙的大玫瑰窗、六扇图案各不相同的尖拱窗、两座小龛各自的窗。
// 画法：先把窗分成一块块「色区」（花瓣、人物、底纹、边条……），色区之间自动出铅条；
// 每个色区里再用碎格切成一小片一小片的玻璃，每片深浅不同，片与片之间一道细暗线。
// 这些图贴在不吃光的材质上并乘到 1 以上，高画质档会晕开。
import { Plate, C, S, cell, CELL, hash } from './paint.js';

const TAU = Math.PI * 2;
// shape：窗的外形（距离函数）；pick(x, y, d) → [色阶, 色区编号, 亮度增减]
function pane(w, h, shape, pick, { seed = 0, cs = 4.5, came = 1.4 } = {}) {
  const P = new Plate(w, h), zone = new Int32Array(w * h).fill(-1), info = new Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { const d = shape(x + .5, y + .5); if (d < 0) { info[i] = pick(x + .5, y + .5, d); zone[i] = info[i][1]; } }
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const z = zone[i]; if (z < 0) continue;
    const zr = x + 1 < w ? zone[i + 1] : -1, zd = y + 1 < h ? zone[i + w] : -1;
    if (shape(x + .5, y + .5) > -came || (zr >= 0 && zr !== z) || (zd >= 0 && zd !== z)) { P.dot(x, y, C.lead); continue; }   // 窗框边和色区之间的铅条
    cell(x / cs, y / cs, seed + z * 3);
    let L = 3.1 + (hash(CELL[0], z, seed) - .5) * 2.6 + (info[i][2] || 0);
    if (CELL[2] - CELL[1] < .1) L -= 1.5;                    // 小玻璃片之间的细线
    P.ink(x, y, info[i][0], L, .35);
  }
  return P;
}
const diamond = (x, y, s) => Math.floor((x + y) / s) * 31 + Math.floor((x - y + 400) / s);      // 菱形格的编号
const edging = (d, y, wd, a, b, s = 6) => d > -wd ? [Math.floor(y / s) & 1 ? a : b, 900 + Math.floor(y / s), .3] : null;   // 沿边一圈两色相间的小块

// 大玫瑰窗（直径 116 像素）：中心一颗金心，八片红蓝相间的花瓣，十六道放射的尖瓣，最外一圈小圆窗
export function rose() {
  const N = 116, c = N / 2, LANC = [C.ruby, C.sapphire, C.emerald, C.amethyst];
  return pane(N, N, S.disc(c, c, 58), (x, y) => {
    const dx = x - c, dy = y - c, r = Math.hypot(dx, dy), a = (Math.atan2(dy, dx) + TAU) % TAU;
    if (r < 7) return [C.amber, 0, 1.6];
    if (r < 10) return [C.white, 1 + Math.floor(a / TAU * 8), .8];
    if (r < 27) {                                            // 八片花瓣
      const k = Math.round(a / TAU * 8) % 8, ak = k * TAU / 8, px = c + Math.cos(ak) * 18, py = c + Math.sin(ak) * 18, d = Math.hypot(x - px, y - py);
      if (d < 3) return [C.amber, 40 + k, 1.2];
      if (d < 7.6) return [k & 1 ? C.ruby : C.sapphire, 10 + k, .5];
      return [C.royal, 2, -1];
    }
    if (r < 30.5) { const s = Math.floor(a / TAU * 24); return [s & 1 ? C.amber : C.emerald, 60 + s, .6]; }   // 一圈金绿相间的小块
    if (r < 51) {                                            // 十六道尖瓣：外头宽、里头尖
      const s = Math.floor(a / TAU * 16), off = (a / TAU * 16 - s - .5) * TAU / 16 * r, hw = Math.min(7.2, (r - 29.5) * .62);
      if (Math.abs(off) < hw) return Math.hypot(off, r - 44.5) < 3.2 ? [C.amber, 200 + s, 1.2] : [LANC[s % 4], 100 + s, .4];
      return [C.royal, 3, -1.2];
    }
    const s = Math.round(a / TAU * 16) % 16, as = s * TAU / 16, d = Math.hypot(x - c - Math.cos(as) * 54, y - c - Math.sin(as) * 54);
    return d < 3.4 ? [s & 1 ? C.cyan : C.rosy, 300 + s, 1] : [C.sapphire, 4, -1.4];
  }, { seed: 7, cs: 4 });
}

// 六扇尖拱窗（50×112）：图案各不相同
const LW = 50, LH = 112, lancetShape = S.ogive(LW / 2, LH, 24, LH, 42);
export function lancets() {
  const cx = LW / 2;
  // 一：蓝底上的圣徒——金光环、绿袍、红披肩
  const saint = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 5, C.ruby, C.amber); if (e) return e;
    if (Math.hypot(x - cx, y - 40) < 4.6) return [C.white, 1, 1];
    if (Math.hypot(x - cx, y - 40) < 8.2) return [C.amber, 2, 1];
    if (y > 100) return [C.emerald, 3, -1.2];
    const hw = 7 + (y - 47) * .13;
    if (y > 46 && Math.abs(x - cx) < hw) return x - cx < -1 - (y - 47) * .05 ? [C.ruby, 5, .3] : [C.emerald, 4, .5];
    if (y > 58 && y < 70 && Math.abs(x - cx - 4) < 3) return [C.white, 6, .8];           // 手里的书
    return [C.sapphire, 100 + diamond(x, y, 9), 0];
  }, { seed: 11 });
  // 二：红底上三枚四叶圆章
  const medals = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 4.5, C.white, C.cyan, 5); if (e) return e;
    for (let k = 0; k < 3; k++) {
      const my = 30 + k * 28, q = S.foils(cx, my, 6, 4, 6.2, Math.PI / 4)(x, y);
      if (Math.hypot(x - cx, y - my) < 3.5) return [C.amber, 10 + k, 1.3];
      if (q < -2) return [k === 1 ? C.emerald : C.sapphire, 20 + k, .4];
      if (q < 0) return [C.white, 30 + k, .7];
    }
    return [C.ruby, 100 + diamond(x, y, 8), -.1];
  }, { seed: 23 });
  // 三：紫底上一棵弯弯的金树，绿叶红果
  const tree = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 4.5, C.amber, C.emerald, 7); if (e) return e;
    const tx = cx + Math.sin(y / 9) * 6;
    if (y > 26 && Math.abs(x - tx) < 2.2) return [C.amber, 1, .8];
    cell(x / 9, y / 9, 5); const id = CELL[0], near = CELL[1];
    if (y > 20 && hash(id, 1, 3) > .45 && near < .42) return hash(id, 2, 3) > .72 ? [C.ruby, 1000 + (id & 1023), 1] : [C.emerald, 2000 + (id & 1023), .4];
    return [C.amethyst, 3, -.6];
  }, { seed: 31 });
  // 四：蓝天上一轮放光的太阳，下面是一层层的浪
  const sun = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 4.5, C.ruby, C.rosy, 6); if (e) return e;
    const r = Math.hypot(x - cx, y - 36), a = Math.atan2(y - 36, x - cx);
    if (r < 8) return [C.amber, 1, 1.6];
    if (r < 19) { const s = Math.floor((a + TAU) / TAU * 12); return [s & 1 ? C.amber : C.white, 10 + s, .7]; }
    if (y > 64) { const b = Math.floor((y + Math.sin(x / 4.5) * 3) / 7); return [[C.cyan, C.sapphire, C.emerald][b % 3], 50 + b, b & 1 ? .3 : -.2]; }
    return [C.sapphire, 100 + diamond(x, y, 10), -.3];
  }, { seed: 43 });
  // 五：绿底上的骑士——白甲、红盾金十字、竖着的剑
  const knight = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 4.5, C.sapphire, C.white, 6); if (e) return e;
    if (Math.abs(x - 36) < 1.6 && y > 34 && y < 92) return [C.white, 1, 1.2];            // 剑
    if (Math.abs(y - 78) < 1.6 && Math.abs(x - 36) < 5) return [C.amber, 2, 1];
    if (Math.hypot(x - 22, y - 44) < 5.5) return [C.white, 3, .6];                       // 头盔
    if (y < 40 && y > 30 && Math.abs(x - 22 - (40 - y) * .5) < 2.5) return [C.ruby, 4, .8];   // 盔缨
    if (y > 50 && y < 100 && Math.abs(x - 22) < 8 - (y > 84 ? (y - 84) * .1 : 0)) {
      const sh = S.ogive(20, 60, 7, 16, 9)(x, 122 - y);                                  // 倒过来的尖拱当盾
      if (sh < 0) return (Math.abs(x - 20) < 1.5 || Math.abs(y - 68) < 1.5) ? [C.amber, 6, 1] : [C.ruby, 5, .4];
      return [C.white, 7 + Math.floor(y / 12), 0];
    }
    if (y > 100) return [C.amber, 8, -1];
    return [C.emerald, 100 + diamond(x, y, 9), -.3];
  }, { seed: 59 });
  // 六：一层层的人字纹，中间一串红菱形
  const chevron = pane(LW, LH, lancetShape, (x, y, d) => {
    const e = edging(d, y, 4, C.white, C.amber, 5); if (e) return e;
    if (Math.abs(x - cx) + Math.abs(((y + 4) % 16) - 8) < 4.5) return [C.ruby, 500 + Math.floor((y + 4) / 16), .8];
    const b = Math.floor((y + Math.abs(x - cx) * 1.1) / 8);
    return [[C.amethyst, C.amber, C.cyan, C.rosy][b % 4], 50 + b * 2 + (x > cx ? 1 : 0), 0];
  }, { seed: 71 });
  return [saint, medals, tree, sun, knight, chevron];
}

// 本方小龛的窗（44×58 的尖拱）：蓝宝石底上一颗八角的白星，青色的光芒。没有一点红
export function ownGlass() {
  const w = 44, h = 58, cx = w / 2, cy = 33;
  return pane(w, h, S.ogive(cx, h, 21, h, 34), (x, y, d) => {
    const e = edging(d, y, 4, C.cyan, C.teal, 5); if (e) return e;
    const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx), star = 5 + 6 * Math.abs(Math.cos(a * 4)) ** 3;
    if (r < 3.4) return [C.white, 1, 1.8];
    if (r < star) return [C.white, 2 + Math.floor((a + TAU) / TAU * 8), 1];
    if (r < 15.5) { const s = Math.floor((a + TAU) / TAU * 16); return [s & 1 ? C.cyan : C.sapphire, 20 + s, s & 1 ? .6 : 0]; }
    return [C.sapphire, 100 + diamond(x, y, 8), -.5];
  }, { seed: 83, cs: 4 });
}
// 对面小龛的窗（直径 54 的圆窗）：红宝石底上一个金十字剑，一圈红金相间的齿。没有一点蓝
export function foeGlass() {
  const N = 54, c = N / 2;
  return pane(N, N, S.disc(c, c, 26.5), (x, y) => {
    const dx = x - c, dy = y - c, r = Math.hypot(dx, dy), a = (Math.atan2(dy, dx) + TAU) % TAU;
    if (r > 21.5) { const s = Math.floor(a / TAU * 20); return [s & 1 ? C.amber : C.ruby, 300 + s, s & 1 ? .8 : -.3]; }
    if ((Math.abs(dx) < 2.3 && dy > -17 && dy < 18) || (Math.abs(dy + 6) < 2.3 && Math.abs(dx) < 10)) return [C.amber, 1, 1.5];   // 十字剑
    if (Math.hypot(dx, dy + 6) < 4.6) return [C.white, 2, .6];
    if (r < 13) return [C.rosy, 10 + Math.floor(a / TAU * 8), .1];
    const s = Math.floor(a / TAU * 12);
    return [s & 1 ? C.ruby : C.crimson, 50 + s, s & 1 ? .4 : -.4];
  }, { seed: 97, cs: 4 });
}
