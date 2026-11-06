# 早餐铺开门 — original score. Jazz waltz in D: nylon guitar (sampled + plucked model), Sneakybass walking in three,
# synthesized brushes over soft snare taps; the clarinet enters only when the steam rises. Reads out/timeline.json.
# Writes out/music.wav (stereo 48 kHz) and out/music_onsets.json (onset of every note, for cuecheck).
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, bp, hp, lp, env_exp, t_

HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
HIT, DUR = TL['hit'], TL['dur']
SEC = {s['id']: s for s in TL['secs']}
def bt(sec, bar, beat=1.0):
    s = SEC[sec]; b = 60 / s['bpm']; return s['t'] + ((bar - 1) * s['meter'] + (beat - 1)) * b
def sw(sec, bar, beat):            # swung eighths: the "and" sits 2/3 through the beat
    whole = int(beat); frac = beat - whole
    return bt(sec, bar, whole + (2 / 3 if abs(frac - .5) < 1e-6 else frac))
BA, BB = 60 / 90, 60 / 72
S.seed(11)
N = int(DUR * SR) + SR
bus = {k: np.zeros((N, 2), np.float32) for k in ['gtr', 'bass', 'drums', 'clar', 'lead']}
ONS = []                            # [t, part, pitch]
def ev(part, t, inst, pitch, dur, vel, pan=0., gain=1.):
    x = S.note(inst, pitch, dur, vel); add(bus[part], x, t, gain, pan); ONS.append([round(t, 4), part, str(pitch)])
def pl(part, t, preset, pitch, dur, vel, pan=0., gain=1., **kw):
    x = P.pluck(preset, pitch, dur, vel, **kw); add(bus[part], x, t, gain, pan); ONS.append([round(t, 4), part, str(pitch)])
rng = np.random.default_rng(5)
hum = lambda s=.006: float(rng.uniform(-s, s))

# ---------- brushes (synth swirl + soft snare taps) ----------
def swish(d, v):
    n = int(d * SR); x = rng.standard_normal(n); tt = np.arange(n) / SR
    y = bp(x, 2200, 9000, 2) * (.6 + .4 * np.sin(2 * np.pi * (1 / d) * tt + 1.2))
    e = np.minimum(1, tt / (d * .45)) ** 1.5 * np.exp(-np.maximum(0, tt - d * .45) / (d * .35))
    return (y * e * v * .5).astype(np.float32)
def tap(v):
    x = S.hit('snare2', 'off', min(.9, .25 + v * .4)); n = min(len(x), int(.18 * SR)); x = x[:n] * np.linspace(1, 0, n) ** 2
    c = hp(rng.standard_normal(int(.03 * SR)), 3000) * env_exp(.03, .004) * .25
    x[:len(c)] += c; return (x * v).astype(np.float32)
def brush_bar(sec, bar, loud=1.):
    b = BA if sec == 'A' else BB
    add(bus['drums'], swish(b * 1.05, .55 * loud), bt(sec, bar, 1) - .03, 1, -.3)
    for beat in (2, 3): add(bus['drums'], tap(.55 * loud), bt(sec, bar, beat) + hum(), 1, .25)
    add(bus['drums'], tap(.28 * loud), sw(sec, bar, 3.5) + hum(), 1, .3)
    add(bus['drums'], S.hit('hihat', 'pedal', .35 * loud), bt(sec, bar, 2) + hum(), .5, .4)

# ---------- harmony ----------
# A: bar 1 Dmaj7 · 2 Bm7 · 3 Em7 · 4 A7 · 5 F#m7 · 6 Gmaj7 (→ A on the last beat, left hanging into the silence)
A_CH = {1: ['D3', 'A3', 'C#4', 'F#4'], 2: ['B2', 'F#3', 'A3', 'D4'], 3: ['E3', 'G3', 'D4', 'F#4'], 4: ['E3', 'G3', 'C#4', 'F#4'],
        5: ['E3', 'A3', 'C#4', 'F#4'], 6: ['F#3', 'B3', 'D4', 'G4']}
A_BASS = {3: ['E2', 'G2', 'B2'], 4: ['A2', 'C#3', 'E3'], 5: ['F#2', 'A2', 'C#3'], 6: ['G2', 'B2', 'A2']}

# bars 1–2: solo guitar, sparse, the pen is the hi-hat
pl('gtr', bt('A', 1, 1), 'nylon_guitar', 'D3', 2.4, .55, -.2)
pl('gtr', bt('A', 1, 2), 'nylon_guitar', 'A5', 2.0, .6, .25, harmonic=True)                        # the eave line: a harmonic
ev('gtr', bt('A', 1, 2) + .02, 'guitar_nylon', 'F#4', 1.2, .42, .1)
ev('gtr', bt('A', 1, 3), 'guitar_nylon', 'C#5', 1.0, .45, .2)
ev('gtr', sw('A', 1, 3.5), 'guitar_nylon', 'A4', .8, .35, .15)
ev('gtr', bt('A', 2, 1), 'guitar_nylon', 'B2', 2.0, .55, -.2)                                        # the wire
ev('gtr', bt('A', 2, 1) + .015, 'guitar_nylon', 'F#3', 1.8, .4, -.1)
ev('gtr', bt('A', 2, 2), 'guitar_nylon', 'D4', 1.0, .45, .1)                                         # laundry pole
ev('gtr', bt('A', 2, 2) + .02, 'guitar_nylon', 'A4', 1.0, .4, .15)
for k, p in enumerate(['F#4', 'A4', 'C#5']): ev('gtr', bt('A', 2, 3) + k * BA / 3, 'guitar_nylon', p, .9, .42 + k * .04, .2)   # clothes: a little triplet
ev('bass', sw('A', 2, 3.5), 'jazz_bass', 'D2', .3, .55, 0)                                           # pickup into the band

# bars 3–6: the band
for bar in (3, 4, 5, 6):
    for i, p in enumerate(A_BASS[bar]): ev('bass', bt('A', bar, i + 1) + (0 if i == 0 else hum(.004)), 'jazz_bass', p, BA * .95, .72 if i == 0 else .62, 0)
    ch = A_CH[bar]
    for beat in (2, 3):
        x = S.chord('guitar_nylon', ch, BA * .55, .38 + (.05 if beat == 2 else 0), strum=.012)
        add(bus['gtr'], x, bt('A', bar, beat) + hum(.003), 1, -.25); ONS.append([round(bt('A', bar, beat), 4), 'gtr', 'comp'])
    brush_bar('A', bar, .85 if bar == 3 else 1.)
# guitar lead line (single notes, swung) over bars 3–6; it leaves room for the bell in bar 4
LEAD = [(3, 2, 'B4', .6), (3, 3, 'D5', .4), (3, 3.5, 'E5', .3), (4, 1, 'E5', .55),
        (5, 2, 'A4', .4), (5, 2.5, 'C#5', .3), (5, 3, 'E5', .6), (6, 1, 'F#5', .9), (6, 2.5, 'E5', .3), (6, 3, 'D5', .7)]
for bar, beat, p, d in LEAD: ev('lead', sw('A', bar, beat) + hum(.003), 'guitar_nylon', p, d, .62, .1)

# ---------- B: after the silence, 72 BPM ----------
# B1 Dmaj9 · B2 Gmaj7 → A7sus4 · B3 Dmaj7 (final)
t0 = bt('B', 1, 1)
ev('bass', t0, 'jazz_bass', 'D2', BB * 2, .8, 0)
x = S.chord('guitar_nylon', ['D3', 'A3', 'E4', 'F#4', 'C#5'], 2.2, .62, strum=.028); add(bus['gtr'], x, t0, 1, -.2); ONS.append([t0, 'gtr', 'Dmaj9'])
pl('gtr', t0, 'nylon_guitar', 'D3', 2.5, .5, -.3)
ev('bass', bt('B', 1, 3), 'jazz_bass', 'A2', BB, .62, 0)
pl('gtr', bt('B', 1, 2), 'nylon_guitar', 'A4', 1.5, .45, .3)
pl('gtr', bt('B', 1, 3), 'nylon_guitar', 'E5', 1.5, .42, .35)
ev('bass', bt('B', 2, 1), 'jazz_bass', 'G2', BB * 1.9, .72, 0)
x = S.chord('guitar_nylon', ['G2', 'D3', 'F#3', 'B3', 'E4'], 1.6, .5, strum=.022); add(bus['gtr'], x, bt('B', 2, 1), 1, -.2); ONS.append([bt('B', 2, 1), 'gtr', 'Gmaj7'])
pl('gtr', bt('B', 2, 2), 'nylon_guitar', 'B4', 1.2, .4, .3)
ev('bass', bt('B', 2, 3), 'jazz_bass', 'A2', BB, .62, 0)
x = S.chord('guitar_nylon', ['A2', 'E3', 'G3', 'D4'], 1.0, .42, strum=.02); add(bus['gtr'], x, bt('B', 2, 3), 1, -.2); ONS.append([bt('B', 2, 3), 'gtr', 'A7sus4'])
tE = bt('B', 3, 1)
ev('bass', tE, 'jazz_bass', 'D2', 2.0, .75, 0)
x = S.chord('guitar_nylon', ['D3', 'A3', 'C#4', 'F#4', 'A4'], 2.4, .55, strum=.06); add(bus['gtr'], x, tE, 1, -.15); ONS.append([tE, 'gtr', 'Dmaj7'])
pl('gtr', tE + .3, 'nylon_guitar', 'D5', 1.6, .5, .3, harmonic=True)
for bar in (1, 2):
    add(bus['drums'], swish(BB * 1.1, .4), bt('B', bar, 1) - .03, 1, -.3)
    add(bus['drums'], tap(.32), bt('B', bar, 3), 1, .25)
add(bus['drums'], swish(1.4, .35), tE - .03, 1, -.2)
# the clarinet: enters with the steam
CL = [(1, 1, 'A4', BB * 1.5), (1, 2.5, 'B4', BB * .5), (1, 3, 'C#5', BB), (2, 1, 'D5', BB * 1.8), (2, 3, 'A4', BB), (3, 1, 'F#4', 1.4)]
for bar, beat, p, d in CL:
    x = S.note('clarinet', p, d, .6 if bar < 3 else .5, release=.35 if bar < 3 else .9, attack=.03)
    add(bus['clar'], x, bt('B', bar, beat), .95, .15); ONS.append([round(bt('B', bar, beat), 4), 'clar', p])

# ---------- the silence: nothing rings through it ----------
def gate(x, a, b, fa=.03):
    i0, i1 = int(a * SR), int(b * SR); n = int(fa * SR)
    x[i0:i0 + n] *= np.linspace(1, 0, n)[:, None]; x[i0 + n:i1] = 0
for k in bus: gate(bus[k], HIT['silence'], HIT['lid'] - .002)

gains = {'gtr': .9, 'bass': 1.0, 'drums': .55, 'clar': .85, 'lead': .8}
mix = sum(bus[k] * g for k, g in gains.items())
mix = S.room(mix, size=.35, mix=.16)
gate(mix, HIT['silence'], HIT['lid'] - .002)
mix = mix[:int(DUR * SR)]
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'music.wav'), mix.astype(np.float32), SR)
json.dump(sorted(ONS), open(os.path.join(HERE, 'out', 'music_onsets.json'), 'w'))
print('music.wav', mix.shape, 'peak', float(np.abs(mix).max()), 'onsets', len(ONS))
