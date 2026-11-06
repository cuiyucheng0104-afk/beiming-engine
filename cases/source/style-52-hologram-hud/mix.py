"""《种子扫描》配乐 + 拟音 + 环境 → out/mix.wav
读 timeline.json（拍点网格）与 events.json（页面导出的 window.EV），所有声音从同一时间源出发。
配乐：numpy 合成（锯齿/方波琶音 + 乒乓延迟、方波脉冲低音、合成踩镲与拍手、去谐锯齿 pad、808 下滑、宽锯齿大和弦）
     + sampler.py 真实采样（glass 玻璃琴、gran_cassa 大鼓、sus_cymbal 悬钹渐强、vibraphone_bowed 弓奏颤音琴）
     + pluck.py 物理建模拨弦（kalimba 开场/结尾的「叮」、harp 高八度叠琶音）。
96 BPM，A 小调 → 结尾 F 利底亚。13.75–15.0 s 真数字静默（整条混音乘 0）。
"""
import os, sys, json
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P          # noqa: E402
from core.audio import sfx as X                          # noqa: E402
from core.audio.sfx import SR                            # noqa: E402

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
EV = EVJ['ev']
BEAT = TL['beat']; S16 = BEAT / 4; DUR = float(TL['dur']); N = int(round(DUR * SR)) + SR // 2
HIT = {k: v * BEAT for k, v in TL['hit'].items()}
SIL0, SIL1 = TL['silence'][0]
OUT = os.path.join(HERE, 'out'); os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
rng = np.random.default_rng(52)
S.seed(52)
ONS = []


def b(n): return n * BEAT
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def st(): return np.zeros((N, 2))
def tt(d): return np.arange(int(round(d * SR))) / SR


def put(buf, x, at, gain=1.0, pan=0.0):
    s = int(round(at * SR))
    if s >= len(buf) or len(x) == 0: return
    if x.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
        x = np.stack([x * l, x * r], 1)
    e = min(len(buf), s + len(x)); buf[s:e] += x[:e - s] * gain


def mark(t, part):
    g = round(t / S16) * S16
    assert abs(g - t) < 1e-6, f'off-grid {part} {t}'
    ONS.append({'t': round(g, 6), 'part': part})


def lpf(x, f, o=2): return sosfilt(butter(o, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x)
def hpf(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bpf(x, lo, hi, o=2): return sosfilt(butter(o, [lo, min(hi, SR * 0.45)], 'band', fs=SR, output='sos'), x)


def tv(x, fc, kind='lp', q=0.35, k=10):
    """时变滤波：一组静态滤波器按截止频率曲线逐采样插值（无分块咔哒）"""
    lo, hi = max(40.0, float(fc.min())) * 0.98, min(SR * 0.42, float(fc.max())) * 1.02
    fs = np.geomspace(lo, hi, k)
    bank = [lpf(x, f) if kind == 'lp' else bpf(x, f * (1 - q), min(f * (1 + q), SR * 0.45)) for f in fs]
    pos = np.interp(np.log(np.clip(fc, lo, hi)), np.log(fs), np.arange(k))
    i0 = np.clip(np.floor(pos).astype(int), 0, k - 2); w = pos - i0
    B = np.stack(bank)
    idx = np.arange(len(x))
    return B[i0, idx] * (1 - w) + B[i0 + 1, idx] * w


def saw(freq, n, ph=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,)) if np.ndim(freq) == 0 else freq
    dt = f / SR; p = (ph + np.cumsum(dt)) % 1.0
    y = 2 * p - 1; o = np.zeros(n)
    m = p < dt; x = p[m] / dt[m]; o[m] = x + x - x * x - 1
    m = p > 1 - dt; x = (p[m] - 1) / dt[m]; o[m] = x * x + x + x + 1
    return y - o


def sq(freq, n, ph=0.0): return 0.5 * (saw(freq, n, ph) - saw(freq, n, ph + 0.5))


def env(n, a=0.004, tau=0.15, rel=0.02):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(t - a, 0) / tau)
    r = min(n, int(rel * SR))
    if r > 0: e[-r:] *= np.linspace(1, 0, r)
    return e


# ======================= 配乐 =======================
arp, arpH, bass, drums, pad, big, samp, plk = st(), st(), st(), st(), st(), st(), st(), st()


def arp_note(m, t, dur, vel=0.5, pan=0.0, cut=3200):
    n = int((dur + 0.12) * SR)
    x = 0.6 * saw(hz(m), n) + 0.4 * sq(hz(m) * 1.0015, n)
    x = lpf(x, cut, 2) * env(n, 0.003, dur * 0.55, 0.03)
    put(arp, x, t, vel * 0.42, pan); mark(t, 'arp')


def harp(m, t, vel=0.35, pan=0.0):
    x = P.pluck('harp', int(m), 0.5, vel, pos=0.08)
    put(plk, hpf(x, 500), t, 0.5, pan)


def bass_note(m, t, dur, vel=0.7):
    n = int((dur + 0.05) * SR)
    f = hz(m)
    x = 0.55 * sq(f, n) + 0.5 * np.sin(2 * np.pi * f * np.arange(n) / SR)
    x = lpf(x, 420 + 900 * vel, 2) * env(n, 0.004, dur * 0.7, 0.03)
    put(bass, x, t, vel * 0.2); mark(t, 'bass')


def sub_pulse(m, t, vel=0.6):
    n = int(0.5 * SR); f = hz(m); tt_ = np.arange(n) / SR
    x = (np.sin(2 * np.pi * f * tt_) + 0.35 * np.sin(4 * np.pi * f * tt_) + 0.18 * np.sin(6 * np.pi * f * tt_)) * env(n, 0.006, 0.16, 0.05)
    put(bass, x, t, vel * 0.36); mark(t, 'pulse')


def hat(t, vel=0.3, open_=False):
    d = 0.22 if open_ else 0.05; n = int(d * SR)
    x = hpf(rng.standard_normal(n), 7000, 2) * env(n, 0.001, d * 0.35, 0.01)
    put(drums, x, t, vel * 0.5, 0.25); mark(t, 'hat')


def clap(t, vel=0.6):
    n = int(0.3 * SR); x = np.zeros(n)
    for k, dt_ in enumerate([0, 0.011, 0.023]):
        s = int(dt_ * SR); m = n - s
        x[s:] += bpf(rng.standard_normal(m), 900, 5000) * env(m, 0.001, 0.012 if k < 2 else 0.11, 0.02)
    put(drums, x, t, vel * 0.42, -0.1); mark(t, 'clap')


def kick(t, vel=0.8):
    n = int(0.45 * SR); tt_ = np.arange(n) / SR
    f = 46 + 110 * np.exp(-tt_ / 0.03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.002, 0.18, 0.04)
    x += 0.25 * hpf(rng.standard_normal(n), 3000) * env(n, 0.0005, 0.004, 0.0)
    put(drums, x, t, vel * 0.45); mark(t, 'kick')


def pad_chord(ms, t, dur, vel=0.4, cut=1800, att=0.5):
    n = int((dur + 0.6) * SR); x = np.zeros((n, 2))
    for i, m in enumerate(ms):
        for dc, pan in [(-0.11, -0.7), (0.0, 0.0), (0.12, 0.7)]:
            v = saw(hz(m + dc), n, rng.random())
            put(x, v, 0, 0.08 / len(ms) * 4, pan)
    e = env(n, att, 9e9, 0.6); e[int(dur * SR):] *= np.exp(-np.arange(n - int(dur * SR)) / SR / 0.25)
    for c in range(2): x[:, c] = lpf(x[:, c], cut, 2) * e
    put(pad, x, t, vel); mark(t, 'pad')


# ---- 段落 ----
AM = [57, 60, 64, 71, 69, 64, 60, 64]
F7 = [53, 57, 60, 64, 65, 64, 60, 57]
G6 = [55, 59, 62, 64, 67, 64, 62, 59]
AMH = [57, 60, 64, 69, 72, 69, 64, 60]
FM = [53, 57, 60, 64, 67, 64, 60, 57]
DM = [62, 65, 69, 64, 74, 69, 65, 64]
FLY = [65, 69, 72, 76, 71, 76, 72, 69]

# INTRO：开场「叮」由拟音负责；B2–B3 低脉冲
for k in (2, 3): sub_pulse(45, b(k), 0.5 + 0.1 * (k - 2))
# GROW-1（B4–B7）：琶音八分 + 八分脉冲低音 + 竖琴叠高八度
for i in range(8):
    t = b(4) + i * BEAT / 2; m = AM[i % 8]
    arp_note(m, t, BEAT / 2, 0.45 + 0.05 * (i % 2 == 0), pan=(-0.35 if i % 2 else 0.35), cut=2600)
    if i % 2 == 0: harp(m + 12, t, 0.32, 0.5 if i % 4 else -0.5)
    bass_note(33 if i % 2 == 0 else 45, t, BEAT / 2 * 0.9, 0.6)
# GROW-2（B8–B11）：十六分（加速）+ 踩镲 + pad
for i in range(16):
    t = b(8) + i * S16; pat = F7 if i < 8 else G6
    arp_note(pat[i % 8] + (12 if i % 4 == 3 else 0), t, S16 * 1.6, 0.42, pan=(-0.4 if i % 2 else 0.4), cut=3200)
    if i % 4 == 0: harp(pat[i % 8] + 12, t, 0.3, 0.6 if i % 8 else -0.6)
    hat(t, 0.5 if i % 2 else 0.25)
    if i % 2 == 0: bass_note((29 if i < 8 else 31) + (12 if i % 4 == 2 else 0), t, S16 * 1.8, 0.66)
pad_chord([53, 57, 60, 64], b(8), 2 * BEAT, 0.5, 1500, 0.4)
pad_chord([55, 59, 62, 64], b(10), 2 * BEAT, 0.5, 1700, 0.15)
# LOCK（B12–B15）：底鼓四分，B14 锁定拍手 + 和弦转 F
for i in range(16):
    t = b(12) + i * S16; pat = AMH if i < 8 else FM
    arp_note(pat[i % 8], t, S16 * 1.5, 0.44, pan=(-0.45 if i % 2 else 0.45), cut=3600)
    hat(t, 0.45 if i % 2 else 0.22)
    if i % 2 == 0: bass_note((33 if i < 8 else 29) + (12 if i % 4 == 2 else 0), t, S16 * 1.8, 0.7)
for k in range(12, 16): kick(b(k), 0.75)
clap(HIT['lock'], 0.8)
pad_chord([57, 60, 64, 67], b(12), 2 * BEAT, 0.45, 1900, 0.1)
pad_chord([53, 57, 60, 64, 71], b(14), 2 * BEAT, 0.55, 2200, 0.02)
# EXPLODE（B16–B19）：Dm(add9) 高八度、悬钹渐强（采样）作 riser
for i in range(16):
    t = b(16) + i * S16
    arp_note(DM[i % 8] + (12 if i >= 8 and i % 2 else 0), t, S16 * 1.4, 0.46, pan=(-0.5 if i % 2 else 0.5), cut=4200)
    hat(t, 0.5 if i % 2 else 0.3)
    if i % 2 == 0: bass_note(38 + (12 if i % 4 == 2 else 0), t, S16 * 1.8, 0.72)
for k in range(16, 20): kick(b(k), 0.7)
clap(HIT['moist'], 0.75)
pad_chord([50, 57, 62, 64, 65], b(16), 4 * BEAT, 0.5, 2400, 0.3)
# HOLD（B20–B21）：半速 = 减速：低音二分、琶音四分；弓奏颤音琴单音托住
bass_note(38, b(20), 2 * BEAT * 0.95, 0.75); kick(b(20), 0.85)
arp_note(69, b(20), BEAT, 0.42, -0.3, 2400); arp_note(65, b(21), BEAT, 0.36, 0.3, 2000)
put(samp, S.note('vibraphone_bowed', 'A4', 2 * BEAT, 0.55), b(20), 0.55, 0.15); mark(b(20), 'vibraphone_bowed')

# OPEN（B24–）：静默后第一声 = 808 下滑 + 宽锯齿大和弦（滤波打开）+ 采样大鼓 + 锁定双音（拟音）
T0 = HIT['open']
n = int((DUR - T0 + 0.4) * SR); tt_ = np.arange(n) / SR
f808 = hz(29) + (hz(36) - hz(29)) * np.exp(-tt_ / 0.07)
x808 = np.sin(2 * np.pi * np.cumsum(f808) / SR)
x808 = (x808 + 0.3 * np.tanh(2.5 * x808)) * np.exp(-tt_ / 1.6) * np.minimum(1, tt_ / 0.002)
put(big, x808, T0, 0.26); mark(T0, '808')        # 808 低频峰值大、K 计权响度小：压低，免得限幅器把整个高潮压扁
CH = [48, 53, 55, 57, 64, 71, 72, 76]                 # C3 F3 G3 A3 E4 B4(#11) C5 E5（根音交给 808）
xc = np.zeros((n, 2))
for i, m in enumerate(CH):
    for dc, pan in [(-0.13, -0.85), (-0.05, -0.3), (0.05, 0.3), (0.13, 0.85)]:
        put(xc, saw(hz(m + dc), n, rng.random()), 0, 0.05, pan)
cut = 800 + 6200 * (1 - np.exp(-tt_ / 0.35))           # 和弦「打开」：截止频率一拍内升起
ce = np.minimum(1, tt_ / 0.004) * (0.55 + 0.45 * np.exp(-tt_ / 0.5)) * np.exp(-tt_ / 3.4)
for c in range(2):
    xc[:, c] = tv(xc[:, c], cut, 'lp') * ce
put(big, xc, T0, 1.75); mark(T0, 'chord')                 # 静默后第一声：全片最响（比旧版 +2.7 dB）
put(samp, hpf(S.hit('gran_cassa', 'hit', 0.9), 45), T0, 0.5); mark(T0, 'gran_cassa')
# 半速鼓 + 柔和八分琶音 + 玻璃琴
kick(b(24), 0.6); kick(b(28), 0.6); clap(b(26), 0.55); clap(b(30), 0.45)
for i in range(1, 12):
    t = b(24) + i * BEAT / 2
    if t >= DUR - 0.2: break
    hat(t, 0.22 if i % 2 else 0.12)
    arp_note(FLY[i % 8], t, BEAT / 2, 0.30 * (1 - i / 16), pan=(-0.5 if i % 2 else 0.5), cut=3000)
for m, dt_, pan in [(76, 0, -0.3), (81, S16, 0.3), (84, 2 * S16, 0.0)]:
    put(samp, S.note('glass', m, 1.6, 0.55), HIT['crown'] + dt_, 0.5, pan); mark(HIT['crown'] + dt_, 'glass')
put(samp, S.note('glass', 76, 1.2, 0.4), b(26), 0.35, 0.4); mark(b(26), 'glass')
pad_chord([53, 57, 60, 64, 67], b(26), 5 * BEAT, 0.32, 2600, 0.6)
# 悬钹渐强（采样）：取峰值前 2.4 s，峰落在 B20（合拢）
cy = S.hit('sus_cymbal', 'cresc', 0.7)
ev_ = np.abs(cy); pk = int(np.argmax(np.convolve(ev_, np.ones(2400) / 2400, 'same')))
L = int(2.4 * SR); s0 = max(0, pk - L); seg_ = cy[s0:pk].copy(); seg_ *= np.linspace(0, 1, len(seg_)) ** 1.5
put(samp, seg_, b(20) - len(seg_) / SR, 0.55, -0.2)

# 高潮总线软饱和：削掉 808 / 和弦起音的尖峰（峰值因数 12 dB → ~8 dB），让母带限幅器不再把静默后第一声压扁
big = np.tanh(1.8 * big) / 1.8 * 1.3

# 乒乓延迟（3/16 拍）：琶音
def pingpong(x, d=3 * S16, fb=0.36, k=4):
    y = x.copy(); s = int(d * SR)
    mono = x.mean(1)
    for i in range(1, k + 1):
        sh = np.zeros(len(x)); sh[i * s:] = mono[:len(x) - i * s]
        sh = lpf(sh, 3800 - 500 * i)
        pan = -0.8 if i % 2 else 0.8
        l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
        y[:, 0] += sh * fb ** i * l; y[:, 1] += sh * fb ** i * r
    return y

arp = pingpong(arp)
for c in range(2):   # 1–4 kHz 轻挖，给拟音留位置
    arp[:, c] = arp[:, c] - 0.3 * bpf(arp[:, c], 1000, 4000)

# ======================= 拟音 =======================
fol = st()
PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88]


def blip(m, d=0.07, fm=2.0, idx=1.2):
    n = int(d * SR); t_ = np.arange(n) / SR; f = hz(m)
    return np.sin(2 * np.pi * f * t_ + idx * np.exp(-t_ / 0.02) * np.sin(2 * np.pi * f * fm * t_)) * env(n, 0.001, d * 0.4, 0.008)


def beep2(m1, m2, d=0.065):
    return np.concatenate([blip(m1, d, 1.0, 0.2), blip(m2, d * 1.4, 1.0, 0.2)])


def glide(f0, f1, d, wave='sin'):
    n = int(d * SR); f = np.geomspace(f0, f1, n); ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) if wave == 'sin' else saw(f, n)) * env(n, 0.01, 9e9, 0.04) * np.hanning(n) ** 0.3


def sweep_noise(d, f0, f1, q=0.35):
    n = int(d * SR); x = rng.standard_normal(n)
    return tv(x, np.geomspace(f0, f1, n), 'bp', q) * np.hanning(n)


def servo(f0, f1, d):
    n = int(d * SR); f = np.geomspace(f0, f1, n)
    x = bpf(saw(f, n), 400, 3000) * 0.6 + 0.3 * bpf(rng.standard_normal(n), 1500, 4000)
    return x * env(n, 0.01, 9e9, 0.05) * np.hanning(n) ** 0.4


def puff(d=0.3, rev=False):
    n = int(d * SR); x = bpf(rng.standard_normal(n), 600, 3500) * env(n, 0.002, d * 0.3, 0.02)
    return x[::-1] if rev else x


def tick(v=1.0):
    n = int(0.012 * SR); return hpf(rng.standard_normal(n), 3000) * env(n, 0.0005, 0.002, 0.002) * v


for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'ignite':
        put(fol, P.pluck('kalimba', 'E6', None, 0.75), t, 0.34, 0.0)   # 开场「叮」：比高潮低 ≥ 3 LU
        put(fol, blip(93, 0.25, 1.0, 0.3), t + 0.002, 0.12, 0.2)
        put(fol, glide(110, 55, 0.6), t, 0.12)
    elif ty == 'dots':
        k = 0
        for ft in np.arange(t, e['t1'], 1 / 24):
            if rng.random() < 0.35: put(fol, blip(PENTA[rng.integers(4, 9)], 0.02, 3.0, 0.6), ft, 0.035, rng.uniform(-0.6, 0.6)); k += 1
    elif ty == 'hud':
        put(fol, X.click(1.3, 1.0), t, 0.22, -0.6); put(fol, X.click(1.5, 1.0), t + 2 / 24, 0.18, 0.6)
        put(fol, blip(84, 0.05), t, 0.08)
    elif ty == 'scanline':
        d = e['t1'] - t
        put(fol, sweep_noise(d, 7000, 1400), t, 0.14, 0.0)
        put(fol, glide(1760, 880, d), t, 0.035)
    elif ty == 'sprout':          # 种子读完：一声亮的提示音（不再在这里放低频）
        put(fol, blip(81, 0.12, 2.0, 2.5), t, 0.1)
    elif ty == 'fall':            # 两拍缓动下落：轻的下行滑音（比旧版发芽下滑低 12 dB，持续音不能比高潮响）
        d = e['t1'] - t
        put(fol, glide(220, 82, d), t, 0.1); put(fol, sweep_noise(d, 2400, 500, 0.3), t, 0.04)
    elif ty == 'land':            # 落到投影台：闷击（比旧版低 6 dB）+ 细咔哒
        put(fol, X.thump(0.8, 60), t, 0.18); put(fol, X.clack(1.3, 0.7), t, 0.12)
    elif ty == 'roots':
        d = e['t1'] - t; n = int(d * SR)
        r = lpf(X.brown(d), 180) * np.sin(np.linspace(0, np.pi, n)) ** 1.5
        put(fol, r, t, 0.18)
    elif ty == 'plane':
        d = e['t1'] - t
        put(fol, glide(330, 1320, d), t, 0.04, 0.0)
        put(fol, sweep_noise(d, 900, 6000, 0.25), t, 0.07)
    elif ty == 'grow':
        nn = e['n']; m = PENTA[(nn * 3) % 7]
        put(fol, blip(m, 0.06, 2.0, 1.0), t, 0.05, -0.5 if nn % 2 else 0.5)
    elif ty == 'chipIn':
        put(fol, sweep_noise(0.3, 1500, 5000), t, 0.07, -0.7)
    elif ty == 'chip':
        put(fol, beep2(88, 93), t, 0.11, -0.6); put(fol, X.clack(1.6, 0.6), t, 0.08, -0.6)
    elif ty == 'leaves':
        for k in range(14): put(fol, blip(PENTA[k % 9] + 12, 0.04, 3.0, 0.8), t + k / 48, 0.03, rng.uniform(-0.8, 0.8))
    elif ty == 'whip':
        d = e['d']; n = int(d * SR)
        w = sweep_noise(d, 400, 4000, 0.5) * np.sin(np.linspace(0, np.pi, n)) ** 2
        put(fol, w, t, 0.32)                                        # 甩镜呼啸：比高潮低 ≥ 3 LU
    elif ty == 'box':
        put(fol, servo(300, 700, 0.45), t, 0.18, -0.2)
    elif ty == 'lock':
        put(fol, X.thump(1.0, 55), t, 0.6); put(fol, X.clack(1.1, 1.0), t, 0.3)
        put(fol, beep2(81, 88), t + 0.004, 0.16, 0.1)
    elif ty == 'leaderRun':
        put(fol, glide(1200, 1900, e['d']), t, 0.03, 0.5)
    elif ty == 'card':
        put(fol, tick(1.0), t, 0.2, 0.6); put(fol, blip(86, 0.05), t, 0.06, 0.6)
    elif ty == 'explode':
        put(fol, puff(0.35), t, 0.38, -0.1); put(fol, X.thump(0.7, 70), t, 0.3)
    elif ty == 'layer':
        i = e['i']; m0 = [57, 60, 62, 64, 67, 69, 72, 74, 76][i]
        put(fol, servo(hz(m0) * 0.5, hz(m0), 0.26), t, 0.08, -0.4 + i * 0.1)
        put(fol, blip(m0 + 12, 0.035, 1.0, 0.5), t + 0.22, 0.03)
    elif ty == 'roll':
        g = 0.07 if e['kind'] == 'age' else 0.05; pan = 0.6
        for k, ft in enumerate(np.arange(t, e['t1'] - 1e-6, 1 / 24)):
            put(fol, tick(0.7 + 0.3 * (k % 2)), ft, g, pan)
    elif ty == 'boxOut':
        put(fol, glide(1400, 700, 0.12), t, 0.05)
    elif ty == 'moist':
        put(fol, beep2(86, 93), t, 0.16, 0.6); put(fol, X.click(1.2), t, 0.16, 0.6)
    elif ty == 'close':
        put(fol, puff(0.3, rev=True), t, 0.32); put(fol, X.clack(0.8, 1.0), t + 0.3, 0.35); put(fol, X.thump(0.6, 80), t + 0.3, 0.25)
    elif ty == 'open':
        put(fol, X.thump(1.0, 48), t, 0.35); put(fol, X.clack(0.9, 1.0), t, 0.32)
        cf = blip(81, 0.5, 1.0, 0.15) + blip(88, 0.5, 1.0, 0.15) + blip(95, 0.5, 1.0, 0.15)
        put(fol, cf, t + 0.002, 0.13, 0.2)
    elif ty == 'glitch':
        n = int(e['d'] * SR); g_ = np.sign(rng.standard_normal(n)) * (rng.random(n) < 0.08)
        g_ = hpf(np.repeat(g_[::16], 16)[:n], 800) * env(n, 0.001, 9e9, 0.01)
        put(fol, g_, t, 0.12, -0.3)
    elif ty == 'wave':
        d = e['t1'] - t
        put(fol, glide(220, 1760, d), t, 0.035); put(fol, sweep_noise(d, 300, 7000, 0.3), t, 0.06)
    elif ty == 'beam':
        d = DUR - t; n = int(d * SR); t_ = np.arange(n) / SR
        h = sum(a * np.sin(2 * np.pi * f * t_) for f, a in [(120, 0.5), (240.7, 0.3), (361, 0.18), (482.5, 0.08)])
        h = h * np.minimum(1, t_ / 0.6) * (1 - 0.8 * np.clip((t_ - d + 1.2) / 1.2, 0, 1))
        put(fol, h + 0.15 * bpf(rng.standard_normal(n), 1800, 2600) * np.minimum(1, t_ / 0.6), t, 0.06)
    elif ty == 'crown':
        for k in range(18): put(fol, blip(PENTA[(k * 5) % 9] + 12, 0.05, 3.0, 0.9), t + k / 24 * 0.7, 0.03, rng.uniform(-0.9, 0.9))
    elif ty == 'echo':
        put(fol, P.pluck('kalimba', 'E6', None, 0.6), t, 0.45, 0.25)
        put(fol, X.click(1.6, 0.6), t, 0.08, 0.25)

# ======================= 环境 =======================
amb = st()
t_ = np.arange(N) / SR
hum = 0.5 * np.sin(2 * np.pi * 40 * t_) + 0.35 * np.sin(2 * np.pi * 80 * t_) + 0.2 * np.sin(2 * np.pi * 120 * t_) * (1 + 0.2 * np.sin(2 * np.pi * 0.3 * t_))
room = lpf(rng.standard_normal(N), 2500); room = room / np.abs(room).max()
a = (hum * 0.022 + room * 0.03) * np.minimum(1, t_ / 0.4)
amb[:, 0] += a; amb[:, 1] += a * 0.98

# ======================= 混音 =======================
music = arp * 0.9 + arpH + bass * 1.0 + drums * 0.95 + pad * 0.8 + plk * 0.8 + samp * 0.9 + big * 1.0
music = S.room(music.astype(np.float32), size=0.45, mix=0.16)
# 关键锁定处给拟音让位：音乐压低 4 dB / 0.25 s
duck = np.ones(N)
for k in ('lock', 'moist'):
    s0 = int(HIT[k] * SR); duck[s0:s0 + int(0.25 * SR)] *= 10 ** (-4 / 20)
music = music * duck[:, None]
fol_r = S.room(fol.astype(np.float32), size=0.25, mix=0.12)
mix = music * 0.85 + fol_r * 1.0 + amb
# 低频平衡：20–120 Hz 不超过其余 −3 dB 附近
def band_db(x, lo, hi):
    m = x.mean(1); y = bpf(m, lo, hi) if lo > 20 else lpf(m, hi); return 10 * np.log10(np.mean(y ** 2) + 1e-12)
low, rest = band_db(mix, 20, 120), 10 * np.log10(np.mean(hpf(mix.mean(1), 120) ** 2) + 1e-12)
if low - rest > -3:
    k = 10 ** ((-3 - (low - rest)) / 20)
    lowp = np.stack([lpf(mix[:, c], 120) for c in range(2)], 1)
    mix = mix - lowp + lowp * k
# 下落 / 落地段（B4–B7）低中频 120 Hz–1 kHz 宽带 −3 dB，50 ms 渐入渐出：让开 15.0 s 的大和弦做全片最响
w = np.zeros(N); a0, a1, rmp = int(HIT['sprout'] * SR), int((HIT['land'] + 0.65) * SR), int(0.05 * SR)
w[a0:a1] = 1.0; w[a0 - rmp:a0] = np.linspace(0, 1, rmp); w[a1:a1 + rmp] = np.linspace(1, 0, rmp)
for c in range(2):
    lm = bpf(mix[:, c], 120, 1000)
    mix[:, c] = mix[:, c] - lm * (1 - 10 ** (-3 / 20)) * w
# 真数字静默：13.75–15.0 s 全部归零（含混响尾巴与环境声），之前 8 ms 收尾
g = np.ones(N); s0, s1 = int(round(SIL0 * SR)), int(round(SIL1 * SR)); f8 = int(0.008 * SR)
g[s0 - f8:s0] = np.linspace(1, 0, f8); g[s0:s1] = 0.0
mix = mix * g[:, None]
mix = mix[:int(round(DUR * SR))]


# 母带：自己做到 −14 LUFS、真峰值 ≤ −1.5 dBTP，让 mux.sh 的 loudnorm 走线性增益（否则它退回动态模式，会把高潮压扁、把弱段抬起，轻重层级就没了）
def lufs(x):
    """BS.1770-4 积分响度（K 计权 + 400 ms 块 + 绝对 −70 / 相对 −10 门限）"""
    from scipy.signal import lfilter
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    y = lfilter(b2, a2, lfilter(b1, a1, x, axis=0), axis=0)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(y[i:i + blk] ** 2, 0).sum() for i in range(0, len(y) - blk, hop)])
    l = -0.691 + 10 * np.log10(z + 1e-12); z = z[l > -70]
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return -0.691 + 10 * np.log10(z.mean())


def tp_limit(x, ceil_db=-1.5, look=0.004, rel=0.06):
    """立体声联动前视限幅；峰值按 4 倍过采样估计（近似真峰值）"""
    from scipy.signal import resample_poly
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    pk = np.abs(resample_poly(x, 4, 1, axis=0)).max(1).reshape(-1, 4).max(1)[:len(x)]
    n = int(look * SR); ceil = 10 ** (ceil_db / 20)
    g = np.minimum(1, ceil / np.maximum(maximum_filter1d(pk, 2 * n + 1), 1e-9))
    # 释放：增益回升时按 rel 时间常数平滑（只放慢回升，不放慢压下）
    a = np.exp(-1 / (rel * SR)); gs = g.copy()
    for i in range(1, len(gs)):
        if gs[i] > gs[i - 1]: gs[i] = gs[i - 1] * a + gs[i] * (1 - a)
    gs = uniform_filter1d(gs, n)
    return x * np.minimum(gs, g)[:, None]


# 16 kHz 以上的合成踩镲毛刺会在 AAC 编码后过冲 2 dB 以上真峰值：母带前先 4 阶低通 15.5 kHz
mix = np.stack([lpf(mix[:, c], 15500, 4) for c in range(2)], 1)
for _ in range(3):   # 本函数比 ffmpeg 的测量偏高约 0.2 LU → 目标 −13.8；真峰值上限 −2.0 dBTP 给 mux 与 AAC 编码留余量
    mix = mix * 10 ** ((-13.8 - lufs(mix)) / 20)
    mix = tp_limit(mix, -2.0)
mix[s0:s1] = 0.0
sf.write(os.path.join(OUT, 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
for nm, x in [('music', music), ('foley', fol_r), ('amb', amb)]:
    sf.write(os.path.join(OUT, 'stems', nm + '.wav'), (x[:len(mix)] * g[:len(mix), None]).astype(np.float32), SR, subtype='FLOAT')
json.dump(sorted(ONS, key=lambda o: o['t']), open(os.path.join(HERE, 'music', 'onsets.json'), 'w'), ensure_ascii=False)
print(f'mix.wav {len(mix) / SR:.3f}s  peak {np.abs(mix).max():.3f}  {lufs(mix):.2f} LUFS  low-rest {low - rest:+.1f} dB  onsets {len(ONS)}')
