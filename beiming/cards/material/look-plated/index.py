"""电镀与银镜摄影棚。环绕灯条按局部帧绝对求值。"""

import math


class BadArgument(ValueError):
    code = 'usage.bad-argument'


def _target(value):
    if (not isinstance(value, dict) or len(value) != 1 or value.keys() - {'object', 'material'}
            or any(not isinstance(name, str) or not name.strip() for name in value.values())):
        raise BadArgument('target 须指定一个非空的 object 或 material 名称')
    return dict(value)


def _material(ctx, target):
    scene = ctx.hostScene
    if 'object' in target:
        obj = scene.objects.get(target['object'])
        material = getattr(obj, 'active_material', None)
    else:
        material = ctx.bpy.data.materials.get(target['material'])
    tree = material.node_tree if material is not None else None
    if tree is None or not material.use_nodes:
        raise BadArgument(f'{target} 须绑定一个启用节点的材质')
    principled = [node for node in tree.nodes if node.bl_idname == 'ShaderNodeBsdfPrincipled']
    if not principled:
        raise BadArgument(f'{target} 的材质须含 Principled BSDF')
    return material, principled


def _input(node, identifier, kind):
    return next(s for s in node.inputs if s.identifier == identifier and s.type == kind)


def _range(value, name, minimum, maximum):
    if type(value) not in (int, float) or not minimum <= value <= maximum:
        raise BadArgument(f'{name} 须在 [{minimum}, {maximum}] 内')
    return value


def _rig_params(count, radius, height, sweep, exposure):
    if type(count) is not int or not 1 <= count <= 32:
        raise BadArgument('stripCount 须为 1 至 32 的整数')
    _range(radius, 'radiusM', 0.05, 1000)
    _range(height, 'heightM', 0.05, 1000)
    _range(sweep, 'sweepRateDeg', -360, 360)
    _range(exposure, 'exposureScale', 0, 100)


def compute_strip_rig(frame, sub, stripCount, radiusM, heightM, sweepDegPerFrame, exposureScale):
    """求北冥 Y-up 下的灯条位置与功率。方位角从 +X 向 +Z 增大。"""
    if type(frame) is not int or abs(frame) > 2**53 - 1:
        raise BadArgument('frame 须为安全整数')
    if type(sub) not in (int, float) or not 0 <= sub < 1:
        raise BadArgument('sub 须在 [0, 1) 内')
    _rig_params(stripCount, radiusM, heightM, sweepDegPerFrame, exposureScale)
    # 用精确整数比取模，长镜头或负帧仍保留子帧相位。
    num, den = sweepDegPerFrame.as_integer_ratio()
    phase = ((frame * num) % (360 * den)) / den + sub * sweepDegPerFrame
    strips = []
    for index in range(stripCount):
        degrees = (phase + 360 * index / stripCount) % 360
        angle = math.radians(degrees)
        strips.append({'azimuthDeg': degrees,
                       'position': (radiusM * math.cos(angle), heightM, radiusM * math.sin(angle)),
                       'powerW': radiusM**2 * exposureScale * (16 if index % 2 else 26)})
    return strips


def validate_params(params):
    defaults = {'target': {'object': 'body'}, 'variant': 'plated', 'stripCount': 7,
                'radiusM': 3.5, 'heightM': 1.6, 'sweepRateDeg': 1.5, 'exposureScale': 1,
                'sweepEnabled': True}
    if not isinstance(params, dict) or params.keys() - defaults.keys():
        raise BadArgument('未知的电镀外观参数')
    p = {**defaults, **params}
    p['target'] = _target(p['target'])
    if p['variant'] not in ('plated', 'silver') or type(p['sweepEnabled']) is not bool:
        raise BadArgument('variant 须为 plated 或 silver，sweepEnabled 须为布尔值')
    _rig_params(p['stripCount'], p['radiusM'], p['heightM'], p['sweepRateDeg'], p['exposureScale'])
    return p


def _world_gradient(world, silver):
    world.use_nodes = True
    world.cycles_visibility.camera = False
    tree = world.node_tree
    tree.nodes.clear()
    tex = tree.nodes.new('ShaderNodeTexCoord')
    axes = tree.nodes.new('ShaderNodeSeparateXYZ')
    height = tree.nodes.new('ShaderNodeMapRange')
    height.inputs[1].default_value, height.inputs[2].default_value = -1, 1
    ramp = tree.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    dark, zenith = ramp.color_ramp.elements
    dark.color, zenith.color = (0.015, 0.022, 0.038, 1), (0.075, 0.08, 0.095, 1)
    ramp.color_ramp.elements.new(0.5).color = (0.37, 0.40, 0.45, 1) if silver else (0.46, 0.49, 0.55, 1)
    side = tree.nodes.new('ShaderNodeMapRange')
    side.interpolation_type = 'SMOOTHSTEP'
    side.inputs[1].default_value, side.inputs[2].default_value = -0.32, 0.42
    mix = tree.nodes.new('ShaderNodeMixRGB')
    mix.inputs[1].default_value = (0.012, 0.017, 0.026, 1)
    background = tree.nodes.new('ShaderNodeBackground')
    output = tree.nodes.new('ShaderNodeOutputWorld')
    for src, src_index, dst, dst_index in (
        (tex, 1, axes, 0), (axes, 2, height, 0), (height, 0, ramp, 0), (axes, 1, side, 0),
        (side, 0, mix, 0), (ramp, 0, mix, 2), (mix, 0, background, 0), (background, 0, output, 0),
    ):
        tree.links.new(src.outputs[src_index], dst.inputs[dst_index])


def _finish(node, color, metallic, roughness, previous):
    for identifier, kind, value in (('Base Color', 'RGBA', color), ('Metallic', 'VALUE', metallic),
                                    ('Roughness', 'VALUE', roughness)):
        socket = _input(node, identifier, kind)
        if not socket.is_linked:
            old = tuple(socket.default_value) if kind == 'RGBA' else socket.default_value
            previous.append((socket, old))
            socket.default_value = value


def create(ctx, params):
    from mathutils import Vector

    p = validate_params(params)
    material, principled = _material(ctx, p['target'])
    bpy, scene = ctx.bpy, ctx.hostScene
    material_name = material.name
    silver = p['variant'] == 'silver'
    rate = p['sweepRateDeg'] if p['sweepEnabled'] else 0
    previous_world = scene.world
    if previous_world is not None and previous_world.get('beiming.plated.studio'):
        raise BadArgument('每个场景只允许一个电镀摄影棚')
    objects, lights, previous = [], [], []
    floor_mesh = floor_material = world = None

    def link(name, data):
        obj = bpy.data.objects.new(name, data)
        objects.append(obj)
        scene.collection.objects.link(obj)
        return obj

    def dispose():
        nonlocal floor_mesh, floor_material, world
        # cards-data 可能先释放生成对象及其材质的卡。
        if bpy.data.materials.get(material_name) == material:
            while previous:
                socket, value = previous.pop()
                socket.default_value = value
        previous.clear()
        while objects:
            bpy.data.objects.remove(objects.pop(), do_unlink=True)
        while lights:
            bpy.data.lights.remove(lights.pop())
        if floor_mesh is not None:
            bpy.data.meshes.remove(floor_mesh)
            floor_mesh = None
        if floor_material is not None:
            bpy.data.materials.remove(floor_material)
            floor_material = None
        if world is not None:
            if scene.world == world:
                scene.world = previous_world
            bpy.data.worlds.remove(world)
            world = None

    def sample(f, sub):
        return compute_strip_rig(f, sub, p['stripCount'], p['radiusM'], p['heightM'], rate, p['exposureScale'])

    def apply(f, sub):
        target = Vector((0, 0, p['heightM'] * 0.45))
        for obj, strip in zip(strips, sample(f, sub)):
            x, y, z = strip['position']
            obj.location = (x, -z, y)
            obj.rotation_euler = (target - obj.location).to_track_quat('-Z', 'Y').to_euler()
            obj.data.energy = strip['powerW'] * (0.78 if silver else 1)

    try:
        base = (0.79, 0.81, 0.84, 1) if silver else (0.50, 0.62, 0.80, 1)
        for node in principled:
            _finish(node, base, 0.91 if silver else 0.84, 0.19 if silver else 0.25, previous)

        world = bpy.data.worlds.new('plated.world')
        world['beiming.plated.studio'] = True
        _world_gradient(world, silver)
        scene.world = world
        floor_mesh = bpy.data.meshes.new('plated.floor')
        r = 5 * p['radiusM']
        floor_mesh.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [], [(0, 1, 2, 3)])
        floor_mesh.update()
        floor = link('plated.floor', floor_mesh)
        floor_material = bpy.data.materials.new('plated.mirror')
        floor_material.use_nodes = True
        floor_mesh.materials.append(floor_material)
        floor_bsdf = next(n for n in floor_material.node_tree.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')
        _finish(floor_bsdf, (0.14, 0.16, 0.19, 1), 1, 0.10, [])

        strips = []
        for index in range(p['stripCount']):
            name = f'plated.strip{index}'
            light = bpy.data.lights.new(name, 'AREA')
            lights.append(light)
            light.shape = 'RECTANGLE'
            light.size, light.size_y = p['radiusM'] * 0.10, p['heightM'] * 1.6
            light.color = (1, 0.88, 0.74) if index % 2 else (0.80, 0.90, 1)
            obj = link(name, light)
            obj.visible_camera = False
            strips.append(obj)
        apply(0, 0)
    except Exception:
        dispose()
        raise

    def meta(f):
        return {'readings': {'stripCount': len(strips), 'azimuthDeg': sample(f, 0)[0]['azimuthDeg']}}

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'entities': {'floor': floor}}
