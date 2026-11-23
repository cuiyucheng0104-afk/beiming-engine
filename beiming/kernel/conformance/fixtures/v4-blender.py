# V4 补录用的 Blender 镜头入口（build-script 模式）：照校准场景「三轴标记加转台」的规格搭场景，规格直接读校准目录，不抄。
# 由 v4-probe.mjs 经 Blender 帧源（beiming/sources/blender/host.mjs 的 startSource → open → render）调用；渲染设置、采样、
# 编号、法线转相机空间都由帧源做，这里只搭几何、材质、相机和动画。搭法同探针表 Blender 适配器（提交 02f498f）：
# 规格 (x, y, z) 写成 Blender (x, -z, y)，传感器竖直适配，世界 = R运动 · R静态；球改平滑着色（和 three 的 SphereGeometry 一样）。
import json, math, os
import bpy, bmesh, numpy as np
from mathutils import Matrix, Vector

CALIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'calib')
C3 = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)


def mat4(R, T): m = np.eye(4); m[:3, :3] = R; m[:3, 3] = T; return Matrix(m.tolist())


def axis_angle(axis, ang):
    a = np.array(axis, float) / np.linalg.norm(axis); K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K


def cam_basis(c):
    pos = np.array(c['positionM'], float); fwd = np.array(c['lookAtM']) - pos; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, c['upDir']); right /= np.linalg.norm(right)
    return pos, fwd, right, np.cross(right, fwd)


def fcurves(idb, path, keys):  # 两个关键帧、线性插值、线性外推：任意时刻都是精确的匀速
    idb.animation_data_create(); act = bpy.data.actions.new(idb.name); idb.animation_data.action = act
    for i, (v0, v1) in keys.items():
        fc = act.fcurve_ensure_for_datablock(idb, path, index=i)
        for fr, v in ((0, v0), (1, v1)): fc.keyframe_points.insert(fr, v).interpolation = 'LINEAR'
        fc.extrapolation = 'LINEAR'


def mesh(o):
    bm = bmesh.new(); sh = o['shape']
    if sh == 'box': bmesh.ops.create_cube(bm, size=1); bmesh.ops.scale(bm, vec=o['sizeM'], verts=bm.verts)
    elif sh == 'sphere':
        bmesh.ops.create_uvsphere(bm, u_segments=128, v_segments=64, radius=o['radiusM'])
        for f in bm.faces: f.smooth = True
    elif sh == 'cylinder':  # 轴沿局部 Y：bmesh 的圆锥轴沿 Z，绕 X 转 -90 度
        bmesh.ops.create_cone(bm, cap_ends=True, segments=128, radius1=o['radiusM'], radius2=o['radiusM'], depth=o['heightM'])
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'))
    else: raise ValueError(f"不认识形体 {sh}")
    me = bpy.data.meshes.new(o['id']); bm.to_mesh(me); bm.free(); return me


def build(ctx):
    # 三个单渲各开一个会话；保留所有实体的名字和编号，只让目标方块参与渲染。
    solo = ctx.tokens.get('probeSoloCube')
    scene = 'probe-axes-turntable' if solo is None else 'probe-occlusion'
    with open(os.path.join(CALIB, scene, 'scene.json'), encoding='utf8') as f:
        s = json.load(f)
    if solo is not None and solo not in [o['id'] for o in s['objects']]:
        raise ValueError(f'遮挡场景没有实体 {solo}')
    sc = bpy.context.scene; c = s['camera']
    if list(ctx.size) != [c['widthPx'], c['heightPx']]: raise ValueError(f"画幅 {ctx.size} 和规格 {c['widthPx']}x{c['heightPx']} 不符")
    w = bpy.data.worlds.new('w'); w.use_nodes = True; sc.world = w
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND'); bg.inputs[0].default_value = (*s['backgroundLinear'], 1); bg.inputs[1].default_value = 1
    pos, fwd, right, up = cam_basis(c)
    cd = bpy.data.cameras.new('cam'); cd.sensor_fit, cd.sensor_height = 'VERTICAL', 24
    cd.lens = 12 / math.tan(math.radians(c['yFovDeg']) / 2); cd.clip_start, cd.clip_end = c['nearM'], c['farM']
    cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cam.matrix_world = mat4(C3 @ np.column_stack([right, up, -fwd]), C3 @ pos)
    entities = []
    for o in s['objects']:
        mat = bpy.data.materials.new(o['id']); mat.use_nodes = True; nt = mat.node_tree; nt.nodes.clear()
        em, mo = nt.nodes.new('ShaderNodeEmission'), nt.nodes.new('ShaderNodeOutputMaterial')
        em.inputs[0].default_value = (*o['emissionLinear'], 1); em.inputs[1].default_value = 1; nt.links.new(em.outputs[0], mo.inputs[0])
        me = mesh(o); me.materials.append(mat)
        ob = bpy.data.objects.new(o['id'], me); sc.collection.objects.link(ob)
        ob.hide_render = solo is not None and o['id'] != solo
        rs = axis_angle(o['rotation']['axisDir'], o['rotation']['angleRad']) if 'rotation' in o else np.eye(3)
        p, m = np.array(o['positionM'], float), o.get('motion')
        if m and m['kind'] == 'spin':  # 父空物体在枢轴上绕轴转，子物体带静态旋转：世界 = R运动 · R静态
            pv = np.array(m['pivotM'], float); e = bpy.data.objects.new(o['id'] + '-pivot', None); sc.collection.objects.link(e)
            e.location, e.rotation_mode, e.rotation_axis_angle = Vector(C3 @ pv), 'AXIS_ANGLE', (0, *(C3 @ (np.array(m['axisDir']) / np.linalg.norm(m['axisDir']))))
            fcurves(e, 'rotation_axis_angle', {0: (0, m['angularVelocityRadPerFrame'])})
            ob.parent = e; ob.matrix_parent_inverse = Matrix.Identity(4); ob.matrix_basis = mat4(C3 @ rs, C3 @ (p - pv))
        elif m: raise ValueError(f"不认识运动 {m['kind']}")
        else: ob.matrix_basis = mat4(C3 @ rs, C3 @ p)
        entities.append({'name': o['id'], 'class': 'part', 'objects': [ob]})
    return {'entities': entities}
