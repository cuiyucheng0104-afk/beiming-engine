"""Closed-form spark strips. Input positions are Y-up metres, times are seconds."""

import math
import struct
from fractions import Fraction


def _number(value, field, low=-math.inf, high=math.inf):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'usage.bad-argument: {field}')
    return value


def _check(p):
    fields = {'position', 'velocity', 'birth', 'life', 'gravity', 'drag', 'sizeM', 'groundY', 'restitution', 'fan', 'pull', 'seed'}
    if not isinstance(p, dict) or p.keys() - fields:
        raise ValueError('usage.bad-argument: particle')
    for key in ('position', 'velocity'):
        v = p.get(key)
        if not isinstance(v, (list, tuple)) or len(v) != 3:
            raise ValueError(f'usage.bad-argument: {key}')
        for x in v:
            _number(x, key)
    if _number(p.get('life'), 'life') <= 0 or _number(p.get('sizeM', 0.02), 'sizeM') <= 0:
        raise ValueError('usage.bad-argument: life or sizeM')
    for key in ('drag', 'fan', 'pull'):
        _number(p.get(key, 0), key, 0)
    for key in ('seed', 'restitution'):
        _number(p.get(key, 0), key, 0, 1)
    for key in ('birth', 'gravity', 'groundY'):
        _number(p.get(key, 0), key)


def _f32(x):
    return struct.unpack('f', struct.pack('f', x))[0]


def _sample(p, age):
    drag = p.get('drag', 0.0)
    kt = drag * age
    if kt < 0.02:
        drift = age * (1 - kt / 2 + kt * kt / 6)
        fall = age * age * (0.5 - kt / 6)
    else:
        drift = -math.expm1(-kt) / drag
        fall = (age - drift) / drag
    x, y, z = (pos + v * drift for pos, v in zip(p['position'], p['velocity']))
    y += p.get('gravity', 0.0) * fall
    if 'groundY' in p and y < p['groundY']:
        y = p['groundY'] + (p['groundY'] - y) * p.get('restitution', 0.35)
    return (x, -z, y), drift


def _material(bpy):
    material = bpy.data.materials.new('Ballistic emission')
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    attribute = tree.nodes.new('ShaderNodeAttribute')
    attribute.attribute_name = 'a'
    strength = tree.nodes.new('ShaderNodeMath')
    strength.operation = 'MULTIPLY'
    strength.inputs[1].default_value = 8.0
    emission = tree.nodes.new('ShaderNodeEmission')
    emission.inputs[0].default_value = (1.0, 0.38, 0.06, 1.0)
    transparent = tree.nodes.new('ShaderNodeBsdfTransparent')
    add = tree.nodes.new('ShaderNodeAddShader')
    output = tree.nodes.new('ShaderNodeOutputMaterial')
    tree.links.new(attribute.outputs[2], strength.inputs[0])
    tree.links.new(strength.outputs[0], emission.inputs[1])
    tree.links.new(transparent.outputs[0], add.inputs[0])
    tree.links.new(emission.outputs[0], add.inputs[1])
    tree.links.new(add.outputs[0], output.inputs[0])
    return material


def create(ctx, params):
    from mathutils import Vector

    particles = params.get('particles')
    if not isinstance(particles, list):
        raise ValueError('usage.bad-argument: particles')
    for particle in particles:
        _check(particle)
    step_fps = _number(params.get('stepFps', 12), 'stepFps', 0.01, 1000)
    fps = float(Fraction(ctx.fps))
    scene, bpy = ctx.hostScene, ctx.bpy
    mesh = bpy.data.meshes.new('Ballistic strips')
    obj = bpy.data.objects.new('Ballistic sparks', mesh)
    scene.collection.objects.link(obj)
    material = _material(bpy)
    mesh.materials.append(material)
    obj['shapeStep'] = 0

    def apply(f, sub):
        now = _f32((f + sub) / fps)
        global_time = _f32((ctx.shot['in'] + f + sub) / fps)
        obj['shapeStep'] = math.floor(_f32(global_time * _f32(step_fps)))
        bpy.context.view_layer.update()
        camera = scene.camera.matrix_world.copy()
        view = camera.inverted()
        verts, faces, weights = [], [], []
        for p in particles:
            age = now - _f32(p.get('birth', 0.0))
            fraction = _f32(_f32(age) / _f32(max(p['life'], 0.0001)))
            if _f32(age) < 0 or fraction >= 1:
                continue
            dx = dy = 0.0
            if p.get('fan', 0) > 0:
                x, y, z = p['velocity']
                velocity = view.to_3x3() @ Vector((x, -z, y))
                axial = abs(velocity.z) / velocity.length if velocity.length > 0.001 else 0
                t = min(1, max(0, (axial - 0.45) / 0.51))
                seed = _f32(p.get('seed', 0))
                angle = _f32(seed * _f32(43.73))
                phase = _f32(seed * _f32(91.31))
                radius = math.sqrt(phase % 1) * t * t * (3 - 2 * t) * p['fan']
                dx, dy = math.cos(angle) * radius, math.sin(angle) * radius * 0.7

            def centre(t):
                point, drift = _sample(p, t)
                v = view @ Vector(point)
                v.x += dx * drift
                v.y += dy * drift
                if p.get('pull', 0) > 0:
                    v.z += min(p['pull'], -v.z / 2)
                return v

            head = centre(age)
            tail = centre(max(0, age - 1.4 / fps))
            # Construct the width in the image plane, including for stationary
            # births and trajectories pointing straight down the optical axis.
            axis = Vector((head.x - tail.x, head.y - tail.y, 0))
            size = p.get('sizeM', 0.02)
            if axis.length < 1.5 * size:
                axis = axis.normalized() if axis.length > 1e-9 else Vector((0, 1, 0))
                tail = head - 1.5 * size * axis
            axis.normalize()
            side = Vector((-axis.y, axis.x, 0)) * size * 0.5 * (1 - 0.6 * fraction)
            index = len(verts)
            for corner in (head + side, head - side, tail - 0.3 * side, tail + 0.3 * side):
                verts.append(camera @ corner)
            faces.append((index, index + 1, index + 2, index + 3))
            light = (1 - fraction) ** 0.7
            weights.extend((light, light, light * 0.25, light * 0.25))
        mesh.clear_geometry()
        mesh.from_pydata(verts, [], faces)
        if verts:
            attr = mesh.attributes.get('a') or mesh.attributes.new('a', 'FLOAT', 'POINT')
            attr.data.foreach_set('value', weights)
        mesh.update()

    def readings():
        return {'alive': len(mesh.polygons), 'shapeStep': obj['shapeStep']}

    def dispose():
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        bpy.data.materials.remove(material)

    return {'object': obj, 'entities': {'sparks': {'root': True, 'object': obj}}, 'apply': apply,
            'readings': readings, 'meta': lambda f: {'readings': readings()}, 'dispose': dispose}
