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

test('灯条闭式求值支持子帧、负帧、反转与独立曝光', () => offline(`
rig = card.compute_strip_rig
zero = rig(0, 0, 4, 3, 2, 6, 1)
assert [s['azimuthDeg'] for s in zero] == [0, 90, 180, 270]
assert zero[0]['position'] == (3, 2, 0)
assert all(math.isclose(math.hypot(s['position'][0], s['position'][2]), 3) for s in zero)
late = rig(20, .5, 4, 3, 2, 6, 2)
assert late[0]['azimuthDeg'] == 123
assert late[0]['powerW'] == 2 * zero[0]['powerW']
assert rig(-1, .5, 4, 3, 2, 6, 1)[0]['azimuthDeg'] == 357
assert rig(20, .5, 4, 3, 2, -6, 1)[0]['azimuthDeg'] == 237
assert rig(20, .5, 4, 3, 2, 0, 1) == zero
assert rig(0, 0, 4, 3, 2, 6, 1) == zero
for args in ((0, 1, 4, 3, 2, 6, 1), (0, 0, 0, 3, 2, 6, 1), (0, 0, 4, 0, 2, 6, 1),
             (0, 0, 4, 3, 2, math.inf, 1)):
    rejects(rig, *args)
rejects(card.validate_params, {'variant': 'other'})
rejects(card.validate_params, {'sweepEnabled': 1})
assert card.validate_params({'variant': 'silver'})['variant'] == 'silver'
`));
