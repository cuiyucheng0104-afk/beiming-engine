"""懂你的人 · ④ 镜片即入口 / ⑤ 陈默的书桌：Blender 静帧
用法：Blender -b --factory-startup --python lens_scene.py -- <shot> <out.png>
shot: hero / closeup / through / off / brand / desk"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
SHOT, OUTP = args[0], args[1]
SRC = os.path.expanduser('~/Desktop/懂你的人/素材/')


# ---------------------------------------------------------------- 基础
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 160
    sc.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = 'GPU'
    except Exception as e:
        print('GPU off', e)
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.cycles.max_bounces = 16
    sc.cycles.transmission_bounces = 16
    sc.cycles.glossy_bounces = 8
    w = bpy.data.worlds.new('W')
    sc.world = w
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0, 0, 0, 1)
    bg.inputs[1].default_value = 0
    return sc


def node(nt, t):
    return next(n for n in nt.nodes if n.type == t)


def mat_principled(name, base, rough=.3, metal=0, transm=0, ior=1.5, coat=0, emit=None, estr=0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = node(m.node_tree, 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = base + (1,)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Transmission Weight'].default_value = transm
    p.inputs['IOR'].default_value = ior
    p.inputs['Coat Weight'].default_value = coat
    if emit:
        p.inputs['Emission Color'].default_value = emit + (1,)
        p.inputs['Emission Strength'].default_value = estr
    return m


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def image_mat(name, path, strength=1.0, hide_from_camera=False):
    """原画卡片：自发光贴图；hide_from_camera=True 时只在镜片折射里看得见"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type != 'OUTPUT_MATERIAL':
            nt.nodes.remove(n)
    out = node(nt, 'OUTPUT_MATERIAL')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = strength
    nt.links.new(tex.outputs['Color'], em.inputs['Color'])
    if hide_from_camera:
        lp = nt.nodes.new('ShaderNodeLightPath')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(lp.outputs['Is Transmission Ray'], mix.inputs[0])
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


def card(name, img, w, loc, rot=(math.pi / 2, 0, 0), strength=1.0, hide=False, mat=None):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (w, w * 940 / 1672, 1)
    ob.data.materials.append(mat or image_mat(name + 'M', SRC + img, strength, hide))
    return ob


# ---------------------------------------------------------------- 眼镜
def outline(a, b, n=4.0, k=96, cx=0.0):
    pts = []
    for i in range(k):
        t = i / k * 2 * math.pi
        c, s = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(c) ** (2 / n), c)
        z = b * math.copysign(abs(s) ** (2 / n), s)
        z += .0018 * (x / a) ** 2 * (1 if z > 0 else 0)       # 上沿略平
        pts.append((cx + x, 0, z))
    return pts


def curve_obj(name, pts, depth, cyclic=True, mat=None, res=6):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = depth
    cu.bevel_resolution = res
    cu.fill_mode = 'FULL'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for p, q in zip(sp.points, pts):
        p.co = (q[0], q[1], q[2], 1)
    sp.use_cyclic_u = cyclic
    ob = bpy.data.objects.new(name, cu)
    if mat:
        cu.materials.append(mat)
    return link(ob)


def lens_mesh(name, a, b, cx, mat, bulge=.004, thick=.0016):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = 10
    k = 96
    center = bm.verts.new((cx, -bulge, 0))
    prev = None
    rows = []
    for r in range(1, rings + 1):
        f = r / rings
        row = []
        for (x, y, z) in outline(a * f, b * f, 4.0, k, 0):
            d2 = (x / a) ** 2 + (z / b) ** 2
            row.append(bm.verts.new((cx + x, -bulge * (1 - min(1, d2)), z)))
        rows.append(row)
    for i in range(k):
        bm.faces.new((center, rows[0][i], rows[0][(i + 1) % k]))
    for r in range(rings - 1):
        for i in range(k):
            bm.faces.new((rows[r][i], rows[r + 1][i], rows[r + 1][(i + 1) % k], rows[r][(i + 1) % k]))
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons:
        p.use_smooth = True
    sol = ob.modifiers.new('S', 'SOLIDIFY')
    sol.thickness = thick
    me.materials.append(mat)
    return ob


def rim_mesh(name, a, b, cx, mat, wx=.0062, wz=.0052, depth=.0058, n=3.6, k=120):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    inner = outline(a, b, n, k, 0)
    outer = outline(a + wx, b + wz, n, k, 0)
    rings = []
    for pts, y in ((outer, -depth / 2), (inner, -depth / 2), (inner, depth / 2), (outer, depth / 2)):
        rings.append([bm.verts.new((cx + x, y, z)) for x, _, z in pts])
    for r in range(4):
        A, B = rings[r], rings[(r + 1) % 4]
        for i in range(k):
            bm.faces.new((A[i], A[(i + 1) % k], B[(i + 1) % k], B[i]))
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    for p in me.polygons:
        p.use_smooth = True
    bv = ob.modifiers.new('B', 'BEVEL')
    bv.width, bv.segments = .0011, 3
    me.materials.append(mat)
    return ob


def glasses(loc=(0, 0, 0), rot=(0, 0, 0), led=True):
    acetate = mat_principled('acetate', (.004, .004, .005), rough=.38, coat=.35)
    glass = mat_principled('glass', (1, 1, 1), rough=0.0, transm=1.0, ior=1.52)
    parts = []
    a, b, gap = .0265, .0185, .0115
    for s in (-1, 1):
        cx = s * (a + gap)
        parts.append(lens_mesh('lens%d' % s, a + .001, b + .001, cx, glass))
        parts.append(rim_mesh('rim%d' % s, a, b, cx, acetate))
        # 镜腿
        x0 = s * (2 * a + gap + .0062)
        tpts = [(x0, .0, .012), (x0 + s * .004, .01, .012), (x0 + s * .006, .06, .011), (x0 + s * .005, .12, .009),
                (x0 + s * .004, .135, -.004), (x0 + s * .003, .14, -.016)]
        parts.append(curve_obj('temple%d' % s, tpts, .0028, cyclic=False, mat=acetate, res=4))
    br = [(-gap, 0, .012), (-.005, 0, .0145), (0, 0, .015), (.005, 0, .0145), (gap, 0, .012)]
    parts.append(curve_obj('bridge', br, .0034, cyclic=False, mat=acetate))
    if led:   # 原画里镜腿前端那颗青色小灯
        bpy.ops.mesh.primitive_uv_sphere_add(radius=.0016, location=(2 * a + gap + .0095, .006, .012))
        d = bpy.context.active_object
        d.data.materials.append(mat_principled('led', (.2, 1, .9), emit=(.25, 1, .95), estr=40))
        parts.append(d)
    root = bpy.data.objects.new('GLASSES', None)
    link(root)
    for p in parts:
        p.parent = root
    root.location, root.rotation_euler = loc, rot
    return root


def strip(name, loc, rot, size=(2.5, .04), power=600, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA')
    l.shape = 'RECTANGLE'
    l.size, l.size_y = size
    l.energy = power
    l.color = color
    ob = link(bpy.data.objects.new(name, l))
    ob.location, ob.rotation_euler = loc, rot
    return ob


def camera(loc, look, lens=50, fstop=None, focus=None):
    cam = bpy.data.cameras.new('cam')
    cam.lens = lens
    cam.clip_start = .001
    ob = link(bpy.data.objects.new('cam', cam))
    ob.location = loc
    d = Vector(look) - Vector(loc)
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    if fstop:
        cam.dof.use_dof = True
        cam.dof.aperture_fstop = fstop
        cam.dof.focus_distance = focus if focus else d.length
    bpy.context.scene.camera = ob
    return ob


def studio_lights(k=1.0):
    strip('L_back_l', (-.35, .45, .05), (math.radians(90), 0, math.radians(-35)), (1.6, .04), 26 * k)
    strip('L_back_r', (.35, .45, .05), (math.radians(90), 0, math.radians(35)), (1.6, .04), 26 * k)
    strip('L_top', (0, .05, .55), (0, 0, 0), (1.2, .05), 14 * k)
    strip('L_side', (-.6, -.1, .05), (math.radians(90), 0, math.radians(-80)), (1.4, .04), 12 * k, (1, .93, .85))


def floor(dark=True):
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, -.06))
    f = bpy.context.active_object
    f.data.materials.append(mat_principled('floor', (.004, .004, .005), rough=.12, coat=.3))
    return f


# ---------------------------------------------------------------- 镜头
def shot_hero():
    reset()
    g = glasses(rot=(0, 0, math.radians(-14)))
    studio_lights()
    floor()
    card('memory', 'i02.png', .5, (.0, .30, -.11), hide=True, strength=1.4)
    camera((.07, -.30, .03), (.0, 0, .0), lens=65, fstop=22)


def shot_closeup():
    reset()
    g = glasses(rot=(0, 0, math.radians(-6)))
    studio_lights(.7)
    card('memory', 'i05.png', .22, (.03, .09, .0), hide=True, strength=1.7)
    camera((.044, -.075, .004), (.036, 0, .0), lens=38, fstop=22, focus=.1)


def shot_through():
    reset()
    g = glasses(rot=(0, 0, math.radians(-3)))
    studio_lights(.5)
    card('memory', 'i05.png', .25, (.035, .10, .0), hide=False, strength=1.5)
    camera((.036, -.016, .002), (.036, .1, .0), lens=24, fstop=1.4, focus=.11)


def shot_off():
    reset()
    g = glasses(loc=(-.06, -.02, -.042), rot=(math.radians(-82), 0, math.radians(28)), led=False)
    bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0, -.06))
    t = bpy.context.active_object
    t.data.materials.append(mat_principled('table', (.08, .045, .025), rough=.35, coat=.3))
    card('stage', 'i16.png', 1.3, (.12, .62, .3), strength=1.25)
    strip('L_warm', (.3, .1, .4), (math.radians(40), 0, math.radians(30)), (.6, .3), 90, (1, .82, .6))
    camera((-.11, -.24, .02), (-.0, .3, .1), lens=22, fstop=3.2, focus=.24)


def shot_brand():
    reset()
    g = glasses(rot=(0, 0, math.radians(-24)))
    studio_lights(1.1)
    floor()
    camera((.07, -.33, .085), (0, 0, -.004), lens=70, fstop=5.6)


def shot_desk():
    reset()
    sc = bpy.context.scene
    sc.world.node_tree.nodes['Background'].inputs[1].default_value = .25 if 'Background' in sc.world.node_tree.nodes else 0
    bg = node(sc.world.node_tree, 'BACKGROUND')
    bg.inputs[0].default_value = (.35, .3, .26, 1)
    bg.inputs[1].default_value = .35
    # 木桌
    m = bpy.data.materials.new('wood')
    m.use_nodes = True
    nt = m.node_tree
    p = node(nt, 'BSDF_PRINCIPLED')
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 3
    wave.inputs['Distortion'].default_value = 6
    wave.inputs['Detail'].default_value = 4
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (.28, .15, .07, 1)
    ramp.color_ramp.elements[1].color = (.55, .34, .17, 1)
    nt.links.new(wave.outputs['Fac'], ramp.inputs[0])
    nt.links.new(ramp.outputs['Color'], p.inputs['Base Color'])
    p.inputs['Roughness'].default_value = .45
    bpy.ops.mesh.primitive_plane_add(size=2.4, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(m)
    paper = mat_principled('paper', (.92, .9, .85), rough=.8)

    def photo(img, w, loc, rz):
        bpy.ops.mesh.primitive_plane_add(size=1, location=(loc[0], loc[1], .0012))
        b = bpy.context.active_object
        b.scale = (w + .012, (w * 940 / 1672) + .012, 1)
        b.rotation_euler = (0, 0, rz)
        b.data.materials.append(paper)
        sol = b.modifiers.new('S', 'SOLIDIFY')
        sol.thickness = .0008
        mt = bpy.data.materials.new(img)
        mt.use_nodes = True
        tex = mt.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(SRC + img)
        pp = node(mt.node_tree, 'BSDF_PRINCIPLED')
        mt.node_tree.links.new(tex.outputs['Color'], pp.inputs['Base Color'])
        pp.inputs['Roughness'].default_value = .35
        bpy.ops.mesh.primitive_plane_add(size=1, location=(loc[0], loc[1], .0024))
        im = bpy.context.active_object
        im.scale = (w, w * 940 / 1672, 1)
        im.rotation_euler = (0, 0, rz)
        im.data.materials.append(mt)

    photo('i02.png', .16, (-.2, .05), .12)
    photo('i10.png', .17, (.02, .16), -.05)
    photo('i16.png', .19, (.2, .02), .08)
    photo('i05.png', .14, (-.03, -.07), -.14)
    # 手机：屏幕亮着第 7 页
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.25, -.16, .004))
    ph = bpy.context.active_object
    ph.scale = (.075, .155, .008)
    ph.rotation_euler = (0, 0, .35)
    bev = ph.modifiers.new('B', 'BEVEL')
    bev.width, bev.segments = .008, 6
    ph.data.materials.append(mat_principled('phone', (.02, .02, .025), rough=.2, coat=1))
    scr = image_mat('scr', SRC + 'i07.png', 1.4)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(.25, -.16, .0085))
    s = bpy.context.active_object
    s.scale = (.068 * 940 / 1672 * 2.0, .068 * 2.0, 1)
    s.scale = (.0665, .145, 1)
    s.rotation_euler = (0, 0, .35)
    s.data.materials.append(scr)
    # 马克杯
    bpy.ops.mesh.primitive_cylinder_add(radius=.04, depth=.09, location=(-.28, -.15, .045))
    bpy.context.active_object.data.materials.append(mat_principled('mug', (.85, .82, .76), rough=.3))
    # 眼镜放在桌上
    glasses(loc=(-.06, -.2, .018), rot=(math.radians(-80), 0, math.radians(15)))
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.5
    sun.angle = math.radians(3)
    sun.color = (1, .86, .66)
    so = link(bpy.data.objects.new('sun', sun))
    so.rotation_euler = (math.radians(62), 0, math.radians(-125))
    camera((-.05, -.62, .42), (.0, .0, 0), lens=42, fstop=4, focus=.72)


{'hero': shot_hero, 'closeup': shot_closeup, 'through': shot_through, 'off': shot_off,
 'brand': shot_brand, 'desk': shot_desk}[SHOT]()
sc = bpy.context.scene
sc.render.filepath = OUTP
sc.render.image_settings.file_format = 'PNG'
bpy.ops.render.render(write_still=True)
print('WROTE', OUTP)
