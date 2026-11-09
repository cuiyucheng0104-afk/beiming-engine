#!/usr/bin/env node
// 北冥引擎 · 原生层 · 通用资产桥（Node 入口）：任何能在浏览器里用 engine 搭出来的 three.js 对象 → GLB（可带骨骼 / morph 动作），
// 导出后做二进制结构检查（validate.mjs）和 GLTFLoader 回读（动作采样、首尾一致），报告写成 JSON。
// 起一个只读的本地服务（随机回环端口，根目录 = 仓库根）和一个无头 Chromium（SwiftShader 软件 GL，只做资产转换，不占独显），
// 退出时都关掉。只允许写声明过的输出文件名。
//
// 用法
//   node engine/native/bridge/export.mjs <作品目录> [--only a.glb,b.glb] [--preview]
//        读 <作品目录>/film.json 的 native.models 里由代码生成的条目（有 module 或 recipe 的），写进 <作品目录>/media/
//   node engine/native/bridge/export.mjs --module <模块.js> --export <函数名> [--args '<JSON>'] [--length 米 | --scale 倍]
//        [--clip '{"name":"Idle","pose":"pose","duration":4,"fps":30}'] [--prefix 名] --out <输出.glb>
//        临时导出一个对象（模块路径相对当前目录，须在仓库内）
//
// models 条目（film.json，路径相对作品目录）
//   { "to": "ferry.glb", "module": "../../src/ferry.js", "export": "createFerry", "args": {…},
//     "length": 2 | "scale": 0.05,          最终长度（米，按返回值的 length 字段或包围盒最长边换算）或直接给缩放
//     "prefix": "ferry",                    未命名网格 / 材质的名字前缀（默认取对象名或文件名）
//     "names": { "lights": "ferry-light-" },  返回值里 { 键: Object3D } 字段的命名规则
//     "meta": { "forward": "+X", "up": "+Y" },  写进根节点 extras 的说明
//     "clip": { "name": "Idle", "pose": "pose", "duration": 4, "fps": 30, "loop": true },
//                                           逐帧调用返回值（或模块）上的 pose(t) 采样子节点 TRS 与 morph 权重
//     "validate": { "animated": true, "clip": "Idle", … },  见 validate.mjs
//     "report": "ferry-report.json", "sources": ["../../engine/form/props.js"] }   报告文件名、额外记录哈希的源文件
//   { "to": "kun.glb", "recipe": "tools/export-kun-browser.mjs", "lod": 0.5, … }
//        复杂生物（GPU 形变要换成骨骼、反照率烘焙）写配方：模块导出 build(ctx, asset) 与可选 verify(ctx, bytes, all)
//   { "to": "x.glb", "from": "path/to/x.glb" }   外部模型：由 prepare.mjs 复制并检查，这里跳过
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, relative, extname, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { validateGLB } from './validate.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };
const sha = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const inRepo = p => { const r = relative(ROOT, p); if (r.startsWith('..') || resolve(ROOT, r) !== p) throw new Error(`路径不在仓库内：${p}`); return r.split(sep).join('/'); };
export const isGenerated = m => Boolean(m.module || m.recipe);

// models：条目数组；baseDir：条目里相对路径的基准；outDir：输出目录
export async function exportModels(models, { baseDir, outDir, preview = false, log = console.log } = {}) {
  const assets = models.map(m => {
    const a = { ...m };
    for (const k of ['module', 'recipe']) if (m[k]) { const abs = resolve(baseDir, m[k]); a[k + 'Rel'] = inRepo(abs); a[k] = '/repo/' + a[k + 'Rel']; }
    if (basename(m.to) !== m.to || !/\.glb$/i.test(m.to)) throw new Error(`输出名只能是 media/ 下的 .glb 文件名：${m.to}`);
    return a;
  });
  if (!assets.length) return {};
  await mkdir(outDir, { recursive: true });
  const writes = new Set(assets.map(a => a.to));
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (req.method === 'POST' && path.startsWith('/output/')) {
        const name = path.slice('/output/'.length);
        if (!writes.has(name)) throw new Error('Output not allowed');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size >= 64_000_000) throw new Error('64 MB budget exceeded'); chunks.push(chunk); }
        await writeFile(resolve(outDir, name), Buffer.concat(chunks));
        res.end('ok'); return;
      }
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#121c2d}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/repo/node_modules/three/build/three.module.js","three/addons/":"/repo/node_modules/three/examples/jsm/"}}</script><script type="module">import {run} from '/repo/engine/native/bridge/browser.mjs';window.task=run(${JSON.stringify({ assets, preview })});</script>`);
        return;
      }
      if (!path.startsWith('/repo/')) { res.writeHead(404).end(); return; }
      const file = resolve(ROOT, path.slice('/repo/'.length));
      if (!file.startsWith(ROOT + sep)) throw new Error('Path not allowed');
      res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser, reports;
  try {
    log(`资产桥：${assets.map(a => a.to).join('、')}（临时回环端口 ${port}）`);
    browser = await chromium.launch({ headless: true, ...(process.env.BEIMING_CHROME ? { executablePath: process.env.BEIMING_CHROME } : {}), args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
    page.on('console', m => log(`[browser:${m.type()}] ${m.text()}`));
    page.on('pageerror', e => console.error(e));
    await page.goto(`http://127.0.0.1:${port}/`);
    reports = await page.evaluate(() => window.task);
    for (const a of assets) {
      const r = reports[a.to];
      r.sourceHashes = {};
      for (const p of [a.moduleRel || a.recipeRel, ...(a.sources || []).map(s => inRepo(resolve(baseDir, s)))].filter(Boolean)) r.sourceHashes[p] = await sha(resolve(ROOT, p));
      r.structuralValidation = await validateGLB(resolve(outDir, a.to), a.validate || {});
      r.sha256 = await sha(resolve(outDir, a.to));
      const reportName = a.report || a.to.replace(/\.glb$/i, '-report.json');
      await writeFile(resolve(outDir, reportName), JSON.stringify(r, null, 2) + '\n');
      log(JSON.stringify({ asset: a.to, bytes: (await stat(resolve(outDir, a.to))).size, sha256: r.sha256, triangles: r.structuralValidation.sceneTriangles, clips: r.structuralValidation.animations.map(({ name, duration, channels, paths, maxLoopError }) => ({ name, duration, channels, paths, maxLoopError })) }));
    }
    const shot = preview && assets.find(a => a.preview)?.preview;
    if (shot) await page.screenshot({ path: resolve(outDir, shot) });
  } finally {
    await browser?.close();
    await new Promise(r => server.close(r));
  }
  return reports;
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help') || !argv.length) {
    console.log(readFileSyncHead()); return;
  }
  if (opt('--module')) {
    const out = resolve(opt('--out') || 'out/model.glb');
    const m = { to: basename(out), module: opt('--module'), export: opt('--export'), args: opt('--args') ? JSON.parse(opt('--args')) : undefined, prefix: opt('--prefix') };
    if (opt('--length')) m.length = Number(opt('--length'));
    if (opt('--scale')) m.scale = Number(opt('--scale'));
    if (opt('--clip')) { m.clip = JSON.parse(opt('--clip')); m.validate = { animated: true, clip: m.clip.name || 'Idle', loop: m.clip.loop !== false }; }
    await exportModels([m], { baseDir: process.cwd(), outDir: dirname(out), preview: argv.includes('--preview') });
    return;
  }
  const dir = resolve(argv.find(a => !a.startsWith('--')));
  const film = JSON.parse(await readFile(resolve(dir, 'film.json'), 'utf8'));
  const only = opt('--only')?.split(',');
  const models = (film.native?.models || []).filter(isGenerated).filter(m => !only || only.includes(m.to));
  await exportModels(models, { baseDir: dir, outDir: resolve(dir, 'media'), preview: argv.includes('--preview') });
}
function readFileSyncHead() { return readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
