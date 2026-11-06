"""从原画提取轮廓线，并接成一笔（不依赖 OpenCV）"""
import numpy as np
from scipy import ndimage as ndi
from PIL import Image

N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def edges(img, sc=2, sigma=2.0, hi=90, lo=78, mask=None):
    """Canny 式：高斯梯度 + 非极大抑制 + 双阈值。返回 (h,w) bool，分辨率 = 原图/sc"""
    w, h = img.size
    a = np.asarray(img.resize((w // sc, h // sc), Image.LANCZOS), np.float32) / 255
    chans = [a @ np.array([.3, .59, .11], np.float32), a[..., 0] - a[..., 1], a[..., 2] - a[..., 1]]
    gx = gy = 0
    for k, c in enumerate(chans):
        g = ndi.gaussian_filter(c, sigma)
        wgt = 1.0 if k == 0 else .6
        sx, sy = ndi.sobel(g, 1), ndi.sobel(g, 0)
        gx, gy = gx + wgt * sx, gy + wgt * sy
    mag = np.hypot(gx, gy)
    ang = (np.rad2deg(np.arctan2(gy, gx)) + 180) % 180
    q = np.zeros_like(mag, np.int8)
    q[(ang >= 22.5) & (ang < 67.5)] = 1
    q[(ang >= 67.5) & (ang < 112.5)] = 2
    q[(ang >= 112.5) & (ang < 157.5)] = 3
    off = {0: (0, 1), 1: (1, 1), 2: (1, 0), 3: (1, -1)}
    nms = np.zeros_like(mag, bool)
    for k, (dy, dx) in off.items():
        f = np.roll(np.roll(mag, dy, 0), dx, 1)
        b = np.roll(np.roll(mag, -dy, 0), -dx, 1)
        nms |= (q == k) & (mag >= f) & (mag >= b)
    m = mag * nms
    if mask is not None:
        m = m * mask
    v = m[m > 0]
    H_, L_ = np.percentile(v, hi), np.percentile(v, lo)
    weak = m > L_
    lab, n = ndi.label(weak, np.ones((3, 3)))
    keep = np.zeros(n + 1, bool)
    keep[np.unique(lab[m > H_])] = True
    keep[0] = False
    return keep[lab]


def trace(e, minlen=10):
    """把细边缘像素追成折线"""
    ys, xs = np.nonzero(e)
    S = set(zip(ys.tolist(), xs.tolist()))
    deg = {}
    for p in S:
        deg[p] = sum((p[0] + dy, p[1] + dx) in S for dy, dx in N8)
    seen, lines = set(), []
    order = sorted(S, key=lambda p: deg[p])          # 先从端点出发
    for s in order:
        if s in seen:
            continue
        line, cur = [s], s
        seen.add(s)
        while True:
            nxt = None
            for dy, dx in N8:
                c = (cur[0] + dy, cur[1] + dx)
                if c in S and c not in seen:
                    nxt = c
                    if dy == 0 or dx == 0:
                        break
            if nxt is None:
                break
            seen.add(nxt)
            line.append(nxt)
            cur = nxt
        if len(line) >= minlen:
            lines.append(np.array([(x, y) for y, x in line], float))
    return lines


def smooth(p, k=3):
    if len(p) < 5:
        return p
    q = p.copy()
    for _ in range(k):
        q[1:-1] = .25 * q[:-2] + .5 * q[1:-1] + .25 * q[2:]
    return q[::2] if len(q) > 8 else q


def join(lines, start=None):
    """贪心按最近端点把线段接成一笔；返回 [(path, is_connector)]"""
    rest = [smooth(l) for l in lines]
    if not rest:
        return []
    if start is None:
        i0 = int(np.argmin([l[:, 1].min() for l in rest]))
    else:
        i0 = int(np.argmin([min(np.hypot(*(l[0] - start)), np.hypot(*(l[-1] - start))) for l in rest]))
    cur = rest.pop(i0)
    out = [(cur, False)]
    while rest:
        end = cur[-1]
        d0 = np.array([np.hypot(*(l[0] - end)) for l in rest])
        d1 = np.array([np.hypot(*(l[-1] - end)) for l in rest])
        j = int(np.argmin(np.minimum(d0, d1)))
        l = rest.pop(j)
        if d1[j] < d0[j]:
            l = l[::-1]
        out.append((np.array([end, l[0]]), True))
        out.append((l, False))
        cur = l
    return out
