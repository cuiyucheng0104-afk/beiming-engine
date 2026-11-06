// main.js —《豹变》B 装饰版：总装。
//   渲染器 + look.js 后期（墨线 / Kuwahara / bloom / 调色 / 纸纹 / 暗角 / 颗粒）+ 叠加层 O + DOM 字幕层。
//   render(t)：按帧号 f = round(t·24) 选场景与机位，所有状态都由 t 直接算出（确定性）。
import * as THREE from 'three';
import { createLook } from '/films/_lib/look.js';
import { setToonGlobals } from '/films/_lib/toon.js';
import { W, H, K, SHARED, loadTex, clamp, lerp, seg, ss, ss5, eo, fseg } from './lib.js';
import { createOverlay } from './overlay.js';
import { buildRoom } from './room.js';
import { buildCliff } from './cliff.js';
import { buildMarket } from './market.js';
import { buildSky } from './sky.js';
import { buildS6 } from './s6.js';

const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const look = createLook(renderer, W, H, { ss: K > 1.5 ? 1 : 2, msaa: 4, paperUrl: '/films/_lib/paper.png' });
const overlay = createOverlay(renderer);
const rtPortal = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });

// DOM 字幕层（书法竖排）+ 片尾纸白
const hud = document.createElement('canvas'); hud.width = W; hud.height = H;
hud.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
document.body.appendChild(hud);
const g2 = hud.getContext('2d');

// ───────────────────────── 资源 ─────────────────────────
const A = './assets/';
const manifestArr = await (await fetch(A + 'manifest.json')).json();
const manifest = {}; for (const m of manifestArr) manifest[m.id] = m;
const names = ['leo_crouch', 'leo_sit', 'leo_takeoff', 'leo_leap', 'leo_head', 'leo_head_2x', 'lw_sit_back', 'lw_walk_back', 'lw_desk_back',
  'hand_pinch', 'hand_open', 'hand_side', 'hands_mending', 'vendor_hand', 'mask_face', 'market_plate', 'cliff_cave', 'deer_walk', 'woodcut_leopard', 'ledge_face'];
const tex = { manifest };
await Promise.all(names.map(async n => { tex[n] = await loadTex(A + n + '.png'); }));
tex.woodcut = tex.woodcut_leopard;
const font = new FontFace('BBMSZ', 'url(/fonts/MaShanZheng-baobian.woff2)');
await font.load(); document.fonts.add(font); await document.fonts.ready;
await look.ready;

const room = buildRoom({ tex });
const cliff = buildCliff({ tex });
const market = buildMarket({ tex });
const sky = buildSky({ tex });
const s6 = buildS6({ room, tex });

// ───────────────────────── 后期参数（DESIGN 3.5 / 3.6） ─────────────────────────
const OL = {
  R: { color: '#2B2622', width: 2.0, inner: 0.55, wobble: 0.45, boilFps: 0, warp: 70, pressure: 0.30, breakup: 0.04, tint: 0.15, darken: 0.55 },
  Y: { color: '#1E3444', width: 1.6, inner: 0.50, wobble: 0.60, boilFps: 0, warp: 70, pressure: 0.45, breakup: 0.18, tint: 0.25, darken: 0.55 },
  M: { color: '#3A1A10', width: 2.4, inner: 0.55, wobble: 0.50, boilFps: 12, warp: 60, pressure: 0.30, breakup: 0.04, tint: 0.15, darken: 0.50 },
  S: { color: '#2E2A33', width: 1.4, inner: 0.50, wobble: 0.50, boilFps: 0, warp: 70, pressure: 0.30, breakup: 0.08, tint: 0.20, darken: 0.55 },
};
const KU_Y = { radius: 1.0, farRadius: 2.5, farStart: 20, farEnd: 21, q: 8, strength: 0.6 };
const KU_M = { radius: 1.0, farRadius: 3.0, farStart: 20, farEnd: 21, q: 8, strength: 0.8 };   // fix1：把 AI 底板的细碎细节抹成大块水粉（style-11 ③）
const GR = {
  R: { warmth: 0.18, saturation: 0.96, lift: [0.020, 0.018, 0.012], shoulder: 0.92 },
  N: { warmth: 0, saturation: 1, lift: [0, 0, 0], shoulder: 1 },
  Y: { warmth: -0.06, saturation: 0.92, lift: [0.026, 0.036, 0.034], shoulder: 0.95 },   // fix2（style-17）：暗部抬向青黑（原 B 0.040 把暗部推成蓝石板）
  M: { warmth: 0.25, saturation: 1.12, lift: [0.020, 0.012, 0.010], shoulder: 0.90 },
  S: { warmth: 0, saturation: 1.00, lift: [0.020, 0.020, 0.040], shoulder: 0.92 },
  C: { warmth: 0.15, saturation: 1.00, lift: [0.020, 0.018, 0.012], shoulder: 0.92 },
};
const mixGrade = (a, b, u) => ({
  exposure: lerp(a.exposure ?? 1, b.exposure ?? 1, u),
  warmth: lerp(a.warmth, b.warmth, u), saturation: lerp(a.saturation, b.saturation, u),
  lift: a.lift.map((v, i) => lerp(v, b.lift[i], u)), shoulder: lerp(a.shoulder, b.shoulder, u),
});
const paper = s => ({ strength: s, scale: K });
const lookY = (t, extra = {}) => ({ t, outline: OL.Y, kuwahara: KU_Y, bloom: { threshold: 0.92, strength: 0.20, radius: 0.60, tint: '#FFFFFF' }, grade: GR.Y, paper: paper(0.10), vignette: 0.12, grain: 0.25, ...extra });

// ───────────────────────── 时间轴 ─────────────────────────
// 帧区间左闭右开：S1[0,81) T1[81,139) S2[139,260) S3a[260,279) S3b[279,308) S3c[308,331) S3d[331,343)
//                 S4a[343,374) S4b[374,430) S4c[430,470) S4d[470,496) S5a[496,520) S5b[520,567) S5c[567,624)
//                 #8[624,635) #9[635,646) T2[646,658) S6[658,720)
function frame(t) {
  overlay.reset();
  SHARED.uT.value = t;
  const fi = Math.round(t * 24), f = t * 24;
  SHARED.uTc.value = (fi - (fi & 1)) / 24;
  overlay.U.uTime.value = t;
  let job;
  if (fi < 81) job = shotS1(t, f);
  else if (fi < 139) job = shotT1(t, f);
  else if (fi < 260) job = shotS2(t, f);
  else if (fi < 343) job = shotS3(t, f);
  else if (fi < 470) job = shotS4(t, f);
  else if (fi < 496) job = shotS4d(t, f);
  else if (fi < 646) job = shotS5(t, f);
  else if (fi < 658) job = shotT2(t, f);
  else job = shotS6(t, f);
  // 门户（T1 日盘虹膜、S3d 面具眼孔）：先把内层场景渲到 rtPortal
  if (job.portal) {
    const p = job.portal;
    setToonGlobals({ keyDir: [-0.30, 0.85, 0.42] });
    look.render(p.scene, p.cam, { ...p.look, paper: false, vignette: 0, grain: 0, target: rtPortal });
    if (p.rain) { overlay.reset(); p.rain(); overlay.render(rtPortal, { addLayer: false }); overlay.reset(); }
  }
  if (job.toon) setToonGlobals(job.toon);
  look.render(job.scene, job.cam, job.look);
  if (job.fx) job.fx();
  overlay.render(null);
  drawHud(t, f);
}

// ── S1 修复室 ──
function shotS1(t, f) {
  const info = room.updateS1(t);
  const fx = () => {
    for (const g of info.glints) overlay.glint(...g);
    if (info.band) { overlay.UA.uBand.value.set(info.bandOff || 0, 340, info.band, 0.6109 + Math.PI / 2); }
    if (info.dot) overlay.UA.uDot.value.set(...info.dot);
    overlay.U.uDust.value = info.dust || 0; overlay.U.uShaft.value.set(760, 420, 0, 330);
  };
  return {
    scene: room.scene, cam: room.cam, fx,
    toon: { keyDir: [-0.55, 0.62, 0.56] },
    look: { t, outline: { ...OL.R, opacity: info.lineOpacity }, kuwahara: false, bloom: { threshold: 0.88, strength: 0.40, radius: 0.60, tint: '#FFE9C0' },
      grade: GR.R, paper: paper(0.12), vignette: 0.16, grain: 0.25 },
  };
}
// ── T1 光轮入书 ──
function shotT1(t, f) {
  const portal = f >= 115.5;
  const info = room.updateT1(t, rtPortal.texture);
  let pj = null;
  if (portal) {
    // 门户里是 S2 雾崖（S2 机位在门户期间一直前推）
    const ci = cliff.updateS2(t);
    pj = { scene: cliff.scene, cam: cliff.cam, look: lookY(t, { bloom: { threshold: 0.92, strength: 0.20, radius: 0.60, tint: '#FFFFFF' } }), rain: () => cliff.rain(overlay, ci) };
  }
  const gU = fseg(f, 116, 139);
  const fx = () => {
    if (info.dot) overlay.UA.uDot.value.set(...info.dot);
    if (info.line) {
      overlay.U.uLine.value.set(520, 5, 1, 1);
      // 门户打开后，屏幕金线只画在虹膜之外；虹膜里由场景 Y 最远一道脊的金边接力（同一条 y、同宽，tech-01 / story-02）
      if (info.irisPx > 0) overlay.U.uLineMask.value.set(960, 520, info.irisPx);
    }
  };
  return {
    scene: room.scene, cam: room.cam, fx, portal: pj,
    toon: { keyDir: [-0.55, 0.62, 0.56] },
    look: { t, outline: OL.R, kuwahara: false,
      bloom: { threshold: 0.80, strength: lerp(0.55, 1.20, fseg(f, 128, 139)), radius: 0.65, tint: '#FFE2A8' },
      grade: mixGrade(GR.R, GR.N, gU), paper: paper(lerp(0.12, 0.10, gU)), vignette: lerp(0.16, 0.12, fseg(f, 81, 139)), grain: 0.25 },
  };
}
// ── S2 南山雾崖 ──
function shotS2(t, f) {
  const ci = cliff.updateS2(t);
  const fx = () => {
    cliff.rain(overlay, ci);
    // 白金闪：f139–f145，峰值 f141（踩 5.867 s）
    // w3（qa2-03）：原来整屏加色 0.85，峰顶三帧平均亮度 251–255、几乎纯白，设计的暖白 #FFF4D6 也没了。
    //   改成按 alpha 盖一层暖白的"幕"（峰值 0.87，底下 S2 透出一层影），只留一点点加色给高光
    const fl = f < 141 ? lerp(0.5, 0.85, fseg(f, 139, 141)) : 0.85 * (1 - ss(fseg(f, 141, 145)));
    if (f < 145) {
      overlay.U.uVeil.value.set(1, 0.957, 0.839, fl * 1.024);
      overlay.UA.uFlash.value.set(1, 0.957, 0.839, fl * 0.03);
    }
    // 金线化进远山：f139 起不再画屏幕金线，只留 3D 里最远一道脊的金边（被近景自然挡住，f139–f170 褪回雾色）
  };
  return { scene: cliff.scene, cam: cliff.cam, fx, toon: { keyDir: [-0.30, 0.85, 0.42] },
    look: lookY(t, { bloom: { threshold: 0.92, strength: f < 145 ? lerp(1.10, 0.20, ss(fseg(f, 141, 145))) : 0.20, radius: 0.60, tint: '#FFFFFF' } }) };
}
// ── S3 面具集市（含 S3d 眼孔门户） ──
function shotS3(t, f) {
  const mi = market.update(t);
  let pj = null;
  if (mi.portal) {
    const ci = cliff.updateS4(14.3);    // S4a 起始机位（C0），门户里是冷雾和雨
    pj = { scene: cliff.scene, cam: cliff.cam, look: lookY(t), rain: () => cliff.rain(overlay, ci) };
    market.setPortal(rtPortal.texture);
  }
  const fi = Math.round(f);
  let grade = GR.M;
  if (fi >= 308 && fi < 331) grade = { ...GR.M, saturation: lerp(1.12, 0.70, fseg(f, 312, 328)) };
  if (fi >= 331) grade = mixGrade(GR.M, GR.N, fseg(f, 335, 343));
  return { scene: market.scene, cam: market.cam, portal: pj, toon: { keyDir: [0.40, 0.60, 0.70] }, fx: mi.fx,
    look: { t, outline: OL.M, kuwahara: KU_M, bloom: { threshold: 0.78, strength: 0.65, radius: 0.70, tint: '#FFD890' }, grade,
      paper: paper(0.08), vignette: fi >= 331 ? lerp(0.20, 0.12, fseg(f, 331, 343)) : 0.20, grain: fi >= 331 ? lerp(0.30, 0.25, fseg(f, 331, 343)) : 0.30 } };
}
// ── S4a–c 豹变（一镜） ──
function shotS4(t, f) {
  const ci = cliff.updateS4(t);
  return { scene: cliff.scene, cam: cliff.cam, toon: { keyDir: [-0.30, 0.85, 0.42] }, fx: () => cliff.fxS4(overlay, ci), look: lookY(t) };
}
// ── S4d 第七天·雾散 ──
function shotS4d(t, f) {
  const ci = cliff.updateS4d(t);
  const u = fseg(f, 470, 494);
  return { scene: cliff.scene, cam: cliff.cam, toon: { keyDir: [0.55, 0.62, 0.35] }, fx: () => cliff.fxS4d(overlay, ci),
    look: lookY(t, { bloom: { threshold: 0.85, strength: 0.35, radius: 0.60, tint: '#FFF2C8' }, grade: { ...GR.Y, warmth: lerp(-0.06, 0.04, u), saturation: lerp(0.92, 1.0, u) }, vignette: lerp(0.12, 0.10, u) }) };
}
const fi_ = f => Math.round(f);
// ── S5 一跃·逍遥（含 #8 #9） ──
function shotS5(t, f) {
  const si = fi_(f) < 635 ? sky.update(t) : sky.updateT2(t, s6.PG);
  const fi = Math.round(f);
  const g = fi < 567 ? GR.S : mixGrade(GR.S, GR.C, fseg(f, 567, 585));
  return { scene: si.scene, cam: si.cam, toon: si.toon, fx: () => si.fx && si.fx(overlay),
    look: { t, outline: OL.S, kuwahara: false, bloom: { threshold: 0.85, strength: 0.45, radius: 0.65, tint: '#FFE9C0' }, grade: g, paper: paper(fi < 567 ? 0.09 : lerp(0.09, 0.04, fseg(f, 567, 585))), vignette: 0.10, grain: 0.25 } };
}
// ── T2 豹眼一闪 ──
function shotT2(t, f) {
  const si = sky.updateT2(t, s6.PG);
  const u = Math.pow(fseg(f, 652, 658), 2);
  return { scene: si.scene, cam: si.cam, toon: si.toon, fx: () => si.fx(overlay),
    look: { t, outline: OL.S, kuwahara: false, bloom: { threshold: 0.85, strength: lerp(0.45, 1.60, u), radius: 0.65, tint: '#FFE9C0' },
      grade: { ...GR.C, exposure: Math.pow(2, 0.6 * u) }, paper: paper(0.05), vignette: 0.10, grain: 0.25 } };
}
// ── S6 回现实 ──
function shotS6(t, f) {
  const si = s6.update(t);
  return { scene: room.scene, cam: room.cam, toon: { keyDir: [-0.55, 0.62, 0.56] }, fx: () => si.fx(overlay),
    look: { t, outline: OL.R, kuwahara: false, bloom: { threshold: 0.88, strength: lerp(1.60, 0.40, eo(fseg(f, 658, 665))), radius: 0.60, tint: '#FFE9C0' },
      grade: GR.R, paper: paper(0.12), vignette: 0.16, grain: 0.25 } };
}

// ───────────────────────── 字幕与纸白（DOM 2D） ─────────────────────────
const CH = [...'君子豹变其文蔚也'];
function drawHud(t, f) {
  g2.setTransform(1, 0, 0, 1, 0, 0);
  g2.clearRect(0, 0, W, H);
  if (f >= 675.5) {
    g2.font = `${80 * K}px BBMSZ`; g2.textAlign = 'center'; g2.textBaseline = 'top';
    for (let i = 0; i < 8; i++) {
      const a = eo(fseg(f, 676 + i, 682 + i));     // fix1（story-16）：逐字间隔 1 帧，f689 八字全显，读得完
      if (a <= 0) continue;
      const col = i < 4 ? 1770 : 1660, row = i % 4;
      g2.fillStyle = `rgba(43,38,34,${(0.90 * a).toFixed(4)})`;
      g2.fillText(CH[i], col * K, (170 + 98 * row + 6 * (1 - a)) * K);
    }
  }
  const pw = ss((t - 29.55) / 0.40);
  if (pw > 0) { g2.fillStyle = `rgba(242,237,224,${pw.toFixed(4)})`; g2.fillRect(0, 0, W, H); }
}

// ───────────────────────── 页面约定 ─────────────────────────
window.DUR = 30;
window.render = t => frame(Math.min(Math.max(+t || 0, 0), 30 - 1e-6));
window.TEXTS = t => (t * 24 >= 676 ? ['君子豹变', '其文蔚也'] : []);
// 预热：每段渲一次，把着色器都编译好
for (const t of [0.5, 2.0, 2.6, 3.6, 4.6, 5.0, 5.5, 6.0, 9.5, 11.0, 11.6, 12.8, 13.5, 14.0, 14.8, 15.3, 16.5, 18.0, 19.5, 20.8, 21.8, 23.5, 25.0, 26.4, 26.9, 27.3, 27.6, 28.6, 29.9]) window.render(t);
window.render(0);
window.READY = true;
