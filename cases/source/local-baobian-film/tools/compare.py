"""并排对比：把一张（或几张）本片静帧和几张参考静帧排成一行，统一高度，方便评审对照画风。
用法：.venv/bin/python tools/compare.py --out cmp.jpg 本片1.jpg [本片2.jpg] -- 参考1.jpg 参考2.jpg ...
"""
import sys
from PIL import Image, ImageDraw


def main(a):
    out = a[a.index('--out') + 1]; a = [x for i, x in enumerate(a) if x != '--out' and (i == 0 or a[i - 1] != '--out')]
    mine, refs = (a[:a.index('--')], a[a.index('--') + 1:]) if '--' in a else (a, [])
    H = 400; tiles = []
    for f, tag in [(f, '本片') for f in mine] + [(f, '参考') for f in refs]:
        im = Image.open(f).convert('RGB'); im = im.resize((max(1, im.width * H // im.height), H), Image.LANCZOS)
        ImageDraw.Draw(im).rectangle([0, 0, 10, H], fill=(230, 80, 60) if tag == '本片' else (80, 160, 230)); tiles.append(im)
    W = sum(t.width for t in tiles) + 8 * (len(tiles) - 1)
    sheet = Image.new('RGB', (W, H), (18, 18, 20)); x = 0
    for t in tiles: sheet.paste(t, (x, 0)); x += t.width + 8
    sheet.save(out, quality=88); print(out, sheet.size, '（左侧红条=本片，蓝条=参考）')


if __name__ == '__main__':
    main(sys.argv[1:])
