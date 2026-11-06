"""一天 · ONE DAY — original score + foley + mix, picture-locked by data.
Reads timeline.json (exported from timeline.js) and events.json (window.EV from the page).
Writes out/stems/*.wav, out/mix.wav, out/onsets.json, out/report.txt.
Score: electronic percussion spine (numpy kit + sampled claps / woodblock / cowbell / shaker / toms / gran cassa / suspended cymbal / timpani)
+ kalimba & music box (pluck.py) + marimba & glockenspiel (samples) + synth bass + detuned-saw stabs + riser. 120 BPM throughout.
"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, compress, lp, hp, bp, noise, t_, env_exp, norm, whoosh, click, clack, thump, step

S.seed(21)
REST_DRIVE = float(os.environ.get('REST_DRIVE', 0.9)); SLAM_G = float(os.environ.get('SLAM_G', 1.0)); SLAM_DRIVE = float(os.environ.get('SLAM_DRIVE', 3.5)); SLAM_SHELF = float(os.environ.get('SLAM_SHELF', 0.85))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
B = TL['BEAT']; NIGHT = TL['NIGHT']; DUR = EVJ['dur']
assert abs(DUR - TL['DUR']) < 1e-9, 'page and timeline disagree on DUR'
bt = lambda b: round(b * B, 6)
NS = int(round(DUR * SR))
def bus(): return np.zeros((NS, 2), np.float32)
drums, bass_b, harm, accent, foley, amb = bus(), bus(), bus(), bus(), bus(), bus()
ONSETS = []   # (t, what) of every scheduled card accent, for the cue check

def put(buf, x, t, g=1.0, pan=0.0):
    add(buf, np.asarray(x, np.float32), t, g, pan)
def midi(n): return S.midi(n)
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def fade_tail(x, ms=8):
    n = int(ms / 1000 * SR); x = x.copy(); x[-n:] *= np.linspace(1, 0, n); return x

# ───────── synth kit ─────────
def kick(v=1.0, d=0.42):
    v *= 0.48
    tt = t_(d); f = 46 + 120 * np.exp(-tt / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, 0.15)
    cl = hp(noise(d), 1800) * env_exp(d, 0.003) * 0.35
    x = body + cl + 0.25 * np.tanh(3 * body)          # a little drive → 2nd/3rd harmonics for small speakers
    return norm(x) * v
def snare(v=1.0):
    d = 0.22; tt = t_(d)
    tone = np.sin(2 * np.pi * 186 * tt) * env_exp(d, 0.05) * 0.6 + np.sin(2 * np.pi * 330 * tt) * env_exp(d, 0.03) * 0.3
    nz = bp(noise(d), 1500, 8000) * env_exp(d, 0.07)
    return norm(tone + nz) * v
def hat(v=1.0, open_=False):
    d = 0.22 if open_ else 0.05
    return norm(hp(noise(d), 7000) * env_exp(d, 0.09 if open_ else 0.014)) * v
def saw_voice(f, d, cut=2400, det=(-0.08, 0, 0.08)):
    tt = t_(d); x = np.zeros_like(tt)
    for c in det:
        ff = f * 2 ** (c / 12); x += 2 * ((tt * ff + 0.37 * c) % 1) - 1
    return lp(x / len(det), cut, 2)
def stab(ms, d=0.35, v=0.5, cut=2600, rel=0.08):
    x = sum(saw_voice(hz(m), d, cut) for m in ms) / len(ms)
    tt = t_(d); e = np.minimum(1, tt / 0.004) * np.exp(-tt / (d * 0.55)); e[-int(rel * SR):] *= np.linspace(1, 0, int(rel * SR))
    return x * e * v
def synth_bass(m, d, v=0.8):
    f = hz(m); tt = t_(d)
    x = np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * 2 * f * tt) + 0.28 * np.sin(2 * np.pi * 3 * f * tt) + 0.12 * (2 * ((tt * f) % 1) - 1)
    e = np.minimum(1, tt / 0.004) * (0.55 + 0.45 * np.exp(-tt / 0.08)); e[-int(0.02 * SR):] *= np.linspace(1, 0, int(0.02 * SR))
    return lp(x, 900) * e * v
def riser(d, v=0.6):
    n = noise(d); tt = t_(d); out = np.zeros_like(n)
    for i in range(0, len(n), 480):
        hi = min(len(n), i + 480); f = 400 * (14 ** (i / len(n)))
        out[i:hi] = bp(n[max(0, i - 2000):hi], f * 0.8, min(f * 1.25, 20000))[-(hi - i):]
    return norm(out) * (tt / d) ** 2 * v
def sub_boom(v=1.0, d=1.8):
    tt = t_(d); f = 36.7 + 30 * np.exp(-tt / 0.06)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, 0.38)
    return norm(x + 0.3 * np.tanh(4 * x)) * v

# ───────── score ─────────
CH = [  # (beat0, beat1, bass root midi, pad/stab chord)
    (0, 12, 38, [62, 66, 69, 73, 76]),      # Dmaj9
    (12, 14, 43, [55, 59, 62, 66]),         # Gmaj7
    (14, 16, 47, [59, 62, 66, 69, 73]),     # Bm9
    (16, 18, 43, [55, 59, 62, 66, 69]),     # Gmaj9
    (18, 20, 45, [57, 62, 64, 69]),         # Asus
    (20, 26, 40, [52, 55, 59, 62, 66]),     # Em9
    (26, 28, 45, [57, 61, 64, 67, 71]),     # A9
]
def chord_at(b):
    for c in CH:
        if c[0] <= b < c[1]: return c
    return CH[-1]

# drums by section
for i in range(0, 28 * 4):           # 16th grid up to the stop
    b = i / 4; bb = b % 4
    if b < 12:                        # morning: kick 1 & 3, clap 2 & 4, light 8th hats (16ths in bar 3)
        if bb in (0, 2): put(drums, kick(0.85), bt(b))
        if bb in (1, 3): put(drums, snare(0.45), bt(b), 1, 0.05); put(drums, S.hit('claps', 'group', 0.55), bt(b), 0.55, -0.1)
        if b % 0.5 == 0: put(drums, hat(0.35 if b % 1 else 0.22), bt(b), 1, 0.3)
        if b >= 8 and b % 0.5: put(drums, hat(0.2), bt(b), 1, 0.35)
        if b >= 8 and b % 1 == 0.5: put(drums, S.hit('shaker', 'down', 0.4), bt(b), 0.5, -0.35)
    elif b < 20:                      # day: four on the floor, snare 2 & 4, 16th hats, shaker
        if bb % 1 == 0: put(drums, kick(0.95), bt(b))
        if bb in (1, 3): put(drums, snare(0.6), bt(b)); put(drums, S.hit('claps', 'group', 0.6), bt(b), 0.5, -0.1)
        put(drums, hat(0.32 if b % 0.5 else 0.2, open_=(b % 1 == 0.5)), bt(b), 0.9, 0.3)
        if b % 0.5 == 0.25: put(drums, S.hit('shaker', 'up', 0.35), bt(b), 0.45, -0.35)
    elif b < 24:                      # evening: kick every beat + 8th pushes, toms fill in the last beat
        if b % 0.5 == 0: put(drums, kick(0.95 if b % 1 == 0 else 0.6), bt(b))
        if bb in (1, 3): put(drums, snare(0.65), bt(b)); put(drums, S.hit('claps', 'group', 0.65), bt(b), 0.55)
        put(drums, hat(0.3), bt(b), 0.9, 0.3)
        if b >= 23: put(drums, S.hit('toms', 'high' if b < 23.5 else 'low', 0.75), bt(b), 0.75, 0.3 - (b - 23))
    else:                             # ½-beat run: kick 8ths, snare 16ths → 32nds (below), riser
        if b % 0.5 == 0: put(drums, kick(0.85), bt(b))
        if b < 26: put(drums, snare(0.35 + 0.15 * (b - 24)), bt(b), 0.9, 0.08)
for k in range(32):                   # 32nd-note snare roll from b26 to b28, crescendo
    b = 26 + k / 16; put(drums, snare(0.3 + 0.4 * k / 31), bt(b), 0.8, 0.05 * np.sin(k))
put(harm, riser(bt(28) - bt(24), 0.38), bt(24))
# day + evening drum bus sits 2 dB under the morning, so the slam is the loudest moment by a clear margin
_tt = np.arange(NS) / SR
drums *= np.interp(_tt, [0, 5.9, 5.99, DUR], [1, 1, 10 ** (-2 / 20), 10 ** (-2 / 20)]).astype(np.float32)[:, None]

# bass: 8ths from b12 to the stop
for i in range(12 * 2, 28 * 2):
    b = i / 2; root = chord_at(b)[2]
    m = root + (12 if (i % 4 == 3) else 0)
    put(bass_b, synth_bass(m, 0.22, 0.75 if b % 1 == 0 else 0.55), bt(b))
# stabs on chapter onsets + pads
for b, d, v in [(0, 1.8, 0.25), (12, 0.4, 0.4), (14, 0.9, 0.45), (16, 0.4, 0.35), (18, 0.4, 0.35), (20, 0.9, 0.5), (22, 0.4, 0.35), (24, 0.25, 0.45), (25, 0.25, 0.45), (26, 0.25, 0.5), (27, 0.25, 0.55)]:
    put(harm, stab(chord_at(b)[3], d, v), bt(b), 1.0, 0.0)
# kalimba: the stretch (b2) and an answer (b3)
for b, n in [(2, 'D5'), (2.25, 'F#5'), (2.5, 'A5'), (3, 'C#6'), (3.5, 'E6')]:
    put(harm, P.pluck('kalimba', n, 1.2, 0.7), bt(b), 0.7, -0.25)
# marimba melody, 8ths, b4 → b20
MEL = {4: ['A4', None, 'F#4', 'A4', 'B4', None, 'D5', None],
       8: ['A4', 'B4', 'D5', 'E5', 'F#5', None, 'E5', 'D5'],
       12: ['D5', None, 'B4', 'D5', 'F#5', None, 'D5', 'B4'],
       16: ['B4', 'D5', 'E5', 'F#5', 'A5', None, 'F#5', 'E5']}
for b0, notes in MEL.items():
    for j, n in enumerate(notes):
        if n: put(harm, S.note('marimba', n, 0.4, 0.62 if j % 2 == 0 else 0.5), bt(b0 + j * 0.5), 0.75, 0.2)
# glockenspiel: one note per 1-beat card, then one per ½-beat card, climbing
for b, n in zip([20, 21, 22, 23], ['B5', 'D6', 'E6', 'F#6']): put(harm, S.note('glockenspiel', n, 0.6, 0.6), bt(b), 0.55, 0.25)
for k, n in enumerate(['E6', 'F#6', 'A6', 'B6', 'D7', 'E7', 'F#7', 'A7']): put(harm, S.note('glockenspiel', n, 0.3, 0.55 + 0.04 * k), bt(24 + k / 2), 0.5, 0.25 - 0.06 * k)

# ───────── per-card accents (every shot onset gets a hit, by chapter) ─────────
for e in EVJ['ev']:
    if e['type'] != 'cut': continue
    t, ch, mode = e['t'], e['ch'], e['mode']
    if ch == 'morning':
        x = S.hit('woodblock', 'a', 0.85); g = 0.7
    elif ch == 'noon':
        x = S.hit('cowbell', None, 0.7); g = 0.38
    elif ch == 'dusk' and mode != 'flash':
        x = S.hit('claps', 'solo', 0.9); g = 0.6
    elif mode == 'flash':
        x = S.hit('shaker', 'slap', 0.8); g = 0.55
    else:
        x = None
    if x is not None:
        x = fade_tail(x[:int(e['beats'] * B * SR * 0.95)], 12)          # no tail into the next card's accent
        on = int(np.argmax(np.abs(x) > np.abs(x).max() * 0.25)) / SR     # sample's own attack offset → placed so the transient lands on the beat
        put(accent, x, t - on, g, 0.15); ONSETS.append((t, f"card {e['card']:02d} accent"))

# ───────── the slam (b32): the most important sound in the film ─────────
ts = bt(NIGHT['slam'])
slamb = bus()   # the slam has its own bus: dense, saturated, the only thing allowed up to the ceiling
put(slamb, S.hit('gran_cassa', 'hit', 1.0), ts, 1.25 * 1.26); ONSETS.append((ts, 'slam gran cassa'))   # +2 dB
put(slamb, sub_boom(1.0), ts, 0.65 * 1.26)                                                               # +2 dB
put(slamb, kick(1.0, 0.6), ts, 0.8)
put(slamb, S.hit('timpani', 'drum3', 1.0), ts, 0.9)
put(slamb, S.hit('sus_cymbal', 'hit', 0.95), ts, 0.8, 0.2)
put(slamb, S.hit('toms', 'low_mallet', 1.0), ts, 0.6, -0.2)
def power(ms, d, v):   # low D power chord: detuned saws, driven — body in the 150 Hz–3 kHz band the ear (and LUFS) hears
    x = sum(saw_voice(hz(m), d, 3200, det=(-0.12, 0, 0.12)) for m in ms) / len(ms)
    tt = t_(d); e = np.minimum(1, tt / 0.002) * (0.35 + 0.65 * np.exp(-tt / 0.18)) * np.exp(-tt / (d * 0.45))
    e[-int(0.3 * SR):] *= np.linspace(1, 0, int(0.3 * SR))
    return np.tanh(2.2 * x * e) * v
put(slamb, power([38, 45, 50, 57, 62], 1.6, 0.9), ts, 0.55, -0.12)
put(slamb, power([50, 57, 62, 66], 1.6, 0.9), ts, 0.45, 0.12)
put(harm, stab([50, 57, 62, 66, 69], 2.4, 0.5, cut=1800, rel=1.2), ts)
put(harm, S.note('glockenspiel', 'D7', 2.5, 0.7), ts, 0.45, 0.3)
put(harm, S.note('vibraphone_bowed', 'D4', 2.4, 0.45, attack=0.6), bt(32.5), 0.45, -0.2)
put(harm, S.note('vibraphone_bowed', 'A4', 2.0, 0.4, attack=0.6), bt(33), 0.35, 0.2)
for b, n in [(33, 'F#5'), (34, 'A5'), (35, 'D6')]:   # music-box lullaby
    put(harm, P.pluck('music_box', n, 2.0, 0.55), bt(b), 0.55, 0.15)

# ───────── foley from window.EV ─────────
def sine(f, d, tau): return np.sin(2 * np.pi * f * t_(d)) * env_exp(d, tau)
def fx(e):
    k = e['type']
    if k == 'alarm':
        out = np.zeros(int(0.5 * SR))
        for i in range(4):
            bpp = (np.sign(np.sin(2 * np.pi * 2600 * t_(0.055))) * 0.5) * np.minimum(1, t_(0.055) / 0.002)
            s0 = int(i * 0.125 * SR); out[s0:s0 + len(bpp)] += bpp; s1 = s0 + int(0.0625 * SR); out[s1:s1 + len(bpp)] += bpp * 0.8
        return lp(out, 6000), 0.0
    if k == 'cloth': return norm(bp(noise(0.3), 500, 3000) * np.sin(np.pi * t_(0.3) / 0.3) ** 2), -0.1
    if k == 'stretch': return whoosh(0.3), 0.0
    if k == 'scrub': return norm(bp(noise(0.09), 2500, 7000) * np.sin(np.pi * t_(0.09) / 0.09)), 0.1
    if k == 'rinse':
        x = lp(noise(0.4), 1500) * 0.3 * env_exp(0.4, 0.15)
        for j in range(6): x[int(j * 0.05 * SR):int(j * 0.05 * SR) + int(0.03 * SR)] += sine(700 + 160 * j, 0.03, 0.01)
        return norm(x), 0.15
    if k == 'step': return norm(step(1.0) * 0.6 + thump(0.6, 90)[:int(0.05 * SR)]), 0.0
    if k == 'zoom':   # rises into the cut (scheduled 0.25 s early)
        d = 0.25; return norm(bp(noise(d), 800, 9000) * (t_(d) / d) ** 2), 0.0
    if k == 'chime': return norm(np.concatenate([sine(1319, 0.25, 0.25), sine(1047, 0.6, 0.35)])), 0.2
    if k == 'rail': return clack(0.55, 1.0), 0.0
    if k == 'key': return click(1.5, 1.0), 0.25
    if k == 'enter': return click(0.9, 1.0), 0.25
    if k == 'tap': return norm(click(0.7) + thump(0.4, 160)[:int(0.06 * SR)] * 0.6), 0.3
    if k == 'raise': return whoosh(0.2) * 0.6, -0.3
    if k == 'chop': return click(2.2, 1.0), 0.2
    if k == 'clink': return norm(sine(2900, 0.25, 0.06) + sine(4170, 0.25, 0.04) * 0.6 + sine(5300, 0.25, 0.02) * 0.3), 0.2
    if k == 'bell':
        tt = t_(0.7); x = (np.sin(2 * np.pi * 3150 * tt) + 0.6 * np.sin(2 * np.pi * 4420 * tt)) * env_exp(0.7, 0.2) * (1 + 0.4 * np.sin(2 * np.pi * 22 * tt))
        return norm(x), 0.2
    if k == 'beep': tt = t_(0.11); return np.sign(np.sin(2 * np.pi * 1850 * tt)) * 0.4 * np.minimum(1, (0.11 - tt) / 0.005), 0.2
    if k == 'sizzle':
        d = 0.5; x = hp(noise(d), 3000) * (np.random.default_rng(3).random(int(round(d * SR))) > 0.97) * 2 + hp(noise(d), 5000) * 0.25
        return norm(x * np.minimum(1, t_(d) / 0.01) * np.minimum(1, (d - t_(d)) / 0.1)), 0.2
    if k == 'toss':
        x = whoosh(0.18) * 0.7; c = clack(0.7); x[:len(c)] += c * 0.8; return x, 0.2
    if k == 'splash': return norm(bp(noise(0.3), 400, 5000) * env_exp(0.3, 0.08)), 0.2
    if k == 'spray': return norm(hp(noise(0.3), 4000) * np.minimum(1, t_(0.3) / 0.01) * np.minimum(1, (0.3 - t_(0.3)) / 0.04)), 0.0
    if k == 'whir':
        tt = t_(0.28); x = (2 * ((tt * 233) % 1) - 1) * 0.2 + bp(noise(0.28), 800, 4000) * 0.5
        return norm(x * np.minimum(1, tt / 0.01) * np.minimum(1, (0.28 - tt) / 0.04)), 0.0
    if k == 'hanger': return clack(1.6, 1.0), 0.1
    if k == 'pour': return norm(bp(noise(0.28), 600, 2500) * np.minimum(1, t_(0.28) / 0.01) * np.minimum(1, (0.28 - t_(0.28)) / 0.05)), 0.2
    if k == 'gulp': tt = t_(0.1); f = 320 - 1500 * tt; return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(0.1, 0.04), 0.0
    if k == 'tapglass': return click(2.6, 1.0), 0.1
    if k == 'page': return norm(bp(noise(0.16), 2000, 9000) * np.sin(np.pi * t_(0.16) / 0.16) ** 2), 0.1
    if k == 'tick': return norm(hp(noise(0.012), 3000) * env_exp(0.012, 0.0015) + sine(3400, 0.012, 0.002) * 0.6) * 0.9, 0.35
    if k == 'tock': return norm(hp(noise(0.02), 1200) * env_exp(0.02, 0.003) + sine(1700, 0.02, 0.004) * 0.6), 0.35
    if k == 'bookclose': return norm(thump(0.5, 140)[:int(0.12 * SR)] + bp(noise(0.12), 1500, 6000) * env_exp(0.12, 0.02) * 0.5), 0.0
    if k == 'whoosh': return whoosh(e.get('dur', 0.34)), 0.0
    if k == 'swipe': return whoosh(0.25) * 0.8, 0.0
    if k == 'rowstop': return norm(S.hit('woodblock', 'c', 0.45)), (-0.5 + 0.2 * e.get('row', 0))
    if k == 'hudout':
        d = e.get('dur', 0.75); out = np.zeros(int(d * SR) + 2000)
        for j in range(20):
            c = sine(4200 - 90 * j, 0.01, 0.002) * 0.5; s0 = int(j * 0.03 * SR); out[s0:s0 + len(c)] += c
        return out, 0.4
    return None, 0
LEAD = {'zoom': 0.25, 'whoosh': 0.17, 'swipe': 0.125}   # sounds centred on / rising into the cut
for e in EVJ['ev']:
    if e['type'] in ('cut', 'slam'): continue
    x, pan = fx(e)
    if x is None: print('no foley for', e['type']); continue
    put(foley, x, e['t'] - LEAD.get(e['type'], 0.0), e.get('gain', 0.7), pan)

# ───────── ambience beds ─────────
rng = np.random.default_rng(5)
def bed(t0, t1, kind, g):
    d = t1 - t0; tt = t_(d); n = len(tt)
    if kind == 'birds':
        x = np.zeros(n)
        for j in range(9):
            s0 = int(rng.random() * (n - 0.2 * SR)); cd = 0.08 + 0.05 * rng.random(); ct = t_(cd)
            f = 3200 + 1600 * rng.random() + 2500 * ct / cd * (1 if j % 2 else -0.5)
            x[s0:s0 + len(ct)] += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * ct / cd) ** 2
        x += lp(noise(d), 500) * 0.15
    elif kind == 'city': x = lp(noise(d), 260) * 0.8 + bp(noise(d), 600, 1800) * 0.1
    elif kind == 'warm': x = lp(noise(d), 700) * 0.6
    elif kind == 'crickets':
        x = np.zeros(n); ch = np.sin(2 * np.pi * 4300 * tt) * (np.sin(2 * np.pi * 28 * tt) > 0.3)
        x += ch * ((tt % 0.9) < 0.35) * 0.35 + lp(noise(d), 300) * 0.25
    e = np.minimum(1, tt / 0.15) * np.minimum(1, (d - tt) / 0.15)
    put(amb, norm(x) * e, t0, g, 0.0)
bed(0, bt(12), 'birds', 0.12); bed(bt(11.5), bt(20.2), 'city', 0.14); bed(bt(19.8), bt(28), 'warm', 0.1)
bed(bt(28), bt(31.5), 'crickets', 0.025); bed(bt(32.2), DUR, 'crickets', 0.03)

# ───────── gate: everything musical stops dead on b28 and comes back on the slam ─────────
def gate(buf, a, b_, fade=0.004):
    i0, i1, nf = int(round(a * SR)), int(round(b_ * SR)), int(fade * SR)
    buf[i0:i1] = 0; buf[max(0, i0 - nf):i0] *= np.linspace(1, 0, min(nf, i0))[:, None]
for bb in (drums, bass_b, harm): gate(bb, bt(28), bt(32))
gate(amb, bt(28) - 0.0, bt(28) + 0.01)                 # the stop also stops the evening bed
gate(amb, bt(NIGHT['hush']), bt(NIGHT['slam']))       # half a beat of true silence
gate(foley, bt(NIGHT['hush']), bt(NIGHT['slam']))           # the last tock is on b31.25 and long gone by b31.5

# ───────── mix ─────────
harm = S.room(harm, size=0.35, mix=0.16)
gate(harm, bt(28), bt(32))
music = drums * 0.9 + bass_b * 0.45 + harm * 2.2
def shelf(x, a, f=110):   # low shelf cut: keeps 25–120 Hz about 3 dB under the mids (TECHNIQUE §5)
    y = x.copy()
    for c in range(2): y[:, c] = x[:, c] - a * lp(x[:, c], f, 2)
    return y
music = shelf(music, 0.72); accent = shelf(accent, 0.55)
for c in range(2): music[:, c] = compress(music[:, c], thr=0.35, ratio=2.0, att=0.006, rel=0.12)
rest = music + accent * 1.0 + foley * 0.9 + amb * 1.0
REST_CEIL = 0.62                                  # everything but the slam peaks ≥ 3.7 dB under it
for c in range(2): rest[:, c] = limit(rest[:, c] * REST_DRIVE, REST_CEIL)
slamb = shelf(slamb, SLAM_SHELF)
slamb = np.tanh(SLAM_DRIVE * slamb) / np.tanh(SLAM_DRIVE)      # parallel-free soft clip: lower crest factor, louder hit at the same peak
mixb = rest + slamb * SLAM_G
for c in range(2): mixb[:, c] = limit(mixb[:, c], 0.95)
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
for name, x in [('drums', drums), ('bass', bass_b), ('harm', harm), ('accent', accent), ('slam', slamb), ('foley', foley), ('amb', amb)]:
    sf.write(os.path.join(HERE, 'out', 'stems', name + '.wav'), x, SR, subtype='FLOAT')
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mixb.astype(np.float32), SR, subtype='FLOAT')

# ───────── report: measured onsets of the accents, band balance ─────────
acc = np.abs(accent + slamb).max(axis=1)
rep, offs = [], []
for t, what in ONSETS:
    i0, i1 = max(0, int((t - 0.03) * SR)), int((t + 0.06) * SR)
    w = acc[i0:i1]; pk = w.max(); j = int(np.argmax(w > pk * 0.25))
    dt = (i0 + j) / SR - t; offs.append(dt * 1000); rep.append(f'{t:8.3f}s  {what:24s} onset {dt * 1000:+6.2f} ms')
def band(x, lo, hi): return 10 * np.log10(np.mean(bp(x.mean(axis=1), lo, hi) ** 2) + 1e-12)
lo, mid = band(mixb, 25, 120), band(mixb, 200, 4000)
quiet = np.abs(mixb[int(bt(NIGHT['hush']) * SR):int(bt(NIGHT['slam']) * SR)]).max()
txt = '\n'.join(rep) + f'\n\naccents: {len(offs)}  max |offset| {max(abs(o) for o in offs):.2f} ms' + \
      f'\nband 25-120 Hz {lo:.1f} dB, 200-4k {mid:.1f} dB, low-mid {lo - mid:+.1f} dB' + \
      f'\nhush window peak (b31.5 → b32): {20 * np.log10(quiet + 1e-9):.1f} dBFS' + f'\nmix peak {np.abs(mixb).max():.3f}\n'
open(os.path.join(HERE, 'out', 'report.txt'), 'w').write(txt)
json.dump([{'t': t, 'what': w, 'offset_ms': o} for (t, w), o in zip(ONSETS, offs)], open(os.path.join(HERE, 'out', 'onsets.json'), 'w'), indent=1)
print(txt[-400:])
