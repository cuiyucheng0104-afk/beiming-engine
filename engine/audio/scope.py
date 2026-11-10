# -*- coding: utf-8 -*-
"""北冥引擎 · 声音示波图（PIL）：频谱图、波形图、曲线面板、声场宽度，给混音自检拼图用。

接口（sig 是立体声或单声道，t0/t1 是秒，w/h 是像素）：
  font(size)                                       中文字体：先看环境变量 BEIMING_CJK_FONT（字体文件路径），再按 macOS / Windows / Linux
                                                   的常见位置找；都没有就用 PIL 默认字体（不含中文，图里的中文会是方框，会打印一次提示）
  heat(v)                                          0..1 → 深紫—橙—浅黄的热度色（uint8 RGB）
  spectrogram(sig, t0, t1, w, h, fmin, fmax, dbr, nfft, hop) → (图, 每行对应的频率)；对数频率轴，dbr 是显示的 dB 范围
  waveform(sig, t0, t1, w, h, ref_db)              左右声道各占一半高度；ref_db 给了就在 ±该电平处画参考线
  curves(series, t0, t1, w, h, lo, hi, refs)       曲线面板：series={名: (时间, 值, 颜色, 线宽)}，lo–hi 每 10 一条网格，refs 画参考线
  side_mid(st, win, hop)                           声场宽度：侧/中信号能量比 dB → (窗中心秒, dB)；单声道很低，左右不相关约 0
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .dsp import SR, N, undb

FONT_CANDS = [
    # macOS
    '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc',
    # Windows（系统盘不一定是 C:，按 WINDIR 找）
    *[os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', f) for f in ('msyh.ttc', 'msyh.ttf', 'simhei.ttf', 'simsun.ttc')],
    # Linux（Noto CJK / 文泉驿 / Droid）
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', '/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
]
_WARNED = []
HEAT = np.array([[8, 8, 24], [48, 18, 92], [120, 28, 120], [190, 55, 95], [240, 110, 60], [252, 185, 70], [252, 250, 200]], float)
BG = (14, 14, 26)


def font(sz):
    env = os.environ.get('BEIMING_CJK_FONT', '')
    for p in ([env] if env else []) + FONT_CANDS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except OSError:
                pass
    if not _WARNED:
        _WARNED.append(1)
        print('[scope] 没找到中文字体，自检图里的中文会显示成方框；用环境变量 BEIMING_CJK_FONT 指定一个字体文件即可', file=sys.stderr)
    try:
        return ImageFont.load_default(sz)          # Pillow ≥ 10.1 才收字号
    except TypeError:
        return ImageFont.load_default()


def heat(v):
    v = np.clip(v, 0, 1) * (len(HEAT) - 1)
    i = np.minimum(v.astype(int), len(HEAT) - 2)
    f = (v - i)[..., None]
    return (HEAT[i] * (1 - f) + HEAT[i + 1] * f).astype(np.uint8)


def spectrogram(sig, t0, t1, w, h, fmin=30, fmax=20000, dbr=(-100, -20), nfft=4096, hop=256):
    seg = sig[N(t0):N(t1)]
    seg = seg.mean(1) if seg.ndim == 2 else seg
    seg = np.pad(seg, (nfft // 2, nfft // 2))
    fr = np.lib.stride_tricks.sliding_window_view(seg, nfft)[::hop] * np.hanning(nfft)
    S = 20 * np.log10(np.abs(np.fft.rfft(fr, axis=1)) / (nfft / 4) + 1e-12)
    fq = np.fft.rfftfreq(nfft, 1 / SR)
    ys = np.geomspace(fmin, fmax, h)[::-1]
    idx = np.clip(np.searchsorted(fq, ys), 1, len(fq) - 1)
    img = S[:, idx].T
    xs = np.linspace(0, img.shape[1] - 1, w).astype(int)
    img = img[:, xs]
    v = (img - dbr[0]) / (dbr[1] - dbr[0])
    return Image.fromarray(heat(v)), ys


def waveform(sig, t0, t1, w, h, ref_db=None):
    im = Image.new('RGB', (w, h), BG)
    dr = ImageDraw.Draw(im)
    seg = sig[N(t0):N(t1)]
    seg = seg[:, None] if seg.ndim == 1 else seg
    col = [(120, 170, 255), (255, 160, 140)]
    for c in range(seg.shape[1]):
        y0 = h * (c + 0.5) / seg.shape[1]
        amp = h / (2 * seg.shape[1]) * 0.95
        ch = seg[:, c]
        n = len(ch)
        for i in range(w):
            a, b = int(i * n / w), int((i + 1) * n / w)
            if b <= a:
                continue
            mn, mx = ch[a:b].min(), ch[a:b].max()
            dr.line([(i, y0 - mx * amp), (i, y0 - mn * amp)], fill=col[c % 2])
        if ref_db is not None:
            for g in (-1, 1):
                yy = y0 - g * amp * undb(ref_db)
                dr.line([(0, yy), (w, yy)], fill=(70, 70, 90))
    return im


def curves(series, t0, t1, w, h, lo=-50, hi=0, refs=()):
    im = Image.new('RGB', (w, h), BG)
    dr = ImageDraw.Draw(im)
    f = font(16)
    for v in range(lo, hi + 1, 10):
        y = h - (v - lo) / (hi - lo) * h
        dr.line([(0, y), (w, y)], fill=(40, 40, 60))
        dr.text((4, y - 18), f'{v}', fill=(110, 110, 140), font=f)
    for rv in refs:
        y = h - (rv - lo) / (hi - lo) * h
        dr.line([(0, y), (w, y)], fill=(90, 90, 60))
    for name, (tc, L, colr, wd) in series.items():
        m = (tc >= t0) & (tc <= t1)
        pts = [((t - t0) / (t1 - t0) * w, h - (np.clip(v, lo, hi) - lo) / (hi - lo) * h) for t, v in zip(tc[m], L[m])]
        if len(pts) > 1:
            dr.line(pts, fill=colr, width=wd)
    return im


def side_mid(st, win=0.2, hop=0.02):
    H, W = N(hop), N(win)
    mid, side = ((st[:, 0] + st[:, 1]) / 2) ** 2, ((st[:, 0] - st[:, 1]) / 2) ** 2
    cm, cs = np.concatenate([[0], np.cumsum(mid)]), np.concatenate([[0], np.cumsum(side)])
    s = np.arange(0, len(st) - W, H)
    return (s + W / 2) / SR, 10 * np.log10((cs[s + W] - cs[s] + 1e-12) / (cm[s + W] - cm[s] + 1e-12))
