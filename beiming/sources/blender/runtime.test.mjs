// 原创折翼测量头：三件飞入，两翼绕各自铰轴展开，装配体按梯形速度曲线转一周。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadContracts } from '../../kernel/contracts/validate.mjs';

const { findBlender, startSource } = await import(pathToFileURL(join(import.meta.dirname, 'host.mjs')).href);
const BLENDER = findBlender();
const requiresBlender = { skip: BLENDER ? false : '本机没有 Blender', timeout: 600000 };
const { validate } = await loadContracts();

const ENTRY = `
import math
import bpy
from mathutils import Vector


def build(ctx):
    rt = ctx.runtime
    tl = rt.Timeline(ctx.fps, ctx.frames)
    tl.segment('dock', 0, 4)
    tl.segment('unfold', 4, 4)
    tl.segment('turn', 8, 9)
    scene = bpy.context.scene
    bpy.ops.object.camera_add(location=(0, -12.5, 0), rotation=(math.pi / 2, 0, 0))
    scene.camera = bpy.context.object
    camera = scene.camera.data
    camera.sensor_fit, camera.sensor_height, camera.lens = 'VERTICAL', 24, 48
    scene.cycles.max_bounces = 0
    scene.view_layers[0].cycles.use_denoising = False

    mat = bpy.data.materials.new('enamel')
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(node for node in tree.nodes if node.type == 'BSDF_PRINCIPLED')
    pins = rt.principled_indices(bsdf)
    for key, kind, value, identifier in [
        ('base_color', 'RGBA', (0.2, 0.3, 0.4, 1), 'Base Color'),
        ('metallic', 'VALUE', 0.25, 'Metallic'),
        ('roughness', 'VALUE', 0.45, 'Roughness'),
        ('emission_color', 'RGBA', (0.8, 0.4, 0.2, 1), 'Emission Color'),
        ('emission_strength', 'VALUE', 1.0, 'Emission Strength'),
    ]:
        rt.set_socket(bsdf, pins[key], value, kind)
        socket = bsdf.inputs[pins[key]]
        assert socket.identifier == identifier, (key, socket.identifier)
        actual = tuple(socket.default_value) if kind == 'RGBA' else (socket.default_value,)
        expected = value if kind == 'RGBA' else (value,)
        assert all(abs(a - b) < 1e-6 for a, b in zip(actual, expected, strict=True)), key

    surface = next(node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL')
    shader_link = rt.link_sockets(tree, bsdf, 0, surface, 0)
    assert shader_link.from_socket == rt.socket_out(bsdf, 0, 'SHADER')
    assert shader_link.to_socket == rt.socket_in(surface, 0, 'SHADER')
    # 越界分别打 Python 负索引、末端后一位和本会被静默截断的金属度值。
    for index, kind, bad in [(pins['roughness'], 'RGBA', 0.5), (-1, 'VALUE', 0.5),
                              (len(bsdf.inputs), 'VALUE', 0.5), (pins['metallic'], 'VALUE', 1.5)]:
        try:
            rt.set_socket(bsdf, index, bad, kind)
        except ValueError:
            pass
        else:
            raise AssertionError(('accepted invalid socket', index, kind))

    def plate(name, half_size, offset=0):
        bpy.ops.mesh.primitive_cube_add(size=2)
        obj = bpy.context.object
        obj.name = name
        for v in obj.data.vertices:
            x, y, z = v.co
            v.co = (x * half_size[0] + offset, y * half_size[1], z * half_size[2])
        obj.data.materials.append(mat)
        return obj

    hub = plate('hub', (0.62, 0.30, 0.52))
    wings = {side: plate(name, (0.76, 0.20, 0.42), side * 0.76)
             for side, name in [(-1, 'left'), (1, 'right')]}
    for wing in wings.values():
        wing.parent = hub
    strength = pins['emission_strength']

    def state(f):
        flying = 1 - rt.smoothstep(tl.progress('dock', f))
        folded = 1 - rt.smoothstep(tl.progress('unfold', f))
        turn = rt.trapezoid_profile(tl.progress('turn', f), 0.25)
        objects = {hub: {'location': (0, -0.25, -1.15 * flying), 'rotation_euler': (0, math.tau * turn, 0)}}
        for side, wing in wings.items():
            objects[wing] = {'location': (side * (1.05 + 1.1 * flying), 0, side * 0.4 * flying),
                             'rotation_euler': (0, -side * math.pi / 3 * folded, 0)}
        return {'objects': objects, 'sockets': {(bsdf, strength, 'VALUE'): 1 + 0.25 * (1 - folded)}}

    def curves(owner):
        anim = owner.animation_data
        action = anim.action
        if hasattr(action, 'fcurves'):
            return action.fcurves
        return action.layers[0].strips[0].channelbag(anim.action_slot).fcurves

    def meta(f):
        readings = {}
        # 所有变换分量及节点树的插口曲线都只准有本次三键。另取两条曲线交给 JS 核值。
        for owner in [hub, *wings.values(), tree]:
            channels = list(curves(owner))
            assert channels, owner.name
            for curve in channels:
                points = curve.keyframe_points
                times = [p.co.x for p in points]
                assert times == [f - 1, f, f + 1], (owner.name, curve.data_path, times, f)
                if owner == hub and curve.data_path == 'rotation_euler' and curve.array_index == 1:
                    for i, p in enumerate(points):
                        readings['spin' + str(i)] = p.co.y
                if owner == tree and curve.data_path == bsdf.inputs[strength].path_from_id('default_value'):
                    for i, p in enumerate(points):
                        readings['glow' + str(i)] = p.co.y
        anchors = {}
        for obj, offset in [(hub, 0), *((wing, side * 0.76) for side, wing in wings.items())]:
            x, y, z = obj.matrix_world @ Vector((offset, 0, 0))
            anchors[obj.name + '#center'] = [x, z, -y]
        return {'anchors': anchors, 'readings': readings,
                'texts': [{'id': 'phase', 'text': str(f), 'bbox2d': [2, 2, 32, 16]}]}

    return {'entities': [{'name': obj.name, 'class': 'part', 'objects': [obj]} for obj in [hub, *wings.values()]],
            'state': state, 'meta': meta}
`;

const SIZE = [480, 384];
const SHOT = { id: 's01', in: 40, out: 57, source: 'blender', host: 'cycles', mode: 'build-script', entry: 'assembly.py', colorRef: 'scene', seed: 73 };
const INPUT = { film: 'f_folding_head', shot: SHOT, output: { size: SIZE, fps: '24000/1001' } };
const CHANNELS = { color: ['R', 'G', 'B', 'A'], depth: ['Z'], normal: ['X', 'Y', 'Z'], objectId: ['id'] };
const FRAMES = [0, 1, 5, 7, 9, 12, 15, 16];
const SHUFFLED = [12, 1, 16, 5, 0, 15, 7, 9];
const smooth = (f) => [0, 7 / 27, 20 / 27, 1][Math.max(0, Math.min(3, f))];
// 八个等长时间间隔，首尾各两格匀加/减速，中间四格每格转 60 度。
const turnAngle = (f) => [0, 15, 60, 120, 180, 240, 300, 345, 360][Math.max(0, Math.min(8, f - 8))] * Math.PI / 180;

function clean(value, contract, schema) {
  const { schemaErrors, violations } = validate(value, contract, schema);
  assert.deepEqual(schemaErrors, []);
  assert.deepEqual(violations, {});
}

function near(got, want, tolerance, label) {
  assert.ok(Math.abs(got - want) <= tolerance, `${label}：实际 ${got}，期望 ${want} ± ${tolerance}`);
}

function expectedCenter(name, f) {
  const flying = 1 - smooth(f), hubHeight = -1.15 * flying;
  if (name === 'hub') return [0, hubHeight, 0.25];
  const side = name === 'left' ? -1 : 1, fold = (1 - smooth(f - 4)) * Math.PI / 3;
  const x = side * (1.05 + 1.1 * flying + 0.76 * Math.cos(fold));
  const y = side * 0.4 * flying + 0.76 * Math.sin(fold);
  const a = turnAngle(f);
  return [Math.cos(a) * x + Math.sin(a) * y, hubHeight - Math.sin(a) * x + Math.cos(a) * y, 0.25];
}

function rasterBoxes(ids, [width, height]) {
  const boxes = new Map();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const id = ids[y * width + x];
    if (id === 0) continue;
    let box = boxes.get(id);
    if (!box) boxes.set(id, box = [x, y, x + 1, y + 1]);
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x + 1); box[3] = Math.max(box[3], y + 1);
  }
  return boxes;
}

function iou(a, b) {
  const area = (box) => (box[2] - box[0]) * (box[3] - box[1]);
  const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return overlap / (area(a) + area(b) - overlap);
}

async function inspect(session, workspace, f, angleDeg = 0) {
  const samples = 8, want = [...Object.keys(CHANNELS), 'meta'];
  const { meta, layers } = await session.render(f, { samples, denoise: 'none', shutter: { angleDeg, samples: 1 } }, want);
  clean(meta);
  const [w, h] = SIZE;
  assert.deepEqual([meta.format, meta.frame, meta.shotFrame, meta.fps, meta.size, meta.seed], ['meta/0.1', SHOT.in + f, f, INPUT.output.fps, SIZE, SHOT.seed]);
  assert.deepEqual([meta.source.host, meta.source.backend, meta.source.samples, meta.camera.shutterAngleDeg], ['cycles', 'CPU', samples, angleDeg]);
  for (const [i, t] of [f - 1, f, f + 1].entries()) {
    near(meta.readings[`spin${i}`], turnAngle(t), 1e-5, `帧 ${f} 转轴在 ${t} 的键值`);
    near(meta.readings[`glow${i}`], 1 + 0.25 * smooth(t - 4), 1e-6, `帧 ${f} 发光插口在 ${t} 的键值`);
  }
  const hashes = {}, pixels = {};
  assert.deepEqual(Object.keys(layers).sort(), Object.keys(CHANNELS).sort());
  for (const [name, components] of Object.entries(CHANNELS)) {
    const ref = layers[name];
    clean(ref, 'source', 'layer-ref.schema.json');
    assert.deepEqual([ref.shape, ref.components], [[h, w, components.length], components]);
    const bytes = await readFile(join(workspace, ref.file));
    assert.equal(bytes.length, w * h * components.length * 4);
    hashes[name] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(ref.hash, hashes[name]);
    const Type = name === 'objectId' ? Uint32Array : Float32Array;
    pixels[name] = new Type(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  }
  assert.equal(meta.hash.color, hashes.color);
  const boxes = rasterBoxes(pixels.objectId, SIZE);
  assert.deepEqual([...boxes.keys()].sort(), [1, 2, 3]);
  assert.deepEqual(meta.entities.map(e => [e.id, e.name]), [[1, 'hub'], [2, 'left'], [3, 'right']]);
  let minIou = 1;
  for (const entity of meta.entities) {
    const box = boxes.get(entity.id), score = iou(box, entity.bbox2d);
    minIou = Math.min(minIou, score);
    assert.ok(score >= 0.95, `帧 ${f} ${entity.name} IoU ${score}，编号层 ${box}，元数据 ${entity.bbox2d}`);
    const center = expectedCenter(entity.name, f), anchor = entity.anchors.center;
    center.forEach((v, k) => near(anchor.world[k], v, 1e-5, `帧 ${f} ${entity.name} 世界锚点 ${k}`));
    const focalPx = h * 48 / 24, distance = 12.5 - center[2];
    const screen = [w / 2 + focalPx * center[0] / distance, h / 2 - focalPx * center[1] / distance];
    screen.forEach((v, k) => near(anchor.screen[k], v, 1e-3, `帧 ${f} ${entity.name} 投影锚点 ${k}`));
    const at = Math.floor(screen[1]) * w + Math.floor(screen[0]);
    assert.equal(pixels.objectId[at], entity.id);
    near(pixels.depth[at], distance - (entity.name === 'hub' ? 0.30 : 0.20), 1e-3, `${entity.name} 正面深度`);
    near(pixels.normal[3 * at + 2], 1, 1e-5, `${entity.name} 正面法线`);
    if (angleDeg === 0) near(pixels.color[4 * at], 0.8 * (1 + 0.25 * smooth(f - 4)), 1e-4, `${entity.name} 线性发光红分量`);
  }
  const { timing, ...deterministic } = meta;
  assert.ok(timing.renderMs > 0);
  return { snapshot: { hashes, meta: deterministic }, color: pixels.color, minIou };
}

test('Cycles CPU 折翼装配：顺序、乱序、独立单帧的各层和 K9 元数据，三键与原生快门', requiresBlender, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-folding-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, SHOT.entry), ENTRY);
  const reference = new Map();

  async function batch(label, frames, baseline = false) {
    const workspace = join(root, label);
    const src = await startSource({ device: 'cpu', limitMs: 120000 });
    try {
      const session = await src.open(INPUT, { filmDir: root, workspace, tier: 'final', lock: null });
      try {
        const manifest = session.manifest();
        clean(manifest, 'source', 'manifest.schema.json');
        assert.equal(manifest.frames, 17);
        for (const f of frames) {
          const { snapshot, color, minIou } = await inspect(session, workspace, f, 180);
          if (baseline) {
            reference.set(f, snapshot);
            t.diagnostic(`帧 ${f} 的最小 IoU：${minIou.toFixed(4)}`);
          } else assert.deepEqual(snapshot, reference.get(f), `${label} 帧 ${f} 各层文件内容和确定性元数据`);
          if (baseline && f === 12) {
            const sharp = await inspect(session, workspace, f);
            for (const name of ['depth', 'normal', 'objectId']) assert.equal(sharp.snapshot.hashes[name], snapshot.hashes[name], name);
            // 快门起点的轮廓之外出现拖影。统计透明变为可见的像素，排除 RGB 采样噪声。
            let trail = 0;
            for (let i = 3; i < color.length; i += 4) if (sharp.color[i] === 0 && color[i] >= 0.25) trail++;
            t.diagnostic(`帧 ${f} 的 180° 快门在原轮廓外新增 ${trail} 个覆盖像素`);
            assert.ok(trail > 100, `开 180 度快门后只有 ${trail} 个新增覆盖像素`);
          }
        }
      } finally { await session.close(); }
    } finally { await src.stop(); }
  }

  await batch('ordered', FRAMES, true);
  await batch('shuffled', SHUFFLED);
  for (const f of FRAMES) await batch(`single-${f}`, [f]);
});

// 与 Blender 是否存在无关。按文件路径加载纯 Python 模块，-I -B 隔离路径且不写缓存。
function python(body) {
  const run = spawnSync(process.execPath, [join(import.meta.dirname, '../../../tools/env/py.mjs'), '-I', '-B', '-c', `
import importlib.util, json, sys
from fractions import Fraction
from types import SimpleNamespace as NS
from unittest import TestCase
check = TestCase()
spec = importlib.util.spec_from_file_location('runtime', sys.argv[1])
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
${body}`, join(import.meta.dirname, 'runtime.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  return run.stdout;
}

test('K1：有理帧率、半开段与标记、缓动及梯形位移，导出的表过正式事件校验', () => {
  const events = JSON.parse(python(`
t = rt.Timeline('24000/1001', 30)
t.segment('dock', 0, 5).segment('spin', t.after('dock', 2), 10).mark('cue', 7)
assert t.span('spin') == (7, 17) and t.frame_of('cue') == 7
assert t.frame_to_seconds(24000) == Fraction(1001) and t.frame_to_seconds(1) == Fraction(1001, 24000)
assert [t.progress('spin', f) for f in (-1, 7, 10, 16, 18)] == [0, 0, 1/3, 1, 1]
assert [t.progress('cue', f) for f in (6, 7, 8)] == [0, 1, 1]
assert rt.Timeline(30).fps == rt.Timeline('30/1').fps == 30
for fps in (0, True, -2, '30/0', 23.976):
    with check.assertRaises(ValueError): rt.Timeline(fps)
for args in [('spin', 0, 1), ('bad name', 0, 1), ('last', 30, 1), ('neg', -1, 2), ('empty', 1, 0)]:
    with check.assertRaises(ValueError): t.segment(*args)
assert rt.smoothstep(.25) == 5/32 and rt.ease_in_out(.25) == 1/8
for fn in (rt.smoothstep, rt.ease_in_out, rt.trapezoid_profile):
    assert [fn(u) for u in (-1, 0, .5, 1, 2)] == [0, 0, .5, 1, 1]
for i, u in enumerate((0, .125, .25, .5, .75, .875, 1)):
    check.assertAlmostEqual(rt.trapezoid_profile(u, .25), [0, 1/24, 1/6, .5, 5/6, 23/24, 1][i])
assert rt.trapezoid_profile(.3, 0) == .3
with check.assertRaises(ValueError): rt.trapezoid_profile(.5, .51)
print(json.dumps(t.export_events('f_runtime')))`));
  clean(events);
  assert.deepEqual([events.frames, events.fps], [30, '24000/1001']);
  assert.deepEqual(events.events.map(e => [e.frame, e.id]), [[0, 'dock'], [7, 'cue'], [7, 'spin']]);
});

test('K3：只调用三次，先删受管曲线，保留非目标动画；缺少通道不能沿用上次的值', () => {
  python(`
class Object:
    def __init__(self):
        self.id_data = self
        self.curves = []
        self.animation_data = NS(action=NS(users=1, fcurves=self.curves))
        self.rotation_mode = 'XYZ'
    def path_from_id(self, p): return p
    def keyframe_insert(self, data_path, frame):
        line = next((c for c in self.curves if c.data_path == data_path), None)
        if line is None:
            line = NS(data_path=data_path, keyframe_points=[])
            self.curves.append(line)
        line.keyframe_points.append(NS(frame=frame, value=getattr(self, data_path), interpolation='BEZIER'))
        return True
obj = Object()
obj.keyframe_insert('rotation_mode', 123)
foreign = obj.curves[0]
log, sets = [], []
def state(t):
    log.append(t)
    return {'objects': {obj: {'location': (t, -t, 0), 'hide_render': t < 2,
                              'rotation_quaternion': ((-1)**t, 0, 0, 0)}}} if t < 30 else {}
k = rt.StateKernel(state)
scene = NS(frame_set=lambda f, subframe: sets.append((f, subframe)))
for f in (0, 17, 3, 0):
    log.clear()
    k.write(scene, f)
    assert log == [f-1, f, f+1] and sets[-1] == (f, 0)
    assert obj.curves[0] is foreign and foreign.keyframe_points[0].interpolation == 'BEZIER'
    assert len(obj.curves) == 4
    for c in obj.curves[1:]:
        pts = c.keyframe_points
        assert [p.frame for p in pts] == log
        assert all(p.interpolation == ('CONSTANT' if c.data_path == 'hide_render' else 'LINEAR') for p in pts)
        if c.data_path == 'location': assert [p.value[0] for p in pts] == log
        if c.data_path == 'rotation_quaternion': assert len({p.value for p in pts}) == 1
for f in (29, 31):
    with check.assertRaises(ValueError): k.write(scene, f)
assert sets[-1] == (0, 0)
assert rt.to_beiming(rt.to_blender((1, 2, 3))) == (1, 2, 3)`);
});

test('插口：只认非负整数、方向和类型；同一着色器的两种序号布局都按 RNA 标识识别', () => {
  python(`
class Node: pass
def socket(identifier, kind): return NS(identifier=identifier, name='统一的显示名', type=kind)
tree = NS(links=NS(new=lambda a,b: (a,b)))
keys = [('Base Color', 'RGBA'), ('Metallic', 'VALUE'), ('Roughness', 'VALUE'), ('IOR', 'VALUE'),
        ('Alpha', 'VALUE'), ('Emission Color', 'RGBA'), ('Emission Strength', 'VALUE')]
for pad in (0, 2):
    bs = Node()
    bs.id_data, bs.bl_idname = tree, 'ShaderNodeBsdfPrincipled'
    bs.inputs = [socket(*v) for v in keys[:5]] + [socket(str(i), 'VALUE') for i in range(pad)] + [socket(*v) for v in keys[5:]]
    ix = rt.principled_indices(bs)
    assert ix['emission_color'] == 5 + pad
    i = ix['roughness']
    s = rt.set_socket(bs, i, .25, 'VALUE')
    assert s is bs.inputs[i] and s.default_value == .25
    src = NS(id_data=tree, outputs=[socket('value', 'VALUE')])
    assert rt.link_sockets(tree, src, 0, bs, i) == (rt.socket_out(src, 0, 'VALUE'), s)
    for j in (-1, len(bs.inputs), True, 1., '0'):
        with check.assertRaises(ValueError): rt.socket_in(bs, j)
    with check.assertRaises(ValueError): rt.socket_out(src, 1)
    with check.assertRaises(ValueError): rt.set_socket(bs, i, .3, 'RGBA')
    with check.assertRaises(ValueError): rt.set_socket(bs, i, '0.3')
    with check.assertRaises(ValueError): rt.set_socket(bs, ix['base_color'], (1, 1, 1))
    with check.assertRaises(ValueError): rt.link_sockets(tree, src, 0, bs, ix['base_color'])
    bs.inputs[i].type = 'VECTOR'
    with check.assertRaises(ValueError): rt.principled_indices(bs)`);
});

test('K4：只并入合法的文字/锚点/读数，坐标与缩放按实际相机和画幅，不改测量原件', () => {
  python(`
cam = {'world': [1,0,0,0, 0,1,0,0, 0,0,1,0, 2,0,0,1],
       'proj': [1,0,0,0, 0,2,0,0, 0,0,-1,-1, 0,0,-1,0]}
m = {'camera':cam, 'entities':[{'name':'wing', 'bbox2d':[0,0,20,10]}]}
c = rt.MetaCollector({'texts':[{'text':'A', 'bbox2d':[0,2,20,8]}], 'readings':{'a':.5}})
c.add_anchor('wing#tip', (3, 2, 1), blender=True)
r = c.merge(m, [20, 10], [40, 20])
assert r['texts'] == [{'text':'A', 'bbox2d':[0,1,10,4]}] and r['readings'] == {'a':.5}
assert r['entities'][0]['anchors'] == {'tip':{'world':[3,1,-2], 'screen':[15,0]}}
assert r['camera'] == cam and r['entities'][0]['bbox2d'] == [0,0,20,10] and 'anchors' not in m['entities'][0]
for fields in ({'camera':{}}, {'texts':{}}, {'texts':[{'text':'A','bbox2d':[1,0,0,0]}]},
               {'texts':[{'text':'','bbox2d':[0,0,0,0]}]}, {'texts':[{'text':'a','id':1,'bbox2d':[0,0,1,1]}]},
               {'anchors':{'wing#tip':[1,False,2]}}, {'anchors':{'wing':[1,2,3]}}, {'readings':{'':1}},
               {'readings':{'x':float('nan')}}, {'readings':{'x':10**400}}, {'readings':{'x':'3'}}):
    with check.assertRaises(ValueError): rt.MetaCollector(fields)
for anchors in ({'unknown#x':[0,0,-1]}, {'wing#eye':[0,0,0]}):
    with check.assertRaises(ValueError): rt.MetaCollector({'anchors':anchors}).merge(m, [20,10])
with check.assertRaises(ValueError): c.add_anchor('wing#tip', (0,0,0))`);
});

test('worker 行协议：仅请求元数据时也按帧交文字框，不把上一帧带来', requiresBlender, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-runtime-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'labels.py');
  await writeFile(entry, `
import bpy
from mathutils import Vector

def build(ctx):
    bpy.ops.object.camera_add(location=(0, 0, 12))
    bpy.context.scene.camera = bpy.context.object
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    def state(f):
        # 局部矩阵同时含位移、90° 旋转和非均匀缩放；相邻样本切换可见性。
        return {'objects': {obj: {'matrix': [[0,-2,0,f], [1,0,0,0], [0,0,3,0], [0,0,0,1]],
                                  'hide_render': bool(f % 2), 'hide_viewport': bool(f % 2)}}}
    def meta(f):
        m = obj.matrix_world
        assert (m.translation - Vector((f,0,0))).length < 1e-5, (f, list(m.translation), list(obj.location))
        assert (m.to_3x3() @ Vector((1,1,1)) - Vector((-2,1,3))).length < 1e-5, str(m)
        assert obj.hide_render == obj.hide_viewport == bool(f % 2), (f, obj.hide_render, obj.hide_viewport)
        return {'texts': [{'id':'phase', 'text':str(f), 'bbox2d':[2,2,32,16]}]}
    return {'entities':[{'name':'body','class':'part','objects':[obj]}], 'state':state, 'meta':meta}
`);
  const messages = [
    { op: 'open', frames: 17, fps: INPUT.output.fps, size: SIZE, seed: 73, tier: 'final', tokens: {}, colorRef: 'scene', entry },
    ...[4, 1].map(f => ({ op: 'render', f, plan: { layers: [], size: SIZE.map(n => n / 2) } })), { op: 'quit' },
  ];
  const run = spawnSync(BLENDER, ['-b', '-noaudio', '--factory-startup', '--python', join(import.meta.dirname, 'worker.py'), '--', root, '--cpu'], {
    input: messages.map((m, id) => JSON.stringify({ ...m, id }) + '\n').join(''), encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const replies = run.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.deepEqual(replies.map(r => [r.id, r.ok]), [[0, true], [1, true], [2, true]]);
  for (const [i, frame] of [4, 1].entries()) {
    const { texts, entities } = replies[i + 1].result;
    assert.deepEqual(texts, [{ id: 'phase', text: String(frame), bbox2d: [1, 1, 16, 8] }]);
    const box = entities[0].bbox3d;
    near((box[0] + box[3]) / 2, frame, 1e-5, '视口隐藏的物体也不能量到上次可见时的世界姿态');
  }
});

test('K4 公开帧源：按帧透传文字框，并标记本帧有值的镜头字段', requiresBlender, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beiming-runtime-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, SHOT.entry), `
import bpy

def build(ctx):
    bpy.ops.object.camera_add(location=(0, 0, 12))
    bpy.context.scene.camera = bpy.context.object
    entities = []
    for x, name in enumerate(('base', 'wing')):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 0, 0))
        entities.append({'name': name, 'class': 'part', 'objects': [bpy.context.object]})
    def meta(f):
        return {'texts': [{'id': 'phase', 'text': str(f), 'bbox2d': [2, 2, 32, 16]}] if f in (1, 4) else [],
                'anchors': {'wing#tip': [1, 0, 0]} if f in (2, 4) else {},
                'readings': {'phase': f} if f in (3, 4) else {}}
    return {'entities': entities, 'meta': meta}
`);
  const src = await startSource({ device: 'cpu' });
  try {
    assert.ok(!src.caps().metaNull.includes('texts'));
    const session = await src.open(INPUT, { filmDir: root, workspace: root, tier: 'final', lock: null });
    try {
      for (const [f, fields] of [[4, ['entities.*.anchors', 'texts', 'readings']], [0, []],
        [2, ['entities.*.anchors']], [3, ['readings']], [1, ['texts']]]) {
        const { meta } = await session.render(f, {}, ['meta']);
        clean(meta);
        assert.deepEqual(meta.origin.shot, fields);
        assert.deepEqual(meta.texts, fields.includes('texts') ? [{ id: 'phase', text: String(f), bbox2d: [2, 2, 32, 16] }] : null);
        assert.deepEqual(meta.entities[1].anchors?.tip?.world, fields.includes('entities.*.anchors') ? [1, 0, 0] : undefined);
        assert.deepEqual(meta.readings, fields.includes('readings') ? { phase: f } : undefined);
      }
    } finally { await session.close(); }
  } finally { await src.stop(); }
});
