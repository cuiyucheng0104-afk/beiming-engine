# -*- coding: utf-8 -*-
"""北冥引擎 · 音频 DSP：48 kHz、float64、确定性（随机都从调用方给的种子来，不用全局随机）。

接口：
  SR / N(秒) / T(秒)                       采样率、秒→样本数、时间轴
  smoothstep(a, b, x) / curve(点, t) / lin_curve(点, t)   断点包络（smoothstep 或线性过渡）
  fade(x, fin, fout)                      首尾余弦淡入淡出
  rng(seed) / norm(x, p) / un_safe(x) / rms / db / undb   随机源、峰值或均方根归一、分贝换算
  white / pink / brown(n, r) / smooth_random(n, r, rate, lo, hi)   噪声源与慢变随机控制
  lp / hp / bp(x, f, o) / peq(x, f, g, q) / shelf(x, f, g, kind, s)   静态滤波与 RBJ 均衡
  svf(x, fc, q, mode)                     时变状态变量滤波（fc/q 可逐样本；立体声逐声道）
  pan_lr / stereo / place / width / decor_pair   等功率摆位、放进缓冲、M/S 宽度、相关噪声对
  make_ir(...) / reverb(st, ir, ...) / echoes(st, taps, ...)   多频段衰减的脉冲响应、卷积混响、离散回声
  compress(st, ...) / tp_limit(st, ceil_db, ...)   RMS 压缩、过采样检测的前视限制器
"""
import numpy as np
import numba
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly, lfilter
from scipy.ndimage import minimum_filter1d, uniform_filter1d

SR = 48000


# ———— 时间与包络 ————
def N(d):
    return int(round(d * SR))


def T(d):
    return np.arange(N(d)) / SR


def smoothstep(a, b, x):
    u = np.clip((np.asarray(x, dtype=float) - a) / (b - a), 0.0, 1.0)
    return u * u * (3 - 2 * u)


def curve(points, t):
    """断点包络：points=[(t, v), ...]，相邻断点之间用 smoothstep 过渡；t 可以是数组（任意时间轴）"""
    t = np.asarray(t, dtype=float)
    ts = np.array([p[0] for p in points], float)
    vs = np.array([p[1] for p in points], float)
    i = np.clip(np.searchsorted(ts, t, side='right') - 1, 0, len(ts) - 2)
    t0, t1 = ts[i], ts[i + 1]
    u = np.clip((t - t0) / np.maximum(t1 - t0, 1e-9), 0, 1)
    s = u * u * (3 - 2 * u)
    out = vs[i] + (vs[i + 1] - vs[i]) * s
    out = np.where(t <= ts[0], vs[0], out)
    return np.where(t >= ts[-1], vs[-1], out)


def lin_curve(points, t):
    ts = [p[0] for p in points]
    vs = [p[1] for p in points]
    return np.interp(t, ts, vs)


def fade(x, fin=0.0, fout=0.0):
    """首尾余弦淡入淡出（单声道或立体声）"""
    x = np.array(x, dtype=float)
    n = len(x)
    if fin > 0:
        k = min(n, N(fin))
        x[:k] *= (np.sin(np.linspace(0, np.pi / 2, k)) ** 2).reshape(-1, *([1] * (x.ndim - 1)))
    if fout > 0:
        k = min(n, N(fout))
        x[n - k:] *= (np.cos(np.linspace(0, np.pi / 2, k)) ** 2).reshape(-1, *([1] * (x.ndim - 1)))
    return x


def rng(seed):
    return np.random.default_rng(seed)


def norm(x, p=1.0):
    m = np.abs(x).max()
    return x * (p / m) if m > 0 else x


def un_safe(x):
    """归一到单位均方根（立体声按整体算）"""
    s = float(np.std(x))
    return x / s if s > 1e-12 else x


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-20))


def db(x):
    return 20 * np.log10(np.maximum(np.abs(x), 1e-12))


def undb(g):
    return 10 ** (g / 20)


# ———— 噪声源（FFT 频谱整形，长度精确） ————
def _shaped(n, r, power):
    w = r.standard_normal(n)
    W = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    W *= f ** (-power / 2)
    x = np.fft.irfft(W, n)
    x -= x.mean()
    return x / (np.std(x) + 1e-12)


def white(n, r):
    return r.standard_normal(n)


def pink(n, r):
    return _shaped(n, r, 1.0)


def brown(n, r):
    return _shaped(n, r, 2.0)


def smooth_random(n, r, rate, lo=0.0, hi=1.0):
    """慢变随机控制信号：每 1/rate 秒一个随机值，smoothstep 插值，范围 lo–hi"""
    k = int(n / SR * rate) + 3
    pts = r.uniform(0, 1, k)
    tk = (np.arange(k) - 1) / rate
    v = curve(list(zip(tk, pts)), np.arange(n) / SR)
    return lo + (hi - lo) * v


# ———— 静态滤波 ————
def _sos(kind, f, o):
    return butter(o, f, kind, fs=SR, output='sos')


def lp(x, f, o=2):
    return sosfilt(_sos('low', min(f, SR * 0.45), o), x, axis=0)


def hp(x, f, o=2):
    return sosfilt(_sos('high', f, o), x, axis=0)


def bp(x, lo, hi, o=2):
    return sosfilt(_sos('band', [lo, min(hi, SR * 0.45)], o), x, axis=0)


def _biquad(b, a, x):
    return lfilter(b, a, x, axis=0)


def peq(x, f, g_db, q=0.9):
    """RBJ 峰值均衡"""
    A = 10 ** (g_db / 40)
    w = 2 * np.pi * f / SR
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return _biquad(b / a[0], a / a[0], x)


def shelf(x, f, g_db, kind='low', s=0.8):
    """RBJ 搁架均衡（kind='low' 或 'high'）"""
    A = 10 ** (g_db / 40)
    w = 2 * np.pi * f / SR
    cw, sw = np.cos(w), np.sin(w)
    al = sw / 2 * np.sqrt((A + 1 / A) * (1 / s - 1) + 2)
    sa = 2 * np.sqrt(A) * al
    if kind == 'low':
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    else:
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    b, a = np.array(b), np.array(a)
    return _biquad(b / a[0], a / a[0], x)


# ———— 时变滤波：Cytomic 梯形积分状态变量滤波器，截止频率/Q 逐样本变化 ————
@numba.njit(cache=True)
def _svf(x, fc, q, mode, sr):
    n = x.shape[0]
    y = np.empty(n)
    ic1 = 0.0
    ic2 = 0.0
    for i in range(n):
        f = fc[i]
        if f > 0.45 * sr:
            f = 0.45 * sr
        if f < 5.0:
            f = 5.0
        g = np.tan(np.pi * f / sr)
        k = 1.0 / q[i]
        a1 = 1.0 / (1.0 + g * (g + k))
        a2 = g * a1
        a3 = g * a2
        v3 = x[i] - ic2
        v1 = a1 * ic1 + a2 * v3
        v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2.0 * v1 - ic1
        ic2 = 2.0 * v2 - ic2
        if mode == 0:
            y[i] = v2                      # 低通
        elif mode == 1:
            y[i] = k * v1                  # 带通（中心增益 1）
        else:
            y[i] = x[i] - k * v1 - v2      # 高通
    return y


def _arr(v, n):
    return np.full(n, float(v)) if np.isscalar(v) else np.asarray(v, dtype=float)


def svf(x, fc, q=0.707, mode='bp'):
    """mode = 'lp' / 'bp' / 'hp'；x 是立体声时左右各滤一遍（fc、q 共用）"""
    x = np.ascontiguousarray(x, dtype=float)
    if x.ndim == 2:
        return np.stack([svf(x[:, c], fc, q, mode) for c in range(x.shape[1])], 1)
    n = len(x)
    m = {'lp': 0, 'bp': 1, 'hp': 2}[mode]
    return _svf(x, _arr(fc, n), _arr(q, n), m, float(SR))


# ———— 立体声 ————
def pan_lr(p):
    p = np.clip(p, -1, 1)
    return np.cos((p + 1) * np.pi / 4) * np.sqrt(2), np.sin((p + 1) * np.pi / 4) * np.sqrt(2)


def stereo(x, pan=0.0):
    """单声道 → 立体声（等功率，居中时左右各为 1）；pan 可以是逐样本数组"""
    l, r = pan_lr(pan)
    return np.stack([x * l, x * r], 1)


def place(buf, x, at, gain=1.0, pan=0.0):
    """把单声道或立体声 x 放进立体声缓冲 buf 的 at 秒处（超出部分裁掉）"""
    if x.ndim == 1:
        x = stereo(x, pan)
    s = int(round(at * SR))
    if s < 0:
        x = x[-s:]
        s = 0
    e = min(len(buf), s + len(x))
    if e > s:
        buf[s:e] += x[:e - s] * gain


def width(st, w):
    """M/S 宽度：w=0 单声道，1 原样，>1 加宽"""
    m = (st[:, 0] + st[:, 1]) / 2
    s = (st[:, 0] - st[:, 1]) / 2 * w
    return np.stack([m + s, m - s], 1)


def decor_pair(make, n, r, corr=0.0):
    """生成两条相关度为 corr 的同类噪声（make(n, r) → 1 维）"""
    a, b, c = make(n, r), make(n, r), make(n, r)
    k = np.sqrt(max(corr, 0.0))
    j = np.sqrt(1 - max(corr, 0.0))
    return np.stack([k * c + j * a, k * c + j * b], 1)


# ———— 混响 ————
def make_ir(rt=2.5, pre=0.02, tone=(0.8, 1.0, 0.72, 0.42), buildup=0.025, er=10,
            er_span=(0.007, 0.075), er_gain=0.45, er_lp=7000, seed=1, length=None):
    """立体声脉冲响应：四个频段（<250 / 250–1k / 1k–4k / >4k）各自按 rt×tone 衰减的去相关噪声尾，
    加稀疏早期反射；预延迟 pre 秒；每声道能量归一化。"""
    r = rng(seed)
    L = N(length if length else rt * 1.3)
    t = np.arange(L) / SR
    edges = [(None, 250), (250, 1000), (1000, 4000), (4000, None)]
    out = np.zeros((L + N(pre), 2))
    for c in range(2):
        w = r.standard_normal(L)
        tail = np.zeros(L)
        for (lo, hi), m in zip(edges, tone):
            if lo is None:
                b = lp(w, hi, 2)
            elif hi is None:
                b = hp(w, lo, 2)
            else:
                b = bp(w, lo, hi, 2)
            tail += b * np.exp(-6.91 * t / (rt * m))
        tail *= 1 - np.exp(-t / buildup)
        e = np.zeros(L)
        for k in range(er):
            d = r.uniform(*er_span)
            i = int(d * SR)
            if i < L:
                e[i] += r.choice([-1, 1]) * er_gain * (1 - 0.6 * (d - er_span[0]) / (er_span[1] - er_span[0])) * r.uniform(0.5, 1)
        e = lp(e, er_lp, 2)
        ir = tail / (np.sqrt(np.sum(tail ** 2)) + 1e-12) + e
        out[N(pre):, c] = ir / (np.sqrt(np.sum(ir ** 2)) + 1e-12)
    return out


def reverb(st, ir, wet=0.3, dry=1.0, cross=0.3, hp_in=140.0):
    """卷积混响：输入保留一部分左右方向（cross 是交叉馈送比例）；送进混响前先高通 hp_in（低频不进长混响，防浑）；返回同长度立体声"""
    if st.ndim == 1:
        st = stereo(st)
    n = len(st)
    src = hp(st, hp_in, 2) if hp_in else st
    a = src[:, 0] * (1 - cross) + src[:, 1] * cross
    b = src[:, 1] * (1 - cross) + src[:, 0] * cross
    l = fftconvolve(a, ir[:, 0])[:n]
    rr = fftconvolve(b, ir[:, 1])[:n]
    return dry * st + wet * np.stack([l, rr], 1)


def echoes(st, taps, seed=5, blur=0.035):
    """离散回声：taps=[(延迟秒, 增益dB, 声像, 低通Hz)]；每个回声用短噪声脉冲做一点模糊（楼群反射不是镜面）"""
    if st.ndim == 1:
        st = stereo(st)
    r = rng(seed)
    n = len(st)
    out = np.zeros_like(st)
    mono = st.mean(1)
    for d, g, p, f in taps:
        k = N(blur)
        ker = r.standard_normal(k) * np.exp(-np.arange(k) / (k / 4))
        ker /= np.sqrt(np.sum(ker ** 2))
        y = lp(fftconvolve(mono, ker)[:n], f, 2)
        place(out, y, d, undb(g), p)
    return out


# ———— 动态 ————
@numba.njit(cache=True)
def _follow(x, att, rel):
    n = x.shape[0]
    y = np.empty(n)
    e = 0.0
    for i in range(n):
        v = x[i]
        c = att if v > e else rel
        e = c * e + (1 - c) * v
        y[i] = e
    return y


def compress(st, thr=-18.0, ratio=2.0, att=0.012, rel=0.18, knee=6.0, makeup=0.0):
    """前馈 RMS 压缩（左右联动），thr/knee/makeup 单位 dB"""
    x = st if st.ndim == 2 else st[:, None]
    p = np.mean(x ** 2, axis=1)
    a, r_ = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    env = _follow(p, a, r_)
    lvl = 10 * np.log10(env + 1e-12)
    over = lvl - thr
    gr = np.where(over <= -knee / 2, 0.0,
                  np.where(over >= knee / 2, over * (1 - 1 / ratio),
                           (1 - 1 / ratio) * (over + knee / 2) ** 2 / (2 * knee)))
    g = undb(-gr + makeup)
    return st * (g[:, None] if st.ndim == 2 else g)


@numba.njit(cache=True)
def _release(g, a):
    y = np.empty_like(g)
    v = 1.0
    for i in range(g.shape[0]):
        if g[i] < v:
            v = g[i]
        else:
            v = a * v + (1 - a) * g[i]
        y[i] = v
    return y


def tp_limit(st, ceil_db=-1.6, look=0.004, rel=0.10, os=4):
    """过采样检测的前视限制器：保证 os 倍过采样后的峰值不超过 ceil_db"""
    ceil = undb(ceil_db)
    n = len(st)
    up = np.abs(resample_poly(st, os, 1, axis=0)).max(axis=1)
    m = len(up) // os
    pk = np.maximum(up[:m * os].reshape(m, os).max(axis=1), np.abs(st[:m]).max(axis=1))
    if m < n:
        pk = np.concatenate([pk, np.abs(st[m:]).max(axis=1)])
    g = np.minimum(1.0, ceil / np.maximum(pk, 1e-12))
    L = max(1, N(look))
    g = minimum_filter1d(g, size=2 * L + 1)
    g = uniform_filter1d(g, size=L)
    g = _release(g, np.exp(-1 / (rel * SR)))
    return st * g[:, None], g
