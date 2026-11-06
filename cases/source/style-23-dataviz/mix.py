"""地球的一秒 — 原创配乐 + 拟音 + 环境，一次写出 out/mix.wav。
读 events.json（页面 window.EV，由 core/render/events.mjs 导出）与 timeline.json（tools/export_timeline.mjs 导出）。
乐器：pluck.py kalimba（出生）· numpy 低通门 FM plonk（闪电）· numpy 失谐锯齿 pad / 正弦 sub / S&H 光点 / riser ·
sampler.py 真实采样：bass_drum、hihat、shaker、timpani、sus_cymbal、gong、glockenspiel、woodblock、claves。
静默段 [拍18, 拍20) 在最终混音里是数字零；静默后的一切在独立缓冲里，尾巴不跨越静默。
用法：$LIB/.venv/bin/python mix.py   （LIB 环境变量指向库根目录）
"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, bp, lp, hp, limit
from core.audio import sampler as S
from core.audio import pluck as PL

S.seed(23)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
TLJ = json.load(open(os.path.join(HERE, 'timeline.json')))
EV, DUR = EVJ['ev'], EVJ['dur']
B = 60 / TLJ['BPM']; T = lambda b: b * B
N = int(round(DUR * SR))
K = TLJ['K']
SIL0, SIL1 = T(K['silence'][0]), T(K['silence'][1])
rng = np.random.default_rng(2025)
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
tt = lambda d: np.arange(int(round(d * SR))) / SR
CUES = []                                   # 每个落到时间线上的声音：{t, ev, layer}，给 cuecheck.py 核对


def buf(): return np.zeros((N, 2), np.float32)
def put(dst, x, t, g=1.0, pan=0.0, ev=None, layer=None):
    i = int(round(t * SR)); x = np.asarray(x, np.float32)
    if ev: CUES.append({'t': round(i / SR, 6), 'ev': ev, 'layer': layer})
    if i >= N or len(x) == 0: return
    n = min(len(x), N - i); l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    if x.ndim == 1: dst[i:i + n, 0] += x[:n] * g * l * 1.414; dst[i:i + n, 1] += x[:n] * g * r * 1.414
    else: dst[i:i + n] += x[:n] * g
def fade_tail(x, ms=5):
    k = min(len(x), int(ms * SR / 1000)); x = np.array(x, np.float32); x[-k:] *= np.linspace(1, 0, k)[:, None] if x.ndim == 2 else np.linspace(1, 0, k); return x


# ============ 乐器 ============
def plonk(f, tau, vel=1.0, index=.4, detune_c=0.0, dur=None):
    """低通门 plonk：正弦 + FM，FM 指数越大越金属；亮度比音量衰减得快（vactrol）"""
    dur = dur or min(3.0, tau * 7 + .04); t = tt(dur)
    env = np.exp(-t / tau); a = int(.002 * SR); env[:a] *= np.linspace(0, 1, a)
    benv = np.exp(-t / (tau * .5))
    def osc(ff):
        mod = np.sin(2 * np.pi * ff * 1.41 * t) * index * benv             # 非整数比 → 带一点钟/雷的金属味
        return np.sin(2 * np.pi * ff * t + mod) + .18 * np.sin(4 * np.pi * ff * t + mod * .6) * benv
    x = osc(f)
    if detune_c: x = .6 * x + .5 * osc(f * 2 ** (detune_c / 1200))
    thud = np.sin(2 * np.pi * 140 * t) * np.exp(-t / .01) * .12
    return ((x * env + thud) * vel).astype(np.float32)

def saw(f, d, cents=(-8, 0, 7)):
    t = tt(d); out = np.zeros_like(t)
    for c in cents:
        ph = (t * f * 2 ** (c / 1200) + rng.random()) % 1.0; out += 2 * ph - 1
    return out / len(cents)

def pad(notes, d, cut, att=.4, rel=.6, cut_end=None):
    x = sum(saw(hz(m), d) for m in notes) / np.sqrt(len(notes))
    if cut_end is None: x = lp(x, cut, 2)
    else:                                                                # 低通逐块打开
        blk = 2400; y = np.zeros_like(x)
        for i in range(0, len(x), blk):
            c = cut + (cut_end - cut) * i / len(x); lo = max(0, i - 4800)
            y[i:i + blk] = lp(x[lo:i + blk], c, 2)[i - lo:]
        x = y
    t = tt(d)[:len(x)]
    env = np.minimum(1, t / max(att, 1e-3)) * np.clip((d - t) / rel, 0, 1) ** 1.5
    return (x * env * (1 + .05 * np.sin(2 * np.pi * .3 * t))).astype(np.float32)

def sub(m, d, att=.05, rel=.4):
    t = tt(d); f = hz(m)
    x = np.sin(2 * np.pi * f * t) + .35 * np.sin(4 * np.pi * f * t) + .18 * np.sin(6 * np.pi * f * t)   # 2、3 次谐波：小喇叭也听得见
    return (x * np.minimum(1, t / att) * np.clip((d - t) / rel, 0, 1)).astype(np.float32)

def kick_syn(v=1.0):
    t = tt(.32); f = 46 + 80 * np.exp(-t / .025); ph = np.cumsum(f) / SR
    return (np.sin(2 * np.pi * ph) * np.exp(-t / .13) * v).astype(np.float32)

def sh_blip(m, v=1.0):
    t = tt(.09); return (np.sin(2 * np.pi * hz(m) * t) * np.exp(-t / .022) * v).astype(np.float32)


# ============ 拟音（石墨、纸、木） ============
def g_tap(v=1.0, bright=1.0):
    """铅笔尖敲纸：极短高频噪声 + 纸面低鸣"""
    d = .05; t = tt(d)
    x = hp(rng.standard_normal(len(t)), 1800 * bright) * np.exp(-t / .0025) + np.sin(2 * np.pi * 320 * t) * np.exp(-t / .008) * .35
    return (x * v).astype(np.float32)

def scratch(d, v=1.0, rate=9.0):
    """手写：石墨在纸上，笔画节奏 ~9 Hz 的颗粒"""
    t = tt(d); n = rng.standard_normal(len(t))
    strokes = np.clip(np.sin(2 * np.pi * rate * t + 2 * np.sin(2 * np.pi * 2.3 * t)), 0, 1) ** .7
    x = bp(n, 2200, 7000) * (.35 + .65 * strokes) + bp(n, 600, 1400) * .2 * strokes
    e = np.minimum(1, t / .02) * np.minimum(1, (d - t) / .04)
    return (x * e * v).astype(np.float32)

def ruler_hiss(d, v=1.0):
    t = tt(d); n = rng.standard_normal(len(t))
    sweep = np.zeros_like(n)
    for i in range(0, len(n), 2400):
        c = 3000 + 2500 * i / len(n); lo = max(0, i - 4800); sweep[i:i + 2400] = bp(n[lo:i + 2400], c * .6, c * 1.4)[i - lo:]
    e = np.minimum(1, t / .05) * np.minimum(1, (d - t) / .06)
    return (sweep * e * v).astype(np.float32)

def paper_sweep(d, v=1.0):
    t = tt(d); n = rng.standard_normal(len(t))
    x = lp(bp(n, 300, 3500), 2500) * np.sin(np.pi * t / d) ** 1.5
    return (x * v).astype(np.float32)

def puncture(v=1.0):
    """纸被戳穿：撕裂的高频颗粒 + 一声闷响"""
    d = .4; t = tt(d); n = rng.standard_normal(len(t))
    tear = hp(n, 2500) * (rng.random(len(t)) > .7) * np.exp(-t / .05)
    thud = np.sin(2 * np.pi * 70 * t * (1 - .4 * t)) * np.exp(-t / .09)
    return ((tear * .7 + hp(n, 1200) * np.exp(-t / .004) * 1.2 + thud) * v).astype(np.float32)

def ratchet_tooth(v=1.0, pitch=1.0):
    d = .06; t = tt(d)
    x = hp(rng.standard_normal(len(t)), 2000) * np.exp(-t / .002) * 1.2
    x += sum(a * np.sin(2 * np.pi * f * pitch * t) * np.exp(-t / tau) for f, a, tau in [(1850, .6, .01), (3300, .4, .006), (720, .5, .014)])
    return (x * v).astype(np.float32)

def air(d, v=1.0):
    t = tt(d); n = rng.standard_normal(len(t))
    return (bp(n, 500, 2500) * np.sin(np.pi * t / d) ** 2 * v).astype(np.float32)

def thunder(d, v=1.0):
    t = tt(d); w = np.cumsum(rng.standard_normal(len(t))); w -= np.linspace(w[0], w[-1], len(w))
    x = lp(hp(w, 25), 180); x /= np.abs(x).max() + 1e-9
    roll = 1 + .8 * np.clip(np.sin(2 * np.pi * .37 * t + 1) * np.sin(2 * np.pi * .9 * t), 0, 1)
    return (x * roll * v).astype(np.float32)

def rain(d, v=1.0):
    t = tt(d); n = rng.standard_normal(len(t))
    drops = hp(n * (rng.random(len(t)) > .992), 3000) * 2
    return (bp(n, 800, 9000) * .35 + drops).astype(np.float32) * v


# ============ 数据之声（声音化） ============
DMIN_PENT = [2, 5, 7, 9, 0]                                   # D F G A C
def snap_pent(m):
    return float(min((abs(m - (o * 12 + pc)), o * 12 + pc) for o in range(3, 9) for pc in DMIN_PENT)[1])

pre, post = buf(), buf()                                      # 静默前 / 静默后
data = buf()
marks = sorted([e for e in EV if e['type'] in ('birth', 'bolt')], key=lambda e: e['t'])
MK = {(m['kind'], m['n']): m for m in TLJ['MARKS']}
BIRTH_P = [69, 72, 74, 77]                                     # A4 C5 D5 F5：出生一次比一次高
notes_log = []
for e in marks:
    m = MK[(e['type'], e['n'])]; pan = -.6 + 1.2 * m['sec']; gap = e['gap']
    if e['type'] == 'birth':
        x = PL.pluck('kalimba', BIRTH_P[e['n'] - 1], 1.6, vel=.85)
        put(data, x, e['t'], 2.2, pan * .6, ev=f"birth{e['n']}", layer='kalimba')
        put(data, g_tap(.35), e['t'], .5, pan, layer='tap')
        notes_log.append({'t': e['t'], 'kind': 'birth', 'midi': BIRTH_P[e['n'] - 1]})
        continue
    n = e['n']                                                 # 闪电：音高 = 泳道里的值 + 累计数抬升
    raw = 55 + m['v'] * 16 + n * .32
    if n <= 14: mm = snap_pent(raw); det = 0
    elif n <= 30: mm = float(round(raw)); det = 0
    else: mm = raw; det = 6 + 30 * (n - 31) / 13               # 极端：不量化 + 失谐递增
    index = float(np.interp(n, [1, 14, 30, 44], [.35, .9, 1.8, 3.2]))
    tau = float(np.clip(gap * .45, .035, .45))                 # 衰减 ≤ 1.5 × 间隔
    vel = float(np.interp(gap, [.083, .167, .333, .667], [.38, .5, .7, .9]))
    dens = 1.0 if e['b'] < 10 else .6                          # 冲刺段整体让位 −4.4 dB：拍 20 才是全片最响
    put(data, plonk(hz(mm), tau, vel, index, det), e['t'], .48 * dens, pan, ev=f"bolt{n}", layer='plonk')
    put(data, g_tap(.25 if gap < .1 else .4), e['t'], .35 * dens, pan, layer='tap')
    notes_log.append({'t': e['t'], 'kind': 'bolt', 'midi': round(mm, 2), 'detune_c': round(det, 1), 'fm': round(index, 2)})
data = S.room(data, size=.3, mix=.14)
pre += data

# ============ 底床（静默前） ============
bed = buf()
# S&H 光点：问题段，八分音符、五声随机
for k in range(8):
    b = .5 + k * .5
    if b >= 4: break
    put(bed, sh_blip(snap_pent(74 + rng.integers(-5, 9)), .5), T(b), .12, rng.uniform(-.7, .7))
# sub：D2 整段，随小节呼吸
put(bed, sub(38, T(16), att=T(1), rel=.3), 0, .11)
# pad：Dm9 → Bbmaj7 → C/D（低通随加速逐步打开）
put(bed, pad([50, 57, 62, 64, 65], T(8), 650, att=T(2), rel=.4), 0, .11)
put(bed, pad([58, 62, 65, 69, 50], T(4) + .3, 800, att=.25, rel=.35, cut_end=1200), T(8), .1)
put(bed, pad([60, 64, 67, 62, 50], T(4) + .3, 1200, att=.2, rel=.3, cut_end=2400), T(12), .075)
# 软底鼓（真实采样 bass_drum + 合成头）：拍 4、8，然后拍 12 起四分音符
kb = [4, 8] + [12, 13, 14, 15]
for b in kb:
    v = .35 if b < 12 else .4
    put(bed, S.hit('bass_drum', None, v), T(b), .55 if b < 12 else .4, 0, ev=f'kick@{b}', layer='kick')
    put(bed, kick_syn(.5), T(b), .35 if b < 12 else .24)
# 低通 hats：拍 4–12 八分，拍 12–16 十六分
b = 4.5
while b < 16 - 1e-9:
    h = lp(S.hit('hihat', 'closed', .35 if b < 12 else .3), 7000)
    put(bed, h, T(b), .16 if b < 10 else .1 if b < 12 else .07, .25 + .1 * np.sin(b))
    b += .5 if b < 12 else .25
# 沙锤（真实采样）：拍 10 起十六分
b = 10.0
while b < 16 - 1e-9:
    put(bed, S.hit('shaker', 'down' if (b * 4) % 2 == 0 else 'up', .4), T(b), .07 if (b * 4) % 2 == 0 else .045, -.3)
    b += .25
# 总数落定：拍 16 一声 timpani 闷响
put(bed, S.hit('timpani', 'drum1', .35), T(K['settle']), .35, 0, ev='settle', layer='timpani')
# riser：拍 16.5 → 18，噪声扫频 + 锯齿上滑，在静默起点一刀切断
d = SIL0 - T(K['riser'][0]); t = tt(d); f = hz(50) * 2 ** (t / d * 1.5); ph = np.cumsum(f) / SR
rs = (2 * (ph % 1) - 1) * .4 + bp(rng.standard_normal(len(t)), 900, 6000) * .5
rs = np.concatenate([lp(rs[i:i + 2400], 500 + 5000 * (i / len(rs)) ** 2) for i in range(0, len(rs), 2400)])
put(bed, rs * (t[:len(rs)] / d) ** 2, T(K['riser'][0]), .4, 0, ev='riser', layer='riser')
bed = S.room(bed, size=.25, mix=.1)
pre += bed

# ============ 环境（静默前） ============
amb = buf()
put(amb, lp(rng.standard_normal(int(SIL0 * SR)), 900) * np.minimum(1, tt(SIL0) / 1.0), 0, .006)       # 纸面房间底噪
flip_t = T(K['flip'][0])
d = SIL0 - flip_t + .1                                          # 雷声远隆：换红铅笔时 J-cut 进来
th = thunder(d, 1) * np.minimum(1, tt(d)[:int(round(d * SR))] / 1.2) * np.clip((SIL0 - flip_t - tt(d)) / 1.5, 0, 1)
put(amb, th, flip_t, .22, ev='thunder_in', layer='ambience')
pre += amb

# ============ 拟音（静默前） ============
fol = buf()
for e in EV:
    ty, t0 = e['type'], e['t']
    if t0 >= SIL0: continue
    if ty == 'axis': put(fol, ruler_hiss(e['dur'], 1), t0, .16, .2, ev='axis', layer='foley')
    elif ty == 'tick': put(fol, lp(g_tap(.9), 7000), t0, .22, -.5 + .25 * e['i'], ev=f"tick{e['i']}", layer='foley')
    elif ty == 'label': put(fol, lp(g_tap(.5, .6), 7000), t0, .2, -.7, ev=f"label{e['i']}", layer='foley')
    elif ty == 'write': put(fol, scratch(e['dur'], 1), t0, .14, -.3, ev=f'write@{e["b"]}', layer='foley')
    elif ty == 'flip':
        put(fol, S.hit('woodblock', None, .3), t0, .3, .4, ev='flip', layer='foley')
        put(fol, air(e['dur'], 1), t0, .05, .4)
    elif ty == 'settle': put(fol, g_tap(.7), t0, .25, .5, layer='foley')
pre += fol

# ============ 静默后（独立缓冲） ============
P2 = buf()
TAP = T(K['tap'])
# —— 全片最重要的声音：拍 20 的“戳破” ——
put(P2, puncture(1), TAP, .7, .2, ev='tap', layer='foley')
put(P2, S.hit('bass_drum', None, 1.0), TAP, 1.1, 0, layer='kick')
put(P2, kick_syn(1), TAP, .8)
put(P2, S.hit('sus_cymbal', 'hit', .8), TAP, .42, .3)
put(P2, S.hit('gong', None, .8), TAP, .8, -.2)
CH = [(20, [58, 62, 65, 70, 74], 34), (21, [60, 64, 67, 72, 76], 36), (22, [62, 66, 69, 74, 78], 38)]   # Bb → C → D，逐级变亮
for i, (b0, ns, root) in enumerate(CH):
    d = T(1) + .25 if i < 2 else T(2.5)
    cg = [.75, .26, .26][i]                                          # 第一级（拍 20）最重
    put(P2, pad(ns, d, 1800 + 900 * i, att=.006, rel=.25 if i < 2 else 1.2), T(b0), cg, 0, ev=f'scale{i + 1}', layer='chord')
    put(P2, sub(root + 12, d, att=.004, rel=.2), T(b0), [.3, .13, .12][i])
    put(P2, S.hit('timpani', f'drum{[2, 3, 4][i]}', .7), T(b0), [.8, .4, .4][i], -.1)
    put(P2, S.note('glockenspiel', ns[-1] + 12 if ns[-1] + 12 <= 96 else ns[-1], 1.5, .6), T(b0), .3, .35)
# 棘轮齿：每一级 4 齿，1/32 音符
for e in [e for e in EV if e['type'] == 'tooth']:
    put(P2, ratchet_tooth(1, 1 + .12 * e['level'] + .03 * e['k']), e['t'], .45, .5, ev=f"tooth{e['level']}.{e['k']}", layer='foley')
    put(P2, S.hit('claves', None, .25), e['t'], .08, .5)
# 点阵颗粒云：一秒被放大，点多到听成雨
grain = buf(); g0, g1 = TAP + .02, T(23.5)
cnt = 420
for j in range(cnt):
    u = (j / cnt) ** .7; t0 = g0 + u * (g1 - g0) + rng.uniform(0, .02)
    mm = snap_pent(rng.uniform(74, 98)); pan = rng.uniform(-.9, .9)
    put(grain, plonk(hz(mm), .04, .25 * (1 - .5 * u), .6 + 2 * u, 0, .2), t0, .16, pan)
grain = S.room(grain, size=.5, mix=.3)
P2 += grain
# 面积块形变：纸面扫刷
for e in EV:
    ty, t0 = e['type'], e['t']
    if t0 < TAP: continue
    if ty == 'morph': put(P2, paper_sweep(e['dur'] + .2, 1), t0, .2, -.2, ev='morph', layer='foley')
    elif ty == 'enter': put(P2, air(e['dur'] + .15, 1), t0, .12, .6, ev='enter', layer='foley')
    elif ty == 'write':
        put(P2, scratch(e['dur'], 1, 7 if e.get('kind') == 'bracket' else 10), t0, .17, .4, ev=f'write@{e["b"]}', layer='foley')
    elif ty == 'strike': put(P2, scratch(e['dur'], 1.3, 5), t0, .22, 0, ev='strike', layer='foley')
    elif ty == 'exit': put(P2, air(e['dur'] + .2, 1.2), t0, .14, .7, ev='exit', layer='foley')
# 回答：D 大九余响 + 写字时的慢 plonk + 最后一个出生音（下一秒的第一个婴儿）
END = DUR
RING = END - .3                                                  # 床层在最后 0.3 s 前自己落完：尾音是自然衰减，不是淡出截断
put(P2, pad([50, 57, 62, 64, 66, 69], RING - T(24), 900, att=.8, rel=2.0), T(24), .12, 0, ev='dmaj9', layer='pad')
put(P2, sub(38, RING - T(24), att=.6, rel=1.5), T(24), .09)
for b0, mm in [(24, 78), (25, 81), (25.5, 86)]:
    put(P2, plonk(hz(mm), .5, .5, .4), T(b0), .22, .2)
lastk = PL.pluck('kalimba', 74, 1.6, vel=.8); tk = tt(len(lastk) / SR)[:len(lastk)]
lastk = lastk * np.exp(-np.maximum(0, tk - .45) / .22)[:, None] if lastk.ndim == 2 else lastk * np.exp(-np.maximum(0, tk - .45) / .22)   # 手指轻按簧片：余响在片尾前自然落到 −40 dB 以下
put(P2, lastk, T(K['last']), 1.4, 0, ev='last', layer='kalimba')
# 雨与雷的宽床：静默后 L-cut 一直延到结尾
d = END - TAP; rn = rain(d, 1) * np.minimum(1, tt(d)[:int(round(d * SR))] / .4) * np.clip((RING - TAP - tt(d)) / 2.5, 0, 1)
put(P2, rn, TAP, .05, 0, ev='rain', layer='ambience')
put(P2, thunder(3.0, 1) * np.exp(-tt(3.0) / 1.2), TAP + .05, .3, -.3)
P2 = S.room(P2, size=.45, mix=.18)

# ============ 总线 ============
out = pre.copy()
i0, i1 = int(round(SIL0 * SR)), int(round(SIL1 * SR))
fade = int(.004 * SR); out[i0 - fade:i0] *= np.linspace(1, 0, fade)[:, None]
out[i0:] = 0                                                    # 静默前的尾巴到此为止
att = int(.0015 * SR); P2[i1:i1 + att] *= np.linspace(0, 1, att)[:, None] ** 2  # 1.5 ms 起音斜坡：防 AAC 在静默→强音处振铃过冲
out += P2                                                       # P2 在 i1 之前全为零
leak = float(np.abs(P2[:i1]).max()); assert leak < 1e-5, f'post buffer leaks before the tap: {leak}'  # 只允许 FFT 卷积的数值噪声
out[i0:i1] = 0.0                                                # 真正的数字静默
ef = int(.2 * SR); out[-ef:] *= np.linspace(1, 0, ef)[:, None]
PRE_GAIN, CEIL_PRE, CEIL_POST = .8, .38, .47                                  # 静默前限得紧、静默后放松：拍 20 的动态不被总线压平
for c in range(2):
    out[:i0, c] = limit(out[:i0, c] * PRE_GAIN, CEIL_PRE)
    out[i1:, c] = limit(out[i1:, c], CEIL_POST)
out[i0:i1] = 0.0
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), out, SR, subtype='PCM_24')
json.dump({'sr': SR, 'silence': [SIL0, SIL1], 'cues': CUES, 'notes': notes_log}, open(os.path.join(HERE, 'out', 'cues.json'), 'w'), indent=1)
# 低频平衡报告
spec = np.abs(np.fft.rfft(out.mean(1))) ** 2; fr = np.fft.rfftfreq(len(out), 1 / SR)
lo = spec[(fr > 20) & (fr < 120)].sum(); rest = spec[(fr >= 120) & (fr < 16000)].sum()
print(f'mix.wav {len(out) / SR:.3f}s peak {np.abs(out).max():.3f}  low(20-120)/rest = {10 * np.log10(lo / rest):+.1f} dB  cues {len(CUES)}')
used = ['bass_drum', 'hihat', 'shaker', 'timpani', 'sus_cymbal', 'gong', 'glockenspiel', 'woodblock', 'claves']
open(os.path.join(HERE, 'out', 'sampler_credits.txt'), 'w').write(str(S.credits(used)))
