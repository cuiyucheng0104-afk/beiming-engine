// 第四章 新作品（第 49–61 小节，96–122 s）。分镜与全部自定决定：notes/ch4.md。接口：ARCH.md §4。
// 跨页 6「奇谭夜」：纸塔从书缝弹起 → 鲸鱼卡片沿弧形纸轨滑过塔顶（中国奇谭）→ 塔上四扇窗四拍依次打开亮灯（中国奇谭 2）
// → 纸森林从书缝升起、浪浪山卡片立在林中 → 第 58 小节第 4 拍全黑全静 → 第 59 小节第 1 拍台灯转向打亮燃比娃，宣纸折扇展开成光芒。
// 本章所有立体件都"从书缝里升起"（塔比书页还高，扣倒放不下），只有两块标题牌是向前扣倒再立起的。
// 需求：无（共用层不需要改动）。
import { at, KEY, FPS } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';
import { clamp, lerp, seg, ss, eo, eio, back, monotone } from '/core/lib.js';
import * as AR from './ch4_art.js';

export const ID = 'ch4';
const PG = .023, Y0 = PG + .0003;           // 跨页 root 原点的世界 y（书页摊平时 root = 世界坐标平移）
const F1 = 1 / FPS;
const TX = TEXT.ch4;

// ———————————————— 时刻（画面落点；声音用 events() 的 id 引用）————————————————
const T = {
  tiers: [at(49, 2), at(49, 3), at(49, 4), at(50, 1)],          // 96.5 / 97 / 97.5 / 98：塔一层一层弹出
  rail: at(50, 3),                                               // 99.0 弧轨到位
  go: KEY.ch4.whale, apex: at(51, 4), land: at(52, 4),          // 100 起步 / 101.5 塔顶 / 103.5 落定
  plateA: at(50, 3),                                             // 99.0 标题牌「中国奇谭」立起（返修：从 100.0 提前一拍半，镜头上摇前留足 1.8 s 读）
  stamp: KEY.ch4.windows,                                        // 104 盖「2」
  wins: [at(53, 2), at(53, 3), at(53, 4), at(54, 1)],           // 104.5 / 105 / 105.5 / 106 四扇窗
  forest: KEY.ch4.forest, langlang: at(56, 2), front: at(56, 3), // 110 / 110.5 / 111
  dark: KEY.ch4.silence, peak: KEY.ch4.peak,                     // 115.5 全黑全静 / 116 最强
  fold: at(61, 3), foldFan: at(61, 3, 2), foldEnd: at(61, 4),    // 返修：121.0 起收布景（折扇先合 → 纸塔逐层下压 → 牌子倒伏），121.5 收完，书页接着翻起
};
// 收折时刻表（返修）：[起, 止]
const FOLD = {
  fan: [T.fold, T.foldFan], rail: [T.fold, T.foldFan], rb: [T.fold + .1, T.fold + .35], plate: [T.fold + .2, T.fold + .4], forest: [T.fold + .15, T.fold + .45],
  tiers: [0, 1, 2, 3].map(k => [T.foldEnd - .09 * k - .23, T.foldEnd - .09 * k]),   // 塔顶先压（121.0–121.23），塔基最后（121.27–121.5）
};

// ———————————————— 布局（跨页 root 坐标：原点 = 书页中心，x 右、y 上、z 朝镜头；书页 x ±.236、z ±.137）————————————————
const TOWER_X = .055;
const TIERS = [
  { z: .008, v: .12, kind: 'base', ww: .19, ow: .214, h: .045, roof: [.031, .045], cols: [] },
  { z: -.018, v: .2, kind: 'body', ww: .16, ow: .19, h: .125, roof: [.108, .125], cols: [-.077, 0, .077], wins: [{ x: -.042, y: .084, s: .038 }, { x: .042, y: .084, s: .038 }] },
  { z: -.042, v: .2, kind: 'body', ww: .13, ow: .162, h: .2, roof: [.183, .2], cols: [-.062, 0, .062], wins: [{ x: -.034, y: .160, s: .038 }, { x: .034, y: .160, s: .038 }] },
  { z: -.066, v: .16, kind: 'top', ww: .085, ow: .13, h: .257, roof: [.204, .228], wallBot: .19, wallTop: .208, spire: [.228, .257] },
];
const WIN_ORDER = [[1, 0], [1, 1], [2, 0], [2, 1]];             // 左下 → 右下 → 左上 → 右上
const WIN_FILES = ['P13_中国奇谭2_如何成为三条龙.png', 'P13_中国奇谭2_耳中人.png', 'P13_中国奇谭2_小雪.png', 'P13_中国奇谭2_大贵人.png'];
// 弧轨：中线 P(φ) = (a cosφ, y0 + b sinφ)，挂在塔后的切缝里
const RAIL = { x: TOWER_X, z: -.093, a: .18, b: .255, y0: .02, rw: .012, phi0: 168 * Math.PI / 180, phi1: 12 * Math.PI / 180 };
const FOREST = [
  { kind: 'far', x0: -.236, x1: .236, z: .014, hm: .11, seed: 3 },
  { kind: 'mid', x0: -.236, x1: -.146, z: .046, hm: .078, seed: 5 },
  { kind: 'mid', x0: .03, x1: .236, z: .046, hm: .072, seed: 8 },
  { kind: 'front', x0: -.236, x1: .236, z: .118, hm: .032, seed: 11 },
];
const LL = { x: -.06, z: .056, h: .082 };                        // 浪浪山卡片（从书缝升起）
const RB = { x: .068, z: .064, h: .116 };                         // 燃比娃卡片（从书缝升起）
const PLATE_A = { x: -.138, z: .066, w: .19, h: .058 };         // 左前标题牌：中国奇谭 → 中国奇谭 2 → 燃比娃
const PLATE_B = { x: .142, z: .07, w: .15, h: .058 };            // 右前标题牌：浪浪山小妖怪
const LEAN = .35;                                                 // 标题牌立起后后仰（弧度）

// 弧长参数化：u ∈ [0,1] → φ
const arcTable = (() => { const N = 400, L = [0]; let s = 0, pp = null;
  for (let i = 0; i <= N; i++) { const phi = RAIL.phi0 + (RAIL.phi1 - RAIL.phi0) * i / N, p = [RAIL.a * Math.cos(phi), RAIL.y0 + RAIL.b * Math.sin(phi)]; if (pp) { s += Math.hypot(p[0] - pp[0], p[1] - pp[1]); L.push(s); } pp = p; }
  return { N, L, len: s }; })();
function phiAt(u) { const { N, L, len } = arcTable, s = clamp(u) * len; let i = 0; while (i < N - 1 && L[i + 1] < s) i++;
  const f = (s - L[i]) / Math.max(1e-9, L[i + 1] - L[i]); return RAIL.phi0 + (RAIL.phi1 - RAIL.phi0) * (i + f) / N; }
RAIL.phiAt = phiAt; RAIL.len = arcTable.len;
// 鲸鱼在轨上的进度：起步加速 → 塔顶减速悬停 → 滑到右端
const whaleS = monotone([[T.go, 0], [T.apex, .47], [T.apex + 1, .56], [T.land, 1]]);
const U0 = .035, U1 = .9;

// ———————————————— 相机：[全片秒, camKey(fov, 仰角, 方位, tx, ty, tz, 可视高)]（目标点是世界坐标）————————————————
export const camera = [
  [96.6, camKey(26, 30, 6, .04, PG + .06, -.01, .31)],
  [97.6, camKey(25, 20, 2, .05, PG + .1, -.02, .32)],
  [98.6, camKey(25, 12, -4, .05, PG + .14, -.03, .35)],
  [99.5, camKey(24, 11, -10, .0, PG + .155, -.05, .37)],
  [100.85, camKey(24, 14, -10, -.05, PG + .13, -.03, .36)],      // 返修：在牌子上多停 0.45 s，再上摇看鲸鱼到塔顶
  [101.6, camKey(22, 8, -5, .06, PG + .285, -.08, .21)],
  [102.6, camKey(22, 8, 2, .085, PG + .28, -.08, .21)],
  [103.8, camKey(24, 13, 7, .03, PG + .13, -.04, .3)],
  [104.6, camKey(24, 14, 5, -.035, PG + .11, -.02, .29)],
  [107.0, camKey(23, 13, -2, -.03, PG + .11, -.02, .28)],
  [109.4, camKey(23, 12, -8, -.03, PG + .105, -.015, .285)],
  [110.6, camKey(26, 8, -14, .0, PG + .07, .02, .26)],
  [113.0, camKey(25, 7, -4, .005, PG + .068, .025, .25)],
  [115.2, camKey(25, 7, 6, .01, PG + .066, .03, .245)],
  [115.95, camKey(27, 10, 10, .0, PG + .075, .03, .3)],
  [116.7, camKey(24, 9, 4, -.025, PG + .074, .05, .245)],
  [119.4, camKey(24, 11, -6, -.025, PG + .08, .05, .25)],
  [121.0, camKey(27, 22, -2, -.02, PG + .065, .0, .34)],
];
// 台灯：115.467 起 0.1 s 熄到 3%（无声，全静一拍）；115.967 起 0.12 s 转向 16°、对准燃比娃、亮度冲到 1.5（共用层自动配开关 + 电流 + 关节）；116.6 起 1.4 s 回到 1.0（无声）
export const lamp = [
  { t: T.dark - F1, dur: .1, dim: .03, env: .12, sound: false },
  { t: T.peak - F1, dur: .07, dim: 1.5, env: .55, yaw: 16, aim: [RB.x, Y0 + .062, RB.z] },
  { t: T.peak + .6, dur: 1.4, dim: 1.0, env: 1.0, sound: false },
];

export function events() {
  const E = [];
  T.tiers.forEach((t, i) => E.push({ t, type: 'pop_up', id: `ch4.tower.${i}`, sfx: true }));
  E.push({ t: T.rail, type: 'rail_up', id: 'ch4.rail', sfx: true });
  E.push({ t: T.go, type: 'move', id: 'ch4.whale.go', sfx: true });
  E.push({ t: T.plateA, type: 'card_up', id: 'ch4.plate.a', sfx: true });
  E.push({ t: T.apex, type: 'mark', id: 'ch4.whale.apex', sfx: true });
  E.push({ t: T.land, type: 'land', id: 'ch4.whale.land', sfx: true });
  E.push({ t: T.stamp, type: 'stamp', id: 'ch4.stamp', sfx: true });
  T.wins.forEach((t, i) => E.push({ t, type: 'window', id: `ch4.win.${i}`, sfx: true }));
  E.push({ t: T.forest, type: 'rise', id: 'ch4.forest', sfx: true });
  E.push({ t: T.langlang, type: 'card_up', id: 'ch4.langlang', sfx: true });
  E.push({ t: T.front, type: 'rise', id: 'ch4.forest.front', sfx: true });
  E.push({ t: T.dark, type: 'silence', id: 'ch4.silence', until: T.peak });
  E.push({ t: T.peak, type: 'peak', id: 'ch4.peak', sfx: true });
  E.push({ t: T.foldFan, type: 'fold', id: 'ch4.fold.fan', sfx: true }, { t: T.fold, type: 'fold', id: 'ch4.fold.tower', sfx: true }, { t: T.foldEnd, type: 'fold', id: 'ch4.fold.end', sfx: true });
  return E;
}

// ———————————————— 搭建 ————————————————
let S6, K, THREE;
const tiers = [], wins = [], forest = [];
let rail, whale, llRise, llCard, rbRise, rbCard, fan, blades = [], plateA, plateB, spotRB, ctxRef;
export async function build(ctx) {
  ctxRef = ctx; K = ctx.kit; THREE = ctx.THREE; S6 = ctx.book.spread(6);
  const R = S6.root;
  S6.autoFold = false;   // 返修：本章自己收折（121.0–121.5），不用共用层在 3 帧内把整套布景压扁
  const img = f => K.img('ch4/' + f);
  const [whaleImg, llImg, rbImg, xuan, ...winImgs] = await Promise.all([img('P12_中国奇谭_鲸鱼主视觉.png'), img('P14_浪浪山小妖怪_海报.png'), img('P15_燃比娃_宣纸手绘.png'), K.img('宣纸.png'), ...WIN_FILES.map(img)]);

  // 书页美术
  const slits = [
    ...TIERS.map(s => [TOWER_X - s.ww / 2 + .004, TOWER_X + s.ww / 2 - .004, s.z]),
    [TOWER_X - RAIL.a - .01, TOWER_X + RAIL.a + .01, RAIL.z],
    ...FOREST.map(f => [f.x0 + .016, f.x1 - .016, f.z]),
    [LL.x - .07, LL.x + .07, LL.z], [RB.x - .1, RB.x + .1, RB.z],
  ];
  S6.setFloor(AR.floorArt({ tower: [TOWER_X, -.03], slits }));
  S6.setBackdrop(AR.backdropArt());

  // —— 纸塔：四层，每层一对 V 形翼（中缝朝镜头凸出），挂窗 ——
  TIERS.forEach((s, k) => {
    const a = AR.tierArt(s, 10 + k), [cl, cr] = AR.halves(a.c);
    const g = new THREE.Group(); g.position.set(TOWER_X, 0, s.z);
    const wl = K.cutPiece(cl, a.w / 2, a.h, { ax: 1 }), wr = K.cutPiece(cr, a.w / 2, a.h, { ax: 0 });
    g.add(wl, wr); R.add(g);
    tiers.push({ g, wl, wr, s, H: a.h + .004 });
  });
  WIN_ORDER.forEach(([k, j], i) => {
    const s = TIERS[k], wn = s.wins[j], wing = j === 0 ? tiers[k].wl : tiers[k].wr;
    const g = new THREE.Group(); g.position.set(wn.x, wn.y - wn.s / 2, 0); wing.add(g);
    const card = K.card(winImgs[i], { h: wn.s, border: .05 }); card.position.set(0, 0, .0012); g.add(card);
    const sw = .0215, sh = wn.s + .0003, sa = AR.shutterArt(sw, sh, -1), sb = AR.shutterArt(sw, sh, 1);   // 返修：窗门下沿抬到片名纸签上沿，开门后不再挡住签上的字
    const shL = doubleShutter(sa, AR.shutterBackArt(sw, sh), 0), shR = doubleShutter(sb, AR.shutterBackArt(sw, sh), 1);
    const pm = 24 / AR.PX; shL.position.set(-(sa.w - pm), .0024, .0024); shR.position.set(sb.w - pm, .0024, .0024); g.add(shL, shR);
    const ta = AR.tagArt(TX.qitan2.windows[i]), tag = K.cutPiece(ta.c, ta.w, ta.h, { ay: 1 });
    tag.position.set(0, .0024, .0008); g.add(tag);
    const light = new THREE.PointLight('#ffc274', 0, .1, 2); light.position.set(0, wn.s / 2, .02); g.add(light);
    wins.push({ g, card, shL, shR, tag, ta, light, t: T.wins[i], text: TX.qitan2.windows[i] });
  });

  // —— 弧形纸轨 + 鲸鱼卡片 ——
  const ra = AR.railArt(RAIL);
  rail = new THREE.Group(); rail.position.set(RAIL.x, 0, RAIL.z); R.add(rail);
  const railPiece = K.cutPiece(ra.c, ra.w, ra.h); rail.add(railPiece);
  whale = K.card(whaleImg, { h: .066 }); rail.add(whale);

  // —— 森林 ——
  FOREST.forEach(f => { const a = AR.forestArt(f.kind, f.x0, f.x1, f.hm, f.seed), g = K.cutPiece(a.c, a.w, a.h, { ax: a.ax }); g.position.set(0, 0, f.z); R.add(g); forest.push({ ...f, g, H: a.h + .004 }); });
  llRise = new THREE.Group(); llRise.position.set(LL.x, 0, LL.z); R.add(llRise);
  llCard = K.card(llImg, { h: LL.h }); llRise.add(llCard);

  // —— 燃比娃：卡片 + 身后的宣纸折扇（一起从书缝升起）+ 一盏跟着台灯的窄光 ——
  rbRise = new THREE.Group(); rbRise.position.set(RB.x, 0, RB.z); R.add(rbRise);
  rbCard = K.card(rbImg, { h: RB.h }); rbRise.add(rbCard);
  fan = new THREE.Group(); fan.position.set(0, .006, -.009); rbRise.add(fan);
  const NB = 15;
  for (let i = 0; i < NB; i++) {
    const b = AR.bladeArt(.2, .036, i, xuan), m = K.cutPiece(b.c, b.w, b.h); m.position.y = -b.padM;
    const pv = new THREE.Group(); pv.add(m); pv.position.z = -.0007 * (i % 3); fan.add(pv);
    const f = i / (NB - 1) * 2 - 1;
    blades.push({ pv, fin: -f * 74 * Math.PI / 180, start: (f < 0 ? 1 : -1) * 1.64, delay: Math.abs(f) * .03 + (i % 2) * .008 });
  }
  spotRB = new THREE.SpotLight('#ffbf73', 0, 0, .17, .75, 1.6); spotRB.castShadow = false;
  ctx.root.add(spotRB, spotRB.target);

  // —— 标题牌 ——
  plateA = makePlate(PLATE_A); plateB = makePlate(PLATE_B);
  plateB.set({ title: TX.langlang.title, sub: TX.langlang.sub });
}
// 窗门：正面窗棂、背面朱红内板（两张背靠背的纸片，开门后从侧面看也不是白纸）
function doubleShutter(front, backArt, ax) {
  const g = new THREE.Group(), f = K.cutPiece(front.c, front.w, front.h, { ax }), b = K.cutPiece(backArt.c, backArt.w, backArt.h, { ax: 1 - ax });
  b.rotation.y = Math.PI; b.position.z = -.0004; g.add(f, b); return g;
}
function makePlate(P) {
  const pc = AR.placard(P.w, P.h); pc.draw({ title: '', sub: '' });
  const g = K.cutPiece(pc.c, pc.w, pc.h); g.position.set(P.x, 0, P.z); S6.root.add(g);
  let key = null;
  return { g, pc, P, cur: null, set(o) { const k = JSON.stringify(o); if (k === key) return; key = k; pc.draw(o); g.userData.tex.needsUpdate = true; this.cur = o; } };
}

// ———————————————— 每帧 ————————————————
const popEnd = (t, tb, d) => { const p = K.popAt(t, tb, d); return p; };
// 从书缝升起：落在 tb（第一次到位），向上小幅过冲（≤ cap 米），然后落定
function riseY(t, tb, H, d = .5, cap = .003) { const p = popEnd(t, tb, d); return p <= 1 ? -H * (1 - p) : cap * Math.min(1, (p - 1) / .1); }
function sinkY(t, t0, t1, H) { return -H * ss(seg(t, t0, t1)); }
const sway = (t, ph, a = .01) => a * (Math.sin(t * 1.7 + ph) * .7 + Math.sin(t * 2.9 + ph * 1.7) * .3);

export function update(t, ctx) {
  // 纸塔
  tiers.forEach((tr, k) => {
    const tb = T.tiers[k], p = clamp(popEnd(t, tb, .5), 0, 1.3), fd = ss(seg(t, ...FOLD.tiers[k]));   // fd：收折（返修，塔顶先压回书缝）
    tr.g.position.y = fd > 0 ? Math.min(riseY(t, tb, tr.H, .5, .0025), -tr.H * fd) : riseY(t, tb, tr.H, .5, .0025);
    tr.g.visible = t > tb - .6 && fd < .999;
    const v = tr.s.v * (p <= 1 ? ss(p) : 1 + (p - 1) * 1.5) * (1 - .8 * fd);
    tr.wl.rotation.y = -v; tr.wr.rotation.y = v;
  });
  // 四扇窗
  wins.forEach((w, i) => {
    const p = popEnd(t, w.t, .42), a = 1.62 * Math.max(0, p);
    w.shL.rotation.y = -a; w.shR.rotation.y = a;
    const pt = popEnd(t, w.t + .04, .4); w.tag.rotation.x = Math.PI / 2 * (1 - Math.max(0, pt));
    const on = eo(seg(t, w.t - F1, w.t + .2)), flick = 1 + .06 * Math.sin(t * 9.3 + i * 2) * Math.sin(t * 3.1 + i);
    const darkK = 1 - .45 * ss(seg(t, T.dark - F1, T.dark + .1)) * (1 - ss(seg(t, T.peak, T.peak + 1.5)));
    w.light.intensity = .0016 * on * flick * darkK * (1 - ss(seg(t, FOLD.tiers[WIN_ORDER[i][0]][0], FOLD.tiers[WIN_ORDER[i][0]][0] + .12)));
  });
  // 弧轨升起（98.5 起，99.0 到位）+ 鲸鱼
  { const fr = ss(seg(t, ...FOLD.rail)); rail.position.y = fr > 0 ? Math.min(riseY(t, T.rail, .32, .7, .002), -.32 * fr) : riseY(t, T.rail, .32, .7, .002);
    rail.visible = t > T.rail - 1 && fr < .999; }
  const s = t < T.go ? 0 : whaleS(t), u = lerp(U0, U1, s), phi = phiAt(u);
  const px = RAIL.a * Math.cos(phi), py = RAIL.y0 + RAIL.b * Math.sin(phi), tx = RAIL.a * Math.sin(phi), ty = -RAIL.b * Math.cos(phi), L = Math.hypot(tx, ty);
  const nx = ty / L * -1, ny = tx / L;   // 外法线（朝上）
  const off = RAIL.rw / 2 + .0005;
  const ang = Math.atan2(ty, tx), bank = clamp(ang * .42, -.38, .38);
  const settle = t > T.land ? .05 * Math.sin(Math.PI * 2 * seg(t, T.land, T.land + .5) * 1.5) * (1 - seg(t, T.land, T.land + .5)) : 0;
  const bob = t > T.land + .5 ? .012 * Math.sin((t - T.land) * 2.1) : 0;
  whale.position.set(px + nx * off, py + ny * off, .004); whale.rotation.z = bank + settle + bob;
  // 标题牌 A：100 立起（中国奇谭）→ 104 盖「2」+ 刷字 → 110 向前扣倒 → 116 带着「燃比娃」重新立起
  if (t < 112) {
    const p1 = popEnd(t, T.plateA, .62), down = ss(seg(t, T.forest - .32, T.forest));
    plateA.g.rotation.x = lerp(Math.PI / 2 * (1 - p1) - LEAN * clamp(p1, 0, 1.2), Math.PI / 2, down);
    // 返修：第 53 小节换字 = 103.6–103.85 先把标题和小字一起擦掉 → 103.86–104.0 标题与朱红「2」一起落定 → 104.0–104.35 刷出新小字（不再出现「中国奇谭 2」配旧小字的帧）
    const E0 = T.stamp - .4, E1 = T.stamp - .15;
    if (t < E0) plateA.set({ title: TX.qitan.title, sub: TX.qitan.sub });
    else if (t < T.stamp - .14) { const k = Math.round((1 - eio(seg(t, E0, E1))) * 40) / 40; plateA.set({ title: TX.qitan.title, titleFrac: k, sub: TX.qitan.sub, subFrac: k }); }
    else {
      const ps = seg(t, T.stamp - .14, T.stamp), sc = ps < 1 ? lerp(2.1, 1, eio(ps)) : 1 - .06 * Math.sin(Math.PI * seg(t, T.stamp, T.stamp + .16));
      const wipe = eo(seg(t, T.stamp, T.stamp + .35));
      plateA.set({ title: TX.qitan.title, titleFrac: Math.round(eo(ps) * 40) / 40, sub: TX.qitan2.facts, subFrac: Math.round(wipe * 40) / 40, stamp: { text: '2', scale: Math.round(sc * 50) / 50, alpha: Math.round(clamp(ps * 1.6) * 20) / 20 } });
    }
  } else {
    const p3 = popEnd(t, T.peak, .62), fp = ss(seg(t, ...FOLD.plate));
    plateA.g.rotation.x = lerp(Math.PI / 2 * (1 - p3) - LEAN * clamp(p3, 0, 1.2), Math.PI / 2, fp);   // 121.2–121.4 向前倒伏（返修）
    plateA.set({ title: TX.ranbiwa.title, sub: TX.ranbiwa.sub });
  }
  plateA.g.visible = true;
  { const fp = ss(seg(t, ...FOLD.plate));   // 返修：燃比娃段牌子前移 2.2 cm（后仰的上沿不再插进折扇）；倒伏时同时向后收 3.5 cm，扣倒后不伸出书页前沿
    plateA.g.position.z = (t >= 112 ? PLATE_A.z + .022 : PLATE_A.z) - .035 * fp;
    plateB.g.position.z = PLATE_B.z - .025 * fp; }
  // 森林
  forest.forEach((f, k) => {
    const tb = f.kind === 'front' ? T.front : T.forest;
    let y = riseY(t, tb + (f.kind === 'mid' ? .0 : 0), f.H, f.kind === 'far' ? .7 : .55, .002);
    if (f.kind !== 'far') y = Math.min(y, sinkY(t, T.dark + .05, T.dark + .42, f.H));
    else if (t >= FOLD.forest[0]) y = Math.min(y, sinkY(t, ...FOLD.forest, f.H));
    f.g.position.y = y; f.g.visible = t > tb - 1 && t < FOLD.forest[1];
    f.g.rotation.x = -sway(t, k * 1.3, f.kind === 'front' ? .02 : .008) * clamp(seg(t, tb, tb + .5));
  });
  // 浪浪山：110.5 从书缝升起，黑暗里收回
  llRise.position.y = Math.min(riseY(t, T.langlang, LL.h + .006, .5, .002), sinkY(t, T.dark + .05, T.dark + .4, LL.h + .006));
  llRise.visible = t > T.langlang - .6 && t < T.peak;
  llRise.rotation.x = -.04;
  // 标题牌 B
  { const p = popEnd(t, T.langlang, .62), down = ss(seg(t, T.dark + .05, T.dark + .38));
    plateB.g.rotation.x = lerp(Math.PI / 2 * (1 - p) - LEAN * clamp(p, 0, 1.2), Math.PI / 2, down); }
  // 燃比娃：116.0 升起落定；折扇 115.967 起从书下向上翻开成光芒
  rbRise.position.y = Math.min(riseY(t, T.peak, RB.h + .012, .36, .003), sinkY(t, ...FOLD.rb, RB.h + .012));
  rbRise.visible = t > T.peak - .5 && t < FOLD.rb[1];
  rbRise.rotation.x = -.05;
  const fc = 1 - eio(seg(t, ...FOLD.fan));   // 121.0–121.25 折扇先合（返修）
  blades.forEach(b => { const p = back(seg(t, T.peak - F1 + b.delay, T.peak + .28 + b.delay), 1.2) * fc, breath = t > T.peak + .5 ? .012 * fc * Math.sin((t - T.peak) * 1.6 + b.fin * 3) : 0;
    b.pv.rotation.z = lerp(b.start, b.fin, p) + breath; });
  fan.visible = t > T.peak - .1 && t < FOLD.fan[1];
  // 燃比娃的窄光：跟着台灯头，对准卡片；116 冲到最亮，之后回落
  const lit = t >= T.peak - F1 ? eo(seg(t, T.peak - F1, T.peak + .05)) * (.7 + 1.6 * Math.exp(-Math.max(0, t - T.peak) / .5)) : 0;
  spotRB.position.copy(ctx.lamp.spot.position); spotRB.target.position.set(RB.x, Y0 + .055, RB.z); spotRB.intensity = 2.2 * lit * (1 - ss(seg(t, FOLD.fan[0], FOLD.rb[1])));
  // 后期：黑一拍压暗角；最强一下泛光迸开、暗角转暖
  const pk = t >= T.peak - F1 ? Math.exp(-Math.max(0, t - T.peak) / .45) : 0, dk = ss(seg(t, T.dark - F1, T.dark + .1)) * (1 - seg(t, T.peak - F1, T.peak));
  ctx.post.bloom.strength = .12 + .55 * pk + .05 * (t > T.peak ? 1 : 0); ctx.post.bloom.threshold = .9 - .25 * pk; ctx.post.bloom.radius = .5 + .2 * pk;
  ctx.post.vig.uniforms.amt.value = .38 + .3 * dk + .08 * pk; ctx.post.vig.uniforms.warm.value = .25 + .3 * pk + .1 * (t > T.peak ? 1 : 0);
  // 景深：焦点跟着这一段的主体
  ctx.post.dof.focus = focusAt(t, ctx);
  ctx.post.dof.aper *= 1 - .6 * ss(seg(t, T.peak - .2, T.peak + .3));   // 燃比娃段：标题牌比卡片近，收小光圈让小字也清楚
  // 全黑一拍：共用层的 dim 不管轮廓光（rim），这里一并压暗（只在本章窗口内、每帧由开头代码重设，不需复位）
  { const L = 1 - .6 * ss(seg(t, T.dark - F1, T.dark + .1)) * (1 - seg(t, T.peak - F1, T.peak + .05)); ctx.lamp.rim.intensity *= L; }
}

// 主体点（世界坐标）随时间切换，交接 0.4 s 平滑
function subject(t) {
  const wp = whale.getWorldPosition(new THREE.Vector3());
  const P = [
    [0, [TOWER_X, Y0 + .12, -.03]],
    [T.go - .2, [wp.x, wp.y + .03, wp.z]],
    [T.land + .3, [TOWER_X - .03, Y0 + .12, -.02]],
    [T.forest + .3, [LL.x, Y0 + .045, LL.z]],
    [T.dark + .2, [RB.x, Y0 + .06, RB.z]],
  ];
  let i = 0; while (i < P.length - 1 && t >= P[i + 1][0]) i++;
  if (i === 0) return P[0][1];
  const w = ss(seg(t, P[i][0], P[i][0] + .4)); return P[i - 1][1].map((v, j) => lerp(v, P[i][1][j], w));
}
const fw = { v: null };
function focusAt(t, ctx) {
  const cam = ctx.cam, p = subject(t); cam.updateMatrixWorld(); if (!fw.v) fw.v = new THREE.Vector3();
  cam.getWorldDirection(fw.v);
  return Math.max(.05, (p[0] - cam.position.x) * fw.v.x + (p[1] - cam.position.y) * fw.v.y + (p[2] - cam.position.z) * fw.v.z);
}

// ———————————————— 画面文字（全部来自 TEXT.ch4）————————————————
function rectBox(ctx, g, art, r) {
  if (!r) return null; g.updateWorldMatrix(true, true); const u = g.userData;
  const xs = [r[0], r[0] + r[2]].map(px => -u.w / 2 + px / art.W * u.w), ys = [r[1], r[1] + r[3]].map(py => u.h - py / art.H * u.h);
  const pts = []; for (const a of xs) for (const b of ys) { const v = new THREE.Vector3(a, b, 0).applyMatrix4(g.matrixWorld); pts.push(ctx.project(v.x, v.y, v.z)); }
  return { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) };
}
const standing = g => g.rotation.x < .9 && g.rotation.x > -1;
export function texts(t, ctx) {
  const out = [];
  if (!S6.root.visible) return out;
  const plate = (pl, id) => { if (!standing(pl.g) || !pl.cur) return;
    const o = pl.cur, title = o.stamp ? TX.qitan2.title : o.title;
    const bt = rectBox(ctx, pl.g, pl.pc, pl.pc.rects.title); if (bt && title && (o.titleFrac ?? 1) > .05) out.push({ id: id + '.title', text: title, ...bt });
    const bs = rectBox(ctx, pl.g, pl.pc, pl.pc.rects.sub); if (bs && o.sub && (o.subFrac ?? 1) > .05) out.push({ id: id + '.sub', text: o.sub, ...bs }); };
  plate(plateA, 'ch4.plateA');
  if (t >= T.langlang - .3 && t < T.peak) plate(plateB, 'ch4.plateB');
  wins.forEach((w, i) => { if (t >= w.t && w.tag.rotation.x < .8 && t < (i < 2 ? T.forest + .2 : T.dark)) { const tg = { W: w.ta.c.width, H: w.ta.c.height }; const b = rectBox(ctx, w.tag, tg, w.ta.rect); if (b) out.push({ id: `ch4.win.${i}`, text: w.text, ...b }); } });
  return out.filter(o => o.x1 > 0 && o.x0 < 1920 && o.y1 > 0 && o.y0 < 1080);   // 只报画面里看得见的
}
export function probe(t) {
  return { tiers: tiers.map(x => +x.g.position.y.toFixed(4)), whaleU: +(t < T.go ? 0 : whaleS(t)).toFixed(4), wins: wins.map(w => +w.shR.rotation.y.toFixed(3)), rb: +rbRise.position.y.toFixed(4), fan: +blades[0].pv.rotation.z.toFixed(3) };
}
