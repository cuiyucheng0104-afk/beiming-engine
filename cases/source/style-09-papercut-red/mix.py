"""鲤鱼跃龙门 — original score + foley + ambience → out/mix.wav (+ out/cuelog.json for the cue check)
Everything is timed from events.json (exported from the page, whose times come from timeline.js).
Run from anywhere: $LIB/.venv/bin/python mix.py   (LIB must point at the library; build.sh sets it)
Instruments (STYLE.md palette): pipa (pluck model), zheng (dan_tranh samples), erhu, dizi (flute samples), sheng (numpy free-reed synthesis),
woodblock (the 梆子 part), small gong, one big gong, frame drum. D gong pentatonic, 110.77 BPM.
"""
import sys, os, json
LIB = os.environ.get('LIB') or os.path.expanduser('~/lemo-opuscar')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.signal import fftconvolve
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, limit, add

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR, EV = EVJ['dur'], EVJ['ev']
N = int((DUR + .05) * SR)
S.seed(9); rng = np.random.default_rng(23)
B = 13 / 24
bt = lambda x: x * B                       # beat → s (beats are whole frames)
qf = lambda t: round(t * 24) / 24          # sub-beat cues: same frame rounding as the page (JS Math.round; no .5 ties occur here)
def evs(ty): return [e for e in EV if e['type'] == ty]
def ev1(ty): return evs(ty)[0]['t']

MUS = {k: np.zeros((N, 2), np.float32) for k in ['pluck', 'zheng', 'winds', 'perc', 'sheng']}
FX = np.zeros((N, 2), np.float32); AMB = np.zeros((N, 2), np.float32)
CUELOG = []                                 # (name, onset s, source) for every note or sound tied to a picture event
def log(name, t, src): CUELOG.append({'cue': name, 't': round(float(t), 6), 'src': src})

# ---------------- instruments ----------------
def pipa(t, p, d, v=.7, g=1., pan=-.2, trem=None):
    kw = {'trem': trem} if trem else {}
    add(MUS['pluck'], P.pluck('pipa', p, d, vel=v, **kw), t, g, pan)
def zheng(t, p, d=1.4, v=.55, g=1., pan=.25): add(MUS['zheng'], S.note('dan_tranh', p, d, vel=v), t, g, pan)
def gliss(t_end, notes, step=.03, v=.5, g=.8, pan=.25):   # rising run that lands its last note on t_end
    for i, p in enumerate(notes): zheng(t_end - (len(notes) - 1 - i) * step, p, .9, v * (.7 + .3 * i / len(notes)), g, pan)
def erhu(t, p, d, v=.5, g=1., pan=.15, curve=None):
    x = S.note('erhu', p, d * 1.6 + .6, vel=v, attack=.06)
    if curve:
        n = int(d * SR); tt = np.arange(n) / SR; ks, vs = zip(*curve); ratio = 2 ** (np.interp(tt, ks, vs) / 12); pos = np.cumsum(ratio); pos = pos[pos < len(x) - 2]
        i = pos.astype(int); f = pos - i; x = x[i] * (1 - f) + x[i + 1] * f; fd = min(len(x), int(.12 * SR)); x[-fd:] *= np.linspace(1, 0, fd)
    else: x = x[:int((d + .3) * SR)]; fd = int(.3 * SR); x[-fd:] *= np.linspace(1, 0, fd)
    add(MUS['winds'], x.astype(np.float32), t, g, pan)
def dizi(t, p, d, v=.55, g=1., pan=-.3):
    x = S.note('flute', p, d, vel=v, attack=.03)
    # dizi membrane buzz: a little band-passed noise riding the note's envelope
    e = np.abs(x); e = np.convolve(e, np.ones(480) / 480, 'same'); buzz = bp(noise(len(x) / SR), 2500, 6000)[:len(x)] * e * .5
    add(MUS['winds'], (x + buzz).astype(np.float32), t, g, pan)
def wb(t, v=.6, var='a', g=1., pan=.35): add(MUS['perc'], S.hit('woodblock', var, vel=v), t, g, pan)
def gong(t, kind='small', v=.6, g=1., pan=0): add(MUS['perc'], S.hit('gong2', kind, vel=v), t, g, pan)
def drum(t, kind='large', v=.7, g=1., pan=0): add(MUS['perc'], S.hit('frame_drum', kind, vel=v), t, g, pan)
def sheng(t, pitches, d, v=.5, g=1., pan=0.):
    """free-reed mouth organ: additive partials, two slightly detuned reeds per pipe, breathy attack, no vibrato"""
    n = int((d + .5) * SR); tt = np.arange(n) / SR; out = np.zeros(n)
    for p in pitches:
        f0 = 440 * 2 ** ((S.midi(p) - 69) / 12)
        for det in (-2.5, 2.5):
            f = f0 * 2 ** (det / 1200)
            for k in range(1, 16):
                if f * k > 9000: break
                out += np.sin(2 * np.pi * f * k * tt + rng.random() * 6) * (1 / k ** .85) * (1.15 if k % 2 == 0 else 1)
    env = np.minimum(1, tt / .07) * np.where(tt < d, 1, np.exp(-(tt - d) / .12)); env *= 1 + .04 * np.sin(2 * np.pi * .7 * tt)
    breath = bp(noise(n / SR), 800, 4000)[:n] * np.minimum(1, tt / .05) * np.exp(-tt / .25) * .3
    x = lp(out / max(1, len(pitches)) * .25, 5200) * env + breath * env
    add(MUS['sheng'], (norm(x) * v).astype(np.float32), t, g, pan)

PENT = ['D', 'E', 'F#', 'A', 'B']
def pent(i, base=4): return f"{PENT[i % 5]}{base + i // 5}"

# ================= SCORE =================
land, fold, unfold = ev1('land'), ev1('crease'), ev1('unfold')
snips = [e['t'] for e in evs('snip')]
peel, settle, gateup, plaque = ev1('peel'), ev1('settle'), ev1('gateup'), ev1('plaque')
copies = [e['t'] for e in evs('copy')]
launch, apex, burst, un2, un3 = ev1('launch'), ev1('apex'), ev1('burst'), ev1('unfold2'), ev1('unfold3')
fuin, fufold, fusn, fuland = ev1('fuin'), ev1('fufold'), [e['t'] for e in evs('fusnip')], ev1('fuland')

# M1 fold: sparse
drum(land, 'large', .75); zheng(land, 'D3', 2.2, .6, 1, 0); log('land', land, 'frame_drum+zheng')
zheng(bt(2), 'A3', 1.2, .4); wb(fold, .55, 'a'); zheng(fold, 'D4', 1.4, .45); log('fold', fold, 'woodblock+zheng')
# M2–M3 cut: pipa ostinato on eighths, woodblock off-beats, drum thickening; erhu enters at b8
riff = ['D4', 'A4', 'F#4', 'A4', 'E4', 'A4', 'F#4', 'B4']
for k in range(int((12 - 5) * 2)):
    tb = 5 + k * .5
    pipa(bt(tb), riff[k % 8], .5, .5 + .2 * (k / 14), .9)
for x in [5.5, 6.5, 7.5, 8.5, 9.5]: wb(bt(x), .4, 'b', .8)
for x in [10.25, 10.75]: wb(bt(x), .45, 'c', .8)
for x in [5, 7]: drum(bt(x), 'large', .55)
for x in [8, 9, 10]: drum(bt(x), 'large', .62)
for x in [10.5, 11]: drum(bt(x), 'small', .6)
zheng(bt(4), 'D2', 3, .4, .9, 0); zheng(bt(8), 'A2', 2.2, .45, .9, 0)
erhu(bt(8), 'F#4', bt(2.2), .45, .9, curve=[(0, 0), (bt(1.6), 0), (bt(2.1), 3)])
erhu(bt(10.25), 'A4', bt(1.6), .5, .9, curve=[(0, 0), (bt(1.2), 0), (bt(1.55), 2)])
for t in snips: log('snip', t, 'foley:snip')
# M4 unfold + breath
gliss(unfold, ['D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5', 'F#5', 'A5'], .028, .5, .85)
gong(unfold, 'small', .55, .8); log('unfold', unfold, 'small gong+zheng gliss')
for (b0, p, d, v) in [(12.15, 'A5', .85, .55), (13, 'B5', .5, .5), (13.5, 'A5', .5, .5), (14, 'F#5', 1, .52), (15, 'E5', .75, .5), (15.75, 'D5', .6, .5)]:
    dizi(bt(b0), p, bt(d), v, .85)
pipa(bt(12), 'D4', bt(2), .45, .7, trem=13); pipa(bt(14), 'A3', bt(2), .42, .7, trem=13)
for k, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A3', 'E4', 'D3', 'A3']): zheng(bt(12 + k * .5), p, 1.2, .32, .7, .3)
# M5–M6 climb: one rising zheng note per copy, drums and woodblock accelerate
drum(peel, 'large', .7); wb(peel, .5, 'a'); log('peel', peel, 'frame_drum+woodblock')
for i, t in enumerate(copies):
    zheng(t, pent(i, 4), 1.0, .5 + .25 * i / 13, 1.0, .35 if i % 2 else -.15); log(f'copy{i}', t, 'zheng')
for x in [17, 18, 19, 20]: drum(bt(x), 'large', .58)
for x in np.arange(20, 22, .5): drum(bt(x), 'large', .62)
for x in np.arange(22, 24, .25): drum(qf(bt(x)), 'small', .55 + .2 * (x - 22) / 2)
for x in [17.5, 18.5, 19.5]: wb(bt(x), .42, 'b', .75)
for x in np.arange(20.5, 22, .5): wb(qf(bt(x + .25)), .45, 'c', .75)
for x in np.arange(22, 24, .125): wb(qf(bt(x)), .3 + .3 * (x - 22) / 2, 'a', .6)
gong(plaque, 'small', .45, .6); log('plaque', plaque, 'small gong')
drum(gateup, 'large', .7, .8); log('gateup', gateup, 'frame_drum')
erhu(bt(17), 'D4', bt(4), .45, .85, curve=[(0, 0), (bt(3), 0), (bt(3.8), 7)])
erhu(bt(21), 'D5', bt(2.9), .5, .9, curve=[(0, 0), (bt(1.8), 0), (bt(2.6), 4)])
pipa(bt(20), 'A4', bt(2), .45, .7, trem=14); pipa(bt(22), 'D5', bt(2), .55, .8, trem=16)
zheng(bt(16), 'D2', 3, .4, .9, 0); zheng(bt(20), 'A2', 2, .45, .9, 0); zheng(bt(22), 'D3', 2, .5, .9, 0)
# M7 launch → apex: drum accent and a run to the top, then everything stops at the apex
drum(launch, 'large', .9); drum(launch, 'small', .7); log('launch', launch, 'frame_drum')
gliss(apex - .02, [pent(i, 4) for i in range(0, 15)], .034, .55, .9)
# M8–M9 dragon and 福
gong(burst, 'big', .95, 1.1); add(MUS['perc'], S.hit('bass_drum', vel=.9), burst, .8, 0); drum(burst, 'large', .9)
sheng(burst, ['D4', 'A4', 'D5', 'E5'], bt(4.2), .55, .85, 0); dizi(burst, 'D6', bt(3.6), .62, .9)
erhu(burst, 'D5', bt(3.5), .55, .85, curve=[(0, -2), (.12, 0)])
log('burst', burst, 'big gong+sheng+dizi+erhu')
gliss(un2, ['A4', 'B4', 'D5', 'E5', 'F#5'], .03, .5, .8); gliss(un3, ['B4', 'D5', 'E5', 'F#5', 'A5', 'B5'], .03, .55, .85)
log('unfold2', un2, 'zheng gliss'); log('unfold3', un3, 'zheng gliss')
for x in [29, 30, 31]: drum(bt(x), 'large', .6)
pipa(bt(29), 'D5', bt(2.5), .55, .8, trem=15)
wb(fufold, .5, 'a'); log('fufold', fufold, 'woodblock')
for t in fusn: log('fusnip', t, 'foley:snip')
gliss(fuland, ['D4', 'F#4', 'A4', 'D5'], .04, .45, .7)
gong(fuland, 'small', .6, .85); log('fuland', fuland, 'small gong+cadence')
for p, dt in [('D3', 0), ('A3', .03), ('D4', .06), ('F#4', .09), ('A4', .12)]: zheng(fuland + dt, p, 2.4, .5, .9, .2)
sheng(fuland, ['D4', 'F#4', 'A4', 'D5'], bt(3.6), .45, .7, -.1); dizi(fuland, 'A5', bt(1), .5, .8); dizi(bt(33), 'D6', bt(2.6), .5, .8)
erhu(fuland, 'F#4', bt(3.5), .4, .7)
wb(bt(34), .4, 'b', .7); wb(bt(35), .35, 'b', .6)

# ================= FOLEY =================
def snip(v=1., small=False):
    d = .22; tt = t_(d)
    sweep = bp(noise(d), 2500, 9000) * np.clip(tt / .05, 0, 1) * np.exp(-np.maximum(0, tt - .05) / .022)
    ring = np.sin(2 * np.pi * (4200 if small else 3800) * tt) * env_exp(d, .03) * .25 + np.sin(2 * np.pi * 5600 * tt) * env_exp(d, .02) * .12
    crack = np.zeros_like(tt); s0 = int(.05 * SR); c = hp(noise(.012), 1800) * env_exp(.012, .002); crack[s0:s0 + len(c)] = c * 2.2
    return norm(sweep * .8 + ring + crack + lp(noise(d), 900) * env_exp(d, .01) * .3) * v
SNIP_OFF = .05                                   # the blades meet (the "crack") 50 ms into the sound
def swish(d=.4, v=1., lo=700, hi=6000, flutter=0):
    tt = t_(d); e = np.sin(np.pi * np.clip(tt / d, 0, 1)) ** 1.5; am = 1 + flutter * np.sin(2 * np.pi * 22 * tt + rng.random() * 6)
    return norm(bp(noise(d), lo, hi) * e * am) * v
def tap(v=1., f=900):
    d = .09; tt = t_(d); return norm(bp(noise(d), 300, 3000) * env_exp(d, .01) + np.sin(2 * np.pi * f * .25 * tt) * env_exp(d, .015) * .5) * v
def snap(v=1., low=90):
    d = .3; tt = t_(d); return norm(hp(noise(d), 600) * env_exp(d, .012) * 1.4 + lp(noise(d), 300) * env_exp(d, .04) * .8 + np.sin(2 * np.pi * low * tt) * env_exp(d, .05) * .6) * v
def slap(v=1.):   # a sheet landing flat
    d = .25; tt = t_(d); return norm(bp(noise(d), 200, 2500) * env_exp(d, .02) + np.sin(2 * np.pi * 75 * tt) * env_exp(d, .04) * .7) * v
def peelS(d=.6, v=1.):
    tt = t_(d); x = bp(noise(d), 1200, 7000) * (.4 + .6 * np.sin(np.pi * tt / d)); gr = np.zeros_like(tt)
    for _ in range(int(d * 110)):
        s0 = int(rng.random() * (len(tt) - 600)); gr[s0:s0 + 600] += hp(noise(600 / SR), 2500)[:600] * env_exp(600 / SR, .002) * rng.random()
    return norm(x * .5 + gr) * v
def thud(v=1.):
    d = .8; tt = t_(d); f = 55 * (1 + .6 * np.exp(-tt / .04))
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .16) + lp(noise(d), 350) * env_exp(d, .05) * .8 + bp(noise(d), 500, 2500) * env_exp(d, .01) * .4) * v
def fwoomp(d=.9, v=1., f=900):
    tt = t_(d); e = np.minimum(1, tt / .06) * np.exp(-tt / (d / 3)); return norm(lp(noise(d), f) * e + np.sin(2 * np.pi * 70 * tt) * e * .4) * v
def shimmer(d=1.2, v=1.):
    tt = t_(d); x = sum(np.sin(2 * np.pi * f * tt + rng.random() * 6) * env_exp(d, .3 + rng.random() * .4) for f in [2637, 2960, 3520, 4434, 5274]) / 5
    return norm(x * np.clip(tt / .02, 0, 1)) * v
def whoosh(d=.5, v=1., lo=300, hi=4000):
    tt = t_(d); out = np.zeros(len(tt)); n = noise(d)
    for i in range(0, len(n), 480):
        h2 = min(len(n), i + 480); f = lo + (hi - lo) * (i / len(n)) ** 1.5; seg = bp(n[max(0, i - 2000):h2], f * .7, min(f * 1.4, 20000))[-(h2 - i):]; out[i:h2] = seg
    return norm(out * np.sin(np.pi * tt / d) ** 2 * (tt / d) ** .5) * v
def splash(v=1.):
    d = .5; tt = t_(d); return norm(bp(noise(d), 600, 6000) * env_exp(d, .09) * (1 + .5 * np.sin(2 * np.pi * 31 * tt)) + lp(noise(d), 400) * env_exp(d, .05)) * v
def crackers(d=1.2, v=1.):
    out = np.zeros(int((d + .4) * SR)); t = 0.
    while t < d:
        s0 = int(t * SR); k = .006 + rng.random() * .006
        c = hp(noise(k), 1200) * env_exp(k, .0012) * (.6 + rng.random() * .8); out[s0:s0 + len(c)] += c
        if rng.random() < .1: b2 = lp(noise(.25), 200) * env_exp(.25, .05) * .7; out[s0:s0 + len(b2)] += b2[:len(out) - s0]
        t += .025 + .05 * rng.random()
    return norm(out) * v
def flutter(d, v=1.):
    tt = t_(d); return norm(bp(noise(d), 1500, 7000) * (.3 + lp(rng.random(len(tt)), 12) * 2) ** 2) * np.minimum(1, tt / .5) * np.minimum(1, (d - tt) / .5) * v
def wind(d, v=1.):
    tt = t_(d); m = lp(rng.random(len(tt)), 2); return norm(bp(noise(d), 150, 1200) * (.35 + m)) * np.minimum(1, tt / .8) * np.minimum(1, np.maximum(0, d - tt) / .5) * v
def room(d):
    tt = t_(d); return norm(lp(brown(d), 400)) * np.minimum(1, tt / .3) * np.minimum(1, np.maximum(0, d - tt) / .3)

for e in EV:
    ty, t = e['type'], e['t']
    if ty == 'roomtone': add(AMB, room(e['dur']), t, .045)
    elif ty == 'nightbed': add(AMB, wind(e['dur']), t, .07, -.2)
    elif ty == 'land': add(FX, slap(1), t, .55); log('land', t, 'foley:slap')
    elif ty == 'foldswish': add(FX, swish(.55, 1, 600, 5500, .5), t, .4, .2)
    elif ty == 'crease': add(FX, tap(1.2), t, .45); log('fold', t, 'foley:crease')
    elif ty == 'scissorsin': add(FX, whoosh(.4, 1, 800, 7000), t - .2, .3, .4)
    elif ty == 'snip': add(FX, snip(1), t - SNIP_OFF, .6 + .1 * (e['i'] / 11), -.05)
    elif ty == 'scrapland': add(FX, tap(.5, 1600), t, .12, -.4 + .1 * (e['k'] % 8))
    elif ty == 'offcut': add(FX, swish(.4, 1, 400, 4000, .8), t, .35, -.2); add(FX, slap(.6), t + .45, .2, -.3)
    elif ty == 'flapswish': add(FX, swish(.25, 1, 900, 7000), t, .35, .3)
    elif ty == 'unfold': add(FX, snap(1), t, .6); log('unfold', t, 'foley:snap')
    elif ty == 'lift': add(FX, swish(.3, 1, 500, 4000), t, .2)
    elif ty == 'peel': add(FX, peelS(.6, 1), t, .5, .5); log('peel', t, 'foley:peel')
    elif ty == 'settle': add(FX, tap(1), t, .35); add(FX, tap(.8), t + .07, .2)
    elif ty == 'gateup': add(FX, thud(1), t, .6); add(FX, swish(.5, 1, 300, 2500), t - .5, .25); log('gateup', t, 'foley:thud')
    elif ty == 'plaque': add(FX, fwoomp(.8, 1, 1100), t, .3); add(FX, shimmer(1.0), t, .12)
    elif ty == 'copy': add(FX, swish(.12, 1, 1500, 8000), t - .1, .2, .4 if e['i'] % 2 else -.4); add(FX, tap(.9, 1300), t, .3, .4 if e['i'] % 2 else -.4); log(f"copy{e['i']}", t, 'foley:flick')
    elif ty == 'launch': add(FX, splash(1), t - .08, .45); add(FX, whoosh(.55, 1, 300, 5000), t, .55); log('launch', t, 'foley:splash+whoosh')
    elif ty == 'burst': add(FX, snap(1, 70), t, .7); add(FX, fwoomp(1.4, 1, 800), t, .5); add(FX, shimmer(1.6), t, .2); log('burst', t, 'foley:snap')
    elif ty in ('unfold2', 'unfold3'): add(FX, snap(1), t, .5); log(ty, t, 'foley:snap')
    elif ty == 'fuin': add(FX, swish(.3, 1, 600, 5000), t - .3, .2); add(FX, tap(1), t, .4); log('fuin', t, 'foley:pat')
    elif ty == 'fufold': add(FX, swish(.45, 1, 700, 6000, .4), t - .5, .3); add(FX, tap(1.2), t, .35); log('fufold', t, 'foley:crease')
    elif ty == 'fusnip': add(FX, snip(1, True), t - SNIP_OFF, .5, .1); log('fusnip', t, 'foley:snip')
    elif ty == 'fuflapswish': add(FX, swish(.25, 1, 900, 7000), t, .3, -.2)
    elif ty == 'fuland': add(FX, snap(1), t, .55); add(FX, tap(1), t + .06, .45); add(FX, tap(.8), t + .14, .3); log('fuland', t, 'foley:snap+pat')
    elif ty == 'confetti': add(FX, flutter(e['dur']), t, .1); add(FX, crackers(e['dur'] - .3, 1), t + .2, .1, .6)

# ================= MIX =================
def room_ir(d=.9, damp=4000):
    n = int(d * SR); e = np.exp(-np.arange(n) / SR / (d / 6.9)); ir = np.stack([lp(rng.standard_normal(n), damp) * e, lp(rng.standard_normal(n), damp) * e], 1); ir[0] = 1; return ir / np.abs(ir).sum(0) * 5
def verb(x, ir, wet):
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1); return x * (1 - wet) + y * wet
music = MUS['pluck'] * .9 + MUS['zheng'] * .85 + MUS['winds'] * .8 + MUS['perc'] * 1.0 + MUS['sheng'] * .7
music = verb(music, room_ir(1.4), .22)
fx = verb(FX, room_ir(.5, 6000), .12)
# the silence: music, ambience and room all cut at the apex and come back only at the burst (60 ms ramps)
sil0, sil1 = apex, burst
tt = np.arange(N) / SR
gate_m = np.clip(1 - (tt - sil0) / .06, 0, 1) * (tt < sil1) + (tt >= sil1)
gate_m = np.where(tt < sil0, 1, gate_m)
gate_a = np.where((tt >= sil0) & (tt < sil1), np.clip(1 - (tt - sil0) / .25, .03, 1), 1)
mix = music * gate_m[:, None] + fx * np.where((tt >= sil0) & (tt < sil1), 0, 1)[:, None] + AMB * gate_a[:, None]
# tail fade over the last half second
fade = np.clip((DUR - tt) / .6, 0, 1); mix *= fade[:, None]
# pre-master to about −14 LUFS with peaks held under −2 dBFS, so the final two-pass loudnorm only trims (measured with ffmpeg ebur128)
import subprocess, re, tempfile
def lufs(x):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f: sf.write(f.name, x.astype(np.float32), SR)
    o = subprocess.run(['ffmpeg', '-nostats', '-i', f.name, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr; os.unlink(f.name)
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
for it in range(3):
    gdb = -14.3 - lufs(mix); mix = mix * 10 ** (gdb / 20)
    # true-peak limiting: limit a 4x oversampled copy, then bring it back to 48 kHz
    import soxr
    up = soxr.resample(mix, SR, SR * 4)
    pk = np.abs(up).max(1); from scipy.ndimage import maximum_filter1d, uniform_filter1d
    n = int(.004 * SR * 4); gl = np.minimum(1, .7 / np.maximum(maximum_filter1d(pk, 2 * n + 1), 1e-9)); gl = uniform_filter1d(gl, n)
    gl = np.minimum(gl, uniform_filter1d(np.minimum(1, .7 / np.maximum(maximum_filter1d(pk, 2 * n + 1), 1e-9)), 1))
    mix = soxr.resample(up * gl[:, None], SR * 4, SR)[:len(mix)]
    if abs(gdb) < .2: break
sf.write(os.path.join(OUT, 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
for k, v in MUS.items(): sf.write(os.path.join(OUT, f'stem_{k}.wav'), v, SR, subtype='PCM_16')
json.dump(sorted(CUELOG, key=lambda x: x['t']), open(os.path.join(OUT, 'cuelog.json'), 'w'), ensure_ascii=False, indent=0)
open(os.path.join(OUT, 'instruments.txt'), 'w').write('\n'.join(S.credits(['dan_tranh', 'erhu', 'flute', 'woodblock', 'gong2', 'frame_drum', 'bass_drum'])))
# silence check + low-end balance report
win = lambda a, b2: 20 * np.log10(np.sqrt(np.mean(mix[int(a * SR):int(b2 * SR)] ** 2)) + 1e-12)
spec = np.abs(np.fft.rfft(mix.mean(1))); fr = np.fft.rfftfreq(len(mix), 1 / SR)
lo_db = 10 * np.log10(spec[(fr > 20) & (fr < 120)].__pow__(2).sum() / spec[(fr >= 120) & (fr < 8000)].__pow__(2).sum())
print(f'mix.wav {DUR:.2f}s  peak {np.abs(mix).max():.3f}  rms(all) {win(0, DUR):.1f} dB  silence[{sil0+.1:.2f}-{sil1-.02:.2f}] {win(sil0 + .1, sil1 - .02):.1f} dB  burst {win(sil1, sil1 + .5):.1f} dB  low/rest {lo_db:.1f} dB')
