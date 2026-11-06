"""Score, sound design and mix for 《火山口》 -> out/mix.wav (48 kHz stereo) + out/stems/ + out/score.json (music cues).

Reads timeline.json (exported from timeline.js) and events.json (the page's window.EV).

  palette   granular synthesis: a grain cloud cut from real sampled vibraphone / glockenspiel / marimba notes,
            its density following the points as they arrive; a low pulse bass with audible 2nd/3rd harmonics;
            FM "嘀" scan blips; ticks dividing 8ths -> 16ths -> 32nds; low-passed detuned-saw pad;
            weight: sampled bass drum, gran cassa, timpani; reversed suspended cymbal into the condense;
            the one organic timbre once the surface exists: marimba + bowed vibraphone (sampled)
  beds      desert wind (the place's own air) at the start and the end; a thin air bed between; near silence b17-b20

usage: $LIB/.venv/bin/python mix.py
"""
import json, os, sys
import numpy as np
import soundfile as sf
import soxr
from scipy.signal import butter, sosfilt
from scipy.ndimage import uniform_filter1d, maximum_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import sfx as X

SR = X.SR
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
T = TL['T']; DUR = TL['dur']; BEAT = TL['beat']
def b(n): return n * BEAT
N = int((DUR + 1.5) * SR)
rng = np.random.default_rng(57); S.seed(57)
MUS, PUL, HIT, FX, BED, GRN = (np.zeros((N, 2)) for _ in range(6))
HITS = np.zeros((N, 2))      # the b12 / b16 impacts: get a -3 dB low shelf below 120 Hz so b20 stays the heaviest
PB = 10 ** (-2 / 20)          # pulse bass trimmed 2 dB under the dive (b4-b12)
CUES = []          # (t, what) every musical event a picture cue should land on, for cuecheck.py


def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lpf(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x, axis=0)
def hpf(x, f, o=2): return sosfilt(sos('high', f, o), x, axis=0)
def bpf(x, a, c, o=2): return sosfilt(sos('band', [a, min(c, SR * .45)], o), x, axis=0)
def tv(d): return np.arange(int(round(d * SR))) / SR
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
mi = S.midi
def put(buf, x, at, g=1.0, pan=0.0):
    x = np.asarray(x, np.float64)
    if x.ndim == 2:
        s = int(round(at * SR))
        if s >= len(buf): return
        if s < 0: x = x[-s:]; s = 0
        e = min(len(buf), s + len(x)); buf[s:e] += x[:e - s] * g
    else:
        X.add(buf, x, at, g, pan)
def adsr(d, a=.005, r=.1):
    n = int(round(d * SR)); e = np.ones(n)
    na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    nr = min(n, int(r * SR)); e[n - nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e
def saw(f, d, det=0.0, nh=30):
    t = tv(d); x = np.zeros_like(t)
    for k in range(1, nh):
        if f * k > 12000: break
        x += np.sin(2 * np.pi * f * (1 + det) * k * t) / k
    return x * .55
def fm(fc, ratio, index, d, tau_i=.15):
    t = tv(d); I = index * np.exp(-t / tau_i)
    return np.sin(2 * np.pi * fc * t + I * np.sin(2 * np.pi * fc * ratio * t))
def stereo(x, w=.0006):
    dd = int(w * SR); return np.stack([x, np.concatenate([np.zeros(dd), x[:-dd]]) if dd else x], 1)
def di(m, vel=.5, d=.16):
    """the scan '嘀': a short bright FM blip"""
    return fm(hz(m), 2.0, 1.8, d, .025) * np.exp(-tv(d) / .045) * vel
def ping(m, vel=.6, d=1.6):
    t = tv(d); f = hz(m)
    return (fm(f, 3.5, 2.4, d, .05) * np.exp(-t / .55) + .3 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / .3)) * vel
def bass(m, d, vel=.8, cut=700):
    f = hz(m); x = saw(f, d, nh=12) * .7 + np.sin(2 * np.pi * f * tv(d)) * .9
    x = lpf(x, cut) + .35 * np.tanh(4 * lpf(x, 1400))          # audible 2nd / 3rd harmonics for small speakers
    return x * adsr(d, .008, min(.12, d * .45)) * vel * .8
def pad(ms, d, vel=.25, cut=1300, a=.5, r=.8):
    x = np.zeros(int(round(d * SR)))
    for m in ms:
        for det in (-.004, 0.0, .0045): x += saw(hz(m), d, det, nh=20)
    return lpf(x, cut, 2) * adsr(d, a, r) * vel / len(ms)
def sweep(d, f0, f1, vel=.4, q=.35):
    n = noise(d); t = tv(d); f = f0 * (f1 / f0) ** (t / d); out = np.zeros_like(n)
    for i in range(0, len(n), 256):
        j = min(len(n), i + 256); fc = f[i]
        out[i:j] = bpf(n[max(0, i - 1024):j], fc * (1 - q), fc * (1 + q))[-(j - i):]
    return out * np.sin(np.pi * t / d) ** 1.5 * vel
def noise(d): return rng.standard_normal(int(round(d * SR)))
def tick(v=.4):
    d = .03; t = tv(d)
    return (hpf(noise(d), 3500) * np.exp(-t / .002) + np.sin(2 * np.pi * 5200 * t) * np.exp(-t / .004) * .4) * v


# ---------------- beds ----------------
def beds():
    # desert wind: brown noise through slow-moving band filters, gusts from seeded LFOs
    d = DUR + 1.5; n = int(round(d * SR))
    w = np.cumsum(rng.standard_normal(n)); w = hpf(w - uniform_filter1d(w, SR // 2), 30)
    w /= np.abs(w).max()
    t = tv(d)
    gust = .55 + .45 * np.sin(2 * np.pi * .23 * t + 1.1) * np.sin(2 * np.pi * .11 * t + .3)
    hiss = bpf(rng.standard_normal(n), 900, 4200) * .25 * (.4 + .6 * gust)
    wind = lpf(w, 520) * gust + hiss
    env = np.ones(n)
    env *= 1 - .85 * np.clip((t - T['crane']) / (b(6) - T['crane']), 0, 1)          # fades to a trace under the dive
    env = np.where(t >= T['wind'], np.maximum(env, np.clip((t - T['wind']) / (b(1.2)), 0, 1)), env)   # L-cut: the place returns
    env = np.where((t >= T['sil']) & (t < T['wind']), 0.0, env)
    windst = np.stack([wind * env, np.roll(wind, 911) * env], 1)
    put(BED, windst, 0, .55)
    # thin air bed (always): very low, high-passed, the only thing in the silence
    air = hpf(rng.standard_normal(n), 2500) * .05 + lpf(rng.standard_normal(n), 300) * .04
    put(BED, np.stack([air, np.roll(air, 4801)], 1), 0, .3)


# ---------------- granular synthesis: grains cut from real sampled notes ----------------
SRC = {}
def src(inst, p):
    k = (inst, p)
    if k not in SRC: SRC[k] = S.note(inst, p, 1.2, vel=.7)
    return SRC[k]
GRAIN_PITCH = ['D5', 'E5', 'F5', 'A5', 'C6', 'D6', 'E6', 'A6']
def grains(t0, t1, dens0, dens1, vel=.18, pitches=GRAIN_PITCH, insts=('vibraphone_hard', 'glockenspiel', 'marimba'), gl=(.025, .07)):
    t = t0
    while t < t1:
        u = (t - t0) / max(1e-6, t1 - t0); dens = dens0 + (dens1 - dens0) * u
        inst = insts[int(rng.integers(len(insts)))]
        p = pitches[int(rng.integers(len(pitches)))]
        if inst == 'glockenspiel' and mi(p) < mi('G5'): p = 'A5'
        s = src(inst, p); L = int(rng.uniform(*gl) * SR); off = int(rng.uniform(.0, .25) * SR)
        g = s[off:off + L]
        if len(g) < 32: t += 1 / dens; continue
        g = g * np.hanning(len(g))
        put(GRN, g, t, vel * rng.uniform(.5, 1.0), rng.uniform(-.85, .85))
        t += rng.exponential(1 / dens)


# ---------------- score ----------------
def score():
    # 0 - b12: the pad (D dorian), opening its filter while the photo turns to points
    put(MUS, stereo(pad([mi('D3'), mi('A3'), mi('E4'), mi('F4')], b(8) + .4, .30, 700, 1.2, .5)), 0)
    put(MUS, stereo(pad([mi('Bb2'), mi('F3'), mi('D4'), mi('A4')], b(4) + .5, .30, 1100, .3, .6)), b(8))
    CUES.append((0, 'pad'))
    # scan: the '嘀' on 8ths across the scan, first one = the line entering, last = land
    seq = ['A5', 'D6', 'A5', 'E6', 'A5', 'D6', 'F6', 'E6']
    for k in range(8):
        tk = T['scan'] + k * BEAT / 2
        put(FX, stereo(di(mi(seq[k]), .38 + .04 * k)), tk, .8, -.4 + .1 * k)
    CUES.append((T['scan'], 'scan di'))
    put(MUS, ping(mi('D6'), .5, 1.8), T['scanEnd'], .8, .2); put(MUS, ping(mi('A6'), .3, 1.4), T['scanEnd'], .6, -.2)
    CUES.append((T['scanEnd'], 'land ping'))
    # grain cloud: density follows the arriving points, then the cloud being flown through
    grains(T['scan'], T['scanEnd'], 18, 90, .2)
    grains(T['scanEnd'], T['cond'], 40, 70, .13)
    grains(T['cond'], T['condEnd'] - .3, 60, 6, .10, pitches=['D5', 'A5', 'D6'])
    # pulse bass: quarters from bar 2, 8ths from bar 3; half-time roots under the condense
    CUES.append((T['crane'], 'pulse in'))
    for k in range(4):
        put(PUL, stereo(bass(mi('D2'), BEAT * .8, .75 * PB)), T['crane'] + k * BEAT)
    for k in range(8):
        put(PUL, stereo(bass(mi('D2') if k < 6 else mi('C2'), BEAT / 2 * .85, (.8 if k % 2 == 0 else .55) * PB)), b(8) + k * BEAT / 2)
    for t0, n, d in ((T['cond'], 'Bb1', 2), (b(14), 'C2', 2)):
        for k in range(d * 2):
            put(PUL, stereo(bass(mi(n), BEAT / 2 * .85, .75 if k % 2 == 0 else .5)), t0 + k * BEAT / 2)
    put(PUL, stereo(bass(mi('D2'), BEAT * .9, .8)), T['condEnd'])
    # ticks that divide: 8ths (bar 2), 16ths (bar 3), 32nds (last beat) -> the condense
    t = T['crane']
    while t < T['cond'] - 1e-6:
        step = BEAT / 2 if t < b(8) - 1e-6 else BEAT / 4 if t < b(11) - 1e-6 else BEAT / 8
        acc = abs(((t - T['crane']) / BEAT) % 1) < 1e-6
        put(FX, tick(.5 if acc else .32), t, .55, rng.uniform(-.5, .5)); t += step
    CUES.append((b(8), '16ths')); CUES.append((b(11), '32nds'))
    # reversed suspended cymbal swelling into the condense
    sc = S.hit('sus_cymbal', 'hit', .8)[:int(BEAT * 1.0 * SR)]
    sc = (sc * np.linspace(1, 0, len(sc)) ** .5)[::-1]
    put(FX, stereo(sc), T['cond'] - len(sc) / SR, .9)
    # the condense: impact; marimba enters (the organic timbre = the solid)
    put(HITS, S.hit('bass_drum', None, .9), T['cond'], .9)
    put(HITS, S.note('timpani', 'D2', 2.0, .85), T['cond'], .9)
    CUES.append((T['cond'], 'condense impact'))
    mar = []
    fig = ['D4', 'A4', 'C5', 'A4', 'F4', 'A4', 'D5', 'A4']   # b12-b14, half beats
    for k, p in enumerate(fig):
        mar.append((k * BEAT / 2, 'marimba', p, .4, .55 if k % 2 == 0 else .42, -.3 + .08 * k))
    # the traced crest: one rising note per lit segment
    for k, p in enumerate(['E5', 'G5', 'A5', 'D6']):
        mar.append((b(2) + k * BEAT / 2, 'marimba', p, .5, .62 + .03 * k, .2 + .1 * k))
        mar.append((b(2) + k * BEAT / 2, 'marimba', S.name(mi(p) - 12), .5, .35, -.2))
    put(MUS, S.render(mar, dur=b(4) + 2), T['cond'], .95)
    CUES.append((T['trace'], 'trace notes'))
    # landing chord at b16 (the solid complete), cut at b17 into the silence
    land = [(0, 'marimba', 'D3', .9, .7, -.3), (.03, 'marimba', 'A3', .9, .6, -.1), (.06, 'marimba', 'F4', .9, .6, .1), (.09, 'marimba', 'E5', .9, .55, .3),
            (0, 'vibraphone_bowed', 'A4', 1.0, .55, -.2), (0, 'vibraphone_bowed', 'E5', 1.0, .45, .2)]
    put(MUS, S.render(land, dur=2.0), T['condEnd'], .9)
    put(HITS, S.hit('gran_cassa', None, .45), T['condEnd'], .5)
    CUES.append((T['condEnd'], 'solid chord'))
    # ---- silence b17-b20 (handled in the mix) ----
    # b20 THE SECTION: the first sound after the silence, the heaviest in the film
    put(HIT, S.hit('gran_cassa', None, 1.0), T['cut'], 1.0)
    put(HIT, S.hit('bass_drum', None, 1.0), T['cut'], .9)
    put(HIT, S.note('timpani', 'D2', 2.6, 1.0), T['cut'], 1.0)
    put(MUS, ping(mi('D7'), .55, 2.2), T['cut'], .8, .1)
    sub = np.sin(2 * np.pi * np.cumsum(np.linspace(70, 38, int(1.2 * SR))) / SR) * np.exp(-tv(1.2) / .35)
    put(HIT, stereo(sub), T['cut'], .7)
    CUES.append((T['cut'], 'SECTION impact'))
    # the profile drawing: rising glide + 16th ticks, pad returns Bb -> C -> Dm
    d = T['cutDone'] - T['cut'] - BEAT / 2; tt = tv(d); f = 600 * (1800 / 600) ** (tt / d)
    put(FX, stereo(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d) ** .7 * .16), T['cut'] + BEAT / 2, .8)
    t = T['cut'] + BEAT / 2
    while t < T['cutDone'] - 1e-6:
        put(FX, tick(.3), t, .5, rng.uniform(-.4, .4)); t += BEAT / 4
    put(MUS, stereo(pad([mi('Bb2'), mi('F3'), mi('D4')], b(2) + .3, .26, 900, .4, .4)), T['cut'] + .05)
    put(MUS, stereo(pad([mi('C3'), mi('G3'), mi('E4')], b(2) + .3, .28, 1100, .2, .4)), T['roll'])
    for k in range(8):
        put(PUL, stereo(bass(mi('Bb1') if k < 4 else mi('C2'), BEAT / 2 * .85, .55 if k % 2 == 0 else .38)), T['cut'] + b(1) + k * BEAT / 2 if k < 4 else T['roll'] + (k - 4) * BEAT / 2)
    # b24 the reading lands: ping, marimba, bass resolves to D, bowed vibraphone holds to the end
    put(MUS, ping(mi('A6'), .55, 2.0), T['land'], .85, .25)
    put(MUS, S.render([(0, 'marimba', 'D4', 1.2, .7, -.2), (.0, 'marimba', 'A4', 1.2, .6, .1), (.0, 'marimba', 'D5', 1.2, .55, .3),
                       (b(1), 'marimba', 'E5', .6, .45, .3), (b(1.5), 'marimba', 'F5', .6, .42, .2), (b(2), 'marimba', 'A5', 1.4, .5, 0),
                       (0, 'vibraphone_bowed', 'D5', b(3) + .2, .5, -.2), (0, 'vibraphone_bowed', 'A5', b(3) + .2, .4, .2)], dur=b(3) + 1.5), T['land'], .95)
    put(HIT, S.note('timpani', 'D2', 2.0, .55), T['land'], .6)
    put(PUL, stereo(bass(mi('D2'), b(2.5), .7)), T['land'])
    put(MUS, stereo(pad([mi('D3'), mi('A3'), mi('E4'), mi('F4')], b(3) + .3, .26, 1300, .3, .8)), T['land'])
    CUES.append((T['land'], 'reading ping'))
    CUES.append((T['wind'], 'wind returns'))


# ---------------- foley from the page's events ----------------
def foley():
    for e in EV:
        t, ty = e['t'], e['type']
        if ty == 'scan':
            d = e['to'] - t
            put(FX, stereo(sweep(d, 500, 4200, .35, .45)), t, .55)
            n = int(d * 140)                                   # the photo turning into points: fine crackle, thickening
            for k in range(n):
                u = k / n
                if rng.random() < .35 + .65 * np.sin(np.pi * u): put(FX, X.click(rng.uniform(1.6, 3.2), .18), t + k / 140 + rng.uniform(0, .006), .16, rng.uniform(-.8, .8))
        elif ty == 'count':
            tk = t
            while tk < e['to']: put(FX, tick(.12), tk, .25, .6); tk += .045
        elif ty == 'crane':
            put(FX, stereo(lpf(sweep(b(4), 180, 900, .5, .5), 1500)), t, .45)
        elif ty == 'land':
            put(FX, X.thump(.45, 120), t, .3)
        elif ty == 'condense':
            d = e['to'] - t                                    # the front: a breathy hiss sweeping down as it widens
            put(FX, stereo(sweep(d, 5000, 900, .35, .3)), t, .5)
        elif ty == 'trace':
            put(FX, stereo(di(mi('D7'), .2, .1)), t, .5, .3)
        elif ty == 'label':
            put(FX, tick(.25), t, .4, .4)
        elif ty == 'solid':
            put(FX, X.thump(.6, 90), t, .35)
        elif ty == 'section':
            put(FX, stereo(hpf(noise(.35), 900) * np.exp(-tv(.35) / .07)), t, .45)       # the cut itself
            put(FX, stereo(sweep(e['to'] - t, 2600, 300, .3, .35)), t + .05, .45)        # the plane travelling
        elif ty == 'chart':
            d = e['to'] - t; n = bpf(noise(d), 2500, 7000) * (.5 + .5 * np.sin(2 * np.pi * 9 * tv(d)) ** 2) * np.sin(np.pi * tv(d) / d)
            put(FX, stereo(n * .12), t, .5)                                              # the pen of the profile line
        elif ty == 'roll':
            tk = t; k = 0
            while tk < e['to']:
                put(FX, X.click(2.4, .5), tk, .4, .25); k += 1
                tk += .028 + .06 * (tk - t) / (e['to'] - t) ** 1      # a ratchet that slows as it lands
        elif ty == 'reading':
            put(FX, X.thump(.4, 140), t, .3)
        elif ty == 'pullback':
            put(FX, stereo(lpf(sweep(e['to'] - t + .3, 900, 200, .5, .5), 1200)), t, .4)


def lufs(x):
    import subprocess, tempfile, re
    f = os.path.join(tempfile.mkdtemp(), 'm.wav'); sf.write(f, x.astype(np.float32), SR)
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])
def true_peak(x): return float(np.abs(soxr.resample(x, SR, 4 * SR)).max())
def tp_limit(x, ceil):
    up = np.abs(soxr.resample(x, SR, 4 * SR)).max(1); n = len(x)
    pk = np.pad(up, (0, max(0, n * 4 - len(up))))[:n * 4].reshape(-1, 4).max(1)
    g0 = np.minimum(1.0, ceil / np.maximum(pk, 1e-9)); look = int(.004 * SR)
    g = -maximum_filter1d(-g0, 2 * look + 1); g = uniform_filter1d(g, look); g = np.minimum(g, -maximum_filter1d(-g0, 3))
    return x * g[:, None]


def main():
    beds(); score(); grains_done = True; foley()
    HIT[:] += HITS - (1 - 10 ** (-3 / 20)) * lpf(HITS, 120, 2)   # low shelf -3 dB < 120 Hz on the b12 / b16 impacts only
    mus = S.room(MUS, .55, .22); grn = S.room(GRN, .7, .35); pul = S.room(PUL, .3, .1); hit = S.room(HIT, .7, .25); fx = S.room(FX, .35, .12); bed = BED.copy()
    # near silence b17 -> b20: music, grains, pulse and foley out; only the air bed remains
    a, c = int((T['sil']) * SR), int(T['cut'] * SR); f = int(.18 * SR)
    for buf in (mus, grn, pul, fx, hit):
        buf[a:a + f] *= (np.linspace(1, 0, f) ** 2)[:, None]; buf[a + f:c] *= 0
    g_mus, g_grn, g_pul, g_hit, g_fx, g_bed = .45, 2.4, .10, .55, .45, .45
    stems = {'music': mus * g_mus, 'grains': grn * g_grn, 'pulse': pul * g_pul, 'hits': hit * g_hit, 'fx': fx * g_fx, 'beds': bed * g_bed}
    shelf = 10 ** (-7 / 20)
    for k in stems:
        x = hpf(stems[k], 44 if k == 'hits' else 36, 4 if k == 'hits' else 2)
        stems[k] = x - (1 - shelf) * lpf(x, 60, 2)
    bus = stems['music'] + stems['grains'] + stems['pulse'] + stems['fx'] + stems['beds']
    lvl = np.sqrt(uniform_filter1d((bus ** 2).max(1), int(.012 * SR)))
    thr = 10 ** (-10 / 20) * np.percentile(lvl, 99.9)
    g = np.where(lvl > thr, (thr + (lvl - thr) / 2.5) / np.maximum(lvl, 1e-9), 1.0)
    g = uniform_filter1d(-maximum_filter1d(-g, int(.008 * SR)), int(.03 * SR))
    mix = bus * g[:, None] + stems['hits']                   # impacts outside the bus compressor
    mix = mix[:int(round(DUR * SR))]
    fade = int(.35 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    for _ in range(3):
        I = lufs(mix); mix = mix * 10 ** ((-14.3 - I) / 20); mix = tp_limit(mix, 10 ** (-3.0 / 20))
    print(f'master: {lufs(mix):.2f} LUFS, true peak {20 * np.log10(true_peak(mix)):.2f} dBTP')
    os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
    sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR)
    for name, bb in stems.items():
        sf.write(os.path.join(HERE, 'out/stems', name + '.wav'), bb[:int(round(DUR * SR))].astype(np.float32), SR)
    json.dump([{'t': round(t, 6), 'what': w} for t, w in CUES], open(os.path.join(HERE, 'out/score.json'), 'w'), indent=1)
    from numpy.fft import rfft, rfftfreq
    m = mix.mean(1); Fq = rfftfreq(len(m), 1 / SR); P = np.abs(rfft(m)) ** 2
    lo = P[(Fq > 20) & (Fq < 120)].sum(); rest = P[(Fq >= 120) & (Fq < 16000)].sum()
    rms = lambda s, e: 20 * np.log10(np.sqrt((mix[int(s * SR):int(e * SR)] ** 2).mean()) + 1e-12)
    print(f'low/rest {10 * np.log10(lo / rest):.1f} dB  | silence b17.3-b20 {rms(T["sil"] + .25, T["cut"] - .01):.1f} dBFS  '
          f'| before {rms(T["cond"], T["sil"]):.1f}  | impact b20 +0.5s {rms(T["cut"], T["cut"] + .5):.1f}  | max 0.5s window elsewhere '
          f'{max(rms(s, s + .5) for s in np.arange(0, DUR - .5, .1) if abs(s - T["cut"]) > .3):.1f}')


if __name__ == '__main__':
    main()
