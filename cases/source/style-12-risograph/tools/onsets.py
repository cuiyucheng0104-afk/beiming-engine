"""Transients in the final mix (for the cue check): high-passed energy envelope, 1 ms hop, rising-edge peaks → out/onsets.json"""
import sys, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, find_peaks
x, sr = sf.read(sys.argv[1]); x = x.mean(1) if x.ndim > 1 else x
y = sosfilt(butter(2, 150, 'high', fs=sr, output='sos'), x)
hop = sr // 1000; e = np.sqrt(np.convolve(y ** 2, np.ones(hop * 3) / (hop * 3), 'same'))[::hop]
le = 20 * np.log10(e + 1e-6); d = np.diff(le, prepend=le[0])
rise = np.convolve(d, np.ones(4), 'same')          # dB gained over ~4 ms
pk, _ = find_peaks(rise, height=6, distance=25)
on = [round(float(p) / 1000, 4) for p in pk]
json.dump(on, open(sys.argv[2], 'w')); print(len(on), 'onsets')
