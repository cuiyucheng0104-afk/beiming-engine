// 第三章 美术语言（第 31–48 小节，60–96 s，跨页 5）。分镜与全部自行决定见 notes/ch3.md。
// 结构：纸框舞台（立在地面页上）+ 框里一块 12 片的百叶翻板（挂在背板前）+ 前沿一根长拉片（四档）。
// 每拉一档 → 百叶从左到右翻 180°，翻过来的一面是下一种真材料（宣纸水墨 / 壁画土墙 / 红纸剪纸 / 毛毡），再在这一面上显影（墨晕、卷草纹生长、窗花一刀刀剪出、贴布字）。
// 时间表在 ch3_cues.js（纯数据，sfx/ch3.json 也由它生成），画布与显影着色器在 ch3_art.js。
//
// 需求（给合成阶段）：见 notes/ch3.md 与返回的 requests；本文件不改任何共用层。
import * as THREE from 'three';
import { at, KEY, BOOK } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';
import { clamp, lerp, seg, ss, eio, eo, ei, back } from '/core/lib.js';
import { popAt } from '../stage.js';
import * as A from '../art.js';
import { C, PULLS, FLIP, SINK, EVENTS } from './ch3_cues.js';
import * as R from './ch3_art.js';

export const ID = 'ch3';
const PG = .023;
const T3 = TEXT.ch3;

// —————————————————— 相机（全片秒；60/96 s 两端各 0.5 s 由共用层衔接）——————————————————
// camKey(fov°, 仰角°, 方位°, 目标 x, y, z, 可视高 m)
export const camera = [
  [60.6, camKey(27, 23, -3, 0, PG + .105, -.035, .37)],          // 升高拉远：全景（纸框 + 拉片）
  [62.2, camKey(26, 21, 0, .01, PG + .1, -.03, .355)],
  [63.4, camKey(26, 20, 5, .035, PG + .095, -.02, .345)],         // 右摇到拉头
  [64.6, camKey(26, 18, 2, 0, PG + .115, -.06, .32)],           // 翻板落定：正面中景
  [66.0, camKey(26, 17, 0, -.01, PG + .115, -.065, .31)],
  [70.6, camKey(24, 14, -5, -.02, PG + .118, -.07, .285)],       // 慢推：远山 + 两张水墨卡
  [71.6, camKey(26, 19, 2, .02, PG + .1, -.035, .33)],            // 拉回看拉片
  [72.7, camKey(25, 14, -15, -.06, PG + .115, -.065, .3)],      // 低机位从左开始横移
  [76.0, camKey(25, 13, -2, 0, PG + .115, -.065, .295)],
  [79.0, camKey(25, 14, 12, .055, PG + .115, -.065, .3)],         // 横移到右
  [79.7, camKey(26, 19, 3, .02, PG + .1, -.035, .33)],
  [80.7, camKey(24, 14, 3, -.055, .168, -.11, .235)],         // 推近团花（焦点在红纸）
  [82.4, camKey(24, 13, 1, -.06, .166, -.11, .225)],
  [83.4, camKey(25, 14, -2, .005, .155, -.09, .27)],
  [85.0, camKey(25, 15, -4, .03, PG + .11, -.065, .3)],            // 后拉右摆，跟焦到卡片
  [87.2, camKey(25, 16, -2, .02, PG + .11, -.06, .31)],
  [87.8, camKey(26, 19, 2, .02, PG + .1, -.035, .33)],
  [88.7, camKey(26, 16, 0, 0, PG + .11, -.05, .32)],
  [90.0, camKey(25, 12, 0, 0, PG + .1, -.04, .3)],             // 低机位推进舞台口
  [93.6, camKey(24, 9, 2, 0, PG + .1, -.045, .27)],              // 返修：推近收在 .27、目标抬高 1.2 cm，「木偶」标题不再被上沿切掉
  [95.5, camKey(26, 20, 0, 0, PG + .08, -.03, .34)],              // 升高拉远，交给第四章
];
// —————————————————— 台灯：木偶段调暗、结尾恢复 ——————————————————
export const lamp = [
  { t: C.puppet.dim, dur: .3, dim: .28 },
  { t: C.puppet.restore, dur: .4, dim: 1 },
];
const EV = EVENTS();
export function events() { return EV.map(e => ({ t: e.t, type: e.type, id: e.id, sfx: true })); }

// —————————————————— 布局 ——————————————————
const PANEL_Y = .02, PANEL_Z = .021;            // 翻板：下沿离背板底 2 cm，离背板 2.1 cm（片宽一半 1.79 cm + 余量）
const FRAME_Z = -.098, FRAME = { w: .46, h: .262, win: [-.205, .205, .035, .252] };
const RAIL = { z: .105, w: .40, h: .03, notch: [-.12, -.04, .04, .12], rest: -.175 };
const CARDS = {   // 卡高 h（米）、位置；mode：rise = 从切口升起，stand = 向前扣倒 → 立起
  p04_kedou: { h: .11, x: -.085, z: -.055, d: .9 }, p10_mudi: { h: .145, x: .118, z: -.035, d: .9 },
  p09_jiuselu: { h: .145, x: -.12, z: -.04 }, p09_tianshu: { h: .105, x: .088, z: -.058 },
  p11_hailuo: { h: .15, x: .105, z: -.035 }, p11_afanti_puppet: { h: .105, x: 0, z: -.05 },
};
const MATS = ['blank', 'ink', 'mural', 'paper', 'puppet'];
const SECT = { ink: C.ink, mural: C.mural, paper: C.paper, puppet: C.puppet };
const FILMS = { ink: T3.ink.films, mural: T3.mural.films, paper: T3.paper.films, puppet: T3.puppet.films };
const LEAN = 1.08;
// 第 k 档的卡片在第 k+1 次拉片时沉下（最后一档不沉，随翻页压平）
const exitOf = mi => (mi < 4 ? PULLS[mi].pull : 1e9);

let S = null;   // 本章全部句柄
export async function build(ctx) {
  const K = ctx.kit, sp = ctx.book.spread(5);
  const [silk, xuan, xuanB, wall, red] = await Promise.all(['装裱绫绢.png', '宣纸.png', '宣纸_逆光.png', '壁画土墙.png', '红纸.png'].map(f => K.img(f)));
  // —— 地面页、背板 ——
  const slits = Object.values(CARDS).map(c => [c.x, c.z, c.h * (c.h > .1 ? .72 : 1.86) + .01]);
  sp.setFloor(R.floorArt(silk, ctx.PW, ctx.PD, slits.slice(0, 5)));
  sp.setBackdrop(R.backArt(ctx.PW, ctx.PD));
  // —— 五张面 ——
  const fibC = R.fiberMap(xuanB);
  const fib = ctxTex(fibC, { linear: true });
  const blank = R.blankPanel(silk, T3.title, C.title, C.sq, 60);
  const ink = R.inkPanel(xuan, fibC, { title: T3.ink.name, titleT: C.ink.title, sealT: C.ink.seal, farT: C.ink.far, nearT: C.ink.near }, KEY.ch3.ink);
  const mural = R.muralPanel(wall, { title: T3.mural.name, sub: T3.mural.sub, titleT: C.mural.title, subT: C.mural.sub, vineT: C.mural.vine, vineDur: C.mural.vineDur, cloudT: C.mural.clouds }, KEY.ch3.mural);
  const paper = R.paperPanel(red, { title: T3.paper.name, titleT: C.paper.title, cutT: C.paper.cuts, cornerT: C.paper.corners }, KEY.ch3.paper);
  const feltB = R.feltCanvas(R.CW, R.CHh, '#272A55', 3);
  const puppet = R.feltPanel(feltB, { title: T3.puppet.name, titleT: C.puppet.title }, KEY.ch3.puppet);
  const P = { blank, ink, mural, paper, puppet };
  const mk = (Base, opts, p, mode, T0, span, soft) => { const L = p.L.textures();
    return R.revealMat(Base, { map: ctxTex(p.base), ...opts }, { mode, col: ctxTex(p.col), den: L.den, arr: L.arr, fib, T0, span, soft }); };
  const bump = (img, o) => ctxTex(R.grayOf(img, R.CW, R.CHh, o), { linear: true });
  const mats = [
    mk(THREE.MeshStandardMaterial, { roughness: .8, bumpMap: bump(silk, { gain: 1.4 }), bumpScale: .6 }, blank, 0, 60, 4.5, [.02, .02, .02]),
    mk(THREE.MeshStandardMaterial, { roughness: .95, bumpMap: fib, bumpScale: 1.2 }, ink, 1, KEY.ch3.ink, 8, [.9, .7, .02]),
    mk(THREE.MeshStandardMaterial, { roughness: 1, bumpMap: bump(wall, { gain: 2.2 }), bumpScale: 3.2 }, mural, 2, KEY.ch3.mural, 8, [.06, .25, .02]),
    mk(THREE.MeshStandardMaterial, { roughness: .62, bumpMap: fib, bumpScale: .5, emissive: '#000000' }, paper, 3, KEY.ch3.paper, 8, [.034, .034, .02]),
    mk(THREE.MeshPhysicalMaterial, { roughness: 1, sheen: 1, sheenRoughness: .42, sheenColor: new THREE.Color('#9AA2E8'), bumpMap: bump(feltB, { gain: 1.6 }), bumpScale: 2.2 }, puppet, 4, KEY.ch3.puppet, 8, [.02, .02, .02]),
  ];
  // —— 百叶翻板 ——
  const panel = new THREE.Group(); panel.position.set(0, 0, PANEL_Z); sp.back.add(panel);
  const N = FLIP.N, sw = R.PNW / N, th = .0012;
  const core = new THREE.MeshStandardMaterial({ color: '#CFC6B4', roughness: .9 });
  const slats = [];
  for (let i = 0; i < N; i++) {
    const g = new THREE.Group(); g.position.set(-R.PNW / 2 + (i + .5) * sw, PANEL_Y + R.PNH / 2, 0); panel.add(g);
    const geoF = new THREE.PlaneGeometry(sw, R.PNH); { const uv = geoF.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / N); }
    const geoB = geoF.clone(); geoB.rotateY(Math.PI);
    const fA = new THREE.Mesh(geoF, mats[0]); fA.position.z = th / 2 + .0001;
    const fB = new THREE.Mesh(geoB, mats[1]); fB.position.z = -th / 2 - .0001;
    const body = new THREE.Mesh(new THREE.BoxGeometry(sw * .998, R.PNH, th), core);
    for (const m of [fA, fB, body]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    slats.push({ g, fA, fB });
  }
  // —— 纸框（立在地面页上，随第 4 页展开而立起）——
  const frC = R.frameArt(FRAME.w, FRAME.h, FRAME.win), frPad = 30 / A.PX;
  const frame = K.cutPiece(frC, frC.width / A.PX, frC.height / A.PX); const frameG = new THREE.Group(); frame.position.y = -frPad; frameG.add(frame); frameG.position.set(0, 0, FRAME_Z); sp.root.add(frameG);
  // —— 拉片纸栏 + 拉头 ——
  const railG = new THREE.Group(); railG.position.set(0, 0, RAIL.z); sp.root.add(railG);
  const names = [T3.ink.name, T3.mural.name, T3.paper.name, T3.puppet.name];
  const rails = [-1, 0, 1, 2, 3].map(a => { const c = R.railArt(RAIL.w, RAIL.h, RAIL.notch, names, a); const g = K.cutPiece(c, c.width / A.PX, c.height / A.PX); g.position.y = -30 / A.PX; railG.add(g); return g; });
  const knC = R.knobArt(.02, .028), knob = K.cutPiece(knC, knC.width / A.PX, knC.height / A.PX); knob.position.set(RAIL.rest, .0195 - 30 / A.PX, .0014); railG.add(knob);
  // —— 卡片与片名标签 ——
  const cards = [];
  for (const [mi, m] of ['ink', 'mural', 'paper', 'puppet'].entries()) {
    SECT[m].cards.forEach(c => {
      cards.push({ ...c, ...CARDS[c.key], m, mi: mi + 1, g: null, pending: await_(ctx, c.key) });
    });
  }
  for (const c of cards) { c.g = await c.pending; c.g.position.set(c.x, 0, c.z); sp.root.add(c.g); c.g.visible = false;
    const str = FILMS[c.m][c.film], n = [...str].length, lh = .018, lw = n * lh * .5 * 1.1 + .034;
    c.L = K.label(str, { w: lw, h: lh }); c.L.g.position.set(c.x, 0, c.z + (c.m === 'puppet' ? .03 : .04)); c.L.g.visible = false; c.text = str; sp.root.add(c.L.g); }
  // —— 木偶段：毛毡台面、小舞台、幕布、追光 ——
  const pup = buildPuppet(ctx, sp);
  // 追光与台口压在图层上（世界坐标），图层在本章 live 之外自动隐藏
  S = { sp, panel, slats, mats, P, frameG, railG, rails, knob, cards, pup, fib };
}
function ctxTex(c, o = {}) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 16; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; return t;
}
async function await_(ctx, key) { return ctx.kit.card(await ctx.ip(key), { h: CARDS[key].h }); }

function buildPuppet(ctx, sp) {
  const K = ctx.kit;
  const G = new THREE.Group(); G.position.set(0, 0, .012); sp.root.add(G);
  // 小舞台框（赭黄毛毡）
  const fel = R.feltCanvas(1600, 1100, '#A8742E', 41, { light: 6, dark: 8 });
  const W = .33, H = .21, OW = .262, OH = .162;
  const pc = R.prosArt(W, H, OW, OH, fel), pros = K.cutPiece(pc, pc.width / A.PX, pc.height / A.PX); pros.position.y = -30 / A.PX; G.add(pros);
  pros.traverse(o => { if (o.isMesh && o.material.roughness !== undefined) o.material.roughness = .98; });
  // 幕布（深红毛毡，带金色流苏边）：每帧重算褶皱
  const cc = R.feltCanvas(900, 1100, '#7A1626', 52, { light: 10, dark: 16 }); { const x = cc.getContext('2d'); const h = cc.height;
    x.fillStyle = '#C99A3C'; x.fillRect(0, h - 70, cc.width, 26); for (let i = 0; i < cc.width; i += 9) { x.fillStyle = i % 18 ? '#B8862E' : '#E2B85A'; x.fillRect(i, h - 44, 5, 44); }
    for (let i = 0; i < cc.width; i += 60) { const g = x.createLinearGradient(i, 0, i + 60, 0); g.addColorStop(0, 'rgba(0,0,0,.18)'); g.addColorStop(.5, 'rgba(255,255,255,.05)'); g.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = g; x.fillRect(i, 0, 60, h - 70); } }
  const cmat = new THREE.MeshPhysicalMaterial({ map: ctxTex(cc), roughness: 1, sheen: 1, sheenRoughness: .45, sheenColor: new THREE.Color('#FF8E8E'), side: THREE.DoubleSide,
    bumpMap: ctxTex(R.grayOf(cc, 900, 1100, { gain: 1.5 }), { linear: true }), bumpScale: 2 });
  const CHH = OH + .03, curtains = [-1, 1].map(side => {
    const geo = new THREE.PlaneGeometry(1, CHH, 48, 6); geo.translate(0, CHH / 2, 0);
    const m = new THREE.Mesh(geo, cmat); m.castShadow = true; m.receiveShadow = true; m.position.z = -.014; G.add(m);
    return { m, side, base: Float32Array.from(geo.attributes.position.array) };
  });
  // 毛毡台面（深绿）
  const mc = R.feltCanvas(1300, 500, '#2E4A36', 61, { light: 10, dark: 14 });
  const mat = new THREE.Mesh(new THREE.BoxGeometry(.27, .0018, .1), new THREE.MeshPhysicalMaterial({ map: ctxTex(mc), roughness: 1, sheen: 1, sheenRoughness: .5, sheenColor: new THREE.Color('#9CC8A8') }));
  mat.geometry.translate(0, .0009, .05); mat.receiveShadow = true; mat.castShadow = true;
  const matG = new THREE.Group(); matG.position.set(0, 0, -.098 + .012); matG.add(mat); sp.root.add(matG);
  // 地排：深靛毛毡的一道矮山（挡住纸框下沿，像小剧场的天幕底）
  const rc = R.feltCanvas(1400, 300, '#20234A', 71, { light: 9, dark: 10 }); { const x = rc.getContext('2d'); x.globalCompositeOperation = 'destination-in'; x.beginPath(); x.moveTo(0, 300);
    for (let i = 0; i <= 40; i++) { const u = i / 40; x.lineTo(u * 1400, 300 - 210 - 70 * Math.sin(u * Math.PI * 3 + .5) * Math.sin(u * Math.PI)); } x.lineTo(1400, 300); x.closePath(); x.fill();
    x.globalCompositeOperation = 'source-over'; x.setLineDash([12, 10]); x.lineWidth = 4; x.strokeStyle = 'rgba(217,164,65,.8)'; x.beginPath();
    for (let i = 0; i <= 40; i++) { const u = i / 40, yy = 300 - 210 - 70 * Math.sin(u * Math.PI * 3 + .5) * Math.sin(u * Math.PI) + 22; i ? x.lineTo(u * 1400, yy) : x.moveTo(u * 1400, yy); } x.stroke(); }
  const row = K.piece(rc, .27, .058, { border: 14 }); const rowG = new THREE.Group(); rowG.position.set(0, 0, -.091); rowG.add(row); sp.root.add(rowG);
  // 追光（世界坐标，挂在本章图层）：高位前光，越过台口打在卡片上
  const spot = new THREE.SpotLight('#FFF0D4', 0, 0, .105, .6, 1.6);
  spot.position.set(.04, 1.1, .12); spot.target.position.set(0, PG + .07, -.05);
  spot.castShadow = true; spot.shadow.mapSize.set(2048, 2048); spot.shadow.bias = -.0002; spot.shadow.normalBias = .001; spot.shadow.camera.near = .1; spot.shadow.camera.far = 1.6; spot.shadow.radius = 3;
  ctx.root.add(spot, spot.target);
  return { G, pros, curtains, OW, CHH, matG, rowG, spot };
}
function drapeCurtains(pup, open) {
  const { curtains, OW } = pup, half = OW / 2 + .006;
  for (const c of curtains) {
    const pos = c.m.geometry.attributes.position, b = c.base, wid = lerp(half + .004, .04, open), amp = .0024 + .0036 * open, pleats = 7;
    for (let i = 0; i < pos.count; i++) {
      const u = b[i * 3] + .5, v = b[i * 3 + 1] / pup.CHH;           // u：0 = 外侧（固定）→ 1 = 内侧（拉开时向外收）
      const x = c.side * (half + .004 - u * wid), z = amp * Math.sin(u * pleats * Math.PI + .6) * (.55 + .45 * v) + (1 - v) * .002 * open * Math.sin(u * 9);
      pos.setXYZ(i, x, b[i * 3 + 1] + (open > 0 ? -.004 * open * u * (1 - v) : 0), z);
    }
    pos.needsUpdate = true; c.m.geometry.computeVertexNormals();
  }
}

// —————————————————— 每帧 ——————————————————
const NOTCH = PULLS.map(p => p.notch);
function slatState(i, t) {
  let rot = 0, f = 0;
  NOTCH.forEach((F, j) => { const t0 = F + i * FLIP.STEP; if (t >= t0) f = j + 1; rot += Math.PI * back(seg(t, t0, t0 + FLIP.D), 1.25); });
  return { rot, f };
}
function knobX(t) {
  let x = RAIL.rest, k = -1;
  PULLS.forEach((p, j) => { if (t >= p.nudge) k = j; });
  if (k < 0) return { x, active: -1 };
  const p = PULLS[k], from = k === 0 ? RAIL.rest : RAIL.notch[k - 1], to = RAIL.notch[k];
  if (t < p.pull) return { x: from - .004 * eio(seg(t, p.nudge, p.pull)), active: k - 1 };
  if (t < p.notch) { const u = seg(t, p.pull - 1 / 30, p.notch); return { x: lerp(from - .004, to, ei(u) * .35 + eio(u) * .65), active: k - 1 }; }
  return { x: to - .0015 * Math.sin(Math.PI * seg(t, p.notch, p.notch + .16)), active: k };
}
const unfold4 = (ctx, t) => ss(seg(ctx.book.pageAngle(4, t), 45, 88));
const fold5 = (ctx, t) => ss(seg(ctx.book.pageAngle(5, t), 60, 86));
let lastT = null;
export function update(t, ctx) {
  if (!S) return;
  const { panel, slats, mats, frameG, railG, rails, knob, cards, pup } = S;
  // —— 翻板随第 4 页展开、随第 5 页压回 ——
  const u4 = unfold4(ctx, t), f5 = fold5(ctx, t), sq = Math.max(.001, u4 * (1 - f5));
  panel.scale.z = sq; panel.position.z = PANEL_Z * sq; panel.visible = sq > .02;
  frameG.scale.y = Math.max(.001, u4); frameG.rotation.x = .25 * (1 - u4);
  for (const m of mats) m.userData.U.c3T.value = t;
  slats.forEach((s, i) => {
    const { rot, f } = slatState(i, t);
    s.g.rotation.y = rot;
    let a, b; if (f === 0) { a = 0; b = 1; } else if (f % 2) { a = f - 1; b = f; } else { a = f; b = f - 1; }
    s.fA.material = mats[a]; s.fB.material = mats[b];
  });
  // 剪纸透光：落刀后孔里的光；拉开前（第四档）随翻板离开
  mats[3].userData.U.c3Glow.value = 2.4;
  // —— 拉片 ——
  const pr = ctx.kit.standAt(railG, t, C.rail, .62, .8), rf = eio(seg(t, C.puppet.stage - .2, C.puppet.stage + .1));
  railG.rotation.x = railG.rotation.x * (1 - rf) + Math.PI / 2 * rf;
  railG.visible = t >= C.rail - .25 && rf < .99;
  const kx = knobX(t); knob.position.x = kx.x;
  rails.forEach((r, i) => { r.visible = i === kx.active + 1; });
  // —— 卡片 ——
  for (const c of cards) {
    const exit = exitOf(c.mi);
    const sink = eio(seg(t, exit, exit + SINK));
    if (c.stand) {
      const p = popAt(t, c.up, .62);
      c.g.rotation.x = Math.PI / 2 * (1 - p) - .05 * clamp(p);
      c.g.position.y = -(c.h + .006) * sink;
      c.g.visible = t >= c.up - .23 && sink < .999;
    } else {
      const p = popAt(t, c.up, c.d || .62);
      c.g.rotation.x = -.04 * clamp(p);
      c.g.position.y = lerp(-(c.h + .006), 0, p) - (c.h + .006) * sink;
      c.g.visible = p > 0 && sink < .999;
    }
    // 标签：立起（向后仰 50°，桌签）→ 打字 → 拉片时向前扣倒
    const pl = popAt(t, c.lab, .5), down = eio(seg(t, exit, exit + .22));
    c.L.g.rotation.x = (Math.PI / 2 * (1 - pl) - LEAN * clamp(pl)) * (1 - down) + Math.PI / 2 * down;
    c.L.g.position.y = .0006 * (1 - clamp(pl));
    c.L.g.visible = t >= c.lab - .2 && down < .98;
    let n = 0; for (const tt of c.types) if (t >= tt) n++; c.L.set(n); c.n = n;
  }
  // —— 木偶段 ——
  const ps = popAt(t, C.puppet.stage, .62);
  pup.G.rotation.x = Math.PI / 2 * (1 - ps); pup.G.visible = t >= C.puppet.stage - .23;
  const pr2 = popAt(t, C.puppet.stage, .5); pup.rowG.rotation.x = Math.PI / 2 * (1 - pr2); pup.rowG.visible = t >= C.puppet.stage - .2;
  pup.matG.scale.z = Math.max(.001, eo(seg(t, C.puppet.stage - .3, C.puppet.stage + .05))); pup.matG.visible = t >= C.puppet.stage - .3;
  const open = eio(seg(t, C.puppet.open - 1 / 30, C.puppet.openEnd));
  if (pup.G.visible && lastT !== open) { drapeCurtains(pup, open); lastT = open; }
  // 追光：90.0 "咣"一下打亮（2 帧到 120%，0.25 s 落回 100%），95.0 随台灯恢复收掉
  const on = seg(t, C.puppet.spot - 1 / 30, C.puppet.spot + 1 / 30), flick = 1 + .2 * Math.exp(-Math.max(0, t - C.puppet.spot) / .08) * (t >= C.puppet.spot ? 1 : 0);
  const off = 1 - eio(seg(t, C.puppet.restore, C.puppet.restore + .4));
  pup.spot.intensity = 18 * on * flick * off;
  // —— 后期：剪纸段泛光稍强（透光孔晕开），对焦：剪纸段先对红纸，84 s 跟焦到卡片 ——
  if (t >= KEY.ch3.paper && t < KEY.ch3.puppet + .7) { ctx.post.bloom.strength = .32; ctx.post.bloom.threshold = .82; ctx.post.bloom.radius = .55; }
  if (t >= KEY.ch3.paper + .3 && t < 86) {
    const cam = ctx.cam; cam.updateMatrixWorld(); const fw = new THREE.Vector3(); cam.getWorldDirection(fw);
    const dOf = (x, y, z) => new THREE.Vector3(x, y, z).sub(cam.position).dot(fw);
    const dWall = dOf(-.07, PG + .14, -.12), dCard = dOf(.105, PG + .07, -.03), u = ss(seg(t, 82.9, 83.8));
    ctx.post.dof.focus = lerp(dWall, dCard, u); ctx.post.dof.aper = 9;
  }
}

// —————————————————— 画面文字（全部来自 TEXT.ch3）——————————————————
const v3 = new THREE.Vector3();
function boxOf(ctx, obj, x0, x1, y0, y1, z = 0) {
  obj.updateWorldMatrix(true, false); const xs = [], ys = [];
  for (const [a, b] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { v3.set(a, b, z).applyMatrix4(obj.matrixWorld); const p = ctx.project(v3.x, v3.y, v3.z); xs.push(p[0]); ys.push(p[1]); }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const FACE_OUT = [KEY.ch3.ink, KEY.ch3.mural, KEY.ch3.paper, KEY.ch3.puppet, Infinity].map(t => t + (FLIP.N - 1) * FLIP.STEP + FLIP.D);
export function texts(t, ctx) {
  if (!S || !S.sp.root.visible) return [];
  const out = [];
  MATS.forEach((m, k) => {
    for (const r of S.P[m].rects) if (t >= r.from && t < Math.min(FACE_OUT[k], BOOK.turns[4].t - .3)) out.push({ id: r.id, text: r.text, ...boxOf(ctx, S.panel, r.x0, r.x1, PANEL_Y + r.y0, PANEL_Y + r.y1, .0007) });
  });
  if (S.railG.visible && t >= C.rail && t < C.puppet.stage - .2) {
    const names = [T3.ink.name, T3.mural.name, T3.paper.name, T3.puppet.name];
    RAIL.notch.forEach((x, i) => out.push({ id: `ch3.rail.${i}`, text: names[i], ...boxOf(ctx, S.railG, x - .011, x + .011, .0035, .0135, 0) }));
  }
  for (const c of S.cards) if (c.L.g.visible && c.n > 0) { const b = ctx.screenBox(c.L.g); if (b) out.push({ id: `ch3.film.${c.key}`, text: c.text, ...b }); }
  return out;
}
export function probe(t, ctx) {
  if (!S) return {};
  const kx = knobX(t);
  return { knob: +kx.x.toFixed(4), slat0: +slatState(0, t).rot.toFixed(3), slat11: +slatState(FLIP.N - 1, t).rot.toFixed(3), cards: S.cards.map(c => +c.g.position.y.toFixed(4)), spot: +S.pup.spot.intensity.toFixed(3) };
}
