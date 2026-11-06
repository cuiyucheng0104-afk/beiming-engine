// 北冥引擎 · 打开影片页面：本地静态服务器 + 无头 Chrome，等页面声明 window.READY。
//
// 页面约定（任何一部影片只要满足这四条就能被渲染）：
//   window.DUR        影片时长（秒）
//   window.render(t)  把画面画到时刻 t；必须是确定性的——同一个 t 永远画出同一张图，任意帧可单独重渲
//   window.READY      资源（贴图、字体、着色器）全部就绪后置 true
//   window.TEXTS(t)   可选：返回该时刻画面上的文字，供检查
//
// GPU 后端：BEIMING_ANGLE=metal | vulkan | gl | default
//   macOS 默认 metal；Windows / Linux 的 NVIDIA RTX 机器请用 vulkan，否则 Chrome 可能落到核显或软件渲染。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary',
};

let server = null;
function serve() {
  if (server) return server;
  server = new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let rel;
      try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
      const file = path.resolve(ROOT, '.' + rel);
      if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return server;
}
export async function closeServer() { if (server) (await server).close(); }

function chromeArgs() {
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  return [
    ...(angle === 'default' ? [] : [`--use-angle=${angle}`]),
    '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb',
  ];
}

// --size WxH（偶数，H.264 yuv420p 的要求）
export function takeSize(args, def = [1920, 1040]) {
  const i = args.indexOf('--size');
  if (i < 0) return { w: def[0], h: def[1] };
  const m = /^(\d+)x(\d+)$/.exec(args.splice(i, 2)[1] || '');
  const w = m && +m[1], h = m && +m[2];
  if (!m || w % 2 || h % 2 || w < 16 || h < 16) { console.error('--size 要写成 WxH，且宽高都是偶数，例如 3840x2080'); process.exit(2); }
  return { w, h };
}

// 打开 <dir>/index.html（dir 相对仓库根目录），返回 { browser, page }
export async function openFilm(dir, { w = 1920, h = 1040, query = '' } = {}) {
  const rel = path.relative(fs.realpathSync(ROOT), fs.realpathSync(path.resolve(dir)));
  if (rel.startsWith('..') || !fs.existsSync(path.join(ROOT, rel, 'index.html'))) {
    console.error(`找不到影片页面：${dir}/index.html（影片目录需要在仓库内）`); process.exit(2);
  }
  const port = (await serve()).address().port;
  const browser = await chromium.launch({ executablePath: process.env.BEIMING_CHROME || undefined, args: chromeArgs() });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { console.error('[页面错误]', e.message); process.exit(1); });
  page.on('console', m => { if (m.type() === 'error') console.error('[页面]', m.text().slice(0, 300)); });
  page.on('response', r => {
    if (r.status() >= 400 && ['script', 'document'].includes(r.request().resourceType())) {
      console.error(`[页面] 缺少必需文件 ${r.url()}（${r.status()}）`); process.exit(1);
    }
  });
  const url = `http://127.0.0.1:${port}/${rel ? rel.split(path.sep).map(encodeURIComponent).join('/') + '/' : ''}index.html`;
  await page.goto(url + (query ? '?' + query : ''));
  await page.waitForFunction(() => window.READY === true, null, { timeout: 180000 });
  const gpu = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2');
    const e = g && g.getExtension('WEBGL_debug_renderer_info');
    return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
  });
  if (/swiftshader|llvmpipe|software/i.test(gpu)) console.error(`[提示] WebGL 正在用软件渲染（${gpu.slice(0, 80)}），会很慢：检查 BEIMING_ANGLE 与显卡驱动`);
  return { browser, page, gpu };
}
