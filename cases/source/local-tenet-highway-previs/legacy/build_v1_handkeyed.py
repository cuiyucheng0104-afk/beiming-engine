"""
高速公路倒放翻车 · 白模预演（10 秒 / 4 镜头 / 30fps / 960x448）

    Blender -b --factory-startup --python-exit-code 1 -P build.py -- --save out/previs.blend

结构（换模型只动 MODEL_*，动画都在 SLOT_* 上）：
    SLOT_Env                 场景插槽：路面、护栏、石墙、天桥、楼
    SLOT_HeroCar             本车插槽（正常时间，匀速前进）
      ├─ MODEL_HeroCar       本车白模（无玻璃，车内可见）
      ├─ SLOT_Driver / MODEL_Driver
      ├─ SLOT_Passenger / MODEL_Passenger
      └─ CAM_Driver / CAM_POV / CAM_Side
    SLOT_FlipCar             翻滚车插槽：动作 FlipCar_ForwardCrash（正向撞车），
      └─ MODEL_FlipCar       放进 NLA 片段并打开 Reversed，得到倒放效果

坐标：路沿 +Y，本车车道 x=+1.75，翻滚车最终在左车道 x=-1.75。单位米。
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
import boilerplate as bp  # noqa: E402
from bpy_extras import anim_utils  # noqa: E402

FPS = 30
FRAMES = 301                      # 0~10.0 秒
CUTS = {"S1": 1, "S2": 43, "S3": 207, "S4": 266}   # 切点 1.4s / 6.867s / 8.833s

HERO_SPEED = 20.0                 # m/s（72km/h），本车匀速
HERO_X = 1.75
CAR_L, CAR_W, CAR_H = 4.7, 1.8, 1.45

# 翻滚车正向撞车的时间轴（τ = 正向时间，秒；最终画面时间 t = 10 - τ）
TAU_DRIVE = 4.0                   # 正常行驶 τ 0~4.0      → 最终 6.0~10.0
TAU_ROLL = 2.7                    # 翻滚 540°  τ 4.0~6.7  → 最终 3.3~6.0
TAU_TOTAL = 8.6                   # 倒扣静止   τ 6.7~8.6  → 最终 1.4~3.3
FLIP_LEAD = 2.0                   # 并排时领先本车的距离
DECEL_POW = 2.5                   # 撞击瞬间减速最猛：v = v0·(1-u)^p


def t_of_frame(f):
    return (f - 1) / FPS


def smooth(u):
    u = min(max(u, 0.0), 1.0)
    return u * u * (3 - 2 * u)


# ------------------------------------------------------------------ 翻滚车正向撞车
def flip_forward(tau):
    """正向（实拍）时间 τ 的车辆位姿：车头朝 -Y 正常行驶 → 翻滚 1.5 圈 → 倒扣停下。
    返回 (location, rotation_euler)。"""
    y_start = HERO_SPEED * 10.0 + FLIP_LEAD          # τ=0 时与本车（最终 10s 处）并排
    if tau <= TAU_DRIVE:
        y = y_start - HERO_SPEED * tau
        return Vector((-HERO_X, y, CAR_H / 2)), (0.0, 0.0, math.pi)
    s = min(tau - TAU_DRIVE, TAU_ROLL)
    u = s / TAU_ROLL
    y_roll0 = y_start - HERO_SPEED * TAU_DRIVE
    slide = HERO_SPEED * TAU_ROLL / (DECEL_POW + 1)          # 翻滚段滑行总距离
    y = y_roll0 - slide * (1 - (1 - u) ** (DECEL_POW + 1))
    x = -HERO_X + (HERO_X + 1.2) * smooth(u / 0.5)          # 前半段就甩到路中偏右
    roll = 3 * math.pi * (1 - (1 - u) ** 1.6)        # 540°，越转越慢，最后倒扣
    hop = 0.45 * math.sin(math.pi * u) ** 1.5        # 中段轻微离地
    z = CAR_H / 2 + (CAR_W - CAR_H) / 2 * abs(math.sin(roll)) + hop
    yaw = math.pi + 1.2 * math.sin(math.pi * u) + 0.35 * smooth(u)
    return Vector((x, y, z)), (0.0, roll, yaw)


def flip_final(f):
    """最终画面第 f 帧翻滚车位姿（倒放后），只用于给 POV 机位算摇镜。"""
    tau = min(max(10.0 - t_of_frame(f), 0.0), TAU_TOTAL)
    return flip_forward(tau)


def hero_location(f):
    return Vector((HERO_X, HERO_SPEED * t_of_frame(f), 0.0))


# ------------------------------------------------------------------ 材质
def clay(name, gray):
    m = bpy.data.materials.new(name)
    b = bp.find_node(m.node_tree, "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (gray, gray, gray, 1)
    b.inputs["Roughness"].default_value = 0.8
    return m


MAT = {}


def mat(key):
    if key not in MAT:
        MAT[key] = clay(key, {"white": 0.7, "light": 0.5, "mid": 0.3, "dark": 0.08,
                              "road": 0.12, "line": 0.9, "skin": 0.7}[key])
    return MAT[key]


# ------------------------------------------------------------------ 几何工具
def box(name, size, loc, material, parent=None, bevel=0.0):
    sx, sy, sz = size

    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    o = bp.mesh_from_bmesh(name, build)
    o.location = loc
    o.data.materials.append(mat(material))
    if bevel:
        m = o.modifiers.new("Bevel", "BEVEL")
        m.width, m.segments = bevel, 2
    if parent:
        o.parent = parent
    return o


def cylinder(name, r, depth, loc, rot, material, parent=None, segs=20):
    o = bp.mesh_from_bmesh(name, lambda bm: bmesh.ops.create_cone(
        bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=depth), smooth=True)
    o.location, o.rotation_euler = loc, rot
    o.data.materials.append(mat(material))
    if parent:
        o.parent = parent
    return o


def sphere(name, r, loc, material, parent=None):
    o = bp.mesh_from_bmesh(name, lambda bm: bmesh.ops.create_uvsphere(
        bm, u_segments=16, v_segments=10, radius=r), smooth=True)
    o.location = loc
    o.data.materials.append(mat(material))
    if parent:
        o.parent = parent
    return o


def empty(name, parent=None, loc=(0, 0, 0), kind="PLAIN_AXES", size=0.5):
    o = bp.new_object(name)
    o.empty_display_type, o.empty_display_size = kind, size
    o.location = loc
    if parent:
        o.parent = parent
    return o


def model_group(name, parent):
    """MODEL_* 空物体：换模型时把新模型挂在插槽下、删掉这个组即可。"""
    return empty(name, parent, kind="CUBE", size=0.2)


# ------------------------------------------------------------------ 白模：车
def car_whitebox(root, interior):
    """车头朝 +Y，原点在包围盒中心（翻滚绕中心转）。interior=True 时做无顶棚玻璃的车内。"""
    h0 = -CAR_H / 2
    p = root
    box("body_lower", (CAR_W, CAR_L, 0.62), (0, 0, h0 + 0.28 + 0.31), "white", p, 0.06)
    if not interior:
        box("cabin", (CAR_W - 0.2, 2.5, 0.55), (0, -0.25, h0 + 0.9 + 0.275), "light", p, 0.08)
    else:
        # 车内：地板、仪表台、A/B/C 柱、车顶、座椅、方向盘
        roof_z = h0 + CAR_H - 0.04
        box("roof", (CAR_W - 0.25, 1.9, 0.08), (0, -0.35, roof_z), "light", p, 0.02)
        for sx in (-1, 1):
            x = sx * (CAR_W / 2 - 0.14)
            box(f"A_pillar_{sx}", (0.1, 0.12, 0.62), (x, 0.82, h0 + 1.13), "dark", p).rotation_euler.x = -0.6
            box(f"B_pillar_{sx}", (0.1, 0.14, 0.55), (x, -0.45, h0 + 1.15), "dark", p)
            box(f"C_pillar_{sx}", (0.1, 0.16, 0.55), (x, -1.25, h0 + 1.15), "dark", p).rotation_euler.x = 0.5
        box("dash", (CAR_W - 0.2, 0.55, 0.28), (0, 0.95, h0 + 0.88), "dark", p, 0.04)
        box("windshield_frame_bottom", (CAR_W - 0.2, 0.08, 0.06), (0, 1.12, h0 + 1.03), "dark", p)
        for sx in (-1, 1):
            x = sx * 0.4
            box(f"seat_base_{sx}", (0.52, 0.55, 0.14), (x, -0.05, h0 + 0.62), "mid", p, 0.04)
            box(f"seat_back_{sx}", (0.5, 0.12, 0.65), (x, -0.36, h0 + 0.95), "mid", p, 0.04).rotation_euler.x = -0.2
        sw = cylinder("steering_wheel", 0.19, 0.03, (-0.4, 0.55, h0 + 1.0), (math.radians(70), 0, 0), "dark", p)
        del sw
        box("rear_seat", (CAR_W - 0.3, 0.5, 0.5), (0, -1.15, h0 + 0.8), "mid", p, 0.04)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cylinder(f"wheel_{sx}{sy}", 0.33, 0.24, (sx * (CAR_W / 2 - 0.1), sy * 1.45, h0 + 0.33),
                     (0, math.pi / 2, 0), "dark", p)
    box("bumper_f", (CAR_W - 0.05, 0.15, 0.2), (0, CAR_L / 2, h0 + 0.45), "light", p, 0.04)
    box("bumper_r", (CAR_W - 0.05, 0.15, 0.2), (0, -CAR_L / 2, h0 + 0.45), "light", p, 0.04)


# ------------------------------------------------------------------ 白模：坐着的人
def seated_person(root, gray="skin"):
    """原点在臀部。朝 +Y。"""
    p = root
    box("pelvis", (0.36, 0.3, 0.16), (0, 0, 0.08), "mid", p, 0.05)
    box("torso", (0.42, 0.24, 0.48), (0, -0.06, 0.38), "mid", p, 0.08).rotation_euler.x = -0.15
    cylinder("neck", 0.055, 0.1, (0, -0.08, 0.64), (0, 0, 0), gray, p)
    head = sphere("head", 0.105, (0, -0.06, 0.76), gray, p)
    head.scale = (0.88, 1.0, 1.18)
    sphere("nose", 0.025, (0, 0.045, 0.76), gray, head.parent)
    for sx in (-1, 1):
        box(f"thigh_{sx}", (0.15, 0.45, 0.15), (sx * 0.11, 0.24, 0.05), "mid", p, 0.04)
        box(f"shin_{sx}", (0.12, 0.13, 0.45), (sx * 0.11, 0.5, -0.17), "mid", p, 0.03)
        arm = box(f"arm_{sx}", (0.1, 0.55, 0.1), (sx * 0.24, 0.2, 0.42), "mid", p, 0.03)
        arm.rotation_euler.x = -0.35
    return head


# ------------------------------------------------------------------ 场景
def build_env(root):
    p = root
    y0, y1 = -60.0, 330.0
    L, cy = y1 - y0, (y0 + y1) / 2
    box("road", (16, L, 0.1), (0, cy, -0.05), "road", p)
    for x in (-3.5, 0.0, 3.5, -6.9, 6.9):
        solid = abs(x) > 6
        if solid:
            box(f"edge_{x}", (0.15, L, 0.02), (x, cy, 0.01), "line", p)
        else:
            y = y0
            while y < y1:
                box(f"dash_{x}_{int(y)}", (0.12, 3.0, 0.02), (x, y + 1.5, 0.01), "line", p)
                y += 12.0
    box("verge_left", (10, L, 0.3), (-13, cy, 0.0), "light", p)
    box("guardrail", (0.1, L, 0.35), (-8.2, cy, 0.6), "white", p)
    box("guardrail_posts", (0.12, L, 0.6), (-8.25, cy, 0.3), "mid", p)
    box("wall_right", (1.5, L, 9.0), (9.8, cy, 4.5), "light", p)
    box("wall_top_slope", (8, L, 1.0), (14.5, cy, 9.3), "mid", p)
    # 天桥
    bridge_y = 205.0
    box("bridge_deck", (40, 6, 1.0), (0, bridge_y, 6.5), "white", p)
    box("bridge_rail", (40, 0.2, 1.0), (0, bridge_y - 3, 7.5), "light", p)
    for x in (-10.5, 10.5):
        box(f"bridge_pier_{x}", (1.2, 1.2, 6.0), (x, bridge_y, 3.0), "light", p)
    box("bridge_stairs", (3, 12, 4), (-14, bridge_y - 9, 2.0), "mid", p).rotation_euler.x = 0.35
    # 远处楼群（右侧墙后高楼、左侧远处白楼）
    for i, (x, y, w, d, h) in enumerate([(24, 120, 14, 18, 34), (26, 160, 12, 16, 40), (30, 215, 16, 20, 30),
                                          (24, 260, 12, 14, 26), (-40, 220, 14, 14, 24), (-55, 190, 12, 12, 30),
                                          (-30, 280, 18, 16, 20)]):
        box(f"building_{i}", (w, d, h), (x, y, h / 2), "white", p)


# ------------------------------------------------------------------ 动画工具
def channelbag(obj):
    ad = obj.animation_data
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def set_interp(obj, kind="LINEAR"):
    for fc in channelbag(obj).fcurves:
        for k in fc.keyframe_points:
            k.interpolation = kind


def key_pose(obj, frame, loc=None, rot=None):
    if loc is not None:
        obj.location = loc
        obj.keyframe_insert("location", frame=frame)
    if rot is not None:
        obj.rotation_euler = rot
        obj.keyframe_insert("rotation_euler", frame=frame)


def add_noise(obj, path, strength, scale, index=None):
    for fc in channelbag(obj).fcurves:
        if fc.data_path == path and (index is None or fc.array_index == index):
            m = fc.modifiers.new("NOISE")
            m.strength, m.scale = strength, scale
            m.phase = 7.3 * fc.array_index + strength * 100


def look_rotation(cam_world, target_world, roll=0.0):
    q = (target_world - cam_world).to_track_quat("-Z", "Y")
    e = q.to_euler()
    e.y += roll
    return e


# ------------------------------------------------------------------ 主流程
def main():
    bp.clean_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, FRAMES
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x, scene.render.resolution_y = 960, 448
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"

    # 场景
    env = empty("SLOT_Env", kind="ARROWS", size=2)
    build_env(model_group("MODEL_Env", env))

    # 本车（正常时间）
    hero = empty("SLOT_HeroCar", kind="ARROWS", size=1.5)
    for f in (1, FRAMES):
        key_pose(hero, f, loc=hero_location(f))
    set_interp(hero, "LINEAR")
    for fc in channelbag(hero).fcurves:
        fc.extrapolation = "LINEAR"
    # 路面颠簸
    hero.keyframe_insert("location", index=2, frame=1)
    add_noise(hero, "location", 0.015, 6, index=2)
    car_whitebox(model_group("MODEL_HeroCar", hero), interior=True)
    seat_z = -CAR_H / 2 + 0.45
    driver_slot = empty("SLOT_Driver", hero, (-0.4, -0.12, seat_z))
    driver_head = seated_person(model_group("MODEL_Driver", driver_slot))
    pass_slot = empty("SLOT_Passenger", hero, (0.4, -0.12, seat_z))
    seated_person(model_group("MODEL_Passenger", pass_slot))
    del driver_head

    # 翻滚车：先做正向撞车动作，再用 NLA 倒放
    flip = empty("SLOT_FlipCar", kind="ARROWS", size=1.5)
    car_whitebox(model_group("MODEL_FlipCar", flip), interior=False)
    n_forward = int(round(TAU_TOTAL * FPS)) + 1        # 259 帧
    for k in range(1, n_forward + 1):
        loc, rot = flip_forward((k - 1) / FPS)
        key_pose(flip, k, loc=loc, rot=rot)
    ad = flip.animation_data
    action = ad.action
    action.name = "FlipCar_ForwardCrash"
    set_interp(flip, "LINEAR")
    slot = ad.action_slot
    track = ad.nla_tracks.new()
    track.name = "倒放"
    strip = track.strips.new("ForwardCrash_Reversed", CUTS["S2"], action)
    strip.action_slot = slot
    strip.use_reverse = True
    strip.extrapolation = "HOLD"
    ad.action = None
    print(f"[flip] NLA strip {strip.frame_start:.0f}-{strip.frame_end:.0f} reversed={strip.use_reverse}")

    # 机位（都挂在本车上）
    def camera(name, lens, loc):
        data = bpy.data.cameras.new(name)
        data.lens, data.sensor_width = lens, 36
        data.clip_start = 0.05
        c = bp.new_object(name, data)
        c.parent = hero
        c.location = loc
        return c

    head_local = Vector((-0.4, -0.18, seat_z + 0.76))
    # S1/S3：副驾侧仪表台角落看驾驶员 3/4 侧脸，手持晃动
    cam_drv = camera("CAM_Driver", 50, (0.2, 0.08, seat_z + 0.74))
    cam_drv.rotation_euler = look_rotation(cam_drv.location, head_local + Vector((0.05, 0, -0.1)))
    for f in (1, 42, 207, 265):
        key_pose(cam_drv, f, rot=cam_drv.rotation_euler)
    # S3 轻推：靠近一点
    key_pose(cam_drv, 207, loc=cam_drv.location)
    key_pose(cam_drv, 265, loc=cam_drv.location.lerp(head_local, 0.12))
    add_noise(cam_drv, "rotation_euler", 0.012, 14)

    # S2：驾驶员身后偏中的主观视角，跟着翻滚车往左摇
    eye = Vector((-0.4, -0.08, seat_z + 0.78))        # 驾驶员眼睛：S2/S4 机位替代驾驶员
    cam_pov = camera("CAM_POV", 30, eye)
    yaw = 0.0
    for f in range(CUTS["S2"], CUTS["S3"] + 1):
        car_loc, _ = flip_final(f)
        rel = car_loc - hero_location(f) - eye
        want = math.atan2(-rel.x, rel.y) if rel.y > -3 else math.radians(75)   # 车在左 → 正角左摇
        want = min(max(want, 0.0), math.radians(75)) if t_of_frame(f) > 4.2 else 0.0
        yaw += (want - yaw) * 0.12                                          # 操作员滞后
        key_pose(cam_pov, f, rot=(math.radians(88), 0.0, yaw))
    add_noise(cam_pov, "rotation_euler", 0.006, 10)

    # S4：看左侧车窗外并排的车
    cam_side = camera("CAM_Side", 35, eye)
    cam_side.rotation_euler = (math.radians(88), 0.0, math.radians(58))
    for f in (CUTS["S4"], FRAMES):
        key_pose(cam_side, f, rot=cam_side.rotation_euler)
    add_noise(cam_side, "rotation_euler", 0.008, 12)

    # 切镜：时间线标记绑定相机
    for name, (f, cam) in {"S1": (CUTS["S1"], cam_drv), "S2": (CUTS["S2"], cam_pov),
                           "S3": (CUTS["S3"], cam_drv), "S4": (CUTS["S4"], cam_side)}.items():
        m = scene.timeline_markers.new(name, frame=f)
        m.camera = cam
    scene.camera = cam_drv

    # S2/S4 相机在驾驶员眼睛位置：这两个镜头隐藏驾驶员模型
    def descendants(o):
        for c in o.children:
            yield c
            yield from descendants(c)
    for o in descendants(bpy.data.objects["MODEL_Driver"]):
        for f, hide in ((1, False), (CUTS["S2"], True), (CUTS["S3"], False), (CUTS["S4"], True)):
            o.hide_render = hide
            o.keyframe_insert("hide_render", frame=f)

    # 光：晴天下午，太阳偏右后
    world = bpy.data.worlds.new("Sky")
    scene.world = world
    nt = world.node_tree
    bg = next((n for n in nt.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        nt.nodes.clear()
        bg = nt.nodes.new("ShaderNodeBackground")
        out = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(bg.outputs[0], out.inputs["Surface"])
    bg.inputs["Color"].default_value = (0.55, 0.7, 0.9, 1)
    bg.inputs["Strength"].default_value = 0.35
    sun = bp.new_object("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.5
    sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-140))

    save = bp.arg_value("--save")
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(save))
        print("saved", save)


main()
