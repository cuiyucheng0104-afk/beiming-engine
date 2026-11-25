"""镜头局部帧、Y 向上的米制坐标。几何求值仅使用 Python 标准库。"""
import math


def _require(condition, label):
    if not condition:
        raise ValueError(f'usage.bad-argument: {label}')


def _number(value, label):
    _require(type(value) in (float, int) and math.isfinite(value), label)
    return value


def _point(value, label):
    _require(isinstance(value, (list, tuple)) and len(value) == 3, label)
    return tuple(_number(v, label) for v in value)


def _fields(spec, keys):
    _require(isinstance(spec, dict) and spec.keys() == keys, ', '.join(sorted(keys)))


def _check_streak(streak):
    _fields(streak, {'points', 'startFrame', 'strideFrames', 'trailFrames', 'halfWidthM'})
    _number(streak['startFrame'], 'startFrame')
    for name in ('strideFrames', 'halfWidthM'):
        _require(_number(streak[name], name) > 0, name)
    _require(type(streak['trailFrames']) is int and 1 <= streak['trailFrames'] <= 120, 'trailFrames')
    points = streak['points']
    _require(isinstance(points, (list, tuple)) and len(points) >= 2, 'points')
    for p in points:
        _point(p, 'points')


def _check_ring(ring):
    _fields(ring, {'center', 'startFrame', 'radiusM', 'widthM', 'segments'})
    _point(ring['center'], 'center')
    _number(ring['startFrame'], 'startFrame')
    for name in ('radiusM', 'widthM'):
        _require(_number(ring[name], name) > 0, name)
    _require(type(ring['segments']) is int and 3 <= ring['segments'] <= 512, 'segments')


def _mesh():
    return {'vertices': [], 'faces': [], 'a': []}


def _cross(a, b):
    return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])


def _sample(streak, t):
    points = streak['points']
    u = min(len(points) - 1, max(0, (t - streak['startFrame']) / streak['strideFrames']))
    i = min(int(u), len(points) - 2)
    return tuple(a + (u - i) * (b - a) for a, b in zip(points[i], points[i+1]))


def build_streak_ribbon_geometry(streak, time, eye):
    """从头向尾取样。相邻四边形共享截面，停顿或沿视线运动时中断带面。"""
    _check_streak(streak)
    _number(time, 'time')
    eye = _point(eye, 'eye')
    geometry = _mesh()
    steps = streak['trailFrames'] * 2
    previous = None
    head = _sample(streak, time)
    for i in range(steps):
        tail = _sample(streak, time - (i + 1) * 0.5)
        tangent = tuple(a - b for a, b in zip(head, tail))
        side = _cross(tangent, tuple(a - b for a, b in zip(eye, head)))
        side_length = math.hypot(*side)
        speed = 2 * math.hypot(*tangent)
        if speed >= 0.004 and side_length > 1e-12:
            level = 0.6 * min(1, speed / 0.045)
            def section(center, index):
                alpha = level * (1 - index / steps)
                offset = streak['halfWidthM'] * alpha**0.6 / side_length
                first = len(geometry['vertices'])
                for sign in (-1, 1):
                    geometry['vertices'].append(tuple(x + sign * offset * s for x, s in zip(center, side)))
                geometry['a'].extend((alpha, alpha))
                return first
            start = previous if previous is not None else section(head, i)
            previous = section(tail, i + 1)
            geometry['faces'].append((start, start + 1, previous + 1, previous))
        else:
            previous = None
        head = tail
    return geometry


def build_shockwave_ring_geometry(ring, time):
    """同心内缘、峰值、外缘共用角采样。以索引回绕闭合最后一个扇段。"""
    _check_ring(ring)
    age = _number(time, 'time') - ring['startFrame']
    geometry = _mesh()
    geometry['radiusM'] = 0.0
    if not 0 <= age < 30:
        return geometry
    radius = 0.12 - ring['radiusM'] * math.expm1(-age / 7)
    width = ring['widthM'] * (0.45 + 0.55 * math.exp(-age / 9))
    brightness = math.exp(-age / 7.5) * min(1, 0.3 + age / 1.5)
    geometry['radiusM'] = radius
    x, y, z = ring['center']
    count = ring['segments']
    for i in range(count):
        angle = math.tau * i / count
        dx, dz = math.cos(angle), math.sin(angle)
        for r in (max(0, radius - width), radius, radius + 0.5 * width):
            geometry['vertices'].append((x + dx*r, y, z + dz*r))
        geometry['a'].extend((0, brightness, 0))
        base, next_base = 3 * i, 3 * ((i + 1) % count)
        for j in (0, 1):
            geometry['faces'].append((base+j, next_base+j, next_base+j+1, base+j+1))
    return geometry


def evaluate_fx_frame(spec, frame, sub=0, eye=(0, 0, 0)):
    _require(isinstance(spec, dict) and spec and not spec.keys() - {'streak', 'ring'}, 'spec')
    _require(type(frame) is int and 0 <= _number(sub, 'sub') < 1, 'frame/sub')
    eye = _point(eye, 'eye')
    t = frame + sub
    streak = build_streak_ribbon_geometry(spec['streak'], t, eye) if 'streak' in spec else _mesh()
    ring = build_shockwave_ring_geometry(spec['ring'], t) if 'ring' in spec else _mesh()
    readings = {'streakFaces': len(streak['faces']), 'ringFaces': len(ring['faces']), 'ringRadiusM': ring.get('radiusM', 0.0)}
    return {'streak': streak, 'ring': ring, 'readings': readings}


def _emissive_material(bpy):
    material = bpy.data.materials.new('streak-ring')
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    attribute = tree.nodes.new('ShaderNodeAttribute')
    attribute.attribute_name = 'a'
    scale = tree.nodes.new('ShaderNodeMath')
    scale.operation = 'MULTIPLY'
    scale.inputs[1].default_value = 10.0
    emission = tree.nodes.new('ShaderNodeEmission')
    emission.inputs[0].default_value = (1, 0.4, 0.08, 1)
    transparent = tree.nodes.new('ShaderNodeBsdfTransparent')
    add = tree.nodes.new('ShaderNodeAddShader')
    output = tree.nodes.new('ShaderNodeOutputMaterial')
    tree.links.new(attribute.outputs[2], scale.inputs[0])  # Attribute 的 Fac
    tree.links.new(scale.outputs[0], emission.inputs[1])
    tree.links.new(emission.outputs[0], add.inputs[0])
    tree.links.new(transparent.outputs[0], add.inputs[1])
    tree.links.new(add.outputs[0], output.inputs[0])
    return material


def create(ctx, params):
    _fields(params, {'spec'})
    spec = params['spec']
    initial = evaluate_fx_frame(spec, 0)
    bpy, scene = ctx.bpy, ctx.hostScene
    material = _emissive_material(bpy)
    mesh = bpy.data.meshes.new('streak-ring')
    obj = bpy.data.objects.new('streak-ring', mesh)
    scene.collection.objects.link(obj)
    mesh.materials.append(material)

    def rebuild(state):
        positions, faces, brightness = [], [], []
        for part in (state['streak'], state['ring']):
            base = len(positions)
            faces.extend(tuple(base + i for i in face) for face in part['faces'])
            positions.extend((x, -z, y) for x, y, z in part['vertices'])
            brightness.extend(part['a'])
        mesh.clear_geometry()
        mesh.from_pydata(positions, [], faces)
        if brightness:
            attr = mesh.attributes.get('a') or mesh.attributes.new('a', 'FLOAT', 'POINT')
            attr.data.foreach_set('value', brightness)
        mesh.update()
        for key, value in state['readings'].items():
            obj[key] = value

    def apply(f, sub):
        scene.view_layers[0].update()
        x, y, z = scene.camera.matrix_world.translation
        rebuild(evaluate_fx_frame(spec, f, sub, (x, z, -y)))

    def readings():
        return {key: obj[key] for key in initial['readings']}

    def dispose():
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        bpy.data.materials.remove(material)

    rebuild(initial)
    return {'object': obj, 'entities': {'effect': {'root': True, 'object': obj}}, 'apply': apply,
            'readings': readings, 'meta': lambda f: {'readings': readings()}, 'dispose': dispose}
