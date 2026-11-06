// main.js —《豹变》C 奇谭：时间线、每段后期参数、资源加载、预热
// 页面约定：window.DUR = 30；window.render(t) 是 t 的纯函数；资源和着色器就绪后 window.READY = true。
import * as THREE from 'three';
import { createPost } from './post.js';
import { buildWorld } from './world.js';
import { buildRoom, barZ, s6Ease } from './room.js';
import { buildFlat } from './flat.js';
import { buildMarket } from './market.js';
import { makeRain, makeStar, makeLensRing, makeSubtitle, makeLightRing, orthoCam } from './fx.js';
import { loadTextures, tcOf, clamp, lerp, seg, ss, ss5, eo, hashi, lin3, motifPh, motifK, EYE_E, STAR_H, P_MOTIF } from './util.js';
import { SHARED } from './toonmat.js';
import { makeSprite, placeFlat, setSpots, setBends, setGradeEmu, texPx } from './sprite.js';

const W = innerWidth, H = innerHeight, K = H / 1040;
const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
SHARED.uK.value = K;
const post = createPost(renderer, W, H, { ss: H > 1500 ? 1 : 2 });
const rtWorld = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });

const fonts = [['ZMX', '/fonts/ZhiMangXing-baobian.woff2'], ['MSZ', '/fonts/MaShanZheng-baobian.woff2']];
await Promise.all(fonts.map(async ([n, u]) => { const f = new FontFace(n, `url(${u})`); await f.load(); document.fonts.add(f); }));
await document.fonts.ready;

const man = await (await fetch('./assets/manifest.json')).json();
const tex = await loadTextures({
  nanshanGrey: './assets/bg_nanshan_grey.png', nanshanColor: './assets/bg_nanshan_color.png', mist: './assets/fx_mist_bank.png',
  leoSit: './assets/leopard_sit.png', leoCoil: './assets/leopard_coil.png', leoLaunch: './assets/leopard_launch.png', leoGlide: './assets/leopard_glide.png', leoHead: './assets/leopard_head.png',
  luSit: './assets/luwei_sit_shelter.png', deer: './assets/deer_walk_sheet.png', luDesk: './assets/luwei_desk_back.png', luDeskNoGl: './assets/luwei_desk_back_noglasses.png', luWalk: './assets/luwei_walk_sheet.png',
  room: './assets/bg_room.png', woodcut: './assets/page_woodcut.png', handTweezers: './assets/hand_tweezers.png', handFree: './assets/hand_tweezers_free.png', tweezers: './assets/tweezers_only.png', handGlasses: './assets/hand_glasses.png', handRelease: './assets/hand_release.png',
  handOpen: './assets/hand_open_side.png', handFist: './assets/hand_fist.png', vendor: './assets/vendor_hand.png', scroll: './assets/bg_scroll_qinglv.png',
  rockPaint: './assets/tex_rock_paint.png', deskPaint: './assets/tex_desk_paint.png',
});

const world = buildWorld({ tex, man });
const room = buildRoom({ tex, man });
world.alignRidges(room.barScreenY(92));
const flat = buildFlat({ tex, man, world });
const market = buildMarket({ tex, man });
const rain = makeRain();
// 镜片 / 豹眼的四芒星：修复室里放在景深之后的屏幕层（不被景深抹掉）；S5c 没有景深，留在场景里进 bloom
const starRoom = makeStar(); const ovStar = { scene: new THREE.Scene(), camera: orthoCam() }; ovStar.scene.add(starRoom.m);
const starFlat = makeStar(); flat.scene.add(starFlat.m);

// ── S6 屏幕层：镜片圈、陆蔚（A10，调色仿真）、字幕 ──
const ov = { scene: new THREE.Scene(), camera: orthoCam() };
const lens = makeLensRing(); ov.scene.add(lens.m);
const a10 = makeSprite(tex.luDesk, { order: 10, mask: false, overlay: true }); ov.scene.add(a10.group);
const sub = makeSubtitle(W, H, K); ov.scene.add(sub.m);
const ring7 = makeLightRing(); ov.scene.add(ring7.m); ring7.u.uPh.value.set(...motifPh(7)); ring7.u.uKk.value = motifK(7);
const A10 = man.find(m => m.id === 'A10')['锚点'];

// ── 后期参数（DESIGN 3.5 / 3.4） ──
const LOOK = {
  // 返修 style-11：房间段 lift 归零并略压暗部（p5 目标 12–25）
  room: { bloom: { strength: .45, threshold: .80, radius: .75, tint: '#FFE7C2' }, grade: { exposure: 1.1, warmth: .18, lift: [-.03, -.04, -.05], saturation: .92, shoulder: .90, toe: .75 }, vignette: .46, grain: .75, paper: .05,
    outline: { width: 2.0, color: '#1A0F0A', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .50, opacity: .75 } },
  ident: { bloom: { strength: 0, threshold: .88, radius: .80, tint: '#F0F0EA' }, grade: { exposure: 1, warmth: 0, lift: [0, 0, 0], saturation: 1.0, shoulder: 1, toe: 0 }, vignette: .28, grain: .85, paper: .06,
    outline: { width: 2.0, color: '#1A0F0A', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .50, opacity: .75 } },
  grey: { bloom: { strength: .40, threshold: .88, radius: .80, tint: '#F0F0EA' }, grade: { exposure: 1, warmth: .02, lift: [.03, .03, .03], saturation: 1.0, shoulder: .92 }, vignette: .28, grain: .85, paper: .06,
    outline: { width: 2.0, color: '#232120', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .15, opacity: 1.0 } },   // 返修 style-03：内部线几乎关掉，崖只描外轮廓
  s4: { bloom: { strength: .35, threshold: .90, radius: .80, tint: '#F0F0EA' }, grade: { exposure: 1, warmth: .02, lift: [.03, .03, .03], saturation: 1.0, shoulder: .92 }, vignette: .30, grain: .85, paper: .06,
    outline: { width: 2.0, color: '#232120', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .15, opacity: 1.0 } },
  market: { bloom: { strength: .85, threshold: .75, radius: .70, tint: '#FFD9A0' }, grade: { exposure: 1, warmth: .10, lift: [0, .02, .035], saturation: 1.08, shoulder: .88 }, vignette: .40, grain: .64, paper: .04,
    outline: { width: 2.1, color: '#0C1214', wobble: .8, warp: 60, pressure: .35, breakup: .10, inner: .60, opacity: .9 } },
  s5: { bloom: { strength: .55, threshold: .78, radius: .80, tint: '#FFF0D8' }, grade: { exposure: .84, warmth: .10, lift: [.01, .02, .025], saturation: 1.02, shoulder: .90 }, vignette: .18, grain: .64, paper: .03,
    outline: { width: 2.0, color: '#1F2A28', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .50, opacity: 1.0 } },
  s6: { bloom: { strength: .50, threshold: .78, radius: .75, tint: '#FFE7C2' }, grade: { exposure: 1.04, warmth: .16, lift: [0, 0, 0], saturation: .95, shoulder: .90, toe: .35 }, vignette: .36, grain: .75, paper: .05,
    outline: { width: 2.0, color: '#1A0F0A', wobble: .6, warp: 60, pressure: .30, breakup: .12, inner: .50, opacity: .75 } },
};
const lerpV = (a, b, k) => Array.isArray(a) ? a.map((x, i) => lerp(x, b[i], k)) : lerp(a, b, k);
// 第 4 轮（qa2-01）：两套调色逐项插值（缺的项按 post.js 的默认值）；wbExp = post.js 调色里的"曝光 × 白平衡"逐通道系数
const G_DEF = { exposure: 1, warmth: 0, lift: [0, 0, 0], saturation: 1, shoulder: 1, toe: 0 };
const gradeMix = (A, B, k) => { const o = {}; for (const key of Object.keys(G_DEF)) o[key] = lerpV(A[key] ?? G_DEF[key], B[key] ?? G_DEF[key], clamp(k)); return o; };
const wbExp = G => { const wm = G.warmth ?? 0, wb = [1 + .10 * wm, 1 + .012 * wm, 1 - .15 * wm], l = wb[0] * .2126 + wb[1] * .7152 + wb[2] * .0722; return wb.map(x => x / l * (G.exposure ?? 1)); };
function mixLook(A, B, k) {
  k = clamp(k);
  const o = {};
  for (const key of ['bloom', 'grade', 'outline']) { o[key] = {}; for (const f of Object.keys(A[key])) o[key][f] = typeof A[key][f] === 'string' ? (k < .5 ? A[key][f] : B[key][f]) : lerpV(A[key][f], B[key][f], k); }
  for (const key of ['vignette', 'grain', 'paper']) o[key] = lerp(A[key], B[key], k);
  return o;
}

// ── 时间线（帧，止帧不含） ──
const SHOTS = [
  ['S1a', 0, 36], ['S1b', 36, 72], ['T1', 72, 127], ['S2a', 127, 211], ['S2b', 211, 287],
  ['S3a', 287, 294], ['S3b', 294, 315], ['S3c', 315, 332], ['S3d', 332, 356],
  ['S4a', 356, 378], ['S4b', 378, 438], ['S4c', 438, 482], ['S5a', 482, 567], ['S5b', 567, 628], ['S5c', 628, 642], ['S6', 642, 720],
];
const shotAt = f => { for (const s of SHOTS) if (f >= s[1] && f < s[2]) return s[0]; return 'S6'; };
const DBG = new URLSearchParams(location.search).get('dbg') || '';

function renderWorldTo(R, look, t) {
  post.render(R.scene, R.camera, { t: Math.round(t * 24) / 24, ...look, dof: null, target: rtWorld, noFx: true });
}

// S6 的陆蔚（屏幕层）：f642 放大 2.1 倍、lens_r 落在 E；f646–f690 拉到 0.7 倍、index_tip 落在 (1180, 600)
const DAP_SPRITE = (() => {
  const pts = [];   // 种子 7 那一枚（第 2 轮）改由屏幕层 ring7 画：手和书页一起被照亮，不再被精灵边缘截断
  // 第 4 轮（zs-01）：落定以后要一眼读成"一身豹纹"——16 枚大小相近（终态约 20–26 px）的环斑，错落地铺在受窗光的背、肩、臂上，
  //   不再是 13 团大小悬殊、被叶团打碎的云形叶影
  const zones = [[700, 560, 34], [792, 636, 30], [636, 694, 36], [556, 806, 38], [724, 806, 34], [468, 652, 32], [612, 572, 28], [862, 742, 26],
    [528, 962, 38], [692, 952, 36], [404, 866, 34], [826, 884, 30], [604, 1124, 40], [396, 1062, 36], [762, 1080, 34], [484, 1252, 38]];
  zones.forEach(([x, y, r], j) => pts.push([x + (hashi(j * 3 + 500) - .5) * 24, y + (hashi(j * 3 + 501) - .5) * 24, r * (.92 + .16 * hashi(j * 3 + 502)), 200 + j]));
  return pts;
})();
function placeA10(f, t) {
  const tc = tcOf(f);
  const s = s6Ease(f);   // 第 4 轮（zs-01）：和 room.js 的 S6 拉轨同一条进度
  const scale = 2.1 * Math.pow(.7 / 2.1, s);
  // f642：头这一大团暗在画左（x < 680），镜片圈（代码画，在 E）不被挡；拉轨后 index_tip 落在 (1180, 600)
  // 第 3 轮（story-13 / self-07）：终态对位点从食指侧缘（index_tip）挪到握笔的拳头中心（种子 7 光斑整枚落在手上），仍落在 (1180, 600)
  const FIST = [888, 662];
  const ax = lerp(A10.lens_r[0], FIST[0], s), ay = lerp(A10.lens_r[1], FIST[1], s);
  const sx = lerp(640, P_MOTIF[0], s), sy = lerp(520, P_MOTIF[1], s);   // 返修 story-10：头往右挪 80K，镜片圈压在他眼眶前方（过肩主观）
  // 补书的手：每 8 帧轻转 ±1.5°；f696 笔尖抬起 6K
  const wob = 1.5 * (Math.floor(f / 8) % 2 ? 1 : -1) * ss(seg(f, 690, 700));
  placeFlat(a10, ax, ay, sx, sy, scale, 0);
  setBends(a10, [{ pivot: [760, 560], center: [880, 660], angle: (wob - (f >= 696 ? 3 : 0)) * Math.PI / 180, rIn: 60, rOut: 170 }]);
  const u = a10.u;
  u.uBlur.value = texPx(a10, 16 * (1 - ss(seg(f, 642, 680))));
  u.uLight.value.set(1, .93, .82); u.uRimC.value.copy(lin3('#F3B136')); u.uRimAmt.value = .55; u.uRimDir.value.set(1, -.35).normalize(); u.uRimW.value = texPx(a10, 6);
  u.uDesat.value = 0; u.uFogAmt.value = 0; u.uTc.value = tc;
  setGradeEmu(a10, LOOK.s6.grade);
  // 光斑：叶影椭圆 → MOTIF 环（f650–f667）；之前每枚摆 ±10K
  const m = ss(seg(f, 650, 667));
  u.uDapN.value = DAP_SPRITE.length; u.uDapOn.value = 1; u.uDapM.value = m; u.uDapLeaf.value = lerp(1, .3, m);   // 第 4 轮：落定时叶团不再把环打碎
  // 种子 7 那一枚：#FFE7B0、α .75；f667–f675 落定时单独亮一下（+15%，两档，一拍二）
  u.uDap7.value = (.75 + (f >= 667 && f < 671 ? .15 : f >= 671 && f < 675 ? .08 : 0)) * ss(seg(f, 652, 667));
  DAP_SPRITE.forEach(([x, y, r, seed], j) => {
    const fr = .4 + .5 * hashi(seed * 3), ph = hashi(seed * 5) * 6.28;
    const sw = (1 - m) * texPx(a10, 10) * Math.sin(2 * Math.PI * fr * t + ph);
    const rr = r;   // 第 4 轮：斑的大小按贴图像素定——跟着人一起随拉轨缩小（光斑落在衬衫上），终态和种子 7 那一圈（40K）是一家人
    u.uDap.value[j].set(x + sw, y + sw * .4, rr * (1.2 + .5 * hashi(seed)), rr * (.6 + .3 * hashi(seed * 7)));
    u.uDapR.value[j].set(hashi(seed * 11) * 3.14, rr, motifK(seed), seed === 7 ? 1 : 0);
    const p = motifPh(seed); u.uDapP.value[j].set(...p);
  });
  // 种子 7 那一枚光斑：跟着食指尖走（拉轨期间随画面缩放），f652–f667 显出、f667–f675 落定时单独亮一下（+15%，两档，一拍二）
  const tip = [sx + (FIST[0] - ax) * scale, sy + (FIST[1] - ay) * scale];
  ring7.u.uC.value.set(tip[0], tip[1]); ring7.u.uR.value = 40 * scale / .7;
  ring7.u.uAmt.value = .75 * ss(seg(f, 652, 667)) * (1 + (f >= 667 && f < 671 ? .15 : f >= 671 && f < 675 ? .08 : 0));
  ring7.m.visible = f >= 652;
  // 第 4 轮（qa2-09）：A10 上那片真镜片（贴图像素：中心 (790, 395)、半轴 (28, 39)，左半被耳朵挡住）在屏幕上的位置
  return { scale, lensAt: [sx + (A10.lens_r[0] - ax) * scale, sy + (A10.lens_r[1] - ay) * scale], lensC: [sx + (790 - ax) * scale, sy + (395 - ay) * scale] };
}
// 桌面 / 书上的 6 枚世界光斑（沿窗光方向投射）
const DAP_W = [[.09, -.02, .022], [.03, .04, .018], [.13, .05, .02], [-.05, .07, .016], [.2, -.06, .025], [.26, .1, .02]];
function setRoomDapple(f, t, on) {
  SHARED.uDap.value.set(on ? 1 : 0, ss(seg(f, 650, 667)), lerp(1, .3, ss(seg(f, 650, 667))), 0);   // 第 4 轮（zs-01）：落定时叶团不再把环打碎
  DAP_W.forEach(([x, z, r], j) => {
    const sw = (1 - ss(seg(f, 650, 667))) * .006 * Math.sin(2 * Math.PI * (.4 + .5 * hashi(j * 9)) * t + j);
    SHARED.uDapW.value[j].set(x + sw, z, r * 1.4, r);
    SHARED.uDapWP.value[j].set(...motifPh(206 + j));
  });
}

function frame(t) {
  const f = clamp(Math.round(t * 24), 0, 719), tc = tcOf(f);
  SHARED.uTc.value = tc;
  SHARED.uDap.value.set(0, 0, 0, 0); SHARED.uPool.value.set(0, 0, 1, 0); SHARED.uFogHi.value.w = 0;
  const id = shotAt(f);
  let R = null, look = LOOK.grey, rainOn = null, overlay = null, fade = null, sub2 = null;
  starRoom.set(0); starFlat.set(0);
  if (id === 'S1a') { R = room.shots.S1a(f, t); look = LOOK.room; }
  else if (id === 'S1b') { R = room.shots.S1b(f, t); look = LOOK.room; if (R.star) { starRoom.set(R.star); overlay = ovStar; } }
  else if (id === 'T1') {
    if (f < 104 && DBG !== 'world') {
      if (f >= 86) { const W2 = world.shots.T1W(f, t); renderWorldTo(W2, LOOK.grey, t); room.doorU.tWorld.value = rtWorld.texture; }
      R = room.shots.T1(f, t); room.doorU.uDbg.value = DBG === 'door' ? 1 : 0;
      look = mixLook(LOOK.room, LOOK.ident, ss(seg(f, 96, 104)));
      if (R.bloomPulse) look = { ...look, bloom: { ...look.bloom, strength: look.bloom.strength + R.bloomPulse } };
    } else { R = world.shots.T1W(f, t); look = LOOK.grey; rainOn = { dens: ss(seg(f, 104, 115)), drops: f >= 115 ? R.drops : [], dry: R.dry }; }
  }
  else if (id === 'S2a') { R = world.shots.S2a(f, t); look = LOOK.grey; rainOn = { dens: 1, drops: R.drops, dry: R.dry }; }
  else if (id === 'S2b') { R = world.shots.S2b(f, t); look = LOOK.grey; rainOn = { dens: 1, near: 1, mid: .7, far: .5, drops: R.drops }; overlay = R.overlay; }
  else if (id.startsWith('S3')) { R = market.shots[id](f, t); look = id === 'S3d' ? mixLook(LOOK.market, LOOK.s4, ss(seg(f, 348, 355))) : LOOK.market; if (id === 'S3b') { const pk = f >= 309 && f < 315 ? (f <= 311 ? (f - 309) / 2 : 1 - (f - 311) / 4) : 0; look = { ...look, bloom: { ...look.bloom, strength: lerp(.85, 1.15, pk) } }; } overlay = R.overlay; }
  else if (id === 'S4a') { R = flat.shots.S4a(f, t); look = LOOK.s4; rainOn = { dens: 1.4, near: 1, mid: 1, far: 1 }; }
  else if (id === 'S4b') { R = flat.shots.S4b(f, t); look = LOOK.s4; rainOn = f < 420 ? { dens: .4, near: 1, mid: 0, far: 0 } : null; }
  else if (id === 'S4c') {
    R = world.shots.S4c(f, t); look = mixLook(LOOK.s4, LOOK.s5, ss((f - 458) / 18)); rainOn = f < 458 ? { dens: .8 } : null;
    // 第七日破雾（返修 style-07）：f458 起换成 S5 的 bloom，阈值 .75，强度做一个 18 帧的峰（.55 → .9 → .55）
    if (f >= 458) { const pk = Math.sin(Math.PI * clamp((f - 458) / 18)); look = { ...look, bloom: { ...look.bloom, threshold: .75, strength: .55 + .35 * pk } }; }
  }
  else if (id === 'S5a') { R = world.shots.S5a(f, t); look = LOOK.s5; }
  else if (id === 'S5b') {
    // 第 4 轮（qa2-01）：原来遮罩外那份 S5a 世界先按 S5 调色渲一遍（没有体积光、没有 vigHi），合进长卷以后又按 S5 调了一遍色——
    //   曝光 .84 叠了两次、日晕没了，f566 → f567 整帧暗 13 级。现在：① 世界走和 S5a 完全一样的后期（S5 调色 + bloom + 体积光 + 景深 + 墨线），
    //   颗粒 / 纸纹 / 暗角留到这一帧最后只做一次；② 这一帧的调色在化开的 18 帧里从"恒等"线性过渡到 S5（bloom、vigHi 同步），
    //   所以 f567 世界那一块原样不动；③ 长卷、小豹、墨点、浮岛按"S5 调色 / 当前调色"的曝光与白平衡比值预先补偿，看起来和原来的 S5b 一样；
    //   世界那一块按当前调色的倒数补偿，过渡期间不被二次调色。f585 以后与原来完全相同。
    const kG = ss(seg(f, 567, 585));
    let wt = null;
    if (f < 587) { const W5 = world.shots.S5a(f, t, { hideLeo: true }); post.render(W5.scene, W5.camera, { t: f / 24, ...LOOK.s5, dof: W5.dof, rays: W5.rays, target: rtWorld, noFx: true }); wt = rtWorld.texture; }
    const G = gradeMix(LOOK.ident.grade, LOOK.s5.grade, kG);
    const cS5 = wbExp(LOOK.s5.grade), cK = wbExp(G);
    R = flat.shots.S5b(f, t, wt, { comp: cS5.map((v, i) => v / cK[i]), wcomp: cK.map(v => 1 / v) });
    look = { ...LOOK.s5, grade: G, bloom: { ...LOOK.s5.bloom, strength: LOOK.s5.bloom.strength * kG } };
    R.vigHi = 1 - kG;
  }
  else if (id === 'S5c') {
    R = flat.shots.S5c(f, t); const k = ss(seg(f, 634, 642));
    // 返修 style-10：S5c 期间整帧饱和度 ×0.85
    look = { ...LOOK.s5, grade: { ...LOOK.s5.grade, warmth: lerp(.10, .16, k), saturation: lerp(1.02, .95, k) * .78 } };
    if (R.star) { starFlat.set(R.star.amt, R.star.arm, R.star.core, R.star.halo); look = { ...look, bloom: { ...look.bloom, strength: look.bloom.strength + .4 * R.star.amt } }; }
  }
  else {
    R = room.shots.S6(f, t); look = LOOK.s6;
    setRoomDapple(f, t, true);
    // T2 后半：镜片高光从峰值衰减 臂长 220 → 60K、α 1 → .3
    const { scale, lensAt, lensC } = placeA10(f, t);
    // 镜片圈：f642 与豹眼同一椭圆（T2 切点不动）。第 4 轮（qa2-09）：原来要到 f650 才开始收、到 f662 还有七成大，悬在后脑前面像第二片镜片 / 放大镜；
    //   现在 f644 起就往他脸上那片真镜片收（缩到它的大小、退到头的剪影后面——A10 画在镜片圈上面，会把它挡住），f655 淡完；星芒跟着镜片圈走
    //   镜片圈的形和那片真镜片重合以后再淡掉（f649–f656），淡出时看不出两圈
    const ls = scale / 2.1, mv = eo(seg(f, 644, 653)), la = 1 - ss(seg(f, 649, 656));
    const lrx = lerp(EYE_E.rx * ls, 28 * scale, mv), lry = lerp(EYE_E.ry * ls, 39 * scale, mv), rk = lrx / EYE_E.rx;
    const lc = [lerp(EYE_E.cx, lensC[0], mv), lerp(EYE_E.cy, lensC[1], mv)];
    lens.u.uA.value = la; lens.u.uE.value.set(lc[0], lc[1], lrx, lry); lens.u.uW.value = 9 * Math.max(rk, .4);
    lens.m.visible = la > .001;
    const zoom = lerp(1.12, 1, ss(seg(f, 649, 656)));
    if (f < 656) R.dof = { ...R.dof, lens: { cx: lc[0], cy: lc[1], rx: lrx, ry: lry, tilt: EYE_E.tilt * Math.PI / 180, zoom, coc: 10 * la, amt: la } };   // 返修 tech-05：镜片里的清楚圆盘跟着镜片圈一起淡掉
    // T2 后半：镜片高光从峰值衰减（臂长 220 → 60K、α 1 → .3）；镜片内画面放大 1.12 倍，星芒中心预先反算，放大后正好落在 H；第 4 轮：中心跟着镜片圈走
    if (f < 652) { const k = eo((f - 642) / 10); starRoom.set(lerp(1.35, .3, k), lerp(220, 60, k) * Math.max(rk, .35), lerp(60, 14, k), lerp(160, 60, k), [lc[0] + (STAR_H[0] - EYE_E.cx) * rk, lc[1] + (STAR_H[1] - EYE_E.cy) * rk]); }
    // 字幕（返修 story-08）：提前到 f672 起洇出——第一列 f672–f682、第二列 f678–f688，两列全显一直保持到 f710，再随整帧淡出
    sub.u.uRev.value.set(ss(seg(f, 672, 682)), ss(seg(f, 678, 688))); sub.u.uA.value = f >= 672 ? 1 : 0; sub.m.visible = f >= 672;
    overlay = f < 652 ? [ov, ovStar] : ov;
    if (f >= 710) fade = { color: '#100C09', amt: ss((f - 710) / 9) };   // 返修 tech-17：f719 正好淡到墨黑
  }
  const L = JSON.parse(JSON.stringify(look));
  // 七天的日夜呼吸（返修 story-03）：每个太阳落下后 6 帧整体曝光压 12%
  if (R.night) L.grade.exposure *= 1 - .12 * R.night;
  if (R.outlineColor) L.outline.color = R.outlineColor;
  let rainP = null;
  if (rainOn) { rain.set(t, rainOn); rainP = rain; }
  // 颗粒、墨线沸腾的种子按整数帧取（t 由帧号量化，避免浮点把 floor(t·24) 算到上一帧）
  if (DBG === 'nograin') L.grain = 0;   // 调试视图：只在 --query dbg=nograin 时生效（量颗粒占多少码率）
  post.render(R.scene, R.camera, { t: f / 24, ...L, dof: R.dof, blur: R.blur, overlay, rain: rainP, fade, lineFog: R.lineFog, rays: R.rays || null, vigHi: R.vigHi || 0, wipeE: R.wipeE || null, dbgRain: DBG === 'rain', dbgCoc: DBG === 'coc' });
}

window.DUR = 30;
window.render = t => frame(t);
// 可选：该时刻画面上的文字（供检查）。书页上的"革"是书页内容，不算字幕
window.TEXTS = t => { const f = Math.round(t * 24); const out = []; if (f >= 672) out.push('君子豹变'); if (f >= 678) out.push('其文蔚也'); return out; };
// 预热：每个镜头渲一帧，把着色器都编译好
for (const t of [.5, 1.8, 3.4, 4.0, 4.5, 5.5, 10, 12.1, 12.6, 13.4, 14.2, 15.2, 16.5, 18.5, 19.6, 21, 21.5, 22.5, 23.8, 25, 26.3, 27.2, 28.8]) frame(t);
window.READY = true;
