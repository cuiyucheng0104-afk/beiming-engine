// src/main.js —《北冥》10 秒概念样片 · 正片入口（合成与渲染总监）
// 三渲二 + 2.5D 合成，六层配方：
//   ① 3D 简单几何体（鲲、渡船）+ 实例化海草 / 藤壶 / 珊瑚 / 海葵   —— kun.js / ferry.js
//   ② 卡通着色（三档色阶、背光边缘光、锈斑噪点、抖动墨线）         —— toon.js + look.js（屏幕空间墨线）
//   ③ 2D 手绘底板作 3D 场景里的面片 / 穹顶分层，镜头运动产生真实视差 —— scene.js + shotA/B/C
//   ④ 角色一拍二、鲲一拍三；镜头、底板、雾、水 24 fps 平滑          —— 各镜头 update(t, f) 里量化
//   ⑤ 后期：雾（3D 物体自带）→ bloom → 暖色调色 → Kuwahara 颜料笔触 → 墨线 → 纸纹 → 暗角 → 颗粒 —— look.js
//   ⑥ 逐帧离线渲染（engine/render），ffmpeg 编码，base64 单文件 HTML —— build.sh
// 眼镜显示层与片名画在最上层的 2D 画布上（不过后期：不加颗粒、不受 bloom / Kuwahara 影响）。
// 页面约定：window.DUR、window.render(t)（确定性，任意帧单独可渲）、window.READY、window.TEXTS(t)。
import * as THREE from 'three';
import { createLook } from './look.js';
import { loadHUDFonts, drawHUD, drawTitle, textsAt, setHUDTheme, setTitleLayout, HUD_T } from './hud.js';
import { loadPlates } from './scene.js';
import { buildShotA } from './shotA.js';
import { buildShotB } from './shotB.js';
import { buildShotC } from './shotC.js';

const q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight;
// 镜头的底板、渡船、导航线是按 1040 高的设计稿用像素坐标摆的：画面更大（如 3840×2080 原生 4K）时，镜头仍在设计尺寸里摆，
// 渲染器、后期（look.js 按 h/1080 缩放）和显示层（hud.js 按 h/1040 缩放）用实际像素；镜头交给显示层的屏幕坐标乘 K。1040 高时 K = 1，与原来逐字节一致
const K = H / 1040, DW = W / K, DH = H / K;
const hudPx = s => K === 1 ? s : { ...s, eye: s.eye && { x: s.eye.x * K, y: s.eye.y * K, r: s.eye.r * K }, nav: s.nav.map(p => ({ x: p.x * K, y: p.y * K })) };

// ── 渲染器：线性 HDR 工作流，输出 sRGB，不做色调映射（保色板） ──
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.cssText = 'position:absolute;left:0;top:0;z-index:1';
document.body.appendChild(renderer.domElement);

// 显示层画布（最上层，不过后期）
const hud = document.createElement('canvas'); hud.width = W; hud.height = H;
hud.style.cssText = 'position:absolute;left:0;top:0;z-index:10;pointer-events:none';
document.body.appendChild(hud);
const hctx = hud.getContext('2d');

const look = createLook(renderer, W, H, { ss: 2, msaa: 4, paperUrl: './assets/plates/paper.png' });

const NAMES = ['sky_dawn', 'sky_tall', 'shotB_sky', 'clouds_back', 'clouds_front_a', 'clouds_front_b', 'skyline_pudong', 'skyline_pudong_reflect', 'skyline_bund', 'river', 'mist_low'];
const [{ tex }] = await Promise.all([loadPlates(NAMES), loadHUDFonts()]);

// 显示层：按任务书色板用中性青白（#EAF6FF / #9FE8FF）；片名写得更快一点，让完整片名在画面上多停一会儿
setHUDTheme(q.get('theme') || 'neutral');
Object.assign(HUD_T, { titleA: [9.0, 9.27], titleB: [9.3, 9.6], subIn: 9.45, subFull: 9.72 });
setTitleLayout({ x: +(q.get('tx') || 0.088), y: +(q.get('ty') || 0.43) });   // 片名放在左侧中部的开阔天空里（鲲从画面上方离开）

const shotA = buildShotA({ W: DW, H: DH, tex, q });
const shotB = buildShotB({ W: DW, H: DH, K, img: tex.shotB_sky.image, q });
const shotC = buildShotC({ W: DW, H: DH, tex, q });

const pick = t => (t < 3 ? shotA : t < 5 ? shotB : shotC);
const DBG = q.get('dbg');

window.DUR = 10;
window.render = t => {
  t = Math.min(Math.max(t, 0), window.DUR - 1e-6);
  const f = Math.round(t * 24);                    // 帧号：所有量化都用它（避免 t*8 的浮点误差）
  const S = pick(t);
  S.update(t, f);
  const p = S.look(t);
  if (DBG) p.debug = DBG;
  look.render(S.scene, S.camera, p);
  hctx.clearRect(0, 0, W, H);
  if (!q.get('nohud')) {
    if (S === shotC) drawHUD(hctx, t, W, H, hudPx(shotC.hudState));
    drawTitle(hctx, t, W, H);
  }
  if (q.get('markers') && S === shotC) shotC.markers(hctx, q.get('markers') === 'log');
};
window.TEXTS = t => textsAt(t, W, H);

await look.ready;
// 预热：每个镜头渲一帧（编译着色器、上传贴图、生成阴影贴图），避免第一帧卡顿
for (const t of [0.5, 2.0, 3.6, 5.3, 7.5, 9.6]) window.render(t);
window.render(0);
window.READY = true;
