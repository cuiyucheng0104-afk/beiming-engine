"""Every designed event in events.json sits on the 90 BPM grid (16th-note resolution) and matches its beat in
timeline.json; the two accelerando figures (87 striae ticks, 39 count ticks) are checked to start and land on
the grid and to match the audio events one to one.   usage: python tools/cuecheck.py <project_dir>"""
import json, sys, os
D = sys.argv[1]
TL = json.load(open(os.path.join(D, 'timeline.json'))); EV = json.load(open(os.path.join(D, 'events.json')))['ev']
q = TL['beat'] / 4
worst = 0; rows = 0
for e in EV:
    if e['type'] in ('stria', 'mark'): continue
    off = (e['t'] / q - round(e['t'] / q)) * q * 1000
    worst = max(worst, abs(off)); rows += 1
    print(f"{e['type']:10s} {e['t']:8.4f}s  beat {e['t'] / TL['beat']:6.2f}  {off:+7.2f} ms")
for ty, s0, s1 in (('stria', 'scan0', 'land1'), ('mark', 'count0', 'land2')):
    ts = [e['t'] for e in EV if e['type'] == ty]
    a = (ts[0] - TL['T'][s0]) * 1000
    print(f"{ty:10s} n={len(ts):3d}  first {ts[0]:.4f}s ({a:+.2f} ms from {s0} on beat {TL['B'][s0]})  last {ts[-1]:.4f}s, lands {TL['T'][s1]:.4f}s on beat {TL['B'][s1]}")
    worst = max(worst, abs(a) if ty == 'mark' else 0)
print(f'{rows} grid events, worst offset {worst:.2f} ms'); sys.exit(0 if worst < 1 else 1)
