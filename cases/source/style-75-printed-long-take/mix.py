"""雪夜小站 — score, foley and ambience, on the grid of timeline.js (60 BPM, 5/4, one bar = 5 s).
Reads events.json (window.EV, exported by core/render/events.mjs) and writes out/mix.wav (48 kHz stereo, exactly the
film length, about -16 LUFS before the master) plus out/score.json (every scored onset, for tools/cuecheck.py).
Run from anywhere:  $LIB/.venv/bin/python mix.py
Three layers. The world: wind in three weights, falling snow, the wires, the engine's boiler and its chuffs, a carriage
creak, a match, a paper lantern. The print: the sheet torn by the steam, the block landing in the sky, the knife, the
press. Music: real samples (VSCO 2 CE / VCSL, CC0) and modelled harp (pluck.py): a far bell, a double-bass pedal and
pizzicato in 3+2, hand chimes, sleigh bells; the first melodic note when the red wakes; silence; the great bell."""
import os, sys, json, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio import sampler as S, pluck as P, sfx as X
from core.audio.sfx import SR, limit, noise, bp, lp, hp, env_exp, t_, norm, thump, brown, whoosh, creak, click

X._rng = np.random.default_rng(75); S.seed(75); R = np.random.default_rng(1919)
E = json.load(open(os.path.join(HERE, 'events.json'))); DUR = E['dur']; EV = E['ev']; N = int(round(DUR * SR))
ev = lambda ty: [e['t'] for e in EV if e['type'] == ty]
one = lambda ty: ev(ty)[0]
tt = np.arange(N) / SR
amb = np.zeros((N, 2), np.float32); fx = np.zeros((N, 2), np.float32); mus = np.zeros((N, 2), np.float32)
SCORE = []   # (t, what) of every onset that must sit on a cue

def add(buf, x, at, gain=1.0, pan=0.0):
    if x.ndim == 1: return X.add(buf, x, at, gain, pan)
    s = int(round(at * SR)); e = min(len(buf), s + len(x))
    if e > s >= 0: buf[s:e] += x[:e - s] * gain
def env(a, b, fi=.3, fo=.3):
    return np.clip((tt - a) / max(fi, 1e-3), 0, 1) * np.clip((b - tt) / max(fo, 1e-3), 0, 1)
def st(x, g=1., pan=0.):
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    return np.stack([x * l * g, x * r * g], 1).astype(np.float32)
def fit(x): y = np.zeros(N, np.float32); n = min(N, len(x)); y[:n] = x[:n]; return y

SIL0, SIL1 = ev('silence')[0], ev('bell')[0]
# the near-silence: everything but a breath of wind falls to about -40 dB, fast, and comes back with the bell
SCORE.append((SIL0, 'cut to silence'))
gate = 1 - (1 - 10 ** (-40 / 20)) * np.clip((tt - SIL0) / .22, 0, 1) * (tt < SIL1)
gate_amb = 1 - (1 - 10 ** (-15 / 20)) * np.clip((tt - SIL0) / .3, 0, 1) * (tt < SIL1)   # a breath of wind stays

# ================================================================== the world
w1 = fit(hp(lp(brown(DUR + .1), 320), 70)) * .3                                   # low wind, the weight of the night
w2 = noise(DUR + .1)[:N]
mid = bp(w2, 350, 1600) * (.5 + .5 * np.sin(2 * np.pi * tt / 6.3 + 1) ** 2) * .16   # wind in the wires and the trees
hiss = hp(noise(DUR + .1)[:N], 5200) * .025                                # snow falling
wind = (w1 + mid + hiss)
wind_g = (1 - .45 * env(7.6, 10.0, .2, .6)) * (1 - .3 * env(10.0, 13.0, .5, .3)) * (1 + .5 * env(15.0, DUR, 1.5, .4))
amb += st(wind * wind_g * gate_amb, 1., -.15) + st(np.roll(wind, 7000) * wind_g * gate_amb, .8, .25)
# the telegraph wires: a soft electric hum with a slow beat, near the poles only
hum = sum(a * np.sin(2 * np.pi * f * tt + p) for f, a, p in [(100, .5, 0), (150.7, .3, 1), (201.3, .22, 2), (302, .1, 3)])
hum *= (.6 + .4 * np.sin(2 * np.pi * .7 * tt)) * env(0, 7.6, .4, .8) * .02
amb += st(hum, 1., -.6)
# the engine's boiler: a low roar and a hiss that grow as the station comes near; muffled in the steam, then beside us
boil = fit(hp(lp(brown(DUR + .1), 160), 55)) * .5 + bp(noise(DUR + .1)[:N], 1500, 6000) * .05
boil_g = np.clip((tt - 1.0) / 6.5, 0, 1) ** 2 * (1 - np.clip((tt - 8.3) / 1.6, 0, 1) * .8) * (1 - .9 * np.clip((tt - 12.5) / 1, 0, 1))
amb += st(boil * boil_g * .5 * gate, 1., .35)

# ================================================================== foley, from the picture's events
def pole_pass(v=1.):   # a telegraph pole rushing past the left of the lens: a swept whoosh with a low thud of air
    d = .5; x = whoosh(d, 1.) * .7; y = lp(noise(d), 180) * np.sin(np.pi * t_(d) / d) ** 6
    return norm(x + y * 2.5) * v
for i, t in enumerate(ev('pole')): add(fx, st(pole_pass(), .38 + .04 * i, -.7), t - .25); SCORE.append((t, 'pole'))
def chuff(v=1.):       # the engine exhales: a hard burst of steam with a thump in the chest
    d = .42; s = t_(d)
    x = bp(noise(d), 280, 5200) * np.minimum(1, s / .008) * np.exp(-s / .12) + hp(noise(d), 3000) * np.exp(-s / .2) * .4
    th = thump(1, 58); m = min(len(th), len(x)); x[:m] += th[:m] * .8
    return norm(x, 1.) * v
for i, t in enumerate(ev('chuff')): add(fx, st(chuff(), .32 + .055 * i, .3), t); SCORE.append((t, 'chuff'))
# through the steam: a roar of white, and the print's own sound, a sheet torn away, peaking on the beat
wp = one('whitePeak')
d = .7; s = t_(d); roar = bp(noise(d), 500, 7000) * np.sin(np.pi * s / d) ** 2
add(fx, st(norm(roar), .45, 0), wp - .45)
def tear(v=1.):
    d = .34; s = t_(d); x = bp(noise(d), 900, 7000) * (np.random.default_rng(3).random(len(s)) > .45) * np.sin(np.pi * s / d) ** .5
    return norm(x, 1.) * v
add(fx, st(tear(), .55, .1), wp - .17); SCORE.append((wp, 'tear'))
add(fx, st(creak(1.), .4, .45), one('creak')); add(fx, st(creak(1.), .2, .5), one('creak') + .27); SCORE.append((one('creak'), 'creak'))
# the match: a scrape, then the small breath of a flame
wk = one('wick')
add(fx, st(norm(hp(noise(.09), 2200) * env_exp(.09, .025)), .35, .2), wk)
add(fx, st(norm(lp(noise(.5), 900) * np.sin(np.pi * t_(.5) / .5) ** 2), .22, .2), wk + .03); SCORE.append((wk, 'match'))
# the paper lantern opens: a crinkle of paper ribs
def crinkle(d=.45, v=1.):
    s = t_(d); x = bp(noise(d), 1400, 7500) * (np.random.default_rng(11).random(len(s)) > .82) * np.exp(-s / (d * .5))
    return norm(x, 1.) * v
add(fx, st(crinkle(), .3, .2), one('body')); SCORE.append((one('body'), 'paper'))
add(fx, st(click(.6, 1.), .12, .2), one('done')); SCORE.append((one('done'), 'hook'))
# the rise: a long soft rush of air
add(fx, st(whoosh(2.2, 1.), .14, -.1), SIL1 + .2)
# the print in the sky
def block(v=1.):
    # a wooden block of type slapped down on the bed: the low body of the block, and a hard wood-on-wood strike whose
    # attack is inside a millisecond (so the print lands as crisply as the bell rings)
    x = thump(1, 62).copy(); y = lp(noise(.25), 400) * env_exp(.25, .05) * .5; x[:len(y)] += y[:len(x)]
    d = .14; s = t_(d)
    slap = bp(noise(d), 700, 6000) * np.minimum(1, s / .0008) * np.exp(-s / .016)
    body = sum(a * np.sin(2 * np.pi * f * s) * np.minimum(1, s / .0008) * np.exp(-s / tau) for f, a, tau in [(290, .9, .05), (690, .55, .024), (1580, .35, .011)])
    k = slap * 1.3 + body; x[:len(k)] += k * 1.6
    return norm(x, 1.) * v
def scrape(d, v=1., f0=2500, f1=6000):
    s = t_(d); x = bp(noise(d), f0, f1) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 37 * s)))
    return norm(x * np.minimum(1, s / .006) * np.minimum(1, (d - s) / .03), 1.) * v
def chip(): d = .1; return norm(hp(noise(d), 2500) * env_exp(d, .01) + np.sin(2 * np.pi * 3100 * t_(d)) * env_exp(d, .004) * .4)
add(fx, st(block(), .85, -.2), one('block')); SCORE.append((one('block'), 'block'))
add(fx, st(S.note('woodblock', None, .5, vel=.95, var='a'), .5, -.25), one('block'))      # real wood (VCSL), on the same sample
add(fx, st(S.note('log_drum', None, 1., vel=.9, var='lo'), .45, -.15), one('block'))
for i, t in enumerate(ev('knife')):
    add(fx, st(scrape(.13, 1., 2600, 7800), .34, -.25 + i * .05), t); add(fx, st(chip(), .07, -.2), t + .1); SCORE.append((t, 'knife'))
pr = one('press')
add(fx, st(thump(1, 46), .6, -.1), pr); add(fx, st(X.clack(.7, 1.), .28, -.1), pr); add(fx, st(lp(noise(.35), 240) * env_exp(.35, .08), .35, -.1), pr); SCORE.append((pr, 'press'))
fx *= gate[:, None]

# ================================================================== music: 60 bpm, 5/4 (3+2)
sc = []
def n(t, inst, p, d, v, pan=0., g=1., **kw):
    sc.append(dict(t=t, inst=inst, pitch=p, dur=d, vel=v, pan=pan, gain=g, **kw))
bf = one('bellFar')
# bar 1 — the rails: the pedal, pizzicato on 1 and 4 (3+2), hand chimes, and the far bell (rendered apart, far away)
n(0, 'contrabass', 'D2', SIL0 + .1, .34, 0, .55, attack=.6)
n(5, 'contrabass', 'A2', SIL0 - 5 + .1, .24, .15, .4, attack=1.2)
for t, p in [(0, 'D2'), (3, 'A1')]: n(t, 'contrabass_pizz', p, 1.4, .55, -.1, .9); SCORE.append((t, 'pizz'))
for t, p in [(2, 'A5'), (4, 'F5')]: n(t, 'hand_chimes', p, 2.4, .26, .35, .55); SCORE.append((t, 'chime'))
# bar 2 — the steam: the pizzicato doubles every chuff (quarter, eighth, sixteenth), sleigh bells shake, then everything stops
for i, t in enumerate(ev('chuff')):
    n(t, 'contrabass_pizz', ['D2', 'A1', 'D2', 'A1', 'C2', 'D2', 'E2'][i], .5, .5 + .05 * i, -.1, .85); SCORE.append((t, 'pizz'))
for t, v in [(6, .3), (7, .42), (ev('chuff')[4], .5)]: n(t, 'sleighbells', None, None, v, .45, .55); SCORE.append((t, 'bells'))
for t, p, v in [(8, 'D2', .42), (9, 'A1', .32)]: n(t, 'contrabass_pizz', p, 1.6, v, -.1, .85); SCORE.append((t, 'pizz'))
# bar 3 — one red waking: the first melodic notes (glockenspiel over a modelled harp), A – D – F#, the turn to major
melody = [(one('wick'), 'A5', 'A4'), (one('body'), 'D6', 'D5'), (one('done'), 'F#6', 'F#5')]
for t, gp, hp_ in melody: n(t, 'glockenspiel', gp, 2.0, .32, .25, .6); SCORE.append((t, 'melody'))
for i, p in enumerate(['D4', 'A4', 'F#5']): n(one('done') + i * .02, 'vibraphone_bowed', p, SIL0 - one('done') + .2, .3, -.3 + .3 * i, .5, attack=.25)
# bar 4 — the great bell after the silence, the horn, a harp note under every knife, the D major chord on the press
B0 = one('bell')
n(B0, 'tubular_bells', 'D4', 4.5, 1.0, -.05, 2.2); n(B0 + .02, 'tubular_bells', 'A4', 4.0, .5, .2, .8)
n(B0, 'timpani', 'D2', 2.5, .95, 0, 1.4); n(B0, 'gran_cassa', None, None, .75, 0, 1.0); n(B0, 'gong', None, None, .4, .1, .6)
n(B0, 'contrabass', 'D2', DUR - B0, .42, 0, .6, attack=.03); SCORE.append((B0, 'bell'))
n(B0 + .6, 'horn', 'D3', 2.3, .42, -.2, .7, attack=.4); n(pr, 'horn', 'F#3', DUR - pr, .45, -.2, .7, attack=.15)
n(one('block'), 'contrabass_pizz', 'D2', 1.2, .55, -.1, .8); SCORE.append((one('block'), 'pizz'))
for i, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4']): n(pr + i * .045, 'harp', p, 1.6, .5, -.3 + .15 * i, .6)
for i, p in enumerate(['D6', 'A5']): n(pr, 'hand_chimes', p, 1.5, .3, .3 - .5 * i, .55)
n(pr, 'vibraphone_bowed', 'F#5', DUR - pr, .26, .3, .45, attack=.2)
SCORE.append((pr, 'chord'))
mus += S.render(sc, dur=DUR + .05)[:N]   # a hair long, then cut: DUR*SR rounds down inside render
# modelled harp: under the lantern melody and on every knife stroke
harp = np.zeros((N, 2), np.float32)
for t, gp, hp_ in melody: add(harp, P.pluck('harp', hp_, 2.4, vel=.62), t, .55, -.2)
for i, t in enumerate(ev('knife')): add(harp, P.pluck('harp', ['D4', 'F#4', 'A4', 'D5', 'F#5'][i], 1.6, vel=.6), t, .5, -.15 + .08 * i)
mus += harp
# the far bell at the very start: rung once, high-cut, swimming in a big room
far = np.zeros((N, 2), np.float32)
add(far, S.note('tubular_bells', 'D4', 6.0, vel=.6), bf, 1., -.3); add(far, S.note('tubular_bells', 'A4', 5.0, vel=.35), bf + .015, .6, -.35)
far = np.stack([lp(far[:, 0], 1800), lp(far[:, 1], 1800)], 1).astype(np.float32)
far = S.room(far, size=.95, mix=.55); SCORE.append((bf, 'farbell'))
mus = S.room(mus, size=.6, mix=.24) + far * .55
# the steam stops the music dead for a beat; the silence takes everything, then the bell
mus *= (1 - env(wp - .15, wp + .05, .1, .05))[:, None]
mus *= gate[:, None]
fx = S.room(fx, size=.3, mix=.1)

# ================================================================== mix
mus = np.stack([hp(mus[:, 0], 38), hp(mus[:, 1], 38)], 1).astype(np.float32)
mix = mus * .7 + fx * .85 + amb * .5
# tame the low shelf: everything under ~110 Hz a few dB down, the rest untouched
low = np.stack([lp(mix[:, 0], 110, 2), lp(mix[:, 1], 110, 2)], 1)
mix = (mix - low * .55).astype(np.float32)
tail = np.clip((DUR - tt) / .9, 0, 1) ** 1.3; head = np.clip(tt / .02, 0, 1)
mix *= (tail * head)[:, None]
# low-end check: 20–120 Hz vs the rest
def band_db(x, lo, hi): y = bp(x.mean(1), lo, hi, 4); return 10 * np.log10(np.mean(y ** 2) + 1e-12)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
tmp = os.path.join(HERE, 'out', 'mix.wav')
def lufs(x):
    sf.write(tmp, x, SR, subtype='PCM_24')
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = float(out.split('Integrated loudness:')[1].split('I:')[1].split('LUFS')[0]); Pk = float(out.split('True peak:')[1].split('Peak:')[1].split('dBFS')[0])
    return I, Pk
for _ in range(3):
    I, Pk = lufs(limit(mix, .6)); mix *= 10 ** ((-16 - I) / 20)
base, ceil = mix.copy(), -2.2
for _ in range(14):
    mix = limit(base, 10 ** (ceil / 20)); I, Pk = lufs(mix)
    mix *= 10 ** ((-16 - I) / 20); mix = limit(mix, 10 ** (ceil / 20)); I, Pk = lufs(mix)
    if Pk <= -3.3: break
    ceil -= .5
assert len(mix) == N
lo, rest = band_db(mix, 25, 120), band_db(mix, 120, 8000)
sil = mix[int((SIL0 + .4) * SR):int((SIL1 - .05) * SR)]; loud = mix[int(15.0 * SR):int(16.0 * SR)]
rms = lambda x: 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)
print(f'out/mix.wav  {DUR:.2f} s  {I:.1f} LUFS  true peak {Pk:.1f} dBFS  low band {lo - rest:+.1f} dB vs rest  silence {rms(sil):.1f} dBFS rms, bell {rms(loud):.1f} dBFS rms')
json.dump(sorted(SCORE), open(os.path.join(HERE, 'out', 'score.json'), 'w'))
print('\n'.join(S.credits(sorted({e['inst'] for e in sc} | {'tubular_bells'}))))
