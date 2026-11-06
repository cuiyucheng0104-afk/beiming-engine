# 早餐铺开门 — foley + ambience (all procedural, driven by window.EV via events.json) + music → out/mix.wav
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio.sfx import SR, add, bp, hp, lp, env_exp, t_, norm, thump, compress, limit
from core.audio import sampler as S

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
HIT, DUR = TL['hit'], E['dur']
N = int(DUR * SR)
rng = np.random.default_rng(3)
S.seed(21)
def buf(): return np.zeros((N, 2), np.float32)
B = {k: buf() for k in ['pen', 'wet', 'body', 'bike', 'shop', 'amb']}
ev = lambda typ: [e for e in E['ev'] if e['type'] == typ]

# ---------- pen on cold-press paper: one burst per real stroke ----------
def pen(d, v=1., bright=1.):
    d = max(.012, d); n = int(d * SR); x = rng.standard_normal(n)
    fiber = lp(rng.standard_normal(n), 90); fiber = .55 + .45 * np.abs(fiber) / (np.abs(fiber).max() + 1e-9)
    grain = (rng.random(n) > .9975) * rng.standard_normal(n) * 1.5
    y = bp(x, 1600 * bright, min(7500 * bright, 15000), 2) * fiber + hp(grain, 2500)
    a = min(.006, d / 4); e = np.minimum(1, np.arange(n) / (a * SR)) * np.minimum(1, (n - np.arange(n)) / (min(.02, d / 3) * SR))
    return (y * e * v * .17).astype(np.float32)
for e in ev('pen'):
    short = e['d'] < .03
    add(B['pen'], pen(e['d'], (.75 if short else 1.) * (.85 + rng.random() * .3), e['b'] * (1.15 if short else 1.)), e['t'], 1, float(rng.uniform(-.3, .3)))
def write(t0, d, v=.85, pan=0.):
    t = t0
    while t < t0 + d - .02:
        dd = min(.03 + rng.random() * .07, t0 + d - t); add(B['pen'], pen(dd, v * (.7 + rng.random() * .5), 1.15), t, 1, pan + float(rng.uniform(-.1, .1))); t += dd + .012 + rng.random() * .03
for e in ev('write'): write(e['t'], e['d'], .9, e.get('pan', 0))

# ---------- water and brush ----------
def wet(size=1.):
    d = .5 + .5 * size; n = int(d * SR); tt = np.arange(n) / SR
    x = bp(rng.standard_normal(n), 900, 5200, 2) * (.7 + .3 * lp(rng.standard_normal(n), 30) / .05)
    e = np.minimum(1, tt / .07) * np.exp(-tt / (.22 * size + .08))
    return (x * e * .35).astype(np.float32)
for e in ev('wet'): add(B['wet'], wet(e['size']), e['t'] - .015, .8 * min(1.2, e['size']), .2)
def rinse():
    d = .9; out = np.zeros(int(d * SR))
    for k in range(26):
        f = 350 + rng.random() * 700; s = int(rng.random() * .7 * SR); dd = .03 + rng.random() * .05; tt = t_(dd)
        b = np.sin(2 * np.pi * f * (1 + 1.5 * tt / dd) * tt) * env_exp(dd, dd / 3); out[s:s + len(b)] += b[:len(out) - s] * (.4 + rng.random() * .6)
    out += bp(rng.standard_normal(len(out)), 600, 3000) * np.exp(-np.arange(len(out)) / SR / .3) * .3
    return (norm(out) * .35).astype(np.float32)
for e in ev('rinse'): add(B['wet'], rinse(), e['t'], .7, -.35)

# ---------- footsteps: soft cloth shoes on stone, on the beat ----------
def step(v=1.):
    d = .09; tt = t_(d)
    heel = lp(rng.standard_normal(len(tt)), 1800) * env_exp(d, .012)
    scuff = bp(rng.standard_normal(len(tt)), 1500, 5000) * env_exp(d, .03) * .25
    return (norm(heel + scuff) * v * .5).astype(np.float32)
for e in ev('step'):
    for k in range(2):
        add(B['body'], step(.55 if e['soft'] else .8), e['t'] + k * .012 + float(rng.uniform(0, .006)), .5 if e['soft'] else .75, float(rng.uniform(-.7, .7)))

# ---------- the bicycle: chain ticks + tyre hiss, panned from its screen position; the bell ----------
tr = ev('track')[0]['pts']; bk = ev('bike')[0]
pan_at = lambda t: float(np.interp(t, [p[0] for p in tr], [p[1] for p in tr]))
t0b, t1b = bk['t'], bk['t1'] + .3
n0, n1 = int(t0b * SR), int(t1b * SR); tt = np.arange(n1 - n0) / SR + t0b
lvl = np.clip((tt - t0b) / .5, 0, 1) * np.clip((t1b - tt) / .9, 0, 1)
hiss = lp(bp(rng.standard_normal(len(tt)), 300, 2400), 1600) * .18 * lvl
pans = np.array([pan_at(x) for x in tt[::480]]); pans = np.interp(np.arange(len(tt)), np.arange(len(pans)) * 480, pans)
L, Rr = np.cos((pans + 1) * np.pi / 4), np.sin((pans + 1) * np.pi / 4)
B['bike'][n0:n1, 0] += hiss * L * 1.4; B['bike'][n0:n1, 1] += hiss * Rr * 1.4
tick_t = t0b
while tick_t < t1b - .2:
    d = .006; c = hp(rng.standard_normal(int(d * SR)), 2500) * env_exp(d, .0015)
    add(B['bike'], (c * .25).astype(np.float32), tick_t, float(np.interp(tick_t, tt, lvl)), pan_at(tick_t)); tick_t += .055 + rng.random() * .01
def bell():
    # a dome bicycle bell tuned to D7, struck three times by the spinning hammer
    d = 1.4; tt2 = t_(d); out = np.zeros(len(tt2))
    for k, (dt, v) in enumerate([(0, 1), (.055, .8), (.11, .6)]):
        s = int(dt * SR); x = tt2[:len(tt2) - s]
        tone = sum(a * np.sin(2 * np.pi * 2349 * r * x + k) * np.exp(-x / tau) for r, a, tau in [(1, 1, .55), (1.34, .5, .35), (2.15, .4, .25), (2.86, .25, .18), (3.7, .15, .1)])
        click = hp(rng.standard_normal(len(x)), 4000) * np.exp(-x / .002) * .6
        out[s:] += (tone * (1 + .15 * np.sin(2 * np.pi * 6 * x)) + click) * v
    glk = S.note('glockenspiel', 'D7', .5, .45); out[:len(glk)] += glk[:len(out)] * .35         # a real struck-metal sample under the synth
    return (norm(out) * .5).astype(np.float32)
for e in ev('bell'): add(B['bike'], bell(), e['t'] - .004, .85, pan_at(e['t']))

# ---------- the shop: lid pop, steam, lid landing, lanterns ----------
def bamboo_knock(v=1., pitch=1.):
    d = .25; tt2 = t_(d)
    res = sum(a * np.sin(2 * np.pi * f * pitch * tt2) * env_exp(d, tau) for f, a, tau in [(820, 1, .045), (1640, .5, .025), (2900, .3, .012), (410, .5, .06)])
    tr2 = hp(rng.standard_normal(len(tt2)), 2000) * env_exp(d, .003)
    wb = S.hit('woodblock', 'b', .55 * v); n = min(len(wb), len(tt2)); x = res * .7 + tr2 * .5; x[:n] += wb[:n] * .6
    return (norm(x) * v * .7).astype(np.float32)
def puff(v=1.):
    d = 1.6; tt2 = t_(d); n = rng.standard_normal(len(tt2))
    body = lp(n, 900) * np.exp(-tt2 / .25) * 1.2 + bp(n, 1500, 7000) * np.minimum(1, tt2 / .015) * np.exp(-tt2 / .55)
    return (norm(body) * v * .7).astype(np.float32)
for e in ev('lid'):
    add(B['shop'], bamboo_knock(1.), e['t'] - .002, .9, -.05)
    add(B['shop'], puff(1.), e['t'], .85, -.1)
for e in ev('breath'): add(B['shop'], puff(.5), e['t'], .55, -.1)   # B2.1: the steamer's second breath
for e in ev('punch'): add(B['shop'], thump(.6, 62), e['t'], .5, 0)
for e in ev('lidLand'):
    for dt, v in [(0, .7), (.07, .35), (.16, .22)]: add(B['shop'], bamboo_knock(v, 1.08), e['t'] + dt, .8, .05)
def lantern():
    x = wet(.8) * 1.0; d = .9; tt2 = t_(d)
    glow = bp(rng.standard_normal(len(tt2)), 3000, 9000) * np.minimum(1, tt2 / .2) * np.exp(-tt2 / .4) * .12
    x2 = np.zeros(max(len(x), len(glow))); x2[:len(x)] += x; x2[:len(glow)] += glow; return x2.astype(np.float32)
for e in ev('lantern'): add(B['wet'], lantern(), e['t'] + .01, .8, -.35 if e['t'] < HIT['lantern2'] - .1 else .35)
st = ev('steam')[0]; n0 = int(st['t'] * SR); tt2 = np.arange(N - n0) / SR
hissb = bp(rng.standard_normal(len(tt2)), 1800, 8000) * (.55 + .45 * np.abs(lp(rng.standard_normal(len(tt2)), 2)) / .02).clip(0, 1.4)
hissb *= np.minimum(1, tt2 / .05) * (.1 + .06 * np.exp(-tt2 / 1.5))
B['shop'][n0:, 0] += hissb * .9; B['shop'][n0:, 1] += hissb * .7

# ---------- ambience: paper room tone → birds (J-cut, a bar before the sky's colour) → far street after the lid ----------
tt3 = np.arange(N) / SR
room = lp(rng.standard_normal(N), 2500) * .006
B['amb'][:, 0] += room; B['amb'][:, 1] += room * .9
def chirp(f0, d=.09):
    tt2 = t_(d); f = f0 * (1 + .25 * np.sin(np.pi * tt2 / d)); return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt2 / d) ** 2).astype(np.float32)
tb = HIT['sky'] - 2.0
while tb < DUR:
    if not (HIT['silence'] - .3 < tb < HIT['lid'] + .2):
        f = 3200 + rng.random() * 2600; g = .045 * min(1, (tb - (HIT['sky'] - 2.0)) / 2.0)
        for k in range(int(1 + rng.random() * 3)): add(B['amb'], chirp(f * (1 + .06 * k), .05 + rng.random() * .06), tb + k * .09, g, float(rng.uniform(-.8, .8)))
    tb += .35 + rng.random() * .7
n0 = int((HIT['lid'] + .4) * SR); tt2 = np.arange(N - n0) / SR
murmur = bp(rng.standard_normal(len(tt2)), 250, 1400) * (.5 + .5 * np.abs(lp(rng.standard_normal(len(tt2)), 4)) / .01).clip(0, 1.5) * .02 * np.minimum(1, tt2 / 1.5)
B['amb'][n0:, 0] += murmur; B['amb'][n0:, 1] += murmur * .8

# ---------- mix ----------
mus = sf.read(os.path.join(HERE, 'out', 'music.wav'), dtype='float32')[0][:N]
music = np.zeros((N, 2), np.float32); music[:len(mus)] = mus
# duck the music a touch under the bell and under the lid/steam hit
duck = np.ones(N, np.float32)
for t, dd, k in [(HIT['bell1'], .35, .6), (HIT['bell2'], .35, .6), (HIT['lid'], .5, .7)]:
    i0, i1 = int(t * SR), int((t + dd) * SR); duck[i0:i1] = np.minimum(duck[i0:i1], np.linspace(k, 1, i1 - i0))
music *= duck[:, None]
fol = {'pen': .9, 'wet': .9, 'body': .55, 'bike': .8, 'shop': 1.0, 'amb': 1.0}
foley = sum(B[k] * g for k, g in fol.items())
for c in range(2): foley[:, c] = hp(foley[:, c], 90)
mix = music * 1.0 + foley * .8
# the silence: one second of true silence, ambience included; the lid is the first sound after it
i0, i1 = int(HIT['silence'] * SR), int((HIT['lid'] - .002) * SR); n = int(.03 * SR)
mix[i0:i0 + n] *= np.linspace(1, 0, n)[:, None]; mix[i0 + n:i1] = 0
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
# low-end balance check: 20–120 Hz vs the rest
spec = np.abs(np.fft.rfft(mix[:, 0] + mix[:, 1])) ** 2; fr = np.fft.rfftfreq(N, 1 / SR)
lo = spec[(fr > 20) & (fr < 120)].sum(); rest = spec[(fr >= 120) & (fr < 16000)].sum()
print('mix.wav', mix.shape, 'peak %.3f' % np.abs(mix).max(), 'low/rest %.1f dB' % (10 * np.log10(lo / rest)))
