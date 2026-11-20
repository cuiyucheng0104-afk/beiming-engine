# Blender 帧源的渲染器一侧。由 host.mjs 起成常驻的后台进程：
#   blender -b -noaudio --factory-startup --python worker.py -- <放中间 EXR 的临时目录>
# 标准输入每行一条 JSON 请求，原来的标准输出每行一条 JSON 应答；Blender 自己往标准输出打的字改道到标准错误。
# 口径：
#   长度是米。对外交出的坐标一律右手系 Y 向上：Blender 里的 (x, y, z) 换成 (x, z, -y)。
#   时间是整数的镜头局部帧号，Blender 的帧号就是它；快门从帧起点打开（motion_blur_position = START）。
#   颜色层是场景线性光（Rec.709 原色），32 位浮点 EXR 直读，不过显示变换；颜色预乘 A。
#   镜头没设背景（scene.world 是空的）或者背景对相机不可见时，什么都没打到的样本 A 和 R、G、B 都是 0；背景对相机可见时 A 是 1。
#   深度、编号、法线三层和元数据量的都是这一帧 sub = 0：关运动模糊、关景深、1 采样、取像素中心，另渲一遍。
#   什么都没打到的像素，Cycles 的深度层给 1e10（米）、法线层给 (0, 0, 0)、编号层给 0，原样交出。
#   可见比例用四分之一分辨率的编号层在 CPU 上数：合渲的像素数 ÷ 单独渲的像素数。
#   颜色层和辅助层各用一个场景（辅助场景是镜头场景的浅拷贝，物体是同一批）：各自留着自己的渲染会话，
#   颜色那一个在显卡上、辅助那一个在 CPU 上，逐帧来回渲不用换设备、不丢常驻的渲染数据。
# 入口文件（build-script 模式）是一个 Python 文件，定义 build(ctx)，只在装载时跑一次，把场景搭进当前的 Blender 场景和时间线，
# 设好 scene.camera，返回 {"entities": [{"name", "class", "role"?, "objects": [bpy 物体]}]}；名下没有物体的是装配体，靠名字前缀归拢。
import hashlib
import importlib.util
import json
import math
import os
import sys
import time

import bpy
import numpy as np

SCRATCH = sys.argv[sys.argv.index('--') + 1]
IPC = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)

# Blender 的 (x, y, z) → 北冥的 (x, z, -y)
AXIS = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
STATE = {}


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Ctx:
    """交给入口文件的 build(ctx)：这个镜头的帧数、帧率、画幅、种子、画风令牌、档位，和换轴的小工具"""

    def __init__(self, job):
        self.frames = job['frames']
        self.fps = job['fps']
        self.size = list(job['size'])
        self.seed = job['seed']
        self.tokens = dict(job['tokens'])
        self.tier = job['tier']

    @staticmethod
    def to_blender(p):
        """北冥的 (x, y, z)（Y 向上）→ Blender 的 (x, -z, y)"""
        return (p[0], -p[2], p[1])


def pick_device():
    """按平台找显卡后端：Linux 试 OPTIX、CUDA，macOS 试 METAL；都没有就用 CPU。返回实际用的后端和显卡名。"""
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for backend in (('METAL',) if sys.platform == 'darwin' else ('OPTIX', 'CUDA')):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            return {'backend': backend, 'gpu': gpus[0].name}
    prefs.compute_device_type = 'NONE'
    return {'backend': 'CPU'}


DEVICE = {}


def oidn_on_gpu():
    """OIDN 降噪能不能放在显卡上：颜色这一遍用显卡渲，并且 Blender 认这块显卡跑得了 OIDN"""
    return DEVICE['backend'] != 'CPU' and bpy.context.preferences.addons['cycles'].preferences.has_oidn_gpu_devices()


def reset():
    """清成空场景。恢复出厂设置会把偏好里的渲染设备一起清掉，所以每次清完都重新选一遍设备。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    DEVICE.clear()
    DEVICE.update(pick_device())


reset()


def rigid(matrix_world):
    """物体的世界矩阵去掉缩放：返回 (3×3 旋转, 位置)，都在 Blender 坐标里"""
    m = np.array(matrix_world, dtype=np.float64)
    rot = m[:3, :3] / np.linalg.norm(m[:3, :3], axis=0)
    return rot, m[:3, 3]


def op_hello(_job):
    return {'version': bpy.app.version_string.split(' ')[0], **DEVICE}


def uncrop(r):
    r.resolution_percentage = 100
    r.pixel_aspect_x = r.pixel_aspect_y = 1.0
    r.use_border = False
    r.use_crop_to_border = False
    r.border_min_x = r.border_min_y = 0.0
    r.border_max_x = r.border_max_y = 1.0


def op_open(job):
    reset()
    scene = bpy.context.scene
    r, c = scene.render, scene.cycles
    r.engine = 'CYCLES'
    r.use_persistent_data = True
    r.resolution_x, r.resolution_y = job['size']
    r.resolution_percentage = 100
    r.pixel_aspect_x = r.pixel_aspect_y = 1.0
    num, den = (int(x) for x in job['fps'].split('/'))
    r.fps, r.fps_base = num, float(den)
    scene.frame_start, scene.frame_end = 0, job['frames'] - 1
    r.motion_blur_position = 'START'
    r.use_compositing = r.use_sequencer = False
    r.use_file_extension = True
    r.use_overwrite = True
    settings = r.image_settings
    if hasattr(settings, 'media_type'):
        settings.media_type = 'MULTI_LAYER_IMAGE'
    settings.file_format = 'OPEN_EXR_MULTILAYER'
    settings.color_depth = '32'
    settings.exr_codec = 'ZIP'
    c.seed = job['seed'] & 0x7FFFFFFF
    c.use_animated_seed = False
    c.use_adaptive_sampling = False
    c.denoiser = 'OPENIMAGEDENOISE'

    spec = importlib.util.spec_from_file_location('beiming_shot_entry', job['entry'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    built = module.build(Ctx(job))

    if bpy.context.scene != scene:
        raise Fail(None, '入口文件切换了当前场景')
    r.engine = 'CYCLES'
    r.motion_blur_position = 'START'
    uncrop(r)
    if scene.camera is None or scene.camera.data.type != 'PERSP' or scene.camera.data.shift_x or scene.camera.data.shift_y:
        raise Fail(None, '入口文件必须把 scene.camera 设成不偏轴的透视相机')
    # 背景算不算进 A：对相机可见的背景算，没设背景或者背景对相机不可见时只算几何
    scene.render.film_transparent = scene.world is None or not scene.world.cycles_visibility.camera
    declared = built['entities']
    names = sorted((e['name'] for e in declared), key=lambda s: s.encode('utf-8'))
    if len(set(names)) != len(names):
        raise Fail(None, '入口文件交的实体名有重复')
    # 没有场景包：实体名按字节序排，从 1 起编号
    ids = {name: k + 1 for k, name in enumerate(names)}
    owner = {}
    for obj in scene.objects:
        obj.pass_index = 0
    for e in declared:
        for obj in e.get('objects', []):
            if obj.name in owner:
                raise Fail(None, '物体 %s 同时归了两个实体' % obj.name)
            owner[obj.name] = e['name']
            obj.pass_index = ids[e['name']]
    entities = [{'id': ids[e['name']], 'name': e['name'], 'class': e['class'], **({'role': e['role']} if e.get('role') else {})}
                for e in sorted(declared, key=lambda e: ids[e['name']])]
    for e in entities:
        # 一个实体占的物体：自己名下的，加名字以它的名字加 . 开头的实体名下的
        e['_objects'] = [o for o, n in owner.items() if n == e['name'] or n.startswith(e['name'] + '.')]
    aux = scene.copy()
    uncrop(aux.render)
    aux.cycles.device = 'CPU'
    aux.cycles.samples = 1
    aux.cycles.use_denoising = False
    aux.render.use_motion_blur = False
    # 盒形滤镜收到 0.01 像素：这 1 个样本落在像素中心，不靠采样序列的第一个点恰好在哪。
    # 本机量到 Cycles 只取 1 个样本时数据层本来就在像素中心，换别的滤镜读数不变；编号层是不是取像素中心由自检逐像素核对
    aux.cycles.pixel_filter_type, aux.cycles.filter_width = 'BOX', 0.01
    STATE.clear()
    STATE.update(entities=entities, frames=job['frames'], display=job['colorRef'] == 'display', aux=aux)
    return {'entities': [{k: e[k] for k in ('id', 'name', 'class')} for e in entities]}


def measure(scene, size):
    """量这一帧 sub = 0 的相机和实体。size 是这次输出的 [宽, 高]，像素。"""
    w, h = size
    scene.render.resolution_x, scene.render.resolution_y = size
    uncrop(scene.render)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    cam = scene.camera.evaluated_get(depsgraph)
    rot, pos = rigid(cam.matrix_world)
    frame = [np.array(v, dtype=np.float64) for v in cam.data.view_frame(scene=scene)]
    half_height = (max(v[1] for v in frame) - min(v[1] for v in frame)) / 2.0 / -frame[0][2]
    fov_y = 2.0 * math.atan(half_height)
    near, far = float(cam.data.clip_start), float(cam.data.clip_end)
    p6 = 1.0 / math.tan(fov_y / 2.0)
    p1 = p6 * h / w
    world = np.eye(4)
    world[:3, :3] = AXIS @ rot
    world[:3, 3] = AXIS @ pos
    camera = {
        'world': world.T.reshape(-1).tolist(),
        'proj': [p1, 0, 0, 0, 0, p6, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2.0 * far * near / (far - near), 0],
        'fovYDeg': math.degrees(fov_y), 'near': near, 'far': far,
    }
    dof = cam.data.dof
    if dof.use_dof:
        focus = float(dof.focus_distance)
        if dof.focus_object is not None:
            target = np.array(dof.focus_object.evaluated_get(depsgraph).matrix_world, dtype=np.float64)[:3, 3]
            focus = float(-((target - pos) @ rot)[2])
        camera.update(focusDist=focus, fstop=float(dof.aperture_fstop), sensorHeightM=2.0 * float(cam.data.lens) * half_height / 1000.0)

    points, tris = {}, 0
    for obj in scene.objects:
        ev = obj.evaluated_get(depsgraph)
        m = np.array(ev.matrix_world, dtype=np.float64)
        mesh = ev.to_mesh() if ev.type == 'MESH' else None
        if mesh is not None:
            local = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', local)
            local = local.reshape(-1, 3)
            if not obj.hide_render:
                tris += len(mesh.loop_triangles)
            ev.to_mesh_clear()
        else:
            local = np.array([list(v) for v in ev.bound_box], dtype=np.float64)
        points[obj.name] = local @ m[:3, :3].T + m[:3, 3]

    entities = []
    for e in STATE['entities']:
        out = {k: e[k] for k in ('id', 'name', 'class', 'role') if k in e}
        pts = np.concatenate([points[o] for o in e['_objects']]) if e['_objects'] else np.empty((0, 3))
        view = (pts - pos) @ rot
        depth = -view[:, 2]
        # shortcut: 跨过近裁剪面的实体只拿近裁剪面之前的顶点算屏幕包围盒，不做多边形裁剪；出现贴脸穿过相机的实体时换成逐三角形裁剪
        front = view[depth > near]
        if len(front):
            sx = (p1 * front[:, 0] / -front[:, 2] + 1.0) / 2.0 * w
            sy = (1.0 - p6 * front[:, 1] / -front[:, 2]) / 2.0 * h
            box = [float(sx.min()), float(sy.min()), float(sx.max()), float(sy.max())]
        else:
            box = [0.0, 0.0, 0.0, 0.0]
        out['bbox2d'] = box
        if len(pts):
            y_up = pts @ AXIS.T
            out['bbox3d'] = y_up.min(axis=0).tolist() + y_up.max(axis=0).tolist()
            out['depth'] = [float(depth.min()), float(depth.max())]
        out['visible'] = None
        ix = max(0.0, min(box[2], w) - max(box[0], 0.0))
        iy = max(0.0, min(box[3], h) - max(box[1], 0.0))
        out['pxArea'] = ix * iy / (w * h)
        entities.append(out)
    return camera, entities, tris, rot


def render_pass(scene, name, size, passes):
    """把 scene 照它现在的设置渲一遍，写成多层 EXR 再读回。返回 { 通道全名: 高 × 宽 的 float32 数组 }，行从上到下。"""
    import OpenImageIO as oiio
    r, layer = scene.render, scene.view_layers[0]
    r.resolution_x, r.resolution_y = size
    uncrop(r)
    layer.use_pass_combined = True
    layer.use_pass_z = 'depth' in passes
    layer.use_pass_object_index = 'objectId' in passes
    layer.use_pass_normal = 'normal' in passes
    path = os.path.join(SCRATCH, name)
    r.filepath = path
    bpy.ops.render.render(write_still=True, scene=scene.name)
    path += '.exr'
    if not os.path.exists(path):
        raise RuntimeError('渲染没有写出文件')
    channels = {}
    inp = oiio.ImageInput.open(path)
    try:
        sub = 0
        while inp.seek_subimage(sub, 0):
            spec = inp.spec()
            if (spec.width, spec.height) != (size[0], size[1]):
                raise RuntimeError('EXR 读回尺寸 %d×%d 与请求 %d×%d 不符' % (spec.width, spec.height, size[0], size[1]))
            part = spec.getattribute('name') or ''
            pixels = inp.read_image(sub, 0, 0, spec.nchannels, oiio.FLOAT)
            for i, ch in enumerate(spec.channelnames):
                channels[ch if ch.count('.') >= 2 or not part else part + '.' + ch] = pixels[:, :, i]
            sub += 1
    finally:
        inp.close()
        os.remove(path)
    return channels


# 编号层在 EXR 里的通道名随 Blender 版本不同：旧版叫 IndexOB，新版叫 Object Index
INDEX = ('IndexOB.X', 'Object Index.X')


def pick(channels, *suffixes):
    """按通道名的结尾取通道，叠成 高 × 宽 × 分量数。一项可以给几个候选名，必须正好命中一个通道。"""
    out = []
    for suffix in suffixes:
        names = (suffix,) if isinstance(suffix, str) else suffix
        hits = [v for k, v in channels.items() if any(k.endswith('.' + n) for n in names)]
        if len(hits) != 1:
            raise RuntimeError('EXR 里找不到唯一的通道 %s：%s' % (suffix, sorted(channels)))
        out.append(hits[0])
    return np.stack(out, axis=-1)


def write_layer(job, name, kind, components, array):
    data = np.ascontiguousarray(array.astype('<u4' if kind == 'u32' else '<f4')).tobytes()
    rel = '%s/%s.%s' % (job['dir'], name, kind)
    os.makedirs(os.path.join(job['workspace'], job['dir']), exist_ok=True)
    with open(os.path.join(job['workspace'], rel), 'wb') as f:
        f.write(data)
    return {'file': rel, 'shape': [array.shape[0], array.shape[1], len(components)], 'components': components, 'hash': 'sha256:' + hashlib.sha256(data).hexdigest()}


def owned(ids_image, entity):
    """这个实体在编号层里占的像素数：编号是它自己的，或者是名字以它的名字加 . 开头的实体的"""
    mine = [e['id'] for e in STATE['entities'] if e['name'] == entity['name'] or e['name'].startswith(entity['name'] + '.')]
    return int(np.isin(ids_image, mine).sum())


def op_render(job):
    scene = bpy.context.scene
    plan = job['plan']
    clock = time.perf_counter
    t0 = clock()
    aux_scene = STATE['aux']
    scene.frame_set(job['f'], subframe=0.0)
    aux_scene.frame_set(job['f'], subframe=0.0)
    camera, entities, tris, cam_rot = measure(scene, plan['size'])
    t1 = clock()
    result = {'camera': camera, 'entities': entities, 'layers': {}, 'stats': None, 'device': dict(DEVICE),
              'timing': {'stateMs': (t1 - t0) * 1000.0, 'renderMs': 0.0, 'readbackMs': 0.0}}
    if not plan['layers']:
        return result

    spent = {'render': 0.0}

    def timed(which, name, size, passes):
        start = clock()
        channels = render_pass(which, name, size, passes)
        spent['render'] += clock() - start
        return channels

    def sub0(name, size, passes):
        """辅助场景渲一遍：这一帧 sub = 0，针孔（渲的时候把景深关掉，渲完还原）"""
        dof = scene.camera.data.dof
        had = dof.use_dof
        dof.use_dof = False
        try:
            return timed(aux_scene, name, size, passes)
        finally:
            dof.use_dof = had

    r, c = scene.render, scene.cycles
    c.device = 'CPU' if DEVICE['backend'] == 'CPU' else 'GPU'
    c.samples = plan['samples']
    c.use_denoising = plan['denoise']
    denoise_on_gpu = plan['denoise'] and oidn_on_gpu()
    c.denoising_use_gpu = denoise_on_gpu
    r.use_motion_blur = plan['angleDeg'] > 0
    if r.use_motion_blur:
        r.motion_blur_shutter = plan['angleDeg'] / 360.0
    color = pick(timed(scene, 'color', plan['size'], ()), 'Combined.R', 'Combined.G', 'Combined.B', 'Combined.A')
    t2 = clock()
    if plan['denoise']:
        # 实际的降噪设备，写进元数据的 source.denoise：显卡跑得了 OIDN 就放在显卡上，否则在 CPU 上
        result['denoise'] = 'oidn-gpu' if denoise_on_gpu else 'oidn-cpu'
    result['layers']['color'] = write_layer(job, 'color', 'f32', ['R', 'G', 'B', 'A'], color)
    luma = np.maximum(color[:, :, :3].astype(np.float64) @ np.array([0.2126, 0.7152, 0.0722]), 0.0)
    p1, p50, p99 = (float(v) for v in np.percentile(luma, [1, 50, 99]))
    result['stats'] = {'luma': {'p1': p1, 'p50': p50, 'p99': p99}, 'noise': None, 'tris': tris}
    if STATE['display']:
        rgb = color[:, :, :3]
        result['stats']['clipHigh'] = float((rgb >= 1.0).any(axis=-1).mean())
        result['stats']['clipLow'] = float((rgb <= 0.0).all(axis=-1).mean())
    readback = clock() - t2

    aux = [n for n in plan['layers'] if n != 'color']
    if aux:
        channels = sub0('aux', plan['size'], aux)
        t3 = clock()
        if 'depth' in aux:
            result['layers']['depth'] = write_layer(job, 'depth', 'f32', ['Z'], pick(channels, 'Depth.Z'))
        if 'objectId' in aux:
            result['layers']['objectId'] = write_layer(job, 'objectId', 'u32', ['id'], np.rint(pick(channels, INDEX)))
        if 'normal' in aux:
            # Cycles 的法线层在 Blender 的世界坐标里，转到相机空间；相机的局部轴和北冥的相机坐标同向
            n = pick(channels, 'Normal.X', 'Normal.Y', 'Normal.Z').astype(np.float64) @ cam_rot
            length = np.linalg.norm(n, axis=-1, keepdims=True)
            result['layers']['normal'] = write_layer(job, 'normal', 'f32', ['X', 'Y', 'Z'], np.where(length > 0, n / np.maximum(length, 1e-30), 0.0))
        readback += clock() - t3

    roles = [e for e in STATE['entities'] if 'role' in e]
    if roles:
        quarter = [max(1, round(plan['size'][0] / 4)), max(1, round(plan['size'][1] / 4))]
        together = np.rint(pick(sub0('vis', quarter, ['objectId']), INDEX))
        hidden = {o.name: o.hide_render for o in scene.objects}
        try:
            for e in roles:
                for o in scene.objects:
                    o.hide_render = hidden[o.name] or (o.type not in ('CAMERA', 'LIGHT') and o.name not in e['_objects'])
                alone = owned(np.rint(pick(sub0('vis', quarter, ['objectId']), INDEX)), e)
                seen = owned(together, e)
                next(x for x in entities if x['id'] == e['id'])['visible'] = min(1.0, seen / alone) if alone else 0.0
        finally:
            for o in scene.objects:
                o.hide_render = hidden[o.name]

    result['timing']['renderMs'] = spent['render'] * 1000.0
    result['timing']['readbackMs'] = readback * 1000.0
    result['samples'] = plan['samples']
    return result


def op_close(_job):
    STATE.clear()
    reset()
    return {}


OPS = {'hello': op_hello, 'open': op_open, 'render': op_render, 'close': op_close}


def reply(message):
    IPC.write(json.dumps(message, ensure_ascii=False) + '\n')
    IPC.flush()


for line in sys.stdin:
    job = json.loads(line)
    if job['op'] == 'quit':
        break
    try:
        reply({'id': job['id'], 'ok': True, 'result': OPS[job['op']](job)})
    except Fail as e:
        reply({'id': job['id'], 'ok': False, 'code': e.code, 'message': str(e)})
    except Exception as e:  # noqa: BLE001
        reply({'id': job['id'], 'ok': False, 'code': None, 'message': '%s: %s' % (type(e).__name__, e)})
        if job['op'] == 'render':
            # 渲染失败（含显卡错误）：进程以非零退出码结束，不带着坏掉的渲染会话接着干
            os._exit(3)
