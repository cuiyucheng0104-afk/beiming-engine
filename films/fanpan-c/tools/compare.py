#!/usr/bin/env python3
"""对战盘两版并排对比图：现在的对战盘 / 风格样图 / C 版 / B 版，每格左上角写谁做的、怎么做的、过程数字
（写在每格上方的说明带里，不压画面：压在画面上会盖住城门的血量牌）。
用法（仓库根目录）：node tools/env/py.mjs films/fanpan-c/tools/compare.py <B 版静帧 PNG> <样图目录>
要先有：films/fanpan-c/out/ref/now-1.png（tools/baseline-shot.mjs 截的）和 films/fanpan-c/out/stills/s_3.jpg（C 版第 3 秒静帧）。
字体用系统里的 Noto Sans CJK（路径写在下面，别的机器按实际位置改）。
输出 films/fanpan-c/out/compare.jpg 和缩小一半的预览 compare-view.jpg。"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'out')      # 输入和输出都在作品的 out/ 下
B_STILL, SAMPLES = sys.argv[1], sys.argv[2]
BOLD = '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc'; BODY = '/usr/share/fonts/noto-cjk/NotoSansCJK-Medium.ttc'
def font(path, size):
    f = ImageFont.truetype(path, size, index=2)      # .ttc 里简体中文那一套
    assert 'SC' in f.getname()[0], f.getname()
    return f

W, H, STRIP, BAND = 1920, 1080, 76, 250
WHITE = (255, 255, 255, 255); SOFT = (228, 230, 238, 255)

def fit(path):
    return Image.open(path).convert('RGB').resize((W, H), Image.LANCZOS)

def mosaic(paths):
    """四张样图拼成一格，中间留细缝。"""
    out = Image.new('RGB', (W, H), (8, 8, 12)); g = 6
    for i, p in enumerate(paths):
        im = Image.open(p).convert('RGB').resize((W // 2 - g // 2, H // 2 - g // 2), Image.LANCZOS)
        out.paste(im, ((i % 2) * (W // 2 + g // 2), (i // 2) * (H // 2 + g // 2)))
    return out

def plate(d, x0, y0, title, lines):
    """在 (x0, y0) 起的说明带里写标题和几行说明；超出说明带就报错。"""
    ft, fb = font(BOLD, 42), font(BODY, 29)
    padx, pady, th, lead = 30, 20, 58, 42
    w = max([d.textlength(title, font=ft)] + [d.textlength(l, font=fb) for l in lines]) + 2 * padx
    assert w <= W and pady + th + lead * len(lines) <= BAND, (title, w, len(lines))
    d.text((x0 + padx, y0 + pady + th / 2), title, font=ft, fill=WHITE, anchor='lm')
    for i, l in enumerate(lines):
        d.text((x0 + padx, y0 + pady + th + lead * i + lead / 2), l, font=fb, fill=SOFT, anchor='lm')

PANELS = [
    (fit(os.path.join(HERE, 'ref', 'now-1.png')), '现在的对战盘 ·《一步翻盘》游戏仓库现状', [
        '谁做的：你的项目（board3d.js，three r180，浏览器里实时画）',
        '怎么来的：本机起游戏、进教学第 1 关后截的图，一个字没改',
        '光是平的：没有投影、没有景深，棋盘和背景一样清楚']),
    (mosaic([os.path.join(SAMPLES, f'{i}.jpg') for i in (1, 2, 3, 4)]), '风格样图 · 你提供的 4 张', [
        '谁做的：你',
        '用法：美术参考，不是游戏里的真实场景；只量景深和光影方案',
        '量到的：画面 25%–55% 清楚、往下越来越虚 · 暗部偏紫 · 高光偏金 · 重暗角']),
    (fit(os.path.join(HERE, 'stills', 's_3.jpg')), 'C 版《林间寨擂》· 北冥代码动画风格 · 86 式', [
        '谁做的：Claude Fable 5.2 写代码，没有 AI 生成的图',
        '怎么做的：three r170 网页渲染 + 自己写的后期（超采样 → 景深 → 泛光 → 调色）',
        '像素画法：色阶表 + 4×4 抖动，每米 40 像素 · 棋子：f1 对 f4',
        '过程数字：3 张 1080p 静帧约 2 秒 · 自己的 5 个文件共 993 行']),
    (fit(B_STILL), 'B 版《沉水擂台》· 北冥原生 · BNE', [
        '谁做的：Claude Fable 5.2 写代码，没有 AI 生成的图',
        '怎么做的：场景导成 2 个 GLB，原生渲染：真实单位的灯、级联阴影、镜头景深',
        '像素画法：浮雕着色 + 2×2 抖动，每米 48 像素 · 棋子：f6 对 f2',
        '过程数字：67 种像素小件、六百多张片 · 灯 14 盏 · 自己的 7 个文件共 1171 行']),
]
FOOT = ('C、B 两版是两个不同的场面，各写各的：像素画法、贴图、小件、调度、棋子阵容都不共用 · '
        '棋子是游戏仓库里的 CC0 序列帧 · 风格样张，未经认可')

CH = BAND + H                                        # 一格 = 说明带 + 画面
sheet = Image.new('RGB', (W * 2, CH * 2 + STRIP), (10, 10, 18))
d = ImageDraw.Draw(sheet); ff = font(BODY, 30)
for i, (im, title, lines) in enumerate(PANELS):
    x0, y0 = (i % 2) * W, (i // 2) * CH
    plate(d, x0, y0, title, lines)
    sheet.paste(im, (x0, y0 + BAND))
d.line([(W, 0), (W, CH * 2)], fill=(40, 42, 54), width=2)
assert d.textlength(FOOT, font=ff) <= W * 2 - 60, d.textlength(FOOT, font=ff)
d.text((W, CH * 2 + STRIP / 2), FOOT, font=ff, fill=(214, 218, 230), anchor='mm')
sheet.save(os.path.join(HERE, 'compare.jpg'), quality=92)
sheet.resize((W, (CH * 2 + STRIP) // 2), Image.LANCZOS).save(os.path.join(HERE, 'compare-view.jpg'), quality=88)
print('写好', os.path.join(HERE, 'compare.jpg'), sheet.size)
