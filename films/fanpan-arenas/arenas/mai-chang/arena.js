// 《丰收麦场》· 秋天村庄的丰收节之夜，接进对战盘（board3d.js 的「自定义擂台」接口，地址带 ?arena=harvest 时用）。
// 这个文件夹自成一套：画法在 paint.js（暮色色带、斜纹抖动、背光金边），能平铺的材料和大图在 mat.js，小件在 props.js；
// 全部逐像素算出来，没有外部图片，也不和 arenas/ 下别的文件夹共用任何东西。
// 场面：村子打麦场中央的一块旧石板场地。左边是本方的水车磨坊（青瓦顶，木水车在转，水槽的水往下流），
// 右边是对面的红漆谷仓（大门敞着透出暖光，门口一只刻了脸的大南瓜灯）；场地后面是篝火、长桌、酒桶，再往后是麦田、枫树、农舍和夜空。
// 棋盘规则、棋子、格子的点击、城堡血量牌都还是游戏自己的；这里只管「看起来是什么地方」：
//   · 实体    石台、磨坊、谷仓、摊子、板车、草捆、水井……用「面片机」一片片拼，一种贴图一张网格
//   · 像素片  一百多种小件拼成一张图集；不动的按「受光并投影 / 受光 / 自发光」三层各拼一张网格，会动的预留缓冲每帧重写
//   · 光      靛蓝的冷环境光 + 从后方低低斜过来的橙色月光（给所有东西的顶上勾一道金边、往镜头这边拉长影子）
//             + 篝火、谷仓、南瓜灯、串灯的暖光（地上一摊摊光晕）+ 磨坊的一盏青灯
//   · 会动的  麦浪、水车和流水、篝火和火星、串灯逐个明灭、彩旗、落叶、南瓜灯烛光、稻草人、烟花、萤火虫、炊烟、乌鸦、风向鸡、队旗、母鸡
// build(ctx) 只调一次，返回 { tick(t, dt) }：t 是场景自己的钟（秒），游戏每帧调一次（「减少动态效果」时不调）。
// 坐标：x 向右（本方 → 对面），z 朝镜头，y 向上。场景自己的东西都放在组 W 里：W 里 y = 0 是地面（比格子的底低 0.12 米）。
import { C, PPM, rnd2, clamp } from './paint.js';
import * as MT from './mat.js';
import { sprites, halo } from './props.js';

const G0 = -.12;                                              // 地面比盘面（格子的底）低多少：打麦场是一块略高出地面的石板台
// 调画面只改这一组数。游戏不做胶片曲线、棋子不吃光（永远是贴图原色），所以四周压暗、往靛蓝里偏，棋子是画面里最亮的东西
const LOOK = {
  bg: '#090720', fog: '#1c1548',
  amb: ['#5a62d8', 1.55], sun: ['#ffa85c', 3.6], fill: ['#7468e0', .55],
  glow: { hi: 1.6, mid: 1.2, lo: .85 },                       // 自发光片的亮度（高画质档超过 1 的部分会晕开）
  halo: .8, lamp: 1,
  bloom: [.5, .72, .86],                                      // 强度、半径、亮过多少才发光
  tilt: { focus: .45, band: .27, amt: 2 },                    // 移轴：清楚的一带压在棋盘上
  tiltShort: { focus: .54, band: .3, amt: 2 },                // 手机横屏：棋盘占了大半个画面、血量牌挂在上面，清楚的一带要宽得多
  grade: { sat: 1.22, con: 1.08, knee: .82, gain: [1.05, .99, .97], lift: [.01, .006, .034], edge: [-.03, -.035, -.012] },
};
const SUN_FROM = [-4, 6.4, -11];                              // 主光从后方偏左、低低地来
const TAU = Math.PI * 2;
const rr = (i, k = 0) => rnd2(i, k, 4242);                    // 确定性随机
const flick = (i, t) => 1 + .13 * Math.sin(t * 9.3 + i * 2.1) + .08 * Math.sin(t * 21.7 + i * 4.7) + .05 * Math.sin(t * 33.1 + i);
const frac = v => v - Math.floor(v);
const unit = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const CARDN = unit([0, 1, .28]), UPV = [0, 1, 0], WHITE = [1, 1, 1], NO = {};
// 顶点色（线性空间）：各种灯火的颜色
const WARM = [1, .62, .24], FIRE = [1, .42, .1], GOLD = [1, .78, .36], TEAL = [.22, 1, .86], RED = [1, .2, .14], VIOLET = [.7, .36, 1], CREAM = [1, .88, .62], SMOKE = [.42, .42, .62];
const BULBC = [GOLD, FIRE, RED, TEAL, CREAM], FLYC = [.75, 1, .3];

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, grid } = ctx;
  const { ROWS, COLS, LX, LZ, HALF: HX, DEPTH, tileZ } = grid, HZ = DEPTH / 2;
  const B = d => -HZ - d, F = d => HZ + d, TY = -G0, GATE = HX + 1.3;       // B(d)：盘面后沿再往后 d 米；F(d)：前沿再往前；TY：W 里盘面底的高度
  const W = new THREE.Group(); W.position.y = G0; scene.add(W);
  const GK = low ? { hi: 1.15, mid: 1, lo: .8 } : LOOK.glow;

  // —— 贴图 ——
  const texOf = new Map();
  const tx = c => { let t = texOf.get(c); if (!t) { t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; texOf.set(c, t); } return t; };
  const T = {
    stone: MT.fieldstone(), stoneW: MT.fieldstone({ seed: 9, band: C.warmStone, alt: C.stone, moss: .06 }), ashlar: MT.ashlar(), pave: MT.pave(), packed: MT.packed(),
    wood: MT.planks(), woodH: MT.planks({ vertical: false, band: C.old, seed: 5, joint: true, lv: 3 }), dark: MT.planks({ band: C.dark, seed: 8, lv: 2.5 }), barn: MT.planks({ band: C.barn, seed: 11, lv: 3 }),
    timber: MT.timber(), cream: MT.paint(), bark: MT.bark(), rings: MT.rings(), cask: MT.cask(), crate: MT.crate(), pantile: MT.pantile(), shingle: MT.shingle(),
    hay: MT.hay(), hayEnd: MT.hayEnd(), awnO: MT.stripes(), awnP: MT.stripes({ a: C.purple, b: C.cream, seed: 5 }), awnR: MT.stripes({ a: C.mapleR, b: C.mapleY, seed: 7 }), cloth: MT.gingham(),
    water: MT.water(), iron: MT.iron(), rope: MT.rope(),
  };

  // —— 面片机：所有实体都拆成四边形和三角形，按贴图收成一堆，最后一种贴图拼成一张网格。贴图按真实尺寸铺（每米 48 像素），顶边对齐 ——
  function Mason(parent) {
    const bins = new Map(); let S = { c: 1, s: 0, x: 0, y: 0, z: 0, a: 0 };
    const P = v => [S.x + v[0] * S.c + v[2] * S.s, S.y + v[1], S.z - v[0] * S.s + v[2] * S.c];
    const bin = c => { let b = bins.get(c); if (!b) bins.set(c, b = { p: [], n: [], u: [], i: [] }); return b; };
    const nrm = (a, b, d) => unit([(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const api = {
      // 在 (x, y, z) 处、转 ry 之后搭 fn 里的东西
      at(x, y, z, ry, fn) { const keep = S, o = P([x, y, z]), a = keep.a + ry; S = { c: Math.cos(a), s: Math.sin(a), x: o[0], y: o[1], z: o[2], a }; fn(); S = keep; },
      // 四边形：a 左下、b 右下、cc 右上、d 左上。uv = [u0, v0, u1, v1]，不给就按真实尺寸铺、贴图的上沿对齐上边
      quad(c, a, b, cc, d, uv) {
        const A = P(a), Bq = P(b), Cq = P(cc), Dq = P(d), n = nrm(A, Bq, Dq), bn = bin(c), i0 = bn.p.length / 3;
        const q = uv ?? [0, 1 - dist(A, Dq) * PPM / c.height, dist(A, Bq) * PPM / c.width, 1];
        bn.p.push(...A, ...Bq, ...Cq, ...Dq); bn.n.push(...n, ...n, ...n, ...n); bn.u.push(q[0], q[1], q[2], q[1], q[2], q[3], q[0], q[3]); bn.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
      },
      tri(c, a, b, cc, ua, ub, uc) {
        const A = P(a), Bq = P(b), Cq = P(cc), n = nrm(A, Bq, Cq), bn = bin(c), i0 = bn.p.length / 3;
        bn.p.push(...A, ...Bq, ...Cq); bn.n.push(...n, ...n, ...n); bn.u.push(...ua, ...ub, ...uc); bn.i.push(i0, i0 + 1, i0 + 2);
      },
      // 方块：底面中心在 (x, y, z)，四周一种贴图、顶面一种；不要底
      box(side, w, h, d, x, y, z, top = side) {
        const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, y1 = y + h;
        api.quad(side, [x0, y, z1], [x1, y, z1], [x1, y1, z1], [x0, y1, z1]); api.quad(side, [x1, y, z1], [x1, y, z0], [x1, y1, z0], [x1, y1, z1]);
        api.quad(side, [x1, y, z0], [x0, y, z0], [x0, y1, z0], [x1, y1, z0]); api.quad(side, [x0, y, z0], [x0, y, z1], [x0, y1, z1], [x0, y1, z0]);
        api.quad(top, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
      },
      // 圆筒 / 圆台。axis 'y'：立着，(x, y, z) 是底面圆心；'x' / 'z'：躺着，(x, y, z) 是正中心。cap：两头（立着的只封顶）用的贴图
      tube(c, r1, r0, h, x, y, z, { seg = 8, cap = null, axis = 'y' } = {}) {
        const pt = (r, a, t) => axis === 'y' ? [x + Math.cos(a) * r, y + t * h, z + Math.sin(a) * r] : axis === 'x' ? [x + (t - .5) * h, y + Math.cos(a) * r, z + Math.sin(a) * r] : [x + Math.cos(a) * r, y + Math.sin(a) * r, z + (t - .5) * h];
        const ku = Math.max(1, Math.round(TAU * Math.max(r0, r1) * PPM / c.width)), kv = h * PPM / c.height;
        for (let k = 0; k < seg; k++) {
          const a0 = k / seg * TAU, a1 = (k + 1) / seg * TAU;
          api.quad(c, pt(r0, a0, 0), pt(r0, a1, 0), pt(r1, a1, 1), pt(r1, a0, 1), [k / seg * ku, 1 - kv, (k + 1) / seg * ku, 1]);
          if (cap) for (const t of axis === 'y' ? [1] : [0, 1]) { const r = t ? r1 : r0; api.tri(cap, pt(0, 0, t), pt(r, a0, t), pt(r, a1, t), [.5, .5], [.5 + Math.cos(a0) * .5, .5 + Math.sin(a0) * .5], [.5 + Math.cos(a1) * .5, .5 + Math.sin(a1) * .5]); }
        }
      },
      // 屋顶：prof 是横断面（一串 [x, y]，从左檐到右檐），顺着 z 拉 d 长；over 是出檐；end 给了就用它把两头的山墙封上
      ridge(c, prof, d, x, y, z, { over = .12, end = null } = {}) {
        const n = prof.length, hd = d / 2, ext = prof.map(p => p.slice());
        for (const [i, j] of [[0, 1], [n - 1, n - 2]]) { const l = Math.hypot(prof[j][0] - prof[i][0], prof[j][1] - prof[i][1]); ext[i] = [prof[i][0] - (prof[j][0] - prof[i][0]) / l * over, prof[i][1] - (prof[j][1] - prof[i][1]) / l * over]; }
        for (let k = 0; k < n - 1; k++) {
          const up = ext[k + 1][1] >= ext[k][1], lo = up ? ext[k] : ext[k + 1], hi = up ? ext[k + 1] : ext[k], za = up ? hd + over : -hd - over;
          api.quad(c, [x + lo[0], y + lo[1], z + za], [x + lo[0], y + lo[1], z - za], [x + hi[0], y + hi[1], z - za], [x + hi[0], y + hi[1], z + za]);
        }
        if (end) { const xs = prof.map(p => p[0]), x0 = Math.min(...xs), y1 = Math.max(...prof.map(p => p[1])), uv = p => [(p[0] - x0) * PPM / end.width, 1 - (y1 - p[1]) * PPM / end.height];
          for (const zz of [hd, -hd]) for (let k = 1; k < n - 1; k++) api.tri(end, [x + prof[0][0], y + prof[0][1], z + zz], [x + prof[k][0], y + prof[k][1], z + zz], [x + prof[k + 1][0], y + prof[k + 1][1], z + zz], uv(prof[0]), uv(prof[k]), uv(prof[k + 1])); }
      },
      done() {
        for (const [c, b] of bins) {
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setIndex(b.i);
          const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tx(c), side: THREE.DoubleSide })); m.castShadow = m.receiveShadow = true; parent.add(m);
        }
        bins.clear();
      },
    };
    return api;
  }
  // 单独的一片（自发光的面：水、谷仓里的灯火、天、远山）。pts 是四个角：左下、右下、右上、左上
  function plate(parent, material, pts, uv = [0, 0, 1, 1]) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]], 2)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(g, material); parent.add(m); return m;
  }

  // —— 像素片：一张图集 ——
  const AT = (() => {
    const set = sprites(), names = Object.keys(set).sort((a, b) => set[b].height - set[a].height), AW = 1024, pos = {}; let x = 1, y = 1, rowH = 0;
    for (const n of names) { const c = set[n]; if (x + c.width + 1 > AW) { x = 1; y += rowH + 1; rowH = 0; } pos[n] = [x, y]; x += c.width + 1; rowH = Math.max(rowH, c.height); }
    const AH = y + rowH + 1, cv = document.createElement('canvas'); cv.width = AW; cv.height = AH; const g = cv.getContext('2d'), at = {}, e = .02;
    for (const n of names) { const c = set[n], [px, py] = pos[n]; g.drawImage(c, px, py); at[n] = { u0: (px + e) / AW, u1: (px + c.width - e) / AW, v0: 1 - (py + e) / AH, v1: 1 - (py + c.height - e) / AH, w: c.width / PPM, h: c.height / PPM }; }
    const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
    return { tex: t, at };
  })();
  const missing = new Set();
  const rect = n => typeof n !== 'string' ? n : AT.at[n] ?? (missing.has(n) || (missing.add(n), console.warn('丰收麦场：图集里没有', n)), AT.at.dot);
  const MAT = {
    lit: new THREE.MeshLambertMaterial({ map: AT.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide }),
    glow: new THREE.MeshBasicMaterial({ map: AT.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide }),
    fore: new THREE.MeshBasicMaterial({ map: AT.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide, fog: false }),
    soft: new THREE.MeshBasicMaterial({ map: Object.assign(new THREE.CanvasTexture(halo(64)), { colorSpace: THREE.SRGBColorSpace }), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  };
  // 一张片的四个角（左上、右上、左下、右下）写进 Q。mode：0 立着（锚在底边中点）· 1 挂着（锚在上边中点）· 2 躺着（锚在中心）· 3 朝镜头（锚在中心）
  // ang：立着 / 挂着 / 躺着时是绕竖轴转多少，朝镜头时是在画面里转多少；shx：没被锚住的那条边顺着片的横向错开多少米（被风吹歪）；tilt：往后仰多少
  const Q = new Float32Array(12), CR = [1, 0, 0], CU = [0, 1, 0];
  function corners(r, x, y, z, s, mode, ang, shx, tilt) {
    const hw = r.w * s / 2, hh = r.h * s, c = Math.cos(ang), sn = Math.sin(ang);
    if (mode === 2) { const ax = c * hw, az = -sn * hw, bx = sn * hh / 2, bz = c * hh / 2; Q[0] = x - ax - bx; Q[1] = y; Q[2] = z - az - bz; Q[3] = x + ax - bx; Q[4] = y; Q[5] = z + az - bz; Q[6] = x - ax + bx; Q[7] = y; Q[8] = z - az + bz; Q[9] = x + ax + bx; Q[10] = y; Q[11] = z + az + bz; return; }
    if (mode === 3) { const h2 = hh / 2, ax = (CR[0] * c + CU[0] * sn) * hw, ay = (CR[1] * c + CU[1] * sn) * hw, az = (CR[2] * c + CU[2] * sn) * hw, bx = (CU[0] * c - CR[0] * sn) * h2, by = (CU[1] * c - CR[1] * sn) * h2, bz = (CU[2] * c - CR[2] * sn) * h2;
      Q[0] = x - ax + bx; Q[1] = y - ay + by; Q[2] = z - az + bz; Q[3] = x + ax + bx; Q[4] = y + ay + by; Q[5] = z + az + bz; Q[6] = x - ax - bx; Q[7] = y - ay - by; Q[8] = z - az - bz; Q[9] = x + ax - bx; Q[10] = y + ay - by; Q[11] = z + az - bz; return; }
    const ax = c * hw, az = -sn * hw, st = Math.sin(tilt), ux = -st * sn * hh + c * shx, uy = Math.cos(tilt) * hh, uz = -st * c * hh - sn * shx;
    if (mode === 1) { Q[0] = x - ax; Q[1] = y; Q[2] = z - az; Q[3] = x + ax; Q[4] = y; Q[5] = z + az; Q[6] = x - ax + ux; Q[7] = y - uy; Q[8] = z - az + uz; Q[9] = x + ax + ux; Q[10] = y - uy; Q[11] = z + az + uz; return; }
    Q[0] = x - ax + ux; Q[1] = y + uy; Q[2] = z - az + uz; Q[3] = x + ax + ux; Q[4] = y + uy; Q[5] = z + az + uz; Q[6] = x - ax; Q[7] = y; Q[8] = z - az; Q[9] = x + ax; Q[10] = y; Q[11] = z + az;
  }
  // 不动的片：三层（cast 受光并投影 / lit 只受光 / glow 自发光），一层一张网格。o：{ flip, yaw, tilt, k 亮度, tint 颜色, flat 躺着, hang 挂着, shx }
  function Deck(parent) {
    const L = {};
    const add = (layer, n, x, y, z, s = 1, o = NO) => {
      const b = L[layer] ??= { p: [], n: [], u: [], c: [], i: [] }, r = rect(n), i0 = b.p.length / 3, nm = o.flat ? UPV : CARDN, k = o.k ?? (layer === 'glow' ? GK.mid : 1), tn = o.tint ?? WHITE, u0 = o.flip ? r.u1 : r.u0, u1 = o.flip ? r.u0 : r.u1;
      corners(r, x, y, z, s, o.flat ? 2 : o.hang ? 1 : 0, o.yaw ?? 0, o.shx ?? 0, o.tilt ?? 0);
      for (let q = 0; q < 12; q += 3) { b.p.push(Q[q], Q[q + 1], Q[q + 2]); b.n.push(nm[0], nm[1], nm[2]); b.c.push(tn[0] * k, tn[1] * k, tn[2] * k); }
      b.u.push(u0, r.v0, u1, r.v0, u0, r.v1, u1, r.v1); b.i.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    };
    return {
      cast: (...a) => add('cast', ...a), lit: (...a) => add('lit', ...a), glow: (...a) => add('glow', ...a),
      done() { for (const [layer, b] of Object.entries(L)) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3)); g.setIndex(b.i);
        const m = new THREE.Mesh(g, layer === 'glow' ? MAT.glow : MAT.lit); m.castShadow = layer === 'cast'; m.receiveShadow = layer !== 'glow'; parent.add(m); } },
    };
  }
  // 会动的片：预先留好 cap 张的位置，每帧 begin → put … → end 重写一遍（不新建任何对象）
  function Reel(cap, material, { cast = false, recv = false, one = null } = {}) {
    const Pb = new Float32Array(cap * 12), Ub = new Float32Array(cap * 8), Cb = new Float32Array(cap * 12), Nb = new Float32Array(cap * 12), Ib = new Uint16Array(cap * 6);
    for (let k = 0; k < cap; k++) { Ib.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3], k * 6); for (let q = 0; q < 4; q++) Nb.set(CARDN, k * 12 + q * 3); }
    const g = new THREE.BufferGeometry(), dyn = (a, n) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b; };
    g.setAttribute('position', dyn(Pb, 3)); g.setAttribute('uv', dyn(Ub, 2)); g.setAttribute('color', dyn(Cb, 3)); g.setAttribute('normal', new THREE.BufferAttribute(Nb, 3)); g.setIndex(new THREE.BufferAttribute(Ib, 1));
    const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; mesh.castShadow = cast; mesh.receiveShadow = recv; W.add(mesh); let n = 0;
    return {
      begin() { n = 0; },
      // r：图集里的一格（或名字）；k 亮度；tint 颜色；mode / ang / shx / tilt 见 corners
      put(r, x, y, z, s = 1, k = 1, tint = WHITE, mode = 0, ang = 0, shx = 0, flip = false, tilt = 0) {
        if (n >= cap) return; r = one ?? rect(r); corners(r, x, y, z, s, mode, ang, shx, tilt); Pb.set(Q, n * 12);
        const u0 = flip ? r.u1 : r.u0, u1 = flip ? r.u0 : r.u1, u = n * 8, c = n * 12; Ub[u] = u0; Ub[u + 1] = r.v0; Ub[u + 2] = u1; Ub[u + 3] = r.v0; Ub[u + 4] = u0; Ub[u + 5] = r.v1; Ub[u + 6] = u1; Ub[u + 7] = r.v1;
        for (let q = 0; q < 12; q += 3) { Cb[c + q] = tint[0] * k; Cb[c + q + 1] = tint[1] * k; Cb[c + q + 2] = tint[2] * k; } n++;
      },
      end() { g.setDrawRange(0, n * 6); g.attributes.position.needsUpdate = g.attributes.uv.needsUpdate = g.attributes.color.needsUpdate = true; },
    };
  }

  // —— 场地的分区（地面贴图和撒小件都按它来）：0 场院 1 麦茬地 2 草地 3 溪岸 4 南瓜地 5 土路 ——
  const roadX = z => .25 + Math.sin(z * .55) * .35;
  const CREEK = [[-GATE - .05, F(.25)], [-GATE - .7, F(1.25)], [-GATE - 1.0, F(2.6)]];
  const nearSeg = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], k = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1); return Math.hypot(x - a[0] - dx * k, z - a[1] - dz * k); };
  const zoneAt = (x, z) => {
    const d = -HZ - z;
    if (z > HZ && Math.min(nearSeg(x, z, CREEK[0], CREEK[1]), nearSeg(x, z, CREEK[1], CREEK[2])) < .62) return 3;
    if (d > 2.45) { if (Math.abs(x - roadX(z)) < .6) return 5; if (d > 5.25) return 2; if (x > HX + 2.3 && d < 3.9) return 4; return 1; }
    if (Math.abs(x) > HX + 4.6 || z > HZ + 1.4) return 2;
    return 0;
  };
  const inWheat = (x, d) => d >= 2.7 && d <= 4.95 && (x < roadX(-HZ - d) - .85 || (x > roadX(-HZ - d) + .85 && (d >= 4.0 || x > HX + 5.4)));   // 哪里长着没割的麦子
  const depthTint = z => { const k = clamp((-HZ - z - 2.4) / 4.4, 0, 1); return [1 - .66 * k, 1 - .68 * k, 1 - .34 * k]; };                          // 越往后越暗越蓝

  // —— 地面：一整张图 ——
  const GX = HX + 8, GZ0 = B(6.5), GZ1 = F(2.6);
  { const cv = MT.ground({ w: GX * 2, d: GZ1 - GZ0, x0: -GX, z0: GZ0, ppm: low ? 32 : PPM, zone: zoneAt }), m = plate(W, new THREE.MeshLambertMaterial({ map: tx(cv) }), [[-GX, 0, GZ1], [GX, 0, GZ1], [GX, 0, GZ0], [-GX, 0, GZ0]]);
    m.geometry.computeVertexNormals(); m.receiveShadow = true; }

  const M = Mason(W), D = Deck(W);
  const LAMPS = [], BULBS = [], PENS = [], HANGS = [], SMOKES = [], JACKS = [], HENS = [], CANDLES = [];
  // 一盏灯：光晕（朝镜头的软光斑）+ 可选的地上一摊光 + 可选的点光。cg：挂在哪座城堡上（坐标就是城堡组里的）
  const lamp = (x, y, z, col, size, o = {}) => { const l = { x, y, z, col, size, a: o.a ?? .4, pool: o.pool ?? 0, flick: !!o.flick, cg: o.cg ?? null, i: LAMPS.length, light: null, power: o.power ?? 0 };
    if (l.power && (!low || o.keep)) { l.light = new THREE.PointLight(new THREE.Color(col[0], col[1], col[2]), l.power, o.reach ?? 6, 2); l.light.position.set(x, y, z + .1); (o.cg ?? W).add(l.light); }
    LAMPS.push(l); return l; };

  // —— 格子：还是游戏那 20 块（点击、抬起都靠它们），一块一张从整盘贴图上切下来的旧石板；四条边取贴图左上角那颗墨色像素 ——
  { const tw = Math.round(LX * PPM), th = Math.round(LZ * PPM), bt = MT.board({ rows: ROWS, lanes: COLS, tw, th });
    for (const t of tiles) { const cv = document.createElement('canvas'); cv.width = tw; cv.height = th; cv.getContext('2d').drawImage(bt, -t.userData.r * tw, -t.userData.c * th);
      const m = new THREE.CanvasTexture(cv); m.magFilter = m.minFilter = THREE.NearestFilter; m.generateMipmaps = false; m.colorSpace = THREE.SRGBColorSpace; t.material = new THREE.MeshLambertMaterial({ map: m }); } }

  // —— 打麦场的石台：比地面高一拃，台面是大石板；格子缝里露出来的底是墨色 ——
  const RX = HX + .3, RZ = HZ + .42;                                             // 石台的半宽、半深（左右紧挨着两座城堡的台基）
  M.box(T.stone, RX * 2, TY, RZ * 2, 0, 0, 0, T.pave);
  plate(W, new THREE.MeshBasicMaterial({ color: '#0b0918' }), [[-HX - .01, TY + .004, HZ + .01], [HX + .01, TY + .004, HZ + .01], [HX + .01, TY + .004, -HZ - .01], [-HX - .01, TY + .004, -HZ - .01]]);
  // 后沿：一道矮木栅，栅上靠着成捆的麦子，栅脚下摆南瓜；前沿只在两个角上放东西（中间被手牌盖住，也不能挡最前一路）
  for (let i = 0, n = Math.round(2 * HX); i < n; i++) D.cast(i % 2 ? 'fenceB' : 'fenceA', -HX + (i + .5) * 2 * HX / n, TY, B(.33), .62 * 2 * HX / n / .62, { flip: i % 3 === 1, k: .95 });
  for (const [x, n, s, fl] of [[-HX + .12, 'shock', .8, 0], [-HX * .52, 'sheaf', .78, 1], [-HX * .16, 'sheafB', .7, 0], [HX * .24, 'sheaf', .74, 0], [HX * .6, 'sheafB', .8, 1], [HX - .1, 'shock', .8, 1]]) D.cast(n, x, TY, B(.2), s, { flip: !!fl });
  for (const [x, n, s] of [[-HX * .76, 'pumpM', .9], [-HX * .34, 'pumpS', 1], [-HX * .02, 'pumpW', .9], [HX * .08, 'pumpS', .8], [HX * .42, 'pumpG', .9], [HX * .8, 'pumpM', 1], [HX * .9, 'pumpS', .9]]) D.cast(n, x, TY, B(.12), s);
  for (const sx of [-1, 1]) { D.cast('pumpS', sx * (HX + .12), TY, F(.24), .9); D.cast('tuftD0', sx * (HX - .5), TY, F(.3), .7, { flip: sx > 0 }); }
  for (let i = 0; i < 15; i++) { const x = -HX - .1 + (i + .5) * (2 * HX + .2) / 15 + (rr(i, 81) - .5) * .2, z = F(.72 + rr(i, 82) * .5);
    D.cast(['pumpS', 'tuftD1', 'marigold', 'rock1', 'pumpW', 'daisy', 'tuftD0', 'mushroom', 'pumpM', 'aster', 'tuftD1', 'pumpG', 'rock0', 'marigold', 'pumpS'][i], x, 0, z, .8 + rr(i, 83) * .25, { flip: rr(i, 84) > .5 }); }
  // 四角的杆：后面两根高（拉彩旗和串灯），前面两根矮（各顶一盏提灯）
  const POLE = { a: [-(HX + .2), 2.75, B(.3)], b: [HX + .2, 2.75, B(.3)], c: [-2.25, 2.4, B(2.42)], d: [2.3, 2.4, B(2.42)], e: [-(HX + 2.95), 2.65, B(1.25)], f: [HX + 2.95, 2.65, B(1.25)] };
  for (const p of Object.values(POLE)) { M.tube(T.bark, .035, .05, p[1], p[0], 0, p[2], { seg: 6 }); M.box(T.stoneW, .22, .1, .22, p[0], 0, p[2]); D.cast('pen2', p[0] + .1, p[1] - .28, p[2] + .02, 1.1); }
  for (const sx of [-1, 1]) { const x = sx * (HX + .16), z = F(.26); M.box(T.dark, .09, .46 + TY, .09, x, 0, z); D.glow('lampW', x, TY + .46, z, .9, { k: GK.hi }); lamp(x, TY + .62, z, WARM, 1.1, { a: .34 }); }
  // 绳子：一条下垂的细带（顺着镜头方向的再加一条横的才看得见）；一路上按种类挂灯泡 / 三角旗 / 纸灯笼
  function strand(a, b, sag, kind, id) {
    const n = Math.max(4, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (kind === 'bulb' ? .34 : .4))); let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= n; i++) {
      const k = i / n, x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k - sag * 4 * k * (1 - k), z = a[2] + (b[2] - a[2]) * k;
      if (i) { M.quad(T.iron, [px, py - .012, pz], [x, y - .012, z], [x, y + .012, z], [px, py + .012, pz]); if (Math.abs(z - pz) > Math.abs(x - px)) M.quad(T.iron, [px - .012, py, pz], [x - .012, y, z], [x + .012, y, z], [px + .012, py, pz]); }
      if (i && i < n) { if (kind === 'bulb') BULBS.push({ x, y, z, c: BULBC[(i + id) % 5], i, s: id }); else if (kind === 'pen') PENS.push({ x, y, z, r: rect('pen' + (i + id * 2) % 6), ph: i * .9 + id * 2 }); else if (i % 2) HANGS.push({ x, y, z, r: rect(['plO', 'plR', 'plC'][(i >> 1) % 3]), col: [WARM, RED, GOLD][(i >> 1) % 3], ph: i + id }); }
      px = x; py = y; pz = z;
    }
  }
  strand(POLE.a, POLE.b, .42, 'bulb', 0); strand(POLE.c, POLE.d, .3, 'lantern', 1); strand(POLE.a, POLE.c, .3, 'pen', 2); strand(POLE.b, POLE.d, .3, 'pen', 3);
  strand(POLE.a, POLE.e, .22, 'bulb', 4); strand(POLE.b, POLE.f, .22, 'bulb', 5); strand(POLE.e, [-(HX + 5.6), 2.2, B(2.5)], .25, 'pen', 6); strand(POLE.f, [HX + 5.6, 2.2, B(2.5)], .25, 'pen', 7);
  strand(POLE.c, [-(HX + 1.3), 2.5, B(4.4)], .3, 'bulb', 8); strand(POLE.d, [HX + 1.3, 2.5, B(4.4)], .3, 'bulb', 9);

  // —— 场院正中：篝火（一圈石头、搭成尖塔的柴、一团大火），两边各一截当凳子的原木 ——
  const FIREP = [0, 0, B(2.0)];                                  // 靠后放：火苗整个落在最后一路棋子的头顶上方，不垫在棋子背后
  D.cast('fireLogs', FIREP[0], 0, FIREP[2], 1.15); lamp(FIREP[0], .62, FIREP[2] + .1, FIRE, 2.6, { a: .4, pool: 4.6, flick: true, power: 9, reach: 9, keep: true }); SMOKES.push({ x: FIREP[0], y: 1.5, z: FIREP[2] - .05, n: 4, rise: 1.7 });
  M.tube(T.bark, .16, .16, 1.15, -1.2, .16, B(2.1), { axis: 'x', cap: T.rings }); M.tube(T.bark, .15, .15, 1.0, 1.25, .15, B(2.12), { axis: 'x', cap: T.rings }); D.cast('stump', -.75, 0, B(1.3), .9); D.cast('stump', .85, 0, B(1.25), .8, { flip: true });
  D.cast('mug', -.75, .34, B(1.29), .9); D.cast('fork', 1.75, 0, B(2.3), .9, { tilt: .12 }); D.cast('logs', .95, 0, B(2.36), .9);
  // 左边：铺着格子布的长桌，摆着烤肉、面包、馅饼、奶酪、酒壶和木杯，桌上两盏烛灯；一条长凳
  { const x = -1.72, z = B(1.12); M.box(T.woodH, 1.55, .06, .62, x, .46, z); M.box(T.cloth, 1.0, .012, .64, x, .52, z); for (const [dx, dz] of [[-.7, -.24], [.7, -.24], [-.7, .24], [.7, .24]]) M.box(T.dark, .07, .46, .07, x + dx, 0, z + dz);
    M.box(T.woodH, 1.4, .05, .2, x, .26, z + .5); for (const dx of [-.6, .6]) M.box(T.dark, .06, .26, .16, x + dx, 0, z + .5);
    for (const [n, dx, dz, s] of [['roast', -.05, 0, 1], ['bread', -.52, -.1, .9], ['pie', .42, .08, 1], ['cheese', .62, -.16, 1], ['jug', -.3, -.2, 1], ['mug', .2, .2, 1], ['mug', -.62, .18, 1], ['jars', .1, -.22, .9]]) D.cast(n, x + dx, .532, z + dz, s);
    for (const dx of [-.36, .3]) { D.cast('milk', x + dx, .532, z - .02, .34); CANDLES.push([x + dx, .71, z - .02]); lamp(x + dx, .78, z, GOLD, .8, { a: .32 }); } }
  // 右边：酒桶架（两只横着的桶带龙头，一只立着当桌子），板条箱
  { const x = 1.78, z = B(1.08); for (const dx of [-.3, .3]) { M.tube(T.cask, .25, .25, .62, x + dx, .52, z, { axis: 'z', cap: T.rings, seg: 10 }); M.box(T.iron, .04, .05, .1, x + dx, .4, z + .34); }
    M.box(T.dark, 1.3, .06, .5, x, .2, z); for (const dx of [-.58, .58]) M.box(T.dark, .07, .2, .46, x + dx, 0, z);
    M.tube(T.cask, .23, .2, .6, x + .92, 0, z + .28, { cap: T.rings, seg: 10 }); D.cast('mug', x + .86, .6, z + .3, 1); D.cast('mug', x + 1.02, .6, z + .22, .9, { flip: true }); D.cast('jug', x - .86, 0, z + .4, 1.2);
    M.box(T.crate, .42, .42, .42, x - .95, 0, z - .2); M.box(T.crate, .34, .34, .34, x - .9, .42, z - .2); D.cast('crApple', x - .92, .76, z - .1, .7); }
  for (const [x, d, fl] of [[-.45, .78, 0], [.55, .72, 1], [2.45, 1.75, 0]]) HENS.push({ x, z: B(d), flip: !!fl, ph: HENS.length * 1.7 });

  // —— 集市摊位：柜台、四根柱、条纹布篷，篷檐下挂玉米串和辣椒串；两座分在左右两侧的空地上 ——
  function stall(x, z, awn, goods, hang) {
    M.box(T.crate, 1.5, .5, .56, x, 0, z, T.woodH);
    for (const [dx, dz] of [[-.74, -.3], [.74, -.3], [-.74, .3], [.74, .3]]) M.box(T.wood, .06, dz < 0 ? 1.62 : 1.24, .06, x + dx, 0, z + dz);
    M.quad(awn, [x - .9, 1.2, z + .56], [x + .9, 1.2, z + .56], [x + .9, 1.66, z - .38], [x - .9, 1.66, z - .38]); M.quad(awn, [x - .9, 1.06, z + .56], [x + .9, 1.06, z + .56], [x + .9, 1.2, z + .56], [x - .9, 1.2, z + .56]);
    goods.forEach(([n, dx, s = .9], i) => D.cast(n, x + dx, .5, z + .08 + (i % 2) * .1, s));
    hang.forEach((n, i) => D.cast(n, x - .6 + i * 1.2 / Math.max(1, hang.length - 1), 1.08, z + .52, .8, { hang: true }));
    HANGS.push({ x: x + .98, y: 1.2, z: z + .5, r: rect('plO'), col: WARM, ph: x }); lamp(x, .95, z + .45, WARM, 1.8, { a: .3, pool: 2.6, power: 3.2, reach: 4.5 });
  }
  stall(-(HX + 3.3), B(1.5), T.awnO, [['crApple', -.5], ['bskPear', -.02], ['bread', .46], ['crPear', .1, .8]], ['corn', 'chili', 'garlic', 'corn']);
  stall(HX + 3.5, B(1.6), T.awnP, [['crGrape', -.48], ['jars', .0, 1], ['cheese', .34, 1], ['crOrange', .52, .8]], ['chili', 'herbs', 'corn', 'chili']);
  for (const [n, x, d, s] of [['sackOpen', -(HX + 2.5), 1.55, 1], ['sack', -(HX + 4.3), 1.6, 1], ['bskApple', -(HX + 2.75), 1.4, .9], ['flour', HX + 2.55, 1.55, 1], ['milk', HX + 4.35, 1.6, 1], ['crOrange', HX + 2.6, 1.35, .9]]) D.cast(n, x, 0, B(d), s);

  // —— 水井：石井圈、两根立柱、小木顶、辘轳和吊桶（右侧空地）——
  { const x = HX + 2.95, z = B(.5); M.tube(T.stone, .4, .43, .46, x, 0, z, { seg: 10 }); plate(W, new THREE.MeshBasicMaterial({ color: '#06202c' }), [[x - .3, .44, z + .3], [x + .3, .44, z + .3], [x + .3, .44, z - .3], [x - .3, .44, z - .3]]);
    for (const dx of [-.42, .42]) M.box(T.wood, .07, 1.3, .07, x + dx, 0, z); M.tube(T.wood, .05, .05, .84, x, 1.0, z, { axis: 'x', seg: 6 }); M.box(T.iron, .03, .2, .03, x + .5, .88, z);
    M.at(x, 1.3, z, Math.PI / 2, () => M.ridge(T.shingle, [[-.34, 0], [0, .26], [.34, 0]], .98, 0, 0, 0, { over: .08 }));
    M.quad(T.rope, [x - .012, .7, z], [x + .012, .7, z], [x + .012, 1.0, z], [x - .012, 1.0, z]); D.cast('bucket', x, .44, z + .02, .8); D.cast('bucket', x + .62, 0, z + .3, 1); D.cast('tuftG', x - .5, 0, z + .34, .9); }
  // —— 左侧空地：结满果子的苹果树，树上靠着梯子，树下几筐苹果和两只蜂箱；右侧：一棵大枫树，树下草捆 ——
  D.cast('apple', -(HX + 4.5), 0, B(2.3), 1.2); D.cast('ladder', -(HX + 3.95), 0, B(2.2), 1, { tilt: .2 }); D.cast('bskApple', -(HX + 2.55), 0, B(-.12), 1); D.cast('crApple', -(HX + 3.3), 0, B(-.2), 1); D.cast('hive', -(HX + 3.9), 0, B(-.35), 1); D.cast('hive', -(HX + 2.9), 0, B(-.6), .9, { flip: true });
  D.cast('mapleR', HX + 4.9, 0, B(2.36), 1.25, { tint: [.8, .78, .9] }); M.box(T.hay, .78, .42, .46, HX + 2.9, 0, B(-.55)); M.box(T.hay, .78, .42, .46, HX + 3.1, .42, B(-.5)); M.box(T.hay, .78, .42, .46, HX + 3.75, 0, B(-.45)); D.cast('rake', HX + 2.5, 0, B(-.72), .9, { tilt: .15 }); D.cast('pumpL', HX + 2.8, 0, B(-1.0), .9);
  // 两座城堡外侧到镜头之间的窄条：栅栏、高麦子、南瓜（画面的左右下角）
  for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) { const x = sx * (HX + 2.85 + (i % 2) * .5), z = -HZ * .5 + i * (HZ * .42);
    D.cast(i % 2 ? 'fenceA' : 'wheatC', x + sx * .2, 0, z, 1, { flip: sx > 0 }); D.cast(['pumpM', 'sheaf', 'pumpS', 'tuftD1', 'sunflower'][i], x - sx * .3, 0, z + .2, .9); }

  // —— 场院后面，路左边是没割的麦田（稻草人立在里面），路右边是割过的麦茬地：板车、圆草捆、草垛 ——
  for (const sx of [-1, 1]) for (let i = 0; i < 9; i++) { const x = sx * (1.3 + i * 1.0) + roadX(B(2.5)); if (Math.abs(x) > HX + 7) continue; D.cast(i % 2 ? 'fenceA' : 'fenceB', x, 0, B(2.5), 1, { flip: i % 3 === 0 }); if (i % 3 === 1) D.cast('sunflower', x + .3, 0, B(2.44), .9 + (i % 2) * .15, { flip: sx > 0 }); }
  D.cast('sign', roadX(B(2.5)) - .82, 0, B(2.36), .85);
  const SCARE = { x: -1.95, z: B(3.35) };
  { const x = 1.55, z = B(3.05); M.box(T.woodH, 1.5, .1, .74, x, .4, z); for (const dz of [-.37, .37]) M.box(T.wood, 1.5, .26, .04, x, .5, z + dz); M.box(T.wood, .04, .26, .74, x - .75, .5, z); M.box(T.dark, .9, .05, .06, x + 1.2, .42, z - .2); M.box(T.dark, .9, .05, .06, x + 1.2, .42, z + .2);
    D.cast('wheel', x - .42, .02, z + .41, 1.1); D.cast('wheel', x + .46, .02, z + .41, 1.1); for (const [dx, dy, s, n] of [[-.5, .5, .85, 'sheaf'], [-.12, .5, .9, 'sheafB'], [.28, .5, .85, 'sheaf'], [.6, .5, .8, 'sheafB'], [.08, .72, .8, 'sheaf']]) D.cast(n, x + dx, dy, z + .05 + dx * .05, s, { flip: dx > 0 });
    D.cast('scythe', x - .95, 0, z + .3, .9, { tilt: .1 }); }
  for (const [x, d, r, ax] of [[2.75, 3.55, .42, 'x'], [1.2, 4.35, .4, 'z'], [3.9, 3.0, .4, 'x'], [-.75, 2.95, .36, 'z'], [HX + 4.9, 4.6, .42, 'x']]) M.tube(T.hay, r, r, r * 1.7, x, r, B(d), { axis: ax, cap: T.hayEnd, seg: 10 });
  for (const [x, d, s] of [[3.5, 4.2, 1.1], [-(HX + 5.2), 2.2, 1.2], [HX + 6.2, 2.4, 1.1], [-5.4, 5.3, 1.25], [HX + 4.2, 5.2, 1.1]]) D.cast('haystack', x, 0, B(d), s, { tint: depthTint(B(d)) });
  for (const [x, d, n] of [[2.2, 2.75, 'shock'], [3.4, 3.4, 'sheaf'], [.95, 3.8, 'shock'], [4.4, 3.8, 'shock'], [2.4, 4.5, 'sheafB']]) D.cast(n, x, 0, B(d), 1, { tint: depthTint(B(d)) });
  // 南瓜地（右后）：一垄垄南瓜，里面三只点着的南瓜灯
  for (let i = 0; i < 26; i++) { const x = HX + 2.5 + rr(i, 1) * 4.6, d = 2.62 + rr(i, 2) * 1.2, k = rr(i, 3); D.cast(k < .3 ? 'pumpL' : k < .6 ? 'pumpM' : k < .8 ? 'pumpS' : k < .9 ? 'pumpW' : 'pumpG', x, 0, B(d), .85 + rr(i, 4) * .4, { flip: rr(i, 5) > .5 }); if (i % 4 === 0) D.cast('tuftG', x + .3, 0, B(d) - .05, 1); }
  for (const [x, d, s] of [[HX + 3.1, 2.75, 1.1], [HX + 4.6, 3.2, 1], [HX + 5.9, 2.7, 1.1], [-(HX + 4.6), .95, 1]]) JACKS.push({ x, y: 0, z: B(d), s, big: false, cg: null });
  // 远处的两座农舍：半木构的墙、木瓦顶、烟囱、亮着的窗
  function cottage(x, z, w = 1.9) {
    M.box(T.timber, w, 1.0, 1.2, x, 0, z); M.at(x, 1.0, z, Math.PI / 2, () => M.ridge(T.shingle, [[-.66, 0], [0, .7], [.66, 0]], w, 0, 0, 0, { over: .14, end: T.timber })); M.box(T.ashlar, .26, .7, .26, x + w * .28, 1.3, z - .1);
    for (const dx of [-.5, .12, .62]) D.glow('win', x + dx * w / 1.9, .34, z + .61, .9, { k: GK.hi }); lamp(x, .6, z + .7, WARM, 1.6, { a: .26, pool: 2.2 }); SMOKES.push({ x: x + w * .28, y: 2.05, z: z - .1, n: 4, rise: 1.5 });
  }
  cottage(-(HX + 4.4), B(5.5)); cottage(HX + 1.7, B(5.75), 1.7);
  for (const [x, d, n] of [[-1.6, 5.6, 'shock'], [-.4, 5.9, 'sheaf'], [1.3, 5.7, 'shock'], [2.3, 5.95, 'sheafB']]) D.cast(n, x, 0, B(d), 1, { tint: depthTint(B(d)) });
  // 枫树：后面一排（中间给路和月亮留一个豁口），两座城堡背后各一丛（只有树冠从屋顶后面露出来）
  for (const [n, x, d, s] of [['mapleO', -(HX + 1.5), 1.75, 1.25], ['mapleY', -(HX + 1.2), 5.6, 1.1], ['mapleR', HX + 1.35, 1.85, 1.2],
    ['mapleR', -(HX + 6.6), 5.4, 1.3], ['mapleO', -(HX + 3.0), 5.9, 1.15], ['mapleR', HX + 3.6, 5.9, 1.2], ['mapleY', HX + 5.6, 5.6, 1.25], ['mapleO', HX + 7.4, 5.0, 1.3], ['mapleY', -(HX + 7.6), 3.6, 1.2]]) D.cast(n, x, 0, B(d), s, { tint: depthTint(B(d)), flip: rr(x * 7, 9) > .5 });
  for (let i = 0; i < 30; i++) { const x = -GX + .4 + i * (GX * 2 - .8) / 29; D.lit(['bushR', 'bushG', 'bushO'][i % 3], x, 0, B(6.25) + rr(i, 6) * .2, 1.2 + rr(i, 7) * .5, { tint: [.42, .4, .7], flip: i % 2 > 0 }); }

  // —— 撒的：草丛、野花、蘑菇、石头、散落的小南瓜和麦捆。位置由编号算出来；石台、城堡、路、篝火、桌子、摊子上不撒 ——
  const blocked = (x, z) => (Math.abs(x) < HX + 2.45 && Math.abs(z) < HZ + .6) || (Math.abs(x) < 2.9 && z < B(.5) && z > B(2.4)) || (Math.abs(Math.abs(x) - HX - 3.4) < 1.1 && Math.abs(z - B(2)) < .6);
  for (let i = 0, n = low ? 420 : 760; i < n; i++) {
    const x = (rr(i, 11) * 2 - 1) * (GX - .3), z = GZ0 + .3 + rr(i, 12) * (GZ1 - GZ0 - .5), k = rr(i, 13), s = .85 + rr(i, 14) * .4, o = { flip: rr(i, 15) > .5, tint: depthTint(z) }, zn = zoneAt(x, z);
    if (blocked(x, z)) continue;
    if (zn === 0) { if (k < .3) D.lit(k < .15 ? 'tuftD0' : 'tuftD1', x, 0, z, s, o); else if (k < .36) D.cast('rock1', x, 0, z, s, o); else if (k < .4) D.cast('pumpS', x, 0, z, s, o); else if (k < .43) D.cast('mushroom', x, 0, z, s, o); }
    else if (zn === 1) { if (inWheat(x, -HZ - z)) continue; if (k < .3) D.lit('tuftW', x, 0, z, s, o); else if (k < .5) D.lit('tuftD1', x, 0, z, s, o); else if (k < .55) D.cast('rock0', x, 0, z, s, o); else if (k < .6) D.cast('sheafB', x, 0, z, s * .8, o); }
    else if (zn === 2) { if (k < .26) D.lit('tuftG', x, 0, z, s, o); else if (k < .38) D.cast('aster', x, 0, z, s, o); else if (k < .5) D.cast('marigold', x, 0, z, s, o); else if (k < .6) D.cast('daisy', x, 0, z, s, o); else if (k < .68) D.cast(k < .64 ? 'bushR' : 'bushO', x, 0, z, s, o); else if (k < .74) D.cast('bushG', x, 0, z, s, o); else if (k < .8) D.cast('mushroom', x, 0, z, s, o); else if (k < .86) D.cast('rock0', x, 0, z, s, o); else if (k < .9) D.cast('rock2', x, 0, z, s, o); }
    else if (zn === 3) { if (k < .22) D.cast('cattail', x, 0, z, s, o); else if (k < .5) D.cast('rock1', x, 0, z, s, o); else D.lit('tuftG', x, 0, z, s, o); }
    else if (zn === 4) { if (k < .35) D.lit('tuftG', x, 0, z, s, o); else if (k < .5) D.cast('pumpS', x, 0, z, s, o); }
  }
  // 小溪：从磨坊的水池流出来，往镜头左下方去
  const waterT = tx(T.water).clone(); waterT.needsUpdate = true;
  const waterM = new THREE.MeshBasicMaterial({ map: waterT, color: new THREE.Color(.8, .95, 1).multiplyScalar(low ? .8 : .95) });
  for (let k = 0; k < 2; k++) { const a = CREEK[k], b = CREEK[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), nx = dz / l * .3, nz = -dx / l * .3;
    plate(W, waterM, [[a[0] - nx, .012, a[1] - nz], [a[0] + nx, .012, a[1] + nz], [b[0] + nx, .012, b[1] + nz], [b[0] - nx, .012, b[1] - nz]], [0, k * .5, .3, k * .5 + l * PPM / 64]); }
  M.box(T.woodH, .9, .05, .34, CREEK[1][0], .1, CREEK[1][1]);                    // 溪上搭的一块踏板
  M.done(); D.done();

  // —— 本方城堡：水车磨坊。石台基上一座半木构的小楼，青瓦人字顶；朝镜头这头的山墙上装着木水车，木水槽从左边架过来，水落进楼前的石砌水池 ——
  const MILL = (() => {
    const cg = castles[0], K = Mason(cg), E = Deck(cg), y0 = .02, hx = -.25, hw = 1.3, zb = -HZ + .06, zf = HZ * .3, hl = zf - zb, zc = (zb + zf) / 2, wz = zf + .3, R = .84, wy = y0 + .92;
    K.box(T.stone, 2, TY + y0, 2 * HZ + .5, 0, G0, 0, T.pave);
    K.box(T.ashlar, hw, .82, hl, hx, y0, zc); K.box(T.timber, hw + .08, .95, hl + .08, hx, y0 + .82, zc);
    K.ridge(T.pantile, [[-(hw / 2 + .04), 0], [0, .9], [hw / 2 + .04, 0]], hl + .08, hx, y0 + 1.77, zc, { over: .16, end: T.timber });
    K.box(T.ashlar, .3, 1.05, .3, hx - .3, y0 + 1.95, zb + .5); K.box(T.stone, .38, .08, .38, hx - .3, y0 + 3.0, zb + .5);              // 烟囱
    K.tube(T.dark, .09, .09, .5, hx, wy, wz - .1, { axis: 'z', seg: 6 });                                                              // 水车的轴
    // 水槽：从左边架过来，越过水车顶，在下行的那一侧把水倒下去；两副木架子撑着
    const fx0 = -2.5, fx1 = hx + .5, fy = wy + R + .1;
    K.box(T.woodH, fx1 - fx0, .06, .34, (fx0 + fx1) / 2, fy, wz); for (const dz of [-.17, .17]) K.box(T.woodH, fx1 - fx0, .16, .04, (fx0 + fx1) / 2, fy + .04, wz + dz);
    for (const x of [-1.3, -2.3]) { for (const dz of [-.2, .2]) K.box(T.dark, .07, fy - G0, .07, x, G0, wz + dz); K.box(T.dark, .07, .07, .5, x, fy - .5, wz); }
    plate(cg, waterM, [[fx0, fy + .1, wz + .14], [fx0, fy + .1, wz - .14], [fx1, fy + .1, wz - .14], [fx1, fy + .1, wz + .14]], [0, 0, .28 * PPM / 64, (fx1 - fx0) * PPM / 64]);
    // 水池：三面石沿，池水是自发光的青
    const px0 = -.95, px1 = .45, pz0 = zf + .08, pz1 = HZ + .2;
    K.box(T.ashlar, px1 - px0 + .1, .16, .1, (px0 + px1) / 2, y0, pz1); K.box(T.ashlar, .1, .16, pz1 - pz0, px0, y0, (pz0 + pz1) / 2); K.box(T.ashlar, .1, .16, pz1 - pz0, px1, y0, (pz0 + pz1) / 2);
    plate(cg, waterM, [[px0, y0 + .1, pz1], [px1, y0 + .1, pz1], [px1, y0 + .1, pz0], [px0, y0 + .1, pz0]], [0, 0, (px1 - px0) * PPM / 64, (pz1 - pz0) * PPM / 64]);
    // 朝棋盘这一侧的走道：每条路一块青毯，两根灯柱挂青灯；墙根靠着面粉袋和磨盘，墙上两扇亮窗
    for (let c = 0; c < COLS; c++) E.glow('matOwn', .72, y0 + .006, tileZ(c), .68, { flat: true, k: .62 });
    for (const z of [-HZ * .5, HZ * .52]) { K.box(T.dark, .07, .95, .07, .93, y0, z); E.glow('lampT', .93, y0 + .95, z, .9, { k: GK.hi }); lamp(.93, y0 + 1.1, z, TEAL, 1.0, { a: .3, cg }); }
    for (const z of [zc - hl * .22, zc + hl * .25]) E.glow('win', hx + hw / 2 + .05, y0 + 1.0, z, .9, { yaw: Math.PI / 2, k: GK.mid });
    E.glow('winRound', hx, y0 + 1.95, zf + .06, .9, { k: GK.hi }); E.cast('millstone', .62, y0, zc + hl * .02, .8); E.cast('flour', .6, y0, zc - hl * .3, .8); E.cast('sack', .7, y0, zc - hl * .42, .8, { flip: true }); E.cast('logs', .64, y0, zf - .25, .6);
    E.cast('cattail', px0 + .2, y0 + .1, pz1 - .1, .7); E.cast('rock1', px1 - .1, y0 + .1, pz1 - .12, .8); E.cast('bucket', .72, y0, HZ - .1, .9);
    K.box(T.dark, .05, .62, .05, hx, y0 + 2.67, zc); K.done(); E.done();
    // 水车：单独一个组，绕 z 轴转
    const wheel = new THREE.Group(); wheel.position.set(hx, wy, wz); cg.add(wheel);
    { const Kw = Mason(wheel), zt = .15, pol = (r, a, z) => [Math.cos(a) * r, Math.sin(a) * r, z];
      for (let k = 0; k < 16; k++) { const a0 = k / 16 * TAU, a1 = (k + 1) / 16 * TAU; for (const z of [zt, -zt]) Kw.quad(T.wood, pol(.58, a0, z), pol(.73, a0, z), pol(.73, a1, z), pol(.58, a1, z)); Kw.quad(T.dark, pol(.58, a0, -zt), pol(.58, a0, zt), pol(.58, a1, zt), pol(.58, a1, -zt)); }
      for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; Kw.quad(T.wood, pol(.56, a, -zt - .02), pol(.56, a, zt + .02), pol(R, a, zt + .02), pol(R, a, -zt - .02)); }
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU, c = Math.cos(a), s = Math.sin(a), w = .045, p = (r, e) => [c * r - s * e * w, s * r + c * e * w, zt + .012]; Kw.quad(T.wood, p(.05, -1), p(.6, -1), p(.6, 1), p(.05, 1)); }
      Kw.tube(T.dark, .11, .11, .42, 0, 0, 0, { axis: 'z', cap: T.rings, seg: 8 }); Kw.done(); }
    lamp(.5, 1.05, wz + .5, TEAL, 2.2, { a: .2, cg, power: 2.2, reach: 5, keep: true });
    SMOKES.push({ x: hx - .3, y: 3.1 + TY, z: zb + .5, n: 4, rise: 1.4, cg });
    return { cg, wheel, fall: [hx + .62, wy + R + .12, wz + .19], pool: y0 + .1, flag: [hx, y0 + 3.27, zc], cock: [hx, y0 + 2.67, zf - .22] };
  })();

  // —— 对面城堡：红漆谷仓。折线顶（木瓦）、白边、朝镜头的山墙上一扇敞着的大门（里面是灯火照着的草堆）、阁楼小门；朝棋盘的一侧搭着披檐，檐柱上挂红灯 ——
  const BARN = (() => {
    const cg = castles[1], K = Mason(cg), E = Deck(cg), y0 = .02, bx = .22, bw = 1.42, zb = -HZ + .06, zf = HZ - .64, bl = zf - zb, zc = (zb + zf) / 2, wh = 1.36, hw = bw / 2 + .03;
    K.box(T.stoneW, 2, TY + y0, 2 * HZ + .5, 0, G0, 0, T.packed);
    K.box(T.barn, bw, wh, bl, bx, y0, zc);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(T.cream, .08, wh, .08, bx + sx * bw / 2, y0, zc + sz * bl / 2);
    K.ridge(T.shingle, [[-hw, 0], [-hw * .58, .74], [0, 1.2], [hw * .58, .74], [hw, 0]], bl + .06, bx, y0 + wh, zc, { over: .15, end: T.barn });
    for (const sx of [-1, 1]) K.box(T.cream, .06, .06, .1, bx + sx * hw * .8, y0 + wh + .34, zf + .05);
    // 大门：门洞里是自发光的一幅（灯下的草堆），白门框，两扇带白色斜撑的门往外敞着
    plate(cg, new THREE.MeshBasicMaterial({ map: tx(MT.barnInside()), color: new THREE.Color(1, 1, 1).multiplyScalar(low ? .85 : .95) }), [[bx - .54, y0, zf + .014], [bx + .54, y0, zf + .014], [bx + .54, y0 + 1.17, zf + .014], [bx - .54, y0 + 1.17, zf + .014]]);
    K.box(T.cream, 1.24, .08, .06, bx, y0 + 1.17, zf + .03); for (const sx of [-1, 1]) K.box(T.cream, .08, 1.17, .06, bx + sx * .58, y0, zf + .03);
    for (const sx of [-1, 1]) E.cast('barnDoor', bx + sx * (.6 + .14), y0, zf + .22, 1, { yaw: -sx * .95, flip: sx > 0 });
    E.cast('loftDoor', bx, y0 + wh + .28, zf + .04, .9); K.box(T.dark, .08, .08, .44, bx, y0 + wh + 1.0, zf + .2); E.cast('bucket', bx, y0 + wh + .66, zf + .4, .6, { hang: true });
    // 披檐（朝棋盘的一侧）：木瓦的斜顶、一排檐柱，柱上挂红灯；檐下每条路一块红毯，墙根是草捆和麻袋
    const lx0 = bx - bw / 2, lx1 = -.98;
    K.quad(T.shingle, [lx1, y0 + .92, zf - .05], [lx1, y0 + .92, zb + .1], [lx0, y0 + 1.22, zb + .1], [lx0, y0 + 1.22, zf - .05]);
    for (let c = 0; c <= COLS; c++) { const z = clamp(-HZ + c * LZ, zb + .14, zf - .1); K.box(T.wood, .06, .92, .06, lx1 + .04, y0, z); if (c % 2 === 1 || c === COLS) { E.glow('lampR', lx1 + .04, y0 + .5, z + .05, .85, { k: GK.hi }); lamp(lx1 + .04, y0 + .66, z + .1, RED, .9, { a: .3, cg }); } }
    for (let c = 0; c < COLS; c++) E.glow('matFoe', -.72, y0 + .006, tileZ(c), .68, { flat: true, k: .62 });
    for (const z of [zc - bl * .3, zc + bl * .12]) K.box(T.hay, .34, .32, .5, lx0 - .19, y0, z); E.cast('sack', lx0 - .2, y0, zc - bl * .08, .7); E.cast('fork', lx0 - .12, y0, zc + bl * .32, .8, { tilt: .12 });
    // 屋脊上的小气楼，山墙尖上的旗杆
    K.box(T.woodH, .34, .24, .34, bx, y0 + wh + 1.14, zc - .5); K.at(bx, y0 + wh + 1.38, zc - .5, 0, () => K.ridge(T.shingle, [[-.2, 0], [0, .17], [.2, 0]], .36, 0, 0, 0, { over: .06, end: T.woodH }));
    K.box(T.dark, .05, .64, .05, bx, y0 + wh + 1.18, zf - .06);
    // 门前：刻了脸的大南瓜灯，旁边几只小的、一捆麦、一只奶桶
    JACKS.push({ x: bx - .78, y: y0, z: zf + .5, s: 1, big: true, cg });
    for (const [n, dx, dz, s] of [['pumpM', .7, .42, 1], ['pumpS', .36, .6, 1], ['pumpW', -.28, .72, .9], ['sheaf', .9, .16, .78], ['milk', -.86, .12, .8], ['pumpS', -.42, .28, .8]]) E.cast(n, bx + dx, y0, zf + dz, s);
    K.done(); E.done();
    lamp(bx, .7, zf + .34, WARM, 2.2, { a: .16, cg, power: 5.5, reach: 6.5, flick: true, keep: true });
    return { cg, flag: [bx, y0 + wh + 1.82, zf - .06] };
  })();
  for (const j of JACKS) lamp(j.x + .02, j.y + (j.big ? .36 : .22) * j.s, j.z + .08, FIRE, j.big ? 1.9 : 1.2, { a: .36, pool: j.cg ? 0 : 1.8, flick: true, cg: j.cg, power: j.big ? 2.6 : 0, reach: 4 });

  // 不动的南瓜灯身（受光的）：放进各自的那一层里。动的只有脸上的烛光
  { const E0 = Deck(W), E1 = Deck(BARN.cg); for (const j of JACKS) (j.cg ? E1 : E0).cast(j.big ? 'jackL' : 'jackM', j.x, j.y, j.z, j.s); E0.done(); E1.done(); }

  // —— 麦田：一排排麦穗片。每帧按一道往右后方走的波把穗头推歪、把波峰提亮——这就是麦浪 ——
  const WHEAT = [];
  for (let r = 0; r < 9; r++) { const d = 2.72 + r * .28, z = B(d), tn = depthTint(z);
    for (let i = 0, x = -GX + rr(r, 21) * .6; x < GX; x += .9, i++) { const xx = x + (rr(r * 31 + i, 22) - .5) * .3; if (inWheat(xx, d)) WHEAT.push({ x: xx, z, r: rect((i + r) % 2 ? 'wheatA' : 'wheatB'), s: 1.08 + rr(r * 31 + i, 23) * .22, flip: rr(r * 31 + i, 24) > .5, tint: tn }); } }

  // —— 远景：天（跟着镜头摆，天际线压在地面的远沿上）、两道远山、月亮 ——
  const farM = (cv, rep, tint) => { const t = tx(cv); t.repeat.set(rep, 1); return new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, fog: false, color: tint }); };
  const sq = (w, h) => [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]];
  const SKY = plate(scene, farM(MT.sky(), 4, new THREE.Color(1, 1, 1)), sq(64, 5)); SKY.position.z = B(13.5);
  const HILL1 = plate(scene, farM(MT.hills({ far: true, lv: 2.3, seed: 57, band: C.sky }), 4, new THREE.Color(.8, .8, 1)), sq(64, 3)); HILL1.position.z = B(12);
  const HILL0 = plate(scene, farM(MT.hills(), 4, new THREE.Color(1, 1, 1)), sq(48, 2.25)); HILL0.position.z = B(10.2);
  for (const m of [SKY, HILL1, HILL0]) m.frustumCulled = false;

  // —— 光 ——
  const sunDir = new THREE.Vector3(...SUN_FROM).normalize();
  scene.background.set(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 24, 52);
  const DIM = low ? .8 : 1;                                       // 低画质档没有移轴和暗角：整体压暗一些，棋子才跳得出来
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1] * DIM; sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1] * DIM; sun.position.copy(sunDir).multiplyScalar(30);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  { const f = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); f.position.set(1, 9, 16); scene.add(f); }                         // 镜头方向来的一点冷补光：朝镜头的面不死黑
  // 头顶的串灯照在盘面上的那一块亮：一盏挂在盘面后半上方的暖色点光（棋子不吃光，只有石板被照亮）
  const overhead = new THREE.PointLight('#ffc070', 24, 9, 2); overhead.position.set(0, 2.7 + TY, -HZ * .3); W.add(overhead);
  // —— 后期（高画质档才有）——
  post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
  { const tl = grid.SHORT ? LOOK.tiltShort : LOOK.tilt; for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = tl.focus; p.uniforms.band.value = tl.band; p.uniforms.amt.value = tl.amt; } }
  { const u = post.grade.uniforms, g = LOOK.grade; u.sat.value = g.sat; u.con.value = g.con; u.knee.value = g.knee; u.gain.value.setRGB(...g.gain); u.lift.value.setRGB(...g.lift); u.edge.value.setRGB(...g.edge); post.grade.enabled = true; }

  // —— 会动的：受光并投影的一层（稻草人、彩旗、队旗、风向鸡）、只受光的一层（麦浪、母鸡、乌鸦）、自发光的一层、叠加的软光、贴镜头的前景 ——
  const RL = { cast: Reel(96, MAT.lit, { cast: true, recv: true }), lit: Reel(WHEAT.length + 16, MAT.lit, { recv: true }), glow: Reel(560, MAT.glow), soft: Reel(260, MAT.soft, { one: { u0: 0, u1: 1, v0: 1, v1: 0, w: 1, h: 1 } }), fore: Reel(16, MAT.fore) };
  const FR = { flame: [0, 1, 2, 3, 4, 5].map(k => rect('flame' + k)), cand: [0, 1, 2, 3].map(k => rect('cand' + k)), fall: [0, 1, 2, 3].map(k => rect('fall' + k)), foam: [rect('foam0'), rect('foam1')], scare: [rect('scare0'), rect('scare1'), rect('scare2')],
    crow: [rect('crow0'), rect('crow1')], hen: [rect('hen0'), rect('hen1')], cock: [rect('cock0'), rect('cock1'), rect('cock2')], own: [0, 1, 2].map(k => rect('flagOwn' + k)), foe: [0, 1, 2].map(k => rect('flagFoe' + k)),
    leaf: [0, 1, 2].map(i => [rect('leaf' + i + 'a'), rect('leaf' + i + 'b')]), puff: [rect('puff0'), rect('puff1'), rect('puff2')], dot: rect('dot'), star: rect('star'), bulb: rect('bulb'), moon: rect('moon'), jackM: rect('jackFaceM'), jackL: rect('jackFaceL'), crowSit: rect('crowSit') };
  const NFLY = low ? 18 : 40, NLEAF = low ? 12 : 26, NEMB = low ? 8 : 16, NSPARK = low ? 22 : 40, COCK = [0, 0, 1, 2, 1, 0, 0, 1], SWAY = [1, 0, 1, 2];
  const FWC = [GOLD, RED, TEAL, VIOLET, CREAM];
  // 贴着镜头的前景：枫叶压在画面上面两个角，麦穗压在左右下角，一盏灯笼吊在左上。位置按画面坐标算（窗口大小、手机横竖变了也还在角上）
  // 每件：[名字, 画面横坐标 -1..1, 纵坐标 -1..1（下 → 上；下面两角的要让底边沉到画面外）, 离镜头几米, 大小（1 = 和场景里的像素一样大）, 颜色, 左右翻]
  const DK = [.05, .022, .03], DW = [.07, .04, .022];
  const FORE = [['bushR', -1.0, .95, 5.6, 1.5, DK, false], ['bushO', -.74, 1.04, 6.2, 1.4, DK, true], ['mapleR', -1.08, .5, 6.4, .9, DK, false], ['bushR', 1.02, .97, 5.8, 1.5, DK, true], ['mapleO', .8, 1.34, 6.6, 1, DK, false],
    ['wheatFg', -1.0, -.8, 5.4, 1.5, DW, false], ['wheatFg', -.74, -.93, 5.7, 1.4, DW, true], ['fenceA', -.5, -.95, 5.9, 1.5, DK, false], ['wheatFg', 1.0, -.82, 5.6, 1.5, DW, true], ['wheatFg', .75, -.95, 5.8, 1.4, DW, false],
    ['plO', -.6, .84, 5.9, 1.3, [.85, .8, .7], false]].map(([n, nx, ny, d, s, tint, flip]) => ({ r: rect(n), nx, ny, d, s: s * d / 16.5, tint, flip }));
  const eye = new THREE.Vector3(), v3 = new THREE.Vector3(), look = new THREE.Vector3(0, .95, -.1);
  let last = 0;

  function tick(t) {
    last = t;
    const beat = Math.floor(t * 8);                                // 每秒 8 拍，像素的东西按拍跳；光和飘的东西连续走
    camera.updateMatrixWorld(); eye.setFromMatrixPosition(camera.matrixWorld); v3.setFromMatrixColumn(camera.matrixWorld, 0); CR[0] = v3.x; CR[1] = v3.y; CR[2] = v3.z; v3.setFromMatrixColumn(camera.matrixWorld, 1); CU[0] = v3.x; CU[1] = v3.y; CU[2] = v3.z;
    const dcam = eye.distanceTo(look); scene.fog.near = dcam + 5; scene.fog.far = dcam + 34;
    // 天际线：从镜头看过去，地面远沿（z = GZ0）落在各层远景的多高
    const kz = (G0 - eye.y) / (eye.z - GZ0), yAt = z => eye.y + kz * (eye.z - z);
    SKY.position.y = yAt(SKY.position.z) + .75; HILL1.position.y = yAt(HILL1.position.z) + .25; HILL0.position.y = yAt(HILL0.position.z) + .12;
    waterT.offset.y = frac(t * .32); MILL.wheel.rotation.z = -t * .7;
    for (const k in RL) RL[k].begin();
    const { cast, lit, glow, soft, fore } = RL, c0 = castles[0].position, c1 = castles[1].position;

    // 月亮：低低的一轮橙色大月亮，外面一圈晕
    { const z = B(12.8), y = yAt(z) + .95 - G0; glow.put(FR.moon, -1.9, y, z, .8, low ? 1.05 : 1.3, WHITE, 3); soft.put(null, -1.9, y, z + .1, 4.2, .3 * LOOK.halo, FIRE, 3); }
    // 麦浪
    for (const w of WHEAT) { const a = w.x * .85 + w.z * .5 - t * 1.6, wave = Math.sin(a) + .35 * Math.sin(a * 2.3 + 1.1); lit.put(w.r, w.x, 0, w.z, w.s, 1 + .2 * wave, w.tint, 0, 0, .09 * wave * w.s, w.flip); }
    // 稻草人（袖子三拍飘动，整个人跟着风晃），肩上蹲一只乌鸦；三只乌鸦隔一阵从天上飞过
    { const sw = Math.sin(t * 1.3) * .05; cast.put(FR.scare[SWAY[Math.floor(beat / 3) % 4]], SCARE.x, .1, SCARE.z, 1.15, 1, WHITE, 0, 0, sw); lit.put(FR.crowSit, SCARE.x + .52 + sw * .7, 1.33, SCARE.z + .02, 1, .9); }
    for (let i = 0; i < 3; i++) { const p = frac(t / 17 + i * .37 + .12), x = -11 + p * 22 + i * .6, y = 2.5 + i * .35 + Math.sin(p * 9 + i) * .25; if (p < .92) lit.put(FR.crow[(beat + i * 3 >> 1) % 2], x, y, B(3.2 + i * .7), 1, .9, WHITE, 3, 0, 0, false); }
    // 母鸡：隔一会儿低头啄一下
    for (const h of HENS) lit.put(FR.hen[Math.sin(t * 2.1 + h.ph) > .55 ? 1 : 0], h.x + Math.floor(Math.sin(t * .23 + h.ph) * 3) * .04, 0, h.z, .9, 1, WHITE, 0, 0, 0, h.flip);
    // 彩旗：一面面三角旗挂在绳上，下角被风吹着摆
    for (const p of PENS) cast.put(p.r, p.x, p.y, p.z, 1.15, 1, WHITE, 1, 0, .06 * Math.sin(t * 5.2 + p.ph) + .03 * Math.sin(t * 9.1 + p.ph * 2));
    // 屋顶：磨坊的青旗和风向鸡，谷仓的红旗（跟着城堡一起抖、一起沉）
    { const f = MILL.flag, k = MILL.cock, g = BARN.flag;
      cast.put(FR.own[(beat >> 1) % 3], c0.x + f[0] + .36, c0.y + f[1] + TY, f[2], 1, 1.1, WHITE, 1); cast.put(FR.foe[((beat >> 1) + 1) % 3], c1.x + g[0] + .36, c1.y + g[1] + TY, g[2], 1, 1.1, WHITE, 1);
      const ck = Math.floor(t / 1.4); cast.put(FR.cock[COCK[ck % 8]], c0.x + k[0], c0.y + k[1] + TY, k[2], .8, 1, WHITE, 0, 0, 0, (ck >> 3) % 2 > 0); }
    // 流水：水槽口落下来的两截水帘（四拍循环）、池里的水花
    { const f = MILL.fall, x = c0.x + f[0], y = c0.y + TY, fr = FR.fall[beat % 4];
      glow.put(fr, x, y + f[1] - 1.0, f[2], 1, GK.mid, WHITE); glow.put(fr, x, y + MILL.pool, f[2], (f[1] - 1.0 - MILL.pool), GK.mid, WHITE);
      glow.put(FR.foam[beat % 2], x - .02, y + MILL.pool - .04, f[2] + .1, .9, GK.mid, WHITE); glow.put(FR.foam[(beat + 1) % 2], x - .7, y + MILL.pool - .05, f[2] + .32, .7, GK.lo, WHITE, 0, 0, 0, true); }
    // 篝火：三层火苗按拍跳帧；火星一颗颗升上去
    for (let i = 0; i < 3; i++) glow.put(FR.flame[(beat + i * 2) % 6], FIREP[0] + (i - 1) * .22, .12 + (i === 1 ? .08 : 0), FIREP[2] + .02 + i * .01, i === 1 ? 1.25 : .85, low ? 1.1 : 1.3, WHITE, 0, 0, 0, i === 2);
    for (let i = 0; i < NEMB; i++) { const life = frac(t * (.32 + rr(i, 41) * .3) + rr(i, 42)), k = (1 - life) * (low ? 1.1 : 1.7); glow.put(FR.dot, FIREP[0] + Math.sin(life * 6 + i) * .22 + (rr(i, 43) - .5) * .5, .7 + life * 2.2, FIREP[2] + (rr(i, 44) - .5) * .3, 1.2, k, FIRE, 3); }
    for (const c of CANDLES) glow.put(FR.cand[(beat + (c[0] > -1.7 ? 2 : 0)) % 4], c[0], c[1], c[2], 1, GK.hi, WHITE);
    // 南瓜灯：脸上的烛光一抖一抖
    for (const j of JACKS) { const ox = j.cg ? j.cg.position.x : 0, oy = j.cg ? j.cg.position.y + TY : 0, k = low ? Math.min(1.15, flick(j.x * 3, t * .8)) : 1.5 * flick(j.x * 3, t * .8); glow.put(j.big ? FR.jackL : FR.jackM, ox + j.x, oy + j.y, j.z + .012, j.s, k, WHITE); }
    // 串灯：一颗颗灯泡沿着绳子挨个亮起来、暗下去；纸灯笼轻轻晃
    for (const b of BULBS) { const k = .45 + .75 * Math.max(0, Math.sin(t * 2.4 - b.i * .85 + b.s * 1.7)) ** 2; glow.put(FR.bulb, b.x, b.y - .15, b.z, 1.25, k * GK.hi, b.c); soft.put(null, b.x, b.y - .08, b.z + .02, .62, .34 * k * LOOK.halo, b.c, 3); }
    for (const h of HANGS) { const sw = Math.sin(t * 1.1 + h.ph) * .035; glow.put(h.r, h.x, h.y, h.z, .85, GK.mid, WHITE, 1, 0, sw); soft.put(null, h.x + sw, h.y - .22, h.z + .03, 1.25, .34 * LOOK.halo, h.col, 3); }
    // 灯：光晕朝镜头；地上各躺一摊暖光；点光跟着抖
    for (const l of LAMPS) { const k = l.flick ? flick(l.i, t) : 1, ox = l.cg ? l.cg.position.x : 0, oy = l.cg ? l.cg.position.y + TY : 0;
      soft.put(null, ox + l.x, oy + l.y, l.z + .06, l.size, l.a * k * LOOK.halo, l.col, 3); if (l.pool) soft.put(null, l.x, .016, l.z + .25, l.pool, .3 * k * LOOK.halo, l.col, 2);
      if (l.light) l.light.intensity = l.power * LOOK.lamp * k; }
    // 落叶：枫叶打着旋儿往下飘
    for (let i = 0; i < NLEAF; i++) { const life = frac(t * (.07 + rr(i, 51) * .06) + rr(i, 52)), y = 4.2 - life * 4.4; if (y < .05) continue;
      glow.put(FR.leaf[i % 3][(beat + i >> 1) % 2], (rr(i, 53) * 2 - 1) * (HX + 5.5) + Math.sin(life * 11 + i) * .4 + life * .9, y, B(5.5) + rr(i, 54) * (HZ * 2 + 6.5), 1.15, .92, WHITE, 3, Math.floor(life * 14 + i) * .8); }
    // 萤火虫：在麦田和草地上一明一灭
    for (let i = 0; i < NFLY; i++) { const a = t * (.22 + rr(i, 61) * .3) + rr(i, 62) * TAU, k = Math.max(0, Math.sin(t * (1.1 + rr(i, 63)) + i * 2.1)) ** 2 * (low ? 1.1 : 1.7), side = i % 3 === 0; if (k < .08) continue;
      glow.put(FR.dot, side ? (i % 2 ? 1 : -1) * (HX + 2.7 + rr(i, 64) * 3.4) + Math.cos(a) * .35 : (rr(i, 64) * 2 - 1) * (HX + 5) + Math.cos(a) * .4, .25 + rr(i, 65) * 1.3 + Math.sin(a * 1.3) * .18, side ? B(2.2) + rr(i, 66) * (HZ * 2 + 2.5) : B(2.6 + rr(i, 66) * 2.6) + Math.sin(a) * .3, 1.3, k, FLYC, 3); }
    // 炊烟：烟囱和篝火上一团团像素烟，越升越大、越淡
    for (const s of SMOKES) for (let k = 0; k < s.n; k++) { const life = frac(t / 4.2 + k / s.n + s.x * .13), ox = s.cg ? s.cg.position.x : 0, oy = s.cg ? s.cg.position.y : 0;
      glow.put(FR.puff[Math.min(2, Math.floor(life * 3))], ox + s.x + life * .7 + Math.sin(life * 4 + k) * .12, oy + s.y + life * s.rise, s.z, .8 + life * .5, .55 * (1 - life * .6), SMOKE, 3); }
    // 烟花：后方天上两处，隔几秒升起一发、绽开（像素小点，会被移轴虚成一团团光斑）
    for (let n = 0; n < 2; n++) {
      const T0 = 6.8, q = t / T0 + n * .46 + .34, id = Math.floor(q), p = q - id, z = B(11.2), x0 = (n ? 1.7 : -.2) + (rr(id, 71 + n) - .5) * 1.4, yb = yAt(z) - G0, top = yb + .8 + rr(id, 73 + n) * .3, col = FWC[(id + n * 2) % 5];
      if (p < .16) { const k = p / .16; for (let j = 0; j < 3; j++) glow.put(FR.dot, x0, yb + .1 + (top - yb - .1) * (k - j * .06) * (2 - k), z, 2.2, (low ? 1 : 1.3) * (1 - j * .3), CREAM, 3); }
      else if (p < .62) { const k = (p - .16) / .46, rad = .85 * (1 - Math.exp(-4.2 * k)), fade = (1 - k) ** .8 * (low ? 1.15 : 1.6);
        for (let j = 0; j < NSPARK; j++) { const a = j / NSPARK * TAU + id, ring = j % 3 === 0 ? .55 : 1, tw = (beat + j) % 3 ? 1 : .5; glow.put(j % 4 ? FR.dot : FR.star, x0 + Math.cos(a) * rad * ring, top + Math.sin(a) * rad * ring - k * k * .3, z, j % 4 ? 3.4 : 2.6, fade * tw, j % 5 === 0 ? CREAM : col, 3);
          if (j % 2) glow.put(FR.dot, x0 + Math.cos(a) * rad * ring * .8, top + Math.sin(a) * rad * ring * .8 - k * k * .24, z, 2.4, fade * .5, col, 3); }
        soft.put(null, x0, top, z + .1, 3 + k * 1.6, .4 * (1 - k) * LOOK.halo, col, 3); }
    }
    // 贴着镜头的前景
    for (const f of FORE) { v3.set(f.nx, f.ny, .5).unproject(camera).sub(eye).normalize(); fore.put(f.r, eye.x + v3.x * f.d, eye.y + v3.y * f.d - G0, eye.z + v3.z * f.d, f.s, 1, f.tint, 3, 0, 0, f.flip); }
    for (const k in RL) RL[k].end();
  }
  const again = () => requestAnimationFrame(() => tick(last));     // 镜头是 build 之后才摆好的、窗口大小也会变：补摆一次（开了「减少动态效果」时游戏不调 tick，全靠这个）
  addEventListener('resize', again); again(); setTimeout(again, 400);
  scene.updateMatrixWorld(true); tick(0);
  return { tick };
}
