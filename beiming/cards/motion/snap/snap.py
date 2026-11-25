"""从飞入到阻尼扣合，按 f + sub 求绝对位置和朝向。"""

import importlib.util
from copy import deepcopy
from pathlib import Path


_spec = importlib.util.spec_from_file_location(
    'beiming_blender_choreo', Path(__file__).resolve().parents[3] / 'sources/blender/choreo.py')
_choreo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_choreo)
_KEYS = ('t0', 'fly_frames', 'rest_pos', 'rest_rot_deg', 'start_offset', 'start_rot_deg')
_DEFAULT = dict(t0=0, fly_frames=18, rest_pos=[0, 0, 0], rest_rot_deg=[0, 0, 0],
                start_offset=[1, 0, 0], start_rot_deg=[0, 20, 0])


def create(ctx, params):
    part = params.get('part', _DEFAULT)
    if not isinstance(part, dict) or any(key not in part for key in _KEYS):
        raise ValueError('part 必须给出时间、终点位置与朝向、初始偏移与朝向')
    args = tuple(deepcopy(part[key]) for key in _KEYS)
    overshoot = params.get('overshoot', 0.045)
    settle_frames = params.get('settleFrames', 6)

    def sample(f, sub=0):
        return _choreo.eval_snap_motion(f + sub, *args, overshoot=overshoot, settle_frames=settle_frames)

    sample(0)
    name = params.get('object', '')
    if not isinstance(name, str):
        raise ValueError('object 必须是场景物体名')
    obj = ctx.hostScene.objects.get(name) if name else None
    if name and obj is None:
        raise ValueError(f'找不到场景物体 {name}')
    end = args[0] + args[1]

    def apply(f, sub):
        if obj is not None:
            pose = sample(f, sub)
            _choreo.apply_object_pose(obj, pose['position'], pose['rotation_deg'])

    def meta(f):
        return {'readings': {'settled': int(f >= end)}}

    def dispose():
        pass

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'sample': sample}
