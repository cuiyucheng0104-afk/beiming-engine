// 舞台测试工具（无头 Chromium + GPU）：截图、测帧率。只在开发时用，构建器不会复制 dev/。
// 先从仓库根起服务：python3 -m http.server 8101 --bind 127.0.0.1
//
//   node site/dev/stage/probe.mjs shot  [--size 1440x900] [--dpr 2] [--q "scene=hero&layer=4"] [--t 0] [--wait 1500] [--out 名字]
//        截图到 out/dev-stage/shots/<名字>.png（--t 给了就定格到该时刻再截；不给就等 --wait 毫秒截实时画面）
//   node site/dev/stage/probe.mjs bench [--size 1440x900] [--dpr 2] [--q "..."] [--secs 12]
//        跑实时循环，记录 rAF 帧间隔与 onStats，打印中位帧率、降档记录
// GPU：Mac 上默认 --use-angle=metal（BEIMING_ANGLE 可改），同 engine/render/page.mjs。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'out/dev-stage');
const BASE = process.env.STAGE_BASE || 'http://127.0.0.1:8101/site/dev/stage/index.html';

export function chromeArgs() {
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  return [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--font-render-hinting=none'];
}

export function arg(args, name, def) { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; }

export async function openStage({ w = 1440, h = 900, dpr = 1, query = '', reduced = false, log = true, cold = false, mobile = false } = {}) {
  // cold：关掉 GPU 着色器磁盘缓存，模拟第一次来的访客（着色器 / 管线全部现编）
  const browser = await chromium.launch({ args: [...chromeArgs(), ...(cold ? ['--disable-gpu-shader-disk-cache'] : [])] });
  // mobile：模拟手机（触屏、粗指针、手机 UA），舞台会按手机档位选像素比与 lod
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference',
    ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('[页面错误]', e.message); });
  page.on('console', m => { if (log && (m.type() === 'error' || m.type() === 'warning')) console.error(`[页面 ${m.type()}]`, m.text().slice(0, 400)); if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) { errors.push(`${r.status()} ${r.url()}`); console.error('[缺文件]', r.status(), r.url()); } });
  // 记录主线程长任务（> 50 ms），看建鲲 / 编译 / 首帧有没有卡住页面
  await page.addInitScript(() => {
    window.__long = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
    // 页面自己的 rAF 间隔（前 8 秒）：看预热期间整页动画会不会卡
    window.__raf = []; let last = performance.now();
    (function tick(now) { window.__raf.push(Math.round(now - last)); last = now; if (now < 8000) requestAnimationFrame(tick); })(last);
  });
  const t0 = Date.now();
  await page.goto(`${BASE}?ui=0&${query}`);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
  const wall = Date.now() - t0;
  return { browser, page, errors, wall };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const [w, h] = (arg(args, 'size', '1440x900')).split('x').map(Number);
  const dpr = +arg(args, 'dpr', '1');
  const query = arg(args, 'q', '');
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const { browser, page, errors, wall } = await openStage({ w, h, dpr, query, reduced: args.includes('--reduced'), cold: args.includes('--cold'), mobile: args.includes('--mobile') });
  const ready = await page.evaluate(() => window.__ready);
  const info = ready === true ? await page.evaluate(() => window.__stage.debug.info) : null;
  if (ready === true) await page.evaluate(() => window.__stage.firstFrame);
  const info2 = ready === true ? await page.evaluate(() => window.__stage.debug.info) : null;
  const longTasks = await page.evaluate(() => window.__long);
  const gaps = await page.evaluate(() => { const r = window.__raf.slice(1); return { max: Math.max(...r), over100: r.filter(x => x > 100).length, over50: r.filter(x => x > 50).length, n: r.length }; });
  console.log(JSON.stringify({ ready, wallMs: wall, longTasks, rafGaps: gaps, info: args.includes('--brief') && info2 ? { buildMs: info2.buildMs, compileMs: info2.compileMs, warmMs: info2.warmMs, warmSteps: info2.warmSteps, firstFrameMs: info2.firstFrameMs, triangles: info2.triangles, pr: info2.pr, db: info2.drawingBuffer } : info2 }));

  if (cmd === 'shot') {
    const t = arg(args, 't', null);
    if (t !== null && ready === true) {
      await page.evaluate(() => window.__stage.pause());
      await page.waitForTimeout(800);                    // 测试页的画布有 0.6 秒淡入
      const ptr = arg(args, 'pointer', null);
      const ms = await page.evaluate(([tt, p]) => window.__stage.debug.renderAt(tt, p ? { pointer: p } : {}), [+t, ptr ? ptr.split(',').map(Number) : null]);
      console.log(`定格 t=${t}，渲染 ${ms.toFixed(1)} ms`);
    } else await page.waitForTimeout(+arg(args, 'wait', '1500'));
    const name = arg(args, 'out', `shot-${Date.now()}`);
    const file = path.join(OUT, 'shots', name + '.png');
    await page.screenshot({ path: file });
    console.log('截图', path.relative(ROOT, file));
  }

  if (cmd === 'bench') {
    const secs = +arg(args, 'secs', '12');
    const res = await page.evaluate(async secs => {
      const iv = []; let last = performance.now();
      await new Promise(done => {
        const end = last + secs * 1000;
        (function tick(now) { iv.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else done(); })(last);
      });
      return { iv: iv.slice(1), stats: window.__statsLog.slice(), info: window.__stage.debug.info };
    }, secs);
    const iv = res.iv.slice().sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)], p95 = iv[Math.floor(iv.length * 0.95)];
    const fpsList = res.stats.map(s => s.fps);
    const fpsSorted = fpsList.slice().sort((a, b) => a - b);
    console.log(JSON.stringify({
      frames: res.iv.length, medianFrameMs: +med.toFixed(2), medianFps: +(1000 / med).toFixed(1), p95FrameMs: +p95.toFixed(2),
      statsFps: fpsList, statsMedianFps: fpsSorted[Math.floor(fpsSorted.length / 2)],
      pixelRatios: [...new Set(res.stats.map(s => s.pixelRatio))], last: res.stats.at(-1), info: res.info,
    }, null, 1));
  }
  if (errors.length) console.log('页面错误 / 缺文件：', errors.length);
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
