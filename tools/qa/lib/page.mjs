// 北冥 QA · 页面检查台：本地只读静态服务（只绑 127.0.0.1、校验 Host、不给 . 开头的路径）+ 无头 Chrome，
// 在页面脚本运行前注入探针：记录 Canvas 2D 的每次 fillText / strokeText（文字、字体、实际不透明度、屏幕方框、document.fonts.check），
// 记录 FontFace 构造（字体来源），可按需「只关文字」重渲一帧（取文字背后的背景算对比度）。外网请求一律拦下并记录（附录 C5 禁止访问外网）。
// 与 engine/render/page.mjs 的区别：出错不 process.exit，而是抛 QaError，由调用方收尾；P04 的 serve.mjs 合入后可改用它的服务部分。
//
//   openPage({ root, pageDir, width, height, fps, profileId, readyTimeoutMs }) → { page, info, externalRequests, pageErrors, close }
//   sampleFrames(h, frames, { fps, dom })     → [{ f, texts, textsError, runs, dom }]（每批在页面里连续 render(t)，减少往返）
//   fontInventory(h)                          → { faces, set }：FontFace 与 @font-face 的来源、描述符、加载状态
//   screenshotPair(h, f, fps)                 → { on: PNG, off: PNG }：同一帧开、关文字各截一张无损图
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QaError, EXIT, onCleanup } from './cli-kit.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

function serve(root) {
  return new Promise((resolve, reject) => {
    const base = path.resolve(root);
    const s = http.createServer((req, res) => {
      const host = String(req.headers.host || '');
      const port = s.address().port;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(421); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      let rel;
      try { rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]); } catch { res.writeHead(400); return res.end(); }
      if (rel.split('/').some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) { res.writeHead(403); return res.end(); }
      const file = path.resolve(base, '.' + rel);
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function chromeArgs() {
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  return [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb'];
}

// 页面里的探针（在页面任何脚本之前运行）
const PROBE = cfg => {
  if (!window.__RENDER) window.__RENDER = { fps: cfg.fps, width: cfg.width, height: cfg.height, profile: cfg.profile };
  const QA = window.__BMQA = { rec: false, hide: false, runs: [], fonts: [], ids: new WeakMap(), next: 1 };
  const alphaOf = s => {
    if (typeof s !== 'string') return 1;
    let m = /^#([0-9a-f]{8})$/i.exec(s);
    if (m) return parseInt(m[1].slice(6), 16) / 255;
    m = /rgba?\(([^)]*)\)/i.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean); if (p.length >= 4) return p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]); }
    return 1;
  };
  QA.alphaOf = alphaOf;
  const NFF = window.FontFace;
  if (NFF) {
    const Wrapped = function FontFace(family, source, desc) {
      const ff = new NFF(family, source, desc);
      let bin = null;
      if (source instanceof ArrayBuffer) bin = new Uint8Array(source.slice(0));
      else if (ArrayBuffer.isView(source)) bin = new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
      QA.fonts.push({ family: String(family), src: typeof source === 'string' ? source : null, bin, face: ff, base: document.baseURI });
      return ff;
    };
    Wrapped.prototype = NFF.prototype;
    Object.defineProperty(window, 'FontFace', { value: Wrapped, writable: true, configurable: true });
  }
  const idOf = c => { if (!c) return 0; let id = QA.ids.get(c); if (!id) { id = QA.next++; QA.ids.set(c, id); } return id; };
  for (const Ctx of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].filter(Boolean)) {
    for (const name of ['fillText', 'strokeText']) {
      const orig = Ctx.prototype[name];
      Ctx.prototype[name] = function (text, x, y) {
        if (QA.rec) {
          const str = String(text);
          try {
            const t = this.getTransform(), m = this.measureText(str);
            const L = x - m.actualBoundingBoxLeft, R = x + m.actualBoundingBoxRight, T = y - m.actualBoundingBoxAscent, B = y + m.actualBoundingBoxDescent;
            const pts = [[L, T], [R, T], [L, B], [R, B]].map(([px, py]) => [t.a * px + t.c * py + t.e, t.b * px + t.d * py + t.f]);
            const cv = this.canvas, attached = !!(cv && cv.isConnected);
            let sx = 1, sy = 1, ox = 0, oy = 0;
            if (attached) { const r = cv.getBoundingClientRect(); sx = r.width / cv.width; sy = r.height / cv.height; ox = r.left; oy = r.top; }
            const xs = pts.map(p => p[0] * sx + ox), ys = pts.map(p => p[1] * sy + oy);
            let loaded = null;
            try { loaded = document.fonts.check(this.font, str); } catch { loaded = null; }
            QA.runs.push({
              op: name, text: str, font: this.font, filter: this.filter && this.filter !== 'none' ? this.filter : null,
              alpha: this.globalAlpha * alphaOf(name === 'fillText' ? this.fillStyle : this.strokeStyle),
              canvas: idOf(cv), attached, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], loaded,
            });
          } catch (e) { QA.runs.push({ op: name, text: str, font: this.font, error: String(e) }); }
        }
        if (QA.hide) return undefined;
        return orig.apply(this, arguments);
      };
    }
  }
  QA.domTexts = () => {
    const out = [];
    if (!document.body || !(document.body.innerText || '').trim()) return out;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, k = 0;
    while ((n = w.nextNode()) && k < 400) {
      const s = n.nodeValue;
      if (!s || !s.trim()) continue;
      const el = n.parentElement;
      if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let op = 1;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity || '1');
      if (op <= 0.02) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const svg = el instanceof SVGElement;
      out.push({ text: s.trim(), font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, alpha: op * alphaOf(svg ? cs.fill : cs.color), box: [r.left, r.top, r.right, r.bottom], dom: true });
      k++;
    }
    return out;
  };
  QA.setHidden = on => {
    QA.hide = on;
    let st = document.getElementById('__bmqa_hide');
    if (on && !st) {
      st = document.createElement('style'); st.id = '__bmqa_hide';
      st.textContent = '*{color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;caret-color:transparent!important}svg text,svg tspan{fill:transparent!important;stroke:transparent!important}';
      document.head.appendChild(st);
    } else if (!on && st) st.remove();
    // 显示层：叠在 WebGL 画布上面的 2D 画布（engine/stage/film.js 的做法），关文字时整层隐藏
    const cvs = [...document.querySelectorAll('canvas')];
    const gl = cvs.filter(c => c.__bmType === 'webgl');
    for (const c of cvs) {
      if (c.__bmType !== '2d' || !gl.length) continue;
      const z = parseInt(getComputedStyle(c).zIndex, 10) || 0;
      if (gl.some(g => (parseInt(getComputedStyle(g).zIndex, 10) || 0) < z)) c.style.visibility = on ? 'hidden' : '';
    }
  };
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    const ctx = gc.call(this, type, opts);
    if (ctx && !this.__bmType) this.__bmType = /webgl|webgpu/i.test(type) ? 'webgl' : type === '2d' ? '2d' : String(type);
    return ctx;
  };
};

export async function openPage({ root, pageDir, width, height, fps, profileId, readyTimeoutMs = 120000 }) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    throw new QaError('env.playwright-missing', '缺少 playwright-core', { hint: '在仓库根目录运行 npm ci（或 npm install）', exitCode: EXIT.ENV });
  }
  const relDir = path.relative(root, pageDir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw new QaError('usage', `页面目录 ${pageDir} 不在服务根 ${root} 之内`, { exitCode: EXIT.USAGE });
  const server = await serve(root);
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  let browser = null;
  const close = async () => {
    if (browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
    await new Promise(r => server.close(() => r()));
  };
  const unhook = onCleanup(close);
  try {
    try {
      browser = await chromium.launch({ executablePath: process.env.BEIMING_CHROME || undefined, args: chromeArgs() });
    } catch (e) {
      const missing = /Executable doesn't exist|executable.*not found|ENOENT/i.test(e.message);
      throw new QaError(missing ? 'env.browser-missing' : 'env.browser', missing ? '没有装无头浏览器（playwright 的 chromium-headless-shell）' : `浏览器启动失败：${e.message.split('\n')[0]}`,
        { hint: missing ? '在仓库根目录运行 npm run setup（会装与 playwright-core 1.63.0 配套的 headless shell）；或用环境变量 BEIMING_CHROME 指向浏览器' : '检查 BEIMING_ANGLE 与显卡驱动；无显卡机器可设 BEIMING_ANGLE=swiftshader', exitCode: EXIT.ENV });
    }
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const externalRequests = [], pageErrors = [], consoleErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e.message || e).slice(0, 400)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    await page.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith(origin + '/') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
      externalRequests.push(u.slice(0, 200));
      return route.abort();
    });
    await page.addInitScript(PROBE, { fps, width, height, profile: profileId });
    const url = `${origin}/${relDir ? relDir.split(path.sep).map(encodeURIComponent).join('/') + '/' : ''}index.html`;
    await page.goto(url, { timeout: readyTimeoutMs }).catch(e => { throw new QaError('page.load', `页面打不开：${e.message.split('\n')[0]}`, { exitCode: EXIT.RUNTIME }); });
    const t0 = Date.now();
    for (;;) {
      if (pageErrors.length) throw new QaError('page.error', `页面脚本出错：${pageErrors[0]}`, { hint: '先用 node engine/render/still.mjs 渲一帧确认页面本身能跑', exitCode: EXIT.RUNTIME });
      const ready = await page.evaluate(() => window.READY === true).catch(() => false);
      if (ready) break;
      if (Date.now() - t0 > readyTimeoutMs) {
        throw new QaError('page.ready-timeout', `等了 ${Math.round(readyTimeoutMs / 1000)} 秒，页面一直没有把 window.READY 置成 true`, { hint: '检查资源是否 404、字体是否加载失败；慢机器可加 --ready-timeout', exitCode: EXIT.TIMEOUT });
      }
      await new Promise(r => setTimeout(r, 100));
    }
    const info = await page.evaluate(() => ({
      dur: window.DUR, hasRender: typeof window.render === 'function', hasTexts: typeof window.TEXTS === 'function',
      gpu: (() => { try { const g = document.createElement('canvas').getContext('webgl2'); const e = g && g.getExtension('WEBGL_debug_renderer_info'); return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ''; } catch { return ''; } })(),
      viewport: [innerWidth, innerHeight],
    }));
    if (!info.hasRender) throw new QaError('page.contract', '页面没有 window.render(t)（附录 C5 必选）', { exitCode: EXIT.GATE });
    if (!(typeof info.dur === 'number' && Number.isFinite(info.dur) && info.dur > 0)) throw new QaError('page.contract', `window.DUR 不是有限正数（收到 ${JSON.stringify(info.dur)}）`, { exitCode: EXIT.GATE });
    return { page, info, origin, externalRequests, pageErrors, consoleErrors, close: async () => { unhook(); await close(); } };
  } catch (e) {
    unhook();
    await close();
    throw e;
  }
}

export async function sampleFrames(h, frames, { fps, dom = true, batch = 24, timeoutMs = 600000 }) {
  const out = [];
  for (let i = 0; i < frames.length; i += batch) {
    const part = frames.slice(i, i + batch);
    const r = await Promise.race([
      h.page.evaluate(async ({ part, fps, dom }) => {
        const QA = window.__BMQA, res = [];
        for (const f of part) {
          QA.runs = []; QA.rec = true;
          try { const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; } catch (e) { QA.rec = false; return { error: `render(${f}/${fps}) 抛错：${(e && e.message) || e}`, frame: f, res }; }
          QA.rec = false;
          let texts = null, textsError = null;
          if (typeof window.TEXTS === 'function') {
            try { texts = window.TEXTS(f / fps); if (texts && typeof texts.then === 'function') texts = await texts; } catch (e) { textsError = String((e && e.message) || e); }
            if (texts != null && !Array.isArray(texts)) { textsError = `TEXTS(t) 应返回数组，收到 ${typeof texts}`; texts = null; }
            else if (texts) texts = JSON.parse(JSON.stringify(texts));
          }
          res.push({ f, texts, textsError, runs: QA.runs, dom: dom ? QA.domTexts() : [] });
        }
        return { res };
      }, { part, fps, dom }),
      new Promise((_, rej) => setTimeout(() => rej(new QaError('timeout', `页面渲染第 ${part[0]}–${part[part.length - 1]} 帧超时`, { exitCode: EXIT.TIMEOUT })), timeoutMs)),
    ]);
    if (h.pageErrors.length) throw new QaError('page.error', `页面脚本出错：${h.pageErrors[0]}`, { exitCode: EXIT.RUNTIME });
    out.push(...r.res);
    if (r.error) throw new QaError('page.render', r.error, { hint: 'render(t) 必须对任意帧可单独调用（附录 C5）', exitCode: EXIT.RUNTIME });
  }
  return out;
}

export async function fontInventory(h) {
  return h.page.evaluate(() => {
    const QA = window.__BMQA;
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const faces = QA.fonts.map(f => ({ origin: 'FontFace', family: f.family, src: f.src, base: f.base, bin: f.bin ? b64(f.bin) : null, weight: f.face.weight, style: f.face.style, unicodeRange: f.face.unicodeRange, status: f.face.status }));
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r.type === CSSRule.FONT_FACE_RULE) {
          faces.push({ origin: 'css', family: r.style.getPropertyValue('font-family').trim(), src: r.style.getPropertyValue('src'), base, weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal', unicodeRange: r.style.getPropertyValue('unicode-range') || '', status: null });
        } else if (r.cssRules) walk(r.cssRules, base);
      }
    };
    const errors = [];
    for (const sh of document.styleSheets) { try { walk(sh.cssRules, sh.href || document.baseURI); } catch { errors.push(`读不到样式表 ${sh.href}（跨域）`); } }
    const set = [];
    document.fonts.forEach(ff => set.push({ family: ff.family, weight: ff.weight, style: ff.style, unicodeRange: ff.unicodeRange, status: ff.status }));
    return { faces, set, errors };
  });
}

export async function screenshotPair(h, f, fps) {
  await h.page.evaluate(async ({ f, fps }) => { const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; }, { f, fps });
  const on = await h.page.screenshot({ type: 'png' });
  await h.page.evaluate(async ({ f, fps }) => { window.__BMQA.setHidden(true); const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; }, { f, fps });
  const off = await h.page.screenshot({ type: 'png' });
  await h.page.evaluate(() => window.__BMQA.setHidden(false));
  return { on, off };
}
