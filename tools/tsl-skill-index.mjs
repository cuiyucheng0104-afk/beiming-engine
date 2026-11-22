#!/usr/bin/env node
// 北冥仓库 · TSL Skill 索引生成器：静态解析 engine/offscreen/tsl/*.js 的导出符号、模块依赖与文件头摘要，
// 生成 skills/beiming-tsl/references/library-index.md（不要手改那份文件）。
//   node tools/tsl-skill-index.mjs            重新生成索引
//   node tools/tsl-skill-index.mjs --check    索引与源码漂移时 exit 1（CI / tests/offscreen/tsl-skill.test.mjs 用）
//   node tools/tsl-skill-index.mjs --json     机器可读的结构（测试核对符号用）
// 解析只用正则扫源码文本，不 import 模块（那些文件要宿主注入 THREE / TSL 才能求值），跨平台用 node:path。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'engine/offscreen/tsl');
const OUT_FILE = path.join(ROOT, 'skills/beiming-tsl/references/library-index.md');
const PREFIX = '// 北冥引擎 · 离屏出片 · ';

const repoRel = p => path.relative(ROOT, p).split(path.sep).join('/');
const resolveDep = (fromFile, spec) => {
  if (!spec.startsWith('.')) return spec;
  const base = path.resolve(path.dirname(fromFile), spec);
  return repoRel(base);
};

// 解析一个模块的导出与 import 依赖（正则扫文本，覆盖仓库里实际用到的全部导出写法）
export function parseModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = repoRel(file);
  const exports = [];
  const seen = new Set();
  const add = (name, kind) => { if (!seen.has(name)) { seen.add(name); exports.push({ name, kind }); } };

  const fn = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(fn)) add(m[1], 'function');
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], 'const');
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1], 'class');
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    const reExport = !!m[2];
    for (const part of m[1].split(',')) {
      const as = part.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = (as ? as[1] : part.trim()).trim();
      if (name) add(name, reExport ? 're-export' : 'const');
    }
  }
  if (/^export\s+default\s+/m.test(src)) add('default', 'default');

  const deps = [];
  const im = /^import\s+(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\})?\s*(?:[\w$]+)?\s*from\s*['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(im)) deps.push(resolveDep(file, m[1]));

  const head = src.split('\n', 1)[0] ?? '';
  const summary = head.startsWith(PREFIX) ? head.slice(PREFIX.length).replace(/\s*$/, '') : '';
  return { file: rel, summary, exports, deps };
}

export function scanModules(dir = SRC_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js'))
    .map(e => parseModule(path.join(dir, e.name)))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function renderIndex(mods) {
  const lines = [
    '# 北冥 TSL 模块与符号索引',
    '',
    '由 `node tools/tsl-skill-index.mjs` 从 `engine/offscreen/tsl/*.js` 静态生成，不要手改；源码改了就重跑生成（漂移会被 `--check` 与 `tests/offscreen/tsl-skill.test.mjs` 拦下）。',
    '模块职责、参数与调用时机见 [subject-routing.md](subject-routing.md)；怎么调试见 [workflow-and-debugging.md](workflow-and-debugging.md)。',
    '',
    '| 模块 | 导出 | 依赖 | 摘要 |',
    '|---|---|---|---|',
  ];
  for (const m of mods) {
    const syms = m.exports.map(e => `\`${e.name}\`${e.kind === 're-export' ? '（转出口）' : ''}`).join('、') || '—';
    const deps = m.deps.map(d => `\`${d}\``).join('、') || '—';
    lines.push(`| [\`${m.file}\`](../../../${m.file}) | ${syms} | ${deps} | ${m.summary} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const spec = { check: { type: 'bool' }, json: { type: 'bool' }, help: { type: 'bool', short: 'h' } };
const HELP = `北冥仓库 · TSL Skill 索引生成器

用法：node tools/tsl-skill-index.mjs [--check|--json]
  （缺省）写入 ${repoRel(OUT_FILE)}
  --check  只比对不写入：索引与源码漂移时 exit 1 并列出差异模块
  --json   把解析结果打到 stdout（符号核对用），不写文件
`;

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const hit = a.startsWith('--') && spec[a.slice(2)];
    if (a === '-h' || a === '--help') { console.log(HELP); return 0; }
    if (!hit) { console.error(`未知参数：${a}\n\n${HELP}`); return 2; }
    opts[a.slice(2)] = true;
  }
  const mods = scanModules();
  if (opts.json) { console.log(JSON.stringify(mods, null, 2)); return 0; }
  const want = renderIndex(mods);
  if (opts.check) {
    const have = fs.readFileSync(OUT_FILE, 'utf8');
    if (have === want) { console.log(`tsl-index: 与 engine/offscreen/tsl/*.js 一致（${mods.length} 个模块）`); return 0; }
    console.error(`tsl-index: ${repoRel(OUT_FILE)} 与 engine/offscreen/tsl/*.js 漂移；跑 node tools/tsl-skill-index.mjs 重新生成`);
    return 1;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, want);
  console.log(`tsl-index: 写入 ${repoRel(OUT_FILE)}（${mods.length} 个模块）`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(main());
