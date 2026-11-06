"""《懂你的人》书桌版全片：Blender 场景 + 一镜到底机位 + 昼夜灯光
用法：
  Blender -b --factory-startup --python desk_film.py -- render <frames_dir/f_> <start> <end>
  Blender -b --factory-startup --python desk_film.py -- still  <out_prefix> <frame>
  Blender -b --factory-startup --python desk_film.py -- project <out.json>     # 导出 HUD 锚点的逐帧屏幕坐标"""
import bpy, math, sys, os, json, random
from mathutils import Vector

HERE = os.path.expanduser('~/Desktop/懂你的人/tools/')
_argv = sys.argv
sys.argv = sys.argv[:sys.argv.index('--') + 1] + ['x', 'x']          # 给被复用的脚本一个假参数
exec(open(HERE + 'desk_scene.py').read().split("\n{'d1_wide'")[0])
sys.argv = _argv
ARGS = sys.argv[sys.argv.index('--') + 1:]
TL = json.load(open(os.path.expanduser('~/Desktop/懂你的人/film/desk/timeline.json')))
DEP = os.path.expanduser('~/Desktop/懂你的人/风格样张/陈默的书桌/tex/depth/')
FPS = TL['fps']
F = lambda s: int(round(s * FPS))
S05E = float(os.environ.get("S05E", "6"))   # S05 补光瓦数
PW = .17                                  # 照片宽（米）
RELIEF = .0045

# ---------------------------------------------------------------- 场景
sc = reset()
sc.render.fps = FPS
sc.cycles.samples = 24
sc.render.use_persistent_data = True
sc.cycles.use_denoising = True
sc.frame_start, sc.frame_end = 0, F(TL['total']) - 1
world_bg = node(sc.world.node_tree, 'BACKGROUND')


def wood():
    m = bpy.data.materials.new('wood')
    m.use_nodes = True
    nt = m.node_tree
    p = node(nt, 'BSDF_PRINCIPLED')
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 2.0
    wave.inputs['Distortion'].default_value = 7
    wave.inputs['Detail'].default_value = 6
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (.24, .13, .06, 1)
    ramp.color_ramp.elements[1].color = (.48, .29, .14, 1)
    nt.links.new(wave.outputs['Fac'], ramp.inputs[0])
    nt.links.new(ramp.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = .42
    p.inputs['Coat Weight'].default_value = .25
    return m


plane('desk', wood(), 2.6, 1.8, (0, 0, 0))
plane('wall', mat_principled('wall', (.78, .74, .68), rough=.9), 2.6, 1.4, (0, .72, .7), (math.pi / 2, 0, 0))
win = mat_principled('sky', (0, 0, 0), emit=(1, .9, .75), estr=5)
plane('window', win, .8, .55, (-.5, .715, .5), (math.pi / 2, 0, 0))
win_p = node(win.node_tree, 'BSDF_PRINCIPLED')

sun = bpy.data.lights.new('sun', 'SUN')
sun.angle = math.radians(2)
so = link(bpy.data.objects.new('sun', sun))
moon = bpy.data.lights.new('moon', 'SUN')
moon.color = (.55, .65, 1)
mo = link(bpy.data.objects.new('moon', moon))
mo.rotation_euler = (math.radians(55), 0, math.radians(200))
# 台灯（夜里点亮）
shade = mat_principled('shade', (.12, .26, .2), rough=.35, metal=.6)
for (kind, kw) in [('cyl', dict(radius=.06, depth=.015, location=(-.92, .5, .0075))),
                   ('cyl', dict(radius=.007, depth=.40, location=(-.92, .5, .2)))]:
    bpy.ops.mesh.primitive_cylinder_add(**kw)
    bpy.context.active_object.data.materials.append(shade)
bpy.ops.mesh.primitive_cone_add(radius1=.08, radius2=.03, depth=.09, location=(-.80, .42, .37), rotation=(math.radians(-25), math.radians(40), 0))
bpy.context.active_object.data.materials.append(shade)
lamp = bpy.data.lights.new('lamp', 'SPOT')
lamp.color, lamp.spot_size, lamp.spot_blend, lamp.shadow_soft_size = (1, .78, .5), math.radians(110), .6, .02
lo = link(bpy.data.objects.new('lamp', lamp))
lo.location, lo.rotation_euler = (-.78, .40, .34), (math.radians(38), math.radians(32), 0)
bpy.ops.mesh.primitive_cylinder_add(radius=.04, depth=.095, location=(.92, .25, .0475))
bpy.context.active_object.data.materials.append(mat_principled('mug', (.86, .83, .77), rough=.25, coat=.6))

# 昼夜：午后 → 金色 → 黄昏 → 夜（关键帧）
def lightkey(t, e, col, rx, rz, moon_e, lamp_e, win_col, win_s, bg, bgs):
    f = F(t)
    sun.energy, sun.color = e, col
    sun.keyframe_insert('energy', frame=f)
    sun.keyframe_insert('color', frame=f)
    so.rotation_euler = (math.radians(rx), 0, math.radians(rz))
    so.keyframe_insert('rotation_euler', frame=f)
    moon.energy = moon_e
    moon.keyframe_insert('energy', frame=f)
    lamp.energy = lamp_e
    lamp.keyframe_insert('energy', frame=f)
    win_p.inputs['Emission Color'].default_value = win_col + (1,)
    win_p.inputs['Emission Strength'].default_value = win_s
    win_p.inputs['Emission Color'].keyframe_insert('default_value', frame=f)
    win_p.inputs['Emission Strength'].keyframe_insert('default_value', frame=f)
    world_bg.inputs[0].default_value = bg + (1,)
    world_bg.inputs[1].default_value = bgs
    world_bg.inputs[0].keyframe_insert('default_value', frame=f)
    world_bg.inputs[1].keyframe_insert('default_value', frame=f)


lightkey(0, 5.0, (1, .86, .66), 66, 245, 0, 0, (1, .9, .75), 5, (.32, .27, .22), .3)
lightkey(76, 5.0, (1, .84, .62), 67, 245, 0, 0, (1, .9, .75), 5, (.32, .27, .22), .3)
lightkey(100, 3.4, (1, .70, .42), 75, 250, 0, 0, (1, .72, .45), 4, (.30, .22, .16), .25)
lightkey(126, 1.3, (1, .48, .28), 82, 255, .1, 12, (.9, .45, .3), 2.2, (.18, .12, .1), .2)
lightkey(137, 0.0, (1, .48, .28), 85, 255, .35, 55, (.15, .22, .55), 1.2, (.02, .03, .07), .25)


# ---------------------------------------------------------------- 物件
PAPER = mat_principled('paperw', (.93, .91, .87), rough=.75)
ANCH = {}             # 站点 → (物体, 本地四角)


def relief_photo(img, x, y, rz, t_pop, w=PW, rx=0.0, z=.0012, key=None):
    h = w * 940 / 1672
    root = bpy.data.objects.new('ph_' + img, None)
    link(root)
    b = plane('border_' + img, PAPER, w + .012, h + .012, (0, 0, 0), thick=.0008)
    b.parent = root
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=200, y_subdivisions=113, size=1, calc_uvs=True)
    g = bpy.context.active_object
    g.name = 'img_' + img
    g.data.materials.append(tex_mat(img, SRC + img, .3))
    g.parent = root
    g.location, g.scale = (0, 0, .0009), (w, h, 1)
    for p in g.data.polygons:
        p.use_smooth = True
    dp = DEP + img.replace('.png', '') + '.png'
    if t_pop is not None and os.path.exists(dp):
        tx = bpy.data.textures.new('d_' + img, 'IMAGE')
        tx.image = bpy.data.images.load(dp)
        tx.extension = 'EXTEND'
        dm = g.modifiers.new('D', 'DISPLACE')
        dm.texture, dm.texture_coords, dm.mid_level = tx, 'UV', 0
        dm.strength = 0
        dm.keyframe_insert('strength', frame=F(t_pop))
        dm.strength = RELIEF
        dm.keyframe_insert('strength', frame=F(t_pop + 1.5))
    root.location, root.rotation_euler = (x, y, z), (rx, 0, rz)
    return root, g


def img_pt(u, v):
    """原画 1920×1080 坐标 → 平面本地坐标"""
    return (u / 1920 - .5, .5 - v / 1080, .004)


HUDBOX = {'S08': (36, 584, 794, 968), 'S13': (1180, 100, 1820, 440), 'S14': (76, 260, 840, 650),
          'S05': (390, 890, 1544, 1034)}

for k, s in enumerate(TL['stations']):
    x, y, rz, t0 = s['x'], s['y'], s['rz'], s['t0']
    kind = s['kind']
    img = 'i%02d.png' % s['page'] if s['page'] else None
    if kind in ('photo', 'strip', 'title'):
        root, g = relief_photo(img, x, y, rz, t0 + .5 if kind != 'title' else 2.0)
        if s.get('hud'):
            u0, v0, u1, v1 = HUDBOX[s['hud']]
            ANCH[s['sid']] = (g.name, [img_pt(u0, v0), img_pt(u1, v0), img_pt(u1, v1), img_pt(u0, v1)])
        if kind == 'title':
            plane('note', tex_mat('note', TEX + 'note.png', .7), .085, .085, (x + .14, y + .07, .0016), (0, 0, .2), thick=.0006)
    elif kind == 'lens':
        glasses(loc=(x, y - .15, .021), rot=(0, 0, math.radians(4)))
        root, g = relief_photo('i05.png', x, y, 0, None, w=.16, rx=math.radians(72), z=.045)
        u0, v0, u1, v1 = HUDBOX['S05']
        ANCH['S05'] = (g.name, [img_pt(u0, v0), img_pt(u1, v0), img_pt(u1, v1), img_pt(u0, v1)])
    elif kind == 'phone':
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, .005))
        ph = bpy.context.active_object
        ph.scale, ph.rotation_euler = (.155, .074, .009), (0, 0, rz)
        bv = ph.modifiers.new('B', 'BEVEL')
        bv.width, bv.segments = .009, 6
        ph.data.materials.append(mat_principled('phone', (.02, .02, .025), rough=.2, coat=1))
        plane('screen7', tex_mat('scr7', TEX + 'phone.png', .15, emit=1.0), .145, .066, (x, y, .0097), (0, 0, rz))
    elif kind == 'notebook':
        nb = plane('notebook', tex_mat('nb', TEX + 'notebook_blank.png', .7), .30, .20, (x, y, .004), (0, 0, rz), thick=.006)
        # 右页书写区（贴图 2400×1600 中 x 1290–2330, y 150–1100）
        q = lambda u, v: (u / 2400 - .5, .5 - v / 1600, .012)
        ANCH['S16'] = (nb.name, [q(1290, 150), q(2330, 150), q(2330, 1100), q(1290, 1100)])
    elif kind == 'gift':
        box = mat_principled('box', (.12, .14, .32), rough=.45)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, .035))
        b = bpy.context.active_object
        b.scale = (.17, .11, .07)
        b.data.materials.append(box)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, .047))
        inner = bpy.context.active_object
        inner.scale = (.155, .095, .07)
        bo = b.modifiers.new('cut', 'BOOLEAN')
        bo.object, bo.operation = inner, 'DIFFERENCE'
        inner.hide_render = True
        inner.hide_viewport = True
        plane('lid', tex_mat('star', TEX + 'starpaper.png', .5, emit=.6), .175, .115, (x, y + .075, .115), (math.radians(-75), 0, 0), thick=.004)
        glasses(loc=(x, y, .06), rot=(math.radians(-82), 0, math.radians(4)), led=True)
        glow = mat_principled('glow', (1, .85, .5), emit=(1, .82, .5), estr=22)
        random.seed(4)
        for i in range(60):
            bpy.ops.mesh.primitive_ico_sphere_add(radius=random.uniform(.0003, .0008), subdivisions=1,
                                                  location=(x + random.uniform(-.08, .08), y + random.uniform(-.05, .05), .07 + random.random() * .09))
            bpy.context.active_object.data.materials.append(glow)
        pl = bpy.data.lights.new('boxglow', 'POINT')
        pl.color, pl.shadow_soft_size = (1, .82, .5), .03
        po = link(bpy.data.objects.new('boxglow', pl))
        po.location = (x, y, .07)
        pl.energy = 0
        pl.keyframe_insert('energy', frame=F(t0 - 2))
        pl.energy = 6
        pl.keyframe_insert('energy', frame=F(t0 + 1))
    elif kind == 'tablet':
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, .005))
        tb = bpy.context.active_object
        tb.scale, tb.rotation_euler = (.21, .135, .008), (0, 0, rz)
        bv = tb.modifiers.new('B', 'BEVEL')
        bv.width, bv.segments = .01, 6
        tb.data.materials.append(mat_principled('tab', (.02, .02, .025), rough=.2, coat=1))
        m = bpy.data.materials.new('tabscr')
        m.use_nodes = True
        nt = m.node_tree
        for n in list(nt.nodes):
            if n.type != 'OUTPUT_MATERIAL':
                nt.nodes.remove(n)
        out = node(nt, 'OUTPUT_MATERIAL')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.1
        mix = nt.nodes.new('ShaderNodeMixRGB')
        for i, nm in enumerate(('i23.png', 'i24.png')):
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = bpy.data.images.load(SRC + nm)
            nt.links.new(t.outputs['Color'], mix.inputs[1 + i])
        nt.links.new(mix.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        mix.inputs[0].default_value = 0
        mix.inputs[0].keyframe_insert('default_value', frame=F(t0 + 2.2))
        mix.inputs[0].default_value = 1
        mix.inputs[0].keyframe_insert('default_value', frame=F(t0 + 2.8))
        scr = plane('screen23', m, .196, .11, (x, y, .0093), (0, 0, rz))
        ANCH['S23'] = (scr.name, [(-.5, .5, .002), (.5, .5, .002), (.5, -.5, .002), (-.5, -.5, .002)])

# ---------------------------------------------------------------- 相机
cam = camera((0, -1, .7), (0, 0, 0), lens=30, fstop=4.0)
tgt = bpy.data.objects.new('target', None)
link(tgt)
con = cam.constraints.new('TRACK_TO')
con.target, con.track_axis, con.up_axis = tgt, 'TRACK_NEGATIVE_Z', 'UP_Y'
cam.data.dof.focus_object = tgt


# 跟机补光：白天很弱，黄昏和夜里加强（电影里常用的跟机灯）
fl = bpy.data.lights.new('camfill', 'AREA')
fl.size, fl.color = .25, (1, .86, .7)
flo = link(bpy.data.objects.new('camfill', fl))
flo.parent = cam
flo.location = (0, .08, 0)
for t_, e_ in [(0, .25), (100, .6), (126, 2.6), (137, 3.6)]:
    fl.energy = e_
    fl.keyframe_insert('energy', frame=F(t_))


# S05 镜片站补光：只在这一站亮，照向斜靠的 i05 照片
_s5 = next(s for s in TL['stations'] if s['sid'] == 'S05')
sp5 = bpy.data.lights.new('s05fill', 'SPOT')
sp5.color, sp5.spot_size, sp5.spot_blend, sp5.shadow_soft_size = (1, .93, .85), math.radians(45), .6, .08
spo = link(bpy.data.objects.new('s05fill', sp5))
spo.visible_glossy = False               # 不在镜片上反出光斑
spo.location = (_s5['x'] - .06, _s5['y'] - .32, .16)
_c5 = spo.constraints.new('TRACK_TO')
_c5.target = link(bpy.data.objects.new('s05aim', None))
_c5.target.location = (_s5['x'], _s5['y'], .05)
_c5.track_axis, _c5.up_axis = 'TRACK_NEGATIVE_Z', 'UP_Y'
for t_, e_ in [(0, 0), (_s5['t0'] - .3, 0), (_s5['t0'] + .8, S05E), (_s5['t1'] - .3, S05E), (_s5['t1'] + .5, 0)]:
    sp5.energy = e_
    sp5.keyframe_insert('energy', frame=F(t_))


def key(t, pose):
    (loc, look, lens) = pose
    f = F(t)
    cam.location = loc
    cam.keyframe_insert('location', frame=f)
    tgt.location = look
    tgt.keyframe_insert('location', frame=f)
    cam.data.lens = lens
    cam.data.keyframe_insert('lens', frame=f)


prev = None
TR = TL['travel']
for s in TL['stations']:
    a, b = s['arrive'], s['end']
    t0, t1 = s['t0'], s['t1']
    if s['kind'] == 'title':
        key(0, a)
        key(1.4, a)
        key(t1, b)
    else:
        tr = 2.2 if s['kind'] == 'brand' else TR
        mid_loc = [(p + q) / 2 for p, q in zip(prev[0], a[0])]
        mid_loc[2] += .05
        mid_look = [(p + q) / 2 for p, q in zip(prev[1], a[1])]
        key(t0 + tr * .5, (mid_loc, mid_look, (prev[2] + a[2]) / 2))
        key(t0 + tr, a)
        if s['kind'] == 'lens':
            key(t0 + tr + 1.8, b)
            bb = ((b[0][0], b[0][1] + .01, b[0][2]), b[1], b[2] + 1)
            key(t1, bb)
            b = bb
        else:
            key(t1, b)
    prev = b

for ob in (cam, tgt, cam.data):
    ad = ob.animation_data
    try:
        fcs = ad.action.layers[0].strips[0].channelbags[0].fcurves
    except Exception:
        fcs = ad.action.fcurves
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'
            kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'

# ---------------------------------------------------------------- 执行
mode = ARGS[0]
if mode == 'project':
    from bpy_extras.object_utils import world_to_camera_view
    W, H = sc.render.resolution_x, sc.render.resolution_y
    res = {}
    for sid, (obn, pts) in ANCH.items():
        st = next(s for s in TL['stations'] if s['sid'] == sid)
        ob = bpy.data.objects[obn]
        rows = {}
        for f in range(F(st['t0']), F(st['t1'] + .8)):
            sc.frame_set(f)
            mw = ob.matrix_world
            q = []
            for p in pts:
                v = world_to_camera_view(sc, cam, mw @ Vector(p))
                q.append([round(v.x * W, 1), round((1 - v.y) * H, 1)])
            rows[f] = q
        res[sid] = rows
    json.dump(res, open(ARGS[1], 'w'))
    print('PROJECTED', list(res))
else:
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = 93
    if mode == 'still':
        f = int(ARGS[2])
        sc.frame_set(f)
        sc.render.filepath = ARGS[1] + '%05d.jpg' % f
        bpy.ops.render.render(write_still=True)
    else:
        sc.render.filepath = ARGS[1]
        sc.frame_start, sc.frame_end = int(ARGS[2]), int(ARGS[3])
        sc.render.use_overwrite = False
        sc.render.use_placeholder = True
        bpy.ops.render.render(animation=True)
print('DONE')
