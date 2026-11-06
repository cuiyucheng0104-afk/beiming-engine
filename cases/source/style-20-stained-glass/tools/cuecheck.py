"""Beat check: every visual cue vs the beat grid, the score's note onsets, the rendered frames and the final audio.
Run (after the render): $LIB/.venv/bin/python tools/cuecheck.py [film.mp4]
- grid:  cue time vs the nearest 1/4-beat of the 72 BPM grid
- score: cue time vs the score note that carries it (music/cues.json)
- frame: the frame where the picture actually changes most (frame-difference peak, +-3 frames) vs the cue
- audio: the onset in the final soundtrack (energy-rise peak, +-60 ms) vs the cue
"""
import sys, os, json, subprocess, numpy as np
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(D, 'timeline.json'))); BEAT, FPS = TL['BEAT'], TL['FPS']
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
cues = [(e['name'], e['t']) for e in EV if e['type'] == 'cue']
score = {c['name']: c['t'] for c in json.load(open(os.path.join(D, 'music', 'cues.json')))['cues']}
film = sys.argv[1] if len(sys.argv) > 1 else os.path.join(D, '20-stained-glass.mp4')

W, H = 160, 90
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', film, '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)
# picture change per frame: pixels that changed a lot (a light switching on, a crack, a cut), minus the smooth trend of camera motion
dif = np.zeros(len(F)); dif[1:] = (np.abs(np.diff(F, axis=0)) > 12).mean((1, 2))
spk = dif.copy()
for f in range(len(F)): w = dif[max(1, f - 3):f + 4]; spk[f] = dif[f] - np.median(w)
pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', film, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True).stdout
A = np.frombuffer(pcm, np.float32); hop, nf = 120, 1024
nfr = (len(A) - nf) // hop; idx = np.arange(nf)[None, :] + hop * np.arange(nfr)[:, None]
S = np.log(np.abs(np.fft.rfft(A[idx] * np.hanning(nf), axis=1)) + 1e-6)
flux = np.zeros(nfr); flux[1:] = np.maximum(S[1:] - S[:-1], 0).sum(1)
tf = (np.arange(nfr) * hop + nf / 2) / 48000   # frame centre times

def frame_onset(t):
    """first frame (cue frame +-3) whose picture change jumps above the local background of the frames before it"""
    fe = int(round(t * FPS)); base = np.median(dif[max(1, fe - 6):fe - 1]) if fe > 2 else 0
    for f in range(max(1, fe - 3), min(len(dif), fe + 4)):
        if dif[f] > 1.6 * base + .004: return (f / FPS - t) * 1000, dif[f]
    return None, 0
def audio_onset(t):
    m = (tf > t - .05) & (tf < t + .05); k = np.flatnonzero(m)
    j = k[int(np.argmax(flux[k]))]; return (tf[j] - t) * 1000
rows, worst = [], {'grid': 0, 'score': 0, 'frame': 0, 'audio': 0}
print(f"{'cue':12s} {'t(s)':>8s} {'beat':>6s} {'grid':>7s} {'score':>7s} {'frame':>7s} {'audio':>7s}")
for name, t in cues:
    bt = t / BEAT; grid = (t - round(bt * 4) / 4 * BEAT) * 1000
    sc = (t - score[name]) * 1000 if name in score else None
    fr, mag = frame_onset(t); au = audio_onset(t)
    worst['grid'] = max(worst['grid'], abs(grid)); worst['frame'] = max(worst['frame'], abs(fr)) if fr is not None else worst['frame']; worst['audio'] = max(worst['audio'], abs(au))
    if sc is not None: worst['score'] = max(worst['score'], abs(sc))
    print(f"{name:12s} {t:8.4f} {bt:6.2f} {grid:7.1f} {('%7.1f' % sc) if sc is not None else '      -'} {('%7.1f' % fr) if fr is not None else '  (cam)'} {au:7.1f}")
print('max |deviation| ms:', {k: round(v, 1) for k, v in worst.items()})
