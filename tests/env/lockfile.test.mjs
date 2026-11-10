// requirements.lock 的读取与 PEP 508 环境标记求值（tools/env/lib/lockfile.mjs）：不启动 Python、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLock, evalMarker, markerEnv, pinsFor, normalizeName, sha256 } from '../../tools/env/lib/lockfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env/spec.json'), 'utf8'));

// 三个目标平台上 CPython 3.12 的 probePython 结果（字段与 tools/env/lib/python.mjs 的 probePython 相同）
const PROBES = {
  'macos-arm64': { version: [3, 12, 12], fullVersion: '3.12.12', platform: 'darwin', machine: 'arm64', system: 'Darwin', osName: 'posix', implementation: 'cpython' },
  'windows-x64': { version: [3, 12, 10], fullVersion: '3.12.10', platform: 'win32', machine: 'AMD64', system: 'Windows', osName: 'nt', implementation: 'cpython' },
  'linux-x64': { version: [3, 12, 3], fullVersion: '3.12.3', platform: 'linux', machine: 'x86_64', system: 'Linux', osName: 'posix', implementation: 'cpython' },
};

test('仓库的 requirements.lock：文件头完整、每个包都固定版本并带哈希、输入哈希与 requirements.in 一致', () => {
  const text = fs.readFileSync(path.join(ROOT, SPEC.python.lock), 'utf8');
  const lock = parseLock(text);
  assert.equal(lock.header.python, SPEC.python.version);
  assert.match(lock.header.excludeNewer, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  assert.equal(lock.header.input, SPEC.python.input);
  assert.equal(lock.header.inputSha256, sha256(fs.readFileSync(path.join(ROOT, SPEC.python.input))));
  assert.ok(lock.pins.length >= 6);
  for (const p of lock.pins) {
    assert.ok(!p.invalid, `无法识别的锁定行：${p.name}`);
    assert.match(p.version, /^\d+(\.\d+)*$/, `${p.name} 没有精确版本`);
    assert.ok(p.hashes.length >= 1, `${p.name} 没有哈希`);
    for (const h of p.hashes) assert.match(h, /^[0-9a-f]{64}$/);
  }
  const names = new Set(lock.pins.map(p => p.name));
  for (const top of ['numpy', 'scipy', 'numba', 'soundfile', 'soxr', 'pillow']) assert.ok(names.has(top), `锁文件缺顶层依赖 ${top}`);
});

test('三个目标平台的 CPython 3.12 都装同一组包（锁文件是通用锁，不按平台分叉版本）', () => {
  const lock = parseLock(fs.readFileSync(path.join(ROOT, SPEC.python.lock), 'utf8'));
  const sets = Object.entries(PROBES).map(([id, p]) => [id, pinsFor(lock, p).map(x => `${x.name}==${x.version}`).sort().join(' ')]);
  for (const [id, s] of sets) assert.equal(s, sets[0][1], `${id} 与 ${sets[0][0]} 要装的包不同`);
  assert.deepEqual(SPEC.lockTargets.map(t => t.id).sort(), Object.keys(PROBES).sort());
});

test('parseLock：续行、行尾注释、via 注释、环境标记、extras、不认识的行', () => {
  const lock = parseLock([
    '# 北冥仓库 · 测试',
    '# input: requirements.in sha256=' + 'a'.repeat(64),
    '# python: 3.12',
    '# exclude-newer: 2026-11-10T00:00:00Z',
    'numpy==2.5.4 \\',
    '    --hash=sha256:' + '1'.repeat(64) + ' \\',
    '    --hash=sha256:' + '2'.repeat(64),
    '    # via -r requirements.in',
    'Typing_Extensions==4.16.0 ; python_version < "3.13" \\',
    '    --hash=sha256:' + '3'.repeat(64) + '   # 行尾注释',
    'requests[socks]==2.32.0 --hash=sha256:' + '4'.repeat(64),
    'some-package>=1.0',
    '--index-url https://example.invalid/simple',
  ].join('\n'));
  assert.equal(lock.header.python, '3.12');
  assert.equal(lock.header.inputSha256, 'a'.repeat(64));
  assert.deepEqual(lock.pins.map(p => [p.name, p.version, p.hashes.length]), [
    ['numpy', '2.5.4', 2], ['typing-extensions', '4.16.0', 1], ['requests', '2.32.0', 1], ['some-package>=1.0', null, 0],
  ]);
  assert.equal(lock.pins[1].marker, 'python_version < "3.13"');
  assert.ok(lock.pins[3].invalid);
});

test('evalMarker：比较、逻辑、括号、in / not in、版本按数值比较', () => {
  const win = markerEnv(PROBES['windows-x64']), mac = markerEnv(PROBES['macos-arm64']);
  assert.equal(evalMarker("implementation_name != 'PyPy'", win), true);
  assert.equal(evalMarker("sys_platform == 'win32' and platform_machine == 'AMD64'", win), true);
  assert.equal(evalMarker("sys_platform == 'win32' and platform_machine == 'AMD64'", mac), false);
  assert.equal(evalMarker("(sys_platform == 'darwin' or os_name == 'nt') and python_version >= '3.12'", mac), true);
  assert.equal(evalMarker('python_version >= "3.9"', mac), true);          // 字符串比较会错（"3.12" < "3.9"）
  assert.equal(evalMarker('python_version < "3.13"', mac), true);
  assert.equal(evalMarker('python_full_version >= "3.12.11"', mac), true);
  assert.equal(evalMarker('python_full_version >= "3.12.11"', win), false);
  assert.equal(evalMarker("'arm' in platform_machine", mac), true);
  assert.equal(evalMarker("'arm' not in platform_machine", win), true);
  assert.equal(evalMarker('not (sys_platform == "linux")', mac), true);
  assert.equal(evalMarker('python_version ~= "3.12"', mac), true);
  assert.equal(evalMarker("extra == 'test'", mac), false);
  assert.equal(evalMarker('', mac), true);
  assert.throws(() => evalMarker('no_such_var == "x"', mac), /未知的标记变量/);
  assert.throws(() => evalMarker('(sys_platform == "darwin"', mac), /括号/);
  assert.throws(() => evalMarker('sys_platform "darwin"', mac));
});

test('pinsFor：按 PEP 508 区分大小写求值；normalizeName 按 PEP 503', () => {
  // cffi 2.x 的元数据写的是 implementation_name != 'PyPy'；implementation_name 是小写的 sys.implementation.name，
  // 所以这个标记在 PyPy 上也成立（pycparser 照装）。真正排除 PyPy 要写小写 'pypy' 或用 platform_python_implementation。
  const lock = parseLock([
    'cffi==2.1.1 --hash=sha256:' + 'a'.repeat(64),
    "pycparser==3.12 ; implementation_name != 'PyPy' --hash=sha256:" + 'b'.repeat(64),
    "onlycpython==1.0 ; implementation_name != 'pypy' --hash=sha256:" + 'c'.repeat(64),
    "alsocpython==1.0 ; platform_python_implementation == 'CPython' --hash=sha256:" + 'd'.repeat(64),
  ].join('\n'));
  const pypy = { ...PROBES['linux-x64'], implementation: 'pypy' };
  assert.deepEqual(pinsFor(lock, PROBES['linux-x64']).map(p => p.name), ['cffi', 'pycparser', 'onlycpython', 'alsocpython']);
  assert.deepEqual(pinsFor(lock, pypy).map(p => p.name), ['cffi', 'pycparser']);
  assert.equal(normalizeName('Typing_Extensions'), 'typing-extensions');
  assert.equal(normalizeName('zope.interface'), 'zope-interface');
  assert.equal(normalizeName('A__B--c'), 'a-b-c');
});
