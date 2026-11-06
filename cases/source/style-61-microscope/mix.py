"""Score, sound design and mix for 一滴池塘水 -> out/mix.wav (48 kHz stereo) + out/stems/.

Everything reads the same clock: timeline.json (from timeline.js) for the grid and events.json (window.EV) for
every visible action, so each sound lands on its frame.

  palette  water drops (synthesised bubble resonances, tuned), hard-mallet vibraphone in 8ths -> 16ths, marimba
           ticks, bowed vibraphone and glass harp for the pads, glockenspiel ("celesta") for each level and
           each reading, a pulse bass with 2nd/3rd harmonics, timpani / bass drum / gran cassa for landings
  foley    the falling drop, the splash, satellites, the objective turret, focus servo and breaths, the focal
           sweep, pen on glass (ring, title), the striae scan with 87 ticks, the counting front with 39 ticks,
           the climb whoosh
  bed      a quiet lab room (fan, a little mains hum)
usage: $LIB/.venv/bin/python mix.py
"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt
from scipy.ndimage import uniform_filter1d, maximum_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import sfx as X

SR = X.SR
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
T = TL['T']; DUR = TL['dur']; BEAT = TL['beat']
def b(n): return n * BEAT
N = int((DUR + 1.0) * SR)
rng = np.random.default_rng(61)
S.seed(61)
MUS = np.zeros((N, 2)); PUL = np.zeros((N, 2)); HIT = np.zeros((N, 2)); FX = np.zeros((N, 2)); BED = np.zeros((N, 2))


# ------------------------------------------------------------------ dsp helpers
def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lpf(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x, axis=0)
def hpf(x, f, o=2): return sosfilt(sos('high', f, o), x, axis=0)
def bpf(x, a, c, o=2): return sosfilt(sos('band', [a, min(c, SR * .45)], o), x, axis=0)
def tv(d): return np.arange(int(round(d * SR))) / SR
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
def mi(n): return 12 * (int(n[-1]) + 1) + NOTE[n[:-1]]
def noise(d): return rng.standard_normal(int(round(d * SR)))
def put(buf, x, at, g=1.0, pan=0.0):
    x = np.asarray(x, np.float64)
    if x.ndim == 2:
        s = int(round(at * SR))
        if s >= len(buf): return
        if s < 0: x = x[-s:]; s = 0
        e = min(len(buf), s + len(x)); buf[s:e] += x[:e - s] * g
    else:
        X.add(buf, x, at, g, pan)
def pan_sweep(x, p0, p1):
    pn = np.linspace(p0, p1, len(x))
    return np.stack([x * np.cos((pn + 1) * np.pi / 4), x * np.sin((pn + 1) * np.pi / 4)], 1) * 1.414
def adsr(d, a=.005, r=.1):
    n = int(round(d * SR)); e = np.ones(n)
    na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    nr = min(n, int(r * SR)); e[n - nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e
def saw(f, d, nh=16):
    t = tv(d); x = np.zeros_like(t)
    for k in range(1, nh):
        if f * k > 12000: break
        x += np.sin(2 * np.pi * f * k * t) / k
    return x * .55


# ------------------------------------------------------------------ instruments of our own
def bubble(f0=1400, d=.16, v=1.0, rise=1.9):
    """A water drop: the Minnaert resonance of the entrained bubble, pitch rising as it shrinks to the surface."""
    t = tv(d); f = f0 * (1 + (rise - 1) * (1 - np.exp(-t / .035)))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (d * .32))
    x[:int(.0015 * SR)] *= np.linspace(0, 1, int(.0015 * SR))
    return x * v
def splash(d=.22, v=1.0):
    x = bpf(noise(d), 1800, 9000) * np.exp(-tv(d) / .045)
    y = bpf(noise(d), 400, 1400) * np.exp(-tv(d) / .02) * .5
    return (x + y) * v * .5
def glass_tap(v=1.0):
    d = .4; t = tv(d)
    ring = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / tau) for f, a, tau in ((2350, .5, .09), (3910, .3, .05), (6120, .15, .03)))
    c = hpf(noise(.006), 2500) * np.exp(-tv(.006) / .0015)
    x = ring * .3; x[:len(c)] += c
    return x * v
POST = []                                                     # transients laid in after the limiter (kept sharp)
def mallet_strike(v=1.0):
    """The head of a hard timpani mallet on a glass-topped bench: a felt thump and a short glass ring here, and a
    5 ms broadband crack that goes in after the limiter (POST) so the first sound after the silence keeps the
    hardest edge in the film as well as the most weight."""
    d = .35; t = tv(d)
    thump = np.sin(2 * np.pi * (95 + 60 * np.exp(-t / .01)) * t) * np.exp(-t / .045)
    thump[:int(.0008 * SR)] *= np.linspace(0, 1, int(.0008 * SR))
    ring = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / tau) for f, a, tau in ((1870, .5, .07), (3120, .3, .04), (4950, .18, .025)))
    return (thump * .6 + ring * .12) * v
def crack():
    c = hpf(noise(.006), 1200, 4) * np.exp(-tv(.006) / .0013)
    return c / np.abs(c).max()
def bass(m, d, vel=.8, cut=420):
    f = hz(m); x = saw(f, d) * .7 + np.sin(2 * np.pi * f * tv(d)) * .9
    x = lpf(x, cut) + .14 * np.tanh(3 * lpf(x, 900))           # 2nd/3rd harmonics speak on small speakers
    return x * adsr(d, .01, min(.2, d * .45)) * vel
def objective_click(up=True, v=1.0):
    d = .5; t = tv(d)
    c1 = hpf(noise(.012), 1800) * np.exp(-tv(.012) / .002)
    c2 = bpf(noise(.03), 600, 3000) * np.exp(-tv(.03) / .006) * .7
    ring = sum(a * np.sin(2 * np.pi * f * (1.03 if up else .97) * t) * np.exp(-t / tau)
               for f, a, tau in ((2140, .5, .06), (3420, .35, .045), (5230, .2, .03)))
    x = np.zeros(int(d * SR)); x[:len(c1)] += c1; s = int(.036 * SR); x[s:s + len(c2)] += c2; x += ring * .25
    return x * .85 * v
def servo(d, up=True, v=1.0):
    t = tv(d); f0, f1 = (700, 1500) if up else (1400, 650)
    f = f0 + (f1 - f0) * t / d
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .3 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    return x * np.sin(np.pi * t / d) ** 2 * .05 * v
def breath(d=.5, v=1.0):
    t = tv(d); x = bpf(noise(d), 500, 3500) * np.sin(np.pi * t / d) ** 2
    return x * .09 * v
def pen(d, v=1.0):
    x = bpf(noise(d), 2500, 9000) * (0.6 + 0.4 * np.abs(np.sin(np.pi * tv(d) * 23)))
    return x * adsr(d, .03, .1) * .16 * v
def scan(d, lo=1800, hi=5000):
    t = tv(d); x = noise(d); y = np.zeros_like(x)
    for i in range(0, len(x), 2048):
        fc = lo + (hi - lo) * (i / len(x)); y[i:i + 2048] = bpf(x[i:i + 2048], fc * .7, fc * 1.4)
    return y * np.sin(np.pi * np.clip(t / d, 0, 1)) ** .6 * .14
def whoosh(d, v=1.0, rev=False):
    t = tv(d); x = noise(d); y = np.zeros_like(x)
    for i in range(0, len(x), 2048):
        fc = 300 + 2600 * np.sin(np.pi * i / len(x)); y[i:i + 2048] = bpf(x[i:i + 2048], fc * .6, fc * 1.6)
    y = y * np.sin(np.pi * t / d) ** 2 * .25 * v
    return y[::-1] if rev else y
def riser(d, v=1.0):
    t = tv(d); f = 320 * 2 ** (2.2 * t / d)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .22 + lpf(hpf(noise(d), 2500), 8000) * .035
    return x * (t / d) ** 2 * v * .5


# ------------------------------------------------------------------ the score (90 BPM, D, open voicings)
def vib(n, at, d=.3, vel=.4, g=.55, pan=0., inst='vibraphone_hard'):
    put(MUS, S.note(inst, mi(n) if isinstance(n, str) else n, d, vel=vel), at, g, pan)
def pad(notes, at, d, vel=.36, g=.5, rel=.9):
    for k, n in enumerate(notes):
        put(MUS, S.note('vibraphone_bowed', mi(n), d, vel=vel, release=rel), at, g, -.45 + .9 * k / max(1, len(notes) - 1))
def glassn(n, at, d=1.6, vel=.5, g=.8, pan=0.):
    put(MUS, S.note('glass', mi(n), d, vel=vel), at, g, pan)
def glock(n, at, vel=.55, g=.7, pan=.1, d=1.6):
    put(HIT, S.note('glockenspiel', mi(n), d, vel=vel), at, g, pan)

def score():
    # A — the drop (b0–b4.5): bowed pad, glass harmonics, a few tuned drops, soft marimba
    pad(['A3', 'D4', 'E4'], b(0), b(4.6), .3, .5)
    glassn('A5', b(1), 2.4, .32, .5, .35); glassn('E5', b(3), 1.6, .26, .45, -.3)
    for k, (n, bb) in enumerate((('D6', 2), ('A5', 2.5), ('E6', 3.5))):
        put(MUS, bubble(hz(mi(n)) / 1.35, .18, .5, rise=1.35), b(bb), .5, (-.4, .3, .1)[k])
    for i in range(5):
        put(MUS, S.note('marimba', mi(('D5', 'A4', 'E5', 'A4', 'F#5')[i]), .25, vel=.24), b(2 + i * .5), .4, .4 - .2 * i)
    # B — the dive (b4.5–b12): pedal D, vibraphone 8ths -> 16ths, pulse bass from b6, one rising note per level
    arp1 = ['D4', 'A4', 'E5', 'A4']; arp2 = ['E4', 'B4', 'F#5', 'B4']; arp3 = ['A4', 'E5', 'F#5', 'C#6']
    for i in range(int((6 - 4.5) * 2)): vib(arp1[i % 4], b(4.5 + i * .5), .3, .34 + .03 * i, .5, .35 * np.sin(i))
    for i in range(6): vib(arp2[i % 4], b(6 + i * .5), .3, .4, .52, .35 * np.sin(i + 1))
    for i in range(12): vib(arp3[i % 4], b(9 + i * .25), .2, .36 + .02 * (i % 4 == 0) + .012 * i, .5, .4 * np.sin(i * 1.3))
    pad(['B3', 'E4', 'F#4'], b(6), b(3.1), .3, .42)
    pad(['A3', 'C#4', 'E4', 'F#4'], b(9), b(3.1), .32, .42)
    for i in range(12): put(PUL, bass(38, BEAT / 2 * .85, .5 + .2 * (i % 2 == 0)), b(6 + i * .5))
    for bb, n, gl in ((6, 'A4', 'A5'), (9, 'D5', 'D6'), (12, 'F#5', 'F#6')):   # the ascending ladder
        vib(n, b(bb), 1.4, .62, .8, 0, 'vibraphone')
        glock(gl, b(bb), .5, .55)
    # C — sweep and ring (b12–b18): half time, bowed pad, quiet marimba 16ths
    pad(['B3', 'D4', 'F#4', 'C#5'], b(12), b(4.2), .34, .5)      # Gmaj7#11 colour over the G below
    put(PUL, bass(31, b(4) * .95, .5, 300), b(12))
    pad(['B3', 'D4', 'F#4', 'A4'], b(16), b(2.0), .3, .46)       # Em9 colour
    put(PUL, bass(40, b(2) * .9, .42, 300), b(16))
    for i in range(16): put(MUS, S.note('marimba', mi(('D6', 'B5', 'F#5', 'B5')[i % 4]), .15, vel=.2), b(12 + i * .25 + 1.0), .3, .5 * np.sin(i))
    # silence b18–b20
    # D — counting (b20–b24): Bm9 -> G6/9 -> A, vibraphone 16ths back
    pad(['B3', 'D4', 'F#4', 'C#5'], b(20), b(2.1), .4, .55)
    pad(['B3', 'D4', 'E4', 'A4'], b(22), b(2.1), .36, .5)
    put(PUL, bass(35, b(2) * .95, .62, 320), b(20)); put(PUL, bass(31, b(2) * .95, .6, 320), b(22))
    arp4 = ['F#4', 'B4', 'C#5', 'D5']; arp5 = ['G4', 'B4', 'D5', 'E5']
    for i in range(12):                                           # 16ths under the count, growing
        vib((arp4 if i < 4 else arp5)[i % 4], b(21 + i * .25), .2, .32 + .018 * i, .48, .4 * np.sin(i * 1.7))
    # E — climb and title (b24–b29.5): D major lands, two falling notes, the final chord
    pad(['A3', 'D4', 'F#4', 'A4'], b(24), b(3.0), .36, .5)
    put(PUL, bass(38, b(3) * .95, .55, 300), b(24))
    vib('D5', b(24.5), 1.2, .5, .7, -.2, 'vibraphone'); vib('A4', b(25), 1.4, .48, .7, .2, 'vibraphone')
    pad(['A3', 'D4', 'E4', 'A4'], b(27), b(2.6) + .6, .38, .55, rel=1.4)
    put(PUL, bass(38, b(2.5) + .4, .55, 260), b(27))
    for k, (n, dt) in enumerate((('A5', 0), ('D6', .5), ('E6', 1.0), ('A5', 1.75))):
        glassn(n if mi(n) <= mi('F6') else 'D5', b(27 + dt), 2.0, .42 - .05 * k, .7, -.3 + .2 * k)
    put(MUS, bubble(hz(mi('A5')) / 1.35, .2, .45, rise=1.35), b(28.5), .45, .2)


# ------------------------------------------------------------------ foley from the page's events
def foley():
    for e in EV:
        t = e['t']; ty = e['type']
        if ty == 'fall':
            put(FX, whoosh(e['dur'] + .05, .35), t, .8, 0)
        elif ty == 'drop':
            put(HIT, bubble(1250, .2, 1.0, 1.7), t, .55, -.05)
            put(FX, splash(.25, 1.0), t, .9, 0); put(FX, glass_tap(.5), t, .5, 0)
            put(HIT, S.hit('timpani', 'drum3', .22), t, .25, 0)
        elif ty == 'satellite':
            for k, dt in enumerate((0, .028, .061)):
                put(FX, bubble(2400 + 500 * k, .07, .4, 1.4), t + dt, .35, (-.5, .45, .1)[k])
        elif ty == 'dive':
            put(FX, servo(b(1.5), True, 1.0), t, .9, 0); put(FX, riser(b(7.5), .9), t, .7, 0)
        elif ty == 'level':
            put(FX, objective_click(True), t, 1.0, .25); put(FX, servo(.22, True, .8), t + .06, .8, .25)
            if e['z'] == 400:
                put(HIT, S.hit('timpani', 'drum2', .55), t, .8, 0); put(HIT, S.hit('bass_drum', None, .45), t, .5, 0)
        elif ty == 'breath':
            put(FX, breath(.5, 1.0), t - .25, 1.0, 0); put(FX, servo(.35, True, .6), t - .1, .7, -.2)
        elif ty == 'sweep':
            d = e['dur']; x = bpf(noise(d), 1200, 7000) * np.sin(np.pi * tv(d) / d) ** 1.5 * .11
            put(FX, pan_sweep(x, -.8, .8), t, 1.0)
        elif ty == 'ring':
            put(FX, pen(e['dur'], 1.0), t, 1.0, .25)
        elif ty == 'scan':
            put(FX, pan_sweep(scan(e['dur']), -.6, .6), t, .9)
        elif ty == 'stria':
            put(FX, X.click(1.8, .22), t, .3, -.4 + .8 * (t - T['scan0']) / (T['land1'] - T['scan0']))
        elif ty == 'land':
            glock('B5', t, .6, .75); glock('D6', t, .45, .5, -.2)
            put(HIT, S.hit('timpani', 'drum2', .42), t, .5, 0)
        elif ty == 'first':                                       # the first sound after the silence: the most important one
            put(HIT, S.hit('timpani', 'drum1', .8), t, .8, 0)
            put(HIT, mallet_strike(1.0), t, 1.0, 0); POST.append((t, crack(), .82))   # the sharpest attack in the film
            put(HIT, S.hit('gran_cassa', 'hit', .6), t, .5, 0)
            put(HIT, bubble(520, .5, 1.0, 1.6), t, .55, 0)
            glock('F#5', t, .6, .7, .1, 2.4); glock('C#6', t + .02, .4, .45, -.2, 2.0)
            put(FX, whoosh(b(1), 1.0), t, .8, 0); put(FX, objective_click(False, .8), t + b(.5), .7, -.25)
        elif ty == 'count':
            put(FX, pan_sweep(scan(e['dur'], 1500, 6000) * 1.1, -.65, .65), t, .9)
        elif ty == 'mark':
            k = (t - T['count0']) / (T['land2'] - T['count0'])
            put(HIT, S.note('marimba', mi('B6') if k < .5 else mi('D7'), .08, vel=.35 + .25 * k), t, .3, -.55 + 1.1 * k)
            put(FX, X.click(1.5 + k, .3), t, .3, -.55 + 1.1 * k)
        elif ty == 'land2':
            for n, g, p in (('D6', .7, 0), ('F#6', .5, -.25), ('A6', .45, .25)): glock(n, t, .6, g, p, 2.2)
            put(HIT, S.hit('bass_drum', None, .55), t, .65, 0); put(HIT, S.hit('timpani', 'drum2', .45), t, .45, 0)
        elif ty == 'climb':
            put(FX, whoosh(e['dur'] + .35, 1.2, rev=True), t, 1.0, 0)
        elif ty == 'objective':
            put(FX, objective_click(False, .75), t, .8, -.25)
        elif ty == 'title':
            for i in range(e['n']):
                put(FX, pen(max(.2, e['step'] * 1.4), .9), t + i * e['step'], 1.0, -.3 + .15 * i)
        elif ty == 'final':
            put(HIT, S.hit('sus_cymbal', 'bow', .28), t - .1, .3, 0)
            put(HIT, S.hit('bass_drum', None, .3), t, .35, 0)


def beds():
    d = N / SR
    fan = lpf(noise(d), 380) * .05 + bpf(noise(d), 900, 2400) * .006
    hum = np.sin(2 * np.pi * 100 * tv(d)) * .004 + np.sin(2 * np.pi * 150 * tv(d)) * .002
    x = (fan + hum)[:N]
    BED[:len(x), 0] += x; BED[:len(x), 1] += np.roll(x, 311)


def lufs_like(x):
    y = hpf(x, 60); y = y + .58 * hpf(y, 1500)
    w = int(.4 * SR); n = len(y) // w
    ms = (y[:n * w].reshape(n, w, -1) ** 2).mean((1, 2)); ms = ms[ms > 10 ** (-70 / 10)]
    rel = ms[ms > ms.mean() * 10 ** (-10 / 10)]
    return -0.691 + 10 * np.log10(rel.mean() + 1e-12)


def act(x):
    m = np.abs(x).mean(1); w = int(.05 * SR); n = len(m) // w; r = np.sqrt((m[:n * w].reshape(n, w) ** 2).mean(1))
    on = r > 10 ** (-40 / 20) * r.max(); return float(np.sqrt((r[on] ** 2).mean()))


def main():
    score(); foley(); beds()
    mus = S.room(MUS, .55, .22); pul = PUL.copy(); hit = S.room(HIT, .6, .24); fx = S.room(FX, .3, .12); bed = BED.copy()
    # the silence (b18–b20): music, pulse, hits and foley fall away; only the room stays
    i0, i1 = int(T['hush'] * SR), int((T['first'] - .004) * SR); f = int(.09 * SR)
    g = np.ones(N); g[i0:i0 + f] = np.linspace(1, .0, f); g[i0 + f:i1] = 0.0
    for buf in (mus, pul, fx, hit): buf *= g[:, None]
    ref = act(mus)
    tg = {'music': 0, 'pulse': -4, 'fx': -5, 'hits': 1, 'beds': -30}
    stems = {}
    for k, x in (('music', mus), ('pulse', pul), ('fx', fx), ('hits', hit), ('beds', bed)):
        stems[k] = x * (ref * 10 ** (tg[k] / 20) / act(x))
    shelf = 10 ** (-4 / 20)
    for k in ('music', 'pulse', 'hits', 'beds', 'fx'):
        x = hpf(stems[k], 38, 2); stems[k] = x - (1 - shelf) * lpf(x, 62, 2)
    bus = stems['music'] + stems['pulse'] + stems['fx'] + stems['beds']
    lvl = np.sqrt(uniform_filter1d((bus ** 2).max(1), int(.012 * SR)))
    thr = 10 ** (-10 / 20) * np.percentile(lvl, 99.9)
    gg = np.where(lvl > thr, (thr + (lvl - thr) / 2.5) / np.maximum(lvl, 1e-9), 1.0)
    gg = uniform_filter1d(-maximum_filter1d(-gg, int(.008 * SR)), int(.03 * SR))
    mix = bus * gg[:, None] + stems['hits']
    mix = mix[:int(round(DUR * SR))]
    fade = int(1.0 * SR); mix[-fade:] *= (np.linspace(1, 0, fade) ** 1.5)[:, None]
    I = lufs_like(mix); mix *= 10 ** ((-15.0 - I) / 20)
    pk = lambda tt: np.abs(mix[int(tt * SR) - 48:int(tt * SR) + 4800]).max()
    print('pre-limit peaks: first %.2f  x400 %.2f  x100 %.2f  overall %.2f' % (pk(T['first']), pk(T['x400']), pk(T['x100']), np.abs(mix).max()))
    if np.abs(mix).max() > .7: mix = np.stack([X.limit(mix[:, 0], .7), X.limit(mix[:, 1], .7)], 1)
    for at, x, pkv in POST:                                       # post-limiter transients, peak pkv per channel
        s0 = int(round(at * SR)); nd = int(.008 * SR)             # the body steps aside for 8 ms so the crack sits clear
        mix[s0:s0 + nd] *= (.25 + .75 * np.linspace(0, 1, nd) ** 2)[:, None]
        mix[s0:s0 + len(x)] += (x * pkv)[:, None]
    os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
    sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR)
    for name, x in stems.items():
        sf.write(os.path.join(HERE, 'out/stems', name + '.wav'), x[:int(round(DUR * SR))].astype(np.float32), SR)
    from numpy.fft import rfft, rfftfreq
    m = mix.mean(1); Fq = rfftfreq(len(m), 1 / SR); Pw = np.abs(rfft(m)) ** 2
    lo = Pw[(Fq > 20) & (Fq < 120)].sum(); rest = Pw[(Fq >= 120) & (Fq < 16000)].sum()
    a, c = int(T['hush'] * SR) + int(.3 * SR), int(T['first'] * SR) - 10
    sil = 20 * np.log10(np.sqrt(np.mean(mix[a:c] ** 2)) + 1e-12); loud = 20 * np.log10(np.sqrt(np.mean(mix ** 2)))
    print(f'mix: approx {lufs_like(mix):.1f} LUFS, peak {np.abs(mix).max():.2f}, low/rest {10 * np.log10(lo / rest):.1f} dB, '
          f'silence {sil:.1f} dBFS vs mean {loud:.1f} dBFS')


if __name__ == '__main__':
    main()
