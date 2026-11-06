# -*- coding: utf-8 -*-
"""北冥引擎 · 环境声：城市低鸣、水面、风、发丝沙沙、一阵涌上来的风。全部程序化合成，同一个种子永远同一段声音。

接口（d 是秒，返回立体声，均方根量级约为 1，电平交给混音定）：
  city_hum(d, seed, fog)          远处城市：低频隆隆 + 中频底噪 + 100 Hz 族嗡鸣 + 车流涌动；fog 越大越闷
  water(d, seed, mode)            水面颗粒合成：'far' 远处水面（闷、宽、碎），'hull' 船边拍水（近、带船壳低频）
  wind(d, seed, kind)             风 → (立体声, 阵风曲线)；'far' 雾里远风，'close' 近景带气流和哨音，'open' 高空宽而亮
  hair(d, seed, gust)             短发在风里的 3–9 kHz 细碎沙沙，跟着阵风曲线 gust 走
  breeze(d, seed)                 一阵带空气感的宽风涌上来（d×0.62 处最强）
"""
import numpy as np

from .dsp import (SR, N, T, curve, rng, un_safe, white, pink, brown, smooth_random, lp, hp, bp, svf,
                  stereo, place, decor_pair)
from .synth import bubble, events


def city_hum(d, seed, fog=1.0):
    """低频：布朗噪声 45–320 Hz，左右高度相关；中频：左右独立、听不出方向；嗡鸣：三台略失谐的 100 Hz 族慢拍"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    low = bp(decor_pair(brown, n, r, corr=0.85), 45, 320, 2)
    low = un_safe(low) * (1 + 0.16 * np.sin(2 * np.pi * 0.09 * t + r.uniform(0, 6))
                          + 0.09 * np.sin(2 * np.pi * 0.23 * t + r.uniform(0, 6)))[:, None]
    mid = un_safe(bp(decor_pair(pink, n, r, corr=0.1), 220, 1600, 2))
    hum = np.zeros(n)
    for f, a in [(99.6, 1.0), (100.35, 0.8), (101.1, 0.55)]:
        p0 = r.uniform(0, 6)
        hum += a * (np.sin(2 * np.pi * f * t + p0) + 0.55 * np.sin(4 * np.pi * f * t + 2 * p0)
                    + 0.3 * np.sin(6 * np.pi * f * t + 3 * p0) + 0.12 * np.sin(8 * np.pi * f * t))
    fan = np.sin(2 * np.pi * 612 * t + 1.0) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t))
    sw = np.zeros((n, 2))
    tt = r.uniform(-1.5, 0.3)
    while tt < d:
        L = r.uniform(2.4, 4.0)
        m = N(L)
        seg = un_safe(bp(pink(m, r), r.uniform(160, 260), r.uniform(800, 1300), 2)) * np.sin(np.linspace(0, np.pi, m)) ** 2
        place(sw, seg * r.uniform(0.5, 1.0), tt, 1.0, r.uniform(-0.7, 0.7))
        tt += r.uniform(1.2, 2.6)
    out = low * 0.8 + mid * 0.24 + stereo(un_safe(hum), 0) * 0.07 + stereo(fan, 0.3) * 0.006 + sw * 0.36
    return lp(out, 1500 / fog, 2)


def _slosh(r, mode):
    dur = r.uniform(0.05, 0.18)
    m = N(dur)
    tt = np.arange(m) / SR
    c = r.uniform(280, 1100) if mode == 'far' else r.uniform(250, 1400)
    x = un_safe(bp(r.standard_normal(m), c / 1.6, c * 1.6, 2))
    return x * np.minimum(1, tt / 0.008) * np.exp(-tt / (dur / 3)) * r.uniform(0.3, 1.0)


def _slap(r):
    m = N(0.12)
    tt = np.arange(m) / SR
    x = np.sin(2 * np.pi * r.uniform(95, 170) * tt) * np.exp(-tt / 0.025) * 0.8
    x += un_safe(lp(r.standard_normal(m), 2200, 2)) * np.exp(-tt / 0.012) * 0.6
    for _ in range(r.integers(2, 5)):
        b = bubble(r, 500, 2400)
        s = N(r.uniform(0.005, 0.05))
        e = min(m, s + len(b))
        x[s:e] += b[:e - s]
    return x * r.uniform(0.5, 1.0)


def water(d, seed, mode='far'):
    """随慢浪起伏的密度投放三种颗粒：带通噪声“哗”、Minnaert 气泡“咕”、拍船“啪”（只在 hull）"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    out = np.zeros((n, 2))
    act = (0.55 + 0.25 * np.sin(2 * np.pi * t / 2.3 + r.uniform(0, 6)) + 0.2 * np.sin(2 * np.pi * t / 3.7 + r.uniform(0, 6))
           + 0.1 * np.sin(2 * np.pi * t / 1.3 + r.uniform(0, 6)))
    act = np.clip(act, 0.08, 1.0) ** 1.6
    rate = 34.0 if mode == 'far' else 42.0
    for tt, _ in events(r, d, rate, act):
        k = r.random()
        if mode == 'hull' and k < 0.12:
            g = _slap(r)
        elif k < 0.55:
            g = _slosh(r, mode)
        else:
            g = bubble(r, 450, 1600) if mode == 'far' else bubble(r, 500, 2400)
        place(out, g, tt, 1.0, r.uniform(-0.85, 0.85) if mode == 'far' else r.uniform(-0.6, 0.6))
    out = lp(hp(out, 150), 3200) if mode == 'far' else lp(hp(out, 70), 6500)
    return un_safe(out)


def wind(d, seed, kind='far'):
    """far：380–800 Hz 随阵风变亮；close：更快的阵风 + 气流体感 + 一丝擦过硬边的哨音；open：宽、亮、左右去相关"""
    r = rng(seed)
    n = N(d)
    if kind == 'far':
        g = smooth_random(n, r, 0.35, 0.35, 1.0) ** 1.3
        src = decor_pair(pink, n, r, corr=0.2)
        x = svf(src, 380 + 420 * g, 0.6, 'bp')
        x = un_safe(lp(x, 1600, 2)) * g[:, None]
    elif kind == 'close':
        g = smooth_random(n, r, 1.1, 0.25, 1.0) ** 1.5
        src = decor_pair(pink, n, r, corr=0.45)
        body = un_safe(svf(src, 260 + 420 * g, 0.55, 'bp'))
        pres = un_safe(svf(src, 1600 + 2200 * g, 1.1, 'bp'))
        buff = un_safe(lp(decor_pair(brown, n, r, corr=0.7), 140, 2))
        wh = un_safe(svf(white(n, r), 1180 * (0.94 + 0.12 * g), 28.0, 'bp'))
        x = (body + 0.22 * pres) * g[:, None] + buff * 0.30 * (g ** 2)[:, None] + stereo(wh, 0.2) * 0.035 * (g ** 2)[:, None]
    else:
        g = smooth_random(n, r, 0.3, 0.45, 1.0)
        src = decor_pair(pink, n, r, corr=0.0)
        body = un_safe(svf(src, 650 + 750 * g, 0.45, 'bp'))
        air = un_safe(hp(decor_pair(white, n, r, corr=0.0), 3500, 2))
        x = (body + air * 0.05) * g[:, None]
    return x, g


def hair(d, seed, gust):
    """发丝擦碰的稀疏起伏：低通噪声取绝对值再升幂，调制 3–9 kHz 的底噪"""
    r = rng(seed)
    n = N(d)
    out = []
    for c in range(2):
        base = lp(hp(white(n, r), 3000, 2), 9000, 2)
        tex = np.abs(lp(white(n, r), 55.0, 2))
        tex = (tex / (tex.max() + 1e-12)) ** 2.0
        out.append(un_safe(base * (0.3 + tex * 3.2)))
    x = np.stack(out, 1) * (gust ** 1.8)[:, None]
    return x


def breeze(d, seed):
    """1.6–3.2 kHz 随包络变亮的带通噪声 + 5 kHz 以上的气声，左右完全去相关"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    env = curve([(0, 0), (d * 0.62, 1.0), (d, 0.7)], t)
    src = decor_pair(pink, n, r, corr=0.0)
    x = un_safe(svf(src, 1500 + 1700 * env, 0.5, 'bp'))
    air = un_safe(hp(decor_pair(white, n, r, corr=0.0), 5000, 2))
    return (x + air * 0.12) * env[:, None]
