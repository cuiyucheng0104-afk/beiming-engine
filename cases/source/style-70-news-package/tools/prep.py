"""material/*.jpg → assets/*_g.jpg：STYLE §6 统一调色（灰度 → 自动黑白点 → γ1.05 → 35% S 曲线 → 黑 8 白 232 → duotone #0E1013→#ECE7D8；极光一张单独用绿通道与更硬的曲线）。
运行：$LIB/.venv/bin/python -I tools/prep.py <工程目录>"""
import os, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = 60_000_000
HERE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = os.path.join(HERE, 'material'), os.path.join(HERE, 'assets')
os.makedirs(OUT, exist_ok=True)
SHADOW = np.array([14, 16, 19], float); LIGHT = np.array([236, 231, 216], float)
def grade(im, black=8, white=232, gamma=1.05, pct=(0.5, 99.6), s=.35, chan=None):
    # chan='g'：只取绿通道作灰度（极光：绿色光带与同样偏绿的夜面亮度接近，按亮度转灰会糊成一片，绿通道能把光带拉开）
    g = np.asarray(im.convert('L'), float) if chan is None else np.asarray(im, float)[..., 1]
    lo, hi = np.percentile(g, pct[0]), np.percentile(g, pct[1])
    g = np.clip((g - lo) / max(1, hi - lo), 0, 1) ** gamma
    g = g * g * (3 - 2 * g) * s + g * (1 - s)
    g = black / 255 + g * (white - black) / 255
    rgb = SHADOW[None, None] + (LIGHT - SHADOW)[None, None] * g[..., None]
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
# 名称: (源文件, 裁切框(比例) 或 None, 输出最大宽)
JOBS = {'goni': ('goni_full.jpg', None, 4000, {}), 'cold': ('coldair.jpg', None, 3840, {}),
        # 极光：裁掉上方空间站机体与下方空白夜面，光带落在画面中三分之一；只对这一张调硬黑白场与 S 曲线
        'aurora': ('aurora.jpg', (0, .19, 1, .83), 3840, dict(chan='g', pct=(2, 99.8), s=.6, gamma=1.6))}
for name, (fn, crop, mw, kw) in JOBS.items():
    im = Image.open(os.path.join(SRC, fn)).convert('RGB')
    if crop:
        w, h = im.size; im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
    if im.width > mw: im = im.resize((mw, round(im.height * mw / im.width)), Image.LANCZOS)
    grade(im, **kw).save(os.path.join(OUT, f'{name}_g.jpg'), quality=90)
    print(name, im.size)
