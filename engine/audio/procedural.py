# -*- coding: utf-8 -*-
"""北冥引擎 · 物理因果与风格化音效程序化合成层（Procedural Audio & Stylized Synthesis）。

遵循 Andy Farnell《Designing Sound》与 Perry Cook《Real Sound Synthesis for Interactive Applications》
的「激励源（Exciter）× 共振体（Resonator）× 运动耦合（Motion Coupling）」物理建模范式，
在实录音效库缺少精确材质匹配、需要参数化连续跟随画面运动，或需要跨世界观合成叠层时提供 48 kHz 确定性合成原语。

接口：
  MATERIAL_MODES / PHISEM_MATERIALS / WHOOSH_PROFILES / CARTOON_KINDS
      内置物理材质共振模态表（7 类刚体/腔体）、PhISEM 随机粒子材质表（6 类）、气动破空廓形表（4 类）与卡通原语名录（7 类）
  modal_impact(material='wood_hollow', *, dur=0.35, hardness=0.65, size_scale=1.0,
               damp_scale=1.0, exciter_sample=None, key=None, seed=1) -> (wave, sync_anchor_s)
      非线性赫兹接触锤击激励（或真实录音瞬态混合卷积 Hybrid Foley）× 多模态色散共振体；支持调性主频吸附
  phisem_particles(dur=0.6, *, count=24, density=1.0, material='gravel',
                   damp=0.012, seed=1) -> (wave, sync_anchor_s)
      Perry Cook PhISEM 非齐次泊松粒子群随机碰撞能量模型，支持标量或逐样本密度曲线驱动
  aerodynamic_whoosh(dur=0.32, *, profile='whip', speed_curve=None, diameter_m=0.022,
                     weight=0.5, seed=1) -> (wave, pcenter_anchor_s)
      基于流体涡街脱落 Strouhal 关系（f_s ≈ St·v(t)/d）与偶极子气动功率律（增益 ∝ v(t)^3）的连续破空合成器
  minnaert_bubbles(dur=0.8, *, rate=12.0, radius_mm=(1.5, 6.0), chirp=0.14,
                   depth_lp_hz=6000.0, seed=1) -> (wave, sync_anchor_s)
      物理 Minnaert 气泡共振（f_0 ≈ 3.26 / r_0）及表面张力颈缩/破裂上滑 chirp，用于水下潜流、水墨溶开与药剂沸腾
  stylized_cartoon(kind='boing', *, dur=0.25, intensity=1.0, pitch_hz=320.0,
                   seed=1) -> (wave, sync_anchor_s)
      非写实卡通世界观专用干净合成原语（boing / pop / zip / blink / slide_up / slide_down / bonk）
"""
import math
import numpy as np
from scipy.signal import fftconvolve, lfilter

from .dsp import (
    SR, N, smoothstep, fade, rng, norm, un_safe,
    white, pink, brown, lp, hp, bp, peq, shelf, svf,
)
from .library import sync_anchor


# ———— 1. 刚体与腔体物理共振模态表（Modal Synthesis） ————
# modes 每项为 (频率比 ratio, 相对幅度 amp, 基准衰减时间常数 tau_s)
MATERIAL_MODES = {
    'wood_hollow': {
        'label': '空心木梆 / 硬木腔体',
        'f0': 420.0,
        'modes': (
            (1.000, 1.00, 0.048),
            (1.582, 0.62, 0.034),
            (2.340, 0.40, 0.024),
            (3.185, 0.24, 0.016),
            (4.290, 0.13, 0.011),
            (5.640, 0.07, 0.008),
        ),
        'beat_hz': 0.8,
        'contact_bp': (900.0, 5200.0),
        'contact_mix': 0.34,
    },
    'bamboo': {
        'label': '竹节 / 翠竹空管',
        'f0': 690.0,
        'modes': (
            (1.000, 1.00, 0.056),
            (1.468, 0.72, 0.042),
            (2.195, 0.48, 0.029),
            (2.960, 0.32, 0.020),
            (4.110, 0.19, 0.013),
            (5.580, 0.10, 0.009),
        ),
        'beat_hz': 1.2,
        'contact_bp': (1400.0, 7600.0),
        'contact_mix': 0.40,
    },
    'bronze_bell': {
        'label': '青铜钟磬 / 编钟双音模态',
        'f0': 520.0,
        'modes': (
            (0.500, 0.48, 1.150),
            (1.000, 1.00, 0.880),
            (1.204, 0.66, 0.640),
            (1.502, 0.52, 0.520),
            (2.000, 0.74, 0.410),
            (2.518, 0.38, 0.280),
            (3.012, 0.29, 0.210),
            (4.185, 0.18, 0.135),
        ),
        'beat_hz': 2.1,
        'contact_bp': (1800.0, 9200.0),
        'contact_mix': 0.26,
    },
    'ceramic': {
        'label': '陶瓷茶盏 / 青瓷薄胎',
        'f0': 1160.0,
        'modes': (
            (1.000, 1.00, 0.145),
            (1.838, 0.64, 0.098),
            (2.735, 0.44, 0.068),
            (3.860, 0.28, 0.045),
            (5.140, 0.16, 0.028),
            (6.680, 0.09, 0.018),
        ),
        'beat_hz': 1.6,
        'contact_bp': (2200.0, 11000.0),
        'contact_mix': 0.32,
    },
    'glass_crystal': {
        'label': '水晶玻璃 / 高纯石英杯壁',
        'f0': 1560.0,
        'modes': (
            (1.000, 1.00, 0.520),
            (2.322, 0.56, 0.340),
            (3.825, 0.34, 0.215),
            (5.580, 0.19, 0.130),
            (7.540, 0.10, 0.075),
        ),
        'beat_hz': 1.3,
        'contact_bp': (3000.0, 13800.0),
        'contact_mix': 0.22,
    },
    'metal_plate': {
        'label': '钢板 / 铁砧薄板弯曲色散',
        'f0': 640.0,
        'modes': (
            (1.000, 1.00, 0.310),
            (1.372, 0.74, 0.265),
            (1.934, 0.62, 0.220),
            (2.685, 0.50, 0.175),
            (3.542, 0.38, 0.135),
            (4.620, 0.29, 0.098),
            (5.890, 0.21, 0.072),
            (7.350, 0.14, 0.048),
        ),
        'beat_hz': 2.8,
        'contact_bp': (2000.0, 12400.0),
        'contact_mix': 0.38,
    },
    'stone_slate': {
        'label': '青石板 / 致密岩板',
        'f0': 350.0,
        'modes': (
            (1.000, 1.00, 0.040),
            (1.635, 0.68, 0.028),
            (2.415, 0.46, 0.019),
            (3.385, 0.30, 0.013),
            (4.560, 0.18, 0.009),
            (6.120, 0.11, 0.006),
        ),
        'beat_hz': 0.9,
        'contact_bp': (1600.0, 9800.0),
        'contact_mix': 0.52,
    },
}


# ———— 2. PhISEM 随机粒子碰撞材质表 ————
PHISEM_MATERIALS = {
    'gravel': {
        'label': '碎石 / 砂砾散落踩踏',
        'modes': ((1180.0, 1.00), (2680.0, 0.78), (5350.0, 0.52), (8200.0, 0.28)),
        'ring_mul': 0.95,
        'modal_mix': 0.42,
        'noise_mix': 0.75,
        'noise_bp': (950.0, 9600.0),
        'size_range': (0.68, 1.45),
        'base_rate': 58.0,
        'sys_decay_frac': 0.48,
        'hp_hz': 140.0,
    },
    'coins': {
        'label': '铜钱散落 / 硬币碰撞清鸣',
        'modes': ((2480.0, 1.00), (5240.0, 0.82), (8460.0, 0.60), (11900.0, 0.38)),
        'ring_mul': 3.60,
        'modal_mix': 0.88,
        'noise_mix': 0.30,
        'noise_bp': (2600.0, 13800.0),
        'size_range': (0.86, 1.18),
        'base_rate': 44.0,
        'sys_decay_frac': 0.58,
        'hp_hz': 420.0,
    },
    'glass_shards': {
        'label': '碎玻璃散落 / 冰晶迸溅',
        'modes': ((3150.0, 1.00), (6420.0, 0.76), (9850.0, 0.56), (13600.0, 0.35)),
        'ring_mul': 2.55,
        'modal_mix': 0.82,
        'noise_mix': 0.45,
        'noise_bp': (3200.0, 15200.0),
        'size_range': (0.65, 1.38),
        'base_rate': 52.0,
        'sys_decay_frac': 0.52,
        'hp_hz': 550.0,
    },
    'dry_leaves': {
        'label': '枯叶散落 / 落叶脆响',
        'modes': ((880.0, 0.65), (2250.0, 0.85), (4900.0, 0.70), (7800.0, 0.45)),
        'ring_mul': 0.70,
        'modal_mix': 0.22,
        'noise_mix': 0.92,
        'noise_bp': (720.0, 11800.0),
        'size_range': (0.60, 1.50),
        'base_rate': 74.0,
        'sys_decay_frac': 0.55,
        'hp_hz': 180.0,
    },
    'embers': {
        'label': '炭火噼啪 / 篝火火星爆裂',
        'modes': ((680.0, 0.55), (2150.0, 0.90), (5400.0, 0.80), (9600.0, 0.55)),
        'ring_mul': 0.52,
        'modal_mix': 0.28,
        'noise_mix': 0.95,
        'noise_bp': (1200.0, 13500.0),
        'size_range': (0.55, 1.60),
        'base_rate': 32.0,
        'sys_decay_frac': 0.78,
        'hp_hz': 95.0,
    },
    'beads': {
        'label': '算盘珠 / 硬木积木散落',
        'modes': ((960.0, 1.00), (2120.0, 0.74), (3880.0, 0.44), (5950.0, 0.20)),
        'ring_mul': 1.25,
        'modal_mix': 0.76,
        'noise_mix': 0.42,
        'noise_bp': (1100.0, 8200.0),
        'size_range': (0.82, 1.22),
        'base_rate': 56.0,
        'sys_decay_frac': 0.50,
        'hp_hz': 220.0,
    },
}


# ———— 3. 气动破空廓形表（Strouhal Aeroacoustics） ————
WHOOSH_PROFILES = {
    'whip': {
        'label': '细竹鞭 / 暗器急抽破空',
        'strouhal': 0.21,
        'v_ref': 38.0,
        'q1': 2.65,
        'h2_mul': 2.08,
        'h2_gain': 0.52,
        'q2': 3.20,
        'shear_mul': 3.60,
        'shear_gain': 0.34,
        'sub_gain': 0.22,
        'peak_u': 0.68,
    },
    'heavy_club': {
        'label': '重兵器 / 巨物沉猛掠过',
        'strouhal': 0.19,
        'v_ref': 22.0,
        'q1': 1.35,
        'h2_mul': 1.85,
        'h2_gain': 0.36,
        'q2': 1.75,
        'shear_mul': 2.50,
        'shear_gain': 0.20,
        'sub_gain': 0.92,
        'peak_u': 0.60,
    },
    'wing_gust': {
        'label': '巨翼鼓风 / 扑翼阵风尾流',
        'strouhal': 0.18,
        'v_ref': 18.5,
        'q1': 1.15,
        'h2_mul': 1.72,
        'h2_gain': 0.30,
        'q2': 1.45,
        'shear_mul': 2.25,
        'shear_gain': 0.24,
        'sub_gain': 0.78,
        'peak_u': 0.40,
    },
    'scifi_pass': {
        'label': '科幻能量掠过 / 等离子近场飞掠',
        'strouhal': 0.22,
        'v_ref': 44.0,
        'q1': 3.10,
        'h2_mul': 2.35,
        'h2_gain': 0.48,
        'q2': 3.80,
        'shear_mul': 4.10,
        'shear_gain': 0.28,
        'sub_gain': 0.62,
        'peak_u': 0.52,
    },
}

CARTOON_KINDS = ('boing', 'pop', 'zip', 'blink', 'slide_up', 'slide_down', 'bonk')


def _interp_curve(curve_or_scalar, n: int) -> np.ndarray:
    """将标量或任意长度一维控制序列重采样到 n 个样本。"""
    if np.isscalar(curve_or_scalar):
        return np.full(n, float(curve_or_scalar), dtype=float)
    arr = np.asarray(curve_or_scalar, dtype=float).ravel()
    if len(arr) == 0:
        return np.zeros(n, dtype=float)
    if len(arr) == 1:
        return np.full(n, float(arr[0]), dtype=float)
    if len(arr) == n:
        return arr.copy()
    return np.interp(np.linspace(0.0, 1.0, n), np.linspace(0.0, 1.0, len(arr)), arr)


def modal_impact(
    material: str = 'wood_hollow',
    *,
    dur: float = 0.35,
    hardness: float = 0.65,
    size_scale: float = 1.0,
    damp_scale: float = 1.0,
    exciter_sample=None,
    key: str = None,
    seed: int = 1,
) -> tuple:
    """物理模态敲击合成器（Exciter × Modal Resonator）：
    · material：内置材质名（见 MATERIAL_MODES）；
    · hardness ∈ [0, 1]：非线性赫兹接触刚度（越大接触时长越短、高频模态与接触脆度激发越强）；
    · size_scale：几何尺度倍率（越大模态频率成反比下移 f ∝ 1/size_scale，余振略展宽）；
    · damp_scale：阻尼倍率（越大阻尼越强、衰减越快；越小余音越绵长）；
    · exciter_sample：可选真实录音瞬态切片，传入时执行混合卷积拟音（Hybrid Foley Synthesis）；
    · key：可选调性主音名（如 'D' / 'A'），经 director.harmonic_freq 将主频吸附至协和音级。
    返回 (单声道 float64 波形, sync_anchor_s)。"""
    if material not in MATERIAL_MODES:
        raise ValueError(f"modal_impact：未知材质 {material!r}，可选 {tuple(MATERIAL_MODES)}")

    cfg = MATERIAL_MODES[material]
    r = rng(seed)
    d_sec = max(0.03, float(dur))
    n = max(32, N(d_sec))
    t = np.arange(n, dtype=float) / float(SR)

    h = float(np.clip(hardness, 0.0, 1.0))
    sc = float(np.clip(size_scale, 0.12, 16.0))
    ds = float(np.clip(damp_scale, 0.05, 25.0))

    f0 = float(cfg['f0']) / sc
    if key is not None:
        from .director import harmonic_freq
        f0 = harmonic_freq(f0, root=key)

    # 1. 共振体脉冲响应 h_res(t)：多模态衰减振子簇 + 几何简并微拍频
    h_res = np.zeros(n, dtype=float)
    beat_base = float(cfg['beat_hz']) / (sc ** 0.35)
    onset_ramp = np.minimum(1.0, t / 0.00025)
    for idx_m, (ratio, amp, tau_base) in enumerate(cfg['modes']):
        is_principal = abs(ratio - 1.0) < 1e-6
        detune = 1.0 if (is_principal and key is not None) else float(1.0 + r.uniform(-0.0022, 0.0022))
        fk = f0 * float(ratio) * detune
        if fk < 24.0 or fk >= 0.45 * SR:
            continue
        tau_k = max(0.0018, (float(tau_base) * (sc ** 0.42)) / ds)
        # 锤头越硬，高阶弯曲模态激发权重越高
        ord_exp = max(0.0, math.log2(max(float(ratio), 1.0)))
        hard_weight = (0.28 + 0.96 * h) ** (ord_exp * 0.62)
        env_k = float(amp) * hard_weight * np.exp(-t / tau_k) * onset_ramp
        phi0 = float(r.uniform(0.0, 0.35)) if not is_principal else 0.0
        beat = beat_base * (0.65 + 0.35 * idx_m) * float(r.uniform(0.88, 1.14))
        if is_principal:
            # 主模态对称微拍包络，保证谱峰严格居于 f0 不偏移
            mod = 1.0 + 0.20 * np.cos(2.0 * np.pi * beat * t)
            h_res += env_k * mod * np.sin(2.0 * np.pi * fk * t)
        else:
            phi2 = float(r.uniform(0.0, 2.0 * np.pi))
            twin_f = min(0.455 * SR, fk + beat)
            h_res += env_k * (
                np.sin(2.0 * np.pi * fk * t + phi0)
                + 0.32 * np.sin(2.0 * np.pi * twin_f * t + phi2)
            ) / 1.25

    # 2. 激励源 e(t)：非线性赫兹接触脉冲（F(t) = sin(πt/τ_c)^α）或真实录音瞬态混合激励
    lo_bp, hi_bp = cfg['contact_bp']
    lo_bp = float(np.clip(lo_bp / (sc ** 0.30), 120.0, 0.38 * SR))
    hi_bp = float(np.clip(hi_bp * (0.55 + 0.65 * h) / (sc ** 0.20), lo_bp + 250.0, 0.44 * SR))

    if exciter_sample is not None and len(exciter_sample) > 0:
        s_raw = np.asarray(exciter_sample, dtype=float)
        s_mono = s_raw.mean(axis=1) if s_raw.ndim == 2 else s_raw
        anc_s = sync_anchor(s_mono, SR)
        ia = max(0, int(round(anc_s * SR)) - N(0.012))
        ib = min(len(s_mono), int(round(anc_s * SR)) + N(0.055))
        seg = s_mono[ia:ib].copy()
        if len(seg) < 8:
            seg = s_mono[:min(len(s_mono), N(0.055))].copy()
        seg = fade(norm(seg, 0.95), min(0.0008, len(seg) / SR * 0.15), min(0.014, len(seg) / SR * 0.35))
        if len(seg) > 24 and abs(h - 0.5) > 0.05:
            seg = shelf(seg, 2200.0, float(6.5 * (h - 0.5)), 'high')
        # 真实瞬态卷积激发物理模态 + 表面高频接触索引（MSI）直达对齐
        res_conv = fftconvolve(seg, h_res)[:n]
        msi_dir = bp(seg, lo_bp, hi_bp, 2) if len(seg) > 16 else seg
        out = un_safe(res_conv) * 0.80
        m_len = min(n, len(msi_dir))
        out[:m_len] += un_safe(msi_dir[:m_len]) * float(cfg['contact_mix']) * (0.40 + 0.65 * h) * 0.45
    else:
        # Chaigne-Doutaut 锤体回弹物理约束：最大接触时长受主模态半周期耦合约束（τ_c ≤ 0.72/f0），确保基频恒居主瓣
        tau_max = min(0.0045, 0.72 / max(f0, 60.0))
        tau_c = 0.00010 + tau_max * ((1.0 - h) ** 1.65)
        len_c = max(2, int(round(tau_c * SR)))
        alpha = 1.45 + 0.95 * h
        u_c = (np.arange(len_c, dtype=float) + 0.5) / float(len_c)
        hertz_pulse = np.sin(np.pi * u_c) ** alpha
        hertz_pulse /= max(float(np.sum(hertz_pulse)), 1e-12)

        res_conv = fftconvolve(hertz_pulse, h_res)[:n]
        # 接触瞬间表面微粗糙破碎/敲击宽带瞬态（MSI）
        msi_n = min(n, max(16, int(round(max(0.0035, tau_c * 3.5) * SR))))
        t_m = np.arange(msi_n, dtype=float) / float(SR)
        tau_msi = max(0.0008, 0.0030 * (1.15 - 0.65 * h) * (sc ** 0.25))
        msi_raw = bp(white(msi_n, r), lo_bp, hi_bp, 2)
        msi_burst = un_safe(msi_raw) * np.minimum(1.0, t_m / 0.0003) * np.exp(-t_m / tau_msi)

        out = un_safe(res_conv) * 0.85
        out[:msi_n] += msi_burst * float(cfg['contact_mix']) * (0.12 + 0.98 * (h ** 1.45)) * 0.55

    out = hp(out, 22.0, 1)
    out = fade(out, 0.0004, min(0.022, d_sec * 0.16))
    peak_lvl = float(0.68 + 0.24 * h)
    out = norm(out, min(0.92, peak_lvl))
    anc = sync_anchor(out, SR)
    return out, float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))


def phisem_particles(
    dur: float = 0.6,
    *,
    count: int = 24,
    density=1.0,
    material: str = 'gravel',
    damp: float = 0.012,
    seed: int = 1,
) -> tuple:
    """Perry Cook PhISEM 随机粒子群碰撞能量模型：
    · count：系统中参与碰撞的有效粒子数（越大单位时间碰撞率越高）；
    · density：标量（初始散落动能强度）或一维曲线（外部运动连续注入动能，如踩碎石、摇算盘、拨炭火）；
    · material：内置粒子材质（gravel / coins / glass_shards / dry_leaves / embers / beads）；
    · damp：单粒碰撞基准衰减时间常数（秒，默认 0.012 即 12 ms）。
    返回 (单声道 float64 波形, sync_anchor_s)。"""
    if material not in PHISEM_MATERIALS:
        raise ValueError(f"phisem_particles：未知材质 {material!r}，可选 {tuple(PHISEM_MATERIALS)}")

    cfg = PHISEM_MATERIALS[material]
    r = rng(seed)
    d_sec = max(0.04, float(dur))
    n = max(32, N(d_sec))
    t = np.arange(n, dtype=float) / float(SR)
    cnt = max(1, int(round(count)))
    tau_base = float(np.clip(damp, 0.0012, 0.25))

    # 1. 系统动能包络 E(t)
    if np.isscalar(density):
        d_val = max(0.0, float(density))
        sys_tau = max(0.07, d_sec * float(cfg['sys_decay_frac']))
        atk = smoothstep(0.0, min(0.010, d_sec * 0.08), t)
        e_curve = d_val * atk * (0.78 * np.exp(-t / sys_tau) + 0.22 * np.exp(-t / (sys_tau * 2.1)))
    else:
        d_arr = np.maximum(0.0, _interp_curve(density, n))
        # 一阶动能惯性池（约 16 ms 弛豫），平顺承接外部运动曲线并在停止时自然收拢
        pole = math.exp(-1.0 / max(1.0, 0.016 * SR))
        e_smooth = lfilter([1.0 - pole], [1.0, -pole], d_arr)
        e_curve = np.maximum(d_arr * 0.85, e_smooth)

    if float(np.max(e_curve)) <= 1e-8:
        return np.zeros(n, dtype=float), 0.0

    # 2. 时间重标度定理（Time-Rescaling）精确采样非齐次泊松碰撞时刻
    lam = float(cfg['base_rate']) * ((cnt / 24.0) ** 0.85) * (np.clip(e_curve, 0.0, 6.0) ** 0.90)
    cum_hazard = np.cumsum(lam) / float(SR)
    tot_hazard = float(cum_hazard[-1])

    hit_indices = []
    cur_h = 0.0
    max_events = max(32, int(d_sec * 650))
    while len(hit_indices) < max_events:
        cur_h += float(r.exponential(1.0))
        if cur_h >= tot_hazard:
            break
        idx = int(np.searchsorted(cum_hazard, cur_h, side='left'))
        if 0 <= idx < n - 8:
            hit_indices.append(idx)

    if not hit_indices and tot_hazard > 1e-3:
        hit_indices.append(min(n - 16, int(np.argmax(lam))))

    # 预先生成一条宽带微破碎噪声供各颗粒切片复用，避免逐颗粒反复做全长 IIR 建滤波器
    lo_n, hi_n = cfg['noise_bp']
    noise_pool = un_safe(bp(white(max(n, N(0.35)), r), lo_n, min(hi_n, 0.44 * SR), 2))
    pool_len = len(noise_pool)

    out = np.zeros(n, dtype=float)
    modal_mix = float(cfg['modal_mix'])
    noise_mix = float(cfg['noise_mix'])
    sz_lo, sz_hi = cfg['size_range']

    for i0 in hit_indices:
        e_loc = float(e_curve[i0])
        vel = math.sqrt(max(e_loc, 1e-5)) * float(r.uniform(0.45, 1.38))
        sz = float(r.uniform(sz_lo, sz_hi))
        tau_g = tau_base * float(cfg['ring_mul']) * (sz ** 0.55) * float(r.uniform(0.72, 1.30))
        m = min(n - i0, max(16, N(min(0.22, 5.2 * tau_g))))
        tg = np.arange(m, dtype=float) / float(SR)
        atk_g = np.minimum(1.0, tg / 0.00035)

        grain = np.zeros(m, dtype=float)
        if modal_mix > 0.01:
            g_mod = np.zeros(m, dtype=float)
            for k_idx, (f_nom, a_nom) in enumerate(cfg['modes']):
                fk = (float(f_nom) / sz) * float(r.uniform(0.97, 1.03))
                if fk >= 0.44 * SR:
                    continue
                tk_dec = max(0.001, tau_g / (1.0 + 0.38 * k_idx))
                ph = float(r.uniform(0.0, 2.0 * np.pi))
                g_mod += float(a_nom) * np.exp(-tg / tk_dec) * np.sin(2.0 * np.pi * fk * tg + ph)
            grain += modal_mix * g_mod

        if noise_mix > 0.01:
            n_off = int(r.integers(0, max(1, pool_len - m)))
            tau_n = max(0.0008, tau_g * (0.42 if material != 'dry_leaves' else 0.85))
            grain += noise_mix * noise_pool[n_off:n_off + m] * np.exp(-tg / tau_n)

        out[i0:i0 + m] += grain * atk_g * vel

    # 炭火噼啪叠加微弱暖炭热流底衬（随动能曲线起伏，无周期调性）
    if material == 'embers':
        hearth = un_safe(lp(brown(n, r), 190.0, 2)) * np.clip(e_curve, 0.0, 1.5) * 0.08
        out += hearth

    out = hp(out, float(cfg['hp_hz']), 1)
    out = fade(out, min(0.002, d_sec * 0.04), min(0.018, d_sec * 0.12))
    e_pk = float(np.max(e_curve))
    target_pk = float(min(0.92, 0.90 * (e_pk / (e_pk + 0.28))))
    out = norm(out, target_pk)
    anc = sync_anchor(out, SR)
    return out, float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))


def aerodynamic_whoosh(
    dur: float = 0.32,
    *,
    profile: str = 'whip',
    speed_curve=None,
    diameter_m: float = 0.022,
    weight: float = 0.5,
    seed: int = 1,
) -> tuple:
    """气动涡街破空合成器（Strouhal Vortex Shedding + Curle Dipole Power Law）：
    · 物理关系：主涡街脱落中心频率 f_s(t) = St · v(t) / d，气动偶极子声压包络正比于 v(t)^3；
    · profile：'whip'（细竹鞭/暗器）、'heavy_club'（重兵器/巨物掠过）、'wing_gust'（巨翼鼓风）、'scifi_pass'（科幻能量掠过）；
    · speed_curve：可选外部逐样本或关键点速度曲线（既支持 0..1 归一化运动学速度，也支持 m/s 物理线速度，全程严格单调映射）；
    · diameter_m：掠过物体特征截面直径（米，越小越尖锐清啸，越大越深沉）；
    · weight：质量/气压厚度权重（控制超低频排空层与阻尼）。
    返回 (单声道 float64 波形, pcenter_anchor_s)。"""
    if profile not in WHOOSH_PROFILES:
        raise ValueError(f"aerodynamic_whoosh：未知廓形 {profile!r}，可选 {tuple(WHOOSH_PROFILES)}")

    cfg = WHOOSH_PROFILES[profile]
    r = rng(seed)
    d_sec = max(0.04, float(dur))
    n = max(32, N(d_sec))
    t = np.arange(n, dtype=float) / float(SR)
    u = t / d_sec

    d_m = max(0.0015, float(diameter_m))
    w_val = float(np.clip(weight, 0.0, 3.0))
    v_ref = float(cfg['v_ref'])

    # 1. 瞬时气流相对速度 v(t) (m/s)
    if speed_curve is None:
        if profile == 'whip':
            s_env = (smoothstep(0.0, 0.68, u) ** 2.05) * (1.0 - smoothstep(0.68, 1.0, u) ** 1.25)
        elif profile == 'heavy_club':
            s_env = (smoothstep(0.0, 0.60, u) ** 1.55) * (1.0 - smoothstep(0.60, 1.0, u) ** 1.15)
        elif profile == 'wing_gust':
            s_env = (smoothstep(0.0, 0.40, u) ** 1.35) * np.exp(-np.maximum(0.0, u - 0.40) * 2.9) * (1.0 - smoothstep(0.86, 1.0, u))
        else:  # scifi_pass
            s_env = np.exp(-((u - 0.52) / 0.21) ** 2) * smoothstep(0.0, 0.14, u) * (1.0 - smoothstep(0.86, 1.0, u))
        v_mps = v_ref * s_env
    else:
        spd = np.maximum(0.0, _interp_curve(speed_curve, n))
        # C^∞ 光滑严格单调递增速度映射：兼容 0..1 画面归一化速率与 5..80 m/s 物理线速度，零分段跳变
        v_mps = v_ref * (spd / (spd + 0.85)) + 0.92 * spd

    v_max = float(np.max(v_mps))
    if v_max <= 1e-7:
        return np.zeros(n, dtype=float), float(0.5 * d_sec)

    # 2. Strouhal 涡街脱落频率 f_s(t) ≈ St · v(t) / d 与 v(t)^3 偶极子气动包络
    st_num = float(cfg['strouhal']) / ((0.75 + 0.50 * w_val) ** 0.22)
    fs_raw = st_num * v_mps / d_m
    fs_curve = np.clip(fs_raw, 32.0, 0.41 * SR)

    # Curle 气动偶极子声压幅值正比于马赫数三次方（即 ∝ v(t)^3）
    env_v3 = (v_mps / v_max) ** 3.0

    # 3. 多尺度尾流湍流滤波组
    vortex_main = un_safe(svf(pink(n, r), fs_curve, float(cfg['q1']), 'bp'))
    fc_wake2 = np.clip(fs_curve * float(cfg['h2_mul']), 65.0, 0.43 * SR)
    vortex_wake2 = un_safe(svf(white(n, r), fc_wake2, float(cfg['q2']), 'bp')) * float(cfg['h2_gain'])
    fc_shear = np.clip(320.0 + fs_curve * float(cfg['shear_mul']), 280.0, 0.43 * SR)
    shear_layer = un_safe(svf(white(n, r), fc_shear, 1.55, 'bp')) * float(cfg['shear_gain'])

    # 近场排空质量低频气压层（受 weight 控制）
    fc_sub = np.clip(48.0 + 0.32 * fs_curve, 38.0, 260.0)
    sub_layer = un_safe(svf(brown(n, r), fc_sub, 0.78, 'lp')) * float(cfg['sub_gain']) * (0.25 + 1.15 * w_val)

    x = vortex_main + vortex_wake2 + shear_layer + sub_layer

    if profile == 'scifi_pass':
        # 科幻飞掠：叠加掠过中心向下折变的多普勒等离子波导谐振层
        u_pk = float(np.argmax(v_mps)) / float(max(1, n - 1))
        dop_warp = 1.26 - 0.44 * smoothstep(max(0.0, u_pk - 0.20), min(1.0, u_pk + 0.20), u)
        f_sci = np.clip(fs_curve * dop_warp, 70.0, 0.40 * SR)
        ph_sci = 2.0 * np.pi * np.cumsum(f_sci) / float(SR)
        sci_tone = 0.34 * np.sin(ph_sci) + 0.16 * np.sin(2.0 * ph_sci + 0.7)
        x = x * 0.78 + un_safe(sci_tone) * 0.46

    x = x * env_v3
    x = hp(x, 24.0, 1)
    x = fade(x, min(0.006, d_sec * 0.08), min(0.012, d_sec * 0.10))

    # 保留跨速度档位的物理响度增长趋势，同时软顶限幅确保峰值 ≤ 0.92 零削波
    target_pk = float(0.92 * ((v_max / (v_max + 7.5)) ** 1.35))
    x = norm(x, max(0.02, min(0.92, target_pk)))

    # 感知冲击中心（P-Center）：平滑气动功率峰值处（速度恒定时退化为中心点）
    if float(env_v3.max() - env_v3.min()) > 1e-3:
        w_sm = max(4, N(0.005))
        sm_env = np.convolve(env_v3, np.ones(w_sm) / float(w_sm), mode='same')
        pcenter_s = float(np.argmax(sm_env)) / float(SR)
    else:
        pcenter_s = float(0.5 * d_sec)
    return x, float(np.clip(pcenter_s, 0.0, (len(x) - 1) / float(SR)))


def minnaert_bubbles(
    dur: float = 0.8,
    *,
    rate: float = 12.0,
    radius_mm=(1.5, 6.0),
    chirp: float = 0.14,
    depth_lp_hz: float = 6000.0,
    seed: int = 1,
) -> tuple:
    """物理 Minnaert 气泡流合成器（Minnaert 1933 / Devin 1959 / van den Doel 2005）：
    · 共振基频严格遵循常压水体 Minnaert 关系：f_0 = 3.26 / r_0（r_0 单位为米，即 3260 / r_mm Hz）；
    · chirp：气泡脱离液颈或浮升破裂时附加流体质量减小引起的频率上滑比例；
    · radius_mm：气泡半径范围 (min_mm, max_mm) 或单一标量毫米值；
    · depth_lp_hz：水深/墨液介质高频吸收截止频率（Hz）。
    返回 (单声道 float64 波形, sync_anchor_s)。"""
    r = rng(seed)
    d_sec = max(0.05, float(dur))
    n = max(32, N(d_sec))

    if np.isscalar(radius_mm):
        r_lo = r_hi = max(0.25, float(radius_mm))
    else:
        r_a, r_b = float(radius_mm[0]), float(radius_mm[1])
        r_lo, r_hi = max(0.25, min(r_a, r_b)), max(0.25, max(r_a, r_b))

    lam = max(0.0, float(rate))
    if lam <= 1e-6:
        return np.zeros(n, dtype=float), 0.0

    # 泊松到达时刻生成（若短时长低密度碰巧未采样到事件，保底在前半段生成 1 颗气泡）
    arrivals = []
    cur_t = 0.0
    t_limit = max(0.01, d_sec - 0.012)
    while len(arrivals) < max(32, int(d_sec * 400)):
        cur_t += float(r.exponential(1.0 / lam))
        if cur_t >= t_limit:
            break
        arrivals.append(cur_t)
    if not arrivals:
        arrivals.append(float(r.uniform(0.06 * d_sec, 0.38 * d_sec)))

    out = np.zeros(n, dtype=float)
    chirp_base = float(np.clip(chirp, -0.45, 2.5))
    log_lo, log_hi = math.log(r_lo), math.log(r_hi)

    for tb in arrivals:
        i0 = min(n - 16, max(0, int(round(tb * SR))))
        r_mm = math.exp(float(r.uniform(log_lo, log_hi))) if r_hi > r_lo * 1.0001 else r_lo
        r_m = r_mm * 1e-3
        # Minnaert 气泡单极体模共振公式：f_0 ≈ 3.26 / r_0
        f0 = float(np.clip(3.26 / r_m, 45.0, 0.42 * SR))
        # Devin 热/辐射/粘滞总阻尼推导的衰减常数 τ_b（大泡低沉绵长，微泡清脆短促）
        damping_rate = 0.043 * f0 + 0.00072 * (f0 ** 1.5)
        tau_b = float(np.clip(1.0 / max(damping_rate, 6.0), 0.0035, 0.14))

        m = min(n - i0, max(16, N(min(0.26, 6.0 * tau_b))))
        tg = np.arange(m, dtype=float) / float(SR)
        c_eff = chirp_base * float(r.uniform(0.88, 1.15))
        f_inst = np.clip(f0 * (1.0 + c_eff * ((tg / tau_b) ** 1.12)), 35.0, 0.44 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)

        env = smoothstep(0.0, min(0.0014, tau_b * 0.35), tg) * np.exp(-tg / tau_b)
        # 主单极腔模 + 微弱液膜脱扣瞬态，保证清透液体质感且不偏离 Minnaert 基频
        pinch = np.exp(-tg / 0.0009) * float(r.uniform(-0.08, 0.08))
        amp = ((r_mm / 3.0) ** 0.52) * float(r.uniform(0.68, 1.15))
        bub = (np.sin(ph) + 0.05 * np.sin(2.0 * ph) + pinch) * env * amp
        out[i0:i0 + m] += bub

    if depth_lp_hz is not None and float(depth_lp_hz) < 0.44 * SR:
        out = lp(out, max(180.0, float(depth_lp_hz)), 4)
    out = hp(out, 28.0, 1)
    out = fade(out, min(0.003, d_sec * 0.04), min(0.018, d_sec * 0.12))
    out = norm(out, 0.90)
    anc = sync_anchor(out, SR)
    return out, float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))


def stylized_cartoon(
    kind: str = 'boing',
    *,
    dur: float = 0.25,
    intensity: float = 1.0,
    pitch_hz: float = 320.0,
    seed: int = 1,
) -> tuple:
    """非写实卡通世界观专用干净合成原语（零底噪、限带防混叠、可独奏或叠层实录）：
    · kind ∈ {'boing', 'pop', 'zip', 'blink', 'slide_up', 'slide_down', 'bonk'}；
    · intensity：夸张度/弹性调制深度/泛音亮度（默认 1.0）；
    · pitch_hz：基准音高频率（Hz，越大整体音调越高）。
    返回 (单声道 float64 波形, sync_anchor_s)。"""
    if kind not in CARTOON_KINDS:
        raise ValueError(f"stylized_cartoon：未知原语类型 {kind!r}，可选 {CARTOON_KINDS}")

    r = rng(seed)
    d_sec = max(0.035, float(dur))
    n = max(32, N(d_sec))
    t = np.arange(n, dtype=float) / float(SR)
    u = t / d_sec
    inten = float(np.clip(intensity, 0.1, 3.0))
    f0 = float(np.clip(pitch_hz, 40.0, 0.35 * SR))

    out = np.zeros(n, dtype=float)

    if kind == 'boing':
        # 弹簧 Q 弹（口簧共振峰扫频 + 阻尼弹性颤音上扬）
        vib_hz = 15.0 + 5.5 * inten
        vib = 0.18 * inten * np.exp(-t / (0.55 * d_sec)) * np.sin(2.0 * np.pi * vib_hz * t)
        glide = 0.76 + 0.52 * (1.0 - np.exp(-t / max(0.018, 0.16 * d_sec)))
        f_inst = np.clip(f0 * glide * (1.0 + vib), 35.0, 0.42 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)
        # 口腔“bo-i-ing”哇音共振峰随弹性张开
        f_wah = f0 * (1.8 + (3.2 * inten) * smoothstep(0.0, 0.42, u) * np.exp(-u * 0.8))
        for k in range(1, 8):
            fk = k * f_inst
            if float(np.min(fk)) >= 0.43 * SR:
                break
            bw = np.maximum(140.0, 0.48 * f_wah)
            formant_w = 0.22 + 1.15 / (1.0 + ((fk - f_wah) / bw) ** 2)
            nyq_mask = smoothstep(0.44 * SR, 0.36 * SR, fk)
            out += (1.0 / (k ** 0.78)) * formant_w * nyq_mask * np.sin(k * ph + float(r.uniform(0.0, 0.4)))
        env = smoothstep(0.0, min(0.003, 0.04 * d_sec), t) * np.exp(-t / max(0.04, 0.46 * d_sec))
        out *= env

    elif kind == 'pop':
        # 气泡/拔塞清脆啵声（快速指数上滑纯圆润液滴腔音 + 微弱唇齿气扑）
        pop_tau = min(max(0.016, 0.22 * d_sec), 0.055)
        span_mul = 1.85 + 0.65 * inten
        f_inst = np.clip(f0 * (0.62 + span_mul * (1.0 - np.exp(-t / (pop_tau * 0.52)))), 40.0, 0.42 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)
        env = smoothstep(0.0, 0.0012, t) * np.exp(-t / pop_tau)
        puff = un_safe(bp(white(n, r), min(6000.0, max(500.0, f0 * 1.5)), min(12000.0, max(1800.0, f0 * 5.0)), 2))
        out = (np.sin(ph) + 0.18 * np.sin(2.0 * ph)) * env + puff * np.exp(-t / 0.0022) * 0.14 * inten

    elif kind == 'zip':
        # 极速蹿出（指数加速陡升哨音 + 紧致气动尾丝，挖除 3.5 kHz 刺耳峰）
        ratio_top = min(0.40 * SR / f0, 4.5 + 3.8 * inten)
        f_inst = np.clip(f0 * (ratio_top ** (u ** 1.65)), 45.0, 0.42 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)
        env = smoothstep(0.0, 0.08, u) * ((0.35 + 0.65 * u) ** 1.1) * (1.0 - smoothstep(0.86, 1.0, u))
        whistle = np.sin(ph) + 0.24 * smoothstep(0.43 * SR, 0.35 * SR, 2.0 * f_inst) * np.sin(2.0 * ph)
        swish = un_safe(svf(white(n, r), np.clip(f_inst * 1.15, 250.0, 0.42 * SR), 3.6, 'bp')) * 0.26
        out = peq((whistle + swish) * env, 3500.0, -5.0, q=1.3)

    elif kind == 'blink':
        # 眨眼双音星芒（清透双粒大三度/纯四度钢片琴星光叮叮）
        f_n1 = float(np.clip(f0 * 2.5, 220.0, 0.36 * SR))
        f_n2 = float(np.clip(f_n1 * (1.26 + 0.08 * min(inten, 1.5)), 260.0, 0.41 * SR))
        gap_s = float(np.clip(0.24 * d_sec, 0.028, 0.075))
        for delay_s, fq, g_note in ((0.0, f_n1, 0.78), (gap_s, f_n2, 1.00)):
            i0 = min(n - 8, int(round(delay_s * SR)))
            m = n - i0
            tn = np.arange(m, dtype=float) / float(SR)
            atk = smoothstep(0.0, 0.0012, tn)
            dec = np.exp(-tn / max(0.018, 0.30 * d_sec))
            note = np.sin(2.0 * np.pi * fq * tn)
            if fq * 2.0 < 0.43 * SR:
                note += 0.25 * inten * np.sin(2.0 * np.pi * (fq * 2.0) * tn) * np.exp(-tn / max(0.010, 0.16 * d_sec))
            if fq * 3.0 < 0.43 * SR:
                note += 0.10 * inten * np.sin(2.0 * np.pi * (fq * 3.0) * tn) * np.exp(-tn / max(0.007, 0.10 * d_sec))
            out[i0:i0 + m] += g_note * atk * dec * note
        out = peq(out, 3500.0, -4.0, q=1.3)

    elif kind in ('slide_up', 'slide_down'):
        # 滑稽滑管哨（Slide Whistle 上滑 / 下滑，带柔和管口呼吸气边与微颤音）
        span = 1.85 + 0.75 * inten
        if kind == 'slide_up':
            curve_u = smoothstep(0.0, 0.92, u)
            f_inst = np.clip(f0 * (0.72 * (span ** curve_u)), 45.0, 0.41 * SR)
        else:
            curve_u = smoothstep(0.0, 0.94, u)
            f_inst = np.clip(f0 * ((0.52 * span) / (span ** (0.85 * curve_u))), 40.0, 0.41 * SR)
        vib = 1.0 + 0.018 * inten * np.sin(2.0 * np.pi * 9.5 * t)
        f_inst = np.clip(f_inst * vib, 40.0, 0.42 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)
        env = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.88, 1.0, u))
        flute = np.sin(ph) + 0.22 * smoothstep(0.43 * SR, 0.35 * SR, 2.0 * f_inst) * np.sin(2.0 * ph)
        breath = un_safe(svf(pink(n, r), np.clip(f_inst * 1.5, 220.0, 0.40 * SR), 2.8, 'bp')) * 0.08
        out = (flute + breath) * env

    else:  # bonk
        # 空心敲头（椰壳/木葫芦双腔模态 + 16ms 滑稽微上弯音高 + 木槌脆点）
        bend = 0.86 + 0.22 * min(inten, 2.0) * (1.0 - np.exp(-t / 0.014))
        f1 = np.clip(f0 * bend, 45.0, 0.40 * SR)
        f2 = np.clip(f0 * 1.62 * bend, 70.0, 0.42 * SR)
        f3 = np.clip(f0 * 2.48, 100.0, 0.43 * SR)
        ph1 = 2.0 * np.pi * np.cumsum(f1) / float(SR)
        ph2 = 2.0 * np.pi * np.cumsum(f2) / float(SR)
        ph3 = 2.0 * np.pi * np.cumsum(f3) / float(SR)
        tau1 = max(0.022, 0.24 * d_sec)
        body = (
            1.00 * np.sin(ph1) * np.exp(-t / tau1)
            + 0.58 * np.sin(ph2) * np.exp(-t / (tau1 * 0.65))
            + 0.26 * inten * np.sin(ph3) * np.exp(-t / (tau1 * 0.38))
        ) * smoothstep(0.0, 0.0008, t)
        knock_n = min(n, N(0.012))
        tk = np.arange(knock_n, dtype=float) / float(SR)
        knock = un_safe(bp(white(knock_n, r), max(350.0, f0 * 0.9), min(6800.0, max(1600.0, f0 * 6.5)), 2))
        out = body
        out[:knock_n] += knock * np.exp(-tk / 0.0022) * 0.38 * min(inten, 2.0)

    out = hp(out, 24.0, 1)
    out = fade(out, min(0.0012, d_sec * 0.04), min(0.014, d_sec * 0.14))
    pk_target = float(min(0.92, 0.72 + 0.14 * min(inten, 1.4)))
    out = norm(out, pk_target)
    anc = sync_anchor(out, SR)
    return out, float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))
