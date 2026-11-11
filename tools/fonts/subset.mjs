#!/usr/bin/env node
// 按作品实际要画的文字，从锁定的完整 OFL 字体离线生成本片的字体子集：films/<名>/fonts/*.woff2 + fonts.json（清单与覆盖率报告）+ 许可全文。
// 文字来源是 film.json 的 texts（画面文字白名单：页面只画这里登记的字）与 fonts[].extra；字族与原始字体的对应在 fonts[]。
// 缺字（原始字体里没有）直接失败并列出是哪个字，绝不静默回退到系统字体；--check 只核对已有子集是否覆盖当前文字（不要 Python）。
// 页面端用 engine/style/fonts.js 读同一份清单并在画字前核对覆盖，两头用同一套码位。不碰仓库 fonts/ 下《北冥》共用的子集。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CliError, defineCommand, isMain, runCli, sha256 } from '../lib/cli.mjs';
import { ROOT, rel, loadLock, cacheDir, fontById, findFontPython, licenseText, sha256File } from './lock.mjs';
import { fontInfo } from './sfnt.mjs';
import { codepointsOf, unicodeRange } from '../../engine/style/fonts.js';

const GEN = 'tools/fonts/subset.mjs@1';
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
const hexcp = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

/** 读作品的 film.json，核对 fonts / texts 的写法 → { film, fam: [{ family, source, weight?, extra?, texts: [] }] }。 */
export function readFilm(dir) {
  const fj = path.join(dir, 'film.json');
  if (!fs.existsSync(fj)) throw new CliError('usage.not-a-film', `${rel(dir)} 下没有 film.json`, '参数要给作品目录，例如 films/chendu');
  let film;
  try { film = JSON.parse(fs.readFileSync(fj, 'utf8')); } catch (e) { throw new CliError('contract.film-json', `${rel(fj)} 不是合法 JSON：${e.message}`, '修好 JSON 语法后重跑'); }
  const bad = m => new CliError('contract.film-fonts', `${rel(fj)}：${m}`, '写法见 node tools/fonts/subset.mjs --help');
  const { fonts, texts } = film;
  if (!Array.isArray(fonts) || !fonts.length) throw bad('缺 fonts（字族 → 锁定原始字体的对应）：画面上有字就必须声明');
  if (!Array.isArray(texts)) throw bad('缺 texts（画面文字白名单）');
  const fam = new Map();
  for (const f of fonts) {
    if (!f || typeof f.family !== 'string' || !f.family.trim()) throw bad(`fonts 项缺 family：${JSON.stringify(f)}`);
    if (typeof f.source !== 'string') throw bad(`字族 ${f.family} 缺 source（fonts/fonts.lock.json 里的 id）`);
    if (fam.has(f.family)) throw bad(`字族 ${f.family} 重复声明`);
    if (f.extra !== undefined && typeof f.extra !== 'string') throw bad(`字族 ${f.family} 的 extra 要是字符串`);
    fam.set(f.family, { ...f, texts: [] });
  }
  const ids = new Set();
  for (const t of texts) {
    if (!t || typeof t.id !== 'string' || typeof t.text !== 'string' || typeof t.font !== 'string') throw bad(`texts 项要有 id、text、font：${JSON.stringify(t)}`);
    if (ids.has(t.id)) throw bad(`texts 的 id 重复：${t.id}`);
    ids.add(t.id);
    if (/\{\{[A-Z_]+\}\}/.test(t.text)) throw bad(`texts.${t.id} 还是占位符 ${t.text}（模版要先经 node tools/new-film.mjs 生成作品）`);
    if (!fam.has(t.font)) throw bad(`texts.${t.id} 用了没声明的字族 ${JSON.stringify(t.font)}`);
    fam.get(t.font).texts.push(t);
  }
  return { film, fam: [...fam.values()] };
}

/** 每个字族要收哪些码位、从哪款锁定字体、定什么字重。 */
export function plan(lock, fam) {
  return fam.map(f => {
    const src = fontById(lock, f.source);
    const cps = codepointsOf(f.texts.map(t => t.text).join('') + (f.extra || '')).sort((a, b) => a - b);
    let weight = f.weight ?? src.weight;
    if (Array.isArray(weight)) weight = weight[0];
    if (src.variable) {
      const ax = (src.axes || []).find(a => a.tag === 'wght');
      if (f.weight === undefined) throw new CliError('contract.film-fonts', `字族 ${f.family} 用的 ${src.id} 是可变字体，要写 weight（${ax ? `${ax.min}–${ax.max}` : '字重'}）`, '例：{ "family": "BM Text", "source": "noto-sans-sc", "weight": 400 }');
      if (ax && (f.weight < ax.min || f.weight > ax.max)) throw new CliError('contract.film-fonts', `字族 ${f.family} 的 weight ${f.weight} 超出 ${src.id} 的范围 ${ax.min}–${ax.max}`, null);
    } else if (f.weight !== undefined && f.weight !== src.weight) {
      throw new CliError('contract.film-fonts', `字族 ${f.family} 写了 weight ${f.weight}，但 ${src.id} 是固定字重 ${src.weight} 的字体`, '换成同族的对应字重（如 barlow-light / barlow-medium），或去掉 weight');
    }
    return { family: f.family, src, weight, cps, chars: String.fromCodePoint(...cps), file: `${slug(f.family)}-${weight}.woff2`, texts: f.texts.map(t => t.id) };
  });
}

/** --check：已有子集是否覆盖当前文字、文件是否被改、原始字体与字重是否变了 → 过期原因列表（空 = 有效）。 */
export function checkExisting(outDir, items) {
  const mf = path.join(outDir, 'fonts.json'), stale = [];
  if (!fs.existsSync(mf)) return [`没有 ${rel(mf)}`];
  let M;
  try { M = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return [`${rel(mf)} 不是合法 JSON`]; }
  for (const it of items) {
    const e = (M.fonts || []).find(f => f.family === it.family);
    if (!e) { stale.push(`清单里没有字族 ${it.family}`); continue; }
    const have = new Set(codepointsOf(e.chars || ''));
    const miss = it.cps.filter(cp => !have.has(cp));
    if (miss.length) stale.push(`${it.family} 缺 ${miss.map(cp => `「${String.fromCodePoint(cp)}」`).join('')}`);
    if (!e.source || e.source.sha256 !== it.src.sha256) stale.push(`${it.family} 的原始字体换了（现在锁定 ${it.src.id} ${it.src.version}）`);
    if (String(e.weight) !== String(it.weight)) stale.push(`${it.family} 的字重从 ${e.weight} 改成了 ${it.weight}`);
    const fp = path.join(outDir, e.file || '');
    if (!e.file || !fs.existsSync(fp)) stale.push(`缺文件 ${e.file}`);
    else if (sha256File(fp) !== e.sha256) stale.push(`${e.file} 和清单记的 sha256 不一致（被改过）`);
  }
  return stale;
}

// fontTools 子进程：异步运行（Ctrl+C 时由清理结束它），固定 SOURCE_DATE_EPOCH 让同样的输入得到逐字节相同的子集
function runPy(py, args, { what, epoch, timeoutSec, onCleanup }) {
  return new Promise((resolve, reject) => {
    const child = spawn(py.cmd, [...py.args, ...args], { env: { ...py.env, SOURCE_DATE_EPOCH: String(epoch) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '', timedOut = false;
    child.stderr.setEncoding('utf8').on('data', d => { if (err.length < 1 << 16) err += d; });
    child.stdout.resume();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    const undo = onCleanup(() => child.kill('SIGKILL'));
    child.on('error', e => { clearTimeout(timer); undo(); reject(new CliError('env.python-spawn', `${what}：启动 Python 失败（${e.code || e.message}）`, '检查 BEIMING_PYTHON / .venv 指向的解释器')); });
    child.on('close', code => {
      clearTimeout(timer); undo();
      if (timedOut) return reject(new CliError('timeout.fonttools', `${what}超过 ${timeoutSec} 秒没完成，已结束`, '字体很大时加 --timeout'));
      if (code !== 0) return reject(new CliError('failure.fonttools', `${what}失败：${err.trim().split('\n').slice(-3).join(' | ') || `退出码 ${code}`}`, '确认 fontTools 是 requirements.lock 锁定的版本（npm run setup）后重试'));
      resolve();
    });
  });
}

export const command = defineCommand({
  name: 'fonts:subset',
  summary: '按作品 film.json 的文字，从锁定的完整 OFL 字体离线生成本片字体子集与覆盖率报告；缺字直接失败',
  usage: ['node tools/fonts/subset.mjs <作品目录> [--check] [--cache <目录>] [--python <解释器>] [--json]'],
  description: [
    '产物写进 <作品目录>/fonts/：<字族>-<字重>.woff2、fonts.json（清单 + 每条文字的覆盖率报告）、OFL 许可全文。提交进作品源码。',
    'film.json 里这样写：',
    '  "fonts": [ { "family": "BM Title", "source": "ma-shan-zheng" },',
    '             { "family": "BM Text", "source": "noto-sans-sc", "weight": 400, "extra": "0123456789" } ],',
    '  "texts": [ { "id": "title", "text": "晨渡", "font": "BM Title" } ]',
    'source 是 fonts/fonts.lock.json 里的 id；weight 给可变字体定字重（定成静态实例，文件更小）；extra 是要额外收的字（动态数字等）。',
    '原始字体先用 node tools/fonts/fetch.mjs 取到缓存；子集化用 Python fontTools（解释器按 tools/env/py.mjs 的统一顺序找）。',
  ],
  positionals: [{ name: 'film', label: '<作品目录>', describe: '例如 films/chendu（里面要有 film.json）' }],
  options: {
    check: { type: 'boolean', describe: '不生成，只核对现有子集：覆盖不了当前文字、文件被改、原始字体或字重变了都算过期（退出 4）' },
    cache: { type: 'string', arg: '<目录>', describe: '原始字体缓存目录（默认 BEIMING_FONT_CACHE，否则 .cache/fonts）' },
    python: { type: 'string', arg: '<解释器>', describe: '装了 fonttools、brotli 的 Python（等同 BEIMING_PYTHON）' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '每一步 fontTools 的超时，默认 300 秒' },
  },
  examples: ['node tools/fonts/subset.mjs films/chendu', 'node tools/fonts/subset.mjs films/chendu --check --json'],
  exitCodes: { 0: '成功', 1: '子集化本身失败', 2: '用法错误', 3: '缺原始字体或缺 Python 依赖', 4: 'film.json 的字体声明不合格、缺字、子集过期', 124: 'fontTools 超时' },
  async run(ctx) {
    const dir = path.resolve(ctx.args.film), outDir = path.join(dir, 'fonts');
    if (path.resolve(outDir) === path.join(ROOT, 'fonts')) throw new CliError('usage.shared-fonts', '仓库根的 fonts/ 是《北冥》共用的冻结子集，不能当作品目录', '给作品目录，例如 films/chendu');
    const lock = loadLock(), { film, fam } = readFilm(dir), items = plan(lock, fam);
    const filmId = film.id ?? path.basename(dir);

    if (ctx.opts.check) {
      const stale = checkExisting(outDir, items);
      if (stale.length) throw new CliError('contract.subset-stale', `字体子集过期：${stale.join('；')}`, `重跑 node tools/fonts/subset.mjs ${rel(dir)}`);
      ctx.log.info(`✓ ${rel(outDir)} 覆盖 film.json 的全部文字`);
      return { data: { film: filmId, fonts: items.map(it => ({ family: it.family, codepoints: it.cps.length })) } };
    }

    // 1. 原始字体在缓存里、哈希对
    const cdir = cacheDir(lock, ctx.opts.cache, ctx.env), srcInfo = new Map();
    for (const it of items) {
      if (srcInfo.has(it.src.id)) continue;
      const p = path.join(cdir, it.src.file);
      if (!fs.existsSync(p)) throw new CliError('env.font-source-missing', `缓存里没有原始字体 ${it.src.file}（${cdir}）`, `先跑 node tools/fonts/fetch.mjs --only ${it.src.id}（要联网，一次即可）`);
      if (sha256File(p) !== it.src.sha256) throw new CliError('contract.font-source-sha256', `${p} 的 sha256 与锁定不符`, `删掉它后重跑 node tools/fonts/fetch.mjs --only ${it.src.id}`);
      srcInfo.set(it.src.id, { path: p, info: fontInfo(fs.readFileSync(p)) });
    }
    // 2. 逐字核对原始字体的覆盖：缺字立即失败，列出全部缺的字（不生成任何文件）
    const missing = [];
    for (const it of items) {
      const cm = srcInfo.get(it.src.id).info.cmap;
      const miss = it.cps.filter(cp => !cm.has(cp));
      if (miss.length) missing.push({ family: it.family, source: it.src.id, chars: miss.map(cp => ({ char: String.fromCodePoint(cp), codepoint: hexcp(cp) })) });
    }
    if (missing.length) {
      throw new CliError('contract.missing-glyphs',
        `缺字：${missing.map(m => `${m.family}（${m.source}）没有 ${m.chars.map(c => `「${c.char}」${c.codepoint}`).join('、')}`).join('；')}`,
        { hint: '改文案，或在 film.json 的 fonts 里给这个字族换一款覆盖更全的锁定字体（例如 noto-sans-sc）；页面绝不回退系统字体', data: { missing } });
    }
    // 3. 子集化（Python fontTools，离线）；临时文件放在输出目录下，成功、失败、中断都删
    const py = await findFontPython({ python: ctx.opts.python, env: ctx.env });
    fs.mkdirSync(outDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(outDir, '.subset-'));
    const undoTmp = ctx.onCleanup(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const outputs = [];
    try {
      const timeoutSec = ctx.opts.timeout ?? 300;
      const manifest = { schemaVersion: 1, generator: GEN, film: filmId, inputs: sha256(JSON.stringify(items.map(x => [x.family, x.src.id, x.src.sha256, x.weight, x.chars, GEN]))), fontTools: py.fontTools, fonts: [], licenses: [], coverage: [] };
      const licenses = new Map();
      for (const it of items) {
        const src = srcInfo.get(it.src.id);
        let from = src.path;
        const epoch = Math.floor(Date.parse(it.src.source?.committed || '2020-01-01T00:00:00Z') / 1000);
        if (it.src.variable) {   // 可变字体先定成静态实例：文件更小，页面里字重也唯一
          from = path.join(tmp, `${slug(it.family)}-instance.ttf`);
          await runPy(py, ['-m', 'fontTools.varLib.instancer', src.path, `wght=${it.weight}`, '-o', from, '-q'], { what: `${it.src.id} 定字重 ${it.weight} `, epoch, timeoutSec, onCleanup: ctx.onCleanup });
        }
        const txt = path.join(tmp, `${slug(it.family)}.txt`);
        fs.writeFileSync(txt, it.chars, 'utf8');
        const dst = path.join(outDir, it.file), dstTmp = path.join(tmp, it.file);
        await runPy(py, ['-m', 'fontTools.subset', from, `--text-file=${txt}`, `--output-file=${dstTmp}`, '--flavor=woff2',
          '--layout-features=*', '--name-IDs=*', '--name-languages=*', '--name-legacy', '--notdef-outline', '--no-hinting', '--drop-tables+=DSIG'],
        { what: `${it.family} 子集化`, epoch, timeoutSec, onCleanup: ctx.onCleanup });
        // 4. 复核产物：子集真的覆盖了全部文字
        const got = fontInfo(fs.readFileSync(dstTmp)).cmap, lost = it.cps.filter(cp => !got.has(cp));
        if (lost.length) throw new CliError('failure.subset-lost-glyphs', `${it.family} 子集化后丢了 ${lost.map(cp => String.fromCodePoint(cp)).join('')}`, 'fontTools 版本或参数有变：用 requirements.lock 锁定的版本（npm run setup）');
        fs.renameSync(dstTmp, dst);
        const lic = path.basename(it.src.licenseFile);
        licenses.set(lic, it.src);
        const sha = sha256File(dst), bytes = fs.statSync(dst).size;
        manifest.fonts.push({
          family: it.family, file: it.file, weight: String(it.weight), style: 'normal',
          chars: it.chars, codepoints: it.cps.length, unicodeRange: unicodeRange(new Set(it.cps)),
          sha256: sha, bytes, texts: it.texts,
          source: { id: it.src.id, family: it.src.family, style: it.src.style, version: it.src.version, sha256: it.src.sha256, license: it.src.license, licenseFile: lic, copyright: it.src.copyright, reservedFontNames: it.src.reservedFontNames || [] },
        });
        outputs.push({ path: rel(dst), sha256: sha, kind: 'font-subset' });
        ctx.log.info(`✓ ${it.family} ← ${it.src.family} ${it.src.version}：${it.cps.length} 个字 → ${rel(dst)}（${bytes} 字节）`);
      }
      // 覆盖率报告：每条文字逐字落在哪个子集里（缺字在第 2 步已经失败，这里全部是 100%）
      for (const it of items) for (const id of it.texts) {
        const t = fam.flatMap(f => f.texts).find(x => x.id === id);
        manifest.coverage.push({ text: id, font: it.family, chars: codepointsOf(t.text).length, covered: codepointsOf(t.text).length, missing: [], source: `${it.src.id}@${it.src.version}` });
      }
      for (const [lic, src] of licenses) {
        const p = path.join(outDir, lic);
        fs.writeFileSync(p, licenseText(src));
        manifest.licenses.push(lic);
        outputs.push({ path: rel(p), sha256: sha256File(p), kind: 'license' });
      }
      // 旧的、本片已不用的子集文件删掉（只删本工具生成的 *.woff2，别的文件不碰）
      const keep = new Set(manifest.fonts.map(f => f.file));
      const mf = path.join(outDir, 'fonts.json');
      let old = [];
      try { old = JSON.parse(fs.readFileSync(mf, 'utf8')).fonts || []; } catch { old = []; }
      for (const f of old) if (f.file && !keep.has(f.file) && /^[\w.-]+\.woff2$/.test(f.file)) fs.rmSync(path.join(outDir, f.file), { force: true });
      fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
      outputs.push({ path: rel(mf), sha256: sha256File(mf), kind: 'manifest' });
      const rows = manifest.coverage.map(c => `${c.text}（${c.font}）${c.covered}/${c.chars}`);
      ctx.log.info(`覆盖率：${rows.join('；')} —— 缺字 0`);
      return { data: { film: filmId, dir: rel(outDir), fontTools: py.fontTools, python: py.source, fonts: manifest.fonts.map(f => ({ family: f.family, file: f.file, codepoints: f.codepoints, bytes: f.bytes, source: `${f.source.id}@${f.source.version}` })), coverage: manifest.coverage }, outputs };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      undoTmp();
    }
  },
});

if (isMain(import.meta.url)) await runCli(command);
