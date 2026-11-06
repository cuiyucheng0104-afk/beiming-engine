"""Picture ↔ music cue check.
For every visual hit in events.json (entries with a `cue`), report:
  frame  : distance of the hit from the nearest 24 fps frame (ms)
  grid   : distance from the nearest eighth note of its section's tempo map (ms)
  music  : distance from the score note tagged with the same cue in out/score_onsets.json (ms)
and check that the silence window holds no note onsets and is near-silent in out/mix.wav.
Exit 1 if any deviation exceeds 0.5 ms or the silence is not quiet.
Usage: python tools/cuecheck.py [project dir]
"""
import json, os, sys
import numpy as np
import soundfile as sf
HERE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SO = json.load(open(os.path.join(HERE, 'out', 'score_onsets.json')))
FPS = TL['fps']; SECS = TL['secs']


def sec_of(t):
    for s in SECS:
        if s['t0'] - 1e-9 <= t < s['t1'] - 1e-9: return s
    return SECS[-1]


def grid_dev(t):
    s = sec_of(t); e = 60 / s['bpm'] / 2; k = round((t - s['t0']) / e); return abs(t - (s['t0'] + k * e))


rows, worst = [], 0.0
for e in EV:
    c = e.get('cue')
    if not c: continue
    t = e['t']
    f = abs(t * FPS - round(t * FPS)) / FPS
    g = grid_dev(t)
    tl = abs(t - TL['t'][c])
    m = SO['onsets'].get(c)
    md = abs(t - m) if m is not None else None
    devs = [f, g, tl] + ([md] if md is not None else [])
    worst = max(worst, max(devs))
    s = sec_of(t)
    bar_beat = (t - s['t0']) / (60 / s['bpm'])
    rows.append((c, t, round(t * FPS), f"{s['id']}{int(bar_beat // s['meter']) + 1}.{bar_beat % s['meter'] + 1:.1f}", f * 1e3, g * 1e3, tl * 1e3, None if md is None else md * 1e3))

print(f"{'cue':9} {'t (s)':>8} {'frame':>5}  {'bar.beat':9} {'frame ms':>8} {'grid ms':>8} {'tl ms':>6} {'music ms':>9}")
for c, t, fr, bb, f, g, tl, md in rows:
    print(f"{c:9} {t:8.4f} {fr:5d}  {bb:9} {f:8.3f} {g:8.3f} {tl:6.3f} {'   (fx)' if md is None else f'{md:9.3f}'}")
untagged = [c for c, *_ in rows if c not in SO['onsets']]
print(f"\n{len(rows)} visual hits · {len(rows) - len(untagged)} with a tagged music note · max deviation {worst * 1e3:.3f} ms")
if untagged: print('carried by foley only (no music note):', ', '.join(untagged))

# the silence before the sun
S = next(s for s in SECS if s['id'] == 'S')
inside = [n for n in SO['notes'] if S['t0'] <= n < S['t1'] - 1e-6]
x, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav'))
mono = x.mean(1)
def lufs_ish(a, b):
    y = mono[int(a * sr):int(b * sr)]; return 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)
sil = lufs_ish(S['t0'] + .3, S['t1'] - .02); full = lufs_ish(0, TL['dur'])
after = lufs_ish(S['t1'], S['t1'] + .5)
print(f"silence {S['t0']}–{S['t1']} s: {len(inside)} note onsets · RMS {sil:.1f} dBFS (film {full:.1f}, first 0.5 s after {after:.1f}) → {after - sil:.1f} dB jump")
ok = worst <= 5e-4 and not inside and full - sil >= 15
print('CUECHECK', 'OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)
