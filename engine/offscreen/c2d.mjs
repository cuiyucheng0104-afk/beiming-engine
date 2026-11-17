// 北冥引擎 · 离屏出片 · C 路线（86 式 / Canvas 2D + WebGPU）宿主适配：
//   registerCanvasFonts(specs, { baseDir, glyphs })   支持 C 路线 FONTS 写法（{ family, src } 或 { family, manifest } 分片 woff2 清单，按 glyphs 码位只注册用得到的分片）
//   await createCanvasFilm({ THREE, TSL, renderer, pipeline, width, height, designWidth, designHeight, fit, fonts, fontsDir, glyphs, baseDir, paper, refHeight })
//     → { canvas, ctx, W, H, K, DW, DH, design, fit, fonts, work({ dur, fps, draw, texts, post }) }
//     自动垫好只建 Skia 画布的 globalThis.document（使 engine/paint/canvas.js 的 canvasFor 直接可用）；
//     post 为空时将 2D 画布 sRGB 像素零失真交由 WebGPU 宿主输出，给 post(t, f) 时在 Dawn GPU 上叠纸纹、暗角与颗粒。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { designFit, normalizeTexts } from '../stage/film.js';
import { setFilmFps, frameOf, REF_FPS } from '../core/clock.js';
import { grainCellOf, grainSeedOf } from '../look/index.js';
import { loadCanvas, loadFilmFonts } from './canvas.mjs';
import { createPaper } from './tsl/paper.js';
import { createCompose } from './tsl/compose.js';

function rangeCoversAny(unicodeRange, codepoints) {
  if (!codepoints) return true;
  for (const part of String(unicodeRange || '').split(',')) {
    const m = /U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
    if (!m) continue;
    const lo = parseInt(m[1], 16), hi = m[2] ? parseInt(m[2], 16) : lo;
    for (const cp of codepoints) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export async function registerCanvasFonts(specs = [], { baseDir = process.cwd(), glyphs = null } = {}) {
  const { GlobalFonts } = await loadCanvas();
  const cps = glyphs !== null && glyphs !== undefined ? [...new Set([...String(glyphs)].map(ch => ch.codePointAt(0)))] : null;
  let chunksLoaded = 0, filesLoaded = 0;
  for (const s of specs) {
    if (!s?.family) throw new Error('registerCanvasFonts：每项字体必须给 family');
    if (s.manifest) {
      const mPath = resolve(baseDir, s.manifest);
      let m;
      try { m = JSON.parse(readFileSync(mPath, 'utf8')); }
      catch (e) { throw new Error(`字体清单载不到：${s.manifest}（${e.message}）`, { cause: e }); }
      const mDir = dirname(mPath);
      for (const c of m.chunks || []) {
        if (!rangeCoversAny(c.unicodeRange, cps)) continue;
        const fPath = resolve(mDir, c.file);
        let ok;
        try { ok = !!GlobalFonts.registerFromPath(fPath, s.family); } catch { ok = false; }
        if (!ok) throw new Error(`字体分片注册失败：${fPath}（family=${s.family}）`);
        chunksLoaded++;
      }
    } else if (s.src) {
      const fPath = resolve(baseDir, s.src);
      let ok;
      try { ok = !!GlobalFonts.registerFromPath(fPath, s.family); } catch { ok = false; }
      if (!ok) throw new Error(`字体文件注册失败：${fPath}（family=${s.family}）`);
      filesLoaded++;
    } else {
      throw new Error(`字体 ${s.family} 要写 src（一个字体文件）或 manifest（分片清单）`);
    }
  }
  return { chunksLoaded, filesLoaded };
}

export async function createCanvasFilm({
  THREE, TSL, renderer, pipeline, width: W, height: H,
  designWidth, designHeight, fit,
  fonts = null, fontsDir = null, glyphs = null, baseDir = process.cwd(),
  paper: paperImage = null, refHeight = 1080,
} = {}) {
  const { createCanvas } = await loadCanvas();
  globalThis.document ??= {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`离屏没有 DOM：只能建画布，收到 <${tag}>`);
      return createCanvas(1, 1);
    },
  };
  const subsetFonts = fontsDir ? await loadFilmFonts(fontsDir) : null;
  if (fonts?.length) await registerCanvasFonts(fonts, { baseDir, glyphs });

  renderer.toneMapping = THREE.NoToneMapping;
  const F = designFit({ width: W, height: H, designWidth, designHeight, fit });
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');

  const canvasTex = new THREE.DataTexture(null, W, H, THREE.RGBAFormat);
  Object.defineProperty(canvasTex.image, 'data', {
    get: () => new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer),
    configurable: true,
  });
  canvasTex.colorSpace = THREE.NoColorSpace;
  canvasTex.minFilter = canvasTex.magFilter = THREE.NearestFilter;
  canvasTex.generateMipmaps = false;
  canvasTex.needsUpdate = true;

  function work({ dur, fps, draw, texts = null, post: postFn = null }) {
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
