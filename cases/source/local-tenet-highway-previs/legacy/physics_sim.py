"""正向（实拍时间）翻车的刚体物理模拟 + 参数搜索。

    Blender -b --factory-startup --python-exit-code 1 -P physics_sim.py -- --search
    Blender -b --factory-startup --python-exit-code 1 -P physics_sim.py -- --params w,slip,mu,lift,crush,veer --out out/crash.json

模型：车（凸包碰撞体，1600kg）以 v0 侧滑（车身横过来）撞进路面，带初始翻滚角速度，
由 Bullet 算出之后的翻滚、弹跳、滑行直到静止。初速度用"前几帧关键帧驱动(Animated)、
之后交给物理"的标准做法给出。
目标（由原片测量反推，见 README）：总翻滚 540°（静止时倒扣），约 2.1s 停住，滑行约 15m。
"""

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.expanduser("~/.claude/skills/blender/scripts"))
import boilerplate as bp  # noqa: E402

FPS = 30
V0 = 14.4                      # m/s，原片测得本车车速（翻滚车撞前与本车同速）
CAR_L, CAR_W = 5.0, 1.87       # Saab 9-5 (2010) 尺寸
LOWER_H, CAB_H = 0.75, 0.55    # 下车身 / 车舱高度（总高约 1.47）
KICK_FRAMES = 10               # 前 10 帧由动画驱动：甩尾 + 起翻，给出初速度和角速度
SIM_FRAMES = 150               # 最多模拟 5 秒


def car_hull():
    """一辆轿车的粗凸包：下车身长方体 + 收窄的车舱。原点在包围盒中心。"""
    def build(bm):
        z0 = -(LOWER_H + CAB_H) / 2
        pts = []
        for x in (-CAR_W / 2, CAR_W / 2):
            for y in (-CAR_L / 2, CAR_L / 2):
                pts += [(x, y, z0 + 0.15), (x * 0.97, y * 0.97, z0 + LOWER_H)]
        for x in (-CAR_W / 2 + 0.2, CAR_W / 2 - 0.2):
            for y in (-1.3, 1.0):
                pts.append((x, y, z0 + LOWER_H + CAB_H))
        for x in (-CAR_W / 2 + 0.1, CAR_W / 2 - 0.1):
            for y in (-CAR_L / 2 + 0.3, CAR_L / 2 - 0.3):
                pts.append((x, y, z0))           # 轮胎底
        vs = [bm.verts.new(p) for p in pts]
        bmesh.ops.convex_hull(bm, input=vs)
    return bp.mesh_from_bmesh("CrashCar", build)


def setup(w_roll, yaw_deg, mu, lift, crush=0.05, veer=0.0):
    bp.clean_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, SIM_FRAMES
    ground = bp.mesh_from_bmesh("Ground", lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=200))
    car = car_hull()
    if scene.rigidbody_world is None:
        with bpy.context.temp_override(scene=scene):
            bpy.ops.rigidbody.world_add()
    rw = scene.rigidbody_world
    if rw.collection is None:
        rw.collection = bpy.data.collections.new("RigidBodyWorld")
    rw.substeps_per_frame, rw.solver_iterations = 20, 20
    rw.point_cache.frame_start, rw.point_cache.frame_end = 1, SIM_FRAMES
    for o, kind in ((ground, "PASSIVE"), (car, "ACTIVE")):
        with bpy.context.temp_override(scene=scene, object=o, active_object=o, selected_objects=[o]):
            bpy.ops.rigidbody.object_add(type=kind)
    gr, cr = ground.rigid_body, car.rigid_body
    gr.friction, gr.restitution = 1.0, 0.1
    cr.collision_shape, cr.mass = "CONVEX_HULL", 1600
    cr.friction, cr.restitution = mu, 0.05
    cr.linear_damping, cr.angular_damping = 0.02, crush      # 角阻尼 ≈ 车身压溃吸能
    cr.use_margin, cr.collision_margin = True, 0.01

    # 车头朝 -Y 行驶（yaw 180°）→ 0.3s 甩尾到侧滑角 slip → 最后 3 帧开始绕纵轴翻 → 交给物理
    h = (LOWER_H + CAB_H) / 2 + 0.02
    pos_xy = Vector((0.0, 0.0))
    for k in range(1, KICK_FRAMES + 2):
        dt = (k - 1) / FPS
        u = min(dt / ((KICK_FRAMES - 1) / FPS), 1.0)
        yaw = math.radians(180 - yaw_deg * (u * u * (3 - 2 * u)) - veer * (u * u * (3 - 2 * u)))
        roll = w_roll * max(0.0, dt - (KICK_FRAMES - 4) / FPS)
        # 失控时行驶方向逐渐偏向 -X（veer 度），位置按偏转后的速度积分
        head = math.radians(veer) * (u * u * (3 - 2 * u))
        pos_xy = pos_xy + Vector((-math.sin(head), -math.cos(head))) * (V0 / FPS) if k > 1 else Vector((0.0, 0.0))
        loc = Vector((pos_xy.x, pos_xy.y, h + lift * max(0.0, dt - (KICK_FRAMES - 4) / FPS)))
        axis = Vector((-math.sin(yaw), math.cos(yaw), 0))
        rot = Matrix.Rotation(roll, 4, axis) @ Matrix.Rotation(yaw, 4, "Z")
        car.matrix_world = Matrix.Translation(loc) @ rot
        car.keyframe_insert("location", frame=k)
        car.keyframe_insert("rotation_euler", frame=k)
        cr.kinematic = k <= KICK_FRAMES
        cr.keyframe_insert("kinematic", frame=k)
    return scene, car


def run(w_roll, yaw_deg, mu, lift, crush=0.05, veer=0.0, record=False):
    scene, car = setup(w_roll, yaw_deg, mu, lift, crush, veer)
    up_prev, roll_total, stop_frame, track, ups = None, 0.0, None, [], []
    p_prev = None
    for f in range(1, SIM_FRAMES + 1):
        scene.frame_set(f)
        m = car.matrix_world.copy()
        p = m.translation.copy()
        up = (m.to_3x3() @ Vector((0, 0, 1))).normalized()
        if up_prev is not None:
            roll_total += math.degrees(up_prev.angle(up))
        up_prev = up
        ups.append((f, up.z))
        speed = (p - p_prev).length * FPS if p_prev is not None else V0
        p_prev = p
        if record:
            q = m.to_quaternion()
            track.append({"f": f, "loc": list(p), "quat": [q.w, q.x, q.y, q.z]})
        if f > KICK_FRAMES + 10 and speed < 0.3 and stop_frame is None:
            stop_frame = f
        if stop_frame and f > stop_frame + 15 and not record:
            break
    stop_t = ((stop_frame or SIM_FRAMES) - 1) / FPS
    t0 = KICK_FRAMES / FPS                                   # 交给物理的时刻
    def first(cond, after):
        return next(((fr - 1) / FPS - t0 for fr, z in ups if (fr - 1) / FPS - t0 > after and cond(z)), 9.0)
    t_inv1 = first(lambda z: z < -0.8, 0.0)
    t_up2 = first(lambda z: z > 0.8, t_inv1)
    t_rest = first(lambda z: z < -0.97, t_up2)
    res = {"w": w_roll, "yaw": yaw_deg, "mu": mu, "lift": lift, "crush": crush, "veer": veer, "roll_deg": round(roll_total, 1),
           "up_z": round(up_prev.z, 2), "stop_t": round(stop_t, 2), "slide_m": round(-p.y - V0 * t0, 2), "x_m": round(p.x, 2),
           "t_inv1": round(t_inv1, 2), "t_up2": round(t_up2, 2), "t_rest": round(t_rest, 2)}
    if record:
        res["track"] = track
        res["stop_frame"] = stop_frame
    return res


def score(r):
    """原片关键时刻（从起翻算）：0.8s 第一次倒扣、1.2s 翻正、2.13s 倒扣落定；滑行约 15.3m。"""
    if r["up_z"] > -0.9:
        return 99.0
    return ((r["t_inv1"] - 0.8) / 0.15) ** 2 + ((r["t_up2"] - 1.2) / 0.15) ** 2 + \
           ((r["t_rest"] - 2.13) / 0.2) ** 2 + ((r["slide_m"] - 15.3) / 3) ** 2 + ((r["x_m"] + 2.7) / 0.6) ** 2


if __name__ == "__main__":
    args = bp.get_args()
    if "--search" in args:
        results = []
        grid = [(2.0, 60, 0.8, crush, veer) for crush in (0.75, 0.8, 0.85) for veer in (6, 9, 12, 15)]
        for w, yaw, mu, crush, veer in grid:
            r = run(w, yaw, mu, 0.5, crush, veer)
            r["score"] = round(score(r), 2)
            results.append(r)
            print("SIM", json.dumps(r))
        best = min(results, key=lambda r: r["score"])
        print("BEST", json.dumps(best))
    else:
        w, yaw, mu, lift, crush, veer = (float(v) for v in bp.arg_value("--params").split(","))
        r = run(w, yaw, mu, lift, crush, veer, record=True)
        out = bp.arg_value("--out", "out/crash.json")
        with open(out, "w") as fh:
            json.dump(r, fh)
        print("RESULT", {k: v for k, v in r.items() if k != "track"})
