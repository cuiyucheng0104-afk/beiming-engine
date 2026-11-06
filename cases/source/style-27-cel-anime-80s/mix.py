"""混音：配乐（out/music.wav）+ 由 events.json 驱动的程序化拟音与环境床 → out/mix.wav
用法（在库根目录）：.venv/bin/python <工程>/mix.py
"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', os.getcwd()); sys.path.insert(0, LIB)
from core.audio import sfx as X
from core.audio.sfx import SR, add, limit, compress

rng = np.random.default_rng(1927)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
FPS, F20, FC, END_F = TL['FPS'], TL['F20'], TL['FC'], TL['END_F']
music, sr = sf.read(os.path.join(HERE, 'out', 'music.wav'), dtype='float32'); assert sr == SR
DUR = END_F / FPS + .6
N = int(DUR * SR)
fol = np.zeros((N, 2)); amb = np.zeros((N, 2))
mus = np.zeros((N, 2)); mus[:min(N, len(music))] = music[:N]


def ts(n): return np.arange(n) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def nz(d): return rng.standard_normal(int(d * SR))
def norm(x, p=1.): m = np.abs(x).max(); return x * p / m if m > 0 else x


def ramp(n, a=.05, r=.1):
    e = np.ones(n); ia, ir = int(a * SR), int(r * SR)
    if ia: e[:ia] = np.linspace(0, 1, ia)
    if ir: e[-ir:] = np.minimum(e[-ir:], np.linspace(1, 0, ir))
    return e


# —— 环境床 ——
def surf(d, v=1.):
    n = int(d * SR); t = ts(n)
    b = lp(np.cumsum(rng.standard_normal(n)) * .02, 500); b -= np.convolve(b, np.ones(4800) / 4800, 'same')
    swell = .55 + .45 * np.sin(2 * np.pi * t / 4.3 + 1) ** 2
    wash = bp(nz(d), 300, 3000) * (.3 + .7 * np.clip(np.sin(2 * np.pi * t / 4.3 + 1.6), 0, 1) ** 3) * .5
    return norm(b * swell + wash) * v * ramp(n, .3, .4)


def cicada(d, v=1., f=4600, evening=False):
    n = int(d * SR); t = ts(n)
    if evening:   # 暮蝉：一串下降的「卡那卡那」脉冲
        car = np.sin(2 * np.pi * (f - 600 * ((t % 2.6) / 2.6)) * t)
        am = (np.sin(2 * np.pi * 9 * t) > 0).astype(float) * np.clip(1 - (t % 2.6) / 2.2, 0, 1)
        x = car * lp(am, 200)
    else:
        x = bp(nz(d), f * .85, f * 1.2) * (.6 + .4 * np.sin(2 * np.pi * 32 * t)) * (.7 + .3 * np.sin(2 * np.pi * .4 * t))
    return norm(x) * v * ramp(n, .4, .4)


def wind(d, v0, v1):
    n = int(d * SR); t = ts(n); u = t / d
    x = np.zeros(n); src = nz(d)
    for i in range(0, n, 2400):
        f = 400 + 1600 * u[i] + 300 * np.sin(i / SR * 3)
        seg = bp(src[max(0, i - 4800):i + 2400], f * .6, f * 1.6)[-len(x[i:i + 2400]):]; x[i:i + 2400] = seg
    return norm(x) * (v0 + (v1 - v0) * u) * ramp(n, .15, .05)


# —— 拟音 ——
def bell(far=0):
    """电车铃「叮叮」：两下非谐金属音"""
    d = 1.4; t = ts(int(d * SR)); out = np.zeros(len(t))
    for k, o in enumerate([0, .16]):
        s = int(o * SR); tt = t[:len(t) - s]
        x = sum(a * np.sin(2 * np.pi * f * tt) * np.exp(-tt / tau) for f, a, tau in [(1760, 1, .5), (4150, .5, .2), (2650, .35, .3), (5900, .2, .08)])
        out[s:] += x * (1 if k == 0 else .85)
    out += hp(nz(d), 4000) * np.exp(-t / .004) * .3
    if far: out = lp(out, 3000); out = out + np.convolve(out, np.exp(-np.arange(9600) / 2000) * .0006, 'same')
    return norm(out)


def tram_motor(d, sweep=0):
    n = int(d * SR); t = ts(n); u = t / d
    f = 140 + 180 * (u if sweep else .5)
    ph = 2 * np.pi * np.cumsum(f) / SR
    whine = sum(np.sin(k * ph) / k for k in range(1, 7)) * .3 + np.sin(ph * 7.3) * .12
    rumble = lp(nz(d), 160) * 1.4
    x = whine + rumble
    # 铁轨接缝「咔哒-咔哒」
    for k in np.arange(.1, d, .62):
        for o in (0, .09):
            s = int((k + o) * SR)
            if s < n - 3000: x[s:s + 3000] += hp(nz(3000 / SR), 600) * np.exp(-ts(3000) / .008) * 3
    return norm(x)


def ticks(d, rate0, rate1=None, v=1.):
    n = int(d * SR); out = np.zeros(n); tt = 0.
    rate1 = rate1 or rate0
    while tt < d - .02:
        r = rate0 + (rate1 - rate0) * tt / d; s = int(tt * SR)
        c = hp(nz(.012), 3500) * np.exp(-ts(int(.012 * SR)) / .0015)
        out[s:s + len(c)] += c; tt += 1 / r
    return out * v


def catch_snd():
    """草帽进掌心「啪」：掌心拍击 + 草编噼啪 + 低频"""
    d = .45; t = ts(int(d * SR))
    slapx = bp(nz(d), 800, 5000) * np.exp(-t / .012) * 1.2
    body = np.sin(2 * np.pi * 180 * t * (1 - .4 * t)) * np.exp(-t / .05) * .8
    straw = np.zeros(len(t))
    for k in range(26):
        s = int((rng.random() ** 2 * .12) * SR); w = int(.004 * SR)
        straw[s:s + w] += hp(nz(.004), 2500)[:len(straw[s:s + w])] * (1 - s / (.13 * SR)) * 1.4
    return norm(slapx + body + straw)


def flutter(d):
    n = int(d * SR); t = ts(n); rate = 16 - 9 * t / d
    am = (.5 + .5 * np.sin(2 * np.pi * np.cumsum(rate) / SR)) ** 2
    return norm(bp(nz(d), 500, 3200) * am) * ramp(n, .05, .3) * (1 - .6 * t / d)


def shimmer():
    d = 1.1; t = ts(int(d * SR))
    x = hp(nz(d), 5000) * np.exp(-((t - .18) / .12) ** 2)
    x += sum(np.sin(2 * np.pi * f * t) * np.exp(-t / .5) * a for f, a in [(2637, .3), (3951, .2), (5274, .15)])
    return norm(x)


def thunk():
    d = .35; t = ts(int(d * SR))
    return norm(np.sin(2 * np.pi * 70 * t) * np.exp(-t / .06) + bp(nz(d), 1500, 6000) * np.exp(-t / .1) * .25)


def swish(d=.25):
    t = ts(int(d * SR)); return norm(bp(nz(d), 1200, 6000) * np.sin(np.pi * t / d) ** 2)


def brake(d):
    """自行车刹车皮：窄带尖音 + 颤动，结尾收住"""
    n = int((d + .12) * SR); t = ts(n)
    f = 2900 + 120 * np.sin(2 * np.pi * 23 * t)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .5 + bp(rng.standard_normal(n), 2400, 3600) * .6
    env = np.clip(t / .05, 0, 1) * np.clip((d + .1 - t) / .1, 0, 1) * (.6 + .4 * t / d)
    return norm(x * env)


def scuff():
    """鞋底点在柏油路上：短促的沙沙 + 低频一下"""
    d = .22; t = ts(int(d * SR))
    return norm(bp(nz(d), 300, 2600) * np.exp(-t / .04) + np.sin(2 * np.pi * 95 * t) * np.exp(-t / .03) * .7)


LOG = []
for ev in EV:
    ty, t0 = ev['type'], ev['t']; v = ev.get('v', 1.); pan = ev.get('pan', 0.); d = ev.get('d', 1.)
    if ty == 'bed_s1':
        add(amb, surf(d + .3, .8), t0, 1., -.2); add(amb, cicada(d + .3, .3), t0, 1., .5)
    elif ty == 'bed_s7':
        add(amb, surf(d, .45), t0, 1., .1); add(amb, wind(d, .25, .12), t0, .6, -.3)
    elif ty == 'bed_s8':
        add(amb, surf(d + .5, .5), t0, 1., -.2); add(amb, cicada(d + .5, .2, 4200, evening=True), t0, 1., .6)
    elif ty == 'freewheel': add(fol, ticks(d, 11), t0, .12, .3)
    elif ty == 'bell': add(fol, bell(ev.get('far', 0)), t0, .35 * v, pan)
    elif ty == 'tram':
        x = tram_motor(d, ev.get('sweep', 0)) * ramp(int(d * SR), .25, .3)
        if ev.get('far'): x = lp(x, 1200)
        add(fol, x, t0, .22 * v, pan)
    elif ty == 'railclack': pass   # 已含在 tram_motor 里
    elif ty == 'pedal':
        a = ev.get('at', d / 2); add(fol, ticks(a, 7, 8, .8), t0, .3, .1); add(fol, ticks(d - a, 9, 12, 1.), t0 + a, .32, .1)
    elif ty == 'wind': add(amb, wind(d, ev['v0'], ev['v1']), t0, .4, -.1)
    elif ty == 'cloth': add(fol, swish(.22), t0, .3 * v, -.2)
    elif ty == 'creak': add(fol, X.creak(1.), t0, .35 * v, .1)
    elif ty == 'whoosh': add(fol, X.whoosh(d, 1.), t0, .42 * v, 0)
    elif ty == 'glint': add(fol, shimmer(), t0, .32 * v, .2)
    elif ty == 'impact':
        x = X.thump(1., 55 if ev.get('big') else 75) + np.pad(hp(nz(.12), 2000) * np.exp(-ts(int(.12 * SR)) / .02), (0, int(.23 * SR)))[:len(X.thump(1.))] * .5
        add(fol, norm(x), t0, .55 * v, 0)
    elif ty == 'gust': add(fol, wind(d, 1., .35), t0, .5 * v, -.2); add(fol, X.whoosh(.6, 1.), t0, .55, -.3)
    elif ty == 'flutter': add(fol, flutter(d), t0, .32, -.3)
    elif ty == 'catch': add(fol, catch_snd(), t0, .95 * v, -.1)
    elif ty == 'band': add(fol, shimmer(), t0, .3 * v, .3)
    elif ty == 'hatgrab': add(fol, swish(.3), t0, .25 * v, 0)
    elif ty == 'tapethunk': add(fol, thunk(), t0, .5 * v, 0); add(fol, hp(nz(.3), 3000) * np.exp(-ts(int(.3 * SR)) / .08), t0, .06, 0)
    elif ty == 'brake': add(fol, brake(d), t0, .16 * v, .1)
    elif ty == 'scuff': add(fol, scuff(), t0, .5 * v, .1)
    elif ty in ('cut', 'choke', 'titlehit'): pass   # 由配乐承担
    LOG.append(ty)

# 真静默：b20 后 60 ms 起到接帽前 2 帧，拟音与环境一起收掉（只留 −62 dBFS 磁带底噪）
s0, s1 = int((F20 / FPS + .06) * SR), int(FC / FPS * SR) - 1
for buf in (fol, amb):
    fd = int(.04 * SR); buf[s0:s0 + fd] *= np.linspace(1, 0, fd)[:, None]; buf[s0 + fd:s1] = 0
# 环境在音乐下面稍微让一让（音乐响的时候 −3 dB）
menv = np.convolve(np.abs(mus).mean(1), np.ones(4800) / 4800, 'same'); duck = 1 - .3 * np.clip(menv / (menv.max() + 1e-9) * 3, 0, 1)
amb *= duck[:, None]
amb = np.stack([hp(amb[:, c], 90) for c in range(2)], 1)
# 拟音总线过一道 11 kHz 低通（录像带的高频本来就到不了这么高）：瞬时起音的噪声咔哒去掉极高频后，AAC 编码不再冲出样间过冲
fol = np.stack([lp(fol[:, c], 11000, 4) for c in range(2)], 1)
mix = mus * .9 + fol * 1.0 + amb * .55
# 段落动态（让「静默 → 接帽」之后的副歌真正炸开）：前奏 S1 整体 −4.5 dB，主歌 S2–S5 −1 dB，副歌 S7 原样，
# 尾声跟着乐队收；台阶都放在拍点上（b8 全乐队进来那一下、C 接帽那一下），30 ms 斜坡，不打在起音上
T8 = TL['SHOTS'][1][1] / FPS
gain = np.ones(N)
def step(t, db0, db1, w=.03):
    a, b = int((t - w) * SR), int(t * SR); g0, g1 = 10 ** (db0 / 20), 10 ** (db1 / 20)
    return a, b, g0, g1
a, b, g0, g1 = step(T8, -4.5, -1); gain[:a] = g0; gain[a:b] = np.linspace(g0, g1, b - a); gain[b:s0] = g1
gain[s0:] = 1.0
mix *= gain[:, None]
mix[s0:s1] = 0
hiss = hp(nz(N / SR), 3000) * 10 ** (-62 / 20); mix[:, 0] += hiss; mix[:, 1] += np.roll(hiss, 997)
pk = np.percentile(np.abs(mix), 99.99); mix = mix * (.89 / pk)
# 峰值驯服：只削最尖的瞬态（约 0.1% 的采样），降低峰均比，让 mux 两遍 loudnorm 到 −14 LUFS 时真峰值不超 −1.2 dB
mix = np.stack([limit(mix[:, c], .5, .004) for c in range(2)], 1)
mix = mix * (.9 / np.abs(mix).max())
# 真峰值（4 倍过采样）驯服：采样峰值 −0.9 dB 时样间峰值会冲到 +0.4 dBTP，mux 的 loudnorm 就只能退回动态模式（会把段落动态压平）。
# 这里把真峰值再压 3.2 dB（只碰最尖的瞬态），让 mux 能用 linear 模式：响度 −14 LUFS、真峰值 ≤ −1.2 dBTP，前奏/副歌的落差原样保留。
from scipy.signal import resample_poly
from scipy.ndimage import maximum_filter1d, uniform_filter1d
def tpk(x): up = resample_poly(x, 4, 1, axis=0); return np.abs(up).max(1)[:len(x) * 4].reshape(len(x), 4).max(1)
tp0 = tpk(mix).max(); ceil = tp0 * 10 ** (-3.2 / 20)
for _ in range(4):
    m = maximum_filter1d(tpk(mix), size=2 * int(.003 * SR) + 1)
    gtp = uniform_filter1d(np.minimum(1, ceil / np.maximum(m, 1e-9)), size=int(.003 * SR))
    mix = mix * gtp[:, None]
print('true peak %.2f → %.2f dBFS' % (20 * np.log10(tp0), 20 * np.log10(tpk(mix).max())))
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
for nm, b in [('foley', fol), ('amb', amb)]: sf.write(os.path.join(HERE, 'out', 'stems', nm + '.wav'), b.astype(np.float32), SR)
print('mix.wav', round(N / SR, 2), 's, events', len(LOG))
