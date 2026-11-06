"""跳水 — original score + foley + ambience → out/mix.wav (and out/stems/*.wav, out/cues.json).
Lo-fi drum machine (synth kick, sampled clap/hats/shaker/rim through tape saturation), synth bass with sidechain,
FM electric piano, sampled vibraphone (soft, hard, bowed), plucked kalimba drops (pluck.py). 90 BPM, grid from timeline.json.
Run: $LIB/.venv/bin/python mix.py   (LIB = the library root)"""
import os, sys, json
import numpy as np, soundfile as sf, soxr
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, t_, bp, lp, hp, noise, norm, add, limit, whoosh

HERE = os.path.dirname(os.path.abspath(__file__))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR, EV = EVJ['dur'], EVJ['ev']
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
BEAT = TL['BEAT']; b = lambda x: x * BEAT
N = int(round(DUR * SR))
S.seed(12)
rng = np.random.default_rng(12)
nz = lambda d: rng.standard_normal(int(round(d * SR)))
CUES = []                       # (time, tag) of every placed onset, for the cue check
def cue(t, tag): CUES.append({'t': round(float(t), 6), 'tag': tag})
def st(): return np.zeros((N, 2))
def place(buf, x, at, g=1.0, pan=0.0, tag=None):
    add(buf, x.astype(np.float64), at, g, pan)
    if tag: cue(at, tag)
def env_ad(d, a, r):
    tt = t_(d); return np.minimum(1, tt / max(a, 1e-4)) * np.exp(-np.maximum(0, tt - a) / r)
HZ = lambda p: S.hz(p)

# ═════════════ instruments (synthesis) ═════════════
def kick(v=1.0, f0=58, dec=.2, click=1.4):
    d = dec * 4; tt = t_(d)
    f = f0 * (1 + 2.6 * np.exp(-tt / .028)); ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-tt / dec)
    cl = hp(nz(d), 2000) * np.exp(-tt / .003) * .35 * click
    knock = bp(nz(d), 180, 1200) * np.exp(-tt / .012) * .5          # the boxy drum-machine knock in the mids
    return hp(np.tanh((body * .8 + cl + knock) * 1.8) / np.tanh(1.8), 38) * v
def sub_hit(v=1.0):            # the entry: a long 808-ish drop with harmonics so it speaks on small speakers
    d = 2.6; tt = t_(d)
    f = 36.7 * (1 + 3.2 * np.exp(-tt / .04)); ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-tt / .6)
    x = np.tanh(x * 3.2) / np.tanh(3.2)
    return hp(x, 30) * v * .8
def bass(p, dur, v=.8, glide=None):
    d = dur + .12; tt = t_(d); f = np.full(len(tt), HZ(p))
    if glide: f = f * 2 ** (glide[0] / 12 * np.clip((tt - glide[1]) / max(glide[2], 1e-3), 0, 1))
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = 2 * ((np.cumsum(f) / SR) % 1) - 1
    x = .55 * np.sin(ph) + .5 * np.sin(2 * ph) + .3 * np.sin(3 * ph) + .12 * np.sin(4 * ph) + .3 * lp(saw, 900)
    e = np.minimum(1, tt / .006) * np.where(tt < dur, np.exp(-tt / (dur * 2.5 + .2)), np.exp(-(dur) / (dur * 2.5 + .2)) * np.exp(-(tt - dur) / .05))
    return hp(np.tanh(x * e * 1.3), 40) * v * .42
def rhodes(p, dur, v=.6):
    d = dur + 1.2; tt = t_(d); f = HZ(p)
    I = (1.6 * v + .3) * np.exp(-tt / .45) + .35
    x = np.sin(2 * np.pi * f * tt + I * np.sin(2 * np.pi * f * tt))
    x += .18 * v * np.sin(2 * np.pi * f * 14.1 * tt) * np.exp(-tt / .018)       # the tine
    x *= 1 + .1 * np.sin(2 * np.pi * 4.6 * tt)                                  # tremolo
    e = np.minimum(1, tt / .003) * np.exp(-tt / 2.4) * np.where(tt < dur, 1, np.exp(-(tt - dur) / .25))
    return x * e * v * .35
def chord(buf, at, notes, dur, v=.55, tag=None):
    for i, n in enumerate(notes): place(buf, rhodes(n, dur, v), at + i * .012, 1, (i / max(1, len(notes) - 1) - .5) * .6)
    if tag: cue(at, tag)

# ═════════════ the score ═════════════
drums, bassb, keys, vib, perc = st(), st(), st(), st(), st()
KICKS = []
def K(bt_, v=1.0, **kw):
    place(drums, kick(v, **kw), b(bt_), .95, 0, 'kick'); KICKS.append(b(bt_))
def clap(bt_, v=.6): place(drums, S.hit('claps', 'group', v), b(bt_), .55, .1, 'clap'); place(drums, S.hit('snare2', 'off', v * .8), b(bt_), .35, -.05)
def hat(bt_, v=.45, op=False): place(drums, S.hit('hihat', 'open' if op else 'closed', v, dur=.5 if op else .12), b(bt_), .32, .35)
def shk(bt_, v=.35): place(perc, S.hit('shaker', 'down' if (bt_ * 4) % 2 < 1 else 'up', v), b(bt_), .3, -.4)
def rim(bt_, v=.6): place(perc, S.hit('claves', None, v), b(bt_), .35, -.3, 'rim')

# bar 1 (b0–4): the print is being made — kick on the plate, rim on the title; drum bus low-passed, opens by b4
K(1, 1.0); rim(2, .7); K(3, .8); hat(3.5, .3)
chord(keys, b(1), ['D3', 'F3', 'A3', 'C4', 'E4'], b(3), .38)                 # Dm9
# bars 2–3 (b4–12): the groove, then the acceleration
for bar in (4, 8):
    for o in (0, 1.5, 2.5): K(bar + o, .95 if o == 0 else .8)
    for o in (1, 3): clap(bar + o)
for i in range(16): hat(4 + i * .5, .5 if i % 2 == 0 else .32, op=(i == 7))
for i in range(8): shk(4 + i * .5, .25)
for i in range(4): hat(10 + i * .25, .3 + i * .03)                           # 16ths from b10
for i in range(6): place(drums, S.hit('snare2', 'taps', .25 + i * .1), b(10.5 + i * .25), .3 + i * .05, -.1, 'roll')
place(drums, S.hit('snare2', 'roll', .7, dur=b(1.5)), b(10.5), .35, -.1)
riser = bp(nz(b(3)), 400, 6000) * np.linspace(0, 1, int(round(b(3) * SR))) ** 2.2
place(perc, riser, b(9), .18, 0)
chord(keys, b(4), ['A#2', 'D3', 'F3', 'A3', 'C4'], b(4) - .05, .5, 'chord')      # Bbmaj9
chord(keys, b(8), ['G2', 'A#2', 'D3', 'F3', 'A3'], b(2), .5, 'chord')            # Gm9
chord(keys, b(10), ['A2', 'C#3', 'G3', 'A#3', 'E4'], b(2) - .05, .55, 'chord')   # A7(b9)
for at, p, d in [(4, 'A#1', 1.4), (5.5, 'A#1', .4), (6, 'D2', .4), (6.5, 'F2', 1.3), (8, 'G1', 1.4), (9.5, 'G1', .4), (10, 'A1', .45), (10.5, 'A1', .2), (10.75, 'C#2', .2), (11, 'E2', .2), (11.25, 'G2', .2), (11.5, 'A2', .2), (11.75, 'C#3', .2)]:
    place(bassb, bass(p, b(d)), b(at), 1, 0, 'bass')
# bar 4–5 (b12–18): TAKEOFF → slow motion. Downbeat crash, tape-slowed, half-time beat, vibraphone line
crash = S.hit('clash', 'crash', .8)
slow = soxr.resample(crash, SR, int(SR * 1.7))                               # played 0.59× → lower, longer: time slows
place(perc, slow, b(12), .5, .1, 'crash')
K(12, 1.0, f0=46, dec=.5)
place(bassb, bass('D2', b(5.5), .85, glide=(-12, .05, .7)), b(12), 1, 0, 'bass')  # the bass sinks an octave as time slows
K(13.5, .55, f0=44, dec=.4); clap(14, .5); K(16, .7, f0=44, dec=.45); rim(17, .4)
for i in range(6): place(perc, S.hit('shaker', 'roll' if i == 0 else 'down', .18), b(12 + i), .2, -.5)
chord(keys, b(12), ['D3', 'A3', 'C4', 'E4', 'F4'], b(6), .4)
for at, p, d, v in [(12.5, 'A4', 1, .55), (13, 'C5', 1, .5), (14, 'E5', 1, .6), (15, 'F5', 1, .7), (16, 'E5', .5, .5), (16.5, 'D5', .5, .45), (17, 'C5', .5, .45), (17.5, 'A4', .5, .4)]:
    place(vib, S.note('vibraphone', p, b(d), v), b(at), .9, .15, 'vib')
for p in ('A4', 'C5', 'E5', 'F5'): place(vib, S.note('vibraphone_bowed', p, b(3), .55, attack=.25), b(15), .35, -.2)   # the violet shimmer
cue(b(15), 'violet')
# bar 5 second half (b18–20): SILENCE — everything musical stops dead at the cut
# bar 6 (b20–24): ENTRY — the heaviest beat of the film, then everything at once
place(drums, sub_hit(1.0), b(20), 1.0, 0, 'entry'); KICKS.append(b(20))
place(perc, S.hit('clash', 'crash', 1.0), b(20), .65, -.1); place(perc, S.hit('sus_cymbal', 'hit', .9), b(20), .35, .25)
clap(20, .9)
chord(keys, b(20), ['D3', 'F3', 'A3', 'C4', 'E4', 'A4'], b(4) - .05, .62, 'chord')   # Dm9 wide
for at, p, d in [(20, 'D2', 1.4), (21.5, 'D2', .4), (22, 'F2', .9), (23, 'A1', .45), (23.5, 'C2', .45)]:
    place(bassb, bass(p, b(d), .9), b(at), 1, 0, 'bass')
for o in (1.5, 2.5): K(20 + o, .85)
clap(23)
for i in range(16): hat(20 + i * .25, .42 if i % 2 == 0 else .26)
place(vib, S.note('vibraphone_hard', 'D5', b(2), .7), b(20), .6, .2); place(vib, S.note('vibraphone_hard', 'A5', b(2), .6), b(20), .45, -.2)
for k, (bt_, p) in enumerate(zip([21, 21.5, 22, 23], ['A5', 'F5', 'D6', 'C6'])):
    place(vib, P.pluck('kalimba', p, 1.6, .75), b(bt_), .55, (-.4, .4, -.2, .3)[k], 'kalimba')
# bar 7 (b24–28): the ripples — the band thins out, one piece at a time
chord(keys, b(24), ['A#2', 'D3', 'F3', 'A3', 'C4'], b(2) - .05, .5, 'chord')
chord(keys, b(26), ['C3', 'E3', 'G3', 'A#3', 'D4'], b(2) - .05, .45, 'chord')     # C9
K(24, .85); K(25.5, .6); clap(25, .5); K(26, .7)
for i in range(6): hat(24 + i * .5, .3)
for i in range(8): shk(24 + i * .5, .22)
for at, p, d in [(24, 'A#1', 1.4), (25.5, 'D2', .4), (26, 'C2', 1.4), (27.5, 'E2', .4)]:
    place(bassb, bass(p, b(d), .8), b(at), 1, 0, 'bass')
for at, p in [(24.5, 'D5'), (25, 'F5'), (26.5, 'E5'), (27, 'G5')]: place(vib, S.note('vibraphone', p, b(.75), .45), b(at), .7, .2, 'vib')
# bar 8 (b28): the final beat — Fmaj9, let it ring
K(28, .9, f0=44, dec=.5)
chord(keys, b(28), ['F2', 'C3', 'E3', 'G3', 'A3', 'C4'], 1.9, .55, 'chord')
place(bassb, bass('F1', 1.6, .85), b(28), 1, 0, 'bass')
for p, pn in [('A4', -.3), ('C5', .1), ('E5', .3), ('G5', -.1)]: place(vib, S.note('vibraphone', p, 1.8, .55), b(28), .45, pn)
place(perc, S.hit('triangle', 'open', .5), b(28), .25, .5)

# ── processing: sidechain from every kick, tape saturation on the drum bus, filter opening in bar 1 ──
tt = np.arange(N) / SR
duck = np.ones(N)
for tk in KICKS:
    m = tt >= tk; duck[m] *= 1 - .55 * np.exp(-(tt[m] - tk) / .13)
keys *= duck[:, None]
# the sunk-octave bass under the slow motion (b12–18) pumps harder: a second, longer duck from those kicks only (≈ −14 dB at the hit)
duckB = duck.copy()
for tk in KICKS:
    if b(12) - 1e-6 <= tk < b(18):
        m = tt >= tk; duckB[m] *= 1 - .55 * np.exp(-(tt[m] - tk) / .22)
bassb *= duckB[:, None]
from scipy.signal import butter, sosfilt
def sweep_lp(x, t0, t1, f0, f1):   # a filter opening from f0 to f1 between t0 and t1 (blockwise)
    y = x.copy(); n0, n1, blk = int(t0 * SR), int(t1 * SR), 2400
    for s in range(0, n1, blk):
        e = min(n1, s + blk); fc = f0 * (f1 / f0) ** max(0, (s - n0) / max(1, n1 - n0))
        sos = butter(2, min(fc, 20000), 'low', fs=SR, output='sos')
        lo = max(0, s - 4800); y[s:e] = sosfilt(sos, x[lo:e], axis=0)[s - lo:]
    return y
drums = sweep_lp(drums, 0, b(4), 700, 16000)
drums = np.tanh(drums * 1.5) / np.tanh(1.5)
# flight (b12–18): the beat goes under water-ish, airy
seg_ = slice(int(b(12) * SR), int(b(18) * SR))
for B_ in (drums, perc):
    B_[seg_] = sosfilt(butter(2, 1600, 'low', fs=SR, output='sos'), B_[seg_], axis=0)
vib = S.room(vib.astype(np.float32), size=.5, mix=.22).astype(np.float64)
keys = S.room(keys.astype(np.float32), size=.35, mix=.15).astype(np.float64)
music = drums * .85 + bassb * .6 + keys * .9 + vib * 1.1 + perc * .95
music = lp(music.T, 11000).T * 1.0
# the dynamic arc: a quiet print, a building run, a hushed fall, the loudest bar on the entry, a settling end
arc_k = [(0, .55), (b(4) - .01, .62), (b(4), .78), (b(12) - .01, 1.0), (b(12), .82), (b(18), .72), (b(20), 1.15), (b(21), 1.0), (b(24), .86), (DUR, .8)]
arc = np.interp(tt, [k[0] for k in arc_k], [k[1] for k in arc_k])
music *= arc[:, None]
# the silence: every musical tail cut dead at the freeze, back on the entry
sil0, sil1 = int(b(18) * SR), int(b(20) * SR)
gate = np.ones(N); gate[sil0:sil1] = 0; f5 = int(.004 * SR); gate[sil0 - f5:sil0] = np.linspace(1, 0, f5)
music *= gate[:, None]

# ═════════════ foley (driven by events.json) ═════════════
fol, amb = st(), st()
def feed(v=1.0, d=.62, rev=False):
    x = bp(nz(d), 1500, 7500) * np.linspace(0, 1, int(round(d * SR))) ** 1.4
    x += bp(nz(d), 200, 900) * .3 * np.sin(np.pi * t_(d) / d)
    return (x[::-1] if rev else x) * v * .5
def kachunk(v=1.0):
    d = .45; x = np.zeros(int(d * SR))
    cl = hp(nz(.03), 1500) * np.exp(-t_(.03) / .004); x[:len(cl)] += cl * .9
    th = np.sin(2 * np.pi * 64 * t_(.4) * (1 - .25 * t_(.4))) * np.exp(-t_(.4) / .08); x[:len(th)] += th * 1.0
    ra = bp(nz(.2), 300, 1400) * np.exp(-t_(.2) / .05); x[480:480 + len(ra)] += ra * .35
    return x * v
def stamp(v=1.0):
    return (lp(nz(.12), 900) * np.exp(-t_(.12) / .02) + np.sin(2 * np.pi * 110 * t_(.12)) * np.exp(-t_(.12) / .03) * .6) * v
def wetstep(v=1.0):
    d = .14; tt = t_(d)
    slap = bp(nz(d), 700, 4500) * np.exp(-tt / .012)
    smack = bp(nz(d), 2500, 9000) * np.exp(-np.maximum(0, tt - .006) / .02) * (tt > .006) * .4
    thud = np.sin(2 * np.pi * 95 * tt) * np.exp(-tt / .025) * .6
    return (slap + smack + thud) * v
def paper_tick(v=1.0): return hp(nz(.03), 3000) * np.exp(-t_(.03) / .004) * v
def drip(v=1.0):
    d = .5; tt = t_(d); f = 900 + 1500 * np.minimum(1, tt / .045)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .07) + hp(nz(d), 3000) * np.exp(-tt / .004) * .3
    return x * v
def splash_big(v=1.0):
    d = 2.4; tt = t_(d)
    burst = bp(nz(d), 250, 7000) * (np.exp(-tt / .35) * .9 + .25 * np.exp(-tt / 1.2))
    crack = hp(nz(d), 1800) * np.exp(-tt / .05) * 1.2
    low = lp(nz(d), 220) * np.exp(-tt / .4) * 1.6
    fall = np.zeros(len(tt))           # the water coming back down: a rain of small slaps
    for k in range(60):
        at = .25 + rng.random() * 1.8
        if any(-.09 < o - at < .03 for o in (2 / 3, 1.0, 4 / 3, 2.0)): at += .12   # keep the falling rain clear of the four drop plinks
        s0 = int(at * SR); x = bp(nz(.05), 900, 6000) * np.exp(-t_(.05) / .01) * (.3 + .7 * rng.random()) * np.exp(-at / 1.2)
        fall[s0:s0 + len(x)] += x[:len(fall) - s0]
    bub = np.zeros(len(tt))
    for k in range(18):
        at = .1 + rng.random() * 1.2; s0 = int(at * SR); dd = .06; f0 = 300 + rng.random() * 600
        x = np.sin(2 * np.pi * np.cumsum(f0 * (1 + 1.5 * t_(dd) / dd)) / SR) * np.sin(np.pi * t_(dd) / dd) * .25
        bub[s0:s0 + len(x)] += x[:len(bub) - s0]
    return (burst + crack + low + fall * .8 + bub) * v
def plink(v=1.0):
    d = .35; tt = t_(d); f = 600 + 1300 * np.minimum(1, tt / .05)
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .06) + bp(nz(d), 1500, 6000) * np.exp(-tt / .02) * .5) * v
def whoom(v=1.0):
    d = 1.4; tt = t_(d)
    return (np.sin(2 * np.pi * (70 + 20 * tt) * tt) * np.sin(np.pi * np.minimum(1, tt / d)) ** 2 + lp(nz(d), 500) * np.sin(np.pi * tt / d) * .5) * v
def bubble_pop(v=1.0):
    d = .25; tt = t_(d); f = 380 + 1400 * tt / d
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .06) + bp(nz(d), 800, 3000) * np.exp(-tt / .03) * .4) * v
def gasp(v=1.0):
    d = .45; tt = t_(d); return bp(nz(d), 900, 3500) * np.sin(np.pi * tt / d) ** 1.5 * np.minimum(1, tt / .05) * v * .5
def flap(v=1.0):
    d = .7; tt = t_(d)
    snap = bp(nz(d), 500, 3200) * np.minimum(1, tt / .0015) * np.exp(-tt / .045)
    flutter = bp(nz(d), 300, 1800) * np.minimum(1, tt / .004) * np.exp(-tt / .2) * (.55 + .45 * np.abs(np.sin(2 * np.pi * 21 * tt)))
    air = bp(nz(d), 220, 1100) * np.minimum(1, tt / .012) * np.exp(-tt / .32)
    return norm(snap + flutter * .7 + air * .45) * v
def stomp(v=1.0):
    d = .3; tt = t_(d)
    return (np.sin(2 * np.pi * 70 * tt * (1 - .3 * tt)) * np.exp(-tt / .06) + bp(nz(d), 400, 3000) * np.exp(-tt / .015) * .8) * v

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'feed': place(fol, feed(1.0, b(1)), t, .55, -.3, 'feed')
    elif ty == 'plateIn': place(fol, kachunk(1.0), t, .8, .1, 'plateIn')
    elif ty == 'title': place(fol, stamp(1.0), t, .7, -.4, 'title')
    elif ty == 'cut':
        if e['shot'] in ('run', 'ripple'): place(fol, paper_tick(.6), t, .4, .3, 'cut')
        else: cue(t, 'cut')
    elif ty == 'step':
        v = .55 + .45 * (1 - min(1, e['dt'] / .7)); place(fol, wetstep(v), t, .75, -.15 + .3 * (e['i'] % 2), 'step')
        place(fol, paper_tick(.25), t, .3, .2)
    elif ty == 'takeoff': place(fol, stomp(1.0), t, .85, 0, 'takeoff'); place(fol, whoosh(.6, .7), t, .5, -.2)
    elif ty == 'spin':   # a cloth/air flap with a hard front, stretched and lowered with the 0.24× slow motion (×1.6), +6 dB
        place(fol, soxr.resample(flap(1.0), SR, int(SR * 1.6)), t, .7, .2 - .2 * (e['beat'] > 14), 'spin')
        place(fol, soxr.resample(whoosh(.45, .9), SR, int(SR * 1.6)), t, .25, .2)
    elif ty == 'violet': place(fol, kachunk(.45), t, .45, .2, 'violetFoley')
    elif ty == 'freeze': cue(t, 'freeze')
    elif ty == 'drip': place(fol, drip(1.0), t, .3, .35, 'drip')
    elif ty == 'entry': place(fol, splash_big(1.0), t, 1.15, 0, 'splash'); place(fol, kachunk(1.0), t, .8, 0)
    elif ty == 'drop': place(fol, plink(1.0), t, (.85, .6, .6, .6)[e['i']], (-.5, .5, -.3, .4)[e['i']], 'drop')   # the first one has to cut through the splash tail
    elif ty == 'ring': place(fol, whoom(1.0), t, .4, 0, 'ring')
    elif ty == 'headUp': place(fol, bubble_pop(1.0), t, .55, 0, 'headUp'); place(fol, gasp(1.0), t + .08, .35, 0)
    elif ty == 'plateOut': place(fol, feed(1.0, b(.75), rev=True), t, .5, .3, 'plateOut')
    elif ty == 'final': place(fol, kachunk(.6), t, .45, 0, 'finalFoley')

# ambience: copier motor hum under the print (A), open air (A–B), wind in the flight (J-cut: starts a beat before the takeoff),
# the hum alone in the silence, water lapping after the entry (L-cut: runs over the cut to the top-down)
def hum(d):
    tt = t_(d); return (np.sin(2 * np.pi * 50 * tt) * .5 + np.sin(2 * np.pi * 100 * tt) * .3 + np.sin(2 * np.pi * 150 * tt) * .12 + bp(noise(d), 200, 800) * .08)
def bed(x, t0, t1, g, fi=.3, fo=.3, pan=0.0):
    n0, n1 = int(t0 * SR), int(t1 * SR); y = x[:n1 - n0].copy(); L = len(y); e = np.ones(L)
    a, r = int(fi * SR), int(fo * SR); e[:a] = np.linspace(0, 1, a); e[L - r:] = np.linspace(1, 0, r); add(amb, y * e, t0, g, pan)
bed(hum(DUR), 0, b(5), .05, .05, .4)
bed(hum(DUR), b(18), b(20), .011, .05, .005)                     # the only thing left in the silence
air = lp(np.cumsum(noise(DUR)) / 300, 600); air = norm(air - lp(air, 20))
bed(air, 0, b(12), .06, .3, .4)
wind = bp(noise(DUR), 300, 2500) * (.6 + .4 * np.sin(2 * np.pi * .7 * np.arange(int(DUR * SR)) / SR))
bed(wind, b(11), b(18), .09, b(1), .004)
lap = lp(noise(DUR), 700) * (.5 + .5 * np.sin(2 * np.pi * .45 * np.arange(int(DUR * SR)) / SR) ** 2)
bed(norm(lap), b(20.5), DUR, .05, .6, .6)

# the silence holds only the hum and the drip
fol[sil0:sil1] *= 0; drip_x = drip(1.0); add(fol, drip_x, b(19), .3, .35)

# ═════════════ master ═════════════
mixd = music * 1.0 + fol * .9 + amb
mixd = mixd - .7 * lp(mixd.T, 140).T                # low shelf: keep 20–120 Hz in check on small speakers
# a further −2 dB shelf below 100 Hz on the whole master — except around the entry, whose sub drop stays exactly as it was
kw = np.interp(tt, [0, b(20) - .02, b(20) - .01, b(20) + 1.2, b(20) + 1.8, DUR], [0, 0, 1, 1, 0, 0])
mixd = mixd - (1 - 10 ** (-2 / 20)) * lp(mixd.T, 100).T * (1 - kw)[:, None]
# final fade over the last 0.5 s
fo = int(.5 * SR); mixd[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
pk = np.abs(mixd).max(); mixd = mixd / pk * .89
# master: +9 dB into a tape-style soft clip and a look-ahead limiter, so the film sits near −14 LUFS with true-peak headroom
mixd = lp(mixd.T, 15000, 4).T
mixd = mixd * 10 ** (10.5 / 20); mixd = .8 * np.tanh(mixd / .8)
up = soxr.resample(mixd, SR, SR * 4)                    # limit at 4× so inter-sample peaks are caught too
for c in range(2): up[:, c] = limit(up[:, c], .6, look=.016)
mixd = soxr.resample(up, SR * 4, SR)[:N]
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mixd.astype(np.float32), SR, subtype='PCM_24')
for nm, x in [('music', music), ('foley', fol), ('amb', amb), ('drums', drums)]:
    sf.write(os.path.join(HERE, 'out', 'stems', nm + '.wav'), (x / max(1e-9, np.abs(x).max()) * .9).astype(np.float32), SR)
json.dump(sorted(CUES, key=lambda c: c['t']), open(os.path.join(HERE, 'out', 'cues.json'), 'w'), indent=0)
# low-end balance report
def band(x, lo, hi):
    X = np.abs(np.fft.rfft(x.mean(1)))**2; f = np.fft.rfftfreq(len(x), 1 / SR); return 10 * np.log10(X[(f >= lo) & (f < hi)].sum() + 1e-12)
print('mix.wav', round(len(mixd) / SR, 3), 's  peak', round(float(np.abs(mixd).max()), 3),
      ' low(20-120) vs mid(120-4k) dB:', round(band(mixd, 20, 120) - band(mixd, 120, 4000), 1), ' cues', len(CUES))
print('silence RMS dBFS', round(20 * np.log10(np.sqrt((mixd[sil0 + 100:sil1 - 100]**2).mean()) + 1e-12), 1),
      ' entry-after RMS', round(20 * np.log10(np.sqrt((mixd[sil1:sil1 + SR // 2]**2).mean()) + 1e-12), 1))
print('\n'.join(S.credits(['claps', 'snare2', 'hihat', 'shaker', 'claves', 'clash', 'sus_cymbal', 'vibraphone', 'vibraphone_hard', 'vibraphone_bowed', 'triangle'])), file=open(os.path.join(HERE, 'out', 'credits_instruments.txt'), 'w'))
