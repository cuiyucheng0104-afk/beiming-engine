"""《十二秒》 score + foley + beds -> out/mix.wav (+ out/stems/*.wav, out/audio_cues.json)
Reads out/timeline.json (tools/export.mjs) and events.json (core/render/events.mjs: the page's window.EV).
usage: $LIB/.venv/bin/python mix.py      (LIB in the environment, default @@LEMO_ROOT@@)
"""
import os, sys, json
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import pluck as P          # physically modelled plucked strings (waveguide)
from core.audio.sfx import SR, add, limit, lp, hp, bp, noise, brown, env_exp, t_, clack, click, whoosh, norm

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
B = TL['BEAT']; DUR = TL['DUR']; BE = TL['BEATS']
EV = EVJ['ev']
N = int(round((DUR + 0.05) * SR))
b = lambda x: x * B
S.seed(1903)
rng = np.random.default_rng(1217)

# ---------------------------------------------------------------- score
sc = []          # (t, inst, pitch, dur, vel, pan[, gain]) or dicts
def n(beat, inst, pitch, dur_beats, vel, pan=0.0, gain=1.0, **kw):
    d = dict(t=b(beat), inst=inst, pitch=pitch, dur=b(dur_beats), vel=vel, pan=pan, gain=gain); d.update(kw); sc.append(d)

# A — the light (b0–b4): one glass ping with the light, a low cello under it, sparse felt piano
n(BE['lightOn'], 'hand_chimes', 'A5', 3, .45, .25, .8)
n(BE['lightOn'], 'piano', 'D5', 3, .22, -.15, .9)
n(1.0, 'cellos', 'D3', 9.5, .32, -.2, .75, attack=.9)
n(2.5, 'piano', 'A4', 2, .18, -.1, .8)
n(BE['tag1'], 'piano', 'F4', 1.5, .2, -.1, .8)
# B — develop (b4–b11): bowed vibraphone Dm(add9) opens with the front; glass harp climbs with it
for p, v in [('D4', .40), ('F4', .36), ('A4', .38), ('E5', .30)]:
    n(BE['develop'], 'vibraphone_bowed', p, 6.5, v, .1, .8, attack=1.0)
for k, p in enumerate(['A5', 'D6', 'E6', 'F6']):
    n(BE['develop'] + k, 'glass', p, 2.5, .42 + .04 * k, .3 - .15 * k, .75)
n(8, 'violas', 'A3', 3.5, .3, .25, .7, attack=.7)
for bb, p in [(8, 'D4'), (9, 'A4'), (10, 'F5'), (10.5, 'E5')]:
    n(bb, 'piano', p, 1.2, .24, -.2, .85)
n(BE['drop1'], 'contrabass_pizz', 'D2', 2, .45, 0, .8)
# plucked strings from core/audio/pluck.py: the measuring scale and the sounder's bass are plucked, not sampled,
# so the tick (a dry, short, bright strike) and the string share one attack
plk = np.zeros((N, 2), np.float32); sc_pl = []
def pk(beat, preset, pitch, vel, pan=0.0, gain=1.0, dur=None, **kw):
    y = P.pluck(preset, pitch, dur, vel, **kw)
    add(plk, y, b(beat), gain, pan); sc_pl.append((b(beat), 'pluck:' + preset, pitch))
# C — measure (b11–b17): a plucked step with every tick (8ths -> 16ths -> 32nds), tremolo strings swell.
# harp waveguide carries the line (shorter decay as the steps get closer), sampled pizzicato stays underneath for body
SCALE = ['D3', 'F3', 'G3', 'A3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'C5', 'D5', 'E5', 'F5', 'A5']
for k, (ft, bb) in enumerate(TL['TICKS']):
    inst = 'cellos_pizz' if k < 5 else 'violins_pizz'
    n(bb, inst, SCALE[k], .5, .34 + .02 * k, -.3 + .04 * k, .45)
    pk(bb, 'harp', SCALE[k], .55 + .025 * k, -.3 + .04 * k, .6, dur=None, t60=2.4 - .1 * k, bright=.45 + .02 * k, pos=.18)
n(BE['ruler'], 'contrabass_pizz', 'D2', 1, .45, 0, .8)
n(12, 'violins_trem', 'A4', 4.0, .32, .3, .55, attack=2.2)
n(12, 'violas', 'D4', 4.0, .3, -.2, .55, attack=2.2)
# the landing on 120: low D, piano, glass
n(BE['count'], 'piano', 'D2', 2, .5, -.1, .9); n(BE['count'], 'piano', 'A2', 2, .42, -.05, .85); n(BE['count'], 'piano', 'D4', 2, .38, .1, .85)
n(BE['count'], 'contrabass_pizz', 'D2', 2, .6, 0, .9)
n(BE['count'], 'glass', 'D6', 2, .55, .25, .8)
# — hush b18–b20: nothing —
# D — the turn (b20): D major add9, glass + hand chimes + low strings: the most important sound
n(BE['light12'], 'glass', 'D6', 4, .7, .2, 1.0)
n(BE['light12'], 'hand_chimes', 'A5', 4, .6, -.25, .9)
n(BE['light12'], 'hand_chimes', 'F#6', 4, .45, .35, .7)
for p, v in [('D2', .38), ('A2', .34), ('F#3', .36), ('E4', .32)]:
    n(BE['light12'], 'piano', p, 3, v, -.05, .9)
n(BE['light12'], 'contrabass', 'D2', 5, .3, 0, .55, attack=.05)
n(BE['light12'], 'violas', 'F#3', 5, .28, .2, .55, attack=.4)
n(BE['light12'], 'cellos', 'A2', 5, .3, -.2, .6, attack=.3)
# the sounder's bass: plucked upright bass (waveguide) on every beat under the Morse "1" and "2", with a ghost
# note on the and of 22 and 24 that answers the dashes
for bb, p, v in [(21, 'D2', .62), (22, 'A1', .55), (22.5, 'A1', .32), (23, 'D2', .6), (24, 'A1', .55), (24.5, 'A1', .3)]:
    pk(bb, 'upright_bass_pizz', p, v, 0.0, .7)
for bb, p in [(21, 'D5'), (22, 'A4'), (23, 'F#4'), (24, 'E4')]:
    n(bb, 'piano', p, 1, .26, .15, .85)
# E — into the photograph (b25 on): G -> A -> D, slowing down
n(BE['cardsOut'], 'cellos', 'G2', 1.0, .34, -.2, .6, attack=.15)
n(BE['cardsOut'], 'piano', 'B3', 1, .22, .1, .8)
n(BE['drop2'], 'cellos', 'A2', 1.5, .38, -.2, .65, attack=.15)
n(BE['drop2'], 'piano', 'C#4', 1, .24, .1, .8)
n(BE['drop2'], 'violins_trem', 'E5', 1.5, .25, .3, .5, attack=.8)
T_END = DUR / B
for inst, p, v, g in [('contrabass', 'D2', .45, .75), ('cellos', 'D3', .4, .65), ('violas', 'A3', .36, .6), ('violins', 'F#4', .32, .55), ('violins', 'D5', .28, .45)]:
    n(BE['enter'], inst, p, T_END - BE['enter'] + 1, v, rng.uniform(-.3, .3), g, attack=.25, release=1.2)
for p, v in [('A4', .34), ('E5', .26)]:
    n(BE['enter'], 'vibraphone_bowed', p, T_END - BE['enter'], v, .2, .7, attack=.6)
n(BE['enter'], 'glass', 'D6', 4, .55, .25, .85)
for p, v in [('D2', .42), ('A2', .34), ('D3', .3), ('F#3', .28)]:
    n(BE['enter'], 'piano', p, 4, v, -.05, .85)
n(29, 'piano', 'A4', 2.5, .22, .15, .8)          # the line slows: gaps of 1.5, then hold
n(30.5, 'piano', 'F#4', 2, .2, .1, .8)

music = S.render(sc, dur=N / SR, master=False)[:N] + plk
# felt: soften the piano-heavy top a little, then a room
music = np.stack([lp(music[:, 0], 7500), lp(music[:, 1], 7500)], 1)
music = S.room(music, size=.5, mix=.2)
# the hush: the music bus is cut away before b18 and stays silent to b20
tt = np.arange(N) / SR
hush0, hush1 = TL['HUSH']
gate = np.where((tt >= b(17.25)) & (tt < hush0), np.clip((hush0 - tt) / (hush0 - b(17.25)), 0, 1) ** 1.5, np.where((tt >= hush0) & (tt < hush1 - 0.002), 0, 1))
music *= gate[:, None]

# ---------------------------------------------------------------- foley (from window.EV)
fol = np.zeros((N, 2), np.float32)
cues = []          # (t, kind) the audio cue placed for every visual event

def ring(freqs, d, v, tau=.25):
    tt = t_(d); y = sum(np.sin(2 * np.pi * f * tt) * np.exp(-tt / (tau * (1 - .25 * i))) for i, f in enumerate(freqs))
    return y * v / len(freqs)

def starter(v):
    y = hp(noise(.012), 2500) * env_exp(.012, .002) * .9
    y = np.concatenate([y, np.zeros(int(.09 * SR))])
    buzz = np.sin(2 * np.pi * 100 * t_(.1)) * env_exp(.1, .03) * .25 + np.sin(2 * np.pi * 300 * t_(.1)) * env_exp(.1, .02) * .1
    y[:len(buzz)] += buzz
    return y * v

def loupe(v):
    c = clack(.9, 1.0)
    r = ring([3150, 4720, 6240], .6, .35, .22)
    y = np.zeros(max(len(c), len(r))); y[:len(c)] += c * .8; y[:len(r)] += r
    return y * v

def paper(d, v, lo=900, hi=5000):
    tt = t_(d); e = np.sin(np.pi * np.clip(tt / d, 0, 1)) ** 1.5
    return bp(noise(d), lo, hi) * e * v * .5

def tick(v, f=2600):
    y = hp(noise(.006), 1800) * env_exp(.006, .0012)
    r = np.sin(2 * np.pi * f * t_(.05)) * env_exp(.05, .008) * .35
    out = np.zeros(len(r)); out[:len(y)] += y; out += r
    return out * v

def pen(d, v):
    tt = t_(d); scr = bp(noise(d), 2200, 7000) * (0.6 + 0.4 * np.sin(2 * np.pi * 23 * tt) ** 2)
    e = np.minimum(1, tt / .03) * np.clip((d - tt) / .12, 0, 1)
    return scr * e * v * .45

def sounder(v, gap):
    c1 = clack(1.6, 1.0); r1 = ring([1850, 2950], .1, .5, .025)
    d = np.zeros(max(len(c1), len(r1))); d[:len(c1)] += c1 * .7; d[:len(r1)] += r1
    c2 = clack(2.1, .7); r2 = ring([2400, 3600], .08, .35, .02)
    u = np.zeros(max(len(c2), len(r2))); u[:len(c2)] += c2 * .5; u[:len(r2)] += r2
    out = np.zeros(int(gap * SR) + len(u)); out[:len(d)] += d; out[int(gap * SR):int(gap * SR) + len(u)] += u * .8
    return out * v

PK = dict(starter=.30, lighton=.26, tag=.16, loupe=.42, develop=.05, push=.08, ruler=.13, tick=.17, caliper=.2, land=.26,
          rise=.08, lift=.28, glide=.1, light12=.18, card=.15, pen=.16, sounder=.26, wipe=.1, rim=.13, title=.12)
_add = add
def add(buf, x, at, gain=1.0, pan=0.0, _k=[None]):
    if buf is fol and _k[0] is not None:
        x = norm(np.asarray(x, np.float64), PK.get(_k[0], .2)) * gain
        gain = 1.0
    _add(buf, x, at, gain, pan)
for e in EV:
    t, k, g = e['t'], e['type'], e.get('g', 1.0)
    add.__defaults__[2][0] = k
    if k == 'starter': add(fol, starter(.5 * g), t, 1, -.3); cues.append((t, k))
    elif k == 'lighton': add(fol, starter(.35), t, 1, -.3); add(fol, lp(brown(.25), 160) * env_exp(.25, .07) * .25, t, 1, 0); cues.append((t, k))
    elif k == 'tag': add(fol, click(1.7, .35), t, 1, -.4); cues.append((t, k))
    elif k == 'loupe': add(fol, loupe(.65 * g), t, 1, 0); cues.append((t, k))
    elif k == 'develop': add(fol, paper(b(3), .10, 3000, 9000), t, 1, .2); cues.append((t, k))
    elif k == 'push': add(fol, whoosh(e['dur'], .14), t, 1, 0); cues.append((t, k))
    elif k == 'ruler': y = paper(.45, .35, 1200, 6000); y[:len(tick(1, 1700))] += tick(1.2, 1700); add(fol, y, t, 1, .1); cues.append((t, k))
    elif k == 'tick': add(fol, tick(.42, 2200 + 14 * e['ft']), t, 1, -.2 + e['ft'] / 300); cues.append((t, k))
    elif k == 'caliper': add(fol, tick(.5, 4100), t, 1, -.25); cues.append((t, k))
    elif k == 'land': add(fol, tick(.6, 3800), t, 1, .2); add(fol, ring([2093, 3136], .9, .25, .35), t, 1, .2); cues.append((t, k))
    elif k == 'rise': add(fol, whoosh(e['dur'], .16)[::-1].copy(), t, 1, 0); cues.append((t, k))
    elif k == 'lift': add(fol, loupe(.38), t, 1, 0); cues.append((t, k))
    elif k == 'glide': add(fol, paper(e['dur'], .22, 600, 4000), t, 1, .3); cues.append((t, k))
    elif k == 'light12': add(fol, ring([4186, 6272], .7, .22, .3), t, 1, -.2); cues.append((t, k))
    elif k == 'card': add(fol, click(1.3, .32 * g), t, 1, -.3 if g == 1 else .3); cues.append((t, k))
    elif k == 'pen': add(fol, pen(.45, .55), t, 1, .35); cues.append((t, k))
    elif k == 'sounder':
        soft = .55 if t < b(BE['cardsOut']) else .32
        add(fol, sounder(soft, e['len']), t, 1, .3); cues.append((t, k))
    elif k == 'wipe': add(fol, paper(.3, .25, 1500, 7000), t, 1, -.2); cues.append((t, k))
    elif k == 'rim': add(fol, whoosh(e['dur'] + .3, .25), t, 1, 0); cues.append((t, k))
    elif k == 'place': cues.append((t, k))
    elif k == 'title': add(fol, click(1.2, .25), t, 1, -.4); cues.append((t, k))

# ---------------------------------------------------------------- beds
beds = np.zeros((N, 2), np.float32)
# ballast hum: 100 Hz + harmonics; follows the light, steps out for the hush, gives way to the place's air
hum = (np.sin(2 * np.pi * 100 * tt) * .5 + np.sin(2 * np.pi * 200 * tt) * .3 + np.sin(2 * np.pi * 300 * tt) * .18 + np.sin(2 * np.pi * 500 * tt) * .06)
hum *= 1 + .08 * np.sin(2 * np.pi * .7 * tt)
hk = np.interp(tt, [0, .02, .2, b(.5), b(.5) + .02, b(.5) + .2, b(1), b(1) + .1, b(17), hush0, hush1, hush1 + .4, b(BE['drop2']), b(BE['enter']), DUR + 1],
                   [0, .5, .1, .1, .45, .12, .12, 1, 1, 0, 0, .55, .55, 0, 0])
beds[:, 0] += hum * hk * .012; beds[:, 1] += hum * hk * .012
room = lp(brown(N / SR), 900)[:N]; room = room / np.abs(room).max()
beds += (room * .0025)[:, None]                                   # room tone: never digital zero, even in the hush
# the place: wind over the dunes and a far surf, from the push into the photograph to the end
wk = np.interp(tt, [0, b(BE['drop2']), b(BE['enter']), DUR], [0, 0, 1, 1])
wl = bp(noise(N / SR)[:N], 200, 1800) * (0.6 + 0.4 * np.interp(tt, np.linspace(0, DUR, 40), rng.uniform(0, 1, 40)))
wr = bp(noise(N / SR)[:N], 200, 1800) * (0.6 + 0.4 * np.interp(tt, np.linspace(0, DUR, 40), rng.uniform(0, 1, 40)))
surf = lp(brown(N / SR), 400)[:N]; surf = surf / np.abs(surf).max() * (0.6 + 0.4 * np.sin(2 * np.pi * tt / 6.5) ** 2)
beds[:, 0] += (wl * .05 + surf * .05) * wk; beds[:, 1] += (wr * .05 + surf * .05) * wk

# ---------------------------------------------------------------- mix
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-12)
music = hp(music.T, 38).T; fol = hp(fol.T, 60).T
mix = music * 1.0 + fol * 1.0 + beds * 1.0
mix = mix - 0.38 * np.stack([lp(mix[:, 0], 110), lp(mix[:, 1], 110)], 1)      # low shelf: keep 20-120 Hz about 3 dB under the mids
# master: stereo-linked compressor (vectorised envelope), make-up, look-ahead limiter
from scipy.ndimage import maximum_filter1d, uniform_filter1d
env = uniform_filter1d(maximum_filter1d(np.abs(mix).max(1), int(.003 * SR)), int(.04 * SR))
thr, ratio = 0.035, 3.0
gr = np.where(env > thr, (thr / np.maximum(env, 1e-9)) ** (1 - 1 / ratio), 1.0)
mix = mix * gr[:, None] * 6.9
mix = np.stack([limit(mix[:, 0], .66), limit(mix[:, 1], .66)], 1).astype(np.float32)
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR)
for nm, x in [('music', music), ('foley', fol), ('beds', beds)]:
    sf.write(os.path.join(HERE, 'out', 'stems', nm + '.wav'), x.astype(np.float32), SR)
json.dump({'cues': cues, 'score': [[d['t'], d['inst'], d['pitch']] for d in sc] + [list(q) for q in sc_pl]}, open(os.path.join(HERE, 'out', 'audio_cues.json'), 'w'))
lo = mix[int(hush0 * SR) + 2400:int(hush1 * SR) - 240]
print('mix', mix.shape, 'peak', float(np.abs(mix).max()), 'rms dBFS', 20 * np.log10(rms(mix)), 'hush rms dBFS', 20 * np.log10(rms(lo)))
print('instruments', sorted({d['inst'] for d in sc}), 'plucked', sorted({q[1] for q in sc_pl}), len(sc_pl))
