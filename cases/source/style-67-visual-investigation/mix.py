#!/usr/bin/env python3
"""大桥的五十九分钟 · score + foley → out/mix.wav (48 kHz stereo).
Every time comes from timeline.json (exported from timeline.js) and events.json (window.EV): 90 BPM, beats → seconds by TL.
Score: core/audio/sampler (VSCO 2 CE / VCSL, CC0) + core/audio/pluck (Karplus–Strong bass) + numpy synthesis (low pulse, metal tear).
Foley: procedural, one sound per visible action, placed from the event list."""
import json, os, sys
import numpy as np, soundfile as sf
D = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import pluck as P
from core.audio.sfx import SR, add, bp, hp, lp, noise, env_exp, t_, whoosh, thump, norm, limit, brown, creak

TL = json.load(open(os.path.join(D, 'timeline.json')))
EVS = json.load(open(os.path.join(D, 'events.json')))['ev']
SPB, DUR = TL['spb'], TL['dur']
def T(b): return round(b * SPB * 30) / 30          # same snap as timeline.js
N = int(round(DUR * SR)); mus = np.zeros((N, 2), np.float32); fx = np.zeros((N, 2), np.float32); hitbus = np.zeros((N, 2), np.float32)
S.seed(67); rng = np.random.default_rng(67)
ev = []
def E(b, inst, pitch, beats, vel, pan=0, gain=1.0): ev.append((T(b), inst, pitch, beats * SPB, vel, pan, gain))

# ═════ score ═════
# S1 cold open (b0–5): low D hit, a thin minor-second cluster, reverse cymbal swell into the cut
E(0, 'gran_cassa', 'hit', 3, .9, 0, .9); E(0, 'timpani', 'D2', 3, .85, 0, .8)
E(0, 'contrabass', 'D2', 2.5, .7, -.15, .55); E(0, 'cellos', 'D3', 1.0, .7, .15, .45)
E(0.25, 'violins_trem', 'D5', 2.75, .22, -.35, .14); E(0.25, 'violins_trem', 'Eb5', 2.75, .22, .35, .14)
# S2 sync grid (b5–12): drone, pizzicato ostinato in eighths (Dm – B♭ – Gm – A), plucked bass roots
E(5, 'timpani', 'D2', 2, .7, 0, .6)
E(5, 'contrabass', 'D2', 7, .5, -.2, .45); E(5, 'cellos', 'A2', 7, .45, .2, .35)
CH = [(5, ['D4', 'F4', 'A4', 'F4'], 'D2'), (7, ['D4', 'F4', 'Bb4', 'F4'], 'Bb1'), (9, ['D4', 'G4', 'Bb4', 'G4'], 'G1'), (11, ['C#4', 'E4', 'A4', 'E4'], 'A1')]
for i, (b0, pat, root) in enumerate(CH):
    b1 = CH[i + 1][0] if i + 1 < len(CH) else 12
    k = 0; b = b0
    while b < b1 - 1e-6:
        E(b, 'violas_pizz', pat[k % 4], .5, .45 + .12 * (k % 4 == 0), .25, .5)
        if k % 2 == 0: E(b, 'cellos_pizz', pat[0][:-1] + '3', .5, .4, -.25, .35)
        k += 1; b += .5
E(7.5, 'violins_trem', 'E5', 4.5, .22, .35, .16); E(7.5, 'violins_trem', 'F5', 4.5, .25, -.35, .16)
# S3 freeze, circle, magnify (b12–18): breath, then the metal, then acceleration
E(12, 'timpani', 'D2', 2, .6, 0, .5); E(12, 'contrabass', 'D2', 6, .45, -.2, .42); E(12, 'cellos', 'A2', 6, .4, .2, .3)
E(13.5, 'vibraphone_bowed', 'D5', 4.5, .5, -.3, .35); E(13.5, 'vibraphone_bowed', 'Eb5', 4.5, .5, .3, .3)
E(13.5, 'sus_cymbal', 'bow', 4.5, .6, .2, .35)
E(15, 'violins_trem', 'D5', 3, .3, -.35, .2); E(15, 'violins_trem', 'Eb5', 3, .3, .35, .2); E(16, 'violas', 'A4', 2, .35, 0, .22)
for i in range(8): E(16 + i * .25, 'cellos_spic', 'D3', .25, .35 + .06 * i, -.1, .4)
# S4 hard sync (b18): one pluck, then nothing
E(18, 'cellos_pizz', 'D3', 1, .8, 0, .55)
# S5 break and verdict (b20–29)
E(20, 'gran_cassa', 'hit', 4, 1.0, 0, 1.0); E(20, 'timpani', 'D2', 4, 1.0, 0, .9); E(20, 'sus_cymbal', 'scrape', 3, .7, -.2, .45)
E(20, 'contrabass', 'D2', 2, .65, -.2, .5); E(20, 'cellos', 'D3', 2, .55, .15, .38); E(20, 'violas', 'F3', 2, .45, -.1, .28)
E(22, 'contrabass', 'Bb1', 2, .5, -.2, .45); E(22, 'cellos', 'F3', 2, .45, .15, .32); E(22, 'violas', 'D4', 2, .4, -.1, .25)
E(24, 'contrabass', 'G1', 1, .5, -.2, .45); E(24, 'cellos', 'D3', 1, .45, .15, .32); E(24, 'violas', 'Bb3', 1, .4, -.1, .25)
E(25, 'contrabass', 'A1', 1, .5, -.2, .45); E(25, 'cellos', 'E3', 1, .45, .15, .32); E(25, 'violas', 'C#4', 1, .4, -.1, .25)
# b26 D minor add9: low strings + vibraphone arpeggio on quarter-beats; b28 badge
for p, inst, pan in [('D2', 'contrabass', 0), ('A2', 'cellos', -.2), ('D3', 'cellos', .2), ('F3', 'violas', -.3), ('E4', 'violas', .3)]: E(26, inst, p, 3, .4, pan, .36)
for i, p in enumerate(['D4', 'A4', 'E5', 'F5', 'A5']): E(26 + .25 * i, 'vibraphone', p, 3, .45, -.3 + .15 * i, .38)
E(28, 'glockenspiel', 'D6', 1, .5, .2, .38); E(28.25, 'glockenspiel', 'A6', 1, .45, .3, .3)
# everything that sustains through S3 is choked at the sync cut (b18), so the single hard tick stands alone
s3 = [e for e in ev if T(12) <= e[0] < T(18)]; rest = [e for e in ev if not (T(12) <= e[0] < T(18))]
mus += S.render(rest, dur=DUR, master=False)[:N]
y3 = S.room(S.render(s3, dur=DUR, master=False)[:N], size=.45, mix=.18); c0 = int(T(18) * SR); y3[c0 - 240:c0] *= np.linspace(1, 0, 240)[:, None]; y3[c0:] = 0

# plucked upright bass (Karplus–Strong): roots on the grid
def pl(b, p, beats, vel, pan=0, g=1.0):
    y = P.pluck('upright_bass_pizz', p, beats * SPB, vel); add(mus, y * g, T(b), 1.0, pan)
pl(0, 'D2', 2, .9, 0, .9)
for b0, _, root in CH: pl(b0, root, 2, .75, -.1, .8)
pl(18, 'D2', .7, .95, 0, 1.0)
pl(20, 'D1', 3, 1.0, 0, 1.1)

# numpy low pulse: D2 with 2nd/3rd harmonics (speaks on small speakers), short pitch drop
def pulse(v=1.0, f=73.42, d=.32):
    tt = t_(d); ph = 2 * np.pi * f * tt * (1 - .06 * tt)
    return (np.sin(ph) + .5 * np.sin(2 * ph) + .28 * np.sin(3 * ph)) * env_exp(d, .09) * (1 - np.exp(-tt / .003)) * v
PG = .68   # S2/S3 pulse bed sits ≈ 3.3 dB lower than v1, so the single b20 break is the loudest and lowest moment of the film
for b in range(5, 12): add(mus, pulse(.75 if b == 5 else .7), T(b), .5 * PG, 0)
for b in (12, 14): add(mus, pulse(.6), T(b), .45 * PG, 0)
for b in (15, 16): add(mus, pulse(.7), T(b), .5 * PG, 0)
for i in range(2): add(mus, pulse(.7), T(16.5 + i * .5), .5 * PG, 0)    # eighths
for i in range(4): add(mus, pulse(.75, d=.16), T(17 + i * .25), .5 * PG, 0)   # sixteenths

mus = S.room(mus, size=.45, mix=.18)
# reverse cymbal swell: the rewind is sucked into the cut at b5
rc = S.hit('sus_cymbal', 'hit', .8)[::-1]; L = int(2 * SPB * SR); rc = rc[-L:] if len(rc) >= L else np.pad(rc, (L - len(rc), 0))
add(mus, rc * np.linspace(.2, 1, len(rc)) ** 2, T(5) - len(rc) / SR, .5, 0)
# the S3 pulses and spiccato also stop dead at the cut
mus[c0 - 240:c0] *= np.linspace(1, .5, 240)[:, None]
mus += y3

# ═════ foley (procedural) ═════
def tick(v=1.0, f=2400):
    d = .03; tt = t_(d); return (hp(noise(d), 1800) * env_exp(d, .003) + np.sin(2 * np.pi * f * tt) * env_exp(d, .004) * .6) * v
def wood(v=1.0, var='a'): return S.hit('woodblock', var, v)
def paper(v=1.0):
    d = .25; return bp(noise(d), 1200, 6000) * env_exp(d, .05) * (1 - np.exp(-t_(d) / .01)) * v
def shutter(v=1.0):
    d = .09; a = hp(noise(d), 2000) * env_exp(d, .006); b = np.pad(hp(noise(.05), 1500) * env_exp(.05, .005), (int(.045 * SR), 0))[:len(a)]
    return norm(a + b * .8) * v
def morse(seq='.-.', f=820, v=1.0):
    out = []
    for c in seq:
        d = .05 if c == '.' else .14; tt = t_(d); s = np.sin(2 * np.pi * f * tt); s[:96] *= np.linspace(0, 1, 96); s[-96:] *= np.linspace(1, 0, 96); out += [s, np.zeros(int(.05 * SR))]
    return np.concatenate(out) * .5 * v
def typekey(v=1.0):
    d = .035; return norm(bp(noise(d), 900, 5000) * env_exp(d, .004) + np.sin(2 * np.pi * 180 * t_(d)) * env_exp(d, .008) * .4) * v
def pencil(d=.5, v=1.0):   # red circle drawn: graphite scratch following the stroke speed (ease-out)
    tt = t_(d); spd = 3 * (1 - tt / d) ** 2; grain = bp(noise(d), 2500, 8000) * (.6 + .4 * np.sign(np.sin(2 * np.pi * 37 * tt)))
    return norm(grain * (spd + .15) * np.sin(np.pi * np.minimum(tt / .03, 1) / 2)) * v
def rewind(d=1.33, v=1.0):  # tape rewind: falling whine + band noise, swelling into the cut
    tt = t_(d); f = 2600 * np.exp(-tt * 1.4) + 260; ph = 2 * np.pi * np.cumsum(f) / SR
    return (bp(noise(d), 500, 4000) * .45 + np.sin(ph) * .3 + np.sin(ph * 2.01) * .14) * np.sin(np.pi * tt / d) ** .5 * v
def tear(d=2.2, v=1.0):     # metal tearing: inharmonic partials gliding down with beating, under a resonant noise sweep
    tt = t_(d); out = np.zeros_like(tt)
    for f, a in [(310, 1), (467, .7), (689, .5), (1013, .35), (1520, .2)]:
        fg = f * (1 - .35 * tt / d) * (1 + .012 * np.sin(2 * np.pi * 5.5 * tt)); out += a * np.sin(2 * np.pi * np.cumsum(fg) / SR)
    sw = np.zeros_like(tt); nz = noise(d)
    for i in range(0, len(tt), 960):
        hi = min(len(tt), i + 960); fc = 2200 * np.exp(-1.2 * i / SR) + 300; sw[i:hi] = bp(nz[max(0, i - 3000):hi], fc * .85, fc * 1.15)[-(hi - i):]
    env = (1 - np.exp(-tt / .02)) * np.exp(-tt / .9)
    return norm((out * .6 + sw * 2.2) * env) * v

rt = lp(brown(DUR), 380)[:N] * .010; fx[:len(rt)] += np.stack([rt, np.roll(rt, 700)], 1)            # room tone, the whole film
wind = bp(noise(T(12) - T(5)), 90, 600) * (.6 + .4 * np.sin(2 * np.pi * .35 * t_(T(12) - T(5))))
w0 = int(T(5) * SR); fx[w0:w0 + len(wind)] += np.stack([wind, np.roll(wind, 900)], 1) * .02              # low wind under the sync grid

for e in EVS:
    t, ty = e['t'], e['type']
    if ty == 'freeze': add(fx, shutter(1), t, .6, -.1); add(fx, thump(.5, 90), t, .25)
    elif ty == 'shutter': add(fx, shutter(.9), t, .45, .25)
    elif ty == 'paper': add(fx, paper(1), t, .45, .2)
    elif ty == 'tick': add(fx, tick(1), t, .35, 0)
    elif ty == 'pencil': add(fx, pencil(e.get('d', .5)), t, .28, -.15)
    elif ty == 'key': add(fx, typekey(1), t, .35, .1)
    elif ty == 'card':
        add(fx, morse('.-.'), t, .32, .25)
        for k in range(e['n']): add(fx, typekey(.75 + .25 * rng.random()), t + .035 * k, .3, .3 - .04 * k)
    elif ty == 'sweep': add(fx, whoosh(.5, 1), t, .38)
    elif ty == 'rewind':
        add(fx, rewind(e['d']), t, .55)
        for k in range(16): add(fx, tick(.8, 3000 - 90 * k), t + k * SPB / 8, .25, .2 * np.sin(k))   # clock ticks running backwards
    elif ty == 'splice': add(fx, tick(1, 1500), t, .4); add(fx, shutter(.6), t, .25)
    elif ty == 'cut': add(fx, thump(.7, 62), t, .42); add(fx, shutter(.8), t, .3)
    elif ty == 'snap': add(fx, S.note('marimba', 'D3', .6, .7), t, .55, -.3)
    elif ty == 'loupe': add(fx, whoosh(.3, 1), t, .28, .4); add(fx, shutter(.7), t, .3, .4)
    elif ty == 'stress':
        for k in range(5): add(fx, creak(.9), t + k * SPB * .9, .22, -.3 + .15 * k)
    elif ty == 'unfreeze': add(fx, tick(1, 1200), t, .35); add(fx, bp(noise(.4), 200, 1200) * env_exp(.4, .15), t, .12)
    elif ty == 'break':
        add(hitbus, thump(1.0, 38), t, 1.0); add(hitbus, thump(.8, 55), t + .01, .6); add(hitbus, tear(2.4), t, .55, .1)
        add(hitbus, lp(brown(1.6), 160) * env_exp(1.6, .5), t, .55)
    elif ty == 'badge': add(fx, tick(1, 3200), t, .4, .2)
    elif ty == 'second': add(fx, wood(1, 'b'), t, .3, -.15)
    elif ty == 'jump': add(fx, tick(1, 2200), t, .4, -.1); add(fx, whoosh(.18, 1), t - .12, .12, -.1)

# the pendulum clock on the grid: every beat in S1/S2/S5, accelerating in S3, a single hard tick at the sync point
def clock(b, v=.5, var='a', pan=-.15): add(fx, wood(1, var), T(b), v, pan)
for b in (1, 2): clock(b, .35)
for b in range(5, 12): clock(b, .55 if b == 5 else .42, 'a' if b % 2 else 'b')
for b in (12, 13, 14): clock(b, .35, 'b')
for i in range(4): clock(15 + i * .5, .45, 'a' if i % 2 == 0 else 'b')
for i in range(4): clock(17 + i * .25, .5 + .05 * i, 'c' if i % 2 else 'a')
clock(18, .9, 'a', 0); add(fx, tick(1, 1800), T(18), .7, 0)
# S5: the clock now ticks real seconds (b21.5, b23, b25.5 from window.EV) and jumps at b24 — no pendulum on every beat
clock(28, .55, 'a', .1)

# ═════ the silence (b19–20) ═════
g = np.ones(N, np.float32); a0, a1, z1 = int(T(18.6) * SR), int(T(19) * SR), int(T(20) * SR)
g[a0:a1] = np.linspace(1, .004, a1 - a0) ** 2; g[a1:z1] = .004 ** 2
mus *= g[:, None]; fx *= g[:, None]
fx[a1:z1] += np.repeat(lp(brown((z1 - a1) / SR), 300)[:z1 - a1, None], 2, 1) * .0025   # only the faintest room

BG = 1.7  # +4.6 dB on the break bus (thump, tear, rumble)
# everything before the silence sits 2.9 dB lower than the break (the limiter caps the b20 peaks, so headroom comes from below)
pre = int(T(19) * SR); mus[:pre] *= .72; fx[:pre] *= .72
hb = hitbus * 1.1 * BG; hpk = float(np.abs(hb).max()); hb = np.tanh(hb / hpk * 3.0) / np.tanh(3.0) * hpk   # saturate the break: denser (RMS up) at the same peak, harmonics carry the sub on small speakers
out = mus * 2.6 + fx * .85 + hb
# low-end balance: pull 20–120 Hz down so it sits ≈ 3 dB under the rest (TECHNIQUE §5)
from scipy.signal import butter, sosfiltfilt
LOWG = .5; low = sosfiltfilt(butter(2, 120, 'low', fs=SR, output='sos'), out, axis=0); out = out - low * (1 - LOWG)
tail = int(.35 * SR); out[-tail:] *= np.linspace(1, 0, tail)[:, None] ** 1.5
def tp_limit(x, ceil):
    from scipy.signal import resample_poly
    from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
    up = resample_poly(x, 4, 1); n = int(.004 * SR * 4)
    gg = np.minimum(1, ceil / np.maximum(maximum_filter1d(np.abs(up), 2 * n + 1), 1e-9)); gg = uniform_filter1d(minimum_filter1d(gg, 2 * n + 1), n)
    return resample_poly(up * gg, 1, 4)[:len(x)]
out = np.stack([tp_limit(limit(out[:, c], .6), .55) for c in range(2)], 1)
os.makedirs(os.path.join(D, 'out'), exist_ok=True)
sf.write(os.path.join(D, 'out/mix.wav'), out.astype(np.float32), SR)
print('mix', out.shape, round(out.shape[0] / SR, 3), 's  peak', round(float(np.abs(out).max()), 3))
X = np.abs(np.fft.rfft(out.mean(1))) ** 2; fq = np.fft.rfftfreq(len(out), 1 / SR)
print('low 20–120 Hz vs rest:', round(10 * np.log10(X[(fq >= 20) & (fq < 120)].sum() / X[(fq >= 120) & (fq < 16000)].sum()), 1), 'dB')
print('credits:', S.credits(sorted({e[1] for e in ev} | {'woodblock', 'marimba'})))
