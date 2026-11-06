"""Cue check: (1) every picture event against the sound placed for it (score + foley, from out/cuelog.json);
(2) every event against the 110.77 BPM grid; (3) the rendered video itself: the frame where each hit actually happens.
Usage: $LIB/.venv/bin/python -I tools/cuecheck.py <project dir> [video.mp4]"""
import sys, os, json, subprocess
import numpy as np
D = sys.argv[1]; VID = sys.argv[2] if len(sys.argv) > 2 else os.path.join(D, 'out', 'video.mp4')
EV = json.load(open(os.path.join(D, 'events.json')))['ev']; CUE = json.load(open(os.path.join(D, 'out', 'cuelog.json')))
B = 13 / 24; FPS = 24
NAME = {'land': 'land', 'crease': 'fold', 'snip': 'snip', 'unfold': 'unfold', 'peel': 'peel', 'gateup': 'gateup', 'plaque': 'plaque', 'launch': 'launch', 'burst': 'burst',
        'unfold2': 'unfold2', 'unfold3': 'unfold3', 'fuin': 'fuin', 'fufold': 'fufold', 'fusnip': 'fusnip', 'fuland': 'fuland'}
rows = []
for e in EV:
    nm = f"copy{e['i']}" if e['type'] == 'copy' else NAME.get(e['type'])
    if not nm: continue
    cands = [c for c in CUE if c['cue'] == nm]
    if not cands: rows.append((nm, e['t'], None, None, None)); continue
    worst = min(abs(c['t'] - e['t']) for c in cands)
    if worst > .2: worst = None
    grid = e['t'] / (B / 4); gdev = (grid - round(grid)) * B / 4
    rows.append((nm, e['t'], worst, gdev, len(cands)))
print(f"{'cue':<9}{'t (s)':>9}{'beat':>8}{'sound Δ ms':>12}{'grid Δ ms':>11}")
mx_s = mx_g = 0
for nm, t, w, gd, n in rows:
    if w is None: print(f'{nm:<9}{t:9.3f}   NO SOUND'); mx_s = 1e9; continue
    mx_s = max(mx_s, w * 1000); mx_g = max(mx_g, abs(gd) * 1000)
    print(f'{nm:<9}{t:9.3f}{t / B:8.2f}{w * 1000:12.2f}{gd * 1000:11.1f}')
print(f'== picture event ↔ its sound: max {mx_s:.2f} ms over {len(rows)} events;  event ↔ sixteenth grid: max {mx_g:.1f} ms (beats are whole frames: 0)')

# ---- (3) measured in the rendered frames ----
if os.path.exists(VID):
    w, h = 240, 136
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', VID, '-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    F = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    d = np.concatenate([[0], np.abs(np.diff(F, axis=0)).mean((1, 2))])   # d[n] = change from frame n-1 to n
    # launch: count red paper pixels in the gap between the two carp ladders (where the hero appears); the hit is the frame where that count jumps
    rawc = subprocess.run(['ffmpeg', '-v', 'error', '-i', VID, '-vf', 'crop=200:300:860:600,scale=100:150', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    Cc = np.frombuffer(rawc, np.uint8).reshape(-1, 150, 100, 3).astype(np.int16)
    red = ((Cc[..., 0] > 150) & (Cc[..., 1] < 100)).sum((1, 2)).astype(np.float32)
    dc = np.concatenate([[0], np.diff(red)])
    stop = {'land', 'fold', 'unfold', 'unfold2', 'unfold3', 'fuland', 'gateup', 'fufold', 'fuin'}
    onset = {'burst', 'launch', 'peel'}
    print('\nframe check (impact frame measured from frame differences):')
    worst = 0
    for nm, t, *_ in rows:
        base = 'stop' if nm in stop else 'onset' if nm in onset else None
        if not base: continue
        ne = round(t * FPS)
        if base == 'stop':   # motion ends on the hit: big change into frame n, small change after it
            win = range(max(1, ne - 3), min(len(d) - 1, ne + 4)); score = {n: d[n] - d[n + 1] for n in win}
        else:                # something new appears on the hit: the biggest change lands on frame n
            win = range(max(1, ne - 3), min(len(d), ne + 4)); score = {n: dc[n] for n in win} if nm == 'launch' else {n: d[n] - d[n - 1] for n in win}
        nd = max(score, key=score.get); off = (nd - t * FPS) / FPS * 1000; worst = max(worst, abs(off))
        print(f'  {nm:<8} expected frame {t * FPS:7.2f}  measured {nd:4d}  offset {off:+6.1f} ms')
    print(f'== measured picture hits vs timeline: max {worst:.1f} ms')
