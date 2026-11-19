#!/usr/bin/env python3
"""量参考图：逐行清晰度（推景深）、明暗分布、饱和度、亮部与暗部的色相、暗角。
用法：node tools/env/py.mjs films/fanpan-c/tools/analyze.py <样图目录>"""
import sys, os, colorsys
import numpy as np
from PIL import Image, ImageFilter
D = sys.argv[1]
def lin(a): return np.where(a <= .04045, a / 12.92, ((a + .055) / 1.055) ** 2.4)
for n in (1, 2, 3, 4):
    im = Image.open(os.path.join(D, f'{n}.jpg')).convert('RGB'); W, H = im.size
    a = np.asarray(im, np.float32) / 255
    Y = .2126 * a[..., 0] + .7152 * a[..., 1] + .0722 * a[..., 2]
    # 清晰度：1 像素尺度的梯度能量 / 4 像素尺度的梯度能量。模糊的地方这个比值低
    g1 = np.abs(np.diff(Y, axis=1))[:-1, :] + np.abs(np.diff(Y, axis=0))[:, :-1]
    Yb = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(3)), np.float32) / 255
    g4 = np.abs(Yb[:-4, 4:] - Yb[:-4, :-4]) + np.abs(Yb[4:, :-4] - Yb[:-4, :-4])
    rows = 18; bh = H // rows; prof = []
    for r in range(rows):
        s1 = g1[r * bh:(r + 1) * bh]; s4 = g4[r * bh:min((r + 1) * bh, g4.shape[0])]
        prof.append(float(np.percentile(s1, 95) / (np.percentile(s4, 95) + 1e-4)))
    mx = max(prof)
    print(f'--- 样图 {n} {W}x{H}')
    print('  清晰度（上→下，1=最清楚）:', ' '.join(f'{p / mx:.2f}' for p in prof))
    pc = np.percentile(Y, [5, 25, 50, 75, 95, 99])
    print('  亮度分位 5/25/50/75/95/99:', ' '.join(f'{v:.3f}' for v in pc), f' 均值 {Y.mean():.3f}')
    mxc = a.max(-1); mnc = a.min(-1); S = (mxc - mnc) / (mxc + 1e-5)
    def hue(mask):
        px = a[mask]
        if len(px) == 0: return 'n/a'
        m = px.mean(0); h, s, v = colorsys.rgb_to_hsv(*m)
        return f'RGB {tuple(int(x * 255) for x in m)} 色相 {h * 360:.0f}° 饱和 {s:.2f}'
    print(f'  饱和度：全图均值 {S.mean():.2f}，亮部(>P75) {S[Y > pc[3]].mean():.2f}，中间 {S[(Y > pc[1]) & (Y < pc[3])].mean():.2f}，暗部(<P25) {S[Y < pc[1]].mean():.2f}')
    print('  高光(>P95):', hue(Y > pc[4])); print('  亮部(P75-P95):', hue((Y > pc[3]) & (Y < pc[4])))
    print('  中间(P25-P75):', hue((Y > pc[1]) & (Y < pc[3]))); print('  暗部(<P25):', hue(Y < pc[1]))
    cy, cx = H // 2, W // 2
    c = Y[cy - H // 6:cy + H // 6, cx - W // 6:cx + W // 6].mean()
    k = np.mean([Y[:H // 6, :W // 6].mean(), Y[:H // 6, -W // 6:].mean(), Y[-H // 6:, :W // 6].mean(), Y[-H // 6:, -W // 6:].mean()])
    print(f'  暗角：四角均值 {k:.3f} / 中心 {c:.3f} = {k / c:.2f}')
    # 色相分布（只算够亮够艳的像素）
    hsv = np.asarray(im.convert('HSV'), np.float32); m = (hsv[..., 1] > 90) & (hsv[..., 2] > 70)
    hh = np.histogram(hsv[..., 0][m] * 360 / 255, bins=12, range=(0, 360))[0]; hh = hh / max(1, hh.sum())
    print('  艳色像素占比', f'{m.mean():.2f}', ' 色相 30° 一档:', ' '.join(f'{v:.2f}' for v in hh))
