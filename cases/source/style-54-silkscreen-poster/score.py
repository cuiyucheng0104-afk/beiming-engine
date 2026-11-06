"""score.py — original surf-instrumental cue for 岛屿之光 (120 BPM, E minor).
Reads events.json (exported from timeline.js) so every hit sits on the picture's beat grid.
Instruments: clean electric guitar (FreePats, CC0) through a synthesized spring reverb with tremolo picking and whammy dives,
upright bass pizzicato (Karoryfer Sneakybass, CC0), congas / frame drum / cajon / shaker / tambourine / claps / bass drum (VCSL, CC0),
bongos (FreePats world percussion, CC0), steel-string strum (pluck.py physical model).
Writes out/score.wav and stems out/stem_*.wav.
"""
import json, os, sys
import numpy as np, soundfile as sf
from scipy.signal import fftconvolve
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, lp, hp, bp, limit

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
grid = next(e for e in E['ev'] if e['type'] == 'grid')
Bs = grid['beat']; DUR = E['dur'] + 1.0; N = int(DUR * SR)
bt = lambda b: b * Bs
S.seed(54)
rng = np.random.default_rng(54)
SEC_INTRO, SEC_INK, SEC_CLIMAX, SEC_END = .8, .54, .50, .62

gtr = np.zeros((N, 2)); gtr_dry = np.zeros((N, 2)); bass = np.zeros((N, 2)); perc = np.zeros((N, 2)); strum = np.zeros((N, 2))

CUELOG = []
def addc(buf, x, t, gain=1.0, pan=0.0):
    """place a note so that its measured attack (first sample ≥ 25 % of its peak) lands exactly on t"""
    ax = np.abs(x); lat = int(np.argmax(ax >= .25 * ax.max())) / SR if ax.max() > 0 else 0.0
    add(buf, x, t - lat, gain, pan)
    CUELOG.append({'t': round(t, 6), 'lat_ms': round(lat * 1000, 3), 'placed': round(t - lat, 6), 'onset': round(t - lat + int(np.argmax(ax >= .25 * ax.max())) / SR, 6), 'gain': round(float(gain * ax.max()), 4)})

# ---------- tools ----------
def spring_ir(dur=2.4):
    """Spring tank: a train of dispersive down-chirps (the 'drip'), decaying, plus a diffuse tail."""
    n = int(dur * SR); ir = np.zeros(n); r = np.random.default_rng(3)
    cl = int(.022 * SR); tt = np.arange(cl) / SR
    f = np.geomspace(4200, 260, cl); ph = 2 * np.pi * np.cumsum(f) / SR
    chirp = np.sin(ph) * np.hanning(cl)
    k, t0 = 0, 0.0
    while t0 < dur - .03:
        s = int(t0 * SR); ir[s:s + cl] += chirp * np.exp(-t0 / .62) * (.9 if k % 2 == 0 else -.7)
        t0 += .0285 + r.random() * .004; k += 1
    tail = r.standard_normal(n) * np.exp(-np.arange(n) / SR / .7) * .05
    ir = hp(lp(ir + tail, 5200), 140)
    return ir / np.sqrt((ir ** 2).sum())
IR = spring_ir()
def spring(x, wet=.35):
    out = np.zeros_like(x)
    for c in range(2): out[:, c] = x[:, c] * (1 - wet * .4) + fftconvolve(x[:, c], IR)[:len(x)] * wet * 3.2
    return out
def bend(x, curve):
    """Resample x along a semitone curve (whammy bar). curve: list of (t, semitones)."""
    tt = np.arange(len(x)) / SR; ts, ss_ = zip(*curve)
    rate = 2 ** (np.interp(tt, ts, ss_) / 12); idx = np.cumsum(rate); idx = idx[idx < len(x) - 1]
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)
def g_note(p, t, dur, vel, pan=0, gain=1.0, curve=None, dst=None):
    x = S.note('electric_guitar', p, dur, vel)
    if curve: x = bend(x, curve)
    addc(gtr if dst is None else dst, x, t, gain, pan)
def g_chord(ps, t, dur, vel, pan=0, gain=1.0, strum_=.014, up=False):
    for i, p in enumerate(ps[::-1] if up else ps): g_note(p, t + i * strum_, dur, vel * (1 - .04 * i), pan + (i - len(ps) / 2) * .04, gain)
def trem(p, b0, b1, sub, vel, pan=0, gain=1.0, cresc=0.0):
    """Tremolo picking: repeated short notes on a subdivision of the beat."""
    n = int(round((b1 - b0) / sub))
    for i in range(n):
        k = i / max(1, n - 1); v = vel * (1 + cresc * k) * (.93 if i % 2 else 1)
        g_note(p, bt(b0 + i * sub), sub * Bs * 1.05, min(1, v), pan, gain)
def bnote(p, b, dur_b, vel=.8, gain=1.0):
    addc(bass, S.note('jazz_bass', p, dur_b * Bs, vel), bt(b), gain, -.05)
def hit(inst, var, b, vel, gain=1.0, pan=0.0, dst=None):
    addc(perc if dst is None else dst, S.hit(inst, var, vel), bt(b), gain, pan)

CH = {'Em': ['E3', 'B3', 'E4', 'G4', 'B4'], 'G': ['G3', 'B3', 'D4', 'G4'], 'A': ['A3', 'E4', 'A4', 'C#5'], 'C': ['C4', 'E4', 'G4', 'C5'], 'D': ['D4', 'A4', 'D5', 'F#5'],
      'EmBig': ['E2', 'B2', 'E3', 'G3', 'B3', 'E4'], 'Cmaj7': ['C3', 'G3', 'B3', 'E4'], 'Em9': ['E2', 'B2', 'F#3', 'G3', 'B3']}

# ---------- bar 0: intro (b0–b3) ----------
g_note('E2', bt(0), 2.0, .95, -.1, 1.25, curve=[(0, 0), (.55, 0), (1.3, -2.2), (2.2, -2.6)])     # the opening "drip": low E through the spring, dipping on the bar
g_note('B3', bt(1), .4, .35, .3, .5)
bnote('B1', 3, .5, .7); bnote('D2', 3.5, .5, .7)
hit('conga', 'muted', 3.5, .45, .5, .3)

# ---------- bars 1–3: groove A, one ink one hit (b4–b15) ----------
bass_line = [(4, 'E2', .5, .85), (4.5, 'E2', .5, .55), (5, 'B1', .5, .7), (5.5, 'D2', .5, .7), (6, 'E2', .5, .95), (6.5, 'E2', .5, .55), (7, 'G2', .5, .7), (7.5, 'F#2', .5, .7),
             (8, 'G2', .5, .8), (8.5, 'G2', .5, .55), (9, 'G2', .5, .95), (9.5, 'B2', .5, .7), (10, 'A2', .5, .8), (10.5, 'A2', .5, .55), (11, 'A2', .5, .95), (11.5, 'C2', .5, .75),
             (12, 'C2', .5, .95), (12.5, 'C2', .5, .6), (13, 'D2', .5, .95), (13.5, 'D2', .5, .65)]
for b, p, d, v in bass_line: bnote(p, b, d, v)
for b in (14, 14.5): bnote('B1', b, .5, .7)                                   # 8ths → 16ths of B under the build
for k in range(4): bnote('B1', 15 + k * .25, .25, .72 + .06 * k)
for bar in range(4, 14, 4):
    for off, var, v in [(0, 'muted', .7), (1, 'conga', .6), (1.5, 'conga', .5), (2, 'muted', .6), (3, 'tumba', .65), (3.5, 'tumba', .55)]:
        if bar + off < 14: hit('conga', var, bar + off, v, .8, .25)
    for k in range(8):
        if bar + k * .5 < 14: hit('shaker', 'up' if k % 2 else 'down', bar + k * .5, .5 if k % 2 else .35, .45, -.35)
    for off in (.5, 1.5, 2.5, 3.5):
        if bar + off < 14: hit('world_perc', 'bongo_high', bar + off, .35, .35, .45)
# each ink lands on a chord stab + a frame-drum hit (chords climb Em → G → A → C → D)
for b, ch, gl in [(6, 'Em', 1), (9, 'G', 1), (11, 'A', 1), (12, 'C', .85), (13, 'D', .7)]:     # the last, densest inks are trimmed so they stay under the snap
    g_chord(CH[ch], bt(b), .9, .9, 0, .95 * gl)
    hit('frame_drum', 'large', b, .9, 1.0 * gl, 0)
    hit('conga', 'quinto', b, .7, .6 * gl, .3)
g_note('E5', bt(12.5), 1.2, .55, .4, .7)          # the lamp: a high pinged note half a beat after the red
g_note('B5', bt(12.5) + .02, 1.0, .4, .45, .45)
# acceleration b14–b16: tremolo picking 16ths → 32nds, conga roll, bass-drum crescendo, then a hard stop
trem('B3', 14, 15, .25, .5, -.1, .8, cresc=.4); trem('F#4', 14, 15, .25, .45, .15, .6, cresc=.4)
trem('B3', 15, 16, .125, .62, -.1, .85, cresc=.5); trem('F#4', 15, 16, .125, .6, .15, .7, cresc=.5); trem('A4', 15.5, 16, .125, .6, .2, .55)
for k in range(16): hit('conga', 'conga' if k % 2 else 'quinto', 14 + k * .125, .45 + .4 * k / 15, .75, .25)
for k in range(8): hit('shaker', 'roll' if k > 4 else 'down', 14 + k * .25, .4 + .07 * k, .4, -.35)
add(perc, S.hit('gran_cassa', 'cresc', .8, dur=1.0), bt(15), .9, 0)   # a swell, not a cue

# ---------- b16–b20: near-silence (nothing in the score) ----------

# ---------- bar 5–6: the snap and the split fountain (b20–b27) ----------
g_chord(CH['EmBig'], bt(20), 2.0, 1.0, 0, 1.25, strum_=.009)          # the most important sound (with the clamp in the foley)
g_note('E2', bt(20) + .01, 2.6, .9, 0, .8, curve=[(0, 0), (1.2, 0), (2.0, -3), (2.6, -3.5)])
hit('gran_cassa', 'hit', 20, 1.0, 1.8, 0); hit('cajon', 'bass', 20, 1.0, 1.4, 0); hit('frame_drum', 'large', 20, 1.0, .9, 0); hit('tambourine', None, 20, .9, .5, .3)
addc(bass, S.note('jazz_bass', 'E1', 1.5, 1.0), bt(20), 1.1, 0)
bass_b = [(21, 'E2'), (21.5, 'G2'), (22, 'E2'), (22.5, 'D2'), (23, 'B1'), (23.5, 'D2'),
          (24, 'C2'), (24.5, 'C2'), (25, 'E2'), (25.5, 'G2'), (26, 'D2'), (26.5, 'D2'), (27, 'F#2'), (27.5, 'A2')]
for b, p in bass_b: bnote(p, b, .5, .9 if b % 1 == 0 else .65)
for bar in (20, 24):
    for off, var, v in [(0, 'muted', .8), (1, 'conga', .7), (1.5, 'conga', .55), (2, 'muted', .7), (2.75, 'quinto', .5), (3, 'tumba', .75), (3.5, 'tumba', .6)]:
        if bar + off > 20: hit('conga', var, bar + off, v, .85, .25)
    for off in (1, 3): hit('claps', 'group', bar + off, .7, .55, -.1)
    for k in range(16): hit('tambourine', None, bar + k * .25, .5 if k % 2 == 0 else .3, .3, .35)
    for off in (0, 2): hit('cajon', 'bass', bar + off, .85, .8, 0) if bar + off > 20 else None
    for off in (1, 3): hit('cajon', 'slap', bar + off, .7, .5, -.05)
# steel-string strum on the off-beats (body under the lead)
for b, ch in [(20.5, ['E3', 'B3', 'E4', 'G4']), (21.5, ['E3', 'B3', 'E4', 'G4']), (22.5, ['E3', 'B3', 'E4', 'G4']), (23.5, ['D3', 'A3', 'D4', 'F#4']),
              (24.5, ['C3', 'G3', 'C4', 'E4']), (25.5, ['C3', 'G3', 'C4', 'E4']), (26.5, ['D3', 'A3', 'D4', 'F#4']), (27.5, ['D3', 'A3', 'D4', 'F#4'])]:
    addc(strum, P.strum('acoustic_guitar', ch, .32, .55, spread=.012), bt(b), .5, -.3)
# lead: tremolo-picked melody across the sunset pull (original line)
for p, b0, b1 in [('E4', 20.5, 21.5), ('G4', 21.5, 22), ('B4', 22, 23.5), ('A4', 23.5, 24), ('G4', 24, 25), ('E4', 25, 25.5), ('F#4', 25.5, 26)]:
    trem(p, b0, b1, .25, .62, .2, .85)
# sunset lands b26: D chord + whammy dive of the lead
g_chord(CH['D'], bt(26), 1.2, .95, 0, 1.0); hit('frame_drum', 'large', 26, .9, .9, 0)
g_note('A4', bt(26) + .02, 1.4, .8, .2, .9, curve=[(0, 0), (.3, 0), (1.1, -5), (1.4, -5)])
g_note('E5', bt(26.5), 1.0, .6, .4, .45)                         # the sun (accent, half a beat later)
hit('world_perc', 'bongo_high', 26.5, .6, .35, .4)
hit('cajon', 'slap', 27, .75, .6, 0)                              # the info band

# ---------- bar 7: title and facts, thinner (half-time feel = deceleration) ----------
g_chord(CH['Em'], bt(28), 1.6, .9, 0, 1.0); hit('frame_drum', 'large', 28, .85, .9, 0); bnote('E2', 28, 1.0, .9)
bnote('B1', 30, 1.0, .75); bnote('D2', 31, 1.0, .7)
for b, p in [(29, 'E4'), (29.5, 'G4'), (30, 'B4'), (30.5, 'E5')]:          # one note per printed item, left to right
    g_note(p, bt(b), .6, .6, -.2 + (b - 29) * .25, .75); hit('world_perc', 'bongo_high' if b % 1 else 'bongo_low_high_velocity', b, .6, .6, .3)
for b in (28, 30): hit('conga', 'tumba', b + 1, .5, .55, .25)
for k in range(8): hit('shaker', 'up' if k % 2 else 'down', 28 + k * .5, .3, .3, -.35)

# ---------- bar 8: screen lifts, ending chord with amp tremolo ----------
g_chord(CH['Cmaj7'], bt(32), 2.0, .85, 0, 1.0, strum_=.045); bnote('C2', 32, 2.0, .85); hit('frame_drum', 'large', 32, .8, .8, 0)
end = np.zeros((N, 2))
for i, p in enumerate(CH['Em9']): g_note(p, bt(34) + i * .05, 3.6, .8, (i - 2) * .1, 1.0, dst=end)
tt = np.arange(N) / SR
end *= (1 - .45 * (.5 + .5 * np.sin(2 * np.pi * 6.0 * (tt - bt(34)))) * np.clip((tt - bt(34)) / .6, 0, 1))[:, None]   # surf-amp tremolo
gtr += end
addc(bass, S.note('jazz_bass', 'E1', 3.0, .95), bt(34), 1.1, 0); hit('frame_drum', 'large', 34, .7, .8, 0)

# ---------- effects, balance, stems ----------
gtr = spring(gtr, .38)
gtr = np.stack([hp(gtr[:, c], 90) for c in range(2)], 1)
b2 = np.stack([bass[:, c] + np.tanh(bass[:, c] * 3) * .25 for c in range(2)], 1)          # 2nd/3rd harmonics so the bass speaks on small speakers
bass = np.stack([lp(b2[:, c], 3500) for c in range(2)], 1)
perc = S.room(perc.astype(np.float32), size=.3, mix=.12)
strum = S.room(strum.astype(np.float32), size=.35, mix=.15)
# section levels: everything else sits clearly under the snap (b20), which keeps full level for its first ~0.15 s
# and then settles onto the climax level (a sidechain-like pump), so the snap is the loudest quarter-second of the film
ts = np.arange(N) / SR
sec = np.interp(ts, [0, bt(4) - .01, bt(4), bt(16), bt(20) - .01, bt(20), bt(20) + .15, bt(20) + .45, bt(28), bt(32), DUR],
                    [SEC_INTRO, SEC_INTRO, SEC_INK, SEC_INK, SEC_INK, 1, 1, SEC_CLIMAX, SEC_CLIMAX, SEC_END, SEC_END])
music = (gtr * .5 + bass * .9 + perc * 1.7 + strum * 4.0) * sec[:, None]
# the near-silence: hard stop at b16 (no tails), back at b20 exactly
a, b = int(bt(16) * SR), int(bt(20) * SR) - 8
cut = np.ones(N); cut[a:a + 240] = np.linspace(1, 0, 240); cut[a + 240:b] = 0
for x in (gtr, bass, perc, strum, music): x *= cut[:, None]
music = np.stack([limit(music[:, c], .95) for c in range(2)], 1)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/score.wav'), music.astype(np.float32), SR)
for nm, x in [('guitar', gtr * .5), ('bass', bass * .9), ('perc', perc * 1.7), ('strum', strum * 4.0)]:
    sf.write(os.path.join(HERE, f'out/stem_{nm}.wav'), x.astype(np.float32), SR)
json.dump(CUELOG, open(os.path.join(HERE, 'out/cuelog.json'), 'w'))
print('score', DUR, 's  peak', float(np.abs(music).max()))
