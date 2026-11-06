# 面包店的早晨 — score + foley + beds → out/mix.wav, and out/cues.json (every music/foley onset, for the cue check).
# Run from the library root: $LIB/.venv/bin/python <project>/mix.py <project>
# Everything is placed from events.json (exported from timeline.js by events.mjs): no hand-typed times here.
import sys, os, json
import numpy as np, soundfile as sf
sys.path.insert(0, '.')
from core.audio import sampler as S
from core.audio.sfx import SR, add, limit, lp, hp, bp, noise, brown, t_, env_exp, norm, click, clack, thump, whoosh, creak, ding

P = sys.argv[1]
EVS = json.load(open(os.path.join(P, 'events.json')))['ev']
TL = EVS[0]; T = TL['T']; DUR = TL['DUR']; N = int(round(DUR * SR))
ev = lambda kind, **f: [e for e in EVS if e['type'] == kind and all(e.get(k) == v for k, v in f.items())]
S.seed(74)
rng = np.random.default_rng(74)
CUES = []   # (t, tag) of every sound that answers a picture event

# ============ score (C major, 100 BPM; instruments from the style's palette + the brief's accordion and xylophone) ============
sc = []
def n(t, inst, p, d, v, pan=0., g=1., tag=None, **kw):
    sc.append(dict(t=t, inst=inst, pitch=p, dur=d, vel=v, pan=pan, gain=g, **kw))
    if tag: CUES.append((round(t, 4), tag))
def chord(t, ps, d, v, inst='accordion', pan=.12, tag=None, **kw):
    for i, p in enumerate(ps): n(t, inst, p, d, v, pan, tag=tag if i == 0 else None, **kw)

H0, H1 = T['hush0'], T['hush1']
# the low string root: soft cello under every cut (not in the silence)
for t0, t1, p in [(0, 2.4, 'C3'), (2.4, 4.8, 'F3'), (4.8, 7.2, 'C3'), (7.2, 8.4, 'F3'), (8.4, 9.6, 'G3'), (9.6, 10.8, 'A3'), (10.8, H0, 'F3'),
                  (H1, 14.4, 'C3'), (14.4, 15.0, 'F3'), (15.0, 15.6, 'G3'), (15.6, 18.0, 'C3'), (18.0, 18.6, 'F3'), (18.6, 19.2, 'G3'), (19.2, DUR, 'C3')]:
    n(t0, 'cellos', p, t1 - t0 + .15, .24 if t0 < 4.8 else .32, -.15, attack=.35 if t0 == 0 else .12, release=.25)
# 1. the corner: one vibraphone note per landing character (the number louder)
for e, p in zip(ev('type', word='title'), ['E5', 'G5', 'C6']): n(e['t'], 'vibraphone', p, 1.4, .5 + .12 * e['num'], .2, tag='type')
chord(T['lampOff'], ['G3', 'C4', 'E4'], .55, .3, attack=.25, pan=-.1)                           # the accordion breathes as the lamp goes out
# 2. lid off: the accordion opens like bellows, glockenspiel when the paper side lands
chord(T['lid0'], ['F3', 'A3', 'C4', 'F4'], 2.25, .55, attack=1.0, tag='lid_up')
n(T['lidFlat'], 'glockenspiel', 'G6', 1.6, .42, .3, tag='lid_flat'); n(T['lidFlat'], 'vibraphone', 'C5', 1.2, .42, .2)
for j, p in enumerate(['C5', 'D5', 'E5', 'G5']): n(T['lidFlat'] + .6 + j * .15, 'xylophone', p, .4, .34 + .04 * j, .25)
# 3–5. the groove: pizzicato "oom" on 1 and 3, accordion "pah" on 2 and 4, shaker when people walk
oom = [(4.8, 'C3'), (6.0, 'G2'), (7.2, 'F2'), (8.4, 'G2'), (9.6, 'A2'), (10.8, 'F2')]
for t, p in oom: n(t, 'cellos_pizz', p, .5, .62, -.1)
pah = [(5.4, ['E4', 'G4', 'C5']), (6.6, ['E4', 'G4', 'C5']), (7.8, ['F4', 'A4', 'C5']), (9.0, ['G4', 'B4', 'D5']), (10.2, ['A4', 'C5', 'E5']), (11.4, ['F4', 'A4', 'C5'])]
for t, ps in pah: chord(t, ps, .2, .3, release=.12)
for e, p in zip(ev('light'), ['C5', 'E5', 'G5']): n(e['t'], 'xylophone', p, .6, .72, .15, tag='light')
for e, p in zip(ev('light'), ['C6', 'E6', 'G6']): n(e['t'], 'glockenspiel', p, 1.0, .32, .3, tag='type')       # the accent squares light: doubled on glockenspiel
for e, p in zip(ev('type', word='w1'), ['F5', 'A5']): n(e['t'], 'vibraphone', p, 1.0, .62, .2, tag='type')
for e, p in zip(ev('type', word='w2'), ['E5', 'A5']): n(e['t'], 'vibraphone', p, 1.0, .62, .2, tag='type')
for e, p in zip(ev('type', word='w3'), ['F5', 'C6']): n(e['t'], 'vibraphone', p, H0 - e['t'], .62, .2, tag='type', release=.06)
# the accent character of each work word (面 / 烤 / 架) is doubled on glockenspiel, an octave up
for w, p in [('w1', 'A6'), ('w2', 'A6'), ('w3', 'C7')]:
    e = ev('type', word=w)[1]; n(e['t'], 'glockenspiel', p, min(1.0, H0 - e['t']), .4, .3, tag='type', release=.06)
for e in ev('knead'): n(e['t'], 'woodblock', None, None, .35, -.2)
baker_steps = ev('step', who='baker')
for i, e in enumerate(baker_steps):
    p = ['G4', 'A4', 'B4', 'C5', 'D5', 'A4', 'B4', 'C5', 'D5', 'E5'][i]
    n(e['t'], 'violins_pizz', p, .25, .34, .3, tag='step')
def shake(a, b, step, v):
    t = a; i = 0
    while t < b - 1e-6: n(t, 'shaker', 'down' if i % 2 == 0 else 'up', None, v * (1 if i % 2 == 0 else .7), .35); t += step; i += 1
shake(*T['walk1'], .3, .26); shake(*T['walk2'], .3, .26)
n(T['ovenDing'], 'triangle', 'open', None, .28, .35)
# 6. the silence, then the domino: one xylophone degree per chair, the grid speeding up under it
for e, p in zip(ev('chair'), ['C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6']):
    k = e['k']; n(e['t'], 'xylophone', p, .8, .68 + .035 * k, .1 - .03 * k, tag='chair')
n(H1, 'glockenspiel', 'C6', 2.0, .55, .25); n(H1, 'cellos_pizz', 'C3', .6, .7, -.1); n(H1, 'vibraphone', 'C4', 1.2, .6, -.1)
chord(H1, ['C3', 'C4', 'E4', 'G4'], 1.15, .64, attack=.02)
n(13.8, 'cellos_pizz', 'G2', .5, .5, -.1); n(14.4, 'cellos_pizz', 'C3', .5, .55, -.1); n(15.0, 'cellos_pizz', 'F2', .3, .55, -.1); n(15.3, 'cellos_pizz', 'G2', .3, .58, -.1)
chord(14.4, ['F4', 'A4', 'C5'], .58, .52, attack=.02); chord(15.0, ['G4', 'B4', 'D5'], .58, .6, attack=.02)
shake(14.4, 15.0, .3, .24); shake(15.0, T['climax'], .2, .3)
n(14.7, 'sus_cymbal', 'roll', .9, .18, .3)
# climax
cl = T['climax']
chord(cl, ['C4', 'E4', 'G4', 'C5'], 1.05, .72, attack=.02, tag='climax')
for p in ['C6', 'E6', 'G6']: n(cl, 'glockenspiel', p, 2.0, .45, .3)
n(cl, 'cellos_pizz', 'C3', .6, .7, -.1); n(cl, 'sus_cymbal', 'hit', None, .32, .3)
for j, p in enumerate(['E5', 'D5', 'C5', 'G4']): n(cl + .6 + j * .15, 'accordion', p, .16, .4, .1)    # a little tag toward the door
# 8. the door: the sign turns, the spot is traced, the guest walks in, the chime, the last chord
fl = T['flip']
chord(fl, ['C5', 'E5', 'G5'], 1.4, .5, inst='vibraphone', pan=.2, tag='flip'); chord(fl, ['E4', 'G4', 'C5'], .5, .38)
n(fl, 'cellos_pizz', 'C3', .5, .5, -.1)
n(T['spot'], 'glockenspiel', 'E6', 1.2, .38, .3, tag='spot')
guest_steps = ev('step', who='guest')
for i, e in enumerate(guest_steps[:-1]): n(e['t'], 'violins_pizz', ['C5', 'D5', 'E5', 'F5', 'G5'][i], .25, .32, .3, tag='step')
shake(T['walk3'][0], T['walk3'][1], .3, .22)
chord(18.0, ['F4', 'A4', 'C5'], .55, .42, attack=.03); n(18.0, 'cellos_pizz', 'F2', .5, .5, -.1)
chord(18.6, ['G4', 'B4', 'D5'], .55, .46, attack=.03); n(18.6, 'cellos_pizz', 'G2', .5, .5, -.1)
n(T['door'], 'hand_chimes', 'C6', 1.6, .45, .3, tag='chime'); n(T['door'] + .1, 'hand_chimes', 'G6', 1.4, .32, .35)
ar = T['arrive']
chord(ar, ['C4', 'E4', 'G4', 'C5'], DUR - ar, .62, attack=.02, tag='arrive')
for p in ['C5', 'G5', 'E6']: n(ar, 'vibraphone', p, 1.2, .45, .2)
n(ar, 'xylophone', 'C6', .8, .62, .15); n(ar, 'glockenspiel', 'C7', 1.2, .35, .3); n(ar, 'cellos_pizz', 'C3', .6, .6, -.1)

music = S.render(sc, dur=DUR + 3, master=False)[:N]
music = S.room(music, size=.38, mix=.16)
# the silence is a real general pause: the score stops on the barline and comes back on the first chair
tt = np.arange(N) / SR
gate = np.ones(N, np.float32)
gate[(tt >= H0) & (tt < H1)] = 0
f = int(.05 * SR); i0 = int(H0 * SR); gate[i0 - f:i0] = np.linspace(1, 0, f)
music *= gate[:, None]

# ============ foley (from the same events) ============
fx = np.zeros((N, 2), np.float32)
def fadd(x, t, g=1., pan=0., tag=None):
    add(fx, x.astype(np.float32), t, g, pan)
    if tag: CUES.append((round(t, 4), tag))
def env_ad(d, a, tau): tt_ = t_(d); return np.minimum(1, tt_ / max(a, 1e-4)) * np.exp(-tt_ / tau)
def flap(v=1.):   # a large sheet of card landing flat
    d = .35; x = bp(noise(d), 250, 2600) * env_ad(d, .004, .05) + lp(noise(d), 180) * env_ad(d, .003, .07) * .8
    return norm(x) * v
def slide(d, lo=300, hi=2500, v=1.):   # card or wood sliding
    x = bp(noise(d), lo, hi); e = np.sin(np.pi * t_(d) / d) ** 1.5
    return norm(x * e) * v
def slap(v=1.):   # dough slapped on wood
    d = .16; x = lp(noise(d), 900) * env_ad(d, .002, .03) + np.sin(2 * np.pi * 140 * t_(d)) * env_ad(d, .002, .04) * .7
    return norm(x) * v
def clank(v=1.):  # oven door: steel
    d = .7; tt_ = t_(d)
    x = sum(a * np.sin(2 * np.pi * fr * tt_) * np.exp(-tt_ / tau) for fr, a, tau in [(410, .7, .25), (1130, .5, .12), (2370, .35, .07), (3010, .2, .05)])
    return norm(x + hp(noise(d), 1500) * env_ad(d, .001, .01) * .8) * v
def wood(v=1., p=1.):  # chair feet on tile
    d = .22; tt_ = t_(d)
    x = sum(a * np.sin(2 * np.pi * fr * p * tt_) * np.exp(-tt_ / tau) for fr, a, tau in [(310, .8, .05), (720, .55, .03), (1650, .3, .018)])
    return norm(x + bp(noise(d), 1500, 6000) * env_ad(d, .0005, .006) * .9) * v
def shoe(v=1.):
    d = .07; return norm(lp(hp(noise(d), 300), 2500) * env_ad(d, .002, .012)) * v
def flick(v=1.):
    d = .12; return norm(hp(noise(d), 2000) * env_ad(d, .001, .015) + bp(noise(d), 600, 1400) * env_ad(d, .01, .03) * .5) * v
def bell(f0, v=1.):
    d = 2.2; tt_ = t_(d)
    x = sum(a * np.sin(2 * np.pi * f0 * r * tt_) * np.exp(-tt_ / tau) for r, a, tau in [(1, 1, .9), (2.76, .45, .35), (5.4, .2, .15), (2.0, .2, .6)])
    return norm(x) * v

fadd(click(.75, 1), T['lampOff'], .45, .5, 'lamp')
fadd(creak(1), T['lid0'] - .05, .3, -.1, 'lid_up'); fadd(creak(1), T['lid0'] + .3, .22, .1)
fadd(whoosh(1.1, 1), T['lid0'] + .1, .22, .2)
fadd(slide(.9, 200, 1800), T['wall0'], .3, -.2, 'walls')
fadd(flap(1), T['lidFlat'], .55, .3, 'lid_flat')
fadd(whoosh(1.0, 1), T['lidFlat'] + .12, .22, .45)
for e in ev('light'): fadd(click(1.3, 1), e['t'], .32, -.1, 'light')
for e in ev('knead'): fadd(slap(1), e['t'], .5, -.15, 'knead')
fadd(wood(.6, 1.8), ev('lift')[0]['t'], .25, -.1, 'lift')
for e in ev('step'): fadd(shoe(1), e['t'], .28 if e['who'] == 'baker' else .3, -.05 if e['who'] == 'baker' else .25, 'step_foley')
fadd(clank(1), T['ovenOpen'], .42, -.2, 'oven_open')
fadd(ding(1), T['ovenDing'], .3, -.2, 'oven_ding')
fadd(slide(.3, 400, 3000), T['shelf'] - .2, .3, -.25); fadd(wood(.8, 1.4), T['shelf'], .35, -.25, 'shelf')
# the silence holds one sound only: the first chair hops (a tiny creak up, a soft tap as it drops back on the triplet)
fadd(creak(.5), T['twitch'][0], .06, .1)
fadd(wood(.5, .8), T['twitch'][1], .07, .08, 'twitch')
for e in ev('chair'):
    k = e['k']; fadd(wood(1, .95 + .04 * k), e['t'], (.95 if k == 0 else .55 + .03 * k), .05 - .04 * k, 'chair_foley')
fadd(thump(1, 60), T['chairs'][0], .36, 0)                                  # the first one lands with weight
fadd(flick(1), T['flip'] - .12, .35, .35); fadd(flick(.7), T['flip'], .3, .35, 'flip_foley')
fadd(bell(1568, 1), T['door'], .2, .35, 'chime_foley'); fadd(bell(2093, .7), T['door'] + .12, .14, .4)
fadd(shoe(1), T['arrive'], .35, .25)

# ============ beds ============
bed = np.zeros((N, 2), np.float32)
def lr(x, y): return np.stack([x, y], 1).astype(np.float32)
street = lr(lp(brown(DUR), 500), lp(brown(DUR), 500)) * .5 + lr(bp(noise(DUR), 800, 3000), bp(noise(DUR), 800, 3000)) * .02
room_ = lr(lp(brown(DUR), 300), lp(brown(DUR), 300)) * .35
hum = (np.sin(2 * np.pi * 100 * tt) * .6 + np.sin(2 * np.pi * 200 * tt) * .25 + np.sin(2 * np.pi * 300 * tt) * .1) * .25
def ramp(a, b): return np.clip((tt - a) / max(b - a, 1e-3), 0, 1)
g_street = (1 - ramp(3.0, 5.4)) + ramp(16.0, 17.8) * .8
g_room = ramp(2.6, 4.6) * (1 - ramp(16.2, 18.4) * .3)
g_hum = ramp(T['lights'][1], T['lights'][1] + .6) * .8 + ramp(T['ovenOpen'], T['ovenOpen'] + .1) * .4 - ramp(T['ovenDing'] + .3, T['ovenDing'] + .8) * .4
quiet = 1 - ((tt >= H0) & (tt < H1)) * .7                                   # the beds dip too in the silence (near-silence, not dead air)
bed += street * (g_street * quiet)[:, None] * .05
bed += room_ * (g_room * quiet)[:, None] * .045
bed += lr(hum, hum) * (np.clip(g_hum, 0, 1) * quiet)[:, None] * .012
for bt in [.25, 1.1, 2.05, 3.25, 16.9, 18.4]:                               # sparrows at dawn (synth chirps)
    for j in range(3):
        d = .07; tt_ = t_(d); fr = 3600 + 900 * np.sin(np.pi * tt_ / d) + rng.random() * 300
        x = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.sin(np.pi * tt_ / d) ** 2
        add(bed, x.astype(np.float32), bt + j * .09, .035, .6 - .3 * j)

# ============ mix ============
mix = music * 1.0 + fx * .9 + bed
# keep the first chair after the silence the biggest sound in the film: the rest of the domino sits 1.2 dB under it
duck = 1 - (1 - 10 ** (-1.2 / 20)) * np.clip((tt - 13.5) / .3, 0, 1) * (1 - np.clip((tt - 16.4) / .6, 0, 1))
mix = mix * duck[:, None]
# end: let the last chord ring, then fade the final .35 s
fo = int(.35 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
peak = np.abs(mix).max(); mix *= .8 / peak
mix = np.stack([limit(mix[:, 0], .84), limit(mix[:, 1], .84)], 1).astype(np.float32)

# true-peak control (STYLE §7: true peak under -1.5 dBFS after the -14 LUFS normalisation in mux.sh).
# mux.sh applies one linear gain; so keep the peak-to-loudness ratio <= PLR here, measuring true peak at 4x oversampling.
from scipy.signal import lfilter, resample_poly
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
def _biquads():
    G, Q, fc = 3.99984385397, .7071752369554193, 1681.9744509555319
    A = 10 ** (G / 40); w0 = 2 * np.pi * fc / SR; al = np.sin(w0) / (2 * Q); cs = np.cos(w0); sA = np.sqrt(A)
    sh = ([A * ((A + 1) + (A - 1) * cs + 2 * sA * al), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - 2 * sA * al)],
          [(A + 1) - (A - 1) * cs + 2 * sA * al, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - 2 * sA * al])
    Q, fc = .5003270373253953, 38.13547087613982; w0 = 2 * np.pi * fc / SR; al = np.sin(w0) / (2 * Q); cs = np.cos(w0)
    hp_ = ([(1 + cs) / 2, -(1 + cs), (1 + cs) / 2], [1 + al, -2 * cs, 1 - al])
    return sh, hp_
def lufs(x):   # ITU-R BS.1770-4 integrated loudness, stereo
    sh, hp_ = _biquads(); y = lfilter(*hp_, lfilter(*sh, x, axis=0), axis=0)
    B, S_ = int(.4 * SR), int(.1 * SR)
    z = np.array([(y[i:i + B] ** 2).mean(0).sum() for i in range(0, len(y) - B + 1, S_)])
    l = -.691 + 10 * np.log10(z + 1e-12); z = z[l > -70]
    rel = -.691 + 10 * np.log10(z.mean()) - 10; z = z[(-.691 + 10 * np.log10(z)) > rel]
    return -.691 + 10 * np.log10(z.mean())
def tpeak(x):  # true peak (linear), 4x oversampled
    return max(np.abs(resample_poly(x[:, c], 4, 1)).max() for c in range(x.shape[1]))
def tp_limit(x, ceil):   # linked look-ahead limiter on the 4x-oversampled envelope
    env = np.max([np.abs(resample_poly(x[:, c], 4, 1)).reshape(-1, 4).max(1)[:len(x)] for c in range(x.shape[1])], 0)
    n = int(.003 * SR); g = np.minimum(1, ceil / np.maximum(maximum_filter1d(env, 2 * n + 1), 1e-9))
    g = uniform_filter1d(minimum_filter1d(g, 2 * n + 1), 2 * n + 1)
    r = int(.03 * SR); g = np.minimum(g, uniform_filter1d(minimum_filter1d(g, r), r))   # short, smooth release
    return (x * g[:, None]).astype(np.float32)
# Loudness is set here, not left to mux.sh's dynamic mode: bring the mix to -14 LUFS and hold true peak at TP_CEIL with the
# oversampled limiter (it only touches the short chair / lid transients); mux.sh then measures -14 and applies ~0 dB linear gain.
TP_CEIL = -2.0
if os.environ.get('PEAKS'):
    a_ = np.abs(mix).max(1); idx = np.argsort(a_)[::-1]; seen_ = []
    for i in idx:
        if all(abs(i - j) > SR * .08 for j in seen_): seen_.append(i)
        if len(seen_) >= 14: break
    for i in seen_: print(f'  peak {i / SR:7.3f}s  {20 * np.log10(a_[i]):6.2f} dBFS')
    rms_ = [(k * .1, 10 * np.log10((mix[int(k * .1 * SR):int((k * .1 + .4) * SR)] ** 2).mean() + 1e-12)) for k in range(195)]
    print('  loudest 0.4s windows:', [(round(t, 1), round(v, 1)) for t, v in sorted(rms_, key=lambda x: -x[1])[:6]])
for _ in range(8):
    L = lufs(mix); mix = (mix * 10 ** ((-14 - L) / 20)).astype(np.float32)
    mix = tp_limit(mix, 10 ** ((TP_CEIL - .1) / 20))
    if abs(lufs(mix) + 14) < .05 and 20 * np.log10(tpeak(mix)) <= TP_CEIL: break
print(f'loudness {lufs(mix):.2f} LUFS  true peak {20 * np.log10(tpeak(mix)):.2f} dBTP (ceiling {TP_CEIL})')
os.makedirs(os.path.join(P, 'out'), exist_ok=True)
sf.write(os.path.join(P, 'out', 'mix.wav'), mix, SR)
json.dump(sorted(CUES), open(os.path.join(P, 'out', 'cues.json'), 'w'))
# low-end check: 20–120 Hz vs the rest
X = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fr = np.fft.rfftfreq(N, 1 / SR)
lo = X[(fr > 20) & (fr < 120)].sum(); rest = X[(fr >= 120) & (fr < 16000)].sum()
print(f'mix.wav {DUR:.2f}s  peak {20*np.log10(np.abs(mix).max()):.1f} dBFS  low/rest {10*np.log10(lo/rest):.1f} dB  silence rms {20*np.log10(np.sqrt((mix[int((H0+.1)*SR):int((H1-.7)*SR)]**2).mean())+1e-9):.1f} dBFS')
print('\n'.join(S.credits(sorted({e['inst'] for e in sc}))))
