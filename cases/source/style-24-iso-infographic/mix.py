"""一封信的旅程 — original score + foley + ambience → out/mix.wav (48 kHz stereo).
Reads events.json (exported from timeline.js by core/render/events.mjs). Writes out/onsets.json for cuecheck.py.
Score: xylophone + marimba + plucked double bass (pluck.py) + woodblock/shaker/claves/toms, a synthesised rubber
"postmark stamp" as the kick, kalimba and glockenspiel for the arrival. 120 BPM, F major."""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, noise, brown, bp, lp, hp, t_, env_exp, norm, whoosh, step, pop, thump

S.seed(11)
rng = np.random.default_rng(5)
EV = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EV['dur']; ev = EV['ev']
tempo = [e for e in ev if e['type'] == 'tempo'][0]
BPM = tempo['bpm']; BEAT = 60 / BPM; SIL0, SIL1 = tempo['sil0'], tempo['sil1']
def b(bar, beat=1, s16=0): return ((bar - 1) * 4 + (beat - 1)) * BEAT + s16 * BEAT / 4
N = int(round((DUR + .05) * SR))
onsets = []          # every musical onset (seconds) — cuecheck compares visual hits against these

# ======================= SCORE =======================
notes = []           # (t, inst, pitch, dur, vel, pan[, gain])
def n(t, inst, pitch, dur=.4, vel=.6, pan=0., gain=1.):
    notes.append((round(t, 6), inst, pitch, dur, vel, pan, gain)); onsets.append(round(t, 6))
plucks = []          # (t, pitch, dur, vel, pan)
def bass(t, pitch, dur=.45, vel=.75): plucks.append((t, pitch, dur, vel)); onsets.append(round(t, 6))
stamps = []          # synthesised rubber-stamp kick (the beat), (t, vel)
def kick(t, vel=.8): stamps.append((t, vel)); onsets.append(round(t, 6))

# —— A · 寄出 (bar 1) ——
for i, p in enumerate(['F3', 'A3', 'C4', 'F4']): n(0 + i * .03, 'marimba', p, 1.8, .42, -.2 + i * .12, .9)
n(b(1, 3), 'xylophone', 'A5', .4, .62, .15); n(b(1, 3, 1), 'xylophone', 'C6', .4, .55, .15)
n(b(1, 4), 'xylophone', 'F6', .4, .66, .15); n(b(1, 4, 2), 'xylophone', 'E6', .4, .5, .15)
n(b(1, 3), 'glockenspiel', 'A6', 1.0, .28, .3)
kick(b(1, 3), .55); kick(b(1, 4), .4)
bass(b(1, 3), 'F2', .9, .55)

# —— B · the journey (bars 2–6): groove, density rises ——
CH = {2: ('D2', ['D4', 'F4', 'A4'], 'Dm'), 3: ('Bb1', ['D4', 'F4', 'Bb4'], 'Bb'), 4: ('C2', ['E4', 'G4', 'C5'], 'C'), 5: ('D2', ['D4', 'F4', 'A4'], 'Dm'), 6: ('G1', ['D4', 'G4', 'Bb4'], 'Gm')}
BASSLINE = {2: ['D2', 'A2', 'D2', 'C2'], 3: ['Bb1', 'F2', 'Bb1', 'A1'], 4: ['C2', 'G2', 'C2', 'E2'], 5: ['D2', 'A2', 'Bb1', 'F2'], 6: ['G1', 'D2', 'C2', 'G2']}
ARP = {5: (['D4', 'F4', 'A4', 'D5'], ['Bb3', 'D4', 'F4', 'Bb4']), 6: (['G3', 'Bb3', 'D4', 'G4'], ['C4', 'E4', 'G4', 'C5'])}
for bar in range(2, 7):
    t0 = b(bar)
    for bt in range(4):
        t = t0 + bt * BEAT
        if t >= SIL0: break
        # stamp-kick on 1 and 3, woodblock on 2 and 4
        if bt in (0, 2): kick(t, .8 if bt == 0 else .65)
        else: n(t, 'woodblock', 'a' if bt == 1 else 'b', .2, .62, .25)
        # bass: quarters in bars 2–3, eighths from the truck (bar 3 beat 3) on
        bl = BASSLINE[bar][bt]
        if t < b(3, 3): bass(t, bl, .42, .78)
        else: bass(t, bl, .2, .8); bass(t + BEAT / 2, bl if bt % 2 == 0 else BASSLINE[bar][(bt + 1) % 4], .18, .62)
        # marimba off-beat dyads (bars 2–4), 16th arpeggios (bars 5–6)
        if bar <= 4 or (bar == 5 and bt < 1):
            for p in CH[bar][1][:2]: n(t + BEAT / 2, 'marimba', p, .25, .45, -.3, .8)
        else:
            arp = ARP[bar][0] if bt < 2 else ARP[bar][1]
            for s in range(4): n(t + s * BEAT / 4, 'marimba', arp[s], .2, .38 + .05 * s, -.35 + .2 * s, .75)
        # shaker: eighths from 5.0, sixteenths from 8.5
        if t >= b(3, 3):
            sub = 4 if t >= b(5, 2) else 2
            for s in range(sub): n(t + s * BEAT / sub, 'shaker', 'down' if s % 2 == 0 else 'up', .15, .45 if s == 0 else .3, .4, .55)
        if t >= b(5, 2) and bt % 2 == 1: n(t + BEAT / 4 * 3, 'claves', None, .2, .4, -.4, .5)
# xylophone melody (the letter motif and its sequences)
MEL = [(b(2, 1), 'D6', .5), (b(2, 2), 'F6', .5), (b(2, 3), 'E6', .5), (b(2, 4), 'C6', .5),
       (b(3, 1), 'A5', .25), (b(3, 1, 1), 'C6', .25), (b(3, 2), 'F6', .5), (b(3, 3), 'E6', .5), (b(3, 4), 'D6', .5),
       (b(4, 1), 'G5', .25), (b(4, 1, 1), 'C6', .25), (b(4, 2), 'E6', .5), (b(4, 3), 'G6', .5), (b(4, 4), 'F6', .5),
       (b(5, 1), 'A6', .5), (b(5, 2), 'D6', .25), (b(5, 2, 2), 'F6', .25), (b(5, 3), 'A6', .25), (b(5, 3, 2), 'D7', .5), (b(5, 4), 'C7', .5),
       (b(6, 1), 'D7', .25), (b(6, 2), 'Bb6', .25), (b(6, 3), 'D7', .25), (b(6, 3, 1), 'C7', .25), (b(6, 4), 'G6', .25), (b(6, 4, 2), 'E6', .25)]
for t, p, d in MEL: n(t, 'xylophone', p, d, .62, .15)
for t in (b(5, 2), b(6, 1)): n(t, 'glockenspiel', 'D7' if t < 10 else 'G6', .8, .35, .35)
# 10.0 touchdown accent, riser and tom fill into the silence
n(b(6, 1), 'sus_cymbal', 'hit', 1.0, .35, 0, .5)
n(b(6, 2), 'sus_cymbal', 'cresc', 1.5, .4, -.2, .55)
for s in range(4): n(b(6, 4, s), 'toms', 'high_mallet' if s < 2 else 'low_mallet', .2, .55 + .1 * s, -.2 + .15 * s, .9)

# —— C · 送达 (13.0–16.0): after the silence, half-time warmth ——
for i, p in enumerate(['Bb2', 'F3', 'A3', 'C4', 'D4']): n(SIL1 + i * .025, 'marimba', p, 2.5, .55, -.3 + i * .15, 1.0)
n(SIL1, 'glockenspiel', 'F6', 2.0, .42, .3); n(SIL1, 'glockenspiel', 'A6', 2.0, .3, -.3)
bass(SIL1, 'Bb1', 1.6, .8)
KAL = [(b(7, 4), 'F4'), (b(8, 1), 'A4'), (b(8, 1, 2), 'C5'), (b(8, 2), 'A4'), (b(8, 3), 'G4'), (b(8, 3, 2), 'F4'), (b(8, 4), 'E4'), (b(8, 4, 2), 'G4')]
for t, p in KAL: n(t, 'kalimba', p, .8, .62, -.15)
for t, ch, bn in [(b(8, 1), ['A3', 'C4', 'E4', 'G4'], 'A1'), (b(8, 3), ['G3', 'Bb3', 'D4', 'F4'], 'G1'), (b(8, 4), ['C4', 'E4', 'G4', 'Bb4'], 'C2')]:
    for i, p in enumerate(ch): n(t + i * .02, 'marimba', p, .9, .42, -.3 + i * .2, .85)
    bass(t, bn, .8, .7)
n(b(8, 4), 'glockenspiel', 'C7', 1.2, .5, .2)          # the heart
n(b(8, 3), 'woodblock', 'c', .2, .35, .3)
n(b(7, 4, 2), 'shaker', 'down', .15, .28, .3, .5)   # under the first footstep

# —— D · scale reveal (16.0–19.75) ——
for s in range(16):  # marimba tremolo swelling through the pull-out
    t = b(9, 1, s); p = ['F3', 'C4', 'A3', 'C4'][s % 4]; n(t, 'marimba', p, .2, .25 + .02 * s, -.2 + .4 * (s % 2), .7)
bass(b(9, 1), 'F2', .9, .7); bass(b(9, 3), 'C2', .9, .7)
n(b(9, 2), 'xylophone', 'C6', .5, .62, -.3); n(b(9, 2, 2), 'xylophone', 'F6', .5, .62, .3)
SCALE = ['F5', 'G5', 'A5', 'Bb5', 'C6', 'D6', 'E6', 'F6', 'G6', 'A6', 'Bb6', 'C7']
for i in range(12):
    t = b(9, 3) + i * BEAT / 4; n(t, 'xylophone', SCALE[i], .3, .5 + .02 * i, -.5 + i / 11, .9)
    n(t, 'shaker', 'down' if i % 2 == 0 else 'up', .12, .3, .5, .4)
n(b(9, 4), 'glockenspiel', 'A6', 1.2, .5, .4); n(b(9, 4, 2), 'glockenspiel', 'C7', 1.2, .5, .5)
T_END = b(10, 1)
for i, p in enumerate(['F2', 'C3', 'F3', 'A3', 'C4', 'F4']): n(T_END + i * .03, 'marimba', p, 1.8, .62, -.4 + i * .16, 1.0)
n(T_END, 'xylophone', 'F6', 1.2, .6, .2); n(T_END, 'glockenspiel', 'F6', 1.8, .45, -.2); n(T_END, 'glockenspiel', 'C7', 1.8, .38, .3)
n(T_END, 'kalimba', 'F4', 1.5, .55, -.1); n(T_END + BEAT / 2, 'kalimba', 'A4', 1.2, .45, .1); n(T_END + BEAT, 'kalimba', 'C5', 1.2, .4, .2)
bass(T_END, 'F1', 1.7, .85)
kick(T_END, .9)

music = S.render([(t, i, p, d, v, pn, g) for (t, i, p, d, v, pn, g) in notes], dur=DUR + .05)
music = music[:N] if len(music) >= N else np.pad(music, ((0, N - len(music)), (0, 0)))
for (t, p, d, v) in plucks:
    x = P.pluck('upright_bass_pizz', p, d + .3, v)
    # give the bass 2nd/3rd harmonics so it speaks on small speakers
    x = x + .35 * np.tanh(x * 3) / 3
    add(music, hp(x, 50).astype(np.float32), t, .4, -.05)

def stamp_kick(v=1.0, big=False):
    """rubber postmark stamp on a wooden counter: low knock + rubber slap + paper"""
    d = .45 if big else .25; tt = t_(d)
    knock = np.sin(2 * np.pi * (95 if not big else 70) * tt * (1 - .35 * tt)) * env_exp(d, .06 if not big else .1)
    wood = bp(noise(d), 300, 1100) * env_exp(d, .012) * .8
    slap = hp(noise(d), 2500) * env_exp(d, .004) * .5
    x = knock + wood + slap
    if big: x = x + np.sin(2 * np.pi * 48 * tt) * env_exp(d, .15) * .6 + bp(noise(d), 1500, 4000) * env_exp(d, .02) * .3
    return norm(x).astype(np.float32) * v
for t, v in stamps: add(music, hp(stamp_kick(v), 70).astype(np.float32), t, .8)
music = S.room(music, size=.32, mix=.14)

# ======================= FOLEY =======================
fol = np.zeros((N, 2), np.float32)
def paper(d=.12, v=1.0, lo=1800, hi=7000):
    return (bp(noise(d), lo, hi) * env_exp(d, d / 4) * v).astype(np.float32)
def metal(parts, d=.4, v=1.0, tr=.003):
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * env_exp(d, tau) for f, a, tau in parts)
    x = x + hp(noise(d), 3000) * env_exp(d, tr) * .6
    return norm(x).astype(np.float32) * v
def motor(d, f0, f1, v=1.0, nz=.4):
    tt = t_(d); f = np.linspace(f0, f1, len(tt)); ph = np.cumsum(f) / SR
    saw = 2 * ((ph) % 1) - 1
    x = lp(saw, 900) + lp(brown(d), 500) * nz
    e = np.minimum(1, tt / .08) * np.minimum(1, (d - tt) / .15)
    return (norm(x) * e * v).astype(np.float32)
def jet(d, f0, f1, v=1.0, up=True):
    tt = t_(d); nz = noise(d); out = np.zeros_like(nz)
    for i in range(0, len(nz), 960):
        hi_ = min(len(nz), i + 960); f = f0 + (f1 - f0) * i / len(nz)
        out[i:hi_] = bp(nz[max(0, i - 3000):hi_], f * .6, f * 1.6)[-(hi_ - i):]
    whine = np.sin(2 * np.pi * np.cumsum(np.linspace(2400, 3400 if up else 2000, len(tt))) / SR) * .08
    e = (tt / d) ** .7 if up else (1 - tt / d) ** 1.5
    return (norm(out + whine) * e * v).astype(np.float32)
def squeak(d=.25, f=1800, v=1.0):
    tt = t_(d); x = np.sin(2 * np.pi * np.cumsum(f * (1 + .03 * np.sin(2 * np.pi * 30 * tt))) / SR) * np.sin(np.pi * tt / d) ** .5
    return (x * v + hp(noise(d), 3000) * np.sin(np.pi * tt / d) * .15 * v).astype(np.float32)
def bell(v=1.0):
    return metal([(3150, 1, .35), (4420, .6, .25), (6240, .3, .12), (2050, .25, .3)], .7, v)

for e in ev:
    t, ty = e['t'], e['type']; v = e.get('v', 1.0)
    if ty == 'slide': add(fol, paper(.45, .35, 2500, 8000), t, .5, .1)
    elif ty == 'flap_metal': add(fol, metal([(520, 1, .05), (1340, .7, .03), (2210, .5, .02), (180, .6, .04)], .3), t, .7, .1); add(fol, paper(.1, .6), t, .4)
    elif ty == 'pen': n_ = int(e['d'] * SR); x = bp(noise(e['d']), 2500, 6000) * (.5 + .5 * np.abs(np.sin(2 * np.pi * 22 * t_(e['d'])))); add(fol, (x * .25).astype(np.float32), t, .5, .3)
    elif ty == 'skin': add(fol, whoosh(.35, .5), t, .45 * v, -.2)
    elif ty == 'paper_land': add(fol, paper(.14, 1.0, 600, 5000), t, .7 * v); add(fol, thump(.25, 140).astype(np.float32), t, .3 * v)
    elif ty == 'hop': add(fol, paper(.08, 1.0, 1500, 7000), t, .45)
    elif ty == 'hop0': add(fol, paper(.08, 1.0, 1500, 7000), t, .4)
    elif ty == 'belt_start':
        add(fol, motor(1.6, 60, 70, .25, .8), t - .1, .25, .3)
        for i in range(12): add(fol, metal([(1900, 1, .01), (3100, .5, .008)], .05, .3), t + i * BEAT / 2, .25, .3)
    elif ty == 'stamp_big':
        add(fol, stamp_kick(1.0, True), t, 1.0 if not e.get('final') else 1.1)
        add(fol, metal([(320, 1, .08), (870, .5, .05), (1610, .3, .03)], .4, .5), t, .5)
        add(fol, paper(.12, .8, 800, 5000), t, .4)
    elif ty == 'flip': add(fol, metal([(2600, 1, .015), (4100, .6, .01)], .08, .7), t, .5, .2)
    elif ty == 'sack_thud': add(fol, (lp(noise(.25), 500) * env_exp(.25, .05)).astype(np.float32), t, .9 * v); add(fol, thump(.5, 90).astype(np.float32), t, .4 * v)
    elif ty == 'truck_go':
        add(fol, motor(e['d'] + .4, 42, 78, 1.0), t, .3, .1)
        for i in range(int(e['d'] / (BEAT / 2))): add(fol, thump(.4, 120).astype(np.float32)[:2400], t + (i + 1) * BEAT / 2, .25)
    elif ty == 'truck_stop': add(fol, (hp(noise(.6), 2500) * env_exp(.6, .15)).astype(np.float32), t, .25, .2); add(fol, thump(.6, 75).astype(np.float32), t, .35)
    elif ty == 'loader': add(fol, motor(e['d'] + .1, 140, 190, .5, .2), t, .3, -.2)
    elif ty == 'jet_roll': add(fol, jet(e['d'] + .05, 300, 900, 1.0), t, .55)
    elif ty == 'liftoff': x = jet(e['d'], 900, 400, 1.0, up=False); add(fol, x, t, .6); add(fol, whoosh(.6, 1.0), t, .5)
    elif ty == 'touchdown': add(fol, squeak(.18, 950, 1.0), t, .3); add(fol, thump(.8, 70).astype(np.float32), t, .5); add(fol, jet(.9, 700, 300, .8, up=False), t, .35)
    elif ty == 'basket': add(fol, metal([(1200, 1, .02), (2300, .6, .015)], .1, .5), t, .4); add(fol, paper(.1, .8), t, .4)
    elif ty == 'bike':
        for i in range(int(e['d'] / (BEAT / 4))): add(fol, metal([(5200, 1, .006)], .02, .2), t + i * BEAT / 4, .25, -.1)
    elif ty == 'bike_leave':
        nt = int(e['d'] / (BEAT / 4))
        add(fol, squeak(.12, 1400, .6), t, .08, -.2)
        for i in range(nt): add(fol, metal([(5200, 1, .006)], .02, .2), t + i * BEAT / 4, .22 * (1 - i / nt) ** 1.5, -.15 - .5 * i / nt)
    elif ty == 'bell': add(fol, bell(1.0), t, .38, .2); add(fol, bell(.9), t + BEAT / 4, .32, .2)
    elif ty == 'brake': add(fol, squeak(.28, 1750, 1.0), t, .22, .1); add(fol, paper(.25, .5, 400, 2500), t, .3)
    elif ty == 'slot_push': pass   # added after the silence mask
    elif ty == 'clack_slot':
        x = metal([(1100, 1, .06), (2700, .8, .05), (4300, .5, .03), (650, .7, .05), (230, .5, .06)], .7, 1.0, .002)
        add(fol, x, t, 1.25, .05); add(fol, paper(.15, 1.0, 900, 6000), t + .02, .5)
    elif ty == 'step': add(fol, step(.8), t, .3, -.1); add(fol, thump(.3, 110).astype(np.float32)[:4000], t, .25)
    elif ty == 'pickup': add(fol, paper(.3, .8, 1500, 7000), t, .45)
    elif ty == 'tear':
        d = .4; x = hp(noise(d), 1200) * (rng.random(int(d * SR)) > .7) * np.sin(np.pi * t_(d) / d); add(fol, (x * .6).astype(np.float32), t, .5, .1)
    elif ty == 'inset': add(fol, pop(.6), t, .25, .3)
    elif ty == 'heart': add(fol, pop(.8), t, .3, .2)
    elif ty == 'pullout':
        x = whoosh(1.0, 1.0)[::-1].copy(); add(fol, x, t, .45)
    elif ty == 'label': add(fol, pop(.5), t, .2)
    elif ty == 'icon': add(fol, paper(.05, .7, 2000, 8000), t, .25, -.5 + e['i'] / 11)
    elif ty == 'sun': add(fol, metal([(5200, 1, .2), (7100, .5, .1)], .4, .4), t, .15, .5)

# ======================= AMBIENCE =======================
amb = np.zeros((N, 2), np.float32)
def birds(d, dens=2.0):
    out = np.zeros(int(round(d * SR)), np.float32)
    for i in range(int(d * dens)):
        s = rng.random() * (d - .3); f0 = 2600 + rng.random() * 2200; L = .06 + rng.random() * .1; tt = t_(L)
        ch = np.sin(2 * np.pi * np.cumsum(f0 * (1 + .25 * np.sin(2 * np.pi * (10 + rng.random() * 14) * tt))) / SR) * np.sin(np.pi * tt / L) ** 2
        for r in range(1 + int(rng.random() * 3)):
            a = int((s + r * (L + .04)) * SR); out[a:a + len(ch)] += ch[:len(out) - a] * .5
    return out
def bed(kind, d):
    tt = t_(d)
    if kind == 'street': return lp(brown(d), 350) * .5 + birds(d, 2.5) * .35
    if kind == 'machine': return (np.sin(2 * np.pi * 60 * tt) * .25 + np.sin(2 * np.pi * 120 * tt) * .15 + bp(noise(d), 400, 900) * .35) * (1 + .3 * np.sign(np.sin(2 * np.pi * 4 * tt)))
    if kind == 'road': return lp(brown(d), 500) * .8
    if kind == 'apron': return lp(brown(d), 600) * .5 + np.sin(2 * np.pi * 3150 * tt) * .02
    if kind == 'wind': return bp(noise(d), 250, 1200) * (.6 + .4 * np.sin(2 * np.pi * .7 * tt))
    if kind == 'room': return lp(brown(d), 700) * .25 + birds(d, .8) * .12
    if kind == 'air': return bp(noise(d), 200, 900) * .35
    return np.zeros(len(tt))
for e in ev:
    if e['type'] != 'bed': continue
    t0, t1 = e['t'], e['t1']; d = t1 - t0
    x = norm(bed(e['kind'], d)).astype(np.float32); tt = t_(d)[:len(x)]
    fade = np.minimum(1, np.minimum(tt / .25, (d - tt) / .25)); x = x * fade * e.get('v', 1)
    add(amb, x, t0, .16, -.3 if e['kind'] in ('street', 'room') else .2)

# ======================= MIX =======================
mix = music * 1.0 + fol * .8 + amb * 1.0
# the held breath: digital silence from SIL0 to SIL1 (12 ms fades) — only the letter's faint paper slide remains
i0, i1, f = int(SIL0 * SR), int(SIL1 * SR), int(.012 * SR)
gate = np.ones(N, np.float32); gate[i0:i1] = 0; gate[i0:i0 + f] = np.linspace(1, 0, f)
mix *= gate[:, None]
for e in ev:
    if e['type'] == 'slot_push':
        d = e['d'] - .03; x = bp(noise(d), 2500, 7000) * np.sin(np.pi * t_(d) / d) ** 2 * (.6 + .4 * np.abs(np.sin(2 * np.pi * 3 * t_(d))))
        add(mix, (x * .02).astype(np.float32), e['t'] + .015, 1.0, .05)
# tail fade
tf = int(.45 * SR); mix[-tf:] *= np.linspace(1, 0, tf)[:, None] ** 1.5
# master: +6 dB into a look-ahead limiter so short transients (stamps, the slot flap) don't dictate the loudness
mix *= 2.0
for c in range(2): mix[:, c] = limit(mix[:, c], .8, .004)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
sf.write(os.path.join(HERE, 'out', 'music_stem.wav'), music.astype(np.float32), SR)
json.dump(sorted(set(onsets)), open(os.path.join(HERE, 'out', 'onsets.json'), 'w'))
# low-end balance report
def band(x, lo, hi): y = bp(x.mean(1), lo, hi, 4); return 10 * np.log10(np.mean(y ** 2) + 1e-12)
lo_ = band(mix, 25, 120); mid = band(mix, 200, 4000)
print(f'mix.wav {len(mix)/SR:.2f}s  peak {np.abs(mix).max():.2f}  low(25–120) − mid(200–4k) = {lo_ - mid:+.1f} dB  silence rms {20*np.log10(np.sqrt(np.mean(mix[i0+f:i1]**2))+1e-12):.1f} dBFS')
print('instruments:', sorted(set(nt[1] for nt in notes)))
