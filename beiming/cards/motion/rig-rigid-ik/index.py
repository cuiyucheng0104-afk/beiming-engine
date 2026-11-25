"""Analytic rigid transforms in metres, right-handed Y-up world coordinates."""
import math


IDENTITY = ((1., 0., 0., 0.), (0., 1., 0., 0.), (0., 0., 1., 0.), (0., 0., 0., 1.))
BONES = ('root', 'upper', 'lower', 'foot')


def _bad(name):
    raise ValueError('usage.bad-argument: ' + name)


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _bad(name)
    return value


def _vec(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        _bad(name)
    return tuple(_number(x, name) for x in value)


def _add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def _sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def _scale(v, k):
    return tuple(x * k for x in v)


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    return (a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0])


def _unit(v):
    n = math.hypot(*v)
    if not n:
        _bad('zero direction')
    return tuple(x / n for x in v)


def _perpendicular(axis, hint):
    # Pick the least-parallel coordinate axis at a pole singularity.
    projection = _sub(hint, _scale(axis, _dot(axis, hint)))
    if math.hypot(*projection) <= 1e-12 * math.hypot(*hint):
        i = min(range(3), key=lambda j: abs(axis[j]))
        basis = tuple(float(j == i) for j in range(3))
        projection = _sub(basis, _scale(axis, axis[i]))
    return _unit(projection)


def solve_two_bone_ik(hip, ankle, pole, l1, l2):
    """pole is a bend direction. Return both joints, clamped endpoint and reachability."""
    hip, target, pole = _vec(hip, 'hip'), _vec(ankle, 'ankle'), _vec(pole, 'pole')
    if min(_number(l1, 'l1'), _number(l2, 'l2')) <= 0:
        _bad('segment length')
    delta = _sub(target, hip)
    distance = math.hypot(*delta)
    axis = _unit(delta) if distance else (0., -1., 0.)
    bend = _perpendicular(axis, pole)
    near, far = abs(l1 - l2), l1 + l2
    reach = max(near, min(distance, far))
    if reach == 0:
        along, height = 0., l1
    else:
        # Factoring the difference of squares avoids cancellation for equal lengths.
        along = 0.5 * (reach + (l1 - l2) * (l1 + l2) / reach)
        height = math.sqrt(max(0., (l1 - along) * (l1 + along)))
    knee = _add(hip, _add(_scale(axis, along), _scale(bend, height)))
    return {'hip': hip, 'knee': knee, 'ankle': _add(hip, _scale(axis, reach)),
            'normal': _unit(_cross(axis, bend)), 'ok': near <= distance <= far}


def _basis(direction, up):
    forward = _unit(_vec(direction, 'direction'))
    side = _unit(_cross(forward, _perpendicular(forward, _vec(up, 'up'))))
    return (forward, _cross(side, forward), side)


def solve_aim_rotation(rest_direction, target_direction, rest_up=(0., 1., 0.), target_up=(0., 1., 0.)):
    """Right-handed 3×3 rotation mapping both the forward axis and projected up."""
    old, new = _basis(rest_direction, rest_up), _basis(target_direction, target_up)
    return tuple(tuple(sum(new[k][i] * old[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def _rigid(rotation, source, target):
    return tuple((*row, target[i] - _dot(row, source)) for i, row in enumerate(rotation)) + (IDENTITY[3],)


def _spec(spec):
    if not isinstance(spec, dict) or set(spec) - {
            'hip', 'ankle', 'pole', 'l1', 'l2', 'targetAnkle', 'rootOffset', 'startFrame', 'endFrame', 'bindings'}:
        _bad('spec')
    for key in ('hip', 'ankle', 'pole', 'l1', 'l2', 'targetAnkle', 'rootOffset', 'startFrame', 'endFrame'):
        if key not in spec:
            _bad(key)
    start, end = (_number(spec[key], key) for key in ('startFrame', 'endFrame'))
    if start >= end:
        _bad('frame interval')
    bindings = spec.get('bindings', {})
    if not isinstance(bindings, dict) or set(bindings) - set(BONES):
        _bad('bindings')
    names = set()
    for group in bindings.values():
        if not isinstance(group, list):
            _bad('bindings')
        for name in group:
            if not isinstance(name, str) or not name or name in names:
                _bad('object name')
            names.add(name)
    return bindings


def evaluate_rig_pose(spec, frame, sub=0):
    """World-space displacements relative to each rigid segment's standing pose."""
    _spec(spec)
    if not 0 <= _number(sub, 'sub') < 1:
        _bad('sub')
    t = _number(frame, 'frame') + sub
    phase = min(1., max(0., (t - spec['startFrame']) / (spec['endFrame'] - spec['startFrame'])))
    phase = phase * phase * (3 - 2 * phase)
    rest = solve_two_bone_ik(spec['hip'], spec['ankle'], spec['pole'], spec['l1'], spec['l2'])
    if not rest['ok']:
        _bad('unreachable rest pose')
    offset, target = _vec(spec['rootOffset'], 'rootOffset'), _vec(spec['targetAnkle'], 'targetAnkle')
    hip = _add(rest['hip'], _scale(offset, phase))
    ankle = _add(rest['ankle'], _scale(_sub(target, rest['ankle']), phase))
    if hip == rest['hip'] and ankle == rest['ankle']:
        return {**rest, 'phase': phase, 'matrices': dict.fromkeys(BONES, IDENTITY)}
    pose = solve_two_bone_ik(hip, ankle, spec['pole'], spec['l1'], spec['l2'])
    matrices = {'root': _rigid(tuple(row[:3] for row in IDENTITY[:3]), rest['hip'], hip),
                'foot': _rigid(tuple(row[:3] for row in IDENTITY[:3]), rest['ankle'], pose['ankle'])}
    for name, base, tip in [('upper', 'hip', 'knee'), ('lower', 'knee', 'ankle')]:
        rotation = solve_aim_rotation(_sub(rest[tip], rest[base]), _sub(pose[tip], pose[base]),
                                      rest['normal'], pose['normal'])
        matrices[name] = _rigid(rotation, rest[base], pose[base])
    return {**pose, 'phase': phase, 'matrices': matrices}


def create(ctx, params):
    from mathutils import Matrix

    spec = params.get('spec')
    bindings = _spec(spec)
    standing = evaluate_rig_pose(spec, spec['startFrame'])
    view = ctx.bpy.context.view_layer
    view.update()
    bound = []
    for bone, names in bindings.items():
        for name in names:
            obj = ctx.hostScene.objects.get(name)
            if obj is None:
                _bad('missing object ' + name)
            bound.append((obj, bone, obj.matrix_world.copy()))
    # Parents must have their new world matrices before Blender computes a child's local one.
    def depth(entry):
        parent, level = entry[0].parent, 0
        while parent is not None:
            parent, level = parent.parent, level + 1
        return level

    bound.sort(key=depth)
    basis = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    inverse = basis.transposed()
    def measurements(pose):
        return {'boundObjects': len(bound), 'reachable': int(pose['ok']), 'phase': pose['phase'],
                'kneeX': pose['knee'][0], 'kneeY': pose['knee'][1], 'kneeZ': pose['knee'][2]}

    current = measurements(standing)

    def apply(f, sub):
        pose = evaluate_rig_pose(spec, f, sub)
        for obj, bone, bind in bound:
            obj.matrix_world = basis @ Matrix(pose['matrices'][bone]) @ inverse @ bind
            view.update()
        current.update(measurements(pose))

    def dispose():
        for obj, _, bind in bound:
            obj.matrix_world = bind
            view.update()

    return {'apply': apply, 'readings': lambda: dict(current), 'meta': lambda f: {'readings': dict(current)},
            'dispose': dispose}
