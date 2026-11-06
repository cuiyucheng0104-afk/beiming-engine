"""Score, foley and beds for 《涨潮一米》 -> out/mix.wav + out/stems/*.wav
usage (from the library root): .venv/bin/python <film>/mix.py
Reads timeline.json (beats, level keys, ticks) and events.json (window.EV from the page: every hour, tick, pick-out).
88 BPM, beat 0.682 s, D minor (Dorian colour).
Palette (STYLE §7): the room (room tone, projector fan, relays, lamp strike, air of the light wash), light as sound
(vibraphone for the sun's hours, bowed vibraphone for held light, glass / glockenspiel per picked-out building,
a rising marimba line for the level), a woodblock metronome that doubles as the water climbs, contrabass as the floor
(arco pedal + a pizzicato line walking up with the water), weight at the hit (gong, timpani, gran cassa, tuba, trombones).
Water itself is synthesised (lapping noise + bubbles), louder as the level rises."""
import os, sys, json
import numpy as np, soundfile as sf, soxr
from scipy.signal import butter, sosfilt
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import sfx as X
SR = X.SR
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
T = TL['T']; BEAT = TL['beat']; DUR = EVJ['dur']; EV = EVJ['ev']
N = int((DUR + 3) * SR)
MUS, HIT, FX, BED = (np.zeros((N, 2), np.float32) for _ in range(4))
S.seed(58)
rng = np.random.default_rng(58)

def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lpf(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x, axis=0)
def hpf(x, f, o=2): return sosfilt(sos('high', f, o), x, axis=0)
def bpf(x, a, b, o=2): return sosfilt(sos('band', [a, min(b, SR * .45)], o), x, axis=0)
def tv(d): return np.arange(int(d * SR)) / SR
def b(n): return n * BEAT
def put(buf, x, at, g=1.0, pan=0.0):
    if x.ndim == 1: X.add(buf, x.astype(np.float32), at, g, pan)
    else:
        s = int(round(at * SR)); e = min(len(buf), s + len(x))
        if s < len(buf): buf[s:e] += x[:e - s] * g
def place(buf, events, g=1.0):
    y = S.render(events, dur=N / SR, master=False); buf[:len(y)] += y[:len(buf)] * g

# level of the water (m above MHHW) at time t, the same monotone keys as the page (piecewise-cubic is close enough
# for a loudness envelope; the visual events themselves come from events.json)
LK = np.array(TL['LEVEL'])
def level(t): return np.interp(t, LK[:, 0], LK[:, 1], left=0, right=1)

# ------------------------------------------------------------------ synth helpers
def hum(d, f0=112):
    t = tv(d); x = sum(np.sin(2 * np.pi * f0 * k * t + k) / k ** 1.4 for k in range(1, 6)) * .25
    air = bpf(rng.standard_normal(len(t)), 300, 2600) * .5
    return x * .35 + air
def spinup(d=.75):
    """the fan coming up to speed: a rising whirr"""
    t = tv(d); f = 30 + 82 * (t / d) ** .7
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .3 + bpf(rng.standard_normal(len(t)), 250, 1800) * .6
    return x * (t / d) ** 1.3
def room_tone(d):
    t = tv(d); x = lpf(np.cumsum(rng.standard_normal(len(t))) * .002, 260, 2); x -= lpf(x, 20)
    return x / (np.abs(x).max() + 1e-9)
def relay(v=1.0):
    a = X.clack(.7, v); c = X.thump(.6 * v, 55)
    n = max(len(a), len(c)); y = np.zeros(n); y[:len(a)] += a; y[:len(c)] += c * .8
    return y
def zap(d=.08, v=1.0):
    t = tv(d); return hpf(rng.standard_normal(len(t)), 2500) * np.exp(-t / .01) * v
def lamp(v=1.0):
    t = tv(1.4)
    z = hpf(rng.standard_normal(len(t)), 2500) * np.exp(-t / .012) * .6
    whump = np.sin(2 * np.pi * (52 + 30 * np.exp(-t / .05)) * t) * np.exp(-t / .35)
    buzz = np.sin(2 * np.pi * 100 * t) * (1 - np.exp(-t / .08)) * np.exp(-t / .5) * .12
    return (z + whump + buzz) * v
def swell(d, f0, f1, v=1.0, q=.5):
    """air of a light wash: band noise whose centre slides f0 -> f1"""
    t = tv(d); x = rng.standard_normal(len(t)); out = np.zeros_like(x); seg_ = 2048
    for i in range(0, len(x), seg_):
        k = i / len(x); fc = f0 * (f1 / f0) ** k
        out[i:i + seg_] = bpf(x[max(0, i - 512):i + seg_], fc * (1 - q / 2), fc * (1 + q / 2))[-len(x[i:i + seg_]):]
    e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 1.5
    return out * e * v
def riser(d, v=1.0):
    t = tv(d); return swell(d, 300, 5000, 1.0, .35) * (t / d) ** 1.6 * v
def water(d):
    """lapping water: low noise with a slow, uneven swell + small bubbles"""
    t = tv(d); n = rng.standard_normal(len(t))
    lap = lpf(n, 700, 2) * (.55 + .45 * np.sin(2 * np.pi * .9 * t + 1.3 * np.sin(2 * np.pi * .23 * t)))
    hiss = bpf(n, 1500, 5000) * .12 * (.5 + .5 * np.sin(2 * np.pi * .7 * t + 2))
    out = lap + hiss
    for _ in range(int(d * 9)):
        at = rng.uniform(0, d - .1); f = rng.uniform(500, 1500); dd = rng.uniform(.02, .06)
        tt = tv(dd); bub = np.sin(2 * np.pi * np.cumsum(f * (1 + 1.6 * tt / dd)) / SR) * np.exp(-tt / (dd / 3)) * rng.uniform(.15, .45)
        i = int(at * SR); out[i:i + len(bub)] += bub
    return out / (np.abs(out).max() + 1e-9)
def pour(d=1.4, v=1.0):
    """water topping the edge: a rushing band of noise that falls in pitch and spreads"""
    t = tv(d); x = swell(d, 2600, 500, 1.0, .9) + lpf(rng.standard_normal(len(t)), 500) * .8 * np.sin(np.pi * np.clip(t / d, 0, 1))
    return x * np.minimum(1, t / .06) * v
def punch(vel=1.0, d=.9):
    t = tv(d); f = 95 * np.exp(-t / .09) + 58
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .24) * vel

# ------------------------------------------------------------------ score
def score():
    m, h = [], []
    # A (0–b2): the white model; one held bowed tone, cut by the relay
    m += [dict(t=.05, inst='vibraphone_bowed', pitch='D5', dur=T['houseOff'] - .05, vel=.42, pan=-.15, attack=.25, release=.12),
          dict(t=b(1), inst='vibraphone_bowed', pitch='A4', dur=T['houseOff'] - b(1), vel=.3, pan=.25, attack=.25, release=.12),
          dict(t=.0, inst='vibraphone', pitch='D5', dur=1.2, vel=.45, pan=-.15)]
    # B (b4–b12): the sun clock. Floor in D minor -> Bb -> C; one vibraphone note per beat, pitch = sun altitude
    L, SS = T['lamp'], T['sunset']
    for inst, p, a, z, v, pn in (('contrabass', 'D2', b(4), b(8), .55, 0), ('cellos', 'A2', b(4), b(8), .42, -.25),
                                 ('contrabass', 'Bb1', b(8), b(10), .55, 0), ('cellos', 'F3', b(8), b(10), .36, -.25),
                                 ('contrabass', 'C2', b(10), b(12), .55, 0), ('cellos', 'G3', b(10), b(12), .36, -.25)):
        m.append(dict(t=a, inst=inst, pitch=p, dur=z - a + .05, vel=v, pan=pn, attack=.18, release=.25))
    scale = ['D4', 'E4', 'F4', 'G4', 'A4', 'C5', 'D5', 'E5', 'F5']
    hours = [(L, 0.0)] + [(e['t'], e['el']) for e in EV if e['type'] == 'hour']
    for i, (t0, el) in enumerate(hours):
        p = scale[int(round(max(el, 0) / 76 * (len(scale) - 1)))]
        m.append(dict(t=t0, inst='vibraphone', pitch=p, dur=1.0, vel=.5 + .1 * (el > 60), pan=-.5 + i / 7))
        m.append(dict(t=t0, inst='marimba', pitch=p.replace('5', '4') if '5' in p else p.replace('4', '3'), dur=.4, vel=.32, pan=.4 - i / 9))
    m += [dict(t=b(8), inst='vibraphone_bowed', pitch='F5', dur=b(3), vel=.32, pan=.3, attack=.5, release=.3),
          dict(t=b(8), inst='hand_chimes', pitch='A5', dur=1.5, vel=.42, pan=-.2)]
    for k in range(16):                      # a quiet marimba pulse in 8ths keeps the clock walking
        pair = ['D3', 'A3'] if k < 8 else ['Bb2', 'F3'] if k < 12 else ['C3', 'G3']
        m.append(dict(t=b(4) + k * BEAT / 2, inst='marimba', pitch=pair[k % 2], dur=.25, vel=.26, pan=-.3 + .6 * (k % 2)))
    # C (b12–b19): the rising level. Arco pedal swelling, pizzicato walking up a step a beat, marimba climbing,
    # woodblock metronome quarters -> 8ths -> 16ths (from events), a glass note for each pick-out slot
    TOP = T['top']
    m.append(dict(t=SS, inst='contrabass', pitch='D2', dur=TOP - SS, vel=.62, pan=0, attack=1.2, release=.03))
    m.append(dict(t=SS, inst='cellos', pitch='D3', dur=TOP - SS, vel=.38, pan=-.2, attack=2.0, release=.03))
    walk = ['D2', 'E2', 'F2', 'G2', 'A2', 'Bb2', 'C3']
    for k, p in enumerate(walk):
        m.append(dict(t=b(12 + k), inst='contrabass_pizz', pitch=p, dur=.6, vel=.7 + .03 * k, pan=.1))
    m.append(dict(t=b(18.5), inst='contrabass_pizz', pitch='D3', dur=.4, vel=.8, pan=.1))
    climb = ['D4', 'F4', 'A4', 'C5', 'D5', 'E5', 'F5', 'A5']
    n8 = int(round((T['tick16'] - SS) / (BEAT / 2)))
    for k in range(n8):
        m.append(dict(t=SS + k * BEAT / 2, inst='marimba', pitch=climb[min(7, k * 8 // (n8 + 4))], dur=.25, vel=.34 + .15 * k / n8, pan=-.35 + .7 * ((k * 3) % 5) / 4))
    for k in range(8):
        m.append(dict(t=T['tick16'] + k * BEAT / 4, inst='marimba', pitch=['D5', 'E5', 'F5', 'A5', 'C6', 'D6', 'E6', 'F6'][k], dur=.2, vel=.5 + .04 * k, pan=-.3 + .08 * k))
    for e in EV:
        if e['type'] == 'tick':
            v = {1: .55, 2: .62, 4: .7}[e['div']]
            m.append(dict(t=e['t'], inst='woodblock', pitch='a' if e['div'] < 4 else 'b', vel=v, pan=.35))
    picks = ['G5', 'A5', 'C6', 'D6', 'E6', 'F6', 'G6', 'A6', 'C7', 'D7', 'E7', 'G7', 'A7', 'C8']
    k = 0
    for e in EV:
        if e['type'] != 'pick': continue
        if not e['cascade']:
            m.append(dict(t=e['t'], inst='glass', pitch='A5', dur=1.2, vel=.55, pan=-.3)); continue
        p = picks[min(k, len(picks) - 1)]; k += 1
        inst = 'glass' if p in ('G5', 'A5', 'C6', 'D6', 'E6', 'F6') else 'glockenspiel'
        vel = min(.85, .42 + .012 * e['n'])
        m.append(dict(t=e['t'], inst=inst, pitch=p, dur=.9, vel=vel, pan=-.6 + 1.2 * k / 14))
    # the traced shadow at b10: a glass note on the trace, the measure lands with a soft hand-chime fifth
    m += [dict(t=T['trace'], inst='glass', pitch='E6', dur=1.0, vel=.42, pan=.3),
          dict(t=T['measure'], inst='hand_chimes', pitch='A5', dur=1.0, vel=.34, pan=.35)]
    # D (b21–): the hit. D minor in the low brass, gong, timpani, gran cassa; the pick-out's glass cluster on top
    HT = T['hit']
    h += [dict(t=HT, inst='gong', pitch=None, vel=.85, pan=.05), dict(t=HT, inst='timpani', pitch='D3', dur=3, vel=1.0, pan=0),
          dict(t=HT, inst='gran_cassa', pitch='hit', vel=.95, pan=0), dict(t=HT + .005, inst='bass_drum', pitch=None, vel=.9, pan=0)]
    for p, inst, v, pn in (('D2', 'tuba', .9, 0), ('D3', 'trombone', .85, -.2), ('A3', 'trombone', .8, .2), ('F3', 'trombone', .75, 0)):
        h.append(dict(t=HT, inst=inst, pitch=p, dur=b(4) - .1, vel=v, pan=pn, attack=.02, release=.9))
    h += [dict(t=HT, inst='glass', pitch='D6', dur=2.5, vel=.7, pan=-.25), dict(t=HT, inst='glockenspiel', pitch='A6', dur=2.5, vel=.6, pan=.25)]
    m += [dict(t=HT + .2, inst='contrabass', pitch='D2', dur=b(4), vel=.55, attack=.5, release=.3),
          dict(t=HT + .3, inst='cellos', pitch='A2', dur=b(4), vel=.36, pan=-.25, attack=.8, release=.3),
          dict(t=HT + .4, inst='vibraphone_bowed', pitch='F5', dur=b(4), vel=.34, pan=.3, attack=.6, release=.3)]
    LN = T['line2']
    m += [dict(t=LN, inst='marimba', pitch='D4', dur=.6, vel=.45, pan=-.2), dict(t=LN, inst='marimba', pitch='A4', dur=.6, vel=.42, pan=.2)]
    CR = T['crest']
    for p, inst, v, pn in (('Bb1', 'tuba', .6, 0), ('Bb2', 'trombone', .55, -.2), ('F3', 'trombone', .5, .2), ('D3', 'trombone', .5, 0)):
        m.append(dict(t=CR, inst=inst, pitch=p, dur=b(2) + .05, vel=v, pan=pn, attack=.25, release=.4))
    m += [dict(t=CR, inst='contrabass', pitch='Bb1', dur=b(2), vel=.5, attack=.3, release=.3),
          dict(t=CR, inst='vibraphone_bowed', pitch='D5', dur=b(2), vel=.32, pan=-.3, attack=.5, release=.3)]
    CO = T['coda']
    for p, inst, v, pn in (('D2', 'tuba', .5, 0), ('A2', 'trombone', .45, -.2), ('F3', 'trombone', .42, .2)):
        m.append(dict(t=CO, inst=inst, pitch=p, dur=DUR - CO + .4, vel=v, pan=pn, attack=.4, release=1.0))
    m += [dict(t=CO, inst='contrabass', pitch='D2', dur=DUR - CO + .4, vel=.48, attack=.4, release=1.0),
          dict(t=CO, inst='vibraphone', pitch='D5', dur=2.5, vel=.5, pan=-.15),                        # the opening note returns
          dict(t=CO, inst='vibraphone_bowed', pitch='D5', dur=DUR - CO + .3, vel=.36, pan=-.15, attack=.4, release=.6),
          dict(t=CO + BEAT, inst='vibraphone_bowed', pitch='A4', dur=DUR - CO - BEAT + .3, vel=.28, pan=.25, attack=.4, release=.6)]
    place(MUS, m); place(HIT, h)

# ------------------------------------------------------------------ foley and beds
def foley():
    D2 = DUR + 2; t = tv(D2)
    put(BED, np.stack([room_tone(D2), room_tone(D2)], 1) * .45, 0)
    fan = hum(D2)
    lvl = np.clip((t - T['fan']) / (T['lamp'] - T['fan']), 0, 1) * .8 + .2 * np.clip((t - T['lamp']) / .3, 0, 1)
    lvl = lvl * np.where(t < T['top'], 1, np.where(t < T['hit'], .14, .6))
    put(BED, fan * lvl[:len(fan)], 0, .45, -.15)
    wat = water(D2); lv = level(t)
    wl = np.where(t < T['sunset'], 0, .25 + .75 * lv) * np.clip((t - T['sunset']) / .5, 0, 1)
    wl = np.where(t < T['top'], wl, np.where(t < T['hit'], .015, .28))
    put(BED, np.stack([wat * wl, np.roll(wat, 4800) * wl], 1), 0, .55)
    for e in EV:
        ty, t0 = e['type'], e['t']
        if ty == 'relay': put(FX, relay(1.0), t0, .9, -.3)
        elif ty == 'fan': put(FX, spinup(T['lamp'] - t0), t0, .55, -.1)
        elif ty == 'flick': put(FX, zap(.06, .5), t0, .6, .1)
        elif ty == 'lamp': put(FX, lamp(1.0), t0, .95, .1)
        elif ty == 'readout': put(FX, X.click(1.4, .6), t0, .35, -.4)
        elif ty == 'hour': put(FX, X.click(.9 + .05 * e['k'], .35), t0, .25, -.45)
        elif ty == 'sunset': put(FX, swell(BEAT * 1.6 + .5, 350, 2400, .9, .6), t0 - .1, .6, 0)
        elif ty == 'sill': put(FX, pour(T['top'] - t0, 1.0), t0, .7, .2)
        elif ty == 'pin': put(FX, X.click(1.7, .55), t0, .35, .3)
        elif ty == 'trace':
            # the projector draws the shadow: a short bright air stroke + one tick per 10 m as the measured line grows
            put(FX, swell(.42, 900, 3800, .8, .5), t0, .38, .25)
            L = e['L']; dt = T['measure'] - t0
            for mm in range(10, int(L) + 1, 10):
                k = 1 - (1 - mm / L) ** (1 / 3)                 # the line grows with ease-out: eo(k) * L = mm
                put(FX, X.click(1.9 + .1 * mm / L, .3), t0 + k * dt, .22, .3)
        elif ty == 'measure': put(FX, X.click(1.5, .65), t0, .4, .3)
        elif ty == 'top': put(FX, X.clack(.45, .5), t0, .45, .2)
        elif ty == 'land': put(FX, X.click(1.2, .7), t0, .4, -.4)
    put(FX, riser(T['top'] - T['tick16'], 1.0), T['tick16'], .55, 0)
    put(HIT, punch(1.0), T['hit'], .9, 0)

# ------------------------------------------------------------------ mix and master
def rms(x): return float(np.sqrt(np.mean(x ** 2) + 1e-12))
def lufs(x):
    import subprocess, tempfile, re
    f = os.path.join(tempfile.mkdtemp(), 'm.wav'); sf.write(f, x.astype(np.float32), SR)
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1])
def true_peak(x): return float(np.abs(soxr.resample(x, SR, 4 * SR)).max())
def tp_limit(x, ceil):
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    up = np.abs(soxr.resample(x, SR, 4 * SR)).max(1); n = len(x)
    pk = np.pad(up, (0, max(0, n * 4 - len(up))))[:n * 4].reshape(-1, 4).max(1)
    g0 = np.minimum(1.0, ceil / np.maximum(pk, 1e-9)); look = int(.004 * SR)
    g = -maximum_filter1d(-g0, 2 * look + 1); g = uniform_filter1d(g, look); g = np.minimum(g, -maximum_filter1d(-g0, 3))
    return x * g[:, None]

def main():
    score(); foley()
    from scipy.ndimage import uniform_filter1d, maximum_filter1d
    mus = S.room(MUS, .55, .22); hit = S.room(HIT, .75, .28); fx = S.room(FX, .35, .12); bed = BED.copy()
    # the stop at +1.00 m: music and foley cut in 30 ms, only a thin fan hum and a whisper of water remain
    def gate(a, b_, floor, f=.03):
        g = np.ones(N); i0, i1 = int(a * SR), int(b_ * SR); k = int(f * SR)
        g[i0:i0 + k] = np.linspace(1, floor, k); g[i0 + k:i1] = floor; return g[:, None]
    TOP, HT = T['top'], T['hit']
    mus *= gate(TOP + .01, HT - .002, 0.); fx *= gate(TOP + .25, HT - .002, 0., .1); bed *= gate(TOP + .05, HT - .002, .45, .15)
    # the room's whoosh just before the hit is removed too: the first sound after the stop is the hit
    stems = {'music': mus * .42, 'hits': hit * .95, 'fx': fx * .55, 'beds': bed * .3}
    shelf = 10 ** (-4 / 20)
    for k in stems:
        x = hpf(stems[k], 46 if k == 'hits' else 36, 4 if k == 'hits' else 2)
        stems[k] = x - (1 - shelf) * lpf(x, 62, 2)
    bus = stems['music'] + stems['fx'] + stems['beds']
    lvl = np.sqrt(uniform_filter1d((bus ** 2).max(1), int(.012 * SR)))
    thr = 10 ** (-12 / 20) * np.percentile(lvl, 99.9)
    g = np.where(lvl > thr, (thr + (lvl - thr) / 2.5) / np.maximum(lvl, 1e-9), 1.0)
    g = uniform_filter1d(-maximum_filter1d(-g, int(.008 * SR)), int(.03 * SR))
    mix = bus * g[:, None] + stems['hits']
    mix = mix[:int(DUR * SR)]
    fade = int(.6 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    for _ in range(3):
        I = lufs(mix); mix = mix * 10 ** ((-14.2 - I) / 20); mix = tp_limit(mix, 10 ** (-2.5 / 20))
    print(f'master: {lufs(mix):.2f} LUFS, true peak {20 * np.log10(true_peak(mix)):.2f} dBTP')
    os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
    sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR)
    for name, b_ in stems.items(): sf.write(os.path.join(HERE, 'out/stems', name + '.wav'), b_[:int(DUR * SR)].astype(np.float32), SR)
    m = mix.mean(1); Fq = np.fft.rfftfreq(len(m), 1 / SR); P = np.abs(np.fft.rfft(m)) ** 2
    lo = P[(Fq > 20) & (Fq < 120)].sum(); rest = P[(Fq >= 120) & (Fq < 16000)].sum()
    print(f'low/rest {10 * np.log10(lo / rest):.1f} dB')
    # loudness shape: momentary (400 ms) peak around the hit vs the rest, and the near-silence before it
    win = int(.4 * SR); e = np.sqrt(uniform_filter1d((mix ** 2).mean(1), win) + 1e-12); db = 20 * np.log10(e)
    def at(a, z): return db[int(a * SR):int(z * SR)]
    print(f'hit max {at(HT, HT + .6).max():.1f} dBFS, loudest elsewhere {max(at(0, HT - .1).max(), at(HT + 1.5, DUR).max()):.1f}, '
          f'silence {np.median(at(TOP + .45, HT - .05)):.1f}, median program {np.median(db):.1f}')

if __name__ == '__main__':
    main()
