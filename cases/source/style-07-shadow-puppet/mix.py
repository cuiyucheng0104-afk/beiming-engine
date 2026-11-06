"""渔夫还珠 — foley from window.EV (events.json) + score stems → out/mix.wav (48 kHz stereo, peak-limited; loudness by mux.sh).
Three layers: ambience (backstage room tone, water, rain), foley (lamp, oar, net, leather pieces, dragon, clapper), music.
The silence (gong + 0.375 s → the pearl bell) is a hard cut of every bed; only one lamp sizzle sounds inside it."""
import sys, os, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, bp, hp, lp, noise, brown, env_exp, t_, norm, whoosh, creak, thump, limit, roar, compress

EV = json.load(open(os.path.join(HERE, 'events.json')))
TL = json.load(open(os.path.join(HERE, 'out/timeline.json'))); T = TL['t']
DUR = EV['dur']; N = int(DUR * SR)
rng = np.random.default_rng(23); S.seed(5)
amb = np.zeros((N, 2), np.float32); fol = np.zeros((N, 2), np.float32)

def env_ad(d, a, r):
    n = int(d * SR); e = np.ones(n); na = max(1, int(a * SR)); nr = max(1, int(r * SR))
    e[:na] = np.linspace(0, 1, na); e[-nr:] *= np.linspace(1, 0, nr); return e
def splash(v=1., big=False):
    d = .9 if big else .45; n = noise(d)
    x = bp(n, 500, 5000) * env_exp(d, .12 if big else .05) + lp(noise(d), 600) * env_exp(d, .08) * (.9 if big else .4)
    bub = sum(np.sin(2 * np.pi * f * t_(d)) * env_exp(d, .02) * np.exp(-((t_(d) - o) ** 2) / 2e-4) for f, o in [(900, .05), (1300, .11), (700, .18), (1600, .24)])
    return norm(x + .25 * bub) * v
def flap(v=1.):   # dry leather piece lifted / swapped
    d = .16; x = bp(noise(d), 700, 3200) * env_exp(d, .025) + lp(noise(d), 300) * env_exp(d, .015) * .6
    return norm(x) * v
def tap(v=1., f=1400):   # rod tap on cloth / wood
    d = .08; return norm(np.sin(2 * np.pi * f * t_(d)) * env_exp(d, .012) + hp(noise(d), 2000) * env_exp(d, .003)) * v
def fwoomp(v=1.):   # oil lamp catching: soft low burst + rising hiss
    d = .9; tt = t_(d)
    x = lp(noise(d), 700) * env_ad(d, .03, .7) * np.exp(-tt / .35) + np.sin(2 * np.pi * 70 * tt * (1 + .4 * tt)) * np.exp(-tt / .25) * .7
    return norm(x + hp(noise(d), 3000) * env_ad(d, .15, .6) * .12) * v
def pfft(v=1.):     # snuff + sizzle tail
    d = .7; tt = t_(d); x = bp(noise(d), 300, 1800) * np.exp(-tt / .05)
    sz = hp(noise(d), 4000) * (rng.random(len(tt)) > .97) * np.exp(-tt / .3) * 2
    return norm(x + lp(sz, 9000) * .5) * v
def sizzle(d=.9, v=1.):
    tt = t_(d); return norm(hp(noise(d), 3500) * (rng.random(len(tt)) > .985) * 3 + hp(noise(d), 5000) * .08) * env_ad(d, .08, .4) * v
def gasp(v=1.):     # a flame dragged low: short soft inward flutter + tiny wick crackle
    d = .35; tt = t_(d); fl = .6 + .4 * np.sin(2 * np.pi * 23 * tt) * np.exp(-tt / .12)
    x = bp(noise(d), 250, 1400) * env_ad(d, .015, .28) * fl + hp(noise(d), 4500) * (rng.random(len(tt)) > .99) * np.exp(-tt / .1)
    return norm(x) * v
def rustle(d=.4, v=1.):
    tt = t_(d); m = np.abs(lp(noise(d), 18)); return norm(bp(noise(d), 1500, 6000) * m) * env_ad(d, .05, .2) * v
def xingmu(v=1.):   # the storyteller's clapper: hard wood on wood, dry
    x = S.hit('claves', None, .95); y = S.hit('woodblock', 'c', .9); n = max(len(x), len(y))
    z = np.pad(x, (0, n - len(x))) * .8 + np.pad(y, (0, n - len(y))) * .6
    th = thump(.6, 160); z[:len(th)] += th * .5
    return norm(z[:int(.5 * SR)]) * v
def bed_water(d, v=1.):
    tt = t_(d); m = .55 + .45 * np.sin(2 * np.pi * tt / 1.7) * np.sin(2 * np.pi * tt / 2.9 + 1)
    return norm(bp(noise(d), 200, 1400) * m + lp(brown(d), 300) * .4) * v
def bed_room(d, v=1.):
    return norm(lp(brown(d), 260) + bp(noise(d), 300, 900) * .05) * v
def bed_rain(d, v=1.):
    tt = t_(d); x = hp(noise(d), 1800) * .5 + bp(noise(d), 3000, 9000) * .5
    drops = np.zeros(len(tt)); idx = rng.integers(0, len(tt) - 2000, int(d * 70))
    for i in idx: drops[i:i + 600] += np.sin(2 * np.pi * rng.uniform(2500, 5000) * np.arange(600) / SR) * np.exp(-np.arange(600) / 90) * rng.uniform(.3, 1)
    return norm(x + drops * .6) * v
def surge_bed(d, v=1.):
    tt = t_(d); x = lp(brown(d), 420) + bp(noise(d), 300, 2500) * (.5 + .5 * np.sin(2 * np.pi * tt / .75) ** 2) * .5
    return norm(x) * env_ad(d, .2, .05) * v

for e in EV['ev']:
    t, k, v = e['t'], e['type'], e.get('v', 1.0)
    if k == 'ignite': add(fol, fwoomp(.55), t, 1, -.3 + .3 * e['i'])
    elif k == 'oar': add(fol, splash(.35), t + .02, .8, -.35); add(fol, creak(.25), t + .05, .5, -.3)
    elif k == 'press': add(fol, flap(.5), t, .7, .2); add(fol, tap(.4, 1100), t + .3, .5, .2)
    elif k == 'rodtap': add(fol, tap(.4 * v, 1200), t, .6, .2)
    elif k == 'oardown': add(fol, tap(.5, 600), t + .375, .6, -.4)   # the yuloh lands on the next half-beat (A6)
    elif k == 'netup': add(fol, creak(.45), t, .6, -.1); add(fol, rustle(.35, .5), t, .6, -.1)
    elif k == 'cast': add(fol, whoosh(.55, .8), t, .9, .2); add(fol, rustle(.3, .4), t, .5, .3)
    elif k == 'liftoff': add(fol, flap(.55 * v), t, .7, .25)
    elif k == 'splash': add(fol, splash(.9), t, 1, .35)
    elif k == 'rope':
        for i in range(4): add(fol, creak(.3), t + i * .1875, .45, .2)
    elif k == 'pearlup': add(fol, splash(.45), t, .7, .3)
    elif k == 'surge': add(amb, surge_bed(e['d'] + .02, .9), t - .375, 1, 0)      # J-cut: the swell arrives half a beat early
    elif k == 'flap': add(fol, flap(v), t, .55, (-1) ** int(t * 8) * .4)
    elif k == 'breach': add(fol, splash(1, True), t, 1.1, .3); add(fol, thump(.9, 55), t, .8, .3)
    elif k == 'creak': add(fol, np.concatenate([creak(.6), creak(.5), creak(.6)]), t, .55, .3)
    elif k == 'roar': add(fol, lp(roar(.9, 1.0), 900) * env_ad(.9, .05, .5), t, .55, .25)
    elif k == 'offwhoosh':
        d = e['d']; tt = t_(d); w = lp(brown(d), 500) * (tt / d) ** 1.6 + bp(noise(d), 200, 1200) * (tt / d) ** 2 * .4
        add(fol, norm(w) * .9, t, .9, 0)
    elif k == 'crashzoom': add(fol, whoosh(.3, .7), t, .7, 0)
    elif k == 'slam': add(fol, thump(1, 48), t, 1.1, 0); add(fol, flap(1.), t, .9, 0)
    elif k == 'sizzle': add(fol, sizzle(.8, .9), t, .55, .45)                       # the single sound inside the silence
    elif k == 'rustle': add(fol, rustle(.45, .6), t, .6, .1)
    elif k == 'jaw': add(fol, tap(.5, 500), t, .6, .3)
    elif k == 'swap': add(fol, flap(.9), t, .8, .3); add(fol, tap(.6, 900), t + .02, .5, .3)
    elif k == 'rain': d = e['d']; add(amb, bed_rain(d, .5) * env_ad(d, .35, .6), t, .55, 0)
    elif k == 'bow': add(fol, creak(.35), t, .5, -.2); add(fol, rustle(.3, .4), t, .5, -.2)
    elif k == 'snuff': add(fol, pfft(.8), t, .8, .3 if e['i'] == 2 else 0)
    elif k == 'clap': add(fol, xingmu(1.0), t, 1.0, 0)
    elif k == 'dim': add(fol, gasp(.55), t, .5, (-.5, 0, .5)[e['i']])              # a lamp flame pulled low by the pearl
    elif k == 'gutter': add(fol, gasp(.5), t, .45, -.4); add(fol, sizzle(.7, .5), t + .03, .35, -.4)   # the last lamp fights for air
    elif k == 'room': d = e['d']; add(amb, bed_room(d, .5) * env_ad(d, .3, .01), t, .3, 0)
    elif k == 'water': d = e['d']; add(amb, bed_water(d, .5 * v) * env_ad(d, .4, .3), t, .45, -.2)

# music stems
mus = {k: sf.read(os.path.join(HERE, f'out/stems/{k}.wav'), dtype='float32')[0] for k in ['luogu', 'jinghu', 'suona', 'bell', 'sanxian']}
for k in mus: mus[k] = np.pad(mus[k], ((0, max(0, N - len(mus[k]))), (0, 0)))[:N]
music = mus['luogu'] * 1.0 + mus['jinghu'] * 2.5 + mus['suona'] * 2.4 + mus['bell'] * 3.2 + mus['sanxian'] * 2.4
# duck music ~4 dB under key foley hits
duck = np.ones(N, np.float32)
for e in EV['ev']:
    if e['type'] in ('splash', 'breach', 'slam', 'clap', 'swap'):
        a, b = int(e['t'] * SR), int((e['t'] + .35) * SR); duck[a:b] = np.minimum(duck[a:b], .63)
from scipy.ndimage import uniform_filter1d
duck = uniform_filter1d(duck, int(.02 * SR))
mix = amb * .9 + fol * .75 + music * duck[:, None]
fol_room = S.room(fol, size=.3, mix=.14)
mix = amb * .9 + fol_room * .75 + music * duck[:, None]
# the silence: hard cut of every bed and tail; only the sizzle remains
s0, s1 = int(T['silence'] * SR), int(T['ting'] * SR); f = int(.02 * SR)
keep = np.zeros((N, 2), np.float32); add(keep, sizzle(.8, .9), T['sizzle'], .55, .45)
mix[s0:s0 + f] *= np.linspace(1, 0, f)[:, None]; mix[s0 + f:s1] = keep[s0 + f:s1] * .75
# low-end balance: pull 20–110 Hz down ~4 dB
for c in range(2): mix[:, c] = mix[:, c] - .38 * lp(mix[:, c], 110, 2)
# low-end check and limit
pk = np.abs(mix).max(); mix = mix / pk * .9
for c in range(2): mix[:, c] = limit(mix[:, c], .55, .004)   # tame drum/gong transients so AAC decode stays under 0 dBFS after loudnorm
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
# band energy report (20–120 Hz vs the rest)
X = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fr = np.fft.rfftfreq(N, 1 / SR)
lo = X[(fr >= 20) & (fr < 120)].sum(); rest = X[(fr >= 120) & (fr < 16000)].sum()
print('mix →', os.path.join(HERE, 'out/mix.wav'), f'| {DUR:.2f}s | low/rest {10*np.log10(lo/rest):.1f} dB')
