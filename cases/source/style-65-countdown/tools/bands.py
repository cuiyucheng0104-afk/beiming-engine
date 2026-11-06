"""Low-end balance check (TECHNIQUE: keep 20–120 Hz about −3 dB relative to the rest).
Band level = energy per octave (dB). Reports 20–120 Hz against the mean octave of 120 Hz–7.68 kHz (six octaves),
for the whole film and for the launch (T0 → end). Run: python tools/bands.py [wav]"""
import sys
from pathlib import Path
import numpy as np, soundfile as sf
from scipy.signal import welch
HERE = Path(__file__).resolve().parent.parent
x, sr = sf.read(sys.argv[1] if len(sys.argv) > 1 else HERE / "out/mix.wav")
if x.ndim > 1: x = x.mean(1)
def report(y, name):
    f, p = welch(y, sr, nperseg=16384); df = f[1] - f[0]
    E = lambda a, b: p[(f >= a) & (f < b)].sum() * df
    low = 10 * np.log10(E(20, 120) / np.log2(120 / 20))
    rest = 10 * np.log10(np.mean([E(120 * 2 ** k, 240 * 2 ** k) for k in range(6)]))
    print(f"{name:<7} 20–120 Hz per octave vs mean octave 120 Hz–7.7 kHz: {low - rest:+.1f} dB"
          f"   (20–60: {10*np.log10(E(20,60)/np.log2(3)) - rest:+.1f}, 60–120: {10*np.log10(E(60,120)) - rest:+.1f})")
    return low - rest
report(x, "film"); report(x[int(15.0 * sr):], "launch")
