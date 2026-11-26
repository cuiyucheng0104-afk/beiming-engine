import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PYTHON = fileURLToPath(new URL('../../../../tools/env/py.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('./snap.py', import.meta.url));

test('snap holds its start pose, crosses contact, settles exactly, and does not overshoot in the zero control', () => {
  const result = spawnSync(process.execPath, [PYTHON, '-I', '-B', '-c', `
import importlib.util
import sys
from copy import deepcopy
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location('snap', sys.argv[1])
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
assert 'bpy' not in sys.modules

part = {'t0': 5, 'fly_frames': 20, 'rest_pos': [1, 2, 3], 'rest_rot_deg': [5, 10, 15],
        'start_offset': [2, 0, 0], 'start_rot_deg': [30, 40, 50]}
params = {'part': part, 'settleFrames': 6, 'overshoot': 0.2}
original = deepcopy(params)
ctx = NS()
h = card.create(ctx, params)
sample = h['sample']
start = {'position': (3, 2, 3), 'rotation_deg': (30, 40, 50)}
rest = {'position': (1, 2, 3), 'rotation_deg': (5, 10, 15)}
assert sample(2) == sample(5) == start
assert sample(25) == sample(33) == rest
assert sample(12)['position'][0] == 1.25  # cubic ease-out at half flight
assert sample(12.5) == sample(12, 0.5) != sample(12)
baseline = {f: sample(f) for f in range(34)}
assert min(p['position'][0] for p in baseline.values()) < 1
control = card.create(ctx, dict(params, overshoot=0))['sample']
assert min(control(f)['position'][0] for f in range(34)) == 1
for f, settled in [(33, 1), (4, 0), (21, 0), (25, 1), (12, 0), (33, 1)]:
    h['apply'](f, 0)
    assert sample(f) == baseline[f]
    assert h['meta'](f) == {'readings': {'settled': settled}}
assert params == original
h['dispose']()
for patch in ({'part': dict(part, fly_frames=0)}, {'part': dict(part, rest_pos=[1, 2])},
              {'overshoot': -0.1}, {'object': 'missing'}, {'object': ['part']}):
    try:
        card.create(NS(hostScene=NS(objects={})), dict(params, **patch))
    except ValueError:
        pass
    else:
        raise AssertionError(patch)
`, ENTRY], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
