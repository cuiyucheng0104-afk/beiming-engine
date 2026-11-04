# -*- coding: utf-8 -*-
"""北冥引擎 · 编配：用采样器把音符写进立体声缓冲（全局秒）。

接口：
  USED                                         用过的乐器名（写署名用）
  dyn_gain(m, range_db)                        力度 0..1 → 线性增益（1 为 0 dB，0 为 −range_db）
  sus(buf, inst, pitch, t0, t1, pan, dyn, ...)  长音：两层力度交叉淡化，音量跟力度曲线 dyn=[(秒, 0..1), ...]；
                                               desks=2 时第二组错开 30 ms、高 5 音分、声像分开，做合奏宽度
  pluck(buf, inst, pitch, t, vel, pan, ...)    一个自然衰减的音（竖琴、钟琴之类）
"""
import numpy as np

from . import sampler as S
from .dsp import SR, N, curve, smoothstep, undb, rms, place

USED = set()
REF = undb(-20.0)    # 两层力度先各自归一到同一均方根，交叉淡化时音量不跳


def dyn_gain(m, range_db=18.0):
    return undb(-range_db * (1 - np.clip(m, 0, 1)))


def _pair(inst, pitch, d, attack, release, vels):
    lo = S.note(inst, pitch, d, vel=vels[0], attack=attack, release=release).astype(float)
    hi = S.note(inst, pitch, d, vel=vels[1], attack=attack, release=release).astype(float)
    n = min(len(lo), len(hi))
    lo, hi = lo[:n], hi[:n]
    a, b = N(min(0.6, d * 0.4)), N(max(0.8, min(d, 1.8)))
    lo *= REF / rms(lo[a:b])
    hi *= REF / rms(hi[a:b])
    return lo, hi


def sus(buf, inst, pitch, t0, t1, pan, gain_db=0.0, attack=0.35, release=0.6, dyn=((0.0, 1.0), (1.0, 1.0)),
        vels=(0.3, 0.85), xf=(0.3, 0.85), desks=2, spread=0.22, rng_db=18.0):
    """xf：力度在 xf[0]–xf[1] 之间从弱奏层过渡到强奏层；rng_db：力度 0 比力度 1 低多少 dB"""
    USED.add(inst)
    for k in range(desks):
        p = pitch if k == 0 else S.midi(pitch) + 0.05
        lo, hi = _pair(inst, p, t1 - t0, attack, release, vels)
        st = t0 + 0.03 * k
        tt = st + np.arange(len(lo)) / SR
        m = curve(dyn, tt)
        w = smoothstep(xf[0], xf[1], m)
        x = (lo * np.sqrt(1 - w) + hi * np.sqrt(w)) * dyn_gain(m, rng_db)
        pk = pan + (spread if k else -spread) * 0.5 if desks > 1 else pan
        place(buf, x, st, undb(gain_db) / np.sqrt(desks), float(np.clip(pk, -1, 1)))


def pluck(buf, inst, pitch, t, vel, pan, gain_db=0.0, dur=1.6, release=None):
    USED.add(inst)
    x = S.note(inst, pitch, dur, vel=vel, release=release).astype(float)
    place(buf, x, t, undb(gain_db), pan)
