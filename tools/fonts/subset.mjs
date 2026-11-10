#!/usr/bin/env node
// 按作品实际要画的文字，从锁定的完整 OFL 字体离线生成本片的字体子集：films/<名>/fonts/*.woff2 + fonts.json 清单 + 许可全文。
// 文字来源是 film.json 的 texts（画面文字白名单：页面只画这里登记的字）与 fonts[].extra；字族与原始字体的对应在 fonts[]。
// 缺字（原始字体里没有）直接失败并列出是哪个字，绝不静默回退到系统字体；--check 只核对已有子集是否覆盖当前文字。
// 页面端用 engine/style/fonts.js 读同一份清单并在画字前核对覆盖，两头用同一套码位。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, CliError, EXIT, ROOT, rel, onCleanup, sha256File, sha256 } from '../lookdev/lib/cli.mjs';
import { loadLock, cacheDir, fontById, findPython, licenseText } from './lock.mjs';
import { fontInfo } from './sfnt.mjs';
import { codepointsOf, unicodeRange } from '../../engine/style/fonts.js';

const USAGE = `
用法：node tools/fonts/subset.mjs <作品目录> [--check] [--cache <目录>] [--python <解释器>] [--json]
  按 film.json 的 texts / fonts 为本片生成字体子集：<作品目录>/fonts/<字族>.woff2、fonts.json（清单）、OFL 许可全文。
  film.json 里这样写：
    "fonts": [ { "family": "BM Title", "source": "ma-shan-zheng" },
               { "family": "BM Text", "source": "noto-sans-sc", "weight": 300, "extra": "0123456789" } ],
    "texts": [ { "id": "title", "text": "晨渡", "font": "BM Title" } ]
  source 是 fonts/fonts.lock.json 里的 id；weight 给可变字体定字重（定成静态实例，更小）；extra 是要额外收的字（数字等动态文字）。
  --check   不生成，只核对现有子集：覆盖不了当前文字、文件被改、原始字体换了版本都算过期（退出码 4）
  --cache   原始字体缓存目录（默认环境变量 BEIMING_FONT_CACHE，否则 .cache/fonts）；先跑 node tools/fonts/fetch.mjs
  --python  装了 fontTools、brotli 的 Python（默认环境变量 PYTHON，其次 BEIMING_PYTHON、旧名 BEIMING_PY、仓库 .venv、python3）
退出码：0 成功；2 用法错误；3 缺原始字体或缺 Python 依赖；4 film.json 不合格、缺字、子集过期；1 子集化本身失败。
`;

const GEN = 'tools/fonts/subset.mjs@1';
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';
const hexcp = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

function readFilm(dir) {
  const fj = path.join(dir, 'film.json');
  if (!fs.existsSync(fj)) throw new CliError(EXIT.USAGE, 'not-a-film', `${rel(dir)} 下没有 film.json`, '参数要给作品目录，例如 films/chendu');
  let film;
  try { film = JSON.parse(fs.readFileSync(fj, 'utf8')); } catch (e) { throw new CliError(EXIT.CONTRACT, 'film-json', `film.json 不是合法 JSON：${e.message}`); }
  const fonts = film.fonts, texts = film.texts;
  const bad = m => new CliError(EXIT.CONTRACT, 'film-fonts', `film.json：${m}`, '格式见 node tools/fonts/subset.mjs --help');
  if (!Array.isArray(fonts) || !fonts.length) throw bad('缺 fonts（字族 → 原始字体的对应），画面上有字就必须声明');
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
    if (ids.has(t.id)) throw bad(`texts 的 id 重复：${t.id}`); ids.add(t.id);
    if (/\{\{[A-Z_]+\}\}/.test(t.text)) throw bad(`texts.${t.id} 还是占位符 ${t.text}（模版要先经 tools/new-film.mjs 生成作品）`);
    if (!fam.has(t.font)) throw bad(`texts.${t.id} 用了没声明的字族 ${JSON.stringify(t.font)}`);
    fam.get(t.font).texts.push(t);
  }
  return { film, fam: [...fam.values()] };
}

function plan(lock, fam) {
  return fam.map(f => {
    const src = fontById(lock, f.source);
    const text = f.texts.map(t => t.text).join('') + (f.extra || '');
    const cps = codepointsOf(text).sort((a, b) => a - b);
    let weight = f.weight ?? src.weight;
    if (Array.isArray(weight)) weight = weight[0];
    if (src.variable) {
      const ax = (src.axes || []).find(a => a.tag === 'wght');
      if (f.weight === undefined) throw new CliError(EXIT.CONTRACT, 'film-fonts', `字族 ${f.family} 用的 ${src.id} 是可变字体，要写 weight（${ax ? `${ax.min}–${ax.max}` : '字重'}）`);
      if (ax && (f.weight < ax.min || f.weight > ax.max)) throw new CliError(EXIT.CONTRACT, 'film-fonts', `字族 ${f.family} 的 weight ${f.weight} 超出 ${src.id} 的范围 ${ax.min}–${ax.max}`);
    } else if (f.weight !== undefined && f.weight !== src.weight) {
      throw new CliError(EXIT.CONTRACT, 'film-fonts', `字族 ${f.family} 写了 weight ${f.weight}，但 ${src.id} 是固定字重 ${src.weight} 的字体`, '换成同族的对应字重（如 barlow-light / barlow-medium）');
    }
    const file = `${slug(f.family)}-${weight}.woff2`;
    return { family: f.family, src, weight, cps, chars: String.fromCodePoint(...cps), file, texts: f.texts.map(t => t.id) };
  });
}

const inputHash = (p) => sha256(JSON.stringify(p.map(x => [x.family, x.src.id, x.src.sha256, x.weight, x.chars, GEN])));

function checkExisting(outDir, items) {
  const mf = path.join(outDir, 'fonts.json'), stale = [];
  if (!fs.existsSync(mf)) return [`没有 ${rel(mf)}`];
  let M;
  try { M = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return [`${rel(mf)} 不是合法 JSON`]; }
  for (const it of items) {
    const e = (M.fonts || []).find(f => f.family === it.family);
    if (!e) { stale.push(`清单里没有字族 ${it.family}`); continue; }
    const have = new Set(codepointsOf(e.chars || ''));
    const miss = it.cps.filter(cp => !have.has(cp));
    if (miss.length) stale.push(`${it.family} 缺 ${miss.map(cp => `「${String.fromCodePoint(cp)}」`).join('')}`);
    if (!e.source || e.source.sha256 !== it.src.sha256) stale.push(`${it.family} 的原始字体换了（锁定 ${it.src.id} ${it.src.version}）`);
    if (String(e.weight) !== String(it.weight)) stale.push(`${it.family} 的字重从 ${e.weight} 改成了 ${it.weight}`);
    const fp = path.join(outDir, e.file || '');
    if (!e.file || !fs.existsSync(fp)) stale.push(`缺文件 ${e.file}`);
    else if (sha256File(fp) !== e.sha256) stale.push(`${e.file} 和清单记的 sha256 不一致（被改过）`);
  }
  return stale;
}

await runCli({
  command: 'fonts:subset',
  usage: USAGE,
  spec: { check: 'bool', cache: 'string', python: 'string' },
  async main({ opts, args, out, log }) {
    if (args.length !== 1) throw new CliError(EXIT.USAGE, 'usage', args.length ? `只接受一个作品目录，收到 ${args.length} 个` : '缺作品目录', '例如 node tools/fonts/subset.mjs films/chendu');
    const dir = path.resolve(args[0]), outDir = path.join(dir, 'fonts');
    const lock = loadLock(), { film, fam } = readFilm(dir), items = plan(lock, fam);

    if (opts.check) {
      const stale = checkExisting(outDir, items);
      if (stale.length) throw new CliError(EXIT.CONTRACT, 'subset-stale', `字体子集过期：${stale.join('；')}`, `重跑 node tools/fonts/subset.mjs ${rel(dir)}`);
      log(`✓ ${rel(outDir)} 覆盖 film.json 的全部文字`);
      return { film: film.id ?? path.basename(dir), fonts: items.map(it => ({ family: it.family, codepoints: it.cps.length })) };
    }

    // 1. 原始字体在缓存里、哈希对
    const cdir = cacheDir(lock, opts.cache), srcInfo = new Map();
    for (const it of items) {
      if (srcInfo.has(it.src.id)) continue;
      const p = path.join(cdir, it.src.file);
      if (!fs.existsSync(p)) throw new CliError(EXIT.ENV, 'font-source-missing', `缓存里没有原始字体 ${it.src.file}（${cdir}）`, `先跑 node tools/fonts/fetch.mjs --only ${it.src.id}`);
      if (sha256File(p) !== it.src.sha256) throw new CliError(EXIT.CONTRACT, 'font-source-mismatch', `${p} 的 sha256 与锁定不符`, `删掉它后重跑 node tools/fonts/fetch.mjs --only ${it.src.id}`);
      srcInfo.set(it.src.id, { path: p, info: fontInfo(fs.readFileSync(p)) });
    }
    // 2. 逐字核对原始字体的覆盖（缺字立即失败，列出全部缺的字）
    const missing = [];
    for (const it of items) {
      const cm = srcInfo.get(it.src.id).info.cmap;
      const miss = it.cps.filter(cp => !cm.has(cp));
      if (miss.length) missing.push({ family: it.family, source: it.src.id, chars: miss.map(cp => `「${String.fromCodePoint(cp)}」${hexcp(cp)}`) });
    }
    if (missing.length) {
      throw Object.assign(new CliError(EXIT.CONTRACT, 'missing-glyphs',
        `缺字：${missing.map(m => `${m.family}（${m.source}）没有 ${m.chars.join('、')}`).join('；')}`,
        '改文案，或在 film.json 的 fonts 里给这个字族换一个覆盖更全的锁定字体（例如 noto-sans-sc）'), { data: { missing } });
    }
    // 3. 子集化（Python fontTools，离线）；临时文件放在输出目录下，结束或中断都删
    const py = findPython(opts.python);
    fs.mkdirSync(outDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(outDir, '.subset-'));
    onCleanup(() => fs.rmSync(tmp, { recursive: true, force: true }));
    // fontTools 写文件时会把 head.modified 改成当前时间；固定 SOURCE_DATE_EPOCH，同样的输入永远得到逐字节相同的子集
    const runPy = (pyArgs, what, epoch) => {
      const env = { ...process.env, SOURCE_DATE_EPOCH: String(epoch) };
      const r = spawnSync(py.cmd, [...py.args, ...pyArgs], { encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 16 << 20, env });
      if (r.error || r.status !== 0) throw new CliError(r.error && r.error.code === 'ETIMEDOUT' ? EXIT.TIMEOUT : EXIT.RUN, 'fonttools-failed', `${what}失败：${(r.error && r.error.message) || (r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`, '确认 fontTools 版本（requirements 锁定的版本）后重试');
    };
    const manifest = { schemaVersion: 1, generator: GEN, film: film.id ?? path.basename(dir), inputs: inputHash(items), fontTools: py.version, fonts: [], licenses: [] };
    const licenses = new Map();
    for (const it of items) {
      const src = srcInfo.get(it.src.id);
      let from = src.path;
      const epoch = Math.floor(Date.parse(it.src.source?.committed || '2020-01-01T00:00:00Z') / 1000);
      if (it.src.variable) {   // 可变字体先定成静态实例：文件更小，页面里字重也唯一
        from = path.join(tmp, `${slug(it.family)}-instance.ttf`);
        runPy(['-m', 'fontTools.varLib.instancer', src.path, `wght=${it.weight}`, '-o', from, '-q'], `${it.src.id} 定字重 ${it.weight} `, epoch);
      }
      const txt = path.join(tmp, `${slug(it.family)}.txt`);
      fs.writeFileSync(txt, it.chars, 'utf8');
      const dst = path.join(outDir, it.file), dstTmp = path.join(tmp, it.file);
      runPy(['-m', 'fontTools.subset', from, `--text-file=${txt}`, `--output-file=${dstTmp}`, '--flavor=woff2',
        '--layout-features=*', '--name-IDs=*', '--name-languages=*', '--name-legacy', '--notdef-outline', '--no-hinting', '--drop-tables+=DSIG'], `${it.family} 子集化`, epoch);
      // 4. 复核产物：子集真的覆盖了全部文字
      const got = fontInfo(fs.readFileSync(dstTmp)).cmap, lost = it.cps.filter(cp => !got.has(cp));
      if (lost.length) throw new CliError(EXIT.RUN, 'subset-lost-glyphs', `${it.family} 子集化后丢了 ${lost.map(cp => String.fromCodePoint(cp)).join('')}`, '报给维护者：fontTools 版本或参数有变');
      fs.renameSync(dstTmp, dst);
      const lic = path.basename(it.src.licenseFile);
      licenses.set(lic, it.src);
      manifest.fonts.push({
        family: it.family, file: it.file, weight: String(it.weight), style: 'normal',
        chars: it.chars, codepoints: it.cps.length, unicodeRange: unicodeRange(new Set(it.cps)),
        sha256: sha256File(dst), bytes: fs.statSync(dst).size, texts: it.texts,
        source: { id: it.src.id, family: it.src.family, style: it.src.style, version: it.src.version, sha256: it.src.sha256, license: it.src.license, licenseFile: lic, copyright: it.src.copyright, reservedFontNames: it.src.reservedFontNames || [] },
      });
      out(dst, 'font-subset');
      log(`✓ ${it.family} ← ${it.src.family} ${it.src.version}：${it.cps.length} 个字 → ${rel(dst)}（${fs.statSync(dst).size} 字节）`);
    }
    for (const [lic, src] of licenses) { const p = path.join(outDir, lic); fs.writeFileSync(p, licenseText(src)); manifest.licenses.push(lic); out(p, 'license'); }
    // 旧的、本片已不用的子集文件删掉（只删本工具生成的 *.woff2，别的文件不碰）
    const keep = new Set(manifest.fonts.map(f => f.file));
    const old = fs.existsSync(path.join(outDir, 'fonts.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'fonts.json'), 'utf8')).fonts || [] : [];
    for (const f of old) if (f.file && !keep.has(f.file) && /\.woff2$/.test(f.file)) fs.rmSync(path.join(outDir, f.file), { force: true });
    const mf = path.join(outDir, 'fonts.json');
    fs.writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
    out(mf, 'manifest');
    return { film: manifest.film, dir: rel(outDir), fonts: manifest.fonts.map(f => ({ family: f.family, file: f.file, codepoints: f.codepoints, bytes: f.bytes, source: `${f.source.id}@${f.source.version}` })) };
  },
});
