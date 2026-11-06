"""懂你的人 · 重新构思：三个方向的示意静帧
① 一根线（one-line）  ② 解码（lidar + hud）  ③ 字号即勇气（swiss-motion）
输出 ~/Desktop/懂你的人/风格样张/重构三方向/"""
import os, math
import numpy as np
from scipy import ndimage as ndi
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

SRC = os.path.expanduser('~/Desktop/懂你的人/素材/')
OUT = os.path.expanduser('~/Desktop/懂你的人/风格样张/重构三方向/')
os.makedirs(OUT, exist_ok=True)
W, H = 1920, 1080
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
PAPER = (245, 241, 232)
INK = (40, 36, 32)
GOLD = (236, 176, 64)
G = (120, 255, 170)


def ft(s, i=1):
    return ImageFont.truetype(HIRA, s, index=i)


def load(n):
    return Image.open(SRC + f'i{n:02d}.png').convert('RGB').resize((W, H), Image.LANCZOS)


def save(im, name):
    im.convert('RGB').save(OUT + name, quality=91)


# ================================================================ ① 一根线
def edge_map(im):
    a = np.asarray(im.resize((W // 2, H // 2), Image.LANCZOS), np.float32) / 255
    lum = a @ np.array([.3, .59, .11], np.float32)
    m = ndi.gaussian_gradient_magnitude(lum, 1.6)
    for c in range(3):
        m = m + .5 * ndi.gaussian_gradient_magnitude(a[..., c], 1.6)
    m = m / (np.percentile(m, 99.5) + 1e-6)
    return np.clip(m, 0, 1)


def poly_mask(polys, ellipses=(), blur=0):
    m = Image.new('L', (W // 2, H // 2), 0)
    d = ImageDraw.Draw(m)
    for p in polys:
        d.polygon([(x / 2, y / 2) for x, y in p], fill=255)
    for (x0, y0, x1, y1) in ellipses:
        d.ellipse((x0 / 2, y0 / 2, x1 / 2, y1 / 2), fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(m, np.float32) / 255


def sample_pts(em, mask, n, gamma=1.8, seed=0):
    p = (em ** gamma) * mask
    p = p.ravel() / p.sum()
    idx = np.random.default_rng(seed).choice(len(p), n, replace=False, p=p)
    ys, xs = np.divmod(idx, em.shape[1])
    j = np.random.default_rng(seed + 1).random((n, 2)) - .5
    return np.stack([xs + j[:, 0], ys + j[:, 1]], 1) * 2


def nn_tour(pts, start=None):
    n = len(pts)
    left = np.ones(n, bool)
    cur = int(np.argmin(pts[:, 1])) if start is None else int(np.argmin(((pts - start) ** 2).sum(1)))
    order = [cur]
    left[cur] = False
    for _ in range(n - 1):
        d = ((pts - pts[cur]) ** 2).sum(1)
        d[~left] = np.inf
        cur = int(np.argmin(d))
        order.append(cur)
        left[cur] = False
    return pts[order]


def two_opt(path, iters=4, win=60):
    p = path.copy()
    n = len(p)
    for _ in range(iters):
        improved = False
        for i in range(1, n - 2):
            a, b = p[i - 1], p[i]
            j1 = min(n - 1, i + win)
            c = p[i + 1:j1]
            dd = p[i + 2:j1 + 1]
            k = min(len(c), len(dd))
            if k <= 0:
                continue
            c, dd = c[:k], dd[:k]
            old = np.hypot(*(a - b)) + np.hypot(*(c - dd).T)
            new = np.hypot(*(a - c).T) + np.hypot(*(b - dd).T)
            g = old - new
            jj = int(np.argmax(g))
            if g[jj] > 1e-3:
                j = i + 1 + jj
                p[i:j + 1] = p[i:j + 1][::-1].copy()
                improved = True
        if not improved:
            break
    return p


def chaikin(p, k=2):
    for _ in range(k):
        q = np.empty((len(p) * 2 - 2, 2))
        q[0::2] = .75 * p[:-1] + .25 * p[1:]
        q[1::2] = .25 * p[:-1] + .75 * p[1:]
        p = q
    return p


def line_layer(paths, width=3.0, color=INK, alpha=255, dash=None, ss=2):
    L = Image.new('L', (W * ss, H * ss), 0)
    d = ImageDraw.Draw(L)
    for p in paths:
        q = [(float(x) * ss, float(y) * ss) for x, y in p]
        if dash:
            on, off = dash
            seg, acc, draw = [q[0]], 0, True
            for a, b in zip(q[:-1], q[1:]):
                acc += math.hypot(b[0] - a[0], b[1] - a[1])
                seg.append(b)
                if acc > (on if draw else off) * ss:
                    if draw and len(seg) > 1:
                        d.line(seg, fill=alpha, width=int(width * ss), joint='curve')
                    seg, acc, draw = [b], 0, not draw
        else:
            d.line(q, fill=alpha, width=int(width * ss), joint='curve')
    L = L.resize((W, H), Image.LANCZOS)
    lay = Image.new('RGBA', (W, H), color + (255,))
    lay.putalpha(L)
    return lay


def paper():
    r = np.random.default_rng(5)
    n = ndi.gaussian_filter(r.random((H, W)).astype(np.float32), 1.2)
    n = (n - n.mean()) / n.std()
    a = np.array(PAPER, np.float32) * (1 + .012 * n[..., None])
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - .07 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    return Image.fromarray(np.clip(a * v[..., None], 0, 255).astype(np.uint8)).convert('RGBA')


def pen(canvas, xy):
    """笔尖 + 纸上的软影"""
    x, y = xy
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 30, y + 26), (x + 330, y - 230), (x + 360, y - 200), (x + 52, y + 44)], fill=(60, 45, 30, 60))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14)))
    d = ImageDraw.Draw(canvas)
    d.ellipse((x - 5, y - 5, x + 5, y + 5), fill=INK + (255,))


def drawing(n, polys=(), ells=(), npts=None, seed=0, gamma=None, start=None, sc=1, sigma=2.4, hi=86, lo=66, minlen=14):
    """原画轮廓 → 一笔（返回 [(path, 是否连接段)]，坐标为 1920×1080）"""
    import contour as C
    m = poly_mask(polys, ells)
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((W // sc, H // sc)), np.float32) / 255
    e = C.edges(load(n), sc, sigma, hi, lo, mask=m)
    J = C.join(C.trace(e, minlen), None if start is None else np.array(start) / sc)
    return [(p * sc, con) for p, con in J]


def ink(segs, width=2.6, color=INK, alpha=255, dash=None):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    lines = [p for p, c in segs if not c]
    cons = [p for p, c in segs if c]
    lay.alpha_composite(line_layer(cons, max(1.0, width * .45), color, int(alpha * .22), dash=dash))
    lay.alpha_composite(line_layer(lines, width, color, alpha, dash=dash))
    return lay


def last(segs):
    return segs[-1][0][-1]


def bloom(canvas, img, mask_fn, edge_ink=True):
    """原画在线框里绽开：墨洇边"""
    m = mask_fn()
    noise = ndi.gaussian_filter(np.random.default_rng(9).random((H // 4, W // 4)).astype(np.float32), 4)
    noise = (noise - noise.min()) / (noise.max() - noise.min())
    nz = Image.fromarray((noise * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
    mm = np.asarray(m, np.float32) / 255 * (.75 + .5 * np.asarray(nz, np.float32) / 255)
    mm = np.clip((mm - .5) * 4 + .5, 0, 1)
    M = Image.fromarray((mm * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
    pic = img.convert('RGBA')
    canvas = Image.composite(pic, canvas, M)
    if edge_ink:
        e = ImageChops.subtract(M.filter(ImageFilter.MaxFilter(5)), M.filter(ImageFilter.MinFilter(5)))
        ink = Image.new('RGBA', (W, H), (60, 50, 40, 255))
        ink.putalpha(e.point(lambda v: v * .5))
        canvas.alpha_composite(ink)
    return canvas


def tangle(cx, cy, r, n=900, seed=3, turns=1.0):
    rng = np.random.default_rng(seed)
    p = np.zeros((n, 2))
    pos, ang = np.array([cx, cy], float), 0.0
    curv = ndi.gaussian_filter1d(rng.normal(0, 1, n), 6) * .9
    for i in range(n):
        ang += curv[i] * turns
        v = pos + 9 * np.array([math.cos(ang), math.sin(ang)])
        d = v - [cx, cy]
        if np.hypot(*d) > r:
            ang += math.pi * .7
            v = pos + 9 * np.array([math.cos(ang), math.sin(ang)])
        pos = v
        p[i] = pos
    return chaikin(p, 2)


def text_outline(canvas, xy, text, size, color=INK, w=2, fill=None):
    d = ImageDraw.Draw(canvas)
    d.text(xy, text, font=ft(size, 0), fill=fill if fill else PAPER + (0,), stroke_width=w, stroke_fill=color + (255,))


def sub(canvas, text, y=995, color=INK):
    d = ImageDraw.Draw(canvas)
    f = ft(32, 0)
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=color + (230,))


def oneline():
    # L1 孤独：线只画得出陈默；人群是远处断开的虚线
    boy = [(200, 40), (540, 40), (560, 1020), (180, 1020)]
    p1 = drawing(2, [boy], sc=1, sigma=2.2, hi=84, lo=62)
    crowd = drawing(2, [[(600, 120), (1900, 120), (1900, 980), (600, 980)]], sc=2, sigma=2.4, hi=90, lo=76)
    cv = paper()
    face = drawing(2, ells=[(330, 80, 545, 270)], sc=1, sigma=1.3, hi=78, lo=45, minlen=8)
    cv.alpha_composite(ink([(p, False) for p, c in crowd if not c], 1.8, (110, 102, 92), 220, dash=(7, 11)))
    cv.alpha_composite(ink(p1, 2.4))
    cv.alpha_composite(ink(face, 1.8))
    d = ImageDraw.Draw(cv)
    d.text((452, 206), '借过', font=ft(17, 0), fill=INK + (150,))
    pen(cv, last(p1))
    sub(cv, '放学的人群里，没有人喊陈默。')
    save(cv, '1-1_一根线_孤独.jpg')

    # L2 咕噜：球球说的话是一团乱线
    qiu = [(760, 120), (1460, 120), (1480, 880), (740, 880)]
    p2 = drawing(5, [qiu], sc=1, sigma=2.2, hi=84, lo=62)
    hand = drawing(5, [[(0, 560), (560, 560), (620, 1080), (0, 1080)]], sc=2, sigma=2.2, hi=86, lo=70)
    cv = paper()
    cv.alpha_composite(ink(hand, 2.0, INK, 210))
    cv.alpha_composite(ink(p2, 2.4))
    t = tangle(560, 330, 170, 1100, 7, 1.2)
    e2 = last(p2)
    link = np.array([e2, [(e2[0] + 560) / 2, 250], t[0]])
    cv.alpha_composite(line_layer([chaikin(link, 3), t], 2.4))
    pen(cv, t[-1])
    sub(cv, '阳台突然一阵响动，白床单里滚出一个小家伙。')
    save(cv, '1-2_一根线_咕噜乱线.jpg')

    # L3 听懂了：镜片框里，乱线被理顺成字，彩色原画随之绽开
    img = load(5)
    lens = (300, 90, 1620, 900)

    def lm():
        m = Image.new('L', (W, H), 0)
        ImageDraw.Draw(m).rounded_rectangle(lens, radius=220, fill=255)
        return m.filter(ImageFilter.GaussianBlur(40))
    cv = paper()
    cv.alpha_composite(ink(hand + p2, 2.2, INK, 210))
    cv = bloom(cv, img, lm)
    fr = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(fr).rounded_rectangle(lens, radius=220, outline=INK + (255,), width=5)
    cv.alpha_composite(fr)
    t2 = tangle(330, 960, 90, 500, 7, 1.2)                        # 剩下的一小团乱线，正在被拉直
    straight = np.linspace(t2[-1], [520, 975], 30)
    cv.alpha_composite(line_layer([t2, straight], 2.4))
    plate = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(plate).rounded_rectangle((500, 925, 1440, 1030), radius=20, fill=PAPER + (235,))
    cv.alpha_composite(plate)
    text_outline(cv, (530, 940), '别、别打我……我只是，迷路了。', 56, INK, 2, INK + (255,))
    pen(cv, (1400, 1000))
    save(cv, '1-3_一根线_听懂了.jpg')

    # L4 我叫陈默：这根线写出他的话，再连向台下每一个人
    img = load(16)
    boy16 = [(820, 40), (1600, 40), (1620, 1080), (820, 1080)]
    p4 = drawing(16, [boy16], sc=1, sigma=2.2, hi=84, lo=62)
    aud = drawing(16, [[(0, 560), (820, 520), (820, 1080), (0, 1080)]], sc=2, sigma=2.4, hi=88, lo=74)
    cv = paper()
    cv.alpha_composite(ink(aud, 1.6, (120, 112, 100), 200))
    cv.alpha_composite(ink(drawing(16, ells=[(1080, 120, 1340, 380)], sc=1, sigma=1.3, hi=78, lo=45, minlen=8), 1.8))
    cv.alpha_composite(ink(p4, 2.4))
    d = ImageDraw.Draw(cv)
    for i, l in enumerate(['我刚那句，', '能不能让我', '再说一遍？']):
        d.text((80, 60 + i * 132), l, font=ft(112, 1), fill=PAPER + (0,), stroke_width=4, stroke_fill=INK + (255,))
    heads = sorted([(110, 720), (250, 640), (400, 700), (540, 630), (690, 690), (780, 610)], key=lambda h: -h[0])
    path = [(1060, 330), (900, 470)]
    for h in heads:
        path += [((path[-1][0] + h[0]) / 2, min(path[-1][1], h[1]) - 70), h]
    cv.alpha_composite(line_layer([chaikin(np.array(path), 3)], 2.2, INK, 230))
    for (x, y) in heads:
        ImageDraw.Draw(cv).ellipse((x - 7, y - 7, x + 7, y + 7), fill=GOLD + (255,))
    sub(cv, '台下的笑声，变成了掌声。')
    save(cv, '1-4_一根线_我叫陈默.jpg')

    # L5 告别：线升上夜空，成了那颗移动的星（全片唯一一次金色）
    boy20 = [(1300, 330), (1640, 330), (1640, 880), (1300, 880)]
    p5 = drawing(20, [boy20], sc=1, sigma=2.0, hi=82, lo=60)
    city = drawing(20, [[(0, 520), (1920, 480), (1920, 760), (0, 800)]], sc=2, sigma=2.0, hi=88, lo=72)
    cv = paper()
    cv.alpha_composite(ink(city, 1.6, INK, 200))
    cv.alpha_composite(ink(p5, 2.4))
    e5 = last(p5)
    up = chaikin(np.array([e5, [1500, 260], [1100, 180], [760, 110]]), 4)
    cv.alpha_composite(line_layer([up], 2.0))
    gl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gl)
    gd.ellipse((735, 85, 785, 135), fill=GOLD + (200,))
    gl = gl.filter(ImageFilter.GaussianBlur(12))
    cv.alpha_composite(gl)
    ImageDraw.Draw(cv).ellipse((752, 102, 768, 118), fill=GOLD + (255,))
    sub(cv, '飞船变成夜空里一颗移动的星。他朝着星星，认真地蹦了三下。')
    save(cv, '1-5_一根线_那颗星.jpg')

    # L6 落版：线收成一副眼镜
    cv = paper()
    pts = []
    for cx in (720, 1200):
        for i in range(181):
            t = i / 180 * 2 * math.pi
            c, s = math.cos(t), math.sin(t)
            pts.append((cx + 200 * np.sign(c) * abs(c) ** .55, 420 + 140 * np.sign(s) * abs(s) ** .55))
        if cx == 720:
            pts += [(920, 400), (960, 375), (1000, 400)]
    lead = [(0, 760), (300, 700), (520, 520)]
    path = chaikin(np.array(lead + pts + [(1400, 400), (1600, 330)]), 2)
    cv.alpha_composite(line_layer([path], 3.0))
    d = ImageDraw.Draw(cv)
    for txt, sz, y, w in [('乐奇眼镜', 92, 640, 1), ('看得见世界，更懂你想说的话。', 38, 780, 0)]:
        f = ft(sz, w)
        d.text(((W - d.textlength(txt, font=f)) / 2, y), txt, font=f, fill=INK + (255,))
    pen(cv, (1600, 330))
    save(cv, '1-6_一根线_落版.jpg')


# ================================================================ ② 解码
def depth_guess(n):
    a = np.asarray(load(n).resize((W // 4, H // 4)), np.float32) / 255
    yy = np.linspace(0, 1, H // 4)[:, None] * np.ones((1, W // 4))
    sat = a.max(2) - a.min(2)
    d = .55 * yy + .25 * ndi.gaussian_filter(sat, 6) + .2 * ndi.gaussian_filter(a.mean(2), 10)
    return (d - d.min()) / (d.max() - d.min())


def cloud(n, npts=520000, yaw=.32, front=None, seed=0, keep=None):
    img = load(n)
    a = np.asarray(img, np.float32)
    dep = np.asarray(Image.fromarray((depth_guess(n) * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255
    r = np.random.default_rng(seed)
    xs, ys = r.integers(0, W, npts), r.integers(0, H, npts)
    z = 1.0 + (1 - dep[ys, xs]) * 1.4
    X, Y = (xs - W / 2) / W * z * 1.6, (ys - H / 2) / W * z * 1.6
    cy, sy = math.cos(yaw), math.sin(yaw)
    Xr, Zr = X * cy + (z - 1.6) * sy, -X * sy + (z - 1.6) * cy + 1.6
    f = 1.05
    u = (Xr / Zr * f / 1.6 * W + W / 2).astype(int)
    v = (Y / Zr * f / 1.6 * W + H / 2).astype(int)
    ok = (u >= 0) & (u < W - 1) & (v >= 0) & (v < H - 1)
    if keep is not None:
        ok &= keep(xs, ys)
    col = a[ys, xs]
    buf = np.zeros((H, W, 3), np.float32)
    o = np.argsort(-Zr[ok])
    uu, vv, cc = u[ok][o], v[ok][o], col[ok][o]
    buf[vv, uu] = np.minimum(255, cc * 1.35 + 18)
    buf[vv + 1, uu] = cc * .6
    return Image.fromarray(np.clip(buf, 0, 255).astype(np.uint8))


def decode():
    # D1 听懂之前：球球是一个「未识别」的点云，扫描线扫过的地方凝成原画
    img = load(5)
    cl = cloud(5, seed=2)
    bg = Image.new('RGB', (W, H), (8, 10, 12))
    pc = ImageChops.lighter(bg, cl)
    fx = 700
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).rectangle((0, 0, fx, H), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(6))
    im = Image.composite(img, pc, m).convert('RGBA')
    d = ImageDraw.Draw(im)
    for k in range(18):
        d.line((fx + k, 0, fx + k, H), fill=G + (int(200 * (1 - k / 18)),))
    bx = (840, 110, 1420, 860)
    for (x, y, sx, sy) in [(bx[0], bx[1], 1, 1), (bx[2], bx[1], -1, 1), (bx[0], bx[3], 1, -1), (bx[2], bx[3], -1, -1)]:
        d.line([(x, y + sy * 50), (x, y), (x + sx * 50, y)], fill=G + (230,), width=3)
    d.text((bx[0], bx[1] - 44), '未识别', font=ft(30), fill=G + (255,))
    d.text((bx[0] + 120, bx[1] - 40), '咕噜…咕噜咕噜…', font=ft(24, 0), fill=(200, 255, 220, 170))
    d.text((60, 1000), '戴上眼镜：扫描线扫过的地方，点云凝成画面', font=ft(26, 0), fill=(200, 210, 205, 200))
    save(im, '2-1_解码_未识别.jpg')

    # D2 孤独：只有陈默是实的，人群永远是凝不成形的点
    img = load(2)
    cl = cloud(2, npts=150000, yaw=.12, seed=4, keep=lambda x, y: x > 560)
    bg = Image.new('RGB', (W, H), (8, 10, 12))
    pc = ImageChops.lighter(bg, cl)
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).rectangle((150, 0, 560, H), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(30))
    im = Image.composite(img, pc, m).convert('RGBA')
    d = ImageDraw.Draw(im)
    d.text((452, 206), '借过', font=ft(17, 0), fill=(255, 255, 255, 120))
    d.text((60, 1000), '放学的人群里，没有人喊陈默。', font=ft(30, 0), fill=(230, 230, 225, 230))
    save(im, '2-2_解码_孤独.jpg')


# ================================================================ ③ 字号即勇气
def swiss():
    BG, BLK, SIG = (242, 241, 237), (20, 20, 20), (255, 72, 32)
    cols = [80 + i * 147 for i in range(13)]

    def grid(d):
        for x in cols:
            d.line((x, 0, x, H), fill=(214, 213, 208), width=1)
        for y in range(60, H, 120):
            d.line((0, y, W, y), fill=(214, 213, 208), width=1)

    # S1 开头：字小到缩在角落
    im = Image.new('RGBA', (W, H), BG + (255,))
    d = ImageDraw.Draw(im)
    grid(d)
    im.paste(load(2).resize((882, 496), Image.LANCZOS), (cols[6], 180))
    d.rectangle((cols[0], 180, cols[0] + 16, 676), fill=BLK)
    d.text((cols[0] + 40, 150), '02', font=ft(300, 1), fill=BLK)
    d.text((cols[0] + 44, 470), '借过', font=ft(64, 1), fill=BLK)
    d.text((cols[0] + 44, 560), '放学的人群里，\n没有人喊陈默。', font=ft(30, 0), fill=BLK, spacing=12)
    d.text((cols[6] + 6, 690), '陈默  13 岁  音量 ≈ 12 dB', font=ft(18, 0), fill=(110, 110, 110))
    d.text((cols[9] + 30, 700), '借过', font=ft(11, 1), fill=SIG)
    d.line((cols[9] + 20, 690, cols[9] + 20, 730), fill=SIG, width=2)
    d.rectangle((cols[0], 900, cols[12], 908), fill=BLK)
    d.text((cols[0], 930), '懂你的人 · 2 / 25', font=ft(20, 0), fill=BLK)
    save(im, '3-1_字号即勇气_借过.jpg')

    # S2 高潮：他的字撑破网格
    im = Image.new('RGBA', (W, H), BG + (255,))
    d = ImageDraw.Draw(im)
    grid(d)
    im.paste(load(16).resize((735, 413), Image.LANCZOS), (cols[7], 120))
    d.text((cols[7] + 6, 545), '16  我叫陈默', font=ft(22, 1), fill=BLK)
    for i, l in enumerate(['我刚那句，', '能不能让我', '再说一遍？']):
        d.text((40, 300 + i * 250), l, font=ft(240, 1), fill=SIG)
    d.rectangle((cols[0], 60, cols[0] + 16, 240), fill=BLK)
    d.text((cols[0] + 40, 60), '音量 → 不再需要字幕', font=ft(22, 0), fill=BLK)
    save(im, '3-2_字号即勇气_我叫陈默.jpg')


def sheet():
    fs = sorted(f for f in os.listdir(OUT) if f[0] in '123' and f.endswith('.jpg'))
    tw, th = 480, 270
    rows = {'1': '① 一根线：整片是一根不断的线，线从原画轮廓算出；懂了，原画才在线里绽开',
            '2': '② 解码：眼镜把世界扫成点云，扫描线扫过才凝成画面', '3': '③ 字号即勇气：网格里只有他的字不守规矩'}
    S = Image.new('RGB', (tw * 4 + 50, 3 * (th * 2 + 70) + 20), (20, 20, 22))
    d = ImageDraw.Draw(S)
    y = 10
    for k in '123':
        row = [f for f in fs if f.startswith(k)]
        d.text((14, y + 6), rows[k], font=ft(24), fill=(240, 236, 226))
        y += 46
        for i, f in enumerate(row):
            S.paste(Image.open(OUT + f).resize((tw, th), Image.LANCZOS), (10 + (i % 4) * (tw + 10), y + (i // 4) * (th + 10)))
        y += (th + 10) * ((len(row) + 3) // 4) + 14
    S = S.crop((0, 0, S.width, y))
    S.save(OUT + '00_重构三方向总览.jpg', quality=88)


if __name__ == '__main__':
    import sys
    w = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if w in ('1', 'all'): oneline()
    if w in ('2', 'all'): decode()
    if w in ('3', 'all'): swiss()
    sheet()
