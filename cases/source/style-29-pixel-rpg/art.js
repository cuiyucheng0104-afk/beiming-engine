// art.js — 勇者骨架（胶囊四肢 + 左上光三阶明暗 + 部件内线 + 全局 1 px 墨描边 + 手绘 ASCII 头）、宝箱怪（程序绘制，两种尺寸）、钥匙、32×32 头像
import { C, T, FB, sprFromRows, bayer, clamp, lerp, mod } from './px.js';

// —— 材质色阶 [内线, 暗, 中, 亮] ——
const MAT = {
  skin: [C.brown, C.skinS, C.skin, C.sand],
  tunic: [C.ink, C.navy, C.blue, C.cyan],
  pants: [C.ink, C.night, C.dslate, C.slate],
  boots: [C.umber, C.umber, C.dbrown, C.brown],
  cape: [C.dgreen, C.dgreen, C.green, C.lime],
  belt: [C.umber, C.umber, C.dbrown, C.clay],
  blade: [C.dslate, C.steel, C.silver, C.white],
  hilt: [C.umber, C.dbrown, C.brown, C.tan],
};
const LX = -.55, LY = -.83;
const tone = (nx, ny) => { const v = nx * LX + ny * LY; return v > .35 ? 3 : v < -.3 ? 1 : 2; };

const SW = 56, SH = 56, OX = 28, OY = 50;
class Spr {
  constructor() { this.c = new Uint8Array(SW * SH).fill(T); this.part = new Int16Array(SW * SH).fill(-1); this.n = 0; }
  // 胶囊：逐像素算法线 → 三阶；返回像素集合以便画内线
  capsule(x0, y0, x1, y1, r0, r1, mat) {
    const id = this.n++, dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-6, ux = dx / len, uy = dy / len;
    const R = Math.max(r0, r1) + 1;
    for (let y = Math.floor(Math.min(y0, y1) - R); y <= Math.ceil(Math.max(y0, y1) + R); y++) for (let x = Math.floor(Math.min(x0, x1) - R); x <= Math.ceil(Math.max(x0, x1) + R); x++) {
      const t = clamp(((x - x0) * ux + (y - y0) * uy) / len, 0, 1), qx = x0 + ux * len * t, qy = y0 + uy * len * t;
      const r = r0 + (r1 - r0) * t, ddx = x - qx, ddy = y - qy, d = Math.hypot(ddx, ddy); if (d > r + .2) continue;
      this.put(x, y, MAT[mat][1 + tone(ddx / Math.max(.7, r), ddy / Math.max(.7, r)) - 1 + 0], id);
    }
    this.inner(id, MAT[mat][0]);
  }
  poly(pts, mat, flat = null) {
    const id = this.n++, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = xs.reduce((a, b) => a + b) / xs.length, cy = ys.reduce((a, b) => a + b) / ys.length;
    const rx = (Math.max(...xs) - Math.min(...xs)) / 2 || 1, ry = (Math.max(...ys) - Math.min(...ys)) / 2 || 1;
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      let ins = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; }
      if (!ins) continue;
      this.put(x, y, flat ?? MAT[mat][tone((x - cx) / rx, (y - cy) / ry)], id);
    }
    this.inner(id, MAT[mat][0]);
  }
  put(x, y, c, id) { const X = Math.round(x) + OX, Y = Math.round(y) + OY; if (X < 0 || Y < 0 || X >= SW || Y >= SH) return; this.c[Y * SW + X] = c; this.part[Y * SW + X] = id; }
  // 部件内线：本部件边缘中“盖在其他部件上”的像素用材质最暗色
  inner(id, line) {
    const mark = [];
    for (let i = 0; i < SW * SH; i++) if (this.part[i] === id) {
      const x = i % SW, y = (i / SW) | 0;
      for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + u, Y = y + v; if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue; const p = this.part[Y * SW + X]; if (p !== id && p !== -1) { mark.push(i); break; } }
    }
    for (const i of mark) this.c[i] = line;
  }
  rows(rows, map, x0, y0) { const id = this.n++; rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) { const ch = r[i]; if (ch === '.') continue; this.put(x0 + i, y0 + j, map[ch], id); } }); }
  // 全局墨描边 → 精灵
  done() {
    const d = this.c.slice();
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      if (this.c[y * SW + x] !== T) continue;
      for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + u, Y = y + v; if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue; if (this.c[Y * SW + X] !== T) { d[y * SW + x] = C.ink; break; } }
    }
    return { w: SW, h: SH, d, ox: OX, oy: OY };
  }
}

// —— 勇者的头（侧面朝右；三根大发尖，单像素眼）——
const HEADMAP = { j: C.rust, h: C.orange, H: C.amber, Y: C.yellow, f: C.skin, F: C.skinS, e: C.ink, m: C.skinS, b: C.rust };
const HEAD = {
  side: [
    '..j....j....',
    '.jHj..jHj...',
    'jhHHjjhHhj..',
    'jhHYHhhHHhj.',
    '.jhhHHhhhhhj',
    'jjhhhhhhhjhh',
    '.jhhhhhjfbff',
    '..jhhhjFffef',
    '.jhhhjFfffef',
    '..jhhjFffff.',
    '...jjFFffmf.',
    '.....FFff...',
  ],
  up: [
    '..j....j....',
    '.jHj..jHj...',
    'jhHHjjhHhj..',
    'jhHYHhhHHhj.',
    '.jhhHHhhhhhj',
    'jjhhhhhhjfbf',
    '.jhhhhhjFffe',
    '..jhhhjFfffe',
    '.jhhhjFfffff',
    '..jhhjFffmf.',
    '...jjFFfff..',
    '.....FFf....',
  ],
  joy: [
    '..j....j....',
    '.jHj..jHj...',
    'jhHHjjhHhj..',
    'jhHYHhhHHhj.',
    '.jhhHHhhhhhj',
    'jjhhhhhhhjhh',
    '.jhhhhhjfbff',
    '..jhhhjFfeef',
    '.jhhhjFfffff',
    '..jhhjFfmmf.',
    '...jjFFfmf..',
    '.....FFff...',
  ],
};

// 姿态：角度以“竖直向下”为 0，正值朝面向方向（右）
// raise：前臂从后脑一侧举过头（负角 = 朝身后），手臂只压在头发上，不经过脸
export const POSE = {
  stand:  { lean: 0, hip: 0, tF: .06, kF: 0, tB: -.06, kB: 0, aF: .12, eF: .25, aB: -.12, eB: .25, cape: .3, head: 'side', sword: 'sheath' },
  reach:  { lean: .14, hip: 0, tF: .18, kF: -.1, tB: -.2, kB: .1, aF: 1.25, eF: .05, aB: -.25, eB: .3, cape: .35, head: 'side', sword: 'sheath' },
  recoil: { lean: -.32, hip: -1, tF: .55, kF: -.7, tB: -.15, kB: -.5, aF: 2.3, eF: .6, aB: -1.6, eB: .4, cape: 1, head: 'up', sword: 'sheath' },
  guard:  { lean: .08, hip: 1, tF: .32, kF: -.32, tB: -.3, kB: -.12, aF: .9, eF: .6, aB: -.4, eB: .5, cape: .5, head: 'side', sword: 'ready' },
  lower:  { lean: 0, hip: 0, tF: .1, kF: 0, tB: -.1, kB: 0, aF: .25, eF: .1, aB: -.15, eB: .25, cape: .35, head: 'side', sword: 'sheath' },
  catch:  { lean: .1, hip: 0, tF: .15, kF: -.05, tB: -.15, kB: 0, aF: 1.75, eF: -.2, aB: -.3, eB: .4, cape: .5, head: 'up', sword: 'sheath' },
  crouch: { lean: .12, hip: 3, tF: .65, kF: -1.15, tB: -.15, kB: -.8, aF: .4, eF: .5, aB: -.25, eB: .5, cape: .7, head: 'side', sword: 'sheath' },
  raise:  { lean: -.06, hip: -1, tF: .1, kF: 0, tB: -.12, kB: 0, aF: -2.6, eF: -.35, aB: -2.3, eB: -.5, cape: 1.1, head: 'joy', sword: 'sheath' },
};
export function mix(a, b, k) { const o = {}; for (const key in a) o[key] = typeof a[key] === 'number' ? lerp(a[key], b[key], k) : (k < .5 ? a[key] : b[key]); return o; }
// 走路：p = 步相位（0..1 = 一步）
export function walkPose(p, base = POSE.stand) {
  const s = Math.sin(2 * Math.PI * p * .5 * 2), ph = mod(p, 2) < 1 ? 1 : -1;   // 两步一周期
  const a = Math.sin(Math.PI * mod(p, 1));                                       // 0 落地 → 1 过中点
  const sw = (mod(p, 1) - .5) * 2 * ph;                                          // 前后摆
  return { ...base, hip: -Math.round(a), tF: .42 * sw, kF: -.55 * a * (ph > 0 ? 1 : .3), tB: -.42 * sw, kB: -.55 * a * (ph > 0 ? .3 : 1), aF: -.35 * sw + .1, eF: .35, aB: .35 * sw - .1, eB: .35, lean: .06 };
}

const lp = (x, y, a, l) => [x + Math.sin(a) * l, y + Math.cos(a) * l];
// 画勇者：返回精灵（朝右；朝左时 blit 翻转）
export function hero(P, t = 0, holdKey = false, keyAng = 0) {
  const s = new Spr();
  const hipY = -10 + P.hip, hipX = 0, neckX = Math.sin(P.lean) * 8, neckY = hipY - 8 * Math.cos(P.lean);
  const sh = [neckX - .5, neckY + 1.5];
  // 披风（身后，三帧步进飘动）
  const fl = Math.floor(t * 8) % 3, w = P.cape;
  s.poly([[neckX - 1, neckY], [neckX - 3, neckY + 1], [-5 - w * 3 - fl, hipY + 3 - w * 2], [-3 - w * 4, hipY - 1 - w * 3 + (fl === 1 ? 1 : 0)], [neckX, neckY + 2]], 'cape');
  // 后臂
  const [ebx, eby] = lp(sh[0], sh[1], P.aB, 4.5), [hbx, hby] = lp(ebx, eby, P.aB + P.eB, 4);
  s.capsule(sh[0], sh[1], ebx, eby, 1.4, 1.3, 'tunic'); s.capsule(ebx, eby, hbx, hby, 1.2, 1.2, 'skin');
  // 后腿
  const [kbx, kby] = lp(hipX - .5, hipY, P.tB, 5), [fbx, fby] = lp(kbx, kby, P.tB + P.kB, 5);
  s.capsule(hipX - .5, hipY, kbx, kby, 1.7, 1.5, 'pants'); s.capsule(kbx, kby, fbx, fby - 1, 1.5, 1.6, 'boots'); s.capsule(fbx, fby - .5, fbx + 2, fby - .5, 1.1, 1.1, 'boots');
  // 剑鞘（后腰）
  if (P.sword !== 'ready' && P.sword !== 'down') s.capsule(hipX - 1, hipY - 1, hipX - 7, hipY + 4, .8, .8, 'hilt');
  // 躯干 + 下摆 + 腰带
  s.capsule(hipX, hipY - 1, neckX, neckY + 1.5, 3.4, 3.5, 'tunic');
  s.poly([[hipX - 3.6, hipY - 2], [hipX + 3.6, hipY - 2], [hipX + 4.2, hipY + 2.5], [hipX - 4.4, hipY + 2.5]], 'tunic');
  s.capsule(hipX - 3, hipY - 2, hipX + 3.4, hipY - 2, .6, .6, 'belt');
  // 前腿
  const [kfx, kfy] = lp(hipX + .5, hipY, P.tF, 5), [ffx, ffy] = lp(kfx, kfy, P.tF + P.kF, 5);
  s.capsule(hipX + .5, hipY, kfx, kfy, 1.7, 1.5, 'pants'); s.capsule(kfx, kfy, ffx, ffy - 1, 1.5, 1.6, 'boots'); s.capsule(ffx, ffy - .5, ffx + 2.2, ffy - .5, 1.1, 1.1, 'boots');
  // 头
  const hd = HEAD[P.head] || HEAD.side;
  s.rows(hd, HEADMAP, Math.round(neckX - 6), Math.round(neckY - 11));
  // 前臂 + 手里的东西
  const [efx, efy] = lp(sh[0] + 1, sh[1], P.aF, 4.5), [hfx, hfy] = lp(efx, efy, P.aF + P.eF, 4);
  if (P.sword === 'ready' || P.sword === 'down') {
    const ang = P.aF + P.eF + (P.sword === 'ready' ? -1.2 : .35), [tx, ty] = lp(hfx, hfy, ang, 11);
    s.capsule(hfx, hfy, tx, ty, 1, .5, 'blade');
    const [gx, gy] = lp(hfx, hfy, ang, 1.2), px_ = Math.cos(ang) * 2.2, py_ = -Math.sin(ang) * 2.2;
    s.capsule(gx - px_, gy - py_, gx + px_, gy + py_, .6, .6, 'hilt');
  }
  s.capsule(sh[0] + 1, sh[1], efx, efy, 1.45, 1.3, 'tunic'); s.capsule(efx, efy, hfx, hfy, 1.25, 1.3, 'skin');
  const spr = s.done();
  spr.hand = [Math.round(hfx), Math.round(hfy)]; spr.head = [Math.round(neckX), Math.round(neckY - 11)];
  return spr;
}

// —— 钥匙（受保护金；绕竖轴旋转：宽度 = |cos|，每 90° 8 帧量化）——
export function key(fb, cx, cy, ang, k = 1) {
  const q = Math.round(ang / (Math.PI / 2) * 8) / 8 * (Math.PI / 2), cs = Math.cos(q), sx = Math.abs(cs), back = cs < 0;
  const pts = [];   // [x,y,c] 以钥匙中心为原点的 13×7 设计
  const ring = ['.ooo.', 'oyYyo', 'oY.yo', 'oyyyo', '.ooo.'];
  const rows = [
    '.ooo.........',
    'oyYyo........',
    'oY.yoooooooo.',
    'oy.yyYYyyyyyo',
    'oyyyoooooyoyo',
    '.ooo.....o.o.',
    '.........ooo.',
  ];
  const map = { o: C.g3, y: C.g1, Y: C.g0 }, mapB = { o: C.g3, y: C.g2, Y: C.g1 };
  const w = rows[0].length, h = rows.length;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const ch = rows[j][i]; if (ch === '.') continue;
    const u = (i - (w - 1) / 2) * sx * (back ? -1 : 1);
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) fb.px(Math.round(cx + u * k) + a, Math.round(cy + (j - (h - 1) / 2) * k) + b, (back ? mapB : map)[ch]);
  }
  if (sx < .2) for (let j = 0; j < h * k; j++) fb.px(Math.round(cx), Math.round(cy - h * k / 2 + j), C.g2);
}
export function sparkle(fb, x, y, ph, col = C.gw, col2 = C.g0) {   // 4 帧闪光
  const k = mod(ph, 4); if (k === 3) return;
  fb.px(x, y, col); if (k === 0) return;
  const r = k === 1 ? 2 : 1; for (let i = 1; i <= r; i++) { fb.px(x - i, y, col2); fb.px(x + i, y, col2); fb.px(x, y - i, col2); fb.px(x, y + i, col2); }
}

// —— 宝箱怪（程序绘制；W 宽、Hb 箱体高、Hl 盖高；st 状态）——
// st: { open 0..1, mouth 张口像素, eyes:'none'|'mad'|'scared'|'shy'|'happy', tongue 0..1, tremble, key 是否叼着钥匙, look -1..1 }
export function chest(fb, cx, by, W, Hb, Hl, st = {}) {
  cx = Math.round(cx); by = Math.round(by);
  const big = W >= 40, x0 = cx - (W >> 1), x1 = x0 + W - 1;
  const mouth = Math.round(st.mouth || 0), bodyTop = by - Hb + 1;
  // 箱体：横向木板（左上光）
  const plank = big ? 6 : 4;
  for (let y = bodyTop; y <= by; y++) for (let x = x0; x <= x1; x++) {
    const ry = y - bodyTop, k = ry % plank;
    let c = k === 0 ? C.tan : k === plank - 1 ? C.dbrown : C.brown;
    if (x >= x1 - (big ? 3 : 1)) c = k === 0 ? C.brown : C.dbrown;                // 右侧背光面
    if (y === by) c = C.umber;
    if (big && (x * 7 + ry * 3) % 23 === 0 && k > 0 && k < plank - 1) c = C.clay;   // 木纹
    fb.px(x, y, c);
  }
  // 腮红索引（平时映射成木色）
  if (big) { for (const sx of [x0 + 9, x1 - 13]) { fb.rect(sx, bodyTop + 3, 5, 2, C.bl1); fb.rect(sx + 1, bodyTop + 4, 3, 1, C.bl2); } }
  else { fb.px(x0 + 3, bodyTop + 2, C.bl1); fb.px(x0 + 4, bodyTop + 2, C.bl1); fb.px(x1 - 4, bodyTop + 2, C.bl1); fb.px(x1 - 3, bodyTop + 2, C.bl1); }
  // 金边：竖带 + 底角
  const band = big ? 4 : 2;
  for (const bx of [x0 + (big ? 3 : 2), x1 - (big ? 6 : 3)]) for (let y = bodyTop; y <= by; y++) for (let i = 0; i < band; i++) fb.px(bx + i, y, i === 0 ? C.g1 : i === band - 1 ? C.g3 : C.g2);
  fb.hline(x0, x1, by, C.g3);
  // 嘴（开口：深色内腔 + 上下牙 + 眼 + 舌）
  const lidBottom = bodyTop - 1 - mouth;
  if (mouth > 0) {
    for (let y = lidBottom + 1; y < bodyTop; y++) for (let x = x0 + 1; x <= x1 - 1; x++) fb.px(x, y, (x < x0 + 3 || x > x1 - 3) ? C.umber : C.ink);
    const tw = big ? 6 : 3, th = Math.max(1, Math.round((big ? 4 : 2) * (st.teeth ?? 1)));
    for (let x = x0 + 2; x + tw <= x1 - 1; x += tw) for (let j = 0; j < th; j++) {
      const ww = Math.max(0, tw - 1 - Math.round(j * (tw - 1) / th));
      for (let i = 0; i < ww; i++) { fb.px(x + i + Math.round(j * .5), lidBottom + 1 + j, i === 0 ? C.silver : C.white); fb.px(x + i + Math.round(j * .5) + (tw >> 1), bodyTop - 1 - j, j === 0 ? C.silver : C.white); }
    }
    // 眼（k = 尺寸倍数）
    const k = W >= 64 ? 2 : 1;
    const ey = lidBottom + 1 + (big ? Math.max(th + 1, Math.round(mouth * .38)) : Math.max(1, Math.round(mouth * .4))), lk = Math.round((st.look || 0) * (big ? 2 * k : 1));
    const exL = cx - (big ? 9 * k + 2 : 4) + lk, exR = cx + (big ? 4 * k + 2 : 3) + lk;
    const e = st.eyes || 'none';
    const R = (x, y, w, h, c) => fb.rect(x, y, w, h, c);
    if (e === 'mad') for (const [ex, dir] of [[exL, 1], [exR, -1]]) {
      if (big) { const L = 5 * k; for (let i = 0; i < L; i++) { const yy = ey + Math.round((dir > 0 ? i : L - 1 - i) * .45); fb.px(ex + i, yy, C.yellow); fb.px(ex + i, yy + 1, C.yellow); if (k > 1) fb.px(ex + i, yy + 2, C.amber); } R(ex + (dir > 0 ? L - 3 : 1), ey + Math.round(L * .45) - 1 + 2, 2, 2, C.white); }
      else { fb.px(ex, ey, C.yellow); fb.px(ex + 1, ey, C.yellow); }
    }
    if (e === 'scared') for (const ex of [exL, exR]) {
      if (big) { R(ex, ey - 1, 4 * k + 1, 5 * k + 1, C.white); R(ex - 1, ey, 4 * k + 3, 5 * k - 1, C.white); R(ex + 2 * k - 1, ey + 2 * k - 1, k + 1, k + 1, C.ink); fb.px(ex + 1, ey, C.silver); fb.px(ex + 4 * k, ey + 5 * k, C.cyan); fb.px(ex + 4 * k, ey + 5 * k + 1, C.cyan); fb.px(ex + 4 * k - 1, ey + 5 * k + 2, C.blue); }
      else { fb.px(ex, ey, C.white); fb.px(ex + 1, ey, C.white); fb.px(ex, ey + 1, C.white); fb.px(ex + 1, ey + 1, C.ink); }
    }
    if (e === 'shy') for (const ex of [exL, exR]) {
      if (big) { const L = 4 * k + 1; fb.hline(ex, ex + L - 1, ey, C.white); fb.px(ex - 1, ey + 1, C.white); fb.px(ex + L, ey + 1, C.white); const px0 = ex + (lk < 0 ? 0 : L - 1 - (k + 1)); R(px0, ey + 1, k + 1, k + 1, C.white); R(px0, ey + 1 + Math.ceil(k / 2), k + 1, 1, C.ink); }
      else { fb.px(ex, ey, C.white); fb.px(ex + 1, ey, C.white); }
    }
    if (e === 'happy') for (const ex of [exL, exR]) {
      if (big) { const L = 2 * k + 1; for (let i = -L; i <= L; i++) { const yy = ey + Math.abs(i) * (k > 1 ? 1 : 1) - (k > 1 ? 0 : 0); fb.px(ex + L + i, yy, C.white); if (k > 1) fb.px(ex + L + i, yy + 1, C.white); } }
      else { fb.px(ex, ey + 1, C.white); fb.px(ex + 1, ey, C.white); fb.px(ex + 2, ey + 1, C.white); }
    }
    // 舌头（从下颌伸出、垂到箱体前）
    if (st.tongue > 0) {
      const L = Math.round(st.tongue * (big ? (W >= 64 ? 20 : 14) : 6)), tx = cx - (big ? 4 : 1) + Math.round(Math.sin((st.t || 0) * 9) * (big ? 1 : 0));
      for (let j = 0; j < L; j++) { const ww = big ? (j < L - 2 ? (W >= 64 ? 9 : 7) : (W >= 64 ? 7 : 5)) : 3; for (let i = 0; i < ww; i++) fb.px(tx + i - (j >= L - 2 && big ? -1 : 0), bodyTop - 2 + j, i === 0 ? C.crimson : i === ww - 1 ? C.crimson : (i === 2 && big) ? C.red : C.hot); }
    }
    // 叼着的钥匙
    if (st.key) key(fb, cx + (big ? 2 : 0), bodyTop - 2, 0, 1);
  }
  // 盖：拱形，上亮下暗；开口时整体上抬并略后仰（前脸变矮）
  const lh = Math.max(3, Math.round(Hl * (1 - .25 * (st.open || 0)))), ly1 = lidBottom, ly0 = ly1 - lh + 1;
  for (let y = ly0; y <= ly1; y++) {
    const v = (y - ly0) / Math.max(1, lh - 1), arch = Math.round((1 - Math.sqrt(Math.max(0, 1 - (1 - v) ** 2 * 1))) * (big ? 6 : 3) * (v < .5 ? 1 : 0));
    const ins = v < .35 ? Math.round((1 - v / .35) ** 2 * (big ? 5 : 2)) : 0;
    for (let x = x0 + ins; x <= x1 - ins; x++) {
      let c = v < .2 ? C.tan : v < .55 ? C.brown : C.dbrown;
      if (x >= x1 - ins - (big ? 3 : 1)) c = v < .3 ? C.brown : C.dbrown;
      if (bayer(x, y) < (v - .45) * 1.2) c = C.dbrown;
      if (y === ly1) c = C.umber;
      fb.px(x, y, c);
    }
    void arch;
  }
  // 盖上的金带 + 锁扣
  for (const bx of [x0 + (big ? 3 : 2), x1 - (big ? 6 : 3)]) for (let y = ly0 + 1; y <= ly1; y++) for (let i = 0; i < band; i++) fb.px(bx + i, y, i === 0 ? C.g1 : i === band - 1 ? C.g3 : C.g2);
  fb.hline(x0 + 1, x1 - 1, ly1, C.g3); fb.hline(x0 + 2, x1 - 2, ly1 - 1, C.g2);
  const lw = big ? 8 : 4, lhh = big ? 9 : 4, lx = cx - (lw >> 1), lyy = mouth > 0 ? ly1 - lhh : ly1 - (big ? 3 : 1);
  fb.rect(lx, lyy, lw, lhh, C.g2); fb.hline(lx, lx + lw - 1, lyy, C.g0); fb.vline(lx, lyy, lyy + lhh - 1, C.g1); fb.vline(lx + lw - 1, lyy, lyy + lhh - 1, C.g3); fb.hline(lx, lx + lw - 1, lyy + lhh - 1, C.g3);
  if (big) { fb.rect(cx - 1, lyy + 3, 2, 2, C.ink); fb.px(cx - 1, lyy + 5, C.ink); fb.px(cx, lyy + 5, C.ink); fb.px(cx - 1, lyy + 6, C.ink); }
  else { fb.px(cx - 1, lyy + 2, C.ink); }
  if (st.eyes === 'scared' && big) { const sx = x1 + 3, sy = ly0 + 2 + (Math.floor((st.t || 0) * 6) % 2); fb.px(sx, sy, C.white); fb.px(sx, sy + 1, C.cyan); fb.px(sx - 1, sy + 2, C.cyan); fb.px(sx, sy + 2, C.blue); fb.px(sx + 1, sy + 2, C.cyan); fb.px(sx, sy + 3, C.blue); }
  return { x0, x1, top: ly0, mouthY: lidBottom, bodyTop };
}
// 宝箱怪描边：在独立缓冲画好再加墨线
export function chestSprite(W, Hb, Hl, st) {
  const pad = 30, fb = new FB(W + 2 * pad, Hb + Hl + 60 + pad); fb.clear(T);
  const by = fb.h - 4, cx = fb.w >> 1;
  const info = chest(fb, cx, by, W, Hb, Hl, st);
  const out = new FB(fb.w, fb.h); out.d.set(fb.d);
  for (let y = 0; y < fb.h; y++) for (let x = 0; x < fb.w; x++) {
    if (fb.get(x, y) !== T) continue;
    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const c = fb.get(x + u, y + v); if (c !== T && c !== undefined && x + u >= 0 && y + v >= 0 && x + u < fb.w && y + v < fb.h) { out.d[y * fb.w + x] = C.ink; break; } }
  }
  return { w: out.w, h: out.h, d: out.d, ox: cx, oy: by, info };
}

// —— 32×32 头像：害羞的宝箱怪（3/4 近景）——
export function portraitMimic(st) {
  const fb = new FB(32, 32); fb.clear(T);
  const s = chestSprite(56, 26, 18, st), cy = Math.round((s.info.mouthY + s.info.bodyTop) / 2);
  fb.blit(s, 16 - s.ox, 15 - cy);
  return { w: 32, h: 32, d: fb.d };
}
// 小心形（受保护粉）
export const HEART = sprFromRows(['.kk.kk.', 'kpPkppk', 'kPppppk', 'kpppppk', '.kpppk.', '..kpk..', '...k...'], { k: C.ink, p: C.heart, P: C.gw });
// “！”气泡
export const BANG = sprFromRows(['.kkkkk.', 'kwwrwwk', 'kwwrwwk', 'kwwrwwk', 'kwwwwwk', 'kwwrwwk', '.kkkkk.', '..kk...', '..k....'], { k: C.ink, w: C.white, r: C.red });
