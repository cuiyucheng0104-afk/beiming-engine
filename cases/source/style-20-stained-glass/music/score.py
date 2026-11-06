"""Original score for 浴火 (D Dorian -> D major), 72 BPM, from timeline.json.
Instruments (STYLE.md palette): organ pedal / soft / full, hand chimes, tubular bells, harp, recorder, water glass, timpani,
plus a synthesized chant-like choir pad (numpy formant synthesis). No piano, no strings.
Run: $LIB/.venv/bin/python music/score.py  -> music/stems/*.wav, music/cues.json (note onsets that carry a visual cue)
"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, lp, hp, bp
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
TL = json.load(open(os.path.join(ROOT, 'timeline.json')))
BEAT = TL['BEAT']; DUR = TL['DUR']; T = TL['T']; N = int(round(DUR * SR))
def b(n): return n * BEAT
S.seed(20)
CUES = []   # (name, t) of notes that carry a picture cue

def fit(x):
    x = x[:N] if len(x) >= N else np.vstack([x, np.zeros((N - len(x), 2), np.float32)])
    return x.astype(np.float32)
def stem(events, size=.85, mix=.3, damp=.5):
    x = fit(S.render(events, dur=DUR + 4, master=False))
    return S.room(x, size=size, mix=mix, damp=damp).astype(np.float32)
def ev(t, inst, pitch, dur, vel, pan=0., **k):
    d = dict(t=t, inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan); d.update(k); return d

# ---------------- choir pad (formant synthesis, "oo" -> "ah") ----------------
MID = lambda p: S.midi(p)
FORM = {'oo': [(320, 1.0, 80), (800, .35, 100), (2500, .06, 150)], 'ah': [(700, 1.0, 110), (1150, .6, 120), (2600, .12, 160)], 'oh': [(450, 1.0, 90), (850, .45, 100), (2600, .08, 150)]}
def choir(t0, pitches, dur, vel=.5, vowel='oo', vowel2=None, att=.8, rel=.6, voices=5):
    n = int((dur + rel) * SR); tt = np.arange(n) / SR; out = np.zeros(n)
    rng = np.random.default_rng(int(t0 * 100) + len(pitches))
    for p in pitches:
        f0 = 440 * 2 ** ((MID(p) - 69) / 12)
        for v in range(voices):
            det = 2 ** ((rng.uniform(-9, 9)) / 1200); vr = rng.uniform(4.6, 5.8); vd = .004 + rng.uniform(0, .003)
            ph = 2 * np.pi * np.cumsum(f0 * det * (1 + vd * np.sin(2 * np.pi * vr * tt + rng.uniform(0, 6)) * np.clip(tt / .6, 0, 1))) / SR
            mix = np.clip(tt / max(dur, 1e-3), 0, 1) if vowel2 else np.zeros(n)
            for h in range(1, 24):
                fh = f0 * h
                if fh > 7000: break
                def amp(form): return sum(a * np.exp(-((fh - F) / bw) ** 2 / 2) for F, a, bw in form) + .015
                a = amp(FORM[vowel]) * (1 - mix) + (amp(FORM[vowel2]) * mix if vowel2 else 0)
                out += a * np.sin(h * ph + rng.uniform(0, 6)) / h ** .3
    env = np.minimum(1, tt / att) * np.clip((dur + rel - tt) / rel, 0, 1)
    out = hp(out * env, 120) * vel
    out /= max(1e-9, np.abs(out).max()) / (.25 * vel)
    st = np.zeros((N, 2), np.float32); s = int(t0 * SR); e = min(N, s + n)
    if s < N: st[s:e, 0] = out[:e - s] * .9; st[s:e, 1] = np.roll(out, 240)[:e - s] * .9
    return st

def zero_from(x, t0, fade=.004):
    i = int(round(t0 * SR)); f = int(fade * SR); x[i - f:i] *= np.linspace(1, 0, f)[:, None]; x[i:] = 0
def zero_between(x, a, c, fade=.004):
    i, j = int(round(a * SR)), int(round(c * SR)); f = min(int(fade * SR), i)
    if f: x[i - f:i] *= np.linspace(1, 0, f)[:, None]
    x[i:j] = 0

# ======================= A dawn (0-5) + B phoenix (5-11): organ drone, chimes, harp, recorder =======================
drone = []
drone += [ev(b(0), 'organ_pedal', 'D2', b(11) - .05, .42, 0, attack=1.2)]
drone += [ev(b(.5), 'organ_soft', 'D3', b(4.5), .32, -.2, attack=2.0), ev(b(.5), 'organ_soft', 'A3', b(4.5), .28, .2, attack=2.4)]
drone += [ev(T['reveal'], 'organ_soft', p, b(3), .34, pn, attack=.25) for p, pn in [('D3', -.2), ('A3', .2), ('D4', 0), ('E4', .1)]]
drone += [ev(b(8), 'organ_soft', p, b(1.5), .32, 0, attack=.3) for p in ('C3', 'G3', 'C4', 'E4')]
drone += [ev(b(9.5), 'organ_soft', p, b(1.5) - .03, .32, 0, attack=.3) for p in ('Bb2', 'F3', 'D4', 'F4')]
DRONE = stem(drone, .9, .34)

ch = []
light = ['A4', 'D5', 'E5', 'F5', 'G5', 'A5', 'C6']   # one note per wakened pane, rising
for i, tt in enumerate(T['petals']):
    ch.append(ev(tt, 'hand_chimes', light[i], 1.6, .55 + i * .04, -.5 + i * .16)); CUES.append(('pane%d' % i, tt))
ch.append(ev(T['petals'][0], 'glass', 'D6', 2.4, .5, -.3))           # the light itself
ch.append(ev(T['reveal'], 'tubular_bells', 'D4', 3.0, .62, 0)); CUES.append(('reveal', T['reveal']))
ch.append(ev(T['reveal'], 'glass', 'A5', 2.0, .4, .3))
ch.append(ev(T['reveal'], 'timpani', 'D2', 2.0, .5, 0))            # weight under the reveal bell
for k, p in enumerate(['D3', 'A3', 'D4', 'F4', 'A4', 'D5']):           # harp run into the reveal
    ch.append(ev(b(4) + k * b(1) / 6, 'harp', p, 1.2, .5 + k * .05, -.2 + k * .08))
# harp eighths under the phoenix (Dorian i - VII - VI)
pat = {5: ['D4', 'A4', 'F4', 'A4'], 6: ['D4', 'A4', 'F4', 'A4'], 7: ['D4', 'A4', 'E4', 'A4'], 8: ['C4', 'G4', 'E4', 'G4'], 9: ['C4', 'G4', 'E4', 'G4'], 10: ['Bb3', 'F4', 'D4', 'F4']}
for bt, ps in pat.items():
    for k, p in enumerate(ps):
        ch.append(ev(b(bt) + k * b(.25), 'harp', p, .9, .36 if k else .44, .25))
for F in T['flaps']:   # wing down-strokes: a soft timpani + a low harp
    ch.append(ev(F, 'timpani', 'D2', 1.2, .34, -.1)); ch.append(ev(F, 'harp', 'D2', 1.4, .5, -.2)); CUES.append(('flap', F))
for tt, p in [(b(10), 'A5'), (b(10) + b(.25), 'C6'), (b(10) + b(.5), 'D6')]:   # the sun moves
    ch.append(ev(tt, 'glass', p, 1.2, .35, .35))
CHIME = stem(ch, .88, .32)

rec = []
for bt, p, d in [(6.5, 'A4', .5), (7, 'C5', .5), (7.5, 'D5', 1), (8.5, 'E5', .5), (9, 'D5', .5), (9.5, 'C5', .5), (10, 'B4', .5), (10.5, 'A4', .5)]:
    rec.append(ev(b(bt), 'recorder', p, b(d) * .95, .5, .15, attack=.04))
REC = stem(rec, .85, .3)

# ======================= C fire (11-15): full organ, timpani, accelerating =======================
fire = []
fire += [ev(T['ignite'], 'organ_pedal', 'D2', b(4) - .02, .5, 0)]
grid = [(11, 1, ('D3', 'F3', 'A3', 'D4')), (12, .5, ('Bb2', 'F3', 'Bb3', 'D4')), (12.5, .5, ('Bb2', 'F3', 'Bb3', 'D4')), (13, .5, ('C3', 'G3', 'C4', 'E4')),
        (13.5, .25, ('C3', 'G3', 'C4', 'E4')), (13.75, .25, ('C3', 'G3', 'C4', 'E4')), (14, .25, ('D3', 'A3', 'D4', 'F4')), (14.25, .25, ('D3', 'A3', 'D4', 'F4')),
        (14.5, .25, ('E3', 'A3', 'C#4', 'E4')), (14.75, .25, ('E3', 'A3', 'C#4', 'G4'))]
for bt, d, chord in grid:
    for p in chord: fire.append(ev(b(bt), 'organ', p, b(d) * .86, .62 + (bt - 11) * .07, 0))
top = {12: 'D5', 13: 'E5', 13.5: 'F5', 14: 'G5', 14.5: 'A5', 14.75: 'Bb5'}
for bt, p in top.items(): fire.append(ev(b(bt), 'organ', p, b(.25) * .9, .8, .1))
fire.append(ev(T['ignite'], 'timpani', 'D2', 1.5, .8, 0)); CUES.append(('ignite', T['ignite']))
for i, tc in enumerate(T['cracks']): fire.append(ev(tc, 'timpani', 'A1' if i % 2 else 'D2', 1.0, .85 + i * .02, 0)); CUES.append(('crack%d' % (i + 1), tc))
for k in range(16):   # timpani roll, crescendo into the break
    tt = b(13.5) + k * b(1.5) / 16
    if any(abs(tt - tc) < 1e-6 for tc in T['cracks']): continue
    fire.append(ev(tt, 'timpani', 'D2', .5, .3 + .035 * k, 0))
FIRE = stem(fire, .82, .26)

# ======================= D mend (17-21) + E noon (21-23) =======================
mend = []
CUES.append(('weld0', T['firstWeld']))
scale = ['D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5']
for i, w in enumerate(T['welds']):
    mend.append(ev(w, 'hand_chimes', scale[i], 1.4, .62, -.3 + i * .1)); mend.append(ev(w, 'organ_soft', scale[i], b(.5) * .98 if i < 6 else b(.5), .42, .1, attack=.03))
    CUES.append(('weld%d' % (i + 1), w))
mend.append(ev(b(17.5), 'organ_soft', 'D3', b(3.5) - .02, .34, -.15, attack=1.4)); mend.append(ev(b(19), 'organ_soft', 'A3', b(2) - .02, .32, .15, attack=.8))
mend.append(ev(b(17.5), 'organ_pedal', 'D2', b(3.5) - .02, .32, 0, attack=1.6))
# noon: D major
bl = T['blaze']
for p in ('D2', 'D3', 'A3', 'D4', 'F#4', 'A4', 'D5'): mend.append(ev(bl, 'organ', p, b(2) + .3, .66, 0, attack=.02))
mend.append(ev(bl, 'organ_pedal', 'D2', b(2) + .3, .6, 0))
mend.append(ev(bl, 'tubular_bells', 'D4', 4.0, .8, -.15)); mend.append(ev(bl + b(.5), 'tubular_bells', 'A4', 4.0, .55, .2)); mend.append(ev(bl + b(1), 'tubular_bells', 'F#4', 4.0, .45, 0))
mend.append(ev(bl, 'timpani', 'D2', 2.0, .8, 0)); mend.append(ev(bl, 'hand_chimes', 'D6', 2.5, .5, .3)); mend.append(ev(bl, 'glass', 'D6', 2.5, .45, -.3)); mend.append(ev(bl, 'harp', 'D3', 2.0, .6, -.1))
for k, p in enumerate(['A4', 'D5', 'F#5', 'A5', 'D6']): mend.append(ev(bl + b(.5) + k * b(.25), 'harp', p, 1.6, .45, .2))
CUES.append(('blaze', bl)); CUES.append(('carve', T['carve']))
MEND = stem(mend, .9, .36)
# the first sound after the silence: its own, very long reverb
bell = fit(S.render([ev(T['firstWeld'], 'tubular_bells', 'D3', 6.0, .95, 0), ev(T['firstWeld'], 'tubular_bells', 'D4', 4.0, .35, .1)], dur=DUR + 4, master=False))
BELL = S.room(bell, size=.97, mix=.5, damp=.4).astype(np.float32)

CHOIR = choir(b(3), ['D4', 'A4'], b(2.2), .45, 'oo') + choir(T['reveal'], ['D4', 'A4', 'D5'], b(6) - .05, .5, 'oo', 'oh')
CHOIR += choir(T['ignite'], ['D4', 'F4', 'A4', 'D5'], b(4) - .02, .6, 'ah', rel=.02, att=.25)
CHOIR = S.room(CHOIR, size=.9, mix=.4, damp=.5).astype(np.float32)
CHOIR2 = choir(b(18), ['D4', 'A4'], b(3), .42, 'oo', 'ah', att=1.6, rel=.02) + choir(bl, ['D4', 'F#4', 'A4', 'D5'], b(2) + .3, .62, 'ah', att=.05)
CHOIR2 = S.room(CHOIR2, size=.9, mix=.4, damp=.5).astype(np.float32)

# ---------------- 16' pedal sub (numpy): the sampled pedal is bright, so its weight is synthesized under it ----------------
def sub(t0, dur, p, vel, att=.3, rel=.5):
    f = 440 * 2 ** ((MID(p) - 69) / 12); n = int((dur + rel) * SR); tt = np.arange(n) / SR
    y = np.sin(2 * np.pi * f * tt) + .35 * np.sin(4 * np.pi * f * tt + .7) + .12 * np.sin(6 * np.pi * f * tt + 1.9)
    env = np.minimum(1, tt / att) * np.clip((dur + rel - tt) / rel, 0, 1) * (1 + .03 * np.sin(2 * np.pi * 5.1 * tt))
    st = np.zeros((N, 2), np.float32); s0 = int(round(t0 * SR)); e = min(N, s0 + n)
    if s0 < N: st[s0:e, 0] = st[s0:e, 1] = (y * env * vel)[:e - s0]
    return st
SUB_A = sub(0, b(11) - .05, 'D2', .32, 1.2) + sub(T['reveal'], b(3), 'D1', .35, .08, .9) + sub(T['ignite'], b(4) - .02, 'D2', .45, .05) + sub(T['ignite'], b(4) - .02, 'D1', .3, .4)
SUB_B = sub(b(17.5), b(3.5) - .02, 'D2', .28, 1.6) + sub(T['blaze'], b(2) + .3, 'D2', .5, .02) + sub(T['blaze'], b(2) + .3, 'D1', .45, .02, .8)
SUB_A = S.room(SUB_A, size=.85, mix=.18, damp=.6).astype(np.float32); SUB_B = S.room(SUB_B, size=.85, mix=.18, damp=.6).astype(np.float32)
zero_from(SUB_A, T['shatter']); zero_between(SUB_B, 0, T['firstWeld']); SUB = SUB_A + SUB_B

# ---------------- the hard stop: everything (reverb tails included) cuts at the break, returns at the first weld ----------------
for x in (DRONE, CHIME, REC, FIRE, CHOIR): zero_from(x, T['shatter'])
zero_between(MEND, T['shatter'], T['firstWeld']); zero_between(CHOIR2, 0, T['firstWeld'])
CHOIR = CHOIR + CHOIR2
# gentle tail at the very end
fe = int(round((DUR - .35) * SR))
for x in (DRONE, CHIME, REC, FIRE, MEND, BELL, CHOIR, SUB): x[fe:] *= np.linspace(1, .25, len(x) - fe)[:, None]

os.makedirs(os.path.join(HERE, 'stems'), exist_ok=True)
for n, x in dict(drone=DRONE, chime=CHIME, recorder=REC, fire=FIRE, mend=MEND, bell=BELL, choir=CHOIR, sub=SUB).items():
    sf.write(os.path.join(HERE, 'stems', n + '.wav'), x, SR)
json.dump({'cues': [{'name': n, 't': t} for n, t in CUES], 'instruments': sorted({e['inst'] for e in drone + ch + rec + fire + mend})}, open(os.path.join(HERE, 'cues.json'), 'w'), indent=1)
print('stems written', {n: round(float(np.abs(x).max()), 3) for n, x in dict(drone=DRONE, chime=CHIME, recorder=REC, fire=FIRE, mend=MEND, bell=BELL, choir=CHOIR).items()})
