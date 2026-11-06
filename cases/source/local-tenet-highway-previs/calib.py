"""全部测量常量与时间基准的唯一来源（纯 Python，Blender 内外都能 import）。

时间基准：原片是 24fps 拉成的 30fps（decimate.py），预演按真实的 24fps 做。
flip_keys.py、data/cam_track.csv 里的帧号都是 24fps 帧号（对应 ref/frames24/）。
像素坐标仍是原片 960 宽坐标（有效画面 x 88~872），主点 (480, 224)。
数值来源见 README「测量」。
"""
import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 时间
_TB = json.load(open(os.path.join(HERE, "data/timebase_24.json")))
FPS, FRAMES = _TB["fps"], _TB["frames"]                 # 24, 241
F30_TO_24 = {int(k): v for k, v in _TB["f30_to_f24"].items()}
CUTS = {"S1": 1, "S2": F30_TO_24[43], "S3": F30_TO_24[207], "S4": F30_TO_24[266]}   # 1 / 35 / 166 / 213


def t_of(f):
    return (f - 1) / FPS


# ---------------------------------------------------------------- 相机标定
RES = (784, 448)                    # 原片有效画面（去掉左右黑边）
X_OFF = 88                          # 原片左黑边
CX, CY = 480.0, 224.0               # 主点（960 宽坐标）
F_PX = 1290.0                       # 焦距（像素），车道虚线周期 12m 定标；9m 则为 968
LENS_MM = F_PX * 36 / RES[0]        # 36mm 宽传感器下 ≈59mm
CAM_X, CAM_H = -1.53, 1.24          # 相机：分界线左 1.53m，离地 1.24m
CAM_BACK = -0.3                     # 相机在车内纵向位置（前排两座中间、眼线后 0.3m），按 A 柱位置反推

# ---------------------------------------------------------------- 场景
V_HERO = 14.4                       # 本车车速 m/s
LEFT_EDGE, RIGHT_EDGE = -3.51, 3.37 # 左右路缘线
WALL_X, WALL_H = 10.4, 4.5          # 石墙墙脚与岩面高度
BRIDGE_CLEAR = 2.6                  # 天桥等效净空（前方路面约 2~3% 上坡，用平路近似）
BRIDGE_Y = V_HERO * t_of(F30_TO_24[52]) + 128.0   # 原片第 52 帧（30fps）时在前方 128m


def hero_y(f):
    return V_HERO * t_of(f)


# ---------------------------------------------------------------- 相机朝向曲线（偏航向右为正、俯仰向下为正，度）
# 镜头 2 前段：远景高楼模板跟踪（track_far.py，30fps 时代测的，已换算帧号）；之后人工读点；
# 镜头 4：墙脚(X=10.4) + 车道(X=2.7) 反解
CAM_KEYS = {}
with open(os.path.join(HERE, "data/cam_track.csv")) as fh:
    for r in csv.DictReader(fh):
        CAM_KEYS[int(r["frame24"])] = (float(r["yaw_right_deg"]), float(r["pitch_down_deg"]))


def cam_at(f):
    """第 f 帧（可为小数）的 (yaw, pitch)，关键帧间线性插值，与 Blender 里的相机动画一致。"""
    fs = sorted(CAM_KEYS)
    if f <= fs[0]:
        return CAM_KEYS[fs[0]]
    if f >= fs[-1]:
        return CAM_KEYS[fs[-1]]
    i = max(j for j in range(len(fs)) if fs[j] <= f)
    a, b = fs[i], fs[min(i + 1, len(fs) - 1)]
    s = 0.0 if b == a else (f - a) / (b - a)
    return tuple(x + (y - x) * s for x, y in zip(CAM_KEYS[a], CAM_KEYS[b]))


def ground_point(u, v, yaw_deg, pitch_deg):
    """像素 (u, v) → 路面 (X 右, Y 前)，相对相机正下方。"""
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    d = [(u - CX) / F_PX, 1.0, -(v - CY) / F_PX]                     # 相机系：x 右, y 前, z 上
    cp, sp = math.cos(pitch), math.sin(pitch)
    d = [d[0], cp * d[1] + sp * d[2], -sp * d[1] + cp * d[2]]       # 低头 pitch
    cy, sy = math.cos(yaw), math.sin(yaw)
    d = [cy * d[0] + sy * d[1], -sy * d[0] + cy * d[1], d[2]]       # 右转 yaw
    if d[2] >= 0:
        return None
    s = CAM_H / -d[2]
    return d[0] * s, d[1] * s
