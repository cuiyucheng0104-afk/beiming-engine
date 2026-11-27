// 《沉水擂台》· B 版擂台，接进对战盘（board3d.js 的「自定义擂台」接口，地址带 ?arena=b 时用）。
// 这个文件夹自成一套：画法在 ink.js（浮雕着色、六级色阶），场景贴图在 stone.js，小件在 cards.js，全部逐像素算出来，
// 没有外部图片，也不和 arenas/c-zhai 共用任何东西。这里只有画法代码和一份普通的 three.js 场景，不带任何渲染运行时。
// 场面：一座泡在水里的遗迹擂台。左边是本方的霜祠（青），右边是对面的焰祠（红），后面是带兽面水口的残墙，水从兽嘴里落进池子。
// 棋盘规则、棋子、格子的点击、城堡血量牌都还是游戏自己的；这里只管「看起来是什么地方」：
//   · 实体    水面、石台、祠、残墙、柱、岸、树干、船：按材质拼成几十张网格（一种贴图一张）
//   · 像素片  几百张平的小片拼成一张图集，按「受光并投影 / 受光 / 自发光三档」分层，各拼成一张网格；会动的每帧重摆
//   · 光      偏紫的冷暗环境 + 从左后方树冠豁口斜下来的暖金阳光（一片只投影的镂空板挡出光斑，擂台上方留一整块亮的）+ 青 / 橙两色的灯
//   · 会动的  火和幽火（按拍跳帧）、瀑布和水花、涟漪、水面的闪光、锦鲤、漂灯、花瓣、萤火、浮尘、光柱、水汽、灯的明灭
// build(ctx) 只调一次，返回 { tick(t, dt) }：t 是场景自己的钟（秒），游戏每帧调一次（「减少动态效果」时不调）。
// 坐标：x 向右（本方 → 对面），z 朝镜头，y 向上。场景自己的东西都放在组 W 里，W 里水面是 y = 0、盘面是 y = TOP。
import * as ST from './stone.js';
import { INK } from './ink.js';
import { sprites, glows } from './cards.js';

const PPM = 48, TOP = .5;
// 调画面只改这一组数。游戏不做胶片曲线、棋子不吃光（永远是贴图原色），所以四周压暗、往紫里偏，棋子是画面里最亮最暖的东西
const LOOK = {
  bg: '#0a0418', fog: '#1e0f3c',
  amb: ['#7a5ac8', 1.25], sun: ['#ffc870', 4.3], fill: ['#8f7cf0', .95], lamp: 3.6,
  glow: { hi: 1.55, mid: 1.15, lo: .8, far: .42 },          // 自发光片的亮度（高画质档超过 1 的部分会晕开）
  halo: .8, shaft: .2,
  bloom: [.5, .72, .86],                                    // 强度、半径、亮过多少才发光
  tilt: { focus: .44, band: .22, amt: 2 },                  // 移轴：清楚的一带压在棋盘上，往上往下虚得比原来重
  grade: { sat: 1.2, con: 1.08, knee: .82, gain: [1.03, .98, 1.05], lift: [.018, .004, .03], edge: [.03, 0, .06] },
};
const SUN_FROM = [-7.5, 16, -8.5], TILT = -.16;
// 确定性随机
function rnd(i, k = 0) {
  let n = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}
const flick = (i, t) => 1 + .14 * Math.sin(t * 9.1 + i * 2.3) + .08 * Math.sin(t * 23.7 + i * 5.1);
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mad = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UPN = unit([0, .9, .44]), SUND = unit(SUN_FROM);       // 立着的片的法线：朝上偏前，背后来的斜阳才照得到
const gn = (x, z, k) => { const xi = Math.floor(x), zi = Math.floor(z), u = x - xi, v = z - zi, s = t => t * t * (3 - 2 * t), g = (a, b) => rnd(a * 131 + b * 17 + 4000, k); return (g(xi, zi) * (1 - s(u)) + g(xi + 1, zi) * s(u)) * (1 - s(v)) + (g(xi, zi + 1) * (1 - s(u)) + g(xi + 1, zi + 1) * s(u)) * s(v); };

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, grid } = ctx;
  const { ROWS, COLS, LX, LZ, HALF: HX, DEPTH, tileZ } = grid, HZ = DEPTH / 2;
  const TW = Math.round(LX * PPM), TH = Math.round(LZ * PPM), RIM = 16;       // 盘面贴图：一格 TW × TH 像素，外加 RIM 像素石沿
  const DX = HX + RIM / TW * LX, DZ = HZ + RIM / TH * LZ, SX = DX + .42, SZ = DZ + .42, SY = .16;   // 石台半宽半深；泡在水里的那圈矮台
  const GATE = HX + 1.3, SHW = .72, PW = 1.9, PD = 4.5, BANK = GATE + 1.2;    // 祠心（就是游戏放城堡的地方）、祠门柱距、祠台宽深、两侧草岸从哪开始
  // 布局原来是照 6.3 × 4.32 米的盘面排的：盘面以内按比例缩，以外整体挪
  const fx = x => Math.abs(x) <= 3.15 ? x * HX / 3.15 : Math.sign(x) * (Math.abs(x) - 3.15 + HX);
  const fz = z => Math.abs(z) <= 2.16 ? z * HZ / 2.16 : Math.sign(z) * (Math.abs(z) - 2.16 + HZ);
  const BACK = fz(-4.55), FALLZ = BACK + .45;                                 // 后墙、瀑布
  const onDais = (x, z, m = .25) => Math.abs(x) < SX + m && Math.abs(z) < SZ + m;
  const onShrine = (x, z) => Math.abs(Math.abs(x) - GATE) < PW / 2 + .15 && Math.abs(z) < PD / 2 + .1;
  const isWater = (x, z) => !onDais(x, z, 0) && !onShrine(x, z) && Math.abs(x) < BANK && z > BACK + .6;
  const W = new THREE.Group(); W.position.y = -TOP; scene.add(W);

  // —— 材质：一张贴图一个 ——
  const px = c => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; return t; };
  const lit = c => new THREE.MeshLambertMaterial({ map: px(c) });
  const M = {
    wall: lit(ST.masonry({ seed: 1, ink: INK.mauve, alt: INK.rust, moss: .16 })), wallDark: lit(ST.masonry({ seed: 21, ink: INK.night2, alt: INK.mauve, moss: .3, rowH: 12 })),
    wallFrost: lit(ST.masonry({ seed: 41, ink: INK.slateOwn, alt: INK.ice, moss: .08, rowH: 12 })),
    frieze: lit(ST.frieze({ h: 16 })), beast: lit(ST.beast()), planks: lit(ST.planks()), water: lit(ST.water()), turf: lit(ST.turf()), cliff: lit(ST.cliff()), bark: lit(ST.bark()),
    tiles: lit(ST.scales({ ink: INK.clay })), tilesIce: lit(ST.scales({ ink: INK.slateOwn, seed: 31 })), column: lit(ST.column()), ice: lit(ST.ice()), lacquer: lit(ST.lacquer()),
    bone: lit(ST.bone()), hull: lit(ST.hull()),
  };
  const glowM = (hex, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) });
  const GM = { bulb: glowM('#ffd27a', 1.5), eye: glowM('#40ffe0', 1.8), coal: glowM('#ff7020', 1.4), ice: glowM('#38d8f0', .6), ember: glowM('#ff7020', .8) };
  const twoSided = new Map(), two = m => twoSided.get(m) ?? (twoSided.set(m, Object.assign(m.clone(), { side: THREE.DoubleSide })), twoSided.get(m));
  const img = m => m.map.image;

  // —— 实体的零件（都返回「几何体 + 材质 + 用哪一段三角形」的清单）。贴图按真实尺寸铺（每米 48 像素），不拉伸 ——
  function box(w, h, d, side, top = side, seed = 0) {            // 四周一种贴图、顶面一种；不要底
    const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const im = img(f === 2 ? top : side), ox = Math.floor(rnd(seed, f) * im.width), oy = f === 2 ? 0 : im.height - (Math.round(dims[f][1] * PPM) % im.height);
      for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, (uv.getX(k) * dims[f][0] * PPM + ox) / im.width, (uv.getY(k) * dims[f][1] * PPM + oy) / im.height); }
    }
    return [[g, side, 0, 12], [g, top, 12, 18], [g, side, 24, 36]];
  }
  function drum(r0, r1, h, m, seg = 12) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg), uv = g.attributes.uv, im = img(m);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(Math.PI * (r0 + r1) * PPM / im.width)), uv.getY(i) * h * PPM / im.height);
    return [[g, m]];
  }
  function rock(r, m, sq = [1, .6, 1]) {
    const g = new THREE.DodecahedronGeometry(r, 0).scale(...sq), uv = g.attributes.uv, im = img(m);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6.28 * r * PPM / im.width, uv.getY(i) * 3.14 * r * PPM / im.height);
    g.computeVertexNormals(); return [[g, m]];
  }
  function gable(w, d, h, m, over = .16) {                       // 人字顶：屋脊顺着 x。贴图按坡面的真实长度铺
    const hw = w / 2 + over, hd = d / 2 + over, sl = Math.hypot(hd, h), im = img(m), U = w * PPM / im.width, V = sl * PPM / im.height;
    const P = [-hw, 0, hd, hw, 0, hd, -hw, h, 0, hw, h, 0, hw, 0, -hd, -hw, 0, -hd, hw, h, 0, -hw, h, 0, -hw, 0, hd, -hw, h, 0, -hw, 0, -hd, hw, 0, -hd, hw, h, 0, hw, 0, hd];
    const T = [0, 0, U, 0, 0, V, U, V, 0, 0, U, 0, 0, V, U, V, 0, 0, .5, V * .5, 1, 0, 0, 0, .5, V * .5, 1, 0];
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2));
    g.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 8, 9, 10, 11, 12, 13]); g.computeVertexNormals();
    return [[g, two(m)]];
  }
  const face = (w, h, m) => [[new THREE.PlaneGeometry(w, h), m]];
  const ball = (r, m) => [[new THREE.SphereGeometry(r, 8, 6), m]];
  const slab = (w, h, d, m) => [[new THREE.BoxGeometry(w, h, d), m]];

  // —— 石场：把零件按材质收成一堆堆，最后一种材质拼成一张网格 ——
  function Yard(parent) {
    const bins = new Map(), mat = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(), at = new THREE.Vector3();
    return {
      add(piece, x = 0, y = 0, z = 0, rot = [0, 0, 0]) {
        mat.compose(at.set(x, y, z), q.setFromEuler(e.set(rot[0], rot[1], rot[2])), one);
        for (const [g, m, from = 0, to = Infinity] of piece) {
          let b = bins.get(m); if (!b) bins.set(m, b = { p: [], n: [], u: [] });
          const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, I = g.index, end = Math.min(to, I ? I.count : P.count);
          for (let k = from; k < end; k++) { const i = I ? I.getX(k) : k; v.fromBufferAttribute(P, i).applyMatrix4(mat); b.p.push(v.x, v.y, v.z); v.fromBufferAttribute(N, i).transformDirection(mat); b.n.push(v.x, v.y, v.z); b.u.push(U.getX(i), U.getY(i)); }
        }
      },
      done() {
        for (const [m, b] of bins) {
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
          const mesh = new THREE.Mesh(g, m); mesh.castShadow = mesh.receiveShadow = !m.isMeshBasicMaterial; parent.add(mesh);
        }
      },
    };
  }

  // —— 像素片：一张图集，按层拼网格 ——
  function pack(set, pad, smooth) {
    const names = Object.keys(set).sort((a, b) => set[b].height - set[a].height), AW = 512, rects = {}; let x = pad, y = pad, rowH = 0;
    for (const n of names) { const c = set[n]; if (x + c.width + pad > AW) { x = pad; y += rowH + pad; rowH = 0; } rects[n] = [x, y, c.width, c.height]; x += c.width + pad; rowH = Math.max(rowH, c.height); }
    const cv = document.createElement('canvas'); cv.width = AW; cv.height = y + rowH + pad; const g = cv.getContext('2d'); for (const n of names) g.drawImage(set[n], rects[n][0], rects[n][1]);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; if (!smooth) { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    const out = {}; for (const n of names) { const [rx, ry, rw, rh] = rects[n]; out[n] = { uv: [rx / AW, 1 - ry / cv.height, (rx + rw) / AW, 1 - (ry + rh) / cv.height], w: rw / PPM, h: rh / PPM }; }
    return { tex: t, at: out };
  }
  const ATLAS = pack(sprites(), 1, false), GLOW = pack(glows(), 2, true);
  const cardLit = new THREE.MeshLambertMaterial({ map: ATLAS.tex, alphaTest: .5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  const cardGlow = k => new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, side: THREE.DoubleSide, color: new THREE.Color(k, k, k) });
  const GK = low ? { hi: 1.15, mid: 1, lo: .75, far: .42 } : LOOK.glow;
  const LAYER = { cast: cardLit, lit: cardLit, hi: cardGlow(GK.hi), mid: cardGlow(GK.mid), lo: cardGlow(GK.lo), far: new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, side: THREE.DoubleSide, color: new THREE.Color('#8a7ae0').multiplyScalar(GK.far) }) };
  // 一张片的四个角（左上、右上、左下、右下）。k: up 立着（锚在底边中点，往后仰一点）· flat 躺着（锚在中心）· face 朝镜头（锚在中心）
  function corners(c, R, U) {
    const r = ATLAS.at[c.n]; if (!r) throw new Error(`图集里没有 ${c.n}`);
    const s = c.s ?? 1, hw = r.w * s / 2, hh = r.h * s, p = c.p;
    if (c.k === 'flat') { const cy = Math.cos(c.yaw ?? 0), sy = Math.sin(c.yaw ?? 0), ax = [cy * hw, 0, -sy * hw], az = [sy * hh / 2, 0, cy * hh / 2]; return [mad(mad(p, ax, -1), az, -1), mad(mad(p, ax), az, -1), mad(mad(p, ax, -1), az), mad(mad(p, ax), az)]; }
    if (c.k === 'face') { const cr = Math.cos(c.roll ?? 0), sr = Math.sin(c.roll ?? 0), ax = mad([R[0] * cr * hw, R[1] * cr * hw, R[2] * cr * hw], U, sr * hw), ay = mad([U[0] * cr * hh / 2, U[1] * cr * hh / 2, U[2] * cr * hh / 2], R, -sr * hh / 2); return [mad(mad(p, ax, -1), ay), mad(mad(p, ax), ay), mad(mad(p, ax, -1), ay, -1), mad(mad(p, ax), ay, -1)]; }
    const t = c.tilt ?? TILT, cy = Math.cos(c.yaw ?? 0), sy = Math.sin(c.yaw ?? 0), ax = [cy * hw, 0, -sy * hw], ay = [Math.sin(t) * sy * hh, Math.cos(t) * hh, Math.sin(t) * cy * hh];
    return [mad(mad(p, ax, -1), ay), mad(mad(p, ax), ay), mad(p, ax, -1), mad(p, ax)];
  }
  const uvOf = c => { const u = ATLAS.at[c.n].uv; return c.flip ? [u[2], u[1], u[0], u[3]] : u; };
  // 不动的片：一层一张网格
  function Deck(parent) {
    const L = {};
    const put = (layer, c) => { const b = L[layer] ??= { p: [], n: [], u: [], i: [] }, q = corners(c), uv = uvOf(c), i = b.p.length / 3, nm = c.k === 'flat' ? [0, 1, 0] : UPN;
      for (const v of q) { b.p.push(v[0], v[1], v[2]); b.n.push(nm[0], nm[1], nm[2]); } b.u.push(uv[0], uv[1], uv[2], uv[1], uv[0], uv[3], uv[2], uv[3]); b.i.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); };
    return {
      up: (layer, n, x, y, z, s = 1, o = {}) => put(layer, { n, p: [x, y, z], s, k: 'up', ...o }),
      flat: (layer, n, x, y, z, s = 1, o = {}) => put(layer, { n, p: [x, y, z], s, k: 'flat', ...o }),
      done() { for (const [layer, b] of Object.entries(L)) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setIndex(b.i);
        const m = new THREE.Mesh(g, LAYER[layer]); m.castShadow = layer === 'cast'; m.receiveShadow = layer === 'cast' || layer === 'lit'; parent.add(m); } },
    };
  }
  // 会动的片：预先留好位置，每帧重写
  function Live(cap, material, tinted = false) {
    const P = new Float32Array(cap * 12), U = new Float32Array(cap * 8), C = tinted ? new Float32Array(cap * 12) : null, I = new Uint16Array(cap * 6);
    for (let k = 0; k < cap; k++) I.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3], k * 6);
    const g = new THREE.BufferGeometry(), dyn = (a, n) => { const b = new THREE.BufferAttribute(a, n); b.setUsage(THREE.DynamicDrawUsage); return b; };
    g.setAttribute('position', dyn(P, 3)); g.setAttribute('uv', dyn(U, 2)); if (C) g.setAttribute('color', dyn(C, 3)); g.setIndex(new THREE.BufferAttribute(I, 1));
    const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; W.add(mesh); let n = 0;
    return {
      mesh, begin() { n = 0; },
      quad(q, uv, a = 1) { if (n >= cap) return; for (let k = 0; k < 4; k++) { P[n * 12 + k * 3] = q[k][0]; P[n * 12 + k * 3 + 1] = q[k][1]; P[n * 12 + k * 3 + 2] = q[k][2]; if (C) C[n * 12 + k * 3] = C[n * 12 + k * 3 + 1] = C[n * 12 + k * 3 + 2] = a; }
        U.set([uv[0], uv[1], uv[2], uv[1], uv[0], uv[3], uv[2], uv[3]], n * 8); n++; },
      end() { g.setDrawRange(0, n * 6); g.attributes.position.needsUpdate = g.attributes.uv.needsUpdate = true; if (C) g.attributes.color.needsUpdate = true; },
    };
  }

  // —— 场地上的固定点 ——
  const STATUES = [[-1, 1, .62], [1, 1, .62], [-1, -1, 1.5], [1, -1, 1.5]].map(([sx, sz, h]) => ({ x: sx * (DX + .1), z: sz * (DZ + .1), h, own: sx < 0 }));   // 擂台四角的兽首石座，头顶一盆火（本方是青的幽火）
  const POSTS = [[-3.0, 3.72, 1.5], [3.35, 3.6, 1.25], [-6.3, -1.9, 1.9], [6.25, -2.3, 1.7], [-1.9, -3.75, 1.3], [2.0, -3.75, 1.1]].map(([x, z, h]) => ({ x: fx(x), z: fz(z), h }));   // 骨白色的灯杆
  const PILLARS = [[-5.6, -3.5, 3.5, .34, 0], [-3.6, -3.55, 2.1, .32, 1], [3.6, -3.55, 3.1, .32, 0], [5.7, -3.5, 1.5, .34, 1]].map(([x, z, h, r, broken]) => ({ x: fx(x), z: fz(z), h, r, broken }));   // 后墙前的一排残柱
  const FLOATS = Array.from({ length: 13 }, (_, i) => { const a = rnd(i, 31) * 6.28, front = i < 8; return front ? { x: fx(-5.6 + rnd(i, 32) * 11.2), z: fz(3.25 + rnd(i, 33) * 1.25), a } : { x: (i % 2 ? 1 : -1) * rnd(i, 34) * (BANK - .4), z: BACK + .9 + rnd(i, 35) * .9, a }; }).filter(f => isWater(f.x, f.z));   // 漂在水上的纸灯
  const BOAT = { x: fx(-1.3), z: fz(4.1) }, JETTY = { x: fx(-3.6), z: fz(4.15) };
  const SPOTS = []; for (let i = 0; SPOTS.length < 90 && i < 2000; i++) { const back = rnd(i, 301) > .45, x = (rnd(i, 302) * 2 - 1) * (BANK - .1), z = back ? BACK + .7 + rnd(i, 303) * (-SZ - BACK - .7) : (rnd(i, 304) > .5 ? SZ + rnd(i, 303) * 1.6 : -SZ + rnd(i, 303) * 2 * SZ); if (isWater(x, z) && !(Math.abs(x) < .9 && z < FALLZ + .5)) SPOTS.push([x, z]); }   // 水面上随手取的点（闪光、涟漪用）

  // —— 实体 ——
  const Y = Yard(W), D = Deck(W);
  // 水面（贴图会慢慢流）和上面一层反着流的亮纹
  const waterT = M.water.map, sheenT = waterT.clone(); sheenT.needsUpdate = true; sheenT.repeat.set(.63, .63); sheenT.rotation = .5;
  { const w = 34, d = 28, g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * PPM / 256, uv.getY(i) * d * PPM / 256);
    const m = new THREE.Mesh(g, M.water); m.receiveShadow = true; m.position.set(0, 0, 1); W.add(m);
    const s = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: sheenT, color: new THREE.Color('#2c7484'), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })); s.position.set(0, .004, 1); W.add(s); }
  for (const s of [-1, 1]) {
    Y.add(box(5.5, 1.4, 14, M.cliff, M.turf, 40 + s), s * (BANK + 2.75), .02, .6);                       // 两侧草岸
    Y.add(box(1.1, .5, 3.2, M.cliff, M.turf, 44 + s), s * (BANK - .15), 0, BACK + 1.6 + s * .4);        // 岸边矮一级的石阶
    Y.add(box(.8, .34, 2.2, M.wall, M.turf, 46 + s), s * (BANK - .3), 0, fz(3.4));
  }
  Y.add(box(26, 1.8, 6, M.cliff, M.turf, 48), 0, .3, BACK - 3.15);                                       // 后岸
  for (let i = 0; i < 18; i++) {                                                                         // 水里的石头、倒下的柱段
    const a = rnd(i, 201), x = i < 6 ? (rnd(i, 204) * 2 - 1) * (SX - .3) : (i % 2 ? 1 : -1) * (SX + .3 + a * (BANK - SX - .6)), z = i < 6 ? BACK + .9 + rnd(i, 202) * .9 : fz(-3.2 + rnd(i, 202) * 7.4);
    if (!isWater(x, z) || Math.abs(x) < 1.1 && z < FALLZ + .8) continue;
    if (i % 5 === 0) Y.add(drum(.24, .24, .7, M.column, 10), x, .12, z, [0, a * 3, Math.PI / 2 - .12]); else Y.add(rock(.2 + rnd(i, 203) * .22, M.cliff), x, .02, z, [0, a * 6, 0]);
  }
  for (let i = 0; i < 9; i++) Y.add(rock(.3 + rnd(i, 211) * .35, M.cliff, [1, .7, 1]), -7.5 + i * 1.9 + rnd(i, 212), 1.25, BACK - .55 - rnd(i, 213) * .5, [0, i, 0]);
  // 擂台：泡在水里的矮台 + 带饰带的台身 + 盘面（石沿露在格子外面一圈）
  Y.add(box(SX * 2, SY + .4, SZ * 2, M.wallDark, M.wallDark, 1), 0, (SY - .4) / 2, 0);
  Y.add(box(DX * 2, TOP - SY, DZ * 2, M.frieze, M.wall, 2), 0, (TOP + SY) / 2, 0);
  { const bt = ST.board({ rows: ROWS, lanes: COLS, tw: TW, th: TH, rim: RIM });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(DX * 2, DZ * 2).rotateX(-Math.PI / 2), lit(bt)); plane.receiveShadow = true; plane.position.y = TOP + .002; W.add(plane);
    // 格子：还是游戏那 20 块（点击、抬起都靠它们），一块一张从盘面贴图上切下来的石板；四条边取贴图左上角那颗墨色像素
    for (const t of tiles) { const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.getContext('2d').drawImage(bt, -RIM - t.userData.r * TW, -RIM - t.userData.c * TH);
      const m = new THREE.CanvasTexture(cv); m.magFilter = m.minFilter = THREE.NearestFilter; m.generateMipmaps = false; m.colorSpace = THREE.SRGBColorSpace; t.material = new THREE.MeshLambertMaterial({ map: m }); } }
  for (const st of STATUES) {                                                                            // 四角石座 + 火盆
    Y.add(box(.5, st.h, .5, M.wall, M.wall, 60), st.x, st.h / 2, st.z); Y.add(box(.6, .08, .6, M.frieze, M.wall, 61), st.x, st.h - .04, st.z);
    if (st.h > 1) { Y.add(face(.46, .52, M.beast), st.x, st.h - .42, st.z + .256); for (const s of [-1, 1]) Y.add(ball(.035, st.own ? GM.eye : GM.coal), st.x + s * .093, st.h - .385, st.z + .262); }
    Y.add(drum(.21, .13, .13, M.lacquer, 8), st.x, st.h + .065, st.z);
    D.up('mid', st.own ? 'glyph' : 'glyphFoe', st.x, st.h * .2 + .02, st.z + .262, .8, { tilt: 0 });
  }
  // 后墙：中段高、嵌一张兽面（嘴是水口），两翼残破；前面一排残柱
  Y.add(box(4.4, 3.6, .5, M.wall, M.wall, 90), 0, 1.8, BACK); Y.add(box(4.7, .22, .62, M.frieze, M.wall, 91), 0, 3.71, BACK);
  Y.add(face(1.62, 1.82, M.beast), 0, 2.2, BACK + .255); Y.add(box(.7, .16, .34, M.wall, M.wall, 92), 0, 1.36, BACK + .39);
  for (const s of [-1, 1]) Y.add(ball(.085, GM.eye), s * .33, 2.33, BACK + .34);
  for (let i = 0; i < 11; i++) {
    const left = i < 6, x = left ? -2.2 - (i + .5) * .98 : 2.2 + (i - 5.5) * 1.16, h = (left ? 2.5 : 2.0) - (i % 3) * .34 - rnd(i, 221) * .3;
    Y.add(box(left ? .98 : 1.16, h, .46, i % 2 ? M.wall : M.wallDark, M.turf, 93 + i), x, h / 2, BACK - .02);
  }
  for (const p of PILLARS) {
    Y.add(box(p.r * 2.5, .2, p.r * 2.5, M.wall, M.wall, 110), p.x, .1, p.z); Y.add(drum(p.r * .88, p.r, p.h, M.column, 12), p.x, p.h / 2 + .15, p.z);
    if (p.broken) Y.add(rock(p.r * 1.05, M.column, [1, .5, 1]), p.x + .05, p.h + .12, p.z, [.3, 1, .2]);
    else { Y.add(box(p.r * 2.6, .2, p.r * 2.6, M.frieze, M.wall, 111), p.x, p.h + .25, p.z); Y.add(box(p.r * 3, .1, p.r * 3, M.wall, M.turf, 112), p.x, p.h + .4, p.z); D.up('hi', 'lantern', p.x - p.r - .14, p.h - .95, p.z + .12, .85, { tilt: 0 }); }
    D.up('cast', 'vine', p.x + .1, p.h - 1.5, p.z + p.r + .03, 1, { tilt: 0 }); D.up('mid', 'glyph', p.x, p.h * .55, p.z + p.r + .04, 1, { tilt: 0 }); D.up('cast', 'fern', p.x - .25, SY - .1, p.z + p.r + .1, .9);
  }
  // 灯杆、前面的栈台和小船、大树干
  for (const p of POSTS) { Y.add(drum(.035, .045, p.h + .5, M.bone, 6), p.x, (p.h - .2) / 2, p.z); Y.add(box(.2, .03, .2, M.bone, M.bone, 120), p.x, p.h + .09, p.z); Y.add(ball(.105, GM.bulb), p.x, p.h + .22, p.z); }
  Y.add(box(2.5, .08, .95, M.planks, M.planks, 121), JETTY.x, .22, JETTY.z);
  for (const [dx, dz] of [[-1.15, -.4], [1.15, -.4], [-1.15, .4], [1.15, .4], [0, -.4]]) Y.add(drum(.055, .06, .7, M.bark, 6), JETTY.x + dx, 0, JETTY.z + dz);
  Y.add(box(1.15, .2, .46, M.hull, M.planks, 122), BOAT.x, .1, BOAT.z, [0, .16, 0]);
  for (const sx of [-1, 1]) Y.add([[new THREE.ConeGeometry(.23, .42, 4), M.hull]], BOAT.x + sx * .76, .11, BOAT.z - sx * .12, [0, Math.PI / 4, -sx * Math.PI / 2]);
  Y.add(drum(.02, .02, .62, M.bone, 5), BOAT.x + .05, .4, BOAT.z - .03); D.up('hi', 'lantern', BOAT.x + .05, .62, BOAT.z - .03, .75, { tilt: 0 });
  for (const [x, z, r, h] of [[-8.2, -5.6, .55, 9], [-9.6, 1.8, .6, 9], [8.6, -5.4, .5, 9], [9.5, 2.4, .62, 9], [-4.4, -6.6, .4, 8], [4.9, -6.8, .45, 8], [.6, -7.6, .5, 8]]) {
    const tx = Math.sign(x) * (Math.abs(x) - 6.05 + BANK), tz = z < -4 ? BACK + z + 4.05 : z;
    Y.add(drum(r * .8, r * 1.15, h, M.bark, 10), tx, h / 2 + .6, tz);
    for (let i = 0; i < 4; i++) { const a = i * 1.57 + x; Y.add(rock(r * .7, M.bark, [1.3, .5, .7]), tx + Math.cos(a) * r * 1.2, 1.25, tz + Math.sin(a) * r * 1.2, [0, -a, 0]); }
  }
  Y.done();

  // —— 两座祠：搭在游戏给的两个城堡组里（组本身挨打会抖、被攻破会下沉，祠跟着动）。组的原点在盘面高度，所以这里的高度都减掉 TOP ——
  castles.forEach((cg, i) => {
    const own = i === 0, s = own ? -1 : 1, Ys = Yard(cg), Ds = Deck(cg), a = (pc, x, y, z, rot) => Ys.add(pc, x, y - TOP, z, rot), up = (l, n, x, y, z, sc, o) => Ds.up(l, n, x, y - TOP, z, sc, o);
    const roofM = own ? M.tilesIce : M.tiles, postM = own ? M.column : M.lacquer, backM = own ? M.wallFrost : M.wallDark;
    a(box(PW, TOP + .4, PD, own ? M.wallDark : M.wall, M.wallDark, 70 + s), 0, (TOP - .4) / 2, 0);                                     // 石台
    a(box(PW + .16, .1, PD + .16, M.frieze, M.wallDark, 71), 0, TOP - .2, 0);                                                           // 台腰一道饰带
    for (const dx of [-SHW, SHW]) { a(drum(.13, .15, 1.75, postM, 10), dx, TOP + .875, 1.12); a(box(.36, .12, .36, M.wall, M.wall, 74), dx, TOP + .06, 1.12); }   // 祠门：两根柱 + 横梁 + 瓦顶
    a(box(SHW * 2 + .7, .16, .24, postM, postM, 75), 0, TOP + 1.8, 1.12); a(box(SHW * 2 + .36, .1, .2, M.frieze, M.frieze, 76), 0, TOP + 1.55, 1.12);
    a(gable(SHW * 2 + .5, .7, .34, roofM, .1), 0, TOP + 1.88, 1.12);
    a(box(1.7, 1.9, .3, backM, M.wall, 77 + s), 0, TOP + .95, -1.2); a(box(1.8, .1, .36, M.frieze, M.wall, 78), 0, TOP + 1.3, -1.2);  // 后壁（腰上一道饰带）+ 瓦顶
    a(gable(1.9, .9, .42, roofM, .1), 0, TOP + 1.9, -1.1);
    for (const dx of [-.8, .8]) a(drum(.11, .12, 1.9, postM, 8), dx, TOP + .95, -.55);
    a(box(.86, .58, .86, own ? M.wallFrost : M.wallDark, own ? M.ice : M.frieze, 79), 0, TOP + .29, .22);                               // 祭台
    a(box(.96, .08, .96, M.frieze, own ? M.ice : M.frieze, 80), 0, TOP + .56, .22);
    if (own) a(slab(.62, .8, .05, GM.ice), 0, TOP + .8, -1.03); else { a(drum(.3, .18, .16, M.lacquer, 10), 0, TOP + .68, .32); a(slab(.7, .7, .05, GM.ember), 0, TOP + .75, -1.03); }   // 后壁上的一龛光
    Ys.done();
    const ban = own ? 'bannerOwn' : 'bannerFoe';
    up('cast', ban, -SHW, .95, 1.3, 1, { tilt: 0 }); up('cast', ban, SHW, .95, 1.3, 1, { tilt: 0, flip: true });
    up('mid', own ? 'glyph' : 'glyphFoe', 0, 1.42, -1.0, 1.2, { tilt: 0 });
    if (own) for (const [dx, y, dz, sc, fl] of [[0, 1.14, .22, 1.5, false], [-.7, TOP, .7, .8, false], [.62, TOP, .8, .65, true], [-.72, TOP, -.45, .9, true], [.7, TOP, -.3, .6, false], [.3, TOP, 1.75, .5, true], [-.5, TOP, 1.9, .42, false]]) up('hi', 'crystal', dx, y, dz, sc, { flip: fl, tilt: 0 });
    else for (const [dx, y, dz, sc] of [[-.4, 1.56, 1.26, 1], [.4, 1.56, 1.26, 1], [0, 1.74, 1.26, .8], [-.62, 1.3, -.9, .8], [.62, 1.3, -.9, .8]]) up('hi', 'lantern', dx, y, dz, sc, { tilt: 0 });
    for (let k = 0; k < 6; k++) up('cast', k % 2 ? 'fern' : 'tuft', (rnd(k, 61 + s) - .5) * (PW - .2), TOP - .02, 1.6 + rnd(k, 63) * .5, .8, { flip: k % 2 > 0 });
    for (let k = 0; k < 4; k++) up('cast', k % 2 ? 'tuft' : 'reed', (rnd(k, 65 + s) - .5) * (PW - .3), TOP - .02, -1.75 - rnd(k, 66) * .4, .8, { flip: k % 2 > 0 });
    for (let c = 0; c < COLS; c++) Ds.flat('mid', own ? 'runeOwn' : 'runeFoe', -s * (PW / 2 - .44), .006, tileZ(c), .82);              // 每条路的门槛上一枚队伍色的符文
    Ds.done();
  });

  // —— 不动的像素片 ——
  for (let i = 0, n = 0; n < (low ? 50 : 84) && i < 1400; i++) {                                         // 水面：莲叶、莲花
    const x = (rnd(i, 1) * 2 - 1) * (BANK - .15), z = BACK + .75 + rnd(i, 2) * (fz(4.9) - BACK - .75);
    if (!isWater(x, z) || onDais(x, z, .12) || Math.abs(x) < .9 && z < FALLZ + .7) continue;
    D.flat('lit', ['pad0', 'pad1', 'pad2'][Math.floor(rnd(i, 3) * 3)], x, .012 + n * .0004, z, .8 + rnd(i, 4) * .5, { yaw: rnd(i, 5) * 6.28 });
    if (rnd(i, 6) > .66) D.up('lit', 'lotus', x + .04, .02, z + .05, .9 + rnd(i, 7) * .4);
    n++;
  }
  for (let i = 0; i < 52; i++) {                                                                         // 矮台边上的芦苇、蕨、草、发光小蘑菇
    const side = i % 4, t = rnd(i, 21) * 2 - 1;
    const x = side < 2 ? t * SX : (side === 2 ? -1 : 1) * (SX - .1 + rnd(i, 22) * .25), z = side < 2 ? (side === 0 ? 1 : -1) * (SZ - .08 + rnd(i, 23) * .25) : t * SZ;
    if (side >= 2 && Math.abs(z) < PD / 2 + .15) continue;                                               // 两侧贴着祠台的那一段不长
    const pick = rnd(i, 24), n = pick < .34 ? 'reed' : pick < .62 ? 'fern' : pick < .82 ? 'tuft' : 'shroom';
    D.up(n === 'shroom' ? 'lo' : 'cast', n, x, SY - .02 - (rnd(i, 25) > .5 ? SY : 0), z, .75 + rnd(i, 26) * .5, { flip: rnd(i, 27) > .5 });
  }
  for (let i = 0; i < (low ? 130 : 240); i++) {                                                          // 两侧草岸和后岸：灌木、蕨、花、蘑菇，越靠外越密
    const back = i % 3 === 0, x = back ? -9 + rnd(i, 41) * 18 : (i % 2 ? 1 : -1) * (BANK + .1 + rnd(i, 42) ** 1.4 * 3.4), z = back ? BACK - .7 - rnd(i, 43) ** 1.3 * 3.6 : BACK - .35 + rnd(i, 44) * 9.6;
    const pick = rnd(i, 45), n = pick < .3 ? 'bushA' : pick < .55 ? 'bushB' : pick < .75 ? 'fern' : pick < .88 ? 'tuft' : pick < .95 ? 'reed' : 'shroom';
    D.up(n === 'shroom' ? 'lo' : 'cast', n, x, (back ? 1.2 : .72) - .03, z, .85 + rnd(i, 46) * .7, { flip: rnd(i, 47) > .5 });
  }
  for (let i = 0; i < 22; i++) {                                                                         // 残墙上挂下来的根须、藤
    const x = -7.2 + i * .68 + rnd(i, 51) * .3; if (Math.abs(x) < 1.1) continue;
    const wallH = Math.abs(x) < 2.2 ? 3.6 : x < 0 ? 2.5 : 2.0;
    D.up('cast', i % 3 ? 'vine' : 'root0', x, wallH - (i % 3 ? 1.45 : 2.6) + .1, BACK + .31, .9 + rnd(i, 52) * .3, { flip: rnd(i, 53) > .5, tilt: 0 });
  }
  for (const s of [-1, 1]) D.up('hi', 'lantern', s * 1.85, 2.75, BACK + .34, .9, { tilt: 0 });           // 后墙两角各挂一盏灯笼
  for (let i = 0; i < 26; i++) D.up('lit', 'canopy', -10 + i * .8 + rnd(i, 71) * .5, 2.2 + rnd(i, 72) * 3.2, BACK - 2.15 - rnd(i, 73) * 3, 1.5 + rnd(i, 74) * 1.2, { tilt: 0, flip: i % 2 > 0 });   // 后岸的树冠
  for (let i = 0; i < 18; i++) D.up('far', 'canopy', -12 + i * 1.4 + rnd(i, 78) * .6, 3.4 + rnd(i, 79) * 3.4, BACK - 5.6 - rnd(i, 80) * 1.5, 2.4 + rnd(i, 81) * 1.4, { tilt: 0, flip: i % 2 < 1 });   // 更远一层，只是一片偏紫的影子
  for (let i = 0; i < 12; i++) D.up('lit', 'root1', -8 + i * 1.4 + rnd(i, 75), 2.4 + rnd(i, 76) * 1.5, BACK - 1.15 - rnd(i, 77), 1.3, { tilt: 0, flip: i % 2 > 0 });
  D.done();

  // —— 树冠漏光板：一格格只投影、不显示的小方片，挡在太阳和场地之间。擂台上方留一个亮的豁口，四周是碎的光斑 ——
  { const P = [], I = [], cell = .42, lift = mad([0, 0, 0], SUND, (11 - TOP) / SUND[1]);
    for (let gz = -10; gz < 8; gz += cell) for (let gx = -13; gx < 13; gx += cell) {
      const x = gx + cell / 2, z = gz + cell / 2, pool = (x / (HX + 1.45)) ** 2 + ((z - .1) / (HZ + .75)) ** 2, leaf = gn(x / 2.6, z / 2.6, 1) * .6 + gn(x / .9, z / .9, 2) * .4;
      if (leaf > (pool < 1 ? .86 : pool < 1.8 ? .56 : .66) || pool < 1 && leaf > .2) continue;           // 留空的格子：光从这里漏下去
      const i = P.length / 3, X = gx + lift[0], Z = gz + lift[2]; P.push(X, 11, Z, X + cell, 11, Z, X, 11, Z + cell, X + cell, 11, Z + cell); I.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide })); m.castShadow = true; m.frustumCulled = false; W.add(m); }

  // —— 光 ——
  scene.background.set(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 24, 52);
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1]; sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1]; sun.position.set(SUND[0] * 30, SUND[1] * 30, SUND[2] * 30);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 2, far: 66 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  { const f = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); f.position.set(2, 8, 16); scene.add(f); }
  // 灯：位置（W 里的坐标，或者城堡组里的）、颜色、相对强度、灯晕用哪张图多大；flick 的会抖
  const LAMPS = [
    ...STATUES.map((s, i) => ({ x: s.x, y: s.h + .5, z: s.z, color: s.own ? '#48f0e0' : '#ff8a30', power: i < 2 ? 1.1 : 1.3, flick: true, halo: s.own ? 'haloTeal' : 'haloFire', size: 1.7, a: .42, dy: -.12, light: true })),
    ...POSTS.map((p, i) => ({ x: p.x, y: p.h + .22, z: p.z, color: '#ffd98a', power: i < 2 ? .8 : 1, halo: 'haloGold', size: 1.0, a: .5, light: !low && (i < 2 || i > 3) })),
    { cg: castles[0], x: 0, y: 1.9, z: .7, color: '#52f4ff', power: .8, halo: 'haloIce', size: 2.8, a: .34, light: true },
    { cg: castles[1], x: 0, y: 1.7, z: .8, color: '#ff6a2c', power: .7, flick: true, halo: 'haloFire', size: 2.8, a: .36, light: true },
    { x: 0, y: .5, z: FALLZ + .3, color: '#58e8d8', power: .9, halo: 'haloTeal', size: 1.7, a: .4, light: true },
    { x: BOAT.x + .05, y: .95, z: BOAT.z - .05, color: '#ffb050', power: .8, flick: true, halo: 'haloFire', size: 1.3, a: .4 },
    ...PILLARS.filter(p => !p.broken).map(p => ({ x: p.x - p.r - .14, y: p.h - .7, z: p.z + .14, color: '#ffb050', power: .6, flick: true, halo: 'haloFire', size: 1.2, a: .4 })),
  ];
  LAMPS.forEach((l, i) => { l.i = i; if (!l.light) return; l.light = new THREE.PointLight(l.color, LOOK.lamp * l.power, l.cg ? 7 : 5.5, 2); if (l.cg) { l.light.position.set(l.x, l.y - TOP, l.z + .12); l.cg.add(l.light); } else { l.light.position.set(l.x, l.y, l.z + .12); W.add(l.light); } });
  // 后期
  post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
  for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = LOOK.tilt.focus; p.uniforms.band.value = LOOK.tilt.band; p.uniforms.amt.value = LOOK.tilt.amt; }
  { const u = post.grade.uniforms, g = LOOK.grade; u.sat.value = g.sat; u.con.value = g.con; u.knee.value = g.knee; u.gain.value.setRGB(...g.gain); u.lift.value.setRGB(...g.lift); u.edge.value.setRGB(...g.edge); post.grade.enabled = true; }

  // —— 会动的：四层像素片 + 一层叠加的软光（灯晕、水面上的倒影、水汽、光柱；亮度写在顶点颜色里）——
  const LV = { hi: Live(110, LAYER.hi), mid: Live(300, LAYER.mid), lo: Live(40, LAYER.lo), fg: Live(10, new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, side: THREE.DoubleSide, color: new THREE.Color('#4a3a78'), fog: false })) };
  const SOFT = Live(72, new THREE.MeshBasicMaterial({ map: GLOW.tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), true);
  const NFLY = low ? 24 : 54, NPETAL = low ? 14 : 30, NMOTE = low ? 60 : 150, NGLINT = low ? 16 : 36;
  const FG = [['bigleaf', -1.02, .9, 5.0, .45, false], ['bigleaf', 1.04, .93, 5.3, .5, true], ['root1', -.56, 1.02, 5.6, .5, false], ['root0', .45, 1.08, 6.0, .45, true], ['bigleaf', -1.12, .2, 5.4, .4, true], ['bigleaf', 1.13, .16, 5.6, .4, false]];   // 贴着镜头的大叶和垂根：只压在画面上沿和两侧，会被移轴虚掉
  const eye = new THREE.Vector3(), vr = new THREE.Vector3(), vu = new THREE.Vector3(), vq = new THREE.Vector3(), look = new THREE.Vector3(0, .95, -.1);
  let last = 0;

  function tick(t) {
    last = t;
    const step = Math.floor(t * 8);                                // 每秒 8 拍，像素的东西按拍跳；光和飘的东西连续走
    camera.updateMatrixWorld(); eye.setFromMatrixPosition(camera.matrixWorld); vr.setFromMatrixColumn(camera.matrixWorld, 0); vu.setFromMatrixColumn(camera.matrixWorld, 1);
    const R = [vr.x, vr.y, vr.z], U = [vu.x, vu.y, vu.z], E = [eye.x, eye.y + TOP, eye.z], dcam = eye.distanceTo(look);
    scene.fog.near = dcam + 6; scene.fog.far = dcam + 36;
    waterT.offset.set(t * .006, t * .011); sheenT.offset.set(-t * .017, t * .009);
    for (const l of LAMPS) if (l.light) l.light.intensity = LOOK.lamp * l.power * (l.flick ? flick(l.i, t) : 1);
    for (const k in LV) LV[k].begin(); SOFT.begin();
    const card = (layer, n, x, y, z, s = 1, o = {}) => { const c = { n, p: [x, y, z], s, k: 'up', tilt: 0, ...o }; LV[layer].quad(corners(c, R, U), uvOf(c)); };
    const c0 = castles[0].position, c1 = castles[1].position;
    // 火盆里的火 / 幽火，焰祠祭台上的大火，霜祠门楣上的一朵幽火
    STATUES.forEach((s, i) => card('hi', `${s.own ? 'wisp' : 'flame'}${(step + i) % 4}`, s.x, s.h + .1, s.z + .02, 1.25));
    card('hi', `flame${(step + 2) % 4}`, c1.x, 1.12 + c1.y, .32, 1.7); card('hi', `wisp${(step + 1) % 4}`, c0.x + SHW, 2.38 + c0.y, 1.1, .9);
    // 瀑布：四格循环往下流，落水处两格水花
    card('mid', `fall${step % 4}`, 0, 0, FALLZ, 1); card('mid', `foam${step % 2}`, 0, -.02, FALLZ + .12, 1.1);
    // 涟漪（瀑布脚下三圈，别处零星）、水面的闪光点、游着的锦鲤、漂灯
    for (let i = 0; i < 16; i++) { const ph = (t * .45 + rnd(i, 81)) % 1, k = Math.min(2, Math.floor(ph * 3)), sp = SPOTS[(i * 5) % SPOTS.length], x = i < 3 ? (i - 1) * .5 : sp[0], z = i < 3 ? FALLZ + .35 + i * .12 : sp[1]; card('lo', `ripple${k}`, x, .008, z, .9 + ph * .5, { k: 'flat' }); }
    for (let i = 0; i < NGLINT; i++) { const sp = SPOTS[(i * 7 + 3) % SPOTS.length]; if (Math.sin(t * 2.4 + i * 1.9) > .2) card('mid', 'glint', sp[0], .01, sp[1], 1, { k: 'flat' }); }
    for (let i = 0; i < 7; i++) { const sp = SPOTS[(i * 11 + 1) % SPOTS.length], a = t * (.3 + rnd(i, 13) * .25) * (i % 2 ? 1 : -1) + i * 2, vx = -Math.sin(a) * .5 * (i % 2 ? 1 : -1), vz = Math.cos(a) * .3 * (i % 2 ? 1 : -1), x = sp[0] + Math.cos(a) * .5, z = sp[1] + Math.sin(a) * .3;
      if (isWater(x, z)) card('lo', 'koi', x, .006, z, 1.1, { k: 'flat', yaw: Math.atan2(vz, -vx) }); }
    FLOATS.forEach((f, i) => { const y = .02 + .015 * Math.sin(t * 1.3 + i * 2), x = f.x + Math.sin(t * .11 + f.a) * .25, z = f.z + Math.cos(t * .09 + f.a) * .12; card('hi', 'lantern', x, y, z, .55);
      SOFT.quad(corners({ n: 'pad2', p: [x, .014, z + .12], s: 2.2, k: 'flat' }), GLOW.at.haloGold.uv, .3 * LOOK.halo * flick(i + 30, t * .4)); });
    // 花瓣、萤火虫、光里的浮尘（都朝镜头）
    for (let i = 0; i < NPETAL; i++) { const ph = (t * (.05 + rnd(i, 111) * .05) + rnd(i, 112)) % 1; card('mid', 'petal', fx(-6.5 + rnd(i, 113) * 13) + Math.sin(t * 1.2 + i) * .3 + ph * 1.2, 5.2 - ph * 5.1, fz(-3 + rnd(i, 114) * 6.5), 1.1, { k: 'face', roll: t * 2 + i }); }
    for (let i = 0; i < NFLY; i++) {
      const a = t * (.25 + rnd(i, 121) * .3) + rnd(i, 122) * 6.28, edge = rnd(i, 126) > .35;
      const bx = edge ? (rnd(i, 123) > .5 ? 1 : -1) * (SX + .2 + rnd(i, 124) * 2.4) : (rnd(i, 124) * 2 - 1) * SX, bz = edge ? BACK + .6 + rnd(i, 125) * 8 : (rnd(i, 125) > .5 ? SZ + .2 + rnd(i, 127) * 1.4 : BACK + .7 + rnd(i, 127) * 1.2);
      if (Math.sin(t * 1.7 + i * 2.1) > -.5) card('hi', 'firefly', bx + Math.cos(a) * .35, .35 + rnd(i, 128) * 1.9 + Math.sin(a * 1.3) * .2, bz + Math.sin(a) * .3, 1, { k: 'face' });
    }
    for (let i = 0; i < NMOTE; i++) { const a = t * (.12 + rnd(i, 131) * .16) + rnd(i, 132) * 6.28; card('mid', 'mote', fx(-6 + rnd(i, 133) * 12) + Math.cos(a) * .4, .5 + rnd(i, 134) * 4.2 + Math.sin(a * 1.4) * .25, BACK + .4 + rnd(i, 135) * 8 + Math.sin(a) * .35, 1, { k: 'face' }); }
    // 贴着镜头的前景：位置按画面坐标算（窗口大小、手机横竖变了也还在角上）
    for (const [n, nx, ny, d, s, flip] of FG) { vq.set(nx, ny, .5).unproject(camera).sub(eye).normalize(); card('fg', n, E[0] + vq.x * d, E[1] + vq.y * d, E[2] + vq.z * d, s, { k: 'face', flip }); }
    // 软光：灯晕朝镜头；水面上各躺一片倒影；瀑布脚下三层水汽；顺着阳光的光柱（绕自己的轴转到正对镜头）
    for (const l of LAMPS) {
      const k = l.flick ? flick(l.i, t) : 1, ox = l.cg ? l.cg.position.x : 0, oy = l.cg ? l.cg.position.y : 0, p = [l.x + ox, l.y + oy + (l.dy ?? 0), l.z + .05], h = l.size / 2, uv = GLOW.at[l.halo].uv;
      SOFT.quad([mad(mad(p, R, -h), U, h), mad(mad(p, R, h), U, h), mad(mad(p, R, -h), U, -h), mad(mad(p, R, h), U, -h)], uv, l.a * k * LOOK.halo);
      if (!l.cg && isWater(l.x, l.z + .5)) SOFT.quad([[p[0] - h * .7, .013, l.z - .1], [p[0] + h * .7, .013, l.z - .1], [p[0] - h * .7, .013, l.z + 1.5], [p[0] + h * .7, .013, l.z + 1.5]], uv, l.a * .5 * k * LOOK.halo);
    }
    { const uv = GLOW.at.mist.uv; for (let i = 0; i < 3; i++) { const w = 1.9 + i * .5, y = .22 + i * .1, z = FALLZ + .3 + i * .25, a = .34 - i * .07 + .05 * Math.sin(t * 1.4 + i), x = Math.sin(t * .3 + i * 2) * .15;
      SOFT.quad([[x - w / 2, y + .5, z], [x + w / 2, y + .5, z], [x - w / 2, y - .25, z], [x + w / 2, y - .25, z]], uv, a); } }
    { const uv = GLOW.at.shaft.uv; [[-1.6, -.2, 2.3, 1], [1.2, .6, 1.7, .8], [3.6, -1.4, 1.3, .6], [-4.2, 1.6, 1.4, .65], [.2, -2.9, 1.5, .7], [-2.9, 3.2, 1.0, .45]].forEach(([x, z, w, k], i) => {
      const mid = mad([fx(x), 0, fz(z)], SUND, 4.6), to = mad(E, mid, -1), cr = unit([SUND[1] * to[2] - SUND[2] * to[1], SUND[2] * to[0] - SUND[0] * to[2], SUND[0] * to[1] - SUND[1] * to[0]]), at = (s, v) => mad(mad(mid, cr, s * w / 2), SUND, 4.7 * v);
      SOFT.quad([at(-1, 1), at(1, 1), at(-1, -1), at(1, -1)], uv, LOOK.shaft * k * (1 + .12 * Math.sin(t * .9 + i * 2))); }); }
    for (const k in LV) LV[k].end(); SOFT.end();
  }
  const again = () => requestAnimationFrame(() => tick(last));     // 镜头一开始还没摆好、窗口大小也会变：补摆一次（开了「减少动态效果」时游戏不调 tick，全靠这个）
  addEventListener('resize', again); again(); setTimeout(again, 400);
  scene.updateMatrixWorld(true); tick(0);
  return { tick };
}
