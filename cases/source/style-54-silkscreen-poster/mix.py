"""mix.py — ambience + foley (driven by events.json from window.EV) + score → out/mix.wav
Materials: squeegee = rubber blade on nylon mesh (mid-high hiss with 220–280 Hz mesh grain, faster = brighter);
ink = wet sticky low gloop; screen = aluminium frame + hinge; registration clamp = wood + metal; paper = dry mids.
"""
import json, os, sys
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, os.path.join(LIB, 'core/audio'))
from sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, clack, creak, thump, whoosh, limit, add

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
grid = next(e for e in E['ev'] if e['type'] == 'grid'); Bs = grid['beat']
DUR = E['dur'] + 1.0; N = int(DUR * SR); tt = np.arange(N) / SR
rng = np.random.default_rng(54)
amb = np.zeros((N, 2)); fol = np.zeros((N, 2))
ev = E['ev']
def at(tp, **kw): return next(e['t'] for e in ev if e['type'] == tp and all(e.get(k) == v for k, v in kw.items()))

# ---------- foley building blocks ----------
def scrape(d, v=1.0, bright=1.0, heavy=0.0, attack=.02):
    n = noise(d); x_t = t_(d)
    grain = .62 + .38 * np.abs(np.sin(2 * np.pi * (220 + 60 * bright) * x_t + rng.random() * 6)) ** 2
    x = bp(n, 650 * bright, min(9000, 5000 * bright), 2) * grain + lp(noise(d), 380) * (.5 + heavy) * .6
    e = np.minimum(1, x_t / max(attack, 1e-3)) * np.minimum(1, (d - x_t) / .05) * (1 - .2 * x_t / d)
    return norm(x * e) * v
def squelch(v=1.0, f=140):
    d = .16; x_t = t_(d)
    return norm(np.sin(2 * np.pi * f * x_t * (1 - .9 * x_t)) * env_exp(d, .05) + lp(noise(d), 900) * env_exp(d, .03) * .5) * v
def gloop(d=.35, v=1.0):
    x_t = t_(d); bub = sum(np.sin(2 * np.pi * (180 + 60 * k) * x_t * (1 - .6 * x_t)) * np.exp(-((x_t - .05 * k) ** 2) / .0006) for k in range(5))
    return norm(lp(noise(d), 700) * np.sin(np.pi * x_t / d) * .6 + bub) * v
def tick(v=1.0, f=3200):
    d = .03; x_t = t_(d)
    return norm(hp(noise(d), 2500) * env_exp(d, .003) + np.sin(2 * np.pi * f * x_t) * env_exp(d, .004) * .4) * v
def stamp(v=1.0):
    d = .14; x_t = t_(d)
    return norm(lp(noise(d), 1200) * env_exp(d, .012) + np.sin(2 * np.pi * 160 * x_t) * env_exp(d, .03) * .7 + bp(noise(d), 2500, 6000) * env_exp(d, .006) * .4) * v
def paperslide(d=.4, v=1.0):
    x_t = t_(d); return norm(bp(noise(d), 900, 4200) * (.7 + .3 * np.sin(2 * np.pi * 31 * x_t)) * np.sin(np.pi * x_t / d) ** 2) * v
def peel(d=.32, v=1.0):
    """Mesh lifting off wet ink: sticky crackle."""
    x_t = t_(d); cr = (rng.random(len(x_t)) > .985) * rng.standard_normal(len(x_t)) * 3
    return norm(bp(cr + noise(d) * .15, 1500, 7000) * np.sin(np.pi * x_t / d)) * v
def regclack(v=1.0):
    d = .7; x_t = t_(d)
    wood = sum(a * np.sin(2 * np.pi * f * x_t) * env_exp(d, tau) for f, a, tau in [(520, 1, .03), (1180, .6, .02), (240, .8, .05)])
    metal = sum(a * np.sin(2 * np.pi * f * x_t) * env_exp(d, tau) for f, a, tau in [(2410, .5, .2), (3890, .3, .13), (5230, .18, .08)])
    return norm(wood + metal + hp(noise(d), 3000) * env_exp(d, .002) * 1.2) * v
def gull(v=1.0):
    d = .5; x_t = t_(d); f = np.interp(x_t, [0, .08, .5], [1500, 2300, 1300])
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .4 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    return norm(bp(x * np.sin(np.pi * x_t / d) ** .7 * (1 + .3 * np.sin(2 * np.pi * 28 * x_t)), 900, 5000)) * v

def bed(a, b, fi, fo):
    return np.clip(np.minimum((tt - a) / max(fi, 1e-3), (b - tt) / max(fo, 1e-3)), 0, 1)

# ---------- ambience ----------
room = lp(brown(DUR), 240) * .5 + bp(noise(DUR), 150, 900) * .06
amb[:, 0] += room * .045; amb[:, 1] += room * .043
surf_w = lp(noise(DUR), 650) * .7 + bp(noise(DUR), 600, 3000) * .18
swell = .45 + .55 * np.sin(2 * np.pi * .19 * tt - 1.2) ** 2
t_sil, t_snap, t_sunset = at('silence'), at('snap'), at('land', id='sunset')
sea_lvl = (bed(t_sil - .8, t_snap + .05, .8, .05) * .7                      # J-cut: the island is heard before the snap; the only sound in the silence
           + bed(t_snap, DUR, .01, 1.0) * .25                               # under the band
           + bed(t_sunset - .4, DUR, .5, 1.2) * .5)                         # the finished scene wakes up, L-cut to the end
sea = surf_w * swell * sea_lvl * .085
amb[:, 0] += sea; amb[:, 1] += np.roll(sea, 1100)
add(amb, gull(1), at('final') + .8, .03, .45); add(amb, gull(1), at('final') + 1.35, .02, .55)
add(amb, gull(1), t_sil + 1.1, .012, -.5)

# ---------- foley from window.EV ----------
SNAP_FOLEY = 1.35                                                       # the clamp: the loudest foley, ~2.6 dB over the first cut
for e in ev:
    t, tp = e['t'], e['type']
    if tp == 'blade':
        add(fol, clack(.7, 1), t, .35, 0); add(fol, thump(1, 120), t, .2, 0); add(fol, tick(.8, 2600), t + .03, .15, .2)
    elif tp == 'pour':
        add(fol, gloop(.4, 1), t, .22, 0); add(fol, squelch(1, 120), t + .05, .22, 0)
    elif tp == 'pull':
        d = e['dur']; fast = 1 / d
        bright = .9 + .25 * min(3, fast)
        gain = {'sunset': .75, 'band': .5, 'title': .5, 'sun': .4}.get(e['id'], .5)
        x = scrape(d + .05, 1, bright, .2, attack=.01)
        if e['dir'] == 'right':                                             # the split fountain pans with the blade
            n = len(x); pan = np.linspace(-.6, .6, n); s0 = int(t * SR)
            fol[s0:s0 + n, 0] += x * np.cos((pan + 1) * np.pi / 4) * gain * 1.4; fol[s0:s0 + n, 1] += x * np.sin((pan + 1) * np.pi / 4) * gain * 1.4
        else: add(fol, x, t, gain, 0)
        add(fol, squelch(1, 130 + 10 * bright), t, .22, 0)
    elif tp == 'land':
        add(fol, tick(.7, 2000), e['t'], .2, .1); add(fol, peel(.22, 1), e['t'] + .02, .12, 0)
    elif tp == 'lift':
        add(fol, clack(.65, 1), t, .3, 0); add(fol, creak(1), t + .05, .2, .2); add(fol, peel(.4, 1), t, .3, 0); add(fol, whoosh(.35, 1), t + .05, .12, 0)
    elif tp == 'loose':
        for k, pan in enumerate([-.5, .4, -.2, .6, .1, -.6]):
            add(fol, paperslide(.5 + .1 * k, 1), t + k * .22, .16 - .012 * k, pan)
        for k in range(3): add(fol, paperslide(.7, 1), t + 1.8 + k * .55, .045, -.3 + .3 * k)       # faint in the silence
    elif tp == 'slide':                                                     # the top layer slips once inside the silence: soft paper brush, kept near-silent
        add(fol, paperslide(.45, 1), t, .07, .35); add(fol, tick(.5, 1800), t, .025, .35)
    elif tp == 'drop':
        add(fol, whoosh(t_snap - t + .02, 1), t, .25, 0)
    elif tp == 'snap':
        add(fol, regclack(1), t, SNAP_FOLEY, 0); add(fol, thump(1, 58), t, .6 * SNAP_FOLEY, 0); add(fol, clack(.5, 1), t + .004, .5 * SNAP_FOLEY, 0)
    elif tp == 'item':
        add(fol, stamp(1), t, .6, -.35 + .25 * e['k']); add(fol, tick(1, 2400), t, .2, -.35 + .25 * e['k'])
    elif tp == 'rest':
        add(fol, thump(1, 140), t, .3, .5); add(fol, clack(.55, 1), t, .2, .5)
    elif tp == 'final':
        add(fol, clack(.65, 1), t, .3, 0); add(fol, creak(1), t + .06, .22, .2); add(fol, peel(.5, 1), t, .3, 0); add(fol, whoosh(.5, 1), t + .05, .14, 0)

# ---------- score + duck ----------
mus, sr = sf.read(os.path.join(HERE, 'out/score.wav')); assert sr == SR
music = np.zeros((N, 2)); music[:min(N, len(mus))] = mus[:N]
fe = np.abs(fol).max(1); from scipy.ndimage import maximum_filter1d, uniform_filter1d
fe = uniform_filter1d(maximum_filter1d(fe, int(.08 * SR)), int(.05 * SR))
duck = 1 - .25 * np.clip(fe / (fe.max() + 1e-9) * 2.5, 0, 1)                 # music ducks ~2.5 dB under foley
mixd = music * .85 * duck[:, None] + fol * 1.0 + amb * 1.0
MAKEUP = 1.2                                                                # drive into the look-ahead limiter: only the ~5 ms clamp/drum transients are shaved, so the
mixd = np.stack([limit(mixd[:, c] * MAKEUP, .95) for c in range(2)], 1)    # peak-to-loudness ratio stays inside what a linear −14 LUFS / −1.2 dBTP normalisation allows
sf.write(os.path.join(HERE, 'out/mix.wav'), mixd.astype(np.float32), SR)
sf.write(os.path.join(HERE, 'out/stem_foley.wav'), fol.astype(np.float32), SR)
sf.write(os.path.join(HERE, 'out/stem_amb.wav'), amb.astype(np.float32), SR)
def db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
print('mix', DUR, 's  rms dB  all %.1f  silence(b16-b20) %.1f' % (db(mixd), db(mixd[int((t_sil + .3) * SR):int((t_snap - .3) * SR)])))
