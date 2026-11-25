import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pythonBin = process.env.BEIMING_PY || (process.platform === 'win32' ? 'python' : 'python3');
const entry = fileURLToPath(new URL('./index.py', import.meta.url));
const setup = `
import json, math, runpy, sys
from pathlib import Path
fx = runpy.run_path(sys.argv[1])
spec = json.loads(Path(sys.argv[1]).with_name('card.json').read_text(encoding='utf-8'))['params']['spec']['default']
frame = fx['evaluate_fx_frame']
`;
function python(program) {
  const r = spawnSync(pythonBin, ['-IB', '-c', setup + program, entry], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr);
}

test('光带沿速度和视线的公垂线展开，移动相机改变截面，停顿会断带', () => python(`
s = dict(spec['streak'], points=[[0,0,0],[4,0,0]], trailFrames=2)
ribbon = fx['build_streak_ribbon_geometry']
for eye, axis in [((0,0,5),1), ((0,5,0),2)]:
    geo = ribbon(s, 3, eye)
    assert len(geo['faces']) == 4 and len(geo['vertices']) == 10
    p, q = geo['vertices'][:2]
    assert math.isclose(abs(p[axis]-q[axis]), 2*s['halfWidthM']*0.6**0.6)
    assert p[0] == q[0] == 3 and p[3-axis] == q[3-axis] == 0
    assert geo['a'][:2] == [0.6,0.6] and geo['a'][-2:] == [0,0]
    assert geo['faces'][0][2:] == tuple(reversed(geo['faces'][1][:2]))
for t in (-1, 0, 6):
    assert not ribbon(s,t,(0,0,5))['faces']
assert not ribbon(s,3,(10,0,0))['faces']
`));

test('冲击环在地平面按指数扩散，接缝闭合且截面亮度向两缘降为零', () => python(`
s = spec['ring']
x,y,z = s['center']
ring = fx['build_shockwave_ring_geometry']
for t in (0,0.5,7,29.75):
    g = ring(s,t)
    radius = 0.12+s['radiusM']*(1-math.exp(-t/7))
    width = s['widthM']*(0.45+0.55*math.exp(-t/9))
    alpha = math.exp(-t/7.5)*min(1,0.3+t/1.5)
    assert len(g['faces']) == 2*s['segments'] and len(g['a']) == len(g['vertices']) == 3*s['segments']
    assert g['faces'][-1][1:3] == (1,2)
    for i,(vx,vy,vz) in enumerate(g['vertices']):
        assert vy == y and math.isclose(math.hypot(vx-x,vz-z), (radius-width,radius,radius+0.5*width)[i%3])
        assert math.isclose(g['a'][i], (0,alpha,0)[i%3])
for t in (-0.01,30):
    assert ring(s,t)['faces'] == []
`));

test('顺序、乱序与独立单帧的几何和读数逐字节一致', () => python(`
def encoded(t):
    return json.dumps(frame(spec, math.floor(t), t%1), allow_nan=False).encode()
ts = [-1,0,1,4.5,7,12,18,29.75,30,34]
forward = {t:encoded(t) for t in ts}
for t in (7,34,12,1,-1,0,18,30,4.5,29.75):
    assert encoded(t) == forward[t]
assert frame(spec,7)['readings']['streakFaces'] == 12
assert frame(spec,7)['readings']['ringFaces'] == 96
assert forward[7] != forward[12]
`));

test('拒绝非有限坐标、非法采样范围、未知字段与坏帧号', () => python(`
for changed, f, sub in [({},0,0), ({'streak':dict(spec['streak'], strideFrames=0)},1,0),
        ({'ring':dict(spec['ring'], segments=True)},0,0), ({'ring':dict(spec['ring'], center=[0,math.nan,2])},0,0),
        ({'ring':dict(spec['ring'], badField=4)},1,0), (spec,1,1), (spec,'3',0), (spec,0,math.inf)]:
    try:
        frame(changed,f,sub)
    except ValueError as e:
        assert 'usage.bad-argument' in str(e)
    else:
        raise AssertionError('accepted invalid input')
`));
