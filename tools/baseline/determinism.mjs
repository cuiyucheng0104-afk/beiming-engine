#!/usr/bin/env node
// 北冥仓库 · 确定性检查：同一部作品用「新页面单帧」「乱序」「从头顺序」三种方式渲同一批帧，像素哈希必须完全一致。
// 只有通过它，video.mjs 的多 worker 分段出片才等同单进程顺序出片（分段边界、切点处不会跳相位）。另做静态扫描。
//   node tools/baseline/determinism.mjs <作品目录> [选项]        例：node tools/baseline/determinism.mjs . --seams --workers 4
//   node tools/baseline/determinism.mjs --template a|c [选项]    检查路线模版（按 new-film 的规则临时实例化，结束即删）
//   node tools/baseline/determinism.mjs --scan-only [--path <目录>]…   只做静态扫描
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMain, CliError, EXIT, usage, log, parseSize, sha256File, displayPath } from './lib/cli.mjs';
import { runWorker, materializeTemplate, noBrowserHint } from './lib/capture.mjs';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { compareImages, diffHeatmap } from './lib/metrics.mjs';
import { scanFiles, listFiles, defaultTargets, loadAllow } from './lib/scan.mjs';
import { runId, headCommit, dirtyPixelPaths } from './lib/git.mjs';
import { platformKey, deviceSlug } from './lib/platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOW = path.join(ROOT, 'tools/baseline/determinism-allow.json');
const TEMPLATES = { a: 'routes/a-webgl/template', c: 'routes/c-style/template' };

const HELP = `北冥仓库 · 确定性检查（determinism）

用法：
  node tools/baseline/determinism.mjs <作品目录> [选项]       作品目录在仓库内，含 index.html；《北冥》样片就是 .
  node tools/baseline/determinism.mjs --template a|c [选项]   检查 A / C 路线模版（临时复制到 out/ 下渲，结束即删）
  node tools/baseline/determinism.mjs --scan-only [--path <目录>]…   只做静态扫描（默认范围：engine 浏览器端代码、films/、路线模版）

做什么：
  1. 取样帧：按 video.mjs 的分段规则（每段 ceil(N/W) 帧）取各分段边界 ±1 帧；切点 ±1 帧；另取若干随机帧；外加首尾帧
  2. 每帧用三种方式各渲一次：新页面单帧（每帧一个全新浏览器，等于分段出片时每段的第一帧）、
     同一页面乱序（确定性随机顺序）、同一页面从第 0 帧逐帧顺序渲到最后一个取样帧（等于单 worker 顺序出片）
  3. 三种方式的像素哈希必须完全一致；不一致的帧给出差异热图（新页面对顺序）
  4. 静态扫描 Math.random / Date.now / performance.now / new Date（存量登记见 tools/baseline/determinism-allow.json）

取样选项（都不写时 = 分段边界 + 切点 + 5 个随机帧 + 首尾帧；写了任何一个就只取写了的）：
  --seams                  分段边界 ±1 帧（配合 --workers，默认 4，与 video.mjs 默认一致）
  --cuts <帧,帧>           切点帧，查 ±1 帧；不写时读作品 film.json 的 shots[].in（v2）或 cuts
  --random <n>             随机取 n 帧（种子 --seed，默认 1）
  --frames <帧,帧>         直接给要查的帧号
其它选项：
  --workers <n>            分段数（默认 4）
  --seed <n>               随机帧与乱序的种子（默认 1）
  --size <宽x高>           默认读 film.json 的 size，没有就 1920x1040
  --fps <n>                默认读 film.json 的 fps，没有就 24
  --query <k=v&…>          页面查询串
  --gpu <策略>             required（默认）| any | software-ok
  --jobs <n>               新页面模式同时开几个浏览器（默认 2）
  --frame-timeout <秒>     单帧上限（默认 60）
  --out <目录>             报告目录（默认 out/determinism/<运行编号>/）
  --no-scan                不做静态扫描
  --path <目录>            --scan-only 的扫描范围（可重复）
  --json                   stdout 只输出一个 JSON 信封

退出码：0 通过；1 运行失败；2 用法错误；3 环境不满足（没浏览器、软件渲染被拒）；4 不确定（三种方式不一致）或静态扫描有违规；124 超时；130 / 143 中断已清理。
`;

const SPEC = {
  flags: {
    '--template': 'string', '--scan-only': 'bool', '--path': 'list', '--seams': 'bool', '--cuts': 'list', '--random': 'int', '--frames': 'list',
    '--workers': 'int', '--seed': 'int', '--size': 'string', '--fps': 'int', '--query': 'string', '--gpu': 'string', '--jobs': 'int',
    '--frame-timeout': 'number', '--out': 'string', '--no-scan': 'bool', '--json': 'bool',
  },
  positionals: [0, 1],
};

const rel = p => displayPath(ROOT, p);
const ints = (list, name) => list.map(v => {
  if (!/^\d+$/.test(v)) throw usage(`${name} 只能写非负整数帧号，现在有 ${JSON.stringify(v)}`);
  return Number(v);
});
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function readFilm(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'film.json'), 'utf8')); } catch { return null; } }

function doScan(paths) {
  const files = listFiles(ROOT, paths);
  const r = scanFiles(ROOT, files, loadAllow(ALLOW));
  log(`静态扫描：${r.files} 个文件，${r.findings.length} 处命中，其中 ${r.allowedCount} 处已登记或行内豁免，${r.errors.length} 处违规`);
  for (const e of r.errors.slice(0, 20)) log(`  ✗ ${e.file}:${e.line}:${e.col} ${e.api} · ${e.text}`);
  return { paths, ...r };
}

async function main({ opts, positionals }) {
  if (opts.scanOnly) {
    if (positionals.length || opts.template) throw usage('--scan-only 不接受作品目录或 --template；用 --path 指定范围');
    const scan = doScan(opts.path.length ? opts.path : defaultTargets(ROOT));
    return scan.errors.length
      ? { exitCode: EXIT.CONTRACT, result: { scan }, error: { code: 'nondeterministic-api', message: `${scan.errors.length} 处用了不确定的 API`, hint: '改成由 t 与固定种子算出；只用于计时的写法在同一行加 // determinism-ok: <理由>' } }
      : { result: { scan } };
  }
  if (opts.path.length) throw usage('--path 只配合 --scan-only 使用');
  if (!!positionals[0] === !!opts.template) throw usage('要么给作品目录，要么给 --template a|c（二选一）');
  if (opts.template && !TEMPLATES[opts.template]) throw usage(`--template 只能是 ${Object.keys(TEMPLATES).join(' | ')}`);
  const gpu = opts.gpu || 'required';
  if (!['required', 'any', 'software-ok'].includes(gpu)) throw usage('--gpu 只能是 required | any | software-ok');
  const W = opts.workers ?? 4;
  if (!(W >= 1 && W <= 64)) throw usage('--workers 要在 1–64 之间');
  if (opts.random != null && !(opts.random >= 0 && opts.random <= 50)) throw usage('--random 要在 0–50 之间');
  const jobs = opts.jobs ?? 2, frameTimeoutMs = Math.round((opts.frameTimeout ?? 60) * 1000), seed = opts.seed ?? 1;

  // 页面目录
  let dir, label, tpl = null;
  if (opts.template) {
    tpl = materializeTemplate(ROOT, TEMPLATES[opts.template], { NAME: `det-${opts.template}`, TITLE: opts.template === 'a' ? 'AI 2026' : '概念样片' }, `det-${opts.template}`);
    dir = tpl.dir; label = `模版 ${TEMPLATES[opts.template]}`;
  } else {
    dir = path.resolve(positionals[0]);
    const r = path.relative(ROOT, dir);
    if (r.startsWith('..') || path.isAbsolute(r) || !fs.existsSync(path.join(dir, 'index.html'))) {
      throw usage(`找不到作品页面：${positionals[0]}/index.html（作品目录要在仓库内）`);
    }
    label = r ? `作品 ${r.split(path.sep).join('/')}` : '《北冥》样片（仓库根目录）';
  }
  try {
    const film = readFilm(dir);
    const size = opts.size ? parseSize(opts.size) : Array.isArray(film?.size) ? film.size : film?.output ? [film.output.width, film.output.height] : [1920, 1040];
    const fps = opts.fps ?? film?.fps ?? film?.output?.fps ?? 24;
    const id = runId(ROOT);
    const outDir = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'out/determinism', id);
    fs.mkdirSync(outDir, { recursive: true });
    const base = { tree: ROOT, dir, pageId: 'film', query: opts.query || '', w: size[0], h: size[1], clip: null, fps, gpu, frameTimeoutMs };

    // 先开一次页面拿 DUR（同时验证页面能打开、渲染器不是软件光栅）
    log(`${label}：${size.join('x')} @ ${fps} fps，${W} 段`);
    const probe = await runWorker({ ...base, groupId: 'probe', times: { frames: [0] }, outDir: path.join(outDir, 'probe'), resultFile: path.join(outDir, '.work', 'probe.json'), order: 'asc' }, { log, prefix: '  [探测] ', timeoutMs: 240000 });
    if (probe.exitCode) failWorker(probe, '打开页面');
    const DUR = probe.result.DUR, N = Math.round(DUR * fps), renderer = probe.result.renderer;
    if (N < 2) throw new CliError('too-short', `作品只有 ${N} 帧，没法做确定性检查`, { exitCode: EXIT.CONTRACT });

    // 取样
    const selectors = opts.seams || opts.cuts.length || opts.random != null || opts.frames.length;
    const pick = new Map();   // 帧 → 理由
    const add = (f, why) => { if (f >= 0 && f < N) pick.set(f, pick.has(f) ? `${pick.get(f)}、${why}` : why); };
    const per = Math.ceil(N / W);
    if (!selectors || opts.seams) for (let k = 1; k < W; k++) { const a = k * per; if (a < N) [a - 1, a, a + 1].forEach(f => add(f, `第 ${k} 段边界（${a}）`)); }
    let cuts = ints(opts.cuts, '--cuts');
    if (!selectors) {   // 默认取样时从作品描述里找切点：film.json v2 的 shots[].in，或 v1 的 cuts（帧号）
      if (Array.isArray(film?.shots)) cuts = film.shots.map(s => s.in).filter(v => Number.isInteger(v) && v > 0);
      else if (Array.isArray(film?.cuts)) cuts = film.cuts.filter(Number.isInteger);
    }
    for (const c of cuts) [c - 1, c, c + 1].forEach(f => add(f, `切点 ${c}`));
    const nRandom = opts.random ?? (selectors ? 0 : 5);
    const R = mulberry(seed);
    for (let i = 0, guard = 0; i < nRandom && guard < 1000; guard++) { const f = Math.floor(R() * N); if (!pick.has(f)) { add(f, '随机'); i++; } }
    for (const f of ints(opts.frames, '--frames')) { if (f >= N) throw usage(`--frames 里的 ${f} 超出作品帧数 ${N}`); add(f, '指定'); }
    if (!selectors) { add(0, '首帧'); add(N - 1, '尾帧'); }
    const warnings = [];
    if (!selectors && !cuts.length) warnings.push('没找到切点信息（作品 film.json 没有 shots[].in 或 cuts），只查了分段边界、随机帧与首尾；可用 --cuts 指定');
    const frames = [...pick.keys()].sort((a, b) => a - b);
    if (!frames.length) throw usage('没有取到任何帧（检查 --frames / --cuts 是否超出作品帧数）');
    log(`取样 ${frames.length} 帧（共 ${N} 帧）：${frames.join(' ')}`);

    // 三种方式
    const work = path.join(outDir, '.work');
    const run = (mode, extra) => runWorker({ ...base, groupId: mode, outDir: path.join(outDir, mode), resultFile: path.join(work, `${mode}.json`), ...extra }, { log, prefix: `  [${mode}] `, timeoutMs: 200000 + (frames.at(-1) + frames.length + 4) * frameTimeoutMs });
    log('① 新页面单帧（每帧一个全新浏览器）');
    const fresh = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, frames.length) }, async () => {
      while (next < frames.length) {
        const f = frames[next++];
        const r = await runWorker({ ...base, groupId: `fresh-${f}`, times: { frames: [f] }, outDir: path.join(outDir, 'fresh'), resultFile: path.join(work, `fresh-${f}.json`), order: 'asc' }, { log, prefix: `  [fresh ${f}] `, timeoutMs: 240000 });
        if (r.exitCode) failWorker(r, `新页面渲第 ${f} 帧`);
        fresh.set(f, r.result.frames[0]);
      }
    }));
    log('② 同一页面乱序');
    const sh = await run('shuffled', { times: { frames }, order: `shuffle:${seed}` });
    if (sh.exitCode) failWorker(sh, '乱序渲染');
    log(`③ 同一页面从第 0 帧顺序渲到第 ${frames.at(-1)} 帧`);
    const sq = await run('sequential', { times: { frames }, order: 'asc', sequential: { from: 0 } });
    if (sq.exitCode) failWorker(sq, '顺序渲染');
    fs.rmSync(work, { recursive: true, force: true });

    const byF = r => new Map(r.result.frames.map(x => [x.f, x]));
    const S = byF(sh), Q = byF(sq);
    const rows = [];
    fs.mkdirSync(path.join(outDir, 'diff'), { recursive: true });
    for (const f of frames) {
      const a = fresh.get(f), b = S.get(f), c = Q.get(f);
      const hashes = { fresh: a?.pixelSha256 ?? null, shuffled: b?.pixelSha256 ?? null, sequential: c?.pixelSha256 ?? null };
      const same = hashes.fresh && hashes.fresh === hashes.shuffled && hashes.fresh === hashes.sequential;
      const row = { f, t: f / fps, why: pick.get(f), status: same ? 'same' : 'differs', hashes };
      if (!same && a && c) {
        const A = decodePNG(fs.readFileSync(a.file)), C = decodePNG(fs.readFileSync(c.file));
        row.stats = compareImages(A, C);
        if (!row.stats.identical && !row.stats.sizeMismatch) {
          const fn = path.join('diff', `f${String(f).padStart(5, '0')}-fresh-vs-sequential.png`);
          fs.writeFileSync(path.join(outDir, fn), encodePNG(diffHeatmap(A, C)));
          row.diff = fn;
        }
        row.differs = Object.entries(hashes).filter(([, h]) => h !== hashes.sequential).map(([k]) => k);
      }
      rows.push(row);
    }
    const bad = rows.filter(r => r.status !== 'same');
    const scan = opts.noScan ? null : doScan(tpl ? [TEMPLATES[opts.template], 'engine'] : rel(dir) ? [rel(dir), 'engine'] : ['src', 'engine']);
    const report = {
      schemaVersion: 1, kind: 'determinism', film: label, dir: tpl ? TEMPLATES[opts.template] : rel(dir) || '.', query: base.query,
      size, fps, DUR, frames: N, workers: W, segmentLength: per, seed,
      platformKey: platformKey(renderer), device: deviceSlug(renderer), renderer, browser: probe.result.browserVersion,
      source: { commit: headCommit(ROOT).sha, dirty: dirtyPixelPaths(ROOT).length > 0 },
      modes: ['fresh', 'shuffled', 'sequential'], samples: rows.length, ok: !bad.length && !(scan?.errors.length),
      rows, scan: scan && { files: scan.files, findings: scan.findings.length, allowed: scan.allowedCount, errors: scan.errors },
      warnings,
    };
    const rp = path.join(outDir, 'report.json');
    fs.writeFileSync(rp, JSON.stringify(report, null, 1) + '\n');
    for (const d of ['fresh', 'shuffled', 'sequential', 'probe']) if (!bad.length) fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
    if (bad.length) {
      log(`不确定：${bad.length}/${rows.length} 帧三种方式结果不同`);
      for (const r of bad.slice(0, 12)) log(`  ✗ 第 ${r.f} 帧（${r.why}）：${r.differs?.join('、') || '?'} 与顺序渲染不同${r.stats ? `，差 >1 级像素 ${(r.stats.fracAbove1 * 100).toFixed(3)}%，最大差 ${r.stats.maxDiff}` : ''}${r.diff ? ` · 热图 ${rel(path.join(outDir, r.diff))}` : ''}`);
    } else log(`通过：${rows.length} 帧在新页面、乱序、顺序三种方式下逐像素一致`);
    const outputs = [{ path: rel(rp), sha256: sha256File(rp), kind: 'determinism-report' }];
    if (bad.length) {
      return { exitCode: EXIT.CONTRACT, outputs, warnings, runJson: rel(rp), result: { ok: false, bad: bad.map(r => r.f) },
        error: { code: 'nondeterministic', message: `${bad.length} 帧三种渲染方式结果不同（第 ${bad.map(r => r.f).join('、')} 帧）`, hint: 'render(t) 里有累计状态、未设种子的随机或依赖上一帧的东西：改成只由 t 算出；修好之前出片用 --workers 1' } };
    }
    if (scan?.errors.length) {
      return { exitCode: EXIT.CONTRACT, outputs, warnings, runJson: rel(rp), result: { ok: false, scanErrors: scan.errors.length },
        error: { code: 'nondeterministic-api', message: `渲染逐像素一致，但静态扫描有 ${scan.errors.length} 处不确定的 API`, hint: '改成由 t 与固定种子算出；只用于计时的写法在同一行加 // determinism-ok: <理由>' } };
    }
    return { outputs, warnings, runJson: rel(rp), result: { ok: true, frames: rows.length } };
  } finally {
    tpl?.remove();
  }
}

function failWorker(r, what) {
  const e = r.result?.error || {};
  const exitCode = [EXIT.ENV, EXIT.CONTRACT, EXIT.TIMEOUT].includes(r.exitCode) ? r.exitCode : EXIT.FAIL;
  throw new CliError(e.code || 'render-failed', `${what}失败：${e.message || r.stderrTail.trim().split('\n').slice(-2).join(' / ')}`, {
    hint: e.code === 'software-fallback' ? (e.hint || '检查 BEIMING_ANGLE；有意用软件渲染时加 --gpu software-ok') : e.code === 'no-browser' ? noBrowserHint
      : '先用 node engine/render/still.mjs <目录> <t> 单独渲一帧看页面报错', exitCode,
  });
}

await runMain({ command: 'determinism', spec: SPEC, help: HELP, main });
