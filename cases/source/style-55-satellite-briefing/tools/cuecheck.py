"""Every key action sits on the 80 BPM grid (eighth notes) and has its sound: compares timeline.json (picture cues)
with the grid and with events.json (what the page exports and mix.py places).
usage: python -I tools/cuecheck.py <film_dir>     exit 1 on any miss"""
import sys, os, json
D = sys.argv[1]
TL = json.load(open(os.path.join(D, 'timeline.json'))); EV = json.load(open(os.path.join(D, 'events.json')))['ev']
T = TL['T']; beat = TL['beat']
SOUND = {'scanIn': 'scan_in', 'dive0': 'dive', 'lock': 'lock', 'mapOn': 'map_print', 'mapName': 'map_name', 'tear': 'tear',
         'y1986': 'ring', 'y2005': 'ring', 'y2010': 'ring', 'y2015': 'ring', 'y2020': 'ring', 'y2026': 'stop', 'markA': 'mark',
         'range0': 'range', 'rangeEnd': 'range_end', 'sil0': 'silence', 'turn': 'turn', 'frame': 'frame', 'title': 'title', 'coda': 'coda'}
bad = 0; worst = 0
print(f'{"cue":9s} {"time":>7s} {"beat":>6s} {"grid ms":>8s} {"sound ms":>9s}  sound')
for k, snd in SOUND.items():
    t = T[k]; b = t / beat; off = (b * 2 - round(b * 2)) * beat / 2 * 1000
    hit = [e for e in EV if e['type'] == snd]
    d = min((abs(e['t'] - t) for e in hit), default=9e9) * 1000
    ok = abs(off) < 0.5 and d < 0.5
    bad += not ok; worst = max(worst, abs(off), d)
    print(f'{k:9s} {t:7.3f} {b:6.2f} {off:8.2f} {d:9.2f}  {snd} {"" if ok else "<--"}')
ticks = [e for e in EV if e['type'] == 'tick']
toff = max(abs((e['t'] / beat * 4) - round(e['t'] / beat * 4)) * beat / 4 * 1000 for e in ticks)
print(f'ticks {len(ticks)} on the sixteenth grid, worst {toff:.2f} ms')
print('max deviation %.2f ms; ' % worst + ('all cues on the grid with their sounds' if not bad else f'{bad} cue(s) off'))
sys.exit(1 if bad or toff > .5 else 0)
