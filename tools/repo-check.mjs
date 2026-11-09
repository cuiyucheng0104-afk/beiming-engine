#!/usr/bin/env node
// 北冥仓库 · 仓库规范检查（只读，给 agent 与 CI 用）：npm run check:repo   或   node tools/repo-check.mjs [--json]
// 不改任何文件、不渲染。每一项独立检查，某一路缺东西只报错不崩溃；有错误时退出码 1，只有提示时退出码 0。
//
// 检查项：
//   1 手册     routes/README.md 存在；routes/{a-webgl,b-native,c-style}/README.md 存在且 8 个二级标题齐全、按顺序
//   2 模版     routes/<路线>/template/ 存在；film.json 字段合法（route 与目录对应、title 必须是 "{{TITLE}}"、dur > 0、
//              fps 正整数、size = [偶数宽, 偶数高]）；有 README.md；文本文件里的 {{…}} 只能是 {{NAME}} / {{TITLE}}
//   3 链接     routes/ 与 films/ 下所有 .md 的相对链接能解析到仓库里的文件或目录；
//              模版里的链接按复制后的位置（films/<名字>/）解析，因为模版是给那个深度写的
//   4 引擎注释 engine/ 下每个 .js / .mjs / .py 文件开头（第一行代码之前）有注释块，且注释里有中文
//   5 内部代号 规则：内部工程代号（raea）只允许出现在已有的历史目录（examples/raea、docs/raea）与 npm 命令名里。
//              a) 仓库里除这两个历史目录外，任何目录名、routes/ 与 films/ 下任何文件名都不得含 raea
//              b) routes/ 下 .md 的正文不得出现 raea；只有代码（行内 `…`、``` 代码块）和链接地址（](…) 里）可以写，
//                 用来指向已有目录、命令或环境变量（如 `examples/raea/`、`npm run raea:render`、`RAEA_BIN`）
//   6 作品     films/ 下每个目录都有合法 film.json（route ∈ a/b/c、title 非空且不是占位符），且不残留占位符
//   7 命令     package.json 的 scripts 里有 new 与 check:repo
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

export const ROUTE_DIRS = { a: 'routes/a-webgl', b: 'routes/b-native', c: 'routes/c-style' };
export const SECTIONS = ['这条路线是什么', '最快上手', '一部作品的目录', '能力清单', '契约', '验收', '边界与常见坑', '参考作品'];
const ALLOWED_PH = new Set(['NAME', 'TITLE']);
const CODENAME = /raea/i;
const LEGACY_CODENAME_DIRS = new Set(['examples/raea', 'docs/raea']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', '__pycache__', '.claude']);
const TEXT_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.py', '.sh', '.txt',
  '.glsl', '.wgsl', '.wesl', '.toml', '.yaml', '.yml', '.svg']);
const CJK = /[一-鿿]/;

const results = [];   // { group, level: 'ok'|'err'|'warn', msg }
const ok = (g, m) => results.push({ group: g, level: 'ok', msg: m });
const err = (g, m) => results.push({ group: g, level: 'err', msg: m });
const warn = (g, m) => results.push({ group: g, level: 'warn', msg: m });

const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const abs = r => path.join(ROOT, r);
const exists = r => fs.existsSync(abs(r));
function walk(dir, { files = true, dirs = false } = {}, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (dirs) out.push(p); walk(p, { files, dirs }, out); }
    else if (e.isFile() && files) out.push(p);
  }
  return out;
}
const isText = f => TEXT_EXT.has(path.extname(f).toLowerCase());

function guard(group, fn) {
  try { fn(); } catch (e) { err(group, `检查本身出错（${e.message}）——按报错修好对应文件后再跑`); }
}

// ── 1 手册 ──
function checkManuals() {
  const G = '手册';
  if (exists('routes/README.md')) ok(G, 'routes/README.md'); else err(G, 'routes/README.md 缺失：三路线总指引');
  for (const [k, d] of Object.entries(ROUTE_DIRS)) {
    const f = `${d}/README.md`;
    if (!exists(f)) { err(G, `${f} 缺失：路线 ${k} 的手册还没写（必须有 8 节：${SECTIONS.join(' / ')}）`); continue; }
    const heads = fs.readFileSync(abs(f), 'utf8').replace(/```[\s\S]*?```/g, '').split('\n')
      .filter(l => /^## /.test(l)).map(l => l.slice(3).trim());
    const missing = SECTIONS.filter(s => !heads.includes(s));
    if (missing.length) { err(G, `${f} 缺少二级标题：${missing.map(s => `「## ${s}」`).join(' ')}（标题要照抄）`); continue; }
    const order = SECTIONS.map(s => heads.indexOf(s));
    if (order.some((v, i) => i && v < order[i - 1])) { err(G, `${f} 8 节齐全但顺序不对：应为 ${SECTIONS.join(' → ')}`); continue; }
    ok(G, `${f} 8 节齐全`);
  }
}

// ── film.json 校验（模版与作品共用）──
function validateFilmJson(file, { route, template }) {
  const probs = [];
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return [`不是合法 JSON（${e.message}）`]; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['顶层必须是对象'];
  if (route ? j.route !== route : !['a', 'b', 'c'].includes(j.route)) probs.push(`route 应为 ${route ? `"${route}"` : '"a" / "b" / "c"'}，现在是 ${JSON.stringify(j.route)}`);
  if (template) { if (j.title !== '{{TITLE}}') probs.push(`title 应为 "{{TITLE}}"（由 new-film 替换），现在是 ${JSON.stringify(j.title)}`); }
  else if (typeof j.title !== 'string' || !j.title.trim() || /\{\{/.test(j.title)) probs.push(`title 应为非空标题，现在是 ${JSON.stringify(j.title)}`);
  if (!(typeof j.dur === 'number' && j.dur > 0 && Number.isFinite(j.dur))) probs.push(`dur 应为正数（秒），现在是 ${JSON.stringify(j.dur)}`);
  if (!(Number.isInteger(j.fps) && j.fps > 0)) probs.push(`fps 应为正整数，现在是 ${JSON.stringify(j.fps)}`);
  const s = j.size;
  if (!(Array.isArray(s) && s.length === 2 && s.every(v => Number.isInteger(v) && v >= 16 && v % 2 === 0)))
    probs.push(`size 应为 [宽, 高]，都是 ≥16 的偶数（H.264 yuv420p 要求），现在是 ${JSON.stringify(s)}`);
  return probs;
}
function placeholderProblems(dir) {
  const out = [];
  for (const f of walk(dir)) {
    if (!isText(f)) continue;
    const bad = [...fs.readFileSync(f, 'utf8').matchAll(/\{\{\s*([^{}\s]*)\s*\}\}/g)].map(m => m[1]).filter(n => !ALLOWED_PH.has(n));
    if (bad.length) out.push(`${rel(f)} 用了不允许的占位符 ${[...new Set(bad)].map(n => `{{${n}}}`).join(' ')}（只允许 {{NAME}} / {{TITLE}}）`);
  }
  return out;
}

// ── 2 模版 ──
function checkTemplates() {
  const G = '模版';
  for (const [k, d] of Object.entries(ROUTE_DIRS)) {
    const t = `${d}/template`;
    if (!exists(t)) { err(G, `${t}/ 缺失：路线 ${k} 还没有模版（new-film ${k} 会失败）`); continue; }
    const fj = `${t}/film.json`;
    if (!exists(fj)) { err(G, `${fj} 缺失`); continue; }
    const probs = validateFilmJson(abs(fj), { route: k, template: true });
    for (const p of probs) err(G, `${fj}：${p}`);
    if (!exists(`${t}/README.md`)) err(G, `${t}/README.md 缺失（三五行：改哪里、怎么出片）`);
    const ph = placeholderProblems(abs(t));
    for (const p of ph) err(G, p);
    if (!probs.length && exists(`${t}/README.md`) && !ph.length) ok(G, `${t}/ film.json 合法、占位符只用 {{NAME}} / {{TITLE}}`);
  }
}

// ── 3 链接 ──
function mdLinks(txt) {
  const body = txt.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of body.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1]);
  return out;
}
function checkLinks() {
  const G = '链接';
  const files = [...walk(abs('routes')), ...walk(abs('films'))].filter(f => f.endsWith('.md'));
  if (!files.length) { warn(G, 'routes/ 与 films/ 下没有 .md 文件'); return; }
  let bad = 0, n = 0;
  for (const f of files) {
    const r = rel(f);
    // 模版按复制后的位置解析：routes/<路线>/template/x.md → films/<名字>/x.md
    const tm = /^routes\/[^/]+\/template\/(.*)$/.exec(r);
    const baseDir = tm ? path.dirname(abs(`films/__template__/${tm[1]}`)) : path.dirname(f);
    for (const link of new Set(mdLinks(fs.readFileSync(f, 'utf8')))) {
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) continue;   // http: mailto: 锚点
      n++;
      let target = link.split('#')[0].split('?')[0];
      try { target = decodeURIComponent(target); } catch { /* 原样 */ }
      if (!target) continue;
      const p = target.startsWith('/') ? abs(target.slice(1)) : path.resolve(baseDir, target);
      if (!p.startsWith(ROOT + path.sep) && p !== ROOT) { bad++; err(G, `${r}：链接 ${link} 指到仓库外`); continue; }
      if (!fs.existsSync(p)) { bad++; err(G, `${r}：链接 ${link} 解析为 ${rel(p)}，不存在${tm ? '（模版链接按 films/<名字>/ 的深度解析）' : ''}`); }
    }
  }
  if (!bad) ok(G, `${files.length} 个 .md、${n} 条相对链接全部可解析`);
}

// ── 4 引擎注释 ──
function headComment(src, ext) {
  const lines = src.split('\n');
  let i = 0;
  if (lines[0]?.startsWith('#!')) i++;
  const out = [];
  if (ext === '.py') {
    while (i < lines.length && (/^\s*$/.test(lines[i]) || /^#/.test(lines[i]))) out.push(lines[i++]);
    const m = /^\s*[rRuU]?("""|''')/.exec(lines[i] || '');
    if (m) {
      const q = m[1];
      out.push(lines[i]);
      if (!(lines[i].split(q).length > 2)) { i++; while (i < lines.length && !lines[i].includes(q)) out.push(lines[i++]); out.push(lines[i] || ''); }
    }
  } else {
    let inBlock = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (inBlock) { out.push(l); if (l.includes('*/')) inBlock = false; continue; }
      if (/^\s*$/.test(l) || /^\s*\/\//.test(l)) { out.push(l); continue; }
      if (/^\s*\/\*/.test(l)) { out.push(l); inBlock = !l.includes('*/'); continue; }
      break;
    }
  }
  return out.join('\n');
}
function checkEngineHeads() {
  const G = '引擎注释';
  const files = walk(abs('engine')).filter(f => ['.js', '.mjs', '.py'].includes(path.extname(f)));
  if (!files.length) { err(G, 'engine/ 下没有 .js / .mjs / .py 文件'); return; }
  let bad = 0;
  for (const f of files) {
    const h = headComment(fs.readFileSync(f, 'utf8'), path.extname(f));
    if (!h.trim() || !/(\/\/|\/\*|#|"""|''')/.test(h)) { bad++; err(G, `${rel(f)}：开头没有注释块（写明做什么 + 接口）`); }
    else if (!CJK.test(h)) { bad++; err(G, `${rel(f)}：开头注释里没有中文`); }
  }
  if (!bad) ok(G, `engine/ 下 ${files.length} 个模块开头都有中文注释`);
}

// ── 5 内部代号 ──
function proseOf(md) {
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/^\s*\[[^\]]+\]:.*$/gm, '');
}
function checkCodenames() {
  const G = '内部代号';
  let bad = 0;
  for (const d of walk(ROOT, { files: false, dirs: true })) {
    const r = rel(d);
    if (r.startsWith('cases/vendor/') || r.startsWith('cases/source/')) continue;   // 第三方与历史快照，只读
    if (CODENAME.test(path.basename(d)) && !LEGACY_CODENAME_DIRS.has(r)) { bad++; err(G, `目录 ${r}/ 名字含内部代号：新目录用对外名称（历史目录只有 ${[...LEGACY_CODENAME_DIRS].join('、')}）`); }
  }
  for (const top of ['routes', 'films']) {
    for (const f of walk(abs(top))) {
      const r = rel(f);
      if (CODENAME.test(path.basename(f))) { bad++; err(G, `文件 ${r} 名字含内部代号`); }
      if (!f.endsWith('.md') || top !== 'routes') continue;
      const lines = proseOf(fs.readFileSync(f, 'utf8')).split('\n');
      lines.forEach((l, i) => {
        if (CODENAME.test(l)) { bad++; err(G, `${r}（正文约第 ${i + 1} 行）出现内部代号：对外写「北冥原生 · BNE」；指向已有目录 / 命令时放进反引号或链接地址`); }
      });
    }
  }
  if (!bad) ok(G, `目录名与 routes/ 正文没有内部代号（历史目录 ${[...LEGACY_CODENAME_DIRS].join('、')} 与代码 / 链接地址除外）`);
}

// ── 6 作品 ──
function checkFilms() {
  const G = '作品';
  if (!exists('films')) { ok(G, 'films/ 还没有作品（node tools/new-film.mjs <a|b|c> <名字> 新建）'); return; }
  const dirs = fs.readdirSync(abs('films'), { withFileTypes: true }).filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name));
  if (!dirs.length) { ok(G, 'films/ 下没有作品'); return; }
  let bad = 0;
  for (const e of dirs) {
    const d = `films/${e.name}`, fj = `${d}/film.json`;
    if (!exists(fj)) { bad++; err(G, `${fj} 缺失：每部作品根目录要有 film.json`); continue; }
    const probs = validateFilmJson(abs(fj), { template: false });
    for (const p of probs) { bad++; err(G, `${fj}：${p}`); }
    for (const f of walk(abs(d))) {
      if (!isText(f)) continue;
      const left = fs.readFileSync(f, 'utf8').match(/\{\{(NAME|TITLE)\}\}/g);
      if (left) { bad++; err(G, `${rel(f)} 残留占位符 ${[...new Set(left)].join(' ')}：作品应由 tools/new-film.mjs 生成`); }
    }
  }
  if (!bad) ok(G, `films/ 下 ${dirs.length} 部作品的 film.json 都合法`);
}

// ── 7 命令 ──
function checkScripts() {
  const G = '命令';
  const pj = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'));
  for (const s of ['new', 'check:repo']) {
    if (pj.scripts?.[s]) ok(G, `npm run ${s} → ${pj.scripts[s]}`); else err(G, `package.json 的 scripts 缺少 "${s}"`);
  }
}

for (const [g, fn] of [['手册', checkManuals], ['模版', checkTemplates], ['链接', checkLinks], ['引擎注释', checkEngineHeads],
  ['内部代号', checkCodenames], ['作品', checkFilms], ['命令', checkScripts]]) guard(g, fn);

const errs = results.filter(r => r.level === 'err'), warns = results.filter(r => r.level === 'warn');
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !errs.length, errors: errs.length, warnings: warns.length, results }, null, 2));
} else {
  let last = '';
  for (const r of results) {
    if (r.group !== last) { console.log(`\n【${r.group}】`); last = r.group; }
    console.log(`  ${r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✗'} ${r.msg}`);
  }
  console.log(`\n${errs.length ? `✗ ${errs.length} 个错误` : '✓ 全部通过'}${warns.length ? `，${warns.length} 个提示` : ''}`);
}
process.exitCode = errs.length ? 1 : 0;
