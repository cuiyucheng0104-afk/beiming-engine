// src/look.js —《北冥》的后期配方：引擎后期管线（engine/look）+ 本片的默认参数（墨色、调色、笔触、纸纹）。
// 管线本身（墨线、雾、bloom、调色、Kuwahara、纸纹、暗角、颗粒）和物体上的 userData 开关见 engine/look/index.js、ids.js。
//
// 用法：
//   import { createLook, LOOK_DEFAULTS } from './look.js';
//   const look = createLook(renderer, W, H, { ss: 2 });   // W×H = 画布实际像素（setPixelRatio(1)）
//   await look.ready;                          // 纸纹（assets/plates/paper.png 有就用，否则程序化）准备好，再设 window.READY
//   look.render(scene, camera, { t, outline: {...}, kuwahara: {...}, bloom: {...}, grade: {...}, fog: {...}, paper: {...}, vignette: .2 });
//   // 眼镜显示层（HUD）在这之后直接画到屏幕：renderer.autoClear = false; renderer.render(hudScene, hudCam); renderer.autoClear = true;
//
// createLook(renderer, w, h, opts)  opts 同 engine/look 的 createLook，本片固定：
//   paperUrl   默认 './assets/plates/paper.png'；null = 不尝试，用程序化纸纹
//   defaults   LOOK_DEFAULTS（像素量按 1080 高度标定）；雾没写颜色时用本片的雾紫
// p（每帧参数）：不写 = 用 LOOK_DEFAULTS；false / null = 关；对象 = 覆盖同名字段。t 用 帧号/24 的精确值。

import { createLook as createEngineLook } from '../engine/look/index.js';

const PAPER_URL = './assets/plates/paper.png';
const FOG_COLOR = '#9C8FD8';   // 雾的默认色：和天空同一支紫

// ───────────────────────────── 默认参数（像素量都按 1080 高度标定，内部按 h/1080 缩放） ─────────────────────────────
export const LOOK_DEFAULTS = {
  outline: {
    width: 2.6,          // 外轮廓线宽（像素，1080p）；外轮廓约 3px、内部线约 1.5px 的手绘比例
    color: '#2A2D52',    // 墨色：深蓝灰，不用纯黑
    wobble: 1.2,         // 抖动幅度（像素）：检测坐标的低频域扭曲
    boilFps: 12,         // 沸腾频率：种子 floor(t*12)，即一拍二
    warp: 70,            // 抖动的波长（像素）
    pressure: 0.35,      // 笔压：线宽沿线 ±35% 起伏
    breakup: 0.1,        // 断线：0 = 不断；0.1 偶尔断开，0.25 明显成段
    inner: 0.55,         // 内部线（两个部件相接、深度相近）相对外轮廓的粗细
    silhouette: 0.12,    // 两侧深度相对差大于它算外轮廓
    depthThreshold: 0.03,// 同一物体内部的深度折痕阈值（1/z 的二阶差分，相对值）
    near: 4, far: 80,    // 线宽随深度变化的区间（世界单位）
    farScale: 0.55,      // 远处线宽系数
    opacity: 1,
    tint: 0.15,          // 墨色吸收一点底色，不那么「贴」
    darken: 0.5,         // 底色比墨还暗时，线取「底色 × 0.5」，暗部的线也看得见
    fogFade: 0.9,        // 雾里的线跟着变淡的程度
  },
  kuwahara: { radius: 5, strength: 1, q: 8, farRadius: 5, farStart: 40, farEnd: 120, protect: [1.05, 1.6] },   // farRadius：远处 / 底板的笔触半径；protect：HDR 亮度在此区间的自发光点不被抹（null 关）
  bloom: { strength: 0.55, threshold: 0.72, radius: 0.65, knee: 0.25, tint: '#ffffff' },
  grade: { exposure: 1, warmth: 0.12, lift: [0.035, 0.022, 0.06], gamma: 1, gain: 1, saturation: 1.04, shoulder: 0.9 },
  fog: null,             // 默认关。{ color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }
  paper: { strength: 0.12, scale: 1 },
  vignette: 0.22,
  grain: 0,              // 页面内颗粒默认关（交给 ffmpeg mux）；要让 HUD 不带颗粒时可以在这里开、mux 关
};

export function createLook(renderer, w, h, opts = {}) {
  return createEngineLook(renderer, w, h, {
    ...opts,
    paperUrl: opts.paperUrl === undefined ? PAPER_URL : opts.paperUrl,
    defaults: LOOK_DEFAULTS, refHeight: 1080, fogColor: FOG_COLOR,
  });
}
