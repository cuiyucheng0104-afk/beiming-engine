"""④ 镜片即入口：Blender 渲染后加字 / HUD，出总览"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
D = os.path.expanduser('~/Desktop/懂你的人/风格样张/镜片即入口/')
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
G = (120, 255, 170)
f = lambda s, i=1: ImageFont.truetype(HIRA, s, index=i)


def load(n):
    return Image.open(D + f'raw/{n}.png').convert('RGBA')


def tag(im, t):
    ImageDraw.Draw(im).text((56, 44), t, font=f(24, 0), fill=(235, 235, 230, 170))


def sub(im, t, y=990, size=34):
    d = ImageDraw.Draw(im)
    w = d.textlength(t, font=f(size))
    d.text(((1920 - w) / 2, y), t, font=f(size), fill=(255, 250, 240, 255), stroke_width=2, stroke_fill=(0, 0, 0, 170))


def glow_text(im, xy, t, size, col=G):
    lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).text(xy, t, font=f(size), fill=col + (255,))
    g = lay.filter(ImageFilter.GaussianBlur(6))
    im.alpha_composite(g)
    im.alpha_composite(lay)


out = []
im = load('hero'); tag(im, '开场 · 整片只有一副眼镜，每一场都在镜片里')
sub(im, '放学的人群里，没有人喊陈默。'); out.append(('4-1_开场_镜片里的他', im))
im = load('closeup'); tag(im, '推近 · 翻译字幕浮在镜片上')
glow_text(im, (800, 868), '咕噜…咕噜咕噜…', 26, (200, 255, 220))
ImageDraw.Draw(im).line((800, 884, 1010, 884), fill=(200, 255, 220, 200), width=2)
glow_text(im, (800, 908), '别、别打我……我只是，迷路了。', 46); out.append(('4-2_推近_翻译在镜片上', im))
im = load('through'); tag(im, '穿过镜片 · 镜框掠过，进入原画的纵深空间')
sub(im, '眼镜把急促的“咕噜”声，译成了人话。', 960); out.append(('4-3_穿过镜片', im))
im = load('off'); tag(im, '高潮 · 眼镜被摘下，第一次不经过镜片看他')
d = ImageDraw.Draw(im)
for i, l in enumerate(['我刚那句，', '能不能让我再说一遍？']):
    d.text((90, 640 + i * 118), l, font=f(100), fill=(255, 248, 232, 255), stroke_width=3, stroke_fill=(0, 0, 0, 140))
out.append(('4-4_摘下眼镜', im))
im = load('brand'); d = ImageDraw.Draw(im)
for t, s, y in [('乐奇眼镜', 84, 760), ('看得见世界，更懂你想说的话。', 36, 880)]:
    w = d.textlength(t, font=f(s)); d.text(((1920 - w) / 2, y), t, font=f(s), fill=(245, 242, 235, 255))
out.append(('4-5_落版', im))
im = load('desk'); tag(im, '⑤ 陈默的书桌（对比）· 原画是桌上的照片、手机屏，镜头在物件间穿梭')
out.append(('5-1_陈默的书桌', im))
for n, im in out:
    im.convert('RGB').save(D + n + '.jpg', quality=91)
S = Image.new('RGB', (1920 + 30, 1080 + 50), (20, 20, 22))
for k, (n, im) in enumerate(out):
    S.paste(im.convert('RGB').resize((640, 360)), (10 + (k % 3) * 650, 10 + (k // 3) * 370))
S = S.crop((0, 0, 1960, 760))
S.save(D + '00_镜片即入口总览.jpg', quality=88)
print([n for n, _ in out])
