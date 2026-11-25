"""Cycles 着色倒角。离线只读参数，宿主入口负责节点接线。"""

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


def validate_params(params):
    if not isinstance(params, dict) or params.keys() - {'target', 'radiusM', 'samples', 'enabled'}:
        raise BadArgument('未知的倒角参数')
    target = _target(params.get('target', {'object': 'body'}))
    radius = params.get('radiusM', 0.015)
    samples = params.get('samples', 4)
    enabled = params.get('enabled', True)
    if type(radius) not in (int, float) or not 0.000001 <= radius <= 100:
        raise BadArgument('radiusM 须在 [0.000001, 100] 米内')
    if type(samples) is not int or not 2 <= samples <= 16:
        raise BadArgument('samples 须为 2 至 16 的整数')
    if type(enabled) is not bool:
        raise BadArgument('enabled 须为布尔值')
    return {'target': target, 'radiusM': radius, 'samples': samples, 'enabled': enabled}


def create(ctx, params):
    p = validate_params(params)
    material, principled = _material(ctx, p['target'])
    tree, material_name = material.node_tree, material.name
    destinations = [_input(node, 'Normal', 'VECTOR') for node in principled]
    patches = []

    def dispose():
        if ctx.bpy.data.materials.get(material_name) != material:
            patches.clear()
        while patches:
            bevel = patches.pop()
            upstream = bevel.inputs[1].links
            previous = upstream[0].from_socket if upstream else None
            consumers = [link.to_socket for link in bevel.outputs[0].links]
            tree.nodes.remove(bevel)
            if previous is not None:
                for socket in consumers:
                    tree.links.new(previous, socket)

    try:
        for dest in destinations if p['enabled'] else ():
            previous = dest.links[0].from_socket if dest.is_linked else None
            bevel = tree.nodes.new('ShaderNodeBevel')
            patches.append(bevel)
            bevel.samples = p['samples']
            bevel.inputs[0].default_value = p['radiusM']
            if previous is not None:
                tree.links.new(previous, bevel.inputs[1])
            tree.links.new(bevel.outputs[0], dest)
    except Exception:
        dispose()
        raise

    return {'dispose': dispose, 'meta': lambda f: {'readings': {'nodeCount': len(patches)}}}
