"""灯塔守夜 · 配乐 + 拟音 + 环境 → out/mix.wav
读 timeline.json（唯一时间源导出）与 events.json（画面 window.EV），所有声音按帧精确落位。
写 out/cues_audio.json：每个关键音乐/拟音事件实际放进音频的时间（供 tools/cuecheck.py 核对）。
"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, bp, lp, hp, env_exp, t_, norm, brown, creak, thump, whoosh, ignite, limit

S.seed(15)
rng = np.random.default_rng(15)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
K, KB = TL['K'], TL['KB']
DUR = TL['dur']
B = TL['beat_s']
import math
T = lambda b: math.floor(b * TL['fpb'] + .5) / TL['fps']   # 与 JS Math.round 一致
N = int(round(DUR * SR))
mus, fol, amb = (np.zeros((N, 2), np.float32) for _ in range(3))
placed = {}


def put(buf, x, at, gain=1.0, pan=0.0, key=None):
    s = int(round(at * SR))
    if key: placed[key] = s / SR
    if s >= len(buf): return
    x = np.asarray(x, np.float32)
    if x.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
        x = np.stack([x * l, x * r], 1)
    e = min(len(buf), s + len(x)); buf[s:e] += x[:e - s] * gain


def n_(inst, pitch, dur, vel, **kw): return S.note(inst, pitch, dur, vel=vel, **kw)


# ============================================================ 配乐（E 小调 → E 大调；低音弦 + 皮与木 + 铜管 + 一面锣）
def score():
    # —— S1 刻版：大鼓 + 大提琴持续音；刀即节奏（原木鼓轻垫）
    put(mus, S.hit('gran_cassa', 'hit', .72), K['knife'][0], .6, -.1, key='m.knife.0')
    put(mus, n_('cellos', 'E3', T(10) - .25, .42, attack=.9, release=.6), 0.0, .8, -.25)
    put(mus, n_('contrabass', 'E2', T(10) - .2, .36, attack=1.4, release=.6), 0.0, .7, .2)
    put(mus, n_('cellos', 'B3', T(10) - T(4) - .2, .36, attack=.5, release=.6), T(4), .55, .3)
    for i, tk in enumerate(K['knife']):
        put(mus, S.hit('log_drum', 'lo' if i < 3 else 'hi', .55 if i < 3 else .42), tk, .55, .35 if i % 2 else -.35, key=f'm.knife.{i}' if i else None)
    put(mus, S.hit('gran_cassa', 'hit', .62), K['sky'], .8, 0, key='m.sky')
    put(mus, S.hit('sus_cymbal', 'cresc', .45), K['sky'] - .05, .25, .4)
    # —— S2 风暴：跳弓八分音型（减速到 b9.75 停），拨弦低音，定音鼓与大鼓
    put(mus, S.hit('gran_cassa', 'hit', .82), K['cut2'], 1.0, 0, key='m.cut2')
    pat = ['E3', 'B3', 'G3', 'B3', 'E3', 'D4', 'B3', 'G3', 'E3', 'B2']
    for i, (b, p) in enumerate(zip(KB['spic'], pat)):
        put(mus, n_('cellos_spic', p, B * .45, .62 if i % 2 == 0 else .5), T(b), .75, -.3 + .6 * (i % 2), key=f'm.spic.{i}')
    for b, p in zip([5, 6, 7, 8, 9], ['E2', 'E2', 'C2', 'B1', 'E2']):
        put(mus, n_('contrabass_pizz', p, B * .9, .7), T(b), .8, .15)
    for i, (tw, p) in enumerate(zip(K['wave'], ['E3', 'B2'])):
        put(mus, n_('timpani', p, 1.4, .85 + .1 * i), tw, .7, -.2, key=f'm.wave.{i}')
        put(mus, S.hit('gran_cassa', 'hit', .7 + .15 * i), tw, .55, .1)
    # —— S3 爬塔：音乐撤空（只留环境与拟音），b11.5–b12 数字静默
    # —— b12 灯亮：全片最重要的一声
    ti = K['ignite']
    put(mus, S.hit('gran_cassa', 'hit', 1.0), ti, 1.2, 0, key='m.ignite')
    put(mus, S.hit('gong', None, .9), ti, .9, -.15)
    put(mus, S.hit('sus_cymbal', 'cresc', .7), ti, .45, .35)
    for p, pan in [('E3', -.35), ('G3', 0), ('B3', .35)]:
        put(mus, n_('horn', p, T(16) - ti, .78, attack=.04, release=.4), ti, .55, pan)
    put(mus, n_('trombone', 'E2', T(16) - ti, .7, attack=.04, release=.4), ti, .45, .1)
    put(mus, n_('tuba', 'E2', T(16) - ti, .6, attack=.06, release=.4), ti, .35, -.1)
    # 光束：一拍一刀，大鼓四分 + 定音鼓 + 大提琴上行
    for i, (tb, p) in enumerate(zip(K['beam'], ['E3', 'F#3', 'G3'])):
        put(mus, S.hit('gran_cassa', 'hit', .66 + .05 * i), tb, .6, 0, key=f'm.beam.{i}')       # 比灯亮低 ≥3 dB
        put(mus, n_('timpani', ['E3', 'F#3', 'G3'][i], 1.0, .7), tb, .43, -.25)
        put(mus, n_('cellos', p, B * 1.02, .62, attack=.03, release=.25), tb, .7, -.3)
    put(mus, S.hit('sus_cymbal', 'cresc', .6), T(15) - .1, .35, -.3)
    # —— b16 照到船：E 大调号角 + 镲
    tl = K['boat_lit']
    put(mus, S.hit('gran_cassa', 'hit', .9), tl, .7, 0, key='m.boat_lit')
    put(mus, S.hit('clash', 'crash', .62), tl, .45, .4)
    for p, pan in [('E3', -.35), ('G#3', 0), ('B3', .35)]:
        put(mus, n_('horn', p, T(19.5) - tl, .66, attack=.05, release=1.6), tl, .45, pan)
    put(mus, n_('trombone', 'E2', T(19.5) - tl, .6, attack=.05, release=1.6), tl, .4, .1)
    put(mus, n_('tuba', 'E2', T(19.5) - tl, .5, attack=.05, release=1.6), tl, .3, -.1)
    for b, p, d in [(16, 'B3', .5), (16.5, 'E4', .5), (17, 'G#4', 1.4), (18, 'F#4', .5), (18.5, 'E4', 1.6)]:
        put(mus, n_('horn', p, B * d, .82, attack=.02, release=.5), T(b), .7, .15, key=f'm.call.{b}')
    put(mus, n_('cellos', 'E3', T(20) - tl, .5, attack=.1, release=1.0), tl, .6, -.3)
    put(mus, n_('cellos', 'B3', T(20) - tl, .45, attack=.1, release=1.0), tl, .5, .3)
    # 靠岸
    put(mus, n_('contrabass_pizz', 'E2', B, .8), K['dock'], .5, .1, key='m.dock')         # 靠岸整体压 6 dB：不能盖过灯亮
    put(mus, n_('timpani', 'E3', 1.2, .55), K['dock'], .28, -.2)
    # —— b20 揭纸 → 成品：锣余音 + 低音 E（L-cut：号角尾音跨过揭纸）
    put(mus, S.hit('gong', None, .38), K['peel'], .55, -.2, key='m.peel')
    put(mus, n_('cellos', 'E3', DUR - K['peel'], .4, attack=.3, release=.3), K['peel'], .55, -.25)
    put(mus, n_('contrabass', 'E2', DUR - K['peel'], .34, attack=.4, release=.3), K['peel'], .5, .2)
    put(mus, n_('cellos', 'G#3', DUR - K['caption'], .3, attack=.5, release=.3), K['caption'], .35, .3)
    put(mus, S.hit('woodblock', 'a', .5), K['caption'], .35, .3, key='m.caption')
    # 星逐颗点亮：轻木鱼，左右交替，越来越轻
    for i, ts in enumerate(K['star']):
        put(mus, S.hit('woodblock', 'bc'[i % 2], .32 - .02 * i), ts, .32, -.45 + .9 * ((i * 3) % 5) / 4, key=f'm.star.{i}')


# ============================================================ 拟音（全部合成，由 window.EV 驱动）
def grains(d, rate, lo, hi, tau=.004, amp=None):
    """纤维撕裂：一串随机的小脉冲，带通"""
    n = int(d * SR); x = np.zeros(n)
    k = rng.random(n) < rate / SR
    x[k] = rng.standard_normal(k.sum()) * 3
    x = bp(x, lo, hi) + bp(rng.standard_normal(n), lo * 1.2, hi) * .15
    e = np.ones(n) if amp is None else amp
    return x * e


def knife_bite(v=1.0):
    d = .25; tt = t_(d)
    tr = hp(rng.standard_normal(len(tt)), 2500) * env_exp(d, .0025)
    wood = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(420, .8, .03), (980, .5, .018), (1750, .35, .01)])
    return norm(tr * 1.2 + wood + lp(rng.standard_normal(len(tt)), 300) * env_exp(d, .02) * .6) * v


def knife_run(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR
    e = np.minimum(1, tt / .03) * np.minimum(1, (d - tt) / .05).clip(0)
    x = grains(d, 900, 1800, 7000, amp=e) + bp(rng.standard_normal(n), 3000, 6500) * e * .25
    return norm(x) * v


def flurry(d, n, v=1.0):
    out = np.zeros(int((d + .2) * SR))
    for i in range(n):
        u = (i / max(1, n - 1)) ** .8; s = int(u * d * SR)
        c = knife_run(.07 + rng.random() * .06, .5 + .5 * rng.random()); out[s:s + len(c)] += c[:len(out) - s]
    b = knife_bite(.8); out[:len(b)] += b
    return norm(out) * v


def gouge(d, v=1.0, lo=500, hi=3200):
    n = int(d * SR); tt = np.arange(n) / SR
    e = np.minimum(1, tt / .04) * np.minimum(1, (d - tt) / .1).clip(0)
    return norm(grains(d, 600, lo, hi, amp=e) + bp(rng.standard_normal(n), lo, hi * .7) * e * .5) * v


def stab(n=5, v=1.0):
    out = np.zeros(int(.25 * SR))
    for i in range(n):
        s = int(rng.random() * .1 * SR); c = knife_bite(.4 + .4 * rng.random())[:int(.06 * SR)]; out[s:s + len(c)] += c * (1 - i * .08)
    return norm(out) * v


def metal(f0, ratios, decays, v=1.0, d=1.0, hit=.3):
    tt = t_(d)
    x = sum(np.sin(2 * np.pi * f0 * r * tt + rng.random()) * env_exp(d, tau) / (1 + i * .4) for i, (r, tau) in enumerate(zip(ratios, decays)))
    x += hp(rng.standard_normal(len(tt)), 3000) * env_exp(d, .002) * hit
    return norm(x) * v


def wave_crash(v=1.0):
    d = 1.8; tt = t_(d)
    body = lp(brown(d), 900) * np.minimum(1, tt / .004) * env_exp(d, .5)
    hiss = hp(rng.standard_normal(len(tt)), 2500) * np.minimum(1, tt / .08) * env_exp(d, .35) * .35
    return norm(body + hiss + lp(rng.standard_normal(len(tt)), 150) * env_exp(d, .1) * .8) * v


def paper_slap(v=1.0):
    d = .3; tt = t_(d)
    return norm(lp(rng.standard_normal(len(tt)), 2500) * env_exp(d, .02) + np.sin(2 * np.pi * 95 * tt) * env_exp(d, .05) * .8) * v


def peel(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; u = tt / d
    tack = grains(d, 300 + 2500 * u, 900, 5000, amp=np.sin(np.pi * u) ** .5)
    air = bp(rng.standard_normal(n), 300, 2400) * (u ** 2) * np.minimum(1, (d - tt) / .05).clip(0) * .8
    return norm(tack + air) * v


def brayer(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR
    e = np.minimum(1, tt / .08) * np.minimum(1, (d - tt) / .15).clip(0)
    flutter = .6 + .4 * np.sin(2 * np.pi * 31 * tt) ** 2
    return norm(grains(d, 1400, 700, 4500, amp=e * flutter) + lp(rng.standard_normal(n), 400) * e * .4) * v


def water_lap(v=1.0):
    d = .45; tt = t_(d)
    return norm(bp(rng.standard_normal(len(tt)), 250, 1600) * np.minimum(1, tt / .04) * env_exp(d, .12)) * v


def foley():
    for e in EV:
        t, ty, key = e['t'], e['type'], e.get('key')
        k = 'f.' + key if key else None
        if ty == 'knife_bite': put(fol, knife_bite(), t, .9 * e.get('v', 1), .25, key=k)
        elif ty == 'knife_run': put(fol, knife_run(e['dur']), t, .55, .2)
        elif ty == 'flurry': put(fol, flurry(e['dur'], e['n']), t, .8, -.2 if '4' in key or '6' in key else .3, key=k)
        elif ty == 'gouge_sky': put(fol, gouge(e['dur']), t, .75, -.3, key=k)
        elif ty == 'stab': put(fol, stab(e['n']), t, .6, .4 if key.endswith('1') else -.3, key=k)
        elif ty == 'knife_lift': put(fol, whoosh(.25, .3), t, .4, .5)
        elif ty == 'impression': put(fol, paper_slap(), t, .9 * e.get('v', 1), 0, key=k)
        elif ty == 'wave_crash': put(fol, wave_crash(), t, .95 * e['v'], -.25 if key.endswith('0') else .25, key=k)
        elif ty == 'creak': put(fol, creak(.8), t, .55, .35, key=k)
        elif ty == 'snap': put(fol, whoosh(.18, .5), t, .45, .0, key=k)
        elif ty == 'rung': put(fol, metal(1180, [1, 2.76, 5.4, 8.93], [.35, .2, .1, .05], d=.6), t, .5 * e['v'], -.35, key=k)
        elif ty == 'grate': put(fol, metal(420, [1, 2.3, 3.9], [.18, .1, .06], d=.35, hit=.6) * .7 + thump(.6, 90)[:int(round(.35 * SR))] * .6, t, .55, -.15, key=k)
        elif ty == 'ignite':
            put(fol, knife_bite(1.0), t, 1.1, 0, key=k); put(fol, ignite(1.0), t, .9, 0)
        elif ty == 'ray': put(fol, gouge(.22, 1, 1200, 6000), t, .7 * e['v'], .5 - .33 * int(key[-1]), key=k)
        elif ty == 'flinch': put(fol, bp(rng.standard_normal(int(.25 * SR)), 300, 2000) * env_exp(.25, .07) * .5, t + .03, .4, -.2)
        elif ty == 'beam':
            put(fol, gouge(.34, 1, 600, 4200), t, .85 * e['v'], .35, key=k); put(fol, thump(.6, 60), t, .5, 0)
        elif ty == 'plate_roll': put(fol, brayer(e['dur'] + .2), t, .5, -.1, key=k)
        elif ty == 'plate_back': put(fol, brayer(e['dur'], .6), t, .35, .2)
        elif ty == 'oars':
            for i in range(int(e['dur'] / .42)): put(fol, water_lap(.6), t + .2 + i * .42, .35, .3)
        elif ty == 'dock':
            put(fol, thump(1.0, 110), t, .45, .2, key=k); put(fol, creak(.9), t + .05, .25, .3)
        elif ty == 'peel': put(fol, peel(e['dur'] + .1), t, .8, .2, key=k)
        elif ty == 'letterpress':
            put(fol, knife_bite(.8)[:int(.12 * SR)], t, .7, 0, key=k); put(fol, paper_slap(.5), t, .4, 0)
        elif ty == 'star': put(fol, knife_bite(.5)[:int(.05 * SR)], t, .22 * e['v'], .3, key=k)
        elif ty == 'boat_lit': placed['f.boat_lit'] = round(t * SR) / SR


# ============================================================ 环境
def ambience():
    def bed(t0, t1, gain, kind, fin=.3, fout=.3):
        d = t1 - t0; n = int(round(d * SR)); tt = np.arange(n) / SR
        if kind == 'storm':
            w = bp(brown(d), 180, 1100) * (.7 + .3 * np.sin(2 * np.pi * .23 * tt + 1) ** 2)
            r = hp(rng.standard_normal(n), 3500) * .25
            sea = lp(brown(d), 260) * (.6 + .4 * np.sin(2 * np.pi * .45 * tt) ** 2)
            x = norm(w + r + sea * .9)
        elif kind == 'wind_hi':
            x = norm(bp(brown(d), 900, 2600) * (.6 + .4 * np.sin(2 * np.pi * .3 * tt) ** 2))
        elif kind == 'sea':
            x = norm(lp(brown(d), 500) + bp(brown(d), 300, 1500) * .5 + hp(rng.standard_normal(n), 4000) * .08)
        else:  # room
            x = norm(lp(brown(d), 300))
        e = np.minimum(1, tt / fin) * np.minimum(1, (d - tt) / fout).clip(0)
        x2 = np.stack([x, np.roll(x, 911)], 1) * e[:, None]
        put(amb, x2, t0, gain)
    bed(T(2.5), K['cut3'], .32, 'storm', fin=T(5) - T(2.5), fout=.05)        # J-cut：风浪在刻版时就进来
    bed(K['cut3'], T(11.5), .035, 'wind_hi', fin=.05, fout=.12)              # 近乎静默：只有极弱的高风
    bed(K['ignite'], K['peel'] + .6, .26, 'sea', fin=.25, fout=.6)           # 灯亮后海风回来；L-cut 跨过揭纸
    bed(K['peel'], DUR, .05, 'room', fin=.4, fout=.3)


score(); foley(); ambience()
for ch in range(2):
    amb[:, ch] = hp(amb[:, ch], 90, 2); fol[:, ch] = hp(fol[:, ch], 55, 2)

# —— 混音：音乐在关键拟音下让 3 dB；静默窗口真·数字静默
fk = np.abs(fol).max(1)
from scipy.ndimage import maximum_filter1d, uniform_filter1d
duck = 1 - .3 * np.clip(uniform_filter1d(maximum_filter1d(fk, int(.08 * SR)), int(.05 * SR)) / (fk.max() + 1e-9) * 3, 0, 1)
mix = mus * duck[:, None] * 1.0 + fol * .9 + amb * 1.0
# 低频平衡：20–120 Hz 收一点，低音提琴/大鼓保留泛音
for ch in range(2): mix[:, ch] -= .5 * lp(lp(mix[:, ch], 110), 110)
s0, s1 = int(round(T(KB['silence'][0]) * SR)), int(round(T(KB['silence'][1]) * SR))
fade = int(.06 * SR)
mix[s0 - fade:s0] *= np.linspace(1, 0, fade)[:, None]
mix[s0:s1] = 0.0
mix[-int(.35 * SR):] *= np.linspace(1, 0, int(.35 * SR))[:, None]
pk = np.abs(mix).max(); mix = mix / pk * .89
# 削峰：其余重音压到同一天花板；b12 灯亮的 0.6 s 窗口天花板高 5 dB —— 灯亮是全片无争议的最高峰
CEIL, LIFT = .135, 10 ** (4.6 / 20)
ceil = np.full(len(mix), CEIL)
i0, i1, rmp = int(round(K['ignite'] * SR)), int(round((K['ignite'] + .6) * SR)), int(.02 * SR)
ceil[i0 - rmp:i0] = np.linspace(CEIL, CEIL * LIFT, rmp); ceil[i0:i1] = CEIL * LIFT; ceil[i1:i1 + 4 * rmp] = np.linspace(CEIL * LIFT, CEIL, 4 * rmp)
def limit_c(x, ceil, look=.006):
    n = int(look * SR)
    m_ = maximum_filter1d(np.abs(x), size=2 * n + 1); g_ = np.minimum(1, ceil / np.maximum(m_, 1e-9)); return x * uniform_filter1d(g_, size=n)
for ch in range(2): mix[:, ch] = limit_c(mix[:, ch], ceil)
mix = mix / np.abs(mix).max() * .89
mix[s0:s1] = 0.0
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
for nm, st in [('music', mus), ('foley', fol), ('amb', amb)]: sf.write(os.path.join(HERE, 'out', f'stem_{nm}.wav'), (st / (np.abs(st).max() + 1e-9) * .8).astype(np.float32), SR)
json.dump(placed, open(os.path.join(HERE, 'out', 'cues_audio.json'), 'w'), indent=1)
# 低频占比
from numpy.fft import rfft, rfftfreq
X = np.abs(rfft(mix.mean(1))) ** 2; f = rfftfreq(len(mix), 1 / SR)
lo = X[(f > 20) & (f < 120)].sum(); rest = X[(f >= 120) & (f < 16000)].sum()
print(f'mix.wav {len(mix)/SR:.3f}s  peak {np.abs(mix).max():.3f}  low(20-120)/rest = {10*np.log10(lo/rest):+.1f} dB  cues placed {len(placed)}')
print('\n'.join(S.credits(['cellos', 'contrabass', 'cellos_spic', 'contrabass_pizz', 'timpani', 'gran_cassa', 'gong', 'sus_cymbal', 'clash', 'horn', 'trombone', 'tuba', 'log_drum', 'woodblock'])), file=open(os.path.join(HERE, 'out', 'credits_instruments.txt'), 'w'))
