// 北冥引擎 · 离屏出片 · 影片外壳：engine/stage/film.js 的对应。渲染器设置、设计尺寸缩放、按帧切镜头、最上层的 2D 显示层。
// 选镜头与局部帧号、设计画幅、文字框规范化直接用 engine/stage/film.js 的纯函数（shotTable / designFit / normalizeTexts），帧率写进
// engine/core/clock.js 的 setFilmFps——镜头代码里的 frameOf / hold / heldTime 与页面上逐位同义。
//
//   await createFilm({ THREE, TSL, renderer, pipeline, width, height, designWidth, designHeight, fit, shadows })   前五项就是宿主给 build 的同名参数 → { renderer, overlay, ctx, W, H, K, DW, DH, design, fit, work }
//     width × height 是宿主的画幅；shadows 阴影贴图类型（默认 PCFShadowMap，false = 不开）。r187 已删掉 PCFSoftShadowMap（A 路线外壳用的那种），
//     主光的滤波由 tsl/toon.js 的 useR170Shadow 换成与 r170 PCFSoft 同式，类型只决定深度纹理的过滤方式，见那里的说明
//     overlay / ctx   显示层画布（@napi-rs/canvas，Skia）与它的 2D 上下文；坐标同 A 路线（实际像素，左上原点）
//   film.work({ dur, fps, shots, look, draw, texts }) → 作品模块的返回值 { render(f), texts(f), dispose() }
//     shots   同 film.run：[{ in, out?, shot, id? }]（film.json v2 原样）或 [{ at, shot }]；镜头 = { scene, camera, update(t, f, ctx), look(t, ctx) }
//     look    tsl/look.js 的 createLook 实例；每帧 look.render(scene, camera, 镜头的后期参数)
//     draw(ctx, t, shot, sctx)   每帧在清空的显示层上画；显示层按 sRGB 数值「盖」在后期结果上（同浏览器合成两块画布），不过后期
//     texts(t)  该时刻的文字（页面约定的 TEXTS），work.texts(f) 交出规范化之后的条目
// 页面约定里给渲染器的 window.DUR / READY / 预热，这里没有：帧数由宿主的 --frames 决定，着色器在第一帧编译。
import { shotTable, designFit, normalizeTexts } from '../stage/film.js';
import { setFilmFps, frameOf, REF_FPS } from '../core/clock.js';
import { mergeParams } from '../style/index.js';
import { loadCanvas } from './canvas.mjs';

export async function createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H, designWidth, designHeight, fit, shadows = THREE.PCFShadowMap } = {}) {
  const { createCanvas } = await loadCanvas();
  const { texture, ivec2, vec4, mix, screenCoordinate, sRGBTransferEOTF } = TSL;
  renderer.toneMapping = THREE.NoToneMapping;   // 保色板（同 A 路线外壳）；宿主的目标已是 sRGB
  renderer.shadowMap.enabled = shadows !== false;
  if (shadows !== false) renderer.shadowMap.type = shadows;
  const F = designFit({ width: W, height: H, designWidth, designHeight, fit });

  const overlay = createCanvas(W, H), ctx = overlay.getContext('2d');
  overlay.__bmOverlay = true;
  // 显示层贴图：上传时才读画布；行序自上而下，按屏幕坐标逐像素取（不翻 y、不插值）；数值就是 sRGB，不做色彩空间换算
  const ovTex = new THREE.DataTexture(null, W, H, THREE.RGBAFormat);
  Object.defineProperty(ovTex.image, 'data', { get: () => new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer), configurable: true });
  ovTex.colorSpace = THREE.NoColorSpace; ovTex.minFilter = ovTex.magFilter = THREE.NearestFilter; ovTex.generateMipmaps = false; ovTex.needsUpdate = true;

  function work({ dur, fps, shots, look, draw = null, texts = null }) {
    const rate = setFilmFps(fps ?? REF_FPS);
    const table = shotTable(shots, { fps: rate, dur });
    const ov = texture(ovTex).load(ivec2(screenCoordinate.xy));
    const pipe = draw ? vec4(sRGBTransferEOTF(mix(look.node.rgb, ov.rgb, ov.a)), 1) : look.output;
    const post = pipeline(pipe);
    return {
      dur,
      render(f) {
        const t = Math.min(f / rate, dur - 1e-6);
        const { entry, ctx: sctx } = table.at(t, frameOf(t, rate));
        const S = entry.shot;
        S.update(t, frameOf(t, rate), sctx);
        const rawLook = S.look(t, sctx);
        look.render(S.scene, S.camera, globalThis.__LOOKDEV ? mergeParams(rawLook, globalThis.__LOOKDEV) : rawLook);
        if (draw) {
          ctx.clearRect(0, 0, W, H);
          if (globalThis.__BMQA_OFFSCREEN?.hide !== 'layer') draw(ctx, t, S, sctx);
          ovTex.needsUpdate = true;
        }
        post.render();
      },
      texts: f => (texts ? normalizeTexts(texts(Math.min(f / rate, dur - 1e-6))) : []),
      dispose() { look.dispose(); ovTex.dispose(); },
    };
  }

  return { renderer, overlay, ctx, W, H, K: F.K, DW: F.DW, DH: F.DH, design: F.design, fit: F.fit, work };
}
