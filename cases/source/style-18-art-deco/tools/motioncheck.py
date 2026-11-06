"""画面动作落点自检：成片逐帧帧差，看每个事件帧（及其后 1 帧）是否出现视觉变化峰（灯泡点火、落定闪光、切换）。
python tools/motioncheck.py film.mp4 —— 报告每个拍点的帧差相对于前 4 帧中位数的倍数。"""
import json, os, sys, subprocess
import numpy as np
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
w, h = 192, 108
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', sys.argv[1], '-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
d = np.r_[0, np.abs(np.diff(F, axis=0)).mean((1, 2))]
skip = {'scribe', 'crane', 'pull', 'dolly', 'fuse', 'cutoff', 'plaque', 'switch', 'chase', 'ding', 'doorstop'}
ok = 0; rows = []
for e in EV:
    if e['type'] in skip or e['t'] <= 0: continue
    f = int(round(e['t'] * 24)); base = np.median(d[max(1, f - 4):f]) + .05; pk = max(d[f], d[min(len(d) - 1, f + 1)])
    r = pk / base; ok += r >= 1.3; rows.append((e['type'], e.get('i', ''), f, r))
for ty, i, f, r in rows: print(f"{ty:8s}{str(i):3s} 帧 {f:3d}  帧差/前4帧中位数 {r:5.2f} {'✓' if r >= 1.3 else '·'}")
print(f'{ok}/{len(rows)} 个事件帧出现视觉变化峰（≥1.3×）')
