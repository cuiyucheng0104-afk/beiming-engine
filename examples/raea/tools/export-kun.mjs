#!/usr/bin/env node
// Rebuild with: node examples/raea/tools/export-kun.mjs [--lod=0.5] [--no-preview]
// Source repository is read-only; uses its existing three/playwright-core packages.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validateGLB } from './export-kun-validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const media = resolve(here, '../media');
const source = resolve(process.env.BEIMING_SOURCE || resolve(here, '../../..'));
const requireSource = createRequire(resolve(source, 'package.json'));
const { chromium } = requireSource('playwright-core');
const lod = Number(process.argv.find(x => x.startsWith('--lod='))?.slice(6) ?? 0.5);
if (!(lod >= 0.4 && lod <= 0.6)) throw new Error('LOD must be in [0.4, 0.6].');
const preview = !process.argv.includes('--no-preview');
await mkdir(media, { recursive: true });
const writes = new Set(['kun.glb', 'ferry.glb']);
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method === 'POST' && path.startsWith('/output/')) {
      const name = path.slice('/output/'.length);
      if (!writes.has(name)) throw new Error('Output not allowed');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size >= 20_000_000) throw new Error('20 MB budget exceeded'); chunks.push(chunk); }
      await writeFile(resolve(media, name), Buffer.concat(chunks));
      res.end('ok'); return;
    }
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#121c2d}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/deps/build/three.module.js","three/addons/":"/deps/examples/jsm/"}}</script><script type="module">import {run} from '/tools/export-kun-browser.mjs';window.task=run(${JSON.stringify({lod, preview})});</script>`);
      return;
    }
    const routes = [['/source/', source], ['/deps/', resolve(source, 'node_modules/three')], ['/tools/', here], ['/media/', media]];
    const route = routes.find(([prefix]) => path.startsWith(prefix));
    if (!route) { res.writeHead(404).end(); return; }
    const [prefix, root] = route;
    const relative = path.slice(prefix.length), file = resolve(root, relative);
    if (!file.startsWith(root + sep) || (prefix === '/tools/' && !relative.startsWith('export')) || (prefix === '/media/' && !writes.has(relative))) throw new Error('Path not allowed');
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
if (port === 5090) { server.close(); throw new Error('Reserved port 5090 was selected; rerun.'); }
let browser;
try {
  console.log(`Exporting LOD ${lod}, temporary loopback port ${port}`);
  browser = await chromium.launch({ headless: true, ...(process.env.BEIMING_CHROME ? { executablePath: process.env.BEIMING_CHROME } : {}), args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
  page.on('console', m => console.log(`[browser:${m.type()}] ${m.text()}`));
  page.on('pageerror', e => console.error(e));
  await page.goto(`http://127.0.0.1:${port}/`);
  const report = await page.evaluate(() => window.task);
  report.sourceHashes = {};
  for (const name of ['src/kun.js','src/ferry.js','engine/form/bend.js']) report.sourceHashes[name] = createHash('sha256').update(await readFile(resolve(source,name))).digest('hex');
  report.structuralValidation = await validateGLB(resolve(media, 'kun.glb'), { animated: true });
  report.ferry.structuralValidation = await validateGLB(resolve(media, 'ferry.glb'), { animated: false });
  if (preview) await page.screenshot({ path: resolve(media, 'kun-preview.png') });
  await writeFile(resolve(media, 'kun-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ kunBytes: (await stat(resolve(media, 'kun.glb'))).size, triangles: report.structuralValidation.sceneTriangles, clip: report.structuralValidation.animations.map(({name,duration,channels,paths,maxLoopError})=>({name,duration,channels,paths,maxLoopError})), ferry: {bytes:report.ferry.bytes,boundsXYZ:report.ferry.boundsXYZ,triangles:report.ferry.structuralValidation.sceneTriangles,emissiveMeshes:report.ferry.emissiveMeshes}, verification: report.roundTrip }, null, 2));
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}
