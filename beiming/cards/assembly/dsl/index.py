"""在镜头初始姿态上应用逐件烘焙的世界矩阵。"""
import json
import math
from itertools import groupby

from mathutils import Matrix, Quaternion


_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def _rigid(rows, name):
    if (not isinstance(rows, list) or len(rows) != 4 or
        any(not isinstance(row, list) or len(row) != 4 or
            not all(type(n) in (float, int) and math.isfinite(n) for n in row) for row in rows) or
        rows[3] != [0, 0, 0, 1]):
        raise ValueError(f'{name}: 需要有限的仿射 4×4 矩阵')
    matrix = Matrix(rows)
    rotation = matrix.to_3x3()
    gram = rotation.transposed() @ rotation
    if (abs(rotation.determinant() - 1) > 1e-5 or
        any(abs(gram[i][j] - int(i == j)) > 1e-5 for i in range(3) for j in range(3))):
        raise ValueError(f'{name}: 需要右手刚体变换')
    return _TO_BLENDER @ matrix @ _TO_BLENDER.transposed()


def create(ctx, params):
    baked = params.get('baked')
    if isinstance(baked, str):
        with open(baked, encoding='utf-8') as stream:
            baked = json.load(stream)
    if not isinstance(baked, dict) or baked.get('format') != 'asm-baked/0.1' or not isinstance(baked.get('parts'), dict):
        raise ValueError('baked 需要 asm-baked/0.1 文件或对象')
    progress = params.get('progress', 1)
    if type(progress) not in (float, int) or not 0 <= progress <= 1:
        raise ValueError('progress 须在 [0,1]')
    animate = params.get('animate', False)
    prefix = params.get('assetAlias', '')
    view = ctx.bpy.context.view_layer
    view.update()
    poses = []
    for name, part in baked['parts'].items():
        obj_name = f'{prefix}.{name}' if prefix else name
        obj = ctx.hostScene.objects.get(obj_name)
        if obj is None:
            raise ValueError(f'找不到拼装零件 {obj_name}')
        delta = _rigid(part.get('matrix4x4'), name)
        parent, depth = obj.parent, 0
        while parent is not None:
            depth += 1
            parent = parent.parent
        poses.append((depth, obj, obj.matrix_world.copy(), delta))

    # 烘焙矩阵已经包含选择器展开后的位移。实际 Blender 父级先求值，
    # 子物体再以烘焙得到的绝对世界姿态写入，组移动不会重复叠加。
    levels = [list(group) for _, group in groupby(sorted(poses, key=lambda p: p[0]), key=lambda p: p[0])]

    def pose_at(u):
        for level in levels:
            for _, obj, original, delta in level:
                if u == 0:
                    obj.matrix_world = original
                elif u == 1:
                    obj.matrix_world = delta @ original
                else:
                    rotation = Quaternion().slerp(delta.to_quaternion(), u).to_matrix().to_4x4()
                    rotation.translation = delta.to_translation() * u
                    obj.matrix_world = rotation @ original
            view.update()

    def apply(f, sub):
        fraction = min(1, max(0, (f + sub) / (ctx.frames - 1))) if animate and ctx.frames > 1 else 1
        pose_at(progress * fraction)

    def dispose():
        pose_at(0)

    apply(0, 0)  # 装载期也交出正确的起始世界姿态，供宿主收集场景。
    return {'apply': apply, 'dispose': dispose}
