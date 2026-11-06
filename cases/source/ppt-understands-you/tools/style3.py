"""懂你的人：三套代码动画风格示意静帧（同 3 个关键画面：借过 / 听懂了 / 我叫陈默）
A 镜片视界  B 陈默的速写本  C 纸片立体书
用法：python style3.py   输出到 ~/Desktop/懂你的人/风格样张/三选一/"""
import math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageChops

M = '/private/tmp/claude-503/-Users-cuiqq/4c0d8b66-8617-4dcd-880b-44cb181f55c4/scratchpad/dnr/m/'
OUT = os.path.expanduser('~/Desktop/懂你的人/风格样张/三选一/')
FD = os.path.expanduser('~/Desktop/懂你的人/tools/fonts/')
os.makedirs(OUT, exist_ok=True)
W, H = 1920, 1080
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
G = (120, 255, 170)
INK = (38, 44, 96)        # 速写本：靛蓝蜡笔
BROWN = (74, 46, 30)      # 立体书：深棕描边
rng = np.random.default_rng(7)


def ft(size, name='hira', i=1):
    p = {'hira': HIRA, 'pen': FD + 'Hanzipen.ttc', 'yuan': FD + 'Yuanti.ttc', 'wawa': FD + 'WawaSC-Regular.otf'}[name]
    return ImageFont.truetype(p, size, index=i)


def load(n):
    return Image.open(M + f'i{n:02d}.png').convert('RGBA').resize((W, H), Image.LANCZOS)


def save(im, name):
    im.convert('RGB').save(OUT + name, quality=90)


def vnoise(h, w, cell, seed):
    r = np.random.default_rng(seed).random((h // cell + 3, w // cell + 3)).astype(np.float32)
    im = Image.fromarray((r * 255).astype(np.uint8)).resize(((w // cell + 3) * cell, (h // cell + 3) * cell), Image.BICUBIC)
    return np.asarray(im, np.float32)[:h, :w] / 255


TOOTH = (0.5 * vnoise(H, W, 2, 1) + 0.3 * vnoise(H, W, 5, 2) + 0.2 * vnoise(H, W, 13, 3))
TOOTH = (TOOTH - TOOTH.min()) / (TOOTH.max() - TOOTH.min())


def wax(pmask, color, k=1.0):
    """蜡笔附着：压力 P 只能填到纸纹高处"""
    P = np.asarray(pmask, np.float32) / 255 * k
    cov = np.clip((TOOTH - (1 - P) * 0.95) / 0.12, 0, 1) * (P > 0.04)
    a = Image.fromarray((cov * 255).astype(np.uint8))
    lay = Image.new('RGBA', (W, H), color + (255,))
    lay.putalpha(a)
    return lay


def jitter(pts, amp=2.0, seed=0):
    r = np.random.default_rng(seed)
    out = []
    n = len(pts)
    ph = r.random(3) * 6.28
    for i, (x, y) in enumerate(pts):
        t = i / max(1, n - 1)
        out.append((x + amp * math.sin(t * 9 + ph[0]) + r.normal(0, amp * .25),
                    y + amp * math.sin(t * 7 + ph[1]) + r.normal(0, amp * .25)))
    return out


def crayon_lines(paths, width, color, k=0.9, seed=0):
    pm = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(pm)
    for j, p in enumerate(paths):
        for s, (wf, v) in enumerate([(1.0, 200), (0.55, 255), (0.3, 150)]):
            q = jitter(p, 1.6, seed * 31 + j * 7 + s)
            d.line(q, fill=v, width=max(1, int(width * wf)), joint='curve')
    return wax(pm.filter(ImageFilter.GaussianBlur(0.8)), color, k)


def crayon_text(xy, text, font, color, k=0.95, angle=0, spacing=8):
    pm = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(pm)
    x, y = xy
    r = np.random.default_rng(len(text))
    for ch in text:
        g = Image.new('L', (font.size * 2, font.size * 2), 0)
        ImageDraw.Draw(g).text((font.size // 2, font.size // 3), ch, font=font, fill=255)
        g = g.rotate(r.normal(angle, 3), resample=Image.BICUBIC)
        pm.paste(ImageChops.lighter(pm.crop((int(x) - font.size // 2, int(y + r.normal(0, 2)) - font.size // 3,
                                             int(x) + font.size * 3 // 2, int(y) + font.size * 5 // 3)), g),
                 (int(x) - font.size // 2, int(y) - font.size // 3))
        x += d.textlength(ch, font=font) + r.normal(0, 1.5)
    pm = pm.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    return wax(pm, color, k)


def wobble_ellipse(cx, cy, rx, ry, seed, loops=1.15, n=120):
    r = np.random.default_rng(seed)
    ph = r.random(2) * 6.28
    pts = []
    for i in range(int(n * loops)):
        t = i / n * 2 * math.pi - 0.6
        rr = 1 + 0.035 * math.sin(3 * t + ph[0]) + 0.02 * math.sin(5 * t + ph[1]) + 0.04 * (i / n)
        pts.append((cx + rx * rr * math.cos(t), cy + ry * rr * math.sin(t)))
    return pts


def outlined(d, xy, text, font, fill, stroke, sw):
    d.text(xy, text, font=font, fill=fill, stroke_width=sw, stroke_fill=stroke)


# ------------------------------------------------------------------ A 镜片视界
def lens_mask():
    """略带梯形的大圆角镜片"""
    m = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(m)
    pts = []
    for i in range(400):
        t = i / 400 * 2 * math.pi
        c, s = math.cos(t), math.sin(t)
        x = 900 * np.sign(c) * abs(c) ** (2 / 5.0)
        y = 500 * np.sign(s) * abs(s) ** (2 / 4.0)
        x *= 1 - 0.05 * (y / 500)          # 下沿略收
        pts.append((960 + x, 532 + y))
    d.polygon(pts, fill=255)
    return m, pts


def style_A():
    m, pts = lens_mask()
    mb = m.filter(ImageFilter.GaussianBlur(3))

    def lens_view(im):
        peri = ImageEnhance.Brightness(im.filter(ImageFilter.GaussianBlur(26))).enhance(0.32)
        v = Image.composite(im, peri, mb)
        rim = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        rd = ImageDraw.Draw(rim)
        rd.line(pts + [pts[0]], fill=(14, 14, 16, 255), width=46)
        rim = rim.filter(ImageFilter.GaussianBlur(10))          # 镜框贴近眼睛，虚
        v = Image.alpha_composite(v, rim)
        hl = Image.new('RGBA', (W, H), (0, 0, 0, 0))            # 镜片反光一道
        ImageDraw.Draw(hl).polygon([(1380, 70), (1520, 70), (1180, 1010), (1060, 1010)], fill=(255, 255, 255, 14))
        hl = hl.filter(ImageFilter.GaussianBlur(30))
        hl.putalpha(ImageChops.multiply(hl.getchannel('A'), m))
        return Image.alpha_composite(v, hl)

    def brackets(d, x0, y0, x1, y1, L=46, c=G + (230,), w=4):
        for (x, y, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
            d.line([(x, y + sy * L), (x, y), (x + sx * L, y)], fill=c, width=w)

    # A1 借过：还没有眼镜——画面就是普通画面，他的话小到几乎看不见
    im = load(2)
    d = ImageDraw.Draw(im)
    d.text((452, 206), '借过', font=ft(19, i=0), fill=(255, 255, 255, 120))
    sub = '放学的人群里，没有人喊陈默。'
    f = ft(34)
    w = d.textlength(sub, font=f)
    outlined(d, ((W - w) / 2, 980), sub, f, (255, 250, 240), (0, 0, 0, 160), 2)
    d.text((60, 40), '02  借过', font=ft(26, i=0), fill=(255, 255, 255, 150))
    save(im, 'A1_镜片视界_借过.jpg')

    # A2 听懂了：从这一刻起画面变成镜片视野，HUD 才出现
    im = lens_view(load(5))
    d = ImageDraw.Draw(im)
    brackets(d, 860, 120, 1380, 640)
    d.text((872, 92), '◉ 识别中  外星语？', font=ft(24, i=0), fill=G + (220,))
    x0, y0, x1, y1 = 390, 890, 1544, 1034
    d.text((x0 + 40, y0 + 16), '咕噜…咕噜咕噜…', font=ft(26, i=0), fill=(200, 255, 220, 130))
    d.line((x0 + 40, y0 + 33, x0 + 250, y0 + 33), fill=(200, 255, 220, 140), width=2)
    d.text((x0 + 40, y0 + 58), '别、别打我……我只是，迷路了。', font=ft(44), fill=G + (255,))
    d.text((x1 - 110, y0 + 16), '翻译', font=ft(24, i=0), fill=G + (210,))
    for i in range(46):                                   # 声纹
        hgt = 6 + 26 * abs(math.sin(i * 0.7)) * (0.5 + 0.5 * math.sin(i * 0.23))
        d.line((x0 + 300 + i * 9, y0 + 30 - hgt / 2, x0 + 300 + i * 9, y0 + 30 + hgt / 2), fill=G + (120,), width=3)
    save(im, 'A2_镜片视界_听懂了.jpg')

    # A3 我叫陈默：他没戴眼镜——字幕走出镜片，变成他自己的大字
    im = load(16)
    im = Image.alpha_composite(im, Image.new('RGBA', (W, H), (0, 0, 0, 46)))
    d = ImageDraw.Draw(im)
    for i, l in enumerate(['我刚那句，', '能不能让我', '再说一遍？']):
        outlined(d, (90, 80 + i * 124), l, ft(100), (255, 248, 232), (0, 0, 0, 110), 3)
    d.text((96, 470), '— 没有字幕，是他自己说的', font=ft(28, i=0), fill=G + (200,))
    save(im, 'A3_镜片视界_我叫陈默.jpg')


# ------------------------------------------------------------------ B 陈默的速写本
def paper_page():
    base = np.array([244, 239, 227], np.float32)
    fib = vnoise(H, W, 3, 9)[:, :]
    fib = np.repeat(fib.mean(axis=1, keepdims=True), W, axis=1) * 0.5 + fib * 0.5
    a = base * (0.95 + 0.05 * TOOTH[..., None]) * (0.985 + 0.015 * fib[..., None])
    yy, xx = np.mgrid[0:H, 0:W]
    vig = 1 - 0.10 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    a = a * vig[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert('RGBA')


PH_S, PH_X, PH_Y, PH_A = 0.74, 92, 46, -1.3     # 照片缩放 / 位置 / 旋转


def photo_pt(x, y):
    """原图 1920 坐标 → 本子页上的位置（含旋转）"""
    w, h = W * PH_S + 28, H * PH_S + 28
    px, py = 14 + x * PH_S - w / 2, 14 + y * PH_S - h / 2
    a = math.radians(-PH_A)
    rx, ry = px * math.cos(a) - py * math.sin(a), px * math.sin(a) + py * math.cos(a)
    return PH_X + 40 + w / 2 + rx, PH_Y + 40 + h / 2 + ry


def paste_photo(page, im):
    pw, ph = int(W * PH_S), int(H * PH_S)
    card = Image.new('RGBA', (pw + 28, ph + 28), (252, 250, 244, 255))
    card.alpha_composite(im.resize((pw, ph), Image.LANCZOS), (14, 14))
    pad = Image.new('RGBA', (card.width + 80, card.height + 80), (0, 0, 0, 0))
    pad.alpha_composite(card, (40, 40))
    pad = pad.rotate(PH_A, resample=Image.BICUBIC)
    sh = Image.new('RGBA', pad.size, (40, 30, 20, 0))
    sh.putalpha(pad.getchannel('A').point(lambda v: v * 0.35).filter(ImageFilter.GaussianBlur(14)))
    page.alpha_composite(sh, (PH_X + 8, PH_Y + 14))
    page.alpha_composite(pad, (PH_X, PH_Y))
    for (cx, cy, ang) in [(PH_X + 70, PH_Y + 50, 38), (PH_X + pad.width - 80, PH_Y + 40, -34)]:   # 胶带
        t = Image.new('RGBA', (190, 52), (236, 226, 192, 175))
        t = t.rotate(ang, expand=True, resample=Image.BICUBIC)
        page.alpha_composite(t, (int(cx - t.width / 2), int(cy - t.height / 2)))
    return page


def doodle_glasses(cx, cy, s, seed):
    L = []
    for dx in (-1, 1):
        x0 = cx + dx * 0.62 * s
        pts = []
        for i in range(70):
            t = i / 60 * 2 * math.pi
            c, sn = math.cos(t), math.sin(t)
            pts.append((x0 + 0.5 * s * np.sign(c) * abs(c) ** 0.6, cy + 0.36 * s * np.sign(sn) * abs(sn) ** 0.6))
        L.append(pts)
    L.append([(cx - 0.14 * s, cy - 0.08 * s), (cx, cy - 0.16 * s), (cx + 0.14 * s, cy - 0.08 * s)])
    L.append([(cx - 1.12 * s, cy - 0.15 * s), (cx - 1.5 * s, cy - 0.3 * s)])
    L.append([(cx + 1.12 * s, cy - 0.15 * s), (cx + 1.5 * s, cy - 0.3 * s)])
    return crayon_lines(L, 9, (30, 30, 40), seed=seed)


def rays(cx, cy, r0, r1, n, seed, a0=0, a1=2 * math.pi):
    out = []
    for i in range(n):
        a = a0 + (a1 - a0) * (i + 0.5) / n
        out.append([(cx + r0 * math.cos(a), cy + r0 * math.sin(a)), (cx + r1 * math.cos(a), cy + r1 * math.sin(a))])
    return out


def style_B():
    pen = ft(52, 'pen', 2)
    # B1 借过
    pg = paste_photo(paper_page(), load(2))
    bx, by = photo_pt(452, 212)
    pg.alpha_composite(crayon_text((bx + 4, by - 4), '借过…', ft(24, 'pen', 0), (252, 248, 238), k=0.9))
    pg.alpha_composite(crayon_lines([wobble_ellipse(bx + 46, by + 12, 62, 30, 3)], 4, (236, 110, 60), 0.85, seed=3))
    nx, ny = photo_pt(930, 34)
    pg.alpha_composite(crayon_text((nx, ny), '他的声音，只有这么小', ft(34, 'pen', 0), INK, 0.9))
    pg.alpha_composite(crayon_lines([[(nx + 20, ny + 52), (bx + 120, by - 10)], [(bx + 120, by - 10), (bx + 134, by - 30)],
                                     [(bx + 120, by - 10), (bx + 142, by - 4)]], 5, (236, 110, 60), 0.85, seed=4))
    pg.alpha_composite(crayon_text((150, 960), '放学的人群里，没有人喊陈默。', pen, INK))
    save(pg, 'B1_速写本_借过.jpg')

    # B2 听懂了
    im = load(5)
    d = ImageDraw.Draw(im)
    x0, y0 = 390, 890
    d.text((x0 + 40, y0 + 16), '咕噜…咕噜咕噜…', font=ft(26, i=0), fill=(200, 255, 220, 130))
    d.line((x0 + 40, y0 + 33, x0 + 250, y0 + 33), fill=(200, 255, 220, 140), width=2)
    d.text((x0 + 40, y0 + 58), '别、别打我……我只是，迷路了。', font=ft(44), fill=G + (255,))
    pg = paste_photo(paper_page(), im)
    pg.alpha_composite(doodle_glasses(1745, 250, 70, 5))
    pg.alpha_composite(crayon_lines(rays(1745, 250, 140, 175, 9, 6, -2.6, -0.5), 5, (240, 170, 40), 0.8, seed=6))
    qx, qy = photo_pt(1130, 250)
    pg.alpha_composite(crayon_lines([wobble_ellipse(qx - 250, qy - 200, 150, 62, 8)], 6, INK, 0.8, seed=8))
    pg.alpha_composite(crayon_text((qx - 360, qy - 226), '咕噜咕噜？', ft(40, 'pen', 0), INK, 0.85))
    pg.alpha_composite(crayon_lines([[(qx - 150, qy - 150), (qx - 70, qy - 70)]], 5, INK, 0.8, seed=9))
    pg.alpha_composite(crayon_text((1640, 400), '原来它', ft(36, 'pen', 0), INK, 0.85))
    pg.alpha_composite(crayon_text((1640, 452), '只是迷路了', ft(36, 'pen', 0), INK, 0.85))
    pg.alpha_composite(crayon_text((150, 960), '眼镜把急促的“咕噜”声译成了人话。', pen, INK))
    save(pg, 'B2_速写本_听懂了.jpg')

    # B3 我叫陈默：字终于写得很大，冲出照片
    pg = paste_photo(paper_page(), load(16))
    big = ft(118, 'pen', 2)
    for i, l in enumerate(['我刚那句，', '能不能让我', '再说一遍？']):
        pg.alpha_composite(crayon_text((70 + i * 30, 70 + i * 150), l, big, (236, 96, 48), 1.0, angle=-4))
    pg.alpha_composite(crayon_lines(rays(1150, 330, 90, 150, 7, 12, -3.0, -1.6), 7, (240, 170, 40), 0.85, seed=12))
    cx, cy = 1760, 760                                       # 页边小猫（呼应他手里的画）
    cat = [wobble_ellipse(cx, cy, 72, 60, 21, 1.05),
           [(cx - 60, cy - 30), (cx - 52, cy - 96), (cx - 18, cy - 56)],
           [(cx + 18, cy - 56), (cx + 52, cy - 96), (cx + 60, cy - 30)],
           [(cx - 30, cy + 2), (cx - 22, cy - 6)], [(cx + 22, cy - 6), (cx + 30, cy + 2)],
           [(cx - 8, cy + 18), (cx, cy + 26), (cx + 8, cy + 18)]]
    pg.alpha_composite(crayon_lines(cat, 6, (200, 110, 40), 0.85, seed=22))
    pg.alpha_composite(crayon_text((150, 960), '他把那句话，又说了一遍。', pen, INK))
    save(pg, 'B3_速写本_我叫陈默.jpg')


# ------------------------------------------------------------------ C 纸片立体书
BX, BY, BS = 230, 30, 0.76            # 立起来的背景板（印着原画）


def board_pt(x, y):
    return BX + x * BS, BY + y * BS


def table_bg():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.random.default_rng(31).random((H // 24 + 3, W // 320 + 3)).astype(np.float32)
    n = np.asarray(Image.fromarray((r * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255
    grain = (np.sin(yy / 5.5 + 9 * n) * 0.5 + 0.5) ** 2 * 0.6 + 0.4 * vnoise(H, W, 3, 32)
    base = np.array([116, 76, 46], np.float32)
    a = base * (0.82 + 0.22 * grain[..., None])
    light = np.exp(-(((xx - 600) / 1100) ** 2 + ((yy - 200) / 800) ** 2))
    a = a * (0.55 + 0.6 * light[..., None])
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert('RGBA')
    return im.filter(ImageFilter.GaussianBlur(5))


def make_card(art, border=9, thick=6):
    A = art.getchannel('A')
    dil = A.filter(ImageFilter.MaxFilter(2 * border + 1 if border < 12 else 25))
    out = Image.new('RGBA', (art.width, art.height + thick), (0, 0, 0, 0))
    edge = Image.new('RGBA', art.size, (150, 138, 120, 255))
    edge.putalpha(dil)
    out.alpha_composite(edge, (0, thick))
    wht = Image.new('RGBA', art.size, (250, 246, 236, 255))
    wht.putalpha(dil)
    out.alpha_composite(wht, (0, 0))
    out.alpha_composite(art, (0, 0))
    return out


def drop(canvas, card, xy, off=(10, 16), blur=10, a=0.42):
    sh = Image.new('RGBA', card.size, (25, 15, 8, 0))
    sh.putalpha(card.getchannel('A').point(lambda v: v * a).filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(sh, (int(xy[0] + off[0]), int(xy[1] + off[1])))
    canvas.alpha_composite(card, (int(xy[0]), int(xy[1])))


def bubble_card(lines, font, tail, pad=34, fill=(255, 255, 255), base=0.3):
    d0 = ImageDraw.Draw(Image.new('L', (1, 1)))
    tw = max(d0.textlength(l, font=font) for l in lines)
    lh = font.size * 1.28
    w, h = int(tw + pad * 2), int(lh * len(lines) + pad * 1.6)
    S = 2 * max(w, h)
    art = Image.new('RGBA', (w + 200, h + 140), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    ox, oy = 40, 30
    tx, ty = tail
    d.polygon([(ox + w * base, oy + h - 10), (ox + w * base + 70, oy + h - 10), (ox + tx, oy + h + ty)], fill=fill + (255,), outline=BROWN + (255,))
    d.rounded_rectangle((ox, oy, ox + w, oy + h), radius=min(h // 2, 60), fill=fill + (255,), outline=BROWN + (255,), width=6)
    d.polygon([(ox + w * base + 4, oy + h - 14), (ox + w * base + 66, oy + h - 14), (ox + tx, oy + h + ty - 10)], fill=fill + (255,))
    d.line([(ox + w * base, oy + h - 4), (ox + tx, oy + h + ty)], fill=BROWN + (255,), width=6)
    d.line([(ox + w * base + 70, oy + h - 4), (ox + tx, oy + h + ty)], fill=BROWN + (255,), width=6)
    for i, l in enumerate(lines):
        d.text((ox + pad, oy + pad * 0.7 + i * lh), l, font=font, fill=BROWN + (255,))
    return art


def sign_card(text, sub=None):
    f = ft(54, 'yuan', 2)
    d0 = ImageDraw.Draw(Image.new('L', (1, 1)))
    w = int(d0.textlength(text, font=f)) + 70
    h = 96 if not sub else 140
    art = Image.new('RGBA', (w + 20, h + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    d.rounded_rectangle((6, 6, w + 6, h + 6), radius=18, fill=(255, 214, 102, 255), outline=BROWN + (255,), width=6)
    d.text((40, 20), text, font=f, fill=BROWN + (255,))
    if sub:
        d.text((42, 88), sub, font=ft(28, 'yuan', 0), fill=BROWN + (220,))
    return art


def paper_glasses(s=1.0):
    art = Image.new('RGBA', (int(360 * s), int(150 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    for x0 in (20, 196):
        d.rounded_rectangle((x0 * s, 20 * s, (x0 + 144) * s, 128 * s), radius=int(34 * s), fill=(196, 228, 240, 255), outline=(28, 26, 30, 255), width=int(16 * s))
    d.arc((158 * s, 30 * s, 202 * s, 74 * s), 200, 340, fill=(28, 26, 30, 255), width=int(12 * s))
    d.line((60 * s, 54 * s, 96 * s, 36 * s), fill=(255, 255, 255, 200), width=int(8 * s))
    return art


def pop_scene(img, title, sub_text, extras):
    cv = table_bg()
    d = ImageDraw.Draw(cv)
    d.polygon([(0, H), (W, H), (W - 60, 820), (60, 820)], fill=(240, 232, 214, 255))      # 下页
    d.line([(60, 820), (W - 60, 820)], fill=(205, 194, 172, 255), width=4)
    bw, bh = int(W * BS), int(H * BS)
    brd = Image.new('RGBA', (bw + 16, bh + 16), (250, 246, 236, 255))
    pic = img.resize((bw, bh), Image.LANCZOS)
    g = Image.fromarray((235 + 20 * TOOTH[:bh, :bw]).astype(np.uint8))
    pic = ImageChops.multiply(pic.convert('RGB'), Image.merge('RGB', [g, g, g])).convert('RGBA')
    brd.alpha_composite(pic, (8, 8))
    sh = Image.new('RGBA', (bw + 60, 120), (0, 0, 0, 0))                              # 背景板投在页面上的影子
    ImageDraw.Draw(sh).rectangle((20, 0, bw + 40, 40), fill=(40, 25, 10, 120))
    cv.alpha_composite(sh.filter(ImageFilter.GaussianBlur(18)), (BX - 20, BY + bh + 6))
    cv.alpha_composite(Image.new('RGBA', (bw + 16, 8), (150, 138, 120, 255)), (BX - 8, BY + bh + 8))
    cv.alpha_composite(brd, (BX - 8, BY - 8))
    s = sign_card(title)                                                             # 吊牌
    s = s.rotate(-3, expand=True, resample=Image.BICUBIC)
    sx, sy = 120, 70
    for xx in (sx + 40, sx + s.width - 50):
        d.line([(xx, 0), (xx, sy + 14)], fill=(235, 228, 210, 255), width=3)
    drop(cv, make_card(s), (sx, sy))
    for card, xy in extras:
        drop(cv, make_card(card), xy)
    f = ft(40, 'yuan', 2)
    w = d.textlength(sub_text, font=f)
    outlined(d, ((W - w) / 2, 990), sub_text, f, (255, 248, 230), BROWN, 5)
    yy, xx = np.mgrid[0:H, 0:W]
    v = (1 - 0.35 * (((xx - 800) / 1300) ** 2 + ((yy - 380) / 900) ** 2)).clip(0.45, 1)
    a = np.asarray(cv.convert('RGB'), np.float32) * v[..., None] * np.array([1.03, 1.0, 0.95])
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def style_C():
    # C1 借过：一个极小的气泡卡，几乎被人群挡住
    x, y = board_pt(450, 190)
    tiny = bubble_card(['借过'], ft(22, 'yuan', 0), (-6, 44), pad=16, base=0.12)
    save(pop_scene(load(2), '借过', '放学的人群里，没有人喊陈默。', [(tiny, (x + 30, y - 110))]), 'C1_立体书_借过.jpg')

    # C2 听懂了：咕噜纸片 → 翻译纸片；纸眼镜立在页面上
    im = load(5)
    d = ImageDraw.Draw(im)
    x0, y0 = 390, 890
    d.text((x0 + 40, y0 + 16), '咕噜…咕噜咕噜…', font=ft(26, i=0), fill=(200, 255, 220, 130))
    d.line((x0 + 40, y0 + 33, x0 + 250, y0 + 33), fill=(200, 255, 220, 140), width=2)
    d.text((x0 + 40, y0 + 58), '别、别打我……我只是，迷路了。', font=ft(44), fill=G + (255,))
    qx, qy = board_pt(1130, 250)
    ex = []
    for i, (dx, dy, a) in enumerate([(-360, -130, 12), (210, -150, -10), (240, 10, 8)]):
        c = bubble_card(['咕噜！'], ft(34, 'yuan', 2), (0, 30), pad=18, fill=(214, 240, 200)).rotate(a, expand=True, resample=Image.BICUBIC)
        ex.append((c, (qx + dx, qy + dy)))
    ex.append((paper_glasses(0.95).rotate(4, expand=True, resample=Image.BICUBIC), (1460, 820)))
    save(pop_scene(im, '听懂了', '眼镜把急促的“咕噜”声译成了人话。', ex), 'C2_立体书_听懂了.jpg')

    # C3 我叫陈默：最大的一张气泡卡从他身边弹出来
    x, y = board_pt(1300, 420)
    big = bubble_card(['我刚那句，', '能不能让我再说一遍？'], ft(66, 'yuan', 2), (860, 40), pad=40, base=0.78)
    stars = []
    for i, (sx, sy, r) in enumerate([(1420, 120, 38), (1640, 300, 26), (300, 520, 30), (1700, 120, 20)]):
        a = Image.new('RGBA', (r * 2 + 10, r * 2 + 10), (0, 0, 0, 0))
        pts = [(r + 5 + (r if k % 2 == 0 else r * 0.45) * math.cos(-math.pi / 2 + k * math.pi / 5),
                r + 5 + (r if k % 2 == 0 else r * 0.45) * math.sin(-math.pi / 2 + k * math.pi / 5)) for k in range(10)]
        ImageDraw.Draw(a).polygon(pts, fill=(255, 206, 70, 255), outline=BROWN + (255,))
        stars.append((a, (sx, sy)))
    save(pop_scene(load(16), '我叫陈默', '“我刚那句，能不能让我再说一遍？”', [(big, (150, 230))] + stars), 'C3_立体书_我叫陈默.jpg')


def sheet():
    names = sorted(n for n in os.listdir(OUT) if n[0] in 'ABC' and n.endswith('.jpg'))
    tw, th = 640, 360
    labels = {'A': 'A 镜片视界：戴上眼镜才进入镜片视野，HUD 只在此刻出现',
              'B': 'B 陈默的速写本：原画贴进本子，蜡笔批注与手写旁白',
              'C': 'C 纸片立体书：原画立成背景板，台词与道具是纸片卡'}
    S = Image.new('RGB', (tw * 3 + 40, (th + 56) * 3 + 10), (20, 20, 22))
    d = ImageDraw.Draw(S)
    for r, k in enumerate('ABC'):
        row = [n for n in names if n.startswith(k)]
        d.text((14, r * (th + 56) + 14), labels[k], font=ft(26, i=1), fill=(240, 236, 226))
        for c, n in enumerate(row):
            S.paste(Image.open(OUT + n).resize((tw, th), Image.LANCZOS), (10 + c * (tw + 10), r * (th + 56) + 52))
    S.save(OUT + '00_三选一总览.jpg', quality=88)


if __name__ == '__main__':
    style_A(); style_B(); style_C(); sheet()
    print(sorted(os.listdir(OUT)))
