"""相机模型（纯 numpy，与 build.py 里 Blender 相机的约定一致）。
姿态：位置 (x, y, z)；yaw = 视线在 XY 平面的方位角（从 +X 逆时针，度）；pitch 抬头为正；roll 绕视线顺时针为正（画面向右倾）。
内参：水平视场 hfov（度），主点在画面中心，像素坐标 1280×544。"""
import math

import numpy as np

W, H = 1280, 544


def basis(yaw, pitch, roll):
    y, p, r = (math.radians(a) for a in (yaw, pitch, roll))
    d = np.array([math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p)])   # 视线
    rt = np.array([math.sin(y), -math.cos(y), 0.0])                                    # 无滚转时的画面右
    up = np.cross(rt, d)
    rt, up = rt * math.cos(r) - up * math.sin(r), up * math.cos(r) + rt * math.sin(r)
    return d, rt, up


def project(P, pos, yaw, pitch, roll, hfov):
    """世界点 P (N,3) → 像素 (N,2)；相机后方的点返回 nan。"""
    d, rt, up = basis(yaw, pitch, roll)
    q = np.atleast_2d(P) - np.asarray(pos)
    z = q @ d
    fpx = (W / 2) / math.tan(math.radians(hfov) / 2)
    u = W / 2 + fpx * (q @ rt) / z
    v = H / 2 - fpx * (q @ up) / z
    out = np.stack([u, v], 1)
    out[z <= 0.05] = np.nan
    return out


def focal_mm(hfov, sensor_w=36.0):
    return sensor_w / 2 / math.tan(math.radians(hfov) / 2)
