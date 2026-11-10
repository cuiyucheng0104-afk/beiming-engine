// 北冥引擎 · 打开影片页面：本地静态服务器 + 无头 Chrome，等页面声明 window.READY。
//
// 页面约定（任何一部影片只要满足这几条就能被渲染）：
//   window.DUR        影片时长（秒），有限正数
//   window.render(t)  把画面画到时刻 t；必须是确定性的——同一个 t 永远画出同一张图，任意帧可单独重渲
//   window.READY      资源（贴图、字体、着色器）全部就绪后置 true
//   window.TEXTS(t)   可选：返回该时刻画面上的文字，供检查
//   window.FPS        可选：页面量化一拍二 / 一拍三用的帧率，没声明按引擎默认 24。video.mjs 默认按它渲染，
//                     --fps 与它不一致直接报错（--any-fps 才跳过）
//
// GPU 后端：BEIMING_ANGLE=metal | vulkan | d3d11 | gl | default
//   macOS 默认 metal；Windows / Linux 的 NVIDIA RTX 机器请用 vulkan，否则 Chrome 可能落到核显或软件渲染。
// 浏览器：默认 Playwright 自带的 chromium-headless-shell；BEIMING_CHROME 指定别的可执行文件（例如系统 Chrome）。
//   tools/rtx/gpucheck.mjs 用的是同一套浏览器与启动参数（chromeExecutable / chromeArgs）。
// 等 READY 的上限：BEIMING_READY_TIMEOUT（秒，默认 180）。
//
// 出错不在这里退出进程：页面未捕获的异常、缺少必需文件（脚本或文档 4xx/5xx）都记在返回的 film 上，
// film.check() 会把它抛出来；等 READY 期间出错立刻失败，并先关掉这个浏览器再抛。退出码与清理交给调用方。
// 影片目录怎样算“在仓库内”（filmRelative）：先看逻辑路径——从影片目录往上找，哪一级的真实路径就是仓库根，就从那一级
//   算相对路径。所以经过符号链接或 Windows 目录联接进入仓库（如 D:\beiming → D:\北冥）认得出；仓库里的影片目录本身是
//   指向仓库外的链接也照样能渲（静态服务器读文件时跟随链接）。逻辑路径不在仓库下时再比真实路径（仓库外的链接指回仓库内）。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

export const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));

/** 渲染脚本可预期的失败（找不到页面、页面报错、等就绪超时）；exitCode 是建议的进程退出码。 */
export class FilmError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'FilmError';
    this.exitCode = exitCode;
  }
}

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

// 渲染器实际使用的 ANGLE 后端、浏览器可执行文件与启动参数（gpucheck 复用同一套）
export const defaultAngle = () => process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
export const chromeExecutable = () => process.env.BEIMING_CHROME || undefined;
export function chromeArgs(angle = defaultAngle()) {
  return [
    ...(angle === 'default' ? [] : [`--use-angle=${angle}`]),
    '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb',
  ];
}
// 软件光栅：SwiftShader、Mesa llvmpipe / softpipe、Windows 的 WARP（“Microsoft Basic Render Driver”）
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|\bwarp\b/i;
export const isSoftwareRenderer = name => SOFTWARE_RENDERER.test(String(name || ''));

// --size WxH（偶数，H.264 yuv420p 的要求）；写了多次以最后一次为准
export function takeSize(args, def = [1920, 1040]) {
  let size = null;
  for (let i = args.indexOf('--size'); i >= 0; i = args.indexOf('--size')) size = args.splice(i, 2)[1] ?? '';
  if (size === null) return { w: def[0], h: def[1] };
  const m = /^(\d+)x(\d+)$/.exec(size);
  const w = m && +m[1], h = m && +m[2];
  if (!m || w % 2 || h % 2 || w < 16 || h < 16) { console.error('--size 要写成 WxH，且宽高都是偶数，例如 3840x2080'); process.exit(2); }
  return { w, h };
}

// path.relative 的结果是否仍在根内：'' 是根本身；'..'、'../x'、Windows 跨盘（返回绝对路径）都在外面。
// 名叫 ..draft 的目录在根内，不能只看是不是以 .. 开头。
export function insideRoot(rel) {
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

const realpath = p => { try { return fs.realpathSync(p); } catch { return null; } };

// 影片目录相对仓库根（root 须是真实路径）的路径，用 insideRoot 判断是否在根内。
//   1) 逻辑路径：从 dir 往上逐级取真实路径，等于 root 的那一级就是仓库根在这条路径上的位置，从那里算相对路径
//      （dir 本身或中间某一级是链接都不影响，链接由静态服务器读文件时跟随）；
//   2) 找不到时比真实路径：dir 是仓库外的链接、指回仓库内。
export function filmRelative(dir, root = ROOT) {
  const abs = path.resolve(dir);
  for (let a = abs; ; a = path.dirname(a)) {
    const real = realpath(a);
    if (real !== null && path.relative(real, root) === '') return path.relative(a, abs);   // Windows 上不分大小写（d: 与 D:）
    if (path.dirname(a) === a) break;
  }
  return path.relative(root, realpath(abs) ?? abs);
}

const readyTimeout = () => {
  const s = Number(process.env.BEIMING_READY_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 180000;
};
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
const abortion = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

// 打开 <dir>/index.html（dir 在仓库内），返回 { browser, page, gpu, check, close, failed }
//   check()   页面已经报过错就抛出（每帧渲完调用一次）
//   close()   关浏览器，最多等 10 秒；可重复调用
//   failed    页面报错时 reject 的 Promise，可与其它等待一起 race
// options.handleSignals=false：不让 Playwright 接管 SIGINT/SIGTERM/SIGHUP（调用方自己收尾，见 video.mjs）
// options.signal：AbortSignal，中止时停止等待、关掉浏览器并抛出 signal.reason
export async function openFilm(dir, { w = 1920, h = 1040, query = '', handleSignals = true, signal } = {}) {
  const rel = filmRelative(dir);
  if (!insideRoot(rel) || !fs.existsSync(path.join(ROOT, rel, 'index.html'))) {
    throw new FilmError(`找不到影片页面：${dir}/index.html（影片目录需要在仓库内）`, 2);
  }
  if (signal?.aborted) throw signal.reason;
  const port = (await serve()).address().port;
  const browser = await chromium.launch({
    executablePath: chromeExecutable(), args: chromeArgs(),
    handleSIGINT: handleSignals, handleSIGTERM: handleSignals, handleSIGHUP: handleSignals,
  });
  let closing = null;
  const close = () => (closing ??= Promise.race([browser.close().catch(() => {}), sleep(10000)]));
  let fatal = null, rejectFailed;
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {});
  const fail = e => { if (!fatal) { fatal = e; rejectFailed(e); } };
  const check = () => { if (fatal) throw fatal; };
  const timeout = readyTimeout();
  let phase = '打开页面';
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('pageerror', e => { console.error('[页面错误]', e.message); fail(new FilmError(`页面错误：${e.message}`)); });
    page.on('console', m => { if (m.type() === 'error') console.error('[页面]', m.text().slice(0, 300)); });
    page.on('response', r => {
      if (r.status() >= 400 && ['script', 'document'].includes(r.request().resourceType())) {
        const msg = `缺少必需文件 ${r.url()}（${r.status()}）`;
        console.error(`[页面] ${msg}`); fail(new FilmError(msg));
      }
    });
    const waits = signal ? [failed, abortion(signal)] : [failed];
    const url = `http://127.0.0.1:${port}/${rel ? rel.split(path.sep).map(encodeURIComponent).join('/') + '/' : ''}index.html`;
    await Promise.race([page.goto(url + (query ? '?' + query : '')), ...waits]);
    phase = `等页面就绪（window.READY，上限 ${timeout / 1000} 秒）`;
    await Promise.race([page.waitForFunction(() => window.READY === true, null, { timeout }), ...waits]);
    check();
    const gpu = await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      const e = g && g.getExtension('WEBGL_debug_renderer_info');
      return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
    });
    if (isSoftwareRenderer(gpu)) console.error(`[提示] WebGL 正在用软件渲染（${gpu.slice(0, 80)}），会很慢：检查 BEIMING_ANGLE 与显卡驱动`);
    return { browser, page, gpu, check, close, failed };
  } catch (e) {
    await close();
    if (e?.name === 'TimeoutError') throw new FilmError(`${phase}超时：${dir}/index.html`);
    throw e;
  }
}
