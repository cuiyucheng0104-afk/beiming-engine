"""mix.py — foley from events.json (synthesised by material) + score + 1930s optical soundtrack → out/mix.wav
Run: $LIB/.venv/bin/python <film>/mix.py   (after events.mjs and music/score.py)"""
import os, sys, json, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, os.path.join(LIB, 'core/audio'))
import sfx as X
from sfx import SR, t_, env_exp, bp, lp, hp, norm, add

R = np.random.default_rng(1931)
def nz(d): return R.standard_normal(len(t_(d)))
ev = json.load(open(os.path.join(HERE, 'events.json'))); DUR = ev['dur']; E = ev['ev']
N = int(round(DUR * SR))
FX = np.zeros((N, 2)); BED = np.zeros((N, 2))

# ———————————————— foley recipes ————————————————
def sweep(f0, f1, d, curve=1.0):
    tt = t_(d); f = f0 + (f1 - f0) * (tt / d) ** curve; return np.sin(2 * np.pi * np.cumsum(f) / SR)
def partials(fs, d, taus, amps=None):
    tt = t_(d); amps = amps or [1] * len(fs)
    return sum(a * np.sin(2 * np.pi * f * tt + R.random() * 6) * np.exp(-tt / tau) for f, tau, a in zip(fs, taus, amps))
def woodblock(f=2400, d=.09):
    tt = t_(d); x = np.sin(2 * np.pi * f * tt) * np.exp(-tt / .018) + .5 * np.sin(2 * np.pi * f * 1.52 * tt) * np.exp(-tt / .01)
    return norm(x + hp(nz(d), 2000) * env_exp(d, .0015) * .4)
def metal(p=1.0, d=.35):   # the clock's steel case and bells: inharmonic partials
    return norm(partials([1830 * p, 2950 * p, 4410 * p, 6120 * p, 990 * p], d, [.09, .06, .04, .025, .12], [1, .7, .5, .3, .5]) + hp(nz(d), 3500) * env_exp(d, .002) * .5)
def slide_whistle(f0, f1, d, vib=0.):
    tt = t_(d); f = f0 * (f1 / f0) ** (tt / d) * (1 + vib * np.sin(2 * np.pi * 6 * tt)); x = np.sin(2 * np.pi * np.cumsum(f) / SR)
    x = x + .15 * np.sin(2 * np.pi * np.cumsum(2 * f) / SR); e = np.minimum(1, tt / .03) * np.minimum(1, (d - tt) / .05)
    return norm(x * e + bp(nz(d), 1500, 5000) * .03 * e)
def boing(f=210, d=.6, depth=.35):
    tt = t_(d); f_ = f * (1 + depth * np.sin(2 * np.pi * 13 * tt) * np.exp(-tt * 4)); ph = 2 * np.pi * np.cumsum(f_) / SR
    return norm((np.sin(ph) + .4 * np.sin(2 * ph) + .2 * np.sin(3 * ph)) * np.exp(-tt * 4.5))
def bell_ring(d):   # alarm: the hammer strikes two bells 18 times a second
    out = np.zeros(len(t_(d)) + int(.35 * SR))
    for k in range(int(d * 18)):
        s = int(k / 18 * SR); b = partials([2050 + (k % 2) * 210, 3300, 5150, 7050], .3, [.07, .045, .028, .016], [1, .7, .5, .3]); out[s:s + len(b)] += b
    return norm(out)
def rubber_creak(d, f0=90, f1=260):
    tt = t_(d); f = f0 * (f1 / f0) ** (tt / d); saw = 2 * ((np.cumsum(f) / SR) % 1) - 1
    return norm(bp(saw, 300, 2500) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 17 * tt))) * np.sin(np.pi * tt / d) ** .5)
def cloth(d, lo=600, hi=4000):
    tt = t_(d); return norm(bp(nz(d), lo, hi) * np.sin(np.pi * tt / d) ** 1.5 * (.7 + .3 * np.sin(2 * np.pi * 31 * tt)))
def zip_(d=.16, f0=400, f1=2200): return norm(sweep(f0, f1, d, 1.5) * np.sin(np.pi * t_(d) / d) + bp(nz(d), 1500, 6000) * .3 * np.sin(np.pi * t_(d) / d))
def ratchet(d):
    out = np.zeros(int(d * SR) + 4000); n = 16
    for k in range(n): s = int((1 - (1 - k / n) ** 1.6) * d * SR); c = woodblock(3100, .03) * .6; out[s:s + len(c)] += c
    return norm(out)
def snore(d):
    tt = t_(d); rattle = .55 + .45 * np.sign(np.sin(2 * np.pi * 28 * tt)) * .8
    inhale = bp(nz(d), 120, 900) * rattle * np.sin(np.pi * np.minimum(1, tt / (d * .62))) ** 1.2 * (tt < d * .62)
    ex = sweep(950, 720, d) * np.clip((tt - d * .66) / .05, 0, 1) * np.exp(-np.clip(tt - d * .66, 0, None) / (d * .2)) * .18
    return norm(lp(inhale, 1200) + ex)
def slap():   # glove on steel, flat-handed: a wet crack + a hollow body thump
    d = .45; tt = t_(d)
    crack = bp(nz(d), 700, 5000) * env_exp(d, .006) * 1.2
    body = np.sin(2 * np.pi * 95 * tt * (1 - .4 * tt)) * env_exp(d, .07)
    smack = lp(nz(d), 2500) * env_exp(d, .025) * .6
    return norm(crack + body * .9 + smack)
def seq(clips, total):
    out = np.zeros(int(total * SR))
    for t0, c in clips:
        s0 = int(t0 * SR); n = max(0, min(len(c), len(out) - s0)); out[s0:s0 + n] += c[:n]
    return norm(out)

RECIPES = {
    'irisOpen': lambda e: (norm(seq([(0, ratchet(e['d']) * .4), (0, cloth(e['d'], 2000, 6000) * .5)], e['d'] + .05)), .22),
    'tick': lambda e: (woodblock(2900, .07), .42),
    'tock': lambda e: (seq([(0, woodblock(2100, .1)), (0, metal(1.3, .12) * .25)], .12), .5),
    'snore': lambda e: (snore(e['d']), .38 * e.get('v', 1)),
    'bell': lambda e: (bell_ring(e['d']), .42),
    'hop': lambda e: (boing(380, .25, .3), .3),
    'land': lambda e: (seq([(0, woodblock(700, .12)), (0, X.thump(.6, 110) * .6)], .3), .4 * e.get('v', 1)),
    'stretch': lambda e: (seq([(0, rubber_creak(e['d'], 90, 300) * .7), (0, slide_whistle(480, 1500, e['d']) * .8)], e['d'] + .05), .36),
    'grab': lambda e: (seq([(0, woodblock(1600, .08)), (0, cloth(.12, 800, 3000) * .5)], .14), .4),
    'curtain': lambda e: (seq([(0, cloth(.35, 900, 5000)), (0, ratchet(.25) * .5)], .4), .45),
    'zipBack': lambda e: (seq([(0, slide_whistle(1400, 500, .3) * .7), (.26, X.pop() * .6)], .45), .35),
    'pillow': lambda e: (norm(lp(nz(.25), 700) * env_exp(.25, .05)), .4),
    'yank': lambda e: (seq([(0, hp(nz(.03), 2500) * env_exp(.03, .003) * 2), (0, cloth(.4, 500, 3500))], .45), .5),
    'thudSoft': lambda e: (norm(lp(nz(.3), 400) * env_exp(.3, .06)), .3),
    'shiver': lambda e: (seq([(k * .04, woodblock(3400 + (k % 2) * 300, .03) * .5) for k in range(int(e['d'] / .04))], e['d'] + .05), .16),
    'pop': lambda e: (X.pop(), .4),
    'inhale': lambda e: (norm(bp(nz(e['d']), 400, 3000) * np.linspace(.2, 1, len(t_(e['d']))) ** 2), .3),
    'gust': lambda e: (norm(lp(nz(.6), 1800) * np.sin(np.pi * t_(.6) / .6) ** .5), .3),
    'pillowFly': lambda e: (X.whoosh(.4), .3),
    'glyph': lambda e: (seq([(0, X.pop() * .6), (0, woodblock(1800 + e['i'] * 400, .06) * .5)], .2), .32),
    'rise': lambda e: (rubber_creak(e['d'], 60, 140), .22),
    'slap': lambda e: (slap(), 1.0),
    'crunch': lambda e: (seq([(0, metal(.9, .4)), (.02, metal(.7, .3) * .7), (.05, boing(520, .3, .6) * .5)], .5), .45),
    'feeble': lambda e: (seq([(0, woodblock(3600, .05) * .5), (.12, metal(2.2, .2) * .3)], .35), .2),
    'peel': lambda e: (rubber_creak(e['d'], 70, 180), .35),
    'liftWhoosh': lambda e: (X.whoosh(.35), .28),
    'boing': lambda e: (boing(170, .8, .5), .7),
    'whistleUp': lambda e: (slide_whistle(400, 1800, e['d']), .35),
    'boingSmall': lambda e: (boing(260, .4, .35), .35),
    'crouch': lambda e: (rubber_creak(.18, 160, 110), .25),
    'bow': lambda e: (cloth(.3, 700, 3500), .3),
    'grabRim': lambda e: (seq([(0, woodblock(1300, .1)), (0, X.thump(.5, 160) * .5)], .2), .45),
    'irisPull': lambda e: (seq([(0, ratchet(e['d'])), (0, zip_(e['d'], 300, 1800) * .6)], e['d'] + .05), .38),
    'irisThunk': lambda e: (seq([(0, X.thump(1, 90)), (0, bp(nz(.2), 400, 2000) * env_exp(.2, .05) * .5)], .3), .5),
    'wordHop': lambda e: (seq([(0, woodblock(1900, .05) * .6), (0, X.pop() * .35)], .12), .4),
    'hatPop': lambda e: (seq([(0, boing(330, .35, .4)), (0, metal(1.1, .25) * .45)], .4), .4),
    'blink': lambda e: (norm(partials([3600, 5400], .05, [.008, .005])), .2),
}
for e in E:
    if e['type'] == 'cue': continue
    x, g = RECIPES[e['type']](e)
    add(FX, np.asarray(x, dtype=np.float64), e['t'], g, {'snore': .35, 'shiver': .3, 'curtain': -.4}.get(e['type'], 0))

mus, msr = sf.read(os.path.join(HERE, 'music', 'score.wav'))
if mus.ndim == 1: mus = np.stack([mus, mus], 1)
mus = np.pad(mus[:N], ((0, max(0, N - len(mus))), (0, 0)))

# ———————————————— 1930s optical soundtrack ————————————————
def optical(x):
    y = np.stack([hp(lp(x[:, c], 6200, 2), 110, 1) for c in range(2)], 1)   # first-order high-pass keeps the tuba's body
    tt = np.arange(N) / SR; dl = (.00035 * np.sin(2 * np.pi * .6 * tt) + .00008 * np.sin(2 * np.pi * 7 * tt)) * SR
    idx = np.clip(np.arange(N) - 40 + dl, 0, N - 1); i0 = idx.astype(int); fr = idx - i0; i1 = np.minimum(i0 + 1, N - 1)
    y = y[i0] * (1 - fr)[:, None] + y[i1] * fr[:, None]
    return np.tanh(y * 1.4) / np.tanh(1.4)
bus = optical(mus * 1.0 + FX * .85)
# the only sound inside the silence: hiss, crackle, the projector gate at 24 Hz
hiss = bp(R.standard_normal(N), 800, 6000) * .004
crk = np.zeros(N)
for p in (R.random(int(DUR * 9)) * (N - 200)).astype(int): L_ = R.integers(8, 60); crk[p:p + L_] += R.standard_normal(L_) * np.exp(-np.arange(L_) / 10) * (.02 + R.random() * .05)
crk = hp(crk, 900)
proj = np.zeros(N); per = SR / 24
for k in range(int(DUR * 24)): s = int(k * per); c = hp(R.standard_normal(200), 1500) * np.exp(-np.arange(200) / 30); proj[s:s + 200] += c[:max(0, min(200, N - s))] * .014
proj += lp(R.standard_normal(N), 180) * .006
BED[:, 0] = hiss + crk + proj; BED[:, 1] = hiss * .9 + crk + proj * .95
mix = bus + BED
for c in range(2): mix[:, c] = X.limit(mix[:, c], .95)
mix = mix / np.abs(mix).max() * .89
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
def db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
sil = slice(int(json.load(open(os.path.join(HERE, 'timeline.json')))['h']['stop'] * SR) + 2400, int(13.0 * SR) - 240)
print('mix.wav', round(DUR, 3), 's | music', round(db(mus), 1), 'dB | fx', round(db(FX), 1), 'dB | silence window', round(db(mix[sil]), 1), 'dB vs overall', round(db(mix), 1), 'dB')
