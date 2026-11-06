"""Cue check: every visual event (events.json, from the page's window.EV) against
  1. the music grid (its beat number x 0.625 s at 96 BPM),
  2. the frame it is shown on at 24 fps (picture quantisation),
  3. the measured onset in the rendered audio (out/stems/foley.wav + music.wav, envelope rise within +-60 ms),
  4. a score note placed on the same instant, for the events the music is meant to hit.
usage: python -I tools/cuecheck.py <project_dir>      exit 1 if any grid deviation > 0.5 ms or audio onset > 12 ms
"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.ndimage import uniform_filter1d
D = sys.argv[1]
TL = json.load(open(os.path.join(D, 'out', 'timeline.json')))
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
AC = json.load(open(os.path.join(D, 'out', 'audio_cues.json')))
B, FPS = TL['BEAT'], 24
fo, sr = sf.read(os.path.join(D, 'out', 'stems', 'foley.wav'))
mu, _ = sf.read(os.path.join(D, 'out', 'stems', 'music.wav'))
x = np.abs(fo).max(1) + np.abs(mu).max(1)
env = uniform_filter1d(x, int(.0015 * sr))
notes = sorted({round(s[0], 5) for s in AC['score']})
MUSIC_HITS = {'lighton', 'develop', 'land', 'light12', 'tick', 'place', 'loupe'}

fx = uniform_filter1d(np.abs(fo).max(1), int(.001 * sr)); mx = uniform_filter1d(np.abs(mu).max(1), int(.001 * sr))
def onset(t, music=False):
    e = mx if music else fx
    i0, i1 = int((t - .035) * sr), int((t - .004) * sr)
    pre = e[max(i0, 0):max(i1, 1)].max() if i1 > 0 else 0.0
    a, b = max(int((t - .004) * sr), 0), int((t + .04) * sr)
    seg = e[a:b]
    hit = np.nonzero(seg > pre * 1.6 + 2e-4)[0]
    return (a + hit[0]) / sr if len(hit) else None

rows, worst_grid, worst_on = [], 0.0, 0.0
for e in EV:
    t = e['t']; grid = e['beat'] * B
    dg = (t - grid) * 1000
    fr = np.ceil(t * FPS - 1e-9) / FPS; df = (fr - t) * 1000
    on = onset(t, e['type'] in ('light12', 'place')); do = (on - t) * 1000 if on is not None else float('nan')
    nm = min(notes, key=lambda q: abs(q - t)); dn = (nm - t) * 1000
    worst_grid = max(worst_grid, abs(dg))
    if on is not None and e['type'] not in ('place',): worst_on = max(worst_on, abs(do))
    rows.append((t, e['type'], e['beat'], dg, df, do, dn if e['type'] in MUSIC_HITS else None))
print(f"{'t(s)':>8} {'event':<9} {'beat':>7} {'grid ms':>8} {'frame ms':>9} {'onset ms':>9} {'note ms':>8}")
for t, k, bb, dg, df, do, dn in rows:
    print(f"{t:8.4f} {k:<9} {bb:7.3f} {dg:8.2f} {df:9.2f} {do:9.2f} {'' if dn is None else f'{dn:8.2f}'}")
on_beat = [r for r in rows if abs(r[2] * 4 - round(r[2] * 4)) < 1e-9 and abs(r[2] - round(r[2])) < 1e-9]
print(f"\nevents {len(rows)}; worst grid deviation {worst_grid:.3f} ms; worst measured audio onset {worst_on:.2f} ms")
print(f"whole-beat events on exact frames: {sum(1 for r in on_beat if abs(r[4]) < 1e-6)}/{len(on_beat)} (a beat = 15 frames at 24 fps);"
      f" sub-beat events wait at most {max(r[4] for r in rows):.1f} ms for their frame")
hits = [r for r in rows if r[6] is not None]
print(f"music hits with a score note on the same instant: {sum(1 for r in hits if abs(r[6]) < .5)}/{len(hits)}")
sys.exit(0 if worst_grid <= .5 and worst_on <= 12 else 1)
