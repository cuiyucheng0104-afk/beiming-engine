// 棱光 PRISM · 玻璃质感产品片。render(t) 确定性：无随机、无系统时间，任意一帧可单独渲染。
import * as THREE from 'three';
import { makePost } from '/core/three/post.js';
import { clamp, seg, eio, eo, ei, ss, lerp, hash } from '/core/lib.js';
import { DUR, T, BEAT, FPS, shotAt, EV, PART_DELAY } from './timeline.js';
import { makeBottle, explode, ACC_A, ACC_B } from './product.js';
import { makeStudio, SPECTRUM } from './studio.js';

const QS = new URLSearchParams(location.search), NOTEXT = QS.has('notext');
const W = 1920, H = 1080;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(2); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.1;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, W / H, 1, 4000);
const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: false });
post.bloom.strength = .2; post.bloom.threshold = 1.1; post.bloom.radius = .45;
post.vig.uniforms.amt.value = .32; post.vig.uniforms.contrast.value = .12;

const studio = makeStudio(renderer, scene);
const B = makeBottle(); scene.add(B.root);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// —— 光路：左上方光源 → 左侧瓶面入射点 E → 玻璃内 → 右侧瓶面出射点 X → 七色扇形落到地面 ——
const SRC = V(-430, 330, 70), E = V(-22.6, 64.2, 2), X = V(23.2, 42, 7);   // E = 左侧瓶肩棱边
const F = SPECTRUM.map((c, k) => V(118 + k * 3, 0, -34 + k * 13));   // 七色落点沿 z 摊开成扇
const beamIn = studio.beam(SRC, E, 3.2, 1.6, '#ffffff');
const beamInside = studio.beam(E, X, 2.0, 2.4, '#f4f2ff'); beamInside.material.depthTest = false; beamInside.renderOrder = 11;
const rays = SPECTRUM.map((c, k) => { const m = studio.beam(X, F[k], .8, 3.4, c); m.material.uniforms.uSoft.value = 1.6; return m; });
// 入射/出射的光点（加色精灵）
const dotTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.18, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
const glint = (p) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: '#ffffff', blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false })); s.position.copy(p); s.renderOrder = 12; scene.add(s); return s; };
const gE = glint(E), gX = glint(X);
const rainAx = F[6].clone().sub(F[0]); studio.U.uRainAx.value.set(rainAx.x, rainAx.z).normalize();

function lightPath(t, on, showIn = true) {
  const show = on && t >= T.beam;
  beamIn.visible = beamInside.visible = gE.visible = gX.visible = show && showIn;
  const dS = p => camera.position.distanceTo(p) / 420;
  const db = t - T.beam;
  if (show) {
    const hit = Math.exp(-db / .18);
    beamIn.material.uniforms.uI.value = 1.7 + 4 * hit; beamIn.material.uniforms.uLen.value = 1; beamIn.material.uniforms.uHead.value = 0;
    beamInside.material.uniforms.uI.value = 1.2 + 2.5 * hit;
    gE.material.opacity = 1; gE.scale.setScalar((14 + 34 * hit) * dS(E)); gE.material.color.setScalar(2.2 + 6 * hit);
    gX.scale.setScalar((9 + 9 * ss(seg(t, T.rays[0], T.rays[6] + .2))) * dS(X)); gX.material.color.setScalar(1.6 * ss(seg(t, T.rays[0], T.rays[0] + .1)));
  }
  rays.forEach((r, k) => {
    const d = t - T.rays[k], vis = on && d >= 0; r.visible = vis;
    const u = r.material.uniforms, f = Math.exp(-Math.max(d, 0) / .22);
    u.uLen.value = clamp(eo(d / (3 / FPS)) * 1.001, 0, 1); u.uI.value = 1.6 + 3 * f; u.uHead.value = d < .25 ? 1 - d / .25 : 0;
    const R = studio.U.uRain.value[k], land = ss(seg(d, 2 / FPS, .45));
    R.set(F[k].x, F[k].z, 7.5, vis ? (.55 + .9 * f) * land : 0);
  });
}

// —— 镜头 ——
const orbit = (c, az, el, d) => c.clone().add(V(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d));
const SW = (t, a, b) => { const u = seg(t, a, b); return u > 0 && u < 1 ? u : null; };
let lastFrame = {};
function frame(t) {
  const [name, t0, t1] = shotAt(t), u = seg(t, t0, t1);
  let pos, look, fov = 28, focus = null, aper = 220, up = V(0, 1, 0);
  const envO = { left: 1, right: 1, back: 1, top: 1, front: 1, key: 0, beam: 0, accent: 0 };
  let bg = .55, sweep = null, beamOn = false, bloom = .2, pool = .0, spot = .02, refl = .3;
  let es = 0, spin = 0, shake = 0, showIn = true, envI = 1, cardP = null;
  studio.wall.visible = false;
  B.root.position.set(0, 0, 0); B.root.rotation.set(0, 0, 0);
  const waves = [];

  switch (name) {
    case 'contour': {   // 黑场：只有一条灯条从相机背后扫过，轮廓被勾出来
      const amb = ss(seg(t, 0, 2.3)), b1 = ss(seg(t, 0, BEAT));   // 第一拍内侧灯条亮起，勾出瓶肩与底边
      Object.assign(envO, { left: .45 + .35 * b1 + .2 * amb, right: .45 + .35 * b1 + .2 * amb, back: .55 + .3 * b1, top: .08, front: 0 });
      cardP = [V(0, 46, 0), 150, 120, 260, .08 + .1 * b1];
      // 第 0 帧灯条就已经在画面左缘的瓶边上（不留黑帧），扫到正中（1.25）最亮
      const s = SW(t + 1e-6, ...T.sweep1); if (s != null) sweep = { x: lerp(-1, 1, s), I: 2.2 + 6 * Math.sin(s * Math.PI) ** 1.5, tilt: .18 };
      pos = V(-66, 58, 320).lerp(V(-50, 54, 268), eio(u)); look = V(0, 50, 0); fov = 28; focus = V(-6, 52, 18); aper = 180;
      bg = 1.3 + .26 * amb; refl = .3; break;
    }
    case 'beam': {      // 高 3/4 慢环绕：白光射入，七色射出
      beamOn = true; envI = 1.6; Object.assign(envO, { left: 2.2, right: 2.2, back: 1.2, top: 1.0, front: 0, beam: 6 * Math.exp(-Math.max(0, t - T.beam) / .3) + 1.5 });
      const az = lerp(-.3, .05, eio(u));
      look = V(40, 40, 4); pos = orbit(look, az, .5, 318); fov = 28; focus = V(6, 48, 6); aper = 120;
      bg = .75; pool = .25; bloom = .24; cardP = [V(0, 46, 0), 170, 210, 260, .22]; break;
    }
    case 'macro': {     // 侧面微距：厚棱边上的光谱，焦点从瓶壁表面转到内部吸管
      Object.assign(envO, { left: 1.3, right: 1.5, back: 1.0, top: .45, front: .1, key: 0 }); envI = 1.25;
      const k = eio(u);
      pos = V(lerp(44, 30, k), lerp(78, 72, k), lerp(78, 64, k)); look = V(lerp(4, 1, k), lerp(64, 62, k), 10);
      fov = 30; const fk = eio(seg(t, t0, T.focusLand));
      focus = V(1, 62, 27).lerp(V(0, 60, 0), fk); aper = 950;
      bg = .75; pool = .3;
      const s = SW(t, T.macroSweep - BEAT, T.macroSweep + BEAT); if (s != null) sweep = { x: lerp(-1, 1, s), I: 1.7 * Math.sin(s * Math.PI) ** 1.5, tilt: -.3 };
      break;
    }
    case 'caustic': {   // 俯拍：焦散与彩带落在桌面，摇臂下降 + 绕垂直轴旋转
      beamOn = true; Object.assign(envO, { left: 1, right: 1, back: 1, top: .5, front: 0, beam: 1.5 });
      const k = eio(u), r = lerp(-.35, .25, k), h = lerp(480, 330, k);
      look = V(58, 0, 22); pos = look.clone().add(V(0, h, 1)); up = V(Math.sin(r), 0, -Math.cos(r));
      fov = 34; focus = V(58, 0, 22); aper = 120; bg = .3; pool = .55; spot = .04; bloom = .26;
      T.rings.forEach((tr, i) => { const d = t - tr; if (d >= 0 && d < 2.2) waves.push([0, 0, 22 + 95 * d, (i === 0 ? .9 : .65) * Math.exp(-d / .7)]); });
      break;
    }
    case 'lensA': {     // 透过瓶身看灯墙：相机横移，背景在厚玻璃里被放大、弯折、分裂
      studio.wall.visible = true; Object.assign(envO, { left: .7, right: .7, back: .8, top: .6, front: .1 });
      const k = eio(u), x = lerp(40, -31, k);
      pos = V(x, 50, 158); look = V(x * .12, 44, 0); fov = 30; focus = V(0, 44, 25); aper = 140;
      bg = .2; pool = .3; refl = .32; break;
    }
    case 'lensB': {     // 快推瓶盖切面：背景被切面切成好几块
      studio.wall.visible = true; Object.assign(envO, { left: .7, right: .7, back: .8, top: .7, front: .1 });
      const k = eio(u) * .65 + ei(u) * .35;
      pos = V(30, 103, 178).lerp(V(13, 93, 70), k); look = V(0, 88, 0); fov = 30; focus = V(0, 89, 14); aper = 380;
      bg = .2; pool = .3; break;
    }
    case 'explode': {   // 停 → 爆炸视图 → 悬浮（全静）→ 合盖 → 拉远给名字
      Object.assign(envO, { left: 3.4, right: 3.4, back: .12, top: 2.2, front: .5, key: 1.3 }); bg = 1.6; envI = 1.7; spot = .06;
      // 每个部件：13.125（错开 2 帧）缓出拉开 → 14.375 起悬浮漂移 +3% → 14.833 极短缓入 → 15.000 合上
      es = PART_DELAY.map((dl, i) => {
        const a = T.apart + dl;
        if (t < a) return 0;
        if (t < T.hover) return eo(seg(t, a, i === 1 ? a + BEAT : T.hover));   // 吸管一拍内就抽出瓶口（穿过瓶身前上棱的时间尽量短）
        if (t < T.snapIn) return 1 + .03 * seg(t, T.hover, T.snapIn);
        if (t < T.snap) return 1.03 * (1 - ei(seg(t, T.snapIn, T.snap)));
        return 0;
      });
      spin = (t - T.apart) * 1.2 * (t < T.snap ? 1 : 0);
      const eMax = Math.max(...es);
      const ow = seg(t, T.stop, T.snap), tail = seg(t, T.snap, DUR), az = lerp(.62, .32, eio(ow)) - .1 * eio(tail) - .09 * tail;   // 合盖后一直保持匀速微环绕到最后一帧
      // 合上后快速拉远（缓出），标题落定（15.625）时瓶子已经让出上三分之一，之后慢慢漂到最远
      const pu = seg(t, T.snap + .08, T.sub + .7), pull = 1 - (1 - pu) ** 3;
      const el = lerp(.32, .14, pull), d = lerp(310, 400, eMax ** .8) * (1 - pull) + (470 + 26 * seg(t, T.sub, DUR)) * pull;
      look = V(0, lerp(52, 98, eMax ** .8), 0).lerp(V(0, 104, 0), pull);
      cardP = [V(0, 40, 0), 120, 125, 230, .5 - .2 * pull];
      pos = orbit(look, az, el, d);
      fov = 28; focus = V(0, 50 + 60 * eMax, 0); aper = lerp(60, 120, pull);
      if (t >= T.snap) { const kk = Math.exp(-(t - T.snap) / .07), fr = Math.round(t * FPS); shake = kk; pos.add(V(hash(fr) - .5, hash(fr + 9) - .5, 0).multiplyScalar(kk * 3)); }
      // 合盖：一串光环从瓶底扩散；之后焦散池留在地上慢慢呼吸
      [T.snap, T.snap + BEAT / 3, T.snap + BEAT * 2 / 3].forEach((tr, i) => { const dd = t - tr; if (dd >= 0 && dd < 2.4) waves.push([0, 0, 24 + 110 * dd, (i === 0 ? 1.3 : .6) * Math.exp(-dd / .75)]); });
      if (t >= T.snap) { const dd = t - T.snap; pool = .2 + .7 * Math.exp(-dd / .4) + .1 * (.5 + .5 * Math.sin(dd * 2.6)); envO.accent = 2.5 * Math.exp(-dd / .25); bloom = .2 + .25 * Math.exp(-dd / .3); }
      const s2 = SW(t, ...T.sweep2); if (s2 != null) sweep = { x: lerp(-1, 1, s2), I: 3 * Math.sin(s2 * Math.PI) ** 1.5, tilt: -.2 };
      break;
    }
  }
  explode(B, es, spin);
  lightPath(t, beamOn, showIn);

  camera.position.copy(pos); camera.up.copy(up); camera.fov = fov; camera.updateProjectionMatrix(); camera.lookAt(look);
  if (cardP) studio.backCard(camera, ...cardP); else studio.backCard(camera, look, 0, 1, 1, 0);
  const camAz = Math.atan2(camera.position.x, camera.position.z);
  if (sweep) sweep.az = camAz + Math.PI;
  studio.updateEnv(Object.assign(envO, { sweep: sweep || { I: 0 }, accentCol: ACC_A.clone().lerp(ACC_B, .4) }));
  scene.backgroundIntensity = bg; scene.environmentIntensity = envI;
  post.dof.focus = focus ? camera.position.distanceTo(focus) : 300; post.dof.aper = aper; post.dof.maxCoc = 14;
  post.bloom.strength = bloom;
  const U = studio.U; U.uTime.value = t * .55; U.uSpot.value = spot; U.uBgI.value = bg; U.uRefl.value = refl;
  U.uPool.value.set(0, 0, 46, pool); U.uPoolOff.value.set(12, 6);
  U.uWave.value.forEach((w, i) => { const v = waves[i]; w.set(...(v || [0, 0, 0, 0])); });
  lastFrame = { name, shake };
  return name;
}

// —— 2D 层：片尾名卡（超细宽字距，斜向高光与灯条同步扫过）——
const ov = document.getElementById('ov'), g = ov.getContext('2d');
await Promise.all(['200 130px "Noto Sans SC"', '300 30px "Noto Sans SC"', '500 18px "Inter Tight"'].map(f => document.fonts.load(f, '棱光一束七种颜色PRISM')));
function spaced(text, x, y, font, sp) { g.font = font; g.letterSpacing = sp + 'px'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, x + sp / 2, y); g.letterSpacing = '0px'; }
// 一个字一个字落定：从上方 22px、透明处缓出落下，最后一个字正好在 land 落定
function landText(text, y, font, sp, land, dur, a0 = 1) {
  g.font = font; g.letterSpacing = sp + 'px';
  const chars = [...text], ws = chars.map(c => g.measureText(c).width), tot = ws.reduce((s, w) => s + w, 0);
  let x = W / 2 - tot / 2 + sp / 2;
  chars.forEach((c, i) => {
    const Li = land - (chars.length - 1 - i) * .06, kk = eo(seg(T_now, Li - dur, Li));   // 第 i 个字在 Li 落定，最后一个字落在 land（拍点）
    g.save(); g.globalAlpha = a0 * clamp(kk * 1.25); g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(c, x, y - 22 * (1 - kk)); g.restore(); x += ws[i];
  });
  g.letterSpacing = '0px';
}
let T_now = 0;
function glintBand(y, h, gx) {
  if (gx == null) return;
  g.save(); g.globalCompositeOperation = 'source-atop';
  const gr = g.createLinearGradient(gx - 190, y - 120, gx + 190, y + 120);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.4, 'rgba(98,214,255,.0)'); gr.addColorStop(.47, 'rgba(160,226,255,.85)'); gr.addColorStop(.5, 'rgba(255,255,255,1)'); gr.addColorStop(.53, 'rgba(196,172,255,.85)'); gr.addColorStop(.6, 'rgba(166,140,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, y - h, W, h * 2); g.restore();
}
const TITLE = { y: 232, font: '200 130px "Noto Sans SC"', sp: 64, text: '棱光' };
const SUB = { y: 352, font: '300 30px "Noto Sans SC"', sp: 16, text: '一束光　七种颜色' };
const KICK = { y: 408, font: '500 18px "Inter Tight"', sp: 9, text: 'PRISM · EAU DE PARFUM' };
const titleOn = t => t >= T.title - .5, subOn = t => t >= T.sub - .5;
function hud(t) {
  T_now = t; g.clearRect(0, 0, W, H);
  if (NOTEXT) return;
  if (titleOn(t)) {
    g.save(); g.fillStyle = 'rgba(238,243,248,.95)'; landText(TITLE.text, TITLE.y, TITLE.font, TITLE.sp, T.title, .5); g.restore();
    const s2 = SW(t, ...T.sweep2); glintBand(TITLE.y, 110, s2 != null ? lerp(W * .3, W * .7, s2) : null);
  }
  if (subOn(t)) {
    g.save(); g.fillStyle = 'rgba(225,232,240,.9)'; landText(SUB.text, SUB.y, SUB.font, SUB.sp, T.sub, .5); g.restore();
    const a = ss(seg(t, T.sub - .3, T.sub + .2));
    g.save(); g.globalAlpha = a * .75; g.fillStyle = '#c6cfd8'; spaced(KICK.text, W / 2, KICK.y, KICK.font, KICK.sp); g.restore();
    // 一条细的强调色线（光的颜色）：在副标题与小字之间，从中间展开
    const lw = 160 * eo(seg(t, T.sub - .2, T.sub + .3));
    const lg = g.createLinearGradient(W / 2 - lw, 0, W / 2 + lw, 0); lg.addColorStop(0, 'rgba(98,214,255,0)'); lg.addColorStop(.5, 'rgba(160,190,255,.7)'); lg.addColorStop(1, 'rgba(166,140,255,0)');
    g.fillStyle = lg; g.fillRect(W / 2 - lw, 381, lw * 2, 1.2);
  }
}
// readcheck：每段文字从第一帧可见起报告全文和外框
function box(o) { g.font = o.font; g.letterSpacing = o.sp + 'px'; const w = g.measureText(o.text).width; g.letterSpacing = '0px'; const h = parseInt(o.font.split(' ')[1]); return { x0: W / 2 - w / 2, x1: W / 2 + w / 2 + o.sp, y0: o.y - h * .7, y1: o.y + h * .7 }; }
window.TEXTS = t => {
  const out = [];
  if (!NOTEXT && titleOn(t)) out.push({ id: 'title', text: TITLE.text, ...box(TITLE) });
  if (!NOTEXT && subOn(t)) { out.push({ id: 'sub', text: SUB.text, ...box(SUB) }); out.push({ id: 'kick', text: KICK.text, ...box(KICK) }); }
  return out;
};

window.render = t => {
  frame(t);
  scene.updateMatrixWorld(); camera.updateMatrixWorld();
  studio.reflect(camera, [beamIn, beamInside, gE, gX]);
  post.composer.render();
  hud(t);
};
window.DUR = DUR;
window.EV = EV;
window.READY = true;
