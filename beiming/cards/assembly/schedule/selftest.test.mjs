import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PYTHON = fileURLToPath(new URL('../../../jobs/python/py.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('./schedule.py', import.meta.url));

test('schedule orders groups and stable ties, emits arrival events, and counts arrivals without applying earlier frames', () => {
  const result = spawnSync(process.execPath, [PYTHON, '-I', '-B', '-c', `
import importlib.util
import sys
from copy import deepcopy
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location('schedule', sys.argv[1])
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
assert 'bpy' not in sys.modules

parts = [
    {'id': 'lid', 'rest_pos': [0, 0, 0], 'group': 'outer'},
    {'id': 'right', 'rest_pos': [1, 0, 0], 'group': 'inner'},
    {'id': 'left', 'rest_pos': [-1, 0, 0], 'group': 'inner'},
    {'id': 'base', 'rest_pos': [0, 0, 0], 'group': 'inner'},
]
params = {'parts': parts, 'groups': ['inner', 'outer'], 'startFrame': 4,
          'gapFrames': 3, 'flyFrames': 12, 'offsetM': 0.8}
original = deepcopy(params)
ctx = NS(fps=24, seed=17, shot={'id': 's01'})
h = card.create(ctx, params)
rows = h['schedule']['parts']
assert [p['id'] for p in rows] == ['base', 'left', 'right', 'lid'], rows
assert [p['t0'] for p in rows] == [4, 7, 10, 13], rows
assert [p['fly_frames'] for p in rows] == [12] * 4
assert any(any(p['start_offset']) for p in rows)
assert h['events']['format'] == 'events/0.1'
assert h['events']['fps'] == '24/1' and h['events']['frames'] == 26
assert all(e['shot'] == 's01' and e['kind'] == 'arrive' and e['from'] == 'tracks'
           for e in h['events']['events'])
assert [(e['id'], e['frame']) for e in h['events']['events']] == [
    ('arrive.base', 16), ('arrive.left', 19), ('arrive.right', 22), ('arrive.lid', 25)]
assert h['events'] == h['schedule']['events']
for f, count in [(25, 4), (15, 0), (19, 2), (16, 1), (25, 4)]:
    assert h['meta'](f) == {'readings': {'partCount': 4, 'arrivedCount': count}}
    h['apply'](f, 0)
assert card.create(ctx, dict(params, parts=list(reversed(parts))))['schedule'] == h['schedule']
assert card.create(ctx, dict(params, groups=['outer', 'inner']))['schedule']['parts'][0]['id'] == 'lid'
assert card.create(ctx, dict(params, gapFrames=0))['events'] != h['events']
assert card.create(NS(fps=24, seed=18, shot={'id': 's01'}), params)['schedule'] != h['schedule']
assert original == params
h['dispose']()
for patch in ({'parts': parts + [parts[0]]}, {'groups': ['inner', 'inner']}, {'flyFrames': 0}):
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
