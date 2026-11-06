"""Music + foley + the vinyl bed → one stereo mix at the film's length, about −16 LUFS (mux.sh masters it to −14), peaks under −3 dBFS.
No voice: the score leads, the foley sits just under it and is lifted where the score is thin; the vinyl bed (crackle, hiss, a faint
turntable rumble) runs the whole film and is the only thing left in the silence. Usage: mix.py <score.wav> <sfx.wav> <timeline.json> <out.wav>"""
import sys, os, json, subprocess, tempfile, re, wave
import numpy as np
sys.path.insert(0, os.path.join(os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar')), 'core/audio'))
from sfx import SR, limit, bp, lp, hp

def read(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, '<f4').astype(np.float64).reshape(-1, 2)
TL = json.load(open(sys.argv[3])); DUR = TL['DUR']; T = TL['T']
N = int(round(DUR * SR))
def fit(x): return x[:N] if len(x) >= N else np.vstack([x, np.zeros((N - len(x), 2))])
m, f = fit(read(sys.argv[1])), fit(read(sys.argv[2]))
for c in range(2): m[:, c] -= .5 * lp(lp(m[:, c], 110), 110)          # tame the synthetic low end (kick + double bass) to ~-3 dB under the mids

# the vinyl bed: sparse crackle (two sizes), soft hiss, a 0.55 Hz turntable rumble
r = np.random.default_rng(1977); tt = np.arange(N) / SR
crk = np.zeros(N)
for rate, amp, w in [(9, .5, 6), (55, .12, 2)]:
    idx = r.integers(0, N - 50, int(DUR * rate))
    for i in idx: crk[i:i + w] += amp * r.uniform(-1, 1) * np.hanning(w)
crk = hp(crk, 1200)
hiss = lp(hp(r.standard_normal(N), 1500), 7000) * .02
rumble = lp(r.standard_normal(N), 60) * .5 * (1 + .3 * np.sin(2 * np.pi * .55 * tt))
vin = np.stack([crk + hiss + rumble * .08, np.roll(crk, 37) + np.roll(hiss, 911) + rumble * .08], 1)
vin *= 10 ** (-41 / 20) / np.sqrt(np.mean(vin ** 2))          # about −41 dBFS RMS before the loudness match: a bed, not a layer
vin[:int(.25 * SR)] *= np.linspace(0, 1, int(.25 * SR))[:, None]
# the room under the music: a very quiet brown-ish tone (a desk by a window)
room = lp(np.cumsum(r.standard_normal(N)) * .002, 300); room -= np.mean(room); room = np.stack([room, np.roll(room, 501)], 1)
room *= 10 ** (-52 / 20) / max(1e-9, np.sqrt(np.mean(room ** 2)))

# where the score is thin, lift the foley a touch; in the silence the vinyl comes up 3 dB and stands alone
menv = np.sqrt(np.convolve(np.mean(m ** 2, 1), np.ones(int(.2 * SR)) / int(.2 * SR), 'same'))
lift = 1 + .3 * (menv < .02)
s0, s1 = int(T['silence'][0] * SR), int(T['launch'] * SR)
vg = np.ones(N); vg[s0:s1] = 10 ** (5 / 20); k = int(.15 * SR); vg[s0 - k:s0] = np.linspace(1, vg[s0], k)
mix = m * 1.0 + f * (10 ** (-1.5 / 20)) * lift[:, None] + vin * vg[:, None] + room
fade = int(.06 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
for c in range(2): mix[:, c] = limit(mix[:, c], .8)

def lufs(x):
    with tempfile.NamedTemporaryFile(suffix='.wav') as tf:
        with wave.open(tf.name, 'wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
        err = subprocess.run(['ffmpeg', '-nostats', '-i', tf.name, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', err)[-1])
for _ in range(2):
    mix *= 10 ** ((-16.0 - lufs(mix)) / 20)
    for c in range(2): mix[:, c] = limit(limit(mix[:, c], .58, .004), .6, .0015)
print('mix loudness', lufs(mix), 'LUFS', 'peak', round(float(np.abs(mix).max()), 3))
# energy per band (the low end should not swamp the rest)
def band(x, lo, hi): y = bp(x.mean(1), lo, hi); return 10 * np.log10(np.mean(y ** 2) + 1e-12)
print('bands dB  20-120:', round(band(mix, 20, 120), 1), ' 120-2k:', round(band(mix, 120, 2000), 1), ' 2k-8k:', round(band(mix, 2000, 8000), 1))
with wave.open(sys.argv[4], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
print('wrote', sys.argv[4])
