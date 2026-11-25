"""Cycles 凹角遮蔽勾线。离线校验与 Blender 接线独立。"""

import re


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
    fields = {'target', 'distanceM', 'samples', 'inkColor', 'inkStrength', 'inside', 'enabled'}
    if not isinstance(params, dict) or params.keys() - fields:
        raise BadArgument('未知的勾线参数')
    target = _target(params.get('target', {'object': 'body'}))
    distance = params.get('distanceM', 0.06)
    samples = params.get('samples', 8)
    color = params.get('inkColor', '#040405')
    strength = params.get('inkStrength', 0.85)
    inside = params.get('inside', False)
    enabled = params.get('enabled', True)
    if type(distance) not in (int, float) or not 0.000001 <= distance <= 100:
        raise BadArgument('distanceM 须在 [0.000001, 100] 米内')
    if type(samples) is not int or not 1 <= samples <= 32:
        raise BadArgument('samples 须为 1 至 32 的整数')
    if not isinstance(color, str) or not re.fullmatch(r'#[\da-fA-F]{6}', color, re.ASCII):
        raise BadArgument('inkColor 须为线性 RGB 的 #RRGGBB 色串')
    rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    if type(strength) not in (int, float) or not 0 <= strength <= 1:
        raise BadArgument('inkStrength 须在 [0, 1] 内')
    if type(inside) is not bool or type(enabled) is not bool:
        raise BadArgument('inside 与 enabled 须为布尔值')
    return {'target': target, 'distanceM': distance, 'samples': samples, 'inkColor': rgb,
            'inkStrength': strength, 'inside': inside, 'enabled': enabled}


def _ink_nodes(tree, p, dest, previous, nodes):
    def add(kind):
        node = tree.nodes.new(kind)
        nodes.append(node)
        return node

    ao = add('ShaderNodeAmbientOcclusion')
    ao.samples = p['samples']
    ao.inside = p['inside']
    ao.inputs[1].default_value = p['distanceM']
    ramp = add('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'EASE'
    dark, clear = ramp.color_ramp.elements
    dark.position, dark.color = 0.40, (p['inkStrength'],) * 3 + (1,)
    clear.position, clear.color = 0.91, (0, 0, 0, 1)
    mix = add('ShaderNodeMixRGB')
    mix.inputs[1].default_value = tuple(dest.default_value)
    mix.inputs[2].default_value = (*p['inkColor'], 1)
    tree.links.new(ao.outputs[1], ramp.inputs[0])
    tree.links.new(ramp.outputs[0], mix.inputs[0])
    if previous is not None:
        tree.links.new(previous, mix.inputs[1])
    tree.links.new(mix.outputs[0], dest)
    return mix


def create(ctx, params):
    p = validate_params(params)
    material, principled = _material(ctx, p['target'])
    tree, material_name = material.node_tree, material.name
    destinations = [_input(node, 'Base Color', 'RGBA') for node in principled]
    patches = []

    def dispose():
        if ctx.bpy.data.materials.get(material_name) != material:
            patches.clear()
        while patches:
            mix, nodes = patches.pop()
            upstream = mix.inputs[1].links
            previous = upstream[0].from_socket if upstream else None
            consumers = [link.to_socket for link in mix.outputs[0].links]
            for node in reversed(nodes):
                tree.nodes.remove(node)
            if previous is not None:
                for socket in consumers:
                    tree.links.new(previous, socket)

    try:
        for dest in destinations if p['enabled'] and p['inkStrength'] else ():
            previous = dest.links[0].from_socket if dest.is_linked else None
            nodes = []
            try:
                mix = _ink_nodes(tree, p, dest, previous, nodes)
            except Exception:
                for node in reversed(nodes):
                    tree.nodes.remove(node)
                raise
            patches.append((mix, nodes))
    except Exception:
        dispose()
        raise

    return {'dispose': dispose, 'meta': lambda f: {'readings': {'aoCount': len(patches)}}}
