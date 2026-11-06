"""Every key action sits on the 88 BPM grid, has its sound event in events.json, and the sound is really there in the mix.
usage: python -I tools/cuecheck.py <film_dir>     exit 1 on any miss
  grid ms  : visual cue time vs the nearest grid line (quarter beat; 1/8 beat for the pick-out cascade)
  ev ms    : the sound event (window.EV, which mix.py reads) vs the visual cue
  frame ms : when the change first appears in a 24 fps frame (render samples t + 1/48 s), for information
  onset ms : the measured attack in out/mix.wav (energy rise in a ±70 ms window) vs the cue, for the designed hits"""
import sys, os, json, math
import numpy as np, soundfile as sf
D = sys.argv[1]
TL = json.load(open(os.path.join(D, 'timeline.json'))); EVJ = json.load(open(os.path.join(D, 'events.json')))
T = TL['T']; beat = TL['beat']; EV = EVJ['ev']
SOUND = {'houseOff': 'relay', 'fan': 'fan', 'lamp': 'lamp', 'r1': 'readout', 'trace': 'trace', 'measure': 'measure', 'sunset': 'sunset', 'r2': 'readout', 'tick8': 'tick', 'tick16': 'tick',
         'sill': 'sill', 'top': 'top', 'hit': 'hit', 'line2': 'land', 'crest': 'crest', 'coda': 'coda', 'end': 'end'}
ONSET = {'houseOff', 'lamp', 'hit', 'line2'}
mix = None
p = os.path.join(D, 'out', 'mix.wav')
if os.path.exists(p):
    x, sr = sf.read(p); mix = (x.mean(1) if x.ndim > 1 else x, sr)
def onset(t):
    """first 1 ms hop after t-30 ms whose level is 6 dB over the level in the 30 ms before that"""
    if mix is None: return None
    x, sr = mix; hop = int(.001 * sr)
    a = int((t - .06) * sr); seg = x[a:a + int(.14 * sr)]
    e = np.array([np.sqrt(np.mean(seg[i:i + hop] ** 2) + 1e-12) for i in range(0, len(seg) - hop, hop)])
    base = np.sqrt(np.mean(e[:30] ** 2)); i0 = 30
    for i in range(i0, len(e)):
        if e[i] > base * 2: return (a + i * hop) / sr - t
    return None
bad = 0; worst_grid = 0; worst_ev = 0; worst_frame = 0
print(f'{"cue":9s} {"time":>7s} {"beat":>6s} {"grid ms":>8s} {"ev ms":>6s} {"frame ms":>8s} {"onset ms":>8s}  sound')
for k, snd in SOUND.items():
    t = T[k]; bq = t / beat * 4; off = (bq - round(bq)) * beat / 4 * 1000
    hit = [e for e in EV if e['type'] == snd and abs(e['t'] - t) < 0.002]
    evms = (hit[0]['t'] - t) * 1000 if hit else float('nan')
    fr = (math.ceil((t - 1 / 48) * 24 - 1e-9) / 24 - t) * 1000   # render() samples half a frame ahead
    on = onset(t) if k in ONSET else None
    ok = abs(off) < 1 and bool(hit) and abs(evms) < 1; bad += not ok
    worst_grid = max(worst_grid, abs(off)); worst_ev = max(worst_ev, abs(evms) if hit else 0); worst_frame = max(worst_frame, abs(fr))
    print(f'{k:9s} {t:7.3f} {t / beat:6.2f} {off:8.2f} {evms:6.2f} {fr:8.1f} {"" if on is None else f"{on * 1000:8.1f}":>8s}  {snd if hit else "MISSING " + snd} {"" if ok else "<--"}')
# every tick and every pick-out on its grid
for typ, div in (('tick', 4), ('pick', 8), ('hour', 1)):
    es = [e for e in EV if e['type'] == typ]
    offs = [abs((e['t'] / beat * div - round(e['t'] / beat * div)) * beat / div * 1000) for e in es]
    w = max(offs) if offs else 0; bad += w >= 1; worst_grid = max(worst_grid, w)
    print(f'{typ:9s} {len(es):3d} events, worst grid offset {w:.3f} ms (1/{div} beat grid)')
print(f'worst: grid {worst_grid:.3f} ms, event vs picture {worst_ev:.3f} ms, frame quantisation up to {worst_frame:.1f} ms')
print('all cues on the grid with their sounds' if not bad else f'{bad} cue(s) off')
sys.exit(1 if bad else 0)
