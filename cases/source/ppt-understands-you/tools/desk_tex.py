"""书桌方向：桌上物件的贴图"""
import os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
T = os.path.expanduser('~/Desktop/懂你的人/风格样张/陈默的书桌/tex/')
SRC = os.path.expanduser('~/Desktop/懂你的人/素材/')
FD = os.path.expanduser('~/Desktop/懂你的人/tools/fonts/')
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
pen = lambda s, i=2: ImageFont.truetype(FD + 'Hanzipen.ttc', s, index=i)
hira = lambda s, i=1: ImageFont.truetype(HIRA, s, index=i)
INK = (40, 46, 92)
r = np.random.default_rng(3)

def grain(im, k=6):
    a = np.asarray(im, np.float32)
    n = r.normal(0, k, a.shape[:2])[..., None]
    return Image.fromarray(np.clip(a + n, 0, 255).astype(np.uint8))

# 便利贴
n = Image.new('RGB', (600, 600), (250, 222, 110))
d = ImageDraw.Draw(n)
d.text((70, 190), '懂你的人', font=pen(120), fill=INK)
d.text((90, 380), '— 给球球', font=pen(56, 0), fill=INK)
grain(n, 4).save(T + 'note.png')

# 速写本内页（两页）：左页贴第16页原画，右页是他写大的那句话和小猫草图
W, H = 2400, 1600
p = Image.new('RGB', (W, H), (246, 242, 230))
d = ImageDraw.Draw(p)
for y in range(140, H - 80, 64):
    d.line((90, y, W // 2 - 70, y), fill=(206, 214, 226), width=2)
    d.line((W // 2 + 70, y, W - 90, y), fill=(206, 214, 226), width=2)
d.line((W // 2, 0, W // 2, H), fill=(200, 192, 176), width=6)
ph = Image.open(SRC + 'i16.png').convert('RGB').resize((980, 551))
fr = Image.new('RGB', (1010, 581), (252, 251, 247)); fr.paste(ph, (15, 15))
fr = fr.rotate(-2.5, expand=True, fillcolor=(246, 242, 230))
p.paste(fr, (120, 300))
tape = Image.new('RGB', (230, 70), (232, 220, 176))
for (x, y, a) in [(140, 290, 30), (960, 270, -28)]:
    t = tape.rotate(a, expand=True, fillcolor=(246, 242, 230)); p.paste(t, (x, y))
d.text((150, 980), '第16页  我叫陈默', font=pen(56, 0), fill=INK)
BLANK = p.copy()
for i, l in enumerate(['我刚那句，', '能不能让我', '再说一遍？']):
    d.text((1330 + i * 20, 200 + i * 230), l, font=pen(170 + i * 20), fill=(220, 80, 40))
# 小猫草图
cx, cy = 1900, 1250
d.ellipse((cx - 150, cy - 120, cx + 150, cy + 130), outline=INK, width=8)
d.line([(cx - 130, cy - 60), (cx - 110, cy - 200), (cx - 40, cy - 110)], fill=INK, width=8)
d.line([(cx + 40, cy - 110), (cx + 110, cy - 200), (cx + 130, cy - 60)], fill=INK, width=8)
for ex in (-55, 55): d.ellipse((cx + ex - 12, cy - 20, cx + ex + 12, cy + 4), fill=INK)
d.line([(cx - 20, cy + 50), (cx, cy + 66), (cx + 20, cy + 50)], fill=INK, width=6)
d.text((1430, 1200), '校园猫咪板块', font=pen(64, 0), fill=INK)
grain(p, 3).save(T + 'notebook.png')
grain(BLANK, 3).save(T + 'notebook_blank.png')

# 手机屏：第7页课堂 + 翻译字幕
s = Image.open(SRC + 'i07.png').convert('RGB').resize((2340, 1316))
s = s.crop((0, 120, 2340, 1200))
d = ImageDraw.Draw(s)
d.rounded_rectangle((300, 820, 2040, 1030), radius=30, fill=(10, 40, 28))
d.text((350, 840), 'Go straight and turn left.', font=hira(52, 0), fill=(210, 255, 230))
d.text((350, 920), '直走，然后左转。', font=hira(70), fill=(120, 255, 170))
s.save(T + 'phone.png')

# 夜里的星光包裹盖纸
g = Image.new('RGB', (1024, 1024), (24, 30, 70))
d = ImageDraw.Draw(g)
for i in range(260):
    x, y, rr = r.integers(0, 1024), r.integers(0, 1024), r.random() * 4 + 1
    d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=(255, 230, 170))
g.filter(ImageFilter.GaussianBlur(.6)).save(T + 'starpaper.png')
print(os.listdir(T))
