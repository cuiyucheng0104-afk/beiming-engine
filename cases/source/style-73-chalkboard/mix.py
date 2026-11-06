"""Sound for 《三个正方形》 -> out/mix.wav (48 kHz stereo, exactly DUR seconds) and out/onsets.json (every scheduled musical hit).
Run from anywhere with the library's python (build.sh does it):
    node $LIB/core/render/events.mjs <film>      (events.json from the picture)
    $LIB/.venv/bin/python <film>/mix.py
No voice. Three layers:
  room   a very low room tone; a distant school bell as the last punctuation
  foley  real chalk recordings (CC0) cut into grains, one grain chain per stroke from events.json; soft taps where cells land;
         a damp cloth for the wipe; a whoosh for the whip
  score  108 BPM in D: nylon guitar (sampled) plucks born from the drawn lines, low marimba, pizzicato double bass and
         chalk-grain percussion; one ascending marimba note per landing cell (accelerating), near-silence, then the peak.
Times come from events.json (the picture) and from the same beat→frame grid as js/timeline.js."""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf, soxr
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, whoosh, noise, bp, hp, lp, t_, brown, thump

S.seed(73)
rng = np.random.default_rng(73)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EVJ['dur']; ev = EVJ['ev']; N = int(round(DUR * SR))
BPM, FPS = 108, 30
tq = lambda b: np.floor(b * 60 / BPM * FPS + .5) / FPS             # same as timeline.js (Math.round: halves go up)
first = lambda k: next(e for e in ev if e['type'] == k)
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
fx, mus, room = (np.zeros((N, 2), np.float32) for _ in range(3))
ONSETS = []                                                        # (t, what) for cuecheck.py

def fade(x, a=.004, b=.03):
    n = len(x); a, b = min(int(a * SR), n // 2), min(int(b * SR), n // 2)
    x = x.copy(); x[:a] *= np.linspace(0, 1, a); x[n - b:] *= np.linspace(1, 0, b); return x

# ---------------------------------------------------------------- chalk grains (CC0 recordings, foley/index.json)
IDX = json.load(open(os.path.join(HERE, 'foley/index.json')))
strokes = [g for g in IDX if g['kind'] == 'stroke']
taps = [g for g in IDX if g['kind'] == 'tap']
cache = {}
def grain(g):
    if g['file'] not in cache:
        x, sr = sf.read(os.path.join(HERE, 'foley', g['file']), dtype='float32')
        if x.ndim > 1: x = x.mean(1)
        if sr != SR: x = soxr.resample(x, sr, SR)
        cache[g['file']] = x / (np.abs(x).max() + 1e-9)
    return cache[g['file']]
def tap(): return fade(grain(taps[rng.integers(len(taps))]), .001, .02)
def chalk(d, v, orange=False, side=False):
    """a stroke of duration d: grains chained and cross-faded to length; the orange chalk softer and duller,
    the side of the stick (filling in) a denser, broader scrub"""
    out = np.zeros(int((d + .06) * SR), np.float32); pos = 0
    step = .35 if side else .6
    while pos < len(out) - int(.03 * SR):
        g = grain(strokes[rng.integers(len(strokes))]); n = min(len(g), len(out) - pos)
        out[pos:pos + n] += fade(g[:n], .006, .02); pos += max(int(step * n), int(.03 * SR))
    env = np.ones(len(out)); a = int(.01 * SR); env[:a] = np.linspace(.3, 1, a); env[-int(.05 * SR):] *= np.linspace(1, 0, int(.05 * SR))
    out = out * env
    out = lp(out, 2600 if side else 3600) if orange else hp(out, 500)
    return (out * v).astype(np.float32)
for e in ev:
    if e['type'] != 'chalk' or e['t'] < 0: continue
    d = max(.04, e['d']); size = min(1.0, e['len'] / 700)
    v = (.14 + .3 * size) * (.75 if e['side'] else 1.0)
    add(fx, chalk(d, v, e['color'] == 'orange', e['side']), e['t'], 1.0, e['pan'])
    add(fx, tap() * .5 * v, e['t'], 1.0, e['pan'])                 # every stroke starts with the chalk biting the slate

# cells: a soft dry tap where each one lands; the last one's faint slide through the silence
for e in ev:
    if e['type'] == 'land':
        x = lp(tap(), 2400) * (.22 if not e['last'] else .0)
        add(fx, x.astype(np.float32), e['t'], 1.0, e['pan'])
    if e['type'] == 'lift' and e['last']:
        d = e['d']; s = bp(noise(d), 900, 3200) * .012
        env = np.minimum(1, t_(d) / .3) * np.clip(1 - t_(d) / (d * .62), 0, 1) ** 1.5          # it slows to a stop at the door
        add(fx, (s * env).astype(np.float32), e['t'], 1.0, -.2)

# whip, wipe, room, bell
e = first('whip'); add(fx, whoosh(e['d'] + .12, .8) * .45, e['t'] - .06, 1.0, .25)
e = first('wipe'); d = e['d'] + .15                               # a damp cloth: four passes, low and soft, a little wet squeak at each turn
w = bp(noise(d), 220, 1900) * .15
rows = np.abs(np.sin(np.pi * 4 * np.clip(t_(d) / d, 0, 1))) ** .6
w *= rows * np.minimum(1, t_(d) / .05) * np.clip((d - t_(d)) / .12, 0, 1)
for k in range(1, 4):
    tt = d * k / 4; sq = np.sin(2 * np.pi * (1350 + 140 * k) * t_(.09)) * np.exp(-t_(.09) / .03) * .02
    add(fx, np.stack([sq, sq], 1)[:, 0].astype(np.float32), e['t'] + tt - .03, 1.0, -.3)
add(fx, w.astype(np.float32), e['t'], 1.0, -.35)
r = lp(brown(DUR), 700) * .005; room[:, 0] += r[:N]; room[:, 1] += np.roll(r, 1931)[:N]
e = first('bell'); d = 1.0                                          # the bell, far down the corridor
b = (np.sign(np.sin(2 * np.pi * 980 * t_(d))) * .3 + np.sin(2 * np.pi * 1960 * t_(d)) * .2) * (.6 + .4 * np.sin(2 * np.pi * 22 * t_(d)))
b = lp(bp(b, 600, 3000), 1800) * np.minimum(1, t_(d) / .05) * np.exp(-np.maximum(0, t_(d) - .75) / .1) * .045
add(room, S.room(np.stack([b, b], 1).astype(np.float32), size=.75, mix=.65)[:, 0], e['t'], 1.0, .55)
ONSETS.append((e['t'], 'bell'))

# ---------------------------------------------------------------- score
def rise(x):
    """where a note's attack is heard: the envelope first reaches half its early maximum (samples start a few ms before it)"""
    a = np.abs(x[:int(.08 * SR)]); e = np.convolve(a, np.ones(48) / 48, 'same'); return int(np.argmax(e > .5 * e.max())) / SR
def place(x, tt, g=1.0, pan=0):                                       # the attack, not the file start, sits on the frame
    add(mus, x, tt - rise(x), g, pan)
def nt(b, inst, p, dur, v, pan=0, g=1.0, t=None, tag=None):
    tt = tq(b) if t is None else t
    if 0 <= tt < DUR: place(S.note(inst, p, dur, v), tt, g, pan); ONSETS.append((tt, tag or f'{inst} {p}'))
def gt(b, p, dur=2.0, v=.6, pan=0, g=1.0, tag=None): nt(b, 'guitar_nylon', p, dur, v, pan, g, tag=tag)
def harm(b, p, v=.5, pan=0, g=1.0):
    tt = tq(b); place(P.pluck('nylon_guitar', p, 2.5, v, harmonic=True), tt, g, pan); ONSETS.append((tt, 'harmonic ' + p))
def strum(b, ps, v=.7, spread=.016, g=1.0, pan=0):
    for i, p in enumerate(ps): place(S.note('guitar_nylon', p, 3.0, v * (1 - .04 * i)), tq(b) + i * spread, g, pan + (i - len(ps) / 2) * .05)
    ONSETS.append((tq(b), 'strum'))
def pz(b, p, v=.75, g=1.0): nt(b, 'contrabass_pizz', p, 1.2, v, -.05, g)
def mar(b, p, v=.6, pan=0, g=1.0, dur=1.2, t=None, tag=None): nt(b, 'marimba', p, dur, v, pan, g, t=t, tag=tag)
def perc(b, v=.25, knock=False, pan=0):                              # chalk-grain percussion
    tt = tq(b); x = hp(tap(), 1800 if not knock else 300) * v
    if knock: x = x * .6
    place(x.astype(np.float32), tt, 1.0, pan); ONSETS.append((tt, 'chalk perc'))
    if knock: add(mus, (thump(1.0, 92) * v * .55).astype(np.float32), tt, 1.0, 0)

# A · the triangle: each line plucks a note as it is drawn (D, A, F#: the key spelled out); the labels on marimba
gt(0, 'D3', 2.5, .66, -.15); gt(1, 'A3', 2.5, .6, 0); gt(2, 'F#4', 3.0, .62, .15)
perc(3, .3)
mar(4, 'A4', .42, -.1); mar(4.5, 'B4', .42, 0); mar(5, 'D5', .48, .1)
# B · squares: open fifths, then the groove enters with the third square (bar 3, Bm)
gt(6, 'D3', 2, .55, -.2); gt(6, 'A3', 2, .5, -.2)
gt(7, 'E3', 2, .5, .2); gt(7, 'B3', 2, .48, .2)
strum(8, ['B2', 'F#3', 'B3', 'D4', 'F#4'], .42)
pz(8, 'B1', .62)
for b, p in [(9.5, 'B1'), (10, 'F#2'), (11, 'A1'), (11.5, 'A1')]: pz(b, p, .78)
for i in range(8): perc(8 + i * .5, .16 + (.08 if i % 2 == 0 else 0), knock=(i in (2, 6)))
mar(9.5, 'F#3', .4, -.2); mar(10.5, 'D3', .4, .2)                     # under the orange fill
# C · cracked into cells (G), the paths (a slide up the string), the stream of cells (A), accelerating
strum(12, ['G2', 'D3', 'G3', 'B3', 'D4'], .5)
for b, p in [(12, 'G1'), (13.5, 'G1'), (14, 'D2'), (15, 'G1'), (15.5, 'B1')]: pz(b, p, .78)
for k in ('A', 'B'):
    tt = tq(13.5); place(P.pluck('nylon_guitar', 'A3' if k == 'A' else 'E3', 1.4, .55, bend=[(0, 0), (.38, 5)]), tt, .8, -.3 if k == 'A' else .3)
ONSETS.append((tq(13.5), 'path slide'))
strum(16, ['A2', 'E3', 'A3', 'C#4', 'E4'], .52)
for b, p in [(16, 'A1'), (17, 'A1'), (17.5, 'E2'), (18, 'A1'), (19, 'A1'), (19.5, 'E2'), (20, 'A1'), (20.5, 'A1'), (21, 'A1'), (21.25, 'A1')]: pz(b, p, .8)
grid = [12 + i * .5 for i in range(8)] + [16 + i * .25 for i in range(16)] + [20 + i * .125 for i in range(12)]
for b in grid:
    sub = (b * 8) % 8
    perc(b, .14 + .05 * (b > 16) + .06 * (b > 20) * (b - 20), knock=(sub == 0 and int(b) % 2 == 1 and b < 20))
SCALE = ['A2', 'B2', 'C#3', 'D3', 'E3', 'F#3', 'G3', 'A3', 'B3', 'C#4', 'D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5', 'B5', 'C#6']
lands = sorted([e for e in ev if e['type'] == 'land'], key=lambda e: e['k'])
for e in lands[:24]:
    k = e['k']; mar(e['beat'], SCALE[k], .45 + .4 * k / 23, e['pan'], 1.0, 1.0, t=e['t'], tag=f'land{k}')
# the stream sits 6.5 dB lower from bar 5 on (ramp b14–b16), so the peak is the loudest moment by a clear margin;
# its own crescendo (velocity and the denser percussion) is kept inside that lower level
g0, g1 = int(tq(14) * SR), int(tq(16) * SR); gl = 10 ** (-6.5 / 20)
mus[g0:g1] *= np.linspace(1, gl, g1 - g0)[:, None]; mus[g1:] *= gl
# and the whole middle (squares, fills, the crack) 3 dB under the opening level, foley included
p0, p1, p2 = int(tq(8.5) * SR), int(tq(9.5) * SR), int(tq(21.5) * SR); pl = 10 ** (-3 / 20)
for L in (mus, fx): L[p0:p1] *= np.linspace(1, pl, p1 - p0)[:, None]; L[p1:p2] *= pl; L[:p2] *= 10 ** (-2 / 20)
# near-silence: everything stops at b21.5 (the tails are damped), only the room and the last cell's slide remain
h0 = int(tq(21.5) * SR) + int(.03 * SR); h1 = int(tq(24) * SR) - 12
mus[h0:h1] *= np.linspace(1, 0, h1 - h0)[:, None] ** 40
# the peak: the last cell drops in. the full D chord, the lowest note of the film, a heavy chalk knock
e = lands[24]; tp = e['t']
def first_tr(x):
    """the first transient: where the 1 ms envelope first reaches 12 % of its early maximum (after the silence the
    ear and an onset detector hear this, not the half-rise)"""
    a = np.abs(x[:int(.08 * SR)]); e = np.convolve(a, np.ones(48) / 48, 'same'); return int(np.argmax(e > .12 * e.max())) / SR
def hit(inst, p, dur, v, g=1.0, pan=0, tag=None):
    x = S.note(inst, p, dur, v); add(mus, x, tp - first_tr(x), g, pan); ONSETS.append((tp, tag or f'{inst} {p}'))
hit('marimba', 'D2', 3.5, 1.0, 1.1, 0, 'peak marimba'); hit('marimba', 'D3', 3.0, .95, 1.0, -.1); hit('marimba', 'A3', 3.0, .8, 1.0, .1); hit('marimba', 'D4', 3.0, .85)
hit('contrabass_pizz', 'D2', 2.5, 1.0, 1.4, 0, 'peak bass'); hit('contrabass_pizz', 'D1', 2.5, 1.0, 1.0); hit('cellos_pizz', 'D3', 2.0, .9, .9)
for i, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5']):
    x = S.note('guitar_nylon', p, 3.0, .8 * (1 - .04 * i)); add(mus, x, tp + i * .012 - first_tr(x), 1.15, (i - 3) * .05)
ONSETS.append((tp, 'strum'))
for i in range(1, 9):                                                  # a short marimba roll holds the chord up for a beat
    b = 24 + i * .125; v = .62 - .045 * i
    for p, pn in (('D3', -.15), ('A3', .15)) if i % 2 else (('D4', 0), ('F#3', -.05)): nt(b, 'marimba', p, 1.0, v, pn, .9)
k = lp(tap(), 1500); k0 = int(np.argmax(np.abs(k) > .12 * np.abs(k).max())) / SR
add(fx, (k * 1.0).astype(np.float32), tp - k0, 1.0, 0); add(fx, (thump(1.0, 52) * .85).astype(np.float32), tp, 1.0, 0)
ONSETS.append((tp, 'peak knock'))
harm(25, 'F#5', .4, .3)                                               # one breath, held
# E · the conclusion: each term of the equation sounds as it is written; the pupil's circle a harmonic; the name on guitar
pz(26, 'D2', .8); pz(28, 'A1', .7)
for g in [e for e in ev if e['type'] == 'glyph']:
    if g['ch'] in 'abc': mar(g['beat'], {'a': 'F#4', 'b': 'A4', 'c': 'D5'}[g['ch']], .58, .25, t=g['t'], tag='eq ' + g['ch'])
    elif g['ch'] in '+=': perc(g['beat'], .3, pan=.25)
harm(28.5, 'A5', .55, .35)
for c, p in zip([e for e in ev if e['type'] == 'char'], ['D4', 'E4', 'F#4', 'A4']): gt(c['beat'], p, 2.0, .5, .3, tag='char ' + p)
# F · the wipe on a low pedal; the closing chord as the cloth lifts; the bell
pz(32, 'D2', .55); pz(32.5, 'D2', .6); mar(32.5, 'D3', .45, -.3, dur=2.0)       # the pull starts; the cloth comes in
strum(34.25, ['D3', 'A3', 'F#4', 'A4'], .42, .03, .9); harm(34.25, 'D5', .5, -.2); harm(34.25, 'A5', .4, .2); pz(34.25, 'D2', .6)
mar(34.75, 'F#4', .28, .2, dur=2.5); mar(34.75, 'D5', .26, -.2, dur=2.5)

# the ending (pull, wipe, chord, bell) 2 dB under the peak's level
q0 = int(tq(32) * SR)
for L in (mus, fx): L[q0:] *= 10 ** (-2 / 20)

# ---------------------------------------------------------------- mix
mus = S.room(mus, size=.42, mix=.16)
def lufs(x):
    from scipy.signal import lfilter
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, .73248077421585]
    b2, a2 = [1, -2, 1], [1, -1.99004745483398, .99007225036621]
    y = lfilter(b2, a2, lfilter(b1, a1, x, axis=0), axis=0); n = int(.4 * SR); h = int(.1 * SR)
    ms = np.array([np.mean(np.sum(y[i:i + n] ** 2, 1)) for i in range(0, len(y) - n, h)])
    g = ms[ms > 10 ** ((-70 + .691) / 10)]; g = g[g > np.mean(g) * 10 ** (-1)] if len(g) else g
    return -.691 + 10 * np.log10(np.mean(g) + 1e-12)
def limit2(x, ceil, look=.004):                                       # linked stereo look-ahead limiter
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    n = int(look * SR); m = maximum_filter1d(np.abs(x).max(1), size=2 * n + 1)
    g = uniform_filter1d(np.minimum(1, ceil / np.maximum(m, 1e-9)), size=n); return x * g[:, None]
mix = (fx * 1.0 + mus * .9 + room).astype(np.float64)
# the ceiling leaves the peak its height: mux.sh adds about +2 dB in linear mode (-16 -> -14 LUFS, true peak <= -1.2),
# so the mix may peak at about -4.3 dBFS (grain and AAC add ~0.6 dB); a lower ceiling flattened the peak to within 2 dB of the stream before it
CEIL = .57
for _ in range(4):                                                    # level, catch the chalk knocks, level again
    mix *= 10 ** ((-16 - lufs(mix)) / 20); mix = limit2(mix, CEIL)
pk = np.abs(soxr.resample(mix, SR, SR * 4)).max()
if 20 * np.log10(pk) > -4.3: mix *= 10 ** ((-4.3 - 20 * np.log10(pk)) / 20)
mix = mix[:N]; nf = int(.35 * SR); mix[-nf:] *= np.linspace(1, 0, nf)[:, None] ** 1.5      # the room and the bell fade with the last frames
mix = mix.astype(np.float32)
sf.write(os.path.join(OUT, 'mix.wav'), mix, SR, subtype='PCM_24')
g = float(np.abs(mix).max() / (np.abs(fx * 1.0 + mus * .9 + room).max() + 1e-12))
sf.write(os.path.join(OUT, 'stem_music.wav'), (mus * .9 * g).astype(np.float32), SR, subtype='PCM_24')
sf.write(os.path.join(OUT, 'stem_fx.wav'), (fx * g).astype(np.float32), SR, subtype='PCM_24')
json.dump(sorted([{'t': round(t, 5), 'what': w} for t, w in ONSETS], key=lambda o: o['t']), open(os.path.join(OUT, 'onsets.json'), 'w'), indent=0)
# low-end balance: 20–120 Hz vs the rest
X = np.abs(np.fft.rfft(mix.mean(1))) ** 2; f = np.fft.rfftfreq(len(mix), 1 / SR)
lo = 10 * np.log10(X[(f > 20) & (f < 120)].sum() / X[(f >= 120) & (f < 16000)].sum())
print(f'mix.wav {DUR:.2f} s  {lufs(mix):.1f} LUFS  true peak {20 * np.log10(np.abs(soxr.resample(mix, SR, SR * 4)).max()):.1f} dBFS  low/rest {lo:.1f} dB')
print(S.credits(['guitar_nylon', 'marimba', 'contrabass_pizz', 'cellos_pizz']))
