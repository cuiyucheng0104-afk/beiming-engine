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

test('AO 离线验证距离、线色、强度与内侧开关', () => offline(`
assert card.validate_params({})['samples'] == 8
p = card.validate_params({'distanceM': 0.08, 'inkColor': '#1a334d', 'inkStrength': 1, 'inside': True})
assert p['inkColor'] == (26/255, 51/255, 77/255) and p['inside'] and p['inkStrength'] == 1
for bad in ({'distanceM': math.inf}, {'distanceM': 0}, {'samples': 0}, {'inkStrength': -1},
            {'inkColor': [0, 0, 0]}, {'inkColor': '#FFF'}, {'inkColor': '#0011hh'}, {'inside': 1}, {'enabled': 'false'},
            {'target': {'object': 'body', 'material': 'metal'}}):
    rejects(card.validate_params, bad)
assert 'bpy' not in sys.modules
`));
