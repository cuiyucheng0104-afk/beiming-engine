// 《彩窗圣堂》：哥特式教堂的中殿。阳光从后墙的大玫瑰窗和两侧的尖拱窗照进来，在空气里拉出彩色的光柱、在地上投下彩色的光斑；
// 暗部是冷的蓝紫，暖光来自成排的蜡烛。棋盘是深色大理石嵌拼（比棋子暗、素），两座城堡是两栋小建筑：本方蓝宝石尖拱窗的礼拜龛、对面红宝石圆窗的祭火门楼。
// 文件分工：paint.js 画法库（距离场 + 镶嵌格 + 七级色阶）；tex.js 大面贴图；glass.js 彩窗；props.js 小件；light.js 加色光图；本文件搭场景、打光、做动画。
// 只用 ctx.THREE，不改游戏的任何对象结构：格子只换材质，城堡搭在游戏给的两个组里。
import { PPM, S, hash } from './paint.js';
import * as TX from './tex.js';
import * as GL from './glass.js';
import { sprites } from './props.js';
import { lightSet } from './light.js';

// 调画面只改这一组数。棋子不吃光（永远是贴图原色），所以场景整体压暗、暗部往蓝紫偏，最鲜艳的颜色留给盘外的彩窗和色光
const LOOK = {
  bg: '#05030c', fog: '#1b154c',
  amb: ['#6f63dc', .6], sun: ['#ffd9a6', 4.2], fill: ['#a99cff', .46], lamp: 3,
  glass: 1.22, rose: 1.36, flame: 1.5,                    // 自发光片的亮度（高画质档超过 1 的部分会晕开）
  halo: .34, shaft: .78, patch: .6, haze: .13,             // 灯晕、光柱、地上的色光、窗前的雾光
  bloom: [.32, .7, .9],                                  // 强度、半径、亮过多少才发光
  tilt: { focus: .46, band: .25, amt: 2 },               // 移轴：清楚的一带压在棋盘上，血量牌也要在这一带里
  tiltM: { focus: .56, band: .3, amt: 1.5 },             // 手机横屏：棋盘占了大半个画面、血量牌贴着上沿，清楚的一带放宽、上移
  grade: { sat: 1.13, con: 1.14, knee: .82, gain: [1.03, .99, 1.04], lift: [.004, .002, .012], edge: [0, 0, 0] },
};
const SUN_FROM = [-6, 15, -9];                           // 主光从后上方偏左来（逆光），影子朝镜头、朝右落
const WHITE = [1, 1, 1], TAU = Math.PI * 2;
const rnd = (i, k = 0) => hash(i, k, 991);               // 确定性随机（每次进场摆法一样）

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, calm, grid } = ctx;
  const { LX, LZ, HALF, DEPTH, SHORT } = grid;
  // —— 布局用的几个基准：全部从棋盘尺寸推出来，桌面和手机横屏都适用 ——
  const BK = -DEPTH / 2, FR = DEPTH / 2;                 // 盘的后沿、前沿
  const EDGE = HALF + 2.3;                               // 城堡的外沿
  const FY = -.14;                                       // 中殿地面比盘面低一级台阶
  const WALLZ = BK - 3;                                  // 后墙
  const DX = HALF + 2.75, DZ0 = BK - .85, DZ1 = FR + .85;   // 托着棋盘和两座小龛的台基
  const RY = 1.5, RS = 1;                              // 玫瑰窗的圆心高度、缩放
  const G = v => low ? Math.min(v, 1.12) : v;            // 低画质档没有泛光：自发光别超过 1.15

  // ================= 贴图 =================
  const px = (cv, rep) => { const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  const T = {}; for (const k of ['floor', 'mosaic', 'carpet', 'wall', 'pier', 'wood', 'slab', 'pave']) T[k] = px(TX[k]().canvas(), true);
  const TROOF = px(TX.roof().canvas(), true);              // 本方小龛的瓦顶（只在城堡组里用）
  // 把一堆小图拼成一张图集：按高矮排成一行行。smooth = 给加色光图用（线性过滤）
  function pack(plates, W, pad, smooth) {
    const names = Object.keys(plates).sort((a, b) => plates[b].h - plates[a].h), at = {}; let x = pad, y = pad, row = 0;
    for (const n of names) { const p = plates[n]; if (x + p.w + pad > W) { x = pad; y += row + pad; row = 0; } at[n] = { x, y, w: p.w, h: p.h, tips: p.tips || null }; x += p.w + pad; row = Math.max(row, p.h); }
    const H = y + row + pad, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), e = smooth ? .5 : .02;
    for (const n of names) { const a = at[n]; g.drawImage(plates[n].canvas(), a.x, a.y); a.u0 = (a.x + e) / W; a.u1 = (a.x + a.w - e) / W; a.vt = 1 - (a.y + e) / H; a.vb = 1 - (a.y + a.h - e) / H; }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false;
    if (smooth) tex.magFilter = tex.minFilter = THREE.LinearFilter; else tex.magFilter = tex.minFilter = THREE.NearestFilter;
    return { tex, at };
  }
  const glass = { rose: GL.rose(), lancets: GL.lancets(), own: GL.ownGlass(), foe: GL.foeGlass() };
  const plates = sprites(); plates.glRose = glass.rose; plates.glOwn = glass.own; plates.glFoe = glass.foe; glass.lancets.forEach((p, i) => { plates['glL' + i] = p; });
  const ATLAS = pack(plates, 1024, 1, false), AT = ATLAS.at, LIGHTS = pack(lightSet(glass), 512, 2, true), LT = LIGHTS.at;
  const spr = n => { const a = AT[n]; if (!a) throw new Error('圣堂：没有这个小件 ' + n); return a; };

  // ================= 实体：按贴图拼成几张网格 =================
  // 石匠：往同一张平铺贴图的网格里加方块、圆柱、山墙。uv 按世界尺寸铺（每米 48 像素）；dark(k) 之后越高越暗
  function Mason(tex) {
    const su = PPM / tex.image.width, sv = PPM / tex.image.height, P = [], N = [], U = [], K = [], I = [];
    const m = new THREE.Matrix4(), q = new THREE.Vector3(), eu = new THREE.Euler(), qt = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), at = new THREE.Vector3();
    let moved = false, dk = 0, tint = WHITE;
    const vtx = (p, n, uv) => {
      q.set(p[0], p[1], p[2]); if (moved) q.applyMatrix4(m); P.push(q.x, q.y, q.z); const k = dk ? Math.max(.16, Math.min(1, 1 - (q.y - 1) * dk)) : 1;
      q.set(n[0], n[1], n[2]); if (moved) q.transformDirection(m); N.push(q.x, q.y, q.z); U.push(uv[0] * su, uv[1] * sv); K.push(tint[0] * k, tint[1] * k, tint[2] * k);
    };
    const B = {
      tint(c) { tint = c; return B; }, dark(k) { dk = k; return B; },
      at(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { moved = !!(x || y || z || rx || ry || rz); if (moved) m.compose(at.set(x, y, z), qt.setFromEuler(eu.set(rx, ry, rz)), one); return B; },
      // 一个四边形：四个角（从外面看逆时针）、法线（一条，或每个角一条）、四个角的 uv（单位是米）
      quad(pts, n, uv) { const i0 = P.length / 3, each = Array.isArray(n[0]); for (let i = 0; i < 4; i++) vtx(pts[i], each ? n[i] : n, uv[i]); I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3); return B; },
      tri(pts, n, uv) { const i0 = P.length / 3; for (let i = 0; i < 3; i++) vtx(pts[i], n, uv[i]); I.push(i0, i0 + 1, i0 + 2); return B; },
      // 方块；skip 里写上不要的面：f 前（朝镜头）b 后 l 左 r 右 t 顶（底面从来不画）
      box(x0, x1, y0, y1, z0, z1, skip = '') {
        if (!skip.includes('f')) B.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        if (!skip.includes('b')) B.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [[-x1, y0], [-x0, y0], [-x0, y1], [-x1, y1]]);
        if (!skip.includes('r')) B.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [[-z1, y0], [-z0, y0], [-z0, y1], [-z1, y1]]);
        if (!skip.includes('l')) B.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
        if (!skip.includes('t')) B.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[x0, -z1], [x1, -z1], [x1, -z0], [x0, -z0]]);
        return B;
      },
      // 圆柱（束柱）：贴图绕一圈铺 reps 遍
      drum(x, z, r, y0, y1, seg = 10, reps = 2) {
        const wrap = reps / su;
        for (let i = 0; i < seg; i++) {
          const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1), u0 = -i / seg * wrap, u1 = -(i + 1) / seg * wrap;
          B.quad([[x + c1 * r, y0, z + s1 * r], [x + c0 * r, y0, z + s0 * r], [x + c0 * r, y1, z + s0 * r], [x + c1 * r, y1, z + s1 * r]], [[c1, 0, s1], [c0, 0, s0], [c0, 0, s0], [c1, 0, s1]], [[u1, y0], [u0, y0], [u0, y1], [u1, y1]]);
        }
        return B;
      },
      // 山墙：底边 y0、尖顶 y1 的三棱柱（正面一个三角、两片斜顶）
      gable(x0, x1, y0, y1, z0, z1) {
        const mx = (x0 + x1) / 2;
        B.tri([[x0, y0, z1], [x1, y0, z1], [mx, y1, z1]], [0, 0, 1], [[x0, y0], [x1, y0], [mx, y1]]);
        return B.pitch(x0, x1, y0, y1, z0, z1);
      },
      // 两片斜顶：屋檐在 y0、屋脊在 y1（沿 z 走）。贴图的竖向顺着坡往上铺（瓦的圆头朝屋檐）
      pitch(x0, x1, y0, y1, z0, z1) {
        const mx = (x0 + x1) / 2, dx = mx - x0, dy = y1 - y0, l = Math.hypot(dx, dy);
        B.quad([[x0, y0, z0], [x0, y0, z1], [mx, y1, z1], [mx, y1, z0]], [-dy / l, dx / l, 0], [[z0, 0], [z1, 0], [z1, l], [z0, l]]);
        B.quad([[x1, y0, z1], [x1, y0, z0], [mx, y1, z0], [mx, y1, z1]], [dy / l, dx / l, 0], [[-z1, 0], [-z0, 0], [-z0, l], [-z1, l]]);
        return B;
      },
      // 四面的尖锥（小尖塔的顶）：底是边长 2r 的方，尖在 y1
      spire(x, z, r, y0, y1) {
        const h = y1 - y0, l = Math.hypot(h, r);
        for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) B.tri([[x + (dx - dz) * r, y0, z + (dz + dx) * r], [x + (dx + dz) * r, y0, z + (dz - dx) * r], [x, y1, z]], [dx * h / l, r / l, dz * h / l], [[-r, 0], [r, 0], [0, l]]);
        return B;
      },
      mesh(parent, cast = true) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(K, 3)); g.setIndex(I);
        const o = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, vertexColors: true })); o.castShadow = cast; o.receiveShadow = true; parent.add(o); return o;
      },
    };
    return B;
  }

  // ================= 小件：图集上的立牌 / 贴地片，按层合成几张网格 =================
  function Deck() { return { P: [], N: [], U: [], K: [], I: [] }; }
  function pushQuad(D, a, b, c, d, r, n, k, flip) {
    const i0 = D.P.length / 3, u0 = flip ? r.u1 : r.u0, u1 = flip ? r.u0 : r.u1;
    D.P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]); D.U.push(u0, r.vb, u1, r.vb, u1, r.vt, u0, r.vt);
    for (let i = 0; i < 4; i++) { D.N.push(n[0], n[1], n[2]); D.K.push(k[0], k[1], k[2]); }
    D.I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }
  // 放一件：(x, y, z) 是底边中点。s 缩放；ry 绕竖轴转（0 = 朝镜头）；tilt 往后仰；flat = 平铺在地上（图的上边朝后）。
  // 返回这件上每根烛芯的位置（给火苗用）
  function card(D, name, x, y, z, { s = 1, ry = 0, tilt = 0, flip = false, tint = WHITE, flat = false } = {}) {
    const a = spr(name), w = a.w / PPM * s, h = a.h / PPM * s, c = Math.cos(ry), sn = Math.sin(ry), rx = c * w / 2, rz = -sn * w / 2;
    let ux, uy, uz, n;
    if (flat) { ux = -sn * h; uy = 0; uz = -c * h; n = [0, 1, 0]; x -= ux / 2; z -= uz / 2; }      // 贴地的片以中心为准
    else { const st = Math.sin(tilt), ct = Math.cos(tilt); ux = -st * sn * h; uy = ct * h; uz = -st * c * h; n = [.6 * sn, .8, .6 * c]; }   // 法线朝上朝前：逆光也吃得到一点主光
    pushQuad(D, [x - rx, y, z - rz], [x + rx, y, z + rz], [x + rx + ux, y + uy, z + rz + uz], [x - rx + ux, y + uy, z - rz + uz], a, n, tint, flip);
    if (!a.tips) return [];
    return a.tips.map(([tx, ty]) => { const fu = ((flip ? a.w - tx : tx) / a.w - .5) * 2, fv = 1 - ty / a.h; return [x + rx * fu + ux * fv + sn * .012, y + uy * fv, z + rz * fu + uz * fv + c * .012]; });
  }
  function deckMesh(D, parent, cast) {
    if (!D.P.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(D.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(D.N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(D.U, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(D.K, 3)); g.setIndex(D.I);
    const o = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: ATLAS.tex, alphaTest: .5, side: THREE.DoubleSide, vertexColors: true })); o.castShadow = cast; o.receiveShadow = true; parent.add(o); return o;
  }

  // —— 会动的东西先登记在这几张表里，tick 里逐帧画 ——
  const FLAMES = [];   // 火苗：{ x, y, z, k: 哪种火, w, h, g: 所属城堡组, ph, hl: 灯晕大小, c: 灯晕颜色 }
  const POOLS = [];    // 蜡烛照在地上的光晕：{ x, y, z, r, g, ph, c }
  const WINS = [];     // 发光的彩窗：{ a: 图集格, x, y, z, w, h, g, i, gain, halo, c }
  const PATCH = [];    // 地上的色光 + 光柱：见 beamTo
  const HANG = [];     // 吊着的 / 挂着的：吊灯、香炉、钟绳、长旗、帷幔
  const WARM = [1, .62, .22], COLD = [.3, .85, 1];
  const FSIZE = { fa: [.19, .33], fs: [.13, .21], fc: [.19, .33], fb: [.36, .52] };
  // 在一件带烛芯的小件上点火。kind：fa 普通烛火 / fs 小烛火 / fc 冷火 / fb 大火；pool = 脚下光晕的大小（0 = 没有）
  function burn(D, name, x, y, z, o = {}, kind = 'fa', g = null, pool = 0, floorY = y) {
    const tips = card(D, name, x, y, z, o), s = o.s || 1, col = kind === 'fc' ? COLD : WARM;
    tips.forEach((p, i) => FLAMES.push({ x: p[0], y: p[1], z: p[2], k: kind, w: FSIZE[kind][0] * Math.max(.8, s), h: FSIZE[kind][1] * Math.max(.8, s), g, ph: FLAMES.length * 7 + i, hl: i % 3 ? 0 : (kind === 'fb' ? 1.5 : kind === 'fs' ? .6 : 1) * (low && i ? 0 : 1), c: col }));
    if (pool) POOLS.push({ x, y: floorY + .012, z: z + .1, r: pool, g, ph: POOLS.length * 13, c: col });
    return tips;
  }

  // ================= 棋盘：游戏那 20 块格子只换材质（一张整盘的嵌拼图切成 20 小张）=================
  { const bc = TX.board(grid).canvas(), cw = Math.round(LX * PPM), ch = Math.round(LZ * PPM);
    for (const t of tiles) { const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; cv.getContext('2d').drawImage(bc, -t.userData.r * cw, -t.userData.c * ch); t.material = new THREE.MeshLambertMaterial({ map: px(cv) }); t.material.color.setScalar(low ? 1.2 : SHORT ? 1.3 : 1.42); } }   // 环境光压暗以后格子自己提一档：比四周的台基和地面亮、清楚（高画质档还要过一道加反差的调色，多提一些）

  // ================= 中殿的实体 =================
  const M = {}; for (const k in T) M[k] = Mason(T[k]);
  const PALE = [.7, .7, .86], FLOOR = [.5, .47, .66];   // 大面石材都压着用：最亮的留给烛光、彩窗和棋子
  // 地面、台基（顶面压暗，格子缝里露出来的就是它）
  M.floor.tint(FLOOR).box(-17, 17, FY - .1, FY, WALLZ - .5, 9, 'fblr');
  M.slab.tint(PALE).box(-DX, DX, FY, 0, DZ0, DZ1, 't'); M.pave.tint([.86, .84, 1]).box(-DX, DX, -.02, 0, DZ0, DZ1, 'fblr');   // 台基顶面是斜铺的拼花砖，比棋盘格暗一档
  // 盘四周的马赛克镶边（瓷片保持方的：0.32 米宽的条，贴图每 1.28 米一个循环）
  { const W = .32, y = .012, k = .5 / W, strip = (x0, x1, z0, z1, along) => { const L = (along ? x1 - x0 : z1 - z0) * k;
      M.mosaic.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], along ? [[0, 0], [L, 0], [L, .5], [0, .5]] : [[0, 0], [0, .5], [L, .5], [L, 0]]); };
    strip(-HALF - .3, HALF + .3, BK - W, BK, true); strip(-HALF - .3, HALF + .3, FR, FR + W, true); strip(-HALF - .3, -HALF, BK, FR, false); strip(HALF, HALF + .3, BK, FR, false); }
  // 祭坛的两级台阶、祭坛、祭坛后的小台
  M.slab.tint(PALE).box(-3, 3, FY, 0, WALLZ, BK - 1.65).box(-2.45, 2.45, 0, .12, WALLZ, BK - 2).tint([.74, .74, .88]).box(-.86, .86, .12, .84, BK - 2.85, BK - 2.3).box(-.5, .5, .84, 1, BK - 2.85, BK - 2.68);
  // 红地毯：从盘前一路铺到祭坛脚下，过台阶时顺着台阶折
  { const w = .85, k = 2 / (w * 2); let v = 0;
    const run = (za, ya, zb, yb) => { const l = Math.hypot(za - zb, ya - yb) * k; M.carpet.quad([[-w, ya, za], [w, ya, za], [w, yb, zb], [-w, yb, zb]], za === zb ? [0, 0, 1] : [0, 1, 0], [[0, v], [2, v], [2, v + l], [0, v + l]]); v += l; };
    run(8, FY + .006, DZ1 + .006, FY + .006); run(DZ1 + .006, FY, DZ1 + .006, .008); run(DZ1, .008, FR + .32, .008);
    run(BK - .32, .008, DZ0, .008); run(DZ0 - .006, .008, DZ0 - .006, FY); run(DZ0, FY + .006, BK - 1.644, FY + .006); run(BK - 1.644, FY, BK - 1.644, .006); run(BK - 1.65, .006, BK - 1.994, .006); run(BK - 1.994, 0, BK - 1.994, .126); run(BK - 2, .126, BK - 2.3, .126); }
  // 后墙和两道侧墙（越高越暗）、墙脚的石裙
  M.wall.tint([.52, .48, .7]).dark(.22).box(-15, 15, FY, 6.4, WALLZ - .4, WALLZ, 'blrt').box(-(EDGE + 5.6), -(EDGE + 5.2), FY, 6.4, WALLZ, 6, 'blft').box(EDGE + 5.2, EDGE + 5.6, FY, 6.4, WALLZ, 6, 'brft');
  M.slab.tint([.5, .48, .66]).box(-15, 15, FY, .3, WALLZ, WALLZ + .07, 'b');
  // 束柱：石墩 + 柱身（越高越暗）。几根立在两侧，几根贴着后墙
  const PIERS = [[-(EDGE + 2.55), -1.55], [EDGE + 2.55, -1.55], [-(EDGE + 2.95), 1.35], [EDGE + 2.95, 1.35], [-(EDGE + .95), WALLZ + .2], [EDGE + 1.8, WALLZ + .2], [EDGE + 3.2, WALLZ + .2], [-3.8, WALLZ + .2], [3.8, WALLZ + .2]];
  M.pier.tint([.6, .57, .78]).dark(.2);
  for (const [x, z] of PIERS) { M.slab.tint([.62, .6, .78]).box(x - .4, x + .4, FY, .22, z - .4, z + .4).box(x - .34, x + .34, .22, .36, z - .34, z + .34); M.pier.drum(x, z, .29, .36, 6.4, 10, 2); }
  // 长椅：座板、靠背、两头的挡板。两侧各几排，朝着祭坛；有两张翻倒了
  function pew(x, z, len, rx = 0, ry = 0, y = FY, shade = 1) {
    const h = len / 2; M.wood.tint([shade * .8, shade * .76, shade * .84]).at(x, y, z, rx, ry, 0);
    M.wood.box(-h, h, .36, .43, -.2, .22).box(-h, h, .16, .94, .2, .27).box(-h - .06, -h, 0, 1.02, -.24, .3).box(h, h + .06, 0, 1.02, -.24, .3).box(-h, h, .94, .99, .17, .3);
    M.wood.at();
  }
  const PEWS = [];
  for (const sx of [-1, 1]) for (let r = 0; r < 5; r++) {
    const x = sx * (EDGE + 1.28), z = 2.75 - r * 1.08;
    if (sx > 0 && r === 2) { pew(x + .1, z + .2, 1.6, Math.PI / 2, .22, FY + .3, .9); continue; }        // 翻倒的一张（往前扑在地上）
    if (sx < 0 && r === 3) { pew(x - .15, z, 1.6, 0, .5, FY, .95); PEWS.push([x - .15, z]); continue; }   // 被撞歪的一张
    pew(x, z, 1.6, 0, 0, FY, .92 + rnd(r, sx + 3) * .16); PEWS.push([x, z]);
  }
  // 石棺（右后方）
  const SARC = [EDGE + 1.7, BK - 1.55];
  M.slab.tint([.62, .62, .78]).box(SARC[0] - .98, SARC[0] + .98, FY, FY + .62, SARC[1] - .4, SARC[1] + .4).tint(PALE).box(SARC[0] - 1.04, SARC[0] + 1.04, FY + .62, FY + .72, SARC[1] - .46, SARC[1] + .46);
  for (const k in M) M[k].mesh(scene, k !== 'floor' && k !== 'mosaic' && k !== 'carpet' && k !== 'wall' && k !== 'pave');

  // ================= 中殿的小件 =================
  const WC = Deck(), WF = Deck();                         // WC 立着的（投影），WF 贴地的（只接影子）
  const put = (n, x, y, z, o) => card(WC, n, x, y, z, o), lay = (n, x, y, z, o = {}) => card(WF, n, x, y, z, { ...o, flat: true });
  const fire = (n, x, y, z, o, kind, pool, fy) => burn(WC, n, x, y, z, o, kind, null, pool, fy);
  // —— 后墙：玫瑰窗、尖拱窗、壁龛石像 ——
  const addWin = (name, x, y, z, s, i, o = {}) => { const a = spr(name); WINS.push({ a, x, y, z, w: a.w / PPM * s, h: a.h / PPM * s, g: null, i, gain: LOOK.glass, halo: 1.5, c: [.6, .55, 1], ...o }); };
  { const a = spr('frameRose'), h = a.h / PPM * RS, gh = spr('glRose').h / PPM * RS;
    put('frameRose', 0, RY - h / 2, WALLZ + .02, { s: RS }); addWin('glRose', 0, RY - gh / 2, WALLZ + .04, RS, 0, { gain: LOOK.rose, halo: 2.2, c: [1, .55, .75], rose: true }); }
  const LANC = [[0, -2.12], [1, 2.12], [2, -(EDGE + 4.55)], [3, EDGE + 1.1], [4, EDGE + 2.5], [5, EDGE + 3.9]];
  const LCOL = [[.4, .6, 1], [1, .4, .5], [.75, .4, 1], [1, .75, .35], [.4, 1, .6], [1, .55, .9]];
  for (const [i, x] of LANC) { put('frameL', x, .38, WALLZ + .02, { s: .85 }); addWin('glL' + i, x, .38 + 3 / PPM * .85, WALLZ + .04, .85, i + 1, { c: LCOL[i] }); }
  for (const sx of [-1, 1]) { put('niche', sx * 3.1, .3, WALLZ + .02, { s: .85 }); put(sx < 0 ? 'angel' : 'knight', sx * 3.1, .36, WALLZ + .13, { s: sx < 0 ? .8 : .84, flip: sx > 0 }); }
  put('plaque', -(EDGE + .95), 1.6, WALLZ + .52); put('hymn', EDGE + 1.8, 1.5, WALLZ + .52); put('plaque', EDGE + 3.2, 1.7, WALLZ + .52, { flip: true });
  for (const x of [-1.5, 1.5]) fire('sconce', x, .45, WALLZ + .1, { flip: x > 0 }, 'fs');
  // —— 祭坛：祭坛布、金十字、烛、杯、花，两侧的大烛台 ——
  put('altarFront', 0, .12, BK - 2.288, { s: .82 }); put('cross', 0, 1, BK - 2.76, { s: .62 });
  fire('candles3', -.6, .84, BK - 2.52, { s: .9 }); fire('candles3', .6, .84, BK - 2.52, { s: .9, flip: true }); put('chalice', -.22, .84, BK - 2.42); lay('bookOpen', .22, .846, BK - 2.48, { s: .7 });
  put('vase0', -1.08, .12, BK - 2.22); put('vase1', 1.08, .12, BK - 2.22, { flip: true });
  for (const sx of [-1, 1]) { fire('candelabra', sx * 1.5, .12, BK - 2.42, {}, 'fa', 1.6); fire('candelabra', sx * 2.25, 0, BK - 1.86, { s: .9 }, 'fa', 1.5); }
  // 祭坛前的铁栏杆（中间给地毯留门）和栏杆脚下的跪凳
  for (const sx of [-1, 1]) { for (const x of [1.28, 2.08, 2.88]) put('railI', sx * x, 0, BK - 1.68, { s: .8 }); put('kneeler', sx * 1.75, FY, BK - 1.42); put(sx < 0 ? 'cushR' : 'cushT', sx * 2.5, FY, BK - 1.36, { flip: sx > 0 }); }
  // 台阶前的一排排蜡烛、蜡泪
  for (let i = 0; i < 4; i++) { const sx = i % 2 ? 1 : -1, x = sx * (HALF + .15 + (i >> 1) * .6); fire(i % 3 === 0 ? 'candles5' : 'candles3', x, FY, BK - 1.5 + rnd(i, 1) * .1, { flip: i % 2 > 0 }, 'fa', i % 3 === 0 ? 1.3 : 0); lay('waxpool', x + .22, FY + .004, BK - 1.38, { s: .8 }); }
  // 诵经台和摊开的大书、奉献箱、书
  put('lectern', -1.72, FY, BK - 1.16); put('chest', 2.9, FY, BK - 1.22); put('bookstack', -2.75, FY, BK - 1.12); put('vase1', 3.3, 0, BK - 1.9, { s: .9 });
  // —— 左后：管风琴；右后：告解亭、石棺 ——
  put('organ', -(EDGE + 2.72), FY, WALLZ + .56); fire('candelabra', -(EDGE + 1.02), FY, WALLZ + .9, {}, 'fa', 1.6); fire('rack', -(EDGE + 1.1), FY, BK - 1.25, {}, 'fs', 1.5); put('bookstack', -(EDGE + 2.3), FY, WALLZ + 1.05); put('kneeler', -(EDGE + 2.9), FY, WALLZ + 1.2);
  put('confessional', EDGE + 3.85, FY, BK - .95); put('sarcoSide', SARC[0], FY, SARC[1] + .412, { s: .98 }); put('effigy', SARC[0], FY + .72, SARC[1], { s: .96 }); fire('candles5', SARC[0] - 1.35, FY, SARC[1] + .35, {}, 'fa', 1.3); put('vase0', SARC[0] + 1.3, FY, SARC[1] + .3); lay('bouquet', SARC[0] + .2, FY + .005, SARC[1] + .8);
  // —— 柱子上的壁烛、柱脚的蜡烛 ——
  PIERS.slice(0, 4).forEach(([x, z], i) => { fire('sconce', x - .12, 1.42, z + .31, {}, 'fs'); fire('sconce', x + .12, 1.42, z + .31, { flip: true }, 'fs'); fire(i % 2 ? 'candles3' : 'candles5', x + (x < 0 ? .62 : -.62), FY, z + .3, { flip: x > 0 }, 'fa', 1.2); });
  // —— 长椅上、过道里的零碎 ——
  PEWS.forEach(([x, z], i) => { if (i % 3 === 0) put('bookstack', x + .4, FY + .43, z, { s: .8 }); if (i % 4 === 1) put(i % 8 === 1 ? 'cushR' : 'cushT', x - .35, FY + .43, z + .02, { s: .8 }); });
  put('bowl', -(EDGE + .55), FY, FR + .95); put('chest', EDGE + .6, FY, FR + .8, { flip: true }); put('lectern', EDGE + 2.6, FY, BK - .1, { flip: true, s: .9 });
  // —— 台基四角：蜡烛簇、跪凳、花 ——
  for (const sx of [-1, 1]) { fire('candles5', sx * (HALF + 1.95), 0, FR + .55, { flip: sx > 0 }, 'fa', 1.4); fire('candles3', sx * (HALF + .75), 0, FR + .62, { flip: sx < 0 }); put('kneeler', sx * 1.55, 0, FR + .62, { s: .9 }); fire('candles3', sx * (HALF + 2.3), 0, BK - .5, {}, 'fa', 1.1); }
  lay('bouquet', .35, .012, FR + .6); lay('bouquet', -.3, .012, BK - .62, { ry: 2.4 });
  // —— 盘前、盘后的台基：两座小龛门前各一朵圆拼花，沿前后沿一排嵌星 / 嵌四叶的方砖，蜡烛脚下是蜡泪 ——
  const TILE = [.86, .84, 1];
  for (const sx of [-1, 1]) {
    lay('rosette', sx * (HALF + 1.3), .012, FR + .45, { s: .5, tint: TILE });
    [[.95, 0], [2.42, 1], [HALF + 2.35, 0]].forEach(([x, k]) => lay('inlay' + k, sx * x, .012, FR + .56, { s: .8, tint: TILE }));
    [[1.3, 1], [2.25, 0], [HALF + 1.3, 1]].forEach(([x, k]) => lay('inlay' + k, sx * x, .012, BK - .6, { s: .7, tint: TILE }));
    lay('waxpool', sx * (HALF + 1.95) + .3, .013, FR + .66, { s: .9 }); lay('waxpool', sx * (HALF + .75) - .22, .013, FR + .7, { s: .7, ry: 1 }); lay('waxpool', sx * (HALF + 2.3) + .2, .013, BK - .42, { s: .8, ry: 2 });
    put(sx < 0 ? 'cushT' : 'cushR', sx * 1.55, .2, FR + .64, { s: .8 });                                       // 跪凳上的垫子
    // 台基两条窄边（小龛外侧）：一溜小蜡烛和蜡泪
    for (let j = 0; j < 3; j++) { const z = -1.5 + j * 1.5; fire('candles3', sx * (DX - .2), 0, z, { s: .8, flip: (j + (sx > 0)) % 2 > 0 }, 'fs', j === 1 ? .9 : 0); lay('waxpool', sx * (DX - .2), .013, z + .2, { s: .7, ry: j * 2 }); }
    // 盘前的中殿地面：一朵大圆拼花、几块方砖
    lay('rosette', sx * (EDGE + .75), FY + .004, DZ1 + 1.25, { s: 1.15, tint: TILE }); lay('inlay0', sx * 3.35, FY + .004, DZ1 + .55, { tint: TILE }); lay('inlay1', sx * 1.75, FY + .004, DZ1 + .6, { tint: TILE }); lay('inlay1', sx * (EDGE + 2.4), FY + .004, DZ1 + .5, { tint: TILE });
  }
  // —— 长椅区：靠背上搭着队伍色的垂幔、椅头的小蜡烛、外侧过道的跪凳和地砖拼花 ——
  PEWS.forEach(([x, z], i) => {
    const sx = x < 0 ? -1 : 1;
    if (i % 2 === 0) put(sx < 0 ? 'valT' : 'valR', x, FY + .58, z + .275, { s: .8 });                          // 垂幔搭在靠背朝镜头的一面
    if (i % 2) fire('sconce', x - sx * .83, FY + 1.0, z + .04, { flip: sx > 0, s: .9 }, 'fs');                  // 椅头挡板顶上的小蜡烛
    if (i % 3 === 1) { put('kneeler', x + sx * 1.3, FY, z - .1, { s: .9, flip: sx > 0 }); put(i % 2 ? 'cushR' : 'cushT', x + sx * 1.3, FY + .22, z - .08, { s: .8 }); }
    lay('inlay' + i % 2, x + sx * 1.25, FY + .004, z + .5, { tint: TILE, s: .9 });
  });
  for (const sx of [-1, 1]) { lay('rosette', sx * (EDGE + 2.5), FY + .004, -.15, { s: .95, tint: TILE }); lay('waxpool', sx * (EDGE + 2.3), FY + .005, -1.1, {}); lay('inlay0', sx * (EDGE + 2.2), FY + .004, BK - .2, { tint: TILE }); }
  // —— 墓碑地砖 ——
  [[-2.35, BK - 1.22, 1.57, 0], [2.2, BK - 1.2, 1.57, 1], [-(EDGE + .22), .6, 0, 2], [EDGE + .22, -1.1, 0, 0], [-(EDGE + 1.2), BK - .3, 1.57, 1], [EDGE + 2.9, .4, .1, 2], [-2.3, FR + 1.7, 1.57, 2], [2.4, FR + 1.75, 1.57, 0], [-(EDGE + 2.2), 3.3, 0, 1]].forEach(([x, z, ry, k]) => lay('tomb' + k, x, FY + .004, z, { ry }));
  // —— 散落的书页和花瓣（地毯上的最多）——
  for (let i = 0; i < 76; i++) {
    const zone = i % 4, r1 = rnd(i, 11), r2 = rnd(i, 12), n = i % 3 === 0 ? 'pages' + (i % 3 + (i >> 2) % 3) % 3 : 'petals' + i % 3;
    const [x, y, z] = zone === 0 ? [(r1 - .5) * 1.5, FY + .01, DZ0 - .1 - r2 * .65] : zone === 1 ? [(r1 - .5) * (i < 44 ? 4.6 : DX * 2 - .6), .014, FR + .38 + r2 * .42] : zone === 2 ? [(r1 < .5 ? -1 : 1) * (EDGE + .1 + r2 * 2.6), FY + .008, -2.6 + rnd(i, 13) * 5.6] : [(r1 - .5) * (HALF * 2 + 3), .014, BK - .38 - r2 * .4];
    lay(n, x, y, z, { ry: rnd(i, 14) * TAU });
  }
  deckMesh(WC, scene, true); deckMesh(WF, scene, false);

  // ================= 吊着的和挂着的（每帧画，会摆）=================
  // 摆锤：支点 (x, y, z)，link 是吊它的链子 / 绳子，len 是链长，下面挂着 name 这件；amp 摆幅（弧度）、sp 快慢
  const pend = (name, x, y, z, len, amp, sp, o = {}) => { const h = { mode: 1, a: spr(name), link: spr(o.link || 'chain'), x, y, z, len, amp, sp, ph: HANG.length * 2.1, s: o.s || 1, g: null, kind: o.kind || null, smoke: !!o.smoke }; HANG.push(h); return h; };
  // 布：上沿固定在 (x, y, z)，下沿左右荡
  const cloth = (name, x, y, z, o = {}) => HANG.push({ mode: 0, a: spr(name), x, y, z, amp: o.amp ?? .05, sp: o.sp ?? 1.1, ph: HANG.length * 1.7, s: o.s || 1, g: o.g || null, ry: o.ry || 0 });
  for (const sx of [-1, 1]) pend('chandelier', sx * (EDGE + 1.35), 5.6, .25, 2.25, .035, .8, { kind: 'fa' });
  if (!SHORT) pend('chandelier', 0, 5.4, BK - 1.15, 1.9, .028, .7, { kind: 'fa', s: .8 });
  const CENSER = pend('censer', 1.62, 4.4, BK - 1.05, 2.85, .2, 1.5, { smoke: true });
  pend('sally', EDGE + 2.05, 5.5, -2.1, 4.1, .03, .9, { link: 'rope' });
  PIERS.slice(0, 4).forEach(([x, z], i) => cloth(['banT', 'banR', 'banG', 'banG'][i], x, 3.45, z + .33, { amp: .04 }));
  cloth('banG', -3.8, 3.3, WALLZ + .52, { amp: .03 }); cloth('banG', 3.8, 3.3, WALLZ + .52, { amp: .03 }); cloth('banT', -(EDGE + .95), 3.5, WALLZ + .52, { amp: .03, s: .9 }); cloth('banR', EDGE + 1.8, 3.6, WALLZ + .52, { amp: .03, s: .9 }); cloth('banG', EDGE + 3.2, 3.9, WALLZ + .52, { amp: .03 });

  // ================= 两座小龛（搭在游戏给的两个组里，跟着抖、跟着沉）=================
  // 两座都是盖满四条路的整栋小建筑，正脸朝镜头，主体压在靠前的一半（血量牌在它们的顶上方；对面那座的主体也就落在右上角记录面板的下面）。
  // 本方「蓝宝石礼拜龛」：浅色大理石的小礼拜堂——三级台阶、尖山墙正脸上一扇蓝宝石尖拱窗、青蓝鱼鳞瓦的坡顶一路铺到后头、屋脊上一座小尖塔、四角扶壁顶着小尖锥。
  // 对面「红宝石祭火龛」：深色条石的门楼——平顶带城垛和铁刺、两座方角楼、正脸一扇红宝石圆窗、门前两只大火盆和一架还愿烛，后面拖一截矮殿。
  // 所有东西都加在 g 里；逐帧画的（彩窗、火苗、旗）登记时带上 g，画的时候加上组的位移。
  function shrine(i) {
    const g = castles[i], s = i ? 1 : -1, own = !i, zb = -DEPTH / 2 + .05, zf = DEPTH / 2 - .05, zF = zf - .6;   // zF：正脸那道墙
    const B = Mason(own ? T.slab : T.wall), R = Mason(own ? TROOF : T.pave), CC = Deck(), CF = Deck();
    const bx = (u0, u1, y0, y1, z0, z1) => B.box(s > 0 ? u0 : -u1, s > 0 ? u1 : -u0, y0, y1, z0, z1);          // u 以「朝外」为正（朝棋盘是负）
    const c = (n, x, y, z, o) => card(CC, n, x, y, z, o);
    const f = (n, x, y, z, o, kind, pool) => { const n0 = FLAMES.length, p0 = POOLS.length; burn(CC, n, x, y, z, o, kind, g, pool, .36); for (let j = n0; j < FLAMES.length; j++) FLAMES[j].x += X0; for (let j = p0; j < POOLS.length; j++) POOLS[j].x += X0; };
    const inward = own ? Math.PI / 2 : -Math.PI / 2, IN = -s;     // 贴在内侧墙上的东西朝着棋盘；IN = 朝棋盘的方向
    const X0 = SHORT ? IN * .1 : 0, H = new THREE.Group(); H.position.x = X0; g.add(H);   // 手机横屏时小龛贴着画面的左右边：整栋往棋盘这边挪一点
    const STONE = own ? [.84, .88, 1.08] : [.9, .6, .7], STEP = own ? [.66, .7, .9] : [.66, .46, .56];
    // 三级台阶：一圈圈往里收，最上一级是门廊的地面（y = .36）
    B.tint(STEP).box(-1.04, 1.04, 0, .12, zb, zf).box(-.98, .98, .12, .24, zb + .08, zf - .1).box(-.92, .92, .24, .36, zb + .16, zf - .2);
    if (own) {
      // —— 殿身：两道侧墙、尖山墙的正脸；手机横屏看不到高处的后半截，殿身只做前半 ——
      const zN = SHORT ? -.2 : zb + .4, WN = .78, E = .97, yE = 1.4, yR = 2.36, wt = yR - WN * (yR - yE) / E;   // 殿身后墙、半宽；屋檐半宽、檐高、脊高；墙顶
      B.tint(STONE).box(-WN, WN, .36, wt, zN, zF, 't').tri([[-WN, wt, zF], [WN, wt, zF], [0, yR, zF]], [0, 0, 1], [[-WN, wt], [WN, wt], [0, yR]]);
      // 鱼鳞瓦的坡顶；正面沿着山墙压两条石边，屋脊一条石梁
      R.tint([.9, .95, 1.1]).pitch(-E, E, yE, yR, zN - .1, zF + .03);
      const z1 = zF + .034; B.tint([.98, 1.02, 1.2]);
      B.quad([[-E, yE - .08, z1], [0, yR - .08, z1], [0, yR + .04, z1], [-E, yE + .04, z1]], [0, 0, 1], [[-E, 0], [0, 0], [0, .12], [-E, .12]]);
      B.quad([[0, yR - .08, z1], [E, yE - .08, z1], [E, yE + .04, z1], [0, yR + .04, z1]], [0, 0, 1], [[0, 0], [E, 0], [E, .12], [0, .12]]);
      B.box(-.04, .04, yR - .03, yR + .05, zN - .1, z1);
      // 正脸两角的扶壁，顶上各一座小尖锥和银尖饰；朝棋盘那道侧墙上一排小扶壁，中间挂队旗
      for (const k of [-1, 1]) { B.tint(STONE).box(k * .8 - .12, k * .8 + .12, .36, 1.6, zF, zF + .16); B.tint([.98, 1.02, 1.2]).box(k * .8 - .15, k * .8 + .15, 1.6, 1.66, zF - .03, zF + .19); R.spire(k * .8, zF + .08, .14, 1.66, 2.08); c('finial', k * .8, 2.06, zF + .08, { s: .42 }); }
      const nb = SHORT ? 2 : 3; B.tint(STONE);
      for (let j = 0; j < nb; j++) { const z = zN + (zF - zN) * (j + .55) / nb; bx(-.9, -WN, .36, 1.14, z - .09, z + .09); if (j) c('banT', IN * (WN + .016), .52, z - (zF - zN) / nb / 2, { s: .4, ry: inward }); }
      // 屋脊上的小尖塔（钟塔）：方塔身、瓦尖顶、银尖饰
      const zs = SHORT ? .8 : -.3, st = SHORT ? 2.8 : 3.05;
      B.tint([1.25, 1.35, 1.7]).box(-.17, .17, yR - .2, st - .4, zs - .17, zs + .17).box(-.21, .21, st - .44, st - .38, zs - .21, zs + .21); R.tint([1.3, 1.4, 1.6]).spire(0, zs, .24, st - .38, st); if (!SHORT) c('finial', 0, st - .02, zs, { s: .4 });
      // 蓝宝石尖拱窗：窗框是立牌，玻璃是每帧画的自发光片
      const gs = .94, gy = .68, gl = spr('glOwn');
      c('frameT', 0, gy, zF + .012, { s: gs });
      WINS.push({ a: gl, x: X0, y: gy + 4 / PPM * gs, z: zF + .03, w: gl.w / PPM * gs, h: gl.h / PPM * gs, g, i: 8, gain: LOOK.glass, halo: 1.1, c: [.25, .6, 1] });
      // 门廊：小台子上的银圣物匣、两盏银灯（冷火）、台阶上的盾徽、跪垫和摊开的经书；扶壁正面各垂一面队旗（会荡）
      B.tint(STEP).box(-.22, .22, .36, .5, zF + .05, zF + .29); c('reliquary', 0, .5, zF + .17, { s: .5 });
      for (const k of [-1, 1]) { f('lampS', k * .7, .36, zf - .32, { s: .66 }, 'fc', 1); cloth('banT', k * .8 + X0, 1.54, zF + .17, { amp: .02, sp: .9, s: .4, g }); }
      c('shieldT', 0, .24, zf - .195, { s: .45 }); c('cushT', IN * .38, .36, zf - .27, { s: .7 }); card(CF, 'bookOpen', IN * -.36, .366, zf - .3, { flat: true, ry: .4, s: .7 });
    } else {
      // —— 门楼（前半）和后面的矮殿：条石墙、深色拼砖的平顶 ——
      const zG = zF - 1.5, top = 2, hall = SHORT ? 1.05 : 1.25, DARK = [.62, .44, .56], tw = top + .42;   // 门楼后墙、楼顶；矮殿顶；角楼顶
      B.tint(STONE).box(-.86, .86, .36, top, zG, zF, 't').tint(DARK).box(-.72, .72, .36, hall, zb + .22, zG, 't');
      R.tint([.95, .4, .46]).box(-.86, .86, top - .02, top, zG, zF, 'fblr').tint([.4, .28, .36]).box(-.72, .72, hall - .02, hall, zb + .22, zG, 'fblr');
      // 城垛：门楼正面三个、两侧各三个，矮殿后沿三个；正面城垛后头一排镀金尖的铁刺
      B.tint(STONE); for (const x of [-.34, 0, .34]) B.box(x - .1, x + .1, top, top + .2, zF - .14, zF);
      for (const k of [-1, 1]) for (let j = 0; j < 3; j++) { const z = zG + .16 + j * .4; B.box(k > 0 ? .72 : -.86, k > 0 ? .86 : -.72, top, top + .2, z - .1, z + .1); }
      B.tint(DARK); for (const x of [-.46, 0, .46]) B.box(x - .12, x + .12, hall, hall + .2, zb + .22, zb + .36);
      c('spikes', 0, top, zF - .2, { s: .5 });
      // 两座方角楼：比门楼高一截，顶上四个小垛；正面各垂一面队旗（会荡）
      for (const k of [-1, 1]) {
        const x = k * .8; B.tint(STONE).box(x - .2, x + .2, .36, tw, zF - .3, zF + .12).box(x - .23, x + .23, tw - .28, tw - .2, zF - .33, zF + .15);
        for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.box(x + ax * .14 - .06, x + ax * .14 + .06, tw, tw + .12, zF - .09 + az * .15 - .06, zF - .09 + az * .15 + .06);
        cloth('banR', x + X0, tw - .3, zF + .13, { amp: .02, sp: .9, s: .46, g });
      }
      // 朝棋盘那道侧墙：两面队旗
      for (const z of [zG + .45, zG + 1.0]) c('banR', IN * .876, .7, z, { s: .42, ry: inward });
      // 红宝石圆窗
      const gs = .82, gy = .84, fr = spr('frameR'), gl = spr('glFoe');
      c('frameR', 0, gy, zF + .012, { s: gs });
      WINS.push({ a: gl, x: X0, y: gy + (fr.h - gl.h) / 2 / PPM * gs, z: zF + .03, w: gl.w / PPM * gs, h: gl.h / PPM * gs, g, i: 9, gain: LOOK.glass, halo: 1.1, c: [1, .25, .3] });
      // 门廊：两只大火盆、窗下一架还愿烛、台阶上的红毯和盾徽
      for (const k of [-1, 1]) f('brazier', k * .62, .36, zf - .34, { s: .95 }, 'fb', 1.5);
      f('rack', 0, .36, zF + .13, { s: .44 }, 'fs', 1.1);
      card(CF, 'frontR', 0, .366, zf - .34, { flat: true, s: .56 }); c('shieldR', 0, .24, zf - .195, { s: .45 });
    }
    B.mesh(H); R.mesh(H); deckMesh(CC, H, true); deckMesh(CF, H, false);
    // 门廊里的一盏灯：本方青、对面橙，把背光的正脸照出来（手机低画质档省掉）
    if (!(low && SHORT)) { const pl = new THREE.PointLight(own ? '#58d8ff' : '#ff6a30', LOOK.lamp * (own ? .8 : 1), 5, 1.5); pl.position.set(X0, 1.15, zf - .05); g.add(pl); LAMPS.push([pl, pl.intensity, 20 + i * 7]); }
  }
  const LAMPS = [];                                       // 点光：[灯, 基准亮度, 抖动的相位]
  shrine(0); shrine(1);

  // ================= 光 =================
  scene.background = new THREE.Color(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 20, 40);
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1] * (low ? .62 : 1);                // 低画质档没有调色和暗角：环境光再收一点，免得比高画质档亮一截
  sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1];
  { const l = Math.hypot(...SUN_FROM) / 30; sun.position.set(SUN_FROM[0] / l, SUN_FROM[1] / l, SUN_FROM[2] / l); }
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03;
  { const fl = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1] * (low ? .62 : 1)); fl.position.set(2, 5, 10); scene.add(fl); }   // 正面的冷补光：逆光里小件的正面不至于死黑
  // 暖色点光：祭坛、两盏吊灯、前排的蜡烛（低画质档只留祭坛那盏）
  for (const [x, y, z, k] of low ? [[0, 1.5, BK - 1.9, 1]] : [[0, 1.5, BK - 1.9, 1], [-(EDGE + 1.3), 2.1, .3, .8], [EDGE + 1.3, 2.1, .3, .8], [0, 1, FR + 1.1, .55]]) {
    const pl = new THREE.PointLight('#ffa040', LOOK.lamp * k, 6.5, 1.5); pl.position.set(x, y, z); scene.add(pl); LAMPS.push([pl, pl.intensity, LAMPS.length * 5]);
  }

  // —— 地上的色光和光柱 ——
  // 一块色光：落在 (x, z)、宽 w 长 l、朝向 ang；tex 是哪扇窗抹虚的图；top 是光柱的上头（null = 只有光斑没有光柱）；hw 是光柱上头的半宽
  // top：光柱的上头（null = 只有光斑没有光柱）；hw：光柱上头的半宽
  const beamTo = (tex, x, y, z, w, l, ang, col, top, hw = .4, k = 1) => PATCH.push({ a: LT[tex], x, y, z, w, l, ang, col, top, hw, k, i: PATCH.length });
  // 后墙的窗照下来的：玫瑰窗的落在祭坛前的地毯上，尖拱窗的落在两边（太阳偏左，光斑都往右偏一点）
  beamTo('gRose', .3, .02, BK - 1.35, 2.6, 1.9, 0, [1, .8, .9], [0, RY + .5, WALLZ + .1], 1, .42);
  beamTo('gL0', -1.9, .02, BK - .85, .9, 1.6, -.12, LCOL[0], [-2.12, 2.6, WALLZ + .1]); beamTo('gL1', 2.45, .02, BK - .85, .9, 1.6, .12, LCOL[1], [2.12, 2.6, WALLZ + .1]);
  beamTo('gL3', EDGE + 1.35, FY + .014, BK - .55, 1, 1.9, .1, LCOL[3], [EDGE + 1.1, 2.6, WALLZ + .1]); beamTo('gL4', EDGE + 2.9, FY + .014, BK - .9, 1, 1.9, .2, LCOL[4], [EDGE + 2.5, 2.6, WALLZ + .1]);
  beamTo('gL2', -(EDGE + 1.5), FY + .014, BK - .5, 1, 1.9, -.25, LCOL[2], [-(EDGE + 3.4), 3.6, WALLZ + .4], .5);
  // 两侧（画外）的尖拱窗照进来的：斜着落在长椅那一带
  for (const sx of [-1, 1]) {
    beamTo(sx < 0 ? 'gL5' : 'gL2', sx * (EDGE + 1.25), FY + .014, .95, 1.15, 2.3, sx * -1.15, sx < 0 ? LCOL[5] : LCOL[2], [sx * (EDGE + 3.9), 3.6, -.4], .5, .62);
    beamTo(sx < 0 ? 'gL3' : 'gL0', sx * (EDGE + 1.7), FY + .014, -1.35, 1.1, 2.2, sx * -1.0, sx < 0 ? LCOL[3] : LCOL[0], [sx * (EDGE + 4.3), 3.6, -2.7], .5, .62);
    beamTo(sx < 0 ? 'gL1' : 'gL5', sx * (EDGE + .9), FY + .014, 2.7, 1, 2, sx * -1.2, sx < 0 ? LCOL[1] : LCOL[5], [sx * (EDGE + 3.5), 3.6, 1.4], .45, .55);
    beamTo(sx < 0 ? 'gL4' : 'gL1', sx * 2.05, .02, FR + .6, .8, 1.1, sx * -.5, sx < 0 ? LCOL[4] : LCOL[1], null, 0, .7);     // 盘前两角：只有光斑
    beamTo(sx < 0 ? 'gOwn' : 'gFoe', sx * (HALF - .35), .075, BK + .5, 1, 1.1, sx * .3, sx < 0 ? LCOL[0] : LCOL[1], null, 0, .22);   // 盘面后两角：很淡的一抹
  }
  // 两座小龛的彩窗落在门前台基上的光：本方一片蓝的尖拱、对面一片红的圆
  beamTo('gOwn', -(HALF + 1.3), .022, FR + .45, .8, .86, 0, [.3, .6, 1], null, 0, .7); beamTo('gFoe', HALF + 1.3, .022, FR + .45, .86, .86, 0, [1, .3, .35], null, 0, .7);
  // 盘前的中殿地面：两块斜着的色光，落在大圆拼花上
  for (const sx of [-1, 1]) beamTo(sx < 0 ? 'gL2' : 'gL3', sx * (EDGE + .6), FY + .014, DZ1 + 1.15, 1, 1.9, sx * -.9, sx < 0 ? LCOL[2] : LCOL[3], null, 0, .7);
  // 漏光板：一张只投影不显色的板挡在太阳和场地之间。亮的地方：棋盘和两座小龛上方一整块、祭坛一带、每块色光落的地方；其余都在拱顶的暗影里
  { const N = low ? 256 : 512, SIZE = 44, GY = 10, cv = document.createElement('canvas'); cv.width = cv.height = N; const g2 = cv.getContext('2d'), im = g2.createImageData(N, N);
    const pool = S.any(S.rect(-(HALF + 2.9), BK - 1.2, (HALF + 2.9) * 2, DEPTH + 2.3, 1.1), S.rect(-2.8, WALLZ - .6, 5.6, 3.4, .6));
    for (let j = 0, o = 0; j < N; j++) for (let i = 0; i < N; i++, o += 4) {
      const x = ((i + .5) / N - .5) * SIZE, z = ((j + .5) / N - .5) * SIZE; let lit = pool(x, z) < 0;
      if (!lit) for (const p of PATCH) { const c = Math.cos(p.ang), sn = Math.sin(p.ang), dx = x - p.x, dz = z - p.z, lx = dx * c - dz * sn, ly = dx * sn + dz * c; if (Math.abs(lx) < p.w * .42 && Math.abs(ly) < p.l * .45 && Math.abs(lx) > .035) { lit = true; break; } }
      im.data[o] = im.data[o + 1] = im.data[o + 2] = 255; im.data[o + 3] = lit ? 0 : 255;
    }
    g2.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(cv); t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    const gobo = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
    gobo.position.set(SUN_FROM[0] / SUN_FROM[1] * GY, GY, SUN_FROM[2] / SUN_FROM[1] * GY); gobo.castShadow = true; gobo.frustumCulled = false; scene.add(gobo); }

  // ================= 后期（只有高画质档有）=================
  if (post.bloom) { post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2]; }
  for (const p of [post.tiltH, post.tiltV]) if (p) { const tl = SHORT ? LOOK.tiltM : LOOK.tilt; p.uniforms.focus.value = tl.focus; p.uniforms.band.value = tl.band; p.uniforms.amt.value = tl.amt; }
  if (post.grade) { const u = post.grade.uniforms, gr = LOOK.grade; u.sat.value = gr.sat * (SHORT ? .88 : 1); u.con.value = gr.con; u.knee.value = gr.knee; u.gain.value.setRGB(...gr.gain); u.lift.value.setRGB(...gr.lift); u.edge.value.setRGB(...gr.edge); post.grade.enabled = true; }

  // ================= 每帧重写的几张网格 =================
  // 预留 n 个四边形的缓冲，每帧从头写：begin → put… → end。不在帧里新建任何对象
  function Live(n, mat, { lit = false, cast = false, order = 0 } = {}) {
    const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), col = new Float32Array(n * 12), nor = lit ? new Float32Array(n * 12) : null, idx = new Uint16Array(n * 6), g = new THREE.BufferGeometry();
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    const aP = new THREE.BufferAttribute(pos, 3), aU = new THREE.BufferAttribute(uv, 2), aC = new THREE.BufferAttribute(col, 3); for (const a of [aP, aU, aC]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', aP); g.setAttribute('uv', aU); g.setAttribute('color', aC); g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (lit) { for (let i = 0; i < n * 4; i++) { nor[i * 3 + 1] = .8; nor[i * 3 + 2] = .6; } g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); }
    const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = order; mesh.castShadow = cast; mesh.receiveShadow = lit; scene.add(mesh);
    let k = 0;
    return {
      begin() { k = 0; },
      // 四个角依次是：左下、右下、右上、左上；r 是图集格；(cr, cg, cb) 是颜色倍数
      put(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, r, cr, cg, cb, flip) {
        if (k >= n) return; const o = k * 12, q = k * 8, u0 = flip ? r.u1 : r.u0, u1 = flip ? r.u0 : r.u1;
        pos[o] = x0; pos[o + 1] = y0; pos[o + 2] = z0; pos[o + 3] = x1; pos[o + 4] = y1; pos[o + 5] = z1; pos[o + 6] = x2; pos[o + 7] = y2; pos[o + 8] = z2; pos[o + 9] = x3; pos[o + 10] = y3; pos[o + 11] = z3;
        uv[q] = u0; uv[q + 1] = r.vb; uv[q + 2] = u1; uv[q + 3] = r.vb; uv[q + 4] = u1; uv[q + 5] = r.vt; uv[q + 6] = u0; uv[q + 7] = r.vt;
        for (let i = 0; i < 12; i += 3) { col[o + i] = cr; col[o + i + 1] = cg; col[o + i + 2] = cb; }
        k++;
      },
      end() { g.setDrawRange(0, k * 6); aP.needsUpdate = aU.needsUpdate = aC.needsUpdate = true; },
    };
  }
  const NM = low ? 40 : 90, NP = low ? 9 : 18;            // 浮尘、飘落的花瓣和书页
  const LG = Live(FLAMES.length + WINS.length + 60, new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide, fog: false }));                          // 自发光：火苗、彩窗
  const LC = Live(HANG.length * 3 + 8, new THREE.MeshLambertMaterial({ map: ATLAS.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide }), { lit: true, cast: true });                      // 吃光的：吊灯、香炉、旗、帷幔
  const LP = Live(NP + 16, new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide }));                                                              // 飘的：花瓣、书页、烟、鸽子
  const LS = Live(FLAMES.length + POOLS.length + WINS.length + PATCH.length * 2 + NM + 72, new THREE.MeshBasicMaterial({ map: LIGHTS.tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), { order: 2 });   // 加色的光
  const LF = Live(16, new THREE.MeshBasicMaterial({ map: ATLAS.tex, alphaTest: .5, vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false }), { order: 8 });   // 贴镜头的前景剪影
  // 几种常用的摆法
  const up = (L, r, x, y, z, w, h, cr, cg, cb, flip) => L.put(x - w / 2, y, z, x + w / 2, y, z, x + w / 2, y + h, z, x - w / 2, y + h, z, r, cr, cg, cb, flip);          // 立着，(x, y) 是底边中点
  const mid = (L, r, x, y, z, w, h, cr, cg, cb) => L.put(x - w / 2, y - h / 2, z, x + w / 2, y - h / 2, z, x + w / 2, y + h / 2, z, x - w / 2, y + h / 2, z, r, cr, cg, cb);   // 立着，(x, y) 是中心
  const flat = (L, r, x, y, z, w, l, ang, cr, cg, cb) => { const c = Math.cos(ang) / 2, s = Math.sin(ang) / 2, rx = c * w, rz = -s * w, fx = -s * l, fz = -c * l; L.put(x - rx - fx, y, z - rz - fz, x + rx - fx, y, z + rz - fz, x + rx + fx, y, z + rz + fz, x - rx + fx, y, z - rz + fz, r, cr, cg, cb); };   // 平铺
  const V = new THREE.Vector3(), Q = new Float32Array(12), TMP = { u0: 0, u1: 0, vt: 0, vb: 0 };
  const ndc = (nx, ny, o) => { V.set(nx, ny, .5).unproject(camera); Q[o] = V.x; Q[o + 1] = V.y; Q[o + 2] = V.z; };
  // 按画面坐标（-1..1）摆一张贴镜头的片：左下角 (x0, y0)、右上角 (x1, y1)
  const screen = (L, r, x0, y0, x1, y1, cr, cg, cb, flip) => { ndc(x0, y0, 0); ndc(x1, y0, 3); ndc(x1, y1, 6); ndc(x0, y1, 9); L.put(Q[0], Q[1], Q[2], Q[3], Q[4], Q[5], Q[6], Q[7], Q[8], Q[9], Q[10], Q[11], r, cr, cg, cb, flip); };
  const FRAMES = { fa: [0, 1, 2, 3].map(i => spr('fa' + i)), fs: [0, 1, 2, 3].map(i => spr('fs' + i)), fc: [0, 1, 2, 3].map(i => spr('fc' + i)), fb: [0, 1, 2, 3].map(i => spr('fb' + i)) };
  const SMOKE = [0, 1, 2].map(i => spr('smoke' + i)), PETF = [0, 1, 2, 3].map(i => spr('petF' + i)), PAGEF = [spr('pageF0'), spr('pageF1')], DOVE = [spr('dove0'), spr('dove1')];
  const HALO = LT.halo, DOT = LT.dot, BEAM = LT.beam, FGC = spr('fgCandle'), FGP = spr('fgPew'), FGR = spr('fgRail'), FGA = spr('fgArch');
  const SHAFTS = PATCH.filter(p => p.top);
  const cloudOf = (i, t) => calm ? 1 : .8 + .17 * Math.sin(t * .21 + i * 1.9) + .07 * Math.sin(t * .47 + i * .7);   // 云遮过太阳：每扇窗各有各的慢起伏
  const FL = G(LOOK.flame), FG = 1.7;                     // FG：前景剪影提一点亮，暗里还看得出木纹和铁花
  let last = 0;

  function tick(t) {
    last = t; const beat = Math.floor(t * 8), cam = camera.position;
    { const d = Math.hypot(cam.x, cam.y - .95, cam.z + .1); scene.fog.near = d + 1.5; scene.fog.far = d + 17; }   // 雾跟着镜头距离走：棋盘不沾雾，后墙罩一层淡紫
    LG.begin(); LC.begin(); LP.begin(); LS.begin(); LF.begin();
    if (!calm) sun.intensity = LOOK.sun[1] * (.93 + .07 * Math.sin(t * .21));
    for (const [pl, base, ph] of LAMPS) pl.intensity = calm ? base : base * (.86 + .28 * hash(beat, ph, 3));           // 烛光一拍一跳

    // —— 彩窗：亮度慢慢起伏；玫瑰窗另有一层呼吸似的脉动。每扇窗前罩一团雾光 ——
    for (const w of WINS) {
      const ox = w.g ? w.g.position.x : 0, oy = w.g ? w.g.position.y : 0, pulse = w.rose && !calm ? 1 + .09 * Math.sin(t * 1.3) : 1, k = G(w.gain * (.86 + .14 * cloudOf(w.i, t)) * pulse), hz = LOOK.haze * cloudOf(w.i, t) * pulse;
      up(LG, w.a, w.x + ox, w.y + oy, w.z, w.w, w.h, k, k, k);
      mid(LS, HALO, w.x + ox, w.y + oy + w.h / 2, w.z + .06, w.w * w.halo * 1.7, w.h * w.halo * 1.25, w.c[0] * hz, w.c[1] * hz, w.c[2] * hz);
    }
    // —— 烛火：每秒 8 拍换帧；灯晕和地上的光晕跟着一跳一跳 ——
    for (const f of FLAMES) {
      const ox = f.g ? f.g.position.x : 0, oy = f.g ? f.g.position.y : 0, x = f.x + ox, y = f.y + oy;
      up(LG, FRAMES[f.k][calm ? 0 : (beat + f.ph) & 3], x, y, f.z, f.w, f.h, FL, FL, FL);
      if (f.hl) { const j = (calm ? 1 : .82 + .36 * hash(beat, f.ph, 5)) * LOOK.halo, sz = f.hl * (calm ? 1 : .92 + .16 * hash(beat, f.ph, 6)); mid(LS, HALO, x, y + f.h * .45, f.z + .03, sz, sz, f.c[0] * j, f.c[1] * j, f.c[2] * j); }
    }
    for (const p of POOLS) { const ox = p.g ? p.g.position.x : 0, oy = p.g ? p.g.position.y : 0, j = (calm ? .3 : .24 + .12 * hash(beat, p.ph, 7)), r = p.r * (calm ? 1 : .94 + .12 * hash(beat, p.ph, 8)); flat(LS, HALO, p.x + ox, p.y + oy, p.z, r * 1.5, r, 0, p.c[0] * j, p.c[1] * j, p.c[2] * j); }
    // —— 地上的色光和光柱：一起慢慢明灭 ——
    for (const p of PATCH) {
      const cl = cloudOf(p.i + 3, t), k = LOOK.patch * p.k * cl; flat(LS, p.a, p.x, p.y, p.z, p.w, p.l, p.ang, k, k, k);
      if (!p.top) continue;
      // 光柱是一片对着镜头的梯形：下头落在光斑上，上头收到窗口
      const tx = p.top[0], ty = p.top[1], tz = p.top[2], ax = tx - p.x, ay = ty - p.y, az = tz - p.z, mx = cam.x - (p.x + tx) / 2, my = cam.y - (p.y + ty) / 2, mz = cam.z - (p.z + tz) / 2;
      let sx = ay * mz - az * my, sy = az * mx - ax * mz, sz = ax * my - ay * mx; const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const hb = p.w * .5, ht = p.hw, s = LOOK.shaft * p.k * cl;
      LS.put(p.x + sx * hb, p.y + sy * hb, p.z + sz * hb, p.x - sx * hb, p.y - sy * hb, p.z - sz * hb, tx - sx * ht, ty - sy * ht, tz - sz * ht, tx + sx * ht, ty + sy * ht, tz + sz * ht, BEAM, p.col[0] * s, p.col[1] * s, p.col[2] * s);
    }
    // —— 光柱里的浮尘：顺着光柱慢慢往下飘，带一点左右晃 ——
    for (let i = 0; i < NM; i++) {
      const p = SHAFTS[i % SHAFTS.length], a = (rnd(i, 21) + (calm ? 0 : t * (.012 + rnd(i, 22) * .02))) % 1, u = 1 - a, off = (rnd(i, 23) - .5) * 1.5 * (p.w * .5 * (1 - u) + p.hw * u), wob = calm ? 0 : Math.sin(t * .6 + i) * .06;
      const x = p.x + (p.top[0] - p.x) * u + off + wob, y = p.y + (p.top[1] - p.y) * u * .85 + .1, z = p.z + (p.top[2] - p.z) * u * .85 + (rnd(i, 24) - .5) * .5, sz = .035 + rnd(i, 25) * .04, k = (.55 + .45 * Math.sin(t * 1.7 + i * 2.3)) * Math.min(1, a * 6, u * 6) * cloudOf(p.i + 3, t) * .75;
      mid(LS, DOT, x, y, z, sz, sz, (p.col[0] * .5 + .5) * k, (p.col[1] * .5 + .5) * k, (p.col[2] * .5 + .5) * k);
    }
    // —— 吊着的和挂着的 ——
    for (const h of HANG) {
      const ox = h.g ? h.g.position.x : 0, oy = h.g ? h.g.position.y : 0, w = h.a.w / PPM * h.s, hh = h.a.h / PPM * h.s, th = calm ? h.amp * .4 : h.amp * Math.sin(t * h.sp + h.ph);
      if (!h.mode) {                                      // 布：上沿不动，下沿荡，中间带一点滞后的小波
        const dx = th * hh, dz = calm ? 0 : Math.cos(t * h.sp * .7 + h.ph) * h.amp * .3 * hh, c = Math.cos(h.ry) * w / 2, sn = -Math.sin(h.ry) * w / 2, x = h.x + ox, y = h.y + oy;
        LC.put(x - c + dx, y - hh, h.z - sn + dz, x + c + dx, y - hh, h.z + sn + dz, x + c, y, h.z + sn, x - c, y, h.z - sn, h.a, 1, 1, 1);
        continue;
      }
      // 摆锤：先画链子（两米一段），再画挂着的那件，最后是它身上的火
      const c = Math.cos(th), sn = Math.sin(th), lw = h.link.w / PPM / 2;
      for (let l0 = 0; l0 < h.len - .01; l0 += 2) {
        const l1 = Math.min(h.len, l0 + 2), fr = (l1 - l0) / 2; TMP.u0 = h.link.u0; TMP.u1 = h.link.u1; TMP.vt = h.link.vt; TMP.vb = h.link.vt + (h.link.vb - h.link.vt) * fr;
        LC.put(h.x - lw * c + l1 * sn, h.y - lw * sn - l1 * c, h.z, h.x + lw * c + l1 * sn, h.y + lw * sn - l1 * c, h.z, h.x + lw * c + l0 * sn, h.y + lw * sn - l0 * c, h.z, h.x - lw * c + l0 * sn, h.y - lw * sn - l0 * c, h.z, TMP, .8, .8, .8);
      }
      const l0 = h.len, l1 = h.len + hh, hw = w / 2;
      LC.put(h.x - hw * c + l1 * sn, h.y - hw * sn - l1 * c, h.z, h.x + hw * c + l1 * sn, h.y + hw * sn - l1 * c, h.z, h.x + hw * c + l0 * sn, h.y + hw * sn - l0 * c, h.z, h.x - hw * c + l0 * sn, h.y - hw * sn - l0 * c, h.z, h.a, 1, 1, 1);
      if (h.kind && h.a.tips) for (let i = 0; i < h.a.tips.length; i++) {
        const lx = (h.a.tips[i][0] / h.a.w - .5) * w, ly = h.len + h.a.tips[i][1] / h.a.h * hh, x = h.x + lx * c + ly * sn, y = h.y + lx * sn - ly * c, j = (calm ? 1 : .82 + .36 * hash(beat, i + h.ph * 10, 5)) * LOOK.halo;
        up(LG, FRAMES.fa[calm ? 0 : (beat + i * 3) & 3], x, y, h.z + .012, .19, .33, FL, FL, FL); if (!(low && i % 2)) mid(LS, HALO, x, y + .15, h.z + .03, .8, .8, WARM[0] * j, WARM[1] * j, WARM[2] * j);
      }
    }
    // —— 香炉的烟：一团团从香炉当时所在的位置冒出来，往上飘、越飘越大 ——
    for (let i = 0; i < 7; i++) {
      const age = calm ? i / 7 : (t * .22 + i / 7) % 1, te = t - age / .22, th = calm ? CENSER.amp * .4 : CENSER.amp * Math.sin(te * CENSER.sp + CENSER.ph), L = CENSER.len + .2;
      const x = CENSER.x + L * Math.sin(th) + Math.sin(age * 5 + i) * .12 * age, y = CENSER.y - L * Math.cos(th) + age * 1.5, sz = .14 + age * .3, k = .95 - age * .5;
      if (age < .92) up(LP, SMOKE[age < .25 ? 0 : age < .6 ? 1 : 2], x, y, CENSER.z + .02, sz, sz, k, k, k * 1.1);
    }
    // —— 飘落的花瓣和书页（只落在盘外：盘后、两侧）——
    for (let i = 0; i < NP; i++) {
      const page = i % 6 === 5, age = calm ? rnd(i, 31) : (t * (page ? .07 : .1) * (.7 + rnd(i, 32) * .6) + rnd(i, 31)) % 1, side = i % 3;
      const x0 = side === 0 ? (rnd(i, 33) - .5) * 5 : (side === 1 ? -1 : 1) * (EDGE + .4 + rnd(i, 33) * 2.4), z0 = side === 0 ? BK - .5 - rnd(i, 34) * 1.6 : -2.2 + rnd(i, 34) * 4.4;
      const x = x0 + (calm ? 0 : Math.sin(t * (page ? .9 : 1.5) + i * 4) * (page ? .35 : .18)), y = 3.6 * (1 - age) + FY + .05;
      if (page) up(LP, PAGEF[calm ? 0 : (beat >> 1) + i & 1], x, y, z0, .2, .15, .9, .9, .95); else up(LP, PETF[calm ? i & 3 : (beat + i) & 3], x, y, z0, .085, .085, 1, 1, 1);
    }
    // —— 偶尔飞过的鸽子：从后墙前面横穿过去，翅膀每秒 8 拍扇 ——
    if (!calm) for (let i = 0; i < 2; i++) {
      const u = ((t + i * 9.5) % 19) / 5.5; if (u >= 1) continue;
      const dir = i ? -1 : 1, x = dir * (-11 + 22 * u), y = (SHORT ? .9 : 2.05) + i * .3 + Math.sin(u * 9) * .12, w = .46;
      up(LP, DOVE[beat & 1], x, y, BK - 1.9 - i * .5, w, w * 14 / 22, 1, 1, 1, dir < 0);
    }
    // —— 贴镜头的前景剪影：按画面坐标摆在四角（左下长椅靠背和烛台，右下铁艺栏杆和烛台，上面两角是拱肋）——
    { const asp = camera.aspect, wOf = (r, h) => h * (r.w / r.h) / asp;
      const hp = SHORT ? .42 : .42, wp = wOf(FGP, hp), hr = .56, wr = wOf(FGR, hr), hc = SHORT ? .8 : .86, wc = wOf(FGC, hc), ha = SHORT ? .5 : .62, wa = wOf(FGA, ha);
      screen(LF, FGP, -1.04, -1.08, -1.04 + wp, -1.08 + hp, FG, FG, FG * 1.1); screen(LF, FGR, 1.04 - wr, -1.12, 1.04, -1.12 + hr, FG, FG, FG * 1.1);
      screen(LF, FGA, -1.02, 1.02 - ha, -1.02 + wa, 1.02, 1, 1, 1); screen(LF, FGA, 1.02 - wa, 1.02 - ha, 1.02, 1.02, 1, 1, 1, true);
      for (const sx of [-1, 1]) {
        const cx = sx * (sx < 0 ? .915 : .94), x0 = cx - wc / 2, y0 = -1.06; screen(LF, FGC, x0, y0, x0 + wc, y0 + hc, 1, 1, 1, sx > 0);
        for (let i = 0; i < 3; i++) {                      // 剪影上的三朵火是亮的，各带一团暖晕
          const tp = FGC.tips[i], fx = x0 + (sx > 0 ? 1 - tp[0] / FGC.w : tp[0] / FGC.w) * wc, fy = y0 + (1 - tp[1] / FGC.h) * hc, fw = wc * .2, fh = hc * .1, j = (calm ? 1 : .8 + .4 * hash(beat, i + sx * 5 + 9, 5)) * .5;
          screen(LF, FRAMES.fb[calm ? 0 : (beat + i * 5 + (sx > 0 ? 2 : 0)) & 3], fx - fw / 2, fy, fx + fw / 2, fy + fh, FL, FL, FL);
          screen(LS, HALO, fx - fw * 2.4, fy - fh * .9, fx + fw * 2.4, fy + fh * 1.9, WARM[0] * j, WARM[1] * j, WARM[2] * j);
        }
      }
    }
    LG.end(); LC.end(); LP.end(); LS.end(); LF.end();
  }

  // 「减少动态效果」时游戏不调 tick：这里自己摆一次；镜头是 build 之后才摆好的，所以下一帧、400 毫秒后、每次改窗口大小后再各补一次
  scene.updateMatrixWorld(true); tick(0);
  const again = () => requestAnimationFrame(() => { camera.updateMatrixWorld(true); tick(last); });
  addEventListener('resize', again); again(); setTimeout(again, 400);
  return { tick };
}
