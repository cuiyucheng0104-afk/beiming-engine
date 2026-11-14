# -*- coding: utf-8 -*-
"""《北冥》声音设计：全部程序化合成，确定性（每个函数自带种子）。环境声（城市、江水、风、发丝、海风）用 engine/audio/ambience.py。

声音家族（导演定调第五节）：渡船汽笛和鲲鸣用同一个发声器 voice()（engine/audio/synth.py）——
  同样的谐波基准谱（3–8 次谐波抬高的“铜管中段”）、同样的“越响越亮”规律、同样的气息噪声。
  汽笛 = A3→D3 两个音、短、稳；鲲鸣 = 低一个八度的 A2→D2，慢慢下滑，带移动的共振峰和扫过泛音列的窄共振峰。
显示层（眼镜）的提示音：一组干净的玻璃质正弦音（engine/audio/synth.glass_seq），干声、居中、不进世界的混响——
  对应画面规则“显示层不加颗粒、不受 bloom 影响”。
"""
import numpy as np
from engine.audio.dsp import (SR, N, T, smoothstep, curve, fade, rng, norm, un_safe, white, pink, brown,
                              lp, hp, bp, svf, stereo, place, decor_pair)
from engine.audio.synth import voice, glass_seq, bubble, events


# ———————————————————— 汽笛与鲲鸣：同一个发声器 engine/audio/synth.voice ————————————————————
def horn(seed=101):
    """渡船汽笛：两个音，A3(220 Hz) 0.40 s → 60 ms 下滑 → D3(146.8 Hz)，共 1.2 s（雾笛式“高→低”）。
    起音带一点气压建立时的上滑和“喘”，换音处轻微凹陷，收尾气压下降、音高下沉。返回干声单声道（1.45 s）。"""
    d = 1.45
    t = T(d)
    st = -7.0 * smoothstep(0.40, 0.46, t)                       # A3 → D3
    st += -0.35 * (1 - smoothstep(0.0, 0.12, t))                 # 起音：气压建立，上滑进音
    st += 0.12 * smoothstep(0.46, 0.56, t) * (1 - smoothstep(0.56, 0.78, t))   # 换音后轻微过冲
    st += -0.30 * smoothstep(1.06, 1.28, t)                      # 收尾：气压泄掉，音高下沉
    f0 = 220.0 * 2 ** (st / 12)
    amp = curve([(0, 0), (0.03, 0.5), (0.085, 1.04), (0.15, 0.97), (0.385, 0.98), (0.43, 0.80), (0.50, 1.0),
                 (0.95, 0.96), (1.10, 0.84), (1.21, 0.0), (1.45, 0.0)], t)
    x = voice(f0, amp, seed, kmax=42, tilt=0.72, mids=(3, 8, 1.6), brass=0.10,
              formants=[(650, 520, 1.0), (1500, 800, 0.5)], floor=0.28, breath=0.05, breath_f=(700, 1700))
    # 第二个音更“粗”：加一点亚谐波（f0/2）和慢的粗糙调制
    sub = np.sin(np.pi * np.cumsum(f0) / SR) * amp * 0.10 * smoothstep(0.45, 0.62, t)
    x = x + sub * np.std(x) * 0.9
    r = rng(seed + 1)
    chuff = bp(r.standard_normal(N(0.05)), 400, 3200, 2) * np.exp(-np.arange(N(0.05)) / SR / 0.012)
    x[:len(chuff)] += un_safe(chuff) * np.std(x) * 0.45
    rel = bp(r.standard_normal(N(0.12)), 300, 2000, 2) * np.sin(np.linspace(0, np.pi, N(0.12))) ** 2
    s = N(1.10)
    x[s:s + len(rel)] += un_safe(rel) * np.std(x) * 0.12
    return norm(fade(x, 0.0, 0.08))


def kun_call(seed=202):
    """鲲鸣：和汽笛同一个发声器，低一个八度。
    0.00–0.22 s 从 F#2 抬进 A2（110 Hz）→ 长音（4 Hz 颤音渐深，元音 oo→aa 张开）→
    1.25–2.30 s 慢慢滑到 D2（73.4 Hz，正好是汽笛第二个音的下八度）→ 尾音再沉 2.5 个半音并消失。
    窄共振峰在 0.9–2.4 s 从 620 Hz 扫到 1500 Hz：基频往下走、泛音旋律往上走（鲸歌感）。返回干声单声道（2.75 s）。"""
    D = 2.75
    t = T(D)
    s = -3.0 * (1 - smoothstep(0.0, 0.22, t))
    s += -7.0 * smoothstep(1.25, 2.30, t)
    s += -2.5 * smoothstep(2.34, 2.75, t)
    s += 0.08 * smoothstep(0.3, 1.2, t)
    rate = 4.0 + 0.6 * smoothstep(0.3, 1.2, t)
    depth = 0.22 * smoothstep(0.35, 1.0, t) * (1 - 0.6 * smoothstep(1.3, 2.2, t))
    s += depth * np.sin(2 * np.pi * np.cumsum(rate) / SR)
    f0 = 110.0 * 2 ** (s / 12)
    amp = curve([(0, 0), (0.06, 0.30), (0.25, 0.72), (0.80, 1.0), (1.40, 0.93), (2.05, 0.72), (2.45, 0.33), (2.75, 0.0)], t)
    F1 = curve([(0, 330), (0.8, 640), (1.4, 600), (2.3, 380), (2.75, 330)], t)
    F2 = curve([(0, 850), (0.8, 1150), (1.4, 1080), (2.3, 760), (2.75, 700)], t)
    nf = curve([(0.9, 620), (2.4, 1500)], t)
    ng = curve([(0.9, 0.0), (1.3, 1.3), (1.9, 1.6), (2.45, 0.0)], t)
    x = voice(f0, amp, seed, kmax=64, tilt=0.72, mids=(3, 8, 1.6), brass=0.13,
              formants=[(105, 90, 0.5), (F1, 170, 1.0), (F2, 240, 0.6), (2500, 320, 0.22)], floor=0.16,   # 105 Hz“胸腔”共鸣：巨体的分量
              narrow=(nf, 70, ng), breath=0.06, breath_f=(F1, F2))
    # 起音的“喉音”：亚谐波 + 26 Hz 粗糙调制（只在开头半秒）
    onset = 1 - smoothstep(0.12, 0.5, t)
    x = x * (1 + 0.28 * onset * np.sin(2 * np.pi * 26 * t))
    x = x + np.sin(np.pi * np.cumsum(f0) / SR) * amp * onset * np.std(x) * 0.6
    x = np.tanh(1.3 * x / (np.abs(x).max() + 1e-12)) / np.tanh(1.3)
    return norm(fade(x, 0.01, 0.12))


# ———————————————————— 镜头 A：鸽群 ————————————————————
def _flap(r, strength):
    """一次下扑：气流“噗”（低通噪声）+ 羽毛“唰”（带通噪声里夹稀疏尖刺），起音 3–5 ms，衰减 18–24 ms，一下一下分得开"""
    m = N(0.08)
    t = np.arange(m) / SR
    whump = un_safe(lp(r.standard_normal(m), r.uniform(500, 800), 2)) * np.minimum(1, t / 0.005) * np.exp(-t / 0.024)
    spk = 0.5 + 3.0 * (r.random(m) < 0.05)
    rust = un_safe(bp(r.standard_normal(m) * spk, 1400, 7000, 2)) * np.minimum(1, t / 0.003) * np.exp(-t / 0.018)
    return (whump * 0.85 + rust * 0.6) * strength * r.uniform(0.8, 1.1)


def _clap(r):
    m = N(0.035)
    t = np.arange(m) / SR
    x = un_safe(bp(r.standard_normal(m), 700, 7000, 2)) * np.exp(-t / 0.0035)
    x += (np.sin(2 * np.pi * r.uniform(1100, 1500) * t) * 0.5 + np.sin(2 * np.pi * r.uniform(2400, 3000) * t) * 0.3) * np.exp(-t / 0.006)
    return x * r.uniform(0.7, 1.0)


def _scuffle(r):
    m = N(0.02)
    t = np.arange(m) / SR
    return un_safe(hp(r.standard_normal(m), 2500, 2)) * np.exp(-t / 0.004)


def pigeons(seed=303, n_birds=10, d=2.6, heading=0.72):
    """鸽群惊起（时间相对 0.80 s）：起飞时翅膀在背上互击的“啪” + 每次下扑的气流“噗”与羽毛沙沙。
    10 只，0.3 s 内陆续起飞；前几下近、干、响，之后 12–18 m/s 往上往远飞（变小、变闷、混响比例变大），约 1.5 s 后基本听不见。
    heading 是飞向右上的比例。返回 (近处立体声, 送混响用的远处立体声)"""
    r = rng(seed)
    near = np.zeros((N(d), 2))
    far = np.zeros((N(d), 2))
    for b in range(n_birds):
        tb = 0.0 if b == 0 else min(0.32, r.gamma(1.4, 0.07))
        f0, f1 = r.uniform(8.5, 10.0), r.uniform(6.5, 7.5)
        nb = int(r.integers(8, 13))
        d0, v = r.uniform(2.0, 4.5), r.uniform(12.0, 18.0)
        p0 = r.uniform(-0.3, 0.3)
        p1 = (1 if r.random() < heading else -1) * r.uniform(0.5, 0.95)
        tk = tb + 0.02 + r.uniform(0.0, 0.015)
        place(near, _scuffle(r), tk - 0.02, (3 / d0) * 0.18, p0)     # 起飞前脚爪一蹬
        for k in range(nb):
            age = tk - tb
            dist = np.sqrt(d0 ** 2 + (v * age) ** 2)
            g = (3.0 / dist) ** 1.2
            pan = p0 + (p1 - p0) * smoothstep(0, 1.3, age)
            cut = float(np.clip(15000 * (3.0 / dist) ** 0.55, 2600, 15000))
            period = 1 / (f0 + (f1 - f0) * smoothstep(0, 0.6, age))
            fl = lp(_flap(r, 1.0 if k < 2 else (0.8 if k < 4 else 0.62)), cut, 2)
            place(near, fl, tk, g, pan)
            place(far, fl, tk, g * min(1.0, dist / 20), pan)
            if k < 3 and r.random() < 0.85:
                place(near, lp(_clap(r), cut, 2), tk + 0.5 * period, g * (1.3 if k == 0 else 0.8), pan)
            tk += period * r.uniform(0.96, 1.04)
    return near, far


def kun_glimpse(seed=404, d=1.85):
    """镜头 A 1.20–3.00：鲲的背脊在云层里滑过——极低的气压涌动，几乎听不见，只给体感"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    env = curve([(0, 0), (0.55, 0.45), (1.05, 1.0), (1.5, 0.7), (1.85, 0.35)], t)
    low = un_safe(svf(brown(n, r), 90 + 60 * env, 0.7, 'lp'))
    rush = un_safe(svf(pink(n, r), 260 + 160 * env, 0.9, 'bp'))
    return fade((low + 0.25 * rush) * env, 0.05, 0.02)


# ———————————————————— 镜头 B ————————————————————
def touch_click(seed=505):
    """手指轻触镜腿：短的“嗒”（1.8–6 kHz，干净）+ 指腹贴上的软体感 + 镜腿外壳的两个小共振（1.85 / 3.15 kHz）。
    频率故意比发丝声（3–9 kHz）低一点，不被风里的沙沙声盖住。"""
    r = rng(seed)
    m = N(0.06)
    t = np.arange(m) / SR
    tick = un_safe(lp(bp(r.standard_normal(m), 1800, 6000, 2), 7000, 2)) * np.exp(-t / 0.0012)
    body = np.sin(2 * np.pi * 430 * t) * np.exp(-t / 0.006) * 0.35 + un_safe(lp(r.standard_normal(m), 900, 2)) * np.exp(-t / 0.004) * 0.25
    res = np.sin(2 * np.pi * 1850 * t) * np.exp(-t / 0.004) * 0.30 + np.sin(2 * np.pi * 3150 * t) * np.exp(-t / 0.0025) * 0.15
    return norm(tick * 0.55 + body + res)


# 显示层提示音：一串玻璃音，notes=[(相对秒, 频率Hz, 增益dB, 衰减秒)] → 单声道
ui_seq = glass_seq


def shadow_swell(seed=606, d=1.2):
    """镜头 B 3.80–5.00：镜片反光里巨影划过——低频气压上涌，末尾一口“吸气”，在 5.00 硬切给“打开”"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    e = smoothstep(0.0, d, t) ** 2
    low = un_safe(svf(brown(n, r), 70 + 220 * smoothstep(0.2, d, t), 0.7, 'lp'))
    mid = un_safe(svf(pink(n, r), 300 + 500 * smoothstep(0.5, d, t), 0.8, 'bp'))
    inh = un_safe(lp(hp(white(n, r), 2500, 2), 9000, 2)) * smoothstep(d - 0.35, d, t) ** 3
    return fade(low * e + mid * 0.35 * e ** 1.5 + inh * 0.12, 0.05, 0.008)


def open_bloom(seed=616, d=2.0):
    """5.00 切第一视角“空间突然打开”：一口很宽的空气（左右完全去相关的 0.6–7 kHz 噪声），
    10 ms 内打开、带通中心从 1.4 kHz 升到 3.2 kHz 再回落，约 0.6 s 时间常数散开（之后交给天空混响）"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    env = smoothstep(0, 0.012, t) * np.exp(-t / 0.6)
    fc = curve([(0, 1400), (0.25, 3200), (d, 1800)], t)
    src = decor_pair(pink, n, r, corr=0.0)
    x = un_safe(svf(src, fc, 0.5, 'bp'))
    air = un_safe(hp(decor_pair(white, n, r, corr=0.0), 6000, 2))
    return (x + air * 0.15) * env[:, None]


# ———————————————————— 镜头 C：鲲掠过 ————————————————————
def _groan(r, d=0.9, f=61.7):
    t = T(d)
    fm = f * (1 + 0.035 * np.sin(2 * np.pi * 0.9 * t) - 0.05 * t)
    ph = 2 * np.pi * np.cumsum(fm) / SR
    x = sum(np.sin(k * ph + r.uniform(0, 6)) / k ** 1.1 for k in range(1, 9))
    x = bp(x, 50, 700, 2)
    am = 0.55 + 0.45 * np.abs(np.sin(2 * np.pi * 6.5 * t + r.uniform(0, 6)))
    return un_safe(x) * am * np.sin(np.pi * t / d) ** 1.5


def kun_pass(seed=707, d=3.4):
    """鲲从头顶滑过（时间相对 6.30；主体 6.40–8.60 右→左）。
    低频气流（截止随强度升高）+ 气流冲刷（中心频率从 650 降到 300 Hz，近似多普勒）+ 高频湍流 + 两声巨体的低沉“吱呀”（B1，有 2、3 次谐波，小喇叭也能听见）。
    返回 (立体声, 声像曲线, 强度包络)"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    env = curve([(0, 0), (0.1, 0.05), (0.6, 0.5), (1.0, 0.92), (1.2, 1.0), (1.55, 0.88), (2.05, 0.5), (2.5, 0.15), (3.4, 0)], t)
    pan = 0.65 - 1.3 * smoothstep(0.1, 2.3, t)
    lowL = un_safe(svf(brown(n, r), 85 + 150 * env, 0.75, 'lp'))
    lowR = un_safe(svf(brown(n, r), 85 + 150 * env, 0.75, 'lp'))
    rushfc = curve([(0, 650), (1.2, 560), (1.6, 430), (2.6, 300)], t)
    rushL = un_safe(svf(pink(n, r), rushfc, 0.9, 'bp'))
    rushR = un_safe(svf(pink(n, r), rushfc, 0.9, 'bp'))
    tex = np.abs(lp(white(n, r), 18.0, 2))
    tex = tex / (tex.max() + 1e-12)
    turb = un_safe(bp(white(n, r), 1800, 5200, 2)) * (0.3 + 1.4 * tex)
    gro = np.zeros(n)
    for at, gd in [(0.62, 0.95), (1.62, 1.1)]:
        x = _groan(r, gd)
        s = N(at)
        gro[s:s + len(x)] += x[:n - s]
    L = (lowL * 1.3 + rushL * 0.45 + turb * 0.08) * env + gro * 0.30
    R = (lowR * 1.3 + rushR * 0.45 + turb * 0.08) * env + gro * 0.30
    # 主体按声像曲线摆位，同时保留一部分去相关的“头顶包围感”
    st = stereo((L + R) / 2, pan) * 0.75 + np.stack([L, R], 1) * 0.35
    return st, pan, env


def seaweed(seed, d, env, pan):
    """鲲背上的海草森林摆动：湿的“唰”（带通噪声 0.12–0.35 s）+ 礁石般的细小噼啪（类似海底枪虾的密集小咔嗒）+ 少量气泡。
    密度跟着 env（掠过强度），声像跟着 pan（主体位置）左右散开。"""
    r = rng(seed)
    n = N(d)
    out = np.zeros((n, 2))
    for tt, i in events(r, d, 11.0, env):
        L = r.uniform(0.12, 0.35)
        m = N(L)
        c = r.uniform(900, 3200)
        x = un_safe(bp(r.standard_normal(m), c / 1.5, c * 1.5, 2)) * np.sin(np.linspace(0, np.pi, m)) ** 2
        place(out, x * r.uniform(0.3, 1.0), tt, 1.0, float(np.clip(pan[i] + r.uniform(-0.45, 0.45), -1, 1)))
    for tt, i in events(r, d, 110.0, env, 1.5):
        m = N(0.004)
        x = un_safe(hp(r.standard_normal(m), 3500, 2)) * np.exp(-np.arange(m) / SR / 0.0007)
        place(out, x * r.uniform(0.08, 0.45), tt, 1.0, float(np.clip(pan[i] + r.uniform(-0.6, 0.6), -1, 1)))
    for tt, i in events(r, d, 7.0, env):
        place(out, bubble(r, 1300, 3800, (0.08, 0.3)), tt, 1.0, float(np.clip(pan[i] + r.uniform(-0.5, 0.5), -1, 1)))
    return lp(hp(out, 300, 2), 7000, 2)


# ———————————————————— 镜头 E：关灯与鲲呼吸 ————————————————————
def switch_off(seed=801):
    """全船照明拉闸断电：清脆机械拨动咔嗒声 + 120 Hz → 32 Hz（0.65 s）电源下坠次低频。返回干声单声道（0.65 s）。"""
    r = rng(seed)
    d = 0.65
    n = N(d)
    t = T(d)
    # 机械开关咔嗒：开关弹片瞬态 + 壳体闷响 + 金属触点余振 + 12 ms 后微弱回弹
    snap = un_safe(bp(r.standard_normal(n), 1800, 6200, 2)) * np.exp(-t / 0.0014)
    clack = np.sin(2 * np.pi * 410 * t) * np.exp(-t / 0.0055)
    detent = np.sin(2 * np.pi * 2650 * t) * np.exp(-t / 0.003)
    b_t = np.maximum(0.0, t - 0.013)
    bounce = (t >= 0.013) * (un_safe(bp(r.standard_normal(n), 1600, 5000, 2)) * np.exp(-b_t / 0.0012) * 0.38
                             + np.sin(2 * np.pi * 1950 * b_t) * np.exp(-b_t / 0.0022) * 0.22)
    click = snap * 0.70 + clack * 0.42 + detent * 0.28 + bounce

    # 电源下坠：120 Hz → 32 Hz，伴随缓慢收拢的变压器放电滤波扫频
    f0 = 120.0 * (32.0 / 120.0) ** smoothstep(0.012, 0.62, t)
    ph = 2 * np.pi * np.cumsum(f0) / SR
    sub_env = smoothstep(0.004, 0.025, t) * (1 - smoothstep(0.38, d, t))
    sub = (np.sin(ph) + 0.24 * np.sin(2 * ph) * np.exp(-t / 0.22)) * sub_env
    sigh_fc = curve([(0.0, 950), (0.18, 360), (0.65, 130)], t)
    sigh = un_safe(svf(pink(n, r), sigh_fc, 0.8, 'bp')) * smoothstep(0.005, 0.03, t) * np.exp(-t / 0.16) * 0.18

    x = click * 0.90 + sub * 0.85 + sigh
    return norm(fade(x, 0.0, 0.04))


def kun_breath(seed=802, d=1.8):
    """黑暗静默里的鲲肺深呼吸：深沉缓慢的次低频肺腔吸吐涌动（0–0.95 s 深吸气，0.95–1.80 s 沉缓呼吐）。返回立体声 (N(d), 2)。"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    inh = smoothstep(0.0, 0.68, t) * (1 - smoothstep(0.68, 1.05, t))
    exh = smoothstep(0.84, 1.32, t) * (1 - smoothstep(1.42, d, t))
    env = 0.75 * inh + 1.0 * exh

    lung_air = un_safe(svf(decor_pair(brown, n, r, corr=0.78), 46 + 44 * env, 0.85, 'lp'))
    f_chest = 48.0 + 12.0 * inh - 7.0 * smoothstep(0.95, d, t)
    ph = 2 * np.pi * np.cumsum(f_chest) / SR
    chest = stereo(np.sin(ph) * 0.7 + np.sin(2 * ph) * 0.18, 0.0) * (0.35 * inh + 0.45 * exh)[:, None]
    airway = un_safe(svf(decor_pair(pink, n, r, corr=0.15), 150 + 320 * inh + 190 * exh, 0.75, 'bp')) * 0.26

    out = (lung_air * 0.95 + airway) * env[:, None] + chest
    return norm(fade(out, 0.08, 0.08), 0.95)


# ———————————————————— 镜头 F / G：鲲鹏振翅与清鸣 ————————————————————
def wing_flaps(seed=803, d=9.5, period=2.6):
    """鲲鹏巨翼振风：下扑低频气压重击（55–180 Hz）+ 宽立体声羽翼掠风（400–3500 Hz）+ 下扑瞬间的微妙金色泛音微光。
    下扑峰值落在 0.30 + k*period（配合 19.3 s 起点，正好对齐 19.6、22.2、24.8、27.4 s）。返回立体声 (N(d), 2)。"""
    r = rng(seed)
    n = N(d)
    t = T(d)
    out = np.zeros((n, 2))
    low_src = decor_pair(brown, n, r, corr=0.55)
    plume_src = decor_pair(pink, n, r, corr=0.05)
    air_hi = un_safe(bp(decor_pair(white, n, r, corr=0.0), 2200, 6200, 2))

    k = 0
    while True:
        tc = 0.30 + k * period
        if tc >= d - 0.15:
            break
        dt = t - tc
        # 上抬蓄力气流（tc-0.55..tc-0.05）+ 巨翼下扑包络
        up_env = smoothstep(-0.62, -0.20, dt) * (1 - smoothstep(-0.18, 0.04, dt))
        dn_att = smoothstep(-0.22, 0.02, dt)
        dn_dec = np.where(dt >= 0.02, np.exp(-(dt - 0.02) / 0.38), 1.0)
        dn_env = dn_att * dn_dec
        strength = 0.78 + 0.10 * min(k, 3)

        # 1) 55–180 Hz 低频气压重击 + 瞬态胸腔气浪
        whump_fc = 55.0 + 125.0 * dn_env
        whump = un_safe(svf(low_src, whump_fc, 0.75, 'lp')) * dn_env[:, None]
        thump_t = np.maximum(0.0, dt + 0.03)
        thump_f = 50.0 + 42.0 * np.exp(-thump_t / 0.11)
        thump_ph = 2 * np.pi * np.cumsum(thump_f) / SR
        thump = stereo(np.sin(thump_ph) * (dt >= -0.03) * np.exp(-thump_t / 0.18), r.uniform(-0.15, 0.15)) * 0.28

        # 2) 400–3500 Hz 宽立体声羽翼掠风 + 错落羽片层叠感
        plume_fc = 420.0 + 2850.0 * (dn_env ** 0.8) + 650.0 * up_env
        plume = un_safe(svf(plume_src, plume_fc, 0.60, 'bp')) * (0.30 * up_env + 1.0 * dn_env)[:, None]
        feathers = np.zeros((n, 2))
        for fi in range(7):
            tf = tc - 0.08 + fi * 0.045 + r.uniform(-0.012, 0.012)
            if 0.0 <= tf < d - 0.05:
                m = N(0.18)
                ft = np.arange(m) / SR
                cf = r.uniform(650, 3200)
                seg = un_safe(bp(r.standard_normal(m), cf / 1.6, min(cf * 1.6, 4800), 2))
                seg = seg * np.minimum(1.0, ft / 0.012) * np.exp(-ft / 0.055)
                pan = r.uniform(-0.85, 0.85)
                place(feathers, seg, tf, 0.22 * r.uniform(0.7, 1.2), pan)

        # 3) 下扑金色泛音微光（日光穿过羽翼：极柔和的 D 大调泛音空气共鸣）
        sh_env = smoothstep(-0.02, 0.16, dt) * np.exp(-np.maximum(0.0, dt - 0.16) / 0.55) * (dt >= -0.02)
        shimmer = np.zeros((n, 2))
        for freq, amp_s, pan_s in [(293.66, 0.35, -0.3), (440.0, 0.45, 0.25), (587.33, 0.40, -0.45),
                                   (739.99, 0.28, 0.45), (880.0, 0.22, 0.0)]:
            mod = 0.55 + 0.45 * un_safe(lp(r.standard_normal(n), 8.0, 1))
            shimmer += stereo(np.sin(2 * np.pi * freq * t + r.uniform(0, 6)) * np.clip(mod, 0.1, 1.2), pan_s) * amp_s
        shimmer = (shimmer * 0.065 + air_hi * 0.11) * sh_env[:, None]

        out += (whump * 0.95 + thump + plume * 0.72 + feathers + shimmer) * strength
        k += 1

    return norm(fade(out, 0.04, 0.15), 0.95)


def kun_peng_call(seed=804):
    """鲲鹏高亢清鸣（~3.2 s）：D3 (146.8 Hz) → A3 (220 Hz) → F#3 (185 Hz) → D3 (146.8 Hz)，
    使用同一发声器 voice()，窄共振峰从 700 Hz 扫升至 2200 Hz，兼具鲸吟的辽阔与大鹏的亮金感。返回干声单声道（3.2 s）。"""
    D = 3.2
    t = T(D)
    s = -1.2 * (1 - smoothstep(0.0, 0.24, t))        # C#3 抬进 D3
    s += 7.0 * smoothstep(0.32, 0.95, t)              # D3 → A3
    s += -3.0 * smoothstep(1.50, 2.10, t)             # A3 → F#3
    s += -4.0 * smoothstep(2.15, 2.85, t)             # F#3 → D3
    s += -0.6 * smoothstep(2.88, 3.20, t)             # 尾音轻沉
    rate = 4.6 + 0.8 * smoothstep(0.5, 1.5, t)
    depth = 0.22 * smoothstep(0.45, 1.10, t) * (1 - 0.5 * smoothstep(2.40, 3.10, t))
    s += depth * np.sin(2 * np.pi * np.cumsum(rate) / SR)
    f0 = 146.83 * 2 ** (s / 12)

    amp = curve([(0, 0), (0.06, 0.35), (0.30, 0.78), (0.95, 1.0), (1.60, 0.94),
                 (2.25, 0.76), (2.80, 0.38), (3.20, 0.0)], t)
    F1 = curve([(0, 420), (0.95, 740), (1.75, 580), (2.60, 440), (3.20, 380)], t)
    F2 = curve([(0, 1100), (0.95, 1680), (1.75, 1380), (2.60, 1020), (3.20, 900)], t)
    nf = curve([(0.35, 700), (1.55, 1650), (2.55, 2200), (3.15, 1400)], t)
    ng = curve([(0.30, 0.0), (0.85, 1.4), (1.85, 1.8), (2.75, 0.7), (3.15, 0.0)], t)

    x = voice(f0, amp, seed, kmax=56, tilt=0.68, mids=(3, 8, 1.6), brass=0.12,
              formants=[(180, 120, 0.4), (F1, 180, 1.0), (F2, 260, 0.65), (2800, 360, 0.28)], floor=0.20,
              narrow=(nf, 80, ng), breath=0.07, breath_f=(F1, F2))
    onset = 1 - smoothstep(0.08, 0.42, t)
    x = x * (1 + 0.16 * onset * np.sin(2 * np.pi * 32 * t))
    x = np.tanh(1.15 * x / (np.abs(x).max() + 1e-12)) / np.tanh(1.15)
    return norm(fade(x, 0.01, 0.14))
