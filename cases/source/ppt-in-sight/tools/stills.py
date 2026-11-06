"""《IN SIGHT 目之所及》故事介绍片 · 静帧参考
两套视觉语言，绝不混用：
  镜片绿  —— 只给眼镜真实能做的事：来电、导航提示、拍照、翻译。永远在“镜框”里出现。
  故事层  —— 讲述者的地图、人物标签、连线、抛物线。暖白底色 + 人物色（Jack 橙 / Ryan 蓝 / Vex 红）。
贯穿全片的一条线：Jack 与 Ryan 之间的联络线。耳机损坏时它断开，Jack 看不见，只能选择相信。
用法：python stills.py   → ../静帧/
"""
import math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '素材' / 'slides'
OUT = ROOT / '静帧'; OUT.mkdir(parents=True, exist_ok=True)
W, H = 1920, 1080
LENS = (108, 255, 150)                    # 镜片绿：只属于眼镜
PAPER = (243, 235, 221)                   # 故事层主色
JACK, RYAN, VEX = (255, 170, 64), (92, 178, 255), (255, 84, 68)
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
AVC = '/System/Library/Fonts/Avenir Next Condensed.ttc'
AVN = '/System/Library/Fonts/Avenir Next.ttc'

def F(size, bold=False): return ImageFont.truetype(HIRA, size, index=1 if bold else 0)
def E(size, w='demi', cond=True):
    return ImageFont.truetype(AVC if cond else AVN, size, index={'bold': 0, 'demi': 2, 'med': 5, 'reg': 7, 'heavy': 8, 'ul': 10}[w])

def cjk(t): return any(ord(c) > 0x2E7F for c in t)
def A(t, size, w='demi', bold=False): return F(size, bold or w in ('bold', 'heavy')) if cjk(t) else E(size, w)

def arr(im): return np.asarray(im.convert('RGB')).astype(np.float32) / 255
def img(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def S(k): return Image.open(SRC / f's{k:02d}.png').convert('RGB')

def fit(im, w=W, h=H, cx=0.5, cy=0.5, zoom=1.0):
    s = max(w / im.width, h / im.height) * zoom
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x = int(np.clip(cx * im.width - w / 2, 0, im.width - w)); y = int(np.clip(cy * im.height - h / 2, 0, im.height - h))
    return im.crop((x, y, x + w, y + h))

def grade(im, sat=1.0, bright=1.0, warm=0.0):
    a = arr(im); g = a.mean(2, keepdims=True)
    a = g + (a - g) * sat; a *= bright
    a[..., 0] += warm * 0.04; a[..., 2] -= warm * 0.04
    return img(a)

def vignette(im, k=0.55, p=2.2):
    a = arr(im); y, x = np.mgrid[0:a.shape[0], 0:a.shape[1]].astype(np.float32)
    r = np.sqrt(((x - a.shape[1] / 2) / (a.shape[1] / 2)) ** 2 + ((y - a.shape[0] / 2) / (a.shape[0] / 2)) ** 2) / 1.414
    return img(a * (1 - k * r ** p)[..., None])

# ---------- 发光层 ----------
def layer(size=(W, H)): return Image.new('L', size, 0)
def glow_add(base, mask_img, color, core=1.0, s1=2.5, s2=12, k1=1.0, k2=0.7):
    a = arr(base); m = np.asarray(mask_img).astype(np.float32) / 255
    c = np.array(color, np.float32) / 255
    g = m * core + ndi.gaussian_filter(m, s1) * k1 + ndi.gaussian_filter(m, s2) * k2
    return img(a + g[..., None] * c)

def shadow_text(im, xy, text, font, fill, anchor='la', blur=6, alpha=200, spacing=0):
    sh = Image.new('L', im.size, 0); d = ImageDraw.Draw(sh)
    d.text(xy, text, font=font, fill=alpha, anchor=anchor, spacing=spacing)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    im.paste((0, 0, 0), (0, 0), sh)
    ImageDraw.Draw(im).text(xy, text, font=font, fill=fill, anchor=anchor, spacing=spacing)

def tracked(d, xy, text, font, fill, track=0.2, anchor='l'):
    """字距加宽的英文标题"""
    widths = [d.textlength(c, font=font) for c in text]
    total = sum(widths) + track * font.size * (len(text) - 1)
    x = xy[0] - (total / 2 if anchor == 'm' else total if anchor == 'r' else 0)
    for c, w in zip(text, widths):
        d.text((x, xy[1]), c, font=font, fill=fill, anchor='ls'); x += w + track * font.size
    return total

def dashed(d, pts, fill, width=3, dash=14, gap=10):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0); n = 0.0
        while n < L:
            a, b = n / L, min(n + dash, L) / L
            d.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)], fill=fill, width=width)
            n += dash + gap

def bez(p0, p1, p2, n=60):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in np.linspace(0, 1, n)]

# ---------- 故事层组件 ----------
def subtitle(im, en, zh, y=None, who=None, color=PAPER):
    """对白字幕：原声一行 + 中文一行。说话人用人物色小标。"""
    y = y or H - 128
    band(im, y - 90, y + 90)
    if who:
        shadow_text(im, (W / 2, y - 44), who, A(who, 26, 'demi', bold=True), who_col(who), anchor='ms')
    shadow_text(im, (W / 2, y), en, E(46, 'med'), color, anchor='ms', blur=8)
    shadow_text(im, (W / 2, y + 52), zh, F(32), (225, 218, 205), anchor='ms', blur=8)

def band(im, y0, y1, k=0.55):
    a = arr(im); yy = np.arange(a.shape[0], dtype=np.float32)
    m = np.clip(1 - np.abs(yy - (y0 + y1) / 2) / ((y1 - y0) / 2 + 60), 0, 1) ** 0.8
    im.paste(img(a * (1 - k * m)[:, None, None]))

def lens_label(im, xy, label):
    d = ImageDraw.Draw(im); f = F(22); tw = d.textlength(label, font=f); x0, y0 = xy
    d.rounded_rectangle([x0, y0, x0 + tw + 28, y0 + 34], radius=5, fill=(6, 20, 10), outline=LENS, width=1)
    d.text((x0 + 14, y0 + 26), label, font=f, fill=LENS, anchor='ls')

def who_col(who):
    w = who.upper()
    return JACK if 'JACK' in w else RYAN if 'RYAN' in w else VEX if 'VEX' in w else PAPER

def narr(im, zh, y=None):
    """旁白字幕：只有中文，略小、居中"""
    shadow_text(im, (W / 2, y or H - 90), zh, F(36), PAPER, anchor='ms', blur=8)

def tag(im, xy, name, role, color, side='r', line_to=None):
    d = ImageDraw.Draw(im); x, y = xy
    if line_to:
        d.line([line_to, (x, y)], fill=color, width=2); d.ellipse([line_to[0] - 5, line_to[1] - 5, line_to[0] + 5, line_to[1] + 5], fill=color)
    nf, rf = E(40, 'bold'), F(22)
    tw = max(d.textlength(name, font=nf), d.textlength(role, font=rf))
    x0 = x if side == 'r' else x - tw - 24
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(ov).rectangle([x0, y - 6, x0 + tw + 36, y + 78], fill=(10, 10, 12, 150))
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB')); d = ImageDraw.Draw(im)
    d.rectangle([x0, y - 2, x0 + 6, y + 70], fill=color)
    shadow_text(im, (x0 + 18, y + 34), name, nf, PAPER, anchor='ls', blur=5)
    shadow_text(im, (x0 + 18, y + 66), role, rf, (220, 212, 198), anchor='ls', blur=5)

def chip(im, xy, text, color, font=None, pad=(18, 10), fill_a=170, anchor='l'):
    font = font or F(26)
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    tw = d.textlength(text, font=font); x, y = xy
    if anchor == 'm': x -= tw / 2 + pad[0]
    if anchor == 'r': x -= tw + 2 * pad[0]
    box = [x, y, x + tw + 2 * pad[0], y + font.size + 2 * pad[1]]
    d.rounded_rectangle(box, radius=6, fill=(12, 12, 14, fill_a), outline=color + (255,), width=2)
    d.text((x + pad[0], y + pad[1] + font.size * 0.86), text, font=font, fill=PAPER, anchor='ls')
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'))
    return box

# ---------- 镜片层（只给眼镜功能） ----------
def lens_frame(im, box, label, radius=34, corner=46, iris=0.0):
    """镜框：四角括号 + 角标“眼镜功能 · X”。iris>0 时镜框外压暗（第一视角）。"""
    if iris > 0:
        m = Image.new('L', im.size, 0); ImageDraw.Draw(m).rounded_rectangle(box, radius=radius * 2, fill=255)
        m = m.filter(ImageFilter.GaussianBlur(40)); a = arr(im); k = np.asarray(m).astype(np.float32) / 255
        im.paste(img(a * (1 - iris + iris * k)[..., None]))
    L = layer(im.size); d = ImageDraw.Draw(L); x0, y0, x1, y1 = box
    for (cx, cy, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(cx, cy + sy * corner), (cx, cy + sy * 8)], fill=255, width=3)
        d.line([(cx + sx * 8, cy), (cx + sx * corner, cy)], fill=255, width=3)
    sh = L.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))   # 亮背景上也看得见
    im.paste((0, 0, 0), (0, 0), sh.point(lambda v: v * 0.7))
    out = glow_add(im, L, LENS, core=0.9, s1=2, s2=8, k1=0.6, k2=0.3)
    im.paste(out)
    d = ImageDraw.Draw(im)
    f = F(22); tw = d.textlength(label, font=f)
    d.rounded_rectangle([x0, y0 - 44, x0 + tw + 28, y0 - 10], radius=5, fill=(6, 20, 10), outline=LENS, width=1)
    d.text((x0 + 14, y0 - 18), label, font=f, fill=LENS, anchor='ls')

def lens_text(im, xy, lines, size=40, anchor='la'):
    L = layer(im.size); d = ImageDraw.Draw(L); x, y = xy
    for i, t in enumerate(lines):
        d.text((x, y + i * size * 1.25), t, font=F(size, True) if cjk(t) else E(size, 'demi', cond=False), fill=255, anchor=anchor)
    im.paste(glow_add(im, L, LENS, core=1.0, s1=1.5, s2=7, k1=0.7, k2=0.35))

# ======================================================================
def s1_cold_open():
    """冷开场：驾驶第一视角，镜框慢慢张开，片名与主题旁白"""
    im = grade(fit(S(4)), sat=0.92, bright=0.9)
    box = (250, 130, W - 250, H - 230)
    lens_frame(im, box, '眼镜功能 · 导航提示', iris=0.78)
    d = ImageDraw.Draw(im)
    tracked(d, (W / 2, 104), 'IN SIGHT', E(64, 'ul', cond=False), PAPER, track=0.55, anchor='m')
    shadow_text(im, (W / 2, H - 150), '目 之 所 及', F(54, True), PAPER, anchor='ms', blur=10)
    narr(im, '目之所及，眼镜帮他看清。目之所及之外，他只能选择相信。', y=H - 72)
    return im

def s2_photo():
    """Ray 的饮料摊：假发被车风掀起，Jack 停车后拍照。快门定格 + 人物标签"""
    base = fit(S(2))
    im = grade(base, sat=1.0, bright=0.9)
    shot = (1180, 56, 1720, 470)                          # 假发那一刻
    a = arr(im); x0, y0, x1, y1 = shot; a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * 0.9 + 0.1; im = img(a)
    ph = grade(base.crop(shot).resize((380, 292), Image.LANCZOS), sat=1.05, bright=1.06)
    card = Image.new('RGB', (400, 312), (240, 240, 236)); card.paste(ph, (10, 10))
    card = card.rotate(-4, expand=True, resample=Image.BICUBIC, fillcolor=(0, 0, 0))
    m = Image.new('L', (400, 312), 255).rotate(-4, expand=True, fillcolor=0)
    im.paste(card, (1490, 560), m)
    lens_frame(im, shot, '眼镜功能 · 拍照')
    lens_text(im, (1206, 452), ['● 已拍摄'], size=26, anchor='ls')
    tag(im, (120, 700), 'JACK', '开车的人 · 戴着眼镜', JACK, line_to=(330, 300))
    tag(im, (560, 110), 'RYAN', '副驾 · 老战友', RYAN, line_to=(640, 470))
    tag(im, (1060, 600), 'RAY', '三人共同的老朋友 · 摊主', PAPER, line_to=(1350, 420))
    subtitle(im, "“You'd better delete that.”", '你最好把那张删了。', who='RAY')
    return im

def coast_map(size=(700, 300)):
    """故事层地图：左栏写赌注，右边画 Coast Hwy 1 → TRITON 研究设施。返回 RGBA 面板和关键点"""
    w, h = size; p = Image.new('RGBA', size, (12, 14, 16, 225)); d = ImageDraw.Draw(p)
    d.rectangle([0, 0, w - 1, h - 1], outline=PAPER + (90,), width=1)
    mx0 = 300                                             # 地图区左边界
    d.line([(mx0, 18), (mx0, h - 18)], fill=PAPER + (60,), width=1)
    coast = [(mx0 + 250, 0), (mx0 + 270, 60), (mx0 + 246, 120), (mx0 + 290, 190), (mx0 + 272, 250), (mx0 + 310, h)]
    d.polygon(coast + [(w, h), (w, 0)], fill=(22, 42, 60, 255))
    for k in range(1, 5):
        d.line([(x + k * 10, y) for x, y in coast], fill=(70, 110, 150, 130 - k * 25), width=1)
    d.text((w - 22, h - 20), 'PACIFIC', font=E(18, 'med'), fill=(120, 160, 200, 255), anchor='rs')
    hwy = [(mx0 + 30, h - 10), (mx0 + 90, h - 70), (mx0 + 140, h - 120), (mx0 + 190, 120), (mx0 + 215, 70), (mx0 + 232, 40)]
    d.line(hwy, fill=(190, 180, 160, 255), width=5, joint='curve')
    d.text((mx0 + 80, h - 110), 'COAST HWY 1', font=E(18, 'demi'), fill=(190, 180, 160, 255), anchor='rm')
    fac = (mx0 + 232, 40); car = (mx0 + 110, h - 98)
    d.rectangle([fac[0] - 20, fac[1] - 14, fac[0] + 20, fac[1] + 14], outline=PAPER + (255,), width=3)
    d.text((fac[0] - 30, fac[1]), 'TRITON 研究设施', font=F(18), fill=PAPER + (255,), anchor='rm')
    stakes = [('雇佣兵已进入设施', VEX), ('核心资料不能外流', PAPER), ('4 人困在下层', RYAN), ('Vex 要提前爆破', VEX)]
    d.text((24, 40), '今天的局面', font=F(22, True), fill=PAPER + (255,), anchor='ls')
    for i, (t, c) in enumerate(stakes):
        y = 86 + i * 54
        d.rectangle([24, y - 14, 30, y + 14], fill=c + (255,)); d.text((44, y), t, font=F(24), fill=PAPER + (255,), anchor='lm')
    return p, fac, car, d

def s3_call():
    """来电：Vex 打进来。故事层地图交代地点和赌注"""
    im = grade(fit(S(3)), sat=0.95, bright=0.88)
    lens_label(im, (24, 200), '眼镜功能 · 来电（手机协同）')
    p, fac, car, d = coast_map()
    for off, c in [(-8, JACK), (8, RYAN)]:
        d.ellipse([car[0] + off - 8, car[1] - 8, car[0] + off + 8, car[1] + 8], fill=c + (255,))
    d.text((car[0] + 24, car[1] + 2), 'Jack + Ryan', font=E(20, 'demi'), fill=PAPER + (255,), anchor='lm')
    pts = bez((fac[0] - 4, fac[1] + 20), (fac[0] - 150, (fac[1] + car[1]) / 2), (car[0] + 4, car[1] - 12), 40)
    dashed(d, pts, VEX + (255,), width=3, dash=10, gap=7)
    d.ellipse([fac[0] + 24, fac[1] - 8, fac[0] + 40, fac[1] + 8], fill=VEX + (255,))
    d.text((fac[0] + 46, fac[1]), 'VEX', font=E(22, 'bold'), fill=VEX + (255,), anchor='lm')
    im.paste(p, (30, 560), p)
    subtitle(im, "“They're already inside, Jack. I'm not waiting.”", '他们已经进去了，Jack。我不等了。', who='VEX · 来电', y=H - 96)
    return im

def s4_jump():
    """追车：SUV 从高位岔道飞落。镜片此刻什么也不显示——判断在人"""
    im = fit(S(5)); im = grade(im, sat=0.85, bright=0.95)
    d = ImageDraw.Draw(im)
    def bracket(box, c):
        x0, y0, x1, y1 = box; k = 30
        for (cx, cy, sx, sy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
            d.line([(cx, cy), (cx + sx * k, cy)], fill=c, width=3); d.line([(cx, cy), (cx, cy + sy * k)], fill=c, width=3)
    bracket((420, 20, 1160, 590), VEX)
    bracket((820, 620, 1390, 905), JACK)
    d.rectangle([1180, 52, 1186, 124], fill=VEX)
    shadow_text(im, (1200, 88), '雇佣兵首领', F(32, True), PAPER, anchor='ls')
    shadow_text(im, (1200, 124), '从高位岔道落下，横停堵路', F(24), PAPER, anchor='ls')
    d.rectangle([1410, 640, 1416, 712], fill=JACK)
    shadow_text(im, (1430, 678), 'JACK', E(40, 'bold'), PAPER, anchor='ls')
    shadow_text(im, (1430, 712), '短刹 · 转向 · 避让', F(24), PAPER, anchor='ls')
    box = (1480, 860, 1880, 1040)
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); ImageDraw.Draw(ov).rounded_rectangle(box, 10, fill=(4, 14, 8, 200))
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'))
    lens_frame(im, box, '镜片此刻', corner=30)
    lens_text(im, (1680, 940), ['（无提示）'], size=30, anchor='mm')
    ImageDraw.Draw(im).text((1680, 1004), '不预测落点，判断在人', font=F(22), fill=(170, 230, 190), anchor='mm')
    return im

def s5_two_throws():
    """两次抛：开场的饮料 ↔ 高潮的钥匙。同一条抛物线，不同的重量"""
    im = Image.new('RGB', (W, H), (10, 10, 11))
    L = grade(fit(S(6), 950, 1080, cx=0.60, cy=0.5, zoom=1.25), sat=0.95, bright=0.92)
    R = grade(fit(S(14), 950, 1080, cx=0.30, cy=0.5, zoom=1.25), sat=1.0, bright=0.95)
    im.paste(L, (0, 0)); im.paste(R, (970, 0))
    band(im, 0, 150, k=0.6)
    arcL = bez((385, 492), (640, 400), (500, 700), 60)        # Jack 指尖 → 瓶子 → Ryan 掌心
    arcR = bez((975, 650), (1246, -179), (1292, 430), 60)       # 画外悬崖边 → 钥匙 → Ryan 掌心
    ov = layer(); d = ImageDraw.Draw(ov)
    dashed(d, arcL, 255, width=4, dash=10, gap=9); dashed(d, arcR, 255, width=4, dash=10, gap=9)
    im = glow_add(im, ov, JACK, core=1.0, s1=2, s2=10, k1=0.8, k2=0.5)
    d = ImageDraw.Draw(im)
    for x, y in [arcL[-1], arcR[-1]]:
        d.ellipse([x - 10, y - 10, x + 10, y + 10], outline=RYAN, width=3)
    shadow_text(im, (60, 92), '开场｜一瓶饮料', F(40, True), PAPER, anchor='ls')
    shadow_text(im, (60, 136), 'Jack 左手握方向盘，右手抛给 Ryan', F(24), PAPER, anchor='ls')
    shadow_text(im, (1030, 92), '高潮｜一把钥匙', F(40, True), PAPER, anchor='ls')
    shadow_text(im, (1030, 136), 'Jack 一手抓住 Vex，空出的手抛给 Ryan', F(24), PAPER, anchor='ls')
    d.rectangle([950, 0, 970, H], fill=(10, 10, 11))
    band(im, H - 140, H, k=0.5)
    shadow_text(im, (W / 2, H - 64), '同一条抛物线，不同的重量。', F(44, True), PAPER, anchor='ms', blur=10)
    return im

def s6_split():
    """分头：墙上的设施路线 → 两人各走一条。约定“上面见”"""
    im = grade(fit(S(8)), sat=0.92, bright=0.9)
    chip(im, (1290, 740), 'RYAN  →  带 4 人撤出', RYAN, font=F(28))
    chip(im, (1290, 806), 'JACK  →  去拿钥匙', JACK, font=F(28))
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); ImageDraw.Draw(ov).rounded_rectangle([44, 140, 420, 420], 10, fill=(10, 10, 12, 190))
    im.paste(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'))
    d = ImageDraw.Draw(im)
    d.text((66, 186), 'Jack 的习惯：每个节点回一句', font=F(24, True), fill=PAPER, anchor='ls')
    for i, (t, c) in enumerate([('节点 1　已确认', PAPER), ('节点 2　已确认', PAPER), ('上层终止台　会合', JACK)]):
        y = 244 + i * 56
        d.ellipse([66, y - 12, 90, y + 12], outline=c, width=3)
        if i < 2: d.line([(72, y), (77, y + 6), (85, y - 6)], fill=c, width=3)
        d.text((106, y), t, font=F(26), fill=c, anchor='lm')
    subtitle(im, "“I'll get the key. You get them out.”", '我去拿钥匙，你把他们救出去。', who='JACK', y=H - 170)
    d = ImageDraw.Draw(im)
    en = "RYAN  “See you upstairs.”  "; zh = '上面见。'
    fe, fz = E(32, 'med'), F(28); tw = d.textlength(en, font=fe) + d.textlength(zh, font=fz)
    x = W / 2 - tw / 2
    shadow_text(im, (x, H - 46), en, fe, RYAN, anchor='ls'); shadow_text(im, (x + d.textlength(en, font=fe), H - 46), zh, fz, RYAN, anchor='ls')
    return im

def s7_link_lost():
    """线断了：左边 Ryan 已带人撤出，右边 Jack 在打斗。中间那条联络线断开"""
    im = Image.new('RGB', (W, H), (8, 8, 9))
    L = grade(fit(S(11), 950, 1080, cx=0.52, zoom=1.0), sat=0.8, bright=0.85)
    R = grade(fit(S(12), 950, 1080, cx=0.45, zoom=1.0), sat=0.95, bright=0.92, warm=0.5)
    im.paste(L, (0, 0)); im.paste(R, (970, 0))
    y = 560
    ov = layer(); ImageDraw.Draw(ov).line([(300, y), (900, y)], fill=255, width=4)
    ovJ = layer(); ImageDraw.Draw(ovJ).line([(1040, y), (1640, y)], fill=255, width=4)
    im = glow_add(im, ov, RYAN, s2=12); im = glow_add(im, ovJ, JACK, s2=12)
    d = ImageDraw.Draw(im)
    d.rectangle([950, 0, 970, H], fill=(8, 8, 9))
    for k in range(7):
        a = k * 0.9; d.line([(905 + 10 * math.cos(a), y + 10 * math.sin(a)), (918 + 26 * math.cos(a), y + 26 * math.sin(a))], fill=PAPER, width=2)
    chip(im, (W / 2, y - 92), 'LINK LOST · 耳机受损', VEX, font=F(28, True), anchor='m', fill_a=215)
    chip(im, (60, 70), '4 / 4 人员已撤出 · 资料已毁', RYAN, font=F(28), fill_a=200)
    chip(im, (60, 140), 'Ryan 知道。Jack 不知道。', PAPER, font=F(24), fill_a=200)
    chip(im, (1030, 70), '没有消息', JACK, font=F(28), fill_a=200)
    chip(im, (1030, 140), 'Jack 只能选择相信 Ryan 会回来', PAPER, font=F(24), fill_a=200)
    band(im, H - 140, H, k=0.5)
    shadow_text(im, (W / 2, H - 64), '线断了。人还在路上。', F(44, True), PAPER, anchor='ms', blur=10)
    return im

def s8_end():
    """结尾：两人坐在平台上。Vex 问，Jack 不答。片名浮现，品牌落版"""
    im = vignette(grade(fit(S(16)), sat=0.9, bright=0.82), k=0.6)
    band(im, H - 380, H, k=0.6)
    subtitle(im, "“Why did you save me?”", '你为什么救我？', who='VEX', y=H - 320)
    shadow_text(im, (W / 2, H - 226), '（ Jack 看向他，没有回答 ）', F(26), (210, 202, 190), anchor='ms')
    d = ImageDraw.Draw(im)
    tracked(d, (W / 2, H - 112), 'IN SIGHT', E(58, 'reg', cond=False), PAPER, track=0.5, anchor='m')
    shadow_text(im, (W / 2, H - 56), '目 之 所 及', F(32, True), PAPER, anchor='ms')
    logo = Image.open(SRC / 'rokid_logo.png').convert('L').resize((170, 45), Image.LANCZOS)
    im.paste((236, 236, 236), (W - 230, H - 86), logo)
    return im

STILLS = [('S1_冷开场_镜框张开', s1_cold_open, '冷开场：第一视角，镜框张开，主题一句话'),
          ('S2_饮料摊_拍照', s2_photo, '饮料摊：拍照功能 + 人物登场'),
          ('S3_来电_地图与赌注', s3_call, 'Vex 来电：地图交代地点和赌注'),
          ('S4_追车_镜片是空的', s4_jump, '追车：镜片什么都不显示，判断在人'),
          ('S5_两次抛_同一条弧', s5_two_throws, '饮料与钥匙：同一条抛物线'),
          ('S6_分头_上面见', s6_split, '分头行动：路线 + 节点确认'),
          ('S7_线断了', s7_link_lost, '联络线断开：一边知道，一边只能相信'),
          ('S8_你为什么救我', s8_end, '结尾：问题没有回答，片名落版')]

if __name__ == '__main__':
    import sys
    only = set(sys.argv[1:])
    thumbs = []
    for name, fn, cap in STILLS:
        if only and not any(o in name for o in only): continue
        im = fn(); im.save(OUT / f'{name}.jpg', quality=92); thumbs.append((im, cap)); print('ok', name)
    if not only:
        tw, th, g = 620, 349, 26
        sheet = Image.new('RGB', (g + 3 * (tw + g), 120 + 3 * (th + 64)), (14, 14, 15)); d = ImageDraw.Draw(sheet)
        d.text((g, 70), 'IN SIGHT 目之所及 · 故事介绍片静帧', font=F(40, True), fill=PAPER, anchor='ls')
        d.text((sheet.width - g, 70), '镜片绿 = 眼镜真实功能　橙 Jack　蓝 Ryan　红 Vex', font=F(24), fill=(190, 184, 172), anchor='rs')
        for i, (im, cap) in enumerate(thumbs):
            x, y = g + (i % 3) * (tw + g), 110 + (i // 3) * (th + 64)
            sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
            d.text((x, y + th + 34), f'{i + 1}　{cap}', font=F(24), fill=PAPER, anchor='ls')
        sheet.save(OUT / '00_总览.jpg', quality=90); print('ok sheet')
