# 红色自行车 — foley, ambience and the final mix. Every sound is placed from window.EV (events.json) or the bike track.
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.ndimage import uniform_filter1d
from core.audio import sampler as S
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, thump, whoosh, creak, add, limit
HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(23)
TL = json.load(open(os.path.join(HERE, 'out/timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
T, DUR = TL['T'], EVJ['dur']
N = int(DUR * SR); tt = np.arange(N) / SR
music, _ = sf.read(os.path.join(HERE, 'out/score.wav')); music = music[:N]
if len(music) < N: music = np.pad(music, ((0, N - len(music)), (0, 0)))
fx = np.zeros((N, 2)); amb = np.zeros((N, 2))
BK = np.array(TL['BIKE'])                         # t, screen pan (-1..1), speed, depth scale
pan_at = lambda t: float(np.clip(np.interp(t, BK[:, 0], BK[:, 1]), -.9, .9))
curve = lambda keys: np.interp(tt, [k[0] for k in keys], [k[1] for k in keys])
def put(buf, x, at, g=1., pan=0.):
    add(buf, x, at, g, pan)

# ---------------- materials
def knife(d=.4, v=1., bright=1.):          # palette knife dragged through thick wet paint
    n = noise(d); x = t_(d)
    grain = 1 + 6 * np.abs(bp(rng.standard_normal(len(n)), 25, 110, 1))
    body = bp(n, 700 * bright, 4200 * bright) * grain
    wet = bp(noise(d), 180, 650) * .55 * (1 + .6 * np.sin(2 * np.pi * 7 * x))
    e = np.minimum(1, x / .025) * np.exp(-np.maximum(0, x - d * .55) / (d * .18))
    return norm((body + wet) * e) * v
def dab(v=1.):                              # wet paint pressed down
    d = .12; return norm(lp(noise(d), 900) * env_exp(d, .03) + np.sin(2 * np.pi * 120 * t_(d)) * env_exp(d, .02) * .6) * v
def bell(v=1.):                             # bicycle bell: two detuned bell partials + the striker
    d = 1.1; x = t_(d)
    y = sum(a * np.sin(2 * np.pi * f * x) * env_exp(d, tau) for f, a, tau in [(3150, 1, .35), (3190, .8, .3), (4720, .45, .18), (6400, .2, .08), (1580, .25, .25)])
    y[:int(.004 * SR)] += hp(noise(.004), 3000) * .8
    return norm(y) * v
def squeal(d=.6, v=1.):                     # rim brake squeal + gravel skid
    x = t_(d); f = 2350 * (1 + .012 * np.sin(2 * np.pi * 31 * x)) * (1 - .05 * x / d)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * np.minimum(1, x / d)) ** .6 * .5
    skid = bp(noise(d), 400, 3500) * np.exp(-x / (d * .6))
    return norm(s + skid * .9) * v
def gravel(d=.25, v=1.):
    n = noise(d); crack = (rng.random(len(n)) > .993) * rng.standard_normal(len(n)) * 6
    return norm(bp(n, 500, 3000) * np.exp(-t_(d) / (d * .5)) + hp(crack, 1500)) * v
def fabric(d=.4, v=1.):
    n = noise(d); m = np.abs(bp(rng.standard_normal(len(n)), 6, 30, 1)); m /= m.max() + 1e-9
    return norm(bp(n, 1200, 6500) * m * np.sin(np.pi * t_(d) / d)) * v
def click(v=1.):
    d = .04; x = t_(d); return norm(hp(noise(d), 2500) * env_exp(d, .002) + np.sin(2 * np.pi * 2600 * x) * env_exp(d, .005) * .5) * v
def chirp(v=1.):
    d = .45; out = np.zeros(int(d * SR)); k = 0
    for i in range(3 + rng.integers(3)):
        dd = .05 + rng.random() * .05; x = t_(dd); f0 = 3000 + rng.random() * 1800
        f = f0 + 800 * np.sin(np.pi * x / dd) * (1 if i % 2 else -1)
        s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * x / dd) ** 2
        st = int(k * SR); out[st:st + len(s)] += s[:len(out) - st]; k += dd + .03
    return out * v
def hum(d=1.8, v=1.):                        # the light arriving: a low swell that peaks on the downbeat
    x = t_(d); pk = 1.1
    e = np.where(x < pk, (x / pk) ** 2.2, np.exp(-(x - pk) / .35))
    y = sum(a * np.sin(2 * np.pi * f * x) for f, a in [(55, 1), (110, .5), (165, .3), (220, .15)]) + lp(noise(d), 300) * .3
    return norm(y * e) * v

# ---------------- ambience: wind over the wheat (two layers), level automated by section; the silence is near-zero
n = N
w1 = bp(rng.standard_normal(n), 180, 1400) * (1 + .5 * np.sin(2 * np.pi * .13 * tt) + .3 * np.sin(2 * np.pi * .41 * tt + 1))
w2 = bp(rng.standard_normal(n), 2500, 7000) * np.abs(bp(rng.standard_normal(n), .3, 2, 1)) * 6      # wheat rustle
wind = np.stack([w1 * .8 + w2 * .5, np.roll(w1, 7001) * .8 + np.roll(w2, 3301) * .5], 1); wind /= np.abs(wind).max()
g_w = curve([(0, .28), (1.5, .5), (T['brake'], .5), (T['stop'] - .1, .22), (T['stop'] + .2, .03), (T['scrape1'] - .01, .03), (T['scrape1'] + .1, .45), (DUR, .42)])
amb += wind * g_w[:, None]

# ---------------- the ride: tyre on dirt + chain, following the bike's speed and screen position
v = np.interp(tt, BK[:, 0], BK[:, 2]); sc = np.interp(tt, BK[:, 0], BK[:, 3]); pn = np.interp(tt, BK[:, 0], BK[:, 1])
riding = ((tt >= T['enter'] - .4) & (tt < T['stop'])) | (tt >= T['away'])
spd = np.where(tt < T['away'], v / 600, np.clip(1 - (tt - T['away']) / (T['last'] - T['away']), 0, 1))
roll = bp(rng.standard_normal(n), 300, 2600) * (1 + 3 * (rng.random(n) > .996))
chain = bp(rng.standard_normal(n), 2500, 6000) * (.5 + .5 * np.sin(2 * np.pi * tt * (4 + 6 * spd)) ** 8)
ride = (lp(roll, 3000) * .7 + chain * .35) * (riding * spd * np.clip(sc * 1.4, 0, 1))[:]
ride = uniform_filter1d(ride, 3)
lgain, rgain = np.cos((np.clip(pn, -.9, .9) + 1) * np.pi / 4), np.sin((np.clip(pn, -.9, .9) + 1) * np.pi / 4)
fx += np.stack([ride * lgain, ride * rgain], 1) * .55

# ---------------- events
for e in EVJ['ev']:
    t, ty = e['t'], e['type']
    if ty == 'knife_first':
        put(fx, knife(.55, 1.0), t, 1, -.2); put(fx, dab(.6), t + .02, 1, -.2)
    elif ty == 'knife_lay':
        put(fx, knife(.26, .32, 1.15), t, 1, pan_at(t) - .35)
    elif ty == 'enter':
        put(fx, gravel(.3, .35), t, 1, -.8)
    elif ty == 'bell':
        put(fx, bell(.42), t, 1, pan_at(t)); put(fx, bell(.3), t + .16, 1, pan_at(t))
    elif ty == 'stand':
        put(fx, fabric(.35, .3), t - .15, 1, pan_at(t)); put(fx, creak(.25), t, 1, pan_at(t))
    elif ty == 'brake':
        put(fx, squeal(.62, .5), t, 1, .05); put(fx, gravel(.5, .5), t + .05, 1, 0)
    elif ty == 'foot':
        put(fx, thump(.5, 95), t, 1, -.1); put(fx, gravel(.18, .35), t, 1, -.1)
    elif ty == 'cloth':
        put(fx, fabric(.38, .32), t - .05, 1, 0)          # the only sound inside the silence
    elif ty == 'scrape':
        i = e['i']; big = 1.0 if i == 0 else .62 + .05 * i
        k = knife(.95 if i == 0 else .62, big, .8 if i == 0 else 1.)
        put(fx, k, t, 1, 0); put(fx, dab(.5 * big), t, 1, 0)
    elif ty == 'rake':
        put(fx, hum(1.8, .55), t - 1.1, 1, 0)
    elif ty == 'pedal':
        put(fx, click(.3), t, 1, pan_at(t)); put(fx, fabric(.3, .18), t - .1, 1, pan_at(t))
    elif ty == 'away':
        put(fx, gravel(.3, .3), t, 1, pan_at(t))
for t in [12.9, 14.05, 16.1, 17.7, 18.5]: put(amb, chirp(.14), t, 1, rng.random() * 1.2 - .3)
put(amb, chirp(.06), 2.6, 1, .6)                                  # one far bird in the grey

# ---------------- mix: knife scrapes and the big scrape room; music leads, ambience ducks a little under it
fx = S.room(fx.astype(np.float32), size=.3, mix=.12)
env = uniform_filter1d(np.abs(music).mean(1), int(.25 * SR)); duck = 1 - .3 * np.clip(env / (env.max() + 1e-9) * 2.5, 0, 1)
mix = music * 1.0 + fx * .6 + amb * .3 * duck[:, None]
# the silence: music is already zero; keep only wind at a whisper and the cloth
mix = np.stack([limit(mix[:, 0], .92), limit(mix[:, 1], .92)], 1)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR)
# band energy check (low end should not dominate)
from numpy.fft import rfft, rfftfreq
F = np.abs(rfft(mix.mean(1))) ** 2; fr = rfftfreq(N, 1 / SR)
lo = F[(fr > 20) & (fr < 120)].sum(); rest = F[(fr >= 120) & (fr < 16000)].sum()
print('mix', N / SR, 's peak', round(float(np.abs(mix).max()), 3), 'low/rest dB', round(10 * np.log10(lo / rest), 1))
