# blender.state-keys：出第 f 帧之前，把 tracks 在 f − 1、f、f + 1 三个整帧上的值写成关键帧，线性插值，
# 让 Cycles 原生的快门运动模糊在 [f, f + 快门角 ÷ 360] 里看得见运动。
# 写哪几个物体：ctx.tracks.objects，就是 tracks.apply 写的那几个（现在是 tracks 的相机）。
# 每次 apply 先删掉这几个物体上一次留下的动画（连同动作数据块），再写这一帧的三个关键帧：结果只由 f 定，不跨帧留状态。
from bpy_extras import anim_utils


def _clear(bpy, owner):
    """删掉这个数据块上的动画，连同只有它在用的动作"""
    data = owner.animation_data
    if data is None:
        return
    action = data.action
    owner.animation_data_clear()
    if action is not None and action.users == 0:
        bpy.data.actions.remove(action)


def _linear(owner):
    """这个数据块上全部关键帧改成线性插值"""
    data = owner.animation_data
    bag = anim_utils.action_get_channelbag_for_slot(data.action, data.action_slot) if data and data.action else None
    for curve in bag.fcurves if bag else ():
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'


def create(ctx, params):
    bpy, tracks = ctx.bpy, ctx.tracks
    objects = list(getattr(tracks, 'objects', ()))

    def key(obj, t, ref):
        """把 obj 现在的变换写成第 t 帧的关键帧；旋转和 ref（第 f 帧的值）对齐到同一侧，插值不绕远路"""
        obj.keyframe_insert('location', frame=t)
        if obj.rotation_mode == 'QUATERNION':
            q = obj.rotation_quaternion
            if q.dot(ref) < 0:
                obj.rotation_quaternion = -q
            obj.keyframe_insert('rotation_quaternion', frame=t)
        else:
            obj.rotation_euler.make_compatible(ref)
            obj.keyframe_insert('rotation_euler', frame=t)
        obj.keyframe_insert('scale', frame=t)
        if obj.type == 'CAMERA':
            obj.data.keyframe_insert('lens', frame=t)

    def apply(f, sub):
        if sub != 0:
            raise ValueError('blender.state-keys 只在整帧上写关键帧，sub 必须是 0，给的是 %r' % (sub,))
        for obj in objects:
            _clear(bpy, obj)
            if obj.type == 'CAMERA':
                _clear(bpy, obj.data)
        tracks.apply(f, 0.0)
        refs = [(obj.rotation_quaternion.copy() if obj.rotation_mode == 'QUATERNION' else obj.rotation_euler.copy()) for obj in objects]
        for t in (f - 1, f, f + 1):
            tracks.apply(t, 0.0)
            for obj, ref in zip(objects, refs):
                key(obj, t, ref)
        for obj in objects:
            _linear(obj)
            if obj.type == 'CAMERA':
                _linear(obj.data)
        # 场景停在第 f 帧的值上
        tracks.apply(f, 0.0)

    def dispose():
        for obj in objects:
            _clear(bpy, obj)
            if obj.type == 'CAMERA':
                _clear(bpy, obj.data)

    return {'apply': apply, 'dispose': dispose}
