#!/usr/local/bin/python3
"""「画境追宝」故事介绍片渲染器。
时间线由台词时长自动排出（vo/dur.json），每个镜头一个函数 fn(t, T, st) → PIL 画面。
用法：/usr/local/bin/python3 film/build.py [--only 3,4] [--preview]   → out/video.mp4 + timeline.json
"""
import sys, json, math, subprocess, argparse
from functools import lru_cache
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi

P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'tools'))
import stills as S0
from stills import F, HEI, SONG, DIDOT, LENS, GOLD, RED, placard, lens_panel, gilt_frame, voronoi

W, H, FPS = 1920, 1080, 24
K = W / 1360                     # 原图坐标 → 画布
OUT = P / 'out'; OUT.mkdir(exist_ok=True)
LINES = {x['id']: x for x in json.load(open(P / 'lines.json'))}
DUR = json.load(open(P / 'vo' / 'dur.json'))
BAR = 64                         # 遮幅高度

def ease(x): x = min(max(x, 0.0), 1.0); return x * x * (3 - 2 * x)
def lerp(a, b, x): return a + (b - a) * x

# ---------------- 素材与运镜 ----------------
@lru_cache(None)
def big(n):
    """封面化到 1920×1084 后放大 2 倍，供运镜采样。"""
    im = S0.load(n, (W, round(768 * K)))
    return im.resize((im.width * 2, im.height * 2), Image.LANCZOS)

class Cam:
    """cx, cy 用原图坐标；z=1 为全幅。pt() 把原图坐标点换成屏幕坐标。"""
    def __init__(self, n, cx, cy, z, shake=(0, 0)):
        b = big(n); bw, bh = b.width / 2, b.height / 2
        vw, vh = W / z, H / z
        x0 = min(max(cx * K - vw / 2, 0), bw - vw) + shake[0]
        y0 = min(max(cy * K - vh / 2, 0), bh - vh) + shake[1]
        self.v = (x0, y0, vw, vh); self.n = n
    def img(self):
        x0, y0, vw, vh = self.v
        return big(self.n).transform((W, H), Image.EXTENT, (x0 * 2, y0 * 2, (x0 + vw) * 2, (y0 + vh) * 2), Image.BILINEAR)
    def pt(self, x, y):
        x0, y0, vw, vh = self.v
        return ((x * K - x0) * W / vw, (y * K - y0) * H / vh)

def cam_path(n, t, a, b, d0=0, d1=None, shake=(0, 0)):
    """a/b = (cx, cy, z)；在 [d0, d1] 内缓动。"""
    x = ease((t - d0) / ((d1 - d0) if d1 else 1e9)) if d1 else 0
    return Cam(n, lerp(a[0], b[0], x), lerp(a[1], b[1], x), lerp(a[2], b[2], x), shake)

def lin_cam(n, t, T, a, b, shake=(0, 0)):
    x = t / T
    return Cam(n, lerp(a[0], b[0], x), lerp(a[1], b[1], x), lerp(a[2], b[2], x), shake)

def shake_at(t, amp, f=17):
    return (amp * math.sin(t * f * 6.283), amp * 0.7 * math.cos(t * f * 5.1 * 1.3))

def arr(im): return np.asarray(im).astype(np.float32)
def img(a): return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

@lru_cache(None)
def grids():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return yy, xx

def bright(im, k):
    return img(arr(im) * k) if k != 1 else im

def fade(im, k):
    return im if k >= 1 else img(arr(im) * max(k, 0))

# ---------------- 文字层 ----------------
NAMECOL = {'乐奇': LENS, '林砚': (255, 236, 200), '许岚': (255, 190, 170), '公爵': (210, 200, 255)}

def subtitle(im, who, text, a=1.0):
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    f = F(HEI, 40, 1); fw = F(HEI, 24, 1)
    tw = d.textlength(text, font=f); x = (W - tw) / 2; y = H - 118
    al = int(255 * a)
    d.text((x, y), text, font=f, fill=(255, 255, 255, al), stroke_width=4, stroke_fill=(0, 0, 0, al))
    nc = NAMECOL.get(who, (230, 230, 230))
    d.text((x, y - 34), who, font=fw, fill=nc + (al,), stroke_width=3, stroke_fill=(0, 0, 0, al))
    return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

def letterbox(im):
    d = ImageDraw.Draw(im); d.rectangle((0, 0, W, BAR), fill=0); d.rectangle((0, H - BAR, W, H), fill=0)
    return im

def panel(im, a, *args, **kw):
    """带淡入的镜片面板。"""
    if a <= 0: return im
    out = lens_panel(im, *args, **kw)
    return out if a >= 1 else Image.blend(im, out, a)

def plac(im, a, xy, lines, w=520):
    if a <= 0: return im
    base = im.copy(); placard(base, xy, lines, w=w)
    return base if a >= 1 else Image.blend(im, base, a)

def mini_tag(im, xy, text, a=1.0, col=(205, 168, 104)):
    """小铜签：失踪藏品标注。"""
    if a <= 0: return im
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    f = F(HEI, 22, 1); x, y = xy
    tw = d.textlength(text, font=f); al = int(255 * a)
    d.line((x, y, x, y - 40), fill=col + (al,), width=2)
    d.rectangle((x - tw / 2 - 14, y - 82, x + tw / 2 + 14, y - 40), fill=col + (int(235 * a),), outline=(90, 65, 30, al), width=2)
    d.text((x - tw / 2, y - 76), text, font=f, fill=(60, 35, 10, al))
    d.ellipse((x - 5, y - 5, x + 5, y + 5), fill=col + (al,))
    return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

def badge(im, a, text, xy=(60, 90), dot=True, col=LENS):
    if a <= 0: return im
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    f = F(HEI, 24, 1); x, y = xy; al = int(255 * a)
    tw = d.textlength(text, font=f)
    d.rounded_rectangle((x, y, x + tw + 58, y + 44), 10, fill=(6, 22, 18, int(170 * a)), outline=col + (al,), width=2)
    if dot: d.ellipse((x + 16, y + 15, x + 30, y + 29), fill=(255, 60, 60, al))
    d.text((x + 40, y + 8), text, font=f, fill=col + (al,))
    return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

def arrow_hint(im, a, xy, text, ang):
    if a <= 0: return im
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    x, y = xy; al = int(255 * a); c = LENS + (al,)
    ca, sa = math.cos(ang), math.sin(ang)
    x2, y2 = x + ca * 90, y + sa * 90
    d.line((x, y, x2, y2), fill=c, width=7)
    d.polygon([(x2 + ca * 24, y2 + sa * 24), (x2 - sa * 18, y2 + ca * 18), (x2 + sa * 18, y2 - ca * 18)], fill=c)
    d.text((x - 40, y + 26), text, font=F(HEI, 28, 1), fill=c, stroke_width=3, stroke_fill=(0, 0, 0, al))
    g = ov.filter(ImageFilter.GaussianBlur(5))
    return Image.alpha_composite(Image.alpha_composite(im.convert('RGBA'), g), ov).convert('RGB')

def vis(t, st, lid, pre=0.0, post=0.5):
    """台词 lid 播放期间的可见度（带淡入淡出）。"""
    if lid not in st: return 0.0
    s = st[lid] - pre; e = st[lid] + DUR[lid] + post
    if t < s or t > e + 0.25: return 0.0
    return min(ease((t - s) / 0.2), ease((e + 0.25 - t) / 0.25))

def after(t, st, lid, d=0.0, ramp=0.25):
    if lid not in st: return 0.0
    return ease((t - st[lid] - d) / ramp)

def end_of(st, lid): return st[lid] + DUR[lid]

# ---------------- 特效 ----------------
@lru_cache(None)
def vor(n, seed):
    pts, lab, gap = voronoi((H, W), n, seed=seed)
    return pts, lab, gap

def flake_transition(A, B, x, touch, rng_seed=3, cells=900):
    """A→B：碎片按离 touch 的距离一片片翻成 B，翻转前沿是灰泥色。x∈[0,1]。"""
    pts, lab, gap = vor(cells, rng_seed)
    r = np.random.default_rng(rng_seed)
    dist = np.hypot(pts[:, 0] - touch[0], pts[:, 1] - touch[1]) + r.uniform(-140, 140, len(pts))
    R = lerp(-200, 2500, x)
    fl = (dist < R)[lab]
    fr = ((dist >= R) & (dist < R + 160) & (r.uniform(0, 1, len(pts)) < 0.5))[lab]
    a, b = arr(A), arr(B)
    a = a * np.array([0.8, 0.9, 1.08])
    out = np.where(fl[..., None], b, a)
    shade = (0.72 + 0.28 * ((lab * 37) % 11) / 10)[..., None]
    out = np.where(fr[..., None], np.array([214, 198, 170]) * shade, out)
    yy, xx = grids()
    near = np.abs(np.hypot(xx - touch[0], yy - touch[1]) - R) < 200
    out[(gap < 2.0) & (fl | fr) & near] *= 0.25
    return img(out)

def oil_reveal(A, B, x, center=(960, 540)):
    """A→B：龟裂从中心长出，裂到哪里，哪里就露出油画；光油高光扫过。"""
    pts, lab, gap = vor(2400, 21)
    r = np.random.default_rng(21)
    dist = np.hypot(pts[:, 0] - center[0], pts[:, 1] - center[1]) + r.uniform(-90, 90, len(pts))
    R = lerp(-100, 1400, x)
    rev = (dist < R)[lab]
    out = np.where(rev[..., None], arr(B), arr(A) * 0.5)
    yy, xx = grids()
    rr = np.hypot(xx - center[0], yy - center[1])
    crack = (gap < 1.4) & (rr < R + 60)
    out[crack] *= np.where(rr[crack] > R - 120, 0.2, 0.75)[:, None]
    sx = lerp(-400, 2400, x)
    sheen = np.exp(-(((xx + yy * 0.5 - sx) / 160) ** 2))[..., None] * 60 * rev[..., None]
    return img(out + sheen)

def oil_texture(im):
    pts, lab, gap = vor(7000, 5)
    a = arr(im); a[gap < 1.0] *= 0.8
    return img(a)

@lru_cache(None)
def cubist_fields():
    pts, lab, gap = vor(140, 11)
    r = np.random.default_rng(4)
    n = len(pts)
    return dict(pts=pts, lab=lab, gap=gap, ang=r.uniform(-0.35, 0.35, n), ph=r.uniform(0, 6.28, n),
                sc=r.uniform(0.9, 1.15, n), ox=r.uniform(-60, 60, n), oy=r.uniform(-60, 60, n),
                tone=r.choice([0.82, 0.95, 1.05, 1.15], n))

def cubist(src, t, amp=1.0):
    c = cubist_fields(); lab = c['lab']
    a = arr(src); yy, xx = grids()
    ang = (c['ang'] * (0.7 + 0.5 * np.sin(t * 0.9 + c['ph'])) * amp)[lab]
    sc = (1 + (c['sc'] - 1) * amp)[lab]
    cx, cy = c['pts'][:, 0][lab], c['pts'][:, 1][lab]
    X, Y = xx - cx, yy - cy
    ca, sa = np.cos(ang), np.sin(ang)
    sx = (ca * X - sa * Y) / sc + cx + (c['ox'] * amp)[lab]
    sy = (sa * X + ca * Y) / sc + cy + (c['oy'] * amp)[lab]
    sx = np.clip(sx, 0, W - 1).astype(np.int32); sy = np.clip(sy, 0, H - 1).astype(np.int32)
    out = a[sy, sx] * (1 + (c['tone'] - 1) * min(amp, 1))[lab][..., None]
    out[c['gap'] < 1.6] *= lerp(1, 0.35, min(amp, 1))
    return img(out)

def alarm(im, t, k=1.0):
    yy, xx = grids()
    ang = np.arctan2(yy - 200, xx - 960)
    band = np.cos(ang - t * 5.0) ** 12
    strobe = 0.5 + 0.5 * (math.sin(t * 9.4) > 0)
    a = arr(im) * (1 - 0.25 * k)
    a[..., 0] += band * 150 * k * strobe
    a[..., 1:] *= (1 - band * 0.35 * k)[..., None]
    return img(a)

def flash(im, k):
    if k <= 0: return im
    a = arr(im); a = a + (255 - a) * 0.55 * k + a * 0.4 * k
    return img(a * np.array([0.92, 0.96, 1.08]))

def rain(im, t, n=500, seed=2):
    r = np.random.default_rng(seed)
    x0 = r.uniform(0, W, n); y0 = r.uniform(0, H, n); sp = r.uniform(1800, 2600, n); ln = r.uniform(30, 70, n)
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    for i in range(n):
        y = (y0[i] + sp[i] * t) % (H + 100) - 50; x = (x0[i] + 0.25 * sp[i] * t) % W
        d.line((x, y, x + ln[i] * 0.25, y + ln[i]), fill=(200, 215, 240, 70), width=2)
    return Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')

def rotor(im, t, k, center=(960, 1500), speed=11.0):
    """旋翼阴影从下方扫过 + 下洗气流把画面压暗/抖动。"""
    if k <= 0: return im
    yy, xx = grids()
    ang = np.arctan2(yy - center[1], xx - center[0])
    th = t * speed
    sh = np.zeros((H, W), np.float32)
    for b in range(2):
        dlt = np.angle(np.exp(1j * (ang - th - b * math.pi)))
        sh = np.maximum(sh, np.exp(-(dlt / 0.17) ** 2))
    a = arr(im) * (1 - 0.72 * k * sh)[..., None]
    glow = np.clip((yy - 500) / 580, 0, 1) ** 2 * 70 * k
    a = a + glow[..., None] * np.array([0.9, 0.95, 1.0])
    return img(a)

def dust(im, t, k, seed=8, n=260):
    if k <= 0: return im
    r = np.random.default_rng(seed)
    x0 = r.uniform(0, W, n); sp = r.uniform(200, 700, n); s = r.uniform(2, 6, n); ph = r.uniform(0, 1, n)
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    for i in range(n):
        y = H - ((ph[i] * H + sp[i] * t) % (H + 50)); x = x0[i] + 40 * math.sin(t * 2 + i)
        d.ellipse((x - s[i], y - s[i], x + s[i], y + s[i]), fill=(220, 210, 190, int(120 * k)))
    return Image.alpha_composite(im.convert('RGBA'), ov.filter(ImageFilter.GaussianBlur(1.5))).convert('RGB')

def wave_panel(im, a, t, xy, name, sub):
    """通话面板：名字 + 跳动声波（真实功能：语音通话）。"""
    if a <= 0: return im
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    x, y = xy; w, h = 420, 150; al = int(255 * a)
    d.rounded_rectangle((x, y, x + w, y + h), 14, fill=(8, 28, 24, int(175 * a)), outline=LENS + (al,), width=2)
    d.text((x + 26, y + 18), '语音通话 · 免提', font=F(HEI, 22), fill=LENS + (al,))
    d.text((x + 26, y + 50), name, font=F(HEI, 36, 1), fill=(245, 255, 250, al))
    d.text((x + 150, y + 60), sub, font=F(HEI, 22), fill=(190, 230, 215, al))
    for i in range(28):
        hh = 6 + 26 * abs(math.sin(t * 7 + i * 0.7)) * abs(math.sin(t * 2.3 + i * 0.31))
        bx = x + 26 + i * 13; by = y + 122
        d.rectangle((bx, by - hh, bx + 7, by + hh * 0.3), fill=LENS + (al,))
    g = ov.filter(ImageFilter.GaussianBlur(5))
    return Image.alpha_composite(Image.alpha_composite(im.convert('RGBA'), g), ov).convert('RGB')

@lru_cache(None)
def wall_bg():
    yy, xx = grids()
    r = np.random.default_rng(1)
    w = ndi.gaussian_filter(r.standard_normal((H, W)), (1, 40)).astype(np.float32) * 6 + 22
    spot = np.exp(-(((xx - 960) / 900) ** 2 + ((yy - 380) / 640) ** 2))
    return np.dstack([w, w * 0.85, w * 0.7]) * (0.6 + 0.9 * spot)[..., None]

@lru_cache(None)
def title_canvas():
    canvas = img(wall_bg())
    bx = (300, 110, 1620, 852)
    canvas.paste(S0.load(2, (bx[2] - bx[0], bx[3] - bx[1])), bx[:2])
    return gilt_frame(canvas, bx, band=52), bx

@lru_cache(None)
def dark_gallery():
    a = arr(S0.load(3).filter(ImageFilter.GaussianBlur(12))) * 0.32
    return img(a)

# ---------------- 镜头 ----------------
def s_title(t, T, st):
    base, bx = title_canvas()
    z = lerp(1.0, 1.07, t / T)
    vw, vh = W / z, H / z
    im = base.transform((W, H), Image.EXTENT, ((W - vw) / 2, (H - vh) / 2 - 20 * t / T, (W + vw) / 2, (H + vh) / 2 - 20 * t / T), Image.BILINEAR)
    # 框内闪电
    fk = max(0, 1 - abs(t - 1.3) / 0.12) + 0.7 * max(0, 1 - abs(t - 1.55) / 0.08) + 0.8 * max(0, 1 - abs(t - 4.4) / 0.1)
    if fk > 0:
        a = arr(im); a[150:830, 330:1590] = a[150:830, 330:1590] * (1 + 0.9 * fk) + 40 * fk; im = img(a)
    im = plac(im, ease((t - 2.6) / 0.8), (700, 905), [('画 境 追 宝', F(SONG, 46, 1), (70, 45, 15)),
                                                     ('一副眼镜，追回一只羊首  ·  展品 No.00', F(HEI, 20), (85, 60, 25))], w=520)
    return fade(im, min(t / 1.0, (T - t) / 0.5, 1))

def s_car(t, T, st):
    c = lin_cam(2, t, T, (1130, 560, 1.75), (1170, 590, 2.0))
    im = c.img()
    fk = max(0, 1 - abs(t - 3.2) / 0.1) + 0.6 * max(0, 1 - abs(t - 3.45) / 0.07)
    im = flash(im, fk * 0.6)
    im = rain(im, t, 260)
    im = letterbox(im)
    im = badge(im, after(t, st, 'a2', -0.2), 'REC  第一视角记录', (70, 90))
    return im

def s_gallery(t, T, st):
    c = lin_cam(3, t, T, (470, 330, 1.45), (600, 380, 1.3))
    im = letterbox(c.img())
    tags = [((415, 380), '皇家彩蛋 · 失踪'), ((515, 120), '名画 · 失踪'), ((635, 430), '琥珀装饰 · 失踪'), ((735, 90), '名画 · 失踪')]
    for k, (p, s) in enumerate(tags):
        im = mini_tag(im, c.pt(*p), s, after(t, st, 'b1', 0.3 + k * 0.45, 0.3))
    return im

def s_duke(t, T, st):
    c = cam_path(3, t, (1100, 420, 1.3), (1240, 430, 2.7), 0, T * 0.8)
    im = letterbox(c.img())
    ax, ay = c.pt(1240, 340)
    im = panel(im, vis(t, st, 'b4'), (120, 120), '实时翻译 · 英语', LINES['b4']['zh'], small=LINES['b4']['say'], anchor=(ax, ay), big_size=34)
    return im

@lru_cache(None)
def appraise_parts():
    base = S0.load(4)
    hx0, hy0, hx1, hy1 = round(250 * K), 0, round(730 * K), round(560 * K)
    g = arr(base.crop((hx0, hy0, hx1, hy1)).convert('L'))
    e = np.hypot(ndi.sobel(g, 0), ndi.sobel(g, 1)); e = e / np.percentile(e, 99.5)
    edge = np.clip(ndi.gaussian_filter(e, 1.0) - 0.35, 0, 1)
    sep = np.dstack([g * 0.95 + 25, g * 0.80 + 15, g * 0.58])
    return base, (hx0, hy0, hx1, hy1), edge, sep

def s_appraise(t, T, st):
    base, (hx0, hy0, hx1, hy1), edge, sep = appraise_parts()
    a = arr(base)
    x = ease(t / 3.0)
    off = int(round(lerp(60, 0, x)))
    reg = a[hy0:hy1, hx0:hx1]
    ghost = np.roll(np.roll(sep, off, 1), -off // 2, 0)
    gk = lerp(0.55, 0.3, x) if t < 3.2 else 0.3 * max(0, 1 - (t - 3.2) / 1.0)
    reg[:] = reg * (1 - gk) + ghost * gk
    ek = 0.8 * (0.6 + 0.4 * math.sin(t * 3)) if t < 4.5 else 0.8 * max(0, 1 - (t - 4.5) / 1.5)
    reg[:] = reg * (1 - edge[..., None] * ek) + np.array(LENS) * edge[..., None] * ek
    im = img(a)
    z = lerp(1.0, 1.06, t / T)
    vw, vh = W / z, H / z
    im = im.transform((W, H), Image.EXTENT, (0, 0, vw, vh), Image.BILINEAR)
    d = ImageDraw.Draw(im); L = 40
    s = 1 * z
    for (cx, cy, sx, sy) in [(hx0, hy0 + 90, 1, 1), (hx1, hy0 + 90, -1, 1), (hx0, hy1, 1, -1), (hx1, hy1, -1, -1)]:
        cx, cy = cx * s, cy * s
        d.line((cx, cy, cx + sx * L, cy), fill=LENS, width=4); d.line((cx, cy, cx, cy + sy * L), fill=LENS, width=4)
    d.text((hx0 * s + 8, hy1 * s - 40), '档案影像 1860 · 叠合中' if t < 3.2 else '档案影像 1860 · 已对齐', font=F(HEI, 22), fill=LENS, stroke_width=3, stroke_fill=(0, 0, 0))
    im = letterbox(im)
    im = panel(im, vis(t, st, 'c1', 0.3, 60), (round(770 * K), round(80 * K)), 'AI 识物 · 历史影像比对', '外观特征 高度吻合', small='铸造纹理：待人工核验', anchor=(hx1 * s, 200 * K * s))
    for lid in ('c3', 'c5'):
        im = panel(im, vis(t, st, lid), (110, 640), '实时翻译 · 英语 · 公爵', LINES[lid]['zh'], small=LINES[lid]['say'], big_size=32)
    return im

def s_alarm(t, T, st):
    c = Cam(4, 560, 330, 1.25, shake_at(t, 3))
    im = alarm(c.img(), t, ease(t / 0.3))
    return letterbox(im)

def s_chase(t, T, st):
    c = cam_path(5, t, (330, 380, 1.9), (680, 384, 1.0), 0.3, T - 0.2, shake_at(t, 2))
    im = letterbox(c.img())
    im = arrow_hint(im, vis(t, st, 'd3', 0, 0.3), (260, 560), '左侧接近', math.pi)
    im = arrow_hint(im, vis(t, st, 'd5', 0, 0.3), (1550, 360), '右后方 2 人', 0.7)
    return im

def s_enter1(t, T, st):
    A = Cam(5, 680, 384, 1.0).img()
    B = Cam(6, 680, 384, 1.0).img()
    x = ease(t / (T - 0.3))
    return letterbox(flake_transition(A, B, x, (1250, 520)))

HEADS = [(42, 192), (38, 268), (112, 238), (180, 236), (262, 246), (222, 292), (408, 262),
         (500, 288), (585, 262), (652, 300), (708, 226), (748, 298)]

def s_count(t, T, st):
    c = lin_cam(6, t, T, (680, 384, 1.0), (640, 370, 1.07))
    im = c.img(); d = ImageDraw.Draw(im); f = F(HEI, 26, 1)
    t0 = st['e2'] + 0.2
    for i, (x, y) in enumerate(HEADS, 1):
        if t < t0 + i * 0.16: continue
        X, Y = c.pt(x, y - 50)
        d.ellipse((X - 19, Y - 19, X + 19, Y + 19), outline=LENS, width=3, fill=(8, 28, 24))
        s = str(i); d.text((X - d.textlength(s, font=f) / 2, Y - 15), s, font=f, fill=(240, 255, 250))
    if t > t0 + 13 * 0.16:
        X, Y = c.pt(4, 120); d.text((max(X, 70), Y), '13 ←画外', font=F(HEI, 22), fill=LENS, stroke_width=3, stroke_fill=(0, 0, 0))
    for k, (n, (x, y)) in enumerate([(14, (985, 150)), (15, (1318, 262))]):
        if t < t0 + 13 * 0.16 + 0.4 + k * 0.35: continue
        X, Y = c.pt(x, y - 45)
        d.ellipse((X - 24, Y - 24, X + 24, Y + 24), outline=RED, width=4, fill=(40, 8, 6))
        s = str(n); d.text((X - d.textlength(s, font=f) / 2, Y - 15), s, font=f, fill=(255, 230, 225))
    im = letterbox(im)
    jx, jy = c.pt(408, 200)
    im = panel(im, vis(t, st, 'e1'), (560, 110), '实时翻译 · 意大利语', LINES['e1']['zh'], small=LINES['e1']['say'], anchor=(jx, jy), big_size=34)
    ka = after(t, st, 'e2', DUR['e2'] - 0.4) * (1 - after(t, st, 'e3', DUR['e3'] + 0.3))
    lx, ly = c.pt(985, 150 - 70)
    im = panel(im, ka, (1150, 520), '原作构图比对', '本应 13 位 · 现在 15 位', anchor=(lx, ly), big_size=36)
    return im

def s_shoe(t, T, st):
    c = lin_cam(6, t, T, (820, 610, 2.3), (790, 630, 2.6))
    im = letterbox(c.img())
    a = after(t, st, 'e5', -0.1, 0.4)
    if a > 0:
        y = int(lerp(H, 700, a))
        im = plac(im, 1.0, (1300, y), [('随身物品', F(SONG, 34, 1), (70, 45, 15)),
                                       ('铜羊首 ×1    皮鞋 1/2', F(HEI, 26, 1), (130, 30, 20))], w=500)
    return im

def s_knight(t, T, st):
    tr = 1.9
    B = oil_texture(lin_cam(7, t, T, (520, 400, 1.35), (560, 400, 1.45)).img())
    if t < tr:
        im = oil_reveal(dark_gallery(), B, ease(t / tr))
    else:
        im = B
    im = letterbox(im)
    c = lin_cam(7, t, T, (520, 400, 1.35), (560, 400, 1.45))
    kx, ky = c.pt(255, 300)
    im = panel(im, vis(t, st, 'f1'), (80, 130), '实时翻译 · 中古荷兰语', LINES['f1']['zh'], small=LINES['f1']['say'], anchor=(kx, ky), big_size=36)
    return im

def s_ride(t, T, st):
    sh = shake_at(t, 4, 3.2)
    im = oil_texture(Cam(7, lerp(820, 1120, t / T), lerp(360, 520, t / T) + sh[1] * 0.4, lerp(1.55, 1.6, t / T), sh).img())
    im = letterbox(im)
    im = panel(im, vis(t, st, 'f7', 0, 0.8), (1320, 110), '导航', '前方右转  →', big_size=40)
    im = panel(im, vis(t, st, 'f9', 0, 0.6), (1180, 110), '导航', '正在重新规划…', small='交通方式：马（未支持）', big_size=40)
    return im

def s_cubist(t, T, st):
    tr = 1.6
    src = Cam(8, 680, 384, 1.0).img()
    amp = lerp(3.0, 1.0, ease(t / tr))
    im = cubist(src, t, amp)
    if t < tr * 0.6:
        im = Image.blend(dark_gallery(), im, ease(t / (tr * 0.6)))
    d = ImageDraw.Draw(im); fz = F(HEI, 30, 1)
    ka = after(t, st, 'g3', -0.1, 0.2)
    if ka > 0:
        for (x, y, ang) in [(560, 520, math.pi), (1150, 260, -math.pi / 2 - 0.5), (1560, 640, math.pi * 0.25)]:
            ca, sa = math.cos(ang), math.sin(ang); L = 150
            x2, y2 = x + ca * L, y + sa * L; col = (230, 220, 200)
            d.line((x, y, x2, y2), fill=col, width=10)
            d.polygon([(x2 + ca * 30, y2 + sa * 30), (x2 - sa * 22, y2 + ca * 22), (x2 + sa * 22, y2 - ca * 22)], fill=col)
            d.text((x - 10, y - 50), '左？', font=fz, fill=col, stroke_width=3, stroke_fill=(0, 0, 0))
    im = letterbox(im)
    ga = after(t, st, 'g4', 0, 1.2)
    if ga > 0:
        ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); do = ImageDraw.Draw(ov)
        path = [(640, 990), (760, 930), (880, 905), (980, 900), (1080, 880)]
        n = 1 + ga * (len(path) - 1); k = int(n)
        pp = path[:k] + ([tuple(np.array(path[k - 1]) + (np.array(path[min(k, len(path) - 1)]) - np.array(path[k - 1])) * (n - k))] if k < len(path) else [])
        if len(pp) > 1: do.line(pp, fill=LENS + (255,), width=10, joint='curve')
        if ga >= 1: do.polygon([(1110, 873), (1072, 858), (1078, 905)], fill=LENS + (255,))
        im = Image.alpha_composite(Image.alpha_composite(im.convert('RGBA'), ov.filter(ImageFilter.GaussianBlur(6))), ov).convert('RGB')
        im = panel(im, min(ga * 2, 1), (1160, 740), '导航 · 按标记，不按透视', '跟着这条线', big_size=34)
    return im

def s_feet(t, T, st):
    im = dark_gallery().copy()
    a = ease(t / 0.4)
    im = plac(im, a, (700, 360), [('足部装备', F(SONG, 40, 1), (70, 45, 15)),
                                 ('左：袜子    右：皮鞋', F(HEI, 26, 1), (85, 60, 25)),
                                 ('状态：不对称', F(HEI, 28, 1), (130, 30, 20))], w=520)
    return letterbox(im)

def s_escape(t, T, st):
    c = lin_cam(1, t, T, (900, 420, 1.12), (1000, 380, 1.3), shake_at(t, 2.5, 2))
    im = c.img()
    a = arr(im); s = 0.5 + 0.5 * math.sin(t * 8)
    a[..., 0] += 30 * s; im = img(a)
    im = rain(im, t, 500)
    im = letterbox(im)
    im = panel(im, vis(t, st, 'h1'), (110, 110), '庄园广播 · 英语', LINES['h1']['zh'], small=LINES['h1']['say'], big_size=38)
    return im

def s_gate(t, T, st):
    t6 = st['h6']
    up = ease((t - t6 - 0.5) / 1.3)
    amp = 6 * after(t, st, 'h6', 0.6, 0.2)
    c = Cam(9, lerp(620, 830, up), lerp(560, 290, up), lerp(1.9, 1.25, up), shake_at(t, amp))
    im = c.img()
    if up > 0:
        a = arr(im); yy, xx = grids()
        fx, fy = c.pt(820, 210)
        g = np.exp(-(((xx - fx) / 260) ** 2 + ((yy - fy - 80) / 140) ** 2)) * 120 * up
        a = a + g[..., None] * np.array([0.6, 0.8, 1.0]); im = img(a)
    im = rain(im, t, 200, 5)
    im = letterbox(im)
    im = panel(im, vis(t, st, 'h3', 0, 2.5), (1180, 110), '车辆识别', '实验性短距升力模式', small='能源：仅够 1 次', big_size=36)
    return im

def s_landed(t, T, st):
    amp = 7 * max(0, 1 - t / 1.2)
    c = lin_cam(9, t, T, (680, 384, 1.0), (700, 330, 1.08), shake_at(t, amp))
    im = letterbox(c.img())
    im = panel(im, vis(t, st, 'h7', 0, 1.0), (1320, 600), '车辆状态', '升力储备 0%', big_size=40)
    return im

def s_call(t, T, st):
    c = lin_cam(10, t, T, (520, 470, 1.55), (600, 430, 1.7))
    im = letterbox(c.img())
    im = wave_panel(im, after(t, st, 'i1', DUR['i1'] - 0.3) * (1 - after(t, st, 'i3', DUR['i3'] + 0.2)), t, (110, 110), '许岚', '通话中')
    na = after(t, st, 'i3', 0.0)
    if na > 0:
        k = ease((t - st['i3']) / 2.6)
        dist = int(round(lerp(300, 0, k) / 10) * 10)
        txt = f'距离接应点 {dist} 米' if dist > 0 else '已到达 · 接应点 B'
        im = panel(im, na, (1240, 600), '坐标已接收 · 位置共享', txt, big_size=38)
    return im

def s_cliff(t, T, st):
    c = lin_cam(10, t, T, (700, 384, 1.0), (980, 300, 1.35))
    im = c.img()
    a = arr(im); yy, xx = grids()
    lx, ly = c.pt(780, 40)
    a += np.exp(-(((xx - lx) / 500) ** 2 + ((yy - ly) / 300) ** 2))[..., None] * 25
    im = letterbox(img(a))
    dx, dy = c.pt(780, 120)
    im = panel(im, vis(t, st, 'i4'), (90, 120), '实时翻译 · 英语 · 公爵', LINES['i4']['zh'], small=LINES['i4']['say'], anchor=(dx, dy), big_size=34)
    im = panel(im, vis(t, st, 'i6'), (90, 120), '实时翻译 · 英语 · 公爵', LINES['i6']['zh'], small=LINES['i6']['say'], anchor=(dx, dy), big_size=34)
    ma = after(t, st, 'i5', DUR['i5'] + 0.15, 0.3) * (1 - after(t, st, 'i7', DUR['i7'] + 1.5))
    im = panel(im, ma, (1260, 610), '私密消息', '许岚：接应已就位。', big_size=36)
    if t > T - 0.35: im = Image.new('RGB', (W, H), 0)
    return im

ROTOR_T = 3.2
def s_silence(t, T, st):
    if t < 0.8: return Image.new('RGB', (W, H), 0)
    k = ease((t - ROTOR_T) / 2.5)
    c = Cam(10, 690, 128, 3.0, shake_at(t, 5 * k))
    im = c.img()
    im = img(arr(im) * lerp(0.55, 0.85, k) * np.array([0.85, 0.92, 1.05]))
    im = rotor(im, t, k, speed=lerp(5, 12, k))
    im = dust(im, t, k)
    im = fade(im, ease((t - 0.8) / 0.8))
    return letterbox(im)

def s_fly(t, T, st):
    c = lin_cam(2, t, T, (560, 240, 1.7), (680, 384, 1.0))
    im = c.img()
    im = rotor(im, t + 30, 0.35 * max(0, 1 - t / 3), speed=12)
    d = ImageDraw.Draw(im)
    if int(t * 2) % 2 == 0: d.ellipse((1700, 200, 1712, 212), fill=(255, 60, 60))
    return letterbox(im)

NEWS = ['黑荆棘庄园 · 接受国际调查', '乐奇第一视角记录 · 成为关键证据', '铜羊首 · 经正式程序返还中国']
def s_news(t, T, st):
    im = Image.new('RGB', (W, H), (8, 8, 8)); d = ImageDraw.Draw(im)
    f = F(SONG, 52, 1)
    for i, s in enumerate(NEWS):
        t0 = 0.4 + i * 1.7
        if t < t0: continue
        n = min(len(s), int((t - t0) * 18) + 1)
        d.text((360, 330 + i * 140), s[:n], font=f, fill=(235, 225, 205))
        d.line((360, 330 + i * 140 + 80, 360 + 70 * ease((t - t0) / 0.8) * 16, 330 + i * 140 + 80), fill=GOLD, width=2)
    return fade(im, min(t / 0.3, (T - t) / 0.4, 1))

@lru_cache(None)
def museum_base():
    src = S0.load(4)
    head = src.crop((round(230 * K), 0, round(700 * K), round(560 * K))).resize((560, 668), Image.LANCZOS)
    a = arr(head); yy, xx = np.mgrid[0:668, 0:560]
    v = np.exp(-(((xx - 300) / 330) ** 2 + ((yy - 280) / 420) ** 2))[..., None]
    head = img(a * (0.25 + 0.95 * v) * np.array([1.08, 1.0, 0.88]))
    yy, xx = grids()
    r = np.random.default_rng(3)
    cv = np.full((H, W, 3), 18.0) + (ndi.gaussian_filter(r.standard_normal((H, W)), 30) * 8)[..., None]
    cv = cv + np.exp(-(((xx - 760) / 600) ** 2 + ((yy - 380) / 500) ** 2))[..., None] * np.array([60, 48, 34])
    canvas = img(cv); canvas.paste(head, (480, 150))
    ImageDraw.Draw(canvas).rectangle((470, 140, 1050, 828), outline=(200, 220, 230), width=2)
    return canvas

def s_museum(t, T, st):
    z = lerp(1.0, 1.05, t / T)
    base = museum_base()
    vw, vh = W / z, H / z
    im = base.transform((W, H), Image.EXTENT, ((W - vw) / 2 - 60 * t / T, (H - vh) / 2, (W + vw) / 2 - 60 * t / T, (H + vh) / 2), Image.BILINEAR)
    old = [('铜 羊 首', F(SONG, 44, 1), (70, 45, 15)), ('圆明园十二生肖兽首', F(HEI, 22), (85, 60, 25)),
           ('状态：私人收藏', F(HEI, 28, 1), (85, 60, 25)), ('黑荆棘庄园', F(HEI, 18), (110, 85, 50))]
    new = [('铜 羊 首', F(SONG, 44, 1), (70, 45, 15)), ('圆明园十二生肖兽首', F(HEI, 22), (85, 60, 25)),
           ('状态：已归还', F(HEI, 28, 1), (130, 30, 20)), ('原登记：私人收藏 · 黑荆棘庄园', F(HEI, 18), (110, 85, 50))]
    x = after(t, st, 'k2', DUR['k2'] * 0.6, 0.8)
    a1 = plac(im, 1.0, (1180, 380), old, w=520)
    a2 = plac(im, 1.0, (1180, 380), new, w=520)
    im = Image.blend(a1, a2, x)
    b = after(t, st, 'k2', DUR['k2'] + 0.8, 0.8)
    if b > 0:
        ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov); al = int(255 * b)
        d.text((1180, 640), '看见更多，才有更多可能。', font=F(SONG, 40, 1), fill=(235, 225, 205, al))
        d.text((1180, 700), '乐奇 AI 眼镜', font=F(HEI, 28), fill=LENS + (al,))
        im = Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')
    im = fade(im, min(t / 0.6, 1, (T - t) / 0.6))
    return im

def s_features(t, T, st):
    im = S0.load(11)
    return fade(im, min(t / 0.5, (T - t) / 0.8, 1))

# 镜头表：(函数, 台词[(id, 前置间隔)], 开头留白, 结尾留白, 最短时长, 段落)
SHOTS = [
    (s_title,    [],                                                    0, 0, 6.5, 'manor'),
    (s_car,      [('a1', .2), ('a2', .3), ('a5', .3)], .4, .5, 0, 'manor'),
    (s_gallery,  [('b1', .3), ('b2', .5), ('b3', .3)],                  .4, .5, 0, 'manor'),
    (s_duke,     [('b4', .2), ('b5', .4)],                              .5, .6, 0, 'manor'),
    (s_appraise, [('c1', .4), ('c2', .3), ('c3', .3), ('c4', .3)], .5, .5, 0, 'manor'),
    (s_alarm,    [('d1', .2), ('d2', .3)],                              .5, .4, 0, 'alarm'),
    (s_chase,    [('d3', .1), ('d4', .15), ('d5', .2), ('d6', .15), ('d7', .2)], .2, .6, 0, 'alarm'),
    (s_enter1,   [],                                                    0, 0, 2.4, 'enter'),
    (s_count,    [('e1', .3), ('e2', .4), ('e3', .4)],                  .3, .8, 0, 'paint'),
    (s_shoe,     [('e5', .2), ('e6', .2)],                  .3, .6, 0, 'paint'),
    (s_knight,   [('f1', .2), ('f2', .2), ('f3', .2), ('f4', .2)],      1.9, .4, 0, 'paint'),
    (s_ride,     [('f7', .2), ('f8', .1), ('f9', .2)], .3, .6, 0, 'paint'),
    (s_cubist,   [('g1', .1), ('g2', .4), ('g3', .2), ('g4', .3)],      1.6, 1.2, 0, 'paint'),
    (s_feet,     [('g5', .2), ('g6', .3)],                              .3, .5, 0, 'paint'),
    (s_escape,   [('h1', .2)],                                          .4, .5, 2.8, 'run'),
    (s_gate,     [('h2', .1), ('h3', .3), ('h5', .2), ('h6', .3)], .3, 2.0, 0, 'run'),
    (s_landed,   [('h7', .5), ('h8', .3), ('h9', .3)],                  .3, .7, 0, 'run'),
    (s_call,     [('i1', .2), ('i2', .4), ('i3', .3)],                  .3, 2.4, 0, 'cliff'),
    (s_cliff,    [('i4', .3), ('i5', .4), ('i6', 1.0), ('i7', .3), ('i8', .5)], .3, .8, 0, 'cliff'),
    (s_silence,  [('j1', 1.9)],                                         0, 0, 6.4, 'silence'),
    (s_fly,      [('j2', .3), ('j3', .4), ('j4', .5), ('j5', .3)],      .3, 1.0, 0, 'hero'),
    (s_news,     [],                                                    0, 0, 6.0, 'hero'),
    (s_museum,   [('k1', .8), ('k2', .5)],                              .2, 4.2, 0, 'hero'),
    (s_features, [],                                                    0, 0, 4.5, 'hero'),
]

def timeline():
    tl, g = [], 0.0
    for i, (fn, lines, lead, tail, mn, seg) in enumerate(SHOTS):
        t = lead; st = {}
        for lid, gap in lines:
            t += gap; st[lid] = t; t += DUR[lid]
        T = max(t + tail, mn)
        T = round(T * FPS) / FPS
        tl.append(dict(i=i, name=fn.__name__, start=g, dur=T, seg=seg, lines=st))
        g += T
    return tl

def render_frame(job):
    i, t = job
    fn = SHOTS[i][0]; sh = TL[i]
    im = fn(t, sh['dur'], sh['lines'])
    for lid, s in sh['lines'].items():
        x = LINES[lid]
        if x['lang'] != 'Chinese': continue
        a = vis(t, sh['lines'], lid, 0.05, 0.25)
        if a > 0: im = subtitle(im, x['who'], x['zh'], a)
    return im.tobytes()

TL = timeline()

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--only', default=''); ap.add_argument('--still', default='')
    ap.add_argument('-j', type=int, default=8)
    a = ap.parse_args()
    json.dump(dict(fps=FPS, shots=TL, total=sum(s['dur'] for s in TL)), open(P / 'timeline.json', 'w'), ensure_ascii=False, indent=1)
    print('total', round(sum(s['dur'] for s in TL), 2), 's')
    if a.still:   # 例：--still 8:2.5,9:1 输出单帧检查
        for tok in a.still.split(','):
            i, t = tok.split(':'); i, t = int(i), float(t)
            Image.frombytes('RGB', (W, H), render_frame((i, t))).save(OUT / f'chk_{i:02d}_{t:.1f}.jpg', quality=85)
        sys.exit()
    from multiprocessing import Pool
    only = [int(x) for x in a.only.split(',') if x] or list(range(len(SHOTS)))
    with Pool(a.j) as pool:
        for i in only:
            n = round(TL[i]['dur'] * FPS)
            out = OUT / f'shot{i:02d}.mp4'
            ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                                   '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', str(out)], stdin=subprocess.PIPE)
            for b in pool.imap(render_frame, [(i, k / FPS) for k in range(n)], chunksize=2):
                ff.stdin.write(b)
            ff.stdin.close(); ff.wait()
            print('shot', i, SHOTS[i][0].__name__, TL[i]['dur'], flush=True)
