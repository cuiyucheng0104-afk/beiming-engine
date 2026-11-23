"""Build-script 镜头运行库。时间与元数据不依赖 bpy；只在分解矩阵时需要 mathutils。"""
import re
import sys
from fractions import Fraction

sys.dont_write_bytecode = True


def _int(x, label):
    if type(x) is not int or abs(x) > 2**53 - 1:
        raise ValueError(f'{label} 必须是安全整数')
    return x


def _number(x):
    if type(x) not in (float, int) or not -sys.float_info.max <= x <= sys.float_info.max:
        raise ValueError(f'需要有限数，收到 {x!r}')
    return x


def _vec(v, n):
    if isinstance(v, (str, bytes, dict)) or not hasattr(v, '__getitem__') or not hasattr(v, '__len__') or len(v) != n:
        raise ValueError(f'需要 {n} 个有限数')
    return tuple(_number(v[i]) for i in range(n))


def _fields(row, allowed):
    if not isinstance(row, dict) or row.keys() - allowed:
        raise ValueError(f'需要字典，只收字段 {sorted(allowed)}')
    return row


def _dict(value, name):
    if not isinstance(value, dict):
        raise ValueError(f'{name} 必须是字典')
    return value


def _unit(u):
    return max(0., min(1., _number(u)))


def smoothstep(u):
    u = _unit(u)
    return u * u * (3 - 2 * u)


def ease_in_out(u):
    u = _unit(u)
    return 2 * u**2 if u < .5 else 1 - 2 * (1 - u)**2


def trapezoid_profile(u, accel_frac=.25):
    """对梯形速度曲线积分，返回位移（0..1）。两端各用 accel_frac 段作匀加/减速。"""
    u, a = _unit(u), _number(accel_frac)
    if not 0 <= a <= .5:
        raise ValueError('accel_frac 必须在 [0, 0.5]')
    if u < a:
        return .5 * (u / a) * u / (1 - a)
    if u > 1 - a:
        return 1 - .5 * ((1 - u) / a) * (1 - u) / (1 - a)
    return (u - a / 2) / (1 - a)


class Timeline:
    """命名段 [start, stop) 与命名标记共用名字。frames 不给时由最后一个段/标记推算。"""
    def __init__(self, fps, frames=None):
        if type(fps) is not int and not (isinstance(fps, str) and re.fullmatch(r'[1-9][0-9]*(/[1-9][0-9]*)?', fps)):
            raise ValueError('fps 必须是正整数或正有理数串')
        self.fps = Fraction(fps)
        if self.fps <= 0 or (frames is not None and _int(frames, 'frames') < 1):
            raise ValueError('fps 与 frames 必须大于 0')
        self.frames, self._spans = frames, {}

    def segment(self, name, start, duration):
        if not isinstance(name, str) or not re.fullmatch(r'[^\s﻿]+', name) or name in self._spans:
            raise ValueError(f'段或标记名称为空、含空白或重复：{name!r}')
        start, duration = _int(start, 'start'), _int(duration, 'duration')
        end = _int(start + duration, 'end')
        if start < 0 or duration < 1 or (self.frames is not None and end > self.frames):
            raise ValueError(f'{name}: 段越界或为空')
        self._spans[name] = (start, end)
        return self

    def mark(self, name, frame):
        return self.segment(name, frame, 1)

    def span(self, name):
        return self._spans[name]

    def frame_of(self, name):
        return self.span(name)[0]

    def after(self, ref, duration=0):
        """段的独占终点再偏移 duration 帧，可用作后一段的 start。"""
        return self.span(ref)[1] + _int(duration, 'duration')

    def progress(self, name, f):
        start, end = self.span(name)
        f = _number(f)
        return float(f >= start) if end == start + 1 else _unit((f - start) / (end - start - 1))

    def frame_to_seconds(self, f):
        return _int(f, 'frame') / self.fps

    def export_events(self, film_id):
        if not isinstance(film_id, str) or not re.fullmatch('[a-z][a-z0-9_-]*', film_id):
            raise ValueError('film_id 不合事件契约')
        return {'format': 'events/0.1', 'film': film_id, 'fps': f'{self.fps.numerator}/{self.fps.denominator}',
                'frames': self.frames or max((end for _, end in self._spans.values()), default=1),
                'events': [{'id': name, 'frame': self.frame_of(name), 'sub': 0, 'kind': 'named', 'from': 'film'}
                           for name in sorted(self._spans, key=lambda name: (self.frame_of(name), name))]}


def to_blender(p):
    x, y, z = _vec(p, 3)
    return (x, -z, y)


def to_beiming(p):
    x, y, z = _vec(p, 3)
    return (x, z, -y)


def _socket(sockets, idx, expected_type):
    if type(idx) is not int or not 0 <= idx < len(sockets):
        raise ValueError(f'插口序号 {idx!r} 越界（共有 {len(sockets)} 个）')
    s = sockets[idx]
    if expected_type is not None and s.type != expected_type:
        raise ValueError(f'插口 {idx} 类型是 {s.type}，不是 {expected_type}')
    return s


def socket_in(node, idx, expected_type=None):
    return _socket(node.inputs, idx, expected_type)


def socket_out(node, idx, expected_type=None):
    return _socket(node.outputs, idx, expected_type)


def _socket_value(s, v):
    kind = s.type
    if kind in ('RGBA', 'VECTOR'):
        v = _vec(v, 4 if kind == 'RGBA' else 3)
    elif kind == 'VALUE':
        v = _number(v)
    elif kind == 'INT':
        v = _int(v, '插口值')
    elif kind == 'BOOLEAN' and type(v) is bool:
        return v
    else:
        raise ValueError(f'{kind} 插口不接受该默认值')
    # Blender 对越界的标量会静默截断，不应让写入值与 state(f) 不同。
    if hasattr(s, 'bl_rna'):
        prop = s.bl_rna.properties['default_value']
        if any(not prop.hard_min <= x <= prop.hard_max for x in (v if isinstance(v, tuple) else (v,))):
            raise ValueError(f'{kind} 插口值超出 RNA 范围')
    return v


def set_socket(node, idx, value, expected_type=None):
    s = socket_in(node, idx, expected_type)
    s.default_value = _socket_value(s, value)
    return s


def link_sockets(tree, from_node, from_idx, to_node, to_idx):
    if from_node.id_data != tree or to_node.id_data != tree:
        raise ValueError('两个节点须属于同一棵节点树')
    src = socket_out(from_node, from_idx)
    return tree.links.new(src, socket_in(to_node, to_idx, src.type))


# identifier 是 RNA 的稳定接口标识，不是 UI 显示名。4.x/5.x 插口布局不同：按实物建索引表。
_PRINCIPLED = {'base_color': ('Base Color', 'RGBA'), 'metallic': ('Metallic', 'VALUE'),
               'roughness': ('Roughness', 'VALUE'), 'ior': ('IOR', 'VALUE'), 'alpha': ('Alpha', 'VALUE'),
               'emission_color': ('Emission Color', 'RGBA'), 'emission_strength': ('Emission Strength', 'VALUE')}


def principled_indices(node):
    if node.bl_idname != 'ShaderNodeBsdfPrincipled':
        raise ValueError('索引表只适用于 Principled BSDF')
    layout = {s.identifier: i for i, s in enumerate(node.inputs)}
    result = {}
    for name, (identifier, kind) in _PRINCIPLED.items():
        i = layout.get(identifier)
        socket_in(node, i, kind)  # 缺失、类型变了都报错，不会误写另一个同类型的口
        result[name] = i
    return result


_TRANSFORM = {'location', 'rotation_euler', 'rotation_quaternion', 'scale'}
_VISIBILITY = {'hide_render', 'hide_viewport'}


def _channels(row):
    """展开一个完整的局部姿态快照；先复制数值，再接触场景。"""
    _fields(row, {'objects', 'sockets'})
    out = {}
    for obj, props in _dict(row.get('objects', {}), 'objects').items():
        _fields(props, _TRANSFORM | _VISIBILITY | {'matrix'})
        if 'matrix' in props:
            if props.keys() & _TRANSFORM:
                raise ValueError('matrix 不与其他变换混用')
            from mathutils import Matrix
            m = props['matrix']
            if len(m) != 4:
                raise ValueError('matrix 要 4×4（局部 TRS，行优先）')
            loc, rot, scale = Matrix([_vec(r, 4) for r in m]).decompose()
            props = {**{p: props[p] for p in props.keys() & _VISIBILITY},
                     'location': loc, 'rotation_quaternion': rot, 'scale': scale}
        if 'rotation_quaternion' in props and 'rotation_euler' in props:
            raise ValueError('旋转只能使用一种表示')
        for p, v in props.items():
            if p in _VISIBILITY:
                if type(v) is not bool:
                    raise ValueError(f'{p} 要布尔值')
            else:
                v = _vec(v, 4 if p == 'rotation_quaternion' else 3)
            out[obj, p] = v
    for key, v in _dict(row.get('sockets', {}), 'sockets').items():
        if not isinstance(key, tuple) or len(key) != 3 or not isinstance(key[2], str):
            raise ValueError('sockets 键要 (node, index, expected_type)')
        s = socket_in(*key)
        out[s, 'default_value'] = _socket_value(s, v)
    return out


def _curve_groups(data):
    """一个所有者使用的 fcurve 集合。Blender 4.0 的旧动作与 4.4+/5.x 的分槽动作。"""
    if data is None or data.action is None:
        return
    action = data.action
    if getattr(action, 'is_action_layered', False):
        for layer in action.layers:
            for strip in layer.strips:
                bag = strip.channelbag(data.action_slot) if data.action_slot else None
                if bag:
                    yield bag.fcurves
    else:
        yield action.fcurves


class StateKernel:
    """每镜头一个核。state(f) 是完整的绝对值快照，不能省掉本帧不变的通道。"""
    def __init__(self, state):
        if not callable(state):
            raise ValueError('state 必须是纯函数 state(f)')
        self.state = state
        self._layout = None

    def write(self, scene, f):
        write_state_keys(scene, f, self)


def write_state_keys(scene, f, kernel):
    """只求三个样本；只替换所声明通道的曲线，保留同物体/节点树上不归这个核管的动画。"""
    f = _int(f, 'frame')
    samples = [_channels(kernel.state(t)) for t in (f - 1, f, f + 1)]
    layout = samples[1].keys()
    if any(s.keys() != layout for s in samples) or (kernel._layout is not None and kernel._layout != layout):
        raise ValueError('state(f) 在每个样本必须交齐同一组物体/插口通道')
    kernel._layout = frozenset(layout)
    paths = {}
    for target, prop in layout:
        owner = target.id_data
        paths.setdefault(owner, set()).add(target.path_from_id(prop))
    for owner, managed in paths.items():
        data = owner.animation_data
        if data and data.action and data.action.users > 1:
            # 别把共用同一动作的其他物体的曲线也删了。
            slot = getattr(data, 'action_slot', None)
            slot_id = slot.identifier if slot else None
            data.action = data.action.copy()
            if slot_id:
                data.action_slot = data.action.slots[slot_id]
        for curves in _curve_groups(data):
            for curve in list(curves):
                if curve.data_path in managed:
                    curves.remove(curve)
    for t, sample in zip((f - 1, f, f + 1), samples):
        for (target, p), v in sample.items():
            if p == 'rotation_quaternion':
                target.rotation_mode = 'QUATERNION'
                if sum(a*b for a, b in zip(v, samples[1][target, p])) < 0:
                    v = tuple(-x for x in v)
            elif p == 'rotation_euler' and target.rotation_mode in ('QUATERNION', 'AXIS_ANGLE'):
                target.rotation_mode = 'XYZ'
            setattr(target, p, v)
            if not target.keyframe_insert(data_path=p, frame=t):
                raise ValueError(f'不能为 {p} 在第 {t} 帧写关键帧')
    for owner, managed in paths.items():
        for curves in _curve_groups(owner.animation_data):
            for curve in curves:
                if curve.data_path in managed:
                    for pt in curve.keyframe_points:
                        pt.interpolation = 'CONSTANT' if curve.data_path in _VISIBILITY else 'LINEAR'
    scene.frame_set(f, subframe=0.)
    # 禁用视口的物体会求值 location，却保留上次可见时的 matrix_world。先让依赖图
    # 在当前姿态上更新一次，再还原视口开关；否则量到的世界包围盒取决于访问顺序。
    hidden = [owner for owner in paths if getattr(owner, 'hide_viewport', False)]
    if hidden:
        try:
            for obj in hidden:
                obj.hide_viewport = False
            scene.view_layers[0].update()
        finally:
            for obj in hidden:
                obj.hide_viewport = True


class MetaCollector:
    """只收镜头能报告的三类数据。坐标默认北冥 Y-up，add_anchor(..., blender=True) 接 Blender 世界坐标。"""
    def __init__(self, extra=None):
        extra = _fields({} if extra is None else extra, {'texts', 'anchors', 'readings'})
        self._texts, self._anchors, self._readings = [], {}, {}
        texts = extra.get('texts', [])
        if not isinstance(texts, (list, tuple)):
            raise ValueError('texts 必须是数组')
        for text in texts:
            _fields(text, {'id', 'text', 'bbox2d'})
            if not isinstance(text.get('text'), str) or not text['text']:
                raise ValueError('文字框缺少非空 text')
            if 'id' in text and not (isinstance(text['id'], str) and text['id']):
                raise ValueError('文字框 id 必须是非空字符串')
            box = _vec(text.get('bbox2d'), 4)
            if box[0] > box[2] or box[1] > box[3]:
                raise ValueError('文字框 bbox2d 的两端写反了')
            self._texts.append({**text, 'bbox2d': box})
        for key, pos in _dict(extra.get('anchors', {}), 'anchors').items():
            self.add_anchor(key, pos)
        for name, value in _dict(extra.get('readings', {}), 'readings').items():
            if not isinstance(name, str) or not name:
                raise ValueError('读数名不能为空')
            self._readings[name] = _number(value)

    def add_anchor(self, key, pos, *, blender=False):
        if not isinstance(key, str) or not re.fullmatch('[^#]+#[^#]+', key) or key in self._anchors:
            raise ValueError(f'锚点 {key!r} 重复或不是「实体名#锚点名」')
        self._anchors[key] = to_beiming(pos) if blender else _vec(pos, 3)

    def merge(self, measured, size, base_size=None):
        """不回写 measure() 的实体；透视投影用相机的列主序刚体世界矩阵与投影矩阵。"""
        camera = measured['camera']
        world, proj = camera['world'], camera['proj']
        entities = {e['name']: dict(e) for e in measured['entities']}
        for key, pos in self._anchors.items():
            entity, name = key.split('#')
            if entity not in entities:
                raise ValueError(f'锚点 {key} 所属实体不存在')
            delta = [pos[j] - world[12+j] for j in range(3)]
            view = [sum(world[4*i+j] * delta[j] for j in range(3)) for i in range(3)] + [1]
            x, y, w = (sum(proj[4*j+i] * view[j] for j in range(4)) for i in (0, 1, 3))
            if abs(w) <= 1e-12:
                raise ValueError(f'锚点 {key} 在相机平面上')
            screen = [_number((1+x/w)*size[0]/2), _number((1-y/w)*size[1]/2)]
            anchors = entities[entity].get('anchors', {})
            if name in anchors:
                raise ValueError(f'锚点 {key} 已存在')
            entities[entity]['anchors'] = {**anchors, name: {'world': list(pos), 'screen': screen}}
        sx, sy = (a / b for a, b in zip(size, base_size or size))
        texts = [{**t, 'bbox2d': [_number(v*k) for v, k in zip(t['bbox2d'], (sx, sy, sx, sy))]} for t in self._texts]
        readings = measured.get('readings', {})
        if readings.keys() & self._readings.keys():
            raise ValueError('读数名重复')
        return {**measured, 'entities': list(entities.values()), 'texts': [*(measured.get('texts') or []), *texts],
                'readings': {**readings, **self._readings}}
