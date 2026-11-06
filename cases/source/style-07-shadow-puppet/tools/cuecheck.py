"""Cue check: picture events (events.json, from window.EV) vs the score (out/score_cues.json) and the actual audio.
1. every picture hit sits on the beat grid of its section (beat or half-beat), and on a whole frame at 24 fps;
2. every picture hit that has a musical partner finds it at the same time (planned deviation);
3. every musical cue's measured attack in its rendered stem (25 % rise of the high-passed 3 ms RMS envelope) vs the planned time.
Run: $LIB/.venv/bin/python tools/cuecheck.py  → prints a table, exits 1 if anything is off by more than 1 frame."""
import os, json, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
TL = json.load(open(os.path.join(HERE, 'out/timeline.json'))); T = TL['t']; FPS = TL['fps']
CUES = {c['name']: c for c in json.load(open(os.path.join(HERE, 'out/score_cues.json')))}
SECS = TL['secs']

def grid_off(t):
    s = [x for x in SECS if x['t'] <= t + 1e-6][-1]; b = 60 / s['bpm'] / 2
    k = round((t - s['t']) / b); return (t - (s['t'] + k * b)) * 1000, f"{s['id']}{k / 2:g}"

PAIR = {('ignite', 0): 'lamp1', ('ignite', 1): 'lamp2', ('ignite', 2): 'lamp3', 'cast': 'cast', 'splash': 'splash', 'pearlup': 'pearl',
        'surge': 'surge', 'breach': 'breach', 'roar': 'liang', 'crashzoom': 'crash', 'slam': 'gong', 'ting': 'ting', 'swap': 'swap', 'bow': 'bow'}
stems = {k: sf.read(os.path.join(HERE, f'out/stems/{k}.wav'), dtype='float32') for k in ['luogu', 'jinghu', 'suona', 'bell', 'sanxian']}

from scipy.signal import butter, sosfilt
HPF = {}
def attack(stem, t):
    """onset = first point after t − 40 ms where the 3 ms RMS envelope of the 1.5 kHz high-passed stem climbs 25 % of the way
    from the floor before (median over [t − 40, t − 5] ms) to the new peak (max over [t, t + 80 ms]).
    The high-pass keeps strike transients and drops the low ringing of earlier gongs."""
    if stem not in HPF:
        x, sr = stems[stem]; y = sosfilt(butter(4, 1500, 'high', fs=sr, output='sos'), x.mean(1))
        k = int(.003 * sr); HPF[stem] = (np.sqrt(np.convolve(y * y, np.ones(k) / k, 'same')), sr)
    env, sr = HPF[stem]
    a, c, b = max(0, int((t - .04) * sr)), int(t * sr), int((t + .08) * sr)
    fl = env[a:max(a + 1, int((t - .005) * sr))]; base = np.median(fl); pk = env[c:b].max()
    if pk < base * 1.3 + 1e-6: return None
    i = np.argmax(env[a:b] > base + .25 * (pk - base)); return (a + i) / sr

bad = 0; rows = []
print(f"{'event':12s} {'t (s)':>8s} {'frame':>6s} {'grid':>6s} {'grid ms':>8s} {'cue':>8s} {'plan ms':>8s} {'audio ms':>9s}")
for e in EV:
    t = e['t']; fr = t * FPS; fq = abs(fr - round(fr)) * 1000 / FPS
    go, gname = grid_off(t)
    key = (e['type'], e.get('i')) if e['type'] == 'ignite' else e['type']
    cn = PAIR.get(key); plan = aud = ''
    if cn:
        c = CUES[cn]; plan = (c['t'] - t) * 1000; at_ = attack(c['stem'], c['t']); aud = (at_ - t) * 1000 if at_ is not None else float('nan')
        if abs(plan) > 1 or (aud == aud and abs(aud) > 1000 / FPS): bad += 1
    if fq > .5 or abs(go) > .5: bad += 1
    print(f"{e['type']:12s} {t:8.4f} {fr:6.1f} {gname:>6s} {go:8.1f} {cn or '':>8s} {plan if plan == '' else f'{plan:8.1f}':>8} {aud if aud == '' else f'{aud:9.1f}':>9}")
print('\nmusic cues (attack placed on the frame; measured in the rendered stem where the hit stands clear of earlier tails):')
devs = []
for n, c in sorted(CUES.items(), key=lambda kv: kv[1]['t']):
    a = attack(c['stem'], c['t'])
    if a is None or a <= c['t'] - .039: print(f"  {n:10s} {c['t']:8.4f}  attack compensation {c.get('comp_ms', 0):5.1f} ms   stem: masked by earlier hits"); continue
    d = (a - c['t']) * 1000; devs.append(d)
    print(f"  {n:10s} {c['t']:8.4f}  attack compensation {c.get('comp_ms', 0):5.1f} ms   stem attack {d:+6.1f} ms")
d = np.array(devs)
print(f"\npicture ↔ score plan: {'0.0 ms for every paired hit' if bad == 0 else f'{bad} problems'}")
print(f"measured stem attacks ({len(d)} clear cues): mean {d.mean():+.1f} ms, median {np.median(d):+.1f} ms, max |{np.abs(d).max():.1f}| ms (1 frame = {1000 / FPS:.1f} ms)")
sys.exit(1 if bad else 0)
