"""Score, foley and mix for 悬索桥为何不倒 → out/mix.wav (48 kHz stereo) + audio/stems/ + audio/score.json.
Reads the same numbers as the picture: audio/timeline.json (BPM grid, hits) and events.json (window.EV).
Run:  $LIB/.venv/bin/python audio/mix.py

Score (original): 96 BPM, A minor → A major at the verdict. A struck synth bass with a piano-like hammer
(numpy, 2nd/3rd harmonics so it speaks on small speakers) doubled by a sampled jazz double bass; a light kit
(snare taps, closed hats), wood (woodblock, claves, log drum), marimba / xylophone, low brass stabs
(trombone, tuba, horn) and synthesised struck steel. No piano, no string pad.
Arc: wall (groove) → span (walking bass climbs a step per beat) → loads (bass pedal in eighths, the magnets
climb the scale, quarter → eighth → sixteenth) → a choked hit, then silence → the verdict (A major, brass,
timpani, steel) → half time → the wall (F → D → A, slowing).
"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); FILM = os.path.dirname(HERE)
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, noise, bp, lp, hp, t_, env_exp, norm, whoosh, brown

S.seed(56); rng = np.random.default_rng(56)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(FILM, 'events.json')))['ev']
BEAT, OFF, DUR = TL['BEAT'], TL['OFF'], TL['DUR']
b = lambda k: OFF + k * BEAT
N = int((DUR + 1.5) * SR)
SIL = (b(21) + .32, b(23))                 # the silence: only the room
music = np.zeros((N, 2), np.float32); fx = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32)
score = []                                  # every musical onset, for the cue check

# ================================================================= instruments
def synth_bass(m, d, v=.8):
    """struck bass: inharmonic partials decaying faster as they go up (a piano-like hammer), plus a felt thump"""
    f0 = 440 * 2 ** ((m - 69) / 12); n = int((d + .35) * SR); tt = np.arange(n) / SR; x = np.zeros(n)
    for h in range(1, 10):
        fh = f0 * h * np.sqrt(1 + .00035 * h * h)
        if fh > 5000: break
        a = (1 / h ** 1.15) * (1.35 if h in (2, 3) else 1) * (.5 + .5 * v)
        x += a * np.sin(2 * np.pi * fh * tt + h) * np.exp(-tt / (1.4 / (1 + .55 * h)))
    x += lp(noise(n / SR), 900) * np.exp(-tt / .012) * .25 * v
    rel = np.clip((d + .35 - tt) / .35, 0, 1) ** 2
    return (norm(x * rel) * v).astype(np.float32)

def steel(f0=420, d=2.2, v=1.0, bright=1.0):
    """struck steel (a beam, a cable band): inharmonic free-bar modes"""
    n = int(d * SR); tt = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * f0 * r * tt + r) * np.exp(-tt / (tau / (1 + .3 * i)))
            for i, (r, a, tau) in enumerate([(1, 1, .9), (2.756, .7 * bright, .55), (5.404, .5 * bright, .3), (8.933, .3 * bright, .18), (13.34, .15 * bright, .1)]))
    x += hp(noise(d), 2500) * np.exp(-tt / .004) * .6
    return (norm(x) * v).astype(np.float32)

notes = []
def note(t, inst, p, d, v, pan=0.0, **k):
    if SIL[0] <= t < SIL[1] or t >= DUR: return
    if t < SIL[0] < t + d: d = max(.05, SIL[0] - t - .02)
    notes.append(dict(t=t, inst=inst, pitch=p, dur=d, vel=v, pan=pan, **k)); score.append((round(t, 4), inst))
def hit(t, inst, var, v, gain=1.0, pan=0.0):
    if SIL[0] <= t < SIL[1] or t >= DUR: return
    add(music, S.hit(inst, var, v), t, gain, pan); score.append((round(t, 4), inst))
def bass(t, p, d, v=.75):
    m = S.midi(p) if isinstance(p, str) else p
    if SIL[0] <= t < SIL[1]: return
    add(music, synth_bass(m, d, v), t, .33, -.05); note(t, 'jazz_bass', m, d, v * .68, .05)
def metal(t, f0, v=.8, d=2.0, pan=0.0, bright=1.0):
    if SIL[0] <= t < SIL[1]: return
    add(music, steel(f0, d, 1.0, bright), t, .22 * v, pan); score.append((round(t, 4), 'steel'))

# ================================================================= A · the wall (b0–b6): Am | F
FIG = [(0, 0, .45), (1, 0, .2), (1.5, 7, .2), (2, 12, .3), (3, 10, .2), (3.5, 7, .2)]   # beat, semitones, length
for k0, root in ((0, 'A1'), (4, 'F1')):
    for db, iv, ln in FIG: bass(b(k0 + db), S.midi(root) + iv, ln, .78 if db == 0 else .6)
for k in range(0, 6):                                           # kick on 1 and the "and" of 2, snare taps on 2 and 4
    for s in range(4):
        t = b(k + s / 4)
        if s == 0 and k % 2 == 0: hit(t, 'bass_drum', None, .6, .7)
        if s == 2 and k % 4 == 1: hit(t, 'bass_drum', None, .45, .55)
        if s == 0 and k % 2 == 1: hit(t, 'snare2', 'taps', .45, .5, -.1)
        if s % 2 == 0 and k >= 2: hit(t, 'hihat', 'closed', .3 if s == 0 else .2, .35, .35)
for k in (0.5, 1.75, 2.5, 3.75, 4.5, 5.75): hit(b(k), 'woodblock', 'b', .45, .35, -.35)
metal(b(0), 220, .9, 2.4, -.1)                                  # the hook: steel + bass + kick on the first landing
for k, p in ((5, 'E5'), (5.5, 'A5')): note(b(k), 'marimba', p, .5, .5, .25)
# J-cut: the cable's steel arrives before its photo (a soft, swelling ring from b4.5)
sw = steel(660, 1.4, 1.0, .6)[::-1].copy(); sw *= np.linspace(0, 1, len(sw)) ** 2
add(music, sw[-int(BEAT * SR):], b(5) - BEAT, .1, .3)

# ================================================================= B · the span (b6–b14): the bass walks up a step per beat
WALK = ['A1', 'B1', 'C2', 'D2', 'E2', 'F2', 'G2', 'G#2']
for i, p in enumerate(WALK):
    k = 6 + i; bass(b(k), p, .5, .62 + .03 * i); bass(b(k + .5), S.midi(p) + 12, .2, .45)
for k in range(6, 12):
    for s in (0, .5): hit(b(k + s), 'hihat', 'closed', .28 if s == 0 else .2, .35, .35)
    if k % 2 == 1: hit(b(k), 'snare2', 'taps', .42, .45, -.1)
    if k % 2 == 0: hit(b(k), 'bass_drum', None, .5, .6)
ARP = ['A4', 'C5', 'E5', 'A5']
for i in range(16):                                             # marimba eighths, the arpeggio climbs with the line
    k = 7 + i * .5; p = S.midi(ARP[i % 4]) + (2 if i >= 8 else 0); note(b(k), 'marimba', p, .3, .38 + .015 * i, .25 - .03 * (i % 4))
hit(b(11), 'claves', None, .5, .4, .3); hit(b(11.5), 'claves', None, .55, .4, .3)
# arrival: the arrowhead lands on A, an octave up
bass(b(12), 'A2', 1.0, .85); bass(b(12), 'A1', 1.0, .7); hit(b(12), 'bass_drum', None, .7, .75)
metal(b(12), 330, .8, 2.0, .2)
for j, p in enumerate(['A4', 'C5', 'E5']): note(b(12) + j * .012, 'marimba', p, 1.2, .55, -.2 + .2 * j)
note(b(12.5), 'xylophone', 'E6', .3, .4, .3); note(b(13), 'marimba', 'G5', .3, .4, .2); note(b(13.5), 'marimba', 'E5', .3, .38, .1)
for k in (12, 12.5, 13, 13.5): hit(b(k), 'hihat', 'closed', .2, .3, .35)

# ================================================================= C · the loads (b14–b21): pedal A in eighths, magnets climb the scale
LOADS = TL['HIT']['loads']
SCALE = ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6']
for i, k in enumerate(LOADS): note(b(k), 'xylophone', SCALE[i], .35, .42 + .03 * i, -.4 + .08 * i)
k = 14.0
while k < 19.0 - 1e-9:
    on = abs(k - round(k)) < 1e-6
    bass(b(k), 'A1' if k < 17 else 'A1', .22 if not on else .3, .7 if on else .5)
    hit(b(k), 'hihat', 'closed', .3 if on else .2, .35, .35)
    if on and int(round(k)) % 2 == 0: hit(b(k), 'bass_drum', None, .6, .7)
    k += .5
for i in range(16): hit(b(18) + i * BEAT / 16, 'snare2', 'on', .2 + .035 * i, .38, -.1)   # snare build into the flow
hit(b(18), 'log_drum', 'lo', .55, .5, -.3); hit(b(18.5), 'log_drum', 'hi', .55, .5, .3)
# the flow: low brass stab on D minor (iv), steel on the tops (E, V), a choked tutti at the base
def stab(t, ch, root, v=.7):
    for j, p in enumerate(ch): note(t + j * .006, 'trombone_stac', p, .32, v, -.3 + .3 * j)
    note(t, 'tuba_stac', root, .38, v)
stab(b(19), ['D3', 'F3', 'A3'], 'D2', .72); bass(b(19), 'D2', .55, .8); hit(b(19), 'bass_drum', None, .7, .75)
for i in range(4): note(b(19) + i * BEAT / 4 * 2, 'marimba', ['D5', 'F5', 'A5', 'D6'][i], .25, .45, .2)
stab(b(20), ['E3', 'G#3', 'B3'], 'E2', .78); bass(b(20), 'E2', .55, .85); metal(b(20), 247, .9, 1.6, 0)
hit(b(20.5), 'snare2', 'on', .6, .5); hit(b(20.75), 'snare2', 'on', .7, .55)
# b21: choked hit (base of the towers), then nothing
stab(b(21), ['A2', 'E3', 'A3'], 'A1', .85); hit(b(21), 'timpani', 'drum2', .8, .8); hit(b(21), 'bass_drum', None, .85, .9)
bass(b(21), 'A1', .28, .9)

# ================================================================= E · the verdict (b23): the first sound after the silence
V = b(23)
for j, p in enumerate(['A2', 'E3', 'A3', 'C#4']): note(V + j * .004, 'trombone', p, 1.3, .8, -.35 + .23 * j)
note(V, 'tuba', 'A1', 1.5, .85); note(V + .01, 'horn', 'E4', 1.25, .6, .2); note(V + .015, 'horn', 'A4', 1.25, .55, -.2)
hit(V, 'timpani', 'drum2', 1.0, 1.0); hit(V, 'gran_cassa', 'hit', .9, .9); hit(V, 'sus_cymbal', 'hit', .55, .35, .2)
bass(V, 'A1', 1.4, 1.0); metal(V, 220, 1.2, 3.2, -.2); metal(V + .003, 293.7, 1.0, 3.0, .25)
# half time: accents only every two beats, the harmony walks F → D → A while the wall is revealed
note(b(25), 'trombone', 'F2', 1.25, .5, -.2); note(b(25), 'trombone', 'C3', 1.25, .45, .2); bass(b(25), 'F1', 1.2, .7)
for i, p in enumerate(['A4', 'C5', 'F5']): note(b(25) + i * BEAT / 2, 'marimba', p, .5, .4, .2 - .2 * i)
note(b(26.5), 'horn', 'C#5', .55, .45, .1); note(b(27), 'horn', 'D5', .8, .45, .1)         # the key word, red, on the horn
note(b(27), 'trombone', 'D3', 1.25, .5, -.2); note(b(27), 'trombone', 'F#3', 1.25, .45, .2); bass(b(27), 'D2', 1.2, .7)
hit(b(27), 'bass_drum', None, .5, .55); hit(b(25), 'bass_drum', None, .45, .5)
for i, p in enumerate(['F#4', 'A4', 'D5']): note(b(27) + i * BEAT / 2, 'marimba', p, .5, .38, -.2 + .2 * i)
S_ = b(28.5)                                                    # the wall settles: A major, long
for j, p in enumerate(['A2', 'E3', 'A3', 'C#4']): note(S_ + j * .01, 'trombone', p, 2.8, .55, -.35 + .23 * j)
note(S_, 'tuba', 'A1', 3.0, .55); note(S_ + .02, 'horn', 'E4', 2.6, .45, .25, attack=.15); note(S_, 'contrabass', 'A1', 3.0, .4, 0, attack=.1)
bass(S_, 'A1', 2.5, .75); hit(S_, 'timpani', 'drum2', .6, .7); metal(S_, 440, .7, 3.0, .3, .7)
for i, p in enumerate(['A4', 'C#5', 'E5', 'A5', 'C#6']): note(S_ + .2 + i * BEAT / 2, 'marimba', p, .9, .32 - .02 * i, (-.3, .3)[i % 2])
hit(b(24) + .0, 'woodblock', 'c', .35, .3, .4)

mus = S.render([dict(t=e['t'], inst=e['inst'], pitch=e['pitch'], dur=e['dur'], vel=e['vel'], pan=e['pan'], **({'attack': e['attack']} if 'attack' in e else {})) for e in notes], dur=N / SR, master=False)
music[:len(mus)] += mus[:N]
music = S.room(music, size=.32, mix=.13)
i0, i1, f = int(SIL[0] * SR), int(SIL[1] * SR), int(.05 * SR)
music[i0:i1] = 0; music[i0 - f:i0] *= np.linspace(1, 0, f)[:, None]

# ================================================================= foley (procedural, on the picture's events)
def squeak(d, seed=0, v=1.0, rate=4):
    r = np.random.default_rng(abs(int(seed))); n = int(d * SR); tt = np.arange(n) / SR
    x = bp(r.standard_normal(n), 1700, 6200) * (.55 + .45 * np.sin(2 * np.pi * (6 + r.random() * 5) * tt)) * .3
    for _ in range(int(d * rate) + 1):
        st = r.uniform(0, max(.01, d - .08)); ln = r.uniform(.04, .14); m = int(ln * SR); s0 = int(st * SR)
        f0 = r.uniform(1800, 3300); fq = f0 * (1 + .16 * np.sin(np.linspace(0, np.pi * r.uniform(1, 3), m)))
        ph = 2 * np.pi * np.cumsum(fq) / SR
        sq = (np.sin(ph) + .35 * np.sin(2 * ph) + .12 * np.sin(3 * ph)) * np.sin(np.linspace(0, np.pi, m)) ** 1.5
        x[s0:s0 + m] += sq[:max(0, min(m, n - s0))] * r.uniform(.2, .55)
    fade = np.minimum(1, np.minimum(tt / .012, (d - tt) / .03))
    return (x * fade * v).astype(np.float32)
def nib(v=1.0, f=1.0):
    d = .07; tt = t_(d)
    return (norm(hp(noise(d), 2500) * env_exp(d, .002) + np.sin(2 * np.pi * 950 * f * tt) * env_exp(d, .008) * .6 + np.sin(2 * np.pi * 190 * tt) * env_exp(d, .02) * .45) * v).astype(np.float32)
def magnet(v=1.0, pitch=1.0, heavy=0.0):
    d = .2 + .25 * heavy; tt = t_(d)
    tr = hp(noise(d), 3000) * env_exp(d, .0012)
    ring = sum(a * np.sin(2 * np.pi * f * pitch * tt) * env_exp(d, tau) for f, a, tau in [(3300, .35, .006), (1780, .32, .011), (960, .2, .02)])
    body = np.sin(2 * np.pi * (200 - 110 * heavy) * pitch * tt * (1 - .2 * tt)) * env_exp(d, .025 + .06 * heavy) * (.45 + .7 * heavy)
    return (norm(tr + ring + body) * v).astype(np.float32)
def landing(v=1.0, metal_=0):
    d = .8; tt = t_(d)
    low = np.sin(2 * np.pi * 62 * tt * (1 - .25 * tt)) * env_exp(d, .09)
    board = bp(noise(d), 160, 520) * env_exp(d, .06) * .8
    slap = hp(noise(d), 1200) * env_exp(d, .007) * .6
    x = low * 1.1 + board + slap
    if metal_: x += steel(880, d, .5, .8)[:len(tt)] * .5
    return (norm(x) * v).astype(np.float32)
def felt(d):
    n = len(t_(d)); tt = np.arange(n) / SR
    x = bp(rng.standard_normal(n), 350, 2600) * (.6 + .4 * np.sin(2 * np.pi * 11 * tt)) + bp(rng.standard_normal(n), 120, 400) * .4
    return (x * np.sin(np.pi * np.clip(tt / d, 0, 1)) ** .6 * .7).astype(np.float32)
def suction_pop(v=1.0, pitch=1.0):
    d = .13; tt = t_(d); fq = (320 + 950 * tt / d) * pitch
    x = np.sin(2 * np.pi * np.cumsum(fq) / SR) * env_exp(d, .03) * .7 + hp(noise(d), 4000) * env_exp(d, .003) * .5
    return (norm(x) * v).astype(np.float32)
def room_tone(d):
    n = len(t_(d)); tt = np.arange(n) / SR
    hvac = bp(rng.standard_normal(n), 140, 1400) * .45 + lp(brown(d), 260) * .35 + (np.sin(2 * np.pi * 120 * tt) + .35 * np.sin(2 * np.pi * 240 * tt)) * .05
    traffic = lp(brown(d), 240) * .4; r = np.random.default_rng(7); t = 1.5
    while t < d - 2:
        ln = r.uniform(2.4, 3.6); m = int(ln * SR); s0 = int(t * SR)
        sw = bp(r.standard_normal(m), r.uniform(170, 260), r.uniform(1100, 2000)) * np.sin(np.linspace(0, np.pi, m)) ** 2 * r.uniform(.5, 1.0)
        traffic[s0:s0 + m] += sw[:max(0, min(m, n - s0))]; t += r.uniform(3.5, 6.0)
    return hvac.astype(np.float32), traffic.astype(np.float32)

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'land': add(fx, landing(e.get('w', 1), e.get('metal', 0)), t - .008, .7 * e.get('w', 1))
    elif ty == 'pin': add(fx, magnet(.9, 1.0 + .05 * e['i']), t, .4, (-.3, .3)[e['i'] % 2])
    elif ty == 'write': add(fx, squeak(e['d'], int(t * 100) + 3, 1.0, 9 if e.get('big') else 7), t, .26 if e.get('big') else .2, .05)
    elif ty == 'tap':
        if 'tick' in e: add(fx, nib(1.0, 1.0 + .06 * e['tick']), t, .34, -.3 + .15 * e['tick'])   # the ticks of the ride: a nib tap, a step higher each beat
        else: add(fx, nib(.9 if e.get('soft') else 1.0), t, .3, .1)
    elif ty == 'draw':   # the long dimension line, stepped: one short stroke per step, ending on the beat
        d = e['d']; n = e.get('steps', 1); r = e.get('rest', 0) if n > 1 else 0; sd = d / n
        for k in range(n):
            md = sd * (1 - r); x = squeak(md, 11 + k, 1.0, 3); tt = np.arange(len(x)) / SR; x *= (.35 + .65 * np.sin(np.pi * tt / md))
            add(fx, x, t + k * sd + r * sd, .24, -.3 + .15 * k)
    elif ty == 'arrow': add(fx, nib(1.0, .8), t, .4, .1); add(fx, steel(1046, 1.0, 1.0, .5), t, .05 if e.get('ring') else .03, .2)
    elif ty == 'load':
        i = e['i']; add(fx, magnet(1.0, .92 + .045 * i), t, .45, -.45 + .1 * i)
        add(fx, squeak(.16, 50 + i, .8, 10), t + .05, .1, -.45 + .1 * i)                 # the hanger line drawn up to the cable
    elif ty == 'flow': add(fx, whoosh(e['d'] + .1, 1.0), t - .05, .2); add(fx, squeak(e['d'], 77, 1.0, 5), t, .16)
    elif ty == 'down': add(fx, squeak(e['d'], 78, 1.0, 4), t, .16)
    elif ty == 'base': add(fx, landing(1.0), t, .55)
    elif ty == 'verdict':
        add(fx, magnet(1.0, .8, 1.0), t, .75, -.45); add(fx, magnet(1.0, .84, 1.0), t + .004, .75, .45)
    elif ty == 'erase': add(fx, felt(e['d']), t, .4, .0)
    elif ty == 'pop': add(fx, suction_pop(.9, .95 + (e['x'] - 1500) / 6000), t, .22, -.45 + (e['x'] - 1500) / 3300)
fx[i0:i1] = 0; fx[i0 - f:i0] *= np.linspace(1, 0, f)[:, None]

# ================================================================= balance and master
def rms(x): m = np.abs(x).max(1) > 1e-5; return float(np.sqrt(np.mean(x[m] ** 2) + 1e-12))
music = hp(music.T, 42).T.astype(np.float32)
fx = hp(fx.T, 45).T.astype(np.float32)
fx *= rms(music) / rms(fx) * 10 ** (-2.0 / 20)                   # foley about 2 dB under the music by RMS: hits read clearly
hv_, tr_ = room_tone(DUR + 1.0); room = np.zeros_like(amb); add(room, hv_, 0, 1.0, .3); add(room, tr_, 0, 1.0, -.45)
room *= rms(music) * 10 ** (-27 / 20) / rms(room); amb += room   # the room: audible in the silence, never ducked
mix = music + fx + amb
from scipy.ndimage import maximum_filter1d, uniform_filter1d
def bus_limit(x, ceil, look=.006, rel=.06):
    n = int(look * SR); pk = np.abs(x).max(1); m = maximum_filter1d(pk, size=2 * n + 1); g = np.minimum(1, ceil / np.maximum(m, 1e-9))
    g = uniform_filter1d(g, size=n); g = np.minimum(g, uniform_filter1d(g, size=int(rel * SR))); return x * g[:, None]
mix = bus_limit(mix, rms(mix) * 3.4); mix = bus_limit(mix, rms(mix) * 3.6, look=.003); mix = mix / np.abs(mix).max() * .7
end = int(DUR * SR); fo = int(.9 * SR); mix[end - fo:end] *= np.linspace(1, 0, fo)[:, None] ** 1.3
os.makedirs(os.path.join(FILM, 'out'), exist_ok=True); os.makedirs(os.path.join(HERE, 'stems'), exist_ok=True)
sf.write(os.path.join(FILM, 'out/mix.wav'), mix[:end], SR)
for nm, s_ in (('music', music), ('fx', fx), ('amb', amb)): sf.write(os.path.join(HERE, 'stems', nm + '.wav'), s_[:end], SR)
json.dump(sorted(set(score)), open(os.path.join(HERE, 'score.json'), 'w'))
# low-end report: 20–120 Hz vs 120 Hz–2 kHz band energy
spec = np.abs(np.fft.rfft(mix[:end].mean(1))) ** 2; fr = np.fft.rfftfreq(end, 1 / SR)
lo = spec[(fr >= 20) & (fr < 120)].sum(); mid = spec[(fr >= 120) & (fr < 2000)].sum()
print('out/mix.wav', round(DUR, 3), 's ·', len(notes), 'sampled notes ·', len(score), 'onsets · low/mid', round(10 * np.log10(lo / mid), 1), 'dB')
