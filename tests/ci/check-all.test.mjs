// tools/check-all.mjs：步骤的选择与别名、阻塞与只报告、退出码按最重的取（附录 C1）、--json 信封（C2）、
// 必需工具缺失时报环境问题、内置语法检查（JS / JSON / Python / sh）只查仓库自己的文件。
// 夹具是临时目录里的小仓库，里面的 repo-check、work-plan 等都是几行的替身脚本，用退出码模拟各种结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeRepo, runNode, CHECK_ALL, python, WIN } from './helpers.mjs';

const CHANGELOG = '# 更新日志\n\n## [Unreleased]\n\n### Added\n\n- 一条\n\n[Unreleased]: https://example.com\n';
const exitWith = (code, line) => `console.log(${JSON.stringify(line)});\nprocess.exit(${code});\n`;
const base = (over = {}) => ({
  'tools/repo-check.mjs': exitWith(0, '✓ 0 个错误'),
  'tools/work-plan.mjs': exitWith(0, '计划有效'),
  'tools/c-styles.mjs': exitWith(0, 'STYLES.md 已是最新'),
  'tools/casebook.py': 'print("OK: 0 records")\n',
  'CHANGELOG.md': CHANGELOG,
  'tests/a/a.test.mjs': `import test from 'node:test';\ntest('ok', () => {});\n`,
  'engine/x.js': 'export const x = 1;\n',
  'data/ok.json': '{"a": 1}\n',
  ...over,
});
const FAST = ['--skip', 'lint'];   // lint 只报告，测试里不依赖本机有没有装 eslint / ruff
const NO_PY = python() ? [] : ['--skip', 'cases,directing'];

test('--help 只打印用法、exit 0；未知步骤 exit 2 并列出可用步骤', async () => {
  const h = await runNode(CHECK_ALL, ['--help', '--root', '/不存在的目录']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /用法：node tools\/check-all\.mjs/);
  const r = await runNode(CHECK_ALL, ['--only', 'nosuch', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'USAGE');
  assert.match(r.json.error.hint, /repo、plan、tests/);
});

test('--list：只列步骤与命令，不执行；lint 是 eslint + ruff 的别名', async () => {
  const r = await runNode(CHECK_ALL, ['--list', '--only', 'lint,plan', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.steps.map(s => [s.id, s.blocking, s.status]), [['plan', true, 'listed'], ['eslint', false, 'listed'], ['ruff', false, 'listed']]);
  assert.match(r.stderr, /node tools\/work-plan\.mjs --check/);
});

test('全部通过：exit 0；测试步骤带上 run-tests 的汇总', { skip: !python() && '没有 Python' }, async t => {
  const { root, cleanup } = makeRepo(base());
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, ...FAST, '--json'], { timeoutMs: 300000 });
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(r.json.steps.map(s => [s.id, s]));
  assert.deepEqual(Object.keys(by), ['repo', 'plan', 'tests', 'styles', 'cases', 'directing', 'syntax', 'changelog']);
  for (const id of ['repo', 'plan', 'tests', 'styles', 'cases', 'syntax', 'changelog']) assert.equal(by[id].status, 'pass', `${id}：${by[id].reason}`);
  assert.equal(by.directing.status, 'skip', '没有 tools/check_directing_docs.py 时跳过');
  assert.equal(by.tests.details.summary.tests, 1);
  assert.equal(by.changelog.details.unreleasedEntries, 1);
});

test('有阻塞步骤失败：exit 1，信封列出失败的步骤，--fail-fast 后面的不再运行', async t => {
  const { root, cleanup } = makeRepo(base({ 'tools/work-plan.mjs': exitWith(1, '✗ T03 写入范围重叠') }));
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, '--only', 'repo,plan,styles', '--json']);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'CHECKS_FAILED');
  assert.match(r.json.error.message, /plan（工程计划）/);
  assert.equal(r.json.steps.find(s => s.id === 'plan').reason, '✗ T03 写入范围重叠');
  const ff = await runNode(CHECK_ALL, ['--root', root, '--only', 'plan,styles', '--fail-fast', '--json']);
  assert.deepEqual(ff.json.steps.map(s => s.status), ['fail', 'not-run']);
});

test('退出码取最重的：环境缺失（3）优先于契约（4）与失败（1）；子命令用法错误记成 check-all 自己的失败', async t => {
  const { root, cleanup } = makeRepo(base({
    'tools/repo-check.mjs': exitWith(4, '契约不通过'), 'tools/work-plan.mjs': exitWith(1, '失败'), 'tools/c-styles.mjs': exitWith(2, '用法错误'),
  }));
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, '--only', 'repo,plan,styles', '--json']);
  assert.equal(r.code, 4);
  assert.deepEqual(r.json.steps.map(s => s.exitCode), [4, 1, 1]);
  assert.match(r.json.steps[2].reason, /用法错误/);
  const missing = makeRepo(base({ 'tools/repo-check.mjs': null }));
  t.after(missing.cleanup);
  const m = await runNode(CHECK_ALL, ['--root', missing.root, '--only', 'repo,plan', '--json']);
  assert.equal(m.code, 3);
  assert.match(m.json.steps[0].reason, /缺少 tools\/repo-check\.mjs/);
});

test('语法检查：找出坏的 JS、JSON、Python、sh；不查 cases/、fixtures/、out/', { skip: !python() && '没有 Python' }, async t => {
  const { root, cleanup } = makeRepo(base({
    'engine/bad.js': 'export const = 1;\n',
    'data/bad.json': '{ 坏 }\n',
    'tools/bad.py': 'def f(:\n    pass\n',
    'tools/bad.sh': 'if then fi\n',
    'cases/old/x.js': 'export const = 1;\n',
    'tests/a/fixtures/broken.js': 'export const = 1;\n',
    'out/tmp.json': '{',
    'data/bom.json': '﻿{"ok": true}\n',
  }));
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, '--only', 'syntax', '--json']);
  assert.equal(r.code, 1, r.stderr);
  const files = r.json.steps[0].details.failures.map(f => f.file).sort();
  const want = ['data/bad.json', 'engine/bad.js', 'tools/bad.py', ...(WIN ? [] : ['tools/bad.sh'])].sort();
  assert.deepEqual(files.filter(f => !(WIN && f === 'tools/bad.sh')), want);
  assert.equal(r.json.steps[0].details.failures.find(f => f.file === 'tools/bad.py').line, 1);
});

test('lint 只报告：没装 eslint / ruff 时跳过并写明怎么装，不影响退出码', async t => {
  const { root, cleanup } = makeRepo(base());
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, '--only', 'eslint,changelog', '--json'], { env: { NODE_PATH: '' } });
  assert.equal(r.code, 0, r.stderr);
  const eslint = r.json.steps.find(s => s.id === 'eslint');
  assert.equal(eslint.blocking, false);
  assert.equal(eslint.status, 'skip');
  assert.match(eslint.reason, /devDependencies/);
});

test('更新日志不合规时 changelog 步骤失败（契约 4）', async t => {
  const { root, cleanup } = makeRepo(base({ 'CHANGELOG.md': '# 更新日志\n\n## [1.0.0]\n' }));
  t.after(cleanup);
  const r = await runNode(CHECK_ALL, ['--root', root, '--only', 'changelog', ...NO_PY, '--json']);
  assert.equal(r.code, 4);
  assert.match(r.json.steps[0].reason, /结构问题/);
});

test('--root 指向不存在的目录：exit 2', async () => {
  const r = await runNode(CHECK_ALL, ['--root', path.join('不存在', '的目录'), '--json']);
  assert.equal(r.code, 2);
});
