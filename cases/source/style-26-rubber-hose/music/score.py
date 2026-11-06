"""score.py — original hot-dance-band score for 闹钟起床号 (F major; 144 → 180 → stop → 144 BPM).
Reads ../timeline.json (the one time source). Samples via core/audio/sampler.py (VSCO 2 CE / VCSL / FreePats),
banjo via core/audio/pluck.py; slide whistle and trombone smear in numpy.
Output: music/score.wav (48 kHz stereo) + music/score.json (accent onsets per hit, for cuecheck).
Run from the library root: $LIB/.venv/bin/python <film>/music/score.py"""
import os, sys, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
HERE = os.path.dirname(os.path.abspath(__file__)); FILM = os.path.dirname(HERE)
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S          # noqa: E402
from core.audio import pluck as PL            # noqa: E402
from core.audio.sfx import SR, add             # noqa: E402

TL = json.load(open(os.path.join(FILM, 'timeline.json')))
SEC = {s['id']: s for s in TL['secs']}; H = TL['h']; DUR = TL['dur']
def T(sid, b=0.0): s = SEC[sid]; return s['t0'] + b * s['beat']
BT = lambda sid: SEC[sid]['beat']
N = int(round((DUR + .2) * SR))
S.seed(26)
STEMS = ['brass', 'reeds', 'piano', 'rhythm', 'drums', 'tuba_hit']
buf = {k: np.zeros((N, 2), np.float32) for k in STEMS}
ACC = {}   # accent onsets: name -> time

LEAD = {'tuba_stac': .022, 'tuba': .025, 'trumpet': .018, 'trumpet_stac': .012, 'trumpet_mute': .02, 'trombone': .02, 'trombone_stac': .015, 'clarinet': .015, 'clarinet_stac': .008}
def put(stem, x, t, gain=1.0, pan=0.0, lead=0.0):
    add(buf[stem], np.asarray(x, np.float32), t - lead, gain, pan)
def nt(stem, inst, pitch, t, dur, vel=.7, gain=1.0, pan=0.0, **kw):
    put(stem, S.note(inst, pitch, dur, vel, **kw), t, gain, pan, LEAD.get(inst, 0.0))
def up(p, k=12): return S.name(S.midi(p) + k)

CH = {  # root, fifth (tuba), chord tones (piano/banjo middle register)
    'F': ('F2', 'C2', ['A3', 'C4', 'F4']), 'F6': ('F2', 'C2', ['A3', 'D4', 'F4']), 'C7': ('C2', 'G2', ['E3', 'Bb3', 'C4']),
    'D7': ('D2', 'A2', ['F#3', 'C4', 'D4']), 'G7': ('G2', 'D2', ['F3', 'B3', 'D4']), 'Bb': ('Bb1', 'F2', ['F3', 'Bb3', 'D4']),
    'Bdim': ('B1', 'F2', ['F3', 'Ab3', 'D4']),
}
def lift(p): return up(p) if S.midi(p) < 36 else p

def stride(sid, b, chord, vel=.6):
    """stride piano for one beat: bass octave on even beats, chord on odd beats"""
    root, fifth, tri = CH[chord]; t = T(sid, b); d = BT(sid)
    if int(round(b)) % 2 == 0:
        p = root if int(round(b)) % 4 == 0 else fifth
        nt('piano', 'upright', p, t, d * .8, vel, .85, -.15); nt('piano', 'upright', up(p), t, d * .8, vel * .85, .65, -.15)
    else:
        for p in tri: nt('piano', 'upright', p, t, d * .35, vel * .8, .5, .1)
def oompah(sid, b, chord, vel=.62):
    root, fifth, tri = CH[chord]; t = T(sid, b); d = BT(sid)
    if int(round(b)) % 2 == 0:
        p = lift(root) if int(round(b)) % 4 == 0 else lift(fifth)
        nt('rhythm', 'tuba_stac', p, t, d * .6, vel, 1.3, -.1)
    else:
        x = PL.strum('banjo', [up(q) for q in tri] + [up(tri[0], 24)], d * .5, vel * .9, spread=.012)
        put('rhythm', x, t - .012, .5, .35)
def brush(sid, b, vel=.45, seed=0):
    rng = np.random.default_rng(int(seed * 100 + b * 7)); d = BT(sid); n = int(d * .9 * SR)
    w = sosfilt(butter(2, [1800, 7000], 'band', fs=SR, output='sos'), rng.standard_normal(n))
    e = np.linspace(0, 1, n) ** .5 * np.exp(-np.linspace(0, 4, n)); put('drums', (w * e * .05 * vel).astype(np.float32), T(sid, b), 1, .05)
    if int(round(b)) % 2: put('drums', S.hit('snare2', 'taps', vel * .7), T(sid, b), .9, 0)
def cymbal(t, vel=.8, short=False, pan=.1):
    put('drums', S.hit('clash', 'short') if short else S.hit('crash', None, vel), t - .012, .7 if not short else .85, pan)
def roll(t0, t1, v0=.2, v1=.8):
    d = t1 - t0; x = S.hit('snare', 'roll', .8)
    if len(x) < d * SR: x = np.concatenate([x] * int(np.ceil(d * SR / len(x) + 1)))
    x = x[:int(d * SR)].copy(); x *= np.linspace(v0, v1, len(x), dtype=np.float32); x[-240:] *= np.linspace(1, 0, 240)
    put('drums', x, t0, 1.0, 0)
def mel(stem, inst, sid, notes, vel=.72, pan=0., legato=.95, gain=1.0, shift=0):
    for off, d, p in notes:
        nt(stem, inst, up(p, shift) if shift else p, T(sid, off), d * BT(sid) * legato, vel, gain, pan)
def smear(t, d, p0, p1, vel=.7, gain=1.0, pan=-.1):
    """trombone smear: a sampled note pitch-bent by resampling with a glide"""
    x = S.note('trombone', p0, d, vel).astype(np.float64); n = len(x)
    ratio = 2 ** ((S.midi(p1) - S.midi(p0)) / 12 * np.clip(np.arange(n) / (d * SR * .8), 0, 1))
    idx = np.cumsum(ratio); idx = idx[idx < n - 1]; i0 = idx.astype(int); fr = idx - i0
    y = x[i0] * (1 - fr) + x[i0 + 1] * fr
    put('brass', y.astype(np.float32), t - .02, gain, pan)

# ======================= A · breathe (144, 8 beats): the clock ticks; a soft lazy piano, a clarinet pickup =======================
for b in range(8):
    stride('A', b, 'F' if b < 4 else 'C7', .32)
mel('reeds', 'clarinet', 'A', [(0, 1.5, 'A4'), (2, 1.5, 'G4')], .42, -.25, gain=.7)          # a yawn on the clarinet
mel('reeds', 'clarinet_stac', 'A', [(5, .5, 'C4'), (5.5, .5, 'D4'), (6, .5, 'E4'), (6.5, .5, 'F4'), (7, .5, 'G4'), (7.5, .5, 'Bb4')], .62, -.25)   # pickup run into the alarm
roll(T('A', 6), T('B', 0), .1, .7)

# ======================= B · ring (144, 12 beats): full band, the theme, every gag answered =======================
THEME = [(0, .5, 'A4'), (.5, .5, 'C5'), (1, .75, 'D5'), (1.75, .75, 'C5'), (2.5, .5, 'A4'), (3, 1, 'F4'),
         (4, .5, 'F#4'), (4.5, .5, 'A4'), (5, .5, 'C5'), (5.5, 1, 'D5'), (6.5, .5, 'B4'), (7, 1, 'G4'),
         (8, .5, 'E4'), (8.5, .5, 'G4'), (9, .5, 'Bb4'), (9.5, .75, 'C5'), (10.5, .5, 'Bb4'), (11, .5, 'G4'), (11.5, .5, 'E4')]
BCH = ['F'] * 4 + ['D7', 'D7', 'G7', 'G7'] + ['C7'] * 4
mel('reeds', 'clarinet', 'B', THEME, .74, -.25, gain=.9)
mel('brass', 'trumpet_mute', 'B', [(o, d, p) for o, d, p in THEME if o < 4 or o >= 8], .55, .25, gain=.45, shift=-3 + 3)   # muted trumpet doubles bars 1 and 3
for b in range(12):
    stride('B', b, BCH[b], .6); oompah('B', b, BCH[b], .62); brush('B', b, .5, 1)
# B0 the alarm: band hit
cymbal(T('B', 0), .8); nt('brass', 'trumpet_stac', 'C5', T('B', 0), BT('B') * .5, .85, .8, .2); nt('brass', 'trombone_stac', 'F3', T('B', 0), BT('B') * .5, .8, .8, -.1)
put('drums', S.hit('bass_drum', None, .8), T('B', 0), .9); ACC['ring'] = T('B', 0)
# B3 grab: woodblock is foley; B4 curtain open: cymbal + trumpet "ta!"
cymbal(T('B', 4), .75); nt('brass', 'trumpet_stac', 'F5', T('B', 4), BT('B') * .45, .9, .9, .2); ACC['curtainOpen'] = T('B', 4)
# B6 pillow: trombone smear down "wah"
smear(T('B', 6), BT('B') * 1.2, 'Bb3', 'F3', .72, 1.3); ACC['pillow'] = T('B', 6)
# B8 yank: rimshot + stab + crash
put('drums', S.hit('snare', 'on', .9), T('B', 8), 1.0); cymbal(T('B', 8), .7, short=True)
nt('brass', 'trumpet_stac', 'G5', T('B', 8), BT('B') * .4, .9, .85, .2); ACC['yank'] = T('B', 8)
# B9–B11 shiver: xylophone chatter (sixteenths)
for k in range(12):
    nt('rhythm', 'xylophone', 'D6' if k % 2 else 'C#6', T('B', 9 + k * .25), .08, .45, .6, .3)
# B11: snare pickup into the tempo change
roll(T('B', 11), T('C', 0), .2, .9)

# ======================= C · bugle (180, 12 beats): acceleration; the bugle call is the melody =======================
# C0–C1: the bugle appears, the inhale: tuba pedal + snare roll crescendo, piano tremolo
nt('rhythm', 'tuba', 'C3', T('C', 0), BT('C') * 1.9, .6, 1.1, -.1)
roll(T('C', 0), T('C', 2), .25, 1.0)
for k in range(8): nt('piano', 'upright', 'C3' if k % 2 else 'G3', T('C', k * .25), .06, .5, .55, 0)
ACC['trumpet'] = T('C', 0)
BUGLE = [(2, .75, 'C5'), (3, .75, 'F5'), (4, 1.4, 'A5'), (5.5, .5, 'G5'), (6, .5, 'F5'), (6.5, .5, 'A5'), (7, 1, 'C6'),
         (8, .5, 'A5'), (8.5, .5, 'Bb5'), (9, .5, 'C6'), (9.5, .5, 'A5'), (10, .5, 'F5'), (10.5, .5, 'G5'), (11, .45, 'A5'), (11.5, .45, 'C6')]
mel('brass', 'trumpet', 'C', BUGLE, .9, .15, legato=.9, gain=1.15)
mel('brass', 'trumpet', 'C', [(o, d, p) for o, d, p in BUGLE], .7, -.15, legato=.9, gain=.45, shift=-5)   # a second trumpet a fourth below
ACC['blast'] = T('C', 2); ACC['ch2'] = T('C', 3); ACC['ch3'] = T('C', 4)
CCH = {2: 'F', 3: 'F', 4: 'F', 5: 'F', 6: 'Bb', 7: 'Bb', 8: 'F', 9: 'F', 10: 'C7', 11: 'C7'}
for b in range(2, 12):
    stride('C', b, CCH[b], .72); oompah('C', b, CCH[b], .74)
    if b % 2: put('drums', S.hit('snare', 'on', .62), T('C', b), .8)
    else: put('drums', S.hit('bass_drum', None, .7), T('C', b), .8)
    for h in (0, .5): put('drums', S.hit('hihat', 'closed', .4), T('C', b + h), .45, .2)
cymbal(T('C', 2), .85); cymbal(T('C', 8), .8)
# clarinet countermelody: running eighths under the bugle
CL = ['F4', 'A4', 'C5', 'A4', 'F4', 'A4', 'C5', 'D5', 'Bb4', 'D5', 'F5', 'D5', 'C5', 'A4', 'F4', 'A4', 'E4', 'G4', 'Bb4', 'C5']
for k, p in enumerate(CL): nt('reeds', 'clarinet_stac', p, T('C', 2 + k * .5), BT('C') * .45, .5, .5, -.3)
# C10–C11: the hand rises — trombone glissando creeping up under the band
smear(T('C', 10), BT('C') * 2 - .03, 'F2', 'C3', .6, 1.0)
# last band hit on C11, then hard stop at D0
put('drums', S.hit('crash', None, .6), T('C', 11) - .012, .45)
put('drums', S.hit('snare', 'on', .85), T('C', 11), .7)   # the hand reaches the top: a dry rimshot on top of the snare
ACC['handRise'] = T('C', 10); ACC['handTop'] = T('C', 11); ACC['danceMax'] = T('C', 8)
put('drums', S.hit('snare', 'on', .8), T('C', 8), .75)   # the whole room's biggest hop: a rimshot on top of the bass drum

# ======================= E · slap (144): the most important sound — tuba low F, after silence =======================
nt('tuba_hit', 'tuba', 'F1', T('E', 0), 1.5, .98, 1.6, 0, release=.5)
nt('tuba_hit', 'tuba', 'F2', T('E', 0), 1.2, .8, .8, 0, release=.4)
put('tuba_hit', S.hit('bass_drum', None, 1.0), T('E', 0), 1.2); put('tuba_hit', S.hit('gran_cassa', 'hit', .9), T('E', 0), .8)
ACC['slap'] = T('E', 0)
# E2: a lonely muted trumpet droop for the flattened clock (soft)
nt('brass', 'trumpet_mute', 'A4', T('E', 2) + .02, BT('E') * .8, .45, .5, .2); nt('brass', 'trumpet_mute', 'Ab4', T('E', 3), BT('E') * .9, .4, .45, .2)

# ======================= F · boing back (144, 6 beats): the band returns, the bow, ta-da =======================
cymbal(T('F', 0), .8); ACC['boing'] = T('F', 0)
FCH = ['F', 'F', 'C7', 'C7', 'F6', 'F6']
mel('brass', 'trumpet', 'F', [(0, .5, 'A4'), (.5, .5, 'C5'), (1, .75, 'D5'), (1.75, .75, 'C5')], .82, .2, gain=.9)
mel('reeds', 'clarinet', 'F', [(0, .5, 'F5'), (.5, .5, 'A5'), (1, .75, 'Bb5'), (1.75, .75, 'A5')], .6, -.25, gain=.55)
for b in range(6):
    if b == 2: continue   # stop-time on the crouch
    stride('F', b, FCH[b], .62); oompah('F', b, FCH[b], .64); brush('F', b, .45, 2)
put('drums', S.hit('clash', 'short'), T('F', 2) - .01, .7); nt('brass', 'trumpet_stac', 'G4', T('F', 2), BT('F') * .4, .7, .7, .2)
# F3 the bow: ta-da (trumpet + clarinet + trombone, F6 chord) + cymbal
for inst, p, g, pan in [('trumpet', 'D5', .9, .2), ('trumpet', 'A4', .6, .1), ('clarinet', 'F5', .6, -.25), ('trombone', 'C4', .7, -.1), ('trombone', 'F3', .6, -.15)]:
    nt('brass' if inst != 'clarinet' else 'reeds', inst, p, T('F', 3) + .010, BT('F') * .9, .85, g, pan)   # +10 ms: lands on the bow frame
cymbal(T('F', 3) + .010, .75); ACC['bow'] = T('F', 3)   # +10 ms: the crash sample's pre-attack landed early
# F4 the reach: clarinet run up; F5 grab → snare roll into the iris shut
mel('reeds', 'clarinet_stac', 'F', [(4, .25, 'C5'), (4.25, .25, 'D5'), (4.5, .25, 'E5'), (4.75, .25, 'F5')], .6, -.25)
roll(T('F', 5), T('G', 0), .2, .95)

# ======================= G · the end: final chord, the button =======================
for inst, p, g, pan in [('trumpet', 'A5', .85, .2), ('trumpet', 'F5', .6, .1), ('clarinet', 'C6', .5, -.25), ('trombone', 'C4', .7, -.1), ('trombone', 'A3', .55, -.15)]:
    nt('brass' if inst != 'clarinet' else 'reeds', inst, p, T('G', 0), BT('G') * 3.2, .82, g, pan, release=.6)
nt('rhythm', 'tuba', 'F2', T('G', 0), BT('G') * 3, .75, 1.2, -.1)
for p in ['F2', 'C3', 'F3', 'A3', 'C4', 'F4']: nt('piano', 'upright', p, T('G', 0), BT('G') * 3, .7, .5, 0)
nt('rhythm', 'glockenspiel', 'F6', T('G', 0), 2.0, .6, .45, .3)
cymbal(T('G', 0), .8); ACC['irisShut'] = T('G', 0)
# G1–G3: a soft vamp under the held chord, one stab per beat, for the roundel's traveling-wave hops
for k, (p, v) in enumerate([('C3', .42), ('F2', .46), ('C3', .5)], 1):
    nt('rhythm', 'tuba_stac', p, T('G', k), BT('G') * .35, v + .2, 1.2, -.1)
    for q in ['A3', 'C4', 'F4']: nt('piano', 'upright', q, T('G', k), BT('G') * .3, v + .1, .5, .1)
    put('drums', S.hit('snare', 'on', .55), T('G', k), .75, 0); ACC[f'hop{k}'] = T('G', k)
# the button: bum (G4, the wink) — BUM (G5, the bells pop up like a hat)
nt('rhythm', 'tuba_stac', 'C3', T('G', 4), BT('G') * .4, .72, 1.2, -.1); nt('piano', 'upright', 'C3', T('G', 4), BT('G') * .4, .7, .6, 0)
ACC['wink'] = T('G', 4)
nt('rhythm', 'tuba_stac', 'F2', T('G', 5), BT('G') * .8, .92, 1.4, -.1)
for p in ['F2', 'F3', 'A3', 'C4', 'F4']: nt('piano', 'upright', p, T('G', 5), BT('G') * .95, .82, .55, 0)
put('drums', S.hit('clash', 'short'), T('G', 5), .6); ACC['hatPop'] = T('G', 5)

# ======================= hard stop: the band stop is silent, reverb tails included =======================
mix = sum(buf[k] * {'brass': .95, 'reeds': .85, 'piano': .8, 'rhythm': .95, 'drums': .7, 'tuba_hit': 1.1}[k] for k in STEMS)
mix = S.room(mix, size=.28, mix=.14)
gate = np.ones(N, np.float32); s0, s1 = int(T('D', 0) * SR), int(T('E', 0) * SR - .025 * SR)
gate[s0:s1] = 0; gate[s0 - 120:s0] = np.linspace(1, 0, 120)
mix *= gate[:, None]
mix = mix[:int(round(DUR * SR))]
pk = np.abs(mix).max(); mix = mix / pk * .9
sf.write(os.path.join(HERE, 'score.wav'), mix.astype(np.float32), SR)
json.dump({'acc': ACC, 'dur': DUR}, open(os.path.join(HERE, 'score.json'), 'w'), indent=1)
inst_used = ['upright', 'clarinet', 'clarinet_stac', 'trumpet', 'trumpet_mute', 'trumpet_stac', 'trombone', 'trombone_stac', 'tuba', 'tuba_stac', 'xylophone', 'glockenspiel', 'snare', 'snare2', 'crash', 'clash', 'bass_drum', 'gran_cassa', 'hihat']
open(os.path.join(HERE, 'credits.txt'), 'w').write('\n'.join(S.credits(inst_used)) + '\n')
print('score.wav', round(DUR, 3), 's, peak normalised; accents:', {k: round(v, 3) for k, v in ACC.items()})
