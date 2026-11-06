"""把 out/motion_curve.csv 画成曲线图（重心速度 / 加速度 / 角速度），检查运动是否平顺。"""
import csv, cv2, numpy as np
from calib import F30_TO_24 as M
A, B = M[50], M[265]                       # 镜头 2 的翻滚段（24fps 帧号）
S0, S1 = M[128], M[182]                     # 逐帧校正段
rows = [r for r in csv.DictReader(open("out/motion_curve.csv")) if A <= int(r["frame"]) <= B]
F = [int(r["frame"]) for r in rows]
series = [("重心速度 m/s", "speed", 25, (230, 140, 40)), ("加速度 m/s2", "accel", 100, (60, 60, 220)),
          ("角速度 rad/s", "omega", 14, (40, 160, 60))]
W, H, L, T = 1400, 180, 70, 24
img = np.full((T + 3 * (H + 30) + 30, W, 3), 255, np.uint8)
x = lambda f: int(L + (f - A) / (B - A) * (W - L - 20))
for k, (name, key, vmax, col) in enumerate(series):
    y0 = T + k * (H + 30)
    cv2.rectangle(img, (L, y0), (W - 20, y0 + H), (200, 200, 200), 1)
    for f in range(A - A % 10 + 10, B + 1, 10):
        cv2.line(img, (x(f), y0), (x(f), y0 + H), (235, 235, 235), 1)
        cv2.putText(img, str(f), (x(f) - 10, y0 + H + 14), 0, 0.38, (120, 120, 120), 1)
    cv2.rectangle(img, (x(S0), y0), (x(S1), y0 + H), (250, 235, 220), -1)
    pts = [(x(f), int(y0 + H - min(float(r[key]), vmax) / vmax * H)) for f, r in zip(F, rows)]
    cv2.polylines(img, [np.array(pts)], False, col, 2, cv2.LINE_AA)
    cv2.putText(img, f"{key}  max {vmax}", (L + 6, y0 + 16), 0, 0.5, col, 1, cv2.LINE_AA)
cv2.putText(img, f"frame @24fps  (shaded = {S0}-{S1})", (L, T - 6), 0, 0.5, (80, 80, 80), 1)
cv2.imwrite("out/motion_curve.png", img)
