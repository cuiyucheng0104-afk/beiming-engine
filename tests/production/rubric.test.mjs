// docs/creative-review/ 的文档与代码同一套取值：维度、否决项、层、优先级（engine/production/vocab.js）、
// 问题条目 schema（issue.schema.json ⇄ review.js 的 validateIssue）、状态文字（state.js 的 STATE_LABELS）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUE_LAYERS, ISSUE_PRIORITIES, ISSUE_STATUSES, RUBRIC_DIMENSIONS, VETOES } from '../../engine/production/vocab.js';
import { RECORD_GATES, validateIssue } from '../../engine/production/review.js';
import { STATE_LABELS } from '../../engine/production/state.js';
import { REPO } from './helpers.mjs';

const doc = name => readFileSync(join(REPO, 'docs', 'creative-review', name), 'utf8');

test('只有一把尺子：vocab.js 的维度与否决项 = 评分标尺 docs/quality/RUBRIC.md 的小节 = 验收题库的评分表', async () => {
  const quality = readFileSync(join(REPO, 'docs', 'quality', 'RUBRIC.md'), 'utf8');
  // 评分标尺 §2 的六个小节标题，顺序与 vocab 相同
  const heads = [...quality.matchAll(/^### 2\.(\d) (.+)$/gm)].map(m => m[2].trim());
  assert.deepEqual(heads, Object.values(RUBRIC_DIMENSIONS));
  // 一票否决：评分标尺 §3 的表逐行对得上（标尺写「断帧或闪帧」，题库写同一句）
  for (const label of Object.values(VETOES)) assert.ok(quality.includes(`| ${label} |`), `评分标尺 §3 缺「${label}」`);
  // 验收题库的评分表（tools/eval/lib/scoring.mjs）：id 与标题都相同
  const { VISUAL_DIMS, VETOES: EVAL_VETOES } = await import('../../tools/eval/lib/scoring.mjs');
  assert.deepEqual(VISUAL_DIMS.map(d => [d.id, d.title]), Object.entries(RUBRIC_DIMENSIONS));
  assert.deepEqual(EVAL_VETOES.map(v => [v.id, v.title]), Object.entries(VETOES));
});

test('docs/creative-review/RUBRIC.md 只写落分方法，不另立标尺：列出全部 id、链到评分标尺，层与优先级与 vocab.js 一致', () => {
  const md = doc('RUBRIC.md');
  assert.match(md, /\.\.\/quality\/RUBRIC\.md/);
  for (const [id, label] of Object.entries(RUBRIC_DIMENSIONS)) assert.ok(md.includes(`| \`${id}\` | ${label} |`), `维度 ${id}「${label}」`);
  for (const [id, label] of Object.entries(VETOES)) assert.ok(md.includes(`| \`${id}\` | ${label} |`), `否决项 ${id}「${label}」`);
  for (const [id, label] of Object.entries(ISSUE_LAYERS)) assert.ok(md.includes(`\`${id}\` | ${label} |`), `层 ${id}「${label}」`);
  for (const p of ISSUE_PRIORITIES) assert.ok(md.includes(`| \`${p}\` |`), p);
  for (const s of ISSUE_STATUSES) assert.ok(md.includes(`\`${s}\``), s);
  // 不写锚点分档表（那是评分标尺的事）：本页没有「| 10 |」「| 8 |」这样的锚点行
  assert.doesNotMatch(md, /^\| (10|8|6|4|2) \|/m);
});

test('issue.schema.json 的取值与 vocab.js 一致，必填项与 validateIssue 一致', () => {
  const s = JSON.parse(doc('issue.schema.json'));
  assert.deepEqual(s.properties.layer.enum, Object.keys(ISSUE_LAYERS));
  assert.deepEqual(s.properties.dimension.enum, Object.keys(RUBRIC_DIMENSIONS));
  assert.deepEqual(s.properties.priority.enum, ISSUE_PRIORITIES);
  assert.deepEqual(s.properties.status.enum, ISSUE_STATUSES);
  assert.deepEqual(s.required.sort(), ['layer', 'priority', 'problem']);
  const film = { output: { frameCount: 240 }, shots: [{ id: 'A' }, { id: 'B' }] };
  const ok = { id: 'R1', frame: 101, shot: 'B', region: [0.4, 0.3, 0.1, 0.1], layer: 'performance', dimension: 'narrative', problem: '发丝穿过镜框', fix: '收短发丝路径', priority: 'P2', evidence: ['review/strips/b.jpg'], status: 'open' };
  assert.deepEqual(validateIssue(ok, { film }), []);
  for (const k of Object.keys(ok)) assert.ok(Object.hasOwn(s.properties, k), `schema 缺字段 ${k}`);
  for (const [bad, code] of [[{ layer: 'colour' }, 'issue-layer'], [{ priority: 'high' }, 'issue-priority'], [{ frame: 240 }, 'issue-frames'], [{ frames: [10, 20] }, 'issue-frames'], [{ problem: '' }, 'issue-problem'], [{ region: [0, 0, 2, 1] }, 'issue-region'], [{ shot: 'Z' }, 'issue-shot']]) {
    assert.ok(validateIssue({ ...ok, ...bad }, { film }).some(d => d.code === code), JSON.stringify(bad));
  }
  const range = { ...ok }; delete range.frame; range.frames = [96, 106];
  assert.deepEqual(validateIssue(range, { film }), []);
});

test('README.md 的状态文字与关口和 state.js / review.js 一致；同目录的文档都在', () => {
  const md = doc('README.md');
  for (const label of Object.values(STATE_LABELS)) assert.ok(md.includes(label), `状态文字「${label}」`);
  for (const g of RECORD_GATES) assert.ok(md.includes(`\`${g}\``), `关口 ${g}`);
  for (const f of ['SOP.md', 'RUBRIC.md', 'review.template.md', 'issue.schema.json']) assert.ok(existsSync(join(REPO, 'docs', 'creative-review', f)), f);
  // 送审单模板的评分表覆盖全部维度
  const tpl = doc('review.template.md');
  for (const [id, label] of Object.entries(RUBRIC_DIMENSIONS)) assert.ok(tpl.includes(`\`${id}\` ${label}`), `送审单缺 ${id}`);
});
