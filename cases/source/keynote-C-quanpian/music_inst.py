"""music.py 的乐器与处理（作曲自用的辅助文件）。
唢呐感（oboe + 滑音/颤音/过载/鼻音峰）、二胡滑音，直接沿用 C-kaitou/mix.py 的写法（开头同一套音色）；
另加：电贝斯（加 2、3 次谐波）、铜管短促齐奏、剪刀"咔嚓"（音乐层的十六分节奏型，不是动作音效）、噪声上扫、五声音阶工具。"""
import numpy as np
from core.audio import sampler as S
from core.audio.sfx import SR, bp, lp, hp, t_, env_exp, norm

# ———————————————— 五声音阶（E 羽：E G A B D）————————————————
PEN = [0, 3, 5, 7, 10]                      # 相对 E 的半音
def deg(n, base=28):
    """第 n 级（0 = base 上的 E，5 = 高八度 E；负数往下）→ midi。base 默认 E1 = 28"""
    return base + PEN[n % 5] + 12 * (n // 5)
ROOT = {'E': 0, 'G': 1, 'A': 2, 'B': 3, 'D': -1}   # 贝斯根音（D 用 D1，比 D2 稳）

def fade(x, fi=.003, fo=.01):
    x = np.array(x, np.float32); a, z = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if z and z < len(x): x[-z:] *= np.linspace(1, 0, z)
    return x

def pitchenv(x, semis):
    """时变移调：semis(t) 半音（数组，长度同 x），用相位累积重采样"""
    rate = 2 ** (semis / 12); ph = np.cumsum(rate); ph -= ph[0]
    ph = ph[ph < len(x) - 1]; return np.interp(ph, np.arange(len(x)), x).astype(np.float32)

# ———————————————— 开头的两件主奏（原样）————————————————
def suona(pitch, dur, vel=.8, scoop=-1.5, scoop_t=.06, vib=(5.6, .28, .14), slide_from=None, slide_t=.09, fall=0.0, swell=False):
    """唢呐感：双簧管采样 + 滑音/颤音/尾音下滑 + 过载 + 1–3.5 kHz 鼻音峰（= C-kaitou/mix.py）"""
    src = S.note('oboe', pitch, dur + .25, vel)
    n = len(src); tt = np.arange(n) / SR
    st = np.zeros(n)
    if slide_from is not None:
        st += np.where(tt < slide_t, slide_from * np.clip(1 - tt / slide_t, 0, 1) ** 1.5, 0)
    elif scoop:
        st += np.where(tt < scoop_t, scoop * np.clip(1 - tt / scoop_t, 0, 1) ** 2, 0)
    f, d, t0 = vib; st += np.where(tt > t0, d * np.minimum(1, (tt - t0) / .15) * np.sin(2 * np.pi * f * (tt - t0)), 0)
    if fall: st += np.where(tt > dur - .12, fall * ((tt - (dur - .12)) / .2) ** 2, 0)
    y = pitchenv(src, st)
    y = np.tanh(y * 3.2) / np.tanh(3.2)
    y = y * .55 + bp(y, 1000, 3500) * 1.1 + hp(y, 3500) * .25
    if swell: y *= np.linspace(.55, 1.15, len(y)) ** 1.4
    return fade(y, .004, .03)

def erhu(pitch, dur, vel=.6, slide_from=None, vib=.18):
    x = S.note('erhu', pitch, dur, vel, attack=.03)
    tt = np.arange(len(x)) / SR; st = np.zeros(len(x))
    if slide_from is not None: st += np.where(tt < .14, slide_from * np.clip(1 - tt / .14, 0, 1) ** 1.6, 0)
    if vib: st += np.where(tt > .25, vib * np.minimum(1, (tt - .25) / .2) * np.sin(2 * np.pi * 5.2 * (tt - .25)), 0)
    if st.any(): x = pitchenv(x, st)
    return fade(x, .01, .05)

def flute(pitch, dur, vel=.55, vib=.12, scoop=0.0):
    x = S.note('flute', pitch, dur, vel, attack=.02)
    tt = np.arange(len(x)) / SR; st = np.zeros(len(x))
    if scoop: st += np.where(tt < .07, scoop * np.clip(1 - tt / .07, 0, 1) ** 2, 0)
    if vib and dur > .4: st += np.where(tt > .3, vib * np.minimum(1, (tt - .3) / .3) * np.sin(2 * np.pi * 5.0 * (tt - .3)), 0)
    if st.any(): x = pitchenv(x, st)
    return fade(x, .006, .04)

# ———————————————— 低音 ————————————————
def bass(m, dur, vel):
    """电贝斯：采样 + tanh 2、3 次谐波 + 200 Hz 以上的指音（= 开头的处理），小喇叭也听得见"""
    while m > 43: m -= 12
    while m < 26: m += 12
    x = S.note('electric_bass', m, dur, vel, release=.04)
    x = np.tanh(x * 1.6) / np.tanh(1.6) + hp(x, 200) * .3
    return fade(x, .002, .02)

# ———————————————— 铜管短促齐奏（第四章副歌的放克铜管）————————————————
def brass(pitches, dur=.16, vel=.75):
    """高声部 trumpet_stac、中低声部 trombone_stac、中声部 horn_stac 加厚；短、干脆"""
    parts = []
    for p in pitches:
        m = S.midi(p)
        parts.append(S.note('trumpet_stac' if m >= 60 else 'trombone_stac', m, dur, vel, release=.08))
        if 50 <= m <= 72: parts.append(S.note('horn_stac', m, dur, vel * .8, release=.1) * .6)
    L = max(len(x) for x in parts); out = np.zeros(L, np.float32)
    for x in parts: out[:len(x)] += x
    out = np.tanh(out * .9 / np.sqrt(len(pitches))) * 1.1
    return fade(out, .002, .03)

# ———————————————— 剪刀节奏型（第三章剪纸档的主奏）————————————————
def scissors(rng, closed=True, pitch=1.0):
    """剪刀"咔嚓"：刀刃剪切的上扫金属噪声（2.5–9 kHz）+ 短促金属振铃 + 纤维断裂；张开（closed=False）只留一声轻"嚓"。
    音乐层里当十六分音符打击乐用：比动作音效轻、短，带一点音高（pitch 控制振铃频率）"""
    d = .07 if closed else .035; tt = t_(d); n = rng.standard_normal(len(tt))
    L = len(tt); out = np.zeros(L)
    for i in range(0, L, 240):                        # 5 ms 一段的上扫带通
        hi_ = min(L, i + 240); f = 2500 + 6500 * (i / L) ** .7
        seg = bp(n[max(0, i - 1200):hi_], f * .7, min(f * 1.5, 20000))[-(hi_ - i):]; out[i:hi_] = seg
    out *= env_exp(d, .018 if closed else .008)
    ring = (np.sin(2 * np.pi * 4300 * pitch * tt) + .5 * np.sin(2 * np.pi * 6150 * pitch * tt)) * env_exp(d, .012) * (.35 if closed else .15)
    crack = hp(rng.standard_normal(L), 4000) * env_exp(d, .0015) * (.8 if closed else .3)
    body = np.sin(2 * np.pi * 1150 * pitch * tt) * env_exp(d, .006) * (.3 if closed else .1)
    return fade(norm(out + ring + crack + body) * (1.0 if closed else .55), .0005, .01)

# ———————————————— 上扫（第 58 小节前三拍的积累）————————————————
def riser(rng, d):
    """白噪声带通上扫 400 Hz → 9 kHz，渐强；到点戛然而止（后面就是全静的一拍）"""
    n = rng.standard_normal(int(d * SR)); L = len(n); out = np.zeros(L)
    for i in range(0, L, 480):
        hi_ = min(L, i + 480); f = 400 * (9000 / 400) ** (i / L)
        out[i:hi_] = bp(n[max(0, i - 2400):hi_], f * .75, min(f * 1.35, 20000))[-(hi_ - i):]
    e = (np.arange(L) / L) ** 2.2
    return fade(norm(out * e), .05, .004)
