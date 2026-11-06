"""Loudness profile of out/mix.wav: momentary level every 0.25 s, the silence depth, the impact ranking, sub-bass share.
usage: python -I tools/audiocheck.py <film_dir>"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
D = sys.argv[1]
x, sr = sf.read(os.path.join(D, 'out/mix.wav')); m = x.mean(1)
T = json.load(open(os.path.join(D, 'timeline.json')))['T']
def db(v): return 20 * np.log10(max(v, 1e-9))
win = int(.4 * sr); hop = int(.25 * sr)
lv = [(i / sr, db(np.sqrt(np.mean(m[i:i + win] ** 2)))) for i in range(0, len(m) - win, hop)]
top = max(v for _, v in lv)
print(' '.join(f'{t:4.1f}:{v - top:5.1f}' for t, v in lv))
def lvl(a, b): s = m[int(a * sr):int(b * sr)]; return db(np.sqrt(np.mean(s ** 2)))
full = lvl(0, len(m) / sr)
print('silence %.1f dB under program' % (lvl(T['sil0'] + .3, T['turn'] - .05) - full))
for k in ('y2026', 'rangeEnd', 'turn', 'lock', 'tear'):
    print('%-9s peak400ms %.1f dB (rel. program)' % (k, lvl(T[k], T[k] + .4) - full))
P = np.abs(np.fft.rfft(m)) ** 2; f = np.fft.rfftfreq(len(m), 1 / sr)
print('20-60 Hz share %.1f dB (FFT power)' % (10 * np.log10(P[(f >= 20) & (f < 60)].sum() / P[f >= 20].sum())))
