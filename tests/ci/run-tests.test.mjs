// tools/run-tests.mjs：发现范围（不进 cases/、films/、fixtures/）、域的划分、Python 模块名、缺依赖的判定、按域筛选、
// 退出码（附录 C1）、--json 信封（C2）、超时与中断的清理。夹具在临时目录里现场生成（tests/ci/helpers.mjs 的 makeRepo）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, parseTap, discover, domainOf, inScope, CliError, EXIT, isMain } from '../../tools/run-tests.mjs';
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

test('发现：跳过 cases/、films/、fixtures/、node_modules/ 与点开头的目录', async t => {
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

test('发现：与源码放在一起的测试按目录归域（engine/audio → audio；tests/<域> 与同名目录合并）', t => {
  const { root, cleanup } = makeRepo({
    'engine/form/a.test.mjs': PASS_NODE,
    'engine/audio/__init__.py': '', 'engine/audio/test_dsp.py': FAIL_PY,
    'audio/test_mix.py': FAIL_PY,
    'tests/audio/test_more.py': FAIL_PY,
    'tests/engine/b.test.mjs': PASS_NODE,
    'lab/regress.test.mjs': PASS_NODE,
    'top.test.mjs': PASS_NODE,
    '.claude/hooks/h.test.mjs': BOOM, 'engine/.cache/c.test.mjs': BOOM, 'src/__pycache__/test_x.py': BOOM,
    'routes/a/test.js': BOOM, 'engine/notatest.mjs': BOOM,
  });
  t.after(cleanup);
  const got = Object.fromEntries(discover(root).map(s => [s.id, s.files]));
  assert.deepEqual(got, {
    'audio:python': ['audio/test_mix.py', 'engine/audio/test_dsp.py', 'tests/audio/test_more.py'],
    'engine:node': ['engine/form/a.test.mjs', 'tests/engine/b.test.mjs'],
    'lab:node': ['lab/regress.test.mjs'],
    'root:node': ['top.test.mjs'],
  });
});

test('发现：git 检出里按 .gitignore 过滤（未跟踪但没被忽略的新测试也会跑）', { skip: spawnSync('git', ['--version']).status !== 0 && '没有 git' }, t => {
  const { root, cleanup } = makeRepo({
    '.gitignore': 'scratch/\n', 'tests/a/a.test.mjs': PASS_NODE, 'scratch/x.test.mjs': BOOM,
  }, { git: true });
  t.after(cleanup);
  fs.writeFileSync(path.join(root, 'tests/a/new.test.mjs'), PASS_NODE);   // 还没 git add
  assert.deepEqual(discover(root).map(s => [s.id, s.files]), [['a:node', ['tests/a/a.test.mjs', 'tests/a/new.test.mjs']]]);
});

test('Python：包里的测试按点分模块名导入，包内绝对导入可用；两个目录里的同名测试都能跑', { skip: !python() && '没有 Python' }, async t => {
  const { root, cleanup } = makeRepo({
    'engine/audio/__init__.py': '',
    'engine/audio/dsp.py': 'def gain(x):\n    return 2 * x\n',
    'engine/audio/test_dsp.py': 'import unittest\nfrom engine.audio.dsp import gain\n\nclass T(unittest.TestCase):\n    def test_gain(self):\n        self.assertEqual(gain(3), 6)\n        self.assertEqual(__name__, "engine.audio.test_dsp")\n',
    'tests/x/test_same.py': 'import unittest\n\nclass A(unittest.TestCase):\n    def test_a(self):\n        pass\n',
    'tests/y/test_same.py': 'import unittest\n\nclass B(unittest.TestCase):\n    def test_b(self):\n        pass\n',
  });
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(r.json.suites.map(s => [s.id, s.counts]));
  assert.equal(by['audio:python'].pass, 1);
  assert.equal(by['x:python'].pass, 1);
  assert.equal(by['y:python'].pass, 1);
});

test('缺声明过的依赖：exit 3（环境问题）并给出安装命令；没声明的模块找不到仍算测试失败（exit 1）', { skip: !python() && '没有 Python' }, async t => {
  const missingPy = 'import unittest\nimport bm_not_installed_pkg\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        pass\n';
  const missingNode = `import test from 'node:test';\nimport x from 'bm-not-installed-pkg';\ntest('x', () => x);\n`;
  const declared = makeRepo({
    'package.json': JSON.stringify({ name: 'x', private: true, devDependencies: { 'bm-not-installed-pkg': '1.0.0' } }),
    'requirements.txt': '# 注释\nbm_not_installed_pkg==1.0 \\\n    --hash=sha256:00\n',
    'tests/py/test_a.py': missingPy, 'tests/js/a.test.mjs': missingNode, 'tests/ok/a.test.mjs': PASS_NODE,
  });
  t.after(declared.cleanup);
  const r = await runNode(RUN_TESTS, ['--root', declared.root, '--json']);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.json.error.code, 'DEPS_MISSING');
  const by = Object.fromEntries(r.json.suites.map(s => [s.id, s]));
  assert.equal(by['py:python'].status, 'env');
  assert.deepEqual(by['py:python'].missingDeps, ['bm_not_installed_pkg']);
  assert.match(by['py:python'].skipReason, /pip install -r requirements\.txt/);
  assert.equal(by['js:node'].status, 'env');
  assert.deepEqual(by['js:node'].missingDeps, ['bm-not-installed-pkg']);
  assert.match(by['js:node'].skipReason, /npm ci/);
  assert.equal(by['ok:node'].status, 'pass');
  const undeclared = makeRepo({ 'tests/py/test_a.py': missingPy, 'tests/js/a.test.mjs': missingNode });
  t.after(undeclared.cleanup);
  const u = await runNode(RUN_TESTS, ['--root', undeclared.root, '--json']);
  assert.equal(u.code, 1, u.stderr);
  assert.deepEqual(u.json.suites.map(s => s.status), ['fail', 'fail']);
});

test('domainOf / inScope：路径规则', () => {
  assert.equal(domainOf('tests/render/a.test.mjs'), 'render');
  assert.equal(domainOf('tests/a.test.mjs'), 'root');
  assert.equal(domainOf('engine/audio/test_audio.py'), 'audio');
  assert.equal(domainOf('engine/look/look.test.mjs'), 'engine');
  assert.equal(domainOf('tools/repo-check/rules/core/x.test.mjs'), 'tools');
  assert.equal(domainOf('x.test.mjs'), 'root');
  for (const yes of ['engine/a.test.cjs', 'audio/test_x.py', 'site/js/a.test.js']) assert.ok(inScope(yes), yes);
  for (const no of ['cases/a/x.test.mjs', 'films/f/x.test.mjs', 'tests/a/fixtures/x.test.mjs', 'a/node_modules/b/x.test.mjs', 'a/out/x.test.mjs',
    '.github/x.test.mjs', 'tests/a/test.js', 'tests/a/x.mjs', 'tests/a/testx.py', 'tests/a/x_test.py']) assert.ok(!inScope(no), no);
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

test('--skip-grep 按名字隔离测试（Node 与 Python；名字里的括号、点按字面匹配），并写进 warnings', { skip: !python() && '没有 Python' }, async t => {
  const node = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('能过的', () => {});\ntest('R35 很慢（4K.x2）', () => assert.fail('不该运行'));\ntest('R36 4Kax2', () => assert.fail('正则才会匹配到这一条'));\n`;
  const py = 'import unittest\n\nclass Heavy(unittest.TestCase):\n    def test_fast(self):\n        pass\n\n    def test_slow_4k(self):\n        self.fail("不该运行")\n';
  const { root, cleanup } = makeRepo({ 'tests/a/a.test.mjs': node, 'tests/b/test_b.py': py });
  t.after(cleanup);
  const r = await runNode(RUN_TESTS, ['--root', root, '--skip-grep', 'R35 很慢（4K.x2）', '--skip-grep', 'R36', '--skip-grep', 'test_slow_4k', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const by = Object.fromEntries(r.json.suites.map(s => [s.id, s.counts]));
  assert.equal(by['a:node'].pass, 1);
  assert.equal(by['a:node'].fail, 0);
  assert.equal(by['b:python'].tests, 1);
  assert.equal(r.json.warnings.filter(w => /--skip-grep/.test(w)).length, 3);
  // 「4K.x2」按字面只匹配 R35；当正则用会连 R36（4Kax2）也选上
  const one = await runNode(RUN_TESTS, ['--root', root, '--only', 'a', '--grep', '4K.x2', '--json']);
  assert.equal(one.code, 1);
  assert.deepEqual(one.json.suites[0].failures.map(f => f.name), ['R35 很慢（4K.x2）']);
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

test('parseTap：整个文件加载失败时，从它前面的诊断注释里取真正的原因', () => {
  const tap = [
    'TAP version 13', '# 测试自己打印的一行', 'ok 1 - 通过的文件', '  ---', '  ...',
    '# node:internal/modules/package_json_reader:301', "# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'three' imported from /x/b.test.mjs",
    '#     at packageResolve (node:internal/modules/esm/resolve:769:81)', '# Subtest: b.test.mjs', 'not ok 2 - b.test.mjs', '  ---',
    "  location: '/x/b.test.mjs:1:1'", "  failureType: 'testCodeFailure'", "  error: 'test failed'", "  code: 'ERR_TEST_FAILURE'", '  ...',
    '# 无关的输出', 'not ok 3 - c.test.mjs', '  ---', "  failureType: 'testCodeFailure'", "  error: 'test failed'", '  ...', '1..3', '# tests 3', '# fail 2',
  ].join('\n');
  const { failures } = parseTap(tap);
  assert.deepEqual(failures.map(f => f.message), ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'three' imported from /x/b.test.mjs", 'test failed']);
});
