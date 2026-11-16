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
  harmonic_freq(hz, root='D', ...)    把金属剑鸣、钟声、UI 音吸附到配乐调性主干音级（五度/八度/五声和弦音）
  carve_negative_space(n, specs, ...) 在关键事件冲击帧前挖出负空间静默包络 (n, 1)
  render_shot_poa(st, in_s, out_s, dur, poa='fog_wide', ...)  按镜头 POA 自动施加宽度、滤波、近讲搁架、脉冲混响与切出 L-cut
  HDRMixer(dur, fps=24.0, ...)        离线前视感知 HDR 总线：Murch 声部聚簇裁剪 + 6 临界频带动态闪避 + BS.1770 母带收口
"""
import math
import numpy as np
from scipy.signal import butter, sosfiltfilt

from .dsp import (SR, smoothstep, undb, fade, stereo, place, space_place,
                  width as ms_width, lp, hp, shelf, make_ir, reverb)
from .mixing import window as shot_window, tail_after, match_level, tame_low, loudness_to


def _zero_phase_bp(x: np.ndarray, lo: float, hi: float, sr: int = SR, order: int = 2) -> np.ndarray:
    """零相位双向带通提取：全频段相位差恒为 0°，从原信号减去 band_sig * depth 时精确衰减目标临界频带而不产生边缘相移鼓包。"""
    nyq = 0.5 * sr
    sos = butter(order, [max(20.0, lo) / nyq, min(hi, sr * 0.46) / nyq], btype='band', output='sos')
    return sosfiltfilt(sos, x, axis=0)

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
    'subtle_ui': {'priority': 76.0, 'target_lufs': -31.5, 'bus': 'ui', 'duck_db': 2.0},
    'support': {'priority': 70.0, 'target_lufs': -21.5, 'bus': 'fx', 'duck_db': 4.5},
    'texture': {'priority': 42.0, 'target_lufs': -28.5, 'bus': 'fx', 'duck_db': 0.0},
}


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
    """离线前视感知 HDR 混音器（EA DICE Frostbite HDR + Walter Murch 2.5 声部法则 + 6 临界频带零相位侧链闪避）。"""

    def __init__(self, dur: float, *, fps: float = 24.0, sr: int = SR, target_lufs: float = -14.0,
                 max_tp: float = -1.5, murch_limit: int = 2, telemetry=None):
        self.dur = float(dur)
        self.fps = float(fps)
        self.sr = int(sr)
        self.n = int(round(self.dur * self.sr))
        self.target_lufs = float(target_lufs)
        self.max_tp = float(max_tp)
        self.murch_limit = max(1, int(murch_limit))
        self.telemetry = telemetry
        self.beds = {'amb': np.zeros((self.n, 2)), 'music': np.zeros((self.n, 2))}
        self._cues = []
        self._vacuums = []
        self._ir_cache = {}

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
                t0: float = 0.0, t1: float = None, gain_db: float = 0.0):
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
        self.beds[b] += full

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
                target_lufs: float = None, gain_db: float = 0.0, pan=None, dist: float = None,
                poa: str = None, duck_db: float = None, track_name: str = 'screen',
                shot_scale: str = None):
        rd = ROLE_DEFAULTS.get(role, ROLE_DEFAULTS['support'])
        prio = float(rd['priority'] if priority is None else priority)
        b_name = str(bus or rd['bus'])
        tgt = rd['target_lufs'] if target_lufs is None else float(target_lufs)
        dk = float(rd['duck_db'] if duck_db is None else duck_db)
        cap = SHOT_PAN_CAP.get(shot_scale, SHOT_PAN_CAP['medium']) if shot_scale is not None else None

        # 若未显式指定声像且挂载了页面真遥测，自动从画面运动重心读取该冲击时刻的横向位置，并按景别上限收束（防微距斜拍极左/极右偏斜）
        if pan is None and self.telemetry is not None:
            tr = self.telemetry.get(track_name)
            auto_cap = SHOT_PAN_CAP['medium'] if cap is None else cap
            pan_curve = tr.pan('x', spread=min(0.80, auto_cap * 1.4))
            idx = int(np.clip(round(float(t_hit) * self.sr), 0, len(pan_curve) - 1))
            pan = float(np.clip(pan_curve[idx], -auto_cap, auto_cap))
            mot_curve = tr.arr('motion', default=0.5)
            prio += 4.0 * float(mot_curve[min(idx, len(mot_curve) - 1)])
        elif pan is not None and cap is not None and np.ndim(pan) == 0:
            pan = float(np.clip(float(pan), -cap, cap))
        pan_val = 0.0 if pan is None else pan

        self._cues.append({
            'id': str(cue_id),
            'wave': np.asarray(wave, dtype=float),
            't_hit': float(t_hit),
            'anchor': float(anchor),
            'role': role,
            'priority': prio,
            'bus': b_name,
            'target_lufs': tgt,
            'gain_db': float(gain_db),
            'pan': pan_val,
            'dist': dist,
            'poa': poa,
            'duck_db': dk,
        })

    def render(self) -> tuple:
        """执行声部聚簇裁剪 → 逐事件摆位定电平 → 负空间抽空 → 6 临界频带侧链闪避 → 母带收口。
        返回 (mix, stems_dict, diagnostics_dict)。"""
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
            'ui': np.zeros((self.n, 2), dtype=float),
        }
        fg_events = []

        # 2. 放置全部离散事件（UI 编码层强制直达干声；世界内事件按 POA 空间同化）
        for c in cues:
            w = c['wave']
            if c['_demoted']:
                w = shelf(w, 3600.0, -3.5, 'high') * undb(-5.5)
            at_s = c['t_hit'] - c['anchor']
            elem = np.zeros((self.n, 2), dtype=float)
            if c['role'] == 'ui' or c['poa'] == 'subjective_internal':
                st_w = stereo(w, c['pan']) if w.ndim == 1 else w
                place(elem, st_w, at_s, 1.0)
            elif c['poa'] in POA_PRESETS or c['dist'] is not None:
                p_cfg = POA_PRESETS.get(c['poa'], POA_PRESETS['fog_wide'])
                d_val = float(c['dist']) if c['dist'] is not None else float(p_cfg['dist_m'])
                ir, wet = self._get_ir(c['poa'])
                space_place(elem, w, at_s, gain=1.0, pan=c['pan'], dist=d_val, ir=ir, wet=wet)
            else:
                if w.ndim == 1:
                    place(elem, w, at_s, 1.0, c['pan'])
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
            if c['_demoted']:
                elem = elem * undb(-4.5)

            b_key = c['bus'] if c['bus'] in stems else 'fx'
            stems[b_key] += elem
            if c['duck_db'] > 0.5 and not c['_demoted']:
                fg_events.append((c, elem))

        # 3. 峰值前负空间抽空（Randy Thom 法则：先于频带闪避作用在环境与配乐声床上）
        if self._vacuums:
            vac_env = carve_negative_space(self.n, self._vacuums, fps=self.fps, sr=self.sr)
            stems['amb'] = stems['amb'] * vac_env
            stems['music'] = stems['music'] * (0.35 + 0.65 * vac_env)

        # 4. 离线前视 6 临界频带动态让位（Spectral Ducking）：只挖前景主能量频带，不抽吸低频底盘
        ducked_bands = {}
        t_axis = np.arange(self.n, dtype=float) / float(self.sr)
        bg_sum = stems['amb'] + stems['music']
        if fg_events and float(np.abs(bg_sum).max()) > 1e-7:
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
                # 对所有显著前景频带评估竞争比：若背景掩蔽前景，就在该临界频带做零相位前视挖槽
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

        raw_mix = fade(sum(stems.values()), min(0.02, self.dur * 0.05), min(0.18, self.dur * 0.1))
        balanced, low_trim_db = tame_low(raw_mix)
        master, master_gain_db, _ = loudness_to(balanced, self.target_lufs, self.max_tp)
        master[0] = master[-1] = 0.0
        scale = undb(master_gain_db)
        out_stems = {k: v * scale for k, v in stems.items()}
        diag = {
            'culledCount': len(culled_ids),
            'culledIds': culled_ids,
            'spectralDucked': ducked_bands,
            'lowTrimDb': round(float(low_trim_db), 2),
            'masterGainDb': round(float(master_gain_db), 2),
        }
        return master, out_stems, diag
