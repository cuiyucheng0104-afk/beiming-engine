"""节奏猜动物 · 配乐 + 拟音 + 玩具嗓 + 混音 → out/mix.wav
读 timeline.json（tools/export.mjs 从 timeline.mjs 导出）与 events.json（core/render/events.mjs 从页面导出）。
电子 funk，120 BPM，F 大调 → 「完美！」升 G 大调。乐器：MuldjordKit 鼓、VCSL 拍手/牛铃、FreePats 指弹贝斯、
VSCO 2 CE 小号/长号/圆号断奏 stab、VCSL 马林巴/钟琴、pluck.py 八音盒，numpy 合成锯齿铜管层、方波主旋律、三角波垫、底鼓次低频、
共振峰玩具嗓。确定性：固定随机种子。"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio import sfx as X
from core.audio.sfx import SR, add, lp, hp, bp, noise, norm, env_exp, t_

S.seed(7); rng = np.random.default_rng(11)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
EV, DUR = EVJ['ev'], EVJ['dur']
BEAT, K = TL['BEAT'], TL['K']
bt = lambda b: b * BEAT
N = int((DUR + 1.5) * SR)
MUS = np.zeros((N, 2), np.float32)   # 音乐总线（会被拟音/人声压低）
FX = np.zeros((N, 2), np.float32)    # 拟音 + 人声总线
AMB = np.zeros((N, 2), np.float32)   # 环境底
CUE = []                              # 每个放下的声音：拍点核对用

def lead(x):
    """一个声音从开头到主瞬态（2 ms 包络第一次到达前 200 ms 峰值的 −10 dB）的时间；采样乐器的起音、扫弦、软起音都算进去"""
    a = np.abs(x if x.ndim == 1 else x.mean(1)); n = int(.2 * SR)
    if len(a) < 64 or a[:n].max() <= 0: return 0.0
    h = int(.002 * SR); e = np.sqrt(np.convolve(a ** 2, np.ones(h) / h, 'same'))
    return min(.06, int(np.argmax(e[:n] > e[:n].max() * .316)) / SR)
def put(bus, x, t, g=1.0, pan=0.0, tag=None, align=True):
    """align=True：把主瞬态（不是文件开头）对到 t 上。铺底、上冲、预卷的嗖声、人声辅音这些按设计提前/渐入的传 align=False"""
    x = np.asarray(x, np.float32)
    add(bus, x, t - (lead(x) if align else 0.0), g, pan)
    if tag: CUE.append({'t': round(t, 6), 'tag': tag, 'bus': 'mus' if bus is MUS else 'fx' if bus is FX else 'amb'})

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)

# ———————————————— 合成乐器（numpy） ————————————————
def kick_sub(g=1.0):
    d = .32; tt = t_(d); f = 46 + 95 * np.exp(-tt * 30)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9)
    return np.tanh(s * 1.8) * g
def saw_stab(ms, dur=.18, cutoff0=5200):
    n = int((dur + .12) * SR); tt = np.arange(n) / SR; out = np.zeros(n)
    for m in ms:
        for det in (-.09, .0, .09):
            f = mtof(m) * 2 ** (det / 12); out += 2 * ((tt * f + rng.random()) % 1) - 1
    out /= len(ms) * 3
    e = np.minimum(1, tt / .004) * np.where(tt < dur, 1, np.exp(-(tt - dur) / .04))
    # 闭合的滤波：分三段低通近似扫频
    a = lp(out, cutoff0); b = lp(out, cutoff0 * .35); w = np.exp(-tt / (dur * .5))
    return (a * w + b * (1 - w)) * e
def square_lead(m, dur):
    n = int((dur + .08) * SR); tt = np.arange(n) / SR
    vib = 1 + .006 * np.sin(2 * np.pi * 5.8 * tt) * np.minimum(1, tt / .15)
    ph = np.cumsum(mtof(m) * vib) / SR
    s = np.sign(np.sin(2 * np.pi * ph)) * .6 + np.sin(2 * np.pi * ph * 2) * .15
    s = lp(s, 3800)
    return s * np.minimum(1, tt / .006) * np.where(tt < dur, 1, np.exp(-(tt - dur) / .03))
def tri_pad(ms, dur):
    n = int(dur * SR); tt = np.arange(n) / SR; s = np.zeros(n)
    for m in ms:
        for det in (-.1, .1):
            s += 2 / np.pi * np.arcsin(np.sin(2 * np.pi * mtof(m) * 2 ** (det / 12) * tt))
    s = lp(s / (2 * len(ms)), 2400)
    return s * np.minimum(1, tt / .06) * np.clip((dur - tt) / .12, 0, 1)
def slap_click(m):
    d = .06; tt = t_(d)
    return (np.sin(2 * np.pi * mtof(m + 24) * tt) * .5 + hp(noise(d), 2500) * .4) * env_exp(d, .008)
def riser(d, f0=300, f1=2400):
    tt = t_(d); f = f0 * (f1 / f0) ** (tt / d)
    s = (2 * ((np.cumsum(f) / SR) % 1) - 1) * .5 + bp(noise(d), 1500, 6000) * .5
    return lp(s, 6000) * (tt / d) ** 2

# ———————————————— 玩具嗓（共振峰合成，按普通话声调画音高） ————————————————
V = {'a': (800, 1250, 2600), 'o': (520, 880, 2450), 'u': (340, 760, 2300), 'i': (290, 2250, 3000),
     'e': (460, 1850, 2600), 'n': (260, 1500, 2500), 'm': (250, 1000, 2300)}
TONE = {1: [(0, 1.5), (1, 1.0)], 2: [(0, -3), (1, 3)], 3: [(0, -2), (.5, -5), (1, -1)], 4: [(0, 4), (1, -5)]}
def syl(cons, vowels, tone, dur, f0=360, fs=1.25, gain=1.0):
    """返回 (mono, 辅音长度)。vowels = [(相对时间 0..1, 元音名)]"""
    cd = {'m': .025, 'g': .025, 'z': .03, 'sh': .03, 'w': .025, None: 0}[cons]
    nv = int(dur * SR); tt = np.arange(nv) / SR; u = tt / dur
    tk = np.array([k for k, _ in TONE[tone]]); tv = np.array([v for _, v in TONE[tone]])
    f0t = f0 * 2 ** (np.interp(u, tk, tv) / 12) * (1 + .012 * np.sin(2 * np.pi * 6 * tt))
    vk = np.array([k for k, _ in vowels])
    F = [np.interp(u, vk, [V[v][j] * fs for _, v in vowels]) for j in range(3)]
    ph = 2 * np.pi * np.cumsum(f0t) / SR; out = np.zeros(nv)
    for h in range(1, 28):
        fh = h * f0t; amp = np.zeros(nv)
        for j, (Fj, Bj, Gj) in enumerate(zip(F, (110, 160, 240), (1.0, .7, .35))):
            amp += Gj / np.sqrt(1 + ((fh - Fj) / (Bj / 2)) ** 2)
        amp *= (fh < 9000) / h ** .55
        out += amp * np.sin(h * ph)
    e = np.minimum(1, tt / .012) * np.clip((dur - tt) / .06, 0, 1)
    out = out * e
    nc = int(cd * SR)
    if cons in ('z', 'sh'):
        c = bp(noise(cd + .02), *(3800, 9000) if cons == 'z' else (2200, 6500)) * np.sin(np.pi * np.arange(int((cd + .02) * SR)) / ((cd + .02) * SR)) * .55
    elif cons == 'g':
        c = bp(noise(cd), 900, 3000) * env_exp(cd, .006) * .8
    elif cons in ('m', 'w'):
        ct = np.arange(nc) / SR; c = np.sin(2 * np.pi * f0 * .9 * ct) * .35 * np.minimum(1, ct / .01)
    else:
        c = np.zeros(0)
    full = np.zeros(nc + nv + int(.02 * SR)); full[:len(c)] += c[:len(full)]; full[nc:nc + nv] += out / (np.abs(out).max() + 1e-9)
    return np.tanh(full * 1.4) * gain, cd
WORDS = {
    'mao': [('m', [(0, 'a'), (.55, 'o'), (1, 'u')], 1, .30)],
    'gou': [('g', [(0, 'o'), (.6, 'o'), (1, 'u')], 3, .30)],
    'ya': [(None, [(0, 'i'), (.3, 'a'), (1, 'a')], 1, .22)],
    'zui': [('z', [(0, 'u'), (.4, 'e'), (1, 'i')], 3, .22)],
    'shou': [('sh', [(0, 'o'), (.6, 'o'), (1, 'u')], 4, .42)],
    'wan': [('w', [(0, 'u'), (.25, 'a'), (.8, 'a'), (1, 'n')], 2, .24)],
    'mei': [('m', [(0, 'e'), (.6, 'e'), (1, 'i')], 3, .34)],
    'ye': [(None, [(0, 'i'), (.3, 'e'), (1, 'e')], 1, .40)],
}
def say(word, beat_t, f0=360, fs=1.25, g=1.0, pan=0.0, bus=None, tag=None):
    """元音落在拍上，辅音提前"""
    for cons, vw, tone, dur in WORDS[word]:
        x, cd = syl(cons, vw, tone, dur, f0, fs)
        put(bus if bus is not None else FX, x, beat_t - cd, g, pan, tag, align=False)
def crowd(word, t, g=.6, n=6):
    for k in range(n):
        f0 = [210, 260, 300, 345, 400, 450][k % 6] * (1 + .03 * rng.standard_normal())
        say(word, t + .004 * k, f0=f0, fs=1.0 + .06 * k, g=g / n * 2.2, pan=-.6 + 1.2 * k / (n - 1))

# ———————————————— 拟音 ————————————————
def boing(f0=260, f1=520, d=.3):
    tt = t_(d); f = f0 + (f1 - f0) * (1 - np.exp(-tt * 18)); f = f * (1 + .08 * np.sin(2 * np.pi * 22 * tt) * np.exp(-tt * 6))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .09)
def plop():
    d = .16; tt = t_(d); f = 420 * np.exp(-tt * 14) + 90
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .045) + lp(noise(d), 600) * env_exp(d, .01) * .4
def stamp(big=False):
    d = .7 if big else .35; tt = t_(d); f = 40 + 100 * np.exp(-tt * 18)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .12 if big else .06)
    clk = lp(noise(d), 3500) * env_exp(d, .012)
    return np.tanh((boom * 1.3 + clk) * 1.6)
def fwip():
    d = .16; tt = t_(d); return bp(noise(d), 3000, 11000) * np.minimum(1, tt / .006) * np.exp(-tt / .05)   # 白闪的「咻」：快起音，主瞬态在切点上
def rattle():
    d = .28; out = np.zeros(int(d * SR))
    for k in range(7):
        c = X.clack(.7 + .5 * rng.random(), .5 + .5 * rng.random()) * .72 ** k; s = int((k / 7) * .06 * SR + rng.random() * 120); out[s:s + len(c)] += c[:len(out) - s]
    return norm(out) + lp(noise(d), 300) * env_exp(d, .05) * .3
def servo(d=.38):
    tt = t_(d); f = 220 + 600 * (tt / d)
    s = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * .3 + np.sin(2 * np.pi * np.cumsum(f * 2) / SR) * .2
    return lp(s, 1800) * np.sin(np.pi * tt / d)
def plink(f=2600):
    d = .25; tt = t_(d); return np.sin(2 * np.pi * f * tt) * env_exp(d, .05) + np.sin(2 * np.pi * f * 2.7 * tt) * env_exp(d, .02) * .3
def crinkle(d=1.2):
    n = int(d * SR); x = np.zeros(n); idx = rng.integers(0, n, 900); x[idx] = rng.standard_normal(900)
    return bp(x, 2500, 9000) * np.exp(-np.arange(n) / SR / .5) * 3
def keyclick():
    c = X.click(1.3 + .2 * rng.random(), 1.0) * .7; d = len(c) / SR
    return c + lp(noise(d), 900)[:len(c)] * env_exp(d, .004)[:len(c)] * .4

# ———————————————— 配乐 ————————————————
CH = {'F': (29, [65, 69, 72]), 'Bb': (34, [65, 70, 74]), 'Gm7': (31, [62, 65, 67, 70]), 'C7': (36, [64, 67, 70, 72]),
      'Dm': (38, [62, 65, 69]), 'G': (31, [67, 71, 74]), 'C': (36, [64, 67, 72]), 'D7': (38, [66, 69, 72])}
def chord_at(beat):
    bar = int(beat // 4); a = TL['ARR'][min(bar, len(TL['ARR']) - 1)]
    if not a['chord']: return None
    cs = a['chord']; return cs[min(int((beat % 4) * len(cs) / 4), len(cs) - 1)]
def drum(v, vel, t, g=1.0, pan=0.0, tag='drum'):
    put(MUS, S.hit('drum_kit', v, vel), t, g, pan, tag)
def brass(ms, t, vel=.8, dur=.16, g=1.0, tag='brass'):
    for m in ms:
        if m >= 58: put(MUS, S.note('trumpet_stac', m, dur, vel), t, g * .55, .25)
        if m - 12 >= 41: put(MUS, S.note('trombone_stac', m - 12, dur, vel), t, g * .45, -.25)
    put(MUS, saw_stab(ms, dur), t, g * .35, 0, tag)
BASS_FUNK = [(0, 0, .2, 1), (3, 12, .1, .7), (4, 0, .12, .8), (6, 0, .1, .7), (8, 10, .15, .85), (10, 0, .1, .8), (11, 12, .1, .7), (14, 7, .2, .85)]
BASS_8 = [(i * 2, (0, 0, 12, 0, 7, 0, 12, 10)[i], .14, .9 if i % 2 == 0 else .75) for i in range(8)]
def bass_bar(bar0, pat, shift=0):
    for s16, iv, d, v in pat:
        beat = bar0 * 4 + s16 / 4; c = chord_at(beat)
        if c is None: continue
        root = CH[c][0] + shift; m = root + iv
        while m > 41: m -= 12
        put(MUS, S.note('electric_bass', m, d * 2, v), bt(beat), .9, 0, 'bass')
        put(MUS, slap_click(m) * .25 + 0, bt(beat), .6 * v)
        put(MUS, np.tanh(np.sin(2 * np.pi * mtof(m) * t_(d * 2)) * 2) * env_exp(d * 2, d), bt(beat), .25)   # 2/3 次谐波让小音箱也听得到
def groove_bar(bar, hats=8, clap=True, kick=True, open_hat=True, g=1.0, chank=True, pad=True):
    b0 = bar * 4
    for i in range(4):
        if kick: drum('kick_drum_left', .85, bt(b0 + i), g); put(MUS, kick_sub(), bt(b0 + i), .32 * g)
        if clap and i in (1, 3): put(MUS, S.hit('claps', 'group', .8), bt(b0 + i), .55 * g, .1, 'clap'); drum('snare_1', .6, bt(b0 + i), .35 * g)
    for k in range(hats):
        tb = b0 + k * 4 / hats
        if open_hat and abs(tb - (b0 + 3.5)) < 1e-6: drum('hi_hat_open', .6, bt(tb), .35 * g, .3)
        else: drum('hi_hat_closed', .5 + .3 * ((k % 2) == 1), bt(tb), .32 * g, .3)
    c = chord_at(b0)
    if chank and c:
        for s16 in (2, 6, 7, 10, 14):
            tones = [m for m in CH[chord_at(b0 + s16 / 4)][1]]
            x = S.chord('electric_guitar', [m - 12 for m in tones], .07, .6, strum=.006)
            put(MUS, hp(x, 500), bt(b0 + s16 / 4), .28 * g, -.35)
    if pad and c:
        cs = TL['ARR'][bar]['chord']; seglen = 4 / len(cs)
        for j, cc in enumerate(cs):
            put(MUS, tri_pad([m - 12 if m - 12 >= 53 else m for m in CH[cc][1]], bt(seglen)), bt(b0 + j * seglen), .16 * g, 0, align=False)

arr = {a['bar']: a['mode'] for a in TL['ARR']}
for bar, mode in arr.items():
    b0 = bar * 4
    if mode == 'jingle':
        brass([65], 0.0, .7, .1); brass([69], bt(.5), .7, .1)   # 号角上行
        put(MUS, S.hit('crash', None, .8), bt(1), .5, .2, 'crash'); drum('kick_drum_left', .9, bt(1)); put(MUS, kick_sub(), bt(1), .6)
        brass(CH['F'][1], bt(1), .85, .2, tag='brass')
        put(MUS, S.hit('snare', 'roll', .55, .5), bt(3.5), .45, 0, 'roll')
        put(MUS, tri_pad([60, 65, 69], bt(3.5)), 0, .12, align=False)
    elif mode in ('groove', 'report'):
        groove_bar(bar); bass_bar(bar, BASS_FUNK, 0)
    elif mode == 'groove8':
        groove_bar(bar, hats=16, open_hat=False); bass_bar(bar, BASS_8, 0)
        for s in (7, 15): put(MUS, S.hit('claps', 'group', .6), bt(b0 + s / 4), .3, -.1)
    elif mode == 'tease':
        for i in range(4): drum('kick_drum_left', .8, bt(b0 + i)); put(MUS, kick_sub(), bt(b0 + i), .5)
        roll = S.hit('snare', 'roll', .7, 2.0); roll = roll * np.linspace(.25, 1.0, len(roll)) ** 1.5
        put(MUS, roll, bt(b0), .7, 0, 'roll')
        put(MUS, riser(bt(4)), bt(b0), .18, align=False)
        put(MUS, tri_pad([62, 65, 69], bt(4)), bt(b0), .12, align=False)
    elif mode == 'finale':
        put(MUS, S.hit('crash', None, .95), bt(b0), .6, -.2, 'crash'); drum('crash_right', .9, bt(b0), .4, .3)
        groove_bar(bar, hats=16); bass_bar(bar, BASS_FUNK, 0)
    elif mode == 'end':
        tg = b0
        put(MUS, S.hit('crash', None, .9), bt(tg), .55, .2, 'crash'); drum('kick_drum_left', .9, bt(tg)); put(MUS, kick_sub(), bt(tg), .6)
        brass(CH['G'][1], bt(tg), .9, .25)
        for i in (1, 2, 3): drum('kick_drum_left', .7, bt(tg + i)); drum('hi_hat_closed', .5, bt(tg + i), .3, .3)
        for i in (1, 3): put(MUS, S.hit('claps', 'group', .7), bt(tg + i), .5, .1)
        brass([71, 74, 79], bt(tg + 1), .7, .1); brass([72, 76, 79], bt(tg + 1.5), .7, .1)
        put(MUS, tri_pad([59, 62, 67], bt(2)), bt(tg), .14, align=False)
        # button：19.0 最后一记 + 余音
        tb = bt(K['button']); drum('kick_drum_left', 1.0, tb); put(MUS, kick_sub(), tb, .7)
        put(MUS, S.hit('crash', None, 1.0), tb, .6, -.2, 'crash')
        brass([67, 71, 74, 79], tb, 1.0, .5, 1.2, tag='button')
        put(MUS, S.note('electric_bass', 31, .8, .9), tb, .9); put(MUS, tri_pad([55, 59, 62, 67], 1.6), tb, .2, align=False)
        put(MUS, S.note('glockenspiel', 91, 1.2, .6), tb, .3, .3)

# 和声与旋律上的事件钩子
# 回合卡盖章：铜管上行 A C F
for e in EV:
    if e['type'] == 'stamp' and e['beat'] < 4: brass([e['m'] - 12, e['m'] - 5, e['m']] if e['m'] < 75 else [65, 69, 77], e['t'], .85, .14, .9)
# 应答：铜管回答（八分段变轻）
for e in EV:
    if e['type'] == 'resp':
        c = chord_at(e['beat']); fast = e['beat'] >= 16
        brass(CH[c][1], e['t'], .7 if fast else .85, .1 if fast else .16, .6 if fast else .85, tag='brass')
    if e['type'] == 'call': put(MUS, S.hit('cowbell', None, .75), e['t'], .5, -.4, 'cowbell')
# 下一关：铜管半音爬升，钉在礼盒摇晃上
for e, top in zip([x for x in EV if x['type'] == 'rattle'], (72, 73, 74, 75)):
    brass([top - 7, top - 3, top], e['t'], .8, .12, .9)
# 开锁：D7 一记短 stab，然后音乐全停
tu = bt(K['unlock']); brass(CH['D7'][1], tu, .9, .12, 1.0, tag='brass'); drum('kick_drum_left', .9, tu); put(MUS, kick_sub(), tu, .6)
# 13.5 起军鼓十六分加花 + 上冲
for i, b in enumerate((27, 27.25, 27.5, 27.75)): drum('snare_1', .55 + .12 * i, bt(b), .6 + .1 * i, 0, 'fill')
put(MUS, riser(.5, 400, 3000), bt(27), .25, align=False)
# 完美！：G 大调全体铜管 + 方波主旋律
tp = bt(K['perfect']); brass([67, 71, 74, 79], tp, 1.0, .3, 1.2, tag='brass')
LEAD = [(28.5, 74, .5), (29, 79, .5), (29.5, 78, .25), (29.75, 79, .25), (30, 83, .5), (30.5, 81, .5), (31, 79, .75), (31.75, 74, .25),
        (33, 76, .5), (33.5, 79, .5), (34, 81, .5), (34.5, 79, .25), (34.75, 76, .25), (35, 74, .75)]
for b, m, d in LEAD: put(MUS, square_lead(m, bt(d) * .9), bt(b), .2 if b < 32 else .13, .15, 'lead')
for b in (29.5, 30.5, 31.5): brass([71, 74, 79], bt(b), .65, .08, .5)
# 成绩单前一拍加花 + 满分印章的铜管
for b in (35.5, 35.75): drum('snare_1', .7, bt(b), .6, 0, 'fill')
# 静默：开锁 stab 之后一切音乐收掉（12.25 起到 13.0），只留房间底噪
s0, s1 = int(TL['SILENCE'][0] * SR), int(TL['SILENCE'][1] * SR)
fade = int(.06 * SR); MUS[s0:s0 + fade] *= np.linspace(1, 0, fade)[:, None]; MUS[s0 + fade:s1] = 0

# ———————————————— 拟音（从 events.json 驱动） ————————————————
marimba = lambda m, v=.7: S.note('marimba', m, .3, v)
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'whoosh': put(FX, X.whoosh(.3, 1.0), t - .22, .35 * e.get('g', .5), 0, None, align=False); CUE.append({'t': t, 'tag': 'whoosh', 'bus': 'fx'})
    elif ty == 'land':
        if e.get('soft'): put(FX, boing(300, 600, .2), t, .18, .2, 'land'); continue
        put(FX, plop(), t, .7, 0, 'land'); put(FX, boing(240, 500, .32), t, .28, .1)
        if e.get('big'): put(FX, stamp(), t, .5)
    elif ty == 'pip': put(FX, marimba(e['m'], .75), t, .5, .2, 'pip'); put(FX, X.pop(.5), t, .12)
    elif ty == 'stamp': put(FX, stamp(), t, .55, 0, 'stamp'); put(FX, marimba(e['m'], .8), t, .25)
    elif ty == 'clap': put(FX, S.hit('claps', 'solo', .9), t, .5, .3, 'clap')
    elif ty == 'flash': put(FX, fwip(), t, .45, 0, 'flash'); put(MUS, S.hit('crash', None, .7), t, .38, .3, 'crash')
    elif ty == 'call': put(FX, X.pop(.9), t, .4, -.2, 'call')
    elif ty == 'resp':
        say({'cat': 'mao', 'dog': 'gou'}[e['a']], t, f0=380 if e['beat'] < 16 else 400, g=.6, pan=.35, tag='voice')
        put(FX, P.pluck('music_box', 84 if e['a'] == 'cat' else 86, .6, .7), t, .25, -.2)
    elif ty == 'star': put(FX, S.note('glockenspiel', [79, 81, 83, 84, 86, 88, 90, 91][e['i']], .4, .55), t + .0, .14, .5, 'star')
    elif ty == 'rattle': put(FX, rattle(), t, .55, -.15, 'rattle')
    elif ty == 'lock': put(FX, X.click(.8, 1.0), t, .6, .1, 'lock'); put(FX, boing(500, 900, .2), t, .2, .1)
    elif ty == 'lid': put(FX, X.pop(1.0), t, .5, -.3, 'lid'); put(FX, X.whoosh(.3, 1), t, .25, -.4)
    elif ty == 'servo': put(FX, servo(), t + .02, .07, -.1, 'servo', align=False)
    elif ty == 'sweat': put(FX, plink(2700), t, .06, .4, 'sweat')
    elif ty == 'shout':
        for w, b in zip(('ya', 'zui', 'shou'), K['shout']): say(w, bt(b), f0=420, fs=1.28, g=1.1, pan=.3, tag='voice')
    elif ty == 'reveal': put(FX, S.note('glockenspiel', 84, .6, .5), t + .25, .1, -.3)
    elif ty == 'judge':
        put(FX, stamp(True), t, .8, 0, 'judge'); crowd('wan', t, .7); crowd('mei', t + bt(.5), .7)
    elif ty == 'confetti': put(FX, crinkle(1.4), t, .18, 0, 'confetti', align=False)
    elif ty == 'type': put(FX, keyclick(), t, .45, -.2, 'type')
    elif ty == 'check': put(FX, stamp(), t, .45, 0, 'check'); put(FX, P.pluck('music_box', [84, 88, 91][e['i']], .8, .75), t, .3, .2)
    elif ty == 'grade': put(FX, stamp(True), t, .85, .1, 'grade')
    elif ty == 'yay': crowd('ye', t, .65)
    elif ty == 'button': put(FX, fwip(), t, .3, 0, 'button')
    elif ty == 'squish':
        sq = crinkle(.3) * .6; sq[:int(.25 * SR)] += boing(320, 140, .25)[:int(.25 * SR)] * .5; put(FX, sq, t, .3, -.25, 'squish')
    elif ty == 'fillhit': CUE.append({'t': t, 'tag': 'fillhit', 'bus': 'mus'})

# ———————————————— 环境底：演播室底噪 + 观众底（静默里只剩底噪） ————————————————
n = N; room = lp(noise(n / SR), 900) * .004
AMB[:, 0] += room; AMB[:, 1] += np.roll(room, 997)
mur = np.zeros(n)
for k in range(6):
    am = 0.5 + 0.5 * np.sin(2 * np.pi * (2.5 + k * .7) * np.arange(n) / SR + k)
    mur += bp(noise(n / SR), 300 + k * 180, 700 + k * 260) * am
mur = mur / np.abs(mur).max() * .03
tt = np.arange(n) / SR
crowd_env = np.interp(tt, [0, 4, 4.3, 12.0, 12.25, 13.0, 14.0, 14.6, 19.0, 19.75], [0, 0, .5, .5, 0, 0, 0, 1.0, .7, .5])
AMB[:, 0] += mur * crowd_env; AMB[:, 1] += np.roll(mur, 1501) * crowd_env

# ———————————————— 混音 ————————————————
MUS = S.room(MUS, size=.3, mix=.12)
FXr = S.room(FX, size=.25, mix=.08)
envl = np.abs(FXr).max(axis=1)
from scipy.ndimage import maximum_filter1d, uniform_filter1d
envl = uniform_filter1d(maximum_filter1d(envl, int(.03 * SR)), int(.08 * SR))
duck = 1 - .35 * np.clip(envl / .5, 0, 1)
mix = MUS * duck[:, None] * 1.25 + FXr * 1.0 + AMB
# 低频控制：20–120 Hz 稍压
from scipy.signal import butter, sosfiltfilt
_sos = butter(2, 120, 'low', fs=SR, output='sos')
LOWCUT = float(os.environ.get('LOWCUT', .5))   # 零相位低架：120 Hz 以下 ×(1−LOWCUT)
for ch in (0, 1): mix[:, ch] -= sosfiltfilt(_sos, mix[:, ch]) * LOWCUT
mix = np.stack([hp(mix[:, 0], 38), hp(mix[:, 1], 38)], 1)
pk = np.abs(mix).max(); mix = mix / pk * 1.3; mix = np.tanh(mix) * .9   # 软削波
mix = mix[:int(DUR * SR)]
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
json.dump(sorted(CUE, key=lambda c: c['t']), open(os.path.join(HERE, 'out', 'music_cues.json'), 'w'), indent=0)
# 频段能量自检
F = np.abs(np.fft.rfft(mix[:, 0])); fr = np.fft.rfftfreq(len(mix), 1 / SR)
lo = 10 * np.log10((F[(fr > 20) & (fr < 120)] ** 2).sum()); mid = 10 * np.log10((F[(fr > 120) & (fr < 4000)] ** 2).sum())
print(f'mix.wav {len(mix) / SR:.2f}s  peak {np.abs(mix).max():.3f}  low-vs-mid {lo - mid:+.1f} dB  cues {len(CUE)}')
sil = mix[s0 + int(.05 * SR):s1 - int(.03 * SR)]
print(f'silence window rms {20 * np.log10(np.sqrt((sil ** 2).mean()) + 1e-12):.1f} dBFS (whole mix {20 * np.log10(np.sqrt((mix ** 2).mean())):.1f})')
