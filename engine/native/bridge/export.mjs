#!/usr/bin/env node
// 北冥引擎 · 原生层 · 通用资产桥（Node 入口）：任何能在浏览器里用 engine 搭出来的 three.js 对象 → GLB（可带骨骼 / morph 动作），
// 导出后做二进制结构检查（validate.mjs）和 GLTFLoader 回读（动作采样、首尾一致），报告写成 JSON。
// 起一个只读的本地服务（随机回环端口，根目录 = 仓库根）和一个无头 Chromium（SwiftShader 软件 GL，只做资产转换，不占独显），
// 退出、出错、超时、收到信号时都关掉。只允许写声明过的输出文件名。
//
// 写入顺序（防止不合格资产留在正式路径）：浏览器 POST 的字节先落到 media/<名>.part → 浏览器端回读断言通过 →
// Node 端结构检查通过 → 才换名成 media/<名>；任何一步失败都删掉 .part，正式路径上的旧文件不动。
// 报告里的 sourceHashes 记录本次导出**实际被浏览器请求过**的每一个仓库文件（含传递依赖与导出脚本自身），
// runtime 记录 three 版本、Playwright 与 Chromium 版本和实际参数，不写死。
//
// 用法
//   node engine/native/bridge/export.mjs <作品目录> [--only a.glb,b.glb] [--preview] [--json]
//        读 <作品目录>/film.json 的 native.models 里由代码生成的条目（有 module 或 recipe 的），写进 <作品目录>/media/
//   node engine/native/bridge/export.mjs --module <模块.js> --export <函数名> [--args '<JSON>'] [--length 米 | --scale 倍]
//        [--clip '{"name":"Idle","pose":"pose","duration":4,"fps":30}'] [--prefix 名] --out <输出.glb>
//        临时导出一个对象（模块路径相对当前目录，须在仓库内）
//   退出码：0 · 1 导出 / 回读失败 · 2 用法 · 3 缺浏览器或依赖 · 4 结构检查不通过 · 124 超时（BNE_BRIDGE_TIMEOUT 秒，默认 900）
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
//     "report": "ferry-report.json" }       报告文件名
//   { "to": "kun.glb", "recipe": "tools/export-kun-browser.mjs", "lod": 0.5, … }
//        复杂生物（GPU 形变要换成骨骼、反照率烘焙）写配方：模块导出 build(ctx, asset) 与可选 verify(ctx, bytes, all)
//   { "to": "x.glb", "from": "path/to/x.glb" }   外部模型：由 prepare.mjs 复制并检查，这里跳过
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, extname, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CliError, EXIT, exitWith, isMain, log, onCleanup, offCleanup, runCli } from '../cli.mjs';
import { validateGLB } from './validate.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };
const sha = buf => createHash('sha256').update(buf).digest('hex');
const inRepo = p => { const r = relative(ROOT, p); if (r.startsWith('..') || resolve(ROOT, r) !== p) throw new CliError(EXIT.USAGE, 'path', `路径不在仓库内：${p}`, '资产桥只服务仓库里的文件；把模块放进仓库（作品目录或 engine/）'); return r.split(sep).join('/'); };
export const isGenerated = m => Boolean(m.module || m.recipe);

// models：条目数组；baseDir：条目里相对路径的基准；outDir：输出目录
export async function exportModels(models, { baseDir, outDir, preview = false, log: say = log, timeoutMs = 900000 } = {}) {
  const assets = models.map(m => {
    const a = { ...m };
    for (const k of ['module', 'recipe']) if (m[k]) { const abs = resolve(baseDir, m[k]); a[k + 'Rel'] = inRepo(abs); a[k] = '/repo/' + a[k + 'Rel']; }
    if (basename(m.to) !== m.to || !/\.glb$/i.test(m.to)) throw new CliError(EXIT.CONTRACT, 'asset-name', `输出名只能是 media/ 下的 .glb 文件名：${m.to}`);
    return a;
  });
  if (!assets.length) return {};
  await mkdir(outDir, { recursive: true });
  const writes = new Set(assets.map(a => a.to));
  const served = new Map();                 // 浏览器实际请求过的仓库文件 → sha256（报告的依赖记录）
  const part = n => resolve(outDir, `${n}.part`);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (req.method === 'POST' && path.startsWith('/output/')) {
        const n = path.slice('/output/'.length);
        if (!writes.has(n)) throw new Error('Output not allowed');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size >= 64_000_000) throw new Error('64 MB budget exceeded'); chunks.push(chunk); }
        await writeFile(part(n), Buffer.concat(chunks));
        res.end('ok'); return;
      }
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        // 模块图任何一处 import 失败都让 window.task 以真实原因 reject，而不是留下 undefined
        res.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#121c2d}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/repo/node_modules/three/build/three.module.js","three/addons/":"/repo/node_modules/three/examples/jsm/"}}</script><script type="module">window.task=import('/repo/engine/native/bridge/browser.mjs').then(m=>m.run(${JSON.stringify({ assets, preview })}));window.task.catch(()=>{});</script>`);
        return;
      }
      if (!path.startsWith('/repo/')) { res.writeHead(404).end(); return; }
      const file = resolve(ROOT, path.slice('/repo/'.length));
      if (!file.startsWith(ROOT + sep)) throw new Error('Path not allowed');
      const body = await readFile(file);
      served.set(relative(ROOT, file).split(sep).join('/'), sha(body));
      res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500).end(String(error)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let browser, reports, done = false;
  const pageErrors = [];
  const shutdown = onCleanup(async () => {
    await browser?.close().catch(() => {});
    await new Promise(r => server.close(r));
    if (!done) for (const a of assets) await rm(part(a.to), { force: true });
  });
  try {
    say(`资产桥：${assets.map(a => a.to).join('、')}（临时回环端口 ${port}）`);
    let chromium;
    try { ({ chromium } = await import('playwright-core')); } catch { throw new CliError(EXIT.ENV, 'deps', '缺 playwright-core', '在仓库根运行 npm ci（或 npm run setup）'); }
    try {
      browser = await chromium.launch({ headless: true, ...(process.env.BEIMING_CHROME ? { executablePath: process.env.BEIMING_CHROME } : {}), args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    } catch (e) { throw new CliError(EXIT.ENV, 'browser', `无头 Chromium 启动失败：${e.message.split('\n')[0]}`, '在仓库根运行 npm run setup 安装锁定版本的 headless shell，或用 BEIMING_CHROME 指定'); }
    const page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
    page.on('console', m => { if (m.type() !== 'warning' || !/GPU stall due to ReadPixels|non-normalized/.test(m.text())) say(`[browser:${m.type()}] ${m.text()}`); });
    page.on('pageerror', e => { pageErrors.push(e.message); say(`[browser:pageerror] ${e.message}`); });
    await page.goto(`http://127.0.0.1:${port}/`);
    const timer = new Promise((_, rej) => setTimeout(() => rej(new CliError(EXIT.TIMEOUT, 'timeout', `资产桥超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已终止`, '确认没有卡死后调大 BNE_BRIDGE_TIMEOUT（秒）')), timeoutMs).unref());
    try {
      reports = await Promise.race([page.evaluate(() => window.task), timer]);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(EXIT.FAIL, 'bridge', `浏览器端导出失败：${String(e.message || e).replace(/^page\.evaluate: /, '').split('\n')[0]}`, pageErrors.length ? `页面报错：${pageErrors[0]}` : '常见原因：配方或模块的 import 路径不对、three 版本不符、回读断言失败');
    }
    if (!reports || typeof reports !== 'object') throw new CliError(EXIT.FAIL, 'bridge', '浏览器端没有返回报告对象', pageErrors[0] || '');
    const runtime = {
      three: await page.evaluate(() => import('three').then(T => `r${T.REVISION}`)),
      playwright: JSON.parse(await readFile(resolve(ROOT, 'node_modules/playwright-core/package.json'), 'utf8')).version,
      browser: browser.version(), gl: 'SwiftShader（--use-angle=swiftshader）',
    };
    const repo = {}, packages = {};
    for (const [f, h] of [...served].sort()) (f.startsWith('node_modules/') ? packages : repo)[f] = h;
    for (const a of assets) {
      const r = reports[a.to];
      if (!r) throw new CliError(EXIT.FAIL, 'bridge', `浏览器端没有 ${a.to} 的报告`);
      const tmp = part(a.to);
      try { r.structuralValidation = await validateGLB(tmp, a.validate || {}); }
      catch (e) { throw new CliError(EXIT.CONTRACT, 'glb', `${a.to} 结构检查不通过：${e.message}`, '修好模块 / 配方后重导；正式路径上的旧文件没有被覆盖'); }
      r.sha256 = sha(await readFile(tmp));
      r.asset = Object.fromEntries(Object.entries(m(a)).filter(([k]) => !k.endsWith('Rel')));
      r.runtime = runtime;
      r.sourceHashes = repo;
      r.packageHashes = packages;
    }
    for (const a of assets) {
      await rename(part(a.to), resolve(outDir, a.to));
      const r = reports[a.to];
      const reportName = a.report || a.to.replace(/\.glb$/i, '-report.json');
      await writeFile(resolve(outDir, reportName), JSON.stringify(r, null, 2) + '\n');
      say(JSON.stringify({ asset: a.to, bytes: r.bytes, sha256: r.sha256, triangles: r.structuralValidation.sceneTriangles, clips: r.structuralValidation.animations.map(({ name, duration, channels, paths, maxLoopError }) => ({ name, duration, channels, paths, maxLoopError })) }));
    }
    done = true;
    const shot = preview && assets.find(a => a.preview)?.preview;
    if (shot) await page.screenshot({ path: resolve(outDir, shot) });
  } finally {
    offCleanup(shutdown);
    await shutdown();
  }
  return reports;
}
// 报告里记录条目本身（实际参数，例如 lod），去掉内部用的 /repo/ 路径
const m = a => ({ ...a, module: a.moduleRel, recipe: a.recipeRel });

const USAGE = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n');

export async function main(argv = process.argv.slice(2)) {
  return runCli({
    command: 'bridge', usage: USAGE, argv,
    spec: { '--only': 'string', '--preview': 'bool', '--module': 'string', '--export': 'string', '--args': 'string', '--length': 'string', '--scale': 'string', '--clip': 'string', '--prefix': 'string', '--out': 'string' },
    main: async a => {
      const json = (k) => { try { return JSON.parse(a[k]); } catch (e) { throw new CliError(EXIT.USAGE, 'usage', `--${k} 不是合法 JSON：${e.message}`); } };
      if (a.module) {
        if (!a.export) throw new CliError(EXIT.USAGE, 'usage', '--module 要配 --export <函数名>');
        const out = resolve(a.out || 'out/model.glb');
        const entry = { to: basename(out), module: a.module, export: a.export, args: a.args ? json('args') : undefined, prefix: a.prefix };
        if (a.length) entry.length = Number(a.length);
        if (a.scale) entry.scale = Number(a.scale);
        if (a.clip) { entry.clip = json('clip'); entry.validate = { animated: true, clip: entry.clip.name || 'Idle', loop: entry.clip.loop !== false }; }
        await exportModels([entry], { baseDir: process.cwd(), outDir: dirname(out), preview: Boolean(a.preview), timeoutMs: 1000 * Number(process.env.BNE_BRIDGE_TIMEOUT || 900) });
        return { outputs: [{ path: out, sha256: sha(await readFile(out)), kind: 'glb' }] };
      }
      if (a._.length !== 1) throw new CliError(EXIT.USAGE, 'usage', '要给一个作品目录，或用 --module 临时导出');
      const dir = resolve(a._[0]);
      let film;
      try { film = JSON.parse(await readFile(resolve(dir, 'film.json'), 'utf8')); } catch { throw new CliError(EXIT.USAGE, 'no-film', `${dir} 下没有可读的 film.json`); }
      const only = a.only?.split(',');
      const models = (film.native?.models || []).filter(isGenerated).filter(x => !only || only.includes(x.to));
      if (!models.length) throw new CliError(EXIT.USAGE, 'usage', 'film.json 里没有要由代码生成的模型（native.models 中带 module / recipe 的条目）');
      const reports = await exportModels(models, { baseDir: dir, outDir: resolve(dir, 'media'), preview: Boolean(a.preview), timeoutMs: 1000 * Number(process.env.BNE_BRIDGE_TIMEOUT || 900) });
      return { outputs: models.map(x => ({ path: relative(ROOT, resolve(dir, 'media', x.to)).split(sep).join('/'), sha256: reports[x.to].sha256, kind: 'glb' })) };
    },
  });
}

if (isMain(import.meta.url)) await exitWith(main());
