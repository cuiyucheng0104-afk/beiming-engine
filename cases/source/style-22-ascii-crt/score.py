"""whale.exe 原创配乐：模拟合成器（PolyBLEP 锯齿/方波 + 4 极梯形滤波 + 磁带抖动 + 长混响/门限混响），
外加采样（VSCO 2 CE 音乐会大鼓、锣）与拨弦物理建模（弹簧"叮"）。全部从 timeline.json 读速度和拍点，确定性。
D 小调，110.77 BPM（13 帧/拍）。唯一的大三和弦（D 大调）只在水柱变冰青的那一拍打开。
python score.py → out/score.wav + out/stems/*.wav + out/music_cues.json"""
import os, sys, json, numpy as np, soundfile as sf
from numba import njit
from scipy.signal import fftconvolve, butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
SR = 48000; B = TL['BEAT']; DUR = TL['DUR']; N = int(round(DUR * SR)); C = TL['CUE']
b = lambda n: n * B
ix = lambda t: int(round(t * SR))
mf = lambda m: 440.0 * 2 ** ((m - 69) / 12)
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'Bb': 10, 'B': 11}
def m(s): return 12 * (int(s[-1]) + 1) + NOTE[s[:-1]]
rng = np.random.default_rng(1103)
S.seed(7)

@njit(cache=True)
def osc(freq, sr, ph0, kind):
    n = len(freq); out = np.empty(n); ph = ph0
    for i in range(n):
        dt = freq[i] / sr; v = 2.0 * ph - 1.0
        if ph < dt:
            t = ph / dt; v -= t + t - t * t - 1.0
        elif ph > 1.0 - dt:
            t = (ph - 1.0) / dt; v -= t * t + t + t + 1.0
        if kind == 1:
            p2 = ph + .5
            if p2 >= 1.0: p2 -= 1.0
            w = 2.0 * p2 - 1.0
            if p2 < dt:
                t = p2 / dt; w -= t + t - t * t - 1.0
            elif p2 > 1.0 - dt:
                t = (p2 - 1.0) / dt; w -= t * t + t + t + 1.0
            v = (v - w) * .5
        out[i] = v; ph += dt
        if ph >= 1.0: ph -= 1.0
    return out

@njit(cache=True)
def ladder(x, fc, res, sr):
    y1 = 0.0; y2 = 0.0; y3 = 0.0; y4 = 0.0; out = np.empty(len(x))
    for i in range(len(x)):
        f = fc[i]
        if f > sr * .42: f = sr * .42
        if f < 20.0: f = 20.0
        g = 1.0 - np.exp(-2.0 * np.pi * f / sr)
        u = np.tanh(x[i] - 4.0 * res * y4)
        y1 += g * (u - np.tanh(y1)); y2 += g * (np.tanh(y1) - np.tanh(y2))
        y3 += g * (np.tanh(y2) - np.tanh(y3)); y4 += g * (np.tanh(y3) - np.tanh(y4))
        out[i] = y4
    return out

def wow(n, t0, seed):
    t = t0 + np.arange(n) / SR; r = np.random.default_rng(seed)
    return 2 ** ((4 / 1200) * (np.sin(2 * np.pi * .41 * t + r.random() * 6.28) * .7 + np.sin(2 * np.pi * 1.07 * t + r.random() * 6.28) * .3))

def adsr(n, a, d, s, r, rel_at):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    ra = rel_at; e0 = np.interp(ra, t, e)
    return np.where(t > ra, e0 * np.exp(-(t - ra) / max(r, 1e-4)), e)

def pan2(x, p):
    a = (p + 1) * np.pi / 4; return np.stack([x * np.cos(a), x * np.sin(a)], 1)

def place(bus, x, t):
    i = ix(t)
    if i >= N: return
    if i < 0: x = x[-i:]; i = 0
    L = min(len(x), N - i); bus[i:i + L] += x[:L]

def voice(midi, dur, t0, kind=0, detune=(-6, 0, 6), cutoff=900., res=.2, amp=1., a=.005, d=.2, s=.7, r=.25, fenv=0., fdec=.1, seed=0, spread=.5, glide=None, fc_curve=None):
    """一个合成器声部（多振荡器失谐）→ 立体声。glide=(目标midi, 用时) 做滑音；fc_curve(t数组)→截止频率"""
    n = ix(dur + r * 5); w = wow(n, t0, seed); t = np.arange(n) / SR
    mm = np.full(n, float(midi))
    if glide: mm = midi + (glide[0] - midi) * np.clip(t / glide[1], 0, 1) ** .7
    sig = np.zeros((n, 2)); k = len(detune); rr = np.random.default_rng(seed + 11)
    for j, c in enumerate(detune):
        f = 440.0 * 2 ** ((mm - 69 + c / 100) / 12) * w
        o = osc(f, SR, rr.random(), kind)
        sig += pan2(o, 0 if k == 1 else (j / (k - 1) * 2 - 1) * spread) / np.sqrt(k)
    fc = fc_curve(t) if fc_curve is not None else cutoff * (1 + fenv * np.exp(-t / fdec))
    env = adsr(n, a, d, s, r, dur)
    y = np.stack([ladder(sig[:, 0], fc, res, SR), ladder(sig[:, 1], fc, res, SR)], 1)
    return y * env[:, None] * amp

def ir_long(dec=3.0, seed=1, pre=.025, hp=220):
    n = ix(dec * 1.5); t = np.arange(n) / SR; r = np.random.default_rng(seed)
    ir = r.standard_normal((n, 2)) * np.exp(-t / (dec / 6.9))[:, None]; ir[:ix(pre)] = 0
    ir = sosfilt(butter(1, hp, 'high', fs=SR, output='sos'), sosfilt(butter(1, 5000, 'low', fs=SR, output='sos'), ir, axis=0), axis=0)
    return ir / np.sqrt((ir ** 2).sum(0).mean())

def ir_gated(length=.32, seed=2):
    n = ix(length); r = np.random.default_rng(seed)
    ir = r.standard_normal((n, 2)) * (1 - .2 * np.arange(n) / n)[:, None]; ir[-ix(.01):] *= np.linspace(1, 0, ix(.01))[:, None]
    ir = sosfilt(butter(2, [160, 6500], 'bandpass', fs=SR, output='sos'), ir, axis=0)
    return ir / np.sqrt((ir ** 2).sum(0).mean())

def reverb(x, ir, wet):
    return x + np.stack([fftconvolve(x[:, 0], ir[:, 0])[:N], fftconvolve(x[:, 1], ir[:, 1])[:N]], 1) * wet

IRL, IRG = ir_long(), ir_gated()
st = {k: np.zeros((N, 2)) for k in ['drone', 'seq', 'arp', 'pad', 'kit', 'hits', 'riser', 'song', 'breach', 'lead', 'color', 'samp', 'thud']}
cues = []

# ---------- 次低音长音：回车时进入，静默时切断；变青后回来托底 ----------
def drone(t0, t1, f0=mf(26), amp=.5, att=.03, rel=.02):
    n = ix(t1 - t0); t = np.arange(n) / SR
    x = .55 * np.sin(2 * np.pi * f0 * t) + .5 * np.sin(2 * np.pi * 2 * f0 * t) + .35 * np.sin(2 * np.pi * 3 * f0 * t)   # 2、3 次谐波让小喇叭也听得见
    x = np.tanh(x * 1.2) * np.minimum(1, t / att) * np.minimum(1, (t1 - t0 - t) / rel)
    x *= .75 + .25 * np.sin(2 * np.pi * (1 / (4 * B)) * t - 1.57)                                                  # 每小节一次呼吸
    place(st['drone'], pan2(x * amp, 0), t0)
drone(b(4), b(22), amp=.13)
drone(b(28), DUR, f0=mf(38), amp=.11, att=.6, rel=1.4)

# ---------- 方波音序器：回车 8 分 → 拉远 16 分 → 变青后 4 分/2 分（减速） ----------
pat = ['D2', 'D2', 'D3', 'D2', 'A2', 'D2', 'C3', 'D2'], ['D2', 'D2', 'F2', 'D2', 'A2', 'D2', 'C3', 'A2']
fc_seq = lambda tt: 260 * (3200 / 260) ** np.clip((tt - b(4)) / (b(22) - b(4)), 0, 1) ** 1.6
for k in range(int((22 - 4) * 2)):
    tb = 4 + k * .5
    if tb >= 16: break
    nt = pat[(k // 8) % 2][k % 8]; acc = 1.0 if k % 2 == 0 else .7
    place(st['seq'], voice(m(nt), B * .42, b(tb), kind=1, detune=(0,), cutoff=fc_seq(b(tb)), res=.38, amp=.36 * acc, a=.002, d=.08, s=.35, r=.06, fenv=1.6, fdec=.05, seed=k), b(tb))
for k in range(int((22 - 16) * 4)):
    tb = 16 + k * .25
    nt = pat[(k // 8) % 2][k % 8]; acc = 1.0 if k % 4 == 0 else .62
    place(st['seq'], voice(m(nt), B * .2, b(tb), kind=1, detune=(0,), cutoff=fc_seq(b(tb)), res=.42, amp=.34 * acc, a=.002, d=.05, s=.3, r=.04, fenv=1.8, fdec=.04, seed=100 + k), b(tb))
for tb, nt, du in [(28, 'D2', 1), (29, 'A2', 1), (30, 'D2', 1), (31, 'F#2', 1), (32, 'D2', 2), (34, 'A1', 1), (35, 'D2', 1.6)]:
    place(st['seq'], voice(m(nt), b(du) * .8, b(tb), kind=1, detune=(0,), cutoff=700, res=.3, amp=.3, a=.004, d=.25, s=.5, r=.4, fenv=1.0, fdec=.12, seed=200 + tb), b(tb))

# ---------- 琶音：随字粒落地一音一音长出来；拉远时 16 → 32 分加速；变青后下行减速 ----------
ARP = ['D4', 'F4', 'A4', 'C5', 'D5', 'F5', 'A5', 'C6']
for k in range(8):                       # b10–b12：每个 16 分音加一个音，琶音"长出来"
    tb = 10 + k * .25
    place(st['arp'], voice(m(ARP[k]), B * .22, b(tb), detune=(-4, 4), cutoff=1600 + 200 * k, res=.25, amp=.16 + .02 * k, a=.002, d=.1, s=.4, r=.12, fenv=1.2, fdec=.05, seed=300 + k), b(tb))
for k in range(16):                      # b12–b16：8 分循环（垫在律动里）
    tb = 12 + k * .5
    place(st['arp'], voice(m(ARP[k % 8]), B * .3, b(tb), detune=(-4, 4), cutoff=1800, res=.25, amp=.13, a=.002, d=.1, s=.35, r=.12, fenv=1.0, fdec=.05, seed=400 + k), b(tb))
for k in range(16):                      # b16–b20：16 分
    tb = 16 + k * .25
    place(st['arp'], voice(m(ARP[k % 8]) + (0 if k < 8 else -2), B * .18, b(tb), detune=(-4, 4), cutoff=2000 + 90 * k, res=.28, amp=.13, a=.002, d=.06, s=.3, r=.08, fenv=1.0, fdec=.04, seed=500 + k), b(tb))
for k in range(16):                      # b20–b22：32 分 + 上行（加速）
    tb = 20 + k * .125
    place(st['arp'], voice(m(ARP[k % 8]) + 2 * (k // 8), B * .1, b(tb), detune=(-4, 4), cutoff=2600 + 160 * k, res=.3, amp=.11 + .005 * k, a=.001, d=.04, s=.3, r=.05, fenv=1.0, fdec=.03, seed=600 + k), b(tb))
DMAJ = ['A5', 'F#5', 'D5', 'A4', 'F#4', 'D4']
for k, (tb, du) in enumerate([(28.5, .5), (29, .5), (29.5, .5), (30, .5), (31, 1), (32, 1), (33, 2)]):
    place(st['arp'], voice(m(DMAJ[k % 6]), b(du) * .7, b(tb), detune=(-5, 5), cutoff=2400, res=.2, amp=.12, a=.003, d=.2, s=.5, r=.5, seed=700 + k), b(tb))

# ---------- 合成垫：Dm → Gm7 → Asus4（不出现大三和弦）；变青：D 大三和弦打开 ----------
def pad(notes, t0, t1, amp, fc0, fc1, att=.4, rel=.02, seed=0):
    fc = lambda tt: fc0 * (fc1 / fc0) ** np.clip(tt / max(t1 - t0, .01), 0, 1)
    for j, nt in enumerate(notes):
        place(st['pad'], voice(m(nt), t1 - t0, t0, detune=(-9, -3, 3, 9), res=.15, amp=amp, a=att, d=1, s=1, r=rel, fc_curve=fc, seed=seed + j, spread=.8), t0)
pad(['D3', 'F3', 'A3'], b(12), b(16), .11, 500, 900, seed=800)
pad(['G3', 'Bb3', 'D4', 'F4'], b(16), b(19), .1, 700, 1400, att=.2, seed=810)
pad(['A3', 'D4', 'E4'], b(19), b(22), .1, 1000, 2400, att=.15, seed=820)
pad(['D3', 'F#3', 'A3', 'D4', 'F#4', 'A4'], b(28), DUR, .085, 380, 2600, att=.006, rel=1.5, seed=830)

# ---------- 键盘当鼓：键帽"咚"踩拍、弹簧"叮"（拨弦物理建模）踩反拍、空格当军鼓 ----------
def thock(v=1.0):
    d = .14; t = np.arange(ix(d)) / SR
    body = np.sin(2 * np.pi * (95 + 60 * np.exp(-t / .01)) * t) * np.exp(-t / .045)
    clk = sosfilt(butter(2, [300, 1400], 'band', fs=SR, output='sos'), rng.standard_normal(len(t))) * np.exp(-t / .008)
    return (body * .6 + clk * .8) * v
def spring(v=1.0):
    x = P.pluck('banjo', m('A6') + rng.uniform(-.3, .3), .15, vel=.8)
    x = sosfilt(butter(2, 2500, 'high', fs=SR, output='sos'), x)
    t = np.arange(len(x)) / SR; tick = sosfilt(butter(2, 3000, 'high', fs=SR, output='sos'), rng.standard_normal(len(x))) * np.exp(-t / .002)
    return (x / (np.abs(x).max() + 1e-9) * .5 + tick * .4) * v
def space(v=1.0):
    d = .2; t = np.arange(ix(d)) / SR
    n = sosfilt(butter(2, [400, 3800], 'band', fs=SR, output='sos'), rng.standard_normal(len(t))) * np.exp(-t / .03)
    return (n + np.sin(2 * np.pi * 190 * t) * np.exp(-t / .02) * .6) * v
for k in range(int((22 - 12) / 1)):
    tb = 12 + k
    place(st['kit'], pan2(thock(1.0 if tb % 2 == 0 else .8), 0), b(tb))
    if tb % 2 == 1: place(st['kit'], pan2(space(.55), .1), b(tb))
    place(st['kit'], pan2(spring(.45), .35), b(tb + .5))
for k in range(int((22 - 16) * 4)):         # 拉远：16 分的轻敲（加速）
    tb = 16 + k * .25
    if k % 2: place(st['kit'], pan2(spring(.22 + .01 * k), -.3), b(tb))
for k in range(16):                          # 最后一小节：32 分滚奏
    tb = 20 + k * .125
    place(st['kit'], pan2(spring(.2 + .015 * k), .2 if k % 2 else -.2), b(tb))

# ---------- 门限混响击打 ----------
def tom(f0=80, v=1.0):
    d = .5; t = np.arange(ix(d)) / SR
    return (np.sin(2 * np.pi * np.cumsum(f0 * (1 + 1.2 * np.exp(-t / .03))) / SR) * np.exp(-t / .12) + sosfilt(butter(2, 2000, 'low', fs=SR, output='sos'), rng.standard_normal(len(t))) * np.exp(-t / .02) * .5) * v
for tb, f0, v in [(4, 70, .8), (12, 85, .55), (16, 65, .6)]:
    place(st['hits'], pan2(tom(f0, v), 0), b(tb)); cues.append({'beat': tb, 'what': 'hit'})

# ---------- 远处的鲸歌（b20，被 b22 的数字零截断） ----------
def whale_song(d=2.4):
    t = np.arange(ix(d)) / SR
    f = 260 * np.exp(-t / 1.6) + 120 + 6 * np.sin(2 * np.pi * 4.2 * t)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .35 * np.sin(2 * np.pi * np.cumsum(2.01 * f) / SR)
    x = sosfilt(butter(2, [90, 1400], 'band', fs=SR, output='sos'), x)
    return x * np.minimum(1, t / .012) * np.exp(-t / 1.4) * np.minimum(1, (d - t) / .3)
place(st['song'], pan2(whale_song() * .22, -.3), b(20)); cues.append({'beat': 20, 'what': 'song'})

# ---------- 上扬：采样保持噪声（b18–b22） ----------
n = ix(b(4)); t = np.arange(n) / SR
sh = np.repeat(rng.standard_normal(n // ix(B / 8) + 2), ix(B / 8))[:n]
noi = rng.standard_normal(n) * .3 + sh
fc = 400 * (10) ** (t / t[-1])
x = ladder(noi * .5, fc, .5, SR) * (t / t[-1]) ** 2
place(st['riser'], pan2(x * .5, 0), b(18))

# ---------- 静默后第一声：鲸跃出 ----------
t0 = b(C['breach'])
gl = voice(m('D3'), b(3), t0, detune=(-12, -4, 4, 12), res=.35, amp=.55, a=.004, d=.6, s=.6, r=1.2, glide=(m('D1'), b(3)),
           fc_curve=lambda tt: 160 + 2400 * np.exp(-tt / .6), seed=900, spread=.7)
place(st['breach'], gl, t0)
tb = np.arange(ix(1.6)) / SR
boom = np.sin(2 * np.pi * np.cumsum(58 * np.exp(-tb / .5) + 28) / SR) * np.exp(-tb / .55)
boom = np.tanh(boom * 1.6) + .35 * np.sin(2 * np.pi * np.cumsum(2 * (58 * np.exp(-tb / .5) + 28)) / SR) * np.exp(-tb / .3)
place(st['breach'], pan2(boom * .32, 0), t0)
place(st['samp'], pan2(S.hit('bass_drum', None, 1.0) * .9, 0), t0); cues.append({'beat': C['breach'], 'what': 'breach'})
# 顶点：失谐齐奏长音 A4 渐强（预备），变青时跳到 F#5（大三度＝颜色）
place(st['lead'], voice(m('A4'), b(2), b(C['apex']), detune=(-10, 0, 10), cutoff=1400, res=.2, amp=.16, a=b(1.6), d=1, s=1, r=.05, seed=950, spread=.6), b(C['apex']))
place(st['color'], voice(m('F#5'), b(3), b(C['cyan']), detune=(-10, 0, 10), cutoff=2600, res=.2, amp=.15, a=.003, d=.8, s=.75, r=1.6, fenv=.8, fdec=.3, seed=960, spread=.6), b(C['cyan']))
# 变青：门限混响击打 + 采样锣轻擦；落水：采样大鼓
place(st['hits'], pan2(tom(60, .7), 0), b(C['cyan'])); cues.append({'beat': C['cyan'], 'what': 'cyan'})
place(st['samp'], pan2(S.hit('gong', None, .5) * .35, .15), b(C['cyan']))
place(st['thud'], pan2(S.hit('bass_drum', None, .8) * .7, -.1), b(C['land'])); cues.append({'beat': C['land'], 'what': 'land'})

# ---------- 合成与混响 ----------
wet = {'pad': .5, 'arp': .35, 'lead': .45, 'color': .45, 'song': .9, 'breach': .4, 'seq': .12, 'kit': .0, 'drone': 0, 'hits': 0, 'riser': .25, 'samp': .0, 'thud': .0}
gains = {'drone': 1, 'seq': .8, 'arp': 1, 'pad': 1, 'kit': .55, 'hits': .55, 'riser': .5, 'song': 1, 'breach': 1, 'lead': 1, 'color': 1, 'samp': .8, 'thud': .8}
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
mix = np.zeros((N, 2))
for k, x in st.items():
    y = reverb(x, IRL, wet[k]) if wet[k] else x
    if k in ('hits', 'samp', 'thud', 'kit'): y = reverb(x, IRG, .35 if k != 'kit' else .12)
    y = y * gains[k]
    st[k] = y; mix += y
# 数字零：b22–b24 一切归零（混响尾一起切）
a0, a1 = ix(b(C['drop'])), ix(b(C['breach'])); f = ix(.002)
gate = np.ones(N); gate[a0:a1] = 0; gate[a0 - f:a0] = np.linspace(1, 0, f)
mix *= gate[:, None]
for k in st: st[k] *= gate[:, None]
cues.append({'beat': C['drop'], 'what': 'drop'})
pk = np.abs(mix).max(); mix *= .9 / pk
for k in st: sf.write(os.path.join(HERE, 'out', 'stems', f'{k}.wav'), (st[k] * .9 / pk).astype(np.float32), SR)
sf.write(os.path.join(HERE, 'out', 'score.wav'), mix.astype(np.float32), SR)
json.dump({'bpm': TL['BPM'], 'cues': [{**c, 't': c['beat'] * B} for c in cues]}, open(os.path.join(HERE, 'out', 'music_cues.json'), 'w'), indent=1)
print('score.wav', round(N / SR, 3), 's, peak norm', round(pk, 3))
