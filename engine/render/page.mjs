// 北冥引擎 · 打开影片页面：本地静态服务器 + 无头 Chrome，注入渲染信息与故障监测，等页面声明 window.READY，核对页面约定。
//
// 页面约定 v1（任何一部影片只要满足这几条就能被渲染；完整说明见 engine/render/README.md「页面约定」）：
//   window.DUR        必选。影片时长（秒），有限正数；round(DUR × fps) 就是帧数
//   window.render(t)  必选。把画面画到时刻 t，可同步也可返回 Promise；必须确定——同一个 t 永远画出同一张图，任意帧可单独重渲
//   window.READY      必选。资源（贴图、字体、着色器）全部就绪后置 true
//   window.FPS        可选。页面量化一拍二 / 一拍三用的帧率；没声明按引擎默认 24。与渲染帧率不一致 → 退出码 4
//   window.TEXTS(t)   推荐。返回该时刻画面上的文字 [{ text, box, alpha, font }]，供 QA 检查
//   window.EV / TIMELINE   可选。声画事件表 / 节拍表（engine/render/events.mjs 导出）
//   window.BEIMING_CONTRACT   可选，缺省 1；本渲染器只认 1
//   window.__RENDER   渲染器注入（页面脚本运行之前）：{ fps, width, height, profile, frameCount, contract }
// 禁止：渲染路径里用 Math.random / Date.now / performance.now（计时除外）、渲染时读回 GPU 画布、访问外网。
//
// 出错不在这里退出进程：页面未捕获的异常、页面崩溃、着色器编译失败、WebGL 上下文丢失、缺本地文件（任何类型返回 ≥400 或
// 请求失败）、访问外网，都记成 film 上的致命错误，check() 抛出（RenderError，错误码见 README「错误码」，带下一步提示）；
// 等 READY 期间出错立刻失败，并先关掉这个浏览器再抛。退出码与清理交给调用方（still / video / shots）。
//
// GPU：ANGLE 后端按 --angle / BEIMING_ANGLE / 平台默认选（macOS metal、Windows vulkan、Linux default），平台不对直接报错；
//   --gpu required（默认，读 BEIMING_GPU）时落到软件渲染判失败（退出码 3）。浏览器与启动参数见 lib/gpu.mjs，
//   tools/rtx/gpucheck.mjs 用的是同一个 launchBrowser。
// 等 READY 的上限：readyTimeoutMs（默认 BEIMING_READY_TIMEOUT 秒，180）；15 秒还没就绪先打印已捕获的错误与还没回来的请求。
// 影片目录怎样算“在仓库内”（filmRelative）：先看逻辑路径——从影片目录往上找，哪一级的真实路径就是仓库根，就从那一级
//   算相对路径。所以经过符号链接或 Windows 目录联接进入仓库（如仓库所在盘上的链接目录 → 真实目录）认得出；仓库里的影片目录本身是
//   指向仓库外的链接也照样能渲（静态服务器登记了它的真实路径）。逻辑路径不在仓库下时再比真实路径（仓库外的链接指回仓库内）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from './lib/server.mjs';
import { RenderError, EXIT } from './lib/errors.mjs';
import { faultWatch, renderInfo } from './lib/inject.mjs';
import {
  chromeArgs, chromeExecutable, defaultAngle, isSoftwareRenderer, SOFTWARE_RENDERER,
  resolveAngle, resolveGpuPolicy, launchBrowser, probeGpu, enforceGpu,
} from './lib/gpu.mjs';

export { chromeArgs, chromeExecutable, defaultAngle, isSoftwareRenderer, SOFTWARE_RENDERER };
export const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
export const CONTRACT_VERSION = 1;

/** 渲染脚本可预期的失败（兼容旧接口）：exitCode 是建议的进程退出码；code 不写时按退出码取 usage.film / failure.film */
export class FilmError extends RenderError {
  constructor(message, exitCode = EXIT.FAILURE, { code, hint } = {}) {
    super(code ?? (exitCode === EXIT.USAGE ? 'usage.film' : 'failure.film'), message, { exitCode, hint });
    this.name = 'FilmError';
  }
}

let server = null;
async function serve() {
  if (!server) {
    const s = createServer({ root: ROOT });
    server = s.listen(0).then(() => s);
  }
  return server;
}
export async function closeServer() { if (server) { const s = await server; server = null; await s.close(); } }

// --size WxH（偶数，H.264 yuv420p 的要求）；写了多次以最后一次为准。兼容旧接口：出错直接退出码 2（events.mjs 在用）
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

// 影片目录相对仓库根（root 须是真实路径）的路径，用 insideRoot 判断是否在根内（见文件开头的说明）
export function filmRelative(dir, root = ROOT) {
  const abs = path.resolve(dir);
  for (let a = abs; ; a = path.dirname(a)) {
    const real = realpath(a);
    if (real !== null && path.relative(real, root) === '') return path.relative(a, abs);   // Windows 上不分大小写（d: 与 D:）
    if (path.dirname(a) === a) break;
  }
  return path.relative(root, realpath(abs) ?? abs);
}

/** 影片页面的检查：返回 { rel, index }；不在仓库内或没有 index.html → 退出码 2 */
export function locateFilm(dir) {
  const rel = filmRelative(dir);
  const index = path.join(ROOT, rel, 'index.html');
  if (!insideRoot(rel) || !fs.existsSync(index)) {
    throw new FilmError(`找不到影片页面：${dir}/index.html（影片目录需要在仓库内）`, EXIT.USAGE,
      { code: 'usage.film-not-found', hint: '影片目录要放在仓库里（films/<名字>/），里面要有 index.html；《北冥》样片是仓库根目录 .' });
  }
  return { rel, index };
}

export const readyTimeoutMs = () => {
  const s = Number(process.env.BEIMING_READY_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 180000;
};
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
const abortion = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

// 致命的控制台消息：着色器编译 / 链接失败（three.js 用 console.error）、WebGL 上下文丢失（three.js 用 console.log，Chrome 用 warning）
const SHADER_FATAL = /Shader Error|VALIDATE_STATUS false|shader is not compiled|Program Info Log|ERROR: 0:\d+/i;
const CONTEXT_LOST = /CONTEXT_LOST|Context Lost/;
const GL_WARNING = /GL_INVALID_|WebGL: INVALID_|GL ERROR/;

/** 报错里照实写出页面给的值：NaN / Infinity 照原样，没设置写 undefined，别的类型注明类型 */
export function show(v) {
  if (v === undefined) return 'undefined（没有设置）';
  if (v === null || typeof v === 'number') return String(v);
  try { return `${JSON.stringify(v) ?? String(v)}（${typeof v}）`; } catch { return `${String(v)}（${typeof v}）`; }
}

const quiet = { info() {}, warn() {}, error: m => console.error(m) };
const stderrLog = { info: m => console.error(m), warn: m => console.error(`[提示] ${m}`), error: m => console.error(m) };

/**
 * 打开 <dir>/index.html（dir 在仓库内）。
 * @param {string} dir
 * @param {object} [o]
 * @param {number} [o.w=1920] @param {number} [o.h=1040] @param {string} [o.query]
 * @param {boolean} [o.handleSignals=true]  false：不让 Playwright 接管 SIGINT/SIGTERM/SIGHUP（渲染脚本自己收尾）
 * @param {AbortSignal} [o.signal]          中止时停止等待、关掉浏览器并抛出 signal.reason
 * @param {object} [o.render]               注入 window.__RENDER：{ fps, profile, frameCount }（宽高取 w/h）
 * @param {string} [o.gpu]                  required | any | software-ok（默认 BEIMING_GPU，再默认 required）
 * @param {string} [o.angle]                ANGLE 后端（默认 BEIMING_ANGLE，再默认平台值）
 * @param {boolean} [o.allowNetwork]        放行外网请求（记进 external）；默认拦截并判失败
 * @param {boolean} [o.lenientAssets]       非脚本 / 文档类的本地 404 只记提示（默认判失败）
 * @param {boolean} [o.allowGlErrors]       着色器错误只记提示（调试用；默认判失败）
 * @param {boolean} [o.contract=true]       READY 后核对页面约定（DUR / render / FPS / TEXTS / 版本），不符退出码 4
 * @param {number} [o.readyTimeoutMs]       等 READY 的上限（毫秒）
 * @param {{info,warn,error}} [o.log]       日志（默认只打印错误到 stderr）
 * @param {{closer: Function}} [o.life]     收尾登记（lib/command.mjs 的 Lifecycle）：浏览器登记为异步关闭，收到信号时也会被关掉
 * @returns {Promise<{browser, page, gpu: string, info, contract, check, close, failed, warnings, requests, external, capture}>}
 *   check()   页面已经出过致命错误就抛出（每帧渲完调用一次）
 *   close()   关浏览器，最多等 10 秒；可重复调用
 *   failed    页面出致命错误时 reject 的 Promise，可与其它等待一起 race
 *   requests  Map<仓库相对路径, HTTP 状态>：页面从本地服务器加载过的文件（镜头缓存据此算依赖）
 */
export async function openFilm(dir, {
  w = 1920, h = 1040, query = '', handleSignals = true, signal, render = null,
  gpu, angle, allowNetwork = false, lenientAssets = false, allowGlErrors = false,
  contract = true, readyTimeoutMs: readyMs = readyTimeoutMs(), hintAfterMs = 15000, log = quiet, life = null,
} = {}) {
  const { rel } = locateFilm(dir);
  const { angle: ANGLE, source: angleSource } = resolveAngle(angle);
  const policy = resolveGpuPolicy(gpu);
  if (signal?.aborted) throw signal.reason;
  const srv = await serve();
  srv.allowRoot(path.resolve(dir));
  const origin = `http://127.0.0.1:${srv.port}`;
  const browser = await launchBrowser({ angle: ANGLE, handleSignals });
  let closing = null, unregister = () => {};
  const close = () => (closing ??= (unregister(), Promise.race([browser.close().catch(() => {}), sleep(10000)])));
  if (life) unregister = life.closer(close);
  let fatal = null, rejectFailed;
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {});
  const fail = e => { if (!fatal) { fatal = e; rejectFailed(e); } };
  const check = () => { if (fatal) throw fatal; };
  const warnings = [], seenWarn = new Set();
  const warn = (msg, code = 'page-warning') => { if (seenWarn.has(msg)) return; seenWarn.add(msg); warnings.push({ code, message: msg }); log.warn(msg, code); };
  const recent = [];   // 最近的问题，等 READY 太久时一起打印
  const note = s => { recent.push(s); if (recent.length > 8) recent.shift(); };
  const requests = new Map(), external = [], inflight = new Set();
  const localPath = url => { try { const u = new URL(url); return u.origin === origin ? decodeURIComponent(u.pathname).replace(/^\/+/, '') : null; } catch { return null; } };
  let phase = '打开页面';
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.addInitScript(faultWatch);
    await page.addInitScript(renderInfo, {
      fps: render?.fps ?? null, width: w, height: h, profile: render?.profile ?? null,
      frameCount: render?.frameCount ?? null, contract: CONTRACT_VERSION,
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      external.push(url);
      if (allowNetwork) { warn(`页面访问了外网：${url}（--allow-network 放行，已记进运行记录）`, 'network-allowed'); return route.continue(); }
      note(`[外网] ${url}`);
      fail(new RenderError('failure.network-blocked', `页面要访问外网：${url}`, {
        hint: '渲染必须离线可复现：把这个文件下载进作品目录（或 assets/），改成相对路径；确实要联网就加 --allow-network（会记进 run.json）',
      }));
      return route.abort('blockedbyclient');
    });
    page.on('pageerror', e => {
      const where = String(e.stack ?? '').split('\n').slice(1, 3).map(s => s.trim()).join(' ← ');
      note(`[页面错误] ${e.message}`);
      log.error(`[页面错误] ${e.message}${where ? `（${where}）` : ''}`);
      fail(new RenderError('failure.page-error', `页面错误：${e.message}${where ? `（${where}）` : ''}`, { hint: '页面脚本抛了未捕获的异常：按位置修好页面代码；用 node engine/render/still.mjs <目录> 0 单独复现' }));
    });
    page.on('crash', () => {
      note('[页面崩溃]');
      fail(new RenderError('failure.page-crash', '页面进程崩溃了（常见原因：显存或内存不够）', { hint: '减少 --workers、降低尺寸，或关掉占用 GPU 的其他任务后重跑' }));
    });
    page.on('console', m => {
      const type = m.type(), text = m.text();
      if (CONTEXT_LOST.test(text)) {
        note(`[页面] ${text.slice(0, 200)}`);
        return fail(new RenderError('failure.context-lost', `WebGL 上下文丢失：${text.slice(0, 160)}`, { hint: '显存不够、驱动重置（Windows TDR）或页面调用了 loseContext：减少 --workers 或尺寸，查共享 GPU 上的其他任务' }));
      }
      if (type === 'error' && SHADER_FATAL.test(text)) {
        note(`[页面] ${text.slice(0, 300)}`);
        log.error(`[页面] ${text.slice(0, 600)}`);
        const e = new RenderError('failure.shader-error', `着色器编译失败：${text.split('\n').find(l => /Shader Error|ERROR:|not compiled/.test(l))?.slice(0, 200) ?? text.slice(0, 200)}`, {
          hint: '按 stderr 里的着色器日志修好 GLSL；调试时可加 --allow-gl-errors 先出图看（不能交付）',
        });
        if (allowGlErrors) warn(`${e.message}（--allow-gl-errors 放行）`, 'shader-error-allowed'); else fail(e);
        return;
      }
      if (/^Failed to load resource/.test(text)) return;   // 由下面的 response / requestfailed 带 URL 报
      if (GL_WARNING.test(text)) { warn(`WebGL 警告：${text.slice(0, 200)}`, 'gl-warning'); return; }
      if (type === 'error') { note(`[页面] ${text.slice(0, 300)}`); log.error(`[页面] ${text.slice(0, 300)}`); }
    });
    page.on('request', r => { inflight.add(r); });
    page.on('requestfinished', r => { inflight.delete(r); });
    page.on('response', r => {
      const p = localPath(r.url());
      if (p === null) return;
      requests.set(p, r.status());
      if (r.status() < 400) return;
      const type = r.request().resourceType();
      const msg = `缺少文件 /${p}（${type}，HTTP ${r.status()}）`;
      note(`[页面] ${msg}`);
      if (lenientAssets && !['script', 'document', 'stylesheet'].includes(type)) { warn(`${msg}：--lenient-assets 放行（页面自己有回退）`, 'asset-missing-allowed'); return; }
      fail(new RenderError('failure.asset-missing', msg, {
        hint: r.status() === 404 ? `检查路径（页面里用相对路径或 /assets/… 这样的仓库绝对路径）；素材没下载就先准备素材；确属可选文件加 --lenient-assets`
          : r.status() === 403 ? '这个文件在允许的根外面（链接逃逸）或是点文件：把素材放进仓库或作品目录' : '静态服务器拒绝了这个请求',
      }));
    });
    page.on('requestfailed', r => {
      inflight.delete(r);
      const p = localPath(r.url());
      if (p === null) return;   // 外网请求由 route 处理
      const why = r.failure()?.errorText ?? '未知';
      if (why === 'net::ERR_ABORTED') return;   // 页面自己取消的（换了 src、媒体中止）
      note(`[页面] 请求失败 /${p}（${why}）`);
      fail(new RenderError('failure.asset-failed', `加载 /${p} 失败（${why}）`, { hint: '文件读不出来：检查权限、是否被占用，或磁盘是否出错' }));
    });

    const waits = signal ? [failed, abortion(signal)] : [failed];
    const url = `${origin}/${rel ? rel.split(path.sep).map(encodeURIComponent).join('/') + '/' : ''}index.html`;
    await Promise.race([page.goto(url + (query ? '?' + query : ''), { timeout: readyMs }), ...waits]);
    phase = `等页面就绪（window.READY，上限 ${readyMs / 1000} 秒）`;
    const t0 = Date.now();
    const hint = setTimeout(() => {
      const pending = [...inflight].map(r => r.url().replace(origin, '')).slice(0, 8);
      log.error(`[提示] 等 window.READY 已 ${((Date.now() - t0) / 1000).toFixed(0)} 秒：页面要在贴图、字体、着色器都就绪后置 window.READY = true。`
        + (recent.length ? `\n  目前看到的问题：\n    ${recent.join('\n    ')}` : '\n  控制台没有报错：检查页面是否执行到了置 READY 的那一行')
        + (pending.length ? `\n  还没回来的请求：${pending.join('、')}` : ''));
    }, Math.min(hintAfterMs, Math.max(1, readyMs - 1)));
    try {
      await Promise.race([page.waitForFunction(() => window.READY === true, null, { timeout: readyMs }), ...waits]);
    } catch (e) {
      if (e?.name === 'TimeoutError') {
        throw new RenderError('timeout.ready', `${phase}超时：${dir}/index.html 在 ${readyMs / 1000} 秒内没有置 window.READY = true`
          + (recent.length ? `；看到的问题：${recent.slice(-3).join('；')}` : ''), {
          hint: '页面卡在加载或初始化：先看上面的报错；重场景冷启动确实慢就调大 --ready-timeout（或 BEIMING_READY_TIMEOUT）',
        });
      }
      throw e;
    } finally { clearTimeout(hint); }
    check();
    phase = '读 GPU';
    const probe = await probeGpu(page);
    const { software, warnings: gpuWarn } = enforceGpu(probe, policy, { angle: ANGLE });
    for (const m of gpuWarn) warn(m, 'software-gl-allowed');
    const info = {
      angle: ANGLE, angleSource, policy, renderer: probe.renderer, vendor: probe.vendor, webgl2: probe.webgl2, software,
      browserVersion: browser.version(), executable: chromeExecutable() ?? 'chromium-headless-shell（Playwright 自带）', args: chromeArgs(ANGLE),
    };
    let pageContract = null;
    if (contract) { phase = '核对页面约定'; pageContract = await readContract(page, dir); }
    check();
    let cdp = null;
    /** 截一帧：png（CDP，optimizeForSpeed，与 Playwright PNG 像素一致）或 jpeg（Playwright，quality 默认 95） */
    const capture = async (format = 'png', quality = 95) => {
      if (format === 'png') {
        cdp ??= await page.context().newCDPSession(page);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true });
        return Buffer.from(data, 'base64');
      }
      return page.screenshot({ type: 'jpeg', quality });
    };
    return { browser, page, gpu: probe.renderer, info, contract: pageContract, check, close, failed, warnings, requests, external, capture, origin };
  } catch (e) {
    await close();
    if (e?.name === 'TimeoutError') throw new RenderError('timeout.page', `${phase}超时：${dir}/index.html`, { hint: '页面打开太慢：先看上面的报错；重场景冷启动确实慢就调大 --ready-timeout' });
    throw e;
  }
}

/** READY 之后读页面约定并核对；不符抛 RenderError（contract.*，退出码 4），信息里点名是哪一条 */
export async function readContract(page, dir = '') {
  const c = await page.evaluate(() => ({
    dur: window.DUR, fps: window.FPS, render: typeof window.render, texts: typeof window.TEXTS,
    version: window.BEIMING_CONTRACT, ev: Array.isArray(window.EV) ? window.EV.length : null, timeline: Boolean(window.TIMELINE),
  }));
  const bad = (code, message, hint) => new RenderError(code, `页面约定不符（${dir || '页面'}）：${message}`, { hint });
  if (c.version !== undefined && c.version !== null && c.version !== CONTRACT_VERSION) {
    throw bad('contract.version', `window.BEIMING_CONTRACT=${show(c.version)}，本渲染器只认页面约定 v${CONTRACT_VERSION}`, '去掉 BEIMING_CONTRACT 或改成 1；页面按新约定写的就换用对应版本的渲染器');
  }
  if (c.render !== 'function') throw bad('contract.render', `window.render 必须是函数，收到 ${c.render}`, '页面要设 window.render = t => { …把画面画到时刻 t… }');
  if (typeof c.dur !== 'number' || !Number.isFinite(c.dur) || c.dur <= 0) {
    throw bad('contract.dur', `window.DUR 必须是正数（秒），收到 ${show(c.dur)}`, '在置 READY 之前设 window.DUR = 片长秒数（帧数 ÷ 帧率）');
  }
  if (c.fps !== undefined && c.fps !== null && !(typeof c.fps === 'number' && Number.isFinite(c.fps) && c.fps > 0)) {
    throw bad('contract.fps', `window.FPS 必须是正数，收到 ${show(c.fps)}`, '不需要就别设 window.FPS（按 24）；设了就写成正数，例如 24、25、30');
  }
  if (c.texts !== 'undefined' && c.texts !== 'function') throw bad('contract.texts', `window.TEXTS 必须是函数，收到 ${c.texts}`, 'window.TEXTS = t => [{ text, box: [x, y, w, h], alpha, font }]');
  return { dur: c.dur, pageFps: c.fps ?? null, texts: c.texts === 'function', ev: c.ev, timeline: c.timeline, version: CONTRACT_VERSION };
}

/**
 * 渲一帧：window.render(t)（可返回 Promise），settle='raf2' 时再等两次 requestAnimationFrame（Vulkan 下显示层清屏提交），
 * 然后读上下文丢失计数；超时、抛错、上下文丢失都抛 RenderError。where 写进报错（"第 2 段第 37 帧（t=1.5417s）"）。
 */
export async function renderFrame(film, t, { timeoutMs = frameTimeoutMs(), settle = 'none', where = `t=${t}`, signal } = {}) {
  let timer;
  const stuck = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RenderError('timeout.frame', `${where}：render(t) 超过 ${timeoutMs / 1000} 秒没有返回`, {
      hint: '页面卡死（死循环、等永远不来的 Promise）：单独渲这一帧排查；重帧确实慢就调大 --frame-timeout（或 BEIMING_FRAME_TIMEOUT）',
    })), timeoutMs);
  });
  const waits = [stuck, film.failed];
  if (signal) waits.push(abortion(signal));
  let faults;
  try {
    faults = await Promise.race([film.page.evaluate(async ({ t, settle }) => {
      await window.render(t);
      if (settle === 'raf2') await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return window.__BEIMING_FAULTS ? window.__BEIMING_FAULTS.length : 0;
    }, { t, settle }), ...waits]);
  } catch (e) {
    if (e instanceof RenderError || signal?.aborted) throw signal?.aborted ? signal.reason : e;
    film.check();
    const msg = String(e?.message ?? e).replace(/^page\.evaluate:\s*/, '').split('\n')[0];
    throw new RenderError('failure.render-throw', `${where}render 出错：${msg}`, { hint: '页面的 render(t) 抛了异常：用 node engine/render/still.mjs <目录> --frame <帧号> 单独复现' });
  } finally { clearTimeout(timer); }
  if (faults > 0) {
    throw new RenderError('failure.context-lost', `${where}：WebGL 上下文丢失`, { hint: '显存不够、驱动重置（Windows TDR）或页面调用了 loseContext：减少 --workers 或尺寸，查共享 GPU 上的其他任务' });
  }
  film.check();
}

/** 最后一帧之后再查一次：上下文丢失事件是异步派发的，留一个任务的时间让它落地 */
export async function finalFaultCheck(film) {
  const n = await film.page.evaluate(() => new Promise(r => setTimeout(() => r(window.__BEIMING_FAULTS ? window.__BEIMING_FAULTS.length : 0), 0)));
  if (n > 0) throw new RenderError('failure.context-lost', 'WebGL 上下文丢失（最后一帧之后才报出来）', { hint: '减少 --workers 或尺寸，查共享 GPU 上的其他任务' });
  film.check();
}

export const frameTimeoutMs = () => {
  const s = Number(process.env.BEIMING_FRAME_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 60000;   // 默认 60 秒（审计 TOOLS-01）：4K 软件渲染的重帧也只要几秒，卡死要尽快判失败
};

export { stderrLog };
