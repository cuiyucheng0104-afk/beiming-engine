"""沿车道虚线采样亮度，找每段虚线的起止行，输出 1/(y-yh)（∝ 纵深 Z/f）。"""
import cv2, numpy as np, sys
VP = np.array([428.0, 188.0])
P0 = np.array([612.0, 337.0])      # 第 52 帧近处虚线上的一点
d = (P0 - VP) / np.linalg.norm(P0 - VP)
for f in [int(a) for a in sys.argv[1:]]:
    g = cv2.cvtColor(cv2.imread(f"ref/frames/{f:03d}.png"), cv2.COLOR_BGR2GRAY).astype(float)
    ys, vals = [], []
    for y in np.arange(200, 345, 0.5):
        t = (y - VP[1]) / d[1]
        x = VP[0] + d[0] * t
        xs = np.arange(int(x) - 6, int(x) + 7)
        v = g[int(y), xs].max() - np.median(g[int(y), int(x) - 25:int(x) + 25])
        ys.append(y); vals.append(v)
    vals = np.array(vals); on = vals > 35
    segs, start = [], None
    for y, o in zip(ys, on):
        if o and start is None: start = y
        if not o and start is not None:
            if y - start > 2: segs.append((start, y))
            start = None
    out = []
    for a, b in segs:
        out.append(f"[{a:.0f}-{b:.0f}] z/f {1/(b-VP[1]):.4f}-{1/(a-VP[1]):.4f}")
    print(f, " ".join(out))
