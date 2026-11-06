"""《IN SIGHT 目之所及》故事介绍片 · 成片
画面：PPT 原图 + ROG 深度图做 2.5D 视差推镜；代码层分两套语言——
  镜片绿：只给眼镜真实功能（导航提示 / 拍照 / 来电 / 翻译 / 免持通话），永远带“眼镜功能”角标；
  故事层：地图、人物标签、Jack↔Ryan 联络线、饮料与钥匙的同一条抛物线。
声音：MiniMax 中文旁白 + 英/西语对白 + Music3 配乐 + 代码合成音效。
用法：python build.py [frames|audio|mux|all] [--preview] [--from 秒 --to 秒]
"""
import os, sys, json, math, subprocess
from functools import lru_cache
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

P = os.path.expanduser('~/Desktop/目之所及/')
SRC, DEP, VO, OUT, MUS = P + '素材/slides/', P + 'depth/', P + '配音/', P + 'film/out/', P + '音乐/'
W, H, FPS = 1920, 1080, 24
XF = 0.5                                  # 段间叠化
LENS = (108, 255, 150); PAPER = (243, 235, 221); SUB = (225, 218, 205)
JACK, RYAN, VEX = (255, 170, 64), (92, 178, 255), (255, 84, 68)
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
AVC = '/System/Library/Fonts/Avenir Next Condensed.ttc'
AVN = '/System/Library/Fonts/Avenir Next.ttc'

LINES = {x['id']: x for x in json.load(open(VO + 'lines.json'))}
DUR = json.load(open(VO + 'wav/dur.json'))

# ---------------------------------------------------------------- 时间线
# (句子, 句前停顿)
ORDER = [('n01', 2.6), ('n02', 1.4), ('d_ray', .3), ('n03', .5),
         ('n04', 1.0), ('d_vex1', .3), ('n05', .4),
         ('n06', 1.0), ('n07', .3),
         ('n08', 1.0),
         ('d_guard', 1.2), ('n09', .3),
         ('n10', 1.0), ('d_jack1', .3), ('d_ryan1', .2), ('n11', .4),
         ('n12', 1.2), ('d_jack2', .4), ('d_vex2', .3),
         ('n13', 1.2), ('n14', .5),
         ('n15', 1.2), ('n16', .8), ('n17', 1.0),
         ('n18', 1.2),
         ('n19', 1.4), ('d_vex3', .6), ('n20', 3.4)]
T = {}; _t = 0.0
for k, g in ORDER:
    _t += g; T[k] = _t; _t += DUR[k]
def at(k, f=0.0): return T[k] + f * DUR[k]
def end(k): return T[k] + DUR[k]
TOTAL = end('n20') + 6.0

# 场景：(名, 起, 止, 页码, 标题)。相邻场景重叠 XF 叠化
SC = [
    ('open',  0.0,               at('n02') - .9,      4,  '海岸公路'),
    ('ray',   at('n02') - .9,    at('n04') - .6,      2,  '饮料摊'),
    ('call',  at('n04') - .6,    at('n06') - .5,      3,  '来电'),
    ('road',  at('n06') - .5,    at('n07') - .1,      4,  '前方路口'),
    ('jump',  at('n07') - .1,    at('n08') - .5,      5,  '岔道飞车'),
    ('bottle', at('n08') - .5,   at('d_guard') - .6,  6,  '直道'),
    ('guard', at('d_guard') - .6, at('n10') - .5,     7,  '设施门口'),
    ('map',   at('n10') - .5,    at('n12') - .6,      8,  '分头'),
    ('stand', at('n12') - .6,    at('n13') - .5,      9,  '对峙'),
    ('ham',   at('n13') - .5,    at('n13', .52),      10, '下层'),
    ('evac',  at('n13', .52),    at('n14') - .2,      11, '撤出'),
    ('lost',  at('n14') - .2,    at('n15') - .4,      11, '联络中断'),
    ('fight', at('n15') - .4,    at('n16') - .2,      12, '扭打'),
    ('hang',  at('n16') - .2,    at('n16', .56),      13, '悬空'),
    ('trust', at('n16', .56),    at('n17') - .2,      13, '看不见'),
    ('catch', at('n17') - .2,    at('n17', .42),      14, '接住'),
    ('twin',  at('n17', .42),    at('n18') - .5,      14, '同一条抛物线'),
    ('abort', at('n18') - .5,    at('n19') - .6,      15, '终止'),
    ('end',   at('n19') - .6,    TOTAL,               16, '目之所及'),
]

# ---------------------------------------------------------------- 工具
def F(size, bold=False): return ImageFont.truetype(HIRA, size, index=1 if bold else 0)
def E(size, w='demi', cond=True):
    return ImageFont.truetype(AVC if cond else AVN, size, index={'bold': 0, 'demi': 2, 'med': 5, 'reg': 7, 'heavy': 8, 'ul': 10}[w])
F = lru_cache(None)(F); E = lru_cache(None)(E)
def cjk(t): return any(ord(c) > 0x2E7F for c in t)

def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ss(x): x = clamp(x); return x * x * (3 - 2 * x)
def ramp(t, a, b): return ss((t - a) / (b - a)) if b > a else float(t >= a)
def eo(x): x = clamp(x); return 1 - (1 - x) ** 3

def fit_arr(im):
    s = max(W / im.width, H / im.height)
    im = im.resize((math.ceil(im.width * s), math.ceil(im.height * s)), Image.LANCZOS)
    x, y = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((x, y, x + W, y + H))

@lru_cache(None)
def depth(k):
    d = Image.fromarray(np.asarray(Image.open(DEP + f's{k:02d}_depth.png')).astype(np.float32), 'F')
    a = np.asarray(fit_arr(d)).astype(np.float32)
    a = (a - np.percentile(a, 2)) / (np.percentile(a, 98) - np.percentile(a, 2) + 1e-6)
    return ndi.gaussian_filter(np.clip(a, 0, 1), 3)

def green_mask(a, box):
    """原图里烘进去的绿色 HUD 字（来电 / 导航 / 翻译），只在 box 内找"""
    x0, y0, x1, y1 = box; m = np.zeros(a.shape[:2], np.float32)
    r, g, b = a[y0:y1, x0:x1, 0], a[y0:y1, x0:x1, 1], a[y0:y1, x0:x1, 2]
    s = (g > r + 0.12) & (g > b + 0.06) & (g > 0.42)
    s = ndi.binary_dilation(s, iterations=4)
    m[y0:y1, x0:x1] = s
    return ndi.gaussian_filter(m, 1.5)

def inpaint(a, m):
    """归一化卷积补洞：用周围颜色填掉 HUD 字"""
    keep = (m < 0.05).astype(np.float32); out = a.copy()
    for s in (6, 14, 30):
        num = ndi.gaussian_filter(a * keep[..., None], (s, s, 0)); den = ndi.gaussian_filter(keep, s)[..., None]
        fill = num / np.maximum(den, 1e-4)
        out = np.where((m > 0.02)[..., None] & (den > 0.02), fill, out)
        if (den > 0.02).all(): break
    return out

HUDBOX = {3: (10, 10, 420, 210), 4: (1470, 560, 1790, 705), 7: (40, 550, 400, 650)}

@lru_cache(None)
def base(k):
    """返回 (原图, 去掉 HUD 的图, HUD 掩码)，都是 1920×1080 float"""
    a = np.asarray(fit_arr(Image.open(SRC + f's{k:02d}.png').convert('RGB'))).astype(np.float32) / 255
    if k in HUDBOX:
        m = green_mask(a, HUDBOX[k]); return a, inpaint(a, m), m
    return a, a, None

def img(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def arr(im): return np.asarray(im).astype(np.float32) / 255

# ---------------------------------------------------------------- 2.5D 相机
class Cam:
    """keys: [(u, z, cx, cy, px, py)]，u∈[0,1] 为场景内进度；px/py=视差幅度（像素，近景位移）"""
    def __init__(self, keys, w=W, h=H): self.keys, self.w, self.h = keys, w, h
    def at(self, u):
        ks = self.keys
        if u <= ks[0][0]: v = ks[0][1:]
        elif u >= ks[-1][0]: v = ks[-1][1:]
        else:
            for a, b in zip(ks, ks[1:]):
                if a[0] <= u <= b[0]:
                    f = ss((u - a[0]) / (b[0] - a[0])); v = [x + (y - x) * f for x, y in zip(a[1:], b[1:])]; break
        z, cx, cy, px, py = v
        hw, hh = self.w / (2 * z), self.h / (2 * z); m = 6 + abs(px) + abs(py)
        cx = clamp(cx, hw + m, W - hw - m); cy = clamp(cy, hh + m, H - hh - m)
        return z, cx, cy, px, py

def render_bg(a, k, cam, u, shake=(0, 0), w=W, h=H, hud=None, still=None):
    z, cx, cy, px, py = cam.at(u); cx += shake[0]; cy += shake[1]
    o, clean, m = base(k)
    src = a if a is not None else o
    if m is not None and hud is not None: src = clean + (o - clean) * (m * hud)[..., None]
    elif m is not None and a is None: src = o
    D = depth(k)
    v, uu = np.mgrid[0:h, 0:w].astype(np.float32)
    x0 = (uu - w / 2) / z + cx; y0 = (v - h / 2) / z + cy
    xi = np.clip(x0.astype(np.int32), 0, W - 1); yi = np.clip(y0.astype(np.int32), 0, H - 1)
    d = D[yi, xi] - 0.5
    xs = x0 + px * d / z; ys = y0 + py * d / z
    out = np.empty((h, w, 3), np.float32)
    for c in range(3): out[..., c] = ndi.map_coordinates(src[..., c], [ys, xs], order=1, mode='nearest')
    return out, (z, cx, cy)

def mapper(zc, ox=0, oy=0, w=W, h=H):
    z, cx, cy = zc
    return lambda x, y: ((x - cx) * z + w / 2 + ox, (y - cy) * z + h / 2 + oy)

# ---------------------------------------------------------------- 画面层工具
def grade(a, sat=1.0, bright=1.0, warm=0.0):
    g = a.mean(2, keepdims=True); a = g + (a - g) * sat; a = a * bright
    if warm: a = a + np.array([warm * .04, warm * .01, -warm * .04], np.float32)
    return a

def glow(a, L, color, core=1.0, s1=2.0, s2=10, k1=0.9, k2=0.6):
    """L: PIL 'L' 图层；在 1/4 尺寸上算光晕，快"""
    m = np.asarray(L).astype(np.float32) / 255
    if m.max() == 0: return a
    sm = np.asarray(L.resize((L.width // 4, L.height // 4), Image.BILINEAR)).astype(np.float32) / 255
    b1 = ndi.gaussian_filter(sm, s1 / 4 + .5); b2 = ndi.gaussian_filter(sm, s2 / 4)
    up = lambda x: np.asarray(Image.fromarray(x.astype(np.float32)).resize((L.width, L.height), Image.BILINEAR))
    g = m * core + up(b1) * k1 + up(b2) * k2
    return a + g[..., None] * (np.array(color, np.float32) / 255)

def over(im, ov):
    return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

def rgba(): return Image.new('RGBA', (W, H), (0, 0, 0, 0))

def text(d, xy, t, size, fill, alpha=1.0, anchor='ls', bold=False, w='demi', shadow=True, font=None):
    f = font or (F(size, bold) if cjk(t) else E(size, w))
    a = int(255 * clamp(alpha))
    if a <= 0: return
    if shadow:
        for dx, dy in ((2, 2), (0, 2), (2, 0), (-1, 1)):
            d.text((xy[0] + dx, xy[1] + dy), t, font=f, fill=(0, 0, 0, int(a * .55)), anchor=anchor)
    d.text(xy, t, font=f, fill=tuple(fill[:3]) + (a,), anchor=anchor)

def mixed(d, xy, parts, alpha=1.0, anchor='m'):
    """[(文字, 字号, 颜色)] 中英混排一行，自动选字体"""
    fs = [(t, F(s) if cjk(t) else E(s, 'med'), c) for t, s, c in parts]
    tw = sum(d.textlength(t, font=f) for t, f, c in fs)
    x = xy[0] - (tw / 2 if anchor == 'm' else 0)
    for t, f, c in fs:
        text(d, (x, xy[1]), t, 0, c, alpha, font=f); x += d.textlength(t, font=f)

def tracked(d, xy, t, f, fill, track=0.5, alpha=1.0):
    ws = [d.textlength(c, font=f) for c in t]; tot = sum(ws) + track * f.size * (len(t) - 1)
    x = xy[0] - tot / 2
    for c, w in zip(t, ws):
        d.text((x, xy[1]), c, font=f, fill=fill + (int(255 * alpha),), anchor='ls'); x += w + track * f.size

def chip(d, xy, t, color, size=26, alpha=1.0, anchor='l', fill_a=185, bold=False):
    if alpha <= 0: return None
    f = F(size, bold) if cjk(t) else E(size, 'demi'); tw = d.textlength(t, font=f); x, y = xy
    if anchor == 'm': x -= tw / 2 + 18
    if anchor == 'r': x -= tw + 36
    x = clamp(x, 24, W - tw - 60); y = clamp(y, 24, H - size - 44)
    a = clamp(alpha); box = [x, y, x + tw + 36, y + size + 20]
    d.rounded_rectangle(box, 6, fill=(12, 12, 14, int(fill_a * a)), outline=tuple(color) + (int(255 * a),), width=2)
    d.text((x + 18, y + 10 + size * .86), t, font=f, fill=PAPER + (int(255 * a),), anchor='ls')
    return box

def tag(d, xy, name, role, color, alpha, line_to=None):
    if alpha <= 0: return
    a = int(255 * alpha); x, y = xy
    nf, rf = E(40, 'bold'), F(22)
    tw = max(d.textlength(name, font=nf), d.textlength(role, font=rf))
    x = clamp(x, 30, W - tw - 70); y = clamp(y, 70, H - 230)
    if line_to:
        d.line([line_to, (x, y)], fill=color + (a,), width=2)
        d.ellipse([line_to[0] - 5, line_to[1] - 5, line_to[0] + 5, line_to[1] + 5], fill=color + (a,))
    d.rectangle([x, y - 6, x + tw + 36, y + 78], fill=(10, 10, 12, int(150 * alpha)))
    d.rectangle([x, y - 2, x + 6, y + 70], fill=color + (a,))
    d.text((x + 18, y + 34), name, font=nf, fill=PAPER + (a,), anchor='ls')
    d.text((x + 18, y + 66), role, font=rf, fill=SUB + (a,), anchor='ls')

def dashed(d, pts, fill, width=3, dash=14, gap=10, upto=1.0):
    """沿折线画虚线，只画前 upto 比例"""
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); s = 0.0
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        n = 0.0
        while n < L and s + n < tot:
            e = min(n + dash, L, tot - s)
            d.line([(a[0] + (b[0] - a[0]) * n / L, a[1] + (b[1] - a[1]) * n / L),
                    (a[0] + (b[0] - a[0]) * e / L, a[1] + (b[1] - a[1]) * e / L)], fill=fill, width=width)
            n += dash + gap
        s += L
        if s >= tot: break

def poly_upto(pts, upto):
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); out = [pts[0]]; s = 0
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        if s + L >= tot:
            f = (tot - s) / L if L else 0; out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); break
        out.append(b); s += L
    return out

def bez(p0, p1, p2, n=60):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in np.linspace(0, 1, n)]

# ---------------------------------------------------------------- 镜片层
def lens_corners(L, box, grow=1.0, corner=46, width=3):
    d = ImageDraw.Draw(L); x0, y0, x1, y1 = box; c = corner * grow
    for (cx, cy, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(cx, cy + sy * c), (cx, cy)], fill=255, width=width)
        d.line([(cx, cy), (cx + sx * c, cy)], fill=255, width=width)

def lens_label(d, xy, label, alpha):
    if alpha <= 0: return
    f = F(22); tw = d.textlength(label, font=f); x0, y0 = xy; a = int(255 * alpha)
    d.rounded_rectangle([x0, y0, x0 + tw + 28, y0 + 34], 5, fill=(6, 20, 10, int(230 * alpha)), outline=LENS + (a,), width=1)
    d.text((x0 + 14, y0 + 26), label, font=f, fill=LENS + (a,), anchor='ls')

def lens_frame(a, box, alpha, grow=1.0, corner=46):
    """镜框四角（带暗描边，亮背景也看得见）。返回新数组"""
    if alpha <= 0: return a
    L = Image.new('L', (W, H), 0); lens_corners(L, box, grow, corner)
    sh = np.asarray(L.filter(ImageFilter.MaxFilter(5))).astype(np.float32) / 255 * 0.65 * alpha
    a = a * (1 - sh[..., None])
    if alpha < 1: L = L.point(lambda v: v * alpha)
    return glow(a, L, LENS, core=0.95, s1=2, s2=8, k1=0.6, k2=0.3)

def lens_text(a, xy, lines, size, alpha, anchor='la'):
    if alpha <= 0: return a
    L = Image.new('L', (W, H), 0); d = ImageDraw.Draw(L); x, y = xy
    for i, t in enumerate(lines):
        d.text((x, y + i * size * 1.3), t, font=F(size, True) if cjk(t) else E(size, 'demi', cond=False), fill=int(255 * alpha), anchor=anchor)
    return glow(a, L, LENS, core=1.0, s1=1.5, s2=7, k1=0.7, k2=0.35)

def iris(a, box, k, radius=70, blur=40):
    """镜框外压暗：k=压暗程度"""
    if k <= 0: return a
    m = Image.new('L', (W, H), 0); ImageDraw.Draw(m).rounded_rectangle(box, radius, fill=255)
    m = m.resize((W // 4, H // 4), Image.BILINEAR).filter(ImageFilter.GaussianBlur(blur / 4)).resize((W, H), Image.BILINEAR)
    q = np.asarray(m).astype(np.float32) / 255
    return a * (1 - k + k * q)[..., None]

def lerp_box(b0, b1, f): return tuple(x + (y - x) * f for x, y in zip(b0, b1))

def vignette(a, k=0.45):
    y, x = np.ogrid[0:a.shape[0], 0:a.shape[1]]
    r = np.sqrt(((x - a.shape[1] / 2) / (a.shape[1] / 2)) ** 2 + ((y - a.shape[0] / 2) / (a.shape[0] / 2)) ** 2) / 1.414
    return a * (1 - k * r ** 2.2)[..., None]

def band(a, y0, y1, k=0.55):
    yy = np.arange(a.shape[0], dtype=np.float32)
    m = np.clip(1 - np.abs(yy - (y0 + y1) / 2) / ((y1 - y0) / 2 + 60), 0, 1) ** 0.8
    return a * (1 - k * m)[:, None, None]

def shake(t, t0, amp=18, dur=0.7):
    if t < t0 or t > t0 + dur: return (0, 0)
    e = (1 - (t - t0) / dur) ** 2 * amp
    return (e * math.sin(t * 91), e * math.cos(t * 77))

def grain(a, seed, k=0.04):
    r = np.random.default_rng(seed).standard_normal((H // 2, W // 2)).astype(np.float32)
    r = np.repeat(np.repeat(r, 2, 0), 2, 1)
    return a + r[..., None] * k

# ---------------------------------------------------------------- 字幕层（全局，按绝对时间）
def sub_chunks(k):
    """旁白按句读切块，按字数分配时间"""
    t = LINES[k]['zh']; parts, cur = [], ''
    for c in t:
        cur += c
        if c in '。！？；：' or (c == '，' and len(cur) > 16):
            parts.append(cur); cur = ''
    if cur: parts.append(cur)
    tot = sum(len(p) for p in parts); s = T[k]; out = []
    for p in parts:
        dd = DUR[k] * len(p) / tot; out.append((p.rstrip('，。；：'), s, s + dd)); s += dd
    return out

CHUNKS = [(c, a, b) for k, _ in ORDER if k[0] == 'n' and k != 'n20' for c, a, b in sub_chunks(k)]
DIAL = [k for k, _ in ORDER if k[0] == 'd']

def subtitles(a, t, scene):
    ov = rgba(); d = ImageDraw.Draw(ov); need_band = False
    for c, s, e in CHUNKS:
        if scene == 'twin': break
        if s - .1 <= t <= e + .15:
            al = ramp(t, s - .1, s + .08) * (1 - ramp(t, e, e + .15))
            text(d, (W / 2, H - 70), c, 36, PAPER, al, anchor='ms'); need_band = True
    for k in DIAL:
        s, e = T[k], end(k) + .5
        if s - .15 <= t <= e + .2:
            x = LINES[k]; al = ramp(t, s - .15, s + .1) * (1 - ramp(t, e, e + .2))
            y = H - 120 if scene not in ('end',) else H - 330
            who = x['who']; col = JACK if who == 'JACK' else RYAN if who == 'RYAN' else VEX if who == 'VEX' else PAPER
            text(d, (W / 2, y - 48), who, 26, col, al, anchor='ms', bold=True, w='bold')
            text(d, (W / 2, y), '“' + x['zh'] + '”', 46, PAPER, al, anchor='ms', w='med')
            if not (k == 'd_guard'):
                text(d, (W / 2, y + 52), x['cn'], 32, SUB, al, anchor='ms')
            else:
                text(d, (W / 2, y + 52), '（西班牙语）', 28, SUB, al, anchor='ms')
            need_band = True
    if need_band and scene not in ('end', 'twin', 'lost'): a = band(a, H - 200, H, 0.5)
    return over(img(a), ov)

def page_mark(im, t, scene):
    s = next(x for x in SC if x[0] == scene)
    al = ramp(t, s[1] + .3, s[1] + .9) * (1 - ramp(t, s[2] - .6, s[2] - .1))
    if scene in ('open', 'end') or al <= 0: return im
    ov = rgba(); d = ImageDraw.Draw(ov)
    text(d, (W - 40, 54), f'P{s[3]:02d}  {s[4]}', 22, SUB, al * .85, anchor='rs')
    return over(im, ov)

# ---------------------------------------------------------------- 场景
def loc(t, name):
    s = next(x for x in SC if x[0] == name); return (t - s[1]) / (s[2] - s[1]), t - s[1]

def sc_open(t):
    u, lt = loc(t, 'open')
    cam = Cam([(0, 1.04, 960, 520, -10, 0), (1, 1.16, 1000, 470, 14, 0)])
    hud = ramp(t, 2.3, 2.7) * (0.75 + 0.25 * (math.sin(t * 40) > -0.6 if t < 2.8 else 1))
    a, zc = render_bg(None, 4, cam, u, hud=hud)
    a = grade(a, .92, .92)
    f = eo((t - 0.4) / 2.0)
    box = lerp_box((860, 480, 1060, 600), (250, 130, W - 250, H - 230), f)
    a = iris(a, box, 0.97 - 0.19 * f, radius=40 + 30 * f)
    a = lens_frame(a, box, ramp(t, .5, 1.2), grow=0.5 + 0.5 * f)
    a *= ramp(t, 0.15, 0.6)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    lens_label(d, (box[0], box[1] - 44), '眼镜功能 · 导航提示', ramp(t, 1.8, 2.3))
    tt = end('n01') + .2
    al = ramp(t, tt, tt + 1.2)
    if al > 0:
        tracked(d, (W / 2, 104), 'IN SIGHT', E(64, 'ul', cond=False), PAPER, track=0.35 + 0.2 * eo((t - tt) / 2.5), alpha=al)
        text(d, (W / 2, 175), '目 之 所 及', 40, PAPER, ramp(t, tt + .6, tt + 1.6), anchor='ms', bold=True)
    return over(im, ov)

def sc_ray(t):
    u, lt = loc(t, 'ray')
    sh = at('n02', .83)                                   # 快门
    cam = Cam([(0, 1.22, 1360, 380, 16, 0), (0.5, 1.12, 1250, 450, 10, 0), (0.72, 1.12, 1100, 480, 0, 0), (1, 1.18, 640, 500, -14, 0)])
    a, zc = render_bg(None, 2, cam, u); m = mapper(zc)
    a = grade(a, 1.0, .93)
    shot = (1180, 56, 1720, 470)
    pb = (*m(shot[0], shot[1]), *m(shot[2], shot[3]))
    fa = ramp(t, sh - 1.0, sh - .5) * (1 - ramp(t, sh + 2.6, sh + 3.2))
    a = lens_frame(a, pb, fa)
    if sh <= t < sh + .25: a = a + (1 - (t - sh) / .25) * 0.55
    if t >= sh: a = lens_text(a, (pb[0] + 26, pb[3] - 24), ['● 已拍摄'], 26, fa, anchor='ls')
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    lens_label(d, (pb[0], pb[1] - 44), '眼镜功能 · 拍照', fa)
    tag(d, m(1060, 600), 'RAY', '三人共同的老朋友 · 摊主', PAPER, ramp(t, at('n02') + .2, at('n02') + .7) * (1 - ramp(t, at('n03') - .3, at('n03'))), line_to=m(1350, 420))
    tag(d, m(120, 700), 'JACK', '开车的人 · 戴着眼镜', JACK, ramp(t, sh - .2, sh + .3), line_to=m(330, 300))
    tag(d, m(560, 110), 'RYAN', '副驾 · 老战友', RYAN, ramp(t, at('n03') + .1, at('n03') + .6), line_to=m(640, 470))
    im = over(im, ov)
    if t >= sh + .2:                                      # 照片卡从取景框飞到右下
        f = eo((t - sh - .2) / .7)
        ph = img(base(2)[0][shot[1]:shot[3], shot[0]:shot[2]]).resize((380, 292), Image.LANCZOS)
        card = Image.new('RGB', (400, 312), (240, 240, 236)); card.paste(ph, (10, 10))
        sc = 0.55 + 0.45 * f; ang = -4 * f
        card = card.resize((int(400 * sc), int(312 * sc))).rotate(ang, expand=True, resample=Image.BICUBIC)
        mk = Image.new('L', (int(400 * sc), int(312 * sc)), 255).rotate(ang, expand=True)
        al = 1 - ramp(t, at('n03') + 1.5, at('n03') + 2.2)
        mk = mk.point(lambda v: v * al)
        x = pb[0] + (1480 - pb[0]) * f; y = pb[1] + (580 - pb[1]) * f
        im.paste(card, (int(x), int(y)), mk)
    return im

def coast_panel(p, fw):
    """故事层地图面板 700×300；p: 场景内进度驱动绘制；fw: 赌注出现进度列表"""
    w, h = 700, 300; pn = Image.new('RGBA', (w, h), (12, 14, 16, 225)); d = ImageDraw.Draw(pn)
    d.rectangle([0, 0, w - 1, h - 1], outline=PAPER + (90,), width=1)
    mx0 = 300
    d.line([(mx0, 18), (mx0, h - 18)], fill=PAPER + (60,), width=1)
    coast = [(mx0 + 250, 0), (mx0 + 270, 60), (mx0 + 246, 120), (mx0 + 290, 190), (mx0 + 272, 250), (mx0 + 310, h)]
    d.polygon(coast + [(w, h), (w, 0)], fill=(22, 42, 60, 255))
    for k in range(1, 5):
        d.line([(x + k * 10, y) for x, y in coast], fill=(70, 110, 150, 130 - k * 25), width=1)
    d.text((w - 22, h - 20), 'PACIFIC', font=E(18, 'med'), fill=(120, 160, 200, 255), anchor='rs')
    hwy = [(mx0 + 30, h - 10), (mx0 + 90, h - 70), (mx0 + 140, h - 120), (mx0 + 190, 120), (mx0 + 215, 70), (mx0 + 232, 40)]
    d.line(poly_upto(hwy, ramp(p, 0, .25)), fill=(190, 180, 160, 255), width=5, joint='curve')
    d.text((mx0 + 80, h - 110), 'COAST HWY 1', font=E(18, 'demi'), fill=(190, 180, 160, int(255 * ramp(p, .1, .2))), anchor='rm')
    fac = (mx0 + 232, 40); car = (mx0 + 110, h - 98)
    fa = int(255 * ramp(p, .2, .3))
    d.rectangle([fac[0] - 20, fac[1] - 14, fac[0] + 20, fac[1] + 14], outline=PAPER + (fa,), width=3)
    d.text((fac[0] - 30, fac[1]), 'TRITON 研究设施', font=F(18), fill=PAPER + (fa,), anchor='rm')
    ca = int(255 * ramp(p, .05, .12))
    for off, c in [(-8, JACK), (8, RYAN)]:
        d.ellipse([car[0] + off - 8, car[1] - 8, car[0] + off + 8, car[1] + 8], fill=c + (ca,))
    d.text((car[0] + 24, car[1] + 2), 'Jack + Ryan', font=E(20, 'demi'), fill=PAPER + (ca,), anchor='lm')
    va = ramp(p, .25, .55)
    pts = bez((fac[0] - 4, fac[1] + 20), (fac[0] - 150, (fac[1] + car[1]) / 2), (car[0] + 4, car[1] - 12), 40)
    dashed(d, pts, VEX + (255,), width=3, dash=10, gap=7, upto=va)
    d.ellipse([fac[0] + 24, fac[1] - 8, fac[0] + 40, fac[1] + 8], fill=VEX + (int(255 * ramp(p, .2, .3)),))
    d.text((fac[0] + 46, fac[1]), 'VEX', font=E(22, 'bold'), fill=VEX + (int(255 * ramp(p, .2, .3)),), anchor='lm')
    stakes = [('雇佣兵已进入设施', VEX), ('核心资料不能外流', PAPER), ('Vex 要提前爆破', VEX), ('4 人困在下层', RYAN)]
    d.text((24, 40), '今天的局面', font=F(22, True), fill=PAPER + (255,), anchor='ls')
    for i, ((s, c), f) in enumerate(zip(stakes, fw)):
        y = 86 + i * 54; al = int(255 * f)
        d.rectangle([24, y - 14, 30, y + 14], fill=c + (al,)); d.text((44 + 20 * (1 - f), y), s, font=F(24), fill=PAPER + (al,), anchor='lm')
    return pn

def sc_call(t):
    u, lt = loc(t, 'call')
    ring = at('n04')
    hud = ramp(t, ring - .3, ring) * (0.6 + 0.4 * (math.sin(t * 30) > 0) if t < ring + .6 else 1)
    cam = Cam([(0, 1.03, 940, 530, -8, 0), (.35, 1.04, 960, 530, 0, 0), (1, 1.12, 1120, 520, 12, 0)])
    a, zc = render_bg(None, 3, cam, u, hud=hud); m = mapper(zc)
    a = grade(a, .95, .9)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    lx, ly = m(24, 200)
    lens_label(d, (max(lx, 20), ly), '眼镜功能 · 来电（手机协同）', ramp(t, ring, ring + .4) * (1 - ramp(t, end('d_vex1'), end('d_vex1') + .5)))
    im = over(im, ov)
    p0 = at('n05') - .2
    if t > p0:
        p = clamp((t - p0) / (DUR['n05'] * .9))
        fw = [ramp(t, at('n05', f), at('n05', f) + .4) for f in (0.0, 0.22, 0.48, 0.78)]
        pn = coast_panel(p, fw)
        sl = eo((t - p0) / .6); al = sl * (1 - ramp(t, SC[2][2] - .7, SC[2][2] - .2))
        pn.putalpha(pn.getchannel('A').point(lambda v: v * al))
        im.paste(pn, (int(30 - 60 * (1 - sl)), 560), pn)
    return im

def sc_road(t):
    u, lt = loc(t, 'road')
    cam = Cam([(0, 1.12, 980, 470, -8, 0), (1, 1.34, 1050, 440, 22, 0)])
    a, zc = render_bg(None, 4, cam, u, shake=(3 * math.sin(t * 50), 2 * math.cos(t * 43)), hud=1.0)
    a = iris(grade(a, .92, .95), (250, 130, W - 250, H - 230), 0.6)
    a = lens_frame(a, (250, 130, W - 250, H - 230), 1.0)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    lens_label(d, (250, 86), '眼镜功能 · 导航提示', 1.0)
    return over(im, ov)

def sc_jump(t):
    u, lt = loc(t, 'jump')
    fr = at('n07', .40)                                     # “这一刻”定格
    cam = Cam([(0, 1.06, 900, 380, 18, -8), (0.4, 1.14, 900, 450, 26, -10), (1, 1.18, 1000, 560, 10, 0)])
    uu = u if t < fr else loc(fr, 'jump')[0] + (u - loc(fr, 'jump')[0]) * .15
    a, zc = render_bg(None, 5, cam, uu, shake=shake(t, SC[4][1] + .15, 22, .9)); m = mapper(zc)
    fz = ramp(t, fr, fr + .3)
    a = grade(a, .85 - .45 * fz, .95 - .08 * fz)
    if fr <= t < fr + .12: a = a + .35
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    def bracket(box, c, al):
        if al <= 0: return
        x0, y0, x1, y1 = box; k = 30; cc = c + (int(255 * al),)
        for (cx, cy, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
            d.line([(cx, cy), (cx + sx * k, cy)], fill=cc, width=3); d.line([(cx, cy), (cx, cy + sy * k)], fill=cc, width=3)
    b1 = ramp(t, at('n07', .02), at('n07', .1)); b2 = ramp(t, at('n07', .2), at('n07', .28))
    bracket((*m(420, 20), *m(1160, 590)), VEX, b1)
    bracket((*m(820, 620), *m(1390, 905)), JACK, b2)
    x, y = m(1180, 52)
    if b1 > 0:
        d.rectangle([x, y, x + 6, y + 72], fill=VEX + (int(255 * b1),))
        text(d, (x + 20, y + 36), '雇佣兵首领', 32, PAPER, b1, bold=True); text(d, (x + 20, y + 72), '从高位岔道落下，横停堵路', 24, PAPER, b1)
    x, y = m(1410, 640)
    if b2 > 0:
        d.rectangle([x, y, x + 6, y + 72], fill=JACK + (int(255 * b2),))
        text(d, (x + 20, y + 38), 'JACK', 40, PAPER, b2, w='bold'); text(d, (x + 20, y + 72), '短刹 · 转向 · 避让', 24, PAPER, b2)
    im = over(im, ov)
    la = ramp(t, at('n07', .5), at('n07', .58))
    if la > 0:
        box = (1480, 840, 1880, 1020)
        ov = rgba(); ImageDraw.Draw(ov).rounded_rectangle(box, 10, fill=(4, 14, 8, int(200 * la))); im = over(im, ov)
        a = lens_frame(arr(im), box, la, corner=30)
        a = lens_text(a, (1680, 922), ['（无提示）'], 30, la * (0.65 + 0.35 * math.sin(t * 4) ** 2), anchor='mm')
        im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
        lens_label(d, (box[0], box[1] - 44), '镜片此刻', la)
        text(d, (1680, 990), '不预测落点，判断在人', 22, (170, 230, 190), la, anchor='mm')
        im = over(im, ov)
    return im

ARC_BOTTLE = bez((385, 492), (640, 400), (500, 700), 60)     # 在 s06 的坐标（fit 后 zoom 1.25、cx .6 的分屏里定的，这里换算到整幅）

def sc_bottle(t):
    u, lt = loc(t, 'bottle')
    cam = Cam([(0, 1.08, 1100, 560, -10, 0), (1, 1.2, 1180, 580, 12, 0)])
    a, zc = render_bg(None, 6, cam, u); m = mapper(zc)
    a = grade(a, .95, .93)
    arc = bez((1079, 501), (1283, 428), (1171, 668), 60)    # Jack 指尖 → 瓶子 → Ryan 掌心
    pa = ramp(t, at('n08', .15), at('n08', .62))
    L = Image.new('L', (W, H), 0); dd = ImageDraw.Draw(L)
    pts = [m(*p) for p in arc]
    dashed(dd, pts, 255, width=4, dash=10, gap=9, upto=pa)
    pulse = ramp(t, at('n08', .72), at('n08', .78)) * (1 - ramp(t, at('n08', .9), end('n08') + .6))
    a = glow(a, L, JACK, core=1.0 + pulse, s1=2, s2=10, k1=0.8 + pulse, k2=0.5 + pulse)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    if pa >= 1:
        x, y = pts[-1]; d.ellipse([x - 10, y - 10, x + 10, y + 10], outline=RYAN + (255,), width=3)
    al = ramp(t, at('n08', .72), at('n08', .8))
    x, y = m(1300, 330)
    chip(d, (x, y), '抛物线 #1 · 记住它', JACK, 26, al)
    return over(im, ov)

def sc_guard(t):
    u, lt = loc(t, 'guard')
    rv = end('d_guard') - .1                                 # 翻译出现
    cam = Cam([(0, 1.06, 820, 520, -12, 0), (1, 1.14, 700, 560, 10, 0)])
    o, clean, mk = base(7)
    wipe = clamp((t - rv) / 1.0)
    xs = np.arange(W, dtype=np.float32)
    wm = np.clip((50 + 330 * wipe - xs) / 12, 0, 1)[None, :] if wipe > 0 else np.zeros((1, W), np.float32)
    src = clean + (o - clean) * (mk * wm)[..., None]
    a, zc = render_bg(src, 7, cam, u); m = mapper(zc)
    a = grade(a, .95, .9)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    x, y = m(50, 520)
    lens_label(d, (x, y), '眼镜功能 · 翻译', ramp(t, rv, rv + .4))
    x, y = m(56, 670)
    text(d, (x, y), '远程连接断了，钥匙在 Vex 手里。', 26, PAPER, ramp(t, rv + 1.0, rv + 1.5))
    return over(im, ov)

BLUE = [(1668, 186), (1668, 298), (1520, 298), (1405, 288), (1408, 380)]
ORNG = [(1410, 384), (1470, 386), (1475, 450), (1555, 452), (1560, 515), (1640, 522)]

def sc_map(t):
    u, lt = loc(t, 'map')
    s, e = SC[7][1], SC[7][2]; uj = (at('d_jack1') - .3 - s) / (e - s)
    cam = Cam([(0, 1.04, 960, 540, -8, 0), (max(.05, uj - .05), 1.22, 1440, 400, 4, 0), (uj + .12, 1.1, 900, 470, -6, 0), (1, 1.12, 860, 480, 8, 0)])
    a, zc = render_bg(None, 8, cam, u); m = mapper(zc)
    a = grade(a, .92, .9)
    L1 = Image.new('L', (W, H), 0); L2 = Image.new('L', (W, H), 0)
    p = ramp(t, at('n10', .1), end('n10') + .3)
    ImageDraw.Draw(L1).line([m(*q) for q in poly_upto(BLUE, p)], fill=255, width=5, joint='curve')
    ImageDraw.Draw(L2).line([m(*q) for q in poly_upto(ORNG, p)], fill=255, width=5, joint='curve')
    a = glow(a, L1, RYAN, .6, 2, 12, .9, .7); a = glow(a, L2, JACK, .6, 2, 12, .9, .7)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    x, y = m(1290, 740)
    chip(d, (x, y), 'JACK  →  去拿钥匙', JACK, 28, ramp(t, at('d_jack1'), at('d_jack1') + .4))
    chip(d, (x, y + 66), 'RYAN  →  带 4 人撤出', RYAN, 28, ramp(t, at('d_ryan1'), at('d_ryan1') + .4))
    al = ramp(t, at('n11') - .2, at('n11') + .3)
    if al > 0:
        d.rounded_rectangle([44, 140, 440, 420], 10, fill=(10, 10, 12, int(195 * al)))
        text(d, (66, 186), 'Jack 的习惯：每个节点回一句', 24, PAPER, al, bold=True, shadow=False)
        for i, (s_, c) in enumerate([('节点 1　已确认', PAPER), ('节点 2　已确认', PAPER), ('上层终止台　会合', JACK)]):
            y = 244 + i * 56; ai = al * ramp(t, at('n11', .25 + i * .2), at('n11', .25 + i * .2) + .25)
            if ai <= 0: continue
            cc = c + (int(255 * ai),)
            d.ellipse([66, y - 12, 90, y + 12], outline=cc, width=3)
            if i < 2: d.line([(72, y), (77, y + 6), (85, y - 6)], fill=cc, width=3)
            d.text((106, y), s_, font=F(26), fill=cc, anchor='lm')
    return over(im, ov)

def sc_stand(t):
    u, lt = loc(t, 'stand')
    cam = Cam([(0, 1.04, 960, 520, -14, 0), (1, 1.1, 900, 500, 14, 0)])
    a, zc = render_bg(None, 9, cam, u); m = mapper(zc)
    fb = ramp(t, at('n12', .2), at('n12', .27)) * (1 - ramp(t, at('n12', .62), at('n12', .7)))   # 六年前
    a = grade(a, .92 - .85 * fb, .92 - .12 * fb, warm=1.4 * fb)
    if fb > 0: a = grain(a, int(t * 24), .05 * fb); a = vignette(a, .55 * fb)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    ta = ramp(t, at('n12', .02), at('n12', .1)) * (1 - fb)
    tag(d, m(60, 330), 'JACK', '要救下层的 4 个人', JACK, ta, line_to=m(466, 150))
    tag(d, m(1530, 330), 'VEX', '要资料永远不外流', VEX, ta, line_to=m(1344, 160))
    if fb > 0:
        chip(d, (W / 2, 120), '六年前', PAPER, 34, fb, anchor='m', bold=True)
        text(d, (W / 2, 230), '三人一起折返，救回了同伴，却错失了目标', 28, PAPER, fb, anchor='ms')
    # 两个人之间的分歧线
    da = ramp(t, at('d_jack2'), at('d_jack2') + .4)
    if da > 0:
        x, y0 = m(880, 200); _, y1 = m(880, 700)
        dashed(d, [(x, y0), (x, y0 + (y1 - y0) * eo((t - at('d_jack2')) / 1.2))], PAPER + (int(200 * da),), 2, 10, 10)
        chip(d, (x - 30, y0 + 40), '人', JACK, 34, da, anchor='r', bold=True)
        chip(d, (x + 30, y0 + 40), '资料', VEX, 34, ramp(t, at('d_vex2'), at('d_vex2') + .4), bold=True)
    return over(im, ov)

def sc_ham(t):
    u, lt = loc(t, 'ham')
    hit = at('n13', .3)
    cam = Cam([(0, 1.08, 760, 560, -10, 0), (1, 1.18, 700, 600, 10, 0)])
    a, zc = render_bg(None, 10, cam, u, shake=shake(t, hit, 14, .5)); m = mapper(zc)
    a = grade(a, .95, .9)
    if hit <= t < hit + .08: a = a + .25
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    x, y = m(560, 880)
    chip(d, (x, y), '存储模块 · 已毁（由 Ryan 动手）', RYAN, 26, ramp(t, hit + .2, hit + .6))
    return over(im, ov)

def counter(d, xy, n, al, col=RYAN):
    chip(d, xy, f'撤出  {n} / 4', col, 30, al, bold=True)

def sc_evac(t):
    u, lt = loc(t, 'evac')
    cam = Cam([(0, 1.06, 900, 540, -14, 0), (1, 1.14, 1000, 520, 14, 0)])
    a, zc = render_bg(None, 11, cam, u)
    a = grade(a, .9, .9)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    s = SC[10][1]; n = int(clamp((t - s - .4) / 1.6) * 4)
    counter(d, (60, 70), n, ramp(t, s + .2, s + .5))
    if n == 4: text(d, (60, 170), '救人和任务，可以同时成立', 26, PAPER, ramp(t, s + 2.1, s + 2.5))
    return over(im, ov)

def sc_lost(t):
    u, lt = loc(t, 'lost')
    camL = Cam([(0, 1.0, 1000, 540, -10, 0), (1, 1.05, 1000, 540, 10, 0)], 950, H)
    camR = Cam([(0, 1.0, 860, 540, -10, 0), (1, 1.05, 860, 540, 10, 0)], 950, H)
    sl = eo((t - SC[11][1]) / .6)
    aL, _ = render_bg(None, 11, camL, u, w=950, h=H); aR, _ = render_bg(None, 12, camR, u, w=950, h=H)
    a = np.full((H, W, 3), 8 / 255, np.float32)
    a[:, :950] = grade(aL, .8, .85); a[:, 970:] = grade(aR, .95, .92, warm=.5)
    ox = int(950 * (1 - sl)); a[:, 970:] = np.roll(a[:, 970:], ox, axis=1) if ox else a[:, 970:]
    if ox: a[:, 970:970 + ox] = 8 / 255
    br = at('n14', .25); y = 560
    L1 = Image.new('L', (W, H), 0); L2 = Image.new('L', (W, H), 0)
    gap = 0 if t < br else eo((t - br) / .5)
    jit = (math.sin(t * 70) * 6 if br <= t < br + .6 else 0)
    ImageDraw.Draw(L1).line([(300, y), (960 - 60 * gap, y + jit)], fill=255, width=4)
    ImageDraw.Draw(L2).line([(960 + 60 * gap, y - jit), (1640, y)], fill=255, width=4)
    if t < br or int(t * 18) % 3: a = glow(a, L1, RYAN, s2=12)
    a = glow(a, L2, JACK, s2=12)
    a[:, 950:970] = 8 / 255
    if br <= t < br + .5 and int(t * 24) % 2:
        a[y - 40:y + 40] = np.roll(a[y - 40:y + 40], 24, axis=1)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    al = ramp(t, br, br + .3)
    chip(d, (W / 2, y - 92), 'LINK LOST · 耳机受损', VEX, 28, al, anchor='m', fill_a=215, bold=True)
    counter(d, (60, 70), 4, 1.0)
    chip(d, (60, 140), 'Ryan 知道。Jack 不知道。', PAPER, 24, ramp(t, br + .6, br + 1), fill_a=200)
    chip(d, (1030, 70), '没有消息', JACK, 28, ramp(t, br + .3, br + .7), fill_a=200)
    chip(d, (1030, 140), 'Jack 只能选择相信 Ryan 会回来', PAPER, 24, ramp(t, br + 1.0, br + 1.4), fill_a=200)
    return over(im, ov)

def sc_fight(t):
    u, lt = loc(t, 'fight')
    crack = at('n15', .78)
    cam = Cam([(0, 1.06, 960, 520, -14, 0), (1, 1.2, 1040, 560, 16, 0)])
    a, zc = render_bg(None, 12, cam, u, shake=shake(t, crack, 16, .6)); m = mapper(zc)
    a = grade(a, .95, .92, warm=.4)
    ka = ramp(t, at('n15', .45), at('n15', .52))
    L = Image.new('L', (W, H), 0)
    if ka > 0:
        x, y = m(967, 548); r = 46 + 10 * math.sin(t * 6)
        ImageDraw.Draw(L).ellipse([x - r, y - r, x + r, y + r], outline=int(255 * ka), width=3)
        a = glow(a, L, JACK, .9, 2, 8, .7, .4)
    if t > crack: a = a * (1 - .25 * ramp(t, crack, crack + .1) * (1 - ramp(t, crack + .3, crack + .9))) + np.array([.12, 0, 0], np.float32) * ramp(t, crack, crack + .1) * (1 - ramp(t, crack + .3, crack + .9))
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    if ka > 0:
        x, y = m(967, 548); chip(d, (x + 60, y + 30), '钥匙 → Jack', JACK, 26, ka)
    return over(im, ov)

def sc_hang(t):
    u, lt = loc(t, 'hang')
    cam = Cam([(0, 1.1, 900, 380, -12, 0), (1, 1.16, 760, 330, 10, 0)])
    a, zc = render_bg(None, 13, cam, u); m = mapper(zc)
    a = grade(a, .95, .92, warm=.3)
    g = ramp(t, at('n16', .02), at('n16', .1))
    L = Image.new('L', (W, H), 0); dd = ImageDraw.Draw(L)
    if g > 0:
        x, y = m(1062, 296); r = 34
        dd.ellipse([x - r, y - r, x + r, y + r], outline=int(255 * g), width=3)
    # 空出的那只手把钥匙抛向画外（安全平台上的 Ryan）
    p = ramp(t, at('n16', .35), at('n16', .55))
    arc = [m(*q) for q in bez((800, 255), (560, -120), (60, 140), 50)]
    dashed(dd, arc, 255, width=4, dash=10, gap=9, upto=p)
    a = glow(a, L, JACK, 1.0, 2, 10, .8, .5)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    if g > 0:
        x, y = m(1062, 296); chip(d, (x + 50, y - 20), '一只手抓住 Vex', VEX, 24, g)
    return over(im, ov)

def sc_trust(t):
    """看不见：画面收进 Jack 眼前一小块，镜框外全黑——目之所及之外"""
    u, lt = loc(t, 'trust')
    cam = Cam([(0, 1.16, 760, 330, 10, 0), (1, 1.3, 820, 300, 16, 0)])
    a, zc = render_bg(None, 13, cam, u); m = mapper(zc)
    a = grade(a, .7, .85, warm=.3)
    f = eo((t - SC[13][1]) / 1.4)
    x, y = m(840, 200)
    box = lerp_box((0, 0, W, H), (x - 330, y - 170, x + 330, y + 170), f)
    a = iris(a, box, 0.93 * f, radius=60)
    a = lens_frame(a, box, f)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    text(d, (W / 2, H - 200), '目之所及之外', 44, PAPER, ramp(t, at('n16', .66), at('n16', .74)), anchor='ms', bold=True)
    return over(im, ov)

ARC_KEY = bez((975 - 970, 650), (1246 - 970, -179), (1292 - 970, 430), 60)   # 右格坐标（950 宽）

def panel(k, cx, cy, zoom, u, px=6):
    cam = Cam([(0, zoom, cx, cy, -px, 0), (1, zoom, cx, cy, px, 0)], 950, H)
    return render_bg(None, k, cam, u, w=950, h=H)

def sc_catch(t):
    u, lt = loc(t, 'catch')
    cam = Cam([(0, 1.2, 600, 420, -10, 0), (1, 1.26, 640, 400, 10, 0)])
    a, zc = render_bg(None, 14, cam, u); m = mapper(zc)
    a = grade(a, 1, .95)
    # 钥匙的弧（全幅坐标：右格取景 cx .3 zoom 1.25 → 原图 x ≈ (px - 970)/1.25*... 这里直接在全幅里定）
    arc = bez((200, 628), (417, -35), (454, 452), 60)
    p = ramp(t, SC[15][1] - .1, SC[15][1] + .9)
    L = Image.new('L', (W, H), 0); dashed(ImageDraw.Draw(L), [m(*q) for q in arc], 255, 4, 10, 9, upto=p)
    a = glow(a, L, JACK, 1.0, 2, 10, .8, .5)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    if p >= 1:
        x, y = m(*arc[-1]); d.ellipse([x - 12, y - 12, x + 12, y + 12], outline=RYAN + (255,), width=3)
    return over(im, ov)

def sc_twin(t):
    u, lt = loc(t, 'twin')
    s = SC[16][1]; f = eo((t - s) / .7)
    aL, _ = panel(6, 1151, 540, 1.25, u)       # 和静帧 S5 同一取景
    aR, _ = panel(14, 576, 540, 1.25, u)
    a = np.full((H, W, 3), 10 / 255, np.float32)
    a[:, :950] = grade(aL, .95, .92); a[:, 970:] = grade(aR, 1, .95)
    if f < 1: a[:, :950] *= f
    a = band(a, 0, 150, .6); a = band(a, H - 140, H, .5)
    L = Image.new('L', (W, H), 0); dd = ImageDraw.Draw(L)
    arcL = bez((385, 492), (640, 400), (500, 700), 60); arcR = [(x + 970, y) for x, y in ARC_KEY]
    dashed(dd, arcL, 255, 4, 10, 9, upto=ramp(t, s + .3, s + 1.2)); dashed(dd, arcR, 255, 4, 10, 9)
    a = glow(a, L, JACK, 1.0, 2, 10, .8, .5)
    im = img(a); ov = rgba(); d = ImageDraw.Draw(ov)
    al = ramp(t, s + .3, s + .8)
    text(d, (60, 92), '开场｜一瓶饮料', 40, PAPER, al, bold=True); text(d, (60, 136), 'Jack 左手握方向盘，右手抛给 Ryan', 24, PAPER, al)
    text(d, (1030, 92), '高潮｜一把钥匙', 40, PAPER, al, bold=True); text(d, (1030, 136), 'Jack 一手抓住 Vex，空出的手抛给 Ryan', 24, PAPER, al)
    text(d, (W / 2, H - 64), '同一条抛物线，不同的重量。', 44, PAPER, ramp(t, s + .8, s + 1.4), anchor='ms', bold=True)
    return over(im, ov)

def sc_abort(t):
    u, lt = loc(t, 'abort')
    call, key = at('n18', .12), at('n18', .7)
    cam = Cam([(0, 1.06, 900, 520, -12, 0), (.6, 1.12, 1150, 450, 6, 0), (1, 1.2, 1380, 400, 12, 0)])
    a, zc = render_bg(None, 15, cam, u); m = mapper(zc)
    a = grade(a, 1, .92)
    # ABORTED 屏幕脉冲
    pa = ramp(t, key, key + .2)
    if pa > 0:
        L = Image.new('L', (W, H), 0); x, y = m(1470, 381)
        ImageDraw.Draw(L).rounded_rectangle([x - 90 * zc[0], y - 30 * zc[0], x + 90 * zc[0], y + 30 * zc[0]], 6, fill=int(120 * pa * (0.6 + 0.4 * math.sin(t * 8) ** 2)))
        a = glow(a, L, LENS, .2, 3, 16, .6, .6)
    # 联络线重新接上（底部）
    y = 880; rc = ramp(t, call + .3, call + 1.3)
    L1 = Image.new('L', (W, H), 0); L2 = Image.new('L', (W, H), 0)
    ImageDraw.Draw(L1).line([(260, y), (260 + 700 * rc, y)], fill=255, width=4)
    ImageDraw.Draw(L2).line([(1660 - 700 * rc, y), (1660, y)], fill=255, width=4)
    if rc > 0: a = glow(a, L1, RYAN, s2=12); a = glow(a, L2, JACK, s2=12)
    # 镜片小窗：免持通话（这是 Jack 那边的眼镜）
    la = ramp(t, call, call + .4)
    box = (40, 90, 460, 230)
    im = img(a)
    if la > 0:
        ov = rgba(); ImageDraw.Draw(ov).rounded_rectangle(box, 10, fill=(4, 14, 8, int(200 * la))); im = over(im, ov)
        a = lens_frame(arr(im), box, la, corner=28)
        a = lens_text(a, (70, 122), ['RYAN', 'CALL CONNECTED'], 30, la)
        im = img(a)
    ov = rgba(); d = ImageDraw.Draw(ov)
    lens_label(d, (box[0], box[3] + 10), 'Jack 的眼镜 · 免持通话', la)
    if rc >= 1: chip(d, (W / 2, y - 30), 'LINK OK', PAPER, 24, ramp(t, call + 1.3, call + 1.6), anchor='m')
    x, y2 = m(1470, 450)
    chip(d, (x, y2), '设施终止台 · 实体钥匙', PAPER, 24, ramp(t, key + .3, key + .7), anchor='m')
    return over(im, ov)

def sc_end(t):
    u, lt = loc(t, 'end')
    cam = Cam([(0, 1.1, 960, 520, -12, 0), (1, 1.04, 960, 540, 12, 0)])
    a, zc = render_bg(None, 16, cam, u)
    a = vignette(grade(a, .9, .82), .55)
    a = band(a, H - 380, H, .6 * ramp(t, at('d_vex3') - .5, at('d_vex3')))
    tt = at('n20') - 1.0                                 # 镜框收拢
    f = eo((t - tt) / 3.5)
    if t > tt:
        box = lerp_box((0, 0, W, H), (560, 300, 1360, 700), f)
        a = iris(a, box, 0.8 * f, radius=60); a = lens_frame(a, box, ramp(t, tt, tt + 1))
    fo = ramp(t, TOTAL - 1.6, TOTAL - .2)
    im = img(a * (1 - fo)); ov = rgba(); d = ImageDraw.Draw(ov)
    na = ramp(t, end('d_vex3') + .3, end('d_vex3') + .9) * (1 - ramp(t, at('n20') - .6, at('n20')))
    text(d, (W / 2, H - 226), '（ Jack 看向他，没有回答 ）', 26, (210, 202, 190), na, anchor='ms')
    n20 = [(c, s, e) for c, s, e in sub_chunks('n20')]
    for c, s, e in n20:
        al = ramp(t, s - .1, s + .2) * (1 - ramp(t, end('n20') + 1.0, end('n20') + 1.6))
        y = 470 if s == n20[0][1] else 560
        text(d, (W / 2, y), c, 40, PAPER, al * (1 - fo), anchor='ms', bold=True)
    ta = ramp(t, end('n20') + 1.7, end('n20') + 2.9) * (1 - fo)
    if ta > 0:
        tracked(d, (W / 2, 520), 'IN SIGHT', E(72, 'reg', cond=False), PAPER, track=0.45 + 0.1 * ta, alpha=ta)
        text(d, (W / 2, 590), '目 之 所 及', 36, PAPER, ta, anchor='ms', bold=True)
    im = over(im, ov)
    if ta > 0:
        logo = Image.open(SRC + 'rokid_logo.png').convert('L').resize((190, 50), Image.LANCZOS)
        im.paste((236, 236, 236), (W // 2 - 95, 650), logo.point(lambda v: v * ta))
    return im

SCENES = {n: globals()['sc_' + n] for n, *_ in SC}

def frame(i):
    t = i / FPS
    act = [s for s in SC if s[1] - XF / 2 <= t < s[2] + XF / 2]
    if not act: act = [SC[-1]]
    ims = []
    for s in act:
        im = SCENES[s[0]](t)
        w = 1.0
        if len(act) > 1:
            if s is act[0]: w = 1 - ramp(t, s[2] - XF / 2, s[2] + XF / 2)
            else: w = ramp(t, s[1] - XF / 2, s[1] + XF / 2)
        ims.append((im, w))
    if len(ims) == 1: im = ims[0][0]
    else: im = Image.blend(ims[0][0], ims[1][0], clamp(ims[1][1]))
    cur = act[-1][0] if len(act) == 1 or ims[1][1] > .5 else act[0][0]
    if cur != 'end' or t < at('n20') - 1: im = subtitles(arr(im), t, cur)
    im = page_mark(im, t, cur)
    return im

def render(i):
    fn = OUT + f'frames/{i:05d}.jpg'
    if os.path.exists(fn): return
    frame(i).save(fn, quality=92)

# ---------------------------------------------------------------- 声音
SR = 44100
def rd(fn):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', fn, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()

def sfx(kind):
    t = np.arange(int(SR * 1.2)) / SR; r = np.random.default_rng(len(kind))
    if kind == 'chime':
        x = np.zeros_like(t)
        for k, f in enumerate((1320, 1760)):
            s = int(SR * .09 * k); n = int(SR * .18); tt = np.arange(n) / SR
            x[s:s + n] += np.sin(2 * np.pi * f * tt) * np.exp(-tt * 18) * .25
        return x[:int(SR * .4)]
    if kind == 'shutter':
        n = r.standard_normal(int(SR * .12)); e = np.exp(-np.arange(len(n)) / SR * 60)
        x = np.concatenate([n * e * .5, np.zeros(int(SR * .03)), n[:int(SR * .06)] * e[:int(SR * .06)] * .35]); return x
    if kind == 'buzz':
        tt = np.arange(int(SR * 1.1)) / SR; g = ((tt % .5) < .32).astype(float)
        return np.sign(np.sin(2 * np.pi * 170 * tt)) * g * .06 * np.sin(2 * np.pi * 9 * tt) ** 2
    if kind == 'impact':
        tt = np.arange(int(SR * 1.2)) / SR
        x = np.sin(2 * np.pi * (70 * tt - 15 * tt ** 2)) * np.exp(-tt * 4) * .7
        x += r.standard_normal(len(tt)) * np.exp(-tt * 14) * .25; return x
    if kind == 'whoosh':
        n = r.standard_normal(int(SR * .7)); n = np.convolve(n, np.ones(40) / 40, 'same')
        e = np.sin(np.pi * np.arange(len(n)) / len(n)) ** 2; return n * e * .5
    if kind == 'glitch':
        n = r.standard_normal(int(SR * .6)); g = (r.random(len(n) // 400 + 1) > .45).repeat(400)[:len(n)]
        return np.round(n * g * 4) / 4 * .18
    if kind == 'connect':
        x = np.zeros(int(SR * .5))
        for k, f in enumerate((880, 1320)):
            s = int(SR * .12 * k); tt = np.arange(int(SR * .15)) / SR
            x[s:s + len(tt)] += np.sin(2 * np.pi * f * tt) * np.exp(-tt * 10) * .22
        return x
    if kind == 'beep':
        x = np.zeros(int(SR * .9))
        for k in range(3):
            s = int(SR * .25 * k); tt = np.arange(int(SR * .12)) / SR
            x[s:s + len(tt)] += np.sin(2 * np.pi * 1000 * tt) * .12
        return x
    if kind == 'hammer':
        tt = np.arange(int(SR * .5)) / SR
        return (r.standard_normal(len(tt)) * np.exp(-tt * 30) * .5 + np.sin(2 * np.pi * 120 * tt) * np.exp(-tt * 20) * .5)
    raise ValueError(kind)

SFX = [('chime', 1.9), ('chime', 2.3), ('shutter', at('n02', .83)), ('chime', at('n02', .83) - 1.0), ('buzz', at('n04') - .4),
       ('chime', at('n04')), ('chime', at('n05') - .2), ('whoosh', SC[4][1]), ('impact', SC[4][1] + .15), ('chime', at('n07', .5)),
       ('whoosh', at('n08', .15)), ('chime', end('d_guard') - .1), ('chime', at('d_jack1')), ('chime', at('d_ryan1')),
       ('hammer', at('n13', .3)), ('glitch', at('n14', .25)), ('impact', at('n15', .78)), ('whoosh', at('n16', .35)),
       ('whoosh', SC[15][1] - .1), ('chime', at('n18', .12)), ('connect', at('n18', .12) + 1.2), ('beep', at('n18', .7))]

def music_bed(n):
    """按幕铺音乐：开场轻快 → 紧张 → 高潮 → 收尾钢琴。缺哪段就用已有的顶上"""
    def get(*names):
        for nm in names:
            if os.path.exists(MUS + nm): return rd(MUS + nm)
        return None
    cues = [(0.0, at('n04') - 1.0, get('open_s7.wav', 'tension_s7.wav'), .55),
            (at('n04') - 1.0, at('n12') - .5, get('tension_long_s9.wav', 'tension_s7.wav'), .6),
            (at('n12') - .5, at('n15') - .8, get('tension_s8.wav', 'tension_s7.wav'), .55),
            (at('n15') - .8, at('n19') - .5, get('climax_s7.wav', 'tension_s8.wav'), .6),
            (at('n19') - .5, TOTAL, get('ending_s7.wav'), .7)]
    out = np.zeros(n, np.float32); xf = int(SR * 1.5)
    for s, e, x, g in cues:
        if x is None: continue
        a, b = int(s * SR), min(n, int(e * SR) + xf)
        L = b - a
        if len(x) < L:                                   # 不够长：循环，接缝交叉淡化
            reps = []; pos = 0
            while sum(len(r) for r in reps) < L + xf: reps.append(x)
            y = reps[0].copy()
            for r_ in reps[1:]:
                f = np.linspace(0, 1, xf); y[-xf:] = y[-xf:] * (1 - f) + r_[:xf] * f; y = np.concatenate([y, r_[xf:]])
            x = y
        seg = x[:L].copy() * g
        f = np.linspace(0, 1, min(xf, L)); seg[:len(f)] *= f; seg[-len(f):] *= f[::-1]
        out[a:b] += seg
    return out

def drive_bed(n):
    """公路段的车声：引擎（转速曲线驱动的谐波+点火颗粒）、路噪、两次刹车/转向轮胎尖叫。只在开车的段落出现"""
    from scipy.signal import butter, sosfilt
    tt = np.arange(n) / SR
    J0, R0, B0, B1 = SC[4][1], SC[3][1], SC[5][1], SC[5][2]
    fr = at('n07', .40)
    keys = [(0.0, 2200, 0), (0.5, 2200, 0), (1.6, 2300, 1.4), (2.5, 2350, 1.0), (8.8, 2450, 1), (10.4, 1300, .75), (11.6, 850, .3), (14.0, 850, 0),
            (R0 - .4, 2600, 0), (R0, 2900, 1.0), (J0, 5200, 1.15), (J0 + .35, 5200, 1.15), (J0 + 1.4, 2200, .85),
            (at('n07', .26), 2500, .85), (at('n07', .36), 4400, 1.05), (fr, 4600, 1.05), (fr + .4, 4300, .32), (B0 - .3, 3600, .32),
            (B0 + .2, 3300, .8), (B1 - .6, 3400, .8), (B1 + .4, 3300, 0), (TOTAL, 800, 0)]
    kt = np.array([k[0] for k in keys]); rpm = np.interp(tt, kt, [k[1] for k in keys]); g = np.interp(tt, kt, [k[2] for k in keys])
    on = g > 0
    eng = np.zeros(n, np.float32)
    if on.any():
        i0, i1 = np.argmax(on), n - np.argmax(on[::-1])
        r = np.random.default_rng(3); seg = slice(max(0, i0 - SR), min(n, i1 + SR))
        f = rpm[seg] / 60 * 2                                  # 四缸：每转两次点火
        ph = np.cumsum(2 * np.pi * f / SR) + np.cumsum(r.standard_normal(len(f))) * 2e-4
        x = np.zeros(len(f))
        for k, amp in enumerate([1, .7, .55, .35, .28, .18, .12, .08], 1):
            x += amp * np.sin(k * ph + k * .7)
        rough = 1 + .25 * np.sin(ph / 2) + .1 * r.standard_normal(len(f))         # 点火不均匀
        x *= rough
        x += sosfilt(butter(2, [80, 600], 'band', fs=SR, output='sos'), r.standard_normal(len(f))) * .6   # 进气/排气噪
        x = sosfilt(butter(3, 1100, 'low', fs=SR, output='sos'), x)                 # 车厢里听到的闷感
        road = sosfilt(butter(2, [40, 700], 'band', fs=SR, output='sos'), r.standard_normal(len(f))) * (rpm[seg] / 4000) * 1.6
        eng[seg] = (x / 6 + road * .35) * g[seg]
    out = eng * 0.24
    def squeal(dur, f0, amp):
        m = int(dur * SR); t = np.arange(m) / SR; r = np.random.default_rng(int(f0))
        fm = f0 + 90 * np.sin(2 * np.pi * 6.5 * t) + np.cumsum(r.standard_normal(m)) * .05
        tone = np.sin(np.cumsum(2 * np.pi * fm / SR)) * .5 + np.sin(np.cumsum(2 * np.pi * fm * 1.51 / SR)) * .2
        hiss = sosfilt(butter(2, [1800, 5200], 'band', fs=SR, output='sos'), r.standard_normal(m)) * .9
        env = np.minimum(1, t / .05) * np.minimum(1, (dur - t) / .35) * (.8 + .2 * np.sin(2 * np.pi * 11 * t))
        return (tone + hiss) * env * amp
    for t0, dur, f0, amp in [(J0 + .45, 1.3, 1150, .16), (at('n07', .27), .75, 1320, .12)]:
        x = squeal(dur, f0, amp); a = int(t0 * SR); out[a:a + len(x)] += x[:n - a]
    return out

def audio():
    n = int(TOTAL * SR); vo = np.zeros(n, np.float32); fx = np.zeros(n, np.float32)
    for k, _ in ORDER:
        x = rd(VO + f'wav/{k}.wav'); a = int(T[k] * SR); vo[a:a + len(x)] += x[:n - a] * (1.0 if k[0] == 'n' else 1.05)
    for kind, t0 in SFX:
        x = sfx(kind); a = int(t0 * SR); fx[a:a + len(x)] += x[:n - a]
    fx += drive_bed(n)
    mu = music_bed(n)
    # 旁白下压音乐（平滑包络）
    env = np.abs(vo); k = int(SR * .25)
    env = np.convolve(env, np.ones(k) / k, 'same'); duck = 1 - 0.55 * np.clip(env / (env.max() * .15 + 1e-6), 0, 1)
    mix = vo + fx * .8 + mu * duck
    mix = mix / (np.abs(mix).max() + 1e-6) * .89
    import wave
    w = wave.open(OUT + 'mix.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes()); w.close()

def srt():
    def ts(x): h, r = divmod(x, 3600); m_, s = divmod(r, 60); return f'{int(h):02d}:{int(m_):02d}:{int(s):02d},{int((s % 1) * 1000):03d}'
    items = [(s, e, c) for c, s, e in CHUNKS] + [(T[k], end(k) + .4, f"{LINES[k]['zh']}\n{LINES[k].get('cn', '')}") for k in DIAL]
    items += [(s, e, c) for c, s, e in sub_chunks('n20')]
    items.sort()
    open(P + 'IN_SIGHT_目之所及_故事介绍.srt', 'w').write('\n'.join(f'{i + 1}\n{ts(s)} --> {ts(e)}\n{c}\n' for i, (s, e, c) in enumerate(items)))

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(OUT + 'frames', exist_ok=True)
    print(f'总长 {TOTAL:.1f}s，{int(TOTAL * FPS)} 帧')
    if '--from' in sys.argv:
        a = float(sys.argv[sys.argv.index('--from') + 1]); b = float(sys.argv[sys.argv.index('--to') + 1])
        idx = range(int(a * FPS), int(b * FPS))
    else: idx = range(int(TOTAL * FPS))
    if '--still' in sys.argv:                              # 抽检单帧：--still 12.5,40,80
        for s in sys.argv[sys.argv.index('--still') + 1].split(','):
            frame(int(float(s) * FPS)).save(OUT + f'check_{float(s):06.1f}.jpg', quality=88); print('ok', s)
        sys.exit()
    if cmd in ('frames', 'all'):
        with Pool(14) as p:
            for j, _ in enumerate(p.imap_unordered(render, idx, chunksize=8)):
                if j % 240 == 0: print('帧', j, flush=True)
    if cmd in ('audio', 'all'): audio(); srt(); print('audio ok')
    if cmd in ('mux', 'all'):
        out = P + 'IN_SIGHT_目之所及_故事介绍.mp4'
        # 两遍响度：先量，再按测量值线性归一（单遍会偏到 -16 LUFS、峰值贴 0）
        r = subprocess.run(['ffmpeg', '-i', OUT + 'mix.wav', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
        J = json.loads(r[r.rindex('{'):r.rindex('}') + 1])
        ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={J['input_i']}:measured_TP={J['input_tp']}:measured_LRA={J['input_lra']}"
              f":measured_thresh={J['input_thresh']}:offset={J['target_offset']}:linear=true,aresample=44100")
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', OUT + 'frames/%05d.jpg', '-i', OUT + 'mix.wav',
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                        '-af', ln, '-shortest', '-movflags', '+faststart', out], check=True)
        print('ok', out)
