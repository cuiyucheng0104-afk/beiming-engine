#!/usr/bin/env python3
"""Cue check: picture and sound against the 90 BPM grid (timeline.json).
1. every event in events.json sits on a quarter-beat and on a whole frame (offset in ms, target 0);
2. sound: the onset of each key hit in out/mix.wav (or the final film) is measured against its beat;
3. picture: every hard cut is found as the biggest frame-to-frame change in the rendered video around its beat;
4. the silence before the break: level of b19–b20 against the rest.
Usage: python tools/cuecheck.py [film.mp4]   (exit 1 when any offset exceeds 1 frame / 10 ms)"""
import json, os, sys, subprocess
import numpy as np, soundfile as sf
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(D, 'timeline.json'))); EV = json.load(open(os.path.join(D, 'events.json')))['ev']
SPB, FPS = TL['spb'], TL['fps']; bad = 0
print('1) events on the grid (ms off the quarter-beat grid / off a whole frame)')
worst = 0
for e in EV:
    q = round(e['t'] / (SPB / 4)) * SPB / 4; off = (e['t'] - q) * 1000; fo = (e['t'] * FPS - round(e['t'] * FPS)) / FPS * 1000
    worst = max(worst, abs(off), abs(fo))
print(f'   {len(EV)} events, worst offset {worst:.3f} ms'); bad += worst > .5

film = sys.argv[1] if len(sys.argv) > 1 else None
wav = os.path.join(D, 'out/mix.wav')
if film:
    wav = os.path.join(D, 'out/_check.wav'); subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', film, '-vn', '-ac', '1', '-ar', '48000', wav], check=True)
x, sr = sf.read(wav); x = x if x.ndim == 1 else x.mean(1)
from scipy.signal import butter, sosfilt
xa = x; x = sosfilt(butter(4, 1500, 'high', fs=sr, output='sos'), x)   # attacks are read from the transients above 1.5 kHz
def onset(t):  # the largest attack within ±40 ms of the beat: biggest jump of 3 ms RMS (above 1.5 kHz) over the 3 ms before
    w = int(.003 * sr); best, bt = -1e9, t
    for i in range(int((t - .04) * sr), int((t + .04) * sr), int(.0005 * sr)):
        if i < 0: continue
        a = (np.sqrt(np.mean(x[i - w:i] ** 2)) if i >= w else 0) + 1e-6; b = np.sqrt(np.mean(x[i:i + w] ** 2)) + 1e-6; j = 20 * np.log10(b / a)
        if j > best: best, bt = j, i / sr
    return bt
print('2) sound onsets at key hits (ms, + = late)')
KEY = [('freeze', 0), ('cut', 5), ('freeze', 12), ('cut', 18), ('break', 20), ('freeze', 26)]
for name, b in KEY:
    t = round(b * SPB * FPS) / FPS; o = onset(t)
    if o is None: print(f'   b{b:<5} {name:8s} no onset found'); bad += 1; continue
    ms = (o - t) * 1000; print(f'   b{b:<5} {name:8s} t={t:7.3f}  onset {ms:+6.1f} ms'); bad += abs(ms) > 10
print('3) silence before the break')
r = lambda a, b: 20 * np.log10(np.sqrt(np.mean(xa[int(a * sr):int(b * sr)] ** 2)) + 1e-9)
t19, t20 = 19 * SPB, 20 * SPB
print(f'   b19–b20 {r(t19 + .02, t20 - .005):6.1f} dBFS   | b20–b21 (break) {r(t20, t20 + SPB):6.1f} dBFS   | whole {r(0, len(xa) / sr):6.1f} dBFS')
if film:
    print('4) hard cuts in the picture (frame of the biggest change, vs. the beat)')
    W, H = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', film, '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    F = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32); dif = np.abs(np.diff(F, axis=0)).mean((1, 2))
    for b in (5, 12, 13.5, 18, 20, 26):
        f = round(b * SPB * FPS); lo, hi = f - 6, f + 6; k = lo + int(np.argmax(dif[lo - 1:hi - 1])) + 0
        print(f'   b{b:<3} expected frame {f:4d}  biggest change at frame {k:4d}  ({(k - f) / FPS * 1000:+.0f} ms)'); bad += k != f
    os.remove(wav)
print('PASS' if not bad else f'FAIL ({bad})'); sys.exit(1 if bad else 0)
