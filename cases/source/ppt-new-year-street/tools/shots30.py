"""《这条街照常过年》故事介绍片 · 30 镜静帧（约 3 分钟，每镜约 6 秒）
沿用 stills.py 的效果模块；灯笼计数一条线贯穿：挂灯 0→40，沈烬熄灭 40→5，金线收结 64。
用法：python shots30.py [编号...]   → ../风格样张/30镜/
"""
import math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi
import stills as S
from stills import (W, H, TEAL, GOLD, PURPLE, LANT, SRC, F, arr, img, fit, scope, glow, line_mask, lanterns,
                    extinguish, erosion, knot_paths, panel, lens_frame, counter, subtitle, bubble, street_map,
                    map_layout, STREET_Y, noise)

OUT = S.ROOT / '风格样张' / '30镜'; OUT.mkdir(parents=True, exist_ok=True)
S.tag = lambda im, *a: im            # 复用 stills 的镜头函数时不加它的说明条
RED = (255, 110, 110); GX = 175

def tag(im, k, title, note):
    t = (k - 1) * 6
    out = Image.new('RGB', (W, H + 84), (14, 14, 14)); out.paste(im, (0, 0)); d = ImageDraw.Draw(out)
    d.text((40, H + 14), f'{k:02d}  {title}  ·  {t // 60}:{t % 60:02d}', font=F(26, True), fill=(255, 255, 255))
    d.text((40, H + 50), note, font=F(19), fill=(185, 185, 185))
    return out

def pillar(path, x=None, w=None):
    """竖版素材放进 16:9：背景同图模糊压暗，前景整高"""
    src = Image.open(path).convert('RGB')
    bg = fit(path).filter(ImageFilter.GaussianBlur(40)); bg = img(arr(bg) * 0.32)
    fg = src.resize((round(src.width * H / src.height), H), Image.LANCZOS)
    if w: fg = fg.crop(((fg.width - w) // 2, 0, (fg.width - w) // 2 + w, H))
    bg.paste(fg, ((W - fg.width) // 2 if x is None else x, 0)); return bg

def dashed(path, dash=14, gap=10):
    segs = []
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        L = math.hypot(x1 - x0, y1 - y0); n = int(L // (dash + gap)) + 1
        for i in range(n):
            a = i * (dash + gap) / L; b = min((i * (dash + gap) + dash) / L, 1)
            if a < 1: segs.append([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)])
    return segs

def pts(): return [p for s in map_layout() for p in s['pts']]

def glitch(im, box, amt=10):
    a = np.asarray(im).copy(); x0, y0, x1, y1 = box
    reg = a[y0:y1, x0:x1].copy()
    reg[..., 0] = np.roll(reg[..., 0], amt, 1); reg[..., 2] = np.roll(reg[..., 2], -amt, 1)
    for y in range(0, y1 - y0, 23):
        if (y // 23) % 3 == 0: reg[y:y + 6] = np.roll(reg[y:y + 6], amt * 2, 1)
    a[y0:y1, x0:x1] = reg; return Image.fromarray(a)

def lit_range(a, b): return list(range(a, b))

# ================= 冷开场 =================
def lone_lantern(t_edge):
    base = arr(fit(SRC / 'image12.jpeg')); lab, L = lanterns(base)
    l = max(L, key=lambda l: l['A']); s = l['sl']
    cx, cy, r = l['cx'], l['cy'], l['r']
    crop = img(base).crop((int(cx - r * 3), int(cy - r * 3), int(cx + r * 3), int(cy + r * 3))).resize((520, 520), Image.LANCZOS)
    a = np.zeros((H, W, 3), np.float32) + 0.008
    c = arr(crop); yy, xx = np.mgrid[0:520, 0:520]
    m = np.clip(1 - (np.hypot(xx - 260, yy - 260) - 120) / 140, 0, 1)[..., None]
    a[280:800, 700:1220] = a[280:800, 700:1220] * (1 - m) + c * m
    lm = np.zeros((H, W), np.float32); lm[540, 960] = 1
    a = glow(a, ndi.gaussian_filter(lm, 3) * 400, LANT, core=0, s1=40, s2=160, k1=0.6, k2=0.5)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([xx, W - xx, yy * 1.6, (H - yy) * 1.6]) / 400
    n = noise((H, W), 10, 21) * .6 + noise((H, W), 2.5, 22) * .3
    f = edge - n
    inside = np.clip((t_edge - f) / 0.03, 0, 1); rim = np.clip(1 - np.abs(f - t_edge) / 0.03, 0, 1)
    if t_edge <= 0: return img(a)
    a = a * (1 - inside[..., None])
    return img(glow(a, rim, PURPLE, core=.8, s1=3, s2=16, k1=1, k2=.6))

def s01():
    im = lone_lantern(-0.2)
    return tag(im, 1, '一盏灯', '全黑里只亮一盏灯笼（从原画里抠出的真灯笼），环境声：远处鞭炮、街坊说话，没有音乐')
def s02():
    im = lone_lantern(0.42)
    subtitle(im, '你走，这条街照常过年。', '沈烬', '普', y=930)
    return tag(im, 2, '黑痕逼近', '黑痕从四边往这盏灯啃过来；沈烬的声音先出，人不出现')
def s03():
    im = S.s1_cold_open()
    return tag(im, 3, '金线结出片名', '一根金线从灯里拉出，结成中国结，片名浮在结下；沈烬说完后半句')

# ================= Rokid 与这条街 =================
def s04():
    im = fit(SRC / 'image3.jpeg'); lens_frame(im)
    panel(im, (60, 110, 520, 260), 'ROKID · 已唤醒', [('除夕 16:00 · 唐人街', F(26), (240, 240, 240, 255)),
                                                    ('晴 · 18°C · 距灯会 3 小时', F(22), (180, 220, 210, 255))])
    subtitle(im, '除夕，下午四点。美国西海岸，唐人街。', 'Rokid', '普')
    return tag(im, 4, '下午的唐人街', '暖金斜光的主街（PPT 母题「下午」），镜片开机的第一眼')
def s05():
    im = S.s2_map()
    return tag(im, 5, '街道地图 · 0/64', '全片主线地图：64 个灯笼点全暗，倒计时开始；之后每段从这里推进去、再拉回来')
def s06():
    im = pillar(SRC / 'v1_3.0.png', x=260); lens_frame(im)
    panel(im, (1060, 250, 1800, 720), '人物 · 主人', [])
    d = ImageDraw.Draw(im)
    rows = [('穆清', F(64, True), (255, 255, 255)), ('这条街的守护者', F(28), TEAL), ('异能：御线 · 金线', F(28), GOLD),
            ('平时：找猫 · 翻译 · 挂灯笼', F(26), (220, 220, 220)), ('今晚：舞狮点睛', F(26), (220, 220, 220))]
    y = 290
    for t, f, c in rows: d.text((1100, y), t, font=f, fill=c); y += f.size + 26
    subtitle(im, '我是 Rokid，在他的眼镜里。他叫穆清。', 'Rokid', '普')
    return tag(im, 6, '穆清', 'v1 原片的正脸特写，Rokid 自我介绍并介绍主人；人物卡只写观众需要记住的三件事')

# ================= 街坊日常 =================
def s07():
    im = fit(SRC / 'image8.png'); lens_frame(im); counter(im, 4)
    subtitle(im, 'Hey! Deliveries — rear entrance, buddy.', '司机（英语原声）', '英')
    return tag(im, 7, '翻译 · 送货请走后门', '日常功能一：英语原声 + 镜片翻译（PPT 原图已有翻译框，直接用）')
def s08():
    im = S.s3_workshop()
    return tag(im, 8, '梁伯 · 粤语', '日常功能二：拍照识别出梁伯，粤语原声配实时翻译；PPT 人物立绘变成识别卡')
def s09():
    im = fit(SRC / 'image14.jpeg'); lens_frame(im); d = ImageDraw.Draw(im)
    for (ax, ay), (bx, by), t in [((300, 330), (520, 210), '狮头 · 待点睛'), ((1180, 160), (1300, 300), '竹骨灯笼 · 18 只'),
                                  ((320, 900), (560, 820), '金线 · 扎骨用')]:
        d.line([(ax, ay), (bx, by)], fill=TEAL, width=2); d.ellipse((ax - 6, ay - 6, ax + 6, ay + 6), outline=TEAL, width=2)
        panel(im, (bx, by - 26, bx + 26 + d.textlength(t, font=F(26)) + 10, by + 30), None, [(t, F(26), (240, 240, 240, 255))], alpha=170)
        d = ImageDraw.Draw(im)
    counter(im, 12)
    subtitle(im, '梁伯的彩扎工坊。今晚那只狮头，在这里扎了一个月。', 'Rokid', '普')
    return tag(im, 9, '梁记彩扎', 'PPT 母题「工坊 · 节庆的红」；标签点出金线——它后面会变成整条街的线')
def s10():
    im = img(arr(fit(SRC / 'image3.jpeg').filter(ImageFilter.GaussianBlur(18))) * 0.45); lens_frame(im)
    card = fit(SRC / 'image5.jpeg', 300, 700); im.paste(card, (300, 170))
    d = ImageDraw.Draw(im); d.rectangle((300, 170, 600, 870), outline=TEAL, width=2)
    panel(im, (660, 230, 1300, 560), '拍照识别 · 人物', [('阿棠', F(56, True), (255, 255, 255, 255)), ('舞狮队领队', F(28), TEAL),
                                                        ('三语控场：英 · 粤 · 普', F(26), (220, 220, 220, 255))])
    bubble(im, (600, 640), (660, 620, 1500, 780), '英', 'Lion team, line up! We roll out at seven sharp!', '舞狮队集合！七点整出发！')
    counter(im, 20)
    return tag(im, 10, '阿棠 · 英语', '人物识别卡 + 英语原声翻译；阿棠一个人在三种语言之间切换，是全片的"声音调度员"')
def s11():
    im = fit(SRC / 'image10.png'); lens_frame(im); counter(im, 20, xy=(60, 90))
    subtitle(im, '谜底是"雨"。另外，今晚降雨概率百分之十。', 'Rokid', '普')
    return tag(im, 11, '拍照搜索 · 灯谜', '日常功能三：拍灯谜出答案；Rokid 认真接话，轻喜剧的一拍')
def s12():
    im = street_map(lit=lit_range(0, 28), countdown='01:30:00', marker=(1040, STREET_Y + 60))
    P = [(330, STREET_Y + 60)] + [(s['b'][0], STREET_Y + 60) for s in map_layout()[:4]] + [(1040, STREET_Y + 60)]
    a = glow(arr(im), line_mask(dashed(P, 10, 8), 3), TEAL, core=.9, s1=2, s2=6, k1=.5, k2=.2); im = img(a)
    lens_frame(im); counter(im, 28)
    subtitle(im, '梁伯，灯我来挂。今晚这条街，一盏都不会少。', '穆清', '普', y=H - 142)
    return tag(im, 12, '挂灯 · 28/64', '拉回地图：穆清走过的路线是一条虚线，他挂过的灯一串串亮起——这些位置就是之后金线的锚点')
def s13():
    im = pillar(SRC / 'v1_14.5.png'); lens_frame(im); counter(im, 40)
    panel(im, (60, 300, 520, 450), '舞狮队 · 已集合', [('12 人 · 1 头狮', F(26), (240, 240, 240, 255)),
                                                    ('19:00 从街口出发', F(24), (180, 220, 210, 255))])
    subtitle(im, '七点，舞狮从街口出发。四十盏，已经亮了。', 'Rokid', '普')
    return tag(im, 13, '舞狮集合 · 40/64', 'v1 原片全身 + 狮头；计数到 40，是全片最"满"的一刻，紧接着被打断')

# ================= 沈烬 =================
def s14():
    im = scope(SRC / 'v2_2.5.png'); lens_frame(im)
    box = (1150, 330, 1430, 540)
    im = glitch(im, box, 12); d = ImageDraw.Draw(im)
    d.rectangle(box, outline=RED, width=3)
    panel(im, (1460, 330, 1860, 560), '拍照识别 · 失败', [('无法识别', F(40, True), (255, 120, 120, 255)), ('无档案 · 无记录', F(24), (230, 230, 230, 255)),
                                                         ('能量读数：异常', F(24), (190, 150, 255, 255))], col=RED)
    subtitle(im, '无法识别。他不在任何一份档案里。', 'Rokid', '普')
    return tag(im, 14, '沈烬 · 无法识别', 'v2 原片沈烬特写；识别框故障抖动——全片唯一一次 Rokid 认不出来的人')
def s15():
    base = scope(SRC / 'v2_0.5.png'); a = arr(base); lab, L = lanterns(a)
    feet = (495, 575); reach = [l for l in L if l['cx'] < 1020]
    a = extinguish(a, lab, reach)
    a, _ = erosion(a, (feet[0] + 30, feet[1] + 110), (400, 170), 0.40, seed=9, ymin=feet[1] - 4)
    im = img(a); lens_frame(im); d = ImageDraw.Draw(im)
    for l in sorted([l for l in reach if l['cy'] < 520], key=lambda l: -l['A'])[:6]:
        x, y, r = l['cx'], l['cy'], max(l['r'] * 1.25, 14)
        for sx in (-1, 1):
            for sy in (-1, 1):
                d.line([(x + sx * r, y + sy * r), (x + sx * r * .5, y + sy * r)], fill=RED, width=2)
                d.line([(x + sx * r, y + sy * r), (x + sx * r, y + sy * r * .5)], fill=RED, width=2)
        d.text((x - 18, y + r + 4), '熄灭', font=F(16, True), fill=RED)
    d.rectangle((feet[0] - 40, 440, feet[0] + 40, 585), outline=PURPLE, width=2)
    d.text((feet[0] - 40, 410), '沈烬 · 蚀光', font=F(20, True), fill=(190, 150, 255))
    mp = street_map(lit=lit_range(7, 40), ero=dict(src=(GX, STREET_Y), R=900, t=.30, seed=5), countdown=None, marker=None)
    im.paste(mp.resize((480, 270), Image.LANCZOS), (W - 520, 150)); d.rectangle((W - 520, 150, W - 40, 420), outline=TEAL, width=2)
    counter(im, 33, xy=(W - 330, 440), warn=True)
    subtitle(im, '检测到异常能量：蚀光。街口的灯笼，正在一盏盏熄灭。', 'Rokid', '普', y=H - 100)
    return tag(im, 15, '背影对峙 · 40→33', '代码找出 AI 画面里的灯笼并逐盏熄灭（左半条街暗了、右边还亮）；黑痕从沈烬脚下沿湿路面爬来')
def s16():
    base = fit(SRC / 'image12.jpeg'); a = arr(base); lab, L = lanterns(a)
    a = extinguish(a, lab, [l for l in L if l['cx'] < 1500])
    a, _ = erosion(a, (300, 1180), (900, 420), 0.55, seed=13, ymin=760)
    im = img(a); lens_frame(im); counter(im, 21, warn=True)
    subtitle(im, '这条街，不需要守护者。', '沈烬', '普')
    return tag(im, 16, '夜巷灯灭 · 21', '同一张夜巷原画（第 8 镜亮着）现在灯全灭了，黑痕从路面漫上来——观众认得这条巷子')
def s17():
    im = street_map(lit=lit_range(28, 40), ero=dict(src=(GX, STREET_Y), R=900, t=.62, seed=5), countdown='00:40:00', marker=(1180, STREET_Y + 60))
    lens_frame(im); counter(im, 12, warn=True)
    panel(im, (60, 160, 470, 280), '警告', [('街口 · 失守', F(36, True), (255, 120, 120, 255))], col=RED)
    subtitle(im, '熄灭的，全是他下午挂上的灯。', 'Rokid', '普', y=H - 142)
    return tag(im, 17, '地图 · 黑痕蔓延 · 12', '拉回地图：黑痕从街口吞进来，三串灯一起暗掉；倒计时只剩 40 分钟')

# ================= 查布置 =================
def s18():
    im = fit(SRC / 'image9.png'); lens_frame(im); counter(im, 12, warn=True)
    subtitle(im, '上屋顶。从高处，看得见他的布置。', 'Rokid', '普')
    return tag(im, 18, '屋顶导航', '地形导航（PPT 原图带导航箭头）；PPT 母题「屋顶 · 冷暗夜色」')
def s19():
    im = street_map(lit=lit_range(28, 40), ero=dict(src=(GX, STREET_Y), R=900, t=.62, seed=5), countdown='00:32:00', marker=None)
    P = pts(); hits = [P[i] for i in (3, 10, 13, 19, 22, 27)]
    a = arr(im); a = glow(a, line_mask(dashed(hits, 8, 8), 2), RED, core=.9, s1=2, s2=6, k1=.4, k2=.2); im = img(a); d = ImageDraw.Draw(im)
    for x, y in hits:
        d.line([(x - 14, y - 14), (x + 14, y + 14)], fill=RED, width=4); d.line([(x - 14, y + 14), (x + 14, y - 14)], fill=RED, width=4)
    nx, ny = P[35]
    for r in (22, 40, 58): d.ellipse((nx - r, ny - r, nx + r, ny + r), outline=PURPLE, width=2)
    panel(im, (nx + 70, ny - 160, nx + 470, ny - 30), '预测 · 下一处', [('华兴饼家门口', F(30, True), (255, 255, 255, 255)), ('置信度 92%', F(22), (190, 150, 255, 255))], col=PURPLE)
    lens_frame(im); counter(im, 12, warn=True)
    subtitle(im, '他的落点有规律——他在切断灯与灯之间的线。', 'Rokid', '普', y=H - 142)
    return tag(im, 19, '落点分析', '红叉是被熄灭的位置，连起来是一条规律；紫圈是预测的下一处。观众在这里第一次"看懂"沈烬')
def s20():
    im = street_map(lit=lit_range(28, 40), ero=dict(src=(GX, STREET_Y), R=900, t=.62, seed=5), countdown='00:25:00', marker=(1180, STREET_Y + 60))
    Sx = map_layout(); net = []
    for i in range(len(Sx) - 1):
        for j in (1, 4, 6):
            net.append([Sx[i]['pts'][j], Sx[i + 1]['pts'][(j + 2) % 8]]); net.append([Sx[i]['pts'][(j + 3) % 8], Sx[i + 1]['pts'][j]])
    segs = [s for p in net for s in dashed(p, 10, 9)]
    kn = [s for p in knot_paths(GX + 110, STREET_Y, 80) for s in dashed(p, 8, 8)]
    a = glow(arr(im), line_mask(segs, 2) * .7, GOLD, core=.8, s1=2, s2=6, k1=.4, k2=.2)
    a = glow(a, line_mask(kn, 3), GOLD, core=.9, s1=2, s2=8, k1=.5, k2=.3); im = img(a)
    lens_frame(im); counter(im, 12, warn=True)
    panel(im, (60, 160, 560, 330), '方案 · 御线', [('每盏灯 = 一个锚点', F(26), (255, 230, 180, 255)), ('64 个锚点 · 街口收结', F(26), (255, 230, 180, 255))], col=GOLD)
    subtitle(im, '那就让每一盏灯，都变成一个锚点。', 'Rokid', '普', y=H - 142)
    return tag(im, 20, '布线计划（伏笔）', '金色虚线是计划：灯与灯连成网、街口画出中国结的虚影。这一镜只给方案，不给结果')
def lion_frame(cx, cy, s, rot=-8):
    """彩扎狮头竹骨：半椭球的纬圈 + 经骨 + 下颌弧，正交投影"""
    r = math.radians(rot); rings, ribs = [], []
    def P(u, v, k=1.0):
        x, y, z = math.cos(v) * math.cos(u) * k, math.sin(v) * .85 * k, math.cos(v) * math.sin(u) * k
        x, z = x * math.cos(r) - z * math.sin(r), x * math.sin(r) + z * math.cos(r)
        return (cx + x * s, cy - y * s + z * s * .25)
    for v in np.linspace(0, 1.25, 5): rings.append([P(u, v) for u in np.linspace(-.2, math.pi + .2, 40)])
    for u in np.linspace(0, math.pi, 9): ribs.append([P(u, v) for v in np.linspace(0, 1.4, 20)])
    jaw = [P(u, -.35, .9) for u in np.linspace(.2, math.pi - .2, 30)]
    def ring(u0, v0, rr, k=28):   # 正面的眼圈 / 鼻梁，贴在球面上
        return [P(u0 + rr * math.cos(t), v0 + rr * math.sin(t) * 1.1, 1.04) for t in np.linspace(0, 2 * math.pi, k)]
    eyes = [ring(math.pi / 2 - .42, .5, .2), ring(math.pi / 2 + .42, .5, .2), ring(math.pi / 2, .18, .12)]
    mouth = [P(u, -.05, 1.05) for u in np.linspace(math.pi / 2 - .7, math.pi / 2 + .7, 24)]
    joints = [P(u, v) for u in np.linspace(0, math.pi, 9) for v in np.linspace(0, 1.25, 5)[1:4]]
    return rings + ribs + [jaw, mouth] + eyes, joints
def s21():
    im = Image.new('RGB', (W, H), (16, 18, 22)); im.paste(Image.open(SRC / 'image16.jpeg').convert('RGB').crop((1190, 10, 1672, 552)).resize((960, H), Image.LANCZOS), (0, 0))
    paths, joints = lion_frame(1440, 600, 360)
    a = arr(im); a = glow(a, line_mask(paths, 5), (205, 170, 115), core=.8, s1=1.5, s2=6, k1=.2, k2=.1)
    jm = Image.new('L', (W, H), 0); dj = ImageDraw.Draw(jm)
    for x, y in joints: dj.ellipse((x - 7, y - 7, x + 7, y + 7), outline=255, width=3)
    a = glow(a, np.asarray(jm).astype(np.float32) / 255, GOLD, core=1, s1=2, s2=10, k1=.9, k2=.6); im = img(a)
    lens_frame(im)
    bubble(im, (900, 820), (980, 840, 1880, 990), '粤', '金线扎狮头，扎得实，就唔会散。', '金线扎狮头，扎得牢，就不会散。')
    return tag(im, 21, '狮头竹骨 · 梁伯的话', '左：PPT 狮头内部的真竹骨；右：代码搭的竹骨线框，每个接点用金线缠住——"御线"的来历，也是街口收结的原理')

# ================= 交锋 =================
def s22():
    im = S.s5_fight()
    return tag(im, 22, '第一次交锋', 'AI 打斗原片 + 拳路预测；场外阿棠的英语疏散用翻译气泡带出，三语同时在场')
def s23():
    base = scope(SRC / 'v2_5.0.png'); a = arr(base)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vig = np.clip((np.hypot((xx - W / 2) / W, (yy - H / 2) / H) - .35) / .3, 0, 1)
    a = a + vig[..., None] * np.array([.35, 0, 0]); im = img(a)
    im = glitch(im, (0, 520, W, 560), 16); d = ImageDraw.Draw(im)
    fx, fy = 1000, 500
    for r in (30, 60, 95): d.ellipse((fx - r, fy - r, fx + r, fy + r), outline=RED, width=3)
    d.text((fx - 260, fy - 170), '冲击 · 0.2 秒', font=F(44, True), fill=RED)
    lens_frame(im); counter(im, 9, warn=True)
    subtitle(im, 'Rokid，算他下一拳。', '穆清', '普')
    return tag(im, 23, '拳到眼前', 'v2 原片拳头贴到镜片前；镜片边缘泛红、画面撕裂一下——观众和 Rokid 站在同一个位置')
def s24():
    im = fit(SRC / 'image11.png'); lens_frame(im); counter(im, 7, warn=True)
    subtitle(im, '右肩起势，向左闪。', 'Rokid', '普')
    return tag(im, 24, '动作分析', '战斗功能（PPT 原图带预测弧线）；Rokid 的话越来越短，节奏加快')
def s25():
    base = scope(SRC / 'v2_9.3.png'); a = arr(base)
    a, _ = erosion(a, (700, 960), (700, 220), 0.5, seed=17, ymin=820)
    im = img(a); lens_frame(im); counter(im, 5, warn=True)
    panel(im, (60, 160, 560, 330), '蓄力中', [('2.1 秒后释放', F(34, True), (190, 150, 255, 255)), ('目标：街口牌坊', F(26), (230, 230, 230, 255))], col=PURPLE)
    subtitle(im, '最后一盏。', '沈烬', '普')
    return tag(im, 25, '沈烬蓄力 · 5', 'v2 原片沈烬伏地；黑痕从他手下沿路面裂开。计数到全片最低：5')

# ================= 金线 =================
def s26():
    im = Image.new('RGB', (W, H)); im.paste(pillar(SRC / 'v1_7.5.png', w=760).crop((580, 0, 1340, H)), (0, 0))
    mp = street_map(lit=lit_range(0, 64)[::2], gold=True, ero=dict(src=(-700, STREET_Y), R=900, t=.5, seed=5), countdown=None, marker=None)
    im.paste(mp.crop((60, 280, 1220, 1080)).resize((1160, 800)), (760, 140))
    a = glow(arr(im), line_mask([[(560, 120), (700, 90), (900, 260), (1100, 560)]], 4), GOLD, core=1.1, s1=3, s2=18, k1=1.2, k2=.9)
    im = img(a); lens_frame(im)
    subtitle(im, '现在。', 'Rokid', '普')
    return tag(im, 26, '指尖牵线', '左：v1 原片指尖牵出金线；右：同一根线落进地图，锚点一个接一个亮起——原片和代码在同一帧里接上')
def s27():
    base = fit(SRC / 'image1.jpeg'); a = arr(base); lab, L = lanterns(a)
    m = np.isin(lab, [l['lab'] for l in L]).astype(np.float32)
    a = glow(a, m * .6, LANT, core=.3, s1=5, s2=22, k1=.7, k2=.6)
    kc = np.zeros((H, W), np.float32); kc[392, 1005] = 1
    a = glow(a, ndi.gaussian_filter(kc, 2) * 300, GOLD, core=0, s1=60, s2=200, k1=.6, k2=.5)
    im = img(a); lens_frame(im); counter(im, 64, xy=(60, 90))
    subtitle(im, '这条街，照常过年。', '穆清', '普')
    return tag(im, 27, '街口收结 · 64/64', 'PPT 屋顶金线原图；代码把画里每盏灯笼重新点亮、结心加光——计划在这一刻兑现')
def s28():
    im = S.s6_gold()
    return tag(im, 28, '地图全亮', '拉回地图：金线网收成中国结，64 盏全亮，黑痕压回街外；倒计时归零，灯会开始')

# ================= 饭还热着 =================
def s29():
    im = fit(SRC / 'image15.jpeg'); lens_frame(im); d = ImageDraw.Draw(im)
    ax, ay = 760, 640
    d.line([(ax, ay), (900, 420)], fill=TEAL, width=2); d.ellipse((ax - 7, ay - 7, ax + 7, ay + 7), outline=TEAL, width=2)
    panel(im, (900, 330, 1360, 470), '座位 · 已预留', [('穆清 · 米饭一碗 · 68°C', F(26), (240, 240, 240, 255))])
    subtitle(im, '他们给他留了位置。饭，还热着。', 'Rokid', '普')
    return tag(im, 29, '留着的位置', 'PPT 母题「结尾 · 回到饭桌暖光」；空碗筷 + 一个认真的温度读数，Rokid 最后一次"认真接话"')
def s30():
    im = S.s7_dinner()
    return tag(im, 30, '年夜饭 · 拍照', 'Rokid 拍照定格成那张合影；梁伯粤语"食饭啦"收尾，落版')

SHOTS = [globals()[f's{k:02d}'] for k in range(1, 31)]

if __name__ == '__main__':
    only = [int(x) for x in sys.argv[1:]]
    ims = {}
    for k, fn in enumerate(SHOTS, 1):
        if only and k not in only: continue
        im = fn(); im.save(OUT / f'{k:02d}.jpg', quality=90); ims[k] = im; print(k, end=' ', flush=True)
    if not only:
        tw, th = 480, 291; cols = 5
        sheet = Image.new('RGB', (cols * (tw + 10) + 10, 6 * (th + 10) + 10), (12, 12, 12))
        for k, im in ims.items():
            i = k - 1; sheet.paste(im.resize((tw, th), Image.LANCZOS), (10 + (i % cols) * (tw + 10), 10 + (i // cols) * (th + 10)))
        sheet.save(OUT / '00_总览.jpg', quality=88)
