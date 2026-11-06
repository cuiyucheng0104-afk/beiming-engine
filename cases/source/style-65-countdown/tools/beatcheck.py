"""Beat check: every visual event (events.json, from timeline.js) against the music cue it must sit on (out/cues.json),
and each against the 60 BPM grid (beats, 8ths, triplets, sextuplets) and against whole 30 fps frames.
Sampled attacks are pre-compensated in mix.py (ADV table), so a cue time is where the audible attack lands.
Run after mix.py:  $LIB/.venv/bin/python tools/beatcheck.py"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf
HERE = Path(__file__).resolve().parent.parent
ev = json.load(open(HERE / "events.json"))["ev"]; cues = json.load(open(HERE / "out/cues.json"))
FPS, BPM = 30, 60
VIS = {"open": "tom", "relayout": "stab", "flag": None, "punch": "timp", "swap": "swap", "merge": "ignition", "flip": "ignition", "cut": "cut-chord", "tick": None}
x, sr = sf.read(HERE / "out/mix.wav"); mono = np.abs(x).mean(1)
def onset(t, win=.06):   # first sample after t-win/2 where the short-term energy jumps by 6 dB over the preceding 20 ms
    a = max(0, int((t - win) * sr)); b = int((t + win) * sr); seg = mono[a:b]
    k = int(.002 * sr); e = np.convolve(seg ** 2, np.ones(k) / k, mode="same") + 1e-12
    ref = int(.02 * sr)
    for i in range(ref, len(e)):
        if e[i] > 4 * e[i - ref:i].mean() and e[i] > 1e-6: return (a + i) / sr
    return None
rows, worst = [], 0.0
for e in ev:
    ty, t = e["type"], e["t"]
    if ty in ("silence",): continue
    frame_err = abs(t * FPS - round(t * FPS)) / FPS * 1000
    beat = t * BPM / 60; grid_err = min(abs(beat * d - round(beat * d)) / d for d in (1, 2, 3, 6)) * 1000
    want = VIS.get(ty)
    cands = [c for c in cues if (want is None or c["what"].startswith(want) or (ty == "tick" and c["what"].startswith("tick")))]
    near = min(cands, key=lambda c: abs(c["t"] - t)) if cands else None
    cue_err = abs(near["t"] - t) * 1000 if near else float("nan")
    worst = max(worst, frame_err, grid_err, cue_err if cue_err == cue_err else 0)
    rows.append((t, ty, e.get("id", e.get("n", "")), round(frame_err, 1), round(grid_err, 1), near["what"] if near else "-", round(cue_err, 1)))
print(f"{'t':>8} {'event':<9} {'id':<7} {'frame_ms':>8} {'grid_ms':>7} {'cue':<10} {'cue_ms':>6}")
for r in rows: print(f"{r[0]:8.3f} {r[1]:<9} {str(r[2]):<7} {r[3]:8.1f} {r[4]:7.1f} {r[5]:<10} {r[6]:6.1f}")
print("max deviation (frame / grid / cue):", round(worst, 2), "ms")
sys.exit(0 if worst < 0.5 else 1)
