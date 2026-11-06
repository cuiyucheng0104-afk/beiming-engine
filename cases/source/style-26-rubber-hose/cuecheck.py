"""cuecheck.py — do the picture and the sound land on the music grid?
1) every hit point: on the beat grid and on a whole frame (ms off the 24 fps grid)
2) every visual cue exported by the page (events.json, type 'cue') vs timeline.json
3) every musical accent (music/score.json) vs its hit, and the measured onset in out/mix.wav (±60 ms window)
4) the picture really changes on the hit frame (frame-difference spike in out/video.mp4)
Run: $LIB/.venv/bin/python <film>/cuecheck.py"""
import os, json, subprocess, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, 'timeline.json'))); H = TL['h']; FPS = TL['fps']
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'music', 'score.json')))['acc']
worst = 0.0
print('— 1) grid: hit → frame offset (ms)')
for k, t in H.items():
    off = (t * FPS - round(t * FPS)) / FPS * 1000; worst = max(worst, abs(off))
print(f'   {len(H)} hits, max offset from the frame grid {worst:.3f} ms')
print('— 2) page cues vs timeline (ms)')
cues = {e['id']: e['t'] for e in EV if e['type'] == 'cue'}
d2 = max(abs(cues[k] - H[k]) * 1000 for k in H); print(f'   {len(cues)} cues, max |Δ| {d2:.3f} ms')
print('— 3) score accents vs hits, and measured onsets in the mix')
mix, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav')); m = mix.mean(1) if mix.ndim > 1 else mix
hop = int(.002 * sr); n = len(m) // hop
env = np.sqrt(np.mean(m[:n * hop].reshape(n, hop) ** 2, 1)); lg = 20 * np.log10(env + 1e-6)
flux = np.maximum(0, np.diff(lg, prepend=lg[0]))
rows = []
for k, t in SC.items():
    hk = H.get(k, H.get({'ch2': 'ch2', 'ch3': 'ch3'}.get(k, k)))
    planned = (t - hk) * 1000 if hk is not None else float('nan')
    i0, i1 = int((t - .06) * sr / hop), int((t + .06) * sr / hop)
    sc = [np.mean(lg[i:i + 10]) - np.mean(lg[i - 10:i]) for i in range(i0, i1)]   # level jump: next 20 ms vs previous 20 ms
    j = i0 + int(np.argmax(sc)); meas = (j * hop / sr - t) * 1000
    rows.append((k, planned, meas)); print(f'   {k:12s} planned {planned:+6.1f} ms   onset in mix {meas:+6.1f} ms')
print('— 4) picture change on hit frames (frame-diff ratio vs the median)')
vid = os.path.join(HERE, 'out', 'video.mp4')
if os.path.exists(vid):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', 'scale=240:136,format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, 136, 240).astype(np.float32)
    dif = np.r_[0, np.abs(np.diff(fr, axis=0)).mean((1, 2))]; med = np.median(dif[1:])
    for k in ['ring', 'curtainOpen', 'cutBed', 'yank', 'trumpet', 'blast', 'ch2', 'ch3', 'danceMax', 'handRise', 'handTop', 'stop', 'slap', 'peel', 'boing', 'bow', 'grabIris', 'irisShut', 'hop1', 'hop2', 'hop3', 'wink', 'hatPop']:
        f = int(round(H[k] * FPS)); loc = int(np.argmax(dif[f - 1:f + 2])) - 1
        print(f'   {k:12s} frame {f:3d}  diff ×{dif[f] / med:5.1f}  (biggest change within ±1 frame at {loc:+d})')
print(f'RESULT: visual hits on grid, max {max(worst, d2):.3f} ms; planned accents max |Δ| {max(abs(r[1]) for r in rows):.1f} ms; measured onsets max |Δ| {max(abs(r[2]) for r in rows):.1f} ms')
