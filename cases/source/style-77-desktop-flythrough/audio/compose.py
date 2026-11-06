"""Score for 灵感送达 (Desktop Flythrough). 112.5 BPM, C major, a bar = 2.1333 s, 37 beats = 19.733 s; every note on the 16th grid.
Lo-fi in the style's palette: soft-mallet vibraphone as the warm "electric piano" (slow tremolo, kick-pumped), a marimba theme, plucked double bass
(jazz pizzicato samples + a physically modelled upright), a soft sine kick, claps, shaker, a quiet string pad only under the ending; the lo-fi colour comes
from a vinyl bed (in mix.py), tape wow on the pitched stems and a gentle low-pass. Shape:
  bars 0–2 half-time (kick on 1, clap on 3) · beat 11.5 half a beat of air · bars 3–4 groove · beat 21 → 24 silence (vinyl only)
  · bar 6 the launch: the full theme and double-time drums (the acceleration) · bar 7 drums thin out · bar 8 the slam, then one held chord (the deceleration).
Reads out/timeline.json (node tools/tl.mjs). Writes music/score.wav, music/harmony.json, music/cues.json.
Run:  $LIB/.venv/bin/python -I audio/compose.py"""
import sys, os, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar')); sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from core.audio import sampler as S
from core.audio import pluck as P
from core.audio.sfx import SR, add, lp, hp, t_, env_exp

S.seed(77)
TL = json.load(open(os.path.join(ROOT, 'out/timeline.json')))
BEAT, BAR, S16, DUR = TL['BEAT'], TL['BAR'], TL['S16'], TL['DUR']
CH = {c['bar']: c for c in TL['CHORDS']}
b = lambda n: n * BEAT                       # beat n → seconds (n on the 16th grid: .25 steps)
SIL0, SIL1 = b(21), b(24)                    # the silence
GAP0, GAP1 = b(11.5), b(12)                  # half a beat of air before the drawer lands
SLAM = b(32)
cues = []                                    # (t, what) for the cue check
def cue(t, what): cues.append([round(t, 6), what])

keys, mar, bass, drums = [], [], [], []      # sampler events per stem
def E(lst, beat, inst, p, dur_beats, v, pan=0., **kw): lst.append(dict(t=b(beat), inst=inst, pitch=p, dur=None if dur_beats is None else dur_beats * BEAT, vel=v, pan=pan, **kw))
def silent(beat): return 21 <= beat < 24 or 11.5 <= beat < 12

# ── vibraphone "e-piano": lazy voicings, slightly rolled, on 1 and the "and" of 2; long held chord at the end ──
for bar in range(0, 8):
    c = CH[bar]; v = c['notes']
    hits = [(0, 1.9), (2.5, 1.4)] if bar < 6 else [(0, 1.4), (1.5, .9), (2.5, 1.4)]
    for (bt, d) in hits:
        beat = bar * 4 + bt
        if silent(beat) or beat >= 32: continue
        if bar == 5 and bt > 0: continue          # the plane pops on bar 5 beat 0; then the silence
        for i, n in enumerate(v):
            keys.append(dict(t=b(beat) + 0, inst='vibraphone', pitch=n + 12, dur=min(d, 21 - beat if beat < 21 else d) * BEAT, vel=.34 - .02 * i, pan=-.25 + .12 * i))
    cue(b(bar * 4), f'chord {c["name"]}')
# the end: the held Cmaj9 (vibraphone + string pad), from the slam to the last half-second
END = DUR - .45
for i, n in enumerate(CH[8]['notes']):
    keys.append(dict(t=SLAM, inst='vibraphone', pitch=n + 12, dur=END - SLAM, vel=.4 - .02 * i, pan=-.3 + .15 * i))
for i, n in enumerate([60, 64, 67, 71]):
    keys.append(dict(t=SLAM, inst='violins' if i > 1 else 'violas', pitch=n, dur=END - SLAM - .2, vel=.2, pan=-.3 + .2 * i, attack=.5, release=.4))
cue(SLAM, 'final chord')

# ── marimba theme (whole phrases; the full theme only after the silence) ──
MEL = {   # bar: [(beat in bar, MIDI, length in beats)]
    0: [(1.5, 76, .5), (2, 79, .5), (2.5, 81, 1), (3.5, 79, .5)],
    1: [(0, 74, 1.5), (1.5, 76, .5), (3, 71, .5), (3.5, 74, .5)],          # beat 2 left open for the pop
    2: [(.5, 77, .5), (1, 81, .5), (1.5, 84, 1), (2.75, 81, .25), (3, 79, .5)],
    3: [(.5, 86, .5), (1, 84, .5), (1.5, 81, .5), (2, 79, 1), (3, 77, .5), (3.5, 79, .5)],
    4: [(0, 81, 1.5), (2, 84, 1), (3, 88, 1)],                             # windows run their own 16ths underneath
    6: [(0, 84, .5), (.5, 81, .5), (1, 79, .5), (1.5, 81, .5), (2, 84, .75), (2.75, 86, .25), (3, 88, 1)],
    7: [(0, 86, .5), (.5, 83, .5), (1, 79, .5), (1.5, 76, .5), (3, 74, .5), (3.5, 79, .5)],   # beats 2–2.5 left open for the two taps
}
for bar, ph in MEL.items():
    for (bt, n, d) in ph:
        beat = bar * 4 + bt; vel = .7 if bar >= 6 else .55
        if silent(beat): continue
        E(mar, beat, 'marimba', n, max(.35, d), vel, .12)
        if d >= 1: E(keys, beat, 'vibraphone', n - 12, d, .18, -.1)
E(mar, 20, 'marimba', 88, 1, .62, .12)                                  # the plane's pop, the last note before the silence
cue(b(24), 'theme')

# ── bass: plucked double bass, root on 1 and a lazy push on the "and" of 3; walking 8ths after the launch ──
WALK = {6: [41, 41, 45, 48, 50, 48, 45, 43], 7: [43, 43, 47, 50, 52, 50, 47, 43]}
bass_notes = []
for bar in range(0, 8):
    c = CH[bar]; r = c['root']
    if bar in WALK:
        for k, n in enumerate(WALK[bar]): bass_notes.append((bar * 4 + k * .5, n, .45, .8 if k % 2 == 0 else .62))
    else:
        bass_notes += [(bar * 4, r, 1.6, .82), (bar * 4 + 2.5, r + (7 if bar % 2 else 12), .9, .62)]
bass_notes = [x for x in bass_notes if not silent(x[0]) and x[0] < 30]          # the bass leaves before the taps
bass_notes += [(4, 40, .8, .9)]                                                   # the camera lands on the note (bar 1)
bass_notes += [(32, 36, 4.5, .95)]                                                # the slam: low C under the final chord
for (beat, n, d, v) in bass_notes:
    E(bass, beat, 'jazz_bass', n, d, v * .9, 0)
cue(b(24), 'bass')

# ── drums ──
def kick(v):
    d = .26; tt = t_(d); f = 52 + 78 * np.exp(-tt / .028)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .085)
    x += .25 * np.tanh(3 * x)                                 # a little 2nd/3rd harmonic so it speaks on small speakers
    return (x * v).astype(np.float32)
kicks = []
for beat16 in range(0, 37 * 4):
    beat = beat16 / 4
    if silent(beat) or beat >= 32: continue
    bar, bb = int(beat // 4), beat % 4
    if bar <= 2:   kick_on = bb in (0,) or (bb == 2.75 and bar == 1); clap_on = bb == 2; sh = bar >= 1 and bb % .5 == 0
    elif bar <= 4: kick_on = bb in (0, 2.5); clap_on = bb in (1, 3); sh = bb % .5 == 0
    elif bar == 5: kick_on = bb == 0; clap_on = False; sh = False
    elif bar == 6: kick_on = bb in (0, 1, 2, 3); clap_on = bb in (1, 3); sh = True                      # double time: every 16th shaker
    else:          kick_on = bb in (0, 1) ; clap_on = bb == 1; sh = bb < 2 and True                     # bar 7: thins out before the taps
    if kick_on: kicks.append((b(beat), .5 if bb == 0 else .38))
    if clap_on: E(drums, beat, 'claps', 'solo' if bar < 6 else 'group', None, .42 if bar < 6 else .5, -.15)
    if sh:
        on8 = bb % .5 == 0
        E(drums, beat, 'shaker', 'down' if on8 else 'up', None, (.2 if on8 else .12) * (1.15 if bar == 6 else 1), .35)
    if bar == 6 and bb % .5 == .25: E(drums, beat, 'hihat', 'closed', None, .16, .45)
cue(b(24), 'kick'); cue(SLAM, 'kick')
for d in drums:
    if d['inst'] in ('claps', 'shaker', 'hihat'): d['dur'] = None

# render stems
def R(evs): return S.render(evs, dur=DUR + .5, master=False) if evs else np.zeros((int((DUR + .5) * SR), 2), np.float32)
K, M, B, D = R(keys), R(mar), R(bass), R(drums)
# the physically modelled upright under the sampled bass: more finger, more wood
for (beat, n, d, v) in bass_notes:
    x = P.pluck('upright_bass_pizz', n, d * BEAT, vel=v * .8); add(B, x * .55, b(beat), 1, 0)
KK = np.zeros_like(D)
for (t, v) in kicks: add(KK, kick(v), t, 1, 0)
add(KK, kick(.75), SLAM, 1, 0); add(KK, kick(.7), b(24), 1, 0)

# lo-fi treatment of the pitched stems: slow tape wow (≤ 0.4 ms of drift, 0.12 % pitch) and a gentle low-pass; vibraphone tremolo; kick pump on the keys
n = K.shape[0]; tt = np.arange(n) / SR
def wow(x, a=.0004, f=.55):
    idx = np.arange(len(x)) - a * SR * np.sin(2 * np.pi * f * tt[:len(x)])
    return np.stack([np.interp(idx, np.arange(len(x)), x[:, c]) for c in range(2)], 1).astype(np.float32)
K = wow(K); M = wow(M, .0003, .47)
K *= (1 - .12 * (.5 + .5 * np.sin(2 * np.pi * 5.6 * tt)))[:, None]          # electric-piano tremolo
pump = np.ones(n)
for (t, v) in kicks + [(b(24), .7)]:
    i = int(t * SR); L = int(.3 * SR); e = 1 - .35 * v * np.exp(-np.arange(L) / (.09 * SR)); pump[i:i + L] = np.minimum(pump[i:i + L], e[:max(0, min(L, n - i))])
K *= pump[:, None]
for X in (K, M):
    for c in range(2): X[:, c] = lp(X[:, c], 8000)
for c in range(2): D[:, c] = lp(D[:, c], 12000)

# balance: measured per stem so the low end sits about 3 dB under the mids and the mallets carry the tune
from core.audio.sfx import bp
def bands(x): y = x.mean(1); return [10 * np.log10(np.mean(bp(y, lo, hi) ** 2) + 1e-12) for lo, hi in ((20, 120), (120, 2000), (2000, 8000))]
mus = K * 1.5 + M * 1.5 + B * .6 + D * 4.0 + KK * .3
for nm, X in (('keys', K), ('marimba', M), ('bass', B), ('perc', D), ('kick', KK * .3)): print(nm, [round(v, 1) for v in bands(X)])
print('score bands dB (20-120, 120-2k, 2k-8k):', [round(v, 1) for v in bands(mus)])
mus = S.room(mus, size=.28, mix=.1)
# the silence is a real silence: everything already stopped at beat 21; cut any reverb tail by the creak so the vinyl stands alone
i0, i1 = int((SIL0 + .35) * SR), int(SIL1 * SR); g = np.ones(n); g[i0:i1] = 0; r = int(.3 * SR); g[i0 - r:i0] = np.linspace(1, 0, r)
mus *= g[:, None]
fade = int(.35 * SR); e = int(DUR * SR); mus = mus[:e]; mus[-fade:] *= (np.linspace(1, 0, fade) ** 2)[:, None]
mus *= .5 / max(1e-9, np.abs(mus).max())
os.makedirs(os.path.join(ROOT, 'music'), exist_ok=True)
sf.write(os.path.join(ROOT, 'music/score.wav'), mus, SR, subtype='PCM_24')
har = [{'bar': c['bar'], 't0': c['bar'] * BAR, 'chord': c['name'], 'notes': c['notes'], 'root': c['root']} for c in TL['CHORDS']]
json.dump(har, open(os.path.join(ROOT, 'music/harmony.json'), 'w'))
allnotes = sorted([e['t'] for e in keys + mar + bass + drums] + [t for t, _ in kicks])
json.dump({'cues': cues, 'notes': [round(t, 6) for t in allnotes]}, open(os.path.join(ROOT, 'music/cues.json'), 'w'))
print('score', mus.shape, 'peak', float(np.abs(mus).max()), 'notes', len(allnotes))
print(S.credits(sorted({e['inst'] for e in keys + mar + bass + drums})))
