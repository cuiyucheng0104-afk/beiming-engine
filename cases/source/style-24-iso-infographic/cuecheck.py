"""Cue check: every visual hit in events.json (exported from timeline.js) must
 1) sit on the 16th-note grid of the tempo, 2) fall on a whole video frame, 3) coincide with a musical onset written by mix.py.
Prints the offsets in ms; exits 1 if any is off by more than 0.5 ms."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json'))); ON = json.load(open(os.path.join(HERE, 'out', 'onsets.json')))
tempo = [e for e in E['ev'] if e['type'] == 'tempo'][0]; s16 = 60 / tempo['bpm'] / 4; FPS = 24
hits = [e for e in E['ev'] if e.get('hit')]; worst = 0; bad = 0
for e in hits:
    t = e['t']; grid = abs(t - round(t / s16) * s16) * 1000; frame = abs(t - round(t * FPS) / FPS) * 1000
    mus = min(abs(t - o) for o in ON) * 1000; d = max(grid, frame, mus); worst = max(worst, d)
    flag = 'OK ' if d <= .5 else 'BAD'; bad += d > .5
    print(f'{flag} {t:7.3f}s  bar {int(t // (s16*16)) + 1}.{int(t % (s16*16) // (s16*4)) + 1}+{int(round(t % (s16*4) / s16))}/4  {e["type"]:<12} grid {grid:.2f} ms  frame {frame:.2f} ms  music {mus:.2f} ms')
print(f'{len(hits)} visual hits, worst offset {worst:.2f} ms, {bad} bad')
sys.exit(1 if bad else 0)
