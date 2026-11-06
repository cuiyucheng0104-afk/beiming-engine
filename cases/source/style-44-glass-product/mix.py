"""棱光 PRISM · 混音：配乐（music/score.wav）+ 玻璃/金属拟音（events.json，由页面的 window.EV 导出）+ 暗室空气底 → out/mix.wav
用法（在 LIB 下）：.venv/bin/python <film>/mix.py
"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, norm, limit, add

rng = np.random.default_rng(44)
ev = json.load(open(os.path.join(HERE, 'events.json')))
TL = json.load(open(os.path.join(HERE, 'timeline.json'))); T = TL['T']
DUR = ev['dur']; N = int(round(DUR * SR))
fx = np.zeros((N, 2)); amb = np.zeros((N, 2))
def nz(d): return rng.standard_normal(int(round(d * SR)))


def shimmer(d, v, f0=2500, f1=8000):
    """扫光：手指沿玻璃杯沿的嘶声——扫频带通噪声 + 非谐分音"""
    tt = t_(d); n = nz(d); out = np.zeros_like(n); hop = 480
    for i in range(0, len(n), hop):
        f = f0 + (f1 - f0) * (i / len(n)); hi = min(len(n), i + hop); s = bp(n[max(0, i - 4000):hi], f * .8, f * 1.25)[-(hi - i):]; out[i:hi] = s
    part = sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) for f, a in [(3136, .5), (4435, .35), (5274, .25), (7040, .15)])
    return norm((out * .7 + part * .1) * np.sin(np.pi * tt / d) ** 2) * v

def panned(buf, x, at, p0, p1, gain=1.0):
    s = int(round(at * SR)); n = min(len(x), len(buf) - s); pan = np.linspace(p0, p1, len(x))[:n]
    buf[s:s + n, 0] += x[:n] * np.cos((pan + 1) * np.pi / 4) * 1.414 * gain; buf[s:s + n, 1] += x[:n] * np.sin((pan + 1) * np.pi / 4) * 1.414 * gain

def ting(f, d=.9, v=1.0):
    """细玻璃叮：基频 + ×2.76 ×5.4 非谐分音"""
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * m * tt + rng.random() * 6) * env_exp(d, tau) for m, a, tau in [(1, 1, .35), (2.76, .4, .15), (5.4, .2, .07)])
    x[:96] *= np.linspace(0, 1, 96); return norm(x) * v

def zap(v=1.0):
    """光束射入：高频正弦簇向下扫 + 噪声闪 + 低频气压"""
    d = .9; tt = t_(d); x = np.zeros_like(tt)
    for f in [5200, 6800, 8300, 3900]: x += np.sin(2 * np.pi * np.cumsum(f * (1 + .25 * np.exp(-tt / .05))) / SR) * env_exp(d, .12) * .3
    x += hp(nz(d), 4000) * env_exp(d, .03) * .8 + np.sin(2 * np.pi * 60 * tt) * env_exp(d, .12) * .7
    return norm(x) * v

def air(d, v, f0=500, f1=2400, rev=False):
    tt = t_(d); n = nz(d); out = np.zeros_like(n); hop = 480
    for i in range(0, len(n), hop):
        u = i / len(n); f = f0 + (f1 - f0) * u; hi = min(len(n), i + hop); s = bp(n[max(0, i - 3000):hi], f * .6, f * 1.5)[-(hi - i):]; out[i:hi] = s
    e = (tt / d) ** 3 if rev else np.sin(np.pi * tt / d) ** 2
    if rev: e[-int(.006 * SR):] *= np.linspace(1, 0, int(.006 * SR))
    return norm(out * e) * v

def bloop(f=520, v=1.0):
    """焦散环：柔和的玻璃水波音（低通的非谐音，音高微降）"""
    d = 1.0; tt = t_(d); ff = f * (1 - .06 * tt)
    x = np.sin(2 * np.pi * np.cumsum(ff) / SR) * env_exp(d, .25) + .35 * np.sin(2 * np.pi * np.cumsum(ff * 2.76) / SR) * env_exp(d, .1)
    x[:240] *= np.linspace(0, 1, 240); return norm(lp(x, 3000)) * v

def mag_click(v=1.0):
    """磁性咔嗒：<2 ms 瞬态 + 3–5 kHz 金属共振 + 低频闷响"""
    d = .12; tt = t_(d)
    x = hp(nz(d), 3000) * env_exp(d, .0012) + sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * env_exp(d, tau) for f, a, tau in [(3300, .55, .018), (4900, .35, .012), (1900, .25, .025)])
    x += np.sin(2 * np.pi * 120 * tt * (1 - .3 * tt)) * env_exp(d, .018) * .6
    return norm(x) * v

def puff(v):
    d = .24; tt = t_(d); return norm(lp(nz(d), 1000) * env_exp(d, .05) * (1 - np.exp(-tt / .008))) * v

def friction(d, v):
    """玻璃-金属摩擦：粗带通噪声慢调制"""
    tt = t_(d); n = bp(nz(d), 350, 1600, 2); grain = 1 + .5 * np.sin(2 * np.pi * 7 * tt + 2 * np.sin(2 * np.pi * .9 * tt))
    e = np.sin(np.pi * np.clip(tt / d, 0, 1)) ** 1.5; return norm(n * grain * e + bp(nz(d), 2500, 6000) * .08 * e) * v

def snap(v=1.0):
    """合盖：6 个相隔几毫秒的咔嗒 + 非谐玻璃和弦 + 亚低音冲击"""
    d = 2.6; out = np.zeros(int(d * SR))
    for k in range(6):
        c = mag_click(.5 + .1 * (k == 0)); s = int(k * .004 * SR); out[s:s + len(c)] += c
    tt = t_(d)
    for f in (1175, 1480, 1760):
        for m, a, tau in [(1, 1, .9), (2.76, .35, .4), (5.4, .15, .18)]:
            out += a * np.sin(2 * np.pi * f * m * tt + rng.random() * 6) * env_exp(d, tau) * .25
    out += np.sin(2 * np.pi * np.cumsum(55 * (1 + .8 * np.exp(-tt / .03))) / SR) * env_exp(d, .25) * .9
    out[:48] *= np.linspace(0, 1, 48)
    return norm(out) * v

def thud(v):
    d = .3; tt = t_(d); return norm(np.sin(2 * np.pi * 70 * tt * (1 - .3 * tt)) * env_exp(d, .05) + lp(nz(d), 400) * env_exp(d, .01) * .4) * v

RAYF = [1760, 1976, 2093, 2349, 2637, 3136, 3520]
for e in ev['ev']:
    ty, t, v = e['type'], e['t'], e.get('v', .5)
    if ty == 'sweep': p = e.get('pan', [-.7, .7]); panned(fx, shimmer(e['d'], v), t, p[0], p[1])
    elif ty == 'flare': add(fx, ting(3520, 1.2, v * .6), t, 1, .2)
    elif ty == 'beam': add(fx, zap(v), t, .9, -.4)
    elif ty == 'ray': add(fx, ting(RAYF[e['k']] * 2, .5, v * .45), t, 1, e.get('pan', 0))
    elif ty == 'rack': add(fx, air(e['d'], v * .6, 800, 2600), t, 1, 0)
    elif ty == 'focus': add(fx, ting(4186, .4, v * .35), t, 1, 0)
    elif ty == 'ring': add(fx, bloop(520 * (1, 1.12, 1.26, 1.5)[e['k']], v), t, 1, (-.3, .3, -.15, .15)[e['k']])
    elif ty in ('slide', 'push'): p = e.get('pan', [0, 0]); panned(fx, air(e['d'], v, 400, 2200), t, p[0], p[1])
    elif ty == 'facet': add(fx, ting(3951, .6, v * .5), t, 1, .3)
    elif ty == 'stop': add(fx, thud(.5), t, 1, 0)
    elif ty == 'release': add(fx, mag_click(v), t, 1, 0)
    elif ty == 'puff': add(fx, puff(v), t, 1, e.get('pan', 0))
    elif ty == 'friction': add(fx, friction(e['d'], v), t, 1, 0)
    elif ty == 'revwhoosh': add(fx, air(e['d'], v * .55, 600, 5000, rev=True), t, 1, 0)
    elif ty == 'snap': add(fx, snap(v), t, 1.1, 0)
    elif ty == 'titlebell': add(fx, ting(2637, 1.0, v * .3), t, 1, -.2)
    elif ty == 'glint': add(fx, shimmer(.7, v * .6, 5000, 9000), t - .35, 1, .3)
    elif ty == 'lastbell': pass   # 由配乐的玻璃竖琴负责

# 暗室空气底：极低的粉噪 + 很弱的高频嘶（14.375–15.0 全静时一起切掉）
w = np.cumsum(rng.standard_normal((N, 2)), 0); w -= np.linspace(w[0], w[-1], N)
room = lp(hp(w.T, 60), 500).T; room /= np.abs(room).max(); amb += room * .012 + hp(rng.standard_normal((N, 2)).T, 6000).T * .0015
i0, i1 = int(round(T['hover'] * SR)), int(round(T['snap'] * SR)); f = int(.006 * SR)
amb[i0 - f:i0] *= np.linspace(1, 0, f)[:, None]; amb[i0:i1] = 0; amb[i1:i1 + f] *= np.linspace(0, 1, f)[:, None]

music, sr = sf.read(os.path.join(HERE, 'music/score.wav')); assert sr == SR
music = music[:N] if len(music) >= N else np.pad(music, ((0, N - len(music)), (0, 0)))
# 低频平衡：把 120 Hz 以下压约 5 dB（目标 20–120 Hz 比其余频段低约 3 dB）
from scipy.signal import butter, sosfilt, sosfiltfilt
# 段落增益：合盖之前整体低 3 dB，让 15.0 的合盖成为全片最响的一声
sec = np.ones(N); i_s = int(round(T['snap'] * SR)); sec[:i_s] = .7
mix = (music * 1.0 + fx * .32) * sec[:, None] + amb
lo = sosfiltfilt(butter(4, 120, 'low', fs=SR, output='sos'), mix, axis=0); mix = mix - lo * .45
# 全静区间只允许反向嘶声：确认音乐与底噪都是 0
# 总线：立体声联动的慢压缩把鼓/808 的峰值压下来，再用前视限幅把最大峰值压约 5 dB，
# 让峰值-响度比 ≲ 12 dB，loudnorm 才能线性地把它推到 −14 LUFS（真峰值 ≤ −1.2 dB）
def bus_comp(x, thr=.3, ratio=2.5, att=.002, rel=.10):
    from scipy.ndimage import maximum_filter1d
    lvl = maximum_filter1d(np.abs(x).max(1), size=int(.002 * SR))
    a, r = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR)); env = np.empty_like(lvl); e = 0.0
    for i, c in enumerate(lvl):
        e = a * e + (1 - a) * c if c > e else r * e + (1 - r) * c; env[i] = e
    g = np.where(env > thr, (thr + (env - thr) / ratio) / np.maximum(env, 1e-9), 1.0)
    return x * g[:, None]
mix = bus_comp(mix)
mix *= .89 / np.abs(mix).max()
lk = np.maximum(np.abs(mix[:, 0]), np.abs(mix[:, 1]))
from scipy.ndimage import maximum_filter1d, uniform_filter1d
nl = int(.005 * SR); m = maximum_filter1d(lk, size=2 * nl + 1); gl = uniform_filter1d(np.minimum(1, .45 / np.maximum(m, 1e-9)), size=nl)
mix *= gl[:, None]; mix *= .89 / np.abs(mix).max()
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR)
sil = np.abs(music[i0:i1]).max() + np.abs(amb[i0:i1]).max()
print('mix.wav', mix.shape, 'peak', round(float(np.abs(mix).max()), 3), '| music+bed in silence window:', round(float(sil), 6))
