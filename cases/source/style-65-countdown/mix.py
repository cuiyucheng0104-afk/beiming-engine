"""T−15 mix: clock ticks, interface foley, launch sound (synthesised) and an original score (sampled + numpy).
No narration and no broadcast commentary (the user's decision); every sound is placed from window.EV (events.json),
which is built from timeline.js — the one source of time.
60 BPM: beat k = film second k = one tick. Pre-zero: an open C–G drone (no third) with a heartbeat that adds layers;
the count accelerates (8ths → 16ths → 32nds) and stops dead at the T−1 tick; one silent beat; T−0: A♭ major in low brass
(♭VI), resolving to C major on the hard cut at T+2.
Run: $LIB/.venv/bin/python mix.py   → out/mix.wav, out/stems/*.wav, out/cues.json (musical cue times for the beat check)"""
import json, os, subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf
HERE = Path(__file__).resolve().parent
LIB = Path(os.environ.get("LIB", "@@LEMO_ROOT@@"))
sys.path.insert(0, str(LIB))
from core.audio import sfx, sampler as S
from core.audio.sfx import SR, t_, env_exp, lp, hp, bp, noise, norm, add

S.seed(15); sfx._rng = np.random.default_rng(15)
ev = json.load(open(HERE / "events.json"))
DUR = ev["dur"]; EV = ev["ev"]; N = int(round(DUR * SR))
T0 = next(e["t"] for e in EV if e["type"] == "merge")
SIL0, SIL1 = next((e["t"], e["t1"]) for e in EV if e["type"] == "silence")
CUT = next(e["t"] for e in EV if e["type"] == "cut")
OPENS = [e for e in EV if e["type"] == "open"]
SWAPS = [e for e in EV if e["type"] == "swap"]
def bus(): return np.zeros((N, 2))
ticks, fol, amb, mus, launch = bus(), bus(), bus(), bus(), bus()
CUES = []   # (t, what) — musical hits that a visual event must sit on
def cue(t, what): CUES.append({"t": round(t, 4), "what": what})

# ——— 1. The clock: a tick on every whole second; two alternating pitches, louder in the last ten; a soft single pitch after zero ———
def tick(fq, v, d=.05):
    tt = t_(d); x = np.sin(2 * np.pi * fq * tt) * env_exp(d, .010) + hp(noise(d), 4000) * env_exp(d, .0015) * .6
    return norm(x) * v
for e in EV:
    if e["type"] != "tick": continue
    t, n = e["t"], e["n"]
    if t < T0:
        last = t >= T0 - 1.01
        add(ticks, tick(1850 if n % 2 else 1480, .95 if last else (.62 if e["loud"] else .42)), t, 1, pan=.15 if n % 2 else -.15)
        cue(t, "tick")
    else:
        add(ticks, tick(1250, .22), t, 1); cue(t, "tick+")

# ——— 2. Interface foley (window.EV) ———
def snap(v=1.0):   # a cell lands: metallic click + small low thump
    d = .09; tt = t_(d)
    x = hp(noise(d), 3000) * env_exp(d, .003) + np.sin(2 * np.pi * 2400 * tt) * env_exp(d, .01) * .4 + np.sin(2 * np.pi * 110 * tt) * env_exp(d, .03) * .7
    return norm(x) * v
def tsk(v=1.0, fc=6000):   # a tile wipes in: short bright brush
    d = .07; return norm(bp(noise(d), fc * .6, min(fc * 1.6, 20000)) * env_exp(d, .012)) * v
def ping(v, fq=3520):     # the orange landing border
    d = .25; tt = t_(d); return norm(np.sin(2 * np.pi * fq * tt) * env_exp(d, .04)) * v
for e in EV:
    t, ty = e["t"], e["type"]
    if ty == "open":
        add(fol, snap(.75), t, 1, pan=-.2 if e["id"] in ("mcc", "v8", "mlp") else (.25 if e["id"] in ("fair", "srm", "flag") else 0))
        add(fol, ping(.12), t + .2, 1, pan=.2)
    elif ty == "relayout":
        add(fol, sfx.whoosh(.30, .55), t - .12, 1, pan=-.3); add(fol, snap(.9), t, 1); add(fol, snap(.5), t + .34, 1, pan=.3)
    elif ty == "flag":
        if e["t"] < T0: add(fol, sfx.whoosh(.22, .32), t - .06, 1, pan=-.3); add(fol, snap(.45), t, 1)
        else: add(fol, snap(.4), t, 1, pan=.3)
    elif ty == "punch":
        add(fol, sfx.thump(.7, 62), t, 1); add(fol, snap(.5), t, 1)
    elif ty == "swap":
        add(fol, tsk(.5 + .05 * e["i"], 5000 + 400 * e["i"]), t, 1, pan=(-.4 + .1 * e["i"]))
    elif ty == "flip":
        add(fol, sfx.clack(1.0, .7), t, 1)
    elif ty == "cut":
        add(fol, sfx.thump(.9, 55), t, 1)

# ——— 3. Ambience and the launch ———
def fade(x, a=.05, b=.05):
    n = len(x); f = np.ones(n); ka, kb = int(a * SR), int(b * SR)
    if ka: f[:ka] = np.linspace(0, 1, ka)
    if kb: f[-kb:] = np.minimum(f[-kb:], np.linspace(1, 0, kb))
    return x * f
# control-room hum (f0 → silence)
d = SIL0; hum = lp(sfx.brown(d), 220) + .15 * np.sin(2 * np.pi * 60 * t_(d)) + .08 * np.sin(2 * np.pi * 120 * t_(d))
add(amb, fade(norm(hum) * .10, .5, .03), 0, 1)
# venting hiss from T−12 (the igniters) and the RS-25 rumble from T−6.36 (the engines' real start), both cut by the silence
d = SIL0 - 3.0; hiss = lp(hp(noise(d), 1500), 7000) * np.minimum(1, t_(d) / 1.5)
add(amb, fade(hiss * .025, .3, .03), 3.0, 1, pan=.2)
rs = T0 - 6.36; d = SIL0 - rs; rum = hp(lp(sfx.brown(d), 160), 40) + .4 * lp(hp(noise(d), 200), 900)
rum = norm(rum) * (np.minimum(1, t_(d) / 2.5) ** 1.5) * .55
add(amb, fade(rum, .4, .03), rs, 1)
# T−0: ignition hit + roar (the loudest moment); crackle grows as the rocket climbs
add(launch, sfx.ignite(1.0), T0, 1.0)
d = DUR - T0; r = sfx.roar(d + .3, 1.0)[:int(d * SR)]
r = hp(r, 55) + .6 * bp(r, 300, 2500)   # less sub, more body you can hear on small speakers
shape = np.minimum(1, t_(d) / .35) * (1 - .25 * np.clip((t_(d) - 3.2) / 1.6, 0, 1))
add(launch, r * shape, T0, .75)
cr = hp(noise(d), 900) * (np.random.default_rng(3).random(int(round(d * SR))) > .9965) * 6
cr = lp(cr, 6000) * np.clip((t_(d) - .4) / 1.5, 0, 1)
add(launch, cr * .25, T0, 1, pan=.1)

# ——— 4. Score ———
SC = []
beat = lambda k: float(k)
# 4a open-fifth drone C2/G2/C3, low-pass opening 120 → 1500 Hz toward zero; cut dead at the silence
dd = SIL0; tt = t_(dd); saw = lambda fq: 2 * ((fq * tt) % 1) - 1
drone = saw(65.41) * .30 + saw(98.00) * .30 + saw(130.81) * .42 + saw(196.00) * .16   # C2/G2 thinned, C3/G3 carry it (low end −3 dB rule)
out = np.zeros_like(drone); cutf = np.geomspace(120, 1500, len(drone)); blk = SR // 4
for i in range(0, len(drone), blk):
    out[i:i + blk] = lp(drone[max(0, i - 4000):i + blk], float(cutf[i]))[-len(drone[i:i + blk]):]
amp = np.minimum(1, tt / .6) * np.linspace(.45, 1, len(out))
add(mus, fade(out * amp * .22, .0, .03), 0, 1)
# 4b heartbeat: bass drum lub (beat) + softer dub (the sixteenth after), from T−15 to T−1; layers join on the grid
for k in range(0, 15):
    t = beat(k); v = .5 + .3 * k / 14
    SC.append((t, 'bass_drum', None, None, v, 0)); cue(t, 'bd')
    if k >= 1: SC.append((t + .25, 'bass_drum', None, None, v * .55, 0))
    if k >= 5: SC.append((t + .5, 'hihat', None, None, .26 + .02 * (k - 5), .3))            # T−10: off-beat hats
    if k >= 9: SC += [(t + .25, 'hihat', None, None, .16, -.3), (t + .75, 'hihat', None, None, .16, -.3)]   # T−6: sixteenths
# 4c the count: a tom and a glockenspiel note on every opening (rising pentatonic), timpani alternating C/G
GL = ['C6', 'D6', 'E6', 'G6', 'A6', 'C7', 'D7', 'E7']
for i, e in enumerate(OPENS):
    t = e["t"]; SC += [(t, 'toms', 'low' if i % 2 else 'high', None, .8, -.1), (t, 'glockenspiel', GL[i], 1.2, .42, .3),
                       (t, 'timpani', 'C2' if i % 2 == 0 else 'G2', 1.0, .5, .1)]
    cue(t, 'tom')
# 4d T−13 re-layout: low brass stab
SC += [(2.0, 'trombone_stac', 'C3', .35, .75, -.2), (2.0, 'trombone_stac', 'G2', .35, .7, .2), (2.0, 'tuba_stac', 'C3', .35, .7, 0)]; cue(2.0, 'stab')
# 4e T−6.36 → RS-25 flag on T−6: the bottom opens (gran cassa, tuba C1, trombone G2 held to the silence)
SC += [(9.0, 'gran_cassa', None, None, .75, 0), (9.0, 'tuba', 'C2', SIL0 - 9.0, .5, 0), (9.0, 'trombone', 'G2', SIL0 - 9.0, .38, .2)]; cue(9.0, 'gran')
# 4f punch-ins: timpani + horn stab
for e in EV:
    if e["type"] == "punch": SC += [(e["t"], 'timpani', 'C2', 1.0, .8, 0), (e["t"], 'horn_stac', 'G3', .3, .6, -.2)]; cue(e["t"], 'timp')
# 4g the assembly: a tom/snare per swap (triplets → sextuplets) and a timpani roll building into the stop
for i, e in enumerate(SWAPS):
    t = e["t"]; SC += [(t, 'toms', 'high_mallet' if i % 2 else 'low_mallet', None, .6 + .05 * i, (-1) ** i * .25), (t, 'snare', None, None, .35 + .06 * i, .1)]
    cue(t, 'swap')
k = 0; t = 12.0
while t < SIL0 - .07:
    step = 1 / 6 if t < 13.0 - 1e-6 else 1 / 12
    SC.append((t, 'timpani', 'C2' if k % 2 else 'G2', .2, .3 + .6 * ((t - 12) / 2.0) ** 2, (-1) ** k * .15)); t += step; k += 1
# 4h T−0: the first sound after the silence — A♭ major in low brass, gran cassa, bass drum, crash, timpani, tubular bell
SC += [(T0, 'gran_cassa', None, None, 1.0, 0), (T0, 'bass_drum', None, None, 1.0, 0), (T0, 'crash', None, None, .95, .2), (T0, 'timpani', 'G#2', 2.5, 1.0, 0),
       (T0, 'tuba', 'G#2', CUT - T0 + .2, .85, 0), (T0, 'trombone', 'G#2', CUT - T0 + .2, .75, -.2), (T0, 'trombone', 'D#3', CUT - T0 + .2, .7, .2),
       (T0, 'horn', 'C4', CUT - T0 + .2, .6, -.3), (T0, 'horn', 'D#4', CUT - T0 + .2, .6, .3), (T0, 'horn', 'G#4', CUT - T0 + .2, .55, 0),
       (T0, 'tubular_bells', 'G#4', 4.5, .7, .25)]
cue(T0, 'ignition')
# 4i after zero: a new texture — contrabass pizzicato eighths, half-time drum, lighter tick
PZ = ['G#1', 'G#1', 'D#2', 'G#1', 'C2', 'C2', 'G1', 'C2', 'C2', 'E2', 'G1', 'C2']
for i in range(int((DUR - .6 - (T0 + 1)) / .5) + 1):
    t = T0 + 1 + i * .5; SC.append((t, 'contrabass_pizz', PZ[i % len(PZ)] if t < CUT else PZ[4 + i % 8], .45, .7 if i % 2 == 0 else .5, 0))
for t in (T0 + 1, T0 + 3): SC.append((t, 'bass_drum', None, None, .55, 0))
# 4j T+2, the hard cut: C major — the arrival
SC += [(CUT, 'timpani', 'C2', 2.0, .9, 0), (CUT, 'gran_cassa', None, None, .7, 0), (CUT, 'sus_cymbal', None, None, .5, -.2),
       (CUT, 'tuba', 'C2', DUR - CUT, .7, 0), (CUT, 'trombone', 'C3', DUR - CUT, .62, -.2), (CUT, 'trombone', 'G2', DUR - CUT, .6, .2),
       (CUT, 'horn', 'E4', DUR - CUT, .55, -.3), (CUT, 'horn', 'G4', DUR - CUT, .55, .3), (CUT, 'trumpet', 'C5', DUR - CUT, .42, 0)]
cue(CUT, 'cut-chord')
SC += [(18.0, 'glockenspiel', 'C6', 1.5, .45, .3), (18.5, 'glockenspiel', 'E6', 1.5, .42, .3), (19.0, 'glockenspiel', 'G6', 1.5, .45, .3), (19.0, 'tubular_bells', 'C5', 3, .55, -.2)]
cue(18.0, 'glock'); cue(19.0, 'bell')
# attack compensation: each instrument's measured 10 %-energy onset (sampler, vel .8) is moved onto the grid, so the
# audible attack — not the file start — lands on the beat. At T0 nothing may sound before zero (the silence), so there
# only the first 9 ms are taken back.
ADV = {'bass_drum': .002, 'toms': .003, 'timpani': .007, 'snare': .0024, 'gran_cassa': .0084, 'trombone_stac': .044, 'tuba_stac': .049,
       'tuba': .085, 'trombone': .04, 'horn': .022, 'horn_stac': .015, 'glockenspiel': .002, 'tubular_bells': .006, 'crash': .028,
       'sus_cymbal': .012, 'trumpet': .0095, 'contrabass_pizz': .012, 'hihat': .002}
SC = [(t - (min(ADV.get(i, 0), .009) if abs(t - T0) < 1e-6 else ADV.get(i, 0)), i, *rest) for (t, i, *rest) in SC]
m = S.render(SC, dur=DUR + 2, master=False)[:N]
mus += m
# the silence: nothing but the T−1 tick between SIL0 and T0 (cuts any sample tails)
def gate(x):
    a, b = int(SIL0 * SR), int((T0 - .009) * SR); r = int(.03 * SR)
    g_ = np.ones(N); g_[a:b] = 0; g_[a:a + r] = np.linspace(1, 0, r); return x * g_[:, None]
mus, fol, amb = gate(mus), gate(fol), gate(amb)
# gentle end fade (last 0.5 s)
endf = np.ones(N); e0 = int((DUR - .5) * SR); endf[e0:] = np.linspace(1, 0, N - e0) ** 1.3
for b in (mus, fol, amb, launch, ticks): b *= endf[:, None]

# ——— 5. Balance and pre-master ———
rms = lambda x: np.sqrt(np.mean(x ** 2) + 1e-12)
pre = slice(0, int(SIL0 * SR))
mus *= .9 / (np.abs(mus).max() + 1e-9)
def rel(x, db): return x * (rms(mus[pre]) / (rms(x[pre]) + 1e-12)) * 10 ** (db / 20)
ticks = rel(ticks, -4.0)
fol = rel(fol, -6.0)
amb = rel(amb, -9.0)
launch = np.stack([hp(launch[:, c], 70) + .9 * bp(launch[:, c], 400, 3500) for c in (0, 1)], 1)   # the roar speaks in the mids, not only the sub
launch = launch * (rms(mus[pre]) / (rms(launch[int(T0 * SR):]) + 1e-12)) * 10 ** (5.0 / 20)    # the launch: loudest thing in the film
# low end after zero (TECHNIQUE §5): the roar loses another 3 dB below 60 Hz (low shelf), and the tuba / pizzicato bass /
# timpani step 2 dB out of the roar's 80–150 Hz while the roar is loud (a dynamic EQ keyed by the roar's envelope).
# Zero-phase filters, so the shelf and the dip do not comb with the dry signal.
from scipy.signal import butter, sosfiltfilt
zf = lambda x, kind, f: sosfiltfilt(butter(2, f, kind, fs=SR, output='sos'), x, axis=0)
launch = launch - (1 - 10 ** (-3 / 20)) * zf(launch, 'low', 60)
w_ = int(.05 * SR); env = np.sqrt(np.convolve((launch ** 2).mean(1), np.ones(w_) / w_, mode='same'))
key = np.clip(env / (.5 * env.max() + 1e-12), 0, 1)
mus = mus - (1 - 10 ** (-2 / 20)) * zf(mus, 'band', [80, 150]) * key[:, None]
mus = gate(mus); launch[:int((T0 - .009) * SR)] = 0   # zero-phase filters ring backwards: keep the silent beat silent
# score ducks a little under the roar so the brass sits inside it
mix = ticks + fol + amb + mus + launch
# low-end balance (TECHNIQUE §5): the roar, drone and gran cassa pile up below 110 Hz; take about 6 dB off down there
mix = mix - .72 * np.stack([lp(lp(mix[:, c], 120), 120) for c in (0, 1)], 1)
def lufs(x):
    sf.write(HERE / "out/_tmp.wav", x.astype(np.float32), SR)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(HERE / "out/_tmp.wav"), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    os.remove(HERE / "out/_tmp.wav")
    return float([l for l in r.splitlines() if l.strip().startswith("I:")][-1].split()[1])
(HERE / "out").mkdir(exist_ok=True)
from scipy.ndimage import maximum_filter1d
from scipy.signal import lfilter
def limit2(x, ceil):
    look = int(.005 * SR); pk = maximum_filter1d(np.abs(x).max(1), size=2 * look + 1)
    gr = np.minimum(1, ceil / np.maximum(pk, 1e-9))
    a = np.exp(-1 / (.150 * SR)); sm = lfilter([1 - a], [1, -a], 1 - gr)
    return x * (1 - np.maximum(1 - gr, sm))[:, None]
for _ in range(3):
    mix *= 10 ** ((-14.0 - lufs(mix)) / 20)
    mix = limit2(mix, .66)
(HERE / "out/stems").mkdir(parents=True, exist_ok=True)
for name, b in [("ticks", ticks), ("foley", fol), ("ambience", amb), ("music", mus), ("launch", launch)]:
    sf.write(HERE / f"out/stems/{name}.wav", b.astype(np.float32), SR)
sf.write(HERE / "out/mix.wav", mix.astype(np.float32), SR)
json.dump(sorted(CUES, key=lambda c: c["t"]), open(HERE / "out/cues.json", "w"), indent=0)
seg = lambda a, b: 20 * np.log10(rms(mix[int(a * SR):int(b * SR)]) + 1e-12)
print("mix ok", DUR, "s | rms dB: pre", round(seg(0, SIL0), 1), " silence", round(seg(SIL0 + .15, T0), 1), " ignition", round(seg(T0, T0 + 1), 1), " end", round(seg(CUT, DUR), 1))
