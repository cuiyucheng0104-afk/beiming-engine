// 《云上浮岛》的大块贴图：盘面（整盘画一张再切 20 块）、白石、草皮、崖壁、瓦、木板、帆布、气球球皮、脚下的云毯、瀑布。
// 全部逐像素算出来，返回的都是 Pix（arena.js 再转成 CanvasTexture）。画法只用本文件夹的 paint.js。
import { PPM, Pix, hash, hash2, fbm, cell, rgb, mix, tone, ramp, pick, bayer } from './paint.js';

// —— 盘面：风化的青石板，嵌着暗暗的青金石风纹和铜钉；整体压暗，比棋子素 ——
const SLATE = ['#18203a', '#202b4a', '#27355a', '#2e4069', '#374c7a'].map(rgb);   // 中间三列
const TEAL = ['#0f2a36', '#143a46', '#194a56', '#1f5c66', '#27727a'].map(rgb);     // 本方出兵列：偏青
const WINE = ['#34162a', '#461d34', '#58253e', '#6c2e48', '#843a52'].map(rgb);     // 对面出兵列：偏红
const GROUT = rgb('#0e1428');
export function boardPix(grid) {
  const { ROWS, COLS, LX, LZ } = grid, TW = Math.round(LX * PPM), TH = Math.round(LZ * PPM), p = new Pix(ROWS * TW, COLS * TH);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    const x0 = r * TW, y0 = c * TH, id = r * 7 + c * 31, rp = r === 0 ? TEAL : r === ROWS - 1 ? WINE : SLATE, own = r === 0, foe = r === ROWS - 1;
    const tint = (hash(id, 3) - .5) * .16;   // 每块石板的深浅差一点
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const X = x0 + x, Y = y0 + y, edge = Math.min(x, y, TW - 1 - x, TH - 1 - y);
      if (edge === 0) { p.set(X, Y, GROUT); continue; }                                   // 一圈勾缝（左上角那颗像素也是它：格子的侧面就是这个颜色）
      let t = .42 + tint + (fbm(X / 9, Y / 9, 5) - .5) * .7 + (hash2(X, Y, 9) - .5) * .12;   // 石面的云斑
      t -= Math.max(0, cell(X / 13, Y / 13, 17) - .78) * 1.4;                               // 几处风化的小坑
      if (edge === 1) t += (x === 1 || y === 1) ? .2 : -.24;                                // 倒角：左上亮一线、右下暗一线
      p.set(X, Y, pick(rp, t, X, Y, .9));
    }
    // 裂纹：个别石板上一道歪歪扭扭的深线
    if (hash(id, 21) > .45) { let cx = x0 + 4 + hash(id, 22) * (TW - 8), cy = y0 + 2; const n = 8 + hash(id, 23) * (TH * .6); for (let k = 0; k < n; k++) { p.set(cx, cy, rp[0]); cy += 1; cx += hash(id + k, 24) > .6 ? (hash(id + k, 25) > .5 ? 1 : -1) : 0; if (cx < x0 + 2 || cx > x0 + TW - 3) break; } }
    // 缺角
    if (hash(id, 31) > .5) { const rx = hash(id, 32) > .5, ry = hash(id, 33) > .5; for (let k = 0; k < 3; k++) for (let j = 0; j < 3 - k; j++) p.set(rx ? x0 + TW - 2 - k : x0 + 1 + k, ry ? y0 + TH - 2 - j : y0 + 1 + j, GROUT); }
    // 嵌线：一圈细细的内框（青金石 / 青 / 红，都压得很暗），四角各一颗铜钉
    const inl = own ? rgb('#1f7c80') : foe ? rgb('#96405a') : rgb('#31509a'), stud = own ? rgb('#3aa39a') : foe ? rgb('#b85a5e') : rgb('#7a6a3c'), m = 5;
    for (let x = m + 3; x < TW - m - 3; x++) { if ((x + id) % 9 > 1) { p.set(x0 + x, y0 + m, inl); p.set(x0 + x, y0 + TH - 1 - m, inl); } }
    for (let y = m + 3; y < TH - m - 3; y++) { if ((y + id) % 9 > 1) { p.set(x0 + m, y0 + y, inl); p.set(x0 + TW - 1 - m, y0 + y, inl); } }
    for (const [sx, sy] of [[m, m], [TW - 2 - m, m], [m, TH - 2 - m], [TW - 2 - m, TH - 2 - m]]) { p.rect(x0 + sx, y0 + sy, 2, 2, stud); p.set(x0 + sx + 1, y0 + sy + 1, tone(stud, -.6)); }
    const cx = x0 + (TW >> 1), cy = y0 + (TH >> 1);
    if (own || foe) {   // 出兵列：两道指向对面的风尾箭
      const d = own ? 1 : -1, col = own ? rgb('#238c8c') : rgb('#a8465a'), lo = rp[1];
      for (const off of [-5, 3]) for (let k = -7; k <= 7; k++) { const ax = cx + (off + 4 - Math.abs(k) * .6) * d; p.set(ax, cy + k, col); p.set(ax - d, cy + k, lo); }
    } else if ((r + c) % 2 === 0) {   // 中间：隔一块嵌一枚青金石的风涡
      const col = rgb('#2f4c96'), hi = rgb('#3d5fae');
      for (let a = 0; a < 9.2; a += .07) { const rr = 1.2 + a * 1.25, px = cx + Math.cos(a + id) * rr, py = cy + Math.sin(a + id) * rr * .92; p.set(px, py, a > 7.6 ? hi : col); }
      p.rect(cx - 1, cy - 1, 2, 2, rgb('#7a6a3c'));
    } else {   // 其余：三道平行的风线，末端打个小卷
      const col = rgb('#2c4688');
      for (let k = 0; k < 3; k++) { const ly = cy - 7 + k * 7, len = 13 - k * 3; for (let x = -len; x <= len; x++) if ((x + k * 3) % 7 !== 0) p.set(cx + x, ly + Math.round(Math.sin((x + id) * .32) * 1.2), col); p.set(cx + len + 1, ly - 1, col); p.set(cx + len, ly - 2, col); }
    }
  }
  return { pix: p, TW, TH };
}

// —— 白石墙：错缝的方石，朝阳的棱发金、缝里发蓝 ——
const STONE = ramp('#d6cfc0', 6, -1, .8);
export function stonePix() {
  const W = 96, H = 96, p = new Pix(W, H), CH = 16;
  for (let y = 0; y < H; y++) { const row = Math.floor(y / CH), off = row % 2 ? 16 : 0, ly = y % CH;
    for (let x = 0; x < W; x++) { const bx = Math.floor(((x + off) % W) / 32), lx = (x + off) % 32, id = row * 5 + bx;
      let t = .62 + (hash(id, 1) - .5) * .22 + (fbm(x / 7, y / 7, 3, 0) - .5) * .3 + (hash2(x, y, 4) - .5) * .08;
      if (ly === 0 || lx === 0) t = .08; else if (ly === 1 || lx === 1) t += .2; else if (ly === CH - 1 || lx === 31) t -= .25;
      if (cell(x / 11, y / 11, 8, 0) > .92) t -= .2;
      p.set(x, y, pick(STONE, t, x, y, .8)); } }
  return p;
}
// —— 铺地：台基顶上的白石方砖，中间嵌一颗小菱形 ——
export function pavePix() {
  const W = 96, H = 96, p = new Pix(W, H), S = 24;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const lx = x % S, ly = y % S, id = Math.floor(x / S) + Math.floor(y / S) * 4, d = Math.abs(lx - 12) + Math.abs(ly - 12);
    let t = .6 + (hash(id, 2) - .5) * .2 + (fbm(x / 6, y / 6, 12) - .5) * .32;
    if (lx === 0 || ly === 0) t = .1; else if (lx === 1 || ly === 1) t += .18; else if (lx === S - 1 || ly === S - 1) t -= .22;
    if (d === 5) t -= .3; else if (d < 5 && id % 3 === 0) t -= .12;
    p.set(x, y, pick(STONE, t, x, y, .8)); }
  return p;
}
// —— 盘底的暗石：格子缝里露出来的就是它 ——
export function pitPix() { const p = new Pix(16, 16); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, hash2(x, y, 1) > .7 ? rgb('#141b34') : GROUT); return p; }

// —— 草皮：能平铺；草叶一撮一撮的，夹着三叶草、小野花和露土 ——
const GRASS = ['#236f5c', '#2f8a54', '#44a548', '#62bd44', '#8fd246', '#c2e65a'].map(rgb);
export function turfPix() {
  const W = 128, H = 128, p = new Pix(W, H), T = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) T[y * W + x] = .46 + (fbm(x / 16, y / 16, 21, 8) - .5) * .9 + (hash2(x, y, 22) - .5) * .1;
  const put = (x, y, v) => { T[(((y % H) + H) % H) * W + ((x % W) + W) % W] += v; };
  for (let i = 0; i < 520; i++) { const x = Math.floor(hash(i, 31) * W), y = Math.floor(hash(i, 32) * H), l = 2 + Math.floor(hash(i, 33) * 3), lean = hash(i, 34) > .5 ? 1 : 0;   // 草叶：一小竖，顶上亮、根上暗，统一往右歪一点（风向）
    for (let k = 0; k < l; k++) put(x + (k === l - 1 ? lean : 0), y - k, k === l - 1 ? .3 : .12); put(x + 1, y + 1, -.24); }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p.set(x, y, pick(GRASS, T[y * W + x], x, y, .8));
  const dot = (x, y, c) => p.set(((x % W) + W) % W, ((y % H) + H) % H, c);
  for (let i = 0; i < 46; i++) { const x = Math.floor(hash(i, 41) * W), y = Math.floor(hash(i, 42) * H), k = hash(i, 43);   // 小野花：白、黄、粉、淡紫
    const c = rgb(k < .4 ? '#fff6e0' : k < .65 ? '#ffd84a' : k < .85 ? '#ff9ac0' : '#b9a4ff'); dot(x, y, c); if (k < .4) { dot(x + 1, y, c); dot(x, y + 1, rgb('#ffd84a')); } dot(x + 1, y + 1, GRASS[0]); }
  for (let i = 0; i < 14; i++) { const x = Math.floor(hash(i, 51) * W), y = Math.floor(hash(i, 52) * H); for (let k = 0; k < 5; k++) dot(x + Math.round(Math.cos(k * 1.26) * 2), y + Math.round(Math.sin(k * 1.26) * 1.5), GRASS[1]); dot(x, y, GRASS[3]); }   // 三叶草的小圈
  return p;
}

// —— 崖壁：一层层的岩页，左右、上下都能平铺；亮面是晒暖的褐金，暗处掉进蓝紫 ——
const ROCK = ['#2c2c62', '#44407c', '#6a5a88', '#957280', '#bb8c6c', '#e2b678', '#ffe0a0'].map(rgb);
export function rockPix() {
  const W = 96, H = 128, H0 = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const layer = fbm(x / 24, y / 8, 61, 4, 16), chunk = 1 - cell(x / 16, y / 16, 62, 6, 8); H0[y * W + x] = 1 + layer * 5 + chunk * 4 + Math.floor(fbm(x / 12, y / 32, 63, 8, 4) * 4) * 1.6; }
  return new Pix(W, H).emboss(H0, W, ROCK, { k: 1.6, wrap: true, grit: .1, seed: 64, soft: .9 });
}

// —— 瓦：一排排鱼鳞瓦。base 给陶土色就是陶瓦，给青 / 红就是两座城堡的顶 ——
export function roofPix(base, seed = 0) {
  const W = 48, H = 48, p = new Pix(W, H), rp = ramp(base, 6, -1, .9);
  for (let y = 0; y < H; y++) { const row = Math.floor(y / 8), ly = y % 8, off = row % 2 ? 4 : 0;
    for (let x = 0; x < W; x++) { const lx = (x + off) % 8, id = row * 9 + Math.floor(((x + off) % W) / 8), u = (lx - 3.5) / 4, arc = Math.sqrt(Math.max(0, 1 - u * u));
      let t = .5 + (hash(id, seed + 1) - .5) * .3 - u * .16 + (arc - .7) * .3 - (ly / 8 - .5) * .3;
      if (ly === 7 - Math.round((1 - arc) * 3) || ly === 7) t -= .34; if (ly === 0) t += .2; if (lx === 0) t -= .2;
      p.set(x, y, pick(rp, t, x, y, .7)); } }
  return p;
}
// —— 木板：横着的码头板，木纹、钉子、板缝 ——
export function plankPix(base = '#a8703f') {
  const W = 48, H = 48, p = new Pix(W, H), rp = ramp(base, 6, -1, .8);
  for (let y = 0; y < H; y++) { const row = Math.floor(y / 12), ly = y % 12;
    for (let x = 0; x < W; x++) { const cut = (x + row * 19) % 48 === 0;
      let t = .52 + (hash(row, 71) - .5) * .2 + (fbm(x / 14, y / 2.5, 72 + row, 0) - .5) * .5;
      if (ly === 0 || cut) t = .05; else if (ly === 1) t += .2; else if (ly === 11) t -= .22;
      if ((ly === 5 || ly === 6) && ((x + row * 19) % 48 === 3 || (x + row * 19) % 48 === 45)) t = .12;
      p.set(x, y, pick(rp, t, x, y, .7)); } }
  return p;
}
// —— 条纹篷布（码头的遮阳篷、气球的吊篮围布）：竖条，带一点褶子的明暗 ——
export function awningPix(a, b) {
  const W = 32, H = 32, p = new Pix(W, H), ra = ramp(a, 5, -.9, .7), rb = ramp(b, 5, -.9, .7);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = Math.floor(x / 8) % 2, lx = x % 8; let t = .56 + Math.sin(x * .39 + 1) * .16 - (y / H - .5) * .2; if (lx === 0) t -= .2; if (y > H - 4) t -= .12 + ((x >> 2) + y) % 2 * .2; p.set(x, y, pick(s ? rb : ra, t, x, y, .7)); }
  return p;
}
// —— 风车的一片帆：木头的桁条和横档撑着青色的帆布（带透明：帆架外面是空的）。帆根在下、帆尖在上 ——
export function sailPix(color, pale) {
  const W = 26, H = 64, p = new Pix(W, H), rc = ramp(color, 5, -.8, .9), rw = ramp(pale, 5, -.8, .8), wood = rgb('#7a4d34'), wd = rgb('#4a2f38');
  for (let y = 0; y < H; y++) { const v = 1 - y / H;   // v：0 帆根 → 1 帆尖
    if (v < .16) { p.rect(11, y, 3, 1, wood); p.set(13, y, wd); continue; }                 // 靠近轴的一截只有桁条
    const half = 5 + (v - .16) * 8, x0 = Math.round(12 - half * .25), x1 = Math.round(12 + half);
    for (let x = x0; x <= x1; x++) { const panel = Math.floor((y + 2) / 9), stripe = panel % 3 === 1; let t = .58 + (x - x0) / (x1 - x0) * .2 + Math.sin(y * .7) * .08 + (hash2(x, y, 81) - .5) * .1; if ((y + 2) % 9 === 8) t -= .3; p.set(x, y, pick(stripe ? rw : rc, t, x, y, .8)); }
    if ((y + 2) % 9 === 0) for (let x = x0 - 1; x <= x1 + 1; x++) p.set(x, y, x % 5 === 0 ? wd : wood);   // 横档
    p.set(x0 - 1, y, wood); p.set(x1 + 1, y, wd); p.rect(11, y, 2, 1, wood); p.set(13, y, wd);
  }
  return p;
}
// —— 气球的球皮：一瓣一瓣竖着的布，赤道上一圈奶白的菱纹，顶上金、底下深 ——
export function balloonPix(red, cream) {
  const W = 128, H = 64, p = new Pix(W, H), rr = ramp(red, 6, -.9, .8), rd = ramp(tone(red, -.35), 6, -.9, .8), rc = ramp(cream, 6, -.8, .7), rg = ramp('#e8a838', 5, -.8, .8);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const g = Math.floor(x / 8), lx = x % 8, v = y / H, bulge = 1 - Math.abs(lx - 3.5) / 4;
    let t = .5 + bulge * .26 - (v - .4) * .34, rp = g % 2 ? rr : rd;
    if (lx === 0) t -= .3;
    if (v < .1) rp = rg; else if (v > .42 && v < .58) { rp = rc; const d = Math.abs(lx - 3.5) + Math.abs(y - 32) * .9; if (d < 3.4) { rp = rr; t += .1; } if (y === 27 || y === 36) { rp = rg; } } else if (v > .9) { rp = rg; t -= .1; }
    p.set(x, y, pick(rp, t, x, y, .8)); }
  return p;
}
// —— 黄铜：小面积的包边、杆头 ——
export function brassPix() { const p = new Pix(16, 16), rp = ramp('#d49a3a', 5, -.9, .9); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, pick(rp, .5 + Math.sin((x + y) * .8) * .22 + (hash2(x, y, 91) - .5) * .2 - (y % 8 === 0 ? .4 : 0), x, y, .8)); return p; }

// —— 脚下的云毯：从天上往下看的一整片云海，能平铺。云头雪白带金边，云谷是很深的天蓝 ——
const SEA = ['#1f62c4', '#2f7fd8', '#58a2e8', '#8cc0f2', '#c2dcf8', '#eef0f2', '#fff8e4'].map(rgb);
export function cloudSeaPix(N = 384) {
  const H0 = new Float32Array(N * N), p = new Pix(N, N), S = N / 8;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const a = 1 - cell(x / S, y / S, 101, 8), b = 1 - cell(x / (S / 2.5) + 3.3, y / (S / 2.5), 102, 20), c = 1 - cell(x / (S / 6), y / (S / 6), 103, 48), cover = fbm(x / S / 2, y / S / 2, 104, 4);   // 大云团、小云头、碎云
    H0[y * N + x] = Math.max(0, a * .62 + b * .3 + c * .12 + (cover - .5) * .5 - .34) * 26;
  }
  // 自己上色：按坡向分亮暗（光从左上），高度低的地方露出下面的蓝
  const at = (i, j) => H0[((j + N) % N) * N + (i + N) % N];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const z = at(x, y), dx = at(x + 1, y) - at(x - 1, y), dy = at(x, y + 1) - at(x, y - 1);
    let t = z <= 0 ? .1 + fbm(x / 24, y / 24, 105, N / 24) * .22 : .36 + Math.min(1, z / 6) * .34 - (dx * .5 + dy * .5) * .2;
    p.set(x, y, pick(SEA, t, x, y, .9)); }
  return p;
}

// —— 瀑布：一条竖着往下流的水帘（上下能接上），白沫和水线，带透明 ——
export function fallPix() {
  const W = 24, H = 64, p = new Pix(W, H), rp = ['#3f8fd8', '#6cb8ee', '#a8dcf8', '#e4f6ff', '#ffffff'].map(rgb);
  for (let x = 0; x < W; x++) { const edge = Math.min(x, W - 1 - x), ph = hash(x, 111) * H, sp = 1 + Math.floor(hash(x, 112) * 2);
    for (let y = 0; y < H; y++) { const s = ((y * sp + ph) % H) / H, streak = s < .5 ? s * 2 : 2 - s * 2; let t = .34 + streak * .5 + (hash2(x, y, 113) - .5) * .2 - (edge < 2 ? .14 : 0);
      if (edge === 0 && hash2(x, y >> 2, 114) > .5) continue; p.set(x, y, pick(rp, t, x, y, .9)); } }
  return p;
}
// —— 云影板：只用来投影的镂空图（不透明的地方挡太阳）。几团边缘虚虚的大云影 ——
export function shadePix(N = 128) {
  const p = new Pix(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const v = fbm(x / 32, y / 32, 121, N / 32) + (1 - cell(x / 32, y / 32, 122, 4)) * .5; if (v > .98) p.set(x, y, [0, 0, 0]); }
  return p;
}
export { STONE, GRASS, ROCK };
