import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PYTHON = fileURLToPath(new URL('../../../jobs/python/py.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('./shake.py', import.meta.url));

test('shake is causal, damped, order-independent, and strictly inert when disabled or given zero impulse', () => {
  const result = spawnSync(process.execPath, [PYTHON, '-I', '-B', '-c', `
import importlib.util
import math
import sys
from copy import deepcopy
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location('shake', sys.argv[1])
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
assert 'bpy' not in sys.modules

params = {'impulses': [{'frame': 8, 'strength': 1}, {'frame': 16, 'strength': 0.5}]}
original = deepcopy(params)
ctx = NS(fps=24, hostScene=NS(camera=None))
h = card.create(ctx, params)
sample = h['sample']
zero = {'position': (0, 0, 0), 'rotation_deg': (0, 0, 0)}
assert sample(7, 0.5) == zero
energy = lambda f: math.hypot(*sample(f)['position'], *sample(f)['rotation_deg'])
assert max(map(energy, range(8, 20))) > 0
assert max(map(energy, range(200, 220))) < max(map(energy, range(8, 20))) * 0.01
assert sample(9, 0.25) == sample(9.25) != sample(9)
baseline = {f: sample(f) for f in range(25)}
for f in [17, 8, 24, 4, 17, 9]:
    assert sample(f) == baseline[f]
    assert h['meta'](f)['readings']['shakeM'] == math.hypot(*baseline[f]['position'])

# A disabled effect may not read or overwrite the camera's current transform.
ctx.hostScene.camera = object()
for patch in ({'enabled': False}, {'impulses': []}, {'impulses': [{'frame': 8, 'strength': 0}]}):
    control = card.create(ctx, dict(params, **patch))
    for f in [16, 0, 8, 200]:
        assert control['sample'](f) == zero
        control['apply'](f, 0)
assert params == original
h['dispose']()

# Real bindings use an absolute static pose, a bottom card, or a track. With
# zero rotation amplitude the location writes can be verified without mathutils.
origin, orientation = (3, -2, 4), (1, 0, 0, 0)
for source in ('static', 'card', 'tracks'):
    camera = NS(location=origin, rotation_mode='QUATERNION', rotation_quaternion=orientation)
    def base_position(f, sub):
        return origin if source == 'static' else (origin[0] + f + sub, *origin[1:])
    def apply_base(f, sub):
        camera.location = base_position(f, sub)
        camera.rotation_quaternion = orientation
    host = NS(fps='24000/1001', hostScene=NS(camera=camera))
    options = dict(params, ampRotDeg=0)
    if source == 'card':
        options['baseCard'] = 'base'
        host.cards = NS(use=lambda as_name: {'object': camera, 'apply': apply_base} if as_name == 'base' else {})
    if source == 'tracks':
        host.tracks = NS(camera=camera, apply=apply_base)
    handle = card.create(host, options)
    for f, sub in [(17, 0), (4, 0), (9, 0.25), (17, 0), (9, 0.25), (4, 0)]:
        dx, dy, dz = handle['sample'](f, sub)['position']
        x, y, z = base_position(f, sub)
        handle['apply'](f, sub)
        assert camera.location == (x + dx, y - dz, z + dy), source
        assert camera.rotation_quaternion == orientation
    handle['dispose']()
    if source == 'static':
        assert camera.location == origin

camera = NS(location=origin, rotation_mode='QUATERNION', rotation_quaternion=orientation)
host = NS(fps=24, hostScene=NS(camera=camera), cards=NS(use=lambda _: {'object': object(), 'apply': None}))
for options, error in [(dict(params, baseCard='wrong'), 'baseCard'), (params, '无父对象')]:
    if not options.get('baseCard'):
        camera.parent = object()
    try:
        card.create(host, options)['apply'](9, 0)
    except ValueError as exc:
        assert error in str(exc)
    else:
        raise AssertionError(error)
    assert camera.location == origin and camera.rotation_quaternion == orientation

assert card.create(ctx, {'impulses': [{'frame': 8.5}]})['sample'](8) == zero
assert card.create(ctx, {'impulses': [{'frame': 8.5}]})['sample'](8.5) != zero
for impulses in ([{'frame': '8.5', 'strength': 1}], [{'frame': 8, 'strength': -1}]):
    try:
        card.create(ctx, {'impulses': impulses})
    except ValueError:
        pass
    else:
        raise AssertionError(impulses)
`, ENTRY], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
