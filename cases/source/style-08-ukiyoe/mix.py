"""一伞三景 — original score + foley + mix, all from the one timeline (events.json, exported from timeline.js via the page).
Run from the library root:  $LIB/.venv/bin/python <project>/mix.py   →  out/mix.wav, out/music.wav, out/cues.json
Score: shamisen (pluck.py, sawari), shakuhachi (flute/recorder samples bent and breathed), taiko + shime + kotsuzumi + ōtsuzumi
(sampled drums + synthesized skins), hyōshigi clappers, koto glissandi, a hand chime. 80 BPM, miyako-bushi on D (D E♭ G A B♭)."""
import sys, os, json
LIB = os.environ.get('LIB') or os.getcwd()
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, t_, env_exp, bp, lp, hp, norm

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
DUR = E['dur']; N = int(round(DUR * SR))
META = next(e for e in E['ev'] if e['type'] == 'meta'); B = META['beat']; BEATS = META['beats']
def b(n): return round(n * B, 6)
T = {k: b(v) for k, v in BEATS.items()}
rng = np.random.default_rng(2024); S.seed(8)
CUES = []
def cue(t, name, stem='music'): CUES.append({'t': round(t, 4), 'name': name, 'stem': stem})
def st(): return np.zeros((N, 2), np.float32)
mus = {k: st() for k in ['shamisen', 'shaku', 'drums', 'koto']}
fx, amb = st(), st()
def nz(d): return rng.standard_normal(int(round(d * SR)))
def fade(x, a=.004, r=.02):
    x = x.copy(); n = len(x); A, R = min(n, int(a * SR)), min(n, int(r * SR))
    if A: x[:A] *= np.linspace(0, 1, A)
    if R: x[n - R:] *= np.linspace(1, 0, R)
    return x
def sines(spec, d):
    tt = t_(d); return sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * np.exp(-tt / tau) for f, tau, a in spec)

# ═════════════ instruments ═════════════
def sam(p, v=.7, dur=None, **kw):
    kw.setdefault('buzz', .7); return P.pluck('shamisen', p, dur, v, **kw)
def koto(p, v=.6, dur=None, **kw): return P.pluck('koto', p, dur, v, **kw)
def hyoshigi(v=1.0):
    L = int(.45 * SR); tt = np.arange(L) / SR
    y = sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * np.exp(-tt / tau) for f, a, tau in [(1240, 1., .045), (2510, .7, .03), (3900, .4, .02), (820, .35, .06)])
    y = y / np.abs(y).max() + 1.4 * bp(rng.standard_normal(L) * np.exp(-tt / .0016), 1500, 9000)
    s1 = S.hit('world_perc', 'claves', .9); s2 = S.hit('woodblock', 'a', .9)
    out = y / np.abs(y).max(); out[:min(L, len(s1))] += s1[:L] / (np.abs(s1).max() + 1e-9) * .7; out[:min(L, len(s2))] += s2[:L] / (np.abs(s2).max() + 1e-9) * .4
    d = int(.0028 * SR); out[d:] += .3 * out[:-d]
    return (out / np.abs(out).max() * v).astype(np.float32)
def taiko(v=1.0, big=False):
    L = int(2.2 * SR); tt = np.arange(L) / SR
    f = 56 + 66 * np.exp(-tt / .04); ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-tt / (.6 if big else .38)) + .35 * np.sin(1.59 * ph + 1) * np.exp(-tt / .2) + .2 * np.sin(2.13 * ph) * np.exp(-tt / .1)
    syn = body + bp(rng.standard_normal(L), 90, 900) * np.exp(-tt / .018) * .8 + bp(rng.standard_normal(L), 1200, 5000) * np.exp(-tt / .004) * .25
    out = syn / np.abs(syn).max() * .85
    for inst, var, g in [('gran_cassa', 'hit', .55), ('toms', 'low_mallet', .35), ('frame_drum', 'large', .3)]:
        s = S.hit(inst, var, min(1, .5 + .5 * v)); s = s[:L] / (np.abs(s).max() + 1e-9); out[:len(s)] += s * g
    out = sosfilt(butter(2, 3800, 'low', fs=SR, output='sos'), out)
    return (out / np.abs(out).max() * v).astype(np.float32)
def shime(v=.6):
    L = int(.5 * SR); tt = np.arange(L) / SR
    f = 400 + 150 * np.exp(-tt / .01); y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .06) + .5 * bp(rng.standard_normal(L), 800, 4000) * np.exp(-tt / .005)
    s = S.hit('frame_drum', 'small_muted', .7); s = s[:L] / (np.abs(s).max() + 1e-9); y = y / np.abs(y).max() * .7; y[:len(s)] += s * .5
    return (y / np.abs(y).max() * v).astype(np.float32)
def pon(v=.8):    # kotsuzumi: a hollow pitched "pon" that rises as the cords are squeezed
    L = int(.9 * SR); tt = np.arange(L) / SR; f = 290 + 70 * (1 - np.exp(-tt / .05))
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .22) + .3 * np.sin(2 * np.pi * np.cumsum(f * 2.3) / SR) * np.exp(-tt / .08)
    y += .35 * bp(rng.standard_normal(L), 400, 3000) * np.exp(-tt / .006)
    return (fade(y / np.abs(y).max()) * v).astype(np.float32)
def kan(v=.8):    # ōtsuzumi: a dry, cracking "kan"
    L = int(.35 * SR); tt = np.arange(L) / SR
    y = bp(rng.standard_normal(L), 1800, 6000, 3) * np.exp(-tt / .012) + .6 * np.sin(2 * np.pi * 930 * tt) * np.exp(-tt / .03) + .3 * np.sin(2 * np.pi * 1610 * tt) * np.exp(-tt / .02)
    return (y / np.abs(y).max() * v).astype(np.float32)
def chime(p='D6', v=.5): return S.note('hand_chimes', p, 2.5, v, release=1.5)
def shaku(p, dur, v=.7, slide=-1.5, fall=0.0, swell=.5, breath=1.0, rel=.35, muraiki=0.):
    """shakuhachi from flute + recorder samples: envelope flattened, slid in from below, meri fall at the end, breath noise"""
    m = S.midi(p); ext = dur + rel + .6
    a = S.note('recorder', max(m, S.midi('F4') - 3), ext, .7, release=.2); c = S.note('flute', max(m, S.midi('C4')), ext, .6, release=.2)
    n = min(len(a), len(c)); y = (.6 * a[:n] / (np.abs(a).max() + 1e-9) + .4 * c[:n] / (np.abs(c).max() + 1e-9)).astype(np.float64)
    w = int(.06 * SR); e = np.sqrt(np.convolve(y ** 2, np.ones(w) / w, 'same')) + 1e-4; e = np.convolve(e, np.ones(w) / w, 'same'); y = y / e
    L = int((dur + rel) * SR); to = np.arange(L) / SR; bend = np.zeros(L)
    if slide: sl = .18; bend += np.where(to < sl, slide * (1 - np.sin(np.clip(to / sl, 0, 1) * np.pi / 2)), 0)
    if fall: k = np.clip((to - (dur - .5)) / .55, 0, 1); bend += fall * k * k
    ph = .04 * SR + np.concatenate([[0], np.cumsum(2 ** (bend[:-1] / 12))]); ph = np.minimum(ph, n - 2)
    z = np.interp(ph, np.arange(n), y)
    envl = np.clip(to / .14, 0, 1) ** 1.6 * (1 + swell * np.sin(np.clip(to / max(dur, .1), 0, 1) * np.pi) ** 1.5 * .8) * (1 - np.clip((to - dur) / rel, 0, 1)) ** 2
    z = z * envl; z = sosfilt(butter(2, 3200, 'low', fs=SR, output='sos'), z) * .8 + bp(z, 900, 1600) * .5
    nzz = bp(rng.standard_normal(L), 1000, 4000, 3); be = .22 * envl + (.9 + muraiki * 2.5) * np.exp(-to / (.07 + muraiki * .12)) * np.clip(to / .012, 0, 1)
    z = z / (np.abs(z).max() + 1e-9) + breath * .5 * nzz / (np.abs(nzz).max() + 1e-9) * be
    return fade(z / (np.abs(z).max() + 1e-9) * v, .003, .03).astype(np.float32)
def put(k, x, t, g=1.0, pan=0.0, name=None):
    add(mus[k], x, t, g, pan)
    if name: cue(t, name, k)

# ═════════════ A · printing (b0–b6) ═════════════
put('drums', hyoshigi(.95), 0.0, 1.0, -.1, 'clack')
for n, (p, name) in enumerate([('D3', 'key'), ('A3', 'sky'), ('Bb3', 'water'), ('D4', 'wood'), ('G3', 'red')], start=1):
    kw = dict(bend=[(0, 0), (.25, 0), (.45, -1)]) if p == 'Bb3' else {}
    put('shamisen', sam(p, .82, None, **kw), b(n), 1.0, -.15 + .08 * n, name)
put('shaku', shaku('A4', 1.9, .62, slide=-2, swell=.6), b(2), 1.0, .15)
put('shaku', shaku('G4', 1.1, .55, slide=0, fall=-1.0, swell=.3), b(4.5), 1.0, .15)
put('drums', taiko(.45), b(4), .7, 0); put('drums', taiko(.7), b(5), .85, 0)
for i in range(4):   # first shamisen ostinato: eighths under the rain
    put('shamisen', sam(['D3', 'A3', 'D4', 'A3'][i], .48 if i % 2 else .6), b(5 + .5 * i), .75, -.2 + .1 * i)
# ═════════════ B · the wind (b6–b10): taiko roll accelerates, clappers accelerate ═════════════
for i, n in enumerate(META['roll']):
    put('drums', taiko(.45 + .45 * i / len(META['roll'])), b(n), .8, (-.2, .2)[i % 2], 'gust' if i == 0 else None)
tt = b(7.9375)
while tt < b(8) - 1e-6: put('drums', shime(.7), tt, .8, .25); tt += B / 16
put('shamisen', sam('Eb4', .85), T['tug'], 1.0, .2, 'tug'); put('drums', kan(.9), T['tug'], .8, .3)
put('drums', taiko(1.0, True), T['tear'], .9, 0, 'tear')
put('shamisen', P.strum('shamisen', ['D3', 'A3', 'D4'], None, .9, spread=.016, buzz=.85, t60=2.0), T['tear'], 1.0, -.1)
for k in range(12):   # shamisen tremolo on D4 climbing in loudness to the breakout
    put('shamisen', sam('D4' if k < 8 else 'Eb4', .4 + .04 * k, buzz=.5), b(8.5) + k * B / 4, .7, .15)
put('shamisen', sam('A4', .7, buzz=.5), b(9), .8, .3, 'pop')
for i, n in enumerate(META['clap']):
    put('drums', hyoshigi(.6 + .05 * i), b(n), .9, (-.25, .25)[i % 2], 'clap' if i == 0 else None)
put('drums', taiko(1.0, True), T['breakout'], 1.0, 0, 'breakout'); put('drums', kan(1.0), T['breakout'], 1.0, -.3)
put('shaku', shaku('D5', .9, .7, slide=-1, swell=.2, muraiki=1.0), T['breakout'], .9, .2)
put('shamisen', sam('D5', .8, buzz=.5), T['breakout'], .8, .2)
# ═════════════ C · three views (b10–b18): ostinato + shime + taiko ═════════════
pat = ['D3', 'D4', 'A3', 'D4', 'Bb3', 'A3', 'G3', 'A3', 'D3', 'D4', 'A3', 'Eb4', 'D4', 'A3', 'Bb3', 'A3']
n = 10.5; i = 0
while n < 18 - 1e-6:
    if not (b(12.75) <= b(n) < b(13.5)) and not (b(15.5) <= b(n) < b(16)):
        grow = 1 + .25 * max(0, (n - 16) / 2)
        put('shamisen', sam(pat[i % 16], (.5 if i % 2 else .62) * grow, buzz=.55), b(n), .72, -.12 + .24 * (i % 2))
    if i % 2 == 1: put('drums', shime(.5 + .15 * max(0, (n - 16) / 2)), b(n), .75, .3)
    n += .5; i += 1
for n_, nm, big in [(11, 'v1', False), (13.5, 'v2', True), (16, 'v3', True)]: put('drums', taiko(1.0 if big else .8, big), b(n_), 1.0, 0, nm)
for n_ in [12, 14, 15, 17]: put('drums', taiko(.6), b(n_), .8, 0)
put('drums', pon(.9), T['bounce'], 1.0, -.2, 'bounce')
for k, p in enumerate(['A3', 'Bb3', 'D4', 'Eb4', 'G4', 'A4']):   # the slide to view 2: a rising run
    put('shamisen', sam(p, .5 + k * .05, buzz=.6), b(12.75) + k * B / 8, .8, -.3 + k * .1)
put('shaku', shaku('A5', .7, .75, slide=-1.5, swell=.2, muraiki=1.0, fall=-.8), T['v2'], .85, .2)
put('shamisen', P.pluck('shamisen', 'D4', None, .6, trem=14, buzz=.6), T['splash'], .7, .2)
put('drums', taiko(.85), T['splash'], .9, 0, 'splash')
for k, p in enumerate(['D4', 'Eb4', 'G4', 'A4', 'Bb4', 'D5', 'Eb5', 'G5']):   # koto glissando landing on view 3
    put('koto', koto(p, .45 + .05 * k), T['v3'] - (7 - k) * .04, .9, -.3 + .08 * k, 'v3gliss' if k == 7 else None)
put('shamisen', sam('D4', .75), T['v3'], .8, -.1)
put('koto', koto('A5', .55), T['v3seal'], .8, .3, 'v3seal')
tt = b(17.5); k = 0
while tt < b(18) - 1e-6: put('drums', shime(.55 + .4 * k / 12), tt, .85, (-.2, .2)[k % 2]); tt += B / 12; k += 1
put('drums', taiko(.9), b(17.5), .8, 0)
# ═════════════ D · ma (b18–b20): silence — everything is cut on the beat (tails too) ═════════════
cue(T['ma'], 'ma')
# ═════════════ E · the fall (b20–end) ═════════════
put('shaku', shaku('D5', 2.4, .8, slide=-2.5, fall=-1.0, swell=.7, breath=1.1, rel=.5), T['shaku'], 1.0, .05, 'shaku')
put('koto', koto('A4', .5), T['reach'], .8, -.2, 'reach')
put('drums', pon(.8), T['catch'], .9, -.1, 'catch')
put('shamisen', sam('D3', .8, None, t60=4.0, buzz=.85), T['catch'], 1.0, -.1)
put('shaku', shaku('G4', .7, .5, slide=0, swell=.2), b(23), .9, .1); put('shaku', shaku('A4', 1.0, .55, slide=0, fall=-.6, swell=.3), b(23.5), .9, .1)
for k, p in enumerate(['D4', 'Eb4', 'G4', 'A4', 'Bb4', 'D5', 'Eb5', 'G5', 'A5', 'D6']):   # season turns: koto glissando up to the clear sky
    put('koto', koto(p, .38 + .04 * k), T['clear'] - (9 - k) * .035, .85, -.35 + .07 * k, 'clear' if k == 9 else None)
put('koto', chime('D6', .5), T['clear'], .5, .3)
put('drums', taiko(.6), T['seal'], .9, 0, 'seal')
put('shamisen', P.strum('shamisen', ['D3', 'A3', 'D4'], None, .65, spread=.02, buzz=.8, t60=3.0), T['seal'], .9, -.1)
put('shaku', shaku('D5', 1.0, .5, slide=-1, swell=.3, fall=-.5, rel=.6), T['seal'], .8, .1)

# music bus: light room, then the ma: hard cut at b18 (reverb tails too), back at b20
music = sum(mus.values())
music = S.room(music, size=.42, mix=.16)
m0, m1 = int(T['ma'] * SR), int(T['maEnd'] * SR)
music[m0:m1] = 0
sf.write(os.path.join(HERE, 'out', 'music.wav'), music, SR)
for k, v in mus.items(): sf.write(os.path.join(HERE, 'out', f'stem_{k}.wav'), v, SR)

# ═════════════ foley ═════════════
def baren(d=.3, v=1):
    tt = t_(d); m = .55 + .45 * np.abs(np.sin(2 * np.pi * 4.6 * tt)); e = np.sin(np.pi * tt / d) ** .7
    return norm(bp(nz(d), 700, 5200) * m * e + lp(nz(d), 500) * e * .3) * v
def block(v=1): d = .2; x = sines([(180, .05, 1), (410, .03, .6), (960, .015, .3)], d); x[:int(.004 * SR)] += nz(.004) * .5; return norm(lp(x, 3000)) * v
def slip(v=1): d = .28; tt = t_(d); return norm(hp(nz(d), 1800) * np.sin(np.pi * tt / d) ** 2 * (1 - tt / d * .5)) * v
def seal(v=1):
    d = .35; x = sines([(88, .07, 1), (180, .03, .4)], d); x[:int(.012 * SR)] += bp(nz(.012), 200, 1500) * .9
    y = np.zeros(int(.45 * SR)); y[:len(x)] += x; k = int(.2 * SR); c = hp(nz(.08), 3000) * env_exp(.08, .02) * .15; y[k:k + len(c)] += c
    return norm(lp(y, 2500)) * v
def scroll(d, v=1):
    tt = t_(d); e = np.sin(np.pi * np.minimum(tt / d, 1)) ** 1.2; f = np.interp(tt, [0, d], [1200, 3200]); x = np.zeros_like(tt); src = nz(d)
    for i in range(0, len(tt), 2400): x[i:i + 2400] = bp(src[max(0, i - 4800):i + 2400], f[i] * .6, f[i] * 1.6)[-len(x[i:i + 2400]):]
    return norm(x * e) * v
def wstep(v=1): d = .18; x = sines([(170, .06, 1), (390, .03, .5), (720, .012, .25)], d); x[:int(.01 * SR)] += bp(nz(.01), 300, 2500) * .6; return norm(lp(x, 2200)) * v
def paper_snap(v=1):   # oiled paper umbrella snapping inside out
    d = .3; tt = t_(d); x = hp(nz(d), 1500) * np.exp(-tt / .03) + bp(nz(d), 300, 1200) * np.exp(-tt / .05) * .6 + np.sin(2 * np.pi * 110 * tt) * np.exp(-tt / .04) * .5
    return norm(x) * v
def flutter(d=.35, v=1):
    tt = t_(d); am = (np.sin(2 * np.pi * 26 * tt) > 0).astype(float) * .7 + .3; return norm(bp(nz(d), 600, 4000) * am * np.sin(np.pi * tt / d) ** 1.5) * v
def whoosh(d=.6, v=1):
    tt = t_(d); f = np.interp(tt, [0, d * .6, d], [400, 2200, 900]); x = np.zeros_like(tt); src = nz(d)
    for i in range(0, len(tt), 1200): x[i:i + 1200] = bp(src[max(0, i - 2400):i + 1200], f[i] * .6, f[i] * 1.5)[-len(x[i:i + 1200]):]
    return norm(x * np.sin(np.pi * tt / d) ** 2) * v
def tear(v=1):   # paper tearing: a crackle of tiny fibres giving way
    d = .32; tt = t_(d); cr = hp(nz(d), 2500) * (rng.random(len(tt)) > .93) * 2.5; x = lp(cr, 9000) * np.exp(-tt / .12) + bp(nz(d), 1500, 6000) * np.exp(-tt / .06) * .4
    return norm(x) * v
def tile(v=1): d = .25; x = sines([(2350, .03, 1), (3700, .02, .6), (1560, .05, .5), (5200, .01, .3)], d); x[:int(.003 * SR)] += nz(.003); return norm(x) * v
def crash_(v=1): d = 1.4; tt = t_(d); x = lp(nz(d), 3000) * np.exp(-tt / .45) + sines([(46, .4, 1.2), (70, .25, .6)], d) + hp(nz(d), 3000) * np.exp(-tt / .15) * .4; return norm(x) * v
def hiss(d, v=1): tt = t_(d); return norm(hp(nz(d), 3000) * np.exp(-tt / (d * .4))) * v
def tok(v=1): d = .16; x = sines([(620, .03, 1), (1350, .015, .5), (240, .04, .5)], d); x[:int(.003 * SR)] += nz(.003) * .5; return norm(x) * v
def rustle(d=.3, v=1): tt = t_(d); return norm(bp(nz(d), 1500, 7000) * np.sin(np.pi * tt / d) ** 2 * (rng.random(len(tt)) > .5)) * v
def chirp(v=1):
    out = np.zeros(int(.9 * SR)); t0 = 0
    for i in range(5):
        d = .05 + rng.random() * .04; tt = t_(d); f = np.interp(tt, [0, d], [3600 + rng.random() * 800, 4800 + rng.random() * 1200]); s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d)
        k = int(t0 * SR); out[k:k + len(s)] += s; t0 += d + .05 + rng.random() * .08
    return norm(out) * v

for e in E['ev']:
    t, ty = e['t'], e['type']
    if ty == 'baren': add(fx, baren(e['d'] + .05, .5 if e['k'] != 'dawn' else .55), t, 1, .1)
    elif ty == 'land': add(fx, block(.5), t, 1, -.1); add(fx, slip(.18), t + .01, 1, .2)
    elif ty == 'step': add(fx, wstep(.4), t, 1, -.2)
    elif ty == 'gust': add(fx, whoosh(1.4, .7), t - .15, 1, -.3)
    elif ty == 'tug': add(fx, paper_snap(.85), t, 1, .2)
    elif ty == 'tear': add(fx, whoosh(.8, .9), t - .05, 1, .3); add(fx, flutter(.4, .5), t, 1, .2)
    elif ty == 'flap': add(fx, flutter(.25, .32 * e['v']), t, 1, .3)
    elif ty == 'pop': add(fx, paper_snap(.5), t, 1, .3)
    elif ty == 'breakout': add(fx, tear(.9), t, 1, .25); add(fx, tok(.5), t + .005, 1, .3)
    elif ty == 'slide': add(fx, scroll(e['d'] + .1, .55), t - .05, 1, 0)
    elif ty == 'cart': add(fx, slip(.4), t, 1, -.3)
    elif ty == 'seal': add(fx, seal(.95 if e.get('big') else .55), t - .01, 1, .3 if e.get('big') else -.2)
    elif ty == 'bounce': add(fx, tile(.55), t, 1, -.1); add(fx, flutter(.3, .3), t, 1, -.1)
    elif ty == 'wave': add(fx, crash_(.8), t - .02, 1, 0)
    elif ty == 'splash': add(fx, hiss(.9, .5), t, 1, .2)
    elif ty == 'leaf': add(fx, whoosh(.55, .22), t - .27, 1, (-.3 if t < T['reach'] else .3))
    elif ty == 'reach': add(fx, rustle(.3, .3), t - .1, 1, .2)
    elif ty == 'catch': add(fx, tok(.75), t, 1, .2); add(fx, rustle(.25, .3), t, 1, .2)
    elif ty == 'clear': add(fx, chirp(.22), t + .35, 1, -.4); add(fx, chirp(.16), t + 1.0, 1, .4)

# ═════════════ ambience ═════════════
def rainbed(d):
    tt = t_(d); bed = hp(nz(d), 900) * .5 + bp(nz(d), 300, 2000) * .25; drops = np.zeros_like(tt)
    for i in rng.integers(0, len(tt) - 400, int(d * 70)): drops[i:i + 200] += np.exp(-np.arange(200) / 30) * (rng.random() - .5) * 3
    return norm(bed + hp(drops, 1500) * .6)
def windbed(d): w = np.cumsum(nz(d)); w -= np.linspace(w[0], w[-1], len(w)); return norm(bp(w, 150, 900))
def env_curve(points):
    tt = np.arange(N) / SR; return np.interp(tt, [p[0] for p in points], [p[1] for p in points]).astype(np.float32)
rb = rainbed(DUR); rb2 = rainbed(DUR)
rainE = env_curve([(0, 0), (T['red'] - .1, 0), (T['red'] + .3, .24), (T['ma'] - .02, .26), (T['ma'], .012), (T['maEnd'] - .01, .012), (T['maEnd'] + .4, .16), (T['clear'] - .36, .15), (T['clear'], 0), (DUR, 0)])
amb[:, 0] += rb * rainE; amb[:, 1] += rb2 * rainE
wb = windbed(DUR); windE = env_curve([(0, 0), (T['gust'] - .2, 0), (T['gust'] + .3, .5), (T['breakout'], .45), (T['v1'] + .5, .16), (T['ma'] - .02, .16), (T['ma'], 0), (T['maEnd'], 0), (T['maEnd'] + .5, .06), (T['clear'], .03), (DUR, .03)])
amb[:, 0] += wb * windE; amb[:, 1] += np.roll(wb, 2400) * windE
sea = lp(np.cumsum(nz(DUR)), 500); sea = norm(hp(sea, 110, 3)) * (.6 + .4 * np.sin(2 * np.pi * np.arange(N) / SR / 2.6))
seaE = env_curve([(0, 0), (T['s2a'], 0), (T['v2'], .35), (T['s3a'], .3), (T['v3'], .08), (T['ma'], .08), (T['ma'] + .01, 0), (T['maEnd'], 0), (T['maEnd'] + .6, .07), (DUR, .07)])
amb[:, 0] += sea * seaE; amb[:, 1] += sea * seaE

# ═════════════ mix ═════════════
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-9)
mix = music * 1.0 + fx * .55 + amb * .5
# low end: a gentle high-pass on the whole mix keeps 20–120 Hz about 3 dB under the rest
mix = np.stack([hp(mix[:, c], 45, 2) for c in range(2)], 1).astype(np.float32)
# in the ma: only the faint rain remains (near silence)
mix[m0:m1] = (amb[m0:m1] * .5 + fx[m0:m1] * .55)
fo = int(.35 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
json.dump(sorted(CUES, key=lambda c: c['t']), open(os.path.join(HERE, 'out', 'cues.json'), 'w'), ensure_ascii=False, indent=0)
seg = lambda a, z: 20 * np.log10(rms(mix[int(a * SR):int(z * SR)]))
print(f'mix {DUR:.2f}s  peak {np.abs(mix).max():.3f}  rms dB: A {seg(0, T["gust"]):.1f}  B {seg(T["gust"], T["breakout"]):.1f}  C {seg(T["breakout"], T["ma"]):.1f}  ma {seg(T["ma"] + .05, T["maEnd"]):.1f}  E {seg(T["maEnd"], DUR):.1f}')
print('instruments:', 'shamisen/koto (pluck.py), recorder, flute, hand_chimes, gran_cassa, toms, frame_drum, world_perc, woodblock')
