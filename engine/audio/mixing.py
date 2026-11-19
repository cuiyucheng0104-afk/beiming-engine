# -*- coding: utf-8 -*-
"""北冥引擎 · 混音工具：全长时间轴上的摆放与镜头窗、让路包络、按目标响度定电平、SSL 总线粘合压缩与透明母带收口。

时间轴 t 是全长的逐样本秒数（np.arange(n) / SR），返回的增益曲线都是 (n, 1)，直接乘立体声。
接口：
  at(x, t0, n)                              把一段（单声道或立体声）放进长 n 的立体声时间轴 t0 秒处
  window(t, a, b, xf, end)                  镜头窗：a 处等功率切入、b 处切出（a ≤ 0 / b ≥ end 时不切）
  tail_after(t, b, rel)                     b 之后 rel 秒内收掉（切走后的尾巴，不硬断混响）
  duck(t, t0, depth, pre, post)             在 t0 附近让开 depth（pre/post = 让开与恢复的起止偏移秒）
  match_level(st, target, how, t0, t1)      定电平 → (结果, 实测, 增益 dB)；how：mom 最大瞬时 / win 区间积分 / peak 采样峰值。
                                            测量区间里没有可测的信号（静音、低于 −70 LUFS、win 区间短于 0.4 s、mom 区间没有完整的窗）
                                            时报 ValueError，不会算出无穷大的增益把整条总线变成 NaN
  tame_low(mix, band, ceil, aim, f, s, iters)  低频段相对最强频段高于 ceil 时用低搁架压到 aim → (结果, 累计搁架 dB)
  loudness_to(mix, lufs, tp, look, rel, tol, iters)  总增益 + 前视真峰值限制，按限制后的实测响度迭代 → (结果, 总增益 dB, 限制增益曲线)；
                                            返回的总增益就是作用在返回音频上的那一个；iters 轮内没收敛时给 RuntimeWarning（带剩余误差）
  bus_glue_compress(st, *, threshold_db=-18.0, ratio=2.0, attack_ms=25.0, release_ms=160.0, knee_db=6.0, sc_hpf_hz=110.0, makeup_db=0.0, mix=1.0)
                                            SSL G-Bus 风格立体声联动前馈软膝总线压缩（110 Hz 侧链高通防低频抽吸，25 ms 慢起音放过前 20 ms 瞬态）
                                            → (压缩后音频, 逐样本正增益衰减曲线 gr_db)
  master_chain(st, *, target_lufs=-13.3, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=3.2, sub_hpf_hz=28.0, mono_bass_hz=100.0, air_db=0.5)
                                            四步透明母带链（次声波清理 + M/S 低频收紧 → 自适应阈值总线粘合压缩 → 奇次软膝微瞬态驯服与空气搁架
                                            → loudness_to 精确收口）→ (master_st, diagnostics_dict)
"""
import math
import warnings

import numpy as np
from scipy.signal import butter, sosfiltfilt

from .dsp import SR, N, smoothstep, undb, db, place, stereo, hp, shelf, tp_limit, fade, rms, _follow
from .meter import momentary_max, integrated, true_peak, band_energy
from .stream import Loudness


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
    span = f'{t0:.3f}–{(len(st) / SR if t1 is None else t1):.3f} s'
    if how == 'mom':
        cur = momentary_max(st, t0, t1)
    elif how == 'win':
        a, b = N(t0), (N(t1) if t1 is not None else len(st))
        if b - a < N(0.4):
            raise ValueError(f'定电平（win 区间积分）的区间 {span} 短于 0.4 s，测不了积分响度')
        cur = integrated(st[a:b])
    elif how == 'peak':
        pk = float(np.abs(st).max()) if len(st) else 0.0
        if not pk > 0:
            raise ValueError('定电平（peak）的信号全是 0')
        cur = float(db(pk))
    else:
        raise ValueError(f'不认识的定电平方式 {how!r}（mom / win / peak）')
    if how != 'peak' and not cur > -70.0:      # −inf（没有块过绝对门限）或几乎静音：增益会大到没有意义
        raise ValueError(f'定电平（{how}）的区间 {span} 里没有可测的信号（实测 {cur:.1f} LUFS，低于 −70 绝对门限）')
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
    if iters < 1:
        raise ValueError(f'loudness_to：iters 至少是 1（给的是 {iters}）')
    cur = integrated(mix)
    if not cur > -70.0:
        raise ValueError(f'loudness_to：整段混音没有可测的信号（积分响度 {cur}），无法定到 {lufs} LUFS')
    g = lufs - cur
    for k in range(iters):
        lim, gr = tp_limit(mix * undb(g), tp, look=look, rel=rel)
        err = lufs - integrated(lim)
        if abs(err) < tol:
            return lim, g, gr
        if k < iters - 1:
            g += err
    warnings.warn(f'loudness_to：{iters} 轮后仍差 {err:+.2f} LU 没到 {lufs} LUFS（真峰值上限 {tp} dBTP 可能太紧）；'
                  f'返回的是实际作用的总增益 {g:.2f} dB', RuntimeWarning, stacklevel=2)
    return lim, g, gr


def _sidechain_level_db(x2d: np.ndarray, sc_hpf_hz: float = 110.0) -> np.ndarray:
    """SSL 风格立体声联动侧链检测器：内置 110 Hz 高通防滚雷/底鼓低频引发全曲抽吸，4 ms 因果短窗平滑消除过零波纹。"""
    sc = hp(x2d, float(sc_hpf_hz), 2) if (sc_hpf_hz is not None and float(sc_hpf_hz) > 10.0 and len(x2d) > 16) else x2d
    sc_sq = 0.5 * np.mean(sc ** 2, axis=1) + 0.5 * np.max(sc ** 2, axis=1)
    a_det = float(math.exp(-1.0 / (0.004 * SR)))
    det_pow = _follow(np.ascontiguousarray(sc_sq, dtype=float), a_det, a_det)
    return 10.0 * np.log10(det_pow + 1e-24)


def _compute_glue_gr(
    lvl_db: np.ndarray,
    threshold_db: float,
    ratio: float,
    attack_ms: float,
    release_ms: float,
    knee_db: float,
) -> np.ndarray:
    """分贝域软膝增益计算 + 独立慢起音/平滑释放包络跟随（起音时间不随瞬态高度缩短，完整放过前 20 ms 拨弦与拟音瞬态）。"""
    if len(lvl_db) == 0 or float(ratio) <= 1.0:
        return np.zeros(len(lvl_db), dtype=float)
    slope = 1.0 - 1.0 / float(ratio)
    over = lvl_db - float(threshold_db)
    k_db = max(0.0, float(knee_db))
    if k_db > 1e-6:
        gr_raw = np.where(
            over <= -0.5 * k_db,
            0.0,
            np.where(over >= 0.5 * k_db, slope * over, slope * ((over + 0.5 * k_db) ** 2) / (2.0 * k_db)),
        )
    else:
        gr_raw = np.maximum(0.0, slope * over)
    att_s = max(1e-4, float(attack_ms) * 1e-3)
    rel_s = max(1e-3, float(release_ms) * 1e-3)
    a_att = float(math.exp(-1.0 / (att_s * SR)))
    a_rel = float(math.exp(-1.0 / (rel_s * SR)))
    return _follow(np.ascontiguousarray(gr_raw, dtype=float), a_att, a_rel)


def bus_glue_compress(
    st,
    *,
    threshold_db: float = -18.0,
    ratio: float = 2.0,
    attack_ms: float = 25.0,
    release_ms: float = 160.0,
    knee_db: float = 6.0,
    sc_hpf_hz: float = 110.0,
    makeup_db: float = 0.0,
    mix: float = 1.0,
):
    """经典 SSL G-Bus 风格立体声联动前馈软膝总线粘合压缩器：
    · sc_hpf_hz=110 Hz 侧链高通，防止滚雷/灯塔/底鼓超低频触发全片抽吸（Pumping）；
    · attack_ms=25 ms 慢起音完整放过前 20 ms 乐器拨弦与拟音清脆瞬态，release_ms=160 ms 丝滑回弹；
    · 返回 (compressed_st, gr_db)，其中 gr_db 为逐样本正增益衰减量（dB，≥ 0）。"""
    arr = np.asarray(st, dtype=float)
    if len(arr) == 0:
        return arr.copy(), np.zeros(0, dtype=float)
    x2d = arr if arr.ndim == 2 else arr[:, None]
    lvl_db = _sidechain_level_db(x2d, sc_hpf_hz)
    gr_db = _compute_glue_gr(lvl_db, threshold_db, ratio, attack_ms, release_ms, knee_db)
    wet_g = undb(-gr_db + float(makeup_db))
    wet = arr * (wet_g[:, None] if arr.ndim == 2 else wet_g)
    m = float(np.clip(mix, 0.0, 1.0))
    if m >= 1.0 - 1e-9:
        return wet, gr_db
    out = (1.0 - m) * arr + m * wet
    eff_gr = np.maximum(0.0, -db((1.0 - m) + m * undb(-gr_db)))
    return out, eff_gr


def _odd_soft_tame(y: np.ndarray) -> tuple:
    """温和奇次 C² 软膝微瞬态驯服：对 ≤ 72% 峰值的 99.8% 主体信号保持 100% 线性恒等（零谐波染色），
    仅将孤立极端毛刺尖峰圆润收敛约 1.0–1.5 dB，为母带换取干净感知响度净空。"""
    pk = float(np.max(np.abs(y))) if len(y) else 0.0
    r_val = rms(y) if len(y) else 0.0
    if pk <= 1e-7 or 20.0 * math.log10(pk / max(r_val, 1e-12)) < 9.5:
        return y, 0.0
    u = y / pk
    u0 = 0.72
    c_ceil = float(undb(-1.25))
    span = c_ceil - u0
    au = np.abs(u)
    over = np.maximum(0.0, au - u0)
    shaped = np.where(au <= u0, u, np.sign(u) * (u0 + span * np.tanh(over / span)))
    out = shaped * pk
    pk_after = float(np.max(np.abs(out)))
    tamed_db = max(0.0, 20.0 * math.log10(pk / max(pk_after, 1e-12)))
    return out, tamed_db


def _master_chain_core(
    st,
    *,
    target_lufs: float = -13.3,
    max_tp: float = -1.5,
    glue: bool = True,
    glue_ratio: float = 2.0,
    max_gr_db: float = 3.2,
    sub_hpf_hz: float = 28.0,
    mono_bass_hz: float = 100.0,
    air_db: float = 0.5,
):
    y = np.asarray(st, dtype=float).copy()
    if y.ndim == 1:
        y = stereo(y, 0.0)
    n = len(y)
    if n == 0 or not integrated(y) > -70.0:
        loudness_to(y, float(target_lufs), float(max_tp))

    dur = n / float(SR)

    # ① 28 Hz 次声波清理 + <100 Hz 零相位 M/S 侧声道低频收紧（保单声道相位与净空）
    if sub_hpf_hz and float(sub_hpf_hz) > 5.0 and n > 32:
        y = hp(y, float(sub_hpf_hz), 2)
    if mono_bass_hz and float(mono_bass_hz) > 15.0 and n > 64:
        mid = 0.5 * (y[:, 0] + y[:, 1])
        side = 0.5 * (y[:, 0] - y[:, 1])
        sos_mb = butter(2, min(float(mono_bass_hz), SR * 0.45), 'high', fs=SR, output='sos')
        side_tight = sosfiltfilt(sos_mb, side)
        y = np.stack([mid + side_tight, mid - side_tight], axis=1)

    # ② 自适应阈值 SSL 总线粘合压缩（峰值压缩量精准落在 1.5–max_gr_db 甜区，不压扁宏观动态 LRA）
    glue_gr_curve = np.zeros(n, dtype=float)
    glue_thr_db = None
    if glue and float(max_gr_db) > 0.05 and float(glue_ratio) > 1.01 and n > 64:
        lvl_db = _sidechain_level_db(y, 110.0)
        act = lvl_db > -65.0
        if np.any(act):
            cap_gr = float(max_gr_db)
            aim_gr = float(np.clip(0.67 * cap_gr, 1.75, max(1.80, cap_gr - 0.45))) if cap_gr >= 2.2 else (0.72 * cap_gr)
            lo_t = float(np.min(lvl_db[act])) - 18.0
            hi_t = float(np.max(lvl_db[act])) + 8.0
            for _ in range(16):
                mid_t = 0.5 * (lo_t + hi_t)
                gr_try = _compute_glue_gr(lvl_db, mid_t, glue_ratio, 25.0, 160.0, 6.0)
                if float(np.max(gr_try)) > aim_gr:
                    lo_t = mid_t
                else:
                    hi_t = mid_t
            glue_thr_db = 0.5 * (lo_t + hi_t)
            glue_gr_curve = _compute_glue_gr(lvl_db, glue_thr_db, glue_ratio, 25.0, 160.0, 6.0)
            if float(np.max(glue_gr_curve)) > cap_gr:
                glue_gr_curve = np.minimum(glue_gr_curve, cap_gr)
            y = y * undb(-glue_gr_curve)[:, None]

    # ③ 低频平衡护栏 + 可选 10 kHz 丝绒空气光泽 + 奇次软膝瞬态微驯服
    y, low_trim_db = tame_low(y)
    eff_air_db = float(air_db or 0.0)
    if abs(eff_air_db) > 1e-4 and n >= 8192:
        if eff_air_db > 0.0:
            be = band_energy(y)
            eff_air_db = float(min(eff_air_db, max(0.0, -10.8 - be['8k+'])))
        if abs(eff_air_db) > 1e-3:
            y = shelf(y, 10000.0, eff_air_db, 'high', s=0.72)

    y, tamed_db = _odd_soft_tame(y)
    y = fade(y, min(0.006, dur * 0.02), min(0.020, dur * 0.04))

    # ④ loudness_to 精确响度与真峰值收口
    master_st, master_gain_db, lim_gr = loudness_to(y, float(target_lufs), float(max_tp))
    if len(master_st) > 0:
        master_st[0] = 0.0
        master_st[-1] = 0.0

    L_acc = Loudness()
    L_acc.feed(master_st)
    final_lufs = integrated(master_st)
    lra_val = L_acc.lra()
    tp_lin = true_peak(master_st, os=4)
    tp_db = float(db(tp_lin)) if tp_lin > 0.0 else -np.inf
    lim_max_gr = max(0.0, float(-db(float(np.min(lim_gr))))) if len(lim_gr) else 0.0
    glue_max_gr = float(np.max(glue_gr_curve)) if len(glue_gr_curve) else 0.0
    glue_mean_gr = float(np.mean(glue_gr_curve)) if len(glue_gr_curve) else 0.0

    diag = {
        'glueEnabled': bool(glue),
        'glueThresholdDb': round(float(glue_thr_db), 2) if glue_thr_db is not None else None,
        'glueMaxGrDb': round(glue_max_gr, 2),
        'glueMeanGrDb': round(glue_mean_gr, 2),
        'transientTamedDb': round(float(tamed_db), 2),
        'airDb': round(float(eff_air_db), 2),
        'lowTrimDb': round(float(low_trim_db), 2),
        'masterGainDb': round(float(master_gain_db), 2),
        'limiterMaxGrDb': round(lim_max_gr, 2),
        'finalLufs': round(float(final_lufs), 2) if np.isfinite(final_lufs) else None,
        'truePeakDbtp': round(tp_db, 2) if np.isfinite(tp_db) else None,
        'lra': round(float(lra_val), 2),
    }
    bus_env = undb(-glue_gr_curve + float(master_gain_db))
    return master_st, diag, bus_env


def master_chain(
    st,
    *,
    target_lufs: float = -13.3,
    max_tp: float = -1.5,
    glue: bool = True,
    glue_ratio: float = 2.0,
    max_gr_db: float = 3.2,
    sub_hpf_hz: float = 28.0,
    mono_bass_hz: float = 100.0,
    air_db: float = 0.5,
):
    """四步透明母带链（不伤音质与宏观动态 LRA 的前提下粘合乐效并提升感知响度）：
    ① 28 Hz 次声波清理 + <100 Hz 零相位 M/S 低频收紧；
    ② 自适应阈值 bus_glue_compress（峰值衰减稳定在 1.5–max_gr_db 甜区，25 ms 慢起音保瞬态）；
    ③ 奇次软膝瞬态微驯服（削孤立毛刺 1–1.5 dB）+ 可选 +0.5 dB @ 10 kHz 空气光泽；
    ④ loudness_to(y, target_lufs, max_tp) 精确收口。
    返回 (master_st, diagnostics_dict)（含 glueMaxGrDb、lra、finalLufs、masterGainDb）。"""
    master_st, diag, _ = _master_chain_core(
        st,
        target_lufs=target_lufs,
        max_tp=max_tp,
        glue=glue,
        glue_ratio=glue_ratio,
        max_gr_db=max_gr_db,
        sub_hpf_hz=sub_hpf_hz,
        mono_bass_hz=mono_bass_hz,
        air_db=air_db,
    )
    return master_st, diag
