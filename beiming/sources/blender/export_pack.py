"""从打开的 Blender 场景写出 scene-pack/0.1。pose(f) 由常驻会话提供。"""
import hashlib
import json
import math
import os
import re
import struct
import tempfile
from decimal import Decimal
from pathlib import Path

import bpy
import numpy as np


EXPORTER = 'sources/blender@0.1'
AXIS = np.array(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)), dtype=np.float64)
FILES = sorted(['pack.json', 'geometry.glb', 'instances.u32', 'frames/instances.f32',
                'frames/camera.f32', 'frames/lights.f32'])


def js_number(value):
    if not math.isfinite(value):
        raise ValueError('JSON 出现非有限数')
    if value == 0:
        return '0'
    # repr 给出能还原 binary64 的最短小数，ECMAScript 的定点/指数切换在 1e-6 和 1e21。
    number = Decimal(repr(value))
    if 1e-6 <= abs(value) < 1e21:
        text = format(number, 'f')
        return text.rstrip('0').rstrip('.') if '.' in text else text
    mantissa, exponent = format(number.normalize(), 'e').split('e')
    return f'{mantissa}e{int(exponent):+d}'


def _json(value, indent, level):
    if isinstance(value, float):
        return js_number(value)
    if not isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    pretty = indent is not None
    if isinstance(value, dict):
        left, right = '{', '}'
        sep = ': ' if pretty else ':'
        # JS 把数组下标形的属性排在其他字符串键之前（材质名也可以是纯数字）。
        indices = sorted((k for k in value if re.fullmatch(r'0|[1-9][0-9]{0,9}', k) and int(k) < 2**32 - 1), key=int)
        keys = [*indices, *(k for k in value if k not in indices)]
        parts = [json.dumps(k, ensure_ascii=False) + sep + _json(value[k], indent, level + 1) for k in keys]
    else:
        left, right = '[', ']'
        parts = [_json(v, indent, level + 1) for v in value]
    if not parts or not pretty:
        return left + ','.join(parts) + right
    pad = '\n' + ' ' * (level + 1)
    return left + pad + (',' + pad).join(parts) + '\n' + ' ' * level + right


def js_dump(value):
    return _json(value, 1, 0)


def js_compact(value):
    return _json(value, None, 0)


def source_node(socket):
    if not socket.is_linked:
        return None
    link, = socket.links
    if link.is_muted or not link.is_valid or link.from_node.mute:
        raise ValueError(f'{socket.name} 有无效或静音连线')
    return link.from_node, link.from_socket.identifier


def constant(socket):
    if socket.is_linked:
        raise ValueError(f'{socket.node.name} 的 {socket.name} 必须是常数')
    v = socket.default_value
    return list(v) if hasattr(v, '__len__') and not isinstance(v, str) else v


def active_output(tree, kind):
    outputs = [n for n in tree.nodes if n.type == kind and n.is_active_output and n.target in ('CYCLES', 'ALL')]
    cycles = [n for n in outputs if n.target == 'CYCLES']
    if cycles:
        outputs = cycles
    if len(outputs) != 1:
        raise ValueError(f'{tree.name} 缺少唯一活动输出 {kind}')
    return outputs[0]


def principled_defaults():
    material = bpy.data.materials.new('scene-pack-defaults')
    try:
        material.use_nodes = True
        shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        return {s.identifier: constant(s) for s in shader.inputs if hasattr(s, 'default_value')}
    finally:
        bpy.data.materials.remove(material)


def material_entry(material, defaults):
    tree = material.node_tree
    if not tree or not material.use_nodes:
        raise ValueError(f'{material.name} 没有 Principled BSDF 节点树')
    output = active_output(tree, 'OUTPUT_MATERIAL')
    surface = source_node(output.inputs['Surface'])
    if not surface or surface[0].type != 'BSDF_PRINCIPLED':
        raise ValueError(f'{material.name} 的 Surface 必须直接连接 Principled BSDF')
    if any(s.is_linked for s in output.inputs if s.name != 'Surface'):
        raise ValueError(f'{material.name} 有表面以外的输出连线')
    shader = surface[0]
    params, pattern, mix, unexported = {}, [], {}, {}
    ramp = None

    def read_ramp(socket):
        nonlocal ramp
        link = source_node(socket)
        if not link:
            raise ValueError(f'{material.name} 的混合因子没有接平滑阶梯')
        node, port = link
        if node.type != 'MAP_RANGE' or node.data_type != 'FLOAT' or node.interpolation_type != 'SMOOTHSTEP' or port != 'Result':
            raise ValueError(f'{material.name} 的混合因子接了不支持的 {node.name}.{port}')
        if ramp is not None:
            if ramp != node:
                raise ValueError(f'{material.name} 有多条不同的勾线链')
            return
        ramp = node
        lo, hi, out_lo, out_hi = (constant(s) for s in node.inputs[1:5])
        if lo >= hi or (out_lo, out_hi) != (0, 1):
            raise ValueError(f'{material.name} 的平滑阶梯区间不受支持')
        occlusion = source_node(node.inputs[0])
        if not occlusion or occlusion[0].type != 'AMBIENT_OCCLUSION' or occlusion[1] != 'AO':
            raise ValueError(f'{material.name} 的平滑阶梯输入必须是 AO')
        ao = occlusion[0]
        if ao.inside or ao.inputs['Normal'].is_linked:
            raise ValueError(f'{material.name} 的 AO 内侧或法线输入不受支持')
        distance = constant(ao.inputs['Distance'])
        if distance <= 0:
            raise ValueError(f'{material.name} 的 AO 距离必须大于 0')
        pattern.extend([dict(node='ao', distance=distance, samples=ao.samples, onlyLocal=ao.only_local, out='ao'),
                        {'node': 'smoothstep', 'in': 'ao', 'edges': [lo, hi], 'out': 'line'}])

    normal = source_node(shader.inputs['Normal'])
    if normal:
        node = normal[0]
        if node.type != 'BEVEL' or node.inputs['Normal'].is_linked:
            raise ValueError(f'{material.name} 的法线输入不支持 {node.name}')
        radius = constant(node.inputs['Radius'])
        if radius <= 0:
            raise ValueError(f'{material.name} 的 bevel 半径必须大于 0')
        pattern.append(dict(node='bevel', radius=radius, samples=node.samples, out='normal'))
    for name, key in [('Base Color', 'baseColor'), ('Metallic', 'metallic'), ('Roughness', 'roughness')]:
        socket = shader.inputs[name]
        link = source_node(socket)
        if link is None:
            value = constant(socket)
            params[key] = value[:3] if key == 'baseColor' else value
        elif key == 'baseColor':
            node = link[0]
            if node.bl_idname != 'ShaderNodeMixRGB' or node.blend_type != 'MIX' or node.use_clamp:
                raise ValueError(f'{material.name} 的 {name} 不支持 {node.name}')
            read_ramp(node.inputs[0])
            params[key], mix[key] = constant(node.inputs[1])[:3], constant(node.inputs[2])[:3]
        else:
            node = link[0]
            if node.type != 'MAP_RANGE' or node.data_type != 'FLOAT' or node.interpolation_type != 'LINEAR' or link[1] != 'Result':
                raise ValueError(f'{material.name} 的 {name} 不支持 {node.name}')
            if (constant(node.inputs[1]), constant(node.inputs[2])) != (0, 1):
                raise ValueError(f'{material.name} 的 {name} 映射输入区间必须是 [0, 1]')
            read_ramp(node.inputs[0])
            params[key], mix[key] = constant(node.inputs[3]), constant(node.inputs[4])
    if mix:
        pattern.append(dict(node='mix', by='line', set=mix))
    for socket in shader.inputs:
        if socket.identifier in ('Base Color', 'Metallic', 'Roughness', 'Normal') or not socket.enabled:
            continue
        if socket.is_linked:
            raise ValueError(f'{material.name} 的 Principled {socket.identifier} 不支持连线')
        if hasattr(socket, 'default_value'):
            value = constant(socket)
            if defaults.get(socket.identifier) != value:
                unexported[socket.identifier] = value
    for values in (params, mix):
        for value in values.values():
            if any(not 0 <= x <= 1 for x in (value if isinstance(value, list) else [value])):
                raise ValueError(f'{material.name} 的材质参数超出 [0, 1]')
    entry = dict(name=material.name, closure='surface', params=params)
    if pattern:
        entry['pattern'] = pattern
    return entry, unexported


def mesh_field(collection, key, components, dtype):
    values = np.empty(len(collection) * components, dtype=dtype)
    collection.foreach_get(key, values)
    return values if components == 1 else values.reshape(-1, components)


def mesh_parts(mesh, scale, repaired):
    mesh.calc_loop_triangles()
    pos = mesh_field(mesh.vertices, 'co', 3, np.float32).astype(np.float64)
    normals = mesh_field(mesh.corner_normals, 'vector', 3, np.float32).astype(np.float64)
    vertex = mesh_field(mesh.loops, 'vertex_index', 1, np.int32)
    triangles = mesh_field(mesh.loop_triangles, 'loops', 3, np.int32)
    slots = mesh_field(mesh.loop_triangles, 'material_index', 1, np.int32)
    zero = np.flatnonzero(np.linalg.norm(normals, axis=1) == 0)
    if zero.size:
        # 同一多边形的环只对应一张面。面也退化时填 +Z，并分别记账。
        polygon = mesh_field(mesh.loop_triangles, 'polygon_index', 1, np.int32)
        faces = mesh_field(mesh.polygons, 'normal', 3, np.float32)
        loop_face = np.zeros(len(normals), dtype=np.int32)
        loop_face[triangles.ravel()] = np.repeat(polygon, 3)
        fallback = faces[loop_face[zero]]
        flat = np.linalg.norm(fallback, axis=1) == 0
        fallback[flat] = (0, 0, 1)
        normals[zero] = fallback
        repaired['face'] += int((~flat).sum())
        repaired['fallbackZ'] += int(flat.sum())
    positions = ((pos @ AXIS[:3, :3].T) * scale).astype('<f4')
    normals = ((normals / np.linalg.norm(normals, axis=1, keepdims=True)) @ AXIS[:3, :3].T).astype('<f4')
    if not np.isfinite(positions).all() or not np.isfinite(normals).all():
        raise ValueError(f'{mesh.name} 的顶点或法线非有限')
    for slot in np.unique(slots):
        loops = triangles[slots == slot].ravel()
        keys = np.column_stack((vertex[loops], normals[loops].view('<i4')))
        unique, indices = np.unique(keys, axis=0, return_inverse=True)
        yield int(slot), (positions[unique[:, 0]], unique[:, 1:].copy().view('<f4'), indices.astype('<u4').ravel())


def write_glb(path, meshes):
    """网格数据按 accessor 顺序连续放置，三种元素都是 4 字节对齐。"""
    buffers, views, accessors, definitions = [], [], [], []
    offset = 0
    for name, (pos, normals, indices) in meshes:
        first = len(accessors)
        for array, kind, dtype, target in ((pos, 'VEC3', 5126, 34962), (normals, 'VEC3', 5126, 34962),
                                           (indices, 'SCALAR', 5125, 34963)):
            accessor = dict(bufferView=len(views), componentType=dtype, count=len(array), type=kind)
            if array is pos:
                accessor.update(min=pos.min(axis=0).tolist(), max=pos.max(axis=0).tolist())
            views.append(dict(buffer=0, byteOffset=offset, byteLength=array.nbytes, target=target))
            accessors.append(accessor)
            buffers.append(array)
            offset += array.nbytes
        primitive = dict(attributes=dict(POSITION=first, NORMAL=first + 1), indices=first + 2, mode=4)
        definitions.append(dict(name=name, primitives=[primitive]))
    doc = dict(asset=dict(version='2.0', generator=EXPORTER), buffers=[dict(byteLength=offset)],
               bufferViews=views, accessors=accessors, meshes=definitions)
    text = js_compact(doc).encode('utf-8')
    text += b' ' * (-len(text) % 4)
    with path.open('wb') as stream:
        stream.write(struct.pack('<4sIII4s', b'glTF', 2, 28 + len(text) + offset, len(text), b'JSON'))
        stream.write(text)
        stream.write(struct.pack('<I4s', offset, b'BIN\0'))
        for array in buffers:
            stream.write(np.ascontiguousarray(array))


def world_entry(scene):
    world = scene.world
    if world is None:
        return dict(color=[0, 0, 0], visibleToCamera=False)
    if world.use_nodes and world.node_tree:
        output = active_output(world.node_tree, 'OUTPUT_WORLD')
        source = source_node(output.inputs['Surface'])
        if not source or source[0].type != 'BACKGROUND' or output.inputs['Volume'].is_linked:
            raise ValueError('世界光必须是常数 Background')
        power = constant(source[0].inputs['Strength'])
        color = [power * c for c in constant(source[0].inputs['Color'])[:3]]
    else:
        color = list(world.color)
    return dict(color=color, visibleToCamera=bool(world.cycles_visibility.camera))


def light_entry(obj, evaluated, owners):
    data = evaluated.data
    if data.type == 'POINT':
        light = dict(name=obj.name, type='point')
    elif data.type == 'AREA' and data.shape in ('SQUARE', 'RECTANGLE'):
        light = dict(name=obj.name, type='area-rect', size=[data.size, data.size if data.shape == 'SQUARE' else data.size_y])
    else:
        raise ValueError(f'灯 {obj.name} 的类型 {data.type}/{getattr(data, "shape", "")} 不受支持')
    light.update(watts=data.energy, color=list(data.color), visibleToCamera=bool(evaluated.visible_camera))
    if light['watts'] < 0:
        raise ValueError(f'灯 {obj.name} 的瓦数小于 0')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', obj.name):
        light['group'] = re.sub('[^a-z0-9-]+', '-', obj.name.lower()).strip('-') or 'light'
    linking = obj.light_linking
    if linking.blocker_collection is not None:
        raise ValueError(f'灯 {obj.name} 使用了不受支持的阴影链接')
    receivers = linking.receiver_collection
    if receivers is not None:
        if receivers.children or any(o.light_linking.link_state != 'INCLUDE' for o in receivers.collection_objects):
            raise ValueError(f'灯 {obj.name} 的接收集合只支持直接包含物体')
        selected = {o.name for o in receivers.objects if o.name in owners}
        names = {owners[n]['name'] for n in selected}
        if not names or any(n not in selected and e['name'] in names for n, e in owners.items()):
            raise ValueError(f'灯 {obj.name} 的接收集合无法用叶子实体名表示')
        light['link'] = sorted(names)
    return light


def camera_sample(scene, dg):
    camera = scene.camera.evaluated_get(dg)
    data = camera.data
    if data.type != 'PERSP' or data.shift_x or data.shift_y:
        raise ValueError('导出要求不偏轴的透视相机')
    view = np.array(data.view_frame(scene=scene))
    half_height = (view[:, 1].max() - view[:, 1].min()) / (-2 * view[0, 2])
    matrix = AXIS @ np.array(camera.matrix_world)
    if not np.allclose(matrix[:3, :3].T @ matrix[:3, :3], np.eye(3), atol=1e-5) or np.linalg.det(matrix[:3, :3]) < 0:
        raise ValueError('相机矩阵含缩放或镜像')
    row = [*matrix.T.ravel(), 2 * math.atan(half_height)]
    static = dict(type='persp', near=data.clip_start, far=data.clip_end)
    dof = data.dof
    if dof.use_dof:
        distance = dof.focus_distance
        if dof.focus_object is not None:
            point = dof.focus_object.evaluated_get(dg).matrix_world.translation
            distance = -(camera.matrix_world.inverted() @ point).z
        if distance <= 0 or dof.aperture_fstop <= 0:
            raise ValueError('景深要求正对焦距离和光圈值')
        static['sensorHeight'] = float(2 * data.lens * half_height / 1000)
        row.extend([distance, dof.aperture_fstop])
    return static, row


def determinant(matrix):
    # 按 5.4 对已经舍入到 float32 的矩阵按双精度求值，避免 LU 的近零舍入。
    a, b, c = matrix[:3, :3].astype(np.float64)
    return a[0] * (b[1]*c[2] - b[2]*c[1]) - a[1] * (b[0]*c[2] - b[2]*c[0]) + a[2] * (b[0]*c[1] - b[1]*c[0])


def geometry_signature(mesh):
    """静态 GLB 不能表示随帧形变：只给有求值器的网格采样，不重复打包或排序顶点。"""
    mesh.calc_loop_triangles()
    digest = hashlib.sha256()
    for collection, key, width, dtype in (
            (mesh.vertices, 'co', 3, np.float32), (mesh.corner_normals, 'vector', 3, np.float32),
            (mesh.loops, 'vertex_index', 1, np.int32), (mesh.loop_triangles, 'loops', 3, np.int32),
            (mesh.loop_triangles, 'material_index', 1, np.int32)):
        digest.update(struct.pack('<Q', len(collection)))
        digest.update(mesh_field(collection, key, width, dtype))
    return digest.digest()


def static_geometry(scene, dg, entities, repaired):
    owners = {obj: entity for entity in entities for obj in entity['_roots']}
    for obj in scene.objects:
        if not obj.hide_render and (obj.is_instancer or obj.type in ('CURVE', 'SURFACE', 'META', 'FONT', 'CURVES', 'POINTCLOUD', 'VOLUME')):
            raise ValueError(f'{obj.name} 不是可直接导出的网格对象，不能省略其几何')
    objects = [o for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    for obj in objects:
        if obj.name not in owners:
            raise ValueError(f'可渲染网格 {obj.name} 缺少实体声明')
    objects.sort(key=lambda o: (owners[o.name]['name'], o.name))
    owners = {o.name: owners[o.name] for o in objects}
    names = {e['name'] for e in owners.values()}
    if any(not re.fullmatch(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*', n) or
           any('.'.join(n.split('.')[:i]) in names for i in range(1, len(n.split('.')))) for n in names):
        raise ValueError('实例行必须属于合法的叶子实体名')
    meshes, rows, cache, materials = [], [], {}, {}
    stats = dict(meshes=0, meshTris=[], instances=0, instanceTris=0)
    # 未分配材质的面用默认漫反射表面。名字单独分配，避免和用户材质相撞。
    default_name = 'default'
    while default_name in bpy.data.materials:
        default_name += '_'
    for obj in objects:
        entity = owners[obj.name]
        evaluated = obj.evaluated_get(dg)
        key = ('object', obj) if obj.modifiers or obj.data.shape_keys else ('data', obj.data)
        # 独立用 Blender 自己的三角形材质槽计数，不从 GLB、实例行或索引数组倒算。
        measured = evaluated.data
        measured.calc_loop_triangles()
        slots = mesh_field(measured.loop_triangles, 'material_index', 1, np.int32)
        used, counts = np.unique(slots, return_counts=True)
        stats['instances'] += len(used)
        stats['instanceTris'] += len(slots)
        if key not in cache:
            scale = abs(np.linalg.det(np.array(evaluated.matrix_world)[:3, :3])) ** (1 / 3)
            if not (scale > 0 and math.isfinite(scale)):
                raise ValueError(f'{entity["name"]} 的实例矩阵行列式为零或非有限')
            part_indices = {}
            mesh = evaluated.to_mesh()
            try:
                for slot, arrays in mesh_parts(mesh, scale, repaired):
                    index = len(meshes)
                    part_indices[slot] = index
                    meshes.append((f'{index}-{obj.data.name}-{slot}', arrays))
            finally:
                evaluated.to_mesh_clear()
            cache[key] = float(scale), part_indices
            stats['meshes'] += len(used)
            stats['meshTris'].extend(counts.tolist())
        scale, part_indices = cache[key]
        for slot, index in part_indices.items():
            material = evaluated.material_slots[slot].material if slot < len(evaluated.material_slots) else None
            material = material.original if material else None
            name = material.name if material else default_name
            materials[name] = material
            rows.append((obj, scale, index, name, entity))
    if not rows:
        raise ValueError('场景没有可导出的三角形')
    return meshes, rows, owners, materials, stats


def collect(scene, entities, job, pose):
    frames = job['frames']
    repaired = dict(face=0, fallbackZ=0)
    with pose(frames[0]):
        dg = bpy.context.evaluated_depsgraph_get()
        meshes, rows, owners, materials, stats = static_geometry(scene, dg, entities, repaired)
        defaults = principled_defaults()
        entries, unexported = [], {}
        for name, material in sorted(materials.items()):
            if material is None:
                entries.append(dict(name=name, closure='surface', params=dict(baseColor=[0.8]*3, metallic=0, roughness=0.5)))
                continue
            entry, extra = material_entry(material.evaluated_get(dg), defaults)
            entries.append(entry)
            if extra:
                unexported[name] = extra
        lights = sorted((o for o in scene.objects if o.type == 'LIGHT' and not o.hide_render), key=lambda o: o.name)
        light_defs = [light_entry(o, o.evaluated_get(dg), owners) for o in lights]
        stats.update(lights=len(lights), lightWatts={o.name: o.evaluated_get(dg).data.energy for o in lights}, frames=frames)
        world = world_entry(scene)
        guarded = {obj: geometry_signature(obj.evaluated_get(dg).data) for obj in (scene.objects[n] for n in owners)
                   if len(frames) > 1 and (obj.modifiers or obj.data.shape_keys or obj.data.animation_data)}
        material_state = {m: (e, unexported.get(e['name'], {})) for e in entries if (m := materials[e['name']]) is not None}

    signs = {}
    instance_table = np.empty((len(frames), len(rows), 16), dtype='<f4')
    light_table = np.empty((len(frames), len(lights), 17), dtype='<f4')
    camera_rows, source_watts = [], []
    for k, frame in enumerate(frames):
        with pose(frame):
            dg = bpy.context.evaluated_depsgraph_get()
            if k:
                if {o.name for o in scene.objects if o.type == 'MESH' and not o.hide_render} != owners.keys():
                    raise ValueError(f'第 {frame} 帧可见网格集合变化，静态实例表无法表示')
                if any(geometry_signature(o.evaluated_get(dg).data) != signature for o, signature in guarded.items()):
                    raise ValueError(f'第 {frame} 帧出现动态网格，静态 GLB 无法表示')
                if any(material_entry(m.evaluated_get(dg), defaults) != value for m, value in material_state.items()):
                    raise ValueError(f'第 {frame} 帧材质变化，静态材质表无法表示')
                if world_entry(scene) != world or {o for o in scene.objects if o.type == 'LIGHT' and not o.hide_render} != set(lights):
                    raise ValueError(f'第 {frame} 帧世界或可见灯集合变化')
            for i, (obj, scale, _mesh, _material, entity) in enumerate(rows):
                matrix = AXIS @ np.array(obj.evaluated_get(dg).matrix_world) @ AXIS.T
                matrix[:3, :3] /= scale
                matrix = matrix.astype('<f4')
                det = determinant(matrix)
                if not math.isfinite(det) or det == 0 or signs.setdefault(i, det < 0) != (det < 0):
                    raise ValueError(f'{entity["name"]} 第 {frame} 帧行列式为零、非有限或变号')
                instance_table[k, i] = matrix.T.ravel()
            current, cam_row = camera_sample(scene, dg)
            if k == 0:
                camera = current
            elif (camera.keys() != current.keys() or any(camera[p] != current[p] for p in ('near', 'far')) or
                  not math.isclose(camera.get('sensorHeight', 0), current.get('sensorHeight', 0), rel_tol=1e-5)):
                raise ValueError('相机静态参数在帧间变化')
            camera_rows.append(cam_row)
            source_watts.append([o.evaluated_get(dg).data.energy for o in lights])
            for i, obj in enumerate(lights):
                evaluated = obj.evaluated_get(dg)
                matrix = AXIS @ np.array(evaluated.matrix_world)
                if not np.allclose(matrix[:3, :3].T @ matrix[:3, :3], np.eye(3), atol=1e-5):
                    raise ValueError(f'灯 {obj.name} 带缩放')
                if k and light_entry(obj, evaluated, owners) != {**light_defs[i], 'watts': evaluated.data.energy}:
                    raise ValueError(f'灯 {obj.name} 第 {frame} 帧改变了不可逐帧表示的属性')
                if evaluated.data.energy < 0:
                    raise ValueError(f'灯 {obj.name} 第 {frame} 帧瓦数为负')
                light_table[k, i] = [*matrix.T.ravel(), evaluated.data.energy]
    camera_table = np.asarray(camera_rows, dtype='<f4')
    if not all(np.isfinite(table).all() for table in (instance_table, camera_table, light_table)):
        raise ValueError('状态表出现非有限数')
    light_fields = ['mat16']
    if np.any(light_table[:, :, 16] != light_table[0, :, 16]):
        light_fields.append('watts')
        stats['frameLightWatts'] = source_watts
    else:
        light_table = light_table[:, :, :16]
    camera_fields = ['mat16', 'fovY'] + (['focusDist', 'fstop'] if 'sensorHeight' in camera else [])
    tables = {'instances': instance_table, 'camera': camera_table, 'lights': light_table}
    fields = {'instances': ['mat16'], 'camera': camera_fields, 'lights': light_fields}
    mat_index = {entry['name']: i for i, entry in enumerate(entries)}
    instances = np.array([[mesh, mat_index[mat], e['id'], int(signs[i])] for i, (_, _, mesh, mat, e) in enumerate(rows)], dtype='<u4')
    pack = dict(format='scene-pack/0.1', id=job['packId'], units=dict(meter=1, up='Y', hand='right'),
                geometry=dict(file='geometry.glb', meshes=[dict(name=name, tris=len(arrays[2]) // 3, attrs=['position', 'cornerNormal'])
                                                          for name, arrays in meshes]),
                instances={'file': 'instances.u32', 'shape': list(instances.shape), 'names': [r[4]['name'] for r in rows],
                           'class': [r[4]['class'] for r in rows]},
                materials=entries, lights=light_defs, world=world, camera=camera,
                frames={'count': len(frames), **{name: dict(file=f'frames/{name}.f32', shape=list(t.shape), fields=fields[name])
                                                 for name, t in tables.items()}},
                source=dict(exporter=EXPORTER, blender=bpy.app.version_string.split()[0], sha256=job['sourceSha256']),
                ext={'blender.sourceFrames': frames, 'blender.label': job['label'], 'blender.zeroCornerNormals': repaired,
                     'blender.unexported': unexported})
    return pack, meshes, instances, tables, stats


def pack_digest(path):
    lines = hashlib.sha256()
    for name in FILES:
        file_hash = hashlib.sha256()
        with (path / name).open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                file_hash.update(block)
        lines.update(f'{file_hash.hexdigest()}  {name}\n'.encode('utf-8'))
    return 'sha256:' + lines.hexdigest()


def export_scene_pack(scene, entities, job, pose):
    destination = Path(job['outDir'])
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('导出目录必须为空，或尚未创建')
    pack, meshes, instances, tables, stats = collect(scene, entities, job, pose)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # 先完整写到同一文件系统，再用单次 rename 发布，失败时临时文件随上下文回收。
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix='.scene-pack-') as temporary:
        staging = Path(temporary) / 'pack'
        (staging / 'frames').mkdir(parents=True)
        write_glb(staging / 'geometry.glb', meshes)
        (staging / 'pack.json').write_bytes((js_dump(pack) + '\n').encode('utf-8'))
        instances.tofile(staging / 'instances.u32')
        for name, table in tables.items():
            table.tofile(staging / pack['frames'][name]['file'])
        digest = pack_digest(staging)
        os.replace(staging, destination)
    return dict(outDir=str(destination), packPath=str(destination / 'pack.json'), files=FILES, stats=stats, digest=digest)
