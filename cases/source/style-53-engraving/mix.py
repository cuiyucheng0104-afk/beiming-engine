"""博物志·鹦鹉螺 — score, foley and mix. Reads out/timeline.json (from timeline.js) and events.json (from the page).
Writes out/stems/*.wav, out/mix.wav, out/onsets.json (every scored onset, for the cue check).
Score: harpsichord continuo + cello / double-bass pizzicato over a descending lament bass (d minor, 90 BPM);
a rising septum scale that accelerates and stops dead; one second of silence; then the first bowed notes (cello,
double bass, solo violin) with a soft chamber organ on a D-major cadence. Deterministic: same input → same file.
"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, bp, lp, hp, env_exp, t_, limit, whoosh, thump
OUT = os.path.join(HERE, 'out'); os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
TL = json.load(open(os.path.join(OUT, 'timeline.json'))); EVJ = json.load(open(os.path.join(HERE, 'events.json')))
SPB = TL['SPB']; C = TL['C']; DUR = TL['DUR']; EV = EVJ['ev']
T = lambda b: b * SPB
N = int(round(DUR * SR)) + SR // 2
S.seed(53); rng = np.random.default_rng(53)

# ------------------------------------------------------------------ the score (beats → seconds)
score = {'hpsi': [], 'pizz': [], 'bowed': [], 'glass': []}
onsets = []
def note(stem, b, inst, pitch, dur_b, vel, pan=0.0, what=None, **kw):
    score[stem].append(dict(t=T(b), inst=inst, pitch=pitch, dur=T(dur_b), vel=vel, pan=pan, **kw))
    if what: onsets.append(dict(t=T(b), b=b, what=what))

# lament bass (cello + double bass pizz), one note a beat, chords for the harpsichord
BASS = [(0, 'D3', 'Dm'), (1, 'C#3', 'A/C#'), (2, 'C3', 'F/C'), (3, 'B2', 'G/B'), (4, 'Bb2', 'Gm/Bb'), (5, 'A2', 'A'), (6, 'G2', 'Gm'), (7, 'A2', 'A7'),
        (8, 'D3', 'Dm'), (9, 'C#3', 'A/C#'), (10, 'C3', 'F/C'), (11, 'B2', 'G/B'), (12, 'Bb2', 'Gm/Bb')]
CH = {'Dm': ['D4', 'F4', 'A4'], 'A/C#': ['C#4', 'E4', 'A4'], 'F/C': ['C4', 'F4', 'A4'], 'G/B': ['B3', 'D4', 'G4'], 'Gm/Bb': ['Bb3', 'D4', 'G4'],
      'A': ['C#4', 'E4', 'A4'], 'Gm': ['G3', 'Bb3', 'D4'], 'A7': ['C#4', 'E4', 'G4']}
for b, bn, ch in BASS:
    lo = S.midi(bn)
    note('pizz', b, 'cellos_pizz', bn, 0.9, 0.62, -0.25, what=f'bass {bn}')
    note('pizz', b, 'contrabass_pizz', lo - 12, 0.9, 0.42 if b < 6 else 0.5, -0.1)
    if b >= 9: note('pizz', b + 0.5, 'cellos_pizz', lo + 12, 0.4, 0.38, -0.25, what=f'walking octave {bn}')            # walking octaves under the crossings
    c = [S.midi(x) for x in CH[ch]]
    if b < 6:                                   # first pass: one plain chord a beat, like the single outline runs
        for i, m in enumerate(c): note('hpsi', b + i * 0.02, 'harpsichord', m, 0.9, 0.62, 0.15)
        onsets.append(dict(t=T(b), b=b, what=f'chord {ch}'))
    elif b < 9:                                 # second pass: broken chord in eighths (hatching)
        pat = [c[0], c[2], c[1] + 12, c[2]]
        for k in range(2): note('hpsi', b + k * 0.5, 'harpsichord', pat[(b * 2 + k) % 4], 0.45, 0.6, 0.2, what=f'8th {ch}' if k == 0 else None)
    elif b < 12:                                # third pass: sixteenths, the crossing family
        pat = [c[0], c[1], c[2], c[0] + 12]
        for k in range(4): note('hpsi', b + k * 0.25, 'harpsichord', pat[k] + (12 if b == 11 and k > 1 else 0), 0.24, 0.55 + 0.08 * (k == 0), 0.2, what=f'16th {ch}' if k == 0 else None)
    else:                                       # B12: the ring is scribed — a rolled chord and one glass ting
        for i, m in enumerate([S.midi('G2')] + c): note('hpsi', b + i * 0.04, 'harpsichord', m, 1.0, 0.58, 0.1)
        note('glass', b, 'glass', 'D6', 1.6, 0.55, 0.35, what='ting (ring scribed)')
# the flight: dominant pedal, a rising arpeggio in eighths
note('pizz', 13, 'cellos_pizz', 'A2', 0.9, 0.6, -0.25, what='lift-off A pedal'); note('pizz', 13, 'contrabass_pizz', 'A1', 1.6, 0.5, -0.1)
note('pizz', 14, 'cellos_pizz', 'A2', 0.9, 0.5, -0.25)
for k, p in enumerate(['A3', 'C#4', 'E4', 'G4', 'A4', 'C#5', 'E5', 'G5']): note('hpsi', 13 + k * 0.25, 'harpsichord', p, 0.3, 0.5 + 0.03 * k, 0.25 - 0.06 * k)
# landing: low D
note('pizz', 15, 'cellos_pizz', 'D3', 1.0, 0.75, -0.2, what='landing D'); note('pizz', 15, 'contrabass_pizz', 'D2', 1.2, 0.72, -0.05)
for i, p in enumerate(['D2', 'D3', 'A3', 'F4']): note('hpsi', 15 + i * 0.03, 'harpsichord', p, 0.9, 0.6, 0.1)
note('hpsi', 15.5, 'harpsichord', 'A4', 0.4, 0.42, 0.25)
# the septa: one note each, a d-minor scale climbing G3 → A5 as the cuts accelerate; A pedal underneath
SCALE = ['G3', 'A3', 'Bb3', 'C#4', 'D4', 'E4', 'F4', 'G4', 'A4', 'Bb4', 'C#5', 'D5', 'E5', 'F5', 'G5', 'A5']
for i, b in enumerate(C['septa']):
    note('hpsi', b, 'harpsichord', SCALE[i], min(0.5, 0.9 * ((C['septa'][i + 1] - b) if i + 1 < len(C['septa']) else 0.3)), 0.5 + 0.25 * i / 15, 0.1 + 0.35 * i / 15, what=f'septum {i + 1}')
for b in (16, 17, 18, 19): note('pizz', b, 'cellos_pizz', 'A2', 0.8, 0.45 + 0.05 * (b - 16), -0.25)
# the stop: an A7 stab on the last septum, then nothing
for i, p in enumerate(['A2', 'E3', 'G3', 'C#4']): note('hpsi', C['stop'] + i * 0.01, 'harpsichord', p, 0.28, 0.66, 0.05)
note('pizz', C['stop'], 'contrabass_pizz', 'A1', 0.3, 0.7, -0.05); note('pizz', C['stop'], 'cellos_pizz', 'A2', 0.3, 0.7, -0.2, what='stop (A7 stab)')
# after the silence: the first bowed notes of the film
F0 = C['first']
note('bowed', F0, 'cellos', 'D2', 2.05, 0.8, -0.2, what='FIRST: bowed cello D2', attack=0.06)
note('bowed', F0, 'contrabass', 'D2', 2.05, 0.6, -0.05, attack=0.06)
for i, p in enumerate(['D2', 'A2', 'D3', 'F#3', 'A3', 'D4']): note('hpsi', F0 + i * 0.06, 'harpsichord', p, 1.8, 0.62, 0.1)
for b, bn, ch, mel in [(23, 'G2', ['G3', 'B3', 'D4', 'G4'], None), (25, 'A2', ['G3', 'C#4', 'E4', 'A4'], None), (27, 'D2', ['A3', 'D4', 'F#4', 'A4', 'D5'], None)]:
    note('bowed', b, 'cellos', bn, 2.05 if b < 27 else 3.1, 0.7, -0.2, what=f'bowed {bn}', attack=0.08)
    note('bowed', b, 'contrabass', bn, 2.05 if b < 27 else 3.1, 0.5, -0.05, attack=0.08)
    for i, p in enumerate([bn] + ch): note('hpsi', b + i * 0.07, 'harpsichord', p, 1.8, 0.5, 0.1)
for b, p, d in [(21, 'A5', 1), (22, 'F#5', 1), (23, 'G5', 1.5), (24.5, 'F#5', 0.5), (25, 'E5', 2), (27, 'D5', 3.1)]:
    note('bowed', b, 'violin', p, d * 0.98, 0.42, 0.3, what=f'violin {p}', attack=0.12)
for b, ps, d in [(21, ['D3', 'A3', 'F#4'], 2), (23, ['D3', 'G3', 'B3'], 2), (25, ['C#3', 'E3', 'G3'], 2), (27, ['D3', 'F#3', 'A3'], 3.1)]:
    for p in ps: note('bowed', b, 'organ_soft', p, d * 0.98, 0.32, 0.0, attack=0.25)
for b, p in [(22, 'A4'), (24, 'B4'), (26, 'C#5')]: note('hpsi', b, 'harpsichord', p, 0.9, 0.36, 0.3, what=f'hpsi {p}')
note('glass', 27, 'glass', 'D6', 3.0, 0.3, 0.35, what='cadence ting')
onsets.append(dict(t=T(27), b=27, what='cadence D'))

def render(evs, level=1.0):
    buf = np.zeros((N, 2), np.float32)
    for e in evs:
        kw = {k: e[k] for k in ('attack',) if k in e}
        x = S.note(e['inst'], e['pitch'], e['dur'], vel=e['vel'], **kw)
        add(buf, x, e['t'], level, e['pan'])
    return buf
stems = {'hpsi': S.room(render(score['hpsi'], 0.55), size=.3, mix=.17),
         'pizz': S.room(render(score['pizz'], 0.7), size=.32, mix=.18),
         'bowed': S.room(render(score['bowed'], 0.62), size=.45, mix=.25),
         'glass': S.room(render(score['glass'], 0.3), size=.6, mix=.35)}
for k in stems: stems[k] = np.stack([hp(stems[k][:, c], 35) for c in (0, 1)], 1).astype(np.float32)
music = sum(stems.values())

# ------------------------------------------------------------------ foley from window.EV
fol = np.zeros((N, 2), np.float32)
def burin(d, v=1.0):
    n = int(d * SR); x = bp(rng.standard_normal(n), 2600, 9000, 2)
    tt = np.arange(n) / SR
    chat = 0.65 + 0.35 * np.abs(np.sin(2 * np.pi * (38 + 9 * np.sin(2 * np.pi * 1.3 * tt)) * tt))   # the burin chatters as it bites
    ring = sum(a * np.sin(2 * np.pi * f * tt) for f, a in [(1180, .05), (2310, .035), (3470, .025)])  # faint plate ring
    e = np.minimum(1, tt / 0.03) * np.minimum(1, (d - tt) / 0.06)
    return (x / (np.abs(x).max() + 1e-9) * chat + ring) * e * v
def tick(f=4200, v=1.0, tau=0.012):
    d = 0.06; tt = t_(d); x = hp(rng.standard_normal(len(tt)), 2500) * env_exp(d, 0.0015) * 0.6 + np.sin(2 * np.pi * f * tt) * env_exp(d, tau)
    return x / (np.abs(x).max() + 1e-9) * v
def scratch(v=1.0):
    d = 0.005 + rng.random() * 0.006; n = int(d * SR); f = 3000 + rng.random() * 4500
    x = bp(rng.standard_normal(n + 64), f * 0.7, min(f * 1.3, 23000))[64:]
    return x * np.hanning(n) * v
def plip(v=1.0):
    d = 0.22; tt = t_(d); f = 1500 * np.exp(-tt * 9) + 520
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, 0.045) + bp(rng.standard_normal(len(tt)), 2000, 7000) * env_exp(d, 0.004) * 0.3
    return x / np.abs(x).max() * v
def swish(d, v=1.0, lo=300, hi=2600):
    n = int(d * SR); tt = np.arange(n) / SR; x = bp(rng.standard_normal(n), lo, hi)
    e = np.minimum(1, tt / 0.04) * np.exp(-tt / (d * 0.55)) * (1 + 0.25 * np.sin(2 * np.pi * 7 * tt))
    return x / (np.abs(x).max() + 1e-9) * e * v
def rub(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; x = lp(rng.standard_normal(n), 900)
    return x / (np.abs(x).max() + 1e-9) * (0.5 + 0.5 * np.sin(2 * np.pi * 4.5 * tt) ** 2) * np.sin(np.pi * tt / d) * v
def scribe(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; out = np.zeros(n); x = rng.standard_normal(n)
    for i in range(0, n, 480):
        f = 4200 + 1800 * np.sin(2 * np.pi * 2.0 * i / SR); j = min(n, i + 480); out[i:j] = bp(x[max(0, i - 2000):j], f * 0.8, f * 1.25)[-(j - i):]
    return out / (np.abs(out).max() + 1e-9) * np.minimum(1, tt / 0.03) * np.minimum(1, (d - tt) / 0.05) * v
def plate_ring(d=1.4, v=1.0):
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * tt + ph) * np.exp(-tt / tau) for f, a, tau, ph in
                        [(587, .5, .55, 0), (1180, .9, .5, 1), (1873, .45, .3, 2), (2310, .6, .35, .5), (3470, .4, .2, 1.4), (5210, .25, .12, .7)])
    x = x * np.minimum(1, tt / 0.002) + bp(rng.standard_normal(len(tt)), 2500, 9000) * env_exp(d, 0.01) * 0.5
    return x / np.abs(x).max() * v
def trace(d, v=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; x = bp(rng.standard_normal(n), 1800, 6500)
    e = (0.55 + 0.45 * np.abs(np.sin(2 * np.pi * 3.0 * tt))) * np.minimum(1, tt / 0.05) * np.minimum(1, (d - tt) / 0.15)
    return x / (np.abs(x).max() + 1e-9) * e * v
def clock(v=1.0):
    d = 0.05; tt = t_(d); x = np.sin(2 * np.pi * 1900 * tt) * env_exp(d, 0.006) + np.sin(2 * np.pi * 820 * tt) * env_exp(d, 0.01) * 0.6
    return x / np.abs(x).max() * v

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'burin':
        d = e['t1'] - t; add(fol, burin(d, 1.0), t, 0.24 if e.get('run') == 'A' else 0.16 if e.get('run') != 'wall' else 0.13, e.get('pan', 0))
        if e.get('run') == 'A': add(fol, plate_ring(1.4), t, 0.07, -0.05)   # the first frame: the burin bites, the copper rings
    elif ty == 'lift': add(fol, tick(5200, 1, 0.01), t, 0.16, 0.1)
    elif ty == 'hatch':
        rate = {1: 70, 2: 120, 3: 170}[e['pass']]; d = e['t1'] - t; k = int(rate * d)
        for i in range(k): add(fol, scratch(0.5 + 0.5 * rng.random()), t + (i + rng.random() * 0.6) / rate, 0.11, (rng.random() - 0.5) * 0.8)
        add(fol, scratch(1.0), t, 0.2, 0)                          # the pass starts on the beat
    elif ty == 'stipple':
        d = e['t1'] - t
        for i in range(int(28 * d)): add(fol, tick(3000 + 1500 * rng.random(), 0.5, 0.004), t + i / 28, 0.06, (rng.random() - 0.5) * 0.5)
    elif ty == 'scribe': add(fol, scribe(e['t1'] - t), t, 0.12, 0.3)
    elif ty == 'burnish': add(fol, rub(e['t1'] - t), t, 0.22, 0.3)
    elif ty == 'trace': add(fol, trace(e['t1'] - t), t, 0.035, 0.45)
    elif ty == 'whoosh': add(fol, whoosh(e['t1'] - t, 1.0), t, 0.08, 0.5)
    elif ty == 'ruling':
        d = e['t1'] - t
        for i in range(int(20 * d)): add(fol, scratch(0.7), t + i / 20, 0.08, 0.45)
    elif ty == 'land': add(fol, thump(1.0, 95), t, 0.22, 0.4); add(fol, tick(2600, 1, 0.02), t, 0.08, 0.4)
    elif ty == 'septum': add(fol, tick(3800 + 1200 * e['i'] / e['n'], 1, 0.008), t, 0.12, e.get('pan', 0)); add(fol, burin(0.05, 1), t, 0.07, 0.3)
    elif ty == 'glyph': add(fol, tick(3300 if e['zh'] else 4600, 1, 0.006), t, 0.09 if e['zh'] else 0.055, 0.35)
    elif ty == 'leader': add(fol, burin(T(0.25), 0.6), t, 0.06, 0.3)
    elif ty == 'clock': add(fol, clock(1.0), t, 0.045, -0.3)
    elif ty == 'drop': add(fol, plip(1.0), t, 0.32, 0.25)
    elif ty == 'brush': add(fol, swish(e['t1'] - t, 1.0, 250, 2200), t, 0.16, 0.3)
    elif ty == 'dab': add(fol, swish(0.16, 1.0, 400, 3000), t, 0.07 if e.get('soft') else 0.1, 0.2 if e.get('soft') else -0.2)
    elif ty == 'wash': add(fol, swish(0.9, 1.0, 250, 1800), t, 0.12, -0.25)
    elif ty == 'air': d = e['t1'] - t; n = int(d * SR); x = lp(rng.standard_normal(n), 700); x = x / np.abs(x).max() * np.sin(np.pi * np.arange(n) / n) ** 2; add(fol, x, t, 0.035, 0)

# ------------------------------------------------------------------ rooms: a quiet workroom with a clock, then a paper room
room = np.zeros((N, 2), np.float32)
tt = np.arange(N) / SR
bed = lp(np.cumsum(rng.standard_normal(N)) * 0.02, 380); bed = hp(bed, 40); bed /= np.abs(bed).max()
bed2 = bp(rng.standard_normal(N), 300, 5000); bed2 /= np.abs(bed2).max()
stopT, firstT = T(C['stop']), T(C['first'])
g1 = (tt < stopT + 0.02).astype(float); g2 = np.clip((tt - firstT) / 0.4, 0, 1)
room[:, 0] += (bed * 0.012 * g1 + bed2 * 0.004 * g2); room[:, 1] += (bed * 0.012 * g1 + bed2 * 0.004 * g2)
for b in range(0, int(C['stop']) + 1):                       # the clock ticks on every beat until the stop
    if b < C['stop']: add(room, clock(1.0), T(b), 0.018, -0.3)

# ------------------------------------------------------------------ the silence: everything gated, except the one clock tick
gate = np.ones(N); a, b = int((stopT + 0.24) * SR), int(firstT * SR)
gate[a:b] = 0; ramp = int(0.04 * SR); gate[a - ramp:a] = np.linspace(1, 0, ramp)
music *= gate[:, None]; fol *= gate[:, None]; room *= gate[:, None]
add(room, clock(1.0), T(C['clock']), 0.03, -0.3)            # the only sound inside the silence
# end: let the cadence breathe, then fade the last 0.45 s
fade = np.ones(N); e0 = int((DUR - 0.45) * SR); fade[e0:] = np.clip(np.linspace(1, 0, N - e0) * 1.0, 0, 1)

mix = (music * 1.0 + fol * 1.0 + room) * fade[:, None]
mix = np.stack([limit(mix[:, c], 0.95) for c in (0, 1)], 1)
mix = mix[:int(round(DUR * SR))]
sf.write(os.path.join(OUT, 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
for k, v in stems.items(): sf.write(os.path.join(OUT, 'stems', k + '.wav'), (v * gate[:, None])[:len(mix)].astype(np.float32), SR, subtype='PCM_24')
sf.write(os.path.join(OUT, 'stems', 'foley.wav'), (fol * gate[:, None])[:len(mix)].astype(np.float32), SR, subtype='PCM_24')
json.dump(sorted(onsets, key=lambda o: o['t']), open(os.path.join(OUT, 'onsets.json'), 'w'), ensure_ascii=False, indent=0)
# band balance report
def band(x, lo, hi):
    from scipy.signal import butter, sosfilt
    y = sosfilt(butter(4, [lo, hi], 'band', fs=SR, output='sos'), x.mean(1)); return 10 * np.log10(np.mean(y ** 2) + 1e-12)
print('mix', mix.shape[0] / SR, 's  peak', round(20 * np.log10(np.abs(mix).max()), 2), 'dBFS',
      ' low(20-120) vs mid(120-4k): %.1f dB' % (band(mix, 20, 120) - band(mix, 120, 4000)))
print('instruments:', sorted({e['inst'] for v in score.values() for e in v}))
