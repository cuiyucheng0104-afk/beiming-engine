"""《见龙》素材预处理（可重跑）。用法：
  $LIB/.venv/bin/python tools/prep.py            # 全部
  $LIB/.venv/bin/python tools/prep.py 3 4        # 只做图 3、4
产出（全部在 assets/ 下，页面用 /@film/assets/... 引用）：
  plates/pNN.png   现在段刻线版，3840×2160（2× 超采样，着色器里 2×2 取样缩回 1×）
  plates/pNN_eq.jpg 亮度均衡后的彩色原图 1920×1080（过渡、墨洇轮廓取亮度用）
  ink/iNN.jpg      闪回段水墨原画 1920×1080（不做刻线）
  paper.jpg        宣纸纹理 1920×1080
  preview/         检查用小图（不进成片）
刻线算法照搬已验证的 ~/Desktop/见龙/tools/printfx.py + render_depth_test.py 的 prep（亮度均衡 mix≈0.55，2× 放大，period≈13）。
近景人脸（图 2、3、4）单独处理：脸部区域局部对比拉开 + 提亮 + 细刻线（period 7）+ 五官勾线（DoG），羽化融回。
"""
import sys, os, json, numpy as np
from PIL import Image, ImageFilter, ImageOps, ImageEnhance, ImageDraw
from scipy.ndimage import gaussian_filter, uniform_filter, maximum_filter, label

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT = os.path.join(HERE, 'material'); A = os.path.join(HERE, 'assets')
PAPER_SRC = '@@WORKSPACE_ROOT@@/Desktop/上影ppt/03-制作/共用/材质/宣纸.png'
INK = np.array([22, 23, 27.]); PAP = np.array([237, 229, 205.]); RED = np.array([196, 51, 43.])
YEL = np.array([223, 164, 67.]); GRN = np.array([61, 255, 176.])
PRESENT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19]
FLASH = [13, 14, 15, 16, 17, 18]
# 每张图的刻线参数：bright 整体提亮，mix 亮度均衡力度，period 刻线周期（2× 像素）
# 返修（2026-11-03 审片第 1 条）：现在段整体压回雨夜。原来 mix 0.55 + bright 1.15–1.3，图版平均亮度 114–132（0–255），
# 比用户选定静帧（36–50）和看过的样片（95）都亮，成了纸色白天。现在 mix 降到 0.3（少拉暗部，保住原画的夜色明暗关系），
# bright 按每张图解到图版平均亮度约 62，脸部另有局部提亮（FACES），白石另有局部保亮（KEEP）。
CFG = {n: dict(bright=0.9, mix=0.3, period=13) for n in PRESENT}
for _n, _b in {1: 0.98, 2: 0.76, 3: 0.78, 4: 1.0, 5: 0.91, 6: 0.82, 7: 0.85, 8: 0.8, 9: 0.89, 10: 0.74, 11: 0.89, 12: 0.83, 19: 0.88}.items():
    CFG[_n].update(bright=_b)
# 近景人脸：(cx, cy, rx, ry) 1920×1080 原图坐标；lift 提亮，gain 局部对比
FACES = {
    2: [(655, 205, 95, 120, dict(lift=0.14, gain=1.0, mode='flat', plo=6, phi=75, tink=0.15, tline=0.55, edge=0.035, amin=80))],
    3: [(975, 470, 150, 200, dict(lift=0.20, gain=1.1))],
    # 返修第 7 条：老人椭圆收紧到脸和胡须本身（原 rx 165 把胡须左侧的暗背景也圈进来，细刻线在那里碎成点状光晕）
    4: [(675, 320, 125, 150, dict(lift=0.20, gain=1.15, edge=0.04, amin=120, mode='flat')), (1190, 320, 130, 190, dict(lift=0.20, gain=1.1, edge=0.03, amin=80, mode='flat', plo=5, phi=88, tink=0.1, tline=0.6))],
    # 返修第 2 条：图 10 老人的头（原来被整体提亮成一块纸色）
    10: [(826, 316, 47, 68, dict(lift=0.04, gain=1.25, mode='flat', smooth=2.0, plo=5, phi=80, tink=0.12, tline=0.55, edge=0.025, amin=30))],
}
# 返修第 2 条：局部保亮（白石保留纸色、背景压暗）：(cx, cy, rx, ry, 亮度倍数) 原图坐标，羽化椭圆
KEEP = {10: [(1440, 575, 500, 245, 1.75)]}
# 返修第 3 条：原画里本来就有的字，刻线后读不出，按原画原样贴回（不做刻线）：(x0, y0, x1, y1) 原图坐标
PATCH = {11: [(136, 664, 716, 762)]}
# 返修第 11 条：这几张图的黄只留小块的光（灯、龙眼、头灯），大片的金色物件/熔岩感的黄去掉（成墨/纸）
YSMALL = {10: 1500, 11: 1500, 12: 1500, 19: 1500}   # 2× 像素面积上限

# 不给黄的区域（皮肤被灯照成橙色的误判）：(x0,y0,x1,y1) 原图坐标
NORED = {8: [(0, 0, 1920, 1080)]}   # 图 8 警灯不给红（红只给灯笼门联）
for _n in (10, 11, 12, 19): NORED[_n] = [(0, 0, 1920, 1080)]   # 返修第 11 条：晚霞红带、龙身红纹都不是灯笼门联
NOYEL = {1: [(600, 600, 780, 730)], 2: [(360, 800, 470, 1000), (700, 700, 810, 820)], 4: [(560, 640, 1000, 1080)]}
for _n in (10, 11): NOYEL[_n] = [(0, 0, 1920, 1080)]   # 返修第 11 条：图 10 人物轮廓的橙色逆光、图 11 白石上的黄苔都不是灯光


def prep(im, mix=0.55):
    """亮度均衡（与 render_depth_test.py 的 prep 相同）"""
    g = im.convert('L'); eq = ImageOps.equalize(g.filter(ImageFilter.GaussianBlur(1)))
    a = np.asarray(im).astype(float); L = np.asarray(g).astype(float) + 1; E = np.asarray(eq).astype(float) + 1
    k = (1 - mix) + mix * E / L
    return Image.fromarray(np.clip(a * k[..., None], 0, 255).astype(np.uint8))


def lum(a):
    return 0.3 * a[..., 0] + 0.59 * a[..., 1] + 0.11 * a[..., 2]


def hatch(L, period, H, W, fine=False):
    """L∈[0,1] → 墨点布尔图；线条相位锚在像素坐标（=画面坐标），随推镜一起走"""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if fine:
        ph = ((yy + 0.8 * np.sin(xx / 23.0) + 0.6 * np.sin(xx / 9.0 + yy / 60.0)) % period) / period
    else:
        ph = ((yy + 1.6 * np.sin(xx / 41.0) + 1.1 * np.sin(xx / 13.0 + yy / 90.0)) % period) / period
    return (np.abs(ph - 0.5) < (1 - L) * 0.62) | (L < 0.08)


def ellipse_mask(H, W, cx, cy, rx, ry, feather):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    return np.clip((1.0 - r) / feather + 0.5, 0, 1)


def scratch2x(n):
    c = CFG[n]
    src = Image.open(f'{MAT}/image{n}.png').convert('RGB').resize((1920, 1080), Image.LANCZOS)
    eq = prep(src, c['mix'])
    big = ImageEnhance.Brightness(eq.resize((3840, 2160), Image.LANCZOS)).enhance(c['bright'])
    a = np.asarray(big).astype(np.float32) / 255; H, W = a.shape[:2]
    L = gaussian_filter(lum(a), 1.2)
    for (cx, cy, rx, ry, g) in KEEP.get(n, []):
        m = ellipse_mask(H, W, cx * 2, cy * 2, rx * 2, ry * 2, 0.5)
        L = L * (1 - m) + np.clip(L * g, 0, 1) * m
    L = np.clip((L - 0.06) / 0.6, 0, 1) ** 0.8
    ink = hatch(L, c['period'], H, W)
    face = np.zeros((H, W), np.float32)
    for (cx, cy, rx, ry, o) in FACES.get(n, []):
        m = ellipse_mask(H, W, cx * 2, cy * 2, rx * 2, ry * 2, 0.35)
        face = np.maximum(face, m)
        # 脸部：局部对比拉开 + 提亮 → 细刻线；五官用 DoG 勾线
        L0 = gaussian_filter(lum(a), 0.8)
        mu = uniform_filter(L0, 61); sd = np.sqrt(np.clip(uniform_filter(L0 * L0, 61) - mu * mu, 1e-5, None))
        Lf = np.clip(0.5 + o['gain'] * 0.22 * (L0 - mu) / sd + o['lift'] + 0.25 * (L0 - 0.4), 0, 1)
        Lf = np.clip((Lf - 0.05) / 0.85, 0, 1) ** 0.9
        # 返修第 7 条：脸上不要中间调噪点。亮度先抹平（皮肤纹理不再碎成墨点），亮处平涂纸色，只留细刻线和五官轮廓；
        # 五官勾线去掉零碎小点（面积 < 60 个 2× 像素的墨点 = 皮肤噪点，不是轮廓）
        Ls = gaussian_filter(Lf, o.get('smooth', 2.4))
        dog = gaussian_filter(L0, 1.5) - gaussian_filter(L0, 4.0)
        edge = dog < -o.get('edge', 0.03)
        lab, nl = label(edge)
        if nl:
            area = np.bincount(lab.ravel()); edge = edge & (area[lab] >= o.get('amin', 60))
        sel = m > 0.5
        if o.get('mode') == 'flat':
            # 平涂模式（返修第 7 条）：亮度大半径抹平后按脸内分位数分三档——亮处平涂纸色、中间调等宽细刻线（不随亮度变粗细，所以不碎成点）、
            # 最暗处（头发、眼窝、镜框）实墨；再叠五官轮廓线
            Lg = gaussian_filter(L0, o.get('smooth', 3.0))
            lo, hi = np.percentile(Lg[sel], [o.get('plo', 8), o.get('phi', 60)])
            Lf = np.clip((Lg - lo) / (hi - lo + 1e-6), 0, 1)
            fink = (Lf < o.get('tink', 0.16)) | ((Lf < o.get('tline', 0.5)) & hatch(np.full_like(Lf, 0.73), 7, H, W, fine=True))
        else:
            fink = (hatch(Ls, 7, H, W, fine=True) & (Ls < 0.62)) | (Ls < 0.1)
        fink = fink | edge
        ink = np.where(sel, fink, ink)
        # 椭圆边缘一圈（0.2<m<0.5）用基础刻线，但亮度向脸部靠拢，避免出现一块"贴片"
        ring = (m > 0.15) & ~sel
        Lr = L * (1 - m) + Lf * m
        ink = np.where(ring, hatch(Lr, c['period'], H, W), ink)
    out = np.where(ink[..., None], INK, PAP).astype(np.float32)
    # 保留色：红（灯笼门联）、黄（灯光）、绿（界面/原画绿光）
    hsv = np.asarray(src.resize((3840, 2160), Image.BILINEAR).convert('HSV')).astype(np.float32) / 255
    h, s, v = hsv[..., 0] * 360, hsv[..., 1], hsv[..., 2]
    red = ((h < 14) | (h > 345)) & (s > 0.55) & (v > 0.4) & (face < 0.05)   # 脸上（嘴唇、眼角）不给红
    yel = (h > 22) & (h < 52) & (s > 0.45) & (v > 0.62) & (face < 0.05)   # 判色用原图（未提亮），黄只给灯光；脸上不给黄   # 脸上不给黄（黄只给灯光）
    grn = (h > 130) & (h < 185) & (s > 0.35) & (v > 0.4)
    for (x0, y0, x1, y1) in NOYEL.get(n, []): yel[2 * y0:2 * y1, 2 * x0:2 * x1] = False
    if n in YSMALL:
        lab, nl = label(yel)
        if nl:
            area = np.bincount(lab.ravel()); yel = yel & (area[lab] <= YSMALL[n])
    out[yel & ~ink] = YEL
    for (x0, y0, x1, y1) in NORED.get(n, []): red[2 * y0:2 * y1, 2 * x0:2 * x1] = False
    out[maximum_filter(red, 3)] = RED
    out[maximum_filter(grn, 3)] = GRN
    for (x0, y0, x1, y1) in PATCH.get(n, []):   # 原画原样贴回（羽化 6 px）
        org = np.asarray(src.resize((3840, 2160), Image.LANCZOS)).astype(np.float32)
        m = np.zeros((H, W), np.float32); m[2 * y0:2 * y1, 2 * x0:2 * x1] = 1; m = gaussian_filter(m, 6)[..., None]
        out = out * (1 - m) + org * m
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), eq


def main(sel):
    for d in ('plates', 'ink', 'preview'): os.makedirs(f'{A}/{d}', exist_ok=True)
    if not os.path.exists(f'{A}/paper.jpg'):
        Image.open(PAPER_SRC).convert('RGB').resize((1920, 1080), Image.LANCZOS).save(f'{A}/paper.jpg', quality=90)
    for n in sel:
        if n in PRESENT:
            p, eq = scratch2x(n)
            p.save(f'{A}/plates/p{n:02d}.png', optimize=True)
            eq.save(f'{A}/plates/p{n:02d}_eq.jpg', quality=92)
            p.resize((960, 540), Image.BOX).save(f'{A}/preview/p{n:02d}.jpg', quality=88)
            for k, (cx, cy, rx, ry, _) in enumerate(FACES.get(n, [])):   # 人脸 1× 裁切，检查五官
                box = (2 * (cx - rx - 40), 2 * (cy - ry - 40), 2 * (cx + rx + 40), 2 * (cy + ry + 40))
                p.crop(box).resize(((box[2] - box[0]) // 2, (box[3] - box[1]) // 2), Image.BOX).save(f'{A}/preview/face{n:02d}_{k}.jpg', quality=92)
            print('plate', n, flush=True)
        elif n in FLASH:
            Image.open(f'{MAT}/image{n}.png').convert('RGB').resize((1920, 1080), Image.LANCZOS).save(f'{A}/ink/i{n:02d}.jpg', quality=93)
            print('ink', n, flush=True)


if __name__ == '__main__':
    sel = [int(x) for x in sys.argv[1:]] or PRESENT + FLASH
    main(sel)
