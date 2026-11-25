"""事件冲量镜头震动；每次应用以未震动的机位为准，不叠加上一帧的偏移。"""

import importlib.util
import math
from copy import deepcopy
from fractions import Fraction
from pathlib import Path


_spec = importlib.util.spec_from_file_location(
    'beiming_blender_choreo', Path(__file__).resolve().parents[3] / 'sources/blender/choreo.py')
_choreo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_choreo)


def _base_pose(camera):
    mode = camera.rotation_mode
    attr = {'QUATERNION': 'rotation_quaternion', 'AXIS_ANGLE': 'rotation_axis_angle'}.get(mode, 'rotation_euler')
    return tuple(camera.location), mode, attr, tuple(getattr(camera, attr))


def _rotated(mode, base, rotation_deg):
    if not any(rotation_deg):
        return base
    from mathutils import Euler, Quaternion

    if mode == 'QUATERNION':
        orientation = Quaternion(base)
    elif mode == 'AXIS_ANGLE':
        orientation = Quaternion(base[1:], base[0])
    else:
        orientation = Euler(base, mode).to_quaternion()
    y_up = Quaternion((1, 0, 0), math.pi / 2)
    delta = Euler(tuple(map(math.radians, rotation_deg)), 'XYZ').to_quaternion()
    result = y_up @ delta @ y_up.conjugated() @ orientation
    if mode == 'QUATERNION':
        return result
    if mode == 'AXIS_ANGLE':
        axis, angle = result.to_axis_angle()
        return (angle, *axis)
    return result.to_euler(mode, Euler(base, mode))


def create(ctx, params):
    impulses = deepcopy(params.get('impulses', []))
    if not isinstance(impulses, (list, tuple)) or any(
        not isinstance(row, dict) or 'frame' not in row or row.keys() - {'frame', 'strength'}
        or any(type(n) not in (int, float) or not math.isfinite(n) for n in row.values())
        or row.get('strength', 1) < 0 for row in impulses
    ):
        raise ValueError('impulses 必须给出有限帧号和非负强度')
    try:
        fps = float(Fraction(ctx.fps))
    except (TypeError, ValueError, ZeroDivisionError, OverflowError) as exc:
        raise ValueError('fps 须为正数或有理数字符串') from exc
    enabled = params.get('enabled', True)
    if not isinstance(enabled, bool):
        raise ValueError('enabled 必须是布尔值')
    amp_pos = params.get('ampPosM', 0.02)
    amp_rot = params.get('ampRotDeg', 0.8)
    config = dict(decay_frames=params.get('decayFrames', 8.0), freq_hz=params.get('freqHz', 18.0),
                  fps=fps, amp_pos_m=amp_pos, amp_rot_deg=amp_rot, enabled=enabled)
    base_card = params.get('baseCard', '')
    if not isinstance(base_card, str):
        raise ValueError('baseCard 必须是卡实例名')

    def sample(f, sub=0):
        return _choreo.eval_camera_shake(f + sub, impulses, **config)

    sample(0)
    active = enabled and (amp_pos or amp_rot) and any(impulse.get('strength', 1) for impulse in impulses)
    tracks = getattr(ctx, 'tracks', None)
    static = None

    def apply(f, sub):
        nonlocal static
        if not active:
            return
        offset = sample(f, sub)
        pos, rot = offset['position'], offset['rotation_deg']
        camera = ctx.hostScene.camera
        if camera is None:
            if any(pos) or any(rot):
                raise ValueError('camera.shake 找不到当前机位')
            return
        if getattr(camera, 'parent', None) is not None:
            raise ValueError('camera.shake 的当前机位必须无父对象')
        if base_card:
            handle = ctx.cards.use(base_card)
            base_apply = handle.get('apply')
            if handle.get('object') is not camera or not callable(base_apply):
                raise ValueError('baseCard 必须按帧写当前活动机位')
            base_apply(f, sub)
        elif getattr(tracks, 'camera', None) is camera:
            tracks.apply(f, sub)
        else:
            if static is None or static[0] is not camera:
                if not any(pos) and not any(rot):
                    return
                static = (camera, _base_pose(camera))

        dynamic = bool(base_card) or getattr(tracks, 'camera', None) is camera
        if dynamic and not any(pos) and not any(rot):
            return
        location, mode, attr, orientation = _base_pose(camera) if dynamic else static[1]
        x, y, z = pos
        camera.location = (location[0] + x, location[1] - z, location[2] + y) if any(pos) else location
        setattr(camera, attr, _rotated(mode, orientation, rot))

    def meta(f):
        offset = sample(f)
        return {'readings': {'shakeM': math.hypot(*offset['position']), 'shakeDeg': math.hypot(*offset['rotation_deg'])}}

    def dispose():
        if static is not None:
            camera, (location, _, attr, orientation) = static
            camera.location = location
            setattr(camera, attr, orientation)

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'sample': sample}
