// 第二章 角色叙事（第 11–30 小节，20.000–60.000 s）。分镜与决定：notes/ch2.md。纸件美术：ch2_art.js。
// 跨页：1（2a，接管开头的纸舞台与剧照卡）→ 第 14 小节翻到 2（2b 担当与协作）→ 第 20 小节翻到 3（2c 守护）→ 第 25 小节翻到 4（2d 陪伴与成长）。
// 翻页、台灯调光的声音由共用层自动配；本章音效在 sfx/ch2.json，全部用 "ev" 引用下面 events() 的 id。
// 全部是 t 的纯函数（不读上一帧）。
import * as THREE from 'three';
import { at, KEY, BEAT } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';
import { clamp, lerp, seg, ss, eo, eio } from '/core/lib.js';
import { E as EZ } from '../cover.js';
import { PX, tabArt } from '../art.js';
import * as AR from './ch2_art.js';

export const ID = 'ch2';
const PG = .023, PI = Math.PI;

// ———————————————— 时刻（全部 at()：画面与音效同一帧） ————————————————
const TA = { stop: KEY.ch2.stillStop, label: KEY.ch2.label, type: [1, 2, 3, 4, 5].map(i => at(11, 2, i)), sun: at(12) };
const TB = { turn: KEY.ch2.turnB, waves: [at(14, 2), at(14, 3), at(14, 4)], cardL: at(15), plateL: at(15, 2), cardR: at(17), plateR: at(17, 2) };
const TC = { turn: KEY.ch2.turnC, dim: at(20, 2), clouds: at(20, 3), roofs: at(20, 4), pull: at(21), moon: at(21, 3), card: at(22), plate: at(22, 2) };
const TD = {
  turn: KEY.ch2.turnD, cards: at(25, 2), label: at(25, 3), type: [1, 2, 3, 4, 5].map(i => at(25, 3, i)),
  // 返修：每小节第 1 拍转一次 90°（转动本身用一拍完成），四张卡依次转到正面、各停一小节；它的品格词在同一拍从转盘上弹起
  steps: [at(26), at(27), at(28), at(29)],                                                   // 50 / 52 / 54 / 56
};
const T_NEXT = KEY.ch3.turn;     // 60.0：第 4 页翻走（第三章）

// ———————————————— 相机 ————————————————
// camKey(fov°, 仰角°, 方位°, 目标 x, y, z, 画面可视高 m)。20–21 s 由共用层从开头的升降上摇衔接过来（位置+速度连续）
export const camera = [
  // 2a 自由与勇气：上升的镜头减速停住 → 拉远 + 下降露出整个纸舞台
  [21.0, camKey(22, 4.5, 3, -.022, PG + .166, -.11, .206)],
  [22.2, camKey(22, 5.5, 1.5, -.02, PG + .164, -.11, .212)],
  [24.6, camKey(25, 16, -3, 0, PG + .1, -.05, .36)],
  [25.6, camKey(26, 20, -1, 0, PG + .08, -.035, .37)],
  // 2b 担当与协作：3/4 全景 → 推近左卡 → 横移到右卡 → 拉远两卡同框
  [26.6, camKey(26, 22, 0, 0, PG + .066, -.03, .345)],
  [27.8, camKey(25, 19, 3, -.012, PG + .06, -.03, .31)],
  [29.3, camKey(23, 13, 12, -.088, PG + .05, -.035, .2)],
  [30.6, camKey(23, 13, 9, -.078, PG + .05, -.035, .198)],
  [32.4, camKey(23, 13, -9, .088, PG + .05, -.035, .2)],
  [33.7, camKey(23, 13, -12, .094, PG + .05, -.035, .198)],
  [35.4, camKey(26, 20, 0, 0, PG + .058, -.03, .335)],
  [37.3, camKey(26, 23, 0, 0, PG + .064, -.03, .345)],
  // 2c 守护：低机位推轨 → 上摇跟月亮 → 下摇推近卡片 → 拉远
  [38.6, camKey(26, 22, 0, 0, PG + .066, -.03, .345)],
  [39.7, camKey(24, 11, -5, .01, PG + .075, -.06, .27)],
  [41.3, camKey(24, 7, -3, .04, PG + .13, -.09, .27)],
  [42.9, camKey(23, 10, 3, .02, PG + .085, -.05, .25)],
  [46.2, camKey(21, 11, 6, 0, PG + .056, -.035, .188)],
  [47.4, camKey(26, 22, 0, 0, PG + .066, -.03, .345)],
  // 2d 陪伴与成长：全景 → 缓推 → 环绕（与转盘反向）→ 推近 → 拉远升高交给第三章
  [48.6, camKey(26, 22, 0, 0, PG + .066, -.03, .345)],
  [49.8, camKey(24, 18, 0, 0, PG + .072, -.03, .285)],
  // 返修：50–56 推近，正面卡占画面高 ≥ 40%；小幅环绕（与转盘反向）
  [51.2, camKey(24, 15, -9, 0, PG + .074, -.002, .218)],
  [53.2, camKey(24, 14, 7, 0, PG + .074, .004, .212)],
  [55.2, camKey(23, 13, -5, 0, PG + .074, .008, .208)],
  [56.4, camKey(23, 13, 1, 0, PG + .074, .006, .212)],
  [58.6, camKey(26, 24, 0, 0, PG + .07, -.03, .36)],
  [59.4, camKey(26, 24, 0, 0, PG + .07, -.03, .36)],
];

// ———————————————— 台灯（规范：第 20 小节翻页后真的调暗；第 25 小节翻页恢复） ————————————————
export const lamp = [
  { t: TC.dim, dur: .3, dim: .25 },
  { t: TD.turn, dur: .25, dim: 1 },
];

// ———————————————— 事件（画面落点；sfx: true = 必须有声音） ————————————————
export function events() {
  const E = [], add = (t, type, id, o = {}) => E.push({ t, type, id, sfx: true, ...o });
  add(TA.stop, 'still_stop', 'ch2.a.stop');
  add(TA.label, 'label', 'ch2.a.label');
  TA.type.forEach((t, i) => add(t, 'type', `ch2.a.type.${i}`, { i }));
  add(TA.sun, 'pop', 'ch2.a.sun');
  TB.waves.forEach((t, i) => add(t, 'fold', `ch2.b.wave.${i}`, { i }));
  add(TB.cardL, 'card_up', 'ch2.b.cardL'); add(TB.plateL, 'plate', 'ch2.b.plateL');
  add(TB.cardR, 'card_up', 'ch2.b.cardR'); add(TB.plateR, 'plate', 'ch2.b.plateR');
  add(TC.clouds, 'fold', 'ch2.c.clouds'); add(TC.roofs, 'fold', 'ch2.c.roofs');
  add(TC.pull, 'pull', 'ch2.c.pull', { dur: TC.moon - TC.pull }); add(TC.moon, 'notch', 'ch2.c.moon');
  add(TC.card, 'card_up', 'ch2.c.card'); add(TC.plate, 'plate', 'ch2.c.plate');
  add(TD.cards, 'card_up', 'ch2.d.cards'); add(TD.label, 'label', 'ch2.d.label');
  TD.type.forEach((t, i) => add(t, 'type', `ch2.d.type.${i}`, { i }));
  TD.steps.forEach((t, k) => add(t, 'turntable', `ch2.d.step.${k}`, { k }));
  TD.steps.forEach((t, i) => add(t, 'word', `ch2.d.word.${i}`, { i }));
  return E;
}

// ———————————————— 搭建 ————————————————
const S = {};
const shown = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
const sizeOf = (c, ppm = PX) => [c.width / ppm, c.height / ppm];

export async function build(ctx) {
  const K = ctx.kit, B = ctx.book, PW = ctx.PW, PD = ctx.PD;
  const plate = (title, sub, o) => { const c = AR.plateArt(title, sub, { ...o, font: K.font }); const [w, h] = sizeOf(c, AR.TPX); return K.piece(c, w, h, { border: 16 }); };

  // —— 2a：跨页 1（开头的纸舞台）——
  const sp1 = B.spread(1);
  S.labelA = K.label(TEXT.ch2.a.title, { w: .118, h: .03 });
  S.labelA.g.position.set(-.105, 0, -.1175); sp1.root.add(S.labelA.g);
  { const c = AR.sunburstArt(.066, .083, 22), [w] = sizeOf(c), p = K.piece(c, w, w, { border: 14 });
    p.position.y = -w / 2; S.sun = new THREE.Group(); S.sun.add(p); S.sun.position.set(0, .193, .0016); sp1.back.add(S.sun); }

  // —— 2b：跨页 2（群青海）——
  const sp2 = B.spread(2);
  sp2.setBackdrop(AR.seaBackArt(PW, PD)); sp2.setFloor(AR.seaFloorArt(PW, PD));
  const WH = [.052, .04, .024], WZ = [-.112, -.09, .032];
  S.waves = WH.map((h, k) => { const c = AR.waveArt(.44, h, k), [w, hh] = sizeOf(c); const g = K.vfold(c, w, hh, { border: 18 }); g.position.z = WZ[k]; sp2.root.add(g); return g; });
  S.cardL = K.card(await ctx.ip('p06_nezha'), { h: .088 }); S.cardL.position.set(-.1, 0, -.056); sp2.root.add(S.cardL);
  S.cardR = K.card(await ctx.ip('p06_hulu'), { h: .088 }); S.cardR.position.set(.1, 0, -.056); sp2.root.add(S.cardR);
  const tb = TEXT.ch2.b;
  S.plateL = plate(tb.left, tb.leftSub); S.plateL.position.set(-.1, 0, .088); sp2.root.add(S.plateL);
  S.plateR = plate(tb.right, tb.rightSub); S.plateR.position.set(.1, 0, .088); sp2.root.add(S.plateR);

  // —— 2c：跨页 3（靛蓝夜）——
  const sp3 = B.spread(3);
  sp3.setBackdrop(AR.nightBackArt(PW, PD)); sp3.setFloor(AR.nightFloorArt(PW, PD));
  { const c = AR.nightCloudArt(.44, .128, .088), [w, h] = sizeOf(c); S.nClouds = K.vfold(c, w, h, { border: 18 }); S.nClouds.position.z = -.12; sp3.root.add(S.nClouds); }
  { const c = AR.roofsArt(.44, .066), [w, h] = sizeOf(c); S.roofs = K.vfold(c, w, h, { border: 18 }); S.roofs.position.z = -.09; sp3.root.add(S.roofs); }
  S.cardC = K.card(await ctx.ip('p07_heimao'), { h: .095 }); S.cardC.position.set(0, 0, -.036); sp3.root.add(S.cardC);
  S.plateC = plate(TEXT.ch2.c.title, TEXT.ch2.c.sub, { wM: .11 }); S.plateC.position.set(0, 0, .088); sp3.root.add(S.plateC);
  S.tab = K.cutPiece(tabArt(.026, .07), .026 + 60 / PX, .07 + 60 / PX, { ay: 0 }); S.tab.rotation.x = -PI / 2; S.tab.position.set(.165, .0007, .162); sp3.root.add(S.tab);
  { const c = AR.moonArt(.04), [w] = sizeOf(c), p = K.piece(c, w, w, { border: 14 });
    p.position.y = -w / 2; S.moonMat = p.userData.f.material; S.moonMat.emissive = new THREE.Color('#dfe8ff'); S.moonMat.emissiveMap = p.userData.tex; S.moonMat.emissiveIntensity = 0;
    S.moon = new THREE.Group(); S.moon.add(p); S.moon.position.set(.1, .04, .0025); sp3.back.add(S.moon); }
  // 冷月光：蓝白聚光，从右前上方来，投卡片形状的影子（本章图层里，图层隐藏时自动关）
  const ml = new THREE.SpotLight('#a9c1ff', 0, 0, .5, .75, 1.6);
  ml.position.set(.2, .44, .36); ml.target.position.set(0, PG + .05, -.04);
  ml.castShadow = true; ml.shadow.mapSize.set(2048, 2048); ml.shadow.bias = -.0001; ml.shadow.normalBias = .0012; ml.shadow.camera.near = .05; ml.shadow.camera.far = 2; ml.shadow.radius = 4;
  ctx.root.add(ml, ml.target); S.moonLight = ml;

  // —— 2d：跨页 4（暖黄晴）——
  const sp4 = B.spread(4);
  sp4.setBackdrop(AR.sunnyBackArt(PW, PD)); sp4.setFloor(AR.sunnyFloorArt(PW, PD));
  S.tt = new THREE.Group(); S.tt.position.set(0, 0, -.03); sp4.root.add(S.tt);
  { const top = new THREE.MeshStandardMaterial({ map: ctx.kit.texOf(AR.turntableTopArt(.1)), roughness: .88 }), side = new THREE.MeshStandardMaterial({ color: '#5A4030', roughness: .9 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, .005, 96), [side, top, side]); disc.position.y = .0025; disc.castShadow = disc.receiveShadow = true; S.tt.add(disc); S.disc = disc; }
  S.rot = new THREE.Group(); S.rot.position.y = .0051; S.tt.add(S.rot);
  S.dCards = [];
  // 返修：每张卡站在一个群青小底座上（卡片立起时一起升起 2.1 cm），卡背印群青布纹（不再是空白纸块）；
  //       品格词牌钉在转盘上、就在自己那张卡前面，跟着卡一起转——哪张卡在正面，正面的词就是它的
  S.lifts = []; S.risers = [];
  const riserM = new THREE.MeshStandardMaterial({ color: '#33449A', roughness: .8 });
  for (const [i, key] of ['p08_xuehaizi', 'p08_afanti', 'p08_shuke', 'p08_tutu'].entries()) {
    const holder = new THREE.Group(); holder.rotation.y = i * PI / 2; S.rot.add(holder);
    const lift = new THREE.Group(); holder.add(lift); S.lifts.push(lift);
    const c = K.card(await ctx.ip(key), { h: .086 }); c.position.z = .062; lift.add(c); S.dCards.push(c);
    inkBack(c);
    const rw = c.userData.w * .82, rs = new THREE.Mesh(new THREE.BoxGeometry(rw, 1, .009).translate(0, .5, 0), riserM); rs.position.z = .0574; rs.castShadow = rs.receiveShadow = true; holder.add(rs); S.risers.push(rs);
  }
  S.words = TEXT.ch2.d.items.map((wd, i) => { const g = plate(wd, null, { wM: .066, hM: .03, tSize: .0165 }); g.position.set(0, .0002, .093); S.rot.children[i].add(g); return g; });
  S.labelD = K.label(TEXT.ch2.d.title, { w: .15, h: .034 }); S.labelD.g.position.set(0, .132, .004); sp4.back.add(S.labelD.g);
}

// ———————————————— 每帧 ————————————————
const typed = (t, list) => list.reduce((n, tt) => n + (t >= tt ? 1 : 0), 0);
const hop = (t, tb, a = .004) => a * Math.sin(PI * seg(t, tb - .06, tb + .24)) * (t > tb - .06 && t < tb + .24 ? 1 : 0);
function stand(K, g, t, tb, lean = .06, y0 = .0012) { const p = K.standAt(g, t, tb, .62, lean); g.position.y = y0 * (1 - clamp(p)); return p; }
// 转盘角：初始 +90°（大耳朵图图朝前），每一步 −90°，第 k 步到位 = TD.steps[k]（back() 过冲回弹）
// 返修：起始转盘斜 45°（雪孩子与大耳朵图图各露 3/4），第一次只转 45° 把雪孩子转正，之后每次 90°
function turnAngle(K, t) { let s = 0; TD.steps.forEach((tb, k) => { s += (k === 0 ? .5 : 1) * K.popAt(t, tb, .6); }); return PI / 4 - PI / 2 * s; }
const RISER = .021;
// 卡背：群青布面 + 金色细框 + 中心一枚金色同心圆（书封的颜色），四周留白边（与正面白边一致）
function inkBack(card) {
  const b = card.userData.b, tex = card.userData.tex, cw = 360, ch = Math.round(360 * card.userData.h / card.userData.w), c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const x = c.getContext('2d'), m = Math.round(Math.min(cw, ch) * .07);
  x.fillStyle = '#F4EEDF'; x.fillRect(0, 0, cw, ch);
  x.fillStyle = '#2F3F8F'; x.fillRect(m, m, cw - 2 * m, ch - 2 * m);
  x.globalAlpha = .16; x.strokeStyle = '#0E1846'; x.lineWidth = 1; for (let k = -ch; k < cw + ch; k += 5) { x.beginPath(); x.moveTo(m + k, m); x.lineTo(m + k - ch, m + ch); x.stroke(); }
  x.globalAlpha = 1; x.strokeStyle = '#D9B45A'; x.lineWidth = 3; x.strokeRect(m + 10, m + 10, cw - 2 * m - 20, ch - 2 * m - 20);
  const cx = cw / 2, cy = ch / 2; for (const r of [.16, .11, .06]) { x.beginPath(); x.arc(cx, cy, Math.min(cw, ch) * r, 0, Math.PI * 2); x.stroke(); }
  const pt = new THREE.CanvasTexture(c); pt.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: .5, roughness: .88, side: THREE.BackSide });
  mat.onBeforeCompile = sh => { sh.uniforms.uPat = { value: pt };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uPat;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb = texture2D(uPat, vec2(1.0 - vMapUv.x, vMapUv.y)).rgb;'); };
  mat.customProgramCacheKey = () => 'ch2cardback';
  b.material = mat;
}

export function update(t, ctx) {
  const K = ctx.kit, O = ctx.opening;
  // 背板上的挂件凸出背板 1–3 mm，比翻过来的书页间隔（0.8 mm）厚：只在自己的跨页里显示，翻走那一帧起隐藏（无论从哪一帧开始渲染都成立）
  S.sun.visible = t > TA.sun - .4 && t < TB.turn;
  S.moon.visible = t >= TC.clouds && t < TD.turn;
  S.labelD.g.visible = t > TD.label - .4 && t < T_NEXT;
  // —— 2a ——
  if (t < TB.turn + .8) {
    // 开头的旧标签在 20.5 向前扣倒（背面朝上）：同一画面只留一句话
    const f = eio(seg(t, TA.label, TA.label + .36));
    O.labelG.rotation.x = lerp(-1.1, PI / 2, f); O.labelG.position.y = .0009 * f;
    // 「自由与勇气」从第二、三层纸云之间升起，落在剧照卡左侧（与开头纸云同一条 popAt 曲线）
    const pr = K.popAt(t, TA.label, .5);
    S.labelA.g.position.y = lerp(.052, .124, pr); S.labelA.g.rotation.x = -.05;
    S.labelA.set(typed(t, TA.type));
    // 日芒：22.0 弹开，之后极慢转
    const ps = K.popAt(t, TA.sun, .6);
    S.sun.scale.setScalar(Math.max(.001, ps)); S.sun.rotation.z = -.045 * Math.max(0, t - TA.sun + .3) - .5 * (1 - clamp(ps));
  }
  // —— 2b ——
  if (t >= TB.turn - 1.2 && t < TC.turn + .8) {
    S.waves.forEach((g, k) => {
      const tb = TB.waves[k], p = stand(K, g, t, tb, 0, .0016 + .0003 * k);
      const amp = ss(seg(t, tb + .25, tb + 1.4)), u = (t - TB.waves[0]) / BEAT - k * .25, c = .5 + .5 * Math.cos(2 * PI * u);
      g.rotation.x += .075 * c * amp;                 // 浪峰：每拍向前一扑（后排在拍上，前两排各晚一个十六分）
      g.userData.setV((.07 + .1 * c * amp) * clamp(p));
      g.position.x = .004 * Math.sin(2 * PI * (t - TB.turn) / 8 + k * 1.3) * amp;
    });
    stand(K, S.cardL, t, TB.cardL, .06, .0024); stand(K, S.cardR, t, TB.cardR, .06, .0025);
    stand(K, S.plateL, t, TB.plateL, .9, .0028); stand(K, S.plateR, t, TB.plateR, .9, .0029);
  }
  // —— 2c ——
  const kMoon = ss(seg(t, TC.pull + .15, TC.moon + .1)) * (1 - ss(seg(t, TD.turn - .5, TD.turn)));
  if (t >= TC.turn - 1.2 && t < TD.turn + .8) {
    stand(K, S.nClouds, t, TC.clouds, 0, .0016); S.nClouds.userData.setV(.1 * clamp(K.popAt(t, TC.clouds)));
    stand(K, S.roofs, t, TC.roofs, 0, .0019); S.roofs.userData.setV(.13 * clamp(K.popAt(t, TC.roofs)));
    stand(K, S.cardC, t, TC.card, .06, .0024);
    stand(K, S.plateC, t, TC.plate, .9, .0028);
    // 拉片：40.0 第一帧开始动（起动类提前一帧），41.0 到位；月亮跟着从夜云后面升起
    const pu = EZ(seg(t, TC.pull - 1 / 30, TC.moon));
    S.tab.position.z = .162 + .045 * pu;
    S.moon.position.y = lerp(.04, .182, pu) + .0015 * Math.sin(PI * seg(t, TC.moon, TC.moon + .2));   // 到档轻轻一顿
    S.moonMat.emissiveIntensity = .7 * kMoon;
  }
  S.moonLight.intensity = 1.15 * kMoon;
  S.moonLight.visible = kMoon > 0;
  if (kMoon > 0) { ctx.post.vig.uniforms.warm.value *= 1 - .85 * kMoon; ctx.post.vig.uniforms.amt.value += .08 * kMoon; }
  // —— 2d ——
  if (t >= TD.turn - 1.2) {
    S.dCards.forEach((g, i) => { const p = stand(K, g, t, TD.cards, .03, .0012 + .0002 * i), u = clamp(p); S.lifts[i].position.y = RISER * u; S.risers[i].scale.y = Math.max(1e-3, RISER * u); S.risers[i].visible = u > .01; });
    S.rot.rotation.y = turnAngle(K, t);
    S.words.forEach((g, i) => {   // 卡第一次转到正面的那一拍弹起（back 回弹，第一次到位 = 拍），立着后仰 .75
      const p = Math.max(0, K.popAt(t, TD.steps[i], .5)); g.scale.setScalar(Math.max(1e-3, p)); g.visible = p > .01; g.rotation.x = -.75;
    });
    const pl = clamp(K.popAt(t, TD.label, .62)); S.labelD.g.rotation.x = PI / 2 * (1 - pl);   // 贴在背板上：从"架子"翻上去贴平（不过冲，免得穿进背板）
    S.labelD.set(typed(t, TD.type));
  }
}

// ———————————————— 画面文字（全部来自 TEXT） ————————————————
export function texts(t, ctx) {
  const out = [], box = (id, text, g) => { if (!shown(g)) return; const b = ctx.screenBox(g); if (b) out.push({ id, text, ...b }); };
  if (t >= TA.type[0] && t < TB.turn) box('ch2.a.title', TEXT.ch2.a.title, S.labelA.g);
  const tb = TEXT.ch2.b;
  if (t >= TB.plateL - .15 && t < TC.turn) { box('ch2.b.left', tb.left, S.plateL); box('ch2.b.leftSub', tb.leftSub, S.plateL); }
  if (t >= TB.plateR - .15 && t < TC.turn) { box('ch2.b.right', tb.right, S.plateR); box('ch2.b.rightSub', tb.rightSub, S.plateR); }
  if (t >= TC.plate - .15 && t < TD.turn) { box('ch2.c.title', TEXT.ch2.c.title, S.plateC); box('ch2.c.sub', TEXT.ch2.c.sub, S.plateC); }
  if (t >= TD.type[0] && t < T_NEXT) box('ch2.d.title', TEXT.ch2.d.title, S.labelD.g);
  TEXT.ch2.d.items.forEach((w, i) => { const a = Math.atan2(Math.sin(S.rot.rotation.y + i * PI / 2), Math.cos(S.rot.rotation.y + i * PI / 2));
    if (t >= TD.steps[i] - .1 && t < T_NEXT && Math.abs(a) < 1.0 && S.words[i].visible) box(`ch2.d.item.${i}`, w, S.words[i]); });
  return out;
}
export function probe(t) {
  return { labelA: +S.labelA.g.position.y.toFixed(4), sun: +S.sun.scale.x.toFixed(3), moon: +S.moon.position.y.toFixed(4), moonLight: +S.moonLight.intensity.toFixed(3),
    turn: +(S.rot.rotation.y * 180 / PI).toFixed(2), cardL: +S.cardL.rotation.x.toFixed(4), cardR: +S.cardR.rotation.x.toFixed(4), cardC: +S.cardC.rotation.x.toFixed(4) };
}
