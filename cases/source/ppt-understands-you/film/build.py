"""《懂你的人》故事介绍片 · A 镜片视界
画面：原画满屏 + 慢推；戴眼镜的段落进入镜片视野，HUD 填进原画预留的框；陈默说的话字号随勇气变大。
声音：MiniMax 旁白（少年音「清澈邻家弟弟」念旁白和陈默，「憨憨萌兽」配球球）+ 采样乐器配乐。
用法：python build.py [frames|audio|mux|all] [--preview]   输出 ../懂你的人_故事介绍.mp4
"""
import os, sys, json, math, re, subprocess
from functools import lru_cache
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageChops

P = os.path.expanduser('~/Desktop/懂你的人/')
SRC, VO, OUT = P + '素材/', P + '旁白/', P + 'film/out/'
LIB = os.path.expanduser('~/lemo-opuscar')
W, H, FPS = 1920, 1080, 30
XF = 0.7                       # 段间叠化
G = (120, 255, 170)
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'

LINES = {x['id']: x['zh'] for f in ('narr.json', 'qiu.json') for x in json.load(open(VO + f))}
DUR = json.load(open(VO + 'wav/dur.json'))

# (段, 图, 句子, 页号, 标题, 选项)
SCENES = [
    ('S01', 1, ['n01'], 1, '懂你的人', dict(kind='title', lead=1.6, tail=1.6, focus=(.55, .55))),
    ('S02', 2, ['n02'], 2, '借过', dict(focus=(.22, .3))),
    ('S03', 3, ['n03'], 3, '天上掉下的眼镜', dict(focus=(.55, .6))),
    ('S04', 4, ['n04'], 4, '不速之客', dict(focus=(.7, .62))),
    ('S05', 5, ['n05', 'q05'], 5, '听懂了', dict(lens=True, suby=835, gap=.5, tail=1.4, focus=(.58, .4))),
    ('S06', 6, ['n06'], 6, '可爱的多分一点', dict(focus=(.45, .5))),
    ('S07', 7, ['n07'], 7, '第一次抬头', dict(lens=True, suby=770, lead=1.4, tail=1.6, focus=(.6, .4))),
    ('S08', 8, ['n08'], 8, '靠近一点', dict(lens=True, suby=1000, lead=1.0, tail=1.8, focus=(.55, .45))),
    ('S09', 9, ['n09', 'q09'], 9, '快乐炸药', dict(tail=1.6, focus=(.5, .55))),
    ('S10', 10, ['n10', 'q10'], 10, '我当你存在', dict(tail=1.8, gap=.6, focus=(.6, .6))),
    ('S11', 11, ['n11'], 11, '看得懂，靠不近', dict(focus=(.4, .5))),
    ('S12', 12, ['n12'], 12, '自己的第一句话', dict(focus=(.5, .45))),
    ('S13', 13, ['n13'], 13, '返航提示', dict(lens=True, lead=1.2, tail=1.6, focus=(.4, .45))),
    ('S14', 14, ['n14'], 14, '寻宝', dict(lens=True, lead=1.0, tail=2.6, focus=(.65, .55))),
    ('S15', 15, ['n15'], 15, '最后一块零件', dict(focus=(.4, .5))),
    ('S16', 16, ['c16', 'n16'], 16, '我叫陈默', dict(gap=1.2, lead=1.0, tail=1.6, focus=(.68, .4))),
    ('S17', 17, ['n17', 'q17'], 17, '拉钩', dict(gap=.6, focus=(.45, .5))),
    ('S18', 18, ['n18'], 18, '大家都来了', dict(focus=(.5, .5))),
    ('S19', 19, ['n19', 'q19'], 19, '必须滴', dict(gap=.8, tail=2.0, focus=(.62, .45))),
    ('S20', 20, ['n20'], 20, '蹦三下', dict(tail=1.4, focus=(.62, .5))),
    ('S21', 21, ['n21'], 21, '抬头走路', dict(focus=(.5, .45))),
    ('S22', 22, ['n22', 'q22'], 22, '星海礼物', dict(gap=.5, focus=(.5, .45))),
    ('S23a', 23, [], 23, '第一视角影像', dict(lens=True, fixed=3.4, focus=(.5, .5))),
    ('S23b', 24, [], 23, '第一视角影像', dict(fixed=3.2, nolabel=True, focus=(.45, .45))),
    ('S24', 25, ['n24', 'q24'], 24, '你真回来了', dict(gap=.6, tail=1.6, focus=(.5, .5))),
    ('S25', 25, ['n25'], 25, '乐奇眼镜', dict(kind='brand', lead=.8, tail=2.6)),
]


def timeline():
    t, out = 0.0, []
    for sid, img, lines, page, title, o in SCENES:
        lead, gap, tail = o.get('lead', .8), o.get('gap', .35), o.get('tail', 1.0)
        cur, ls = t + lead, []
        for i, l in enumerate(lines):
            ls.append((l, cur, DUR[l]))
            cur += DUR[l] + (gap if i < len(lines) - 1 else 0)
        end = o['fixed'] + t if 'fixed' in o else cur + tail
        out.append(dict(sid=sid, img=img, lines=ls, page=page, title=title, o=o, a=t, b=end))
        t = end
    return out, t + XF


TL, TOTAL = timeline()
NF = int(round(TOTAL * FPS))


def ft(size, i=1):
    return _ft(size, i)


@lru_cache(None)
def _ft(size, i):
    return ImageFont.truetype(HIRA, size, index=i)


@lru_cache(None)
def src(n):
    return Image.open(SRC + f'i{n:02d}.png').convert('RGB')


def ease(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)


def clamp01(x):
    return min(1.0, max(0.0, x))


# ---------------------------------------------------------------- 画面基础
def kenburns(n, u, focus, z0=1.0, z1=1.075):
    im = src(n)
    sw, sh = im.size
    z = z0 + (z1 - z0) * ease(u)
    cw, ch = sw / z, sh / z
    fx, fy = focus
    cx = sw / 2 + (fx - .5) * (sw - cw) * ease(u)
    cy = sh / 2 + (fy - .5) * (sh - ch) * ease(u)
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    return im.transform((W, H), Image.EXTENT, box, Image.BICUBIC), (box, sw / W)


def to_screen(pt, kb):
    """原图 1920 坐标 → 当前推镜后的屏幕坐标"""
    (x0, y0, x1, y1), s = kb
    return ((pt[0] * s - x0) / (x1 - x0) * W, (pt[1] * s - y0) / (y1 - y0) * H)


def outlined(d, xy, text, font, fill, stroke=(0, 0, 0, 170), sw=2):
    d.text(xy, text, font=font, fill=fill, stroke_width=sw, stroke_fill=stroke)


# ---------------------------------------------------------------- 镜片
def lens_pts(scale):
    pts = []
    for i in range(360):
        t = i / 360 * 2 * math.pi
        c, s = math.cos(t), math.sin(t)
        x = 935 * np.sign(c) * abs(c) ** (2 / 9.0)
        y = 520 * np.sign(s) * abs(s) ** (2 / 6.0)
        x *= 1 - 0.04 * (y / 520)
        pts.append((960 + x * scale, 540 + y * scale))
    return pts


@lru_cache(64)
def lens_layers(scale):
    pts = lens_pts(scale)
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(3))
    rim = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(rim).line(pts + [pts[0]], fill=(14, 14, 16, 255), width=44)
    rim = rim.filter(ImageFilter.GaussianBlur(10))
    hl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(hl).polygon([(1400, 40), (1540, 40), (1180, 1040), (1060, 1040)], fill=(255, 255, 255, 13))
    hl = hl.filter(ImageFilter.GaussianBlur(30))
    hl.putalpha(ImageChops.multiply(hl.getchannel('A'), m))
    return m, rim, hl


def lens_view(im, scale):
    m, rim, hl = lens_layers(round(scale, 3))
    peri = ImageEnhance.Brightness(im.resize((240, 135), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3))
                                   .resize((W, H), Image.BILINEAR)).enhance(0.3)
    v = Image.composite(im, peri, m).convert('RGBA')
    v = Image.alpha_composite(v, rim)
    return Image.alpha_composite(v, hl)


def brackets(d, box, p, L=46, c=G, a=230, w=4):
    x0, y0, x1, y1 = box
    l = L * ease(p)
    if l < 1:
        return
    for (x, y, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(x, y + sy * l), (x, y), (x + sx * l, y)], fill=c + (a,), width=w)


def typed(text, t, t0, cps=16):
    k = int((t - t0) * cps)
    return text[:max(0, min(len(text), k))]


# ---------------------------------------------------------------- 字幕
def chunks(text, n=19):
    parts = re.findall(r'[^，。？！：；]+[，。？！：；]?', text)
    out, cur = [], ''
    for p in parts:
        if len(cur + p) <= n:
            cur += p
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return out


def sub_spans(lid, t0, dur):
    cs = chunks(LINES[lid])
    tot = sum(len(c) for c in cs)
    spans, cur = [], t0
    for c in cs:
        d = dur * len(c) / tot
        spans.append((c.rstrip('，；：'), cur, cur + d))
        cur += d
    return spans


def draw_sub(d, text, y, color=(255, 250, 240), alpha=1.0):
    f = ft(36)
    w = d.textlength(text, font=f)
    a = int(255 * alpha)
    outlined(d, ((W - w) / 2, y), text, f, color + (a,), (0, 0, 0, int(170 * alpha)), 2)


# ---------------------------------------------------------------- 各段特写
def special(sc, t, im, kb):
    sid, o = sc['sid'], sc['o']
    lt = {l: (a, a + d) for l, a, d in sc['lines']}
    d = ImageDraw.Draw(im)
    ts = t - sc['a']
    if kb:
        zf = W * kb[1] / (kb[0][2] - kb[0][0])
        Pt = lambda x, y: to_screen((x, y), kb)
        F = lambda sz, w=1: ft(int(round(sz * zf)), w)
    if sid == 'S01':
        a = ease((ts - .4) / 1.2)
        outlined(d, (130, 150), '懂你的人', ft(128), (255, 250, 236, int(255 * a)), (0, 0, 30, int(120 * a)), 3)
        d.text((136, 320), '乐奇眼镜创意品牌短片', font=ft(32, 0), fill=(235, 235, 230, int(220 * a)))
    if sid == 'S02':                                   # 他说话只有这么小
        s0 = lt['n02'][0] + 2.6
        if t > s0:
            x, y = to_screen((452, 206), kb)
            d.text((x, y), '借过', font=ft(19, 0), fill=(255, 255, 255, int(130 * ease((t - s0) / .4))))
    if sid == 'S03':                                   # 镜片内闪过一道微光
        s0 = lt['n03'][0] + 3.0
        p = (t - s0) / 1.1
        if 0 < p < 1:
            k = math.sin(p * math.pi)
            for pt, r in [((1060, 625), 120), ((1478, 655), 60)]:
                x, y = to_screen(pt, kb)
                fl = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                fd = ImageDraw.Draw(fl)
                fd.ellipse((x - r * k, y - r * k, x + r * k, y + r * k), fill=G + (int(110 * k),))
                fd.line((x - 3 * r * k, y, x + 3 * r * k, y), fill=(220, 255, 235, int(200 * k)), width=3)
                fd.line((x, y - 1.4 * r * k, x, y + 1.4 * r * k), fill=(220, 255, 235, int(160 * k)), width=2)
                im.alpha_composite(fl.filter(ImageFilter.GaussianBlur(6)))
                im.alpha_composite(fl.filter(ImageFilter.GaussianBlur(1.5)))
            d = ImageDraw.Draw(im)
    if sid == 'S05':
        x0, y0 = 390, 890
        n0 = lt['n05'][0] + .3
        if t > n0:
            s = typed('咕噜…咕噜咕噜…', t, n0, 8)
            d.text(Pt(x0 + 40, y0 + 16), s, font=F(26, 0), fill=(200, 255, 220, 140))
            if t > lt['n05'][1] - .6:
                a_, b_ = Pt(x0 + 40, y0 + 33), Pt(x0 + 40 + 210 * ease((t - lt['n05'][1] + .6) / .4), y0 + 33)
                d.line(a_ + b_, fill=(200, 255, 220, 150), width=2)
            d.text(Pt(1434, y0 + 16), '翻译', font=F(24, 0), fill=G + (210,))
            for i in range(46):
                hh = (6 + 26 * abs(math.sin(i * .7 + t * 9)) * (.5 + .5 * math.sin(i * .23))) if t < lt['q05'][1] else 4
                d.line(Pt(x0 + 300 + i * 9, y0 + 30 - hh / 2) + Pt(x0 + 300 + i * 9, y0 + 30 + hh / 2), fill=G + (120,), width=3)
        q0, q1 = lt['q05']
        if t > q0:
            d.text(Pt(x0 + 40, y0 + 58), typed(LINES['q05'], t, q0, len(LINES['q05']) / (q1 - q0) * 1.3), font=F(44), fill=G + (255,))
        brackets(d, to_screen((860, 120), kb) + to_screen((1380, 640), kb), (ts - 1.0) / .5)
    if sid == 'S07':
        a0 = sc['a'] + 1.0
        for i in range(30):
            hh = 4 + 18 * abs(math.sin(i * .9 + t * 8)) * (.5 + .5 * math.sin(i * .3))
            d.line(Pt(520 + i * 9, 157 - hh / 2) + Pt(520 + i * 9, 157 + hh / 2), fill=G + (90,), width=3)
        d.text(Pt(1540, 122), typed('英 → 中', t, a0 + .6, 10), font=F(22, 0), fill=G + (230,))
        d.text(Pt(130, 852), typed('Go straight and turn left.', t, a0 + .3, 20), font=F(34, 0), fill=(220, 255, 235, 230))
        d.text(Pt(130, 922), typed('直走，然后左转。', t, a0 + 1.6, 9), font=F(46), fill=G + (255,))
    if sid == 'S08':
        a0, x0, y0 = sc['a'] + .9, 36, 584
        brackets(d, to_screen((660, 360), kb) + to_screen((1180, 930), kb), (ts - .6) / .5)
        d.text(Pt(x0 + 140, y0 + 48), typed('识别：猫', t, a0, 10), font=F(36), fill=G + (255,))
        d.text(Pt(x0 + 60, y0 + 130), typed('问：如何温柔接近？', t, a0 + .9, 12), font=F(32, 0), fill=(230, 255, 240, 240))
        d.text(Pt(x0 + 60, y0 + 190), typed('答：先让它闻闻手。', t, a0 + 2.6, 10), font=F(40), fill=G + (255,))
    if sid == 'S09':
        q0 = lt['q09'][0]
        for i, ch in enumerate('再来一根！'):
            ti = q0 + i * .32
            if t > ti:
                p = clamp01((t - ti) / .25)
                sc_ = .6 + .5 * math.sin(p * math.pi * .5) + .1 * math.sin(p * math.pi)
                f = ft(int(130 * sc_))
                x, y = 520 + i * 180, 70 + 18 * math.sin(i * 1.7)
                outlined(d, (x, y), ch, f, (255, 214, 90, 255), (60, 25, 10, 255), 6)
    if sid == 'S10':
        q0, q1 = lt['q10']
        ti = q0 + DUR['q10'] * .52
        if t > ti:
            p = ease((t - ti) / 1.4)
            f = ft(int(40 + 92 * p))
            outlined(d, (110, 110), '很大声地存在。', f, (255, 248, 230, int(255 * clamp01((t - ti) / .3))), (10, 20, 60, 160), 4)
    if sid == 'S13':
        a0 = sc['a'] + 1.0
        bx = (1230, 110, 1800, 430)
        if ts > .9:
            pan = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            pd = ImageDraw.Draw(pan)
            al = ease((ts - .9) / .4)
            pd.rounded_rectangle(bx, radius=18, fill=(10, 40, 30, int(120 * al)), outline=G + (int(200 * al),), width=3)
            im.alpha_composite(pan)
            d = ImageDraw.Draw(im)
            d.text((bx[0] + 30, bx[1] + 26), typed('球球状态：持续衰弱', t, a0, 12), font=ft(34), fill=G + (255,))
            lvl = 1 - .78 * ease((t - a0 - 1) / 3.5)
            d.rectangle((bx[0] + 30, bx[1] + 86, bx[0] + 30 + 500 * lvl, bx[1] + 104), fill=(255, 150, 90, 230) if lvl < .45 else G + (230,))
            d.rectangle((bx[0] + 30, bx[1] + 86, bx[0] + 530, bx[1] + 104), outline=G + (160,), width=2)
            d.text((bx[0] + 30, bx[1] + 136), typed('当前设备：飞船密钥', t, a0 + 1.6, 12), font=ft(30, 0), fill=(230, 255, 240, 240))
            d.text((bx[0] + 30, bx[1] + 200), typed('我想回家', t, a0 + 3.4, 6), font=ft(46), fill=(255, 236, 200, 255))
    if sid == 'S14':
        a0, x0, y0 = sc['a'] + .9, 76, 260
        brackets(d, to_screen((1360, 760), kb) + to_screen((1780, 1000), kb), (ts - .5) / .5)
        rows = [('乐奇，看一下这是什么？', 30, 0, (255, 240, 210)), ('识别：电路板', 36, 1, G), ('可见元件：电容、铜线圈', 28, 0, (230, 255, 240)),
                ('问：电容有什么作用？', 28, 0, (230, 255, 240)), ('答：储存电能，平滑电压。', 34, 1, G)]
        tt = a0
        for i, (s, sz, w, c) in enumerate(rows):
            d.text(Pt(x0 + 44, y0 + 50 + i * 66), typed(s, t, tt, 13), font=F(sz, w), fill=c + (255,))
            tt += len(s) / 13 + .25
    if sid == 'S16':                                   # 字终于很大
        c0 = lt['c16'][0]
        for i, (l, frac) in enumerate([('我刚那句，', 0), ('能不能让我', .4), ('再说一遍？', .7)]):
            ti = c0 + DUR['c16'] * frac
            if t > ti:
                p = ease((t - ti) / .9)
                outlined(d, (90, 80 + i * 126), l, ft(int(34 + 70 * p)), (255, 248, 232, int(255 * clamp01((t - ti) / .25))), (0, 0, 0, 120), 3)
    if sid == 'S19':
        q0 = lt['q19'][0]
        for i, ch in enumerate('必须滴！'):
            ti = q0 + i * .12
            if t > ti:
                p = clamp01((t - ti) / .3)
                sc_ = .3 + .85 * math.sin(p * math.pi * .5) - .15 * math.sin(p * math.pi)
                g = Image.new('RGBA', (300, 300), (0, 0, 0, 0))
                outlined(ImageDraw.Draw(g), (40, 20), ch, ft(int(190 * sc_)), (255, 214, 90, 255), (30, 40, 90, 255), 7)
                g = g.rotate([-8, 5, -4, 10][i], resample=Image.BICUBIC)
                im.alpha_composite(g, (150 + i * 210, int(40 + 30 * math.sin(i * 1.3))))
        d = ImageDraw.Draw(im)
    if sid == 'S23a':
        a0 = sc['a'] + .8
        if int(t * 2) % 2 == 0:
            d.ellipse((248, 128, 268, 148), fill=(255, 70, 60, 230))
        d.text((282, 122), '第一视角', font=ft(24, 0), fill=G + (220,))
        d.text((250, 172), typed('把你记住', t, a0, 6), font=ft(52), fill=G + (255,))
    if sid == 'S23b':
        a0 = sc['a'] + .6
        bx = (150, 150, 620, 330)
        if ts > .4:
            al = ease((ts - .4) / .4)
            pan = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(pan).rounded_rectangle(bx, radius=26, fill=(10, 40, 30, int(130 * al)), outline=G + (int(210 * al),), width=3)
            im.alpha_composite(pan)
            d = ImageDraw.Draw(im)
            d.text((bx[0] + 34, bx[1] + 26), '跨星来电', font=ft(26, 0), fill=G + (int(220 * al),))
            d.text((bx[0] + 34, bx[1] + 80), typed('想我没？', t, a0 + .5, 6), font=ft(64), fill=(255, 248, 232, 255))
    if sid == 'S25':
        a = ease((ts - .3) / 1.0)
        for txt, sz, y, c in [('乐奇眼镜', 104, 400, (255, 250, 240)), ('看得见世界，更懂你想说的话。', 42, 570, (235, 230, 220))]:
            f = ft(sz)
            w = d.textlength(txt, font=f)
            d.text(((W - w) / 2, y), txt, font=f, fill=c + (int(255 * a),))
        brackets(d, (560, 340, 1360, 660), (ts - .8) / .8, L=60, a=200)
    return im


# ---------------------------------------------------------------- 一段的一帧
def scene_frame(sc, t):
    o = sc['o']
    u = (t - sc['a']) / (sc['b'] - sc['a'] + XF)
    if o.get('kind') == 'brand':
        im = src(25).resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(8))
        im = ImageEnhance.Brightness(im).enhance(.4).convert('RGBA')
        kb = None
    else:
        im, kb = kenburns(sc['img'], u, o.get('focus', (.5, .5)), z1=1.035 if o.get('lens') else 1.075)
        im = im.convert('RGBA')
    ts = t - sc['a']
    if o.get('lens'):
        s = 1.32 - .32 * ease((ts - .15) / .85)
        im = lens_view(im.convert('RGB'), s)
    im = special(sc, t, im, kb)
    d = ImageDraw.Draw(im)
    if not o.get('nolabel') and o.get('kind') not in ('title', 'brand'):
        a = ease((ts - .3) / .5) * (1 - ease((ts - (sc['b'] - sc['a']) + .6) / .5))
        lab = f"{sc['page']:02d}  {sc['title']}"
        if not o.get('lens'):
            d.text((64, 46), lab, font=ft(26, 0), fill=(255, 255, 255, int(160 * a)))
    if o.get('kind') != 'brand':
        y = o.get('suby', 985)
        for lid, a0, du in sc['lines']:
            if lid in ('q05', 'c16', 'q09', 'q19'):
                continue                                  # 这几句由 HUD / 大字呈现
            col = (255, 222, 120) if lid.startswith('q') else (255, 250, 240)
            for txt, s0, s1 in sub_spans(lid, a0, du):
                if s0 - .05 <= t < s1 + .15:
                    al = clamp01((t - s0 + .05) / .12) * clamp01((s1 + .15 - t) / .12)
                    draw_sub(d, txt, y, col, al)
    return im.convert('RGB')


def frame(fi):
    t = fi / FPS
    cur = [s for s in TL if s['a'] <= t < s['b'] + XF]
    if not cur:
        cur = [TL[-1]]
    if len(cur) == 1:
        im = scene_frame(cur[0], t)
    else:
        A, B = cur[0], cur[1]
        p = ease((t - B['a']) / XF)
        im = Image.blend(scene_frame(A, t), scene_frame(B, t), p)
    fo = 1 - ease((t - (TOTAL - 1.2)) / 1.2)               # 片尾淡出
    fi_ = ease(t / .6)                                     # 片头淡入
    if fo * fi_ < 1:
        im = ImageEnhance.Brightness(im).enhance(fo * fi_)
    return im


def write_frame(fi):
    p = OUT + f'frames/{fi:05d}.jpg'
    if not os.path.exists(p):
        frame(fi).save(p, quality=93)
    return fi


# ---------------------------------------------------------------- 声音
def audio():
    sys.path.insert(0, LIB)
    import soundfile as sf, soxr
    from core.audio import sampler as S
    from core.audio.sfx import SR, add
    S.seed(11)
    N = int((TOTAL + 1) * SR)
    vo = np.zeros((N, 2), np.float32)
    for sc in TL:
        for lid, a0, du in sc['lines']:
            x, sr = sf.read(VO + f'wav/{lid}.wav', dtype='float32')
            if x.ndim > 1:
                x = x.mean(1)
            x = soxr.resample(x, sr, SR)
            g = 1.0 if lid.startswith('n') or lid.startswith('c') else .95
            add(vo, x * g, a0, 1.0, -.08 if lid.startswith('q') else 0)

    # —— 配乐：76 BPM，按时间落在哪一段决定情绪
    beat = 60 / 76
    bar = beat * 4
    mood_of = {}
    for sc in TL:
        n = int(sc['sid'][1:3])
        m = ('intro' if n <= 4 else 'play' if n <= 9 else 'warm' if n == 10 else 'low' if n <= 13 else
             'build' if n <= 15 else 'peak' if n == 16 else 'tender' if n <= 20 else 'lift' if n <= 24 else 'end')
        mood_of[sc['sid']] = m

    def mood(t):
        for sc in TL:
            if sc['a'] <= t < sc['b']:
                return mood_of[sc['sid']]
        return 'end'
    MAJ = [('D', ['D', 'F#', 'A']), ('B', ['B', 'D', 'F#']), ('G', ['G', 'B', 'D']), ('A', ['A', 'C#', 'E'])]
    MIN = [('B', ['B', 'D', 'F#']), ('G', ['G', 'B', 'D']), ('E', ['E', 'G', 'B']), ('F#', ['F#', 'A#', 'C#'])]
    ev = []
    brand_t = TL[-1]['a']
    nb = int(brand_t / bar) + 1
    for k in range(nb):
        t0 = k * bar
        m = mood(t0 + .01)
        root, ch = (MIN if m == 'low' else MAJ)[k % 4]
        r2, r3 = root + '2', root + '3'
        c4 = [c + '4' for c in ch]
        c5 = [c + '5' for c in ch]
        if m in ('intro', 'tender', 'warm', 'lift'):
            pat = [ch[0] + '3', ch[2] + '3', ch[0] + '4', ch[1] + '4', ch[2] + '4', ch[1] + '4', ch[0] + '4', ch[2] + '3']
            step = beat / 2 if m != 'tender' else beat
            for i, p in enumerate(pat[:int(bar / step)]):
                ev.append((t0 + i * step, 'piano', p, step * 2.2, .30 if m == 'intro' else .34, -.15))
            ev.append((t0, 'cellos', r2, bar, .26, .25))
        if m in ('warm', 'lift', 'tender'):
            ev.append((t0, 'violins', c5[1], bar, .22, .3))
            ev.append((t0, 'violins', c5[2] if m != 'tender' else c4[2], bar, .18, .35))
        if m == 'warm':
            for i in range(4):
                ev.append((t0 + i * beat, 'celesta', [c5[0], c5[1], c5[2], c5[1]][i], beat, .32, .4))
        if m in ('play', 'lift'):
            for i in (0, 2):
                ev.append((t0 + i * beat, 'cellos_pizz', r2 if i == 0 else ch[2] + '2', beat, .45, .2))
            for i in (1, 3):
                for p in c4:
                    ev.append((t0 + i * beat, 'piano', p, beat * .5, .28, -.2))
            mel = [c5[1], c5[2], c5[0], c5[2]] if k % 2 == 0 else [c5[2], c5[1], c5[0], None]
            for i, p in enumerate(mel):
                if p:
                    ev.append((t0 + i * beat + beat / 2, 'glockenspiel', p, beat, .26, .4))
        if m == 'low':
            ev.append((t0, 'piano', r3, bar, .26, -.1))
            ev.append((t0, 'piano', ch[2] + '3', bar, .2, -.1))
            ev.append((t0 + 2 * beat, 'piano', ch[1] + '4', bar / 2, .2, -.1))
            ev.append((t0, 'cellos', r2, bar, .22, .2))
            ev.append((t0, 'vibraphone_bowed', ch[1] + '4', bar, .18, .3))
        if m == 'build':
            for i in range(8):
                ev.append((t0 + i * beat / 2, 'piano', c4[i % 3], beat * .45, .3 + .02 * (k % 4), -.2))
                ev.append((t0 + i * beat / 2, 'cellos_spic', r2, beat * .4, .3, .2))
            ev.append((t0, 'violins', c5[(k % 3)], bar, .25, .3))
        if m == 'peak':
            for i in (0, 2):
                for p in [r3] + c4:
                    ev.append((t0 + i * beat, 'piano', p, beat * 2, .46, -.15))
            ev.append((t0, 'contrabass', r2, bar, .35, 0))
            ev.append((t0, 'cellos', r3, bar, .35, .2))
            for p in c5:
                ev.append((t0, 'violins', p, bar, .32, .3))
            ev.append((t0, 'glockenspiel', c5[0], beat, .3, .4))
    # 片尾：落在 D 大三和弦
    for p in ['D2', 'D3', 'A3', 'D4', 'F#4', 'A4']:
        ev.append((brand_t, 'piano', p, 6, .4, -.1))
    for p in ['D4', 'F#4', 'A4', 'D5']:
        ev.append((brand_t, 'violins', p, 6, .26, .3))
    ev.append((brand_t + .3, 'glockenspiel', 'A5', 2, .3, .4))
    ev.append((brand_t + .9, 'glockenspiel', 'D6', 3, .3, .4))
    # 微光提示
    s03 = next(s for s in TL if s['sid'] == 'S03')
    ev.append((s03['lines'][0][1] + 3.0, 'glockenspiel', 'E6', 2, .35, .3))
    ev.append((s03['lines'][0][1] + 3.15, 'celesta', 'B6', 2, .3, .3))
    mus = S.render(ev, dur=TOTAL + 1)[:N]
    mus = S.room(mus, size=.5, mix=.22)
    mus = np.pad(mus, ((0, max(0, N - len(mus))), (0, 0)))[:N]

    # —— 音效：进镜片「嘀」+ HUD 轻打字
    sfx = np.zeros((N, 2), np.float32)
    tt = np.arange(int(.14 * SR)) / SR
    beep = (np.sin(2 * np.pi * (1500 * tt + 1800 * tt * tt)) * np.exp(-tt * 22)).astype(np.float32) * .35
    tick = (np.random.default_rng(3).normal(0, 1, int(.012 * SR)) * np.exp(-np.arange(int(.012 * SR)) / 60)).astype(np.float32) * .12
    for sc in TL:
        if sc['o'].get('lens'):
            add(sfx, beep, sc['a'] + .35, 1, 0)
            for i in range(14):
                add(sfx, tick, sc['a'] + 1.0 + i * .13, 1, .3)

    # —— 旁白下压音乐
    env = np.abs(vo).mean(1)
    k = int(.25 * SR)
    env = np.convolve(env, np.ones(k) / k, mode='same')
    duck = 1 - .62 * np.clip(env / .02, 0, 1)
    k2 = int(.4 * SR)
    duck = np.convolve(duck, np.ones(k2) / k2, mode='same')[:, None]
    mix = vo + mus * .55 * duck + sfx * .8
    sf.write(OUT + 'mix.wav', mix.astype(np.float32), SR)
    with open(OUT + 'credits_music.txt', 'w') as f:
        f.write('\n'.join(S.credits(sorted({e[1] for e in ev}))))
    print('audio', round(len(mix) / SR, 1), 's')


def srt():
    def ts(x):
        h, r = divmod(x, 3600)
        m, s = divmod(r, 60)
        return f'{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}'
    k, rows = 1, []
    for sc in TL:
        for lid, a0, du in sc['lines']:
            for txt, s0, s1 in sub_spans(lid, a0, du):
                rows.append(f'{k}\n{ts(s0)} --> {ts(s1)}\n{txt}\n')
                k += 1
    open(P + '懂你的人_故事介绍.srt', 'w').write('\n'.join(rows))


def mux():
    out = P + '懂你的人_故事介绍.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', OUT + 'frames/%05d.jpg',
                    '-i', OUT + 'mix.wav', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], check=True)
    print(out)


if __name__ == '__main__':
    os.makedirs(OUT + 'frames', exist_ok=True)
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    print('total', round(TOTAL, 2), 's', NF, 'frames')
    if what == 'stills':                      # 每段中点抽一帧
        os.makedirs(OUT + 'stills', exist_ok=True)
        for sc in TL:
            for q in (.35, .8):
                t = sc['a'] + (sc['b'] - sc['a']) * q
                frame(int(t * FPS)).save(OUT + f"stills/{sc['sid']}_{int(q * 100)}.jpg", quality=85)
    if what in ('frames', 'all'):
        with Pool(10) as pool:
            for i, _ in enumerate(pool.imap_unordered(write_frame, range(NF), chunksize=8)):
                if i % 600 == 0:
                    print(i, '/', NF, flush=True)
    if what in ('audio', 'all'):
        audio()
    if what in ('mux', 'all'):
        srt()
        mux()
