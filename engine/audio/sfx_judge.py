# -*- coding: utf-8 -*-
"""北冥引擎 · 音效物理形态与录音取证判定器（Stage 1，零训练确定性信号特征）。

依据 Geoffroy Peeters et al. (2011)《The Timbre Toolbox》正交物理描述符与录音取证判据，
在不依赖神经网络权重训练的前提下，筛查外部 CC0 录音或合成音效的七类常见缺陷：
  1. 削波过载 / 直流偏移（clipped_samples / dc_offset）
  2. 伪高采样率升频（8/11 kHz 老旧电话或游戏素材转存 48 kHz，bandwidth_95_hz 过低）
  3. 50/60 Hz 交流电源哼声与底噪过高（hum_prominence_db / snr_db）
  4. 录死的大堂混响尾音（近景拟音混入长 RT20，破坏混音空间同化）
  5. 动作包络错配（Log-Attack Time 与波峰因数 Crest Factor：如衣袂摩擦里混入机械硬刺 H1，或撞击音效起音拖沓）
  6. 非乐音拟音里混入合成器周期振荡或人声口技谐波梳（频谱白化自相关 pitch_prominence）
  7. 高频程序化合成伪影（>6 kHz 周期颗粒/帧跳包络调制电嗡声 hf_envelope_buzz 与 4–16 kHz 窄带金属哨音尖刺 hf_whistle_db）

接口：
  infer_archetype(name_or_query) → 原型名
  extract_metrics(x, sr=SR) → 物理指标 dict
  judge_wave(x, sr=SR, archetype='generic') → {ok, status, score, archetype, metrics, reasons}
  judge_file(path, archetype=None) → 同上（自动按文件名推断原型，除非显式指定）
"""
import json
import math
import os
import re
import sys

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import butter, sosfiltfilt
import soundfile as sf

from ._cli import ArgumentParser, CliError, rel as _rel, run as run_cli
from .dsp import SR

# 各拟音原型的物理形态约束：
# lat = (最小 log10(起音秒), 最大 log10(起音秒))；crest_max = 最大允许波峰因数 dB；
# min_bw = 95% 能量带宽下限 Hz；tonal_max = 频谱白化谐波显著度上限；rt20_max = 20dB 衰减秒上限；
# hf_buzz_max = >6 kHz 包络周期调制上限；hf_whistle_max_db = 4–16 kHz 窄带哨音尖刺上限 dB（仅设于宽带非乐音原型）
ARCHETYPES = {
    'friction_cloth': {
        'lat': (-1.90, 0.05),       # 真实衣料/织物摩擦起音 ≥ 12.5 ms；机械咔嗒/脆刺 LAT < -2.0
        'crest_max': 26.5,          # 排除孤立硬瞬态尖刺（如 snap1 = 29.6 dB）
        'min_bw': 3200.0,
        'tonal_max': 0.42,          # 排除木门吱呀粘滑谐波与嘴吹嘘声
        'rt20_max': 0.48,
        'hf_buzz_max': 0.50,
        'hf_whistle_max_db': 17.0,
    },
    'whoosh': {
        'lat': (-1.75, 0.15),       # 破空挥动需有气动建立过程（≥ 18 ms）
        'crest_max': 26.0,
        'min_bw': 2600.0,
        'tonal_max': 0.44,          # 排除合成器扫频振荡器与口技“咻”声
        'rt20_max': 0.55,
        'hf_buzz_max': 0.50,
        'hf_whistle_max_db': 17.0,
    },
    'water': {
        'lat': (-3.20, -0.35),
        'crest_max': 32.0,
        'min_bw': 3800.0,           # 水花/断水撕裂必须有中高频水沫细节
        'tonal_max': 0.42,
        'rt20_max': 0.85,
        'hf_buzz_max': 0.55,
        'hf_whistle_max_db': 18.5,
    },
    'metal_blade': {
        'lat': (-3.50, -1.10),      # 金属撞击/出鞘瞬态需干脆（≤ 80 ms）
        'crest_max': 34.0,
        'min_bw': 5200.0,           # 刀剑泛音延伸至高频
        'tonal_max': 0.92,          # 剑鸣本身允许非谐/准谐波模态
        'rt20_max': 0.95,
    },
    'impact': {
        'lat': (-3.50, -1.15),      # 打击/落点起音 ≤ 70 ms
        'crest_max': 35.0,
        'min_bw': 1800.0,
        'tonal_max': 0.48,
        'rt20_max': 0.60,
        'hf_buzz_max': 0.58,
        'hf_whistle_max_db': 19.5,
    },
    'wood': {
        'lat': (-3.50, -1.25),      # 木质敲击起音短促（≤ 56 ms）
        'crest_max': 35.0,
        'min_bw': 2600.0,
        'tonal_max': 0.55,
        'rt20_max': 0.45,
        'hf_buzz_max': 0.58,
        'hf_whistle_max_db': 19.5,
    },
    'foley_snap': {
        'lat': (-3.60, -1.50),
        'crest_max': 36.0,
        'min_bw': 3600.0,
        'tonal_max': 0.45,
        'rt20_max': 0.38,
        'hf_buzz_max': 0.55,
        'hf_whistle_max_db': 18.5,
    },
    'mechanical': {
        'lat': (-3.65, -0.85),      # 涵盖圆珠笔微动按压、塑料螺纹破拆、棘轮咬合、机械快门与钟表擒纵（0.2–140 ms）
        'crest_max': 38.5,          # 近麦精密干声瞬态峰值因数高属正常物理特征
        'min_bw': 3000.0,
        'tonal_max': 0.68,          # 允许微型弹簧/笔管壳体短促模态，但拦截合成器连续正弦波
        'rt20_max': 0.50,
    },
    'ambience': {
        'lat': (-3.50, 1.50),
        'crest_max': 28.0,
        'min_bw': 900.0,
        'tonal_max': 0.55,
        'rt20_max': None,
        'allow_low_snr': True,
        'hf_buzz_max': 0.52,
        'hf_whistle_max_db': 18.0,
    },
    'low_drone': {
        'lat': (-3.60, 1.60),       # 超低频气压/巨物体感/水下低鸣允许慢起与持续包络
        'crest_max': 32.0,
        'min_bw': 150.0,            # 能量集中在 40–450 Hz 属设计本意，不判伪升频
        'tonal_max': 0.96,
        'rt20_max': None,
        'allow_low_snr': True,
        'allow_sub_hum': True,      # 50–120 Hz 本身即体感基频区，不误报交流电源哼声
    },
    'sustained_tonal': {
        'lat': (-3.60, 0.85),       # 汽笛/号角/鲸歌鲲鸣等持续乐音，允许百毫秒级起音
        'crest_max': 32.0,
        'min_bw': 380.0,
        'tonal_max': 1.0,
        'rt20_max': None,
    },
    'tonal_ui': {
        'lat': (-3.60, -0.25),      # 兼容短促提示音与扫描式上行提示音（≤ 560 ms）
        'crest_max': 32.0,
        'min_bw': 850.0,
        'tonal_max': 1.0,
        'rt20_max': 0.85,
    },
    'motorized': {
        'lat': (-3.20, 1.40),
        'crest_max': 32.0,
        'min_bw': 900.0,
        'tonal_max': 0.98,
        'rt20_max': 2.20,
    },
    'generic': {
        'lat': (-3.60, 0.80),
        'crest_max': 35.0,
        'min_bw': 1400.0,
        'tonal_max': 0.75,
        'rt20_max': 0.90,
    },
}

_MOTOR_ONTOLOGY_RE = re.compile(
    r'servo|motor|zoom[\s_-]*lens|power[\s_-]*zoom|drill|actuator|whir|electric[\s_-]*drive|舵机|电机|马达|电动变焦',
    re.I,
)

_ARCH_PATTERNS = [
    ('low_drone', re.compile(r'glimpse|rumble|sub_hit|low_drone|drone|baro|underwater|cave|shadow|气压|低鸣|潜流|暗影', re.I)),
    ('sustained_tonal', re.compile(r'horn|foghorn|siren|kun_call|whale|bowed|汽笛|号角|鲲鸣|鲸', re.I)),
    ('ambience', re.compile(r'amb|breeze|wind_long|soft_wind|howl_wind|fog|room|forest|city|night|mist|环境|海风|微风|雾|夜', re.I)),
    ('friction_cloth', re.compile(r'cloth|robe|fabric|silk|cape|rustl|sleeve|garment|hair|衣|袍|袖|绸|发丝', re.I)),
    ('metal_blade', re.compile(r'sword|blade|slash|sheath|unsheath|katana|steel|knife|metal_ring|chime|gong|bell|剑|刃|鞘|锋|钟|锣', re.I)),
    ('water', re.compile(r'water|splash|wave|stream|river|rain|drop|cleave|pour|surf|水|浪|溪|雨|瀑|潮', re.I)),
    ('whoosh', re.compile(r'whoosh|swoosh|swish|swing|whip_air|wind_gust|bloom|破空|挥|阵风', re.I)),
    ('wood', re.compile(r'wood|bamboo|knock|clapper|muyu|bangu|branch|木|竹|梆', re.I)),
    ('motorized', _MOTOR_ONTOLOGY_RE),
    ('mechanical', re.compile(r'ratchet|unscrew|screw|shutter|watch|clock|ballpoint|pen_click|pen_cap|plastic_cap|latch|caliper|stapler|spring|gear|hinge|rotary|dial|棘轮|快门|怀表|钟表|圆珠笔|笔帽|螺纹|弹簧|卡尺|齿轮|转轴|拨盘', re.I)),
    ('foley_snap', re.compile(r'click|touch|tap|snap|switch|step|flap|pigeon|wing|触|嗒|步|翼|鹤', re.I)),
    ('impact', re.compile(r'hit|punch|thud|thump|slam|bodyfall|boom|crash|stomp|击|撞|砸|落', re.I)),
    ('tonal_ui', re.compile(r'ui|hitech|hi[-_ ]?tech|hud|laser|telemetry|ping|scan|beep|menu|interface|提示|笛|镭射', re.I)),
]


def infer_archetype(text: str) -> str:
    s = str(text or '')
    for arch, pat in _ARCH_PATTERNS:
        if pat.search(s):
            return arch
    return 'generic'


def _whitened_pitch_prominence(frames: np.ndarray, sr: int) -> float:
    """频谱白化自相关基频显著度（Tolonen & Karjalainen / Peeters Timbre Toolbox）：
    先用平滑幅度包络除掉宽带共振峰与低频滚降（使纯布料/风声/水声的低频隆隆声不产生假自相关高值），
    再测 95–1600 Hz 基频滞后区间的周期梳状峰。纯湍流噪声 ≈ 0.05–0.22，口技人声/合成器振荡器 ≈ 0.45–0.90。"""
    if len(frames) == 0:
        return 0.0
    w = frames.shape[1]
    win = np.hanning(w)
    step = max(1, len(frames) // 12)
    sel = frames[::step][:12] * win
    spec = np.abs(np.fft.rfft(sel, axis=1))
    freqs = np.fft.rfftfreq(w, 1.0 / sr)
    df = freqs[1] - freqs[0] if len(freqs) > 1 else 25.0
    sm_bins = max(3, int(round(320.0 / max(df, 1.0))))
    vals = []
    l0 = max(2, int(round(sr / 1600.0)))
    l1 = min(w // 2, int(round(sr / 95.0)))
    if l1 <= l0:
        return 0.0
    band_mask = (freqs >= 140.0) & (freqs <= min(6500.0, sr * 0.45))
    for s in spec:
        env = uniform_filter1d(s, size=sm_bins, mode='nearest')
        flat_mag = np.where(band_mask, s / (env + 1e-9), 0.0)
        ac = np.fft.irfft(flat_mag ** 2, n=w)
        if ac[0] > 1e-12:
            ac = ac / ac[0]
            vals.append(float(np.max(ac[l0:l1])))
    return float(np.percentile(vals, 80)) if vals else 0.0


def _estimate_rt20(env: np.ndarray, hop_s: float, pk_idx: int, crest_db: float = 20.0):
    """从脉冲型主峰后能量衰减曲线（Schroeder 逆向积分）估算 -5 dB 到 -25 dB 的衰减时间 rt20_s（乘 3 即等效 RT60）。
    物理约束：Schroeder 积分仅对脉冲衰减响应成立；对持续环境声、连续多次摩擦或稳态长音（尾段未衰减 ≥18 dB 或波峰因数过低）
    返回 None，避免把录音总时长误判为大堂混响。"""
    tail = env[pk_idx:]
    if len(tail) < 24 or crest_db < 16.5:
        return None
    pk_v = float(tail[0])
    if pk_v <= 1e-12:
        return None
    end_q = tail[max(1, int(len(tail) * 0.82)):]
    # 尾段必须真实单调回落（末尾 P85 ≤ 主峰 -18.4 dB 且中位数 ≤ 主峰 -13 dB），否则属于持续发声或连发序列而非房间残响
    if float(np.percentile(end_q, 85)) > 0.12 * pk_v or float(np.median(tail)) > 0.22 * pk_v:
        return None
    p = tail ** 2
    sch = np.cumsum(p[::-1])[::-1]
    if sch[0] <= 1e-24:
        return None
    sch_db = 10.0 * np.log10(sch / sch[0] + 1e-24)
    i5 = np.flatnonzero(sch_db <= -5.0)
    i25 = np.flatnonzero(sch_db <= -25.0)
    if not len(i5) or not len(i25):
        return None
    k0, k1 = int(i5[0]), int(i25[0])
    if k1 <= k0:
        return 0.0
    return round((k1 - k0) * hop_s, 4)


def _hf_envelope_buzz(m: np.ndarray, sr: int) -> float:
    """检测 >6 kHz 频段内由朴素颗粒投放、等间距脉冲列或无随机化帧跳合成留下的 33–500 Hz（滞后 2–30 ms）周期幅度调制电嗡声。"""
    if sr < 16000 or len(m) < int(round(0.085 * sr)):
        return 0.0
    thr_lin = 10.0 ** (-38.0 / 20.0)
    env_full = uniform_filter1d(np.abs(m), max(1, int(round(0.004 * sr))), mode='nearest')
    pk_full = float(env_full.max())
    if pk_full <= 1e-8:
        return 0.0
    act_full = np.flatnonzero(env_full > pk_full * thr_lin)
    if len(act_full) == 0 or (int(act_full[-1]) - int(act_full[0]) + 1) / float(sr) < 0.085:
        return 0.0

    fc = min(6000.0, 0.35 * float(sr))
    sos = butter(4, fc / (0.5 * float(sr)), btype='highpass', output='sos')
    x_hp = sosfiltfilt(sos, m)

    env = uniform_filter1d(np.abs(x_hp), max(1, int(round(0.0005 * sr))), mode='nearest')
    env_span = uniform_filter1d(env, max(3, int(round(0.020 * sr))), mode='nearest')
    pk_hp = float(env_span.max())
    if pk_hp <= 1e-12:
        return 0.0
    mask_hp = env_span > pk_hp * thr_lin
    idx_hp = np.flatnonzero(mask_hp)
    if len(idx_hp) == 0 or float(np.sum(mask_hp)) / float(sr) < 0.085:
        return 0.0
    i0, i1 = int(idx_hp[0]), int(idx_hp[-1]) + 1
    if (i1 - i0) / float(sr) < 0.085:
        return 0.0

    rms_full = float(np.sqrt(np.mean(m[int(act_full[0]):int(act_full[-1]) + 1] ** 2) + 1e-24))
    rms_hp = float(np.sqrt(np.mean(x_hp[i0:i1] ** 2) + 1e-24))
    if rms_hp <= rms_full * (10.0 ** (-55.0 / 20.0)):
        return 0.0

    env_act = env[i0:i1]
    env_det = env_act - uniform_filter1d(env_act, max(3, int(round(0.040 * sr))), mode='nearest')
    dec = max(1, int(round(sr / 4000.0)))
    sr_d = float(sr) / float(dec)
    n_d = len(env_det) // dec
    if n_d < 32:
        return 0.0
    y = env_det[:n_d * dec].reshape(n_d, dec).mean(axis=1)

    taper = min(max(4, int(round(0.006 * sr_d))), n_d // 8)
    w = np.ones(n_d, dtype=float)
    if taper > 0:
        ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(taper) / float(taper)))
        w[:taper] = ramp
        w[-taper:] = ramp[::-1]
    yw = (y - float(np.dot(w, y)) / max(float(np.sum(w)), 1e-12)) * w
    e0 = float(np.dot(yw, yw))
    if e0 <= 1e-24:
        return 0.0

    l0 = max(1, int(round(0.002 * sr_d)))
    l1 = min(n_d // 2, int(round(0.030 * sr_d)))
    if l1 <= l0:
        return 0.0

    n_fft = 1 << (2 * n_d - 1).bit_length()
    ry = np.fft.irfft(np.abs(np.fft.rfft(yw, n=n_fft)) ** 2, n=n_fft)[:l1 + 1]
    rw = np.fft.irfft(np.abs(np.fft.rfft(w, n=n_fft)) ** 2, n=n_fft)[:l1 + 1]
    acf = (ry / e0) / np.maximum(rw / rw[0], 0.65)
    z = np.flatnonzero(acf[1:] <= 0.0)
    s0 = max(l0, int(z[0]) + 1) if len(z) > 0 else l0
    if s0 > l1:
        return 0.0
    return round(float(np.clip(np.max(acf[s0:l1 + 1]), 0.0, 1.0)), 4)


def _hf_whistle_db(m: np.ndarray, sr: int) -> float:
    """检测 4.0–16.0 kHz 频段内非自然的窄带金属哨音反馈峰或梳状滤波尖刺（相对 ±400 Hz 中值局部基底的突出 dB）。"""
    if sr < 12000 or len(m) < 1024:
        return 0.0
    env_c = uniform_filter1d(np.abs(m), max(1, int(round(0.004 * sr))), mode='nearest')
    pk = float(env_c.max())
    if pk <= 1e-8:
        return 0.0
    act_mask = env_c > pk * (10.0 ** (-38.0 / 20.0))
    if int(np.sum(act_mask)) < 1024:
        return 0.0

    nfft, hop = 4096, 1024
    # 居中填充半窗零样本，确保 t=0 附近的毫秒级敲击接触宽带瞬态（MSI）不被首帧 Hann 窗左缘归零抹除
    m_pad = np.pad(m, nfft // 2, mode='constant')
    fr = np.lib.stride_tricks.sliding_window_view(m_pad, nfft)[::hop]
    w_hann = np.hanning(nfft)
    fr_win = fr * w_hann
    fr_rms = np.sqrt(np.mean(fr_win * fr_win, axis=1) + 1e-24)
    rmax = float(fr_rms.max())
    act_fr = fr_win[fr_rms >= 0.10 * rmax]
    if len(act_fr) == 0:
        act_fr = fr_win
    pw = np.mean(np.abs(np.fft.rfft(act_fr, axis=1)) ** 2, axis=0)

    freqs = np.fft.rfftfreq(nfft, 1.0 / float(sr))
    f_hi = min(16000.0, 0.45 * float(sr))
    bmask = (freqs >= 4000.0) & (freqs <= f_hi)
    if not np.any(bmask):
        return 0.0
    bpw = pw[bmask]
    tot_max, band_max = float(np.max(pw)), float(np.max(bpw))
    if band_max <= 1e-30 or tot_max <= 1e-30:
        return 0.0
    tot_db = 10.0 * np.log10(tot_max)
    max_band_db = 10.0 * np.log10(band_max)
    if max_band_db <= tot_db - 68.0:
        return 0.0
    floor_db = max(max_band_db - 45.0, tot_db - 68.0)
    spec_db = np.maximum(10.0 * np.log10(np.maximum(bpw, 1e-30)), floor_db)
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else (float(sr) / nfft)
    bins_in_800 = max(5, int(round(800.0 / max(df, 1e-6))) | 1)
    baseline_db = median_filter(spec_db, size=bins_in_800, mode='nearest')
    return round(float(max(0.0, np.max(spec_db - baseline_db))), 2)


def extract_metrics(x: np.ndarray, sr: int = SR) -> dict:
    """提取单声道或立体声信号的确定性物理形态与取证指标。"""
    arr = np.asarray(x, dtype=float)
    if arr.size == 0 or not np.all(np.isfinite(arr)):
        return {'empty_or_nan': True}
    m = arr.mean(axis=1) if arr.ndim == 2 else arr
    n = len(m)
    dur_s = n / float(sr)
    abs_all = np.abs(arr)
    peak = float(abs_all.max())
    if peak < 1e-8 or n < max(32, int(sr * 0.01)):
        return {'empty_or_nan': False, 'silent': True, 'duration_s': round(dur_s, 4), 'peak': round(peak, 6)}

    clipped = int(np.sum(abs_all >= 0.999))
    clip_ratio = clipped / float(abs_all.size)
    dc = float(np.max(np.abs(arr.mean(axis=0)))) if arr.ndim == 2 else float(abs(m.mean()))

    # 2 ms 细包络：算 Log-Attack Time、有效时长与尖峰突出度
    w2 = max(8, int(round(sr * 0.002)))
    h2 = max(1, int(round(sr * 0.0005)))
    cs = np.concatenate([[0.0], np.cumsum(m * m)])
    k2 = max(1, (n - w2) // h2 + 1)
    st2 = np.arange(min(k2, max(1, n - w2 + 1))) * h2
    env2 = np.sqrt(np.maximum(0.0, cs[st2 + min(w2, n)] - cs[st2]) / max(1, min(w2, n)))
    hop2_s = h2 / float(sr)

    pk_env = float(env2.max())
    # 第一个主冲击峰（≥ 75% 全局最大包络）
    pk_idx = int(np.argmax(env2))
    for i, v in enumerate(env2):
        if v >= 0.75 * pk_env:
            hi = min(len(env2), i + max(2, int(round(0.012 / hop2_s))))
            if v >= float(env2[i:hi].max()) - 1e-12:
                pk_idx = i
                break
    pk_v = float(env2[pk_idx])
    i90 = pk_idx
    while i90 > 0 and env2[i90] > 0.90 * pk_v:
        i90 -= 1
    i10 = i90
    while i10 > 0 and env2[i10] > 0.10 * pk_v:
        i10 -= 1
    trimmed_start = bool(i10 == 0 and env2[0] > 0.18 * pk_v)
    s_lo = min(len(env2) - 1, pk_idx + int(round(0.006 / hop2_s)))
    s_hi = min(len(env2), pk_idx + int(round(0.065 / hop2_s)) + 1)
    post_sustain = float(np.median(env2[s_lo:s_hi]) / max(pk_v, 1e-12)) if s_hi > s_lo else 0.0
    if post_sustain >= 0.28:
        trimmed_start = True
    attack_s = max(0.0003, (i90 - i10) * hop2_s)
    lat = math.log10(attack_s)

    act_mask2 = env2 >= 0.10 * pk_env
    active_dur_s = float(np.sum(act_mask2)) * hop2_s
    # 波峰因数取主峰前后 [-50ms, +200ms] 事件窗的均方根作分母，使孤立硬尖刺与持续摩擦准确拉开差距
    w_lo = max(0, pk_idx - int(round(0.050 / hop2_s)))
    w_hi = min(len(env2), pk_idx + int(round(0.200 / hop2_s)) + 1)
    win_rms = float(np.sqrt(np.mean(env2[w_lo:w_hi] ** 2) + 1e-24)) if w_hi > w_lo else float(np.sqrt(np.mean(m * m)))
    crest_db = 20.0 * math.log10(max(peak, 1e-12) / max(win_rms, 1e-12))

    # 20 ms 帧谱：算 95% 有效带宽（+6 dB/oct 斜率补偿抵消近讲 1/f^2 低频气流，专抓低采样率伪升频与闷糊）、谱平坦度等
    wf = min(n, max(64, int(round(sr * 0.025))))
    hf = max(16, wf // 4)
    if n >= wf:
        fr = np.lib.stride_tricks.sliding_window_view(m, wf)[::hf]
    else:
        fr = m[None, :]
    fr_rms = np.sqrt(np.mean(fr * fr, axis=1) + 1e-24)
    rmax = float(fr_rms.max())
    act_fr = fr[fr_rms >= 0.12 * rmax]
    if len(act_fr) == 0:
        act_fr = fr

    floor_rms = float(np.percentile(fr_rms, 10))
    has_quiet_margin = floor_rms < 0.25 * rmax and len(fr_rms) >= 6
    snr_db = 20.0 * math.log10(rmax / max(floor_rms, 1e-9)) if has_quiet_margin else None

    pw = np.mean(np.abs(np.fft.rfft(act_fr * np.hanning(act_fr.shape[1]), axis=1)) ** 2, axis=0) + 1e-24
    freqs = np.fft.rfftfreq(act_fr.shape[1], 1.0 / sr)
    pw_emph = np.where(freqs >= 80.0, pw * ((np.minimum(freqs, 16000.0) / 1000.0) ** 2), 0.0)
    cum = np.cumsum(pw_emph)
    bw95 = float(freqs[min(len(freqs) - 1, int(np.searchsorted(cum, 0.95 * cum[-1])))]) if cum[-1] > 0 else 0.0

    f_band = (freqs >= 220.0) & (freqs <= min(8000.0, sr * 0.45))
    if np.any(f_band):
        bpw = pw[f_band]
        flatness = float(np.exp(np.mean(np.log(bpw))) / np.mean(bpw))
    else:
        flatness = 0.0

    # 50/60 Hz 电源哼声：需要细频谱分辨率（≥ 0.25s 才测）
    hum_db = 0.0
    if n >= int(sr * 0.25):
        n_hum = min(n, int(sr * 1.0))
        sp_h = np.abs(np.fft.rfft(m[:n_hum] * np.hanning(n_hum))) ** 2 + 1e-24
        fh = np.fft.rfftfreq(n_hum, 1.0 / sr)
        cont = sp_h[(fh >= 35.0) & (fh <= 170.0)]
        if len(cont) >= 8:
            med = float(np.median(cont))
            hum_peaks = [float(sp_h[np.abs(fh - f0) <= 2.5].max()) for f0 in (50.0, 60.0, 100.0, 120.0) if np.any(np.abs(fh - f0) <= 2.5)]
            if hum_peaks and med > 0:
                hum_db = max(0.0, 10.0 * math.log10(max(hum_peaks) / med))

    pitch_prom = _whitened_pitch_prominence(act_fr, sr)
    rt20_s = _estimate_rt20(env2, hop2_s, pk_idx, crest_db)
    hf_buzz = _hf_envelope_buzz(m, sr)
    hf_whistle = _hf_whistle_db(m, sr)

    return {
        'empty_or_nan': False,
        'silent': False,
        'sample_rate': int(sr),
        'duration_s': round(dur_s, 4),
        'active_dur_s': round(active_dur_s, 4),
        'peak': round(peak, 5),
        'clipped_samples': clipped,
        'clip_ratio': round(clip_ratio, 6),
        'dc_offset': round(dc, 6),
        'trimmed_start': trimmed_start,
        'log_attack_time': round(lat, 3),
        'attack_ms': round(attack_s * 1000.0, 2),
        'crest_factor_db': round(crest_db, 2),
        'bandwidth_95_hz': round(bw95, 1),
        'spectral_flatness': round(flatness, 4),
        'pitch_prominence': round(pitch_prom, 4),
        'hf_envelope_buzz': hf_buzz,
        'hf_whistle_db': hf_whistle,
        'hum_prominence_db': round(hum_db, 2),
        'snr_db': round(snr_db, 2) if snr_db is not None else None,
        'rt20_s': rt20_s,
    }


def _apply_manifest_window(x: np.ndarray, sr: int, spec: dict) -> np.ndarray:
    """按 sfx_manifest.json 的裁剪范围（start / len）截取实际入片片段，避免把未入片的片头片尾静音或杂音算进形态指标。"""
    if not spec or not isinstance(spec, dict):
        return x
    a = max(0, int(round(float(spec.get('start', 0.0) or 0.0) * sr)))
    if a >= len(x):
        return x
    if 'len' in spec and spec['len'] is not None:
        b = min(len(x), a + max(1, int(round(float(spec['len']) * sr))))
        return x[a:b]
    return x[a:]


def _primary_slice_if_multi(x: np.ndarray, sr: int) -> np.ndarray:
    """对鸽翼连扑、圆珠笔连续按压、钟表滴答等多事件录音素材，提取能量最强的一段独立短事件测起音包络与混响。"""
    m = x.mean(axis=1) if x.ndim == 2 else x
    win = max(4, int(round(sr * 0.004)))
    if len(m) < int(sr * 0.28):
        return x
    env = np.sqrt(np.convolve(m * m, np.ones(win) / win, 'same'))
    pk = float(env.max())
    if pk <= 1e-12:
        return x
    edges = np.flatnonzero(np.diff(np.r_[False, env > pk * 0.14, False])).reshape(-1, 2)
    valid = [(a, b) for a, b in edges if (b - a) >= int(sr * 0.0025)]
    if len(valid) < 2:
        return x
    a, b = max(valid, key=lambda ab: float(env[ab[0]:ab[1]].max()))
    s0 = max(0, int(a) - int(sr * 0.012))
    s1 = min(len(x), int(b) + int(sr * 0.035), s0 + int(sr * 0.18))
    return x[s0:s1] if (s1 - s0) >= int(sr * 0.015) else x


def judge_wave(x: np.ndarray, sr: int = SR, archetype: str = 'generic', *, spec: dict = None) -> dict:
    """按物理原型（及可选清单设计意图 spec）判定一段波形：返回 status ∈ {'pass', 'suspect', 'reject'}、0..100 分与逐条原因。"""
    spec = spec if isinstance(spec, dict) else {}
    # 若清单显式用低通把素材压到 ≤550 Hz 作体感/闷远层（如 kun_glimpse lp=400、amb_close lp=500），尊重导演滤波意图
    explicit_lp = float(spec['lp']) if ('lp' in spec and spec['lp'] is not None) else None
    if explicit_lp is not None and explicit_lp <= 550.0 and archetype in ('generic', None):
        arch = 'low_drone'
    else:
        arch = archetype if archetype in ARCHETYPES else infer_archetype(archetype)
    cfg = ARCHETYPES[arch]

    raw_m = extract_metrics(x, sr)
    if raw_m.get('empty_or_nan'):
        return {'ok': False, 'status': 'reject', 'score': 0.0, 'archetype': arch, 'metrics': raw_m, 'reasons': ['空信号或含 NaN/Inf']}
    if raw_m.get('silent'):
        return {'ok': False, 'status': 'reject', 'score': 0.0, 'archetype': arch, 'metrics': raw_m, 'reasons': ['近乎全静音']}

    x_eval = _apply_manifest_window(x, sr, spec)
    if arch in ('foley_snap', 'mechanical'):
        x_eval = _primary_slice_if_multi(x_eval, sr)
    m = extract_metrics(x_eval, sr) if x_eval is not x else raw_m
    if m.get('empty_or_nan') or m.get('silent'):
        m = raw_m
    # 原始文件若已削波，即使裁剪段外也不漏报；裁剪段内削波更直接命中
    m['clipped_samples'] = max(int(m.get('clipped_samples', 0)), int(raw_m.get('clipped_samples', 0)))
    m['clip_ratio'] = max(float(m.get('clip_ratio', 0.0)), float(raw_m.get('clip_ratio', 0.0)))

    score = 100.0
    hard, soft = [], []

    # 1. 取证硬伤
    if m['clipped_samples'] >= 24 or m['clip_ratio'] > 0.0005:
        hard.append(f"削波过载（{m['clipped_samples']} 个满幅样本）")
        score -= 45.0
    elif m['clipped_samples'] >= 6:
        soft.append(f"轻微触顶（{m['clipped_samples']} 个样本）")
        score -= 12.0

    if m['dc_offset'] > 0.03:
        hard.append(f"直流偏移严重（{m['dc_offset']:.4f}）")
        score -= 35.0
    elif m['dc_offset'] > 0.012:
        soft.append(f"直流偏移偏高（{m['dc_offset']:.4f}）")
        score -= 10.0

    min_bw = float(cfg['min_bw'])
    if explicit_lp is not None:
        min_bw = min(min_bw, max(120.0, explicit_lp * 0.72))

    if m['bandwidth_95_hz'] < min_bw * 0.65:
        hard.append(f"有效带宽过窄（95% 能量仅到 {m['bandwidth_95_hz']:.0f} Hz，疑似低采样率劣质素材升频或严重闷糊）")
        score -= 35.0
    elif m['bandwidth_95_hz'] < min_bw:
        soft.append(f"高频延伸不足（95% 能量到 {m['bandwidth_95_hz']:.0f} Hz < 期望 {min_bw:.0f} Hz）")
        score -= 14.0

    if not cfg.get('allow_low_snr') and m['snr_db'] is not None and m['snr_db'] < 14.0:
        soft.append(f"录音底噪过高（信噪比仅 {m['snr_db']:.1f} dB）")
        score -= 18.0

    if arch not in ('tonal_ui', 'sustained_tonal') and not cfg.get('allow_sub_hum') and m['hum_prominence_db'] > 16.0:
        soft.append(f"疑似 50/60 Hz 交流电源哼声（突出 {m['hum_prominence_db']:.1f} dB）")
        score -= 16.0

    # 2. 包络与动作形态（LAT + Crest Factor；首帧已被硬裁剪进持续段且无高波峰尖刺时不误判起音过陡）
    lat_lo, lat_hi = cfg['lat']
    lat = m['log_attack_time']
    skip_sharp_lat = m.get('trimmed_start') and m['crest_factor_db'] <= cfg['crest_max'] - 2.0
    if not skip_sharp_lat and lat < lat_lo - 0.25:
        hard.append(f"起音过陡（LAT={lat:.2f} / {m['attack_ms']:.1f} ms < 下限 {lat_lo:.2f}，混入硬瞬态/机械咔嗒混淆物）")
        score -= 38.0
    elif not skip_sharp_lat and lat < lat_lo:
        soft.append(f"起音偏硬（LAT={lat:.2f} / {m['attack_ms']:.1f} ms < 建议 {lat_lo:.2f}）")
        score -= 15.0
    elif lat > lat_hi + 0.30:
        hard.append(f"起音拖沓（LAT={lat:.2f} / {m['attack_ms']:.1f} ms > 上限 {lat_hi:.2f}，缺乏撞击瞬态）")
        score -= 35.0
    elif lat > lat_hi:
        soft.append(f"起音偏慢（LAT={lat:.2f} / {m['attack_ms']:.1f} ms > 建议 {lat_hi:.2f}）")
        score -= 14.0

    if m['crest_factor_db'] > cfg['crest_max'] + 2.5:
        hard.append(f"波峰因数过高（{m['crest_factor_db']:.1f} dB > {cfg['crest_max']:.1f} dB，存在孤立机械尖刺）")
        score -= 32.0
    elif m['crest_factor_db'] > cfg['crest_max']:
        soft.append(f"波峰因数偏高（{m['crest_factor_db']:.1f} dB）")
        score -= 12.0

    # 3. 谐波污染（口技人声/合成器振荡器/粘滑吱呀混入宽带拟音）
    if m['pitch_prominence'] > cfg['tonal_max'] + 0.14:
        hard.append(f"非乐音拟音检出强周期谐波（pitch={m['pitch_prominence']:.2f} > {cfg['tonal_max']:.2f}，疑似口技摹拟、合成器或谐波异响）")
        score -= 36.0
    elif m['pitch_prominence'] > cfg['tonal_max']:
        soft.append(f"周期谐波偏强（pitch={m['pitch_prominence']:.2f} > {cfg['tonal_max']:.2f}）")
        score -= 15.0

    # 3b. 高频程序化合成伪影（>6 kHz 颗粒/脉冲周期调制电嗡声与 4–16 kHz 窄带哨音尖刺，仅约束宽带非乐音拟音）
    if explicit_lp is None or explicit_lp >= 4000.0:
        buzz_max = cfg.get('hf_buzz_max')
        if buzz_max is not None:
            buzz = float(m.get('hf_envelope_buzz', 0.0))
            if buzz > buzz_max + 0.07:
                hard.append(f"高频包络呈周期性调制电嗡声（hf_envelope_buzz={buzz:.3f} > {buzz_max}）")
                score -= 36.0
            elif buzz > buzz_max:
                soft.append(f"高频包络呈周期性调制电嗡声（hf_envelope_buzz={buzz:.3f} > {buzz_max}）")
                score -= 15.0

        whistle_max = cfg.get('hf_whistle_max_db')
        if whistle_max is not None:
            whistle = float(m.get('hf_whistle_db', 0.0))
            if whistle > whistle_max + 1.8:
                hard.append(f"高频存在窄带哨音尖刺（hf_whistle_db={whistle:.1f} dB > {whistle_max} dB）")
                score -= 36.0
            elif whistle > whistle_max:
                soft.append(f"高频存在窄带哨音尖刺（hf_whistle_db={whistle:.1f} dB > {whistle_max} dB）")
                score -= 15.0

    # 4. 录死混响尾音（仅对脉冲型衰减信号生效）
    if cfg['rt20_max'] is not None and m['rt20_s'] is not None and m['duration_s'] >= 0.45:
        if m['rt20_s'] > cfg['rt20_max'] * 1.6:
            soft.append(f"自带混响尾音过长（RT20={m['rt20_s']:.2f}s，等效 RT60≈{m['rt20_s'] * 3:.1f}s，不易做近景空间同化）")
            score -= 16.0

    score = round(max(0.0, min(100.0, score)), 1)
    status = 'reject' if (hard or score < 55.0) else ('suspect' if (soft or score < 80.0) else 'pass')
    return {
        'ok': status != 'reject',
        'status': status,
        'score': score,
        'archetype': arch,
        'metrics': m,
        'reasons': hard + soft,
    }


def judge_file(path: str, archetype: str = None, *, spec: dict = None) -> dict:
    try:
        x, sr = sf.read(path, dtype='float64', always_2d=True)
    except Exception as e:
        return {
            'ok': False, 'status': 'reject', 'score': 0.0,
            'archetype': archetype or infer_archetype(os.path.basename(path)),
            'metrics': {}, 'reasons': [f'音频无法解码：{e}'], 'file': _rel(path),
        }
    arch = archetype or ((spec or {}).get('archetype') if isinstance(spec, dict) else None) or infer_archetype(os.path.basename(path))
    res = judge_wave(x, sr, arch, spec=spec)
    res['file'] = _rel(path)
    return res


def judge_ontology(x: np.ndarray, sr: int = 48000, *, power: str = 'passive',
                   name: str = '', tags=()) -> dict:
    """因果本体取证（Causal Ontology Guard）：
    当画面物体为无源机构（power='passive'，如手按弹簧圆珠笔、机械拨盘、冷兵器）时，
    从标签语义与信号特征两路拦截“电机/伺服持续正弦嗡鸣”与“np.tile 机械周期循环”：
      · sustained_tone_ms：80–3000 Hz 内主导窄带谱峰（相邻帧频率漂移 ≤ 3.5%、峰均比 ≥ 14）最长连续驻留毫秒数；
      · loop_periodicity：包络去均值自相关在 40–500 ms 滞后区间的最大周期重复系数（需样本长度 ≥ 3 个滞后周期）。"""
    m = x.mean(axis=1) if np.ndim(x) == 2 else np.asarray(x, dtype=float)
    text_blob = ' '.join([str(name or ''), *(str(t) for t in (tags or ()))])
    reasons = []
    status = 'pass'

    win = max(64, int(round(0.020 * sr)))
    hop = max(32, win // 2)
    sustained_ms = 0.0
    if len(m) >= win * 2:
        k = (len(m) - win) // hop + 1
        fr = np.lib.stride_tricks.sliding_window_view(m, win)[::hop][:k] * np.hanning(win)
        rms = np.sqrt(np.mean(fr * fr, axis=1))
        active = rms > max(1e-5, 0.12 * float(rms.max()))
        spec = np.abs(np.fft.rfft(fr, axis=1)) ** 2
        fq = np.fft.rfftfreq(win, 1.0 / sr)
        band = (fq >= 80.0) & (fq <= min(3000.0, sr * 0.45))
        if np.any(band):
            sb = spec[:, band]
            fb = fq[band]
            pk_idx = np.argmax(sb, axis=1)
            pk_f = fb[pk_idx]
            crest_f = sb[np.arange(k), pk_idx] / (np.median(sb, axis=1) + 1e-24)
            tonal_f = active & (crest_f >= 16.0)
            best_run, cur_run, prev_f = 0, 0, -1.0
            for ok_t, f0 in zip(tonal_f, pk_f):
                if ok_t and (prev_f < 0 or abs(f0 - prev_f) / max(prev_f, 1.0) <= 0.035):
                    cur_run += 1
                    best_run = max(best_run, cur_run)
                    prev_f = float(f0)
                elif ok_t:
                    cur_run = 1
                    prev_f = float(f0)
                else:
                    cur_run = 0
                    prev_f = -1.0
            sustained_ms = round(best_run * (hop / float(sr)) * 1000.0, 1)

    loop_per = 0.0
    env_hop = max(16, int(round(0.004 * sr)))
    if len(m) >= int(round(0.16 * sr)):
        n_e = len(m) // env_hop
        env = np.sqrt(np.mean(m[:n_e * env_hop].reshape(n_e, env_hop) ** 2, axis=1))
        env = env - float(np.mean(env))
        denom = float(np.dot(env, env))
        l_lo = max(4, int(round(0.040 * sr / env_hop)))
        l_hi = min(n_e // 3, int(round(0.500 * sr / env_hop)))
        if denom > 1e-18 and l_hi > l_lo:
            ac = [float(np.dot(env[:-lg], env[lg:])) / denom for lg in range(l_lo, l_hi + 1)]
            loop_per = round(max(0.0, max(ac)), 4)

    if power == 'passive':
        if _MOTOR_ONTOLOGY_RE.search(text_blob):
            status = 'reject'
            reasons.append('无源机构（passive）命中电机/伺服标签词')
        if sustained_ms > 120.0:
            status = 'reject'
            reasons.append(f'检出 {sustained_ms:.0f} ms 持续窄带调性嗡鸣（疑似电机/振荡器残留，上限 120 ms）')
        if loop_per > 0.85:
            if status == 'pass':
                status = 'suspect'
            reasons.append(f'包络周期自相关 {loop_per:.2f} > 0.85（疑似 np.tile 死循环拼接）')

    return {
        'ok': status != 'reject',
        'status': status,
        'power': power,
        'metrics': {'sustained_tone_ms': sustained_ms, 'loop_periodicity': loop_per},
        'reasons': reasons,
    }


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.sfx_judge',
                       description='音效物理形态与录音取证判定（Stage 1，零训练）：退出码 0 通过、4 检出不合格素材')
    p.add_argument('target', help='音频文件或目录')
    p.add_argument('--archetype', help='指定拟音原型（' + ' / '.join(ARCHETYPES) + '；默认按文件名推断）')
    p.add_argument('--manifest', help='可选 sfx_manifest.json：按清单里的键名与裁剪/滤波参数推断目录内 <id>.* 的原型')
    return p


def main_cli(args, ctx):
    if not os.path.exists(args.target):
        raise CliError('env.input-missing', f'找不到待检目标：{args.target}')
    id_to_entry = {}
    if args.manifest and os.path.exists(args.manifest):
        with open(args.manifest, encoding='utf-8') as f:
            sounds = json.load(f).get('sounds', {})
        id_to_entry = {str(v.get('id')): (k, v) for k, v in sounds.items() if isinstance(v, dict) and 'id' in v}

    paths = []
    if os.path.isdir(args.target):
        for fn in sorted(os.listdir(args.target)):
            if fn.lower().endswith(('.wav', '.flac', '.mp3', '.ogg', '.m4a')):
                paths.append(os.path.join(args.target, fn))
    else:
        paths.append(args.target)
    if not paths:
        raise CliError('usage.empty-dir', f'目录里没有音频文件：{args.target}')

    results = []
    for p in paths:
        stem = os.path.splitext(os.path.basename(p))[0]
        hint_name, spec = id_to_entry.get(stem, (stem, None))
        arch = args.archetype or ((spec or {}).get('archetype') if isinstance(spec, dict) else None) or infer_archetype(hint_name)
        r = judge_file(p, arch, spec=spec)
        r['name'] = hint_name
        results.append(r)
        mark = {'pass': '✓', 'suspect': '!', 'reject': '✗'}[r['status']]
        why = (' —— ' + '；'.join(r['reasons'])) if r['reasons'] else ''
        ctx.out(f"  {mark} {hint_name:16} [{r['archetype']:15}] {r['score']:5.1f} 分{why}")

    counts = {s: sum(1 for r in results if r['status'] == s) for s in ('pass', 'suspect', 'reject')}
    ok = counts['reject'] == 0
    data = {'ok': ok, 'counts': counts, 'results': results}
    if not ok:
        bad = [r['name'] for r in results if r['status'] == 'reject']
        return {'data': data, 'error': {'code': 'contract.sfx-judge', 'message': '检出不合格音效素材：' + '、'.join(bad),
                                        'hint': '更换或裁剪被拒素材（原因见 reasons）'}}
    return {'data': data}


def main(argv=None):
    return run_cli(main_cli, make_parser(), argv=argv, command='audio:sfx-judge')


if __name__ == '__main__':
    sys.exit(main())
