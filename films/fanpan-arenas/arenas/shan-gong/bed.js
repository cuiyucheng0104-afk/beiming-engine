// 《珊瑚龙宫》· 大面积的材质贴图：海床沙、礁石、宫殿石料、雕花带、螺钿盘面和石沿、焦散光纹、砗磲壳、鮟鱇头骨、发光珠。
// 全部用 tide.js 的胶片逐像素算出来。能平铺的贴图都用带周期的噪声，接缝对得上。
import { PPM, mk, Cel, K, hx, wave, swell, cells, dice, rgbOf } from './tide.js';

// 浮雕：按一张「高度函数」给已经落笔的像素加明暗（上面和左面来光：朝上、朝左的坡亮，朝下、朝右的坡暗）
export function carve(cel, H, k = 1) {
  return cel.tint((x, y, m, v) => [m, v + k * ((H(x, y + 1) - H(x, y - 1)) * -.7 + (H(x + 1, y) - H(x - 1, y)) * -.4)]);
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 海床：被水流梳出来的沙纹（弯的横纹）+ 大块明暗 + 散的小石子、贝壳屑、珊瑚渣
export function sandTex() {
  const N = 192, c = new Cel(N, N), R = dice(11);
  const H = (x, y) => { const u = x / N, v = y / N; return Math.sin((v * 12 + swell(u * 6, v * 6, 3, 6) * 2.4 + Math.sin(u * Math.PI * 2) * .35) * Math.PI * 2) * .55 + swell(u * 12, v * 12, 9, 12) * 1.5; };
  c.each((x, y) => [K.sand, 1.45 + swell(x / N * 8, y / N * 8, 21, 8) * 1.5 + (hx(x, y, 4) - .5) * .55]);
  carve(c, H, 1.5);
  for (let i = 0; i < 54; i++) { const x = R.int(4, N - 5), y = R.int(4, N - 5), r = R.in(.9, 2.7); c.orb(x, y, r, r * .8, R.pick([K.reef, K.reef, K.stone, K.pearl, K.pink, K.teal, K.orange]), { lo: 1, hi: 4.2 }); }
  return c.bake();
}
// 礁石：一块块棱面（碎片格），棱缝暗，面上有珊瑚虫的彩色小点
export function rockTex() {
  const N = 96, c = new Cel(N, N), R = dice(5);
  c.each((x, y) => { const f = cells(x / N * 6, y / N * 6, 5, 6), e = f[1] - f[0]; return [K.reef, e < .07 ? .5 : 1.3 + f[2] * 1.7 + e * 1.3 - f[0] * .9 + (hx(x, y, 8) - .5) * .5]; });
  for (let i = 0; i < 26; i++) { const x = R.int(2, N - 3), y = R.int(2, N - 3), m = R.pick([K.pink, K.teal, K.violet, K.orange]); c.put(x, y, m, 3.6); if (R() < .5) c.put(x + 1, y, m, 2.6); if (R() < .5) c.put(x, y + 1, m, 2.2); }
  return c.bake();
}
// 宫殿石料：错缝砌的条石，每块上亮下暗，缝是深蓝；石面上挂一点绿藻
export function wallTex() {
  const N = 96, c = new Cel(N, N);
  c.each((x, y) => {
    const row = Math.floor(y / 24), sx = x + (row & 1) * 24, bx = sx % 48, by = y % 24, id = hx(Math.floor(sx / 48) % 2, row, 3);
    if (bx === 0 || by === 0) return [K.grout, 1.4];
    let lv = 2 + id * .9 + (swell(x / N * 8, y / N * 8, 31, 8) - .5) * 1.5 + (hx(x, y, 2) - .5) * .3;
    if (bx === 1 || by === 1) lv += .9; if (bx === 47 || by === 23) lv -= .9;
    if (swell(x / N * 6, y / N * 6, 44, 6) > .64 && by < 12) return [K.kelp, lv - .4];
    return [K.stone, lv];
  });
  return c.bake();
}
// 柱身：竖的凹槽，一圈正好 8 道
export function fluteTex() {
  const W = 96, Ht = 48, c = new Cel(W, Ht);
  c.each((x, y) => { const f = (x % 12) / 12; return [K.stone, 2 + Math.sin(f * Math.PI) * 1.7 + (swell(x / W * 6, y / Ht * 3, 61, 6) - .5) * 1.2 - (y % 24 === 0 ? 1.4 : 0)]; });
  return c.bake();
}
// 雕花带：一排卷浪纹（圆环 + 中心珠 + 底下的连线），上下各一道线脚。给台基侧面、门楣用
export function friezeTex() {
  const W = 96, Ht = 48, c = new Cel(W, Ht);
  const H = (x, y) => {
    const px = ((x % 24) + 24) % 24, dx = px - 12, dy = y - 24, d = Math.hypot(dx, dy);
    let h = Math.max(1 - Math.abs(d - 8) / 2, 1.2 - d / 3, 1 - Math.abs(dy - 8 + Math.cos(px / 24 * Math.PI * 2) * 4) / 1.6, 0);
    if (y < 7 || y >= Ht - 7) h = Math.max(h, 1 - Math.abs((y < 7 ? y : Ht - 1 - y) - 3) / 3);
    return Math.max(0, Math.min(1, h)) * 2.2;
  };
  c.each((x, y) => [K.stone, 1.7 + Math.min(1, H(x, y)) * .9 + (swell(x / W * 8, y / Ht * 4, 71, 8) - .5) * .8]);
  carve(c, H, 1.2);
  return c.bake();
}

// 盘面：整盘画一张，再按 (r, c) 切成 20 小张。
//   每格 = 一圈深蓝勾缝 + 一道细嵌线 + 里面的螺钿碎片（碎片格，片与片之间是暗缝），片上有一道斜着的虹彩，中心一朵很淡的贝纹。
//   本方出兵列用青色的两条色带、对面出兵列用紫红的两条，中间三列用三条中性的蓝紫。整体压在色带的 1–3 级，比棋子暗。
//   同一张大图外面再套一圈雕花石沿（RP 像素宽），铺在格子下面：格子之间的缝里露出来的是它的勾缝色。
export function boardArt({ ROWS, COLS, LX, LZ }) {
  const TW = Math.round(LX * PPM), TH = Math.round(LZ * PPM), RP = 18, W = ROWS * TW + RP * 2, Ht = COLS * TH + RP * 2, c = new Cel(W, Ht);
  const tones = r => r === 0 ? [K.oA, K.oB, K.oA] : r === ROWS - 1 ? [K.fA, K.fB, K.fA] : [K.nA, K.nB, K.nC];
  c.each((X, Y) => {
    const x = X - RP, y = Y - RP;
    if (x >= 0 && y >= 0 && x < ROWS * TW && y < COLS * TH) {                 // —— 格子 ——
      const r = Math.floor(x / TW), q = Math.floor(y / TH), tx = x % TW, ty = y % TH, e = Math.min(tx, ty, TW - 1 - tx, TH - 1 - ty), T = tones(r);
      if (e < 1) return [K.grout, 1.5];
      if (e === 2) return [T[0], 2.9 + ((tx + ty) % 6 < 3 ? .5 : 0)];             // 细嵌线
      if (e < 4) return [K.grout, 2.2];
      const f = cells(x / 8.5, y / 8.5, 17), gap = f[1] - f[0], id = f[2];
      if (gap < .09) return [K.grout, 2];
      const cx = tx - TW / 2, cy = ty - TH / 2, d = Math.hypot(cx, cy), a = Math.atan2(cy, cx);
      let lv = 1.8 + id * 1.1 + Math.sin((x + y) * .21 + id * 9) * .32 + ((r + q) & 1 ? .22 : 0);
      const petal = d < 11 + Math.cos(a * 6) * 2.5 && d > 4; if (petal) lv += .55; if (d < 2.5) lv += 1;
      return [T[Math.floor(id * 2.999)], lv];
    }
    // —— 石沿 ——：沿着边走的坐标 s 和离盘面的距离 d
    const dxo = x < 0 ? -x : x >= ROWS * TW ? x - ROWS * TW + 1 : 0, dyo = y < 0 ? -y : y >= COLS * TH ? y - COLS * TH + 1 : 0, d = Math.max(dxo, dyo);
    if (d <= 1) return [K.grout, 1.2];
    const s = dxo >= dyo ? y + 1000 : x + 1000, ph = s % 16, corner = dxo > 3 && dyo > 3;
    if (d >= RP - 1) return [K.slab, 1];
    if (d === 2 || d === RP - 2) return [K.stone, 3.6];
    if (d === 3 || d === RP - 3) return [K.slab, 1.3];
    if (corner) { const r2 = Math.hypot(dxo - RP / 2, dyo - RP / 2); return r2 < 2.5 ? [K.pearl, 4.6 - r2 * .5] : r2 < 5 ? [K.slab, 1.4] : [K.stone, 2.4 + (Math.atan2(dyo - RP / 2, dxo - RP / 2) * 4 / Math.PI % 1 + 1) % 1 * 1.2]; }
    const k = Math.hypot(ph - 8, d - RP / 2);                                    // 每 16 像素一朵扇贝纹，贝心嵌一颗小珍珠
    if (k < 1.6) return [K.pearl, 4.4 - k * .5];
    if (k < 3) return [K.slab, 1.2];
    const arc = Math.abs(Math.hypot(ph - 8, d - RP + 3) - 6.5);
    return [K.stone, 2.1 + (arc < 1 ? 1.2 : arc < 2 ? -.6 : 0) + (hx(X, Y, 6) - .5) * .5];
  });
  const whole = c.bake(), tiles = [];
  for (let r = 0; r < ROWS; r++) for (let q = 0; q < COLS; q++) { const t = mk(TW, TH); t.getContext('2d').drawImage(whole, -(RP + r * TW), -(RP + q * TH)); tiles.push({ r, c: q, cv: t }); }
  // 石沿那张图里，格子的位置整片涂成勾缝色（格子自己盖在上面，只有缝里看得见它）
  const g = whole.getContext('2d'), gc = rgbOf(K.grout, 1); g.fillStyle = `rgb(${gc[0]},${gc[1]},${gc[2]})`; g.fillRect(RP, RP, ROWS * TW, COLS * TH);
  return { tiles, frame: whole, rim: RP / PPM };
}

// 焦散：水面波纹聚出来的亮线网。碎片格的「次近 − 最近」在片与片的交界处趋近 0，取反就是一张亮线网；坐标先被噪声揉一下才不呆板。
// 直接出成黑底彩线（加色叠上去），两张不同种子的图反向流动、相乘似地叠在一起就会闪。
export function causticTex(seed, tint) {
  const N = 128, c = mk(N, N), g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data;
  for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i += 4) {
    const u = x / N * 5 + (swell(x / N * 4, y / N * 4, seed + 3, 4) - .5) * 1.1, v = y / N * 5 + (swell(x / N * 4, y / N * 4, seed + 9, 4) - .5) * 1.1, f = cells(u, v, seed, 5);
    const b = Math.pow(1 - smooth(0, .34, f[1] - f[0]), 2.4) * (.6 + wave(x / N * 3, y / N * 3, seed + 5, 3) * .7);
    d[i] = Math.min(255, tint[0] * b); d[i + 1] = Math.min(255, tint[1] * b); d[i + 2] = Math.min(255, tint[2] * b); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}

// 砗磲壳：一片扇形的壳，u 是绕铰合处的角度（−A…A，N 道大褶），v 从铰合处到壳口。arena.js 里壳的曲面用同一组 A、N，褶才对得上。
//   inner = 里面：珍珠层（青白底，带粉紫虹彩的环带），壳口一圈是砗磲那层发青的外套膜，上面一颗颗亮斑；外面：粗糙的青灰壳，长着藤壶和绿藻
export const SHELL = { A: 1.15, N: 11 };
export function shellTex(inner) {
  const W = 264, Ht = 96, c = new Cel(W, Ht);
  c.each((x, y) => {
    const u = x / W, v = y / Ht, fold = Math.cos((u * 2 - 1) * SHELL.A * SHELL.N), ring = Math.sin(v * 40 + swell(u * 8, v * 3, 51) * 5);
    if (inner) {
      if (v > .965) return [K.pearl, 3.6 + fold * .8];
      if (v > .86) return [hx(Math.floor(x / 3), Math.floor(y / 3), 1) > .78 ? K.cyan : K.teal, 2.5 + fold * .9 + (hx(Math.floor(x / 3), Math.floor(y / 3), 1) > .78 ? 1.6 : 0)];
      if (v > .8) return [K.violet, 2.2 + fold * .7];
      const band = Math.sin(v * 11 + swell(u * 5, v * 2, 53) * 4);
      const rib = fold > .2 ? 1 : fold < -.55 ? -1 : 0;                              // 褶的脊亮、沟暗，一道一道分明
      return [rib < 0 ? K.shell : band > .72 ? K.violet : K.nacre, (rib < 0 ? 2.5 : band > .72 ? 2.6 : 2.2) + v * .7 + rib * .7 + ring * .2];
    }
    if (hx(Math.floor(x / 3), Math.floor(y / 3), 57) > .93) return [K.white, 2.5 + hx(x, y, 2) * 1.4];   // 藤壶
    return [swell(u * 9, v * 4, 55) > .62 ? K.kelp : K.shell, 1.8 + (fold > .2 ? 1.1 : fold < -.55 ? -1 : 0) + ring * .5 + v * .8];
  });
  return c.bake();
}
// 外套膜：壳里那层软肉，青紫相间的波纹和亮斑
export function mantleTex() {
  const N = 64, c = new Cel(N, N);
  c.each((x, y) => { const s = Math.sin((y / N * 5 + swell(x / N * 4, y / N * 4, 81, 4) * 1.6) * Math.PI * 2); return [s > .3 ? K.teal : s < -.4 ? K.violet : K.oB, 2.2 + s * .9 + (hx(Math.floor(x / 2), Math.floor(y / 2), 83) > .9 ? 1.6 : 0)]; });
  return c.bake();
}
// 鮟鱇头骨：包在一颗压扁的球上。u = 0 是正前（朝棋盘），u = .25 朝镜头。朝镜头那一侧挖一个大眼窝，前面两个鼻孔，头顶一道骨缝，到处是裂纹
export function skullTex() {
  const W = 384, Ht = 96, c = new Cel(W, Ht);
  c.each((x, y) => {
    const u = x / W, v = y / Ht, eye = Math.hypot((u - .19) * 3.4, (v - .34) * 1.25), eye2 = Math.hypot((u - .81) * 3.4, (v - .34) * 1.25);
    const e = Math.min(eye, eye2); if (e < .17) return [K.grout, .6 + e * 3]; if (e < .21) return [K.bone, 1.2];
    const nose = Math.min(Math.hypot((u - .04) * 6, (v - .4) * 2), Math.hypot((u - .96) * 6, (v - .4) * 2)); if (nose < .1) return [K.grout, 1];
    const f = cells(u * 14, v * 4, 91, 14), crack = f[1] - f[0] < .035, seam = Math.abs(v - .16 - Math.sin(u * 60) * .02) < .012;
    return [K.bone, crack || seam ? 1 : 2.3 + (1 - v) * 1.5 + (swell(u * 12, v * 4, 93, 12) - .5) * 1.5 + (e < .3 ? .9 : 0)];
  });
  return c.bake();
}
// 骨头（牙、诱灯的竿）：竖向的纹理，根部暗
export function boneTex() {
  const W = 24, Ht = 48, c = new Cel(W, Ht);
  c.each((x, y) => [K.bone, 2.4 + Math.sin(x / W * Math.PI) * 1.3 + (hx(x, Math.floor(y / 3), 95) - .5) * .8 + (y / Ht - .5) * -1.2]);
  return c.bake();
}
// 发光珠（大珍珠、诱灯）：包在球上，上亮下暗，带几道晕圈和一块高光
export function orbTex(m, W = 48) {
  const Ht = W / 2, c = new Cel(W, Ht);
  c.each((x, y) => { const v = y / Ht, hl = Math.hypot(((x / W - .2 + 1) % 1) * 4 - .2, (v - .3) * 2.4); return [m, hl < .3 ? 5 : 4.4 - v * 2.2 + Math.sin(v * 16 + swell(x / W * 6, v * 3, 97, 6) * 3) * .35]; });
  return c.bake();
}
// 一块几乎全黑的暗红（头骨嘴里、壳的深处）
export function pitTex(m) { const c = new Cel(16, 16); c.each((x, y) => [m, .2 + hx(x, y, 99) * .9]); return c.bake(); }
// 台基侧面的线脚：上面一道亮线，中间一排珍珠，下面一道暗槽。高 16 像素，正好是一级台阶
export function trimTex() {
  const W = 48, Ht = 16, c = new Cel(W, Ht);
  c.each((x, y) => {
    if (y < 2) return [K.stone, 4.2 - y * .6]; if (y === 2) return [K.slab, 1.2]; if (y >= Ht - 2) return [K.slab, y === Ht - 1 ? .8 : 1.6];
    const px = x % 8, d = Math.hypot(px - 3.5, y - 8), w = Math.abs(y - 8 - Math.sin(x / 48 * Math.PI * 4) * 3);
    if (d < 2.2) return [K.pearl, 4.6 - d * .9 - (y > 8 ? .8 : 0)];
    return [K.stone, 2.2 + (w < 1 ? .9 : 0) + (hx(x, y, 12) - .5) * .5 - (y > 10 ? .5 : 0)];
  });
  return c.bake();
}
// 铺地：下层台基顶面的大方砖，砖角嵌一小块螺钿
export function paveTex() {
  const N = 96, c = new Cel(N, N);
  c.each((x, y) => {
    const tx = x % 48, ty = y % 48, e = Math.min(tx, ty, 47 - tx, 47 - ty), id = hx(Math.floor(x / 48), Math.floor(y / 48), 21);
    if (e < 1) return [K.grout, 1.6];
    if (Math.abs(tx - 24) + Math.abs(ty - 24) < 5) return [K.nacre, 1.8 + ((tx + ty) & 1)];
    return [K.slab, 2 + id * .7 + (e < 2 ? (tx < 2 || ty < 2 ? .9 : -.7) : 0) + (swell(x / N * 8, y / N * 8, 23, 8) - .5) * 1.3 + (hx(x, y, 22) - .5) * .3];
  });
  return c.bake();
}
