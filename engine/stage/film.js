// 北冥引擎 · 影片外壳：渲染器、最上层的 2D 显示层、设计尺寸缩放、按时间切镜头，并兑现页面约定（engine/render/page.mjs）。
// 渲染器走线性工作流：输出 sRGB、不做色调映射（保色板），开软阴影。显示层画布叠在最上面，不过后期（不加颗粒、不受辉光与笔触影响）。
// 镜头按 designHeight 高的设计稿用像素坐标摆；实际画面更大（如原生 4K）时镜头仍在设计尺寸 DW×DH 里摆，
// 渲染器、后期、显示层用实际像素 W×H，镜头交给显示层的屏幕坐标乘 K（= H / designHeight）。K = 1 时与按实际像素摆完全一致。
//
//   createFilm({ width, height, designHeight, shadows }) → { renderer, overlay, ctx, W, H, K, DW, DH, run }
//     shadows   阴影贴图类型（THREE.*ShadowMap），false = 不开阴影
//   film.run({ dur, fps, shots, post, debug, draw, texts, warm })   设好 window.DUR / render / TEXTS，预热后置 window.READY
//     shots     [{ at: 开始秒, shot }]，按开始时间升序；镜头 = { scene, camera, update(t, f), look(t) → 后期参数 }
//     post      后期：{ render(scene, camera, params), ready }
//     debug     非空时写进后期参数的 debug（调试视图）
//     draw(ctx, t, shot)   每帧在清空的显示层上画（字幕、界面、调试标记）
//     texts(t)  该时刻画面上的文字（window.TEXTS）
//     warm      预热时刻：每个镜头渲一帧，提前编译着色器、上传贴图、生成阴影贴图，最后回到 t = 0
// render(t) 的帧号 f = frameOf(t, fps)，镜头里的一拍二、一拍三都从它量化（engine/core/clock.js）。
import * as THREE from 'three';
import { frameOf } from '../core/clock.js';

export function createFilm({ width = innerWidth, height = innerHeight, designHeight = height, shadows = THREE.PCFSoftShadowMap } = {}) {
  const W = width, H = height;
  const K = H / designHeight, DW = W / K, DH = H / K;

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  if (shadows !== false) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = shadows; }
  renderer.domElement.style.cssText = 'position:absolute;left:0;top:0;z-index:1';
  document.body.appendChild(renderer.domElement);

  const overlay = document.createElement('canvas'); overlay.width = W; overlay.height = H;
  overlay.style.cssText = 'position:absolute;left:0;top:0;z-index:10;pointer-events:none';
  document.body.appendChild(overlay);
  const ctx = overlay.getContext('2d');

  async function run({ dur, fps = 24, shots, post, debug = null, draw = null, texts = null, warm = [] }) {
    const pick = t => { let s = shots[0].shot; for (const c of shots) if (t >= c.at) s = c.shot; return s; };
    window.DUR = dur;
    window.FPS = fps;   // 页面约定（engine/render/page.mjs）：video.mjs 据此核对 --fps，不一致就报错，免得一拍二、一拍三的节奏抖
    window.render = t => {
      t = Math.min(Math.max(t, 0), dur - 1e-6);
      const f = frameOf(t, fps);
      const S = pick(t);
      S.update(t, f);
      const p = S.look(t);
      if (debug) p.debug = debug;
      post.render(S.scene, S.camera, p);
      ctx.clearRect(0, 0, W, H);
      if (draw) draw(ctx, t, S);
    };
    if (texts) window.TEXTS = texts;
    await post.ready;
    for (const t of warm) window.render(t);
    window.render(0);
    window.READY = true;
  }

  return { renderer, overlay, ctx, W, H, K, DW, DH, run };
}
