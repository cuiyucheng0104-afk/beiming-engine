// tools/run-tests.mjs：发现范围（不进 cases/、films/、fixtures/）、按域筛选、退出码（附录 C1）、--json 信封（C2）、超时与中断的清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, parseTap, discover, CliError, EXIT, isMain } from '../../tools/run-tests.mjs';
import { makeRepo, runNode, RUN_TESTS, REPO, python, alive, waitFor, WIN } from './helpers.mjs';

const PASS_NODE = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('一加一', () => assert.equal(1 + 1, 2));\ntest('字符串', () => assert.equal('北' + '冥', '北冥'));\n`;
const FAIL_NODE = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('能过的', () => {});\ntest('故意失败', () => assert.equal(1, 2));\n`;
const PASS_PY = `import unittest\nfrom helper_b import double\n\nclass T(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(2), 4)\n\n    def test_utf8(self):\n        print('中文输出不出错')\n        self.assertTrue(True)\n`;
const FAIL_PY = `import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n\n    def test_broken(self):\n        self.assertEqual(1, 2)\n`;
const BOOM = `throw new Error('不该被运行');\n`;

const passRepo = () => makeRepo({
  'tests/alpha/a.test.mjs': PASS_NODE,
  'tests/alpha/fixtures/broken.test.mjs': BOOM,            // fixtures/ 不被发现
  'tests/beta/test_b.py': PASS_PY,
  'tests/beta/helper_b.py': 'def double(x):\n    return 2 * x\n',
  'tests/gamma/suite.json': JSON.stringify({ requires: ['gpu'] }),
  'tests/gamma/g.test.mjs': BOOM,                           // 要 GPU，默认整组跳过
  'tests/README.md': '不是测试\n',
  'tools/x.test.mjs': PASS_NODE,
  'tools/sub/y.test.mjs': PASS_NODE,
  'tools/test_tool.py': 'import unittest\n\nclass U(unittest.TestCase):\n    def test_x(self):\n        self.assertIn("冥", "北冥")\n',
  'cases/old/test.js': BOOM,                                // 历史作品自带的测试：不跑
  'cases/old/x.test.mjs': BOOM,
  'films/demo/z.test.mjs': BOOM,
  'node_modules/pkg/q.test.mjs': BOOM,
});

test('--help 只打印用法、exit 0，不碰任何文件', async () => {
  const r = await runNode(RUN_TESTS, ['--help', '--root', '/这个目录不存在']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法：node tools\/run-tests\.mjs/);
  assert.equal(r.stderr, '');
});

test('未知参数 exit 2；--json 时 stdout 是唯一一个信封对象', async () => {
  const r = await runNode(RUN_TESTS, ['--no-such-flag']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不认识的参数 --no-such-flag/);
  const j = await runNode(RUN_TESTS, ['--no-such-flag', '--json']);
  assert.equal(j.code, 2);
  assert.ok(j.json, `stdout 应是 JSON：${j.stdout}`);
  assert.deepEqual(Object.keys(j.json).slice(0, 7), ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']);
  assert.equal(j.json.ok, false);
  assert.equal(j.json.exitCode, 2);
  assert.equal(j.json.error.code, 'USAGE');
});

test('发现：只进 tests/ 与 tools/，跳过 cases/、films/、fixtures/、node_modules/', async t => {
  const { root, cleanup } = passRepo();
  t.after(cleanup);
  const suites = discover(root);
  assert.deepEqual(suites.map(s => s.id), ['alpha:node', 'beta:python', 'gamma:node', 'tools:node', 'tools:python']);
  assert.deepEqual(suites.find(s => s.id === 'tools:node').files, ['tools/sub/y.test.mjs', 'tools/x.test.mjs']);
  assert.deepEqual(suites.find(s => s.id === 'gamma:node').config, { requires: ['gpu'] });
  const r = await runNode(RUN_TESTS, ['--root', root, '--list', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.suites.find(s => s.id === 'gamma:node').status, 'skip');
  assert.match(r.json.suites.find(s => s.id === 'gamma:node').skipReason, /gpu/);
});

test('全部通过：exit 0，计数正确，要 GPU 的组跳过并写明原因', { skip: !python() && '没有 Python' }, async t => {
  const { root, cleanup } = passRepo();
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(r.json.suites.map(s => [s.id, s]));
  assert.equal(by['alpha:node'].status, 'pass');
  assert.equal(by['alpha:node'].counts.tests, 2);
  assert.equal(by['beta:python'].status, 'pass');
  assert.equal(by['beta:python'].counts.tests, 2);
  assert.equal(by['tools:node'].counts.tests, 4);
  assert.equal(by['tools:python'].counts.pass, 1);
  assert.equal(by['gamma:node'].status, 'skip');
  assert.equal(r.json.summary.fail, 0);
  assert.ok(r.json.warnings.some(w => /gamma:node 已跳过/.test(w)));
  assert.doesNotMatch(r.stderr, /不该被运行/);
});

test('--only / --skip 按域筛选；不存在的域 exit 2，加 --if-present 只提示', async t => {
  const { root, cleanup } = passRepo();
  t.after(cleanup);
  const only = await runNode(RUN_TESTS, ['--root', root, '--only', 'alpha', '--json']);
  assert.equal(only.code, 0, only.stderr);
  assert.deepEqual(only.json.suites.map(s => s.id), ['alpha:node']);
  const skip = await runNode(RUN_TESTS, ['--root', root, '--list', '--skip', 'alpha,beta', '--skip', 'gamma', '--json']);
  assert.deepEqual(skip.json.suites.map(s => s.domain), ['tools', 'tools']);
  const bad = await runNode(RUN_TESTS, ['--root', root, '--only', 'nosuch', '--json']);
  assert.equal(bad.code, 2);
  assert.match(bad.json.error.message, /nosuch/);
  assert.match(bad.json.error.message, /alpha、beta、gamma、tools/);
  const soft = await runNode(RUN_TESTS, ['--root', root, '--only', 'nosuch', '--if-present', '--json']);
  assert.equal(soft.code, 0);
  assert.ok(soft.json.warnings.some(w => /nosuch/.test(w)));
});

test('有失败：exit 1，失败的测试名与位置进信封', { skip: !python() && '没有 Python' }, async t => {
  const { root, cleanup } = makeRepo({ 'tests/alpha/a.test.mjs': FAIL_NODE, 'tests/beta/test_b.py': FAIL_PY });
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--json']);
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'TESTS_FAILED');
  const node = r.json.suites.find(s => s.id === 'alpha:node'), py = r.json.suites.find(s => s.id === 'beta:python');
  assert.equal(node.status, 'fail');
  assert.deepEqual(node.failures.map(f => f.name), ['故意失败']);
  assert.match(node.failures[0].location, /a\.test\.mjs:\d+:\d+$/);
  assert.equal(py.status, 'fail');
  assert.equal(py.counts.fail, 1);
  assert.match(py.failures[0].name, /test_broken/);
  assert.equal(r.json.summary.fail, 2);
});

test('--bail：第一组失败后剩下的标为未运行', async t => {
  const { root, cleanup } = makeRepo({ 'tests/a/a.test.mjs': FAIL_NODE, 'tests/b/b.test.mjs': PASS_NODE });
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--bail', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.suites.map(s => s.status), ['fail', 'not-run']);
});

test('--grep 只跑名字匹配的测试', async t => {
  const { root, cleanup } = makeRepo({ 'tests/alpha/a.test.mjs': FAIL_NODE });
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--grep', '能过', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.suites[0].counts.pass, 1);
});

test('环境：--require 缺能力 exit 3，未知能力 exit 2；找不到 Python 而有 Python 测试 exit 3', async t => {
  const { root, cleanup } = makeRepo({ 'tests/alpha/a.test.mjs': PASS_NODE, 'tests/beta/test_b.py': FAIL_PY });
  t.after(cleanup);
  const gpu = await runNode(RUN_TESTS, ['--root', root, '--require', 'gpu', '--json'], { env: { BEIMING_TEST_GPU: '' } });
  assert.equal(gpu.code, 3);
  assert.equal(gpu.json.error.code, 'ENV_MISSING');
  const unknown = await runNode(RUN_TESTS, ['--root', root, '--require', 'teleport', '--json']);
  assert.equal(unknown.code, 2);
  const nopy = await runNode(RUN_TESTS, ['--root', root, '--python', path.join(root, 'no-python-here'), '--json']);
  assert.equal(nopy.code, 3);
  assert.equal(nopy.json.error.code, 'PYTHON_MISSING');
});

test('一个测试也没发现 exit 4；suite.json 写坏了这一组判失败', async t => {
  const empty = makeRepo({ 'README.md': '空\n', 'tests/only-fixtures/fixtures/a.test.mjs': PASS_NODE });
  t.after(empty.cleanup);
  const r = await runNode(RUN_TESTS, ['--root', empty.root, '--json']);
  assert.equal(r.code, 4);
  assert.equal(r.json.error.code, 'NO_TESTS');
  const bad = makeRepo({ 'tests/x/suite.json': '{ 坏 json', 'tests/x/a.test.mjs': PASS_NODE });
  t.after(bad.cleanup);
  const b = await runNode(RUN_TESTS, ['--root', bad.root, '--json']);
  assert.equal(b.code, 1);
  assert.match(b.json.suites[0].skipReason, /suite\.json 不合法/);
});

const HANG = `import test from 'node:test';\nimport fs from 'node:fs';\ntest('卡住', async () => {\n  fs.writeFileSync(process.env.BM_PIDFILE, String(process.pid));\n  await new Promise(() => setInterval(() => {}, 1000));\n});\n`;

test('超时：exit 124，整棵进程树被结束', async t => {
  const { root, cleanup } = makeRepo({ 'tests/slow/hang.test.mjs': HANG });
  t.after(cleanup);
  const pidFile = path.join(root, 'pid.txt');
  const r = await runNode(RUN_TESTS, ['--root', root, '--timeout', '3', '--json'], { env: { BM_PIDFILE: pidFile }, timeoutMs: 60000 });
  assert.equal(r.code, 124, r.stderr);
  assert.equal(r.json.error.code, 'TIMEOUT');
  assert.equal(r.json.suites[0].status, 'timeout');
  assert.ok(r.ms < 30000, `用时 ${r.ms} ms`);
  const pid = +fs.readFileSync(pidFile, 'utf8');
  assert.ok(await waitFor(() => !alive(pid), 10000), `测试进程 ${pid} 仍在`);
});

test('收到 SIGINT：结束子进程、输出信封、exit 130', { skip: WIN && 'Windows 没有 POSIX 信号' }, async t => {
  const { root, cleanup } = makeRepo({ 'tests/slow/hang.test.mjs': HANG });
  t.after(cleanup);
  const pidFile = path.join(root, 'pid.txt');
  const child = spawn(process.execPath, [RUN_TESTS, '--root', root, '--json'], { env: { ...process.env, BM_PIDFILE: pidFile, GITHUB_ACTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.resume();
  const done = new Promise(r => child.on('close', code => r(code)));
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')), '测试没有启动');
  const pid = +fs.readFileSync(pidFile, 'utf8');
  child.kill('SIGINT');
  assert.equal(await done, 130);
  const j = JSON.parse(out);
  assert.equal(j.exitCode, 130);
  assert.equal(j.error.code, 'INTERRUPTED');
  assert.ok(await waitFor(() => !alive(pid), 10000), `测试进程 ${pid} 仍在`);
});

test('经目录联接 / 符号链接调用时照常工作（入口判断按真实路径）', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-alias-'));
  const alias = path.join(base, '工具 别名');
  fs.symlinkSync(path.join(REPO, 'tools'), alias, WIN ? 'junction' : 'dir');
  t.after(() => { if (WIN) fs.rmdirSync(alias); else fs.unlinkSync(alias); fs.rmdirSync(base); });
  const r = await runNode(path.join(alias, 'run-tests.mjs'), ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法/);
  assert.equal(isMain(new URL('file:///不是入口.mjs').href), false);
});

test('parseArgs：逗号与重复合并、--x=v、缺值与类型错误报用法错误', () => {
  const spec = { only: { type: 'list' }, json: { type: 'bool' }, timeout: { type: 'int' }, root: { type: 'string' }, help: { type: 'bool', short: 'h' } };
  const o = parseArgs(['--only', 'a,b', '--only=c', '--json', '--timeout', '5', '-h', '--root=x'], spec);
  assert.deepEqual(o.only, ['a', 'b', 'c']);
  assert.equal(o.json, true); assert.equal(o.timeout, 5); assert.equal(o.help, true); assert.equal(o.root, 'x');
  for (const bad of [['--only'], ['--timeout', '0'], ['--timeout', 'x'], ['--json=1'], ['--nope'], ['-x'], ['stray'], ['--root', '--json']]) {
    assert.throws(() => parseArgs(bad, spec), e => e instanceof CliError && e.exitCode === EXIT.USAGE, bad.join(' '));
  }
});

test('parseTap：计数取汇总行，失败只记叶子测试', () => {
  const tap = [
    'TAP version 13', '# Subtest: 通过', 'ok 1 - 通过', '  ---', '  duration_ms: 0.7', '  ...',
    '# Subtest: 失败的测试', 'not ok 2 - 失败的测试', '  ---', "  location: '/x/a.test.mjs:4:1'", "  failureType: 'testCodeFailure'", '  error: |-', '    Expected 1 to equal 2', '  ...',
    'ok 3 - 跳过 # SKIP 缺浏览器', '# Subtest: 分组', '    not ok 1 - 子测试失败', '      ---', "      location: '/x/a.test.mjs:6:3'", "      failureType: 'testCodeFailure'", "      error: 'boom'", '      ...',
    'not ok 4 - 分组', '  ---', "  failureType: 'subtestsFailed'", '  ...', 'not ok 5 - 待办 # TODO 以后', '1..5',
    '# tests 6', '# suites 0', '# pass 2', '# fail 3', '# cancelled 0', '# skipped 1', '# todo 1', '# duration_ms 39.2',
  ].join('\n');
  const { counts, failures } = parseTap(tap);
  assert.deepEqual(counts, { tests: 6, suites: 0, pass: 2, fail: 3, cancelled: 0, skipped: 1, todo: 1, duration_ms: 39.2 });
  assert.deepEqual(failures.map(f => [f.name, f.location, f.message]), [
    ['失败的测试', '/x/a.test.mjs:4:1', 'Expected 1 to equal 2'],
    ['子测试失败', '/x/a.test.mjs:6:3', 'boom'],
  ]);
});
