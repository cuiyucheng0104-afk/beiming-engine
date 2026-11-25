"""K2 包围盒契约。所有输入与报告使用北冥右手 +Y 向上米制坐标。"""

import math
import re


_NAME = re.compile(r'[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*')
_FACES = (
    (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
    (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2),
    (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5),
)
_DEFAULT_SPEC = {'envelope': [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5],
                 'parts': [{'name': 'body', 'size': [0.5, 0.5, 0.5]}]}


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


def _boolean(value, label):
    if not isinstance(value, bool):
        raise BadArgument(f'{label} 必须是布尔值')
    return value


def _name(value, label):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise BadArgument(f'{label} 必须是合法实体名')
    return value


def _vector(value, length, label):
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise BadArgument(f'{label} 必须含 {length} 个数')
    return tuple(_number(x, label) for x in value)


def _bbox(value, label, *, flat=False):
    box = _vector(value, 6, label)
    for lo, hi in zip(box[:3], box[3:]):
        if hi < lo or (hi == lo and not flat) or not math.isfinite(hi - lo):
            raise BadArgument(f'{label} 的上下界须有序且跨度有限，代理盒各轴需有正跨度')
    return box


def _part_bbox(part):
    has_box, has_size = 'bbox' in part, 'size' in part
    if has_box == has_size or (has_box and 'center' in part):
        raise BadArgument('零件须声明 bbox 或 size，center 只和 size 一起使用')
    if has_box:
        return _bbox(part['bbox'], 'bbox')
    size = _vector(part['size'], 3, 'size')
    center = _vector(part.get('center', (0, 0, 0)), 3, 'center')
    if min(size) <= 0:
        raise BadArgument('size 各轴须大于零')
    return _bbox(tuple(c - s / 2 for c, s in zip(center, size))
                 + tuple(c + s / 2 for c, s in zip(center, size)), 'size/center')


def validate_bbox_spec(spec):
    """返回规范化副本，检查部件名、包围盒和让位引用。几何违规由契约检查报告。"""
    _fields(spec, {'envelope', 'parts', 'fallbackMissing'}, 'spec')
    envelope = _bbox(spec.get('envelope'), 'envelope')
    fallback = _boolean(spec.get('fallbackMissing', True), 'fallbackMissing')
    if not isinstance(spec.get('parts'), list) or not spec['parts']:
        raise BadArgument('parts 须为非空列表')
    parts, names, entities = [], set(), set()
    for part in spec['parts']:
        _fields(part, {'name', 'bbox', 'size', 'center', 'required', 'clearances', 'entity'}, 'part')
        name = _name(part.get('name'), 'part.name')
        if name in names:
            raise BadArgument(f'零件名重复 {name}')
        names.add(name)
        box = _part_bbox(part)
        required = _boolean(part.get('required', True), 'required')
        row = {'name': name, 'bbox': box, 'required': required, 'clearances': []}
        if 'entity' in part:
            entity = _name(part['entity'], 'entity')
            if entity in entities:
                raise BadArgument(f'场景实体重复绑定 {entity}')
            entities.add(entity)
            row['entity'] = entity
        clearances = part.get('clearances', [])
        if not isinstance(clearances, list):
            raise BadArgument('clearances 须为列表')
        against_names = set()
        for pair in clearances:
            _fields(pair, {'against', 'minGap'}, 'clearance')
            against = _name(pair.get('against'), 'against')
            if against == name or against in against_names:
                raise BadArgument(f'{name} 有自引用或重复的让位对 {against}')
            against_names.add(against)
            row['clearances'].append({'against': against, 'minGap': _number(pair.get('minGap'), 'minGap', 0)})
        parts.append(row)
    for part in parts:
        for pair in part['clearances']:
            if pair['against'] not in names:
                raise BadArgument(f"{part['name']} 的让位对引用了未知零件 {pair['against']}")
    return {'envelope': envelope, 'parts': parts, 'fallbackMissing': fallback}


def _gap(a, b):
    return math.hypot(*(max(b[i] - a[i + 3], a[i] - b[i + 3], 0.0) for i in range(3)))


def check_bbox_contract(spec, actual_boxes, clearance_tol=0.0005):
    """核对实际 AABB 与占位 AABB。缺少必需件时按 spec.fallbackMissing 处理。"""
    return _check(validate_bbox_spec(spec), actual_boxes, _number(clearance_tol, 'clearanceTol', 0, 0.1))


def _check(spec, actual_boxes, tol):
    _fields(actual_boxes, {p['name'] for p in spec['parts']}, 'actual_boxes')
    envelope = spec['envelope']
    boxes, errors, proxied, missing = {}, [], [], []
    for part in spec['parts']:
        name, expected = part['name'], part['bbox']
        if name in actual_boxes:
            box = _bbox(actual_boxes[name], 'actual_boxes.' + name, flat=True)
        else:
            missing.append(name)
            if not part['required']:
                continue
            if not spec['fallbackMissing']:
                errors.append({'code': 'missing-part', 'part': name})
                continue
            proxied.append(name)
            box = expected
        boxes[name] = box
        for i, axis in enumerate('XYZ'):
            over = max(envelope[i] - box[i], box[i + 3] - envelope[i + 3])
            if over > tol:
                errors.append({'code': 'outside-envelope', 'part': name, 'axis': axis, 'overBy': over})
            expected_span = expected[i + 3] - expected[i]
            span = box[i + 3] - box[i]
            if abs(span - expected_span) > tol:
                errors.append({'code': 'scale-mismatch', 'part': name, 'axis': axis,
                               'expectedSize': expected_span, 'actualSize': span})
    for part in spec['parts']:
        name = part['name']
        for pair in part['clearances']:
            against, minimum = pair['against'], pair['minGap']
            if name in boxes and against in boxes:
                gap = _gap(boxes[name], boxes[against])
                if gap < minimum - tol:
                    errors.append({'code': 'clearance', 'part': name, 'against': against,
                                   'gap': gap, 'minGap': minimum})
    return {'ok': not errors, 'errors': errors, 'missingParts': missing, 'proxiedParts': proxied, 'boxes': boxes}


def build_proxy_geometry(part):
    """八个北冥坐标顶点与十二个朝外的三角面。"""
    x0, y0, z0, x1, y1, z1 = box = _part_bbox(part)
    vertices = ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
    return {'vertices': vertices, 'triangles': _FACES, 'bbox': box}


def _to_blender(point):
    x, y, z = point
    return x, -z, y


def _from_blender(point):
    x, y, z = point
    return x, z, -y


def _world_bbox(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    if not evaluated.data.vertices:
        raise BadArgument('绑定的场景网格没有顶点')
    matrix = evaluated.matrix_world
    points = iter(evaluated.data.vertices)
    low = list(_from_blender(matrix @ next(points).co))
    high = low.copy()
    for vertex in points:
        for i, value in enumerate(_from_blender(matrix @ vertex.co)):
            low[i] = min(low[i], value)
            high[i] = max(high[i], value)
    return tuple(low + high)


def _scale_spec(spec, scale):
    def scaled(box, label):
        return _bbox(tuple(x * scale for x in box), label)

    spec['envelope'] = scaled(spec['envelope'], 'envelopeScale × envelope')
    for part in spec['parts']:
        part['bbox'] = scaled(part['bbox'], 'envelopeScale × bbox')
        for pair in part['clearances']:
            pair['minGap'] = _number(pair['minGap'] * scale, 'envelopeScale × minGap')


def create(ctx, params):
    """核对显式绑定的场景网格。只为新建的必需件代理登记实体。"""
    _fields(params, {'spec', 'fallbackMissing', 'clearanceTol', 'envelopeScale'}, 'params')
    spec = validate_bbox_spec(params.get('spec', _DEFAULT_SPEC))
    if 'fallbackMissing' in params:
        spec['fallbackMissing'] = _boolean(params['fallbackMissing'], 'fallbackMissing')
    tol = _number(params.get('clearanceTol', 0.0005), 'clearanceTol', 0, 0.1)
    _scale_spec(spec, _number(params.get('envelopeScale', 1), 'envelopeScale', 0.001, 1000))

    scene = ctx.hostScene
    entities, boxes = {}, {}
    bindings = [(p['name'], scene.objects.get(p['entity'])) for p in spec['parts'] if 'entity' in p]
    if any(obj is not None for _, obj in bindings):
        layer = scene.view_layers[0]
        layer.update()
        for name, obj in bindings:
            if obj is None:
                continue
            if obj.type != 'MESH':
                raise BadArgument(f'{name} 须绑定场景中的 Mesh')
            boxes[name] = _world_bbox(obj, layer.depsgraph)
    report = _check(spec, boxes, tol)
    if not report['ok']:
        detail = ', '.join(f"{issue['part']} {issue['code']}" for issue in report['errors'])
        raise BadArgument('包围盒契约不通过：' + detail)

    bpy = getattr(ctx, 'bpy', None)
    if bpy is None:
        import bpy

    meshes = []

    def dispose():
        while entities:
            _, obj = entities.popitem()
            bpy.data.objects.remove(obj, do_unlink=True)
        while meshes:
            bpy.data.meshes.remove(meshes.pop())

    try:
        for name in report['proxiedParts']:
            geo = build_proxy_geometry({'bbox': report['boxes'][name]})
            if max(map(abs, geo['bbox'])) > 3.4028234663852886e38:  # float32 max
                raise BadArgument(f'{name} 的代理顶点超出 Blender 坐标范围')
            mesh = bpy.data.meshes.new(name)
            meshes.append(mesh)
            mesh.from_pydata(list(map(_to_blender, geo['vertices'])), [], geo['triangles'])
            mesh.update()
            obj = bpy.data.objects.new(name, mesh)
            entities[name] = obj
            scene.collection.objects.link(obj)
    except Exception:
        dispose()
        raise

    readings = {'partCount': len(spec['parts']), 'loadedCount': len(boxes),
                'missingCount': len(report['missingParts']), 'proxiedCount': len(entities), 'ok': 1}

    def apply(f, sub):
        pass

    def meta(f):
        return {'readings': dict(readings)}

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'entities': entities,
            'readings': readings, 'contract': report}
