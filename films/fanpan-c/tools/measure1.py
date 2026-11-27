#!/usr/bin/env python3
"""量一张出图（和 analyze.py 同一套量法，只是单张）。用法：node tools/env/py.mjs films/fanpan-c/tools/measure1.py <图> [<图>…]"""
import sys, colorsys
import numpy as np
from PIL import Image, ImageFilter
for f in sys.argv[1:]:
    im = Image.open(f).convert('RGB'); W, H = im.size; a = np.asarray(im, np.float32) / 255
    Y = .2126 * a[..., 0] + .7152 * a[..., 1] + .0722 * a[..., 2]
    g1 = np.abs(np.diff(Y, axis=1))[:-1, :] + np.abs(np.diff(Y, axis=0))[:, :-1]
    Yb = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(3 * W / 1440)), np.float32) / 255; k = max(1, round(4 * W / 1440))
    g4 = np.abs(Yb[:-k, k:] - Yb[:-k, :-k]) + np.abs(Yb[k:, :-k] - Yb[:-k, :-k]); rows = 18; bh = H // rows
    prof = [float(np.percentile(g1[r * bh:(r + 1) * bh], 95) / (np.percentile(g4[r * bh:min((r + 1) * bh, g4.shape[0])], 95) + 1e-4)) for r in range(rows)]
    pc = np.percentile(Y, [5, 25, 50, 75, 95, 99]); mx = a.max(-1); S = (mx - a.min(-1)) / (mx + 1e-5)
    def hue(m):
        h, s, v = colorsys.rgb_to_hsv(*a[m].mean(0)); return f'色相 {h * 360:.0f}° 饱和 {s:.2f}'
    c = Y[H // 3:2 * H // 3, W // 3:2 * W // 3].mean(); q = np.mean([Y[:H // 6, :W // 6].mean(), Y[:H // 6, -W // 6:].mean(), Y[-H // 6:, :W // 6].mean(), Y[-H // 6:, -W // 6:].mean()])
    print(f'--- {f} {W}x{H}')
    print('  清晰度（上→下）:', ' '.join(f'{p / max(prof):.2f}' for p in prof))
    print('  亮度 5/25/50/75/95/99:', ' '.join(f'{v:.3f}' for v in pc), f' 均值 {Y.mean():.3f}')
    print(f'  饱和度均值 {S.mean():.2f}；高光 {hue(Y > pc[4])}；中间 {hue((Y > pc[1]) & (Y < pc[3]))}；暗部 {hue(Y < pc[1])}')
    print(f'  暗角 四角/中心 = {q / c:.2f}')
