"""《AFTERGLOW》PV 配乐：128 BPM，A 小调，16 小节 = 30 秒。纯代码合成，同时导出节拍表 beats.json 供剪辑卡点。

段落（小节从 0 数）：
  0-1  前奏      铺底和弦 + 琶音 + 雨声
  2-3  推进      底鼓进、军鼓滚奏加速、上升音效，最后一拍留空
  4-7  drop 1    全鼓组 + supersaw 和弦 + 贝斯 + 主旋律（侧链压缩）
  8-9  安静段    钢琴旋律 + 铺底
  10-11 推进 2
  12-14 drop 2   更满，主旋律加八度
  15   收尾      重击 + 和弦 + 混响尾音
"""
import json

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
BPM = 128
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
LEN = BARS * BAR
N = int(LEN * SR) + SR * 2  # 留 2 秒尾音，最后裁到 30 秒
rng = np.random.default_rng(7)


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def t_of(bar, beat=0.0):
    return bar * BAR + beat * BEAT


def bus():
    return np.zeros((2, N))


def add(buf, sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
    if i >= N:
        return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    if sig.ndim == 2:  # already stereo
        sig = sig[:, : N - i]
        buf[0, i:i + sig.shape[1]] += sig[0] * gain * l * np.sqrt(2)
        buf[1, i:i + sig.shape[1]] += sig[1] * gain * r * np.sqrt(2)
        return
    sig = sig[: N - i]
    buf[0, i:i + len(sig)] += sig * gain * l * np.sqrt(2)
    buf[1, i:i + len(sig)] += sig * gain * r * np.sqrt(2)


def env_adsr(n, a=0.005, d=0.1, s=0.7, r=0.1):
    t = np.arange(n) / SR
    dur = n / SR
    e = np.ones(n) * s
    e[t < a] = t[t < a] / a
    m = (t >= a) & (t < a + d)
    e[m] = 1 - (1 - s) * (t[m] - a) / d
    rel = t > dur - r
    e[rel] *= np.clip((dur - t[rel]) / r, 0, 1)
    return e


def saw(f, n, phase=0.0):
    t = np.arange(n) / SR
    return 2 * ((f * t + phase) % 1.0) - 1


def lp(x, fc, order=2):
    b, a = signal.butter(order, min(fc, SR / 2 - 100) / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def hp(x, fc, order=2):
    b, a = signal.butter(order, fc / (SR / 2), "high")
    return signal.lfilter(b, a, x)


def bp(x, lo, hi):
    b, a = signal.butter(2, [lo / (SR / 2), hi / (SR / 2)], "band")
    return signal.lfilter(b, a, x)


# ---------- instruments ----------
def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.045)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.28)
    click = hp(rng.standard_normal(n), 2000) * np.exp(-t / 0.004) * 0.35
    return np.tanh(1.6 * (body + click))


def snare():
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = bp(rng.standard_normal(n), 1200, 9000) * np.exp(-t / 0.12)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.06)
    return 0.8 * noise + 0.6 * tone


def clap():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    e = np.zeros(n)
    for k, d in enumerate((0.0, 0.011, 0.022)):
        m = t >= d
        e[m] += np.exp(-(t[m] - d) / (0.012 if k < 2 else 0.09))
    return bp(rng.standard_normal(n), 900, 6000) * e


def hat(open_=False):
    n = int((0.25 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t / (0.08 if open_ else 0.012))


def crash():
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 3500) * np.exp(-t / 0.7)


def reverse_cymbal(dur):
    c = crash()[: int(dur * SR)]
    return c[::-1] * np.linspace(0, 1, len(c)) ** 2


def impact():
    n = int(2.5 * SR)
    t = np.arange(n) / SR
    f = 32 + 70 * np.exp(-t / 0.12)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.8)
    cr = np.zeros(n); c = crash(); cr[:len(c)] = c[:n]
    return np.tanh(2.0 * boom) + 0.4 * cr


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = t / dur
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    # sweep a bandpass upward in blocks
    blk = 2048
    for i in range(0, n, blk):
        c = 400 + 9000 * x[i] ** 2
        seg = noise[max(0, i - 512):i + blk]
        y = bp(seg, c * 0.7, min(c * 1.4, SR / 2 - 200))[-len(noise[i:i + blk]):]
        out[i:i + blk] = y
    tone = np.sin(2 * np.pi * np.cumsum(200 + 1200 * x ** 2) / SR) * 0.25
    return (out * 0.6 + tone) * x ** 1.5


def supersaw(notes, dur, cutoff=5000, voices=7, detune=0.18):
    n = int(dur * SR)
    L, R = np.zeros(n), np.zeros(n)
    for m in notes:
        f0 = midi(m)
        for v in range(voices):
            cents = (v - (voices - 1) / 2) / ((voices - 1) / 2) * detune * 100
            s = saw(f0 * 2 ** (cents / 1200), n, rng.random())
            pan = (v - (voices - 1) / 2) / ((voices - 1) / 2)
            L += s * (1 - pan) / 2
            R += s * (1 + pan) / 2
    e = env_adsr(n, 0.01, 0.2, 0.75, 0.08)
    L, R = lp(L, cutoff) * e, lp(R, cutoff) * e
    return np.stack([L, R]) / (voices * len(notes)) * 2.2


def pad(notes, dur, cutoff=1800):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for m in notes:
        f = midi(m)
        for dt in (-0.07, 0.0, 0.08):
            out += np.sin(2 * np.pi * f * (1 + dt / 100) * t) + 0.3 * saw(f * (1 + dt / 50), n)
    out = lp(out, cutoff) * env_adsr(n, 0.4, 0.3, 0.8, 0.6)
    return out / (3 * len(notes))


def pluck(m, dur=0.22, cutoff=3500):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = saw(midi(m), n) * 0.6 + np.sign(np.sin(2 * np.pi * midi(m) * t)) * 0.4
    return lp(s, cutoff) * np.exp(-t / 0.07)


def bass(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = saw(midi(m), n) * 0.7 + np.sin(2 * np.pi * midi(m) * t) * 0.6
    return np.tanh(1.5 * lp(s, 900)) * env_adsr(n, 0.004, 0.08, 0.8, 0.03)


def lead(m, dur, bright=4200):
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.15) / 0.2, 0, 1)
    ph = np.cumsum(midi(m) * vib) / SR
    s = 0.55 * (2 * (ph % 1) - 1) + 0.45 * np.sign(np.sin(2 * np.pi * ph * 1.003))
    return lp(s, bright) * env_adsr(n, 0.008, 0.12, 0.7, 0.06)


def piano(m, dur):
    n = int((dur + 0.8) * SR)
    t = np.arange(n) / SR
    f = midi(m)
    s = sum(np.sin(2 * np.pi * f * k * t) * np.exp(-t * (1.2 + 1.8 * k)) / k for k in range(1, 7))
    return s * 0.7


def rain(dur):
    n = int(dur * SR)
    x = bp(rng.standard_normal(n), 2500, 11000) * 0.25
    drops = np.zeros(n)
    for _ in range(int(dur * 40)):
        i = rng.integers(0, n - 2000)
        drops[i:i + 2000] += hp(rng.standard_normal(2000), 4000) * np.exp(-np.arange(2000) / 120) * rng.random()
    return x + drops * 0.6


# ---------- arrangement ----------
CHORDS = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]]  # Am F C G
ROOTS = [45, 41, 48, 43]
DROP_MEL = [  # (bar-in-cycle, beat, length, midi)
    (0, 0, .5, 76), (0, .5, .5, 81), (0, 1, .5, 79), (0, 1.5, 1, 76), (0, 2.5, .5, 74), (0, 3, 1, 76),
    (1, 0, .5, 72), (1, .5, .5, 74), (1, 1, .5, 76), (1, 1.5, 1, 79), (1, 2.5, .5, 76), (1, 3, .5, 74), (1, 3.5, .5, 72),
    (2, 0, .5, 76), (2, .5, .5, 79), (2, 1, 1, 81), (2, 2, .5, 84), (2, 2.5, .5, 83), (2, 3, .5, 81), (2, 3.5, .5, 79),
    (3, 0, 1.5, 81), (3, 1.5, .5, 79), (3, 2, 1, 76), (3, 3, 1, 74),
]
BREAK_MEL = [(0, 0, 1, 69), (0, 1, 1, 72), (0, 2, 2, 76), (1, 0, 1, 74), (1, 1, 1, 72), (1, 2, 2, 69)]

drums, music, lead_bus, fx, amb = bus(), bus(), bus(), bus(), bus()
kick_times = []


def chord_of(bar):
    return bar % 4


# intro 0-1 + break 8-9: pad + arp
for b in list(range(0, 4)) + [8, 9, 10, 11]:
    c = chord_of(b)
    add(music, pad([n + 12 for n in CHORDS[c]], BAR + 0.3), t_of(b), gain=0.55)
for b in [0, 1, 2, 3, 10, 11]:
    c = chord_of(b)
    seq = [CHORDS[c][0] + 12, CHORDS[c][1] + 12, CHORDS[c][2] + 12, CHORDS[c][0] + 24]
    cut = 1500 + 2500 * (b in (2, 3, 10, 11))
    for k in range(16):
        add(music, pluck(seq[k % 4], cutoff=cut), t_of(b, k / 4), pan=0.35 * (-1) ** k, gain=0.22)
add(amb, rain(4.2), 0, gain=0.3)

# builds 2-3, 10-11
for b0 in (2, 10):
    for b in (b0, b0 + 1):
        for k in range(4):
            if not (b == b0 + 1 and k == 3):
                add(drums, lp(kick(), 2500), t_of(b, k), gain=0.45 + 0.15 * (b == b0 + 1)); kick_times.append(t_of(b, k))
    # snare roll: 8ths then 16ths, rising volume, stops before the gap beat
    for k in range(8):
        add(drums, snare(), t_of(b0, k / 2), gain=0.12 + 0.03 * k)
    for k in range(12):
        add(drums, snare(), t_of(b0 + 1, k / 4), gain=0.3 + 0.035 * k)
    add(fx, riser(BAR * 2 - BEAT), t_of(b0), gain=0.5)
    add(fx, reverse_cymbal(BEAT * 1.0), t_of(b0 + 1, 3), gain=0.6)
    add(music, supersaw(CHORDS[chord_of(b0 + 1)], BAR - BEAT, cutoff=2500), t_of(b0 + 1), gain=0.35)

# drops 4-7, 12-14
for b0, nbars, big in ((4, 4, False), (12, 3, True)):
    add(fx, impact(), t_of(b0), gain=0.8)
    add(fx, crash(), t_of(b0), gain=0.5)
    for i in range(nbars):
        b = b0 + i
        c = chord_of(i)
        for k in range(4):
            add(drums, kick(), t_of(b, k)); kick_times.append(t_of(b, k))
            add(drums, hat(open_=True), t_of(b, k + .5), pan=0.2, gain=0.22)
        for k in (1, 3):
            add(drums, snare(), t_of(b, k), gain=0.55)
            add(drums, clap(), t_of(b, k), gain=0.45)
        for k in range(16):
            add(drums, hat(), t_of(b, k / 4), pan=-0.3, gain=0.12 + 0.05 * (k % 2))
        # chords: off-beat stabs + sustained
        add(music, supersaw([n + 12 for n in CHORDS[c]], BAR, cutoff=6500 if big else 5200), t_of(b), gain=0.5)
        for k in range(8):
            r = ROOTS[c] - 12 + (12 if k % 2 else 0)
            add(music, bass(r, BEAT / 2 * 0.9), t_of(b, k / 2), gain=0.55)
        for (cb, beat, ln, m) in DROP_MEL:
            if cb == i:
                if big and i == nbars - 1 and cb == 2 and beat >= 2:
                    continue
                add(lead_bus, lead(m, ln * BEAT * 0.95), t_of(b, beat), pan=-0.1, gain=0.32)
                if big:
                    add(lead_bus, lead(m + 12, ln * BEAT * 0.95, 6000), t_of(b, beat), pan=0.15, gain=0.14)
    if big:  # last drop bar resolves to a long A
        add(lead_bus, lead(81, BEAT * 2), t_of(14, 2), gain=0.32)
        add(lead_bus, lead(93, BEAT * 2, 6000), t_of(14, 2), pan=0.15, gain=0.12)

# break melody (piano)
for (cb, beat, ln, m) in BREAK_MEL:
    add(lead_bus, piano(m, ln * BEAT), t_of(8 + cb, beat), gain=0.45)
    add(lead_bus, piano(m + 12, ln * BEAT), t_of(8 + cb, beat), pan=0.2, gain=0.15)

# outro bar 15: impact + final chord + piano tag
add(fx, impact(), t_of(15), gain=0.9)
add(fx, crash(), t_of(15), gain=0.5)
add(music, supersaw([57, 64, 69, 72], BAR + 1.5, cutoff=4000), t_of(15), gain=0.55)
add(music, pad([57, 64, 69, 72], BAR + 1.5), t_of(15), gain=0.5)
add(drums, kick(), t_of(15)); kick_times.append(t_of(15))
for k, m in enumerate((81, 76, 72, 69)):
    add(lead_bus, piano(m, BEAT), t_of(15, 1 + k * 0.5), gain=0.3)

# ---------- mix ----------
# sidechain the music bus from the kick
sc = np.ones(N)
for kt in kick_times:
    i = int(kt * SR)
    n = min(int(0.3 * SR), N - i)
    sc[i:i + n] = np.minimum(sc[i:i + n], 1 - 0.75 * np.exp(-np.arange(n) / SR / 0.09))
music *= sc
lead_bus *= 0.6 + 0.4 * sc


def reverb(x, dur=1.8, wet=0.25):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / (dur / 5))
        ir = lp(ir, 6000)
        ir /= np.sqrt(np.sum(ir ** 2))
        out[ch] = signal.fftconvolve(x[ch], ir)[: x.shape[1]]
    return x * (1 - wet) + out * wet * 1.6


music = reverb(music, 1.6, 0.22)
lead_bus = reverb(lead_bus, 2.2, 0.3)
fx = reverb(fx, 2.5, 0.2)
mix = drums * 0.9 + music * 0.85 + lead_bus * 1.0 + fx * 0.7 + amb * 0.6
mix = mix[:, : int(30.0 * SR)]
fade = int(0.25 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade)
mix = np.tanh(mix * 1.2)
mix /= np.max(np.abs(mix)) / 0.89
wavfile.write("music.wav", SR, (mix.T * 32767).astype(np.int16))

beats = [round(i * BEAT, 4) for i in range(int(30 / BEAT) + 1)]
json.dump({"bpm": BPM, "beat": BEAT, "bar": BAR, "beats": beats,
           "sections": {"intro": [0, t_of(2)], "build1": [t_of(2), t_of(4)], "drop1": [t_of(4), t_of(8)],
                        "break": [t_of(8), t_of(10)], "build2": [t_of(10), t_of(12)], "drop2": [t_of(12), t_of(15)],
                        "outro": [t_of(15), 30.0]}}, open("beats.json", "w"), indent=1)
print("music.wav", mix.shape[1] / SR, "s; sections:", json.load(open("beats.json"))["sections"])
