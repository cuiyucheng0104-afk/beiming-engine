import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PYTHON = fileURLToPath(new URL('../../../jobs/python/py.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('./explode.py', import.meta.url));

test('explode has exact endpoints, nonzero separation, an absolute scene binding, and an inert scale-zero control', () => {
  const result = spawnSync(process.execPath, [PYTHON, '-I', '-B', '-c', `
import importlib.util
import math
import sys
from copy import deepcopy
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location('explode', sys.argv[1])
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
assert 'bpy' not in sys.modules

parts = [{'id': 'left', 'rest_pos': [-1, 1, 2]}, {'id': 'right', 'rest_pos': [1, 1, 2]}]
rest = {'left': (-1, 1, 2), 'right': (1, 1, 2)}
params = {'parts': parts, 'phase': {'startFrame': 3, 'endFrame': 13, 'from': 0, 'to': 1},
          'axisWeights': [1, 0, 0], 'scaleM': 2, 'center': [0, 1, 2],
          'bindings': {'left': 'kit.left', 'right': 'kit.right'}}
original = deepcopy(params)
left, right = NS(), NS()
ctx = NS(hostScene=NS(objects={'kit.left': left, 'kit.right': right}))
h = card.create(ctx, params)
sample = h['sample']
assert sample(3) == sample(-1) == rest
assert sample(13) == sample(30)
spread = lambda f: math.dist(*sample(f).values())
assert spread(13) > spread(8) > spread(3)
assert h['meta'](8) == {'readings': {'progress': 0.5, 'partCount': 2}}
assert sample(7, 0.5) == sample(7.5)
assert sample(7) != sample(7, 0.5)
for f in [13, -1, 8, 3, 13, 8]:
    want = sample(f)
    h['apply'](f, 0)
    for name, obj in [('left', left), ('right', right)]:
        x, y, z = want[name]
        assert obj.location == (x, -z, y)
assert card.create(ctx, dict(params, scaleM=0))['sample'](13) == rest
by_group = card.create(ctx, dict(params, scaleM=0, parts=[dict(parts[0], group='outer'), parts[1]],
                                groupOffsets={'outer': [0, 2, 0]}))['sample']
assert by_group(3) == rest
assert by_group(13) == {'left': (-1, 3, 2), 'right': (1, 1, 2)}
assert card.create(ctx, dict(params, phase={'startFrame': 3, 'endFrame': 13, 'from': 1, 'to': 0}))['sample'](13) == rest
assert original == params
h['dispose']()
for patch in ({'phase': {'startFrame': 3, 'endFrame': 3, 'from': 0, 'to': 1}},
              {'bindings': {'left': 'missing'}}, {'bindings': {'unknown': 'kit.left'}},
              {'bindings': {'left': 'kit.left', 'right': 'kit.left'}}):
    try:
        card.create(ctx, dict(params, **patch))
    except ValueError:
        pass
    else:
        raise AssertionError(patch)
`, ENTRY], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
