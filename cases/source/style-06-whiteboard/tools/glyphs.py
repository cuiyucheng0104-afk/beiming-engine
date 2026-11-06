"""CJK outline font (OFL, Google Fonts &text= subset) → single-line strokes in a plausible stroke order.
Render each glyph, thin it to a 1-px skeleton (Zhang–Suen), trace the skeleton graph, join edges that run straight
through a junction, split at sharp corners (keeping 横折 / 竖折 style turns whole), orient each stroke the way a hand
writes it and sort with the usual rules (left component first, top before bottom, horizontal before vertical).
Output: fonts/glyphs.json  {char: {w, s:[[x,y,x,y,...], ...]}} in em units, y down, origin top-left of the em box.
Usage: python tools/glyphs.py fonts/NotoSansSC-w100-subset.ttf <chars> fonts/glyphs.json [--png sheet.png]"""
import sys, json, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

S = 360                     # render size (px per em)
PAD = 40


def raster(font, ch):
    im = Image.new("L", (S + 2 * PAD, S + 2 * PAD + 160), 0)   # CJK glyphs reach ~1.23 em below the origin: keep room for the bottom strokes
    d = ImageDraw.Draw(im)
    d.text((PAD, PAD), ch, font=font, fill=255)
    a = np.array(im) > 110
    return a


def zhang_suen(img):
    I = img.copy().astype(np.uint8)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P = np.pad(I, 1)
            p2, p3, p4, p5 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:], P[2:, 2:]
            p6, p7, p8, p9 = P[2:, 1:-1], P[2:, :-2], P[1:-1, :-2], P[:-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = sum(n.astype(int) for n in nb)
            seq = nb + [p2]
            A = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(int) for i in range(8))
            if step == 0:
                c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            m = (I == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if m.any():
                I[m] = 0; changed = True
    return I.astype(bool)


N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def graph(sk):
    pts = set(zip(*np.nonzero(sk)))
    nbr = {p: [(p[0] + dy, p[1] + dx) for dy, dx in N8 if (p[0] + dy, p[1] + dx) in pts] for p in pts}
    deg = {p: len(v) for p, v in nbr.items()}
    nodes = {p for p in pts if deg[p] != 2}
    # cluster adjacent node pixels into one junction
    cid, clusters = {}, []
    for p in nodes:
        if p in cid: continue
        st, cl = [p], []
        cid[p] = len(clusters)
        while st:
            q = st.pop(); cl.append(q)
            for r in nbr[q]:
                if r in nodes and r not in cid: cid[r] = len(clusters); st.append(r)
        clusters.append(cl)
    edges, seen = [], set()
    for ci, cl in enumerate(clusters):
        for p in cl:
            for q in nbr[p]:
                if q in nodes: continue
                if (p, q) in seen: continue
                path = [p, q]; prev, cur = p, q
                while cur not in nodes:
                    nx = [r for r in nbr[cur] if r != prev and r not in path[-3:]]
                    if not nx: break
                    prev, cur = cur, nx[0]; path.append(cur)
                seen.add((p, q)); seen.add((path[-1], path[-2]))
                e = (ci, cid.get(path[-1], -1), path)
                edges.append(e)
    # dedupe edges traced from both ends
    uniq, keys = [], set()
    for a, b, path in edges:
        k = (min(path[0], path[-1]), max(path[0], path[-1]), len(path))
        if k in keys: continue
        keys.add(k); uniq.append([a, b, path])
    # pure cycles (no junction)
    used = {p for _, _, path in uniq for p in path} | nodes
    for p in pts:
        if p in used: continue
        path = [p]; prev, cur = None, p
        while True:
            nx = [r for r in nbr[cur] if r != prev and r not in path[-2:]]
            if not nx or (nx[0] == p): break
            prev, cur = cur, nx[0]
            if cur in path: break
            path.append(cur)
        for q in path: used.add(q)
        path.append(path[0])
        uniq.append([-1, -1, path])
    return clusters, uniq, deg


def dirvec(path, k=10):
    a = np.array(path[0], float); b = np.array(path[min(k, len(path) - 1)], float)
    v = b - a; n = np.linalg.norm(v); return v / n if n else v


def strokes_of(sk):
    clusters, edges, deg = graph(sk)
    # prune short spurs ending in an endpoint
    def is_end(ci, path): return ci == -1 or (len(clusters[ci]) == 1 and deg[clusters[ci][0]] == 1)
    keep = []
    for a, b, path in edges:
        L = len(path)
        if L < 9 and a != -1 and b != -1 and (is_end(a, path) != is_end(b, path)):
            continue
        keep.append([a, b, path])
    edges = keep
    # at each junction pair the most opposite edges
    inc = {}
    for i, (a, b, path) in enumerate(edges):
        if a >= 0: inc.setdefault(a, []).append((i, 0))
        if b >= 0 and not (a == b and a >= 0 and False): inc.setdefault(b, []).append((i, 1))
    link = {}
    for ci, L in inc.items():
        if len(clusters[ci]) == 1 and deg[clusters[ci][0]] == 1: continue
        vs = []
        for i, end in L:
            p = edges[i][2] if end == 0 else edges[i][2][::-1]
            vs.append((i, end, dirvec(p)))
        pairs = []
        for x in range(len(vs)):
            for y in range(x + 1, len(vs)):
                if vs[x][0] == vs[y][0]: continue
                pairs.append((float(vs[x][2] @ vs[y][2]), x, y))
        pairs.sort()
        used = set()
        for d, x, y in pairs:
            if d > -0.8: break
            if x in used or y in used: continue
            used |= {x, y}
            link[(vs[x][0], vs[x][1])] = (vs[y][0], vs[y][1])
            link[(vs[y][0], vs[y][1])] = (vs[x][0], vs[x][1])
    # chain edges
    done, chains = set(), []
    for i in range(len(edges)):
        if i in done: continue
        # walk to one extremity
        cur, end = i, 0
        guard = 0
        while (cur, end) in link and guard < 50:
            nxt = link[(cur, end)]
            if nxt[0] == i: break
            cur, end = nxt[0], 1 - nxt[1]; guard += 1
        # now traverse from (cur, end) forward
        pts, e, s = [], cur, end
        guard = 0
        while guard < 50:
            done.add(e)
            p = edges[e][2] if s == 0 else edges[e][2][::-1]
            pts += p if not pts else p[1:]
            key = (e, 1 - s)
            if key not in link: break
            nxt = link[key]
            if nxt[0] in done: break
            e, s = nxt[0], nxt[1]; guard += 1
        chains.append(pts)
    return [c for c in chains if len(c) >= 3]


def rdp(P, eps):
    if len(P) < 3: return P
    a, b = np.array(P[0], float), np.array(P[-1], float)
    ab = b - a; L = np.linalg.norm(ab)
    best, bi = 0, 0
    for i in range(1, len(P) - 1):
        p = np.array(P[i], float)
        q = p - a; d = abs(ab[0] * q[1] - ab[1] * q[0]) / L if L else np.linalg.norm(q)
        if d > best: best, bi = d, i
    if best > eps: return rdp(P[:bi + 1], eps)[:-1] + rdp(P[bi:], eps)
    return [P[0], P[-1]]


def smooth(P, it=2):
    P = np.array(P, float)
    for _ in range(it):
        Q = P.copy(); Q[1:-1] = (P[:-2] + 2 * P[1:-1] + P[2:]) / 4; P = Q
    return P


def orient(P):
    """the way a hand writes it: mostly-horizontal strokes from the left, others from the top"""
    a, b = P[0], P[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    if abs(dx) > abs(dy) * 1.1:
        return P if dx > 0 else P[::-1]
    return P if dy > 0 else P[::-1]


def split_corners(P):
    """P: list of (x,y). Split where the path turns sharply, unless it's a 横折 (right → down) or 竖折 (down → right)."""
    S_ = rdp([tuple(p) for p in P], 3.0)
    if len(S_) < 3: return [P]
    cuts = []
    for i in range(1, len(S_) - 1):
        v1 = np.subtract(S_[i], S_[i - 1]); v2 = np.subtract(S_[i + 1], S_[i])
        n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
        if n1 < 6 or n2 < 6: continue
        c = float(v1 @ v2 / n1 / n2)
        if c > 0.45: continue                         # gentle bend: keep
        u1, u2 = v1 / n1, v2 / n2
        hz = lambda u: u[0] > .8                       # going right
        dn = lambda u: u[1] > .55                      # going down (y down)
        if (hz(u1) and dn(u2)) or (dn(u1) and u2[0] > .7) or (hz(u1) and u2[1] > .3 and u2[0] < 0):
            continue                                   # 横折 / 竖折 / 横撇: one stroke
        cuts.append(S_[i])
    if not cuts: return [P]
    out, cur = [], []
    Pt = [tuple(p) for p in P]
    for p in Pt:
        cur.append(p)
        if p in cuts and len(cur) > 1:
            out.append(cur); cur = [p]
    out.append(cur)
    return [o for o in out if len(o) >= 2]


def glyph(font, ch):
    a = raster(font, ch)
    if not a.any(): return None
    sk = zhang_suen(a)
    chains = strokes_of(sk)
    strokes = []
    for c in chains:
        P = [(p[1], p[0]) for p in c]                  # (x, y)
        closed = len(P) > 8 and math.dist(P[0], P[-1]) < 3
        for piece in split_corners(P):
            piece = orient(piece)
            if len(piece) < 2: continue
            L = sum(math.dist(piece[i], piece[i + 1]) for i in range(len(piece) - 1))
            if L < 4: continue
            strokes.append(piece)
    # merge pieces that continue each other almost straight (split artefacts)
    # component columns: x ranges of connected skeleton parts
    ys, xs = np.nonzero(a)
    x0, x1 = xs.min(), xs.max()
    def col(st):
        mx = np.mean([p[0] for p in st]); return mx
    # find a clear vertical gap in the x-projection of the strokes → left / right components
    proj = np.zeros(a.shape[1], int)
    for st in strokes:
        sx = [p[0] for p in st]; proj[int(min(sx)):int(max(sx)) + 1] += 1
    gap = None
    inner = proj[x0 + int((x1 - x0) * .2): x0 + int((x1 - x0) * .8)]
    zero = np.nonzero(inner == 0)[0]
    if len(zero): gap = x0 + int((x1 - x0) * .2) + int(zero.mean())
    def key(st):
        sx, sy = st[0]
        xs_ = [p[0] for p in st]; ys_ = [p[1] for p in st]
        w, h = max(xs_) - min(xs_), max(ys_) - min(ys_)
        horiz = w > h * 1.6
        comp = 0 if gap is None else (0 if np.mean(xs_) < gap else 1)
        k = min(ys_) + 0.35 * min(xs_) - (0.12 * S if horiz else 0)
        return (comp, k)
    strokes.sort(key=key)
    # closing bottom strokes of boxes go last within their component: a horizontal at the very bottom of a box
    out = []
    for st in strokes:
        P = smooth(st, 2)
        P = rdp([tuple(p) for p in P], 1.2)
        out.append([round((x - PAD) / S, 4) if i % 2 == 0 else round((y - PAD) / S, 4) for (x, y) in P for i in (0, 1)])
    # fix the flattening above (x,y pairs)
    fixed = []
    for st in out:
        fixed.append(st)
    return fixed


# Hand-defined glyphs (em units, same frame as the skeleton output). The skeleton reads 光's three top strokes as two
# dots and a tick and splits the 竖弯钩, so on the board it looked like "米:"; it is written here stroke by stroke in the
# standard order 丨 丶 丿 一 丿 乚. The ？ dot is a round blob whose skeleton collapses to a point, so it gets a short tap.
OVERRIDE = {
    '光': [[0.497, 0.315, 0.497, 0.738],                                           # 竖: long, reaches the 横
           [0.195, 0.435, 0.232, 0.505, 0.264, 0.570, 0.296, 0.636],              # 左点
           [0.812, 0.428, 0.776, 0.498, 0.740, 0.560, 0.700, 0.628],              # 右撇
           [0.075, 0.742, 0.922, 0.742],                                           # 横
           [0.364, 0.750, 0.353, 0.850, 0.335, 0.936, 0.310, 1.003, 0.251, 1.097, 0.204, 1.143, 0.154, 1.175, 0.070, 1.210],  # 撇
           [0.622, 0.750, 0.624, 1.120, 0.635, 1.180, 0.665, 1.207, 0.720, 1.213, 0.872, 1.214, 0.905, 1.200, 0.921, 1.150, 0.933, 1.058]],  # 竖弯钩
}
EXTRA = {'？': [[0.222, 1.100, 0.236, 1.118, 0.240, 1.128]]}


def main():
    fn, chars, outp = sys.argv[1], sys.argv[2], sys.argv[3]
    png = sys.argv[sys.argv.index('--png') + 1] if '--png' in sys.argv else None
    font = ImageFont.truetype(fn, S)
    res = {}
    for ch in dict.fromkeys(chars):
        g = OVERRIDE.get(ch) or glyph(font, ch)
        if g is None: continue
        g = g + EXTRA.get(ch, [])
        res[ch] = {'w': 1.0, 's': g}
        print(ch, len(g), 'strokes')
    json.dump(res, open(outp, 'w'), ensure_ascii=False)
    if png:
        cell = 220; cols = 8; rows = math.ceil(len(res) / cols)
        im = Image.new('RGB', (cols * cell, rows * cell), 'white'); d = ImageDraw.Draw(im)
        for k, (ch, g) in enumerate(res.items()):
            ox, oy = (k % cols) * cell + 10, (k // cols) * cell + 10
            for j, st in enumerate(g['s']):
                pts = [(ox + st[i] * 200, oy + st[i + 1] * 200) for i in range(0, len(st), 2)]
                hue = j / max(1, len(g['s']) - 1)
                colr = (int(220 * hue), 40, int(220 * (1 - hue)))
                d.line(pts, fill=colr, width=4)
                d.ellipse([pts[0][0] - 5, pts[0][1] - 5, pts[0][0] + 5, pts[0][1] + 5], fill=colr)
                d.text((pts[0][0] + 4, pts[0][1] - 12), str(j + 1), fill=(0, 0, 0))
        im.save(png)


main()
