"""硬表面件与命名锚点；只移动相机，不改标注。"""
import json
import math
from pathlib import Path

import bpy


def linear_rgb(hex_color):
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb) + (1,)


def build(ctx):
    film = json.loads(Path(__file__).with_name('film.json').read_text(encoding='utf-8'))
    p = film['shots'][0]['params']
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.new('studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get('Background').inputs[0].default_value = linear_rgb(p['background'])
    bpy.ops.object.camera_add()
    cam = scene.camera = bpy.context.object
    cam.rotation_euler = (math.pi / 2, 0, 0)
    cam.data.sensor_fit = 'VERTICAL'
    cam.data.sensor_height = 24
    cam.data.lens = 12 / math.tan(math.radians(p['fovYDeg']) / 2)
    x = p['cameraX'][int(ctx.tokens.get('take', 0))]
    for f in range(ctx.frames):
        cam.location = ctx.to_blender((x + p['travelX'] * f / (ctx.frames - 1), p['cameraY'], p['cameraZ']))
        cam.keyframe_insert(data_path='location', frame=f)
    objects = []
    for part in p['parts']:
        bpy.ops.mesh.primitive_cube_add(size=1, location=ctx.to_blender(part['center']))
        obj = bpy.context.object
        obj.name = part['id']
        w, h, d = part['size']
        obj.scale = (w, d, h)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel = obj.modifiers.new('rim', 'BEVEL')
        bevel.width, bevel.segments = 0.018, 3
        mat = bpy.data.materials.new(obj.name)
        mat.use_nodes = True
        surface = mat.node_tree.nodes.get('Principled BSDF')
        surface.inputs['Base Color'].default_value = linear_rgb(part['color'])
        surface.inputs['Metallic'].default_value = 0.55
        obj.data.materials.append(mat)
        objects.append(obj)
    return {'entities': [{'name': 'module', 'class': 'part', 'role': 'hero', 'objects': objects}],
            'meta': lambda f: {'anchors': {'module#pin': p['anchor']}}}
