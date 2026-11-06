"""Prepare web-sized material textures from material/*.png (IP images are NOT touched: they are used as the original PNGs)."""
import os, sys
from PIL import Image
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(HERE, 'material'); O = os.path.join(HERE, 'material', 'web'); os.makedirs(O, exist_ok=True)
jobs = [('宣纸.png', 'paper.jpg', 2048), ('宣纸_逆光.png', 'paper_back.jpg', 2048), ('书封布面.png', 'cloth.jpg', 2048),
        ('装裱绫绢.png', 'silk.jpg', 2048), ('棉布幕_透光.png', 'curtain.jpg', 2048)]
for src, dst, w in jobs:
    p = os.path.join(O, dst)
    if os.path.exists(p): continue
    im = Image.open(os.path.join(M, src)).convert('RGB')
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(p, quality=92); print(dst, im.size)
