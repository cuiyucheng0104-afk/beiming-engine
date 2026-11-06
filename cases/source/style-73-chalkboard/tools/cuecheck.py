"""Cue check: every visual hit against the beat grid and against the sound that should land on it.
usage: python tools/cuecheck.py <film dir>        (after events.mjs and mix.py)
1. grid:     the time the picture puts each cue (events.json, type 'cue'; landings are read off the cell motion
             frame by frame) vs its beat on the 108 BPM grid snapped to 30 fps frames (js/timeline.js).
2. schedule: the nearest musical onset the score scheduled (out/onsets.json) vs the cue.
3. measured: the attack actually found in the rendered music stem (out/stem_music.wav) near the cue.
Exits 1 if any cue is off the grid or has no scheduled sound within 1 ms."""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
D = sys.argv[1]
ev = json.load(open(os.path.join(D, 'events.json')))['ev']
ons = json.load(open(os.path.join(D, 'out/onsets.json')))
tq = lambda b: np.floor(b * 60 / 108 * 30 + .5) / 30             # Math.round, as in js/timeline.js
cues = [e for e in ev if e['type'] == 'cue']
chalk = [e['t'] for e in ev if e['type'] in ('chalk', 'land')]
x, sr = sf.read(os.path.join(D, 'out/stem_music.wav')); x = x.mean(1)
x = sosfilt(butter(2, 700, 'high', fs=sr, output='sos'), x)
env = np.convolve(np.abs(x), np.ones(int(.002 * sr)) / int(.002 * sr), 'same')
def attack(t):
    a, b = int((t - .02) * sr), int((t + .06) * sr); seg = env[a:b]
    if len(seg) == 0 or seg.max() < 1e-4: return None
    base = np.median(env[max(0, a - int(.03 * sr)):a]) if a > 0 else 0
    thr = base + .5 * (seg.max() - base); i = int(np.argmax(seg > thr))
    return (a + i) / sr - t
bad, rows, meas = 0, [], []
for c in cues:
    g = (c['t'] - tq(c['beat'])) * 1000
    on = min(ons, key=lambda o: abs(o['t'] - c['t'])); s = (on['t'] - c['t']) * 1000
    fo = min(chalk + [1e9], key=lambda t: abs(t - c['t'])); f = (fo - c['t']) * 1000
    m = attack(c['t']) if abs(s) < 1 else None
    if m is not None: meas.append(m * 1000)
    ok = abs(g) < .5 and (abs(s) < 1 or abs(f) < 1)
    bad += not ok
    rows.append(f"{c['id']:>10}  beat {c['beat']:>7.3f}  t {c['t']:7.3f}  grid {g:+6.1f} ms  music {s:+7.1f} ms ({on['what'][:18]:<18})  foley {f:+7.1f} ms  attack {'' if m is None else f'{m * 1000:+5.1f} ms'}  {'ok' if ok else 'OFF'}")
print('\n'.join(rows))
gm = max(abs((c['t'] - tq(c['beat'])) * 1000) for c in cues)
on_music = [c for c in cues if abs(min(ons, key=lambda o: abs(o['t'] - c['t']))['t'] - c['t']) < .001]
print(f'\n{len(cues)} cues · picture vs grid: max {gm:.2f} ms · {len(on_music)} cues carry a scheduled musical onset at 0 ms, the rest a chalk sound at 0 ms'
      f' · measured attack in the music stem: median {np.median(meas):+.1f} ms, max |{np.max(np.abs(meas)):.1f}| ms ({len(meas)} cues) · {bad} off')
sys.exit(1 if bad else 0)
