// 《丰收麦场》能平铺的材料贴图和几张大图（盘面、地面、天空、远山、谷仓里的灯火）。每个函数返回一张 canvas，种子相同画出来就相同。
// 全部逐像素算（画法在 paint.js），贴到立体的形体上时按每米 48 像素铺。
import { C, Sheet, rnd2, vn, cloud, cells, clamp, seq } from './paint.js';
const S = (w, h) => new Sheet(w, h), INK = C.night;

// —— 石 ——
// 乱石墙：一颗颗圆头的毛石干垒，石缝最暗，每颗上亮下暗，缝里长一点苔（场地的台帮、井圈、磨坊的墙脚）
export function fieldstone({ w = 64, h = 48, gw = 16, gh = 12, seed = 3, band = C.stone, alt = C.warmStone, moss = .1, lv = 2.7 } = {}) {
  return S(w, h).each((x, y) => {
    const c = cells(x, y, gw, gh, w / gw, h / gh, seed), gap = c[1], id = c[2], ox = c[3], oy = c[4];
    if (gap < .1) return [INK, .7 + rnd2(x, y, seed) * .8];
    const n = cloud(x / 8, y / 8, seed + 4, 3, w / 8, h / 8);
    if (moss && n > 1 - moss * 2.6 && oy < 0) return [C.moss, 1.4 + n * 2];
    return [rnd2(id, 5, seed) < .34 ? alt : band, lv + (rnd2(id, 9, seed) - .5) * 1.5 - ox * .9 - oy * 1.9 + (n - .5) * 1.1 - (gap < .2 ? .8 : 0)];
  }).canvas();
}
// 条石：错缝砌的方石块（磨坊的下半截）
export function ashlar({ w = 48, h = 24, bw = 24, bh = 12, seed = 5, band = C.stone, lv = 2.8 } = {}) {
  return S(w, h).each((x, y) => {
    const row = Math.floor(y / bh), sx = (x + (row & 1) * (bw >> 1)) % w, bx = Math.floor(sx / bw), lx = sx % bw, ly = y % bh;
    if (lx === 0 || ly === bh - 1) return [INK, 1];
    let v = lv + (rnd2(bx, row, seed) - .5) * 1.5 + (cloud(x / 6, y / 6, seed, 2, w / 6, h / 6) - .5) * 1.3;
    if (ly === 0) v += 1.1; if (lx === 1) v += .5; if (lx === bw - 1) v -= .7; if (ly === bh - 2) v -= .6;
    return rnd2(bx, row, seed + 3) < .07 ? [C.moss, v - 1.1] : [band, v];                 // 偶尔一块长了青苔（压暗，不然像贴了绿瓷砖）
  }).canvas();
}
// 铺地的大石板（场地台面露在格子外面的那一圈、城堡的台面）：每块形状不一，缝里塞着麦秆
export function pave({ n = 96, seed = 14, band = C.warmStone, lv = 2.2 } = {}) {
  return S(n, n).each((x, y) => {
    const c = cells(x, y, 24, 24, n / 24, n / 24, seed), gap = c[1], id = c[2], ox = c[3], oy = c[4];
    if (gap < .07) return rnd2(x >> 1, y, seed) < .22 ? [C.straw, 2.4 + rnd2(x, y, seed + 1) * 1.4] : [INK, .8];
    return [rnd2(id, 2, seed) < .3 ? C.flag : band, lv + (rnd2(id, 1, seed) - .5) * 1.3 - ox * .5 - oy * 1.1 + (cloud(x / 7, y / 7, seed, 3, 0, 0) - .5) * 1.5 - (gap < .14 ? .7 : 0)];
  }).canvas();
}
// 整张盘面：ROWS × COLS 格，每格 tw × th 像素。打麦场的旧石板——一格里两三块不规则的石板，深色、素；
// 最外一圈像素是墨色勾缝（格子的四个侧面取的就是左上角这颗）。本方出兵列偏青、留着磨掉一半的青漆记号，对面出兵列偏红
export function board({ rows, lanes, tw, th, seed = 11 }) {
  const s = S(rows * tw, lanes * th);
  s.each((x, y) => {
    const r = Math.floor(x / tw), c = Math.floor(y / th), lx = x - r * tw, ly = y - c * th, e = Math.min(lx, ly, tw - 1 - lx, th - 1 - ly);
    if (e === 0) return [INK, .5];
    const band = r === 0 ? C.flagOwn : r === rows - 1 ? C.flagFoe : C.flag, k = cells(lx, ly, tw / 2, th / 2, 2, 2, seed + r * 7 + c * 13), gap = k[1], id = k[2], ox = k[3], oy = k[4];
    if (e > 1 && gap < .055) return [band, .8];                                                    // 石板之间的裂缝
    let v = 2.75 + (rnd2(id, r * 5 + c, seed) - .5) * 1.0 + (cloud(x / 9, y / 9, seed, 3) - .5) * 1.5 - ox * .35 - oy * .7;
    if (e === 1) v += (ly === 1 || lx === 1) ? .9 : -.8;                                           // 格子的倒角：上、左亮，下、右暗
    if (rnd2(x, y, seed + 2) < .03) v -= .9;                                                       // 麻点
    return [band, v];
  });
  // 队伍色的漆：出兵列靠外的一道边线 + 每格一个朝里指的箭头，都磨掉了一半
  for (const [r, band, dir] of [[0, C.teal, 1], [rows - 1, C.red, -1]]) for (let c = 0; c < lanes; c++) {
    const x0 = r * tw, y0 = c * th, worn = (x, y) => cloud(x / 4, y / 4, seed + 60 + r, 2) < .56, edge = dir > 0 ? x0 + 4 : x0 + tw - 7;
    for (let y = 4; y < th - 4; y++) for (let k = 0; k < 3; k++) if (worn(edge + k, y0 + y)) s.px(edge + k, y0 + y, band, 2.1 + (k === 1 ? .5 : 0));
    const cx = x0 + tw / 2 + dir * 3, cy = y0 + th / 2;
    for (let i = -7; i <= 7; i++) for (let k = 0; k < 2; k++) { const x = Math.round(cx + dir * (5 - Math.abs(i)) * .8) + k * dir, y = Math.round(cy + i); if (worn(x, y)) s.px(x, y, band, 1.9 + k * .5); }
  }
  // 缝里的麦秆和落叶：只落在格子的边上，颜色压着
  const rr = seq(seed + 5);
  for (let i = 0; i < rows * lanes * 9; i++) {
    const r = Math.floor(rr() * rows), c = Math.floor(rr() * lanes), side = Math.floor(rr() * 4), a = rr(), b = 1 + Math.floor(rr() * 3), kind = rr();
    const x = r * tw + (side < 2 ? Math.round(a * (tw - 6)) + 2 : side === 2 ? b : tw - 1 - b), y = c * th + (side >= 2 ? Math.round(a * (th - 6)) + 2 : side === 0 ? b : th - 1 - b);
    if (kind < .6) { const len = 2 + Math.floor(rr() * 4), dx = side < 2 ? 1 : (rr() < .5 ? 1 : 0), dy = side < 2 ? (rr() < .3 ? 1 : 0) : 1; for (let k = 0; k < len; k++) s.px(x + dx * k, y + dy * k, C.straw, 1.9 + rr() * 1.2); }
    else { const bd = kind < .78 ? C.mapleR : kind < .92 ? C.mapleO : C.mapleY; s.px(x, y, bd, 2.4).px(x + 1, y, bd, 1.8).px(x, y + 1, bd, 1.6); }
  }
  return s.canvas();
}

// —— 木 ——
// 木板：板缝最暗，木纹顺着板长拉丝，板头钉两颗钉。vertical：板竖着排
export function planks({ w = 48, h = 48, pw = 8, seed = 2, band = C.wood, lv = 2.8, vertical = true, joint = false } = {}) {
  return S(w, h).each((x, y) => {
    const a = vertical ? x : y, b = vertical ? y : x, L = vertical ? h : w, k = Math.floor(a / pw), la = a % pw, j = (b + Math.floor(rnd2(k, 3, seed) * L)) % L;
    if (la === 0) return [INK, .9];
    if (joint && j === 0) return [INK, 1.3];
    if (la === (pw >> 1) && (j === 3 || j === L - 4)) return [C.iron, 1.6];
    let v = lv + (rnd2(k, 1, seed) - .5) * 1.3 + (vn(b / 13 + k * 5.3, a / 2.2, seed) - .5) * 1.6;
    if (la === 1) v += .8; if (la === pw - 1) v -= .8;
    return [band, v];
  }).canvas();
}
// 半木构的墙：米色抹灰，深色的梁柱和一道斜撑（磨坊的上半截）
export function timber({ seed = 7 } = {}) {
  const n = 48;
  return S(n, n).each((x, y) => {
    const beam = x < 4 || y < 4 || Math.abs(x - 26) < 2 || (x < 26 && Math.abs((x - 4) - (y - 4) * .5) < 1.7);
    if (beam) return [C.dark, 2.4 + (vn(x / 2, y / 9, seed) - .5) * 1.6 - (x === 0 || y === 0 || x === 3 || y === 3 ? .9 : 0)];
    return [C.plaster, 2.5 + (cloud(x / 7, y / 7, seed, 3) - .5) * 1.8 - (y < 7 ? .9 : 0) - (rnd2(x, y, seed) < .03 ? 1 : 0)];
  }).canvas();
}
// 刷了漆的木头（门框、漆柱、白边）：漆面有磨损
export function paint({ band = C.cream, seed = 4, lv = 3 } = {}) {
  return S(16, 16).each((x, y) => [cloud(x / 3, y / 5, seed, 2, 0, 0) > .7 ? C.old : band, lv + (vn(x / 2, y / 6, seed) - .5) * 1.2 - (x === 0 ? 1.2 : 0)]).canvas();
}
// 树皮：竖向的深沟亮脊
export function bark({ w = 32, h = 48, seed = 6, band = C.bark } = {}) {
  return S(w, h).each((x, y) => [band, .9 + cloud(x / 3.2, y / 12, seed, 3, 10, 4) * 3.6 - (rnd2(x, y >> 2, seed) < .08 ? 1 : 0)]).canvas();
}
// 原木的截面：一圈圈年轮
export function rings({ n = 16, seed = 2 } = {}) {
  return S(n, n).each((x, y) => { const d = Math.hypot(x - n / 2 + .5, y - n / 2 + .5); return d > n / 2 - 1 ? [C.bark, 1.4] : [C.wood, 3.6 + Math.sin(d * 2.1 + rnd2(1, 1, seed) * 3) * .9 - d * .08]; }).canvas();
}
// 木桶的侧面：一条条桶板 + 上下两道铁箍
export function cask({ band = C.wood } = {}) {
  return S(48, 30).each((x, y) => (y >= 4 && y < 7) || (y >= 22 && y < 25) ? [C.iron, y % 18 === 4 ? 3.6 : 2] : x % 6 === 0 ? [INK, 1] : [band, 2.7 + (vn(x / 1.6, y / 8, 7) - .5) * 1.5 + (rnd2(Math.floor(x / 6), 0, 9) - .5) - Math.abs(y - 15) * .05]).canvas();
}
// 板条箱的一面：四框 + 横条
export function crate({ seed = 4 } = {}) {
  const n = 24;
  return S(n, n).each((x, y) => { const e = Math.min(x, y, n - 1 - x, n - 1 - y); if (e === 0) return [INK, .9]; if (e < 4) return [C.wood, 3.5 + (e === 1 ? .8 : 0) - (e === 3 ? 1 : 0)]; return y % 6 === 0 ? [INK, .7] : [C.old, 2.3 + (vn(x / 7, y / 1.6, seed) - .5) * 1.6]; }).canvas();
}

// —— 屋顶 ——
// 筒瓦：一垄一垄的青瓦，每排下沿压一道影，零星长苔（磨坊）
export function pantile({ band = C.tealRoof, seed = 3, w = 48, h = 32 } = {}) {
  const ROLL = [1.3, .6, -.1, -.9, -1.6, -.7, .2, .9];
  return S(w, h).each((x, y) => {
    const row = Math.floor(y / 16), lx = (x + row * 4) % 8, ly = y % 16, k = Math.floor((x + row * 4) / 8) % (w / 8);
    if (ly === 15) return [INK, 1];
    const v = 2.9 + ROLL[lx] + (rnd2(k, row, seed) - .5) * 1.2 - (ly < 2 ? 1 : 0) + (ly === 14 ? .9 : 0);
    return [rnd2(k, row, seed + 5) < .09 ? C.moss : band, v];
  }).canvas();
}
// 木瓦：错缝的小木片，越往下沿越亮（谷仓）
export function shingle({ band = C.redRoof, seed = 9, w = 48, h = 24 } = {}) {
  return S(w, h).each((x, y) => {
    const row = Math.floor(y / 8), sx = (x + row * 5) % w, k = Math.floor(sx / 8), lx = sx % 8, ly = y % 8;
    if (ly === 7) return [INK, .9]; if (lx === 0) return [INK, 1.7];
    return [rnd2(k, row, seed + 2) < .14 ? C.old : band, 2.5 + (rnd2(k, row, seed) - .5) * 1.8 + ly / 7 * 1.4 - (ly === 0 ? .8 : 0)];
  }).canvas();
}

// —— 草、布、水、土 ——
// 干草捆的侧面：横着的草丝 + 两道捆绳
export function hay({ seed = 4, w = 48, h = 32, band = C.hay, twine = true } = {}) {
  return S(w, h).each((x, y) => {
    if (twine && (y === 9 || y === 22)) return [C.dark, 2 + (x % 3 === 0 ? 1.2 : 0)];
    const v = 2.7 + (vn(x / 9, y / 1.3, seed) - .5) * 2.6 + (rnd2(x, y, seed) < .07 ? 1.6 : 0) - (rnd2(x, y, seed + 1) < .06 ? 1.5 : 0);
    return [rnd2(x >> 2, y, seed) < .22 ? C.straw : band, v];
  }).canvas();
}
// 干草捆的两头：一个个草茬的断面
export function hayEnd({ seed = 6, n = 32 } = {}) {
  return S(n, n).each((x, y) => [rnd2(x, y, seed) < .3 ? C.straw : C.hay, 2.2 + rnd2(x >> 1, y >> 1, seed + 1) * 2.4 - (rnd2(x, y, seed + 2) < .14 ? 1.6 : 0)]).canvas();
}
// 条纹布篷：两色竖条，上亮下暗
export function stripes({ a = C.pumpkin, b = C.cream, seed = 2 } = {}) {
  return S(32, 32).each((x, y) => { const k = Math.floor(x / 8) % 2, lx = x % 8; return [k ? b : a, 3.3 - y / 32 * 1.2 + (lx === 0 ? -1 : lx === 1 ? .6 : 0) + (vn(x / 3, y / 9, seed) - .5) * .9]; }).canvas();
}
// 红白格子桌布
export function gingham({ band = C.red } = {}) {
  return S(16, 16).each((x, y) => { const a = (x >> 2) & 1, b = (y >> 2) & 1; return a && b ? [band, 2.6] : a || b ? [band, 4.3] : [C.white, 3.6]; }).canvas();
}
// 流水：顺着贴图的纵向流（场景里让贴图沿纵向滚），深浅两层波纹 + 零星亮点
export function water({ n = 64, seed = 8 } = {}) {
  return S(n, n).each((x, y) => {
    const a = cloud(x / 8, y / 16, seed, 3, n / 8, n / 16), g = cloud(x / 4, y / 8, seed + 9, 2, n / 4, n / 8);
    return g > .7 ? [C.water, 5.2] : [C.water, 1.6 + a * 2.8];
  }).canvas();
}
// 夯实的泥地（谷仓的台面）
export function packed({ n = 48, seed = 12 } = {}) {
  return S(n, n).each((x, y) => rnd2(x - (x % 3), y, seed) < .04 ? [C.straw, 3.2] : [C.dirt, 2 + (cloud(x / 8, y / 8, seed, 3, n / 8, n / 8) - .5) * 2.2 - (rnd2(x, y, seed + 1) < .04 ? 1 : 0)]).canvas();
}
// 铁皮、绳
export function iron() { return S(8, 8).each((x, y) => [C.iron, 2.3 + (y === 0 ? 1.6 : 0) - (y === 7 ? 1 : 0) + rnd2(x, y, 3) * .6]).canvas(); }
export function rope() { return S(8, 8).each((x, y) => [C.straw, (x + y) % 4 < 2 ? 3.4 : 1.7]).canvas(); }

// —— 地面：一整张图（每米 ppm 像素），哪里是什么地由 zone(x, z) 说了算，边界用噪声抖开 ——
//   0 场院的夯土（散着麦秆、石子、落叶） 1 麦茬地（一垄一垄） 2 草地（铺着落叶） 3 溪岸的湿泥 4 南瓜地 5 车辙土路
export function ground({ w, d, x0, z0, ppm, zone, seed = 21 }) {
  const W = Math.round(w * ppm), H = Math.round(d * ppm), LEAF = [C.mapleR, C.mapleO, C.mapleY];
  return S(W, H).each((px, py) => {
    const wx = x0 + (px + .5) / ppm + (cloud(px / 20, py / 20, seed, 3) - .5) * .9, wz = z0 + (py + .5) / ppm + (cloud(px / 20, py / 20, seed + 40, 3) - .5) * .9;
    const k = zone(wx, wz), n = cloud(px / 9, py / 9, seed + 3, 3), h = rnd2(px, py, seed), h2 = rnd2(px, py, seed + 1);
    if (h > .993 - (k === 2 ? cloud(px / 34, py / 34, seed + 9, 2) * .1 : 0)) return [LEAF[Math.floor(h2 * 3)], 2.5 + h2 * 1.4];      // 落叶：草地上成片，别处零星
    switch (k) {
      case 1: { const ry = py % 7; if (ry === 0 && h2 < .62) return [C.hay, 2.3 + h * 1.6]; if (ry === 1 && h2 < .2) return [C.wheat, 3.3]; return [C.soil, 1.5 + (n - .5) * 1.9]; }
      case 2: return h < .08 ? [C.moss, 2.6 + n * 1.6] : [n > .55 ? C.olive : C.leaf, 1.3 + n * 2.1];
      case 3: return h < .05 ? [C.stone, 2 + h2 * 2] : [C.soil, .9 + n * 1.4];
      case 4: return (px + py * 2) % 11 < 2 ? [C.soil, .9] : h < .05 ? [C.leaf, 2.4] : [C.soil, 1.9 + (n - .5) * 1.6];
      case 5: return [C.dirt, 2.8 + (n - .5) * 1.9 - (rnd2(px, py >> 3, seed + 5) < .1 ? .9 : 0)];
      default: if (h < .014) return [C.warmStone, 3 + h2]; if (rnd2(px - (px % 3), py, seed + 7) < .035) return [C.straw, 3.1 + h2]; return [C.dirt, 2 + (n - .5) * 2.3];
    }
  }).canvas();
}

// —— 远景 ——
// 天：从头顶的靛蓝，经紫、品红，到天边一线橙黄；有星，有被余晖从下面照亮的几缕云。横向可以平铺。hor：天际线在图的多高（0 顶 … 1 底）
const SUNSET = ['#06051c', '#0b0a2c', '#13103e', '#1e1450', '#30185c', '#4c1e62', '#74285e', '#a23a4e', '#d25a38', '#f08a30', '#ffbe52'].map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
export function sky({ w = 512, h = 256, hor = .7, seed = 31 } = {}) {
  return S(w, h).each((x, y) => {
    const v = y / h; if (v > hor) return [SUNSET, 5 - (v - hor) / (1 - hor) * 9];
    const t = v / hor, wisp = cloud(x / 32, y / 4, seed, 3, w / 32, 0), base = Math.pow(t, 1.9) * 9.4 + .4;
    if (t > .3 && wisp > .6) return [SUNSET, base + (wisp - .6) * 9 * (t > .62 ? 1 : -.4)];        // 云：低处的被照亮，高处的是暗影
    if (t < .8 && rnd2(x, y, seed) < .0045 * (1 - t)) return [C.husk, 4.5 + rnd2(x, y, seed + 1) * 2];   // 星
    return [SUNSET, base];
  }).canvas();
}
// 一道远山的剪影（透明底，横向平铺）：起伏的山脊、几棵树、亮着窗的农舍。far：更远的一层，只有轮廓
export function hills({ w = 384, h = 72, seed = 41, band = C.night, lv = 1.4, far = false } = {}) {
  const s = S(w, h), top = x => h * .5 - (cloud(x / 48, 0, seed, 3, w / 48, 0) - .5) * h * .7 - (far ? 6 : 0);
  s.each((x, y) => { const t = top(x); if (y < t) return null; return [band, lv + (y - t < 2 ? 1.6 : 0) - (y - t) / h * 1.2 + (cloud(x / 6, y / 3, seed + 3, 2, w / 6, 0) - .5) * (far ? .6 : 1.4)]; });
  const r = seq(seed);
  for (let i = 0; i < (far ? 10 : 16); i++) {                                                     // 树：圆头的小黑影
    const x = Math.floor(r() * w), t = Math.round(top(x)), R = 3 + Math.floor(r() * 4);
    for (let dy = -R * 2; dy <= 0; dy++) for (let dx = -R; dx <= R; dx++) if ((dx / R) ** 2 + ((dy + R) / R) ** 2 < 1) s.px((x + dx + w) % w, t + dy, band, lv - .5 + (dy < -R && dx < 1 ? 1.4 : 0));
  }
  if (!far) for (let i = 0; i < 6; i++) {                                                         // 农舍：人字顶 + 两三扇亮窗 + 烟囱
    const x = 20 + Math.floor(i * (w - 40) / 6 + r() * 20), t = Math.round(top(x)) - 9, ww = 16 + Math.floor(r() * 8);
    s.box(x, t + 5, ww, 10, band, lv + .9); for (let k = 0; k < 7; k++) s.box(x - 2 + k, t + 5 - k, ww + 4 - k * 2, 1, C.redRoof, 1.6 + (k === 6 ? 1.5 : 0)); s.box(x + ww - 5, t - 3, 2, 5, band, lv + 1.2);
    for (let k = 0; k < 2 + (ww > 20 ? 1 : 0); k++) s.box(x + 3 + k * 6, t + 8, 3, 3, C.glow, 5.4).px(x + 4 + k * 6, t + 9, C.glow, 6);
  }
  return s.canvas();
}
// 敞着门的谷仓里：一盏灯照着的草堆和梁（自发光的一块）
export function barnInside() {
  const w = 52, h = 56;
  return S(w, h).each((x, y) => {
    const far = Math.hypot((x - 26) / 26, (y - 16) / 34);                                                                          // 离那盏灯多远：越远越暗，四角落进暗红里
    if (y > 40 + Math.sin(x * .45) * 3 + (x > 30 ? -9 : 0)) return [C.hay, 3.6 - far * 1.6 + rnd2(x, y, 5) * 1.6 - (y % 8 === 0 || (x + (y >> 3) * 7) % 16 === 0 ? 1.5 : 0)];   // 码着的草捆
    if (x % 17 === 4 || y === 6 || y === 7) return [C.dark, 1.6];                                                                   // 梁柱
    if (x > 8 && x < 16 && y > 12 && (y % 6 === 0 || x === 9 || x === 15)) return [C.dark, 2.2];                                    // 靠墙的梯子
    if (Math.abs(x - 26) < 3 && y > 10 && y < 18) return [C.glow, 6];                                                               // 吊着的一盏灯
    if (Math.abs(x - 26) < 1 && y <= 10) return [C.dark, 1];
    return far < .5 ? [C.glow, clamp(5.4 - far * 5, 2.4, 6)] : [C.fire, clamp(4.6 - far * 3.2, .6, 4)];
  }).canvas();
}
