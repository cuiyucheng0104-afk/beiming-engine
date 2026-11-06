"""手工深度图：读 depth_specs/iNN.json，输出 深度图 + 叠加检查图
用法：python depth_render.py i03 [i04 ...]
spec 格式（坐标一律按 1920×1080 原画坐标，z：0=最远 1=最近）：
{
  "ground": [0.55, 0.0, 0.6],          # 可选：从画面高度 0.55 往下，深度由 0.0 线性增到 0.6（地面/桌面）
  "layers": [                          # 由远到近依次覆盖
    {"poly": [[x,y],...], "z": 0.3},
    {"ellipse": [x0,y0,x1,y1], "z": 0.9},
    {"poly": [...], "z_top": 0.5, "z_bottom": 0.8}   # 纵向渐变（如斜着的墙、地上的物体）
  ],
  "blur": 12                           # 羽化像素（按 1920 宽算），默认 12
}"""
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

T = os.path.expanduser('~/Desktop/懂你的人/')
SPEC = T + 'tools/depth_specs/'
OUT = T + '风格样张/陈默的书桌/tex/depth/'
CHK = T + 'tools/depth_specs/check/'
W, H = 1672, 940
K = W / 1920


def render(key):
    sp = json.load(open(SPEC + key + '.json'))
    yy = np.arange(H, dtype=np.float32)[:, None] / H * np.ones((1, W), np.float32)
    z = np.zeros((H, W), np.float32)
    if sp.get('ground'):
        h0, a, b = sp['ground']
        z = np.where(yy > h0, a + (b - a) * (yy - h0) / max(1e-3, 1 - h0), z).astype(np.float32)
    for L in sp.get('layers', []):
        m = Image.new('L', (W, H), 0)
        d = ImageDraw.Draw(m)
        if 'poly' in L:
            d.polygon([(x * K, y * K) for x, y in L['poly']], fill=255)
        else:
            x0, y0, x1, y1 = L['ellipse']
            d.ellipse((x0 * K, y0 * K, x1 * K, y1 * K), fill=255)
        mk = np.asarray(m, np.float32) / 255
        if 'z' in L:
            v = np.full((H, W), L['z'], np.float32)
        else:
            ys = np.nonzero(mk.any(1))[0]
            t = np.clip((yy - ys.min() / H) / max(1e-3, (ys.max() - ys.min()) / H), 0, 1)
            v = L['z_top'] + (L['z_bottom'] - L['z_top']) * t
        z = z * (1 - mk) + v * mk
    im = Image.fromarray((np.clip(z, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sp.get('blur', 12) * K))
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(CHK, exist_ok=True)
    im.save(OUT + key + '.png')
    # 检查图：左原画、右深度伪彩叠加 + 等深线
    src = Image.open(T + f'素材/{key}.png').convert('RGB').resize((960, 540))
    dz = np.asarray(im.resize((960, 540)), np.float32) / 255
    col = np.stack([dz, 1 - np.abs(dz - .5) * 2, 1 - dz], -1) * 255
    ov = (np.asarray(src, np.float32) * .45 + col * .55).astype(np.uint8)
    lev = (np.floor(dz * 8) != np.floor(np.roll(dz, 1, 0) * 8)) | (np.floor(dz * 8) != np.floor(np.roll(dz, 1, 1) * 8))
    ov[lev] = 255
    S = Image.new('RGB', (1920, 540))
    S.paste(src, (0, 0))
    S.paste(Image.fromarray(ov), (960, 0))
    S.save(CHK + key + '_check.jpg', quality=85)
    print(key, 'ok', OUT + key + '.png', CHK + key + '_check.jpg')


if __name__ == '__main__':
    for k in sys.argv[1:]:
        render(k)
