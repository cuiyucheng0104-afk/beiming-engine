"""mix.py — 《冷冻柜》配乐 + 拟音 + 环境声 → out/mix.wav（以及分轨 out/stems/*.wav、out/score_cues.json）
全部时间来自 events.json（由 timeline.js → main.js → core/render/events.mjs 导出）。
配器：特雷门琴（numpy）、slap bass（numpy）、方波琶音 + 鼓机（numpy）、颤音琴/弓奏颤音琴/手铃/玻璃琴/吊镲/拍手/沙锤（sampler 真实采样）、尼龙吉他（pluck.py 拨弦）、罐头笑声（numpy 共振峰合成）。
"""
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, lfilter
from core.audio import sampler as S, pluck as PL
from core.audio import sfx as X
from core.audio.sfx import SR, add

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
META = next(e for e in E['ev'] if e['type'] == 'meta')
B = META['B']; HIT = META['hit']; DUR = E['dur']
N = int(round((DUR + .02) * SR))
bt = lambda b: b * B
rng = np.random.default_rng(28)
S.seed(28)
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)

# ———————————————— 基础 DSP ————————————————
def tt(d): return np.arange(int(round(d * SR))) / SR
def mf(m): return 440 * 2 ** ((m - 69) / 12)
NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def M(s):
    n = NOTE[s[0]]; i = 1
    if len(s) > 2 and s[1] in '#b': n += 1 if s[1] == '#' else -1; i = 2
    return n + 12 * (int(s[i:]) + 1)
def lp(x, f, o=2): return sosfilt(butter(o, min(f, SR * .45), 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, min(b, SR * .45)], 'band', fs=SR, output='sos'), x)
def peq(x, f0=95., gain_db=3., Q=.9):   # RBJ 峰值 EQ：80–110 Hz 抬 +3 dB，40 Hz 以下基本不动
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f0 / SR; al = np.sin(w) / (2 * Q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A]); a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return lfilter(b / a[0], a / a[0], x, axis=0)
def adsr(n, a=.005, d=.1, s=.6, r=.1, hold=None):
    hold = hold if hold is not None else n / SR - r
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-6), np.where(t < a + d, 1 - (1 - s) * (t - a) / max(d, 1e-6), s))
    rel = np.clip((t - hold) / max(r, 1e-6), 0, 1)
    return e * (1 - rel)
def saw(ph): return 2 * (ph % 1) - 1
def sq(ph, w=.5): return np.where(ph % 1 < w, 1., -1.)
def noise(d): return rng.standard_normal(int(round(d * SR)))
def norm(x, p=1.): m = np.abs(x).max(); return x * (p / m) if m > 0 else x
def st(n=None): return np.zeros((n or N, 2))
def addm(buf, x, at, gain=1., pan=0.):   # mono → 立体声缓冲
    add(buf, np.asarray(x, dtype=np.float64), at, gain, pan)
def addst(buf, x, at, gain=1.):
    s = int(round(at * SR)); e = min(len(buf), s + len(x))
    if e > s: buf[s:e] += x[:e - s] * gain

# 混响
def ir(d=1.6, decay=.4, lpf=6000, pre=.012, seed=5):
    r = np.random.default_rng(seed); n = int(d * SR); t = np.arange(n) / SR
    h = np.stack([lp(r.standard_normal(n), lpf) * np.exp(-t / decay) for _ in range(2)], 1); h[:int(pre * SR)] = 0
    return h / np.abs(h).sum(0).max() * 6
def spring_ir(d=1.3, seed=9):
    r = np.random.default_rng(seed); n = int(d * SR); t = np.arange(n) / SR
    base = bp(r.standard_normal(n), 300, 4500) * np.exp(-t / .38)
    chirp = np.sin(2 * np.pi * np.cumsum(900 + 2600 * np.exp(-t / .05)) / SR) * np.exp(-t / .08) * .4   # 弹簧的“嘣”
    flutter = np.zeros(n)
    for k in range(1, 30): i = int(k * .029 * SR); flutter[i:i + 40] += .55 ** k * r.standard_normal(min(40, n - i))
    h = np.stack([base + chirp + flutter, np.roll(base, 37) + chirp * .8 + np.roll(flutter, 51)], 1); h[:int(.008 * SR)] = 0
    return h / np.abs(h).sum(0).max() * 5
def conv(x, h, wet=.3):
    y = np.stack([fftconvolve(x[:, c], h[:, c])[:len(x)] for c in range(2)], 1)
    return x * (1 - wet) + y * wet

# ———————————————— 合成乐器 ————————————————
def theremin(notes, glide=.07, vib=.3, rate=5.6, bright=.16, v=1.):
    """notes: [(t, dur, midi)] 连奏；滑音 70 ms，颤音在每个音开始 150 ms 后渐入"""
    t0 = notes[0][0]; t1 = max(t + d for t, d, _ in notes) + .3; n = int((t1 - t0) * SR)
    target = np.full(n, float(notes[0][2])); amp = np.zeros(n); vib_env = np.zeros(n)
    for t, d, m in notes:
        a, b = int((t - t0) * SR), int((t + d - t0) * SR); target[a:] = m
        env = adsr(b - a + int(.14 * SR), .04, .09, .85, .14, hold=d)
        amp[a:a + len(env)] = np.maximum(amp[a:a + len(env)], env[:n - a])
        L = int((d + .14) * SR); w = np.clip((np.arange(L) / SR - .15) / .25, 0, 1); vib_env[a:a + L] = np.maximum(vib_env[a:a + L], w[:n - a])
    k = 1 - np.exp(-1 / (glide * SR))
    mid = lfilter([k], [1, -(1 - k)], target, zi=[target[0] * (1 - k)])[0]
    f = mf(mid + vib * vib_env * np.sin(np.arange(n) / SR * rate * 2 * np.pi)); ph = np.cumsum(f) / SR
    x = np.sin(2 * np.pi * ph) + bright * np.sin(4 * np.pi * ph) + .06 * np.sin(6 * np.pi * ph)
    return t0, lp(x * amp, 5200) * v
def slap(m, d, v=1., kind='thumb'):
    n = int((d + .12) * SR); t = np.arange(n) / SR; f = mf(m) * (1 + .012 * np.exp(-t / .03))
    ph = np.cumsum(f) / SR
    x = sum(a * np.sin(2 * np.pi * k * ph) for k, a in [(1, 1), (2, .55), (3, .35), (4, .2), (5, .12), (6, .08)])
    br = {'thumb': (3200, 700), 'pop': (5200, 1100), 'ghost': (1500, 500)}[kind]
    cut = br[1] + (br[0] - br[1]) * np.exp(-t / .07)
    y = np.zeros(n); seg = 256
    for i in range(0, n, seg): y[i:i + seg] = lp(x[max(0, i - 2048):i + seg], cut[i])[-len(x[i:i + seg]):]
    e = adsr(n, .002, .16, .45, .06, hold=d) if kind != 'ghost' else adsr(n, .001, .04, 0, .02, hold=.04)
    tr = lp(noise(.012), 2200) * np.exp(-tt(.012) / .003) * (1.4 if kind == 'thumb' else .4)
    if kind == 'pop': tr = hp(noise(.01), 2500) * np.exp(-tt(.01) / .002) * 1.6
    y = y * e; y[:len(tr)] += tr
    return np.tanh(y * 1.6) * .8 * v
def sqarp(m, d, v=1., w=.3, cut=3000):
    n = int((d + .1) * SR); ph = np.cumsum(np.full(n, mf(m))) / SR
    return lp(sq(ph, w) * adsr(n, .002, .07, .3, .07, hold=d), cut) * v
def kick(v=1.):
    d = .32; t = tt(d); f = 46 + 90 * np.exp(-t / .035)
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .12) + hp(noise(d), 3000) * np.exp(-t / .003) * .3) * v
def clap(v=1.):
    d = .22; x = np.zeros(int(d * SR))
    for k, o in enumerate([0, .011, .022]): s = int(o * SR); b = bp(noise(d - o), 900, 2600) * np.exp(-tt(d - o) / (.012 if k < 2 else .06)); x[s:] += b
    return norm(x) * v
def hat(v=1., open_=False):
    d = .25 if open_ else .05; t = tt(d)
    x = bp(noise(d), 7000, 13000) + .3 * np.sin(2 * np.pi * 8100 * t + 3 * np.sin(2 * np.pi * 5400 * t))
    return x * np.exp(-t / (.08 if open_ else .012)) * v * .5
def tom(m=45, v=1.):
    d = .35; t = tt(d); f = mf(m) * (1 + .5 * np.exp(-t / .03))
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .13) + lp(noise(d), 1500) * np.exp(-t / .01) * .3) * v
def sub_boom(v=1., f0=55, d=1.4):
    t = tt(d); return np.sin(2 * np.pi * np.cumsum(f0 * (1 + .8 * np.exp(-t / .06))) / SR) * np.exp(-t / .45) * v

# 罐头笑声：每个“观众”是一串“哈”音节（声门脉冲 + 元音共振峰 + 气声）
FORM = {'a': [(800, 1.0), (1250, .6), (2650, .25)], 'e': [(520, 1.0), (1900, .5), (2600, .25)], 'o': [(560, 1.0), (900, .7), (2500, .15)]}
def laugh_voice(r, d, f0, vowel, rate, nsyl, decay):
    n = int(d * SR); t = np.arange(n) / SR; out = np.zeros(n)
    per = 1 / rate
    for k in range(nsyl):
        s0 = k * per * (1 + .08 * r.standard_normal()); L = per * .78
        a, b = int(s0 * SR), int(min(d, s0 + L) * SR)
        if a >= n - 10: break
        m = b - a; tl = np.arange(m) / SR
        fk = f0 * (1.06 - .1 * tl / L) * (1 + .015 * r.standard_normal())
        ph = np.cumsum(fk * (1 + .01 * r.standard_normal(m))) / SR
        src = saw(ph) * .6 + .5 * r.standard_normal(m) * np.exp(-tl / .035)   # 前面带一点“h”气声
        env = np.minimum(1, tl / .012) * np.exp(-tl / (L * .45)) * (decay ** k)
        out[a:b] += src * env
    y = sum(g * bp(out, f * .85, f * 1.15) for f, g in FORM[vowel])
    return y
def laugh_track(d, voices=46, seed=11):
    r = np.random.default_rng(seed); buf = np.zeros((int(d * SR), 2))
    for i in range(voices):
        male = r.random() < .5
        f0 = (r.uniform(105, 155) if male else r.uniform(185, 270))
        on = abs(r.normal(.05, .12)); dd = d - on
        y = laugh_voice(r, dd, f0, r.choice(['a', 'a', 'e', 'o']), r.uniform(4.6, 6.6), int(r.integers(5, 13)), r.uniform(.84, .95))
        # 少数人会在后面再笑第二轮
        if r.random() < .35:
            o2 = r.uniform(.9, 1.5); y2 = laugh_voice(r, max(.2, dd - o2), f0 * 1.05, 'a', r.uniform(5, 6.5), int(r.integers(3, 7)), .85)
            y[int(o2 * SR):int(o2 * SR) + len(y2)] += y2[:len(y) - int(o2 * SR)] * .7
        g = r.uniform(.4, 1.0) / voices ** .5; pan = r.uniform(-.8, .8)
        add(buf, y * g, on, 1, pan)
    t = np.arange(len(buf)) / SR
    env = np.minimum(1, t / .12) * np.exp(-np.maximum(0, t - .9) / 1.1)
    buf *= env[:, None]
    y = S.room(buf.astype(np.float32), size=.55, mix=.3)
    return y * (10 ** (-15 / 20) / np.sqrt(np.mean(y[:int(1.8 * SR)] ** 2)))   # 笑声段 RMS ≈ −15 dBFS

# ———————————————— 配乐 ————————————————
CUES = []   # 配乐拍点表：给 cuecheck 用
def cue(name, b): CUES.append({'name': name, 'beat': b, 't': bt(b)})

def score():
    muzak, groove, ther, stings, laughs = st(), st(), st(), st(), st()
    # —— A 超市电梯波萨（b0–b6）：颤音琴（采样）+ 尼龙吉他（pluck.py）+ 沙锤（采样）——
    chords = [(0, ['D3', 'A3', 'C4', 'F4', 'E4'], 'D2'), (2, ['G3', 'B3', 'F4', 'E4'], 'G2'), (4, ['C3', 'E4', 'G3', 'B3', 'D4'], 'C2')]
    for b0, ch, bass in chords:
        for off in (0, 1.5):
            for i, p in enumerate(ch[1:]): addst(muzak, S.render([(0, 'vibraphone', p, B * 1.2, .42, -.3 + i * .2)], dur=B * 2.4, master=False), bt(b0 + off) + i * .012, .55)
        addm(muzak, PL.pluck('nylon_guitar', bass, B * 1.4, .62), bt(b0), .7, -.1)
        addm(muzak, PL.pluck('nylon_guitar', bass[:-1] + str(int(bass[-1])), B * .9, .5), bt(b0 + 1), .55, -.1)
        for k, off in enumerate((.5, 1.0, 1.75)): addm(muzak, PL.strum('nylon_guitar', ch[1:4], B * .4, .38, spread=.012, up=k % 2 == 1), bt(b0 + off), .45, .25)
    for k in range(12): addm(muzak, S.hit('shaker', 'down' if k % 2 == 0 else 'up', .35 if k % 2 else .5), bt(k * .5), .32, .35)
    muzak = np.stack([bp(muzak[:, c], 220, 6500) for c in range(2)], 1)          # 超市喇叭的窄频
    cue('muzak_in', 0)
    # 特雷门琴主题：外星人一入画就进来（b2）
    t0, x = theremin([(bt(2), B * .9, M('A4')), (bt(3), B * .45, M('Bb4')), (bt(3.5), B * .45, M('A4')), (bt(4), B * .9, M('F4')),
                      (bt(5), B * .45, M('E4')), (bt(5.5), B * .45, M('Eb4')), (bt(6), B * 1.8, M('D4'))], v=.55)
    addm(ther, x, t0, 1, -.15); cue('theremin', 2)

    # —— B 三次开门（b6–b17）——
    riff = [(0, 'D2', 'thumb', .45), (.5, 'D3', 'pop', .2), (.75, 'D2', 'ghost', .1), (1, 'F2', 'thumb', .4), (1.5, 'A2', 'thumb', .3),
            (2, 'D2', 'thumb', .45), (2.5, 'D3', 'pop', .2), (3, 'C3', 'thumb', .3), (3.5, 'A2', 'pop', .2)]
    def groove_bar(b0, beats=4, drums=True, bass=True):
        for o, n, k, d in riff:
            if o < beats and bass: addm(groove, slap(M(n), d * B * 1.6, .9, k), bt(b0 + o), .62, 0)
        if drums:
            for i in range(beats):
                if i % 2 == 0: addm(groove, kick(), bt(b0 + i), .9)
                else: addm(groove, clap(), bt(b0 + i), .42, .1)
            for i in range(beats * 2): addm(groove, hat(.8 if i % 2 else .5), bt(b0 + i * .5), .5, .3)
    groove_bar(6, 3)                    # b6–b9（b9 砸门）
    groove_bar(9, 3)                    # b9–b12
    # 开门 stinger：第一次长（4 个音），第二次短（2 个音）——三次法则在加速
    for i, p in enumerate(['D4', 'F4', 'A4', 'D5']): addm(stings, sqarp(M(p), B * .22, .5), bt(HIT['open1']) + i * B / 4, .55, .15)
    addst(stings, S.render([(0, 'vibraphone_hard', 'D5', B * 2, .6, 0), (0, 'vibraphone_hard', 'F5', B * 2, .5, .2), (0, 'vibraphone_hard', 'A5', B * 2, .5, -.2)], dur=B * 3, master=False), bt(HIT['open1']), .8)
    cue('stinger1', HIT['open1'])
    for i, p in enumerate(['A4', 'D5']): addm(stings, sqarp(M(p), B * .22, .5), bt(HIT['open2']) + i * B / 4, .55, .15)
    addst(stings, S.render([(0, 'vibraphone_hard', 'D5', B * 1.2, .55, 0), (0, 'vibraphone_hard', 'A5', B * 1.2, .45, .2)], dur=B * 2, master=False), bt(HIT['open2']), .7)
    cue('stinger2', HIT['open2'])
    for h in ('slam1', 'slam2'): addm(groove, kick(1.1), bt(HIT[h]), 1.0); addm(groove, slap(M('D2'), B * .5, 1, 'thumb'), bt(HIT[h]), .7); cue(h, HIT[h])
    # 犹豫（b12–b14）：鼓退场，只剩 hat 嘀嗒 + 低音 16 分震音渐强 + 特雷门琴颤抖
    for i in range(8): addm(groove, hat(.6), bt(12 + i * .25 + .25), .35, .3)
    for i in range(8): addm(groove, slap(M('D2'), B * .2, .5 + i * .06, 'ghost' if i % 2 else 'thumb'), bt(12 + i * .25), .45 + i * .04)
    t0, x = theremin([(bt(12.2), B * .8, M('A4')), (bt(13), B * .9, M('Bb4'))], vib=.6, rate=7.5, v=.4); addm(ther, x, t0, 1, -.15)
    # 反向吊镲吸进 b14
    cym = S.hit('sus_cymbal', 'hit', .8)[:int(1.6 * SR)][::-1]
    addm(stings, cym, bt(HIT['open3']) - len(cym) / SR, .5, 0)
    # 开门 #3：特雷门琴大滑音 + 低音 boom + 手铃/钟琴冰晶琶音 + 弓奏颤音琴长音
    t0, x = theremin([(bt(14), B * .2, M('D4')), (bt(14.25), B * 1.6, M('D6')), (bt(16), B * .95, M('Db6'))], glide=.16, vib=.45, v=.6)
    addm(ther, x, t0, 1, 0)
    addm(stings, sub_boom(1.0, 48), bt(14), .9)
    shimmer = [(0, 'glockenspiel', 'D6'), (.0625, 'glockenspiel', 'F6'), (.125, 'glockenspiel', 'A6'), (.1875, 'glockenspiel', 'C7'), (.25, 'glockenspiel', 'E7'),
               (0, 'hand_chimes', 'D5'), (0, 'hand_chimes', 'A5')]
    addst(stings, S.render([(o * 1, inst, p, 2.0, .55, (i % 3 - 1) * .4) for i, (o, inst, p) in enumerate(shimmer)], dur=3.0, master=False), bt(14), .7)
    addst(stings, S.render([(0, 'vibraphone_bowed', 'A4', bt(3) - .1, .55, -.3), (0, 'vibraphone_bowed', 'D5', bt(3) - .1, .5, .3)], dur=bt(3.2), master=False), bt(14), .55)
    cue('reveal', HIT['open3'])
    addm(groove, slap(M('Db2'), B * .8, 1, 'thumb'), bt(HIT['react']), .5); cue('react_hit', HIT['react'])

    # —— D 吸入（b21–b27）——
    addm(stings, peq(sub_boom(1.2, 40, 2.0)), bt(HIT['inhale']), 1.0)   # 吸气 boom：80–110 Hz +3 dB
    for bar0 in (21, 25):
        nb = 4 if bar0 == 21 else 2
        for i in range(nb):
            addm(groove, kick(1.05), bt(bar0 + i), .95)
            if i % 2: addm(groove, clap(), bt(bar0 + i), .45, .1)
        for i in range(nb * 4): addm(groove, hat(.7 + .3 * (i % 2)), bt(bar0 + i * .25), .45, .3)
    for i in range(16):   # 方波琶音 16 分音符逐拍升调
        root = [M('D4'), M('F4'), M('A4'), M('C5')][i // 4]
        addm(stings, sqarp(root + [0, 3, 7, 12][i % 4], B * .2, .45), bt(21 + i * .25), .42, -.2 + (i % 4) * .13)
    for i in range(8): addm(groove, slap(M(['D2', 'D2', 'F2', 'D2', 'A2', 'D2', 'C3', 'D2'][i]), B * .4, .9, 'thumb' if i % 2 == 0 else 'pop'), bt(21 + i * .5), .6)
    t0, x = theremin([(bt(21), B * 1, M('D5')), (bt(22), B * .9, M('F5')), (bt(23), B * 1.9, M('A5'))], vib=.8, rate=8.5, v=.45); addm(ther, x, t0, 1, .1)
    addm(stings, S.hit('sus_cymbal', 'hit', .9)[:int(1.2 * SR)][::-1], bt(HIT['wipe']) - 1.2, .45)
    addst(stings, S.render([(0, 'sus_cymbal', 'stick', None, .7, 0)], dur=2, master=False), bt(HIT['wipe']), .45); cue('wipe_hit', HIT['wipe'])
    for i in range(4): addm(groove, kick(1), bt(23 + i * .5), .8); addm(groove, tom(52 - i * 3, .8), bt(23.25 + i * .5), .45, -.3 + i * .2)
    cue('inside', HIT['inside'])
    # b25 冻结：其它全部停住，只剩玻璃琴“冰”和弦 + 特雷门琴冻住的长音
    for s_ in (groove, stings):
        a = int(bt(HIT['freeze']) * SR); b_ = int(bt(HIT['spit']) * SR); s_[a:b_] *= np.linspace(1, 0, b_ - a)[:, None] ** 8
    addst(stings, S.render([(0, 'glass', 'A#4', B * 1.2, .7, -.3), (0, 'glass', 'D5', B * 1.2, .65, 0), (0, 'glass', 'F5', B * 1.2, .65, .3)], dur=B * 2, master=False), bt(HIT['freeze']), .9)
    cue('freeze', HIT['freeze'])
    # b26 弹出：低音上滑 + 鼓过门 → b27 落地（之后硬切）
    t0, x = theremin([(bt(26), B * .3, M('D3')), (bt(26.3), B * .6, M('D5'))], glide=.12, v=.35); addm(ther, x, t0, 1, 0)
    for i in range(4): addm(groove, tom(50 + i * 3, .9), bt(26 + i * .25), .55, .3 - i * .2)
    addm(groove, kick(1.2), bt(HIT['spit']), 1.0); cue('spit', HIT['spit'])
    addm(groove, kick(1.2), bt(HIT['land']), 1.0); addm(groove, slap(M('D2'), B * .3, 1, 'thumb'), bt(HIT['land']), .7); cue('land', HIT['land'])

    # —— F 哔之后：slap bass 过门 + 罐头笑声 + ba-dum-tss + 收尾 ——
    fill = [(0, 'D2', 'thumb'), (.25, 'D3', 'pop'), (.5, 'F2', 'thumb'), (.75, 'G2', 'thumb'), (1, 'A2', 'thumb'), (1.25, 'C3', 'pop'), (1.5, 'D3', 'pop'), (1.75, 'C3', 'ghost'),
            (2, 'A2', 'thumb'), (2.5, 'G2', 'thumb'), (2.75, 'F2', 'ghost'), (3, 'D2', 'thumb')]
    for o, n, k in fill: addm(groove, slap(M(n), B * .3, 1, k), bt(HIT['total'] + o), .66)
    for i in range(3):
        addm(groove, kick(1), bt(32 + i), .85)
        if i % 2: addm(groove, clap(), bt(32 + i), .4, .1)
    cue('fill', HIT['total'])
    lt = laugh_track(bt(36.5) - bt(32))
    addst(laughs, lt, bt(HIT['laugh']), 1.0)
    addst(laughs, S.render([(0, 'claps', 'group', None, .45, -.4), (.07, 'claps', 'group', None, .4, .4), (.16, 'claps', 'group', None, .35, 0)], dur=1.2, master=False), bt(HIT['laugh']) + .25, .25)
    cue('laugh', HIT['laugh'])
    addm(groove, tom(50, 1), bt(33.5), .7, -.25); addm(groove, tom(45, 1), bt(33.75), .75, .25)
    addst(stings, S.render([(0, 'sus_cymbal', 'stick', None, .85, .2)], dur=2.5, master=False), bt(HIT['pop']), .7); addm(groove, kick(1.1), bt(HIT['pop']), .9)
    cue('rimshot', HIT['pop'])
    t0, x = theremin([(bt(35), B * .35, M('A4')), (bt(35.3), B * 2.2, M('D5'))], glide=.11, vib=.4, v=.5); addm(ther, x, t0, 1, -.1)
    addst(stings, S.render([(0, 'vibraphone', p, 2.5, .5, (i - 1.5) * .3) for i, p in enumerate(['D4', 'F4', 'A4', 'E5'])], dur=2.6, master=False), bt(HIT['blink']), .6)
    cue('button', HIT['blink'])

    ther = conv(ther, spring_ir(), .38)
    stings = conv(stings, ir(1.4, .35), .22)
    groove = peq(groove)                       # slap bass / 鼓机：80–110 Hz +3 dB
    groove = conv(groove, ir(.8, .18), .12)
    music = muzak * .42 + groove * .55 + ther * .75 + stings * .72
    # 硬切：连混响尾巴一起切到 0（3 ms 淡出防爆音）
    for b0, b1 in ((HIT['cut1'], HIT['inhale']), (HIT['cut2'], HIT['beep1'])):
        a, z = int(bt(b0) * SR), int(bt(b1) * SR); f = int(.003 * SR)
        music[a - f:a] *= np.linspace(1, 0, f)[:, None]; music[a:z] = 0
    return music, laughs

# ———————————————— 拟音 ————————————————
def vox(f0a, f0b, d, vowel='a', breath=.2, nasal=False):
    t = tt(d); f = np.linspace(f0a, f0b, len(t)) * (1 + .02 * np.sin(2 * np.pi * 5 * t)); ph = np.cumsum(f) / SR
    src = saw(ph) * .7 + breath * noise(d)
    y = sum(g * bp(src, fq * .85, fq * 1.15) for fq, g in FORM[vowel])
    if nasal: y = bp(y, 300, 3500) + .3 * bp(src, 230, 300)
    return norm(y * np.minimum(1, t / .05) * np.minimum(1, (d - t) / .15))
def squeak(f0, f1, d, wob=25):
    t = tt(d); f = np.linspace(f0, f1, len(t)) * (1 + .04 * np.sin(2 * np.pi * wob * t))
    return norm(bp(saw(np.cumsum(f) / SR), 500, 5000) * np.sin(np.pi * t / d) ** .7)
def hiss(d, lo=2500, hi=9000, tau=.3):
    t = tt(d); return norm(bp(noise(d), lo, hi) * np.minimum(1, t / .02) * np.exp(-t / tau))
def seal_pop(): d = .12; t = tt(d); return norm(np.sin(2 * np.pi * np.cumsum(160 + 220 * np.exp(-t / .01)) / SR) * np.exp(-t / .03) + lp(noise(d), 900) * np.exp(-t / .008))
def slam(): d = .6; t = tt(d); x = X.thump(1, 62) * .9; r = bp(noise(d), 1800, 6000) * np.exp(-t / .06) * (np.sin(2 * np.pi * 31 * t) > 0); y = np.zeros(len(t)); y[:len(x)] += x; return norm(y + r * .35)
def clink(f=2400, d=.5):
    t = tt(d); return norm(sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t / (tau)) for k, a, tau in [(1, 1, .12), (2.76, .5, .06), (5.4, .3, .03)]) + hp(noise(d), 4000) * np.exp(-t / .002))
def crack():
    d = .9; t = tt(d); x = hp(noise(d), 1200) * np.exp(-t / .025) * 1.4 + lp(noise(d), 300) * np.exp(-t / .05) * .8
    for k in range(8): x[int(k * .012 * SR):int(k * .012 * SR) + len(clink(3000 + 700 * k, .4))] += clink(3000 + 700 * k, .4)[:len(x) - int(k * .012 * SR)] * .3 * .8 ** k
    return norm(x)
def boing(f0=300, f1=110, d=.6):
    t = tt(d); f = (f1 + (f0 - f1) * np.exp(-t / .15)) * (1 + .12 * np.sin(2 * np.pi * 16 * t) * np.exp(-t / .3))
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .25))
def beep():
    d = .13; t = tt(d); x = np.sin(2 * np.pi * 2950 * t) + .18 * np.sin(2 * np.pi * 8850 * t)
    return x * np.minimum(1, t / .002) * np.minimum(1, (d - t) / .004)
def blip(): d = .09; t = tt(d); return np.sin(2 * np.pi * np.cumsum(1700 - 600 * t / d) / SR) * np.exp(-t / .03)
def rustle(d=.25, v=1.): t = tt(d); return norm(bp(noise(d), 1500, 7000) * (np.abs(np.sin(2 * np.pi * 14 * t)) ** 2) * np.sin(np.pi * t / d)) * v
def gulp():
    d = .28; t = tt(d); f = 210 * np.exp(-t / .3)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-((t - .06) / .03) ** 2) + np.sin(2 * np.pi * np.cumsum(f * .7) / SR) * np.exp(-((t - .17) / .035) ** 2) * .8
    return norm(lp(x, 1200))
def suck():
    d = 2.2; t = tt(d); n = noise(d); out = np.zeros_like(n)
    for i in range(0, len(n), 480):
        hi = min(len(n), i + 480); f = 180 + 3200 * (i / len(n)) ** .7
        out[i:hi] = bp(n[max(0, i - 2000):hi], f * .6, f * 1.4)[-(hi - i):]
    env = np.minimum(1, t / .06) * (1 - .3 * t / d) * np.minimum(1, (d - t) / .4)
    return norm(out * env * 1.2 + sub_boom(1, 38, d) * .9)
def printer(): d = .45; t = tt(d); x = sq(np.cumsum(np.full(len(t), 1150.)) / SR) * ((t * 3 / d) % 1 < .55) * .4; return lp(x, 3000) * np.minimum(1, (d - t) / .02)
def chew(): d = .07; t = tt(d); return norm(bp(noise(d), 600, 2500) * np.exp(-t / .015))
def gum_pop(): d = .25; t = tt(d); return norm(hp(noise(d), 400) * np.exp(-t / .006) * 1.5 + np.sin(2 * np.pi * 180 * t) * np.exp(-t / .04))

def upto(x, t, tend):   # 截到 tend（冻结那一刻尖叫被冻住）
    n = max(0, int((tend - t) * SR)); y = x[:n].copy(); f = min(len(y), int(.004 * SR))
    if f: y[-f:] *= np.linspace(1, 0, f)
    return y
def foley():
    fol = st(); gulps = st()
    # 每个 EV 事件 → 一个声音（类型 → 合成器、增益、声像）
    for e in E['ev']:
        ty, t = e['type'], e['t']
        if ty == 'glass_squeak': addm(fol, squeak(900, 1250, .2, 30), t, .28, -.2)
        elif ty == 'yawn': addm(fol, vox(150, 95, 1.0, 'a', .35), t, .32, .35)
        elif ty == 'point': addm(fol, X.pop(.8), t, .3, -.2)
        elif ty == 'sigh': addm(fol, lp(hiss(.7, 300, 2500, .3), 2000), t, .3, .35)
        elif ty == 'step': addm(fol, X.thump(.5, 140) * .5 + 0, t, .3, -.2); addm(fol, squeak(1600, 1900, .06, 40), t, .1, -.2)
        elif ty == 'grab': addm(fol, X.click(.7, .9), t, .45, -.1)
        elif ty == 'door_open':
            fast = e.get('fast', 0); addm(fol, seal_pop(), t - .015, .6, .05); addm(fol, hiss(1.2 if not fast else .8, 1500, 7000, .35), t, .32, .1)
            addm(fol, X.creak(.8), t - .1, .18, .2)
        elif ty == 'vapor': addm(fol, lp(hiss(1.0, 400, 3000, .4), 2500), t, .2, 0)
        elif ty == 'slam': addm(fol, slam(), t, .85, .05)
        elif ty == 'eye_slide': addm(fol, squeak(2400, 2000, .16, 60), t, .12, .3)
        elif ty == 'whip': addm(fol, X.whoosh(.32, 1), t - .2, .5, -.4)
        elif ty == 'whimper': addm(fol, vox(520, 380, .45, 'e', .1, nasal=True), t, .22, -.1)
        elif ty == 'shrug': addm(fol, rustle(.28), t, .3, .3)
        elif ty == 'inhale_small': addm(fol, hiss(.45, 800, 4000, .5)[::-1], t, .25, -.1)
        elif ty == 'creak': addm(fol, X.creak(1), t, .35, .1); addm(fol, hiss(.5, 3000, 9000, .2), t + .05, .15, 0)
        elif ty == 'door_open_big':
            addm(fol, seal_pop(), t - .015, .8, 0); addm(fol, hiss(2.2, 2000, 10000, .8), t, .35, .2)
            for k in range(14): addm(fol, clink(2600 + 400 * (k % 7), .6), t + .03 * k, .07, (k % 5 - 2) * .3)
        elif ty == 'react': addm(fol, squeak(600, 1500, .22, 10), t - .05, .3, .2); addm(fol, rustle(.2), t, .3, .2)
        elif ty == 'gulp': addm(gulps, gulp(), t, .3, .15)
        elif ty == 'suck': addm(fol, upto(suck(), t, bt(HIT['inside'])), t, 1.0, 0)
        elif ty == 'lift': addm(fol, X.creak(1), t, .3, -.2)
        elif ty == 'stretch': addm(fol, squeak(260, 900, .45, 12), t, .3, .2)
        elif ty == 'swirl': addm(fol, X.whoosh(.55, 1), t - .3, .7, 0)
        elif ty == 'tumble': fz = bt(HIT['freeze']) - .12; addm(fol, upto(X.whoosh(.5, 1), t, fz), t, .4, -.5); addm(fol, upto(X.whoosh(.4, 1), t + .25, fz), t + .25, .35, .5)
        elif ty == 'scream_squeak': addm(fol, upto(vox(780, 920, .8, 'a', .1), t, bt(HIT['freeze']) - .12), t, .25, .3)
        elif ty == 'ice_form':
            for k in range(12): addm(fol, clink(3500 + 300 * k, .06) * np.exp(-tt(.06) / .015), t + k * B * .2 / 12, .05 + .01 * k, (k % 3 - 1) * .4)   # 在「咔」前留 0.1 s 空隙
        elif ty == 'freeze': addm(fol, crack(), t, .85, 0)
        elif ty == 'spit': addm(fol, boing(), t, .7, 0); addm(fol, X.whoosh(.4, 1), t + .05, .35, 0)
        elif ty in ('land', 'land2'): addm(fol, X.clack(.7, 1), t, .8, -.3 if ty == 'land' else .1); addm(fol, X.thump(.6, 90), t, .4, 0)
        elif ty == 'chew': addm(fol, chew(), t, .05, .2)
        elif ty == 'reach': addm(fol, rustle(.25), t, .14, .2)
        elif ty == 'pickup': addm(fol, rustle(.2), t, .2, .1); addm(fol, clink(2200, .3), t + .05, .1, .1)
        elif ty == 'beep': addm(fol, beep(), t, .62, 0)
        elif ty == 'swipe': addm(fol, X.whoosh(.25, 1), t, .12, .3)
        elif ty == 'set_down': addm(fol, X.clack(.8, 1), t, .3, .4)
        elif ty == 'total': addm(fol, printer(), t + .05, .2, .35)
        elif ty == 'bubble': addm(fol, squeak(140, 330, .55, 6), t, .2, .1)
        elif ty == 'pop': addm(fol, gum_pop(), t, .7, .1)
        elif ty == 'blink': addm(fol, blip(), t, .35, .3)
    # 死寂段：拟音尾巴也一起切掉，只留“咕”的一声咽口水
    a, z = int(bt(HIT['cut1']) * SR), int(bt(HIT['inhale']) * SR); f = int(.003 * SR)
    fol[a - f:a] *= np.linspace(1, 0, f)[:, None]; fol[a:z] = 0
    return (fol + gulps) * 1.5

# ———————————————— 环境声 ————————————————
def ambience():
    amb = st(); t = np.arange(N) / SR
    hum = (np.sin(2 * np.pi * 120 * t) * .5 + np.sin(2 * np.pi * 240 * t) * .3 + np.sin(2 * np.pi * 360 * t) * .15) * (1 + .3 * np.sin(2 * np.pi * 120 * t))
    buzz = bp(rng.standard_normal(N), 3000, 6000) * (np.abs(np.sin(2 * np.pi * 60 * t)) ** 8) * .25
    comp = lp(rng.standard_normal(N), 140) * 2.0 + np.sin(2 * np.pi * 98 * t) * .15
    store = (hum * .5 + buzz + comp) * .045
    # 超市（b0–b24，含死寂段：死寂里只剩它）
    e_store = np.clip(1 - (t - bt(HIT['inside'])) / .02, 0, 1)
    # 收银台（b27 起）：日光灯 + 传送带电机
    belt = (np.sin(2 * np.pi * 60 * t) * .4 + lp(rng.standard_normal(N), 400) * .8) * .03 * (t > bt(HIT['land'])) * (1 + .2 * np.sin(2 * np.pi * 9 * t))
    e_check = np.clip((t - bt(HIT['land'])) / .01, 0, 1)
    # 宇宙内（b24–b27）：冰风
    wind = bp(rng.standard_normal(N), 400, 2200) * (.6 + .4 * np.sin(2 * np.pi * .7 * t)) * .05
    e_in = ((t >= bt(HIT['inside'])) & (t < bt(HIT['land']))).astype(float)
    for c, ph in ((0, 0), (1, 1)):
        amb[:, c] = store * (e_store + e_check) + belt + wind * e_in
    # 死寂段稍微抬一点压缩机（让“冷场”被听见）
    dead = ((t >= bt(HIT['cut1'])) & (t < bt(HIT['inhale']))).astype(float)
    amb *= (1 + .35 * dead)[:, None]
    return amb

def main():
    music, laughs = score()
    fol = foley()
    amb = ambience()
    mixb = music * 1.0 + laughs * .9 + fol * 1.0 + amb * 1.0
    # 低频平衡：20–120 Hz 轻压
    lo = np.stack([lp(mixb[:, c], 110, 2) for c in range(2)], 1)
    mixb = mixb - lo * .18   # 返修：审片测得 20–120 Hz 比其余低 6.9 dB，放松低频压制（配合 groove/吸气 boom 的 +3 dB 峰值 EQ）
    mixb = np.stack([X.limit(mixb[:, c], .95) for c in range(2)], 1)
    for name, x in (('music', music), ('laugh', laughs), ('foley', fol), ('amb', amb)):
        sf.write(os.path.join(HERE, 'out', 'stems', name + '.wav'), x.astype(np.float32), SR)
    sf.write(os.path.join(HERE, 'out', 'mix.wav'), mixb.astype(np.float32), SR)
    json.dump(CUES, open(os.path.join(HERE, 'out', 'score_cues.json'), 'w'), ensure_ascii=False, indent=1)
    print('mix', mixb.shape[0] / SR, 's  peak', float(np.abs(mixb).max()))

if __name__ == '__main__':
    main()
