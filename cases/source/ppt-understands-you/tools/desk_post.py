"""⑤ 陈默的书桌：渲染后加字、拼总览"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
D = os.path.expanduser('~/Desktop/懂你的人/风格样张/陈默的书桌/')
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
G = (120, 255, 170)
f = lambda s, i=1: ImageFont.truetype(HIRA, s, index=i)
SHOTS = [
    ('d1_wide', '5-1_开场_书桌全景', '开场 · 一镜到底，整片都在陈默的书桌上', None),
    ('d2_photo', '5-2_停在照片上', '停在照片上 · 镜头落下，照片里的那天开始动', '放学的人群里，没有人喊陈默。'),
    ('d3_phone', '5-3_手机屏', '手机屏 · 课堂上的英语字幕', '课堂上，被老师叫起时，他第一次把答案完整地说了出来。'),
    ('d4_lens', '5-4_隔着眼镜看照片', '隔着眼镜看照片 · 只有镜片里才有翻译', None),
    ('d5_notebook', '5-5_速写本', '速写本 · 他把那句话写得很大', '台下的笑声，变成了掌声。'),
    ('d6_gift', '5-6_星海礼物', '星海礼物 · 夜里，书桌上多了一个包裹', '书桌上多了一个裹着星光的包裹，里面是崭新的同款眼镜。'),
]
out = []
for raw, name, tag, sub in SHOTS:
    im = Image.open(D + f'raw/{raw}.png').convert('RGBA')
    d = ImageDraw.Draw(im)
    d.text((56, 44), tag, font=f(24, 0), fill=(255, 255, 255, 200), stroke_width=2, stroke_fill=(0, 0, 0, 90))
    if raw == 'd4_lens':
        lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        ld.text((440, 852), '咕噜…咕噜咕噜…', font=f(26, 0), fill=(200, 255, 220, 220))
        ld.line((440, 868, 650, 868), fill=(200, 255, 220, 220), width=2)
        ld.text((440, 892), '别、别打我……我只是，迷路了。', font=f(46), fill=G + (255,))
        im.alpha_composite(lay.filter(ImageFilter.GaussianBlur(5)))
        im.alpha_composite(lay)
        d = ImageDraw.Draw(im)
    if sub:
        w = d.textlength(sub, font=f(34))
        d.text(((1920 - w) / 2, 990), sub, font=f(34), fill=(255, 250, 240, 255), stroke_width=2, stroke_fill=(0, 0, 0, 170))
    im.convert('RGB').save(D + name + '.jpg', quality=91)
    out.append(im)
S = Image.new('RGB', (1960, 760), (20, 20, 22))
for k, im in enumerate(out):
    S.paste(im.convert('RGB').resize((640, 360)), (10 + (k % 3) * 650, 10 + (k // 3) * 370))
S.save(D + '00_陈默的书桌总览.jpg', quality=88)
