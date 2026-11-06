"""从参考静帧里提色板（k-means，纯 numpy），输出色值、占比和一张色卡图。
用法：.venv/bin/python tools/palette.py [--k 10] [--out palette.png] 图1 图2 ...
"""
import sys
import numpy as np
from PIL import Image, ImageDraw


def main(a):
    k = 10; out = 'palette.png'
    if '--k' in a: i = a.index('--k'); k = int(a[i + 1]); del a[i:i + 2]
    if '--out' in a: i = a.index('--out'); out = a[i + 1]; del a[i:i + 2]
    px = []
    for f in a:
        im = Image.open(f).convert('RGB'); im.thumbnail((200, 200)); px.append(np.asarray(im).reshape(-1, 3))
    X = np.concatenate(px).astype(np.float32)
    rng = np.random.default_rng(7); C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(30):
        lab = np.argmin(((X[:, None] - C[None]) ** 2).sum(-1), 1)
        C = np.array([X[lab == j].mean(0) if (lab == j).any() else C[j] for j in range(k)])
    share = np.bincount(lab, minlength=k) / len(X); order = np.argsort(-share)
    sw = Image.new('RGB', (k * 100, 130), (255, 255, 255)); dr = ImageDraw.Draw(sw)
    for n, j in enumerate(order):
        c = tuple(int(v) for v in C[j]); hx = '#%02X%02X%02X' % c
        dr.rectangle([n * 100, 0, n * 100 + 99, 99], fill=c); dr.text((n * 100 + 4, 104), f'{hx} {share[j]*100:.0f}%', fill=(0, 0, 0))
        print(hx, f'{share[j]*100:.1f}%')
    sw.save(out); print(out)


if __name__ == '__main__':
    main(sys.argv[1:])
