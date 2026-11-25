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
from collections import Counter

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

const MESH = `

def check_mesh(mesh, boundary=0):
    vertices, faces = mesh['vertices'], mesh['faces']
    assert len(set(vertices)) == len(vertices)
    assert all(math.isfinite(v) for p in vertices for v in p)
    edges = Counter()
    volume = 0
    for face in faces:
        assert len(face) in (3, 4) and len(set(face)) == len(face)
        edges.update(zip(face, face[1:] + face[:1]))
        a = vertices[face[0]]
        for i in range(1, len(face) - 1):
            b, c = vertices[face[i]], vertices[face[i + 1]]
            u, v = [x-y for x, y in zip(b, a)], [x-y for x, y in zip(c, a)]
            cross = [u[(j+1)%3]*v[(j+2)%3] - u[(j+2)%3]*v[(j+1)%3] for j in range(3)]
            assert any(cross), face
            volume += sum(x*y for x, y in zip(a, cross)) / 6
    assert all(count == 1 for count in edges.values())
    assert sum((b,a) not in edges for a,b in edges) == boundary
    if not boundary:
        assert volume > 0
    return tuple(max(p[d] for p in vertices) - min(p[d] for p in vertices) for d in range(3)), volume
`;

test('原语的外向二流形、精确尺寸、槽体积与倒角细分', () => offline(MESH + `
build = card.build_primitive_mesh
box = {'kind': 'box', 'sizeM': [2, 1, 3]}
plain = build(box)
round1 = build(dict(box, bevelM=.2, bevelSegments=1))
round4 = build(dict(box, bevelM=.2, bevelSegments=4))
for m in (plain, round1, round4):
    assert check_mesh(m)[0] == (2, 1, 3)
assert len(plain['vertices']) == 8 < len(round1['vertices']) < len(round4['vertices'])
assert 0 < check_mesh(round1)[1] < check_mesh(round4)[1] < 6
cylinder = {'kind': 'cylinder', 'radiusM': .4, 'heightM': 1, 'segments': 19, 'bevelM': .06, 'bevelSegments': 3}
assert check_mesh(build(cylinder))[0] == (.8, 1, .8)
plate = {'kind': 'slotted_plate', 'sizeM': [2, .5, 3], 'slotSizeM': [1, 2], 'slotDepthM': .25}
for depth, volume in ((.25, 2.5), (.5, 2)):
    assert check_mesh(build(dict(plate, slotDepthM=depth)))[0] == (2, .5, 3)
    assert math.isclose(check_mesh(build(dict(plate, slotDepthM=depth)))[1], volume)
assert build(plate) == build(dict(plate))
for bad in (dict(box, bevelM=.5), dict(box, sizeM=[1,0,2]), dict(plate, slotDepthM=.6),
            dict(plate, slotSizeM=[2, 1]), dict(cylinder, segments=True), {'kind': 'unknown'}):
    rejects(build, bad)
`));
