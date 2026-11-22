// 北冥 QA · 页面检查台：本地只读静态服务（只绑 127.0.0.1、校验 Host、不给 . 开头的路径）+ 无头 Chrome，
// 在页面脚本运行前注入探针：记录 Canvas 2D 的每次 fillText / strokeText（文字、字体、实际不透明度、屏幕方框、document.fonts.check），
// 记录 FontFace 构造（字体来源），可按需「只关文字」重渲一帧（取文字背后的背景算对比度）。外网请求一律拦下并记录（附录 C5 禁止访问外网）。
// 与 engine/render/page.mjs 的区别：出错不 process.exit，而是抛 QaError，由调用方收尾；P04 的 serve.mjs 合入后可改用它的服务部分。
//
//   openPage({ root, pageDir, width, height, fps, profileId, readyTimeoutMs }) → { page, info, externalRequests, pageErrors, close }
//   sampleFrames(h, frames, { fps, dom })     → [{ f, texts, textsError, runs, dom }]（每批在页面里连续 render(t)，减少往返）
//   fontInventory(h)                          → { faces, set }：FontFace 与 @font-face 的来源、描述符、加载状态
//   screenshotSet(h, f, fps)                  → { on, text, layer }（PNG）：同一帧照常、只关文字、关文字并藏掉显示层各截一张无损图
//   samplePlates(h, frames, { fps })          → [{ f, plates: [贴图面片] }]（openPage 要带 shimThree: true）
import { PROBE, THREE_MODULE, threeShim } from '../../../engine/render/lib/page-probe.mjs';
export { PROBE, THREE_MODULE, threeShim, fontInventory } from '../../../engine/render/lib/page-probe.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QaError, EXIT, onCleanup, withTimeout, usageError } from './cli-kit.mjs';
import { checkRecordHash } from './probe.mjs';

export function readPageRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw usageError(`${path.basename(file)} 不是可读取的 JSON：${e.message}`); }
}

export function checkPageRecordSpec(doc, { film, size, fps }) {
  const w = size?.[0] ?? film?.width, h = size?.[1] ?? film?.height;
  if (doc?.schemaVersion !== 1 || doc.source !== 'page-render' ||
      ![doc.width, doc.height, doc.frameCount].every(n => Number.isSafeInteger(n) && n > 0) ||
      (w != null && doc.width !== w) || (h != null && doc.height !== h) || !Number.isFinite(doc.fps) || Math.abs(doc.fps - fps) > 1e-6 ||
      (film?.frameCount != null && film.frameCount !== doc.frameCount)) throw usageError('页面 QA 记录的版本、来源、帧数、画幅或帧率与成片不符');
  if (Object.hasOwn(doc, 'videoStreamSha256')) checkRecordHash(doc, '页面 QA 记录');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

function serve(root, { shimThree = false } = {}) {
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
      const tm = shimThree && !/[?&]bmqa=real\b/.test(req.url) ? THREE_MODULE.exec(rel) : null;
      if (tm) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : threeShim(tm[1])); }
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

export async function openPage({ root, pageDir, width, height, fps, profileId, readyTimeoutMs = 120000, shimThree = false }) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    throw new QaError('env.playwright-missing', '缺少 playwright-core', { hint: '在仓库根目录运行 npm ci（或 npm install）', exitCode: EXIT.ENV });
  }
  const relDir = path.relative(root, pageDir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw new QaError('usage.bad-value', `页面目录 ${pageDir} 不在服务根 ${root} 之内`, { exitCode: EXIT.USAGE });
  const server = await serve(root, { shimThree });
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
    const r = await withTimeout(
      h.page.evaluate(async ({ part, fps, dom }) => {
        const QA = window.__BMQA, res = [];
        for (const f of part) {
          QA.runs = []; QA.rec = true;
          try { const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; } catch (e) { QA.rec = false; return { error: `render(${f}/${fps}) 抛错：${(e && e.message) || e}`, frame: f, res }; }
          QA.rec = false;
          res.push(await QA.sampleTexts(f, f / fps, dom));
        }
        return { res };
      }, { part, fps, dom }),
      timeoutMs,
      () => { throw new QaError('timeout', `页面渲染第 ${part[0]}–${part[part.length - 1]} 帧超时`, { hint: '单帧太慢时用 --timeout 放宽（秒）；或检查 render(t) 是否卡死', exitCode: EXIT.TIMEOUT }); },
    );
    if (h.pageErrors.length) throw new QaError('page.error', `页面脚本出错：${h.pageErrors[0]}`, { exitCode: EXIT.RUNTIME });
    out.push(...r.res);
    if (r.error) throw new QaError('page.render', r.error, { hint: 'render(t) 必须对任意帧可单独调用（附录 C5）', exitCode: EXIT.RUNTIME });
  }
  return out;
}

// 逐帧 render(t)，取探针记下的贴图面片（见 PROBE 的 installThree）
export async function samplePlates(h, frames, { fps, batch = 24, timeoutMs = 600000 }) {
  const out = [];
  for (let i = 0; i < frames.length; i += batch) {
    const part = frames.slice(i, i + batch);
    const r = await withTimeout(
      h.page.evaluate(async ({ part, fps }) => {
        const QA = window.__BMQA, res = [];
        for (const f of part) {
          QA.plates = []; QA.platesSeen = new Set(); QA.platesRec = true;
          try { const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; } catch (e) { QA.platesRec = false; return { error: `render(${f}/${fps}) 抛错：${(e && e.message) || e}`, res }; }
          QA.platesRec = false;
          res.push({ f, plates: QA.plates });
        }
        return { res, three: QA.three, err: QA.platesErr };
      }, { part, fps }),
      timeoutMs,
      () => { throw new QaError('timeout', `页面渲染第 ${part[0]}–${part[part.length - 1]} 帧超时`, { hint: '单帧太慢时用 --timeout 放宽（秒）', exitCode: EXIT.TIMEOUT }); },
    );
    if (h.pageErrors.length) throw new QaError('page.error', `页面脚本出错：${h.pageErrors[0]}`, { exitCode: EXIT.RUNTIME });
    if (r.error) throw new QaError('page.render', r.error, { hint: 'render(t) 必须对任意帧可单独调用（附录 C5）', exitCode: EXIT.RUNTIME });
    out.push(...r.res);
    h.three = r.three; h.platesErr = r.err;
  }
  return out;
}

// 同一帧截三张无损图：on 照常；text 只关文字；layer 关文字并藏掉整层显示层
export async function screenshotSet(h, f, fps) {
  const shot = async mode => {
    await h.page.evaluate(async ({ f, fps, mode }) => { window.__BMQA.setHidden(mode); const p = window.render(f / fps); if (p && typeof p.then === 'function') await p; }, { f, fps, mode });
    return h.page.screenshot({ type: 'png' });
  };
  try {
    return { on: await shot(false), text: await shot('text'), layer: await shot('layer') };
  } finally {
    await h.page.evaluate(() => window.__BMQA.setHidden(false)).catch(() => {});
  }
}
