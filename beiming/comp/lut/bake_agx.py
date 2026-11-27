# AgX Medium High Contrast 查找表的 Blender 一侧。由 bake-agx.mjs 起一个一次性的后台 Blender 来跑：
#   blender -b -noaudio --factory-startup --python bake_agx.py -- '<一行 JSON>'
# 四种活，都只读 Blender 自带的色彩配置（场景线性 Rec.709 → 显示 sRGB、视图 AgX、外观 AgX - Medium High Contrast）：
#   bake    用 OCIO 处理器在整形后的三维网格上逐点直算，写成 .cube
#   direct  把给定的线性值走 Blender 存图的色彩管理（save_render，关抖动）存成 16 位或 8 位 PNG 再读回，当独立的对照
#   ocio    同一个 OCIO 处理器在给定的线性值上逐点直算（32 位浮点），当浮点的标准答案
#   chain   把这个处理器（OCIO 默认优化之后）的算子逐个写成 JSON：矩阵、log2、三维表、log 式的分级、指数、sRGB 编码。
#           三维表只写格数和几个格点的值，表本身由 JS 一侧从 Blender 自带的 .cube 读（同一份文件，sha256 进锁）
# 数值口径：输入是场景线性光（Rec.709 原色），输出是显示空间的 sRGB 编码值，范围 0 到 1。
import json
import os
import sys

import bpy
import numpy as np

DISPLAY = 'sRGB'
VIEW = 'AgX'
LOOK = 'AgX - Medium High Contrast'


def config_path():
    return os.path.join(bpy.utils.resource_path('LOCAL'), 'datafiles', 'colormanagement', 'config.ocio')


def processor(optimized=False):
    import PyOpenColorIO as ocio
    config = ocio.Config.CreateFromFile(config_path())
    pipeline = ocio.LegacyViewingPipeline()
    pipeline.setDisplayViewTransform(ocio.DisplayViewTransform(src=ocio.ROLE_SCENE_LINEAR, display=DISPLAY, view=VIEW))
    pipeline.setLooksOverrideEnabled(True)
    pipeline.setLooksOverride(LOOK)
    p = pipeline.getProcessor(config, config.getCurrentContext())
    return p.getOptimizedProcessor(ocio.OPTIMIZATION_DEFAULT) if optimized else p.getDefaultCPUProcessor()


# 指纹格点：取三维表这几个下标上的值，JS 一侧据此认出是哪一张 .cube（同格数的表不止一张）
PROBE_INDEX = [(1, 2, 3), (7, 0, 5), (11, 13, 2)]


def chain(job):
    import PyOpenColorIO as ocio
    ops = []
    for t in processor(optimized=True).createGroupTransform():
        name = type(t).__name__
        forward = t.getDirection() == ocio.TRANSFORM_DIR_FORWARD
        if name == 'MatrixTransform':
            ops.append({'op': 'matrix', 'm': list(t.getMatrix()), 'offset': list(t.getOffset()), 'forward': forward})
        elif name == 'LogTransform':
            ops.append({'op': 'log', 'base': t.getBase(), 'forward': forward})
        elif name == 'Lut3DTransform':
            if t.getInterpolation() != ocio.INTERP_TETRAHEDRAL or not forward:
                raise SystemExit('三维表只认正向、四面体插值')
            ops.append({'op': 'lut3d', 'size': t.getGridSize(), 'probe': [[i, j, k, list(t.getValue(i, j, k))] for i, j, k in PROBE_INDEX]})
        elif name == 'GradingPrimaryTransform':
            v = t.getValue()
            rgbm = lambda x: [x.red, x.green, x.blue, x.master]
            ops.append({'op': 'grading-primary', 'style': str(t.getStyle()).split('.')[-1], 'forward': forward,
                        'brightness': rgbm(v.brightness), 'contrast': rgbm(v.contrast), 'gamma': rgbm(v.gamma),
                        'offset': rgbm(v.offset), 'exposure': rgbm(v.exposure), 'lift': rgbm(v.lift), 'gain': rgbm(v.gain),
                        'saturation': v.saturation, 'pivot': v.pivot, 'pivotBlack': v.pivotBlack, 'pivotWhite': v.pivotWhite,
                        'clampBlack': v.clampBlack, 'clampWhite': v.clampWhite})
        elif name == 'ExponentTransform':
            ops.append({'op': 'exponent', 'value': list(t.getValue()), 'negative': str(t.getNegativeStyle()).split('.')[-1], 'forward': forward})
        elif name == 'ExponentWithLinearTransform':
            ops.append({'op': 'moncurve', 'gamma': list(t.getGamma()), 'offset': list(t.getOffset()), 'negative': str(t.getNegativeStyle()).split('.')[-1], 'forward': forward})
        else:
            raise SystemExit('OCIO 处理器里有不认识的算子：%s' % name)
    lut_dir = os.path.join(os.path.dirname(config_path()), 'luts')
    with open(job['outPath'], 'w', encoding='utf-8') as f:
        json.dump({'ocio': ocio.__version__, 'blender': bpy.app.version_string, 'config': config_path(), 'luts': lut_dir,
                   'display': DISPLAY, 'view': VIEW, 'look': LOOK, 'ops': ops}, f)


def bake(job):
    n, shaper = job['gridSize'], job['shaper']
    # 网格点在整形后的 0 到 1 上均匀分布；解回线性光：mid × 2^(档数)，档数从 minStops 到 maxStops
    t = np.linspace(0.0, 1.0, n, dtype=np.float64)
    axis = shaper['midGray'] * np.exp2(shaper['minStops'] + t * (shaper['maxStops'] - shaper['minStops']))
    # .cube 的次序：红变得最快，蓝最慢
    b, g, r = np.meshgrid(axis, axis, axis, indexing='ij')
    rgb = np.ascontiguousarray(np.stack([r, g, b], axis=-1).reshape(-1, 3).astype(np.float32))
    processor().applyRGB(rgb)
    rgb = np.clip(rgb, 0.0, 1.0)
    lines = ['TITLE "agx-mhc"', 'LUT_3D_SIZE %d' % n, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']
    lines += ['%.6f %.6f %.6f' % (p[0], p[1], p[2]) for p in rgb.tolist()]
    with open(job['outPath'], 'w', encoding='ascii', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


def float_direct(job):
    rgb = np.ascontiguousarray(np.array(job['values'], dtype=np.float32).reshape(-1, 3))
    processor().applyRGB(rgb)
    with open(job['outPath'], 'w', encoding='ascii') as f:
        json.dump([[float(c) for c in p] for p in rgb.tolist()], f)


def direct(job):
    values = job['values']
    scene = bpy.context.scene
    scene.render.dither_intensity = 0.0
    scene.display_settings.display_device = DISPLAY
    scene.view_settings.view_transform = VIEW
    scene.view_settings.look = LOOK
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    settings = scene.render.image_settings
    settings.file_format = 'PNG'
    settings.color_mode = 'RGB'
    settings.color_depth = str(job.get('depth', 16))
    settings.compression = 0
    image = bpy.data.images.new('agx-direct-in', len(values), 1, alpha=False, float_buffer=True)
    image.pixels.foreach_set(np.array([[v[0], v[1], v[2], 1.0] for v in values], dtype=np.float32).ravel())
    png = job['outPath'] + '.png'
    try:
        image.save_render(png, scene=scene)
        back = bpy.data.images.load(png)
        back.colorspace_settings.name = 'Non-Color'
        px = np.empty(len(values) * 4, dtype=np.float32)
        back.pixels.foreach_get(px)
    finally:
        if os.path.exists(png):
            os.remove(png)
    with open(job['outPath'], 'w', encoding='ascii') as f:
        json.dump([[float(c) for c in p[:3]] for p in px.reshape(-1, 4)], f)


job = json.loads(sys.argv[sys.argv.index('--') + 1])
{'bake': bake, 'direct': direct, 'ocio': float_direct, 'chain': chain}[job['mode']](job)
