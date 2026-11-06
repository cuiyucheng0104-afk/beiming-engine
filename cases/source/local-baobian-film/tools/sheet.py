"""接触印样：把一个目录里的 s_<t>.jpg 按时间排好拼成一张，每格标上时间。
用法：.venv/bin/python tools/sheet.py <目录> [--out sheet.jpg] [--cols 6] [--w 400]
"""
import sys, os, re, glob
from PIL import Image, ImageDraw, ImageFont


def tkey(f):
    m = re.search(r'([0-9]+(?:\.[0-9]+)?)\.jpg$', os.path.basename(f))
    return float(m.group(1)) if m else 1e9


def main(a):
    d = a[0]; out = os.path.join(d, 'sheet.jpg'); cols = 6; w = 400
    if '--out' in a: out = a[a.index('--out') + 1]
    if '--cols' in a: cols = int(a[a.index('--cols') + 1])
    if '--w' in a: w = int(a[a.index('--w') + 1])
    fs = sorted([f for f in glob.glob(os.path.join(d, '*.jpg')) if os.path.basename(f) != os.path.basename(out)], key=tkey)
    if not fs: print('没有图'); return 1
    im0 = Image.open(fs[0]); h = w * im0.height // im0.width
    rows = (len(fs) + cols - 1) // cols; lab = 24
    sheet = Image.new('RGB', (cols * w, rows * (h + lab)), (18, 18, 20)); dr = ImageDraw.Draw(sheet)
    try: font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 16)
    except Exception: font = None
    for k, f in enumerate(fs):
        x, y = (k % cols) * w, (k // cols) * (h + lab)
        sheet.paste(Image.open(f).convert('RGB').resize((w, h), Image.LANCZOS), (x, y + lab))
        t = tkey(f); dr.text((x + 6, y + 3), f't={t:g}s' if t < 1e9 else os.path.basename(f), fill=(240, 220, 120), font=font)
    sheet.save(out, quality=88); print(out, sheet.size); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
