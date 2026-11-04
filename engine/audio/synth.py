# -*- coding: utf-8 -*-
"""北冥引擎 · 合成器件：加法共振峰发声器、玻璃质提示音、Minnaert 气泡、按密度投放颗粒的事件流。

接口：
  voice(f0, amp, seed, ...)                    加法合成：逐样本基频/幅度 → 单声道；越响越亮、共振峰、扫过泛音列的窄峰、气息噪声
  glass_tone(f, d, decay, bright, beat, octave) 正弦 + 玻璃的非谐泛音（2.76×、5.40×）+ 慢拍
  glass_seq(notes, d, octave)                  一串玻璃音：notes=[(相对秒, Hz, 增益 dB, 衰减秒)] → 单声道
  bubble(r, lo, hi, g)                         一个气泡“咕”：频率略上扬的衰减正弦
  events(r, d, rate, density, power)           泊松事件流：平均每秒 rate 个，按 density[i]**power 的概率留下 → 逐个给出 (秒, 样本下标)
"""
import numpy as np

from .dsp import SR, N, T, smoothstep, rng, un_safe, lp, svf, undb


def voice(f0, amp, seed, kmax=48, tilt=0.8, mids=(3, 8, 1.5), brass=0.11, formants=None, narrow=None,
          floor=0.2, breath=0.0, breath_f=(700, 1500), jitter=4.0):
    """f0/amp 是逐样本的基频(Hz)与幅度(0..1)。
    · 基准谱 k^-tilt，mids=(k1,k2,倍数) 抬高中段谐波
    · 越响越亮：第 k 次谐波 ∝ amp^(1+brass·(k-1))，起音和收尾只剩低次谐波（气压建立/泄掉）
    · formants=[(中心Hz 标量或数组, 带宽Hz, 增益)] 直接加权谐波幅度（相当于声道/号口的共振），floor 是共振峰之外的底
    · narrow=(中心数组, 带宽, 增益数组)：窄共振峰扫过谐波列，形成“泛音旋律”
    · breath：按 breath_f 两个中心带通的气息噪声；jitter：音分级的慢抖动"""
    r = rng(seed)
    n = len(f0)
    jit = lp(r.standard_normal(n), 3.0, 1)
    jit = jit / (np.std(jit) + 1e-12) * jitter
    f = f0 * 2 ** (jit / 1200)
    ph = 2 * np.pi * np.cumsum(f) / SR
    out = np.zeros(n)
    phases = r.uniform(0, 2 * np.pi, kmax + 1)
    a0 = np.clip(amp, 0, 1.3)
    # 每条谐波各自慢慢起伏（高次谐波起伏更大），让加法合成不那么“干净”
    ctrl = [lp(r.standard_normal(n // 64 + 2), 256.0, 1) for _ in range(6)]   # 每 64 点一个控制值 → 实际截止约 4 Hz
    ctrl = [np.interp(np.arange(n), np.arange(len(cc)) * 64, cc / (np.std(cc) + 1e-12)) for cc in ctrl]
    for k in range(1, kmax + 1):
        fk = k * f
        if fk.min() > 15000:
            break
        a = (k ** -tilt) * (mids[2] if mids[0] <= k <= mids[1] else 1.0) * a0 ** (1 + brass * (k - 1))
        a = a * (1 + min(0.06 + 0.012 * k, 0.3) * ctrl[k % 6] * (0.6 if k % 2 else 1.0))
        if formants:
            resp = floor
            for fc, bw, g in formants:
                resp = resp + g / (1 + ((fk - fc) / (bw / 2)) ** 2)
            a = a * resp
        if narrow is not None:
            fc, bw, g = narrow
            a = a * (1 + g / (1 + ((fk - fc) / (bw / 2)) ** 2))
        a = a * smoothstep(15000, 11000, fk)
        out += a * np.sin(k * ph + phases[k])
    if breath > 0:
        z = r.standard_normal(n)
        b = svf(z, breath_f[0], 1.3, 'bp') + 0.6 * svf(z, breath_f[1], 1.6, 'bp')
        out += un_safe(b) * np.std(out) * breath * a0
    return out


def glass_tone(f, d=1.2, decay=0.26, bright=1.0, beat=1.4, octave=0.0):
    """泛音衰减更快；octave>0 加一个八度泛音（更清楚）"""
    t = T(d)
    x = np.zeros_like(t)
    for ratio, a, dm in [(1.0, 1.0, 1.0), (2.0, octave, 0.5), (2.76, 0.10 * bright, 0.35), (5.40, 0.03 * bright, 0.16)]:
        if a == 0:
            continue
        fr = f * ratio
        x += a * np.exp(-t / (decay * dm)) * (np.sin(2 * np.pi * fr * t) + 0.5 * np.sin(2 * np.pi * (fr + beat * ratio) * t)) / 1.5
    return x * smoothstep(0, 0.004, t)


def glass_seq(notes, d=1.6, octave=0.0):
    out = np.zeros(N(d))
    for dt, f, g, dec in notes:
        x = glass_tone(f, d - dt, dec, octave=octave) * undb(g)
        s = N(dt)
        out[s:s + len(x)] += x[:len(out) - s]
    return out


def bubble(r, lo=450, hi=1600, g=(0.15, 0.6)):
    f0 = r.uniform(lo, hi)
    tau = r.uniform(0.006, 0.02)
    m = N(tau * 6)
    tt = np.arange(m) / SR
    f = f0 * (1 + r.uniform(0.6, 2.2) * tt)          # Minnaert 气泡：频率略微上扬
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / tau) * np.minimum(1, tt / 0.0015) * r.uniform(*g)


def events(r, d, rate, density, power=1.0):
    """density 是逐样本 0..1 的密度曲线。生成器：调用方在两次取值之间用同一个 r 做颗粒，随机序列照样确定"""
    n = len(density)
    tt = 0.0
    while True:
        tt += r.exponential(1 / rate)
        if tt >= d:
            return
        i = min(n - 1, N(tt))
        if r.random() > (density[i] if power == 1.0 else density[i] ** power):
            continue
        yield tt, i
