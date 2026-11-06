"""棱光 PRISM · 原创配乐（真实采样 sampler.py + 拨弦 pluck.py + numpy 合成）。96 BPM，D 小调 → 结尾 D 大三和弦。
读 timeline.json（与画面同一份时间），写 music/stems/*.wav、music/score.wav、music/score.json（每个关键音的实际起点，供 cuecheck 核对）。
用法（在 LIB 下）：.venv/bin/python <film>/music/score.py
"""
import os, sys, json
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__)); FILM = os.path.dirname(HERE)
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import pluck as P
from core.audio.sfx import SR

TL = json.load(open(os.path.join(FILM, 'timeline.json')))
T, BEAT, DUR = TL['T'], TL['BEAT'], TL['DUR']
N = int(round(DUR * SR))
rng = np.random.default_rng(96)
S.seed(96)
at = lambda bar, beat=1: ((bar - 1) * 4 + (beat - 1)) * BEAT
CUES = []   # (time, label)：落在拍点上的关键音，cuecheck 用


def tt(d): return np.arange(int(round(d * SR))) / SR
def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lp(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x)
def hp(x, f, o=2): return sosfilt(sos('high', f, o), x)
def bp(x, lo, hi, o=2): return sosfilt(sos('band', [lo, min(hi, SR * .45)], o), x)
def mhz(m): return 440.0 * 2 ** ((m - 69) / 12)
def fade(x, fi=.002, fo=.01):
    x = np.array(x, dtype=np.float64); a, b = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if b and len(x) > b: x[-b:] *= np.linspace(1, 0, b)
    return x

STEMS = {k: np.zeros((N, 2)) for k in ['sub', 'bass', 'drums', 'glass', 'pluck', 'pad', 'fx']}
def put(stem, x, t, gain=1.0, pan=0.0, label=None):
    i = int(round(t * SR))
    if i >= N or len(x) == 0: return
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        n = min(len(x), N - i); STEMS[stem][i:i + n] += x[:n] * gain
    else:
        n = min(len(x), N - i); a = (pan + 1) * np.pi / 4
        STEMS[stem][i:i + n, 0] += x[:n] * gain * np.cos(a) * 1.414; STEMS[stem][i:i + n, 1] += x[:n] * gain * np.sin(a) * 1.414
    if label: CUES.append((round(t, 6), label))


# —— 合成乐器 ——
def kick(v=1.0):
    t = tt(.32); f = 46 + 70 * np.exp(-t / .022)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .1) + hp(rng.standard_normal(len(t)), 3000) * np.exp(-t / .002) * .12
    return fade(x) * v

def b808(m, length, v=1.0, big=False, slide=0.0):
    """808：正弦 + 起音音高包络 + 尾巴滑音 + 软饱和（带出 2、3 次谐波，小喇叭也听得到）"""
    t = tt(length); f0 = mhz(m); f = f0 * (1 + 1.1 * np.exp(-t / .016))
    if slide: f *= 2 ** (slide / 12 * np.clip((t - length * .5) / (length * .45), 0, 1))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (1.2 if big else .5))
    k = 3.2 if big else 2.6
    x = np.tanh(x * k) / np.tanh(k)
    return fade(x + hp(rng.standard_normal(len(t)), 2500) * np.exp(-t / .002) * .2, .001, .03) * v

def clap(v=1.0):
    d = .4; t = tt(d); n = rng.standard_normal(len(t)); env = np.zeros(len(t))
    for k, o in enumerate([0, .010, .021, .033]):
        i = int(o * SR); env[i:] += np.exp(-(t[i:] - o) / (.006 if k < 3 else .1))
    return fade(bp(n * env, 1000, 5000)) * v

def tick(v=1.0, f=9500):
    """精密的滤波滴答：极短高频正弦 + 噪声"""
    t = tt(.025)
    return fade(np.sin(2 * np.pi * f * t) * np.exp(-t / .003) + hp(rng.standard_normal(len(t)), 7000) * np.exp(-t / .0015) * .5, .0003, .003) * v

def fm_glass(m, v=1.0, d=.6, cut=9000):
    """FM 玻璃拨音：调制比 3.5（非谐）+ 衰减的调制指数"""
    t = tt(d); f = mhz(m); I = 2.0 * np.exp(-t / .05) + .2
    x = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * f * 3.5 * t)) + .2 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / .08)
    return fade(lp(x * np.exp(-t / .2), cut), .002, .03) * v

def bell_ding(m, v=1.0, d=3.5):
    """高音玻璃叮：FM 1.4 + 非谐分音 ×2.76 ×5.4 ×8.93"""
    t = tt(d); f = mhz(m); I = 2.6 * np.exp(-t / .35) + .3
    x = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * f * 1.4 * t)) * np.exp(-t / 1.3)
    for r, a, tau in [(2.76, .4, .6), (5.40, .2, .3), (8.93, .09, .14)]:
        x += a * np.sin(2 * np.pi * f * r * t + rng.uniform(0, 6)) * np.exp(-t / tau)
    return fade(x, .001, .1) * v

def pad(ms, d, cut=1600, att=.8, rel=1.2):
    """暖铺底：失谐锯齿叠（每音 5 支 ±10 音分），低通，立体声"""
    t = tt(d); L = np.zeros(len(t)); R = np.zeros(len(t))
    for m in ms:
        for k, c in enumerate(np.linspace(-10, 10, 5)):
            f = mhz(m) * 2 ** (c / 1200); ph = rng.uniform(0, 1)
            w = 2 * ((f * t + ph) % 1) - 1
            if k % 2: L += w
            else: R += w
    e = np.minimum(1, t / att) * np.minimum(1, np.maximum(0, (d - t) / rel))
    return np.stack([lp(L, cut) * e, lp(R, cut) * e], 1) / (len(ms) * 3)

def sub(m, d, v=1.0, att=1.0, rel=.6):
    t = tt(d); f = mhz(m)
    x = np.sin(2 * np.pi * f * t) + .35 * np.sin(4 * np.pi * f * t) + .15 * np.sin(6 * np.pi * f * t)
    e = np.minimum(1, t / att) * np.minimum(1, np.maximum(0, (d - t) / rel))
    return x * e * v

def sparkle(d, density, lo=2200, hi=7000, v=1.0):
    """颗粒水晶云：很多极短的高音正弦颗粒（D 小调五声音高）"""
    out = np.zeros((int(round(d * SR)), 2)); pcs = [2, 5, 7, 9, 0]
    n = int(d * density)
    for i in range(n):
        st = rng.uniform(0, d); m = 12 * rng.integers(7, 10) + pcs[rng.integers(0, 5)]
        f = mhz(m)
        if f < lo or f > hi: continue
        g = tt(rng.uniform(.04, .16)); x = np.sin(2 * np.pi * f * g) * np.sin(np.pi * g / g[-1]) ** 2
        a = (rng.uniform(-.8, .8) + 1) * np.pi / 4; j = int(st * SR); k = min(len(x), len(out) - j)
        out[j:j + k, 0] += x[:k] * np.cos(a); out[j:j + k, 1] += x[:k] * np.sin(a)
    return out * v

def riser(d, v=1.0):
    t = tt(d); n = rng.standard_normal(len(t)); out = np.zeros(len(t)); hop = 480
    for i in range(0, len(t), hop):
        u = i / len(t); f = 400 + 6000 * u ** 2; s = bp(n[max(0, i - 3000):i + hop], f * .7, f * 1.4)[-hop:]; out[i:i + len(s)] = s
    saw = 2 * ((np.cumsum(110 * 2 ** (3 * t / d)) / SR) % 1) - 1
    return (out * .8 + lp(saw, 2500) * .25) * (t / d) ** 2 * v

D = lambda o: 12 * (o + 1) + 2   # D 的 midi
def n(name): return S.midi(name)

# ———————— A 轮廓（第 1 小节）————————
put('sub', sub(n('D2'), at(6) - 0.0, .5, att=2.0, rel=.02), 0.0)                               # 亚低音一直到 12.5 骤停
put('fx', sparkle(2.5, 26, v=.06), 0.0)
put('glass', S.note('glass', 'D5', 2.0, .7), T['flare'], .9, -.2, label='flare')                  # 1.25 轮廓到肩
put('glass', S.note('vibraphone_bowed', 'A4', 2.4, .45, attack=.6), 0.05, .35, .25)              # 弓玻璃长音淡入

# ———————— B 色散（第 2 小节）————————
put('drums', kick(.9), T['beam'], label='beam')
put('bass', b808(D(1), 1.6, .8), T['beam'], label='beam808')
for p, pn in [('D4', -.3), ('F4', 0), ('A4', .3)]: put('glass', S.note('glass', p if p != 'D4' else 'D5', 2.4, .55), T['beam'], .55, pn)
put('glass', S.note('hand_chimes', 'D6', 2.0, .5), T['beam'], .5, .1)
RAYS = ['D5', 'E5', 'F5', 'G5', 'A5', 'C6', 'D6']           # 七色 = 七个上行音（三连音八分）
for k, (tr, p) in enumerate(zip(T['rays'], RAYS)):
    put('glass', S.note('glockenspiel', p, .6, .5 + .03 * k), tr, .55, -.5 + k * .16, label=f'ray{k}')
    put('glass', fm_glass(n(p) + 12, .12, .4), tr, 1.0, -.5 + k * .16)
put('drums', kick(.6), at(2, 3))
put('pad', pad([n('D3'), n('A3'), n('F4')], 2.5, cut=1200, att=.3, rel=.4), at(2), .5)

# ———————— C 微距（第 3 小节）：拨弦主题 + 弓颤音琴 ————————
put('drums', kick(.85), at(3), label='cut_macro')
put('bass', b808(n('Bb1'), 1.2, .7), at(3))
put('pad', pad([n('Bb2'), n('F3'), n('D4')], 2.5, cut=1400, att=.2, rel=.3), at(3), .55)
put('glass', S.note('vibraphone_bowed', 'D5', 2.3, .4, attack=.3), at(3), .3, -.3)
MEL = [(1, 'A4', 1), (2, 'D5', 1), (3, 'F5', .5), (3.5, 'E5', .5), (4, 'D5', 1)]
for b, p, d in MEL:
    put('pluck', P.pluck('harp', p, None, .75), at(3, b), .9, .15, label='pluck' if b == 2 else None)
put('drums', kick(.6), at(3, 3))
for k in range(4): put('drums', tick(.25), at(3, 3) + k * BEAT / 2, 1, .4)

# ———————— D 焦散（第 4 小节）：节奏层全开，808 每拍一个 = 每圈焦散环 ————————
BAR4 = ['G1', 'G1', 'Bb1', 'C2']
for k, tr in enumerate(T['rings']):
    put('bass', b808(n(BAR4[k]), BEAT * .95, .75), tr, label=f'ring{k}')
    put('glass', fm_glass(n(['D6', 'F6', 'A5', 'C6'][k]), .22, .7, cut=7000), tr, 1, (-.4, .4, -.2, .2)[k])
put('drums', kick(.9), at(4)); put('drums', kick(.7), at(4, 3)); put('drums', clap(.5), at(4, 4))
for k in range(8): put('drums', tick(.28 if k % 2 == 0 else .18), at(4) + k * BEAT / 2, 1, (-.4, .4)[k % 2])
put('pad', pad([n('G2'), n('D3'), n('Bb3')], 2.5, cut=1500, att=.15, rel=.3), at(4), .5)
for b, p in [(1.5, 'D5'), (2.5, 'Bb4'), (3.5, 'G4')]: put('pluck', P.pluck('harp', p, None, .6), at(4, b), .7, -.2)

# ———————— E 透镜（第 5 小节）：加速，滴答变十六分，四拍底鼓，上升音，808 滑上去 ————————
put('drums', kick(.9), at(5), label='cut_lensA'); put('drums', kick(.8), at(5, 2)); put('drums', kick(.9), at(5, 3), label='cut_lensB'); put('drums', kick(.8), at(5, 4))
put('drums', clap(.55), at(5, 2)); put('drums', clap(.6), at(5, 4))
for k in range(16): put('drums', tick(.18 + .02 * (k % 4 == 0), 9000 + 300 * (k % 3)), at(5) + k * BEAT / 4, 1, (-.5, .5)[k % 2])
put('bass', b808(n('A1'), 1.2, .75), at(5)); put('bass', b808(n('A1'), 1.24, .75, slide=5), at(5, 3))
put('pad', pad([n('A2'), n('E3'), n('C#4')], 2.5, cut=2200, att=.1, rel=.02), at(5), .5)
for k, p in enumerate(['A4', 'C#5', 'E5', 'A5'] * 4): put('pluck', fm_glass(n(p), .2 + .015 * k, .3, cut=6000 + 300 * k), at(5) + k * BEAT / 4, 1, (-.3, .3)[k % 2])
put('fx', np.stack([riser(2.5, .35)] * 2, 1), at(5))
put('glass', S.note('glass', 'A5', 1.0, .5), T['lensB'] + BEAT, .45, .3)

# 12.5 骤停：所有声部在 12.5 处硬切（含混响尾巴），见下方 gate；只留一条极弱的弓玻璃长音到 14.375

# ———————— G 合盖与名字（第 7–8 小节）————————
SN = T['snap']
put('bass', b808(D(1), 3.2, 1.0, big=True), SN, label='snap808')
put('drums', kick(1.0), SN, label='snap')
for p, pn in [('D5', -.35), ('F#5', 0), ('A5', .35), ('D6', 0)]: put('glass', S.note('glass', p, 3.5, .8), SN, .7, pn)
put('glass', S.note('hand_chimes', 'D6', 3.0, .8), SN, .7, .15)
put('glass', bell_ding(D(6), .55, 4.5), SN, 1, 0)            # 全片最重的一声里的「叮」
put('pad', pad([n('D3'), n('F#3'), n('A3'), n('E4')], DUR - SN, cut=1700, att=.25, rel=2.2), SN, .75)
put('sub', sub(n('D2'), DUR - SN, .45, att=.02, rel=2.5), SN)
put('glass', S.note('glockenspiel', 'A5', 1.5, .55), T['title'], .55, .2, label='title')
put('glass', S.note('glass', 'F#5', 2.0, .5), T['title'], .4, -.2)
put('fx', sparkle(2.4, 30, v=.05), T['sub'] - .3)
put('glass', S.note('hand_chimes', 'A5', 2.0, .45), T['sub'], .45, -.25, label='sub')
put('pluck', P.pluck('harp', 'D5', None, .55), T['sub'] + BEAT, .5, .2)
put('pluck', P.pluck('harp', 'F#5', None, .5), T['sub'] + BEAT * 1.5, .45, -.1)
put('glass', S.note('glass', 'D5', 2.2, .6), T['last'], .65, 0, label='last')
put('glass', S.note('hand_chimes', 'D6', 2.0, .4), T['last'], .35, .3)
put('pluck', P.pluck('music_box', 'A6', None, .4), T['last'] + BEAT, .3, -.3)

# —— 空间：玻璃、拨弦、铺底送混响，然后在 12.5 与 14.375–15.0 把尾巴硬切 ——
for k, (size, mix) in {'glass': (.75, .35), 'pluck': (.6, .3), 'pad': (.7, .25), 'fx': (.5, .2)}.items():
    STEMS[k] = S.room(STEMS[k].astype(np.float32), size=size, mix=mix, predelay=.02).astype(np.float64)

def gate(x, a, b, fo=.006):
    i, j, f = int(round(a * SR)), int(round(b * SR)), int(fo * SR)
    x[i - f:i] *= np.linspace(1, 0, f)[:, None]; x[i:j] = 0
for k in STEMS: gate(STEMS[k], T['stop'], SN)              # 12.5 骤停：所有声部连同混响尾巴一起切掉
# 「停」里只留一条很弱的弓玻璃长音（近静默），14.375 前收干净
tone = S.note('vibraphone_bowed', 'A4', T['hover'] - T['stop'] - .25, .3, attack=.3, release=.2)
put('glass', S.room(tone, .6, .25), T['stop'], .22, label='stop_tone')
for k in STEMS: gate(STEMS[k], T['hover'], SN)              # 14.375–15.0 完全静音

# 低频平衡：长音区段的低端不要太厚
STEMS['sub'] = hp(STEMS['sub'].T, 40).T; STEMS['bass'] = hp(STEMS['bass'].T, 42).T; STEMS['drums'] = hp(STEMS['drums'].T, 38).T
mix = STEMS['sub'] * .12 + STEMS['bass'] * .3 + STEMS['drums'] * .6 + STEMS['glass'] * 1.0 + STEMS['pluck'] * .8 + STEMS['pad'] * .55 + STEMS['fx'] * .9
# 最后 1.2 s 自然收：淡出
fo = int(.9 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.2
pk = np.abs(mix).max(); mix *= .8 / pk
os.makedirs(os.path.join(HERE, 'stems'), exist_ok=True)
for k, v in STEMS.items(): sf.write(os.path.join(HERE, 'stems', k + '.wav'), (v * .8 / pk).astype(np.float32), SR)
sf.write(os.path.join(HERE, 'score.wav'), mix.astype(np.float32), SR)
json.dump({'bpm': TL['BPM'], 'dur': DUR, 'cues': sorted(CUES), 'silence': [T['hover'], SN], 'stop': T['stop']}, open(os.path.join(HERE, 'score.json'), 'w'), indent=1, ensure_ascii=False)
print('score.wav', mix.shape, 'peak', round(float(np.abs(mix).max()), 3), 'cues', len(CUES))
print('instruments:', S.credits(['glass', 'vibraphone_bowed', 'hand_chimes', 'glockenspiel']))
