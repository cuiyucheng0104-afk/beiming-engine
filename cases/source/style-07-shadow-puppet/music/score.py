"""渔夫还珠 — original score. Gong-and-drum patterns (锣鼓经 thinking) + a jinghu-like fiddle (erhu samples pitched and
coloured nasal, glides by variable-speed resampling) + sanxian-like plucks (pluck.py) + one suona-like shriek (oboe + formants + saturation) + the pearl bell.
All times come from out/timeline.json (written from timeline.js). Melodies are original.
Run: $LIB/.venv/bin/python music/score.py   (needs LIB in the environment or the default path)
Writes out/stems/{luogu,jinghu,suona,bell,sanxian}.wav (48 kHz stereo float) and out/score_cues.json."""
import sys, os, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as PK
from core.audio.sfx import SR, add, bp, hp, lp

TL = json.load(open(os.path.join(HERE, 'out/timeline.json')))
T = TL['t']; DUR = TL['dur']; N = int(DUR * SR) + SR
SEC = {s['id']: s for s in TL['secs']}
def at(sec, beat): s = SEC[sec]; return round(s['t'] + beat * 60 / s['bpm'], 4)
S.seed(11)
G4 = 67     # tonic G (huan-yin: G A B D E; ku-yin: raised 4th, lowered 7th)
stems = {k: np.zeros((N, 2), np.float32) for k in ['luogu', 'jinghu', 'suona', 'bell', 'sanxian']}
CUES = []
ONSET = {}
def onset(x):            # intrinsic attack delay of a sound: first sample above 10 % of its peak
    a = np.abs(x); return int(np.argmax(a > .1 * a.max())) if a.max() > 0 else 0
def pl(buf, x, t, gain=1.0, pan=0.0):
    """place a sound so that its attack (not its file start) lands exactly on t"""
    o = onset(x); add(buf, x, t - o / SR, gain, pan); ONSET[round(t, 4)] = max(ONSET.get(round(t, 4), 0), o)
def cue(name, t, stem): CUES.append({'name': name, 't': round(float(t), 4), 'stem': stem, 'comp_ms': round(ONSET.get(round(t, 4), 0) / SR * 1000, 2)})


def warp(x, semis):
    x = np.asarray(x, np.float64); n = len(x)
    t = np.arange(int(n * 1.7) + SR) / SR
    ph = np.concatenate([[0], np.cumsum(2 ** (semis(t)[:-1] / 12.0))])
    ph = ph[ph < n - 1]; i = ph.astype(int); f = ph - i
    return (x[i] * (1 - f) + x[i + 1] * f).astype(np.float32)
def fade(x, fi=.003, fo=.05):
    x = x.copy(); a, b = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if b and b < len(x): x[-b:] *= np.linspace(1, 0, b)
    return x
def trim(x, d, fo=.06):
    n = int(d * SR); x = x[:n].copy() if len(x) > n else np.pad(x, (0, n - len(x)))
    return fade(x, 0, fo)
def mixd(*xs):
    n = max(len(x) for x, _ in xs); o = np.zeros(n, np.float32)
    for x, g in xs: o[:len(x)] += x * g
    return o

# ---------------- percussion ----------------
def small_gong(v=.6, rise=1.8): return warp(S.hit('gong2', 'small', v), lambda t: rise * np.clip(t / .12, 0, 1))
def big_gong(v=.85, drop=-3.0):
    y = warp(S.hit('gong2', 'big', v), lambda t: drop * np.clip(t / .45, 0, 1) ** .7); return y + .3 * lp(y, 240)
def bangu(v=.6): return trim(S.hit('woodblock', 'a', v), .22, .05)
def clapper(v=.5): return trim(S.hit('claves', None, v), .2, .05)
def cym(v=.6, d=.5): return trim(S.hit('clash', 'short', v), d, .2)
def crash(v=.8, d=2.0): return trim(S.hit('crash', None, v), d, .7)
def tanggu(v=.6, d=.9): return trim(mixd((S.hit('frame_drum', 'large', v), 1), (S.hit('bass_drum', None, v * .7), .55)), d, .25)
def muyu(v=.4): return trim(S.hit('log_drum', 'hi', v), .3, .05)

L = stems['luogu']
# ===== A 慢板 (80 BPM): one small-gong "tai" per lamp, each a step higher
for i, (k, rise) in enumerate([('lamp1', 1.2), ('lamp2', 1.9), ('lamp3', 2.6)]):
    pl(L, small_gong(.5 + .07 * i, rise), T[k], .75, -.25); cue(k, T[k], 'luogu')
pl(L, cym(.35, .6), T['lamp3'], .35, .3)
# 板鼓 + 檀板 pulse: "da · ta" on every beat from the third lamp to the cast
for b in range(2, 7):
    pl(L, bangu(.42 if b % 2 else .5), at('A', b), .5, .15); cue(f'bangu{b}', at('A', b), 'luogu')
    pl(L, clapper(.32), at('A', b + .5), .35, -.1)
pl(L, bangu(.55), T['netUp'], .55, .15); pl(L, bangu(.4), T['netUp'] + .1875, .45, .15)
pl(L, small_gong(.55, 1.4), T['netUp'], .45, -.25)
# cast: cymbal + small gong; splash: hall drum
pl(L, cym(.6, .9), T['cast'], .6, .3); pl(L, small_gong(.62, 2.4), T['cast'], .55, -.25); cue('cast', T['cast'], 'luogu')
pl(L, tanggu(.6, 1.0), T['splash'], .7, 0); cue('splash', T['splash'], 'luogu')
# 板鼓 accelerating roll 6.0 → 7.5 (the clear acceleration)
t, gap, i = T['splash'], .375, 0
while t < T['surge'] - .03:
    pl(L, bangu(min(.85, .35 + .045 * i)), t, .5 + .02 * i, .15); t += gap; gap = max(.045, gap * .8); i += 1
pl(L, small_gong(.6, 3.0), T['pearl'], .55, -.2); cue('pearl', T['pearl'], 'luogu')
sc = trim(S.hit('sus_cymbal', 'cresc', .55), T['surge'] - T['pearl'] + .05, .03)
add(L, sc, T['surge'] - len(sc) / SR, .45, .25)        # swell ends exactly on the surge

# ===== B 急急风 (160 BPM)
pl(L, big_gong(.7, -2.5), T['surge'], .75, 0); pl(L, crash(.8, 1.6), T['surge'], .6, .2); pl(L, tanggu(.85), T['surge'], .9, 0)
cue('surge', T['surge'], 'luogu')
for b in range(1, 10):
    tb = at('B', b)
    acc = b in (2, 4)
    pl(L, tanggu(.8 if acc else .55 + .03 * b, .5), tb, .75 if acc else .55, -.05)
    pl(L, cym(.5 + .03 * b, .3), tb + .1875, .42, .3)                       # "才" on the off-beat
    if b % 2 == 1 and b < 9: pl(L, small_gong(.45, 1.6), tb, .35, -.3)
    cue(f'jjf{b}', tb, 'luogu')
for k in range(int((T['gong'] - T['surge']) / .09375)):                         # 板鼓 sixteenths, then thirty-seconds
    tk = T['surge'] + k * .09375
    pl(L, bangu(.3 + .2 * (tk > T['offscreen'])), tk, .3 + .15 * (tk > T['offscreen']), .15)
    if tk > T['offscreen'] + .75: pl(L, bangu(.4), tk + .046875, .35, .15)
pl(L, crash(.9, 1.4), T['breach'], .65, .2); cue('breach', T['breach'], 'luogu')
pl(L, big_gong(.8, -3), T['liang'], .8, 0); pl(L, crash(.85, 1.2), T['liang'], .55, -.2); cue('liang', T['liang'], 'luogu')
# hall-drum roll building from the off-screen move to the gong
t = T['offscreen'] + .375
while t < T['gong'] - .09:
    u = (t - T['offscreen']) / (T['gong'] - T['offscreen'])
    pl(L, tanggu(.45 + .45 * u, .3), t, .4 + .5 * u, (-1) ** int(t * 20) * .15); t += .1875 if u < .5 else .09375 if u < .8 else .046875
pl(L, crash(.9, .5), T['crash'], .6, .2); cue('crash', T['crash'], 'luogu')
# THE gong: kuang + crash + drum, then a hard stop at the silence (≤ 25 ms fade, tails included)
pl(L, big_gong(.98, -3.6), T['gong'], 1.5, 0); pl(L, crash(1.0, 1.0), T['gong'], .7, 0); pl(L, tanggu(1.0, .4), T['gong'], 1.0, 0)
cue('gong', T['gong'], 'luogu')

# ===== D (80 BPM): 木鱼, a soft "tai" on the bow, the clapper at the very end lives in the foley
for b in (2, 3, 4, 5):
    pl(L, muyu(.32), at('D', b), .42, .1); cue(f'muyu{b}', at('D', b), 'luogu')
pl(L, small_gong(.38, 1.2), T['bow'], .4, -.2); cue('bow', T['bow'], 'luogu')
sw = trim(S.hit('sus_cymbal', 'bow', .45), 2.6, 1.2)
add(L, sw, T['swap'], .3, .3); cue('swap', T['swap'], 'luogu')
pl(L, big_gong(.3, -2), T['clap'], .3, 0)

# ---------------- the pearl bell: first sound after the silence ----------------
B = stems['bell']
bell = mixd((S.note('hand_chimes', 'G6', 3.6, .75, release=2.5), 1.0), (S.note('glockenspiel', 'D7', 2.0, .35, release=1.6), .45))
pl(B, bell, T['ting'], 1.0, .05); pl(B, trim(S.hit('nepal_bells', None, .35), 2.5, 1.0), T['ting'] + .01, .25, -.2)
cue('ting', T['ting'], 'bell')
pl(B, S.note('hand_chimes', 'D6', 2.4, .32, release=1.8), T['swap'], .35, .2)        # a soft echo when the dragon becomes rain

# ---------------- jinghu (erhu sample, brighter and nasal) ----------------
def jinghu(m, dur, v=.6, slide=(0, .01), vib=(6.2, .22, .18), fall=(0, .01), trem=0):
    x = S.note('erhu', m, dur + .3, v, release=.2)
    so, st = slide; fo, ft = fall; hz, dep, v0 = vib
    def semis(t):
        s = so * np.clip(1 - t / st, 0, 1) ** 1.6 + dep * np.clip((t - v0) / .25, 0, 1) * np.sin(2 * np.pi * hz * t)
        return s + fo * np.clip((t - (dur - ft)) / ft, 0, 1) ** 2
    y = warp(x, semis)
    if trem: y = y * (1 + .4 * np.sin(2 * np.pi * trem * np.arange(len(y)) / SR))
    y = y + .9 * hp(y, 2600) + .8 * bp(y, 1000, 1500) + .5 * bp(y, 2400, 3400)
    return trim(np.tanh(y * 1.7) / 1.7, dur + .18, .15)
J = stems['jinghu']
# A: huan-yin phrase (rowing, the net)
phA = [(T['lamp3'], 74, .72, (-2, .12)), (at('A', 3), 76, .36, (0, .01)), (at('A', 3.5), 74, .36, (1, .05)), (at('A', 4), 71, .72, (-1, .08)),
       (at('A', 5), 69, .36, (0, .01)), (at('A', 5.5), 71, .36, (0, .01)), (T['netUp'], 74, .72, (-2, .1)), (T['cast'], 79, .36, (-3, .06)), (at('A', 7.5), 76, .36, (0, .01))]
for t, m, d, sl in phA:
    pl(J, jinghu(m, d, .62, sl), t, .5, -.15)
cue('jinghuA', T['lamp3'], 'jinghu')
# A': tense tremolo rising to the surge
x = S.note('erhu', 74, 1.7, .55, release=.1)
rise = lambda t: 7 * np.clip(t / 1.5, 0, 1) ** 1.4 + .3 * np.sin(2 * np.pi * (6 + 4 * t) * t)
y = warp(x, rise); y = y * (1 + .45 * np.sin(2 * np.pi * 13 * np.arange(len(y)) / SR))
y = y + .9 * hp(y, 2600) + .8 * bp(y, 1000, 1500); y = trim(np.tanh(y * 1.7) / 1.7, T['surge'] - T['splash'], .02)
add(J, y, T['splash'], .38, -.15)
# D: ku-yin (raised 4th = C+.45, lowered 7th = F#−.5), the return
phD = [(T['handover'], 74, .72, (-2, .2), (0, .01)), (at('D', 2), 72.45, .36, (0, .01), (0, .01)), (at('D', 2.5), 71, .36, (.5, .05), (0, .01)),
       (T['bow'], 69, .72, (-1, .1), (0, .01)), (T['snuff3'], 65.5, .36, (1, .06), (0, .01)), (at('D', 4.5), 67, 1.95, (-1.5, .2), (-.6, .5))]
for t, m, d, sl, fa in phD:
    pl(J, jinghu(m, d, .55, sl, vib=(5.2, .26, .25), fall=fa), t, .46, -.12)
cue('jinghuD', T['handover'], 'jinghu')

# ---------------- suona-like shriek, once, on the dragon's pose ----------------
def suona(m, dur, v=.85, slide=(-3, .1), vib=(6.8, .35, .15)):
    x = S.note('oboe', m, dur + .3, v, release=.15); so, st = slide; hz, dep, v0 = vib
    y = warp(x, lambda t: so * np.clip(1 - t / st, 0, 1) ** 1.5 + dep * np.clip((t - v0) / .2, 0, 1) * np.sin(2 * np.pi * hz * t))
    y = y + 1.2 * bp(y, 1200, 3000) + .5 * hp(y, 3500); return trim(np.tanh(y * 2.4) / 2.4, dur, .12)
SU = stems['suona']
pl(SU, suona(86, .7, .9, (-4, .12)), T['liang'], .55, .2); pl(SU, suona(83, .2, .8, (0, .01)), T['liang'] + .75, .45, .2); pl(SU, suona(81, .45, .8, (1, .04)), T['liang'] + .9375, .45, .2)
cue('suona', T['liang'], 'suona')

# ---------------- sanxian-like plucks (pluck.py shamisen model, sawari buzz ≈ the 三弦 bridge buzz) ----------------
SX = stems['sanxian']
def sanxian(m, v=.7, d=.9, bend=None):
    kw = dict(buzz=.55); 
    if bend: kw['bend'] = bend
    return trim(PK.pluck('shamisen', m, d, v, **kw), d, .12)
# A: the rowing pulse — root/fifth on the beat, a grace on the off-beat (G3 D4 / A3 B3), one per oar stroke
for b, m in zip(range(1, 9), [55, 62, 55, 62, 59, 57, 62, 67]):
    pl(SX, sanxian(m, .62 + .03 * (b % 2), .7), at('A', b), .55, .2)
    if b in (3, 5): pl(SX, sanxian(m + 2, .45, .3), at('A', b + .5), .35, .2)
cue('sanxianA', at('A', 1), 'sanxian')
# B: two hard plucks with a falling bend on the breach and the pose
for t0 in (T['breach'], T['liang']): pl(SX, sanxian(67, .9, .6, bend=[(0, 0), (.08, 0), (.4, -2)]), t0, .5, .25)
# D: the bow and the lamps — low plucks, ku-yin colour
for t0, m in [(T['bow'], 55), (T['snuff3'], 50), (T['snuff2'], 55)]:
    pl(SX, sanxian(m, .5, 1.2, bend=[(0, 0), (.3, 0), (.9, -.5)]), t0, .42, .15)

# ---------------- reverb, hard stop, write ----------------
rv = {'luogu': (.38, .18), 'jinghu': (.4, .2), 'suona': (.35, .15), 'bell': (.7, .38), 'sanxian': (.35, .16)}
s0, s1 = int(T['silence'] * SR), int(T['ting'] * SR)
for k, x in stems.items():
    y = S.room(x, size=rv[k][0], mix=rv[k][1])
    # nothing from before the gong may leak into the silence (fade over 25 ms)
    f = int(.025 * SR); y[s0:s0 + f] *= np.linspace(1, 0, f)[:, None]; y[s0 + f:s1] = 0
    stems[k] = y.astype(np.float32)
os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
for k, x in stems.items(): sf.write(os.path.join(HERE, f'out/stems/{k}.wav'), x[:int(DUR * SR)], SR, subtype='FLOAT')
json.dump(sorted(CUES, key=lambda c: c['t']), open(os.path.join(HERE, 'out/score_cues.json'), 'w'), indent=1)
print('score stems →', os.path.join(HERE, 'out/stems'), '| cues', len(CUES))
for k, x in stems.items(): print(f'  {k:7s} peak {20*np.log10(np.abs(x).max()+1e-9):6.1f} dBFS')
