// A/C 页面的渲染期旁注：原 render 只调用一次。保留 draw/DOM 探针、字体、投影和各候选帧的对比度；
// 合并之后 QA 才能按整片取每条文字峰值（并列取中间），不能取各块峰值的平均。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE, THREE_MODULE, threeShim, fontInventory } from '../../../tools/qa/lib/page.mjs';
import { loadFaceBytes, measureContrast, sampleTextItems } from '../../../tools/qa/checks/texts.mjs';
import { analyzePlate } from '../../../tools/qa/lib/plate-edges.mjs';
import { decodePng } from '../../../tools/qa/lib/png.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

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
  qa.backgroundCSS = () => {
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
      // CSS object-position moves the original replaced content out of its clip; preserve underlying CSS backgrounds.
      if (cs.objectFit !== 'fill' || cs.objectPosition !== '50% 50%') { qa.backgroundError = true; continue; }
      const css = `${sel}{object-position:-100000px -100000px!important;background-image:url(${m.c.toDataURL()}),${cs.backgroundImage}!important;background-size:100% 100%,${cs.backgroundSize}!important;background-position:0 0,${cs.backgroundPosition}!important;background-repeat:no-repeat,${cs.backgroundRepeat}!important;background-origin:content-box,${cs.backgroundOrigin}!important;background-clip:content-box,${cs.backgroundClip}!important}`;
      text += css;
      if (!overlay) layer += css;
    }
    return { text, layer, error: !!qa.backgroundError };
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
    sheets.set(page, text => session.send('CSS.setStyleSheetText', { styleSheetId, text }));
  }
  return sheets.get(page);
}

export async function endPageQaFrame(film, { frame, fps, onPng = null }) {
  const row = await film.page.evaluate(async ({ frame, fps }) => {
    const q = window.__BMQA;
    q.rec = q.platesRec = false;
    const sample = await q.sampleTexts(frame, frame / fps);
    return { ...sample, plates: q.plates.map(({ src, ...p }) => {
      const u = new URL(src, document.baseURI);
      if (u.origin !== location.origin) throw new Error('面片来源不在本地渲染根内');
      return { ...p, file: decodeURIComponent(u.pathname).replace(/^\/+/, '') };
    }), contrast: [] };
  }, { frame, fps });
  const { width, height } = film.page.viewportSize();
  const items = sampleTextItems(row, !film.contract.texts, width, height).filter(x => !x.bad && (x.alpha ?? 1) > 0.02);
  if (!items.length) return row;
  const css = await film.page.evaluate(() => window.__BMQA.backgroundCSS());
  if (css.error) return row;
  const on = decodePng(onPng || await film.capture('png'));
  const setCSS = await inspectorSheet(film.page);
  try {
    await setCSS(css.text);
    const text = decodePng(await film.capture('png'));
    let layer = null;
    for (const { id, box, text: label } of items) {
      let m = measureContrast(on, text, box), via = 'text';
      if (!m?.separable && css.layer !== css.text) {
        if (!layer) { await setCSS(css.layer); layer = decodePng(await film.capture('png')); }
        m = measureContrast(on, layer, box); via = 'layer';
      }
      row.contrast.push({ id, text: label, box, via, ...(m || { separable: false }) });
    }
  } finally { await setCSS(''); }
  return row;
}

export async function finishPageQaChunk(film, rows) {
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
    images.push({ file, analysis: await analyzePlate(abs) });
  }
  return { rows, fonts, images, info: { hasTexts: film.contract.texts, dur: film.contract.dur, gpu: film.gpu }, three, platesErr, externalRequests: [...film.external] };
}

export function mergePageQaChunks(parts, { width, height, fps, frameCount, firstFrame = 0 }) {
  const rows = parts.flatMap(p => p.rows).sort((a, b) => a.f - b.f);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || rows.length !== frameCount || rows.some((s, i) => s.f !== firstFrame + i ||
      !Array.isArray(s.runs) || !Array.isArray(s.dom) || !Array.isArray(s.plates) || !Array.isArray(s.contrast))) throw new Error('页面 QA 分块缺帧、重帧或缺少探针记录');
  const info = parts[0].info;
  if (parts.some(p => p.info.hasTexts !== info.hasTexts || p.three !== parts[0].three)) throw new Error('页面 QA 分块的探针契约不一致');
  const uniq = list => [...new Set(list.map(x => JSON.stringify(x)))].map(x => JSON.parse(x));
  const base = { schemaVersion: 1, source: 'page-render', width, height, fps, frameCount, firstFrame };
  const fonts = Object.fromEntries(['faces', 'set', 'errors'].map(k => [k, uniq(parts.flatMap(p => p.fonts[k]))]));
  return {
    texts: { ...base, info: { ...info, viewport: [width, height] }, fonts, externalRequests: [...new Set(parts.flatMap(p => p.externalRequests))],
      frames: rows.map(({ plates, ...s }, f) => ({ ...s, f })) },
    plates: { ...base, frames: frameCount, three: parts[0].three, platesErr: parts.find(p => p.platesErr)?.platesErr || null,
      images: uniq(parts.flatMap(p => p.images || [])), placements: rows.some(s => s.plates.length) ? rows.map((s, f) => ({ f, plates: s.plates })) : [] },
  };
}
