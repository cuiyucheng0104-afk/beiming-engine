# 校准场景在 Blender 上的搭法（各场景目录里的 shot.blender.py 共用）：照 scene.json 的规格搭几何、自发光材质、相机和匀速运动。
# 渲染设置、采样、编号都由帧源做（beiming/sources/blender/），这里只搭场景。搭法沿用一致性夹具 v4-blender.py，补了平面和匀速直线运动。
# 规格的 (x, y, z)（Y 向上）写成 Blender 的 (x, -z, y)；传感器竖直适配；世界 = R运动 · R静态，同 check.mjs 的 objectTransform。
import json
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

C3 = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)


def mat4(rot, pos):
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = pos
    return Matrix(m.tolist())


def axis_angle(axis, angle):
    a = np.array(axis, float) / np.linalg.norm(axis)
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * k @ k


def keyframes(idb, path, keys):
    """两个关键帧、线性插值、线性外推：任意时刻都是精确的匀速。keys 是 { 分量下标: (第 0 帧的值, 第 1 帧的值) }"""
    idb.animation_data_create()
    action = bpy.data.actions.new(idb.name)
    idb.animation_data.action = action
    for index, values in keys.items():
        curve = action.fcurve_ensure_for_datablock(idb, path, index=index)
        for frame, value in enumerate(values):
            curve.keyframe_points.insert(frame, value).interpolation = 'LINEAR'
        curve.extrapolation = 'LINEAR'


def mesh(o):
    bm = bmesh.new()
    shape = o['shape']
    if shape == 'box':
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=o['sizeM'], verts=bm.verts)
    elif shape == 'plane':  # 局部 XY 平面，法线 +Z
        x, y = (side / 2 for side in o['sizeM'])
        bm.faces.new([bm.verts.new(p) for p in ((-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0))])
    elif shape == 'sphere':
        bmesh.ops.create_uvsphere(bm, u_segments=128, v_segments=64, radius=o['radiusM'])
        for face in bm.faces:
            face.smooth = True
    elif shape == 'cylinder':  # 轴沿局部 Y：bmesh 的圆锥轴沿 Z，绕 X 转 -90 度
        bmesh.ops.create_cone(bm, cap_ends=True, segments=128, radius1=o['radiusM'], radius2=o['radiusM'], depth=o['heightM'])
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'))
    else:
        raise ValueError(f'不认识形体 {shape}')
    data = bpy.data.meshes.new(o['id'])
    bm.to_mesh(data)
    bm.free()
    return data


def build_scene(ctx, scene_path):
    with open(scene_path, encoding='utf8') as f:
        spec = json.load(f)
    scene = bpy.context.scene
    world = bpy.data.worlds.new('calib')
    world.use_nodes = True
    scene.world = world
    background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    background.inputs[0].default_value = (*spec['backgroundLinear'], 1)
    background.inputs[1].default_value = 1

    c = spec['camera']
    pos = np.array(c['positionM'], float)
    fwd = np.array(c['lookAtM'], float) - pos
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, c['upDir'])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    lens = bpy.data.cameras.new('cam')
    lens.sensor_fit, lens.sensor_height = 'VERTICAL', 24
    lens.lens = 12 / math.tan(math.radians(c['yFovDeg']) / 2)
    lens.clip_start, lens.clip_end = c['nearM'], c['farM']
    cam = bpy.data.objects.new('cam', lens)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.matrix_world = mat4(C3 @ np.column_stack([right, up, -fwd]), C3 @ pos)

    entities = []
    for o in spec['objects']:
        material = bpy.data.materials.new(o['id'])
        material.use_nodes = True
        tree = material.node_tree
        tree.nodes.clear()
        emission, output = tree.nodes.new('ShaderNodeEmission'), tree.nodes.new('ShaderNodeOutputMaterial')
        emission.inputs[0].default_value = (*o['emissionLinear'], 1)
        emission.inputs[1].default_value = 1
        tree.links.new(emission.outputs[0], output.inputs[0])
        data = mesh(o)
        data.materials.append(material)
        ob = bpy.data.objects.new(o['id'], data)
        scene.collection.objects.link(ob)

        rs = axis_angle(o['rotation']['axisDir'], o['rotation']['angleRad']) if 'rotation' in o else np.eye(3)
        p, motion = np.array(o['positionM'], float), o.get('motion')
        if motion and motion['kind'] == 'spin':  # 父空物体在枢轴上绕轴转，子物体带静态旋转
            pivot = np.array(motion['pivotM'], float)
            axis = np.array(motion['axisDir'], float)
            parent = bpy.data.objects.new(o['id'] + '-pivot', None)
            scene.collection.objects.link(parent)
            parent.location, parent.rotation_mode = Vector(C3 @ pivot), 'AXIS_ANGLE'
            parent.rotation_axis_angle = (0, *(C3 @ (axis / np.linalg.norm(axis))))
            keyframes(parent, 'rotation_axis_angle', {0: (0, motion['angularVelocityRadPerFrame'])})
            ob.parent = parent
            ob.matrix_parent_inverse = Matrix.Identity(4)
            ob.matrix_basis = mat4(C3 @ rs, C3 @ (p - pivot))
        elif motion and motion['kind'] == 'linear':
            ob.matrix_basis = mat4(C3 @ rs, C3 @ p)
            start, step = C3 @ p, C3 @ np.array(motion['velocityMPerFrame'], float)
            keyframes(ob, 'location', {i: (start[i], start[i] + step[i]) for i in range(3)})
        elif motion:
            raise ValueError(f"不认识运动 {motion['kind']}")
        else:
            ob.matrix_basis = mat4(C3 @ rs, C3 @ p)
        entities.append({'name': o['id'], 'class': 'part', 'objects': [ob]})
    return {'entities': entities}
