"""懂你的人 · 书桌方向 15 秒动态测试（一镜到底）
0–2s 书桌全景 → 2–6s 落到「借过」照片，照片鼓起成浮雕 → 6.8–9.8s 滑到立着的眼镜，透过镜片看球球照片
用法：Blender -b --factory-startup --python desk_anim.py -- anim <frames_dir/f_> [start end]"""
import bpy, math, sys, os
from mathutils import Vector

HERE = os.path.expanduser('~/Desktop/懂你的人/tools/')
src = open(HERE + 'desk_scene.py').read().split("\n{'d1_wide'")[0]
exec(src)
FPS = 24
T = lambda s: int(round(s * FPS))

sc = desk_base()
sc.render.fps = FPS
sc.cycles.samples = 48
sc.cycles.use_denoising = True
sc.frame_start, sc.frame_end = 0, T(19.0)

# 眼镜立在桌上，镜片对着斜靠的球球照片
flat = bpy.data.objects['ph_i05.png']
for c in list(flat.children):
    bpy.data.objects.remove(c, do_unlink=True)
bpy.data.objects.remove(flat, do_unlink=True)
glasses(loc=(-.02, -.30, .021), rot=(0, 0, math.radians(4)))
photo('i05.png', .16, (-.03, -.15), 0, rx=math.radians(72), z=.045)
l = bpy.data.lights.new('fill', 'AREA')
l.size, l.energy, l.color = .3, 2.5, (1, .9, .78)
lo = link(bpy.data.objects.new('fill', l))
lo.location, lo.rotation_euler = (.06, -.26, .25), (math.radians(35), 0, math.radians(20))

# 「借过」照片换成可鼓起的浮雕网格
root = bpy.data.objects['ph_i02.png']
old = next(c for c in root.children if c.name.startswith('img'))
mat = old.data.materials[0]
w, h = old.scale.x, old.scale.y
bpy.data.objects.remove(old, do_unlink=True)
bpy.ops.mesh.primitive_grid_add(x_subdivisions=320, y_subdivisions=180, size=1, calc_uvs=True)
g = bpy.context.active_object
g.data.materials.append(mat)
g.parent = root
g.location = (0, 0, .0009)
g.scale = (w, h, 1)
for p in g.data.polygons:
    p.use_smooth = True
tex = bpy.data.textures.new('dep', 'IMAGE')
tex.image = bpy.data.images.load(os.path.expanduser('~/Desktop/懂你的人/风格样张/陈默的书桌/tex/i02_depth.png'))
tex.extension = 'EXTEND'
dm = g.modifiers.new('D', 'DISPLACE')
dm.texture = tex
dm.texture_coords = 'UV'
dm.mid_level = 0
dm.strength = 0
dm.keyframe_insert('strength', frame=T(3.6))
dm.strength = .009         # 网格 z 方向没缩放，这里就是米：鼓起约 1.3 cm
dm.keyframe_insert('strength', frame=T(6.0))

# 相机：跟一个目标空物体，焦点也落在它上面
cam = camera((-.04, -.78, .5), (0, .02, 0), lens=36, fstop=4.5)
tgt = bpy.data.objects.new('target', None)
link(tgt)
con = cam.constraints.new('TRACK_TO')
con.target = tgt
con.track_axis, con.up_axis = 'TRACK_NEGATIVE_Z', 'UP_Y'
cam.data.dof.focus_object = tgt
KEYS = [  # 秒, 相机位置, 看向, 焦距
    (0.0, (-.04, -.80, .52), (0, .03, 0), 36),
    (2.0, (-.09, -.62, .40), (-.08, .03, 0), 36),
    (5.6, (-.29, -.075, .175), (-.24, .085, .0), 50),
    (6.8, (-.285, -.06, .16), (-.24, .085, .0), 50),
    (8.2, (-.07, -.64, .10), (-.03, -.2, .03), 55),
    (9.8, (-.045, -.48, .036), (-.032, -.15, .042), 72),
    (19.0, (-.043, -.455, .037), (-.032, -.15, .042), 74),
]
for s, loc, look, lens in KEYS:
    f = T(s)
    cam.location = loc
    cam.keyframe_insert('location', frame=f)
    tgt.location = look
    tgt.keyframe_insert('location', frame=f)
    cam.data.lens = lens
    cam.data.keyframe_insert('lens', frame=f)


def ease_all(ob):
    ad = ob.animation_data
    if not ad or not ad.action:
        return
    try:
        fcs = ad.action.layers[0].strips[0].channelbags[0].fcurves
    except Exception:
        fcs = ad.action.fcurves
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'
            kp.easing = 'AUTO'
            kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'


for ob in (cam, tgt, cam.data, g):
    ease_all(ob)
for ob in (g,):
    pass

args = sys.argv[sys.argv.index('--') + 1:]
out = args[1]
sc.render.filepath = out
sc.render.image_settings.file_format = 'JPEG'
sc.render.image_settings.quality = 93
if len(args) >= 4:
    sc.frame_start, sc.frame_end = int(args[2]), int(args[3])
if len(args) >= 5 and args[4] == 'still':
    sc.frame_set(int(args[2]))
    sc.render.filepath = out + '%04d.jpg' % int(args[2])
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print('DONE')
