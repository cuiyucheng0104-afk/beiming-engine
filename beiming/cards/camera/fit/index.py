"""Blender 卡入口：先在北冥坐标求整段，再在 apply 时写入本卡的相机。"""

import importlib.util
import json
import math
import sys
from itertools import product
from pathlib import Path


_HERE = Path(__file__).resolve().parent
_PARAMS = json.loads((_HERE / 'card.json').read_text(encoding='utf-8'))['params']
# 帧源按文件装载卡，不能假定其工作目录或导入路径。
_CORE_SPEC = importlib.util.spec_from_file_location('beiming_blender_choreo', _HERE.parents[2] / 'sources' / 'blender' / 'choreo.py')
_CORE = importlib.util.module_from_spec(_CORE_SPEC)
_CORE_SPEC.loader.exec_module(_CORE)
_SQRT_HALF = math.sqrt(0.5)
_FLOAT32_MAX = 3.4028234663852886e38


class _BadArgument(ValueError):
    code = 'usage.bad-argument'


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _box(value):
    if not isinstance(value, dict) or value.keys() != {'min', 'max'}:
        raise _BadArgument('包围盒须仅含 min、max')
    lo, hi = value['min'], value['max']
    if not all(isinstance(v, (list, tuple)) and len(v) == 3 and all(map(_number, v)) for v in (lo, hi)):
        raise _BadArgument('包围盒坐标须各为三个有限数')
    if any(a > b for a, b in zip(lo, hi)):
        raise _BadArgument('包围盒各轴的 min 不得超过 max')
    return {'min': tuple(lo), 'max': tuple(hi)}


def _params(params):
    if not isinstance(params, dict) or params.keys() - _PARAMS.keys():
        raise _BadArgument('参数须使用卡声明的字段名')
    values = {key: params.get(key, spec['default']) for key, spec in _PARAMS.items()}
    for key, spec in _PARAMS.items():
        value = values[key]
        if 'range' in spec:
            lo, hi = spec['range']
            if not _number(value) or not lo <= value <= hi or (spec['type'] == 'integer' and value != int(value)):
                raise _BadArgument(f'{key} 超出范围')
        if spec['type'] == 'boolean' and type(value) is not bool:
            raise _BadArgument(f'{key} 必须是布尔值')
    if values['view'] not in ('fixed', 'orbit'):
        raise _BadArgument('view 只能是 fixed 或 orbit')
    values['bbox'] = _box(values['bbox'])
    series = values['bboxes']
    if series is not None:
        if not isinstance(series, list) or not series:
            raise _BadArgument('bboxes 必须是非空逐帧包围盒数组或 null')
        values['bboxes'] = [_box(box) for box in series]
    return values


def _static_nearest(pose, box, orbit):
    # 静态路径保持旧版语义：没有分辨得出的正深度则没有取景解。
    qx, qy, qz, qw = pose['quaternion']
    back = (2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy))
    tx, ty, tz = pose['target']
    if orbit:
        ce = math.hypot(back[0], back[2])
        return max((y - ty) * back[1] + math.hypot(x - tx, z - tz) * ce
                   for x, y, z in product(*zip(box['min'], box['max'])))
    return max((x - tx) * back[0] + (y - ty) * back[1] + (z - tz) * back[2]
               for x, y, z in product(*zip(box['min'], box['max'])))


def create(ctx, params):
    """创建一台垂直视场角相机；sample 交回北冥坐标下此局部帧的姿态。"""
    p = _params(params)
    static = p['bboxes'] is None
    boxes = [p['bbox']] if static else p['bboxes']
    orbit = p['view'] == 'orbit'
    try:
        poses = _CORE.solve_dynamic_camera_fit(
            boxes, p['azimuthDeg'], p['elevationDeg'], p['fovYDeg'], p['aspect'], p['margin'],
            window_frames=int(p['windowFrames']), smooth_alpha=p['smoothAlpha'],
            ground_y=-sys.float_info.max if static else p['groundY'],
            ground_clearance_m=0 if static else p['groundClearanceM'],
            near_clip_m=math.ulp(0.0) if static else p['nearClipM'],
            use_sliding_max=p['useSlidingMax'], orbit=orbit,
        )
    except ValueError as exc:
        raise _BadArgument(str(exc)) from exc
    if static:
        nearest = _static_nearest(poses[0], boxes[0], orbit)
        if boxes[0]['min'] == boxes[0]['max'] or not poses[0]['distance'] - nearest > abs(nearest) * 1e-12:
            raise _BadArgument('盒退化或尺度不可表示，没有八角都在相机前方的最小取景距离')
    far = 100.0
    for pose, box in zip(poses, boxes):
        radius = math.hypot(*(max(abs(lo - x), abs(hi - x))
                              for lo, hi, x in zip(box['min'], box['max'], pose['target'])))
        far = max(far, 1.01 * (pose['distance'] + radius))
        if far > _FLOAT32_MAX or any(abs(v) > _FLOAT32_MAX for v in pose['position']):
            raise _BadArgument('相机或包围盒超出 Blender 坐标范围')

    def sample(f, sub=0):
        if not _number(f) or f != int(f) or abs(f) > 2 ** 53 - 1 or not _number(sub) or not 0 <= sub < 1:
            raise _BadArgument('帧号或子帧超界')
        return dict(poses[min(len(poses) - 1, max(0, int(f)))])

    bpy = getattr(ctx, 'bpy', None)
    if bpy is None:
        import bpy
    camera_data = bpy.data.cameras.new('camera.fit')
    camera = None
    disposed = False

    def dispose():
        nonlocal disposed
        if disposed:
            return
        disposed = True
        if camera is not None:
            bpy.data.objects.remove(camera, do_unlink=True)
        bpy.data.cameras.remove(camera_data)

    def apply(f, sub=0):
        pose = sample(f, sub)
        x, y, z = pose['position']
        camera.location = (x, -z, y)
        # 北冥到 Blender 的换轴由绕 X 的 +90° 表示，左乘相机到世界的四元数。
        x, y, z, w = pose['quaternion']
        camera.rotation_quaternion = tuple(_SQRT_HALF * v for v in (w - x, w + x, y - z, y + z))

    def meta(f):
        pose = sample(f)
        return {'readings': {'distance': pose['distance'], 'cameraHeightM': pose['position'][1]}}

    try:
        camera_data.sensor_fit = 'VERTICAL'
        camera_data.angle_y = math.radians(p['fovYDeg'])
        camera_data.clip_start, camera_data.clip_end = p['nearClipM'], far
        camera = bpy.data.objects.new('camera.fit', camera_data)
        camera.rotation_mode = 'QUATERNION'
        apply(0)
        ctx.hostScene.collection.objects.link(camera)
    except Exception:
        dispose()
        raise
    return {'object': camera, 'apply': apply, 'sample': sample, 'meta': meta, 'dispose': dispose}
