"""Score + foley + ambience → out/mix.wav (48 kHz stereo), stems in out/stems/, music onsets in out/score_onsets.json.
Every note time comes from the tempo map in timeline.json (computed here independently of the page);
every foley time comes from events.json (exported from the page's window.EV). cuecheck.py compares the two.
Run with the library's venv:  $LIB/.venv/bin/python mix.py
"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or os.path.expanduser('~/lemo-opuscar')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P, sfx as X
from core.audio.sfx import SR, add, bp, lp, hp, noise, t_, env_exp, norm
from scipy.signal import butter, sosfilt

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = TL['dur']; N = int(round(DUR * SR)) + SR // 2
SECS = {s['id']: s for s in TL['secs']}
rng = np.random.default_rng(2024); S.seed(11)


def at(sec, bar, beat=1, frac=0.0):
    s = SECS[sec]; return s['t0'] + ((bar - 1) * s['meter'] + (beat - 1) + frac) * 60.0 / s['bpm']


def beat(sec): return 60.0 / SECS[sec]['bpm']


# ————————————————————————— instruments —————————————————————————
def hum(pitch, dur, vel=.6, vowel='m', vib=.22):
    """A child's hummed note ('mm' / 'oo'): band-limited glottal source → formant filters → nasal low-pass."""
    f0 = S.hz(pitch); n = int((dur + .3) * SR); tt = np.arange(n) / SR
    vibr = 1 + (2 ** (vib / 12) - 1) * np.sin(2 * np.pi * 5.2 * tt) * np.clip((tt - .22) / .3, 0, 1)
    drift = 1 + .003 * np.sin(2 * np.pi * .7 * tt + rng.random() * 6)
    ph = 2 * np.pi * np.cumsum(f0 * vibr * drift) / SR
    src = np.zeros(n)
    for k in range(1, 40):
        if k * f0 > 5000: break
        src += np.sin(k * ph) / k ** 1.35
    breath = bp(rng.standard_normal(n), 900, 3200) * .025
    F = [(330, 90, 1.0), (920, 140, .45), (2700, 300, .08)] if vowel == 'm' else [(420, 90, 1.0), (1050, 140, .55), (2800, 300, .12)]
    out = np.zeros(n)
    for fc, bw, g in F:
        out += bp(src, max(60, fc - bw), fc + bw, 2) * g
    out = lp(out + breath, 1900 if vowel == 'm' else 2600, 2)
    env = np.minimum(1, tt / .07) * np.clip((dur + .25 - tt) / .25, 0, 1)
    return norm(out * env).astype(np.float32) * vel


EVT = []          # (t, inst, pitch, dur, vel, pan, gain)
SYN = []          # (t, mono buffer, gain, pan) for synthesized voices
ONSETS = {}       # cue tag → music onset time (the note that is meant to land with that picture hit)


def nt(t, inst, pitch, dur, vel, pan=0., gain=1., tag=None):
    EVT.append((t, inst, pitch, dur, vel, pan, gain))
    if tag: ONSETS.setdefault(tag, round(t, 6))


def syn(t, buf, gain=1., pan=0., tag=None):
    SYN.append((t, buf, gain, pan))
    if tag: ONSETS.setdefault(tag, round(t, 6))


def mbox(t, pitch, vel=.7, pan=.1, gain=1., tag=None):
    syn(t, P.pluck('music_box', pitch, 2.2, vel), gain, pan, tag)


def uke_chord(t, notes, vel=.5, pan=.25, strum=.018, gain=1., tag=None):
    for i, p in enumerate(notes): nt(t + i * strum, 'ukulele', p, .55, vel * (1 - .06 * i), pan, gain, tag if i == 0 else None)


# ————————————————————————— A: drawing the boat (3/4, 90, C major) —————————————————————————
b = beat('A')
for bar, root, chord in [(1, 'C3', ['C4', 'E4', 'G4']), (2, 'G2', ['B3', 'D4', 'G4'])]:
    nt(at('A', bar, 1), 'bassoon_stac', root, .4, .5, -.25, .8)
    for bt in (2, 3): uke_chord(at('A', bar, bt), chord, .38, .3)
# theme, first phrase only (music box): E G C' | B . A G
for (bar, bt, fr, p, tag) in [(1, 1, 0, 'E5', 'hull'), (1, 2, 0, 'G5', 'sail'), (1, 3, 0, 'C6', 'flag'),
                              (2, 1, 0, 'B5', 'eyes'), (2, 2, .5, 'A5', None), (2, 3, 0, 'G5', 'ripple')]:
    mbox(at('A', bar, bt, fr), p, .75, .15, 1.0, tag)
    syn(at('A', bar, bt, fr), hum(p.replace('5', '4').replace('6', '5'), b * .95, .5), .35, -.2)
nt(at('A', 2, 1), 'glockenspiel', 'G6', 1.0, .55, .3, .8)                     # the eyes pop open
for k, tag in enumerate(['pud0', 'pud1', 'pud2', 'pud3']):                   # colouring the puddle: shaker on the eighths
    nt(at('A', 2, 1, .5 * k), 'shaker', 'down' if k % 2 == 0 else 'up', None, .45, -.3, .7, tag)
for k in range(8):
    nt(at('A', 1, 1, .5 * k), 'shaker', 'down' if k % 2 == 0 else 'up', None, .22, -.35, .55)

# ————————————————————————— B: the storm (4/4, 120 — faster; A minor) —————————————————————————
b = beat('B')
bass = [('A2', 1, 1), ('E3', 1, 2), ('A2', 1, 3), ('E3', 1, 4), ('F2', 2, 1), ('C3', 2, 2), ('F2', 2, 3), ('C3', 2, 4), ('E2', 3, 1), ('E2', 3, 2)]
for p, bar, bt in bass:
    nt(at('B', bar, bt), 'bassoon_stac', p, .3, .7 if bt in (1, 3) else .55, -.2, 1.35)
nt(at('B', 1, 1), 'clarinet', 'A3', 1.9, .5, .25, 1.3, 'cloud0')
nt(at('B', 2, 1), 'clarinet', 'C4', .95, .5, .25, 1.2)
nt(at('B', 2, 3), 'clarinet', 'B3', .95, .5, .25, 1.2)
nt(at('B', 3, 1), 'clarinet', 'G#3', .85, .5, .25, 1.15, 'sink')
for bar, bt, tag in [(1, 2, 'cloud1'), (1, 3, 'cloud2'), (1, 4, 'frown')]:
    nt(at('B', bar, bt), 'woodblock', 'a' if bt != 4 else 'b', None, .5, .4, .7, tag)
nt(at('B', 1, 1), 'frame_drum', 'large_muted', None, .55, -.1, .8)
nt(at('B', 2, 1), 'gran_cassa', 'hit', None, .55, 0, .9, 'wash')
nt(at('B', 2, 1), 'sus_cymbal', 'roll', None, .3, .2, .5)
# rain on the glockenspiel: sixteenths in A minor pentatonic, getting denser (the acceleration), cut at the sink
pent = ['A5', 'C6', 'D6', 'E6', 'G6', 'A6', 'C7']
for k in range(int(round((at('B', 3, 1) - at('B', 2, 1)) / (b / 4)))):
    t = at('B', 2, 1, k / 4); u = k / 32
    if rng.random() < .25 + .75 * u * u or k % 4 == 0:
        nt(t, 'glockenspiel', pent[rng.integers(len(pent))], .3, .22 + .22 * u, rng.uniform(-.6, .6), .55)
for i, (bar, bt, fr) in enumerate([(2, 2, 0), (2, 2, .5), (2, 3, 0), (2, 3, .5), (2, 4, 0), (2, 4, .5)]):   # the six big drops
    nt(at('B', bar, bt, fr), 'xylophone', ['E6', 'C6', 'A5', 'E6', 'D6', 'A5'][i], .4, .62, -.5 + i * .2, 1.0, f'drop{i}')
for i, (bar, bt) in enumerate([(2, 2), (2, 3), (2, 4), (3, 2)]):                    # the boat rocks: a low pizz under each creak
    nt(at('B', bar, bt), 'jazz_bass', ['A1', 'F1', 'C2', 'E1'][i], .5, .55, 0, .9, f'rock{i}' if i < 3 else 'rock3')
for k in range(16):                                                               # shaker sixteenths through the storm
    t = at('B', 2, 1, k / 4)
    nt(t, 'shaker', 'down' if k % 2 == 0 else 'up', None, .18 + .12 * (k / 16), .35, .5)
# 9.0–10.0: nothing at all (the drip is foley)

# ————————————————————————— C: the sun (3/4, 90 again — slower; C major) —————————————————————————
b = beat('C')
t0 = at('C', 1, 1)
# THE sound: the first major chord after the silence
for p, v in [('C6', .85), ('E6', .8), ('G6', .8), ('C7', .65)]: nt(t0, 'glockenspiel', p, 2.5, v, .25, 1.0, 'sun' if p == 'C6' else None)
for p in ['C4', 'E4', 'G4', 'C5']: nt(t0, 'vibraphone_hard', p, 2.4, .72, -.15, .9)
uke_chord(t0, ['C4', 'E4', 'G4', 'C5'], .8, .3, .022, 1.1)
nt(t0, 'bassoon', 'C3', 1.9, .55, -.2, .9)
nt(t0, 'gran_cassa', 'hit', None, .6, 0, .9)
nt(t0, 'sus_cymbal', 'bell', None, .45, .3, .6)
for p in ['C4', 'E4', 'G4']: syn(t0, hum(p, 2.0, .6, 'oo'), .32, rng.uniform(-.4, .4))
for p in ['C5', 'E5']: syn(t0, hum(p, 2.0, .45, 'oo', .3), .2, rng.uniform(-.5, .5))
# harmony per bar: C | F | C | F→G | C
HAR = {1: ('C3', ['C4', 'E4', 'G4']), 2: ('F2', ['A3', 'C4', 'F4']), 3: ('C3', ['C4', 'E4', 'G4']), 4: ('F2', ['A3', 'C4', 'F4'])}
for bar, (root, ch) in HAR.items():
    if bar > 1: nt(at('C', bar, 1), 'bassoon_stac', root, .4, .55, -.25, .9)
    for bt in (2, 3):
        c = ['B3', 'D4', 'G4'] if (bar == 4 and bt == 3) else ch
        uke_chord(at('C', bar, bt), c, .42, .3, .016, 1.0, 'lift' if (bar == 4 and bt == 3) else None)
        nt(at('C', bar, bt), 'claps', 'group', None, .38, -.15, .6)
    for k in range(6): nt(at('C', bar, 1, .5 * k), 'shaker', 'down' if k % 2 == 0 else 'up', None, .2, -.4, .5)
    if bar > 1: syn(at('C', bar, 1), np.sum([hum(p, b * 2.9, .4, 'oo') for p in ch], axis=0) / 3, .28, 0)
# the yellow crayon's scribbles get a little uke chop on the "and"s
for tag, (bar, bt, fr) in [('sw0', (1, 1, .5)), ('sw1', (1, 2, 0)), ('sw2', (1, 2, .5))]:
    nt(at('C', bar, bt, fr), 'xylophone', {'sw0': 'G5', 'sw1': 'C6', 'sw2': 'E6'}[tag], .3, .42, .4, .6, tag)
nt(at('C', 1, 3), 'glockenspiel', 'G6', 1.5, .7, .35, .9, 'sunface')
nt(at('C', 1, 3), 'glockenspiel', 'C7', 1.5, .55, .45, .7)
for k, p in enumerate(['C6', 'D6', 'E6', 'G6']):                                  # rays: a quick xylophone run
    nt(at('C', 1, 3, .5 + k * .125), 'xylophone', p, .25, .4, .5, .6, 'ray' if k == 0 else None)
nt(at('C', 2, 1), 'bassoon_stac', 'F2', .4, .55, -.25, .9, 'pull')
for i, p in enumerate(['C6', 'D6', 'E6', 'G6', 'A6', 'C7']):                      # each drop coloured = one note, rising
    nt(at('C', 2, 1, i * .5), 'glockenspiel', p, 1.2, .62, -.6 + i * .12, .9, f'col{i}')
for i, p in enumerate(['C5', 'E5', 'G5', 'A5', 'C6', 'E6']):                      # each rainbow band = one note, rising
    nt(at('C', 3, 1, i * .5), 'xylophone', p, .5, .55, -.5 + i * .2, .85, f'band{i}')
# the theme, in full, once: recorder (with the hum an octave down)
mel = [((3, 1, 0), 'E5', 1), ((3, 2, 0), 'G5', 1), ((3, 3, 0), 'C6', 1), ((4, 1, 0), 'D6', 1), ((4, 2, 0), 'C6', .5), ((4, 2, .5), 'B5', .5),
       ((4, 3, 0), 'A5', .5), ((4, 3, .5), 'G5', .5), ((5, 1, 0), 'C6', 2.6)]
for (bar, bt, fr), p, d in mel:
    t = at('C', bar, bt, fr)
    tag = {(3, 1, 0): 'sailaway', (4, 1, 0): 'under', (5, 1, 0): 'land'}.get((bar, bt, fr))
    nt(t, 'recorder', p, d * b * .95, .62, -.1, 1.0, tag)
    syn(t, hum(p.replace('6', '5') if '6' in p else p.replace('5', '4'), d * b * .95, .45, 'oo'), .22, .2)
# the end: C chord, rings out; one music-box note when 完 is finished
tE = at('C', 5, 1)
uke_chord(tE, ['C4', 'E4', 'G4', 'C5'], .7, .25, .03, 1.0)
for p in ['C4', 'G4', 'E5']: nt(tE, 'vibraphone', p, 1.7, .55, -.1, .8)
nt(tE, 'bassoon', 'C3', 1.6, .45, -.2, .8)
nt(tE, 'glockenspiel', 'C7', 1.7, .5, .3, .7)
for p in ['C4', 'E4', 'G4']: syn(tE, hum(p, 1.5, .45, 'm'), .25, 0)
mbox(at('C', 5, 2), 'G6', .6, .2, .9, 'wan')

# ————————————————————————— render the score —————————————————————————
def render_score():
    mus = S.render([(t, i, p, d, v, pn, g) for (t, i, p, d, v, pn, g) in EVT], dur=N / SR, master=False)
    mus = mus[:N] if len(mus) >= N else np.pad(mus, ((0, N - len(mus)), (0, 0)))
    for t, buf, g, pn in SYN: add(mus, buf, t, g, pn)
    return mus.astype(np.float32)


# ————————————————————————— foley (from window.EV) —————————————————————————
def stickslip(dur, speed=.8, heavy=0.):
    """Crayon on paper: stick-slip grains whose rate follows the stroke speed, band-passed noise + a little paper body."""
    n = int(dur * SR); out = np.zeros(n)
    rate = 70 + 110 * speed; t = 0.0
    while t < dur:
        s = int(t * SR); L = int(.006 * SR)
        g = rng.standard_normal(min(L, n - s)) * np.exp(-np.arange(min(L, n - s)) / (.0018 * SR)) * (.5 + rng.random())
        out[s:s + len(g)] += g
        t += (1 / rate) * (.5 + rng.random())
    body = bp(rng.standard_normal(n), 250, 900) * .12 * (1 + heavy)
    x = bp(out, 1400 - 500 * heavy, 6500 - 1500 * heavy) + body
    e = np.minimum(1, np.arange(n) / (.03 * SR)) * np.minimum(1, (n - np.arange(n)) / (.05 * SR))
    return norm(x * e)


def swish(dur=.3, heavy=0.):
    """One back-and-forth colouring stroke: two humps of crayon grain."""
    n = int(dur * SR); tt = np.arange(n) / n
    x = stickslip(dur, .9, heavy)[:n]
    env = np.abs(np.sin(np.pi * tt * 2)) ** .8
    return norm(x * env)


def brush(dur):
    n = int(dur * SR); tt = np.arange(n) / n
    wet = lp(rng.standard_normal(n), 1600) * (.6 + .4 * np.sin(2 * np.pi * 7 * tt))
    bristle = bp(rng.standard_normal(n) * (rng.random(n) > .985), 2200, 6000) * 2
    return norm((wet + bristle) * np.sin(np.pi * tt) ** .7)


def drip():
    d = .35; tt = t_(d); f = 900 * (1 + 1.8 * np.minimum(1, tt / .03))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .045)
    return norm(x + hp(noise(d), 3000) * env_exp(d, .004) * .3)


def plink():
    d = .2; tt = t_(d); f = 1300 * (1 + .9 * np.minimum(1, tt / .02))
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .03))


def splash():
    d = .7; tt = t_(d)
    x = lp(noise(d), 3500) * env_exp(d, .12) + bp(noise(d), 300, 1200) * env_exp(d, .08) * .6
    bub = sum(np.sin(2 * np.pi * np.cumsum(np.full(len(tt), f) * (1 + .5 * tt)) / SR) * env_exp(d, .05) * (tt > o) for f, o in [(500, .08), (700, .16), (420, .24)])
    return norm(x + bub * .3)


def rise():
    d = .5; tt = t_(d); f = 260 + 520 * tt / d
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d) * .6 + lp(noise(d), 2000) * env_exp(d, .1) * .4)


def chirp():
    d = .16 + rng.random() * .1; tt = t_(d); f0 = 3200 + rng.random() * 1500
    f = f0 * (1 + .35 * np.sin(np.pi * tt / d) - .2 * tt / d)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d) ** 2


def crinkle(d=.3):
    n = int(d * SR); x = hp(rng.standard_normal(n) * (rng.random(n) > .96) * 3, 1800) + bp(rng.standard_normal(n), 2000, 6000) * .3
    return norm(x * np.sin(np.pi * np.arange(n) / n) ** .5)


def flap():
    d = .3; tt = t_(d)
    return norm(X.thump(1, 85)[:len(tt)] * .8 + hp(noise(d), 1200) * env_exp(d, .015) * .7)


def setdown():
    a = X.clack(.55, 1.0); b2 = X.clack(.5, .5); out = np.zeros(int(.4 * SR)); out[:len(a)] += a; s = int(.11 * SR); out[s:s + len(b2)] += b2[:len(out) - s]
    return norm(lp(out, 5000))


def puff():
    d = .45; tt = t_(d)
    return norm(lp(noise(d), 900) * np.sin(np.pi * tt / d) ** 1.5 + crinkle(.45)[:len(tt)] * .25)


def rainbed(dur, keys):
    n = int(dur * SR); tt = np.arange(n) / SR
    hiss = bp(rng.standard_normal(n), 1500, 9000) * .5 + bp(rng.standard_normal(n), 400, 1500) * .25
    ticks = hp(rng.standard_normal(n) * (rng.random(n) > .9975) * 4, 2500)
    x = (hiss + ticks)
    ks = np.array(keys); env = np.interp(tt, ks[:, 0] - ks[0, 0], ks[:, 1])
    return x * env


def build_foley():
    fol = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32); rain = np.zeros((N, 2), np.float32)
    for e in EVJ['ev']:
        t, ty, pn = e['t'], e['type'], e.get('pan', 0)
        if ty == 'scratch': add(fol, stickslip(e['dur'], e.get('speed', .8)), t, .30, pn)
        elif ty == 'scribble':
            d = e['dur']; k = 0
            while k * .125 < d - .05: add(fol, swish(.2, e.get('heavy', 0) * .5), t + k * .125, .2 + .08 * e.get('heavy', 0), pn); k += 1
        elif ty == 'swish': add(fol, swish(e['dur'], e.get('heavy', 0)), t, .28 * e.get('v', 1), pn)
        elif ty == 'pop': add(fol, X.pop(1.0), t, .30 * e.get('v', 1), pn)
        elif ty == 'brush':
            x = brush(e['dur']); h = len(x) // 2
            for i, seg in enumerate([x[:h], x[h:]]): add(fol, seg, t + i * h / SR, .4, e['pan0'] if i == 0 else e['pan1'])
        elif ty == 'thunder': add(amb, X.rumble(2.6, 1.0), t - .05, .55, 0)
        elif ty == 'rain': x = rainbed(e['t1'] - t + .2, e['keys']); add(rain, x, t, .085, -.3); add(rain, np.roll(x, 3000), t, .085, .3)
        elif ty == 'plink': add(fol, plink(), t, .12, pn)
        elif ty == 'creak': add(fol, X.creak(1.0), t, .22 * e.get('v', 1), pn)
        elif ty == 'splash': add(fol, splash(), t, .45, pn)
        elif ty == 'drip':
            d = drip(); add(fol, d, t, .13, pn); add(fol, d * .25, t + .09, .13, -pn)
        elif ty == 'blink': add(fol, X.click(1.6, .6), t, .06, pn)
        elif ty == 'zip': add(fol, X.whoosh(.22, 1.0), t - .02, .22, pn)
        elif ty == 'rise': add(fol, rise(), t, .22, pn)
        elif ty == 'birds':
            tb = t
            while tb < e['t1'] - .3:
                add(amb, chirp(), tb, .045, rng.uniform(-.8, .8))
                if rng.random() < .5: add(amb, chirp(), tb + .12, .035, rng.uniform(-.8, .8))
                tb += .45 + rng.random() * .7
        elif ty == 'tick': add(fol, swish(e.get('dur', .3), .2), t, .2, pn)
        elif ty == 'swipe':
            x = stickslip(e['dur'], 1.0, .3); h = len(x) // 2
            add(fol, x[:h], t, .26, e['pan0']); add(fol, x[h:], t + h / SR, .26, e['pan1'])
        elif ty == 'paddle':
            d = e['t1'] - t; n = int(d * SR); tt = np.arange(n) / SR
            add(amb, lp(rng.standard_normal(n), 700) * (.5 + .5 * np.sin(2 * np.pi * .9 * tt)) * np.minimum(1, tt / .5), t, .05, .1)
        elif ty == 'puff': add(fol, puff(), t - .03, .28, pn)
        elif ty == 'lift': add(fol, crinkle(.32), t, .26, pn)
        elif ty == 'whoosh': add(fol, X.whoosh(e['dur'], 1.0), t, .22, pn)
        elif ty == 'flap': add(fol, flap(), t, .40, pn)
        elif ty == 'setdown': add(fol, setdown(), t, .32, pn)
        elif ty == 'write':
            d = e['dur']
            for k, (o, L) in enumerate([(0, .18), (.2, .16), (.38, .26)]):
                if o < d: add(fol, stickslip(L, .7), t + o, .26, 0)
    # room tone (very low) everywhere except the silence keeps only this
    n = N; room = lp(np.cumsum(rng.standard_normal(n)) * .002, 300)
    room = hp(room, 30); room = room / (np.abs(room).max() + 1e-9) * .004
    amb[:, 0] += room; amb[:, 1] += np.roll(room, 977)
    # the rain bed makes room for the music: −3 dB from 7.5 s on, and a further −4.5 dB dip ±120 ms around every drop note and the sink
    tt = np.arange(N) / SR
    db = -3.0 * np.clip((tt - 7.5) / .25, 0, 1)
    hits = [e['t'] for e in EVJ['ev'] if str(e.get('cue', '')).startswith('drop') or e.get('cue') == 'sink']
    dip = np.zeros(N)
    for h in hits:
        w = .12; r = .03                                                   # hold ±120 ms, 30 ms ramps
        dip = np.maximum(dip, np.clip(np.minimum((tt - (h - w - r)) / r, ((h + w + r) - tt) / r), 0, 1))
    db = db - 4.5 * dip
    rain *= (10 ** (db / 20))[:, None]
    amb += rain
    return fol, amb


# ————————————————————————— mix —————————————————————————
def lift_highs(x, f=3000, g=1.3):
    hi = np.stack([hp(x[:, c], f, 2) for c in range(2)], 1); return x + hi * (g - 1)


def tame_lows(x, f=120, cut=.7):
    lo = np.stack([lp(x[:, c], f, 2) for c in range(2)], 1); return x - lo * (1 - cut)


if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
    mus = render_score()
    mus = lift_highs(mus, 3500, 1.25)                # metal voices: a gentle high lift
    mus = tame_lows(mus, 110, .75)
    mus = S.room(mus, size=.32, mix=.16)
    fol, amb = build_foley()
    fol = S.room(fol, size=.18, mix=.10)
    # keep the silence silent: nothing but the room and the drip in 9.0–10.0 (the score is already empty there)
    ts, te = SECS['S']['t0'], SECS['S']['t1']
    i0, i1 = int(ts * SR), int(te * SR)
    tail = np.linspace(1, 0, int(.25 * SR))[:, None]
    mus[i0:i0 + len(tail)] *= tail; mus[i0 + len(tail):i1] = 0           # cut reverb tails into the silence
    mix = mus * 1.0 + fol * .9 + amb * 1.0
    # tame the transient peaks (glock / claps / chord) so the −14 LUFS master keeps its true peak under −1.2 dB
    for c in range(2): mix[:, c] = X.limit(mix[:, c], .42, .003)
    mix *= .9 / max(1e-9, np.abs(mix).max())
    L = int(round(DUR * SR)); mix = mix[:L]
    fade = int(.35 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
    sf.write(os.path.join(HERE, 'out', 'stems', 'music.wav'), mus[:L], SR, subtype='PCM_24')
    sf.write(os.path.join(HERE, 'out', 'stems', 'foley.wav'), fol[:L], SR, subtype='PCM_24')
    sf.write(os.path.join(HERE, 'out', 'stems', 'amb.wav'), amb[:L], SR, subtype='PCM_24')
    json.dump({'onsets': ONSETS, 'notes': sorted(round(e[0], 6) for e in EVT) + sorted(round(s[0], 6) for s in SYN)}, open(os.path.join(HERE, 'out', 'score_onsets.json'), 'w'), indent=0)
    # report: band balance + peak
    def band(x, lo, hi): y = bp(x.mean(1), lo, hi, 2); return 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)
    print('mix.wav', mix.shape, 'peak', round(float(np.abs(mix).max()), 3),
          '| 20–120 Hz', round(band(mix, 20, 120), 1), 'dB · 120–5k', round(band(mix, 120, 5000), 1), 'dB')
    print('music onsets tagged:', len(ONSETS))
    print(S.credits(sorted({e[1] for e in EVT})))
