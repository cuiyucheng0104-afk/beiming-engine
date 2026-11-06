#!/usr/bin/env python3
"""《那一脚》 mix: original sampled score (drum kit, electric bass, staccato trumpet/trombone, horns, tuba, timpani, glockenspiel)
+ procedural foley driven by window.EV (events.json) + synthesized crowd → out/mix.wav (48 kHz stereo), out/music_hits.json.
Music rule (STYLE §8): the groove runs while the picture plays; on a freeze the drums stop — one brass stab + timpani + thump + shutter,
then hi-hat only. Before the goal the whole film goes quiet; the first sound after it is the goal chord.
Run: $LIB/.venv/bin/python tools/mix.py"""
import sys, os, json
import numpy as np, soundfile as sf
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, lp, hp, bp, noise, env_exp, t_, thump, whoosh, click, clack, pop, ding, step, roar, heartbeat, norm, limit, brown

E = json.load(open(f'{D}/events.json')); EV = E['ev']; TL = next(e for e in EV if e['type'] == 'timeline')
DUR = TL['dur']; B = TL['beat']; HIT = TL['hits']; SEG = {s['id']: s for s in TL['seg']}
N = int(np.ceil((DUR + .05) * SR))
def b(n): return n * B
def st(n=N): return np.zeros((n, 2), np.float32)
S.seed(69)
HITS = {}            # music accents by name, for the cue check
def mark(name, t): HITS.setdefault(name, []).append(round(t, 5))

# ======================= score =======================
ev = []
def E_(t, inst, p, d, v, pan=0, g=1.0): ev.append((t, inst, p, d, v, pan, g))
DK = 'drum_kit'
def kick(t, v=.9): E_(t, DK, 'kick_drum_left', None, v, 0)
def snare(t, v=.75): E_(t, DK, 'snare_1', None, v, -.05)
def hat(t, v=.4, open_=False): E_(t, DK, 'hi_hat_open' if open_ else 'hi_hat_closed', None, v, .3)
def crash(t, v=.8, side='left'): E_(t, DK, 'crash_' + side, None, v, -.35 if side == 'left' else .35)
def bass(t, p, d, v=.75): E_(t, 'electric_bass', p, d, v, 0)
def brass_stab(t, tr, tb, v=.85, tuba=None):
    for p in tr: E_(t, 'trumpet_stac', p, .28, v, .18)
    for p in tb: E_(t, 'trombone_stac', p, .32, v, -.18)
    if tuba: E_(t, 'tuba_stac', tuba, .35, v * .9, 0)
def timp(t, p='D3', v=.85, d=1.4): E_(t, 'timpani', p, d, v, 0)

DM = (['D5', 'F5', 'A5'], ['D3', 'A3'], 'D2')
BB = (['D5', 'F5', 'Bb5'], ['Bb2', 'F3'], 'Bb1')
CC = (['E5', 'G5', 'C6'], ['C3', 'G3'], 'C2')
AA = (['C#5', 'E5', 'A5'], ['A2', 'E3'], 'A1')

def groove(a, nbeats, g=1.0, busy=False, riff=True):
    """Full groove from beat a for nbeats: kick/snare/16th hats + electric bass riff + brass stabs on the off-beats"""
    prog = [DM, DM, BB, CC]
    for i in range(int(np.ceil(nbeats))):
        t = b(a + i); bt = i % 4; bar = (i // 4) % 4
        if i + .01 > nbeats: break
        if bt in (0, 2): kick(t, .92 * g)
        if busy and bt in (0, 2): kick(t + b(.75), .55 * g)
        if bt == 1 and i % 8 == 5: kick(t + b(.5), .6 * g)
        if bt in (1, 3): snare(t, .78 * g)
        for k in range(4):
            if i + k * .25 >= nbeats: break
            hat(t + b(k * .25), (.5 if k == 0 else .26 if k == 2 else .17) * g)
        ch = prog[bar] if riff else DM
        root = ch[2].replace('1', '2') if ch[2] in ('D2',) else ch[2]
        bp_ = {'D2': ['D2', 'D2', 'D3', 'D2'], 'Bb1': ['Bb1', 'Bb1', 'Bb2', 'Bb1'], 'C2': ['C2', 'C2', 'C3', 'C2'], 'A1': ['A1', 'A1', 'A2', 'A1']}[ch[2]]
        bass(t, bp_[bt], b(.45), .8 * g)
        if bt == 3: bass(t + b(.5), bp_[0], b(.3), .6 * g)
        if riff and bt in (1, 3) and i + .5 < nbeats: brass_stab(t + b(.5), ch[0][:2], ch[1][:1], .55 * g)
def half(a, nbeats, chords, g=1.0):
    """Half-time groove (slow motion): kick on 1, snare on 3, 8th hats, long bass + horn chord per bar"""
    for i in range(int(nbeats)):
        t = b(a + i); bt = i % 4
        if bt == 0: kick(t, .85 * g)
        if bt == 2: snare(t, .6 * g); kick(t + b(1.5), .45 * g)
        hat(t, .32 * g); hat(t + b(.5), .2 * g)
        if bt == 0:
            ch = chords[(i // 4) % len(chords)]
            bass(t, ch[0], b(3.8), .72 * g)
            for p in ch[1]: E_(t, 'horn', p, b(3.9), .42 * g, 0, 1.0)
def freeze_hit(t, chord=DM, v=.9, big=False):
    brass_stab(t, chord[0] + (['D6'] if big else []), chord[1], v, chord[2]); timp(t, 'D3' if chord is not AA else 'A2', .9 * v)
    kick(t, .8 * v); mark('stab', t)
    if big: crash(t, .75 * v)
def hats_only(a, z, v=.24):
    t = b(a)
    while t < b(z) - 1e-6: hat(t, v); t += b(.5)

# 1 · live (beats 0–6.5): full groove, crash on the wipe
crash(0, .85); mark('wipe_in', 0)
groove(0, 6.5, 1.0)
brass_stab(b(1), ['D5', 'A5'], ['D3'], .62); E_(b(1), DK, 'snare_2', None, .7, -.05)   # the first pass gets its own accent
mark('pass1', b(1)); mark('thru_live', b(3))
# 2 · freeze ① (beats 8–16)
freeze_hit(b(8), DM, .95); mark('freeze1', b(8))
hats_only(8.5, 16)
bass(b(8), 'D2', b(3.8), .6); bass(b(12), 'D2', b(3.8), .55)
for tb_, p in [(8.5, 'A6'), (10, 'D7'), (11, 'F6'), (12, 'A6'), (14, 'D7')]: E_(b(tb_), 'glockenspiel', p, .5, .32, .25); mark({8.5: 'ring10', 10: 'arrow1', 11: 'label1', 12: 'ring9', 14: 'arrow2'}[tb_], b(tb_))
for i in range(12): timp(b(14.5) + i * b(.125), 'A2', .18 + .05 * i, .3)
# 3 · slow motion (beats 16–24): half-time, horns, stopwatch beats, snare roll into the strike
half(16, 8, [('D2', ['D3', 'F3', 'A3']), ('A1', ['C#3', 'E3', 'A3'])], .95); mark('resume', b(16))
E_(b(17), 'glockenspiel', 'A6', .4, .3, .2); mark('thru_slow', b(17))
E_(b(22), 'glockenspiel', 'D7', .4, .45, .2); mark('recv9', b(22))
for i in range(16): E_(b(22) + i * b(.125), DK, 'snare_2', None, .18 + .035 * i, 0)
for i in range(8): timp(b(22) + i * b(.25), 'A2', .3 + .07 * i, .35)
# 4 · strike freeze (beat 24): dominant stab, then near-silence
freeze_hit(b(24), AA, 1.0, big=True); mark('strike', b(24))
E_(b(24), 'horn', 'A2', b(1.6), .35, 0)
# 5 · split screen (beats 26–28): the groove restarts, busier
crash(b(26), .7, 'right'); mark('wipe_split', b(26))
groove(26, 2, 1.0, busy=True)
# 6 · split freeze (beats 28–34): stab, hats, a held low A rising, then everything cut on 33.5
freeze_hit(b(28), DM, .95); mark('freezeSplit', b(28))
hats_only(28.5, 33.5, .22)
E_(b(28.5), 'glockenspiel', 'F6', .4, .52, .2); mark('ringsSplit', b(28.5))
E_(b(29.5), 'glockenspiel', 'A6', .4, .34, .2); mark('label2', b(29.5))
for p, v in [('A1', .5), ('A2', .45)]: E_(b(30), 'tuba' if p == 'A1' else 'trombone', p, b(3.45), v, 0)
for i in range(20): timp(b(31) + i * b(.125), 'A2', .2 + .035 * i, .25)
mark('cut_silence', b(33.5))
# 7 · beats 33.5–36: silence (foley only)
# 8 · GOAL (beat 36): the first sound after the silence
G = b(36)
for p in ['D5', 'F#5', 'A5', 'D6']: E_(G, 'trumpet', p, b(1.8), .95, .15)
for p in ['D3', 'A3', 'D4']: E_(G, 'trombone', p, b(1.8), .95, -.15)
for p in ['F#4', 'A4']: E_(G, 'horn', p, b(3.5), .8, 0)
E_(G, 'tuba', 'D2', b(1.8), .9, 0); timp(G, 'D3', 1.0, 2.0); E_(G, 'timpani', 'A2', 1.5, .8, 0)
crash(G, 1.0, 'left'); crash(G + .01, .9, 'right'); kick(G, 1.0); bass(G, 'D2', b(1.8), .9)
for i, p in enumerate(['D6', 'F#6', 'A6', 'D7']): E_(G + i * b(.25), 'glockenspiel', p, 1.2, .6, .25)
mark('goal', G)
# fanfare groove beats 37–40 (D major), tom fill into the hero cut
for i in range(1, 4):
    t = b(36 + i); kick(t, .9); hat(t + b(.5), .3); hat(t + b(.25), .2); hat(t + b(.75), .2)
    if i in (1, 3): snare(t, .8)
for i, (p, d) in enumerate([('A4', .5), ('D5', .5), ('F#5', .5), ('A5', 1.0), ('F#5', .5)]): E_(b(37 + [0, .5, 1, 1.5, 2.5][i]), 'trumpet', p, b(d) * .95, .7, .1)
for i in range(4): E_(b(37.5) + i * b(.125), DK, 'tom_' + str(i + 1), None, .7, .2 - .13 * i)
bass(b(37), 'D2', b(.9), .8); bass(b(38), 'G1', b(1.9), .8)
# hero (beat 38): crash, horns hold G → A, kick on each beat
crash(b(38), .8, 'right'); mark('hero', b(38)); mark('title', b(38))
for p in ['G3', 'B3', 'D4']: E_(b(38), 'horn', p, b(1.9), .6, 0)
for i in range(2): kick(b(38 + i), .85); hat(b(38 + i + .5), .3)
snare(b(39), .8); E_(b(38.5), 'glockenspiel', 'B6', .5, .62, .2); mark('sub', b(38.5))
# 39.5: no roll; cymbals, crowd and horns are pulled out for half a beat so the final tutti lands in a hole (see the gap envelope below)
# final (beat 40): tutti D major + crash, ring out
F_ = b(40)
for p in ['D5', 'F#5', 'A5']: E_(F_, 'trumpet_stac', p, .4, .95, .15)
for p in ['D4', 'F#4', 'A4']: E_(F_, 'horn', p, b(1.6), .7, 0)
for p in ['D3', 'A3']: E_(F_, 'trombone', p, b(1.2), .8, -.15)
E_(F_, 'tuba', 'D2', b(1.4), .8, 0); timp(F_, 'D3', 1.0, 1.2); crash(F_, 1.0, 'left'); kick(F_, 1.0); bass(F_, 'D2', b(1.4), .85)
E_(F_, 'glockenspiel', 'D7', 1.5, .55, .25); mark('final', F_)

music = S.render(ev, dur=N / SR)
music = music[:N] if len(music) >= N else np.vstack([music, st(N - len(music))])
# tape stop on the rewind: the live groove slows to a halt over 0.42 s, then nothing until the freeze stab
ts = b(6.5); i0 = int(ts * SR); L = int(.42 * SR)
tau = np.arange(L) / SR; pos = i0 + (tau - tau ** 2 / (2 * .42)) * SR
x = np.arange(N)
seg_ = np.stack([np.interp(pos, x, music[:, c]) for c in range(2)], 1) * np.linspace(1, 0, L)[:, None] ** 1.5
fr = int(b(8) * SR) - 400
music[i0:fr] = 0; music[i0:i0 + L] = seg_[:min(L, fr - i0)]
# hard cut to silence on 33.5 (a 30 ms fade), and nothing until the goal
a, z = int(b(33.5) * SR), int(G * SR) - 200
music[a:a + 1440] *= np.linspace(1, 0, 1440)[:, None]; music[a + 1440:z] = 0
# strike freeze: the stab rings, then near-silence
a = int((b(24) + .7) * SR); z = int((b(26) - .15) * SR); music[a:a + 4800] *= np.linspace(1, .12, 4800)[:, None]; music[a + 4800:z] *= .12
music = S.room(music, size=.35, mix=.14)
# re-gate the silence after the room so no reverb tail leaks into it (cut on 33.5, nothing until the goal chord)
a, z = int(b(33.5) * SR) + 1440, int(G * SR) - 200; music[a:z] = 0
# half-beat hole before the final tutti: everything held from the hero cut is pulled out on 39.5 (30 ms fade)
a, z = int(b(39.5) * SR), int(F_ * SR) - 96; music[a:a + 1440] *= np.linspace(1, 0, 1440)[:, None]; music[a + 1440:z] = 0

# ======================= crowd =======================
rng = np.random.default_rng(690)
def crowd_bed(d):
    n = int(d * SR)
    out = st(n)
    for c in range(2):
        w = rng.standard_normal(n); w = bp(w, 250, 2600, 2) * .6 + bp(w, 600, 1400, 2) * .5
        m = np.interp(np.arange(n), np.linspace(0, n, 40), rng.uniform(.6, 1.1, 40))
        out[:, c] = w * m
    # scattered shouts
    for k in range(int(d * 2.2)):
        at = rng.uniform(0, d - .5); L_ = rng.uniform(.25, .6); f0 = rng.uniform(500, 1100)
        s_ = bp(rng.standard_normal(int(L_ * SR)), f0, f0 * 1.6, 2) * np.sin(np.pi * np.arange(int(L_ * SR)) / (L_ * SR)) ** 2
        add(out, s_ * .9, at, .5, rng.uniform(-.7, .7))
    return out / np.abs(out).max()
bed = crowd_bed(DUR + .5)[:N]
cg = np.zeros(N)                # crowd gain envelope
lpm = np.zeros(N)               # 1 = low-passed (analysis)
def span(a, z, g, l=0):
    i, j = int(a * SR), int(z * SR); cg[i:j] = g; lpm[i:j] = l
span(0, b(6.5), .42, 0); span(b(6.5), b(8), .25, 1); span(b(8), b(24), .3, 1); span(b(24), b(26), .1, 1)
span(b(26), b(33.5), .3, 1); span(b(33.5), b(36), .0, 1); span(b(36), b(37.6), .5, 0); span(b(37.6), b(37.8), .22, 0); span(b(37.8), b(38), .06, 0); span(b(38), b(39.5), .4, 0); span(b(39.5), b(40), .03, 0); span(b(40), DUR + .05, .45, 0)
k = int(.06 * SR); cg = np.convolve(cg, np.ones(k) / k, 'same'); lpm = np.convolve(lpm, np.ones(k) / k, 'same')
bedlp = np.stack([lp(bed[:, c], 650) for c in range(2)], 1) * 1.6
crowd = (bed * (1 - lpm)[:, None] + bedlp * lpm[:, None]) * cg[:, None]
# rewind: the live crowd reversed and squeezed
rv = bed[int(.2 * SR):int(3.0 * SR)][::-1]; idx = np.linspace(0, len(rv) - 1, int(b(1.5) * SR)); rv = np.stack([np.interp(idx, np.arange(len(rv)), rv[:, c]) for c in range(2)], 1)
add2 = lambda buf, x, at, g: buf.__setitem__(slice(int(at * SR), int(at * SR) + len(x)), buf[int(at * SR):int(at * SR) + len(x)] + x[:max(0, len(buf) - int(at * SR))] * g)
add2(crowd, hp(rv.T, 400).T * np.linspace(.2, .5, len(rv))[:, None], b(6.5), .7)

# ======================= foley (from window.EV) =======================
fx = st(); rbus = st()
def squeak(d):
    n = int(d * SR); tt = np.arange(n) / SR
    x = bp(rng.standard_normal(n), 2200, 5200, 2)
    fl = .55 + .45 * np.sin(2 * np.pi * (34 + 8 * np.sin(2 * np.pi * 3 * tt)) * tt) ** 2
    e = np.minimum(1, tt / .03) * np.minimum(1, (d - tt) / .05)
    return norm(x * fl * e) * .8
def shutter():
    a = click(1.3, 1.0); c = click(1.0, .8); out = np.zeros(int(.12 * SR)); out[:len(a)] += a; s0 = int(.055 * SR); out[s0:s0 + len(c)] += c[:len(out) - s0]; return out
def ballkick(v, rate):
    d = .22; tt = t_(d); f = 95 * (.6 + .4 * rate)
    body = np.sin(2 * np.pi * f * tt * (1 - .4 * tt)) * env_exp(d, .045 / max(rate, .4))
    sl = lp(noise(d), 2500 * rate + 600) * env_exp(d, .008 / max(rate, .4))
    # leather slap: a 3 ms broadband transient so the contact has a hard, audible front edge (attack < 1 ms)
    slap = bp(noise(d), 1200, 6500) * env_exp(d, .003) + hp(noise(d), 700) * env_exp(d, .0018) * .9
    return norm(body + sl * .8 + slap * 1.1) * v
def netswish():
    d = .7; tt = t_(d); x = bp(noise(d), 1500, 7000) * env_exp(d, .18) + bp(noise(d), 300, 900) * env_exp(d, .08) * .6
    rattle = (np.sin(2 * np.pi * 23 * tt) > .6) * bp(noise(d), 2500, 6000) * env_exp(d, .25) * .4
    return norm(x + rattle)
def tapewhine(d):
    n = int(d * SR); tt = np.arange(n) / SR; f = 1900 * np.exp(-tt * 1.6) + 300 * np.sin(2 * np.pi * 7 * tt) + 400
    ph = 2 * np.pi * np.cumsum(f) / SR; x = np.sin(ph) * .5 + np.sin(ph * 2.01) * .2 + bp(rng.standard_normal(n), 900, 4000) * .25
    return norm(x * np.minimum(1, tt / .05) * np.minimum(1, (d - tt) / .08))
def pop2():
    # ring pop with a click front (attack < 1 ms): the sine sweep alone gets masked by the hats and glockenspiel
    p = pop(1.0); c = click(2.2, 1.0); p[:len(c)] += c[:len(p)] * .9
    n = hp(noise(.02), 900) * env_exp(.02, .002); p[:len(n)] += n * .8
    return norm(p)
def flap():
    out = np.zeros(int(.4 * SR))
    for i, at in enumerate([0, .06, .11, .15]): c = clack(1.4 - i * .1, .8 - i * .12); s0 = int(at * SR); out[s0:s0 + len(c)] += c[:len(out) - s0]
    return norm(out)
def swell(d):
    n = int(d * SR); tt = np.arange(n) / SR; return norm(bp(rng.standard_normal(n), 400, 2400) * (tt / d) ** 2) * .6
for e in EV:
    ty, t = e['type'], e['t']
    if ty == 'whoosh': add(fx, whoosh(e['d'] + .1, 1.0), t - .05, .55 * e['v'], .3)
    elif ty == 'kick':
        kg = 1.25 if e['rate'] == 1 and t < b(6.5) else .035 if b(34) - 1e-3 <= t < b(36) else .9   # the strike inside the silence is felt, not heard
        add(fx, ballkick(e['v'], e['rate']) if kg > .2 else lp(ballkick(e['v'], e['rate']), 300), t, kg, e.get('pan', -.1))
    elif ty == 'net': add(fx, netswish(), t, .75, .2)
    elif ty == 'thud': add(fx, thump(1.0, 60), t, .45 * e['v'], .15)
    elif ty == 'rewind': add(fx, tapewhine(e['d']), t, .45, 0); add(fx, clack(.7, 1.0), t, .5, 0); add(fx, click(.8, 1.0), t + .004, .45, 0)   # transport button clunk
    elif ty == 'freeze': add(fx, shutter(), t, .55, 0); add(fx, thump(1, 52), t, .55, 0)
    elif ty == 'pop': add(fx, pop2(), t, .95 * e['v'], .1)
    elif ty == 'squeak': add(fx, squeak(e['d']), t, .32, -.1)
    elif ty == 'tick': add(fx, step(1.0), t, (.4 if t < b(36) else 1.0) * e['v'], .2); (t >= b(36)) and add(fx, click(1.6, 1.0), t, .6 * e['v'], .2)
    elif ty == 'swell': add(fx, swell(e['d']), t - e['d'] * .5, .4, 0)
    elif ty == 'swtick': add(fx, click(1.5, 1.0), t, .3 * e['v'], -.3)
    elif ty == 'swstop': add(fx, ding(1.0)[:int(1.0 * SR)], t, .28, -.3); add(fx, click(1.2, 1.0), t, .4, -.3)
    elif ty == 'slam': add(fx, thump(1.0, 75), t, .5, 0); add(fx, clack(.8, 1.0), t, .3, 0)
    elif ty == 'flip': add(fx, flap(), t + .02, .55, .5); add(fx, whoosh(.3, 1.0), t, .25, .5)
    elif ty == 'roar':
        r = roar(e['d'], 1.0); r = norm(bp(r, 200, 3000) + hp(noise(e['d']), 1500) * .15 * np.minimum(1, t_(e['d']) / .3))
        att = np.minimum(1, t_(e['d']) / .12); add(rbus, r * att, t, .62, -.25); add(rbus, r[::-1][::-1] * att, t + .013, .55, .3)
    elif ty == 'heart': add(fx, lp(heartbeat(1.0), 180), t, .045, 0)   # the silence has to be nearly empty: heartbeat peaks ≤ −24 dBFS after the master
    elif ty == 'cut': add(fx, click(.9, 1.0), t, .45, 0); add(fx, thump(1.0, 68), t, .5, 0)   # hard cut to the hero: a hit you feel
# visual hits that sound through foley (rings, lines, wipes): pair them with the foley event on the same frame
FT = sorted(e['t'] for e in EV if e['type'] not in ('timeline',))
for name, th in HIT.items():
    if name not in HITS:
        near = min(FT, key=lambda x: abs(x - th) if x <= th + 1e-3 else 9e9)
        if abs(near - th) < .03: mark(name, near if abs(near - th) > 1e-3 else th)
# ball flight whoosh in the silence (rides the slow ball, 0.62×)
add(fx, whoosh(b(2) - .05, 1.0) * np.linspace(.2, 1, int(round((b(2) - .05) * SR))) ** 2, b(34) + .02, .07, .4)

# ======================= mix =======================
def rms(x): return np.sqrt(np.mean(x ** 2) + 1e-12)
music *= .2 / rms(music[int(0 * SR):int(b(6.5) * SR)])
# roar: crest on the goal, settles under the hero shot, pulled out on 39.5, back on the final tutti
tt = np.arange(N) / SR
rg = np.interp(tt, [0, b(36), b(37.6), b(37.8), b(37.85), b(38) - .003, b(38) + .002, b(39.5) - .01, b(39.5) + .03, F_ - .002, F_ + .003, DUR + 1], [1, 1, .8, .42, .1, .1, .75, .62, .02, .02, .7, .7])
rbus *= rg[:, None]
# ending: after the last tutti every layer decays (music ≈ −75 dB/s from 0.1 s after the hit, crowd −85 dB/s: −15 dB within 0.35 s, ≤ −40 dBFS by 19.3 s);
# the last 120 ms is a linear fade to digital silence, so the film never ends on a click
def tail_env(start, rate_db):
    g = np.ones(N); i = int(start * SR); g[i:] = 10 ** (-rate_db * (tt[i:] - start) / 20); return g
eM = tail_env(F_ + .1, 75); eC = tail_env(F_ + .02, 85)
music *= eM[:, None]; crowd *= eC[:, None]; rbus *= eC[:, None]; fx *= tail_env(F_ + .12, 70)[:, None]
mix = (music * 1.0 + crowd * .22 + fx * .55 + rbus * .55) * 10 ** (-3.2 / 20)
fo = int(.12 * SR); e_ = int(DUR * SR); mix[e_ - fo:e_] *= np.linspace(1, 0, fo)[:, None]; mix[e_:] = 0
for c in range(2): mix[:, c] = limit(mix[:, c], .92)
os.makedirs(f'{D}/out', exist_ok=True)
sf.write(f'{D}/out/mix_raw.wav', mix.astype(np.float32), SR, subtype='PCM_24')
# bus glue compression (ffmpeg acompressor, RMS detector): evens out the transients so ebur128 and loudnorm agree and the master stays linear
import subprocess
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'{D}/out/mix_raw.wav', '-af', 'acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2,alimiter=limit=0.89:level=false',
                '-c:a', 'pcm_s24le', f'{D}/out/mix.wav'], check=True)
json.dump(HITS, open(f'{D}/out/music_hits.json', 'w'), indent=0)
# band balance report
from scipy.signal import welch
f, P = welch(mix.mean(1), SR, nperseg=8192); lo = P[(f >= 20) & (f < 120)].sum(); mid = P[(f >= 120) & (f < 6000)].sum()
print('mix.wav', round(len(mix) / SR, 3), 's  peak', round(float(np.abs(mix).max()), 3), ' low/rest dB', round(10 * np.log10(lo / mid), 1))
