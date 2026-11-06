"""《乐奇AR · 她的舞蹈导师》故事介绍片 · 成片
风格：Lemo-Opuscar「体育战术板 Telestrator」借来讲舞蹈——先看动作，再定格、在原图上画：
  黄 = 她；青 = 老师和生活里的动作来源；粉笔白 = 中性标注；眼镜视角永远装在香槟色镜框里。
节奏：全片 90 BPM 网格（一小节 2.667 秒），每一刀都落在拍点上；Music3 分段配乐统一拉到 90 BPM 再对齐小节。
转场按 PPT 第 12 页：平面进入空间 / 脚步穿过场景 / 白布接回舞房。
用法：python build.py [frames|audio|mux|all] [--still t1,t2] [--from a --to b]
"""
import os, sys, json, math, subprocess
from functools import lru_cache
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

P = os.path.expanduser('~/Desktop/她的舞蹈导师/')
SRC, DEP, VO, OUT, MUS = P + '素材/img/', P + 'depth/', P + '配音/', P + 'film/out/', P + '音乐/'
NAME = '乐奇AR_她的舞蹈导师_故事介绍'
W, H, FPS = 1920, 1080, 24
BPM = 90; BEAT = 60 / BPM; BAR = 4 * BEAT
def tb(bar, beat=0.0): return (bar + beat / 4) * BAR

YEL, CYN, CHALK, RED = (255, 212, 0), (63, 216, 255), (244, 241, 232), (255, 59, 48)
LENS = (240, 214, 168); INK = (8, 12, 14)
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
AVC = '/System/Library/Fonts/Avenir Next Condensed.ttc'
MENLO = '/System/Library/Fonts/Menlo.ttc'

LINES = {x['id']: x for x in json.load(open(VO + 'lines.json'))}
DUR = json.load(open(VO + 'wav/dur.json'))
# 旁白落点：(小节, 拍)
VOAT = {'n01': (4, 1), 'n02': (6, 2), 'n03': (8, 1), 'n04': (10, 2), 'n05': (16, 0), 'n06': (20, 0), 'n07': (22, 1),
        'n08': (24, 1), 'n09': (28, 0), 'n10': (32, 0), 'n11': (37, 0), 'n12': (42, 0),
        'm1': (46, 1), 'm2': (47, 1), 'm3': (48, 1), 'm4': (49, 1), 'n14': (50, 1), 'n15': (54, 1), 'n16': (56, 1)}
T = {k: tb(*v) for k, v in VOAT.items()}
TOTAL = tb(61)

def F(size, bold=True): return ImageFont.truetype(HIRA, size, index=1 if bold else 0)
def E(size, w='demi'): return ImageFont.truetype(AVC, size, index={'bold': 0, 'demi': 2, 'med': 5, 'heavy': 8}[w])
def MONO(size): return ImageFont.truetype(MENLO, size, index=1)
F = lru_cache(None)(F); E = lru_cache(None)(E); MONO = lru_cache(None)(MONO)
def cjk(t): return any(ord(c) > 0x2E7F for c in t)

def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ss(x): x = clamp(x); return x * x * (3 - 2 * x)
def ramp(t, a, b): return ss((t - a) / (b - a)) if b > a else float(t >= a)
def eo(x): x = clamp(x); return 1 - (1 - x) ** 3
def lerp(a, b, f): return a + (b - a) * f

# ---------------------------------------------------------------- 素材
def fit(im, w=W, h=H):
    s = max(w / im.width, h / im.height)
    im = im.resize((math.ceil(im.width * s), math.ceil(im.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))

@lru_cache(None)
def base(k):
    """1920×1080 float；原图只有 830 宽，放大后做一道轻锐化"""
    im = fit(Image.open(SRC + k).convert('RGB')).filter(ImageFilter.UnsharpMask(2.2, 55, 2))
    return np.asarray(im).astype(np.float32) / 255

@lru_cache(None)
def depth(k):
    d = Image.fromarray(np.asarray(Image.open(DEP + k.split('.')[0] + '_depth.png')).astype(np.float32), 'F')
    a = np.asarray(fit(d)).astype(np.float32)
    a = (a - np.percentile(a, 2)) / (np.percentile(a, 98) - np.percentile(a, 2) + 1e-6)
    return ndi.gaussian_filter(np.clip(a, 0, 1), 3)

def img(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def arr(im): return np.asarray(im.convert('RGB')).astype(np.float32) / 255

# ---------------------------------------------------------------- 2.5D 相机
class Cam:
    """keys: [(u, z, cx, cy)]；px/py 视差幅度"""
    def __init__(self, keys, px=14, py=4): self.keys, self.px, self.py = keys, px, py
    def at(self, u, w=W, h=H):
        ks = self.keys
        if u <= ks[0][0]: v = ks[0][1:]
        elif u >= ks[-1][0]: v = ks[-1][1:]
        else:
            for a, b in zip(ks, ks[1:]):
                if a[0] <= u <= b[0]:
                    f = ss((u - a[0]) / (b[0] - a[0])); v = [x + (y - x) * f for x, y in zip(a[1:], b[1:])]; break
        z, cx, cy = v
        hw, hh = w / (2 * z), h / (2 * z); m = 4 + self.px + self.py
        return z, clamp(cx, hw + m, W - hw - m), clamp(cy, hh + m, H - hh - m)

def render_bg(k, z, cx, cy, u, px, py, w=W, h=H):
    src = base(k); D = depth(k)
    v, uu = np.mgrid[0:h, 0:w].astype(np.float32)
    x0 = (uu - w / 2) / z + cx; y0 = (v - h / 2) / z + cy
    xi = np.clip(x0.astype(np.int32), 0, W - 1); yi = np.clip(y0.astype(np.int32), 0, H - 1)
    d = D[yi, xi] - 0.5
    sx, sy = px * (u - .5) * 2, py * (u - .5) * 2           # 近景随进度横移 → 视差
    xs = x0 + sx * d / z; ys = y0 + sy * d / z
    out = np.empty((h, w, 3), np.float32)
    for c in range(3): out[..., c] = ndi.map_coordinates(src[..., c], [ys, xs], order=1, mode='nearest')
    return out

def mapper(z, cx, cy, w=W, h=H, ox=0):
    return lambda x, y: ((x - cx) * z + w / 2 + ox, (y - cy) * z + h / 2)

# ---------------------------------------------------------------- 画面处理
def grade(a, sat=1.0, cool=0.0, bright=1.0):
    g = a.mean(2, keepdims=True); a = g + (a - g) * sat
    if cool: a = a + np.array([-.025, 0, .03], np.float32) * cool
    return a * bright

def vignette(a, k=0.35):
    h, w = a.shape[:2]; y, x = np.ogrid[0:h, 0:w]
    r = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2) / 1.414
    return a * (1 - k * r ** 2.2)[..., None]

def grain(a, seed, k=0.012):
    r = np.random.default_rng(seed).standard_normal((H // 2, W // 2)).astype(np.float32)
    return a + np.repeat(np.repeat(r, 2, 0), 2, 1)[..., None] * k

def glow_on(a, L, color, k1=.8, k2=.45, s1=2.0, s2=10):
    m = np.asarray(L).astype(np.float32) / 255
    if m.max() == 0: return a
    sm = np.asarray(L.resize((W // 4, H // 4), Image.BILINEAR)).astype(np.float32) / 255
    up = lambda x: np.asarray(Image.fromarray(x.astype(np.float32)).resize((W, H), Image.BILINEAR))
    g = up(ndi.gaussian_filter(sm, s1 / 4 + .5)) * k1 + up(ndi.gaussian_filter(sm, s2 / 4)) * k2
    return a + g[..., None] * (np.array(color, np.float32) / 255)

def spotlight(a, cx, cy, rx, ry, k):
    if k <= 0: return a
    y, x = np.ogrid[0:H, 0:W]; r = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    m = np.clip((r - 1) / .25, 0, 1)
    return a * (1 - k * .58 * m)[..., None]

# ---------------------------------------------------------------- 马克笔层
def poly_upto(pts, upto):
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); out = [pts[0]]; s = 0
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        if s + L >= tot:
            f = (tot - s) / L if L else 0; out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); break
        out.append(b); s += L
    return out

def dash_pieces(pts, upto, dash=22, gap=14):
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); s = 0.0; out = []
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        n = 0.0
        while n < L and s + n < tot:
            e = min(n + dash, L, tot - s)
            out.append([(a[0] + (b[0] - a[0]) * n / L, a[1] + (b[1] - a[1]) * n / L), (a[0] + (b[0] - a[0]) * e / L, a[1] + (b[1] - a[1]) * e / L)])
            n += dash + gap
        s += L
    return out

def bez(p0, p1, p2, n=48):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in np.linspace(0, 1, n)]

class Ink:
    """一层 RGBA 画笔 + 每种颜色一张发光掩码"""
    def __init__(self):
        self.ov = Image.new('RGBA', (W, H), (0, 0, 0, 0)); self.d = ImageDraw.Draw(self.ov); self.gl = {}
    def g(self, col):
        if col not in self.gl: self.gl[col] = Image.new('L', (W, H), 0)
        return ImageDraw.Draw(self.gl[col])
    def line(self, pts, col, w=7, upto=1.0, dash=False, arrow=False, alpha=1.0):
        if upto <= 0 or alpha <= 0 or len(pts) < 2: return
        A = int(255 * alpha)
        pieces = dash_pieces(pts, upto) if dash else [poly_upto(pts, upto)]
        for p in pieces:
            if len(p) < 2: continue
            self.d.line(p, fill=(0, 0, 0, int(140 * alpha)), width=w + 6, joint='curve')
        for p in pieces:
            if len(p) < 2: continue
            self.d.line(p, fill=col + (A,), width=w, joint='curve')
            self.d.line(p, fill=(255, 255, 255, int(170 * alpha)), width=max(1, int(w * .28)))
            self.g(col).line(p, fill=A, width=w)
        if arrow and upto > .88:
            q = poly_upto(pts, upto); (x0, y0), (x1, y1) = q[-2] if len(q) > 1 else q[0], q[-1]
            if len(q) > 2: x0, y0 = q[max(0, len(q) - 4)]
            ang = math.atan2(y1 - y0, x1 - x0); s = w * 3.4 * eo((upto - .88) / .12)
            tri = [(x1 + math.cos(ang) * s * .6, y1 + math.sin(ang) * s * .6),
                   (x1 + math.cos(ang + 2.5) * s, y1 + math.sin(ang + 2.5) * s), (x1 + math.cos(ang - 2.5) * s, y1 + math.sin(ang - 2.5) * s)]
            self.d.polygon(tri, fill=col + (A,), outline=(0, 0, 0, int(140 * alpha))); self.g(col).polygon(tri, fill=A)
    def ring(self, c, r, col, upto=1.0, t=0.0, alpha=1.0, w=6):
        if upto <= 0 or alpha <= 0: return
        ry = r * .36; n = 72
        pts = [(c[0] + r * math.cos(-math.pi / 2 + 2 * math.pi * i / n), c[1] + ry * math.sin(-math.pi / 2 + 2 * math.pi * i / n)) for i in range(n + 1)]
        self.line(pts, col, w, upto, alpha=alpha)
        if upto >= 1:                                       # 外圈虚线，转起来
            ph = t * 60 / max(r, 1); m = 24
            for i in range(m):
                if i % 2: continue
                a0 = ph + 2 * math.pi * i / m; a1 = a0 + 2 * math.pi / m * .9
                seg = [(c[0] + r * 1.18 * math.cos(a), c[1] + ry * 1.18 * math.sin(a)) for a in np.linspace(a0, a1, 5)]
                self.d.line(seg, fill=col + (int(200 * alpha),), width=3)
    def dot(self, c, r, col, alpha=1.0):
        if alpha <= 0: return
        self.d.ellipse([c[0] - r - 3, c[1] - r - 3, c[0] + r + 3, c[1] + r + 3], fill=(0, 0, 0, int(140 * alpha)))
        self.d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=col + (int(255 * alpha),))
        self.g(col).ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=int(255 * alpha))
    def label(self, xy, zh, en, col, alpha=1.0, size=40, anchor='l'):
        """黑卡 + 角色色左条 + 中文一行 + 小号英文"""
        if alpha <= 0: return
        d = self.d; f = F(size); fe = E(21, 'demi')
        tw = max(d.textlength(zh, font=f), d.textlength(en, font=fe) + len(en) * 2)
        x, y = xy
        if anchor == 'r': x -= tw + 48
        if anchor == 'm': x -= (tw + 48) / 2
        x = clamp(x, 30, W - tw - 78); y = clamp(y, 130, H - size - 190)
        x += (1 - eo(alpha)) * -24; A = int(255 * alpha)
        hh = size + 46
        d.rectangle([x, y, x + tw + 48, y + hh], fill=INK + (int(225 * alpha),))
        d.rectangle([x, y, x + 7, y + hh], fill=col + (A,))
        d.text((x + 26, y + 8 + size * .88), zh, font=f, fill=CHALK + (A,), anchor='ls')
        cx = x + 26
        for ch in en:
            d.text((cx, y + hh - 10), ch, font=fe, fill=col + (A,), anchor='ls'); cx += d.textlength(ch, font=fe) + 2
    def compose(self, a):
        for col, L in self.gl.items(): a = glow_on(a, L, col, .5, .35)
        im = Image.alpha_composite(img(a).convert('RGBA'), self.ov).convert('RGB')
        return arr(im)

# ---------------------------------------------------------------- 镜框（眼镜视角）
def lens(a, t, t0, tag, sub='AR内容应用构想', box=(70, 150, W - 70, H - 170)):
    al = ramp(t, t0, t0 + .25)
    if al <= 0: return a
    L = Image.new('L', (W, H), 0); d = ImageDraw.Draw(L); x0, y0, x1, y1 = box; c = 54 * (0.7 + 0.3 * eo((t - t0) / .3))
    for (cx, cy, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(cx, cy + sy * c), (cx, cy), (cx + sx * c, cy)], fill=int(255 * al), width=3)
    sh = np.asarray(L.filter(ImageFilter.MaxFilter(5))).astype(np.float32) / 255 * .5
    a = glow_on(a * (1 - sh[..., None]), L, LENS, .6, .3)
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0)); dd = ImageDraw.Draw(ov); A = int(255 * al)
    f = F(24, False); tw = dd.textlength(tag, font=f)
    dd.rounded_rectangle([x0 + 18, y0 + 18, x0 + 50 + tw, y0 + 58], 6, fill=(20, 16, 10, int(200 * al)), outline=LENS + (A,), width=1)
    dd.text((x0 + 34, y0 + 47), tag, font=f, fill=LENS + (A,), anchor='ls')
    if sub: dd.text((x0 + 22, y0 + 88), sub, font=F(19, False), fill=(200, 196, 186, int(200 * al)), anchor='ls')
    return arr(Image.alpha_composite(img(a).convert('RGBA'), ov))

# ---------------------------------------------------------------- 镜头表
class Shot:
    def __init__(self, k, b0, b1, cam, ov=None, freezes=(), lens=None, px=14, py=4, spot=None):
        self.k, self.s, self.e, self.cam, self.ov = k, tb(b0), tb(b1), cam, ov
        self.fr = [(tb(a), tb(b)) for a, b in freezes]; self.lens, self.px, self.py, self.spot = lens, px, py, spot
    def live(self, t):
        """去掉定格时长后的有效时间 → 相机进度 u"""
        tot = sum(b - a for a, b in self.fr); lt = t - self.s
        for a, b in self.fr:
            if t > a: lt -= min(t, b) - a
        return clamp(lt / max(self.e - self.s - tot, 1e-3))
    def frozen(self, t):
        for a, b in self.fr:
            if a <= t < b: return a, b
        return None

def pulse(t, b0, b1):
    """b0..b1 小节内，每拍一个 0→1 衰减脉冲"""
    if not (tb(b0) <= t < tb(b1)): return 0.0
    x = ((t - tb(b0)) / BEAT) % 1
    return (1 - x) ** 3

def beatno(t): return int(t / BEAT + 1e-6)

# ---- 各镜头标注（M：原图坐标→屏幕；u 进度；t 绝对时间；ink 画笔）
def ov_open(S, t, M, ink):
    d = ink.d
    for i, (txt, f, col, y, bt) in enumerate([('乐奇AR', F(64), YEL, 420, 1.0), ('成为她的舞蹈导师', F(104), CHALK, 560, 1.5),
                                               ('突破瓶颈，找到创新', F(40, False), (220, 216, 206), 650, 2.25)]):
        al = ramp(t, tb(bt), tb(bt) + .3) * (1 - ramp(t, tb(3.5), tb(3.9)))
        if al > 0: d.text((130 + (1 - eo(al)) * -30, y), txt, font=f, fill=col + (int(255 * al),), anchor='ls')
    al = ramp(t, tb(2.5), tb(2.7)) * (1 - ramp(t, tb(3.5), tb(3.9)))
    d.text((134, 730), '舞蹈创意短片提案', font=F(24, False), fill=(190, 186, 176, int(220 * al)), anchor='ls')
    d.rectangle([130, 452, 130 + 520 * eo((t - tb(1.25)) / .5), 458], fill=YEL + (int(255 * al),))

def ov_tv(S, t, M, ink):
    u = ramp(t, tb(4, 2), tb(5))
    ink.ring(M(1380, 700), 150, CYN, u, t, alpha=1 - ramp(t, tb(5.6), tb(6)))
    ink.label((M(1380, 700)[0] - 120, 830), '屏幕里的老师', 'ON SCREEN · FLAT', CYN, ramp(t, tb(5), tb(5) + .3) * (1 - ramp(t, tb(5.75), tb(6))))

def ov_stuck(S, t, M, ink):
    f0 = tb(8)
    ink.ring(M(370, 1000), 190, YEL, ramp(t, f0 + .1, f0 + .5), t)
    ink.ring(M(1700, 428), 70, CYN, ramp(t, f0 + .35, f0 + .7), t)
    ink.line([M(470, 930), M(1100, 640), M(1620, 440)], CHALK, 5, ramp(t, f0 + .6, f0 + 1.1), dash=True, arrow=True)
    ink.label((900, 800), '平面跟练：只看得到正面', 'FLAT VIDEO · ONE ANGLE', CHALK, ramp(t, f0 + 1.0, f0 + 1.3))

def ov_glasses(S, t, M, ink):
    pass

def ov_holo(S, t, M, ink):
    ink.ring(M(1025, 1005), 230, CYN, ramp(t, tb(13), tb(13) + .5), t)
    ink.label((1180, 560), '老师，站进了她的空间', 'SPATIAL HOLOGRAM', CYN, ramp(t, tb(13, 1), tb(13, 1) + .3))

def ov_same(S, t, M, ink):
    ink.ring(M(412, 1000), 120, YEL, ramp(t, tb(14), tb(14) + .4), t)
    ink.ring(M(1290, 950), 240, CYN, ramp(t, tb(14, 1), tb(14, 1) + .4), t)
    ink.line([M(530, 990), M(860, 1040), M(1060, 980)], CHALK, 5, ramp(t, tb(14, 2), tb(14, 3)), dash=True)
    ink.label((560, 330), '同一个空间', 'SAME SPACE', CHALK, ramp(t, tb(15), tb(15) + .3))

def ov_side(t, M, ink):
    f0 = tb(17)
    ink.line(bez(M(650, 930), M(860, 760), M(1080, 990)), CYN, 8, ramp(t, f0 + .2, f0 + .8), arrow=True)
    ink.label((M(880, 0)[0] - 150, 300), '重心往前送', 'WEIGHT SHIFT', CYN, ramp(t, f0 + .8, f0 + 1.1), size=36)

def ov_back(t, M, ink):
    f0 = tb(17)
    for (x, y), dx in (((806, 985), -1), ((1133, 945), 1)):
        p = M(x, y); ink.line([p, (p[0] + dx * 150, p[1] + 25)], CYN, 8, ramp(t, f0 + .45, f0 + .95), arrow=True)
    ink.label((M(980, 0)[0] - 150, 300), '脚尖朝外', 'TOES OUT', CYN, ramp(t, f0 + 1.0, f0 + 1.3), size=36)

def ov_sync(S, t, M, ink):
    ink.ring(M(1660, 862), 150, YEL, ramp(t, tb(20, 1), tb(20, 1) + .4), t)
    ink.ring(M(1135, 842), 200, CYN, ramp(t, tb(20, .5), tb(20, .5) + .4), t)
    ink.label((1180, 260), '看得更全，动作对上了', 'SEE IT WHOLE', YEL, ramp(t, tb(20, 3), tb(20, 3) + .3) * (1 - ramp(t, tb(21.8), tb(22))))
    f0 = tb(22)
    ink.label((300, 280), '照着跳，还不是她自己的舞', 'STILL HIS MOVES', CHALK, ramp(t, f0 + .5, f0 + .8))

def ov_out(S, t, M, ink): pass

def ov_nav(S, t, M, ink):
    for i, box in enumerate([(1551, 202, 1855, 363), (1551, 407, 1855, 570)]):
        al = ramp(t, tb(26, 1 + i), tb(26, 1 + i) + .25)
        a, b = M(box[0], box[1]), M(box[2], box[3])
        ink.d.rounded_rectangle([a[0] - 6, a[1] - 6, b[0] + 6, b[1] + 6], 22, outline=YEL + (int(255 * al),), width=4)
    ink.label((1140, 640), '球场 · 冰场', 'WHERE BODIES MOVE', CYN, ramp(t, tb(27), tb(27) + .3), size=34)

def ov_court(S, t, M, ink):
    p = pulse(t, 28, 30)
    ink.ring(M(612, 735), 70 + 30 * p, CYN, ramp(t, tb(28), tb(28) + .4), t)
    ink.ring(M(1594, 1000), 90 + 22 * p, YEL, ramp(t, tb(28, 2), tb(28, 2) + .4), t)
    ink.label((1060, 300), '跟着球声，轻点脚', 'TAP ON THE BOUNCE', YEL, ramp(t, tb(29), tb(29) + .3))

def ov_capture(S, t, M, ink):
    # 原图底部 4 个点：按拍逐个点亮
    for i, x in enumerate((1171, 1232, 1293, 1354)):
        on = (beatno(t) % 4) == i and t < tb(31)
        if on or t >= tb(31): ink.dot(M(x, 993), 13, YEL, 1.0 if on else .85)
    f0 = tb(31)
    ink.line([M(1238, 640), M(1120, 800), M(1470, 845)], CYN, 9, ramp(t, f0 + .15, f0 + .7), arrow=True)
    ink.label((280, 330), '沉拍 · 变向', 'DROP THE BEAT · CUT', YEL, ramp(t, f0 + .6, f0 + .9))

def ov_rink(S, t, M, ink):
    ink.ring(M(1545, 695), 120, CYN, ramp(t, tb(32), tb(32) + .4), t)
    ink.line(bez(M(1520, 720), M(1100, 820), M(760, 700)), CYN, 6, ramp(t, tb(32, 2), tb(33)), dash=True, arrow=True)
    ink.label((560, 230), '隔着护栏观察', 'WATCH THROUGH THE GLASS', CHALK, ramp(t, tb(33), tb(33) + .3), size=34)

def ov_slow(S, t, M, ink):
    f0 = tb(34, 2)
    ink.line(bez(M(1330, 965), M(1520, 880), M(1700, 850)), CYN, 8, ramp(t, f0 + .1, f0 + .5), dash=True, arrow=True)
    ink.line(bez(M(1720, 965), M(1530, 880), M(1360, 850)), CYN, 8, ramp(t, f0 + .3, f0 + .7), dash=True, arrow=True)
    ink.label((300, 330), '交叉滑步 → 连贯换步', 'CROSSOVER · STEP CHANGE', YEL, ramp(t, f0 + .7, f0 + 1.0))

def ov_feet(S, t, M, ink):
    ink.ring(M(500, 925), 170, YEL, ramp(t, tb(36), tb(36) + .3), t)
    ink.ring(M(1010, 830), 150, YEL, ramp(t, tb(36, 1), tb(36, 1) + .3), t)

def ov_rope(S, t, M, ink):
    ink.ring(M(893, 842), 110, CYN, ramp(t, tb(37), tb(37) + .3), t)
    k = beatno(t) - beatno(tb(37))
    for i in range(4):
        x = lerp(1359, 1718, i / 3)
        if i <= k: ink.dot(M(x, 937), 11, YEL)
    ink.label((260, 330), '轻跳 · 停顿', 'HOP · HOLD', YEL, ramp(t, tb(37, 1), tb(37, 1) + .3))

def ov_pong(S, t, M, ink):
    pts = bez(M(874, 311), M(700, 230), M(560, 470))
    ink.line(pts, CYN, 6, ramp(t, tb(38), tb(38, 1.5)), dash=True, arrow=True)
    ink.label((1200, 260), '回弹', 'REBOUND', YEL, ramp(t, tb(38, 1), tb(38, 1) + .3))

def ov_sheet(S, t, M, ink):
    for i, off in enumerate((0, -40)):
        ink.line(bez(M(420, 110 + off), M(1150, -40 + off), M(1840, 400 + off)), YEL, 7 - i * 2, ramp(t, tb(39, i), tb(39, i + 1.5)), arrow=(i == 0))
    ink.label((260, 520), '展开 · 收回', 'OPEN · FOLD', YEL, ramp(t, tb(39, 2), tb(39, 2) + .3) * (1 - ramp(t, tb(40, 2), tb(40, 3))))

# 四张动作卡：(名字, 来源, 原图, 裁切框)
CARDS = [('沉拍变向', '篮球', 'image3.jpeg', (900, 250, 1700, 700)), ('交叉滑步', '滑冰', 'image14.jpeg', (1117, 551, 1862, 970)),
         ('轻跳停顿', '跳绳', 'image15.jpeg', (1296, 605, 1891, 940)), ('展开收回', '晾晒', 'image17.jpeg', (500, 150, 1700, 825))]
@lru_cache(None)
def thumb(k, box, w, h):
    return img(base(k)).crop(box).resize((w, h), Image.LANCZOS)

def ov_board(S, t, M, ink):
    for i, x in enumerate((787, 935, 1077)):                 # 原图里的 ①②③ 按拍点亮
        if tb(41.5) <= t < tb(43) and (beatno(t) % 3) == i: ink.ring(M(x, 935), 34, YEL, 1, t)

def board_layer(a, t):
    """第 43 小节起：画面压暗成板，四张卡按拍落下，再连成顺序"""
    k = ramp(t, tb(43), tb(43) + .3)
    if k <= 0: return a
    a = a * (1 - .72 * k) + np.array([12, 20, 17], np.float32) / 255 * .72 * k
    im = img(a).convert('RGBA'); ov = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    for x in range(0, W, 60): d.line([(x, 0), (x, H)], fill=(255, 255, 255, int(14 * k)))
    for y in range(0, H, 60): d.line([(0, y), (W, y)], fill=(255, 255, 255, int(14 * k)))
    cw, ch = 380, 214; gx = 92
    x0 = (W - (4 * cw + 3 * gx)) / 2; y0 = 400
    d.text((x0, 300), '回看 · 排序', font=F(56), fill=CHALK + (int(255 * k),), anchor='ls')
    d.text((x0 + 300, 300), 'REVIEW · ORDER', font=E(28), fill=YEL + (int(255 * k),), anchor='ls')
    for i, (nm, src, kk, box) in enumerate(CARDS):
        al = ramp(t, tb(43, 1 + i * .75), tb(43, 1 + i * .75) + .22)
        if al <= 0: continue
        x = x0 + i * (cw + gx); y = y0 - (1 - eo(al)) * 60
        th = thumb(kk, box, cw, ch); im.alpha_composite(th.convert('RGBA'), (int(x), int(y))) if al >= 1 else None
        if al < 1:
            t2 = th.convert('RGBA'); t2.putalpha(int(255 * al)); im.alpha_composite(t2, (int(x), int(y)))
        d.rectangle([x - 3, y - 3, x + cw + 3, y + ch + 3], outline=CYN + (int(255 * al),), width=3)
        d.ellipse([x - 26, y - 26, x + 26, y + 26], fill=YEL + (int(255 * al),))
        d.text((x, y + 13), str(i + 1), font=E(40, 'heavy'), fill=INK + (int(255 * al),), anchor='ms')
        d.text((x, y + ch + 62), nm, font=F(42), fill=YEL + (int(255 * al),), anchor='ls')
        d.text((x, y + ch + 102), '来自 ' + src, font=F(26, False), fill=CYN + (int(255 * al),), anchor='ls')
        if i < 3:
            la = ramp(t, tb(44, i), tb(44, i) + .3)
            ax = x + cw + 14; ay = y0 + ch / 2
            if la > 0:
                d.line([(ax, ay), (ax + (gx - 30) * la, ay)], fill=YEL + (255,), width=6)
                if la > .8: d.polygon([(ax + gx - 22, ay), (ax + gx - 40, ay - 12), (ax + gx - 40, ay + 12)], fill=YEL + (255,))
    return arr(Image.alpha_composite(im, ov))

def move_overlay(i):
    nm, src, kk, box = CARDS[i]; b = 46 + i
    def f(S, t, M, ink):
        f0 = tb(b, 1)
        if i == 0:
            ink.line([M(990, 330), M(990, 610)], YEL, 10, ramp(t, f0 + .05, f0 + .35), arrow=True)
            ink.line(bez(M(860, 1010), M(1100, 880), M(1380, 975)), YEL, 7, ramp(t, f0 + .3, f0 + .65), dash=True, arrow=True)
        elif i == 1:
            ink.line(bez(M(300, 990), M(700, 880), M(1180, 840)), YEL, 9, ramp(t, f0 + .05, f0 + .4), dash=True, arrow=True)
            ink.line(bez(M(1180, 1000), M(780, 900), M(380, 820)), YEL, 9, ramp(t, f0 + .2, f0 + .55), dash=True, arrow=True)
        elif i == 2:
            ink.ring(M(1180, 900), 360, YEL, ramp(t, f0 + .05, f0 + .4), t)
            for k in range(2):
                x = 545 + k * 44; ink.line([(x, 312), (x, 392)], YEL, 14, ramp(t, f0 + .3 + k * .1, f0 + .5 + k * .1))
        else:
            for k, r in enumerate((180, 320, 470)):
                ink.ring(M(960, 845), r, YEL, ramp(t, f0 + .05 + k * .12, f0 + .4 + k * .12), t, alpha=1 - k * .2)
        ink.label((120, 300), f'{i + 1}  {nm}', 'MOVE 0%d · FROM %s' % (i + 1, {'篮球': 'BASKETBALL', '滑冰': 'SKATING', '跳绳': 'ROPE', '晾晒': 'LAUNDRY'}[src]),
                  YEL, ramp(t, f0 + .25, f0 + .5), size=54)
        al = ramp(t, f0 + .4, f0 + .65)                      # 右上角：这一步来自哪
        if al > 0:
            th = thumb(kk, box, 300, 169).convert('RGBA'); th.putalpha(int(255 * al))
            ink.ov.alpha_composite(th, (W - 300 - 80, 170))
            ink.d.rectangle([W - 383, 167, W - 77, 342], outline=CYN + (int(255 * al),), width=3)
            ink.d.text((W - 380, 380), '来自 ' + src, font=F(26), fill=CYN + (int(255 * al),), anchor='ls')
    return f

def ov_none(S, t, M, ink): pass

SH = [
    Shot('image.jpeg', 0, 4, Cam([(0, 1.0, 960, 540), (1, 1.07, 1180, 560)]), ov_open, px=18),
    Shot('image21.jpeg', 4, 6, Cam([(0, 1.02, 900, 540), (1, 1.08, 1040, 520)]), ov_tv),
    Shot('image8.jpeg', 6, 10, Cam([(0, 1.0, 960, 560), (1, 1.06, 900, 600)]), ov_stuck, freezes=[(8, 10)]),
    Shot('image9.jpeg', 10, 12, Cam([(0, 1.0, 960, 540), (1, 1.12, 900, 380)]), ov_glasses, px=10),
    None,                                                   # 12–13 平面进入空间（专门处理）
    Shot('image10.jpeg', 13, 14, Cam([(0, 1.0, 960, 540), (1, 1.05, 1000, 560)]), ov_holo, lens='眼镜视角 · 空间人物影像', px=22),
    Shot('image5.jpeg', 14, 16, Cam([(0, 1.0, 960, 560), (1, 1.06, 880, 560)]), ov_same, px=24),
    None,                                                   # 16–20 双机位分屏（专门处理）
    Shot('image2.jpeg', 20, 24, Cam([(0, 1.0, 1200, 600), (1, 1.1, 1300, 620)]), ov_sync, freezes=[(22, 24)], px=20),
    Shot('image.png', 24, 26, Cam([(0, 1.0, 960, 540), (1, 1.08, 1060, 540)]), ov_out, px=20),
    Shot('image11.jpeg', 26, 28, Cam([(0, 1.0, 960, 540), (1, 1.08, 1000, 600)]), ov_nav, lens='眼镜视角 · 创意导航', px=24),
    Shot('image12.jpeg', 28, 30, Cam([(0, 1.0, 960, 540), (1, 1.06, 900, 560)]), ov_court, px=20),
    Shot('image3.jpeg', 30, 32, Cam([(0, 1.0, 960, 540), (1, 1.06, 1100, 560)]), ov_capture, freezes=[(31, 32)], lens='眼镜视角 · 节奏采集', px=16),
    Shot('image13.jpeg', 32, 34, Cam([(0, 1.0, 960, 540), (1, 1.06, 1100, 540)]), ov_rink, px=24),
    Shot('image14.jpeg', 34, 36, Cam([(0, 1.0, 960, 540), (.5, 1.03, 1100, 620), (1, 1.5, 1490, 800)]), ov_slow, freezes=[(34.5, 35.5)], lens='眼镜视角 · 片段慢放', px=10),
    Shot('image22.jpeg', 36, 37, Cam([(0, 1.12, 760, 700), (1, 1.0, 960, 540)]), ov_feet, px=16),
    Shot('image15.jpeg', 37, 38, Cam([(0, 1.0, 960, 540), (1, 1.05, 1000, 600)]), ov_rope, lens='眼镜视角 · 短句循环', px=16),
    Shot('image16.jpeg', 38, 39, Cam([(0, 1.0, 960, 540), (1, 1.05, 900, 520)]), ov_pong, lens='眼镜视角 · 素材对照', px=16),
    Shot('image17.jpeg', 39, 41, Cam([(0, 1.0, 960, 540), (.7, 1.05, 1050, 560), (1, 1.9, 1100, 640)]), ov_sheet, lens='眼镜视角 · 灵感收藏', px=14),
    Shot('image18.jpeg', 41, 46, Cam([(0, 1.06, 960, 560), (.45, 1.0, 960, 540), (1, 1.0, 960, 540)]), ov_board, lens='眼镜视角 · 素材重组', px=12),
    Shot('image4.jpeg', 46, 47, Cam([(0, 1.0, 1000, 560), (1, 1.06, 1080, 600)]), move_overlay(0), freezes=[(46.25, 47)], px=26),
    Shot('image22.jpeg', 47, 48, Cam([(0, 1.0, 960, 560), (1, 1.06, 700, 700)]), move_overlay(1), freezes=[(47.25, 48)], px=22),
    Shot('image19.jpeg', 48, 49, Cam([(0, 1.0, 960, 540), (1, 1.05, 1100, 560)]), move_overlay(2), freezes=[(48.25, 49)], px=26),
    Shot('image23.jpeg', 49, 50, Cam([(0, 1.0, 960, 540), (1, 1.05, 960, 600)]), move_overlay(3), freezes=[(49.25, 50)], px=26),
    Shot('image19.jpeg', 50, 52, Cam([(0, 1.12, 900, 520), (1, 1.0, 1000, 540)]), ov_none, px=40, py=10),
    Shot('image23.jpeg', 52, 54, Cam([(0, 1.0, 960, 560), (1, 1.12, 960, 520)]), ov_none, px=40, py=8),
    Shot('image20.jpeg', 54, 56, Cam([(0, 1.0, 960, 540), (1, 1.07, 1100, 520)]), ov_none, px=22),
    Shot('image24.jpeg', 56, 58, Cam([(0, 1.0, 960, 540), (1, 1.08, 760, 560)]), ov_none, px=22),
    Shot('image2.png', 58, 61, Cam([(0, 1.0, 960, 540), (1, 1.04, 960, 540)]), ov_none, px=10),
]
SH = [s for s in SH if s]
WIPES = [tb(24), tb(50)]                                    # 段落间的黄色斜带
CHAP = [(0, '瓶颈 · 平面跟练', 'FOLLOW'), (12, 'AR · 走进动作', 'AR SPACE'), (24, '生活 · 取材', 'COLLECT'), (41, '舞房 · 编排', 'CHOREO')]

def find(t):
    for s in SH:
        if s.s <= t < s.e: return s
    return SH[-1]

def shot_frame(S, t, w=W, h=H, ox=0):
    """渲染一个镜头的画面 + 标注（返回 float 数组）"""
    u = S.live(t); z, cx, cy = S.cam.at(u, w, h); fz = S.frozen(t)
    if fz:
        f = (t - fz[0]); z *= 1 + .035 * (1 - eo(f / .35)) + .012 * f / max(fz[1] - fz[0], .1)
    if S.k == 'image19.jpeg' and tb(50) <= t < tb(52) or S.k == 'image23.jpeg' and tb(52) <= t < tb(54):
        z *= 1 + .012 * pulse(t, 50, 54)                    # 最后一段：每拍轻推
    a = render_bg(S.k, z, cx, cy, u, S.px, S.py, w, h)
    if fz: a = vignette(grade(a, .58, 1.0), .5)
    return a, mapper(z, cx, cy, w, h, ox), fz

def frame_main(t):
    # 12–13 小节：平面进入空间——镜头推进电视，电视里的老师长成整幅立体画面
    if tb(12) <= t < tb(13):
        f = eo((t - tb(12)) / BAR)
        z = lerp(1.0, 2.05, f); cx, cy = lerp(1100, 1395, f), lerp(470, 416, f)
        a = render_bg('image21.jpeg', z, cx, cy, .5, 0, 0)
        M = mapper(z, cx, cy); (x0, y0), (x1, y1) = M(918, 42), M(1872, 790)
        sw, sh = int(x1 - x0), int(y1 - y0)
        if sw > 8 and sh > 8:
            inner = render_bg('image10.jpeg', 1.0, 960, 540, f, 22 * f, 0)
            im = img(a); im.paste(img(inner).resize((sw, sh), Image.BILINEAR), (int(x0), int(y0))); a = arr(im)
        ink = Ink(); return lens(ink.compose(a), t, tb(12, 3), '眼镜视角 · 空间人物影像'), None
    # 16–20 小节：双机位分屏（侧面 | 背面）
    if tb(16) <= t < tb(20):
        out = np.zeros((H, W, 3), np.float32); ink = Ink(); fz = tb(17) <= t < tb(20)
        u = clamp((t - tb(16)) / BAR) if not fz else 1.0
        for j, (k, cx, ov, lab) in enumerate((('image6.jpeg', 870, ov_side, 'A  侧面 SIDE'), ('image7.jpeg', 980, ov_back, 'B  背面 BACK'))):
            z = 1.0 + .03 * u
            if fz: z *= 1 + .035 * (1 - eo((t - tb(17)) / .35))
            sl = render_bg(k, z, cx, 560, u, 16, 0, 960, H)
            if fz: sl = vignette(grade(sl, .6, 1.0), .4)
            out[:, j * 960:(j + 1) * 960] = sl
            M = mapper(z, cx, 560, 960, H, j * 960)
            ov(t, M, ink)
            ink.d.rectangle([j * 960 + 60, 240, j * 960 + 290, 286], fill=INK + (220,))
            ink.d.text((j * 960 + 76, 274), lab, font=F(24), fill=CYN + (255,), anchor='ls')
        ink.d.rectangle([957, 0, 963, H], fill=YEL + (255,))
        a = ink.compose(out)
        return lens(a, t, tb(16), '眼镜视角 · 多角度观察', '全方位观察需配套空间内容', box=(40, 120, W - 40, H - 150)), (tb(17) if fz else None)
    S = find(t); a, M, fz = shot_frame(S, t)
    if S.spot: a = spotlight(a, *S.spot, 1)
    ink = Ink(); S.ov(S, t, M, ink); a = ink.compose(a)
    if S.k == 'image18.jpeg': a = board_layer(a, t)
    if S.lens and not (S.k == 'image18.jpeg' and t >= tb(43)): a = lens(a, t, S.s, S.lens, sub='AR内容应用构想' if S.k != 'image10.jpeg' else '需配套空间内容')
    # 白布接回舞房：40.5 小节起画面泛白，41 小节从白里露出舞房
    if tb(40.5) <= t < tb(41): a = a + (1 - a) * ramp(t, tb(40.5), tb(41))
    if tb(41) <= t < tb(41.6): a = a + (1 - a) * (1 - ramp(t, tb(41), tb(41.6)))
    # 结尾：落版
    if S.k == 'image24.jpeg' or S.k == 'image2.png': a = endcard(a, t, S)
    return a, (fz[0] if fz else None)

def endcard(a, t, S):
    im = img(a).convert('RGBA'); ov = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    if S.k == 'image24.jpeg':
        for txt, f, col, y, bt in (('乐奇AR', F(60), YEL, 300, 56.5), ('她的舞蹈导师', F(96), CHALK, 420, 57), ('突破瓶颈，找到创新', F(38, False), (220, 216, 206), 500, 57.5)):
            al = ramp(t, tb(bt), tb(bt) + .4)
            d.text((560 + (1 - eo(al)) * -24, y), txt, font=f, fill=col + (int(255 * al),), anchor='ls')
    else:
        al = ramp(t, tb(58, 1), tb(58, 1) + .4)
        d.rectangle([60, H - 120, 420, H - 70], fill=INK + (int(200 * al),))
        d.text((80, H - 84), '官方产品参考', font=F(26, False), fill=CHALK + (int(255 * al),), anchor='ls')
    im = Image.alpha_composite(im, ov); a = arr(im)
    if S.k == 'image2.png': a = a * (1 - ramp(t, tb(60.2), tb(60.9)))
    return a

# ---------------------------------------------------------------- 包装：角标 / 节拍钟 / 字幕 / 斜带
def packaging(im, t):
    if t < tb(4) or t >= tb(54): return im
    out = ramp(t, tb(50), tb(50, 1.2))                      # 界面退场
    d = ImageDraw.Draw(im, 'RGBA'); dy = -140 * eo(out); dx = -420 * eo(out)
    ch = [c for c in CHAP if tb(c[0]) <= t][-1]
    # 右上角标
    x0, y0 = 1452, 38 + dy
    d.rectangle([x0, y0, x0 + 236, y0 + 50], fill=YEL + (255,))
    d.text((x0 + 16, y0 + 37), '她的舞蹈导师', font=F(30), fill=INK + (255,), anchor='ls')
    d.rectangle([x0 + 236, y0, 1880, y0 + 50], fill=INK + (230,))
    d.text((x0 + 252, y0 + 36), ch[2], font=E(26, 'bold'), fill=(CYN if ch[2] == 'AR SPACE' else YEL) + (255,), anchor='ls')
    d.rectangle([x0, y0 + 50, 1880, y0 + 86], fill=INK + (200,))
    d.text((x0 + 16, y0 + 78), ch[1], font=F(22, False), fill=CHALK + (255,), anchor='ls')
    # 左上节拍钟
    bn = beatno(t); bar, bt = bn // 4, bn % 4
    x0 = 40 + dx; y0 = 38
    d.rectangle([x0, y0, x0 + 360, y0 + 56], fill=INK + (225,))
    d.text((x0 + 16, y0 + 40), '90 BPM', font=E(30, 'heavy'), fill=YEL + (255,), anchor='ls')
    d.text((x0 + 128, y0 + 38), f'BAR {bar + 1:02d}', font=MONO(22), fill=CHALK + (255,), anchor='ls')
    for i in range(4):
        cx = x0 + 262 + i * 24; on = i == bt
        d.ellipse([cx - 8, y0 + 20, cx + 8, y0 + 36], fill=(YEL if on else (90, 92, 88)) + (255,))
    return im

def sub_chunks(k):
    t = LINES[k]['zh']; parts, cur = [], ''
    for c in t:
        cur += c
        if c in '。！？' or (c == '，' and len(cur) > 13): parts.append(cur); cur = ''
    if cur: parts.append(cur)
    tot = sum(len(p) for p in parts); s = T[k]; out = []
    for p in parts:
        e = s + DUR[k] * len(p) / tot; out.append((p.rstrip('，。'), s, e)); s = e
    return out
CHUNKS = [c for k in VOAT for c in sub_chunks(k) if not k.startswith('m')]

def subtitles(im, t):
    d = ImageDraw.Draw(im, 'RGBA')
    for c, s, e in CHUNKS:
        if s - .08 <= t <= e + .12:
            al = ramp(t, s - .08, s + .06) * (1 - ramp(t, e, e + .12)); f = F(38, False)
            tw = d.textlength(c, font=f); x0 = W / 2 - tw / 2 - 28
            d.rectangle([x0, 950, x0 + tw + 56, 1022], fill=(0, 0, 0, int(163 * al)))
            d.rectangle([x0, 950, x0 + tw + 56, 954], fill=YEL + (int(255 * al),))
            d.text((W / 2, 1002), c, font=f, fill=CHALK + (int(255 * al),), anchor='ms')
    return im

def wipe(im, t):
    for tc in WIPES:
        if abs(t - tc) < .17:
            f = (t - tc + .17) / .34; x = lerp(-700, W + 300, f)
            d = ImageDraw.Draw(im, 'RGBA'); sk = 260
            d.polygon([(x, 0), (x + 300, 0), (x + 300 - sk, H), (x - sk, H)], fill=YEL + (255,))
            d.polygon([(x - 18, 0), (x, 0), (x - sk, H), (x - sk - 18, H)], fill=INK + (255,))
            d.polygon([(x + 300, 0), (x + 318, 0), (x + 318 - sk, H), (x + 300 - sk, H)], fill=INK + (255,))
    return im

def frame(i):
    t = i / FPS
    a, f0 = frame_main(t)
    if f0 is not None and t - f0 < .12: a = a + (1 - a) * .55 * (1 - (t - f0) / .12)     # 定格白闪
    for b in (46, 47, 48, 49, 52):                          # 动作段：每个小节头小闪
        if 0 <= t - tb(b) < .08: a = a + (1 - a) * .3
    a = grain(vignette(a, .22), 7, .012)          # 固定颗粒：逐帧随机颗粒会让码率翻几倍
    im = img(a)
    im = packaging(im, t); im = subtitles(im, t); im = wipe(im, t)
    if t < .5: im = Image.blend(Image.new('RGB', (W, H)), im, ramp(t, 0, .5))
    return im

def render(i):
    fn = OUT + f'frames/{i:05d}.jpg'
    if os.path.exists(fn): return
    frame(i).save(fn, quality=92)

# ---------------------------------------------------------------- 声音
SR = 44100
def rd(fn, af=None):
    cmd = ['ffmpeg', '-loglevel', 'error', '-i', fn] + (['-af', af] if af else []) + ['-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, np.float32).copy()

def bp(x, lo, hi):
    from scipy.signal import butter, sosfilt
    return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, hi):
    from scipy.signal import butter, sosfilt
    return sosfilt(butter(2, hi, 'low', fs=SR, output='sos'), x)

def sfx(kind, seed=0):
    r = np.random.default_rng(hash(kind) % 1000 + seed); n = int(SR * 1.2); tt = np.arange(n) / SR
    if kind == 'ball':      # 篮球拍地：低频闷响 + 橡胶 ring + 场地回声
        x = np.sin(2 * np.pi * (70 + 90 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 22)
        x += .35 * np.sin(2 * np.pi * 410 * tt) * np.exp(-tt * 30) + .3 * bp(r.standard_normal(n), 300, 2500) * np.exp(-tt * 90)
        x = x + .25 * np.roll(x, int(.09 * SR)); return x * .9
    if kind == 'scrape':    # 冰刀：带通噪声扫频
        x = bp(r.standard_normal(n), 2500, 9000) * np.exp(-((tt - .18) / .12) ** 2) * .45
        return x + .15 * bp(r.standard_normal(n), 800, 2000) * np.exp(-((tt - .2) / .15) ** 2)
    if kind == 'rope':      # 跳绳甩过：短嗖声 + 落地轻拍
        x = bp(r.standard_normal(n), 900, 4000) * np.exp(-((tt - .08) / .04) ** 2) * .5
        return x + .25 * bp(r.standard_normal(n), 100, 900) * np.exp(-np.maximum(tt - .16, 0) * 60) * (tt > .16)
    if kind == 'pong':
        return np.sin(2 * np.pi * 2300 * tt) * np.exp(-tt * 70) * .35 + bp(r.standard_normal(n), 2000, 7000) * np.exp(-tt * 300) * .3
    if kind == 'flap':      # 床单抖开
        e = np.exp(-((tt - .12) / .07) ** 2); return lp(r.standard_normal(n), 1200) * e * .9
    if kind == 'shutter':
        x = bp(r.standard_normal(n), 1500, 8000) * (np.exp(-tt * 120) + .6 * np.exp(-np.maximum(tt - .06, 0) * 140) * (tt > .06))
        return x * .3
    if kind == 'stab':      # 定格：低频重拍
        return (np.sin(2 * np.pi * (55 + 60 * np.exp(-tt * 18)) * tt) * np.exp(-tt * 6) * .8 + .2 * bp(r.standard_normal(n), 60, 400) * np.exp(-tt * 20))
    if kind == 'squeak':    # 马克笔
        fl = 1 + .3 * np.sin(2 * np.pi * 28 * tt)
        return bp(r.standard_normal(n), 2000, 5000) * fl * np.exp(-((tt - .15) / .1) ** 2) * .12
    if kind == 'pop':
        return np.sin(2 * np.pi * (900 - 500 * tt) * tt) * np.exp(-tt * 40) * .18
    if kind == 'whoosh':
        return bp(r.standard_normal(n), 400, 5000) * np.exp(-((tt - .17) / .1) ** 2) * .35
    if kind == 'tick':
        return np.sin(2 * np.pi * 1800 * tt) * np.exp(-tt * 120) * .2
    if kind == 'step':      # 球鞋落地
        return (np.sin(2 * np.pi * 90 * tt) * np.exp(-tt * 40) * .5 + bp(r.standard_normal(n), 200, 3000) * np.exp(-tt * 80) * .25)
    if kind == 'breath':
        e = np.sin(np.pi * np.clip(tt / .9, 0, 1)) ** 2; return bp(r.standard_normal(n), 300, 2500) * e * .09
    if kind == 'white':
        return bp(r.standard_normal(n), 200, 8000) * np.clip(tt / .6, 0, 1) ** 2 * (tt < .67) * .3
    raise KeyError(kind)

def sfx_list():
    L = []
    for b in (8, 17, 22, 31, 34.5): L += [('stab', tb(b)), ('shutter', tb(b))]
    for b in (46, 47, 48, 49): L += [('stab', tb(b, 1)), ('shutter', tb(b, 1))]
    for tc in WIPES: L.append(('whoosh', tc - .17))
    L += [('whoosh', tb(12) - .1), ('whoosh', tb(16) - .17)]
    for k in range(16): L.append(('ball', tb(28, k) + .0))                 # 球声进入鼓点
    for k in (0, 2, 4, 6, 8, 10, 12, 14): L.append(('scrape', tb(32, k)))  # 冰刃成为擦拍
    L += [('step', tb(36)), ('step', tb(36, 2))]
    for k in range(4): L.append(('rope', tb(37, k)))
    for k in range(8): L.append(('pong', tb(38, k / 2)))
    for k in (0, 2, 4): L.append(('flap', tb(39, k)))
    L.append(('white', tb(40.5)))
    for k in range(4): L.append(('tick', tb(43, 1 + k * .75)))
    # 段落标注：画圈 pop + 马克笔
    for b in (4.5, 8, 13, 14, 17, 20, 28, 31, 32, 34.5, 36, 37):
        L += [('pop', tb(b) + .12), ('squeak', tb(b) + .5)]
    # 最后露出呼吸和脚步
    L += [('breath', tb(53, 2)), ('step', tb(53, 3)), ('step', tb(53, 3.5)), ('breath', tb(54, 3)), ('step', tb(55)), ('step', tb(55, 2))]
    return L

def cue(name, bpm, fd):
    """拉到 90 BPM，返回 (音频, 第一拍下标)"""
    x = rd(MUS + name, f'atempo={BPM / bpm:.5f}')
    return x, int(fd * bpm / BPM * SR)

SKIP = {'b_open.wav': 2}                                  # b 段前两小节是空引子，跳过
NUDGE = {'a_stuck.wav': .055, 'b_open.wav': -.036}
def music_bed(n):
    B = json.load(open(MUS + 'beats.json'))
    plan = [('a_stuck.wav', 0, 12), ('b_open.wav', 12, 24), ('c_life.wav', 24, 41), ('d_dance.wav', 41, 53.75), ('e_outro.wav', 54, 61)]
    out = np.zeros(n, np.float32); bar = int(BAR * SR); fade = int(.03 * SR)
    for name, b0, b1 in plan:
        x, fd = cue(name, B[name]['bpm'], B[name]['first_downbeat'])
        need = int((b1 - b0) * bar)
        body = x[fd + SKIP.get(name, 0) * bar:]
        if len(body) < need + bar:                         # 不够长：取中段整小节循环
            nb = len(body) // bar; lo, hi = 1, max(2, nb - 2)
            loop = body[lo * bar:hi * bar]; seg = list(body[:hi * bar])
            seg = np.array(seg, np.float32)
            while len(seg) < need + bar:
                k = min(fade, len(loop)); w = np.linspace(0, 1, k)
                seg[-k:] = seg[-k:] * (1 - w) + loop[:k] * w; seg = np.concatenate([seg, loop[k:]])
            body = seg
        a = int((tb(b0) + NUDGE.get(name, 0)) * SR)       # 实测相位微调（拍点检测：各段对齐误差 ≤ 25 ms）
        if b0 > 0:                                           # 弱起：前面留一拍的引子
            pre = x[max(0, fd - int(BEAT * SR)):fd]; s = a - len(pre)
            out[s:a] += pre * np.linspace(0, 1, len(pre))
        seg = body[:need + int(BEAT * SR)].copy()
        tail = int(BEAT * SR * (.25 if name == 'd_dance.wav' else 1))
        seg[need:need + tail] *= np.linspace(1, 0, len(seg[need:need + tail])); seg[need + tail:] = 0
        if name == 'e_outro.wav': seg *= np.clip((np.arange(len(seg)) / SR) / BAR, 0, 1) ** .7
        if name == 'e_outro.wav': seg[-int(2.5 * SR):] *= np.linspace(1, 0, int(2.5 * SR)) if len(seg) > 2.5 * SR else 1
        e = min(n, a + len(seg)); out[a:e] += seg[:e - a] / (np.abs(x).max() + 1e-6) * .8
    return out

def freeze_filter(mu):
    """定格时：音乐压低并闷掉（跟画面一起“冻住”）"""
    tt = np.arange(len(mu)) / SR; env = np.zeros(len(mu), np.float32)
    for s in SH:
        for a, b in s.fr: env = np.maximum(env, np.clip((tt - a) / .05, 0, 1) * np.clip((b - tt) / .1, 0, 1))
    env = np.maximum(env, ((tt >= tb(17)) & (tt < tb(20))) * 1.0)
    env = np.convolve(env, np.ones(800) / 800, 'same')
    return mu * (1 - .45 * env) + lp(mu, 700) * .45 * env

def audio():
    n = int((TOTAL + .5) * SR); vo = np.zeros(n, np.float32); fx = np.zeros(n, np.float32)
    for k in VOAT:
        x = rd(VO + f'wav/{k}.wav'); a = int(T[k] * SR); vo[a:a + len(x)] += x[:n - a]
    for kind, t0 in sfx_list():
        x = sfx(kind, int(t0 * 10)); a = int(t0 * SR); fx[a:a + len(x)] += x[:n - a]
    mu = freeze_filter(music_bed(n))
    env = np.abs(vo); k = int(SR * .2)
    env = np.convolve(env, np.ones(k) / k, 'same'); duck = 1 - 0.45 * np.clip(env / (env.max() * .15 + 1e-6), 0, 1)
    mix = vo * 1.0 + fx * .75 + mu * .62 * duck
    mix = mix / (np.percentile(np.abs(mix), 99.95) + 1e-6) * .8
    mix = np.tanh(mix * 1.1) / 1.1                         # 软限幅：吃掉音效的瞬时尖峰
    import wave
    w = wave.open(OUT + 'mix.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes()); w.close()

def srt():
    def ts(x): h, r = divmod(x, 3600); m_, s = divmod(r, 60); return f'{int(h):02d}:{int(m_):02d}:{int(s):02d},{int((s % 1) * 1000):03d}'
    items = sorted([(s, e, c) for c, s, e in CHUNKS] + [(T[k], T[k] + DUR[k], LINES[k]['zh'].rstrip('。')) for k in VOAT if k.startswith('m')])
    open(P + NAME + '.srt', 'w').write('\n'.join(f'{i + 1}\n{ts(s)} --> {ts(e)}\n{c}\n' for i, (s, e, c) in enumerate(items)))

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(OUT + 'frames', exist_ok=True)
    print(f'总长 {TOTAL:.1f}s，{int(TOTAL * FPS)} 帧')
    if '--still' in sys.argv:
        for s in sys.argv[sys.argv.index('--still') + 1].split(','):
            frame(int(float(s) * FPS)).save(OUT + f'check_{float(s):06.1f}.jpg', quality=85); print('ok', s)
        sys.exit()
    if '--from' in sys.argv:
        a = float(sys.argv[sys.argv.index('--from') + 1]); b = float(sys.argv[sys.argv.index('--to') + 1])
        idx = range(int(a * FPS), int(b * FPS))
    else: idx = range(int(TOTAL * FPS))
    if cmd in ('frames', 'all'):
        with Pool(14) as p:
            for j, _ in enumerate(p.imap_unordered(render, idx, chunksize=8)):
                if j % 240 == 0: print('帧', j, flush=True)
    if cmd in ('audio', 'all'): audio(); srt(); print('audio ok')
    if cmd in ('mux', 'all'):
        out = P + NAME + '.mp4'
        r = subprocess.run(['ffmpeg', '-i', OUT + 'mix.wav', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
        J = json.loads(r[r.rindex('{'):r.rindex('}') + 1])
        ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={J['input_i']}:measured_TP={J['input_tp']}:measured_LRA={J['input_lra']}"
              f":measured_thresh={J['input_thresh']}:offset={J['target_offset']}:linear=true,aresample=44100")
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', OUT + 'frames/%05d.jpg', '-i', OUT + 'mix.wav',
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                        '-af', ln, '-shortest', '-movflags', '+faststart', out], check=True)
        print('ok', out)
