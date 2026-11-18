// 北冥引擎 · 离屏出片 · C 路线（86 式 / Canvas 2D + WebGPU）同源宿主适配（浏览器 Chrome WebGPU 与 Node + Dawn 通用）：
//   registerCanvasFonts(specs, { baseDir, base, glyphs })   支持 C 路线 FONTS 写法（{ family, src } 或 { family, manifest } 分片 woff2 清单，按 glyphs 码位只加载用得到的分片）
//   await createCanvasFilm({ THREE, TSL, renderer, pipeline, width, height, designWidth, designHeight, fit, fonts, fontsDir, glyphs, baseDir, base, paper, refHeight })
//     → { canvas, ctx, W, H, K, DW, DH, design, fit, fonts, work({ dur, fps, draw, texts, post }) }
//     Node 端自动垫好只建 Skia 画布的 globalThis.document（使 engine/paint/canvas.js 的 canvasFor 直接可用），浏览器端用原生 <canvas> 与 FontFace；
//     post 为空时将 2D 画布 sRGB 像素零失真交由 WebGPU 宿主输出，给 post(t, f) 时在 GPU 上叠纸纹、暗角与颗粒。
import { designFit, normalizeTexts } from '../stage/film.js';
import { setFilmFps, frameOf, REF_FPS } from '../core/clock.js';
import { grainCellOf, grainSeedOf } from '../look/index.js';
import { loadCanvasIso, loadFilmFontsIso, registerCanvasFontsIso } from './io.mjs';
import { createPaper } from './tsl/paper.js';
import { createCompose } from './tsl/compose.js';

export async function registerCanvasFonts(specs = [], opts = {}) {
  return registerCanvasFontsIso(specs, opts);
}

export async function createCanvasFilm({
  THREE, TSL, renderer, pipeline, width: W, height: H,
  designWidth, designHeight, fit,
  fonts = null, fontsDir = null, glyphs = null, baseDir = undefined, base = undefined,
  paper: paperImage = null, refHeight = 1080,
} = {}) {
  const { createCanvas } = await loadCanvasIso();
  const subsetFonts = fontsDir ? await loadFilmFontsIso(fontsDir, base ?? baseDir) : null;
  if (fonts?.length) await registerCanvasFontsIso(fonts, { baseDir, base, glyphs });

  renderer.toneMapping = THREE.NoToneMapping;
  const F = designFit({ width: W, height: H, designWidth, designHeight, fit });
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  canvas.__bmOverlay = true;

  const canvasTex = new THREE.DataTexture(null, W, H, THREE.RGBAFormat);
  Object.defineProperty(canvasTex.image, 'data', {
    get: () => {
      const d = ctx.getImageData(0, 0, W, H).data;
      return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    },
    configurable: true,
  });
  canvasTex.colorSpace = THREE.NoColorSpace;
  canvasTex.minFilter = canvasTex.magFilter = THREE.NearestFilter;
  canvasTex.generateMipmaps = false;
  canvasTex.needsUpdate = true;

  function work({ dur, fps, draw, texts = null, post: postFn = null, events = null, timeline = null }) {
    if (typeof draw !== 'function') throw new TypeError('createCanvasFilm.work：需要 draw(ctx, t, f) 函数');
    const rate = setFilmFps(fps ?? REF_FPS);
    const { texture, ivec2, vec4, screenCoordinate, sRGBTransferEOTF } = TSL;

    let paper = null, compose = null, pipeNode;
    if (postFn) {
      paper = createPaper({ THREE, TSL, renderer }, { refHeight, image: paperImage });
      paper.resize(W, H);
      compose = createCompose({ THREE, TSL }, { width: W, height: H, mid: paper.procMid });
      pipeNode = vec4(sRGBTransferEOTF(compose.node.rgb), 1);
    } else {
      const px = texture(canvasTex).load(ivec2(screenCoordinate.xy));
      pipeNode = vec4(sRGBTransferEOTF(px.rgb), 1);
    }
    const pass = pipeline(pipeNode);
    const k = H / refHeight, kp = Math.max(1, Math.round(k));

    return {
      dur,
      ...(events ? { events } : {}),
      ...(timeline ? { timeline } : {}),
      render(f) {
        const t = Math.min(f / rate, dur - 1e-6);
        const fn = frameOf(t, rate);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
        draw(ctx, t, fn);
        canvasTex.needsUpdate = true;
        if (postFn) {
          paper.prepare();
          const p = postFn(t, fn) || {};
          const pPaper = p.paper === false ? { strength: 0 } : (typeof p.paper === 'number' ? { strength: p.paper } : (p.paper || { strength: 0 }));
          const grainObj = typeof p.grain === 'object' && p.grain ? p.grain : { amount: typeof p.grain === 'number' ? p.grain : 0, size: 1, holdFrames: 1 };
          const layer = paper.layer(pPaper, kp, k);
          compose.update({
            src: canvasTex, line: null, ink: null, paper: layer,
            vignette: p.vignette ?? 0,
            grain: grainObj.amount ?? 0,
            grainSeed: grainSeedOf(p.t ?? t, rate, grainObj.holdFrames ?? 1),
            grainCell: grainCellOf(grainObj.size ?? 1, k, kp),
          });
        }
        pass.render();
      },
      texts: f => (texts ? normalizeTexts(texts(Math.min(f / rate, dur - 1e-6))) : []),
      dispose() {
        paper?.dispose();
        compose?.dispose();
        canvasTex.dispose();
      },
    };
  }

  return { canvas, ctx, W, H, K: F.K, DW: F.DW, DH: F.DH, design: F.design, fit: F.fit, fonts: subsetFonts, work };
}
