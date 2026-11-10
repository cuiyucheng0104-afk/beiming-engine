// 北冥引擎 · 本地静态服务器（渲染器与 npm run serve 共用）：影片页面要经 http 才能加载 ES 模块与贴图。
// 只监听 127.0.0.1；只回答 GET / HEAD；Host 必须是 127.0.0.1 或 localhost 加本端口（挡 DNS 重绑定）；
// 路径里任何一段以 . 开头（.git、.env、.claude、.segs-*）一律 404；先按词法、再按真实路径判断是否在允许的根里：
// 仓库根、仓库的 node_modules（工作树里常是指向别处的链接，importmap 要用）、以及调用方登记的影片目录真实路径
// （仓库里的影片目录本身可以是指向仓库外的链接）。其余真实路径落在外面的（链接逃逸）返回 403。
// 不列目录；目录请求返回其中的 index.html（没有就 404）；/favicon.ico 不存在时回 204（免得每页一条 404 噪声）。
// 支持单段 Range（预览 mp4 时浏览器拖动要用）；一律 Cache-Control: no-store。
//
//   createServer({ root, allow })            → { listen(port?) → Promise<{ port, url }>, close(), allowRoot(dir), onRequest(fn) }
//   resolveRequest(root, url, allowed)       → { status } | { file, rel }（导出给测试）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
};

const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (child, parent) => {
  const r = path.relative(parent, child);
  return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
};

/**
 * URL → 文件。root 须是真实路径；allowed 是允许的真实路径根（含 root）。
 * @returns {{ status: number } | { file: string, rel: string }}
 */
export function resolveRequest(root, url, allowed = [root]) {
  let p;
  try { p = decodeURIComponent(String(url).split('?')[0].split('#')[0]); } catch { return { status: 400 }; }
  if (p.includes('\0') || p.includes('\\')) return { status: 400 };
  const segs = p.split('/').filter(Boolean);
  if (segs.some(s => s === '..')) return { status: 403 };
  if (segs.some(s => s.startsWith('.'))) return { status: 404 };
  const file = path.resolve(root, ...segs);
  if (!within(file, root)) return { status: 403 };
  const r = real(file);
  if (r === null) return { status: 404, file, rel: segs.join('/') };
  if (!allowed.some(a => within(r, a))) return { status: 403 };
  return { file: r, rel: segs.join('/') };
}

export function createServer({ root, allow = [] } = {}) {
  const ROOT = real(root);
  if (!ROOT) throw new Error(`服务根不存在：${root}`);
  const allowed = new Set([ROOT, ...[path.join(ROOT, 'node_modules'), ...allow].map(real).filter(Boolean)]);
  const listeners = new Set();
  let port = 0;
  const server = http.createServer((req, res) => {
    const done = (status, headers = {}, body) => {
      res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(body);
      for (const fn of listeners) { try { fn({ method: req.method, url: req.url, status }); } catch {} }
    };
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return done(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Host 不对：只服务 127.0.0.1');
    if (req.method !== 'GET' && req.method !== 'HEAD') return done(405, { Allow: 'GET, HEAD' });
    let x = resolveRequest(ROOT, req.url, [...allowed]);
    if (x.status === 404 && x.rel === 'favicon.ico') return done(204);
    if (x.status) return done(x.status);
    let st;
    try { st = fs.statSync(x.file); } catch { return done(404); }
    if (st.isDirectory()) {
      const idx = path.join(x.file, 'index.html');
      try { st = fs.statSync(idx); x = { file: idx, rel: x.rel + '/index.html' }; } catch { return done(404); }
    }
    if (!st.isFile()) return done(404);
    const type = MIME[path.extname(x.file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0, end = st.size - 1, status = 200;
    if (range && (range[1] !== '' || range[2] !== '')) {
      if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); } else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
      if (start > end || start >= st.size) return done(416, { 'Content-Range': `bytes */${st.size}` });
      status = 206;
    }
    const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    for (const fn of listeners) { try { fn({ method: req.method, url: req.url, status, file: x.file }); } catch {} }
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const s = fs.createReadStream(x.file, { start, end });
    s.on('error', () => res.destroy());
    s.pipe(res);
  });
  return {
    root: ROOT,
    allowRoot(dir) { const r = real(dir); if (r) allowed.add(r); },
    onRequest(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    listen(p = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => {
          port = server.address().port;
          resolve({ port, url: `http://127.0.0.1:${port}/` });
        });
      });
    },
    get port() { return port; },
    close() { return new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }); },
  };
}
