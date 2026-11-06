"""沿翻滚车位置裁剪原片（或渲染）并拼图。用法: crops.py src(ref|dir) start end step out [cols]（24fps 帧号）"""
import cv2, numpy as np, sys
from flip_keys import PICKS as picks
from calib import F30_TO_24 as M
src, a, b, st, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
cols = int(sys.argv[6]) if len(sys.argv) > 6 else 6
ks = sorted(picks)
def center(f):
    if f <= ks[0]: return picks[ks[0]]
    for k0, k1 in zip(ks, ks[1:]):
        if k0 <= f <= k1:
            t = (f - k0) / (k1 - k0); return tuple(picks[k0][i] * (1 - t) + picks[k1][i] * t for i in (0, 1))
    return picks[ks[-1]]
tiles = []
for f in range(a, b + 1, st):
    if src == "ref":
        im = cv2.imread(f"ref/frames24/{f:03d}.png")
    else:
        im = cv2.imread(f"{src}/f_{f:04d}.png"); im = cv2.copyMakeBorder(im, 0, 0, 88, 88, cv2.BORDER_CONSTANT)
    cx, cy = center(f)
    w = int(np.interp(f, [M[43], M[120], M[150], M[190], M[206]], [200, 300, 480, 520, 560])); h = int(w * 0.55)
    x0 = int(min(max(cx - w / 2, 0), 960 - w)); y0 = int(min(max(cy - h * 0.7, 0), 448 - h))
    c = cv2.resize(im[y0:y0 + h, x0:x0 + w], (330, 182), interpolation=cv2.INTER_CUBIC)
    cv2.putText(c, str(f), (5, 22), 0, 0.7, (0, 255, 255), 2); tiles.append(c)
while len(tiles) % cols: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))
