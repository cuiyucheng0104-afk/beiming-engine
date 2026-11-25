"""米制 Y-up 硬表面网格。圆柱沿 +Y，板槽从 +Y 面向下切。"""

import math
import re


class BadArgument(ValueError):
    code = 'usage.bad-argument'


def _number(value, name, lo, hi):
    if type(value) not in (int, float) or not lo <= value <= hi:
        raise BadArgument(f'{name} 须在 [{lo}, {hi}] 内')
    return value


def _vector(value, name, n, lo, hi):
    if not isinstance(value, (list, tuple)) or len(value) != n:
        raise BadArgument(f'{name} 须有 {n} 个分量')
    return tuple(_number(part, name, lo, hi) for part in value)


def _integer(value, name, lo, hi):
    if type(value) is not int or not lo <= value <= hi:
        raise BadArgument(f'{name} 须为 {lo} 至 {hi} 的整数')
    return value


def _validate(spec):
    if not isinstance(spec, dict):
        raise BadArgument('spec 须为对象')
    kind = spec.get('kind')
    common = {'kind', 'name', 'center'}
    if kind == 'box':
        allowed, required = {'sizeM', 'bevelM', 'bevelSegments'}, {'sizeM'}
    elif kind == 'cylinder':
        allowed, required = {'radiusM', 'heightM', 'segments', 'bevelM', 'bevelSegments'}, {'radiusM', 'heightM'}
    elif kind == 'slotted_plate':
        allowed = required = {'sizeM', 'slotSizeM', 'slotDepthM'}
    else:
        raise BadArgument('kind 须为 box、cylinder 或 slotted_plate')
    if spec.keys() - (common | allowed) or required - spec.keys():
        raise BadArgument(f'{kind} 的 spec 含未知或缺少必填字段')
    name = spec.get('name', 'body')
    if not isinstance(name, str) or not re.fullmatch('[A-Za-z0-9_]{1,40}', name):
        raise BadArgument('name 须由 1 到 40 个英数字或下划线组成')
    center = _vector(spec.get('center', (0, 0, 0)), 'center', 3, -10000, 10000)
    p = {**spec, 'name': name, 'center': center}
    if kind == 'cylinder':
        radius = _number(p['radiusM'], 'radiusM', 0.00001, 1000)
        height = _number(p['heightM'], 'heightM', 0.00001, 1000)
        p['segments'] = _integer(p.get('segments', 32), 'segments', 4, 256)
        limit = min(radius, height / 2)
    else:
        width, height, depth = _vector(p['sizeM'], 'sizeM', 3, 0.00001, 1000)
        limit = min(width, height, depth) / 2
    if kind == 'slotted_plate':
        sx, sz = _vector(p['slotSizeM'], 'slotSizeM', 2, 0.00001, 1000)
        _number(p['slotDepthM'], 'slotDepthM', 0.00001, height)
        if sx >= width or sz >= depth:
            raise BadArgument('slotSizeM 必须小于板件的 X、Z 尺寸')
    else:
        bevel = _number(p.get('bevelM', 0), 'bevelM', 0, 500)
        if bevel >= limit:
            raise BadArgument('bevelM 必须小于最短半尺寸')
        p['bevelM'] = bevel
        p['bevelSegments'] = _integer(p.get('bevelSegments', 2), 'bevelSegments', 1, 16)
    return p


def _box(size, bevel, subdivisions):
    half = tuple(length / 2 for length in size)
    core = tuple(h - bevel for h in half)
    # 在六个盒面上共用边界采样，沿内盒的最近点向外投影到圆角表面。
    axes = [tuple(-x for x in reversed(band)) + band for band in (
        tuple(h if i == subdivisions else c + bevel * i / subdivisions for i in range(subdivisions + 1))
        if bevel else (h,) for h, c in zip(half, core)
    )]
    if any(a >= b for samples in axes for a, b in zip(samples, samples[1:])):
        raise BadArgument('倒角细分小于尺寸可表示的间距')
    vertices, faces, indices = [], [], {}

    def vertex(raw):
        if raw not in indices:
            surface = raw
            if bevel:
                nearest = tuple(max(-c, min(c, v)) for c, v in zip(core, raw))
                delta = tuple(v - c for v, c in zip(raw, nearest))
                if sum(d != 0 for d in delta) > 1:
                    distance = math.hypot(*delta)
                    surface = tuple(c + d / distance * bevel for c, d in zip(nearest, delta))
            indices[raw] = len(vertices)
            vertices.append(surface)
        return indices[raw]

    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        for sign in (-1, 1):
            grid = []
            for row in axes[v]:
                line = []
                for col in axes[u]:
                    point = [0, 0, 0]
                    point[axis], point[u], point[v] = sign * half[axis], col, row
                    line.append(vertex(tuple(point)))
                grid.append(line)
            for low, high in zip(grid, grid[1:]):
                for i in range(len(low) - 1):
                    face = (low[i], low[i + 1], high[i + 1], high[i])
                    faces.append(face if sign > 0 else face[::-1])
    return vertices, faces, 0


def _cylinder(radius, height, count, bevel, subdivisions):
    half = height / 2
    profile = [(radius, -half), (radius, half)]
    if bevel:
        upper = [(radius, half - bevel)]
        for i in range(1, subdivisions):
            angle = math.pi * i / (2 * subdivisions)
            upper.append((radius - bevel * (1 - math.cos(angle)), half - bevel * (1 - math.sin(angle))))
        upper.append((radius - bevel, half))
        profile = [(r, -y) for r, y in reversed(upper)] + upper
    # 四个轴向极值都保留。任意总段数分配到四个象限，不改变外包尺寸。
    directions = []
    quadrants = ((1, 0), (0, -1), (-1, 0), (0, 1))
    for q, (x, z) in enumerate(quadrants):
        segments = count // 4 + int(q < count % 4)
        directions.append((x, z))
        for j in range(1, segments):
            a = (q + j / segments) * math.pi / 2
            directions.append((math.cos(a), -math.sin(a)))
    vertices = [(r * x, y, r * z) for r, y in profile for x, z in directions]
    faces = []
    for offset in range(0, len(vertices) - count, count):
        for i in range(count):
            nxt = (i + 1) % count
            faces.append((offset + i, offset + nxt, offset + count + nxt, offset + count + i))
    smooth = len(faces)
    top = len(vertices) - count
    vertices.extend([(0, -half, 0), (0, half, 0)])
    for i in range(count):
        nxt = (i + 1) % count
        faces.extend([(len(vertices) - 2, nxt, i), (len(vertices) - 1, top + i, top + nxt)])
    return vertices, faces, smooth


def _plate(size, slot, cut):
    x, y, z = (length / 2 for length in size)
    sx, sz = (length / 2 for length in slot)

    def ring(a, b, h):
        return [(-a, h, -b), (-a, h, b), (a, h, b), (a, h, -b)]

    through = cut == size[1]
    vertices = ring(x, z, -y) + ring(x, z, y) + ring(sx, sz, y) + ring(sx, sz, y - cut)
    faces = []
    for i in range(4):
        j = (i + 1) % 4
        faces.extend([(i, j, j + 4, i + 4), (i + 4, j + 4, j + 8, i + 8), (i + 8, j + 8, j + 12, i + 12)])
        if through:
            faces.append((j, i, i + 12, j + 12))
    if not through:
        faces.extend([(3, 2, 1, 0), (12, 13, 14, 15)])
    return vertices, faces, 0


def _geometry(p):
    if p['kind'] == 'box':
        return _box(p['sizeM'], p['bevelM'], p['bevelSegments'])
    if p['kind'] == 'cylinder':
        return _cylinder(p['radiusM'], p['heightM'], p['segments'], p['bevelM'], p['bevelSegments'])
    return _plate(p['sizeM'], p['slotSizeM'], p['slotDepthM'])


def build_primitive_mesh(spec):
    """返回按 center 平移后的 Y-up 顶点和朝外三角/四边面。"""
    p = _validate(spec)
    vertices, faces, _ = _geometry(p)
    points = [tuple(a + b for a, b in zip(point, p['center'])) for point in vertices]
    if len(set(points)) != len(points):
        raise BadArgument('原语含重合顶点，检查倒角与槽壁间距')
    return {'vertices': points, 'faces': faces}


def create(ctx, params):
    if not isinstance(params, dict) or params.keys() - {'spec'}:
        raise BadArgument('原语只接受 spec 参数')
    p = _validate(params.get('spec', {'kind': 'box', 'sizeM': [1, 1, 1]}))
    vertices, faces, smooth = _geometry(p)
    bpy = ctx.bpy
    mesh = obj = material = None

    def dispose():
        nonlocal obj, mesh, material
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)
            obj = None
        if mesh is not None:
            bpy.data.meshes.remove(mesh)
            mesh = None
        if material is not None:
            if material.users == 0:
                bpy.data.materials.remove(material)
            material = None

    try:
        name = p['name']
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([(x, -z, y) for x, y, z in vertices], [], faces)
        if mesh.validate() or len({tuple(v.co) for v in mesh.vertices}) != len(vertices):
            raise BadArgument('原语网格含非法面或在 Blender 精度下重合的顶点')
        mesh.update()
        for polygon in mesh.polygons[:smooth]:
            polygon.use_smooth = True
        obj = bpy.data.objects.new(name, mesh)
        x, y, z = p['center']
        obj.location = (x, -z, y)
        ctx.hostScene.collection.objects.link(obj)
        material = bpy.data.materials.new(f'{obj.name}.surface')
        material.use_nodes = True
        mesh.materials.append(material)
    except Exception:
        dispose()
        raise
    return {'object': obj, 'entities': {'body': {'root': True, 'object': obj}}, 'dispose': dispose,
            'meta': lambda f: {'readings': {'vertexCount': len(vertices), 'faceCount': len(faces)}}}
