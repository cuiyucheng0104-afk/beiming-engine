"""Foley (glass, lead, solder, air, fire, stone hall) from events.json + score stems -> out/mix.wav
Every sound sits on its event time from window.EV; the silence (shatter -> first weld) is enforced here too.
Run: $LIB/.venv/bin/python mix.py"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, limit, add
from scipy.signal import fftconvolve
D = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(D, 'timeline.json'))); T = TL['T']; BEAT = TL['BEAT']
E = json.load(open(os.path.join(D, 'events.json'))); DUR = E['dur']; ev = [e for e in E['ev'] if e['type'] != 'cue']
N = int(round(DUR * SR))
fx = np.zeros((N, 2)); dry = np.zeros((N, 2)); small = np.zeros((N, 2)); amb = np.zeros((N, 2))
rng = np.random.default_rng(20)

def hall_ir(d=2.8, damp=2600, pre=.02):
    n = int(d * SR); e = np.exp(-np.arange(n) / SR / (d / 6.9))
    ir = np.stack([lp(rng.standard_normal(n), damp) * e, lp(rng.standard_normal(n), damp) * e], 1)
    ir = np.concatenate([np.zeros((int(pre * SR), 2)), ir]); ir[0] = 1; return ir / np.abs(ir).sum(0) * 5
def verb(x, ir, mix=.3):
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1); return x * (1 - mix) + y * mix
HALL = hall_ir()

# ---------------- material foley ----------------
def glass_tink(v=1., f0=None, d=1.2, bright=1.):
    """struck glass: inharmonic partials 1 : 2.32 : 4.25 : 6.63 : 9.38"""
    f0 = f0 or rng.uniform(2300, 3400); t = t_(d); y = np.zeros_like(t)
    for r, a, tau in [(1, 1, .5), (2.32, .6, .32), (4.25, .38, .2), (6.63, .22, .12), (9.38, .12, .07)]:
        y += a * np.sin(2 * np.pi * f0 * r * t + rng.uniform(0, 6)) * np.exp(-t / (tau * d))
    y += .25 * hp(noise(d), 5000) * np.exp(-t / .004) * bright
    return y * v * .35
def glass_crack(v=1., n_t=26, d=2.2, low=1.):
    t = t_(d); y = np.zeros_like(t)
    y += hp(noise(d), 1500) * np.exp(-t / .03) * 1.2                         # the snap
    y += bp(noise(d), 160, 900) * np.exp(-t / .06) * .9 * low                 # thump of the pane
    for k in range(n_t):                                                      # the crack running + a rain of tinkles
        at = rng.uniform(0, .25) if k < n_t // 2 else rng.uniform(.18, d * .65); n0 = int(at * SR)
        s = glass_tink(rng.uniform(.25, .8) * (1 if k < n_t // 2 else .5), rng.uniform(2500, 6400), rng.uniform(.25, .7))
        y[n0:n0 + len(s)] += s[:len(y) - n0]
    return y * v
def shatter(v=1.):
    d = 3.2; t = t_(d); y = glass_crack(1.3, 60, d, 1.4)
    y += np.sin(2 * np.pi * 52 * t * (1 - .2 * t)) * np.exp(-t / .22) * .9    # body blow
    y += lp(noise(d), 300) * np.exp(-t / .12) * .7
    return y * v
def lead_creak(d=1.0, v=1.):
    t = t_(d); rate = 18 + 10 * np.sin(2 * np.pi * .7 * t); ph = np.cumsum(rate) / SR
    pulses = (np.sin(2 * np.pi * ph) > .92).astype(float)
    return bp(pulses * noise(d) * .7 + pulses * .6, 260, 1400) * np.sin(np.pi * t / d) ** .5 * v
def grind(d=1.0, v=1.):
    """glass edge sliding along a came: gritty band noise + faint squeal"""
    t = t_(d); e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** .7
    y = bp(noise(d), 1800, 5200) * .5 * (1 + .6 * np.sin(2 * np.pi * 23 * t))
    y += .12 * np.sin(2 * np.pi * (1900 + 200 * np.sin(2 * np.pi * 1.3 * t)) * t) * e
    return y * e * v
def weld(v=1., f0=3000):
    d = .8; t = t_(d); y = hp(noise(d), 3500) * np.exp(-t / .14) * .5            # solder hiss
    y[:int(.012 * SR)] += hp(noise(.012), 2000) * 1.2                             # tick
    g = glass_tink(.5, f0, .6); y[:len(g)] += g[:len(y)]
    return y * v
def air(d=1.2, v=1., lo=300, hi=2400, shape=1.5):
    t = t_(d); e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** shape
    return bp(noise(d), lo, hi) * e * v * .5
def swell(d=1.0, v=1., lo=150, hi=1800):   # rises into its end
    t = t_(d); e = (t / d) ** 2.2
    return bp(noise(d), lo, hi) * e * v * .6
def whoosh(d=.4, v=1.):
    t = t_(d); out = np.zeros_like(t); n = noise(d)
    for i in range(0, len(n), 480):
        hi = min(len(n), i + 480); f = 500 + 2800 * (i / len(n)); out[i:hi] = bp(n[max(0, i - 2000):hi], f * .7, f * 1.3)[-(hi - i):]
    return out * np.sin(np.pi * t / d) ** 2 * v
def wing_glass(v=1.):
    """a glass wing moving in its leads: short grind + a soft clack + air"""
    y = np.zeros(int(.6 * SR)); g = grind(.22, .6); y[:len(g)] += g
    c = glass_tink(.4, rng.uniform(1700, 2100), .4, .4); y[int(.19 * SR):int(.19 * SR) + len(c)] += c[:len(y) - int(.19 * SR)]
    a = air(.35, .9, 200, 1500); y[:len(a)] += a
    return y * v
def ignite(v=1., d=2.0):
    t = t_(d); sub = np.sin(2 * np.pi * 48 * t * (1 - .25 * t)) * np.exp(-t / .45)
    return (sub * .9 + lp(noise(d), 1400) * np.exp(-t / .3)) * v
def fire_bed(d, v=1.):
    t = t_(d); e = np.clip(t / .3, 0, 1) * (.75 + .45 * t / d)
    cr = (rng.random(len(t)) > .9992).astype(float) * rng.uniform(.3, 1, len(t))
    roar = lp(brown(d), 600) * .5 * (1 + .3 * np.sin(2 * np.pi * 3.1 * t))
    return (bp(cr, 1200, 7000) * 3 + roar) * e * v
def iron_tick(v=1.):
    d = .3; t = t_(d)
    return (sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / tau) for f, a, tau in [(2870, 1, .03), (4410, .6, .02), (6210, .3, .012)]) + hp(noise(d), 3000) * np.exp(-t / .002)) * v * .5
def bird(v=1.):
    d = .5; out = np.zeros(int(d * SR))
    for k in range(3):
        n = int(.06 * SR); tt = np.arange(n) / SR; f = 3600 + 1400 * np.sin(np.pi * tt / .06) + rng.uniform(-200, 200)
        s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / .06) ** 2; o = int(k * .12 * SR); out[o:o + n] += s
    return out * v * .3

# ---------------- events ----------------
pane_f = [2400, 2600, 2750, 2950, 3150, 3300, 3500]
for e in ev:
    t0, k = e['t'], e['type']
    if k == 'pane':    add(fx, air(.9, .55, 400, 3200, 2), t0 - .05, .7, -.5 + e['i'] * .16); add(fx, glass_tink(.35, pane_f[e['i']], .9, .3), t0, .55, -.5 + e['i'] * .16)
    elif k == 'reveal': add(fx, air(1.6, .8, 250, 2600), t0 - .08, .8); add(fx, glass_tink(.4, 1980, 1.6, .2), t0, .5)
    elif k == 'lift':   add(fx, air(.4, .7, 300, 2000), t0, .6, -.2)
    elif k == 'flap':   add(fx, wing_glass(1.0), t0 - .19, .9, -.15)
    elif k == 'air':    add(fx, air(e['d'] + .3, .9, 180, 1600, 1.2), t0, .8, .1)
    elif k == 'glare':  add(fx, air(1.0, .5, 1500, 6000, 2), t0 - .04, .5)
    elif k == 'patch':  add(fx, swell(e['d'], .7, 120, 900), t0, .8); add(fx, air(e['d'] + .4, .5, 300, 1800), t0, .6, .3)
    elif k == 'whip':   add(fx, whoosh(e['d'] + .05, 1.0), t0, .85, .2)
    elif k == 'ignite': add(fx, ignite(1.0), t0, .9)
    elif k == 'fire':   add(fx, fire_bed(e['d'], .45), t0, .9, .1)
    elif k == 'crack':  add(fx, glass_crack(1.0 + .06 * e['i'], 22 + 3 * e['i']), t0 - .003, .8, [-.3, .35, -.1, .4, 0, -.35][e['i']])
    elif k == 'shatter': add(dry, shatter(1.0), t0 - .003, 1.5)     # its own ring is the only sound in the silence
    elif k == 'tinkle': add(small, glass_tink(.35, rng.uniform(3800, 5600), .5), t0, .3 if e['i'] == 0 else .05, rng.uniform(-.6, .6))
    elif k == 'tick':   add(small, iron_tick(.8), t0, .06, .4)
    elif k == 'weld0':  add(fx, weld(1.0, 2350), t0, 1.0)
    elif k == 'creak':  add(fx, lead_creak(e['d'] + .2, .6), t0, .6, -.1)
    elif k == 'slide':  add(fx, grind(e['d'], .45), t0, .55, rng.uniform(-.3, .3)); add(fx, lead_creak(e['d'], .4), t0, .5)
    elif k == 'weld':   add(fx, weld(.9, 2600 + 120 * e['i']), t0, .75, rng.uniform(-.3, .3))
    elif k == 'sweep':  add(fx, air(e['d'] + .3, .5, 400, 3000, 2), t0, .5, .1)
    elif k == 'blaze':  add(fx, swell(BEAT * .5, 1.0, 150, 2500), t0 - BEAT * .5, .9); add(fx, air(2.4, .7, 200, 3000, .8), t0, .7)
    elif k == 'birds':
        for j in range(3): add(amb, bird(.9), t0 + j * .45, .35, rng.uniform(-.7, .7))

# ---------------- ambience: a large stone hall ----------------
tt = t_(DUR)
room = lp(brown(DUR), 360) * .07 + bp(noise(DUR), 400, 1600) * .004
amb[:, 0] += room; amb[:, 1] += np.roll(room, 311)
for at in (.35, 1.2):   # birds in the vault at dawn
    add(amb, bird(.6), at, .25, rng.uniform(-.7, .7))

fx = verb(fx, HALL, .36)
dry = verb(dry, hall_ir(3.2, 3000, .015), .42)
small = verb(small, hall_ir(2.4, 3500, .015), .45)
# the break rings out, then decays toward silence (only small sounds remain inside it)
j0 = int((T['shatter'] + .3) * SR); tt2 = np.arange(N - j0) / SR; dry[j0:] *= np.maximum(np.exp(-tt2 / .055), 0)[:, None]   # the rain is gone ~0.35 s after the break
dry = dry + small
amb = verb(amb, HALL, .3)

# ---------------- score ----------------
def stem(n):
    a, sr = sf.read(os.path.join(D, 'music', 'stems', n + '.wav')); b = np.zeros((N, 2)); b[:min(N, len(a))] = a[:N]; return b
gains = {'drone': 1.0, 'chime': .9, 'recorder': 1.3, 'fire': 1.0, 'mend': 1.0, 'bell': 3.6, 'choir': 1.4, 'sub': .15}   # bell +2.8 dB: the first sound after the silence
mus = sum(stem(n) * g for n, g in gains.items())
mus = mus + .9 * lp(mus.T, 110).T   # low shelf ~+5.5 dB under 110 Hz: organ pedal D2, timpani, the bells' body

# ---------------- the silence: hard stop at the break, only the glass's own ring until the first weld ----------------
i0, i1 = int(round(T['shatter'] * SR)), int(round(T['firstWeld'] * SR)); f = int(.004 * SR)
for x in (fx, amb):
    x[i0 - f:i0] *= np.linspace(1, 0, f)[:, None]; x[i0:i1] = 0
amb[i1:i1 + int(1.2 * SR)] *= np.linspace(0, 1, int(1.2 * SR))[:, None]   # the hall comes back slowly

mix = mus * 1.0 + fx * .85 + dry * 1.0 + amb * 1.0
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
os.makedirs(os.path.join(D, 'out'), exist_ok=True)
sf.write(os.path.join(D, 'out', 'mix.wav'), mix.astype(np.float32), SR)
def rms(x): return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
for nm, a, c in [('dawn', 0, T['reveal']), ('phoenix', T['reveal'], T['ignite']), ('fire', T['ignite'], T['shatter']), ('silence', T['shatter'] + .9, T['firstWeld']),
                 ('first weld', T['firstWeld'], T['firstWeld'] + .5), ('mend', T['firstWeld'], T['blaze']), ('noon', T['blaze'], DUR)]:
    s0, s1 = int(a * SR), int(c * SR); print(f'{nm:11s} mix {rms(mix[s0:s1]):6.1f} dB   music {rms(mus[s0:s1]):6.1f}   fx {rms(fx[s0:s1] + dry[s0:s1]):6.1f}')
# low-end balance: 20-120 Hz vs the rest
from scipy.signal import welch
fr, P = welch(mix.mean(1), SR, nperseg=8192); lo = P[(fr >= 20) & (fr < 120)].sum(); rest = P[(fr >= 120) & (fr < 8000)].sum()
print('low/rest energy', round(10 * np.log10(lo / rest), 1), 'dB   peak', round(float(np.abs(mix).max()), 3))
