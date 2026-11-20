import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintContract } from './lint.mjs';

const GOOD_MD = `# 示例契约

版本：0.1.0-draft

## 1. 范围
## 2. 术语
## 3. 结构
## 4. 不变量

| 编号 | 条文 | 怎么查 | 反例文件 |
|---|---|---|---|
| T1 | 帧号必须是整数 | 看类型 | T1-float.json |
| T2 | 已撤 | — | — |

## 5. 口径
## 6. 待定
## 7. 变更记录
`;

function fixture(md, index, files = { 'T1-float.json': '{"frame":1.5}' }) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-lint-'));
  mkdirSync(join(dir, 'counterexamples'));
  writeFileSync(join(dir, 'CONTRACT.md'), md);
  writeFileSync(join(dir, 'counterexamples', 'index.json'), JSON.stringify(index));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'counterexamples', name), body);
  return dir;
}

test('合格的契约没有问题，已撤的条文不要求反例', () => {
  const dir = fixture(GOOD_MD, [{ file: 'T1-float.json', violates: ['T1'], why: '帧号是小数' }]);
  const { problems, counts } = lintContract(dir);
  assert.deepEqual(problems, []);
  assert.equal(counts.invariants, 1);
  rmSync(dir, { recursive: true });
});

test('缺小节、缺反例、反例违反两条、JSON 坏掉，各报一条', () => {
  const md = GOOD_MD.replace('## 6. 待定\n', '').replace('| T2 | 已撤 | — | — |', '| T2 | 帧号不得为负 | 看值 | — |');
  const dir = fixture(md, [{ file: 'T1-float.json', violates: ['T1', 'T2'], why: '两条都违反' }], {
    'T1-float.json': '{"frame":',
  });
  const { problems } = lintContract(dir);
  assert.equal(problems.filter((p) => p.includes('## 6. 待定')).length, 1);
  assert.equal(problems.filter((p) => p.includes('violates 必须正好 1 条')).length, 1);
  assert.equal(problems.filter((p) => p.includes('没有反例：T1、T2')).length, 1);
  assert.equal(problems.filter((p) => p.includes('JSON 解析失败')).length, 1);
  rmSync(dir, { recursive: true });
});
