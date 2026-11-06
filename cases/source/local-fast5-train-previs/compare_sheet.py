"""逐镜头对照拼板：每个镜头取一帧（默认中间帧），左原片右白模，5 个镜头一张。
    python3.14 compare_sheet.py [step]   → out/peek/cmp_1.jpg …（step=渲染时的帧间隔，取最近的已渲染帧）"""
import glob
import sys

import cv2
import numpy as np

import calib as cb

step = int(sys.argv[1]) if len(sys.argv) > 1 else 1
have = {int(p[-8:-4]) for p in glob.glob("out/frames24/f_*.*")}
rows = []
for k, (a, b) in cb.SHOTS.items():
    m = (a + b) // 2
    f = min(have, key=lambda x: (abs(x - m) if a <= x <= b else 999 + abs(x - m)))
    ref = cv2.resize(cv2.imread(f"ref/frames24/{f:03d}.jpg"), (512, 218))
    ren = cv2.imread(next(p for p in glob.glob(f"out/frames24/f_{f:04d}.*")))
    ren = cv2.resize(ren, (512, 218))
    cv2.putText(ref, f"{k} f{f}", (6, 22), 0, 0.6, (0, 255, 255), 2)
    rows.append(np.hstack([ref, np.full((218, 4, 3), 255, np.uint8), ren]))
for i in range(0, len(rows), 5):
    cv2.imwrite(f"out/peek/cmp_{i // 5 + 1}.jpg", np.vstack(rows[i:i + 5]), [cv2.IMWRITE_JPEG_QUALITY, 82])
print("ok", len(rows))
