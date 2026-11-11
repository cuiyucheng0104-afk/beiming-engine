// tests/engine 的浏览器夹具（不是测试文件，供 *.test.mjs 引用）：只读静态服务器（仓库根 + 内存里的测试页）+ 无头 Chrome。
// 与 engine/render/page.mjs 同一套 BEIMING_ANGLE / BEIMING_CHROME；没装 playwright-core 或 headless shell（npm run setup）时
// open() 返回 { skip: 原因 }，测试自己 t.skip，不算失败。
//
//   const B = await open()                       → { skip } 或 { soft, gpu, page(name, html, o), close() }
//     soft                                       WebGL 是软件渲染（SwiftShader / llvmpipe）：测试按它缩小尺寸、放宽时限
//     page(name, html, { w, h, init, timeout })  打开一张内存里的测试页，返回 { page, errors, result(), close() }
//       init       在页面任何脚本之前写进 window 的字段（例如 { __RENDER: { fps, width, height, profile } }，模拟渲染器注入）
//       timeout    等 window.RESULT / READY 的上限（毫秒，默认 120000；软件渲染下 ×3）
//       errors     页面报错（pageerror：未捕获的异常与未处理的 Promise 拒绝）逐条记下
//       result(cond = 'RESULT')  等 window[cond] 出现（或页面报错）后返回它的值；页面报错时抛出带报错原文的 Error
//   HEAD / TAIL                                 测试页的固定头尾（importmap 指向仓库的 three；模块脚本写在两者之间）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };

export const HEAD = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body style="margin:0;background:#000"><script type="module">
`;
export const TAIL = `
</script></body></html>`;

export async function open() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return { skip: '没有 playwright-core（npm ci）' }; }
  const pages = new Map();
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || ''), port = server.address().port;
    if (host !== `127.0.0.1:${port}`) { res.writeHead(421); return res.end(); }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.startsWith('/__p13__/')) {
      const body = pages.get(rel.slice(9));
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body || '');
    }
    if (rel.split('/').some(s => s.startsWith('.') && s !== '.' && s !== '..')) { res.writeHead(403); return res.end(); }
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.BEIMING_CHROME || undefined,
      args: [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb'],
    });
  } catch (e) {
    server.close();
    return { skip: '无头 Chrome 起不来（先 npm run setup）：' + String(e.message).split('\n')[0] };
  }
  const probe = await browser.newPage();
  const gpu = await probe.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2'), e = g && g.getExtension('WEBGL_debug_renderer_info');
    return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
  });
  await probe.close();
  const soft = /swiftshader|llvmpipe|softpipe|software/i.test(gpu);

  async function page(name, html, { w = 320, h = 180, init = null, timeout = 120000 } = {}) {
    pages.set(name, html);
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const errors = [];
    p.on('pageerror', e => errors.push(String(e.message || e)));
    if (init) await p.addInitScript(o => { Object.assign(window, o); }, init);
    const limit = soft ? timeout * 3 : timeout;
    // 页面模块用顶层 await 跑完整段测试，load 事件可能很晚才到：导航只等提交，实际时限交给下面的等待
    await p.goto(`${origin}/__p13__/${name}`, { waitUntil: 'commit', timeout: limit });
    async function result(cond = 'RESULT') {
      const t0 = Date.now();
      for (;;) {
        if (errors.length) throw new Error(`页面报错：${errors[0]}`);
        const v = await p.evaluate(k => (window[k] === undefined ? { pending: true } : { value: window[k] }), cond);
        if (!v.pending) return v.value;
        if (Date.now() - t0 > limit) throw new Error(`等了 ${Math.round(limit / 1000)} 秒，window.${cond} 一直没出现`);
        await new Promise(r => setTimeout(r, 25));
      }
    }
    return { page: p, errors, result, close: () => p.close().catch(() => {}) };
  }

  return { soft, gpu, page, origin, close: async () => { await browser.close().catch(() => {}); server.close(); } };
}
