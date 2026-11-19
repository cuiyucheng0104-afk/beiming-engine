// 《云上浮岛》：擂台搭在一座浮岛顶上，脚下是云海，黄金时刻的斜阳从左后方照过来。
// 本方（青）是一座风车塔，对面（红）是系着红气球的飞艇码头。画法在 paint / tex / props / sky 四个文件里，搭建工具在 kit.js。
// 入口只有一个 build(ctx)：搭一次，返回 { tick }。three 用 ctx.THREE，不自己 import。
import { hash } from './paint.js';
import * as T from './tex.js';
import { sprites, hex } from './props.js';
import { clouds, softs, curtainPix, puffLayerPix } from './sky.js';
import { makeKit } from './kit.js';

// —— 整个场景的调子都在这里 ——
const LOOK = {
  amb: ['#5874e6', .44],            // 天光：蓝的，影子里是它
  sun: ['#ffb864', 1.9],            // 斜阳：金的
  fill: ['#6f9cff', .26],            // 从镜头这边补的一点蓝光，让背阴面有形
  bloom: [.36, .68, .9], tilt: { focus: .44, band: .22, amt: 2 }, tiltShort: { focus: .58, band: .3, amt: 1.5 },   // 手机横屏盘面占满画面、血量牌贴着上沿：清楚带放高、放宽
  grade: { sat: 1.3, con: 1.1, knee: .82, gain: [1.02, 1, 1.03], lift: [.004, .008, .028], edge: [0, .012, .05] },
  haze: '#2f4a90',                  // 远处的雾：比近处亮的蓝白（整体压暗过，所以数值不高）
  curtain: [.38, .3, .36],                    // 天幕整体的亮度
  sea: [.06, .098, .23],                       // 脚下云海的亮度
  cloud: [.2, .24, .4],                      // 一朵朵云的亮度
  card: .3,                         // 像素片吃到多少太阳（法线和太阳的夹角余弦）
  glow: 1.4,                        // 发光片的亮度（高画质下会泛光）
  skyline: .2,                      // 画面最上面多高是天
  lamp: 1.5,
};
const SUN_FROM = [-6, 9, -9];       // 太阳在左后方，不高：影子长

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, team, grid } = ctx, { HALF, DEPTH, HPY, SHORT } = grid;
  const K = makeKit(THREE), HD = DEPTH / 2, W = new THREE.Group(); scene.add(W);
  const R = (i, k = 0) => hash(i, k + 700), TC = team.map(hex), PI = Math.PI;
  const GY = -.1, SEA = -7;                                   // 草皮顶面的高度；云海的高度
  // 设计时按桌面的盘（半宽 2.5、半深 2.4）摆；盘变大（手机横屏）时盘外的东西跟着盘边走
  const fx = u => (Math.abs(u) > 2.5 ? Math.sign(u) * (HALF + Math.abs(u) - 2.5) : u * HALF / 2.5);
  const fz = v => (Math.abs(v) > 2.4 ? Math.sign(v) * (HD + Math.abs(v) - 2.4) : v * HD / 2.4);
  const EX = HALF + .5, EZ = HD + .5, KS = SHORT ? .8 : 1;    // 台基的半宽半深；矮屏幕上城堡里个别东西缩一点

  // ———————————————————— 光和雾 ————————————————————
  const hazeC = new THREE.Color(LOOK.haze), col = (c, k = 1) => new THREE.Color(...c).multiplyScalar(k);
  scene.background.copy(hazeC); scene.fog = new THREE.Fog(hazeC, 24, 48);
  const sl = Math.hypot(...SUN_FROM), SUND = SUN_FROM.map(v => v / sl);
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1]; sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1]; sun.position.set(SUND[0] * 30, SUND[1] * 30, SUND[2] * 30);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17, near: 2, far: 66 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  const fill = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); fill.position.set(5, 6, 12); W.add(fill);

  // ———————————————————— 材质 ————————————————————
  const M = {
    stone: K.lam(T.stonePix()), pave: K.lam(T.pavePix()), pit: K.lam(T.pitPix()), turf: K.lam(T.turfPix()), rock: K.lam(T.rockPix()),
    roofC: K.lam(T.roofPix('#1697b4', 1)), roofR: K.lam(T.roofPix(TC[1], 2)), plank: K.lam(T.plankPix()), wood: K.lam(T.plankPix('#6e4634')),
    awn: K.lam(T.awningPix(TC[1], '#f6ecd8')), brass: K.lam(T.brassPix()),
    sail: K.lam(T.sailPix('#19b6c6', '#eef6f2'), { alphaTest: .5, side: THREE.DoubleSide }),
    balloon: K.lam(T.balloonPix(TC[1], '#fff0d0')),
  };
  M.wall = K.lam(T.stonePix()); M.wall.emissive.set(0x9fb4ff); M.wall.emissiveMap = M.wall.map; M.wall.emissiveIntensity = .12;   // 城堡的石墙：自己带一点蓝亮，背阴面（正对镜头的那几面）也看得清砖缝
  M.sail.userData.noCast = true;                              // 风车叶不投影：转着的影子扫在盘面上会抢棋子
  for (const m of [M.balloon, M.roofC, M.roofR, M.sail]) { m.emissive.set(0xffffff); m.emissiveMap = m.map; m.emissiveIntensity = m === M.balloon ? .2 : .12; }   // 队伍色的大面自己带一点亮：背阴面也认得出颜色
  M.fall = new THREE.MeshBasicMaterial({ map: K.tex(T.fallPix()), alphaTest: .5, side: THREE.DoubleSide, color: new THREE.Color(.26, .42, .66) }); M.fall.userData.m = [.5, 64 / 48];
  M.grout = new THREE.MeshLambertMaterial({ color: '#a8c4f0' }); M.grout.userData.m = [1, 1];                    // 格子缝里露出来的浅色石缝：格线靠它读出来
  M.pave.color.setScalar(.6); M.plank.color.setScalar(.72); M.turf.color.setScalar(.85);                                                                                           // 盘外的铺地压暗一点，别比盘面抢眼
  M.pond = new THREE.MeshBasicMaterial({ color: '#2f78b4' });

  // 小件图集（props + 云）和软光图集
  const AT = K.pack({ ...sprites(TC), ...clouds() }), SF = K.pack(softs(), { smooth: true, pad: 2, width: 512 }), S = SF.at;
  const a = n => { const r = AT.at[n]; if (!r) throw new Error('图集里没有小件：' + n); return r; };
  const fr = n => [0, 1, 2, 3].map(i => a(n + i));            // 四帧的旗
  const NUP = (() => { const k = LOOK.card, n = [-.1, .86, .5], d = n[0] * SUND[0] + n[1] * SUND[1] + n[2] * SUND[2], m = [n[0] + SUND[0] * (k - d), n[1] + SUND[1] * (k - d), n[2] + SUND[2] * (k - d)], l = Math.hypot(...m); return m.map(v => v / l); })();   // 像素片共用的法线：朝上朝前，掺一点朝太阳
  const litM = new THREE.MeshLambertMaterial({ map: AT.tex, alphaTest: .5, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  const airM = new THREE.MeshBasicMaterial({ map: AT.tex, alphaTest: .5, side: THREE.DoubleSide, color: col(LOOK.cloud) });
  const glowM = new THREE.MeshBasicMaterial({ map: AT.tex, alphaTest: .5, side: THREE.DoubleSide, fog: false, color: new THREE.Color().setScalar(low ? 1.15 : LOOK.glow) });
  const fgM = new THREE.MeshBasicMaterial({ map: AT.tex, alphaTest: .5, side: THREE.DoubleSide, fog: false, depthTest: false, depthWrite: false, transparent: true });
  const addM = new THREE.MeshBasicMaterial({ map: SF.tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const hazeM = new THREE.MeshBasicMaterial({ map: SF.tex, vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const LIT = K.Cards(W, litM, 1300, { normal: NUP, cast: true, receive: true });       // 不动的小件：吃光、投影
  const GLOW = K.Cards(W, glowM, 160);                                                   // 不动的发光片：水晶、窗、灯
  const LIVE = K.Cards(W, litM, 520, { dyn: true, normal: NUP, receive: true });         // 会动的小件：旗、草、风筝
  const AIR = K.Cards(W, airM, 320, { dyn: true });                                      // 天上的：云、飞艇、鸟、花瓣（不吃光，远了被雾染淡）
  const SOFT = K.Cards(W, addM, 140, { dyn: true, rgba: true, order: 3 });               // 叠加的软光：灯晕、光柱、闪光
  const HAZE = K.Cards(W, hazeM, 110, { dyn: true, rgba: true, order: 4 });              // 盖上去的软片：水雾、云丝、彩虹
  const FG = K.Cards(W, fgM, 16, { dyn: true, order: 6 });                               // 贴镜头的前景剪影
  const Y = K.Yard(W);

  // ———————————————————— 盘面：整盘画一张，切给 20 块格子 ————————————————————
  { const { pix, TW, TH } = T.boardPix(grid), src = pix.canvas();
    for (const t of tiles) { const c = document.createElement('canvas'); c.width = TW; c.height = TH; c.getContext('2d').drawImage(src, -t.userData.r * TW, -t.userData.c * TH); t.material = new THREE.MeshLambertMaterial({ map: K.tex(c, { repeat: false }), color: new THREE.Color().setScalar(2.1) }); } }
  K.box(Y, [M.stone, M.pave], EX * 2, .12, EZ * 2, 0, GY, 0);                            // 白石台基，顶上铺方砖
  K.box(Y, M.grout, HALF * 2 + .02, .03, DEPTH + .02, 0, .02, 0);                          // 垫在格子底下的浅色石板：格缝里露出来的就是它，垫到快贴着格子顶面，横缝从镜头这个俯角也看得见
  K.box(Y, M.stone, EX * 2 + .16, .07, EZ * 2 + .16, 0, GY, 0);                           // 台基脚下的一圈石沿

  // ———————————————————— 主岛：圆角方的一块，下面是倒锥的崖 ————————————————————
  const EXP = .74, RX = fx(5.3), RZB = -fz(-5.35), RZF = fz(3.7), NP = 32, shore = [];
  for (let i = 0; i < NP; i++) { const an = i / NP * 2 * PI, c = Math.cos(an), s = Math.sin(an), j = 1 + (R(i, 1) - .5) * .1; shore.push([Math.sign(c) * Math.abs(c) ** EXP * RX * j, Math.sign(s) * Math.abs(s) ** EXP * (s < 0 ? RZB : RZF) * j]); }
  const onIsle = (x, z, m = .93) => (Math.abs(x) / (RX * m)) ** (2 / EXP) + (Math.abs(z) / ((z < 0 ? RZB : RZF) * m)) ** (2 / EXP) < 1;
  const edgeZ = x => RZF * Math.max(0, 1 - (Math.abs(x) / RX) ** (2 / EXP)) ** (EXP / 2);   // 这个 x 上，岛的前沿在哪
  const SPOTS = [];                                                                        // 岛底下水晶的位置（tick 里给它们打光晕）
  // 岛底下挂的东西：草皮边垂下来的草、树根和藤、青色的浮空水晶
  const under = (rings, cz, seed, big = 1) => {
    const n = rings[0].length;
    for (let i = 0; i < n; i++) { const p1 = rings[1][i], p2 = rings[2][i], p3 = rings[3][i]; if (p1[2] < cz - .2) continue;      // 只挂朝镜头这半圈
      LIT.hang(a(i % 2 ? 'fringeA' : 'fringeB'), p1[0], p1[1] + .1, p1[2] + .04, big, R(i, seed) > .5);
      if (R(i, seed + 1) > .35) LIT.hang(a(['rootA', 'vineA', 'rootB', 'vineB'][Math.floor(R(i, seed + 2) * 4)]), p2[0] + (R(i, seed + 3) - .5) * .3, p2[1] + .25, p2[2] + .06, big > 1 ? 1.2 : .8, R(i, seed + 4) > .5);
      if (R(i, seed + 5) > .5) { const c = ['crystalS', 'crystalM', 'crystalL'][Math.floor(R(i, seed + 6) * 3)], s = big > 1 ? 1.5 : 1; GLOW.hang(a(c), p3[0], p3[1] + .1, p3[2] + .1, s); SPOTS.push([p3[0], p3[1] - a(c).h * s * .4, p3[2] + .16, a(c).h * s * 3.2, R(i, seed + 7) * 6.28]); } }
  };
  under(K.isle(Y, M.turf, M.rock, shore, [[0, 1], [.18, 1.015], [.9, .93], [2.1, .75], [3.5, .5], [4.9, .24], [5.9, .05]], 0, GY, 0, 7), .4, 11, 1.4);
  // 卫星小岛：小一号的同一种东西
  const islet = (x, y, z, rx, rz, depth, seed, n = 12) => { const pts = []; for (let i = 0; i < n; i++) { const an = i / n * 2 * PI, j = 1 + (R(i, seed) - .5) * .26; pts.push([Math.cos(an) * rx * j, Math.sin(an) * rz * j]); }
    under(K.isle(Y, M.turf, M.rock, pts, [[0, 1], [.12, 1.02], [depth * .24, .9], [depth * .52, .62], [depth * .8, .3], [depth, .04]], x, y, z, seed), z, seed + 20); };
  const IA = [fx(-8.4), -1.3, fz(-8.4)], IB = [fx(-7.5), -2.3, fz(-2.6)], IC = [fx(7.3), -1.3, fz(-1.6)], ID = [fx(6.6), -2.7, fz(-9.6)];   // 磨坊岛（左后）、灯塔岛（左）、货栈岛（右）、树岛（右后）
  islet(...IA, 2.3, 1.6, 3.2, 31, 14); islet(...IB, 1.15, .85, 2.2, 32); islet(...IC, 1.2, .95, 2.3, 33); islet(...ID, 1.8, 1.3, 2.8, 34);
  const ROCKS = [[fx(-6.3), -1.1, fz(1.4), .5], [fx(6.4), -2.6, fz(-5), .6], [fx(-5.9), -3.2, fz(-6.6), .55], [fx(1.8), -3.6, fz(-9.4), .7], [fx(-2.6), -4.2, fz(-11.5), .8], [fx(9.8), -3.4, fz(-6.2), .5]];   // 几块零散的浮石
  ROCKS.forEach(([x, y, z, r], i) => islet(x, y, z, r, r * .75, r * 2, 40 + i, 7));

  // ———————————————————— 岛上的小件 ————————————————————
  const up = (n, u, v, s = 1, flip = false, y = GY) => LIT.up(a(n), fx(u), y, fz(v), s, flip);
  const LAMPS = [];                                                                        // 所有会发光的点：[x, y, z, 颜色, 光晕大小, 强度, 闪不闪]
  // 后沿的白石栏杆：一段段栏板，接缝上立望柱，两头的望柱顶着灯
  { const n = Math.round(EX * 2), w = EX * 2 / n, z = -EZ + .1; for (let i = 0; i < n; i++) LIT.up(a('rail'), -EX + w * (i + .5), .02, z, w, false, 0, 0);
    for (let i = 0; i <= n; i += 2) { const end = i === 0 || i >= n - 1, x = -EX + w * i; LIT.up(a(end ? 'postLamp' : 'post'), x, .02, z + .03, 1, false, 0, 0); if (end) LAMPS.push([x, .62, z + .1, '#ffd070', 1.3, .5, 1]); } }
  for (const sx of [-1, 1]) LIT.up(a('post'), sx * (EX - .12), .02, EZ - .12, .8, false, 0, 0);    // 前沿两角的矮柱
  // 后花园：拱门、树、井、长椅、望远镜
  up('arch', -3.75, -4.2, .85); up('treeA', -4.7, -4.7, 1, true); up('cypress', -2.55, -4.75); up('treeB', -1.5, -4.95); up('bushB', -2.25, -3.75); up('well', -.6, -4.05); up('cypressS', .55, -4.8); up('treeD', 1.6, -4.95);
  up('bench', 1.65, -3.6); up('scope', 2.75, -3.75); up('bushA', 3.35, -4.35); up('treeC', 4.3, -4.65, 1, true); up('bushD', 4.55, -3.7); up('signpost', -2.9, -3.4); up('rockB', .9, -3.9); up('rockA', -1.3, -3.6); up('bushC', 2.2, -4.5); up('rockC', 3.9, -3.3);
  for (const [u, v] of [[-3.4, -3.3], [3.4, -3.3], [-3.45, 3.2], [3.45, 3.2]]) { up('lantern', u, v); LAMPS.push([fx(u), GY + .42, fz(v) + .05, '#ffc860', 1.1, .45, 1]); }   // 石灯笼
  LIT.flat(a('stoneA'), fx(.35), GY + .012, fz(-3.25), 1, .3); LIT.flat(a('stoneB'), fx(-.05), GY + .012, fz(-3.6), 1, -.2); LIT.flat(a('stoneA'), fx(-.4), GY + .012, fz(-3.85), 1, .8);
  // 左前角：磨坊的板车和面粉袋；右前角：码头的货
  up('cart', -4.3, 2.95); up('sack', -3.75, 3.2); up('sack', -3.5, 3.05, 1, true); up('rockA', -4.95, 2.3, 1, true); up('barrelC', -4.75, 3.1); up('reed', -5.0, 1.3); up('reed', -5.05, .9, 1, true);
  up('crateA', 3.55, 3.1); up('crateC', 4.05, 3.25); up('barrel', 4.5, 3.0); up('coil', 3.2, 3.3); up('crateB', 4.3, 2.85); up('anchor', 4.85, 2.4); up('bollard', 5.0, 1.6); up('bollard', 5.05, -2.9);
  { const x = fx(4.1); LIT.hang(a('ladder'), x, GY + .02, edgeZ(x) - .02, 1); const x2 = fx(-4.2); LIT.hang(a('ladder'), x2, GY + .02, edgeZ(x2) - .02, .8); }   // 岛沿上垂下去的绳梯
  // 旗杆（木杆是一截截接起来的片）；杆顶的旗在 tick 里按帧换
  const FLAGS = [];
  const pole = (x, y, z, h, flag, s = 1, lit = LIT) => { const p = a('pole'); for (let k = 0; k * p.h < h; k++) lit.up(p, x, y + k * p.h, z, 1, false, 0, 0); if (flag) FLAGS.push({ f: fr(flag), x, y: y + h, z, s, k: FLAGS.length }); };
  pole(fx(-1.95), GY, fz(-3.3), 2.0, 'strmA'); pole(fx(.95), GY, fz(-3.25), 1.7, 'strmB'); pole(fx(3.7), GY, fz(-3.15), 1.3, 'pennG'); pole(fx(-4.85), GY, fz(-3.3), 1.5, 'bannW');
  for (let i = 2; i <= Math.round(EX * 2) - 2; i += 2) pole(-EX + EX * 2 / Math.round(EX * 2) * i, .62, -EZ + .13, .3, 'pennG', .8);   // 栏杆望柱上的小金旗
  // 草和花：撒在草皮上，躲开台基和两座城堡的地盘；tick 里随风歪
  const GRASS = []; { const names = ['tuft0', 'tuft1', 'tuft2', 'tuft0', 'tuft1', 'flowerA', 'flowerB', 'flowerC', 'flowerD', 'flowerE', 'tuft2', 'reed'];
    for (let i = 0; i < (low ? 150 : 260); i++) { const x = (R(i, 61) * 2 - 1) * RX, z = -RZB + R(i, 62) * (RZB + RZF); if (!onIsle(x, z) || (Math.abs(x) < EX + 2.05 && Math.abs(z) < EZ + .12)) continue; GRASS.push({ r: a(names[Math.floor(R(i, 63) * names.length)]), x, z, flip: R(i, 64) > .5, ph: x * .9 + z * .4 }); } }

  // ———————————————————— 绳桥：一块块桥板顺着垂下去的弧线铺，两边各一道绳 ————————————————————
  const bridge = (x0, y0, z0, x1, y1, z1, sag = .45) => { const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, y1 - y0, dz), n = Math.max(5, Math.round(len / .3)), yaw = Math.atan2(-dx, -dz), l = Math.hypot(dx, dz), ax = -dz / l * .24, az = dx / l * .24, p = a('plank'), rp = a('rope'); let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= n; i++) { const u = i / n, x = x0 + dx * u, y = y0 + (y1 - y0) * u - Math.sin(u * PI) * sag, z = z0 + dz * u; LIT.flat(p, x, y, z, 2, yaw);
      if (i) for (const s of [-1, 1]) LIT.line(rp, px + ax * s, py + .34, pz + az * s, x + ax * s, y + .34, z + az * s, .045);
      if (i % 2 === 0) for (const s of [-1, 1]) LIT.line(rp, x + ax * s, y, z + az * s, x + ax * s, y + .34, z + az * s, .03);
      px = x; py = y; pz = z; }
    for (const [x, y, z] of [[x0, y0, z0], [x1, y1, z1]]) for (const s of [-1, 1]) LIT.up(a('bollard'), x + ax * s * 1.3, y, z + az * s * 1.3, 1.2, false, 0, 0); };
  bridge(fx(-3.9), GY, -RZB * .93, IA[0] + 1.3, IA[1], IA[2] + 1.25);                     // 主岛 → 磨坊岛（从拱门后面出去）
  bridge(fx(5.15), GY, fz(-1.2), IC[0] - 1.0, IC[1], IC[2] + .1, .3);                      // 主岛 → 货栈岛
  bridge(IA[0] - 1.6, IA[1], IA[2] + .9, IB[0] - .2, IB[1], IB[2] - .7, .6);               // 磨坊岛 → 灯塔岛

  // ———————————————————— 卫星小岛上的东西 ————————————————————
  const on = (I, n, dx, dz, s = 1, flip = false) => LIT.up(a(n), I[0] + dx, I[1], I[2] + dz, s, flip);
  on(IA, 'millBody', -.5, -.3); on(IA, 'hutA', .85, -.5); on(IA, 'treeC', -1.6, .1); on(IA, 'bushA', .2, .55); on(IA, 'fence', 1.2, .6); on(IA, 'cypressS', 1.75, -.2); on(IA, 'tuft2', -.9, .7); on(IA, 'flowerB', .7, .9); on(IA, 'barrel', -1.0, .35);
  on(IB, 'beacon', 0, -.1); on(IB, 'bushC', -.6, .3); on(IB, 'rockB', .55, .35); on(IB, 'tuft1', .2, .5);
  on(IC, 'hutC', -.1, -.3); on(IC, 'crateA', .6, .35); on(IC, 'barrelR', -.75, .3); on(IC, 'treeC', .75, -.5, .8); on(IC, 'crateB', .25, .55);
  on(ID, 'treeB', -.5, -.3); on(ID, 'treeA', .7, -.5, .9, true); on(ID, 'hutB', -1.15, .1, .9); on(ID, 'bushD', .3, .5); on(ID, 'cypress', 1.3, 0, .8);
  ROCKS.forEach(([x, y, z], i) => LIT.up(a(['bushA', 'cypressS', 'treeC', 'bushC', 'treeD', 'bushB'][i]), x, y, z - .05, i === 2 || i === 4 ? .8 : 1));
  const MILL = [IA[0] - .5, IA[1] + .98, IA[2] - .28], BEACON = [IB[0], IB[1] + 1.52, IB[2]], SMOKE = [IA[0] + 1.17, IA[1] + .85, IA[2] - .5];   // 小风车的轴、灯塔的灯、烟囱口
  LAMPS.push([BEACON[0], BEACON[1], BEACON[2] + .1, '#fff0a0', 1.1, .8, 2]);

  // ———————————————————— 瀑布：磨坊岛的池子漫过岛沿落进云里；主岛左边还有一道磨坊的出水 ————————————————————
  const FALLS = [];
  const fall = (x, y, z, w, h) => { const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * h / M.fall.userData.m[1]); g.translate(0, -h / 2, 0); Y.put(g, M.fall, x, y, z); FALLS.push([x, y - h, z, w]); };
  K.disc(Y, M.pond, .5, IA[0] + .25, IA[1] + .012, IA[2] + 1.0, 10); fall(IA[0] + .25, IA[1] + .03, IA[2] + 1.6, .55, 4.4); LIT.up(a('rockB'), IA[0] - .2, IA[1], IA[2] + 1.45); LIT.up(a('rockB'), IA[0] + .75, IA[1], IA[2] + 1.5, 1, true);
  { const x = -RX * .985, z = fz(.2); K.box(Y, M.stone, .5, .16, .34, x + .2, GY - .12, z); fall(x - .12, GY - .02, z + .02, .4, 5.2); }

  // ———————————————————— 本方城堡（青）：风车塔。后面一座高塔顶着大风车，前面一座矮磨坊带小风车，中间是门楼 ————————————————————
  const ROTORS = [];
  // 一副风车叶：四片帆布，挂在一个会转的组里；法线朝后，逆着光是透亮的
  const rotor = (g, x, y, z, r) => { const tilt = new THREE.Group(), spin = new THREE.Group(); tilt.position.set(x, y, z); tilt.rotation.x = -.16; tilt.add(spin); g.add(tilt);
    const Yr = K.Yard(spin), w = r * 26 / 64; for (let b = 0; b < 4; b++) { const pg = new THREE.PlaneGeometry(w, r); pg.translate(w * .02, r / 2 + .03, 0); Yr.put(pg, M.sail, 0, 0, 0, 0, 0, b * PI / 2); }
    K.box(Yr, M.brass, .16, .16, .12, 0, -.08, -.02);
    for (const m of Yr.done()) if (m.material === M.sail) { const nb = m.geometry.attributes.normal; for (let i = 0; i < nb.count; i++) nb.setXYZ(i, -.3, .3, -.9); }
    ROTORS.push([spin, .5 / r]); };
  { const g = castles[0], Yc = K.Yard(g), C = K.Cards(g, litM, 60, { normal: NUP, cast: true, receive: true }), G = K.Cards(g, glowM, 12), zH = -HD * .6, zM = HD * .24, tx = -.16, MS = SHORT ? .76 : 1;
    K.box(Yc, [M.wall, M.pave], 1.9, .12, DEPTH * .97, 0, GY, 0);                                    // 石台
    K.box(Yc, M.wall, .34, .6, DEPTH * .88, -.76, .02, 0); for (let i = 0; i < 9; i++) K.box(Yc, M.wall, .36, .15, DEPTH * .05, -.76, .62, (i - 4) * DEPTH * .88 / 9);   // 外侧的矮墙和垛口
    // 后面的磨坊仓：石头的方屋、两坡青瓦顶，后角一座细高的角楼
    K.box(Yc, M.wall, 1.3, 1.0 * MS, 1.3, .06, .02, zH); K.box(Yc, M.wall, 1.3, .3 * MS, .56, .06, .02 + 1.0 * MS, zH);
    { const y = .02 + 1.26 * MS, an = Math.atan2(.56 * MS, .76), L = Math.hypot(.56 * MS, .76) + .12; K.box(Yc, M.roofC, 1.46, .06, L, .06, y, zH + .4, 0, an); K.box(Yc, M.roofC, 1.46, .06, L, .06, y, zH - .4, 0, -an); K.box(Yc, M.brass, 1.5, .07, .08, .06, .02 + 1.54 * MS, zH); }
    { const h = SHORT ? .95 : 1.95; K.tube(Yc, M.wall, .24, .3, h, -.52, .02, zH - .5, 8, PI / 8); K.tube(Yc, M.brass, .29, .29, .07, -.52, h, zH - .5, 8, PI / 8); K.cone(Yc, M.roofC, .42, SHORT ? .4 : .6, -.52, h + .07, zH - .5, 8, PI / 8); }   // 手机横屏时后排贴着画面上沿：角楼压矮
    // 前面的主风车塔：八角的石塔收着腰往上，铜箍，青瓦尖顶；一根轴伸出来挂着大风车
    K.tube(Yc, M.wall, .5 * MS, .8 * MS, 1.62 * MS, tx, .02, zM, 8, PI / 8); K.tube(Yc, M.wall, .86 * MS, .9 * MS, .2 * MS, tx, .02, zM, 8, PI / 8);
    K.tube(Yc, M.brass, .56 * MS, .56 * MS, .08, tx, .02 + 1.58 * MS, zM, 8, PI / 8); K.cone(Yc, M.roofC, .76 * MS, .8 * MS, tx, .02 + 1.66 * MS, zM, 8, PI / 8); K.box(Yc, M.brass, .08, .16, .08, tx, .02 + 2.44 * MS, zM);
    K.rod(Yc, M.wood, tx, 1.4 * MS, zM + .4 * MS, tx, 1.4 * MS, zM + .8 * MS, .1);
    rotor(g, tx, 1.4 * MS, zM + .8 * MS, 1.04 * MS);
    C.up(a('gateC'), tx, .02, zM + .86 * MS, .56 * MS, false, 0, 0); G.up(a('winC'), tx, .98 * MS, zM + .6 * MS, .8, false, 0, 0); G.up(a('winC'), .06, .62 * MS, zH + .66, 1, false, 0, 0);
    for (const z of [-HD + .25, HD - .2]) { C.up(a('post'), .78, .02, z, 1, false, 0, 0); G.up(a('gemC'), .78, .62, z + .02, 1, false, 0, 0); LAMPS.push([-(HALF + 1.3) + .78, .8, z + .1, '#40f0e0', 1.3, .55, 0]); }   // 靠盘这一侧的两根灯柱：青色的灯
    C.up(a('sack'), .7, .02, HD * .72); C.up(a('sack'), .5, .02, HD * .8, 1, true); C.up(a('barrelC'), .74, .02, -.5); C.up(a('crateC'), .72, .02, zH + .9);
    pole(-.76, .76, HD * .4, .9, null, 1, C); pole(-.76, .76, -HD + .2, .8, null, 1, C);
    const F = K.Cards(g, litM, 8, { dyn: true, normal: NUP }), ba = fr('bannC'), pe = fr('pennC');                                                        // 城堡自己的旗：跟着城堡晃、沉
    g.userData.flags = f => { F.begin(); F.up(ba[f & 3], -.76 + ba[0].w / 2, 1.66 - ba[0].h * .75, HD * .4, 1, false, 0, 0); F.up(pe[(f + 1) & 3], -.76 + pe[0].w / 2, 1.56 - pe[0].h * .7, -HD + .2, 1, false, 0, 0); F.end(); };
    Yc.done(); C.end(); G.end();
    { const L = new THREE.PointLight('#40f0e0', LOOK.lamp * .6, 4.5, 2); L.position.set(1.0, 1.0, 1.4); g.add(L); }
  }

  // ———————————————————— 对面城堡（红）：飞艇码头。木栈台伸出岛沿，前面系着一只红气球，后面是红瓦的塔台 ————————————————————
  let BOB = null;
  { const g = castles[1], Yc = K.Yard(g), C = K.Cards(g, litM, 70, { normal: NUP, cast: true, receive: true }), G = K.Cards(g, glowM, 12), zB = -HD * .76, zQ = HD * .42, tx = .12;
    K.box(Yc, [M.wall, M.pave], 1.9, .12, DEPTH * .97, 0, GY, 0);                                    // 石台
    K.box(Yc, [M.wood, M.plank], 2.3, .1, DEPTH * .84, .32, .02, .08);                                 // 木栈台
    for (const z of [-HD * .7, 0, HD * .7]) K.box(Yc, M.wood, .12, .7, .12, 1.36, -.6, z);            // 伸出岛沿那一边的木桩
    const TS = SHORT ? .46 : 1;                                                                         // 手机横屏时后排贴着画面上沿：塔台压矮
    K.box(Yc, M.wall, 1.12, 1.12 * TS, 1.02, tx, .12, zB); K.box(Yc, M.plank, 1.34, .06, 1.24, tx, .12 + 1.12 * TS, zB); K.box(Yc, M.wood, .94, .86 * TS, .84, tx, .18 + 1.12 * TS, zB);   // 塔台：石头的底、一圈挑台、木头的上层
    K.cone(Yc, M.roofR, .92, .78 * TS, tx, .18 + 1.98 * TS, zB, 4, PI / 4); K.box(Yc, M.brass, .1, .16, .1, tx, .14 + 2.76 * TS, zB);   // 四坡红瓦顶
    K.box(Yc, M.awn, .84, .04, .52, tx, .1 + .88 * TS, zB + .74, 0, .5);                                // 门上的条纹遮阳篷
    K.rod(Yc, M.wood, 1.05, .12, -.25, 1.05, 1.5, -.25, .07); K.rod(Yc, M.wood, 1.1, 1.42, -.25, .4, 1.62, -.25, .06); K.rod(Yc, M.wood, .46, 1.6, -.25, .46, 1.05, -.25, .02); K.box(Yc, M.plank, .26, .24, .26, .46, .82, -.25);   // 吊杆吊着一只货箱
    K.rod(Yc, M.wood, 1.2, .12, HD * .78, 1.2, 1.5 * KS, HD * .78, .05);                               // 挂风向袋的杆
    C.up(a('gateR'), tx, .12, zB + .52, .8 * TS, false, 0, 0); C.up(a('crestR'), tx, .12 + 1.6 * TS, zB + .43, 1, false, 0, 0);
    if (!SHORT) { G.up(a('winR'), tx - .28, 1.45, zB + .43, 1, false, 0, 0); G.up(a('winR'), tx + .28, 1.45, zB + .43, 1, false, 0, 0); }
    for (const z of [-HD + .25, HD - .2]) { C.up(a('post'), -.78, .02, z, 1, false, 0, 0); G.up(a('gemR'), -.78, .62, z + .02, 1, false, 0, 0); LAMPS.push([HALF + 1.3 - .78, .8, z + .1, '#ff6858', 1.3, .55, 0]); }   // 靠盘这一侧的两根灯柱：红色的灯
    C.up(a('crateR'), -.5, .12, -.35); C.up(a('barrelR'), -.62, .12, 1.75); C.up(a('coil'), .9, .12, 1.9); C.up(a('anchor'), 1.25, .12, -1.2); C.up(a('crateR'), .95, .12, -HD * .5, .8, true);
    for (const z of [-.2, 1.0, 2.0]) C.up(a('bollard'), 1.36, .12, z * HD / 2.4, 1, false, 0, 0);
    // 红气球：整只挂在一个会起伏的组里
    const bob = new THREE.Group(); bob.position.set(.02, 0, zQ); g.add(bob); BOB = bob;
    { const Yb = K.Yard(bob), r = .8 * KS, cy = (.6 + .9 * KS); K.ball(Yb, M.balloon, r, 0, cy, 0, 1.12); K.tube(Yb, M.brass, .2 * KS, .13 * KS, .14, 0, cy - r * 1.12 - .08, 0, 8);
      K.box(Yb, M.plank, .32, .24, .32, 0, .22, 0); K.box(Yb, M.awn, .35, .07, .35, 0, .4, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { K.rod(Yb, M.wood, sx * .15, .46, sz * .15, sx * r * .55, cy - r * .78, sz * r * .55, .02); }
      K.rod(Yb, M.wood, .15, .26, .15, 1.3, .14, .5, .02); K.rod(Yb, M.wood, -.15, .26, -.1, -.7, .14, -.9, .02);     // 两道缆绳拴在栈台上
      Yb.done(); }
    const F = K.Cards(g, litM, 8, { dyn: true, normal: NUP }), ba = fr('bannR'), so = fr('sock');
    const fy = .12 + 2.2 * TS; pole(-.2, fy, zB - .2, .5, null, 1, C);
    g.userData.flags = f => { F.begin(); F.up(so[f & 3], 1.2 + so[0].w / 2, 1.5 * KS - so[0].h * .8, HD * .78, 1, false, 0, 0); F.up(ba[(f + 2) & 3], -.2 + ba[0].w / 2, fy + .5 - ba[0].h * .75, zB - .2, 1, false, 0, 0); F.end(); };
    Yc.done(); C.end(); G.end();
    { const L = new THREE.PointLight('#ff7058', LOOK.lamp * .6, 4.5, 2); L.position.set(-1.0, 1.0, 1.4); g.add(L); }
  }

  // ———————————————————— 云海：最底下一张云毯，上面两层镂空的碎云（各走各的速度），最远处一条天幕 ————————————————————
  const flatPlane = (tex, y, tile, col, cut) => { tex.repeat.set(150 / tile, 120 / tile); const m = new THREE.Mesh(new THREE.PlaneGeometry(150, 120).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ map: tex, color: col, alphaTest: cut ? .5 : 0 })); m.position.set(0, y, -42); W.add(m); return tex; };
  const seaT = flatPlane(K.tex(T.cloudSeaPix(384), { mip: true }), SEA, 18, col(LOOK.sea)), puffP = puffLayerPix(256);
  const puffA = flatPlane(K.tex(puffP), SEA + 1.5, 21, col(LOOK.sea, 1.2), true), puffB = flatPlane(K.tex(puffP), SEA + 3.1, 15, col(LOOK.sea, 1.42), true); puffB.offset.set(.37, .21);
  // 天幕：一张钉在画面顶上的远景（天色、云山、卷云）。四个角每帧按镜头重摆；它的地平线正好压在云海淡出的地方
  const curG = new THREE.BufferGeometry(), curP = new Float32Array(12); curG.setAttribute('position', new THREE.BufferAttribute(curP, 3)); curG.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2)); curG.setIndex([0, 2, 1, 1, 2, 3]);
  const CUR_H = 84, CUR_HZ = Math.round(CUR_H * .72) / CUR_H, curtain = new THREE.Mesh(curG, new THREE.MeshBasicMaterial({ map: K.tex(curtainPix(640, CUR_H, .5), { repeat: false }), alphaTest: .5, fog: false, color: col(LOOK.curtain) })); curtain.frustumCulled = false; W.add(curtain);
  // 云影板：只投影、自己不画出来的一张镂空板，慢慢从岛上空飘过
  const shadeT = K.tex(T.shadePix(128)); shadeT.repeat.set(2, 2);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(52, 52).rotateX(-PI / 2), new THREE.MeshBasicMaterial({ map: shadeT, alphaTest: .5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide })); plate.position.y = 8.5; plate.castShadow = true; plate.frustumCulled = false; W.add(plate);

  // ————————————���——————— 天上飘的 ————————————————————
  // 一朵朵云：近处的在岛的两边和脚下，远处的贴着云海；越近飘得越快
  const CLOUDS = []; { const kinds = ['cloudA', 'cloudB', 'cloudC', 'cloudE', 'cloudD', 'cloudB', 'cloudA', 'cloudE', 'cloudC', 'cloudF'];
    for (let i = 0; i < (low ? 18 : 30); i++) { const far = R(i, 71), z = 3 - far * 27, big = 1.2 + far * 1.5 + R(i, 72) * .5; CLOUDS.push({ r: a(kinds[i % kinds.length]), x: (R(i, 73) * 2 - 1) * 26, y: SEA + .9 + R(i, 74) * (z > -6 ? 2.6 : 3.4) + (z < -8 && i % 5 === 0 ? 2.2 : 0), z, s: big, v: .34 - far * .24, flip: R(i, 75) > .5 }); } }
  const FAR = [['farIsleC', -13, -4.4, -21, 1.5], ['farIsleA', 7.5, -5.0, -24, 1.4], ['farIsleB', -4.5, -4.9, -25.5, 1.5], ['farIsleB', 15, -4.3, -19, 1.3], ['farIsleA', -19, -4.6, -17, 1.2]].map(([n, x, y, z, s], i) => ({ r: a(n), x, y, z, s, ph: i * 1.7 }));   // 远处的浮岛
  const SHIPS = [{ f: [a('ship0'), a('ship1')], x: -12, y: -3.9, z: -20, v: .32, s: 1.2 }, { f: [a('shipB0'), a('shipB1')], x: 9, y: -3.2, z: -11.5, v: -.2, s: 1 }];                                                           // 远处慢慢开过去的飞艇
  const BALLOONS = [['balloonA', -10.5, -2.7, -13.5], ['balloonB', 2.5, -4.6, -21], ['balloonC', -3.4, -4.3, -17.5], ['balloonA', 12.5, -4.2, -16], ['balloonB', -16.5, -3.9, -15]].map(([n, x, y, z], i) => ({ r: a(n), x, y, z, ph: i * 2.3 }));
  const BIRDS = Array.from({ length: low ? 5 : 9 }, (_, i) => ({ ph: R(i, 81) * 6.28, r: .8 + R(i, 82) * 1.6, h: R(i, 83) * .8, v: .5 + R(i, 84) * .25 })), birdF = [a('bird0'), a('bird1'), a('bird2'), a('bird1')], farBird = [a('birdFar0'), a('birdFar1')];
  const DRIFT = Array.from({ length: low ? 22 : 44 }, (_, i) => ({ r: a(['petal0', 'petal1', 'seed', 'leaf', 'petal0', 'seed'][i % 6]), x: R(i, 91) * 16, y: .35 + R(i, 92) * 2.5, z: -5 + R(i, 93) * 8.5, v: .5 + R(i, 94) * .7, ph: R(i, 95) * 6.28 }));                // 横着飘过去的花瓣、蒲公英籽、叶子
  const KITES = [{ r: a('kite0'), ax: fx(-2.9), az: fz(-3.6), x: fx(-.9), y: 2.25, z: fz(-3.2), ph: 0 }, { r: a('kite1'), ax: fx(1.65), az: fz(-3.6), x: fx(3.25), y: 1.85, z: fz(-3.0), ph: 2 }, { r: a('kite2'), ax: IA[0] + 1.6, az: IA[2] + .2, ay: IA[1], x: IA[0] + 3.6, y: IA[1] + 2.0, z: IA[2] + .6, ph: 4 }];
  const bows = [a('bowA'), a('bowB'), a('bowC')], strm = fr('strmC'), mills = fr('millSail'), vanes = [a('vane0'), a('vane1')], smokes = [a('smoke0'), a('smoke1')], chime = a('chime'), rope = a('rope'), white = a('white');
  const WISPS = Array.from({ length: low ? 4 : 7 }, (_, i) => ({ x: R(i, 101) * 2.6, y: i < 5 ? -.72 + R(i, 102) * .34 : .78 + R(i, 102) * .2, w: .5 + R(i, 103) * .5, v: .012 + R(i, 104) * .02, a: .34 + R(i, 105) * .3 }));   // 贴着镜头飘过去的云丝（下沿多，顶上两缕）
  const fgRail = a('fgRail'), fgPole = a('fgPole'), fgFlag = fr('fgFlag'), fgPost = a('fgPost');

  LIT.end(); GLOW.end(); Y.done();
  const POINTS = low ? [] : LAMPS.filter(l => l[6] > 0).slice(0, 5).map(l => { const p = new THREE.PointLight(l[3], LOOK.lamp * l[5], 4.2, 2); p.position.set(l[0], l[1], l[2] + .15); W.add(p); return p; });

  // ———————————————————— 后期 ————————————————————
  post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
  { const tl = SHORT ? LOOK.tiltShort : LOOK.tilt; for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = tl.focus; p.uniforms.band.value = tl.band; p.uniforms.amt.value = tl.amt; } }
  { const u = post.grade.uniforms, g = LOOK.grade; u.sat.value = g.sat; u.con.value = g.con; u.knee.value = g.knee; u.gain.value.setRGB(...g.gain); u.lift.value.setRGB(...g.lift); u.edge.value.setRGB(...g.edge); post.grade.enabled = true; }

  // ———————————————————— 每帧 ————————————————————
  const v = new THREE.Vector3(), cp = new THREE.Vector3(), fw = new THREE.Vector3(), q = new Float32Array(12), wrap = (x, span) => ((x % span) + span) % span;
  // 画面上的一个点（-1..1）、离镜头 D 远，是场景里的哪儿
  const corner = (nx, ny, D, out, o) => { v.set(nx, ny, .5).unproject(camera).sub(cp); const k = D / v.dot(fw); out[o] = cp.x + v.x * k; out[o + 1] = cp.y + v.y * k; out[o + 2] = cp.z + v.z * k; };
  // 把一张片按画面位置贴上去：左下角 (x0, y0)、右上角 (x1, y1)
  const screen = (L, r, x0, y0, x1, y1, D, flip) => { corner(x0, y1, D, q, 0); corner(x1, y1, D, q, 3); corner(x0, y0, D, q, 6); corner(x1, y0, D, q, 9); L.quad(r, q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8], q[9], q[10], q[11], flip); };
  let last = 0;
  function tick(t) {
    last = t; const f = Math.floor(t * 8), asp = camera.aspect;                              // f：像素动画按每秒 8 拍走
    camera.updateMatrixWorld(); cp.setFromMatrixPosition(camera.matrixWorld); camera.getWorldDirection(fw); K.aim(camera);
    // 天幕和雾：先找“地平线”那条视线落在云海上的地方，天幕就立在那儿，雾也正好在那儿淡到底
    { const yH = 1 - 2 * LOOK.skyline; v.set(0, yH - .03, .5).unproject(camera).sub(cp); const k = (SEA - cp.y) / v.y, DC = Math.min(150, v.dot(fw) * k), dist = v.length() * k, yT = 1.03, yB = yT - (yT - yH) / CUR_HZ;
      corner(-1.03, yT, DC, curP, 0); corner(1.03, yT, DC, curP, 3); corner(-1.03, yB, DC, curP, 6); corner(1.03, yB, DC, curP, 9); curG.attributes.position.needsUpdate = true;
      scene.fog.far = dist * .99; scene.fog.near = Math.min(dist * .55, cp.distanceTo(W.position) + 7); }
    // 云海各层、云影板、瀑布
    seaT.offset.x = -t * .012; puffA.offset.x = -t * .022; puffB.offset.x = .37 - t * .04; plate.position.x = -13 + wrap(t * .32, 26); M.fall.map.offset.y = (f % 16) / 16;
    // 风车、气球
    for (const [g, sp] of ROTORS) g.rotation.z = .62 - t * sp;      // 起手就斜着：「减少动态效果」时停在这个角度，也还是个风车的样子
    BOB.position.y = Math.sin(t * .9) * .045; BOB.rotation.z = Math.sin(t * .6) * .025; BOB.rotation.x = Math.sin(t * .47 + 1) * .02;
    castles[0].userData.flags(f); castles[1].userData.flags(f);

    // —— 吃光的、会动的小件 ——
    LIVE.begin();
    for (const g of GRASS) LIVE.up(g.r, g.x, GY, g.z, 1, g.flip, (Math.round(Math.sin(f * .42 + g.ph) * 2) / 2 + .6) * .035);          // 草和花顺着风一下一下地歪
    for (const F of FLAGS) { const r = F.f[(f + F.k * 3) & 3]; LIVE.up(r, F.x + r.w * F.s / 2, F.y - r.h * F.s * .75, F.z, F.s, false, 0, 0); }
    KITES.forEach((k, i) => { const x = k.x + Math.sin(t * .7 + k.ph) * .3, y = k.y + Math.sin(t * 1.1 + k.ph) * .14, z = k.z, ay = k.ay ?? GY;   // 风筝：线从地上牵上去，线上系着一串蝴蝶结
      LIVE.line(rope, k.ax, ay + .3, k.az, x - .1, y - .25, z, .022); LIVE.face(k.r, x, y, z, 1, -.35 + Math.sin(t * .9 + k.ph) * .14);
      for (let j = 1; j <= 4; j++) LIVE.face(bows[(i + j) % 3], x - .1 - j * .13 + Math.sin(t * 2 + j + k.ph) * .04, y - .25 - j * .16, z, 1, Math.sin(f * .8 + j) * .5); });
    LIVE.up(mills[f & 3], MILL[0], MILL[1] - mills[0].h / 2, MILL[2] + .12, 1, false, 0, 0);                                           // 磨坊岛的小风车
    LIVE.up(vanes[(f >> 2) & 1], fx(-.6), GY + .5, fz(-4.05), 1, false, 0, 0); LIVE.hang(chime, fx(-3.75), GY + 1.42, fz(-4.15), 1, false, Math.sin(t * 2.2) * .05);   // 井上的风向标、拱门下的风铃
    { const r = strm[(f + 1) & 3]; LIVE.up(r, BEACON[0] + r.w * .4, BEACON[1] + .2, BEACON[2], .8, false, 0, 0); }                    // 灯塔顶上的长飘带
    LIVE.end();

    // —— 天上的 ——
    AIR.begin();
    for (const c of CLOUDS) AIR.up(c.r, wrap(c.x + t * c.v + 30, 60) - 30, c.y, c.z, c.s, c.flip, 0, .1);
    for (const o of FAR) AIR.up(o.r, o.x, o.y + Math.sin(t * .3 + o.ph) * .12, o.z, o.s);
    for (const s of SHIPS) AIR.up(s.f[f & 1], wrap(s.x + t * s.v + 26, 52) - 26, s.y + Math.sin(t * .5 + s.z) * .1, s.z, s.s, s.v < 0, 0, .05);
    for (const b of BALLOONS) AIR.up(b.r, b.x + Math.sin(t * .13 + b.ph) * .8, b.y + Math.sin(t * .45 + b.ph) * .22, b.z, 1.2, false, 0, .05);
    BIRDS.forEach((b, i) => { const an = t * b.v + b.ph, x = fx(-4.6) + Math.cos(an) * (2.2 + b.r), z = fz(-6.5) + Math.sin(an) * 1.4; AIR.face(birdF[(f + i) & 3], x, 1.1 + b.h + Math.sin(an * 2) * .2, z, 1, 0, Math.sin(an) > 0); });   // 一群海鸥在左后方的天上打圈
    for (let i = 0; i < 7; i++) AIR.up(farBird[(f + i) >> 1 & 1], wrap(-9 + t * .5 + 24, 48) - 24 + (i - 3) * .55, -3.4 - Math.abs(i - 3) * .22, -16, 1.5);                    // 远处一排人字形的鸟
    for (const d of DRIFT) AIR.face(d.r, wrap(d.x + t * d.v, 16) - 8, d.y + Math.sin(t * 1.3 + d.ph) * .22 - wrap(t * .07 + d.ph, .8), d.z + Math.sin(t * .6 + d.ph) * .3, 1, t * 1.5 + d.ph);
    for (let i = 0; i < 4; i++) { const u = wrap(t * .28 + i / 4, 1); AIR.face(smokes[i & 1], SMOKE[0] + u * .7, SMOKE[1] + u * .9, SMOKE[2], .7 + u * .9); }                  // 小屋烟囱的烟
    for (const [x, y, z, w] of FALLS) for (let i = 0; i < 5; i++) { const u = wrap(t * .9 + i / 5, 1); AIR.face(white, x + (R(i, 111) - .5) * w * 2 * u, y + 1.6 - u * u * 1.8 + u * .6, z + .1, 1.5); }   // 瀑布脚下溅起来的水点
    AIR.end();

    // —— 叠加的软光：灯晕、水晶的辉光、灯塔的闪光、斜下来的光柱 ——
    SOFT.begin();
    for (const l of LAMPS) { const c = l[3], k = l[6] === 2 ? Math.max(.12, Math.sin(t * 1.6) ** 9 * 1.1) : l[6] === 1 ? .82 + Math.sin(t * 9 + l[0] * 5) * .1 : .8 + Math.sin(t * 1.8 + l[2]) * .2;
      SOFT.tint(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255, l[5] * k * .38).face(S.halo, l[0], l[1], l[2], l[4] * (l[6] === 2 ? 1 + k : 1));
      if (l[6] === 2 && k > .5) SOFT.face(S.star, l[0], l[1], l[2], 1.5 * k); }
    for (const s of SPOTS) SOFT.tint(.25, 1, .95, .2 + Math.sin(t * 1.4 + s[4]) * .1).face(S.halo, s[0], s[1], s[2], s[3]);
    for (let i = 0; i < 5; i++) SOFT.tint(1, .74, .42, .03 + Math.sin(t * .5 + i * 1.7) * .012).face(S.ray, fx(-5.2 + i * 2.3), 1.2 + (i % 2) * .5, fz(-3.6 - (i % 3) * .5), 3.4 + (i % 2), .52, false, 1.5);
    SOFT.tint(1, .7, .38, .04); screen(SOFT, S.halo, -1.5, .3, -.4, 1.6, 30);                                                           // 太阳那一角的一大团暖晕
    SOFT.end();

    // —— 盖上去的软片：瀑布落进云里的水雾、彩虹、贴镜头的云丝 ——
    HAZE.begin();
    FALLS.forEach(([x, y, z, w], j) => { for (let i = 0; i < 5; i++) { const u = wrap(t * .16 + i / 5 + j * .3, 1); HAZE.tint(.4, .54, .8, (1 - u) * .36).face(S.mist, x + (R(i, 121 + j) - .5) * 1.2 * u, y + .1 + u * .9, z + .15, 1 + u * 2.2); } });
    HAZE.tint(1, 1, 1, .22).face(S.rainbow, IA[0] + 1.5, IA[1] - 1.2, IA[2] + 1.2, 1.1);
    for (const w of WISPS) { const x = wrap(w.x + t * w.v, 2.6) - 1.3, hgt = w.w * .26 * asp; HAZE.tint(.34, .44, .68, w.a * .28); screen(HAZE, S.wisp, x - w.w / 2, w.y - hgt / 2, x + w.w / 2, w.y + hgt / 2, 9); }
    HAZE.end();

    // —— 前景剪影：左下角一段栏杆和一根挂旗的高杆，右下角一段栏杆 ——
    FG.begin();
    { const h = .17, k = h / fgRail.h / asp; screen(FG, fgRail, -1.02, -1.01, -1.02 + fgRail.w * k, -1.01 + h, 8); screen(FG, fgRail, 1.03 - fgRail.w * k, -1.01, 1.03, -1.01 + h * .9, 8, true);
      const px = -.955, pw = fgPole.w * k; for (let i = 0; i < 5; i++) screen(FG, fgPole, px, -1.01 + h * .8 + i * fgPole.h * k * asp, px + pw, -1.01 + h * .8 + (i + 1) * fgPole.h * k * asp, 8);
      const top = -1.01 + h * .8 + 5 * fgPole.h * k * asp, r = fgFlag[f & 3]; screen(FG, r, px + pw, top - r.h * k * asp, px + pw + r.w * k, top, 8); }
    FG.end();
  }

  const again = () => requestAnimationFrame(() => tick(last));     // 镜头是搭完之后才摆的、窗口大小也会变：补摆一次（「减少动态效果」时游戏不调 tick，全靠这个）
  addEventListener('resize', again); again(); setTimeout(again, 400);
  scene.updateMatrixWorld(true); tick(0);
  return { tick };
}
