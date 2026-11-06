#!/usr/local/bin/python3
"""「画境追宝」方案样张：画框即入口 / 展签贯穿 / 每幅画说自己的语言 / 乐奇只做真功能。
用法：/usr/local/bin/python3 tools/stills.py  → 样张/01..07.jpg + 00_总览.jpg"""
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '素材/ppt'
OUT = ROOT / '样张'; OUT.mkdir(exist_ok=True)
W, H = 1920, 1080
HEI = '/System/Library/Fonts/Hiragino Sans GB.ttc'
SONG = '/System/Library/Fonts/Supplemental/Songti.ttc'
DIDOT = '/System/Library/Fonts/Supplemental/Didot.ttc'
LENS = (70, 235, 190)          # 乐奇镜片绿：只给真实功能
GOLD = (212, 170, 92)
RED = (235, 70, 60)
rng = np.random.default_rng(7)

def F(path, size, idx=0): return ImageFont.truetype(path, size, index=idx)

def load(n, size=(W, H)):
    im = Image.open(SRC / f'image{n}.png').convert('RGB')
    s = max(size[0] / im.width, size[1] / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - size[0]) // 2, (im.height - size[1]) // 2
    return im.crop((x, y, x + size[0], y + size[1]))

def S(v): return round(v * W / 1360)  # 原图 1360 宽坐标 → 画布

# ---------- 画框：金色线脚 ----------
def gilt_frame(img, box, band=46, inner_shadow=True):
    """在 img 上 box 外围画一圈金框（线脚截面用正弦起伏 + 噪声做旧）。"""
    x0, y0, x1, y1 = box
    a = np.array(img).astype(np.float32)
    yy, xx = np.mgrid[0:img.height, 0:img.width]
    dx = np.maximum(np.maximum(x0 - xx, xx - x1), 0)
    dy = np.maximum(np.maximum(y0 - yy, yy - y1), 0)
    d = np.maximum(dx, dy).astype(np.float32)
    m = (d > 0) & (d <= band)
    t = d / band
    prof = 0.55 + 0.30 * np.sin(t * np.pi * 3.2) + 0.25 * (1 - t) - 0.35 * t ** 4
    # 光从左上来：上/左边亮，下/右边暗
    side = np.where(dy >= dx, np.where(yy < y0, 1.15, 0.72), np.where(xx < x0, 1.05, 0.80))
    noise = ndi.gaussian_filter(rng.standard_normal(d.shape), 1.2) * 0.10
    k = np.clip(prof * side + noise, 0.15, 1.4)[..., None]
    col = np.array(GOLD, np.float32) * k + np.array([30, 18, 0], np.float32) * (k > 1.05)
    a[m] = np.clip(col[m], 0, 255)
    # 外沿深色描边
    edge = (d > band) & (d <= band + 3)
    a[edge] = a[edge] * 0.25
    if inner_shadow:
        inside = (d == 0)
        dist_in = np.minimum(np.minimum(xx - x0, x1 - xx), np.minimum(yy - y0, y1 - yy)).astype(np.float32)
        sh = np.clip(dist_in / 26, 0, 1) * 0.45 + 0.55
        a[inside] = a[inside] * sh[inside][:, None]
    return Image.fromarray(a.astype(np.uint8))

# ---------- 展签：黄铜铭牌 ----------
def placard(img, xy, lines, w=520, pad=26):
    """lines: [(text, font, color)]；黄铜底 + 刻字（暗字 + 下沿高光）。"""
    d0 = ImageDraw.Draw(img)
    hs = [d0.textbbox((0, 0), t, font=f)[3] for t, f, _ in lines]
    h = sum(hs) + pad * 2 + 12 * (len(lines) - 1)
    x, y = xy
    plate = np.zeros((h, w, 3), np.float32)
    g = np.linspace(1.08, 0.78, h)[:, None] * np.ones((1, w))
    brush = ndi.gaussian_filter(rng.standard_normal((h, w)), (0.4, 18)) * 0.06
    k = (g + brush)[..., None]
    plate[:] = np.array([196, 160, 98], np.float32) * k
    pl = Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8))
    dp = ImageDraw.Draw(pl)
    dp.rectangle((4, 4, w - 5, h - 5), outline=(120, 90, 45), width=2)
    for sx, sy in [(14, 14), (w - 15, 14), (14, h - 15), (w - 15, h - 15)]:
        dp.ellipse((sx - 5, sy - 5, sx + 5, sy + 5), fill=(150, 118, 64), outline=(95, 70, 35))
    cy = pad
    for (t, f, c), hh in zip(lines, hs):
        tw = dp.textlength(t, font=f)
        tx = (w - tw) / 2
        dp.text((tx, cy + 1.5), t, font=f, fill=(238, 214, 160))
        dp.text((tx, cy), t, font=f, fill=c)
        cy += hh + 12
    shadow = Image.new('L', (w + 40, h + 40), 0)
    ImageDraw.Draw(shadow).rectangle((20, 26, w + 20, h + 26), fill=170)
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    img.paste((0, 0, 0), (x - 20, y - 20), shadow)
    img.paste(pl, (x, y))
    return h

# ---------- 乐奇镜片面板（翻译 / 识物 / 通话） ----------
def lens_panel(img, xy, title, big, small=None, w=None, anchor=None, big_size=44):
    ov = Image.new('RGBA', img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    ft, fb, fs = F(HEI, 22), F(HEI, big_size, 1), F(DIDOT, 26)
    bw = max(d.textlength(big, font=fb), d.textlength(small or '', font=fs if (small or '').isascii() else F(HEI, 24)), d.textlength(title, font=ft) + 40)
    w = w or int(bw + 60)
    h = 34 + 22 + 16 + big_size + (40 if small else 0) + 26
    x, y = xy
    d.rounded_rectangle((x, y, x + w, y + h), 14, fill=(8, 28, 24, 175), outline=LENS + (230,), width=2)
    d.ellipse((x + 22, y + 24, x + 32, y + 34), fill=LENS + (255,))
    d.text((x + 42, y + 17), title, font=ft, fill=LENS + (255,))
    yy = y + 58
    if small:
        fsm = fs if small.isascii() else F(HEI, 24)
        d.text((x + 30, yy), small, font=fsm, fill=(190, 230, 215, 230)); yy += 40
    d.text((x + 30, yy), big, font=fb, fill=(245, 255, 250, 255))
    if anchor:
        ax, ay = anchor
        px = x + w // 2 if abs(ax - (x + w / 2)) < w / 2 else (x if ax < x else x + w)
        py = y + h if ay > y + h else y
        d.line((px, py, ax, ay), fill=LENS + (200,), width=2)
        d.ellipse((ax - 6, ay - 6, ax + 6, ay + 6), outline=LENS + (255,), width=2)
    glow = ov.filter(ImageFilter.GaussianBlur(6))
    base = img.convert('RGBA')
    base = Image.alpha_composite(base, glow); base = Image.alpha_composite(base, ov)
    return base.convert('RGB')

def subtitle(img, who, text, y=H - 110, color=(255, 255, 255)):
    d = ImageDraw.Draw(img); f = F(HEI, 40, 1); fw = F(HEI, 26)
    t = text; tw = d.textlength(t, font=f)
    x = (W - tw) / 2
    d.text((x, y), t, font=f, fill=color, stroke_width=4, stroke_fill=(0, 0, 0))
    d.text((x, y - 36), who, font=fw, fill=(220, 220, 220), stroke_width=3, stroke_fill=(0, 0, 0))

def letterbox(img, k=0.12):
    d = ImageDraw.Draw(img); b = int(H * k / 2)
    d.rectangle((0, 0, W, b), fill=0); d.rectangle((0, H - b, W, H), fill=0)

def label_corner(img, n, name):
    d = ImageDraw.Draw(img)
    d.text((40, 30), f'样张 {n:02d}', font=F(HEI, 22), fill=(255, 255, 255, 160), stroke_width=2, stroke_fill=(0, 0, 0))
    d.text((40, 58), name, font=F(HEI, 28, 1), fill=(255, 240, 200), stroke_width=3, stroke_fill=(0, 0, 0))

# ---------- Voronoi 工具 ----------
def voronoi(shape, n, seed=1):
    r = np.random.default_rng(seed)
    pts = np.c_[r.uniform(0, shape[1], n), r.uniform(0, shape[0], n)]
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    q = np.c_[xx.ravel(), yy.ravel()]
    dd, ii = cKDTree(pts).query(q, k=2)
    lab = ii[:, 0].reshape(shape); gap = (dd[:, 1] - dd[:, 0]).reshape(shape)
    return pts, lab, gap

# ============ 样张 ============
def s01_title():
    bg = load(2)
    a = np.array(bg).astype(np.float32) * 0.9
    img = Image.fromarray(a.astype(np.uint8))
    canvas = Image.new('RGB', (W, H), (14, 11, 9))
    # 深色墙布纹
    wall = ndi.gaussian_filter(rng.standard_normal((H, W)), (1, 40)) * 6 + 22
    canvas = Image.fromarray(np.clip(np.dstack([wall, wall * 0.85, wall * 0.7]), 0, 255).astype(np.uint8))
    bx = (260, 120, 1660, 860)
    canvas.paste(img.resize((bx[2] - bx[0], bx[3] - bx[1])), bx[:2])
    canvas = gilt_frame(canvas, bx, band=52)
    # 顶光
    yy, xx = np.mgrid[0:H, 0:W]
    spot = np.exp(-(((xx - 960) / 900) ** 2 + ((yy - 300) / 700) ** 2))[..., None]
    c = np.array(canvas).astype(np.float32) * (0.55 + 0.6 * spot)
    canvas = Image.fromarray(np.clip(c, 0, 255).astype(np.uint8))
    placard(canvas, (700, 900), [('画 境 追 宝', F(SONG, 46, 1), (70, 45, 15)),
                                ('一副眼镜，追回一只羊首  ·  展品 No.00', F(HEI, 20), (85, 60, 25))], w=520)
    label_corner(canvas, 1, '片头：整部片是一座画廊，每一场都是一件展品')
    return canvas

def s02_appraise():
    img = load(4)
    # 识物：历史照片与眼前羊首交替叠合（真实功能：识物 + 第一视角记录）
    hx0, hy0, hx1, hy1 = S(250), S(0), S(730), S(560)
    crop = img.crop((hx0, hy0, hx1, hy1))
    g = np.array(crop.convert('L')).astype(np.float32)
    e = np.hypot(ndi.sobel(g, 0), ndi.sobel(g, 1)); e = e / np.percentile(e, 99.5)
    edge = np.clip(ndi.gaussian_filter(e, 1.0) - 0.35, 0, 1)
    sep = np.dstack([g * 0.95 + 25, g * 0.80 + 15, g * 0.58])  # 棕褐旧照
    a = np.array(img).astype(np.float32)
    reg = a[hy0:hy1, hx0:hx1]
    # 旧照错位 14px 叠一层“残影”，表示正在对齐
    ghost = np.roll(np.roll(sep, 14, 1), -8, 0)
    reg[:] = reg * 0.5 + ghost * 0.5
    reg[:] = reg * (1 - edge[..., None] * 0.8) + np.array(LENS) * edge[..., None] * 0.8
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    L = 40
    for (cx, cy, sx, sy) in [(hx0, hy0 + 30, 1, 1), (hx1, hy0 + 30, -1, 1), (hx0, hy1, 1, -1), (hx1, hy1, -1, -1)]:
        d.line((cx, cy, cx + sx * L, cy), fill=LENS, width=4); d.line((cx, cy, cx, cy + sy * L), fill=LENS, width=4)
    d.text((hx0 + 8, hy1 - 40), '档案影像 1860 · 叠合中', font=F(HEI, 22), fill=LENS, stroke_width=3, stroke_fill=(0, 0, 0))
    img = lens_panel(img, (S(770), S(70)), 'AI 识物 · 历史影像比对', '外观特征 高度吻合', small='铸造纹理：待人工核验', anchor=(hx1, S(200)))
    letterbox(img)
    subtitle(img, '乐奇', '历史影像比对高度吻合，建议继续核验铸造特征。')
    label_corner(img, 2, '鉴定：乐奇只给相似度，最后一步由林砚自己判断')
    return img

def s03_enter():
    """现实画廊 → 文艺复兴墙绘：裂纹从手触处蔓延，一片片灰泥翻落成画。"""
    real = load(3); fresco = load(6)
    shp = (H, W)
    pts, lab, gap = voronoi(shp, 900, seed=3)
    touch = np.array([1180, 560])
    dist = np.hypot(pts[:, 0] - touch[0], pts[:, 1] - touch[1])
    R = 600
    jitter = rng.uniform(-120, 120, len(pts))
    flipped = (dist + jitter) < R                    # 已翻成画的碎片
    front = (np.abs(dist + jitter - R) < 110) & (rng.uniform(0, 1, len(pts)) < 0.45)          # 正在剥落的一圈
    fm = flipped[lab]; frm = front[lab] & ~fm
    ra, fa = np.array(real).astype(np.float32), np.array(fresco).astype(np.float32)
    # 现实部分冷色，画里暖色
    ra = ra * np.array([0.78, 0.88, 1.08])
    out = np.where(fm[..., None], fa, ra)
    # 剥落圈：灰泥色 + 轻微位移
    plaster = np.array([214, 198, 170], np.float32)
    shade = (0.75 + 0.25 * ((lab * 37) % 11) / 10)[..., None]
    out = np.where(frm[..., None], plaster * shade * 0.9 + out * 0.1, out)
    near0 = np.abs(np.hypot(*(np.mgrid[0:H, 0:W][::-1] - touch[:, None, None])) - R) < 170
    crack = (gap < 2.0) & (fm | frm) & near0
    out[crack] = out[crack] * 0.25
    # 裂纹细节：画面区域整体加龟裂
    _, lab2, gap2 = voronoi(shp, 5000, seed=9)
    near = np.abs(np.hypot(*(np.mgrid[0:H, 0:W][::-1] - touch[:, None, None])) - R) < 220
    fine = (gap2 < 1.1) & fm & near
    out[fine] = out[fine] * 0.72
    img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    # 飘落的灰泥片
    d = ImageDraw.Draw(img)
    for _ in range(35):
        ang = rng.uniform(0, 2 * np.pi); rr = R + rng.uniform(-20, 160)
        x, y = touch[0] + np.cos(ang) * rr * 0.9, touch[1] + np.sin(ang) * rr * 0.6 + rng.uniform(0, 80)
        s = rng.uniform(5, 16)
        poly = [(x + s * np.cos(t + ang), y + s * 0.6 * np.sin(t + ang)) for t in np.linspace(0, 2 * np.pi, 5)[:-1]]
        d.polygon(poly, fill=(220, 205, 178), outline=(120, 105, 85))
    letterbox(img)
    subtitle(img, '林砚', '你也看见了？')
    label_corner(img, 3, '入画①：现实是冷色，画是暖色——碎片按距离一片片翻成墙绘')
    return img

def s04_count():
    img = load(6)
    heads = [(42, 192), (38, 268), (112, 238), (180, 236), (262, 246), (222, 292), (408, 262),
             (500, 288), (585, 262), (652, 300), (708, 226), (748, 298)]
    d = ImageDraw.Draw(img); f = F(HEI, 26, 1)
    for i, (x, y) in enumerate(heads, 1):
        X, Y = S(x), S(y) - 70
        d.ellipse((X - 19, Y - 19, X + 19, Y + 19), outline=LENS, width=3, fill=(8, 28, 24))
        t = str(i); d.text((X - d.textlength(t, font=f) / 2, Y - 15), t, font=f, fill=(240, 255, 250))
    d.text((S(4), S(120)), '13 ←画外', font=F(HEI, 22), fill=LENS, stroke_width=3, stroke_fill=(0, 0, 0))
    for n, (x, y) in [(14, (985, 150)), (15, (1318, 262))]:
        X, Y = S(x), S(y) - 60
        d.ellipse((X - 24, Y - 24, X + 24, Y + 24), outline=RED, width=4, fill=(40, 8, 6))
        t = str(n); d.text((X - d.textlength(t, font=f) / 2, Y - 15), t, font=f, fill=(255, 230, 225))
    img = lens_panel(img, (S(820), S(440)), '原作构图比对', '本应 13 位 · 现在 15 位', anchor=(S(985), S(150) - 36), big_size=40)
    letterbox(img)
    subtitle(img, '林砚', '多的就是我和那个抢包的，别给我数人头了！')
    label_corner(img, 4, '画境一·最后的晚餐：乐奇真的在数人头')
    return img

def s05_knight():
    img = load(7)
    # 油画龟裂 + 光油高光，提示“这是一块 1430 年的木板油画”
    a = np.array(img).astype(np.float32)
    _, lab, gap = voronoi((H, W), 7000, seed=5)
    a[gap < 1.0] *= 0.78
    yy, xx = np.mgrid[0:H, 0:W]
    sheen = np.exp(-(((xx - 1400) / 500) ** 2 + ((yy - 250) / 260) ** 2))[..., None] * 38
    a = a + sheen
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    img = lens_panel(img, (S(30), S(250)), '实时翻译 · 中古荷兰语', '站住！你是何人，外乡人？',
                     small='Halt! Wie zijt gij, vreemdeling?', anchor=(S(110), S(270)), big_size=38)
    img = lens_panel(img, (S(640), S(120)), '乐奇', '他在问您的身份。', anchor=(S(780), S(360)), big_size=34)
    letterbox(img)
    subtitle(img, '林砚', '告诉他，我走错展厅了！')
    label_corner(img, 5, '画境二·公正的法官：每幅画说它自己年代的语言')
    return img

def s06_cubist():
    base = load(8)
    a = np.array(base).astype(np.float32)
    shp = (H, W)
    pts, lab, gap = voronoi(shp, 140, seed=11)
    yy, xx = np.mgrid[0:H, 0:W]
    out = np.empty_like(a)
    r = np.random.default_rng(4)
    for i in range(len(pts)):
        m = lab == i
        if not m.any(): continue
        ang = r.uniform(-0.35, 0.35); sc = r.uniform(0.9, 1.15)
        ox, oy = r.uniform(-60, 60), r.uniform(-60, 60)
        cx, cy = pts[i]
        X, Y = xx[m] - cx, yy[m] - cy
        sx = (np.cos(ang) * X - np.sin(ang) * Y) / sc + cx + ox
        sy = (np.sin(ang) * X + np.cos(ang) * Y) / sc + cy + oy
        sx = np.clip(sx, 0, W - 1).astype(int); sy = np.clip(sy, 0, H - 1).astype(int)
        tone = r.choice([0.82, 0.95, 1.05, 1.15])
        out[m] = a[sy, sx] * tone
    out[gap < 1.6] *= 0.35
    img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    # 三个“左”：按三块平面各自的透视画箭头；只有绿色那支是乐奇的
    d = ImageDraw.Draw(img); fz = F(HEI, 30, 1)
    def arrow(x, y, ang, col, lab_t, w=10, L=150):
        ca, sa = np.cos(ang), np.sin(ang)
        x2, y2 = x + ca * L, y + sa * L
        d.line((x, y, x2, y2), fill=col, width=w)
        hx, hy = -sa, ca
        d.polygon([(x2 + ca * 30, y2 + sa * 30), (x2 + hx * 22, y2 + hy * 22), (x2 - hx * 22, y2 - hy * 22)], fill=col)
        d.text((x - 10, y - 50), lab_t, font=fz, fill=col, stroke_width=3, stroke_fill=(0, 0, 0))
    arrow(560, 520, np.pi, (230, 220, 200), '左？')
    arrow(1150, 260, -np.pi / 2 - 0.5, (230, 220, 200), '左？')
    arrow(1560, 640, np.pi * 0.25, (230, 220, 200), '左？')
    img = lens_panel(img, (1080, 760), '导航 · 按标记，不按透视', '向这里', anchor=(960, 900), big_size=34)
    ov = Image.new('RGBA', img.size, (0, 0, 0, 0)); do = ImageDraw.Draw(ov)
    pts_path = [(700, 980), (820, 920), (960, 900)]
    do.line(pts_path, fill=LENS + (255,), width=10, joint='curve')
    do.polygon([(985, 893), (950, 875), (952, 925)], fill=LENS + (255,))
    img = Image.alpha_composite(img.convert('RGBA'), ov.filter(ImageFilter.GaussianBlur(5)))
    img = Image.alpha_composite(img, ov).convert('RGB')
    letterbox(img)
    subtitle(img, '林砚', '这儿有三个左边！')
    label_corner(img, 6, '画境三·鸽子与豌豆：代码把画面切成碎面，地板变墙')
    return img

def s07_home():
    """尾卡：同一块展签，状态从“私藏”改成“已归还”。"""
    src = load(4)
    head = src.crop((S(230), 0, S(700), S(560))).resize((560, 668), Image.LANCZOS)
    a = np.array(head).astype(np.float32)
    yy, xx = np.mgrid[0:668, 0:560]
    v = np.exp(-(((xx - 300) / 330) ** 2 + ((yy - 280) / 420) ** 2))[..., None]
    a = a * (0.25 + 0.95 * v) * np.array([1.08, 1.0, 0.88])
    head = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    canvas = Image.new('RGB', (W, H), (18, 16, 14))
    wall = ndi.gaussian_filter(rng.standard_normal((H, W)), 30) * 40 + 0
    cv = np.array(canvas).astype(np.float32) + wall[..., None] * 0.2
    yy, xx = np.mgrid[0:H, 0:W]
    cv = cv + np.exp(-(((xx - 760) / 600) ** 2 + ((yy - 380) / 500) ** 2))[..., None] * np.array([60, 48, 34])
    canvas = Image.fromarray(np.clip(cv, 0, 255).astype(np.uint8))
    canvas.paste(head, (480, 150))
    d = ImageDraw.Draw(canvas)
    d.rectangle((470, 140, 1050, 828), outline=(200, 220, 230), width=2)  # 玻璃展柜边
    placard(canvas, (1180, 380), [('铜 羊 首', F(SONG, 44, 1), (70, 45, 15)),
                                  ('圆明园十二生肖兽首', F(HEI, 22), (85, 60, 25)),
                                  ('状态：已归还', F(HEI, 28, 1), (130, 30, 20)),
                                  ('原登记：私人收藏 · 黑荆棘庄园', F(HEI, 18), (110, 85, 50))], w=520)
    d.text((1180, 640), '看见更多，才有更多可能。', font=F(SONG, 40, 1), fill=(235, 225, 205))
    d.text((1180, 700), '乐奇 AI 眼镜', font=F(HEI, 28), fill=LENS)
    subtitle(canvas, '林砚', '不用。它回家了。', y=H - 120)
    label_corner(canvas, 7, '结尾：开头那块展签，状态被改写')
    return canvas

if __name__ == '__main__':
    fns = [s01_title, s02_appraise, s03_enter, s04_count, s05_knight, s06_cubist, s07_home]
    ims = []
    for i, fn in enumerate(fns, 1):
        im = fn(); im.save(OUT / f'{i:02d}.jpg', quality=90); ims.append(im); print('ok', i)
    tw, th = 640, 360
    sheet = Image.new('RGB', (tw * 3, th * 3), (10, 10, 10))
    for k, im in enumerate(ims):
        sheet.paste(im.resize((tw, th), Image.LANCZOS), ((k % 3) * tw, (k // 3) * th))
    ds = ImageDraw.Draw(sheet)
    ds.text((tw * 1 + 30, th * 2 + 120), '画境追宝 · 方案样张', font=F(SONG, 44, 1), fill=GOLD)
    ds.text((tw * 1 + 30, th * 2 + 190), '画框即入口 / 展签贯穿 / 每幅画说自己的语言', font=F(HEI, 24), fill=(220, 220, 220))
    sheet.save(OUT / '00_总览.jpg', quality=88)
