// A/C 渲染期逐帧记录文字、字体和投影；对比度按分块取每条文字的首次峰值，再按全片帧序归并。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE, THREE_MODULE, threeShim, fontInventory } from './page-probe.mjs';
import { loadFaceBytes, measureContrast, sampleTextItems } from './text-samples.mjs';
import { analyzePlate, plateEdgeOptions } from './plate-edges.mjs';
import { decodePng } from './png.mjs';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

// 写入独立画布（不写回作品）。复用原画布的 draw 调用和状态，但 fillText/strokeText 不进副本，
// 因而图文交错、save/clip、画完文字后再盖图、把画布 drawImage 到另一层都能取到真实的无字背景。
function installBackgrounds() {
  const qa = window.__BMQA, mirrors = new WeakMap(), byCanvas = new WeakMap(), privateCanvases = new WeakSet();
  const mirror = ctx => {
    if (privateCanvases.has(ctx.canvas)) return null;
    let m = mirrors.get(ctx);
    if (!m) {
      const c = document.createElement('canvas');
      privateCanvases.add(c);
      c.width = ctx.canvas.width; c.height = ctx.canvas.height;
      m = { c, ctx: c.getContext('2d', ctx.getContextAttributes()), text: false };
      mirrors.set(ctx, m); byCanvas.set(ctx.canvas, m);
    }
    if (m.c.width !== ctx.canvas.width) m.c.width = ctx.canvas.width;
    if (m.c.height !== ctx.canvas.height) m.c.height = ctx.canvas.height;
    return m;
  };
  for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean)) {
    for (const k of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, k);
      Object.defineProperty(C.prototype, k, { ...d, set(v) {
        d.set.call(this, v);
        const m = byCanvas.get(this); if (m) m.c[k] = this[k];
      } });
    }
  }
  const patterns = new WeakMap();
  for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].filter(Boolean)) {
    for (const k of Object.getOwnPropertyNames(C.prototype)) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, k);
      if (d.set) {
        Object.defineProperty(C.prototype, k, { ...d, set(v) {
          d.set.call(this, v);
          try { const m = mirror(this); if (m) m.ctx[k] = patterns.get(v) || this[k]; } catch { qa.backgroundError = true; }
        } });
      } else if (typeof d.value === 'function' && !/^(constructor$|get|is|measure|create(?!Pattern))/.test(k)) {
        Object.defineProperty(C.prototype, k, { ...d, value: function (...args) {
          const result = d.value.apply(this, args);
          try {
            const m = mirror(this);
            if (m) {
              if (k === 'fillText' || k === 'strokeText') m.text = true;
              else {
                if (k === 'drawImage' || k === 'createPattern') {
                  const src = byCanvas.get(args[0]);
                  if (src?.text) { args[0] = src.c; m.text = true; }
                }
                const copy = m.ctx[k](...args);
                if (k === 'createPattern' && result && copy) patterns.set(result, copy);
              }
            }
          } catch { qa.backgroundError = true; }
          return result;
        } });
      }
    }
  }
  const patternTransform = CanvasPattern.prototype.setTransform;
  CanvasPattern.prototype.setTransform = function (...args) {
    const ret = patternTransform.apply(this, args);
    try { const p = patterns.get(this); if (p) patternTransform.apply(p, args); } catch { qa.backgroundError = true; }
    return ret;
  };
  // DevTools 的 inspector stylesheet 不改作品 DOM、inline style、画布内容或画布状态；清空即可还原。
  qa.backgroundCSS = bounds => {
    const cvs = [...document.querySelectorAll('canvas')];
    const gl = cvs.filter(c => c.__bmType === 'webgl');
    const selector = el => {
      let s = '';
      while (el.parentElement) {
        s = `>:nth-child(${[...el.parentElement.children].indexOf(el) + 1})` + s;
        el = el.parentElement;
      }
      return ':root' + s;
    };
    const hideDom = '*{-webkit-text-fill-color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important}svg text,svg tspan{fill:transparent!important;stroke:transparent!important}';
    let text = hideDom, layer = hideDom;
    for (const c of cvs) {
      const m = byCanvas.get(c), cs = getComputedStyle(c), sel = selector(c);
      const overlay = c.__bmType === '2d' && gl.some(g => (+getComputedStyle(g).zIndex || 0) < (+cs.zIndex || 0));
      if (overlay) layer += `${sel}{visibility:hidden!important}`;
      if (!m?.text) continue;
      const rect = c.getBoundingClientRect();
      // 移开原画布的替换内容，作品原有的 CSS 背景仍在。
      if (cs.objectFit !== 'fill' || cs.objectPosition !== '50% 50%') { qa.backgroundError = true; continue; }
      let image = m.c, size = '100% 100%', pos = '0 0';
      // 一比一的未变换画布可精确裁切镜像；不能按屏幕轴换算的画布保留原 CSS 合成。
      let aligned = Number.isInteger(rect.left) && Number.isInteger(rect.top) && rect.width === c.width && rect.height === c.height &&
        c.clientWidth === c.width && c.clientHeight === c.height && ['paddingLeft','paddingRight','paddingTop','paddingBottom'].every(k => cs[k] === '0px');
      for (let el = c; aligned && el; el = el.parentElement) {
        const st = getComputedStyle(el);
        aligned = [st.transform, st.scale, st.rotate, st.translate, st.perspective, st.filter, st.offsetPath].every(v => v === 'none') && st.zoom === '1';
      }
      if (aligned) {
        if (!bounds.some(b => b.x < rect.right && b.y < rect.bottom && b.x + b.width > rect.left && b.y + b.height > rect.top)) continue;
        const tile = m.tile ??= document.createElement('canvas'); privateCanvases.add(tile);
        const x = Math.max(0, Math.min(...bounds.map(b => b.x)) - rect.left), y = Math.max(0, Math.min(...bounds.map(b => b.y)) - rect.top);
        tile.width = Math.min(c.width, Math.max(...bounds.map(b => b.x + b.width)) - rect.left) - x;
        tile.height = Math.min(c.height, Math.max(...bounds.map(b => b.y + b.height)) - rect.top) - y;
        tile.getContext('2d', m.ctx.getContextAttributes()).drawImage(m.c, x, y, tile.width, tile.height, 0, 0, tile.width, tile.height);
        image = tile; size = `${tile.width}px ${tile.height}px`; pos = `${x}px ${y}px`;
      }
      const css = `${sel}{object-position:-100000px -100000px!important;background-image:url(${image.toDataURL()}),${cs.backgroundImage}!important;background-size:${size},${cs.backgroundSize}!important;background-position:${pos},${cs.backgroundPosition}!important;background-repeat:no-repeat,${cs.backgroundRepeat}!important;background-origin:content-box,${cs.backgroundOrigin}!important;background-clip:content-box,${cs.backgroundClip}!important}`;
      text += css;
      if (!overlay) layer += css;
    }
    return { text, layer, error: !!qa.backgroundError, scrollX, scrollY };
  };
}

export async function installPageQa(page, origin) {
  await page.addInitScript({ content: `(${PROBE})(null);(${installBackgrounds})();` });
  await page.route(url => url.origin === origin && THREE_MODULE.test(url.pathname) && !url.searchParams.has('bmqa'), route =>
    route.fulfill({ contentType: 'text/javascript', body: threeShim(new URL(route.request().url()).pathname.split('/').at(-1)) }));
}

export async function beginPageQaFrame(film) {
  await film.page.evaluate(() => {
    const q = window.__BMQA;
    q.runs = []; q.plates = []; q.platesSeen.clear(); q.rec = q.platesRec = true;
  });
}

const sheets = new WeakMap();
async function inspectorSheet(page) {
  if (!sheets.has(page)) {
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const { frameTree } = await session.send('Page.getFrameTree');
    const { styleSheetId } = await session.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
    sheets.set(page, { setCSS: text => session.send('CSS.setStyleSheetText', { styleSheetId, text }),
      async capture(clip) {
        const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, optimizeForSpeed: true, captureBeyondViewport: false, clip });
        return Buffer.from(data, 'base64');
      } });
  }
  return sheets.get(page);
}

// 同一 id 换了字是另一条轨；同帧重报同一条时取最后一条，与 QA 的逐帧表一致。
function updatePeaks(peaks, row, derived, width, height) {
  const items = new Map();
  for (const it of sampleTextItems(row, derived, width, height)) if (!it.bad) items.set(JSON.stringify([it.id, it.text]), it);
  const changed = [];
  for (const [key, it] of items) {
    const alpha = it.alpha ?? 1;
    if (alpha <= (peaks.get(key)?.alpha ?? 0.02)) continue;
    const peak = { row, it, alpha };
    peaks.set(key, peak); changed.push(peak);
  }
  return changed;
}

// 只保存 WCAG 取样实际会读的区域（含字框外的背景），不为一个小标题截全画幅。
async function snapshotPeaks(film, peaks, onPng) {
  const { width, height } = film.page.viewportSize();
  const input = onPng && decodePng(onPng);
  const regions = [];
  for (const peak of peaks) {
    const b = peak.it.box;
    const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1]));
    const x1 = Math.min(width, Math.ceil(b[2])), y1 = Math.min(height, Math.ceil(b[3]));
    if (x1 - x0 < 2 || y1 - y0 < 2) { peak.outside = true; continue; }
    const pad = Math.max(4, Math.round(0.3 * (y1 - y0)));
    const x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad);
    const w = Math.min(width, x1 + pad) - x, h = Math.min(height, y1 + pad) - y;
    const clip = { x, y, width: w, height: h, scale: 1 };
    const region = { clip, box: [b[0] - x, b[1] - y, b[2] - x, b[3] - y] };
    if (input) { // PNG 母版本来就已截取，不再多截前景，不为一条字保留整张母版。
      const data = Buffer.allocUnsafe(w * h * 4);
      for (let i = 0; i < h; i++) data.set(input.data.subarray(((y + i) * width + x) * 4, ((y + i) * width + x + w) * 4), i * w * 4);
      region.on = { width: w, height: h, data };
    }
    regions.push({ peak, region });
  }
  if (!regions.length) return;
  const css = await film.page.evaluate(bounds => window.__BMQA.backgroundCSS(bounds), regions.map(p => p.region.clip));
  if (css.error) return; // 缺证据让 QA 报缺失，不拿另一帧顶替。
  const { capture, setCSS } = await inspectorSheet(film.page);
  for (const { region: r } of regions) {
    r.clip.x += css.scrollX; r.clip.y += css.scrollY;
    r.on ??= decodePng(await capture(r.clip));
  }
  try {
    await setCSS(css.text);
    for (const { peak, region: r } of regions) {
      peak.measurement = measureContrast(r.on, decodePng(await capture(r.clip)), r.box);
    }
    if (css.layer !== css.text) {
      // 仅对未分离的路径字取隐藏整层的背景。
      const fallback = regions.filter(({ peak }) => !peak.measurement?.separable);
      if (fallback.length) {
        await setCSS(css.layer);
        for (const { peak, region: r } of fallback) {
          peak.measurement = measureContrast(r.on, decodePng(await capture(r.clip)), r.box);
          peak.via = 'layer';
        }
      }
    }
  } finally { await setCSS(''); }
}

export function samplePageQaFrame(film, frame, fps) {
  return film.page.evaluate(async ({ frame, fps }) => {
    const q = window.__BMQA;
    q.rec = q.platesRec = false;
    const sample = await q.sampleTexts(frame, frame / fps);
    return { ...sample, plates: q.plates.map(({ src, ...p }) => {
      const u = new URL(src, document.baseURI);
      if (u.origin !== location.origin) throw new Error('面片来源不在本地渲染根内');
      return { ...p, file: decodeURIComponent(u.pathname).replace(/^\/+/, '') };
    }), contrast: [] };
  }, { frame, fps });
}

export async function endPageQaFrame(film, { frame, fps, peaks, onPng = null }) {
  const row = await samplePageQaFrame(film, frame, fps);
  const { width, height } = film.page.viewportSize();
  // 首次完全显现可直接取证；亚 1 的峰值要等分块结束才能确定。
  const now = updatePeaks(peaks, row, !film.contract.texts, width, height).filter(p => p.alpha === 1);
  if (now.length) {
    await snapshotPeaks(film, now, onPng);
    for (const peak of now) peak.sampled = true;
  }
  return row;
}

export async function finishPageQaChunk(film, rows, peaks, revisit, plateOpts = {}) {
  const byFrame = Map.groupBy([...peaks.values()], p => p.row.f);
  for (const f of [...byFrame.keys()].sort((a, b) => a - b)) {
    const list = byFrame.get(f), missing = list.filter(p => !p.sampled);
    if (missing.length) await revisit(f, probe => snapshotPeaks(probe, missing, null));
    for (const { it: { id, text, box }, row, measurement, outside, via = 'text' } of list) {
      if (measurement || outside) row.contrast.push({ id, text, box, via, ...(measurement || { separable: false }) });
    }
  }
  const fonts = await fontInventory(film);
  for (const face of fonts.faces) {
    if (!face.bin) {
      const bytes = loadFaceBytes(face, film.origin, ROOT);
      if (Buffer.isBuffer(bytes)) face.bin = bytes.toString('base64');
    }
    face.base = face.base?.replace(film.origin, 'http://page.invalid');
    face.src = face.src?.replaceAll(film.origin, 'http://page.invalid');
  }
  const { three, platesErr } = await film.page.evaluate(() => ({ three: window.__BMQA.three, platesErr: window.__BMQA.platesErr }));
  const images = [];
  for (const file of new Set(rows.flatMap(row => row.plates.map(p => p.file)))) {
    const abs = path.resolve(ROOT, file);
    if (!abs.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('面片路径不在渲染根内');
    const analysis = await analyzePlate(abs, plateOpts);
    images.push({ file, analysis: { ...analysis, options: plateEdgeOptions(plateOpts) } });
  }
  return { rows, fonts, images, info: { hasTexts: film.contract.texts, dur: film.contract.dur, gpu: film.gpu }, three, platesErr, externalRequests: [...film.external] };
}

export function mergePageQaChunks(parts, { width, height, fps, frameCount, firstFrame = 0 }) {
  const rows = parts.flatMap(p => p.rows).sort((a, b) => a.f - b.f);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || rows.length !== frameCount || rows.some((s, i) => s.f !== firstFrame + i ||
      !Array.isArray(s.runs) || !Array.isArray(s.dom) || !Array.isArray(s.plates) || !Array.isArray(s.contrast))) throw new Error('页面 QA 分块缺帧、重帧或缺少探针记录');
  const info = parts[0].info;
  if (parts.some(p => p.info.hasTexts !== info.hasTexts || p.three !== parts[0].three)) throw new Error('页面 QA 分块的探针契约不一致');
  const peaks = new Map();
  for (const row of rows) updatePeaks(peaks, row, !info.hasTexts, width, height);
  const uniq = list => [...new Set(list.map(x => JSON.stringify(x)))].map(x => JSON.parse(x));
  const base = { schemaVersion: 1, source: 'page-render', width, height, fps, frameCount, firstFrame };
  const fonts = Object.fromEntries(['faces', 'set', 'errors'].map(k => [k, uniq(parts.flatMap(p => p.fonts[k]))]));
  return {
    texts: { ...base, info: { ...info, viewport: [width, height] }, fonts, externalRequests: [...new Set(parts.flatMap(p => p.externalRequests))],
      frames: rows.map(({ plates, contrast, ...s }, f) => ({ ...s, f, contrast: contrast.filter(x => peaks.get(JSON.stringify([x.id, x.text]))?.row.f === s.f) })) },
    plates: { ...base, frames: frameCount, three: parts[0].three, platesErr: parts.find(p => p.platesErr)?.platesErr || null,
      images: uniq(parts.flatMap(p => p.images || [])), placements: rows.some(s => s.plates.length) ? rows.map((s, f) => ({ f, plates: s.plates })) : [] },
  };
}
