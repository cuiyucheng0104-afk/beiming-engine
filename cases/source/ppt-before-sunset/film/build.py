"""《日落之前》故事介绍片 · 成片
画面：PPT 原图 + ROG 深度图 2.5D 视差；代码层四件事：
  日落钟：右上角的太阳弧，全片按故事时间往下走，日落即片尾；场与场之间用两张图里的太阳对位转场；
  镜片窗：只给眼镜的三个功能（通话 / 实时翻译 / 语音支付），镜片绿，按 PPT 功能页样式；
  沙地图：牧场主在沙地上划出岔路、红水罐、运水便道，拍下后变成卡片，跟到山坡；
  墨线批注：人物票签、陆遥的脱身计划、蓝色胶带。
声音：MiniMax 中文旁白 + 中/西语对白 + Music3 分幕配乐 + 代码合成音效。
用法：python build.py [frames|audio|mux|all] [--from 秒 --to 秒] [--still 1,2,3]
"""
import os, sys, json, math, subprocess
from functools import lru_cache
from multiprocessing import Pool
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

P = os.path.expanduser('~/Desktop/日落之前/')
SRC, DEP, VO, OUT, MUS = P + '素材/ppt/ppt/media/', P + 'depth/', P + '配音/', P + 'film/out/', P + '音乐/'
W, H, FPS = 1920, 1080, 24
XF = 0.9                                         # 段间转场时长
INK = (58, 34, 22); PAPER = (240, 228, 204); CREAM = (247, 238, 218); SUB = (226, 214, 192)
LENS = (86, 232, 146); LENS_BG = (8, 34, 22)
CHUAN, YAO, ESTE, GANG, TAPE = (232, 150, 84), (110, 176, 238), (232, 200, 120), (214, 92, 70), (64, 132, 222)
SONG = '/System/Library/Fonts/Supplemental/Songti.ttc'
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
CLAR = '/System/Library/Fonts/Supplemental/SuperClarendon.ttc'
TYPE = '/System/Library/Fonts/Supplemental/AmericanTypewriter.ttc'

LINES = {x['id']: x for x in json.load(open(VO + 'lines.json'))}
DUR = json.load(open(VO + 'wav/dur.json'))

@lru_cache(None)
def words(k):
    """逐字时间：[(秒, 已出字数)]"""
    try: segs = json.load(open(VO + f'subs/{k}.titles'))
    except Exception: return []
    return [(w['time_begin'] / 1000, w['word_end']) for s in segs for w in s.get('timestamped_words', [])]

def typed(k, t):
    """t 时刻这句台词出到第几个字"""
    txt = LINES[k].get('say', LINES[k]['zh']); ws = words(k)
    if t < T[k]: return 0
    if not ws: return int(len(txt) * clamp((t - T[k]) / DUR[k]))
    n = 0
    for tb, e in ws:
        if T[k] + tb <= t: n = max(n, e)
    return min(n, len(txt))

# ---------------------------------------------------------------- 时间线
# (句子, 句前停顿) 或 (句子, (参照句, 相对参照句开头的偏移))：同传译句压在西语原句上
ORDER = [('n01', 4.2), ('n02', .6),
         ('y01', 3.4), ('g01', .1), ('c01', .3), ('y02', .2), ('n03', 1.3),
         ('n04', 1.6),
         ('n05', 2.0), ('c02', .5), ('e01', .6), ('t01', ('e01', 1.5)),
         ('e02', .6), ('t02', ('e02', 1.6)), ('e03', .5), ('t03', ('e03', 1.6)), ('n06', 1.4),
         ('b01', 1.6), ('n07', 1.0), ('n08', 1.2),
         ('c03', .9), ('y03', .5), ('n09', .8), ('c04', .6), ('y04', .15), ('c05', .6),
         ('c06', 2.3), ('n10', 1.7), ('c07', 1.0), ('y05', .5),
         ('n11', 1.9), ('k01', .5), ('c08', .4), ('t04', 1.0), ('y06', .9), ('c09', .4), ('y07', .8), ('c10', .3),
         ('n12', 1.6), ('n13', 1.4), ('y08', 3.4), ('c11', .3)]
T = {}; _t = 0.0
for k, g in ORDER:
    if isinstance(g, tuple): T[k] = T[g[0]] + g[1]
    else: T[k] = _t + g
    _t = max(_t, T[k] + DUR[k])
def at(k, f=0.0): return T[k] + f * DUR[k]
def end(k): return T[k] + DUR[k]
TOTAL = end('c11') + 3.2
CRASH = end('c06') + .25                          # 水车撞门
SHUT = end('t03') + .7                            # 拍下沙地图
DROP = at('y02', .93)                             # 通话中断

# 场景：(名, 起, 止, 图)。相邻场景在边界处转场 XF
_b = [0.0, end('n02') + .6, end('n03') + .7, T['n05'] - .4, T['e02'] + .1, end('n06') + .5,
      end('b01') + .3, T['n08'] - .3, end('c05') + .5, end('y05') + .7, end('c10') + .7, end('n12') + .5, TOTAL]
_n = [('open', 'image'), ('call', 'image2'), ('ride', 'image3'), ('ask', 'image4'), ('map', None),
      ('boss', 'image6'), ('ridge', 'image5'), ('mine', 'image6'), ('crash', 'image7'), ('store', 'image8'),
      ('recap', None), ('hero', 'image9')]
SC = [(n, _b[i], _b[i + 1], im) for i, (n, im) in enumerate(_n)]
SCD = {s[0]: s for s in SC}

# 每张图里的太阳（1920×1080 坐标，半径）——转场对位用
SUN = {'image': (720, 760, 70), 'image2': (862, 452, 52), 'image3': (1132, 740, 78), 'image4': (990, 552, 66),
       'image5': (1366, 256, 100), 'image6': (960, 412, 98), 'image7': (1380, 500, 88), 'image8': (494, 462, 38),
       'image9': (1170, 522, 16)}

# 章节（PPT 七节；第七节按剧本第七场“先回家”，与日落结尾一致）
CHAP = [(SCD['call'][1], '01', '求救', '眼镜里，传来女儿的求救'),
        (SCD['ride'][1], '02', '穿越荒原', '一个人，穿过整片荒原'),
        (SCD['ask'][1], '03', '问路', '听懂一句话，多找到一条路'),
        (SCD['boss'][1], '04', '潜入', '从烈日，走进暗处'),
        (T['c03'] - 1.2, '05', '绝境', '找到她，却没有了退路'),
        (SCD['crash'][1], '06', '脱险', '这一次，他们一起闯出去'),
        (SCD['store'][1], '07', '回家', '牛仔也得有人帮')]

# 日落钟：故事时间（距 16:00 的分钟）关键帧，19:42 日落
SUNSET = 222
CLK = [(SCD['call'][1], 5), (SCD['ride'][1] - .3, 5), (SCD['ride'][1] + .6, 10), (SCD['ride'][2] - .5, 45),
       (SCD['ask'][1] + .5, 65), (SCD['map'][2] - .3, 78), (SCD['boss'][1] + .5, 140), (SCD['ridge'][2] - .3, 160),
       (SCD['mine'][1] + .5, 164), (SCD['mine'][2] - .4, 182), (SCD['crash'][1] + .5, 190), (SCD['crash'][2], 196),
       (SCD['store'][1] + .5, 210), (SCD['store'][2] - .3, 214)]
def story_min(t):
    ks = CLK
    if t <= ks[0][0]: return ks[0][1]
    for a, b in zip(ks, ks[1:]):
        if a[0] <= t <= b[0]: return a[1] + (b[1] - a[1]) * ss((t - a[0]) / (b[0] - a[0]))
    return ks[-1][1]

# ---------------------------------------------------------------- 工具
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ss(x): x = clamp(x); return x * x * (3 - 2 * x)
def ramp(t, a, b): return ss((t - a) / (b - a)) if b > a else float(t >= a)
def eo(x): x = clamp(x); return 1 - (1 - x) ** 3
def win(t, a, b, fi=.3, fo=.3): return ramp(t, a, a + fi) * (1 - ramp(t, b - fo, b))

@lru_cache(None)
def FS(size, w='black'): return ImageFont.truetype(SONG, size, index={'black': 0, 'bold': 1, 'light': 3, 'reg': 6}[w])
@lru_cache(None)
def FH(size, bold=False): return ImageFont.truetype(HIRA, size, index=1 if bold else 0)
@lru_cache(None)
def FC(size, w='black'): return ImageFont.truetype(CLAR, size, index={'black': 7, 'bold': 5, 'reg': 0, 'light': 3, 'italic': 1}[w])
@lru_cache(None)
def FT(size, w='reg'): return ImageFont.truetype(TYPE, size, index={'reg': 0, 'bold': 2, 'semi': 3, 'cond': 4}[w])

def fit_arr(im):
    s = max(W / im.width, H / im.height)
    im = im.resize((math.ceil(im.width * s), math.ceil(im.height * s)), Image.LANCZOS)
    x, y = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((x, y, x + W, y + H))

@lru_cache(None)
def base(k): return np.asarray(fit_arr(Image.open(SRC + k + '.png').convert('RGB'))).astype(np.float32) / 255

@lru_cache(None)
def depth(k):
    d = Image.fromarray(np.asarray(Image.open(DEP + f'{k}_depth.png')).astype(np.float32), 'F')
    a = np.asarray(fit_arr(d)).astype(np.float32)
    a = (a - np.percentile(a, 2)) / (np.percentile(a, 98) - np.percentile(a, 2) + 1e-6)
    return ndi.gaussian_filter(np.clip(a, 0, 1), 3)

def img(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def arr(im): return np.asarray(im.convert('RGB')).astype(np.float32) / 255
def rgba(): return Image.new('RGBA', (W, H), (0, 0, 0, 0))
def over(im, ov): return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

class Cam:
    """keys: [(u, z, cx, cy, px, py)]，u∈[0,1] 为场景内进度；px/py=视差幅度"""
    def __init__(self, keys): self.keys = keys
    def at(self, u):
        ks = self.keys
        if u <= ks[0][0]: v = ks[0][1:]
        elif u >= ks[-1][0]: v = ks[-1][1:]
        else:
            for a, b in zip(ks, ks[1:]):
                if a[0] <= u <= b[0]:
                    f = ss((u - a[0]) / (b[0] - a[0])); v = [x + (y - x) * f for x, y in zip(a[1:], b[1:])]; break
        z, cx, cy, px, py = v
        hw, hh = W / (2 * z), H / (2 * z); m = 4 + (abs(px) + abs(py)) / z
        cx = clamp(cx, hw + m, W - hw - m) if z > 1.0 else W / 2
        cy = clamp(cy, hh + m, H - hh - m) if z > 1.0 else H / 2
        return z, cx, cy, px, py

_GRID = None
def render_bg(src, k, z, cx, cy, px, py):
    global _GRID
    if _GRID is None: _GRID = np.mgrid[0:H, 0:W].astype(np.float32)
    v, uu = _GRID; D = depth(k)
    x0 = (uu - W / 2) / z + cx; y0 = (v - H / 2) / z + cy
    xi = np.clip(x0.astype(np.int32), 0, W - 1); yi = np.clip(y0.astype(np.int32), 0, H - 1)
    d = D[yi, xi] - 0.5
    xs = x0 + px * d / z; ys = y0 + py * d / z
    out = np.empty((H, W, 3), np.float32)
    for c in range(3): out[..., c] = ndi.map_coordinates(src[..., c], [ys, xs], order=1, mode='nearest')
    return out

def cam_bg(k, cam, u, src=None, shake=(0, 0)):
    z, cx, cy, px, py = cam.at(u); cx += shake[0] / z; cy += shake[1] / z
    a = render_bg(base(k) if src is None else src, k, z, cx, cy, px, py)
    return a, (lambda x, y: ((x - cx) * z + W / 2, (y - cy) * z + H / 2)), z

def grade(a, sat=1.0, bright=1.0, warm=0.0, contrast=1.0):
    g = a.mean(2, keepdims=True); a = g + (a - g) * sat
    if contrast != 1.0: a = (a - .5) * contrast + .5
    a = a * bright
    if warm: a = a + np.array([warm * .05, warm * .015, -warm * .05], np.float32)
    return a

def glow(a, L, color, core=1.0, s1=2.0, s2=10, k1=0.9, k2=0.6):
    m = np.asarray(L).astype(np.float32) / 255
    if m.max() == 0: return a
    sm = np.asarray(L.resize((L.width // 4, L.height // 4), Image.BILINEAR)).astype(np.float32) / 255
    b1 = ndi.gaussian_filter(sm, s1 / 4 + .5); b2 = ndi.gaussian_filter(sm, s2 / 4)
    up = lambda x: np.asarray(Image.fromarray(x.astype(np.float32)).resize((L.width, L.height), Image.BILINEAR))
    g = m * core + up(b1) * k1 + up(b2) * k2
    return a + g[..., None] * (np.array(color, np.float32) / 255)

def bloom(a, xy, r, k, color=(1.0, .78, .5)):
    """太阳光晕：径向加亮"""
    if k <= 0: return a
    y, x = np.ogrid[0:H, 0:W]; d2 = ((x - xy[0]) ** 2 + (y - xy[1]) ** 2) / (r * r)
    g = np.exp(-d2) * 1.0 + np.exp(-d2 / 9) * .35
    return a + (g * k)[..., None] * np.array(color, np.float32)

def vignette(a, k=0.4):
    y, x = np.ogrid[0:H, 0:W]
    r = np.sqrt(((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2) / 1.414
    return a * (1 - k * r ** 2.4)[..., None]

def band(a, y0, y1, k=0.55):
    yy = np.arange(H, dtype=np.float32)
    m = np.clip(1 - np.abs(yy - (y0 + y1) / 2) / ((y1 - y0) / 2 + 80), 0, 1) ** 0.8
    return a * (1 - k * m)[:, None, None]

def shake(t, t0, amp=18, dur=0.7, f=1.0):
    if t < t0 or t > t0 + dur: return (0.0, 0.0)
    e = (1 - (t - t0) / dur) ** 2 * amp
    return (e * math.sin(t * 91 * f), e * math.cos(t * 77 * f))

def grain(a, seed, k=0.014):
    r = np.random.default_rng(seed).standard_normal((H // 2, W // 2)).astype(np.float32)
    return a + np.repeat(np.repeat(r, 2, 0), 2, 1)[..., None] * k

def iris(a, box, k, radius=90, blur=50):
    if k <= 0: return a
    m = Image.new('L', (W, H), 0); ImageDraw.Draw(m).rounded_rectangle(box, radius, fill=255)
    m = m.resize((W // 4, H // 4), Image.BILINEAR).filter(ImageFilter.GaussianBlur(blur / 4)).resize((W, H), Image.BILINEAR)
    q = np.asarray(m).astype(np.float32) / 255
    return a * (1 - k + k * q)[..., None]

def lerp(a, b, f): return a + (b - a) * f
def lerp_box(b0, b1, f): return tuple(x + (y - x) * f for x, y in zip(b0, b1))

def wobble(pts, amp=2.0, seed=0):
    r = np.random.default_rng(seed)
    return [(x + r.normal() * amp, y + r.normal() * amp) for x, y in pts]

def poly_upto(pts, upto):
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); out = [pts[0]]; s = 0
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        if s + L >= tot:
            f = (tot - s) / L if L else 0; out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); break
        out.append(b); s += L
    return out

def dashed(d, pts, fill, width=3, dash=16, gap=11, upto=1.0):
    seg = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
    tot = sum(seg) * clamp(upto); s = 0.0
    for (a, b), L in zip(zip(pts, pts[1:]), seg):
        n = 0.0
        while n < L and s + n < tot:
            e = min(n + dash, L, tot - s)
            if L > 0:
                d.line([(a[0] + (b[0] - a[0]) * n / L, a[1] + (b[1] - a[1]) * n / L),
                        (a[0] + (b[0] - a[0]) * e / L, a[1] + (b[1] - a[1]) * e / L)], fill=fill, width=width)
            n += dash + gap
        s += L
        if s >= tot: break

def bez(p0, p1, p2, n=60):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in np.linspace(0, 1, n)]

def ellipse_pts(cx, cy, rx, ry, a0=-100, a1=280, n=90, seed=0):
    r = np.random.default_rng(seed); ph = r.uniform(0, 6)
    return [(cx + rx * (1 + .04 * math.sin(3 * th + ph)) * math.cos(th), cy + ry * (1 + .05 * math.sin(2 * th + ph)) * math.sin(th))
            for th in np.radians(np.linspace(a0, a1, n))]

def txt(d, xy, s, font, fill, alpha=1.0, anchor='ls', shadow=0, stroke=0, stroke_fill=(0, 0, 0)):
    a = int(255 * clamp(alpha))
    if a <= 0: return
    if shadow:
        d.text((xy[0] + shadow, xy[1] + shadow), s, font=font, fill=(0, 0, 0, int(a * .55)), anchor=anchor)
    d.text(xy, s, font=font, fill=tuple(fill[:3]) + (a,), anchor=anchor,
           stroke_width=stroke, stroke_fill=tuple(stroke_fill[:3]) + (int(a * .85),) if stroke else None)

# ---------------------------------------------------------------- 纸与墨
@lru_cache(None)
def paper_tex(w, h, seed=1, dark=False):
    """做旧纸：低频斑 + 纤维 + 噪点"""
    r = np.random.default_rng(seed)
    lo = ndi.gaussian_filter(r.standard_normal((h // 8 + 2, w // 8 + 2)), 3)
    lo = np.asarray(Image.fromarray(lo.astype(np.float32)).resize((w, h), Image.BICUBIC))
    fib = ndi.gaussian_filter(r.standard_normal((h, w)), (0.6, 4))
    n = r.standard_normal((h, w)) * .5
    v = lo * .05 + fib * .03 + n * .02
    c = np.array(CREAM if not dark else (52, 40, 32), np.float32) / 255
    a = c[None, None, :] + v[..., None] * (np.array([1, .9, .75]) if not dark else np.array([.6, .5, .4]))
    yy, xx = np.ogrid[0:h, 0:w]
    rr = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / 1.414
    a = a * (1 - .28 * rr ** 2.5)[..., None]
    return np.clip(a, 0, 1).astype(np.float32)

def torn_mask(w, h, seed=0, amp=3.5):
    r = np.random.default_rng(seed); m = Image.new('L', (w, h), 0); d = ImageDraw.Draw(m)
    n = 40; pts = []
    for i in range(n): pts.append((w * i / n, 2 + abs(r.normal()) * amp))
    for i in range(n): pts.append((w - 2 - abs(r.normal()) * amp, h * i / n))
    for i in range(n): pts.append((w - w * i / n, h - 2 - abs(r.normal()) * amp))
    for i in range(n): pts.append((2 + abs(r.normal()) * amp, h - h * i / n))
    d.polygon(pts, fill=255); return m

def paper_card(w, h, seed=0, dark=False):
    """RGBA 纸片：做旧纸 + 毛边"""
    a = paper_tex(w, h, seed, dark)
    im = Image.fromarray((a * 255).astype(np.uint8)).convert('RGBA'); im.putalpha(torn_mask(w, h, seed)); return im

def paste_rot(ov, card, xy, ang=0.0, alpha=1.0, scale=1.0, shadow=True):
    """把 RGBA 卡片按中心 xy 旋转缩放贴到 ov 上（带落影）"""
    if alpha <= 0: return
    c = card
    if scale != 1.0: c = c.resize((max(1, int(c.width * scale)), max(1, int(c.height * scale))), Image.LANCZOS)
    if ang: c = c.rotate(ang, Image.BICUBIC, expand=True)
    if alpha < 1:
        al = c.split()[3].point(lambda v: int(v * alpha)); c = c.copy(); c.putalpha(al)
    x, y = int(xy[0] - c.width / 2), int(xy[1] - c.height / 2)
    if shadow:
        s = Image.new('RGBA', c.size, (0, 0, 0, 0)); s.putalpha(c.split()[3].point(lambda v: int(v * .45)))
        _safe_comp(ov, s.filter(ImageFilter.GaussianBlur(6)), x + 6, y + 8)
    _safe_comp(ov, c, x, y)

def _safe_comp(ov, c, x, y):
    x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + c.width), min(H, y + c.height)
    if x1 <= x0 or y1 <= y0: return
    ov.alpha_composite(c.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))

# ---------------------------------------------------------------- 人物票签
@lru_cache(None)
def ticket(name, line1, line2, color, seed=0):
    w = 430; h = 150 if line2 else 112
    c = paper_card(w, h, seed); d = ImageDraw.Draw(c)
    d.ellipse([18, h / 2 - 9, 36, h / 2 + 9], fill=(70, 50, 36, 255)); d.ellipse([22, h / 2 - 5, 32, h / 2 + 5], fill=(30, 20, 14, 255))
    d.rectangle([50, 18, 56, h - 18], fill=tuple(color) + (255,))
    d.text((72, 58), name, font=FS(42), fill=INK + (255,), anchor='ls')
    d.text((72 + d.textlength(name, font=FS(42)) + 14, 56), line1, font=FS(22, 'bold'), fill=(120, 80, 52, 255), anchor='ls')
    if line2: d.text((72, 102), line2, font=FS(23, 'reg'), fill=INK + (235,), anchor='ls')
    d.line([(72, h - 22), (w - 26, h - 22)], fill=(120, 90, 60, 120), width=1)
    return c

def draw_tag(ov, key, xy, target, alpha, ang=-2.0, seed=0):
    """票签 + 一根细绳连到人物"""
    if alpha <= 0: return
    name, l1, l2, col = key
    c = ticket(name, l1, l2, col, seed)
    hole = (xy[0] - c.width / 2 + 27, xy[1])
    d = ImageDraw.Draw(ov)
    k = eo(alpha)
    end_ = (lerp(hole[0], target[0], k), lerp(hole[1], target[1], k))
    mid = ((hole[0] + end_[0]) / 2, max(hole[1], end_[1]) + 40)
    d.line(bez(hole, mid, end_, 30), fill=(40, 26, 18, int(220 * alpha)), width=2)
    if k > .95: d.ellipse([end_[0] - 5, end_[1] - 5, end_[0] + 5, end_[1] + 5], fill=(40, 26, 18, int(255 * alpha)))
    paste_rot(ov, c, xy, ang, alpha, scale=.9 + .1 * eo(alpha))

# ---------------------------------------------------------------- 日落钟
def sun_clock(ov, t, alpha, cx=W - 190, cy=130, R=86, big=False, marks=None, mm=None, A0=-150):
    """太阳弧：左端 13:30，右端地平线 19:42。mm=故事分钟（距 16:00）"""
    if alpha <= 0: return
    d = ImageDraw.Draw(ov); a = int(255 * alpha)
    m = story_min(t) if mm is None else mm
    # 默认 13:30 在左侧高处、19:42 落在右侧地平线；回顾页用 A0=0（16:00 起）
    def pos(mi, r=R):
        th = math.radians(165 - 165 * (mi - A0) / (SUNSET - A0))
        return cx + r * math.cos(th), cy - r * math.sin(th)
    if not big:
        card = clock_card(); paste_rot(ov, card, (cx - 10, cy + 6), 0, alpha, shadow=True)
    col = INK + (a,)
    lw = 2 if not big else 4
    d.line([(cx - R - 26, cy), (cx + R + 26, cy)], fill=col, width=lw)              # 地平线
    pts = [pos(mi) for mi in np.linspace(A0, SUNSET, 60)]
    dashed(d, pts, (90, 64, 44, a), width=lw, dash=4 if not big else 10, gap=5 if not big else 12)
    for mi in range(-120, SUNSET, 60):                                             # 整点刻度
        if mi < A0: continue
        p0, p1 = pos(mi, R - (6 if not big else 14)), pos(mi, R + (6 if not big else 14))
        d.line([p0, p1], fill=col, width=lw)
    done = [pos(mi) for mi in np.linspace(A0, min(m, SUNSET), 40)]
    if len(done) > 1: d.line(done, fill=(196, 92, 40, a), width=lw + 1)
    sx, sy = pos(min(m, SUNSET + 4))
    if m > SUNSET:                                                                 # 落下去
        sy = cy + (m - SUNSET) * (1.4 if not big else 3)
    rs = 11 if not big else 30
    if sy - rs < cy:                                                               # 只画地平线以上那部分
        circ = [(sx + rs * math.cos(th), min(cy, sy + rs * math.sin(th))) for th in np.linspace(0, 2 * math.pi, 48)]
        d.polygon(circ, fill=(226, 104, 44, a), outline=(120, 50, 20, a))
    if marks: marks(d, pos, m)
    if not big:
        hh, mn = divmod(int(round(960 + m)), 60)
        left = max(0, SUNSET - m); lh, lm = divmod(int(round(left)), 60)
        d.text((cx - R - 24, cy + 40), f'{hh:02d}:{mn:02d}', font=FC(30, 'black'), fill=col, anchor='ls')
        lab = f'距日落 {lh}:{lm:02d}' if left > .5 else '日落'
        d.text((cx + R + 24, cy + 38), lab, font=FS(22, 'bold'), fill=(150, 64, 30, a), anchor='rs')

@lru_cache(None)
def clock_card(): return paper_card(300, 196, seed=11)

# ---------------------------------------------------------------- 章节印章
@lru_cache(None)
def chap_card(no, name, sub):
    f1, f2, f3 = FC(64, 'black'), FS(62), FS(24, 'bold')
    tmp = ImageDraw.Draw(Image.new('L', (10, 10)))
    w = int(max(110 + tmp.textlength(name, font=f2) + 40, tmp.textlength(sub, font=f3) + 70))
    c = paper_card(w, 160, seed=int(no) + 3); d = ImageDraw.Draw(c)
    d.text((28, 86), no, font=f1, fill=(176, 70, 34, 255), anchor='ls')
    d.text((28 + tmp.textlength(no, font=f1) + 18, 84), name, font=f2, fill=INK + (255,), anchor='ls')
    d.line([(30, 106), (w - 30, 106)], fill=INK + (150,), width=2)
    d.text((30, 140), sub, font=f3, fill=(110, 76, 50, 255), anchor='ls')
    # 印刷不均：随机掉墨
    r = np.random.default_rng(int(no)); A = np.asarray(c).copy()
    holes = ndi.gaussian_filter(r.random(A.shape[:2]), 1.2) > .62
    ink = A[..., :3].mean(2) < 150
    A[..., :3][holes & ink] = (A[..., :3][holes & ink] * .4 + np.array(CREAM) * .6).astype(np.uint8)
    return Image.fromarray(A)

def chapter(ov, t):
    for t0, no, name, sub in CHAP:
        if t0 - .1 <= t <= t0 + 3.6:
            k = clamp((t - t0) / .22); al = win(t, t0, t0 + 3.6, .12, .5)
            sc = 1.18 - .18 * eo(k); ang = -3 + 1.5 * eo(k)
            c = chap_card(no, name, sub)
            paste_rot(ov, c, (70 + c.width / 2, 92 + c.height / 2), ang, al * k, scale=sc)

# ---------------------------------------------------------------- 镜片窗（只给三个功能）
FEAT = SRC + 'feature-scenes3.png'
PANEL = {1: (32, 125, 557, 826), 2: (582, 125, 1092, 826), 3: (1117, 125, 1642, 826)}
PHUD = {1: (122, 203, 473, 308), 2: (627, 622, 1048, 735), 3: (1203, 203, 1463, 297)}

def inpaint(a, m):
    keep = (m < 0.05).astype(np.float32); out = a.copy()
    for s in (6, 14, 30, 60):
        num = ndi.gaussian_filter(a * keep[..., None], (s, s, 0)); den = ndi.gaussian_filter(keep, s)[..., None]
        fill = num / np.maximum(den, 1e-4)
        out = np.where((m > 0.02)[..., None] & (den > 0.02), fill, out)
        keep = np.maximum(keep, ((den[..., 0] > .02) & (m > .02)).astype(np.float32))
    return out

@lru_cache(None)
def pov(n):
    """功能页 POV 小图，去掉烘进去的 HUD（之后由代码重画）"""
    im = Image.open(FEAT).convert('RGB'); a = np.pad(np.asarray(im).astype(np.float32) / 255, ((40, 40), (40, 40), (0, 0)), mode='edge')
    x0, y0, x1, y1 = [v + 40 for v in PANEL[n]]; hx0, hy0, hx1, hy1 = [v + 40 for v in PHUD[n]]
    m = np.zeros(a.shape[:2], np.float32); m[hy0 - 18:hy1 + 18, hx0 - 18:hx1 + 18] = 1
    sub = a[y0 - 40:y1 + 40, x0 - 40:x1 + 40]; ms = m[y0 - 40:y1 + 40, x0 - 40:x1 + 40]
    # 只在面板内取样
    inside = np.zeros_like(ms); inside[40:-40, 40:-40] = 1
    fill = inpaint(sub * inside[..., None], np.maximum(ms, 1 - inside))
    sub = np.where((ms > 0)[..., None], fill, sub)[40:-40, 40:-40]
    sub = ndi.gaussian_filter(sub, (0.6, 0.6, 0)) * .0 + sub
    return sub

@lru_cache(None)
def avatar():
    im = Image.open(FEAT).convert('RGB').crop((137, 210, 228, 301)).resize((96, 96), Image.LANCZOS)
    m = Image.new('L', (96, 96), 0); ImageDraw.Draw(m).ellipse([1, 1, 95, 95], fill=255)
    im = im.convert('RGBA'); im.putalpha(m); return im

def panel_map(box, n):
    """镜片窗里 POV 小图的坐标（功能页原图坐标）→ 屏幕坐标"""
    x0, y0, x1, y1 = box; w, h = x1 - x0, y1 - y0; px0, py0, px1, py1 = PANEL[n]; cw, ch = px1 - px0, py1 - py0
    s = max(w / cw, h / ch); ox, oy = (cw * s - w) / 2, (ch * s - h) / 2
    return (lambda x, y: (x0 + (x - px0) * s - ox, y0 + (y - py0) * s - oy)), s

def lens_poly(box, k=0.0):
    """太阳镜镜片形：上宽下略收，大圆角"""
    x0, y0, x1, y1 = box; w, h = x1 - x0, y1 - y0; pts = []
    for th in np.linspace(0, 2 * math.pi, 120, endpoint=False):
        c, s = math.cos(th), math.sin(th)
        ex = 2 / 5.0
        px = abs(c) ** ex * (1 if c >= 0 else -1); py = abs(s) ** ex * (1 if s >= 0 else -1)
        squeeze = 1 - .08 * (py + 1) / 2                      # 下沿收窄
        pts.append((x0 + w / 2 + px * w / 2 * squeeze, y0 + h / 2 + py * h / 2))
    return pts

def lens_window(a, box, content, alpha, label='', glitch=0.0, t=0.0):
    """把 content(数组, 任意尺寸) 填进镜片形窗口；背景压暗；返回新数组和 HUD 画布函数所需的映射"""
    if alpha <= 0: return a
    x0, y0, x1, y1 = [int(round(v)) for v in box]; w, h = max(2, x1 - x0), max(2, y1 - y0)
    m = Image.new('L', (W, H), 0); ImageDraw.Draw(m).polygon(lens_poly(box), fill=255)
    m = m.filter(ImageFilter.GaussianBlur(1.2)); M = np.asarray(m).astype(np.float32) / 255 * alpha
    a = a * (1 - .45 * alpha)                                                          # 背景压暗
    ch, cw = content.shape[:2]; s = max(w / cw, h / ch)
    ci = img(content).resize((max(1, int(cw * s)), max(1, int(ch * s))), Image.LANCZOS)
    ox, oy = (ci.width - w) // 2, (ci.height - h) // 2
    ci = arr(ci.crop((ox, oy, ox + w, oy + h)))
    if glitch > 0:
        r = np.random.default_rng(int(t * 100))
        for _ in range(int(6 * glitch)):
            yy = r.integers(0, h - 10); hh = r.integers(4, 30); dx = int(r.normal() * 40 * glitch)
            ci[yy:yy + hh] = np.roll(ci[yy:yy + hh], dx, 1)
        ci[..., 0] = np.roll(ci[..., 0], int(8 * glitch), 1); ci = ci * (1 - .3 * glitch)
    full = np.zeros((H, W, 3), np.float32)
    X0, Y0 = max(0, x0), max(0, y0); X1, Y1 = min(W, x0 + w), min(H, y0 + h)
    full[Y0:Y1, X0:X1] = ci[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
    a = a * (1 - M[..., None]) + full * M[..., None]
    # 镜框：黑色板材 + 一道高光
    fr = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(fr)
    pl = lens_poly(box); d.line(pl + [pl[0]], fill=(14, 12, 12, int(250 * alpha)), width=16, joint='curve')
    d.line(pl[50:75], fill=(120, 110, 100, int(150 * alpha)), width=3)
    a = arr(over(img(a), fr))
    return a

def hud_box(d, L, box, alpha, icon='phone'):
    """PPT 同款绿色面板：深绿底、亮绿描边、四角括号。d 画在 RGBA 上，L 画在发光层"""
    if alpha <= 0: return
    x0, y0, x1, y1 = box; A = int(255 * alpha)
    d.rounded_rectangle(box, 14, fill=LENS_BG + (int(205 * alpha),), outline=LENS + (int(200 * alpha),), width=2)
    c = 18
    for (cx, cy, sx, sy) in [(x0 - 5, y0 - 5, 1, 1), (x1 + 5, y0 - 5, -1, 1), (x0 - 5, y1 + 5, 1, -1), (x1 + 5, y1 + 5, -1, -1)]:
        L.line([(cx, cy + sy * c), (cx, cy), (cx + sx * c, cy)], fill=int(255 * alpha), width=3)

def icon(d, L, kind, cx, cy, r, alpha, prog=1.0):
    A = int(255 * alpha)
    if kind == 'phone':
        L.ellipse([cx - r, cy - r, cx + r, cy + r], outline=A, width=3)
        # 听筒：两端圆头的弧
        L.arc([cx - r * .55, cy - r * .55, cx + r * .55, cy + r * .55], 110, 250, fill=A, width=int(r * .28))
        for th in (110, 250):
            px, py = cx + r * .55 * math.cos(math.radians(th)), cy + r * .55 * math.sin(math.radians(th))
            L.ellipse([px - r * .2, py - r * .2, px + r * .2, py + r * .2], fill=A)
    elif kind == 'globe':
        L.ellipse([cx - r, cy - r, cx + r, cy + r], outline=A, width=3)
        L.ellipse([cx - r * .45, cy - r, cx + r * .45, cy + r], outline=A, width=2)
        L.line([(cx - r, cy), (cx + r, cy)], fill=A, width=2)
        L.line([(cx - r * .85, cy - r * .5), (cx + r * .85, cy - r * .5)], fill=A, width=2)
        L.line([(cx - r * .85, cy + r * .5), (cx + r * .85, cy + r * .5)], fill=A, width=2)
    elif kind == 'check':
        L.ellipse([cx - r, cy - r, cx + r, cy + r], outline=A, width=3)
        pts = [(cx - r * .45, cy + r * .02), (cx - r * .1, cy + r * .38), (cx + r * .5, cy - r * .35)]
        L.line(poly_upto(pts, prog), fill=A, width=5, joint='curve')
    elif kind == 'wave':
        pass

def wave(L, x0, x1, cy, amps, alpha, hmax=22):
    n = len(amps); A = int(255 * alpha); step = (x1 - x0) / n
    for i, v in enumerate(amps):
        x = x0 + i * step + step / 2; hh = max(2, v * hmax)
        L.line([(x, cy - hh), (x, cy + hh)], fill=A, width=max(2, int(step * .45)))

# 声音包络（通话波形用）
_ENV = {}
def env_of(keys):
    k = tuple(keys)
    if k not in _ENV:
        n = int(TOTAL * 60) + 1; e = np.zeros(n, np.float32)
        for kk in keys:
            x = rd(VO + f'wav/{kk}.wav'); fr = len(x) // 735
            r = np.sqrt((x[:fr * 735].reshape(fr, 735) ** 2).mean(1)); r = (r / (np.percentile(r, 95) + 1e-6)) ** .8
            a = int(T[kk] * 60); e[a:a + fr] = np.maximum(e[a:a + fr], r[:n - a])
        _ENV[k] = np.clip(e, 0, 1)
    return _ENV[k]

def amps_at(keys, t, n=22, seed=0):
    e = env_of(keys); i = int(t * 60)
    r = np.random.default_rng(i * 7 + seed)
    base_ = [e[int(clamp(i - j, 0, len(e) - 1))] for j in range(n)]
    return [clamp(b * (.55 + .9 * r.random()) + .06) for b in base_]

def gtext(L, xy, s, font, alpha, anchor='ls'):
    if alpha <= 0 or not s: return
    L.text(xy, s, font=font, fill=int(255 * alpha), anchor=anchor)

def apply_hud(a, ov, Lm):
    a = arr(over(img(a), ov))                                   # 先铺面板底
    a = glow(a, Lm, LENS, core=0.0, s1=1.5, s2=8, k1=.55, k2=.3)  # 再加光晕
    m = np.asarray(Lm).astype(np.float32)[..., None] / 255      # 字芯用亮薄荷色，保证对比
    return a * (1 - m) + np.array([.84, 1.0, .9], np.float32) * m

# ---------------------------------------------------------------- 字幕
def chunks(k):
    t = LINES[k]['zh']; parts, cur = [], ''
    for c in t:
        cur += c
        if c in '。！？；' or (c == '，' and len(cur) > 13):
            parts.append(cur); cur = ''
    if cur: parts.append(cur)
    tot = sum(len(p) for p in parts); s = T[k]; out = []
    for p in parts:
        dd = DUR[k] * len(p) / tot; out.append((p.rstrip('，。；'), s, s + dd)); s += dd
    return out

NARR = [(c, a, b) for k, _ in ORDER if k[0] == 'n' for c, a, b in chunks(k)]
DIAL = [k for k, _ in ORDER if k[0] in 'cyegbk']
WHO_COL = {'陆川': CHUAN, '陆遥': YAO, '埃斯特班': ESTE, '看守': GANG, '头目': GANG, '店员': SUB}
PHONE = {'y01', 'g01', 'y02'}
_ds = sorted(DIAL + [k for k, _ in ORDER if k[0] in 'tn'], key=lambda k: T[k])
DEND = {k: min(end(k) + .45, min([T[j] - .12 for j in _ds if T[j] > T[k] + .05 and j[0] in 'cyegbk'] or [1e9])) for k in DIAL}

def subtitles(im, t, scene):
    ov = rgba(); d = ImageDraw.Draw(ov); need = False
    for c, s, e in NARR:
        if s - .1 <= t <= e + .15:
            al = ramp(t, s - .1, s + .08) * (1 - ramp(t, e, e + .15))
            txt(d, (W / 2, H - 64), c, FS(40, 'bold'), CREAM, al, 'ms', shadow=0, stroke=3, stroke_fill=(20, 12, 8)); need = True
    for k in DIAL:
        x = LINES[k]
        if k in ('e01', 'e02', 'e03'): continue                        # 翻译在镜片里
        s, e = T[k], DEND[k]
        if s - .15 <= t <= e + .2:
            al = ramp(t, s - .15, s + .1) * (1 - ramp(t, e, e + .2)); need = True
            who = x['who'] + ('（电话）' if k in PHONE else '')
            col = WHO_COL.get(x['who'], SUB)
            y = H - 70
            if 'es' in x:
                txt(d, (W / 2, y - 50), x['es'], FT(34, 'semi'), (236, 226, 206), al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
                if k == 'g01': txt(d, (W / 2, y), '（西班牙语，他听不懂）', FS(30, 'bold'), SUB, al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
                else: txt(d, (W / 2, y), x['zh'], FS(40, 'bold'), CREAM, al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
                txt(d, (W / 2, y - 102), who, FS(26, 'black'), col, al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
            else:
                txt(d, (W / 2, y), x['zh'], FS(44, 'bold'), CREAM, al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
                txt(d, (W / 2, y - 56), who, FS(26, 'black'), col, al, 'ms', stroke=3, stroke_fill=(20, 12, 8))
    if need and scene not in ('hero', 'recap'):
        im = img(band(arr(im), H - 190, H, .42))
    return over(im, ov)

# ---------------------------------------------------------------- 场景
def loc(t, name):
    s = SCD[name]; return (t - s[1]) / (s[2] - s[1]), t - s[1]

def sunpos(mp, k):
    x, y, r = SUN[k]; sx, sy = mp(x, y); return sx, sy

TAG_CHUAN = ('陆川', '45 · 退役搜救员', '话少，习惯替所有人做决定', CHUAN)
TAG_YAO = ('陆遥', '19 · 他的女儿', '在拍边境野生动物的影像作业', YAO)
TAG_ESTE = ('埃斯特班', '60 · 牧场主', '只会说西班牙语', ESTE)
TAG_BOSS = ('头目', '借废弃矿场中转盗猎赃物', '', GANG)

def sc_open(t):
    u, lt = loc(t, 'open')
    cam = Cam([(0, 1.0, 960, 540, 14, 4), (.55, 1.05, 1000, 560, 16, 4), (1, 1.1, 1060, 560, 18, 4)])
    a, mp, z = cam_bg('image', cam, u)
    a = grade(a, sat=.92, warm=.2)
    a = a * ramp(t, .4, 2.2)
    ov = rgba(); d = ImageDraw.Draw(ov)
    # 片名：木活字印章感
    k = clamp((t - 2.0) / .25); ta = ramp(t, 2.0, 2.1) * (1 - ramp(t, T['n01'] + .6, T['n01'] + 1.3))
    if ta > 0:
        tc = title_card(); sc = 1.25 - .25 * eo(k)
        paste_rot(ov, tc, (520, 360), -1.5, ta, scale=sc, shadow=False)
    sx, sy = sunpos(mp, 'image')
    draw_tag(ov, TAG_CHUAN, (1060, 230), mp(1530, 330), win(t, at('n01', .45), SCD['open'][2] - .2, .5, .4), -2, 1)
    draw_tag(ov, TAG_YAO, (420, 520), mp(940, 690), win(t, T['n02'] - .1, SCD['open'][2] - .2, .5, .4), 1.5, 2)
    a = bloom(a, (sx, sy), 70 * z, .18 * ramp(t, .8, 2.5))
    return over(img(a), ov), (sx, sy)

@lru_cache(None)
def title_card():
    c = Image.new('RGBA', (900, 420), (0, 0, 0, 0)); d = ImageDraw.Draw(c)
    d.text((450, 220), '日落之前', font=FS(176), fill=(64, 30, 18, 255), anchor='ms')
    d.text((450, 300), '救她，也学会被救', font=FS(46, 'bold'), fill=(150, 62, 30, 255), anchor='ms')
    d.line([(150, 330), (750, 330)], fill=(64, 30, 18, 200), width=2)
    d.text((450, 372), '乐奇 AI 太阳镜  ·  约 8 分钟故事提案', font=FS(26, 'bold'), fill=(90, 60, 40, 255), anchor='ms')
    A = np.asarray(c).copy(); r = np.random.default_rng(5)
    holes = ndi.gaussian_filter(r.random(A.shape[:2]), 1.4) > .64
    A[..., 3][holes] = (A[..., 3][holes] * .35).astype(np.uint8)
    return Image.fromarray(A)

def sc_call(t):
    u, lt = loc(t, 'call')
    cam = Cam([(0, 1.04, 940, 470, 10, 3), (.45, 1.1, 900, 460, 12, 3), (.8, 1.16, 880, 450, 12, 3), (1, 1.2, 870, 450, 12, 3)])
    a, mp, z = cam_bg('image2', cam, u)
    a = grade(a, sat=.95, warm=.1)
    ring = T['y01'] - 2.6; opn = T['y01'] - 1.8; ans = T['y01'] - .7
    ix, iy = mp(630, 276)
    ov = rgba(); d = ImageDraw.Draw(ov); Lm = Image.new('L', (W, H), 0); L = ImageDraw.Draw(Lm)
    # 镜腿上的来电灯：一圈圈脉冲
    if ring <= t < opn + .3:
        for j in range(3):
            ph = ((t - ring) * 1.6 - j / 3) % 1
            r = 14 + ph * 70; L.ellipse([ix - r, iy - r, ix + r, iy + r], outline=int(255 * (1 - ph) * .9), width=3)
    box_lens = (mp(500, 240)[0], mp(500, 240)[1], mp(1360, 590)[0], mp(1360, 590)[1])
    wbox = (1170, 96, 1770, 900)
    k = eo(clamp((t - opn) / .55)); cl = eo(clamp((t - (DROP + 1.3)) / .5))
    al = ramp(t, opn, opn + .15) * (1 - cl)
    sx, sy = sunpos(mp, 'image2')
    if al > 0:
        box = lerp_box(box_lens, wbox, k) if cl == 0 else lerp_box(wbox, (ix - 10, iy - 10, ix + 10, iy + 10), cl)
        gl = clamp((t - DROP) / .25) * (1 - clamp((t - DROP - .9) / .4)) if t > DROP else 0
        a = lens_window(a, box, pov(1), al, glitch=gl, t=t)
        if k > .9 and cl == 0:
            pm, s = panel_map(box, 1)
            hb = (*pm(116, 197), *pm(479, 314))
            ha = ramp(t, opn + .5, opn + .8)
            hud_box(d, L, hb, ha)
            ov.alpha_composite(avatar().resize((int(86 * s), int(86 * s))), (int(hb[0] + 12 * s), int(hb[1] + 9 * s)))
            fx = hb[0] + 112 * s
            if t < ans:
                gtext(L, (fx, hb[1] + 40 * s), '女儿来电', FH(int(26 * s), True), ha)
                gtext(L, (fx, hb[1] + 84 * s), '陆遥', FH(int(20 * s)), ha * .85)
            elif t < DROP:
                gtext(L, (fx, hb[1] + 36 * s), '女儿来电', FH(int(24 * s), True), ha)
                wave(L, fx, fx + 150 * s, hb[1] + 56 * s, amps_at(('y01', 'g01', 'c01', 'y02'), t, 16), ha, 13 * s)
                sec = int(t - ans); gtext(L, (fx, hb[1] + 92 * s), f'通话中  00:{sec:02d}', FH(int(19 * s)), ha * .9)
            else:
                gtext(L, (fx, hb[1] + 36 * s), '女儿来电', FH(int(24 * s), True), ha * .6)
                L.line([(fx, hb[1] + 56 * s), (fx + 150 * s, hb[1] + 56 * s)], fill=int(200 * ha), width=2)
                gtext(L, (fx, hb[1] + 92 * s), '通话中断', FH(int(21 * s), True), ha)
            icon(d, L, 'phone', hb[2] - 42 * s, (hb[1] + hb[3]) / 2, 24 * s, ha)
            gtext(L, (box[0] + 40, box[3] - 40), '眼镜功能 · 通话', FH(22), ha * .9)
    a = apply_hud(a, ov, Lm)
    # 中断之后：那句听不懂的外语留在空气里
    if t > end('y02') + .3:
        ov = rgba(); d = ImageDraw.Draw(ov); e = win(t, at('n03', .45), SCD['call'][2] + .3, .6, .5)
        txt(d, (430, 760), '¡Dame el teléfono!', FT(64, 'semi'), (246, 232, 206), e * .9, 'ms', stroke=4, stroke_fill=(30, 18, 12))
        txt(d, (430, 812), '？', FS(46), (246, 232, 206), e * .7, 'ms', stroke=3, stroke_fill=(30, 18, 12))
        a = arr(over(img(a), ov))
        a = grade(a, sat=1 - .35 * e)
    return img(a), (sx, sy)

# 摩托：从原图里抠出来，沿车辙往前开
@lru_cache(None)
def bike_sprite():
    a = base('image3'); x0, y0, x1, y1 = 912, 905, 990, 975
    sub = a[y0:y1, x0:x1]; lum = sub.mean(2)
    m = (lum < .42).astype(np.float32)
    m = ndi.binary_closing(m > 0, iterations=2); m = ndi.binary_fill_holes(m)
    lab, n = ndi.label(m)
    if n > 1:
        sz = ndi.sum(m, lab, range(1, n + 1)); keep = 1 + int(np.argmax(sz)); m = lab == keep
    m = ndi.gaussian_filter(ndi.binary_dilation(m, iterations=2).astype(np.float32), .8)
    full = np.zeros(a.shape[:2], np.float32); full[y0:y1, x0:x1] = m
    ys, xs = np.nonzero(full > .05); cy_, cx_ = ys.mean(), xs.mean()
    ry, rx = (ys.max() - ys.min()) / 2 + 10, (xs.max() - xs.min()) / 2 + 12
    yy, xx = np.ogrid[0:H, 0:W]; hole = (((xx - cx_) / rx) ** 2 + ((yy - cy_) / ry) ** 2 <= 1.3).astype(np.float32)
    hole = ndi.gaussian_filter(hole, 4)[..., None]                     # 用车前方的地面贴补（带羽化）
    clean = a * (1 - hole) + np.roll(a, -170, 1) * hole
    return clean, sub, m, (x0, y0)

def sc_ride(t):
    u, lt = loc(t, 'ride')
    clean, sub, m, (bx, by) = bike_sprite()
    dx = 300 * ss(u * .9 + .05); dy = -38 * ss(u * .9 + .05)
    src = clean.copy(); hh, ww = m.shape
    X, Y = int(bx + dx), int(by + dy)
    src[Y:Y + hh, X:X + ww] = src[Y:Y + hh, X:X + ww] * (1 - m[..., None]) + sub * m[..., None]
    cam = Cam([(0, 1.18, 860 + 0, 790, 26, 6), (1, 1.24, 1060, 770, 28, 6)])
    a, mp, z = cam_bg('image3', cam, u, src=src)
    a = grade(a, sat=.96, warm=.12)
    # 热浪：地平线一带横向扭动
    y0, y1 = int(mp(0, 690)[1]), int(mp(0, 790)[1]); y0 = max(0, y0); y1 = min(H, y1)
    if y1 > y0:
        rows = np.arange(y0, y1)
        off = (np.sin(rows * .19 + t * 7) * 1.6 + np.sin(rows * .07 - t * 4) * 1.0) * np.sin(np.pi * (rows - y0) / (y1 - y0))
        for c in range(3):
            a[y0:y1, :, c] = np.array([np.roll(a[r, :, c], int(round(o))) for r, o in zip(rows, off)])
    # 扬尘：车后不断冒出的沙团
    ov = rgba(); Ld = Image.new('L', (W, H), 0); d = ImageDraw.Draw(Ld)
    bxs, bys = mp(bx + dx + 20, by + dy + 52)
    rr = np.random.default_rng(4)
    for i in range(160):
        tb = SCD['ride'][1] - 2 + i * .08; age = t - tb
        if age < 0 or age > 2.6: continue
        ub = clamp((tb - SCD['ride'][1]) / (SCD['ride'][2] - SCD['ride'][1]))
        ox, oy = mp(bx + 300 * ss(ub * .9 + .05) + 10, by - 38 * ss(ub * .9 + .05) + 54)
        vx, vy = -40 - rr.random() * 60, -10 - rr.random() * 22
        x = ox + vx * age * z; y = oy + vy * age * z
        r = (6 + age * 26) * z; A = int(110 * (1 - age / 2.6) ** 1.5)
        d.ellipse([x - r, y - r * .7, x + r, y + r * .7], fill=A)
    Ld = Ld.filter(ImageFilter.GaussianBlur(6))
    dm = np.asarray(Ld).astype(np.float32)[..., None] / 255
    a = a * (1 - dm * .55) + np.array([.82, .62, .45], np.float32) * dm * .55
    sx, sy = sunpos(mp, 'image3')
    a = bloom(a, (sx, sy), 60 * z, .12)
    return img(a), (sx, sy)

def translate_hud(d, L, box, k_es, k_zh, t, alpha, s=1.0):
    """实时翻译面板：上面西语原句（跟着说话出词），下面中文译句（跟着同传出字）"""
    if alpha <= 0: return
    hud_box(d, L, box, alpha)
    x0, y0, x1, y1 = box
    icon(d, L, 'globe', x0 + 34 * s, y0 + 34 * s, 15 * s, alpha)
    gtext(L, (x0 + 62 * s, y0 + 44 * s), '实时翻译', FH(int(24 * s), True), alpha)
    gtext(L, (x0 + 172 * s, y0 + 44 * s), '西班牙语 → 中文', FH(int(17 * s)), alpha * .75)
    on = t < end(k_es) + .2
    wave(L, x1 - 150 * s, x1 - 24 * s, y0 + 36 * s, amps_at((k_es, k_zh), t, 14, 3) if on else [0.05] * 14, alpha, 11 * s)
    es = LINES[k_es]['say']; n = typed(k_es, t)
    d.text((x0 + 26 * s, y0 + 82 * s), es[:n], font=FT(int(20 * s), 'reg'), fill=(190, 236, 206, int(210 * alpha)), anchor='ls')
    zh = LINES[k_zh]['zh']; m = typed(k_zh, t)
    gtext(L, (x0 + 26 * s, y0 + 126 * s), zh[:m], FH(int(30 * s), True), alpha)

def sc_ask(t):
    u, lt = loc(t, 'ask')
    cam = Cam([(0, 1.04, 960, 560, 16, 4), (.4, 1.12, 1120, 560, 18, 4), (.82, 1.16, 1150, 600, 18, 4), (1, 1.2, 1160, 800, 18, 4)])
    a, mp, z = cam_bg('image4', cam, u)
    a = grade(a, sat=.96, warm=.12)
    ov = rgba(); d = ImageDraw.Draw(ov); Lm = Image.new('L', (W, H), 0); L = ImageDraw.Draw(Lm)
    draw_tag(ov, TAG_ESTE, (1530, 250), mp(1250, 470), win(t, at('n05', .1), end('c02') + .3, .5, .4), 2, 3)
    opn = end('c02') - .1; k = eo(clamp((t - opn) / .5))
    sx, sy = sunpos(mp, 'image4')
    if t > opn:
        wb = (150, 90, 730, 890)
        box = lerp_box((mp(1200, 520)[0], mp(1200, 520)[1], mp(1260, 600)[0], mp(1260, 600)[1]), wb, k)
        a = lens_window(a, box, pov(2), ramp(t, opn, opn + .12))
        if k > .9:
            pm, s = panel_map(box, 2)
            hb = (*pm(600, 612), *pm(1074, 760))
            translate_hud(d, L, hb, 'e01', 't01', t, ramp(t, opn + .4, opn + .7), s * .98)
            gtext(L, (box[0] + 40, box[1] + 50), '眼镜功能 · 实时翻译', FH(22), ramp(t, opn + .4, opn + .7) * .9)
    a = apply_hud(a, ov, Lm)
    return img(a), (sx, sy)

# ---------------------------------------------------------------- 沙地图
MAP_T0 = T['e02']
def mt(x): return MAP_T0 + x
# 笔画：(点列, 起, 止)。俯视的沙地，北在上
STROKES = []
MO = (-190, 120)
def _o(p): return (p[0] + MO[0], p[1] + MO[1])
def _st(pts, a, b): STROKES.append((wobble([_o(p) for p in pts], 1.6, len(STROKES)), mt(a), mt(b)))
_st([(980, 1100), (972, 860), (960, 650)], .1, .9)                          # 来路
_st(bez((960, 650), (760, 520), (560, 300)), .9, 1.5)                       # 岔路左
_st(bez((960, 650), (1120, 520), (1200, 420)), 1.5, 2.1)                    # 岔路右 → 矿场
_st([(1140, 420), (1520, 400), (1540, 170), (1150, 190), (1140, 420)], 2.2, 3.5)   # 矿场围墙
_st([(1250, 390), (1330, 450)], 3.6, 3.8); _st([(1330, 390), (1250, 450)], 3.85, 4.05)   # 大门 ✕
_st(bez((1700, 470), (1640, 330), (1555, 300)), 4.2, 4.9)                   # 东边入口
_st([(1555, 300), (1578, 286)], 4.9, 5.0); _st([(1555, 300), (1578, 318)], 5.0, 5.1)
WATER = [_o(p) for p in bez((1840, 760), (1880, 120), (1340, 120), 80)]
STROKES.append((wobble(WATER, 1.6, 99), end('e02') + .7, end('e02') + 3.4))          # 运水便道（WATER 已平移）
_st([(1340, 120), (1340, 175)], end('e02') - MAP_T0 + 3.5, end('e02') - MAP_T0 + 3.8)
RED = _o((1650, 250)); RED_T = mt(4.6)

@lru_cache(None)
def sand():
    r = np.random.default_rng(9)
    lo = ndi.gaussian_filter(r.standard_normal((H // 6 + 2, W // 6 + 2)), 4)
    lo = np.asarray(Image.fromarray(lo.astype(np.float32)).resize((W, H), Image.BICUBIC))
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rip = np.sin((xx * .9 + yy * .45) * .045 + lo * 6) * .5 + .5
    rip = ndi.gaussian_filter(rip, 1.2)
    fine = r.standard_normal((H, W)).astype(np.float32)
    h = rip * .6 + lo * .8 + fine * .08
    gx = ndi.sobel(ndi.gaussian_filter(h, 1.0), 1); gy = ndi.sobel(ndi.gaussian_filter(h, 1.0), 0)
    shade = np.clip(.75 - (gx * .5 + gy * .6) * .9, .35, 1.2)
    col = np.array([.80, .58, .38], np.float32)
    a = col[None, None, :] * shade[..., None] * (1 + lo[..., None] * .06) + fine[..., None] * .025
    peb = (r.random((H, W)) > .9985).astype(np.float32)
    peb = ndi.gaussian_filter(peb, 1.6) * 10
    a = a * (1 - np.clip(peb, 0, .5)[..., None])
    return np.clip(a, 0, 1).astype(np.float32)

def groove_layer(t):
    G = Image.new('L', (W, H), 0); g = ImageDraw.Draw(G); tip = None
    for pts, a, b in STROKES:
        if t < a: continue
        f = clamp((t - a) / (b - a)); p = poly_upto(pts, f)
        if len(p) > 1: g.line(p, fill=255, width=11, joint='curve')
        if a <= t <= b: tip = p[-1]
    return G, tip

def sand_frame(t, still=False):
    a = sand().copy()
    G, tip = groove_layer(t)
    g = np.asarray(G.resize((W // 2, H // 2), Image.BILINEAR)).astype(np.float32) / 255
    dep = ndi.gaussian_filter(g, 2.2)
    gx = ndi.sobel(dep, 1); gy = ndi.sobel(dep, 0)
    sh = (gx * .7 + gy * .9)                                   # 光从左上：沟的上沿暗、下沿亮
    sh = np.asarray(Image.fromarray(sh.astype(np.float32)).resize((W, H), Image.BILINEAR))
    dep = np.asarray(Image.fromarray(dep.astype(np.float32)).resize((W, H), Image.BILINEAR))
    a = a * (1 - dep[..., None] * .38) + np.clip(sh, -1, 1)[..., None] * np.array([.42, .32, .22]) * .9
    rim = np.asarray(G.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32) / 255 - dep
    a = a + np.clip(rim, 0, 1)[..., None] * .05
    # 红水罐：一块红石头落下
    if t > RED_T:
        k = clamp((t - RED_T) / .35); bounce = abs(math.sin(k * math.pi * 1.5)) * (1 - k) * 30
        ov = rgba(); d = ImageDraw.Draw(ov); x, y = RED[0], RED[1] - bounce
        d.ellipse([x - 26 + 8, RED[1] - 16 + 12, x + 26 + 8, RED[1] + 16 + 12], fill=(40, 20, 10, 90))
        d.polygon([(x - 26, y - 4), (x - 12, y - 20), (x + 14, y - 22), (x + 28, y - 4), (x + 18, y + 16), (x - 16, y + 18)], fill=(168, 52, 30, 255))
        d.polygon([(x - 12, y - 18), (x + 12, y - 20), (x + 4, y - 6), (x - 10, y - 6)], fill=(214, 96, 60, 255))
        a = arr(over(img(a), ov))
    return a, tip

MAP_LABELS = [(_o((1240, 490)), '大门 · 锁着', mt(4.1)), (_o((1600, 200)), '东边 · 红水罐', end('t02') - .3), (_o((1560, 640)), '运水便道', end('t03') - .2),
              (_o((640, 250)), '公路', mt(1.6)), (_o((1280, 300)), '矿场', mt(3.6))]

def map_ink(ov, t, alpha=1.0, s=1.0, ox=0, oy=0):
    d = ImageDraw.Draw(ov)
    for (x, y), lab, t0 in MAP_LABELS:
        al = ramp(t, t0, t0 + .4) * alpha
        if al <= 0: continue
        f = FS(int(32 * s), 'black'); tw = d.textlength(lab, font=f)
        X, Y = ox + x * s, oy + y * s
        d.rounded_rectangle([X - 12 * s, Y - 36 * s, X + tw + 12 * s, Y + 12 * s], 6, fill=(244, 232, 206, int(225 * al)))
        d.text((X, Y), lab, font=f, fill=INK + (int(255 * al),), anchor='ls')

def sc_map(t):
    u, lt = loc(t, 'map')
    tt = min(t, SHUT)
    a, tip = sand_frame(tt)
    # 镜头：轻微漂移 + 跟着笔尖
    z = 1.04 + .03 * u
    a = img(a).resize((int(W * z), int(H * z)), Image.BILINEAR)
    ox = (a.width - W) / 2 + 20 * math.sin(lt * .4); oy = (a.height - H) / 2 + 10 * math.cos(lt * .3)
    a = arr(a.crop((int(ox), int(oy), int(ox) + W, int(oy) + H)))
    def M(x, y): return (x * z - ox, y * z - oy)
    ov = rgba(); d = ImageDraw.Draw(ov)
    if tip is not None and t < SHUT:                                 # 树枝
        tx, ty = M(*tip); ex, ey = tx + 620, ty + 520
        sh = rgba(); sd = ImageDraw.Draw(sh); sd.line([(tx + 14, ty + 18), (ex + 40, ey + 30)], fill=(30, 16, 8, 110), width=16)
        ov.alpha_composite(sh.filter(ImageFilter.GaussianBlur(7)))
        d.line([(tx, ty), (ex, ey)], fill=(86, 58, 34, 255), width=14); d.line([(tx + 2, ty - 3), (ex + 2, ey - 3)], fill=(140, 100, 64, 255), width=4)
    # 中文标注（讲故事的人加的墨字）
    map_ink(ov, t, 1.0, z, -ox, -oy)
    a = arr(over(img(a), ov))
    # 镜片视角：四周压暗
    a = iris(a, (60, 40, W - 60, H - 40), .5, radius=220, blur=120)
    ov = rgba(); d = ImageDraw.Draw(ov); Lm = Image.new('L', (W, H), 0); L = ImageDraw.Draw(Lm)
    hb = (W / 2 - 560, H - 232, W / 2 + 560, H - 58)
    if t < T['e03'] - .1: translate_hud(d, L, hb, 'e02', 't02', t, win(t, SCD['map'][1] + .3, T['e03'] - .1, .3, .25), 1.25)
    else: translate_hud(d, L, hb, 'e03', 't03', t, win(t, T['e03'] - .1, SHUT - .1, .25, .3), 1.25)
    gtext(L, (90, 90), '眼镜功能 · 实时翻译', FH(24), win(t, SCD['map'][1] + .3, SHUT - .1) * .9)
    a = apply_hud(a, ov, Lm)
    # 拍照：闪白 + 定格成照片，缩到左上角
    if t >= SHUT:
        a = photo_fly(a, t)
    return img(a), None

@lru_cache(None)
def map_photo():
    a, _ = sand_frame(SHUT); im = img(a); ov = rgba(); map_ink(ov, SHUT + 10); im = over(im, ov)
    pw, ph = 560, 315
    p = im.resize((pw, ph), Image.LANCZOS)
    card = Image.new('RGBA', (pw + 28, ph + 64), (246, 240, 228, 255)); card.paste(p, (14, 14))
    d = ImageDraw.Draw(card); d.text((22, ph + 50), '岔路口 · 沙地上的路线', font=FS(24, 'bold'), fill=INK + (255,), anchor='ls')
    return card

CARD_XY = (60 + 588 * .62 / 2, 300 + 379 * .62 / 2)
def photo_fly(a, t):
    k = clamp((t - SHUT) / .12); fl = (1 - clamp((t - SHUT - .05) / .5)) * k
    f = eo(clamp((t - SHUT - .55) / .8))
    ov = rgba(); c = map_photo()
    if f <= 0:
        a = a + fl * .8
        return a
    sc = lerp(W * .9 / c.width, .62, f); xy = (lerp(W / 2, CARD_XY[0], f), lerp(H / 2 - 20, CARD_XY[1], f))
    bg = a * (1 - .5 * f)
    paste_rot(ov, c, xy, lerp(0, -4, f), 1.0, scale=sc)
    return arr(over(img(bg + fl * .8), ov))

def card_overlay(im, t):
    """沙地照片卡：从拍下一直跟到山坡，红点沿运水便道走"""
    if not (SCD['ridge'][1] <= t <= SCD['ridge'][2] + .2): return im
    al = ramp(t, SCD['ridge'][1] + .2, SCD['ridge'][1] + .7) * (1 - ramp(t, SCD['ridge'][2] - .6, SCD['ridge'][2] + .1))
    ov = rgba(); c = map_photo().copy()
    if t > T['n07']:
        d = ImageDraw.Draw(c)
        f = ramp(t, at('n07', .55), at('n07', .95))
        pts = [(14 + x * 560 / W, 14 + y * 315 / H) for x, y in WATER]
        p = poly_upto(pts, f); d.line(p, fill=(200, 40, 30, 255), width=4)
        x, y = p[-1]; d.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(220, 50, 30, 255), outline=(255, 240, 220, 255), width=2)
    paste_rot(ov, c, CARD_XY, -4, al, scale=.62)
    return over(im, ov)

def sc_boss(t):
    u, lt = loc(t, 'boss')
    cam = Cam([(0, 1.9, 960, 470, 30, 8), (1, 2.15, 960, 480, 34, 8)])
    a, mp, z = cam_bg('image6', cam, u)
    a = grade(a, sat=.85, bright=.62, contrast=1.15, warm=.1)
    a = vignette(a, .55)
    sx, sy = sunpos(mp, 'image6')
    a = bloom(a, (sx, sy), 80 * z / 2, .18)
    ov = rgba()
    draw_tag(ov, TAG_BOSS, (1420, 300), mp(960, 505), win(t, T['b01'] + .3, SCD['boss'][2] - .1, .5, .4), -2, 5)
    return over(img(a), ov), (sx, sy)

def ink_layer(t, items):
    """墨线批注：[(点列, 起, 止, 颜色, 宽)]"""
    ov = rgba(); d = ImageDraw.Draw(ov)
    for pts, a, b, col, w in items:
        if t < a: continue
        p = poly_upto(pts, ramp(t, a, b))
        if len(p) > 1: d.line(p, fill=col, width=w, joint='curve')
    return ov

def sc_ridge(t):
    u, lt = loc(t, 'ridge')
    cam = Cam([(0, 1.06, 1000, 520, 26, 6), (.6, 1.18, 1220, 560, 28, 6), (1, 1.26, 1300, 580, 30, 6)])
    a, mp, z = cam_bg('image5', cam, u)
    a = grade(a, sat=.95, warm=.14, bright=1.02)
    # 热浪
    y0, y1 = int(max(0, mp(0, 470)[1])), int(min(H, mp(0, 640)[1]))
    if y1 > y0:
        rows = np.arange(y0, y1)
        off = (np.sin(rows * .17 + t * 6) * 1.8 + np.sin(rows * .05 - t * 3) * 1.1) * np.sin(np.pi * (rows - y0) / (y1 - y0))
        for c in range(3):
            a[y0:y1, :, c] = np.array([np.roll(a[r, :, c], int(round(o))) for r, o in zip(rows, off)])
    sx, sy = sunpos(mp, 'image5')
    a = bloom(a, (sx, sy), 110 * z, .22)
    # 墨线：圈出矿场，画出运水便道
    mine = [mp(x, y) for x, y in ellipse_pts(1420, 600, 150, 72, seed=3)]
    road = [mp(x, y) for x, y in bez((620, 720), (1020, 860), (1480, 650), 50)]
    ov = ink_layer(t, [(mine, at('n07', .2), at('n07', .42), (190, 46, 30, 235), 5),
                       (road, at('n07', .55), at('n07', .95), (190, 46, 30, 235), 4)])
    d = ImageDraw.Draw(ov)
    lx, ly = mp(1420, 500)
    txt(d, (lx, ly - 40), '矿场', FS(34, 'black'), (190, 46, 30), ramp(t, at('n07', .4), at('n07', .5)), 'ms', stroke=3, stroke_fill=CREAM)
    rx, ry = mp(1000, 830)
    txt(d, (rx, ry + 10), '运水便道', FS(30, 'black'), (190, 46, 30), ramp(t, at('n07', .85), at('n07', .95)), 'ms', stroke=3, stroke_fill=CREAM)
    return over(img(a), ov), (sx, sy)

# 陆遥的计划：墨线小图，跟着她说到的词出现
def plan_card(t):
    k = 'y04'; txt_ = LINES[k]['zh']
    def wt(word):
        i = txt_.find(word); ws = words(k)
        for tb, e in ws:
            if e > i: return T[k] + tb
        return T[k]
    t1, t2, t3 = wt('钥匙'), wt('侧门'), wt('木栏')
    c = paper_card(560, 300, seed=21); d = ImageDraw.Draw(c); col = INK + (255,); red = (186, 50, 30, 255)
    if t >= t1:
        f = ramp(t, t1, t1 + .5)
        truck = [(40, 200), (40, 130), (90, 130), (110, 95), (160, 95), (160, 130), (250, 130), (250, 200), (40, 200)]
        d.line(poly_upto(truck, f), fill=col, width=4)
        if f > .9:
            d.rounded_rectangle([170, 104, 246, 128], 10, outline=col, width=3)
            for wx in (80, 210): d.ellipse([wx - 18, 186, wx + 18, 222], outline=col, width=4, fill=(236, 224, 198, 255))
            d.text((140, 262), '钥匙在车上', font=FS(26, 'black'), fill=col, anchor='ms')
            # 小钥匙
            d.ellipse([120, 108, 136, 124], outline=red, width=3); d.line([(136, 116), (152, 116)], fill=red, width=3)
    if t >= t2:
        f = ramp(t, t2, t2 + .4)
        d.line(poly_upto([(262, 160), (330, 160)], f), fill=red, width=4)
        if f > .9:
            d.polygon([(330, 150), (346, 160), (330, 170)], fill=red)
            d.rectangle([352, 92, 404, 208], outline=col, width=4); d.line([(352, 92), (340, 102), (340, 216), (352, 208)], fill=col, width=3)
            d.text((378, 262), '侧门', font=FS(26, 'black'), fill=col, anchor='ms')
    if t >= t3:
        f = ramp(t, t3, t3 + .5)
        if f > 0:
            for i, x in enumerate((440, 480, 520)):
                d.line(poly_upto([(x, 100), (x, 210)], clamp(f * 3 - i)), fill=col, width=5)
            d.line(poly_upto([(426, 130), (536, 126)], f), fill=col, width=4); d.line(poly_upto([(426, 180), (536, 184)], f), fill=col, width=4)
            if f > .9:
                d.line([(462, 112), (474, 140), (466, 160), (480, 196)], fill=red, width=3)
                d.text((482, 262), '木栏已烂', font=FS(26, 'black'), fill=col, anchor='ms')
    return c

def sc_mine(t):
    u, lt = loc(t, 'mine')
    cam = Cam([(0, 1.24, 980, 560, 20, 5), (.28, 1.12, 960, 600, 22, 5), (.42, 1.3, 940, 660, 24, 6),
               (.55, 1.06, 960, 520, 22, 5), (.72, 1.22, 960, 600, 24, 6), (1, 1.3, 940, 640, 24, 6)])
    a, mp, z = cam_bg('image6', cam, u)
    a = grade(a, sat=.95, warm=.08)
    # 感光：从烈日进暗处，先暗后亮
    dk = ramp(t, T['n08'] - .2, end('n08') + .2)
    if dk < 1:
        a = a * (.1 + .9 * dk ** 1.4)
        a = iris(a, (240, 120, W - 240, H - 120), .85 * (1 - dk), radius=300, blur=160)
    ov = rgba(); d = ImageDraw.Draw(ov)
    # 出口被堵：门洞里的人影
    gate = [mp(x, y) for x, y in [(570, 470), (570, 600), (1350, 600), (1350, 470)]]
    blk = at('n09', .45)
    if t > blk:
        f = ramp(t, blk, blk + .5); g = win(t, blk, SCD['mine'][2] + .2, .3, .5)
        br = ImageDraw.Draw(ov)
        x0, y0 = gate[0]; x1, y1 = gate[2]
        for (ax, ay, bx_, by_) in [(x0, y0, x0 + 30, y0), (x0, y0, x0, y1), (x0, y1, x0 + 30, y1), (x1, y0, x1 - 30, y0), (x1, y0, x1, y1), (x1, y1, x1 - 30, y1)]:
            br.line([(ax, ay), (lerp(ax, bx_, f), lerp(ay, by_, f))], fill=(214, 70, 40, int(240 * g)), width=5)
        txt(br, ((x0 + x1) / 2, y0 - 18), '出口被堵', FS(40, 'black'), (230, 80, 50), g * f, 'ms', stroke=4, stroke_fill=(20, 10, 6))
    pa = win(t, at('y04', .05), SCD['mine'][2] + .2, .4, .5)
    if pa > 0:
        paste_rot(ov, plan_card(t), (380, 330), -2.5, pa)
    sx, sy = sunpos(mp, 'image6')
    a = bloom(a, (sx, sy), 90 * z, .1 * dk)
    return over(img(a), ov), (sx, sy)

# 撞门：碎木片 + 尘土
_rr = np.random.default_rng(12)
SPL = [(_rr.uniform(1350, 1650), _rr.uniform(150, 800), _rr.uniform(300, 1300), _rr.uniform(-900, -100), _rr.uniform(-8, 8),
        _rr.uniform(14, 46), _rr.uniform(4, 12), _rr.uniform(0, 6.28)) for _ in range(46)]
DUST = [(_rr.uniform(300, 1100), _rr.uniform(780, 1000), _rr.uniform(-300, 300), _rr.uniform(-160, -30), _rr.uniform(40, 120)) for _ in range(60)]

def sc_crash(t):
    u, lt = loc(t, 'crash')
    pre = CRASH
    sh = (0, 0)
    if t < pre:                                                   # 引擎发抖
        e = ramp(t, T['c06'] - 1.8, T['c06'] - 1.0) * .4 + ramp(t, T['c06'] - .6, T['c06'] - .3) * .6
        sh = (math.sin(t * 61) * 3 * e, math.cos(t * 53) * 3 * e)
    sh2 = shake(t, pre, 46, 1.1)
    sh = (sh[0] + sh2[0], sh[1] + sh2[1])
    cu = (CRASH - SCD['crash'][1]) / (SCD['crash'][2] - SCD['crash'][1])
    cam = Cam([(0, 1.45, 760, 230, 18, 4), (cu - .001, 1.55, 760, 220, 18, 4), (cu + .02, 1.02, 980, 540, 34, 8),
               (cu + .3, 1.08, 1060, 520, 30, 8), (.8, 1.3, 800, 260, 20, 5), (1, 1.42, 780, 240, 20, 5)])
    a, mp, z = cam_bg('image7', cam, u, shake=sh)
    a = grade(a, sat=1.0, warm=.1)
    # 撞击瞬间：闪光 + 径向模糊
    if pre <= t < pre + .35:
        k = 1 - (t - pre) / .35
        im = img(a); acc = a.copy()
        for s_ in (1.03, 1.06, 1.1):
            z2 = im.resize((int(W * s_), int(H * s_)), Image.BILINEAR); ox, oy = (z2.width - W) // 2, (z2.height - H) // 2
            acc += arr(z2.crop((ox, oy, ox + W, oy + H)))
        a = a * (1 - k) + acc / 4 * k + k * .18
    ov = rgba(); d = ImageDraw.Draw(ov)
    if t >= pre:
        age = t - pre
        for x, y, vx, vy, vr, ln, wd, r0 in SPL:
            px_ = x + vx * age; py_ = y + vy * age + 900 * age * age
            if py_ > H + 100 or age > 2.2: continue
            ang = r0 + vr * age; c, s = math.cos(ang), math.sin(ang)
            X, Y = mp(px_, py_)
            pts = [(X + c * ln - s * wd, Y + s * ln + c * wd), (X - c * ln - s * wd, Y - s * ln + c * wd),
                   (X - c * ln + s * wd, Y - s * ln - c * wd), (X + c * ln + s * wd, Y + s * ln - c * wd)]
            A = int(255 * clamp(1 - age / 2.2))
            d.polygon(pts, fill=(120, 76, 42, A), outline=(52, 30, 16, A))
        Ld = Image.new('L', (W, H), 0); dd = ImageDraw.Draw(Ld)
        for x, y, vx, vy, r in DUST:
            if age > 3.5: break
            X, Y = mp(x + vx * age * (1 - age / 8), y + vy * age * (1 - age / 8)); R = (r + age * 140) * z
            dd.ellipse([X - R, Y - R * .6, X + R, Y + R * .6], fill=int(70 * clamp(1 - age / 3.5)))
        Ld = Ld.filter(ImageFilter.GaussianBlur(14)); dm = np.asarray(Ld).astype(np.float32)[..., None] / 255
        a = a * (1 - dm) + np.array([.86, .66, .46], np.float32) * dm
    # 警笛：画外的红蓝光，在左缘轻轻交替
    if t > at('n10', .4):
        ph = (t * 2.2) % 1; e = win(t, at('n10', .4), SCD['crash'][2] + .3, .8, .6) * .16
        yy, xx = np.ogrid[0:H, 0:W]; m = np.exp(-xx / 260.0)
        col = np.array([1, .2, .15]) if ph < .5 else np.array([.2, .35, 1])
        a = a + (m * e)[..., None] * col
    sx, sy = sunpos(mp, 'image7')
    return over(img(a), ov), (sx, sy)

def sc_store(t):
    u, lt = loc(t, 'store')
    cam = Cam([(0, 1.04, 960, 540, 18, 4), (.5, 1.1, 1000, 520, 20, 5), (.75, 1.16, 1220, 420, 20, 5), (1, 1.2, 1260, 400, 20, 5)])
    a, mp, z = cam_bg('image8', cam, u)
    a = grade(a, sat=.96, warm=.16)
    ov = rgba(); d = ImageDraw.Draw(ov); Lm = Image.new('L', (W, H), 0); L = ImageDraw.Draw(Lm)
    opn = T['c08'] + .2; cls = end('t04') + 1.3
    k = eo(clamp((t - opn) / .5)); c = eo(clamp((t - cls) / .45))
    if opn < t < cls + .5:
        wb = (150, 90, 730, 890); tb = (mp(560, 790)[0] - 10, mp(560, 790)[1] - 10, mp(560, 790)[0] + 10, mp(560, 790)[1] + 10)
        box = lerp_box(tb, wb, k) if c == 0 else lerp_box(wb, tb, c)
        a = lens_window(a, box, pov(3), ramp(t, opn, opn + .12) * (1 - c))
        if k > .9 and c == 0:
            pm, s = panel_map(box, 3)
            hb = (*pm(1196, 197), *pm(1500, 312))
            ha = ramp(t, opn + .4, opn + .7); ok = T['t04'] + .05
            hud_box(d, L, hb, ha)
            if t < ok:
                rr = 22 * s; cx, cy = hb[0] + 44 * s, (hb[1] + hb[3]) / 2
                L.arc([cx - rr, cy - rr, cx + rr, cy + rr], int(t * 400) % 360, int(t * 400) % 360 + 260, fill=int(255 * ha), width=4)
                gtext(L, (hb[0] + 88 * s, hb[1] + 46 * s), '语音支付', FH(int(26 * s), True), ha)
                gtext(L, (hb[0] + 88 * s, hb[1] + 88 * s), '10.00  ·  声纹确认中', FH(int(19 * s)), ha * .85)
            else:
                icon(d, L, 'check', hb[0] + 44 * s, (hb[1] + hb[3]) / 2, 22 * s, ha, clamp((t - ok) / .3))
                gtext(L, (hb[0] + 88 * s, hb[1] + 46 * s), '语音支付', FH(int(26 * s), True), ha)
                gtext(L, (hb[0] + 88 * s, hb[1] + 88 * s), '支付成功', FH(int(24 * s), True), ha)
            gtext(L, (box[0] + 40, box[3] - 40), '眼镜功能 · 语音支付', FH(22), ha * .9)
    a = apply_hud(a, ov, Lm)
    # 蓝色胶带：画一圈蓝墨
    ov = rgba(); d = ImageDraw.Draw(ov)
    ta = T['y07'] - .1
    if t > ta:
        g = win(t, ta, SCD['store'][2] + .2, .2, .5)
        ring = [mp(x, y) for x, y in ellipse_pts(1440, 236, 70, 44, seed=8)]
        p = poly_upto(ring, ramp(t, ta, ta + .6)); d.line(p, fill=TAPE + (int(250 * g),), width=5, joint='curve')
        lx, ly = mp(1440, 236)
        txt(d, (lx - 90, ly - 40), '蓝色胶带 · 她贴的，好认', FS(32, 'black'), TAPE, g * ramp(t, ta + .5, ta + .8), 'rs', stroke=4, stroke_fill=CREAM)
    sx, sy = sunpos(mp, 'image8')
    a = bloom(a, (sx, sy), 50 * z, .14)
    return over(img(a), ov), (sx, sy)

# 回顾：日落钟放大成一天的时间轴，三个功能是路上的三个点
RECAP_MARK = [(8, '眼镜通话', '接听求救', 1, 0), (68, '实时翻译', '问出便道', 2, 0), (205, '语音支付', '双手照护时买水', 3, 0)]
@lru_cache(None)
def mini_lens(n):
    p = img(pov(n)); w, h = 210, 260
    s = max(w / p.width, h / p.height); p = p.resize((int(p.width * s), int(p.height * s)), Image.LANCZOS)
    p = p.crop(((p.width - w) // 2, (p.height - h) // 2, (p.width - w) // 2 + w, (p.height - h) // 2 + h)).convert('RGBA')
    m = Image.new('L', (w, h), 0); ImageDraw.Draw(m).polygon(lens_poly((0, 0, w, h)), fill=255); p.putalpha(m)
    d = ImageDraw.Draw(p); pl = lens_poly((3, 3, w - 3, h - 3)); d.line(pl + [pl[0]], fill=(16, 14, 14, 255), width=8)
    return p

def sc_recap(t):
    u, lt = loc(t, 'recap')
    a = paper_tex(W, H, 31).copy()
    ov = rgba(); d = ImageDraw.Draw(ov); Lm = Image.new('L', (W, H), 0); L = ImageDraw.Draw(Lm)
    # 远山剪影
    r = np.random.default_rng(2); xs = np.linspace(0, W, 40); ys = 800 - np.abs(np.cumsum(r.normal(0, 9, 40))) - 20
    ys[8:12] -= 60; ys[26:31] -= 80
    d.polygon([(0, 880)] + list(zip(xs, ys + 60)) + [(W, 880)], fill=(176, 112, 74, 110))
    mm = lerp(0, SUNSET + 14, ramp(t, T['n12'] - .2, end('n12') + .2))
    lit = {}
    def marks(dd, pos, m):
        for mi, name, sub, n, t0 in RECAP_MARK:
            x, y = pos(mi); on = m >= mi
            lit[n] = (x, y, on)
    RC = (W / 2, 880, 640)
    sun_clock(ov, t, max(.002, ramp(t, SCD['recap'][1], SCD['recap'][1] + .5)), cx=RC[0], cy=RC[1], R=RC[2], big=True, marks=marks, mm=mm, A0=0)
    for mi, name, sub, n, t0 in RECAP_MARK:
        x, y, on = lit[n]
        e = ramp(mm, mi, mi + 6)
        L.ellipse([x - 20, y - 20, x + 20, y + 20], outline=int(255 * (.35 + .65 * e)), width=4)
        if e > 0:
            L.ellipse([x - 9, y - 9, x + 9, y + 9], fill=int(255 * e))
            ml = mini_lens(n)
            cx_, cy_ = (560, 960, 1360)[n - 1], 540                           # 三枚镜片排在弧内
            paste_rot(ov, ml, (cx_, cy_), 0, e)
            L.line([(x, y), (cx_, cy_ - ml.height / 2 - 6)], fill=int(160 * e), width=2)
            txt(d, (cx_, cy_ + ml.height / 2 + 46), f'0{n}  {name}', FS(34, 'black'), INK, e, 'ms')
            txt(d, (cx_, cy_ + ml.height / 2 + 82), sub, FS(24, 'bold'), (130, 80, 50), e, 'ms')
    txt(d, (W / 2, 120), '一路相助的三个功能', FS(46, 'black'), INK, ramp(t, SCD['recap'][1] + .3, SCD['recap'][1] + .8), 'ms')
    txt(d, (W / 2 - 640, 930), '16:00', FC(28, 'black'), INK, 1, 'ms'); txt(d, (W / 2 + 640, 930), '日落', FS(30, 'black'), (170, 70, 30), 1, 'ms')
    a = arr(over(img(a), ov))
    a = glow(a * (1 - np.asarray(Lm)[..., None].astype(np.float32) / 255 * .0), Lm, (40, 150, 90), core=1.0, s1=1.5, s2=6, k1=.4, k2=.2)
    # 太阳位置（给转场用）
    th = math.radians(165 - 165 * min(mm, SUNSET) / SUNSET)
    sx, sy = W / 2 + 640 * math.cos(th), 880 - 640 * math.sin(th)
    return img(a), (sx, sy)

def sc_hero(t):
    u, lt = loc(t, 'hero')
    cam = Cam([(0, 1.0, 960, 540, 16, 4), (1, 1.1, 1000, 600, 18, 4)])
    a, mp, z = cam_bg('image9', cam, u)
    a = grade(a, sat=.94, warm=.18)
    ov = rgba(); d = ImageDraw.Draw(ov)
    t0 = SCD['hero'][1] + .6
    tc = hero_title(); k = clamp((t - t0) / .25)
    out = 1 - ramp(t, end('n13') + 2.6, end('n13') + 3.4)
    paste_rot(ov, tc, (1240, 250), -1, ramp(t, t0, t0 + .1) * out, scale=1.2 - .2 * eo(k), shadow=False)
    tp = t0 + 1.6                                                    # 胶带落下、压平
    if t > tp:
        f = eo(clamp((t - tp) / .35)); flat = eo(clamp((t - tp - .7) / .3))
        tape = tape_strip(); ang = lerp(14, 3, f) - 2 * flat
        paste_rot(ov, tape, (1240, 392 - 26 * (1 - f)), ang * .4, f * out, scale=1.25 - .2 * f - .03 * flat)
    sx, sy = sunpos(mp, 'image9')
    a = a * (1 - .9 * ramp(t, end('n13') + 3.0, end('n13') + 4.0))
    return over(img(a), ov), (sx, sy)

@lru_cache(None)
def hero_title():
    c = Image.new('RGBA', (900, 420), (0, 0, 0, 0)); d = ImageDraw.Draw(c)
    d.text((450, 160), '日落之前', font=FS(150), fill=(64, 30, 18, 255), anchor='ms')
    d.text((450, 236), '去往你牵挂的人身边。', font=FS(44, 'bold'), fill=(120, 56, 28, 255), anchor='ms')
    d.text((450, 318), '乐奇 AI 太阳镜', font=FS(54), fill=(40, 24, 16, 255), anchor='ms')
    return c

@lru_cache(None)
def tape_strip():
    w, h = 190, 40; r = np.random.default_rng(3)
    a = np.ones((h, w, 4), np.float32) * np.array([*np.array(TAPE) / 255, .88])
    a[..., :3] *= (1 + ndi.gaussian_filter(r.standard_normal((h, w)), (1, 6))[..., None] * .06)
    m = Image.new('L', (w, h), 0); dd = ImageDraw.Draw(m)
    xs = np.linspace(0, h, 9); left = [(4 + r.uniform(-3, 3), y) for y in xs]; right = [(w - 4 + r.uniform(-3, 3), y) for y in xs[::-1]]
    dd.polygon(left + right, fill=255)
    a[..., 3] *= np.asarray(m).astype(np.float32) / 255
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), 'RGBA')
    ImageDraw.Draw(im).line([(10, 8), (w - 12, 6)], fill=(255, 255, 255, 70), width=3)
    return im

SCENES = {'open': sc_open, 'call': sc_call, 'ride': sc_ride, 'ask': sc_ask, 'map': sc_map, 'boss': sc_boss,
          'ridge': sc_ridge, 'mine': sc_mine, 'crash': sc_crash, 'store': sc_store, 'recap': sc_recap, 'hero': sc_hero}

# ---------------------------------------------------------------- 合成
def warp(im, sxy, s, dxy=(0, 0)):
    """以 sxy 为中心缩放 s，再平移 dxy"""
    a = 1 / s
    tx = sxy[0] - a * (sxy[0] + dxy[0]); ty = sxy[1] - a * (sxy[1] + dxy[1])
    return im.transform((W, H), Image.AFFINE, (a, 0, tx, 0, a, ty), Image.BILINEAR)

def transition(A, B, sa, sb, p):
    """太阳对位：A 推向自己的太阳；B 从“太阳对齐在 A 太阳处”放开。中间一团光"""
    q = ss(p)
    if sa is None or sb is None:
        return Image.blend(A, B, q)
    A2 = warp(A, sa, 1 + .5 * q)
    s0 = 1.5; sB = s0 + (1 - s0) * q
    off = ((sa[0] - sb[0]) * (1 - q), (sa[1] - sb[1]) * (1 - q))
    B2 = warp(B, sb, sB, off)
    out = arr(Image.blend(A2, B2, q))
    cx, cy = lerp(sa[0], sb[0], q), lerp(sa[1], sb[1], q)
    out = bloom(out, (cx, cy), 220, .55 * math.sin(math.pi * p) ** 1.5, (1.0, .82, .58))
    return img(out)

def frame(i):
    t = i / FPS
    act = [s for s in SC if s[1] - XF / 2 <= t < s[2] + XF / 2]
    if not act: act = [SC[-1]]
    if len(act) == 1:
        im, _ = SCENES[act[0][0]](t); cur = act[0][0]
    else:
        A, sa = SCENES[act[0][0]](t); B, sb = SCENES[act[1][0]](t)
        p = clamp((t - (act[0][2] - XF / 2)) / XF)
        im = transition(A, B, sa, sb, p); cur = act[0][0] if p < .5 else act[1][0]
    im = card_overlay(im, t)
    ov = rgba()
    ca = ramp(t, SCD['call'][1] + .8, SCD['call'][1] + 1.4) * (1 - ramp(t, SCD['recap'][1] - .6, SCD['recap'][1]))
    sun_clock(ov, t, ca)
    chapter(ov, t)
    im = over(im, ov)
    im = subtitles(im, t, cur)
    a = grain(arr(im), i)
    if t > TOTAL - 1.0: a = a * (1 - ramp(t, TOTAL - 1.0, TOTAL - .2))
    return img(a)

def render(i):
    fn = OUT + f'frames/{i:05d}.jpg'
    if os.path.exists(fn): return
    frame(i).save(fn, quality=92)

# ---------------------------------------------------------------- 声音
SR = 44100
def rd(fn):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', fn, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(OUT + 'frames', exist_ok=True)
    print(f'总长 {TOTAL:.1f}s，{int(TOTAL * FPS)} 帧；场景', [(s[0], round(s[1], 1)) for s in SC])
    if '--from' in sys.argv:
        a_ = float(sys.argv[sys.argv.index('--from') + 1]); b_ = float(sys.argv[sys.argv.index('--to') + 1])
        idx = range(int(a_ * FPS), int(b_ * FPS))
    else: idx = range(int(TOTAL * FPS))
    if '--still' in sys.argv:
        for s in sys.argv[sys.argv.index('--still') + 1].split(','):
            frame(int(float(s) * FPS)).save(OUT + f'check_{float(s):06.1f}.jpg', quality=88); print('ok', s)
        sys.exit()
    if cmd in ('frames', 'all'):
        with Pool(14) as p:
            for j, _ in enumerate(p.imap_unordered(render, idx, chunksize=6)):
                if j % 240 == 0: print('帧', j, flush=True)
    if cmd in ('audio', 'all'):
        import mix; mix.audio(); mix.srt(); print('audio ok')     # 声音在 mix.py
    if cmd in ('mux', 'all'):
        out = P + '日落之前_故事介绍.mp4'
        r = subprocess.run(['ffmpeg', '-i', OUT + 'mix.wav', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
        J = json.loads(r[r.rindex('{'):r.rindex('}') + 1])
        ln = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={J['input_i']}:measured_TP={J['input_tp']}:measured_LRA={J['input_lra']}"
              f":measured_thresh={J['input_thresh']}:offset={J['target_offset']}:linear=true,aresample=44100")
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', OUT + 'frames/%05d.jpg', '-i', OUT + 'mix.wav',
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
                        '-af', ln, '-shortest', '-movflags', '+faststart', out], check=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', out, '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-crf', '24',
                        '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', P + '日落之前_故事介绍_手机版.mp4'], check=True)
        print('ok', out)
