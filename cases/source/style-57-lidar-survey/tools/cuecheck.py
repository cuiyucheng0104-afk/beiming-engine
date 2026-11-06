"""Cue check: every visual event (events.json, from the page's window.EV) against the music cue it must land on
(out/score.json, written by mix.py) and against the 84 BPM half-beat grid. Also measures, in the rendered mix,
that the silence is silent and that the first sound after it starts on the section beat.
Exit 1 if any cue is off by more than 1 ms."""
import json, os, sys
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(HERE, 'events.json')))['ev']
sc = {c['what']: c['t'] for c in json.load(open(os.path.join(HERE, 'out/score.json')))}
tl = json.load(open(os.path.join(HERE, 'timeline.json')))
B, FPS = tl['beat'], tl['fps']
PAIR = {'scan': 'scan di', 'land': 'land ping', 'crane': 'pulse in', 'condense': 'condense impact', 'solid': 'solid chord',
        'section': 'SECTION impact', 'reading': 'reading ping', 'wind': 'wind returns'}
bad = 0; rows = []
for e in ev:
    t = e['t']; beat = t / B; grid = abs(beat * 2 - round(beat * 2)) * B / 2 * 1000
    music = None
    if e['type'] in PAIR: music = (t - sc[PAIR[e['type']]]) * 1000
    if e['type'] == 'trace' and e.get('i') == 0: music = (t - sc['trace notes']) * 1000
    fr = round(t * FPS); q = (fr / FPS - t) * 1000
    ok = grid < 1 and (music is None or abs(music) < 1)
    bad += not ok
    rows.append((t, e['type'], beat, grid, music, fr, q, ok))
print(f'{"t (s)":>8} {"event":<10} {"beat":>6} {"grid ms":>8} {"music ms":>9} {"frame":>6} {"frame q ms":>10}')
for t, ty, beat, grid, music, fr, q, ok in rows:
    print(f'{t:8.4f} {ty:<10} {beat:6.2f} {grid:8.2f} {"" if music is None else f"{music:9.2f}":>9} {fr:6d} {q:10.2f} {"" if ok else "  <-- OFF"}')
# the silence and the first sound after it, measured in the mix
x, sr = sf.read(os.path.join(HERE, 'out/mix.wav')); m = np.abs(x).max(1)
T = tl['T']
sil = m[int((T['sil'] + .3) * sr):int((T['cut'] - .005) * sr)]
prog = np.sqrt((x ** 2).mean())
rmsenv = np.sqrt(np.convolve((x ** 2).mean(1), np.ones(96) / 96, mode='same'))      # 2 ms RMS envelope
silr = rmsenv[int((T['sil'] + .3) * sr):int((T['cut'] - .005) * sr)]
i0 = int((T['cut'] - .05) * sr)
on = i0 + int(np.argmax(rmsenv[i0:i0 + int(.15 * sr)] > 4 * silr.max()))
print(f'silence b{tl["HIT"]["sil"]}+0.3s .. b{tl["HIT"]["cut"]}: rms {20*np.log10(np.sqrt((silr**2).mean())):.1f} dBFS (peak {20*np.log10(sil.max()+1e-9):.1f}), programme rms {20*np.log10(prog):.1f} dBFS')
print(f'first sound after the silence starts {(on / sr - T["cut"]) * 1000:+.1f} ms from the section beat')
print('max |music - picture| on paired cues: %.3f ms' % max(abs(r[4]) for r in rows if r[4] is not None))
print('max frame quantisation (24 fps vs 84 BPM): %.1f ms' % max(abs(r[6]) for r in rows))
print('OK' if not bad else f'{bad} cue(s) off'); sys.exit(1 if bad else 0)
