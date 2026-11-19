# -*- coding: utf-8 -*-
"""北冥引擎 · 物理因果与风格化音效程序化合成层（Procedural Audio & Stylized Synthesis）。

遵循 Andy Farnell《Designing Sound》与 Perry Cook《Real Sound Synthesis for Interactive Applications》
的「激励源（Exciter）× 共振体（Resonator）× 运动耦合（Motion Coupling）」物理建模范式，
在实录音效库缺少精确材质匹配、需要参数化连续跟随画面运动，或需要跨世界观合成叠层时提供 48 kHz 确定性合成原语。

接口：
  MATERIAL_MODES / PHISEM_MATERIALS / WHOOSH_PROFILES / CARTOON_KINDS
  THUNDER_GEOMETRIES / DISC_MATERIALS / BLAST_KINDS
      内置物理材质共振模态表（7 类刚体/腔体）、PhISEM 随机粒子材质表（6 类）、气动破空廓形表（4 类）、
      卡通原语名录（7 类）、雷暴通道几何名录（3 类）、圆片碰撞材质名录（4 类）与冲击波爆破名录（4 类）
  modal_impact(material='wood_hollow', *, dur=0.35, hardness=0.65, size_scale=1.0,
               damp_scale=1.0, exciter_sample=None, key=None, radiation='disp', seed=1) -> (wave, sync_anchor_s)
      非线性赫兹接触锤击激励（或真实录音瞬态混合卷积 Hybrid Foley）× 多模态色散共振体；支持调性主频吸附与无限障板加速度辐射（radiation='accel'）
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
  thunder_strike(dur=3.5, *, distance_m=450.0, geometry='diagonal', branches=5,
                 strokes=2, seed=1) -> (stereo_wave, sync_anchor_s)
      三维曲折先导闪电通道推迟势双耳声传播（Few 1969 N 波冲击子 + 偶极辐射方向图 + ISO 9613-1 分壳层大气高频吸收 + 二次回击）
  pouring_vessel(dur=1.8, *, fill_start=0.12, fill_end=0.88, height_cm=18.0,
                 radius_cm=3.6, flow_rate=0.65, seed=1) -> (wave, sync_anchor_s)
      幂律微气泡群（Minnaert + 脱颈上滑 chirp）与全频带水流湍流激励时变四分之一波长闭底圆筒空气柱（前三阶奇次轴向共振峰连续上扬）
  bouncing_disc(dur=1.2, *, material='coin_brass', bounces=9, spin_tail=True,
                size_scale=1.0, seed=1) -> (stereo_wave, sync_anchor_s)
      微非对称圆薄板简并分裂双音模态（双耳拍频闪烁延伸至 19 kHz）+ 等比恢复弹跳序列 + 欧拉盘有限时间奇点加速滚振与平拍止音
  shock_blast(dur=1.4, *, kind='firework', distance_m=25.0, mach_crack=True,
              seed=1) -> (stereo_wave, sync_anchor_s)
      超音速前导弹道 N 波脆裂 + Friedlander (1946) 冲击波超压方程 + 地面反射梳状凹口与四类场景尾迹（礼花星群/火炮胸腔震荡/拔塞气泡/长鞭音爆）
"""
import math
import numpy as np
from scipy.signal import fftconvolve, lfilter

from .dsp import (
    SR, N, smoothstep, fade, rng, norm, un_safe,
    white, pink, brown, smooth_random, lp, hp, bp, peq, shelf, svf,
    pan_lr, stereo, decor_pair,
)
from .library import sync_anchor

__all__ = [
    'MATERIAL_MODES',
    'PHISEM_MATERIALS',
    'WHOOSH_PROFILES',
    'CARTOON_KINDS',
    'THUNDER_GEOMETRIES',
    'DISC_MATERIALS',
    'BLAST_KINDS',
    'modal_impact',
    'phisem_particles',
    'aerodynamic_whoosh',
    'minnaert_bubbles',
    'stylized_cartoon',
    'thunder_strike',
    'pouring_vessel',
    'bouncing_disc',
    'shock_blast',
]


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
THUNDER_GEOMETRIES = ('overhead', 'diagonal', 'distant_roll')
DISC_MATERIALS = ('coin_brass', 'coin_silver', 'jade_token', 'stone_go')
BLAST_KINDS = ('firework', 'cannon', 'cork_pop', 'whip_crack')

_DISC_CFGS = {
    'coin_brass': {
        'label': '黄铜古钱 / 铜币清脆双音闪烁',
        'f0': 2680.0,
        'modes': (
            (1.000, 1.00, 0.235, 0.0044),
            (1.732, 0.78, 0.175, 0.0052),
            (2.328, 0.62, 0.135, 0.0038),
            (3.910, 0.46, 0.088, 0.0048),
            (5.540, 0.32, 0.056, 0.0035),
            (6.780, 0.22, 0.036, 0.0041),
        ),
        'restitution': 0.76,
        'hardness': 0.82,
        'table_f': 340.0,
        'table_mix': 0.26,
    },
    'coin_silver': {
        'label': '纯银大洋 / 银币绵长澄澈余韵',
        'f0': 2420.0,
        'modes': (
            (1.000, 1.00, 0.410, 0.0026),
            (1.735, 0.82, 0.310, 0.0031),
            (2.332, 0.66, 0.230, 0.0024),
            (3.920, 0.50, 0.150, 0.0029),
            (5.580, 0.36, 0.095, 0.0022),
            (7.180, 0.25, 0.060, 0.0027),
        ),
        'restitution': 0.78,
        'hardness': 0.86,
        'table_f': 360.0,
        'table_mix': 0.22,
    },
    'jade_token': {
        'label': '青玉腰牌 / 玉佩温润晶莹击鸣',
        'f0': 3160.0,
        'modes': (
            (1.000, 1.00, 0.088, 0.0062),
            (1.695, 0.72, 0.064, 0.0070),
            (2.385, 0.54, 0.046, 0.0055),
            (3.760, 0.38, 0.030, 0.0064),
            (5.080, 0.24, 0.019, 0.0050),
            (5.960, 0.15, 0.013, 0.0058),
        ),
        'restitution': 0.72,
        'hardness': 0.78,
        'table_f': 410.0,
        'table_mix': 0.32,
    },
    'stone_go': {
        'label': '围棋云子 / 致密石子落盘脆叩',
        'f0': 1880.0,
        'modes': (
            (1.000, 1.00, 0.026, 0.0092),
            (1.710, 0.68, 0.019, 0.0105),
            (2.540, 0.48, 0.014, 0.0084),
            (4.060, 0.30, 0.009, 0.0096),
            (6.280, 0.18, 0.006, 0.0080),
            (8.350, 0.10, 0.004, 0.0088),
        ),
        'restitution': 0.65,
        'hardness': 0.74,
        'table_f': 290.0,
        'table_mix': 0.52,
    },
}


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
    radiation: str = 'disp',
    seed: int = 1,
) -> tuple:
    """物理模态敲击合成器（Exciter × Modal Resonator）：
    · material：内置材质名（见 MATERIAL_MODES）；
    · hardness ∈ [0, 1]：非线性赫兹接触刚度（越大接触时长越短、高频模态与接触脆度激发越强）；
    · size_scale：几何尺度倍率（越大模态频率成反比下移 f ∝ 1/size_scale，余振略展宽）；
    · damp_scale：阻尼倍率（越大阻尼越强、衰减越快；越小余音越绵长）；
    · exciter_sample：可选真实录音瞬态切片，传入时执行混合卷积拟音（Hybrid Foley Synthesis）；
    · key：可选调性主音名（如 'D' / 'A'），经 director.harmonic_freq 将主频吸附至协和音级；
    · radiation：'disp'（默认，保持历史逐位完全一致）或 'accel'（二阶接触力差分模拟无限障板薄板加速度辐射，基频以下 -12 dB/oct 自然滚降消除软槌低频闷击）。
    返回 (单声道 float64 波形, sync_anchor_s)。"""
    if material not in MATERIAL_MODES:
        raise ValueError(f"modal_impact：未知材质 {material!r}，可选 {tuple(MATERIAL_MODES)}")
    if radiation not in ('disp', 'accel'):
        raise ValueError(f"modal_impact：未知辐射模式 {radiation!r}，可选 ('disp', 'accel')")

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
        if radiation == 'accel':
            seg_exc = np.diff(seg, n=2, prepend=[0.0, 0.0])
            seg_exc /= max(float(np.linalg.norm(seg_exc)), 1e-12)
            res_conv = fftconvolve(seg_exc, h_res)[:n]
            msi_raw_s = bp(seg, lo_bp, hi_bp, 2) if len(seg) > 16 else seg
            msi_dir = np.diff(msi_raw_s, n=2, prepend=[0.0, 0.0])
        else:
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

        if radiation == 'accel':
            exc_accel = np.diff(hertz_pulse, n=2, prepend=[0.0, 0.0], append=[0.0, 0.0])
            exc_accel /= max(float(np.linalg.norm(exc_accel)), 1e-12)
            res_conv = fftconvolve(exc_accel, h_res)[:n]
        else:
            res_conv = fftconvolve(hertz_pulse, h_res)[:n]
        # 接触瞬间表面微粗糙破碎/敲击宽带瞬态（MSI）
        msi_n = min(n, max(16, int(round(max(0.0035, tau_c * 3.5) * SR))))
        t_m = np.arange(msi_n, dtype=float) / float(SR)
        tau_msi = max(0.0008, 0.0030 * (1.15 - 0.65 * h) * (sc ** 0.25))
        msi_raw = bp(white(msi_n, r), lo_bp, hi_bp, 2)
        msi_burst = un_safe(msi_raw) * np.minimum(1.0, t_m / 0.0003) * np.exp(-t_m / tau_msi)
        if radiation == 'accel':
            msi_burst = un_safe(np.diff(msi_burst, n=2, prepend=[0.0, 0.0]))

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


def _make_nwave(tau_s: float, asym: float = 0.86) -> np.ndarray:
    """构造零直流净冲量的双极性 N 波冲击子（Few 1969 / Whitham 1956）：
    激波前沿瞬跳至正压峰，经线性稀疏斜坡跌至负相，再平滑弛豫归零。"""
    n_half = max(2, int(round(max(0.00004, float(tau_s)) * SR)))
    n_rise = max(1, int(round(0.08 * n_half)))
    n_body = max(2, 2 * n_half)
    n_tail = max(2, int(round(0.48 * n_half)))
    if n_rise == 1:
        rise = np.array([1.0], dtype=float)
    else:
        rise = np.linspace(0.38, 1.0, n_rise, endpoint=False)
    body = np.linspace(1.0, -asym, n_body, endpoint=False)
    u_t = np.linspace(0.0, 1.0, n_tail, dtype=float)
    tail = -asym * np.exp(-3.8 * u_t) * (1.0 - u_t)
    w = np.concatenate([rise, body, tail])
    pos_s = float(np.sum(w[w > 0.0]))
    neg_s = float(-np.sum(w[w < 0.0]))
    if pos_s > 1e-12 and neg_s > 1e-12:
        w = np.where(w < 0.0, w * (pos_s / neg_s), w)
    pk = float(np.max(np.abs(w)))
    return w / max(pk, 1e-12)


def _make_friedlander(t_plus_s: float, rise_s: float = 0.00006) -> np.ndarray:
    """构造 Friedlander (1946) 冲击波超压波形 p(t) = p_0 * (1 - t/t_+) * exp(-t/t_+)，严格零净冲量。"""
    tp = max(0.00018, float(t_plus_s))
    m = max(16, int(round(8.2 * tp * SR)))
    t = np.arange(m, dtype=float) / float(SR)
    w = (1.0 - t / tp) * np.exp(-t / tp)
    n_r = int(round(float(rise_s) * SR))
    if n_r >= 2:
        n_r = min(n_r, m // 4)
        w[:n_r] *= np.linspace(0.42, 1.0, n_r)
    taper = 1.0 - smoothstep(0.76 * float(m), float(m - 1), np.arange(m, dtype=float))
    w *= taper
    pos_s = float(np.sum(w[w > 0.0]))
    neg_s = float(-np.sum(w[w < 0.0]))
    if pos_s > 1e-12 and neg_s > 1e-12:
        w = np.where(w < 0.0, w * (pos_s / neg_s), w)
    pk = float(np.max(np.abs(w)))
    return w / max(pk, 1e-12)


def _deposit_frac_1d(buf: np.ndarray, pos: np.ndarray, weights: np.ndarray) -> None:
    """一维亚采样线性插值脉冲沉积（保双耳微时差连续相位）。"""
    n = len(buf)
    valid = (pos >= 0.0) & (pos < float(n - 1))
    if not np.any(valid):
        return
    p = pos[valid]
    w = weights[valid]
    k = np.floor(p).astype(np.int64)
    f = p - k
    np.add.at(buf, k, w * (1.0 - f))
    np.add.at(buf, k + 1, w * f)


def _finalize_stereo(st: np.ndarray, d_sec: float, fin_s: float = 0.0012, fout_s: float = 0.024, peak: float = 0.90) -> tuple[np.ndarray, float]:
    """统一立体声去极低频漂移、零直流校准、首尾防咔嗒淡变与安全峰值归一化。"""
    out = np.asarray(st, dtype=np.float64)
    out = hp(out, 22.0, 1)
    out = out - np.mean(out, axis=0, keepdims=True)
    out = fade(out, min(fin_s, d_sec * 0.04), min(fout_s, d_sec * 0.14))
    out = norm(out, min(0.92, float(peak)))
    anc = sync_anchor(out, SR)
    return np.asarray(out, dtype=np.float64), float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))


# ———— 6. 四大场景物理因果全带宽（0–20 kHz）合成器 ————
def thunder_strike(
    dur: float = 3.5,
    *,
    distance_m: float = 450.0,
    geometry: str = 'diagonal',
    branches: int = 5,
    strokes: int = 2,
    seed: int = 1,
) -> tuple[np.ndarray, float]:
    """三维曲折先导闪电通道声学合成器（Few 1969 / Ribner & Roy 1982 / ISO 9613-1）：
    · 在三维空间构建 z = 0..3200 m 的多尺度曲折梯级先导主通道（~560 节点）及 branches 条云间次生分叉；
    · geometry ∈ {'overhead', 'diagonal', 'distant_roll'} 控制通道相对原点听者的俯仰/横跨几何；
    · 分别计算各通道微元到左耳（x = -0.12 m）与右耳（x = +0.12 m）的精确声学推迟到达时刻 (r_i - r_min) / 343.0；
    · 按偶极方向图 sin^2(θ_i) / max(r_i, 25) 叠加双极性 N 波冲击子，经远近距离壳层施加渐进大气高频吸收，
      保留近顶雷暴 4–18 kHz 撕裂电弧脆响，并将远端云层演化为 35–180 Hz 胸腔滚雷与立体声散射余波；
    · strokes 控制主击后的电离通道二次箭式回击（间隔 40–110 ms）。
    返回 (立体声 (N(dur), 2) float64 波形, 主雷鸣 sync_anchor_s)。"""
    if geometry not in THUNDER_GEOMETRIES:
        raise ValueError(f"thunder_strike：未知几何构型 {geometry!r}，可选 {THUNDER_GEOMETRIES}")

    r = rng(seed)
    d_sec = max(0.25, float(dur))
    n = max(128, N(d_sec))
    dist = max(18.0, float(distance_m))
    n_branches = int(np.clip(branches, 0, 24))
    n_strokes = int(np.clip(strokes, 1, 8))

    # 1. 构建三维多尺度曲折闪电主通道节点 P (n_main + 1, 3)
    n_main = 560
    u = np.linspace(0.0, 1.0, n_main + 1)

    # 宏观蛇行回环（产生 Ribner-Roy 焦散雷暴重击）+ 梯级先导微折角（产生高频撕裂）
    macro_step = r.standard_normal((n_main + 1, 3))
    b_lp = [0.06]
    a_lp = [1.0, -0.94]
    tort_macro = lfilter(b_lp, a_lp, macro_step, axis=0)
    tort_macro -= tort_macro[0:1, :]
    tort_micro = np.cumsum(r.standard_normal((n_main + 1, 3)) * 5.2, axis=0)
    tort_micro -= np.outer(u, tort_micro[-1])

    az0 = float(r.uniform(-0.52, 0.52))
    x0 = dist * math.sin(az0)
    y0 = dist * math.cos(az0)

    if geometry == 'overhead':
        z_line = 3200.0 * (u ** 1.05)
        x_line = x0 + 95.0 * math.sin(az0 + 0.7) * u
        y_line = y0 + 110.0 * u
        pts_main = np.column_stack([x_line, y_line, z_line]) + tort_macro * np.array([58.0, 58.0, 18.0]) + tort_micro
        pts_main[:, 2] = np.maximum(0.0, pts_main[:, 2])
        cur_main = 1.38 * np.exp(-u / 0.34) + 0.44
    elif geometry == 'diagonal':
        sweep_dir = 1.0 if r.random() >= 0.5 else -1.0
        z_line = 3200.0 * u
        x_line = x0 + sweep_dir * 980.0 * (u - 0.18)
        y_line = y0 + 780.0 * (u ** 1.15)
        pts_main = np.column_stack([x_line, y_line, z_line]) + tort_macro * np.array([105.0, 95.0, 32.0]) + tort_micro
        pts_main[:, 2] = np.maximum(0.0, pts_main[:, 2])
        cur_main = 1.15 * np.exp(-u / 0.55) + 0.48
    else:  # distant_roll：云层斜向横跨，前导暗雷分支贴近视线轴先行到达，主干宽边焦散雷峰随后滚至
        sweep_dir = 1.0 if r.random() >= 0.5 else -1.0
        core_recess = min(420.0, max(110.0, 0.22 * d_sec * 343.0))
        # u ∈ [0, 0.26] 沿视线近似径向后退（偶极辐射 sin^2 θ 低，形成前导低沉滚雷），u > 0.26 横向展开强宽边主干
        recess = core_recess * smoothstep(0.0, 0.36, u) + 680.0 * (np.maximum(0.0, u - 0.36) ** 1.25)
        lat_span = sweep_dir * 1350.0 * (smoothstep(0.22, 0.92, u) - 0.35)
        z_line = 920.0 + 2150.0 * (0.25 + 0.75 * smoothstep(0.15, 1.0, u))
        x_line = x0 + lat_span
        y_line = y0 + recess
        pts_main = np.column_stack([x_line, y_line, z_line]) + tort_macro * np.array([120.0, 70.0, 45.0]) + tort_micro * 1.3
        cur_main = 0.16 + 1.18 * smoothstep(0.16, 0.42, u) * np.exp(-np.maximum(0.0, u - 0.48) * 1.15)

    def _nodes_to_segs(pts: np.ndarray, cur_nodes: np.ndarray):
        dvec = np.diff(pts, axis=0)
        seg_len = np.maximum(np.linalg.norm(dvec, axis=1), 1e-3)
        tang = dvec / seg_len[:, None]
        mid = 0.5 * (pts[:-1] + pts[1:])
        cur_s = 0.5 * (cur_nodes[:-1] + cur_nodes[1:]) * np.clip(seg_len / 6.0, 0.45, 2.2)
        return mid, tang, cur_s

    mid_main, tang_main, cur_seg_main = _nodes_to_segs(pts_main, cur_main)

    # 2. 次生云间分叉通道
    br_mids, br_tangs, br_curs = [], [], []
    n_br_seg = 48
    for _ in range(n_branches):
        idx_f = int(r.integers(int(0.12 * n_main), int(0.86 * n_main)))
        p_start = pts_main[idx_f]
        ub = np.linspace(0.0, 1.0, n_br_seg + 1)
        b_dir = r.standard_normal(3)
        b_dir[2] = b_dir[2] * 0.55 + (0.35 if geometry != 'distant_roll' else 0.05)
        b_dir /= max(float(np.linalg.norm(b_dir)), 1e-6)
        span_m = float(r.uniform(180.0, 440.0))
        b_walk = np.cumsum(r.standard_normal((n_br_seg + 1, 3)) * 8.5, axis=0)
        b_walk -= b_walk[0:1, :]
        pts_b = p_start[None, :] + np.outer(ub * span_m, b_dir) + b_walk
        pts_b[:, 2] = np.maximum(12.0, pts_b[:, 2])
        cur_b = float(cur_main[idx_f]) * float(r.uniform(0.36, 0.62)) * (1.0 - 0.65 * ub)
        mb, tb, cb = _nodes_to_segs(pts_b, cur_b)
        br_mids.append(mb)
        br_tangs.append(tb)
        br_curs.append(cb)

    if br_mids:
        mid_first = np.vstack([mid_main] + br_mids)
        tang_first = np.vstack([tang_main] + br_tangs)
        cur_first = np.concatenate([cur_seg_main] + br_curs)
    else:
        mid_first, tang_first, cur_first = mid_main, tang_main, cur_seg_main

    ear_l = np.array([-0.12, 0.0, 0.0], dtype=float)
    ear_r = np.array([0.12, 0.0, 0.0], dtype=float)
    r_l0 = np.linalg.norm(mid_first - ear_l[None, :], axis=1)
    r_r0 = np.linalg.norm(mid_first - ear_r[None, :], axis=1)
    r_min = float(min(np.min(r_l0), np.min(r_r0)))
    pre_s = min(0.045, 0.008 + 0.016 * float(smoothstep(120.0, 1500.0, dist)))

    # 3. 八尺度双极性 N 波冲击子核组（分属 4 个渐进大气吸收距离壳层）
    tau_grid = np.array([0.000055, 0.00013, 0.00030, 0.00068, 0.00145, 0.00295, 0.00540, 0.00860], dtype=float)
    log_taus = np.log(tau_grid)
    kernels = [_make_nwave(float(ts), asym=0.85) for ts in tau_grid]

    imp_l = np.zeros((8, n), dtype=float)
    imp_r = np.zeros((8, n), dtype=float)
    shell_r_num = np.zeros(4, dtype=float)
    shell_r_den = np.zeros(4, dtype=float)

    stroke_delay = 0.0
    for s_idx in range(n_strokes):
        if s_idx == 0:
            m_pts, t_vecs, c_amps = mid_first, tang_first, cur_first
            s_gain = 1.0
        else:
            stroke_delay += float(r.uniform(0.042, 0.108))
            m_pts, t_vecs, c_amps = mid_main, tang_main, cur_seg_main
            s_gain = (0.60 ** s_idx) * float(r.uniform(0.84, 1.14))

        vl = ear_l[None, :] - m_pts
        vr = ear_r[None, :] - m_pts
        rl = np.linalg.norm(vl, axis=1)
        rr = np.linalg.norm(vr, axis=1)
        rm = 0.5 * (rl + rr)

        sin2_l = np.clip(1.0 - (np.sum(t_vecs * vl, axis=1) / np.maximum(rl, 1.0)) ** 2, 0.0, 1.0)
        sin2_r = np.clip(1.0 - (np.sum(t_vecs * vr, axis=1) / np.maximum(rr, 1.0)) ** 2, 0.0, 1.0)

        # 双耳方位头影与大气湍流微去相关时延（随传播距离自然展宽，赋予真实天空立体声开阔度）
        az_x = np.clip(m_pts[:, 0] / np.maximum(rm, 1.0), -1.0, 1.0)
        ild_l = 1.0 - 0.26 * az_x
        ild_r = 1.0 + 0.26 * az_x

        turb_scale = 0.00018 + 0.00065 * np.sqrt(np.maximum(rm - 35.0, 0.0) / 600.0)
        turb_l = lfilter([0.18], [1.0, -0.82], r.standard_normal(len(rm))) * turb_scale
        turb_r = lfilter([0.18], [1.0, -0.82], r.standard_normal(len(rm))) * turb_scale

        tl = pre_s + stroke_delay + (rl - r_min) / 343.0 + turb_l
        tr = pre_s + stroke_delay + (rr - r_min) / 343.0 + turb_r

        pol = r.choice(np.array([-1.0, 1.0]), size=len(rm), p=[0.18, 0.82])
        jit_amp = r.uniform(0.72, 1.32, size=len(rm))
        wl = s_gain * c_amps * jit_amp * pol * ild_l * (0.07 + 0.93 * sin2_l) / np.maximum(rl, 25.0)
        wr = s_gain * c_amps * jit_amp * pol * ild_r * (0.07 + 0.93 * sin2_r) / np.maximum(rr, 25.0)

        # 非线性冲击波脉宽随距离展宽 τ_i(r)
        tau_seg = (0.000046 + 0.00000145 * (rm ** 1.04)) * r.uniform(0.68, 1.38, size=len(rm))
        lt = np.clip(np.log(np.maximum(tau_seg, tau_grid[0])), log_taus[0], log_taus[-1] - 1e-9)
        k_lo = np.clip(np.searchsorted(log_taus, lt, side='right') - 1, 0, 6)
        alpha = (lt - log_taus[k_lo]) / (log_taus[k_lo + 1] - log_taus[k_lo])

        pos_l = tl * float(SR)
        pos_r = tr * float(SR)
        for k_idx in range(8):
            w_k = np.zeros(len(rm), dtype=float)
            m0 = k_lo == k_idx
            if np.any(m0):
                w_k[m0] += 1.0 - alpha[m0]
            if k_idx > 0:
                m1 = k_lo == (k_idx - 1)
                if np.any(m1):
                    w_k[m1] += alpha[m1]
            nz = w_k > 1e-6
            if np.any(nz):
                _deposit_frac_1d(imp_l[k_idx], pos_l[nz], wl[nz] * w_k[nz])
                _deposit_frac_1d(imp_r[k_idx], pos_r[nz], wr[nz] * w_k[nz])
                sh = k_idx // 2
                w_abs = np.abs(wl[nz]) + np.abs(wr[nz])
                shell_r_num[sh] += float(np.sum(rm[nz] * w_abs * w_k[nz]))
                shell_r_den[sh] += float(np.sum(w_abs * w_k[nz]))

    # 4. 逐距离壳层卷积 N 波并施加 ISO 9613-1 风格大气高频吸收
    out = np.zeros((n, 2), dtype=float)
    default_shell_r = (max(dist, 65.0), max(dist * 1.35, 280.0), max(dist * 1.85, 820.0), max(dist * 2.4, 1650.0))
    for sh in range(4):
        sh_st = np.zeros((n, 2), dtype=float)
        for sub in (0, 1):
            ki = 2 * sh + sub
            if np.any(imp_l[ki]) or np.any(imp_r[ki]):
                ker = kernels[ki]
                sh_st[:, 0] += fftconvolve(imp_l[ki], ker)[:n]
                sh_st[:, 1] += fftconvolve(imp_r[ki], ker)[:n]
        if not np.any(sh_st):
            continue
        r_eff = shell_r_num[sh] / shell_r_den[sh] if shell_r_den[sh] > 1e-12 else default_shell_r[sh]
        fc_atm = float(np.clip(22500.0 / (1.0 + (r_eff / 170.0) ** 1.24), 210.0, 20800.0))
        if fc_atm < 20200.0:
            sh_st = lp(sh_st, fc_atm, 2)
        if r_eff > 260.0:
            sh_db = -min(18.0, ((r_eff - 260.0) / 135.0) ** 0.92)
            sh_st = shelf(sh_st, float(np.clip(fc_atm * 1.18, 650.0, 7500.0)), sh_db, 'high')
        out += sh_st

    # 5. 近场接地点高能先导电弧撕裂（4–19.5 kHz，随距离指数衰减）
    if r_min < 480.0:
        arc_gain = math.exp(-r_min / 155.0)
        arc_len = min(n, N(0.18))
        i_arc = min(n - 16, max(0, int(round(pre_s * SR))))
        m_arc = min(n - i_arc, arc_len)
        if m_arc > 32:
            ta = np.arange(m_arc, dtype=float) / float(SR)
            arc_env = smoothstep(0.0, 0.0012, ta) * (0.72 * np.exp(-ta / 0.014) + 0.28 * np.exp(-ta / 0.052))
            arc_noise = bp(decor_pair(white, m_arc, r, corr=0.35), 3400.0, 19600.0, 2)
            pk_main = max(float(np.max(np.abs(out))), 1e-9)
            out[i_arc:i_arc + m_arc] += un_safe(arc_noise) * arc_env[:, None] * pk_main * 0.34 * arc_gain

    # 6. 大气胸腔低频共振耦合（35–175 Hz）与地面/云底侧向早期散射（建立自然立体声包围感）
    mono_abs = np.abs(out.mean(axis=1))
    win_e = max(8, N(0.028))
    rumble_env = np.convolve(mono_abs, np.ones(win_e) / float(win_e), mode='same')
    rumble_src = bp(decor_pair(brown, n, r, corr=0.78), 34.0, 175.0, 2)
    pk_ref = max(float(np.max(rumble_env)), 1e-12)
    rumble_w = 0.26 + 0.36 * float(smoothstep(180.0, 1400.0, dist))
    out += un_safe(rumble_src) * (rumble_env / pk_ref)[:, None] * max(float(np.std(out)), 1e-9) * rumble_w

    # 地面近场反射 + 云底非对称侧向散射（>150 Hz 侧向去相关，确保低频单声道兼容且整体 corr ∈ (0.35, 0.86)）
    scatter_src = hp(out, 150.0, 2)
    taps = (
        (0.0065, 0.32, 8500.0, True),
        (0.0175, -0.26, 4600.0, False),
        (0.0310, 0.22, 2600.0, True),
        (0.0520, -0.18, 1450.0, False),
    )
    sc_acc = np.zeros_like(out)
    for dly_s, g_sc, fc_sc, swap_ch in taps:
        shift = N(dly_s * float(r.uniform(0.88, 1.14)))
        if 0 < shift < n - 16:
            seg_sc = lp(scatter_src[:n - shift], fc_sc, 2)
            if swap_ch:
                seg_sc = seg_sc[:, ::-1]
            sc_acc[shift:] += seg_sc * g_sc
    # 湍流散射层（包络严格跟随雷声本体，无稳态底噪）
    wake_noise = bp(decor_pair(pink, n, r, corr=0.18), 140.0, float(np.clip(11000.0 / (1.0 + dist / 320.0), 650.0, 9500.0)), 2)
    sc_acc += un_safe(wake_noise) * (rumble_env / pk_ref)[:, None] * max(float(np.std(out)), 1e-9) * 0.30
    out = out + sc_acc

    return _finalize_stereo(out, d_sec, fin_s=0.0015, fout_s=min(0.08, d_sec * 0.14), peak=0.91)


def pouring_vessel(
    dur: float = 1.8,
    *,
    fill_start: float = 0.12,
    fill_end: float = 0.88,
    height_cm: float = 18.0,
    radius_cm: float = 3.6,
    flow_rate: float = 0.65,
    seed: int = 1,
) -> tuple[np.ndarray, float]:
    """茶盏/酒壶/水杯注水物理因果合成器（Minnaert 微泡群 × 时变四分之一波长闭底圆筒空气柱）：
    · 幂律半径分布微气泡群（r_0 ∈ [0.6, 4.5] mm，f_0 = 3.26 / r_0_m 叠液颈脱离上滑 chirp）与 2–18 kHz 水流飞溅湍流；
    · 连续液面上升驱动有效空气柱长度 L_eff(t) = height_cm * (1 - fill(t)) + 0.61 * radius_cm（含 Levine-Schwinger 管口末端修正），
      经时变 dsp.svf(..., 'bp') 激发前三阶奇次轴向共振模态 f_k(t) = (2k + 1) * 34300 / (4 * L_eff(t))（k = 0, 1, 2，上限 14 kHz）；
    · 自然呈现杯壶注满过程中标志性的共振峰连续上扬。
    返回 (单声道 (N(dur),) float64 波形, sync_anchor_s)。"""
    r = rng(seed)
    d_sec = max(0.08, float(dur))
    n = max(64, N(d_sec))
    t = np.arange(n, dtype=float) / float(SR)
    u = t / d_sec

    fl = float(np.clip(flow_rate, 0.0, 2.5))
    if fl <= 1e-6:
        return np.zeros(n, dtype=np.float64), 0.0

    f_s = float(np.clip(fill_start, 0.0, 0.98))
    f_e = float(np.clip(fill_end, 0.0, 0.98))
    h_cm = max(2.5, float(height_cm))
    rad_cm = max(0.5, float(radius_cm))

    # 1. 倾倒水流起收包络与连续液位积分曲线 fill(t)
    onset_splash = 1.0 + 0.22 * np.exp(-np.maximum(0.0, t - 0.035) / 0.085) * smoothstep(0.0, 0.030, t)
    pour_env = smoothstep(0.0, min(0.038, 0.10 * d_sec), t) * (1.0 - smoothstep(max(0.89, 1.0 - 0.05 / d_sec), 1.0, u))
    vol_cum = np.cumsum(np.maximum(pour_env, 1e-6))
    vol_u = (vol_cum - vol_cum[0]) / max(float(vol_cum[-1] - vol_cum[0]), 1e-12)
    fill_t = np.clip(f_s + (f_e - f_s) * vol_u, 0.0, 0.985)

    # 2. 时变四分之一波长闭底圆筒空气柱有效长度与前三阶奇次轴向模态频率
    l_eff = np.maximum(0.65, h_cm * (1.0 - fill_t) + 0.61 * rad_cm)
    aspect = l_eff / rad_cm
    q0_curve = np.clip(3.8 + 1.65 * aspect, 4.0, 11.5)

    # 3. 幂律半径分布（r_0 ∈ [0.6, 4.5] mm）Minnaert 微气泡群合成
    bub_rate = (175.0 + 250.0 * fl) * (0.35 + 0.65 * pour_env)
    cum_h = np.cumsum(bub_rate) / float(SR)
    tot_h = float(cum_h[-1])

    bub_exc = np.zeros(n, dtype=float)
    cur_h = 0.0
    max_bubs = max(64, int(d_sec * 620))
    r_min_mm = 0.60
    p_exp = -0.65  # 幂律半径采样：兼顾深水期中大液泡（720–1800 Hz）与满杯期细密微泡（1800–5400 Hz）

    while cur_h < tot_h and max_bubs > 0:
        cur_h += float(r.exponential(1.0))
        if cur_h >= tot_h:
            break
        max_bubs -= 1
        i0 = int(np.searchsorted(cum_h, cur_h, side='left'))
        if i0 >= n - 16:
            break
        # 随液面升高落差减小，最大卷入气泡半径自然收敛
        fall_frac = float(np.clip(1.0 - 0.65 * fill_t[i0], 0.28, 1.0))
        r_max_loc = max(0.95, 4.50 * fall_frac)
        u_r = float(r.random())
        r_mm = (r_min_mm ** p_exp + u_r * ((r_max_loc ** p_exp) - (r_min_mm ** p_exp))) ** (1.0 / p_exp)
        r_m = r_mm * 1e-3

        f_b = float(np.clip(3.26 / r_m, 320.0, 0.42 * SR))
        damp_b = 0.045 * f_b + 0.00075 * (f_b ** 1.5)
        tau_b = float(np.clip(1.0 / max(damp_b, 12.0), 0.0022, 0.048))
        m = min(n - i0, max(16, N(min(0.11, 5.2 * tau_b))))
        tg = np.arange(m, dtype=float) / float(SR)
        chirp_k = float(r.uniform(0.11, 0.25))
        f_inst = np.clip(f_b * (1.0 + chirp_k * ((tg / tau_b) ** 1.15)), 240.0, 0.44 * SR)
        ph = 2.0 * np.pi * np.cumsum(f_inst) / float(SR)
        env_b = smoothstep(0.0, min(0.0009, tau_b * 0.30), tg) * np.exp(-tg / tau_b)
        amp_b = ((r_mm / 2.2) ** 0.50) * float(r.uniform(0.60, 1.25)) * float(pour_env[i0])
        bub_exc[i0:i0 + m] += (np.sin(ph) + 0.06 * np.sin(2.0 * ph)) * env_b * amp_b

    # 4. 宽带液柱冲击湍流（无周期调制）耦合进圆筒腔体前三阶奇次共振峰
    jet_mod = smooth_random(n, r, rate=11.0, lo=0.68, hi=1.32) * pour_env
    plunge_noise = bp(pink(n, r), 180.0, 12000.0, 2) * jet_mod
    cavity_in = 0.58 * un_safe(bub_exc) + 0.42 * un_safe(plunge_noise)

    cavity_out = np.zeros(n, dtype=float)
    # 开口辐射阻尼随阶数 (2k+1)^2 递增，主基模 k=0 主导杯腔音高上扬，k=1,2 赋予圆筒管腔泛音色彩
    mode_gains = (1.00, 0.24, 0.12)
    q_scales = (1.00, 0.82, 0.68)
    for k, (g_m, q_s) in enumerate(zip(mode_gains, q_scales)):
        fk_raw = (2 * k + 1) * 34300.0 / (4.0 * l_eff)
        fk_clamped = np.clip(fk_raw, 80.0, 14000.0)
        # 接近 14 kHz 上限时平滑收敛模态权重，防止硬截断产生固定频点窄带哨音
        hi_taper = smoothstep(14000.0, 11500.0, fk_raw)
        qk = np.clip(q0_curve * q_s, 2.6, 12.0)
        # 补偿时变带通等效噪声带宽（ENBW ∝ fc / Q），保持全注水过程能量均衡
        bw_norm = np.sqrt(qk / np.maximum(fk_clamped, 100.0)) * 16.0
        yk = svf(cavity_in, fk_clamped, qk, 'bp') * bw_norm
        cavity_out += yk * (g_m * hi_taper)

    # 5. 杯口与液面直达高频水沫细丝（3.8–19.2 kHz，保留 48 kHz 全带宽清透水感且不掩蔽 300–4000 Hz 腔体基频上滑）
    splash_mod = smooth_random(n, r, rate=17.0, lo=0.55, hi=1.45) * pour_env
    stream_air = bp(white(n, r), 3800.0, 19200.0, 2) * splash_mod
    bub_hi = hp(bub_exc, 3400.0, 2)

    out = (un_safe(cavity_out) * 0.84 + un_safe(stream_air) * (0.14 + 0.09 * min(fl, 1.2)) + un_safe(bub_hi) * 0.14) * onset_splash
    # 重力自由落差动能修正（液位升高时落差 h*(1-fill) 减小，声强由清脆初冲渐趋温润满杯）
    grav_head = 1.0 - 0.28 * fill_t
    out = out * pour_env * grav_head
    out = hp(out, 32.0, 1)
    out = out - float(np.mean(out))
    out = fade(out, min(0.004, d_sec * 0.04), min(0.020, d_sec * 0.10))
    pk_target = float(min(0.92, 0.62 + 0.24 * min(fl, 1.25)))
    out = norm(out, pk_target)
    anc = sync_anchor(out, SR)
    return np.asarray(out, dtype=np.float64), float(np.clip(anc, 0.0, (len(out) - 1) / float(SR)))


def bouncing_disc(
    dur: float = 1.2,
    *,
    material: str = 'coin_brass',
    bounces: int = 9,
    spin_tail: bool = True,
    size_scale: float = 1.0,
    seed: int = 1,
) -> tuple[np.ndarray, float]:
    """圆薄板弹跳与欧拉盘加速滚振合成器（Chladni 圆盘简并分裂双模态 + Moffatt 2000 有限时间奇点）：
    · material ∈ DISC_MATERIALS = ('coin_brass', 'coin_silver', 'jade_token', 'stone_go')；
    · 微非对称圆盘简并分裂成对模态 (f_m, f_m * (1 + δ)) 以双耳正交辐射相位差投射左右声道，金属/美玉泛音闪烁直达 16–19 kHz；
    · 弹跳阶段遵循几何恢复系数间隔 t_{k+1} - t_k = dt_0 * restitution^k，撞击冲量递减并带接触角度微随机扰动；
    · spin_tail=True 时在弹跳收拢后无缝衔入欧拉盘边缘滚动颤振 f_chatter(t) ∝ (t_sing - t)^(-1/3)（约 15 Hz 加速至 95 Hz），
      最终以干脆平拍压桌瞬态（Flat-Slap Settle）止住残余自由振动。
    返回 (立体声 (N(dur), 2) float64 波形, 首击 sync_anchor_s)。"""
    if material not in DISC_MATERIALS:
        raise ValueError(f"bouncing_disc：未知圆片材质 {material!r}，可选 {DISC_MATERIALS}")

    cfg = _DISC_CFGS[material]
    r = rng(seed)
    d_sec = max(0.18, float(dur))
    n = max(64, N(d_sec))
    sc = float(np.clip(size_scale, 0.25, 6.0))
    n_bounces = max(1, int(round(bounces)))

    # 1. 构建双耳简并分裂双音圆盘共振脉冲响应 h_disc (n_ir, 2) 与桌面腔体叩击核 h_table
    f0 = float(cfg['f0']) / sc
    ir_sec = min(d_sec, max(0.12, 5.5 * float(cfg['modes'][0][2]) * (sc ** 0.45)))
    n_ir = max(64, N(ir_sec))
    t_ir = np.arange(n_ir, dtype=float) / float(SR)
    onset_ir = np.minimum(1.0, t_ir / 0.00018)

    h_hard = np.zeros((n_ir, 2), dtype=float)
    h_roll = np.zeros((n_ir, 2), dtype=float)
    for m_idx, (ratio, amp, tau_b, d_split) in enumerate(cfg['modes']):
        fa = f0 * float(ratio) * float(r.uniform(0.996, 1.004))
        if fa >= 0.445 * SR:
            continue
        split = float(d_split) * float(r.uniform(0.88, 1.14))
        fb = min(0.452 * SR, fa * (1.0 + split))
        tau_m = max(0.0015, float(tau_b) * (sc ** 0.45))
        env_m = float(amp) * np.exp(-t_ir / tau_m) * onset_ir

        # 正交简并模态 (cos mθ, sin mθ) 投射至左右耳呈天然方位相位分离，产生空间拍频闪烁
        ph_a = float(r.uniform(0.0, 2.0 * math.pi))
        ph_b = float(r.uniform(0.0, 2.0 * math.pi))
        dphi_lr = 0.78 + 0.36 * (m_idx % 3)
        mode_l = np.sin(2.0 * np.pi * fa * t_ir + ph_a) + 0.76 * np.sin(2.0 * np.pi * fb * t_ir + ph_b)
        mode_r = 0.78 * np.sin(2.0 * np.pi * fa * t_ir + ph_a + 0.28) + np.sin(2.0 * np.pi * fb * t_ir + ph_b + dphi_lr)
        pair = np.column_stack([mode_l, mode_r]) * (env_m[:, None] * 0.56)
        h_hard += pair
        # 边缘滚振对高阶面外模态激发较柔和，保留清润边音
        roll_w = 1.0 / (1.0 + 0.55 * m_idx)
        h_roll += pair * roll_w

    # 桌面局部木石接触短叩核（赋予落桌与欧拉盘滚振真实固体承载感）
    n_tb = min(n_ir, N(0.032))
    t_tb = np.arange(n_tb, dtype=float) / float(SR)
    ft1 = float(cfg['table_f']) / (sc ** 0.25)
    ft2 = ft1 * 2.18
    h_tab = (
        np.sin(2.0 * np.pi * ft1 * t_tb) * np.exp(-t_tb / 0.0055)
        + 0.55 * np.sin(2.0 * np.pi * ft2 * t_tb + 0.5) * np.exp(-t_tb / 0.0028)
    ) * float(cfg['table_mix'])

    # 2. 几何弹跳冲量序列 t_{k+1} - t_k = dt_0 * restitution^k
    t0 = min(0.008, 0.025 * d_sec)
    rest = float(cfg['restitution'])
    if spin_tail:
        t_bounce_end = 0.40 * d_sec
        t_settle = 0.82 * d_sec
    else:
        t_bounce_end = 0.74 * d_sec
        t_settle = d_sec

    exc_hard = np.zeros((n, 2), dtype=float)
    exc_roll = np.zeros((n, 2), dtype=float)
    exc_tab = np.zeros(n, dtype=float)
    msi_st = np.zeros((n, 2), dtype=float)

    if n_bounces == 1:
        bounce_times = [t0]
    else:
        geom_weights = np.array([rest ** k for k in range(n_bounces)], dtype=float)
        dt_0 = (t_bounce_end - t0) / float(np.sum(geom_weights))
        dts = dt_0 * geom_weights
        bounce_times = [t0]
        cur_t = t0
        for k in range(n_bounces - 1):
            # 极轻微接触微倾角抖动（≤3%），严格保持间隔单调递减加速
            cur_t += float(dts[k]) * float(r.uniform(0.985, 1.015))
            bounce_times.append(cur_t)

    base_h = float(cfg['hardness'])
    for k, tb in enumerate(bounce_times):
        pos = tb * float(SR)
        if pos >= n - 8:
            break
        vel_k = (rest ** (0.78 * k)) * float(r.uniform(0.90, 1.10) if k > 0 else 1.0)
        hk = float(np.clip(base_h * (0.96 ** k) * float(r.uniform(0.88, 1.08)), 0.18, 1.0))
        pan_k = float(r.uniform(-0.22, 0.22)) * (0.86 ** k)
        gl, gr = pan_lr(pan_k)

        # 金属/玉石刚性边缘亚采样脉冲直接激发全频带 16–19 kHz 双音闪烁，柔接触分量走短赫兹核
        _deposit_frac_1d(exc_hard[:, 0], np.array([pos]), np.array([vel_k * hk * gl]))
        _deposit_frac_1d(exc_hard[:, 1], np.array([pos]), np.array([vel_k * hk * gr]))
        i0 = int(round(pos))
        len_p = max(2, int(round((0.00010 + 0.00050 * ((1.0 - hk) ** 1.4)) * SR)))
        m_p = min(n - i0, len_p)
        if m_p >= 2:
            up = (np.arange(m_p, dtype=float) + 0.5) / float(m_p)
            pulse = np.sin(np.pi * up) ** 1.8
            pulse /= max(float(np.sum(pulse)), 1e-12)
            exc_roll[i0:i0 + m_p, 0] += pulse * vel_k * (1.0 - 0.55 * hk) * gl
            exc_roll[i0:i0 + m_p, 1] += pulse * vel_k * (1.0 - 0.55 * hk) * gr
            exc_tab[i0:i0 + m_p] += pulse * vel_k * (0.65 + 0.35 * hk)

        # 接触瞬间高频脆响（MSI 延伸至 18.5 kHz）
        m_msi = min(n - i0, N(0.0032))
        if m_msi >= 12:
            tm = np.arange(m_msi, dtype=float) / float(SR)
            burst = bp(decor_pair(white, m_msi, r, corr=0.55), 2400.0, 18800.0, 2)
            msi_st[i0:i0 + m_msi] += un_safe(burst) * (np.exp(-tm / 0.00075) * vel_k * (0.24 + 0.38 * hk))[:, None]

    # 3. 欧拉盘有限时间奇点加速滚振（Moffatt 2000：f_chatter(t) ∝ (t_sing - t)^(-1/3)，约 22 Hz → 95 Hz）
    slap_st = np.zeros((n, 2), dtype=float)
    if spin_tail and t_settle > t_bounce_end + 0.04:
        i_spin_a = max(0, int(round(t_bounce_end * SR)))
        i_spin_b = min(n - 8, int(round(t_settle * SR)))
        if i_spin_b > i_spin_a + 32:
            t_spin = np.arange(i_spin_a, i_spin_b, dtype=float) / float(SR)
            span_s = float(t_settle - t_bounce_end)
            f_start = 22.0
            f_end = 95.0
            ratio_cube = (f_end / f_start) ** 3.0
            eps_sing = span_s / max(ratio_cube - 1.0, 1.0)
            t_sing = t_settle + eps_sing
            f_chat = f_start * (((t_sing - t_bounce_end) / np.maximum(t_sing - t_spin, 1e-5)) ** (1.0 / 3.0))
            # 进动圆盘边缘滚动相位积分，生成精确加速脉冲列
            ph_chat = np.cumsum(f_chat) / float(SR)
            trig = np.flatnonzero(np.diff(np.floor(ph_chat)) >= 1.0)
            last_b_vel = max(0.14, rest ** (0.72 * max(0, n_bounces - 1)))
            for idx_rel in trig:
                ig = i_spin_a + int(idx_rel)
                if ig >= n - 6:
                    break
                prog = float(idx_rel) / float(max(1, i_spin_b - i_spin_a))
                amp_c = last_b_vel * (0.48 + 0.42 * math.sin(math.pi * min(1.0, prog * 1.04))) * float(r.uniform(0.88, 1.12))
                pan_c = 0.16 * math.sin(2.0 * math.pi * 6.5 * prog)
                gl, gr = pan_lr(pan_c)
                exc_roll[ig, 0] += amp_c * 0.48 * gl
                exc_roll[ig, 1] += amp_c * 0.48 * gr
                exc_tab[ig] += amp_c * 1.35
                m_tk = min(n - ig, N(0.0016))
                if m_tk >= 8:
                    ttk = np.arange(m_tk, dtype=float) / float(SR)
                    tick = bp(white(m_tk, r), 1500.0, 15800.0, 2) * np.exp(-ttk / 0.00048)
                    slap_st[ig:ig + m_tk] += stereo(un_safe(tick) * amp_c * 0.22, pan_c)

        # 平拍落定（Flat-Slap Settle）：盘底气膜挤出脆啪 + 桌面实拍
        i_set = min(n - 12, int(round(t_settle * SR)))
        m_slap = min(n - i_set, N(0.014))
        if m_slap >= 16:
            tsl = np.arange(m_slap, dtype=float) / float(SR)
            air_squeeze = bp(decor_pair(white, m_slap, r, corr=0.65), 950.0, 12800.0, 2)
            slap_env = smoothstep(0.0, 0.0004, tsl) * np.exp(-tsl / 0.0020)
            wood_thud = stereo(
                np.sin(2.0 * np.pi * (ft1 * 0.92) * tsl) * np.exp(-tsl / 0.0038),
                0.0,
            )
            slap_amp = max(0.18, 0.48 * (rest ** (0.55 * max(0, n_bounces - 1))))
            slap_st[i_set:i_set + m_slap] += (un_safe(air_squeeze) * slap_env[:, None] * 0.55 + wood_thud * 0.65) * slap_amp

    # 4. 卷积合成：滚动贴桌期自然收敛腾空弹跳余音，平拍贴桌时刻彻底摩擦止音
    hard_st = np.zeros((n, 2), dtype=float)
    roll_st = np.zeros((n, 2), dtype=float)
    for ch in (0, 1):
        hard_st[:, ch] = fftconvolve(exc_hard[:, ch], h_hard[:, ch])[:n]
        roll_st[:, ch] = fftconvolve(exc_roll[:, ch], h_roll[:, ch])[:n]
    tab_mono = fftconvolve(exc_tab, h_tab)[:n]
    tab_st = stereo(tab_mono, 0.0)

    if spin_tail and t_settle < d_sec:
        t_all = np.arange(n, dtype=float) / float(SR)
        # 进入连续边缘滚振后，桌面持续接触阻尼掉腾空期的长铃音，使欧拉盘加速颤振颗粒清晰可辨
        roll_contact_damp = np.where(t_all <= t_bounce_end, 1.0, np.exp(-(t_all - t_bounce_end) / 0.048))
        hard_st *= roll_contact_damp[:, None]
        mute_env = np.where(t_all <= t_settle, 1.0, np.exp(-(t_all - t_settle) / 0.0040))
        hard_st *= mute_env[:, None]
        roll_st *= mute_env[:, None]
        tab_st *= np.where(t_all <= t_settle + 0.006, 1.0, np.exp(-(t_all - t_settle - 0.006) / 0.0042))[:, None]

    disc_st = hard_st + roll_st
    out = un_safe(disc_st) * 0.76 + un_safe(tab_st) * float(cfg['table_mix']) * 0.58 + msi_st * 0.36 + slap_st * 0.55
    return _finalize_stereo(out, d_sec, fin_s=0.0005, fout_s=min(0.018, d_sec * 0.10), peak=0.90)


def shock_blast(
    dur: float = 1.4,
    *,
    kind: str = 'firework',
    distance_m: float = 25.0,
    mach_crack: bool = True,
    seed: int = 1,
) -> tuple[np.ndarray, float]:
    """非线性激波与爆破声学合成器（Whitham 弹道 N 波 + Friedlander 1946 冲击波超压 + 场景尾迹）：
    · kind ∈ BLAST_KINDS = ('firework', 'cannon', 'cork_pop', 'whip_crack')；
    · mach_crack=True 时在主 Friedlander 冲击波前导叠入 0.35–1.2 ms 超音速双极性 N 波脆裂；
    · 耦合地面反射梳状干涉凹口（2.5–6.5 ms 延迟衰减反射）、距离大气衰减与四类物理尾迹（保留 0–20 kHz 全带宽空气脆度）。
    返回 (立体声 (N(dur), 2) float64 波形, 主爆破 sync_anchor_s)。"""
    if kind not in BLAST_KINDS:
        raise ValueError(f"shock_blast：未知冲击波类型 {kind!r}，可选 {BLAST_KINDS}")

    r = rng(seed)
    d_sec = max(0.16, float(dur))
    n = max(64, N(d_sec))
    dist = max(0.8, float(distance_m))

    preset_map = {
        'firework': {'t_blast': min(0.048, 0.16 * d_sec), 't_plus': 0.0021, 'n_tau': 0.00028, 'lead_s': 0.0065},
        'cannon': {'t_blast': min(0.036, 0.14 * d_sec), 't_plus': 0.0072, 'n_tau': 0.00052, 'lead_s': 0.0105},
        'cork_pop': {'t_blast': min(0.092, 0.24 * d_sec), 't_plus': 0.00085, 'n_tau': 0.00018, 'lead_s': 0.0026},
        'whip_crack': {'t_blast': min(0.155, 0.28 * d_sec), 't_plus': 0.00042, 'n_tau': 0.00016, 'lead_s': 0.0022},
    }
    p_cfg = preset_map[kind]
    t_blast = float(p_cfg['t_blast'])
    i_blast = min(n - 24, max(4, int(round(t_blast * SR))))

    # 正压持续时间随传播距离非线性微展宽
    dist_stretch = 1.0 + 0.08 * math.sqrt(max(0.0, dist - 5.0))
    t_plus = float(p_cfg['t_plus']) * dist_stretch
    n_tau = float(np.clip(float(p_cfg['n_tau']) * (1.0 + 0.04 * math.sqrt(dist)), 0.00015, 0.00060))

    direct_st = np.zeros((n, 2), dtype=float)
    pre_tail_st = np.zeros((n, 2), dtype=float)

    # 1. 可选前导超音速弹道双极性 N 波脆裂（0.35–1.2 ms 全宽）
    if mach_crack:
        nw = _make_nwave(n_tau, asym=0.90)
        i_nw = max(1, int(round((t_blast - float(p_cfg['lead_s'])) * SR)))
        # 左右耳微声像差（0.08 ms）增强前导激波空间锐度
        for ch, off in ((0, 0), (1, max(1, int(round(0.00008 * SR))))):
            ia = min(n - 4, i_nw + off)
            m_nw = min(n - ia, len(nw))
            if m_nw > 2:
                direct_st[ia:ia + m_nw, ch] += nw[:m_nw] * (0.62 if kind != 'cork_pop' else 0.38)
        # 激波前沿高频空气电离/剪切嘶裂（4–20 kHz）
        m_snap = min(n - i_nw, N(0.0045))
        if m_snap >= 12:
            ts = np.arange(m_snap, dtype=float) / float(SR)
            snap_air = bp(decor_pair(white, m_snap, r, corr=0.45), 4200.0, 20200.0, 2)
            direct_st[i_nw:i_nw + m_snap] += un_safe(snap_air) * (np.exp(-ts / 0.0009) * 0.28)[:, None]

    # 2. 主 Friedlander 冲击波 p(t) = p_0 * (1 - t/t_+) * exp(-t/t_+) + 全频带激波瞬态前沿
    fw = _make_friedlander(t_plus, rise_s=0.00004 if kind in ('whip_crack', 'firework') else 0.00007)
    for ch, off in ((0, 0), (1, 1)):
        ib = min(n - 4, i_blast + off)
        m_fw = min(n - ib, len(fw))
        if m_fw > 4:
            direct_st[ib:ib + m_fw, ch] += fw[:m_fw] * 1.0

    # 近距激波面宽带全频撕裂瞬态（直达 20.5 kHz，杜绝任何 12 kHz 硬截断）
    m_edge = min(n - i_blast, N(0.012 if kind in ('cannon', 'firework') else 0.0055))
    if m_edge >= 16:
        te = np.arange(m_edge, dtype=float) / float(SR)
        tau_edge = 0.0024 if kind in ('cannon', 'firework') else 0.0011
        edge_hi = bp(decor_pair(white, m_edge, r, corr=0.48), 2600.0, 20500.0, 2)
        direct_st[i_blast:i_blast + m_edge] += un_safe(edge_hi) * (np.exp(-te / tau_edge) * 0.42)[:, None]

    # 3. 地面反射干涉凹口（2.5–6.5 ms 延迟衰减反射）
    tau_gnd = float(np.clip(0.0062 / (1.0 + dist / 45.0) + 0.0025, 0.0025, 0.0065))
    shift_gnd = N(tau_gnd)
    if 0 < shift_gnd < n - 16:
        gnd_ref = lp(direct_st[:n - shift_gnd], 7600.0, 2)
        # 地面声阻抗相移与微左右散射差
        direct_st[shift_gnd:, 0] += gnd_ref[:, 0] * 0.44
        shift_r = min(n - 1, shift_gnd + max(1, int(round(0.00014 * SR))))
        if shift_r < n - 8:
            direct_st[shift_r:, 1] += gnd_ref[:n - shift_r, 1] * 0.41

    # 4. 四类物理预设专属前导与余波尾迹
    if kind == 'firework':
        # 升空微哨前导 + 延迟散开的漫天噼啪星群（Crackling Stars，双耳宽声像 2.5–19.8 kHz）
        if i_blast > N(0.018):
            tw = np.arange(i_blast, dtype=float) / float(SR)
            f_lift = 1150.0 + 950.0 * (tw / max(t_blast, 1e-3))
            lift = svf(pink(i_blast, r), f_lift, 4.5, 'bp')
            pre_tail_st[:i_blast] += stereo(un_safe(lift) * smoothstep(0.0, t_blast * 0.7, tw) * 0.07, 0.0)

        star_start = min(n - 32, i_blast + N(0.085))
        n_stars = max(18, int(min(95, (d_sec - t_blast) * 68)))
        if star_start < n - 32:
            for _ in range(n_stars):
                u_st = float(r.beta(1.5, 2.8))
                ist = star_start + int(round(u_st * (n - 24 - star_start)))
                if ist >= n - 16:
                    continue
                star_nw = _make_nwave(float(r.uniform(0.00008, 0.00024)), asym=0.88)
                pan_s = float(r.uniform(-0.82, 0.82))
                gl, gr = pan_lr(pan_s)
                amp_s = float(r.uniform(0.06, 0.24)) * (1.0 - 0.55 * u_st)
                ms = min(n - ist, len(star_nw))
                pre_tail_st[ist:ist + ms, 0] += star_nw[:ms] * amp_s * gl
                pre_tail_st[ist:ist + ms, 1] += star_nw[:ms] * amp_s * gr
                m_sp = min(n - ist, N(0.0024))
                if m_sp >= 8:
                    tsp = np.arange(m_sp, dtype=float) / float(SR)
                    sp = bp(white(m_sp, r), 3800.0, 19800.0, 2) * np.exp(-tsp / 0.0006)
                    pre_tail_st[ist:ist + m_sp] += stereo(un_safe(sp) * amp_s * 0.35, pan_s)
        # 高空开阔空气散射余韵
        sky_tail = np.zeros(n - i_blast, dtype=float)
        if len(sky_tail) > 32:
            tsky = np.arange(len(sky_tail), dtype=float) / float(SR)
            sky_n = bp(decor_pair(pink, len(sky_tail), r, corr=0.28), 90.0, 6200.0, 2)
            pre_tail_st[i_blast:] += un_safe(sky_n) * (np.exp(-tsky / 0.22) * 0.16)[:, None]

    elif kind == 'cannon':
        # 35–90 Hz 胸腔冲击震荡波 + 远山峡谷多次立体声回声
        m_rem = n - i_blast
        if m_rem > 32:
            tc = np.arange(m_rem, dtype=float) / float(SR)
            f_sub = 82.0 * np.exp(-tc / 0.095) + 38.0
            ph_sub = 2.0 * np.pi * np.cumsum(f_sub) / float(SR)
            chest = np.sin(ph_sub) * smoothstep(0.0, 0.002, tc) * np.exp(-tc / 0.145)
            roar = bp(decor_pair(brown, m_rem, r, corr=0.62), 35.0, 420.0, 2)
            pre_tail_st[i_blast:] += stereo(chest * 0.62, 0.0) + un_safe(roar) * (np.exp(-tc / 0.32) * 0.28)[:, None]

        blast_body = lp(direct_st, 1650.0, 2)
        valley_taps = ((0.165, 0.24, -0.48, 1200.0), (0.360, 0.16, 0.52, 820.0), (0.620, 0.10, -0.30, 560.0))
        for dly_v, gv, pan_v, fc_v in valley_taps:
            iv = N(dly_v)
            if iv < n - 32:
                ev = lp(blast_body[:n - iv].mean(axis=1), fc_v, 2)
                # 峡谷漫反射展宽脉冲
                ker_v = r.standard_normal(min(N(0.045), n - iv)) * np.exp(-np.linspace(0.0, 3.6, min(N(0.045), n - iv)))
                ker_v /= max(float(np.linalg.norm(ker_v)), 1e-12)
                ev_diff = fftconvolve(ev, ker_v)[:n - iv]
                pre_tail_st[iv:] += stereo(ev_diff * gv, pan_v)

    elif kind == 'cork_pop':
        # 橡胶/软木塞粘滑扭转摩擦前导 + 上滑亥姆霍兹瓶颈啵声 + 绵密高泡微嘶（3–19.8 kHz）
        i_pre_end = max(0, i_blast - N(0.008))
        if i_pre_end > N(0.025):
            tp_r = np.arange(i_pre_end, dtype=float) / float(SR)
            # 粘滑脉冲串激发玻璃瓶颈阻尼摩擦
            stick_rate = 65.0 + 95.0 * (tp_r / max(float(tp_r[-1]), 1e-3))
            ph_ss = np.cumsum(stick_rate) / float(SR)
            ss_imp = np.zeros(i_pre_end, dtype=float)
            ss_idx = np.flatnonzero(np.diff(np.floor(ph_ss)) >= 1.0)
            ss_imp[ss_idx] = r.uniform(0.5, 1.0, size=len(ss_idx))
            squeak = svf(ss_imp + 0.15 * white(i_pre_end, r), 920.0 + 480.0 * (tp_r / max(float(tp_r[-1]), 1e-3)), 5.5, 'bp')
            env_sq = smoothstep(0.0, 0.012, tp_r) * (1.0 - smoothstep(0.75 * float(tp_r[-1]), float(tp_r[-1]), tp_r))
            pre_tail_st[:i_pre_end] += stereo(un_safe(squeak) * env_sq * 0.09, -0.06)

        # 拔出瞬间瓶颈空气塞亥姆霍兹共振急速上滑“啵”声
        m_pop = min(n - i_blast, N(0.042))
        if m_pop >= 16:
            t_pop = np.arange(m_pop, dtype=float) / float(SR)
            f_helm = 285.0 + 540.0 * (1.0 - np.exp(-t_pop / 0.0065))
            ph_h = 2.0 * np.pi * np.cumsum(f_helm) / float(SR)
            helm_wave = (np.sin(ph_h) + 0.22 * np.sin(2.0 * ph_h)) * smoothstep(0.0, 0.0008, t_pop) * np.exp(-t_pop / 0.013)
            pre_tail_st[i_blast:i_blast + m_pop] += stereo(helm_wave * 0.78, 0.0)

        # 香槟/汽酒二氧化碳高泡微嘶（3.2–20 kHz 全频带晶莹嘶泡）
        i_fizz = min(n - 16, i_blast + N(0.008))
        m_fizz = n - i_fizz
        if m_fizz > 32:
            tfz = np.arange(m_fizz, dtype=float) / float(SR)
            fizz_env = smoothstep(0.0, 0.018, tfz) * (0.65 * np.exp(-tfz / 0.24) + 0.35 * np.exp(-tfz / 0.68))
            fizz_air = bp(decor_pair(white, m_fizz, r, corr=0.22), 3400.0, 20200.0, 2)
            # 叠入细密微泡颗粒脉动
            n_micro = max(24, int(m_fizz / SR * 180))
            for _ in range(n_micro):
                im = int(r.integers(0, max(1, m_fizz - 24)))
                mm = min(m_fizz - im, N(0.0022))
                tmm = np.arange(mm, dtype=float) / float(SR)
                fm = float(r.uniform(5200.0, 18600.0))
                bub_m = np.sin(2.0 * np.pi * fm * tmm) * np.exp(-tmm / 0.00055) * float(fizz_env[im]) * 0.045
                ch_m = int(r.integers(0, 2))
                fizz_air[im:im + mm, ch_m] += bub_m
            pre_tail_st[i_fizz:] += un_safe(fizz_air) * (fizz_env * 0.20)[:, None]

    else:  # whip_crack：气动皮鞭加速破空上扬，直抵鞭梢跨音速 N 波脆裂
        if i_blast > N(0.025):
            tw = np.arange(i_blast, dtype=float) / float(SR)
            uw = tw / max(t_blast, 1e-4)
            v_ramp = (uw ** 2.35)
            f_strouhal = np.clip(180.0 + 3600.0 * v_ramp, 160.0, 14500.0)
            whoosh_src = decor_pair(pink, i_blast, r, corr=0.65)
            whoosh_l = svf(whoosh_src[:, 0], f_strouhal, 2.4, 'bp')
            whoosh_r = svf(whoosh_src[:, 1], f_strouhal * 1.025, 2.4, 'bp')
            env_w = smoothstep(0.0, 0.15, uw) * (v_ramp ** 1.35)
            pre_tail_st[:i_blast, 0] += un_safe(whoosh_l) * env_w * 0.24
            pre_tail_st[:i_blast, 1] += un_safe(whoosh_r) * env_w * 0.25

        # 鞭梢音爆后高频开阔空气余振（直达 20 kHz）
        m_after = min(n - i_blast, N(0.14))
        if m_after > 24:
            ta = np.arange(m_after, dtype=float) / float(SR)
            snap_tail = bp(decor_pair(white, m_after, r, corr=0.52), 1800.0, 20400.0, 2)
            pre_tail_st[i_blast:i_blast + m_after] += un_safe(snap_tail) * (np.exp(-ta / 0.016) * 0.26)[:, None]

    out = direct_st + pre_tail_st

    # 5. 距离大气高频渐进吸收（近距 25 m 完整保留 12–20 kHz 空气脆度，远距平滑自然衰减，绝无 12 kHz 砖墙低通）
    if dist > 38.0:
        fc_dist = float(np.clip(21500.0 / (1.0 + ((dist - 38.0) / 165.0) ** 1.10), 950.0, 20800.0))
        if fc_dist < 20400.0:
            out = lp(out, fc_dist, 2)
        sh_att = -min(14.0, ((dist - 38.0) / 120.0) ** 0.88)
        out = shelf(out, float(np.clip(fc_dist * 0.85, 1200.0, 9000.0)), sh_att, 'high')

    return _finalize_stereo(out, d_sec, fin_s=0.0008, fout_s=min(0.030, d_sec * 0.12), peak=0.91)
