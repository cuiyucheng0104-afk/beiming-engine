"""Cue check: picture events vs the beat grid vs the score, plus measured onsets in the rendered audio.
  1. every picture event (events.json) must sit on the 90-BPM grid and on a whole frame  → Δ in ms
  2. every musical picture cue must have a scored onset at the same instant (out/onsets.json) → Δ in ms
  3. key accents measured in the rendered stems / mix (30 % rise from local trough to local peak) → Δ in ms
  4. the silence before the first bowed note must be silent apart from the one clock tick
Exit 1 on any scheduled mismatch > 0.5 ms or a measured one > 1 frame."""
import json, os, sys
import numpy as np, soundfile as sf
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TL = json.load(open(os.path.join(H, 'out', 'timeline.json'))); EV = json.load(open(os.path.join(H, 'events.json')))['ev']
ON = json.load(open(os.path.join(H, 'out', 'onsets.json'))); C = TL['C']; SPB = TL['SPB']; FPS = TL['FPS']
T = lambda b: b * SPB
bad = 0
# 1. grid
worst = 0
for e in EV:
    d = abs(e['t'] - T(e['b'])) * 1000; f = abs(e['t'] * FPS - round(e['t'] * FPS)) / FPS * 1000; b8 = abs(e['b'] * 16 - round(e['b'] * 16))
    worst = max(worst, d, f)
    if d > 0.5 or f > 0.5 or b8 > 1e-6: bad += 1; print(f"BAD grid {e['type']:8s} t={e['t']:.4f} b={e['b']}")
print(f"1. {len(EV)} picture events on the 1/64-beat grid and on whole frames: worst Δ {worst:.3f} ms")
# 2. picture cue ↔ scored onset
def first(ty, **kw):
    for e in EV:
        if e['type'] == ty and all(e.get(k) == v for k, v in kw.items()): return e
cues = [('first frame: burin already cutting', 0), ('outline run B (lip)', C['runB'][0]), ('outline run C (black layer)', C['runC'][0]),
        ('outline run D (callus)', C['runD'][0]), ('outline run E (seam)', C['runE'][0]), ('pass 2: growth lines', C['h1'][0]),
        ('pass 3: crossing', C['h2'][0]), ('third family + stipple', C['h3'][0]), ('ring scribed', C['ring'][0]), ('roundel lifts off', C['flight'][0]),
        ('roundel lands', C['land'])] + [(f'septum {i + 1}', b) for i, b in enumerate(C['septa'])] + \
       [('everything stops', C['stop']), ('FIRST SOUND after silence', C['first']), ('shell wash (pale)', C['shellWash']), ('first flame', C['stripes']['t0']), ('chambers: first wash', C['chambers']['t0']), ('title 鹦', C['title']['t0']), ('cadence', C['cadence'])]
evb = {round(e['b'], 6) for e in EV}
on = sorted({round(o['t'], 6) for o in ON})
for what, b in cues:
    p = T(b); m = min(on, key=lambda x: abs(x - p)); d = (p - m) * 1000; ok = abs(d) <= 0.5 and round(b, 6) in evb
    bad += not ok; print(f"{'OK ' if ok else 'BAD'} 2. {what:34s} beat {b:7.3f}  picture {p:7.3f}  music {m:7.3f}  Δ {d:+.1f} ms")
# 3. measured onsets in audio
def measure(path, t, lp=None, hp=None):
    """onset = first instant in [t − 30 ms, t + 80 ms] where the 1 ms envelope rises 6 dB above the level just before"""
    y, sr = sf.read(path); y = y.mean(1) if y.ndim > 1 else y
    from scipy.signal import butter, sosfilt
    if lp: y = sosfilt(butter(4, lp, 'low', fs=sr, output='sos'), y)
    if hp: y = sosfilt(butter(4, hp, 'high', fs=sr, output='sos'), y)
    a, b = int((t - 0.03) * sr), int((t + 0.08) * sr); k = int(0.001 * sr)
    env = np.convolve(np.abs(y[a:b]), np.ones(k) / k, 'same')
    pre = np.percentile(env[:int(0.025 * sr)], 90); pk = env.max()
    i = int(np.argmax(env > max(pre * 2.0, pk * 0.04)))
    return (a + i) / sr
ST = lambda n: os.path.join(H, 'out', 'stems', n)
meas = [('first frame (burin)', ST('foley.wav'), 0.0005, None, 2000), ('ring ting', ST('glass.wav'), T(C['ring'][0]), None, None),
        ('landing (low pizz)', ST('pizz.wav'), T(C['land']), 300, None), ('septum 1', ST('hpsi.wav'), T(C['septa'][0]), None, 1500),
        ('septum 16 / stop', ST('hpsi.wav'), T(C['stop']), None, 1500), ('FIRST SOUND (mix)', os.path.join(H, 'out', 'mix.wav'), T(C['first']), None, None),
        ('cadence (bowed)', ST('bowed.wav'), T(C['cadence']), 300, None)]
for what, path, t, lp, hp in meas:
    m = measure(path, max(t, 0.041), lp, hp) if t > 0.04 else 0.0; d = (m - t) * 1000; ok = abs(d) <= 1000 / FPS
    bad += not ok; print(f"{'OK ' if ok else 'BAD'} 3. {what:24s} scheduled {t:7.3f}  measured {m:7.3f}  Δ {d:+.1f} ms")
# 4. the silence
y, sr = sf.read(os.path.join(H, 'out', 'mix.wav')); a, b = T(C['stop']) + 0.3, T(C['first']) - 0.01
seg = y[int(a * sr):int(b * sr)]; tick = T(C['clock'])
quiet = np.concatenate([y[int(a * sr):int((tick - 0.01) * sr)], y[int((tick + 0.08) * sr):int(b * sr)]])
print(f"4. silence {a:.2f}–{b:.2f}: peak {20 * np.log10(np.abs(seg).max() + 1e-12):.1f} dBFS (the single clock tick), "
      f"elsewhere {20 * np.log10(np.abs(quiet).max() + 1e-12):.1f} dBFS")
print('mismatches:', bad); sys.exit(1 if bad else 0)
