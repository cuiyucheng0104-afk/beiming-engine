"""接触印样张：把一组静帧拼成一张图，方便一眼检查整片。
用法：python tools/contact_sheet.py out.jpg a.jpg b.jpg ... [--cols 4] [--w 480]
每格上方标文件名（Windows 反斜杠路径也只显示文件名）。
"""
import os
import sys
from PIL import Image, ImageDraw

USAGE = '用法：python tools/contact_sheet.py out.jpg a.jpg b.jpg ... [--cols 4] [--w 480]'


def main(argv):
    cols, width = 4, 480
    if '--cols' in argv:
        i = argv.index('--cols'); cols = int(argv[i + 1]); del argv[i:i + 2]
    if '--w' in argv:
        i = argv.index('--w'); width = int(argv[i + 1]); del argv[i:i + 2]
    if len(argv) < 2 or cols < 1 or width < 1:
        print(USAGE, file=sys.stderr)
        return 2
    out, files = argv[0], argv[1:]
    first = Image.open(files[0])
    height = width * first.height // first.width
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * width, rows * (height + 22)), (20, 20, 24))
    draw = ImageDraw.Draw(sheet)
    for k, f in enumerate(files):
        x, y = (k % cols) * width, (k // cols) * (height + 22)
        sheet.paste(Image.open(f).convert('RGB').resize((width, height)), (x, y + 22))
        draw.text((x + 6, y + 5), os.path.basename(f.replace('\\', '/')), fill=(230, 230, 230))
    sheet.save(out, quality=88)
    print(out, sheet.size)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
