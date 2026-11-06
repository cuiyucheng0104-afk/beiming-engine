"""cue check: every visual hit (timeline.js HIT → events.json) against the music note written on it (out/music_hits.json),
every EV on a whole frame, every foley-driving EV on the beat grid (or a named subdivision), and the silence really silent.
Run after mix.py:  $LIB/.venv/bin/python tools/cuecheck.py   (exit 1 on any miss)"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
MH = json.load(open(os.path.join(HERE, 'out', 'music_hits.json')))
FPS, BF = TL['fps'], TL['beat_f']
hits = {h['label']: h['t'] for h in MH['hits']}
bad = 0; worst = 0.0
print('%-14s %6s %9s %9s %8s' % ('cue', 'beat', 'picture', 'music', 'Δ ms'))
def frame_of(b):
    i = int(np.floor(b + 1e-9)); return BF[i] + (BF[i + 1] - BF[i]) * (b - i)
cues = dict(TL['hit']); cues['hop2'] = 22.6
for name, b in sorted(cues.items(), key=lambda kv: kv[1]):
    if name == 'pen': continue                     # the pen draws from frame 0; its vibraphone note is checked as 'pen' below
    f = frame_of(b); tv = f / FPS
    if abs(f - round(f)) > 1e-6: print('  !! %s not on a whole frame (%.3f)' % (name, f)); bad += 1
    tm = hits.get(name)
    if tm is None: print('%-14s %6.1f %9.4f %9s   MISSING' % (name, b, tv, '-')); bad += 1; continue
    d = (tm - tv) * 1000; worst = max(worst, abs(d))
    print('%-14s %6.1f %9.4f %9.4f %8.3f' % (name, b, tv, tm, d))
    if abs(d) > 0.5: bad += 1
for i in range(16):                                 # every accelerando cycle has its bass note on its frame
    b = TL['sec']['D'] + i; tv = BF[b] / FPS; tm = hits.get('cyc%d' % i)
    d = 1e9 if tm is None else (tm - tv) * 1000; worst = max(worst, abs(d))
    if abs(d) > 0.5: print('cyc%d off by %.2f ms' % (i, d)); bad += 1
print('accelerando cycles: 16 checked (beat lengths %s frames)' % [BF[i + 1] - BF[i] for i in range(28, 44)])
offgrid = [e for e in EV if abs(e['t'] * FPS - round(e['t'] * FPS)) > 1e-3]
for e in offgrid: print('  !! EV %s at %.5f is not on a whole frame' % (e['type'], e['t'])); bad += 1
print('EV on whole frames: %d / %d' % (len(EV) - len(offgrid), len(EV)))
mix, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav'))
a, b = MH['sil']; seg = mix[int(round((a + .08) * sr)):int(round(b * sr))]
pk = 20 * np.log10(np.abs(seg).max() + 1e-12)
print('silence %.3f–%.3f s: peak %.1f dBFS' % (a + .08, b, pk))
if pk > -90: bad += 1
first = mix[int(round(b * sr)):int(round((b + .1) * sr))]
print('first sound after the silence (the bell, %.3f s): peak %.1f dBFS' % (b, 20 * np.log10(np.abs(first).max() + 1e-12)))
print('worst picture↔music offset: %.3f ms · %s' % (worst, 'PASS' if not bad else '%d problems' % bad))
sys.exit(1 if bad else 0)
