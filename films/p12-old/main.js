// 北冥风格路线 · WebGL 三渲二 · 最小模版作品（由 routes/a-webgl/template 复制到 films/<名字>/）。
// 一个镜头把六层配方各用一次，换成自己的内容时按层替换：
//   ① 造型   engine/form/rock.js 的 spire / mesa：程序化山峰与台地（随机只来自 mulberry 种子）
//   ② 着色   engine/shade/toon.js + surface.js：三档卡通分档、投影量化、背光边缘光、物体空间锈斑
//   ③ 底板   engine/stage/plates.js + camera.js：三层程序化画布（天空、远山、近山）+ 一个加色太阳在起始机位下按屏幕像素摆好，相机平移时由真实透视出视差
//   ④ 时钟   engine/core/clock.js：镜头 24 fps 平滑，墨线一拍二沸腾（look 的 boilFps）
//   ⑤ 后期   engine/look：墨线 → 雾 → bloom → 调色 → Kuwahara → 纸纹 → 暗角
//   ⑥ 显示层 engine/overlay/text.js：片名画在最上层画布，不过后期；window.TEXTS 报告字的方框
// 时长 / 帧率 / 设计画幅读 film.json；页面约定（window.DUR / render(t) / READY / TEXTS）由 engine/stage/film.js 兑现。
// 确定性：不用 Date.now、不用 Math.random；同一个 t 永远画出同一张图。
import * as THREE from 'three';
import { createFilm } from '../../engine/stage/film.js';
import { createLook } from '../../engine/look/index.js';
import { toonKind, setToonShared } from '../../engine/shade/toon.js';
import { patchLayer } from '../../engine/shade/surface.js';
import { spire, mesa } from '../../engine/form/rock.js';
import { canvasLayer, plate, glowSprite } from '../../engine/stage/plates.js';
import { aimCamera, placeOnScreen } from '../../engine/stage/camera.js';
import { loadFonts, createOverlay, fontSpec, measure } from '../../engine/overlay/text.js';
import { mulberry, ss, seg, lerp, eio } from '../../engine/core/math.js';
import { hold } from '../../engine/core/clock.js';

const FILM = await (await fetch('./film.json')).json();
const DUR = FILM.dur, FPS = FILM.fps;

// 镜头按 film.json 的设计画幅摆；--size 给更大的画面（如 4K）时，引擎按 K = 实际高 / 设计高 放大，构图不变
const film = createFilm({ designHeight: FILM.size[1] });
const { W, H, K, DW, DH } = film;
const look = createLook(film.renderer, W, H, { ss: 2, msaa: 4, refHeight: 1080, fogColor: '#9C8FD8' });

// ───────────────────────── 色板（换画风先换这里） ─────────────────────────
const C = {
  zenith: '#4F5BBF', lavender: '#9C8FD8', pink: '#F2A0A6', apricot: '#FFB26B',
  ridgeFar: '#8E7CC3', ridgeNear: '#6A64AE',
  rock: '#8C86C8', rockShade1: '#5E5A9E', rockShade2: '#3C3A72', rim: '#FFD3B0', rust: '#7A5C9E', ink: '#2A2D52',
};

// ───────────────────────── ③ 底板：程序化画布 ─────────────────────────
function skyCanvas() {
  const { canvas, ctx, tex } = canvasLayer(1536, 832);
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, C.zenith); g.addColorStop(0.45, C.lavender); g.addColorStop(0.78, C.pink); g.addColorStop(1, C.apricot);
  ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 几抹横云：确定性随机
  const R = mulberry(11);
  for (let i = 0; i < 14; i++) {
    const x = R() * canvas.width, y = canvas.height * (0.25 + R() * 0.45), w = 120 + R() * 260, h = 10 + R() * 18;
    ctx.fillStyle = `rgba(247,169,143,${(0.18 + R() * 0.22).toFixed(3)})`;
    ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2); ctx.fill();
  }
  tex.needsUpdate = true;
  return tex;
}
function ridgeCanvas(seed, color, base, amp) {
  const { canvas, ctx, tex } = canvasLayer(2048, 512);
  const R = mulberry(seed), ph = [R() * 6.28, R() * 6.28, R() * 6.28];
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, canvas.height);
  for (let x = 0; x <= canvas.width; x += 8) {
    const u = x / canvas.width;
    const y = base - amp * (0.55 * Math.sin(u * 7.1 + ph[0]) + 0.3 * Math.sin(u * 17.3 + ph[1]) + 0.15 * Math.sin(u * 41 + ph[2]));
    ctx.lineTo(x, y * canvas.height);
  }
  ctx.lineTo(canvas.width, canvas.height); ctx.closePath(); ctx.fill();
  tex.needsUpdate = true;
  return tex;
}

// ───────────────────────── 镜头 ─────────────────────────
function buildShot() {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, DW / DH, 0.5, 800);
  const CAM0 = new THREE.Vector3(-3, 4.6, 46), CAM1 = new THREE.Vector3(3, 5, 42);
  aimCamera(cam, CAM0, 0, -0.06);

  // 底板在起始机位下摆：比画面宽 40%，相机平移不露边；远的离相机 400，近的 140 → 视差不同
  const sky = plate(skyCanvas(), 0); placeOnScreen(sky, cam, DW, DH, DW / 2, DH * 0.46, DW * 1.4, 400, DH * 1.3); scene.add(sky);
  const far = plate(ridgeCanvas(3, C.ridgeFar, 0.55, 0.16), 1); placeOnScreen(far, cam, DW, DH, DW / 2, DH * 0.62, DW * 1.4, 300, DH * 0.42); scene.add(far);
  const near = plate(ridgeCanvas(5, C.ridgeNear, 0.62, 0.2), 2); placeOnScreen(near, cam, DW, DH, DW / 2, DH * 0.8, DW * 1.5, 140, DH * 0.56); scene.add(near);
  const sun = glowSprite('#FFE2B8', { order: 1.5, amt: 1.6, core: 1.4 }); placeOnScreen(sun, cam, DW, DH, DW * 0.7, DH * 0.5, 260, 350, 260); scene.add(sun);

  // ①② 造型 + 卡通着色：同一族材质（共享着色器），每个物体一个 ID，墨线在物体之间也画得出来
  const kind = toonKind({ name: 'tpl-rock', firstId: 1, layers: [patchLayer()] });
  const rockOpts = {
    color: C.rock, shade1: C.rockShade1, shade2: C.rockShade2, step1: 0.55, step2: 0.25,
    rimColor: C.rim, rimAmt: 0.9, rimInside: 0.35, rimPower: 0.3,
    rustColor: C.rust, rustAmt: 0.55, rustThr: 0.08, patchScale: 0.14, inkColor: C.ink,
  };
  const R = mulberry(20261109);
  const add = (geo, opts, pos) => {
    const m = kind.bind(new THREE.Mesh(geo),kind.make({ ...rockOpts, ...opts }));
    m.position.set(...pos); scene.add(m); return m;
  };
  add(mesa(R, { cx: 0, cz: 0, rx: 8, rz: 4.5, yTop: () => 0, yBot: () => -5, dome: 0.6, seed: 0.3 }), { color: '#7C77BC' }, [0, -0.2, 0]);
  add(spire(R, 11, 2.6, { steps: 4, lean: [0.06, 0], seed: 0.1 }), {}, [-3.2, 0.6, 0.5]);
  add(spire(R, 6.5, 1.9, { steps: 3, lean: [-0.08, 0.04], seed: 0.2 }), { color: '#9A92D0' }, [4.2, 0.5, -1.4]);

  // 主光 = 第一盏投影的平行光（toon 只取方向和投影，颜色由色板给定）
  const key = new THREE.DirectionalLight('#ffffff', 1); key.position.set(14, 10, -6); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -8, near: 1, far: 60 });
  key.shadow.bias = -0.0005; scene.add(key, key.target);

  function update(t, f) {
    // ④ 镜头 24 fps 平滑推移；墨线抖动时钟一拍二
    const u = eio(t / DUR);
    aimCamera(cam, new THREE.Vector3().lerpVectors(CAM0, CAM1, u), lerp(0.02, -0.03, u), -0.06);
    setToonShared(kind.shared, { inkTime: hold(f, 2) });
  }

  // ⑤ 后期参数（像素量按 1080 高标定）；写 false / null 关掉某一道
  const lookAt = t => ({
    t,
    outline: { width: 2.6, color: C.ink, wobble: 1.1, boilFps: 12, pressure: 0.35, breakup: 0.08, tint: 0.15 },
    kuwahara: { radius: 4, strength: 1, farRadius: 6, farStart: 40, farEnd: 160 },
    bloom: { strength: 0.6, threshold: 0.72, radius: 0.65, knee: 0.25 },
    grade: { exposure: 1, warmth: 0.1, lift: [0.03, 0.02, 0.05], saturation: 1.04, shoulder: 0.9 },
    fog: { color: C.lavender, colorHigh: C.pink, density: 0.01, start: 24, max: 0.5, cutoff: 200 },
    paper: { strength: 0.12 }, vignette: 0.22, grain: 0,
  });

  return { scene, camera: cam, update, look: lookAt };
}

// ───────────────────────── ⑥ 显示层：片名 ─────────────────────────
await loadFonts([['Barlow', '../../fonts/Barlow-500.woff2', 500], ['Barlow', '../../fonts/Barlow-300.woff2', 300]]);
const O = createOverlay({ ink: [234, 246, 255], glow: [159, 232, 255], halo: [42, 45, 82], fill: [20, 22, 50] });
function drawTitle(ctx, t) {
  const S = H / 1040, a = ss(seg(t, 0.8, 1.5)), b = ss(seg(t, 1.2, 1.9));
  const x = W * 0.08, y = H * 0.36;
  const f1 = fontSpec(500, 72 * S, ['Barlow']), f2 = fontSpec(300, 22 * S, ['Barlow']);
  const m1 = measure(FILM.title, f1, 6 * S);
  O.glowText(ctx, FILM.title, x, y, f1, O.theme.ink, a, S, { ls: 6 * S });
  O.rec('title', FILM.title, x, y - m1.asc, x + m1.w, y + m1.desc, a);
  const sub = 'BEIMING ENGINE · WEBGL TOON';
  const m2 = measure(sub, f2, 4 * S);
  O.glowText(ctx, sub, x, y + 46 * S, f2, O.theme.glow, b * 0.9, S, { ls: 4 * S });
  O.rec('subtitle', sub, x, y + 46 * S - m2.asc, x + m2.w, y + 46 * S + m2.desc, b);
}

const shot = buildShot();
await film.run({
  dur: DUR, fps: FPS, post: look,
  shots: [{ at: 0, shot }],
  draw: (ctx, t) => drawTitle(ctx, t),
  texts: t => O.collect(() => drawTitle(null, t)),
  warm: [0, DUR / 2],
});
