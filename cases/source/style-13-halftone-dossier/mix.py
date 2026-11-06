"""配乐 + 拟音 + 环境 → out/mix.wav（以及 out/stem_*.wav 供拍点核对）
noir：拨弦低音行走 + 刷子 + 响指 + 颤音琴（真实采样），马林巴式拨音 / 合成底鼓·拍手·踩镲 / 方波低音 / 八音盒（合成与物理建模）
所有音符位置都从 timeline.json 的段落网格算出；拟音全部由 events.json（window.EV）驱动。"""
import os, sys, json, subprocess
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, bp, lp, hp, t_, env_exp, norm, whoosh as _whoosh

rng = np.random.default_rng(13); S.seed(13)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
DUR = TL['dur']; SEC = {s['id']: s for s in TL['secs']}; T = TL['t']
def B(sec, beat): s = SEC[sec]; return s['t0'] + beat * 60 / s['bpm']
N = int(DUR * SR) + SR
mus, perc, fx, amb = (np.zeros((N, 2), np.float32) for _ in range(4))
def noise(d): return rng.standard_normal(int(round(d * SR)))
def fade_tail(x, d=.006): n = min(len(x), int(d * SR)); x = x.copy(); x[-n:] *= np.linspace(1, 0, n); return x

# ———————————— 合成乐器（风格声音调色板）————————————
def brush_sweep(d, v=1.0):
    tt = t_(d); n = noise(d)
    x = bp(n, 1800, 9000) * (.55 + .45 * np.sin(np.pi * tt / d)) * (.7 + .3 * np.sin(2 * np.pi * tt / d * 2))
    a = np.minimum(1, tt / .05) * np.minimum(1, (d - tt) / .08)
    return (x * a * .22 * v).astype(np.float32)
def brush_tap(v=1.0):
    d = .16; tt = t_(d)
    x = bp(noise(d), 1500, 8000) * env_exp(d, .035) + np.sin(2 * np.pi * 210 * tt) * env_exp(d, .02) * .25
    return norm(x) * v
def snap(v=1.0):
    d = .12; tt = t_(d)
    x = hp(noise(d), 2500) * env_exp(d, .006) + np.sin(2 * np.pi * 2300 * tt) * env_exp(d, .012) * .5 + bp(noise(d), 600, 1500) * env_exp(d, .01) * .4
    return norm(x) * v
def mpluck(f, d=.7, v=1.0):   # 马林巴式拨音：基频 + 约 4× 泛音
    tt = t_(d); x = np.sin(2 * np.pi * f * tt) * env_exp(d, .28) + .45 * np.sin(2 * np.pi * f * 3.99 * tt) * env_exp(d, .05)
    x[:96] *= np.linspace(0, 1, 96); return norm(x) * v
def kick(v=1.0):
    d = .32; tt = t_(d); f = 46 + 110 * np.exp(-tt / .035)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .11) + hp(noise(d), 3000) * env_exp(d, .002) * .3
    return norm(x) * v
def clap(v=1.0):
    d = .22; x = np.zeros(int(d * SR))
    for k, o in enumerate([0, .011, .022]):
        s = int(o * SR); b = bp(noise(d - o), 900, 5000) * env_exp(d - o, .008 if k < 2 else .06); x[s:s + len(b)] += b
    return norm(x) * v
def hat(v=1.0, open_=False):
    d = .25 if open_ else .06; return norm(hp(noise(d), 7000) * env_exp(d, .09 if open_ else .014)) * v
def sqbass(midi, d, v=1.0):   # 方波感低音，带 2/3 次谐波，小喇叭也听得见
    f = 440 * 2 ** ((midi - 69) / 12); tt = t_(d)
    x = sum(np.sin(2 * np.pi * f * k * tt) / k for k in (1, 3, 5, 7)) * .8 + .3 * np.sin(2 * np.pi * f * 2 * tt)
    e = np.minimum(1, tt / .004) * env_exp(d, d * .7); e[-240:] *= np.linspace(1, 0, 240)
    return (lp(x, 1400) * e * v * .5).astype(np.float32)
def tri_pad(midis, d, v=1.0):
    tt = t_(d); x = sum(2 / np.pi * np.arcsin(np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * tt)) for m in midis)
    e = np.minimum(1, tt / (d * .8)) ** 2; e[-int(.01 * SR):] *= np.linspace(1, 0, int(.01 * SR))
    return (lp(x, 1800) * e * v * .2).astype(np.float32)
M = S.midi

# ———————————— 配乐 ————————————
def note(inst, pitch, t, d, v, pan=0, g=1.0, buf=None, **kw):
    x = S.note(inst, pitch, d, vel=v, **kw); add(mus if buf is None else buf, x, t, g, pan)

# S1 封面（弱起半拍）+ S2 证物（3/4）+ S5 嫌犯照：拨弦低音行走
walk = [('cover', 0, 'A1', .45)] + [('cover', .5 + i, p, .9) for i, p in enumerate(['D2', 'F2', 'A2', 'Eb2'])]
walk += [('exhibits', i, p, .9) for i, p in enumerate(['D2', 'F2', 'F#2', 'G2', 'Bb1', 'G#1', 'A1', 'C#2', 'Eb2'])]
walk += [('mug', i, p, .9) for i, p in enumerate(['D2', 'C2', 'B1', 'Bb1'])]
for sec, b, p, dd in walk:
    bl = 60 / SEC[sec]['bpm']; note('jazz_bass', p, B(sec, b), bl * dd, .82 if b % 1 == 0 else .7, -.05, .95)
note('jazz_bass', 'D1', T['flash1'], .6, .9, 0, .9)
# 刷子：每拍一扫 + 2/4 拍（华尔兹为 2/3 拍）点击；响指
def groove(sec, b0, b1, taps, snaps, v=1.0):
    bl = 60 / SEC[sec]['bpm']; b = b0
    while b < b1 - 1e-6:
        add(perc, brush_sweep(bl * .98, v), B(sec, b), 1, .25)
        if any(abs((b - b0) % m - r) < 1e-6 for m, r in taps): add(perc, brush_tap(.55 * v), B(sec, b), .55, -.2)
        if any(abs((b - b0) % m - r) < 1e-6 for m, r in snaps): add(perc, snap(.7 * v), B(sec, b), .5, .45)
        b += 1
groove('cover', .5, 4.5, [(2, 1)], [(2, 1)])
groove('exhibits', 0, 9, [(3, 1), (3, 2)], [(3, 1), (3, 2)])
groove('mug', 0, 4, [(2, 1)], [(2, 1)])
# 颤音琴动机：半音邻音（A–B♭–A），开头与嫌犯照呼应
for sec, b0 in [('cover', 2.5), ('mug', 2)]:
    for k, (p, dd) in enumerate([('A4', .5), ('Bb4', .5), ('A4', 1.4)]):
        note('vibraphone', p, B(sec, b0 + k * .5), dd * 60 / SEC[sec]['bpm'] * (2.2 if k == 2 else 1), .62, .3, .9, buf=None)
# 证物钉上时的颤音琴和弦（逐件升高）+ 马林巴式应答
for k, (top, low) in enumerate([('D5', ['F4', 'A4']), ('F5', ['A4', 'C5']), ('A5', ['C#5', 'E5'])]):
    t0 = T['pin%d' % (k + 1)]
    for i, p in enumerate([top] + low): note('vibraphone', p, t0 + i * .012, 1.1, .7 - .1 * i, .3 - .15 * i, .85)
    for j, p in enumerate([['A4', 'G4'], ['Bb4', 'A4'], ['C#5', 'E5']][k]):
        add(mus, mpluck(440 * 2 ** ((M(p) - 69) / 12), .6, .9), B('exhibits', 3 * k + 2 + .5 * j), .32, -.35)
# 拉远前的军鼓装饰音（16 分）
for b in (8.5, 8.75): add(perc, S.hit('snare2', 'on', .45), B('exhibits', b), .4, -.1)

# S3 证物板 120 BPM：合成底鼓 + 拍手 + 三连音摇摆踩镲 + 方波低音
for b in range(8):
    add(perc, kick(), B('board', b), .5)
    if b % 2: add(perc, clap(), B('board', b), .32, .15)
    subs = [0, 2 / 3] if b < 4 else [0, 1 / 3, 2 / 3]
    for s_ in subs: add(perc, hat(.8 if s_ else 1, open_=(b == 7 and s_ == 2 / 3)), B('board', b + s_), .16 + .05 * (b >= 4), .5)
bline = ['D2', 'D3', 'D2', 'D3', 'D2', 'C3', 'D2', 'A2', 'D2', 'Eb2', 'E2', 'F2', 'F#2', 'G2', 'G#2', 'A2']
for i, p in enumerate(bline):
    b = i // 2 + (2 / 3 if i % 2 else 0); add(mus, sqbass(M(p), (2 / 3 if not i % 2 else 1 / 3) * .5 * .95, .9), B('board', b), .4)
# 颤音琴弓奏长音（张力），11.0 → 13.0 渐强
for i, p in enumerate(['D4', 'F4', 'A4', 'C#5']):
    x = S.note('vibraphone_bowed', p, 2.0, vel=.7, attack=1.6); x = x[:int(2.0 * SR)]; x *= np.linspace(.3, 1, len(x)) ** 1.5
    add(mus, x, B('board', 4), .55, -.3 + .2 * i)
add(mus, tri_pad([M('D3'), M('A3')], 2.0, 1), B('board', 4), .45)
# 军鼓滚奏 + 上扬扫频
roll = S.hit('snare', 'roll', .8, dur=1.0); roll = roll[:int(SR * 1.0)] * np.linspace(.15, 1, min(len(roll), SR)) ** 2
add(perc, roll, B('board', 6), .55, -.1)
d = 2.0; tt = t_(d); f = 220 * 2 ** (tt / d * 3.2); sw = np.sin(2 * np.pi * np.cumsum(f) / SR) * (tt / d) ** 2 * .22
add(mus, sw.astype(np.float32), B('board', 4), .5)

# 13.0：硬切（音乐与鼓的尾巴都截掉，形成真正的静默）；16.667：再次抽空
def gate(buf, a, b, ft=.012):
    i, j, n = int(a * SR), int(b * SR), int(ft * SR)
    buf[i:i + n] *= np.linspace(1, 0, n)[:, None]; buf[i + n:j] = 0
gate(mus, T['swallow'], T['flash1'] - .002); gate(perc, T['swallow'], T['flash1'] - .002)
gate(mus, T['cut'], T['stamp'] - .002, .03); gate(perc, T['cut'], T['stamp'] - .002, .03)

# S6 印章：最重一拍 + 收尾
st = T['stamp']
note('jazz_bass', 'D1', st, 1.2, 1.0, 0, 1.3); note('contrabass_pizz', 'D2', st, 1.0, .95, -.1, .8)
for i, p in enumerate(['F3', 'A3', 'C#4', 'E4']): note('vibraphone_hard', p, st + i * .006, 1.6, .85, -.2 + .15 * i, .7)
add(perc, S.hit('bass_drum', None, 1.0), st, 1.0)
note('jazz_bass', 'A1', B('mug', 6), .55, .8, 0, 1.0)
for k, p in enumerate(['D6', 'F6', 'A6', 'D7']):
    add(mus, P.pluck('music_box', p, 1.6, .75), B('mug', 6.5 + k * .25), .42, .35 - .2 * k)
fin = T['final']
note('jazz_bass', 'D2', fin, 1.0, .85, 0, 1.1)
for i, p in enumerate(['F4', 'A4', 'C#5', 'E5']): note('vibraphone', p, fin + i * .03, 1.0, .6, -.2 + .15 * i, .8)
add(perc, brush_sweep(.9, 1.2), fin, 1, .2); add(perc, brush_tap(.6), fin, .5)

# ———————————— 拟音（由 window.EV 驱动）————————————
def key_(i):
    d = .09; tt = t_(d); p = 1 + (rng.random() - .5) * .12
    x = hp(noise(d), 3000) * env_exp(d, .003) + np.sin(2 * np.pi * 175 * p * tt) * env_exp(d, .022) * .9 + bp(noise(d), 700, 2400) * env_exp(d, .012) * .7
    return norm(x)
def bell():
    d = 1.4; tt = t_(d); return norm(sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(2280, 1, .5), (5520, .45, .22), (8850, .2, .1), (3390, .2, .3)]))
def swish(d, lo=1500, hi=6000):
    tt = t_(d); return norm(bp(noise(d), lo, hi) * np.sin(np.pi * tt / d) ** 2)
def pin_():
    d = .14; tt = t_(d)
    x = np.sin(2 * np.pi * 820 * tt) * env_exp(d, .016) + hp(noise(d), 2500) * env_exp(d, .003) * .8 + np.sin(2 * np.pi * 110 * tt) * env_exp(d, .05) * .9 + bp(noise(d), 1200, 5000) * env_exp(d, .03) * .5
    return norm(x)
def pop_(f0):
    d = .14; tt = t_(d); f = f0 * (1 + 1.6 * tt / d); return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .035))
def squeak(d):
    tt = t_(d); f = 1500 + 700 * tt / d + 120 * np.sin(2 * np.pi * 38 * tt)
    return norm((np.sin(2 * np.pi * np.cumsum(f) / SR) * .6 + bp(noise(d), 2000, 5000) * .4) * np.minimum(1, tt / .02) * np.minimum(1, (d - tt) / .02))
def puff(d=.32):
    tt = t_(d); return norm(lp(noise(d), 2200) * np.exp(-tt / .07) * np.minimum(1, tt / .01) + bp(noise(d), 3000, 8000) * env_exp(d, .12) * .3)
def airy(d):
    tt = t_(d); return norm(hp(noise(d), 3500) * (.5 + .5 * np.sin(tt / d * 9 * np.pi) ** 2) * np.sin(np.pi * tt / d))
def tick(v=1):
    d = .05; tt = t_(d); return norm(hp(noise(d), 2000) * env_exp(d, .004) + np.sin(2 * np.pi * 1900 * tt) * env_exp(d, .008) * .4) * v
def riser(d):
    tt = t_(d); n = noise(d); out = np.zeros_like(n)
    for i in range(0, len(n), 480):
        hi_ = min(len(n), i + 480); f = 400 * 2 ** (3.3 * i / len(n)); out[i:hi_] = bp(n[max(0, i - 2000):hi_], f * .7, min(f * 1.4, 20000))[-(hi_ - i):]
    return norm(out * (tt / d) ** 1.5)
def zip_(d=.1):
    tt = t_(d); return norm(bp(noise(d), 2500, 9000) * (tt / d) ** 2)
def rattle(d):
    tt = t_(d); am = (rng.random(len(tt)) < .004).astype(float); am = np.convolve(am, np.exp(-np.arange(300) / 60), 'same')
    return norm(bp(noise(d), 900, 5000) * am * (tt / d) ** 1.5)
def thud(f=60, d=.25):
    tt = t_(d); return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .06) + lp(noise(d), 300) * env_exp(d, .015) * .4)
def charge(d):
    tt = t_(d); f = 1500 * 2 ** (2.2 * tt / d); x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .3 * np.sin(2 * np.pi * np.cumsum(f * 2.01) / SR)
    return (x * (tt / d) ** 2 * .3).astype(np.float32)
def shutter(big):
    d = .32; x = np.zeros(int(d * SR))
    for o, g in [(0, 1), (.038, .7)]:
        c = tick(g); s = int(o * SR); x[s:s + len(c)] += c
    m = bp(noise(.03), 800, 3000) * env_exp(.03, .01) * .5; x[int(.01 * SR):int(.01 * SR) + len(m)] += m
    if big: fl = hp(noise(.2), 5000) * env_exp(.2, .05) * .5 + np.sin(2 * np.pi * 3800 * t_(.2)) * env_exp(.2, .04) * .3; x[:len(fl)] += fl
    return norm(x)
def clack():
    d = .2; tt = t_(d)
    x = np.sin(2 * np.pi * 520 * tt) * env_exp(d, .03) + np.sin(2 * np.pi * 1340 * tt) * env_exp(d, .015) * .6 + hp(noise(d), 2000) * env_exp(d, .004) + thud(95, d) * .7
    return norm(x)
def stamp():
    d = 1.3; tt = t_(d); f = 38 + 62 * np.exp(-tt / .09)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .38)
    boom = boom + .35 * np.tanh(boom * 3)   # 2/3 次谐波，让低频在小喇叭上也"说话"
    click = hp(noise(d), 2500) * env_exp(d, .003) * 1.2 + np.sin(2 * np.pi * 3100 * tt) * env_exp(d, .006) * .4
    slap = bp(noise(d), 250, 2200) * env_exp(d, .05) * .9
    cr = (rng.random(len(tt)) < .0025) * rng.standard_normal(len(tt)) * 3 * np.exp(-tt / .3); crackle = hp(np.convolve(cr, np.exp(-np.arange(80) / 12), 'same'), 1500)
    rat = bp(noise(d), 600, 4000) * np.abs(np.sin(2 * np.pi * 31 * tt)) * env_exp(d, .18) * .35
    return norm(boom * 1.2 + click + slap + crackle * .5 + rat)
def squawk():
    out = np.zeros(int(.45 * SR))
    for k, (o, g, f0) in enumerate([(0, 1, 980), (.11, .7, 900), (.2, .55, 860)]):
        d = .085; tt = t_(d); ph = np.cumsum(f0 * (1 - .25 * tt / d)) / SR
        saw = 2 * (ph % 1) - 1; src = saw * .6 + noise(d) * .5
        v = bp(src, 1600, 4200, 3) + bp(src, 700, 1300) * .5
        v *= np.minimum(1, tt / .006) * np.exp(-tt / .04); s = int(o * SR); out[s:s + len(v)] += norm(v) * g
    return norm(np.tanh(out * 2))
def flutter(d):
    tt = t_(d); am = .5 + .5 * np.sin(2 * np.pi * (11 + 5 * np.sin(tt * 7)) * tt)
    return norm(bp(noise(d), 1200, 6000) * am * np.sin(np.pi * tt / d) ** .5)
def paperland():
    d = .2; tt = t_(d); return norm(bp(noise(d), 500, 4500) * env_exp(d, .03) + thud(140, d) * .3)
def ruffle(d=.35):
    tt = t_(d); return norm(bp(noise(d), 1500, 7000) * (.35 + .65 * np.abs(np.cos(2 * np.pi * 14 * tt)) ** 2) * np.minimum(1, tt / .003) * (1 - tt / d) ** 1.5)

TW = ['D4', 'F4', 'A4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5']
hits = [np.zeros((N, 2), np.float32) for _ in range(2)]   # 只放"拍点声音"的干声分轨（相邻拍点交替放两轨，互不遮挡），给 cuecheck 测起音
HORD = {h: i % 2 for i, h in enumerate(sorted({e['hit'] for e in EV if 'hit' in e}, key=lambda h: T[h]))}
CUR = {}
def A(buf, x, at, g=1.0, pan=0.0):
    add(buf, x, at, g, pan)
    if CUR.get('hit') and 'peak' not in CUR and abs(at - CUR['t']) < 1e-9: add(hits[HORD[CUR['hit']]], x, at, g, pan)
for e in EV:
    t, ty = e['t'], e['type']; CUR = e
    if ty == 'key': A(fx, key_(e['i']), t, .55, -.2 + .06 * e['i'])
    elif ty == 'bell': A(fx, bell(), t, .32, .4)
    elif ty == 'whoosh': A(fx, _whoosh(e['d']), t, .45 * e.get('g', 1), 0)
    elif ty == 'swish': A(fx, swish(e['d']), t, .25 * e.get('g', 1), .1)
    elif ty == 'pin': A(fx, pin_(), t, .62, -.25 + .25 * e['k'])
    elif ty == 'numeral': A(fx, pop_(260 + 60 * e['k']), t, .22, .3)
    elif ty == 'tassel': A(fx, swish(.45, 800, 3000), t, .12, -.3)
    elif ty == 'marker': A(fx, squeak(e['d']), t, .16, -.2); A(fx, tick(.6), e['peak'], .25)
    elif ty == 'dust': A(fx, puff(), t + .05, .35, 0)
    elif ty == 'featherfall': A(fx, airy(e['d']), t, .14, .3)
    elif ty == 'featherland': A(fx, tick(.5), t, .16, .3); A(fx, swish(.2, 3000, 8000), t, .08)
    elif ty == 'riser': A(fx, riser(e['d']), t, .35)
    elif ty == 'boardhit': A(perc, S.hit('sus_cymbal', 'hit', .55), t, .35, .3); A(fx, thud(70, .3), t, .4)
    elif ty == 'pop': A(fx, pop_(500 + 45 * e['i'] + (300 if e.get('big') else 0)), t, .2 if not e.get('big') else .3, -.3 + .07 * e['i'])
    elif ty == 'twang':
        i = e['i']; x = P.pluck('banjo', TW[i], 1.1, .85, bend=[(0, -1.5), (.04, 0)]); A(mus, x, t, .42 + .02 * i, -.5 + .12 * i)
        A(fx, zip_(), t - .1, .1, -.5 + .12 * i)
    elif ty == 'rattle': A(fx, rattle(e['d']), t, .22, 0)
    elif ty == 'swallow': pass   # 吞满的那一刻就是静默本身，不加声音
    elif ty == 'charge': A(fx, charge(e['d']), t, .22, .1)
    elif ty == 'shutter': A(fx, shutter(e.get('big')), t, .6 if e.get('big') else .45, .1)
    elif ty == 'clack': A(fx, clack(), t, .5, .2)
    elif ty == 'lookup': A(fx, ruffle(.18), t, .12, .2)
    elif ty == 'stamp': A(fx, stamp(), t, 1.0, -.05)
    elif ty == 'flinch': A(fx, ruffle(.4), t + .02, .18, .2)
    elif ty == 'squawk': A(fx, squawk(), t, .42, -.25)
    elif ty == 'flutter': A(fx, flutter(e['d']), t, .16, -.3)
    elif ty == 'paperland': A(fx, paperland(), t, .35, -.4)
    elif ty == 'ruffle': A(fx, ruffle(), t, .16, .2)

# ———————————— 环境：档案室房间底噪 + 窗外极轻的雨 ————————————
room = lp(np.cumsum(rng.standard_normal(N)), 250); room = room - np.convolve(room, np.ones(4800) / 4800, 'same'); room = norm(room) * .02
rain = bp(rng.standard_normal(N), 1200, 7000) * .012
drops = (rng.random(N) < .0009) * rng.standard_normal(N); drops = bp(np.convolve(drops, np.exp(-np.arange(120) / 18), 'same'), 2000, 8000) * .05
bed = (room + rain + drops).astype(np.float32); amb[:, 0] += bed; amb[:, 1] += np.roll(bed, 311)

# ———————————— 混音 + 母带 ————————————
mus_r = S.room(mus, size=.32, mix=.16); perc_r = S.room(perc, size=.25, mix=.1)
# 混响尾巴也必须在硬切处截掉，静默才是真的静默
gate(mus_r, T['swallow'], T['flash1'] - .002); gate(perc_r, T['swallow'], T['flash1'] - .002)
gate(mus_r, T['cut'], T['stamp'] - .002, .03); gate(perc_r, T['cut'], T['stamp'] - .002, .03)
fx_r = S.room(fx, size=.2, mix=.08); gate(fx_r, T['swallow'], 13.55)
music = mus_r * .9 + perc_r * .8
# 印章附近给拟音让位
duck = np.ones(N, np.float32); i0 = int(T['stamp'] * SR); duck[i0:i0 + int(.5 * SR)] = np.linspace(.6, 1, int(.5 * SR))
mix = music * duck[:, None] + fx_r * 1.0 + amb
mix = mix[:int(DUR * SR)]
fo = int(.6 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)

def measure(x):
    p = os.path.join(HERE, 'out', '_meas.wav'); sf.write(p, x, SR, subtype='FLOAT')
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
    j = json.loads(r[r.rindex('{'):r.rindex('}') + 1]); os.remove(p); return float(j['input_i']), float(j['input_tp'])
for it in range(3):
    I, TP = measure(mix)
    g = 10 ** ((-14.0 - I) / 20); mix = mix * g
    mix = np.stack([limit(mix[:, c], ceil=10 ** (-2.8 / 20)) for c in range(2)], 1).astype(np.float32)
I, TP = measure(mix); print(f'mix: I={I:.2f} LUFS  TP={TP:.2f} dBTP  dur={len(mix) / SR:.3f}s')
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
for name, x in [('music', music), ('fx', fx_r), ('amb', amb), ('hitsA', hits[0]), ('hitsB', hits[1])]: sf.write(os.path.join(HERE, 'out', f'stem_{name}.wav'), x[:int(DUR * SR)], SR, subtype='FLOAT')
S.credits(['jazz_bass', 'vibraphone', 'vibraphone_hard', 'vibraphone_bowed', 'contrabass_pizz', 'snare', 'snare2', 'bass_drum', 'sus_cymbal'])
