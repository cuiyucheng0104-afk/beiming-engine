#!/usr/bin/env python3
"""Original score + foley + projector bed -> out/mix.wav, and out/cues.json (every music/foley cue).
Everything reads timeline.json (exported from timeline.js) and events.json (window.EV).
Run from anywhere with the library venv:  $LIB/.venv/bin/python audio/mix.py

Score: an original American march for brass band, 120 BPM, B-flat major (no quotation of existing
tunes). Fanfare (timpani + trumpets) -> march (tuba oom-pah, horns/trombones on the off-beats, snare,
bass drum, trumpet tune) -> soft map section (muted trumpet, clarinet, banjo, telegraph) -> the deal
accelerates (quarters, eighths, sixteenths) -> one stab and a dead stop: only the projector runs ->
the most important sound of the film: full band B-flat chord as the plane comes home -> broad
half-time tune (deceleration) -> freeze: timpani + choked cymbal, horns hold -> "da - DA!"."""
import json, os, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent.parent
LIB = Path(os.environ.get("LIB", "@@LEMO_ROOT@@"))
sys.path.insert(0, str(LIB))
from core.audio import sampler as S, pluck as PL
from core.audio.sfx import SR, add, bp, lp, hp, noise, norm, env_exp, t_, whoosh, thump, click, limit

TL = json.loads((HERE / "timeline.json").read_text())
EVJ = json.loads((HERE / "events.json").read_text())
EV = EVJ["ev"]
HIT, DUR, B = TL["HIT"], TL["DUR"], TL["BEAT"]
PAGES, DEALS = TL["PAGES"], TL["DEALS"]
S.seed(29)
N = int((DUR + .6) * SR)
M = S.midi
CUES = []                      # (t, what) every scored cue, for tools/cuecheck.py
def cue(t, what): CUES.append({"t": round(t, 4), "what": what})

ev = []                        # (t, inst, pitch, dur, vel, pan, gain)
def n(t, inst, p, d, v, pan=0, g=1.0): ev.append((t, inst, p, d, v, pan, g))
plucks = []
def chord(t, ps, d, v, inst='trumpet', pan=0, g=.5):
    for p in ps: n(t, inst, p, d, v, pan, g)

BB = ['Bb', 'D', 'F']; EB = ['Eb', 'G', 'Bb']; F7 = ['F', 'A', 'C', 'Eb']; C7 = ['C', 'E', 'G', 'Bb']; GM = ['G', 'Bb', 'D']; ED = ['E', 'G', 'Bb', 'Db']
def vo(ch, o, k=3): return [f"{x}{o}" for x in ch][:k]
ROOT = {'Bb': ('Bb1', 'F2'), 'Eb': ('Eb2', 'Bb1'), 'F7': ('F2', 'C2'), 'C7': ('C2', 'G1'), 'Gm': ('G1', 'D2')}
CH = {'Bb': BB, 'Eb': EB, 'F7': F7, 'C7': C7, 'Gm': GM}

def tutti(t, ch, d, v=.9, top=None, g=1.0):
    """full band chord: trumpets, horns, trombones, tuba (+ clarinet an octave up)"""
    c = CH[ch]
    chord(t, vo(c, 4) if top is None else top, d, v, 'trumpet', -.15, .45 * g)
    chord(t, vo(c, 4), d, v * .9, 'horn', .25, .35 * g)
    chord(t, vo(c, 3), d, v * .9, 'trombone' if d > .3 else 'trombone_stac', .1, .42 * g)
    n(t, 'tuba' if d > .3 else 'tuba_stac', ROOT[ch][0], d, v, -.05, .75 * g)
    chord(t, vo(c, 5, 2), d, v * .7, 'clarinet' if d > .3 else 'clarinet_stac', .35, .25 * g)

def march_bar(t0, chs, soft=1.0, snare=True, banjo=False):
    """one bar of march accompaniment; chs = chord per half bar"""
    for h, ch in enumerate(chs):
        T = t0 + h * 2 * B
        n(T, 'tuba_stac', ROOT[ch][0] if h == 0 else ROOT[ch][1], .3, .85 * soft, -.05, .8)        # oom
        n(T, 'bass_drum', None, None, .55 * soft, 0, .55)
        for p in vo(CH[ch], 4, 3):                                                                   # pah
            n(T + B, 'horn_stac', p, .2, .7 * soft, .3, .28)
            n(T + B, 'trombone_stac', M(p) - 12, .2, .65 * soft, .15, .25)
        if banjo:
            for k in (0, 1): plucks.append((T + k * B, 'banjo', vo(CH[ch], 4, 3), .3, .55 + .2 * k, .26 * soft, -.4))
    if snare:
        for k in range(8):
            t = t0 + k * B / 2
            n(t, 'snare', 'on', None, (.42 if k % 2 == 0 else .22) * soft, .12, .45)
    n(t0, 'clash' if soft >= 1 else 'sus_cymbal', 'crash' if soft >= 1 else 'stick', None, .45 * soft, .2, .35)

# ------------------------------------------------------------------ A. ident fanfare (0 - 3.0)
t = HIT['beams_on']
n(t, 'timpani', 'Bb2', .8, .95, 0, .9); n(t, 'timpani', 'F2', .8, .8, 0, .7); n(t, 'crash', None, None, .8, 0, .7)
n(t, 'bass_drum', None, None, .9, 0, .8); cue(t, 'beams_on: timpani + crash')
t = HIT['logo_name']
tutti(t, 'Bb', .42, .95, top=['D5', 'F5', 'Bb5']); n(t, 'bass_drum', None, None, .8, 0, .7); n(t, 'clash', 'crash', None, .6, 0, .5)
cue(t, 'logo_name: brass stab')
call = [(2, 'F4', .5), (2.5, 'Bb4', .5), (3, 'D5', .5), (3.5, 'F5', .25), (3.75, 'D5', .25), (4, 'F5', 1.0)]
for b_, p, d in call:
    tt = b_ * B
    n(tt, 'trumpet', p, d * B * 2 * .95, .85, -.2, .9)
    n(tt, 'horn', M(p) - 9 if b_ < 4 else 'Bb4', d * B * 2 * .95, .7, .25, .55)
for k in range(8): n(2.0 + k * .125, 'snare', 'on', None, .2 + k * .05, .1, .4)
n(HIT['logo_iris'], 'timpani', 'F2', .5, .7, 0, .7)
chord(HIT['logo_iris'], ['A4', 'C5', 'Eb5', 'F5'], 2 * B * .95, .75, 'trumpet', 0, .35)      # F7 swells into the paper
chord(HIT['logo_iris'], ['F3', 'A3', 'Eb4'], 2 * B, .7, 'trombone', .1, .4)
n(HIT['logo_iris'], 'tuba', 'F1', 2 * B, .8, 0, .7); cue(HIT['logo_iris'], 'logo_iris: F7 swell')
# ------------------------------------------------------------------ B. the paper (3.0 - 6.0)
t = HIT['paper_fly']
n(t, 'snare', 'roll', .5, .55, 0, .5); n(t, 'timpani', 'F2', .3, .6); cue(t, 'paper_fly: snare roll')
for k, p in enumerate(['F3', 'G3', 'A3', 'Bb3']): n(t + k * B / 4, 'trombone_stac', p, .1, .8, .1, .5)
t = HIT['paper_slam']
tutti(t, 'Bb', .3, 1.0, top=['F5', 'Bb5', 'D6']); n(t, 'bass_drum', None, None, 1.0, 0, .9); n(t, 'crash', None, None, .85, 0, .7)
n(t, 'timpani', 'Bb2', .5, .95); cue(t, 'paper_slam: DA! tutti')
march_bar(2 * TL['BAR'], ['Bb', 'F7'])                         # bar 2: 4.0 - 6.0
mel = [(4.0, 'D5', .45), (4.5, 'F5', .22), (4.75, 'D5', .22), (5.0, 'Bb5', .45), (5.5, 'A5', .22), (5.75, 'F5', .22)]
for tt, p, d in mel: n(tt, 'trumpet', p, d, .85, -.2, .85); n(tt, 'clarinet', M(p) - 9, d, .6, .35, .4)
n(HIT['paper_punch'], 'crash', None, None, .65, .2, .55); cue(HIT['paper_punch'], 'paper_punch: crash')
# ------------------------------------------------------------------ C. the map (6.0 - 11.0), soft
for bar, chs in ((3, ['Bb', 'F7']), (4, ['Eb', 'F7'])):
    march_bar(bar * TL['BAR'], chs, soft=.6, snare=False, banjo=True)
    for k in range(8): n(bar * TL['BAR'] + k * B / 2, 'snare2', 'taps' if k % 2 else 'stick', None, .3, .1, .3)
mapmel = [(6.0, 'D5', .45), (6.5, 'C5', .22), (6.75, 'Bb4', .22), (7.0, 'C5', .45), (7.5, 'A4', .45),
          (8.0, 'Eb5', .45), (8.5, 'Bb4', .45), (9.0, 'C5', .45), (9.5, 'A4', .22), (9.75, 'C5', .22)]
for tt, p, d in mapmel: n(tt, 'trumpet_mute', p, d, .78, -.2, .9); n(tt + .0, 'clarinet', M(p) - 3, d, .5, .4, .28)
for k, p in (('flip_map', 'Bb6'), ('montreal', 'D7'), ('newyork', 'F7'), ('atlanta', 'Eb7'), ('stlouis', 'C7'), ('stpaul', 'D7')):
    n(HIT[k], 'glockenspiel', p, .7, .7, .25, .5); cue(HIT[k], f'{k}: glockenspiel')
n(HIT['map_title'], 'glockenspiel', 'F6', .5, .55, .25, .4); cue(HIT['map_title'], 'map_title: glockenspiel')
n(HIT['route0'], 'woodblock', None, None, .6, -.3, .45); cue(HIT['route0'], 'route0: woodblock')
t = HIT['home']
tutti(t, 'Bb', .8, .85); n(t, 'clash', 'crash', None, .6, 0, .5); n(t, 'timpani', 'Bb2', .6, .8); n(t, 'glockenspiel', 'Bb6', .9, .75, .25, .55)
cue(t, 'home: band chord')
t = HIT['map_push']                                            # rising horns + roll into the deal
for k, p in enumerate(['F3', 'Bb3', 'D4', 'F4']): n(t + k * B / 4, 'horn', p, B / 4 + .05, .8, .25, .45)
n(t, 'snare', 'roll', B, .5, 0, .45); cue(t, 'map_push: horn run')
# ------------------------------------------------------------------ D. the deal accelerates (11.0 - 13.0), E. flip-book (13.0 - 14.0)
deal_ch = ['Bb', 'Bb', 'Eb', 'C7', 'F7', 'F7']
deal_top = [['F4', 'Bb4', 'D5'], ['Bb4', 'D5', 'F5'], ['Bb4', 'Eb5', 'G5'], ['Bb4', 'E5', 'G5'], ['A4', 'C5', 'F5'], ['C5', 'Eb5', 'A5']]
for i, t in enumerate(DEALS):
    tutti(t, deal_ch[i], .2, .8 + .03 * i, top=deal_top[i], g=.85)
    n(t, 'snare', 'on', None, .75, .1, .6); n(t, 'bass_drum', None, None, .7, 0, .6); cue(t, f'deal{i}: stab')
for k in range(8):                                             # eighth-note drive under the deal
    tt = DEALS[0] + k * B / 2
    n(tt, 'snare', 'on', None, .3, .1, .35); n(tt, 'tuba_stac', ['Bb1', 'D2', 'F2', 'D2', 'Eb2', 'G2', 'F2', 'A2'][k], .2, .75, -.05, .6)
for i, t in enumerate(PAGES):                                  # sixteenths: chromatic climb, a paper flick each page
    p = ['F5', 'F#5', 'G5', 'G#5', 'A5', 'Bb5', 'B5', 'C6'][i]
    n(t, 'trumpet_stac', p, .1, .8 + .02 * i, -.15, .6); n(t, 'clarinet_stac', M(p) - 12, .1, .7, .35, .35)
    n(t, 'snare', 'on', None, .35 + .05 * i, .1, .45); n(t, 'tuba_stac', 'F2' if i % 2 == 0 else 'C2', .1, .6, -.05, .45)
    cue(t, f'page{i}: trumpet sixteenth')
n(HIT['dive'], 'crash', None, None, .55, .2, .45); cue(HIT['dive'], 'dive: crash')
t = HIT['stop']                                                # one stab, then the band is gone
tutti(t, 'F7', .14, 1.0, top=['A4', 'Eb5', 'F5', 'C6']); n(t, 'bass_drum', None, None, .9, 0, .8); n(t, 'timpani', 'F2', .2, .9)
cue(t, 'stop: stab, dead stop')
# ------------------------------------------------------------------ F. the return (15.0 - end)
t = HIT['land_cut']                                            # the most important sound in the film
tutti(t, 'Bb', 1.9, 1.0, top=['D5', 'F5', 'Bb5', 'D6'], g=1.15)
n(t, 'crash', None, None, 1.0, 0, .9); n(t, 'bass_drum', None, None, 1.0, 0, 1.0); n(t, 'timpani', 'Bb2', 1.0, 1.0); n(t, 'timpani', 'F2', 1.0, .9)
n(t, 'glockenspiel', 'Bb6', 1.2, .8, .25, .6); n(t, 'piccolo', 'Bb6', 1.9, .7, .3, .3)
cue(t, 'land_cut: full band B-flat (first sound after the silence)')
t = HIT['roll_cut']                                            # broad half-time tune (deceleration)
tutti(t, 'Eb', .95, .9, top=['G4', 'Bb4', 'Eb5', 'G5']); n(t, 'bass_drum', None, None, .85, 0, .8); n(t, 'clash', 'crash', None, .55, 0, .45)
n(t + 2 * B, 'tuba', 'Bb1', .5, .8); chord(t + 2 * B, ['F4', 'Bb4', 'D5', 'F5'], .45, .8, 'trumpet', -.1, .4)
n(t + 3 * B, 'trumpet', 'Eb5', .25, .8, -.1, .6); n(t + 3.5 * B, 'trumpet', 'D5', .25, .8, -.1, .6)
cue(t, 'roll_cut: Eb chord')
t = HIT['freeze']                                              # freeze: timpani + choked cymbal, horns hold the dominant
n(t, 'timpani', 'F2', .6, 1.0); n(t, 'timpani', 'C3', .6, .8); n(t, 'clash', 'short', None, .85, 0, .7); n(t, 'bass_drum', None, None, .9, 0, .8)
chord(t, ['C3', 'F3', 'A3', 'Eb4'], 3 * B, .6, 'horn', .2, .45); n(t, 'tuba', 'F1', 3 * B, .55, 0, .5)
cue(t, 'freeze: timpani + choked cymbal')
t = HIT['ring_done']
n(t, 'glockenspiel', 'F6', .8, .75, .25, .55); n(t, 'glockenspiel', 'Bb6', .8, .7, .25, .45)
n(t, 'trombone', 'F3', .4, .8, .1, .5); n(t + .02, 'trombone', 'Bb3', .4, .8, .1, .4); cue(t, 'ring_done: glockenspiel')
t = HIT['da']
tutti(t, 'F7', .18, .95, top=['A4', 'C5', 'Eb5', 'F5']); n(t, 'snare', 'on', None, .8, .1, .6); n(t, 'bass_drum', None, None, .8, 0, .7)
cue(t, 'da')
t = HIT['DA']
tutti(t, 'Bb', .75, 1.0, top=['D5', 'F5', 'Bb5', 'D6'], g=1.1); n(t, 'crash', None, None, .95, 0, .85)
n(t, 'bass_drum', None, None, 1.0, 0, .95); n(t, 'timpani', 'Bb2', .9, 1.0); n(t, 'piccolo', 'D7', .6, .7, .3, .3)
cue(t, 'DA!')

music = S.render(ev, dur=N / SR)
for t, pre, ps, d, v, g, pan in plucks:
    add(music, PL.strum(pre, ps, d, vel=v, spread=.012), t, g, pan)
# the band, as a 1929 optical track: band-limited 95-7500 Hz, low shelf, light saturation
for c in range(2):
    x = bp(music[:, c], 95, 7500, 2)
    x = x + .25 * lp(x, 220)
    music[:, c] = np.tanh(x * 1.6) / 1.6
music = S.room(music, size=.3, mix=.12)
# dead stop: nothing of the band between the stop stab and the return (stab rings 0.2 s)
tt = t_(N / SR)
gate = np.ones(N, np.float32)
a, b_ = int((HIT['stop'] + .2) * SR), int((HIT['land_cut'] - .004) * SR)
gate[a:b_] = 0; r = int(.06 * SR); gate[a - r:a] = np.linspace(1, 0, r)
music *= gate[:, None]

# ------------------------------------------------------------------ foley, every visible action from window.EV
fx = np.zeros((N, 2), np.float32)
def arc(v=1.0):
    d = .5; x = hp(noise(d), 2000) * env_exp(d, .006) + bp(noise(d), 3000, 9000) * env_exp(d, .12) * .25
    return norm(x) * v
def long_whoosh(d, v=1.0):
    tq = t_(d); out = np.zeros(len(tq)); nz = noise(d)
    for i in range(0, len(tq), 480):
        f = 400 + 2600 * (i / len(tq)) ** 1.6; hi = min(len(tq), i + 480)
        out[i:hi] = bp(nz[max(0, i - 2000):hi], f * .7, f * 1.4)[-(hi - i):]
    flutter = .55 + .45 * np.abs(np.sin(2 * np.pi * np.cumsum(3 + 9 * tq / d) / SR))
    return norm(out * flutter * (tq / d) ** 1.4) * v
def paper_slap(v=1.0): d = .25; return norm(bp(noise(d), 500, 6000) * env_exp(d, .03)) * v
def flap(v=1.0): d = .3; tq = t_(d); return norm(bp(noise(d), 800, 5000) * (np.abs(np.sin(2 * np.pi * 14 * tq)) ** 2) * env_exp(d, .1)) * v
def flick(v=1.0): d = .07; return norm(bp(noise(d), 1500, 7000) * env_exp(d, .015)) * v
def shutter(v=1.0):
    a_ = click(1.4, 1); out = np.zeros(int(.09 * SR)); out[:len(a_)] += a_[:len(out)]; b2 = click(1.1, .7)
    j = int(.045 * SR); out[j:j + len(b2)] += b2[:len(out) - j]; return norm(out) * v
def tele(v=1.0):   # one telegraph-sounder click (brass armature on its stop)
    c = click(2.0, 1); d = np.zeros(int(.05 * SR)); d[:len(c)] += c[:len(d)]; return norm(bp(d, 900, 6000)) * v
def pencil_sq(d, v=1.0):   # grease pencil on celluloid: a scratchy squeak
    tq = t_(d); f = 1700 + 500 * np.sin(2 * np.pi * 7 * tq)
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * (.4 + .6 * (np.sin(2 * np.pi * 23 * tq) > 0))
    x = bp(noise(d), 1500, 6000) * .6 + tone * .25
    return norm(x * np.minimum(1, np.minimum(tq / .02, (d - tq) / .03))) * v
def engine(d, f0=48, v=1.0, rise=0.0):
    """a 1929 radial engine: firing pulses + propeller wash"""
    tq = t_(d); f = f0 * (1 + rise * tq / d)
    ph = 2 * np.pi * np.cumsum(f) / SR
    pulse = (np.maximum(0, np.sin(ph)) ** 6) * (.8 + .2 * np.sin(ph * .5))
    x = lp(pulse - pulse.mean(), 900) * 1.2 + bp(noise(d), 200, 2500) * (.35 + .25 * np.sin(2 * np.pi * f * 2 / 3 * tq / 1))
    return norm(x) * v
def crowd(d, v=1.0):
    x = bp(noise(d), 300, 2500) * (.7 + .3 * np.sin(2 * np.pi * .7 * t_(d))); return norm(lp(x, 2600)) * v

def evt(ty): return [e for e in EV if e["type"] == ty]
E = {e["type"]: e["t"] for e in EV if "i" not in e}
add(fx, arc(.9), E['beams_on'], .9); cue(E['beams_on'], 'fx: carbon arc snap')
hum = lp(noise(2.6), 140) * .5 + np.sin(2 * np.pi * 100 * t_(2.6)) * .08
add(fx, norm(hum) * np.minimum(1, t_(2.6) / .05) * np.minimum(1, (2.6 - t_(2.6)) / .3), E['beams_on'], .12)   # searchlight hum
add(fx, whoosh(.5, .7), E['logo_iris'], .25)
add(fx, long_whoosh(.5, .9), E['paper_fly'], .75); cue(E['paper_fly'], 'fx: spinning whoosh')
add(fx, thump(1, 80), E['paper_slam'], .85); add(fx, paper_slap(.9), E['paper_slam'], .8); cue(E['paper_slam'], 'fx: thump + paper slap')
add(fx, whoosh(.18, .6), E['paper_punch'] - .09, .4); add(fx, paper_slap(.4), E['paper_punch'], .25)
add(fx, whoosh(.4, .7), E['flip_map'] - .12, .45, -.2); add(fx, flap(.8), E['flip_map'] + .02, .5, .2); cue(E['flip_map'], 'fx: flip flap')
for e in evt('arrive'):                                          # a telegraph click as the line reaches each stop
    add(fx, tele(.9 if e.get("key") else .6), e["t"], .45 if e.get("key") else .3, -.3 + .6 * (e["i"] / 32))
cue(E['route0'], 'fx: telegraph line starts')
add(fx, whoosh(.5, .8), E['map_push'], .55); cue(E['map_push'], 'fx: map push whoosh')
for i, t in enumerate(DEALS): add(fx, shutter(.9), t, .55, (i % 3 - 1) * .3); cue(t, f'fx: shutter {i}')
add(fx, whoosh(.25, .7), E['dive'] - .1, .45)
for e in evt('page'): add(fx, flick(.9), e["t"], .5, .15); cue(e["t"], f'fx: page flick {e["i"]}')
# J-cut: a far engine creeps in under the silence, then the plane comes over at the cut
eng1 = engine(E['roll_cut'] - E['stop'] - .3, 44, 1, .25)
env1 = np.clip((t_(len(eng1) / SR) - (.45)) / (len(eng1) / SR - .45), 0, 1) ** 1.6
add(fx, eng1 * env1, E['stop'] + .3, .32, .35)
eng2 = engine(E['freeze'] - E['roll_cut'] + .02, 52, 1, -.12)
add(fx, eng2 * np.minimum(1, t_(len(eng2) / SR) / .05), E['roll_cut'], .38, -.1); cue(E['roll_cut'], 'fx: engine close')
add(fx, lp(noise(.9), 180) * env_exp(.9, .3) * .5, E['roll_cut'], .5)                 # wheels on turf
cr = crowd(DUR - E['land_cut'] + .3); add(fx, cr * np.minimum(1, t_(len(cr) / SR) / .4), E['land_cut'], .09)
add(fx, thump(1, 70), E['freeze'], .8); add(fx, shutter(1), E['freeze'], .5); cue(E['freeze'], 'fx: freeze thump + shutter')
add(fx, pencil_sq(.4, .8), E['freeze'] + .04, .38, -.1); cue(E['freeze'] + .04, 'fx: grease pencil ring')
add(fx, pencil_sq(.16, .7), E['ring_done'] - .05, .32, .2)
add(fx, thump(.7, 75), E['da'], .5); add(fx, thump(.9, 70), E['DA'], .7)
# projector bed: motor hum + 24 Hz claw clatter + optical hiss, first to last frame
claw = (np.abs(np.sin(np.pi * 24 * tt)) ** 18)
bed = bp(noise(N / SR), 1500, 5000) * claw * .5 + hp(lp(noise(N / SR), 260), 110) * .12 + hp(noise(N / SR), 5000) * .08
bed = norm(bed) * .055 * np.minimum(1, tt / .05)
fx[:, 0] += bed; fx[:, 1] += bed * .95

mix = music * 1.1 + fx * .9
fo = int(.25 * SR); end = int(DUR * SR)
mix[end - fo:end] *= np.linspace(1, .0, fo)[:, None] ** .5
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
(HERE / "out").mkdir(exist_ok=True)
sf.write(HERE / "out" / "mix.wav", mix[:end], SR)
sf.write(HERE / "out" / "stem_music.wav", music[:end], SR); sf.write(HERE / "out" / "stem_fx.wav", fx[:end], SR)
(HERE / "out" / "cues.json").write_text(json.dumps(sorted(CUES, key=lambda c: c["t"]), ensure_ascii=False, indent=1))
def db(x): return round(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9), 1)
sil = mix[int((E['stop'] + .3) * SR):int((E['land_cut'] - .05) * SR)]
print("mix rms", db(mix[:end]), "| silence section rms", db(sil), "| land_cut 0.3 s rms", db(mix[int(E['land_cut'] * SR):int((E['land_cut'] + .3) * SR)]))
