// 页面宿主（node 一侧）：起本机静态服务和无头、静音的浏览器，把片子描述交给页面里的运行时，
// 再把读回的各层、元数据和预览图落盘。页面一侧在 runtime.js。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../../engine/render/lib/gpu.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// 页面只拿得到这两处：本系统的代码，和 0.187.0 的 three
const SERVED = ['beiming/', 'node_modules/three-webgpu/build/'];
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{ "imports": { "three": "/node_modules/three-webgpu/build/three.module.js" } }</script>
<script type="module">
import { createHost } from '/beiming/host/page/runtime.js';
window.__createHost = createHost;
</script>`;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 地址里的路径换成仓库里的文件；不在放行目录里、或者想跳出去的，返回 null */
export function resolveServed(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, ''); } catch { return null; }
  const abs = resolve(REPO, rel);
  const back = relative(REPO, abs).split(sep).join('/');
  return SERVED.some((dir) => back.startsWith(dir)) && MIME[extname(abs)] ? abs : null;
}

async function startServer() {
  const server = createServer(async (req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const file = resolveServed(req.url);
    const body = file && await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(file)], 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

/** 把一次成功的 render 落盘：各层是小端的原始数组（<通道名>.<类型>），加 meta.json 和 preview.png。返回每个文件的哈希和大小 */
export async function writeFrame(dir, result) {
  await mkdir(dir, { recursive: true });
  const files = {};
  const put = async (name, bytes, more = {}) => {
    await writeFile(join(dir, name), bytes);
    files[name] = { sha256: sha256(bytes), bytes: bytes.length, ...more };
  };
  for (const [name, l] of Object.entries(result.layers)) {
    await put(`${name}.${l.type}`, Buffer.from(l.base64, 'base64'), { layer: name, type: l.type, components: l.components, size: l.size });
  }
  if (result.png) await put('preview.png', Buffer.from(result.png, 'base64'));
  await put('meta.json', Buffer.from(`${JSON.stringify(result.meta, null, 2)}\n`));
  return files;
}

/**
 * 起一个新浏览器，装载 filmPath 这份片子描述里的 shotId。
 * 返回的对象的方法就是页面运行时的方法（caps、openSession、render、evaluate……），都是异步的；用完调 close()。
 */
export async function openHost({ filmPath, shotId, tier }) {
  const film = JSON.parse(await readFile(filmPath, 'utf8'));
  const filmDir = relative(REPO, dirname(resolve(filmPath))).split(sep).join('/');
  const server = await startServer();
  // 浏览器起不来时要把刚起的本地服务关掉，不然进程退不出去
  const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable(), args: [...chromeArgs(), '--mute-audio'] })
    .catch(async (e) => { await server.close(); throw e; });
  const close = async () => { await browser.close(); await server.close(); };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.origin}/`);
    await page.waitForFunction(() => window.__createHost, null, { timeout: 30000 }).catch(() => { throw new Error(`页面运行时没装起来：${errors.join('；') || '超时'}`); });
    await page.evaluate((cfg) => { window.__host = window.__createHost(cfg); }, { film, shotId, tier, filmBase: `${server.origin}/${filmDir}/` });
    const call = (method) => (...args) => page.evaluate(([m, a]) => window.__host[m](...a), [method, args]);
    const host = { close };
    for (const m of ['caps', 'openSession', 'closeSession', 'manifest', 'render', 'query', 'evaluate', 'rngProbe', 'observations']) host[m] = call(m);
    return host;
  } catch (e) {
    await close();
    throw e;
  }
}
