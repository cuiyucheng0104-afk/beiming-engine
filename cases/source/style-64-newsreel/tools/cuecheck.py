#!/usr/bin/env python3
"""Beat check: every visual hit vs the music/foley cue it must land on.
  1. score: each visual event in events.json (window.EV) against out/cues.json (written by audio/mix.py)
  2. audio: the measured onset in out/mix.wav nearest each hit (spectral-flux peak, 2.7 ms hop)
  3. picture: for hard cuts / slams, the frame of largest change in out/video.mp4 (if rendered)
  Every hit must also sit on the 8th-note grid (0.25 s) or the 16th grid (pages), and on a whole frame.
Run:  $LIB/.venv/bin/python -I tools/cuecheck.py   (exit 1 if any score offset > 1 ms or picture offset > 0 frames)"""
import json, subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent.parent
TL = json.loads((HERE / "timeline.json").read_text())
EV = json.loads((HERE / "events.json").read_text())["ev"]
CUES = json.loads((HERE / "out/cues.json").read_text())
FPS, BEAT = TL["FPS"], TL["BEAT"]
skip = {"arrive"}                                        # telegraph clicks follow the line, not the grid
vis = [(e["type"] + (str(e["i"]) if "i" in e else ""), e["t"]) for e in EV if e["type"] not in skip]
vis = [(k, t) for k, t in vis if k not in ("logo_iris_",)]
ct = np.array([c["t"] for c in CUES])

x, sr = sf.read(HERE / "out/mix.wav"); m = x.mean(1)
hop, win = 128, 1024
frames = np.lib.stride_tricks.sliding_window_view(np.pad(m, (win, win)), win)[::hop] * np.hanning(win)
spec = np.abs(np.fft.rfft(frames, axis=1))
flux = np.maximum(0, np.diff(np.log1p(spec * 10), axis=0)).sum(1)
ft = (np.arange(len(flux)) + 1) * hop / sr - win / sr + win / 2 / sr    # time of each flux value (window centre)

vid = HERE / "out/video.mp4"; diff = None
if vid.exists():
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(vid), "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, 90, 160).astype(np.float32)
    diff = np.r_[0, np.abs(np.diff(fr, axis=0)).mean((1, 2))]
CUTS = {"deal0", "land_cut", "roll_cut", "paper_punch", "dive", "freeze"} | {f"page{i}" for i in range(2, 8)}   # page1 = end of the dive zoom

bad = 0
print(f"{'event':13s} {'t (s)':>7s} {'grid':>5s} {'score Δms':>9s} {'audio onset Δms':>15s} {'picture Δfr':>11s}  cue")
for k, t in sorted(vis, key=lambda a: a[1]):
    on_grid = abs(t / (BEAT / 4) - round(t / (BEAT / 4))) < 1e-6 and abs(t * FPS - round(t * FPS)) < 1e-6
    i = int(np.argmin(np.abs(ct - t))); d_score = (ct[i] - t) * 1000
    sel = (ft > t - .03) & (ft < t + .05)
    d_aud = (ft[sel][np.argmax(flux[sel])] - t) * 1000 if sel.any() else float('nan')
    d_pic = ""
    if diff is not None and k in CUTS:
        f0 = round(t * FPS); w = 1 if k.startswith('page') else 3; lo, hi = max(1, f0 - w), min(len(diff) - 1, f0 + w)
        d_pic = int(np.argmax(diff[lo:hi + 1]) + lo - f0)
        if d_pic != 0: bad += 1
    if not on_grid or abs(d_score) > 1: bad += 1
    print(f"{k:13s} {t:7.3f} {'ok' if on_grid else 'OFF':>5s} {d_score:9.1f} {d_aud:15.1f} {str(d_pic):>11s}  {CUES[i]['what']}")
print("RESULT:", "PASS" if not bad else f"{bad} problem(s)")
sys.exit(1 if bad else 0)
