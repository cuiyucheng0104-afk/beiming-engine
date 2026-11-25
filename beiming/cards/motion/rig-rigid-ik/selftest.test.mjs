import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function python(body) {
  const setup = `
import json, math, runpy, struct, sys
from pathlib import Path
root = Path(sys.argv[1])
rig = runpy.run_path(str(root / 'index.py'))
solve, aim, pose = [rig[k] for k in ('solve_two_bone_ik', 'solve_aim_rotation', 'evaluate_rig_pose')]
spec = json.loads((root / 'card.json').read_text(encoding='utf8'))['params']['spec']['default']
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', setup + body, import.meta.dirname], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

test('两段定长、可达球壳、重合关节和极向量半平面', () => python(`
hip = (1, 2, 3)
for distance, l1, l2, ok in [(2, 1.5, 1, True), (2.5, 1.5, 1, True), (.5, 1.5, 1, True),
                             (.1, 1, 2, False), (5, 1.5, 1, False), (0, 1, 1, True), (0, 2, 1, False)]:
    ankle = (1, 2-distance, 3)
    for pole in [(1, 0, 2), (-1, 0, -2), (0, 1, 0)]:
        p = solve(hip, ankle, pole, l1, l2)
        assert p['ok'] == ok
        assert abs(math.dist(hip, p['knee']) - l1) < 1e-12
        assert abs(math.dist(p['knee'], p['ankle']) - l2) < 1e-12
        assert abs(math.dist(p['ankle'], hip) - min(l1+l2, max(abs(l1-l2), distance))) < 1e-12
        assert (p['knee'][0]-1)*pole[0] + (p['knee'][2]-3)*pole[2] >= -1e-12
rot = aim((1, 0, 0), (0, 0, -1), (0, 1, 0), (1, 0, 0))
assert tuple(row[0] for row in rot) == (0, 0, -1)
assert tuple(row[1] for row in rot) == (1, 0, 0)
`));

test('站姿恒等、世界矩阵首尾连接与乱序逐位一致', () => python(`
stand = pose(spec, 0, 0)
identity = tuple(tuple(float(i==j) for j in range(4)) for i in range(4))
assert all(m == identity for m in stand['matrices'].values())
def check(frame):
    out = pose(spec, frame, .25)
    values = []
    for name, joints in [('root', ['hip']), ('upper', ['hip', 'knee']), ('lower', ['knee', 'ankle']), ('foot', ['ankle'])]:
        mat = out['matrices'][name]
        for key in joints:
            point = stand[key] + (1,)
            moved = [sum(x*y for x,y in zip(row,point)) for row in mat[:3]]
            assert math.dist(moved, out[key]) < 1e-12
        values.extend(x for row in mat for x in row)
    return struct.pack('!64d', *values)
frames = [0, 3, 9, 17, 24]
forward = {f: check(f) for f in frames}
assert check(9) == forward[9]
assert {f: check(f) for f in [17, 0, 24, 9, 3]} == forward
assert not pose(dict(spec, targetAnkle=[100, 0, 0]), 24)['ok']
`));

test('非法骨长、非有限参数、帧区间与重复绑定报 usage.bad-argument', () => python(`
for fn in [lambda: solve([0]*3, [0]*3, [1]*3, 0, 1), lambda: aim([0]*3, [1]*3),
           lambda: pose(dict(spec, pole=[math.nan,0,0]), 2), lambda: pose(spec, True),
           lambda: pose(spec, 1, 1), lambda: pose(dict(spec, endFrame=0), 2),
           lambda: pose(dict(spec, l2=-1), 0), lambda: pose(dict(spec, targetAnkle=[0,0]), 0),
           lambda: pose(dict(spec, bindings={'upper':['part'], 'lower':['part']}), 2)]:
    try:
        fn()
    except ValueError as e:
        assert str(e).startswith('usage.bad-argument:')
    else:
        raise AssertionError('invalid input passed')
`));
