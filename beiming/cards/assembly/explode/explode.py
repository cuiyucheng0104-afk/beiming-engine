"""沿镜头局部帧采样零件散开位置，可绝对写入显式绑定的场景对象。"""

import importlib.util
from copy import deepcopy
from pathlib import Path


_spec = importlib.util.spec_from_file_location(
    'beiming_blender_choreo', Path(__file__).resolve().parents[3] / 'sources/blender/choreo.py')
_choreo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_choreo)


def create(ctx, params):
    parts = deepcopy(params.get('parts', [{'id': 'part', 'rest_pos': [0, 0, 0]}]))
    phase = params.get('phase', {'startFrame': 0, 'endFrame': 24, 'from': 0, 'to': 1})
    if not isinstance(phase, dict) or phase.keys() != {'startFrame', 'endFrame', 'from', 'to'}:
        raise ValueError('phase 必须定义 startFrame、endFrame、from、to')
    start, end, p0, p1 = (phase[k] for k in ('startFrame', 'endFrame', 'from', 'to'))
    if (type(start) is not int or type(end) is not int or start >= end
            or any(type(p) not in (int, float) or not 0 <= p <= 1 for p in (p0, p1))):
        raise ValueError('phase 帧区间必须递增，from、to 须在 [0, 1]')
    config = deepcopy({
        'axis_weights': params.get('axisWeights', [1, 1, 1]), 'scale_m': params.get('scaleM', 1),
        'center': params.get('center'), 'group_offsets': params.get('groupOffsets'),
    })

    def progress(f):
        if f <= start:
            return p0
        if f >= end:
            return p1
        return p0 + (p1 - p0) * ((f - start) / (end - start))

    def sample(f, sub=0):
        return _choreo.eval_explode(parts, progress(f + sub), **config)

    ids = sample(start)
    bindings = params.get('bindings', {})
    if (not isinstance(bindings, dict) or bindings.keys() - ids.keys()
            or any(not isinstance(name, str) or not name for name in bindings.values())
            or len(set(bindings.values())) != len(bindings)):
        raise ValueError('bindings 必须把已知零件 ID 各绑定到不同的场景物体名')
    objects = {}
    for part, name in bindings.items():
        obj = ctx.hostScene.objects.get(name)
        if obj is None:
            raise ValueError(f'找不到场景物体 {name}')
        objects[part] = obj

    def apply(f, sub):
        if objects:
            positions = sample(f, sub)
            for part, obj in objects.items():
                _choreo.apply_object_pose(obj, positions[part])

    def meta(f):
        return {'readings': {'progress': progress(f), 'partCount': len(parts)}}

    def dispose():
        pass

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'sample': sample}
