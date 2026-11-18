// 对拍的参考侧：在无头 Chrome（页面渲染器同一个浏览器、同一份启动参数）里跑仓库现有的 WebGL / GLSL 实现，把结果读回成 RGBA8（行序自下而上，
// 与 DataTexture 数据行序一致）。用法：const ref = await startReference(); const px = await ref.render(页面脚本, 参数); await ref.close();
// 页面脚本是模块脚本的正文，import 用 '/engine/…' 这样的仓库根路径（同源，来自 engine/render/lib/server.mjs）和 importmap 里的 'three'（仓库的 r170）；
// 脚本要把结果写进 window.RESULT = { b64: 读回像素的 base64 }，出错写 { error }。没装浏览器抛 CliError('env.browser')，调用方据此跳过。
import { chromium } from 'playwright-core';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../engine/render/lib/server.mjs';
import { chromeArgs, chromeExecutable, defaultAngle } from '../../engine/render/lib/gpu.mjs';
import { CliError } from '../../tools/lib/cli.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = body => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script>
window.addEventListener('error', e => { window.RESULT ??= { error: String(e.message || e) }; });
window.addEventListener('unhandledrejection', e => { window.RESULT ??= { error: String((e.reason && e.reason.stack) || e.reason) }; });
</script></head><body style="margin:0"><script type="module">
${body}
</script></body></html>`;

export async function startReference() {
  const srv = createServer({ root: ROOT });
  const { url } = await srv.listen(0);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable(), args: chromeArgs(defaultAngle()) });
  } catch (e) {
    await srv.close();
    throw new CliError('env.browser', `无头浏览器起不来：${String(e?.message ?? e).split('\n')[0]}`, { hint: 'npm run setup' });
  }
  return {
    async render(body, args = {}, { timeout = 60000 } = {}) {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
      try {
        await page.route('**/__ref__.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE(body) }));
        await page.addInitScript(a => { window.__ARGS = a; }, args);
        await page.goto(`${url}__ref__.html`, { waitUntil: 'commit', timeout });
        await page.waitForFunction(() => window.RESULT !== undefined, null, { timeout });
        const r = await page.evaluate(() => window.RESULT);
        if (r.error) throw new Error(`参考页出错：${r.error}`);
        return new Uint8Array(Buffer.from(r.b64, 'base64'));
      } finally { await page.close(); }
    },
    async close() { await browser.close().catch(() => {}); await srv.close(); },
  };
}

/** 页面里把读回的像素编成 base64 的片段（分块，避免大数组展开爆栈） */
export const PAGE_B64 = `const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s); };`;
