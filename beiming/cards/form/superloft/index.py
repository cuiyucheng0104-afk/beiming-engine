"""沿米制 Y-up 脊线扫掠超椭圆，局部截面绕切向以度旋转。"""

import math
import re
import sys


class BadArgument(ValueError):
    code = 'usage.bad-argument'


_DEFAULT_SECTIONS = [
    {'rx': 0.5, 'ry': 0.4, 'exponent': 2, 'center': [0, 0.6, -0.6]},
    {'rx': 0.5, 'ry': 0.4, 'exponent': 2, 'center': [0, 0.6, 0.6]},
]


def _number(value, name, low, high):
    if type(value) not in (int, float) or not low <= value <= high:
        raise BadArgument(f'{name} 须在 [{low}, {high}] 内')
    return value


def _section(row):
    if (not isinstance(row, dict) or row.keys() - {'center', 'rx', 'ry', 'exponent', 'twistDeg'}
            or {'center', 'rx', 'ry', 'exponent'} - row.keys()):
        raise BadArgument('截面须给出 center、rx、ry、exponent，可选 twistDeg')
    center = row['center']
    if not isinstance(center, (list, tuple)) or len(center) != 3:
        raise BadArgument('center 须是北冥坐标的三维点')
    return (tuple(_number(x, 'center', -10000, 10000) for x in center),
            _number(row['rx'], 'rx', 0.00001, 1000), _number(row['ry'], 'ry', 0.00001, 1000),
            _number(row['exponent'], 'exponent', 1, sys.float_info.max), _number(row.get('twistDeg', 0), 'twistDeg', -360, 360))


def _sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    x, y, z = a
    u, v, w = b
    return y * w - z * v, z * u - x * w, x * v - y * u


def _unit(vec):
    length = math.hypot(*vec)
    if length < 1e-9:
        raise BadArgument('脊线不能有重合点或原路折返')
    return tuple(x / length for x in vec)


def _transport(u, before, after):
    # 最短旋转的 Rodrigues 公式，轴向量的长度等于两切向夹角的正弦。
    axis = _cross(before, after)
    denom = 1 + _dot(before, after)
    if denom < 1e-9:
        raise BadArgument('相邻脊线切向不能相反')
    first = _cross(axis, u)
    second = _cross(axis, first)
    return _unit(tuple(x + y + z / denom for x, y, z in zip(u, first, second)))


def _sections_between(profiles):
    def lerp(a, b, t):
        return a + (b - a) * t

    # 大幅扭转时补环，避免直接搭桥把截面拉到轴心。
    rows = [profiles[0]]
    for (a, rx, ry, n, twist), end in zip(profiles, profiles[1:]):
        b, dx, dy, dn, angle = end
        steps = max(1, math.ceil(abs(angle - twist) / 45))
        for i in range(1, steps):
            t = i / steps
            rows.append((tuple(lerp(x, y, t) for x, y in zip(a, b)), lerp(rx, dx, t), lerp(ry, dy, t),
                         lerp(n, dn, t), lerp(twist, angle, t)))
        rows.append(end)
    return rows


def _geometry(sections, radial_segments, cap_ends):
    if not isinstance(sections, (list, tuple)) or not 2 <= len(sections) <= 64:
        raise BadArgument('sections 须有 2 至 64 个截面')
    if type(radial_segments) is not int or not 4 <= radial_segments <= 256:
        raise BadArgument('radialSegments 须为 4 至 256 的整数')
    if type(cap_ends) is not bool:
        raise BadArgument('capEnds 须为布尔值')
    profiles = _sections_between([_section(row) for row in sections])
    centers = [row[0] for row in profiles]
    directions = [_unit(_sub(b, a)) for a, b in zip(centers, centers[1:])]
    tangents = [directions[0], *(_unit(tuple(x + y for x, y in zip(a, b))) for a, b in zip(directions, directions[1:])),
                directions[-1]]
    previous = tangents[0]
    ref = (1, 0, 0) if abs(previous[0]) < 0.9 else (0, 1, 0)
    u = _unit(tuple(x - _dot(ref, previous) * y for x, y in zip(ref, previous)))
    count = radial_segments
    directions_2d = [(math.cos(math.tau * j / count), math.sin(math.tau * j / count)) for j in range(count)]
    vertices, faces = [], []
    for (center, rx, ry, exponent, twist), tangent in zip(profiles, tangents):
        u = _transport(u, previous, tangent)
        v = _cross(tangent, u)
        previous = tangent
        angle = math.radians(twist)
        cos, sin = math.cos(angle), math.sin(angle)
        for c, s in directions_2d:
            # 先除最大分量，使很大的指数也有一个恒为 1 的幂项。
            m = max(abs(c), abs(s))
            r = 1 / (m * ((abs(c) / m)**exponent + (abs(s) / m)**exponent)**(1 / exponent))
            x, y = rx * c * r, ry * s * r
            a, b = x * cos - y * sin, x * sin + y * cos
            vertices.append(tuple(o + a * i + b * j for o, i, j in zip(center, u, v)))
    last = len(vertices) - count
    for offset in range(0, last, count):
        for i in range(count):
            j = (i + 1) % count
            faces.append((offset + i, offset + j, offset + count + j, offset + count + i))
    side_faces = len(faces)
    if cap_ends:
        start_cap = len(vertices)
        vertices.extend((centers[0], centers[-1]))
        for i in range(count):
            j = (i + 1) % count
            faces.extend(((start_cap, j, i), (start_cap + 1, last + i, last + j)))
    return vertices, faces, side_faces, centers


def build_superloft_mesh(sections, radialSegments, capEnds):
    """返回世界坐标顶点及朝外面，输入截面保留原顺序。"""
    vertices, faces, _, _ = _geometry(sections, radialSegments, capEnds)
    return {'vertices': vertices, 'faces': faces}


def create(ctx, params):
    if not isinstance(params, dict) or params.keys() - {'sections', 'radialSegments', 'capEnds', 'name'}:
        raise BadArgument('未知的超椭圆放样参数')
    name = params.get('name', 'superloft')
    if not isinstance(name, str) or not re.fullmatch('[A-Za-z0-9_]{1,40}', name):
        raise BadArgument('name 须由 1 到 40 个英数字或下划线组成')
    count = params.get('radialSegments', 48)
    vertices, faces, side_faces, centers = _geometry(params.get('sections', _DEFAULT_SECTIONS), count,
                                                     params.get('capEnds', True))
    bpy = ctx.bpy
    mesh = obj = material = None

    def dispose():
        nonlocal mesh, obj, material
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

    def to_blender(point):
        x, y, z = point
        return x, -z, y

    try:
        origin = centers[0]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([to_blender(_sub(p, origin)) for p in vertices], [], faces)
        if mesh.validate():
            raise BadArgument('放样网格含非法面')
        mesh.update()
        for polygon in mesh.polygons[:side_faces]:
            polygon.use_smooth = True
        obj = bpy.data.objects.new(name, mesh)
        obj.location = to_blender(origin)
        ctx.hostScene.collection.objects.link(obj)
        material = bpy.data.materials.new(f'{obj.name}.surface')
        material.use_nodes = True
        mesh.materials.append(material)
        ring_vertices = len(centers) * count
        local_centers = [to_blender(_sub(center, origin)) for center in centers]
        mean_radius = math.fsum(math.dist(v.co, local_centers[i // count])
                                for i, v in enumerate(mesh.vertices[:ring_vertices])) / ring_vertices
    except Exception:
        dispose()
        raise
    return {'object': obj, 'entities': {'body': {'root': True, 'object': obj}}, 'dispose': dispose,
            'meta': lambda f: {'readings': {'vertexCount': len(vertices), 'faceCount': len(faces),
                                            'meanSectionRadiusM': mean_radius}}}
