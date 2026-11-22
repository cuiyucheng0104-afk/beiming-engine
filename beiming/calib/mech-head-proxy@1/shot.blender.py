# Blender 帧源的镜头入口（build-script 模式）：规格是旁边的 scene.json，搭法在 ../shot_blender.py。
import os
import runpy

HERE = os.path.dirname(os.path.abspath(__file__))
build_scene = runpy.run_path(os.path.join(HERE, '..', 'shot_blender.py'))['build_scene']


def build(ctx):
    return build_scene(ctx, os.path.join(HERE, 'scene.json'))
