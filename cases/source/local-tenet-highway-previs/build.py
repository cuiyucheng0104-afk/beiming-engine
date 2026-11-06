"""
高速公路倒放翻车 · 白模预演 v3.2（原片测量 + 逐帧姿态匹配 + 腾空段抛物线，24fps）

    Blender -b --factory-startup --python-exit-code 1 -P build.py -- --save out/previs.blend
    （一般用 ./run.sh，会接着跑验证门禁）

所有测量常量和时间基准在 calib.py（原片是 24 拉 30，预演按真实的 24fps 做）；翻滚车关键帧在
flip_keys.py。成片时间的逐帧位姿反过来写成正向动作，再用 NLA 倒放得到成片里的"倒放翻车"。

坐标：X 向右（分界虚线 X=0），Y 沿路向前，Z 向上，单位米。
颜色只为看清位置关系：本车=蓝灰，翻滚车=橙，环境=浅灰。

插槽（换模型只动 MODEL_*，动画都在 SLOT_* 上）：
    SLOT_Env / MODEL_Env
    SLOT_HeroCar（正常时间匀速）/ MODEL_HeroCar、SLOT_Driver、SLOT_Passenger、CAM_POV、CAM_Driver
    SLOT_FlipCar（动作 FlipCar_ForwardCrash = 正向撞车，NLA 片段 Reversed）/ MODEL_FlipCar
"""

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
sys.path.insert(0, HERE)
import boilerplate as bp  # noqa: E402
import car_model as cm  # noqa: E402
import flip_keys as fk  # noqa: E402
import calib as cb  # noqa: E402
from bpy_extras import anim_utils  # noqa: E402

# ---------------------------------------------------------------- 测量值（calib.py 是唯一来源）
from calib import (FPS, FRAMES, CUTS, RES, LENS_MM, V_HERO, CAM_X, CAM_H, CAM_BACK,  # noqa: E402
                   LEFT_EDGE, RIGHT_EDGE, WALL_X, WALL_H, BRIDGE_CLEAR, BRIDGE_Y, hero_y)
G = 9.81
AIR_EPS = 0.06                      # 车身最低点离地超过 6cm 才算腾空；POSE 里 0.05 的 lift 是贴着地滚时防穿地的余量
A_MAX, W_MAX = 80.0, 14.0           # 物理检查阈值：约 8g、14 rad/s
A_IMPACT = 200.0                    # 起跳/落地帧（腾空段两端）是着地冲击，放宽到约 20g


# ---------------------------------------------------------------- 材质 / 几何
MATS = {}
COLORS = {"env": 0.62, "env_dark": 0.35, "road": 0.16, "line": 0.92, "grass": (0.3, 0.36, 0.26), "wall": (0.5, 0.46, 0.38),
          "hero": (0.32, 0.42, 0.58), "hero_dark": (0.08, 0.1, 0.14), "flip": (0.85, 0.42, 0.12),
          "tire": 0.05, "person": 0.75, "seat": 0.22}


def mat(key):
    if key not in MATS:
        c = COLORS[key]
        c = (c, c, c) if isinstance(c, float) else c
        m = bpy.data.materials.new(key)
        b = bp.find_node(m.node_tree, "BSDF_PRINCIPLED")
        b.inputs["Base Color"].default_value = (*c, 1)
        b.inputs["Roughness"].default_value = 0.85
        MATS[key] = m
    return MATS[key]


def box(name, size, loc, m, parent=None, rot=(0, 0, 0), bevel=0.0):
    sx, sy, sz = size

    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    o = bp.mesh_from_bmesh(name, build)
    o.location, o.rotation_euler = loc, rot
    o.data.materials.append(mat(m))
    if bevel:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width, mod.segments = bevel, 2
    o.parent = parent
    return o


def cyl(name, r, depth, loc, rot, m, parent=None, segs=20):
    o = bp.mesh_from_bmesh(name, lambda bm: bmesh.ops.create_cone(
        bm, cap_ends=True, segments=segs, radius1=r, radius2=r, depth=depth), smooth=True)
    o.location, o.rotation_euler = loc, rot
    o.data.materials.append(mat(m))
    o.parent = parent
    return o


def sphere(name, r, loc, m, parent=None):
    o = bp.mesh_from_bmesh(name, lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=r),
                           smooth=True)
    o.location = loc
    o.data.materials.append(mat(m))
    o.parent = parent
    return o


def empty(name, parent=None, loc=(0, 0, 0), kind="PLAIN_AXES", size=0.5):
    o = bp.new_object(name)
    o.empty_display_type, o.empty_display_size = kind, size
    o.location, o.parent = loc, parent
    return o


# ---------------------------------------------------------------- 场景（按测量）
def build_env(p):
    y0, y1 = -60.0, 420.0
    L, cy = y1 - y0, (y0 + y1) / 2
    box("road", (LEFT_EDGE * -1 + RIGHT_EDGE + 2.2, L, 0.1), ((RIGHT_EDGE + LEFT_EDGE) / 2, cy, -0.05), "road", p)
    box("line_left_edge", (0.15, L, 0.02), (LEFT_EDGE, cy, 0.005), "line", p)
    box("line_right_edge", (0.15, L, 0.02), (RIGHT_EDGE, cy, 0.005), "line", p)
    y = y0
    while y < y1:                                   # 分界虚线：线 3m / 间隔 9m
        box(f"dash_{int(y)}", (0.12, 3.0, 0.02), (0.0, y + 1.5, 0.005), "line", p)
        y += 12.0
    # 左：护栏 + 草地分隔带 + 对向车道
    box("guardrail", (0.08, L, 0.3), (LEFT_EDGE - 0.9, cy, 0.6), "env", p)
    box("guardrail_posts", (0.1, L, 0.45), (LEFT_EDGE - 0.95, cy, 0.22), "env_dark", p)
    box("median_grass", (8.0, L, 0.12), (LEFT_EDGE - 5.0, cy, 0.0), "grass", p)
    box("road_opposite", (8.0, L, 0.1), (LEFT_EDGE - 13.0, cy, -0.05), "road", p)
    # 右：路肩、草带、人行道、石墙、坡、路灯
    box("shoulder_right", (1.2, L, 0.1), (RIGHT_EDGE + 0.6, cy, -0.05), "road", p)
    box("grass_right", (4.0, L, 0.15), (RIGHT_EDGE + 3.2, cy, 0.0), "grass", p)
    box("sidewalk", (WALL_X - RIGHT_EDGE - 5.2, L, 0.2), ((WALL_X + RIGHT_EDGE + 5.2) / 2, cy, 0.05), "env", p)
    box("rock_wall", (1.2, L, WALL_H), (WALL_X + 0.6, cy, WALL_H / 2), "wall", p)
    slope = box("slope", (16.0, L, 0.4), (WALL_X + 8.8, cy, WALL_H + 2.5), "grass", p)
    slope.rotation_euler.y = math.atan2(5.0, 15.0)
    for i, yy in enumerate(range(-40, 400, 40)):
        cyl(f"lamp_{i}", 0.08, 9.0, (WALL_X - 1.2, yy, 4.5), (0, 0, 0), "env_dark", p, 8)
    # 天桥：净空 5.5m，横跨两侧，左侧有楼梯
    box("bridge_deck", (70, 5.0, 1.2), (0, BRIDGE_Y, BRIDGE_CLEAR + 0.6), "env", p)
    box("bridge_rail", (70, 0.15, 1.1), (0, BRIDGE_Y - 2.4, BRIDGE_CLEAR + 1.75), "env_dark", p)
    for x in (-8.5, 6.5):
        box(f"bridge_pier_{x}", (1.0, 1.4, BRIDGE_CLEAR + 3), (x, BRIDGE_Y, (BRIDGE_CLEAR - 3) / 2), "env_dark", p)
    for x in (-16.0, -6.5):
        box(f"bridge_stair_{x}", (2.5, 10.0, 0.6), (x, BRIDGE_Y - 6.0, BRIDGE_CLEAR / 2), "env", p,
            rot=(math.atan2(BRIDGE_CLEAR, 10.0), 0, 0))
    # 远景楼（墙后橙色高层、左侧白楼）
    for i, (x, yy, w, d, h) in enumerate([(38, 175, 16, 18, 48), (45, 205, 14, 16, 52), (52, 240, 18, 18, 44),
                                           (34, 280, 14, 14, 36), (-45, 180, 16, 16, 30), (-62, 215, 14, 14, 38),
                                           (-38, 260, 20, 16, 26)]):
        box(f"building_{i}", (w, d, h), (x, yy, h / 2), "env", p)


# ---------------------------------------------------------------- 车
def flip_car_model(p):
    """翻滚车：Saab 9-5 比例白模（car_model.py），车头白灯黑格栅、车尾红灯车牌、深色车窗和底盘。"""
    cm.build(p)


def hero_car_model(p):
    """本车：原点在地面、车身中线；相机在 (0, 0, 1.24)。只做影响取景的部件：仪表台、A/B 柱、车顶、门。"""
    W = 1.85
    box("floor", (W, 4.8, 0.35), (0, -0.2, 0.4), "hero", p)
    for sx in (-1, 1):
        box(f"door_{sx}", (0.1, 2.6, 0.55), (sx * (W / 2 - 0.05), -0.45, 0.85), "hero", p)
        # A 柱：从挡风玻璃底角斜到车顶前沿
        base, top = Vector((sx * 0.8, 1.55, 1.0)), Vector((sx * 0.68, 0.45, 1.45))   # 真车比例：眼线高度处离前排眼睛约 1.2m
        mid, d = (base + top) / 2, top - base
        box(f"A_pillar_{sx}", (0.13, 0.22, d.length), mid, "hero_dark", p,
            rot=(math.atan2(-d.y, d.z), math.atan2(d.x, d.z), 0))
        box(f"B_pillar_{sx}", (0.1, 0.14, 0.4), (sx * 0.86, -0.6, 1.25), "hero_dark", p)
    box("dash", (W - 0.15, 0.55, 0.2), (0, 0.95, 0.96), "hero_dark", p, bevel=0.04)   # 上沿按原片第 345 行反算
    box("hood", (W - 0.1, 1.2, 0.1), (0, 1.9, 0.8), "hero", p)
    box("roof", (W - 0.3, 1.8, 0.07), (0, -0.5, 1.47), "hero", p)
    box("windshield_header", (W - 0.3, 0.1, 0.07), (0, 0.47, 1.45), "hero_dark", p)
    cyl("steering_wheel", 0.19, 0.03, (-0.4, 0.62, 0.86), (math.radians(65), 0, 0), "hero_dark", p)
    for sx in (-1, 1):
        box(f"seat_back_{sx}", (0.5, 0.12, 0.7), (sx * 0.4, -0.45, 0.9), "seat", p)
    box("rear_seat", (W - 0.3, 0.5, 0.5), (0, -1.3, 0.8), "seat", p)


def seated_person(p):
    """原点在臀部，朝 +Y。"""
    box("pelvis", (0.36, 0.3, 0.16), (0, 0, 0.08), "person", p, bevel=0.04)
    box("torso", (0.42, 0.24, 0.48), (0, -0.06, 0.38), "person", p, rot=(-0.15, 0, 0), bevel=0.06)
    head = sphere("head", 0.105, (0, -0.06, 0.76), "person", p)
    head.scale = (0.88, 1.0, 1.18)
    sphere("nose", 0.035, (0, 0.05, 0.75), "person", p)
    for sx in (-1, 1):                                       # 眼睛：一眼看出脸朝向
        sphere(f"eye_{sx}", 0.018, (sx * 0.038, 0.03, 0.79), "hero_dark", p)
    for sx in (-1, 1):
        box(f"arm_{sx}", (0.09, 0.5, 0.09), (sx * 0.24, 0.18, 0.42), "person", p, rot=(-0.35, 0, 0))
        box(f"thigh_{sx}", (0.15, 0.45, 0.15), (sx * 0.11, 0.24, 0.05), "person", p)


# ---------------------------------------------------------------- 动画工具
def bag(obj):
    ad = obj.animation_data
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def interp(obj, kind):
    for fc in bag(obj).fcurves:
        for k in fc.keyframe_points:
            k.interpolation = kind


def cam_rot(yaw_right, pitch_down):
    return Euler((math.radians(90 - pitch_down), 0.0, math.radians(-yaw_right)))


def load_cam_curve():
    return dict(cb.CAM_KEYS)


# ---------------------------------------------------------------- 翻滚车：逐帧姿态匹配 → 正向动作 → NLA 倒放
def catmull(keys, f):
    """keys: sorted [(frame, tuple)]；按时间做 Catmull-Rom 插值，两端保持。"""
    fs = [k for k, _ in keys]
    if f <= fs[0]:
        return keys[0][1]
    if f >= fs[-1]:
        return keys[-1][1]
    i = max(j for j in range(len(fs)) if fs[j] <= f)
    p0 = keys[max(i - 1, 0)][1]
    p1, p2 = keys[i][1], keys[i + 1][1]
    p3 = keys[min(i + 2, len(keys) - 1)][1]
    t = (f - fs[i]) / (fs[i + 1] - fs[i])
    return tuple(0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3)
                 for a, b, c, d in zip(p0, p1, p2, p3))


def gauss(vals, sigma):
    """浮点 σ 的高斯平滑，两端线性外推。"""
    k = max(1, int(math.ceil(3 * sigma)))
    n = len(vals)
    ext = [vals[0] - (vals[1] - vals[0]) * (k - j) for j in range(k)] + list(vals) + \
          [vals[-1] + (vals[-1] - vals[-2]) * (j + 1) for j in range(k)]
    w = [math.exp(-0.5 * ((j - k) / sigma) ** 2) for j in range(2 * k + 1)]
    sw = sum(w)
    return [sum(w[j] * ext[i + j] for j in range(2 * k + 1)) / sw for i in range(n)]


def car_rot(h, r, p):
    """h 车头朝向（+Y 往 +X，度），r 绕纵轴翻滚，p 俯仰。"""
    return (Matrix.Rotation(math.radians(-h), 3, "Z") @ Matrix.Rotation(math.radians(p), 3, "X")
            @ Matrix.Rotation(math.radians(r), 3, "Y"))


def flip_final_poses():
    """成片时间每帧位姿 [(loc, quat)]，第 i 项为第 i+1 帧。"""
    ground = []
    for f, (u, v) in sorted(fk.PICKS.items()):
        yaw, _ = cb.cam_at(f)
        if f in fk.WORLD_Y:                                  # 远处：距离用尺寸反算，横向按画面水平角
            depth = fk.WORLD_Y[f] - hero_y(f)
            ang = math.radians(yaw) + math.atan((u - cb.CX) / cb.F_PX)
            ground.append((f, (CAM_X + depth * math.tan(ang), fk.WORLD_Y[f])))
            continue
        gx, gy = cb.ground_point(u, v, *cb.cam_at(f))
        ground.append((f, (CAM_X + gx, hero_y(f) + gy)))
    pose_keys = sorted(fk.POSE.items())
    f_last = ground[-1][0]
    poses = []
    for f in range(1, FRAMES + 1):
        if f <= f_last:
            x, y = catmull(ground, f)
        else:                                                # 摆正后倒着开，与本车同速
            x, y = ground[-1][1][0], ground[-1][1][1] + (V_HERO - fk.DRIFT_BACK) * (f - f_last) / FPS
        h, r, p, lift = catmull(pose_keys, f)
        R = car_rot(h, r, p)
        q = R.to_quaternion()
        if poses and q.dot(poses[-1][1]) < 0:                # 四元数正负号连续，避免插值多转一圈
            q.negate()
        poses.append([Vector((x, 0.0, cm.rest_height(R) + max(lift, 0.0))), q, y])
    # 平滑宽度按时间定（30fps 时代的 6 / 3 / 1.8 / 1.5 帧 → 24fps 的 0.8 倍）
    # 路面轨迹：远处读点纵深误差大，纵深(Y) σ=0.2s，横向(X) σ=0.1s；尾段是匀速直线，平滑不改变它
    ys = gauss([p[2] for p in poses], 4.8)
    xs = gauss([p[0].x for p in poses], 2.4)
    # 姿态：四元数各分量高斯平滑后归一化（σ=0.06s，去掉关键帧间的角速度突变）
    qs = [p[1] for p in poses]
    comps = [gauss([q[c] for q in qs], 1.44) for c in range(4)]
    qs = [Quaternion((comps[0][i], comps[1][i], comps[2][i], comps[3][i])).normalized() for i in range(len(qs))]
    # 高度 = 平滑后姿态的贴地高度 + 平滑后的 lift（贴地滚动时重心严格跟着贴地高度走）；腾空段换成抛物线
    # 凸包车模的贴地高度在换着地角时有折点（真车是圆角），所以贴地高度本身也轻度平滑（rest_s），最后再保证不穿地
    rest = [cm.rest_height(q.to_matrix()) for q in qs]
    rest_s = gauss(rest, 1.2)
    lifts = gauss([max(p[0].z - cm.rest_height(p[1].to_matrix()), 0.0) for p in poses], 1.2)
    zs = [r + max(l, 0.0) for r, l in zip(rest_s, lifts)]
    global AIR, Z_DEBUG
    matched = list(zs)
    AIR = ballistic(zs, rest_s)
    # 不穿地；再做一次很轻的平滑（σ=0.8 帧）去掉凸包折点带来的单帧尖刺——对抛物线只差一个常数，z'' = -g 不变
    zs = [max(z, r) for z, r in zip(gauss([max(z, r) for z, r in zip(zs, rest)], 0.8), rest)]
    Z_DEBUG = list(zip(matched, rest_s, zs))
    return [(Vector((xs[i], ys[i], zs[i])), qs[i]) for i in range(len(poses))]


def ballistic(zs, rest):
    """腾空段重心高度换成重力抛物线 z = zp - g/2·(t - tp)²：g 固定，顶点 (tp, zp) 对匹配高度做最小二乘，
    起跳/落地点 = 抛物线与贴地高度的交点。腾空段由"最低点离地 > AIR_EPS"找出，原地修改 zs，返回各段信息。"""
    n, wins, i = len(zs), [], 0
    while i < n:
        if zs[i] - rest[i] <= AIR_EPS:
            i += 1
            continue
        j = i
        while j + 1 < n and zs[j + 1] - rest[j + 1] > AIR_EPS:
            j += 1
        seg = range(i, j + 1)
        par = lambda k, tp, zp: zp - 0.5 * G * ((k - tp) / FPS) ** 2          # noqa: E731
        best = None
        for s10 in range(10 * (i - 3), 10 * (j + 3) + 1):
            tp = s10 / 10
            zp = sum(zs[k] + 0.5 * G * ((k - tp) / FPS) ** 2 for k in seg) / len(seg)
            err = sum((par(k, tp, zp) - zs[k]) ** 2 for k in seg)
            if best is None or err < best[0]:
                best = (err, tp, zp)
        _, tp, zp = best
        k0 = int(round(tp))
        lo = hi = k0
        while lo - 1 >= 0 and par(lo - 1, tp, zp) > rest[lo - 1]:
            lo -= 1
        while hi + 1 < n and par(hi + 1, tp, zp) > rest[hi + 1]:
            hi += 1
        matched = [zs[k] for k in range(lo, hi + 1)]
        for k in range(lo, hi + 1):
            zs[k] = max(par(k, tp, zp), rest[k])
        dev = max(abs(a - b) for a, b in zip(matched, zs[lo:hi + 1]))
        wins.append({"from": lo + 1, "to": hi + 1, "flight_s": round((hi - lo + 2) / FPS, 3),
                     "apex_lift": round(zp - rest[k0], 3), "max_dev_m": round(dev, 3)})
        i = max(j, hi) + 1
    return wins


AIR, Z_DEBUG = [], []


def physics_check(poses):
    """重心速度/加速度、角速度是否连续合理（逐帧姿态匹配不是模拟，用这个兜底）。"""
    dt = 1 / FPS
    impact = {f for w in AIR for f in (w["from"] - 1, w["from"], w["to"], w["to"] + 1)}
    warn, fall, amax, wmax = [], [], (0, 0), (0, 0)
    for i in range(1, len(poses) - 1):
        a = (poses[i + 1][0] - 2 * poses[i][0] + poses[i - 1][0]) / dt ** 2
        q0, q1 = poses[i][1], poses[i + 1][1]
        ang = q0.rotation_difference(q1).angle
        w = min(ang, 2 * math.pi - ang) / dt
        amax = max(amax, (a.length, i + 1))
        wmax = max(wmax, (w, i + 1))
        if a.length > (A_IMPACT if i + 1 in impact else A_MAX) or w > W_MAX:
            warn.append(i + 1)
        if a.z < -G - 0.5:                                   # 地面只能往上推：重心竖直加速度不可能小于 -g
            fall.append((i + 1, round(a.z, 1)))
    with open(os.path.join(HERE, "out/motion_curve.csv"), "w") as fh:
        fh.write("frame,speed,accel,omega\n")
        for i in range(1, len(poses) - 1):
            v = (poses[i + 1][0] - poses[i - 1][0]).length / (2 * dt)
            a = (poses[i + 1][0] - 2 * poses[i][0] + poses[i - 1][0]).length / dt ** 2
            ang = poses[i][1].rotation_difference(poses[i + 1][1]).angle
            fh.write(f"{i + 1},{v:.2f},{a:.1f},{min(ang, 2 * math.pi - ang) / dt:.2f}\n")
    with open(os.path.join(HERE, "out/physics.json"), "w") as fh:
        json.dump({"fps": FPS, "a_max": round(amax[0], 1), "a_max_frame": amax[1], "w_max": round(wmax[0], 2),
                   "w_max_frame": wmax[1], "limits": [A_MAX, W_MAX, A_IMPACT],
                   "impact_frames": sorted(impact), "over": warn,
                   "faster_than_g": fall, "airborne": AIR}, fh,
                  ensure_ascii=False, indent=1)
    with open(os.path.join(HERE, "out/height_debug.csv"), "w") as fh:
        fh.write("frame,z_matched,rest_s,z_final\n")
        for i, (a, b, c) in enumerate(Z_DEBUG):
            fh.write(f"{i + 1},{a:.3f},{b:.3f},{c:.3f}\n")
    for w in AIR:
        print(f"[physics] 腾空 {w['from']}-{w['to']} 帧，约 {w['flight_s']}s，顶点处最低点离地 {w['apex_lift']} m，"
              f"与匹配高度最大偏差 {w['max_dev_m']} m")
    if fall:
        print(f"[physics] 重心下落比自由落体还快（z'' < -g，物理上不可能）的帧：{fall}")
    print(f"[physics] 最大加速度 {amax[0]:.1f} m/s² @帧{amax[1]}，最大角速度 {wmax[0]:.1f} rad/s @帧{wmax[1]}；"
          f"超限帧 {warn[:20]}")


# ---------------------------------------------------------------- 主流程
def main():
    bp.clean_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, FRAMES
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.render.use_motion_blur = True                      # 原片有明显运动模糊，没有它同样的运动看着发卡
    scene.render.motion_blur_shutter = 0.5

    env = empty("SLOT_Env", kind="ARROWS", size=2)
    build_env(empty("MODEL_Env", env, kind="CUBE", size=0.2))

    # 本车：正常时间，沿 X=CAM_X 匀速前进
    hero = empty("SLOT_HeroCar", kind="ARROWS", size=1.5)
    for f in (1, FRAMES):
        hero.location = (CAM_X, hero_y(f) - CAM_BACK, 0.0)       # 相机（不是车中心）按实测轨迹走
        hero.keyframe_insert("location", frame=f)
    interp(hero, "LINEAR")
    hero_car_model(empty("MODEL_HeroCar", hero, kind="CUBE", size=0.2))
    seat_z = 0.45
    for name, x in (("Driver", -0.4), ("Passenger", 0.4)):
        slot = empty(f"SLOT_{name}", hero, (x, -0.2, seat_z))
        seated_person(empty(f"MODEL_{name}", slot, kind="CUBE", size=0.2))

    # 翻滚车
    flip = empty("SLOT_FlipCar", kind="ARROWS", size=1.5)
    flip.rotation_mode = "QUATERNION"
    flip_car_model(empty("MODEL_FlipCar", flip, kind="CUBE", size=0.2))
    final = flip_final_poses()
    physics_check(final)
    for k in range(1, FRAMES + 1):                           # 正向动作：第 k 帧 = 成片第 FRAMES+1-k 帧
        loc, q = final[FRAMES - k]
        flip.location, flip.rotation_quaternion = loc, q
        flip.keyframe_insert("location", frame=k)
        flip.keyframe_insert("rotation_quaternion", frame=k)
    ad = flip.animation_data
    action, slot = ad.action, ad.action_slot
    action.name = "FlipCar_ForwardCrash"
    interp(flip, "LINEAR")
    track = ad.nla_tracks.new()
    track.name = "倒放"
    strip = track.strips.new("ForwardCrash_Reversed", 1, action)
    strip.action_slot = slot
    strip.use_reverse = True
    strip.extrapolation = "HOLD"
    ad.action = None

    # 机位
    def camera(name, lens, loc):
        data = bpy.data.cameras.new(name)
        data.lens, data.sensor_width, data.sensor_fit = lens, 36, "HORIZONTAL"
        data.clip_start = 0.05
        c = bp.new_object(name, data)
        c.parent, c.location = hero, loc
        return c

    cam_pov = camera("CAM_POV", LENS_MM, (0.0, CAM_BACK, CAM_H))   # A 柱在眼线高度约偏右 30°，与原片一致
    keys = load_cam_curve()
    for f in sorted(keys):
        cam_pov.rotation_euler = cam_rot(*keys[f])
        cam_pov.keyframe_insert("rotation_euler", frame=f)
    interp(cam_pov, "LINEAR")

    # 原片后段相机越来越"往下看"，但仪表台在画面里位置不变：这是本车刹车点头（整车俯仰），
    # 不是相机在车里低头。所以把俯仰的增量也加到车内模型上（绕相机位置转），仪表台和 A 柱跟着相机
    model = bpy.data.objects["MODEL_HeroCar"]
    pivot = Vector((0.0, CAM_BACK, CAM_H))
    model.rotation_mode = "XYZ"
    base_pitch = keys[min(keys)][1]
    for f in sorted(keys):
        dp = math.radians(keys[f][1] - base_pitch)
        R = Matrix.Rotation(-dp, 3, "X")
        model.rotation_euler = (-dp, 0.0, 0.0)
        model.location = pivot - R @ pivot
        model.keyframe_insert("rotation_euler", frame=f)
        model.keyframe_insert("location", frame=f)
    interp(model, "LINEAR")

    cam_drv = camera("CAM_Driver", 35, (0.35, 0.6, 1.2))      # S1/S3：副驾侧看驾驶员（未测量，按构图）
    head = Vector((-0.4, -0.26, seat_z + 0.74))
    aim = head + Vector((0.0, 0.25, -0.08))                    # 人头落在画面左三分之一，头顶留空
    cam_drv.rotation_euler = (aim - cam_drv.location).to_track_quat("-Z", "Y").to_euler()

    for name, (f, cam) in {"S1": (CUTS["S1"], cam_drv), "S2": (CUTS["S2"], cam_pov),
                           "S3": (CUTS["S3"], cam_drv), "S4": (CUTS["S4"], cam_pov)}.items():
        scene.timeline_markers.new(name, frame=f).camera = cam
    scene.camera = cam_drv

    # 光：晴天，太阳偏左后上方
    world = bpy.data.worlds.new("Sky")
    scene.world = world
    nt = world.node_tree
    bg = next((n for n in nt.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        nt.nodes.clear()
        bg = nt.nodes.new("ShaderNodeBackground")
        nt.links.new(bg.outputs[0], nt.nodes.new("ShaderNodeOutputWorld").inputs["Surface"])
    bg.inputs["Color"].default_value = (0.5, 0.65, 0.85, 1)
    bg.inputs["Strength"].default_value = 0.45
    sun = bp.new_object("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy, sun.data.angle = 3.5, math.radians(1.0)
    sun.rotation_euler = (math.radians(40), 0, math.radians(150))

    save = bp.arg_value("--save")
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(save))
        print("saved", save)


main()
