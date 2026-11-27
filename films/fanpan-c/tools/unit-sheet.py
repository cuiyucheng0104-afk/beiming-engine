# 把候选角色待机序列帧的第一帧拼成一张目录图，用来挑上场的兵。
# 用法：node tools/env/py.mjs films/fanpan-c/tools/unit-sheet.py <游戏仓库>/assets/units <输出图> <阵营前缀，逗号分隔，如 f1,f4>
import sys, glob, os
from PIL import Image, ImageDraw
src, out, pref = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
files = sorted(f for f in glob.glob(src + '/*_idle.png') if os.path.basename(f).split('_')[0] in pref)
cells = []
for f in files:
    im = Image.open(f).convert('RGBA'); h = im.height
    cells.append((os.path.basename(f)[:-9], im.crop((0, 0, h, h)).resize((160, 160), Image.NEAREST), im.width // h, h))
cols = 10; rows = (len(cells) + cols - 1) // cols
sheet = Image.new('RGB', (cols * 170, rows * 190), (40, 44, 60)); d = ImageDraw.Draw(sheet)
for i, (n, im, k, h) in enumerate(cells):
    x, y = (i % cols) * 170 + 5, (i // cols) * 190 + 5
    sheet.paste(im, (x, y), im); d.text((x, y + 162), f'{n[:24]}\n{k}f c{h}', fill=(230, 230, 230))
sheet.save(out); print(len(cells), sheet.size)
