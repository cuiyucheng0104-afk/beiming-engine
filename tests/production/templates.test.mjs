// docs/routes/templates/ 里的样例与模板：film.json v2 样例合格；运行记录模板是「未执行」且两种口径都合格；
// 审片记录样例原样抄用必然无效（占位符），防止被当成用户认可；契约文档引用的模板都存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateFilm } from '../../engine/production/film.js';
import { validateRenderResult } from '../../engine/production/project.js';
import { validateReview } from '../../engine/production/review.js';
import { REPO } from './helpers.mjs';

const T = name => JSON.parse(readFileSync(join(REPO, 'docs', 'routes', 'templates', name), 'utf8'));

test('film.json v2 样例通过校验，与 engine/production/README.md 的示例一致', () => {
  const f = T('film.json');
  const r = validateFilm(f, { checkFiles: false });
  assert.deepEqual(r.diagnostics, []);
  const md = readFileSync(join(REPO, 'engine', 'production', 'README.md'), 'utf8');
  const inDoc = JSON.parse(/```json\n([\s\S]*?)```/.exec(md)[1]);
  const { $comment, ...rest } = f;
  assert.deepEqual(rest, inDoc);
});

test('运行记录模板是未执行的记录：默认与严格口径都没有诊断', () => {
  const run = T('run.json');
  assert.equal(run.status, 'not-run');
  assert.deepEqual(validateRenderResult(run).diagnostics, []);
  assert.deepEqual(validateRenderResult(run, { strict: true }).diagnostics, []);
  // 预填成功就报错
  assert.ok(validateRenderResult({ ...run, creativeAcceptance: { status: 'accepted', reviews: [] } }).diagnostics.some(d => d.code === 'result-prefilled'));
});

test('审片记录样例原样抄用无效：原话、出处、文件哈希都是占位符', () => {
  const codes = validateReview(T('review.json')).diagnostics.filter(d => d.level === 'error').map(d => d.code);
  for (const c of ['review-quote-placeholder', 'review-source-ref', 'review-files']) assert.ok(codes.includes(c), c);
});

test('contracts.md 引用的模板与实现文件都存在', () => {
  const md = readFileSync(join(REPO, 'docs', 'routes', 'contracts.md'), 'utf8');
  const links = [...md.matchAll(/\]\(([^)#\s]+)\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l));
  assert.ok(links.length > 10);
  for (const l of links) assert.ok(existsSync(join(REPO, 'docs', 'routes', ...l.split('/'))), `链接不存在：${l}`);
});
