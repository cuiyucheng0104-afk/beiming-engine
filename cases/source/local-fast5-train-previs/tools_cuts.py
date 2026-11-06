"""在 24fps 参考帧上找剪辑点，写 data/shots.json（镜头号 → 首末帧，24fps 帧号从 1 起）。"""
import json
import cv2
import numpy as np

N = 646
fr = [cv2.resize(cv2.imread(f"ref/frames24/{i:03d}.jpg", 0), (320, 136)).astype(np.float32) for i in range(1, N + 1)]
# 用直方图差 + 像素差联合判剪辑：快速运动镜头像素差大，但直方图差小
def hist(a):
    h = cv2.calcHist([a.astype(np.uint8)], [0], None, [32], [0, 256]).ravel()
    return h / h.sum()
d = np.array([np.abs(fr[i] - fr[i - 1]).mean() for i in range(1, N)])
hd = np.array([np.abs(hist(fr[i]) - hist(fr[i - 1])).sum() for i in range(1, N)])
starts = [1]
for k in range(len(d)):
    f = k + 2
    loc = np.median(np.r_[d[max(0, k - 5):k], d[k + 1:k + 6]])
    if (d[k] > 3.0 * loc and d[k] > 12) or hd[k] > 0.5:
        if f - starts[-1] >= 3:
            starts.append(f)
shots = {}
for i, a in enumerate(starts):
    b = (starts[i + 1] - 1) if i + 1 < len(starts) else N
    shots[f"S{i + 1:02d}"] = [a, b]
json.dump(shots, open("data/shots.json", "w"), indent=1)
for k, (a, b) in shots.items():
    print(k, a, b, f"{(b - a + 1) / 24:.2f}s")
