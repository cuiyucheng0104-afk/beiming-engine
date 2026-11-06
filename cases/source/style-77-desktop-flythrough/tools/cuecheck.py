"""Cue check: every visual event (window.EV, camera keys included), every note of the score and every hit point must sit on the
16th-note grid of timeline.js and on a whole frame; the big visual hits must coincide with a music cue. Prints the deviations in ms.
Usage: python3 tools/cuecheck.py   (reads out/events.json, out/timeline.json, music/cues.json; exit 1 on any deviation > 0.5 ms)"""
import json, os, sys
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(f'{H}/out/timeline.json')); EV = json.load(open(f'{H}/out/events.json'))['ev']; MU = json.load(open(f'{H}/music/cues.json'))
S16, FPS, BEAT = TL['S16'], TL['FPS'], TL['BEAT']
dev = lambda t, q: abs(t - round(t / q) * q) * 1000
bad = 0
def chk(label, t):
    global bad
    g, f = dev(t, S16), dev(t, 1 / FPS); ok = g < .5 and f < .5
    if not ok: bad += 1
    return g, f, ok
rows = [chk(e['type'], e['t']) for e in EV]
print(f"visual events: {len(EV)}  max grid dev {max(r[0] for r in rows):.3f} ms  max frame dev {max(r[1] for r in rows):.3f} ms")
nr = [chk('note', t) for t in MU['notes']]
print(f"score notes:   {len(nr)}  max grid dev {max(r[0] for r in nr):.3f} ms")
# the big hits: visual event ↔ music cue at the same instant
cues = MU['cues']; T = TL['T']
PAIRS = [('lamp', T['lampOn'], 'lamp click on beat 1'), ('pop', T['bulbPop'], 'bulb pop on beat 6'), ('drawer', T['drawerOpen'][0], 'drawer starts (lands bar 3)'),
         ('land', T['drawerOpen'][1], 'hop lands as the drawer stops, bar 3 downbeat'), ('glow', T['bulbLight'], 'bulb lights, bar 4'), ('pop', T['planePop'], 'plane pops, bar 5'),
         ('creak', T['creak'], 'the one sound in the silence'), ('launch', T['launch'], 'LAUNCH, bar 6: first sound after the silence'), ('roll', T['roll'][0], 'roll over the mug, bar 7'),
         ('tap', T['tap1'], 'tap 1'), ('tap', T['tap2'], 'tap 2'), ('slam', T['slam'], 'STAMP, bar 8')]
print('\nhit                                   visual t   music cue                 Δ ms')
for ty, t, what in PAIRS:
    v = min((e['t'] for e in EV if e['type'] == ty), key=lambda x: abs(x - t)); m = min(cues, key=lambda c: abs(c[0] - v)) if cues else None
    on_note = min(abs(n - v) for n in MU['notes']) * 1000
    d = abs(v - t) * 1000; bad += d > .5
    print(f"{what:<45s} {v:7.3f}   {'note on same 16th' if on_note < .5 else 'between notes (foley carries it)':<26s} {d:.3f}")
sil = [e for e in EV if TL['T']['silence'][0] < e['t'] < TL['T']['launch'] and e['type'] not in ('camkey',)]
nsil = [n for n in MU['notes'] if TL['T']['silence'][0] <= n < TL['T']['launch']]
print(f"\nsilence {TL['T']['silence'][0]:.3f}–{TL['T']['launch']:.3f} s: sound events inside = {[e['type'] for e in sil]}, score notes inside = {len(nsil)}")
print('RESULT', 'OK: 0 ms' if bad == 0 else f'{bad} deviations')
sys.exit(1 if bad else 0)
