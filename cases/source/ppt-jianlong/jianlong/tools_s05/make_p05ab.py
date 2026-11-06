"""S05 专用素材（分段导演自建，只给 S05 用）：从刻线图版 p05 去掉原画绿光，做「浮现」的底版。
  p05a = 去掉原画口诀浮标 + 鹿影（眼镜绿光保留）；p05b = 只去掉原画口诀浮标（鹿影保留）。
  原画浮标在 2× 刻线里糊成一团、读不出字，所以换成代码画的同一句白名单口诀标签（清楚可读）。
去掉的办法：绿像素（及外扩 3 px）用同一行最近的非绿像素填——刻线是横线，同行取值不会断线。
鹿影在 p05a 之上由 p05b 原样显影，不改构图、不重画。
深度沿用 d05（复制成 d05a/d05b，因为图版管理按编号找深度）。"""
import numpy as np, shutil, os
from PIL import Image
from scipy.ndimage import binary_dilation
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
a = np.asarray(Image.open(f'{HERE}/assets/plates/p05.png').convert('RGB')).copy()
H, W = a.shape[:2]
g = (a[..., 1].astype(int) > a[..., 0].astype(int) + 40) & (a[..., 1] > 120)
g = binary_dilation(g, iterations=3)
yy, xx = np.mgrid[0:H, 0:W]
lab = g & (xx >= 782 * 2) & (xx < 1060 * 2) & (yy >= 260 * 2) & (yy < 380 * 2)
deer = g & (xx >= 1060 * 2)
def fill(img, m):
    out = img.copy()
    for y in np.nonzero(m.any(1))[0]:
        row = m[y]; ok = np.nonzero(~row)[0]; bad = np.nonzero(row)[0]
        j = np.clip(np.searchsorted(ok, bad), 1, len(ok) - 1)
        L, R = ok[j - 1], ok[j]
        src = np.where(bad - L <= R - bad, L, R)
        out[y, bad] = img[y, src]
    return out
b = fill(a, lab)
Image.fromarray(b).save(f'{HERE}/assets/plates/p05b.png', optimize=False)
Image.fromarray(fill(b, deer)).save(f'{HERE}/assets/plates/p05a.png', optimize=False)
for s in 'ab': shutil.copyfile(f'{HERE}/assets/depth/d05.png', f'{HERE}/assets/depth/d05{s}.png')
print('ok', lab.sum(), deer.sum())
