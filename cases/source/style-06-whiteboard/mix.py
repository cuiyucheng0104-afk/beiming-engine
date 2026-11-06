"""Score + foley + room → out/mix.wav (and out/score.json for the cue check).
Everything is placed from events.json, which carries the timeline (timeline.js) and every stroke the engine scheduled.
Score: ukulele (FreePats samples) island strum, kalimba line, glockenspiel pings, marimba taps, cello pizzicato bass,
one bowed cello note for the red light, and marker squeaks / nib ticks as the percussion section. C major, 120 BPM."""
import sys, os, json
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, bp, lp, hp, add, compress, limit
from core.audio import sampler as S
from core.audio import pluck as P

HERE = os.path.dirname(os.path.abspath(__file__))
ev = json.load(open(os.path.join(HERE, 'events.json'))); E = ev['ev']; DUR = ev['dur']
TLe = next(e for e in E if e['type'] == 'timeline'); TL = TLe['TL']; LAND = TLe['LAND']; Wn = TL['W']
BEAT, S16 = TL['BEAT'], TL['S16']
def b(bar, beat=1, n16=0): return (bar - 1) * 4 * BEAT + (beat - 1) * BEAT + n16 * S16
rng = np.random.default_rng(23); S.seed(5)
NS = int((DUR + 1.5) * SR)
mus, fol, room = (np.zeros((NS, 2), np.float32) for _ in range(3))
tt = lambda d: np.arange(int(d * SR)) / SR
def db(x): return 10 ** (x / 20)
SCORE = []                                            # (t, tag) for cuecheck
def put(buf, x, t, g=1., pan=0., tag=None):
    if t < 0 or t >= DUR + 1: return
    add(buf, np.asarray(x, np.float32), t, g, pan)
    if tag: SCORE.append({'t': round(t, 4), 'tag': tag})

# ───────── instruments
UKE = {'C': ['G4', 'C4', 'E4', 'C5'], 'Am': ['A4', 'C4', 'E4', 'A4'], 'F': ['A4', 'C4', 'F4', 'A4'], 'G': ['G4', 'D4', 'G4', 'B4']}
ROOT = {'C': 'C3', 'Am': 'A2', 'F': 'F2', 'G': 'G2'}
def strum(ch, t, vel=.7, up=False, dur=.9, pan=-.15, tag=None, g=1.):
    p = UKE[ch][::-1] if up else UKE[ch]
    put(mus, S.chord('ukulele', p, dur, vel, strum=.011 if not up else .008), t, g, pan, tag)
def chuck(ch, t, vel=.5):                             # muted strum
    put(mus, S.chord('ukulele', UKE[ch], .045, vel, strum=.006), t, .9, -.15)
def bass(ch, t, vel=.62, tag=None): put(mus, S.note('cellos_pizz', ROOT[ch], .5, vel), t, 1.0, .1, tag)
def kal(p, t, vel=.7, pan=.2, tag=None, g=1.): put(mus, S.note('kalimba', p, 1.2, vel), t, g, pan, tag)
def glock(p, t, vel=.55, pan=.3, tag=None, g=.8): put(mus, S.note('glockenspiel', p, 1.0, vel), t, g, pan, tag)
def mari(p, t, vel=.6, pan=.25, tag=None): put(mus, S.note('marimba', p, .4, vel), t, 1.0, pan, tag)

# marker percussion: a short dry-erase squeak (snare role) and a nib tick (hat role)
def squeak_hit(f0=2050, d=.085, v=1.):
    ts = tt(d); f = f0 * (1 + .025 * np.sin(2 * np.pi * 11 * ts)) * (1 - .06 * ts / d)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .35 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    x = x * np.sin(np.pi * np.minimum(1, ts / d)) ** 1.2 * .5
    x[:len(ts)] += bp(rng.standard_normal(len(ts)), 2200, 7000) * np.exp(-ts / .02) * .5
    return x * v
def nib_tick(v=1.):
    n = int(.025 * SR); return bp(rng.standard_normal(n), 2500, 8000) * np.exp(-tt(.025) / .004) * .9 * v

def groove(bar, ch, dens=1., vel=1., perc=True):
    """island strum D . D U . U D U on 8ths; dens<1 = quarter-note strums only (the slower answer section)"""
    t0 = b(bar)
    pat = [(0, 0, .74), (2, 0, .58), (3, 1, .42), (5, 1, .44), (6, 0, .58), (7, 1, .42)] if dens >= 1 else [(0, 0, .66), (2, 0, .5), (4, 0, .58), (6, 0, .5)]
    for k, up, v in pat: strum(ch, t0 + k * 2 * S16, v * vel, bool(up), tag=('strum' if k == 0 else None))
    bass(ch, t0); bass(ch, t0 + 2 * BEAT, .5)
    if perc:
        for k in range(8): put(mus, nib_tick(.55 if k % 2 else .8), t0 + k * 2 * S16, .45 * vel, .35)
        for bt in (1, 3): put(mus, squeak_hit(2000 + 120 * bt), t0 + bt * BEAT, .55 * vel, -.25)

# ───────── A. question (0 – 3.5)
groove(1, 'C', vel=.9)
strum('Am', b(2), .72); bass('Am', b(2))
for k, up, v in [(2, 0, .56), (3, 1, .42), (5, 1, .44)]: strum('Am', b(2) + k * 2 * S16, v, bool(up))
for k in range(6): put(mus, nib_tick(.5 if k % 2 else .75), b(2) + k * 2 * S16, .42, .35)
put(mus, squeak_hit(2100), b(2, 2), .5, -.25)
kal('G5', LAND['天'], .72, tag='天')
kal('E5', LAND['蓝(题)'], .75, tag='蓝(题)'); glock('E6', LAND['蓝(题)'], .5)
put(mus, S.hit('woodblock', 'a', .7), LAND['？'], .8, .2, tag='？')
# ───────── B. light (3.5 – 8)
strum('F', LAND['太阳'], .8, tag='太阳'); bass('F', b(3)); kal('A4', LAND['太阳'], .55)
for k in range(4): chuck('F', b(3) + k * S16, .45 + .05 * k)            # rays: muted chucks on 16ths
for k, up, v in [(3, 1, .42), (5, 1, .44), (6, 0, .58), (7, 1, .42)]: strum('F', b(3) + k * 2 * S16, v, bool(up))
bass('F', b(3, 3), .5, tag='白光箭头')
put(mus, squeak_hit(2150), b(3, 2), .5, -.25); put(mus, squeak_hit(2250), b(3, 4), .5, -.25)
for k in range(8): put(mus, nib_tick(.5 if k % 2 else .75), b(3) + k * 2 * S16, .42, .35)
groove(4, 'G', vel=.9)
put(mus, S.hit('woodblock', 'b', .6), LAND['白光'], .6, .2, tag='白光')
for k, p in enumerate(['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5']):       # one kalimba note per wave: red lowest, violet highest
    kal(p, Wn['waves'][k][0], .62 + .03 * k, pan=-.3 + .1 * k, tag=f'wave{k}')
# ───────── C. scatter (8 – 12)
groove(5, 'C', vel=.85)
for k, p in enumerate(['C5', 'E5', 'G5', 'D5', 'A5', 'E5', 'G5', 'C6']): mari(p, Wn['dots'][k], .62, tag=f'dot{k}')
kal('C5', LAND['空气分子'], .6, tag='空气分子')
strum('Am', b(6), .78); bass('Am', b(6), .7)
put(mus, S.note('cellos', 'A2', 1.0, .62, attack=.04, release=.3), Wn['red'][0], .75, -.35, tag='红箭头起')
put(mus, S.note('cellos_pizz', 'E3', .5, .6), LAND['红箭头'], .8, -.3, tag='红箭头')
for k, up, v in [(2, 0, .6), (3, 1, .5)]: strum('Am', b(6) + k * 2 * S16, v, bool(up))
for k in range(16):                                    # F tremolo, crescendo into the cut
    strum('F', b(6, 3) + k * S16, .38 + .035 * k, k % 2 == 1, dur=.2, g=.9)
for k in range(8): put(mus, nib_tick(.6 + .05 * k), b(6) + k * 2 * S16, .45, .35)
for k in range(8): put(mus, squeak_hit(2000 + 60 * k, .06), b(6, 3) + k * S16, .35 + .04 * k, -.25)
bass('F', b(6, 3), .7)
pent = ['C6', 'D6', 'E6', 'G6', 'A6', 'C7', 'D7']
for k, t in enumerate(LAND['蓝弹']): glock(pent[min(k, 6)], t, .55 + .04 * k, pan=.35, tag=f'bounce{k}')
for k, t in enumerate(Wn['spray']): glock(['G5', 'A5', 'C6', 'E6', 'G6', 'A6', 'C7', 'E7'][k], t, .45 + .03 * k, pan=-.35 + .1 * k, tag=f'spray{k}', g=.6)
# hard stop at 12.0 (everything before it is cut dead, with a 6 ms fade)
i0 = int(b(7) * SR); f = int(.006 * SR)
mus[i0:i0 + f] *= np.linspace(1, 0, f)[:, None]; mus[i0 + f:] = 0
# ───────── D. rewind: the scatter cue reversed and squeezed into the eraser run
a0, a1 = int(b(6) * SR), int(b(7) * SR); seg = mus[a0:a1][::-1]
k = int((Wn['erase'][1] - Wn['erase'][0]) * SR); idx = np.linspace(0, len(seg) - 1, k)
rw = np.stack([np.interp(idx, np.arange(len(seg)), seg[:, c]) for c in range(2)], 1)
rw *= (np.minimum(1, np.linspace(0, 1, k) / .05) * np.minimum(1, np.linspace(1, 0, k) / .08))[:, None]
mus[i0:i0 + k] += rw * .8; SCORE.append({'t': round(b(7), 4), 'tag': 'rewind'})
# where each reversed ping / spray glock ends inside the reversed cue (τ → 12 + (12 − τ)/2): the picture un-draws on these
rwT = lambda tau: b(7) + (b(7) - tau) * (Wn['erase'][1] - Wn['erase'][0]) / 2
for k, t in enumerate(LAND['蓝弹']): SCORE.append({'t': round(rwT(t), 4), 'tag': f'rw_bounce{k}'})
for k, t in enumerate(Wn['spray']): SCORE.append({'t': round(rwT(t), 4), 'tag': f'rw_spray{k}'})
# ───────── E. answer (13 – 17): half density
for t, ch, v in [(b(7, 3), 'F', .6), (b(7, 4), 'F', .45)]: strum(ch, t, v); bass('F', b(7, 3), .55)
for bar, ch in [(8, 'C'), (9, 'F')]:
    strum(ch, b(bar), .68, tag='strum'); strum(ch, b(bar, 2), .48); bass(ch, b(bar), .6)
    put(mus, squeak_hit(2050), b(bar, 2), .45, -.25); put(mus, squeak_hit(2150), b(bar, 4), .45, -.25)
for t, v in [(b(8, 3), .62), (b(8, 4), .46)]: strum('Am', t, v)
bass('Am', b(8, 3), .55)
strum('F', b(9, 3) - BEAT, .5); strum('F', b(9, 2, 2), .38, True)
kal('E5', LAND['蓝光'], .75, tag='蓝光')
kal('C5', LAND['波长短'], .72, tag='波长短')
kal('A4', LAND['最容易被'], .72, tag='最容易被')
glock('G5', Wn['circle'][0], .45, .35)
# 17.0: everything lands together on an unresolved G, then stops
strum('G', LAND['散射'], .8, dur=.28, tag='散射'); bass('G', LAND['散射'], .7)
kal('B4', LAND['圈蓝'], .78, tag='圈蓝'); glock('B5', LAND['圈蓝'], .55)
i1 = int((LAND['散射'] + .16) * SR); f = int(.08 * SR)
mus[i1:i1 + f] *= np.linspace(1, 0, f)[:, None]; mus[i1 + f:] = 0          # silence until the slap
# ───────── F. the slap (18.0)
T0 = Wn['slap']
strum('C', T0, .95, dur=2.0, tag='磁贴'); put(mus, S.note('cellos_pizz', 'C2', 1.2, .85), T0, 1.1, 0)
kal('C5', T0, .8); kal('G5', T0, .7, pan=.35); glock('C6', T0, .7, 0, g=.9)
put(mus, S.hit('gran_cassa', 'hit', .55), T0, .55, 0); put(mus, S.hit('sus_cymbal', 'hit', .35), T0, .35, .25)
# the full board lands on E5 (18.875), then G5 and C6 ring out over the still picture
for k, (p, t) in enumerate([('E5', Wn['full']), ('G5', Wn['full'] + BEAT / 2), ('C6', Wn['full'] + BEAT)]): kal(p, t, .55 - .05 * k, pan=.1 * k, tag=('全板' if k == 0 else None))
strum('C', Wn['full'] + BEAT, .4, dur=1.2); glock('G6', Wn['full'], .35, .3, g=.5)

# ───────── foley from the board
_band = {}
def band(n, lo, hi):
    k = (lo, hi)
    if k not in _band: _band[k] = bp(rng.standard_normal(SR * 8), lo, hi, 2).astype(np.float32)
    bb = _band[k]; i = int(rng.integers(0, len(bb) - n - 1)); return bb[i:i + n]
def marker(dur, length, pen, z=1., squeak_p=.28):
    d = max(.03, dur); n = int(d * SR); u = np.linspace(0, 1, n)
    v = 1 - .8 * np.cos(2 * np.pi * u)
    a = (v / 1.8) ** .8 * np.minimum(1, u * d / .006) * np.minimum(1, (1 - u) * d / .012)
    br = {'R': 1.1, 'B1': .92, 'B2': .95, 'K2': 1.03}.get(pen, 1.)
    x = (band(n, 2200 * br, 7500 * br) * (.55 + .45 * v / 1.8) + band(n, 500 * br, 1500 * br) * .45
         + bp((rng.random(n) < .004 * (1 + v)) * rng.standard_normal(n) * .8, 1500, 6000)) * a
    if length > 140 and rng.random() < squeak_p:
        s0 = rng.uniform(.15, .55) * d; sd = min(d - s0, rng.uniform(.06, .16))
        if sd > .03:
            m = int(sd * SR); ts = np.arange(m) / SR; f0 = rng.uniform(1500, 2600) * br
            f = f0 * (1 + .03 * np.sin(2 * np.pi * rng.uniform(7, 13) * ts))
            sq = (np.sin(2 * np.pi * np.cumsum(f) / SR) + .3 * np.sin(4 * np.pi * np.cumsum(f) / SR)) * np.sin(np.pi * ts / sd) ** 1.5 * .35
            i0_ = int(s0 * SR); x[i0_:i0_ + m] += sq[:len(x) - i0_]
    m4 = int(.004 * SR); x[:m4] += bp(rng.standard_normal(m4), 2500, 6500) * np.linspace(1, 0, m4) * 1.4
    return x * .32 * min(1.3, z ** .5)
def tap(z=1., v=1.):
    n = int(.03 * SR); return bp(rng.standard_normal(n), 1800, 6000) * np.exp(-tt(.03) / .004) * .36 * min(1.3, z ** .5) * v
def ring(fs, taus, amps, d):
    x = np.zeros(int(d * SR)); t = tt(d)
    for f_, ta, am in zip(fs, taus, amps): x += np.sin(2 * np.pi * f_ * t + rng.uniform(0, 6)) * np.exp(-t / ta) * am
    return x
def magnet_slap():
    d = .9; x = np.zeros(int(d * SR))
    c = bp(rng.standard_normal(int(.006 * SR)), 1800, 9000) * np.linspace(1, 0, int(.006 * SR)) * 1.8; x[:len(c)] += c
    x += ring([830, 1370, 2210, 3120], [.09, .06, .04, .025], [.4, .3, .18, .1], d)
    x += ring([120, 175], [.14, .08], [1.4, .6], d)
    x += lp(rng.standard_normal(len(x)), 500) * np.exp(-tt(d) / .05) * .6
    return x
def cap_on():
    d = .2; x = np.zeros(int(d * SR))
    for k, o in enumerate([0, .04]):
        i = int(o * SR); c = bp(rng.standard_normal(int(.006 * SR)), 2500, 9000) * np.linspace(1, 0, int(.006 * SR)); x[i:i + len(c)] += c * (1 - .4 * k)
        r = ring([2600], [.015], [.4], .06); x[i:i + len(r)] += r
    return x * .7
def eraser(d, env=None):
    n = int(d * SR); t = tt(d)
    base = bp(rng.standard_normal(n), 250, 2600) * .6 + bp(rng.standard_normal(n), 2500, 6000) * .15
    if env:                                                       # felt rub follows the eraser's own speed (fast at first, slowing to the origin)
        et = np.array([e[0] for e in env]) - env[0][0]; ev_ = np.array([e[1] for e in env], float)
        sp = np.interp(t, et, ev_); mod = .25 + .75 * np.clip(sp / np.percentile(ev_, 90), 0, 1) ** .6
    else: mod = .45 + .55 * np.abs(np.sin(np.pi * t / d * 8))
    return base * mod * np.minimum(1, t / .03) * np.minimum(1, (d - t) / .05) * .55
def whoosh(d, v=1.):
    n = int(d * SR); t = tt(d); return bp(rng.standard_normal(n), 300, 2400) * np.sin(np.pi * t / d) ** 2 * .35 * v
def clock_tick():
    x = np.zeros(int(.25 * SR)); c = bp(rng.standard_normal(int(.004 * SR)), 3000, 9000) * 1.2; x[:len(c)] += c
    return (x + ring([1480, 2900], [.018, .01], [.35, .15], .25)) * .22

for e in E:
    ty, t = e['type'], e['t']; pan = e.get('pan', 0); z = e.get('z', 1); off = db(-9) if e.get('on', 1) == 0 else 1
    if ty in ('write', 'stroke', 'wave', 'bounce', 'spray', 'circle'):
        g = {'write': .75, 'wave': 1.0, 'bounce': 1.1, 'spray': 1.0, 'circle': 1.2}.get(ty, 1.)
        put(fol, marker(e['dur'], e['len'], e['pen'], z, .6 if ty in ('circle', 'wave') else .28), t, off * g, pan)
    elif ty in ('tap', 'dot'): put(fol, tap(z, 1.4 if ty == 'dot' else 1.), t, off, pan)
    elif ty == 'erase': put(fol, eraser(e['dur'], e.get('env')), t, 1.3, .1)
    elif ty == 'unwrite':                                          # a stroke un-drawing: its own marker sound played backwards
        put(fol, marker(e['dur'], e['len'], e['pen'], z, .5)[::-1].copy(), t, off * .8, pan)
    elif ty == 'whip': put(fol, whoosh(e['dur'] + .1, 1.0), t - .03, 1, -.2)
    elif ty == 'capOn': put(fol, cap_on(), t, 1.1, .2)
    elif ty == 'magnet': put(fol, magnet_slap(), t, 1.4, -.1, tag='磁贴拟音')
# pens flying in / out
by_pen = {}
for e in E:
    if 'pen' in e: by_pen.setdefault(e['pen'], []).append(e)
for pen, L in by_pen.items():
    L.sort(key=lambda e: e['t'])
    put(fol, whoosh(.42, .4), L[0]['t'] - .42, 1, .4)
    for a, c in zip(L, L[1:]):
        if c['t'] - (a['t'] + a['dur']) > .75 and not (17 < a['t'] + a['dur'] < 18): put(fol, whoosh(.38, .3), a['t'] + a['dur'], 1, .5); put(fol, whoosh(.42, .4), c['t'] - .42, 1, .4)
put(fol, whoosh(.8, .25), Wn['magnetIn'], 1, -.4)                 # magnet floats in (soft air)
put(fol, whoosh(.3, .35), Wn['erase'][0] - .3, 1, .3)            # eraser arrives

# ───────── room: tone, and one wall-clock tick inside the silence
rt = lp(rng.standard_normal(NS), 900) * .010 + lp(rng.standard_normal(NS), 180) * .012
room[:, 0] += rt; room[:, 1] += np.roll(rt, 311)
put(room, clock_tick(), b(9, 4), .45, -.45)
room = S.room(room, size=.3, mix=.2)

# ───────── mix: music on top, foley ~5 dB under it (no voice), room underneath
mus = S.room(mus, size=.35, mix=.16)
def rms(x): y = x[np.abs(x).max(1) > 1e-4]; return float(np.sqrt(np.mean(y ** 2))) if len(y) else 1.
mu_r, fo_r = rms(mus), rms(fol)
mix = mus + fol * (mu_r / fo_r) * db(-5) + room * db(2)
# low-end balance: tame 20–120 Hz a little
low = (0, 0)

pk = float(np.abs(mix).max()); mix = mix / pk * .95                 # tame the crest so the master limiter has headroom
for _ in range(3): mix = np.stack([limit(mix[:, c], .36, .003) for c in range(2)], 1)
mix = np.tanh(mix / .38) * .8                     # gentle soft clip catches what slips through, then −2 dBFS
os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
fo = int(.35 * SR); mix[int(DUR * SR) - fo:int(DUR * SR)] *= np.linspace(1, 0, fo)[:, None] ** 1.5   # ring out, no click at the cut
sf.write(os.path.join(HERE, 'out/mix.wav'), mix[:int(DUR * SR)].astype(np.float32), SR)
for name, x in [('music', mus), ('foley', fol * (mu_r / fo_r) * db(-5)), ('room', room * db(2))]:
    sf.write(os.path.join(HERE, 'out/stems', name + '.wav'), x[:int(DUR * SR)].astype(np.float32), SR)
json.dump(sorted(SCORE, key=lambda s: s['t']), open(os.path.join(HERE, 'out/score.json'), 'w'), ensure_ascii=False, indent=0)
print('rms music/foley dB', round(20 * np.log10(mu_r), 1), round(20 * np.log10(fo_r), 1), 'peak', round(float(np.abs(mix).max()), 3))
print('\n'.join(S.credits(['ukulele', 'kalimba', 'glockenspiel', 'marimba', 'cellos_pizz', 'cellos', 'woodblock', 'gran_cassa', 'sus_cymbal'])))
