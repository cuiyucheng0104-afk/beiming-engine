"""明日早晨 — original score + foley + ambience → out/mix.wav (and stems, music_hits.json for cuecheck.py)

Score: a West-Coast cool-jazz combo on the timeline's own beat grid (timeline.json, written from timeline.js):
  whistled melody (numpy synthesis: sine + breath band + scoops, glides, vibrato, trills)
  swing xylophone answers and eighth runs (VCSL xylophone) · vibraphone, one chord per step (VCSL)
  pizzicato double bass walking (Karoryfer Sneakybass) · brushes (synthesised) → ride (MuldjordKit) · finger snaps · bongos
  B-flat major, 144 BPM (10 frames per beat) → accelerando to 240 BPM → up a whole step to C major for the ornament.
Foley is driven from window.EV (events.json), every sound on its frame. Silence: b25–b27 everything cut, room tone included;
the toaster bell on b28 is the first sound after it.
Run: $LIB/.venv/bin/python mix.py      (LIB defaults to @@LEMO_ROOT@@)
"""
import sys, os, json, math
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio import sampler as S
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, clack, whoosh, creak, thump, ding as sding, limit

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
FPS = TL['fps']; BT = TL['beats']; DUR = TL['dur']; N = int(round(DUR * SR)); HIT = TL['hit']; BF = TL['beat_f']
S.seed(48); rng = np.random.default_rng(48)


def T(b):
    """time of global beat b (fractions interpolate inside that beat; the grid is in whole frames)"""
    i = int(math.floor(b + 1e-9)); fr = b - i
    return BT[i] + (BT[i + 1] - BT[i]) * fr


def L(i): return BT[i + 1] - BT[i]
def M(p): return S.midi(p) if isinstance(p, str) else p


STEMS = ('drums', 'bass', 'vib', 'xylo', 'lead', 'foley', 'amb')
st = {k: np.zeros((N, 2), np.float32) for k in STEMS}
HITS = []


def put(stem, x, t, g=1.0, pan=0.0, label=None):
    """sample-exact placement (rounded, never truncated) + optional cue label for cuecheck"""
    s = int(round(t * SR))
    if label: HITS.append(dict(label=label, t=s / SR, stem=stem))
    if s >= N: return
    x = np.asarray(x, np.float32)
    if s < 0: x = x[-s:]; s = 0
    e = min(N, s + len(x)); l, r = math.cos((pan + 1) * math.pi / 4), math.sin((pan + 1) * math.pi / 4)
    st[stem][s:e, 0] += x[:e - s] * g * l * 1.414; st[stem][s:e, 1] += x[:e - s] * g * r * 1.414


def jit(ms=5): return float(rng.uniform(-ms, ms)) / 1000
def sine(f, d): return np.sin(2 * np.pi * np.cumsum(np.broadcast_to(f, len(t_(d))).astype(float)) / SR)
def nz(d): return rng.standard_normal(len(t_(d)))
def env_ad(d, a=.004, tau=.1):
    x = env_exp(d, tau); n = int(a * SR)
    if n: x[:n] *= np.linspace(0, 1, n)
    return x
def mixn(*xs):
    n = max(len(x) for x in xs); return sum(np.pad(x, (0, n - len(x))) for x in xs)


# ================================================================ instruments
def motor(x, rate=5.0, depth=.3, t0=0.):
    tt = np.arange(len(x)) / SR + t0
    return x * (1 - depth * (.5 + .5 * np.sin(2 * np.pi * rate * tt))).astype(np.float32)


def vib(t, pitches, dur, vel=.45, hard=False, trem=0., pan=-.25, g=1.0, label=None, bowed=False):
    inst = 'vibraphone_bowed' if bowed else ('vibraphone_hard' if hard else 'vibraphone')
    for i, p in enumerate(pitches):
        x = S.note(inst, M(p), dur, vel=vel, attack=.25 if bowed else 0)
        if trem: x = motor(x, depth=trem, t0=i * .011)
        put('vib', x, t, g, pan + (i - 1.5) * .07, label if i == 0 else None)


def xy(t, p, vel=.5, pan=.3, g=1.0, label=None, ring=.5):
    put('xylo', S.note('xylophone', M(p), ring, vel=vel), t, g, pan, label)


def bass(t, p, beats=.95, vel=.62, g=1.0, label=None, bl=None):
    d = max(.1, beats * (bl if bl else 60 / 144))
    put('bass', S.note('jazz_bass', M(p), d, vel=vel, release=.07), t, g, 0, label)


def whistle(t, p, dur, vel=.5, glide=None, trill=0., scoop=.8, pan=.12, g=1.0, label=None, vibd=.22):
    """a whistled note: almost-pure sine, an airy noise band around the pitch, a scoop (or a glide) into it, late vibrato"""
    d = dur + .14; tt = t_(d); m = np.full(len(tt), float(M(p)))
    if glide is not None: m += (M(glide) - M(p)) * np.clip(1 - tt / .16, 0, 1) ** 2
    else: m -= scoop * np.exp(-tt / .03)
    m += vibd * np.clip((tt - .14) / .25, 0, 1) * np.sin(2 * np.pi * 5.7 * tt)
    if trill:
        sq = np.tanh(4 * np.sin(2 * np.pi * 8.2 * tt)) * .5 + .5
        m += trill * sq * np.clip((tt - .06) / .05, 0, 1)
    f = 440 * 2 ** ((m - 69) / 12); ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + .05 * np.sin(2 * ph) + .012 * np.sin(3 * ph)
    f0 = S.hz(M(p)); air = bp(nz(d), f0 * .82, min(f0 * 1.25, 20000)) * .55 + hp(nz(d), 5000) * .025
    e = np.minimum(1, tt / .028) ** 1.5 * np.where(tt < dur, 1.0, np.exp(-(tt - dur) / .035))
    e *= 1 + .08 * np.clip(tt / max(dur, .05), 0, 1)
    x = (tone * .85 + air / max(1e-6, np.abs(air).std() * 6)) * e
    put('lead', (x * vel * .55).astype(np.float32), t, g, pan, label)


def brush_tap(t, v=.5, pan=-.12, label=None):
    d = .16; tt = t_(d); n = nz(d)
    x = bp(n, 1500, 9000) * np.exp(-tt / .045) + .5 * bp(n, 300, 1200) * np.exp(-tt / .02) + .25 * np.sin(2 * np.pi * 190 * tt) * np.exp(-tt / .03)
    put('drums', x / 3.2 * v, t, 1, pan, label)


def brush_sweep(t, d, v=.3, pan=-.18):
    tt = t_(d); n = nz(d)
    x = (bp(n, 1800, 7500) + .35 * bp(n, 500, 1800)) * np.sin(np.pi * tt / d) ** 1.5
    put('drums', x / 4 * v, t, 1, pan)


def pedal(t, v=.3): put('drums', S.hit('hihat', 'pedal', min(1, v), .3), t + .004, .45, .45)
def ride(t, v=.35, label=None): put('drums', S.hit('drum_kit', 'ride_right', v, 1.3), t, .55, .38, label)
def crash(t, v=.6, label=None): put('drums', S.hit('drum_kit', 'crash_right', v, 3.0), t, .6, .35, label)
def kick(t, v=.4): put('drums', S.hit('drum_kit', 'kick_drum_left', v, .5), t, .55, 0)


def snap(t, v=.5, pan=.55):
    d = .12; tt = t_(d)
    x = hp(nz(d), 1400) * np.exp(-tt / .010) + .55 * np.sin(2 * np.pi * 2150 * tt) * np.exp(-tt / .018) + .5 * bp(nz(d), 500, 1400) * np.exp(-tt / .006)
    put('drums', norm(x) * .4 * v, t, 1, pan)


def bongo(t, hi=True, v=.5):
    put('drums', S.hit('world_perc', 'bongo_high' if hi else 'bongo_low_high_velocity', v, .4), t, .6, -.45 if hi else -.3)


# ---------------------------------------------------------------- voicings (sounding pitch; vibraphone F3–E6)
V = {
    'Bb69': ['D4', 'G4', 'C5', 'F5'], 'Bbmaj9': ['D4', 'F4', 'A4', 'C5'], 'Gm9': ['F3', 'Bb3', 'D4', 'A4'],
    'Cm9': ['Eb4', 'G4', 'Bb4', 'D5'], 'F13': ['Eb4', 'A4', 'D5'], 'F7': ['Eb4', 'A4', 'C5'], 'Cm7': ['Eb4', 'G4', 'Bb4'],
    'Ebmaj9': ['G3', 'Bb3', 'D4', 'F4'], 'Edim7': ['E4', 'G4', 'Bb4', 'Db5'], 'Dm7': ['F4', 'A4', 'C5'], 'G7': ['F4', 'B4', 'E5'],
    'G7b9': ['F4', 'Ab4', 'B4', 'D5'], 'Bb6': ['D4', 'F4', 'G4', 'Bb4'], 'Bb7': ['D4', 'Ab4', 'C5'], 'Eb7': ['Db4', 'G4', 'C5'],
    'G7alt': ['F4', 'B4', 'Eb5', 'Ab5'], 'C69': ['E4', 'A4', 'D5', 'G5'], 'C6': ['E4', 'G4', 'A4', 'C5'], 'Fmaj7': ['E4', 'A4', 'C5', 'F5'],
}

# ================================================================ A · the kitchen prints itself (b0–b7)
whistle(T(0) + .02, 'F6', .5, .22, scoop=1.5, label=None)                       # a single tentative whistle under the pen
vib(T(0), ['D5'], 1.6, .22, pan=.1, label='pen')
plates = [('plateWall', 'Bb69', 'Bb1'), ('plateFloor', 'Gm9', 'G1'), ('plateCounter', 'Cm9', 'C2'), ('plateMachine', 'F13', 'F1')]
for k, (name, ch, root) in enumerate(plates):
    b = HIT[name]
    vib(T(b), V[ch], L(b) * 1.15, .42 + .06 * k, hard=True, label=name)
    bass(T(b), root, .9, .55 + .05 * k)
    if k >= 1: brush_tap(T(b), .45 + .1 * k)
brush_sweep(T(2), 2 * L(2), .18); brush_sweep(T(4), 2 * L(4), .24)
b = HIT['sun']                                                                    # sun rises: vibraphone glissando + glockenspiel
put('xylo', S.note('glockenspiel', M('F6'), 1.5, vel=.45), T(b), .7, .4, 'sun')
gl = ['F4', 'G4', 'Bb4', 'C5', 'D5', 'F5', 'G5', 'Bb5']
for i, p in enumerate(gl): put('vib', S.note('vibraphone_hard', M(p), .9, vel=.25 + .3 * i / 7), T(b) + i * L(b) / len(gl), .9, -.3 + .08 * i)
bass(T(6), 'D2', .9, .55); bass(T(7), 'A1', .9, .55, label='leverUp')
brush_sweep(T(6), 2 * L(6), .26); brush_tap(T(7), .6); pedal(T(7))
xy(T(7), 'F5', .45, label=None); xy(T(7.6), 'A5', .5)

# ================================================================ B · three steps (b8–b23), whistle theme, xylophone answers
BASS_B = ['Bb1', 'D2', 'Bb1', 'B1', 'C2', 'F1', 'Eb2', 'E2', 'F2', 'G1', 'F1', 'A1', 'Bb1', 'G1', 'C2', 'F1']
for i, p in enumerate(BASS_B):
    b = 8 + i
    bass(T(b), p, .92, .62 + (.08 if i in (2, 6, 10) else 0))
for b in range(8, 24, 2): brush_sweep(T(b), 2 * L(b) * 1.04, .3)
for b in range(9, 24, 2): brush_tap(T(b) + jit(3), .62); pedal(T(b), .35)
brush_tap(T(8), .7, label='lever')
COMP = {8: 'Bbmaj9', 12: 'Cm7', 13: 'F7', 15: 'Edim7', 16: 'Dm7', 17: 'G7', 19: 'F7', 20: 'Bb6', 21: 'G7', 22: 'Cm7', 23: 'F7'}
for b, ch in COMP.items():
    vib(T(b), V[ch], L(b) * 1.1, .26, pan=-.3)
    if b in (8, 16, 20): vib(T(b + .6), V[ch], L(b) * .45, .2, pan=-.3)
# one vibraphone chord per step, on the call-out beat
vib(T(HIT['pop']), V['Bb69'] + ['D6'], L(10) * 1.6, .55, hard=True, trem=.25, label='pop')
vib(T(HIT['call2']), V['Ebmaj9'] + ['C6'], L(14) * 1.6, .55, hard=True, trem=.25, label='call2')
vib(T(HIT['paper']), V['F13'] + ['G5'], L(18) * 1.6, .55, hard=True, trem=.25, label='paper')
# whistled theme (original) — (beat, pitch, beats, kw)
THEME = [
    (8.6, 'F5', .4, {}), (9, 'Bb5', .6, {}), (9.6, 'C6', .4, {}), (10, 'D6', .95, {}),
    (12, 'Eb6', .6, dict(label='knob')), (12.6, 'D6', .4, {}), (13, 'C6', .95, dict(label='pour')), (14, 'G5', .6, {}), (14.6, 'Bb5', .4, {}),
    (16, 'F5', .6, dict(label='hatch')), (16.6, 'A5', .4, {}), (17, 'C6', .95, dict(glide='F5', label='arm')), (18, 'Eb6', .95, {}),
    (20, 'D6', .6, dict(label='wide')), (20.6, 'C6', .4, {}), (21, 'Bb5', .6, dict(label='arrow23')), (21.6, 'G5', .4, {}),
    (22, 'F5', .95, {}), (23.6, 'C6', .4, {}),
]
for b, p, ln, kw in THEME:
    whistle(T(b), p, ln * L(int(b)), .5, **kw)
# xylophone answers on the medallion beats (swung eighths)
ANS = {11: ['F6', 'D6', 'Bb5'], 15: ['G6', 'Eb6', 'C6'], 19: ['C6', 'A5', 'F5']}
for k, (b, ns) in enumerate(ANS.items()):
    for j, p in enumerate(ns):
        xy(T(b + (0, .3, .6)[j]), p, .55 - .06 * j, label=('medal%d' % (k + 1)) if j == 0 else None)
# three medallions hop: xylophone Bb–D–F on b22, b22.6 (the swung off-beat = frame 6), b23
for j, (b, p) in enumerate([(22, 'Bb5'), (22.6, 'D6'), (23, 'F6')]):
    xy(T(b), p, .5 + .05 * j, label=['hop', 'hop2', 'ready'][j])

# ================================================================ C · stop (b24) then silence b25–b27
b = HIT['stop']; tS = T(b)
vib(tS, V['Bb69'], .3, .6, hard=True, label='stop')
bass(tS, 'Bb1', .5, .8); xy(tS, 'Bb6', .55); whistle(tS, 'Bb5', .2, .45, scoop=.4)
brush_tap(tS, .9); kick(tS, .45)

# ================================================================ D · accelerando (b28–b43), 144 → 240 BPM
D0 = TL['sec']['D']
PAIRS = [('Bb69', 'Bb1', 'D2', ['D5', 'F5', 'Bb5', 'D6'], 'D6', 2), ('G7b9', 'G1', 'B1', ['B4', 'D5', 'F5', 'Ab5'], 'D6', 1),
         ('Cm9', 'C2', 'Eb2', ['Eb5', 'G5', 'Bb5', 'D6'], 'Eb6', 2), ('F13', 'F1', 'A1', ['A5', 'C6', 'Eb6', 'F6'], 'F6', 2),
         ('Bb7', 'Bb1', 'D2', ['D6', 'F6', 'Ab6', 'Bb6'], 'F6', 2), ('Eb7', 'Eb2', 'G2', ['Eb6', 'G6', 'Bb6', 'Db7'], 'G6', 1),
         ('Dm7', 'D2', 'F2', ['F6', 'A6', 'C7', 'D7'], 'A6', 2), ('G7alt', 'G1', 'B1', ['G6', 'B6', 'Eb7', 'F7'], 'B6', 1)]
tD = T(HIT['ding'])
for k, (ch, r1, r2, arp, wp, tr) in enumerate(PAIRS):
    b = D0 + 2 * k; v = .5 + .025 * k
    vib(T(b), V[ch], (L(b) + L(b + 1)) * .9, .44 + .02 * k, hard=True, pan=-.3, label='ding' if k == 0 else None)
    for j in range(2):
        bb = b + j; bl = L(bb)
        bass(T(bb), [r1, r2][j], .9, .66 + .015 * k, bl=bl, label='cyc%d' % (bb - D0))
        sw = .5 + .1 * np.clip((round(bl * FPS) - 6) / 4, 0, 1)
        xy(T(bb), arp[2 * j], v, pan=.32); xy(T(bb) + sw * bl, arp[2 * j + 1], v * .85, pan=.36)
    whistle(T(b), wp, (L(b) + L(b + 1)) * .93, .5 + .02 * k, trill=tr, scoop=.5, pan=.12)
for i in range(16):
    bb = D0 + i; bl = L(bb)
    if i < 8:
        brush_tap(T(bb), .55 + .04 * i)
        if i % 2 == 0: brush_sweep(T(bb), 2 * bl, .3)
    else:
        ride(T(bb), .38 + .02 * (i - 8)); ride(T(bb) + .5 * bl, .26)
        if i % 2: brush_tap(T(bb), .85)
    if i % 2: snap(T(bb), .55 + .03 * i); pedal(T(bb), .4)
    if i >= 12:
        bongo(T(bb), True, .55); bongo(T(bb) + .5 * bl, False, .5)
kick(tD, .35)

# ================================================================ E · ornament (b44–b51), up a whole step to C
b = HIT['freeze']; tF = T(b)
vib(tF, V['C69'] + ['E5', 'C6'], 1.8, .85, hard=True, trem=.3, g=1.25, label='freeze')
bass(tF, 'C2', 2.0, .95, g=1.2); bass(tF, 'C1', 2.0, .6); crash(tF, .85); kick(tF, .7)
put('drums', S.hit('timpani', 'drum1', .7), tF, .6, 0); xy(tF, 'C7', .7, pan=.1)
whistle(tF, 'C7', L(b) * .9, .45, scoop=1.2)
gl = ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6', 'G6', 'A6', 'C7']
for i, p in enumerate(gl): xy(tF + .06 + i * (.6 * L(b) - .08) / len(gl), p, .3 + .3 * i / 10, pan=-.2 + .05 * i)   # the run clears before the fold
b = HIT['fold']                                                       # the mirror half snaps open on the swung off-beat (frame 405)
put('vib', S.note('vibraphone_hard', M('G5'), 1.1, vel=.55), T(b), .9, -.15, 'fold'); put('xylo', S.note('glockenspiel', M('G6'), 1.2, vel=.38), T(b), .6, .25)
b = HIT['petals']                                                     # six petals, six vibraphone notes
for i, p in enumerate(['G5', 'E5', 'D5', 'C5', 'A4', 'G4']):
    put('vib', S.note('vibraphone_hard', M(p), 1.2, vel=.5 - .03 * i), T(b) + i * L(b) / 6, .9, .35 - .14 * i, 'petals' if i == 0 else None)
bass(T(b), 'G1', .9, .6)
b = HIT['lock']
vib(T(b), V['Fmaj7'], 2.4, .5, hard=True, trem=.35, label='lock'); bass(T(b), 'F1', .9, .62)
put('xylo', S.note('glockenspiel', M('C7'), 2.0, vel=.4), T(b), .6, .45)
vib(T(b), ['C4', 'E4', 'A4', 'D5'], DUR - T(b), .3, bowed=True, trem=.4, g=.55, pan=.0)          # bowed vibes under the title
bass(T(HIT['ring1']), 'G1', .9, .6, label='ring1'); xy(T(HIT['ring1']), 'E6', .4, pan=-.35)
bass(T(HIT['ring2']), 'C2', .9, .62, label='ring2'); xy(T(HIT['ring2']), 'G6', .42, pan=.4)
bass(T(49), 'A1', .9, .55)
for b, p, ln in [(46, 'E6', .6), (46.6, 'D6', .4), (47, 'C6', .95), (48, 'A5', .6), (48.6, 'C6', .4), (49, 'E6', .55)]:
    whistle(T(b), p, ln * L(int(b)), .45)
for b in range(44, 51, 2): brush_sweep(T(b), 2 * L(b), .2)
for b in (45, 47, 49): brush_tap(T(b), .45)
# the button: two notes, G on the swung off-beat, C on b50
xy(T(49.6), 'G5', .5); bass(T(49.6), 'G1', .4, .62)
b = HIT['button']
xy(T(b), 'C6', .6, label='button'); xy(T(b), 'C7', .4, pan=-.2); bass(T(b), 'C2', 1.4, .8)
vib(T(b), V['C69'], 1.2, .32, pan=.1)

# ================================================================ foley (from window.EV, by material)
def stamp_s(p=1.0):                 # rubber stamp: thick, damped thud + paper smack
    d = .3; tt = t_(d)
    return norm(sine(140 * p * (1 - .4 * tt), d) * env_exp(d, .035) + lp(nz(d), 1800) * env_exp(d, .012) * .9 + bp(nz(d), 2000, 6000) * env_exp(d, .006) * .35)
def pen_s(d):
    x = bp(nz(d), 2200, 7000) * (0.45 + .55 * np.abs(np.sin(2 * np.pi * 9 * t_(d) + 3 * np.sin(2 * np.pi * 1.3 * t_(d)))))
    return norm(x) * np.sin(np.pi * t_(d) / d) ** .5
def tick_s(hi):
    d = .06; tt = t_(d); f = 2400 if hi else 1900
    return norm(hp(nz(d), 2500) * env_exp(d, .003) + sine(f, d) * env_exp(d, .01) * .6)
def plastic(p=1.0, d=.18):
    return norm(hp(nz(d), 1500) * env_exp(d, .003) + sine(620 * p, d) * env_exp(d, .025) * .6 + sine(1340 * p, d) * env_exp(d, .015) * .3)
def metal_clack(p=1.0):
    d = .25; return norm(mixn(clack(1.2 * p, 1)[:int(.12 * SR)], sine(1850 * p, d) * env_exp(d, .05) * .35, sine(3120 * p, d) * env_exp(d, .03) * .2))
def spring(d=.55, f=210, depth=.35, v=1.0):   # a metal spring "boing": wobbling pitch, bright partials
    tt = t_(d); fm = f * (1 + depth * np.exp(-tt / .12) * np.sin(2 * np.pi * 17 * tt)) * (1 + .5 * np.exp(-tt / .02))
    x = sine(fm, d) + .4 * sine(fm * 2.76, d) * env_exp(d, .08) + .2 * sine(fm * 5.4, d) * env_exp(d, .03)
    return norm(x * env_ad(d, .002, d * .35)) * v
def swish(d=.3, lo=1600, hi=8000):
    tt = t_(d); return norm(bp(nz(d), lo, hi)) * np.sin(np.pi * tt / d) ** 2
def iris():                         # call-out opening "shhk": a rising filtered noise
    d = .22; tt = t_(d); x = nz(d); y = np.zeros_like(x)
    for k, (a, b2) in enumerate([(1200, 2600), (2600, 5200), (4500, 9000)]):
        seg_ = slice(int(k * len(x) / 3), int((k + 1) * len(x) / 3)); y[seg_] = bp(x, a, b2)[seg_]
    return norm(y * np.sin(np.pi * tt / d) ** 1.2)
def softpop(p=1.0):
    d = .14; tt = t_(d); f = (380 + 1300 * tt / d) * p
    return norm(sine(f, d) * env_exp(d, .04) + bp(nz(d), 800, 3000) * env_exp(d, .005) * .3)
def ceramic(p=1.0, v=1.0):
    d = 1.0; return norm(sum(a * sine(f * p, d) * env_exp(d, tau) for f, a, tau in [(2210, 1, .28), (3480, .6, .16), (5970, .35, .08), (8100, .15, .04)]) + hp(nz(d), 4000) * env_exp(d, .003) * .5) * v
def toast_land():
    d = .25; return norm(mixn(lp(nz(d), 900) * env_exp(d, .025), sine(160, d) * env_exp(d, .03) * .7, ceramic(1.3, .12)[:int(d * SR)]))
def ratchet(d, n0=10, n1=26, up=True, p=1.0):
    tt = t_(d); out = np.zeros(len(tt)); k = 0; tc = 0.0
    while tc < d - .02:
        c = norm(hp(nz(.02), 2500) * env_exp(.02, .002) + sine(2900 * p * (1 + .1 * k % 3), .02) * env_exp(.02, .004) * .5)
        s = int(tc * SR); out[s:s + len(c)] += c[:len(out) - s] * (.6 + .4 * rng.random())
        rate = n0 + (n1 - n0) * (tc / d if up else 1 - tc / d); tc += 1 / rate; k += 1
    return norm(out)
def slide_whistle(d=.4, f0=650, f1=1500):
    tt = t_(d); f = np.geomspace(f0, f1, len(tt)) * (1 + .012 * np.sin(2 * np.pi * 6 * tt))
    return norm(sine(f, d) + .12 * bp(nz(d), 900, 3200)) * np.sin(np.pi * tt / d) ** .6
def gurgle(d, v=1.0):               # pouring coffee: bubbles (short rising sines) over a liquid noise bed
    tt = t_(d); bed = bp(nz(d), 250, 1400) * (0.6 + .4 * np.abs(np.sin(2 * np.pi * 7 * tt)))
    out = bed * .35
    nb = int(d * 38)
    for k in range(nb):
        t0 = rng.uniform(0, max(.01, d - .05)); f = rng.uniform(380, 900); bd = .03
        b_ = sine(f * (1 + 2.2 * t_(bd) / bd), bd) * env_ad(bd, .002, .012)
        s = int(t0 * SR); out[s:s + len(b_)] += b_[:len(out) - s] * rng.uniform(.3, .9)
    e = np.minimum(1, tt / .04) * np.minimum(1, (d - tt) / .08)
    return norm(out * e) * v
def paper_slap():
    d = .2; return norm(mixn(bp(nz(d), 1000, 6000) * env_exp(d, .018), lp(nz(d), 500) * env_exp(d, .02) * .7, sine(120, d) * env_exp(d, .02) * .4))
def door_snap():
    d = .2; return norm(mixn(clack(.9, 1)[:int(d * SR)], plastic(.7, d) * .6))
def jam():                           # machines lock: a heavy metal clunk + a spring cut short
    d = .5; x = norm(mixn(thump(1, 75)[:int(d * SR)], metal_clack(.7) * .8, spring(.18, 160, .5) * .5)); return x
def bell(v=1.0):                     # the toaster's bell: struck bell partials (sfx.ding) + a brighter strike
    a = sding(1.0); b2 = ceramic(1.6, .5)
    d = 1.8; tt = t_(d); f = 1396.9                     # F6
    c = sum(a2 * sine(f * r, d) * env_exp(d, tau) for r, a2, tau in [(1, 1, .9), (2.0, .45, .5), (2.76, .3, .35), (5.4, .15, .12)])
    return norm(mixn(norm(c), a * .55, b2 * .35, hp(nz(.02), 3000) * env_exp(.02, .003) * .5)) * v
def riffle(d, n=6):
    out = np.zeros(len(t_(d)) + int(.2 * SR))
    for k in range(n):
        c = swish(.09, 2500, 9000) * .8
        s = int(k * d / n * SR); out[s:s + len(c)] += c
    return norm(out)
def crinkle(d):
    tt = t_(d); x = hp(nz(d), 2000) * (rng.random(len(tt)) > .985) * 4
    return norm(lp(x, 9000) + bp(nz(d), 2000, 6000) * .2) * np.sin(np.pi * tt / d) ** .5
def hum(d, f0, f1):
    tt = t_(d); f = np.linspace(f0, f1, len(tt))
    x = sine(f, d) + .5 * sine(2 * f, d) + .25 * sine(3 * f, d) + .1 * bp(nz(d), 200, 900)
    return norm(x) * np.minimum(1, tt / .03) * np.minimum(1, (d - tt) / .05)

FO = 'foley'
for e in EVJ['ev']:
    t, ty = e['t'], e['type']
    if ty == 'pen': put(FO, pen_s(e['dur'] + .15), t, .32, -.1)
    elif ty == 'stamp': put(FO, stamp_s(1 + .08 * e['i']), t, .55, (-.3, .25, -.1, .3)[e['i']])
    elif ty == 'sun': put(FO, slide_whistle(.4, 900, 1800), t, .12, .3)
    elif ty == 'tick': put('amb', tick_s(e['b'] % 2 == 0), t, .07, -.45)
    elif ty == 'lever_up': put(FO, creak(1)[:int(.3 * SR)] * .5, t, .16, -.4)
    elif ty == 'lever': put(FO, metal_clack(1.0), t, .42, -.4)
    elif ty == 'heat': put(FO, hum(e['dur'], 118, 124) * .5 + bp(nz(e['dur']), 3000, 8000)[:len(t_(e['dur']))] * .03, t, .1, -.4)
    elif ty == 'pop': put(FO, spring(.6, 230, .4), t, .45, -.35); put(FO, swish(.25, 900, 4000), t, .2, -.35)
    elif ty == 'callout': put(FO, iris(), t, .22, 0)
    elif ty == 'tagpop': put(FO, softpop(1.1), t + .04, .16, .2)
    elif ty == 'land': put(FO, toast_land(), t, .35, -.25)
    elif ty == 'medal': put(FO, stamp_s(.85), t, .5, (-.35, 0, .35)[e['n'] - 1])
    elif ty == 'knob': put(FO, ratchet(.16, 30, 30, p=.8), t, .3, 0)
    elif ty == 'pour': put(FO, gurgle(e['dur'] + .1), t, .3, .05)
    elif ty == 'clink': put(FO, ceramic(1.0, 1.0), t, .3, .05)
    elif ty == 'hatch': put(FO, door_snap(), t, .38, .45)
    elif ty == 'arm': put(FO, ratchet(e['dur'], 12, 34), t, .3, .4); put(FO, slide_whistle(e['dur'] * .95), t, .16, .4)
    elif ty == 'paper': put(FO, paper_slap(), t, .45, .35)
    elif ty == 'retract': put(FO, ratchet(.3, 34, 14, up=False), t, .22, .45); put(FO, slide_whistle(.32, 1500, 700), t + .02, .12, .45)
    elif ty == 'swish': put(FO, swish(.35), t, .22, 0)
    elif ty == 'arrow': put(FO, pen_s(.32), t, .2, .1)
    elif ty == 'hop': put(FO, softpop(1.0 + .25 * e['n']), t, .14, (-.35, 0, .35)[e['n'] - 1])
    elif ty == 'stop': put(FO, jam(), t, .5, 0)
    elif ty == 'ding': put(FO, bell(), t, .62, -.3)
    elif ty == 'cyc':
        d = e['dur']; g = .5 + .03 * e['i']
        put(FO, spring(.3, 230 + 12 * e['i'], .35), t, .2 * g, -.35)
        put(FO, gurgle(max(.12, d * .8), 1), t, .14 * g, .05)
        put(FO, ratchet(d * .45, 28, 40), t, .14 * g, .4)
        put(FO, paper_slap(), t + .45 * d, .22 * g, .38)
    elif ty == 'freeze': put(FO, stamp_s(.7), t, .7, 0)
    elif ty == 'wipe': put(FO, swish(e['dur'] + .15, 900, 6000), t, .32, 0)
    elif ty == 'fold': put(FO, paper_slap(), t, .34, .1); put(FO, crinkle(e['dur'] + .1), t, .14, 0)
    elif ty == 'fan': put(FO, riffle(e['dur'], 6), t, .24, 0)
    elif ty == 'lock': put(FO, stamp_s(.8), t, .6, 0)
    elif ty == 'ring': put(FO, swish(.45, 700, 4500), t, .16, (-.3, .3)[e['n'] - 1])
    elif ty == 'button': put(FO, stamp_s(1.1), t, .3, 0)

# ---------------------------------------------------------------- ambience: room tone, the motor during the race
tone = lp(brown(DUR), 380); tone = (tone / np.abs(tone).max()).astype(np.float32)
tone2 = lp(brown(DUR), 380); tone2 = (tone2 / np.abs(tone2).max()).astype(np.float32)
put('amb', tone, 0, .045, -.5); put('amb', tone2, 0, .045, .5)
tD0, tE0 = T(HIT['ding']), T(HIT['freeze'])
put('amb', hum(tE0 - tD0, 62, 104) * np.linspace(.5, 1, len(t_(tE0 - tD0))), tD0, .09, .2)

# ================================================================ bus, silence gate, master
music = st['drums'] * .85 + st['bass'] * 1.05 + st['vib'] * .8 + st['xylo'] * .7 + st['lead'] * .85
music = S.room(music, size=.32, mix=.16)
fol = S.room(st['foley'], size=.18, mix=.08)
mix = music + fol * 1.0 + st['amb']
# the stop: everything (room tone too) cut from b25 to the bell on b28
g = np.ones(N, np.float32); a, b2 = int(round(T(25) * SR)), int(round(T(28) * SR))
fade = int(.07 * SR); g[a:a + fade] = np.linspace(1, 0, fade) ** 2; g[a + fade:b2] = 0
mix *= g[:, None]
for k in st: st[k] *= g[:, None]
# low-end check before mastering
def band_db(x, lo, hi):
    X = np.abs(np.fft.rfft(x.mean(1))) ** 2; f = np.fft.rfftfreq(len(x), 1 / SR)
    return 10 * np.log10(X[(f >= lo) & (f < hi)].sum() + 1e-12)
lo_rel = band_db(mix, 20, 120) - band_db(mix, 120, 8000)
if lo_rel > -3:
    from scipy.signal import butter, sosfilt
    sos = butter(2, 120, 'low', fs=SR, output='sos'); low = sosfilt(sos, mix, axis=0)
    k = 10 ** ((-3 - lo_rel) / 20); mix = mix + low * (k - 1)
pk = np.abs(mix).max(); mix = mix / pk * .89
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1).astype(np.float32)
sf.write(os.path.join(OUT, 'mix.wav'), mix, SR, subtype='FLOAT')
sf.write(os.path.join(OUT, 'music.wav'), (music * g[:, None] / pk * .89).astype(np.float32), SR, subtype='FLOAT')
os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
for k in st: sf.write(os.path.join(OUT, 'stems', k + '.wav'), st[k], SR, subtype='FLOAT')
json.dump(dict(hits=HITS, sil=[T(25), T(28)]), open(os.path.join(OUT, 'music_hits.json'), 'w'), indent=1)
print('mix.wav %.3f s · low band %.1f dB rel · %d cue marks' % (len(mix) / SR, band_db(mix, 20, 120) - band_db(mix, 120, 8000), len(HITS)))
