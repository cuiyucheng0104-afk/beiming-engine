# -*- coding: utf-8 -*-
"""北冥引擎 · 96 带 ERB 复基带分析-再合成（CPU 参考实现；GPU 版见同目录 gpu.py / erb_cuda.cu）。

由 out/proto-erb-resyn/erb_resyn.py 原型搬入（2026-11-22，用户过耳后）。数值与原型逐采样一致，只把 render 拆成两段：
  plan(...)          采样点级的轻量规划：时长/尺寸抖动、时间轴、增益表、起音位置，以及这一条 take 的全部随机数；
  _execute_numpy()   重计算：载波构造、交替投影、合成。GPU 版执行同一份 Plan，所以两边能逐波形对照。

设计目标（借鉴公开的 ERB 听觉网格再合成思路，从第一性原理为 GPU 批处理重写）：
  1. 规整均匀张量布局：DEC=8 (6 kHz 复基带, 0.167 ms 均匀时间网格)，天然映射为 CUDA [B, C, NB, M] 连续显存。
  2. 96 带紧框架 ERB 滤波器组（35 Hz .. 23.5 kHz，相邻带 50% 余弦平方和恒为 1）：每个 DFT bin 至多属于 2 个相邻子带。
  3. 啁啾不变相干度估计 + 跨带瞬态相位对齐（零原始波形拷贝却保住刀锋瞬态）。
  4. exact 轮子带包络交替投影，叠加起音因果约束与颗粒约束；支持 size / pitch / dur / bright / hard / vary / seed 与环境床缝合。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np
from scipy import fft as sfft
from scipy.ndimage import gaussian_filter, gaussian_filter1d, uniform_filter1d
from scipy.signal import butter, sosfiltfilt

SR = 48000
DEC = 8
FS_BASE = SR / DEC  # 6000.0 Hz (0.1667 ms / sample)
NB = 96
F_LO = 35.0
F_HI = 23500.0
FLOOR_DB = -96.0


def hz_to_erb(f: np.ndarray | float) -> np.ndarray | float:
    return 21.4 * np.log10(0.00437 * np.asarray(f) + 1.0)


def erb_to_hz(e: np.ndarray | float) -> np.ndarray | float:
    return (10.0 ** (np.asarray(e) / 21.4) - 1.0) / 0.00437


@dataclass
class ERBFilterbank:
    """预计算 96 带 ERB 紧框架映射表（每个 DFT bin 至多归属 2 个子带，零循环向量化）。"""
    n_fft: int
    m_base: int
    nb: int
    sr: int
    centers_hz: np.ndarray       # (NB,)
    centers_erb: np.ndarray      # (NB,)
    bw_hz: np.ndarray            # (NB,)
    k0: np.ndarray               # (NB,)
    k1: np.ndarray               # (NB,)
    kc: np.ndarray               # (NB,)
    # 扁平化稀疏映射（用于 O(N) 向量化分析/合成，无 Python for 循环）
    flat_b: np.ndarray           # (K_tot,) 子带索引
    flat_u: np.ndarray           # (K_tot,) 基带 DFT bin 索引 [0, M)
    flat_k: np.ndarray           # (K_tot,) 全带 rfft bin 索引 [0, N//2]
    flat_w: np.ndarray           # (K_tot,) 半余弦窗权重
    # 每全带 bin 至多 2 个子带的直接 gather 表（对应未来 CUDA 无锁 kernel）
    bin_b0: np.ndarray           # (N//2+1,)
    bin_u0: np.ndarray           # (N//2+1,)
    bin_w0: np.ndarray           # (N//2+1,)
    bin_b1: np.ndarray           # (N//2+1,)
    bin_u1: np.ndarray           # (N//2+1,)
    bin_w1: np.ndarray           # (N//2+1,)
    # 噪声载波带限掩码（每个子带的频域半余弦窗，形状 (NB, M)）
    band_mask: np.ndarray        # (NB, M) float32


_BANK_CACHE: dict[tuple[int, int, int], ERBFilterbank] = {}


def get_filterbank(m_base: int, nb: int = NB, sr: int = SR) -> ERBFilterbank:
    key = (m_base, nb, sr)
    if key in _BANK_CACHE:
        return _BANK_CACHE[key]

    n_fft = DEC * m_base
    n_bins = n_fft // 2 + 1
    freqs = np.arange(n_bins, dtype=np.float64) * (sr / n_fft)
    erbs = hz_to_erb(freqs)

    e_lo = float(hz_to_erb(F_LO))
    e_hi = float(hz_to_erb(min(F_HI, 0.49 * sr)))
    e_centers = np.linspace(e_lo, e_hi, nb)
    step = (e_hi - e_lo) / (nb - 1)
    centers_hz = erb_to_hz(e_centers)
    bw_hz = erb_to_hz(np.minimum(e_centers + step, hz_to_erb(0.5 * sr))) - erb_to_hz(
        np.maximum(e_centers - step, 0.0)
    )

    # 逐带构造半余弦窗，使所有内部频点 sum_b W_b^2 == 1.0
    k0_arr = np.zeros(nb, dtype=np.int32)
    k1_arr = np.zeros(nb, dtype=np.int32)
    kc_arr = np.zeros(nb, dtype=np.int32)

    flat_b_list, flat_u_list, flat_k_list, flat_w_list = [], [], [], []
    bin_b0 = np.zeros(n_bins, dtype=np.int32)
    bin_u0 = np.zeros(n_bins, dtype=np.int32)
    bin_w0 = np.zeros(n_bins, dtype=np.float32)
    bin_b1 = np.zeros(n_bins, dtype=np.int32)
    bin_u1 = np.zeros(n_bins, dtype=np.int32)
    bin_w1 = np.zeros(n_bins, dtype=np.float32)
    bin_cnt = np.zeros(n_bins, dtype=np.int32)
    band_mask = np.zeros((nb, m_base), dtype=np.float32)

    # 直流与 Nyquist 不进带通（避免直流漂移），从 k=1 到 n_bins-2 全覆盖
    valid_k = np.arange(1, n_bins - 1, dtype=np.int32)
    valid_e = erbs[valid_k]

    for b in range(nb):
        ec = e_centers[b]
        if b == 0:
            sel = valid_e < (ec + step)
            ks = valid_k[sel]
            es = valid_e[sel]
            w = np.where(es <= ec, 1.0, np.cos(0.5 * np.pi * (es - ec) / step))
            # 20 Hz 以下平缓高通去极低频直流漂移
            f_ks = freqs[ks]
            hp = np.clip((f_ks - 15.0) / 15.0, 0.0, 1.0)
            w = w * np.sin(0.5 * np.pi * hp)
        elif b == nb - 1:
            sel = valid_e > (ec - step)
            ks = valid_k[sel]
            es = valid_e[sel]
            w = np.where(es >= ec, 1.0, np.cos(0.5 * np.pi * (ec - es) / step))
        else:
            sel = (valid_e > (ec - step)) & (valid_e < (ec + step))
            ks = valid_k[sel]
            es = valid_e[sel]
            w = np.cos(0.5 * np.pi * np.abs(es - ec) / step)

        keep = w > 1e-7
        ks = ks[keep]
        w = w[keep].astype(np.float32)
        if len(ks) == 0:
            kc = int(np.clip(round(centers_hz[b] * n_fft / sr), 1, n_bins - 2))
            k0_arr[b] = kc
            k1_arr[b] = kc
            kc_arr[b] = kc
            continue

        k0 = int(ks[0])
        k1 = int(ks[-1]) + 1
        assert (k1 - k0) < m_base, f"Band {b} width {k1 - k0} >= m_base {m_base}"
        kc = int(round(centers_hz[b] * n_fft / sr))
        kc = max(k0, min(k1 - 1, kc))
        u = ((ks - kc) % m_base).astype(np.int32)

        k0_arr[b] = k0
        k1_arr[b] = k1
        kc_arr[b] = kc

        flat_b_list.append(np.full(len(ks), b, dtype=np.int32))
        flat_u_list.append(u)
        flat_k_list.append(ks)
        flat_w_list.append(w)
        band_mask[b, u] = w

        # 每个 bin 至多属于 2 个相邻子带，同一子带内的 bin 互不重复：按子带顺序向量化赋值（等价于逐 bin 填第 1、第 2 个槽）
        c = bin_cnt[ks]
        first, second = ks[c == 0], ks[c == 1]
        bin_b0[first], bin_u0[first], bin_w0[first] = b, u[c == 0], w[c == 0]
        bin_b1[second], bin_u1[second], bin_w1[second] = b, u[c == 1], w[c == 1]
        bin_cnt[first], bin_cnt[second] = 1, 2

    bank = ERBFilterbank(
        n_fft=n_fft,
        m_base=m_base,
        nb=nb,
        sr=sr,
        centers_hz=centers_hz.astype(np.float32),
        centers_erb=e_centers.astype(np.float32),
        bw_hz=bw_hz.astype(np.float32),
        k0=k0_arr,
        k1=k1_arr,
        kc=kc_arr,
        flat_b=np.concatenate(flat_b_list),
        flat_u=np.concatenate(flat_u_list),
        flat_k=np.concatenate(flat_k_list),
        flat_w=np.concatenate(flat_w_list),
        bin_b0=bin_b0,
        bin_u0=bin_u0,
        bin_w0=bin_w0,
        bin_b1=bin_b1,
        bin_u1=bin_u1,
        bin_w1=bin_w1,
        band_mask=band_mask,
    )
    _BANK_CACHE[key] = bank
    return bank


def analyze_subbands(x: np.ndarray, bank: ERBFilterbank) -> np.ndarray:
    """将全带宽实信号 (N,) 或 (C, N) 分析为复基带子带 (C, NB, M)。"""
    single = x.ndim == 1
    if single:
        x = x[None, :]
    c_ch, n = x.shape
    assert n == bank.n_fft
    X = sfft.rfft(x.astype(np.float32, copy=False), axis=-1)
    # 单边解析谱（正频率 * 2）
    Xa = X.astype(np.complex64, copy=True)
    Xa[:, 1:-1] *= 2.0

    Zb = np.zeros((c_ch, bank.nb, bank.m_base), dtype=np.complex64)
    Zb[:, bank.flat_b, bank.flat_u] = Xa[:, bank.flat_k] * bank.flat_w[None, :]
    z = sfft.ifft(Zb, axis=-1) * (bank.m_base / bank.n_fft)
    return z[0] if single else z


def synthesize_subbands(y_b: np.ndarray, bank: ERBFilterbank) -> np.ndarray:
    """将复基带子带 (NB, M) 或 (C, NB, M) 合成全带宽实信号 (N,) 或 (C, N)。"""
    single = y_b.ndim == 2
    if single:
        y_b = y_b[None, :, :]
    Yb = sfft.fft(y_b.astype(np.complex64, copy=False), axis=-1) * (bank.n_fft / bank.m_base)
    # 无原子锁双带 gather-sum（每个 bin 至多 2 个子带）
    Ya = (
        Yb[:, bank.bin_b0, bank.bin_u0] * bank.bin_w0[None, :]
        + Yb[:, bank.bin_b1, bank.bin_u1] * bank.bin_w1[None, :]
    )
    # 转回实信号单边谱
    Ya[:, 1:-1] *= 0.5
    Ya[:, 0] = Ya[:, 0].real
    Ya[:, -1] = Ya[:, -1].real
    y = sfft.irfft(Ya, n=bank.n_fft, axis=-1).astype(np.float32)
    return y[0] if single else y


def _choose_m_base(n_samples: int, pad_ms: float = 40.0, sr: int = SR) -> tuple[int, int]:
    pad_base = int(math.ceil((pad_ms * 1e-3 * sr) / DEC))
    need_base = int(math.ceil(n_samples / DEC)) + 2 * pad_base
    # 保证最短 N >= 8192 (M >= 1024)，确保低频子带拥有足够频率分辨率
    m = sfft.next_fast_len(max(1024, need_base))
    return m, pad_base


def _estimate_coherence_and_freq(
    z: np.ndarray, bank: ERBFilterbank, active_frames: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """啁啾不变相干度估计（一阶稳态 + 二阶线性滑频）与瞬时基带角频率。"""
    nb, m = z.shape
    amp = np.abs(z).astype(np.float32)
    u = z / np.maximum(amp, 1e-12)

    # 瞬时基带角频率（能量加权短平滑）
    d1 = z[:, 1:] * np.conj(z[:, :-1])
    d1_re = uniform_filter1d(d1.real, size=5, axis=-1, mode="nearest")
    d1_im = uniform_filter1d(d1.imag, size=5, axis=-1, mode="nearest")
    omega = np.zeros((nb, m), dtype=np.float32)
    omega[:, 1:] = np.arctan2(d1_im, d1_re)
    omega[:, 0] = omega[:, 1]
    # 限制在子带半宽内，防低能量区相位跳变
    max_om = np.minimum(np.pi * 0.9, np.pi * (bank.bw_hz / FS_BASE)).astype(np.float32)
    omega = np.clip(omega, -max_om[:, None], max_om[:, None])

    kappa = np.zeros((nb, m), dtype=np.float32)
    phase0 = np.angle(z).astype(np.float32)
    top_amp = float(amp.max() + 1e-12)
    energy_gate = amp > (top_amp * (10.0 ** (-42.0 / 20.0)))

    for b in range(nb):
        # 极高频靠近 Nyquist (f > 21 kHz) 往往是编解码滚降底噪，避免误判为相干哨音
        if float(bank.centers_hz[b]) > 20500.0:
            continue
        # 去相关滞后：~1.5 / bw_hz，在此滞后下带限白噪近似不相关
        lag = int(round(1.5 * FS_BASE / max(float(bank.bw_hz[b]), 25.0)))
        lag = max(3, min(lag, m // 6))
        if active_frames < max(24, 4 * lag):
            # 极短片段的低频子带周期数不足，直接走噪声/瞬态通路，防虚假共振
            continue
        win = min(max(20, int(round(4.5 * lag))), max(20, active_frames))
        n_indep = max(1.0, win / max(lag, 1))
        if n_indep < 3.5:
            continue
        # 一阶稳态相干
        prod1 = z[b, lag:] * np.conj(z[b, :-lag])
        wt1 = amp[b, lag:] * amp[b, :-lag]
        num1_re = uniform_filter1d(prod1.real, size=win, mode="nearest")
        num1_im = uniform_filter1d(prod1.imag, size=win, mode="nearest")
        den1 = uniform_filter1d(wt1, size=win, mode="nearest") + 1e-12
        c1 = np.sqrt(num1_re * num1_re + num1_im * num1_im) / den1

        # 二阶啁啾不变相干：u[t+lag] * conj(u[t])^2 * u[t-lag]
        c2 = np.zeros_like(c1)
        if 2 * lag < m - 2:
            q = u[b, 2 * lag :] * (np.conj(u[b, lag:-lag]) ** 2) * u[b, :-2 * lag]
            wt2 = (amp[b, 2 * lag :] * amp[b, lag:-lag] * amp[b, :-2 * lag]) ** (1.0 / 3.0)
            qw = q * wt2
            num2_re = uniform_filter1d(qw.real, size=win, mode="nearest")
            num2_im = uniform_filter1d(qw.imag, size=win, mode="nearest")
            den2 = uniform_filter1d(wt2, size=win, mode="nearest") + 1e-12
            c2_core = np.sqrt(num2_re * num2_re + num2_im * num2_im) / den2
            c2[: len(c2_core)] = c2_core

        # 校准有限样本白噪统计本底（二阶项统计方差更大，门限更严），避免宽带纤维摩擦误判为正弦哨音
        floor1 = min(0.88, 1.42 / math.sqrt(n_indep) + 0.10)
        floor2 = min(0.93, 1.62 / math.sqrt(n_indep) + 0.14)
        k1 = np.clip((c1 - floor1) / max(0.98 - floor1, 0.05), 0.0, 1.0)
        k2 = np.clip((c2 - floor2) / max(0.98 - floor2, 0.05), 0.0, 1.0)
        k_band = np.maximum(k1, k2) ** 1.6
        # 对齐中心时刻并施加能量门限
        half = lag // 2
        kappa[b, half : half + len(k_band)] = k_band
    kappa = np.where(energy_gate, kappa, 0.0).astype(np.float32)

    return kappa, omega, phase0


def _estimate_impulsiveness(x_mono: np.ndarray, env_full: np.ndarray, m_base: int) -> np.ndarray:
    """估计逐帧跨带瞬态冲激强度 gamma[m] ∈ [0, 0.9]（零原始波形存储，纯 1D 标量曲线）。

    原理：在 96 带紧框架下，如果各子带相位彼此独立，瞬时预期 RMS 为 sqrt(0.5 * sum_b A_b[m]^2)，
    8 采样块峰值与之比值通常落在 1.0–1.9；而真实纤维微断/剪刀轻叩时跨带相位对齐叠加，
    该比值会跃升至 2.2–4.5。
    """
    blk_pk = np.abs(x_mono).reshape(m_base, DEC).max(axis=1)
    # 瞬时跨带独立相位预期 RMS
    rms_exp = np.sqrt(0.5 * np.sum(env_full * env_full, axis=0) + 1e-12)
    active = rms_exp > (0.05 * float(rms_exp.max() + 1e-12))
    ratio = np.where(active, blk_pk / rms_exp, 0.0)
    # 超过随机相位基线 (2.05) 的部分映射为跨带瞬态对齐强度
    gamma = np.clip((ratio - 2.05) / 1.75, 0.0, 0.92).astype(np.float32)
    return gamma


# ———— 起音的因果约束（第 1 轮盲听找到的根因）————
# 第 1 轮：耳朵认出合成版几乎全靠「那一下」（备注写起音的 8 题认对 7/8）。
# 根因：96 个滤网是零相位的，量出来的子带包络在起音前就开始爬升。原录音里这些「往前抹」的部分在子带之间正负抵消；
#   合成时换成新噪声就抵消不了，起音前冒出一层声音（比原录音多 12–47 dB），「咔」就糊了。
#   同一个抹开也发生在起音之后：低频的能量晚到 1–2 ms、在 +12 ms 处多出 7–18 dB，「咔」变成「噗」。
# 修法（不用原录音的任何采样）：分析时记下每个「先静后响」起音的时刻，以及起音前 30 ms、后 40 ms 原录音
#   低/中/高/全带的包络轮廓（相对起音后 40 ms 平均能量的 dB，每个起音约 1700 个数，只是轮廓、不含波形）。
#   合成时把它当成时域约束放进交替投影：每轮先在时域把起音前压到不比轮廓响、起音后按轮廓塑形，再回子带对齐包络；
#   起音前被滤网抹开的那段子带包络不可信，只许压不许抬。最后找到的是两种约束同时满足的信号：
#   形状跟原录音一样干脆，细节是新抽的噪声。变速时起音段保持原速，只伸缩起音之间。

_HP200 = butter(2, 200.0, "high", fs=SR, output="sos")
_HP2K = butter(4, 2000.0, "high", fs=SR, output="sos")
GATE_SPLIT_HZ = ((350.0, 700.0), (2000.0, 4000.0))  # 低/中、中/高的分频过渡区（对数域余弦）
ONSET_PRE_MS = 30.0                                  # 起音前受约束的时长
ONSET_POST_MS = (40.0, 20.0, 15.0)                   # 起音后按轮廓塑形的时长（低/中/高）：低频滤网抹得最开
ONSET_ANCHOR_MS = 40.0                               # 轮廓相对起音后 40 ms 内该段的平均能量记 dB
ONSET_ENV_MS = (1.5, 0.5, 0.25, 0.25)                # 低/中/高/全带包络的平滑窗
FINAL_MODE = "pre"                                   # 最后一步：pre = 只压起音前（默认）；both = 再塑形起音后；none = 不闸（起音前会冒声）
ONSET_MAX_GAIN = 4.0                                 # 起音后塑形最多抬 12 dB
# 整条声音的「颗粒」约束（第 3 轮后加）：布料、脚步、火把里大量 1–2 ms 的中等颗粒，是好几个相邻子带同时鼓一下；
#   单个中频子带（70–190 Hz 宽）的包络分辨不了 1–2 ms，换新相位后拼不回来，局部峭度掉一半（布料 0.65→−0.2）。
#   做法同起音约束：低/中/高三段的细包络起伏（细包络 / 8 ms 包络）放进交替投影当时域约束，只学起伏的样子不学响度亮度；
#   纯音占比高的段不加（锣、铃），起音前后交给起音约束，调用方要变速/变大小时不加。连敲（vary>0）时颗粒时刻沿用原录音
#   （随 vary 的时长抖动伸缩）：试过相位随机化与 IAAFT 打乱时刻，都和宽带总能量里原录音那份起伏打架，噼啪回不来
#   （布料 −5.1 dB 对沿用原时刻 −2.4 dB）；沿用时各下波形仍互相独立（两两 >2 kHz 相关 0.01–0.04）。
GRAIN = True                                         # False = 第 3 轮的行为
GRAIN_ENV_MS = (1.5, 1.0, 1.0)                       # 颗粒细包络的平滑窗：1–2 ms 的颗粒看得见，再细就逼近抄波形
GRAIN_SMOOTH_MS = 8.0
GRAIN_GAIN = (0.5, 2.0)                              # 每轮时域增益夹在 −6..+6 dB
GRAIN_KURT = (0.2, 1.2)                              # 原录音该段局部峭度 ≤0.2（像平滑噪声，如风）不加约束，≥1.2 全加：没有颗粒就别照抄随机起伏
_PRE_N = int(ONSET_PRE_MS * 1e-3 * SR) // DEC
_POST_N = int(max(ONSET_POST_MS) * 1e-3 * SR) // DEC
_SPLIT_MASKS: dict[int, tuple[np.ndarray, np.ndarray]] = {}


def _env_ms(x: np.ndarray, win_ms: float) -> np.ndarray:
    k = max(1, int(round(win_ms * 1e-3 * SR)))
    return np.sqrt(np.maximum(uniform_filter1d(np.asarray(x, np.float64) ** 2, size=k), 0.0) + 1e-18)


def _mono64(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, np.float64)
    return x.mean(axis=1) if x.ndim == 2 else x


def detect_attacks(x: np.ndarray, jump_db: float = 10.0, quiet_db: float = -12.0, floor_db: float = -30.0,
                   min_gap_s: float = 0.06, max_n: int = 32) -> list[int]:
    """「先静后响」的起音：1 ms 包络 4 ms 内跳升 >= jump_db、不低于全局峰值 floor_db，
    且起音前 2–20 ms 的能量比起音后 0–10 ms 低 quiet_db 以上（纹理类连续声不算）。返回起跳采样点，升序。"""
    m = sosfiltfilt(_HP200, _mono64(x))
    e = _env_ms(m, 1.0)
    lag = int(0.004 * SR)
    if len(e) <= lag + 1:
        return []
    jump = np.zeros(len(e))
    jump[lag:] = 20.0 * np.log10(e[lag:] / e[:-lag])
    cand = np.flatnonzero((jump >= jump_db) & (e >= e.max() * 10.0 ** (floor_db / 20.0)))
    gap, ms = int(min_gap_s * SR), SR // 1000
    picks: list[int] = []
    for i in cand[np.argsort(-jump[cand], kind="stable")]:
        if all(abs(int(i) - p) > gap for p in picks):
            picks.append(int(i))
        if len(picks) >= max_n:
            break
    out = set()
    for p in picks:
        lo, hi = max(0, p - 20 * ms), min(len(e), p + 10 * ms)
        pk = float(e[max(0, p - 10 * ms):hi].max())
        above = np.flatnonzero(e[lo:hi] >= 0.1 * pk)
        on = lo + int(above[0]) if len(above) else p
        pre = float(np.sum(m[max(0, on - 20 * ms):max(0, on - 2 * ms)] ** 2)) + 1e-18
        post = float(np.sum(m[on:on + 10 * ms] ** 2)) + 1e-18
        if 10.0 * math.log10(pre / post) <= quiet_db:
            out.add(on)
    return sorted(out)


def attack_windows(x: np.ndarray, ons: list[int], pre_ms: float = 3.0, post_min_ms: float = 10.0,
                   post_max_ms: float = 30.0, hf_decay_db: float = 12.0) -> list[tuple[int, int]]:
    """每个起音的「起音段」[a, b)：起音前 pre_ms 到宽带与 >2 kHz 包络都从峰值降 hf_decay_db 后再 4 ms
    （夹在 10–30 ms；短素材不超过剩余长度的 35%）。相邻段合并。变速时这一段保持原速。"""
    m = _mono64(x)
    eb = _env_ms(m, 1.5)
    eh = _env_ms(sosfiltfilt(_HP2K, m), 0.5)
    ms = SR // 1000
    wins: list[list[int]] = []
    for on in ons:
        hi = min(len(m), on + int(post_max_ms * ms))
        if hi - on < 4:
            continue
        ends = []
        for env, pk_win in ((eh, 10), (eb, 15)):
            seg = env[on:hi]
            pk_i = int(np.argmax(seg[:min(len(seg), pk_win * ms)]))
            below = np.flatnonzero(seg[pk_i:] < seg[pk_i] * 10.0 ** (-hf_decay_db / 20.0))
            ends.append((pk_i + int(below[0]) if len(below) else len(seg)) + 4 * ms)
        cap = min(int(post_max_ms * ms), max(int(post_min_ms * ms), int(0.35 * (len(m) - on))))
        b = min(len(m), on + int(np.clip(max(ends), post_min_ms * ms, cap)))
        a = max(0, on - int(pre_ms * ms))
        if wins and a <= wins[-1][1]:
            wins[-1][1] = max(wins[-1][1], b)
        elif b > a:
            wins.append([a, b])
    return [(int(a), int(b)) for a, b in wins]


def _split_masks(n: int) -> tuple[np.ndarray, np.ndarray]:
    """rfft 域的低、高两段实数掩码（中段 = 1 − 低 − 高），对数频率上的余弦过渡。"""
    if n not in _SPLIT_MASKS:
        lf = np.log2(np.maximum(np.fft.rfftfreq(n, 1.0 / SR), 1.0))

        def fall(lo: float, hi: float) -> np.ndarray:
            u = np.clip((lf - math.log2(lo)) / (math.log2(hi) - math.log2(lo)), 0.0, 1.0)
            return 0.5 + 0.5 * np.cos(np.pi * u)

        _SPLIT_MASKS[n] = (fall(*GATE_SPLIT_HZ[0]), 1.0 - fall(*GATE_SPLIT_HZ[1]))
    return _SPLIT_MASKS[n]


def _analytic_split(y: np.ndarray) -> tuple[list[np.ndarray], np.ndarray]:
    """(C, N) 实信号 → ([低, 中, 高], 全带) 的解析信号：三段实部相加等于 y，取模就是包络（低频没有半周期纹波）。"""
    n = y.shape[-1]
    lo_m, hi_m = _split_masks(n)
    Y = sfft.rfft(np.asarray(y, np.float64), axis=-1)

    def analytic(spec: np.ndarray) -> np.ndarray:
        full = np.zeros(spec.shape[:-1] + (n,), np.complex128)
        full[..., : spec.shape[-1]] = spec
        full[..., 1:(n + 1) // 2] *= 2.0
        return sfft.ifft(full, axis=-1)

    z, zl, zh = analytic(Y), analytic(Y * lo_m), analytic(Y * hi_m)
    return [zl, z - zl - zh, zh], z


def _zenv(z: np.ndarray, win_ms: float) -> np.ndarray:
    """各声道功率平均后的包络 (N,)：立体声两边用同一条包络、同一个增益，声像不动。"""
    k = max(1, int(round(win_ms * 1e-3 * SR)))
    p = np.mean(np.abs(z) ** 2, axis=0)
    return np.sqrt(np.maximum(uniform_filter1d(p, size=k), 0.0) + 1e-30)


def _renv(y: np.ndarray, win_ms: float) -> np.ndarray:
    """(C, N) 实信号的短时 RMS 包络 (N,)，各声道功率平均。全带的起音前上限必须用它：
    解析信号包络自带希尔伯特拖尾（1/t 衰减），原录音是数字静音时也有 -40 dB 级的包络，闸门会把它当「原录音就有」放行。"""
    k = max(1, int(round(win_ms * 1e-3 * SR)))
    p = np.mean(np.asarray(y, np.float64) ** 2, axis=0)
    return np.sqrt(np.maximum(uniform_filter1d(p, size=k), 0.0) + 1e-30)


def onset_profiles(y: np.ndarray, onsets: np.ndarray) -> np.ndarray:
    """(C, N) 原录音 → (K, 4, L)：每个起音前 30 ms、后 40 ms 的低/中/高（解析包络）与全带（实信号 RMS）包络，
    相对起音后 40 ms 内该段平均能量的 dB（DEC 步长）。只是轮廓，不含波形。"""
    L = _PRE_N + _POST_N + 1
    offs = (np.arange(L) - _PRE_N) * DEC
    an_n = int(ONSET_ANCHOR_MS * 1e-3 * SR)
    bands, _ = _analytic_split(y)
    prof = np.empty((len(onsets), 4, L), np.float32)
    for j, e in enumerate([_zenv(zj, ONSET_ENV_MS[j]) for j, zj in enumerate(bands)] + [_renv(y, ONSET_ENV_MS[3])]):
        for k, o in enumerate(onsets):
            anchor = math.sqrt(float(np.mean(e[o:o + an_n] ** 2))) + 1e-30
            prof[k, j] = np.clip(20.0 * np.log10(e[np.clip(o + offs, 0, len(e) - 1)] / anchor), -120.0, 30.0)
    return prof


def _onset_shape(
    y: np.ndarray,
    ons: np.ndarray,
    slopes: np.ndarray,
    prof: np.ndarray,
    post: bool = True,
    post_slopes: Optional[np.ndarray] = None,
) -> np.ndarray:
    """(C, N) 的时域约束（起音前按 slopes、起音后按 post_slopes 缩放）：
      起音后：低/中/高三段的包络按原录音轮廓塑形 40/20/15 ms（增益 0–4 倍，窗尾 30% 渐回 1）；
      起音前 30 ms：三段与全带都不许比原录音轮廓响（只压不抬，窗头 3 ms 渐入）。
    起音后单独用 post_slopes：极短素材（如 14 ms 剪纸）拉长 2 倍时，起音后塑形窗跟着拉长，不会把拉长后的剪声一刀砍回原长。
    轮廓相对的是这条信号自己起音后 40 ms 的平均能量，所以整体响度、亮度怎么变都不受影响。"""
    n = y.shape[-1]
    an_n, ramp_n = int(ONSET_ANCHOR_MS * 1e-3 * SR), int(0.003 * SR)
    pos = np.arange(prof.shape[-1], dtype=np.float64)
    p_slopes = slopes if post_slopes is None else post_slopes

    def target(e: np.ndarray, k: int, j: int, o: int, s_lookup: float, s_an: float, t: np.ndarray) -> np.ndarray:
        anchor = math.sqrt(float(np.mean(e[o:min(n, o + int(an_n * s_an) + 1)] ** 2))) + 1e-30
        return anchor * 10.0 ** (np.interp(_PRE_N + (t - o) / (s_lookup * DEC), pos, prof[k, j]) / 20.0)

    def cap_before(g: np.ndarray, e: np.ndarray, j: int) -> None:
        for k, (o, s, sp) in enumerate(zip(ons, slopes, p_slopes)):
            a = max(0, o - int(_PRE_N * DEC * s))
            if not 0 < o < n or o <= a:
                continue
            t = np.arange(a, o)
            gk = np.minimum(1.0, target(e, k, j, o, s, sp, t) / (e[a:o] + 1e-12))
            ramp = np.clip((t - a) / ramp_n, 0.0, 1.0) if a > 0 else 1.0
            g[a:o] = np.minimum(g[a:o], 1.0 - ramp * (1.0 - gk))

    bands, _ = _analytic_split(y)
    out = np.zeros(y.shape, np.float64)
    for j, zj in enumerate(bands):
        e = _zenv(zj, ONSET_ENV_MS[j])
        g = np.ones(n)
        for k, (o, s, sp) in enumerate(zip(ons, slopes, p_slopes)):
            b = min(n, o + int(ONSET_POST_MS[j] * 1e-3 * SR * sp))
            if not post or not 0 <= o < b:
                continue
            t = np.arange(o, b)
            gk = np.clip(target(e, k, j, o, sp, sp, t) / (e[o:b] + 1e-12), 0.0, ONSET_MAX_GAIN)
            w = 0.5 + 0.5 * np.cos(np.pi * np.clip(((t - o) / (b - o) - 0.7) / 0.3, 0.0, 1.0))
            g[o:b] = 1.0 + w * (gk - 1.0)
        cap_before(g, e, j)
        out += zj.real * uniform_filter1d(g, size=9)[None, :]
    # 全带再压一遍起音前：分频本身也会把起音往前抹一点，三段各自压完不一定抵消干净
    g = np.ones(n)
    cap_before(g, _renv(out, ONSET_ENV_MS[3]), 3)
    return (out * uniform_filter1d(g, size=9)[None, :]).astype(np.float32)


def grain_mod(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(C, N) → ((3, N) 低/中/高的颗粒起伏 log2(细包络 / 8 ms 包络), (3,) 各段该加多少约束)。只是起伏的样子，不含波形。
    权重看原录音按 10 ms 局部 RMS 归一后的峭度：平滑噪声（风）≈0 或负，真有颗粒的（布料、火把）明显为正。
    各段取「本段」与「全带」两者较大的：布料的低频段单看不尖，但低频颗粒和中频同时鼓起才拼出大尖峰，也要约束。"""
    bands, z_all = _analytic_split(y)

    def weight(x: np.ndarray) -> float:
        e = _renv(x[None, :], 10.0)
        u = x[e > e.max() * 0.03] / e[e > e.max() * 0.03]
        k = float(np.mean(u ** 4) / (np.mean(u ** 2) ** 2 + 1e-30) - 3.0) if len(u) > 480 else 0.0
        return float(np.clip((k - GRAIN_KURT[0]) / (GRAIN_KURT[1] - GRAIN_KURT[0]), 0.0, 1.0))

    w_all = weight(z_all.real.mean(axis=0))
    mods = [np.log2(np.clip(_zenv(z, GRAIN_ENV_MS[j]) / _zenv(z, GRAIN_SMOOTH_MS), 0.1, 10.0)) for j, z in enumerate(bands)]
    ws = [max(weight(z.real.mean(axis=0)), w_all) for z in bands]
    return np.stack(mods).astype(np.float32), np.asarray(ws, np.float32)



def _grain_shape(y: np.ndarray, tgt: np.ndarray, w: np.ndarray) -> np.ndarray:
    """(C, N) 时域颗粒约束：三段的颗粒起伏往 tgt（log2，(3, N)）靠，权重 w ∈ [0, 1]（(3, N)）。三段实部相加仍是 y 的分解。"""
    out = np.zeros(y.shape, np.float64)
    for j, z in enumerate(_analytic_split(y)[0]):
        cur = np.log2(np.clip(_zenv(z, GRAIN_ENV_MS[j]) / _zenv(z, GRAIN_SMOOTH_MS), 0.1, 10.0))
        g = np.clip(2.0 ** (w[j] * (tgt[j] - cur)), GRAIN_GAIN[0], GRAIN_GAIN[1])
        out += z.real * uniform_filter1d(g, size=9)[None, :]
    return out.astype(np.float32)


def _onset_pre_bounds(bank: ERBFilterbank, on_frames: np.ndarray, slopes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """起音前被滤网抹开的那段（约 2.5 / 带宽，夹在 2–30 ms）的边界：(lo (K, NB), ci (K,))，第 b 带的区间是 [lo[k, b], ci[k])。"""
    w = np.minimum(np.clip(2.5 / np.maximum(bank.bw_hz, 1.0), 0.002, 1.0) * FS_BASE, ONSET_PRE_MS * 1e-3 * FS_BASE)
    lo = np.stack([np.maximum(0, np.floor(c - w * s)).astype(int) for c, s in zip(on_frames, slopes)])
    return lo, np.asarray([int(c) for c in on_frames], dtype=int)


def _onset_band_masks(bank: ERBFilterbank, m_base: int, on_frames: np.ndarray, slopes: np.ndarray) -> np.ndarray:
    """(NB, M) 布尔表：起音前各子带被零相位滤网抹开的那段（约 2.5 / 带宽，夹在 2–30 ms）。
    这段的子带包络是滤网抹出来的，不可信：只许压不许抬。（起音后那段子带照常对齐：实测不对齐频谱误差会涨到 4–6 dB。）"""
    lo, ci = _onset_pre_bounds(bank, on_frames, slopes)
    pre = np.zeros((bank.nb, m_base), bool)
    for k in range(len(ci)):
        for b in range(bank.nb):
            pre[b, lo[k, b]:ci[k]] = True
    return pre


def _model_stats(model: "ERBModel") -> dict:
    """只与模型有关、与种子和参数无关的统计量（env 转 float64 再平方求和每次要几毫秒，长声音上比 GPU 渲染还慢），缓存在模型实例上。"""
    st = getattr(model, "_stats", None)
    if st is None:
        w2 = model.env.astype(np.float64) ** 2
        band_pow = np.mean(w2, axis=1) + 1e-30
        log_f = np.log2(np.maximum(model.centers_hz, 20.0))
        k_pow = band_pow * _k_band_weights(model.centers_hz)
        st = dict(
            tonal=float(np.sum(model.kappa * w2) / (np.sum(w2) + 1e-30)),
            log_f=log_f,
            k_pow=k_pow,
            log_f_center=float(np.sum(k_pow * log_f) / (np.sum(k_pow) + 1e-30)),
            tot_e=np.sqrt(np.sum(w2, axis=0)),
        )
        model._stats = st
    return st


def _onset_time_map(model: "ERBModel", out_n: int, att_slope: float) -> tuple[np.ndarray, np.ndarray]:
    """起音段按 att_slope（= size）走，其余部分均匀伸缩，总长 out_n。返回（源采样节点，输出采样节点）。
    两条细节护栏：
      1) 极短声音（如 14 ms 剪纸）的保速起音段不超过有效尾长的 25%（下限 3 ms），避免整段剪声都被冻住拉不开；
      2) 拉长（out_n > n）时，首起音前的纯静音预留不跟着拉长，把拉伸预算留给有声段、也不把节拍推迟。"""
    n = model.n_orig
    tot_e = _model_stats(model)["tot_e"]
    pk_e = float(tot_e.max()) + 1e-30
    segs: list[list[int]] = []
    for a_raw, b_raw in model.onset_seg:
        a, b = int(a_raw), int(b_raw)
        # 找该起音段内最后一个起音作为有效尾长起点（兼容相邻段合并）
        in_ons = [int(o) for o in model.onsets if a <= int(o) <= b] if model.onsets is not None else []
        ref_o = in_ons[-1] if in_ons else a
        fo = min(len(tot_e) - 1, ref_o // DEC)
        after = np.flatnonzero(tot_e[fo:] > 0.1 * pk_e)
        act_after = int((after[-1] + 1) * DEC) if len(after) else (b - ref_o)
        b_new = min(b, ref_o + max(int(0.003 * SR), int(0.25 * act_after)))
        if b_new > a:
            if segs and a <= segs[-1][1]:
                segs[-1][1] = max(segs[-1][1], b_new)
            else:
                segs.append([a, b_new])

    lead_fix = 0
    if segs and model.onsets is not None and model.onset_prof is not None and out_n > n:
        p_pre = model.onset_prof[0, 3, :_PRE_N]
        loud = np.flatnonzero(p_pre > -30.0)
        silent_until = int(model.onsets[0]) - (_PRE_N - int(loud[0])) * DEC if len(loud) else segs[0][0]
        lead_fix = max(0, min(segs[0][0], silent_until))
    use_lead_fix = lead_fix > int(0.002 * SR)

    lw = sum(b - a for a, b in segs)
    fixed_in = lw + (lead_fix if use_lead_fix else 0)
    fixed_out = att_slope * lw + (lead_fix if use_lead_fix else 0)
    rem_in = n - fixed_in
    s = (out_n - fixed_out) / max(rem_in, 1)
    if rem_in <= 0 or s < 0.2:  # 起音段塞不进目标时长（极短素材大幅压缩）：退回均匀伸缩
        return np.array([0.0, n]), np.array([0.0, float(out_n)])
    src, out, pos, prev = [0.0], [0.0], 0.0, 0
    if use_lead_fix:
        pos += float(lead_fix)
        src.append(lead_fix)
        out.append(pos)
        prev = lead_fix
    for a, b in segs:
        pos += s * (a - prev)
        src.append(a)
        out.append(pos)
        pos += att_slope * (b - a)
        src.append(b)
        out.append(pos)
        prev = b
    pos += s * (n - prev)
    src.append(n)
    out.append(pos)
    return np.asarray(src, np.float64), np.asarray(out, np.float64) * (out_n / pos)


@dataclass
class ERBModel:
    """无量化 float32 规整 ERB 声学模型（可另存为 float16 紧凑资产，不含原始波形）。"""
    sr: int
    nb: int
    n_orig: int                  # 原始有效采样点数
    m_active: int                # 原始有效基带帧数
    env: np.ndarray              # (NB, m_active) float32 能量包络（单声道或立体声联合）
    kappa: np.ndarray            # (NB, m_active) float32 相干载波占比 [0, 1]
    omega: np.ndarray            # (NB, m_active) float32 瞬时基带角频率 (rad/baseband_sample)
    phase0: np.ndarray           # (NB, m_active) float32 相位参考
    impulsiveness: np.ndarray    # (m_active,) float32 跨带瞬态相位对齐强度 [0, 0.85]
    top_amp: float               # 峰值子带幅值
    centers_hz: np.ndarray       # (NB,)
    centers_erb: np.ndarray      # (NB,)
    # 可选立体声参数（当源为双声道时保留每带 ILD / ICC / IPD 与时变声像）
    stereo: bool = False
    ild_db: Optional[np.ndarray] = None      # (NB,) L/R 能量差 dB
    icc: Optional[np.ndarray] = None         # (NB,) 实部归一化互相关 [-1, 1]
    ipd: Optional[np.ndarray] = None         # (NB,) 平均声道相位差 rad
    pan_db: Optional[np.ndarray] = None      # (m_active,) 时变声像偏移 dB
    # 「先静后响」的起音（没有就是 None，纹理类声音常见）
    onsets: Optional[np.ndarray] = None      # (K,) 起音采样点（源时间）
    onset_seg: Optional[np.ndarray] = None   # (S, 2) 起音段 [a, b)，变速时保持原速
    onset_prof: Optional[np.ndarray] = None  # (K, 4, L) 起音前 30 ms、后 40 ms 低/中/高/全带的相对轮廓 dB
    grain: Optional[np.ndarray] = None       # (3, m_active) 低/中/高的颗粒起伏 log2(细包络/8 ms 包络)，基带帧率
    grain_w: Optional[np.ndarray] = None     # (3,) 各段颗粒约束的权重（原录音该段有多「噼啪」）

    def compact_bytes_fp16(self) -> int:
        total = (
            self.env.size * 2
            + self.kappa.size * 2
            + self.omega.size * 2
            + self.impulsiveness.size * 2
        )
        if self.stereo and self.pan_db is not None:
            total += (self.ild_db.size + self.icc.size + self.ipd.size + self.pan_db.size) * 2
        if self.onsets is not None:
            total += self.onsets.size * 4 + self.onset_seg.size * 4 + self.onset_prof.size * 2
        if self.grain is not None:
            total += self.grain.size * 2
        return total


def analyze(x: np.ndarray, sr: int = SR, nb: int = NB, pad_ms: float = 40.0) -> ERBModel:
    """将 48 kHz 单声道或立体声录音分析为规整 96 带 ERB 模型。"""
    assert sr == SR, f"Expected {SR} Hz, got {sr}"
    x = np.asarray(x, dtype=np.float32)
    is_stereo = x.ndim == 2 and x.shape[1] == 2
    if x.ndim == 2 and x.shape[1] == 1:
        x = x[:, 0]
    n_orig = x.shape[0]

    m_base, pad_base = _choose_m_base(n_orig, pad_ms=pad_ms, sr=sr)
    bank = get_filterbank(m_base, nb=nb, sr=sr)
    pad_samp = pad_base * DEC
    m_active = int(math.ceil(n_orig / DEC))

    if is_stereo:
        buf = np.zeros((2, bank.n_fft), dtype=np.float32)
        buf[:, pad_samp : pad_samp + n_orig] = x.T
        z_lr = analyze_subbands(buf, bank)  # (2, NB, M)
        z_l, z_r = z_lr[0], z_lr[1]
        # 联合包络与声道统计
        p_l = z_l.real ** 2 + z_l.imag ** 2
        p_r = z_r.real ** 2 + z_r.imag ** 2
        env_full = np.sqrt(0.5 * (p_l + p_r)).astype(np.float32)
        z_mono = 0.5 * (z_l + z_r)
        x_mono_buf = 0.5 * (buf[0] + buf[1])

        sl = slice(pad_base, pad_base + m_active)
        sum_l = p_l[:, sl].sum(axis=1) + 1e-14
        sum_r = p_r[:, sl].sum(axis=1) + 1e-14
        ild_db = (10.0 * np.log10(sum_l / sum_r)).astype(np.float32)
        cross = (z_l[:, sl] * np.conj(z_r[:, sl])).sum(axis=1)
        coh_complex = cross / (np.sqrt(sum_l * sum_r) + 1e-14)
        icc = np.clip(np.abs(coh_complex) * np.cos(np.angle(coh_complex)), -1.0, 1.0).astype(np.float32)
        ipd = np.angle(coh_complex).astype(np.float32)
        # 时变声像（平滑 25 ms）
        tot_l = uniform_filter1d(p_l[:, sl].sum(axis=0), size=150, mode="nearest") + 1e-12
        tot_r = uniform_filter1d(p_r[:, sl].sum(axis=0), size=150, mode="nearest") + 1e-12
        pan_db = np.clip(10.0 * np.log10(tot_l / tot_r) - float(np.median(ild_db)), -12.0, 12.0).astype(
            np.float32
        )
    else:
        buf = np.zeros(bank.n_fft, dtype=np.float32)
        buf[pad_samp : pad_samp + n_orig] = x
        z_mono = analyze_subbands(buf, bank)  # (NB, M)
        env_full = np.abs(z_mono).astype(np.float32)
        x_mono_buf = buf
        ild_db = icc = ipd = pan_db = None

    kappa_full, omega_full, phase_full = _estimate_coherence_and_freq(z_mono, bank, m_active)
    imp_full = _estimate_impulsiveness(x_mono_buf, env_full, m_base)

    sl = slice(pad_base, pad_base + m_active)
    env = env_full[:, sl].copy()
    kappa = kappa_full[:, sl].copy()
    omega = omega_full[:, sl].copy()
    phase0 = phase_full[:, sl].copy()
    imp = imp_full[sl].copy()

    pad = int(0.05 * SR)  # 两头补零，免得分频的循环卷积把片尾绕到片头
    x2 = np.pad(np.asarray(x.T if x.ndim == 2 else x[None, :], np.float64), ((0, 0), (pad, pad)))
    gmod, grain_w = grain_mod(x2)
    grain = gmod[:, pad:pad + n_orig:DEC][:, :m_active].copy()
    onsets = onset_seg = onset_prof = None
    ons = detect_attacks(x)
    if ons:
        onsets = np.asarray(ons, np.int64)
        onset_seg = np.asarray(attack_windows(x, ons), np.int64).reshape(-1, 2)
        onset_prof = onset_profiles(x2, onsets + pad)

    return ERBModel(
        sr=sr,
        nb=nb,
        n_orig=n_orig,
        m_active=m_active,
        env=env,
        kappa=kappa,
        omega=omega,
        phase0=phase0,
        impulsiveness=imp,
        top_amp=float(env.max() + 1e-12),
        centers_hz=bank.centers_hz.copy(),
        centers_erb=bank.centers_erb.copy(),
        stereo=is_stereo,
        ild_db=ild_db,
        icc=icc,
        ipd=ipd,
        pan_db=pan_db,
        onsets=onsets,
        onset_seg=onset_seg,
        onset_prof=onset_prof,
        grain=grain,
        grain_w=grain_w,
    )


def _generate_bandlimited_unit_noise(
    rng: np.random.Generator, bank: ERBFilterbank, c_ch: int = 1
) -> np.ndarray:
    """生成去除 Rayleigh 振幅起伏的单位恒模带限复噪声载波 (c_ch, NB, M)。"""
    nb, m = bank.nb, bank.m_base
    # 直接在频域按子带半余弦窗抽样复高斯白噪 -> IFFT 即得严格带限解析噪声
    re = rng.standard_normal((c_ch, nb, m)).astype(np.float32)
    im = rng.standard_normal((c_ch, nb, m)).astype(np.float32)
    N_spec = (re + 1j * im) * bank.band_mask[None, :, :]
    bn = sfft.ifft(N_spec, axis=-1).astype(np.complex64)
    # 除以自身 Rayleigh 包络，消除噪声声码器特有的“水声/抽吸颗粒感”
    mag = np.abs(bn)
    rms = np.sqrt(np.mean(mag * mag, axis=-1, keepdims=True) + 1e-14)
    bn_unit = bn / np.maximum(mag, 0.22 * rms)
    # 归一化到单位 RMS
    out_rms = np.sqrt(np.mean(bn_unit.real ** 2 + bn_unit.imag ** 2, axis=-1, keepdims=True) + 1e-14)
    return (bn_unit / out_rms).astype(np.complex64)


def _impulse_peaks(rng: np.random.Generator, bank: ERBFilterbank, gamma_full: np.ndarray, strength: float = 0.72):
    """跨带同相微冲激的规划：非极大值抑制挑出冲激帧（最小间隔 1.5 ms = 9 帧），并为每个冲激抽随机子采样偏移与希尔伯特相位。
    返回 (帧位置列表, 每带相量 (P, NB) complex64, 每个冲激的幅度列表)。
    物理原理：在 48 kHz 采样点 n0 处的理想冲激，在第 b 个 ERB 复基带子带的相位严格等于 phi0 - 2*pi*kc[b]*n0/N
    （实测误差 < 0.001 rad，零额外 FFT）。每次渲染的偏移与相位都是新抽的，绝不复用原波形。"""
    m_base = bank.m_base
    g = gamma_full
    if float(g.max()) <= 0.12 or strength <= 0.0:
        return [], np.zeros((0, bank.nb), np.complex64), []
    min_sep = 9
    order = np.argsort(g)[::-1]
    taken = np.zeros(m_base, dtype=bool)
    peaks = []
    # 每秒至多 ~120 个显著微冲激，限制单次极长片段的循环次数
    max_peaks = max(12, int(m_base / 50))
    for idx in order:
        if g[idx] <= 0.14 or len(peaks) >= max_peaks:
            break
        if taken[idx]:
            continue
        peaks.append(int(idx))
        taken[max(0, idx - min_sep) : min(m_base, idx + min_sep + 1)] = True
    kc_f = bank.kc.astype(np.float64)
    phasors = np.zeros((len(peaks), bank.nb), np.complex64)
    amps = []
    for i, pk in enumerate(peaks):
        n0 = pk * DEC + int(rng.integers(0, DEC))
        phi0 = float(rng.uniform(-np.pi, np.pi))
        phasors[i] = np.exp(1j * (phi0 - (2.0 * np.pi * kc_f * n0 / bank.n_fft))).astype(np.complex64)
        amps.append(np.minimum(0.88, float(g[pk]) * strength))
    return peaks, phasors, amps


def _impulse_sigma(bank: ERBFilterbank) -> tuple[np.ndarray, np.ndarray]:
    """每带冲激时间窗宽度（高频 ~0.6 ms，中频 ~2.2 ms，低频上限 3.0 ms）与权重（250 Hz 以下不强行对齐，避免低频噗噗声）。"""
    sigma_b = np.clip(0.55 * FS_BASE / np.maximum(bank.bw_hz, 80.0), 3.5, 18.0).astype(np.float32)
    band_imp_scale = np.clip((bank.centers_hz - 200.0) / 400.0, 0.0, 1.0).astype(np.float32)
    return sigma_b, band_imp_scale


def _impulse_carrier(bank: ERBFilterbank, peaks: list, phasors: np.ndarray, amps: list) -> tuple[np.ndarray, np.ndarray]:
    """按 _impulse_peaks 的规划累加跨带同相微冲激载波 (NB, M) 与逐带混合权重 (NB, M)，只更新每个冲激 ±54 帧。"""
    nb, m_base = bank.nb, bank.m_base
    imp_acc = np.zeros((nb, m_base), dtype=np.complex64)
    w_acc = np.zeros((nb, m_base), dtype=np.float32)
    if not peaks:
        return imp_acc, w_acc
    t_grid = np.arange(m_base, dtype=np.float32)
    sigma_b, band_imp_scale = _impulse_sigma(bank)
    for pk, phasor, amp in zip(peaks, phasors, amps):
        lo = max(0, pk - 54)
        hi = min(m_base, pk + 55)
        dt = (t_grid[lo:hi] - float(pk))[None, :]
        win = np.exp(-0.5 * (dt / sigma_b[:, None]) ** 2).astype(np.float32)
        wt = amp * band_imp_scale[:, None] * win
        imp_acc[:, lo:hi] += phasor[:, None] * wt
        w_acc[:, lo:hi] = np.maximum(w_acc[:, lo:hi], wt)
    mag = np.abs(imp_acc)
    imp_unit = np.where(mag > 1e-6, imp_acc / np.maximum(mag, 1e-6), 0.0).astype(np.complex64)
    return imp_unit, np.clip(w_acc, 0.0, 0.88).astype(np.float32)


def _erb_axis_map(centers_erb: np.ndarray, freq_scale: float):
    """ERB 频率轴缩放（物理尺寸 size / 音高 pitch）的映射：输出带 f_b 读取源频率 f_b / freq_scale。
    返回 (i0, frac, valid, above, below, roll_above, roll_below)；不缩放时返回 None。_resample_erb_axis 与 GPU 共用这一份。"""
    if abs(freq_scale - 1.0) < 1e-4:
        return None
    centers_hz = erb_to_hz(centers_erb)
    src_hz = centers_hz / freq_scale
    src_erb = hz_to_erb(src_hz)
    # 映射到连续带索引 [0, NB-1]
    e0, e1 = float(centers_erb[0]), float(centers_erb[-1])
    nb = len(centers_erb)
    idx_f = (src_erb - e0) / (e1 - e0) * (nb - 1)
    valid = (idx_f >= 0.0) & (idx_f <= nb - 1)
    idx_clip = np.clip(idx_f, 0.0, nb - 1 - 1e-6)
    i0 = np.floor(idx_clip).astype(np.int32)
    frac = (idx_clip - i0).astype(np.float32)
    # 超出上界（如 size > 1 向下移频，顶端空出的高频带）与下界平滑滚降而非硬切
    above = idx_f > (nb - 1)
    below = idx_f < 0.0
    roll_above = np.exp(-0.45 * (idx_f - (nb - 1)).astype(np.float32))
    roll_below = np.exp(-0.6 * (-idx_f).astype(np.float32))
    return i0, frac, valid, above, below, roll_above, roll_below


def _resample_erb_axis(arr: np.ndarray, centers_erb: np.ndarray, freq_scale: float) -> np.ndarray:
    """沿 ERB 频率轴平滑缩放 (NB, T) 数组（物理尺寸 size / 音高 pitch 变换）。"""
    mp = _erb_axis_map(centers_erb, freq_scale)
    if mp is None:
        return arr.copy()
    i0, frac, valid, above, below, roll_above, roll_below = mp
    out = np.zeros_like(arr)
    out[valid] = (1.0 - frac[valid, None]) * arr[i0[valid]] + frac[valid, None] * arr[i0[valid] + 1]
    if np.any(above):
        out[above] = arr[-1:] * roll_above[above][:, None]
    if np.any(below):
        out[below] = arr[0:1] * roll_below[below][:, None]
    return out


# 「同一件东西敲几次」的 take 间变化量（第 2 轮盲听连敲复盘后重写，彻底去掉「双重瑞利」与失控随机 EQ）：
#   1) 微观纹理：原录音包络里已经带着一份自然瑞利起伏（σ=5.57 dB），绝不能再往上面硬乘 7 dB 噪声（会叠成双重瑞利、砸塌布料与笔帽音头）。
#      改为「宽带宏观轮廓 G(m) × 平滑频谱占比 N(b,m)」拆分，只在非纯音、非起音区域用新抽的带限高斯白噪包络替换旧毛刺（单份自然瑞利，
#      自带 ERB 紧框架跨带相关性，不跟交替投影打架，也绝不抹平布料纤维甩动与快门多响）。
#   2) 宏观微调：静态频谱起伏收紧到 1.10 dB（跨 3.5 带平滑）、倾斜用 1.4 oct tanh 软架并绕声音自身能量重心旋转（防止快门等双峰声质心乱飞），
#      并强制 K 加权总能量守恒，确保 vary 不会把同一只木鱼搞成忽大忽小 10 dB。响度变化仍由调用方给。
VARY_DUR, VARY_SIZE, VARY_TILT, VARY_HARD = 0.075, 0.022, 0.40, 0.30  # 每 1.0 vary 的 σ：时长、尺寸、软架倾斜 dB/oct、起音硬度
VARY_RIPPLE_DB, VARY_RIPPLE_SIGMA = 1.10, 3.5                         # 静态平滑频谱起伏（σ dB，沿 ERB 轴平滑带数）
# 多 take（render_takes）：从同一动作的几下里学变化
TAKE_ATK_MS = 20.0        # 「咔」窗：起音前 1 ms 到起音后 20 ms 的频谱单独学（真实快门、笔帽变的主要是这一段）
TAKE_FLOOR_DB = 60.0      # 比该段最强频带低 60 dB 以上的按 −60 dB 计，空带不当成「变化」
TAKE_SMOOTH_BANDS = 1.5   # 沿 ERB 轴平滑：短窗频谱估计自带的随机起伏不能当成「变化」学进去


def _k_band_weights(centers_hz: np.ndarray) -> np.ndarray:
    """近似 BS.1770 K 加权功率响应（38 Hz 高通 + 1681 Hz +4 dB 高频架），用于 vary EQ 响度守恒。"""
    f = np.asarray(centers_hz, np.float64)
    hp = (f ** 4) / (f ** 4 + 38.0 ** 4)
    g_hi = 10.0 ** (4.0 / 10.0)
    shelf = 1.0 + (g_hi - 1.0) * (f ** 2) / (f ** 2 + 1681.0 ** 2)
    return (hp * shelf).astype(np.float64)


def _unit_noise(rng: np.random.Generator, shape: tuple, sigma: tuple) -> np.ndarray:
    """平滑高斯随机场，实测标准差归一到 1。"""
    f = gaussian_filter(rng.standard_normal(shape), sigma=sigma, mode="reflect")
    return (f / (float(f.std()) + 1e-12)).astype(np.float32)


@dataclass
class Plan:
    """render 的一次规划（plan 产出，_execute_numpy 或 GPU 执行）：采样点级的轻量参数，加上这一条 take 的全部随机数。
    rng 停在「纹理重抽白噪 w_td 与噪声载波」之前：两个执行器都从这里接着抽，同一份 Plan 在 CPU 与 GPU 上用的是同一组随机数。"""
    m_base: int
    pad_base: int
    out_n: int                     # 输出采样点数
    out_m: int                     # 输出基带帧数
    exact: int
    vary: float                    # v（纹理重抽强度）
    size: float                    # 抖动后的尺寸（也是起音段斜率）
    freq_scale: float
    hard: float
    use_stereo: bool
    stereo_mode: int               # 0 单声道输出；1 立体声模型按 ILD/ICC 重构；2 单声道模型输出双声道
    src_pos: np.ndarray            # (out_m,) float64 每个输出帧读取的源帧位置
    imp_t: np.ndarray              # (out_m,) float32
    gain_db: np.ndarray            # (NB,) float32 bright 倾斜 + vary 静态起伏
    eq: Optional[np.ndarray]       # (E, NB) float32 学来的「咔」/声身频谱（render_takes）
    w_atk: Optional[np.ndarray]    # (out_m,) float32「咔」窗权重
    imp_full: np.ndarray           # (M,) float32 跨带冲激强度
    imp: Optional[tuple]           # _impulse_peaks 的结果；None = 不加冲激载波
    init_phi: np.ndarray           # (NB, 1) float32 相干载波初相
    use_on: bool
    on_f: Optional[np.ndarray] = None        # (K,) 起音在输出里的帧位置（不含补零）
    on_slope: Optional[np.ndarray] = None    # (K,) 起音段局部时间倍率
    post_slope: Optional[np.ndarray] = None  # (K,) 起音后 20 ms 的实际拉伸倍率
    on_samp: Optional[np.ndarray] = None     # (K,) 起音采样点（含补零）
    use_grain: bool = False
    use_reseed: bool = False
    att_prot: Optional[np.ndarray] = None    # (M,) 纹理重抽的起音保护
    pan_full: Optional[np.ndarray] = None    # (M,) 时变声像（stereo_mode == 1）
    rng: Optional[np.random.Generator] = None


def plan(
    model: ERBModel,
    seed: int = 0,
    dur: float = 1.0,
    time_warp: Optional[Callable[[np.ndarray], np.ndarray]] = None,
    size: float = 1.0,
    pitch: float = 0.0,
    bright: float = 0.0,
    hard: float = 0.0,
    vary: float = 0.0,
    exact: int = 4,
    impulse_strength: float = 1.0,
    pad_ms: float = 40.0,
    stereo_out: Optional[bool] = None,
    transients: bool = True,
    eq_db: Optional[np.ndarray] = None,
    m_floor: int = 0,
) -> Plan:
    """render 的规划段（参数含义同 render）：只做采样点级的轻量计算并抽随机数，(NB, M) 的重计算留给执行器。
    m_floor：基带帧数 m_base 的下限。GPU 批量渲染用它让带时长抖动的一批 take 共用同一个 m_base（多出来的是静音补零，
    不改变声音）；默认 0 = 按这一条自己的长度选。"""
    rng = np.random.default_rng(seed)

    # 调用方要的变速/变大小（vary 自己的小抖动不算）：这种时候不加颗粒约束，免得颗粒被一起拉长，也不动已过耳的变速
    req_stretch = (time_warp is not None) or abs(dur - 1.0) > 1e-3 or abs(size - 1.0) > 1e-3

    # 有机微抖动（避免连续多下出现“机关枪效应”，同时保持“同一件东西”的材质一致与 K 加权响度守恒）
    v = float(max(0.0, vary))
    eq_v = np.zeros(model.nb, dtype=np.float32)
    if v > 0.0 and eq_db is None:
        st = _model_stats(model)
        tonal, log_f, k_pow, log_f_center = st["tonal"], st["log_f"], st["k_pow"], st["log_f_center"]

        clip_n = lambda: float(np.clip(rng.standard_normal(), -2.0, 2.0))  # noqa: E731
        dur = float(dur * math.exp(VARY_DUR * v * clip_n()))
        # 纯音占比越高，分音频率越是物体本身决定的：尺寸抖动随之收紧（保留 18% 下限做极细微有机漂移）
        size_scale = max(0.18, 1.0 - 0.82 * tonal)
        size = float(size * math.exp(VARY_SIZE * v * size_scale * clip_n()))
        # 绕声音自身能量重心做 1.4 oct 软架倾斜：单峰声自然明暗变化，双峰声（如快门）不会两端扯断
        df = 1.4 * np.tanh((log_f - log_f_center) / 1.4)
        vary_tilt_db = (VARY_TILT * v * clip_n() * df).astype(np.float32)
        hard = float(hard + VARY_HARD * v * clip_n())
        raw_rip = _unit_noise(rng, (model.nb,), (VARY_RIPPLE_SIGMA,))
        ripple_db = np.clip(VARY_RIPPLE_DB * v * raw_rip, -2.0 * VARY_RIPPLE_DB * v, 2.0 * VARY_RIPPLE_DB * v).astype(
            np.float32
        )
        eq_v = ripple_db + vary_tilt_db
        # K 加权功率守恒补偿，杜绝随机 EQ 撞上共鸣峰把单下响度拉飞
        ratio_pow = float(np.sum(k_pow * (10.0 ** (eq_v / 10.0))) / (np.sum(k_pow) + 1e-30))
        eq_v = (eq_v - 10.0 * math.log10(max(ratio_pow, 1e-6))).astype(np.float32)

    freq_scale = (2.0 ** (pitch / 12.0)) / size

    # 目标有效长度
    out_n_samp = max(DEC * 8, int(round(model.n_orig * dur)))
    out_m_active = int(math.ceil(out_n_samp / DEC))
    m_base, pad_base = _choose_m_base(out_n_samp, pad_ms=pad_ms, sr=model.sr)
    m_base = max(m_base, int(m_floor))
    bank = get_filterbank(m_base, nb=model.nb, sr=model.sr)

    # 时间轴重采样（支持标量拉伸或任意逐帧运动学曲线）；有起音时起音段按 size 走、不跟着 dur 拉长压短
    use_on = transients and model.onsets is not None
    stretched = (time_warp is not None) or (out_n_samp != model.n_orig) or (abs(size - 1.0) > 1e-3)
    u_out = np.linspace(0.0, 1.0, out_m_active, dtype=np.float64)
    if time_warp is not None:
        src_pos = np.clip(np.asarray(time_warp(u_out), dtype=np.float64), 0.0, 1.0) * max(model.m_active - 1, 1)
    elif use_on and (out_n_samp != model.n_orig or abs(size - 1.0) > 1e-3):
        sk, ok_ = _onset_time_map(model, out_n_samp, size)
        src_pos = np.clip(np.interp(np.arange(out_m_active) * float(DEC), ok_, sk) / DEC, 0.0, model.m_active - 1)
    else:
        src_pos = u_out * max(model.m_active - 1, 1)
    src_grid = np.arange(model.m_active, dtype=np.float64)
    imp_t = np.interp(src_pos, src_grid, model.impulsiveness).astype(np.float32)

    # 频谱倾斜（bright）+ 响度守恒的多 take 音色微调（eq_v）；学来的频谱：首起音前 1 ms 到后 TAKE_ATK_MS 用「咔」那条，
    # 其余用声身那条，两头 3 ms 线性过渡
    octs = np.log2(np.maximum(model.centers_hz, 20.0) / 1500.0).astype(np.float32)
    gain_db = bright * octs + eq_v
    eq = w_atk = None
    if eq_db is not None:
        eq = np.asarray(eq_db, np.float32).reshape(-1, model.nb)
        w_atk = np.zeros(out_m_active, np.float32)
        if eq.shape[0] == 2 and model.onsets is not None:
            fr = np.arange(out_m_active, dtype=np.float64)
            c = float(np.interp(model.onsets[0] / DEC, src_pos, fr))
            a0, a1, ramp = c - 1e-3 * FS_BASE, c + TAKE_ATK_MS * 1e-3 * FS_BASE * size, 3e-3 * FS_BASE
            w_atk = np.clip(np.minimum(fr - (a0 - ramp), (a1 + ramp) - fr) / ramp, 0.0, 1.0).astype(np.float32)

    IMP_full = np.zeros(m_base, dtype=np.float32)
    IMP_full[pad_base : pad_base + out_m_active] = np.clip(imp_t * impulse_strength, 0.0, 0.85)

    # 起音在输出里的位置（补零后的采样点）、起音段斜率与起音后实际拉伸斜率
    pad_samp = pad_base * DEC
    on_f = on_slope = post_slope = on_samp = None
    if use_on:
        frames = np.arange(out_m_active, dtype=np.float64)
        on_f = np.interp(model.onsets / DEC, src_pos, frames)
        dsrc = np.gradient(src_pos) if out_m_active > 2 else np.ones(out_m_active)
        on_slope = 1.0 / np.maximum(np.interp(on_f, frames, dsrc), 1e-3)
        if stretched:
            post_ref_f = np.minimum(model.m_active - 1.0, model.onsets / DEC + 0.020 * FS_BASE)
            post_out_f = np.interp(post_ref_f, src_pos, frames)
            post_slope = np.clip((post_out_f - on_f) / np.maximum(post_ref_f - model.onsets / DEC, 1.0), 0.25, 4.0)
        else:
            post_slope = on_slope
        on_samp = (pad_samp + np.round(on_f * DEC)).astype(np.int64)

    use_grain = GRAIN and transients and model.grain is not None and not req_stretch and float(model.grain_w.max()) > 0.0
    use_stereo = model.stereo if stereo_out is None else stereo_out
    stereo_mode = 1 if (use_stereo and model.stereo and model.ild_db is not None) else (2 if use_stereo else 0)

    # 相干载波初相（随机初始相位保证不同 seed 独立）与跨带冲激的随机数
    init_phi = rng.uniform(-np.pi, np.pi, size=(model.nb, 1)).astype(np.float32)
    imp = None
    if impulse_strength > 0.0 and float(IMP_full.max()) > 0.12:
        imp = _impulse_peaks(rng, bank, IMP_full, strength=0.72 * impulse_strength)

    # 纹理重抽的起音保护：起音前 4 ms 到后 6 ms 锁死，再 6 ms 余弦渐放
    use_reseed = v > 0.0
    att_prot = None
    if use_reseed:
        att_prot = np.clip(IMP_full / 0.25, 0.0, 1.0).astype(np.float32)
        if use_on:
            for cf, s_on in zip(pad_base + on_f, on_slope):
                i0 = max(0, int(cf - 0.004 * FS_BASE * s_on))
                i1 = min(m_base, int(cf + 0.006 * FS_BASE * s_on))
                i2 = min(m_base, int(cf + 0.012 * FS_BASE * s_on))
                att_prot[i0:i1] = 1.0
                if i2 > i1:
                    fade = 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, i2 - i1, dtype=np.float32)))
                    att_prot[i1:i2] = np.maximum(att_prot[i1:i2], fade)

    pan_full = None
    if stereo_mode == 1:
        pan_full = np.zeros(m_base, dtype=np.float32)
        pan_full[pad_base : pad_base + out_m_active] = np.interp(src_pos, src_grid, model.pan_db).astype(np.float32)

    return Plan(
        m_base=m_base, pad_base=pad_base, out_n=out_n_samp, out_m=out_m_active, exact=int(exact), vary=v, size=size,
        freq_scale=freq_scale, hard=hard, use_stereo=bool(use_stereo), stereo_mode=stereo_mode, src_pos=src_pos,
        imp_t=imp_t, gain_db=gain_db, eq=eq, w_atk=w_atk, imp_full=IMP_full, imp=imp, init_phi=init_phi,
        use_on=bool(use_on), on_f=on_f, on_slope=on_slope, post_slope=post_slope, on_samp=on_samp,
        use_grain=bool(use_grain), use_reseed=use_reseed, att_prot=att_prot, pan_full=pan_full, rng=rng,
    )


def _finish(y_out: np.ndarray, out_n_samp: int, sr: int, use_stereo: bool) -> np.ndarray:
    """(C, out_n) 收尾：首尾防咔嗒窗与软限幅，返回 (out_n,) 或 (out_n, 2)。"""
    # 边界防咔嗒窗：开头只给 0.3 ms（起音可能就在头几个采样，窗长了会削掉起音），结尾短拟音 0.4 ms、长环境床 2 ms
    head = min(int(0.0003 * sr), out_n_samp // 12)
    tail = min(int((0.0004 if out_n_samp < int(0.25 * sr) else 0.002) * sr), out_n_samp // 12)
    for k, at_head in ((head, True), (tail, False)):
        if k > 4:
            ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, k, dtype=np.float32))
            if at_head:
                y_out[:, :k] *= ramp[None, :]
            else:
                y_out[:, -k:] *= ramp[::-1][None, :]

    # 透明软限幅天花板（仅作用于 >0.90 的偶发相位尖峰，避免整条增益被拉低，确保 0 削波）
    ceil = 0.90
    knee = 0.075
    abs_y = np.abs(y_out)
    over = abs_y > ceil
    if np.any(over):
        y_out = np.where(
            over,
            np.sign(y_out) * (ceil + knee * np.tanh((abs_y - ceil) / knee)),
            y_out,
        ).astype(np.float32)

    if not use_stereo:
        return y_out[0]
    return y_out.T  # (n_samp, 2)


def _execute_numpy(model: ERBModel, p: Plan) -> np.ndarray:
    """render 的执行段（CPU 参考实现）：(NB, M) 张量构造、三路载波、exact 轮交替投影、合成与收尾。"""
    m_base, pad_base, out_m_active, out_n_samp = p.m_base, p.pad_base, p.out_m, p.out_n
    bank = get_filterbank(m_base, nb=model.nb, sr=model.sr)
    src_pos = p.src_pos
    src_grid = np.arange(model.m_active, dtype=np.float64)
    use_on, use_grain, use_reseed, v = p.use_on, p.use_grain, p.use_reseed, p.vary

    def interp_time_2d(mat: np.ndarray) -> np.ndarray:
        i0 = np.floor(src_pos).astype(np.int32)
        i1 = np.minimum(i0 + 1, mat.shape[1] - 1)
        f = (src_pos - i0).astype(np.float32)
        return (1.0 - f[None, :]) * mat[:, i0] + f[None, :] * mat[:, i1]

    env_t = interp_time_2d(model.env)
    kappa_t = interp_time_2d(model.kappa)
    omega_t = interp_time_2d(model.omega)
    imp_t = p.imp_t

    # ERB 频率轴缩放（物理尺寸 / 音高变换）
    env_tf = _resample_erb_axis(env_t, model.centers_erb, p.freq_scale)
    kappa_tf = np.clip(_resample_erb_axis(kappa_t, model.centers_erb, p.freq_scale), 0.0, 1.0)
    omega_tf = _resample_erb_axis(omega_t, model.centers_erb, p.freq_scale) * float(p.freq_scale)

    # 频谱倾斜 + 多 take 音色 + 学来的「咔」/声身频谱 + 瞬态硬度（仅在冲激与高频处）
    octs = np.log2(np.maximum(model.centers_hz, 20.0) / 1500.0).astype(np.float32)
    env_tf = env_tf * (10.0 ** (p.gain_db / 20.0))[:, None]
    if p.eq is not None:
        env_tf = env_tf * (10.0 ** ((p.eq[-1][:, None] + p.w_atk[None, :] * (p.eq[0] - p.eq[-1])[:, None]) / 20.0))
    if abs(p.hard) > 1e-4:
        hf_wt = np.clip((octs + 0.5) / 2.5, 0.0, 1.0)[:, None]
        hard_db = 4.5 * p.hard * hf_wt * np.maximum(imp_t[None, :], 0.15)
        env_tf = env_tf * (10.0 ** (hard_db / 20.0))

    # 填入带静音填充的规整张量 [NB, M]
    A_full = np.zeros((model.nb, m_base), dtype=np.float32)
    K_full = np.zeros((model.nb, m_base), dtype=np.float32)
    OM_full = np.zeros((model.nb, m_base), dtype=np.float32)
    sl = slice(pad_base, pad_base + out_m_active)
    A_full[:, sl] = env_tf
    K_full[:, sl] = kappa_tf
    OM_full[:, sl] = omega_tf

    # 绝对静音门限（动作外区间 -inf dBFS 数字零）
    floor_amp = float(model.top_amp * (10.0 ** (FLOOR_DB / 20.0)))
    silent = A_full < (floor_amp * 2.0)
    A_full[silent] = 0.0

    pad_samp = pad_base * DEC
    on_samp, on_slope, post_slope = p.on_samp, p.on_slope, p.post_slope
    if use_on:
        pre_mask = _onset_band_masks(bank, m_base, pad_base + p.on_f, on_slope)

    # 颗粒约束的目标与权重（按时间轴取原录音的颗粒起伏；vary 的小幅时长抖动照样加）
    if use_grain:
        assert bank.n_fft == m_base * DEC
        gm = np.stack([np.interp(src_pos, src_grid, model.grain[j]) for j in range(3)])
        g_tgt = np.zeros((3, bank.n_fft))
        g_tgt[:, pad_samp:pad_samp + out_n_samp] = np.repeat(gm, DEC, axis=1)[:, :out_n_samp]
        P = A_full.astype(np.float64) ** 2
        groups = (model.centers_hz < 500.0, (model.centers_hz >= 500.0) & (model.centers_hz < 2800.0), model.centers_hz >= 2800.0)
        kap = np.stack([np.sum(P[s] * K_full[s], axis=0) / (np.sum(P[s], axis=0) + 1e-30) for s in groups])
        g_w = np.repeat((1.0 - kap) * model.grain_w[:, None], DEC, axis=1)  # 没颗粒的段、纯音占比高的段（锣、铃的分音）不加
        if use_on:  # 起音前 30 ms 到后 40 ms 交给起音约束，两头 3 ms 过渡
            t = np.arange(bank.n_fft, dtype=np.float64)
            ramp, hold = 3e-3 * SR, np.zeros(bank.n_fft)
            for o, s_on in zip(on_samp, on_slope):
                a0, a1 = o - ONSET_PRE_MS * 1e-3 * SR * s_on, o + max(ONSET_POST_MS) * 1e-3 * SR * s_on
                hold = np.maximum(hold, np.clip(np.minimum(t - (a0 - ramp), (a1 + ramp) - t) / ramp, 0.0, 1.0))
            g_w *= 1.0 - hold[None, :]

    # 构造三路混合载波：相干连续相位振荡器 + 去 Rayleigh 噪声 + 跨带微冲激
    use_stereo = p.use_stereo
    c_ch = 2 if use_stereo else 1

    # 相干载波：沿时间积分瞬时基带角频率（加上时间伸缩后保持绝对频率不变），段内严格相位连续
    beta = p.init_phi + np.cumsum(OM_full, axis=-1, dtype=np.float64).astype(np.float32)
    coh_carrier = np.exp(1j * beta).astype(np.complex64)

    # 跨带瞬态冲激载波（闭式解析相位，零额外 FFT）
    if p.imp is not None:
        imp_carrier, imp_weight = _impulse_carrier(bank, *p.imp)
    else:
        imp_carrier, imp_weight = None, None

    # 多 take 单份瑞利纹理重抽准备（vary == 0 时完全不走，保持已过耳的单次再合成一比特不变）
    if use_reseed:
        alpha_reseed = (min(1.0, v) * (1.0 - K_full) * (1.0 - p.att_prot[None, :])).astype(np.float32)

        # 拆出「宽带宏观包络 G(m) × 平滑频谱占比 N(b,m)」：只平滑 N² 去掉原录音冻结毛刺，宽带脉冲/甩动丝毫不糊
        P_full = A_full.astype(np.float64) ** 2
        G2 = np.sum(P_full, axis=0)
        N2 = P_full / (G2[None, :] + 1e-30)
        N2_sm = np.empty_like(N2)
        for b_i in range(model.nb):
            win = int(np.clip(round(2.2 * FS_BASE / max(float(bank.bw_hz[b_i]), 50.0)), 7, 96))
            num = uniform_filter1d(N2[b_i] * G2, size=win, mode="nearest")
            den = uniform_filter1d(G2, size=win, mode="nearest") + 1e-30
            N2_sm[b_i] = np.maximum(num / den, 0.0)
        N2_sm /= np.sum(N2_sm, axis=0, keepdims=True) + 1e-30
        A_sm = np.sqrt(N2_sm * G2[None, :]).astype(np.float32)

        # 时域白噪经同一套 ERB 紧框架分析 -> 逐带单位 RMS，天然满足跨带一致性与自然瑞利分布
        w_td = p.rng.standard_normal((c_ch, bank.n_fft)).astype(np.float32)
        if use_grain:  # 重抽用的噪声也带上同一份颗粒起伏（低/中/高各乘自己的细起伏），免得重抽把噼啪抹平
            w_td = sum(z.real * 2.0 ** (model.grain_w[j] * g_tgt[j])[None, :]
                       for j, z in enumerate(_analytic_split(w_td)[0])).astype(np.float32)
        z_g = analyze_subbands(w_td, bank)
        if c_ch == 1 and z_g.ndim == 2:
            z_g = z_g[None, :, :]
        g_rms = np.sqrt(np.mean(z_g.real ** 2 + z_g.imag ** 2, axis=-1, keepdims=True) + 1e-14)
        z_g = (z_g / g_rms).astype(np.complex64)

    # 噪声载波与立体声通道合成
    if p.stereo_mode == 1:
        # 按原录音逐带 ILD / ICC / IPD / 时变声像重构真实立体声场
        ratio_lr = 10.0 ** ((model.ild_db[:, None] + p.pan_full[None, :]) / 10.0)
        gl = np.sqrt(2.0 * ratio_lr / (1.0 + ratio_lr)).astype(np.float32)
        gr = np.sqrt(2.0 / (1.0 + ratio_lr)).astype(np.float32)
        icc = np.clip(model.icc, -0.999, 0.999).astype(np.float32)[:, None]
        sg = np.where(icc < 0, -1.0, 1.0).astype(np.float32)
        c_abs = np.abs(icc)

        n_lr = _generate_bandlimited_unit_noise(p.rng, bank, c_ch=2)
        n_common = n_lr[0] * np.sqrt(0.5 * (1.0 + c_abs))
        n_diff = n_lr[1] * np.sqrt(0.5 * (1.0 - c_abs))
        nz_l = n_common + n_diff
        nz_r = sg * (n_common - n_diff)
        turn = np.exp(-1j * np.arccos(icc)).astype(np.complex64)

        A_ch = np.stack([gl * A_full, gr * A_full], axis=0)
        nz_ch = np.stack([nz_l, nz_r], axis=0)
        coh_ch = np.stack([coh_carrier, coh_carrier * turn], axis=0)
        if use_reseed:
            gc = z_g[0] * np.sqrt(0.5 * (1.0 + c_abs))
            gd = z_g[1] * np.sqrt(0.5 * (1.0 - c_abs))
            zg_ch = np.stack([gc + gd, sg * (gc - gd)], axis=0)
            A_sm_ch = np.stack([gl * A_sm, gr * A_sm], axis=0)
    elif p.stereo_mode == 2:
        # 单声道源输出双声道（轻微宽声像去相关）
        nz_ch = _generate_bandlimited_unit_noise(p.rng, bank, c_ch=2)
        A_ch = np.stack([A_full, A_full], axis=0)
        coh_ch = np.stack([coh_carrier, coh_carrier], axis=0)
        if use_reseed:
            zg_ch = z_g
            A_sm_ch = np.stack([A_sm, A_sm], axis=0)
    else:
        nz_ch = _generate_bandlimited_unit_noise(p.rng, bank, c_ch=1)
        A_ch = A_full[None, :, :]
        coh_ch = coh_carrier[None, :, :]
        if use_reseed:
            zg_ch = z_g
            A_sm_ch = A_sm[None, :, :]

    if use_reseed:
        R_new = np.abs(zg_ch).astype(np.float32)
        R_norm = R_new / np.sqrt(np.mean(R_new * R_new, axis=-1, keepdims=True) + 1e-14)
        A_reseed = A_sm_ch * R_norm
        al = alpha_reseed[None, :, :]
        A_ch = np.sqrt((1.0 - al) * (A_ch ** 2) + al * (A_reseed ** 2)).astype(np.float32)
        # 重抽区域的载波相位与 zg_ch 对齐，减少交替投影冲突
        zg_unit = zg_ch / np.maximum(R_new, 1e-4)
        nz_ch = (1.0 - al) * nz_ch + al * zg_unit
        nz_rms = np.sqrt(np.mean(nz_ch.real ** 2 + nz_ch.imag ** 2, axis=-1, keepdims=True) + 1e-14)
        nz_ch = (nz_ch / nz_rms).astype(np.complex64)

    # 融合随机噪声与跨带解析同相冲激
    if imp_carrier is not None and imp_weight is not None:
        g_imp = imp_weight[None, :, :]
        stoch = np.sqrt(np.maximum(0.0, 1.0 - g_imp * g_imp)) * nz_ch + g_imp * imp_carrier[None, :, :]
    else:
        stoch = nz_ch

    # 融合相干载波与非相干载波
    k_b = K_full[None, :, :]
    y_b = A_ch * (k_b * coh_ch + np.sqrt(np.maximum(0.0, 1.0 - k_b * k_b)) * stoch)
    y_b = y_b.astype(np.complex64)

    # exact 轮交替投影：时域起音约束（前要安静、后按轮廓） + 子带包络对齐（消除重叠子带串扰与包络失真）
    silent_ch = A_ch < (floor_amp * 2.0)
    eps_proj = float(floor_amp * 4.0 + 1e-9)
    for _ in range(int(p.exact)):
        Yb = sfft.fft(y_b, axis=-1) * (bank.n_fft / bank.m_base)
        Ya = (
            Yb[:, bank.bin_b0, bank.bin_u0] * bank.bin_w0[None, :]
            + Yb[:, bank.bin_b1, bank.bin_u1] * bank.bin_w1[None, :]
        )
        if use_on or use_grain:  # 回到时域施加起音/颗粒约束，再变回同一套单边谱（与 synthesize_subbands / analyze_subbands 的换算一致）
            X = Ya.copy()
            X[:, 1:-1] *= 0.5
            xt = sfft.irfft(X, n=bank.n_fft, axis=-1)
            if use_on:
                xt = _onset_shape(xt, on_samp, on_slope, model.onset_prof, post=True, post_slopes=post_slope)
            if use_grain:
                xt = _grain_shape(xt, g_tgt, g_w)
            X = sfft.rfft(xt, axis=-1)
            X[:, 1:-1] *= 2.0
            Ya = X.astype(np.complex64)
        Zb = np.zeros_like(Yb)
        Zb[:, bank.flat_b, bank.flat_u] = Ya[:, bank.flat_k] * bank.flat_w[None, :]
        w_b = sfft.ifft(Zb, axis=-1) * (bank.m_base / bank.n_fft)

        got = np.abs(w_b)
        ratio = ((A_ch + eps_proj) / (got + eps_proj)) ** 0.78
        ratio = np.clip(ratio, 0.25, 4.0).astype(np.float32)
        if use_on:  # 起音前被滤网抹出来的那段，子带包络不可信：只许压不许抬
            ratio = np.where(pre_mask[None], np.minimum(ratio, 1.0), ratio)
        y_b = (w_b * ratio).astype(np.complex64)
        y_b[silent_ch] = 0.0

    # 终轮合成到 48 kHz 实信号（最后再施加一次起音约束，保证输出满足它）并裁回精确有效区间
    y_full = synthesize_subbands(y_b, bank)  # (C, N)
    if use_on and FINAL_MODE != "none":
        y_full = _onset_shape(
            y_full, on_samp, on_slope, model.onset_prof, post=(FINAL_MODE == "both"), post_slopes=post_slope
        )
    return _finish(y_full[:, pad_samp : pad_samp + out_n_samp].copy(), out_n_samp, model.sr, use_stereo)


def render(
    model: ERBModel,
    seed: int = 0,
    dur: float = 1.0,
    time_warp: Optional[Callable[[np.ndarray], np.ndarray]] = None,
    size: float = 1.0,
    pitch: float = 0.0,
    bright: float = 0.0,
    hard: float = 0.0,
    vary: float = 0.0,
    exact: int = 4,
    impulse_strength: float = 1.0,
    pad_ms: float = 40.0,
    stereo_out: Optional[bool] = None,
    transients: bool = True,
    eq_db: Optional[np.ndarray] = None,
) -> np.ndarray:
    """从 ERB 模型合成一条全新 48 kHz take（零原始波形拷贝，CPU 参考实现）。

    参数：
      dur: 时长倍率（如 0.55 拉快成快剪，1.65 拉慢成慢剪，不改音高与材质共鸣；起音段保持原速）
      time_warp: 可选逐帧运动学时间映射函数 u_out∈[0,1] -> u_src∈[0,1]（支持非均匀加速）
      size: 物理物体尺寸（>1 更大更厚重低沉，<1 更小更轻脆；移频，起音段时长按 size 缩放）
      pitch: 音高微调（半音）
      bright: 频谱倾斜（dB/octave，以 1.5 kHz 为支点）
      hard: 瞬态起音硬度（-1..+1，调节微冲激高频锐度）
      vary: 多 take 变化强度（1 = 同物连敲的典型差异：单份瑞利纹理重抽 + 响度守恒的柔和音色/时长/尺寸微抖，不含响度）
      exact: 子带包络交替投影迭代次数（默认 4 轮）
      impulse_strength: 跨带瞬态相位对齐强度（0=纯独立随机相位噪声，1=完整冲激对齐）
      transients: 模型里有起音时，套用起音前的时域约束与起音段保速（False = 第 1 轮盲听的版本）
      （GRAIN=True 且不变时长时，整条声音另加颗粒约束，见 GRAIN 处的说明）
      eq_db: (NB,) 或 (2, NB)「咔」/声身两条频谱增益 dB（render_takes 从几下里学来的）。给了就不再做 vary 的通用随机音色/时长/尺寸抖动，
             只保留细节纹理重抽
    """
    return _execute_numpy(model, plan(
        model, seed=seed, dur=dur, time_warp=time_warp, size=size, pitch=pitch, bright=bright, hard=hard, vary=vary,
        exact=exact, impulse_strength=impulse_strength, pad_ms=pad_ms, stereo_out=stereo_out, transients=transients,
        eq_db=eq_db,
    ))


# ———— 多 take：从同一动作的几下里学「这个东西每次怎么变」（第 3 轮盲听后加）————
# 一下录音里只有「这一下」，没有「这个东西每次敲会怎么变」：笔帽每次按「咔」的亮度能差近两个八度，木鱼几乎不变，
# 快门变的是「咔」而不是机身。所以有几下录音时变化从这几下里学：每下记「咔」与声身各自的频谱形状；
# 新的一下 = 时间骨架与起音轮廓借其中一下（保持毫秒级对齐，不跨 take 逐采样平均轮廓——否则微错位的起音峰会被压扁 7–13 dB），
# 「咔」与声身的频谱按这几下的样本协方差重抽（多元高斯，秩 ≤ K−1），细节纹理再用 vary 的单份瑞利重抽。
# 只动包络，不拼接任何一下的波形。时长不学（量不准，快门这类机械声本来就不该变），交给调用方。


@dataclass
class TakeSet:
    """同一动作几下录音的模型与特征。feats 每行一下：「咔」频谱 NB、声身频谱 NB。"""
    models: list
    feats: np.ndarray


def _take_parts(m: ERBModel) -> tuple[np.ndarray, np.ndarray]:
    """（「咔」段各带功率, 声身各带功率）。没检出起音时以宽带最响的一帧当起音；声身不足 5 ms 时两段视为同一段。"""
    p = m.env.astype(np.float64) ** 2
    o = int(m.onsets[0] // DEC) if m.onsets is not None else int(np.argmax(p.sum(axis=0)))
    a = min(m.m_active, o + int(TAKE_ATK_MS * 1e-3 * FS_BASE))
    pa = p[:, max(0, o - int(1e-3 * FS_BASE)):a].sum(axis=1) + 1e-30
    pb = p[:, a:].sum(axis=1) + 1e-30 if m.m_active - a >= int(5e-3 * FS_BASE) else pa.copy()
    return pa, pb


def _take_feats(m: ERBModel) -> np.ndarray:
    pa, pb = _take_parts(m)
    ref = float(np.sum(_k_band_weights(m.centers_hz) * (pa + pb)))  # 两段对同一个参考：「咔」比声身突出多少也是变化的一部分

    def shape(pw: np.ndarray) -> np.ndarray:
        d = 10.0 * np.log10(pw / ref)
        return gaussian_filter1d(np.maximum(d, d.max() - TAKE_FLOOR_DB), TAKE_SMOOTH_BANDS, mode="nearest")

    return np.concatenate([shape(pa), shape(pb)]).astype(np.float64)


def analyze_takes(takes: list, sr: int = SR) -> TakeSet:
    """同一动作的几下录音（至少 2 下，建议 3 下以上）→ TakeSet。"""
    assert len(takes) >= 2, "至少两下才谈得上「怎么变」"
    models = [analyze(x, sr=sr) for x in takes]
    feats = np.stack([_take_feats(m) for m in models])
    return TakeSet(models=models, feats=feats)


def medoid_take(ts: TakeSet) -> int:
    """最有代表性的一下（频谱特征离平均最近）。只能用一下当来源时选它，别直接取第一下（第 3 轮笔帽就栽在这）。"""
    return int(np.argmin(np.sum((ts.feats - ts.feats.mean(axis=0)) ** 2, axis=1)))


def takes_args(ts: TakeSet, seed: int = 0, base: Optional[int] = None, spread: float = 1.0) -> tuple[ERBModel, dict]:
    """render_takes 的抽样段：返回 (借来的那一下的模型, 传给 render / plan 的参数)。GPU 批量渲染复用这一段。"""
    rng = np.random.default_rng(seed)
    K, nb = len(ts.models), ts.models[0].nb
    mu = ts.feats.mean(axis=0)
    z = np.clip(rng.standard_normal(K), -2.0, 2.0)
    f = mu + spread * (z @ (ts.feats - mu)) / math.sqrt(K - 1)  # 期望 = 这几下的平均，协方差 = 这几下的样本协方差
    b = int(rng.integers(K)) if base is None else int(base) % K
    m, fb = ts.models[b], ts.feats[b]
    eq = np.stack([f[:nb] - fb[:nb], f[nb:2 * nb] - fb[nb:2 * nb]])
    pa, pb = _take_parts(m)
    kp = _k_band_weights(m.centers_hz)
    if m.onsets is None:  # 没有起音就分不出「咔」段：两条按各自能量合成一条
        eq = 10.0 * np.log10((pa * 10.0 ** (eq[0] / 10.0) + pb * 10.0 ** (eq[1] / 10.0)) / (pa + pb))[None, :]
        loud = np.sum(kp * (pa + pb) * 10.0 ** (eq[0] / 10.0)) / np.sum(kp * (pa + pb))
    else:
        loud = np.sum(kp * (pa * 10.0 ** (eq[0] / 10.0) + pb * 10.0 ** (eq[1] / 10.0))) / np.sum(kp * (pa + pb))
    eq = np.clip(eq - 10.0 * math.log10(loud), -12.0, 12.0)  # 保持借来那一下的 K 计权响度：响度交给调用方
    return m, dict(seed=int(rng.integers(1 << 31)), vary=1.0, eq_db=eq.astype(np.float32))


def render_takes(ts: TakeSet, seed: int = 0, base: Optional[int] = None, spread: float = 1.0, **kw) -> np.ndarray:
    """从几下学来的变化里抽新的一下（其余参数同 render）。base = 借哪一下的时间骨架（连敲时轮流给，免得短序列里偏向某一下；
    None = 随机）；spread = 变化幅度倍率，1 = 这几下实际的离散程度。"""
    m, args = takes_args(ts, seed=seed, base=base, spread=spread)
    return render(m, **args, **kw)


def quilt_ambience(
    model: ERBModel,
    target_sec: float,
    seed: int = 0,
    chunk_sec: float = 2.4,
    xfade_sec: float = 0.45,
    vary: float = 0.35,
    exact: int = 3,
) -> np.ndarray:
    """无限无缝环境床织布：用同一份 ERB 纹理模型以独立 seed 渲染若干微变块并等功率交叉淡化。"""
    assert model.m_active * DEC >= int((chunk_sec + xfade_sec) * model.sr * 0.6), "源环境样本太短"
    rng = np.random.default_rng(seed)
    n_target = int(round(target_sec * model.sr))
    n_xfade = int(round(xfade_sec * model.sr))
    c_ch = 2 if model.stereo else 1

    # 先用不同 seed 渲染两版全长新鲜纹理（每次噪声载波完全独立，绝无循环重复感）
    takes = []
    n_takes = max(2, int(math.ceil(target_sec / max(model.n_orig / model.sr, 1.0))) + 1)
    for k in range(n_takes):
        tk = render(model, seed=seed + 1009 * (k + 1), dur=1.0, vary=vary, exact=exact, impulse_strength=0.6)
        if tk.ndim == 1:
            tk = tk[:, None]
        takes.append(tk)

    out = np.zeros((n_target + n_xfade, c_ch), dtype=np.float32)
    pos = 0
    step_idx = 0
    win_in = np.sin(0.5 * np.pi * np.linspace(0.0, 1.0, n_xfade, dtype=np.float32))[:, None]
    win_out = np.cos(0.5 * np.pi * np.linspace(0.0, 1.0, n_xfade, dtype=np.float32))[:, None]

    while pos < n_target:
        src = takes[step_idx % len(takes)]
        src_len = len(src)
        chunk_len = min(int(round(chunk_sec * model.sr * rng.uniform(0.82, 1.15))), src_len - 1)
        start = int(rng.integers(0, max(1, src_len - chunk_len)))
        seg = src[start : start + chunk_len].copy()

        end = min(pos + len(seg), len(out))
        seg = seg[: end - pos]
        if pos == 0:
            out[: len(seg)] = seg
        else:
            ov = min(n_xfade, len(seg))
            out[pos : pos + ov] = out[pos : pos + ov] * win_out[:ov] + seg[:ov] * win_in[:ov]
            if len(seg) > ov:
                out[pos + ov : pos + len(seg)] = seg[ov:]
        pos = pos + len(seg) - n_xfade
        step_idx += 1

    res = out[:n_target]
    return res[:, 0] if not model.stereo else res
