"""翻滚车白模：Saab 9-5（2010）比例的轿车，车头 +Y、车顶 +Z、原点在包围盒中心。
车身用侧面轮廓做凸包，加深色车窗、白大灯、红尾灯、黑格栅、白车牌，前后一眼可分。"""
import bpy
import bmesh
from mathutils import Vector

L, W, H = 5.0, 1.87, 1.47
ZC = H / 2                                  # 原点离地高度（包围盒中心）
AXLE_F, AXLE_R, WHEEL_R = 1.47, -1.37, 0.34

# 侧面轮廓 (y, z)，z 从地面算。下车身（腰线以下，全宽）与车舱（腰线以上，收窄）分别做凸包，
# 保留"引擎盖低、挡风玻璃根部凹进去"的轮廓
LOWER = [(-2.5, 0.28), (-2.5, 0.8), (-2.42, 0.97), (-1.55, 1.0), (1.2, 0.98), (2.42, 0.84), (2.5, 0.6),
         (2.45, 0.28)]
CABIN_BASE = [(-1.55, 0.99), (1.2, 0.97)]          # 车舱底（腰线）
CABIN_TOP = [(-0.85, 1.44), (0.35, 1.47)]          # 车顶前后沿
HALF_LOW, HALF_BELT, HALF_ROOF = W / 2, 0.86, 0.7


def lower_points():
    pts = [(sx * HALF_LOW, y, z - ZC) for sx in (-1, 1) for y, z in LOWER]
    return pts


def tire_points():
    return [(sx * (HALF_LOW - 0.12), y, 0.0 - ZC) for sx in (-1, 1) for y in (AXLE_F, AXLE_R)]   # 轮胎底


def cabin_points():
    pts = [(sx * HALF_BELT, y, z - ZC) for sx in (-1, 1) for y, z in CABIN_BASE]
    pts += [(sx * HALF_ROOF, y, z - ZC) for sx in (-1, 1) for y, z in CABIN_TOP]
    return pts


def hull_points():
    return lower_points() + cabin_points() + tire_points()


def _mesh(name, build):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _mat(name, rgb, emit=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = 0.6
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*rgb, 1)
    return m


def _quad(name, corners, mat, parent):
    def build(bm):
        vs = [bm.verts.new(c) for c in corners]
        bm.faces.new(vs)
    o = _mesh(name, build)
    o.data.materials.append(mat)
    o.parent = parent
    return o


def _box(name, size, loc, mat, parent):
    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    o = _mesh(name, build)
    o.location = loc
    o.data.materials.append(mat)
    o.parent = parent
    return o


def build(parent, body_rgb=(0.85, 0.42, 0.12)):
    body_m = _mat("car_body", body_rgb)
    glass = _mat("car_glass", (0.04, 0.05, 0.07))
    head = _mat("car_headlight", (1.0, 0.97, 0.85), emit=1.5)
    tail = _mat("car_taillight", (0.9, 0.05, 0.04), emit=1.0)
    dark = _mat("car_dark", (0.03, 0.03, 0.03))
    plate = _mat("car_plate", (0.95, 0.95, 0.95))

    def hull(pts):
        def f(bm):
            vs = [bm.verts.new(p) for p in pts]
            bmesh.ops.convex_hull(bm, input=vs)
        return f
    o = _mesh("flip_body", hull(lower_points()))
    o.data.materials.append(body_m)
    o.parent = parent
    cab = _mesh("flip_cabin", hull(cabin_points()))
    cab.data.materials.append(body_m)
    cab.parent = parent

    z = lambda v: v - ZC                                    # noqa: E731
    e = 0.015                                               # 贴面外移，避免 z-fighting

    def on_slope(y0, z0, y1, z1, half0, half1, inset=0.06):
        """沿车舱斜面贴一块玻璃：从 (y0,z0) 半宽 half0 到 (y1,z1) 半宽 half1，法线方向外移 e。"""
        d = Vector((0, y1 - y0, z1 - z0)).normalized()
        n = Vector((0, -d.z, d.y)) if y1 < y0 else Vector((0, d.z, -d.y))
        if n.z < 0:
            n = -n
        a0 = Vector((0, y0, z(z0))) + d * inset + n * e
        a1 = Vector((0, y1, z(z1))) - d * inset + n * e
        return [(-half0 + inset, a0.y, a0.z), (half0 - inset, a0.y, a0.z),
                (half1 - inset, a1.y, a1.z), (-half1 + inset, a1.y, a1.z)]
    _quad("windshield", on_slope(1.2, 0.97, 0.35, 1.47, HALF_BELT, HALF_ROOF), glass, parent)
    _quad("rear_window", on_slope(-1.55, 0.99, -0.85, 1.44, HALF_BELT, HALF_ROOF), glass, parent)
    for sx in (-1, 1):                                      # 侧窗：腰线到车顶之间的侧斜面
        b0, b1 = sx * (HALF_BELT + e), sx * (HALF_ROOF + e + 0.02)
        _quad(f"side_window_{sx}", [(b0, 1.0, z(1.02)), (b0, -1.4, z(1.03)),
                                    (b1, -0.8, z(1.4)), (b1, 0.3, z(1.42))], glass, parent)
        _box(f"headlight_{sx}", (0.42, 0.06, 0.14), (sx * 0.62, 2.45, z(0.74)), head, parent)
        _box(f"taillight_{sx}", (0.36, 0.06, 0.16), (sx * 0.66, -2.5, z(0.86)), tail, parent)
        for ay, nm in ((AXLE_F, "f"), (AXLE_R, "r")):
            w = _mesh(f"wheel_{nm}{sx}", lambda bm: bmesh.ops.create_cone(
                bm, cap_ends=True, segments=20, radius1=WHEEL_R, radius2=WHEEL_R, depth=0.24))
            w.location, w.rotation_euler = (sx * (HALF_LOW - 0.1), ay, z(WHEEL_R)), (0, 1.5708, 0)
            w.data.materials.append(dark)
            w.parent = parent
    _box("underbody", (W - 0.2, L - 0.4, 0.03), (0, 0, z(0.28) - 0.012), dark, parent)   # 深色底盘：翻起来能认出来
    _box("grille", (0.7, 0.05, 0.16), (0, 2.49, z(0.6)), dark, parent)
    _box("plate", (0.52, 0.04, 0.12), (0, -2.51, z(0.62)), plate, parent)
    return o


def rest_height(rot3):
    """给定车身朝向（3x3），返回车身最低点贴地时原点的离地高度。"""
    return -min((rot3 @ Vector(p)).z for p in hull_points())
