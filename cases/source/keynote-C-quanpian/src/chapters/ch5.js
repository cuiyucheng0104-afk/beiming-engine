// 第五章 合作城（第 62–73 小节，122–146 s）。接口见 ARCH.md §4；分镜与决定见 notes/ch5.md。
// 62：书页摊平（共用层）→ 书边四面的风琴折纸向外展开（纸面延展）→ 建筑从书脊中心向外、每个十六分音符一圈层层弹起。
// 64–69：标题纸条在广场立起打字 → 镜头俯飞：咖啡店（65.1）、茶饮店（67.1）、书店（69.1），到店那一拍案例卡翻起、下一拍说明纸条立起。
// 69.4：广场门楼弹起；70.1 / 70.2 / 70.3：三道门依次打开，门里是三个问题。73 末：镜头升起，交给第六章的等距镜头。
// 城一直留到合书：第六、七章用 ctx.use('city') 接管（setRetract(r) 收城、plan 给出「谈」字街道）。
//
// 需求（给合成阶段）：
//  1. 共用层：跨页 n 的背板挂件（spread(n).back = 第 n−1 页的 backRoot）翻走后没有自动隐藏。第 62 小节整摞摊平后，第三章挂在 spread(5).back 上的面板
//     （凸出背板约 2 cm）平躺在远半页上方，把第五章远半页的城和街道整片盖住。本章在 121.9 s 起把 spread(1–6).back 设为不可见作为兜底，
//     建议共用层按 spread.window 自动隐藏 back（同 root），之后可删掉本章 update() 第一行。
//  2. 城一直留到合书：第六·七章用 city.gate.retract(r) 折平门楼、city.plan.strokes 点亮「谈」字街道、city.setRetract(r, t) 在第 88 小节收城
//     （卡片、纸条只转不压，IP 图不变形）。本章 update() 在 121–180 s 每帧重设全部可见性与姿态，第六·七章在其后覆盖。
//  3. 本章没有改共用层；台灯：沿用占位的第 61 小节第 4 拍转回，另加三次无声的光斑微调（只改 aim，不触发台灯音效）。
import * as THREE from 'three';
import { at, KEY, CH } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';
import { clamp, lerp, seg, ss, eio, eo, back, track } from '/core/lib.js';
import * as M from './ch5_mem.js';
import * as P from './ch5_plan.js';

export const ID = 'ch5';
const PG = .023, PAL = M.PAL, D2R = Math.PI / 180;
const COS_FAR = Math.cos(4.7 * D2R);

// ———————————————— 时刻（全部量化到整帧） ————————————————
const T_FLAT = KEY.ch5.flat;                               // 122.0 摊平落定（共用层：唰 + 纸板落定）
const T_SIDE = at(62, 2), T_FRONT = at(62, 3);             // 风琴折纸展开落定：左右两侧 / 前沿
const T_GROW0 = at(62, 3), GROW_STEPS = 19;                // 建筑一圈一圈弹起：62.3 起每个十六分音符一圈，到 63.3 + 2 个十六分
const T_LIFE = at(63, 4);                                  // 小汽车、行人出现
const T_TITLE = at(63, 4);                                 // 125.5 标题纸条立起（返修：从 64.1 提前一拍，和高位全景重叠，127.5 前早已打完）
const T_TYPE = Array.from({ length: [...TEXT.ch5.title].length }, (_, i) => at(63, 4, 1 + i));   // 每个十六分打一个字：125.63–126.5
const T_SHOP = { coffee: at(65), tea: at(67), book: at(69) };                                    // 到店 = 案例卡翻起落定
const T_CAP = { coffee: at(65, 2), tea: at(67, 2), book: at(69, 2) };                           // 说明纸条立起
const T_TITLE_FOLD = at(70, 1, 1), T_GATE = at(70, 1, 2);  // 返修：书店停到 138.0；甩镜 138.0–138.5 途中标题纸条扣下（138.13）、门楼弹起（138.27）
const T_DOOR = [at(70, 2), at(70, 3), at(70, 4)];          // 返修：三道门挪到第 70 小节第 2、3、4 拍（138.5 / 139.0 / 139.5），仍是三拍依次打开
const T_SWING = [at(70, 1), at(70, 2)];                    // 书店 → 门前的甩镜：0.5 s 缓入缓出
const T_LEAVE = at(73, 2);                                 // 镜头开始升起，交给第六章
const CAP_TOP = { coffee: [at(65, 2) - .5, at(66) + .4], tea: [at(67, 2) - .5, at(68) + .4], book: [at(69, 2) - .5, at(70, 1, 1)] };   // 说明纸条压在最上层的时段（只在镜头停在该店时）

// ———————————————— 镜头 ————————————————
// [秒, camKey(fov, 仰角, 方位, 目标 x, y, z, 可视高)]；方位正 = 相机在 +x 一侧
const S = P.SHOPS, G = P.GATE;
const front = (s, k = 1) => [s.cx + Math.sin(s.ang) * s.d / 2 * k, s.cz + Math.cos(s.ang) * s.d / 2 * k];
const [cfx, cfz] = front(S.coffee), [tfx, tfz] = front(S.tea), [bfx, bfz] = front(S.book);
const BOOK_Y = .021;                                       // 远半页（有坡）在书店处的地面高
const az = s => s.ang / D2R;
export const camera = [
  [122.5, camKey(30, 54, -6, 0, PG, -.12, .66)],                       // 摊平后的俯视：整本书
  [124.0, camKey(30, 58, -3, .01, PG, -.12, .80)],                     // 升起拉远：纸面向四周延展、城一圈圈长出来
  [125.4, camKey(30, 50, 3, .03, PG, -.07, .66)],
  [126.5, camKey(32, 24, 2, P.BANNER.x, PG + .012, P.BANNER.z, .2)],    // 俯冲到广场：标题纸条
  [127.2, camKey(32, 22, 10, P.BANNER.x - .01, PG + .012, P.BANNER.z - .01, .17)],
  [128.0, camKey(32, 29, az(S.coffee), cfx, PG + .024, cfz, .125)],     // 咖啡店（65.1 停）
  [130.0, camKey(32, 27, az(S.coffee) - 6, cfx + .003, PG + .023, cfz, .117)],
  [131.0, camKey(32, 30, 4, .07, PG + .01, -.045, .2)],                 // 越过路口
  [132.0, camKey(32, 28, az(S.tea), tfx, PG + .026, tfz, .112)],         // 茶饮店（67.1 停）
  [134.0, camKey(32, 26, az(S.tea) + 6, tfx - .003, PG + .025, tfz, .105)],
  [135.0, camKey(34, 22, -8, .075, PG + .012, -.14, .17)],              // 沿「火」的竖笔大街往里飞
  [136.0, camKey(32, 24, 0, bfx, BOOK_Y + .05, bfz, .158)],             // 书店（69.1 停）：楼 + 屋顶广告牌上的案例卡
  [137.0, camKey(32, 23, 2, bfx, BOOK_Y + .049, bfz, .15)],
  [138.0, camKey(32, 23, 3, bfx, BOOK_Y + .049, bfz, .146)],           // 返修：书店停满两小节（136–138），极慢推
  [138.25, camKey(31, 32, 0, G.cx, PG + .04, G.cz - .01, .27)],        // 甩镜中点：从广场上空越过（不穿过刚弹起的门楼）
  [138.5, camKey(30, 15, -2, G.cx, PG + .056, G.cz + .01, .152)],      // 138.0–138.5 甩镜到门前（两端速度为 0 = 缓入缓出）；门楼在途中弹起
  [139.5, camKey(30, 13, -3, G.cx, PG + .055, G.cz + .01, .146)],
  [143.8, camKey(30, 12, 3, G.cx, PG + .054, G.cz + .01, .134)],        // 慢推：读门里的三个问题
  [145.0, camKey(26, 24, 18, .08, PG + .03, .0, .2)],                  // 升起、转向：交给第六章的推拉变焦
  [146.0, camKey(16, 34, 34, .095, PG + .01, .0, .16)],
];
const camT = track(camera);
// 台灯：第 61 小节第 4 拍转回（第四章转去打燃比娃）；光斑跟着城微调（只改 aim，无声）
export const lamp = [
  { t: at(61, 4), dur: .5, yaw: 0, aim: [.02, .063, -.03] },
  { t: at(63, 1), dur: 1.5, aim: [.03, .03, -.08], sound: false },
  { t: at(68, 3), dur: 1.5, aim: [.06, .03, -.12], sound: false },
  { t: at(70, 1), dur: .6, aim: [.06, .04, -.01], sound: false },
];

// ———————————————— 事件（画面落点；sfx/ch5.json 引用这些 id） ————————————————
const growT = k => at(62, 3, k);                          // 第 k 圈落定
export function events() {
  const E = [
    { t: T_SIDE, type: 'unfold', id: 'ch5.unfold.side', sfx: true },
    { t: T_FRONT, type: 'unfold', id: 'ch5.unfold.front', sfx: true },
    ...Array.from({ length: GROW_STEPS }, (_, k) => ({ t: growT(k), type: 'grow', id: `ch5.grow.${k}`, k, sfx: true })),
    { t: T_LIFE, type: 'life', id: 'ch5.life' },
    { t: T_TITLE, type: 'card_up', id: 'ch5.title.up', sfx: true },
    ...T_TYPE.map((t, i) => ({ t, type: 'type', id: `ch5.title.type.${i}`, i, sfx: true })),
  ];
  for (const k of ['coffee', 'tea', 'book']) E.push({ t: T_SHOP[k], type: 'card_up', id: `ch5.${k}.card`, sfx: true }, { t: T_CAP[k], type: 'label_up', id: `ch5.${k}.cap`, sfx: true });
  E.push({ t: at(66), type: 'cam_move', id: 'ch5.move.1' }, { t: at(68), type: 'cam_move', id: 'ch5.move.2' }, { t: T_SWING[0], type: 'cam_move', id: 'ch5.move.3' });
  E.push({ t: T_TITLE_FOLD, type: 'fold', id: 'ch5.title.fold', sfx: true }, { t: T_GATE, type: 'pop', id: 'ch5.gate.up', sfx: true });
  T_DOOR.forEach((t, i) => E.push({ t, type: 'door', id: `ch5.door.${i}`, sfx: true }));
  E.push({ t: T_LEAVE, type: 'cam_move', id: 'ch5.leave' });
  return E;
}

// ———————————————— 搭建 ————————————————
let nearG, farG, worldG;
const items = [];          // { g, k(圈), kind: 'bld'|'tree'|'life', t0 }
const cards = {}, caps = {};
let banner, gate, accs = [], cars = [], people = [], spill = [], streets = [];
let lastT = 0;
const R = P.mulb(55);
function placeOn(obj, x, z) {   // 近半页 → spread(7).root；远半页 → 第 6 页背面（有坡，跟着书页走）
  if (z > P.ZH) { obj.position.set(x, 0, z); nearG.add(obj); } else { obj.position.set(x, 0, (z - P.ZH) / COS_FAR); farG.add(obj); }
  return obj;
}
const wave = (x, z) => { const d = Math.hypot(x * .9, (z - P.ZH) * 1.05); return Math.min(GROW_STEPS - 1, Math.floor(d / .34 * (GROW_STEPS - 1))); };

export async function build(ctx) {
  const sp = ctx.book.spread(7);
  nearG = new THREE.Group(); nearG.name = 'city.near'; sp.root.add(nearG);
  farG = new THREE.Group(); farG.name = 'city.far'; farG.rotation.x = Math.PI / 2; sp.back.add(farG);
  worldG = new THREE.Group(); worldG.name = 'city.world'; ctx.root.add(worldG);
  const plan = P.genCity(5);
  // —— 地面印刷：街道（「谈」字十笔）、地块色区、广场 ——
  const gN = groundArt('near', plan), gF = groundArt('far', plan); sp.setFloor(gN); sp.setBackdrop(gF);
  streets.push(streetLayer(gN.streets, 'near'), streetLayer(gF.streets, 'far')); nearG.add(streets[0]); farG.add(streets[1]);

  // —— 普通建筑 ——
  for (const b of plan.blds) { const g = building(b); placeOn(g, b.cx, b.cz); items.push({ g, k: wave(b.cx, b.cz), kind: 'bld' }); }
  for (const t of plan.trees) { const g = M.tree(t.kind, R, t.s); g.rotation.y = R() * 6.28; placeOn(g, t.x, t.z); items.push({ g, k: Math.min(GROW_STEPS - 1, wave(t.x, t.z) + 1), kind: 'tree' }); }

  // —— 三家店 + 案例卡 + 说明纸条 ——
  const imgs = { coffee: await ctx.ip('p17_starbucks'), tea: await ctx.ip('p17_guming'), book: await ctx.ip('p17_citic') };
  TEXT.ch5.cases.forEach((txt, i) => { const k = ['coffee', 'tea', 'book'][i]; const L = ctx.kit.label(txt, { w: .136, h: .0158 }); L.set([...txt].length); caps[k] = L; });
  for (const k of ['coffee', 'tea', 'book']) {
    const s = S[k], g = shop(k, s, ctx, imgs[k]); g.rotation.y = s.ang; placeOn(g, s.cx, s.cz);
    items.push({ g: g.userData.body, k: wave(s.cx, s.cz), kind: 'bld' });
    for (const x of g.userData.extra) items.push({ g: x, k: Math.min(GROW_STEPS - 1, wave(s.cx, s.cz) + 2), kind: 'tree' });
  }

  // —— 标题纸条（广场中央）——
  banner = ctx.kit.label(TEXT.ch5.title, { w: .148, h: .022 });
  banner.g.position.set(P.BANNER.x, 0, P.BANNER.z); nearG.add(banner.g);

  // —— 广场门楼 + 三道门 ——
  gate = gateBuild(ctx); gate.g.position.set(G.cx, 0, G.cz); nearG.add(gate.g);
  // 广场小物：路灯、花坛、长椅
  for (const [x, z, k] of [[-.03, .045, 0], [.17, .045, 0], [-.03, .128, 1], [.17, .128, 1], [-.004, .12, 2], [.144, .12, 2]]) {
    const g = k < 2 ? streetLamp(k) : planter(); placeOn(g, x, z); items.push({ g, k: GROW_STEPS - 2, kind: 'tree' });
  }

  // —— 书边四面的风琴折纸（纸面延展）+ 上面的公园、田、环路 ——
  accs.push(accordion(ctx, 'right'), accordion(ctx, 'left'), accordion(ctx, 'front'));

  // —— 小汽车、行人（只在该动的时候动：循环小动作）——
  buildLife(ctx);

  ctx.publish('city', {
    group: worldG, near: nearG, far: farG, retract: 0,
    setRetract: (r, t = lastT) => applyRetract(r, t), ch67Plan: false,
    plan: { strokes: P.STROKES, streetW: P.STREET_W, tanBox: P.TAN_BOX, ZH: P.ZH, plaza: P.PLAZA, gate: P.GATE, shops: P.SHOPS,
      note: '街道 = 「谈」字十笔（世界坐标 x/z，米）；远半页（z < −.14）上的东西挂在第 6 页背面（farG）' },
    gate, shops: cards,
  });
}

// ———————————————— 每帧 ————————————————
export function update(t, ctx) {
  lastT = t;
  // 摊平落地前一刻：把第 1–6 跨页背板上的挂件藏起来（它们原来凸出背板几毫米，书页平躺后会从城底下戳出来、盖住远半页）——见 requests
  for (let n = 1; n <= 6; n++) { const b = ctx.book.spread(n).back; if (b && t >= (n < 6 ? T_FLAT - .75 : T_FLAT - .1)) b.visible = false; }
  { const r = ((t - T_GROW0) / .125 + 1.5) / (GROW_STEPS - 1) * .34; for (const m of streets) m.material.userData.R.value = r; }
  const on = t >= T_FLAT - .75;
  nearG.visible = farG.visible = on; worldG.visible = t >= T_FLAT;
  // 生长：每圈在它的十六分音符上第一次到位（back 回弹）
  for (const it of items) {
    const tk = growT(it.k), p = Math.max(0, ctx.kit.popAt(t, tk, it.kind === 'tree' ? .36 : .42));
    if (it.kind === 'tree') it.g.scale.setScalar(Math.max(1e-3, p));
    else { it.g.scale.set(1 + .18 * (1 - Math.min(1, p)) * (p > 0), Math.max(1e-3, p), 1 + .18 * (1 - Math.min(1, p)) * (p > 0)); }
    it.g.visible = p > .002;
  }
  // 风琴折纸
  for (const A of accs) A.update(t);
  // 案例卡：到店那一拍翻起；说明纸条：下一拍立起（之后一直立着，第七章收城时由 setRetract 向前扣倒）
  for (const k of ['coffee', 'tea', 'book']) {
    ctx.kit.standAt(cards[k], t, T_SHOP[k], .5, 0); cards[k].visible = t >= T_SHOP[k] - .5;
    ctx.kit.standAt(caps[k].g, t, T_CAP[k], .5, .62); caps[k].g.visible = t >= T_CAP[k] - .5;
    // 返修：停在这家店的这一段，说明纸条画在最上层（路过的小车、行人从纸条后面过，不再压字）
    const top = t >= CAP_TOP[k][0] && t < CAP_TOP[k][1], f = caps[k].g.userData.f;
    f.material.depthTest = !top; f.material.transparent = top; f.renderOrder = top ? 20 : 0;   // 放进透明队列最后画：街道层（透明）也压不住它
  }
  // 标题纸条：立起 → 打字 → 69.3 向前扣下
  { const g = banner.g, up = ctx.kit.popAt(t, T_TITLE, .5), down = ss(seg(t, T_TITLE_FOLD - .3, T_TITLE_FOLD));
    g.rotation.x = Math.PI / 2 * (1 - up) - .3 * clamp(up) + (Math.PI / 2 + .3) * down;
    g.visible = t >= T_TITLE - .5 && t < T_TITLE_FOLD + .1;
    banner.set(T_TYPE.filter(x => t >= x).length); }
  // 门楼与三道门
  gate.update(t);
  // 小汽车、行人
  lifeUpdate(t);
  // 景深：对在镜头目标点上，收小光圈（城要清楚）；146 s 起交给第六章
  if (t < CH.ch5.range[1]) { const k = camT(t), tgt = new THREE.Vector3(k[3], k[4], k[5]);
    ctx.post.dof.focus = Math.max(.05, ctx.cam.position.distanceTo(tgt)); ctx.post.dof.aper = t < 125.6 ? 4 : t > 137.9 ? 2.6 : 3.2; ctx.post.dof.maxCoc = 12; }
}

// 收城：r 0→1。小东西先收，建筑按"由外向内"倒着一圈圈压平，卡片/纸条向前扣倒（只转不压，IP 图不变形），折纸合回
function applyRetract(r, t) {
  if (r <= 0) return;
  for (const it of items) { const kk = (GROW_STEPS - 1 - it.k) / (GROW_STEPS - 1), u = ss(seg(r, kk * .6, kk * .6 + .4)); const s = 1 - u;
    if (it.kind === 'tree') it.g.scale.setScalar(Math.max(1e-3, s * it.g.scale.y)); else it.g.scale.y = Math.max(1e-3, Math.min(it.g.scale.y, s)); it.g.visible = s > .003; }
  const f = ss(seg(r, 0, .35));
  for (const k in cards) { cards[k].rotation.x = lerp(cards[k].rotation.x, Math.PI / 2, f); caps[k].g.rotation.x = lerp(caps[k].g.rotation.x, Math.PI / 2, f); }
  gate.retract(r);
  for (const c of [...cars, ...people]) c.g.visible = c.g.visible && r < .15;
  for (const A of accs) A.retract(r);
  for (const s of spill) s.material.opacity *= 1 - r;
}

// ———————————————— 画面文字（全部来自 TEXT.ch5） ————————————————
export function texts(t, ctx) {
  const out = [];
  const box = (g, id, text) => { if (!g.visible || !visChain(g)) return; const b = ctx.screenBox(g); if (b && b.x1 > 0 && b.x0 < 1920 && b.y1 > 0 && b.y0 < 1080) out.push({ id, text, ...b }); };
  if (banner.g.visible && t >= T_TYPE[0] && t < T_TITLE_FOLD) box(banner.g, 'ch5.title', TEXT.ch5.title);
  ['coffee', 'tea', 'book'].forEach((k, i) => { if (t >= T_CAP[k] - .1 && caps[k].g.rotation.x < 1.2) box(caps[k].g, `ch5.case.${k}`, TEXT.ch5.cases[i]); });
  gate.panels.forEach((p, i) => { if (gate.openAmt(i, t) > .2 && gate.g.visible) box(p, `ch5.door.${i}`, TEXT.ch5.doors[i]); });
  return out;
}
const visChain = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
export function probe(t) {
  return { grown: items.filter(i => i.g.visible).length, doors: T_DOOR.map((_, i) => +gate.openAmt(i, t).toFixed(3)), cards: Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, +c.rotation.x.toFixed(3)])) };
}

// ═════════════════════════════════ 部件 ═════════════════════════════════
const SAT = [PAL.yellow, PAL.pink, PAL.sky, PAL.mint, PAL.lilac, PAL.peach, PAL.cobalt, PAL.green];
const PAST = [PAL.butter, PAL.blush, PAL.ice, PAL.mintL, PAL.lilacL, PAL.peachL, PAL.cream];
const pick = a => a[Math.floor(R() * a.length)];
const inTri = (x, z) => { // 下「火」两条腿之间的三角地块（镜头从广场看店时会越过它）：建筑压低
  const A = [.064, -.092], B = [-.07, .01], C = [.21, .01]; const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([x, z], A, B), d2 = s([x, z], B, C), d3 = s([x, z], C, A); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
function building(b) {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); root.userData.body = body;
  const low = inTri(b.cx, b.cz) || b.cz > .005;
  let h = low ? .011 + R() * .01 : .013 + R() * .028; if (!low && R() < .12) h += .02;
  const col = pick(SAT), top = pick(PAST), kind = R();
  const usePat = R() < .38;
  const o = { col, top, top2: '#FFFFFF', patTop: R() < .5 ? 'dots' : 'terrazzo', scaleTop: .0035, seed: R() * 100 };
  if (usePat) Object.assign(o, { pat: pick(['dots', 'diag', 'vstripe', 'zig', 'hstripe']), col2: R() < .5 ? '#FFFFFF' : M.INKM, scale: .0032 + R() * .002 });
  else o.win = { w: .0058 + R() * .0016, h: .0072, base: .0055, lit: .25 + R() * .4, a: '#FFD36E', b: pick([PAL.ice, '#FFFFFF', PAL.lilacL]) };
  if (kind < .5 || b.w < .017 || b.d < .017) {               // 平顶楼 + 屋顶小件
    const m = M.mbox(b.w, h, b.d, o); body.add(m);
    if (R() < .55) { const k = R(); const tw = Math.min(b.w, b.d) * .38;
      const x = k < .4 ? M.mball(tw * .5, { col: pick(SAT) }) : k < .7 ? M.mcyl(tw * .45, tw * .8, { col: pick(SAT), top: pick(PAST), line: 2.4 }) : M.mbox(tw, tw * .7, tw, { col: pick(SAT), top: pick(PAST), line: 2.4 });
      x.position.set((R() - .5) * b.w * .3, h + (k < .4 ? tw * .5 : 0), (R() - .5) * b.d * .3); body.add(x); }
  } else if (kind < .78) {                                    // 坡屋顶小楼
    const m = M.mbox(b.w, h, b.d, o); body.add(m);
    const along = b.w >= b.d, rf = M.mroof((along ? b.w : b.d) + .002, Math.min(b.w, b.d) * .42, (along ? b.d : b.w) + .002, { col: pick([PAL.cobalt, PAL.pink, PAL.yellow, PAL.green, PAL.peach]) });
    rf.position.y = h; if (!along) rf.rotation.y = Math.PI / 2; body.add(rf);
  } else {                                                    // 叠层楼（上小下大）+ 半圆顶
    const h1 = h * .62, m = M.mbox(b.w, h1, b.d, o); body.add(m);
    const w2 = b.w * .66, d2 = b.d * .66, m2 = M.mbox(w2, h - h1 + .006, d2, { col: pick(SAT), top: pick(PAST), patTop: 'dots', top2: '#FFFFFF', pat: R() < .5 ? 'vstripe' : 'none', col2: '#FFFFFF', scale: .003 });
    m2.position.y = h1; body.add(m2);
    if (R() < .6) { const d = M.mball(Math.min(w2, d2) * .36, { col: pick(SAT) }); d.position.y = h + .006; d.scale.y = .8; body.add(d); }
  }
  return root;
}
// 门脸朝 +z 的店（局部坐标：原点 = 底面中心）
function shop(kind, s, ctx, img) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body); const fz = s.d / 2, extra = [];
  const add = (m, x, y, z) => { m.position.set(x, y, z); body.add(m); return m; };
  let card;
  if (kind === 'coffee') {
    add(M.mbox(s.w, s.h, s.d, { col: PAL.pink, top: PAL.blush, patTop: 'terrazzo', top2: '#FFFFFF', pat: 'vstripe', col2: '#FFB3D1', scale: .006 }), 0, 0, 0);
    add(M.mbox(s.w + .003, .006, s.d + .003, { col: PAL.cobalt, top: PAL.cobalt, pat: 'zig', col2: PAL.yellow, scale: .0045 }), 0, s.h, 0);           // 檐口
    add(M.mbox(.034, .019, .002, { col: PAL.ice, top: PAL.ice, line: 3 }), -.009, .003, fz);                                                          // 橱窗
    add(M.mbox(.011, .021, .002, { col: M.INKM, top: M.INKM, line: 0 }), .018, 0, fz);                                                                // 门
    const aw = add(M.mbox(.058, .0018, .014, { col: '#FFFFFF', top: '#FFFFFF', patTop: 'vstripe', top2: PAL.yellow, scaleTop: .007, line: 2.6 }), 0, .0245, fz + .006); aw.rotation.x = .38;
    add(M.mbox(.058, .0025, .006, { col: PAL.yellow, top: PAL.yellow, line: 2.6 }), 0, .0268, fz + .003);                                             // 招牌托架
    card = ctx.kit.card(img, { h: .0285 }); card.position.set(0, .0295, fz + .0035);
  } else if (kind === 'tea') {
    add(M.mbox(s.w, s.h, s.d, { col: PAL.mint, top: PAL.mintL, patTop: 'dots', top2: '#FFFFFF', pat: 'none' }), 0, 0, 0);
    add(M.mbox(s.w + .002, .0082, s.d + .002, { col: PAL.cobalt, top: PAL.yellow, pat: 'zig', col2: '#FFFFFF', scale: .004 }), 0, s.h - .007, 0);   // 返修：檐口顶面高出屋面 1.2 mm（原来与屋面共面，近景闪方块）
    // 橱窗框（凸出立面），案例卡立在窗里
    const fw = .054, fh = .035, y0 = .0055;
    add(M.mbox(fw + .006, .004, .009, { col: PAL.yellow, top: PAL.yellow }), 0, y0 - .004, fz + .0045);                                              // 窗台
    add(M.mbox(fw + .006, .004, .009, { col: PAL.yellow, top: PAL.yellow }), 0, y0 + fh, fz + .0045);
    add(M.mbox(.003, fh, .009, { col: PAL.yellow, top: PAL.yellow }), -fw / 2 - .0015, y0, fz + .0045);
    add(M.mbox(.003, fh, .009, { col: PAL.yellow, top: PAL.yellow }), fw / 2 + .0015, y0, fz + .0045);
    add(M.mbox(fw, fh, .001, { col: '#FFF6E4', top: '#FFF6E4', pat: 'dots', col2: PAL.mintL, scale: .004, line: 0 }), 0, y0, fz + .0003);             // 窗里的背板
    const aw = add(M.mbox(.062, .0018, .012, { col: '#FFFFFF', top: '#FFFFFF', patTop: 'vstripe', top2: PAL.pink, scaleTop: .0065, line: 2.6 }), 0, y0 + fh + .0085, fz + .0065); aw.rotation.x = .42;
    card = ctx.kit.card(img, { h: .0285 }); card.position.set(0, y0 + .002, fz + .004);
  } else {
    add(M.mbox(s.w, s.h, s.d, { col: PAL.lilac, top: PAL.lilacL, patTop: 'terrazzo', top2: '#FFFFFF', pat: 'dots', col2: '#FFFFFF', scale: .005 }), 0, 0, 0);
    add(M.mbox(.044, .016, .002, { col: PAL.butter, top: PAL.butter, line: 3 }), -.006, .004, fz);                                                    // 橱窗
    add(M.mbox(.011, .02, .002, { col: M.INKM, top: M.INKM, line: 0 }), .023, 0, fz);
    for (let i = 0; i < 7; i++) add(M.mbox(.0042, .007 + (i % 3) * .0018, .003, { col: [PAL.pink, PAL.cobalt, PAL.yellow, PAL.green, PAL.peach, PAL.sky, PAL.mint][i], top: '#FFFFFF', line: 2.2 }), -.024 + i * .0058, .0045, fz + .0025);   // 窗里的书
    add(M.mbox(s.w + .003, .0062, s.d + .003, { col: PAL.yellow, top: PAL.butter, pat: 'diag', col2: M.INKM, scale: .004 }), 0, s.h - .005, 0);   // 返修：同上，檐口顶面高出屋面 1.2 mm
    // 屋顶广告牌：两根柱子 + 底梁，案例卡立在底梁上
    for (const x of [-.026, .026]) add(M.mbox(.003, .012, .003, { col: PAL.cobalt, top: PAL.cobalt }), x, s.h, .002);
    add(M.mbox(.06, .003, .005, { col: PAL.cobalt, top: PAL.pink, line: 2.6 }), 0, s.h + .009, .002);
    card = ctx.kit.card(img, { h: .034 }); card.position.set(0, s.h + .012, .0045);
  }
  g.add(card); cards[kind] = card;   // 卡片不跟楼一起压扁：只用翻起（standAt），图不变形
  const cap = caps[kind]; cap.g.position.set(0, 0, fz + (kind === 'tea' ? .031 : .017)); g.add(cap.g);   // 返修：茶饮店纸条前移 1.4 cm（后仰的上沿原来插进橱窗框、压住古茗卡下半部）
  g.userData = { body, extra }; return g;
}
function umbrella(col) {
  const g = new THREE.Group();
  g.add(M.mcyl(.0005, .012, { col: M.INKM, top: M.INKM, line: 0, hull: false, seg: 6 }));
  const c = M.mcone(.0065, .004, { col }); c.position.y = .0105; g.add(c);
  const tb = M.mcyl(.003, .0005, { col: '#FFFFFF', top: '#FFFFFF', line: 2, seg: 14 }); tb.position.y = .005; g.add(tb);
  return g;
}
function planter() {
  const g = new THREE.Group(); g.add(M.mbox(.008, .004, .008, { col: PAL.peach, top: PAL.green, patTop: 'dots', top2: PAL.mint, line: 2.4 }));
  const b = M.mball(.004, { col: PAL.green }); b.position.y = .006; g.add(b); return g;
}
function streetLamp(k) {
  const g = new THREE.Group();
  g.add(M.mcyl(.0007, .022, { col: M.INKM, top: M.INKM, line: 0, hull: false, seg: 8 }));
  const b = M.mball(.0028, { col: '#FFE7A6' }); b.position.y = .0235; b.children[0].material.userData.U.uBoost.value = .9; g.add(b);
  if (k === 0) { const f = M.mbox(.012, .006, .0008, { col: PAL.pink, top: PAL.pink, pat: 'zig', col2: '#FFFFFF', scale: .003, line: 2 }); f.position.set(.006, .014, 0); g.add(f); }
  return g;
}

// —— 门楼：三道门，门里是问题 ——
function gateBuild(ctx) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const W = G.w, H = .072, fz = .0085, C = [-.06, 0, .06], DW = .046, DH = .06;
  const add = (m, x, y, z) => { m.position.set(x, y, z); body.add(m); return m; };
  add(M.mbox(W + .012, .005, .03, { col: PAL.lilac, top: PAL.lilacL, patTop: 'terrazzo', top2: '#FFFFFF', line: 3 }), 0, 0, .004);                     // 台基
  add(M.mbox(W, H + .005, .012, { col: '#F3E3C8', top: PAL.cream }), 0, .005, -.0035);                                                                  // 后墙（门洞里看到的墙）
  for (const x of [-.088, -.03, .03, .088]) add(M.mbox(.014 - (Math.abs(x) > .05 ? .004 : 0), DH, .007, { col: PAL.cobalt, top: PAL.cobalt, pat: 'dots', col2: '#FFFFFF', scale: .004 }), x, .005, .005);
  add(M.mbox(W, .008, .008, { col: PAL.yellow, top: PAL.yellow, pat: 'diag', col2: M.INKM, scale: .004 }), 0, .005 + DH, .0045);                          // 门楣
  add(M.mbox(W, .02, .011, { col: '#FFFFFF', top: PAL.pink, pat: 'zig', col2: PAL.cobalt, scale: .006, patTop: 'dots', top2: '#FFFFFF' }), 0, .013 + DH, -.002);   // 女儿墙：蓝色锯齿
  // 门洞上的半圆窗 + 顶上三个孟菲斯记号：黄圆点、粉三角、蓝锯齿
  C.forEach((c, i) => { const cc = [PAL.sky, PAL.yellow, PAL.mint][i]; const f = M.mcyl(.0135, .002, { col: cc, top: cc, line: 2.6, seg: 28 }); f.rotation.x = Math.PI / 2; f.position.set(c, .074, .0046); body.add(f); });
  const dot = M.mball(.011, { col: PAL.yellow }); add(dot, -.07, .104, -.002);
  const tri = M.mroof(.012, .022, .026, { col: PAL.pink }); add(tri, 0, .093, -.002); tri.rotation.y = Math.PI / 2;
  const zz = M.mbox(.03, .009, .006, { col: PAL.cobalt, top: PAL.cobalt, pat: 'zig', col2: '#FFFFFF', scale: .0045 }); add(zz, .07, .094, -.002); zz.rotation.z = .25;
  // 门里的字（受光的印刷面板，开门后内部提亮）
  const panels = C.map((c, i) => { const p = M.printPlane(doorArt(i), DW - .002, DH - .002, { boost: .35 }); p.position.set(c, .005 + DH / 2, .0029); body.add(p); return p; });
  // 门扇：每道门两扇，向外开
  const doors = C.map((c, i) => {
    const cols = [[PAL.yellow, PAL.cobalt, 'dots'], [PAL.pink, '#FFFFFF', 'zig'], [PAL.sky, '#FFFFFF', 'diag']][i];
    return [-1, 1].map(sd => { const piv = new THREE.Group(); piv.position.set(c + sd * DW / 2, .005, fz - .0005); body.add(piv);
      const leaf = M.mbox(DW / 2 - .0004, DH - .0006, .0018, { col: cols[0], top: cols[0], pat: cols[2], col2: cols[1], scale: .004 }); leaf.position.x = -sd * (DW / 4); piv.add(leaf);
      const knob = M.mball(.0012, { col: M.INKM }); knob.position.set(-sd * (DW / 2 - .004), DH * .48, .0016); piv.add(knob);
      return { piv, sd }; });
  });
  // 门里漏出的暖光，铺在广场上
  for (const c of C) { const m = new THREE.Mesh(new THREE.PlaneGeometry(DW * 1.2, .05), new THREE.MeshBasicMaterial({ color: '#FFC46B', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.geometry.translate(0, -.025, 0); m.rotation.x = -Math.PI / 2; m.position.set(c, .0012, fz + .0005); body.add(m); spill.push(m); }
  const openAmt = (i, t) => { const u = seg(t, T_DOOR[i], T_DOOR[i] + .42); return u <= 0 ? 0 : back(u, 1.4); };
  return {
    g, panels, doors, openAmt,
    update(t) {
      const p = Math.max(0, ctx.kit.popAt(t, T_GATE, .5)); g.visible = p > .002;
      body.scale.set(1 + .14 * (1 - Math.min(1, p)) * (p > 0), Math.max(1e-3, p), 1);
      doors.forEach((pair, i) => { const pre = .04 * Math.sin(Math.PI * seg(t, T_DOOR[i] - .12, T_DOOR[i])); const a = openAmt(i, t);
        for (const { piv, sd } of pair) piv.rotation.y = sd * (a * 1.85 - pre);
        panels[i].material.userData.U.uGlow.value = .32 * clamp(a); spill[i].material.opacity = .22 * clamp(a); });
    },
    retract(r) { const u = ss(seg(r, 0, .5)); doors.forEach((pair, i) => pair.forEach(({ piv, sd }) => { piv.rotation.y *= 1 - u; })); body.scale.y = Math.max(1e-3, body.scale.y * (1 - ss(seg(r, .5, 1)))); g.visible = body.scale.y > .003; },   // 返修：先关门（r 0–.5），门关好再折平（r .5–1）
  };
}
// 门里的面板：「01 角色叙事」（序号朱红）/ 朱红短线（= 原文的｜）/ 问题分两行
const QBREAK = [['这个角色', '为什么适合场景？'], ['哪些视觉特点', '值得保留？'], ['有什么故事', '值得一起讲？']];
function doorArt(i) {
  const PXM = 10000, w = Math.round(.044 * PXM), h = Math.round(.058 * PXM), c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const [head, q] = TEXT.ch5.doors[i].split('｜'), [num, ...rest] = head.split(' '), name = rest.join(' ');
  if (q.replace(/\s/g, '') !== QBREAK[i].join('')) throw new Error('门 ' + i + ' 的问题拆行与白名单不一致');
  x.fillStyle = '#FFF4DE'; x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgba(185,160,255,.18)'; for (let yy = 18; yy < h; yy += 26) for (let xx = (yy / 26 % 2) * 13 + 10; xx < w; xx += 26) { x.beginPath(); x.arc(xx, yy, 3.2, 0, 7); x.fill(); }
  x.strokeStyle = M.INKM; x.lineWidth = 6; x.strokeRect(10, 10, w - 20, h - 20);
  x.textBaseline = 'alphabetic'; x.textAlign = 'left';
  const pad = 34; let y = 128;
  x.font = '800 72px InterF'; x.fillStyle = '#BE3A2E'; x.fillText(num, pad, y); const nw = x.measureText(num).width;
  x.font = '700 62px SC'; x.fillStyle = '#3A2A20'; x.fillText(name, pad + nw + 12, y);
  x.fillStyle = '#BE3A2E'; x.fillRect(pad, y + 30, 64, 9);
  x.font = '500 47px SCM'; x.fillStyle = '#3A2A20'; QBREAK[i].forEach((ln, j) => x.fillText(ln, pad, y + 120 + j * 66));
  return c;
}

// —— 风琴折纸：书边一摞竖着的纸板，一拍里像手风琴一样向外摊开，落在桌面上 ——
function accordion(ctx, side) {
  const cfg = { right: { N: 9, L: .27, o: [.2405, 0, 0], ry: 0, tl: T_SIDE }, left: { N: 6, L: .23, o: [-.2405, 0, -.015], ry: Math.PI, tl: T_SIDE }, front: { N: 6, L: .47, o: [0, 0, .1425], ry: -Math.PI / 2, tl: T_FRONT } }[side];
  const a = .021, N = cfg.N, L = cfg.L, g = new THREE.Group(); g.position.set(...cfg.o); g.rotation.y = cfg.ry; worldG.add(g);
  const art = accArt(side, N * a, L), tex = new THREE.CanvasTexture(art); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
  const panels = [];
  for (let i = 0; i < N; i++) {
    const geo = new THREE.PlaneGeometry(a, L); geo.rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv; for (let j = 0; j < uv.count; j++) uv.setX(j, (i + uv.getX(j)) / N);
    const m = M.memMat({ col: '#FFFFFF', line: 0, shape: 2, side: THREE.DoubleSide, boost: .28 }); m.map = tex;
    const mesh = new THREE.Mesh(geo, m); mesh.receiveShadow = true; mesh.castShadow = true;
    const piv = new THREE.Group(); piv.add(mesh); mesh.position.x = a / 2; g.add(piv); panels.push(piv);
  }
  // 展开后上面的小东西（世界坐标里摆，跟着 worldG）
  const deco = [];
  const addDeco = (obj, lx, lz) => { const v = new THREE.Vector3(lx, .0006, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), cfg.ry).add(new THREE.Vector3(...cfg.o)); obj.position.copy(v); worldG.add(obj); deco.push(obj);
    items.push({ g: obj, k: Math.min(GROW_STEPS - 1, Math.max(wave(v.x, v.z), Math.ceil((cfg.tl - T_GROW0) / .125) + 2)), kind: 'tree' }); };
  const RR = P.mulb(side.length * 31);
  if (side === 'right') { for (let i = 0; i < 16; i++) { const lx = .02 + RR() * (N * a - .03), lz = (RR() - .5) * (L - .03); if (Math.hypot(lx - .1, lz - .03) < .045) continue; addDeco(M.tree(Math.floor(RR() * 5), RR, .9 + RR() * .4), lx, lz); } }
  if (side === 'left') { for (let i = 0; i < 7; i++) { const lx = .025 + RR() * (N * a - .045), lz = (RR() - .5) * (L - .05); const h = M.mbox(.016, .01 + RR() * .008, .014, { col: pick(SAT), top: pick(PAST), win: { w: .006, h: .007, base: .004, lit: .5 } }); const r = M.mroof(.018, .008, .016, { col: pick([PAL.cobalt, PAL.pink, PAL.yellow]) }); r.position.y = h.geometry.parameters.height; const gg = new THREE.Group(); gg.add(h, r); addDeco(gg, lx, lz); }
    for (let i = 0; i < 10; i++) addDeco(M.tree(Math.floor(RR() * 5), RR, .8 + RR() * .3), .01 + RR() * (N * a - .02), (RR() - .5) * (L - .02)); }
  if (side === 'front') { for (let i = 0; i < 14; i++) { const lz = (i / 13 - .5) * (L - .04); addDeco(M.tree(i % 5, RR, .85), .012, lz + .004); if (i % 2) addDeco(M.tree((i + 2) % 5, RR, .8), N * a - .012, lz); } }
  const ang = t => { const tl = cfg.tl, u = seg(t, tl - .38, tl); return 90 * (1 - eio(u)) + 4 * Math.sin(Math.PI * seg(t, tl, tl + .16)); };
  const setA = th => { const c = Math.cos(th * D2R), s = Math.sin(th * D2R); let x = 0, y = 0;
    panels.forEach((p, i) => { const up = i % 2 === 0; const nx = x + a * c, ny = up ? a * s : 0; p.position.set(x, y + .0004 + i * 1e-5, 0); p.rotation.z = Math.atan2(ny - y, nx - x); x = nx; y = ny; }); };
  return {
    g, deco,
    update(t) { g.visible = t >= T_FLAT; setA(ang(t)); },
    retract(r) { const u = ss(seg(r, .55, 1)); setA(Math.max(ang(lastT), 90 * u)); g.visible = g.visible && u < .999; },
  };
}
function accArt(side, Wm, Lm) {
  const K = 4000, w = Math.round(Wm * K), h = Math.round(Lm * K), c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const RR = P.mulb(side.length * 7 + 3);
  const grain = () => { for (let i = 0; i < w * h / 900; i++) { x.fillStyle = `rgba(${RR() < .5 ? '255,255,255' : '90,70,50'},${.05 + RR() * .06})`; x.fillRect(RR() * w, RR() * h, 1 + RR() * 2, 1 + RR() * 2); } };
  if (side === 'right') {
    x.fillStyle = PAL.mintL; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(47,203,122,.25)'; for (let yy = 8; yy < h; yy += 22) for (let xx = (yy / 22 % 2) * 11 + 6; xx < w; xx += 22) { x.beginPath(); x.arc(xx, yy, 3, 0, 7); x.fill(); }
    // 池塘
    x.save(); x.translate(.1 * K, h / 2 + .03 * K); x.beginPath(); x.ellipse(0, 0, .04 * K, .055 * K, .3, 0, 7); x.fillStyle = PAL.sky; x.fill(); x.lineWidth = 7; x.strokeStyle = M.INKM; x.stroke();
    x.strokeStyle = '#FFFFFF'; x.lineWidth = 5; x.lineCap = 'round'; for (let i = 0; i < 6; i++) { const yy = (i - 2.5) * 30, xx = (i % 2) * 30 - 15; x.beginPath(); for (let k = 0; k <= 12; k++) x.lineTo(xx + k * 4 - 24, yy + Math.sin(k * 1.1) * 5); x.stroke(); }
    x.restore();
    x.strokeStyle = '#FFF6E4'; x.lineWidth = .009 * K; x.lineCap = 'round'; x.beginPath(); x.moveTo(0, h * .2); x.bezierCurveTo(w * .6, h * .1, w * .2, h * .7, w, h * .85); x.stroke();
  } else if (side === 'left') {
    const bands = [PAL.peachL, PAL.lilacL, PAL.butter, PAL.blush];
    for (let i = 0; i < 6; i++) { x.fillStyle = bands[i % 4]; x.fillRect(0, i * h / 6, w, h / 6 + 1); }
    x.strokeStyle = 'rgba(37,33,74,.18)'; x.lineWidth = 4; for (let i = 0; i < 6; i++) for (let k = 0; k < w; k += 18) { x.beginPath(); x.moveTo(k, i * h / 6 + 10); x.lineTo(k + 9, (i + 1) * h / 6 - 10); x.stroke(); }
  } else {
    x.fillStyle = PAL.blush; x.fillRect(0, 0, w, h);
    const rw = .03 * K, ry = w * .5;                       // 环路（沿书前沿），两端圆头
    x.fillStyle = '#FFF6E4'; x.strokeStyle = M.INKM; x.lineWidth = 7;
    x.beginPath(); x.roundRect(ry - rw / 2, .02 * K, rw, h - .04 * K, rw / 2); x.fill(); x.stroke();
    x.strokeStyle = PAL.yellow; x.lineWidth = 6; x.setLineDash([22, 18]); x.beginPath(); x.moveTo(ry, .04 * K); x.lineTo(ry, h - .04 * K); x.stroke(); x.setLineDash([]);
    x.fillStyle = 'rgba(255,255,255,.55)'; for (let yy = 20; yy < h; yy += 34) x.fillRect(8, yy, 10, 10), x.fillRect(w - 18, yy + 17, 10, 10);
  }
  grain();
  x.strokeStyle = 'rgba(37,33,74,.55)'; x.lineWidth = 3; for (let i = 1; i < 12; i++) { x.beginPath(); x.moveTo(i * .021 * K, 0); x.lineTo(i * .021 * K, h); x.stroke(); }   // 折痕
  return c;
}

// —— 地面印刷 ——
function groundArt(half, plan) {
  const K = 5000, PW = .472, PD = .274, w = Math.round(PW * K), h = Math.round(PD * K), c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  // 世界 (x, z) → 画布像素
  const toC = half === 'near' ? (X, Z) => [(X + PW / 2) * K, (Z + .136) * K] : (X, Z) => { const s = (P.ZH - Z) / COS_FAR; return [(X + PW / 2) * K, h - (s - .004) * K]; };
  // 色区：按区域聚类的粉彩（孟菲斯：同色成片，不要撒点）
  const seeds = [[-.15, -.33, PAL.butter], [.0, -.36, PAL.lilacL], [.16, -.33, PAL.mintL], [-.16, -.18, PAL.peachL], [.15, -.2, PAL.blush], [-.17, -.04, PAL.mintL], [.08, -.06, PAL.butter], [.2, .05, PAL.lilacL], [-.17, .09, PAL.ice], [.03, -.21, PAL.peachL]];
  const img = x.createImageData(w, h), d = img.data;
  const rgb = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const SC = seeds.map(s => rgb(s[2]));
  const inv = half === 'near' ? (px, py) => [px / K - PW / 2, py / K - .136] : (px, py) => [px / K - PW / 2, P.ZH - ((h - py) / K + .004) * COS_FAR];
  for (let py = 0; py < h; py += 2) for (let px = 0; px < w; px += 2) {
    const [X, Z] = inv(px, py); let bi = 0, bd = 1e9; seeds.forEach((s, i) => { const dd = (s[0] - X) ** 2 + (s[1] - Z) ** 2; if (dd < bd) { bd = dd; bi = i; } });
    const [r, gg, b] = SC[bi]; for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const k = ((py + oy) * w + px + ox) * 4; d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255; }
  }
  x.putImageData(img, 0, 0);
  // 地块上的小图案：水磨石碎点
  const RR = P.mulb(half === 'near' ? 11 : 12);
  for (let i = 0; i < 2600; i++) { const px = RR() * w, py = RR() * h; x.fillStyle = [PAL.pink, PAL.sky, PAL.yellow, '#FFFFFF', PAL.lilac][Math.floor(RR() * 5)]; x.globalAlpha = .55; x.beginPath(); x.ellipse(px, py, 3 + RR() * 5, 2 + RR() * 3, RR() * 3, 0, 7); x.fill(); }
  x.globalAlpha = 1;
  // 广场（近半页前沿）：粉色水磨石 + 同心圆铺装
  if (half === 'near') {
    const [ax, ay] = toC(P.PLAZA.x0 - .02, P.PLAZA.z0 - .012), [bx, by] = toC(P.PLAZA.x1 + .02, P.PLAZA.z1 + .002);
    x.fillStyle = PAL.blush; x.beginPath(); x.roundRect(ax, ay, bx - ax, by - ay, 40); x.fill(); x.lineWidth = 8; x.strokeStyle = M.INKM; x.stroke();
    const [cx, cy] = toC(P.BANNER.x, (P.PLAZA.z0 + P.PLAZA.z1) / 2 + .005);
    for (let r = 8; r >= 1; r--) { x.beginPath(); x.ellipse(cx, cy, r * 52, r * 30, 0, 0, 7); x.fillStyle = r % 2 ? '#FFE3EE' : PAL.blush; x.fill(); }
    x.strokeStyle = PAL.pink; x.lineWidth = 5; for (let r = 1; r <= 8; r++) { x.beginPath(); x.ellipse(cx, cy, r * 52, r * 30, 0, 0, 7); x.stroke(); }
    x.fillStyle = PAL.cobalt; for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; x.beginPath(); x.arc(cx + Math.cos(a) * 9 * 52, cy + Math.sin(a) * 9 * 30, 9, 0, 7); x.fill(); }
  }
  // 街道 =「谈」字十笔：另画在一张透明画布上，跟着生长的波一圈圈印出来（摊平那一刻页面上只有色区，读不出字）
  const sc = document.createElement('canvas'); sc.width = w; sc.height = h; const y = sc.getContext('2d');
  const strokePath = (p, lw, col, dash) => { const x = y; x.beginPath(); p.forEach(([X, Z], i) => { const [px, py] = toC(X, Z); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.lineWidth = lw; x.strokeStyle = col; x.lineCap = 'round'; x.lineJoin = 'round'; x.setLineDash(dash || []); x.stroke(); x.setLineDash([]); };
  for (const s of P.STROKES) strokePath(s.p, (P.STREET_W + .011) * K, '#FFFFFF');            // 人行道（白）
  for (const s of P.STROKES) strokePath(s.p, (P.STREET_W + .0016) * K, M.INKM);              // 路沿
  for (const s of P.STROKES) strokePath(s.p, P.STREET_W * K, '#FFF3DE');                     // 路面
  for (const s of P.STROKES) strokePath(s.p, .0016 * K, PAL.yellow, [.006 * K, .005 * K]);   // 中线
  // 纸纹
  x.globalAlpha = .5; for (let i = 0; i < w * h / 500; i++) { x.fillStyle = RR() < .5 ? 'rgba(255,255,255,.25)' : 'rgba(90,70,50,.08)'; x.fillRect(RR() * w, RR() * h, 1 + RR() * 2, 1); } x.globalAlpha = 1;
  // 书脊一侧的折缝阴影
  const gg = half === 'near' ? x.createLinearGradient(0, 0, 0, .02 * K) : x.createLinearGradient(0, h, 0, h - .02 * K);
  gg.addColorStop(0, 'rgba(60,40,70,.28)'); gg.addColorStop(1, 'rgba(60,40,70,0)'); x.fillStyle = gg; x.fillRect(0, half === 'near' ? 0 : h - .02 * K, w, .02 * K);
  c.streets = sc;
  return c;
}
// 街道叠印层：世界坐标里离书脊中心的距离 < 当前波的半径才显现（与建筑生长同一个度量）
function streetLayer(canvas, half) {
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  const m = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: .92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.userData.R = { value: -1 };
  m.onBeforeCompile = sh => { sh.uniforms.uR = m.userData.R;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\n vWP = (modelMatrix * vec4(transformed, 1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP; uniform float uR;')
      .replace('#include <map_fragment>', `#include <map_fragment>\n float dd = length(vec2(vWP.x * .9, (vWP.z - (${P.ZH.toFixed(4)})) * 1.05)); diffuseColor.a *= 1. - smoothstep(uR - .012, uR, dd);`); };
  m.customProgramCacheKey = () => 'ch5street';
  const PW = .472, PD = .274, mesh = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD), m); mesh.rotation.x = -Math.PI / 2; mesh.receiveShadow = true;
  if (half === 'near') mesh.position.set(0, .00006, .001 - .0003 * 0); else mesh.position.set(0, .00006, -(.004 + PD / 2));
  return mesh;
}

// —— 小汽车（沿笔画的环线：两条车道 + 两端掉头）、行人（来回走，转身）——
function buildLife(ctx) {
  const RR = P.mulb(77);
  const carCols = [PAL.yellow, PAL.cobalt, PAL.pink, PAL.mint, PAL.peach, PAL.sky, PAL.lilac];
  const st = i => P.STROKES[i].p;
  const loops = [   // [A, B, 车数, 半页]
    [st(9)[0], st(9)[1], 2], [st(8)[1], st(8)[2], 2], [st(4)[1], st(4)[2], 1], [st(5)[0], st(5)[1], 1], [st(4)[0], st(4)[1], 1], [st(1)[0], st(1)[1], 1],
  ];
  loops.forEach(([A, B, n], li) => { for (let k = 0; k < n; k++) { const g = M.car(carCols[(li * 2 + k) % carCols.length], RR); const holder = new THREE.Group(); holder.add(g); placeOn(holder, 0, (A[1] + B[1]) / 2);
    cars.push({ g: holder, car: g, A, B, ph: k / n + RR() * .2, v: .022 + RR() * .008, far: (A[1] + B[1]) / 2 < P.ZH }); } });
  // 前沿环路（桌面上的风琴折纸）
  for (let k = 0; k < 3; k++) { const g = M.car(carCols[(k * 3 + 1) % carCols.length], RR); const holder = new THREE.Group(); holder.add(g); worldG.add(holder);
    cars.push({ g: holder, car: g, A: [-.2, .2025], B: [.2, .2025], ph: k / 3, v: .03, world: true }); }
  // 行人：广场上、店门口、前沿人行道
  const walks = [[[-.02, .06], [.05, .075]], [[.09, .065], [.16, .052]], [[-.025, .1], [.03, .118]], [[.11, .112], [.165, .1]], [[.02, .05], [.02, .07]],
    [[S.coffee.cx + .03, S.coffee.cz + .03], [S.coffee.cx + .052, S.coffee.cz + .007]], [[S.tea.cx - .025, S.tea.cz + .026], [S.tea.cx - .006, S.tea.cz + .04]],
    [[S.book.cx - .03, S.book.cz + .026], [S.book.cx + .02, S.book.cz + .026]], [[-.2, .176], [-.05, .176]], [[.06, .176], [.2, .176]]];
  const pc = [PAL.cobalt, PAL.pink, PAL.yellow, PAL.green, PAL.peach, PAL.lilac, PAL.sky, PAL.coral || PAL.pink];
  walks.forEach(([A, B], i) => { const g = M.person(pc[i % pc.length], RR); const holder = new THREE.Group(); holder.add(g);
    const world = A[1] > .14; if (world) worldG.add(holder); else placeOn(holder, A[0], A[1]);
    people.push({ g: holder, p: g, A, B, ph: RR(), v: .009 + RR() * .004, far: A[1] < P.ZH, world }); });
}
function lifeUpdate(t) {
  const born = Math.max(0, back(seg(t, T_LIFE - .3, T_LIFE + .1), 1.6)), vis = t >= T_LIFE - .3;
  for (const c of cars) {
    const [ax, az] = c.A, [bx, bz] = c.B, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = uz, nz = -ux, o = .0068;
    const loop = 2 * L + 2 * Math.PI * o; let s = ((t * c.v / loop + c.ph) % 1) * loop, x, z, hd;
    if (s < L) { x = ax + ux * s + nx * o; z = az + uz * s + nz * o; hd = Math.atan2(-uz, ux); }
    else if (s < L + Math.PI * o) { const a = (s - L) / o; const cx = bx, cz = bz; x = cx + (nx * Math.cos(a) + ux * Math.sin(a)) * o; z = cz + (nz * Math.cos(a) + uz * Math.sin(a)) * o; hd = Math.atan2(-uz, ux) - a; }
    else if (s < 2 * L + Math.PI * o) { const q = s - L - Math.PI * o; x = bx - ux * q - nx * o; z = bz - uz * q - nz * o; hd = Math.atan2(-uz, ux) + Math.PI; }
    else { const a = (s - 2 * L - Math.PI * o) / o; x = ax + (-nx * Math.cos(a) - ux * Math.sin(a)) * o; z = az + (-nz * Math.cos(a) - uz * Math.sin(a)) * o; hd = Math.atan2(-uz, ux) + Math.PI - a; }
    if (c.world) c.g.position.set(x, .0006, z); else if (c.far) c.g.position.set(x, 0, (z - P.ZH) / COS_FAR); else c.g.position.set(x, 0, z);
    c.g.rotation.y = hd; c.g.visible = vis; c.car.scale.setScalar(Math.max(1e-3, born));
    c.car.userData.body.position.y = .00025 * Math.abs(Math.sin(t * 9 + c.ph * 20));
  }
  for (const p of people) {
    const [ax, az] = p.A, [bx, bz] = p.B, L = Math.max(1e-4, Math.hypot(bx - ax, bz - az)), per = 2 * L / p.v + 1.2;
    const u = ((t / per + p.ph) % 1) * per, legT = L / p.v; let s, dir;
    if (u < legT) { s = u / legT; dir = 0; } else if (u < legT + .6) { s = 1; dir = ss((u - legT) / .6); } else if (u < 2 * legT + .6) { s = 1 - (u - legT - .6) / legT; dir = 1; } else { s = 0; dir = 1 - ss((u - 2 * legT - .6) / .6); }
    const x = ax + (bx - ax) * s, z = az + (bz - az) * s, walking = (u < legT) || (u > legT + .6 && u < 2 * legT + .6);
    if (p.world) p.g.position.set(x, .0006, z); else if (p.far) p.g.position.set(x, 0, (z - P.ZH) / COS_FAR); else p.g.position.set(x, 0, z);
    p.g.rotation.y = Math.atan2(-(bz - az), bx - ax) + Math.PI * dir;
    const ph = t * 7 + p.ph * 30; p.p.userData.body.position.y = walking ? .0004 * Math.abs(Math.sin(ph)) : 0;
    p.p.userData.legs.forEach((l, i) => { l.rotation.z = walking ? .45 * Math.sin(ph + i * Math.PI) : 0; });
    p.g.visible = vis; p.p.scale.setScalar(Math.max(1e-3, born));
  }
}
