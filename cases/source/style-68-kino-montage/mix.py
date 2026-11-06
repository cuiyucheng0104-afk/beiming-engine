#!/usr/bin/env python3
"""《大坝》配乐 + 拟音 + 环境 → out/mix.wav（以及 out/stems/*.wav、out/score.json 供 cuecheck.py 核对）。

    $LIB/.venv/bin/python mix.py

一切时间都来自 events.json（index.html 的 window.EV，由 timeline.js 的拍点网格算出）。
配乐：D 小调，120 BPM。工业打击——铁砧（合成）、机械 ostinato（大提琴跳弓 + 断奏巴松）、
断奏大号/长号踩拍、小鼓 16 分、木琴数格、圆号/小号刺、定音鼓、大鼓、锣；合唱式合成器（共振峰合成）。
采样来自 core/audio/sampler.py（VSCO 2 CE、VCSL，CC0）。拟音全部程序合成（core/audio/sfx.py + 本文件）。
"""
import os, sys, json
from pathlib import Path
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, lfilter, resample_poly
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d

HERE = Path(__file__).resolve().parent
LIB = Path(os.environ.get("LIB", "@@LEMO_ROOT@@")).resolve()
sys.path.insert(0, str(LIB))
from core.audio import sampler as S
from core.audio import sfx as X
from core.audio.sfx import SR, add

S.seed(1931)
rng = np.random.default_rng(1931)
EVJ = json.load(open(HERE / "events.json"))
DUR, EV = EVJ["dur"], EVJ["ev"]
N = int(round(DUR * SR))
B = 0.5                                  # one beat
evt = lambda ty: [e for e in EV if e["type"] == ty]
first = lambda ty: evt(ty)[0]["t"]
SIL0, HIT = first("silence"), first("hit")          # 14.0, 15.0
BUILD0 = evt("floor")[0]["t"]                         # 12.0
m = S.midi
OUT = HERE / "out"; (OUT / "stems").mkdir(parents=True, exist_ok=True)
SCORE = []                                            # (t, label) musical anchors for cuecheck


def st(n=None): return np.zeros((N if n is None else n, 2), np.float32)


def place(buf, x, t, g=1.0, pan=0.0):
    if t >= DUR: return
    add(buf, x.astype(np.float32), t, g, pan)


def bpf(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], "band", fs=SR, output="sos"), x)


def envd(d, a=.002, tau=.2):
    tt = np.arange(int(d * SR)) / SR
    return np.minimum(1, tt / max(a, 1e-4)) * np.exp(-tt / tau)


# ============================================================ synthesized industrial sounds
def anvil(v=1.0, f0=640.0, d=1.6):
    """铁砧：非谐泛音 + 金属敲击瞬态 + 一点低频身体。"""
    tt = np.arange(int(d * SR)) / SR
    x = sum(a * np.sin(2 * np.pi * f0 * r * tt + rng.random() * 6) * np.exp(-tt / tau)
            for r, a, tau in [(1, 1, .9), (2.76, .7, .55), (5.40, .45, .3), (8.93, .3, .18), (13.3, .2, .1)])
    x += X.hp(X.noise(d), 3000) * np.exp(-tt / .004) * 1.2
    x += np.sin(2 * np.pi * 95 * tt) * np.exp(-tt / .05) * .8
    return X.norm(x) * v


def clank(p=1.0, v=1.0, d=.6):
    """钢构件碰撞。"""
    tt = np.arange(int(d * SR)) / SR
    x = sum(a * np.sin(2 * np.pi * 330 * p * r * tt + rng.random() * 6) * np.exp(-tt / tau)
            for r, a, tau in [(1, 1, .22), (1.47, .7, .16), (2.09, .6, .12), (2.56, .5, .09), (3.9, .3, .05)])
    x += X.bp(X.noise(d), 1500, 6000) * np.exp(-tt / .006)
    return X.norm(x) * v


def stamp(v=1.0):
    """印章 / 落版：低 thump + 木质 clack + 钢 clank。"""
    d = .5; x = np.zeros(int(d * SR))
    th = X.thump(1, 62); x[:len(th)] += th[:len(x)] * .9
    c = clank(.8, .55); x[:len(c)] += c[:len(x)]
    k = X.clack(.7, .5); x[:len(k)] += k
    return X.norm(x) * v


def marker(d, v=1.0):
    """红马克笔划过纸面：带通噪声 + 毡头颤动。"""
    tt = np.arange(int(d * SR)) / SR
    x = X.bp(X.noise(d), 1800, 6500) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 17 * tt)))
    return X.norm(x * np.sin(np.pi * tt / d) ** .5) * v


def paper(v=1.0, d=.22):
    tt = np.arange(int(d * SR)) / SR
    x = X.bp(X.noise(d), 900, 5000) * np.exp(-tt / .05) * (1 + .5 * np.sin(2 * np.pi * 45 * tt))
    return X.norm(x) * v


def scrape(d, v=1.0, lo=250, hi=2600):
    """柱子升起：金属摩擦，音高上扫。"""
    n = int(d * SR); x = X.noise(d); out = np.zeros(n); blk = 480
    for i in range(0, n, blk):
        j = min(n, i + blk); f = lo * (hi / lo) ** (i / n)
        out[i:j] = X.bp(x[max(0, i - 2400):j], f * .85, f * 1.15)[-(j - i):]
    tt = np.arange(n) / SR
    out += .3 * np.sin(2 * np.pi * np.cumsum(lo * (hi / lo) ** (tt / d)) / SR * 2.0)
    return X.norm(out * np.minimum(1, tt / .02) * np.minimum(1, (d - tt) / .03)) * v


def rivet_gun(d, v=1.0, rate=21.0):
    """铆钉枪连击（合成）：每击 = 高频瞬态 + 2.4 kHz 金属振铃 + 低频冲击。"""
    n = int(d * SR); out = np.zeros(n)
    k = 0
    while True:
        s = int((k / rate + rng.random() * .004) * SR)
        if s >= n: break
        hd = .045; tt = np.arange(int(hd * SR)) / SR
        h = X.hp(X.noise(hd), 2500) * np.exp(-tt / .003) + np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt / .012) * .5 \
            + np.sin(2 * np.pi * 140 * tt) * np.exp(-tt / .01) * .7
        e = min(len(h), n - s); out[s:s + e] += h[:e] * (.75 + .25 * rng.random()); k += 1
    fe = int(.006 * SR); out[-fe:] *= np.linspace(1, 0, fe)
    return X.norm(out) * v


def choir(notes, d, v=1.0, attack=.35, release=.6, vowel="ah"):
    """合唱式合成器：每个声部 3 条略失谐的锯齿波 + 颤音，经共振峰带通（"啊"）。"""
    F = {"ah": [(730, 90, 1.0), (1090, 110, .5), (2440, 170, .25)], "oh": [(570, 80, 1.0), (840, 100, .45), (2410, 170, .2)]}[vowel]
    n = int((d + release) * SR); tt = np.arange(n) / SR
    src = np.zeros(n)
    for p in notes:
        f = 440 * 2 ** ((m(p) - 69) / 12)
        for c in (-7, 0, 6):
            fr = f * 2 ** (c / 1200) * (1 + .006 * np.sin(2 * np.pi * (5.2 + rng.random() * .6) * tt + rng.random() * 6))
            ph = np.cumsum(fr) / SR
            src += 2 * (ph % 1) - 1
    y = sum(g * bpf(src, fc - bw, fc + bw) for fc, bw, g in F)
    y += .15 * X.lp(src, 500)
    env = np.minimum(1, tt / attack) * np.where(tt < d, 1, np.exp(-(tt - d) / (release / 4)))
    return X.norm(y * env) * v


# ============================================================ score
ev = []
def E(t, inst, pitch, dur, vel, pan=0, gain=1.0):
    if t < DUR: ev.append((round(t, 5), inst, pitch, dur, vel, pan, gain))

CELL = ["D3", "D3", "F3", "D3", "A2", "D3", "E3", "F3"]          # the machine figure, eighths
def harmony(t):                     # transposition of the figure by bar (2 s): Dm Dm Bb C | Dm Dm (count) | –
    bar = int(t // 2)
    return {0: 0, 1: 0, 2: -4, 3: -2, 4: 0, 5: 0}.get(bar, 0)

def ostinato(t0, t1, vel=.55, bassoon=True, oct_=0):
    n = int(round((t1 - t0) / .25))
    for i in range(n):
        t = t0 + i * .25; p = m(CELL[i % 8]) + harmony(t) + 12 * oct_
        acc = .12 if i % 2 == 0 else 0
        E(t, "cellos_spic", p, .22, vel + acc, -.25)
        if bassoon: E(t, "bassoon_stac", p, .2, vel * .8 + acc, .3, .8)

def pulse(t0, t1, vel=.6):          # staccato tuba on every beat, trombone on 2 and 4
    k = 0; t = t0
    while t < t1 - 1e-6:
        root = m("D2") + harmony(t)
        E(t, "tuba_stac", root, .3, vel, 0, .9)
        if k % 2 == 1: E(t, "trombone_stac", root + 12, .25, vel * .9, .15, .7)
        t += B; k += 1

def taps(t0, t1, vel=.35, step=.125):
    t = t0; i = 0
    while t < t1 - 1e-6:
        E(t, "snare2", "taps" if i % 4 else "on", .2, vel * (1.15 if i % 4 == 0 else .8), .2, .7); t += step; i += 1

def troll(t0, t1, pitch="D3", v0=.25, v1=.85, step=.0625):        # timpani roll crescendo
    n = int(round((t1 - t0) / step))
    for i in range(n):
        E(t0 + i * step, "timpani", pitch, .3, v0 + (v1 - v0) * i / max(1, n - 1), (-.15 if i % 2 else .15), .9)

def stab(t, notes, vel=.8, insts=("horn_stac", "trumpet_stac")):
    for inst in insts:
        for p in notes:
            if inst == "trumpet_stac" and m(p) < m("F3"): continue
            E(t, inst, p, .3, vel, .1 if inst == "horn_stac" else -.1, .8)

# --- S1 0–3: roll → land → machine
troll(0.0, first("band"), "D3", .2, .75)
land = first("land")
E(land, "gran_cassa", "hit", None, .9, 0); E(land, "tuba_stac", "D2", .4, .9, 0); E(land, "trombone_stac", "D3", .35, .85, 0)
E(land, "timpani", "D3", 1.2, .9, 0)
SCORE.append((land, "land"))
ostinato(land, 3.0, .5)
pulse(land, 3.0, .55)
stp = [e for e in evt("stamp")]
stab(stp[0]["t"], ["D4", "F4", "A4"], .8); SCORE.append((stp[0]["t"], "stamp"))
taps(1.0, 2.75, .28)
E(first("jump"), "timpani", "A2", .8, .8, 0); SCORE.append((first("jump"), "jump"))
E(first("wipe"), "sus_cymbal", "cresc", None, .55, 0, .6)

# --- S2 3–8: the chart
turn = first("turn")
E(turn, "gran_cassa", "hit", None, .85, 0); E(turn, "clash", "short", None, .6, 0, .6); SCORE.append((turn, "turn"))
ostinato(turn, 7.5, .52)
pulse(turn, 8.0, .6)
taps(turn, 7.5, .3)
for e in evt("bar"):
    t0 = e["t"]; base = m("D2") + harmony(t0) + (0 if e["k"] == 0 else 5)
    for j, iv in enumerate([0, 3, 7, 12]):
        E(t0 + j * .125, "tuba_stac" if e["k"] == 0 else "trombone_stac", base + iv + (0 if e["k"] == 0 else 12), .2, .7 + j * .05, 0, .9)
    E(t0 + B, "xylophone", m("D5") + (0 if e["k"] == 0 else 7), .4, .7, .3)
    SCORE.append((t0, f"bar{e['k']}"))
stab(stp[1]["t"], ["Bb3", "D4", "F4", "Bb4"], .85); SCORE.append((stp[1]["t"], "num2"))
tilt = first("tilt")
for dt, p, d in [(0, "D5", .2), (.25, "F5", .2), (.5, "E5", .45), (1.0, "C5", .2), (1.25, "D5", .2), (1.5, "A4", .45)]:
    E(tilt + dt, "trumpet_stac", p, d, .78, -.2, .85)
    E(tilt + dt, "horn_stac", m(p) - 12, d, .65, .2, .7)
SCORE.append((tilt, "tilt"))
E(first("window"), "trombone_stac", "C3", .3, .8, 0); E(first("window"), "tuba_stac", "C2", .3, .8, 0); SCORE.append((first("window"), "window"))
rolls = evt("roll")
troll(rolls[1]["t"], rolls[1]["t"] + rolls[1]["d"], "A2", .2, .8)
E(rolls[1]["t"], "sus_cymbal", "cresc", None, .6, 0, .6)

# --- S3 8–12: count the many (acceleration)
c0 = first("count") if False else evt("cell")[0]["t"]
E(c0, "gran_cassa", "hit", None, .9, 0); E(c0, "timpani", "D3", 1, .85, 0); E(c0, "clash", "crash", None, .55, 0, .5)
SCORE.append((c0, "cellTitle"))
ostinato(c0, BUILD0 - .5, .56)
pulse(c0, BUILD0, .62)
taps(c0, 10.0, .3); taps(10.0, 11.5, .4, .0625 * 2); taps(11.0, 11.5, .45, .0625)
SCALE = ["D5", "E5", "F5", "G5", "A5", "Bb5", "C6", "D6", "E6", "F6", "G6"]
for e in evt("cell"):
    if e["k"] < 0: continue
    E(e["t"], "xylophone", SCALE[e["k"]], .35, .75, .25, 1.0); SCORE.append((e["t"], f"cell{e['k']}"))
for t in np.arange(10.0, 11.5, .125):
    E(t, "tuba_stac", "D2", .1, .5, 0, .6)
cnt = first("count")
stab(cnt, ["D4", "F4", "A4", "D5"], .95); E(cnt, "timpani", "D3", 1.0, 1.0, 0); E(cnt, "gran_cassa", "hit", None, 1.0, 0); E(cnt, "clash", "crash", None, .7, 0, .6)
E(cnt, "tuba_stac", "D2", .4, .95, 0); SCORE.append((cnt, "count"))
troll(11.5 + .25, BUILD0, "D3", .3, .7, .125)

# --- S4 12–14: A (men) = rivet gun alone, B (concrete) = the orchestra; accelerating to the cut
floors = evt("floor")
for i, e in enumerate(floors):
    t0 = e["t"]; t1 = floors[i + 1]["t"] if i + 1 < len(floors) else SIL0
    if e["kind"] == "B":
        root = m("D2") + [0, 0, 1, 3][i // 2]
        E(t0, "tuba_stac", root, .3, 1.0, 0); E(t0, "trombone_stac", root + 12, .3, .95, -.1); E(t0, "horn_stac", root + 24, .3, .9, .15)
        E(t0, "horn_stac", root + 27, .3, .85, .2); E(t0, "timpani", "D3", .8, .95, 0); E(t0, "gran_cassa", "hit", None, .85, 0)
        SCORE.append((t0, f"floorB{i}"))
    else:
        E(t0, "snare2", "on", .2, .7, 0, .8); SCORE.append((t0, f"floorA{i}"))
troll(13.0, SIL0, "A2", .3, 1.0, .0625)
E(13.0, "sus_cymbal", "cresc", None, .8, 0, .7)

# --- S6 15–19.5: the heaviest hit
E(HIT, "timpani", "D3", 3.5, 1.0, -.1); E(HIT, "timpani", "A2", 3.5, 1.0, .1); E(HIT, "timpani", "F2", 3.5, .9, 0)
E(HIT, "gran_cassa", "hit", None, 1.0, 0); E(HIT, "bass_drum", None, None, 1.0, 0); E(HIT, "gong", None, None, 1.0, 0, 1.0)
E(HIT, "clash", "crash", None, .9, 0, .7)
for p, inst, v in [("D2", "tuba", .95), ("A2", "trombone", .9), ("D3", "trombone", .9), ("F3", "horn", .9), ("A3", "horn", .9), ("D4", "horn", .85)]:
    E(HIT, inst, p, 3.0, v, (m(p) - 50) / 40, 1.0)
SCORE.append((HIT, "hit"))
stab(first("type") if False else 15.5, ["A4"], .5, ("horn_stac",))
nh = [e for e in evt("stamp") if e["t"] > HIT][0]["t"]
stab(nh, ["A3", "C#4", "E4", "A4"], .9); E(nh, "timpani", "A2", 1.0, .85, 0); SCORE.append((nh, "numH"))
rs = first("restamp")
stab(rs, ["D4", "F4", "A4", "D5"], 1.0); E(rs, "timpani", "D3", 2.2, 1.0, 0); E(rs, "gran_cassa", "hit", None, .95, 0)
E(rs, "tuba_stac", "D2", .5, 1.0, 0); E(rs, "clash", "short", None, .6, 0, .6); SCORE.append((rs, "restamp"))
ostinato(rs, 18.0, .4, bassoon=False)                 # the machine slows: eighths to beat 36 ...
for dt, p in [(0, "D3"), (.5, "A2")]: E(18.0 + dt, "cellos_spic", p, .4, .5, -.25)   # ... quarters to beat 38 ...
for p in ["D2", "A2"]: E(rs, "tuba", p, 2.3, .55, 0, .8)
rs2 = [e for e in evt("restamp") if e.get("k") == 2][0]["t"]
stab(rs2, ["D4", "F4", "A4"], .85); E(rs2, "timpani", "D3", 1.0, .9, 0); E(rs2, "gran_cassa", "hit", None, .8, 0); E(rs2, "tuba_stac", "D2", .4, .9, 0)
SCORE.append((rs2, "restamp2"))
END = first("end")                                    # ... and lands on one rivet: the last accent, then only the ring-out
E(END, "timpani", "D3", 1.5, .95, 0); E(END, "timpani", "A2", 1.5, .8, .1); E(END, "gran_cassa", "hit", None, .85, 0)
E(END, "tuba_stac", "D2", .5, .95, 0); E(END, "trombone_stac", "D3", .4, .85, 0); E(END, "clash", "short", None, .55, 0, .6)
SCORE.append((END, "end"))

def shelf(x, f0, gdb, low=True, q=.707):
    """RBJ shelving biquad, per channel."""
    A = 10 ** (gdb / 40); w = 2 * np.pi * f0 / SR; al = np.sin(w) / (2 * q); c = np.cos(w); sA = 2 * np.sqrt(A) * al
    if low:
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    else:
        b = [A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA)]
        a = [(A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA]
    b, a = np.array(b) / a[0], np.array(a) / a[0]
    return lfilter(b, a, x, axis=0)

HITDRUMS = {"timpani", "gran_cassa", "bass_drum"}
hd = [e for e in ev if abs(e[0] - HIT) < 1e-6 and e[1] in HITDRUMS]
rest = [e for e in ev if not (abs(e[0] - HIT) < 1e-6 and e[1] in HITDRUMS)]
music = S.render(rest, dur=DUR + .5, master=False)[:N]
drums = S.render(hd, dur=DUR + .5, master=False)[:N]
music = music + shelf(drums, 60, 3.0) * 10 ** (3 / 20)          # the hit after the silence: +3 dB and a 60 Hz shelf
music = shelf(music, 100, 2.0)                                   # a little more floor under the whole score

# choir: rises under the chart, swells into the build, full on the hit
ch = st()
place(ch, choir(["D4", "F4", "A4"], 2.5, .5), tilt, .16, -.1)
place(ch, choir(["C4", "E4", "G4"], 1.6, .5), 6.5, .14, .1)
place(ch, choir(["D4", "F4", "A4", "D5"], 2.0, .6, attack=1.6), BUILD0, .22, 0)
place(ch, choir(["D3", "A3", "D4", "F4", "A4", "D5"], 3.6, 1.0, attack=.02, release=1.0), HIT, .34, 0)
place(ch, choir(["D4", "F4", "A4"], 2.2, .7, attack=.05, release=.8, vowel="oh"), rs, .2, 0)
music = music + S.room(ch, size=.55, mix=.25)

# ============================================================ foley (every visible action)
fol = st()
for e in EV:
    t, ty = e["t"], e["type"]
    if ty == "band": place(fol, X.whoosh(.3, 1), t - .3, .35, -.4); place(fol, clank(.7, 1), t, .5, -.3)
    elif ty == "land": place(fol, paper(1, .3), t, .6, .1); place(fol, anvil(1, 640), t, .55, .1); place(fol, X.thump(1, 55), t, .7, 0)
    elif ty == "marker": place(fol, marker(e["d"] + .05, 1), t, .5, -.2)
    elif ty == "stamp": place(fol, stamp(1), t, .75 * e.get("g", 1), .15)
    elif ty == "jump": place(fol, anvil(1, 700), t, .5, 0); place(fol, X.click(.6, 1), t, .3, 0)
    elif ty == "wipe": place(fol, X.whoosh(e["d"], 1), t, .55, .5)
    elif ty == "turn": place(fol, paper(1, .45), t, .6, -.2); place(fol, anvil(1, 600), t, .5, 0)
    elif ty == "bar": place(fol, scrape(e["d"], 1, 220 + 120 * e["k"], 2200 + 600 * e["k"]), t, .3, -.2 + .4 * e["k"]); place(fol, clank(.9 + .2 * e["k"], 1), t + e["d"], .45, 0)
    elif ty == "type": place(fol, X.clack(.8, 1), t, .3, .2); place(fol, X.thump(.7, 80), t, .3, 0)
    elif ty == "tilt": place(fol, anvil(1, 760), t, .45, .2); place(fol, X.whoosh(.5, 1), t, .25, .3)
    elif ty == "window": place(fol, stamp(1), t, .6, .4)
    elif ty == "cell":
        k = e["k"] + 1; place(fol, paper(1, .12), t, .45, -.6 + .12 * k); place(fol, clank(1 + .09 * k, 1, .3), t, .35, -.6 + .12 * k)
    elif ty == "count": place(fol, stamp(1), t, .9, 0); place(fol, anvil(1, 560), t, .7, 0); place(fol, X.whoosh(.12, 1), t - .12, .4, -.5)
    elif ty == "floor":
        nxt = [f["t"] for f in evt("floor") if f["t"] > t] + [SIL0]
        if e["kind"] == "A": place(fol, rivet_gun(nxt[0] - t - .04, 1), t, .55, -.3)   # the burst stops 40 ms before the next cut: the B hit lands clean
        place(fol, stamp(1), t, .55, .4); place(fol, clank(1.0 + .07 * e["i"], 1, .4), t, .4, .4)
    elif ty == "figure": place(fol, X.thump(1, 90), t, .45, .3); place(fol, paper(1, .1), t, .3, .3)
    elif ty == "crown": place(fol, anvil(1, 880), t, .5, .3)
    elif ty == "hit": place(fol, anvil(1, 520, 3.0), t, .9, 0); place(fol, X.thump(1, 45), t, 1.0, 0); place(fol, stamp(1), t, .9, 0)
    elif ty == "restamp": place(fol, stamp(1), t, .9 if e.get("k") != 2 else .75, 0); place(fol, anvil(1, 600 if e.get("k") != 2 else 660), t, .6, 0)
    elif ty == "end":                                                 # the rivet driven home: hammer ring + thump + clank
        place(fol, anvil(1, 920, 2.2), t, .5, .35); place(fol, X.thump(1, 50), t, .6, 0); place(fol, clank(1.3, 1, .5), t, .35, .35)

# ============================================================ ambience: wind in the canyon, the site far off
amb = st()
w = X.brown(DUR); tt = np.arange(len(w)) / SR
w = X.bp(w, 70, 700) * (.6 + .4 * np.sin(2 * np.pi * .13 * tt + 1.0))
hum = X.lp(X.noise(DUR), 200) * .3 * (1 + .3 * np.sin(2 * np.pi * 3.1 * tt))
a = X.norm(w + hum)[:N]
amb[:, 0] += a * .06; amb[:, 1] += np.roll(a, 3100) * .06
fd = np.ones(N); i0 = int(BUILD0 * SR); i1 = int(SIL0 * SR)
fd[i0:i1] = np.linspace(1, 2.2, i1 - i0)                    # the wind rises into the cut
amb *= fd[:, None]

# ============================================================ master
def gate(buf, a, b, f=.006):
    i0, i1, n = int(round(a * SR)), int(round(b * SR)), int(f * SR)
    buf[i0 - n:i0] *= np.linspace(1, 0, n)[:, None]; buf[i0:i1] = 0

stems = {"music": music * 1.0, "foley": fol * .9, "amb": amb}
for k in stems: gate(stems[k], SIL0, HIT)                     # the silence: everything off
mix = sum(stems.values())
# the arc in level: the document and the chart sit lower, the count and the build climb, the hit is the top
kt = [(0, .5), (3.0, .56), (8.0, .6), (11.4, .62), (12.0, .64), (14.0, .74), (15.0, 1.0), (15.4, .9), (15.9, .62), (17.0, .58), (18.0, .58), (DUR, .6)]   # after the hit everything sits ≥ 2 dB under it
gcurve = np.interp(np.arange(N) / SR, [k[0] for k in kt], [k[1] for k in kt])
mix *= gcurve[:, None]
# the only sound in the silence: one dry rivet tick, far away (≈ −40 dBFS)
r = first("rivet"); tk = X.click(.5, 1) * .012
place(mix, tk, r, 1.0, .2)
# the hit itself must start clean on its sample: no pre-ring (sampler onsets are aligned)
mix = X.compress(mix, thr=.35, ratio=2.5, att=.003, rel=.12) if mix.ndim == 1 else np.stack([X.compress(mix[:, c], thr=.5, ratio=2.0, att=.003, rel=.12) for c in range(2)], 1)
nf = int(.025 * SR); mix[:nf] *= np.linspace(0, 1, nf)[:, None]          # 25 ms fade at sample 0
ne = int(.4 * SR); mix[-ne:] *= np.linspace(1, 0, ne)[:, None] ** 2


def lufs(x):
    """BS.1770-4 integrated loudness (48 kHz K-weighting, 400 ms blocks, absolute and relative gates)."""
    y = lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], x, axis=0)
    y = lfilter([1, -2, 1], [1, -1.99004745483398, 0.99007225036621], y, axis=0)
    bl, hop = int(.4 * SR), int(.1 * SR)
    z = np.array([np.mean(y[i:i + bl] ** 2, 0).sum() for i in range(0, len(y) - bl, hop)])
    L = -.691 + 10 * np.log10(z + 1e-12)
    z = z[L > -70]; rel = -.691 + 10 * np.log10(z.mean()) - 10
    z = z[-.691 + 10 * np.log10(z) > rel]
    return -.691 + 10 * np.log10(z.mean())


def tpeak(x): return np.abs(resample_poly(x, 4, 1, axis=0)).max()


def tp_limit(x, ceil_db, look=.002, rel=.06):
    """Linked-stereo true-peak limiter: 4× oversampled detection, look-ahead min-hold, smoothed release."""
    ceil = 10 ** (ceil_db / 20); n = int(look * SR)
    up = np.abs(resample_poly(x, 4, 1, axis=0)).max(1)
    pk = up[:len(up) // 4 * 4].reshape(-1, 4).max(1)
    pk = np.pad(pk, (0, len(x) - len(pk)), constant_values=0)
    g = np.minimum(1, ceil / np.maximum(pk, 1e-9))
    g = minimum_filter1d(g, 2 * n + 1)
    r = np.exp(-1 / (rel * SR)); out = g.copy()                      # release: recover slowly, attack is the min-hold
    for i in range(1, len(g)): out[i] = min(g[i], r * out[i - 1] + (1 - r) * g[i]) if g[i] > out[i - 1] else g[i]
    out = uniform_filter1d(minimum_filter1d(out, n + 1), n)
    return x * out[:, None]


TARGET, CEIL = -14.0, -2.2
for _ in range(4):                                     # loudness up to −14, peaks held under the ceiling, repeat until both hold
    mix *= 10 ** ((TARGET - lufs(mix)) / 20)
    mix = tp_limit(mix, CEIL)
    if abs(lufs(mix) - TARGET) < .15 and 20 * np.log10(tpeak(mix)) <= CEIL + .05: break
mix = tp_limit(mix, CEIL - .1)
pk = np.abs(mix).max()
print("master: integrated", round(lufs(mix), 2), "LUFS, true peak", round(20 * np.log10(tpeak(mix)), 2), "dBTP")
sf.write(OUT / "mix.wav", mix.astype(np.float32), SR, subtype="PCM_24")
for k, v in stems.items(): sf.write(OUT / "stems" / f"{k}.wav", np.clip(v * 10 ** (-1.8 / 20) / max(1e-9, np.abs(v).max()), -1, 1).astype(np.float32), SR, subtype="PCM_24")
json.dump({"bpm": 120, "anchors": [{"t": round(t, 5), "label": l} for t, l in sorted(SCORE)], "silence": [SIL0, HIT]},
          open(OUT / "score.json", "w"), indent=1)

# report: silence level, low-end balance
def db(x): return 20 * np.log10(max(1e-9, np.sqrt(np.mean(x ** 2))))
sil = mix[int((SIL0 + .02) * SR):int((HIT - .01) * SR)]
print("mix", mix.shape, "peak dBFS", round(20 * np.log10(np.abs(mix).max()), 2), "silence RMS dBFS", round(db(sil), 1))
from numpy.fft import rfft, rfftfreq
mono = mix.mean(1); sp = np.abs(rfft(mono)) ** 2; f = rfftfreq(len(mono), 1 / SR)
low = sp[(f >= 20) & (f < 120)].sum(); rest = sp[(f >= 120) & (f < 16000)].sum()
print("20–120 Hz vs rest (dB):", round(10 * np.log10(low / rest), 1))
print(S.credits(sorted({e[1] for e in ev})) if hasattr(S, "credits") else "")
