#!/usr/bin/env node
// 契约目录的结构检查，口径见 CONVENTIONS.md 第 1、2 节。
// 用法：node beiming/kernel/contracts/lint.mjs [契约目录 …]；不带参数查本目录下全部契约。
// 只查结构（七节、JSON 可解析、不变量和反例一一对上），不查条文内容。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['1. 范围', '2. 术语', '3. 结构', '4. 不变量', '5. 口径', '6. 待定', '7. 变更记录'];

function jsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(e.parentPath, e.name));
}

/** 返回 { problems: string[], counts: { invariants, counterexamples, examples, json } } */
export function lintContract(dir) {
  const problems = [];
  const counts = { invariants: 0, counterexamples: 0, examples: 0, json: 0 };
  const mdPath = join(dir, 'CONTRACT.md');
  if (!existsSync(mdPath)) return { problems: ['没有 CONTRACT.md'], counts };
  const md = readFileSync(mdPath, 'utf8');

  if (!/^版本：\d+\.\d+\.\d+(-draft)?\s*$/m.test(md)) problems.push('缺「版本：x.y.z」这一行');
  for (const s of SECTIONS) {
    const n = md.split('\n').filter((l) => l.trim() === `## ${s}`).length;
    if (n !== 1) problems.push(`小节「## ${s}」应该正好出现 1 次，实际 ${n} 次`);
  }

  // 第 4 节表格的第一列是不变量编号；写了「已撤」的行不算
  const sec4 = md.split(/^## 4\. 不变量\s*$/m)[1]?.split(/^## 5\. 口径\s*$/m)[0] ?? '';
  const ids = [...sec4.matchAll(/^\|\s*`?([A-Z]{1,2}\d+)`?\s*\|(.*)$/gm)]
    .filter((m) => !m[2].includes('已撤'))
    .map((m) => m[1]);
  counts.invariants = ids.length;
  if (ids.length === 0) problems.push('第 4 节没有找到带编号的不变量');
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`不变量编号重复：${[...new Set(dup)].join('、')}`);

  for (const f of jsonFiles(dir)) {
    counts.json++;
    try {
      JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      problems.push(`JSON 解析失败：${relative(dir, f)}（${e.message}）`);
    }
  }

  const exDir = join(dir, 'examples');
  counts.examples = existsSync(exDir) ? jsonFiles(exDir).filter((f) => !f.endsWith('index.json')).length : 0; // examples/index.json 是映射表，不是正例
  if (existsSync(join(dir, 'schema')) && counts.examples === 0) problems.push('有 schema/ 却没有正例');

  const idxPath = join(dir, 'counterexamples', 'index.json');
  if (!existsSync(idxPath)) {
    problems.push('没有 counterexamples/index.json');
    return { problems, counts };
  }
  let index = [];
  try {
    index = JSON.parse(readFileSync(idxPath, 'utf8'));
  } catch {
    return { problems, counts }; // 解析失败上面已经报过
  }
  if (!Array.isArray(index)) {
    problems.push('counterexamples/index.json 必须是数组');
    return { problems, counts };
  }
  counts.counterexamples = index.length;
  const covered = new Set();
  for (const entry of index) {
    const where = `index.json 里的 ${entry?.file ?? '（缺 file）'}`;
    if (typeof entry?.file !== 'string' || !existsSync(join(dir, 'counterexamples', entry.file))) {
      problems.push(`${where}：文件不存在`);
    }
    if (!Array.isArray(entry?.violates) || entry.violates.length !== 1) {
      problems.push(`${where}：violates 必须正好 1 条`);
    } else if (!ids.includes(entry.violates[0])) {
      problems.push(`${where}：violates 写的 ${entry.violates[0]} 不在第 4 节里`);
    } else {
      covered.add(entry.violates[0]);
    }
    if (typeof entry?.why !== 'string' || !entry.why.trim()) problems.push(`${where}：缺 why`);
  }
  const listed = new Set(index.map((e) => e?.file));
  for (const f of readdirSync(join(dir, 'counterexamples'))) {
    if (f !== 'index.json' && !listed.has(f)) problems.push(`反例 ${f} 没有登记进 index.json`);
  }
  const missing = ids.filter((id) => !covered.has(id));
  if (missing.length) problems.push(`这些不变量没有反例：${missing.join('、')}`);

  return { problems, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(here, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(here, e.name, 'CONTRACT.md')))
        .map((e) => join(here, e.name));
  let bad = 0;
  for (const dir of dirs) {
    const { problems, counts } = lintContract(dir);
    const tally = `不变量 ${counts.invariants}，反例 ${counts.counterexamples}，正例 ${counts.examples}，JSON ${counts.json}`;
    console.log(`${problems.length ? '✗' : '✓'} ${dir}：${tally}`);
    for (const p of problems) console.log(`    ${p}`);
    if (problems.length) bad++;
  }
  console.log(`共 ${dirs.length} 份契约，${bad} 份有问题`);
  process.exit(bad ? 1 : 0);
}
