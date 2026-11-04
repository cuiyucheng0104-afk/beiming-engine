# -*- coding: utf-8 -*-
"""北冥引擎 · 测量：BS.1770 响度、真峰值、频段能量、带内信噪比、起音时间，外加 ffmpeg 官方响度做旁证。

接口：
  kweight(st)                            K 加权（48 kHz 系数）
  loudness_curve(st, win, hop)           逐窗响度 → (窗中心秒, LUFS)；win=0.4 瞬时 / 3.0 短时
  integrated(st)                         BS.1770-4 门限积分响度（LUFS）
  momentary_max(st, t0, t1)              窗中心落在 t0–t1 秒内的最大瞬时响度
  true_peak(st, os)                      过采样真峰值（线性，所有声道最大）
  band_energy(st, bands, nfft, hop)      各频段能量，相对最强频段的 dB
  band_snr(sig, other, t, lo, hi, d)     t 秒起 d 秒内、lo–hi Hz 带内 sig 对 other 的能量比 dB
  onset(st, t_hint, rel_db, search)      t_hint 前后 search 秒内，第一次超过局部峰值 rel_db 的时刻
  ebur128(path)                          ffmpeg ebur128 汇总：I / LRA / 真峰值 / LRA 上下沿
  loudnorm_linear(path, I, TP, LRA)      两遍 loudnorm（第二遍 linear=true）→ (第一遍测量, 第二遍结果)
"""
import re
import json
import subprocess

import numpy as np
from scipy.signal import lfilter, resample_poly

from .dsp import SR, N, stereo, undb

# ITU-R BS.1770 在 48 kHz 下的 K 加权两级双二阶系数
_KB1 = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
_KA1 = np.array([1.0, -1.69065929318241, 0.73248077421585])
_KB2 = np.array([1.0, -2.0, 1.0])
_KA2 = np.array([1.0, -1.99004745483398, 0.99007225036621])

BANDS = {'20-120': (20, 120), '120-500': (120, 500), '500-2k': (500, 2000), '2k-8k': (2000, 8000), '8k+': (8000, 24000)}


def kweight(st):
    return lfilter(_KB2, _KA2, lfilter(_KB1, _KA1, st, axis=0), axis=0)


def loudness_curve(st, win=0.4, hop=0.02):
    if st.ndim == 1:
        st = stereo(st) / np.sqrt(2)
    k = kweight(st)
    p = np.sum(k ** 2, axis=1)
    W, H = N(win), N(hop)
    c = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, len(p) - W + 1, H)
    ms = (c[starts + W] - c[starts]) / W
    return (starts + W / 2) / SR, -0.691 + 10 * np.log10(ms + 1e-12)


def integrated(st):
    """400 ms 块、75% 重叠、−70 绝对门限、−10 相对门限"""
    if st.ndim == 1:
        st = stereo(st) / np.sqrt(2)
    k = kweight(st)
    p = np.sum(k ** 2, axis=1)
    W, H = N(0.4), N(0.1)
    c = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, len(p) - W + 1, H)
    z = (c[starts + W] - c[starts]) / W
    lz = -0.691 + 10 * np.log10(z + 1e-12)
    z1 = z[lz > -70]
    if len(z1) == 0:
        return -np.inf
    rel = -0.691 + 10 * np.log10(z1.mean()) - 10
    z2 = z[lz > rel]
    return float(-0.691 + 10 * np.log10(z2.mean()))


def momentary_max(st, t0=0.0, t1=None):
    """t1 不给就到信号结尾"""
    tc, L = loudness_curve(st, 0.4, 0.01)
    m = (tc >= t0) & (tc <= (t1 if t1 is not None else len(st) / SR))
    return float(L[m].max())


def true_peak(st, os=4):
    up = resample_poly(st, os, 1, axis=0)
    return float(np.abs(up).max())


def band_energy(st, bands=BANDS, nfft=8192, hop=2048):
    """立体声先混成单声道；汉宁窗逐帧功率谱累加后按频段求和"""
    x = st.mean(1) if st.ndim == 2 else st
    win = np.hanning(nfft)
    frames = np.lib.stride_tricks.sliding_window_view(x, nfft)[::hop] * win
    Pw = (np.abs(np.fft.rfft(frames, axis=1)) ** 2).sum(0)
    f = np.fft.rfftfreq(nfft, 1 / SR)
    e = {k: 10 * np.log10(Pw[(f >= lo) & (f < hi)].sum() + 1e-20) for k, (lo, hi) in bands.items()}
    top = max(e.values())
    return {k: round(v - top, 2) for k, v in e.items()}


def band_snr(sig, other, t, lo, hi, d):
    """用来看一条声音会不会被其余声音盖住（保留一位小数）"""
    a, b = N(t), N(t + d)
    u, o = sig[a:b].mean(1), other[a:b].mean(1)
    U, O = np.abs(np.fft.rfft(u * np.hanning(len(u)))) ** 2, np.abs(np.fft.rfft(o * np.hanning(len(o)))) ** 2
    fq = np.fft.rfftfreq(len(u), 1 / SR)
    m = (fq >= lo) & (fq < hi)
    return round(float(10 * np.log10(U[m].sum() / (O[m].sum() + 1e-20) + 1e-20)), 1)


def onset(st, t_hint, rel_db=-30.0, search=0.6):
    """返回秒（保留 4 位）；搜索区间全静音时返回 None"""
    x = np.abs(st).max(1)
    a, b = max(0, N(t_hint - search)), min(len(x), N(t_hint + search))
    seg = x[a:b]
    if seg.max() <= 0:
        return None
    thr = seg.max() * undb(rel_db)
    return round((a + int(np.argmax(seg > thr))) / SR, 4)


def _ffmpeg(path, af):
    return subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', af, '-f', 'null', '-'],
                          capture_output=True, text=True).stderr


def ebur128(path):
    s = _ffmpeg(path, 'ebur128=peak=true')
    s = s[s.rfind('Summary:'):]
    num = lambda pat: float(re.search(pat, s).group(1))  # noqa: E731
    return {'I_LUFS': num(r'I:\s+(-?[\d.]+) LUFS'), 'LRA_LU': num(r'LRA:\s+(-?[\d.]+) LU'),
            'TP_dBTP': num(r'Peak:\s+(-?[\d.]+) dBFS'),
            'LRA_low': num(r'LRA low:\s+(-?[\d.]+) LUFS'), 'LRA_high': num(r'LRA high:\s+(-?[\d.]+) LUFS')}


def loudnorm_linear(path, I=-14, TP=-1.2, LRA=11):
    """第二遍结果里 normalization_type 为 linear 才说明只做了线性增益、没有压动态"""
    tgt = f'loudnorm=I={I}:TP={TP}:LRA={LRA}'
    s = _ffmpeg(path, tgt + ':print_format=json')
    j1 = json.loads(s[s.rfind('{'):s.rfind('}') + 1])
    ln = (tgt + ':measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:'
          'measured_thresh={input_thresh}:offset={target_offset}:linear=true:print_format=json').format(**j1)
    s = _ffmpeg(path, ln)
    j2 = json.loads(s[s.rfind('{'):s.rfind('}') + 1])
    return j1, j2
