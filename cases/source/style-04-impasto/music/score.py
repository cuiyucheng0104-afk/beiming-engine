# 红色自行车 — score. 3/4 waltz at 96 BPM: accordion, double-bass pizzicato, brushed snare.
# A minor while the world is grey; cut on the brake; silence; A major tutti when the knife opens the sky.
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio import sampler as S
from core.audio.sfx import SR, add, limit, bp, hp, lp, noise, t_, env_exp, norm
HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, '../out/timeline.json')))
T, BEAT, BAR = TL['T'], TL['BEAT'], TL['BAR']
DUR = TL['DUR']
S.seed(11)
tb = lambda bar, beat=1: bar * BAR + (beat - 1) * BEAT
ev, onsets = [], []          # onsets: every musical attack, for the cue check
def E(t, inst, pitch, dur, vel, pan=0., **kw):
    ev.append(dict(t=t, inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan, **kw)); onsets.append([round(t, 4), inst, str(pitch)])

# ---------------- intro (bars 0–1): accordion drone, bowed bass far away
E(0.0, 'accordion', 'E3', BAR * 2 - .1, .3, -.1, attack=.35); E(0.0, 'accordion', 'A3', BAR * 2 - .1, .28, .1, attack=.35)
E(tb(1), 'accordion', 'C4', BAR - .1, .26, .2, attack=.3)
E(0.0, 'contrabass', 'A1', BAR * 2 - .2, .32, 0, attack=.8)

# ---------------- part A: A-minor waltz while he rides through the grey (bars 2–4)
CH = {'Am': (['A3', 'C4', 'E4'], 'A1', 'E2'), 'Dm': (['A3', 'D4', 'F4'], 'D2', 'A1'), 'E7': (['G#3', 'B3', 'D4', 'E4'], 'E2', 'B1'),
      'A': (['A3', 'C#4', 'E4'], 'A1', 'E2'), 'D': (['A3', 'D4', 'F#4'], 'D2', 'A1'), 'Amaj': (['C#4', 'E4', 'A4'], 'A1', 'E2')}
for bar, ch in [(2, 'Am'), (3, 'Dm'), (4, 'E7')]:
    notes, root, fifth = CH[ch]
    E(tb(bar), 'contrabass_pizz', root, .9, .8, -.05)
    if bar == 4: E(tb(bar, 3), 'contrabass_pizz', fifth, .5, .7, -.05)      # the bass starts walking: he stands up
    for bt in (2, 3):
        for p in notes: E(tb(bar, bt), 'accordion', p, BEAT * .5, .44 if bt == 2 else .38, .18)
MEL_A = [(2, 1, 2, 'E5'), (2, 3, 1, 'C5'), (3, 1, 1, 'D5'), (3, 2, 1, 'F5'), (3, 3, 1, 'E5'),
         (4, 1, .5, 'D5'), (4, 1.5, .5, 'E5'), (4, 2, .5, 'F5'), (4, 2.5, .5, 'E5'), (4, 3, .5, 'D5'), (4, 3.5, .5, 'B4')]
for b, bt, n, p in MEL_A: E(tb(b, bt), 'accordion', p, n * BEAT * .92, .55, -.15)
# brake (bar 5 beat 1): one short stab and the bass, then nothing
E(T['brake'], 'contrabass_pizz', 'E2', .6, .9, 0)
for p in ['G#3', 'D4', 'E4']: E(T['brake'], 'accordion', p, .22, .5, .1, release=.06)
E(T['stop'], 'contrabass_pizz', 'A1', .5, .55, 0)          # the foot goes down: the last note before the silence
partA = S.render([e for e in ev], dur=DUR + .2)
partA = S.room(partA, size=.35, mix=.16)
# hard cut: everything gone before the stop (the silence is real)
c0, c1 = int((T['stop'] + .22) * SR), int((T['stop'] + .4) * SR)
partA[c0:c1] *= np.linspace(1, 0, c1 - c0)[:, None] ** 2; partA[c1:] = 0
evA = len(ev); ev.clear()

# ---------------- part B: A-major tutti from the first scrape (bars 6–10)
c0 = T['scrape1']
for k, p in enumerate(['A2', 'E3', 'A3', 'C#4', 'E4', 'A4', 'C#5', 'E5', 'A5']): E(c0 + k * .03, 'harp', p, 1.6, .5 + k * .03, -.3)
E(c0, 'contrabass', 'A1', BAR * 3 - .1, .55, 0, attack=.02)
for p in ['A2', 'E3']: E(c0, 'cellos', p, BAR * 2 - .1, .5, -.2, attack=.05)
E(c0, 'timpani', 'A2', 1.2, .6, 0); E(c0, 'sus_cymbal', 'hit', None, .35, .2)
for s in TL['SCRAPES']: E(s['t'], 'glockenspiel', s['pitch'], 1.6, .8, .2)
prog = [(6, 'A'), (7, 'D'), (8, 'Amaj'), (9, 'E7')]
for bar, ch in prog:
    notes, root, fifth = CH[ch]
    E(tb(bar), 'contrabass_pizz', root, .9, .85, -.05)
    E(tb(bar, 3), 'contrabass_pizz', fifth, .5, .62 if bar < 9 else .45, -.05)
    for bt in (2, 3):
        for p in notes: E(tb(bar, bt), 'accordion', p, BEAT * .55, (.5 if bt == 2 else .44) * (.75 if bar == 9 else 1), .18)
        if bar in (7, 8): E(tb(bar, bt), 'violins_pizz', notes[-1].replace('4', '5'), .4, .32, .35)
for p in ['D3', 'A3']: E(tb(7), 'cellos', p, BAR - .1, .42, -.2, attack=.1)
for p in ['A2', 'E3', 'C#4']: E(tb(8), 'cellos', p, BAR - .1, .55, -.2, attack=.05)
MEL_B = [(6, 1, 2, 'A4'), (6, 3, 1, 'C#5'), (7, 1, 1, 'D5'), (7, 2, 1, 'F#5'), (7, 3, 1, 'A5'),
         (8, 1, 2, 'A5'), (8, 3, 1, 'E5'), (9, 1, 1, 'D5'), (9, 2, 1, 'C#5'), (9, 3, 1, 'B4')]
for b, bt, n, p in MEL_B: E(tb(b, bt), 'accordion', p, n * BEAT * .95, .62 if b < 9 else .5, -.15)
E(T['rake'], 'violins', 'A5', BAR * .9, .42, .3, attack=.03); E(T['rake'], 'violins', 'E5', BAR * .9, .36, .35, attack=.03)
E(T['rake'], 'glockenspiel', 'E6', 1.8, .6, .2)
# final chord: everything lands on A
f0 = T['last']
for p in ['A3', 'C#4', 'E4', 'A4']: E(f0, 'accordion', p, DUR - f0 + .3, .5, .1)
E(f0, 'contrabass_pizz', 'A1', 1.2, .85, 0); E(f0, 'cellos', 'A2', DUR - f0 + .3, .45, -.2)
E(f0, 'glockenspiel', 'A6', 2, .55, .2)
for k, p in enumerate(['A2', 'E3', 'A3', 'C#4', 'E4', 'A4']): E(f0 + .02 + k * .06, 'harp', p, 1.5, .4, -.3)
partB = S.render(ev, dur=DUR + .2)
partB = S.room(partB, size=.48, mix=.22)
partB[:int((T['scrape1'] - .002) * SR)] = 0

# the suspended cymbal swells into the raking light (peak exactly on T.rake)
sw = S.hit('sus_cymbal', 'cresc', .55)
env = np.abs(sw); from scipy.ndimage import uniform_filter1d
pk = int(np.argmax(uniform_filter1d(env, 2400)))
cym = np.zeros((len(partB), 2)); add(cym, sw[:pk + int(.05 * SR)] * np.r_[np.ones(pk), np.linspace(1, 0, int(.05 * SR))][:pk + int(.05 * SR)], T['rake'] - pk / SR, .55, .25)
onsets.append([round(T['rake'], 4), 'sus_cymbal_peak', 'cresc'])

# ---------------- brushed snare (synth): a tap on 1, sweeps on 2 and 3 (eighths while he stands)
def sweep(d=.3, v=1.):
    n = noise(d); tt = t_(d); e = np.minimum(1, tt / .045) * np.exp(-np.maximum(0, tt - .045) / (d * .35))
    return norm(bp(n, 1800, 9000) * e) * v
def tap(v=1.):
    d = .12; return norm(bp(noise(d), 400, 6000) * env_exp(d, .025) + np.sin(2 * np.pi * 190 * t_(d)) * env_exp(d, .03) * .4) * v
br = np.zeros((len(partB), 2))
def brushes(b0, b1, eighths=lambda b: False, gain=1.):
    for bar in range(b0, b1):
        add(br, tap(.5 * gain), tb(bar), 1, -.25); onsets.append([round(tb(bar), 4), 'brush', 'tap'])
        steps = [2, 2.5, 3, 3.5] if eighths(bar) else [2, 3]
        for bt in steps:
            add(br, sweep(.24 if eighths(bar) else .34, (.42 if bt % 1 == 0 else .3) * gain), tb(bar, bt), 1, -.3); onsets.append([round(tb(bar, bt), 4), 'brush', 'sweep'])
brushes(2, 5, eighths=lambda b: b == 4)
add(br, tap(.6), T['brake'], 1, -.2)
brushes(6, 10, gain=1.15)
mix = partA + partB + cym + br * .5
n = int(DUR * SR); mix = mix[:n]
mix[-int(.35 * SR):] *= np.linspace(1, 0, int(.35 * SR))[:, None] ** 1.5
mix = np.stack([limit(mix[:, 0], .9), limit(mix[:, 1], .9)], 1)
sf.write(os.path.join(HERE, '../out/score.wav'), mix.astype(np.float32), SR)
json.dump(sorted(onsets), open(os.path.join(HERE, '../out/score_onsets.json'), 'w'))
print('score', mix.shape[0] / SR, 's peak', float(np.abs(mix).max()), 'events', len(onsets))
