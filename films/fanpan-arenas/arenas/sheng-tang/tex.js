// 《彩窗圣堂》的大面贴图：地面、棋盘、马赛克镶边、地毯、墙、束柱、木头、台基。
// 每个函数返回一张 Plate（像素画布），由 arena.js 转成贴图。除了棋盘，全都能无缝平铺（按世界坐标铺，每米 48 像素）。
import { Plate, C, S, cloud, hash, PPM } from './paint.js';

// 地面：一米见方的大理石板，深浅两色交错，四角切掉嵌一颗深色小方块、中间一点黄铜。192 像素 = 4 米一个循环
export function floor() {
  const N = 192, T = 48;
  return new Plate(N, N).each((x, y) => {
    const tx = Math.floor(x / T), ty = Math.floor(y / T), u = x % T, v = y % T, du = Math.min(u, T - 1 - u), dv = Math.min(v, T - 1 - v), k = du + dv;
    const vein = cloud(x / 48, y / 48, 3, 4, 4, 4), fil = Math.abs(cloud(x / 24, y / 24, 9, 3, 8, 8) - .5);
    if (k < 9) {                                             // 四角的小嵌块（四块板的角拼成一个菱形）
      const cx = Math.round(x / T) % 4, cy = Math.round(y / T) % 4;
      if (k === 8) return [C.night, 1, 0];
      if (k < 2) return [C.brass, 3.2 + hash(cx, cy, 5), .4];
      return [(cx + cy) & 1 ? C.wine : C.basalt, 2.6 + (vein - .5) * 2.4 + (k === 7 ? (u < T / 2 ? .6 : -.6) : 0), .7];
    }
    if (du === 0 || dv === 0) return [C.night, 1.4, .3];     // 板缝
    let L = 2.75 + (vein - .5) * 3.4 + hash(tx, ty, 2) * .8;
    if (fil < .016) L += 1.1;                                // 大理石的白筋
    if (fil > .46) L -= .8;                                  // 和几道暗纹
    if (u === 1 || v === 1) L += .7; else if (u === T - 2 || v === T - 2) L -= .7;   // 板边的倒角：左上亮、右下暗
    return [(tx + ty) & 1 ? C.marble : C.stone, L, .8];
  });
}

// 整张棋盘：深色大理石嵌拼，每格一圈细金线，中间暗暗地嵌一朵四叶；本方出兵列偏青蓝、对面出兵列偏红。之后按格切成 20 小张
export function board(G) {
  const cw = Math.round(G.LX * PPM), ch = Math.round(G.LZ * PPM), m = Math.min(cw, ch);
  const leaf = S.any(S.foils(cw / 2, ch / 2, m * .17, 4, m * .15, Math.PI / 4), S.disc(cw / 2, ch / 2, m * .13));
  return new Plate(cw * G.ROWS, ch * G.COLS).each((x, y) => {
    const r = Math.floor(x / cw), c = Math.floor(y / ch), u = x - r * cw, v = y - c * ch, du = Math.min(u, cw - 1 - u), dv = Math.min(v, ch - 1 - v), e = Math.min(du, dv);
    const own = r === 0, foe = r === G.ROWS - 1, rp = own ? C.ownTile : foe ? C.foeTile : (r + c) & 1 ? C.slate : C.slateB;
    if (e < 1) return [C.night, .5, 0];                      // 最外一圈是勾缝色；每格左上角那颗像素也是它（格子的四个侧面采样的就是这颗）
    if (e === 1) return [C.night, 1.6, .3];
    if (e === 2) return [C.gold, 2.5 + hash(x, y, 1) * 1.1 + (u === 2 || v === 2 ? .7 : -.4), .5];       // 细金线
    if (e === 3) return [rp, 1.5, .4];
    const vein = cloud(x / 30, y / 30, 21 + r * 7 + c * 13, 3), fil = Math.abs(cloud(x / 17, y / 17, 40 + r + c * 5, 3) - .5);
    let L = (own || foe ? 2.85 : 3.3) + (vein - .5) * 2.4;
    if (fil < .013) L += 1.1;
    if (du + dv < 13) return [own ? C.royal : foe ? C.wine : C.night, du + dv === 12 ? 1.2 : 2.3 + (vein - .5) * 2, .6];   // 四角的三角嵌块
    const d = leaf(u + .5, v + .5);
    if (Math.abs(d) < .75) L += .9; else if (d < 0) L -= .75;   // 四叶：一道稍亮的线，里面暗半级
    return [rp, L, .8];
  });
}

// 马赛克镶边：三像素一颗的小方瓷片。两条金边夹一条深蓝底，中间一串红 / 蓝 / 绿的菱形。96×24，沿长边循环
export function mosaic() {
  const JEWEL = [C.ruby, C.sapphire, C.emerald, C.amber];
  return new Plate(96, 24).each((x, y) => {
    if (x % 3 === 0 || y % 3 === 0) return [C.night, 1.2, 0];
    const t = Math.floor(x / 3), r = Math.floor(y / 3), j = hash(t, r, 4), d = Math.abs((t % 8) - 3.5) + Math.abs(r - 3.5);
    if (r === 0 || r === 7) return [C.gold, 2.6 + j * 1.6, .5];
    if (r === 1 || r === 6) return [C.basalt, 2.4 + j * 1.2, .5];
    if (d < 1.6) return [JEWEL[Math.floor(t / 8) % 4], 2.6 + j * 1.5, .5];
    if (d < 2.6) return [C.gold, 2.4 + j * 1.6, .5];
    return [C.royal, 1.6 + j * 1.3, .5];
  });
}

// 地毯：main 是毯面的色阶、dark 是暗纹的色阶。两条金边、里面一格格的菱形暗纹和小金花。横向 96 像素（2 米宽），纵向 48 像素一个循环
export function carpet(main = C.crimson, dark = C.wine) {
  return new Plate(96, 48).each((x, y) => {
    const e = Math.min(x, 95 - x), w = ((x + y) & 1) * .35 + hash(x, y, 6) * .5 - .4;   // w：织物的颗粒
    if (e < 2) return [C.brass, 2 + w + (y % 4 < 2 ? 1 : 0), .5];                        // 流苏边
    if (e < 9) { const z = Math.abs(((y + (e - 2) * 2) % 12) - 6); return z < 2 ? [dark, 2.2 + w, .5] : [C.gold, 2.3 + w + (e === 5 ? .8 : 0), .5]; }   // 金边上一串斜纹
    if (e < 11) return [dark, 1.6 + w, .5];
    const u = (x - 48 + 480) % 24 - 12, v = y % 24 - 12, d = Math.abs(u) + Math.abs(v);
    if (d < 2) return [C.gold, 3 + w, .5];
    if (d > 9 && d < 11.5) return [dark, 2.6 + w, .5];
    return [main, 2.45 + w + (d < 6 ? .35 : 0), .6];
  });
}

// 墙：一层层的方石，隔层错半块；每块的明暗略有不同，上沿亮、下沿暗，还有水渍。192×192
export function wall() {
  return new Plate(192, 192).each((x, y) => {
    const row = Math.floor(y / 24), xx = (x + (row & 1) * 24) % 192, col = Math.floor(xx / 48), u = xx % 48, v = y % 24;
    if (u === 0 || v === 0) return [C.night, 1.5, .3];
    let L = 2.5 + hash(col, row, 3) * 1.2 + (cloud(x / 48, y / 48, 12, 3, 4, 4) - .5) * 2.6;
    if (v === 1 || u === 1) L += .8; else if (v === 23 || u === 47) L -= .8;
    if (hash(x, y, 8) > .965) L -= .9;                       // 石头上的小坑
    return [hash(col, row, 5) > .7 ? C.stone : C.stoneDk, L, .8];
  });
}

// 束柱：一圈细柱并在一起（每 12 像素一根，圆的明暗），每两米一道箍。48×96，绕柱一圈铺两遍
export function pier() {
  return new Plate(48, 96).each((x, y) => {
    const u = (x % 12 + .5) / 12 * 2 - 1, band = y < 5;
    let L = 3 + 1.9 * (-.6 * u + .55 * Math.sqrt(1 - u * u) - .32) + (cloud(x / 24, y / 24, 5, 2, 2, 4) - .5) * 1.2;
    if (band) L += y === 0 ? 1.2 : y === 4 ? -1.4 : .5;
    if (Math.abs(u) > .86 && !band) L = 1.2;                 // 细柱之间的深缝
    return [band ? C.marble : C.stone, L, .7];
  });
}

// 木头：横向的橡木板，每 12 像素一条，有木纹和几个节疤。96×48
export function wood() {
  return new Plate(96, 48).each((x, y) => {
    const row = Math.floor(y / 12), v = y % 12, g = cloud((x + row * 37) / 30, y / 3.2, 14 + row, 2, 0, 15);
    let L = 2.7 + (g - .5) * 2.6 + hash(row, 0, 2) * .6;
    if (v === 0) L = 1; else if (v === 1) L += .7; else if (v === 11) L -= .6;
    if ((x + row * 29) % 96 === 0) L = 1.2;                  // 板头的接缝
    const kx = (x - 20 - row * 31 + 960) % 96, kd = Math.hypot(kx - 6, (v - 6) * 1.6);
    if (kd < 3 && row % 2 === 0) L -= 1.4 - kd * .3;
    return [C.oak, L, .7];
  });
}

// 台基 / 祭坛 / 墩座用的浅色大理石：大块的石料，两米一道缝，带筋。96×96
export function slab() {
  return new Plate(96, 96).each((x, y) => {
    const v = y % 48, u = (x + (Math.floor(y / 48) & 1) * 48) % 96, vein = cloud(x / 32, y / 32, 30, 4, 3, 3), fil = Math.abs(cloud(x / 19, y / 19, 33, 3, 5, 5) - .5);
    if (u === 0 || v === 0) return [C.stoneDk, 1.6, .3];
    let L = 3 + (vein - .5) * 3;
    if (fil < .02) L += 1; if (v === 1) L += .8; else if (v === 47) L -= .8;
    return [C.marble, L, .8];
  });
}

// 屋面（本方小龛的坡顶）：一排排圆头的釉瓦，隔排错半片；深蓝的底，每隔三排夹一排青瓦。血量牌就挂在屋脊前面，所以花样要素、明暗差要小。48×64
export function roof() {
  return new Plate(48, 64).each((x, y) => {
    const row = Math.floor(y / 8), v = y % 8, xs = x + (row & 1) * 6, u = xs % 12, ci = Math.floor(xs / 12) % 4;
    const r = v > 2 ? Math.hypot(u - 5.5, v - 2) : Math.abs(u - 5.5);
    if (r > 5.9 || (u === 0 && v <= 2)) return [C.night, 1.7, .3];                       // 瓦和瓦之间的缝、圆头外面露出的暗处
    const L = 2.3 + hash(ci, row, 9) * .7 - (u > 6 ? .35 : 0) + (v === 0 ? -.7 : v === 1 ? .4 : 0) + (r > 4.7 ? -.6 : 0);
    return [row % 4 === 3 ? C.tealCloth : C.royal, L, .6];
  });
}

// 台基顶面的拼花地砖：斜铺的小方砖，深浅两色相间，隔一块浅砖嵌一颗酒红的小菱形。96×96
export function pave() {
  return new Plate(96, 96).each((x, y) => {
    const a = x + y, b = x - y + 960, ia = Math.floor(a / 24), ib = Math.floor(b / 24), fa = a % 24, fb = b % 24, e = Math.min(fa, 23 - fa, fb, 23 - fb);
    if (e < 1) return [C.night, 1.3, .3];
    const dark = (ia + ib) & 1, vein = cloud(x / 24, y / 24, 61, 3, 4, 4);
    if (!dark && (ia - ib + 400) % 4 === 0 && Math.abs(fa - 11.5) + Math.abs(fb - 11.5) < 5) return [C.wine, 2.7 + (vein - .5) * 1.5, .6];
    return [dark ? C.basalt : C.stoneDk, (dark ? 2.3 : 2.7) + (vein - .5) * 2.2 + (e === 1 ? (fa === 1 || fb === 1 ? .6 : -.5) : 0), .8];
  });
}
