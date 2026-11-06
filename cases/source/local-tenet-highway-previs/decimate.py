"""原片是 24fps 拉成的 30fps：每 5 帧补 1 帧重复帧。找出重复帧、去掉，得到真实时间的 24fps 素材。

    python3 decimate.py

判据：某帧与上一帧的平均像素差，除以前后各 4 个帧间差的中位数。真重复帧的比值 ≤ 0.13，
其余帧 ≥ 0.42，中间没有灰区，阈值取 0.25。
输出：
  data/timebase_24.json   {"dups": [...30fps 帧号], "f30_to_f24": {"1": 1, ...}}（重复帧映射到它复制的那一帧）
  ref/frames24/001.png …   24fps 逐帧
  ref/reference24.mp4      24fps，带原声
"""
import json
import os
import subprocess

import cv2
import numpy as np

SRC, N30 = "ref/frames", 301
fr = [cv2.imread(f"{SRC}/{i:03d}.png", 0)[:, 88:872].astype(np.float32) for i in range(1, N30 + 1)]
d = np.array([np.abs(fr[i] - fr[i - 1]).mean() for i in range(1, N30)])     # d[k]：第 k+2 帧与第 k+1 帧
ratio = [d[k] / np.median(np.r_[d[max(0, k - 4):k], d[k + 1:k + 5]]) for k in range(len(d))]
dups = [k + 2 for k, r in enumerate(ratio) if r < 0.25]

f30_to_f24, n = {}, 0
for f in range(1, N30 + 1):
    if f not in dups:
        n += 1
    f30_to_f24[f] = n
os.makedirs("data", exist_ok=True)
with open("data/timebase_24.json", "w") as fh:
    json.dump({"src_fps": 30, "fps": 24, "frames": n, "dups": dups, "f30_to_f24": f30_to_f24}, fh, indent=1)

os.makedirs("ref/frames24", exist_ok=True)
for f in range(1, N30 + 1):
    if f not in dups:
        cv2.imwrite(f"ref/frames24/{f30_to_f24[f]:03d}.png", cv2.imread(f"{SRC}/{f:03d}.png"))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", "ref/frames24/%03d.png", "-i", "ref/reference.mp4",
                "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-c:a", "copy",
                "-shortest", "ref/reference24.mp4"], check=True)
print(f"重复帧 {len(dups)} 个：{dups}")
print(f"30fps {N30} 帧 → 24fps {n} 帧（{n / 24:.2f}s）")
