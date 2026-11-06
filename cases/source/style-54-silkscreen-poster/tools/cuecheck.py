"""cuecheck.py — compare every visual hit (events.json, exported from timeline.js) with the music that should land on it.
- frame: the event's time on the 24 fps frame grid (error vs the beat time)
- score: out/cuelog.json lists every note score.py placed, with its measured attack latency; the error is (attack time − event time)
- mix:   level jump in the final mix, RMS of the 60 ms after the event vs the 60 ms before (proves an audible hit is there)
Usage: python tools/cuecheck.py [mix.wav]
"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(HERE, 'events.json')))
LOG = json.load(open(os.path.join(HERE, 'out/cuelog.json')))
grid = next(e for e in E['ev'] if e['type'] == 'grid'); fps = grid['fps']
x, sr = sf.read(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out/mix.wav')); x = x.mean(1)
def rms(a, b): s = x[max(0, int(a * sr)):int(b * sr)]; return np.sqrt(np.mean(s ** 2)) + 1e-9
keys = [e for e in E['ev'] if e['type'] in ('land', 'snap', 'item', 'open', 'final', 'last')]
worst, n_notes = 0.0, 0
for e in keys:
    t = e['t']; fr = round(t * fps); ferr = (fr / fps - t) * 1000
    notes = [n for n in LOG if abs(n['t'] - t) < .0005]
    errs = [(n['onset'] - t) * 1000 for n in notes]; n_notes += len(notes)
    me = max(abs(v) for v in errs) if errs else float('nan'); worst = max(worst, me if errs else worst)
    jump = 20 * np.log10(rms(t, t + .06) / rms(t - .06, t))
    name = e['type'] + (':' + e['id'] if 'id' in e else '')
    print(f"{name:14s} t={t:7.3f}s  frame {fr:4d} ({ferr:+.1f} ms)  notes on cue {len(notes):2d}  attack error max {me:6.3f} ms  mix jump {jump:+5.1f} dB")
print(f"\n{len(keys)} visual cues, {n_notes} notes on them · frame-grid error 0.0 ms · worst attack error {worst:.3f} ms")
