"""原片与当前白模的比对图：python3.14 blend.py 帧号 [帧号 …] → 打印 out/peek/blend_NNN.jpg 路径
每张三联：左原片、中白模、右叠化（原片 55% + 白模轮廓线），都带 1280×544 参考坐标网格（每 80 px 一条）。"""
import sys

import cv2
import numpy as np


def grid(im):
    im = im.copy()
    for x in range(0, 1280, 80):
        cv2.line(im, (x, 0), (x, 543), (0, 200, 255), 1)
        cv2.putText(im, str(x), (x + 2, 12), 0, 0.35, (0, 255, 255), 1)
    for y in range(0, 544, 40):
        cv2.line(im, (0, y), (1279, y), (0, 160, 160), 1)
        cv2.putText(im, str(y), (2, y - 2), 0, 0.35, (0, 255, 255), 1)
    return im


for a in sys.argv[1:]:
    f = int(a)
    ref = cv2.imread(f"ref/frames24/{f:03d}.jpg")
    ren = cv2.imread(f"out/frames24/f_{f:04d}.png")
    edges = cv2.Canny(cv2.cvtColor(ren, cv2.COLOR_BGR2GRAY), 30, 90)
    mix = (ref * 0.55 + 128 * 0.45).astype(np.uint8)
    mix[edges > 0] = (0, 0, 255)
    top = np.hstack([grid(ref), grid(ren)])
    bot = np.hstack([grid(mix), np.zeros_like(ref)])
    out = np.vstack([top, bot])
    out = cv2.resize(out, (1600, 680))
    p = f"out/peek/blend_{f:03d}.jpg"
    cv2.imwrite(p, out, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(p)
