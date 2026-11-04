# -*- coding: utf-8 -*-
"""北冥引擎 · 混音工具：全长时间轴上的摆放与镜头窗、让路包络、按目标响度定电平、母带的低频平衡与响度/真峰值收口。

时间轴 t 是全长的逐样本秒数（np.arange(n) / SR），返回的增益曲线都是 (n, 1)，直接乘立体声。
接口：
  at(x, t0, n)                              把一段（单声道或立体声）放进长 n 的立体声时间轴 t0 秒处
  window(t, a, b, xf, end)                  镜头窗：a 处等功率切入、b 处切出（a ≤ 0 / b ≥ end 时不切）
  tail_after(t, b, rel)                     b 之后 rel 秒内收掉（切走后的尾巴，不硬断混响）
  duck(t, t0, depth, pre, post)             在 t0 附近让开 depth（pre/post = 让开与恢复的起止偏移秒）
  match_level(st, target, how, t0, t1)      定电平 → (结果, 实测, 增益 dB)；how：mom 最大瞬时 / win 区间积分 / peak 采样峰值
  tame_low(mix, band, ceil, aim, f, s, iters)  低频段相对最强频段高于 ceil 时用低搁架压到 aim → (结果, 累计搁架 dB)
  loudness_to(mix, lufs, tp, look, rel, tol, iters)  总增益 + 前视真峰值限制，按限制后的实测响度迭代 → (结果, 总增益 dB, 限制增益曲线)
"""
import numpy as np

from .dsp import SR, N, smoothstep, undb, db, place, stereo, shelf, tp_limit
from .meter import momentary_max, integrated, band_energy


def at(x, t0, n):
    b = np.zeros((n, 2))
    place(b, x if x.ndim == 2 else stereo(x), t0)
    return b


def window(t, a, b, xf=0.012, end=None):
    end = len(t) / SR if end is None else end
    up = np.sin(np.pi / 2 * smoothstep(a - xf / 2, a + xf / 2, t)) if a > 0 else np.ones(len(t))
    dn = np.cos(np.pi / 2 * smoothstep(b - xf / 2, b + xf / 2, t)) if b < end else np.ones(len(t))
    return (up * dn)[:, None]


def tail_after(t, b, rel=0.3):
    return (1 - smoothstep(b, b + rel, t))[:, None]


def duck(t, t0, depth=0.5, pre=(0.10, 0.01), post=(0.06, 0.25)):
    return (1 - depth * smoothstep(t0 - pre[0], t0 - pre[1], t) * (1 - smoothstep(t0 + post[0], t0 + post[1], t)))[:, None]


def match_level(st, target, how='mom', t0=0.0, t1=None):
    if how == 'mom':
        cur = momentary_max(st, t0, t1)
    elif how == 'win':
        cur = integrated(st[N(t0):(N(t1) if t1 is not None else len(st))])
    else:
        cur = float(db(np.abs(st).max()))
    g = target - cur
    return st * undb(g), cur, g


def tame_low(mix, band='20-120', ceil=-3.5, aim=-3.8, f=115, s=0.7, iters=4):
    total = 0.0
    for _ in range(iters):
        be = band_energy(mix)
        if be[band] <= ceil:
            break
        step = -(be[band] - aim)
        mix = shelf(mix, f, step, 'low', s)
        total += step
    return mix, total


def loudness_to(mix, lufs, tp, look=0.005, rel=0.12, tol=0.03, iters=8):
    g = lufs - integrated(mix)
    for _ in range(iters):
        lim, gr = tp_limit(mix * undb(g), tp, look=look, rel=rel)
        err = lufs - integrated(lim)
        if abs(err) < tol:
            break
        g += err
    return lim, g, gr
