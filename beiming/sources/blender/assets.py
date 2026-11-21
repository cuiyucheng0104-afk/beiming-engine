# Blender 帧源的资产：把一个资产文件载进当前场景，交回它的零件。worker.py 在固定装载的第 1 步、ctx.assets.load 里调。
# 认四种文件，按扩展名分：
#   .json  合成硬表面几何的说明（格式 kit-spec/0.1，内置演示资产 asset:rtx-card@1 就是一份，见同目录 rtx-card.json）：
#          长度米，北冥坐标（右手系，Y 向上），颜色线性光；每个零件搭成一个网格物体，带材质；说明里的灯和环境光一起搭进场景。
#   .glb   glTF 二进制，用 Blender 自带的导入器（glTF 自己是米、Y 向上，导入器换成 Blender 的 Z 向上）。
#   .stl   用 Blender 自带的导入器，坐标原样当 Blender 的坐标（Z 向上），单位当米。
#   .blend 把文件里的全部物体追加进来（不是链接），相机不要。
# 零件：说明里的每一项；导入的文件里每个网格物体一个。零件的物体改名叫 <别名>.<零件名>，零件名只留字母、数字、下划线，重名的加 _2、_3。
# 相机不进场景：取哪台相机归固定装载脚本定。
import json
import math
import os
import re

import bmesh
import bpy
from mathutils import Matrix, Vector

# 北冥的 (x, y, z) → Blender 的 (x, -z, y)
TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
RENDERABLE = ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'CURVES', 'POINTCLOUD', 'VOLUME')


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def _material(name, spec):
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*spec['base'], 1.0)
    bsdf.inputs['Metallic'].default_value = spec['metallic']
    bsdf.inputs['Roughness'].default_value = spec['roughness']
    if 'emission' in spec:
        bsdf.inputs['Emission Color'].default_value = (*spec['emission'], 1.0)
        bsdf.inputs['Emission Strength'].default_value = spec['strength']
    return m


def _box(bm, item):
    size, at = item['size'], item['at']
    rep = item.get('repeat', {'count': 1, 'step': [0, 0, 0]})
    for k in range(rep['count']):
        c = [at[i] + k * rep['step'][i] for i in range(3)]
        verts = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((*size, 1.0)))['verts']
        if item.get('bevel'):
            edges = list({e for v in verts for e in v.link_edges})
            bmesh.ops.bevel(bm, geom=edges, offset=item['bevel'], offset_type='OFFSET', segments=2, profile=0.5, affect='EDGES', clamp_overlap=True)


def _cylinder(bm, item):
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=48, radius1=item['radius'], radius2=item['radius'],
                          depth=item['depth'], matrix=Matrix.Translation(item['at']))


def _ring(bm, item):
    """绕 Z 轴的方截面圆环：截面的四条边绕轴扫一圈，首尾焊上"""
    r0, r1, h = item['inner'], item['outer'], item['depth'] / 2.0
    cx, cy, cz = item['at']
    loop = [bm.verts.new((cx + x, cy, cz + z)) for x, z in ((r0, -h), (r1, -h), (r1, h), (r0, h))]
    edges = [bm.edges.new((loop[i], loop[(i + 1) % 4])) for i in range(4)]
    bmesh.ops.spin(bm, geom=loop + edges, cent=item['at'], axis=(0, 0, 1), angle=2 * math.pi, steps=64, use_merge=True)


def _blades(bm, item):
    """风扇叶：count 片薄板绕 Z 轴均布，每片绕自己的长轴转 pitchDeg 度"""
    r0, r1 = item['inner'], item['outer']
    for k in range(item['count']):
        m = (Matrix.Translation(item['at']) @ Matrix.Rotation(2 * math.pi * k / item['count'], 4, 'Z') @ Matrix.Translation(((r0 + r1) / 2, 0, 0))
             @ Matrix.Rotation(math.radians(item['pitchDeg']), 4, 'X') @ Matrix.Diagonal((r1 - r0, item['width'], item['thickness'], 1.0)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)


SHAPES = {'box': _box, 'cylinder': _cylinder, 'ring': _ring, 'blades': _blades}


def _kit(path, alias, scene):
    """照 kit-spec/0.1 的说明搭：每个零件一个网格物体（几何先在北冥坐标里搭，再整体换到 Blender 坐标），加灯和环境光"""
    with open(path, encoding='utf-8') as f:
        spec = json.load(f)
    if spec.get('format') != 'kit-spec/0.1':
        raise ValueError('资产说明 %s 的 format 不是 kit-spec/0.1' % os.path.basename(path))
    mats = {name: _material('%s.%s' % (alias, name), m) for name, m in spec['materials'].items()}
    parts = {}
    for part, items in spec['parts'].items():
        bm = bmesh.new()
        used = []
        for item in items:
            before = set(bm.faces)
            SHAPES[item['shape']](bm, item)
            if item['material'] not in used:
                used.append(item['material'])
            for face in bm.faces:
                if face not in before:
                    face.material_index = used.index(item['material'])
        bmesh.ops.transform(bm, matrix=TO_BLENDER, verts=bm.verts)
        bm.normal_update()
        mesh = bpy.data.meshes.new('%s.%s' % (alias, part))
        bm.to_mesh(mesh)
        bm.free()
        for name in used:
            mesh.materials.append(mats[name])
        obj = bpy.data.objects.new('%s.%s' % (alias, part), mesh)
        scene.collection.objects.link(obj)
        parts[part] = obj
    for light in spec.get('lights', []):
        data = bpy.data.lights.new('%s.%s' % (alias, light['name']), 'AREA')
        data.size, data.energy, data.color = light['size'], light['watts'], light['color']
        obj = bpy.data.objects.new('%s.light.%s' % (alias, light['name']), data)
        obj.location = to_blender(light['at'])
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = (to_blender(light['aim']) - obj.location).to_track_quat('-Z', 'Y')
        scene.collection.objects.link(obj)
    env = spec.get('environment')
    if env and scene.world is None:
        # 环境光只照明，不进相机：背景照样透明
        world = bpy.data.worlds.new('%s.environment' % alias)
        if not world.node_tree:
            world.use_nodes = True
        bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
        bg.inputs['Color'].default_value = (*env['color'], 1.0)
        bg.inputs['Strength'].default_value = env['strength']
        world.cycles_visibility.camera = False
        scene.world = world
    return parts


def _imported(path, kind, scene):
    """用 Blender 自带的导入器或追加，交回新进场景的物体"""
    before = set(bpy.data.objects)
    if kind == 'glb':
        bpy.ops.import_scene.gltf(filepath=path)
    elif kind == 'stl':
        bpy.ops.wm.stl_import(filepath=path)
    else:
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        for obj in dst.objects:
            if obj is not None and obj.type != 'CAMERA' and obj.name not in scene.collection.all_objects:
                scene.collection.objects.link(obj)
    new = [o for o in bpy.data.objects if o not in before]
    for cam in [o for o in new if o.type == 'CAMERA']:
        bpy.data.objects.remove(cam)
    return [o for o in bpy.data.objects if o not in before]


def load(path, kind, alias, scene):
    """载入一个资产，交回 { 零件名: 物体 }。零件名只有字母、数字、下划线；零件的物体都改名叫 <别名>.<零件名>"""
    if kind == 'kit':
        return _kit(path, alias, scene)
    parts = {}
    for obj in sorted((o for o in _imported(path, kind, scene) if o.type in RENDERABLE), key=lambda o: o.name.encode('utf-8')):
        base = re.sub(r'[^A-Za-z0-9_]', '_', obj.name) or 'part'
        name, n = base, 1
        while name in parts:
            n += 1
            name = '%s_%d' % (base, n)
        obj.name = '%s.%s' % (alias, name)
        parts[name] = obj
    if not parts:
        raise ValueError('资产 %s 里没有可渲的物体' % os.path.basename(path))
    return parts
