"""《叮咚》 score, foley and mix. Run from anywhere:  $LIB/.venv/bin/python mix.py
Reads events.json (node core/render/events.mjs <film>). Writes out/mix.wav (48 kHz stereo, the film's length),
out/stems/*.wav and out/score.json (every cue's placed time and measured audio onset, for tools/cuecheck.mjs).

G major, 120 BPM, the drone tuned to the mains hum (G1 ≈ 49 Hz). The palette of the style: pulse waves and saw
tones, FM bells and a real glockenspiel / tubular bells / vibraphone (VCSL samples via sampler.py), a plucked
music box and bass (pluck.py), relay clicks, soft kicks and 16th ticks, filtered noise. No piano, no strings.
The ear's rule: a gated tremolo tone = alternating current; a steady tone = direct current.
Motif: the doorbell's two notes B -> G (a falling major third).
"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import sawtooth

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P          # noqa: E402
from core.audio import sfx                                 # noqa: E402
from core.audio.sfx import SR, t_, bp, lp, hp, noise, add  # noqa: E402

S.seed(76)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
EV, DUR = EVJ['ev'], EVJ['dur']
N = int(round(DUR * SR))
BEAT = 0.5; S16 = BEAT / 4
def ev(ty): return [e for e in EV if e['type'] == ty]
def one(ty): return ev(ty)[0]['t']
def hz(m):
    m = S.midi(m) if isinstance(m, str) else m
    return 440.0 * 2 ** ((m - 69) / 12)
def M(p): return S.midi(p)
def buf(): return np.zeros((N, 2), np.float32)
def fade(x, a=0.003, b=0.02):
    x = np.asarray(x, np.float64).copy(); n = len(x); ia, ib = min(n, int(a * SR)), min(n, int(b * SR))
    if ia: x[:ia] *= np.linspace(0, 1, ia)
    if ib: x[-ib:] *= np.linspace(1, 0, ib)
    return x

T = {k: one(k) for k in ['press', 'launch', 'r1', 'c1', 'viaDn', 'viaUp', 'u1', 'plunge', 'sch', 'dff', 'stop', 'out', 'whip', 'coil', 'hush', 'ding', 'dong']}
BOUNCE = [e['t'] for e in ev('bounce')]
SEQ = [e['t'] for e in ev('seq')]
ROM = [e['t'] for e in ev('rom')]
Q = [e['t'] for e in ev('q')]

# ============================== voices ==============================
def pulse(m, d, pw=0.25, cut=3000, dec=0.09, att=0.002):
    tt = t_(d); ph = (tt * hz(m)) % 1.0
    x = np.where(ph < pw, 1.0, -1.0) - (2 * pw - 1)
    return lp(x * np.minimum(1, tt / att) * np.exp(-tt / dec), cut, 2)
def saw(m, d, cut=2000):
    tt = t_(d); return lp(sawtooth(2 * np.pi * hz(m) * tt), cut)
def sine(m, d): return np.sin(2 * np.pi * hz(m) * t_(d))
def fmbell(m, d=2.4, ratio=3.5, idx=2.2, dec=0.9):
    tt = t_(d); f = hz(m); I = idx * np.exp(-tt / 0.25)
    return np.sin(2 * np.pi * f * tt + I * np.sin(2 * np.pi * f * ratio * tt)) * np.exp(-tt / dec) * np.minimum(1, tt / 0.0015)
def gate(x, rate_fn, depth=0.9, t0=0.0, soft=0.006):
    """AC: amplitude-gated at a (time-varying) rate in Hz; rate_fn(t_abs) -> Hz"""
    tt = np.arange(len(x)) / SR + t0; r = np.array([rate_fn(v) for v in tt[::48]]); r = np.repeat(r, 48)[:len(x)]
    ph = np.cumsum(r) / SR; g = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * ph))
    from scipy.ndimage import uniform_filter1d
    g = uniform_filter1d(g, max(1, int(soft * SR)))
    d = depth if np.isscalar(depth) else np.interp(tt, depth[0], depth[1])
    return x * (1 - d + d * g)
def relay(pitch=1.0, v=1.0):
    x = np.zeros(int(0.07 * SR)); c = sfx.click(1.25 * pitch, 1.0); x[:len(c)] += c[:len(x)]
    c2 = sfx.click(0.95 * pitch, 0.55); s = int(0.012 * SR); x[s:s + len(c2)] += c2[:len(x) - s]
    tt = t_(0.07); x += np.sin(2 * np.pi * 140 * pitch * tt) * np.exp(-tt / 0.012) * 0.35
    return x * v
def kick(v=1.0, f0=48):
    d = 0.42; tt = t_(d); f = f0 + 80 * np.exp(-tt / 0.028)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.16)
    x += 0.25 * np.sin(2 * 2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.06)       # 2nd harmonic so it speaks on small speakers
    return x * v
def tick(v=1.0, lo=5500, hi=12000):
    d = 0.035; tt = t_(d); return bp(noise(d), lo, hi) * np.exp(-tt / 0.003) * v
def zap(m=55, d=0.16, v=1.0):
    tt = t_(d); f = hz(m) * (1 + 1.5 * np.exp(-tt / 0.02))
    x = sawtooth(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.05)
    return bp(x, 300, 5000) * v
def scratch(d, v=1.0):
    """silkscreen being plotted: a faint grainy scratch"""
    n = noise(d); tt = t_(d); grains = (np.random.default_rng(int(d * 1000)).random(len(n)) > 0.985) * 1.0
    from scipy.ndimage import uniform_filter1d
    g = uniform_filter1d(grains, 40) * 30
    return bp(n, 2500, 7000) * (0.25 + g) * np.minimum(1, tt / 0.02) * np.minimum(1, (d - tt) / 0.05).clip(0) * v
def riser(d, f0=400, f1=5000, v=1.0):
    n = noise(d); tt = t_(d); out = np.zeros_like(n)
    for i in range(0, len(n), 480):
        hi_ = min(len(n), i + 480); f = f0 * (f1 / f0) ** (i / len(n)); out[i:hi_] = bp(n[max(0, i - 2400):hi_], f * 0.8, min(f * 1.25, 20000))[-(hi_ - i):]
    return out * (tt / d) ** 1.6 * v
def faller(d, f0=4000, f1=200, v=1.0):
    n = noise(d); tt = t_(d); out = np.zeros_like(n)
    for i in range(0, len(n), 480):
        hi_ = min(len(n), i + 480); f = f0 * (f1 / f0) ** (i / len(n)); out[i:hi_] = bp(n[max(0, i - 2400):hi_], f * 0.75, f * 1.3)[-(hi_ - i):]
    return out * np.sin(np.pi * tt / d) ** 1.5 * v

# chords (MIDI) per time
CH = {'G': ['G', 'B', 'D'], 'Em': ['E', 'G', 'B'], 'C': ['C', 'E', 'G'], 'D': ['D', 'F#', 'A'], 'Am': ['A', 'C', 'E']}
ROOT = {'G': 'G2', 'Em': 'E2', 'C': 'C3', 'D': 'D2', 'Am': 'A2'}
# 16th arpeggio patterns: the last two notes of each beat fall a third where the chord allows it (the B -> G motif)
PAT = {'G': ['G4', 'D5', 'B5', 'G5'], 'Em': ['E4', 'B4', 'B5', 'G5'], 'C': ['C5', 'G4', 'E5', 'C5'], 'D': ['D4', 'A4', 'F#5', 'D5'], 'Am': ['A4', 'E5', 'C6', 'A5']}

stems = {k: buf() for k in ['drone', 'arp', 'bass', 'drums', 'bells', 'pad', 'foley', 'ac']}
CUE = {}                                   # cue name -> list of (time, mono sound) placed for it, for the onset check
def place(stem, x, at, gain=1.0, pan=0.0, cue=None):
    add(stems[stem], np.asarray(x, np.float32), at, gain, pan)
    if cue: CUE.setdefault(cue, []).append((at, np.asarray(x, np.float64) * gain))

# ============================== drone: the hum on G ==============================
def drone():
    tt = np.arange(N) / SR; f = 49.0
    x = 0.35 * np.sin(2 * np.pi * 2 * f * tt) + 0.4 * np.sin(2 * np.pi * 3 * f * tt) + 0.3 * np.sin(2 * np.pi * 4 * f * tt) + 0.2 * np.sin(2 * np.pi * 6 * f * tt) + 0.08 * np.sin(2 * np.pi * 8 * f * tt)
    x += 0.04 * lp(sawtooth(2 * np.pi * f * tt), 900)
    lvl = 0.32 * np.interp(tt, [0, 1.5, 2.0, 7.9, 8.0, 9.0, 12.0, 12.05, 13.0, 16.0, 16.05, 16.5, 17.5, 19.0, DUR],
                         [0.10, 0.11, 0.13, 0.13, 0.14, 0.09, 0.09, 0.05, 0.12, 0.13, 0.025, 0.025, 0.09, 0.06, 0.0])
    stems['drone'][:, 0] += x * lvl; stems['drone'][:, 1] += x * lvl
    room = lp(noise(DUR), 500) * 0.012 * np.interp(tt, [0, 12, 12.05, 13, 16, 16.05, 16.5, DUR], [1, 1, 0.4, 0.6, 1, 0.3, 0.3, 0.6])
    stems['drone'][:, 0] += room; stems['drone'][:, 1] += np.roll(room, 311)
    # the long tone in the stop: a thin D6, the only music left
    d6 = sine('D6', 1.0) * np.interp(t_(1.0), [0, 0.3, 0.9, 1.0], [0, 1, 1, 0]) * 0.028
    place('drone', d6, T['stop'], 1.0, 0.1)
    b6 = sine('B6', 0.5) * np.interp(t_(0.5), [0, 0.1, 0.45, 0.5], [0, 1, 1, 0]) * 0.02
    place('drone', b6, T['hush'], 1.0, -0.1)
drone()

# ============================== DC tone and AC coil ==============================
def dc_tone():
    # steady tone while the current runs SW1 -> U1 (direct current = one long tone)
    d = T['plunge'] + 0.6 - T['launch']; x = saw('G2', d, 700) * 0.6 + saw('D3', d, 900) * 0.35
    tt = t_(d) + T['launch']
    lv = np.interp(tt, [T['launch'], T['launch'] + 0.08, T['r1'] - 0.01, T['r1'] + 0.05, T['plunge'], T['plunge'] + 0.6], [0, 1, 1, 0.7, 0.6, 0])
    x = bp(x, 140, 1800) * lv * 0.08
    place('ac', x, T['launch'], 1.0, -0.1)
    # the coil: alternating current, gated faster and faster, hush, then (after 咚) the gate smooths into a long tone
    t0 = T['coil']; d = DUR - t0; tt = t_(d) + t0
    def rate(v):
        if v < T['hush']: return 2 * (2.2 + (7 - 2.2) * (v - t0) / (T['hush'] - t0))
        if v < T['ding']: return 1.4
        return 2 * max(0.0, 3 - 3 * (v - T['ding']) / (18.8 - T['ding']))
    base = saw('G2', d, 1200) * 0.5 + saw('D3', d, 1500) * 0.3 + saw('G3', d, 1800) * 0.2
    depth = ([t0, T['dong'], 18.8, 19.3], [0.95, 0.9, 0.2, 0.0])
    x = gate(bp(base, 90, 2500), rate, depth, t0)
    lv = np.interp(tt, [t0, t0 + 0.05, T['hush'] - 0.02, T['hush'] + 0.02, T['ding'] - 0.01, T['ding'], T['dong'], 18.6, DUR - 0.3, DUR],
                       [0, 0.35, 1.0, 0.12, 0.12, 0.7, 0.75, 0.55, 0.15, 0])
    place('ac', x * lv * 0.16, t0, 1.0, 0.15)
dc_tone()

# ============================== arpeggio (pulse waves) ==============================
def arp():
    def chord_at(t):
        if t < 4.0: return 'G'
        if t < 6.0: return 'Em'
        if t < 7.0: return 'C'
        if t < 9.0: return 'D'
        if t < 14.0: return 'Em'
        if t < 15.0: return 'C'
        return 'D'
    # the press starts it: four rising notes into the downbeat
    for i, p in enumerate(['G4', 'B4', 'D5', 'G5']):
        place('arp', pulse(M(p), 0.2, 0.25, 2600, 0.09), T['press'] + i * S16, 0.17, -0.3 + 0.2 * i)
    def run(t0, t1, cut0, cut1, g0, g1, pan=0.25):
        n = int(round((t1 - t0) / S16))
        for i in range(n):
            t = t0 + i * S16; c = chord_at(t); p = PAT[c][i % 4]; f = i / max(1, n - 1)
            cut = cut0 * (cut1 / cut0) ** f; g = g0 + (g1 - g0) * f
            acc = 1.0 if i % 4 == 0 else 0.78
            place('arp', pulse(M(p), 0.2, 0.25 if i % 8 < 4 else 0.125, cut, 0.085), t, g * acc, pan * (1 if i % 2 else -1))
    run(T['launch'], T['plunge'], 900, 4200, 0.13, 0.16)
    # the plunge: the arpeggio dives an octave and closes
    for i in range(8):
        t = T['plunge'] + i * S16; p = M(PAT['D'][i % 4]) - i * 1.5
        place('arp', pulse(p, 0.22, 0.25, 2800 * 0.75 ** i, 0.1), t, 0.13 * (1 - i / 9), 0.3 * (-1) ** i)
    run(T['out'] + S16 * 4, T['hush'], 700, 6000, 0.08, 0.17, 0.35)
    # one last echo after 咚, high and soft, falling through the motif
    for i, p in enumerate(['D6', 'B5', 'G5', 'D5', 'B4', 'G4']):
        place('arp', pulse(M(p), 0.3, 0.25, 3500, 0.14), 18.25 + i * S16, 0.06 * (1 - i / 8), 0.4 * (-1) ** i)
arp()

# ============================== bass (plucked) ==============================
def bass():
    seq = [(2.0, 'G2'), (3.0, 'G2'), (3.5, 'D2'), (4.0, 'E2'), (5.0, 'E2'), (5.5, 'B1'), (6.0, 'C2'), (6.5, 'C2'), (7.0, 'D2'), (7.5, 'D2'),
           (13.5, 'E2'), (14.0, 'C2'), (14.5, 'C2'), (15.0, 'D2'), (15.5, 'D2'), (15.75, 'D2')]
    for t, p in seq:
        x = P.pluck('upright_bass_pizz', p, 0.6, vel=0.8)
        x = x + 0.4 * np.tanh(3 * x)                     # a little 2nd/3rd harmonic so it speaks
        place('bass', fade(x, 0.001, 0.08), t, 0.32, 0.0)
    # 咚: a deep plucked G under the chord
    place('bass', fade(P.pluck('upright_bass_pizz', 'G2', 2.0, vel=0.95), 0.001, 0.3), T['dong'], 0.36, 0.0)
bass()

# ============================== drums: soft kick, 16th ticks ==============================
def drums():
    for k in range(int((T['plunge'] - T['launch']) / BEAT)):
        t = T['launch'] + k * BEAT; place('drums', kick(0.9 if k % 4 == 0 else 0.7), t, 0.26)
    for k in range(int((T['plunge'] - 4.0) / S16)):
        t = 4.0 + k * S16; place('drums', tick(1.0 if k % 2 else 0.5), t, 0.10, 0.5 * (-1) ** k)
    for k in range(4):
        t = T['out'] + 1.0 + k * BEAT; place('drums', kick(0.75), t, 0.24)
    for k in range(4):
        t = 15.0 + k * BEAT / 2; place('drums', kick(0.8), t, 0.26)
    for k in range(int((T['hush'] - 14.0) / S16)):
        t = 14.0 + k * S16; place('drums', tick(1.0 if k % 2 else 0.6), t, 0.08 + 0.06 * k / 16, 0.5 * (-1) ** k)
    # 叮 / 咚: a soft sub hit under each bell
    place('drums', kick(1.0, 50), T['ding'], 0.32, cue='ding')
    place('drums', kick(1.0, 46), T['dong'], 0.38, cue='dong')
drums()

# ============================== bells and the chip's music box ==============================
def bells():
    # inside the chip: Schmitt, flip-flop, then the sequencer winding up the G pentatonic, faster and faster
    place('bells', P.pluck('music_box', 'G5', 1.2, vel=0.8), T['sch'], 0.85, -0.2, cue='sch')
    place('bells', P.pluck('music_box', 'D6', 1.2, vel=0.8), T['dff'], 0.85, 0.2, cue='dff')
    scale = ['G4', 'A4', 'B4', 'D5', 'E5', 'G5', 'A5', 'B5', 'D6', 'E6', 'G6', 'A6', 'B6', 'D7', 'E7', 'G7']
    for i, t in enumerate(SEQ):
        place('bells', P.pluck('music_box', scale[i], 0.6, vel=0.6 + 0.02 * i), t, 0.62, -0.5 + i / 15, cue=f'seq{i}')
        place('bells', pulse(M(scale[i]) - 12, 0.12, 0.125, 2400, 0.04), t, 0.07, 0.5 - i / 15)
    # the two tone cells: the motif, first heard here, small (glockenspiel + music box)
    for t, p, cue in [(ROM[0], 'B5', 'rom1'), (ROM[1], 'G5', 'rom2')]:
        place('bells', S.note('glockenspiel', p, 0.6, vel=0.6), t, 0.5, -0.1, cue=cue)
        place('bells', P.pluck('music_box', p, 1.0, vel=0.85), t, 0.6, 0.1, cue=cue)
    # 叮 (B) and 咚 (G): the motif full size — glockenspiel, tubular bells, vibraphone, FM bell
    for t, hi, lo, cue in [(T['ding'], 'B5', 'B4', 'ding'), (T['dong'], 'G5', 'G4', 'dong')]:
        place('bells', S.note('glockenspiel', hi, 2.5, vel=1.0), t, 0.85, -0.15, cue=cue)
        place('bells', S.note('tubular_bells', lo, 3.0, vel=0.95), t, 0.8, 0.15, cue=cue)
        place('bells', S.note('vibraphone_hard', lo, 2.6, vel=0.95), t, 0.6, 0.0, cue=cue)
        place('bells', fmbell(M(hi), 2.8, 3.5, 2.4, 1.1), t, 0.26, 0.0, cue=cue)
        place('bells', fmbell(M(lo), 2.8, 2.0, 1.2, 1.4), t, 0.16, 0.0, cue=cue)
    # 咚 opens into the chord: G B D F# A
    for p, pan in [('G4', -0.3), ('B4', 0.3), ('D5', -0.15), ('F#5', 0.2), ('A5', 0.0)]:
        place('bells', S.note('vibraphone_bowed', p, 1.9, vel=0.75, attack=0.25), T['dong'] + 0.05, 0.32, pan)
    place('bells', S.note('hand_chimes', 'D6', 2.0, vel=0.6), T['dong'] + 0.5, 0.25, 0.35)
    place('bells', S.note('hand_chimes', 'B5', 2.0, vel=0.55), T['dong'] + 1.0, 0.22, -0.35)
    # the press and the output: a glockenspiel spark at each
    place('bells', S.note('glockenspiel', 'G6', 0.5, vel=0.5), T['press'], 0.2, 0.3, cue='press')
    place('bells', S.note('glockenspiel', 'D6', 0.8, vel=0.75), T['out'], 0.3, 0.2, cue='out')
    for i, t in enumerate(Q):
        place('bells', S.note('glockenspiel', ['G5', 'B5', 'D6'][i], 0.5, vel=0.6), t, 0.22, -0.3 + 0.3 * i, cue=f'q{i}')
bells()

def pad():
    # the chord's long tone: pulse-wave pad G B D F# A, slow swell under 咚, fading to the end
    d = DUR - T['dong']; tt = t_(d)
    env = np.interp(tt, [0, 0.5, 1.4, d - 0.6, d], [0, 0.8, 1.0, 0.5, 0])
    x = np.zeros(len(tt))
    for p in ['G3', 'B3', 'D4', 'F#4', 'A4', 'D5']:
        f = hz(M(p)); ph = (tt * f * (1 + 0.0015 * np.sin(2 * np.pi * 0.3 * tt))) % 1.0
        x += np.where(ph < 0.3, 1.0, -1.0)
    x = lp(x, 1800) * env * 0.035
    place('pad', x, T['dong'], 1.0, -0.2); place('pad', np.roll(x, 900), T['dong'], 1.0, 0.2)
    # a soft pre-swell from the coil up to the hush
    d = T['hush'] - T['coil']; tt = t_(d)
    x = sum(np.sin(2 * np.pi * hz(M(p)) * tt) for p in ['D4', 'A4', 'F#5']) * (tt / d) ** 2 * 0.03
    place('pad', x, T['coil'], 1.0, 0.0)
pad()

# ============================== foley (driven by the picture's events) ==============================
def foley():
    # the finger: air moving close to the mic, then the press
    place('foley', faller(1.0, 900, 260, 1.0) * 0.06, 0.0, 1.0, -0.4)
    place('foley', riser(0.5, 200, 900, 1.0) * 0.08, 1.0, 1.0, -0.3)
    # the tact switch: the dome snaps (two clicks), a soft fingertip thump
    snap = relay(1.6, 1.0) * 0.8; _th = sfx.thump(1.0, 90)[:len(snap)]; snap[:len(_th)] += _th * 0.25
    place('foley', snap, T['press'], 0.75, 0.0, cue='press')
    for i, b in enumerate(BOUNCE):
        place('foley', tick(1.0, 3000, 9000) * (0.6 if i else 1.0), b, 0.35, 0.1, cue=f'bounce{i}')
    place('foley', zap(55, 0.18), T['launch'], 0.35, 0.1, cue='launch')
    place('foley', faller(0.6, 700, 200) * 0.07, T['launch'], 1.0, -0.5)               # the finger leaves
    # the path: each station its own sound; R1 one step lower (step-down), vias down/up through the board
    place('foley', relay(1.0), T['r1'], 0.45, 0.2, cue='r1')
    place('foley', relay(0.85), T['c1'], 0.45, 0.3, cue='c1')
    th = sfx.thump(1.0, 80) * 0.5; th[:int(0.12 * SR)] += lp(noise(0.12), 600) * np.exp(-t_(0.12) / 0.03) * 0.3
    place('foley', th, T['viaDn'], 0.5, 0.35, cue='viaDn')
    place('foley', sfx.pop(1.0) * 0.6, T['viaUp'], 0.4, 0.4, cue='viaUp')
    place('foley', relay(0.75, 1.2), T['u1'], 0.55, 0.0, cue='u1')
    place('foley', sfx.thump(1.0, 60) * 0.6, T['u1'], 0.5, 0.0, cue='u1')
    # the plunge: a falling rush, arrival thump
    place('foley', faller(1.0, 5000, 160) * 0.22, T['plunge'], 1.0, 0.0)
    th = sfx.thump(0.9, 75) * 0.5; th[:int(0.05 * SR)] += bp(noise(0.05), 300, 3000) * np.exp(-t_(0.05) / 0.008) * 0.6
    place('foley', th, T['plunge'], 0.45, 0.0, cue='plunge')
    place('foley', sfx.thump(0.8, 70) * 0.35, T['sch'], 1.0, 0.0, cue='sch')
    place('foley', relay(1.3, 0.6), T['sch'], 0.3, -0.3, cue='sch')
    place('foley', relay(1.15, 0.7), T['dff'], 0.35, 0.2, cue='dff')
    for i, t in enumerate(SEQ):
        place('foley', tick(1.0, 4000, 11000), t, 0.16, -0.5 + i / 15, cue=f'seq{i}')
    # the oscillator: a high gated tone, gate rate = the sequencer's clock (alternating)
    t0, t1 = SEQ[0], T['stop']; d = t1 - t0
    def rate(v):
        k = max(0, np.searchsorted(SEQ, v) - 1); nxt = SEQ[k + 1] if k + 1 < len(SEQ) else SEQ[-1] + 1 / 30
        return 1.0 / max(1 / 30, nxt - SEQ[k])
    osc = gate(sine('D6', d) * 0.5 + sine('A6', d) * 0.2, rate, 0.95, t0) * np.interp(t_(d), [0, 0.1, d - 0.01, d], [0, 1, 1, 0])
    place('foley', osc, t0, 0.05, 0.25)
    # 12.0: the stop — nothing (the gate below cuts every tail)
    # 13.0: the first sound after the silence — the output fires: a heavy relay, a low thump, a burst
    place('foley', relay(0.7, 1.4), T['out'], 0.7, 0.1, cue='out')
    place('foley', kick(1.0, 42), T['out'], 0.55, 0.0, cue='out')
    place('foley', bp(noise(0.25), 800, 6000) * np.exp(-t_(0.25) / 0.05), T['out'], 0.25, 0.2, cue='out')
    place('foley', faller(0.9, 300, 2600) * 0.08, T['out'], 1.0, 0.3)     # pulling back out
    # Q1–Q3: silver in, amber out — three relays stepping up, each with a zap of current
    for i, t in enumerate(Q):
        place('foley', relay(1.0 + 0.2 * i, 1.0), t, 0.5, -0.3 + 0.3 * i, cue=f'q{i}')
        place('foley', zap(43 + 5 * i, 0.2), t, 0.28, -0.3 + 0.3 * i, cue=f'q{i}')
    # the whip and the crash onto the coil
    place('foley', sfx.whoosh(0.3) * 0.35, T['whip'] - 0.03, 1.0, 0.4)
    place('foley', sfx.thump(1.0, 70) * 0.6, T['coil'], 0.6, 0.0, cue='coil')
    place('foley', relay(0.9, 0.8), T['coil'], 0.4, 0.2, cue='coil')
    place('foley', riser(T['hush'] - T['coil'], 300, 7000) * 0.22, T['coil'], 1.0, 0.0)
    # the rings: air pushed out across the board; at 咚 every trace lights (a fine shimmer)
    for t, v in [(T['ding'], 0.16), (T['dong'], 0.2)]:
        place('foley', faller(1.6, 2400, 220, 1.0) * v, t, 1.0, 0.0)
    d = 1.6; tt = t_(d); sh = hp(noise(d), 6000) * np.exp(-tt / 0.5) * (np.random.default_rng(5).random(len(tt)) > 0.6)
    place('foley', sh * 0.06, T['dong'], 1.0, -0.4); place('foley', np.roll(sh, 1700) * 0.06, T['dong'], 1.0, 0.4)
    # silkscreen plotting
    for e in ev('plot'):
        place('foley', scratch(e['d'] + 0.05), e['t'], 0.05 if not e['big'] else 0.08, 0.3)
foley()

# ============================== gates: the two silences ==============================
def silence_gate():
    tt = np.arange(N) / SR
    g = np.ones(N)
    g *= np.interp(tt, [T['stop'] - 0.004, T['stop'] + 0.004, T['out'] - 0.001, T['out']], [1, 0, 0, 1])     # hard stop
    g2 = np.interp(tt, [T['hush'] - 0.004, T['hush'] + 0.004, T['ding'] - 0.001, T['ding']], [1, 0.03, 0.03, 1])  # near-silence
    for k in ['arp', 'bass', 'drums', 'bells', 'pad', 'foley']:
        stems[k] *= (g * g2)[:, None]
    stems['ac'] *= (g * np.interp(tt, [T['hush'] - 0.004, T['hush'] + 0.004, T['ding'] - 0.001, T['ding']], [1, 0.1, 0.1, 1]))[:, None]
silence_gate()

# ============================== mix ==============================
GAIN = {'drone': 1.0, 'arp': 1.0, 'bass': 0.9, 'drums': 0.9, 'bells': 1.0, 'pad': 1.0, 'foley': 1.0, 'ac': 1.0}
wet = buf()
for k in ['bells', 'arp', 'pad']:
    wet += S.room(stems[k], size=0.62 if k == 'bells' else 0.4, mix=1.0) * (0.28 if k == 'bells' else 0.16)
# reverb tails obey the silences too
tt = np.arange(N) / SR
wet *= (np.interp(tt, [T['stop'] - 0.004, T['stop'] + 0.006, T['out'] - 0.001, T['out']], [1, 0, 0, 1]) *
        np.interp(tt, [T['hush'] - 0.004, T['hush'] + 0.006, T['ding'] - 0.001, T['ding']], [1, 0.05, 0.05, 1]))[:, None]
mix = sum(stems[k] * GAIN[k] for k in stems) + wet
for c in range(2): mix[:, c] = hp(mix[:, c], 55, 4)
# the ending: 叮 and 咚 keep their full attacks (the loudest moments of the film), their sustain and the chord under
# them sit 3 dB lower, so the tail does not dominate the integrated loudness (and the two loudness meters agree)
G_END = 10 ** (-3.0 / 20)
env = np.ones(N); k = tt >= T['ding']
env[k] = np.interp(tt[k], [T['ding'], T['ding'] + 0.12, T['ding'] + 0.45, T['dong'] - 0.02, T['dong'], T['dong'] + 0.12, T['dong'] + 0.5, DUR],
                   [1, 1, G_END, G_END, 0.85, 0.85, G_END, G_END])        # 咚 a little under 叮: 叮 stays the loudest sound
mix *= env[:, None]
# master bus (STYLE §7): about −15.6 LUFS integrated (ffmpeg ebur128), sample peaks held under −4.6 dBFS by a soft
# look-ahead limiter, so the true peak stays under −3 dBTP and mux.sh's two-pass loudnorm can reach −14 LUFS linearly
import subprocess, tempfile, re
def meter(x):
    with tempfile.NamedTemporaryFile(suffix='.wav') as f:
        sf.write(f.name, x.astype(np.float32), SR)
        r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f.name, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1]), float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r)[-1])
for _ in range(3):
    mix *= 10 ** ((-15.6 - meter(mix)[0]) / 20)
    for c in range(2): mix[:, c] = sfx.limit(mix[:, c], 10 ** (-4.6 / 20), 0.004)
I_MIX, TP_MIX = meter(mix)
pk = 1.0
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
# mix.wav carries 3 s of digital silence after the picture. mux.sh's loudnorm over-weights the last ~3 s of whatever it
# measures (its look-ahead is flushed at the end); here those seconds are the 叮咚 climax, so it read the film ~0.6 LU
# louder than ebur128 does and the master landed under −14. With a silent tail the two meters agree (measured: 0.0 LU),
# and mux.sh cuts the audio to the picture's length (-shortest), so the tail never reaches the film.
TAIL = np.zeros((int(3.0 * SR), 2), np.float32)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), np.concatenate([mix.astype(np.float32), TAIL]), SR, subtype='PCM_24')
for k, v in stems.items(): sf.write(os.path.join(HERE, 'out', 'stems', k + '.wav'), (v * 0.6 / pk).astype(np.float32), SR)

# ============================== score.json: each cue's audio onset, measured from what was placed ==============================
score = {}
for name, items in CUE.items():
    on = []
    for at, x in items:
        a = np.abs(x); thr = 0.1 * a.max(); i = int(np.argmax(a > thr)); on.append(at + i / SR)
    score[name] = {'placed': min(at for at, _ in items), 'onset': min(on)}
# the two silences: the cue is the cut itself, measured on the final mix (5 ms RMS falls 12 dB under the 50 ms before)
mono = mix.mean(1)
for name in ['stop', 'hush']:
    t0 = T[name]; i0 = int((t0 - 0.06) * SR); w = int(0.005 * SR); ref = np.sqrt(np.mean(mono[i0:i0 + int(0.05 * SR)] ** 2))
    for i in range(i0 + int(0.05 * SR), i0 + int(0.2 * SR), 24):
        if np.sqrt(np.mean(mono[i:i + w] ** 2)) < ref * 0.25: score[name] = {'placed': t0, 'onset': i / SR}; break
json.dump(score, open(os.path.join(HERE, 'out', 'score.json'), 'w'), indent=1)
used = ['glockenspiel', 'tubular_bells', 'vibraphone_hard', 'vibraphone_bowed', 'hand_chimes']
open(os.path.join(HERE, 'out', 'instrument_credits.txt'), 'w').write('\n'.join(S.credits(used)) if isinstance(S.credits(used), list) else str(S.credits(used)))
print('mix', mix.shape, f'{I_MIX} LUFS, true peak {TP_MIX} dBTP, sample peak', round(float(np.abs(mix).max()), 4), 'cues', len(score))
