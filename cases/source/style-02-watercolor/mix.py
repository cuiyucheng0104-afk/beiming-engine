# 配乐（采样竖琴/长笛/钢片琴/卡林巴/弓奏颤音琴 + 拨弦合成 + numpy 水滴）+ 拟音（由 events.json 驱动）→ out/mix.wav
# 用法：$LIB/.venv/bin/python mix.py        （先跑 tools/tl2json.mjs 和 core/render/events.mjs）
import os, sys, json, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, bp, lp, hp

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
DUR = TL['DUR']; N = int(round(DUR * SR)); T = TL['T']
SEC = {s['id']: s for s in TL['SECS']}
at = lambda sid, b: SEC[sid]['t'] + b * 60 / SEC[sid]['bpm']
rng = np.random.default_rng(20261031); S.seed(7)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)

# ================= 配乐 =================
SC = []          # (t, inst, pitch, dur, vel, pan[, gain])
CUES = {}        # 每个拍点上「音乐里那一下」的时间，给 cuecheck
def cue(name, t): CUES.setdefault(name, round(t, 6))
def n(t, inst, p, d, v, pan=0, g=1.0, **kw): SC.append(dict(t=t, inst=inst, pitch=p, dur=d, vel=v, pan=pan, gain=g, **kw))
def arp(t0, t1, step, notes, v, pan=(-.3, .3), g=1.0, d=1.6):
    k = 0; t = t0
    while t < t1 - 1e-6:
        n(t, 'harp', notes[k % len(notes)], d, v * (1.0 if k % 4 == 0 else .82), pan[k % 2], g); k += 1; t = round(t0 + k * step, 6)
HARM = []        # 竖琴泛音（pluck.py 物理建模）
def harm(t, p, v, pan=0, g=.6): HARM.append((t, p, v, pan, g))

# --- A 滴落（80） ---
cue('drop', T['drop']); n(T['drop'], 'harp', 'D2', 3.5, .8, -.1); n(T['drop'], 'harp', 'D3', 3.0, .55, .1)
arp(T['drop'] + .375, 3.0, .375, ['A3', 'E4', 'F#4', 'A4', 'C#5', 'A4', 'F#4', 'E4'], .42)
cue('note1', T['note1'])                         # 1.5 正好在分解和弦的一拍上（A3/E4 …）
# --- B 成鱼（80） ---
cue('head', T['head']); n(T['head'], 'harp', 'D2', 2.0, .62, -.1)
arp(T['head'], at('B', 2), .375, ['D3', 'A3', 'E4', 'F#4', 'A4', 'E4'], .45)
cue('eye', T['eye']); n(T['eye'], 'glockenspiel', 'A6', 1.2, .4, .25)
cue('flick1', T['flick1']); n(T['flick1'], 'harp', 'B1', 2.0, .78, -.1); n(T['flick1'], 'harp', 'F#4', 1.6, .62, .25)   # 第一下摆尾：低音 +2 dB，再加一个中音拨弦，让起音清楚
arp(at('B', 2), at('B', 4), .375, ['F#3', 'B3', 'D4', 'A4', 'C#5', 'D4'], .45)
n(at('B', 4), 'harp', 'G1', 2.0, .62, -.1)
arp(at('B', 4), at('B', 6), .375, ['D3', 'G3', 'B3', 'F#4', 'A4', 'F#4'], .45)
for k, p in zip(['leaf1', 'leaf2', 'leaf3', 'leaf4'], ['D6', 'A5', 'B5', 'F#6']): cue(k, T[k]); harm(T[k], p, .75, .35)
cue('note2', T['note2'])
# 7.5 起四分三连音（= 120 BPM 的拍子），节拍调制进 C 段
cue('gear', T['gear']); n(T['gear'], 'harp', 'A1', 2.0, .6, -.1)
for i, t in enumerate([7.5, 8.0, 8.5]): n(t, 'harp', ['E3', 'A3', 'D4'][i], 1.4, .55, -.2); n(t, 'harp', ['A3', 'D4', 'E4'][i], 1.4, .5, .2)
for i, p in enumerate(['A4', 'B4', 'C#5', 'D5']): n(8.5 + i * .125, 'harp', p, 1.0, .42 + .04 * i, .3)
# 长笛主题（从第一下摆尾进）
for t, p, d in [(4.5, 'F#5', .75), (5.25, 'A5', .375), (5.625, 'B5', .375), (6.0, 'A5', 1.05), (7.125, 'F#5', .375), (7.5, 'E5', .5), (8.0, 'F#5', .5), (8.5, 'A5', .5)]:
    n(t, 'flute', p, d * .96, .72 if t == T['flick1'] else .55, .15, .85, attack=.012 if t == T['flick1'] else .03)
# --- C 四季（120），密度一拍一档 ---
C = [('spring', 'G1', ['D4', 'G4', 'A4', 'B4', 'D5', 'B4', 'A4', 'G4'], .25, 'B5'),
     ('summer', 'E2', ['B3', 'E4', 'F#4', 'G4', 'B4', 'D5'], 1 / 6, 'D6'),
     ('autumn', 'C2', ['G3', 'C4', 'E4', 'F#4', 'B4', 'E5', 'F#4', 'E4'], .125, 'E6')]
for name, bass, notes, step, fl in C:
    t0 = T[name]; cue(name, t0); n(t0, 'harp', bass, 1.4, .7, -.1); arp(t0, t0 + 1.0, step, notes, .44, d=1.0)
    n(t0, 'flute', fl, .92, .55, .15, .85, attack=.04)
t0 = T['winter']; cue('winter', t0); n(t0, 'harp', 'B1', 1.2, .7, -.1); n(t0, 'flute', 'F#6', .95, .58, .15, .85, attack=.04)
sc = ['B3', 'C#4', 'D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5', 'B5', 'D6']
for r, base in enumerate([0, 8]):              # 两次上行刮奏，32 分
    for i in range(8): n(t0 + r * .5 + i * .0625, 'harp', sc[base + i], .8, .4 + .03 * i, .3 - .08 * i)
for k, ps in [('spring2', ['D6', 'G6']), ('summer2', ['E6']), ('autumn2', ['F#6']), ('winter2', ['B6', 'D7', 'F#7'])]:
    cue(k, T[k])
    for i, p in enumerate(ps): n(T[k] + i * .0625, 'glockenspiel', p, 1.0, .38, .3)
for i in range(16):                            # 有机的推进：沙锤八分 + 手鼓每拍
    t = T['spring'] + i * .25; n(t, 'shaker', 'down' if i % 2 == 0 else 'up', None, .16 + .1 * (i / 16), .35, .7)
for i in range(8): n(T['spring'] + i * .5, 'frame_drum', 'small', None, .25 + .04 * i, -.15, .8)
# --- D 屏息 ---
cue('dive', T['dive']); DBUS = [dict(t=T['dive'], inst='harp', pitch='B1', dur=.22, vel=.5, pan=0)]
cue('hush', T['hush'])
# --- E 跃起与雾（80） ---
tl = T['leap']; cue('leap', tl)
gl = ['D3', 'E3', 'F#3', 'G3', 'A3', 'B3', 'C#4', 'D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5', 'B5', 'C#6', 'D6']
for i, p in enumerate(gl): n(tl + i * .015, 'harp', p, 2.5, .55 + .3 * i / len(gl), -.5 + i / len(gl), 1.0)
n(tl, 'harp', 'D2', 3.0, .9, -.1); n(tl, 'harp', 'A2', 3.0, .75, .1)
n(tl, 'gran_cassa', 'hit', None, .6, 0, 1.0)
n(tl, 'flute', 'D6', .72, .72, .1, 1.0, attack=.02)
tb = T['burst']; cue('burst', tb)
for i, p in enumerate(['D6', 'F#6', 'A6', 'C#7']): n(tb + i * .015, 'glockenspiel', p, 2.0, .5, -.3 + .2 * i)
for p in ['D5', 'A5']: n(tb, 'hand_chimes', p, 2.5, .55, .2)
for i, p in enumerate(['D3', 'A3', 'E4', 'F#4', 'A4', 'C#5', 'E5']): n(tb + i * .02, 'harp', p, 2.5, .7, -.4 + i * .12)
n(tb, 'harp', 'D2', 3.0, .7, 0); n(tb, 'sus_cymbal', 'hit', None, .35, .1, .7)
tm = T['bloom']; cue('bloom', tm); n(tm, 'harp', 'D2', 2.5, .55)
arp(tm, T['seal'], .375, ['D3', 'B3', 'F#4', 'A4', 'D5', 'A4'], .38)
for t, p, d in [(tm, 'A5', .72), (T['mist'], 'F#5', .72), (T['seal'], 'D5', 1.6)]: n(t, 'flute', p, d, .55, .15, .85, attack=.04)
for i, td in enumerate(TL['DROPS']): harm(td, ['A6', 'F#6', 'D6', 'B5', 'A5'][i], .6, (i % 2) * .6 - .3, .5)
ts = T['mist']; cue('mist', ts)
for p in ['D4', 'A4', 'F#5']: n(ts, 'vibraphone_bowed', p, 2.6, .5, 0, .8, attack=.5)
tq = T['seal']; cue('seal', tq); n(tq, 'kalimba', 'D4', 2.0, .7, .3); n(tq, 'harp', 'D2', 2.0, .6, 0); n(tq, 'harp', 'D3', 2.0, .5, 0)
harm(at('E', 5), 'A5', .5, .2, .45); harm(at('E', 6), 'D6', .45, -.2, .4)

music = S.render(SC, dur=DUR + 3, master=False)[:N]
# 长笛第一音的气息起音（chiff）：带通噪声 25 ms 衰减，正落在 flick1
_x = np.arange(int(.09 * SR)) / SR; _ch = bp(np.random.default_rng(45).standard_normal(len(_x)), 1400, 5200) * np.exp(-_x / .022) * np.minimum(1, _x / .0015)
_ch = _ch / np.abs(_ch).max() * .16; _i = int(round(T['flick1'] * SR)); music[_i:_i + len(_ch), 0] += _ch * .9; music[_i:_i + len(_ch), 1] += _ch * 1.1
for t, p, v, pan, g in HARM: add(music, P.pluck('harp', p, 2.5, v, harmonic=True), t, g, pan)
# 屏息：音乐在 D0 后 0.22 s 内收干净，D 段只剩 D0 那一声低音
env = np.ones(N, np.float32); i0, i1, i2 = int(T['dive'] * SR), int((T['dive'] + .22) * SR), int(T['leap'] * SR) - 2
env[i0:i1] = .5 + .5 * np.cos(np.linspace(0, np.pi, i1 - i0)); env[i1:i2] = 0
music = S.room(music, size=.5, mix=.24) * env[:, None]
dbus = S.render(DBUS, dur=DUR, master=False)[:N]; dbus = S.room(dbus, size=.4, mix=.2)
e2 = np.ones(N, np.float32); j1 = int((T['dive'] + .45) * SR); e2[int(T['dive'] * SR + .2 * SR):j1] = np.linspace(1, 0, j1 - int(T['dive'] * SR + .2 * SR)); e2[j1:] = 0
music += dbus * e2[:, None]

# ================= 拟音 =================
fx = np.zeros((N, 2), np.float32)
def noise(d): return rng.standard_normal(int(round(d * SR)))
def tt(d): return np.arange(int(round(d * SR))) / SR
def nrm(x, p=1.0): m = np.abs(x).max(); return x * (p / m) if m > 0 else x
def pink(n_):
    w = np.fft.rfft(rng.standard_normal(n_)); f = np.arange(len(w)); f[0] = 1; return np.fft.irfft(w / np.sqrt(f), n_)
def bubble(f0, d=.12, rise=.6, g=1.0):          # Minnaert 气泡：频率随时间上扬
    x = tt(d); f = f0 * (1 + rise * x / d); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x / (d * .28)) * np.minimum(1, x / .002) * g
def brush(d, g, p0=-.5, p1=.5):
    n_ = int(d * SR); u = np.arange(n_) / n_
    x = bp(noise(d), 1500, 7000) * (.6 + .4 * np.abs(np.sin(np.arange(n_) / SR * 2 * np.pi * 9))) + bp(pink(n_), 300, 1500) * .6
    y = nrm(x * np.sin(np.pi * u) ** .8, .5) * g; pan = p0 + (p1 - p0) * u
    return np.stack([y * np.cos((pan + 1) * np.pi / 4) * 1.414, y * np.sin((pan + 1) * np.pi / 4) * 1.414], 1)
def put2(buf, x2, t):
    s = int(round(t * SR)); e = min(len(buf), s + len(x2))
    if e > s: buf[s:e] += x2[:e - s]
def scratch(d, nstr, g, pan):
    out = np.zeros(int(d * SR))
    for k in range(nstr):
        s0 = k / nstr * d + rng.uniform(0, .02); L_ = rng.uniform(.06, .13); x = bp(noise(L_), 2500, 7500) * (.5 + .5 * rng.random(int(round(L_ * SR)))) ** 2
        x *= np.sin(np.pi * tt(L_) / L_) ** .6; i = int(s0 * SR); out[i:i + len(x)] += x[:len(out) - i]
    return nrm(out, .5) * g, pan
def swish(g):
    d = .32; x = bp(noise(d), 350, 1900) * np.minimum(1, tt(d) / .04) * np.exp(-tt(d) / .1)
    b = bubble(rng.uniform(700, 1000), .08, .7, .3); x[int(.04 * SR):int(.04 * SR) + len(b)] += b
    return nrm(x, 1) * g
def stamp(g):
    x = tt(1.0); y = np.sin(2 * np.pi * np.cumsum(92 * (1 + .5 * np.exp(-x * 30))) / SR) * np.exp(-x * 9) + lp(noise(1.0), 900) * np.exp(-x / .04) * .6
    return nrm(y, .8) * g
def chirp(f0):
    d = .09; x = tt(d); f = f0 * (1 + .35 * np.sin(2 * np.pi * 38 * x)) * (1 + 1.2 * x); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * x / d) ** 2
def bed(d, kind):
    n_ = int(d * SR); x = tt(d)
    if kind == 'spring':
        y = lp(pink(n_), 900) * .05
        for _ in range(9):
            s0 = rng.uniform(0, d - .4); c = chirp(rng.uniform(3000, 4600)) * rng.uniform(.3, .6); i = int(s0 * SR); y[i:i + len(c)] += c
    elif kind == 'summer':
        y = bp(noise(d), 4200, 6800) * (.55 + .45 * np.sin(2 * np.pi * 52 * x) ** 2) * (.7 + .3 * np.sin(2 * np.pi * .9 * x)) * .5
    elif kind == 'autumn':
        y = lp(pink(n_), 700) * (.6 + .4 * np.sin(2 * np.pi * .7 * x)) * .5 + bp(noise(d), 2500, 8000) * (rng.random(n_) > .992) * 1.2
    else:
        y = bp(pink(n_), 500, 1300) * (.6 + .4 * np.sin(2 * np.pi * .45 * x + 1)) * .6 + bp(noise(d), 1800, 2600) * .08
    e = np.minimum(1, x / .5) * np.minimum(1, (d - x) / .25)
    return nrm(y, 1) * e
# 底层：纸面房间声 + 池水
room_ = lp(pink(N), 2500); room_ = nrm(room_, 1) * .006
re = np.ones(N); h0, h1 = int(T['hush'] * SR), int(T['leap'] * SR); re[h0:h1] = .45
ROOM = np.stack([room_ * re, np.roll(room_, 2400) * re], 1)
def water_env():
    e = np.zeros(N); x = np.arange(N) / SR
    e += np.clip((x - 2.6) / .8, 0, 1) * np.clip((T['dive'] + .25 - x) / .25, 0, 1)
    e += np.clip((x - T['leap']) / .02, 0, 1) * np.clip((17.4 - x) / 1.2, 0, 1)
    return np.clip(e, 0, 1)
wl = bp(np.cumsum(rng.standard_normal(N)) * .02, 120, 900) * (.7 + .3 * np.sin(2 * np.pi * .3 * np.arange(N) / SR))
wl = nrm(wl, 1) * .045 * water_env()
fx += np.stack([wl, np.roll(wl, 3000)], 1)

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'fall':
        d = e['dur']; x = tt(d); y = bp(noise(d), 2500, 6000) * (x / d) ** 2 * .12; add(fx, y, t, 1, 0)
    elif ty == 'drop':
        add(fx, bubble(1150, .16, .55, 1.0), t, .55, 0); add(fx, lp(noise(.05), 1200) * np.exp(-tt(.05) / .012), t, .35, 0)
        add(fx, bubble(420, .2, .3, .6), t, .35, 0)
    elif ty == 'soak':
        d = e['dur']; n_ = int(d * SR); y = hp(noise(d), 4500) * (rng.random(n_) > .985) * .8 + bp(pink(n_), 600, 2500) * .2
        add(fx, nrm(y, 1) * np.exp(-tt(d) / .9) * .09, t, 1, 0)
    elif ty == 'write':
        y, pan = scratch(e['dur'], e['n'], .13, e.get('pan', 0)); add(fx, y, t, 1, pan)
    elif ty == 'brush':
        put2(fx, brush(e['dur'], e['g'] * .55, e.get('pan0', -.4), e.get('pan1', .4)), t)
    elif ty == 'eye':
        add(fx, lp(noise(.03), 2500) * np.exp(-tt(.03) / .006), t, .12, .2)
    elif ty == 'flick':
        k1 = e.get('hit') == 'flick1'          # 第一下摆尾加重约 4 dB，并加一个水面拍击的瞬态
        add(fx, swish(e['g'] * .32 * (1.6 if k1 else 1)), t - .04, 1, e.get('pan', 0))
        if k1: add(fx, nrm(bp(noise(.06), 500, 3000) * np.exp(-tt(.06) / .012) * np.minimum(1, tt(.06) / .001), 1), t, .22, e.get('pan', 0))
    elif ty == 'band':
        put2(fx, brush(.8, .3, -.6, .6), t); add(fx, nrm(lp(pink(int(.9 * SR)), 1400), 1) * np.sin(np.pi * tt(.9) / .9) * .05, t, 1, .2)
    elif ty == 'amb':
        add(fx, bed(e['dur'], e['season']), t, {'spring': .06, 'summer': .035, 'autumn': .06, 'winter': .07}[e['season']], .3)
    elif ty == 'dive':
        for k in range(6): add(fx, bubble(rng.uniform(300, 700) * (1 + k * .15), .07, .9, 1), t + k * .03, .12, rng.uniform(-.3, .3))
    elif ty == 'leap':          # 全片最重要的一声
        d = .9; x = tt(d)
        sp = lp(noise(d), 3500) * np.exp(-x / .14) + hp(noise(d), 4000) * np.exp(-x / .3) * .5
        body = np.sin(2 * np.pi * 70 * x * (1 - .3 * x)) * np.exp(-x / .09) * .9
        add(fx, nrm(sp + body, 1), t, .55, 0)
        for k in range(14): add(fx, bubble(rng.uniform(500, 1600), .08, .8, 1), t + .02 + rng.uniform(0, .5), .08, rng.uniform(-.7, .7))
    elif ty == 'burst':
        for k, (p0, p1) in enumerate([(-.9, -.2), (.9, .2), (-.3, .6), (.4, -.5)]): put2(fx, brush(.55, .35, p0, p1), t + k * .03)
    elif ty == 'plink':
        add(fx, bubble(rng.uniform(900, 1500), .14, .7, 1), t, .2, e.get('pan', 0))
    elif ty == 'mist':
        d = 1.2; x = tt(d); y = bp(noise(d), 1200, 6000) * np.sin(np.pi * x / d) ** 1.5 * .6 + lp(pink(int(d * SR)), 800) * np.sin(np.pi * x / d) * .3
        put2(fx, np.stack([nrm(y, 1) * .07, nrm(np.roll(y, 1200), 1) * .07], 1), t)
    elif ty == 'seal':
        add(fx, stamp(.4), t, 1, e.get('pan', 0))
fx = S.room(fx, size=.3, mix=.16)
gx = np.ones(N, np.float32); g0, g1 = int((T['hush'] - .03) * SR), int((T['hush'] + .07) * SR)
gx[g0:g1] = np.linspace(1, 0, g1 - g0); gx[g1:int(T['leap'] * SR) - 2] = 0
fx = fx * gx[:, None] + ROOM

# ================= 混音 =================
mix = music * 1.0 + fx * 1.0
# 静默核对：hush 段应近乎全静
q = mix[int((T['hush'] + .05) * SR):int((T['leap'] - .01) * SR)]
hush_db = 20 * np.log10(np.sqrt(np.mean(q ** 2)) + 1e-12)
tail = int(.45 * SR); mix[-tail:] *= np.linspace(1, 0, tail)[:, None] ** 1.5
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
sf.write(os.path.join(HERE, 'out', 'music.wav'), music.astype(np.float32), SR, subtype='PCM_24')
json.dump({'cues': CUES, 'score': [{'t': e['t'], 'inst': e['inst'], 'pitch': e['pitch']} for e in SC]}, open(os.path.join(HERE, 'out', 'score_cues.json'), 'w'), ensure_ascii=False)
rms = lambda a, b: 20 * np.log10(np.sqrt(np.mean(mix[int(a * SR):int(b * SR)] ** 2)) + 1e-12)
print(f'mix.wav {DUR}s  peak {20*np.log10(np.abs(mix).max()):.1f} dBFS  hush {hush_db:.1f} dBFS  '
      f'leap(14.0–14.4) {rms(14.0, 14.4):.1f}  C {rms(9, 13):.1f}  B {rms(3, 9):.1f}  end {rms(17, 18.5):.1f}')
with open(os.path.join(HERE, 'out', 'credits_music.txt'), 'w') as f: f.write('\n'.join(S.credits(sorted({e['inst'] for e in SC} | {'harp'}))))
