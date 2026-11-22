// 北冥仓库 · beiming-tsl skill 一致性测试（node --test）：library-index 与 engine/offscreen/tsl/*.js 零漂移、
// SKILL.md / subject-routing / workflow-and-debugging / evals 里引用的仓内路径与导出符号真实存在、evals 正负例结构完备。
// 不需要 GPU（纯静态扫描）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanModules, renderIndex } from '../../tools/tsl-skill-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = path.join(ROOT, 'skills/beiming-tsl');
const DOCS = ['SKILL.md', 'references/subject-routing.md', 'references/workflow-and-debugging.md'];
const mods = scanModules();
const exportNames = new Map(mods.map(m => [m.file, new Set(m.exports.map(e => e.name))]));
const allTslSymbols = new Set(mods.flatMap(m => m.exports.map(e => e.name)));
// 宿主层（engine/offscreen/*.mjs）的导出也当真实符号：文档正文会引用 createFilm 这类外壳函数
const hostSymbols = new Set();
for (const e of fs.readdirSync(path.join(ROOT, 'engine/offscreen'), { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
  const src = fs.readFileSync(path.join(ROOT, 'engine/offscreen', e.name), 'utf8');
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)/gm)) hostSymbols.add(m[1]);
}

// ── 1. 索引零漂移 ─────────────────────────────────────────────
test('library-index.md 与 engine/offscreen/tsl/*.js 零漂移', () => {
  const have = fs.readFileSync(path.join(SKILL, 'references/library-index.md'), 'utf8');
  assert.equal(have, renderIndex(mods), '索引过期：跑 node tools/tsl-skill-index.mjs 重新生成');
});

test('tsl-skill-index --check 退出码 0', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/tsl-skill-index.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `--check 失败：${r.stdout}${r.stderr}`);
});

// ── 2. 文档引用的仓内路径存在 ─────────────────────────────────
const REPO_PREFIX = /^(engine|tests|films|tools|docs|lab|routes|skills|assets|cases\/entries)\//;
const isRepoFileRef = s => !/[<>{}$*]/.test(s) && REPO_PREFIX.test(s) && /\.(js|mjs|cjs|json|md|html|toml|png|jpg|txt)$/.test(s);

test('SKILL 与 references 里引用的仓内路径都存在', () => {
  const missing = [];
  for (const rel of DOCS) {
    const file = path.join(SKILL, rel);
    const text = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const refs = new Set();
    for (const m of text.matchAll(/\]\(([^)#\s]+)\)/g)) refs.add(m[1]);          // markdown 链接目标
    for (const m of text.matchAll(/`([^`\n]+)`/g)) refs.add(m[1].trim());       // 反引号里的路径
    for (const ref of refs) {
      const clean = ref.replace(/^[./]+/, '').split(/[?#]/)[0];
      const base = ref.startsWith('./') || ref.startsWith('../') ? path.resolve(dir, ref.split(/[?#]/)[0]) : null;
      const cand = base ?? path.join(ROOT, clean);
      if (base || isRepoFileRef(clean)) {
        if (!fs.existsSync(cand)) missing.push(`${rel} → ${ref}`);
      }
    }
  }
  assert.deepEqual(missing, [], '文档引用了不存在的仓内路径');
});

test('library-index.md 链接的模块路径都存在', () => {
  const text = fs.readFileSync(path.join(SKILL, 'references/library-index.md'), 'utf8');
  const links = [...text.matchAll(/\]\((\.\.\/)+([^\s)]+)\)/g)].map(m => m[2]);
  assert.ok(links.length >= mods.length, '索引表链接数量异常');
  for (const l of links) assert.ok(fs.existsSync(path.join(ROOT, l)), `索引链接失效：${l}`);
});

// ── 3. subject-routing 总表的导出符号真实存在 ─────────────────
test('subject-routing 总表引用的符号都在对应模块的导出里', () => {
  const text = fs.readFileSync(path.join(SKILL, 'references/subject-routing.md'), 'utf8');
  const table = text.split('\n').filter(l => l.startsWith('|') && /engine\/offscreen\/tsl\//.test(l));
  assert.ok(table.length >= 13, `总表行数异常：${table.length}`);
  const bad = [];
  let checked = 0;
  for (const line of table) {
    const cols = line.split('|').map(c => c.trim());
    for (const seg of cols[3]?.split(/；/) ?? []) {                                    // 「模块 A：符号；模块 B：符号」分段
      const modLink = seg.match(/\[([\w-]+\.js)\]\(/);                                // [look.js](../../../engine/...)
      if (!modLink) continue;
      const mod = `engine/offscreen/tsl/${modLink[1]}`;
      // 圆括号（全角）里的是工厂返回的方法名，不是模块导出，不查
      for (const m of seg.replace(/（[^）]*）/g, '').matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
        checked++;
        if (!exportNames.get(mod)?.has(m[1])) bad.push(`${mod} 缺导出 \`${m[1]}\`（表里引用了）`);
      }
    }
  }
  assert.ok(checked >= 20, `总表符号校验覆盖不足：${checked}`);
  assert.deepEqual(bad, [], '总表符号与源码不符');
});

test('subject-routing 正文里 create/make 开头的调用名是真实导出', () => {
  const text = fs.readFileSync(path.join(SKILL, 'references/subject-routing.md'), 'utf8');
  const calls = new Set([...text.matchAll(/`((?:create|make|load|decode|to)[A-Z]\w*)\(/g)].map(m => m[1]));
  assert.ok(calls.size >= 10, `调用符号数异常：${[...calls]}`);
  for (const c of calls) assert.ok(allTslSymbols.has(c) || hostSymbols.has(c), `正文引用了不存在的导出：${c}`);
});

// ── 4. evals 结构合法、正负例完备 ─────────────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

test('evals：每份用例 frontmatter 合法、tags 二选一、正负齐备', () => {
  const dir = path.join(SKILL, 'evals');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort();
  assert.ok(files.length >= 17, `用例数量异常：${files.length}`);
  const themes = new Set();
  const routing = fs.readFileSync(path.join(SKILL, 'references/subject-routing.md'), 'utf8');
  for (const row of routing.split('\n').filter(l => l.startsWith('|') && l.includes('engine/offscreen/tsl/'))) {
    const m = row.split('|')[2]?.match(/`([a-z][a-z-]+)`/);
    if (m) themes.add(m[1]);
  }
  const covered = new Set();
  let pos = 0, neg = 0;
  for (const f of files) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(fm, `${f} 缺 frontmatter`);
    assert.ok(fm.description?.length >= 8, `${f} description 太短`);
    assert.ok(fm.expected_outcome?.length >= 8, `${f} expected_outcome 太短`);
    const tags = fm.tags?.replace(/[[\]]/g, '').split(',').map(s => s.trim()) ?? [];
    assert.equal(tags.length, 1, `${f} tags 要恰好一个 positive/negative`);
    if (tags[0] === 'positive') {
      pos++;
      assert.ok(fm.covers, `${f} 正例要有 covers`);
      for (const id of fm.covers.replace(/[[\]]/g, '').split(',').map(s => s.trim())) {
        assert.ok(themes.has(id), `${f} covers 了不存在的主题 id：${id}`);
        covered.add(id);
      }
    } else if (tags[0] === 'negative') {
      neg++;
    } else assert.fail(`${f} tags 只能是 positive/negative`);
  }
  assert.ok(pos >= 13 && neg >= 4, `正例 ${pos} / 负例 ${neg} 数量不足`);
  assert.deepEqual([...themes].filter(t => !covered.has(t)), [], '正例没有覆盖全部主题 id');
});

// ── 5. 入口脚本在册 ───────────────────────────────────────────
test('package.json 登记 tsl:index 与 tsl:index:check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['tsl:index', 'tsl:index:check']) {
    assert.ok(pkg.scripts?.[name], `缺 script ${name}`);
  }
});
