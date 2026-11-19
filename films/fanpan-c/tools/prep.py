# 从游戏仓库取几条 CC0 待机序列帧：敌方逐帧水平翻转（面朝左），写出 units.json（格子、脚底、站高、倍率、帧数）。
# films/fanpan-c/units/ 里的十条就是这样来的（多取的两条将领没用上）；stage.js 的 UNITS 表照 units.json 抄。
# 用法：node tools/env/py.mjs films/fanpan-c/tools/prep.py <游戏仓库> <输出目录>
import sys, re, json, os
from PIL import Image
game, out = sys.argv[1], sys.argv[2]
OWN = ['f1_general', 'f1_tank', 'f1_silverguardsquire', 'f1_ranged', 'f1_azuritelion', 'f1_ironcliffeguardian']
FOE = ['f4_juggernaut', 'f4_nightsorrow', 'f4_gloomchaser', 'f4_darkspine', 'f4_crawler', 'f4_bloodmoon']
src = open(os.path.join(game, 'chess-gfx.js'), encoding='utf-8').read()
meta = {}
for name in OWN + FOE:
    m = re.search(r'file:\s*"%s"\s*,([^}]*)}' % name, src)
    if not m: print('缺元数据', name); continue
    kv = dict((k, float(v)) for k, v in re.findall(r'(\w+):\s*([\d.]+)', m.group(1)))
    im = Image.open(os.path.join(game, 'assets/units', name + '_idle.png')).convert('RGBA')
    cell = int(kv['cell']); n = im.width // cell
    if name in FOE:
        flipped = Image.new('RGBA', im.size)
        for i in range(n):
            flipped.paste(im.crop((i * cell, 0, (i + 1) * cell, im.height)).transpose(Image.FLIP_LEFT_RIGHT), (i * cell, 0))
        im = flipped
    im.save(os.path.join(out, name + '_idle.png'))
    meta[name] = dict(cell=cell, rowH=im.height, frames=n, feet=kv.get('feet'), h=kv.get('h'), scale=kv.get('scale'), team='own' if name in OWN else 'foe')
    print(name, meta[name])
json.dump(meta, open(os.path.join(out, 'units.json'), 'w'), indent=1)
