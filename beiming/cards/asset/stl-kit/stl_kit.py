"""STL 读入、缺件代理与盘点机位。几何输出统一为北冥右手 +Y 向上米制。"""

import base64
import binascii
import hashlib
import itertools
import math
import re
import struct
from pathlib import Path


_NAME = re.compile(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*')
_DECIMAL = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?')
_STL_FACET = struct.Struct('<12fH')
_GEOMETRY_FACET = struct.Struct('<9d')
_DEFAULT_KIT = {'parts': [{'name': 'body', 'size': [0.5, 0.5, 0.5]}]}


class BadArgument(ValueError):
    code = 'usage.bad-argument'


def _fields(value, allowed, label):
    if not isinstance(value, dict) or value.keys() - allowed:
        raise BadArgument(f'{label} 必须是只含已声明字段的对象')


def _number(value, label, low=-math.inf, high=math.inf):
    try:
        out = float(value) if type(value) in (int, float) else math.nan
    except OverflowError:
        out = math.inf
    if not math.isfinite(out) or not low <= out <= high:
        raise BadArgument(f'{label} 必须是范围内的有限数')
    return out


def _vector(value, length, label):
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise BadArgument(f'{label} 必须含 {length} 个数')
    return tuple(_number(x, label) for x in value)


def _bbox(value, label, *, flat=False):
    box = _vector(value, 6, label)
    if any(hi < lo or (hi == lo and not flat) or not math.isfinite(hi - lo)
           for lo, hi in zip(box[:3], box[3:])):
        raise BadArgument(f'{label} 的上下界须有序且跨度有限，代理盒各轴需有正跨度')
    return box


def _axes(unit_scale, up_axis):
    scale = _number(unit_scale, 'unitScale', 0.0001, 1000)
    if up_axis not in ('Y', 'Z'):
        raise BadArgument('upAxis 只接受 Y 或 Z')
    return scale, up_axis


def _ascii_facets(data):
    try:
        text = data.decode('ascii')
    except UnicodeDecodeError:
        raise BadArgument('STL 不是完整的二进制或 ASCII 文件') from None
    if re.search(r'[^\x09\x0a\x0d\x20-\x7e]', text):
        raise BadArgument('ASCII STL 含非法字符')
    lines = text.strip().splitlines()
    if len(lines) < 3:
        raise BadArgument('ASCII STL 缺少 solid、facet 或 endsolid')
    start, end = lines[0].split(maxsplit=1), lines[-1].split(maxsplit=1)
    if start[0] != 'solid' or end[0] != 'endsolid' or (len(end) == 2 and start[1:] != end[1:]):
        raise BadArgument('ASCII STL 的 solid 与 endsolid 不匹配')
    tokens = itertools.chain.from_iterable(line.split() for line in lines[1:-1])

    def expect(*words):
        for word in words:
            if next(tokens, None) != word:
                raise BadArgument(f'ASCII STL 期望 {word}')

    def vector():
        values = [next(tokens, '') for _ in range(3)]
        if not all(_DECIMAL.fullmatch(v) for v in values):
            raise BadArgument('ASCII STL 的法线与顶点必须是十进制数')
        return tuple(map(float, values))

    while (word := next(tokens, None)) is not None:
        if word != 'facet':
            raise BadArgument('ASCII STL 期望 facet')
        expect('normal')
        normal = vector()
        expect('outer', 'loop')
        points = []
        for _ in range(3):
            expect('vertex')
            points.extend(vector())
        expect('endloop', 'endfacet')
        yield normal + tuple(points)


def _bounds(vertices):
    low = tuple(min(v[i] for v in vertices) for i in range(3))
    high = tuple(max(v[i] for v in vertices) for i in range(3))
    return _bbox(low + high, '几何包围盒', flat=True)


def _geometry(vertices, triangles):
    digest = hashlib.sha256()
    for a, b, c in triangles:
        digest.update(_GEOMETRY_FACET.pack(*vertices[a], *vertices[b], *vertices[c]))
    return {'vertices': vertices, 'triangles': triangles, 'triangleCount': len(triangles),
            'bbox': _bounds(vertices), 'sha256': digest.hexdigest()}


def parse_stl_bytes(data, unit_scale=0.001, up_axis='Z'):
    """按精确字节长识别二进制 STL，否则按 ASCII 文法读入。摘要按面序散列归一化顶点。"""
    scale, axis = _axes(unit_scale, up_axis)
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise BadArgument('STL 数据必须是字节')
    data = bytes(data)
    if len(data) >= 84 and len(data) == 84 + _STL_FACET.size * struct.unpack_from('<I', data, 80)[0]:
        kind = 'binary'
        facets = (row[:12] for row in _STL_FACET.iter_unpack(memoryview(data)[84:]))
    else:
        kind = 'ascii'
        facets = _ascii_facets(data)

    vertices, triangles, indices = [], [], {}
    for row in facets:
        if not all(map(math.isfinite, row)):
            raise BadArgument('STL 的法线与顶点必须是有限数')
        face = []
        for i in range(3, 12, 3):
            x, y, z = row[i:i + 3]
            xyz = (x, z, -y) if axis == 'Z' else (x, y, z)
            point = tuple(_number(v * scale, '缩放后的顶点') or 0.0 for v in xyz)
            index = indices.setdefault(point, len(vertices))
            if index == len(vertices):
                vertices.append(point)
            face.append(index)
        triangles.append(tuple(face))
    if not triangles:
        raise BadArgument('STL 至少需要一个三角面')
    return {'format': kind, **_geometry(vertices, triangles)}


def _proxy_bbox(part):
    has_box, has_size = 'fallbackBbox' in part, 'size' in part
    if has_box and has_size or ('center' in part and not has_size):
        raise BadArgument('fallbackBbox 与 size 二选一，center 只和 size 一起使用')
    if has_box:
        return _bbox(part['fallbackBbox'], 'fallbackBbox')
    if not has_size:
        return None
    size = _vector(part['size'], 3, 'size')
    center = _vector(part.get('center', (0, 0, 0)), 3, 'center')
    if min(size) <= 0:
        raise BadArgument('size 各轴须大于零')
    return _bbox(tuple(c - s / 2 for c, s in zip(center, size))
                 + tuple(c + s / 2 for c, s in zip(center, size)), 'size/center')


def _proxy(box):
    x0, y0, z0, x1, y1, z1 = box
    vertices = ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
    triangles = ((0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
                 (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2),
                 (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5))
    return _geometry(vertices, triangles)


def _read_part(part):
    if 'bytes' in part:
        data = part['bytes']
        if isinstance(data, (bytes, bytearray, memoryview)):
            return data
        if isinstance(data, list) and all(type(v) is int and 0 <= v <= 255 for v in data):
            return bytes(data)
        if isinstance(data, str):
            try:
                decoded = base64.b64decode(data, validate=True)
                if base64.b64encode(decoded).decode('ascii') == data:
                    return decoded
            except (ValueError, binascii.Error):
                pass
        raise BadArgument('bytes 必须是字节、0 到 255 的整数数组或标准 base64')
    if 'path' not in part:
        return None
    path = part['path']
    if not isinstance(path, str) or not path.strip() or '\0' in path:
        raise BadArgument('path 必须是非空文件路径')
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        raise BadArgument('STL 文件不可读') from None


def _inventory(parts):
    if not isinstance(parts, (list, tuple)) or not parts:
        raise BadArgument('盘点至少需要一个零件摘要')
    rows, boxes, names = [], [], set()
    for part in parts:
        if not isinstance(part, dict):
            raise BadArgument('零件摘要必须是对象')
        name, source, count = part.get('name'), part.get('source'), part.get('triangleCount')
        if not isinstance(name, str) or not _NAME.fullmatch(name) or name in names:
            raise BadArgument('盘点需要唯一合法的零件名')
        if source not in ('stl', 'proxy') or type(count) is not int or count <= 0:
            raise BadArgument(f'{name} 的来源或三角面数不合法')
        box = _bbox(part.get('bbox'), 'bbox', flat=True)
        names.add(name)
        boxes.append(box)
        rows.append({'name': name, 'source': source, 'triangleCount': count,
                     'bbox': box, **({'sha256': part['sha256']} if 'sha256' in part else {})})
    bounds = tuple(min(b[i] for b in boxes) for i in range(3)) + tuple(max(b[i] for b in boxes) for i in range(3, 6))
    proxied = sum(p['source'] == 'proxy' for p in rows)
    return {'partCount': len(rows), 'loadedCount': len(rows) - proxied, 'proxiedCount': proxied,
            'totalTriangles': sum(p['triangleCount'] for p in rows),
            'bounds': _bbox(bounds, '盘点包围盒', flat=True), 'parts': rows}


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _views(box, fov_deg):
    fov = _number(fov_deg, 'fov_deg', 0, 180)
    if fov in (0, 180):
        raise BadArgument('fov_deg 必须大于 0 且小于 180')
    tangent = math.tan(math.radians(fov) / 2) / 1.1
    if tangent == 0:
        raise BadArgument('fov_deg 太小，无法计算盘点机位')
    half = tuple((hi - lo) / 2 for lo, hi in zip(box[:3], box[3:]))
    target = tuple(lo + d for lo, d in zip(box, half))
    corners = tuple(itertools.product(*((-d, d) for d in half)))
    inv_root3 = 1 / math.sqrt(3)
    inv_root2 = 1 / math.sqrt(2)
    inv_root6 = 1 / math.sqrt(6)
    views = {}
    # 方形透视画幅。对每个角点求出能同时满足水平及竖直视锥的最小距离。
    for name, back, right, up in (
        ('front', (0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ('side', (1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ('top', (0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ('iso', (inv_root3,) * 3, (inv_root2, 0, -inv_root2), (-inv_root6, 2 * inv_root6, -inv_root6)),
    ):
        distance = max(max(_dot(c, back) + max(abs(_dot(c, right)), abs(_dot(c, up))) / tangent for c in corners),
                       max(_dot(c, back) for c in corners) + max(1e-6, math.ulp(max(map(abs, target))) * 4))
        eye = tuple(t + d * distance for t, d in zip(target, back))
        if not math.isfinite(distance) or not all(map(math.isfinite, eye)):
            raise BadArgument('盘点机位超出有限数范围')
        views[name] = {'eye': eye, 'target': target, 'up': up, 'distance': distance, 'bbox': box}
    return views


def build_inventory_four_views(parts_summary, fov_deg=35):
    """用零件摘要生成完整盘点与四个能容纳合并 AABB 的机位。"""
    inventory = _inventory(parts_summary)
    return {'inventory': inventory, 'views': _views(inventory['bounds'], fov_deg)}


def load_stl_kit(kit, opts):
    """按清单顺序读入实件与代理网格，返回几何、盘点清单及可选机位。"""
    _fields(kit, {'parts'}, 'kit')
    _fields(opts, {'unitScale', 'upAxis', 'missingPolicy', 'inventoryViews'}, 'opts')
    scale, axis = _axes(opts.get('unitScale', 0.001), opts.get('upAxis', 'Z'))
    policy, want_views = opts.get('missingPolicy', 'proxy'), opts.get('inventoryViews', True)
    if policy not in ('proxy', 'error'):
        raise BadArgument('missingPolicy 只接受 proxy 或 error')
    if not isinstance(want_views, bool):
        raise BadArgument('inventoryViews 必须是布尔值')
    if not isinstance(kit.get('parts'), list) or not kit['parts']:
        raise BadArgument('parts 须为非空列表')
    parts, names = [], set()
    for part in kit['parts']:
        _fields(part, {'name', 'path', 'bytes', 'fallbackBbox', 'size', 'center'}, 'part')
        name = part.get('name')
        if not isinstance(name, str) or not _NAME.fullmatch(name) or name in names:
            raise BadArgument('parts 中的零件名必须合法且唯一')
        names.add(name)
        try:
            if 'path' in part and 'bytes' in part:
                raise BadArgument('path 与 bytes 二选一')
            box = _proxy_bbox(part)
            data = _read_part(part)
            if data is not None:
                source, geo = 'stl', parse_stl_bytes(data, scale, axis)
            elif policy == 'proxy' and box is not None:
                source, geo = 'proxy', _proxy(box)
            elif policy == 'proxy':
                raise BadArgument('缺少 STL 文件且未提供代理尺寸')
            else:
                raise BadArgument('缺少 STL 文件（missingPolicy=error）')
        except BadArgument as exc:
            raise BadArgument(f'{name}：{exc}') from None
        parts.append({'name': name, 'source': source, **geo})
    summary = build_inventory_four_views(parts) if want_views else {'inventory': _inventory(parts), 'views': {}}
    return {'parts': parts, **summary}


def create(ctx, params):
    """把盘点中的网格交给 Blender 场景，以数字读数接入逐帧元数据。"""
    _fields(params, {'kit', 'unitScale', 'upAxis', 'missingPolicy', 'inventoryViews'}, 'params')
    loaded = load_stl_kit(params.get('kit', _DEFAULT_KIT), {k: v for k, v in params.items() if k != 'kit'})
    bpy = getattr(ctx, 'bpy', None)
    if bpy is None:
        import bpy

    scene = ctx.hostScene
    meshes, entities = [], {}

    def dispose():
        while entities:
            _, obj = entities.popitem()
            bpy.data.objects.remove(obj, do_unlink=True)
        while meshes:
            bpy.data.meshes.remove(meshes.pop())

    try:
        for part in loaded['parts']:
            name = part['name']
            if max(map(abs, part['bbox'])) > 3.4028234663852886e38:  # float32 max
                raise BadArgument(f'{name} 的顶点超出 Blender 坐标范围')
            mesh = bpy.data.meshes.new(name)
            meshes.append(mesh)
            mesh.from_pydata([(x, -z, y) for x, y, z in part['vertices']], [], part['triangles'])
            mesh.update()
            obj = bpy.data.objects.new(name, mesh)
            entities[name] = obj
            scene.collection.objects.link(obj)
    except Exception:
        dispose()
        raise

    inventory, views = loaded['inventory'], loaded['views']
    readings = {k: inventory[k] for k in ('partCount', 'loadedCount', 'proxiedCount', 'totalTriangles')}
    readings['viewCount'] = len(views)

    def apply(f, sub):
        pass

    def meta(f):
        return {'readings': dict(readings)}

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'entities': entities,
            'readings': readings, 'inventory': inventory, 'views': views}
