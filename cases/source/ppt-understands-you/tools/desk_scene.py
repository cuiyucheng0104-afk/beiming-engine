"""懂你的人 · ⑤ 陈默的书桌：Blender 静帧
用法：Blender -b --factory-startup --python desk_scene.py -- <shot> <out.png>
shot: d1_wide / d2_photo / d3_phone / d4_lens / d5_notebook / d6_gift"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

HERE = os.path.expanduser('~/Desktop/懂你的人/tools/')
exec(open(HERE + 'lens_scene.py').read().split("\n{'hero'")[0])        # 复用眼镜、相机、材质等
TEX = os.path.expanduser('~/Desktop/懂你的人/风格样张/陈默的书桌/tex/')


def tex_mat(name, path, rough=.5, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = node(nt, 'BSDF_PRINCIPLED')
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = bpy.data.images.load(path)
    nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = rough
    if emit:
        nt.links.new(t.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = emit
    return m


def plane(name, mat, w, h, loc, rot=(0, 0, 0), thick=0.0):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (w, h, 1)
    ob.data.materials.append(mat)
    if thick:
        s = ob.modifiers.new('S', 'SOLIDIFY')
        s.thickness = thick / max(w, h)
    return ob


PAPER = None


def photo(img, w, loc, rz=0.0, rx=0.0, z=.0012):
    global PAPER
    PAPER = PAPER or mat_principled('paperw', (.93, .91, .87), rough=.75)
    h = w * 940 / 1672
    root = bpy.data.objects.new('ph_' + img, None)
    link(root)
    b = plane('border', PAPER, w + .012, h + .012, (0, 0, 0), thick=.0008)
    im = plane('img', tex_mat(img, SRC + img, .3), w, h, (0, 0, .0009))
    for o in (b, im):
        o.parent = root
    root.location = (loc[0], loc[1], z)
    root.rotation_euler = (rx, 0, rz)
    return root


def desk_base(night=False):
    reset()
    sc = bpy.context.scene
    sc.cycles.samples = 200
    bg = node(sc.world.node_tree, 'BACKGROUND')
    bg.inputs[0].default_value = (.32, .27, .22, 1) if not night else (.02, .03, .07, 1)
    bg.inputs[1].default_value = .3 if not night else .25
    # 木桌
    m = bpy.data.materials.new('wood')
    m.use_nodes = True
    nt = m.node_tree
    p = node(nt, 'BSDF_PRINCIPLED')
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 2.4
    wave.inputs['Distortion'].default_value = 7
    wave.inputs['Detail'].default_value = 6
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (.26, .14, .065, 1)
    ramp.color_ramp.elements[1].color = (.52, .32, .16, 1)
    nt.links.new(wave.outputs['Fac'], ramp.inputs[0])
    nt.links.new(ramp.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = .42
    p.inputs['Coat Weight'].default_value = .25
    plane('desk', m, 2.4, 1.6, (0, 0, 0))
    # 墙和窗
    plane('wall', mat_principled('wall', (.78, .74, .68), rough=.9), 2.4, 1.2, (0, .62, .6), (math.pi / 2, 0, 0))
    sky = mat_principled('sky', (0, 0, 0), emit=(1, .9, .75) if not night else (.15, .22, .55), estr=5 if not night else 1.2)
    plane('window', sky, .7, .5, (-.35, .615, .42), (math.pi / 2, 0, 0))
    if not night:
        sun = bpy.data.lights.new('sun', 'SUN')
        sun.energy = 5.0
        sun.angle = math.radians(2)
        sun.color = (1, .84, .62)
        so = link(bpy.data.objects.new('sun', sun))
        so.rotation_euler = (math.radians(66), 0, math.radians(245))
    else:
        moon = bpy.data.lights.new('moon', 'SUN')
        moon.energy = .35
        moon.color = (.55, .65, 1)
        mo = link(bpy.data.objects.new('moon', moon))
        mo.rotation_euler = (math.radians(55), 0, math.radians(200))
    # 物件
    photo('i02.png', .17, (-.24, .08), .14)
    photo('i10.png', .18, (.0, .2), -.05)
    photo('i05.png', .15, (-.04, -.05), -.16)
    plane('note', tex_mat('note', TEX + 'note.png', .7), .085, .085, (-.13, .21, .0016), (0, 0, .2), thick=.0006)
    nb = plane('notebook', tex_mat('nb', TEX + 'notebook.png', .7), .40, .267, (.27, -.01, .004), (0, 0, -.08), thick=.006)
    # 手机（横放），屏幕亮着第 7 页
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.33, -.24, .005))
    ph = bpy.context.active_object
    ph.scale = (.155, .074, .009)
    ph.rotation_euler = (0, 0, .28)
    bv = ph.modifiers.new('B', 'BEVEL')
    bv.width, bv.segments = .009, 6
    ph.data.materials.append(mat_principled('phone', (.02, .02, .025), rough=.2, coat=1))
    plane('screen', tex_mat('scr', TEX + 'phone.png', .15, emit=1.6 if night else 1.0), .145, .066, (.33, -.24, .0097), (0, 0, .28))
    bpy.ops.mesh.primitive_cylinder_add(radius=.04, depth=.095, location=(-.36, -.12, .0475))
    bpy.context.active_object.data.materials.append(mat_principled('mug', (.86, .83, .77), rough=.25, coat=.6))
    return sc


def desk_lamp(on=True):
    shade = mat_principled('shade', (.12, .26, .2), rough=.35, metal=.6)
    bpy.ops.mesh.primitive_cylinder_add(radius=.06, depth=.015, location=(-.42, .28, .0075))
    bpy.context.active_object.data.materials.append(shade)
    bpy.ops.mesh.primitive_cylinder_add(radius=.007, depth=.36, location=(-.42, .28, .18))
    bpy.context.active_object.data.materials.append(shade)
    bpy.ops.mesh.primitive_cone_add(radius1=.08, radius2=.03, depth=.09, location=(-.31, .2, .33), rotation=(math.radians(-25), math.radians(40), 0))
    bpy.context.active_object.data.materials.append(shade)
    if on:
        l = bpy.data.lights.new('lamp', 'SPOT')
        l.energy = 55
        l.color = (1, .78, .5)
        l.spot_size = math.radians(95)
        l.spot_blend = .6
        l.shadow_soft_size = .02
        lo = link(bpy.data.objects.new('lamp', l))
        lo.location = (-.29, .18, .30)
        lo.rotation_euler = (math.radians(30), math.radians(28), 0)


# ---------------------------------------------------------------- 镜头
def d1_wide():
    desk_base()
    glasses(loc=(-.1, -.2, .019), rot=(math.radians(-80), 0, math.radians(14)))
    desk_lamp(False)
    camera((-.04, -.78, .5), (.0, .02, 0), lens=36, fstop=5.6, focus=.9)


def d2_photo():
    desk_base()
    glasses(loc=(-.1, -.2, .019), rot=(math.radians(-80), 0, math.radians(14)))
    camera((-.29, -.07, .17), (-.24, .085, 0), lens=55, fstop=4, focus=.235)


def d3_phone():
    desk_base()
    glasses(loc=(.22, -.32, .019), rot=(math.radians(-80), 0, math.radians(-20)))
    camera((.25, -.43, .16), (.33, -.23, 0), lens=50, fstop=3.2, focus=.27)


def d4_lens():
    desk_base()
    # 眼镜立在桌上，镜片对着一张斜靠在马克杯上的照片
    glasses(loc=(-.2, -.24, .021), rot=(0, 0, math.radians(4)))
    photo('i05.png', .16, (-.21, -.09), 0, rx=math.radians(72), z=.045)
    l = bpy.data.lights.new('fill', 'AREA')
    l.size = .3
    l.energy = 6
    l.color = (1, .9, .78)
    lo = link(bpy.data.objects.new('fill', l))
    lo.location = (-.12, -.2, .25)
    lo.rotation_euler = (math.radians(35), 0, math.radians(20))
    camera((-.225, -.42, .036), (-.212, -.09, .042), lens=75, fstop=5.6, focus=.33)


def d5_notebook():
    desk_base()
    glasses(loc=(.06, -.2, .019), rot=(math.radians(-80), 0, math.radians(30)))
    camera((.25, -.33, .36), (.27, -.02, 0), lens=42, fstop=4, focus=.48)


def d6_gift():
    desk_base(night=True)
    desk_lamp(True)
    # 星光包裹：盒子 + 半开的盖子 + 盒里的新眼镜和光点
    box = mat_principled('box', (.12, .14, .32), rough=.45)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.0, -.12, .035))
    b = bpy.context.active_object
    b.scale = (.17, .11, .07)
    b.data.materials.append(box)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.0, -.12, .047))
    inner = bpy.context.active_object
    inner.scale = (.155, .095, .07)
    bool_ = b.modifiers.new('cut', 'BOOLEAN')
    bool_.object = inner
    bool_.operation = 'DIFFERENCE'
    inner.hide_render = True
    lid = plane('lid', tex_mat('star', TEX + 'starpaper.png', .5, emit=.6), .175, .115, (.0, -.045, .115), (math.radians(-75), 0, 0), thick=.004)
    glasses(loc=(.0, -.12, .06), rot=(math.radians(-82), 0, math.radians(4)))
    glow = mat_principled('glow', (1, .85, .5), emit=(1, .82, .5), estr=22)
    import random
    random.seed(4)
    for i in range(70):
        bpy.ops.mesh.primitive_ico_sphere_add(radius=random.uniform(.0003, .0008), subdivisions=1,
                                              location=(random.uniform(-.08, .08), -.12 + random.uniform(-.05, .05), .07 + random.random() * .09))
        bpy.context.active_object.data.materials.append(glow)
    pl = bpy.data.lights.new('boxglow', 'POINT')
    pl.energy = 6
    pl.color = (1, .82, .5)
    pl.shadow_soft_size = .03
    po = link(bpy.data.objects.new('boxglow', pl))
    po.location = (0, -.12, .07)
    photo('i20.png', .15, (.17, -.27), .25)
    camera((.06, -.38, .27), (.0, -.12, .03), lens=48, fstop=4, focus=.36)


{'d1_wide': d1_wide, 'd2_photo': d2_photo, 'd3_phone': d3_phone, 'd4_lens': d4_lens,
 'd5_notebook': d5_notebook, 'd6_gift': d6_gift}[SHOT]()
sc = bpy.context.scene
sc.render.filepath = OUTP
sc.render.image_settings.file_format = 'PNG'
bpy.ops.render.render(write_still=True)
print('WROTE', OUTP)
