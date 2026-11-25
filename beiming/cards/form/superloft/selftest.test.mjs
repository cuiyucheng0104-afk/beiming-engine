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

test('超椭圆方程、不同截面、绕脊线旋转与端盖绕序', () => offline(MESH + `
build = card.build_superloft_mesh
sections = [{'rx': 1, 'ry': .75, 'exponent': 2, 'center': [0, 0, 0]},
            {'rx': .7, 'ry': 1, 'exponent': 8, 'center': [0, 0, 2], 'twistDeg': 45}]
mesh = build(sections, 32, True)
check_mesh(mesh)
assert check_mesh(build(sections, 32, False), 64)
assert build(sections, 32, True) == mesh
for i, section in enumerate(sections):
    angle = math.radians(section.get('twistDeg', 0))
    for x, y, z in mesh['vertices'][32*i:32*(i+1)]:
        u, v = x*math.cos(angle)+y*math.sin(angle), -x*math.sin(angle)+y*math.cos(angle)
        assert z == section['center'][2]
        assert math.isclose(abs(u/section['rx'])**section['exponent'] + abs(v/section['ry'])**section['exponent'], 1)
bent = [sections[0], dict(sections[1], center=[0,0,2]), dict(sections[1], center=[1,.5,4], rx=.6)]
check_mesh(build(bent, 32, True))
check_mesh(build([sections[0], dict(sections[1], twistDeg=180)], 32, True))
for exponent in (1, 64, 1e300):
    check_mesh(build([dict(s, exponent=exponent) for s in sections], 32, True))
for bad in ([sections[0]], [sections[0], sections[0]], [sections[0], dict(sections[1], exponent=.9)],
            [sections[0], dict(sections[1], rx=math.nan)], [sections[0], dict(sections[1], twistDeg=math.inf)],
            [sections[0], sections[1], sections[0]]):
    rejects(build, bad, 32, True)
rejects(build, sections, 3, True)
rejects(build, sections, 32, 1)
`));
