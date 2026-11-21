// 《珊瑚龙宫》· 海底擂台（地址参数 arena=sea）。擂台沉在一座珊瑚宫殿的前庭里。
// 这个文件只管「搭」：把 bed.js 的材质贴图和 fauna.js 的小件摆成场景、合批、打光、调后期，再在 tick 里让它们动起来。
//   画法（色带、胶片、噪声）在 tide.js，三个文件都是这个擂台自己的，不和别的擂台共用。
// 布局（x 向右，z 朝镜头，y 向上；盘面底是 y = 0）：
//   · 盘和两座城堡站在一座两级的石台上（每级 1/3 米），石台外面是海床（y = G，往外起伏成沙丘）。
//   · 左边本方：一只竖着张开的巨型砗磲，两片壳之间托着一颗发青光的大珍珠。右边对面：一具鮟鱇头骨，嘴里一圈针牙，头顶的骨竿吊着一盏红色诱灯，身后长着红珊瑚。
//   · 盘后（z 小）：一排断柱和两尊石像 → 台阶和宫门残墙 → 宫殿与沉船的剪影 → 珊瑚林，越远越被蓝青色的海水吞掉。
//   · 贴镜头的前景：海带和海扇的墨蓝剪影，每帧按画面坐标压在下面两个角上。
// 会动的（tick）：海床上的焦散光纹、光柱明灭、成串的气泡、四群小鱼、水母漂浮和脉动、海带 / 海葵 / 海草摆动、巨蚌开合、
//   珍珠灯和大珍珠 / 诱灯的呼吸、诱灯摇晃、浮游的发光微粒、远处游过的蝠鲼和海龟、横着走的小螃蟹、前景海带。
import { PPM, mk, dice, swell, K } from './tide.js';
import * as BED from './bed.js';
import { sprites, glowSheet } from './fauna.js';

const LOOK = {
  bg: '#052a62', fog: '#093c7c',                                           // 远处被这个蓝青色吞掉
  amb: ['#4a78e6', 1.35],                                                  // 环境光：群青，暗部自然偏蓝
  sun: ['#c2f8ff', 3.4, [-3, 18, -7]],                                     // 主光：水面漏下来的冷青白，从正上偏后打下来
  fill: ['#6a58ee', .9, [3, 5, 12]],                                       // 正面的补光：蓝紫，让朝镜头的立面不至于死黑
  pearl: ['#2cffd6', 6], lure: ['#ff3c2c', 12], lamp: ['#ffb060', 7],     // 三种点光：青珍珠、红诱灯、暖色珍珠灯
  bloom: [.56, .7, .84],
  tilt: { focus: .48, band: .26, amt: 1.7 }, tiltShort: { focus: .6, band: .3, amt: 1.5 },               // 手机横屏盘面占满画面：清楚带放高、放宽
  grade: { sat: 1.08, con: 1.08, knee: .82, gain: [.96, 1.02, 1.08], lift: [0, .012, .03], edge: [-.5, -.42, -.26] },
};
const G = -2 / 3, STEP = -1 / 3, TAU = Math.PI * 2;                        // 海床的高度、下一级台面的高度
const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const W1 = [1, 1, 1];

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, grid } = ctx;
  const { ROWS, COLS, LX, LZ, HALF, DEPTH, SHORT } = grid, Zh = DEPTH / 2;
  const V3 = THREE.Vector3, glow = k => low ? Math.min(k, 1.15) : k;          // 低画质档没有泛光，自发光不要超过 1.15

  // ———————————————————— 贴图 ————————————————————
  const tex = (cv, rep) => { const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  const TEX = {}, SIZE = {}, MATS = {};
  const reg = (key, cv) => { TEX[key] = tex(cv, true); SIZE[key] = [cv.width, cv.height]; };
  const art = BED.boardArt(grid), FW = art.frame.width / PPM, FH = art.frame.height / PPM;   // 整盘贴图（连石沿）的米制尺寸
  Object.entries({ sand: BED.sandTex(), rock: BED.rockTex(), wall: BED.wallTex(), flute: BED.fluteTex(), frieze: BED.friezeTex(), trim: BED.trimTex(), pave: BED.paveTex(), frame: art.frame,
    shellOut: BED.shellTex(false), shellIn: BED.shellTex(true), mantle: BED.mantleTex(), skull: BED.skullTex(), bone: BED.boneTex(), pit: BED.pitTex(K.red) }).forEach(([k, cv]) => reg(k, cv));
  const lam = key => MATS[key] || (MATS[key] = new THREE.MeshLambertMaterial({ map: TEX[key], vertexColors: true }));
  for (const t of tiles) { const a = art.tiles.find(q => q.r === t.userData.r && q.c === t.userData.c); t.material = new THREE.MeshLambertMaterial({ map: tex(a.cv) }); }   // 格子只换材质

  // 小件图集：所有小图排进一张 2048 宽的图，记下每张的 uv 和米制尺寸；序列帧记成数组
  const A = {}; let ATLAS;
  { const S = sprites(), items = [];
    for (const [name, v] of Object.entries(S)) (Array.isArray(v) ? v : [v]).forEach((cv, i) => items.push({ name, i, cv, multi: Array.isArray(v) }));
    items.sort((a, b) => b.cv.height - a.cv.height);
    const AW = 2048; let x = 1, y = 1, rowH = 0;
    for (const it of items) { if (x + it.cv.width + 1 > AW) { x = 1; y += rowH + 2; rowH = 0; } it.x = x; it.y = y; x += it.cv.width + 2; rowH = Math.max(rowH, it.cv.height); }
    const AH = y + rowH + 1, cv = mk(AW, AH), g = cv.getContext('2d');
    for (const it of items) { g.drawImage(it.cv, it.x, it.y); const e = { u0: it.x / AW, u1: (it.x + it.cv.width) / AW, v0: 1 - (it.y + it.cv.height) / AH, v1: 1 - it.y / AH, w: it.cv.width / PPM, h: it.cv.height / PPM }; if (it.multi) (A[it.name] ||= [])[it.i] = e; else A[it.name] = e; }
    ATLAS = tex(cv); }
  const GS = glowSheet(mk), GLOWTEX = new THREE.CanvasTexture(GS.cv); GLOWTEX.colorSpace = THREE.SRGBColorSpace;      // 软光图用线性过滤
  const soft = a => ({ u0: a[0], v0: a[1], u1: a[2], v1: a[3] }), HALO = soft(GS.halo), SHAFT = soft(GS.shaft), MOTE = soft(GS.mote);

  // ———————————————————— 合批工具 ————————————————————
  // Mass：实体零件。按贴图把三角形收进各自的篮子，done() 时一种贴图出一张网格（吃光、投影、受影）。
  function Mass(parent) {
    const bins = {}, B = k => bins[k] || (bins[k] = { p: [], n: [], u: [], c: [] });
    const M = {
      // 一个四边形面：四个角按「从外面看逆时针」给
      face(key, pts, uvs, col = W1) {
        const b = B(key), [a, q, , d] = pts, e1 = [q[0] - a[0], q[1] - a[1], q[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n) || 1;
        for (const j of [0, 1, 2, 0, 2, 3]) { b.p.push(...pts[j]); b.n.push(n[0] / l, n[1] / l, n[2] / l); b.u.push(...uvs[j]); b.c.push(...col); }
      },
      // 一个方块：贴图按每米 48 像素平铺，竖向从上沿对齐。top：顶面换一张贴图；skip：不要的面（t 顶 f 前 b 后 l 左 r 右）
      box(key, x0, x1, y0, y1, z0, z1, { top = key, skip = '', col = W1, topCol = col } = {}) {
        const ku = PPM / SIZE[key][0], kv = PPM / SIZE[key][1], tu = PPM / SIZE[top][0], tv = PPM / SIZE[top][1], v0 = (y0 - y1) * kv;
        if (!skip.includes('t')) M.face(top, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[x0 * tu, -z1 * tv], [x1 * tu, -z1 * tv], [x1 * tu, -z0 * tv], [x0 * tu, -z0 * tv]], topCol);
        if (!skip.includes('f')) M.face(key, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x0 * ku, v0], [x1 * ku, v0], [x1 * ku, 0], [x0 * ku, 0]], col);
        if (!skip.includes('b')) M.face(key, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [[-x1 * ku, v0], [-x0 * ku, v0], [-x0 * ku, 0], [-x1 * ku, 0]], col);
        if (!skip.includes('r')) M.face(key, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[-z1 * ku, v0], [-z0 * ku, v0], [-z0 * ku, 0], [-z1 * ku, 0]], col);
        if (!skip.includes('l')) M.face(key, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[z0 * ku, v0], [z1 * ku, v0], [z1 * ku, 0], [z0 * ku, 0]], col);
      },
      // 并进一个 three 的几何体（球、柱、锥、自己算的曲面）。ru / rv：贴图重复几遍；flip：翻面（里外各贴一张图时用）
      geo(key, g0, m, { ru = 1, rv = 1, col = W1, flip = false } = {}) {
        const g = g0.index ? g0.toNonIndexed() : g0.clone(); g.applyMatrix4(m);
        const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array, b = B(key), s = flip ? -1 : 1;
        for (let i = 0; i < P.length / 3; i += 3) for (const j of flip ? [0, 2, 1] : [0, 1, 2]) { const k = i + j; b.p.push(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]); b.n.push(N[k * 3] * s, N[k * 3 + 1] * s, N[k * 3 + 2] * s); b.u.push(U[k * 2] * ru, U[k * 2 + 1] * rv); b.c.push(...col); }
        g.dispose(); if (g0 !== g) g0.dispose();
      },
      bin: B,
      done() {
        for (const [key, b] of Object.entries(bins)) {
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
          const m = new THREE.Mesh(g, lam(key)); m.castShadow = key !== 'sand'; m.receiveShadow = true; parent.add(m);
        }
      },
    };
    return M;
  }
  const at = (px, py, pz, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new V3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V3(sx, sy, sz));

  // Quads：一摞四边形片，共用一张贴图、一次绘制。不动的片写一次；会动的每帧 begin → put → end 重写缓冲。
  //   put(图块, 底边中点, 半宽向量, 高度向量, 颜色, 是否左右翻)
  const DEPTHMAT = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: ATLAS, alphaTest: .5 });
  function Quads(cap, mat, parent = scene, { cast = false, order = 0 } = {}) {
    const P = new Float32Array(cap * 12), U = new Float32Array(cap * 8), C = new Float32Array(cap * 12), I = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) I.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    const g = new THREE.BufferGeometry(), pa = new THREE.BufferAttribute(P, 3), ua = new THREE.BufferAttribute(U, 2), ca = new THREE.BufferAttribute(C, 3);
    pa.setUsage(THREE.DynamicDrawUsage); ua.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa); g.setAttribute('uv', ua); g.setAttribute('color', ca); g.setIndex(new THREE.BufferAttribute(I, 1));
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = order; if (cast) { m.castShadow = true; m.customDepthMaterial = DEPTHMAT; } parent.add(m);
    let n = 0;
    return {
      begin() { n = 0; },
      put(e, ax, ay, az, wx, wy, wz, ux, uy, uz, r, gg, b, flip) {
        if (n >= cap) return; const p = n * 12, q = n * 8, u0 = flip ? e.u1 : e.u0, u1 = flip ? e.u0 : e.u1;
        P[p] = ax - wx; P[p + 1] = ay - wy; P[p + 2] = az - wz; P[p + 3] = ax + wx; P[p + 4] = ay + wy; P[p + 5] = az + wz;
        P[p + 6] = ax + wx + ux; P[p + 7] = ay + wy + uy; P[p + 8] = az + wz + uz; P[p + 9] = ax - wx + ux; P[p + 10] = ay - wy + uy; P[p + 11] = az - wz + uz;
        U[q] = u0; U[q + 1] = e.v0; U[q + 2] = u1; U[q + 3] = e.v0; U[q + 4] = u1; U[q + 5] = e.v1; U[q + 6] = u0; U[q + 7] = e.v1;
        for (let k = 0; k < 12; k += 3) { C[p + k] = r; C[p + k + 1] = gg; C[p + k + 2] = b; }
        n++;
      },
      end() { g.setDrawRange(0, n * 6); pa.needsUpdate = ua.needsUpdate = ca.needsUpdate = true; },
    };
  }
  const E = name => Array.isArray(A[name]) ? A[name][0] : A[name];
  const up = (Q, name, x, y, z, s = 1, col = W1, flip = false) => { const e = E(name); Q.put(e, x, y, z, e.w * s / 2, 0, 0, 0, e.h * s, 0, col[0], col[1], col[2], flip); };          // 立着的片，底边中点落在 (x, y, z)，朝镜头
  const lay = (Q, name, x, y, z, s = 1, rot = 0, col = W1) => { const e = E(name), c = Math.cos(rot), sn = Math.sin(rot), w = e.w * s / 2, h = e.h * s; Q.put(e, x + sn * h / 2, y, z + c * h / 2, c * w, 0, -sn * w, -sn * h, 0, -c * h, col[0], col[1], col[2], false); };   // 躺着的片，中心在 (x, y, z)

  const cardMat = (o = {}) => new THREE.MeshBasicMaterial({ map: ATLAS, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide, ...o });
  const CARD = cardMat();
  const CAST = Quads(640, CARD, scene, { cast: true }), FLAT = Quads(260, CARD), FAR = Quads(60, CARD);       // 近处会投影的片 / 躺在地上的片 / 远景剪影
  const LIVE = Quads(low ? 300 : 380, CARD);                                                                 // 会动的小件
  const FGQ = Quads(8, cardMat({ fog: false }), scene, { order: 6 });                                         // 贴镜头的前景剪影
  const SOFTMAT = new THREE.MeshBasicMaterial({ map: GLOWTEX, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const SOFT = Quads(low ? 150 : 240, SOFTMAT, scene, { order: 4 });                                           // 加色软光：灯晕、光柱、微粒
  // 城堡身上会动的片和光晕各放一摞在城堡自己的组里：城堡抖、沉的时候跟着走，「减少动态效果」时也不会留在半空
  const GQ = new Map(castles.map(g => [g, { live: Quads(16, CARD, g), soft: Quads(8, SOFTMAT, g, { order: 4 }) }]));

  // ———————————————————— 海床 ————————————————————
  const PXO = HALF + 3.0, PZ = FH / 2 + .4;                                   // 石台的外沿（两座城堡的台基也算在里面）
  const gy = (x, z) => G + (swell(x * .17 + 40, z * .17 + 40, 3) - .38) * .95 * sm(.5, 4.5, Math.max(Math.abs(x) - PXO, Math.abs(z) - PZ, 0));   // 海床高度：石台附近是平的，往外起伏成沙丘
  const rim = (x, z) => 1 - .7 * sm(4.5, 11, Math.hypot(x, z * .85));                                             // 离盘越远越暗：把目光收在盘上
  const WORLD = Mass(scene), cau = { p: [], a: [] };                          // cau：焦散叠层用的面（位置 + 强度）
  const cauQuad = (pts, amt) => { for (const j of [0, 1, 2, 0, 2, 3]) { cau.p.push(...pts[j]); cau.a.push(amt); } };
  { const b = WORLD.bin('sand'), ku = PPM / SIZE.sand[0], X0 = -17, X1 = 17, Z0 = -30, Z1 = 9, e = .3;
    const vert = (x, z) => { const y = gy(x, z), sh = (.74 + .42 * swell(x * .09, z * .09, 8)) * rim(x, z), nx = -(gy(x + e, z) - gy(x - e, z)) / (2 * e), nz = -(gy(x, z + e) - gy(x, z - e)) / (2 * e), l = Math.hypot(nx, 1, nz); return { p: [x, y, z], n: [nx / l, 1 / l, nz / l], u: [x * ku, -z * ku], c: [sh * .94, sh, sh * 1.05] }; };
    for (let z = Z0; z < Z1; z++) for (let x = X0; x < X1; x++) {
      const q = [vert(x, z + 1), vert(x + 1, z + 1), vert(x + 1, z), vert(x, z)];
      for (const j of [0, 1, 2, 0, 2, 3]) { b.p.push(...q[j].p); b.n.push(...q[j].n); b.u.push(...q[j].u); b.c.push(...q[j].c); }
      cauQuad(q.map(v => [v.p[0], v.p[1] + .015, v.p[2]]), 1);
    } }

  // ———————————————————— 石台：盘面的石沿、两级台阶 ————————————————————
  { const x0 = -FW / 2, x1 = FW / 2, z0 = -FH / 2, z1 = FH / 2;
    WORLD.box('trim', x0, x1, STEP, 0, z0, z1, { skip: 'tlr' });                                               // 上一级：侧面是嵌珍珠的线脚
    WORLD.face('frame', [[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]]); // 顶面：整盘贴图（雕花石沿 + 格子缝里露出来的勾缝色）
    WORLD.box('trim', x0, x1, G, STEP, z0 - .4, z1 + .4, { top: 'pave', skip: 'lr' });                         // 下一级：顶面铺方砖
    cauQuad([[x0, STEP + .012, z1 + .4], [x1, STEP + .012, z1 + .4], [x1, STEP + .012, z1], [x0, STEP + .012, z1]], .7);
    cauQuad([[x0, STEP + .012, z0], [x1, STEP + .012, z0], [x1, STEP + .012, z0 - .4], [x0, STEP + .012, z0 - .4]], .7);
    cauQuad([[-HALF, .068, Zh], [HALF, .068, Zh], [HALF, .068, -Zh], [-HALF, .068, -Zh]], .03); }               // 盘面上只留很淡的一层

  // ———————————————————— 会动的东西先登记，tick 里统一写缓冲 ————————————————————
  const R = dice(20261), plants = [], halos = [], lamps = [], clams = [], crabs = [], schools = [], jellies = [], bubblers = [], lights = [];
  const hush = (x, z) => Math.abs(x) < HALF + .35 && z < -Zh && z > -(FH / 2 + 2.6) ? .58 : 1;                     // 盘正后面那一条是后排棋子的背景：压暗、别抢
  const dep = (z, x = 9) => { const k = Math.max(0, Math.min(1, (-z - 3) / 15)), v = rim(x, z) * .92 * hush(x, z); return z > Zh + .5 ? [.6 * v, .7 * v, .86 * v] : [(1 - .34 * k) * v, (1 - .2 * k) * v, (1 - .06 * k) * v]; };   // 越远越暗一点、越蓝一点；镜头前那一条压暗
  const plant = (name, x, y, z, s = 1, col = W1, g = null) => plants.push({ f: A[name], x, y, z, s, col, ph: R.int(0, 7), flip: R() < .5, q: g ? GQ.get(g).live : LIVE });
  const halo = (x, y, z, size, rgb, amp = .12, sp = 1, g = null) => halos.push({ x, y, z, size, rgb, amp, sp, ph: R.in(0, TAU), q: g ? GQ.get(g).soft : SOFT });
  // 珍珠灯：扭纹石柱 + 一颗会呼吸的暖色珍珠；pt = 要不要配一盏点光
  const lamp = (x, z, s, pt) => { const y = gy(x, z); up(CAST, 'lampPost', x, y, z, s, dep(z)); const L = { x, y: y + (A.lampPost.h - .2 - A.lampOrb.h * .45) * s, z: z + .01, s, ph: R.in(0, TAU), light: null };
    if (pt) { L.light = new THREE.PointLight(LOOK.lamp[0], LOOK.lamp[1], 6.5, 2); L.light.position.set(x, L.y + .1, z + .25); scene.add(L.light); } lamps.push(L); };

  // ———————————————————— 城堡的台基（两座共用的画法），f = 朝盘面的方向（本方 +1，对面 −1）————————————————————
  function terrace(M, g, f, col) {
    const a = .925 * f, o1 = -1.3 * f, o2 = -1.6 * f, z0 = -FH / 2, z1 = FH / 2, lo = Math.min, hi = Math.max, side = f > 0 ? 'r' : 'l';
    M.box('trim', lo(a, o1), hi(a, o1), STEP, 0, z0, z1, { top: 'pave', skip: side, topCol: col });
    M.box('trim', lo(a, o2), hi(a, o2), G, STEP, z0 - .4, z1 + .4, { top: 'pave', skip: side, topCol: col });
    // 台面上的焦散跟着城堡走（挨打会抖、被攻破会沉）
    const p = [], am = [], rect = (xa, xb, y, za, zb, k) => { for (const v of [[xa, y, zb], [xb, y, zb], [xb, y, za], [xa, y, zb], [xb, y, za], [xa, y, za]]) { p.push(...v); am.push(k); } };
    rect(lo(a, o1), hi(a, o1), .012, z0, z1, .55); rect(lo(a, o2), hi(a, o2), STEP + .012, z1, z1 + .4, .7); rect(lo(a, o2), hi(a, o2), STEP + .012, z0 - .4, z0, .7); rect(lo(o1, o2), hi(o1, o2), STEP + .012, z0, z1, .7);
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); cg.setAttribute('amt', new THREE.Float32BufferAttribute(am, 1));
    const cm = new THREE.Mesh(cg, CAUSTIC); cm.frustumCulled = false; cm.renderOrder = 2; g.add(cm);
  }

  // 焦散叠层的材质：两张亮线网反向流动，取「两张都亮的地方」再加一点各自的余光，所以会闪；加色叠在海床和台面上，远了淡出
  const cauTex = s => { const t = tex(BED.causticTex(s, [255, 255, 255]), true); return t; };
  const CAUSTIC = new THREE.ShaderMaterial({
    uniforms: { ta: { value: cauTex(3) }, tb: { value: cauTex(29) }, t: { value: 0 }, tint: { value: new THREE.Color().setRGB(.34, .92, 1) }, gain: { value: low ? .36 : .5 }, fogR: { value: new THREE.Vector2(20, 46) } },
    vertexShader: 'attribute float amt; varying vec2 vW; varying float vA; varying float vD; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xz; vA = amt; vec4 mv = viewMatrix * w; vD = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform sampler2D ta; uniform sampler2D tb; uniform float t; uniform vec3 tint; uniform float gain; uniform vec2 fogR; varying vec2 vW; varying float vA; varying float vD;\nvoid main(){ float a = texture2D(ta, vW * .27 + vec2(t * .019, t * .012)).r, b = texture2D(tb, vW * .21 + vec2(-t * .015, t * .021)).r; float c = min(a, b) * 1.5 + a * b * 1.4 + (a + b) * .1; gl_FragColor = vec4(tint * c * vA * gain * (1. - smoothstep(fogR.x, fogR.y, vD)), 1.);\n#include <colorspace_fragment>\n}',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });

  // ———————————————————— 本方城堡：一只朝镜头张开的巨型砗磲。下片平躺在台基上，上片竖在后面当屏风，中间的软肉垫上托着一颗发青光的大珍珠 ————————————————————
  // 一片壳的曲面：a 是绕铰合处的角度，r 从铰合处到壳口；fn(sin a, cos a, r, 褶, 靠边的程度) 返回这一点的位置。褶的道数和贴图一致
  function valveGeo(fn, wavy = .12) {
    const NU = 44, NV = 8, pos = [], uv = [], idx = [], { A: SA, N: SN } = BED.SHELL;
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
      const a = (i / NU * 2 - 1) * SA, fold = Math.cos(a * SN), r = j / NV * (1 + wavy * fold) * (1 - .1 * (a / SA) ** 2);
      pos.push(...fn(Math.sin(a), Math.cos(a), r, fold, (a / SA) ** 2)); uv.push(i / NU, j / NV);
    }
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const q = j * (NU + 1) + i, b = q + 1, c = q + NU + 1, d = c + 1; idx.push(q, b, d, q, d, c); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  const orbMat = (cv, k) => new THREE.MeshBasicMaterial({ map: tex(cv), color: new THREE.Color().setScalar(k) });
  let pearl, lureOrb, lureLine;
  { const g = castles[0], M = Mass(g), D = Quads(70, CARD, g, { cast: true }), I4 = new THREE.Matrix4(), teal = [.72, 1.02, 1.04], ZH = -Zh + .12, RU = 2.78, RL = DEPTH - .2;
    terrace(M, g, 1, [.7, 1.05, 1.08]);
    const upper = () => valveGeo((sa, ca, r, fold, e) => { const y = ca * RU * r; return [sa * .5 * RU * r, .05 + y, ZH - .1 - y * .1 - .34 * Math.sin(Math.PI * r * .85) + .5 * r * r * e + .13 * fold * r]; });   // 上片：竖着，肚子往后鼓、两边往前卷
    const lower = () => valveGeo((sa, ca, r, fold, e) => [sa * .3 * RL * r, .04 + .3 * r * r * e + .16 * r * r + .1 * fold * r, ZH + ca * RL * r], .05);                                          // 下片：平躺，壳口微微翘起
    M.geo('shellIn', upper(), I4, { col: [1.5, 1.6, 1.6] }); M.geo('shellOut', upper(), I4, { flip: true }); M.geo('shellIn', lower(), I4, { flip: true });
    M.geo('mantle', new THREE.SphereGeometry(1, 18, 6, 0, TAU, 0, Math.PI / 2), at(0, .06, -.15, .7, .42, 1.45), { ru: 3, rv: 1 });      // 壳里的软肉垫
    M.done();
    pearl = new THREE.Mesh(new THREE.SphereGeometry(.44, 20, 12), orbMat(BED.orbTex(K.teal, 64), glow(1.15))); pearl.position.set(0, .86, -.05); g.add(pearl);
    const beadMat = orbMat(BED.orbTex(K.pearl, 32), .92);
    for (const [x, z, r] of [[-.5, .95, .16], [.46, 1.2, .2], [-.12, 1.55, .12], [.62, .3, .13], [-.62, .1, .11]]) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 6), beadMat); m.position.set(x, .2 + r * .7, z); g.add(m); }   // 壳里滚着的几颗小珍珠
    const pl = new THREE.PointLight(LOOK.pearl[0], LOOK.pearl[1], 8, 2); pl.position.set(.2, 1.3, .7); g.add(pl); lights.push({ l: pl, base: LOOK.pearl[1], ph: 0, sp: 1.1 });
    halo(0, .86, .1, 1.9, [.06, .6, .52], .12, 1.1, g);
    // 陪衬：上片两边的青珊瑚和海扇、挂在上片里面的珍珠串、鹦鹉螺、荧光球藻；青色海葵是活的
    up(D, 'branchTealBig', -1.22, 0, ZH + .1, .95, teal); up(D, 'branchWhite', 1.2, 0, ZH + .2, 1, teal); up(D, 'fanViolet', -1.38, STEP, ZH + .7, .8, [.7, .9, 1.1]); up(D, 'whipCyan', 1.38, STEP, ZH + .6, 1.1);
    for (const [x, y, s] of [[-.44, 1.5, .7], [.44, 1.5, .7], [0, 1.95, .62]]) up(D, 'garland', x, y, ZH - .28, s);
    up(D, 'nautilus', 1.02, 0, FH / 2 - .5, 1.2); up(D, 'tableTeal', -1.0, 0, FH / 2 - .4, .9); up(D, 'bulbCyan', 1.2, 0, .4, 1.1, [glow(1.4), glow(1.4), glow(1.4)]); up(D, 'bulbCyan', -1.2, STEP, FH / 2 + .22, 1, [glow(1.4), glow(1.4), glow(1.4)], true);
    up(D, 'scallopWhite', .7, STEP, FH / 2 + .25, 1.1); up(D, 'pearl', .3, STEP, FH / 2 + .3, 1.2, [glow(1.3), glow(1.3), glow(1.3)]); up(D, 'conch', -.35, STEP, FH / 2 + .28, 1);
    up(D, 'tubewormWhite', -1.15, 0, -.5, .9); up(D, 'barnacleA', -1.4, STEP, .9, 1); up(D, 'scallopWhite', 1.05, 0, -1.2, 1);
    D.end();
    plant('anemTeal', -1.05, 0, .6, 1.1, W1, g); plant('anemTeal', 1.1, 0, -.4, .95, W1, g); plant('anemTeal', -.62, STEP, FH / 2 + .12, 1.1, W1, g); plant('anemTeal', 1.3, STEP, FH / 2 + .1, 1, W1, g);
    plant('anemViolet', -1.42, STEP, -.3, .9, teal, g); plant('grassB', .1, STEP, FH / 2 + .16, 1.2, W1, g); plant('grassB', 1.42, STEP, 1.1, 1.1, W1, g);
    halo(1.2, .42, .42, .7, [.1, .8, .9], .2, 2.3, g);
    bubblers.push({ x: .3, y: 1.2, z: .1, top: 4.4, n: 6, sp: .21, g }); }

  // ———————————————————— 对面城堡：鮟鱇头骨，上下颌之间一圈针牙，头顶骨竿吊着红色诱灯，身后是红珊瑚 ————————————————————
  { const g = castles[1], M = Mass(g), D = Quads(70, CARD, g, { cast: true }), ZS = Zh * .9, red = [1.08, .82, .86];
    terrace(M, g, -1, [1.12, .8, .9]);
    M.geo('skull', new THREE.SphereGeometry(1, 30, 9, 0, TAU, 0, Math.PI * .53), at(.12, 1.16, 0, 1.02, 1.08, ZS), { col: [.86, .82, .9] });                       // 头盖
    M.geo('skull', new THREE.SphereGeometry(1, 30, 5, 0, TAU, Math.PI * .5, Math.PI * .5), at(.04, .7, .04, 1.1, .68, ZS * 1.04));      // 下颌（一只碗）
    M.geo('pit', new THREE.SphereGeometry(1, 16, 8), at(.14, .9, 0, .9, .62, ZS * .93));                                                 // 嘴里的暗处
    // 牙：沿着颌的椭圆边一圈，上牙朝下、下牙朝上，交错着排（朝盘面和朝镜头的这大半圈）
    let a = -.95, k = 0; const TOOTH = [1.7, 1.6, 1.5], cone = (r, h) => new THREE.ConeGeometry(r, h, 5, 1, true);
    while (a < 3.5) { const cx = .12 - Math.cos(a) * 1.0, cz = Math.sin(a) * ZS, lenU = .34 + (k % 3) * .07, lenL = .28 + ((k + 1) % 3) * .07, ox = -Math.cos(a) * .05, oz = Math.sin(a) * .05;
      M.geo('bone', cone(.085, lenU + .1), at(cx + ox, 1.12 - (lenU + .1) / 2, cz + oz, 1, 1, 1, Math.PI, 0, 0), { col: TOOTH }); M.geo('bone', cone(.075, lenL + .06), at(cx - Math.cos(a + .08) * .1, .68 + (lenL + .06) / 2, cz + Math.sin(a + .08) * .2, 1, 1, 1), { col: TOOTH });
      a += .33 / Math.hypot(Math.sin(a), ZS * Math.cos(a)); k++; }
    // 诱灯的骨竿：从头顶往盘面那边弯过去
    const curve = new THREE.CatmullRomCurve3([new V3(-.2, 2.1, -.7), new V3(-.55, 2.62, -.62), new V3(-.9, 2.74, -.5), new V3(-1.15, 2.5, -.42)]);
    M.geo('bone', new THREE.TubeGeometry(curve, 12, .05, 5), new THREE.Matrix4(), { rv: 1, ru: 3 });
    for (const [x, y, z, h] of [[.5, 2.1, .5, .5], [.75, 1.95, -.4, .42], [.3, 2.15, -1.2, .46], [.62, 2.0, 1.3, .36]]) M.geo('bone', cone(.09, h), at(x, y + h / 2 - .06, z, 1, 1, 1, 0, 0, -.35));   // 头顶的骨刺
    M.done();
    { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), orbMat(BED.orbTex(K.red, 32), .62)); m.position.set(.2, .86, 0); m.scale.set(.62, .34, ZS * .74); g.add(m); }   // 喉咙里一团暗红的余烬
    lureOrb = new THREE.Mesh(new THREE.SphereGeometry(.2, 16, 10), orbMat(BED.orbTex(K.red, 48), glow(1.5))); g.add(lureOrb);
    lureLine = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, 1, 4), new THREE.MeshBasicMaterial({ color: 0x7a5a6a })); g.add(lureLine);
    const ll = new THREE.PointLight(LOOK.lure[0], LOOK.lure[1], 8, 2); ll.position.set(-1.25, 1.6, 0); g.add(ll); lights.push({ l: ll, base: LOOK.lure[1], ph: 2, sp: 1.6 });
    halo(-.12, 1.98, 1.22, .75, [1.6, .2, .1], .3, 2.1, g);                                                    // 眼窝里的一点红光
    halo(-.6, .9, .5, 2.4, [.9, .07, .1], .2, 1.3, g);                                                          // 嘴里透出来的暗红
    // 红珊瑚：身后和两头长出来的「王座」，台基上是橙色脑珊瑚、鱼骨、红海葵
    up(D, 'branchRedBig', .55, .2, -Zh - .12, 1, red); up(D, 'branchRedTall', -.42, 0, -Zh - .16, .9, red); up(D, 'branchRedTall', 1.2, STEP, -Zh + .5, .8, red, true); up(D, 'fanOrange', 1.25, STEP, -Zh - .2, 1, red);
    up(D, 'branchRed', 1.08, 0, .2, 1.1, red); up(D, 'branchRed', -.62, 0, FH / 2 - .1, .9); up(D, 'brainOrange', .5, 0, FH / 2 - .12, 1.1); up(D, 'tubeOrange', 1.05, 0, FH / 2 - .2, .9, red, true);
    up(D, 'fishbone', .1, STEP, FH / 2 + .22, 1); up(D, 'urchin', -.6, STEP, FH / 2 + .28, 1.1); up(D, 'branchOrange', 1.42, G, FH / 2 + .3, .9, red); up(D, 'scallopOrange', .82, STEP, FH / 2 + .3, 1); up(D, 'barnacleB', 1.2, STEP, -.8, 1);
    D.end();
    plant('anemRed', -.18, 0, FH / 2 - .1, 1.1, W1, g); plant('anemRed', .9, STEP, FH / 2 + .14, 1, W1, g); plant('anemRed', -.5, 0, -Zh + .05, 1, red, g); plant('anemPink', 1.3, STEP, .9, .9, red, g); plant('grassA', -.3, STEP, FH / 2 + .18, 1, [1, .7, .8], g);
    bubblers.push({ x: -.5, y: .8, z: .9, top: 4.2, n: 5, sp: .17, g }); }

  // ———————————————————— 盘后的宫殿前庭：断柱、石像、台阶、宫门残墙 ————————————————————
  { const M = WORLD, ZC = -(FH / 2 + 1.25), dim = [.86, .92, 1];
    // 一根柱子：础石 + 带凹槽的柱身 + 柱头；broken = 断在半截，顶上一块歪茬
    const column = (x, z, h, broken) => { const y = gy(x, z) - .1;
      M.box('frieze', x - .36, x + .36, y, y + .3, z - .36, z + .36, { top: 'pave' });
      M.geo('flute', new THREE.CylinderGeometry(.23, .26, h, 8, 1, !broken), at(x, y + .3 + h / 2, z), { rv: h * PPM / 48 });
      if (!broken) M.box('frieze', x - .34, x + .34, y + .3 + h, y + .62 + h, z - .34, z + .34, { top: 'pave' });
      else M.geo('rock', new THREE.IcosahedronGeometry(.24, 0), at(x + .03, y + .32 + h, z, 1, .5, 1, .2, .6, .3)); return y + .62 + h; };
    const tops = [[-6.3, 1.1, 1], [-4.75, 2.3, 0], [-3.15, 1.2, 1], [3.15, 2.3, 0], [4.75, .7, 1], [6.3, 1.7, 1], [-7.9, 1.0, 1], [7.9, 2.4, 0]].map(([x, h, b]) => [x, column(x, ZC - (Math.abs(x) > 7 ? .5 : 0), h, b)]);
    M.geo('frieze', new THREE.BoxGeometry(2.1, .4, .62), at(-5.6, gy(-5.6, ZC + .2) + .42, ZC + .2, 1, 1, 1, 0, .25, .22), { ru: 2 });   // 掉下来的一截楣梁，斜搭在断柱脚下
    M.geo('flute', new THREE.CylinderGeometry(.23, .23, 1.5, 8, 1, false), at(4.2, gy(4.2, ZC + .9) + .2, ZC + .9, 1, 1, 1, 0, .5, Math.PI / 2), { rv: 1.5 });   // 倒在地上的一截柱身
    M.geo('flute', new THREE.CylinderGeometry(.23, .23, .9, 8, 1, false), at(-2.3, gy(-2.3, ZC - .7) + .2, ZC - .7, 1, 1, 1, 0, -.3, Math.PI / 2), { rv: .9 });
    // 台阶：三级，通向宫门
    const ZG = -(FH / 2 + 3.3);
    for (let i = 0; i < 3; i++) M.box('trim', -1.9 + i * .12, 1.9 - i * .12, G - .5, G + .16 * (i + 1), ZG - .1, ZG + 1.25 - i * .36, { top: 'pave', col: dim });
    // 宫门：两根门垛 + 雕花门楣；两边的残墙高高低低，墙头塌了几处
    for (const s of [-1, 1]) { M.box('wall', Math.min(s * 1.45, s * 2.35), Math.max(s * 1.45, s * 2.35), G - .6, 2.5, ZG - .75, ZG - .05, { top: 'pave', col: dim }); }
    M.box('frieze', -2.5, 2.5, 2.5, 3.0, ZG - .8, ZG, { top: 'pave', col: dim });
    for (const [x0, x1, h] of [[-3.4, -2.35, 1.5], [-4.6, -3.4, .6], [-6.2, -4.6, -.1], [-7.6, -6.2, .35], [-10, -8.4, 0], [2.35, 3.2, 1.9], [3.2, 4.9, .5], [5.6, 7.2, -.1], [7.2, 8.6, 1.2], [8.6, 10.4, .2]]) {
      M.box('wall', x0, x1, G - .8, h, ZG - .65, ZG - .15, { top: 'pave', col: dim }); if (h > 1) M.box('frieze', x0, x1, h - .5, h - .16, ZG - .68, ZG - .12, { skip: 't', col: dim }); }
    halo(0, .9, ZG - .5, 4.2, [.1, .5, .9], .1, .5); halo(0, .7, ZG - .4, 2, [.5, .25, .9], .12, .7);            // 门洞里透出来的光
    // 几块真的礁石（有体积、会投影），小件长在它们上面
    for (const [x, z, s] of [[-3.9, ZC - 1.1, .8], [2.5, ZC - 1.3, .7], [-6.9, ZC + .6, .9], [6.6, ZC - .9, 1], [-8.6, -1.2, 1.1], [8.8, -.6, 1.2], [-6.6, 2.4, .9], [6.9, 2.9, .8], [-3.3, FH / 2 + 2.3, .7], [3.9, FH / 2 + 2.6, .9], [.4, FH / 2 + 3.4, .8], [-5.6, -9, 1.6], [5.2, -10.5, 1.8], [0, -12.5, 1.5], [-10.5, -6.5, 1.6], [11, -7.5, 1.5]])
      M.geo('rock', new THREE.IcosahedronGeometry(1, 1), at(x, gy(x, z) + .05, z, s * R.in(.75, 1.05), s * R.in(.42, .62), s * R.in(.55, .8), R.in(-.2, .2), R.in(0, 6), R.in(-.2, .2)), { ru: 2, rv: 2, col: dep(z, x) });
  }
  WORLD.done();
  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(cau.p, 3)); g.setAttribute('amt', new THREE.Float32BufferAttribute(cau.a, 1)); const m = new THREE.Mesh(g, CAUSTIC); m.frustumCulled = false; m.renderOrder = 2; scene.add(m); }

  // ———————————————————— 小件：摆几百个 ————————————————————
  const COOL = ['branchTeal', 'branchWhite', 'branchViolet', 'fanViolet', 'tableTeal', 'tubeViolet', 'whipCyan', 'bulbCyan', 'tubewormWhite', 'brainLemon', 'branchMag', 'fanMag'];
  const WARM = ['branchPink', 'branchOrange', 'branchRed', 'fanPink', 'fanOrange', 'tablePink', 'tubeOrange', 'brainOrange', 'brainPink', 'whipMag', 'bulbMag', 'tubewormPink', 'tubeLemon'];
  const GLOWY = { bulbCyan: [.1, .8, 1], bulbMag: [1, .2, .8], whipMag: [.9, .3, .7], whipCyan: [.2, .8, 1], branchTeal: [.1, .7, .7], branchMag: [.8, .2, .7] };
  const SWAY = ['anemTeal', 'anemPink', 'anemRed', 'anemViolet', 'grassA', 'grassB', 'kelpB'], SHORTY = SWAY.slice(0, 6);   // SHORTY：镜头前只摆矮的，不挡最前面一路
  const free = (x, z, m = .15) => Math.abs(x) > PXO + m || Math.abs(z) > PZ + m;                                 // 不在石台上
  const pickSide = x => R() < .22 ? R.pick(x < 0 ? WARM : COOL) : R.pick(x < 0 ? COOL : WARM);                    // 左半边偏冷色的珊瑚，右半边偏暖色：和两座城堡呼应
  const coral = (x, z, s) => { if (!free(x, z)) return; const n = pickSide(x), y = gy(x, z), c = dep(z, x), gl = GLOWY[n];
    up(CAST, n, x, y - .03, z, s, gl ? c.map(v => v * glow(1.25)) : c, R() < .5); if (gl && z < Zh && R() < .7) halo(x, y + E(n).h * s * .7, z + .02, .9 * s, gl, .25, R.in(1.2, 2.6)); };
  // 一丛礁：一堆长满珊瑚虫的石头，周围几株珊瑚、海葵和海草
  const reef = (x, z, s) => { if (!free(x, z, .3)) return; const c = dep(z, x);
    up(CAST, R() < .5 ? 'moundA' : 'moundB', x, gy(x, z) - .08, z - .05, s, c, R() < .5);
    for (let i = 0, n = 3 + R.int(0, 2); i < n; i++) coral(x + R.in(-.9, .9) * s, z + R.in(-.1, .3) * s, s * R.in(.7, 1.15));
    for (let i = 0; i < 2; i++) { const px = x + R.in(-1, 1) * s, pz = z + R.in(.1, .4); if (free(px, pz)) plant(R.pick(z > 0 ? SHORTY : SWAY), px, gy(px, pz) - .02, pz, s * R.in(.8, 1.1), c); } };
  // 盘后：礁丛压在断柱和残墙之间；越靠后摆得越大
  const ZB = -(FH / 2 + .4);
  for (const [x, z, s] of [[-5.5, ZB - .9, 1.1], [-7.6, ZB - 1.8, 1.3], [-3.4, ZB - 2.2, .9], [-9.6, ZB - .4, 1.3], [5.4, ZB - 1.0, 1.1], [7.4, ZB - 2.0, 1.3], [3.3, ZB - 2.1, .9], [9.7, ZB - .6, 1.3],
    [-2.9, ZB - 3.6, 1.2], [2.9, ZB - 3.7, 1.2], [-6.4, ZB - 4.2, 1.5], [6.6, ZB - 4.4, 1.5], [-9.4, ZB - 4.0, 1.6], [9.6, ZB - 3.8, 1.6], [-4, ZB - 6.5, 1.9], [4.2, ZB - 7, 1.9], [0, ZB - 8.4, 2], [-8.5, ZB - 8, 2.2], [8.8, ZB - 8.6, 2.2],
    [-6.3, -.9, 1], [-6.5, 1.1, 1], [6.4, -1.2, 1], [6.5, .9, 1], [-7.9, .2, 1.2], [8, 0, 1.2],                    // 两座城堡外侧
    [-5.4, FH / 2 + 1.4, 1], [-2.4, FH / 2 + 1.7, .9], [1.9, FH / 2 + 1.6, .9], [5.2, FH / 2 + 1.5, 1], [-4.1, FH / 2 + 3, 1.1], [3.2, FH / 2 + 3.2, 1.1], [-.6, FH / 2 + 2.6, 1]]) reef(x, z, s);   // 镜头前那一条
  // 石台脚下一圈：贴着台阶长的小珊瑚、贝、海胆
  for (let i = 0; i < 46; i++) { const back = i < 26, x = R.in(-PXO - .3, PXO + .3), z = back ? -PZ - R.in(.12, .7) : PZ + R.in(.12, .8), y = gy(x, z), c = dep(z, x);
    const n = R.pick(['pebbleS', 'pebbleM', 'scallopPink', 'scallopWhite', 'conch', 'urchin', 'barnacleA', 'barnacleB', 'tubewormPink', 'brainLemon', 'conchOrange', 'pebbleS']);
    up(CAST, n, x, y - .02, z, R.in(.8, 1.2), c, R() < .5); }                        // 盘后这一条会被后排棋子的头压到，压暗一点、摆矮的
  for (let i = 0; i < 16; i++) { const x = R.in(-PXO, PXO), z = -PZ - R.in(.15, .8); plant(R.pick(['grassA', 'grassB', 'grassA', 'anemViolet']), x, gy(x, z) - .02, z, R.in(.8, 1.1), dep(z, x)); }
  // 满地的零碎：海星、贝壳、小石子躺在沙上
  for (let i = 0; i < 150; i++) { const x = R.in(-11, 11), z = R() < .7 ? R.in(-12, -PZ) : R.in(PZ, PZ + 3.6); if (!free(x, z)) continue; const y = gy(x, z) + .02, c = dep(z, x);
    if (R() < .4) lay(FLAT, R.pick(['starOrange', 'starPink', 'starViolet']), x, y, z, R.in(.8, 1.3), R.in(0, 6), c); else if (R() < .25) lay(FLAT, R.pick(['coinsA', 'coinsB', 'planks']), x, y, z, R.in(.7, 1), R.in(0, 6), c);
    else up(CAST, R.pick(['pebbleS', 'pebbleM', 'pebbleS', 'scallopPink', 'scallopOrange', 'conch', 'urchin', 'pebbleL', 'barnacleA']), x, y - .04, z, R.in(.7, 1.3), c, R() < .5); }
  // 散的珊瑚和海带，把礁丛之间的沙地填上
  for (let i = 0; i < 70; i++) { const x = R.in(-11.5, 11.5), z = R() < .78 ? R.in(-13, -PZ - .9) : R.in(PZ + .5, PZ + 3.4); coral(x, z, R.in(.8, 1.2) * (z < -8 ? 1.5 : 1)); }
  for (let i = 0; i < 34; i++) { const x = R.in(-11, 11), z = R() < .75 ? R.in(-11, -PZ - 1.4) : R.in(PZ + .6, PZ + 3.2); if (!free(x, z, .4)) continue; plant(R.pick(z > 0 ? ['grassA', 'grassB', 'anemPink'] : ['kelpA', 'kelpB', 'kelpA', 'kelpC', 'grassA']), x, gy(x, z) - .03, z, R.in(.8, 1.15), dep(z, x).map(v => v * .9)); }
  // 沉在前庭里的东西
  { const c = dep(-4), ZC = -(FH / 2 + 1.25);
    up(CAST, 'statue', -1.5, gy(-1.5, ZC + .15), ZC + .15, 1, [.56, .64, .78]); up(CAST, 'statue', 1.5, gy(1.5, ZC + .15), ZC + .15, 1, [.56, .64, .78], true);
    // 藏宝箱和金币：摆在台阶脚下，高过后排棋子的头
    const tz = -(FH / 2 + 2.75), ty = G + .48; up(CAST, 'chest', -.3, ty, tz, 1.2, [glow(1.12), glow(1.06), .95]); halo(-.3, ty + .45, tz + .02, 1.3, [1, .7, .2], .15, 1.7);
    for (const [dx, dz, r] of [[-.8, .16, 1], [.5, .2, 2], [.1, .3, 4], [1.0, .1, 5], [-1.2, .3, 3]]) lay(FLAT, r & 1 ? 'coinsA' : 'coinsB', -.3 + dx, ty + .02, tz + dz, 1, r, [1.05, 1, .9]);
    up(CAST, 'amphora', .85, ty, tz - .1, 1.1, c); up(CAST, 'amphoraBroken', 1.3, ty, tz + .12, 1, c); up(CAST, 'amphora', -4.6, gy(-4.6, ZC + .5), ZC + .5, 1, c, true); up(CAST, 'amphoraBroken', 5.6, gy(5.6, ZC + .2), ZC + .2, 1.1, c);
    up(CAST, 'barrel', 2.4, gy(2.4, ZC - .5), ZC - .5, 1.1, c); up(CAST, 'wheel', -2.6, gy(-2.6, ZC - .4) - .1, ZC - .4, 1.2, c); up(CAST, 'barrel', -7.3, gy(-7.3, ZC - .2), ZC - .2, 1, c);
    up(CAST, 'anchor', 5.9, gy(5.9, ZC + .6) - .12, ZC + .6, 1.25, c); for (let i = 0; i < 3; i++) lay(FLAT, 'chain', 5.2 - i * 1.05, gy(5.2 - i * 1.05, ZC + 1) + .03, ZC + 1 + i * .12, 1, .15 * i, c);
    up(CAST, 'columnStub', -9.3, gy(-9.3, ZC - 1.5), ZC - 1.5, 1.2, dep(-6)); up(CAST, 'columnTall', 9.6, gy(9.6, ZC - 2.2), ZC - 2.2, 1.1, dep(-6)); up(CAST, 'columnBroken', -11.2, gy(-11.2, ZC - 2.6), ZC - 2.6, 1.2, dep(-7));
    up(CAST, 'fishbone', 3.4, gy(3.4, ZC + .7), ZC + .7, 1.2, c); up(CAST, 'nautilus', -3.6, gy(-3.6, ZC + .8), ZC + .8, 1.1, c);
    // 镜头前那一条：锚、罐子、另一只小箱子（大半会被手牌盖住，只在两边露出来）
    up(CAST, 'anchor', -4.9, gy(-4.9, PZ + 1) - .15, PZ + 1, 1.1, dep(4)); up(CAST, 'amphora', 4.3, gy(4.3, PZ + .8), PZ + .8, 1.1, dep(4)); up(CAST, 'chest', 2.9, gy(2.9, PZ + 1.2), PZ + 1.2, 1, dep(4)); up(CAST, 'wheel', -1.6, gy(-1.6, PZ + 1.1) - .1, PZ + 1.1, 1.1, dep(4));
    // 珍珠灯：盘后两角各一盏（带点光），宫门两边各一盏，镜头前两盏
    lamp(-(HALF + .15), ZB - .35, 1.45, true); lamp(HALF + .15, ZB - .35, 1.45, true); lamp(-2.75, -(FH / 2 + 3.0), 1.5, !low); lamp(2.75, -(FH / 2 + 3.0), 1.5, !low);
    lamp(-(HALF + .9), PZ + .35, 1.1, false); lamp(HALF + .9, PZ + .35, 1.1, false); lamp(-7.2, ZB - 2.6, 1.6, false); lamp(7.4, ZB - 2.9, 1.6, false); }
  // 巨蚌：会慢慢张开、露出珍珠，再合上
  for (const [x, z, s] of [[-2.6, -(FH / 2 + 2.3), 1.3], [2.3, -(FH / 2 + 1.5), 1.1], [6.1, -(FH / 2 + .9), 1.2], [-6.9, -(FH / 2 + 1.2), 1.25], [-3.1, PZ + .9, 1], [.2, -(FH / 2 + 4.6), 1.5]]) clams.push({ x, y: gy(x, z) - .04, z, s, ph: R(), col: dep(z) });
  for (const [x, z, w] of [[-1.2, -(FH / 2 + .75), 1.6], [3.2, -(FH / 2 + 1.0), 1.2], [1.2, PZ + .5, 1.5]]) crabs.push({ x, z, w, ph: R.in(0, 9) });
  // 远景：宫殿和沉船的剪影、三排珊瑚林，全靠海水的雾把它们一层层推远
  // （镜头俯着看，z 小于 −9 的东西已经出了画面上沿，所以「远」只能收在残墙后面两三米里，靠雾把它们推远）
  { const fz = [1.5, 1.75, 2];                                                                                // 剪影比雾亮：淡蓝的影子浮在深蓝里
    up(FAR, 'wreck', -8.9, gy(-8.9, -7.1) - .3, -7.1, .8, fz); up(FAR, 'palace', 6.6, gy(6.6, -7.5) - .1, -7.5, .5, fz); up(FAR, 'wreck', 13.2, gy(13.2, -7.2) - .2, -7.2, .6, fz, true); up(FAR, 'palace', -14, gy(-14, -6.6) - .1, -6.6, .45, fz, true);
    for (const [x, z, s, n] of [[-4.2, -7.9, .7, 'forestB'], [.4, -8.4, .8, 'forestA'], [10.4, -7.9, .8, 'forestB'], [-14.5, -6.4, .9, 'forestA'], [15, -6.2, .9, 'forestB'], [-2.2, -9.2, .9, 'forestA'], [3, -9, .8, 'forestB']]) up(FAR, n, x, gy(x, z) - .1, z, s, [1.1, 1.3, 1.5], R() < .5);
    up(FAR, 'columnBroken', 3.4, gy(3.4, -7) - .2, -7, .8, [.8, .9, 1]); up(FAR, 'columnTall', 10.8, gy(10.8, -6.8) - .2, -6.8, .8, [.8, .9, 1]); up(FAR, 'columnBroken', -3.4, gy(-3.4, -6.9) - .2, -6.9, .8, [.8, .9, 1]); }
  CAST.end(); FLAT.end(); FAR.end();

  // 鱼群：每群绕着一个扁的椭圆游，前后错开
  for (const [n, cx, cy, cz, rx, rz, sp, cnt] of [['fishOrange', -3.2, 1.5, -(FH / 2 + 1.5), 3.0, .6, .16, 11], ['fishTeal', 3.4, 1.15, -(FH / 2 + 2.3), 2.8, .7, -.13, 12], ['fishLemon', -7.2, 1.7, -1.6, 2.2, .9, .1, 10], ['fishSilver', 7.4, 2.0, -.8, 2.2, .8, -.11, 10], ['fishPink', -5.6, .5, PZ + 1.3, 2.4, .6, .14, 8]]) {
    const fish = []; for (let i = 0, m = low ? Math.ceil(cnt / 2) : cnt; i < m; i++) fish.push({ off: R.in(0, .9), dx: R.in(-.35, .35), dy: R.in(-.3, .3), dz: R.in(-.25, .25), s: R.in(.9, 1.4), ph: R.in(0, TAU) });
    schools.push({ f: A[n], cx, cy, cz, rx, rz, sp, fish, col: dep(cz).map(v => v * glow(1.1)) }); }
  // 水母：三种颜色，慢慢漂、一张一缩，身后带一团自己颜色的光
  for (const [n, x, y, z, s, rgb] of [['jellyCyan', -6.3, 2.2, -.6, 1.1, [.1, .8, 1]], ['jellyMag', 6.5, 2.4, -1.4, 1.1, [1, .2, .8]], ['jellyViolet', -8.6, 1.6, 1.2, 1.2, [.55, .3, 1]], ['jellyCyan', 8.9, 1.5, .9, 1.2, [.1, .8, 1]],
    ['jellyMag', -5.4, 1.5, -(FH / 2 + 2.4), 1.2, [1, .2, .8]], ['jellyViolet', 5.2, 1.3, -(FH / 2 + 2.9), 1.2, [.55, .3, 1]], ['jellyCyan', 2.3, .9, -(FH / 2 + 3.6), 1.1, [.1, .8, 1]], ['jellyMag', -7.4, .6, 3.0, .9, [1, .2, .8]]]) jellies.push({ f: A[n], x, y, z, s, rgb, ph: R.in(0, TAU) });
  // 气泡：从礁缝、宝箱、蚌口里一串串往上冒（城堡那两串在上面登记过了）
  for (const [x, z, n] of [[-.3, -(FH / 2 + 2.75), 6], [-3.9, -(FH / 2 + 2.3), 7], [2.6, -(FH / 2 + 2.6), 6], [6.3, -(FH / 2 + 1), 5], [-7, -(FH / 2 + 1.6), 6], [0, -(FH / 2 + 6), 7]]) bubblers.push({ x, y: gy(x, z) + .3 + (x === -.3 ? .6 : 0), z, top: 4.6, n: low ? Math.ceil(n / 2) : n, sp: R.in(.14, .2), g: null });
  // 光柱：几道从水面斜着漏下来的光，立在盘后和两侧
  const shafts = [[-7.6, -1.2, 1.9], [-5.6, -(FH / 2 + 1.9), 1.5], [-1.4, -(FH / 2 + 2.4), 1.4], [2.3, -(FH / 2 + 2.9), 1.6], [5.9, -(FH / 2 + 1.7), 1.5], [8.0, -.6, 1.9], [-9.8, 1.6, 2.1], [9.9, 1.9, 2.1]].map(([x, z, w]) => ({ x, z, w, ph: R.in(0, TAU), sp: R.in(.25, .5) }));
  // 浮游的发光微粒
  const motes = []; for (let i = 0, n = low ? 45 : 90; i < n; i++) motes.push({ x: R.in(-9, 9), y: R.in(G + .2, 4), z: R.in(-9, 4), ph: R.in(0, TAU), sp: R.in(.03, .09), s: R.in(.05, .11), rgb: R.pick([[.2, .9, 1], [.2, .9, 1], [1, .3, .9], [.7, 1, .9], [1, .9, .5]]) });
  // 远处的大鱼剪影
  const rovers = [{ f: A.manta, y: 1.15, z: -(FH / 2 + 2.9), s: 1.25, sp: .5, span: 34, off: 6, dir: 1 }, { f: A.turtle, y: .9, z: -(FH / 2 + 3.6), s: 1.1, sp: .32, span: 30, off: 19, dir: -1 }];
  // 贴镜头的前景剪影：按画面坐标（−1…1）定在下面两个角上；hf = 占画面高度的几成
  const FG = SHORT
    ? [{ f: A.fgKelp, nx: -1.0, ny: -1.05, hf: .8, ph: 0 }, { f: A.fgKelp, nx: 1.0, ny: -1.08, hf: .7, ph: 2, flip: true }]
    : [{ f: A.fgKelp, nx: -1.0, ny: -1.04, hf: 1.12, ph: 3 }, { f: A.fgKelp, nx: 1.01, ny: -1.3, hf: 1.25, ph: 1 }, { f: A.fgKelp, nx: -.9, ny: -1.04, hf: .62, ph: 0 }, { f: A.fgKelp, nx: -.8, ny: -1.12, hf: .44, ph: 1, flip: true }, { f: [A.fgBranch], nx: -.66, ny: -1.02, hf: .3, ph: 0 },
      { f: A.fgKelp, nx: .97, ny: -1.06, hf: .56, ph: 2, flip: true }, { f: [A.fgFan], nx: .8, ny: -1.03, hf: .4, ph: 0 }];

  // ———————————————————— 光、雾、后期 ————————————————————
  scene.background.set(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 20, 46);
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1];
  sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1]; sun.position.set(...LOOK.sun[2]);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03;
  { const f = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); f.position.set(...LOOK.fill[2]); scene.add(f); }
  if (post && !low) {
    post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
    const tl = SHORT ? LOOK.tiltShort : LOOK.tilt; for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = tl.focus; p.uniforms.band.value = tl.band; p.uniforms.amt.value = tl.amt; }
    const u = post.grade.uniforms, gr = LOOK.grade; u.sat.value = gr.sat; u.con.value = gr.con; u.knee.value = gr.knee; u.gain.value.setRGB(...gr.gain); u.lift.value.setRGB(...gr.lift); u.edge.value.setRGB(...gr.edge); post.grade.enabled = true;
  }

  // ———————————————————— 每帧 ————————————————————
  const AIM = new V3(0, .95, -.1), va = new V3(), vb = new V3(), vr = new V3(), vu = new V3(), SEQ = [0, 1, 2, 1], PEARL0 = pearl.position.clone();
  let last = 0;
  function tick(t) {
    last = t; const beat = Math.floor(t * 8);                                 // 像素类的动画都踩在每秒 8 拍上
    // 雾跟着镜头的远近走：棋盘永远在雾外，往后 30 米吞完
    const dcam = camera.position.distanceTo(AIM); scene.fog.near = dcam + 1.5; scene.fog.far = dcam + 15;
    CAUSTIC.uniforms.t.value = t; CAUSTIC.uniforms.fogR.value.set(dcam + 1, dcam + 13);

    LIVE.begin(); for (const q of GQ.values()) { q.live.begin(); q.soft.begin(); }
    for (const p of plants) { const e = p.f[((beat + p.ph) >> 1) % p.f.length]; p.q.put(e, p.x, p.y, p.z, e.w * p.s / 2, 0, 0, 0, e.h * p.s, 0, p.col[0], p.col[1], p.col[2], p.flip); }
    for (const c of clams) { const k = (t * .09 + c.ph) % 1, e = A.clam[k < .5 ? 0 : k < .55 || k > .93 ? 1 : 2]; LIVE.put(e, c.x, c.y, c.z, e.w * c.s / 2, 0, 0, 0, e.h * c.s, 0, c.col[0], c.col[1], c.col[2], false); }
    for (const c of crabs) { const k = ((t * .07 + c.ph) % 2 + 2) % 2, u = k < 1 ? k : 2 - k, moving = Math.sin(t * .6 + c.ph) > -.3, x = c.x + (u - .5) * c.w, e = A.crab[moving ? beat & 1 : 0]; LIVE.put(e, x, gy(x, c.z) - .01, c.z, e.w / 2, 0, 0, 0, e.h, 0, .9, .9, .95, k > 1); }
    for (const s of schools) for (let i = 0; i < s.fish.length; i++) { const f = s.fish[i], a = t * s.sp + f.off, e = s.f[(beat + i) & 1], x = s.cx + Math.cos(a) * s.rx + f.dx, z = s.cz + Math.sin(a) * s.rz + f.dz, y = s.cy + f.dy + Math.sin(t * .9 + f.ph) * .08;
      LIVE.put(e, x, y, z, e.w * f.s / 2, 0, 0, 0, e.h * f.s, 0, s.col[0], s.col[1], s.col[2], -Math.sin(a) * s.sp < 0); }
    for (const j of jellies) { const pulse = SEQ[((beat >> 1) + Math.floor(j.ph * 2)) & 3], e = j.f[pulse]; j.cx = j.x + Math.sin(t * .11 + j.ph) * .7; j.cy = j.y + Math.sin(t * .37 + j.ph * 2) * .3 + (pulse === 2 ? .03 : 0); const k = glow(1.3);
      LIVE.put(e, j.cx, j.cy, j.z, e.w * j.s / 2, 0, 0, 0, e.h * j.s, 0, k, k, k, false); }
    for (const b of bubblers) { const ox = b.g ? b.g.position.x : 0, oy = b.g ? b.g.position.y : 0;
      for (let i = 0; i < b.n; i++) { const u = (t * b.sp + i / b.n + (i * .37) % .11) % 1, e = A.bubble[i % 3], s = .6 + u * .7, x = b.x + ox + Math.sin(u * 11 + i * 2.1) * .07 * (1 + u * 2), y = b.y + oy + u * (b.top - b.y); if (u > .96) continue; LIVE.put(e, x, y, b.z, e.w * s / 2, 0, 0, 0, e.h * s, 0, 1, 1, 1, false); } }
    for (const r of rovers) { const u = ((t * r.sp + r.off) % r.span + r.span) % r.span, x = (u - r.span / 2) * r.dir, e = r.f[(beat >> 2) & 1], y = r.y + Math.sin(t * .3 + r.off) * .25; LIVE.put(e, x, y, r.z, e.w * r.s / 2, 0, 0, 0, e.h * r.s, 0, .8, .9, 1, r.dir < 0); }
    for (const L of lamps) { const e = A.lampOrb, k = glow(1.06 + .1 * Math.sin(t * 1.3 + L.ph)), s = L.s * .8; LIVE.put(e, L.x, L.y, L.z, e.w * s / 2, 0, 0, 0, e.h * s, 0, k, k * .74, k * .4, false); if (L.light) L.light.intensity = LOOK.lamp[1] * (.8 + .25 * Math.sin(t * 1.3 + L.ph)); }
    LIVE.end();

    const sw = Math.sin(t * 1.3) * .16, lx = -1.15 + Math.sin(sw) * .5, ly = 2.5 - Math.cos(sw) * .5;   // 诱灯在竿头下面摇到哪了
    SOFT.begin();
    const hl = (x, y, z, size, r, g, b) => SOFT.put(HALO, x, y - size / 2, z, size / 2, 0, 0, 0, size, 0, r, g, b, false);
    for (const h of halos) { const k = (1 - h.amp + h.amp * Math.sin(t * h.sp + h.ph)) * (low ? .35 : .5); h.q.put(HALO, h.x, h.y - h.size / 2, h.z, h.size / 2, 0, 0, 0, h.size, 0, h.rgb[0] * k, h.rgb[1] * k, h.rgb[2] * k, false); }
    for (const L of lamps) { const k = (.26 + .08 * Math.sin(t * 1.3 + L.ph)) * (low ? .6 : 1); hl(L.x, L.y + .14 * L.s, L.z + .02, 1.2 * L.s, k, k * .55, k * .2); }
    for (const j of jellies) { const k = .26 + .08 * Math.sin(t * 2 + j.ph); hl(j.cx, j.cy + .55 * j.s, j.z - .02, 1.5 * j.s, j.rgb[0] * k, j.rgb[1] * k, j.rgb[2] * k); }
    for (const s of shafts) { const k = (.34 + .16 * Math.sin(t * s.sp + s.ph) + .06 * Math.sin(t * s.sp * 2.7 + s.ph)) * (low ? .6 : 1), dx = Math.sin(t * .07 + s.ph) * .3; SOFT.put(SHAFT, s.x + dx, G - .2, s.z, s.w, 0, 0, -1.1, 5.6, 0, .45 * k, .9 * k, k, false); }
    for (const m of motes) { const y = G + .2 + ((m.y - G + t * m.sp) % 4.4), x = m.x + Math.sin(t * .23 + m.ph) * .35, k = (.35 + .35 * Math.sin(t * 1.7 + m.ph * 5)) * (m.z > -Zh - .4 && Math.abs(m.x) < HALF + .4 ? .4 : 1); SOFT.put(MOTE, x, y, m.z, m.s / 2, 0, 0, 0, m.s, 0, m.rgb[0] * k, m.rgb[1] * k, m.rgb[2] * k, false); }
    { const k = (.5 + .12 * Math.sin(t * 1.6 + 2)) * (low ? .6 : 1); GQ.get(castles[1]).soft.put(HALO, lx, ly - .95, -.4, .95, 0, 0, 0, 1.9, 0, k, .22 * k, .1 * k, false); }   // 诱灯的红晕
    SOFT.end(); for (const q of GQ.values()) { q.live.end(); q.soft.end(); }

    // 前景剪影：从画面坐标反推到镜头前不远处的一个点，再沿镜头自己的右和上方向摆片
    camera.updateMatrixWorld(); vr.setFromMatrixColumn(camera.matrixWorld, 0); vu.setFromMatrixColumn(camera.matrixWorld, 1);
    const Hf = va.set(0, 1, .5).unproject(camera).distanceTo(vb.set(0, -1, .5).unproject(camera));                // 那个深度上，整个画面有多高
    FGQ.begin();
    for (const f of FG) { const e = f.f[((beat >> 1) + f.ph) % f.f.length], h = Hf * f.hf, w = h * e.w / e.h / 2; va.set(f.nx, f.ny, .5).unproject(camera);
      FGQ.put(e, va.x, va.y, va.z, vr.x * w, vr.y * w, vr.z * w, vu.x * h, vu.y * h, vu.z * h, .55, .7, .9, !!f.flip); }
    FGQ.end();

    // 大珍珠轻轻浮动、呼吸；诱灯吊在骨竿头上摇
    const br = Math.sin(t * 1.1); pearl.position.y = PEARL0.y + Math.sin(t * .8) * .03; pearl.material.color.setScalar(glow(1.12 + .1 * br));
    lureOrb.position.set(lx, ly, -.42); lureOrb.material.color.setScalar(glow(1.4 + .2 * Math.sin(t * 1.6 + 2)));
    lureLine.position.set((lx - 1.15) / 2, (ly + 2.5) / 2, -.42); lureLine.rotation.z = sw; lureLine.scale.y = .5;
    for (const L of lights) L.l.intensity = L.base * (.86 + .16 * Math.sin(t * L.sp + L.ph));
    lights[1].l.position.set(lx, ly, .1);
  }

  const again = () => requestAnimationFrame(() => tick(last));               // 镜头是 build 之后才摆好的，窗口变了也会重摆：补摆一次前景
  addEventListener('resize', again); again(); setTimeout(again, 400);
  scene.updateMatrixWorld(true); tick(0);
  return { tick };
}
