import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.py', import.meta.url));
function offline(source) {
  const script = `import runpy, sys, math, copy
studio = runpy.run_path(sys.argv[1]); solve = studio['solve']
assert 'bpy' not in sys.modules and 'mathutils' not in sys.modules
def close(a, b): return math.isclose(a,b,rel_tol=1e-6,abs_tol=1e-8)
def near(a, b): return all(map(close,a,b)) and len(a)==len(b)
` + source;
  const proc = spawnSync('python3', ['-I', '-B', '-c', script, entry], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, proc.stderr);
}

test('六套棚光：逐灯尺寸、功率和相对位移的 100 倍尺度律；与半米标定锚点对拍', () => offline(`
for rig,count,linked,key in [('hero',6,0,16.230955),('explode',5,0,18.936115),('poster',6,0,5.410318),
                             ('mech-matte',5,3,27.850142),('mech-plated',12,11,11.836310),('wide-matte',5,3,48.476456)]:
    def at(s): return solve({'preset':rig, 'subjectScaleM':0.5*s, 'spec':{'anchor':[0,0.25*s,0], 'receiverCollection':'balls'}}, 0, 0)
    unit,big = at(1),at(100)
    assert len(unit)==count and sum(v['receiverCollection']=='balls' for v in unit.values())==linked
    assert sum(v['bodyOnly'] for v in studio['solve_studio_rig'](rig).values())==linked
    assert close(unit['key']['watts'],key)
    for name, lamp in unit.items():
        scaled = big[name]
        for k in ('position','size'): assert near(scaled[k], [100*x for x in lamp[k]])
        assert close(scaled['watts'], 10000*lamp['watts']) and scaled['normal']==lamp['normal']
        assert close(math.hypot(*lamp['normal']),1) and close(math.hypot(*lamp['widthAxis']),1)
        assert abs(sum(x*y for x,y in zip(lamp['widthAxis'],lamp['normal'])))<1e-7
key=solve({'subjectScaleM':0.5,'spec':{'anchor':[0,0.25,0]}})['key']
assert near(key['position'],[0.6907895,0.8092105,0.8223684])
assert near(key['normal'],[-0.5517373,-0.4689766,-0.6896716])
assert near(key['size'],[0.9868422,0.7401316])
public = studio['solve_studio_rig']
assert public('hero',0.5,1,target_center=(0,0.25,0))['key']==key
assert close(public('hero',0.5,2)['key']['watts'],2*key['watts'])
`));

test('按绝对帧和子帧求灯条绕行；自定义受光集合、开关和倍数不依赖调用顺序', () => offline(`
p={'preset':'mech-plated','spec':{'anchor':[3,4,5]}}
s0,s90=solve(p,0,0),solve(p,180,0)
a,b=s0['strip0']['position'],s90['strip0']['position']
assert near(b,[3+a[2]-5, a[1], 5-(a[0]-3)])
assert s0['key']==s90['key'] and solve(p,0,0)==s0
assert solve(p,8,0.5)['strip0']!=solve(p,8,0)['strip0']
row={'name':'key','position':[0,2,0],'target':[0,0,0],'size':[2,1],'watts':8,'receiverCollection':'body'}
p={'preset':'custom','subjectScaleM':2,'spec':{'anchor':[1,2,3], 'lights':[row],
   'cues':[{'frame':2,'gains':{'key':0}}, {'frame':6,'gains':{'key':0.25}}]}}
original=copy.deepcopy(p)
for f,w in [(9,8),(0,32),(2,0),(5,0),(6,8),(1,32)]:
    light=solve(p,f,0.5)['key']
    assert light['watts']==w and light['position']==(1,6,3) and light['normal']==(0,-1,0)
    assert light['size']==(4,2) and light['receiverCollection']=='body'
assert original==p
body=dict(row, bodyOnly=True); del body['receiverCollection']
pair={'preset':'custom','spec':{'receiverCollection':'parts','lights':[body,dict(body,name='fill',bodyOnly=False)]}}
solved=solve(pair)
assert solved['key']['bodyOnly'] and solved['key']['receiverCollection']=='parts'
assert not solved['fill']['bodyOnly'] and solved['fill']['receiverCollection'] is None
p={'preset':'hero', 'exposureScale':2,'spec':{'cues':[{'frame':4,'exposureScale':0.25}]}}
base=studio['solve_studio_rig']('hero')['key']['watts']
for f,g in [(8,.25),(0,2),(4,.25),(3,2)]: assert close(solve(p,f,0)['key']['watts'],base*g)
p['spec']['cues']=[{'frame':3,'preset':'mech-plated','exposureScale':.5},{'frame':7,'preset':'explode'}]
for f,kind,g in [(8,'explode',.5),(0,'hero',2),(3,'mech-plated',.5),(2,'hero',2)]:
    assert solve(p,f,.75)==solve({'preset':kind, 'exposureScale':g}, f,.75)
`));

test('拒绝坏方案、尺寸、退化朝向、重名及不存在的灯光开关', () => offline(`
base={'name':'key','position':[1,0,0],'size':[1,1],'watts':1}
for scale,exposure in [(0,1),(-1,1),(1,0),(1,-.5)]:
    try: studio['solve_studio_rig']('hero',subject_scale_m=scale,exposure_scale=exposure)
    except studio['BadArgument'] as exc: assert exc.code=='usage.bad-argument' and exc.code in str(exc)
    else: raise AssertionError((scale,exposure))
for p in [{'spec':{'cues':[{'frame':3,'exposureScale':0}]}},{'preset':'typo'},{'preset':'custom'},{'subjectScaleM':0},{'subjectScaleM':True},{'subjectScaleM':math.nan},
          {'spec':{'lights':[base]}},{'preset':'custom','spec':{'lights':[base,base]}},
          {'spec':{'cues':[{'frame':0,'gains':{'typo':2}}]}},
          *[{'preset':'custom','spec':{'lights':[dict(base,**changes)]}} for changes in [
          {'position':[0,0,0]}, {'size':[0,1]}, {'watts':-1}, {'color':[1,2,0]},
          {'widthAxis':[1,0,0]}, {'name':'rig'}, {'receiverCollection':''}, {'bodyOnly':1},
          {'bodyOnly':False,'receiverCollection':'parts'}]]]:
    try: solve(p)
    except ValueError as e: assert e.code=='usage.bad-argument'
    else: raise AssertionError(p)
`));
