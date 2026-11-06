"""Score, sound design and mix for 《后退的冰川》 -> out/mix.wav (48 kHz stereo) + out/stems/.

Every hit is placed from timeline.json (cues, 80 BPM grid) and events.json (window.EV from the page),
so each sound sits on its frame.

  palette   telemetry: FM pings (the lock ping comes back at the end), dry ticks that divide to accelerate,
            noise scans, servo whines, a ratchet for the range line
            weight: sampled timpani, concert bass drum, gran cassa, low brass stab (trombone + tuba + horn)
            synthesis: pulse bass with 2nd/3rd harmonics, detuned-saw pad under a low-pass, riser
            ice: synthesised cracks with the dispersive "zing" of fractured ice; plucked double bass (pluck.py)
            the one wet timbre, held back for the turn: bowed vibraphone, glockenspiel, hand chimes, bowed cymbal
  beds      orbit hum + radio hiss + data chatter; after the turn the fjord's water
usage: $LIB/.venv/bin/python mix.py
"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import pluck as P
from core.audio import sfx as X

SR = X.SR
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
T = TL['T']; BEAT = TL['beat']; DUR = T['dur']
N = int((DUR + 0.5) * SR)
rng = np.random.default_rng(55)
S.seed(55)
STEMS = {k: np.zeros((N, 2)) for k in ('mus', 'pul', 'hit', 'fx', 'bed')}

# ------------------------------------------------------------------ dsp
def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lpf(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x, axis=0)
def hpf(x, f, o=2): return sosfilt(sos('high', f, o), x, axis=0)
def bpf(x, a, b, o=2): return sosfilt(sos('band', [a, min(b, SR * .45)], o), x, axis=0)
def tv(d): return np.arange(int(round(d * SR))) / SR
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def mi(n): return S.midi(n)
def nz(d): return rng.standard_normal(int(round(d * SR)))
def put(stem, x, at, g=1.0, pan=0.0):
    buf = STEMS[stem]; x = np.asarray(x, np.float64)
    if x.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        x = np.stack([x * l, x * r], 1) * np.sqrt(2)
    if stem == 'hit' and at < T['sil0']:      # long skins/brass tails stop in the silence (they must not resurface at the turn)
        n = max(0, int((T['sil0'] + .45 - at) * SR))
        if len(x) > n: x = x[:n] * np.linspace(1, 0, n)[:, None] ** 2
    s = int(round(at * SR))
    if s < 0: x = x[-s:]; s = 0
    e = min(N, s + len(x))
    if e > s: buf[s:e] += x[:e - s] * g
def env(d, a=.005, r=.1):
    n = int(round(d * SR)); e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e
def stereo(x, w=.0007):
    k = int(w * SR); return np.stack([x, np.concatenate([np.zeros(k), x[:-k]])], 1)
def room(x, size=.5, mix=.25): return S.room(x if x.ndim == 2 else stereo(x), size=size, mix=mix)
def norm(x, p=1.0): m = np.abs(x).max(); return x * (p / m) if m > 0 else x

# ------------------------------------------------------------------ voices
def saw(f, d, det=0.0):
    t = tv(d); ph = (f * (1 + det)) * t
    return 2 * (ph - np.floor(ph + .5))
def fm_ping(m, d=1.4, vel=.6, idx=2.2, ratio=3.5):
    t = tv(d); fc = hz(m)
    mod = idx * np.exp(-t / .12) * np.sin(2 * np.pi * fc * ratio * t)
    x = np.sin(2 * np.pi * fc * t + mod) * np.exp(-t / (d * .35))
    x += .25 * np.sin(2 * np.pi * fc * 2.01 * t) * np.exp(-t / .2)
    return x * env(d, .002, .05) * vel
def tick(v=.6):
    d = .03; t = tv(d)
    x = hpf(nz(d), 3000) * np.exp(-t / .0012) * .6 + np.sin(2 * np.pi * 3150 * t) * np.exp(-t / .006)
    return x * v
def scan(d, f0, f1, vel=.5):
    n = int(d * SR); x = nz(d); out = np.zeros(n); blk = 512
    fs = np.geomspace(f0, f1, n // blk + 1)
    for i in range(0, n, blk):
        f = fs[i // blk]; seg_ = x[max(0, i - 2048):i + blk]
        y = bpf(seg_, f * .7, f * 1.4)[-min(blk, n - i):]
        out[i:i + len(y)] = y
    e = np.sin(np.pi * np.linspace(0, 1, n)) ** 1.5
    return out * e * vel * 3
def servo(d, f0, f1, vel=.15):
    t = tv(d); f = np.geomspace(f0, f1, len(t)) * (1 + .006 * np.sin(2 * np.pi * 7 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) + .35 * np.sin(2 * ph) + .15 * np.sin(3 * ph)
    return x * env(d, .08, .12) * vel
def ice_crack(v=1.0, zing=True, low=1.0):
    d = 1.6; t = tv(d); x = np.zeros(len(t))
    # a cluster of micro-fractures
    k = rng.integers(7, 14); pos = np.sort(rng.random(k) ** 1.6) * .16
    for p in pos:
        s = int(p * SR); L = int(.004 * SR)
        x[s:s + L] += hpf(nz(.004), 1500) * np.exp(-np.arange(L) / (.0007 * SR)) * (.4 + rng.random())
    body = bpf(x, 900, 5200) * 2 + bpf(x, 250, 900)
    ring = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / tau) for f, a, tau in [(1750, .25, .05), (2900, .18, .03)]) * (t < .3)
    thump = np.sin(2 * np.pi * (70 + 30 * np.exp(-t / .03)) * t) * np.exp(-t / .22) * .9 * low
    y = body + ring * .4 + thump
    if zing:   # dispersive chirp: the falling "pew" that cracking ice sends through itself
        f = 3800 * np.exp(-t / .22) + 520
        z = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .38) * (t > .02)
        y += z * .32
    return y * v
def paper(d, rate=16, vel=.5):
    n = int(d * SR); y = np.zeros(n); step = 60 / TL['bpm'] / (rate / 4)
    for i in range(int(d / step) + 1):
        s = int(i * step * SR); L = int(.05 * SR)
        g = bpf(nz(.05), 1200, 6500) * np.exp(-np.arange(L) / (.012 * SR)) * (.6 + .4 * rng.random())
        y[s:s + L] += g[:max(0, min(L, n - s))]
    roll = bpf(nz(d), 200, 900) * .25
    return (y + roll) * env(d, .02, .08) * vel
def rip(d=.8, vel=.8):
    n = int(d * SR); t = tv(d)
    imp = (rng.random(n) < (120 + 900 * t / d) / SR).astype(float) * rng.standard_normal(n)
    y = bpf(imp, 700, 7000) * 6 + bpf(nz(d), 1500, 5000) * .5
    return y * np.sin(np.pi * np.clip(t / d, 0, 1)) ** .7 * vel
def ratchet(big=False, v=.5):
    d = .06; t = tv(d)
    x = hpf(nz(d), 2000) * np.exp(-t / .0015) + np.sin(2 * np.pi * (2300 if not big else 1500) * t) * np.exp(-t / .012) * .6
    if big: x += np.sin(2 * np.pi * 180 * t) * np.exp(-t / .03) * .8
    return x * v
def pulse_bass(m, d, vel=.6, cut=500):
    f = hz(m); t = tv(d)
    x = saw(f, d) * .5 + np.sin(2 * np.pi * f * t) * .7 + .35 * np.sin(2 * np.pi * 2 * f * t) + .22 * np.sin(2 * np.pi * 3 * f * t)
    return lpf(x, cut) * env(d, .004, min(.06, d * .4)) * vel
def pad(ms, d, vel=.22, cut=1300, a=.6, r=.9):
    y = 0
    for m in ms:
        for det in (-.004, 0, .0045): y = y + saw(hz(m), d, det)
    y = lpf(y / (3 * len(ms)), cut, 2)
    return stereo(y * env(d, a, r) * vel, .0011)

# ------------------------------------------------------------------ beds
def bed_hum():
    t = np.arange(N) / SR
    x = (np.sin(2 * np.pi * 55 * t) * .5 + np.sin(2 * np.pi * 110.3 * t) * .35 + np.sin(2 * np.pi * 165.2 * t) * .2) * (.8 + .2 * np.sin(2 * np.pi * .23 * t))
    h = bpf(rng.standard_normal(N), 2500, 8000) * .25
    y = hpf(x, 45) * .5 + h
    put('bed', y, 0, 0.25)
    # data chatter: soft FM blips on random sixteenths until the range line ends
    for i in range(int(T['rangeEnd'] / (BEAT / 4))):
        if rng.random() < .28:
            put('bed', fm_ping(84 + int(rng.integers(0, 12)), .08, .12, idx=4, ratio=1.41), i * BEAT / 4, .5, float(rng.uniform(-.7, .7)))
def bed_water():
    d = DUR - T['turn'] + .5
    w = lpf(np.cumsum(rng.standard_normal(int(d * SR))) * .02, 600)
    w = hpf(w, 60); w = norm(w)
    t = tv(d); sw = .55 + .45 * np.sin(2 * np.pi * .35 * t - 1.2)
    x = w * sw * env(d, .9, .5)
    put('bed', stereo(x, .004), T['turn'], 0.35)

# ------------------------------------------------------------------ score
def score():
    # pulse bass: eighths on D from the first frame, filter opening through the dive; stops on the last ring
    for i in range(int(T['y2026'] / (BEAT / 2))):
        t0 = i * BEAT / 2
        root = 38
        if t0 >= T['y2005']: root = 36
        if t0 >= T['y2010']: root = 34
        if t0 >= T['y2015']: root = 33
        if t0 >= T['y2020']: root = 31
        cut = 260 + 900 * min(1, t0 / T['lock']) if t0 < T['lock'] else 700 + 500 * (t0 > T['y1986'])
        vel = .35 + .25 * min(1, t0 / T['lock']) + .1 * (t0 > T['y1986'])
        put('pul', pulse_bass(root, BEAT / 2 * .85, vel, cut), t0, 1.0)
    # sixteenths on the last two rings
    for i in range(int((T['y2026'] - T['y2015']) / (BEAT / 4))):
        t0 = T['y2015'] + i * BEAT / 4
        put('pul', pulse_bass(50, BEAT / 4 * .7, .18, 1800), t0, 1.0, .2)
    # range line: the pulse returns in sixteenths, filter opening to the reading
    n = int((T['rangeEnd'] - T['range0']) / (BEAT / 4))
    for i in range(n):
        t0 = T['range0'] + i * BEAT / 4; u = i / n
        put('pul', pulse_bass(38, BEAT / 4 * .75, .5 + .5 * u, 400 + 2200 * u), t0, 1.0)
    # pads (detuned saws, low-passed)
    chords = [(T['mapOn'], T['y2005'], [50, 57, 62, 65]),        # Dm
              (T['y2005'], T['y2010'], [48, 55, 60, 64]),        # C
              (T['y2010'], T['y2015'], [46, 53, 58, 62]),        # Bb
              (T['y2015'], T['y2020'], [45, 52, 57, 61]),        # A
              (T['y2020'], T['y2026'], [43, 50, 55, 58]),        # Gm
              (T['y2026'], T['rangeEnd'] - .3, [50, 57, 62, 65]),  # Dm, holds under the range line (kept low: the reading must top it)
              ]
    for a, b, ms in chords:
        put('mus', pad(ms, b - a + .25, .2 if a < T['y2026'] else .11, 1100 + 600 * (a > T['y1986']), a=.25 if a > T['mapOn'] else .7, r=.25), a)
    # after the turn: Dm9 opening, then the Dorian brightening (G/D), then an open D to end
    put('mus', pad([50, 57, 64, 65, 69], T['frame'] - T['turn'] + .4, .12, 1500, a=1.0, r=.5), T['turn'])
    put('mus', pad([50, 55, 59, 62, 67], T['coda'] - T['frame'] + .4, .10, 1600, a=.5, r=.5), T['frame'])
    put('mus', pad([50, 57, 62, 64, 69], DUR - T['coda'] + .5, .11, 1500, a=.4, r=1.2), T['coda'])
    # drone under the end (no pad note below MIDI 48 except this bass with harmonics)
    put('pul', pulse_bass(38, DUR - T['turn'] + .3, .22, 300) * env(DUR - T['turn'] + .3, 1.2, 1.5), T['turn'], 1.0)

    ev = [
        # the lock: ping + soft timpani
        (T['lock'], 'timpani', 'D3', 1.2, .45, 0),
        (T['mapName'], 'gran_cassa', 'hit', None, .35, 0),
        (T['tear'] - .05, 'gran_cassa', 'cresc', None, .55, 0),
        # rings: timpani on each root
        (T['y1986'], 'timpani', 'D3', 1.0, .6, -.1),
        (T['y2005'], 'timpani', 'C3', 1.0, .6, .1),
        (T['y2010'], 'timpani', 'A#2', .8, .62, -.1),
        (T['y2015'], 'timpani', 'A2', .6, .64, .1),
        (T['y2020'], 'timpani', 'G2', .6, .66, -.1),
        # the stop on the last ring
        (T['y2026'], 'timpani', 'D3', 1.4, .62, 0), (T['y2026'], 'bass_drum', None, None, .55, 0),
        (T['y2026'], 'tuba', 'D2', .9, .5, 0), (T['y2026'], 'trombone', 'A2', .9, .45, -.2), (T['y2026'], 'trombone', 'D3', .9, .42, .2),
        (T['y2026'], 'sus_cymbal', 'bow', None, .22, .3),
        # the range line builds: gran cassa crescendo into the reading
        (T['range0'] + 1.2, 'gran_cassa', 'cresc', None, .5, 0),
        # the reading lands: the heaviest designed impact
        (T['rangeEnd'], 'tuba', 'D2', .8, .95, 0), (T['rangeEnd'], 'trombone', 'D3', .8, .9, -.25), (T['rangeEnd'], 'trombone', 'A2', .8, .9, .25),
        (T['rangeEnd'], 'horn', 'F3', .8, .8, -.35), (T['rangeEnd'], 'horn', 'A3', .8, .8, .35),
        (T['rangeEnd'], 'timpani', 'D3', 1.0, 1.0, 0), (T['rangeEnd'], 'bass_drum', None, None, 1.0, 0), (T['rangeEnd'], 'gran_cassa', 'hit', None, .9, 0),
        # the turn: the only wet timbres of the film
        (T['turn'], 'vibraphone_bowed', 'D5', 3.2, .9, -.25), (T['turn'], 'vibraphone_bowed', 'A5', 3.2, .75, .25),
        (T['turn'], 'glockenspiel', 'D6', 2.4, .6, .3), (T['turn'], 'hand_chimes', 'D5', 2.6, .7, -.3), (T['turn'], 'hand_chimes', 'A5', 2.6, .55, .3),
        (T['turn'] + BEAT, 'hand_chimes', 'A5', 2.4, .4, -.3),
        (T['turn'], 'sus_cymbal', 'bow', None, .45, -.2),
        (T['turn'] + 2 * BEAT, 'hand_chimes', 'E5', 2.0, .32, .2),
        (T['frame'], 'vibraphone_bowed', 'B4', 2.2, .32, -.2), (T['frame'], 'vibraphone_bowed', 'G5', 2.2, .28, .2),
        (T['title'] + BEAT, 'hand_chimes', 'D5', 2.2, .32, 0),
        (T['coda'], 'timpani', 'D3', 1.5, .55, 0), (T['coda'], 'vibraphone_bowed', 'D5', 2.0, .55, -.2), (T['coda'], 'vibraphone_bowed', 'A4', 2.0, .45, .2),
        (T['coda'], 'glockenspiel', 'A6', 1.5, .25, .3),
    ]
    HITS = {'timpani', 'bass_drum', 'gran_cassa', 'tuba', 'trombone', 'horn'}
    for t0, inst, p, d, v, pan in ev:
        if p is None or inst in ('gran_cassa', 'sus_cymbal'):
            x = S.hit(inst, p, v) if p is not None else S.hit(inst, None, v)
        else:
            x = S.note(inst, p, d, vel=v)
        stem = 'hit' if inst in HITS else 'mus'
        if inst in ('tuba', 'trombone', 'horn') and t0 in (T['rangeEnd'], T['y2026']):
            x = x * env(len(x) / SR, .003, .35)          # a stab, not a sustained note
            if t0 == T['rangeEnd']: x = x * 1.45          # the reading's stab is the loudest moment of the film
        put(stem, x, t0, 1.0, pan)
    # plucked double bass on each ring, descending D-C-Bb-A-G
    for t0, m in [(T['y1986'], 'D2'), (T['y2005'], 'C2'), (T['y2010'], 'A#1'), (T['y2015'], 'A1'), (T['y2020'], 'G1'), (T['y2026'], 'D2')]:
        put('mus', P.pluck('upright_bass_pizz', m, 1.4, vel=.85), t0, 0.9, -.05)
    # harp harmonics after the turn (plucked, glassy)
    for t0, m in [(T['turn'] + BEAT * .5, 'A4'), (T['turn'] + BEAT * 1.5, 'D5'), (T['turn'] + BEAT * 2.5, 'E5'), (T['frame'] + BEAT * .5, 'B4'), (T['coda'] + BEAT, 'D5')]:
        put('mus', P.pluck('harp', m, 2.5, vel=.55, harmonic=True), t0, .7, .15)

# ------------------------------------------------------------------ foley from the page's events
def foley():
    for e in EV:
        t0, ty = e['t'], e['type']
        if ty == 'scan_in': put('fx', scan(T['dive0'] + .1, 7000, 600, .35), t0, 1.0)
        elif ty == 'dive':
            d = T['lock'] - t0
            put('fx', scan(d, 300, 5000, .25) * np.linspace(.3, 1, int(round(d * SR))), t0, .9)
            put('fx', servo(d, 260, 820, .1), t0, 1.0, -.2)
            put('hit', S.hit('gran_cassa', 'cresc', .4), t0 - .1, .7)
        elif ty == 'lock':
            p = fm_ping(81, 1.6, .55)
            put('fx', p, t0, 1.0, 0); put('fx', p * .35, t0 + BEAT / 2, 1.0, -.5); put('fx', p * .15, t0 + BEAT, 1.0, .5)
            put('fx', servo(.18, 900, 1500, .08), t0 - .18, 1.0)
        elif ty == 'map_print': put('fx', paper(.65, 16, .4), t0, 1.0, .1)
        elif ty == 'map_name': put('fx', bpf(nz(.25), 300, 3000) * np.exp(-tv(.25) / .05) * .3, t0, 1.0)
        elif ty == 'tear':
            d = T['y1986'] - t0
            put('fx', rip(d + .1, .55), t0 - .1, 1.0, -.15)                 # J-cut: the paper goes before the bar
            put('fx', scan(d, 600, 6500, .4), t0, 1.0, .15)
        elif ty == 'scan': put('fx', scan(e['d'] + .05, 5500, 700, .3), t0, 1.0, .1)
        elif ty in ('ring', 'stop'):
            i = e['i']; big = ty == 'stop'
            put('fx', ice_crack(.35 + .1 * i if not big else .9, zing=(i % 2 == 0 or big), low=.6 + .1 * i), t0, 1.0, float(rng.uniform(-.4, .4)))
        elif ty == 'tick': put('fx', tick(e['v'] * .55), t0, 1.0, .35)
        elif ty == 'mark':
            put('fx', fm_ping(86, .6, .35, idx=1.6), t0, 1.0, -.3); put('fx', servo(.14, 1100, 1700, .06), t0 - .14, 1.0)
        elif ty == 'range': put('fx', servo(T['rangeEnd'] - t0, 380, 1250, .07), t0, 1.0, .2)
        elif ty == 'ratchet': put('fx', ratchet(bool(e['big']), .32 if e['big'] else .18), t0, 1.0, .25)
        elif ty == 'range_end':
            put('fx', fm_ping(74, 1.4, .5, idx=3.0, ratio=1.0), t0, 1.0)          # the reading lands on a pitched hit (D5)
            put('fx', X.pop(.4) if hasattr(X, 'pop') else tick(.6), t0, .5, .3)
        elif ty == 'turn':
            put('fx', room(ice_crack(.9, zing=True, low=.6), .85, .5), t0, 1.4, -.35)   # far ice, in the fjord's space
        elif ty == 'frame':
            p = fm_ping(77, 1.4, .4)                                              # the lock ping answered, a third lower (F5)
            put('fx', p, t0, 1.0); put('fx', p * .3, t0 + BEAT / 2, 1.0, .5)
            put('fx', servo(.32, 700, 1300, .06), t0 - .32, 1.0, -.2)
        elif ty == 'coda': put('fx', fm_ping(74, 1.8, .25), t0, 1.0, -.2)
    # L-cut: far cracks keep ringing into the card
    for t0, v in [(T['frame'] + BEAT * 1.25, .3), (T['coda'] + BEAT * .75, .22)]:
        put('fx', room(ice_crack(v, zing=False, low=.3), .9, .6), t0, .7, float(rng.uniform(-.6, .6)))

# ------------------------------------------------------------------ mix
def comp(x, thr=.3, ratio=3.0, att=.005, rel=.12):
    lvl = np.abs(x).max(1); g = np.ones(len(x)); a, r = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR)); e = 0
    env_ = np.empty(len(x))
    for i in range(0, len(x), 64):
        v = lvl[i:i + 64].max(); e = (a if v > e else r) ** 64 * e + (1 - (a if v > e else r) ** 64) * v; env_[i:i + 64] = e
    over = np.maximum(env_ / thr, 1)
    return x * (over ** (1 / ratio - 1))[:, None]
def gain_curve(points):
    t = np.arange(N) / SR; xs, ys = zip(*points); return np.interp(t, xs, ys)[:, None]

bed_hum(); bed_water(); score(); foley()
db = lambda d: 10 ** (d / 20)
mus = comp(STEMS['mus'] * db(4), .35, 2.5); pul = comp(STEMS['pul'] * db(-17), .35, 2.5)
fx = comp(STEMS['fx'] * db(-3), .45, 2.0); bed = STEMS['bed'] * db(-9); hit = STEMS['hit'] * db(9)
hit = hpf(hit, 58, 4); hit = hit + bpf(hit, 70, 140, 2) * 0.6          # impact weight at 60-120 Hz, not below
mus = hpf(mus, 55, 2); pul = hpf(pul, 50, 2); bed = hpf(bed, 70, 2)
# suck-outs and the silence: music and foley down before the heaviest impacts; near-silence before the turn
sil = T['sil0']; turn = T['turn']; re = T['rangeEnd']; st = T['y2026']
duck = gain_curve([(0, 1), (st - .26, 1), (st - .2, db(-22)), (st - .01, db(-22)), (st, 1),
                   (re - .34, 1), (re - .3, db(-25)), (re - .01, db(-25)), (re, 1),
                   (sil - .5, 1), (sil + .05, db(-40)), (turn - .01, db(-40)), (turn, 1), (DUR + 1, 1)])
hit_tail = gain_curve([(0, 1), (sil - .2, 1), (sil + .25, db(-36)), (turn - .01, db(-36)), (turn, 1), (DUR + 1, 1)])
bed_g = gain_curve([(0, 1), (sil - .3, 1), (sil + .2, db(-8)), (turn - .01, db(-8)), (turn, 1), (DUR + 1, 1)])
mixb = (mus + pul + fx) * duck + hit * hit_tail + bed * bed_g
mixb = hpf(mixb, 52, 4)
lo = lpf(mixb, 75, 4); mixb = mixb - lo * (1 - db(-9))           # shelf the sub below ~60 Hz
fade = gain_curve([(0, 1), (DUR - .5, 1), (DUR, 0), (DUR + 1, 0)]); mixb *= fade
mixb = mixb[:int(DUR * SR)]
# master: BS.1770 loudness to -14 LUFS, then an oversampled (true-peak) look-ahead limiter at -1.9 dBTP,
# so the final loudnorm pass in mux.sh is a near-zero linear gain and the true peak stays <= -1.2 dB (STYLE §7)
from scipy.signal import lfilter, resample_poly
from scipy.ndimage import maximum_filter1d, uniform_filter1d
def lufs(x):
    y = lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], x, axis=0)
    y = lfilter([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], y, axis=0)
    b, h = int(.4 * SR), int(.1 * SR)
    z = np.array([np.mean(y[i:i + b] ** 2, 0).sum() for i in range(0, len(y) - b, h)])
    L = -0.691 + 10 * np.log10(np.maximum(z, 1e-12)); z = z[L > -70]
    rel = -0.691 + 10 * np.log10(z.mean()) - 10; L = -0.691 + 10 * np.log10(z)
    return -0.691 + 10 * np.log10(z[L > rel].mean())
def tp_limit(x, ceil_db=-1.9, look=.004):
    ceil = 10 ** (ceil_db / 20); n = int(look * SR)
    for _ in range(3):
        up = resample_poly(x, 4, 1, axis=0); pk = np.abs(up).max(1).reshape(-1, 4).max(1)[:len(x)]
        if pk.max() <= ceil: break
        g = np.minimum(1, ceil * .985 / np.maximum(maximum_filter1d(pk, 2 * n + 1), 1e-9))
        g = np.minimum(g, uniform_filter1d(g, n)); x = x * g[:, None]
    return x
pre = mixb.copy()
for _ in range(4):                                  # gain to -14, limit, repeat until the limited master sits on -14
    mixb = tp_limit(mixb * 10 ** ((-14.0 - lufs(mixb)) / 20))
    if abs(lufs(mixb) + 14.0) < .05: break
gr = None
for t0 in (T['lock'], T['y2026'], T['rangeEnd'], T['turn'], T['coda']):
    seg_ = slice(int(t0 * SR), int((t0 + .3) * SR)); print('  limiter at %.2f s: peak %.1f dBFS' % (t0, 20 * np.log10(np.abs(mixb[seg_]).max())))
print('master: %.2f LUFS, sample peak %.2f dBFS' % (lufs(mixb), 20 * np.log10(np.abs(mixb).max())))
os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mixb.astype(np.float32), SR)
for k, v in STEMS.items(): sf.write(os.path.join(HERE, f'out/stems/{k}.wav'), v[:int(DUR * SR)].astype(np.float32), SR)
print('mix', mixb.shape, 'peak', float(np.abs(mixb).max()))
