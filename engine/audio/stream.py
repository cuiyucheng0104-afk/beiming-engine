# -*- coding: utf-8 -*-
"""北冥引擎 · 长片音频：float32 总线、按事件稀疏摆放、分块测量与分块母带，十分钟级的片子内存可控。

为什么另起一套：mixing.at() 给每个元素分配一条全长 (n, 2) float64 缓冲，meter.integrated / dsp.tp_limit 对整段信号一次算完——
540 秒的片子一条缓冲约 415 MB，一次 4 倍过采样真峰值的临时量约 1.7 GB，元素一多就超内存。短片照用原来的函数（《北冥》10 秒样片
的混音就是那一套，逐样本不变）；长片用这里的：同一公式、同一滤波器，分块只改变求和顺序，与整段计算的差别在 1e-9 量级
（tests/audio/test_stream.py 逐项比对）。

接口：
  Bus(n, name='', dtype=float32)        立体声累加总线，.buf 是 (n, 2) 数组
    .place(x, at, gain=1, pan=0)        单声道或立体声 x 放到 at 秒处：只写 x 覆盖的那一段，不为元素分配全长缓冲
    .mix(other, gain=1)                 把另一条总线按块加进来
    .shape(fn, chunk_s=10)              按块乘增益曲线 fn(t 秒数组) → (m,) 或 (m, 1)（镜头窗、让路、淡出都写成 t 的函数）
  bed(bus, make, start, dur, seg=20, xf=1.0, seed=0, gain=1)
                                        长环境声底层：每段 seg 秒由 make(段长秒, 种子) 生成（立体声），相邻段等功率交叉 xf 秒；
                                        种子 = seed + 段号，确定；同一时刻只有一段在内存里
  chunks(n, size) → [(a, b), …]
  Loudness()                            BS.1770-4 累加器（K 加权的滤波状态跨块延续）：.feed(块)；.integrated() / .momentary_max() /
                                        .short_term_max() / .lra()；空或全静音时 integrated() 返回 −inf
  peaks(blocks, os=4)                   逐样本过采样峰值的生成器（块与块之间用 64 个样本的上下文接缝，结果与整段计算一致）
  measure(x, chunk_s=10, os=4) → {integrated, momentaryMax, shortTermMax, lra, truePeak, samplePeak, seconds}
                                        x 是 ndarray 或音频文件路径（按块读盘）
  peak_envelope(x, os=4) → (n,) float64 每个样本的过采样峰值（供 limit / loudness_to 复用）
  limit(x, ceil_db, look=0.004, rel=0.10, os=4, chunk_s=10, pk=None, pre_gain_db=0) → 统计
                                        原地前视真峰值限制，与 dsp.tp_limit 同一算法；统计 {minGainDb, overOneDbSec}
  loudness_to(x, lufs, tp, look=0.005, rel=0.12, tol=0.03, iters=8, chunk_s=10) → (总增益 dB, 统计)
                                        原地：总增益 + 前视真峰值限制，按"限制后"的实测响度迭代（同 mixing.loudness_to）
  write_wav(path, x, sr=48000, subtype='PCM_24', chunk_s=10)   分块写盘
"""
import warnings

import numpy as np
import numba
from scipy.signal import lfilter, resample_poly
from scipy.ndimage import minimum_filter1d, uniform_filter1d

from .dsp import SR, N, stereo, undb, db
from .meter import _KB1, _KA1, _KB2, _KA2

MARGIN = 64          # 过采样 FIR（resample_poly 的 Kaiser 窗，4 倍时半长 40 个输出样本 ≈ 10 个输入样本）两侧需要的上下文，留足
BIN = 480            # 10 ms：瞬时 / 短时响度的步长，也是 100 ms 积分块的组成单位


def chunks(n, size):
    size = max(1, int(size))
    return [(a, min(n, a + size)) for a in range(0, n, size)]


def _as2d(x):
    x = np.asarray(x)
    return x[:, None] if x.ndim == 1 else x


class Bus:
    def __init__(self, n, name='', dtype=np.float32):
        self.n, self.name = int(n), name
        self.buf = np.zeros((self.n, 2), dtype=dtype)

    def place(self, x, at, gain=1.0, pan=0.0):
        x = np.asarray(x)
        if x.ndim == 1:
            x = stereo(x, pan)
        s = int(round(at * SR))
        if s < 0:
            x, s = x[-s:], 0
        e = min(self.n, s + len(x))
        if e > s:
            self.buf[s:e] += (x[:e - s] * gain).astype(self.buf.dtype, copy=False)
        return self

    def mix(self, other, gain=1.0, chunk_s=10.0):
        src = other.buf if isinstance(other, Bus) else other
        for a, b in chunks(self.n, N(chunk_s)):
            self.buf[a:b] += (src[a:b] * gain).astype(self.buf.dtype, copy=False)
        return self

    def shape(self, fn, chunk_s=10.0):
        for a, b in chunks(self.n, N(chunk_s)):
            g = np.asarray(fn(np.arange(a, b) / SR), dtype=np.float64)
            self.buf[a:b] *= (g if g.ndim == 2 else g[:, None]).astype(self.buf.dtype, copy=False)
        return self


def bed(bus, make, start, dur, seg=20.0, xf=1.0, seed=0, gain=1.0):
    """长底层：段长 seg 秒、相邻交叉 xf 秒（等功率：sin² + cos² = 1，互不相关的噪声底层总功率不变）"""
    if seg <= 2 * xf:
        raise ValueError(f'bed：段长 {seg} 秒要大于两倍交叉 {xf} 秒')
    t, i, end = float(start), 0, float(start) + float(dur)
    while t < end - 1e-9:
        d = min(seg, end - t)
        last = t + d >= end - 1e-9
        y = _as2d(np.asarray(make(d, seed + i), dtype=np.float64))
        if y.shape[1] == 1:
            y = np.repeat(y, 2, axis=1)
        k = min(len(y), N(xf))
        if i > 0 and k:
            y[:k] *= np.sin(np.linspace(0, np.pi / 2, k))[:, None]
        if not last and k:
            y[-k:] *= np.cos(np.linspace(0, np.pi / 2, k))[:, None]
        bus.place(y, t, gain)
        if last:
            break
        t += d - xf
        i += 1
    return bus


# ———————————————— 测量 ————————————————
class Loudness:
    """BS.1770-4：K 加权（两级双二阶，状态跨块延续）→ 每 10 ms 的能量和 → 400 ms 块 / 3 s 窗"""

    def __init__(self):
        self.z1 = self.z2 = None
        self.bins = []                   # 每 10 ms 的 K 加权能量和（声道相加）
        self._rest = np.zeros(0)
        self.n = 0

    def feed(self, x):
        x = _as2d(np.asarray(x, dtype=np.float64))
        if not len(x):
            return self
        if self.z1 is None:
            c = x.shape[1]
            self.z1, self.z2 = np.zeros((2, c)), np.zeros((2, c))
        k, self.z1 = lfilter(_KB1, _KA1, x, axis=0, zi=self.z1)
        k, self.z2 = lfilter(_KB2, _KA2, k, axis=0, zi=self.z2)
        p = np.sum(k ** 2, axis=1)       # 单声道：meter 把它当成 stereo(x)/√2，能量和也是 x²
        p = np.concatenate([self._rest, p])
        m = len(p) // BIN
        if m:
            self.bins.extend(p[:m * BIN].reshape(m, BIN).sum(axis=1).tolist())
        self._rest = p[m * BIN:]
        self.n += len(x)
        return self

    def _win(self, w, hop):
        b = np.asarray(self.bins)
        if len(b) < w:
            return np.zeros(0)
        c = np.concatenate([[0.0], np.cumsum(b)])
        s = np.arange(0, len(b) - w + 1, hop)
        return (c[s + w] - c[s]) / (w * BIN)

    def integrated(self):
        b = np.asarray(self.bins)
        if len(b) < 40:
            return -np.inf
        sub = b[:len(b) // 10 * 10].reshape(-1, 10).sum(axis=1)       # 100 ms 子块
        if len(sub) < 4:
            return -np.inf
        z = (sub[:-3] + sub[1:-2] + sub[2:-1] + sub[3:]) / (4 * 10 * BIN)   # 400 ms 块、75% 重叠
        lz = -0.691 + 10 * np.log10(z + 1e-12)
        ga = lz > -70
        if not ga.any():
            return -np.inf
        rel = -0.691 + 10 * np.log10(z[ga].mean()) - 10
        return float(-0.691 + 10 * np.log10(z[ga & (lz > rel)].mean()))

    def momentary_max(self):
        z = self._win(40, 1)
        return float((-0.691 + 10 * np.log10(z + 1e-12)).max()) if len(z) else -np.inf

    def short_term_max(self):
        z = self._win(300, 1)
        return float((-0.691 + 10 * np.log10(z + 1e-12)).max()) if len(z) else -np.inf

    def lra(self):
        """EBU Tech 3342：3 s 短时响度每 100 ms 一个值，−70 绝对门限、−20 LU 相对门限，取 10%–95% 分位差"""
        z = self._win(300, 10)
        if not len(z):
            return 0.0
        lz = -0.691 + 10 * np.log10(z + 1e-12)
        g = lz > -70
        if not g.any():
            return 0.0
        rel = -0.691 + 10 * np.log10(z[g].mean()) - 20
        v = lz[g & (lz > rel)]
        return float(np.percentile(v, 95) - np.percentile(v, 10)) if len(v) else 0.0


def _block_peaks(seg, os):
    up = np.abs(resample_poly(seg, os, 1, axis=0))
    up = up.max(axis=1) if up.ndim == 2 else up
    return up


def peaks(blocks, os=4):
    """blocks 是 (m, C) 块的可迭代对象；逐块产出这些样本的过采样峰值（与 dsp.tp_limit 的 pk 同义：max(过采样峰值, 样本峰值)）"""
    ctx = None          # 已经算过的、最后 MARGIN 个样本（给下一段当左侧上下文）
    pend = None         # 还缺右侧上下文、没算的样本
    for blk in blocks:
        blk = _as2d(np.asarray(blk, dtype=np.float64))
        if not len(blk):
            continue
        parts = [p for p in (ctx, pend, blk) if p is not None]
        buf = np.concatenate(parts) if len(parts) > 1 else blk
        lc = 0 if ctx is None else len(ctx)
        stop = len(buf) - MARGIN
        if stop > lc:
            up = _block_peaks(buf, os)
            u = up[lc * os:stop * os].reshape(stop - lc, os).max(axis=1)
            yield np.maximum(u, np.abs(buf[lc:stop]).max(axis=1))
            ctx = buf[max(0, stop - MARGIN):stop]
            pend = buf[stop:]
        else:
            pend = buf[lc:]
    if pend is not None and len(pend):
        lc = 0 if ctx is None else len(ctx)
        buf = pend if ctx is None else np.concatenate([ctx, pend])
        up = _block_peaks(buf, os)
        m = len(buf) - lc
        u = up[lc * os:(lc + m) * os].reshape(m, os).max(axis=1)
        yield np.maximum(u, np.abs(buf[lc:]).max(axis=1))


def _blocks_of(x, chunk_s):
    if isinstance(x, (str, bytes)) or hasattr(x, '__fspath__'):
        import soundfile as sf
        return sf.blocks(x, blocksize=N(chunk_s), dtype='float64', always_2d=True)
    return (x[a:b] for a, b in chunks(len(x), N(chunk_s)))


def measure(x, chunk_s=10.0, os=4):
    L = Loudness()
    tp = sp = 0.0
    n = 0

    def tee():
        nonlocal sp, n
        for blk in _blocks_of(x, chunk_s):
            blk = _as2d(np.asarray(blk, dtype=np.float64))
            L.feed(blk)
            if len(blk):
                sp = max(sp, float(np.abs(blk).max()))
            n += len(blk)
            yield blk
    for p in peaks(tee(), os):
        tp = max(tp, float(p.max()))
    return {'integrated': L.integrated(), 'momentaryMax': L.momentary_max(), 'shortTermMax': L.short_term_max(),
            'lra': L.lra(), 'truePeak': tp, 'truePeakDb': float(db(tp)) if tp > 0 else -np.inf,
            'samplePeak': sp, 'seconds': n / SR}


def peak_envelope(x, os=4, chunk_s=10.0):
    out = np.empty(len(x))
    i = 0
    for p in peaks(_blocks_of(x, chunk_s), os):
        out[i:i + len(p)] = p
        i += len(p)
    return out


# ———————————————— 母带：分块前视真峰值限制 ————————————————
@numba.njit(cache=True)
def _release_from(g, a, v0):
    y = np.empty_like(g)
    v = v0
    for i in range(g.shape[0]):
        if g[i] < v:
            v = g[i]
        else:
            v = a * v + (1 - a) * g[i]
        y[i] = v
    return y, v


def _gains(pk, ceil, pre, look, rel, chunk_s):
    """逐块产出 (a, b, 增益曲线)：与 dsp.tp_limit 同一算法（最小值滤波 2L+1 → 均值滤波 L → 释放），块边界留足上下文"""
    n = len(pk)
    L = max(1, N(look))
    h = L // 2 + 1                       # 均值滤波窗的半宽（含余量）
    ext = L + h + 1
    a_rel = float(np.exp(-1 / (rel * SR)))
    v = 1.0
    for a, b in chunks(n, N(chunk_s)):
        a0, b0 = max(0, a - ext), min(n, b + ext)
        g = np.minimum(1.0, ceil / np.maximum(pk[a0:b0] * pre, 1e-12))
        g = minimum_filter1d(g, size=2 * L + 1)
        a1, b1 = max(0, a - h), min(n, b + h)
        g = uniform_filter1d(g[a1 - a0:b1 - a0], size=L)[a - a1:a - a1 + (b - a)]
        g, v = _release_from(np.ascontiguousarray(g), a_rel, v)
        yield a, b, g


def limit(x, ceil_db, look=0.004, rel=0.10, os=4, chunk_s=10.0, pk=None, pre_gain_db=0.0):
    """原地：x ← x · 10^(pre/20) · 限制增益。返回 {minGainDb, overOneDbSec}"""
    pk = peak_envelope(x, os, chunk_s) if pk is None else pk
    pre = float(undb(pre_gain_db))
    gmin, over = 1.0, 0
    for a, b, g in _gains(pk, float(undb(ceil_db)), pre, look, rel, chunk_s):
        x[a:b] = (x[a:b] * (pre * g)[:, None]).astype(x.dtype, copy=False)
        gmin = min(gmin, float(g.min()))
        over += int((g < undb(-1)).sum())
    return {'minGainDb': round(float(db(gmin)), 3), 'overOneDbSec': round(over / SR, 3)}


def _limited_loudness(x, pk, g_db, tp, look, rel, chunk_s):
    L = Loudness()
    pre = float(undb(g_db))
    for a, b, g in _gains(pk, float(undb(tp)), pre, look, rel, chunk_s):
        L.feed(np.asarray(x[a:b], dtype=np.float64) * (pre * g)[:, None])
    return L.integrated()


def loudness_to(x, lufs, tp, look=0.005, rel=0.12, tol=0.03, iters=8, chunk_s=10.0, os=4):
    if iters < 1:
        raise ValueError(f'loudness_to：iters 至少是 1（给的是 {iters}）')
    cur = measure(x, chunk_s, os)['integrated']
    if not cur > -70.0:
        raise ValueError(f'loudness_to：整段混音没有可测的信号（积分响度 {cur}），无法定到 {lufs} LUFS')
    pk = peak_envelope(x, os, chunk_s)
    g = lufs - cur
    err = None
    for k in range(iters):
        err = lufs - _limited_loudness(x, pk, g, tp, look, rel, chunk_s)
        if abs(err) < tol:
            break
        if k < iters - 1:
            g += err
    else:
        warnings.warn(f'loudness_to：{iters} 轮后仍差 {err:+.2f} LU 没到 {lufs} LUFS（真峰值上限 {tp} dBTP 可能太紧）；'
                      f'作用的是总增益 {g:.2f} dB', RuntimeWarning, stacklevel=2)
    stats = limit(x, tp, look, rel, os, chunk_s, pk=pk, pre_gain_db=g)
    return g, stats


def write_wav(path, x, sr=SR, subtype='PCM_24', chunk_s=10.0):
    import soundfile as sf
    x = _as2d(x)
    with sf.SoundFile(path, 'w', samplerate=sr, channels=x.shape[1], subtype=subtype) as f:
        for a, b in chunks(len(x), N(chunk_s)):
            f.write(np.asarray(x[a:b]))
    return path
