"""Cue check: every visual event the page emits (events.json, measured by the engine) against the score's hits
(out/score_hits.json, written by mix.py on the 16th-note grid). A visual event counts at the first frame that shows it
(30 fps). Prints each pair and the deviation in ms; exits 1 if any key event misses its hit by more than half a frame."""
import json, math, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS = 30; BEAT = 60 / 112.5; G16 = BEAT / 4
ev = json.load(open(os.path.join(HERE, 'events.json')))['ev']; hits = json.load(open(os.path.join(HERE, 'out', 'score_hits.json')))
H = {}
for h in hits: H.setdefault(h['what'], []).append(h['t'])
def frame_t(t): return math.ceil(t * FPS - .05) / FPS           # first frame that draws it (events.json rounds to 1 ms = 0.03 frame)
rows, worst = [], 0.0
def check(label, tv, key):
    global worst
    ts = H.get(key)
    if not ts: rows.append((label, tv, None, None, 'NO HIT ' + key)); worst = max(worst, 999); return
    th = min(ts, key=lambda x: abs(x - tv)); d = (frame_t(tv) - th) * 1000; worst = max(worst, abs(d))
    rows.append((label, tv, th, d, key))
for e in ev:
    ty = e['type']
    if ty == 'stop': check('stop ' + e['id'], e['t'], 'chime' if e['id'] == 'BY' else 'stop:' + e['id'])
    elif ty in ('x', 'drop'): check(ty + ' ' + e['id'], e['t'], ty + ':' + e['id'])
    elif ty == 'spin': check('year lands ' + str(e['y1']), e['t1'], 'year:' + str(e['y1']))
    elif ty == 'cue' and e['name'] in ('dive', 'surface', 'bridgeN', 'bridgeS', 'silence', 'land'): check('cue ' + e['name'], e['t'], e['name'])
    elif ty == 'cue' and e['name'] in ('endChime', 'newHome', 'open'): check('cue ' + e['name'], e['t'], 'chime')
    elif ty == 'cut': check('cut ' + e['kind'], e['t'], {'glide': 'stop:SD', 'hard': 'silence' if abs(e['t'] - 29 * BEAT) < .01 else 'x:CZW', 'rise': 'land'}[e['kind']])
off = [h for h in hits if abs(h['t'] / G16 - round(h['t'] / G16)) > 1e-4]
for r in rows: print(f"{r[0]:<22} visual {r[1]:7.3f}s  frame {frame_t(r[1]):7.3f}s  score {('%7.3f' % r[2]) if r[2] is not None else '   --  '}s  dev {('%+5.1f' % r[3]) if r[3] is not None else '  ?? '} ms  [{r[4]}]")
print(f'{len(rows)} visual events checked; max |deviation| = {worst:.1f} ms; score hits off the 16th grid: {len(off)} of {len(hits)}')
sys.exit(0 if worst <= 1000 / FPS / 2 and not off else 1)
