// 概念种子表（ccore-concepts）的格式与来源自检：只查表本身，不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('./ccore-concepts/', import.meta.url);
const [head, ...lines] = readFileSync(new URL('concepts.tsv', dir), 'utf8').trimEnd().split('\n');
const COLS = ['id', 'split', 'domain', 'level', 'voxel', 'title', 'compare', 'hedge', 'interactive', 'prompt'];
const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [COLS[i], v])));

test('表头固定，每行 10 列', () => {
  assert.equal(head, COLS.join('\t'));
  for (const l of lines) assert.equal(l.split('\t').length, COLS.length, l.slice(0, 60));
});

test('400 条、编号唯一、50 个领域各 8 条', () => {
  assert.equal(rows.length, 400);
  assert.equal(new Set(rows.map((r) => r.id)).size, 400);
  const per = Object.groupBy(rows, (r) => r.domain);
  assert.equal(Object.keys(per).length, 50);
  for (const [d, rs] of Object.entries(per)) assert.equal(rs.length, 8, d);
});

test('字段值域：难度 1–8、标记 0/1、划分 train|val、提示词和标题非空', () => {
  for (const r of rows) {
    assert.match(r.level, /^[1-8]$/, r.id);
    for (const k of ['voxel', 'compare', 'hedge', 'interactive']) assert.match(r[k], /^[01]$/, `${r.id}.${k}`);
    assert.match(r.split, /^(train|val)$/, r.id);
    assert.ok(r.title.trim() && r.prompt.trim().length >= 18, r.id);
  }
  assert.deepEqual([...new Set(rows.map((r) => r.level))].sort(), ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('来源许可文件在位且是 CCORE 的 MIT', () => {
  const lic = readFileSync(new URL('LICENSE-upstream.txt', dir), 'utf8');
  assert.match(lic, /MIT License/);
  assert.match(lic, /Copyright \(c\) 2026 CCORE/);
});
