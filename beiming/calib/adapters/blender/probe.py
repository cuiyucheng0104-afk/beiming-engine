# 一次性探针适配器：用 Blender Cycles（无窗口）把六个校准场景照规格各搭一遍、各渲两遍，读回多层 EXR，
# 和 scene.json 的标准答案比，写探针表的 Blender 一列。用完即删，不是产品代码。
# 用法（仓库根目录）：python3 beiming/calib/adapters/blender/probe.py <Blender 可执行文件>
# 同一个文件两种身份：系统 python 里是调度方；Blender 里（-- render / -- analyze）是渲染方和读回方。
import hashlib, json, math, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
CALIB = os.path.join(ROOT, 'beiming', 'calib')
OUT = os.path.join(ROOT, 'out', 'probe', 'blender')
SCENES = sorted(d for d in os.listdir(CALIB) if os.path.isfile(os.path.join(CALIB, d, 'scene.json')))
SAMPLES, RUNS = 64, 2
LOOK = 'AgX - Medium High Contrast'
AGX_EV = (-12.47393, 12.5260688)  # Blender 配置里 AgX Log 的 lg2 分配范围（相对 0.18，共 25 档），整形曲线用它
ROW_OF = {'probe-gray-chart': '颜色层的线性度', 'probe-plane-steps': '深度口径', 'probe-thin-geometry': '编号层的边缘', 'probe-axes-turntable': '坐标与相机', 'probe-moving-cube': '时间键', 'probe-occlusion': '可见比例的成本'}

def load(name): return json.load(open(os.path.join(CALIB, name, 'scene.json'), encoding='utf8'))

def jobs(s):  # 要渲的 (帧, 子帧, 快门位置)；快门位置 None 表示不开运动模糊
    out = {(0, 0.0, None)}
    for e in (e for e in s['expected'] if 'atFrame' in e):
        if e.get('sampleAt') == 'shutterMid':
            mid = s['camera']['shutterAngleDeg'] / 360 / 2; out |= {(e['atFrame'], 0.0, None), (e['atFrame'], mid, None), (e['atFrame'], 0.0, 'START'), (e['atFrame'], 0.0, 'CENTER')}
        else: out.add((e['atFrame'], float(e['subFrameRatio']) if 'subFrameRatio' in e else 0.0, None))
    return sorted(out, key=lambda j: (j[0], j[1], j[2] or ''))

def tag(j): return f'f{j[0]:04d}s{round(j[1] * 100):02d}' + (f'-blur-{j[2].lower()}' if j[2] else '')

# ---------------- 调度方（系统 python，只用标准库） ----------------
def drive(blender):
    # 读时钟只为填「耗时」一行：集成负责人准了这个口子（一次性探针，用完即删，计时不进确定性比较）
    def blend(*args):
        t0 = time.perf_counter(); subprocess.run([blender, '-b', '--factory-startup', '--python', __file__, '--', *args], check=True, stdout=subprocess.DEVNULL)
        return (time.perf_counter() - t0) * 1000
    proc = {'coldStartMs': [blend('noop') for _ in range(2)]}
    for name in SCENES:
        s = load(name)
        for j in jobs(s):  # 规格编号图：每个渲染时刻一张（开运动模糊的取 sub = 0）
            p = os.path.join(OUT, name, f'spec-{tag(j)}.bin'); os.makedirs(os.path.dirname(p), exist_ok=True)
            subprocess.run(['node', os.path.join(HERE, 'specmask.mjs'), os.path.join(CALIB, name, 'scene.json'), p, str(j[0] + j[1])], check=True)
        for run in range(1, RUNS + 1): proc[f'{name}/run{run}'] = blend('render', name, str(run))
    with open(os.path.join(OUT, 'process-ms.json'), 'w') as f: json.dump(proc, f, indent=1)
    blend('analyze')

if __name__ == '__main__' and 'bpy' not in sys.modules:
    drive(sys.argv[1]); sys.exit(0)

# ---------------- Blender 里 ----------------
import bpy, bmesh, numpy as np, OpenImageIO as oiio; from mathutils import Matrix, Vector; from bpy_extras.object_utils import world_to_camera_view

C3 = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)  # 规格 (x, y, z) → Blender (x, −z, y)；读回用转置 (x, z, −y)

def mat4(R, T): m = np.eye(4); m[:3, :3] = R; m[:3, 3] = T; return Matrix(m.tolist())

def axis_angle(axis, ang):
    a = np.array(axis, float) / np.linalg.norm(axis); K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K

def obj_transform(o, t):  # 同 check.mjs：R = R运动 · R静态
    rs = axis_angle(o['rotation']['axisDir'], o['rotation']['angleRad']) if 'rotation' in o else np.eye(3)
    m, p = o.get('motion'), np.array(o['positionM'], float)
    if m and m['kind'] == 'spin':
        rm = axis_angle(m['axisDir'], m['angularVelocityRadPerFrame'] * t); pv = np.array(m['pivotM'], float)
        return rm @ rs, rm @ (p - pv) + pv
    if m and m['kind'] == 'linear': return rs, p + np.array(m['velocityMPerFrame']) * t
    return rs, p

def cam_basis(c):
    pos = np.array(c['positionM'], float); fwd = np.array(c['lookAtM']) - pos; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, c['upDir']); right /= np.linalg.norm(right)
    return pos, fwd, right, np.cross(right, fwd), (c['heightPx'] / 2) / math.tan(math.radians(c['yFovDeg']) / 2)

def project(c, p):
    pos, fwd, right, up, f = cam_basis(c); d = np.asarray(p) - pos; z = d @ fwd
    return np.array([c['widthPx'] / 2 + f * (d @ right) / z, c['heightPx'] / 2 - f * (d @ up) / z])

def fcurves(idb, path, keys):  # 两个关键帧、线性插值、线性外推：任意子帧都是精确的匀速
    idb.animation_data_create(); act = bpy.data.actions.new(idb.name); idb.animation_data.action = act
    for i, (v0, v1) in keys.items():
        fc = act.fcurve_ensure_for_datablock(idb, path, index=i)
        for fr, v in ((0, v0), (1, v1)): fc.keyframe_points.insert(fr, v).interpolation = 'LINEAR'
        fc.extrapolation = 'LINEAR'

def mesh(o):
    bm = bmesh.new(); sh = o['shape']
    if sh == 'box': bmesh.ops.create_cube(bm, size=1); bmesh.ops.scale(bm, vec=o['sizeM'], verts=bm.verts)
    elif sh == 'plane':
        x, y = o['sizeM'][0] / 2, o['sizeM'][1] / 2; bm.faces.new([bm.verts.new(v) for v in ((-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0))])
    elif sh == 'sphere': bmesh.ops.create_uvsphere(bm, u_segments=128, v_segments=64, radius=o['radiusM'])
    else:  # 圆柱轴沿局部 Y：bmesh 的圆锥轴沿 Z，绕 X 转 −90 度
        bmesh.ops.create_cone(bm, cap_ends=True, segments=128, radius1=o['radiusM'], radius2=o['radiusM'], depth=o['heightM'])
        bmesh.ops.rotate(bm, verts=bm.verts, matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'))
    me = bpy.data.meshes.new(o['id']); bm.to_mesh(me); bm.free(); return me

def build(s):
    sc = bpy.context.scene
    for ob in list(bpy.data.objects): bpy.data.objects.remove(ob)
    c, r, cy = s['camera'], sc.render, sc.cycles
    r.engine, r.resolution_x, r.resolution_y, r.resolution_percentage, r.fps = 'CYCLES', c['widthPx'], c['heightPx'], 100, s['frameRateFps']
    sc.frame_start, sc.frame_end = 0, s['frameRange']['endFrame']
    cy.device, cy.samples, cy.use_adaptive_sampling, cy.use_denoising, cy.seed, cy.use_animated_seed = 'CPU', SAMPLES, False, False, 0, False
    sc.view_settings.view_transform, sc.view_settings.look, sc.view_settings.exposure, sc.view_settings.gamma = 'Standard', 'None', 0, 1
    im = r.image_settings; im.media_type = 'MULTI_LAYER_IMAGE'; im.file_format, im.color_depth, im.exr_codec = 'OPEN_EXR_MULTILAYER', '32', 'ZIP'
    vl = sc.view_layers[0]; vl.use_pass_z = vl.use_pass_object_index = vl.use_pass_position = True
    w = sc.world or bpy.data.worlds.new('w'); sc.world = w
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND'); bg.inputs[0].default_value = (*s['backgroundLinear'], 1); bg.inputs[1].default_value = 1
    pos, fwd, right, up, _ = cam_basis(c)
    cd = bpy.data.cameras.new('cam'); cd.sensor_fit, cd.sensor_height = 'VERTICAL', 24  # 竖直适配：视场角按竖直方向算
    cd.lens = 12 / math.tan(math.radians(c['yFovDeg']) / 2); cd.clip_start, cd.clip_end = c['nearM'], c['farM']
    cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cam.matrix_world = mat4(C3 @ np.column_stack([right, up, -fwd]), C3 @ pos)
    objs = {}
    for o in s['objects']:
        mat = bpy.data.materials.new(o['id']); mat.use_nodes = True; nt = mat.node_tree; nt.nodes.clear()
        em, mo = nt.nodes.new('ShaderNodeEmission'), nt.nodes.new('ShaderNodeOutputMaterial')
        em.inputs[0].default_value = (*o['emissionLinear'], 1); em.inputs[1].default_value = 1; nt.links.new(em.outputs[0], mo.inputs[0])
        me = mesh(o); me.materials.append(mat)
        ob = bpy.data.objects.new(o['id'], me); ob.pass_index = o['idIndex']; sc.collection.objects.link(ob); objs[o['id']] = ob
        rs, p = obj_transform({k: v for k, v in o.items() if k != 'motion'}, 0)
        m = o.get('motion')
        if m and m['kind'] == 'spin':  # 父空物体在枢轴上绕轴转，子物体带静态旋转：世界 = R运动 · R静态
            pv = np.array(m['pivotM'], float); e = bpy.data.objects.new(o['id'] + '-pivot', None); sc.collection.objects.link(e)
            e.location, e.rotation_mode, e.rotation_axis_angle = Vector(C3 @ pv), 'AXIS_ANGLE', (0, *(C3 @ (np.array(m['axisDir']) / np.linalg.norm(m['axisDir']))))
            fcurves(e, 'rotation_axis_angle', {0: (0, m['angularVelocityRadPerFrame'])})
            ob.parent = e; ob.matrix_parent_inverse = Matrix.Identity(4); ob.matrix_basis = mat4(C3 @ rs, C3 @ (p - pv))
        else:
            ob.matrix_basis = mat4(C3 @ rs, C3 @ p)
            if m: fcurves(ob, 'location', {i: (ob.location[i], ob.location[i] + v) for i, v in enumerate(C3 @ np.array(m['velocityMPerFrame']))})
    return sc, cam, objs

def render(name, run):
    s = load(name); sc, cam, objs = build(s); d = os.path.join(OUT, name, f'run{run}'); os.makedirs(d, exist_ok=True)
    info = {'version': bpy.app.version_string, 'renderMs': {}, 'evals': {}, 'quarterMs': {}}
    def shot(path):
        # 读时钟只为填「耗时」一行：集成负责人准了这个口子（一次性探针，用完即删，计时不进确定性比较）
        sc.render.filepath = path; t0 = time.perf_counter(); bpy.ops.render.render(write_still=True); return (time.perf_counter() - t0) * 1000
    for j in jobs(s):
        sc.render.use_motion_blur = bool(j[2])
        if j[2]: sc.render.motion_blur_position, sc.render.motion_blur_shutter = j[2], s['camera']['shutterAngleDeg'] / 360
        sc.frame_set(j[0], subframe=j[1]); info['renderMs'][tag(j)] = shot(os.path.join(d, tag(j) + '.exr'))
    # 开模糊（START）那张换种子 7 再渲一张，给时间键一行看编号层的取样时刻随不随种子变；不计进 renderMs
    for j in [j for j in jobs(s) if j[2] == 'START']: sc.render.use_motion_blur, sc.render.motion_blur_position, sc.render.motion_blur_shutter, sc.cycles.seed = True, 'START', s['camera']['shutterAngleDeg'] / 360, 7; sc.frame_set(j[0], subframe=j[1]); shot(os.path.join(d, tag(j) + '-seed7.exr'))
    sc.render.use_motion_blur, sc.cycles.seed = False, 0
    for i, e in enumerate(s['expected']):  # 求值读数：Blender 自己的依赖图在 t 时刻的变换，加 Blender 相机的投影
        if e['kind'] != 'projectPoint': continue
        sub = s['camera']['shutterAngleDeg'] / 720 if e.get('sampleAt') else e['subFrameRatio']
        sc.frame_set(e['atFrame'], subframe=sub); dg = bpy.context.evaluated_depsgraph_get()
        pw = objs[e['objectId']].evaluated_get(dg).matrix_world @ Vector(e['localPointM'])
        q = world_to_camera_view(sc, cam, pw); info['evals'][str(i)] = [q.x * sc.render.resolution_x, (1 - q.y) * sc.render.resolution_y]
    if name == 'probe-gray-chart':  # 显示变换：同一次渲染，用场景的色彩管理存一张 AgX 显示图
        rr = next(i for i in bpy.data.images if i.type == 'RENDER_RESULT')
        sc.view_settings.view_transform, sc.view_settings.look = 'AgX', LOOK
        im = sc.render.image_settings; im.media_type = 'IMAGE'; im.file_format, im.color_depth = 'PNG', '16'
        rr.save_render(os.path.join(d, 'agx-mhc.png'), scene=sc)
    if name == 'probe-occlusion':  # 可见比例的成本：四分之一分辨率、1 采样的编号层，合渲一遍、每个实体单独各一遍
        sc.frame_set(0); sc.render.resolution_percentage, sc.cycles.samples = 25, 1; info['quarterMs']['all'] = shot(os.path.join(d, 'q-all.exr'))
        for oid, ob in objs.items():
            for o2 in objs.values(): o2.hide_render = o2 is not ob
            info['quarterMs'][oid] = shot(os.path.join(d, f'q-{oid}.exr'))
    with open(os.path.join(d, 'info.json'), 'w') as f: json.dump(info, f, indent=1)

# ---------------- 读回 ----------------
def read_exr(path):  # Blender 5.2 的多层 EXR 是多部分文件：每个通道层一个子图
    inp, layers, k = oiio.ImageInput.open(path), {}, 0
    while inp.seek_subimage(k, 0):
        spec = inp.spec(); px = inp.read_image(k, 0, 0, spec.nchannels, 'float')
        for c, ch in enumerate(spec.channelnames): layers.setdefault(ch.split('.')[-2], []).append(px[:, :, c])
        k += 1
    inp.close(); return {n: np.stack(v, -1) for n, v in layers.items()}

def lum_centroid(img):
    y = img['Combined'][:, :, :3] @ [0.2126, 0.7152, 0.0722]; jj, ii = np.indices(y.shape)
    return np.array([(y * (ii + .5)).sum(), (y * (jj + .5)).sum()]) / y.sum()

def centroid(mask):
    jj, ii = np.nonzero(mask); return np.array([ii.mean() + .5, jj.mean() + .5]) if len(ii) else np.array([np.nan, np.nan])

def box_iou(a0, a1, b0, b1):
    inter = np.prod(np.clip(np.minimum(a1, b1) - np.maximum(a0, b0), 0, None))
    return inter / (np.prod(np.subtract(a1, a0)) + np.prod(np.subtract(b1, b0)) - inter)

def id_box(mask):
    jj, ii = np.nonzero(mask); return [ii.min(), jj.min()], [ii.max() + 1, jj.max() + 1]

def R(scene, what, exp, got, diff, unit): return {'scene': scene, 'what': what, 'expected': exp, 'got': got, 'diff': diff, 'unit': unit}
def rnd(x, n=6): return [rnd(v, n) for v in x] if isinstance(x, (list, tuple, np.ndarray)) else round(float(x), n)

def analyze():
    rows = {k: [] for k in ['颜色层的线性度', '显示变换', '深度口径', '编号层的边缘', '坐标与相机', '时间键', '快门相位', '子帧累积和后期的先后', '显示变换的整形曲线', '可见比例的成本', '确定性', '耗时']}
    proc, timing = json.load(open(os.path.join(OUT, 'process-ms.json'))), []
    for name in SCENES:
        s = load(name); c = s['camera']; W, H = c['widthPx'], c['heightPx']; row = rows[ROW_OF[name]]
        d1 = os.path.join(OUT, name, 'run1'); info = json.load(open(os.path.join(d1, 'info.json'))); version = info['version']
        # 读时钟只为填「耗时」一行：集成负责人准了这个口子（一次性探针，用完即删，计时不进确定性比较）
        t0 = time.perf_counter(); img = {tag(j): read_exr(os.path.join(d1, tag(j) + '.exr')) for j in jobs(s)}
        timing.append(R(name, '读回一张多层 EXR（平均）', '无标准答案', rnd((time.perf_counter() - t0) * 1000 / len(img), 1), '无', 'ms'))
        timing.append(R(name, '单帧渲染（进程内，平均）', '无标准答案', rnd(np.mean(list(info['renderMs'].values())), 1), '无', 'ms'))
        timing.append(R(name, f'整个进程（{len(img)} 帧，两遍）', '无标准答案', rnd([proc[f'{name}/run{k}'] for k in (1, 2)], 1), '无', 'ms'))
        spec = {t: np.fromfile(os.path.join(OUT, name, f'spec-{t}.bin'), np.uint8).reshape(H, W) for t in img}
        byidx = {o['idIndex']: o['id'] for o in s['objects']}; objs = {o['id']: o for o in s['objects']}
        ident = lambda t: np.rint(img[t]['Object Index'][:, :, 0]).astype(int)
        for i, e in enumerate(s['expected']):
            if 'pixelPx' in e and e['kind'] == 'projectPoint':  # 自测：Python 版投影和检查器重算一致
                sub = c['shutterAngleDeg'] / 720 if e.get('sampleAt') else e['subFrameRatio']
                Rm, T = obj_transform(objs[e['objectId']], e['atFrame'] + sub)
                assert np.allclose(project(c, Rm @ e['localPointM'] + T), e['pixelPx'], atol=1e-4), (name, i)
            k = e['kind']
            if k == 'pixelHits':
                t = tag((e['atFrame'], 0.0, None)); ii, jj = (int(math.floor(v)) for v in e['pixelPx'])
                gid, z = byidx.get(int(ident(t)[jj, ii]), '背景'), float(img[t]['Depth'][jj, ii, 0]); h = e['hits'][0] if e['hits'] else None
                row.append(R(name, f'像素 {e["pixelPx"]} 第一命中', h['objectId'] if h else '背景', gid, '一致' if gid == (h['objectId'] if h else '背景') else '不一致', 'objectId'))
                if h:
                    row.append(R(name, f'像素 {e["pixelPx"]} 深度层 vs 平面深度', h['planeDepthM'], rnd(z), rnd(z - h['planeDepthM']), 'm'))
                    if name == 'probe-plane-steps': row.append(R(name, f'像素 {e["pixelPx"]} 深度层 vs 射线距离', h['rayDistanceM'], rnd(z), rnd(z - h['rayDistanceM']), 'm'))
                else: row.append(R(name, f'像素 {e["pixelPx"]} 背景深度层读数', '无交点', rnd(z, 1), '无', 'm'))
            elif k == 'patchColor':
                ii, jj = (int(math.floor(v)) for v in e['pixelPx']); g = img['f0000s00']['Combined'][jj, ii, :3]
                row.append(R(name, f'{e["objectId"]} 中心像素颜色', e['valueLinear'], rnd(g), rnd(np.abs(g - e['valueLinear']).max(), 7), 'linear'))
            elif k == 'projectPoint':
                ev = info['evals'][str(i)]; lab = f'{e["objectId"]} 局部点 {e["localPointM"]} 第 {e["atFrame"]} 帧'
                if e.get('sampleAt'):  # 快门相位：拖影的亮度重心对照帧起点、+1/4 帧两张不开模糊的渲染
                    f0, fm = tag((e['atFrame'], 0.0, None)), tag((e['atFrame'], e['subFrameRatio'], None))
                    pxf = (lum_centroid(img[fm]) - lum_centroid(img[f0]))[0] / e['subFrameRatio']
                    for pos in ('start', 'center'):
                        b = f'{f0}-blur-{pos}'; got = np.array(e['pixelPx']) + lum_centroid(img[b]) - lum_centroid(img[fm])
                        rows['快门相位'].append(R(name, f'第 {e["atFrame"]} 帧快门中点：整图亮度重心的位移（亮度的大部分来自高光球），加在 {e["objectId"]} 的期望像素上（motion_blur_position={pos.upper()}）', e['pixelPx'], rnd(got), rnd(got - e['pixelPx']), 'px'))
                        ph = e['subFrameRatio'] + (lum_centroid(img[b]) - lum_centroid(img[fm]))[0] / pxf
                        rows['快门相位'].append(R(name, f'拖影中点的相位（{pos.upper()}）', e['subFrameRatio'], rnd(ph, 4), rnd(ph - e['subFrameRatio'], 4), 'frame'))
                        aux = (centroid(ident(b) == objs[e['objectId']]['idIndex']) - centroid(spec[f0] == objs[e['objectId']]['idIndex']))[0] / pxf
                        row.append(R(name, f'开运动模糊（{pos.upper()}）时编号层轮廓重心折合的时刻（逐像素随机取快门窗口里的时刻，随种子变），相对 sub = 0', 0, rnd(aux, 4), rnd(aux, 4), 'frame'))
                    # 同一个量的两个旁证：START 换种子 7 重渲的编号层；种子 0 那张的深度层（非背景轮廓，方块加高光球，对规格编号图的非背景）
                    for lab2, m, ms in (('种子 7 重渲的编号层', np.rint(read_exr(os.path.join(d1, f0 + '-blur-start-seed7.exr'))['Object Index'][:, :, 0]) == objs[e['objectId']]['idIndex'], spec[f0] == objs[e['objectId']]['idIndex']), ('种子 0 的深度层（非背景轮廓）', img[f0 + '-blur-start']['Depth'][:, :, 0] < c['farM'], spec[f0] != 0)): v = (centroid(m) - centroid(ms))[0] / pxf; row.append(R(name, f'开运动模糊（START）时{lab2}轮廓重心折合的时刻（逐像素随机取快门窗口里的时刻，随种子变），相对 sub = 0', 0, rnd(v, 4), rnd(v, 4), 'frame'))
                    rows['子帧累积和后期的先后'] += [R(name, f'第 {e["atFrame"]} 帧整图线性亮度的和（{k}）', '无标准答案', rnd((img[t]['Combined'][:, :, :3] @ [0.2126, 0.7152, 0.0722]).sum(), 1), '无', 'linear') for k, t in (('不开模糊', f0), ('帧起点开快门 START', f0 + '-blur-start'), ('帧中心开快门 CENTER', f0 + '-blur-center'))]
                    continue
                t = tag((e['atFrame'], e['subFrameRatio'], None)); oi = objs[e['objectId']]['idIndex']
                if any(e['localPointM']):  # 非中心点：位置层里离目标点 2 厘米内的像素的屏幕重心
                    Rm, T = obj_transform(objs[e['objectId']], e['atFrame'] + e['subFrameRatio']); tgt = Rm @ e['localPointM'] + T
                    P = img[t]['Position'][:, :, :3] @ C3  # Blender 世界 (x, y, z) → 规格 (x, z, −y)
                    got = centroid((ident(t) == oi) & (np.linalg.norm(P - tgt, axis=-1) < 0.02)); how = '渲染·位置层近邻重心'
                else:  # 中心点：编号层重心对照规格编号图重心的偏移，透视和遮挡造成的重心偏差两边抵消
                    got = np.array(e['pixelPx']) + centroid(ident(t) == oi) - centroid(spec[t] == oi); how = '渲染·编号层重心偏移'
                row.append(R(name, f'{lab} sub {e["subFrameRatio"]}（{how}）', e['pixelPx'], rnd(got), rnd(got - e['pixelPx']), 'px'))
                row.append(R(name, f'{lab} sub {e["subFrameRatio"]}（求值·依赖图加相机投影）', e['pixelPx'], rnd(ev), rnd(np.subtract(ev, e['pixelPx'])), 'px'))
                if e['objectId'].startswith('tip-'): g = centroid(ident(t) == oi); row.append(R(name, f'{lab} sub {e["subFrameRatio"]}（渲染·编号层重心直接对期望值，亚像素差）', e['pixelPx'], rnd(g), rnd(g - e['pixelPx']), 'px'))
            elif k == 'projectedBox':
                m = ident('f0000s00') == objs[e['objectId']]['idIndex']; b0, b1 = id_box(m); iou = box_iou(b0, b1, e['boxMinPx'], e['boxMaxPx'])
                row.append(R(name, f'{e["objectId"]} 编号层反算包围盒对元数据包围盒的交并比', 1, rnd(iou, 4), rnd(iou - 1, 4), 'ratio'))
            elif k == 'projectedWidth':  # 颜色层每行积分等于覆盖宽度（滤波保面积）；编号层每行数像素
                ctr = project(c, objs[e['objectId']]['positionM']); ii = int(ctr[0]); rows_ = slice(int(ctr[1]) - 60, int(ctr[1]) + 60)
                cov = img['f0000s00']['Combined'][rows_, ii - 8:ii + 9, 0].sum(1) / objs[e['objectId']]['emissionLinear'][0]
                idw = (ident('f0000s00')[rows_, ii - 8:ii + 9] == objs[e['objectId']]['idIndex']).sum(1)
                row.append(R(name, f'{e["objectId"]} 投影宽度（颜色层覆盖积分，120 行平均）', e['widthPx'], rnd(cov.mean()), rnd(cov.mean() - e['widthPx']), 'px'))
                row.append(R(name, f'{e["objectId"]} 投影宽度（编号层像素数，120 行平均）', e['widthPx'], rnd(idw.mean()), rnd(idw.mean() - e['widthPx']), 'px'))
        if name == 'probe-gray-chart':
            row.append(R(name, '背景像素 (320.5, 130.5) 颜色', s['backgroundLinear'], rnd(img['f0000s00']['Combined'][130, 320, :3]), rnd(np.abs(img['f0000s00']['Combined'][130, 320, :3] - s['backgroundLinear']).max(), 7), 'linear'))
            display(s, rows, d1)
        if name == 'probe-thin-geometry':
            raw = img['f0000s00']['Object Index'][:, :, 0]
            row.append(R(name, '编号层非整数像素占比（有无抗锯齿）', 0, rnd(np.mean(np.abs(raw - np.rint(raw)) > 1e-6), 6), rnd(np.mean(np.abs(raw - np.rint(raw)) > 1e-6), 6), 'ratio'))
        for t in img:  # 每张渲染的编号层和规格编号图逐像素比：不一致的像素占比
            if 'blur' not in t: row.append(R(name, f'{t} 编号层对规格编号图的不一致像素占比', 0, rnd(np.mean(ident(t) != spec[t]), 6), rnd(np.mean(ident(t) != spec[t]), 6), 'ratio'))
        if name == 'probe-occlusion':
            q = {k: np.rint(read_exr(os.path.join(d1, f'q-{k}.exr'))['Object Index'][:, :, 0]) for k in ['all', *objs]}
            for oid, o in objs.items():
                row.append(R(name, f'{oid} 四分之一分辨率单独多渲一遍编号层', '无标准答案', rnd(info['quarterMs'][oid], 1), '无', 'ms'))
                row.append(R(name, f'{oid} 可见比例（合渲像素 / 单独像素，四分之一分辨率）', '无标准答案', rnd((q['all'] == o['idIndex']).sum() / (q[oid] == o['idIndex']).sum(), 4), '无', 'ratio'))
        determinism(name, s, rows['确定性'])
    rows['耗时'] = [R('全部', 'Blender 冷启动（空脚本进程，两次）', '无标准答案', rnd(proc['coldStartMs'], 1), '无', 'ms')] + timing
    notes = json.load(open(os.path.join(HERE, 'notes.json'), encoding='utf8'))
    table = {'format': 'probe-column/0.1', 'source': f'blender-cycles（CPU，{SAMPLES} 采样，无降噪，种子 0）', 'version': version, 'machine': 'mac',
             'rows': [{'row': k, 'status': notes[k][0], 'readings': v, 'note': notes[k][1]} for k, v in rows.items()]}
    with open(os.path.join(CALIB, 'table', 'blender.json'), 'w', encoding='utf8') as f: json.dump(table, f, ensure_ascii=False, indent=1)

def display(s, rows, d):  # 显示变换和整形曲线：Blender 自带 OCIO 配置直算 / 渲染存图 / 烘出的两张三维查找表
    import PyOpenColorIO as O
    cfg = O.GetCurrentConfig(); dvt = O.DisplayViewTransform(); dvt.setSrc('Linear Rec.709'); dvt.setDisplay('sRGB'); dvt.setView('AgX')
    pl = O.LegacyViewingPipeline(); pl.setDisplayViewTransform(dvt); pl.setLooksOverrideEnabled(True); pl.setLooksOverride(LOOK)
    cpu = pl.getProcessor(cfg).getDefaultCPUProcessor()
    ocio = lambda rgb: np.array(cpu.applyRGB(np.asarray(rgb, np.float32).ravel().tolist()), float).reshape(-1, 3)
    png = oiio.ImageInput.open(os.path.join(d, 'agx-mhc.png')); pimg = png.read_image(0, 0, 0, 3, 'float'); png.close()
    N, (lo, hi) = 33, AGX_EV; g = np.linspace(0, 1, N); grid = np.stack(np.meshgrid(g, g, g, indexing='ij'), -1).reshape(-1, 3)
    luts = {'log': ocio(0.18 * 2 ** (lo + grid * (hi - lo))).reshape(N, N, N, 3), 'lin': ocio(grid).reshape(N, N, N, 3)}
    for k, lut in luts.items():  # .cube：R 变化最快
        with open(os.path.join(OUT, f'agx-mhc-{k}.cube'), 'w') as f:
            f.write(f'TITLE "AgX MHC {k}"\nLUT_3D_SIZE {N}\n' + ''.join(f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n' for v in lut.transpose(2, 1, 0, 3).reshape(-1, 3)))
    def apply(lut, s3):  # 三线性插值，s3 在 [0, 1]
        x = np.clip(s3, 0, 1) * (N - 1); i0 = np.minimum(x.astype(int), N - 2); fr = x - i0; out = 0
        for dr, dg, db in np.ndindex(2, 2, 2):
            out = out + (fr[0] if dr else 1 - fr[0]) * (fr[1] if dg else 1 - fr[1]) * (fr[2] if db else 1 - fr[2]) * lut[i0[0] + dr, i0[1] + dg, i0[2] + db]
        return out
    for e in s['expected']:
        if e['kind'] != 'patchColor': continue
        v = np.array(e['valueLinear'], float); ref = ocio(v)[0] * 255; ii, jj = (int(math.floor(x)) for x in e['pixelPx']); got = pimg[jj, ii] * 255
        rows['显示变换'].append(R(s['id'], f'{e["objectId"]} AgX MHC 显示值：渲染存图 vs OCIO 直算', rnd(ref, 3), rnd(got, 3), rnd(np.abs(got - ref).max(), 3), '8 位显示码值'))
        if e['objectId'].startswith('hdr-'):
            sh = (np.log2(np.maximum(v, 1e-10) / 0.18) - lo) / (hi - lo)
            for k, s3, lab in (('log', sh, '对数整形后查 33³ 表'), ('lin', v, '不整形直接查 33³ 表（定义域 0 到 1）')):
                gl = apply(luts[k], s3) * 255
                rows['显示变换的整形曲线'].append(R(s['id'], f'{e["objectId"]}（{v[0]}）{lab} vs OCIO 直算', rnd(ref, 3), rnd(gl, 3), rnd(np.abs(gl - ref).max(), 3), '8 位显示码值'))

def determinism(name, s, out):
    files = [tag(j) + '.exr' for j in jobs(s)] + (['agx-mhc.png'] if name == 'probe-gray-chart' else []) + ([f'q-{k}.exr' for k in ['all'] + [o['id'] for o in s['objects']]] if name == 'probe-occlusion' else [])
    def px(p):
        if p.endswith('.exr'): return np.concatenate([v for _, v in sorted(read_exr(p).items())], -1)
        i = oiio.ImageInput.open(p); a = i.read_image(0, 0, 0, i.spec().nchannels, 'float'); i.close(); return a
    for fn in files:
        a, b = (px(os.path.join(OUT, name, f'run{k}', fn)) for k in (1, 2)); h = [hashlib.sha256(np.ascontiguousarray(x).tobytes()).hexdigest() for x in (a, b)]  # 对解码后的像素数据算
        out.append(R(name, f'{fn} 两遍解码像素的 SHA-256（expected 是 run1，got 是 run2）', h[0], h[1], '相同' if h[0] == h[1] else '不同', 'sha256'))
        if np.array_equal(a, b): out.append(R(name, f'{fn} 两遍像素逐位比对', '逐位相同', '逐位相同', 0, '个不同的数')); continue
        ca, cb = (np.clip(x[:, :, :3], 0, 1) for x in (a, b)); mse = np.mean((ca - cb) ** 2)
        out.append(R(name, f'{fn} 两遍不同：颜色层 PSNR（截到 0 到 1）', '逐位相同', rnd(10 * math.log10(1 / mse) if mse else math.inf, 2), int((a != b).sum()), 'dB（diff 为不同的数的个数）'))
        out.append(R(name, f'{fn} 两遍不同：8 位下差 5 级以上的像素占比', 0, rnd(np.mean(np.abs(np.rint(ca * 255) - np.rint(cb * 255)).max(-1) > 5), 6), '无', 'ratio'))

if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:]  # noop 什么都不做，只量冷启动
    render(argv[1], int(argv[2])) if argv[0] == 'render' else analyze() if argv[0] == 'analyze' else None
