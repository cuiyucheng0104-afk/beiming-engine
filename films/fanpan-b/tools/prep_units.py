# 《沉水擂台》B 版自己的棋子准备：从游戏仓库取 10 条 CC0 待机序列帧（我方 f6 冰蓝白、敌方 f2 红），敌方逐帧左右翻转。
# films/fanpan-b/units/ 里的十条就是这样来的；打印出来的元数据抄进 plan.js。
# 用法：node tools/env/py.mjs films/fanpan-b/tools/prep_units.py <游戏仓库> <输出目录>
import sys, re, json, os
from PIL import Image
game, out = sys.argv[1], sys.argv[2]
OWN = ['f6_icedryad', 'f6_greatwhitenorth', 'f6_snowman', 'f6_arcticrhyno', 'f6_frostdrake']
FOE = ['f2_demononi', 'f2_onnabugeisha', 'f2_pandabear', 'f2_kindling', 'f2_geomancer']
src = open(os.path.join(game, 'chess-gfx.js'), encoding='utf-8').read()
os.makedirs(out, exist_ok=True)
meta = {}
for name in OWN + FOE:
    m = re.search(r'file:\s*"%s"\s*,([^}]*)}' % name, src)
    kv = dict((k, float(v)) for k, v in re.findall(r'(\w+):\s*([\d.]+)', m.group(1)))
    im = Image.open(os.path.join(game, 'assets/units', name + '_idle.png')).convert('RGBA')
    cell = int(kv['cell']); n = im.width // cell
    if name in FOE:
        flip = Image.new('RGBA', im.size)
        for i in range(n):
            flip.paste(im.crop((i * cell, 0, (i + 1) * cell, im.height)).transpose(Image.FLIP_LEFT_RIGHT), (i * cell, 0))
        im = flip
    im.save(os.path.join(out, name + '.png'))
    meta[name] = dict(cell=cell, rowH=im.height, frames=n, feet=int(kv['feet']), h=int(kv['h']), scale=kv['scale'])
    print(name, json.dumps(meta[name]))
