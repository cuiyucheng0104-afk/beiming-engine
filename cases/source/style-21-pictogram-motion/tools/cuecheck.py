"""Cue check: picture events ↔ beat grid ↔ measured audio onsets ↔ rendered video.
python tools/cuecheck.py   → prints a report and writes out/cuecheck.txt; exits 1 on any miss.
1. every event the page exports (window.EV) equals the timeline's and sits on the 16th-note grid and on a frame;
2. every card accent / the slam, measured in the rendered accent stem, lands on its cut (mix.py → out/onsets.json);
3. in the rendered video, the biggest frame-to-frame change around each cut happens on the cut frame (±1 frame).
"""
import json, os, subprocess, sys
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVP = json.load(open(os.path.join(HERE, 'events.json')))
B, FPS = TL['BEAT'], TL['FPS']
lines, bad = [], 0

# 1. grid
assert len(TL['EV']) == len(EVP['ev']), 'page EV differs from timeline'
worst_grid = worst_frame = worst_same = 0.0
for a, b in zip(TL['EV'], EVP['ev']):
    worst_same = max(worst_same, abs(a['t'] - b['t']))
    beats = b['t'] / B; g = abs(beats * 4 - round(beats * 4)) * B / 4
    fr = abs(b['t'] * FPS - round(b['t'] * FPS)) / FPS
    worst_grid, worst_frame = max(worst_grid, g), max(worst_frame, fr)
lines.append(f'[1] {len(EVP["ev"])} picture/sound events: page = timeline (max {worst_same*1000:.3f} ms), '
             f'on the 16th grid (max {worst_grid*1000:.3f} ms), on a frame (max {worst_frame*1000:.3f} ms)')
bad += worst_grid > 1e-6 or worst_frame > 1e-6 or worst_same > 1e-9

# 2. audio onsets
on = json.load(open(os.path.join(HERE, 'out', 'onsets.json')))
mx = max(abs(o['offset_ms']) for o in on)
lines.append(f'[2] {len(on)} accents measured in the rendered accent stem: max |offset| {mx:.2f} ms (target 0, limit ±15)')
for o in on: lines.append(f'      {o["t"]:7.3f}s  {o["what"]:22s} {o["offset_ms"]:+6.2f} ms')
bad += mx > 15

# 3. video
vid = os.path.join(HERE, 'out', 'video.mp4')
if os.path.exists(vid):
    w, h = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    d = np.r_[0, np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))]   # d[k] = change from frame k-1 to k
    lines.append(f'[3] video: {len(fr)} frames ({len(fr)/FPS:.3f} s); largest frame change around each cut (frame k = change into frame k):')
    worst = 0
    for c in TL['CARDS'][1:]:
        k0 = round(c['t0'] * FPS)
        # the cut is the midpoint of a transition centred on the beat: the single largest change lands on the
        # step into the cut frame (k0) or out of it (k0+1), i.e. ±0.5 frame of the beat; the push lands on k0
        win = 3 if c['mode'] != 'flash' else 1
        ks = np.arange(k0 - win, k0 + win + 1); ks = ks[(ks > 0) & (ks < len(d))]
        if c['tin'] == 'push': ks = np.arange(k0 - 6, k0 + 2)
        kmax = int(ks[np.argmax(d[ks])])
        off = kmax - k0 - (0 if c['tin'] == 'push' else 0.5)
        if c['tin'] in ('whip', 'scroll'):   # camera moves: frames inside the move are all blurred, so use the centre of the change
            ks = np.arange(k0 - 4, k0 + 5); off = float((ks * d[ks]).sum() / d[ks].sum()) - 0.5 - k0
        worst = max(worst, abs(off))
        lines.append(f'      card {c["n"]:02d} {c["tin"]:8s} cut {c["t0"]:6.3f}s  frame {k0:3d}  largest change at {off:+.1f} frames')
    lines.append(f'    worst {worst:.2f} frames ({worst / FPS * 1000:.0f} ms)')
    bad += worst > 1.01   # ±1 frame = ±42 ms at 24 fps
    ns = round(TL['NIGHT']['slam'] * B * FPS)
    lines.append(f'    slam frame {ns}: change {d[ns]:.1f} (median of film {np.median(d):.1f})')
txt = '\n'.join(lines)
print(txt); open(os.path.join(HERE, 'out', 'cuecheck.txt'), 'w').write(txt + '\n')
sys.exit(1 if bad else 0)
