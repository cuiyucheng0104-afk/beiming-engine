// 《沉水擂台》B 版 · 场景贴图：贴在模型上的像素图，逐像素算出来（每个像素先定高度和颜色组，再由 ink.js 的浮雕着色定明暗）。
// 每个函数返回一张 canvas；标了「平铺」的四边能无缝接上。密度一律每米 48 像素。
import { INK, relief, h2, vn, fbm, dome, seg } from './ink.js';
import { ROWS, LANES, TILE, FRONT } from './plan.js';

// 乱石砌：每行石块宽度不一、错缝，缝里是深色，顶沿长苔。平铺
export function masonry({ w = 96, h = 96, rowH = 16, ink = INK.rust, alt = INK.sand, moss = .35, seed = 1 } = {}) {
  return relief(w, h, (x, y) => {
    const r = Math.floor(y / rowH), ly = y % rowH, off = Math.floor(h2(r, 0, seed) * w);
    let u = (x + off) % w, a = 0, i = 0, bw = 0;
    for (;; i++) { bw = 14 + Math.floor(h2(r, i, seed + 3) * 16); if (a + bw > w - 10) { bw = w - a; } if (u < a + bw) break; a += bw; }
    const lx = u - a, gap = Math.min(lx, bw - 1 - lx, ly, rowH - 1 - ly);
    if (gap < 1) return { ink: INK.night, lv: h2(x, y, seed) > .8 ? 1 : 0 };
    const id = r * 37 + i, tone = h2(id, 1, seed), n = fbm(x / 7, y / 7, seed);
    const mossy = moss > 0 && ly < 2 + h2(id, 2, seed) * 5 * moss * 2 && vn(x / 3, r * 9, seed + 5) > .62 - moss * .5;
    const chip = h2(id, 3, seed) > .7 && Math.hypot(lx - bw * h2(id, 4, seed), ly - rowH * .6) < 3 ? -1.5 : 0;
    return { z: Math.min(gap, 2) * .9 + n * 1.6 + chip, ink: mossy ? INK.moss : tone > .72 ? alt : ink, add: (tone - .5) * .9 + (mossy ? .5 : 0) };
  }, { wrap: true });
}

// 浮雕饰带：一排回旋水纹，夹在两道线脚中间。横向平铺
export function frieze({ w = 96, h = 22, ink = INK.sand, seed = 2 } = {}) {
  return relief(w, h, (x, y) => {
    if (y < 3 || y >= h - 3) return { z: 2.2 - Math.abs((y < 3 ? y : h - 1 - y) - 1), ink, add: .4 };
    const u = x % 24, v = y - 3, cx = 12, cy = 8, d = Math.hypot(u - cx, (v - cy) * 1.25), an = Math.atan2(v - cy, u - cx);
    const spiral = Math.abs(((d - an * 1.15 + 20) % 5) - 2.5) < 1.1 && d < 9.5;
    const eye = d < 2;
    return { z: spiral || eye ? 2.4 : 0, ink: spiral || eye ? ink : INK.rust, add: spiral ? .3 : -.9 + fbm(x / 5, y / 5, seed) * .6 };
  }, { wrap: true });
}

// 兽面：对称的石雕（眉、眼窝、鼻、带牙的嘴），头顶和脸颊长苔。眼睛留成深洞，发光的眼珠是场景里另外放的
export function beast({ w = 64, h = 72, ink = INK.sand, seed = 3 } = {}) {
  return relief(w, h, (x, y) => {
    const sx = Math.abs(x - (w - 1) / 2), n = fbm(x / 6, y / 6, seed);
    let z = 3.2 * Math.max(0, dome(sx, y, 0, 36, 31, 37)) + n * 1.2, k = ink, add = 0;
    const brow = dome(sx, y, 13, 22, 14, 6); if (brow > 0) z += 3.5 * brow;
    const eye = dome(sx, y, 13, 31, 7, 5); if (eye > 0) { z -= 4.5 * eye; add -= 1.2; }
    const nose = dome(sx, y, 0, 38, 6, 11); if (nose > 0) z += 3.2 * nose;
    const cheek = dome(sx, y, 21, 44, 9, 8); if (cheek > 0) z += 1.8 * cheek;
    if (y >= 52 && y < 64 && sx < 20) { const tooth = ((sx + 2) % 8) < 5 && y < 60; z += tooth ? 1.5 : -3.2; add += tooth ? .8 : -1.6; if (tooth) k = INK.bone; }
    if (y > 63) { z -= (y - 63) * .5; }
    const horn = seg(sx, y, 22, 14, 29, 2); if (horn < 3.2) { z += 3 - horn * .6; k = INK.bone; }
    if (y < 12 + vn(x / 4, 1, seed) * 9 || (vn(x / 5, y / 5, seed + 9) > .68 && y < 46)) { k = INK.moss; add += .5; z += .8; }
    if (Math.abs(sx - 30) < 1.3 || y < 1 || y > h - 2) { add -= 1.2; }
    return { z, ink: k, add };
  });
}

// 木栈板：一条条横板，板头错开，有钉子和磨白的边。平铺
export function planks({ w = 96, h = 48, bh = 12, ink = INK.plank, seed = 4 } = {}) {
  return relief(w, h, (x, y) => {
    const r = Math.floor(y / bh), ly = y % bh, cut = Math.floor(h2(r, 1, seed) * w), u = (x + cut) % w, joint = u % 48;
    if (ly === 0 || joint === 0) return { ink: INK.night, lv: 0 };
    const grain = vn(x / 9, y * 1.7 + r * 13, seed), nail = (joint === 3 || joint === 44) && (ly === 3 || ly === bh - 4);
    if (nail) return { ink: INK.night, lv: 1.4 };
    return { z: (ly < 2 ? ly : ly > bh - 3 ? bh - 1 - ly : 2) * .7 + grain * 1.3, ink: h2(r, Math.floor(u / 48), seed) > .7 ? INK.wood : ink, add: (h2(r, Math.floor(u / 48), seed + 1) - .5) * .8 + (vn(x / 3, r * 7, seed + 2) > .78 ? .7 : 0) };
  }, { wrap: true });
}

// 水面：暗紫色的静水，一道道细碎的亮纹（偏青）。平铺。这张只管花纹，反光交给材质的光滑度
export function water({ s = 256, seed = 5 } = {}) {
  return relief(s, s, (x, y) => {
    const u = x / s * 8, v = y / s * 8;
    const warp = vn(u * 1.5, v * 1.5, seed, 12, 12) * 2.2, band = Math.sin((v * 3.6 + warp + vn(u * .8, v * .8, seed + 1, 6, 6) * 5) * 2.1);
    const fine = vn(u * 6, v * 9, seed + 2, 48, 72), deep = vn(u * .5, v * .5, seed + 3, 4, 4);
    let lv = 1.1 + deep * 1.3 + (band > .82 ? 1.6 : band > .55 ? .5 : 0) + (fine > .82 ? 1.1 : 0);
    return { ink: INK.water, lv };
  }, { wrap: true });
}

// 草岸：苔和草的碎块，零星小花。平铺
export function turf({ s = 128, seed = 6 } = {}) {
  return relief(s, s, (x, y) => {
    const n = vn(x / 16, y / 16, seed, 8, 8), fine = vn(x / 3, y / 3, seed + 1, 43, 43), blade = h2(x, y >> 1, seed) > .72;
    const fl = h2(x >> 1, y >> 1, seed + 4);
    if (fl > .992) return { ink: fl > .996 ? INK.petal : INK.gold, lv: 4.6 };
    return { z: fine * 2.6 + (blade ? 1.2 : 0), ink: n > .58 ? INK.fern : n > .34 ? INK.moss : INK.leaf, add: (n - .5) * 1.4 + (blade ? .5 : -.1) };
  }, { wrap: true, k: .9, base: 2.1 });
}

// 岩壁：斜向的断层和裂缝，挂着苔。平铺
export function cliff({ w = 96, h = 96, seed = 7 } = {}) {
  return relief(w, h, (x, y) => {
    const a = vn(x / 20, y / 12, seed, 5, 8), cell = Math.floor((y + a * 22) / 13), ly = (y + a * 22) % 13;
    const crack = ly < 1.2 || (vn(x / 6, cell * 3.1, seed + 2, 16, 0) > .8 && ly < 6);
    if (crack) return { ink: INK.night, lv: .6 };
    const mossy = ly < 4 && vn(x / 5, cell * 5.3, seed + 3, 19, 0) > .5;
    return { z: ly * .35 + fbm(x / 6, y / 6, seed) * 2.2, ink: mossy ? INK.moss : h2(cell, 0, seed) > .6 ? INK.clay : INK.rust, add: (h2(cell, 1, seed) - .5) * 1 + (mossy ? .6 : 0) };
  }, { wrap: true });
}

// 树皮：竖向的沟。平铺
export function bark({ w = 48, h = 96, seed = 8 } = {}) {
  return relief(w, h, (x, y) => {
    const u = x + vn(x / 9, y / 22, seed, 5, 4) * 8, ridge = Math.abs(((u % 8) + 8) % 8 - 4);
    const knot = dome(x, y, 30, 40, 6, 9);
    return { z: ridge * .9 + (knot > 0 ? knot * 3 : 0) + vn(x / 2, y / 5, seed + 1, 24, 19) * 1.2, ink: vn(x / 7, y / 9, seed + 4, 7, 11) > .72 ? INK.moss : INK.bark, add: knot > 0 ? .4 : 0 };
  }, { wrap: true });
}

// 瓦：一排排鱼鳞瓦。平铺
export function scales({ s = 48, ink = INK.lacquer, seed = 9 } = {}) {
  return relief(s, s, (x, y) => {
    const r = Math.floor(y / 8), u = (x + (r % 2) * 6) % 12, v = y % 8, d = dome(u, v, 5.5, 0, 6.5, 8.5);
    if (d <= 0) return { ink: INK.night, lv: .8 };
    return { z: d * 3.4 + v * .2, ink: h2(Math.floor((x + (r % 2) * 6) / 12), r, seed) > .82 ? INK.moss : ink, add: (h2(Math.floor((x + (r % 2) * 6) / 12), r, seed + 1) - .5) * 1.1 };
  }, { wrap: true });
}

// 石柱：竖槽、两道箍、斑驳的苔。横向平铺
export function column({ w = 48, h = 96, seed = 10 } = {}) {
  return relief(w, h, (x, y) => {
    const band = (y > 8 && y < 15) || (y > h - 16 && y < h - 9), flute = Math.abs((x % 8) - 3.5);
    const mossy = vn(x / 6, y / 8, seed, 8, 12) > .66 || y > h - 8 - vn(x / 4, 2, seed, 12, 0) * 10;
    const crack = Math.abs(x - 20 - vn(1, y / 9, seed + 2) * 14) < .8 && y > 30 && y < 70;
    if (crack) return { ink: INK.night, lv: .4 };
    return { z: band ? 4 + (Math.floor(x / 4) % 2) : flute * .9 + fbm(x / 5, y / 5, seed) * 1.3, ink: mossy ? INK.moss : band ? INK.rust : INK.sand, add: mossy ? .4 : band ? .2 : 0 };
  }, { wrap: true });
}

// 冰：斜切的晶面。平铺
export function ice({ s = 48, seed = 11 } = {}) {
  return relief(s, s, (x, y) => {
    const a = Math.floor((x + y * .6) / 9), b = Math.floor((x * .5 - y + 96) / 11), t = h2(a, b, seed);
    const edge = ((x + y * .6) % 9) < 1 || ((x * .5 - y + 96) % 11) < 1;
    return { ink: INK.ice, lv: edge ? 4.8 : 1.6 + t * 2.6 };
  }, { wrap: true });
}

// 漆木：红漆上几道金线和磨损。平铺
export function lacquer({ s = 32, seed = 12 } = {}) {
  return relief(s, s, (x, y) => {
    if (y % 16 === 7 || y % 16 === 8) return { ink: INK.gold, lv: 3.4 + (h2(x >> 1, y, seed) > .5 ? 1 : 0) };
    const worn = vn(x / 4, y / 7, seed, 8, 5) > .78;
    return { z: vn(x / 2, y / 9, seed + 1, 16, 4) * 1.5, ink: worn ? INK.wood : INK.lacquer, add: worn ? -.3 : .2 };
  }, { wrap: true });
}

// 盘面：5 × 4 格石板，一格 60 × 52 像素，外面一圈雕花石沿。
// 石板偏暗偏冷（棋子是亮的、暖的，要压得住）；本方出生列偏青、敌方出生列偏红，中间一道嵌金的前线
export function board({ seed = 13 } = {}) {
  const { w: tw, h: th, rim } = TILE, W = ROWS * tw + rim * 2, H = LANES * th + rim * 2;
  return relief(W, H, (x, y) => {
    const u = x - rim, v = y - rim;
    if (u < 0 || v < 0 || u >= ROWS * tw || v >= LANES * th) {              // 石沿
      const e = Math.min(x, y, W - 1 - x, H - 1 - y), along = (y < rim || y >= H - rim) ? x : y;
      if (e < 2) return { z: e * 1.5, ink: INK.sand, add: .3 };
      if (e > rim - 3) return { z: (rim - 1 - e) * 1.2, ink: INK.rust, add: -.6 };
      const groove = e === 6 || e === rim - 6, stud = e > 7 && e < rim - 7 && along % 16 > 5 && along % 16 < 11;
      const mossy = vn(x / 7, y / 7, seed) > .7;
      return { z: groove ? -1 : stud ? 3 : 1.5, ink: mossy ? INK.moss : stud ? INK.sand : INK.mauve, add: groove ? -1 : stud ? .4 : -.2 };
    }
    const r = Math.floor(u / tw), l = Math.floor(v / th), lx = u % tw, ly = v % th, e = Math.min(lx, ly, tw - 1 - lx, th - 1 - ly);
    if (r === FRONT && lx >= tw - 2 || r === FRONT + 1 && lx < 2) return { ink: INK.gold, lv: 3.6 + (h2(x, y >> 2, seed) > .4 ? 1 : 0) };
    if (e < 1) return { ink: INK.night, lv: .3 };
    const ink = r === 0 ? INK.slateOwn : r === ROWS - 1 ? INK.slateFoe : INK.slate, id = r * 7 + l;
    const n = fbm(x / 9, y / 9, seed), speck = h2(x, y, seed + 2);
    const crack = h2(id, 5, seed) > .45 && seg(lx, ly, tw * h2(id, 6, seed), 0, tw * h2(id, 7, seed), th * (.4 + .5 * h2(id, 8, seed))) < .7;
    if (crack) return { ink: INK.night, lv: .8 };
    const inner = e === 6 || (e > 6 && e < 9 && (lx < 15 || lx > tw - 16) && (ly < 15 || ly > th - 16));
    const mossy = e < 5 && vn(x / 4, y / 4, seed + 4) > .7;
    return { z: Math.min(e, 3) * .8 + n * 1.4 - (inner ? 1.4 : 0), ink: mossy ? INK.moss : ink, add: ((r + l) % 2 ? -.45 : -.05) + (speck > .93 ? .7 : speck < .05 ? -.6 : 0) + (inner ? -.5 : 0) + (mossy ? .9 : 0) };
  }, { base: 2.05 });
}

// 小件
export const paper = () => relief(16, 16, (x, y) => ({ ink: y < 2 || y > 13 ? INK.lacquer : INK.paper, lv: y < 2 || y > 13 ? 3 : (x % 4 === 0 ? 3.2 : 4.6) }), { wrap: true });
export const bone = () => relief(16, 32, (x, y) => ({ z: (y % 16 < 2 ? 2 : 0) + vn(x / 3, y / 4, 14, 5, 8) * 1.4, ink: INK.bone, add: y % 16 < 2 ? .5 : 0 }), { wrap: true });
export const hull = () => relief(64, 24, (x, y) => (y % 8 === 0 ? { ink: INK.night, lv: .4 } : { z: vn(x / 8, y, 15, 8, 0) * 1.6 + (y % 8) * .25, ink: y < 8 ? INK.lacquer : INK.wood, add: y < 8 ? .2 : -.2 }), { wrap: true });
