// 《林间寨擂》· C 版的全部贴图与小物件像素画。每个函数返回一张 canvas；种子相同画出来就相同。
// 两类：能平铺的材料（砌石、树皮、竹、木板、茅草、布……，贴在立体的形体上），和透明底的小物件（陶罐、蘑菇、蕨、灯笼、牌子……，做成立着的卡片）。
import { D, RAMP as R, Pix, hash2, vnoise, fbm, mulberry, digits, HEART } from './pix.js';
const T = (w, h) => new Pix(w, h);

// ———————————————— 能平铺的材料 ————————————————
// 砌石：错缝的石块，缝最暗，每块自己偏亮或偏暗，上沿亮下沿暗；缝里和顶上长青苔
export function masonry({ w = 64, h = 48, bw = 16, bh = 12, seed = 1, moss = .4, rp = R.rock, base = 2.5 } = {}) {
  return T(w, h).fill((x, y) => {
    const row = Math.floor(y / bh), ox = (row & 1) * (bw >> 1), bx = Math.floor((x + ox) / bw) % (w / bw), lx = (x + ox) % bw, ly = y % bh;
    const n = fbm(x / 8, y / 8, seed, 3, w / 8, h / 8);
    if (moss && n + (ly < 2 ? .16 : 0) > 1 - moss * .38) return [R.grass, 1 + n * 3.4];
    if (lx === 0 || ly === 0) return [rp, .2];
    let v = base + (hash2(bx, row, seed) - .5) * 1.6 + (n - .5) * 1.5;
    if (ly === 1) v += 1; if (ly === bh - 1) v -= .9; if (lx === 1) v += .5; if (lx === bw - 1) v -= .6;
    return [rp, v];
  }).canvas();
}
// 回纹饰带：擂台石沿上刻的一圈
const KEY = ['1111111011111110', '1000001010000010', '1011101010111010', '1010101010101010', '1010001010100010', '1011111010111110', '1000000010000000', '1111111111111111'];
export function frieze({ rp = R.slab } = {}) {
  return T(32, 12).fill((x, y) => y === 0 ? [rp, 4.8] : y === 11 ? [rp, .8] : (y === 1 || y === 10) ? [rp, 2.2] : KEY[y - 2][x % 16] === '1' ? [rp, 1.2] : [rp, 3.7 - (y - 2) * .08]).canvas();
}
// 树皮：竖向的深沟和亮脊，背阴处长苔
export function bark({ w = 64, h = 64, seed = 5 } = {}) {
  return T(w, h).fill((x, y) => { const r = fbm(x / 3.2, y / 16, seed, 3, 20, 4), k = fbm(x / 8, y / 8, seed + 2, 2, 8, 8); return k > .72 ? [R.grass, .6 + k * 2.6] : [R.wood, .4 + r * 3.7 + (k - .5) * 1.4]; }).canvas();
}
// 竹竿：一节 40 像素，节上一道暗线一道亮线，竿身有竖向的色差
export function bamboo({ w = 16, h = 40, seed = 3, rp = R.bamboo } = {}) {
  return T(w, h).fill((x, y) => y === 0 ? [rp, .8] : y === 1 ? [rp, 4.9] : [rp, 3.1 + (vnoise(x / 2, y / 11, seed, 8, 0) - .5) * 1.6 + (hash2(x, 3, seed) < .15 ? -1 : 0)]).canvas();
}
// 木板：板缝最暗，木纹顺着板长拉丝，隔一段一道接缝和一颗钉
export function planks({ w = 64, h = 32, ph = 8, seed = 3, vertical = false, rp = R.wood, base = 2.7 } = {}) {
  const count = (vertical ? w : h) / ph;
  return T(w, h).fill((x, y) => {
    const a = vertical ? x : y, b = vertical ? y : x, k = Math.floor(a / ph) % count, la = a % ph, j = (b + k * 23) % 48;
    if (la === 0 || j === 0) return [rp, .3];
    if (la === (ph >> 1) && j === 4) return [R.rock, 1];
    let v = base + (hash2(k, 1, seed) - .5) * 1.4 + (vnoise(b / 12 + k * 3.1, a / 1.7, seed) - .5) * 1.6;
    if (la === 1) v += .7; if (la === ph - 1) v -= .7;
    return [rp, v];
  }).canvas();
}
// 茅草：一层压一层的草帘，每层下沿亮、被压住的地方暗，下沿参差不齐
export function thatch({ w = 64, h = 48, rh = 12, seed = 11, rp = R.thatch } = {}) {
  return T(w, h).fill((x, y) => { const yy = (y + Math.floor(hash2(x, 0, seed) * 4)) % rh; return yy === 0 ? [rp, .5] : [rp, 1 + (yy / rh) * 3.4 + (vnoise(x / 1.4, y / 10, seed) - .5) * 1.8 + (hash2(x, y, seed) < .02 ? 1.2 : 0)]; }).canvas();
}
// 条纹布：阵营色的底，隔几行一道亮纹和一道金线
export function weave({ team = 'teal', seed = 2 } = {}) {
  return T(16, 16).fill((x, y) => y % 8 === 0 ? [R[team], .7] : y % 8 === 4 && x % 4 < 2 ? [R.gold, 3.6] : [R[team], 2.5 + (y % 8 < 3 ? 1.1 : 0) + Math.sin(x * Math.PI / 4 + seed) * .6]).canvas();
}
// 兽皮帐面：皮色的底，下半截一圈骨白色的折线纹，零星缝线
export function hide({ seed = 4 } = {}) {
  return T(32, 32).fill((x, y) => { const zig = Math.abs((x % 8) - 4); if (y - 20 === zig || y - 21 === zig) return [R.bone, 4.2, .2]; if (y === 27) return [R.red, 3.4, .2]; if (x % 16 === 0 && y % 4 < 2) return [R.clay, .6]; return [R.clay, 2.3 + (fbm(x / 6, y / 6, seed, 2, 0, 0) - .5) * 2.2 - (y < 4 ? 1 : 0)]; }).canvas();
}
export function rope() { return T(8, 8).fill((x, y) => (x + y) % 4 < 2 ? [R.thatch, 3.8] : [R.thatch, 1.6]).canvas(); }
// 木桶的侧面：竖板 + 两道铁箍
export function barrelSide() {
  return T(32, 28).fill((x, y) => (y >= 4 && y < 7) || (y >= 20 && y < 23) ? [R.rock, y % 16 === 4 ? 4 : 2.2] : x % 8 === 0 ? [R.wood, .4] : [R.wood, 2.6 + (vnoise(x / 1.5, y / 9, 7, 0, 0) - .5) * 1.6 + (hash2(x >> 3, 0, 9) - .5)]).canvas();
}
// 木箱的一面：边框 + 斜撑 + 钉
export function crateFace({ seed = 4 } = {}) {
  const w = 24;
  return T(w, w).fill((x, y) => { const e = Math.min(x, y, w - 1 - x, w - 1 - y); if (e === 0) return [R.wood, .3]; if (e < 3) return (e === 1 && (x + y) % 9 === 0) ? [R.rock, 4] : [R.wood, 3.7 + (e === 1 ? .7 : 0)]; if (Math.abs(x - y) < 2) return [R.wood, 3.5]; return [R.wood, 2 + vnoise(x / 1.5, y / 8, seed) * 1.4 - (x % 5 === 0 ? 1.1 : 0)]; }).canvas();
}
// 图腾柱的一截：刻出来的脸，眼白和牙是骨色，脸颊和上下边是阵营色的彩绘
export function totem({ team = 'teal', kind = 0, seed = 3 } = {}) {
  const w = 32, p = T(w, w).fill((x, y) => [R.wood, 2.5 + (vnoise(x / 1.6, y / 10, seed) - .5) * 1.5 - (x === 0 || x === w - 1 ? 1.5 : 0)]);
  for (let x = 0; x < w; x++) { const zig = Math.abs((x % 6) - 3); for (const y0 of [1, 27]) { p.put(x, y0 + zig, R[team], 3.6, .2); p.put(x, y0 + zig + 1, R[team], 2.2, .2); } p.put(x, 0, R.wood, .4); p.put(x, 31, R.wood, .4); }
  for (const s of [-1, 1]) {                                  // 眉、眼、脸颊彩绘
    const cx = 15.5 + s * 7;
    p.line(cx - 4, kind ? 8 : 10, cx + 4, kind ? 10 - s * 2 + s * 2 : 8, R.wood, .5, 2);
    if (kind === 0) p.ell(cx, 13, 3.5, 2.5, R.bone, 4, 1.4); else p.box(Math.round(cx - 3), 12, 7, 3, R.bone, 4.4);
    p.box(Math.round(cx - .5), 12, 2, 2, R.wood, .2, 0);
    for (let k = 0; k < 3; k++) p.line(cx + s * 2 - 2, 17 + k * 2, cx + s * 2 + 2, 17 + k * 2, R[team], 4 - k * .6, 1);
  }
  p.box(14, 12, 4, 7, R.wood, (u) => 4 - u * 2);               // 鼻
  p.box(8, 21, 16, 5, R.wood, .3, 0);                          // 嘴和牙
  for (let x = 9; x < 23; x += 3) { p.box(x, 21, 2, kind ? 3 : 2, R.bone, 4.6, 0); if (kind === 0) p.box(x + 1, 24, 2, 2, R.bone, 3.6, 0); }
  return p.canvas();
}
// 窗：暖色的亮格子，十字窗棂，半幅阵营色的帘子
export function windowGlow({ team = 'teal' } = {}) {
  const w = 14, h = 18;
  return T(w, h).fill((x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 || x === (w >> 1) || y === 8) ? [R.wood, .8] : (y < 6 ? [R[team], 3.2 + Math.sin(x * 1.6) * .8] : [R.gold, 4.2 + (1 - y / h) * 1.2, .4])).canvas();
}

// ———————————————— 棋盘与地面（各一整张，不平铺）————————————————
// 棋盘石面：5×4 块石板。纹理故意画得安静（明暗只差一级半），棋子站上去才跳得出来。
// 我方出兵那一排嵌青色的角线和菱形，敌方那一排嵌红色；前线的位置嵌一道金线；外沿爬进来一点青苔
export function boardTop({ rows = 5, lanes = 4, cw = 48, ch = 44, front = 2, seed = 5 } = {}) {
  const W = rows * cw, H = lanes * ch, p = T(W, H), cracks = new Set(), rnd = mulberry(seed * 977);
  for (let k = 0; k < 26; k++) { let x = rnd() * W, y = rnd() * H; const dx = rnd() < .5 ? 1 : -1; for (let i = 0, n = 5 + rnd() * 14; i < n; i++) { cracks.add((x | 0) + ',' + (y | 0)); x += dx * (rnd() < .7 ? 1 : 0); y += rnd() < .6 ? 1 : 0; } }
  p.fill((x, y) => {
    const i = Math.floor(x / cw), j = Math.floor(y / ch), lx = x % cw, ly = y % ch, e = Math.min(lx, ly, cw - 1 - lx, ch - 1 - ly);
    const n = fbm(x / 9, y / 9, seed, 3), edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    if (edge < 7 && fbm(x / 6, y / 6, seed + 31, 2) > .52 + edge * .04) return [R.grass, 1.4 + n * 2.6];
    if (e === 0) return [R.slab, .4];
    if (cracks.has(x + ',' + y)) return [R.slab, 1.3];
    const team = i === 0 ? R.teal : i === rows - 1 ? R.red : null, a = Math.min(lx, cw - 1 - lx), b = Math.min(ly, ch - 1 - ly);
    if (team) {
      if ((a === 4 && b >= 4 && b < 12) || (b === 4 && a >= 4 && a < 12)) return [team, 2.6, .3];
      const m = Math.abs(lx - (cw - 1) / 2) + Math.abs(ly - (ch - 1) / 2); if (m > 8.4 && m < 10.6) return [team, 2.3, .3];
    } else if (a >= 4 && a <= 5 && b >= 4 && b <= 5) return [R.slab, 1.6];
    let v = 3.2 + (hash2(i, j, seed) - .5) * .7 + (n - .5) * 1.3;
    if (e === 1) v += (lx === 1 || ly === 1) ? 1.1 : -1.2;
    return [R.slab, v];
  });
  const fx = (front + 1) * cw; if (front >= 0) for (let y = 0; y < H; y++) { p.put(fx - 1, y, R.gold, 2.4 + (y % 6 < 3 ? .8 : 0), .2); p.put(fx, y, R.gold, 3.4 + (y % 6 < 3 ? .8 : 0), .2); }
  return p.canvas();
}
// 整片空地：擂台脚下一圈卵石，往外是踩实的土，前面和两侧各一条浅色的小路，再往外是草（一丛一丛的草叶、零星的花），土上有石子和落叶
export function ground({ wm = 26, hm = 20, cx = 13, cz = 11, seed = 9, rx = 3.3, rz = 2.5, clx = 8.2, clz = 5.2 } = {}) {
  return T(wm * D, hm * D).fill((x, y) => {
    const X = x / D - cx, Z = y / D - cz, n = fbm(x / 30, y / 30, seed, 4), f = fbm(x / 5, y / 5, seed + 7, 2), h = hash2(x, y, seed + 3);
    const d = Math.max(Math.abs(X) - rx, Math.abs(Z) - rz) + (n - .5) * .5;
    const clearing = Math.hypot(X / clx, (Z - .3) / clz) + (n - .5) * .5;
    const path = Math.max(Math.exp(-((X - Math.sin(Z * .7) * .5) ** 2) / 1.4) * (Z > rz - .1 ? 1 : 0), Math.exp(-((Z - 1.2 + X * .12) ** 2) / .8) * (Math.abs(X) > rx + .3 ? .8 : 0));
    if (d < .85) {
      const cs = 9, gx = Math.floor(x / cs), gy = Math.floor(y / cs); let best = 99, id = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const qx = (gx + a + .5 + (hash2(gx + a, gy + b, 11) - .5) * .7) * cs, qy = (gy + b + .5 + (hash2(gx + a, gy + b, 12) - .5) * .7) * cs, q = Math.max(Math.abs(x - qx), Math.abs(y - qy) * 1.2); if (q < best) { best = q; id = hash2(gx + a, gy + b, 13); } }
      return best > 3.6 ? [R.dirt, .8 + f] : [R.rock, 2.2 + id * 1.6 + (3.6 - best) * .25 - (f - .5), .5];
    }
    if (clearing - path * .45 > 1) {
      const blade = hash2(x, Math.floor((y + hash2(x, 0, 5) * 6) / 6), seed + 1);
      if (h < .004) return [h < .0015 ? R.red : h < .0028 ? R.gold : R.bone, 4.2];
      return [R.grass, 1.2 + n * 2.4 + (blade - .5) * 1.8 + (f - .5) - Math.min(1.4, (clearing - 1) * 1.1) + (blade > .93 ? 1.3 : 0)];
    }
    if (h < .004) return [R.rock, 2.6 + h * 500];
    if (h > .9972) return [R.thatch, 3.6];
    if (h > .995 && h < .996) return [R.grass, 2.4];
    return [R.dirt, 2.4 + (n - .5) * 2.4 + (f - .5) * 1.3 + path * 1.1 - Math.max(0, clearing - .82) * 3];
  }).canvas();
}

// ———————————————— 透明底的小物件 ————————————————
// 陶罐：0 高的红陶罐、1 土黄的罐、2 矮的宽口缸；肚子上一圈骨白色的纹
export function pot({ kind = 0 } = {}) {
  const rp = kind === 1 ? R.thatch : R.clay, w = kind === 2 ? 20 : 16, h = kind === 2 ? 16 : 22, p = T(w + 2, h + 2), cx = w / 2 + .5;
  p.ell(cx, h - h * .42, w / 2 - 1, h * .42, rp, 3, 2.6);
  p.box(Math.round(cx - w * .22), 2, Math.round(w * .44) + 1, Math.round(h * .24), rp, u => 3.6 - u * 1.8);
  p.box(Math.round(cx - w * .3), 1, Math.round(w * .6) + 1, 2, rp, (u, v) => 4.8 - u * 1.4 - v);
  const by = Math.round(h * .55); for (let x = 2; x < w; x++) if (p.has(x, by)) { p.put(x, by, R.bone, 4.4 - x / w * 2, .2); if (x % 4 < 2 && p.has(x, by + 1)) p.put(x, by + 1, R.bone, 3.2, .2); }
  return p.outline(R.clay, 0).canvas();
}
export function mushrooms({ seed = 1 } = {}) {
  const p = T(24, 18);
  for (const [cx, top, r, rp] of [[7, 6, 5, R.red], [16, 9, 4, seed & 1 ? R.gold : R.red], [11, 12, 2.5, R.violet]]) {
    p.box(Math.round(cx - 1), top + 1, 3, 16 - top, R.bone, u => 4.6 - u * 1.8);
    for (let y = -r; y <= 0; y++) for (let x = -r; x <= r; x++) if (x * x + y * y * 2.2 <= r * r) p.put(cx + x, top + y + 1, rp, 3.5 - x / r * 1.2 - y / r * .9, .4);
    p.put(cx - r * .4, top - r * .3 + 1, R.bone, 5, 0); p.put(cx + r * .45, top, R.bone, 5, 0);
  }
  return p.outline(R.wood, 0).canvas();
}
export function flowers({ seed = 1, rp = R.red } = {}) {
  const p = T(24, 18), rnd = mulberry(seed * 71 + 5);
  for (let i = 0; i < 6; i++) { const x = 1 + rnd() * 22; p.line(x, 17, x + (rnd() - .5) * 5, 10 + rnd() * 4, R.grass, 3 + rnd() * 2); }
  for (let i = 0; i < 7; i++) {
    const x = 3 + rnd() * 18, top = 2 + rnd() * 8; p.line(x, 17, x + (rnd() - .5) * 3, top + 2, R.grass, 2.6);
    const hx = Math.round(x + (rnd() - .5) * 2), hy = Math.round(top);
    for (const [a, b] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) p.put(hx + a, hy + b, rp, 3.6 + (a + b < 0 ? 1 : 0), .2);
    p.put(hx, hy, R.gold, 5, 0);
  }
  return p.canvas();
}
// 蕨：从根部散开的十来条叶，每条两侧一对一对的小叶，叶尖最亮
export function fern({ seed = 1, w = 40, h = 30, rp = R.grass } = {}) {
  const p = T(w, h), rnd = mulberry(seed * 37 + 3);
  for (let i = 0; i < 11; i++) {
    const a = -1.35 + 2.7 * (i + rnd() * .6) / 11, L = h * (.55 + rnd() * .4), lv = 2.2 + rnd() * 2.4;
    for (let s = 0; s <= 1; s += 1 / (L * 1.4)) {
      const x = w / 2 + Math.sin(a) * L * s, y = h - 1 - Math.cos(a) * L * s + s * s * L * .28; p.put(x, y, rp, lv + s * 1.4, .3);
      if (Math.round(s * L) % 2 === 0) { const k = (1 - s) * 3 + 1; p.put(x - Math.cos(a) * k * .6, y - k * .6, rp, lv + 1, .3); p.put(x + Math.cos(a) * k * .6, y + k * .5, rp, lv - .6, .3); }
    }
  }
  return p.canvas();
}
export function tuft({ seed = 1, w = 20, h = 14, rp = R.grass } = {}) {
  const p = T(w, h), rnd = mulberry(seed * 131 + 7);
  for (let i = 0; i < 10; i++) { const x = 2 + rnd() * (w - 4), top = 1 + rnd() * h * .55, lean = (rnd() - .5) * 6, lv = 2 + rnd() * 2.6; p.line(x, h - 1, x + lean, top, rp, t => lv - 1 + t * 2.2); }
  return p.canvas();
}
// 一团叶子：几个球叠出体积（左上受光），再按 2×2 的小叶片打碎；树冠、灌木、前景的剪影都用它
export function foliage({ w = 72, h = 52, seed = 1, rp = R.leaf, lift = 0, blobs = 9 } = {}) {
  const p = T(w, h), rnd = mulberry(seed * 91 + 17), B = [];
  for (let i = 0; i < blobs; i++) { const r = h * (.2 + rnd() * .16); B.push([r + 1 + rnd() * (w - 2 * r - 2), i < 3 ? h - 2 - r : r + 1 + rnd() * (h - 2 * r - 3), r]); }
  p.fill((x, y) => {
    let best = -9; for (const [cx, cy, r] of B) { const nx = (x - cx) / r, ny = (y - cy) / r, q = nx * nx + ny * ny; if (q <= 1) best = Math.max(best, -.55 * nx - .7 * ny + .45 * Math.sqrt(1 - q)); }
    return best < -8 ? null : [rp, 2.1 + lift + best * 2.3 + (hash2(x >> 1, (y + ((x >> 1) & 1)) >> 1, seed) - .5) * 1.9, .5];
  });
  return p.outline(rp, 0).canvas();
}
// 垂下来的藤：一条弯弯的茎，两边交替长叶
export function vine({ seed = 1, h = 96 } = {}) {
  const p = T(14, h);
  for (let y = 0; y < h; y++) { const x = 6.5 + Math.sin(y * .16 + seed) * 2.6; p.put(x, y, R.leaf, 3.2 - y / h, .3); if (y % 5 === seed % 5) { const s = (y / 5 | 0) & 1 ? 1 : -1; for (let k = 1; k <= 3; k++) { p.put(x + s * k, y + k - 1, R.grass, 4.6 - k * .5, .3); p.put(x + s * k, y + k, R.grass, 3.2 - k * .4, .3); } } }
  return p.canvas();
}
// 纸灯笼：一个发光的茧，三道竹骨，底下一条红穗
export function lantern({ rp = R.gold } = {}) {
  const p = T(16, 24); p.box(6, 1, 4, 2, R.wood, 2.4); p.ell(7.5, 11, 5.5, 7.5, rp, 3.8, 1.8);
  for (let y = 4; y < 19; y++) for (const x of [4, 7, 11]) if (p.has(x, y)) p.put(x, y, rp, 2.4, .2);
  p.box(6, 18, 4, 2, R.wood, 2.4); p.line(7.5, 20, 7.5, 22, R.red, 3.4);
  return p.outline(R.wood, 0).canvas();
}
// 火苗的序列帧（横排 frames 帧）：水滴形，芯是 hot 色阶，外焰是 cool 色阶，越往上越碎
export function flames({ frames = 4, w = 16, h = 24, hot = R.gold, cool = R.red } = {}) {
  const p = T(w * frames, h);
  for (let f = 0; f < frames; f++) for (let y = 0; y < h; y++) {
    const t = 1 - y / (h - 1), sway = Math.sin(f * 1.7 + t * 3.1) * 2.2 * t, half = (1 - t) ** .7 * (w / 2 - 1.5) * (.8 + .2 * Math.sin(f * 2.3 + y));
    for (let x = 0; x < w; x++) { const dx = Math.abs(x - (w - 1) / 2 - sway); if (dx > half || hash2(x, y, f) < t * .35) continue; const k = (1 - dx / (half + .01)) * (1 - t * .8); p.put(f * w + x, y, k > .5 ? hot : cool, k > .5 ? 3.4 + k * 2.6 : 2.4 + k * 3.6, .4); }
  }
  return p.canvas();
}
// 城门血量牌：两根绳吊着的木牌，阵营色的边，像素心 + 数字（放大两倍）
export function plaque({ hp = 10, team = 'teal' } = {}) {
  const w = 46, h = 30, p = T(w, h); p.line(8, 0, 8, 6, R.thatch, 3.4); p.line(w - 9, 0, w - 9, 6, R.thatch, 3.4);
  p.box(1, 6, w - 2, h - 7, R.wood, (u, v, x, y) => 1.2 + vnoise(x / 9, y / 1.6, 31) * 1.2);
  for (let x = 1; x < w - 1; x++) { p.put(x, 6, R[team], 4.4, .2); p.put(x, 7, R[team], 3, .2); p.put(x, h - 2, R[team], 2.2, .2); }
  for (let y = 6; y < h - 1; y++) { p.put(1, y, R[team], 3.8, .2); p.put(w - 2, y, R[team], 2.4, .2); }
  const text = String(hp), tw = text.length * 8 - 2, x0 = Math.round((w - (14 + 3 + tw)) / 2), y0 = 12;
  HEART.forEach((row, j) => [...row].forEach((c, i) => { if (c === '1') p.box(x0 + i * 2, y0 + j * 2, 2, 2, R.red, j < 2 && i < 3 ? 4.6 : 3.2, 0); }));
  digits(p, text, x0 + 17, y0 + 1, R.gold, 5, 2);
  return p.outline(R.wood, 0).canvas();
}
// 棋子脚边的战力牌：阵营色的菱形小牌 + 数字
export function badge({ n = 1, team = 'teal' } = {}) {
  const s = 15, c = 7, p = T(s, s);
  p.fill((x, y) => { const m = Math.abs(x - c) + Math.abs(y - c); return m > c ? null : m > c - 1 ? [R.rock, 0] : m > c - 2 ? [R[team], y < c ? 4.6 : 3.2, .2] : [R[team], 1 - (y - c) * .1, .3]; });
  const text = String(n); digits(p, text, c - (text.length * 4 - 1 >> 1), c - 2, R.gold, 5, 1);
  return p.canvas();
}
// 脚下的阵营色圈和一块抖动的接触影
export function ring({ team = 'teal', w = 40, h = 20 } = {}) {
  return T(w, h).fill((x, y) => { const r = Math.hypot((x - (w - 1) / 2) / (w / 2 - 1), (y - (h - 1) / 2) / (h / 2 - 1)); return r > 1 ? null : r > .86 ? [R[team], 4, .3] : r > .74 ? [R[team], 2.2, .4, (x + y) & 1 ? 255 : 0] : [R.rock, 0, 0, r < .5 || (x + y) & 1 ? 170 : 0]; }).canvas();
}
// 彩旗串上的一面小三角旗
export function pennant({ team = 'teal' } = {}) {
  return T(12, 16).fill((x, y) => { const half = (1 - y / 15) * 5.6; const dx = Math.abs(x - 5.5); return dx > half ? null : y < 2 ? [R.thatch, 3.6] : dx > half - 1 ? [R[team], 1.6] : y % 5 === 3 ? [R.gold, 4] : [R[team], 3.6 - (x / 12) * 1.6]; }).canvas();
}
// 长幡：阵营色的布，竖向的褶，金色的上沿，中间一个徽记（青：菱形；红：火焰形），下摆剪成三个尖
export function banner({ team = 'teal', seed = 2 } = {}) {
  const w = 26, h = 64, rp = R[team];
  return T(w, h).fill((x, y) => {
    const tail = h - 9 + Math.abs(((x + 4) % 9) - 4) * 1.8; if (y > tail) return null;
    if (x === 0 || x === w - 1 || y > tail - 1) return [rp, .4];
    if (y < 4) return [R.gold, 4.4 - y * .6 + Math.sin(x) * .4];
    const fold = Math.sin(x * .8 + seed) * .8 + Math.sin(y * .2 + x * .3) * .35, cx = (w - 1) / 2, cy = h * .4;
    const m = team === 'teal' ? Math.abs(x - cx) + Math.abs(y - cy) * .7 : Math.hypot((x - cx) * (1 + Math.max(0, cy - y) * .12), (y - cy) * .55);
    if (m < 2.5) return [R.gold, 5, .2]; if (m < 6) return [R.bone, 4.6 + fold * .4, .3]; if (m < 7.5) return [rp, .8];
    if (y % 14 === 6) return [R.gold, 3];
    return [rp, 2.8 + fold - (y / h) * .6];
  }).canvas();
}
export function sack() { const p = T(20, 18); p.ell(9.5, 11, 8, 6.5, R.bone, 2.8, 2.4); p.box(7, 2, 6, 4, R.bone, u => 3.6 - u * 1.4); p.line(6, 5, 13, 5, R.red, 3.4); return p.outline(R.wood, 0).canvas(); }
// 架子上的铜锣：木架、两根绳、一面有同心纹的金盘
export function gong() {
  const p = T(36, 40);
  p.box(2, 3, 3, 37, R.wood, u => 3.6 - u * 1.6); p.box(31, 3, 3, 37, R.wood, u => 3.2 - u * 1.6); p.box(0, 1, 36, 3, R.wood, (u, v) => 4.2 - v * 1.2); p.box(0, 37, 8, 3, R.wood, 2.2); p.box(28, 37, 8, 3, R.wood, 2);
  p.line(12, 4, 12, 9, R.thatch, 3.4); p.line(23, 4, 23, 9, R.thatch, 3.4);
  p.ell(17.5, 21, 11.5, 11.5, R.gold, 3.2, 2.6);
  for (let a = 0; a < 6.3; a += .05) { p.put(17.5 + Math.cos(a) * 7.5, 21 + Math.sin(a) * 7.5, R.gold, 1.6, .2); p.put(17.5 + Math.cos(a) * 11, 21 + Math.sin(a) * 11, R.gold, a > 2.4 && a < 5 ? 5 : 1.4, .2); }
  p.ell(17.5, 21, 3, 3, R.gold, 4.6, 1.6);
  return p.outline(R.wood, 0).canvas();
}
// 兵器架：两根立柱两道横杆，斜靠三支长矛，挂一面阵营色的圆盾
export function rack({ team = 'teal' } = {}) {
  const p = T(38, 34);
  p.box(3, 8, 2, 26, R.wood, 3); p.box(33, 8, 2, 26, R.wood, 2.4); p.box(1, 12, 36, 2, R.wood, 3.6); p.box(1, 26, 36, 2, R.wood, 2.6);
  for (const x of [9, 14, 28]) { p.line(x, 33, x + 3, 3, R.thatch, 3.2); p.line(x + 3, 3, x + 3.4, 0, R.bone, 5, 2); }
  p.ell(21, 21, 6, 6, R[team], 3.2, 2.4); p.ell(21, 21, 2, 2, R.gold, 4.4, 1.4);
  return p.outline(R.wood, 0).canvas();
}
// 鼓：皮色的鼓身，骨白色的鼓面，一圈绳
export function drum() {
  const p = T(24, 22); p.box(2, 6, 20, 14, R.clay, u => 3.6 - u * 2.2); p.ell(11.5, 19, 10, 2.5, R.clay, 1.6, 1); p.ell(11.5, 6, 10, 3.5, R.bone, 4, 1.4);
  for (let x = 3; x < 22; x += 4) p.line(x, 9, x + 2, 18, R.thatch, 3.6); return p.outline(R.wood, 0).canvas();
}
// 棋盘上的选中框：四个金色的角
export function brackets({ w = 48, h = 44 } = {}) {
  return T(w, h).fill((x, y) => { const a = Math.min(x, w - 1 - x), b = Math.min(y, h - 1 - y); return ((a < 3 && b < 13) || (b < 3 && a < 13)) ? [R.gold, (a === 0 || b === 0) ? 2.4 : 5, .2] : null; }).canvas();
}
// 出兵格上发光的符：阵营色，左右对称的几笔
export function rune({ team = 'teal', kind = 0 } = {}) {
  const p = T(21, 21), S = [[[10, 2, 10, 18], [4, 8, 10, 2], [16, 8, 10, 2], [5, 14, 15, 14]], [[4, 3, 16, 3], [10, 3, 10, 17], [4, 17, 10, 11], [16, 17, 10, 11]], [[10, 2, 3, 10], [3, 10, 10, 18], [10, 18, 17, 10], [17, 10, 10, 2], [10, 7, 10, 13]], [[3, 4, 10, 10], [17, 4, 10, 10], [10, 10, 10, 18], [5, 18, 15, 18]]][kind % 4];
  for (const [a, b, c, d] of S) p.line(a, b, c, d, R[team], 4.6, 2, .2);
  return p.canvas();
}
// 一记斩击的弧光：新月形，里沿最亮，尾巴抖动着淡出
export function slash({ rp = R.teal } = {}) {
  const w = 60, h = 34;
  return T(w, h).fill((x, y) => { const dx = x - 8, dy = (y - h / 2) * 1.5, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx); if (dx < 0 || Math.abs(a) > 1.25) return null; const thick = 7 * (1 - (Math.abs(a) / 1.25) ** 2), d = r - 40; if (d > 1 || d < -thick) return null; const k = 1 + d / (thick + .01); return k < .45 && hash2(x, y, 4) > k * 2 ? null : [k > .8 ? R.bone : rp, k > .8 ? 5 : 2.6 + k * 2.6, .5]; }).canvas();
}
// 四角星形的火花
export function spark({ rp = R.gold } = {}) {
  const s = 17, c = 8;
  return T(s, s).fill((x, y) => { const a = Math.abs(x - c), b = Math.abs(y - c); return a * b > 3.2 || a + b > c ? null : [a + b < 3 ? R.bone : rp, 5.4 - (a + b) * .4, .3]; }).canvas();
}
export function butterfly({ rp = R.violet } = {}) {                       // 两帧：翅膀张开、收拢
  const p = T(18, 7); [[0, 4], [9, 2]].forEach(([x0, wing]) => { for (let k = 1; k <= wing; k++) for (let y = 1; y < 6; y++) if (Math.abs(y - 3) <= 3 - k * .5) { p.put(x0 + 4 - k, y, k === wing ? R.gold : rp, 4.6 - Math.abs(y - 3) * .5, .2); p.put(x0 + 4 + k, y, k === wing ? R.gold : rp, 4 - Math.abs(y - 3) * .5, .2); } for (let y = 1; y < 6; y++) p.put(x0 + 4, y, R.wood, .4, 0); });
  return p.canvas();
}
export function leaf({ rp = R.thatch } = {}) { return T(6, 4).fill((x, y) => (Math.abs(x - 2.5) / 3) ** 2 + (Math.abs(y - 1.5) / 2) ** 2 > 1 ? null : [rp, y === 1 ? 4.6 : 3.2, .3]).canvas(); }
// 一团烟：抖动着淡出的圆
export function puff() { const s = 24; return T(s, s).fill((x, y) => { const r = Math.hypot(x - 11.5, y - 11.5) / 11.5, n = fbm(x / 5, y / 5, 3, 2); return r + (n - .5) * .7 > .9 ? null : [R.bone, 1.4 + (1 - r) * 1.6 - (y / s), .6, hash2(x, y, 2) > r * .9 ? 150 : 0]; }).canvas(); }
// 晶石的切面：几块亮暗不一的三角
export function crystal({ rp = R.teal } = {}) { return T(16, 16).fill((x, y) => [rp, 2.2 + ((x + y * 2) % 16 < 5 ? 2.4 : (x * 2 - y + 32) % 16 < 4 ? 1.2 : 0) + (hash2(x >> 2, y >> 2, 7) - .5) * 1.6, .4]).canvas(); }

// ———————————————— 不抖动的平滑图（加色叠加用）————————————————
export function halo(s = 64) {
  const c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d'), img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const r = Math.hypot(x - (s - 1) / 2, y - (s - 1) / 2) / (s / 2), v = Math.max(0, 1 - r) ** 2.2, i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255); img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0); return c;
}
// 光柱：横向中间亮两边淡，纵向上端亮、落地前淡出，里面有几道竖向的明暗
export function shaft(w = 64, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = Math.sin(Math.PI * x / (w - 1)) ** 1.6 * Math.min(1, (h - y) / (h * .3)) * Math.min(1, y / (h * .12) + .25) * (.7 + .3 * vnoise(x / 4, y / 60, 5)), i = (y * w + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(a * 255); img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0); return c;
}

// ———————————————— 后补的几样 ————————————————
// 石头：一块带明暗的圆石，顶上盖一层苔
export function boulder({ w = 30, h = 20, seed = 1 } = {}) {
  const p = T(w + 2, h + 2); p.ell(w / 2 + .5, h * .58 + 1, w / 2 - 1, h * .42, R.rock, 2.8, 2.8);
  for (let y = 0; y < h; y++) for (let x = 0; x < w + 2; x++) if (p.has(x, y) && !p.has(x, y - 3 - Math.floor(hash2(x >> 1, 0, seed) * 3)) && fbm(x / 5, y / 5, seed, 2) > .35) p.put(x, y, R.grass, 4.4 - (y / h) * 3, .4);
  for (let k = 0; k < 3; k++) { const x0 = 5 + hash2(k, 1, seed) * (w - 10), y0 = h * .45 + hash2(k, 2, seed) * h * .3; p.line(x0, y0, x0 + 3, y0 + 4, R.rock, 1.2); }
  return p.outline(R.rock, 0).canvas();
}
// 树桩的截面：一圈一圈的年轮
export function rings({ s = 24 } = {}) {
  return T(s, s).fill((x, y) => { const r = Math.hypot(x - (s - 1) / 2, y - (s - 1) / 2), n = vnoise(x / 4, y / 4, 6); return r > s / 2 ? null : r > s / 2 - 2 ? [R.wood, 1] : [R.thatch, 3.2 + Math.sin(r * 1.5 + n * 2) * 1.1 - (y / s) * .6]; }).canvas();
}
// 小石灯：石座 + 发光的灯室 + 石帽
export function stoneLamp() {
  const p = T(16, 26); p.box(5, 17, 6, 8, R.rock, u => 3.4 - u * 1.8); p.box(3, 23, 10, 3, R.rock, (u, v) => 3.6 - v * 1.4);
  p.box(3, 9, 10, 8, R.rock, 2.2); p.box(5, 10, 6, 6, R.gold, (u, v) => 5 - v * 1.2); p.box(7, 10, 2, 6, R.rock, 1.2);
  for (let y = 0; y < 5; y++) p.box(7 - y * 1.4, 4 + y, Math.round(2 + y * 2.8), 1, R.rock, 4.4 - y * .5); p.box(7, 2, 2, 2, R.rock, 4);
  return p.outline(R.rock, 0).canvas();
}
// 一截躺着的原木（侧面）
export function logSide() { return T(32, 12).fill((x, y) => y === 0 || y === 11 ? [R.wood, .4] : [R.wood, 3.6 - Math.abs(y - 4) * .45 + (vnoise(x / 6, y / 1.5, 4, 0, 0) - .5) * 1.4]).canvas(); }
