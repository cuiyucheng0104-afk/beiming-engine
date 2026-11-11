// 北冥仓库 · 截一个集合：把集合展开成页面组，每组起一个截帧子进程（worker.mjs），收齐结果写成「截帧清单」。
//
//   captureSet({ tree, sets, setName, outDir, gpu, jobs, frameTimeoutMs, log, source, perturb })
//     perturb  加在每个页面网址上的查询串（不进帧编号），只给 compare --perturb 做灵敏度检查
//     tree     被测工作树（当前仓库，或 --against 检出的临时工作树）；页面、渲染器、模版都从这里取
//     outDir   PNG 与截帧清单（capture.json）写到这里
//     → { manifest, failures }：manifest 见 writeCaptureManifest；failures 是没截成的组（含原因与建议的退出码）
//   runWorker(spec, { log, timeoutMs })   跑一个截帧子进程（determinism.mjs 也用）
//   materializeTemplate(tree, rel, vars)  把 routes/<路线>/template 按 new-film 的规则复制到 <tree>/out/golden-tpl-…/
//     （模版是按 films/<名字>/ 两级深度写相对路径的，不能原地渲染）并替换 {{NAME}} / {{TITLE}}；film.json 声明了字体时
//     再按本片文字生成字体子集（A 模版需要）；结束时删除
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, codeFor, onCleanup, offCleanup, sha256File } from './cli.mjs';
import { expandSet, setHash } from './sets.mjs';
import { backendOf, deviceSlug, platformKey, toolVersions, osDescription } from './platform.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.sh', '.txt',
  '.glsl', '.wgsl', '.wesl', '.toml', '.yaml', '.yml', '.svg']);
const SKIP = new Set(['out', 'node_modules', '.DS_Store', '__pycache__']);

export function materializeTemplate(tree, rel, vars, tag) {
  const src = path.join(tree, rel);
  const dst = path.join(tree, 'out', `golden-tpl-${tag.replace(/[^a-z0-9]+/gi, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const copy = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) { copy(sp, dp); continue; }
      if (!e.isFile()) continue;
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
        let txt = fs.readFileSync(sp, 'utf8');
        for (const [k, v] of Object.entries(vars || {})) txt = txt.split(`{{${k}}}`).join(v);
        fs.writeFileSync(dp, txt);
      } else fs.copyFileSync(sp, dp);
    }
  };
  copy(src, dst);
  const remove = () => fs.rmSync(dst, { recursive: true, force: true });
  // A 模版在页面上只画本片字体子集里的字：实例化后要先生成子集（与作者跑 npm run new 之后的第一步相同），否则页面拒绝打开
  const film = (() => { try { return JSON.parse(fs.readFileSync(path.join(dst, 'film.json'), 'utf8')); } catch { return null; } })();
  if (film?.fonts?.length && !fs.existsSync(path.join(dst, 'fonts', 'fonts.json'))) {
    const r = spawnSync(process.execPath, [path.join(tree, 'tools/fonts/subset.mjs'), dst, '--quiet'], { cwd: tree, encoding: 'utf8', timeout: 300000, windowsHide: true });
    if (r.status !== 0) {
      remove();
      const tail = String(r.stderr || r.error?.message || '').trim().split('\n').slice(-2).join(' ');
      throw new CliError(r.status === 3 ? EXIT.ENV : EXIT.FAIL, 'template-fonts', `模版 ${rel} 的字体子集没生成：${tail}`, '先跑 node tools/fonts/fetch.mjs 取原始字体（要联网，一次即可），并确认 Python 装了 fonttools、brotli（npm run setup）');
    }
  }
  remove.sync = remove;
  onCleanup(remove);
  return { dir: dst, remove: () => { offCleanup(remove); remove(); } };
}

export function runWorker(spec, { log = () => {}, timeoutMs = 600000, prefix = '' } = {}) {
  return new Promise(resolve => {
    fs.mkdirSync(path.dirname(spec.resultFile), { recursive: true });
    const specFile = spec.resultFile.replace(/\.json$/, '.spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec));
    fs.rmSync(spec.resultFile, { force: true });
    const child = spawn(process.execPath, [WORKER, specFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let tail = '';
    child.stderr.on('data', d => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      for (const line of s.split('\n')) if (line.trim()) log(`${prefix}${line}`);
    });
    let timedOut = false;
    const kill = () => {
      if (child.exitCode != null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 10000).unref();
    };
    kill.sync = () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } };
    onCleanup(kill);
    const timer = setTimeout(() => { timedOut = true; log(`${prefix}超时（${timeoutMs / 1000} 秒），结束子进程`); kill(); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      offCleanup(kill);
      let res = null;
      try { res = JSON.parse(fs.readFileSync(spec.resultFile, 'utf8')); } catch { /* 子进程没来得及写 */ }
      fs.rmSync(specFile, { force: true });
      const exitCode = timedOut ? EXIT.TIMEOUT : (code ?? EXIT.FAIL);
      resolve({ exitCode, result: res, stderrTail: tail });
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

function readFilmSize(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'film.json'), 'utf8'));
    const s = j.size || j.output && [j.output.width, j.output.height];
    if (Array.isArray(s) && s.length === 2) return s;
  } catch { /* 下面报错 */ }
  return null;
}
function readFilmFps(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'film.json'), 'utf8')); return j.fps || j.output?.fps || null; } catch { return null; }
}

export async function captureSet({ tree, sets, setName, outDir, gpu = 'required', jobs = 2, frameTimeoutMs = 60000, log = () => {}, source = {}, perturb = '' }) {
  const groups = expandSet(sets, setName);
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const results = await pool(groups, jobs, async g => {
    const p = g.page;
    if (p.requires && !fs.existsSync(path.join(tree, p.requires))) {
      return { group: g, exitCode: EXIT.CONTRACT, error: { code: 'missing-page', message: `被测工作树里没有 ${p.requires}（页面 ${g.pageId}）` } };
    }
    let dir, tpl = null;
    if (p.template) {
      if (!fs.existsSync(path.join(tree, p.template, 'index.html'))) {
        return { group: g, exitCode: EXIT.CONTRACT, error: { code: 'missing-page', message: `被测工作树里没有模版 ${p.template}` } };
      }
      tpl = materializeTemplate(tree, p.template, p.vars, g.pageId);
      dir = tpl.dir;
    } else {
      dir = path.join(tree, p.dir);
      if (!fs.existsSync(path.join(dir, 'index.html'))) {
        return { group: g, exitCode: EXIT.CONTRACT, error: { code: 'missing-page', message: `被测工作树里没有 ${p.dir}/index.html（页面 ${g.pageId}）` } };
      }
    }
    try {
      const size = g.size === 'film.json' ? readFilmSize(dir) : g.size;
      if (!size) return { group: g, exitCode: EXIT.CONTRACT, error: { code: 'bad-film-json', message: `${g.pageId} 的 film.json 读不出画幅` } };
      const fps = p.fps || readFilmFps(dir) || 24;
      const spec = {
        groupId: g.groupId, tree, dir, pageId: g.pageId, query: g.query, w: size[0], h: size[1], clip: g.clip, times: g.times, fps,
        outDir: path.join(outDir, 'frames'), resultFile: path.join(outDir, '.work', `${g.groupId.replace(/[^a-z0-9]+/gi, '_')}.json`),
        gpu, frameTimeoutMs, order: 'asc', ...(perturb ? { perturb } : {}),
      };
      log(`  · ${g.pageId}${g.query ? `?${g.query}` : ''} ${size.join('x')}${g.clip ? ` 裁切 ${g.clip.join(',')}` : ''}`);
      const r = await runWorker(spec, { log, prefix: `    [${g.pageId}] `, timeoutMs: 200000 + 30 * frameTimeoutMs });
      return { group: g, exitCode: r.exitCode, error: r.result?.error || (r.exitCode ? { code: 'worker-failed', message: `截帧子进程退出码 ${r.exitCode}：${r.stderrTail.trim().split('\n').slice(-3).join(' / ')}` } : null), result: r.result };
    } finally {
      tpl?.remove();
    }
  });
  fs.rmSync(path.join(outDir, '.work'), { recursive: true, force: true });

  const frames = [], failures = [], renderers = new Set(), browsers = new Set();
  for (const r of results) {
    if (r.result?.renderer) renderers.add(r.result.renderer);
    if (r.result?.browserVersion) browsers.add(r.result.browserVersion);
    for (const f of r.result?.frames || []) frames.push({ ...f, file: path.relative(outDir, f.file).split(path.sep).join('/') });
    if (r.exitCode !== 0) failures.push({ groupId: r.group.groupId, pageId: r.group.pageId, exitCode: r.exitCode, ...r.error });
  }
  const renderer = [...renderers][0] || '';
  const manifest = {
    schema: 'beiming-golden-capture/v1',
    set: setName, setHash: setHash(sets, setName),
    platformKey: renderer ? platformKey(renderer) : null, device: renderer ? deviceSlug(renderer) : null, renderer, backend: backendOf(renderer),
    browser: [...browsers][0] || null,
    env: { os: osDescription(), ...toolVersions(tree), angle: process.env.BEIMING_ANGLE || 'default', gpuPolicy: gpu, ...(perturb ? { perturb } : {}) },
    source, capturedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10,
    frames: frames.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    failures,
  };
  if (renderers.size > 1) manifest.warnings = [`同一集合里各页面报出的渲染器不一样：${[...renderers].join(' | ')}`];
  fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify(manifest, null, 1) + '\n');
  return { manifest, failures };
}

// 截帧清单里的 PNG 还在、且字节哈希对得上 → 可以复用（compare 取参照像素时用）
export function captureUsable(dir, { setHash: want, platformKey: pk, device, browser } = {}) {
  const f = path.join(dir, 'capture.json');
  if (!fs.existsSync(f)) return null;
  let m;
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  if (m.failures?.length || (want && m.setHash !== want) || (pk && m.platformKey !== pk) || (device && m.device !== device) || (browser && m.browser !== browser)) return null;
  for (const fr of m.frames) {
    const p = path.join(dir, fr.file);
    if (!fs.existsSync(p) || sha256File(p) !== fr.pngSha256) return null;
  }
  return m;
}
export const noBrowserHint = '装浏览器：npx playwright-core install chromium-headless-shell（与 package.json 锁定的 playwright-core 同版本）';
export function failureExit(failures) {
  if (!failures.length) return EXIT.OK;
  const codes = failures.map(f => f.exitCode);
  for (const c of [EXIT.TIMEOUT, EXIT.ENV, EXIT.FAIL, EXIT.CONTRACT]) if (codes.includes(c)) return c;
  return codes[0] || EXIT.FAIL;
}
export function assertCaptured(failures) {
  if (!failures.length) return;
  const exitCode = failureExit(failures);
  const first = failures.find(f => f.exitCode === exitCode) || failures[0];
  throw new CliError(codeFor(exitCode, first.code || 'capture-failed'),
    `${failures.length} 组没截成：${failures.map(f => `${f.pageId}（${f.message}）`).join('；')}`,
    { hint: first.code === 'software-fallback' ? first.hint || '检查 BEIMING_ANGLE；有意用软件渲染时加 --gpu software-ok'
      : first.code === 'no-browser' ? noBrowserHint
        : first.code === 'missing-page' ? '参照提交里没有这个页面：换一个包含它的提交，或去掉对应的 --set'
          : '按上面日志里的页面报错修页面；单独看一帧：node engine/render/still.mjs <目录> <t>', exitCode });
}
