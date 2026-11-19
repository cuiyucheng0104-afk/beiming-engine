# -*- coding: utf-8 -*-
"""北冥引擎 · 导演声学谱与感知 HDR 混音层（Director Sound Score & Perceptual HDR Bus）。

把「画面逐帧真遥测（kinematics.json）+ 导演意图（听觉视角 POA、留白负空间、声部叙事层级、音乐调性耦合）」
编译为清晰、不糊、100% 过机器 QA 门禁的分轨与母带混音。

设计依据：
  · Michel Chion《Audio-Vision》：听觉视角（Point of Audition, POA）独立于摄影机机位决定远闷宽 / 近窄干 / 主观头内空间；
  · Randy Thom《Designing a Movie for Sound》：爆发力来自冲击前 4–12 帧抽走声床的负空间（Negative Space），而非堆满幅电平；
  · Walter Murch《Dense Clarity》：编码声（对白/UI）↔ 拟音 ↔ 具身声（配乐/超低频）分槽，及同一瞬态窗最多保留 2–2.5 个前景焦点；
  · EA DICE Frostbite / Wwise HDR Audio：叙事优先级驱动离线前视（Lookahead）临界频带动态让位（Spectral Ducking），不抽吸低频底盘。

接口：
  POA_PRESETS                         内置听觉视角预设表（fog_wide / intimate_dry / open_sky / subjective_internal）
  screen_scale_to_distance(r, ...)    画面元素占画高/画宽比例 r ∈ (0, 1] → 米制声学距离 d(t)（标量或逐样本曲线）
  depth_gain_db(dist_m, ...)          声学距离 d(t) → 相对近景基准距离的自由场纵深电平偏移（dB）
  harmonic_freq(hz, root='D', ...)    把金属剑鸣、钟声、UI 音吸附到配乐调性主干音级（五度/八度/五声和弦音）
  carve_negative_space(n, specs, ...) 在关键事件冲击帧前挖出负空间静默包络 (n, 1)
  volume_curve(n, points, ...)        推子音量包络曲线 [(t_s, gain_db), ...] → (n, 1) 余弦/线性平滑自动化（Fader Riding）
  sculpt_stem_eq(stems, ...)          分轨互补 EQ 分槽（AMB 让出 <110Hz 与 800Hz 暖中频槽位，Foley/FX 清低中频泥沼，VO 清胸腔轰鸣提咬字，配乐微让位）
  carve_dialogue_pocket(stems, vo, ...) 对白共振峰动态频带挖槽（仅动态衰减配乐 800–4200Hz 共振峰带，100% 守护 <350Hz 大提琴/低音底盘）
  render_shot_poa(st, in_s, out_s, dur, poa='fog_wide', ...)  按镜头 POA 自动施加宽度、滤波、近讲搁架、脉冲混响与切出 L-cut
  HDRMixer(dur, fps=24.0, ...)        离线前视感知 HDR 总线：默认 tame_low + loudness_to（与既有成片链路一致）；显式启用后支持互补 EQ + 对白共振峰让位 + 推子包络 + Murch 聚簇 + 配乐天花板 + SSL 总线粘合母带
"""
import math
import os
import numpy as np
from scipy.ndimage import maximum_filter1d, uniform_filter1d
from scipy.signal import butter, lfilter, resample_poly, sosfilt, sosfiltfilt

from .dsp import (SR, smoothstep, undb, fade, pan_lr, stereo, place, space_place, doppler,
                  width as ms_width, lp, hp, shelf, make_ir, reverb, tp_limit, _follow)
from .meter import integrated, kweight, true_peak
from .mixing import window as shot_window, tail_after, match_level, tame_low, loudness_to, _master_chain_core
from .stream import Loudness


def _zero_phase_bp(x: np.ndarray, lo: float, hi: float, sr: int = SR, order: int = 2) -> np.ndarray:
    """零相位双向带通提取：全频段相位差恒为 0°，从原信号减去 band_sig * depth 时精确衰减目标临界频带而不产生边缘相移鼓包。"""
    nyq = 0.5 * sr
    sos = butter(order, [max(20.0, lo) / nyq, min(hi, sr * 0.46) / nyq], btype='band', output='sos')
    return sosfiltfilt(sos, x, axis=0)


def _hp_sr(x: np.ndarray, f_hz: float, order: int = 2, sr: int = SR) -> np.ndarray:
    sos = butter(order, min(max(10.0, float(f_hz)), float(sr) * 0.45), 'high', fs=float(sr), output='sos')
    return sosfilt(sos, x, axis=0)


def _peq_sr(x: np.ndarray, f_hz: float, g_db: float, q: float = 0.9, sr: int = SR) -> np.ndarray:
    if abs(float(g_db)) < 1e-4:
        return x
    A = 10.0 ** (float(g_db) / 40.0)
    w = 2.0 * math.pi * min(max(15.0, float(f_hz)), float(sr) * 0.45) / float(sr)
    al = math.sin(w) / (2.0 * max(0.1, float(q)))
    b = np.array([1.0 + al * A, -2.0 * math.cos(w), 1.0 - al * A])
    a = np.array([1.0 + al / A, -2.0 * math.cos(w), 1.0 - al / A])
    return lfilter(b / a[0], a / a[0], x, axis=0)


def volume_curve(
    n: int = None,
    points: list = None,
    *,
    dur: float = None,
    sr: int = SR,
    smooth: bool = True,
) -> np.ndarray:
    """生成推子音量自动化包络曲线（Fader Riding）：
    · points: [(t_s, gain_db), ...] 时间-分贝断点表；
    · smooth=True 时在分贝域做分段余弦平滑插值（C¹ 连续、零过冲），smooth=False 时在分贝域线性插值；
    · 返回形状 (n, 1) 的线性增益数组，可直接乘立体声波形。"""
    if n is None:
        if dur is None:
            raise ValueError('volume_curve：n 与 dur 至少需提供一个')
        n_out = max(0, int(round(float(dur) * float(sr))))
    else:
        n_out = max(0, int(n))
    if n_out == 0:
        return np.ones((0, 1), dtype=float)
    if not points:
        return np.ones((n_out, 1), dtype=float)

    pts = sorted(((float(p[0]), float(p[1])) for p in points), key=lambda it: it[0])
    if len(pts) == 1:
        return np.full((n_out, 1), float(undb(pts[0][1])), dtype=float)

    t = (
        np.arange(n_out, dtype=float) / float(sr)
        if dur is None
        else np.linspace(0.0, float(dur), n_out, endpoint=False, dtype=float)
    )
    ts = np.array([p[0] for p in pts], dtype=float)
    gs = np.array([p[1] for p in pts], dtype=float)

    if not smooth:
        db_c = np.interp(t, ts, gs)
    else:
        idx = np.clip(np.searchsorted(ts, t, side='right') - 1, 0, len(ts) - 2)
        t0 = ts[idx]
        t1 = ts[idx + 1]
        u = np.clip((t - t0) / np.maximum(t1 - t0, 1e-9), 0.0, 1.0)
        s = 0.5 * (1.0 - np.cos(np.pi * u))
        db_c = gs[idx] + (gs[idx + 1] - gs[idx]) * s
        db_c = np.where(t <= ts[0], gs[0], db_c)
        db_c = np.where(t >= ts[-1], gs[-1], db_c)
    return undb(db_c)[:, None]


def _preserve_silent_gaps(
    arr: np.ndarray,
    orig_abs: np.ndarray,
    *,
    min_gap_s: float = 0.020,
    taper_s: float = 0.004,
    hold_tail_s: float = 0.0,
    sr: int = SR,
) -> np.ndarray:
    """在台词句间静音隙（连续为 0 达 min_gap_s 以上）严格保持 0.0，并在进入静音隙前做微余弦阻尼消除滤波尾音台阶。"""
    n = len(arr)
    if n == 0 or not np.any(orig_abs == 0.0):
        return arr
    min_gap = max(8, int(round(float(min_gap_s) * float(sr))))
    taper_n = max(4, int(round(float(taper_s) * float(sr))))
    hold_n = max(0, int(round(float(hold_tail_s) * float(sr))))
    is_zero = (orig_abs == 0.0).astype(np.int8)
    edges = np.flatnonzero(np.diff(is_zero, prepend=0, append=0) != 0)
    if len(edges) == 0:
        return arr
    gate = np.ones(n, dtype=float)
    for s0, e0 in zip(edges[0::2], edges[1::2]):
        if e0 - s0 < min_gap:
            continue
        eff_s0 = min(e0, s0 + hold_n) if s0 > 0 else 0
        if eff_s0 < e0:
            gate[eff_s0:e0] = 0.0
            if eff_s0 > 0:
                k = min(taper_n, eff_s0)
                w = np.cos(0.5 * np.pi * np.linspace(0.0, 1.0, k, dtype=float)) ** 2
                gate[eff_s0 - k:eff_s0] = np.minimum(gate[eff_s0 - k:eff_s0], w)
    return arr * (gate[:, None] if arr.ndim == 2 else gate)


def sculpt_stem_eq(
    stems: dict,
    *,
    amb_warmth_cut_db: float = -3.0,
    fx_mud_cut_db: float = -2.2,
    music_presence_dip_db: float = -1.0,
    sr: int = SR,
) -> dict:
    """分轨互补 EQ 分槽（Complementary Pocket EQ）：用频谱镶嵌替代粗暴降音量，让对白与音效长在音乐里面：
    · amb: 110 Hz 高通清底 + 800 Hz (Q=0.75) 暖中频让位凹槽（把 450–1800 Hz 旋律和声核心区让给配乐）；
    · foley: 130 Hz 高通 + 320 Hz (-2.0 dB) 去低中频闷泥；
    · fx: 30 Hz 次声波清理（完整保留 55–140 Hz 滚雷/灯塔胸腔重音）+ 280 Hz 低中频去泥沼；
    · vo / dialogue: 85 Hz 二阶高通（清喷麦超低频）+ 240 Hz (-1.8 dB, Q=1.1) 清低中频轰鸣
      + 3.0 kHz (+1.2 dB, Q=0.9) 提辅音清晰度 + 7.2 kHz (-1.0 dB, Q=2.0) 柔化齿音，并严格保留句间静音 0.0；
    · music: 保留 100% 饱满低音与中频基音，仅在 3.2 kHz 拟音咬合区微让位 music_presence_dip_db。"""
    out = {}
    pad_n = max(8, int(round(0.010 * float(sr))))
    taper_n = max(4, int(round(0.005 * float(sr))))
    for k, v in (stems or {}).items():
        arr = np.asarray(v, dtype=float).copy()
        if len(arr) <= 32 or float(np.max(np.abs(arr))) <= 1e-8:
            out[k] = arr
            continue
        orig_abs = np.max(np.abs(arr), axis=1) if arr.ndim == 2 else np.abs(arr)
        has_zero_gaps = bool(np.any(orig_abs == 0.0))
        kl = str(k).lower()
        if kl in ('amb', 'ambience'):
            arr = _hp_sr(arr, 110.0, 2, sr)
            if abs(float(amb_warmth_cut_db)) > 1e-4:
                arr = _peq_sr(arr, 800.0, float(amb_warmth_cut_db), q=0.75, sr=sr)
        elif kl == 'foley':
            arr = _hp_sr(arr, 130.0, 2, sr)
            foley_cut = -2.0 if abs(float(fx_mud_cut_db) - (-2.2)) < 1e-6 else float(fx_mud_cut_db) * (2.0 / 2.2)
            if abs(foley_cut) > 1e-4:
                arr = _peq_sr(arr, 320.0, foley_cut, q=0.90, sr=sr)
        elif kl in ('fx', 'sfx'):
            arr = _hp_sr(arr, 30.0, 2, sr)
            if abs(float(fx_mud_cut_db)) > 1e-4:
                arr = _peq_sr(arr, 280.0, float(fx_mud_cut_db), q=0.90, sr=sr)
        elif kl in ('vo', 'dialogue', 'voice'):
            arr = _hp_sr(arr, 85.0, 2, sr)
            arr = _peq_sr(arr, 240.0, -1.8, q=1.1, sr=sr)
            arr = _peq_sr(arr, 3000.0, 1.2, q=0.9, sr=sr)
            arr = _peq_sr(arr, 7200.0, -1.0, q=2.0, sr=sr)
            if has_zero_gaps:
                arr = _preserve_silent_gaps(arr, orig_abs, min_gap_s=0.020, taper_s=0.004, sr=sr)
        elif kl in ('music', 'bgm'):
            if abs(float(music_presence_dip_db)) > 1e-4:
                arr = _peq_sr(arr, 3200.0, float(music_presence_dip_db), q=0.85, sr=sr)
        if has_zero_gaps and kl in ('fx', 'sfx', 'foley', 'ui'):
            act = maximum_filter1d((orig_abs > 0.0).astype(float), size=2 * pad_n + 1)
            gate = uniform_filter1d(act, size=taper_n)
            gate = np.where(act == 0.0, 0.0, gate)
            arr = arr * (gate[:, None] if arr.ndim == 2 else gate)
        out[k] = arr
    return out


def _speech_envelope(
    vo: np.ndarray,
    n_out: int,
    *,
    spans: list = None,
    lookahead_ms: float = 15.0,
    attack_ms: float = 20.0,
    release_ms: float = 180.0,
    sr: int = SR,
) -> np.ndarray:
    """提取平滑前视对白包络（15 ms 前视、20 ms 起音、180 ms 释放，可结合 voice.json 的 spans 句段区间）。"""
    if n_out <= 0:
        return np.zeros(0, dtype=float)
    sr_f = float(sr)
    vo_env = np.zeros(n_out, dtype=float)
    if vo is not None and len(vo) > 0:
        vo_arr = np.asarray(vo, dtype=float)
        mono = vo_arr.mean(axis=1) if vo_arr.ndim == 2 else vo_arr.reshape(-1)
        if len(mono) < n_out:
            mono = np.pad(mono, (0, n_out - len(mono)))
        elif len(mono) > n_out:
            mono = mono[:n_out]
        w_rms = max(8, int(round(0.015 * sr_f)))
        rms_s = np.sqrt(np.maximum(0.0, uniform_filter1d(mono * mono, size=w_rms)) + 1e-24)
        pk_rms = float(np.max(rms_s))
        if pk_rms > 1e-5:
            gate_lin = 10.0 ** (-42.0 / 20.0)
            act = rms_s > min(gate_lin, pk_rms * 0.15)
            ref_rms = float(np.percentile(rms_s[act], 75)) if np.any(act) else pk_rms
            rel_db = 20.0 * np.log10(rms_s / max(ref_rms, 1e-12) + 1e-12)
            floor_lin = min(gate_lin * 0.5, pk_rms * 0.06)
            drive = np.where(rms_s > floor_lin, np.clip((rel_db + 20.0) / 17.0, 0.0, 1.0), 0.0)
            look_n = max(1, int(round(max(0.0, float(lookahead_ms)) * 1e-3 * sr_f)))
            win_la = look_n + 1
            drive_la = maximum_filter1d(np.pad(drive, (0, look_n)), size=win_la, origin=-(win_la // 2))[:n_out]
            a_att = float(math.exp(-1.0 / (max(1e-4, float(attack_ms) * 1e-3) * sr_f)))
            a_rel = float(math.exp(-1.0 / (max(1e-3, float(release_ms) * 1e-3) * sr_f)))
            vo_env = _follow(np.ascontiguousarray(drive_la, dtype=float), a_att, a_rel)

    if spans:
        t = np.arange(n_out, dtype=float) / sr_f
        span_env = np.zeros(n_out, dtype=float)
        pre_s = max(0.005, (float(lookahead_ms) + float(attack_ms)) * 1e-3)
        rel_s = max(0.020, float(release_ms) * 1e-3)
        for item in spans:
            t0_s, t1_s = float(item[0]), float(item[1])
            if t1_s > t0_s:
                up = smoothstep(t0_s - pre_s, t0_s + 0.005, t)
                dn = 1.0 - smoothstep(t1_s, t1_s + rel_s, t)
                span_env = np.maximum(span_env, up * dn)
        if float(np.max(vo_env)) > 1e-4:
            vo_env = np.maximum(vo_env, 0.85 * span_env)
        else:
            vo_env = span_env

    return np.clip(vo_env, 0.0, 1.0)


def carve_dialogue_pocket(
    stems: dict,
    vo: np.ndarray,
    *,
    spans: list = None,
    formant_duck_db: float = 4.2,
    amb_duck_db: float = 2.5,
    fx_duck_db: float = 1.8,
    sr: int = SR,
) -> dict:
    """对白共振峰动态频带挖槽（Formant-Band Dynamic Pocket Ducking）：
    严禁宽带死压配乐！仅在对白有声期间对伴奏做零相位临界频带动态凹槽：
      · music: < 350 Hz 大提琴/低音温暖底盘 100% 零衰减（0.0 dB），> 6500 Hz 泛音空气层衰减 ≤ 0.5 dB，
               仅在 800–4200 Hz 人声共振峰/辅音清晰度核心带按包络动态让位 formant_duck_db（默认 ~4.2 dB）；
      · amb: 600–4500 Hz 频带温和让位 amb_duck_db（默认 ~2.5 dB）；
      · foley / fx: 1.2–4.2 kHz 临场齿擦带轻柔让位 fx_duck_db（默认 ~1.8 dB），既不踩台词字头又完整保留低频冲击体感。"""
    if not stems:
        return {}
    ref_n = len(vo) if (vo is not None and len(vo) > 0) else max((len(v) for v in stems.values()), default=0)
    base_env = _speech_envelope(vo, ref_n, spans=spans, sr=sr)
    if ref_n <= 64 or float(np.max(base_env)) <= 1e-4:
        return {k: np.asarray(v, dtype=float).copy() for k, v in stems.items()}

    out = {}
    pad_n = max(8, int(round(0.010 * float(sr))))
    taper_n = max(4, int(round(0.005 * float(sr))))
    for k, v in stems.items():
        arr = np.asarray(v, dtype=float).copy()
        n_s = len(arr)
        if n_s <= 64 or float(np.max(np.abs(arr))) <= 1e-8:
            out[k] = arr
            continue
        env = base_env if n_s == ref_n else (
            base_env[:n_s] if n_s < ref_n else np.pad(base_env, (0, n_s - ref_n))
        )
        kl = str(k).lower()
        if kl in ('music', 'bgm') and float(formant_duck_db) > 1e-4:
            band = _zero_phase_bp(arr, 800.0, 4200.0, sr=sr, order=4)
            depth = 1.0 - undb(-float(formant_duck_db) * env)
            arr = arr - band * (depth[:, None] if arr.ndim == 2 else depth)
        elif kl in ('amb', 'ambience') and float(amb_duck_db) > 1e-4:
            band = _zero_phase_bp(arr, 600.0, 4500.0, sr=sr, order=3)
            depth = 1.0 - undb(-float(amb_duck_db) * env)
            arr = arr - band * (depth[:, None] if arr.ndim == 2 else depth)
        elif kl in ('foley', 'fx', 'sfx') and float(fx_duck_db) > 1e-4:
            orig_abs = np.max(np.abs(arr), axis=1) if arr.ndim == 2 else np.abs(arr)
            has_zero_gaps = bool(np.any(orig_abs == 0.0))
            band = _zero_phase_bp(arr, 1200.0, 4200.0, sr=sr, order=3)
            depth = 1.0 - undb(-float(fx_duck_db) * env)
            arr = arr - band * (depth[:, None] if arr.ndim == 2 else depth)
            if has_zero_gaps:
                act = maximum_filter1d((orig_abs > 0.0).astype(float), size=2 * pad_n + 1)
                gate = uniform_filter1d(act, size=taper_n)
                gate = np.where(act == 0.0, 0.0, gate)
                arr = arr * (gate[:, None] if arr.ndim == 2 else gate)
        out[k] = arr
    return out


def _speech_gated_lufs(st: np.ndarray, sr: int = SR, gate_dbfs: float = -42.0) -> tuple:
    """测量对白有声窗（50 ms 窗 RMS > gate_dbfs，剔除句间静音停顿）的 BS.1770 响度。"""
    arr = np.asarray(st, dtype=float)
    if arr.ndim == 1:
        arr = stereo(arr, 0.0)
    win_n = max(64, int(round(0.050 * float(sr))))
    n_wins = len(arr) // win_n
    if n_wins == 0:
        if len(arr) == 0 or float(np.max(np.abs(arr))) <= 1e-7:
            return -np.inf, np.zeros(0, dtype=bool)
        kw = kweight(arr)
        lufs = -0.691 + 10.0 * math.log10(float(np.sum(kw * kw) / max(1, len(arr))) + 1e-24)
        return float(lufs), np.ones(1, dtype=bool)

    wins = arr[:n_wins * win_n].reshape(n_wins, win_n, 2)
    win_rms = np.sqrt(np.mean(wins * wins, axis=(1, 2)) + 1e-24)
    thr = 10.0 ** (float(gate_dbfs) / 20.0)
    act = win_rms > thr
    if not np.any(act):
        pk_w = float(np.max(win_rms))
        if pk_w <= 1e-5:
            return -np.inf, act
        act = win_rms > (pk_w * 0.12)
    active_concat = wins[act].reshape(-1, 2)
    if len(active_concat) >= int(round(0.40 * float(sr))):
        lufs = integrated(active_concat)
    else:
        lufs = -np.inf
    if not np.isfinite(lufs) or lufs <= -70.0:
        kw = kweight(active_concat)
        lufs = -0.691 + 10.0 * math.log10(float(np.sum(kw * kw) / max(1, len(active_concat))) + 1e-24)
    return float(lufs), act

# 与 engine/audio/qa.py _MASK_BANDS 完全同构的 6 个听觉临界频带
CRITICAL_BANDS = (
    ('80-250', 80.0, 250.0),
    ('250-600', 250.0, 600.0),
    ('600-1.5k', 600.0, 1500.0),
    ('1.5k-3.5k', 1500.0, 3500.0),
    ('3.5k-7.5k', 3500.0, 7500.0),
    ('7.5k-14k', 7500.0, 14000.0),
)

POA_PRESETS = {
    'fog_wide': {
        'width': 1.05, 'lp_hz': 3400.0, 'proximity_db': 0.0, 'dist_m': 6.5,
        'ir': {'rt': 2.6, 'pre': 0.045, 'tone': (0.85, 1.0, 0.68, 0.38), 'seed': 41},
        'wet': 0.20, 'l_cut_s': 0.28,
    },
    'intimate_dry': {
        'width': 0.52, 'lp_hz': 18500.0, 'proximity_db': 2.8, 'dist_m': 0.75,
        'ir': {'rt': 0.35, 'pre': 0.004, 'tone': (1.0, 1.0, 0.82, 0.60), 'seed': 42},
        'wet': 0.08, 'l_cut_s': 0.05,
    },
    'open_sky': {
        'width': 1.35, 'lp_hz': 19500.0, 'proximity_db': 0.0, 'dist_m': 3.2,
        'ir': {'rt': 4.0, 'pre': 0.060, 'tone': (0.85, 1.0, 0.72, 0.45), 'seed': 43},
        'wet': 0.26, 'l_cut_s': 0.40,
    },
    'subjective_internal': {
        'width': 0.12, 'lp_hz': 20000.0, 'proximity_db': 0.0, 'dist_m': 0.5,
        'ir': None, 'wet': 0.0, 'l_cut_s': 0.0,
    },
}

_NOTE_SEMI = {
    'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3, 'E': 4, 'F': 5,
    'F#': 6, 'GB': 6, 'G': 7, 'G#': 8, 'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11,
}
_SCALES = {
    'fifth': (0, 7),
    'triad': (0, 4, 7),
    'minor': (0, 3, 7, 10),
    'pentatonic': (0, 2, 4, 7, 9),
    'add9': (0, 2, 4, 7),
}


def _root_midi(root) -> float:
    if isinstance(root, (int, float)):
        hz = float(root)
        return 69.0 + 12.0 * math.log2(max(hz, 16.0) / 440.0)
    s = str(root or 'D').strip().upper()
    name = s[:2] if len(s) >= 2 and s[1] in ('#', 'B') else s[:1]
    rest = s[len(name):]
    octv = int(rest) if rest.lstrip('-').isdigit() else 4
    semi = _NOTE_SEMI.get(name, 2)
    return float((octv + 1) * 12 + semi)


def harmonic_freq(target_hz: float, root='D', scale: str = 'pentatonic') -> float:
    """将剑鸣、铜钟或 UI 提示音的标称频率吸附到当前配乐调性的最近协和音级（误差通常 ≤ 1.5 半音），实现声画/乐效调性同源。"""
    hz = float(target_hz)
    if hz <= 20.0:
        return hz
    r_pc = _root_midi(root) % 12.0
    degs = _SCALES.get(scale, _SCALES['pentatonic'])
    m_in = 69.0 + 12.0 * math.log2(hz / 440.0)
    best_m, best_dist = m_in, 999.0
    base_oct = int(math.floor((m_in - r_pc) / 12.0))
    for k in range(base_oct - 1, base_oct + 3):
        for d in degs:
            cand = k * 12.0 + r_pc + float(d)
            dist = abs(cand - m_in)
            if dist < best_dist:
                best_dist, best_m = dist, cand
    return round(440.0 * (2.0 ** ((best_m - 69.0) / 12.0)), 3)


def carve_negative_space(n: int, specs: list, *, fps: float = 24.0, sr: int = SR) -> np.ndarray:
    """按导演焦点事件表在冲击帧前挖出负空间静默曲线 (n, 1)：
    每项 spec = {'frame': 结果帧(或 't': 秒), 'leadFrames': 6, 'holdFrames': 1, 'dipDb': -14.0, 'recoverSec': 0.55}。"""
    t = np.arange(n, dtype=float) / float(sr)
    env = np.ones(n, dtype=float)
    fd = 1.0 / float(fps)
    for sp in (specs or []):
        t_hit = float(sp['t']) if 't' in sp and sp['t'] is not None else float(sp['frame']) * fd
        lead_s = max(0.02, float(sp.get('leadFrames', 6.0)) * fd)
        hold_s = max(0.0, float(sp.get('holdFrames', 1.0)) * fd)
        rec_s = max(0.06, float(sp.get('recoverSec', 0.55)))
        dip_db = float(sp.get('dipDb', -14.0))
        floor_lin = 0.0 if dip_db <= -60.0 else float(undb(dip_db))
        # 从 t_hit - lead_s 平滑抽空，在 [t_hit - 1.5帧, t_hit + hold_s] 落到谷底，冲击爆发后平滑回升
        down = smoothstep(t_hit - lead_s, t_hit - min(lead_s * 0.25, 1.5 * fd), t)
        up = smoothstep(t_hit + hold_s, t_hit + hold_s + rec_s, t)
        carve = 1.0 - (1.0 - floor_lin) * down * (1.0 - up)
        env = np.minimum(env, carve)
    return env[:, None]


def render_shot_poa(st: np.ndarray, in_s: float, out_s: float, dur: float, poa='fog_wide', *, xf: float = 0.025, sr: int = SR) -> np.ndarray:
    """把一段长度覆盖本镜头的声床或环境元素按听觉视角 POA 处理并放置到全片时间轴 (N(dur), 2)。"""
    cfg = POA_PRESETS.get(poa, POA_PRESETS['fog_wide']) if isinstance(poa, str) else dict(poa)
    n_tot = int(round(dur * sr))
    t_tot = np.arange(n_tot, dtype=float) / float(sr)
    pad = max(0.15, float(cfg.get('l_cut_s', 0.2)) + 0.05)
    seg_t0 = max(0.0, float(in_s) - 0.12)
    seg_t1 = min(float(dur), float(out_s) + pad)
    seg_n = max(16, int(round((seg_t1 - seg_t0) * sr)))

    y = np.asarray(st, dtype=float)
    if y.ndim == 1:
        y = stereo(y, 0.0)
    if len(y) > seg_n:
        y = y[:seg_n].copy()
    elif len(y) < seg_n:
        y = np.vstack([y, np.zeros((seg_n - len(y), 2))])

    if cfg.get('lp_hz') and float(cfg['lp_hz']) < 19000.0:
        y = lp(y, float(cfg['lp_hz']), 2)
    if cfg.get('proximity_db') and abs(float(cfg['proximity_db'])) > 0.1:
        y = shelf(y, 200.0, float(cfg['proximity_db']), 'low')
    if cfg.get('ir') and float(cfg.get('wet', 0.0)) > 0.0:
        ir_cfg = dict(cfg['ir'])
        ir = make_ir(**ir_cfg)
        y = reverb(y, ir, wet=float(cfg['wet']), dry=1.0)
    if cfg.get('width') is not None:
        y = ms_width(y, float(cfg['width']))
    y = fade(y, min(0.02, len(y) / sr * 0.1), min(0.08, len(y) / sr * 0.2))

    full = np.zeros((n_tot, 2), dtype=float)
    place(full, y, seg_t0, 1.0)
    w_main = shot_window(t_tot, float(in_s), float(out_s), xf=xf, end=dur)
    l_cut = float(cfg.get('l_cut_s', 0.0))
    if l_cut > 0.01 and float(out_s) < float(dur) - 1e-3:
        in_gate = shot_window(t_tot, float(in_s), float(dur) + 1.0, xf=xf, end=dur)
        post_tail = tail_after(t_tot, float(out_s), rel=l_cut)
        env = np.maximum(w_main, in_gate * post_tail * 0.55)
    else:
        env = w_main
    return full * env


ROLE_DEFAULTS = {
    'hero': {'priority': 95.0, 'target_lufs': -15.5, 'bus': 'fx', 'duck_db': 8.5},
    'ui': {'priority': 88.0, 'target_lufs': -23.0, 'bus': 'ui', 'duck_db': 7.5},
    'accent': {'priority': 80.0, 'target_lufs': -19.5, 'bus': 'fx', 'duck_db': 5.0},
    'subtle_ui': {'priority': 76.0, 'target_lufs': -31.5, 'bus': 'ui', 'duck_db': 2.0},
    'support': {'priority': 70.0, 'target_lufs': -21.5, 'bus': 'fx', 'duck_db': 4.5},
    'foley': {'priority': 58.0, 'target_lufs': -22.5, 'bus': 'foley', 'duck_db': 3.0},
    'texture': {'priority': 42.0, 'target_lufs': -28.5, 'bus': 'fx', 'duck_db': 0.0},
}

# 按影片世界观与写实调性定义「环境音 (amb) + 硬效/设计音 (fx) + 生命体拟音 (foley)」三层干线配比与选材声族域
WORLD_PROFILES = {
    'realistic': {
        'label': '写实实景 / 历史武侠',
        'stems_lufs': {'amb': -31.0, 'fx': -17.5, 'foley': -21.0},
        'foley_enabled': True,
        'preferred_cats': ['AMB', 'WIND', 'WATR', 'FIRE', 'CLOTH', 'FEET', 'FOLY', 'WOOD', 'METL', 'ROCK', 'WEAP'],
        'forbidden_cats': ['TOON', 'SCI', 'UI'],
    },
    'semi_realistic': {
        'label': '半写实角色 / 定格积木 / 风格化叙事',
        'stems_lufs': {'amb': -33.0, 'fx': -17.0, 'foley': -22.5},
        'foley_enabled': True,
        'preferred_cats': ['AMB', 'MECH', 'PLAS', 'WOOD', 'TOY', 'CLOTH', 'FEET', 'SWSH', 'BELL'],
        'forbidden_cats': ['GORE'],
    },
    'hitech': {
        'label': '高科技界面 / 工程拆解 / 抽象数据',
        'stems_lufs': {'amb': -38.0, 'fx': -16.5, 'foley': None},
        'foley_enabled': False,
        'preferred_cats': ['UI', 'BEEP', 'LASR', 'MECH', 'CLOCK', 'EQUIP', 'CMPT'],
        'forbidden_cats': ['TOON', 'GORE', 'CRWD', 'ANML'],
    },
    'scifi': {
        'label': '科幻世界 / 未来机甲与力场',
        'stems_lufs': {'amb': -30.5, 'fx': -16.0, 'foley': -23.5},
        'foley_enabled': True,
        'preferred_cats': ['SCI', 'LASR', 'ELEC', 'ROBT', 'MOTR', 'MECH', 'AIR', 'UI', 'DSGN'],
        'forbidden_cats': ['TOON'],
    },
    'cartoon': {
        'label': '卡通弹性夸张 / 幽默动画',
        'stems_lufs': {'amb': -35.0, 'fx': -15.5, 'foley': -22.0},
        'foley_enabled': True,
        'preferred_cats': ['TOON', 'TOY', 'WHST', 'BELL', 'SWSH', 'BEEP', 'PLAS'],
        'forbidden_cats': ['GORE'],
    },
    'poetic': {
        'label': '东方水墨写意 / 留白意象',
        'stems_lufs': {'amb': -32.0, 'fx': -18.5, 'foley': -23.0},
        'foley_enabled': True,
        'preferred_cats': ['WIND', 'WATR', 'BELL', 'MUSC', 'PAPR', 'CLOTH', 'WING', 'SWSH'],
        'forbidden_cats': ['TOON', 'SCI', 'MOTR'],
    },
}


def fit_to_span(wave: np.ndarray, span_dur: float, *, anchor: float = 0.0,
                fade_in_s: float = 0.003, fade_out_s: float = None, sr: int = SR) -> tuple:
    """音效时值服从画面元素生命周期：
    当原始素材在冲击锚点 anchor 之后的长度超过画面动作持续时长 span_dur 时，
    按 anchor + span_dur 裁切尾部，并施加余弦阻尼淡出（fade_out_s 默认取 span_dur 的 25%，夹在 15–120 ms），
    防止长素材拖过画面动作结束帧或硬切出咔嗒声。返回 (裁切淡出后的波形, 新锚点秒)。"""
    arr = np.asarray(wave, dtype=float)
    if len(arr) == 0:
        return arr.copy(), 0.0
    span_s = max(0.015, float(span_dur))
    anc_s = max(0.0, float(anchor))
    max_len = max(16, int(round((anc_s + span_s) * sr)))
    if len(arr) <= max_len:
        fo = min(0.020, len(arr) / sr * 0.20) if fade_out_s is None else float(fade_out_s)
        return fade(arr.copy(), min(fade_in_s, len(arr) / sr * 0.15), fo), min(anc_s, len(arr) / sr)
    trimmed = arr[:max_len].copy()
    fo = float(np.clip(span_s * 0.26, 0.015, 0.120)) if fade_out_s is None else float(fade_out_s)
    fo = min(fo, max(0.005, (len(trimmed) / sr - anc_s) * 0.85)) if len(trimmed) / sr > anc_s else min(fo, len(trimmed) / sr * 0.4)
    trimmed = fade(trimmed, min(fade_in_s, len(trimmed) / sr * 0.15), fo)
    return trimmed, anc_s


def pan_trajectory(dur: float, keyframes: list, *, dist_keyframes: list = None,
                   cap: float = None, sr: int = SR) -> tuple:
    """生成跟随画面运动物体的连续 48 kHz 声像曲线 pan(t) 与可选距离曲线 dist(t)：
    · keyframes: [(时刻秒或归一化 0..1, pan 值 -1..1), ...]，例如蜜蜂从左飞到右传 [(0.0, -0.8), (dur, +0.8)]；
    · cap: 按镜头景别收束上限（如 close=0.25, wide=0.60, full=0.80）。
    返回 (pan_curve, dist_curve_or_None)。"""
    n = max(1, int(round(float(dur) * sr)))
    t_out = np.arange(n, dtype=float) / float(sr)

    def _interp_kf(kfs, lo, hi, default_val):
        if not kfs:
            return np.full(n, default_val, dtype=float)
        pts = sorted((float(t), float(v)) for t, v in kfs)
        # 若最大时间 ≤ 1.0 且 dur > 1.05，允许按 [0..1] 归一化进度书写关键帧
        scale_t = float(dur) if (pts[-1][0] <= 1.0 and float(dur) > 1.05 and pts[0][0] >= 0.0) else 1.0
        ts = np.array([p[0] * scale_t for p in pts], dtype=float)
        vs = np.array([p[1] for p in pts], dtype=float)
        # 用分段 smoothstep 让进出端更圆润自然，消除折线速度突变
        if len(ts) == 1:
            curve = np.full(n, vs[0], dtype=float)
        else:
            curve = np.interp(t_out, ts, vs)
        return np.clip(curve, lo, hi)

    lim = 1.0 if cap is None else float(cap)
    p_curve = _interp_kf(keyframes, -lim, lim, 0.0)
    d_curve = _interp_kf(dist_keyframes, 0.25, 50.0, 2.0) if dist_keyframes else None
    return p_curve, d_curve


def _extend_nonperiodic(x: np.ndarray, n_target: int, r) -> np.ndarray:
    """用带随机起点偏移与 12 ms 等功率交叉淡化的纹理拼接替代 np.tile，消除死循环周期嗡声。"""
    src = np.asarray(x, dtype=float)
    if len(src) >= n_target:
        return src[:n_target].copy()
    if len(src) < 32:
        return np.resize(src, n_target)
    xf = min(max(8, int(round(0.012 * SR))), len(src) // 3)
    ang = np.linspace(0.0, np.pi * 0.5, xf)
    out = src.copy()
    while len(out) < n_target:
        max_off = max(1, len(src) // 3)
        off = int(r.integers(0, max_off)) if len(src) - max_off > xf * 2 else 0
        chunk = src[off:]
        if xf > 0 and len(chunk) > xf and len(out) > xf:
            seam = out[-xf:] * np.cos(ang) + chunk[:xf] * np.sin(ang)
            out = np.concatenate([out[:-xf], seam, chunk[xf:]])
        else:
            out = np.concatenate([out, chunk])
    return out[:n_target]


SHOT_PAN_CAP = {
    'macro': 0.12,
    'close': 0.25,
    'medium': 0.35,
    'wide': 0.60,
    'full': 0.80,
}


def screen_scale_to_distance(
    screen_ratio,
    *,
    ref_ratio: float = 0.45,
    ref_dist_m: float = 1.8,
    min_dist_m: float = 0.55,
    max_dist_m: float = 28.0,
    exponent: float = 0.95,
):
    """将画面元素占画面高度/宽度的视觉比例 r ∈ (0, 1] 换算为米制声学距离 d(t)：
    · 默认以近景侧跟 r=0.45 对应基准距离 ref_dist_m=1.8 m；
    · 例如大远景 r=1/12 → d≈8.93 m，摇臂拉远 r=1/7 → d≈5.35 m，特写 r=0.85 → d≈0.98 m；
    · 支持标量（返回 float）或一维序列/数组（返回同长度 float64 ndarray）。"""
    r_ref = max(1e-4, float(ref_ratio))
    d_ref = max(0.1, float(ref_dist_m))
    d_min = max(0.1, float(min_dist_m))
    d_max = max(d_min, float(max_dist_m))
    exp_v = max(0.1, float(exponent))
    if np.isscalar(screen_ratio) or (isinstance(screen_ratio, np.ndarray) and screen_ratio.ndim == 0):
        r = float(np.clip(float(screen_ratio), 1e-4, 2.0))
        d = d_ref * ((r_ref / r) ** exp_v)
        return float(np.clip(d, d_min, d_max))
    arr = np.clip(np.asarray(screen_ratio, dtype=float), 1e-4, 2.0)
    d_arr = d_ref * ((r_ref / arr) ** exp_v)
    return np.clip(d_arr, d_min, d_max)


def depth_gain_db(
    dist_m,
    ref_dist_m: float = 1.8,
    *,
    rolloff: float = 0.95,
    min_db: float = -24.0,
    max_db: float = 6.5,
):
    """按米制声学距离计算相对近景基准距离 ref_dist_m 的自由场纵深电平偏移（dB）：
    · 与 dsp.space_place 直达声距离衰减律 (ref_dist / dist)^0.95 严格同构；
    · 支持标量（返回 float）或一维序列/数组（返回同长度 float64 ndarray）。"""
    d_ref = max(0.1, float(ref_dist_m))
    ro = max(0.1, float(rolloff))
    if np.isscalar(dist_m) or (isinstance(dist_m, np.ndarray) and dist_m.ndim == 0):
        d = max(0.20, float(dist_m))
        g = 20.0 * ro * math.log10(d_ref / d)
        return float(np.clip(g, float(min_db), float(max_db)))
    d_arr = np.maximum(np.asarray(dist_m, dtype=float), 0.20)
    g_arr = 20.0 * ro * np.log10(d_ref / d_arr)
    return np.clip(g_arr, float(min_db), float(max_db))


def resolve_screen_ratio_curve(
    screen_ratio,
    n: int,
    dur: float = None,
    *,
    default_ratio: float = 0.45,
    sr: int = SR,
) -> np.ndarray:
    """将标量、关键帧 [(t, ratio), ...] 或任意长度曲线统一重采样为长度 n 的视觉占比曲线 r(t) ∈ (0, 2]。"""
    n_out = max(1, int(n))
    if screen_ratio is None:
        return np.full(n_out, float(default_ratio), dtype=float)
    if np.isscalar(screen_ratio) or (isinstance(screen_ratio, np.ndarray) and screen_ratio.ndim == 0):
        return np.full(n_out, float(np.clip(float(screen_ratio), 1e-4, 2.0)), dtype=float)
    if (
        isinstance(screen_ratio, (list, tuple))
        and len(screen_ratio) > 0
        and isinstance(screen_ratio[0], (list, tuple))
        and len(screen_ratio[0]) >= 2
    ):
        eff_dur = float(dur) if dur is not None else (n_out / float(sr))
        t_out = np.arange(n_out, dtype=float) / float(sr)
        pts = sorted((float(p[0]), float(p[1])) for p in screen_ratio)
        scale_t = eff_dur if (pts[-1][0] <= 1.0 and eff_dur > 1.05 and pts[0][0] >= 0.0) else 1.0
        ts = np.array([p[0] * scale_t for p in pts], dtype=float)
        vs = np.array([p[1] for p in pts], dtype=float)
        curve = np.full(n_out, vs[0], dtype=float) if len(ts) == 1 else np.interp(t_out, ts, vs)
        return np.clip(curve, 1e-4, 2.0)
    arr = np.asarray(screen_ratio, dtype=float).reshape(-1)
    if len(arr) == 0:
        return np.full(n_out, float(default_ratio), dtype=float)
    if len(arr) == 1:
        return np.full(n_out, float(np.clip(float(arr[0]), 1e-4, 2.0)), dtype=float)
    if len(arr) == n_out:
        return np.clip(arr.copy(), 1e-4, 2.0)
    interp = np.interp(np.linspace(0.0, 1.0, n_out), np.linspace(0.0, 1.0, len(arr)), arr)
    return np.clip(interp, 1e-4, 2.0)


def subtle_precision_cue(*, tick_sample=None, trace_sample=None, dur: float = 0.36, tick_ms: float = 28.0,
                         cutoff_hz: float = 7800.0, trace_gain: float = 0.42, elbow_at: float = None,
                         end_tick: bool = False, seed: int = 1) -> tuple:
    """精密工程制图引出线/游标卡尺拟音（Precision Drafting & Horological Cue）：
    遵循心理声学 200ms 响度时间积分定律（强制起笔脉冲下限 ≥12ms，避免 <5ms 针尖脉冲因积分能量过低而听不见）：
    零科幻电子正弦铃音；以 12–45 ms 自然衰减的真实机械怀表擒纵/千分尺微咔起笔，
    衔接与画面划线等长（如 360ms / 450ms）的真实纸面笔尖摩擦与折角/收笔微触点。返回 (单声道波形, 锚点秒)。"""
    from .dsp import rng, white, bp, norm
    from .library import sync_anchor

    r = rng(seed)
    n_tot = max(64, int(round(max(0.04, float(dur)) * SR)))
    tk_n = max(32, int(round(float(np.clip(tick_ms, 12.0, 65.0)) * 1e-3 * SR)))

    def _soft_body(w, drive=1.9):
        y = norm(w, 0.98)
        return np.tanh(y * drive) / math.tanh(drive)

    if tick_sample is not None and len(tick_sample) > 0:
        tm = tick_sample.mean(1) if np.ndim(tick_sample) == 2 else np.asarray(tick_sample, dtype=float)
        anc = sync_anchor(tm, SR)
        ia = max(0, int(round(anc * SR)) - max(6, int(round(0.0015 * SR))))
        seg = tm[ia:ia + tk_n].copy()
        if len(seg) < tk_n:
            seg = np.pad(seg, (0, tk_n - len(seg)))
        tick = _soft_body(fade(lp(hp(seg, 420.0, 2), float(cutoff_hz), 2), 0.0005, min(0.010, tk_n / SR * 0.45)))
    else:
        tt = np.arange(tk_n) / float(SR)
        tick = _soft_body(fade(bp(white(tk_n, r), 1100.0, min(float(cutoff_hz), 7800.0), 2) * np.exp(-tt / max(0.0012, tk_n / SR * 0.22)), 0.0004, 0.003))

    out = np.zeros(n_tot, dtype=float)
    m0 = min(n_tot, len(tick))
    out[:m0] += tick[:m0] * 0.92

    if trace_sample is not None and len(trace_sample) > 0 and trace_gain > 0.0 and n_tot > 32:
        tr = trace_sample.mean(1) if np.ndim(trace_sample) == 2 else np.asarray(trace_sample, dtype=float)
        s0 = min(n_tot // 4, int(round(0.006 * SR)))
        tr_len = n_tot - s0
        off = int(r.integers(0, max(1, len(tr) - tr_len))) if len(tr) > tr_len else 0
        seg_t = tr[off:off + tr_len]
        if len(seg_t) < tr_len:
            seg_t = _extend_nonperiodic(tr, tr_len, r)
        u = np.linspace(0.0, 1.0, tr_len)
        arc = np.sin(np.pi * np.clip(u, 0.0, 1.0)) ** 0.65
        whisper = _soft_body(lp(hp(seg_t, 520.0, 2), min(6400.0, float(cutoff_hz) * 0.88), 2), drive=2.2) * arc * float(trace_gain)
        out[s0:s0 + tr_len] += fade(whisper, min(0.008, tr_len / SR * 0.12), min(0.025, tr_len / SR * 0.20))

    if elbow_at is not None and 0.02 < float(elbow_at) < (n_tot / SR - 0.02):
        ie = int(round(float(elbow_at) * SR))
        me = min(n_tot - ie, max(12, m0 // 2))
        out[ie:ie + me] += tick[:me] * 0.42

    if end_tick and n_tot > m0 * 2:
        mend = min(m0, n_tot // 3)
        out[n_tot - mend:] += fade(tick[:mend], 0.0004, min(0.006, mend / SR * 0.4)) * 0.58

    anc_out = sync_anchor(out[:min(len(out), max(m0 * 2, 64))], SR)
    return norm(out, 0.92), anc_out


def hitech_laser_trace(dur: float = 0.36, *, f_lo: float = 6800.0, f_hi: float = 12600.0,
                       pulse_hz: tuple = (118.0, 46.0), elbow_at: float = None, sample=None, seed: int = 1) -> tuple:
    """高科技镭射脉冲走线拟音（Hi-Tech Laser Pulse Vector Trace）：
    用于工程 HUD 引出线与精密矢量尺寸线绘制：
      · 采用余弦平方窗调频微晶脉冲串（6.8–12.6 kHz 极高频清透颗粒），脉冲率随视觉 ease-out 速度从密到疏；
      · 内置 Fletcher-Munson 人耳耳道共振敏感区（2.8–4.8 kHz）防刺耳凹槽（-6.5 dB）与 14.8 kHz 丝绒滚降，
        做到“极高频、晶莹清脆而绝不扎耳朵”；可叠混真实 hitech CC0 扫描纹理 sample。
    返回 (单声道波形, 锚点秒)。"""
    from .dsp import rng, norm, peq
    from .library import sync_anchor

    r = rng(seed)
    n_tot = max(64, int(round(max(0.05, float(dur)) * SR)))
    t = np.arange(n_tot, dtype=float) / float(SR)
    u = t / max(float(dur), 1e-6)

    # 脉冲密度沿 ease-out 划线轨迹平滑减速：起步密集镭射扫描，收笔定格微疏
    p0, p1 = float(pulse_hz[0]), float(pulse_hz[1])
    rate = p1 + (p0 - p1) * ((1.0 - np.clip(u, 0.0, 1.0)) ** 1.35)
    ph = np.cumsum(rate / float(SR))
    trig = np.flatnonzero(np.diff(np.floor(ph), prepend=-1.0) > 0)

    out = np.zeros(n_tot, dtype=float)
    g_len = max(24, int(round(0.0022 * SR)))   # 2.2 ms 无旁瓣汉宁平方微晶脉冲
    tg = np.arange(g_len, dtype=float) / float(SR)
    win_g = np.sin(np.pi * np.linspace(0.0, 1.0, g_len)) ** 2

    for idx_k, i0 in enumerate(trig):
        if i0 >= n_tot - 8:
            break
        prog = float(i0) / float(n_tot)
        # 频率沿划线轻轻上扬并带微随机抖动，避免死板固定正弦音
        fc = float(f_lo + (f_hi - f_lo) * (prog ** 0.75)) * float(r.uniform(0.96, 1.04))
        fc = min(fc, 0.43 * SR)
        chirp = np.sin(2.0 * np.pi * (fc * tg + 650.0 * (tg ** 2) / 0.0022)) * win_g
        amp = (0.45 + 0.55 * math.sin(math.pi * min(1.0, prog * 0.92 + 0.08))) * float(r.uniform(0.78, 1.15))
        if idx_k == 0:
            amp *= 1.35
        m = min(g_len, n_tot - int(i0))
        out[int(i0):int(i0) + m] += chirp[:m] * amp

    # 折线转折点（如 overlay.js 引线斜转水平处）补一粒清透双频微锁点
    if elbow_at is not None and 0.02 < float(elbow_at) < (n_tot / SR - 0.02):
        ie = int(round(float(elbow_at) * SR))
        me = min(n_tot - ie, int(round(0.009 * SR)))
        te = np.arange(me, dtype=float) / float(SR)
        we = np.sin(np.pi * np.linspace(0.0, 1.0, me)) ** 1.6
        out[ie:ie + me] += 0.75 * we * np.sin(2.0 * np.pi * min(9600.0, f_hi * 0.85) * te)

    # 可选叠入真实 hitech CC0 激光/界面纹理（仅取 >5.2 kHz 晶莹空气层）
    if sample is not None and len(sample) > 0:
        sm = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        if len(sm) < n_tot:
            sm = _extend_nonperiodic(sm, n_tot, r)
        else:
            sm = sm[:n_tot]
        hi_tex = lp(hp(norm(sm, 0.95), 5200.0, 2), 14800.0, 2) * (np.sin(np.pi * np.clip(u, 0.0, 1.0)) ** 0.6)
        out = 0.72 * norm(out, 0.95) + 0.34 * hi_tex

    # 防扎耳朵核心均衡：挖除 3.5 kHz 耳道刺耳共振峰，14.8 kHz 以上丝绒滚降
    out = peq(out, 3500.0, -6.5, q=1.35)
    out = lp(hp(out, 4200.0, 2), 14800.0, 2)
    out = np.tanh(norm(out, 0.98) * 1.65) / math.tanh(1.65)
    out = fade(out, min(0.002, dur * 0.05), min(0.016, dur * 0.15))
    return norm(out, 0.90), sync_anchor(out[:min(len(out), int(0.05 * SR))], SR)


def hitech_micro_beep(*, freq_hz: float = 2960.0, root: str = 'D', pattern: str = 'double',
                      dur: float = 0.085, sample=None, emphasis_layer: bool = False,
                      accent_sample=None, seed: int = 1) -> tuple:
    """细致高科技菜单/数据弹出微提示音（Hi-Tech Precision HUD Micro-Beep）：
    玻璃质感软包络调性微滴音（pip / double / chord_lock），吸附影片调性并避开 3.5 kHz 刺耳区；
    传 emphasis_layer=True 时在原基础 beep 上精准叠入一层高五度/八度晶莹强调副 beep（用于核心镜头 HUD 菜单强调）。
    返回 (单声道波形, 锚点秒)。"""
    from .dsp import rng, norm, peq

    _ = rng(seed)
    f1 = harmonic_freq(freq_hz, root=root, scale='pentatonic')
    f2 = harmonic_freq(f1 * 1.25, root=root, scale='pentatonic')
    f3 = harmonic_freq(f1 * 1.50, root=root, scale='pentatonic')
    n_tot = max(64, int(round(max(0.035, float(dur)) * SR)))
    out = np.zeros(n_tot, dtype=float)

    def _glass_pip(f_hz, length_s, gain=1.0):
        m = max(24, int(round(length_s * SR)))
        tp = np.arange(m, dtype=float) / float(SR)
        # 1.2 ms 丝滑余弦起音彻底消除数码硬咔刺，指数晶莹衰减
        atk = smoothstep(0.0, min(0.0014, length_s * 0.25), tp)
        env = atk * np.exp(-tp / max(0.008, length_s * 0.34))
        sig = (np.sin(2.0 * np.pi * f_hz * tp) + 0.14 * np.sin(2.0 * np.pi * min(0.43 * SR, f_hz * 2.0) * tp)) * env
        return sig * float(gain)

    if pattern == 'pip':
        p = _glass_pip(f1, min(dur, 0.042), 0.95)
        out[:min(n_tot, len(p))] += p[:min(n_tot, len(p))]
    elif pattern == 'chord_lock':
        for delay_s, fq, g in ((0.0, f1, 0.72), (0.016, f2, 0.82), (0.032, f3, 0.92)):
            i0 = int(round(delay_s * SR))
            if i0 < n_tot:
                p = _glass_pip(fq, max(0.035, dur - delay_s), g)
                m = min(n_tot - i0, len(p))
                out[i0:i0 + m] += p[:m]
    else:  # 'double'：经典双微粒菜单弹出音（前轻后稳）
        p1 = _glass_pip(f1, 0.024, 0.62)
        p2 = _glass_pip(f2, max(0.036, dur - 0.026), 0.95)
        out[:min(n_tot, len(p1))] += p1[:min(n_tot, len(p1))]
        i2 = min(n_tot - 8, int(round(0.026 * SR)))
        m2 = min(n_tot - i2, len(p2))
        out[i2:i2 + m2] += p2[:m2]

    if sample is not None and len(sample) > 0:
        sm = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        m = min(n_tot, len(sm))
        out[:m] = 0.68 * norm(out[:m], 0.92) + 0.38 * fade(hp(norm(sm[:m], 0.92), 900.0, 2), 0.001, min(0.015, m / SR * 0.3))

    if emphasis_layer:
        # 在保持与前序菜单同源基础音色的前提下，于 +12ms 叠入高五度+高八度双晶莹泛音层及可选实录强调 beep
        f_hi5 = min(0.42 * SR, harmonic_freq(f2 * 1.50, root=root, scale='pentatonic'))
        f_oct = min(0.42 * SR, harmonic_freq(f1 * 2.00, root=root, scale='pentatonic'))
        emp1 = _glass_pip(f_hi5, max(0.032, dur * 0.62), 0.58)
        emp2 = _glass_pip(f_oct, max(0.040, dur * 0.72), 0.52)
        ie1 = min(n_tot - 8, int(round(0.012 * SR)))
        ie2 = min(n_tot - 8, int(round(0.036 * SR)))
        out[ie1:ie1 + min(n_tot - ie1, len(emp1))] += emp1[:n_tot - ie1]
        out[ie2:ie2 + min(n_tot - ie2, len(emp2))] += emp2[:n_tot - ie2]
        if accent_sample is not None and len(accent_sample) > 0:
            am = accent_sample.mean(1) if np.ndim(accent_sample) == 2 else np.asarray(accent_sample, dtype=float)
            ia = min(n_tot - 8, int(round(0.014 * SR)))
            ma = min(n_tot - ia, len(am))
            out[ia:ia + ma] += fade(hp(norm(am[:ma], 0.90), 1400.0, 2), 0.001, min(0.018, ma / SR * 0.35)) * 0.48

    out = lp(peq(out, 3500.0, -4.5, q=1.3), 14500.0, 2)
    return norm(fade(out, 0.0008, min(0.012, n_tot / SR * 0.25)), 0.88), 0.0015


class HDRMixer:
    """离线前视感知 HDR 混音器（EA DICE Frostbite HDR + Walter Murch 2.5 声部法则 + 6 临界频带零相位侧链闪避）。

    只传旧构造参数时走与既有成片链路相同的收口：`tame_low` + `loudness_to`。
    互补 EQ、连续中高频让路、配乐天花板与 SSL 总线粘合需显式传入
    `glue_eq` / `continuous_duck_db` / `music_ceiling_offset_db` / `master_glue`。
    """

    def __init__(self, dur: float, *, fps: float = 24.0, sr: int = SR, target_lufs: float = -14.0,
                 max_tp: float = -1.5, murch_limit: int = 2, telemetry=None, world: str = 'realistic',
                 music_ceiling_offset_db=None, music_focus_windows: list = None,
                 continuous_duck_db: float = 0.0, glue_eq: bool = False, master_glue: bool = False,
                 glue_max_gr_db: float = 3.2):
        self.dur = float(dur)
        self.fps = float(fps)
        self.sr = int(sr)
        self.n = int(round(self.dur * self.sr))
        self.target_lufs = float(target_lufs)
        self.max_tp = float(max_tp)
        self.murch_limit = max(1, int(murch_limit))
        self.telemetry = telemetry
        self.world = world if world in WORLD_PROFILES else 'realistic'
        self.music_ceiling_offset_db = None if music_ceiling_offset_db is None else float(music_ceiling_offset_db)
        self.continuous_duck_db = max(0.0, float(continuous_duck_db))
        self.glue_eq = bool(glue_eq)
        self.master_glue = bool(master_glue)
        self.glue_max_gr_db = float(glue_max_gr_db)
        self.music_focus_windows = []
        self.beds = {'amb': np.zeros((self.n, 2)), 'music': np.zeros((self.n, 2))}
        self._cues = []
        self._vacuums = []
        self._ir_cache = {}
        self._dialogue = None
        if music_focus_windows:
            self.set_music_focus_windows(music_focus_windows)

    def _legacy_mix_path(self) -> bool:
        """未显式打开任何新混音能力时，render() 必须与既有 tame_low + loudness_to 收口一致。"""
        return (
            not self.glue_eq
            and not self.master_glue
            and self.continuous_duck_db <= 0.05
            and self.music_ceiling_offset_db is None
            and not self.music_focus_windows
        )

    def set_dialogue(
        self,
        wave_or_path,
        *,
        spans=None,
        voice_json=None,
        target_lufs: float = -16.0,
        formant_duck_db: float = 4.2,
        amb_duck_db: float = 2.5,
        fx_duck_db: float = 1.8,
        gain_db: float = 0.0,
        pan: float = 0.0,
        room_wet: float = 0.04,
        curve_points=None,
    ):
        """设置四干线对白轨（VO / Dialogue）：
        · 支持传入 (n, 2) / (n,) 波形数组、voice.wav 路径或 dialogue 构建目录；传入 voice_json 时自动经 dialogue.spans 解析句段区间；
        · 执行有声窗门限响度匹配（> -42 dBFS 的 50 ms 有声窗定电平至 target_lufs=-16.0 LUFS + gain_db，不统计句间静音）；
        · 可选施加极克制早期反射空间融合（room_wet=0.04, rt=0.32s）消除干瘪贴玻璃感，并在 render() 中自动联动 sculpt_stem_eq 与 carve_dialogue_pocket。"""
        if wave_or_path is None:
            self._dialogue = None
            return self

        if isinstance(wave_or_path, (str, bytes)) or hasattr(wave_or_path, '__fspath__'):
            import soundfile as sf
            p = os.fspath(wave_or_path)
            if isinstance(p, bytes):
                p = p.decode('utf-8')
            if os.path.isdir(p):
                vj_cand = os.path.join(p, 'voice.json')
                if voice_json is None and os.path.isfile(vj_cand):
                    voice_json = vj_cand
                p = os.path.join(p, 'voice.wav')
            raw_w, sr_in = sf.read(p, dtype='float64', always_2d=False)
            if int(sr_in) != self.sr and len(raw_w) > 0:
                g_sr = math.gcd(self.sr, int(sr_in))
                raw_w = resample_poly(raw_w, self.sr // g_sr, int(sr_in) // g_sr, axis=0)
        else:
            raw_w = np.asarray(wave_or_path, dtype=float)

        eff_spans = None
        if spans is not None:
            eff_spans = [(float(s[0]), float(s[1])) for s in spans]
        elif voice_json is not None:
            from .voice.dialogue import spans as _dialogue_spans
            eff_spans = [(float(s[0]), float(s[1])) for s in _dialogue_spans(voice_json)]

        pan_f = float(np.clip(float(pan), -1.0, 1.0))
        if raw_w.ndim == 1:
            st = stereo(raw_w, pan_f)
        elif raw_w.shape[1] == 1:
            st = stereo(raw_w[:, 0], pan_f)
        else:
            st = raw_w[:, :2].copy()
            if abs(pan_f) > 1e-4:
                l_g, r_g = pan_lr(pan_f)
                st = np.stack([st[:, 0] * l_g, st[:, 1] * r_g], axis=1)

        full = np.zeros((self.n, 2), dtype=float)
        m = min(self.n, len(st))
        if m > 0:
            full[:m] = st[:m]

        self._dialogue = {
            'wave': full,
            'spans': eff_spans,
            'target_lufs': None if target_lufs is None else float(target_lufs),
            'formant_duck_db': max(0.0, float(formant_duck_db)),
            'amb_duck_db': max(0.0, float(amb_duck_db)),
            'fx_duck_db': max(0.0, float(fx_duck_db)),
            'gain_db': float(gain_db),
            'pan': pan_f,
            'room_wet': 0.0 if room_wet is None else max(0.0, float(room_wet)),
            'curve_points': curve_points,
        }
        return self

    def set_music_focus_windows(self, windows: list, *, is_climax: bool = True):
        """设置音乐主导窗口列表：
        支持 (t0, t1)、(t0, t1, val_db)、(t0, t1, sfx_trim_db, music_lift_db) 或 dict；
        在窗口内放开配乐净空压制并平滑推高配乐（纯音乐情绪高潮/片尾辉煌收束）。"""
        default_lift = abs(self.music_ceiling_offset_db) - 0.8 if (self.music_ceiling_offset_db is not None and self.music_ceiling_offset_db < -1.0) else 4.0
        default_lift = max(2.0, float(default_lift))
        parsed = []
        for item in (windows or []):
            if isinstance(item, dict):
                t0 = float(item.get('t0', item.get('in_s', 0.0)))
                t1 = float(item.get('t1', item.get('out_s', 0.0)))
                trim_db = -abs(float(item.get('sfx_trim_db', item.get('trim_db', -2.5))))
                lift_db = float(item.get('music_lift_db', item.get('lift_db', default_lift if is_climax else 0.0)))
            elif len(item) >= 4:
                t0, t1 = float(item[0]), float(item[1])
                trim_db = -abs(float(item[2]))
                lift_db = float(item[3])
            elif len(item) == 3:
                t0, t1, v = float(item[0]), float(item[1]), float(item[2])
                if v > 0.0:
                    trim_db = -2.5
                    lift_db = v
                else:
                    trim_db = v
                    lift_db = default_lift if is_climax else min(2.5, abs(v) * 0.35)
            else:
                t0, t1 = float(item[0]), float(item[1])
                trim_db = -2.5
                lift_db = default_lift
            if t1 > t0:
                parsed.append({
                    't0': max(0.0, t0),
                    't1': min(self.dur, t1),
                    'sfx_trim_db': float(trim_db),
                    'music_lift_db': max(0.0, float(lift_db)),
                })
        self.music_focus_windows = parsed
        return self

    def _get_ir(self, poa_name: str):
        if not poa_name or poa_name not in POA_PRESETS:
            return None, 0.0
        cfg = POA_PRESETS[poa_name]
        if not cfg.get('ir'):
            return None, 0.0
        if poa_name not in self._ir_cache:
            self._ir_cache[poa_name] = make_ir(**cfg['ir'])
        return self._ir_cache[poa_name], float(cfg.get('wet', 0.18))

    def add_bed(self, bus: str, wave: np.ndarray, *, target_lufs: float = None, how: str = 'win',
                t0: float = 0.0, t1: float = None, gain_db: float = 0.0, curve_points: list = None):
        b = 'music' if bus == 'music' else 'amb'
        st = np.asarray(wave, dtype=float)
        if st.ndim == 1:
            st = stereo(st, 0.0)
        full = np.zeros((self.n, 2), dtype=float)
        place(full, st, 0.0, 1.0)
        if target_lufs is not None:
            full, _, _ = match_level(full, float(target_lufs), how, t0, self.dur if t1 is None else t1)
        if abs(gain_db) > 1e-6:
            full = full * undb(gain_db)
        if curve_points:
            full = full * volume_curve(self.n, curve_points, dur=self.dur, sr=self.sr)
        self.beds[b] += full

    def add_scene_ambience(self, scenes: list, *, target_lufs: float = None,
                           hard_xfade_s: float = 0.055, montage_xfade_s: float = 0.85,
                           curve_points: list = None):
        """按多场景镜头表铺设环境音轨（室外↔室内切换等通用空间接缝规则，支持全片或分场景 curve_points 音量曲线）：
        · transition='hard_cut'（默认）：画面硬切换景时，在切点做极短等功率微交叉淡化（默认 55 ms ≈ 1.3 帧），
          既彻底消除零样本硬切咔嗒声（过 audio.cuts 门），又防止上一场室外风声拖入下一场室内穿帮；
        · transition='montage'：导演蒙太奇叙事段落，使用长等功率交叉淡化（默认 0.85 s）平滑过渡；
        · transition='j_cut' / 'l_cut'：支持声音先入（lead_s，默认 0.35 s）或余音后延（tail_s，默认 0.45 s）。"""
        if not scenes:
            return
        t_axis = np.arange(self.n, dtype=float) / float(self.sr)
        acc = np.zeros((self.n, 2), dtype=float)
        n_sc = len(scenes)
        for idx, sc in enumerate(scenes):
            in_s = float(sc['in_s'])
            out_s = float(sc['out_s'])
            w = np.asarray(sc['wave'], dtype=float)
            if w.ndim == 1:
                w = stereo(w, 0.0)
            tr_in = str(sc.get('transition_in') or (scenes[idx - 1].get('transition') if idx > 0 else 'hard_cut') or 'hard_cut')
            tr_out = str(sc.get('transition') or 'hard_cut')

            def _xf_dur(kind, custom):
                if custom is not None:
                    return float(custom)
                if kind == 'montage':
                    return float(montage_xfade_s)
                return float(hard_xfade_s)

            xf_in = _xf_dur(tr_in, sc.get('xfade_in_s'))
            xf_out = _xf_dur(tr_out, sc.get('xfade_s'))
            eff_in = in_s - float(sc.get('lead_s', 0.35)) if tr_in == 'j_cut' and idx > 0 else in_s
            eff_out = out_s + float(sc.get('tail_s', 0.45)) if tr_out == 'l_cut' and idx < n_sc - 1 else out_s

            need_s = max(0.05, (eff_out - eff_in) + xf_in + xf_out + 0.1)
            need_n = int(round(need_s * self.sr))
            if len(w) < need_n:
                r = np.random.default_rng(101 + idx)
                w = np.column_stack([
                    _extend_nonperiodic(w[:, 0], need_n, r),
                    _extend_nonperiodic(w[:, 1], need_n, r),
                ])
            seg_buf = np.zeros((self.n, 2), dtype=float)
            place(seg_buf, w, max(0.0, eff_in - xf_in * 0.5), float(undb(sc.get('gain_db', 0.0))))
            if sc.get('curve_points'):
                seg_buf = seg_buf * volume_curve(self.n, sc['curve_points'], dur=self.dur, sr=self.sr)
            # 首尾边界分别精确用各自的 xf_in / xf_out 等功率窗，确保 hard_cut 接缝两侧 sin²+cos²=1
            up = np.sin(np.pi / 2.0 * smoothstep(eff_in - xf_in / 2.0, eff_in + xf_in / 2.0, t_axis)) if idx > 0 else np.ones(self.n)
            dn = np.cos(np.pi / 2.0 * smoothstep(eff_out - xf_out / 2.0, eff_out + xf_out / 2.0, t_axis)) if idx < n_sc - 1 else np.ones(self.n)
            env = (up * dn)[:, None]
            acc += seg_buf * env

        tgt_lufs = target_lufs if target_lufs is not None else WORLD_PROFILES[self.world]['stems_lufs']['amb']
        if tgt_lufs is not None and float(np.abs(acc).max()) > 1e-7 and self.dur >= 0.45:
            acc, _, _ = match_level(acc, float(tgt_lufs), 'win', 0.0, self.dur)
        if curve_points:
            acc = acc * volume_curve(self.n, curve_points, dur=self.dur, sr=self.sr)
        self.beds['amb'] += acc

    def add_negative_space(self, frame: int = None, *, t: float = None, lead_frames: float = 6.0,
                           hold_frames: float = 1.0, dip_db: float = -14.0, recover_sec: float = 0.55):
        sp = {'leadFrames': lead_frames, 'holdFrames': hold_frames, 'dipDb': dip_db, 'recoverSec': recover_sec}
        if t is not None:
            sp['t'] = float(t)
        else:
            sp['frame'] = int(frame)
        self._vacuums.append(sp)

    def add_cue(self, cue_id: str, wave: np.ndarray, t_hit: float, *, anchor: float = 0.0,
                role: str = 'support', priority: float = None, bus: str = None,
                target_lufs: float = None, gain_db: float = 0.0, pan=None, dist=None,
                screen_ratio=None, ref_ratio: float = 0.45, ref_dist_m: float = 1.8,
                poa: str = None, duck_db: float = None, continuous_duck_db: float = None,
                track_name: str = 'screen', shot_scale: str = None, span_dur: float = None,
                fade_out_s: float = None, follow_motion: bool = False, doppler_mps=None,
                curve_points: list = None, _depth_peak_db: float = None):
        rd = ROLE_DEFAULTS.get(role, ROLE_DEFAULTS['support'])
        prio = float(rd['priority'] if priority is None else priority)
        b_name = str(bus or rd['bus'])
        # 纯高科技/无生命体世界观关闭 foley 时，若误传 bus='foley' 且未强制指定，自动静默跳过生命体拟音层
        if b_name == 'foley' and not WORLD_PROFILES[self.world]['foley_enabled'] and role == 'foley':
            return
        tgt = rd['target_lufs'] if target_lufs is None else float(target_lufs)
        dk = float(rd['duck_db'] if duck_db is None else duck_db)
        cap = SHOT_PAN_CAP.get(shot_scale, SHOT_PAN_CAP['medium']) if shot_scale is not None else None

        w_arr = np.asarray(wave, dtype=float)
        anc_val = float(anchor)
        if span_dur is not None:
            w_arr, anc_val = fit_to_span(w_arr, float(span_dur), anchor=anc_val, fade_out_s=fade_out_s, sr=self.sr)
        if doppler_mps is not None and len(w_arr) > 8:
            w_arr = doppler(w_arr, vel_mps=doppler_mps)

        depth_peak = _depth_peak_db
        from_sr = bool(screen_ratio is not None or _depth_peak_db is not None)
        if screen_ratio is not None and len(w_arr) > 0:
            if np.isscalar(screen_ratio) or (isinstance(screen_ratio, np.ndarray) and screen_ratio.ndim == 0):
                d_sr = screen_scale_to_distance(float(screen_ratio), ref_ratio=ref_ratio, ref_dist_m=ref_dist_m)
                sr_pk_db = depth_gain_db(d_sr, ref_dist_m=ref_dist_m)
            else:
                r_curve = resolve_screen_ratio_curve(
                    screen_ratio, len(w_arr), len(w_arr) / float(self.sr), default_ratio=ref_ratio, sr=self.sr
                )
                d_sr = screen_scale_to_distance(r_curve, ref_ratio=ref_ratio, ref_dist_m=ref_dist_m)
                sr_pk_db = float(np.max(depth_gain_db(d_sr, ref_dist_m=ref_dist_m)))
            if dist is None:
                dist = d_sr
            if depth_peak is None:
                depth_peak = float(sr_pk_db)

        if depth_peak is not None and tgt is not None:
            tgt = float(tgt) + float(depth_peak)

        # 声像支持三种输入：标量、关键帧列表 [(t, pan), ...]、或逐样本曲线；也可开启 follow_motion 从页面真遥测连续切片
        if isinstance(pan, list) and pan and isinstance(pan[0], (tuple, list)):
            pan, auto_d = pan_trajectory(len(w_arr) / float(self.sr), pan, cap=cap, sr=self.sr)
            if dist is None and auto_d is not None:
                dist = auto_d
        elif pan is None and self.telemetry is not None:
            tr = self.telemetry.get(track_name)
            auto_cap = SHOT_PAN_CAP['medium'] if cap is None else cap
            pan_curve = tr.pan('x', spread=min(0.85, auto_cap * 1.4))
            if follow_motion and len(w_arr) > 1:
                s0 = int(round((float(t_hit) - anc_val) * self.sr))
                idxs = np.clip(np.arange(s0, s0 + len(w_arr)), 0, len(pan_curve) - 1)
                pan = np.clip(pan_curve[idxs], -auto_cap, auto_cap)
                if dist is None and 'depth' in getattr(tr, 'channels', {}):
                    d_curve = tr.dist('depth')
                    dist = d_curve[np.clip(np.arange(s0, s0 + len(w_arr)), 0, len(d_curve) - 1)]
            else:
                idx = int(np.clip(round(float(t_hit) * self.sr), 0, len(pan_curve) - 1))
                pan = float(np.clip(pan_curve[idx], -auto_cap, auto_cap))
            mot_curve = tr.arr('motion', default=0.5)
            idx_m = int(np.clip(round(float(t_hit) * self.sr), 0, len(mot_curve) - 1))
            prio += 4.0 * float(mot_curve[idx_m])
        elif pan is not None and cap is not None:
            pan = float(np.clip(float(pan), -cap, cap)) if np.ndim(pan) == 0 else np.clip(np.asarray(pan, dtype=float), -cap, cap)
        pan_val = 0.0 if pan is None else pan

        self._cues.append({
            'id': str(cue_id),
            'wave': w_arr,
            't_hit': float(t_hit),
            'anchor': anc_val,
            'role': role,
            'priority': prio,
            'bus': b_name,
            'target_lufs': tgt,
            'gain_db': float(gain_db),
            'pan': pan_val,
            'dist': dist,
            'ref_dist_m': float(ref_dist_m),
            'from_screen_ratio': from_sr,
            'poa': poa,
            'duck_db': dk,
            'continuous_duck_db': continuous_duck_db,
            'curve_points': curve_points,
        })

    def render(self) -> tuple:
        """执行声部聚簇裁剪 → 逐事件摆位定电平 → 负空间抽空 → 6 临界频带侧链闪避 → 母带收口。
        未打开新混音开关时收口为 tame_low + loudness_to；显式打开 glue_eq / continuous_duck_db /
        music_ceiling_offset_db / master_glue 时才走互补 EQ、连续让路、配乐天花板与 SSL 粘合母带。
        返回 (mix, stems_dict, diagnostics_dict)。"""
        legacy = self._legacy_mix_path()
        # 1. Walter Murch 2.5 法则：85 ms 并发窗内超出 murch_limit 的低优先级瞬态自动退居群像层
        cues = [dict(c) for c in self._cues]
        culled_ids = []
        for idx, c in enumerate(cues):
            if c['role'] == 'texture':
                c['_demoted'] = False
                continue
            Higher = [
                o for j, o in enumerate(cues)
                if j != idx and o['role'] != 'texture'
                and abs(o['t_hit'] - c['t_hit']) <= 0.085
                and (o['priority'] > c['priority'] or (o['priority'] == c['priority'] and j < idx))
                and (
                    legacy
                    or o['bus'] == c['bus']
                    or (o['role'] == 'hero' and c['role'] != 'ui')
                )
            ]
            if len(Higher) >= self.murch_limit:
                c['_demoted'] = True
                culled_ids.append(c['id'])
            else:
                c['_demoted'] = False

        stems = {
            'amb': self.beds['amb'].copy(),
            'music': self.beds['music'].copy(),
            'fx': np.zeros((self.n, 2), dtype=float),
            'foley': np.zeros((self.n, 2), dtype=float),
            'ui': np.zeros((self.n, 2), dtype=float),
        }
        fg_events = []

        # 2. 放置全部离散事件（UI 编码层强制直达干声；世界内事件按 POA / screen_ratio 空间同化）
        for c in cues:
            w = c['wave']
            if c['_demoted']:
                w = shelf(w, 3600.0, -3.5, 'high') * undb(-5.5)
            at_s = c['t_hit'] - c['anchor']
            elem = np.zeros((self.n, 2), dtype=float)
            if c['role'] == 'ui' or c['poa'] == 'subjective_internal':
                if w.ndim == 1:
                    st_w = stereo(w, c['pan'])
                else:
                    p_a = np.asarray(c['pan'], dtype=float)
                    if p_a.ndim > 0 or abs(float(p_a)) > 1e-4:
                        ang = (np.clip(p_a, -1.0, 1.0) + 1.0) * np.pi / 4.0
                        l_g, r_g = np.cos(ang) * np.sqrt(2.0), np.sin(ang) * np.sqrt(2.0)
                        st_w = np.stack([w[:, 0] * l_g, w[:, 1] * r_g], axis=1)
                    else:
                        st_w = w
                place(elem, st_w, at_s, 1.0)
            elif c['poa'] in POA_PRESETS or c['dist'] is not None:
                p_cfg = POA_PRESETS.get(c['poa'], POA_PRESETS['fog_wide'])
                d_val = c['dist'] if c['dist'] is not None else float(p_cfg['dist_m'])
                eff_poa = c['poa']
                if eff_poa is None and c.get('from_screen_ratio'):
                    eff_poa = 'intimate_dry' if float(np.mean(d_val)) <= 1.5 else 'open_sky'
                ir, wet = self._get_ir(eff_poa)
                if c['poa'] is None and c.get('from_screen_ratio'):
                    wet = min(wet, 0.16)
                ref_d = float(c.get('ref_dist_m', 2.0)) if c.get('from_screen_ratio') else 2.0
                pan_arr = np.asarray(c['pan'], dtype=float)
                space_place(
                    elem, w, at_s, gain=1.0, pan=c['pan'], dist=d_val, ref_dist=ref_d, ir=ir, wet=wet,
                    dynamic_pan=bool(not legacy and pan_arr.ndim > 0 and pan_arr.size > 1),
                )
            else:
                if w.ndim == 1:
                    place(elem, w, at_s, 1.0, c['pan'])
                else:
                    p_a = np.asarray(c['pan'], dtype=float)
                    if p_a.ndim > 0 or abs(float(p_a)) > 1e-4:
                        ang = (np.clip(p_a, -1.0, 1.0) + 1.0) * np.pi / 4.0
                        l_g, r_g = np.cos(ang) * np.sqrt(2.0), np.sin(ang) * np.sqrt(2.0)
                        place(elem, np.stack([w[:, 0] * l_g, w[:, 1] * r_g], axis=1), at_s, 1.0)
                    else:
                        place(elem, w, at_s, 1.0)

            # 按目标瞬时响度或采样峰值定电平（短促点击 < 0.18s 自动改用峰值补偿对齐，防 400ms 窗低估短瞬态）
            if c['target_lufs'] is not None:
                t_a = max(0.0, at_s)
                t_b = min(self.dur, max(t_a + 0.45, at_s + len(w) / self.sr + 0.15))
                pk = float(np.abs(elem).max())
                if pk > 1e-7:
                    if t_b - t_a >= 0.42 and len(w) >= int(0.18 * self.sr):
                        try:
                            elem, _, _ = match_level(elem, c['target_lufs'], 'mom', t_a, t_b)
                        except ValueError:
                            elem = elem * (undb(c['target_lufs'] + 6.0) / pk)
                    else:
                        elem = elem * (undb(c['target_lufs'] + 6.0) / pk)
            if abs(c['gain_db']) > 1e-6:
                elem = elem * undb(c['gain_db'])
            if c.get('curve_points'):
                elem = elem * volume_curve(self.n, c['curve_points'], dur=self.dur, sr=self.sr)
            if c['_demoted']:
                elem = elem * undb(-4.5)

            b_key = c['bus'] if c['bus'] in stems else 'fx'
            stems[b_key] += elem
            extra_cont = (not legacy) and (c.get('continuous_duck_db') or 0.0) > 0.2
            if (c['duck_db'] > 0.5 or extra_cont) and not c['_demoted']:
                fg_events.append((c, elem))

        # 2b. 分轨互补 EQ 分槽（glue_eq=True）：AMB 让出 <110Hz 与 800Hz 暖中频槽位，Foley/FX 清低中频泥沼，配乐在咬合区微让位
        fg_narr_pre = stems['fx'] + stems['foley']
        has_fg_narr = bool(float(np.abs(fg_narr_pre).max()) > 1e-5)
        if self.glue_eq and self.n > 64:
            stems = sculpt_stem_eq(
                stems,
                music_presence_dip_db=(-1.0 if has_fg_narr else 0.0),
                sr=self.sr,
            )

        # 3. 峰值前负空间抽空。旧路径与既有成片一致（配乐跟环境一起深抽）；新路径只让配乐微呼吸，避免腰斩旋律。
        if self._vacuums:
            vac_env = carve_negative_space(self.n, self._vacuums, fps=self.fps, sr=self.sr)
            stems['amb'] = stems['amb'] * vac_env
            if legacy:
                stems['music'] = stems['music'] * (0.35 + 0.65 * vac_env)
            else:
                stems['music'] = stems['music'] * (0.68 + 0.32 * vac_env)

        t_axis = np.arange(self.n, dtype=float) / float(self.sr)
        focus_mask = np.zeros(self.n, dtype=float)
        focus_lift_db = np.zeros(self.n, dtype=float)
        for fw in self.music_focus_windows:
            xf_f = min(0.35, max(0.04, (fw['t1'] - fw['t0']) * 0.22))
            w_up = smoothstep(fw['t0'] - xf_f * 0.5, fw['t0'] + xf_f * 0.5, t_axis) if fw['t0'] > 0.02 else np.ones(self.n)
            w_dn = (1.0 - smoothstep(fw['t1'] - xf_f * 0.5, fw['t1'] + xf_f * 0.5, t_axis)) if fw['t1'] < self.dur - 0.02 else np.ones(self.n)
            win_f = w_up * w_dn
            focus_mask = np.maximum(focus_mask, win_f)
            focus_lift_db = np.maximum(focus_lift_db, float(fw['music_lift_db']) * win_f)

        # 3b. 连续前景动作中高频凹槽轻柔让路（需显式 continuous_duck_db>0，聚焦 2.0–5.0 kHz 咬合带）
        fg_narr = stems['fx'] + stems['foley']
        has_fg_narr = bool(float(np.abs(fg_narr).max()) > 1e-5)
        cont_duck_applied_db = 0.0
        if self.continuous_duck_db > 0.05 and has_fg_narr and float(np.abs(stems['music']).max()) > 1e-7 and self.n >= 256:
            fg_pow = np.mean(fg_narr ** 2, axis=1)
            rms_25ms = np.sqrt(np.maximum(0.0, uniform_filter1d(fg_pow, size=max(16, int(round(0.025 * self.sr))))) + 1e-24)
            bridged = maximum_filter1d(rms_25ms, size=max(16, int(round(0.26 * self.sr))))
            act_thr = max(5e-4, float(np.percentile(rms_25ms[rms_25ms > 1e-5], 85)) * 0.12) if np.any(rms_25ms > 1e-5) else 1.0
            raw_act = (bridged >= act_thr).astype(float)
            min_run = max(32, int(round(0.32 * self.sr)))
            sustained_mask = np.zeros(self.n, dtype=float)
            edges = np.flatnonzero(np.diff(raw_act, prepend=0.0, append=0.0) != 0)
            for s_i, e_i in zip(edges[0::2], edges[1::2]):
                if e_i - s_i >= min_run:
                    sustained_mask[s_i:e_i] = 1.0
            for c, _ in fg_events:
                c_cd = c.get('continuous_duck_db')
                if c_cd is not None and float(c_cd) > 0.05:
                    s_c = max(0, int(round((c['t_hit'] - c['anchor']) * self.sr)))
                    e_c = min(self.n, s_c + len(c['wave']))
                    if e_c > s_c:
                        sustained_mask[s_c:e_c] = np.maximum(
                            sustained_mask[s_c:e_c],
                            min(1.8, float(c_cd) / max(self.continuous_duck_db, 1e-6)),
                        )

            if float(sustained_mask.max()) > 0.01:
                sm_env = uniform_filter1d(sustained_mask, size=max(32, int(round(0.18 * self.sr))))
                sm_env = sm_env * (1.0 - 0.65 * focus_mask)
                db_curve = -self.continuous_duck_db * sm_env
                cont_duck_applied_db = round(float(-np.min(db_curve)), 2)
                if self.n > 64:
                    if self.continuous_duck_db <= 2.8:
                        mus_sub = lp(stems['music'], 160.0, 2)
                        mus_pres = _zero_phase_bp(stems['music'], 2000.0, 5000.0, sr=self.sr, order=2)
                        mus_body = stems['music'] - mus_sub - mus_pres
                        stems['music'] = (
                            mus_sub
                            + mus_body * undb(0.15 * db_curve)[:, None]
                            + mus_pres * undb(db_curve)[:, None]
                        )
                    else:
                        mus_sub = lp(stems['music'], 155.0, 2)
                        mus_hi = stems['music'] - mus_sub
                        stems['music'] = (
                            mus_sub * undb(0.35 * db_curve)[:, None]
                            + mus_hi * undb(db_curve)[:, None]
                        )
                else:
                    stems['music'] = stems['music'] * undb(db_curve)[:, None]

        # 4. 离线前视 6 临界频带动态让位（Spectral Ducking）。
        #    旧路径：背景 amb+music 同槽挖；新路径：AMB 大幅让位，配乐守护低中频基音。
        ducked_bands = {}
        bg_sum = stems['amb'] + stems['music']
        if fg_events and float(np.abs(bg_sum).max()) > 1e-7:
            if legacy:
                band_carves = {bn: np.zeros(self.n, dtype=float) for bn, _, _ in CRITICAL_BANDS}
                for c, elem in fg_events:
                    ia = max(0, int(round((c['t_hit'] - 0.015) * self.sr)))
                    ib = min(self.n, int(round((c['t_hit'] + 0.220) * self.sr)))
                    if ib - ia < 256:
                        continue
                    u_seg = elem[ia:ib].mean(axis=1)
                    o_seg = bg_sum[ia:ib].mean(axis=1)
                    if float(np.max(np.abs(u_seg))) < 1e-6:
                        continue
                    win = np.hanning(len(u_seg))
                    U = np.abs(np.fft.rfft(u_seg * win)) ** 2
                    O = np.abs(np.fft.rfft(o_seg * win)) ** 2
                    fq = np.fft.rfftfreq(len(u_seg), 1.0 / self.sr)
                    bu = [(bn, lo, hi, float(U[(fq >= lo) & (fq < hi)].sum())) for bn, lo, hi in CRITICAL_BANDS]
                    tot_u = sum(v for _, _, _, v in bu) + 1e-24
                    dom = [(bn, lo, hi, v) for bn, lo, hi, v in bu if v / tot_u >= 0.14]
                    if not dom:
                        dom = [max(bu, key=lambda it: it[3])]
                    for bn, lo, hi, vu in dom:
                        vo = float(O[(fq >= lo) & (fq < hi)].sum())
                        snr_db = 10.0 * math.log10((vu + 1e-24) / (vo + 1e-24))
                        want_snr = 1.5 if c['role'] == 'hero' else (-2.5 if c['role'] == 'ui' else -4.0)
                        if snr_db < want_snr:
                            need_db = min(16.5, max(float(c['duck_db']), (want_snr - snr_db) + 2.5))
                            depth = 1.0 - float(undb(-need_db))
                            t0 = c['t_hit']
                            atk = smoothstep(t0 - 0.035, t0 - 0.012, t_axis)
                            rel = 1.0 - smoothstep(t0 + 0.180, t0 + 0.340, t_axis)
                            band_carves[bn] = np.maximum(band_carves[bn], depth * atk * rel)
                            ducked_bands.setdefault(c['id'], []).append((bn, round(snr_db, 1), round(need_db, 1)))
                for bn, lo, hi in CRITICAL_BANDS:
                    cv = band_carves[bn]
                    if float(cv.max()) <= 0.03 or self.n < 64:
                        continue
                    for b_name in ('amb', 'music'):
                        if float(np.abs(stems[b_name]).max()) <= 1e-7:
                            continue
                        band_sig = _zero_phase_bp(stems[b_name], lo, hi, sr=self.sr, order=2)
                        stems[b_name] = stems[b_name] - band_sig * cv[:, None]
            else:
                amb_carves = {bn: np.zeros(self.n, dtype=float) for bn, _, _ in CRITICAL_BANDS}
                mus_carves = {bn: np.zeros(self.n, dtype=float) for bn, _, _ in CRITICAL_BANDS}
                for c, elem in fg_events:
                    at_s = max(0.0, c['t_hit'] - c['anchor'])
                    end_s = min(self.dur, at_s + len(c['wave']) / float(self.sr))
                    span_len = end_s - at_s
                    if span_len > 0.40 and c['role'] not in ('ui', 'subtle_ui'):
                        n_hops = max(1, int(math.ceil(span_len / 0.22)))
                        probe_windows = [
                            (at_s + k * 0.22, min(end_s, at_s + (k + 1) * 0.22 + 0.04), k > 0)
                            for k in range(n_hops)
                        ]
                    else:
                        probe_windows = [(max(0.0, c['t_hit'] - 0.015), min(self.dur, c['t_hit'] + 0.220), False)]

                    want_snr = 2.5 if c['role'] == 'hero' else (-1.5 if c['role'] == 'ui' else -2.0)
                    for w_t0, w_t1, is_tail_win in probe_windows:
                        ia = max(0, int(round(w_t0 * self.sr)))
                        ib = min(self.n, int(round(w_t1 * self.sr)))
                        if ib - ia < 256:
                            continue
                        u_seg = elem[ia:ib].mean(axis=1)
                        o_seg = bg_sum[ia:ib].mean(axis=1)
                        if float(np.max(np.abs(u_seg))) < 1e-6:
                            continue
                        win = np.hanning(len(u_seg))
                        U = np.abs(np.fft.rfft(u_seg * win)) ** 2
                        O = np.abs(np.fft.rfft(o_seg * win)) ** 2
                        fq = np.fft.rfftfreq(len(u_seg), 1.0 / self.sr)
                        bu = [(bn, lo, hi, float(U[(fq >= lo) & (fq < hi)].sum())) for bn, lo, hi in CRITICAL_BANDS]
                        tot_u = sum(v for _, _, _, v in bu) + 1e-24
                        dom = [(bn, lo, hi, v) for bn, lo, hi, v in bu if v / tot_u >= 0.14]
                        if not dom:
                            dom = [max(bu, key=lambda it: it[3])]
                        has_hi_glimpse = any(bn in ('1.5k-3.5k', '3.5k-7.5k', '7.5k-14k') for bn, _, _, _ in dom)
                        for bn, lo, hi, vu in dom:
                            vo = float(O[(fq >= lo) & (fq < hi)].sum())
                            snr_db = 10.0 * np.log10((vu + 1e-24) / (vo + 1e-24))
                            if snr_db < want_snr:
                                need_amb_db = min(15.0, max(float(c['duck_db']), (want_snr - snr_db) + 2.2))
                                if has_hi_glimpse and bn == '80-250':
                                    need_mus_db = min(1.0, need_amb_db * 0.20)
                                elif has_hi_glimpse and bn == '250-600':
                                    need_mus_db = min(2.0, need_amb_db * 0.35)
                                elif has_hi_glimpse and bn == '600-1.5k':
                                    need_mus_db = min(3.2, need_amb_db * 0.55)
                                elif is_tail_win:
                                    need_mus_db = min(3.2, max(1.8, (want_snr - snr_db) + 1.0))
                                else:
                                    need_mus_db = min(13.5, max(min(float(c['duck_db']), 3.2), (want_snr - snr_db) + 2.0))

                                atk = smoothstep(w_t0 - 0.035, w_t0 - 0.008, t_axis)
                                rel = 1.0 - smoothstep(w_t1 - 0.020, w_t1 + 0.150, t_axis)
                                shape_w = atk * rel
                                amb_carves[bn] = np.maximum(amb_carves[bn], (1.0 - float(undb(-need_amb_db))) * shape_w)
                                if need_mus_db > 0.05:
                                    mus_carves[bn] = np.maximum(mus_carves[bn], (1.0 - float(undb(-need_mus_db))) * shape_w)
                                prev_list = ducked_bands.setdefault(c['id'], [])
                                if not any(x[0] == bn for x in prev_list):
                                    prev_list.append((bn, round(snr_db, 1), round(need_mus_db, 1)))

                if self.n >= 64:
                    for bn, lo, hi in CRITICAL_BANDS:
                        cv_a = amb_carves[bn]
                        if float(cv_a.max()) > 0.03 and float(np.abs(stems['amb']).max()) > 1e-7:
                            band_a = _zero_phase_bp(stems['amb'], lo, hi, sr=self.sr, order=2)
                            stems['amb'] = stems['amb'] - band_a * cv_a[:, None]
                        cv_m = mus_carves[bn]
                        if float(cv_m.max()) > 0.03 and float(np.abs(stems['music']).max()) > 1e-7:
                            band_m = _zero_phase_bp(stems['music'], lo, hi, sr=self.sr, order=2)
                            stems['music'] = stems['music'] - band_m * cv_m[:, None]

        # 4b. 对白轨（VO）声学塑形、有声门限响度校准、早期反射融合与共振峰动态挖槽（保护配乐 <350Hz 大提琴低音底盘）
        vo_st = None
        has_vo_sig = False
        vo_snr_1k_4k_db = None
        if self._dialogue is not None:
            dlg = self._dialogue
            vo_st = dlg['wave'].copy()
            orig_vo_abs = np.max(np.abs(vo_st), axis=1) if len(vo_st) > 0 else np.zeros(0, dtype=float)
            has_vo_sig = bool(self.n > 64 and len(orig_vo_abs) > 0 and float(np.max(orig_vo_abs)) > 1e-7)
            if has_vo_sig:
                vo_st = sculpt_stem_eq({'vo': vo_st}, sr=self.sr)['vo']
                fq_v = np.fft.rfftfreq(len(vo_st), 1.0 / float(self.sr))
                sp_v = np.abs(np.fft.rfft(vo_st.mean(axis=1))) ** 2
                tot_v = float(sp_v.sum()) + 1e-24
                e14_v = float(sp_v[(fq_v >= 1000.0) & (fq_v <= 4000.0)].sum())
                frac_14_db = 10.0 * math.log10(e14_v / tot_v + 1e-24)
                if frac_14_db < -11.0:
                    art_boost = min(3.5, (-10.5 - frac_14_db) * 0.65)
                    vo_st = _peq_sr(vo_st, 2500.0, art_boost, q=0.75, sr=self.sr)
                    if np.any(orig_vo_abs == 0.0):
                        vo_st = _preserve_silent_gaps(vo_st, orig_vo_abs, min_gap_s=0.020, taper_s=0.004, sr=self.sr)

                vo_lufs, _ = _speech_gated_lufs(vo_st, sr=self.sr, gate_dbfs=-42.0)
                if dlg['target_lufs'] is not None and np.isfinite(vo_lufs) and vo_lufs > -70.0:
                    vo_st = vo_st * undb((dlg['target_lufs'] - vo_lufs) + dlg['gain_db'])
                elif abs(dlg['gain_db']) > 1e-6:
                    vo_st = vo_st * undb(dlg['gain_db'])

                if dlg['room_wet'] > 1e-4:
                    if '__vo_room__' not in self._ir_cache:
                        self._ir_cache['__vo_room__'] = make_ir(
                            rt=0.32,
                            pre=0.006,
                            tone=(0.75, 1.0, 0.85, 0.58),
                            er=12,
                            er_span=(0.005, 0.038),
                            er_gain=0.65,
                            er_lp=6800,
                            seed=53,
                        )
                    vo_st = reverb(
                        vo_st,
                        self._ir_cache['__vo_room__'],
                        wet=dlg['room_wet'],
                        dry=1.0,
                        cross=0.22,
                        hp_in=160.0,
                    )
                    if np.any(orig_vo_abs == 0.0):
                        vo_st = _preserve_silent_gaps(
                            vo_st,
                            orig_vo_abs,
                            min_gap_s=0.38,
                            taper_s=0.015,
                            hold_tail_s=0.32,
                            sr=self.sr,
                        )

                if dlg['curve_points']:
                    vo_st = vo_st * volume_curve(self.n, dlg['curve_points'], dur=self.dur, sr=self.sr)

                stems = carve_dialogue_pocket(
                    stems,
                    vo_st,
                    spans=dlg['spans'],
                    formant_duck_db=dlg['formant_duck_db'],
                    amb_duck_db=dlg['amb_duck_db'],
                    fx_duck_db=dlg['fx_duck_db'],
                    sr=self.sr,
                )
            stems['vo'] = vo_st

        # 5. 配乐黄金配比控制（需显式 music_ceiling_offset_db，使终混配乐稳立在 -16.0 ~ -17.5 LUFS）与高潮窗释放
        music_narr_trim_db = 0.0
        has_fg_or_vo = has_fg_narr or has_vo_sig
        if (
            self.music_ceiling_offset_db is not None
            and has_fg_or_vo
            and self.dur >= 0.45
            and float(np.abs(stems['music']).max()) > 1e-6
        ):
            other_bus = stems['amb'] + stems['fx'] + stems['foley'] + stems['ui']
            if 'vo' in stems:
                other_bus = other_bus + stems['vo']
            narr_sel = focus_mask < 0.5
            mus_probe = stems['music'][narr_sel] if int(np.sum(narr_sel)) >= int(0.45 * self.sr) else stems['music']
            mus_narr_lufs = integrated(mus_probe)
            if np.isfinite(mus_narr_lufs) and mus_narr_lufs > -68.0 and float(np.abs(other_bus).max()) > 1e-6:
                ceil_lufs = self.target_lufs + float(self.music_ceiling_offset_db) - 0.45
                base_focus = np.minimum(focus_lift_db, 3.0) * focus_mask
                mus_0 = stems['music'] * undb(base_focus)[:, None]
                mus0_whole_lufs = integrated(mus_0)
                eff_mus0_lufs = max(mus_narr_lufs, mus0_whole_lufs - 0.35) if np.isfinite(mus0_whole_lufs) else mus_narr_lufs
                mix0_lufs = integrated(other_bus + mus_0)
                if np.isfinite(mix0_lufs) and mix0_lufs > -68.0:
                    post0 = eff_mus0_lufs + (self.target_lufs - mix0_lufs)
                    if post0 > ceil_lufs + 0.05:
                        other_pk_db = 20.0 * math.log10(max(float(np.abs(other_bus).max()), 1e-9))
                        max_safe_gain = max(0.0, (self.max_tp + 9.5) - other_pk_db)
                        lo_tr, hi_tr = -20.0, 0.0
                        for _ in range(12):
                            mid_tr = 0.5 * (lo_tr + hi_tr)
                            env_db = mid_tr * (1.0 - focus_mask) + np.minimum(3.0, mid_tr + focus_lift_db) * focus_mask
                            cand_mus = stems['music'] * undb(env_db)[:, None]
                            cand_mix_lufs = integrated(other_bus + cand_mus)
                            if not np.isfinite(cand_mix_lufs) or cand_mix_lufs <= -68.0:
                                lo_tr = mid_tr
                                continue
                            req_gain = self.target_lufs - cand_mix_lufs
                            cand_whole_lufs = integrated(cand_mus)
                            cand_eff = max(
                                mus_narr_lufs + mid_tr,
                                (cand_whole_lufs - 0.35) if np.isfinite(cand_whole_lufs) else (mus_narr_lufs + mid_tr),
                            )
                            cand_post = cand_eff + req_gain
                            if cand_post > ceil_lufs and req_gain <= max_safe_gain:
                                hi_tr = mid_tr
                            else:
                                lo_tr = mid_tr
                        music_narr_trim_db = float(lo_tr)
                        env_db = (
                            music_narr_trim_db * (1.0 - focus_mask)
                            + np.minimum(3.0, music_narr_trim_db + focus_lift_db) * focus_mask
                        )
                        stems['music'] = stems['music'] * undb(env_db)[:, None]
                    elif float(np.max(base_focus)) > 0.05:
                        stems['music'] = mus_0
        elif float(np.max(focus_lift_db)) > 0.05 and float(np.abs(stems['music']).max()) > 1e-6:
            stems['music'] = stems['music'] * undb(np.minimum(focus_lift_db, 4.5))[:, None]

        # 5b. 核对有声窗 1–4 kHz 对白清晰度信噪比：若伴奏在共振峰带仍偏厚，仅在 800–4200 Hz 追加微凹槽（绝不动 <350Hz 低频）
        if has_vo_sig and self._dialogue is not None:
            dlg = self._dialogue
            win_n = max(64, int(round(0.050 * self.sr)))
            nw = self.n // win_n
            if nw >= 2:
                vo_w = stems['vo'][:nw * win_n].reshape(nw, win_n, 2)
                vo_w_rms = np.sqrt(np.mean(vo_w * vo_w, axis=(1, 2)) + 1e-24)
                act_w = vo_w_rms > (10.0 ** (-42.0 / 20.0))
                if int(np.sum(act_w)) >= 2:
                    han = np.hanning(win_n)[None, :, None]
                    fq_w = np.fft.rfftfreq(win_n, 1.0 / float(self.sr))
                    m14 = (fq_w >= 1000.0) & (fq_w <= 4000.0)

                    def _band_1k_4k_energy(st_arr):
                        aw = st_arr[:nw * win_n].reshape(nw, win_n, 2)[act_w] * han
                        sp = np.abs(np.fft.rfft(aw, axis=1)) ** 2
                        return float(0.5 * sp[:, m14, :].sum())

                    acc_bus = stems['music'] + stems['amb'] + stems['fx'] + stems['foley'] + stems['ui']
                    e_vo = _band_1k_4k_energy(stems['vo'])
                    e_acc = _band_1k_4k_energy(acc_bus)
                    vo_snr_1k_4k_db = 10.0 * math.log10(max(e_vo, 1e-30) / max(e_acc, 1e-20))
                    if (
                        vo_snr_1k_4k_db < 4.5
                        and dlg['formant_duck_db'] > 0.5
                        and dlg['gain_db'] >= -3.0
                        and e_acc > 1e-18
                    ):
                        extra_dip = min(5.5, (4.5 - vo_snr_1k_4k_db) + 0.8)
                        acc_stems = {k: stems[k] for k in ('music', 'amb', 'fx', 'foley') if k in stems}
                        acc_stems = carve_dialogue_pocket(
                            acc_stems,
                            stems['vo'],
                            spans=dlg['spans'],
                            formant_duck_db=extra_dip,
                            amb_duck_db=extra_dip * 0.75,
                            fx_duck_db=extra_dip * 0.55,
                            sr=self.sr,
                        )
                        stems.update(acc_stems)
                        acc_bus = stems['music'] + stems['amb'] + stems['fx'] + stems['foley'] + stems['ui']
                        e_acc = _band_1k_4k_energy(acc_bus)
                        vo_snr_1k_4k_db = 10.0 * math.log10(max(e_vo, 1e-30) / max(e_acc, 1e-20))

        # 6. 总线粘合压缩与透明母带收口（master_glue=True 走 SSL G-Bus 粘合母带链，分轨保持标量校准增益防跨轨抽吸）
        raw_mix = fade(sum(stems.values()), min(0.02, self.dur * 0.05), min(0.18, self.dur * 0.1))
        raw_i = integrated(raw_mix)
        if (
            self.master_glue
            and self.sr == SR
            and self.n >= int(0.42 * self.sr)
            and float(np.max(np.abs(raw_mix))) > 1e-6
            and raw_i > -68.0
        ):
            master, m_diag, _ = _master_chain_core(
                raw_mix,
                target_lufs=self.target_lufs,
                max_tp=self.max_tp,
                glue=True,
                glue_ratio=2.0,
                max_gr_db=self.glue_max_gr_db,
            )
            low_trim_db = m_diag['lowTrimDb']
            master_gain_db = m_diag['masterGainDb']
            glue_max_gr_db = m_diag['glueMaxGrDb']
            lra_val = m_diag['lra']
            final_lufs = m_diag['finalLufs']
            stem_scale = float(undb(self.target_lufs - raw_i))
        else:
            balanced, low_trim_db = tame_low(raw_mix)
            master, master_gain_db, _ = loudness_to(balanced, self.target_lufs, self.max_tp)
            master[0] = master[-1] = 0.0
            L_acc = Loudness()
            L_acc.feed(master)
            glue_max_gr_db = 0.0
            lra_val = round(float(L_acc.lra()), 2)
            fin_i = integrated(master)
            final_lufs = round(float(fin_i), 2) if np.isfinite(fin_i) else None
            stem_scale = float(undb(master_gain_db))

        # 7. 导出分轨。旧路径只做响度标量缩放（与既有成片一致）；新路径再加逐轨前视真峰值保护。
        out_stems = {}
        stem_tp_limited = []
        if legacy:
            out_stems = {k: v * stem_scale for k, v in stems.items()}
        else:
            tp_ceil_lin = float(undb(self.max_tp))
            for k, v in stems.items():
                st_k = v * stem_scale
                if len(st_k) > 0 and float(np.max(np.abs(st_k))) > 1e-7:
                    if true_peak(st_k, os=4) > tp_ceil_lin or float(np.max(np.abs(st_k))) > tp_ceil_lin:
                        st_k, _ = tp_limit(st_k, self.max_tp, look=0.005, rel=0.10)
                        tp_post = true_peak(st_k, os=4)
                        if tp_post > tp_ceil_lin and tp_post > 0.0:
                            st_k = st_k * (tp_ceil_lin / tp_post)
                        stem_tp_limited.append(k)
                    st_k[0] = 0.0
                    st_k[-1] = 0.0
                out_stems[k] = st_k

        diag = {
            'culledCount': len(culled_ids),
            'culledIds': culled_ids,
            'spectralDucked': ducked_bands,
            'continuousDuckMaxDb': cont_duck_applied_db,
            'musicCeilingOffsetDb': self.music_ceiling_offset_db,
            'musicNarrativeTrimDb': round(float(music_narr_trim_db), 2),
            'glueEq': self.glue_eq,
            'masterGlue': self.master_glue,
            'glueMaxGrDb': glue_max_gr_db,
            'lra': lra_val,
            'finalLufs': final_lufs,
            'stemTpLimited': stem_tp_limited,
            'lowTrimDb': round(float(low_trim_db), 2),
            'masterGainDb': round(float(master_gain_db), 2),
            'dialogueEnabled': bool(self._dialogue is not None),
            'dialogueSnr1k4kDb': round(float(vo_snr_1k_4k_db), 2) if vo_snr_1k_4k_db is not None else None,
        }
        return master, out_stems, diag
