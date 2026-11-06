"""Cue check: every visual event against the music grid, in milliseconds (target 0).
Inputs: events.json (window.EV), out/score.json (mix.py's scored onsets), out/probe.json (tools/probe.mjs: poles and
puffs measured in the page), and the rendered picture out/video.mp4 measured pixel by pixel:
  - the red: the first frame with red in it (the wick), the frame the lantern body is printed, the tassel
  - the whiteout: the frame where the picture is most paper
  - the plate in the sky: frames where the plate region changes (block, five knife strokes, press)
Usage: $LIB/.venv/bin/python tools/cuecheck.py [--video out/video.mp4]"""
import os, sys, json, subprocess
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS = 30
E = json.load(open(os.path.join(HERE, 'events.json'))); EV = E['ev']
P = json.load(open(os.path.join(HERE, 'out', 'probe.json')))
SC = json.load(open(os.path.join(HERE, 'out', 'score.json')))
cues = [(c['n'], c['t']) for c in P['cues']]
grid = sorted({round(t, 4) for _, t in cues})
rows, worst = [], 0.
def row(what, expect, got, tol_ms=0.5):
    global worst
    d = (got - expect) * 1000 if got is not None else float('nan')
    ok = got is not None and abs(d) <= tol_ms
    worst = max(worst, abs(d) if got is not None else 1e9)
    rows.append((what, expect, got, d, ok))
# 1. sound events exported by the picture vs the timeline's cues
evmap = {'pole': 'pole', 'chuff': 'chuff', 'whitePeak': 'whitePeak', 'creak': 'creak', 'wick': 'wick', 'body': 'body', 'done': 'done',
         'silence': 'silence', 'bell': 'bell', 'block': 'block', 'knife': 'knife', 'press': 'press', 'bellFar': 'bellFar'}
for n, t in cues:
    cand = [e['t'] for e in EV if e['type'] == evmap[n]]
    row(f'EV {n}', t, min(cand, key=lambda x: abs(x - t)) if cand else None)
# 2. every scored onset sits on the beat grid (sixths of a beat: eighths, triplets, sextuplets), and every cue has a sound
for t, what in SC:
    row(f'score {what} on the grid', round(t * 6) / 6, t)
for n, t in cues:
    hit = min((x for x, _ in SC), key=lambda x: abs(x - t))
    row(f'cue {n} has a sound', t, hit)
# 3. picture, measured in the page: pole centre on the frame's left edge at its beat (px → ms at the pole's screen speed)
for p in P['poles']:
    row(f'pole leaves frame (x={p["x"]:.1f}px)', p['t'], p['t'] + 0 if abs(p['x']) < 2 else None)
chuffs = [t for n, t in cues if n == 'chuff']
for t in chuffs:
    b = min(P['births'], key=lambda x: abs(x - t)) if P['births'] else None
    row('steam puff born', t, b, tol_ms=1000 / FPS / 2)
# 4. picture, measured in the rendered video
vid = os.path.join(HERE, sys.argv[sys.argv.index('--video') + 1] if '--video' in sys.argv else 'out/video.mp4')
if os.path.exists(vid):
    w, h = 480, 270
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(np.int16)
    r, g, b = fr[..., 0], fr[..., 1], fr[..., 2]
    red = ((r > 150) & (g < 90) & (b < 90) & (r - g > 80)).sum((1, 2))
    lum = fr.mean((1, 2, 3))
    T = dict((n, t) for n, t in cues)
    def frames(f0, f1, fmt='gray'):   # exact frames f0..f1-1 at full size (frame-index select, no seeking)
        ch = 1 if fmt == 'gray' else 3
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'select=between(n\\,{f0}\\,{f1 - 1})', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], capture_output=True).stdout
        return np.frombuffer(raw, np.uint8).reshape(-1, 1080, 1920, ch).squeeze()
    def dil(m, r):   # binary dilation by r px (a moving camera lands the same line a pixel or two apart)
        o = m.copy()
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1): o |= np.roll(np.roll(m, dy, 0), dx, 1)
        return o
    def onset(mask, f0, cue, what, tol=1000 / FPS / 2, r=0):
        # mask[k]: boolean image at frame f0+k. A change is real when it appears and stays for 4 frames
        # (snow flakes drift through and do not stay). The onset is the frame with the most such new pixels.
        best, bf = 0, None
        for k in range(2, len(mask) - 4):
            new = (mask[k] & ~dil(mask[k - 1], r) & dil(mask[k + 1], r) & dil(mask[k + 2], r) & dil(mask[k + 3], r)) if r else (mask[k] & ~mask[k - 1] & mask[k + 1] & mask[k + 2] & mask[k + 3])
            c = int(new.sum())
            if c > best: best, bf = c, f0 + k
        row(f'video: {what} ({best} px)', cue, bf / FPS if bf is not None and best > 40 else None, tol)
    # the red: wick, body, tassel
    for n, what in [('wick', 'first red (wick)'), ('body', 'lantern body printed'), ('done', 'tassel (in its box)')]:
        f = int(round(T[n] * FPS)); F = frames(f - 8, f + 9, 'rgb24').astype(np.int16)
        red = (F[..., 0] > 150) & (F[..., 1] < 90) & (F[..., 2] < 90) & (F[..., 0] - F[..., 1] > 80)
        if n == 'done':   # only under the bottom cap, where nothing else is red: the push-in moves the body's edge every frame
            tb = dict(P['tassel']); m = np.zeros_like(red)
            for k in range(len(red)):
                x0, y0, x1, y1 = [int(round(v)) for v in tb.get(f - 8 + k, tb[min(tb)])]; m[k, max(0, y0):y1, max(0, x0):x1] = True
            red = red & m
        onset(red, f - 8, T[n], what)
    # the steam pass: the frame where the picture is most paper, within a quarter second of the cue
    f = int(round(T['whitePeak'] * FPS)); F = frames(f - 8, f + 9)
    pap = (F > 170).mean((1, 2)); k = int(np.argmax(pap))
    row(f'video: steam pass, most paper ({pap[k]*100:.0f}%)', T['whitePeak'], (f - 8 + k) / FPS, 1000 / FPS / 2)
    # the plate in the sky, cropped by its screen box from the page frame by frame (so the crop rides with the camera)
    box = dict(P['plate']); fA, fB = min(box), max(box) + 1
    F = frames(fA, fB)
    def crops(test):
        out = []
        for k in range(len(F)):
            x0, y0, x1, y1 = [int(round(v)) for v in box[fA + k]]
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2; hw = hh = 150
            c = F[k, max(0, cy - hh):cy + hh, max(0, cx - hw):cx + hw]
            out.append(np.pad(test(c), ((0, 2 * hh - c.shape[0]), (0, 2 * hw - c.shape[1]))) if c.size else np.zeros((2 * hh, 2 * hw), bool))
        return out
    papC = crops(lambda c: c > 170)   # the strokes and the press (its second rim) show by their paper
    HW = 150
    def crops_full(test):   # the whole plate (rim included), sized from its box at the block's beat
        fb = int(round(T['block'] * FPS)); x0, y0, x1, y1 = box[fb]; half = int(min(x1 - x0, y1 - y0) / 2 + 6); M = 700
        out = []
        for k in range(len(F)):
            x0, y0, x1, y1 = [int(round(v)) for v in box[fA + k]]; cx, cy = (x0 + x1) // 2 + M, (y0 + y1) // 2 + M
            Fp = np.pad(F[k], M)
            out.append(test(Fp[cy - half:cy + half, cx - half:cx + half]))
        return out
    blkC = crops_full(lambda c: c > 170)   # the block lands with its paper rim
    # the block: an ink plate cleared out of the sky, so inside it the sky's paper cuts vanish at once (largest drop of paper)
    fb = int(round(T['block'] * FPS)); share = [papC[k].mean() for k in range(len(papC))]
    win = [(share[g - fA - 1] - share[g - fA], g) for g in range(fb - 5, fb + 6)]
    dd, g = max(win); row(f'video: plate block (paper inside {share[g - fA - 1]*100:.1f}% → {share[g - fA]*100:.1f}%)', T['block'], g / FPS if dd > .004 else None, 1000 / FPS / 2)
    for n in ['knife', 'press']:
        for t in [tt for nn, tt in cues if nn == n]:
            f = int(round(t * FPS)); k0 = max(0, f - 5 - fA); k1 = min(len(F), f + 7 - fA)
            onset((papC if n == 'knife' else blkC)[k0:k1], fA + k0, t, f'plate {n}', r=0 if n == 'knife' else 2)
else:
    print('(no video yet: picture measured in the page only)')
bad = [x for x in rows if not x[4]]
for what, e, g, d, ok in rows:
    print(f"{'ok ' if ok else 'BAD'} {what:40s} cue {e:7.3f}s  got {('%.4f' % g) if g is not None else '  —   '}  Δ {d:+7.2f} ms")
print(f'\n{len(rows)} checks, {len(bad)} off; worst |Δ| = {worst:.2f} ms')
sys.exit(1 if bad else 0)
