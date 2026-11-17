// 晨渡 · A 路线页面（无头 Chrome，WebGL，GLSL）对离屏出片（Node + Dawn，TSL）逐帧对拍：同一个 story.js、同一份世界与镜头、同一组后期预设。
// 参考侧打开作品真正的页面（index.html?msaa=0），注入渲染器的 __RENDER，render(t) 后无损截图（含浏览器合成的显示层，同出片链截到的画面）；
// 离屏侧 msaa 0（两边多重采样的采样位置与解析不保证相同，逐帧对拍不带它）。每帧过 M1 质量门（engine/offscreen/diff.mjs）。
//   node films/chendu/tools/compare.mjs [--frames 0,40,71,72,90,96,120,150,191] [--size 960x540] [--out <目录>] [--query animatic=1]
// 退出码：0 全部通过 · 4 有帧不过 · 3 缺 GPU 或浏览器。
import { mkdirSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { createServer } from '../../../engine/render/lib/server.mjs';
import { chromeArgs, chromeExecutable, defaultAngle } from '../../../engine/render/lib/gpu.mjs';
import { loadGpu } from '../../../engine/offscreen/load.mjs';
import { createHost } from '../../../engine/offscreen/host.mjs';
import { diffRgba, meetsGate } from '../../../engine/offscreen/diff.mjs';
import { decodePng, encodePng } from '../../../tools/plates/png.mjs';

const { values: a } = parseArgs({ options: { frames: { type: 'string', default: '0,40,71,72,90,96,120,150,191' }, size: { type: 'string', default: '960x540' }, out: { type: 'string' }, query: { type: 'string', default: '' } } });
const frames = a.frames.split(',').map(Number), [W, H] = a.size.split('x').map(Number), FPS = 24;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)), WORK = fileURLToPath(new URL('../offscreen.mjs', import.meta.url));
const extra = Object.fromEntries(new URLSearchParams(a.query));
const opaque = px => { const o = Uint8Array.from(px); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

let host, browser, srv;
try {
  const gpu = await loadGpu();
  globalThis.__CHENDU = { msaa: 0, animatic: 'animatic' in extra, notext: 'notext' in extra, lookdev: extra.lookdev ? JSON.parse(extra.lookdev) : null };
  host = await createHost({ gpu, width: W, height: H, fps: FPS });
  srv = createServer({ root: ROOT });
  browser = await chromium.launch({ executablePath: chromeExecutable(), args: chromeArgs(defaultAngle()) });
} catch (e) {
  if (String(e.code).startsWith('env.')) { console.error(`对拍不可用：${e.message}`); process.exit(3); }
  throw e;
}
let bad = 0;
try {
  const { url } = await srv.listen(0);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(r => { window.__RENDER = r; }, { fps: FPS, width: W, height: H, profile: null, frameCount: null, contract: 1 });
  page.on('pageerror', e => console.error('页面出错：', e.message));
  await page.goto(`${url}films/chendu/index.html?${new URLSearchParams({ msaa: '0', ...extra })}`);
  await page.waitForFunction(() => window.READY === true, null, { timeout: 180000 });
  const work = await host.load(WORK);
  if (a.out) mkdirSync(a.out, { recursive: true });
  for (const f of frames) {
    await page.evaluate(t => window.render(t), f / FPS);
    const g = opaque(decodePng(await page.screenshot({ type: 'png' })).data);
    const t = opaque(await host.renderFrame(work, f));
    const d = diffRgba(t, g, { width: W, height: H }), gate = meetsGate(d);
    if (!gate.ok) bad++;
    console.log(`帧 ${String(f).padStart(3)}  PSNR ${d.psnr.toFixed(2)} dB  最大差 ${d.maxDelta}  大差像素 ${d.bigPixels}（${(100 * d.bigPixels / d.pixels).toFixed(3)}%）  ${gate.ok ? '通过' : `不过：${gate.reasons.join('；')}`}`);
    if (a.out) for (const [k, px] of [['page', g], ['offscreen', t]]) writeFileSync(`${a.out}/${k}-${f}.png`, encodePng({ width: W, height: H, data: px }));
  }
} finally { host.dispose(); await browser.close().catch(() => {}); await srv.close(); }
process.exit(bad ? 4 : 0);
