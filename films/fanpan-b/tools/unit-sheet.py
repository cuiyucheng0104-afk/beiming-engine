# 把候选角色的待机第一帧按游戏里的倍率、脚底对齐拼成一张图，用来挑上场的兵。
# 用法：node tools/env/py.mjs films/fanpan-b/tools/unit-sheet.py <游戏仓库> <输出图> <角色文件名> ...
import sys, os, re
from PIL import Image
game = sys.argv[1]; names = sys.argv[3:]; out = sys.argv[2]
src = open(os.path.join(game, 'chess-gfx.js'), encoding='utf-8').read()
W = 7
sheet = Image.new('RGBA', (W * 200, ((len(names) + W - 1) // W) * 200), (40, 30, 50, 255))
for i, n in enumerate(names):
    m = re.search(r'file:\s*"%s"\s*,([^}]*)}' % n, src)
    kv = dict((k, float(v)) for k, v in re.findall(r'(\w+):\s*([\d.]+)', m.group(1)))
    im = Image.open(os.path.join(game, 'assets/units', n + '_idle.png')).convert('RGBA')
    c = int(kv['cell']); f = im.crop((0, 0, c, im.height))
    s = kv['scale'] * 1.5
    f = f.resize((int(c * s), int(im.height * s)), Image.NEAREST)
    sheet.alpha_composite(f, (i % W * 200 + 100 - f.width // 2, i // W * 200 + 190 - int(kv['feet'] * s)))
sheet.save(out)
