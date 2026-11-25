"""摄影棚面光。纯数学层使用北冥 +Y 向上坐标，只有 create 接触 Blender。"""

import math
import re


# 半米标定读数换算到一米主体。每行：实体、相对位置、出光法线、宽边轴提示、两边长、瓦数、线性 RGB、限主体。
# 轴提示为 None 时宽边取水平切线。功率是归一化面光总功率，不是单位面积辐亮度。
_PRESETS = {
    'hero': (
        ('key', (1.3815789, 1.1184211, 1.6447369), (-0.55173731, -0.46897662, -0.68967158), None, (1.9736843, 1.4802631), 64.9238205, (1.0, 0.97, 0.93), False),
        ('top', (0, 1.3815789, 0.19736843), (0, -0.98710549, -0.16007116), (1, 0, 0), (2.9605262, 0.082236841), 43.282547, (1.0, 1.0, 1.0), False),
        ('rim_r', (1.6447369, 0.72368431, -1.3157896), (-0.70201176, -0.34320572, 0.62401068), (0, 1, 0), (1.6447369, 0.16447368), 64.9238205, (0.72, 0.84, 1.0), False),
        ('rim_l', (-1.6447369, 0.49342108, -0.98684216), (0.72199482, -0.30942622, 0.61885291), (0, 1, 0), (1.4802631, 0.13157894), 19.4771461, (0.72, 0.84, 1.0), False),
        ('fill', (-1.1513158, -0.65789479, 1.4802631), (0.57932425, 0.33104223, -0.74484527), None, (1.6447369, 0.98684216), 8.6565094, (1.0, 0.9, 0.78), False),
        ('under', (0.3289474, -0.98684216, 0.72368425), (-0.15179418, 0.72861207, -0.66789448), (1, 0, 0), (2.6315789, 0.098684207), 7.5744457, (1.0, 1.0, 1.0), False),
    ),
    'explode': (
        ('key_b', (1.8092107, 1.3157896, -1.3157896), (-0.68355954, -0.49713415, 0.5344193), None, (1.9736843, 1.6447369), 75.7444611, (1.0, 1.0, 1.0), False),
        ('key', (1.8092107, 1.3157896, 1.6447369), (-0.66531181, -0.48386312, -0.56853908), None, (1.9736843, 1.6447369), 75.7444611, (1.0, 0.97, 0.93), False),
        ('top', (0, 1.5789475, 0.098684214), (0, -1.0, 0), (0, 0, 1), (2.4671052, 0.65789473), 86.565094, (1.0, 1.0, 1.0), False),
        ('rim', (-1.8092107, 0.13157892, 0.098684214), (0.99736583, -0.072535612, 0), (0, 0, 1), (2.3026316, 0.19736841), 75.7444611, (0.72, 0.84, 1.0), False),
        ('under', (0.65789479, -1.3157896, 0.098684214), (-0.4472135, 0.89442724, 0), None, (1.9736843, 1.3157895), 10.8206367, (1.0, 0.9, 0.78), False),
    ),
    'poster': (
        ('key', (0, 1.9736843, 1.9736843), (0, -0.70710677, -0.70710677), None, (3.6184211, 1.9736843), 21.6412735, (1.0, 1.0, 1.0), False),
        ('side_l', (-1.8092107, 0, 0.82236844), (0.91036648, 0, -0.41380295), (0, 1, 0), (1.9736843, 0.39473683), 27.0515919, (1.0, 1.0, 1.0), False),
        ('side_r', (1.8092107, 0, 0.82236844), (-0.91036648, 0, -0.41380298), (0, 1, 0), (1.9736843, 0.39473683), 27.0515919, (1.0, 1.0, 1.0), False),
        ('top', (0, 1.4802631, 0.1644737), (0, -0.99227786, -0.12403475), (1, 0, 0), (2.9605262, 0.32894737), 43.282547, (1.0, 1.0, 1.0), False),
        ('rim_l', (-1.4802631, 0.82236838, -1.4802631), (0.65814513, -0.36563626, 0.65814519), (0, 1, 0), (1.6447369, 0.39473683), 64.9238205, (1.0, 1.0, 1.0), False),
        ('rim_r', (1.4802631, 0.82236838, -1.4802631), (-0.65814519, -0.36563626, 0.65814519), (0, 1, 0), (1.6447369, 0.39473683), 64.9238205, (1.0, 1.0, 1.0), False),
    ),
    'mech-matte': (
        ('fill', (1.6887435, -0.049999982, 1.3721039), (-0.77590925, 0.022973228, -0.63042611), None, (1.0554646, 1.2665577), 19.4951, (0.75, 0.85, 1.0), True),
        ('key', (-1.3721039, 0.79999995, 1.7942899), (0.57259828, -0.33385107, -0.7487821), None, (1.2665577, 0.94991815), 111.4005661, (1.0, 1.0, 1.0), False),
        ('rim_l', (-1.2665576, 0.35000002, -1.4776504), (0.64051586, -0.17699987, 0.74726868), None, (0.26386616, 1.6887435), 144.8207397, (0.8, 0.9, 1.0), True),
        ('rim_r', (1.3721039, 0.44999999, -1.3721039), (-0.6888268, -0.22590989, 0.6888268), None, (0.26386616, 1.6887435), 111.4005661, (1.0, 0.92, 0.85), True),
        ('top', (0, 1.5500002, -0.1583197), (0, -0.98980069, 0.14245902), None, (1.1610112, 1.1610112), 30.6351566, (1.0, 1.0, 1.0), False),
    ),
    'mech-plated': (
        ('strip0', (0.75015998, 0.20000005, 2.3087549), (-0.30797359, -0.082108654, -0.94784516), None, (0.16887434, 1.9000001), 26.457634, (1.0, 0.93, 0.86), True),
        ('strip1', (1.9639443, 0.20000005, 1.4268891), (-0.80628532, -0.082108773, -0.58580047), None, (0.16887434, 1.9000001), 41.7752113, (0.8, 0.9, 1.0), True),
        ('strip2', (2.4275687, 0.20000005, 0), (-0.9966234, -0.082108773, 0), None, (0.16887434, 1.9000001), 26.457634, (0.8, 0.9, 1.0), True),
        ('strip3', (1.9639443, 0.20000005, -1.4268891), (-0.80628514, -0.082108654, 0.58580065), None, (0.16887434, 1.9000001), 41.7752113, (1.0, 0.93, 0.86), True),
        ('strip4', (0.75015998, 0.20000005, -2.3087549), (-0.30797359, -0.082108773, 0.94784516), None, (0.16887434, 1.9000001), 26.457634, (0.8, 0.9, 1.0), True),
        ('strip5', (-0.75015998, 0.20000005, -2.3087549), (0.30797359, -0.082108773, 0.94784516), None, (0.16887434, 1.9000001), 41.7752113, (0.8, 0.9, 1.0), True),
        ('strip6', (-1.9639443, 0.20000005, -1.4268891), (0.80628514, -0.082108654, 0.58580065), None, (0.16887434, 1.9000001), 26.457634, (1.0, 0.93, 0.86), True),
        ('strip7', (-2.4275687, 0.20000005, 0), (0.9966234, -0.082108773, 0), None, (0.16887434, 1.9000001), 41.7752113, (0.8, 0.9, 1.0), True),
        ('strip8', (-1.9639443, 0.20000005, 1.4268891), (0.80628532, -0.082108773, -0.58580047), None, (0.16887434, 1.9000001), 26.457634, (0.8, 0.9, 1.0), True),
        ('strip9', (-0.75015998, 0.20000005, 2.3087549), (0.30797359, -0.082108654, -0.94784516), None, (0.16887434, 1.9000001), 41.7752113, (1.0, 0.93, 0.86), True),
        ('key', (-1.3721039, 0.79999995, 1.7942899), (0.57259828, -0.33385107, -0.7487821), None, (1.2665577, 0.94991815), 47.3452415, (1.0, 1.0, 1.0), True),
        ('top', (0, 1.5500002, -0.1583197), (0, -0.98980069, 0.14245902), None, (1.583197, 1.583197), 52.9152679, (1.0, 1.0, 1.0), False),
    ),
    'wide-matte': (
        ('fill', (1.8947369, -0.049999982, 1.5789474), (-0.76806343, 0.020268288, -0.64005291), None, (1.263158, 1.368421), 58.1717453, (0.75, 0.85, 1.0), True),
        ('key', (-1.5789474, 0.85000014, 2.0), (0.58780348, -0.31643429, -0.74455112), None, (1.5789474, 1.0526316), 193.9058228, (1.0, 1.0, 1.0), False),
        ('rim_l', (-1.6842107, 0.35000002, -1.5789474), (0.72129488, -0.14989409, 0.67621404), None, (0.31578949, 1.7894738), 210.5263214, (0.8, 0.9, 1.0), True),
        ('rim_r', (1.7894738, 0.45000005, -1.4736842), (-0.7577849, -0.1905605, 0.62405831), None, (0.31578949, 1.7894738), 166.2049866, (1.0, 0.92, 0.85), True),
        ('top', (0, 1.6500001, -0.15789475), (0, -0.9914543, 0.13045461), None, (1.6842105, 1.368421), 47.0914116, (1.0, 1.0, 1.0), False),
    ),
}


class BadArgument(ValueError):
    code = 'usage.bad-argument'

    def __init__(self, reason):
        super().__init__(f'{self.code}: {reason}')


def _number(x, label, lo=-3.40282346e38, hi=3.40282346e38):
    if type(x) not in (int, float) or not lo <= x <= hi:
        raise BadArgument(f'{label} 需要范围内的有限数')
    return float(x)


def _vec(v, n, label, **limits):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise BadArgument(f'{label} 需要 {n} 个数')
    return tuple(_number(x, label, **limits) for x in v)


def _fields(obj, allowed, label):
    if not isinstance(obj, dict) or obj.keys() - allowed:
        raise BadArgument(f'{label} 须为字典且只含已声明的字段')


def _receiver(name):
    if not isinstance(name, str) or not name.strip():
        raise BadArgument('receiverCollection 需要非空集合名')
    return name


def _unit(v):
    length = math.hypot(*v)
    if not length:
        raise BadArgument('面光方向或宽边轴退化')
    return tuple(x / length for x in v)


def _width(normal, hint):
    if hint is None:
        x, _, z = normal
        return _unit((-z, 0, x)) if x or z else (1, 0, 0)
    axis = _unit(hint)
    dot = sum(a*b for a, b in zip(axis, normal))
    projected = tuple(a - dot*n for a, n in zip(axis, normal))
    if math.hypot(*projected) < 1e-8:
        raise BadArgument('宽边轴与出光方向平行')
    return _unit(projected)


def _custom(lights):
    if not isinstance(lights, list) or not lights:
        raise BadArgument('custom 方案须指定非空 lights 数组')
    for item in lights:
        _fields(item, {'name', 'position', 'target', 'widthAxis', 'size', 'watts', 'color', 'bodyOnly', 'receiverCollection'}, 'light')
        name = item.get('name')
        if not isinstance(name, str) or not re.fullmatch('[A-Za-z0-9_]+', name) or name == 'rig':
            raise BadArgument('面光实体名称不合法或与根 rig 冲突')
        pos = _vec(item.get('position'), 3, 'position')
        aim = _vec(item.get('target', (0, 0, 0)), 3, 'target')
        axis = _vec(item['widthAxis'], 3, 'widthAxis') if 'widthAxis' in item else None
        size = _vec(item.get('size'), 2, 'size', lo=0)
        if min(size) == 0:
            raise BadArgument('矩形面光边长须为正')
        rgb = _vec(item.get('color', (1, 1, 1)), 3, 'color', lo=0, hi=1)
        limited = item.get('bodyOnly', 'receiverCollection' in item)
        if type(limited) is not bool or ('receiverCollection' in item and not limited):
            raise BadArgument('bodyOnly 必须为布尔值，指定受光集合时不能为 false')
        yield (name, pos, tuple(t-p for t, p in zip(aim, pos)), axis, size,
               _number(item.get('watts'), 'watts', 0), rgb,
               _receiver(item['receiverCollection']) if 'receiverCollection' in item else limited)


def _plan(params):
    _fields(params, {'preset', 'subjectScaleM', 'exposureScale', 'spec'}, 'params')
    preset = params.get('preset', 'hero')
    spec = params.get('spec', {})
    _fields(spec, {'anchor', 'lights', 'cues', 'receiverCollection'}, 'spec')
    scale = _number(params.get('subjectScaleM', 1), 'subjectScaleM', 1e-6, 1e6)
    exposure = _number(params.get('exposureScale', 1), 'exposureScale', 1e-6, 1000)
    anchor = _vec(spec.get('anchor', (0, 0, 0)), 3, 'anchor')
    receiver = _receiver(spec['receiverCollection']) if 'receiverCollection' in spec else None
    rigs = {}

    def prepare(kind):
        if not isinstance(kind, str) or kind not in (*_PRESETS, 'custom'):
            raise BadArgument('未知 preset')
        if kind in rigs:
            return
        rows = _custom(spec.get('lights')) if kind == 'custom' else _PRESETS[kind]
        base = {}
        for name, pos, n, axis, size, watts, color, limited in rows:
            if name in base:
                raise BadArgument(f'面光名称重复：{name}')
            normal = _unit(n)
            link = limited if isinstance(limited, str) else receiver if limited else None
            base[name] = dict(position=tuple(x*scale for x in pos), normal=normal, widthAxis=_width(normal, axis),
                              size=_vec(tuple(x*scale for x in size), 2, '缩放后尺寸'),
                              watts=_number(watts*scale**2, '缩放后功率'), color=color, bodyOnly=bool(limited), receiverCollection=link)
        rigs[kind] = base

    prepare(preset)
    active = preset
    cues = []
    if not isinstance(spec.get('cues', []), list):
        raise BadArgument('cues 须为数组')
    for cue in spec.get('cues', []):
        _fields(cue, {'frame', 'gains', 'exposureScale', 'preset'}, 'cue')
        f = cue.get('frame')
        if type(f) is not int or not 0 <= f < 2**53 or (cues and f <= cues[-1][0]) or len(cue) < 2:
            raise BadArgument('cue 须有变化量，且局部帧号须严格递增')
        active = cue.get('preset', active)
        prepare(active)
        gains = cue.get('gains', {})
        _fields(gains, rigs[active].keys(), 'gains')
        cues.append((f, active, _number(cue['exposureScale'], 'exposureScale', 1e-6, 1000) if 'exposureScale' in cue else None,
                     {k: _number(v, 'gain', 0, 1000) for k, v in gains.items()}))
    if 'lights' in spec and 'custom' not in rigs:
        raise BadArgument('指定了 lights 但未使用 custom 方案')

    def sample(f, sub):
        if type(f) is not int or abs(f) >= 2**53 or _number(sub, 'sub', 0, 1) == 1:
            raise BadArgument('局部帧号须为安全整数，sub 在 [0,1) 内')
        kind, level, gains = preset, exposure, {}
        for frame, changed, value, changes in cues:
            if frame > f:
                break
            if kind != changed:
                kind, gains = changed, {}
            if value is not None:
                level = value
            gains.update(changes)
        theta = math.radians(((f % 720) + sub) * 0.5)
        c, s = math.cos(theta), math.sin(theta)

        def spin(v):
            x, y, z = v
            return c*x + s*z, y, c*z - s*x

        result = {}
        for name, lamp in rigs[kind].items():
            row = lamp.copy()
            if kind == 'mech-plated' and name.startswith('strip'):
                for k in ('position', 'normal', 'widthAxis'):
                    row[k] = spin(lamp[k])
            row['position'] = _vec(tuple(x+t for x, t in zip(row['position'], anchor)), 3, '世界位置')
            row['watts'] = _number(lamp['watts'] * level * gains.get(name, 1), '面光总功率')
            result[name] = row
        return result, level, kind
    return sample, rigs


def solve(params, f=0, sub=0):
    """给定局部帧与子帧，不依赖已应用的帧、Blender 或场景对象。"""
    sample, _ = _plan(params)
    return sample(f, sub)[0]


def solve_studio_rig(preset, subject_scale_m=1.0, exposure_scale=1.0, custom_lights=None, target_center=(0, 0, 0)):
    """求第零帧的逐灯快照；坐标和尺寸以米计，瓦数是已经解出的总功率。"""
    spec = {'anchor': target_center}
    if custom_lights is not None:
        spec['lights'] = custom_lights
    return solve({'preset': preset, 'subjectScaleM': subject_scale_m, 'exposureScale': exposure_scale, 'spec': spec})


def _plated_gradient(tree):
    """镜面材质的间接世界光：前半球的近水平反射方向可见亮带，背半球近黑。"""
    new, link = tree.nodes.new, tree.links.new
    direction = new('ShaderNodeSeparateXYZ')
    link(new('ShaderNodeTexCoord').outputs[0], direction.inputs[0])

    def mapped(axis, start, end, curve):
        node = new('ShaderNodeMapRange')
        node.interpolation_type = curve
        node.inputs[1].default_value, node.inputs[2].default_value = start, end
        link(direction.outputs[axis], node.inputs[0])
        return node.outputs[0]

    palette = new('ShaderNodeValToRGB')
    link(mapped(2, -.25, .9, 'LINEAR'), palette.inputs[0])
    stops = palette.color_ramp.elements
    stops[0].color, stops[1].color = (.004, .005, .008, 1), (.01, .012, .018, 1)
    for t, rgb in ((.24, (.19, .22, .28)), (.42, (.05, .058, .08))):
        stops.new(t).color = (*rgb, 1)
    mix = new('ShaderNodeMixRGB')
    mix.inputs[1].default_value = (.003, .0035, .005, 1)
    link(mapped(1, .3, -.35, 'SMOOTHSTEP'), mix.inputs[0])
    link(palette.outputs[0], mix.inputs[2])
    return mix.outputs[0]


def _blender(v):
    return v[0], -v[2], v[1]


def create(ctx, params):
    """只拥有本实例创建的灯、根物体与世界；受光集合为调用方所有。"""
    sample, rigs = _plan(params)
    scene = ctx.hostScene
    bpy = getattr(ctx, 'bpy', None)
    if bpy is None:
        import bpy
    from mathutils import Matrix, Vector

    receivers, objects, lights, entities = {}, {}, [], {}
    for rig in rigs.values():
        for row in rig.values():
            if row['bodyOnly']:
                name = row['receiverCollection']
                col = bpy.data.collections.get(name) if name is not None else None
                if col is None:
                    raise BadArgument(f'主体专用面光需要存在的 receiverCollection，收到 {name!r}')
                receivers[name] = col

    anchor = tuple(params.get('spec', {}).get('anchor', (0, 0, 0)))
    scale = params.get('subjectScaleM', 1)
    world, root, last = None, None, {}
    # 相邻棚光实例可以交错释放；把上一个世界作为 RNA 引用保存而不是靠名字找回。
    previous_key = '_beiming_studio_previous_world'

    def dispose():
        nonlocal world, root
        if world is not None:
            previous = world.get(previous_key)
            if scene.world == world:
                scene.world = previous
            for other in bpy.data.worlds:
                if other.get(previous_key) == world:
                    if previous is None:
                        del other[previous_key]
                    else:
                        other[previous_key] = previous
            bpy.data.worlds.remove(world)
            world = None
        while objects:
            _, obj = objects.popitem()
            bpy.data.objects.remove(obj, do_unlink=True)
        while lights:
            bpy.data.lights.remove(lights.pop())
        if root is not None:
            bpy.data.objects.remove(root, do_unlink=True)
            root = None
        entities.clear()

    def report(rows, level):
        return {'lightCount': len(rows), 'totalWatts': sum(l['watts'] for l in rows.values()),
                'keyWatts': rows['key']['watts'] if 'key' in rows else 0,
                'linkedCount': sum(l['bodyOnly'] for l in rows.values()),
                'subjectScaleM': scale, 'exposureScale': level}

    def apply(f, sub):
        rows, level, kind = sample(f, sub)
        use_band = kind == 'mech-plated'
        socket = bg.inputs[0]
        if use_band and not socket.is_linked:
            world.node_tree.links.new(band, socket)
        elif not use_band:
            if socket.is_linked:
                world.node_tree.links.remove(socket.links[0])
            rgb = (.006, .007, .010) if kind in ('mech-matte', 'wide-matte') else (.020, .022, .026)
            socket.default_value = (*rgb, 1)
        bg.inputs[1].default_value = level
        for name, obj in objects.items():
            row = rows.get(name)
            data = obj.data
            obj.hide_render = obj.hide_viewport = row is None or not row['watts']
            if row is None:
                # 池里不属于当前方案的灯也要有确定的状态，不能保留上次被激活时的位置或链接。
                obj.location, obj.rotation_quaternion = (0, 0, 0), (1, 0, 0, 0)
                data.size, data.size_y, data.energy, data.color = 1, 1, 0, (1, 1, 1)
                obj.light_linking.receiver_collection = None
                continue
            obj.location = _blender(tuple(x-a for x, a in zip(row['position'], anchor)))
            x = Vector(_blender(row['widthAxis']))
            z = -Vector(_blender(row['normal']))
            obj.rotation_quaternion = Matrix((x, z.cross(x), z)).transposed().to_quaternion()
            data.size, data.size_y = row['size']
            data.energy, data.color = row['watts'], row['color']
            obj.light_linking.receiver_collection = receivers.get(row['receiverCollection'])
        last.update(report(rows, level))

    try:
        world = bpy.data.worlds.new('studio.world')
        if scene.world is not None:
            world[previous_key] = scene.world
        scene.world = world
        world.use_nodes = True
        world.cycles_visibility.camera = False
        bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
        band = _plated_gradient(world.node_tree) if 'mech-plated' in rigs else None
        root = bpy.data.objects.new('studio.rig', None)
        scene.collection.objects.link(root)
        root.location = _blender(anchor)
        entities['rig'] = {'object': root, 'root': True}
        for name in dict.fromkeys(name for rig in rigs.values() for name in rig):
            data = bpy.data.lights.new('studio.' + name, 'AREA')
            lights.append(data)
            data.shape = 'RECTANGLE'
            data.normalize = True
            obj = bpy.data.objects.new('studio.' + name, data)
            entities[name] = objects[name] = obj
            scene.collection.objects.link(obj)
            obj.parent, obj.rotation_mode, obj.visible_camera = root, 'QUATERNION', False
        apply(0, 0)
    except Exception:
        dispose()
        raise

    def meta(f):
        rows, level, _ = sample(f, 0)
        return {'readings': report(rows, level)}

    return {'object': root, 'entities': entities, 'apply': apply, 'readings': last.copy, 'meta': meta, 'dispose': dispose}
