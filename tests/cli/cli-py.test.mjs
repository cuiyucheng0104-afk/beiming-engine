// 让 node --test tests/cli 也跑 tools/lib/cli.py 的单元测试（tests/cli/test_cli_py.py）。
// 没有 Python 时跳过；Python 解释器取 BEIMING_PY，其次 python3 / python。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidates = [process.env.BEIMING_PY, 'python3', 'python'].filter(Boolean);
const py = candidates.find(c => spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { encoding: 'utf8' }).status === 0);

test('cli.py 单元测试（python -m unittest）', { skip: py ? false : '没有 Python 3.10+' }, () => {
  const r = spawnSync(py, ['-B', '-m', 'unittest', 'discover', '-s', 'tests/cli', '-p', 'test_*.py'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /OK/);
});
