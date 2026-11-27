// 《齿轮熔炉》· 铺面贴图：能平铺的大面（地面、铆接铁板、耐火砖、铜皮、管壁、传送带、铁水……）、盘面和台沿、齿轮。
// 全部用 metal.js 的板金法逐像素算出来，每米 48 像素。返回的都是 canvas。
import { Sheet, PPM, jit, cloud, turb } from './metal.js';

// —— 车间地面：一行行大小不一的石板，夹着几块铆接的铁盖板；缝里是煤灰，上面有油渍 ——
export function floor(seed = 3) {
  const s = new Sheet(192, 192, true), rows = [[48, 64, 32, 48], [32, 48, 48, 64], [64, 32, 64, 32], [48, 48, 32, 64], [32, 64, 48, 48], [64, 48, 48, 32]];
  rows.forEach((ws, j) => {
    let x = (j * 20) % 192;
    ws.forEach((w, i) => {
      const k = jit(i, j, seed), iron = k > .78;
      if (iron) s.panel(x + 1, j * 32 + 1, w - 2, 30, 'iron', .3 + k * .08, { edge: .12, rivet: 12 });
      else { s.panel(x + 1, j * 32 + 1, w - 2, 30, 'stone', .3 + k * .14, { edge: .09 }); if (k < .3) { const cx = x + 6 + k * 60, cy = j * 32 + 4; s.line(cx, cy, cx + 5, cy + 9, 'stone', .1).line(cx + 5, cy + 9, cx + 3, cy + 20, 'stone', .1); } }
      for (let a = 0; a < 32; a++) { s.dot(x, j * 32 + a, 'coal', .08); } for (let a = 0; a < w; a++) s.dot(x + a, j * 32, 'coal', .08);
      x += w;
    });
  });
  return s.grime(.13, 24, seed).wear('coal', .66, 32, seed + 3, -.25).wear('rust', .74, 16, seed + 8, -.12).scuff(60, 6, .06, seed).bake();
}

// —— 铆接铁板：一块块压边的板，四边打铆钉；带锈的流痕 ——
export function plate({ ink = 'iron', seed = 1, w = 96, h = 48, pw = 48, ph = 24, v = .36, rust = .7, rivet = 12 } = {}) {
  const s = new Sheet(w, h, true);
  for (let y = 0, j = 0; y < h; y += ph, j++) for (let x = (j & 1) * (pw >> 1), i = 0; x < w + (j & 1) * (pw >> 1); x += pw, i++) s.panel(x, y, pw, ph, ink, v + (jit(i, j, seed) - .5) * .12, { edge: .14, rivet });
  return s.grime(.1, 16, seed).wear('rust', rust, 9, seed + 2, -.05, 3).scuff(26, 5, .07, seed).bake();
}

// —— 警示斜纹：黄黑相间，上沿一道亮边 ——
export function hazard({ w = 48, h = 12, a = 'hazard', b = 'coal', seed = 2, va = .55 } = {}) {
  const s = new Sheet(w, h, true);
  s.each((x, y) => (((x + y) % 16) + 16) % 16 < 8 ? [a, va - y / h * .12] : [b, .2]);
  for (let x = 0; x < w; x++) { s.add(x, 0, .16).dot(x, h - 1, 'coal', .06); }
  return s.grime(.12, 8, seed).scuff(14, 4, -.12, seed).bake();
}

// —— 耐火砖：错缝砌，砖色不匀，间或一块熏黑的；上面一层煤灰 ——
export function brick({ seed = 4, w = 96, h = 48, ink = 'brick', v = .42 } = {}) {
  const s = new Sheet(w, h, true);
  for (let y = 0, j = 0; y < h; y += 8, j++) for (let x = (j & 1) * 8, i = 0; x < w + 8; x += 16, i++) {
    const k = jit(i, j, seed);
    s.panel(x, y, 15, 7, k > .86 ? 'soot' : k < .1 ? 'rust' : ink, v + (k - .5) * .2, { edge: .1 });
    for (let a = 0; a < 16; a++) s.dot(x + a, y + 7, 'coal', .1); for (let a = 0; a < 8; a++) s.dot(x + 15, y + a, 'coal', .1);
  }
  return s.grime(.16, 20, seed).bake();
}

// —— 铜皮：竖缝、一排铆钉、往下淌的铜绿 ——
export function copper({ seed = 5, w = 48, h = 48, ink = 'copper', green = .62 } = {}) {
  const s = new Sheet(w, h, true);
  s.each((x, y) => [ink, .46 + .1 * cloud(x / 12, y / 6, seed, 4, 8) + (x % 24 === 1 ? .14 : x % 24 === 0 ? -.2 : 0)]);
  for (let y = 4; y < h; y += 8) for (let x = 4; x < w; x += 24) s.rivet(x, y, .3);
  return s.wear('patina', green, 8, seed + 1, -.06, 4).grime(.08, 12, seed).scuff(12, 4, .1, seed).bake();
}

// —— 箍：黄铜（或铁）的一圈箍带，上亮下暗，一排铆钉 ——
export function hoop({ ink = 'brass', seed = 6, v = .52 } = {}) {
  const s = new Sheet(24, 8, true);
  s.each((x, y) => [ink, v + [.24, .14, .05, 0, -.04, -.1, -.2, -.3][y]]);
  for (let x = 2; x < 24; x += 8) s.rivet(x, 3, .28);
  return s.scuff(4, 3, .1, seed).bake();
}

// —— 管壁：横向是绕管一圈，纵向是沿着管子；每隔一段一道焊缝，带锈 ——
export function pipe({ ink = 'iron', seed = 7, v = .4, wear = 'rust', thr = .66 } = {}) {
  const s = new Sheet(24, 48, true);
  s.each((x, y) => [ink, v + .08 * cloud(x / 6, y / 12, seed, 4, 4) + (y % 24 === 0 ? -.18 : y % 24 === 1 ? .14 : 0)]);
  for (let x = 3; x < 24; x += 6) { s.rivet(x, 4, .22); s.rivet(x + 3, 28, .22); }
  return s.wear(wear, thr, 8, seed + 4, -.04, 2).bake();
}

// —— 线圈：一圈圈紫铜线 ——
export function coil() { return new Sheet(8, 6, true).each((x, y) => ['copper', [.78, .52, .26][y % 3] + (jit(x, y, 3) - .5) * .08]).bake(); }

// —— 传送带的带面：黑胶皮，每隔一段一道防滑条，两边是铁边 ——
export function belt() {
  const s = new Sheet(24, 24, true);
  s.each((x, y) => x < 2 || x > 21 ? ['iron', x === 0 || x === 22 ? .5 : .3] : ['coal', .3 + (y % 8 === 0 ? .26 : y % 8 === 1 ? -.1 : 0) + .05 * jit(x, y, 9)]);
  for (let y = 3; y < 24; y += 8) { s.rivet(0, y, .2); s.rivet(22, y, .2); }
  return s.bake();
}

// —— 铁水：顺着槽流的亮纹（纵向拉长的噪声），间或一片发暗的渣壳。发光材质用 ——
export function molten(seed = 11) {
  const s = new Sheet(24, 96, true);
  s.each((x, y) => {
    const n = turb(x / 8, y / 32, seed, 3, 3), m = cloud(x / 4 + n * 2, y / 12, seed + 3, 6, 8), edge = Math.min(x, 23 - x) < 2 ? -.2 : 0;
    if (n < .3 && m < .5) return ['rust', .3 + m * .3];
    return ['fire', .5 + .5 * m + (n - .5) * .3 + edge];
  });
  return s.bake();
}

// —— 走道的铁格栅：一道道扁钢，底下是黑的 ——
export function grating() {
  const s = new Sheet(24, 24, true);
  s.each((x, y) => x % 6 < 2 ? ['iron', x % 6 === 0 ? .55 : .3] : y % 12 < 2 ? ['iron', y % 12 === 0 ? .48 : .26] : ['coal', .04]);
  return s.bake();
}

// —— 花纹钢板：斜着的小凸条，一块块铆在一起 ——
export function tread({ ink = 'iron', v = .34, seed = 12 } = {}) {
  const s = new Sheet(48, 48, true);
  s.each((x, y) => [ink, v + ((x + y * 3) % 8 === 0 || (x + y * 3) % 8 === 1 ? (((x >> 2) + (y >> 2)) & 1 ? .16 : -.1) : 0)]);
  for (const [x, y] of [[0, 0], [24, 24]]) { for (let a = 0; a < 24; a++) { s.dot(x + a, y, 'coal', .1).dot(x, y + a, 'coal', .1); } s.rivet(x + 3, y + 3).rivet(x + 19, y + 3).rivet(x + 3, y + 19).rivet(x + 19, y + 19); }
  return s.grime(.1, 12, seed).wear('rust', .72, 8, seed + 1, -.06).bake();
}

// —— 木板：横着的几条，带木纹和钉子 ——
export function wood(seed = 13) {
  const s = new Sheet(48, 48, true);
  s.each((x, y) => { const p = Math.floor(y / 12), yy = y % 12; return yy === 11 ? ['coal', .12] : ['wood', .42 + (jit(p, 0, seed) - .5) * .16 + .08 * Math.sin((x + p * 17) * .35 + cloud(x / 9, y / 3, seed, 5, 16) * 5) + (yy === 0 ? .14 : 0)]; });
  for (let p = 0; p < 4; p++) { const b = Math.floor(jit(p, 1, seed) * 48); for (let yy = 0; yy < 11; yy++) s.dot(b, p * 12 + yy, 'coal', .14); s.rivet(b + 3, p * 12 + 4, .2).rivet(b - 4, p * 12 + 4, .2); }
  return s.grime(.08, 10, seed).bake();
}

// —— 后墙：一整面，6 米高、4 米一段。下面一米是铆接的铁护板（顶上一道警示斜纹），往上是耐火砖，每两米一根带铆钉的工字钢立柱，中腰一道铁梁 ——
export function wall(seed = 21) {
  const W = 192, H = 288, s = new Sheet(W, H, true);
  for (let y = 0, j = 0; y < H; y += 8, j++) for (let x = (j & 1) * 8, i = 0; x < W + 8; x += 16, i++) {
    const k = jit(i, j, seed), dark = y < 60 ? .12 : 0;                       // 最上面一截被烟熏得更黑
    s.panel(x, y, 15, 7, k > .82 ? 'soot' : 'brick', .34 + (k - .5) * .16 - dark, { edge: .08 });
    for (let a = 0; a < 16; a++) s.dot(x + a, y + 7, 'coal', .08);
  }
  for (let x = 0; x < W; x += 48) s.panel(x, H - 50, 48, 50, 'iron', .3 + jit(x, 5, seed) * .06, { edge: .12, rivet: 11 });   // 铁护板
  s.rect(0, H - 60, W, 10, 'hazard', (i, j) => ((i + j) % 16 < 8 ? .46 : -1));
  for (let x = 0; x < W; x++) for (let j = 0; j < 10; j++) if ((x + j) % 16 >= 8) s.dot(x, H - 60 + j, 'coal', .16);
  s.panel(0, 130, W, 14, 'iron', .32, { edge: .14, rivet: 8 });                // 中腰的铁梁
  for (const x of [0, 96]) { s.panel(x, 0, 16, H, 'iron', .3, { edge: .16, rivet: 10 }); for (let y = 0; y < H; y++) { s.add(x + 7, y, -.1).add(x + 8, y, .06); } }   // 立柱
  return s.grime(.14, 32, seed).wear('coal', .7, 40, seed + 7, -.3, 2).wear('rust', .76, 12, seed + 2, -.1, 3).bake();
}

// —— 玻璃管里的青光：中间亮、两边暗，往上冒的小泡。发光材质用 ——
export function glassTube({ ink = 'teal', seed = 14 } = {}) {
  const s = new Sheet(12, 48, true);
  s.each((x, y) => [ink, .52 + .34 * Math.sin((x + .5) / 12 * Math.PI) + (jit(x >> 1, y >> 1, seed) > .9 ? .3 : 0) + .06 * Math.sin(y / 48 * 6.283 * 3)]);
  return s.bake();
}

// —— 煤堆的面 ——
export function coal(seed = 15) {
  const s = new Sheet(48, 48, true);
  s.each((x, y) => { let best = 9, bi = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const gx = Math.floor(x / 6) + i, gy = Math.floor(y / 6) + j, wx = ((gx % 8) + 8) % 8, wy = ((gy % 8) + 8) % 8, d = Math.hypot(x - (gx + jit(wx, wy, seed)) * 6, y - (gy + jit(wy, wx, seed + 1)) * 6); if (d < best) { best = d; bi = wx * 8 + wy; } }
    return ['coal', .2 + jit(bi, 2, seed) * .3 - best * .05 + (jit(x, y, seed) > .97 ? .4 : 0)]; });
  return s.bake();
}

// —— 冷却水：暗的水面，几道亮的波纹 ——
export function water(seed = 16) {
  return new Sheet(48, 48, true).each((x, y) => { const n = cloud(x / 12, y / 5, seed, 4, 9.6) + .3 * Math.sin((y + cloud(x / 8, y / 8, seed + 2, 6, 6) * 8) * .8); return ['water', .3 + (n > .95 ? .45 : n > .8 ? .18 : 0) + .1 * n]; }).bake();
}

// —— 桁架：上下两根弦杆，中间一个个交叉的斜撑；镂空 ——
export function truss() {
  const s = new Sheet(48, 30);
  s.panel(0, 0, 48, 5, 'iron', .32, { edge: .16 }).panel(0, 25, 48, 5, 'iron', .3, { edge: .16 });
  for (const [a, b] of [[0, 24], [24, 48], [24, 0], [48, 24]]) for (let t = 0; t <= 20; t++) { const x = a + (b - a) * t / 20, y = 5 + t; s.dot(x, y, 'iron', .36).dot(x + 1, y, 'iron', .22); }
  s.panel(22, 3, 5, 24, 'iron', .28, { edge: .12 });
  for (let x = 3; x < 48; x += 8) s.rivet(x, 1, .24).rivet(x, 26, .24);
  return s.bake();
}

// —— 栏杆：立柱、扶手、一道腰杆、脚边的踢脚板；镂空 ——
export function railing() {
  const s = new Sheet(48, 46);
  s.bar(0, 2, 48, 2, 2.2, 'iron', .46).bar(0, 20, 48, 20, 1.4, 'iron', .34);
  for (const x of [5, 29]) { s.bar(x, 0, x, 46, 2, 'iron', .38); s.disc(x, 2, 3, 'brass', .5); }
  s.panel(0, 38, 48, 8, 'hazard', .4, { edge: .14 }); s.each((x, y) => y >= 39 && y < 45 && (x + y) % 12 < 6 ? ['coal', .18] : null);
  return s.bake();
}

// —— 齿轮：n 个齿，节圆半径每齿 0.022 米（齿数和半径成正比，所以大小齿轮才咬得上）。齿朝 0 度（贴图的右边）起一个 ——
export const MODULE = .022;
export function gear(n, { ink = 'brass', seed = 0, spokes = n < 14 ? 0 : n < 30 ? 4 : n < 50 ? 5 : 6, hub = 'iron' } = {}) {
  const rp = n * MODULE * PPM, th = 2.4, R = Math.ceil(rp + th) + 1, size = R * 2 + 1, s = new Sheet(size, size), TAU = Math.PI * 2;
  s.each((x, y) => {
    const dx = x - R, dy = y - R, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx), ph = ((a / TAU * n + .5) % 1 + 1) % 1, tooth = Math.abs(ph - .5) < .27;
    if (d > rp + (tooth ? th : -th * .6)) return null;
    const lit = (-.62 * dx - .78 * dy) / (d || 1), rim = Math.max(3.5, rp * .2), hubR = Math.max(2.5, rp * .26);
    if (d > rp - th * .6) return [ink, .52 + .2 * lit + (tooth ? .08 : -.14)];                                // 齿
    if (d > rp - rim) return [ink, .46 + .16 * lit * (d > rp - rim * .5 ? 1 : -.6) + .04 * jit(x, y, seed)];    // 轮缘
    if (d < hubR) return d < hubR * .42 ? [hub, .2] : [hub === ink ? ink : hub, .5 + .24 * lit];             // 轮毂和轴孔
    if (!spokes) return [ink, .34 + .08 * lit];
    const sa = ((a / TAU * spokes) % 1 + 1) % 1, off = Math.abs(sa - .5) * TAU / spokes * d;                 // 离最近一根辐条的中线有多远（像素）
    if (off < Math.max(1.6, rp * .085)) return [ink, .44 + .16 * lit * (off < .8 ? 1 : .2) - (off > rp * .06 ? .12 : 0)];
    return null;                                                                                               // 辐条之间是空的
  });
  for (let k = 0; k < Math.max(4, spokes * 2); k++) { const a = (k + .5) / Math.max(4, spokes * 2) * TAU, r = rp - Math.max(3.5, rp * .2) * .55 - th * .3; if (rp > 14) s.rivet(R + Math.cos(a) * r - 1, R + Math.sin(a) * r - 1, .22); }
  if (ink !== 'brass') s.wear('rust', .7, 6, seed + 3, -.05);
  s.grime(.08, 10, seed).rim('coal', .06);
  return s.bake();
}

// —— 盘面：一格一块铆钉铁板，嵌一圈黄铜条，四角黄铜铆钉。本方出兵列（r = 0）漆成暗青，对面（最后一列）漆成暗红，
//    靠城堡那一边各有一道队伍色的警示斜纹和一颗嵌灯。整张画好后由 arena.js 按格子切开；每格左上角那颗像素是侧边用的勾缝色 ——
export function board({ rows, lanes, tw, th }) {
  const s = new Sheet(rows * tw, lanes * th);
  for (let c = 0; c < lanes; c++) for (let r = 0; r < rows; r++) {
    const x0 = r * tw, y0 = c * th, team = r === 0 ? 'teal' : r === rows - 1 ? 'red' : null, k = jit(r, c, 31), alt = ((r + c) & 1) * .035;
    s.rect(x0, y0, tw, th, 'coal', .04);                                                   // 勾缝
    s.panel(x0 + 1, y0 + 1, tw - 2, th - 2, 'iron', .3 + k * .04 + alt, { edge: .13 });     // 铁板的边
    for (let i = 4; i < tw - 4; i++) { s.dot(x0 + i, y0 + 4, 'brass', .4).dot(x0 + i, y0 + th - 5, 'brass', .26); }   // 嵌的黄铜条
    for (let j = 4; j < th - 4; j++) { s.dot(x0 + 4, y0 + j, 'brass', .36).dot(x0 + tw - 5, y0 + j, 'brass', .24); }
    s.rect(x0 + 5, y0 + 5, tw - 10, th - 10, team ?? 'soot', (i, j) => (team === 'red' ? .11 : team ? .125 : .42 + alt) + (k - .5) * .04 + (((i + j * 3) % 8 < 2) ? ((((i >> 2) + (j >> 2)) & 1) ? .05 : -.04) : 0) + (i === 0 || j === 0 ? -.08 : 0));   // 板心：花纹钢板
    for (const [a, b] of [[2, 2], [tw - 4, 2], [2, th - 4], [tw - 4, th - 4]]) { s.dot(x0 + a, y0 + b, 'brass', .62).dot(x0 + a + 1, y0 + b, 'brass', .4).dot(x0 + a, y0 + b + 1, 'brass', .4).dot(x0 + a + 1, y0 + b + 1, 'brass', .2); }
    if (team) {
      const left = r === 0, bx = left ? x0 + 6 : x0 + tw - 13;                               // 靠城堡那边的斜纹带
      for (let j = 6; j < th - 6; j++) for (let i = 0; i < 7; i++) s.dot(bx + i, y0 + j, team, ((i + j) % 8 < 4) ? (team === 'red' ? .26 : .34) : .08);
      for (let j = 6; j < th - 6; j++) s.dot(left ? bx + 7 : bx - 1, y0 + j, team, .44);
      const my = y0 + (th >> 1), ax = left ? x0 + tw - 14 : x0 + 13, dir = left ? 1 : -1;      // 板心一个朝前的箭头（很暗，只是点题）
      for (let i = 0; i < 6; i++) for (let j = -i; j <= i; j++) if (Math.abs(j) >= i - 1) s.dot(ax - dir * i, my + j, team, .3);
    } else if ((r + c) % 2 === 0) { const cx = x0 + (tw >> 1), cy = y0 + (th >> 1); for (let a = 0; a < 16; a++) { const an = a / 16 * 6.283; s.add(cx + Math.cos(an) * 7, cy + Math.sin(an) * 7, a % 2 ? .07 : -.05); } }   // 中间的格子隔一块压一个浅浅的圆印
  }
  const out = s.grime(.07, 22, 5).scuff(120, 7, .05, 9);
  for (let c = 0; c < lanes; c++) for (let r = 0; r < rows; r++) out.dot(r * tw, c * th, 'coal', .04);
  return out.bake();
}

// —— 台沿：盘面外面那一圈。最外是警示斜纹，往里是铆钉铁框和一道黄铜条，四角各一块带大螺栓的角板；
//    左边（本方）那一条嵌一排青灯座，右边嵌红灯座。中间（格子底下）是黑的 ——
export function daisTop({ w, h, rim, lanes, th }) {
  const s = new Sheet(w, h), inX = rim, inY = rim;
  s.rect(0, 0, w, h, 'coal', .04);
  for (let i = 0; i < w; i += 24) for (const y of [0, h - rim]) s.panel(i, y, 24, rim, 'iron', .32 + jit(i, y, 3) * .06, { edge: .14 });
  for (let j = rim; j < h - rim; j += 24) for (const x of [0, w - rim]) s.panel(x, j, rim, Math.min(24, h - rim - j), 'iron', .32 + jit(x, j, 4) * .06, { edge: .14 });
  const haz = (x, y) => ((x + y) % 14 + 14) % 14 < 7;
  s.each((x, y) => { const d = Math.min(x, y, w - 1 - x, h - 1 - y); if (d >= 1 && d < 7) return haz(x, y) ? ['hazard', .5] : ['coal', .16]; if (d === 7 || d === 0) return ['coal', .08]; return null; });
  s.each((x, y) => { const d = Math.min(x - inX, y - inY, w - inX - 1 - x, h - inY - 1 - y); return d === -3 ? ['brass', .5] : d === -2 ? ['brass', .28] : null; });      // 贴着格子的一道黄铜条
  for (let i = 12; i < w - 8; i += 12) for (const y of [9, h - 12]) s.rivet(i, y); for (let j = 12; j < h - 8; j += 12) for (const x of [9, w - 12]) s.rivet(x, j);
  for (const [cx, cy] of [[0, 0], [w - rim, 0], [0, h - rim], [w - rim, h - rim]]) { s.panel(cx + 1, cy + 1, rim - 2, rim - 2, 'steel', .36, { edge: .18 }); s.disc(cx + rim / 2, cy + rim / 2, rim * .27, 'brass', .52, .3); s.dot(cx + rim / 2, cy + rim / 2, 'coal', .1); }
  for (let c = 0; c < lanes; c++) for (const [x, ink] of [[rim - 9, 'teal'], [w - rim + 3, 'red']]) { const y = inY + c * th + (th >> 1); s.panel(x, y - 9, 6, 18, ink, .2, { edge: .2 }); }   // 灯座（灯本身是另外一张发光的小片）
  return s.grime(.08, 18, 2).scuff(40, 5, .06, 4).bake();
}

// —— 大熔炉的炉口：一面耐火砖墙上开一个拱洞（镂空），箍一圈带铆钉的铁拱圈，拱顶一块黄铜牌，底下一道铁炉唇。按 1.5 倍放大用（远景） ——
export function mouth() {
  const W = 132, H = 86, s = new Sheet(W, H), cx = 66, top = 36, r = 39, ir = 30;
  for (let y = 0, j = 0; y < H; y += 8, j++) for (let x = (j & 1) * 8 - 8, i = 0; x < W; x += 16, i++) { const k = jit(i, j, 51); s.panel(x, y, 15, 7, k > .8 ? 'soot' : 'brick', .38 + (k - .5) * .18, { edge: .09 }); for (let a = 0; a < 16; a++) s.dot(x + a, y + 7, 'coal', .08); }
  s.grime(.16, 18, 4).wear('coal', .66, 20, 9, -.2);
  s.each((x, y) => { const d = y >= top ? Math.abs(x - cx) : Math.hypot(x - cx, y - top); if (d < ir) return 0; if (d < r) return ['iron', .44 - (x - cx) * .003 + (d < ir + 1.6 ? -.2 : d > r - 1.6 ? .16 : 0)]; return null; });
  for (let k = 0; k <= 10; k++) { const a = Math.PI * (1 + k / 10); s.rivet(cx + Math.cos(a) * 34.5 - 1, top + Math.sin(a) * 34.5 - 1, .3); }
  for (let y = top + 8; y < H - 8; y += 9) { s.rivet(cx - 35, y, .3); s.rivet(cx + 33, y, .3); }
  s.panel(cx - 9, 0, 18, 9, 'brass', .56, { edge: .2, rivet: -1, pad: 2 });
  for (const x of [8, W - 30]) { s.panel(x, 40, 22, 14, 'iron', .36, { edge: .16, rivet: -1 }); s.rect(x + 4, 44, 14, 6, 'fire', (i, j) => .5 + .1 * j + (i % 4 === 0 ? -.3 : 0)); }   // 两边各一个观火孔
  s.rect(0, H - 8, W, 8, 'hazard', (i, j) => (i + j) % 16 < 8 ? .46 : .0); s.each((x, y) => y >= H - 8 && (x + y - (H - 8)) % 16 >= 8 ? ['coal', .16] : null);
  s.each((x, y) => y >= H - 8 && Math.abs(x - cx) < ir ? 0 : null);
  return s.bake();
}
