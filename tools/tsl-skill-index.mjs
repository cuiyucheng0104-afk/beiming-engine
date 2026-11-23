#!/usr/bin/env node
// 北冥仓库 · TSL Skill 索引生成器：静态解析 engine/offscreen/tsl/*.js 的导出符号、模块依赖与文件头摘要，
// 生成 skills/beiming-tsl/references/library-index.md（不要手改那份文件）。
//   node tools/tsl-skill-index.mjs            重新生成索引
//   node tools/tsl-skill-index.mjs --check    只核对：索引与源码漂移时退出 4（CI 与 tests/offscreen/tsl-skill.test.mjs 用）
// 命令约定见 docs/CLI.md（tools/lib/cli.mjs）——--json 时 stdout 只有一个信封对象；--help 打印用法、不碰任何文件。
// 解析只用正则扫源码文本，不 import 模块（那些文件要宿主注入 THREE / TSL 才能求值），跨平台用 node:path。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from './lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'engine/offscreen/tsl');
const OUT_FILE = path.join(ROOT, 'skills/beiming-tsl/references/library-index.md');
const PREFIX = '// 北冥引擎 · 离屏出片 · ';
const OUT_REL = 'skills/beiming-tsl/references/library-index.md';

const repoRel = p => path.relative(ROOT, p).split(path.sep).join('/');
const resolveDep = (fromFile, spec) => {
  if (!spec.startsWith('.')) return spec;
  return repoRel(path.resolve(path.dirname(fromFile), spec));
};

// 解析一个模块的导出与 import 依赖（正则扫文本，覆盖仓库里实际用到的全部导出写法）
export function parseModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = repoRel(file);
  const exports = [];
  const seen = new Set();
  const add = (name, kind) => { if (!seen.has(name)) { seen.add(name); exports.push({ name, kind }); } };

  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) add(m[1], 'function');
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
  for (const m of src.matchAll(/^import\s+(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\})?\s*(?:[\w$]+)?\s*from\s*['"]([^'"]+)['"]/gm)) deps.push(resolveDep(file, m[1]));

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

export const command = defineCommand({
  name: 'tsl-skill-index',
  summary: '生成 / 核对 beiming-tsl skill 的 TSL 模块符号索引（engine/offscreen/tsl/*.js → skills/beiming-tsl/references/library-index.md）',
  usage: ['node tools/tsl-skill-index.mjs [--check]'],
  description: [
    '不带参数：静态解析 engine/offscreen/tsl/*.js 的导出符号、模块依赖与文件头摘要，重写 library-index.md（生成物，别手改）。',
    '--check：只核对不写文件；索引与源码漂移时退出 4。',
    '测试 tests/offscreen/tsl-skill.test.mjs 同时用它的导出（scanModules / renderIndex）做零漂移与符号核对。',
  ],
  options: {
    check: { type: 'boolean', describe: '只核对，不写文件（漂移时退出 4）' },
  },
  exitCodes: { 0: '成功', 2: '用法错误', 4: '核对不通过（索引与 engine/offscreen/tsl/*.js 漂移）' },
  examples: ['node tools/tsl-skill-index.mjs --check'],
  run(ctx) {
    const mods = scanModules();
    if (ctx.opts.check) {
      const have = fs.readFileSync(OUT_FILE, 'utf8');
      if (have !== renderIndex(mods)) {
        throw new CliError('contract.stale', `${OUT_REL} 与 engine/offscreen/tsl/*.js 漂移`, '运行 node tools/tsl-skill-index.mjs 重新生成，再提交生成物；不要手改');
      }
      ctx.out(`tsl-index: 与 engine/offscreen/tsl/*.js 一致（${mods.length} 个模块）`);
      return { data: { modules: mods.length } };
    }
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, renderIndex(mods));
    ctx.out(`tsl-index: 写入 ${OUT_REL}（${mods.length} 个模块）`);
    return { data: { modules: mods.length } };
  },
});

if (isMain(import.meta.url)) runCli(command);
