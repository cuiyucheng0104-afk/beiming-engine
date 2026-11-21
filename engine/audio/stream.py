# -*- coding: utf-8 -*-
"""北冥引擎 · 长片音频：float32 总线、按事件稀疏摆放、分块测量与分块母带，十分钟级的片子内存可控。

为什么另起一套：mixing.at() 给每个元素分配一条全长 (n, 2) float64 缓冲，meter.integrated / dsp.tp_limit 对整段信号一次算完——
540 秒的片子一条缓冲约 415 MB，一次 4 倍过采样真峰值的临时量约 1.7 GB，元素一多就超内存。短片照用原来的函数（《北冥》10 秒样片
的混音就是那一套，逐样本不变）；长片用这里的：同一公式、同一滤波器，分块只改变求和顺序，与整段计算的差别在 1e-9 量级
（tests/audio/test_audio_stream.py 逐项比对；10 分钟合成混音的峰值内存实测 932 MB，见 tests/audio/longmix_probe.py）。

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
  TruePeak(os=4)                        推入式逐样本过采样峰值：.feed(块) / .finish() 返回峰值数组，.value 是最大值（线性）
  peaks(blocks, os=4)                   逐样本过采样峰值的生成器（块与块之间用 64 个样本的上下文接缝，结果与整段计算一致）
  measure(x, chunk_s=10, os=4) → {integrated, momentaryMax, shortTermMax, lra, truePeak, samplePeak, seconds}
                                        x 是 ndarray 或音频文件路径（按块读盘）
  peak_envelope(x, os=4) → (n,) float64 每个样本的过采样峰值（供 limit / loudness_to 复用）
  limit(x, ceil_db, look=0.004, rel=0.10, os=4, chunk_s=10, pk=None, pre_gain_db=0) → 统计
                                        原地前视真峰值限制，与 dsp.tp_limit 同一算法；统计 {minGainDb, overOneDbSec}
  loudness_to(x, lufs, tp, look=0.005, rel=0.12, tol=0.03, iters=8, chunk_s=10) → (总增益 dB, 统计)
                                        原地：总增益 + 前视真峰值限制，按"限制后"的实测响度迭代（同 mixing.loudness_to）
  bus_glue_compress(x, *, threshold_db=-18.0, ratio=2.0, attack_ms=25.0, release_ms=160.0, knee_db=6.0, sc_hpf_hz=110.0, makeup_db=0.0, mix=1.0, chunk_s=10.0)
                                        原地分块 SSL G-Bus 立体声联动软膝总线粘合压缩（跨块保持侧链高通 zi 与 Numba 包络状态，零接缝咔嗒）
  master_chain(x, *, target_lufs=-13.3, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=3.2, sub_hpf_hz=28.0, mono_bass_hz=100.0, air_db=0.5, chunk_s=10.0)
                                        原地分块四步透明母带链（10 分钟立体声峰值内存 < 1.0 GB，诊断字典与 mixing.master_chain 同构）
  write_wav(path, x, sr=48000, subtype='PCM_24', chunk_s=10)   分块写盘
"""
import math
import warnings

import numpy as np
import numba
from scipy.signal import butter, lfilter, resample_poly
from scipy.ndimage import minimum_filter1d, uniform_filter1d

from .dsp import SR, N, stereo, undb, db
from .meter import BANDS, _KB1, _KA1, _KB2, _KA2

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


class TruePeak:
    """推入式的逐样本过采样峰值：.feed(块) 返回这一次能算的样本的峰值（缺右侧上下文的留到下一块），.finish() 返回剩下的；
    .value 是到目前为止的最大值（线性）。与 dsp.tp_limit 的 pk 同义：max(过采样峰值, 样本峰值)"""

    def __init__(self, os=4):
        self.os, self.value = os, 0.0
        self.ctx = None          # 已经算过的、最后 MARGIN 个样本（给下一段当左侧上下文）
        self.pend = None         # 还缺右侧上下文、没算的样本

    def _eval(self, buf, lc, stop):
        up = _block_peaks(buf, self.os)
        u = up[lc * self.os:stop * self.os].reshape(stop - lc, self.os).max(axis=1)
        p = np.maximum(u, np.abs(buf[lc:stop]).max(axis=1))
        if len(p):
            self.value = max(self.value, float(p.max()))
        return p

    def feed(self, blk):
        blk = _as2d(np.asarray(blk, dtype=np.float64))
        if not len(blk):
            return np.zeros(0)
        parts = [p for p in (self.ctx, self.pend, blk) if p is not None]
        buf = np.concatenate(parts) if len(parts) > 1 else blk
        lc = 0 if self.ctx is None else len(self.ctx)
        stop = len(buf) - MARGIN
        if stop <= lc:
            self.pend = buf[lc:]
            return np.zeros(0)
        p = self._eval(buf, lc, stop)
        self.ctx, self.pend = buf[max(0, stop - MARGIN):stop], buf[stop:]
        return p

    def finish(self):
        if self.pend is None or not len(self.pend):
            return np.zeros(0)
        lc = 0 if self.ctx is None else len(self.ctx)
        buf = self.pend if self.ctx is None else np.concatenate([self.ctx, self.pend])
        self.pend = None
        return self._eval(buf, lc, len(buf))


def peaks(blocks, os=4):
    """blocks 是 (m, C) 块的可迭代对象；逐块产出这些样本的过采样峰值（按顺序、每个样本恰好一次）"""
    tp = TruePeak(os)
    for blk in blocks:
        p = tp.feed(blk)
        if len(p):
            yield p
    p = tp.finish()
    if len(p):
        yield p


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


# ———————————————— 流式总线粘合压缩与透明母带链（H11） ————————————————
_SPEC_NFFT = 8192
_SPEC_HOP = 2048


def _butter_hp_ba(f_hz: float, order: int = 2):
    fc = min(max(5.0, float(f_hz)), SR * 0.45)
    b, a = butter(order, fc, 'high', fs=SR)
    return b / a[0], a / a[0]


def _shelf_ba(f_hz: float, g_db: float, kind: str = 'low', s: float = 0.8):
    A = 10.0 ** (float(g_db) / 40.0)
    w = 2.0 * math.pi * min(max(10.0, float(f_hz)), SR * 0.46) / float(SR)
    cw, sw = math.cos(w), math.sin(w)
    al = 0.5 * sw * math.sqrt((A + 1.0 / A) * (1.0 / max(0.1, float(s)) - 1.0) + 2.0)
    sa = 2.0 * math.sqrt(A) * al
    if kind == 'low':
        b = np.array([
            A * ((A + 1.0) - (A - 1.0) * cw + sa),
            2.0 * A * ((A - 1.0) - (A + 1.0) * cw),
            A * ((A + 1.0) - (A - 1.0) * cw - sa),
        ])
        a = np.array([
            (A + 1.0) + (A - 1.0) * cw + sa,
            -2.0 * ((A - 1.0) + (A + 1.0) * cw),
            (A + 1.0) + (A - 1.0) * cw - sa,
        ])
    else:
        b = np.array([
            A * ((A + 1.0) + (A - 1.0) * cw + sa),
            -2.0 * A * ((A - 1.0) + (A + 1.0) * cw),
            A * ((A + 1.0) + (A - 1.0) * cw - sa),
        ])
        a = np.array([
            (A + 1.0) - (A - 1.0) * cw + sa,
            2.0 * ((A - 1.0) + (A + 1.0) * cw),
            (A + 1.0) - (A - 1.0) * cw - sa,
        ])
    return b / a[0], a / a[0]


@numba.njit(cache=True)
def _det_pow_chunk(sc_sq, a_det, det_state):
    n = sc_sq.shape[0]
    out = np.empty(n, dtype=np.float64)
    det = det_state
    om = 1.0 - a_det
    for i in range(n):
        det = a_det * det + om * sc_sq[i]
        out[i] = det
    return out, det


@numba.njit(cache=True)
def _glue_env_chunk(sc_sq, threshold_db, slope, knee_db, cap_gr, a_det, a_att, a_rel, det_state, env_state):
    n = sc_sq.shape[0]
    gr_out = np.empty(n, dtype=np.float64)
    det = det_state
    env_db = env_state
    om_det = 1.0 - a_det
    om_att = 1.0 - a_att
    om_rel = 1.0 - a_rel
    half_k = 0.5 * knee_db
    inv_2k = 1.0 / (2.0 * knee_db) if knee_db > 1e-6 else 0.0
    for i in range(n):
        det = a_det * det + om_det * sc_sq[i]
        lvl_db = 10.0 * math.log10(det + 1e-24)
        over = lvl_db - threshold_db
        if knee_db > 1e-6:
            if over <= -half_k:
                raw = 0.0
            elif over >= half_k:
                raw = slope * over
            else:
                d = over + half_k
                raw = slope * d * d * inv_2k
        else:
            raw = slope * over if over > 0.0 else 0.0
        if raw > env_db:
            env_db = a_att * env_db + om_att * raw
        else:
            env_db = a_rel * env_db + om_rel * raw
        gr_val = env_db
        if cap_gr > 0.0 and gr_val > cap_gr:
            gr_val = cap_gr
        gr_out[i] = gr_val
    return gr_out, det, env_db


@numba.njit(cache=True)
def _max_gr_from_lvl(lvl_db, threshold_db, slope, knee_db, a_att, a_rel):
    n = lvl_db.shape[0]
    env_db = 0.0
    max_gr = 0.0
    om_att = 1.0 - a_att
    om_rel = 1.0 - a_rel
    half_k = 0.5 * knee_db
    inv_2k = 1.0 / (2.0 * knee_db) if knee_db > 1e-6 else 0.0
    for i in range(n):
        over = lvl_db[i] - threshold_db
        if knee_db > 1e-6:
            if over <= -half_k:
                raw = 0.0
            elif over >= half_k:
                raw = slope * over
            else:
                d = over + half_k
                raw = slope * d * d * inv_2k
        else:
            raw = slope * over if over > 0.0 else 0.0
        if raw > env_db:
            env_db = a_att * env_db + om_att * raw
        else:
            env_db = a_rel * env_db + om_rel * raw
        if env_db > max_gr:
            max_gr = env_db
    return max_gr


def bus_glue_compress(
    x,
    *,
    threshold_db: float = -18.0,
    ratio: float = 2.0,
    attack_ms: float = 25.0,
    release_ms: float = 160.0,
    knee_db: float = 6.0,
    sc_hpf_hz: float = 110.0,
    makeup_db: float = 0.0,
    mix: float = 1.0,
    chunk_s: float = 10.0,
):
    """流式原地 SSL G-Bus 立体声联动前馈软膝总线压缩器：
    · 按 chunk_s 分块原地处理 x，跨块传递 110 Hz 侧链高通 zi、4 ms 检测器功率状态与分贝域包络状态 env_db；
    · 块接缝处零阶跃、零咔嗒，与整段一次处理逐样本等价；
    · 返回 (x, gr_db)（gr_db 为 float32 逐样本正增益衰减曲线，dB）。"""
    n = len(x)
    if n == 0:
        return x, np.zeros(0, dtype=np.float32)

    m_mix = float(np.clip(mix, 0.0, 1.0))
    if float(ratio) <= 1.0 or m_mix <= 1e-9:
        if abs(float(makeup_db)) > 1e-6 and m_mix > 1e-9:
            g_mk = (1.0 - m_mix) + m_mix * float(undb(float(makeup_db)))
            for a, b in chunks(n, N(chunk_s)):
                x[a:b] = (x[a:b] * g_mk).astype(x.dtype, copy=False)
        return x, np.zeros(n, dtype=np.float32)

    use_sc = sc_hpf_hz is not None and float(sc_hpf_hz) > 10.0 and n > 16
    if use_sc:
        b_sc, a_sc = _butter_hp_ba(float(sc_hpf_hz), 2)
        c_ch = 1 if x.ndim == 1 else x.shape[1]
        zi_sc = np.zeros((len(a_sc) - 1, c_ch), dtype=np.float64)
    else:
        b_sc = a_sc = zi_sc = None

    slope = 1.0 - 1.0 / float(ratio)
    k_db = max(0.0, float(knee_db))
    a_det = float(math.exp(-1.0 / (0.004 * SR)))
    a_att = float(math.exp(-1.0 / (max(1e-4, float(attack_ms) * 1e-3) * SR)))
    a_rel = float(math.exp(-1.0 / (max(1e-3, float(release_ms) * 1e-3) * SR)))
    det_state = 0.0
    env_state = 0.0
    mk_db = float(makeup_db)
    gr_full = np.empty(n, dtype=np.float32)

    for a, b in chunks(n, N(chunk_s)):
        blk = np.asarray(x[a:b], dtype=np.float64)
        blk2d = blk[:, None] if blk.ndim == 1 else blk
        if use_sc:
            sc, zi_sc = lfilter(b_sc, a_sc, blk2d, axis=0, zi=zi_sc)
        else:
            sc = blk2d
        sc_sq = np.ascontiguousarray(0.5 * np.mean(sc * sc, axis=1) + 0.5 * np.max(sc * sc, axis=1), dtype=np.float64)
        gr_blk, det_state, env_state = _glue_env_chunk(
            sc_sq, float(threshold_db), slope, k_db, 0.0, a_det, a_att, a_rel, det_state, env_state
        )
        wet_g = undb(-gr_blk + mk_db)
        if m_mix >= 1.0 - 1e-9:
            gain_vec = wet_g
            eff_gr = gr_blk
        else:
            gain_vec = (1.0 - m_mix) + m_mix * wet_g
            eff_gr = np.maximum(0.0, -db((1.0 - m_mix) + m_mix * undb(-gr_blk)))
        out_blk = blk * (gain_vec[:, None] if blk.ndim == 2 else gain_vec)
        x[a:b] = out_blk.astype(x.dtype, copy=False)
        gr_full[a:b] = eff_gr.astype(np.float32, copy=False)

    return x, gr_full


def _band_rel_from_pw(pw: np.ndarray, fq: np.ndarray) -> dict:
    e = {k: 10.0 * math.log10(float(pw[(fq >= lo) & (fq < hi)].sum()) + 1e-20) for k, (lo, hi) in BANDS.items()}
    top = max(e.values())
    return {k: round(v - top, 2) for k, v in e.items()}


def master_chain(
    x,
    *,
    target_lufs: float = -13.3,
    max_tp: float = -1.5,
    glue: bool = True,
    glue_ratio: float = 2.0,
    max_gr_db: float = 3.2,
    sub_hpf_hz: float = 28.0,
    mono_bass_hz: float = 100.0,
    air_db: float = 0.5,
    chunk_s: float = 10.0,
):
    """流式原地四步透明母带链（10 分钟立体声峰值内存 < 1.0 GB，块边界全状态延续零咔嗒）：
    ① 28 Hz 次声波清理 + <100 Hz M/S 侧声道低频收紧（lfilter 跨块传递 zi）；
    ② 分块 RMS/侧链分位点校准自适应阈值 SSL 总线粘合压缩（Numba @njit 跨块延续 env_db，峰值衰减落在 [1.5, max_gr_db]）；
    ③ 低频平衡护栏 + 可选 +0.5 dB @ 10 kHz 空气光泽搁架 + 奇次 C² 软膝微瞬态驯服 + 首尾微淡入淡出；
    ④ stream.loudness_to 原地精确响度与真峰值收口。
    返回 (x, diagnostics_dict)（键集合与 mixing.master_chain 完全一致）。"""
    if x.ndim == 1:
        x = stereo(x, 0.0).astype(np.float32)
    n = len(x)
    if n == 0 or not measure(x, chunk_s=chunk_s)['integrated'] > -70.0:
        loudness_to(x, float(target_lufs), float(max_tp), chunk_s=chunk_s)

    dur = n / float(SR)
    chunk_n = N(chunk_s)

    # ———— Pass 1：原地 28 Hz 次声波高通 + <100 Hz M/S 侧声道高通 + 2 ms 侧链包络采样与功率谱累加 ————
    use_sub = bool(sub_hpf_hz and float(sub_hpf_hz) > 5.0 and n > 32)
    if use_sub:
        b_sub, a_sub = _butter_hp_ba(float(sub_hpf_hz), 2)
        zi_sub = np.zeros((len(a_sub) - 1, 2), dtype=np.float64)
    else:
        b_sub = a_sub = zi_sub = None

    use_mb = bool(mono_bass_hz and float(mono_bass_hz) > 15.0 and n > 64)
    if use_mb:
        b_mb, a_mb = _butter_hp_ba(float(mono_bass_hz), 2)
        zi_mb = np.zeros(len(a_mb) - 1, dtype=np.float64)
    else:
        b_mb = a_mb = zi_mb = None

    do_glue = bool(glue and float(max_gr_db) > 0.05 and float(glue_ratio) > 1.01 and n > 64)
    b_sc, a_sc = _butter_hp_ba(110.0, 2)
    zi_sc_p1 = np.zeros((len(a_sc) - 1, 2), dtype=np.float64)
    a_det = float(math.exp(-1.0 / (0.004 * SR)))
    det_p1 = 0.0
    decim_hop = 96  # 2 ms 采样步长（10 分钟仅 2.4 MB，相对 25 ms 起音 / 160 ms 释放过采样 > 12 倍）
    det_rest = np.zeros(0, dtype=np.float64)
    lvl_2ms_parts = []

    pw = np.zeros(_SPEC_NFFT // 2 + 1, dtype=np.float64)
    spec_rest = np.zeros(0, dtype=np.float64)
    spec_win = np.hanning(_SPEC_NFFT)

    for a, b in chunks(n, chunk_n):
        blk = np.asarray(x[a:b], dtype=np.float64)
        if use_sub:
            blk, zi_sub = lfilter(b_sub, a_sub, blk, axis=0, zi=zi_sub)
        if use_mb:
            mid = 0.5 * (blk[:, 0] + blk[:, 1])
            side = 0.5 * (blk[:, 0] - blk[:, 1])
            side_t, zi_mb = lfilter(b_mb, a_mb, side, zi=zi_mb)
            blk = np.stack([mid + side_t, mid - side_t], axis=1)

        if do_glue:
            sc1, zi_sc_p1 = lfilter(b_sc, a_sc, blk, axis=0, zi=zi_sc_p1)
            sc_sq1 = np.ascontiguousarray(0.5 * np.mean(sc1 * sc1, axis=1) + 0.5 * np.max(sc1 * sc1, axis=1), dtype=np.float64)
            dp1, det_p1 = _det_pow_chunk(sc_sq1, a_det, det_p1)
            dbuf = np.concatenate([det_rest, dp1]) if len(det_rest) else dp1
            nd = len(dbuf) // decim_hop
            if nd > 0:
                d_sub = dbuf[:nd * decim_hop].reshape(nd, decim_hop).mean(axis=1)
                lvl_2ms_parts.append(10.0 * np.log10(d_sub + 1e-24))
            det_rest = dbuf[nd * decim_hop:]

        mono = 0.5 * (blk[:, 0] + blk[:, 1])
        sbuf = np.concatenate([spec_rest, mono]) if len(spec_rest) else mono
        ks = (len(sbuf) - _SPEC_NFFT) // _SPEC_HOP + 1 if len(sbuf) >= _SPEC_NFFT else 0
        if ks > 0:
            fr = np.lib.stride_tricks.sliding_window_view(sbuf, _SPEC_NFFT)[::_SPEC_HOP][:ks] * spec_win
            pw += (np.abs(np.fft.rfft(fr, axis=1)) ** 2).sum(axis=0)
        spec_rest = sbuf[ks * _SPEC_HOP:]

        x[a:b] = blk.astype(x.dtype, copy=False)

    if do_glue and len(det_rest) > 0:
        lvl_2ms_parts.append(np.array([10.0 * math.log10(float(det_rest.mean()) + 1e-24)], dtype=np.float64))

    # ———— 自适应粘合压缩阈值校准（按分块侧链 RMS 分位区间二分求解，使峰值衰减稳定在 [1.5, max_gr_db]） ————
    glue_thr_db = None
    slope = 1.0 - 1.0 / float(glue_ratio) if float(glue_ratio) > 1.0 else 0.0
    cap_gr = float(max_gr_db)
    if do_glue and lvl_2ms_parts:
        lvl_2ms = np.ascontiguousarray(np.concatenate(lvl_2ms_parts), dtype=np.float64)
        del lvl_2ms_parts
        act = lvl_2ms > -65.0
        if np.any(act):
            act_vals = lvl_2ms[act]
            aim_gr = float(np.clip(0.67 * cap_gr, 1.75, max(1.80, cap_gr - 0.45))) if cap_gr >= 2.2 else (0.72 * cap_gr)
            lo_t = float(np.percentile(act_vals, 5)) - 18.0
            hi_t = float(np.percentile(act_vals, 99.9)) + 8.0
            a_att_2m = float(math.exp(-decim_hop / (0.025 * SR)))
            a_rel_2m = float(math.exp(-decim_hop / (0.160 * SR)))
            for _ in range(16):
                mid_t = 0.5 * (lo_t + hi_t)
                mg = _max_gr_from_lvl(lvl_2ms, mid_t, slope, 6.0, a_att_2m, a_rel_2m)
                if mg > aim_gr:
                    lo_t = mid_t
                else:
                    hi_t = mid_t
            glue_thr_db = 0.5 * (lo_t + hi_t)
        del lvl_2ms

    # ———— 从累加频谱精确求解低频护栏搁架（tame_low）与 10 kHz 空气光泽搁架 ————
    fq = np.fft.rfftfreq(_SPEC_NFFT, 1.0 / float(SR))
    w_rad = 2.0 * np.pi * fq / float(SR)
    ejw = np.exp(-1j * w_rad)
    ej2w = ejw * ejw
    low_trim_db = 0.0
    low_steps = []
    if pw.any():
        pw_sim = pw.copy()
        for _ in range(4):
            be_cur = _band_rel_from_pw(pw_sim, fq)
            if be_cur['20-120'] <= -3.5:
                break
            step_db = -(be_cur['20-120'] - (-3.8))
            b_ls, a_ls = _shelf_ba(115.0, step_db, 'low', 0.7)
            H_ls = (b_ls[0] + b_ls[1] * ejw + b_ls[2] * ej2w) / (a_ls[0] + a_ls[1] * ejw + a_ls[2] * ej2w)
            pw_sim = pw_sim * (np.abs(H_ls) ** 2)
            low_steps.append((b_ls, a_ls, np.zeros((len(a_ls) - 1, 2), dtype=np.float64)))
            low_trim_db += step_db
    else:
        pw_sim = pw

    eff_air_db = float(air_db or 0.0)
    if abs(eff_air_db) > 1e-4 and n >= _SPEC_NFFT and pw_sim.any():
        if eff_air_db > 0.0:
            be_post = _band_rel_from_pw(pw_sim, fq)
            eff_air_db = float(min(eff_air_db, max(0.0, -10.8 - be_post['8k+'])))
    else:
        eff_air_db = 0.0

    if abs(eff_air_db) > 1e-3:
        b_air, a_air = _shelf_ba(10000.0, eff_air_db, 'high', 0.72)
        zi_air = np.zeros((len(a_air) - 1, 2), dtype=np.float64)
    else:
        eff_air_db = 0.0
        b_air = a_air = zi_air = None

    # ———— Pass 2：原地执行有状态粘合压缩 + 低频护栏搁架 + 10 kHz 空气搁架，并统计峰值与均方能量 ————
    zi_sc_p2 = np.zeros((len(a_sc) - 1, 2), dtype=np.float64)
    a_att = float(math.exp(-1.0 / (0.025 * SR)))
    a_rel = float(math.exp(-1.0 / (0.160 * SR)))
    det_p2 = 0.0
    env_p2 = 0.0
    glue_max_gr = 0.0
    glue_sum_gr = 0.0
    pk_post = 0.0
    sum_sq_post = 0.0

    for a, b in chunks(n, chunk_n):
        blk = np.asarray(x[a:b], dtype=np.float64)
        if glue_thr_db is not None:
            sc2, zi_sc_p2 = lfilter(b_sc, a_sc, blk, axis=0, zi=zi_sc_p2)
            sc_sq2 = np.ascontiguousarray(0.5 * np.mean(sc2 * sc2, axis=1) + 0.5 * np.max(sc2 * sc2, axis=1), dtype=np.float64)
            gr_blk, det_p2, env_p2 = _glue_env_chunk(
                sc_sq2, glue_thr_db, slope, 6.0, cap_gr, a_det, a_att, a_rel, det_p2, env_p2
            )
            if len(gr_blk):
                glue_max_gr = max(glue_max_gr, float(gr_blk.max()))
                glue_sum_gr += float(gr_blk.sum())
            blk = blk * undb(-gr_blk)[:, None]

        for idx_s in range(len(low_steps)):
            b_ls, a_ls, zi_ls = low_steps[idx_s]
            blk, zi_ls = lfilter(b_ls, a_ls, blk, axis=0, zi=zi_ls)
            low_steps[idx_s] = (b_ls, a_ls, zi_ls)

        if b_air is not None:
            blk, zi_air = lfilter(b_air, a_air, blk, axis=0, zi=zi_air)

        if len(blk):
            pk_post = max(pk_post, float(np.max(np.abs(blk))))
            sum_sq_post += float(np.sum(blk * blk))
        x[a:b] = blk.astype(x.dtype, copy=False)

    glue_mean_gr = glue_sum_gr / max(1, n)

    # ———— 奇次 C² 软膝微瞬态驯服（仅对波峰因数 ≥ 9.5 dB 且 |u| > 0.72 的孤立尖峰生效） + 首尾微淡入淡出 ————
    r_val = math.sqrt(sum_sq_post / max(1, x.size) + 1e-20)
    tamed_db = 0.0
    if pk_post > 1e-7 and 20.0 * math.log10(pk_post / max(r_val, 1e-12)) >= 9.5:
        u0 = 0.72
        c_ceil = float(undb(-1.25))
        span = c_ceil - u0
        pk_after = 0.0
        for a, b in chunks(n, chunk_n):
            blk = np.asarray(x[a:b], dtype=np.float64)
            u = blk / pk_post
            au = np.abs(u)
            over = np.maximum(0.0, au - u0)
            shaped = np.where(au <= u0, u, np.sign(u) * (u0 + span * np.tanh(over / span))) * pk_post
            if len(shaped):
                pk_after = max(pk_after, float(np.max(np.abs(shaped))))
            x[a:b] = shaped.astype(x.dtype, copy=False)
        tamed_db = max(0.0, 20.0 * math.log10(pk_post / max(pk_after, 1e-12)))

    k_in = min(n, N(min(0.006, dur * 0.02)))
    if k_in > 0:
        w_in = (np.sin(np.linspace(0.0, 0.5 * math.pi, k_in)) ** 2)[:, None]
        x[:k_in] = (np.asarray(x[:k_in], dtype=np.float64) * w_in).astype(x.dtype, copy=False)
    k_out = min(n, N(min(0.020, dur * 0.04)))
    if k_out > 0:
        w_out = (np.cos(np.linspace(0.0, 0.5 * math.pi, k_out)) ** 2)[:, None]
        x[n - k_out:] = (np.asarray(x[n - k_out:], dtype=np.float64) * w_out).astype(x.dtype, copy=False)

    # ———— Pass 4：loudness_to 原地精确响度与真峰值收口 ————
    master_gain_db, lim_stats = loudness_to(x, float(target_lufs), float(max_tp), chunk_s=chunk_s)
    if n > 0:
        x[0] = 0.0
        x[-1] = 0.0

    m_fin = measure(x, chunk_s=chunk_s, os=4)
    final_lufs = m_fin['integrated']
    tp_db = m_fin['truePeakDb']
    lim_max_gr = max(0.0, -float(lim_stats['minGainDb']))

    diag = {
        'glueEnabled': bool(glue),
        'glueThresholdDb': round(float(glue_thr_db), 2) if glue_thr_db is not None else None,
        'glueMaxGrDb': round(float(glue_max_gr), 2),
        'glueMeanGrDb': round(float(glue_mean_gr), 2),
        'transientTamedDb': round(float(tamed_db), 2),
        'airDb': round(float(eff_air_db), 2),
        'lowTrimDb': round(float(low_trim_db), 2),
        'masterGainDb': round(float(master_gain_db), 2),
        'limiterMaxGrDb': round(float(lim_max_gr), 2),
        'finalLufs': round(float(final_lufs), 2) if np.isfinite(final_lufs) else None,
        'truePeakDbtp': round(float(tp_db), 2) if np.isfinite(tp_db) else None,
        'lra': round(float(m_fin['lra']), 2),
    }
    return x, diag


def write_wav(path, x, sr=SR, subtype='PCM_24', chunk_s=10.0):
    import soundfile as sf
    x = _as2d(x)
    with sf.SoundFile(path, 'w', samplerate=sr, channels=x.shape[1], subtype=subtype) as f:
        for a, b in chunks(len(x), N(chunk_s)):
            f.write(np.asarray(x[a:b]))
    return path
