"""《这条街照常过年》故事介绍片 · 静帧参考
系统：Rokid 讲述 + 代码画的街道地图（64 盏灯笼 = 进度）+ 原画/AI 视频里的灯笼真的随剧情明灭。
效果全是代码：灯笼检测与熄灭、蚀光侵蚀、金线与中国结、镜片 HUD、三语翻译气泡。
用法：python stills.py   → ../风格样张/静帧/
"""
import math, random
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '素材' / 'hi'
OUT = ROOT / '风格样张' / '静帧'; OUT.mkdir(parents=True, exist_ok=True)
W, H = 1920, 1080
TEAL = (110, 240, 205); GOLD = (255, 196, 92); PURPLE = (150, 90, 255); LANT = (255, 120, 60)
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'; SONG = '/System/Library/Fonts/Supplemental/Songti.ttc'

def F(size, bold=False, song=False):
    return ImageFont.truetype(SONG if song else HIRA, size, index=(1 if bold else 3) if song else (1 if bold else 0))

def arr(im): return np.asarray(im.convert('RGB')).astype(np.float32) / 255
def img(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))

def fit(path, w=W, h=H):
    im = Image.open(path).convert('RGB')
    s = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))

def scope(path):
    """宽银幕素材：上下黑边，画面 1920×816 居中"""
    base = Image.new('RGB', (W, H), 'black')
    base.paste(fit(path, W, 816), (0, 132)); return base

# ---------- 发光 ----------
def glow(a, mask, color, core=1.0, s1=3, s2=16, k1=1.2, k2=0.9):
    """mask: float HxW 0..1；加色发光"""
    c = np.array(color, np.float32) / 255
    g = mask * core + ndi.gaussian_filter(mask, s1) * k1 + ndi.gaussian_filter(mask, s2) * k2
    return a + g[..., None] * c

def line_mask(paths, width, size=(W, H)):
    m = Image.new('L', size, 0); d = ImageDraw.Draw(m)
    for p in paths:
        d.line([tuple(map(float, q)) for q in p], fill=255, width=width, joint='curve')
    return np.asarray(m).astype(np.float32) / 255

def noise(shape, s, seed):
    r = np.random.default_rng(seed).random(shape).astype(np.float32)
    n = ndi.gaussian_filter(r, s); n = (n - n.min()) / (n.max() - n.min() + 1e-6)
    return n

# ---------- 灯笼检测 / 熄灭 ----------
def lanterns(a, ymax=1.0):
    R, G, B = a[..., 0] * 255, a[..., 1] * 255, a[..., 2] * 255
    m = (R > 185) & (R > G * 1.3) & (B < 120) & (G > 35)
    m = ndi.binary_fill_holes(ndi.binary_closing(m, iterations=2))
    lab, n = ndi.label(m); out = []
    minA = a.shape[0] * a.shape[1] * 0.00012
    for i, s in enumerate(ndi.find_objects(lab)):
        h, w = s[0].stop - s[0].start, s[1].stop - s[1].start
        A = (lab[s] == i + 1).sum()
        if A < minA or A > a.shape[0] * a.shape[1] * 0.03: continue
        if A / (h * w) < 0.5 or not 0.6 < h / w < 2.2: continue
        cy, cx = (s[0].start + s[0].stop) / 2, (s[1].start + s[1].stop) / 2
        if cy > a.shape[0] * ymax: continue
        out.append(dict(lab=i + 1, sl=s, cx=cx, cy=cy, A=A, r=math.sqrt(A / math.pi)))
    return lab, out

def extinguish(a, lab, L, amt=1.0):
    """熄灭：用周围背景把灯体光斑补掉，只留一点暗红纸色，并减掉光晕"""
    if not L: return a
    m = np.isin(lab, [l['lab'] for l in L])
    md = ndi.gaussian_filter(ndi.binary_dilation(m, iterations=3).astype(np.float32), 3.0)
    keep = 1 - ndi.binary_dilation(m, iterations=6).astype(np.float32)
    rmax = max(l['r'] for l in L)
    bg = np.stack([ndi.gaussian_filter(a[..., c] * keep, rmax * .9) for c in range(3)], -1)
    bg /= ndi.gaussian_filter(keep, rmax * .9)[..., None] + 1e-4
    paper = bg * 0.30 + a.mean(-1, keepdims=True) * np.array([0.30, 0.05, 0.05]) + np.array([0.06, 0.01, 0.01])
    halo = np.zeros(m.shape, np.float32)
    for l in L:
        halo += ndi.gaussian_filter((lab == l['lab']).astype(np.float32), l['r'] * 1.4) * 3.0
    halo = np.clip(halo, 0, 1)
    a = a * (1 - md[..., None] * amt) + paper * md[..., None] * amt
    return a * (1 - halo[..., None] * 0.45 * amt)

# ---------- 蚀光 ----------
def erosion(a, src, R, t, seed=3, rim=PURPLE, mask_only=False, ymin=None):
    """从 src 扩散的黑痕：距离场减噪声，阈值 t 以内吞成黑，边缘紫光"""
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    Rx, Ry = (R, R / 1.25) if np.isscalar(R) else R
    d = np.hypot((xx - src[0]) / Rx, (yy - src[1]) / Ry)
    if ymin is not None: d = d + np.clip((ymin - yy) / 70, 0, None)
    n = noise((h, w), 9, seed) * 0.55 + noise((h, w), 2.5, seed + 1) * 0.25
    f = d - n
    inside = np.clip((t - f) / 0.03, 0, 1)
    edge = np.clip(1 - np.abs(f - t) / 0.025, 0, 1)
    if mask_only: return inside
    a = a * (1 - inside[..., None] * 0.86) + inside[..., None] * np.array([0.02, 0.01, 0.03])
    veins = (noise((h, w), 1.2, seed + 7) > 0.62) * np.clip((t + 0.12 - f) / 0.12, 0, 1) * (1 - inside)
    a = a * (1 - veins[..., None] * 0.7)
    return glow(a, edge, rim, core=0.9, s1=3, s2=14, k1=1.1, k2=0.7), inside

# ---------- 中国结（盘长结）----------
def knot_paths(cx, cy, s, n=4, rot=45):
    """盘长结：n×n 交织格 + 四边交替回环 + 四角耳圈，旋转 45° 后挂绳和穗"""
    P = []; g = [(-s + 2 * s * (i + .5) / n) for i in range(n)]; st = 2 * s / n
    for y in g: P.append([(-s, y), (s, y)])
    for x in g: P.append([(x, -s), (x, s)])
    def arc(c, r, a0, a1, k=20): return [(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * j / k)),
                                         c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * j / k))) for j in range(k + 1)]
    for i in range(1, n - 2, 2):            # 内侧成对回环（四边都有）
        m = (g[i] + g[i + 1]) / 2
        P += [arc((s, m), st / 2, -90, 90), arc((-s, m), st / 2, 90, 270),
              arc((m, s), st / 2, 0, 180), arc((m, -s), st / 2, 180, 360)]
    def bez(p0, p1, p2, p3, k=30):
        return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                      for a, b, c, d in zip(p0, p1, p2, p3)) for t in (j / k for j in range(k + 1))]
    e = st * 2.2
    for sx in (-1, 1):
        for sy in (-1, 1):
            hy = g[0] if sy < 0 else g[-1]; vx = g[0] if sx < 0 else g[-1]
            P.append(bez((sx * s, hy), (sx * (s + e), hy), (vx, sy * (s + e)), (vx, sy * s)))
    r = math.radians(rot); out = []
    for p in P:
        out.append([(cx + x * math.cos(r) - y * math.sin(r), cy + x * math.sin(r) + y * math.cos(r)) for x, y in p])
    ys = [q[1] for p in out for q in p]; top, bot = min(ys), max(ys)
    out.append([(cx, top - s * .9), (cx, top)])
    out.append([(cx, bot), (cx, bot + s * .3)])
    for k in range(-5, 6): out.append([(cx + k * s * .03, bot + s * .32), (cx + k * s * .055, bot + s * 1.15)])
    return out

# ---------- 镜片 HUD ----------
def panel(im, box, title=None, lines=(), col=TEAL, fs=26, alpha=150):
    x0, y0, x1, y1 = box
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    d.rounded_rectangle(box, 14, fill=(6, 22, 24, alpha), outline=col + (230,), width=2)
    y = y0 + 14
    if title:
        d.text((x0 + 18, y), title, font=F(20, True), fill=col + (255,)); y += 34
    for t, f, c in lines:
        d.text((x0 + 18, y), t, font=f, fill=c); y += f.size + 12
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'))

def lens_frame(im, label='ROKID'):
    d = ImageDraw.Draw(im); L = 60; m = 36
    for x, y, sx, sy in [(m, m, 1, 1), (W - m, m, -1, 1), (m, H - m, 1, -1), (W - m, H - m, -1, -1)]:
        d.line([(x, y + sy * L), (x, y), (x + sx * L, y)], fill=TEAL, width=3)
    d.text((W - m - 150, m + 12), label, font=F(18, True), fill=TEAL)
    d.ellipse((W - m - 178, m + 17, W - m - 166, m + 29), fill=TEAL)

def counter(im, lit, total=64, xy=(W - 330, 90), warn=False):
    d = ImageDraw.Draw(im); x, y = xy
    col = (255, 110, 110) if warn else GOLD
    panel(im, (x, y, x + 280, y + 112), '灯会防护', [], col=col)
    d = ImageDraw.Draw(im)
    d.text((x + 18, y + 44), f'{lit:02d}', font=F(48, True), fill=col)
    d.text((x + 92, y + 64), f'/ {total} 盏', font=F(22), fill=(220, 220, 220))
    for i in range(16):
        on = i < round(lit / total * 16)
        d.rectangle((x + 200 + (i % 4) * 16, y + 42 + (i // 4) * 16, x + 211 + (i % 4) * 16, y + 53 + (i // 4) * 16),
                    fill=col if on else (60, 50, 45))

def subtitle(im, text, who=None, lang='普', y=H - 92):
    d = ImageDraw.Draw(im); f = F(40)
    col = {'普': (255, 255, 255), '粤': (255, 205, 120), '英': (150, 205, 255)}[lang]
    tw = d.textlength(text, font=f); x = (W - tw) / 2
    for dx, dy in [(2, 2), (0, 2), (2, 0)]: d.text((x + dx, y + dy), text, font=f, fill=(0, 0, 0))
    d.text((x, y), text, font=f, fill=col)
    if who:
        fw = F(22, True); ww = d.textlength(who, font=fw)
        d.text(((W - ww) / 2, y - 34), who, font=fw, fill=col)

def bubble(im, anchor, box, lang, orig, zh):
    """Rokid 实时翻译：原声原文 + 中文，指向说话人"""
    col = (255, 205, 120) if lang == '粤' else (150, 205, 255)
    tag = '粤语 → 中文' if lang == '粤' else 'EN → 中文'
    panel(im, box, f'实时翻译 · {tag}', [(orig, F(24), (200, 200, 200, 255)), (zh, F(34, True), (255, 255, 255, 255))],
          col=TEAL, alpha=165)
    d = ImageDraw.Draw(im); x0, y0, x1, y1 = box
    px = min(max(anchor[0], x0 + 30), x1 - 30); py = y1 if anchor[1] > y1 else y0
    d.line([(px, py), anchor], fill=TEAL, width=2); d.ellipse((anchor[0] - 6, anchor[1] - 6, anchor[0] + 6, anchor[1] + 6), outline=TEAL, width=2)
    d.rectangle((x1 - 64, y0 + 16, x1 - 18, y0 + 34), outline=col, width=2)
    d.text((x1 - 54, y0 + 15), lang, font=F(16, True), fill=col)

def tag(im, code, title, note):
    """说明条放在画面下方另起一条，不压画面"""
    out = Image.new('RGB', (W, H + 84), (14, 14, 14)); out.paste(im, (0, 0)); d = ImageDraw.Draw(out)
    d.text((40, H + 14), f'{code}  {title}', font=F(26, True), fill=(255, 255, 255))
    d.text((40, H + 50), note, font=F(19), fill=(185, 185, 185))
    return out

# ---------- 街道地图 ----------
STREET_Y = 560
def map_layout():
    """主街东西向，四条横街；8 串灯笼斜挂过街，每串 8 盏 = 64"""
    strings = []
    xs = np.linspace(380, 1700, 8)
    for i, x in enumerate(xs):
        a = (x - 40, STREET_Y - 120); b = (x + 40, STREET_Y + 120)
        pts = [(a[0] + (b[0] - a[0]) * (j + .5) / 8, a[1] + (b[1] - a[1]) * (j + .5) / 8 + 14 * math.sin(math.pi * (j + .5) / 8)) for j in range(8)]
        strings.append(dict(a=a, b=b, pts=pts))
    return strings

def street_map(lit=None, ero=None, gold=False, marker=(1180, STREET_Y + 60), size=(W, H), countdown='03:00:00'):
    S = map_layout()
    a = np.zeros((H, W, 3), np.float32) + np.array([0.02, 0.05, 0.07])
    yy, xx = np.mgrid[0:H, 0:W]
    a += (np.exp(-((xx - 1000) ** 2 + (yy - 560) ** 2) / (2 * 700 ** 2)) * 0.06)[..., None] * np.array([0.3, 0.8, 0.8])
    grid = ((xx % 60 == 0) | (yy % 60 == 0)).astype(np.float32) * 0.035
    a += grid[..., None] * np.array(TEAL) / 255
    im = img(a); d = ImageDraw.Draw(im)
    tl = TEAL + (0,)
    blocks = []
    cross = [300, 720, 1140, 1560, 1860]
    for k in range(len(cross) - 1):
        x0, x1 = cross[k] + 45, cross[k + 1] - 45
        blocks += [(x0, 150, x1, STREET_Y - 120), (x0, STREET_Y + 120, x1, 960)]
    for b in blocks:
        d.rounded_rectangle(b, 10, outline=(60, 140, 125), width=2)
        # 铺面隔线
        for x in range(int(b[0]) + 70, int(b[2]), 70):
            y0 = b[3] - 40 if b[1] < STREET_Y else b[1]; d.line([(x, y0), (x, y0 + 40)], fill=(40, 95, 85), width=1)
    d.line([(120, STREET_Y - 100), (1900, STREET_Y - 100)], fill=TEAL, width=3)
    d.line([(120, STREET_Y + 100), (1900, STREET_Y + 100)], fill=TEAL, width=3)
    for x in cross:
        d.line([(x - 40, 120), (x - 40, STREET_Y - 100)], fill=(80, 180, 160), width=2)
        d.line([(x + 40, 120), (x + 40, STREET_Y - 100)], fill=(80, 180, 160), width=2)
        d.line([(x - 40, STREET_Y + 100), (x - 40, 990)], fill=(80, 180, 160), width=2)
        d.line([(x + 40, STREET_Y + 100), (x + 40, 990)], fill=(80, 180, 160), width=2)
    for x in range(160, 1900, 80): d.line([(x, STREET_Y), (x + 40, STREET_Y)], fill=(50, 110, 100), width=2)
    # 牌坊（街口）
    gx = 175; d.rectangle((gx - 22, STREET_Y - 150, gx + 22, STREET_Y + 150), outline=(255, 120, 90), width=3)
    d.line([(gx - 60, STREET_Y - 150), (gx + 60, STREET_Y - 150)], fill=(255, 120, 90), width=5)
    d.line([(gx - 60, STREET_Y + 150), (gx + 60, STREET_Y + 150)], fill=(255, 120, 90), width=5)
    labels = [((gx - 70, STREET_Y + 175), '街口 · 牌坊', (255, 150, 120)), ((400, 200), '永安茶楼', TEAL), ((820, 200), '华兴饼家', TEAL),
              ((1240, 860), '梁记彩扎', TEAL), ((820, 860), '舞狮队 · 集合点', TEAL), ((1640, 200), '金华饭馆', GOLD)]
    for (x, y), t, c in labels:
        d.text((x, y), t, font=F(24, True), fill=c)
    am = np.zeros((H, W), np.float32)
    a = arr(im)
    # 灯笼串
    sm = line_mask([[s['a']] + s['pts'] + [s['b']] for s in S], 2)
    a = a + sm[..., None] * np.array([0.35, 0.25, 0.2])
    allp = [p for s in S for p in s['pts']]
    lit = set(range(64)) if lit is None else set(lit)
    Lm = Image.new('L', (W, H), 0); Dm = Image.new('L', (W, H), 0)
    dl, dd = ImageDraw.Draw(Lm), ImageDraw.Draw(Dm)
    for i, (x, y) in enumerate(allp):
        (dl if i in lit else dd).ellipse((x - 9, y - 11, x + 9, y + 11), fill=255)
    lm = np.asarray(Lm).astype(np.float32) / 255; dm = np.asarray(Dm).astype(np.float32) / 255
    a = a * (1 - dm[..., None]) + dm[..., None] * np.array([0.30, 0.10, 0.08])
    a = glow(a * (1 - lm[..., None]), lm, LANT, core=1.0, s1=4, s2=18, k1=1.4, k2=0.9)
    if gold:
        net = []
        for i in range(len(S) - 1):
            for j in (1, 4, 6):
                net.append([S[i]['pts'][j], S[i + 1]['pts'][(j + 2) % 8]])
                net.append([S[i]['pts'][(j + 3) % 8], S[i + 1]['pts'][j]])
        for s in S: net.append([s['pts'][0], (gx + 70, STREET_Y)]) if s is S[0] else None
        net += [[S[0]['pts'][j], (gx + 110, STREET_Y)] for j in range(0, 8, 2)]
        kn = knot_paths(gx + 110, STREET_Y, 80)
        a = glow(a, line_mask(net, 2) * 0.8, GOLD, core=0.9, s1=2, s2=10, k1=0.8, k2=0.5)
        a = glow(a, line_mask(kn, 6), GOLD, core=1.1, s1=3, s2=22, k1=1.3, k2=1.2)
    if ero is not None:
        a, _ = erosion(a, ero['src'], ero['R'], ero['t'], seed=ero.get('seed', 5))
    im = img(a); d = ImageDraw.Draw(im)
    if marker:
        x, y = marker
        d.ellipse((x - 14, y - 14, x + 14, y + 14), outline=TEAL, width=3); d.ellipse((x - 5, y - 5, x + 5, y + 5), fill=TEAL)
        d.text((x + 22, y - 14), '穆清', font=F(22, True), fill=TEAL)
    d.text((60, 60), '唐人街 · 主街', font=F(30, True), fill=TEAL)
    d.text((60, 102), 'ROKID 地形导航 · 俯视', font=F(18), fill=(150, 200, 190))
    if countdown:
        d.text((W // 2 - 140, 54), '距灯会开始', font=F(20), fill=(170, 210, 200))
        d.text((W // 2 - 140, 80), countdown, font=F(44, True), fill=(255, 255, 255))
    return im if size == (W, H) else im.resize(size, Image.LANCZOS)

# ================= 静帧 =================
def s1_cold_open():
    a = np.zeros((H, W, 3), np.float32) + 0.01
    a, _ = erosion(a + 0.0, (W / 2, H / 2), 900, 99, seed=11) if False else (a, None)
    # 四周黑痕往里啃：反向距离场
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([xx, W - xx, yy * 1.6, (H - yy) * 1.6]) / 400
    n = noise((H, W), 10, 21) * .6 + noise((H, W), 2.5, 22) * .3
    f = edge - n; rim = np.clip(1 - np.abs(f - 0.12) / 0.03, 0, 1)
    a = glow(a, rim, PURPLE, core=.7, s1=3, s2=16, k1=1, k2=.6)
    kn = knot_paths(W / 2, 360, 84)
    a = glow(a, line_mask(kn, 7), GOLD, core=1.15, s1=3, s2=26, k1=1.4, k2=1.4)
    lm = np.zeros((H, W), np.float32); lm[110:118, :] = 0
    im = img(a); d = ImageDraw.Draw(im)
    t = '这条街照常过年'; f = F(96, True, song=True); tw = d.textlength(t, font=f)
    d.text(((W - tw) / 2, 620), t, font=f, fill=(255, 226, 170))
    t2 = 'THE STREET KEEPS ITS NEW YEAR'; f2 = F(22); d.text(((W - d.textlength(t2, font=f2)) / 2, 742), t2, font=f2, fill=(200, 170, 120))
    subtitle(im, '你走，这条街照常过年。你留下，我就一盏一盏灭。', '沈烬', '普', y=840)
    return tag(im, 'S1', '冷开场 · 0:00', '黑痕从四边啃进来，一根金线结出中国结，片名从结下浮出；沈烬一句威胁定调')
    return im

def s2_map():
    im = street_map(lit=[], countdown='03:00:00', marker=(1140, STREET_Y + 50))
    lens_frame(im); counter(im, 0)
    panel(im, (60, 790, 470, 930), 'ROKID', [('已连接 · 除夕 16:00', F(24), (230, 230, 230, 255)),
                                            ('今日任务：挂灯 64 盏', F(24), (230, 230, 230, 255))])
    subtitle(im, '除夕，下午四点。美国西海岸，唐人街。距离灯会开始，还有三小时。', 'Rokid', '普', y=H - 92 - 50)
    return tag(im, 'S2', 'Rokid 开机 · 0:15', '全片的主线地图：64 个灯笼点全暗，倒计时开始。之后每段剧情都从这张图推进去、再拉回来')
    return im

def s3_workshop():
    base = fit(SRC / 'image12.jpeg'); a = arr(base)
    lab, L = lanterns(a)
    a = glow(a, np.isin(lab, [l['lab'] for l in L]).astype(np.float32) * .25, LANT, core=.3, s1=4, s2=14, k1=.4, k2=.3)
    im = img(a); lens_frame(im)
    # 梁伯身份卡（拍照识别）
    card = fit(SRC / 'image6.jpeg', 200, 420)
    panel(im, (1250, 170, 1860, 640), '拍照识别 · 人物', [])
    im.paste(card, (1272, 210)); d = ImageDraw.Draw(im)
    for i, (t, f, c) in enumerate([('梁伯', F(44, True), (255, 255, 255)), ('梁记彩扎 · 工坊主人', F(24), TEAL),
                                   ('关系：穆清的师傅', F(24), (220, 220, 220)), ('常用语言：粤语', F(24), (255, 205, 120)),
                                   ('今晚：等他回来吃饭', F(24), (220, 220, 220))]):
        d.text((1500, 220 + i * 62 + (0 if i == 0 else 10)), t, font=f, fill=c)
    d.text((1272, 600), '识别置信度 98% · 街坊档案', font=F(18), fill=(150, 200, 190))
    bubble(im, (1050, 560), (120, 640, 1000, 800), '粤', '阿清，帮手挂埋呢串灯笼啦。', '阿清，帮我把这串灯笼也挂上。')
    counter(im, 12, xy=(W - 330, 680))
    return tag(im, 'S3', '街坊日常 · 0:40', '日常三项之一：粤语原声 + 镜片实时翻译；PPT 人物立绘变成 Rokid 的识别卡')
    return im

def s4_arrive():
    base = scope(SRC / 'v2_0.5.png'); a = arr(base)
    lab, L = lanterns(a)
    feet = (495, 575)                       # 远处沈烬的脚下
    reach = [l for l in L if l['cx'] < 1020]
    a = extinguish(a, lab, reach)
    a, _ = erosion(a, (feet[0] + 30, feet[1] + 110), (400, 170), 0.40, seed=9, ymin=feet[1] - 4)
    im = img(a); lens_frame(im); d = ImageDraw.Draw(im)
    for l in sorted([l for l in reach if l['cy'] < 520], key=lambda l: -l['A'])[:6]:
        x, y, r = l['cx'], l['cy'], max(l['r'] * 1.25, 14)
        for sx in (-1, 1):
            for sy in (-1, 1):
                d.line([(x + sx * r, y + sy * r), (x + sx * r * .5, y + sy * r)], fill=(255, 110, 110), width=2)
                d.line([(x + sx * r, y + sy * r), (x + sx * r, y + sy * r * .5)], fill=(255, 110, 110), width=2)
        d.text((x - 18, y + r + 4), '熄灭', font=F(16, True), fill=(255, 120, 120))
    d.rectangle((feet[0] - 40, 440, feet[0] + 40, 585), outline=PURPLE, width=2)
    d.text((feet[0] - 40, 410), '沈烬 · 蚀光', font=F(20, True), fill=(190, 150, 255))
    mp = street_map(lit=list(range(12, 19)), ero=dict(src=(175, STREET_Y), R=900, t=.52, seed=5), countdown=None, marker=None)
    mp = mp.resize((480, 270), Image.LANCZOS); im.paste(mp, (W - 520, 150))
    d.rectangle((W - 520, 150, W - 40, 420), outline=TEAL, width=2)
    counter(im, 7, xy=(W - 330, 440), warn=True)
    subtitle(im, '检测到异常能量：蚀光。街口的灯笼，正在一盏盏熄灭。', 'Rokid', '普', y=H - 100)
    return tag(im, 'S4', '沈烬到来 · 1:05', '代码自动找出 AI 画面里的灯笼：左半条街逐盏熄灭、右边还亮着；黑痕从沈烬脚下顺着湿路面爬过来，右上地图同步 12→7')

def s5_fight():
    base = scope(SRC / 'v2_4.2.png'); a = arr(base)
    # 动作预测：拳路弧线（虚线点）
    pts = [(700 + 520 * t, 560 - 160 * math.sin(math.pi * t * .9)) for t in np.linspace(0, 1, 40)]
    dots = [pts[i:i + 2] for i in range(0, 39, 2)]
    a = glow(a, line_mask(dots, 4), TEAL, core=1, s1=2, s2=8, k1=.8, k2=.4)
    im = img(a); lens_frame(im); d = ImageDraw.Draw(im)
    ex, ey = pts[-1]
    for r in (18, 36, 54): d.ellipse((ex - r, ey - r, ex + r, ey + r), outline=TEAL, width=2)
    d.text((ex - 120, ey - 100), '右拳 · 0.4 秒后到达', font=F(24, True), fill=TEAL)
    d.polygon([(150, 520), (200, 490), (200, 550)], fill=TEAL); d.polygon([(205, 520), (255, 490), (255, 550)], fill=TEAL)
    d.text((272, 502), '向左闪避', font=F(32, True), fill=TEAL)
    panel(im, (1480, 170, 1860, 330), '动作分析', [('对手：沈烬', F(24), (230, 230, 230, 255)), ('蚀光强度 ▮▮▮▮▯', F(24), (190, 150, 255, 255))])
    bubble(im, (1900, 860), (1220, 760, 1880, 905), '英', 'Everyone, this way! Stay behind the lion!', '大家往这边走！躲到狮子后面！')
    d = ImageDraw.Draw(im); d.text((1222, 728), '阿棠 · 场外', font=F(20, True), fill=(150, 205, 255))
    return tag(im, 'S5', '交锋 · 1:45', 'AI 打斗原片 + 代码预测轨迹；场外阿棠的英语疏散用翻译气泡带出，三语同时在场')
    return im

def s6_gold():
    im = street_map(lit=None, gold=True, ero=dict(src=(-700, STREET_Y), R=900, t=.42, seed=5), countdown='00:00:00', marker=(330, STREET_Y + 50))
    lens_frame(im); counter(im, 64)
    v = fit(SRC / 'v1_7.5.png', 300, 450)
    im.paste(v, (W - 360, 260)); d = ImageDraw.Draw(im); d.rectangle((W - 360, 260, W - 60, 710), outline=GOLD, width=2)
    d.text((W - 360, 720), '原片：指尖牵出金线', font=F(18), fill=GOLD)
    subtitle(im, '下午挂的每一盏灯，都是他提前布下的线。', 'Rokid', '普', y=H - 92 - 50)
    return tag(im, 'S6', '金线护街口 · 2:20', '伏笔兑现：之前挂灯的位置连成一张金线网，在街口收成中国结；64 盏一起亮，黑痕被压回街外')
    return im

def s7_dinner():
    base = fit(SRC / 'image17.jpeg'); a = arr(base)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    flash = np.exp(-((xx - W / 2) ** 2 + (yy - H / 2) ** 2) / (2 * 900 ** 2)) * .10
    a = a + flash[..., None]
    im = img(a); d = ImageDraw.Draw(im)
    m = 120
    for x, y, sx, sy in [(m, m, 1, 1), (W - m, m, -1, 1), (m, H - m - 60, 1, -1), (W - m, H - m - 60, -1, -1)]:
        d.line([(x, y + sy * 70), (x, y), (x + sx * 70, y)], fill=(255, 255, 255), width=4)
    d.ellipse((W / 2 - 22, H / 2 - 82, W / 2 + 22, H / 2 - 38), outline=(255, 255, 255), width=2)
    panel(im, (W - 560, 150, W - 140, 280), 'ROKID · 拍照', [('已保存 · 除夕 19:02 · 唐人街', F(24), (240, 240, 240, 255)),
                                                         ('相册：今年的年夜饭', F(22), (180, 220, 210, 255))])
    bubble(im, (1720, 520), (1000, 760, 1800, 900), '粤', '齐人未呀？饭还热住，食饭啦！', '人齐了吗？饭还热着，吃饭啦！')
    d = ImageDraw.Draw(im); f = F(54, True, song=True); t = '饭还热着，年照常过。'
    d.text((160, 170), t, font=f, fill=(255, 236, 200))
    return tag(im, 'S7', '饭还热着 · 2:40', 'Rokid 拍照功能做定格：快门、取景框、存档；最后一句粤语收住，落版')
    return im

SHOTS = [('S1_冷开场', s1_cold_open), ('S2_Rokid开机_地图', s2_map), ('S3_街坊日常_粤语翻译', s3_workshop),
         ('S4_沈烬到来_灯笼熄灭', s4_arrive), ('S5_交锋_动作预测', s5_fight), ('S6_金线护街口', s6_gold), ('S7_饭还热着', s7_dinner)]

if __name__ == '__main__':
    import sys
    only = sys.argv[1:]
    ims = []
    for name, fn in SHOTS:
        if only and not any(o in name for o in only): continue
        im = fn(); im.save(OUT / f'{name}.jpg', quality=92); ims.append(im); print(name)
    if not only:
        tw, th = 640, 388; sheet = Image.new('RGB', (tw * 2 + 30, (th + 15) * 4 + 15), (12, 12, 12))
        for k, im in enumerate(ims):
            sheet.paste(im.resize((tw, th), Image.LANCZOS), (10 + (k % 2) * (tw + 10), 10 + (k // 2) * (th + 15)))
        sheet.save(OUT / '00_总览.jpg', quality=90)
