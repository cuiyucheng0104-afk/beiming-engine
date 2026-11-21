# 「卡加数据」模式的固定装载（卡的运行时接口契约 3.4 的六步）在 Blender 一侧的实现，和页面宿主的 host/page/runtime.js 同构。
# 分工：node 一侧（host.mjs）做装载之前的检查、解参数、解先后要求，并在求值核里跑数据层的卡（evaluate 形状，算 tracks）；
# 这里在常驻的 Blender 里跑第 1 到 4 步（assets → tracks → create → collect，每次装载一遍）和第 5、6 步（每帧写状态、并元数据）。
# tracks 的值是 node 一侧每帧现算好交过来的：出第 f 帧时交 f − 1、f、f + 1 三个整帧（sub = 0）的值，
# tracks.apply(t, sub) 只认这三个时刻，别的时刻报错，不猜。
# 口径同 worker.py：长度米；对外的坐标右手系 Y 向上，Blender 里的 (x, y, z) 是北冥的 (x, z, -y)；帧号是镜头局部帧号。
import importlib.util
import math
import re
import struct
import types

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

# Blender 的 (x, y, z) → 北冥的 (x, z, -y)
AXIS = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
TO_BLENDER = Matrix(AXIS.T.tolist())
# 既没有相机轨道、也没有相机类卡时宿主自己备的那台透视相机，和页面宿主相同：放在世界原点，朝 −Z，Y 向上；
# 竖直视场角 40 度，近裁剪面 0.1 米，远裁剪面 100 米。相机轨道写的那台相机用同样的裁剪面
HOST_CAMERA = {'fovYDeg': 40.0, 'nearM': 0.1, 'farM': 100.0}
META_KEYS = ('texts', 'anchors', 'readings')
CARD_ENTRIES = ('create', 'evaluate')
ENTITY_NAME = re.compile(r'^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$')
ARG = re.compile(r'^[^/\s]+/[^/\s]+$')
M32 = 0xFFFFFFFF


class Fail(Exception):
    """带错误码的失败；code 是 None 时不带码"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---------- 命名随机流：和 kernel/eval/rng.mjs 逐位相同（流名先 cyrb128 散列成四个 32 位状态，再用 sfc32 出数） ----------

def _imul(a, b):
    return (a * b) & M32


def stream_name(seed, shot_id, arg):
    """流名 = <镜头种子>/<镜头>/<用途>/<对象>"""
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > 4294967295:
        raise ValueError('镜头种子必须是 [0, 4294967295] 里的整数，给的是 %r' % (seed,))
    if not isinstance(arg, str) or not ARG.match(arg):
        raise ValueError('随机流的参数必须是 "<用途>/<对象>"，给的是 %r' % (arg,))
    return '%d/%s/%s' % (seed, shot_id, arg)


class Stream:
    """一条命名随机流：next() 返回 [0, 1) 里的数，u32() 返回 32 位无符号整数，name 只读"""
    __slots__ = ('_name', '_s')

    def __init__(self, name):
        h1, h2, h3, h4 = 1779033703, 3144134277, 1013904242, 2773480762
        units = name.encode('utf-16-le')
        for (k,) in struct.iter_unpack('<H', units):
            h1 = h2 ^ _imul(h1 ^ k, 597399067)
            h2 = h3 ^ _imul(h2 ^ k, 2869860233)
            h3 = h4 ^ _imul(h3 ^ k, 951274213)
            h4 = h1 ^ _imul(h4 ^ k, 2716044179)
        h1 = _imul(h3 ^ (h1 >> 18), 597399067)
        h2 = _imul(h4 ^ (h2 >> 22), 2869860233)
        h3 = _imul(h1 ^ (h3 >> 17), 951274213)
        h4 = _imul(h2 ^ (h4 >> 19), 2716044179)
        self._name = name
        self._s = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]

    @property
    def name(self):
        return self._name

    def u32(self):
        a, b, c, d = self._s
        t = (a + b + d) & M32
        d = (d + 1) & M32
        a = b ^ (b >> 9)
        b = (c + (c << 3)) & M32
        c = ((((c << 21) & M32) | (c >> 11)) + t) & M32
        self._s = [a, b, c, d]
        return t

    def next(self):
        return self.u32() / 4294967296.0


# ---------- 卡运行库里要在这一侧用的两样，和 cards/runtime.mjs 同算法 ----------

def create_order(names, pairs):
    """create 的排法（CR 契约 5.2）：每一步在「必须排在它前面的都已经排好」的实例里取书写顺序最靠前的"""
    stray = sorted({n for p in pairs for n in p if n not in names})
    if stray:
        raise Fail('contract.order-cycle', '卡的先后要求提到了这个镜头里没有的实例 %s' % '、'.join(stray))
    done, left = [], list(names)
    while left:
        nxt = next((n for n in left if all(later != n or first in done for first, later in pairs)), None)
        if nxt is None:
            raise Fail('contract.order-cycle', '卡的先后要求成环，排不出次序：%s' % '、'.join(left))
        done.append(nxt)
        left.remove(nxt)
    return done


def merge_entities(prefix, entities):
    """Handle.entities 并进镜头时的名字（CR 契约 5.4）：相对名前面加 <as>.，带 root 的那个就叫实例名"""
    rows = []
    for rel, v in (entities or {}).items():
        root = isinstance(v, dict) and v.get('root') is True
        rows.append({'rel': rel, 'root': root, 'object': v['object'] if root else v, 'name': prefix if root else '%s.%s' % (prefix, rel)})
    if sum(r['root'] for r in rows) > 1:
        raise ValueError('卡实例 %s 的 Handle.entities 里带 root 的实体多于一个' % prefix)
    odd = [r['name'] for r in rows if not ENTITY_NAME.match(r['name'])]
    if odd:
        raise ValueError('卡实例 %s 带进来的实体名 %s 不合实体名的写法' % (prefix, '、'.join(odd)))
    return rows


def merge_meta(prefix, extra):
    """Handle.meta(f) 的返回值并进镜头：读数的名字前面加 <as>.。Blender 宿主不交文字框（能力声明 metaNull 列了 texts），也还没接锚点"""
    stray = [k for k in extra if k not in META_KEYS]
    if stray:
        raise ValueError('卡实例 %s 的 meta(f) 交了不许交的键：%s' % (prefix, '、'.join(stray)))
    if extra.get('texts') or extra.get('anchors'):
        raise ValueError('卡实例 %s 的 meta(f) 交了文字框或锚点，Blender 宿主还没接' % prefix)
    readings = extra.get('readings') or {}
    for k, v in readings.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float('inf'), float('-inf')):
            raise ValueError('卡实例 %s 的读数 %s 不是有限的数' % (prefix, k))
    ids = list(readings)
    return {'readings': {'%s.%s' % (prefix, k): float(readings[k]) for k in ids}, 'ids': ids, 'merged': ['%s.%s' % (prefix, k) for k in ids]}


# ---------- 数据轨道 ----------

class Tracks:
    """求值核算好的轨道。有相机轨道时带 camera（一台 Blender 透视相机），objects 是 apply 写的那几个物体"""

    def __init__(self, scene, has_camera):
        self.samples = {}
        self.objects = ()
        if has_camera:
            data = bpy.data.cameras.new('tracks.camera')
            data.sensor_fit = 'VERTICAL'
            data.clip_start, data.clip_end = HOST_CAMERA['nearM'], HOST_CAMERA['farM']
            cam = bpy.data.objects.new('tracks.camera', data)
            cam.rotation_mode = 'QUATERNION'
            scene.collection.objects.link(cam)
            self.camera = cam
            self.objects = (cam,)

    def apply(self, f, sub):
        """把 (f, sub) 这一时刻的轨道值写进场景。相机轨道的一段：pos 米、quat [x, y, z, w]（相机到世界）、fovDeg 竖直视场角，都在北冥坐标里"""
        if not self.objects:
            return
        key = (int(f), float(sub))
        if key not in self.samples:
            raise ValueError('tracks 没有第 %r 帧 sub = %r 的值：帧源每帧只交 f − 1、f、f + 1 三个整帧' % (f, sub))
        seg = self.samples[key]['camera']
        x, y, z, w = seg['quat']
        rot = TO_BLENDER @ Quaternion((w, x, y, z)).to_matrix()
        cam = self.camera
        cam.location = TO_BLENDER @ Vector(seg['pos'])
        cam.rotation_quaternion = rot.to_quaternion()
        cam.data.angle_y = math.radians(seg['fovDeg'])


# ---------- 交给卡的 ctx 和固定装载 ----------

class CardCtx:
    """交给卡的 create(ctx, params) 的 ctx（镜头契约 3.2）：Blender 帧源带 bpy 和 hostScene，没有 scene、THREE、renderer"""

    def __init__(self, job, scene, tracks, use, assets):
        shot = job['shot']
        self.tracks = tracks
        self.cards = types.SimpleNamespace(use=use)
        self.params = dict(job.get('params') or {})
        self.seed = job['seed']
        self.assets = types.SimpleNamespace(load=assets)
        self.tokens = dict(job.get('tokens') or {})
        self.size = list(job['size'])
        self.fps = job['fps']
        self.frames = job['frames']
        self.shot = types.MappingProxyType({'id': shot['id'], 'in': shot['in'], 'frames': job['frames']})
        # 每个命名条目一项，值是它的全片帧号减这个镜头的起始帧：可以是负数，也可以不小于镜头帧数
        self.events = types.MappingProxyType(dict(job.get('events') or {}))
        self.bpy = bpy
        self.hostScene = scene

    def rng(self, arg):
        return Stream(stream_name(self.seed, self.shot['id'], arg))

    @staticmethod
    def anchor(entity, name):
        raise ValueError('没有锚点 %s#%s' % (entity, name))


def _module(entry, use):
    """装一张卡的实现文件；对外必须正好一个卡入口，就是卡文件声明的形状（CR1）"""
    spec = importlib.util.spec_from_file_location('beiming_card_%s' % re.sub(r'\W', '_', use), entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Loaded:
    """一次固定装载的结果：第 1 到 4 步在构造时跑完，第 5 步 state(f, sub)，第 6 步 meta(f)"""

    def __init__(self, job, scene, load_asset):
        self.job, self.scene = job, scene
        # 这次装载里宿主自己记的账：做了哪几步、create 的次序、每帧写状态和并元数据的次序、相机从哪来，每个卡实例是谁调的、
        # Handle 上有什么、并进镜头之后叫什么。经每帧元数据的 ext["blender.load"] 交出去
        self.account = {'cards': []}
        self.instances = [dict(i, row={'as': i['as'], 'card': i['use'], 'impl': i['impl'], 'shape': i['shape']}) for i in job['instances']]
        self.loaded_assets = {}
        self._load_asset = load_asset
        self.made = []

    def _asset(self, ref):
        """ctx.assets.load：镜头条目的资产在第 1 步已经载好，交回同一份；只在全片 assets 里的这时再载，零件不进 entities"""
        if ref not in self.loaded_assets:
            hit = next((a for a in self.job['assets'] if a['ref'] == ref), None)
            if hit is None:
                raise ValueError('资产 %s 不在这个镜头能用的资产里（镜头条目的 assets 加全片的 assets）' % ref)
            parts = self._load_asset(hit['path'], hit['kind'], hit['alias'], self.scene)
            self.loaded_assets[ref] = {'alias': hit['alias'], 'parts': parts}
        got = self.loaded_assets[ref]
        return types.SimpleNamespace(by_name={'%s.%s' % (got['alias'], k): v for k, v in got['parts'].items()})

    def _create(self, inst, ctx):
        """调一张 create 形状的卡，交回 Handle；实体名加上实例前缀，记进账里"""
        module = _module(inst['entry'], inst['use'])
        entries = [k for k in CARD_ENTRIES if callable(getattr(module, k, None))]
        if entries != [inst['shape']]:
            raise ValueError('卡 %s 的实现对外的卡入口是 %s，卡文件声明的是 %s' % (inst['use'], '、'.join(entries) or '没有', inst['shape']))
        handle = module.create(ctx, dict(inst['params']))
        if not isinstance(handle, dict) or not callable(handle.get('dispose')):
            raise ValueError('卡 %s 的 create 交回的 Handle 没有 dispose()' % inst['use'])
        inst['handle'] = handle
        inst['merged'] = merge_entities(inst['as'], handle.get('entities'))
        inst['row'].update(calledVia='cards.use', members=list(handle), entities=[m['rel'] for m in inst['merged']],
                           roots=[m['rel'] for m in inst['merged'] if m['root']], merged=[m['name'] for m in inst['merged']])
        self.account['cards'].append(inst['row'])
        return handle

    def _use(self, ctx_ref):
        """ctx.cards.use：as 必须是这个镜头 cards 里声明过的实例名，runtime 的键不得和卡声明的参数同名（镜头契约 S9）"""
        def use(name, **runtime):
            inst = next((i for i in self.instances if i['as'] == name and not i['overlay']), None)
            if inst is None:
                raise Fail('contract.undeclared-card', '镜头 %s 没有声明卡实例 %s' % (self.job['shot']['id'], name))
            shadow = [k for k in runtime if k in inst['paramNames']]
            if shadow:
                raise Fail('contract.runtime-shadows-param', 'ctx.cards.use(%s) 的 runtime 里的 %s 和卡 %s 声明的参数同名' % (name, '、'.join(shadow), inst['use']))
            if inst['shape'] != 'create':
                raise ValueError('卡实例 %s 是 evaluate 形状，由 tracks 求值，不经 ctx.cards.use' % name)
            if runtime:
                # shortcut: runtime 怎么交到 create 契约还没定，带了东西来就报错，不丢掉照常装；定了以后在这里交过去
                raise ValueError('ctx.cards.use(%s) 带了 runtime（%s），怎么交到 create 契约还没定，Blender 宿主不接' % (name, '、'.join(runtime)))
            return inst.get('handle') or self._create(inst, ctx_ref[0])
        return use

    def build(self):
        """第 1 到 4 步。交回 { camera, entities: [{ name, class, role?, objects }] }"""
        job, scene, account = self.job, self.scene, self.account
        steps, created = [], []
        account.update(steps=steps, orderPairs=[list(p) for p in job['pairs']], createOrder=created)
        declared = []
        # 第 1 步：镜头条目的资产。别名是装配体，零件各是一个实体 <别名>.<零件名>
        for a in (x for x in job['assets'] if x['shot']):
            parts = self._load_asset(a['path'], a['kind'], a['alias'], scene)
            self.loaded_assets[a['ref']] = {'alias': a['alias'], 'parts': parts}
            declared.append({'name': a['alias'], 'class': 'assembly', 'objects': []})
            declared += [{'name': '%s.%s' % (a['alias'], k), 'class': 'part', 'objects': [v]} for k, v in parts.items()]
        steps.append('assets')

        # 第 2 步：tracks。evaluate 形状的卡在 node 一侧的求值核里跑，这里只记账；有产出相机轨道的卡时备一台相机
        data = [i for i in self.instances if i['shape'] == 'evaluate']
        self.tracks = Tracks(scene, bool(job['tracksCamera']))
        for i in data:
            i['row']['calledVia'] = 'tracks'
            account['cards'].append(i['row'])
        steps.append('tracks')

        # 第 3 步：create，照 ports.order 排；叠加层展开出的实例装在镜头自己的卡之后。evaluate 形状的轮到时只记次序
        own = [i['as'] for i in self.instances if not i['overlay']]
        order = create_order(own, [tuple(p) for p in job['pairs']]) + [i['as'] for i in self.instances if i['overlay']]
        ctx_ref = [None]
        ctx = CardCtx(job, scene, self.tracks, self._use(ctx_ref), self._asset)
        ctx_ref[0] = ctx
        for name in order:
            inst = next(i for i in self.instances if i['as'] == name)
            if inst['shape'] == 'create' and 'handle' not in inst:
                self._create(inst, ctx)
            created.append(name)
        steps.append('create')

        # 第 4 步：collect。相机取 tracks.camera，没有就取相机类卡交出的相机，再没有用宿主备的那台
        self.made = [i for i in (next(x for x in self.instances if x['as'] == n) for n in order) if 'handle' in i]
        cam_cards = [i for i in self.made if i['kind'] == 'camera' and getattr(i['handle'].get('object'), 'type', None) == 'CAMERA']
        has_tracks_cam = bool(self.tracks.objects)
        if not has_tracks_cam and len(cam_cards) > 1:
            raise ValueError('镜头 %s 有 %d 张相机类卡，取哪一张契约还没定' % (job['shot']['id'], len(cam_cards)))
        if has_tracks_cam:
            camera = self.tracks.camera
        elif cam_cards:
            camera = cam_cards[0]['handle']['object']
        else:
            camera = self._host_camera()
        if has_tracks_cam or cam_cards:
            account['camera'] = {'tracksHasCamera': has_tracks_cam, 'from': 'tracks' if has_tracks_cam else 'card'}
        scene.camera = camera
        for inst in self.made:
            for m in inst['merged']:
                objs = [m['object']] if m['object'] is not None else []
                declared.append({'name': m['name'], 'class': 'part', 'objects': objs})
        names = [d['name'] for d in declared]
        dup = sorted({n for n in names if names.count(n) > 1})
        if dup:
            raise ValueError('实体名 %s 重复' % '、'.join(dup))
        roles = job.get('roles') or {}
        for d in declared:
            if roles.get('hero') == d['name']:
                d['role'] = 'hero'
            elif d['name'] in (roles.get('mustSee') or []):
                d['role'] = 'mustSee'
        steps.append('collect')

        self.appliers = [i for i in self.made if callable(i['handle'].get('apply'))]
        self.reporters = [i for i in self.made if callable(i['handle'].get('meta'))]
        account.update(applyOrder=['tracks'] + [i['as'] for i in self.appliers], metaOrder=['host'] + [i['as'] for i in self.reporters])
        return {'camera': camera, 'entities': declared}

    def _host_camera(self):
        data = bpy.data.cameras.new('host.camera')
        data.sensor_fit = 'VERTICAL'
        data.angle_y = math.radians(HOST_CAMERA['fovYDeg'])
        data.clip_start, data.clip_end = HOST_CAMERA['nearM'], HOST_CAMERA['farM']
        cam = bpy.data.objects.new('host.camera', data)
        cam.rotation_mode = 'QUATERNION'
        cam.rotation_quaternion = TO_BLENDER.to_quaternion()
        self.scene.collection.objects.link(cam)
        return cam

    def state(self, f, sub, samples):
        """第 5 步：先 tracks.apply(f, sub)，再按 create 的次序调各张卡的 apply(f, sub)。samples 是这一帧交过来的轨道值"""
        self.tracks.samples = samples
        self.tracks.apply(f, sub)
        for i in self.appliers:
            i['handle']['apply'](f, sub)

    def meta(self, f):
        """第 6 步：宿主量完之后按 create 的次序并进各张卡的 meta(f)。交回 { readings }"""
        readings = {}
        for i in self.reporters:
            m = merge_meta(i['as'], i['handle']['meta'](f) or {})
            readings.update(m['readings'])
            i['row'].update(metaIds=m['ids'], mergedMetaIds=m['merged'])
        return readings

    def dispose(self):
        for i in self.made:
            i['handle']['dispose']()
