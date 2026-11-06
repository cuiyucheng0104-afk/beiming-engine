"""把物理模拟轨迹对齐到原片：每组候选只做"整体平移 (dx,dy) + 时间偏移 t0"（不改物理），
最小化投影到原片画面的像素误差。输出最优组合到 out/align.json。

    python3 fit_align.py out/cand_*.json
"""
import json
import math
import sys

import numpy as np

from ground_track import CAM_X, CX, CY, F, H, cam, picks

FPS, V = 30, 14.4
REST_GUESS = (-0.3, 83.0)


def cam_at(f):
    k = min(cam, key=lambda c: abs(c - f))
    return cam[k]


def project(px, py, f):
    """路面点 (px,py,0) → 原片像素 (u,v)，向量化。"""
    yaw, pitch = (math.radians(a) for a in cam_at(f))
    dX, dY, dZ = px - CAM_X, py - V * (f - 1) / FPS, -H
    cy, sy = math.cos(yaw), math.sin(yaw)
    x, y = cy * dX - sy * dY, sy * dX + cy * dY
    cp, sp = math.cos(pitch), math.sin(pitch)
    yy, z = cp * y - sp * dZ, sp * y + cp * dZ
    return CX + F * x / yy, CY - F * z / yy


def model_xy(track, t0, f):
    t = (f - 1) / FPS
    if t >= t0:
        x, y, _ = track[0]["loc"]
        return x, y + V * (t - t0)
    s = min(int(round((t0 - t) * FPS)), len(track) - 1)
    x, y, _ = track[s]["loc"]
    return x, y


best_all = None
for path in sys.argv[1:]:
    sim = json.load(open(path))
    tr = sim["track"]
    rest = tr[-1]["loc"]
    dxs = np.arange(-2.0, 2.01, 0.1) + REST_GUESS[0] - rest[0]
    dys = np.arange(-12.0, 12.01, 0.25) + REST_GUESS[1] - rest[1]
    DX, DY = np.meshgrid(dxs, dys)
    best = None
    for t0 in np.arange(5.6, 7.6, 0.02):
        err = np.zeros_like(DX)
        for f, (u, v) in picks.items():
            mx, my = model_xy(tr, t0, f)
            mu, mv = project(mx + DX, my + DY, f)
            err += np.minimum((mu - u) ** 2 + (mv - v) ** 2, 300.0 ** 2)
        i = np.unravel_index(np.argmin(err), err.shape)
        rms = math.sqrt(err[i] / len(picks))
        if best is None or rms < best["rms"]:
            best = {"file": path, "t0": round(float(t0), 3), "dx": round(float(DX[i]), 3), "dy": round(float(DY[i]), 3),
                    "rms": round(rms, 1)}
    p = {k: sim[k] for k in ("w", "yaw", "mu", "crush", "veer", "roll_deg", "t_rest", "slide_m")}
    print(f"{best['rms']:6.1f}px  t0={best['t0']:.2f}  平移=({best['dx']:+.2f},{best['dy']:+.2f})  {p}")
    if best_all is None or best["rms"] < best_all["rms"]:
        best_all = best

# 最优组合的逐帧误差
sim = json.load(open(best_all["file"]))
tr = sim["track"]
print("\n最优:", best_all)
print(" frame   原片(u,v)    模型(u,v)   误差   车位置(X,Y)  领先本车")
for f, (u, v) in sorted(picks.items()):
    mx, my = model_xy(tr, best_all["t0"], f)
    mx, my = mx + best_all["dx"], my + best_all["dy"]
    mu, mv = project(np.array(mx), np.array(my), f)
    print(f" {f:4d}  ({u:3d},{v:3d})  ({float(mu):5.0f},{float(mv):4.0f})  {math.hypot(mu - u, mv - v):5.1f}"
          f"   ({mx:5.2f},{my:6.1f})  {my - V * (f - 1) / FPS:5.1f}m")
json.dump(best_all, open("out/align.json", "w"))
