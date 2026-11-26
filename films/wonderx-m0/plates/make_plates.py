#!/usr/bin/env python3
"""WonderX M0 的 2.5D 纸雕底板：程序生成（numpy 画层，Pillow 编码 WebP），不是 AI 生成，也不含任何第三方素材。

两层纸雕：
  clouds_far.webp     远景云海 + 现代城市剪影（暗场、单盏暖光从右上打），2560×1440 不透明
  proscenium.webp     近景纸雕云头（左下大团、右上小团），1920×1080 带 alpha

纸的纤维与颗粒不在图里：出片时整幅画面统一过后期（engine/look 的纸纹与颗粒），底板只留大面积的平滑色与低频云斑，体积才压得下来。
用法：node tools/env/py.mjs films/wonderx-m0/plates/make_plates.py（或直接 python3）
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
INK = (8, 8, 10)          # 墨
PAPER = (244, 240, 230)   # 纸
WARM = (255, 196, 107)    # 暖光


def fbm(w, h, base=4, octaves=4, seed=1, persistence=0.5):
    """低频值噪声叠加（分形布朗），0..1；大图上用 Pillow 放大小网格，比逐点算快得多。"""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        gw = base * 2 ** o
        gh = max(2, round(gw * h / w))
        g = rng.random((gh, gw)).astype(np.float32)
        out += amp * np.asarray(Image.fromarray(g, mode="F").resize((w, h), Image.BICUBIC))
        total += amp
        amp *= persistence
    out -= out.min()
    return out / max(out.max(), 1e-6)


def blur(a, r):
    """0..1 的遮罩做高斯模糊（Pillow 只给 8 位图模糊，遮罩够用）。"""
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(r))
    return np.asarray(im, np.float32) / 255


def hexc(s):
    return np.array(s, np.float32) if not isinstance(s, str) else np.array([int(s[i:i + 2], 16) for i in (1, 3, 5)], np.float32)


def edge_line(w, base, bumps, rng, wobble=0.012, wob_freq=9):
    """一条纸雕云边：基准高度 + 若干高斯鼓包 + 低频起伏，返回每个 x 的边缘高度（0..1，自上而下）。"""
    x = np.linspace(0, 1, w, dtype=np.float32)
    e = np.full(w, base, np.float32)
    for cx, hw, h in bumps:
        e -= h * np.exp(-((x - cx) / hw) ** 2 * 2.2)
    e += (fbm(w, 1, base=2, octaves=3, seed=int(rng.integers(1 << 30)))[0] - 0.5) * wobble
    return e


def layer(img, edge_px, top, bottom, depth, shadow_px=22, shadow_r=16, shadow_k=0.6, hi=0.0, mottle=None, mottle_k=0.0, alpha=None):
    """往图上叠一层纸：先给它背后的画面压一道投影，再画纸面（上亮下暗的平滑渐变），顶边一条切纸高光。"""
    w, h = edge_px.shape[0], img.shape[0]
    mask = np.clip((np.arange(h, dtype=np.float32)[:, None] - edge_px[None, :]) / 1.5 + 0.5, 0, 1)   # 1.5 px 抗锯齿的边
    # 投影：遮罩下移后模糊
    sh = np.zeros_like(mask)
    sh[shadow_px:, :] = blur(mask, shadow_r)[:-shadow_px, :]
    img *= 1 - (sh[..., None] * shadow_k)
    if alpha is not None:
        alpha *= 1 - np.clip(sh * 1.6, 0, 1)
    t = np.clip((np.arange(h, dtype=np.float32)[:, None] - edge_px[None, :]) / depth, 0, 1)[..., None]
    body = hexc(top) * (1 - t) + hexc(bottom) * t
    if mottle is not None:
        body *= 1 + (mottle[..., None] - 0.5) * 2 * mottle_k
    if hi > 0:   # 顶边高光：遮罩减去下移 5 px 的遮罩
        band = mask.copy()
        band[5:, :] -= mask[:-5, :]
        body += (hexc(WARM) - body * 0.4) * np.clip(band, 0, 1)[..., None] * hi
    img[:] = img * (1 - mask[..., None]) + body * mask[..., None]
    if alpha is not None:
        alpha[:] = alpha * (1 - mask) + mask


def clouds_far(path, w=2560, h=1440):
    rng = np.random.default_rng(2027)
    img = np.zeros((h, w, 3), np.float32)
    # 天：墨黑往下渐暖，右上一团暖光
    y = np.arange(h, dtype=np.float32)[:, None] / h
    img[:] = hexc("#07070b") * (1 - y[..., None]) + hexc("#241a12") * y[..., None]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx / w - 0.72) ** 2 + ((yy / h - 0.30) * 1.25) ** 2) / 0.09
    img += hexc(WARM) * (np.exp(-r2) * 0.16)[..., None]
    mot = fbm(w, h, base=6, octaves=3, seed=11)

    # 远 → 近五层纸云
    rows = [(.50, "#6d5b47", "#4d3f32", .34, .10), (.585, "#4c3d30", "#352a20", .30, .08), (.665, "#30261d", "#211a14", .28, .06),
            (.76, "#1c1612", "#110e0b", .30, .04), (.885, "#0f0c0a", "#08080a", .36, 0.0)]
    for i, (base, top, bottom, depth, hi) in enumerate(rows):
        bumps = [(float(rng.uniform(.03, .97)), float(rng.uniform(.05, .13)), float(rng.uniform(.03, .075))) for _ in range(14)]
        layer(img, edge_line(w, base, bumps, rng) * h, top, bottom, depth * h, shadow_px=14 + 3 * i, shadow_r=12 + 2 * i, shadow_k=.55,
              hi=hi, mottle=mot, mottle_k=.05)

        if i == 2:   # 第三层里立一座现代城市剪影：细高的楼、天线，窗里几点暖光
            skyline = np.zeros((h, w), np.float32)
            x = 40
            lights = []
            while x < w - 60:
                bw = int(rng.integers(16, 44)); bh = int(rng.integers(90, 330)); top_y = base * h - bh
                skyline[int(top_y):int(base * h) + 40, x:x + bw] = 1
                if rng.random() < .3:
                    skyline[max(0, int(top_y) - 70):int(top_y), x + bw // 2:x + bw // 2 + 2] = 1
                for _ in range(int(rng.integers(2, 7))):
                    lights.append((x + int(rng.integers(3, max(4, bw - 6))), int(top_y) + int(rng.integers(8, max(9, bh - 10)))))
                x += bw + int(rng.integers(6, 26))
            skyline = np.clip(blur(skyline, 0.7), 0, 1)
            body = hexc("#171310") * (1 + (mot[..., None] - .5) * .1)
            img[:] = img * (1 - skyline[..., None]) + body * skyline[..., None]
            band = np.clip(skyline - np.roll(skyline, 5, axis=0), 0, 1)
            img += (hexc(WARM) - img * .5) * band[..., None] * .22
            for lx, ly in lights:
                img[ly:ly + 5, lx:lx + 3] = hexc(WARM) * .9
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path, "WEBP", quality=72, method=6)


def proscenium(path, w=1920, h=1080):
    rng = np.random.default_rng(1987)
    img = np.zeros((h, w, 3), np.float32)
    alpha = np.zeros((h, w), np.float32)
    mot = fbm(w, h, base=5, octaves=4, seed=5)
    # 近景过镜：左下、右下两组纸雕云头，中央完全透明（远景与中景从这里看过去）。
    # 每层只在自己那一角有云（边的基准高度在画面下方，只有鼓包顶起来的地方露进画面）。
    clumps = [
        # (基准高度, [(鼓包中心 x, 半宽, 鼓起高度)], 顶色, 底色, 渐变深度, 边光)
        (1.18, [(-.08, .24, .48), (.08, .20, .42), (.22, .15, .34), (.34, .10, .23)], "#8f7961", "#3a2d22", .34, .28),
        (1.20, [(-.04, .20, .44), (.11, .17, .35), (.25, .12, .27)], "#dfd0b7", "#9c8362", .32, .48),
        (1.22, [(-.06, .16, .37), (.06, .14, .32), (.17, .10, .24)], "#f4f0e6", "#c4ad8e", .30, .58),
        (1.20, [(.82, .10, .22), (.92, .14, .33), (1.04, .18, .38)], "#b6a084", "#64503b", .28, .38),
        (1.24, [(.88, .10, .24), (.98, .13, .34), (1.08, .16, .33)], "#eee4d1", "#ad9270", .25, .52),
    ]
    for base, bumps, top, bottom, depth, hi in clumps:
        layer(img, edge_line(w, base, bumps, rng, wobble=.008) * h, top, bottom, depth * h, shadow_px=12, shadow_r=10, shadow_k=.5,
              hi=hi, mottle=mot, mottle_k=.06, alpha=alpha)
    # 没有纸的地方不留颜色（透明像素的颜色会让 WebP 的边缘发脏）
    img *= (alpha[..., None] > 0)
    rgba = np.dstack([np.clip(img, 0, 255), np.clip(alpha * 255, 0, 255)]).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(path, "WEBP", quality=74, method=6, exact=False)


def paper(path, n=2048):
    """纸的微观纤维：可平铺的灰度贴图（2K），给后期的纸纹和微观材质镜头用。亮度围绕 0.56（线性混合时不改整体明度）。
    多尺度纤维：粗的纵横纸浆团（低频值噪声）、斜向的长短纤维（带通噪声拉伸）、细颗粒（高频）。
    """
    rng = np.random.default_rng(42)
    # 周期噪声：采样周期网格后做双线性插值（左右上下无缝）
    def tile_noise(gw, gh):
        g = rng.standard_normal((gh, gw)).astype(np.float32)
        # 首行首列接到最后，小网格多一行一列 → 放大后裁掉接缝
        g2 = np.pad(g, ((0, 1), (0, 1)), mode="wrap")
        im = Image.fromarray(g2, "F").resize((round(n * (gw + 1) / gw), round(n * (gh + 1) / gh)), Image.BICUBIC)
        return np.asarray(im, np.float32)[:n, :n]
    pulp = tile_noise(24, 24) * 3.5 + tile_noise(85, 85) * 2.6
    horiz = tile_noise(120, 1400) * 2.8   # 横纤维（长条沿 x）
    vert = tile_noise(1600, 150) * 1.8    # 竖纤维
    diag = np.roll(horiz, n // 3, axis=1)
    for i in range(n):
        diag[i] = np.roll(diag[i], i // 3)   # 斜向纤维
    grain = rng.standard_normal((n, n)).astype(np.float32) * 3.6
    lum = np.clip(144 + pulp + horiz + vert + diag * .7 + grain, 88, 205).astype(np.uint8)
    Image.fromarray(lum, "L").save(path, "WEBP", quality=82, method=6)


if __name__ == "__main__":
    out = HERE if len(sys.argv) < 2 else Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    clouds_far(out / "clouds_far.webp")
    proscenium(out / "proscenium.webp")
    paper(out / "paper.webp")
    for name in ("clouds_far.webp", "proscenium.webp", "paper.webp"):
        print(f"{name}: {(out / name).stat().st_size:,} B")
