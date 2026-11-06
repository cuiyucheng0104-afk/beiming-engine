// 北冥引擎 · 后期合成管线：手绘墨线 + 空气透视雾 + bloom + 调色 + Kuwahara 颜料笔触 + 纸纹 + 暗角 + 颗粒。
// 每一道是一个独立模块（ids / ink / fog / bloom / grade / kuwahara / paper / compose / debug），这里按固定顺序串起来：
//   ① 主场景 → MSAA、HalfFloat 线性 HDR，带深度纹理
//   ② ID 图（超采样 ss 倍）→ 边缘检测（深度 + ID，近的一侧拥有这条线）→ 笔画（抖动种子 floor(t*boilFps)）
//   ③ 雾 → bloom → 调色 → OutputPass（色调映射 + sRGB）
//   ④ Kuwahara（sRGB 空间）→ 叠墨线（在 Kuwahara 之后，不被抹糊）→ 纸纹 → 暗角 →（颗粒）→ 屏幕 / 目标
// 所有随时间变化的东西只取决于 p.t，逐帧离线渲染可以任意跳帧。
//
//   createLook(renderer, w, h, opts?) → { render(scene, camera, p), ready, setSize(w, h), dispose(), targets, size }
//     w × h        画布实际像素（renderer.setPixelRatio(1)）
//     opts.ss 2           墨线超采样倍数（ID 图和笔画在 w*ss × h*ss 上算，合成时双线性下采样 → 线自带抗锯齿）；1 更快、线略硬
//     opts.msaa 4         主场景 MSAA 采样数
//     opts.paperUrl null  外部纸纹图；没有或加载失败就用程序化纸纹
//     opts.defaults       每帧参数的默认值，结构同 LOOK_BASE（影片把自己的一套整体传进来）
//     opts.refHeight 1080 像素量（线宽、抖动、笔触半径）的标定高度：内部乘 输出高度 / refHeight，换分辨率画面一致
//     opts.fogColor       雾没写颜色时用的颜色（默认白）
//     opts.fps 24         颗粒换种子的频率
//   await look.ready 之后再出第一帧（外部纸纹图要先载好）。
//
// p（每帧参数；某一项不写 = 用 defaults；写 false / null = 关掉这一项；写对象 = 覆盖默认里的同名字段）：
//   t         全局时间（秒）
//   outline   墨线：{ width, color, wobble, boilFps, warp, pressure, breakup, inner, silhouette, depthThreshold,
//                     near, far, farScale, opacity, tint, darken, fogFade }        各字段见 ink.js、compose.js
//   kuwahara  { radius, strength, q, farRadius, farStart, farEnd, protect }      见 kuwahara.js；protect 见 grade.js
//   bloom     { strength, threshold, radius, knee, tint }                         见 bloom.js
//   grade     { exposure, warmth, lift, gamma, gain, saturation, shoulder }      见 grade.js
//   fog       { color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }   见 fog.js
//   paper     { strength, scale, tex, mid }                                       见 paper.js
//   vignette  0..1（或 { strength }）    grain  0..1（或 { amount }）
//   target    输出到哪个 WebGLRenderTarget（默认 null = 屏幕）
//   debug     'id' | 'depth' | 'edge' | 'line' | 'bloom' | 'paper' | 'kuwahara' | 'scene'   看中间缓冲
// 哪些物体描边、怎么挡线，由物体的 userData 决定，见 ids.js。

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeParam } from './params.js';
import { createFullscreen, renderTarget } from './pass.js';
import { createIdPass } from './ids.js';
import { createInk } from './ink.js';
import { createFogPass } from './fog.js';
import { createBloom } from './bloom.js';
import { createGrade } from './grade.js';
import { createKuwahara } from './kuwahara.js';
import { createPaper } from './paper.js';
import { createCompose } from './compose.js';
import { createDebugView } from './debug.js';

// 中性默认：黑墨、不调色、不加雾、不加颗粒；像素量按 refHeight 标定
export const LOOK_BASE = {
  outline: {
    width: 2.5, color: '#000000', wobble: 1, boilFps: 12, warp: 60, pressure: 0.3, breakup: 0,
    inner: 0.6, silhouette: 0.12, depthThreshold: 0.03, near: 4, far: 80, farScale: 0.6,
    opacity: 1, tint: 0, darken: 0.5, fogFade: 0.9,
  },
  kuwahara: { radius: 4, strength: 1, q: 8, farRadius: 4, farStart: 40, farEnd: 120, protect: [1.05, 1.6] },
  bloom: { strength: 0.5, threshold: 0.8, radius: 0.6, knee: 0.25, tint: '#ffffff' },
  grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 },
  fog: null,
  paper: { strength: 0.1, scale: 1 },
  vignette: 0.2,
  grain: 0,
};

export function createLook(renderer, w, h, opts = {}) {
  const ss = opts.ss ?? 2, msaa = opts.msaa ?? 4, refHeight = opts.refHeight ?? 1080, fps = opts.fps ?? 24;
  const D = opts.defaults ?? LOOK_BASE, fogColor = opts.fogColor;

  const fx = createFullscreen(renderer);
  const ids = createIdPass(renderer), ink = createInk(fx), fog = createFogPass(fx), bloom = createBloom(fx);
  const grade = createGrade(fx), kuwa = createKuwahara(fx), compose = createCompose(fx), debug = createDebugView(fx);
  const paper = createPaper(fx, renderer, { url: opts.paperUrl ?? null, refHeight });
  const out = new OutputPass();

  let W = 0, H = 0, T = {};
  function alloc(nw, nh) {
    for (const k in T) if (k !== 'paper') T[k]?.dispose?.();
    W = nw; H = nh;
    const LW = W * ss, LH = H * ss, NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    paper.resize(W, H); bloom.resize(W, H);
    T = {
      scene: new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: msaa, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) }),
      id: new THREE.WebGLRenderTarget(LW, LH, { type: THREE.HalfFloatType, ...NEAREST, depthTexture: new THREE.DepthTexture(LW, LH, THREE.FloatType) }),
      edge: renderTarget(LW, LH, NEAREST),
      line: renderTarget(LW, LH, { type: THREE.UnsignedByteType }),
      fog: renderTarget(W, H), grade: renderTarget(W, H), out: renderTarget(W, H), kuwa: renderTarget(W, H),
      paper: paper.target,
    };
  }
  alloc(w, h);
  const _cc = new THREE.Color();

  function render(scene, camera, p = {}) {
    const t = p.t ?? 0, k = H / refHeight;
    const OL = mergeParam(p.outline, D.outline), KU = mergeParam(p.kuwahara, D.kuwahara), BL = mergeParam(p.bloom, D.bloom);
    const GR = mergeParam(p.grade, D.grade), FG = mergeParam(p.fog, D.fog), PA = mergeParam(p.paper, D.paper);
    const VG = p.vignette === undefined ? D.vignette : (typeof p.vignette === 'object' && p.vignette ? p.vignette.strength ?? 0 : +p.vignette || 0);
    const GN = p.grain === undefined ? D.grain : (typeof p.grain === 'object' && p.grain ? p.grain.amount ?? 0 : +p.grain || 0);
    const target = p.target ?? null;

    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_cc);
    renderer.autoClear = false;
    try {
      paper.prepare();
      camera.updateMatrixWorld();

      // ① 主场景
      renderer.setRenderTarget(T.scene); renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.setClearColor(_cc, prevAlpha);

      // ② 墨线：ID 图 → 边缘 → 笔画
      let lineOn = false;
      if (OL && OL.opacity > 0 && OL.width > 0) {
        const maxWidth = ids.render(scene, camera, T.id) || 1;
        renderer.setClearColor(_cc, prevAlpha);
        ink.render({ ids: T.id, edge: T.edge, line: T.line, camera, p: OL, fog: FG, fogColor, t, k, ss, maxWidth });
        lineOn = true;
      }

      // ③ 雾 → bloom → 调色 → OutputPass
      let src = T.scene.texture;
      if (FG) { fog.render(src, T.scene.depthTexture, FG, camera, T.fog, fogColor); src = T.fog.texture; }
      const glow = BL && BL.strength > 0 ? bloom.render(src, BL) : null;
      grade.render({ src, bloom: glow, bloomAmount: BL ? BL.strength : 0, bloomTint: BL?.tint, grade: GR, protect: KU && KU.protect }, T.grade);
      out.render(renderer, T.out, T.grade);

      // ④ Kuwahara（sRGB 空间）→ 合成
      let col = T.out.texture;
      if (KU && KU.strength > 0 && KU.radius > 0) {
        kuwa.render({ src: col, depth: T.scene.depthTexture, camera, p: KU, k, w: W, h: H }, T.kuwa); col = T.kuwa.texture;
      }
      const layer = paper.layer(PA);
      if (p.debug) {
        debug.render(p.debug, { id: T.id.texture, depth: T.id.depthTexture, edge: T.edge.texture, line: T.line.texture, bloom: glow, paper: layer.tex, kuwahara: col, scene: T.scene.texture }, camera, target);
      } else {
        compose.render({ src: col, line: lineOn ? T.line.texture : null, ink: OL, paper: layer, vignette: VG, grain: GN, grainSeed: Math.floor(t * fps + 1e-6), w: W, h: H }, target);
      }
    } finally {
      renderer.autoClear = prevAuto; renderer.setClearColor(_cc, prevAlpha); renderer.setRenderTarget(prevRT);
    }
  }

  function dispose() {
    for (const k in T) if (k !== 'paper') T[k]?.dispose?.();
    for (const m of [ink, fog, bloom, grade, kuwa, compose, debug, paper, fx]) m.dispose();
    out.dispose();
  }

  return {
    render, ready: paper.ready, dispose,
    setSize(nw, nh) { if (nw !== W || nh !== H) alloc(nw, nh); },
    get targets() { return T; },
    get size() { return { w: W, h: H, ss }; },
  };
}
