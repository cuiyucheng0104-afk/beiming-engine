import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.py', import.meta.url));

function offline(code) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = spawnSync(python, ['-B', '-c', `
import importlib.util
import math
import sys

spec = importlib.util.spec_from_file_location('card', sys.argv[1])
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
assert 'bpy' not in sys.modules

def rejects(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return
    raise AssertionError('invalid input accepted')

` + code, entry], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('倒角离线验证半径、采样与变异开关', () => offline(`
assert card.validate_params({})['samples'] == 4
p = {'target': {'material': 'metal'}, 'radiusM': 0.04, 'samples': 16, 'enabled': False}
assert card.validate_params(p) == p
for bad in ({'radiusM': 0}, {'radiusM': math.nan}, {'samples': 1}, {'samples': 17},
            {'samples': True}, {'enabled': 1}, {'target': {}},
            {'target': {'object': 'body', 'material': 'metal'}}, {'target': {'object': ''}}):
    rejects(card.validate_params, bad)
assert 'bpy' not in sys.modules
`));
