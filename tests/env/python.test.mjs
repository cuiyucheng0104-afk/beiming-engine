// 统一的 Python 解析（tools/env/lib/python.mjs、tools/env/py.mjs）：查找顺序、显式指定坏了不悄悄换、子进程环境。
// 不依赖本机装了哪个 Python：解析逻辑用替身 probe 测；只有最后一组在找得到 Python 3 时才真的起进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidates, resolvePython, pythonEnv, venvPython, probePython } from '../../tools/env/lib/python.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY_MJS = path.join(ROOT, 'tools/env/py.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-py-test-'));

test('查找顺序：BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv → python3 → python（Windows 再加 py -3.12、py -3）', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.venv'));
    const env = { BEIMING_PYTHON: '/a/py', BEIMING_PY: '/b/py', PYTHON: '/c/py' };
    assert.deepEqual(candidates({ env, root, platform: 'darwin' }).map(c => c.source), ['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON', '.venv', 'python3', 'python']);
    const win = candidates({ env: {}, root, platform: 'win32' });
    assert.deepEqual(win.map(c => c.source), ['.venv', 'python3', 'python', 'py -3.12', 'py -3']);
    assert.deepEqual(win.find(c => c.source === 'py -3.12').args, ['-3.12']);
    assert.equal(win[0].cmd, venvPython(path.join(root, '.venv'), 'win32'));
    // 没有 .venv 时不列它；空白的变量当没设
    fs.rmdirSync(path.join(root, '.venv'));
    assert.deepEqual(candidates({ env: { PYTHON: '  ' }, root, platform: 'linux' }).map(c => c.source), ['python3', 'python']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('venvPython：POSIX 在 bin/python，Windows 在 Scripts\\python.exe', () => {
  assert.equal(venvPython('/r/.venv', 'linux'), path.join('/r/.venv', 'bin', 'python'));
  assert.equal(venvPython('/r/.venv', 'darwin'), path.join('/r/.venv', 'bin', 'python'));
  assert.equal(venvPython('/r/.venv', 'win32'), path.join('/r/.venv', 'Scripts', 'python.exe'));
});

const fakeProbe = table => async (cmd, args) => {
  const key = [cmd, ...args].join(' ');
  return table[key] || { ok: false, error: `PATH 里没有 ${cmd}` };
};
const OK312 = { ok: true, path: '/x/python3.12', version: [3, 12, 12], executable: '/x/python3.12', prefix: '/x', basePrefix: '/x' };

test('resolvePython：第一个能运行的胜出；系统候选失败就试下一个', async () => {
  const root = tmp();
  try {
    const r = await resolvePython({ env: {}, root, platform: 'win32', probe: fakeProbe({ 'py -3.12': OK312 }) });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'py -3.12');
    assert.deepEqual(r.args, ['-3.12']);
    assert.deepEqual(r.tried.map(t => [t.source, t.ok]), [['python3', false], ['python', false], ['py -3.12', true]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolvePython：显式指定的变量或 .venv 坏了直接报错，不悄悄换成系统 Python', async () => {
  const root = tmp();
  try {
    const probe = fakeProbe({ python3: OK312 });
    const bad = await resolvePython({ env: { BEIMING_PYTHON: '/nope/python' }, root, platform: 'linux', probe });
    assert.equal(bad.ok, false);
    assert.equal(bad.source, 'BEIMING_PYTHON');
    assert.match(bad.error, /BEIMING_PYTHON=\/nope\/python 无法使用/);
    assert.match(bad.hint, /完整路径|取消这个变量/);
    fs.mkdirSync(path.join(root, '.venv'));
    const venv = await resolvePython({ env: {}, root, platform: 'linux', probe });
    assert.equal(venv.ok, false);
    assert.equal(venv.source, '.venv');
    assert.match(venv.hint, /删掉 \.venv 后重跑 npm run setup/);
    fs.rmdirSync(path.join(root, '.venv'));
    const none = await resolvePython({ env: {}, root, platform: 'linux', probe: fakeProbe({}) });
    assert.equal(none.ok, false);
    assert.match(none.hint, /npm run setup/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pythonEnv：固定 UTF-8 输出，仓库根放在 PYTHONPATH 最前面且不重复', () => {
  const root = path.resolve('/repo');
  const e = pythonEnv({ PYTHONIOENCODING: 'gbk', PYTHONPATH: [root, '/other'].join(path.delimiter), KEEP: '1' }, { root });
  assert.equal(e.PYTHONUTF8, '1');
  assert.equal(e.PYTHONIOENCODING, 'utf-8');
  assert.deepEqual(e.PYTHONPATH.split(path.delimiter), [root, '/other']);
  assert.equal(e.KEEP, '1');
});

test('probePython：不存在的解释器给出可读的错误，不抛异常', async () => {
  const r = await probePython(path.join(os.tmpdir(), `beiming-no-such-python-${process.pid}`));
  assert.equal(r.ok, false);
  assert.match(r.error, /文件不存在/);
  const r2 = await probePython('beiming-no-such-python-xyz', [], { env: { PATH: '' } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /PATH 里没有/);
});

test('py.mjs：--which --json 在显式指定坏解释器时退出 3，信封完整', () => {
  const r = spawnSync(process.execPath, [PY_MJS, '--which', '--json'], { encoding: 'utf8', env: { ...process.env, BEIMING_PYTHON: path.join(os.tmpdir(), 'beiming-missing-python') } });
  assert.equal(r.status, 3);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.exitCode, 3);
  assert.equal(j.command, 'env:py');
  assert.equal(j.error.code, 'python-missing');
  assert.ok(j.error.hint);
  for (const k of ['outputs', 'runJson', 'warnings']) assert.ok(k in j, `信封缺 ${k}`);
});

// 找一个真能跑的 Python 3（任意版本）来测透传：退出码、参数、UTF-8 输出
const realPython = (() => {
  for (const c of [process.env.BEIMING_PYTHON, process.env.PYTHON, 'python3', 'python']) {
    if (!c) continue;
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  return null;
})();

test('py.mjs：参数原样透传、退出码透传、GBK 环境下按 UTF-8 输出', { skip: !realPython && '本机没有可运行的 Python 3' }, () => {
  const env = { ...process.env, BEIMING_PYTHON: realPython, PYTHONIOENCODING: 'gbk' };
  delete env.BEIMING_PY;
  const code = spawnSync(process.execPath, [PY_MJS, '-c', 'import sys; sys.exit(7)'], { encoding: 'utf8', env });
  assert.equal(code.status, 7);
  const args = spawnSync(process.execPath, [PY_MJS, '-c', 'import sys, json; print(json.dumps(sys.argv[1:]))', '--help', 'a b', '中文'], { encoding: 'utf8', env });
  assert.equal(args.status, 0, args.stderr);
  assert.deepEqual(JSON.parse(args.stdout), ['--help', 'a b', '中文']);
  // 「−」（U+2212）在 GBK 里没有：没有 PYTHONIOENCODING=utf-8 覆盖时，重定向输出会 UnicodeEncodeError
  const uni = spawnSync(process.execPath, [PY_MJS, '-c', 'print("T\\u221215 鲲")'], { env });
  assert.equal(uni.status, 0, String(uni.stderr));
  assert.equal(uni.stdout.toString('utf8').trim(), 'T−15 鲲');
  // 任何目录下运行，PYTHONPATH 的第一项都是仓库根（脚本里可以直接 import engine.audio）
  const pp = spawnSync(process.execPath, [PY_MJS, '-c', 'import os; print(os.environ["PYTHONPATH"].split(os.pathsep)[0])'], { encoding: 'utf8', env, cwd: os.tmpdir() });
  assert.equal(pp.status, 0, pp.stderr);
  assert.equal(fs.realpathSync(pp.stdout.trim()), fs.realpathSync(ROOT));
});
