import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.py', import.meta.url));
const setup = `
import importlib.util, json, sys
from types import SimpleNamespace as NS
spec = importlib.util.spec_from_file_location('material_library', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert 'bpy' not in sys.modules
names = 'frame_dark frame_black frame_edge fin_black fan_blade fan_hub pcb_black copper gold chip die substrate choke cap steel nickel plastic_black port_metal rubber pad_white emit_white'.split()
`;
function offline(code) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = spawnSync(python, ['-I', '-B', '-c', setup + code, entry], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('L18 全部 21 组 M/R/E 基线、色域与帧统计可离线核对', () => offline(`
assert set(m.list_materials()) == set(names) and len(m.list_materials()) == 21
assert m.validate_assignments({'plate':'gold'}) == {'plate':'gold'}
for call, arg in [(m.get_material_spec, 'unknown'), (m.get_material_spec, []), (m.validate_assignments, {'p':None}), (m.validate_assignments, None)]:
    try: call(arg)
    except ValueError as exc: assert exc.code == 'usage.bad-argument'
    else: raise AssertionError(arg)
readings = m.material_readings(list(names), 2)
assert (readings['materialCount'], readings['assignedCount'], readings['metallicCount'], readings['emissiveCount']) == (21, 2, 10, 1)
roughness = [.50,.50,.26,.36,.43,.30,.36,.27,.30,.50,.07,.42,.55,.28,.33,.38,.46,.25,.82,.68,.50]
metals = {'frame_dark','frame_edge','fan_hub','copper','gold','die','cap','steel','nickel','port_metal'}
for name, rough in zip(names, roughness):
    spec = m.get_material_spec(name)
    assert spec['roughness'] == readings[name+'.roughness'] == rough
    assert readings[name+'.metallic'] == (1 if name in metals else .2 if name == 'choke' else 0)
    assert readings[name+'.emissionStrength'] == (2.5 if name == 'emit_white' else 0)
json.dumps(readings, allow_nan=False)
`));

test('离线记录实际节点连线：Object 坐标、距离淡出、不同表面工艺与发光', () => offline(`
# 记录真正传入宿主的端口；只接受数字索引，不在测试里模拟着色算法。
class Sockets(dict):
    def __init__(self, owner): super().__init__(); self.owner = owner
    def __missing__(self, index):
        assert type(index) == int
        self[index] = s = NS(node=self.owner, index=index, default_value=None, source=None)
        return s
class Nodes(list):
    def new(self, kind):
        n = NS(bl_idname=kind, color_ramp=NS(elements=[NS(),NS()]))
        n.inputs, n.outputs = Sockets(n), Sockets(n)
        self.append(n)
        return n
for name in names:
    nodes = Nodes()
    links = NS(new=lambda src, dst: setattr(dst, 'source', src))
    tree = NS(nodes=nodes, links=links)
    mat = NS(node_tree=tree)
    m.configure_material(mat, name)
    by = lambda kind: [n for n in nodes if n.bl_idname == 'ShaderNode'+kind]
    bsdf, = by('BsdfPrincipled'); out, = by('OutputMaterial')
    assert out.inputs[0].source is bsdf.outputs[0]
    assert bsdf.inputs[1].default_value == m.material_readings([name], 0)[name+'.metallic']
    assert len(mat.diffuse_color) == 4 and all(0 <= v <= 1 for v in mat.diffuse_color)
    if name == 'emit_white':
        assert bsdf.inputs[29].default_value == 2.5 and bsdf.inputs[28].default_value == mat.diffuse_color
    else:
        co, = by('TexCoord'); assert set(co.outputs) == {3}
        assert bsdf.inputs[2].source is not None
    for bump in by('Bump'):
        fade = bump.inputs[0].source.node
        assert fade in by('MapRange') and fade.clamp
        assert fade.inputs[0].source is by('CameraData')[0].outputs[2]
        assert 0 < fade.inputs[1].default_value < fade.inputs[2].default_value
        assert fade.inputs[3].default_value > 0 and fade.inputs[4].default_value == 0
        assert bump.inputs[3].source is not None and bsdf.inputs[6].source is bump.outputs[0]
    if name in ('plastic_black','fan_hub','pcb_black','steel','pad_white'): assert by('Bump')
    if name == 'fan_hub': assert bsdf.inputs[18].source.node in by('Tangent')
    if name == 'pcb_black': assert by('TexWave') and bsdf.inputs[0].source is not None
    if name == 'die': assert by('LayerWeight') and bsdf.inputs[0].source is not None
    if name == 'pad_white': assert bsdf.inputs[9].default_value > 0
`));

test('通配符在当前场景展开并去重；精确名可覆盖，冲突规则不依赖 JSON 键顺序', () => offline(`
objects = {k:NS(type=t, name=k) for k,t in [('part.a','MESH'), ('part.b','MESH'), ('part.lamp','LIGHT'), ('other','MESH')]}
def resolve(rules):
    return {obj.name: name for obj,name in m.resolve_targets(objects, rules)}
rules = {'part.?':'copper', 'part.*':'copper', 'part.a':'gold'}
assert resolve(rules) == resolve(dict(reversed(rules.items()))) == {'part.a':'gold', 'part.b':'copper'}
for rules in [{'part.*':'gold','*.a':'steel'}, {'Part.*':'gold'}, {'part.lamp':'gold'}, {'missing':'gold'}]:
    try: resolve(rules)
    except ValueError as e: assert e.code == 'usage.bad-argument' and 'usage.bad-argument' in str(e)
    else: raise AssertionError(rules)
`));

test('宿主先释放资产时跳过失效 RNA 目标，仍释放 21 个材质；不掩盖其它错误', () => offline(`
class Block:
    def __init__(self, **attrs): self.__dict__.update(attrs); self.live = True
    def as_pointer(self):
        if not self.live: raise ReferenceError('removed')
        return 1
class Slots(list):
    def pop(self, *, index):
        if self.broken: raise RuntimeError('unexpected')
        return super().pop(index)
class Owned(dict):
    def new(self, name): self[name] = obj = Block(name=name); return obj
    def remove(self, obj): del self[obj.name]
owned = Owned(); data = NS(materials=owned)
m.configure_material = lambda mat,name: None
for broken in [False, True]:
    mesh = Block(users=1, materials=Slots()); mesh.materials.broken = broken
    obj = Block(type='MESH', material_slots=[], data=mesh)
    ctx = NS(bpy=NS(data=data), hostScene=NS(objects={'part':obj}))
    handle = m.create(ctx, {'assignments':{'part':'steel'}})
    assert len(owned) == 21
    if broken:
        try: handle['dispose']()
        except RuntimeError as exc: assert str(exc) == 'unexpected'
        else: raise AssertionError('不应吞掉与目标删除无关的错误')
    else:
        mesh.live = obj.live = False
        handle['dispose'](); handle['dispose']()
        assert not owned and len(mesh.materials) == 1  # 不触碰已删除的 mesh
`));

test('坏材质名、无效对象或非网格在分配前被拒绝', () => offline(`
mesh = NS(type='MESH')
ctx = NS(hostScene=NS(objects={'target':mesh, 'lamp':NS(type='LIGHT')}))
for params in [{ 'junk':0 }, {'assignments':[]}, {'assignments':{'target':'unknown'}},
               {'assignments':{'target':'steel', 'missing':'gold'}}, {'assignments':{'lamp':'gold'}},
               {'assignments':{'':'steel'}}, {'assignments':{'target':None}}]:
    try: m.create(ctx, params)
    except ValueError as exc: assert exc.code == 'usage.bad-argument'
    else: raise AssertionError(params)
`));
