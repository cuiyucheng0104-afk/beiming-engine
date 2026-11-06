"""whale.exe 混音：合成拟音（全部程序生成，按 window.EV 落在帧上）+ 环境床 + out/score.wav → out/mix.wav
材质：继电器、消磁线圈、屈簧键盘、电传、字粒落地的细小高频、海（带限噪声）、水花、BEL。"""
import json, os, sys, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, os.path.join(LIB, 'core', 'audio'))
from sfx import limit, whoosh, thump
SR = 48000
rng = np.random.default_rng(22)
E = json.load(open(os.path.join(HERE, 'events.json')))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
B = TL['BEAT']; C = TL['CUE']; b = lambda n: n * B
DUR = E['dur']; N = int(round(DUR * SR))
def T(d): return np.arange(int(round(d * SR))) / SR
def nz(d): return rng.standard_normal(int(round(d * SR)))
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
bus = {k: np.zeros((N, 2)) for k in ['sfx', 'bed', 'room']}
solo = {k: np.zeros(N) for k in ['enter', 'shatter', 'bel', 'poweroff']}   # 单独渲染的关键拟音，给 cuecheck 量起音
def add(name, x, at, g=1.0, pan=0.0):
    i = int(round(at * SR))
    if i >= N or len(x) == 0: return
    x = x[:N - i] * g
    if SOLO in solo: solo[SOLO][i:i + len(x)] += x
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    bus[name][i:i + len(x), 0] += x * l * 1.414; bus[name][i:i + len(x), 1] += x * r * 1.414

# ---------- 拟音 ----------
def key(v=1.0, kind='key'):
    """屈簧机械键：塑料咔 + 3.4k 弹簧叮 + 键帽回弹的低"咚"；回车更重"""
    d = .1; t = T(d); p = rng.uniform(.93, 1.08)
    clk = hp(nz(d), 2200) * np.exp(-t / .0028)
    ping = np.sin(2 * np.pi * 3400 * p * t) * np.exp(-t / .03) * .22 + np.sin(2 * np.pi * 5230 * p * t) * np.exp(-t / .015) * .1
    thock = bp(nz(d), 260 * p, 900 * p) * np.exp(-np.maximum(0, t - .012) / .012) * (t > .01) * 1.3
    if kind == 'enter': thock = lp(thock, 600) * 2.4; clk *= 1.2
    if kind == 'light': thock *= .6
    return (clk * .8 + ping + thock) * v
def tty(v=1.0):          # 机器打出的字：电传滴答
    d = .03; t = T(d)
    return (bp(nz(d), 1200, 4200) * np.exp(-t / .004) + np.sin(2 * np.pi * 1850 * t) * np.exp(-t / .008) * .3) * v
def relay(v=1.0):
    d = .12; t = T(d)
    return (hp(nz(d), 1500) * np.exp(-t / .004) * .8 + bp(nz(d), 80, 400) * np.exp(-t / .03) * 1.4 + hp(nz(d), 1500) * np.exp(-np.maximum(0, t - .035) / .003) * (t > .035) * .4) * v
def degauss(v=1.0):
    d = 1.3; t = T(d); wob = 1 + .04 * np.sin(2 * np.pi * 7 * t)
    hum = sum(np.sin(2 * np.pi * 50 * h * t * wob) / h for h in (1, 2, 3, 5)) * np.exp(-t / .35)
    return (np.tanh(hum * 1.5) * .5 + lp(nz(d), 160) * np.exp(-t / .08) * 1.4) * v
def ratchet(v=1.0):
    d = .02; t = T(d); return hp(nz(d), 2500) * np.exp(-t / .002) * v
def landtick(n, v=1.0, hi=6000):
    d = .025; t = T(d); x = np.zeros_like(t)
    for _ in range(min(n, 6)):
        f = rng.uniform(2200, hi); o = rng.uniform(0, .01)
        x += np.sin(2 * np.pi * f * t) * np.exp(-np.maximum(0, t - o) / .003) * (t >= o)
    return x * v * min(1.6, np.sqrt(n) / 3)
def shatter(v=1.0):      # 句子碎裂：一记电流"嗞"+ 字形撕开
    d = .5; t = T(d)
    buzz = np.sign(np.sin(2 * np.pi * 120 * t)) * bp(nz(d), 800, 5000) * .4
    return (hp(nz(d), 3000) * np.exp(-t / .05) + buzz * np.exp(-t / .12)) * v
def splash_rush(v=1.0):  # 破水：水被推起的冲刷
    d = 1.6; t = T(d)
    x = lp(nz(d), 1800) * np.minimum(1, t / .05) * np.exp(-t / .5) + hp(nz(d), 2500) * np.exp(-t / .25) * .6
    return x * v
def hiss(d, v=1.0):      # 水柱嘶声上扬
    t = T(d); e = np.minimum(1, t / (d * .8)) ** 1.5 * np.minimum(1, (d - t) / .03)
    x = np.zeros_like(t); n = nz(d)
    for i in range(0, len(t), 960):
        f = 1500 + 5500 * (i / len(t)); seg = bp(n[max(0, i - 2000):i + 960], f * .6, min(f * 1.4, 20000))[-min(960, len(t) - i):]; x[i:i + len(seg)] = seg
    return x * e * v
def burst(v=1.0):        # 水柱炸开：亮的喷雾 + 一簇簇字粒
    d = 1.2; t = T(d)
    x = hp(nz(d), 4000) * np.exp(-t / .3) * .7 + bp(nz(d), 1500, 6000) * np.exp(-t / .08)
    return x * v
def slam(v=1.0):         # 鲸落水：闷响 + 大片水花
    d = 2.0; t = T(d)
    th = np.sin(2 * np.pi * np.cumsum(70 * np.exp(-t / .2) + 32) / SR) * np.exp(-t / .3)
    sp = lp(nz(d), 3500) * np.exp(-t / .55) * np.minimum(1, t / .015) + hp(nz(d), 3000) * np.exp(-t / .9) * .25
    return (np.tanh(th * 2) * .55 + sp * .9) * v
def wave_rise(d, v=1.0):  # 大浪隆起：低频水体涌起，滤波逐渐打开
    t = T(d); n = nz(d); x = np.zeros_like(t)
    for i in range(0, len(t), 960):
        f = 300 + 2600 * (i / len(t)) ** 1.6; seg = lp(n[max(0, i - 3000):i + 960], f)[-min(960, len(t) - i):]; x[i:i + len(seg)] = seg
    return x * (t / d) ** 1.8 * np.minimum(1, (d - t) / .02) * v
def wave_crash(v=1.0):   # 浪唇砸下：闷响 + 白沫嘶
    d = 1.4; t = T(d)
    body = lp(nz(d), 2200) * np.minimum(1, t / .008) * np.exp(-t / .35)
    foam = hp(nz(d), 3500) * np.exp(-t / .6) * .45
    low = np.sin(2 * np.pi * np.cumsum(55 * np.exp(-t / .25) + 38) / SR) * np.exp(-t / .22) * .8
    return (body + foam + low) * v
def bubbles(d, v=1.0):   # 下沉的气泡：一串向上滑的短音
    t = T(d); x = np.zeros_like(t); r = np.random.default_rng(5)
    for _ in range(int(d * 14)):
        o = r.uniform(0, d - .08); f0 = r.uniform(180, 520); n = int(.07 * SR); tt = np.arange(n) / SR
        g = np.sin(2 * np.pi * np.cumsum(f0 * (1 + 3 * tt / .07)) / SR) * np.exp(-tt / .02) * r.uniform(.3, 1) * (1 - o / d) ** .7
        i = int(o * SR); x[i:i + n] += g[:len(x) - i]
    return lp(x, 2500) * v
def bel(v=1.0):
    d = .5; t = T(d)
    sq = np.sign(np.sin(2 * np.pi * 1000 * t)) * .35 + np.sin(2 * np.pi * 2000 * t) * .15
    return lp(sq, 4500) * np.exp(-t / .14) * np.minimum(1, t / .003) * v
def poweroff(v=1.0):
    d = 1.2; t = T(d)
    whine = np.sin(2 * np.pi * np.cumsum(2400 * np.exp(-t / .12) + 60) / SR) * np.exp(-t / .35) * .3
    return (lp(nz(d), 150) * np.exp(-t / .06) * 2.5 + hp(nz(d), 3000) * np.exp(-t / .05) * .5 + whine) * v

SOLO = None
for e in E['ev']:
    t, ty = e['t'], e['type']; pan = rng.uniform(-.25, .25); SOLO = ty
    if ty == 'key': add('sfx', key(1.0), t, .55, pan)
    elif ty == 'keyLight': add('sfx', key(1.0, 'light'), t, .45, pan)
    elif ty == 'enter': add('sfx', key(1.0, 'enter'), t, .8)
    elif ty == 'tty': add('sfx', tty(), t, .4, .1)
    elif ty == 'tick': add('sfx', tty(), t, .3, -.1)
    elif ty == 'relay': add('sfx', relay(), t, .8)
    elif ty == 'degauss': add('sfx', degauss(), t, .55)
    elif ty == 'ratchet': add('sfx', ratchet(), t, .2, .45)
    elif ty == 'land': add('sfx', landtick(e['n']), t, .1, rng.uniform(-.6, .6))
    elif ty == 'settle': add('sfx', landtick(e['n'], hi=8000), t, .09, rng.uniform(-.7, .7))
    elif ty == 'shatter': add('sfx', shatter(), t, .35)
    elif ty == 'zoomOut':
        d = e['d']; tt = T(d)
        sw = np.sin(2 * np.pi * np.cumsum(180 + 2600 * (tt / d) ** 2) / SR) * (tt / d) ** 1.5 * .06 + (lp(nz(d), 1200) * (1 - tt / d) + bp(nz(d), 1500, 6000) * (tt / d)) * (tt / d) ** 2 * .25
        add('sfx', sw, t, .5)
    elif ty == 'breach': add('sfx', splash_rush(), t, .7); add('sfx', whoosh(.6), t, .3)
    elif ty == 'spout': add('sfx', hiss(b(2)), t, .35)
    elif ty == 'burst': add('sfx', burst(), t, .5)
    elif ty == 'slam': add('sfx', slam(), t, .85)
    elif ty == 'bel': add('sfx', bel(), t, .35)
    elif ty == 'waveRise': add('sfx', wave_rise(e['d']), t, .55, -.1)
    elif ty == 'waveCrash': add('sfx', wave_crash(), t, .6, -.35)
    elif ty == 'finFlap': add('sfx', whoosh(.45), t, .3, .3)
    elif ty == 'sink': add('sfx', bubbles(e['d']), t, .35, -.05)
    elif ty == 'poweroff': add('sfx', relay(), t, .6); add('sfx', poweroff(), t, .55)

SOLO = None
# ---------- 环境床 ----------
t = np.arange(N) / SR
room = lp(rng.standard_normal(N), 500) * .02 + np.sin(2 * np.pi * 100 * t) * .004 + np.sin(2 * np.pi * 15734 * t) * .0012
bus['room'][:, 0] += room; bus['room'][:, 1] += room
# 海：带限噪声，随浪起伏；拉远时变远（低通、变小）
s0 = b(C['shatter']) + .4
sea = np.zeros(N); n = rng.standard_normal(N)
far = np.clip((t - b(16)) / (b(22) - b(16)), 0, 1)
lo = sosfilt(butter(2, 900, 'low', fs=SR, output='sos'), n); hi_ = sosfilt(butter(2, [900, 5000], 'band', fs=SR, output='sos'), n)
swell = .55 + .45 * np.sin(2 * np.pi * .23 * t) * np.sin(2 * np.pi * .61 * t + 1)
sea = (lo * (1 - .3 * far) + hi_ * (.5 - .4 * far)) * swell
fade = np.clip((t - s0) / 1.2, 0, 1) * np.clip((b(C['off']) + .4 - t) / .8, 0, 1)
sea *= fade * (1 - .35 * far) * .09
bus['bed'][:, 0] += sea; bus['bed'][:, 1] += np.roll(sea, 240)

# ---------- 合成 ----------
score, sr = sf.read(os.path.join(HERE, 'out', 'score.wav')); assert sr == SR
score = score[:N] if len(score) >= N else np.pad(score, ((0, N - len(score)), (0, 0)))
# 静默：b22–b24 除极轻的室内底噪外全部归零（拟音、海一并切掉）
a0, a1 = int(round(b(C['drop']) * SR)), int(round(b(C['breach']) * SR)); f = int(.002 * SR)
gate = np.ones(N); gate[a0:a1] = 0; gate[a0 - f:a0] = np.linspace(1, 0, f)
for k in ('sfx', 'bed'): bus[k] *= gate[:, None]
bus['sfx'] = sosfilt(butter(2, 50, 'high', fs=SR, output='sos'), bus['sfx'], axis=0)
room_g = np.ones(N); room_g[a0:a1] = .35                    # 静默里只剩 −60 dB 左右的底噪
mix = score * 1.0 + bus['sfx'] * .9 + bus['bed'] * 1.0 + bus['room'] * room_g[:, None]
# 真峰值限制（4× 过采样检测，双声道联动）：把峰值-响度比压到 12 dB 以内，mux 的 −14 LUFS / −1.2 dBTP 才都能达标
from scipy.signal import resample_poly
from scipy.ndimage import maximum_filter1d, uniform_filter1d
def tp_limit(x, ceil_db=-5.5, look=.004, rel=.06):
    up = np.abs(resample_poly(x, 4, 1, axis=0)).max(1)
    pk = up[:len(x) * 4].reshape(-1, 4).max(1)
    c = 10 ** (ceil_db / 20); n = int(look * SR)
    g = np.minimum(1, c / np.maximum(maximum_filter1d(pk, 2 * n + 1), 1e-9))
    g = np.minimum(g, uniform_filter1d(g, n))
    # 释放：增益回升放慢
    a = np.exp(-1 / (rel * SR)); out = np.empty_like(g); e = 1.0
    for i in range(len(g)):
        e = g[i] if g[i] < e else a * e + (1 - a) * g[i]; out[i] = e
    return x * out[:, None]
mix = tp_limit(mix)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
for k in bus: sf.write(os.path.join(HERE, 'out', 'stems', f'fx_{k}.wav'), bus[k].astype(np.float32), SR)
for k in solo: sf.write(os.path.join(HERE, 'out', 'stems', f'solo_{k}.wav'), solo[k].astype(np.float32), SR)
# 频段能量（低频不要过重）
F = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fr = np.fft.rfftfreq(N, 1 / SR)
band = lambda a, c: 10 * np.log10(F[(fr >= a) & (fr < c)].sum() + 1e-12)
print('mix.wav', round(N / SR, 3), 's  20-120Hz vs 120-5k: %.1f dB' % (band(20, 120) - band(120, 5000)))
