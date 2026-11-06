"""从源码重建整场白模：地面/峡谷、轨道、火车、桁架桥、卡车/科尔维特/人物插槽、25 个镜头相机。
    Blender -b --factory-startup --python-exit-code 1 -P build.py -- --save out/previs.blend
物体运动按主时间轴 world.py 逐帧求值后打关键帧（每个剪辑帧一帧），镜头相机来自 data/cams.json，
用时间线标记按镜头切换相机。"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import calib as cb  # noqa: E402
import world as wd  # noqa: E402
import human as hm  # noqa: E402
import poses as ps  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SAVE = argv[argv.index("--save") + 1] if "--save" in argv else None

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps, sc.frame_start, sc.frame_end = cb.FPS, 1, cb.FRAMES
sc.render.resolution_x, sc.render.resolution_y = cb.RES
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "MATERIAL"
sc.display.shading.show_shadows = True
sc.display.shading.show_cavity = True
sc.world = bpy.data.worlds.new("W")
sc.world.color = (0.75, 0.8, 0.85)


def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    return m


M = {k: mat(k, v) for k, v in {
    "ground": (0.72, 0.6, 0.42), "canyon": (0.5, 0.36, 0.25), "rail": (0.25, 0.22, 0.2),
    "car": (0.78, 0.78, 0.8), "band": (0.18, 0.2, 0.32), "truss": (0.28, 0.2, 0.15),
    "truck": (0.3, 0.3, 0.28), "cv": (0.85, 0.85, 0.88), "tire": (0.08, 0.08, 0.08),
    "brian": (0.25, 0.35, 0.2), "dom": (0.15, 0.15, 0.15)}.items()}


def box(name, size, loc=(0, 0, 0), m=None, parent=None, rot=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    sx, sy, sz = (s / 2 for s in size)
    v = [(x * sx, y * sy, z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    if m:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    ob.location, ob.rotation_euler = loc, rot
    if parent:
        ob.parent = parent
    return ob


def beam(name, a, b, t, m, parent=None):
    a, b = Vector(a), Vector(b)
    d = b - a
    ob = box(name, (t, t, d.length), (a + b) / 2, m, parent)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return ob


def empty(name, parent=None):
    ob = bpy.data.objects.new(name, None)
    sc.collection.objects.link(ob)
    ob.empty_display_size = 1.0
    if parent:
        ob.parent = parent
    return ob


# ---------------------------------------------------------------- 地面与峡谷
# 右侧崖边：过 (RIM_X0, -6) 点、与轨道夹角 RIM_ANGLE，往 −X 方向离轨道越来越远
ang = math.radians(cb.RIM_ANGLE_DEG)
def rim_y(x):
    return -6.0 - (cb.RIM_X0 - x) * math.tan(ang)
me = bpy.data.meshes.new("ground")
xs = list(range(-1200, 1201, 50))
far = 1500
verts, faces = [], []
for x in xs:                                   # 平台：轨道左侧全部 + 右侧到崖边
    verts += [(x, far, 0), (x, rim_y(x) if x < cb.RIM_X0 + 40 else -6.0, 0)]
for i in range(len(xs) - 1):
    faces.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
me.from_pydata(verts, [], faces)
me.materials.append(M["ground"])
g = bpy.data.objects.new("GROUND", me)
sc.collection.objects.link(g)
box("CANYON_FLOOR", (3000, 3000, 1), (0, -1500 - 6, -cb.CANYON_DEPTH), M["canyon"])
# 桥头以远（X > RIM_X0+40）轨道左侧也是峡谷：平台只铺到那里
box("FAR_RIM", (1200, far * 2, 2), (cb.BRIDGE_LEN + 600, 0, -1), M["ground"])
for x in range(-1200, int(cb.RIM_X0) + 40, 40):     # 崖壁（斜面）
    y0, y1 = rim_y(x), rim_y(x + 40)
    m2 = bpy.data.meshes.new("wall")
    m2.from_pydata([(x, y0, 0), (x + 40, y1, 0), (x + 40, y1 - 25, -cb.CANYON_DEPTH), (x, y0 - 25, -cb.CANYON_DEPTH)], [], [(0, 1, 2, 3)])
    m2.materials.append(M["canyon"])
    o = bpy.data.objects.new("CANYON_WALL", m2)
    sc.collection.objects.link(o)

# ---------------------------------------------------------------- 轨道
for s in (-1, 1):
    box(f"RAIL_{s}", (2400, 0.08, 0.16), (0, s * cb.RAIL_GAUGE / 2, 0.08), M["rail"])
box("BALLAST", (2400, 4.0, 0.3), (0, 0, -0.15), M["rail"])

# ---------------------------------------------------------------- 桁架桥（曲弦穿式桁架）
def top_z(x):
    s = x / cb.BRIDGE_LEN
    return cb.TRUSS_H_END + (cb.TRUSS_H_MID - cb.TRUSS_H_END) * math.sin(math.pi * s)
n = int(cb.BRIDGE_LEN / cb.TRUSS_PANEL)
for s in (-1, 1):
    y = s * cb.TRUSS_Y
    for i in range(n):
        x0, x1 = i * cb.TRUSS_PANEL, (i + 1) * cb.TRUSS_PANEL
        beam(f"BOT_{s}_{i}", (x0, y, 0.3), (x1, y, 0.3), 0.6, M["truss"])
        beam(f"TOP_{s}_{i}", (x0, y, top_z(x0)), (x1, y, top_z(x1)), 0.6, M["truss"])
        beam(f"VERT_{s}_{i}", (x1, y, 0.3), (x1, y, top_z(x1)), 0.45, M["truss"])
        a, b = ((x0, y, 0.3), (x1, y, top_z(x1))) if i < n / 2 else ((x0, y, top_z(x0)), (x1, y, 0.3))
        beam(f"DIAG_{s}_{i}", a, b, 0.4, M["truss"])
    beam(f"ENDPOST_{s}", (0, y, 0.0), (0, y, top_z(0)), 0.8, M["truss"])      # 桥头端柱（卡车撞的就是 −Y 这根）
for i in range(0, n + 1, 1):
    x = i * cb.TRUSS_PANEL
    beam(f"STRUT_{i}", (x, -cb.TRUSS_Y, top_z(x)), (x, cb.TRUSS_Y, top_z(x)), 0.35, M["truss"])
box("DECK", (cb.BRIDGE_LEN, 2 * cb.TRUSS_Y + 1, 1.2), (cb.BRIDGE_LEN / 2, 0, -0.6), M["truss"])

# ---------------------------------------------------------------- 火车
train = empty("TRAIN")
for i in range(cb.N_CARS):
    xc = -i * (cb.CAR_LEN + cb.CAR_GAP) - cb.CAR_LEN / 2
    c = box(f"CAR_{i}", (cb.CAR_LEN, cb.CAR_W, cb.CAR_H - 0.9), (xc, 0, 0.9 + (cb.CAR_H - 0.9) / 2), M["car"], train)   # 车顶 = CAR_H（与求解器一致）
    box(f"BAND_{i}", (cb.CAR_LEN * 0.96, cb.CAR_W + 0.04, 0.7), (xc, 0, 2.6), M["band"], train)
    for k in (-1, 1):
        box(f"BOGIE_{i}_{k}", (3.0, 2.6, 0.9), (xc + k * (cb.CAR_LEN / 2 - 3.5), 0, 0.45), M["rail"], train)

# ---------------------------------------------------------------- 插槽（换模型时替换 SLOT_* 的子物体）
cv = empty("SLOT_Corvette")                # 原点在车身中心正下方的地面；座舱敞开（特写机位要能看进去）
# v5：座舱是空的（只有地板、门槛、仪表台），人坐进去、车内机位不穿模
box("cv_front", (1.35, cb.CV_W, 0.42), (1.55, 0, 0.41), M["cv"], cv)          # 车头（脚坑以前）
box("cv_rear", (1.25, cb.CV_W, 0.42), (-1.6, 0, 0.41), M["cv"], cv)           # 车尾
box("cv_floor", (2.0, cb.CV_W, 0.1), (-0.1, 0, 0.25), M["cv"], cv)            # 座舱地板
box("cv_dash", (0.25, cb.CV_W * 0.9, 0.3), (0.75, 0, 0.72), M["cv"], cv)      # 仪表台
box("cv_hood", (1.7, cb.CV_W * 0.92, 0.2), (1.35, 0, 0.72), M["cv"], cv)
box("cv_deck", (1.2, cb.CV_W * 0.92, 0.22), (-1.6, 0, 0.73), M["cv"], cv)
for s in (-1, 1):
    box(f"cv_sill_{s}", (2.0, 0.1, 0.55), (-0.1, s * 0.83, 0.5), M["cv"], cv)
beam("cv_shield", (0.45, 0.75, 0.82), (0.45, -0.75, 0.82), 0.05, M["cv"], cv)
beam("cv_shield_top", (0.35, 0.75, 1.08), (0.35, -0.75, 1.08), 0.03, M["cv"], cv)
for s in (-1, 1):
    beam(f"cv_bar_{s}", (-0.75, s * 0.6, 0.8), (-0.75, s * 0.6, 1.25), 0.06, M["cv"], cv)
beam("cv_bar_top", (-0.75, 0.6, 1.25), (-0.75, -0.6, 1.25), 0.06, M["cv"], cv)
for k in (-1, 1):
    for s in (-1, 1):
        box(f"cv_wheel_{k}_{s}", (0.64, 0.22, 0.64), (k * cb.CV_WB / 2, s * 0.74, 0.32), M["tire"], cv)
for s in (-1, 1):                                  # 座椅：坐垫在骨盆下、靠背在背后（v5：不再是包住人的实心块）
    box(f"cv_seat_{s}", (0.45, 0.48, 0.08), (-0.45, s * 0.38, 0.33), M["tire"], cv)
    box(f"cv_seatback_{s}", (0.08, 0.48, 0.55), (-0.75, s * 0.38, 0.6), M["tire"], cv)

truck = empty("SLOT_Truck")                 # 原点在车身几何中心；局部 x 朝车头
# 改装重卡（v4，按 S03 第 95 帧侧面）：笼架驾驶室 + 长车斗板 + 四只大轮
box("truck_chassis", (cb.TRUCK_LEN * 0.95, 1.6, 0.45), (0, 0, -1.0), M["truck"], truck)
# 白色车斗板 = SLOT_Panel：起爆前斜躺在车斗位置随车走，起爆后就是被炸飞的那块"侧板"（S21 竖在火球上方的白板）
box("truck_cab_body", (2.6, 2.2, 1.1), (3.1, 0, -0.2), M["truck"], truck)
for i, x in enumerate((1.6, 4.5)):                   # 防滚笼架：两道门形框 + 顶部纵梁；顶在局部 z≈1.0（v4 实测离地约 3.4–4.0 m）
    for yy in (-1.15, 1.15):
        beam(f"cage_post_{i}_{yy}", (x, yy, -0.6), (x, yy, 1.0), 0.12, M["truck"], truck)
    beam(f"cage_top_{i}", (x, -1.15, 1.0), (x, 1.15, 1.0), 0.12, M["truck"], truck)
for yy in (-1.15, 1.15):
    beam(f"cage_rail_{yy}", (1.6, yy, 1.0), (4.5, yy, 1.0), 0.12, M["truck"], truck)
for i, x in enumerate((-3.5, -1.5, 0.5)):            # 车斗右侧笼架（S10/S11 布莱恩坐/趴的地方）
    beam(f"truck_cage_{i}", (x, -1.2, -0.55), (x, -1.2, 1.0), 0.1, M["truck"], truck)
beam("truck_cage_top", (-3.5, -1.2, 1.0), (0.5, -1.2, 1.0), 0.1, M["truck"], truck)
for k, ax in enumerate((wd.FRONT_AXLE, -0.6, wd.REAR_AXLE)):   # v4：一根前轴 + 两根后轴
    for s_ in (-1, 1):
        w = bpy.data.meshes.new("wheel")
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=20, radius1=0.62, radius2=0.62, depth=0.45)
        bm.to_mesh(w); bm.free()
        for poly in w.polygons:
            poly.use_smooth = len(poly.vertices) == 4          # 只圆滑胎面，端面保持平（否则渲染成球）
        w.materials.append(M["tire"])
        o = bpy.data.objects.new(f"truck_wheel_{k}_{s_}", w)
        sc.collection.objects.link(o)
        o.parent = truck
        o.location = (ax, s_ * cb.TRUCK_W / 2, -cb.TRUCK_H / 2 + 0.62)
        o.rotation_euler = (math.pi / 2, 0, 0)

# 车厢侧壁撕裂口（v4）：卡车车头插进去的地方，布尔挖空，挖刀挂在火车上随车走
tx0, tx1, tz0, tz1 = wd.P.get("tear", [-6.0, 8.0, 0.95, 3.55])
cutter = box("CAR_TEAR_CUTTER", (tx1 - tx0, 1.5, tz1 - tz0), (-wd.P["truck_to_front"] + (tx0 + tx1) / 2, -1.05, (tz0 + tz1) / 2),
             mat("car_interior", (0.12, 0.1, 0.09)), train)
cutter.hide_render = True
cutter.display_type = "WIRE"
for ob in list(train.children):
    if ob.name.startswith(("CAR_", "BAND_")) and ob is not cutter:
        md = ob.modifiers.new("tear", "BOOLEAN")
        md.operation, md.object = "DIFFERENCE", cutter
        md.solver = "EXACT"
        md.material_mode = "TRANSFER"                # 破口内壁用挖刀的暗色材质，看得出是个洞
# 车顶被顶起的鼓包（v4：缝后约 3–13 m，最高处约 4.6 m）
bulge = box("CAR_ROOF_BULGE", (10.0, 2.4, 0.15), (-wd.P["truck_to_front"] + 2.6 - 8.0, 0.2, 4.35), mat("car", (0.78, 0.78, 0.8)), train)
bulge.rotation_euler = (math.radians(-4), math.radians(-4), 0)                 # v5：抬到车顶以上、收进车顶宽度（原先压到车外的人）
panel = empty("SLOT_Panel")                 # 货厢侧板：起爆前贴在卡车车斗右侧，起爆后按拟合抛体独立飞
box("panel_board", (5.6, 0.14, cb.TRUCK_W), (0, 0, 0), mat("bed", (0.72, 0.72, 0.70)), panel)
box_ = empty("SLOT_Box")                    # 货厢：起爆前在卡车车斗上，起爆后被火车拖着翻滚
box("cargo_box", (4.5, 2.4, 1.6), (0, 0, 0), M["truck"], box_)
tire = empty("SLOT_Tire")                   # 备胎：起爆前挂在车斗里，起爆后独立飞
box("tire_body", (0.9, 0.3, 0.9), (0, 0, 0), M["tire"], tire)

# 人物：人体形体（椭球拼成的人台，平滑着色），每个部位是独立物体，逐帧按 poses.q_at 的正向运动学打世界位姿；
# SLOT_* 空物体只跟骨盆。换精细人物模型时，按 human.BODY 的部位名绑定即可
import bmesh  # noqa: E402

def ellipsoid(name, size, m):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=0.5)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    bm.to_mesh(me); bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    ob.rotation_mode = "QUATERNION"
    return ob


LOOK = {"brian": {"skin": (0.78, 0.58, 0.47), "shirt": (0.30, 0.34, 0.24), "pants": (0.22, 0.29, 0.44), "shoes": (0.16, 0.13, 0.11)},
        "dom": {"skin": (0.62, 0.45, 0.36), "shirt": (0.06, 0.06, 0.06), "pants": (0.17, 0.17, 0.19), "shoes": (0.08, 0.08, 0.08)}}
brian = empty("SLOT_Brian")
dom = empty("SLOT_Dom")
PARTS = {}
for who in LOOK:
    mats = {k: mat(f"{who}_{k}", v) for k, v in LOOK[who].items()}
    for nm, fr, anc, off, size, slot in hm.BODY:
        PARTS[(who, nm)] = (ellipsoid(f"{who}_{nm}", size, mats[slot]), fr, anc, off)

# ---------------------------------------------------------------- 逐帧求值打关键帧
for f in range(1, cb.FRAMES + 1):
    T = wd.T_of(f)
    train.location = (wd.train_front_x(T), 0, 0)
    train.keyframe_insert("location", frame=f)
    x, y, z, yaw, pitch = wd.truck_pose(T)
    if wd.BLAST is None or T < wd.BLAST["t_blast"]:
        x += wd.truck_cheat_x(f)                    # 逐镜头卡车作弊（S23，仅起爆前；起爆后的货厢/碎片按实测轨迹）
    truck.location, truck.rotation_euler = (x, y, z), (0, math.radians(pitch), math.radians(yaw))
    truck.keyframe_insert("location", frame=f); truck.keyframe_insert("rotation_euler", frame=f)
    pp = wd.panel_pose(T)
    if pp is None:                                   # 起爆前：平躺在车斗位置（卡车局部 (-1.55, 0, -0.62)），随卡车偏转/抬头
        Rt = Euler((0, math.radians(pitch), math.radians(yaw))).to_matrix()
        c = Vector((x, y, z)) + Rt @ Vector((-1.6, 0, -0.75))
        panel.location, panel.rotation_euler = tuple(c), (math.pi / 2, math.radians(pitch - 10.0), math.radians(yaw))   # 后端比车身再低约 10°
    else:
        panel.location, panel.rotation_euler = pp[:3], (0, math.radians(pp[4]), math.radians(pp[3]))
    panel.keyframe_insert("location", frame=f); panel.keyframe_insert("rotation_euler", frame=f)
    bp = wd.box_pose(T)
    if bp is None:                                   # 货厢：起爆前原片里看不到（车斗只是一块翘起的板），先藏到地下
        bp = (x, y, -50.0, yaw, pitch)
    box_.location, box_.rotation_euler = bp[:3], (0, math.radians(bp[4]), math.radians(bp[3]))
    box_.keyframe_insert("location", frame=f); box_.keyframe_insert("rotation_euler", frame=f)
    tp = wd.tire_pose(T)
    if tp is None:
        a = math.radians(yaw)
        tp = (x - 2.5 * math.cos(a), y - 2.5 * math.sin(a), z + 0.9, yaw, 0.0)
    tire.location, tire.rotation_euler = tp[:3], (0, math.radians(tp[4]), math.radians(tp[3]))
    tire.keyframe_insert("location", frame=f); tire.keyframe_insert("rotation_euler", frame=f)
    x, y, yaw = wd.corvette_f(f)
    cv.location, cv.rotation_euler = (x, y, 0), (0, 0, math.radians(yaw))
    cv.keyframe_insert("location", frame=f); cv.keyframe_insert("rotation_euler", frame=f)
    for who, slot in (("brian", brian), ("dom", dom)):
        J, FR = hm.fk_frames(ps.q_at(who, f))
        slot.location = tuple(J["pelvis"])
        slot.keyframe_insert("location", frame=f)
        for (w, nm), (o, fr, anc, off) in PARTS.items():
            if w != who:
                continue
            R = FR[fr]
            o.location = tuple(J[anc] + R @ np.asarray(off, float))
            o.rotation_quaternion = Matrix(R.tolist()).to_quaternion()
            o.keyframe_insert("location", frame=f); o.keyframe_insert("rotation_quaternion", frame=f)

# ---------------------------------------------------------------- 镜头相机
MOUNTS = {"world": None, "train": train, "truck": truck, "corvette": cv}
cams = json.load(open(os.path.join(ROOT, "data/cams.json")))
for shot, (a, b) in cb.SHOTS.items():
    c = cams.get(shot)
    cd = bpy.data.cameras.new(f"CAM_{shot}")
    cam = bpy.data.objects.new(f"CAM_{shot}", cd)
    sc.collection.objects.link(cam)
    cd.sensor_fit, cd.sensor_width = "HORIZONTAL", cb.SENSOR_W
    cd.clip_start, cd.clip_end = 0.05, 5000
    cam.rotation_mode = "QUATERNION"
    if c is None:
        continue
    cam.parent = MOUNTS[c["mount"]]
    for k in c["keys"]:                      # [帧, x, y, z, yaw, pitch, roll, hfov]
        f, x, y, z, yaw, pitch, roll, hfov = k
        cam.location = (x, y, z)
        cam.rotation_quaternion = (Euler((0, 0, math.radians(yaw - 90))).to_quaternion()
                                   @ Euler((math.radians(90 + pitch), 0, 0)).to_quaternion()
                                   @ Euler((0, 0, -math.radians(roll))).to_quaternion())
        cd.lens = cb.SENSOR_W / 2 / math.tan(math.radians(hfov) / 2)
        cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_quaternion", frame=f)
        cd.keyframe_insert("lens", frame=f)
    m = sc.timeline_markers.new(shot, frame=a)
    m.camera = cam
sc.camera = bpy.data.objects["CAM_S01"]

# 物体关键帧一律线性（逐帧都有键，切点处不插值穿帮）
for ob in bpy.data.objects:
    for dat in (ob.animation_data, getattr(ob.data, "animation_data", None)):
        if dat and dat.action:
            for fc in getattr(dat.action, "fcurves", []):
                for kp in fc.keyframe_points:
                    kp.interpolation = "LINEAR"
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, SAVE))
    print("saved", SAVE)
