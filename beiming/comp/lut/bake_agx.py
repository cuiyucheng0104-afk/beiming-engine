# AgX Medium High Contrast 查找表的 Blender 一侧。由 bake-agx.mjs 起一个一次性的后台 Blender 来跑：
#   blender -b -noaudio --factory-startup --python bake_agx.py -- '<一行 JSON>'
# 两种活，都只读 Blender 自带的色彩配置（场景线性 Rec.709 → 显示 sRGB、视图 AgX、外观 AgX - Medium High Contrast）：
#   bake    用 OCIO 处理器在整形后的三维网格上逐点直算，写成 .cube
#   direct  把给定的线性值走 Blender 存图的色彩管理（save_render）存成 16 位 PNG 再读回，当独立的对照
# 数值口径：输入是场景线性光（Rec.709 原色），输出是显示空间的 sRGB 编码值，范围 0 到 1。
import json
import os
import sys

import bpy
import numpy as np

DISPLAY = 'sRGB'
VIEW = 'AgX'
LOOK = 'AgX - Medium High Contrast'


def processor():
    import PyOpenColorIO as ocio
    path = os.path.join(bpy.utils.resource_path('LOCAL'), 'datafiles', 'colormanagement', 'config.ocio')
    config = ocio.Config.CreateFromFile(path)
    pipeline = ocio.LegacyViewingPipeline()
    pipeline.setDisplayViewTransform(ocio.DisplayViewTransform(src=ocio.ROLE_SCENE_LINEAR, display=DISPLAY, view=VIEW))
    pipeline.setLooksOverrideEnabled(True)
    pipeline.setLooksOverride(LOOK)
    return pipeline.getProcessor(config, config.getCurrentContext()).getDefaultCPUProcessor()


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


def direct(job):
    values = job['values']
    scene = bpy.context.scene
    scene.display_settings.display_device = DISPLAY
    scene.view_settings.view_transform = VIEW
    scene.view_settings.look = LOOK
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    settings = scene.render.image_settings
    settings.file_format = 'PNG'
    settings.color_mode = 'RGB'
    settings.color_depth = '16'
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
{'bake': bake, 'direct': direct}[job['mode']](job)
