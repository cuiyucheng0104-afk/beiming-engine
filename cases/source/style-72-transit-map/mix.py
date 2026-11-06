"""《十年》 score + foley -> out/mix.wav (48 kHz stereo, exactly DUR) and out/score_hits.json (for tools/cuecheck.py).
Run with the library's python:  $LIB/.venv/bin/python mix.py   (after node core/render/events.mjs <this folder>)

112.5 BPM, F major: one beat = 0.5333 s = 16 frames at 30 fps, so every 16th note falls on a whole frame.
Palette (STYLE.md §7): glockenspiel / marimba / pizzicato / xylophone, one voice per line, added as the network grows;
a two-note station chime (vibraphone C6 -> F5, glockenspiel an octave up) at the opening, the new home, the closing, the end;
a light electronic pulse synthesised in numpy (kick, hat, clap, bass); a chord on every interchange.
Every musical hit is placed on the beat grid (events snapped to 16ths), never on a free time."""
import sys, os, json, re, subprocess, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
import numpy as np, soundfile as sf, soxr
from core.audio import sampler as S
from core.audio.sfx import SR, add, limit, whoosh, click, clack, pop, thump, noise, bp, hp, lp, t_, norm, brown, compress, crash

S.seed(72); rng = np.random.default_rng(72)
EV = json.load(open(os.path.join(HERE, 'events.json'))); DUR = EV['dur']; ev = EV['ev']; N = int(round(DUR * SR))
BEAT = 60 / 112.5
def B(n): return n * BEAT
def snap(t): return round(t / (BEAT / 4)) * (BEAT / 4)          # to the 16th grid
cue = {e['name']: e['beat'] for e in ev if e['type'] == 'cue'}
HITS = []                                                         # (time, what) for the cue check
def hit(t, what): HITS.append({'t': round(t, 6), 'what': what})

mus, free, used = [], [], set()
def n(t, inst, pitch, dur, vel, pan=0, gain=1.0, bus=None, **kw):
    if t < 0 or t >= DUR: return
    used.add(inst); (free if bus == 'free' else mus).append(dict(t=float(t), inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan, gain=gain, **kw))

CH = {'F': ['F3', 'C4', 'G4', 'A4'], 'Dm': ['D3', 'A3', 'D4', 'F4'], 'Bbmaj7': ['Bb2', 'F3', 'A3', 'D4'], 'Gm9': ['G2', 'F3', 'Bb3', 'A4'],
      'Csus4': ['C3', 'G3', 'C4', 'F4'], 'C': ['C3', 'G3', 'C4', 'E4'], 'Am7': ['A2', 'E3', 'G3', 'C4'], 'Bb': ['Bb2', 'F3', 'Bb3', 'D4'], 'Am': ['A2', 'E3', 'A3', 'C4']}
ROOT = {'F': 'F2', 'Dm': 'D2', 'Bbmaj7': 'Bb1', 'Gm9': 'G1', 'Csus4': 'C2', 'C': 'C2', 'Am7': 'A1', 'Bb': 'Bb1', 'Am': 'A1'}
# harmony: a chord on every interchange (beat -> chord); the silence at B29–B31 holds nothing
HARM = [(0, 'F'), (8, 'Dm'), (11, 'Bbmaj7'), (15, 'Gm9'), (17, 'Csus4'), (19, 'C'), (21, 'Am7'), (22, 'Dm'), (25, 'Bb'), (26, 'C'),
        (27, 'Am'), (28, 'Dm'), (28.5, 'C'), (29, None), (31, 'F'), (33, 'Bb'), (34, 'F'), (37, None)]
def chord_at(b):
    c = None
    for bb, ch in HARM:
        if bb <= b + 1e-9: c = ch
    return c
M = S.midi
def up(p, k=12): return M(p) + k

def chime(b, v=.7, g=.7, bus=None):
    t = B(b); n(t, 'vibraphone_hard', 'C6', 1.4, v, -.1, g, bus); n(t + B(.5), 'vibraphone_hard', 'F5', 2.4, v * .92, .1, g, bus)
    n(t, 'glockenspiel', 'C7', .8, v * .5, -.1, g * .45, bus); n(t + B(.5), 'glockenspiel', 'F6', 1.2, v * .45, .1, g * .45, bus)
    hit(t, 'chime'); hit(t + B(.5), 'chime2')

# ---------------------------------------------------------------- station plucks: one voice per line
VOICE = {'1': ('glockenspiel', ['F5', 'G5', 'A5', 'C6', 'D6', 'F6', 'G6', 'A6']), '2': ('marimba', ['C5', 'D5', 'F5', 'G5', 'A5', 'C6', 'D6', 'F6']),
         '3': ('violins_pizz', ['F4', 'A4', 'C5', 'D5', 'F5', 'G5']), 'R': ('xylophone', ['F5', 'A5', 'C6', 'D6', 'F6', 'G6', 'A6', 'C7'])}
cnt = {}
for e in ev:
    if e['type'] != 'stop': continue
    t = snap(e['t']); ln = e['line']; inst, sc = VOICE[ln]; k = cnt.get(ln, 0); cnt[ln] = k + 1
    if e['id'] == 'BY': continue                                     # the chime opens the map instead
    n(t, inst, sc[k % len(sc)], .9, .62 if ln != 'R' else .5, e['pan'] * .6, .55 if ln != '3' else .7)
    if ln == '1': n(t, 'marimba', sc[k % len(sc)], .4, .35, e['pan'] * .6, .25)
    hit(t, 'stop:' + e['id'])

# ---------------------------------------------------------------- interchange chords
def stab(b, ch, v=.6, g=.6, harp=True, bus=None):
    t = B(b)
    for i, p in enumerate(CH[ch]): n(t, 'vibraphone_hard', up(p), 1.6, v, -.3 + .2 * i, g * .55, bus)
    if harp:
        for i, p in enumerate(CH[ch] + [CH[ch][1]]): n(t + i * .035, 'harp', up(p), 1.8, v * .8, -.4 + .2 * i, g * .5, bus)
    hit(t, 'chord:' + ch)
for e in ev:
    if e['type'] in ('x', 'drop'):
        b = round(snap(e['t']) / BEAT * 4) / 4; ch = chord_at(b)
        if ch: stab(b, ch, .55 if e['type'] == 'x' else .75); hit(B(b), e['type'] + ':' + e['id'])
        if e['type'] == 'x' and e['id'] != 'HL': n(B(b), 'gran_cassa', 'hit', None, .35, 0, .5)

# ---------------------------------------------------------------- grooves (beat loops); each line adds a voice
def arp(b0, b1, inst, step, vel, gain, octv=12, pat=(0, 2, 1, 3, 2, 1, 3, 2), pan=(-.25, .25)):
    b = b0; i = 0
    while b < b1 - 1e-9:
        ch = chord_at(b)
        if ch: n(B(b), inst, up(CH[ch][pat[i % len(pat)]], octv), step * BEAT * 1.6, vel * (1.08 if i % 4 == 0 else 1), pan[i % 2], gain)
        b += step; i += 1
arp(6, 21, 'marimba', .5, .42, .42, 12)                     # blue: marimba in eighths
arp(22, 29, 'marimba', .25, .4, .38, 12)                    # the ring: sixteenths
arp(31, 35, 'marimba', .25, .42, .38, 12)
arp(15.5, 21, 'violins_pizz', 1, .5, .5, 12, pat=(1, 3, 2, 3))   # green: pizzicato off-beats
arp(22.5, 29, 'violins_pizz', 1, .55, .5, 12, pat=(1, 3, 2, 3))
arp(31.5, 35, 'violins_pizz', 1, .55, .5, 12, pat=(1, 3, 2, 3))
arp(22, 29, 'xylophone', .5, .4, .32, 24, pat=(3, 2, 1, 2), pan=(.35, -.35))    # ring voice
arp(31, 35, 'xylophone', .5, .42, .32, 24, pat=(3, 2, 1, 2), pan=(.35, -.35))
for b in (22, 24, 26, 28, 31, 33):                          # harp arpeggios on the ring's harmony
    ch = chord_at(b)
    for i, p in enumerate(CH[ch]): n(B(b) + i * B(.25), 'harp', up(p, 12), 1.4, .45, -.3 + .2 * i, .35)
# synth pulse (numpy): kick, hat, clap, bass
def kick(v=1.0):
    d = .28; tt = t_(d); f = 56 + 100 * np.exp(-tt * 30); ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-tt * 9) + .3 * lp(noise(d), 1200) * np.exp(-tt * 70)) * v
def hat(v=1.0, d=.05): x = hp(noise(d), 7000, 4) * np.exp(-t_(d) * 70); return norm(x) * v
def clap(v=1.0):
    d = .18; x = bp(noise(d), 900, 2600); e = np.zeros_like(x)
    for o in (0, .011, .022): i = int(o * SR); e[i:] += np.exp(-t_(d - o) * 32)[:len(e) - i]
    return norm(x * e) * v
def bass(p, d, v=1.0):
    f = S.hz(p); tt = t_(d); ph = 2 * np.pi * f * tt
    x = np.sin(ph) + .45 * np.sin(2 * ph) + .22 * np.sin(3 * ph)
    return lp(x, 900) * np.minimum(1, tt / .006) * np.exp(-tt * 3.2) * np.minimum(1, (d - tt) / .03) * v
pulse = np.zeros((N, 2), np.float32)
def groove(b0, b1, kd=1, hats=2, claps=False, bass_step=.5, g=1.0):
    b = b0
    while b < b1 - 1e-9:
        t = B(b)
        if abs(b - round(b)) < 1e-9:
            add(pulse, kick(.9), t, .3 * g)
            if claps and int(round(b)) % 2 == 1: add(pulse, clap(1), t, .1 * g, .1)
        for k, o in enumerate([.5] if hats == 1 else [.25, .5, .75]):
            add(pulse, hat(1), B(b + o), (.045 if o == .5 else .028) * g, .35 if k % 2 else -.3)
        b += 1
    b = b0
    while b < b1 - 1e-9:
        ch = chord_at(b)
        if ch: add(pulse, bass(up(ROOT[ch]), bass_step * BEAT * .9, 1), B(b), .2 * g)
        b += bass_step
groove(4, 8, hats=1, bass_step=1, g=.8)
groove(8, 17, hats=1, bass_step=.5)
groove(17, 21, hats=1, bass_step=.5, g=.8)                  # under the river (low-passed below)
groove(22, 29, hats=2, claps=True, bass_step=.5, g=1.05)    # the ring: the fullest
groove(31, 35, hats=2, claps=True, bass_step=.5, g=1.0)
# a snare roll pulls into the cut to silence
n(B(27), 'snare', 'roll', B(2), .5, 0, .35)

# ---------------------------------------------------------------- the story's sound marks
chime(0, .72)
hit(0, 'open')
stab(11, 'Bbmaj7', .85, .8); n(B(11), 'bass_drum', None, None, .7, 0, .9); n(B(11), 'horn', 'F3', B(3), .5, -.2, .45, attack=.05); n(B(11), 'horn', 'D4', B(3), .45, .2, .4, attack=.05)
chime(21, .6, .6)                                             # 新家: the chime returns, the music breathes
n(B(21), 'vibraphone_bowed', 'E5', B(1.2), .4, -.2, .4, attack=.15); n(B(21), 'vibraphone_bowed', 'C5', B(1.2), .38, .2, .4, attack=.15)
# B29–B31: near-silence. Only a bowed vibraphone, very soft, and the two pens.
n(B(29), 'vibraphone_bowed', 'C6', B(2.1), .22, -.15, .22, bus='free', attack=.3, release=.4)
n(B(29), 'vibraphone_bowed', 'F5', B(2.1), .18, .15, .18, bus='free', attack=.5, release=.4)
hit(B(29), 'silence')
# B31: the ring closes. The most important sound of the film.
L = B(31)
n(L, 'bass_drum', None, None, 1.0, 0, 1.1, bus='free'); n(L, 'gran_cassa', 'hit', None, .9, 0, .8, bus='free')
n(L, 'timpani', 'F2', 2.0, .8, 0, .7, bus='free')
for i, p in enumerate(['F3', 'A3', 'C4', 'F4']): n(L, 'horn', p, B(4), .62, -.3 + .2 * i, .5, bus='free', attack=.04, release=1.2)
for i, p in enumerate(['F2', 'C3', 'F3', 'A3', 'C4', 'F4', 'A4', 'C5', 'F5']): n(L + i * .028, 'harp', p, 3.0, .7, -.5 + .12 * i, .6, bus='free')
n(L, 'tubular_bells', 'F4', 4.0, .6, .1, .5, bus='free')
for i, p in enumerate(['F4', 'A4', 'C5', 'F5']): n(L, 'vibraphone_hard', p, 2.5, .7, -.3 + .2 * i, .5, bus='free')
n(L, 'sus_cymbal', 'hit', None, .45, .2, .35, bus='free')
chime(31, .75, .75, bus='free')
hit(L, 'land')
# B32–B36: the red dot pulses once a beat; a soft ping each time
for b in range(32, 37): n(B(b), 'hand_chimes', 'C7' if b % 2 == 0 else 'F6', .6, .3, .25, .22, bus='free'); hit(B(b), 'pulse')
# B35: the ensemble lifts away; pad and the chime close the film
for i, p in enumerate(['F4', 'A4', 'C5']): n(B(34.5), 'vibraphone_bowed', p, B(2.6), .35, -.2 + .2 * i, .35, bus='free', attack=.4, release=.8)
chime(35, .62, .65, bus='free')

music = S.render(mus, dur=DUR + 3, master=False)[:N] + pulse
fr = S.render(free, dur=DUR + 3, master=False)[:N]
# under the river: low-pass the main bus from B17 to B19 (block-wise, smooth cutoff)
def sweep_lp(x, a, b, lo=480):
    out = x.copy(); i0, i1 = int((a - .2) * SR), int((b + .3) * SR); blk = 1200
    for i in range(max(0, i0), min(len(x), i1), blk):
        tt = i / SR; d = min(1, max(0, (tt - (a - .2)) / .3)) * min(1, max(0, ((b + .3) - tt) / .3))
        fc = np.exp(np.log(14000) * (1 - d) + np.log(lo) * d)
        seg_ = x[max(0, i - 4000):i + blk]; y = np.stack([lp(seg_[:, c], fc, 2) for c in range(2)], 1)[-(min(blk, len(x) - i)):]
        out[i:i + len(y)] = y
    return out
music = sweep_lp(music, B(17), B(19))
# the breath at B21–B22 thins the groove; B29–B31 is near-silence (the main bus falls away inside 40 ms)
g = np.ones(N, np.float32)
def dip(a, b, lvl, fi=.04, fo=.02):
    ia, ib = int(a * SR), int(b * SR); g[ia:ib] = np.minimum(g[ia:ib], lvl)
    k = int(fi * SR); g[max(0, ia - k):ia] = np.minimum(g[max(0, ia - k):ia], np.linspace(1, lvl, min(k, ia)))
    k = int(fo * SR); g[ib:ib + k] = np.minimum(g[ib:ib + k], np.linspace(lvl, 1, k))
dip(B(29), B(31), .0, fi=.035, fo=.005)
music = S.room(music * g[:, None], size=.35, mix=.14)
fr = S.room(fr, size=.45, mix=.18)

# ---------------------------------------------------------------- foley, from window.EV
fx = np.zeros((N, 2), np.float32)
def pen_sound(e):     # felt-tip glide: band noise whose level follows the tip speed; pan follows the tip on screen
    d = e['t1'] - e['t'] + .08; m = int(d * SR); x = lp(hp(noise(d), 1300), 4200)[:m]
    tt = np.arange(m) / SR; sp = np.interp(tt, np.arange(len(e['sp'])) * .02, e['sp']); pa = np.interp(tt, np.arange(len(e['pan'])) * .02, e['pan'])
    a = np.clip(sp / 3.0, 0, 1.3) ** .7 * (1 + .2 * np.sin(2 * np.pi * 9 * tt)); a *= np.minimum(1, tt / .03) * np.minimum(1, (d - tt) / .08)
    y = x * a; i0 = int(e['t'] * SR); i1 = min(N, i0 + m)
    gl, gr = np.sqrt(.5 * (1 - pa)), np.sqrt(.5 * (1 + pa))
    sil = ((np.arange(i0, i1) / SR > B(29)) & (np.arange(i0, i1) / SR < B(31))) * 2.6 + 1   # louder in the silence
    fx[i0:i1, 0] += (y * gl)[:i1 - i0] * .03 * sil; fx[i0:i1, 1] += (y * gr)[:i1 - i0] * .03 * sil
def falling(d):       # a capsule falling: a descending whistle + air
    tt = t_(d); f = 2000 * np.exp(-tt * 3.4) + 200; ph = 2 * np.pi * np.cumsum(f) / SR
    return norm(np.sin(ph) * .25 * (tt / d) + lp(noise(d), 900) * (tt / d) ** 2)
def shimmer(d=1.0):  # the shock rings: a soft bright spread
    tt = t_(d); return norm(bp(noise(d), 3000, 9000) * np.exp(-tt * 3.5) * np.minimum(1, tt / .02))
def sub(f=48, d=.7):
    tt = t_(d); return np.sin(2 * np.pi * f * tt * (1 + .4 * np.exp(-tt * 12))) * np.exp(-tt * 4.5) * np.minimum(1, tt / .004)
room = lp(brown(DUR + .1), 260); room = norm(room)[:N]; add(fx, room, 0, .012)
first_depart = set()
for e in ev:
    t, ty, pan = e['t'], e['type'], e.get('pan', 0)
    if ty == 'pen': pen_sound(e)
    elif ty == 'stop' and e.get('vis'): add(fx, click(1.15 + .35 * ((sum(map(ord, e['id'])) % 7) / 7), 1), t, .07, pan); add(fx, pop(.6), t, .03, pan)
    elif ty == 'minor' and e.get('vis'): add(fx, click(1.9, .6), t, .022, pan)
    elif ty == 'x': add(fx, pop(1), t, .09, pan); add(fx, thump(1, 95), t, .14, pan)
    elif ty == 'fall': add(fx, falling(.42), t, .3 if e['id'] == 'XY' else .38, .05)
    elif ty == 'drop':
        big = e['id'] == 'XJ'
        add(fx, thump(1, 56), t, .7 if big else .55, 0); add(fx, pop(1), t, .25, 0); add(fx, sub(44 if big else 52, .9 if big else .6), t, .55 if big else .35, 0)
        add(fx, shimmer(1.1 if big else .9), t + .02, .1 if big else .07, .1); add(fx, crash(.6), t, .1 if big else .06, .15)
    elif ty == 'depart' and e['line'] not in first_depart:
        first_depart.add(e['line']); add(fx, click(1.6, 1), t + .05, .06, pan); add(fx, pop(.5), t + .1, .04, pan)   # the line bullet springs in
    elif ty == 'spin':      # the year drum: a ratchet tick each time a figure passes, a clack when it lands
        a, b = e['t'], e['t1']; d0 = e['y0'] % 10; d1 = e['y1'] % 10; Nn = (d1 - d0) % 10 + 10 * e['k']
        uu = np.linspace(0, 1, 4001); E = uu ** 3 * (uu * (uu * 6 - 15) + 10)
        for k in range(1, Nn): add(fx, click(2.4, .55), a + (b - a) * float(np.interp(k / Nn, E, uu)), .028, -.75)
        add(fx, clack(1.2, 1), snap(b), .09, -.75); hit(snap(b), 'year:' + str(e['y1']))
    elif ty == 'cut' and e['kind'] == 'glide': add(fx, whoosh(.8), t - .05, .14, .2)
    elif ty == 'cut' and e['kind'] == 'rise': add(fx, whoosh(1.4), t + .15, .18, 0)
# the camera drops low, the line dives: plunge, bubbles, surfacing
add(fx, whoosh(.55), B(16.3), .16, -.2)
plunge = lp(noise(.5), 500) * np.exp(-t_(.5) * 6); add(fx, norm(plunge), B(cue['dive']), .22, 0); hit(B(cue['dive']), 'dive')
for k in range(26):
    tb = B(17) + .05 + k * (B(2) - .1) / 26 + rng.uniform(-.02, .02); d = .05; tt = t_(d); f = rng.uniform(380, 900) * (1 + 2.2 * tt / d)
    add(fx, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d), tb, .02, rng.uniform(-.5, .5))
wat = lp(noise(B(2)), 320) * np.sin(np.linspace(0, np.pi, int(B(2) * SR))); add(fx, norm(wat), B(17), .09, 0)
add(fx, pop(1), B(cue['surface']), .16, .25); add(fx, norm(hp(noise(.25), 2500) * np.exp(-t_(.25) * 14)), B(cue['surface']), .05, .2); hit(B(cue['surface']), 'surface')
# rail clacks on finished track (ta-tak pairs on the beat) and the ring's two bridge crossings
for b in np.arange(8, 37, 1):
    if 29 <= b < 31: continue
    v = .018 if b < 22 else .026
    if b % 2 == 0 or b >= 22: add(fx, clack(1.0 + .1 * (b % 3), .7), B(b), v, [-.6, .5, -.2, .7][int(b) % 4]); add(fx, clack(1.1, .6), B(b) + B(.25), v * .8, [-.6, .5, -.2, .7][int(b) % 4])
for nm, pn in (('bridgeN', .3), ('bridgeS', -.2)):
    for k in range(4): add(fx, clack(.9 + .1 * k, 1), B(cue[nm] + k * .125), .07, pn)
    hit(B(cue[nm]), nm)
# the paper veil comes down and lifts; the red dot pulses
for nm in ('veilOn', 'veilOff'): add(fx, norm(bp(noise(.7), 1500, 6000) * np.sin(np.linspace(0, np.pi, int(.7 * SR)))), B(cue[nm]) - .1, .05, 0)
for b in range(32, 37): tt = t_(.25); add(fx, np.sin(2 * np.pi * 2093 * tt) * np.exp(-tt * 18), B(b), .03, .25)
add(fx, whoosh(.5), B(22) - .02, .07, 0)                     # the hard cut into the wide

# ---------------------------------------------------------------- mix and loudness (about -16 LUFS before the master's -14)
mix = music * .8 + fr * .95 + fx
mix = np.stack([hp(mix[:, c], 38, 4) for c in range(2)], 1)
mix = mix - .5 * np.stack([lp(mix[:, c], 95, 2) for c in range(2)], 1)   # about -6 dB shelf under 95 Hz
fade = np.ones(N, np.float32); f0 = N - int(.6 * SR); fade[f0:] = np.linspace(1, 0, N - f0) ** 1.5; mix *= fade[:, None]
mix = np.stack([compress(mix[:, c], thr=.18, ratio=2.6, att=.006, rel=.16) for c in range(2)], 1)
def lufs_tp(x):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f: tmp = f.name
    sf.write(tmp, x.astype(np.float32), SR, subtype='FLOAT')
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    os.remove(tmp)
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1]), float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', out)[-1])
ceil = 10 ** (-3.4 / 20)
for _ in range(8):
    I, P = lufs_tp(mix); mix *= 10 ** ((-16.0 - I) / 20)
    for c in range(2): mix[:, c] = limit(mix[:, c], ceil * .8)
    tp = np.abs(soxr.resample(mix, SR, SR * 4)).max()
    if tp > ceil: mix *= ceil / tp
I, P = lufs_tp(mix)
# band balance: energy below 50 Hz against the full band
spec = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fq = np.fft.rfftfreq(N, 1 / SR)
lo_db = 10 * np.log10(spec[fq < 50].sum() / spec.sum()); lo120 = 10 * np.log10(spec[(fq >= 20) & (fq < 120)].sum() / spec.sum())
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
json.dump(sorted(HITS, key=lambda h: h['t']), open(os.path.join(HERE, 'out', 'score_hits.json'), 'w'), ensure_ascii=False, indent=0)
# near-silence check: level of B29–B31 against the bar before it
def rms(a, b): x = mix[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
print(f'mix: {I:.1f} LUFS, true peak {P:.1f} dBTP, <50 Hz {lo_db:.1f} dB, 20-120 Hz {lo120:.1f} dB of total')
print(f'silence B29-B31 {rms(B(29.1), B(30.2)):.1f} dBFS rms vs ring B27-B29 {rms(B(27), B(29)):.1f} dBFS; landing beat {rms(B(31), B(32)):.1f} dBFS')
print('instruments:', ', '.join(sorted(used)))
open(os.path.join(HERE, 'out', 'instruments.txt'), 'w').write('\n'.join(S.credits(sorted(used))) + '\n')
