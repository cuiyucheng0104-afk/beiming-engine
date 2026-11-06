"""追电车的夏天 —— 原创 city pop 配乐（真实采样 + 拨弦物理建模 + numpy 合成）
读 timeline.json（每拍 13 帧，所有拍点帧对齐），写 out/music.wav、out/stems/*.wav、out/music_cues.json
用法（在库根目录）：.venv/bin/python <工程>/music/score.py
"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', os.getcwd())
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as PL
from core.audio.sfx import SR, limit

S.seed(27)
rng = np.random.default_rng(27)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS, FPB, F18, F19, F20, FC, END_F = TL['FPS'], TL['FPB'], TL['F18'], TL['F19'], TL['F20'], TL['FC'], TL['END_F']
DUR = END_F / FPS + 1.5   # 尾音多留一点，mux 会按画面截断


def bfr(b):   # 第一部分：拍 → 帧（含渐慢）
    if b <= 18: return b * FPB
    if b <= 19: return F18 + (b - 18) * 16
    return F19 + (b - 19) * 19


def A(b): return bfr(b) / FPS                 # 第一部分拍 → 秒
def B(n): return (FC + n * FPB) / FPS         # 接帽后第 n 拍 → 秒


N = int(DUR * SR)
STEMS = {k: np.zeros((N, 2)) for k in ['drums', 'bass', 'keys', 'gtr', 'pad', 'lead', 'fx']}
CUELOG = []


def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def ts(n): return np.arange(n) / SR
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x, axis=0)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x, axis=0)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x, axis=0)


def place(stem, x, t, g=1.0, pan=0.0):
    x = np.asarray(x, float)
    if x.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
        x = np.stack([x * l, x * r], 1)
    s = int(round(t * SR))
    if s >= N: return
    e = min(N, s + len(x)); STEMS[stem][s:e] += x[:e - s] * g


def make_ir(dur, rt60, predelay=.02, damp=4000, seed=1):
    n = int(dur * SR); t = ts(n); r = np.random.default_rng(seed); out = []
    for c in range(2):
        x = r.standard_normal(n) * np.exp(-6.9 * t / rt60)
        x = x * .5 + lp(x, damp, 1) * .5
        out.append(np.concatenate([np.zeros(int(predelay * SR)), x]))
    ir = np.stack(out, 1); return ir / np.sqrt((ir ** 2).sum(0).mean())


IR_PLATE = make_ir(1.0, .85, .006, 7000, 3)
IR_HALL = make_ir(2.4, 1.8, .025, 3600, 4)


def gated(x, hold=.22, fall=.02):
    """门限混响：干声 + 板式混响，混响尾巴在 ~220 ms 被硬切"""
    x = np.asarray(x, float); n = len(x) + int(.3 * SR); x = np.pad(x, (0, n - len(x)))
    wet = np.stack([fftconvolve(x, IR_PLATE[:, c])[:n] for c in range(2)], 1)
    t = ts(n); gate = np.where(t < hold, 1.0, np.clip(1 - (t - hold) / fall, 0, 1))[:, None]
    return x[:, None] * .85 + wet * gate * 1.0

# ───────────── 合成乐器（DX 电钢、slap 贝斯、合成铜管、FM 钟）─────────────


def epiano(m, dur, vel=.7):
    f = mtof(m); rel = .25; n = int((dur + rel) * SR); t = ts(n)
    tau = 1.1 * (262 / f) ** .5 + .3
    re = np.where(t < dur, 1.0, np.exp(-(t - dur) / .07))
    amp = np.exp(-t / tau) * re * np.minimum(1, t / .0015)
    I1 = vel * 1.6 * np.exp(-t / .45) + .3 * vel
    ph = 2 * np.pi * f * t; ph2 = 2 * np.pi * f * 1.0018 * t
    body = .6 * np.sin(ph + I1 * np.sin(ph)) + .4 * np.sin(ph2 + .7 * I1 * np.sin(ph2))
    tine = np.sin(ph + 2.4 * vel * np.exp(-t / .014) * np.sin(14 * ph)) * np.exp(-t / .1) * .32 * vel * re
    return (body * amp + tine) * vel


def slap(m, dur, vel=.8, kind='T'):
    f0 = mtof(m); rel = .03; n = int((dur + rel) * SR); t = ts(n)
    base_tau, kk, tilt, drop, click = dict(T=(1.1, .3, 1.0, .03, .5), P=(.8, .12, .8, .045, .9), F=(1.6, .7, 1.5, .01, .1), G=(.04, .9, 1.4, 0, .6))[kind]
    ph = 2 * np.pi * np.cumsum(f0 * (1 + drop * np.exp(-t / .009))) / SR
    y = np.zeros(n)
    for k in range(1, int(min(40, 9000 / f0)) + 1):
        y += np.sin(k * ph + .37 * k) / k ** tilt * np.exp(-t / (base_tau / (1 + kk * k ** 1.15)))
    y /= 2.2
    cl = hp(rng.standard_normal(n), 2500) * np.exp(-t / .0022) * click
    env = np.minimum(1, t / .0012) * np.where(t < dur, 1, np.exp(-(t - dur) / .012))
    return np.tanh(1.5 * (y + cl) * env) * vel


def saw(freq):
    dt = np.asarray(freq, float) / SR; ph = (rng.random() + np.cumsum(dt)) % 1.0; y = 2 * ph - 1
    m = ph < dt; x = ph[m] / dt[m]; y[m] -= x + x - x * x - 1
    m = ph > 1 - dt; x = (ph[m] - 1) / dt[m]; y[m] -= x * x + x + x + 1
    return y


def brass(m, dur, vel=.8, att=.012):
    f = mtof(m); rel = .12; n = int((dur + rel) * SR); t = ts(n)
    scoop = 2 ** ((-.35 * np.exp(-t / .035)) / 12)
    vib = 1 + .004 * np.sin(2 * np.pi * 5.4 * t) * np.clip((t - .3) / .3, 0, 1)
    y = sum(saw(f * 2 ** (d / 1200) * scoop * vib) for d in (-9, 0, 8)) / 3
    fe = np.where(t < att + .03, np.minimum(1, t / (att + .03)), .55 + .45 * np.exp(-(t - att - .03) / .22))
    cut = f * 1.4 + (1400 + 5 * f) * (.35 + .65 * vel) * fe
    # 分段低通（每 10 ms 一个截止频率）
    out = np.zeros(n); blk = 480; zi = None
    for i in range(0, n, blk):
        sos = butter(2, min(18000, cut[i]), 'low', fs=SR, output='sos')
        if zi is None: zi = np.zeros((sos.shape[0], 2))
        out[i:i + blk], zi = sosfilt(sos, y[i:i + blk], zi=zi)
    env = np.where(t < att, t / att, np.where(t < dur, .8 + .2 * np.exp(-(t - att) / .25), 0))
    env = np.where(t >= dur, (.8) * np.exp(-(t - dur) / (rel / 4)), env)
    return out * env * vel


def bell(m, dur=2.6, vel=.5):
    f = mtof(m); n = int(dur * SR); t = ts(n)
    I = 2.4 * vel * np.exp(-t / .3) + .25
    y = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * 3.5 * f * t)) * np.exp(-t / .9) + .25 * np.sin(2 * np.pi * 2.001 * f * t) * np.exp(-t / .4)
    return y * np.minimum(1, t / .002) * vel


def kick(vel=1.0):
    n = int(.4 * SR); t = ts(n)
    f = 48 + 90 * np.exp(-t / .03) + 360 * np.exp(-t / .0025)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .16) + hp(rng.standard_normal(n), 3000) * np.exp(-t / .004) * .2
    return np.tanh(1.5 * y) * vel


def riser(dur, vel=1.0):
    n = int(dur * SR); t = ts(n); u = t / dur; out = np.zeros(n); x = rng.standard_normal(n)
    for i in range(0, n, 960):
        fc = 300 * (7000 / 300) ** (u[i] ** 1.5); out[i:i + 960] = bp(x[max(0, i - 2000):i + 960], fc * .8, min(fc * 1.25, 20000))[-len(out[i:i + 960]):]
    return out * u ** 2 * vel

# ───────────── 和声 ─────────────
Q = {'M7': [0, 4, 7, 11], 'M9': [0, 4, 7, 11, 14], 'm7': [0, 3, 7, 10], 'm9': [0, 3, 7, 10, 14], '7': [0, 4, 7, 10], '7#9': [0, 4, 10, 15], '13': [0, 4, 10, 14, 21], '7sus4': [0, 5, 7, 10], '9sus4': [0, 5, 10, 14]}
PC = dict(C=0, Db=1, D=2, Eb=3, E=4, F=5, Gb=6, G=7, Ab=8, A=9, Bb=10, B=11, **{'F#': 6, 'C#': 1})
# (起拍, 拍数, 根, 性质)
CH1 = [(0, 4, 'G', 'M9'), (4, 2, 'F#', 'm7'), (6, 1, 'E', 'm9'), (7, 1, 'A', '13'),
       (8, 2, 'G', 'M7'), (10, 2, 'F#', '7#9'), (12, 2, 'B', 'm9'), (14, 1, 'A', 'm7'), (15, 1, 'D', '7'),
       (16, 2, 'G', 'M9'), (18, 2, 'A', '9sus4')]
CH2 = [(0, 2, 'Ab', 'M9'), (2, 2, 'G', '7#9'), (4, 2, 'C', 'm9'), (6, 1, 'F', 'm9'), (7, 1, 'Bb', '13'), (8, 5, 'Eb', 'M9')]


def voicing(r, q, lo=55, hi=74):
    root = PC[r]; ns = []
    for iv in Q[q][1:]:
        m = 48 + (root + iv) % 12
        while m < lo: m += 12
        while m > hi: m -= 12
        ns.append(m)
    return sorted(set(ns))


def broot(r): m = 28 + (PC[r] - 4) % 12; return m          # E1..D#2

# ───────────── 写谱 ─────────────


def part1():
    # —— 前奏 b0–b8：半速 DX 电钢 + 弦乐垫 + 沙锤 ——
    ev = []
    for s, d, r, q in CH1[:4]:
        for off in (0, 1.5, 2.5):   # 半速切分：每个和弦重击几次
            if off < d:
                nxt = min(d, [o for o in (1.5, 2.5, 99) if o > off][0])
                for m in voicing(r, q):
                    place('keys', epiano(m, A(s + nxt) - A(s + off) + .03, .5 if off else .58), A(s + off), .55, -.15)
        ev.append((A(s), r, q, A(s + d) - A(s)))
    for s, d, r, q in CH1[:4]:
        for m in voicing(r, q, 62, 79)[:3]:
            place('pad', S.note('violins', m, A(s + d) - A(s) + .3, vel=.45, attack=.35), A(s), .65, .25)
    for k in range(8, 32):
        b = k / 4
        place('drums', S.hit('shaker', 'down' if k % 2 else 'up', .35 + .2 * (k % 2 == 0)), A(b), .32, .45)
    place('fx', bell(86, 2.4, .45), A(0), .35, .3)
    place('fx', bell(81, 2.4, .35), A(4), .3, -.3)
    # 贝斯 b4 进来（指弹长音）
    for s, d, r, q in CH1[1:4]:
        place('bass', slap(broot(r) + 12, A(s + d) - A(s) - .05, .55, 'F'), A(s), .9, 0)
        place('bass', S.note('electric_bass', broot(r), A(s + d) - A(s), vel=.55), A(s), .55, 0)
    # 鼓 b4–b8：底鼓 + 8 分镲，b7 门限通鼓过门
    for b in (4, 5, 6):
        place('drums', kick(.85), A(b), .8)
        place('drums', S.hit('drum_kit', 'kick_drum_left', .6), A(b), .5)
    for k in range(8, 14): place('drums', S.hit('drum_kit', 'hi_hat_closed', .35 + .15 * (k % 2 == 0)), A(k / 2), .45, .3)
    for i, (sub, tm) in enumerate([(0, 'tom_1'), (.25, 'tom_1'), (.5, 'tom_2'), (.75, 'tom_2'), (1.0, 'tom_3'), (1.25, 'tom_3'), (1.5, 'tom_4'), (1.75, 'tom_4')]):
        place('drums', gated(S.hit('drum_kit', tm, .55 + i * .05)), A(7 + sub / 2), .55, -.4 + i * .1)
    CUELOG.append({'id': 'b6', 'what': '电车铃（拟音）'})

    # —— 主歌 b8–b16：全组 ——
    for s, d, r, q in CH1[4:9]:
        vs = voicing(r, q)
        # 电钢切分：拍位 0, .75, 1.5
        for off in (0, .75, 1.5):
            if off < d:
                for m in vs: place('keys', epiano(m, .22, .6), A(s + off), .42, -.2)
        # 吉他 16 分切音（反拍），右声道
        for k in range(int(d * 4)):
            if k % 2 == 1:
                for j, m in enumerate(voicing(r, q, 64, 79)[:3]):
                    place('gtr', S.note('electric_guitar', m, .07, vel=.5 + .2 * (k % 4 == 3)), A(s + k / 4) + j * .004, .38, .55)
        # 贝斯：拇指根音 + 八度勾弦 + 闷音
        rt = broot(r)
        pat = [(0, 0, 'T', .9), (.75, 0, 'G', .4), (1.0, 12, 'P', .7), (1.5, 0, 'T', .8), (1.75, 7, 'T', .6)]
        for off, iv, kind, v in pat:
            if off < d:
                place('bass', slap(rt + 12 + iv, .2 if kind != 'G' else .06, v, kind), A(s + off), .95, 0)
        place('bass', S.note('electric_bass', rt, A(s + min(d, 1)) - A(s), vel=.6), A(s), .5, 0)
    for b in range(8, 16):
        bar_beat = b % 4
        if bar_beat in (0, 2): place('drums', kick(1), A(b), .9); place('drums', S.hit('drum_kit', 'kick_drum_left', .8), A(b), .5)
        if bar_beat == 2 or bar_beat == 0: place('drums', kick(.7), A(b + .75), .6)
        if bar_beat in (1, 3):
            place('drums', gated(S.hit('drum_kit', 'snare_1', .85)), A(b), .75)
            if b >= 12: place('drums', S.hit('claps', 'group', .7), A(b), .35, .15)
        for k in range(4):
            open_ = (bar_beat == 3 and k == 2)
            place('drums', S.hit('drum_kit', 'hi_hat_open' if open_ else 'hi_hat_closed', .35 + .25 * (k == 0) + .1 * (k == 2), dur=.25 if open_ else None), A(b + k / 4), .42, .3)
    place('drums', S.hit('drum_kit', 'crash_left', .85), A(8), .55, -.4)
    CUELOG.append({'id': 'b8', 'what': '镲 + 全组进入'})
    # b15 军鼓滚奏 + b14 起噪声上升
    for k in range(8): place('drums', gated(S.hit('drum_kit', 'snare_2', .4 + k * .07), hold=.12), A(15 + k / 8), .55, 0)
    place('fx', riser(A(16) - A(14), .5), A(14), .5)
    # 萨克斯主奏（D 大调动机）+ 合成铜管
    mel = [(8, 'A4', .5), (8.5, 'B4', .25), (8.75, 'D5', .75), (9.5, 'E5', .5), (10, 'F#5', 1.0), (11, 'E5', .5), (11.5, 'C#5', .5),
           (12, 'D5', .75), (12.75, 'C#5', .25), (13, 'B4', .5), (13.5, 'F#5', .5), (14, 'E5', 1.0), (15, 'F#5', .5), (15.5, 'A5', .5)]
    for b, p, d in mel: place('lead', S.note('alto_sax', p, A(b + d) - A(b) - .02, vel=.78), A(b), .62, -.05)
    for b, ch in [(8, ['D5', 'F#5', 'A5']), (12, ['D5', 'F#5', 'A5'])]:
        for p in ch: place('lead', brass(S.midi(p), .16, .75), A(b), .22, .2)
    for i, p in enumerate(['A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5']):
        place('lead', brass(S.midi(p), A(14 + (i + 1) / 4) - A(14 + i / 4), .5 + i * .04), A(14 + i / 4), .16, .3)

    # —— b16 帽飞：镲 + 铜管和弦，鼓退，竖琴刮奏（pluck 拨弦），弦乐渐强，渐慢 ——
    place('drums', S.hit('drum_kit', 'crash_right', 1.0), A(16), .7, .35)
    place('drums', kick(1), A(16), 1.0)
    for p in ['B4', 'D5', 'F#5', 'A5']: place('lead', brass(S.midi(p), .5, .85), A(16), .26, -.1)
    place('lead', S.note('alto_sax', 'B5', A(18) - A(16), vel=.82), A(16), .55, -.05)
    CUELOG.append({'id': 'b16', 'what': '镲 + 铜管（帽子被掀起）'})
    gl = [55, 59, 62, 66, 69, 71, 74, 78, 81, 83, 86, 90, 93]   # G 大九和弦上行
    for i, m in enumerate(gl):
        tt = A(16.25) + i * (A(17.75) - A(16.25)) / len(gl)
        place('fx', PL.pluck('harp', m, 1.6, vel=.55 + i * .02), tt, .5, -.5 + i * .08)
    for s, d, r, q in CH1[9:11]:
        for m in voicing(r, q, 62, 81):
            place('pad', S.note('violins', m, A(s + d) - A(s) + .02, vel=.38 + .12 * (r == 'A'), attack=.25), A(s), .55, .1)
        for m in voicing(r, q):
            place('keys', epiano(m, A(s + d) - A(s), .55), A(s), .4, -.2)
        place('bass', slap(broot(r) + 12, A(s + d) - A(s) - .03, .7, 'F'), A(s), .9)
        place('bass', S.note('electric_bass', broot(r), A(s + d) - A(s), vel=.65), A(s), .5)
    # 渐慢：b18、b19 底鼓 + 大通鼓（越来越慢）
    for b in (18, 19):
        place('drums', gated(S.hit('drum_kit', 'tom_4', .8), hold=.3), A(b), .7, -.2)
        place('drums', kick(.9), A(b), .8)
    place('lead', S.note('alto_sax', 'E5', A(19) - A(18), vel=.7), A(18), .5)
    place('lead', S.note('alto_sax', 'D5', A(20) - A(19), vel=.66), A(19), .5)
    CUELOG.append({'id': 'b18', 'what': '渐慢开始'})
    # b20 全体短促切断（然后真静默）
    for p in ['A3', 'D4', 'G4', 'B4', 'E5']: place('lead', brass(S.midi(p), .11, .95), A(20), .3, 0)
    place('drums', gated(S.hit('drum_kit', 'snare_1', 1.0), hold=.08, fall=.01), A(20), .8)
    place('drums', kick(1), A(20), 1.0)
    place('bass', slap(33, .09, .9, 'P'), A(20), 1.0)
    CUELOG.append({'id': 'b20', 'what': '全体切断 → 真静默'})


def part2():
    # —— C：接帽，升半音（降 E 大调），全体回来 ——
    place('drums', S.hit('drum_kit', 'crash_left', 1.0), B(0), .8, -.3)
    place('drums', S.hit('drum_kit', 'crash_right', .9), B(0), .55, .4)
    place('drums', kick(1.1), B(0), 1.1)
    for p in ['Eb4', 'Ab4', 'C5', 'G5', 'Bb5']: place('lead', brass(S.midi(p), .55, 1.0), B(0), .32, 0)
    CUELOG.append({'id': 'C+0', 'what': '接帽：全体 + 铜管和弦（升半音）'})
    for s, d, r, q in CH2[:5]:
        vs = voicing(r, q, 56, 75)
        for off in (0, .75, 1.5):
            if off < d:
                for m in vs: place('keys', epiano(m, .25, .65), B(s + off), .45, -.2)
        for k in range(int(d * 4)):
            if k % 2 == 1:
                for j, m in enumerate(voicing(r, q, 65, 80)[:3]):
                    place('gtr', S.note('electric_guitar', m, .07, vel=.55 + .2 * (k % 4 == 3)), B(s + k / 4) + j * .004, .42, .55)
        rt = broot(r)
        for off, iv, kind, v in [(0, 0, 'T', .95), (.75, 0, 'G', .45), (1.0, 12, 'P', .75), (1.5, 0, 'T', .85), (1.75, 7, 'T', .6)]:
            if off < d: place('bass', slap(rt + 12 + iv, .2 if kind != 'G' else .06, v, kind), B(s + off), 1.0)
        place('bass', S.note('electric_bass', rt, B(s + min(d, 1)) - B(s), vel=.65), B(s), .5)
        for m in voicing(r, q, 63, 82)[:4]:
            place('pad', S.note('violins', m, B(s + d) - B(s) + .05, vel=.42, attack=.12), B(s), .5, .2)
    for n in range(0, 7):
        bb = n % 4
        if bb in (0, 2): place('drums', kick(1), B(n), .95); place('drums', S.hit('drum_kit', 'kick_drum_left', .8), B(n), .5); place('drums', kick(.7), B(n + .75), .6)
        if bb in (1, 3): place('drums', gated(S.hit('drum_kit', 'snare_1', .9)), B(n), .8); place('drums', S.hit('claps', 'group', .75), B(n), .4, .15)
        for k in range(4): place('drums', S.hit('drum_kit', 'hi_hat_closed', .4 + .25 * (k == 0) + .1 * (k == 2)), B(n + k / 4), .45, .3)
    # 副歌旋律：萨克斯 + 合成铜管低八度齐奏
    mel = [(0, 'Eb5', 1.5), (1.5, 'F5', .5), (2, 'G5', 1.0), (3, 'F5', .5), (3.5, 'D5', .5), (4, 'Eb5', 1.5), (5.5, 'D5', .25), (5.75, 'C5', .25),
           (6, 'Ab5', 1.0), (7, 'G5', .5), (7.5, 'F5', .5), (8, 'G5', 3.0)]
    for n, p, d in mel:
        place('lead', S.note('alto_sax', p, B(n + d) - B(n) - .02, vel=.82), B(n), .66, -.05)
        place('lead', brass(S.midi(p) - 12, B(n + d) - B(n) - .03, .6), B(n), .14, .25)
    # C+6 白闪：镲 + 反向吊镲；C+7 标题：铜管短击
    place('drums', S.hit('drum_kit', 'crash_right', .85), B(6), .55, .4)
    rev = S.hit('drum_kit', 'crash_left', .7)[:int(.8 * SR)][::-1]
    place('fx', rev, B(6) - .8, .35, -.3)
    CUELOG.append({'id': 'C+6', 'what': '白闪：镲'})
    for p in ['D4', 'Ab4', 'C5', 'F5', 'G5']: place('lead', brass(S.midi(p), .2, .95), B(7), .32, 0)
    place('drums', gated(S.hit('drum_kit', 'snare_1', 1.0)), B(7), .8); place('drums', kick(1), B(7), 1.0)
    for s, d, r, q in CH2[5:7]:
        for m in voicing(r, q):
            place('keys', epiano(m, B(s + d) - B(s), .6), B(s), .45, -.2)
        place('bass', slap(broot(r) + 12, .3, .8), B(s), 1.0)
    CUELOG.append({'id': 'C+7', 'what': '标题：铜管短击 + 军鼓'})
    # C+8 尾声：Ebmaj9 延音，鼓收，钟音
    place('drums', S.hit('drum_kit', 'crash_left', .8), B(8), .5, -.3); place('drums', kick(1), B(8), .9)
    for m in voicing('Eb', 'M9', 55, 77): place('keys', epiano(m, 3.2, .62), B(8), .5, -.2)
    for m in voicing('Eb', 'M9', 63, 84): place('pad', S.note('violins', m, 3.6, vel=.4, attack=.2), B(8), .55, .2)
    place('bass', slap(broot('Eb') + 12, 2.6, .75, 'F'), B(8), .9); place('bass', S.note('electric_bass', broot('Eb'), 2.6, vel=.6), B(8), .5)
    for i, (n, m) in enumerate([(8, 94), (9, 91), (10, 87), (11, 89), (12, 94)]):
        place('fx', bell(m, 2.2, .4 - i * .03), B(n), .35, .4 - i * .2)
    place('fx', S.note('glockenspiel', 'Bb6', 1.5, vel=.5), B(7), .4, .3)
    place('fx', S.note('glockenspiel', 'G6', 1.5, vel=.45), B(12), .4, -.3)
    CUELOG.append({'id': 'C+12', 'what': '最后的钟音'})


part1(); part2()
# 真静默：b20 切断后 60 ms 起到 C 之前，所有音乐声部压到 0
s0, s1 = int((A(20) + .06) * SR), int(B(0) * SR) - 1
fade = int(.03 * SR)
for k, x in STEMS.items():
    x[s0:s0 + fade] *= np.linspace(1, 0, fade)[:, None]; x[s0 + fade:s1] = 0

GAIN = dict(drums=1.0, bass=.5, keys=.6, gtr=.55, pad=.5, lead=.8, fx=.7)
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
mixb = np.zeros((N, 2))
for k, x in STEMS.items():
    y = x * GAIN[k]
    if k in ('keys', 'lead', 'pad', 'fx', 'gtr'):
        send = {'keys': .22, 'lead': .2, 'pad': .3, 'fx': .35, 'gtr': .12}[k]
        wet = np.stack([fftconvolve(y.sum(1) * .5, IR_HALL[:, c])[:N] for c in range(2)], 1) * send
        wet[s0 + fade:s1] *= 0   # 静默里也不留混响尾巴
        y = y + wet
    if k == 'bass': y = hp(y, 35)
    if k in ('drums', 'bass'): y = y - (.72 if k == 'drums' else .45) * lp(y, 120)   # 低频搁架：20–120 Hz 收掉一些，免得小音箱糊
    sf.write(os.path.join(HERE, 'out', 'stems', k + '.wav'), y.astype(np.float32), SR)
    mixb += y
pk = np.percentile(np.abs(mixb), 99.99)
mixb = mixb * (.85 / pk)
mixb = np.stack([limit(mixb[:, c], .95) for c in range(2)], 1)
sf.write(os.path.join(HERE, 'out', 'music.wav'), mixb.astype(np.float32), SR)
for c in CUELOG:
    i = c['id']; c['t'] = round(A(int(i[1:])) if i.startswith('b') else B(float(i[2:])), 4)
json.dump(CUELOG, open(os.path.join(HERE, 'out', 'music_cues.json'), 'w'), ensure_ascii=False, indent=1)
print('music.wav', round(N / SR, 2), 's; cues', len(CUELOG))
print('\n'.join(S.credits(['alto_sax', 'electric_guitar', 'electric_bass', 'drum_kit', 'violins', 'claps', 'shaker', 'glockenspiel'])))
