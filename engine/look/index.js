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
//     opts.paperUrl null  外部纸纹图；没给就用程序化纸纹。给了却加载失败，look.ready 直接 reject（错误里带地址），不再悄悄换纸
//     opts.defaults       每帧参数的默认值，结构同 LOOK_BASE（影片把自己的一套传进来）；和 LOOK_BASE 逐项合并，
//                         只写了部分字段的项，其余字段仍取 LOOK_BASE 的（墨色、深度阈值等不会变成 undefined）
//     opts.refHeight 1080 像素量（线宽、抖动、笔触半径）的标定高度：内部乘 输出高度 / refHeight，换分辨率画面一致；
//                         bloom 的 mip 链按 log2(输出高度 / refHeight) 多降几级，图片纸纹与颗粒按整数倍 round(输出高度 / refHeight) 放大
//                         （原生 4K 对 1080 标定：bloom 多降 1 级、纸纹平铺与颗粒格子 2 倍；1080 附近都不变）
//     opts.fogColor       雾没写颜色时用的颜色（默认白）
//     opts.fps            颗粒换种子的频率；不写时取影片帧率（engine/core/clock.js 的 filmFps()，默认 24，film.run 按渲染帧率设好）
//   await look.ready 之后再出第一帧（外部纸纹图要先载好）。
//
// p（每帧参数；某一项不写 = 用 defaults；写 false / null = 关掉这一项；写对象 = 覆盖默认里的同名字段；
//    写数字 = 只改它的量：outline → opacity，kuwahara / bloom / paper → strength，fog → density；grade 没有单一的量，写数字报错）：
//   t         全局时间（秒）
//   outline   墨线：{ width, color, wobble, boilFps, boilHold, warp, pressure, breakup, inner, silhouette, depthThreshold,
//                     near, far, farScale, opacity, tint, darken, fogFade }        各字段见 ink.js、compose.js
//             boilHold 可选：墨线每 boilHold 个输出帧沸腾一次（按影片帧率，换帧率也是一拍 n）；不写按 boilFps（每秒几次）
//   kuwahara  { radius, strength, q, farRadius, farStart, farEnd, protect }      见 kuwahara.js；protect 见 grade.js
//   bloom     { strength, threshold, radius, knee, tint }                         见 bloom.js
//   grade     { exposure, warmth, lift, gamma, gain, saturation, shoulder }      见 grade.js
//   fog       { color, colorHigh, density, start, max, baseHeight, falloff, cutoff, sky }   见 fog.js
//   paper     { strength, scale, tex, mid, scaleMode, anchor }                    见 paper.js（scaleMode、anchor 默认关）
//             混合是乘法：颜色 × (1 + 2 · strength · (纸纹 − 中性亮度))，正片取 0.12–0.14（不是 soft-light）
//             scaleMode 'refHeight'：图片纸纹相对画高一样大，并按面积取样——原生 4K 缩回 1080 与 1080 直出相同（engine/look/gpu.test R63）
//   vignette  0..1（或 { strength }）
//   grain     0..1（或 { amount, size, holdFrames }）：amount 强度；
//             size 颗粒格子边长（refHeight 像素，按 输出高度 / refHeight 连续放大后取整）；不写 = 整数倍 round(输出高度 / refHeight)，与以前相同
//               格子是整像素：size × 输出高度 / refHeight 是整数时，缩回 1080 与 1080 直出逐像素相同；不是整数时取整，颗粒相对画面变粗或变细。
//               要 1080 / 1440 / 2160 三档都等比，size 取 3 的倍数（3 → 3 / 4 / 6 像素）；size 1 只在 1080、2160 等比（1440 上是 1 像素，
//               缩回 1080 后颗粒高频弱四成）。默认的 1 像素颗粒在非整数倍画幅上做不到等比，这是整像素格子的物理限制
//             holdFrames 每几帧换一次颗粒（1 = 每帧换，默认；2 = 一拍二，压码率）
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
import { filmFps } from '../core/clock.js';

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

// 某一项写成数字时代表的字段（vignette / grain 本身就是数）；grade 不在表里：写数字报错
const SCALAR = { outline: 'opacity', kuwahara: 'strength', bloom: 'strength', fog: 'density', paper: 'strength' };
const ITEMS = ['outline', 'kuwahara', 'bloom', 'grade', 'fog', 'paper'];
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function scalarItem(key, v, where) {
  if (typeof v !== 'number') return v;
  if (!SCALAR[key]) throw new TypeError(`look：${where}.${key} 不能写成数字（${v}），请写对象，例如 { exposure: ${v} }`);
  return { [SCALAR[key]]: v };
}
const amountOf = (v, field) => isObj(v) ? v[field] ?? 0 : +v || 0;

// opts.defaults 与 LOOK_BASE 逐项合并：对象项按字段覆盖，false / null 照样表示默认关
export function lookDefaults(d) {
  if (!d) return LOOK_BASE;
  const o = { ...LOOK_BASE };
  for (const k of Object.keys(d)) {
    if (d[k] === undefined) continue;
    const v = ITEMS.includes(k) ? scalarItem(k, d[k], 'defaults') : d[k];
    o[k] = ITEMS.includes(k) && isObj(v) && isObj(LOOK_BASE[k]) ? { ...LOOK_BASE[k], ...v } : v;
  }
  o.vignette = amountOf(o.vignette, 'strength');
  Object.assign(o, grainOpts(o.grain, {})); o.grain = amountOf(o.grain, 'amount');
  return o;
}

// 颗粒的 size / holdFrames（grain 写成对象时才有）；没写的字段取 D 里的
function grainOpts(v, D) {
  const g = isObj(v) ? v : {};
  const size = g.size !== undefined ? g.size : D.grainSize ?? null, hold = g.holdFrames !== undefined ? g.holdFrames : D.grainHold ?? null;
  if (size !== null && !(typeof size === 'number' && size > 0)) throw new TypeError(`look：grain.size 要是正数（refHeight 像素），收到 ${JSON.stringify(size)}`);
  if (hold !== null && !(Number.isInteger(hold) && hold >= 1)) throw new TypeError(`look：grain.holdFrames 要是 ≥ 1 的整数，收到 ${JSON.stringify(hold)}`);
  return { grainSize: size, grainHold: hold };
}

// 每帧参数 p 和（合并过的）默认值 D → 各项的最终参数；null = 这一项关
export function lookParams(p, D = LOOK_BASE) {
  const r = {};
  for (const k of ITEMS) r[k] = mergeParam(scalarItem(k, p[k], 'p'), D[k]);
  r.vignette = p.vignette === undefined ? D.vignette : amountOf(p.vignette, 'strength');
  r.grain = p.grain === undefined ? D.grain : amountOf(p.grain, 'amount');
  Object.assign(r, grainOpts(p.grain, D));
  return r;
}

// 颗粒格子边长与种子：size / holdFrames 没写时与以前逐位相同（格子 = kp，种子 = 帧计数）
export function grainCellOf(size, k, kp) { return size === null || size === undefined ? kp : Math.max(1, Math.round(size * k)); }
export function grainSeedOf(t, fps, hold) { const n = Math.floor(t * fps + 1e-6); return hold > 1 ? Math.floor(n / hold) : n; }

export function createLook(renderer, w, h, opts = {}) {
  const ss = opts.ss ?? 2, msaa = opts.msaa ?? 4, refHeight = opts.refHeight ?? 1080, fps = opts.fps ?? null;
  const D = lookDefaults(opts.defaults), fogColor = opts.fogColor;

  const fx = createFullscreen(renderer);
  const ids = createIdPass(renderer), ink = createInk(fx), fog = createFogPass(fx), bloom = createBloom(fx, { refHeight });
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
    const t = p.t ?? 0, k = H / refHeight, kp = Math.max(1, Math.round(k));   // kp：图片纸纹 / 颗粒的整数像素倍率
    const { outline: OL, kuwahara: KU, bloom: BL, grade: GR, fog: FG, paper: PA, vignette: VG, grain: GN, grainSize, grainHold } = lookParams(p, D);
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
        ink.render({ ids: T.id, edge: T.edge, line: T.line, camera, p: OL, fog: FG, fogColor, t, k, ss, maxWidth, fps: fps ?? filmFps() });
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
      const layer = paper.layer(PA, kp, k);
      if (p.debug) {
        debug.render(p.debug, { id: T.id.texture, depth: T.id.depthTexture, edge: T.edge.texture, line: T.line.texture, bloom: glow, paper: layer.tex, kuwahara: col, scene: T.scene.texture }, camera, target);
      } else {
        compose.render({ src: col, line: lineOn ? T.line.texture : null, ink: OL, paper: layer, vignette: VG, grain: GN,
          grainSeed: grainSeedOf(t, fps ?? filmFps(), grainHold), grainCell: grainCellOf(grainSize, k, kp), w: W, h: H }, target);
      }
    } finally {
      renderer.autoClear = prevAuto; renderer.setClearColor(_cc, prevAlpha); renderer.setRenderTarget(prevRT);
    }
  }

  function dispose() {
    for (const k in T) if (k !== 'paper') T[k]?.dispose?.();
    for (const m of [ids, ink, fog, bloom, grade, kuwa, compose, debug, paper, fx]) m.dispose();
    out.material.dispose();   // 不调 out.dispose()：它经 FullScreenQuad.dispose 删掉 three 全局共享的全屏几何体（见 pass.js）
  }

  return {
    render, ready: paper.ready, dispose,
    setSize(nw, nh) { if (nw !== W || nh !== H) alloc(nw, nh); },
    get targets() { return T; },
    get size() { return { w: W, h: H, ss }; },
  };
}
