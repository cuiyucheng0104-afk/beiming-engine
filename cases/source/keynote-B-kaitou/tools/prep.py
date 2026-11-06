"""素材预处理：从共用材质（本地 Qwen-Image 生成）裁切、缩小出三张纹理。IP 图不经过这里，原样复制。
运行：$LIB/.venv/bin/python tools/prep.py"""
import os
import numpy as np
from PIL import Image, ImageFilter
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(HERE), '共用', '材质')
M = os.path.join(HERE, 'material')
# 1) 台外木桌：避开左上角的台灯底座，取右下区域，压暗后作为台外桌面
d = Image.open(os.path.join(SRC, '木桌.png')).convert('RGB').crop((900, 500, 3328, 1856)).resize((1600, 894), Image.LANCZOS)
a = np.asarray(d).astype(np.float32) / 255
a = a ** 1.25 * 0.55
Image.fromarray((a * 255).clip(0, 255).astype(np.uint8)).save(os.path.join(M, 'desk.jpg'), quality=90)
# 2) 扩散板斑驳：宣纸_逆光 → 灰度、去均值，存为 0..255（128 = 1.0）
m = Image.open(os.path.join(SRC, '宣纸_逆光.png')).convert('L').resize((1163, 410), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.2))
g = np.asarray(m).astype(np.float32); g = (g - g.mean()) / (g.std() + 1e-6)
Image.fromarray((128 + g * 32).clip(0, 255).astype(np.uint8)).save(os.path.join(M, 'mottle.png'))
# 3) 数据纸纤维：宣纸 → 灰度高通，存为 0..255（128 = 不变）
f = Image.open(os.path.join(SRC, '宣纸.png')).convert('L').crop((0, 0, 2400, 1500)).resize((1720, 1075), Image.LANCZOS)
h = np.asarray(f).astype(np.float32); lo = np.asarray(f.filter(ImageFilter.GaussianBlur(24))).astype(np.float32)
hh = h - lo; hh = hh / (hh.std() + 1e-6)
Image.fromarray((128 + hh * 30).clip(0, 255).astype(np.uint8)).save(os.path.join(M, 'fibre.png'))
print('ok')
