#!/usr/bin/env python3
"""把参考图逐行的清晰度换算成「等效模糊半径」：取每张图最清楚的一条，人为加不同半径的高斯模糊，
得到「清晰度 → 模糊半径」的对照表，再反查每一行。只是估计：内容本身粗细不同会带来误差。
用法：node tools/env/py.mjs films/fanpan-c/tools/dof.py <样图目录>"""
import sys, os
import numpy as np
from PIL import Image, ImageFilter
D = sys.argv[1]; ROWS = 18
def metric(L):
    Y = np.asarray(L, np.float32) / 255
    g1 = np.abs(np.diff(Y, axis=1))[:-1, :] + np.abs(np.diff(Y, axis=0))[:, :-1]
    Yb = np.asarray(L.filter(ImageFilter.GaussianBlur(3)), np.float32) / 255
    g4 = np.abs(Yb[:-4, 4:] - Yb[:-4, :-4]) + np.abs(Yb[4:, :-4] - Yb[:-4, :-4])
    return float(np.percentile(g1, 95) / (np.percentile(g4, 95) + 1e-4))
for n in (1, 2, 3, 4):
    L = Image.open(os.path.join(D, f'{n}.jpg')).convert('L'); W, H = L.size; bh = H // ROWS
    strips = [L.crop((0, r * bh, W, (r + 1) * bh)) for r in range(ROWS)]
    m = [metric(s) for s in strips]; best = int(np.argmax(m))
    sig = [0, .4, .7, 1, 1.5, 2, 3, 4, 6, 8, 12]
    table = [metric(strips[best].filter(ImageFilter.GaussianBlur(s))) if s else m[best] for s in sig]
    est = [float(np.interp(-v, [-t for t in table], sig)) for v in m]     # table 随 sigma 递减
    print(f'样图 {n}：最清楚在第 {best + 1}/{ROWS} 行（画面高度 {100 * (best + .5) / ROWS:.0f}% 处）')
    print('   对照表 sigma→清晰度:', ' '.join(f'{s}:{t:.2f}' for s, t in zip(sig, table)))
    print('   各行等效模糊 sigma(px@1440):', ' '.join(f'{e:.1f}' for e in est))
