"""四连关 · 原创配乐 + 拟音 + 混音 → out/mix.wav
节拍全部来自 out/timeline.json（timeline.js 导出），拟音全部来自 events.json（页面 window.EV 导出）。
乐器：律动 = 采样鼓组（MuldjordKit）+ numpy 合成芯片底鼓 / 脉冲贝斯 / 方波主奏；铜管 stab 与号角 = VSCO2 小号/长号/圆号/大号；
每关一件色彩乐器：蜡笔 = 八音盒（pluck.py music_box）+ 木琴，像素 = 方波琶音（numpy），网印 = 硬槌颤音琴，水墨 = 古琴（pluck.py guqin）。
"""
import os, sys, json
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P, sfx as X
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
SR = X.SR
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = TL['dur']; N = int(round(DUR * SR)); FPS = TL['fps']
SEG = {s['id']: s for s in TL['segs']}
S.seed(32)
rng = np.random.default_rng(32)
LOG = []   # (t, 名称) 供核对脚本：音乐里落在拍点上的重音

def bt(seg, i):  # 段内第 i 拍（可小数）的秒数——与画面同一公式
    s = SEG[seg]; return (s['f0'] + round(i * s['fpb'] * 1000) / 1000) / FPS
def spb(seg): return SEG[seg]['fpb'] / FPS
def buf(): return np.zeros((N, 2), np.float32)
def add(B, x, t, g=1.0, pan=0.0):
    if x.ndim == 2:
        s = int(round(t * SR));
        if s >= N: return
        x = x[:N - s]; B[s:s + len(x)] += x * g; return
    X.add(B, x.astype(np.float32), t, g, pan)
def lpf(x, f): return sosfilt(butter(2, f, 'low', fs=SR, output='sos'), x)
def hpf(x, f): return sosfilt(butter(2, f, 'high', fs=SR, output='sos'), x)
def bpf(x, a, b): return sosfilt(butter(2, [a, b], 'band', fs=SR, output='sos'), x)
def tt(d): return np.arange(int(d * SR)) / SR
def hz(p): return S.hz(p)
def adsr(n, a=.003, d=.08, s=.6, r=.05, hold=None):
    e = np.ones(n); A = int(a * SR); D = int(d * SR); R = int(r * SR); H = n - R if hold is None else min(n - R, int(hold * SR))
    e[:A] = np.linspace(0, 1, max(A, 1))[:len(e[:A])]
    if D > 0: e[A:A + D] = np.linspace(1, s, D)[:len(e[A:A + D])]
    e[A + D:H] = s
    if R > 0 and H < n: e[H:] = np.linspace(s, 0, n - H)
    return e

# —— numpy 合成：带限脉冲 / 方波（加法合成，不混叠）——
def pulse(f, d, duty=.5, nh=None, vib=0.0, glide=None):
    n = int(d * SR); t = np.arange(n) / SR
    if glide is not None: f_t = f * (glide / f) ** (t / d)
    else: f_t = np.full(n, f)
    if vib: f_t = f_t * (1 + vib * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t / .15))
    ph = 2 * np.pi * np.cumsum(f_t) / SR
    out = np.zeros(n); K = nh or int(min(40, 14000 / max(f, 30)))
    for k in range(1, K + 1):
        a = 2 / (k * np.pi) * np.sin(k * np.pi * duty)
        if abs(a) < 1e-4: continue
        out += a * np.cos(k * ph)
    return out
def chip(f, d, duty=.25, a=.004, dec=.12, sus=.5, rel=.04, vib=0.0, glide=None):
    x = pulse(f, d + rel, duty, vib=vib, glide=glide); return x * adsr(len(x), a, dec, sus, rel, hold=d)
def kick_syn(v=1.0):
    d = .32; t = tt(d); f = 52 + 110 * np.exp(-t / .03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .16)
    x[:200] += hpf(rng.standard_normal(200), 3000) * np.exp(-np.arange(200) / 40) * .4
    return x * v
def subdrop(d=1.0):
    t = tt(d); f = 70 * np.exp(-t / .6) + 30
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .5) * np.minimum(1, t / .005)
def crush(x, bits=4, hold=6):
    y = np.repeat(x[::hold], hold)[:len(x)]; q = 2 ** (bits - 1); return np.round(y * q) / q

# ==================== 配乐 ====================
DR = buf(); BS = buf(); BR = buf(); CO = buf(); LD = buf(); PADB = buf()
KEYS = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7}
def deg(key, d, octv=4):  # 大调音级 → midi
    sc = [0, 2, 4, 5, 7, 9, 11]; o, i = divmod(d, 7)
    return 12 * (octv + 1 + o) + KEYS[key] + sc[i]

def hit(B, inst, var, t, v, g=1.0, pan=0.0):
    x = S.hit(inst, var, v); add(B, x, t, g, pan)

def groove(seg, beats=None, feel='norm', start=0, stop=None):
    """律动：底鼓 / 拍手 / 闭镲，贝斯在 bass() 里"""
    s = SEG[seg]; n = s['beats'] if stop is None else stop
    for i in range(start, n):
        t = bt(seg, i)
        if feel == 'four' or i % 2 == 0:
            add(DR, kick_syn(.9), t, .55); hit(DR, 'drum_kit', 'kick_drum_left', t, .8, .55)
        if feel != 'four' and i % 2 == 1 and i + .5 < n: add(DR, kick_syn(.6), bt(seg, i + .5), .35)
        if i % 2 == 1: hit(DR, 'claps', 'group', t, .8, .6); hit(DR, 'drum_kit', 'snare_1', t, .6, .35)
        sub = 4 if feel in ('16', 'four') else 2
        for k in range(sub):
            tk = bt(seg, i + k / sub); open_ = feel == 'four' and k == 2
            hit(DR, 'drum_kit', 'hi_hat_open' if open_ else 'hi_hat_closed', tk, .6 if k % 2 == 0 else .4, .5 if not open_ else .3, .25)

def bass(seg, roots, octv=2, sub=2, start=0, stop=None):
    """脉冲贝斯：roots = 每拍的根音音级；八分音符八度跳"""
    s = SEG[seg]; n = s['beats'] if stop is None else stop; d = spb(seg) / sub
    for i in range(start, n):
        r = roots[i % len(roots)]
        for k in range(sub):
            m = deg(s['key'], r, octv) + (12 if k % 2 else 0)
            x = chip(hz(m), d * .8, duty=.3, dec=.1, sus=.45, rel=.03)
            x = lpf(x, 1400) + .25 * np.tanh(3 * lpf(x, 400))
            add(BS, x, bt(seg, i + k / sub), .5)

def stab(t, key, chord=(0, 2, 4), v=.85, big=False, oct_=4):
    ev = []
    for d in chord:
        m = deg(key, d, oct_)
        ev += [(t, 'trumpet_stac', m + 12, .25, v, .15), (t, 'trombone_stac', m, .25, v, -.15)]
        if big: ev += [(t, 'horn_stac', m, .3, v, 0), (t, 'trumpet_stac', m + 24 if m + 24 <= 84 else m + 12, .25, v * .8, .3)]
    if big: ev += [(t, 'tuba_stac', deg(key, 0, 2), .4, v, 0), (t, 'trombone_stac', deg(key, 0, 3), .3, v, 0)]
    return ev

BRASS_EV = []
def horn_call(seg_from, i_from, key_to):
    """号角：两个音的上行呼号，落到下一关的 stab 上"""
    t1 = bt(seg_from, i_from); t2 = bt(seg_from, i_from + .5)
    m5 = deg(key_to, 4, 4)
    BRASS_EV.extend([(t1, 'trumpet_stac', m5, .18, .7, .2), (t1, 'horn', m5 - 12, .2, .6, -.2),
                     (t2, 'trumpet', deg(key_to, 0, 5), spb(seg_from) * .45, .75, .2), (t2, 'horn', deg(key_to, 0, 4), spb(seg_from) * .45, .65, -.2)])

def music():
    cmd_t = {}
    # ---- s0：闹钟响 = 开场重拍 ----
    t0 = bt('s0', 0); BRASS_EV.extend(stab(t0, 'C', big=True)); add(DR, kick_syn(1), t0, .7); hit(DR, 'drum_kit', 'crash_left', t0, .9, .5); LOG.append((t0, 'stab'))
    for k in range(4): hit(DR, 'snare2', 'on', bt('s0', 1 + k / 4), .45 + k * .12, .7)          # 小鼓过门
    bass('s0', [4], start=1); add(DR, kick_syn(.8), bt('s0', 1), .45)
    horn_call('s0', 1, 'C')
    # ---- 各关 ----
    for g, key, roots in [('g1', 'C', [0, 0, 3, 3, 4, 4]), ('g2', 'D', [0, 0, 5, 5, 0]), ('g3', 'E', [0, 0, 3, 3, 4, 4]), ('g4', 'F', [0, 3, 4, 0]), ('boss', 'G', [0, 0, 5, 3, 4, 4])]:
        t = bt(g, 0); cmd_t[g] = t
        BRASS_EV.extend(stab(t, key, big=(g == 'boss'))); LOG.append((t, 'stab'))
        hit(DR, 'drum_kit', 'crash_left', t, .7 if g != 'boss' else 1, .4 if g != 'boss' else .7)
    # g1 蜡笔（C）：八音盒动机 + 木琴
    groove('g1'); bass('g1', [0, 0, 3, 3, 4, 4])
    mel = [(0.5, 2, 6), (1, 4, 6), (1.5, 0, 7), (2, 4, 6), (2.5, 5, 6), (3, 3, 6), (3.5, 0, 7), (4, 4, 7)]
    for i, d, o in mel:
        x = P.pluck('music_box', deg('C', d, o - 1), .4, vel=.7); add(CO, x, bt('g1', i), .9, -.25)
    for k, d in enumerate([0, 2, 4, 7]):   # 接住：木琴上行
        add(CO, S.note('xylophone', deg('C', d, 5), .3, .8), bt('g1', 4 + k * .125), .7, .2)
    for k, d in enumerate([4, 5, 6, 7, 9]):   # 欢呼：八音盒上行
        add(CO, P.pluck('music_box', deg('C', d, 5), .3, vel=.6), bt('g1', 5 + k * .1), .6, -.2)
    # s1（C）：✓ 铜管、主奏短句、号角到 D
    BRASS_EV.extend(stab(bt('s1', 0), 'C', (0, 2, 4), .7)); LOG.append((bt('s1', 0), 'stab'))
    groove('s1'); bass('s1', [0, 4])
    for i, d in [(0, 4), (.5, 2), (1, 0)]: add(LD, chip(hz(deg('C', d, 5)), spb('s1') * .45, .5, vib=.004), bt('s1', i), .16, .1)
    horn_call('s1', 1, 'D')
    # g2 像素（D）：方波 16 分琶音；第 3 拍失败——律动抽空一拍，然后转小调
    groove('g2', stop=3); groove('g2', feel='half', start=4); bass('g2', [0, 0, 5], stop=3); bass('g2', [0], start=4, sub=1)
    arp = [0, 2, 4, 7]
    for i in range(3):
        for k in range(4):
            d = arp[k] + (5 if i == 2 else 0)
            add(CO, chip(hz(deg('D', d, 5)), spb('g2') / 4 * .7, .125, dec=.05, sus=.3), bt('g2', i + k / 4), .15, .3 * (1 if k % 2 else -1))
    for k, m in enumerate([0, -1, -2, -3]):   # 失败：方波"哇哇"下滑
        n0 = deg('D', 4, 4) + m
        add(CO, chip(hz(n0), .16 if k < 3 else .42, .5, vib=.012 if k == 3 else 0, glide=hz(n0 - .6) if k == 3 else None), bt('g2', 3) + 4 / FPS + k * .17, .16)
    for k, d in enumerate([0, 2, 4]):   # 小调余音（Dm）
        add(CO, chip(hz(deg('D', d, 4) - (1 if d == 2 else 0)), spb('g2') * .9, .25, dec=.2, sus=.3), bt('g2', 4) + k * .02, .06)
    # s2（D）：✗ 低铜管 bwomp，玻璃碎，号角到 E
    BRASS_EV.extend([(bt('s2', 0), 'trombone_stac', deg('D', 0, 2), .3, .8, 0), (bt('s2', 0), 'tuba_stac', deg('D', 0, 1) + 1, .3, .8, 0), (bt('s2', 0), 'trombone_stac', deg('D', 0, 2) + 1, .3, .7, .2)])
    LOG.append((bt('s2', 0), 'stab'))
    add(DR, kick_syn(1), bt('s2', 0), .55); groove('s2', start=1); bass('s2', [0, 4], start=1)
    horn_call('s2', 1, 'E')
    # g3 网印（E）：硬槌颤音琴和弦（每刷一下一个和弦），闪光高音
    groove('g3'); bass('g3', [0, 0, 3, 3, 4, 4])
    vch = [(1, [0, 2, 4, 6]), (2, [3, 5, 7, 9]), (3, [0, 2, 4, 6]), (4, [4, 6, 8, 10])]
    for i, ch in vch:
        for k, d in enumerate(ch): add(CO, S.note('vibraphone_hard', deg('E', d, 4), .35, .6), bt('g3', i) + k * .006, .75, -.15 + k * .1)
    for k, d in enumerate([7, 9, 11, 14]):
        add(CO, S.note('glockenspiel', deg('E', d, 5), .4, .6), bt('g3', 5 + k * .125), .5, .2)
        add(CO, S.note('vibraphone_hard', deg('E', d, 4), .5, .5), bt('g3', 5 + k * .125), .35, -.2)
    # s3（E）：✓，SPEED UP——铜管 16 分音符上行 + 小军鼓滚奏，落到 F
    BRASS_EV.extend(stab(bt('s3', 0), 'E', (0, 2, 4), .7)); LOG.append((bt('s3', 0), 'stab'))
    groove('s3', stop=1); bass('s3', [0], stop=1)
    BRASS_EV.extend(stab(bt('s3', 1), 'E', (0, 2, 4), .9, big=True)); LOG.append((bt('s3', 1), 'stab'))
    run = list(range(deg('E', 0, 4), deg('F', 0, 5)))      # E4 → E5 半音阶上行
    for k, m in enumerate(run[:11]):          # 16 分音符：第 1.25 拍到第 3.75 拍，每个都在网格上
        tk = bt('s3', 1.25 + k * .25)
        BRASS_EV.append((tk, 'trumpet_stac', m + (k // 4), .12, .75 + k * .02, .1 if k % 2 else -.1))
        BRASS_EV.append((tk, 'trombone_stac', m - 12 + (k // 4), .12, .65 + k * .02, -.1))
    for k in range(20): hit(DR, 'snare2', 'on', bt('s3', 1.5 + k * .125), .3 + k / 20 * .7, .8)      # 32 分滚奏，落在网格上
    groove('s3', feel='16', start=1); bass('s3', [0, 1, 2], start=1, sub=4)
    add(FX, swell(3 * spb('s3')), bt('s3', 1), .25)
    # g4 水墨（F，144）：古琴 + 16 分闭镲；第 2 拍拍开关：低古琴 + 锣 + 定音鼓；第 3 拍只剩低音
    groove('g4', feel='16', stop=2); bass('g4', [0, 3], stop=2)
    for i, d in [(.5, 4), (1, 5), (1.5, 7), (1.75, 9)]:
        add(CO, P.pluck('guqin', deg('F', d, 4), .6, vel=.7), bt('g4', i), .9, .25)
    t = bt('g4', 2); LOG.append((t, 'slap'))
    add(CO, P.pluck('guqin', deg('F', 0, 2), 2.0, vel=.95, bend=[(0.0, 0), (0.25, 0), (0.6, -1)]), t, 1.0, 0)
    add(CO, P.pluck('guqin', deg('F', 4, 4), 1.5, vel=.6, harmonic=True), t, .7, .3)
    hit(DR, 'gong2', 'small', t, .7, .5); hit(DR, 'timpani', 'drum1', t, .9, .6); add(DR, kick_syn(1), t, .6)
    add(DR, kick_syn(.7), bt('g4', 3), .4); bass('g4', [0], start=3, sub=1)
    # s4（F）：✓ 后一拍断电——全部停；只剩两声心跳
    BRASS_EV.extend(stab(bt('s4', 0), 'F', (0, 2, 4), .7)); LOG.append((bt('s4', 0), 'stab'))
    add(DR, kick_syn(.9), bt('s4', 0), .55); hit(DR, 'drum_kit', 'hi_hat_closed', bt('s4', .5), .4, .25)
    # boss（G，160）：最大的一声 + 四踩律动 + 四种色彩乐器同场
    tb0 = bt('boss', 0)
    add(DR, subdrop(1.2), tb0, .9); add(DR, kick_syn(1), tb0, .8); hit(DR, 'timpani', 'drum1', tb0, 1, .8); hit(DR, 'gong2', 'big', tb0, .8, .35)
    hit(DR, 'clash', 'crash', tb0, 1, .6); LOG.append((tb0, 'slam'))
    add(DR, subdrop(.9), tb0, .55); hit(DR, 'timpani', 'drum2', tb0, 1, .7); hit(DR, 'drum_kit', 'crash_left', tb0, 1, .6)
    BRASS_EV.extend([(tb0, 'horn', deg('G', d, 3), spb('boss') * .9, .95, p) for d, p in [(0, -.3), (2, 0), (4, .3)]])
    BRASS_EV.extend([(tb0, 'trombone', deg('G', 0, 2), spb('boss') * .9, .95, 0), (tb0, 'trumpet', deg('G', 4, 4), spb('boss') * .9, .9, .2)])
    groove('boss', feel='four', start=1); bass('boss', [0, 0, 5, 3, 4, 4], start=1)
    for i in range(1, 3):        # 像素琶音
        for k in range(4): add(CO, chip(hz(deg('G', [0, 2, 4, 7][k], 5)), spb('boss') / 4 * .7, .125, dec=.05, sus=.3), bt('boss', i + k / 4), .07, .3 * (1 if k % 2 else -1))
    for i, d in [(1, 4), (1.5, 2), (2, 0), (2.5, 4)]: add(CO, P.pluck('music_box', deg('G', d, 5), .35, vel=.7), bt('boss', i), .8, -.3)   # 八音盒
    LOG.append((bt('boss', 3), 'catch'))
    for k, d in enumerate([0, 2, 4, 7]): add(CO, S.note('vibraphone_hard', deg('G', d, 4), .4, .6), bt('boss', 3) + k * .006, .5, .1)   # 颤音琴
    add(CO, S.note('glockenspiel', deg('G', 7, 5), .4, .7), bt('boss', 3), .4, -.2)
    t = bt('boss', 4); LOG.append((t, 'slap'))
    add(CO, P.pluck('guqin', deg('G', 0, 2), 2.0, vel=.95, bend=[(0.0, 0), (0.3, 0), (0.7, 2)]), t, 1.0, 0)          # 古琴
    add(CO, P.pluck('guqin', deg('G', 4, 4), 1.5, vel=.7, harmonic=True), t, .7, .25)
    hit(DR, 'timpani', 'drum2', t, .9, .6); hit(DR, 'gong2', 'small', t, .7, .5)
    # 主奏旋律（方波）贯穿 BOSS
    lead = [(1, 4, .5), (1.5, 4, .5), (2, 5, .5), (2.5, 7, .5), (3, 9, 1), (4, 7, .5), (4.5, 8, .5), (5, 7, 1)]
    for i, d, L in lead: add(LD, chip(hz(deg('G', d, 5)), spb('boss') * L * .9, .5, vib=.005), bt('boss', i), .14, .1)
    # end（G）：铜管终止大和弦 + 镲；然后八音盒摇篮和弦
    te = bt('end', 0)
    BRASS_EV.extend(stab(te, 'G', (0, 2, 4), .95, big=True)); LOG.append((te, 'stab'))
    BRASS_EV.extend([(te + spb('end') * .5, 'trumpet', deg('G', 0, 5), .9, .8, .1), (te + spb('end') * .5, 'horn', deg('G', 4, 4), 1.0, .7, -.1), (te + spb('end') * .5, 'trombone', deg('G', 2, 3), 1.0, .7, 0)])
    hit(DR, 'clash', 'crash', te, .9, .55); add(DR, kick_syn(1), te, .7); add(DR, subdrop(.6), te, .4)
    for k, d in enumerate([0, 4, 7, 9, 11]): add(CO, P.pluck('music_box', deg('G', d, 4), 1.4, vel=.55), bt('end', 2) + k * .06, .7, -.2 + k * .1)
    for k, d in enumerate([0, 2, 4]): add(CO, S.note('vibraphone', deg('G', d, 4), 1.2, .45), bt('end', 2) + .01 * k, .45, 0)
    add(CO, S.note('glockenspiel', deg('G', 0, 6), 1.0, .4), bt('end', 3), .35, .3)
    add(BR, S.render(BRASS_EV, master=False), 0, .62)
    return cmd_t

# ==================== 拟音 ====================
FX = buf(); AMB = buf(); FXS = buf()   # FXS：静默段里唯一允许出声的（断电、心跳、BOSS 前吸气）
def bell_ring(d, f0=1800):
    t = tt(d); x = sum(a * np.sin(2 * np.pi * f0 * r * t) for r, a in [(1, 1), (1.47, .6), (2.31, .4), (3.1, .25)])
    am = np.abs(np.sin(np.pi * 26 * t)) ** 3
    return x * am * np.minimum(1, (d - t) / .08 + .01) * .5
def static(d=.06): n = rng.standard_normal(int(d * SR)); return bpf(n, 1500, 7000) * np.exp(-np.arange(len(n)) / (d * SR / 3))
def glass():
    d = .6; t = tt(d); x = hpf(rng.standard_normal(len(t)), 2500) * np.exp(-t / .025) * 1.2
    for k in range(9): f = 3000 + rng.random() * 5000; x += np.sin(2 * np.pi * f * t + rng.random() * 6) * np.exp(-t / (.04 + rng.random() * .12)) * .3
    for dt in (.09, .17, .26, .33):   # 碎片弹跳
        s = int(dt * SR); L = int(.04 * SR); f = 4000 + rng.random() * 3000
        x[s:s + L] += np.sin(2 * np.pi * f * np.arange(L) / SR) * np.exp(-np.arange(L) / (.008 * SR)) * .35
    return x
def paper_tap(): n = rng.standard_normal(int(.03 * SR)); return bpf(n, 1200, 6000) * np.exp(-np.arange(len(n)) / 200)
def flip(): x = np.zeros(int(.09 * SR)); a = paper_tap(); x[:len(a)] += a; x[int(.035 * SR):int(.035 * SR) + len(a)] += a * .8; return x
def rustle(d=.4):
    n = bpf(rng.standard_normal(int(d * SR)), 2000, 7000); g = np.repeat(rng.random(int(d * 60) + 1), SR // 60)[:len(n)] ** 2
    return n * g * np.sin(np.pi * tt(d)[:len(n)] / d)
def slide(f0, f1, d, wob=0.0):
    t = tt(d); f = f0 * (f1 / f0) ** (t / d) * (1 + wob * np.sin(2 * np.pi * 7 * t))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, t / .02) * np.minimum(1, (d - t) / .05)
def squeak(): t = tt(.07); return np.sin(2 * np.pi * (2200 + 300 * np.sin(2 * np.pi * 60 * t)) * t) * np.exp(-t / .02)
def bit_sweep(f0, f1, d, duty=.5): return crush(chip(f0, d, duty, dec=.05, sus=.6, rel=.02, glide=f1), 5, 4)
def bit_noise(d, bits=4, hold=8, lo=500, hi=6000): return crush(bpf(rng.standard_normal(int(d * SR)), lo, hi), bits, hold)
def shk(d=.13):
    n = bpf(rng.standard_normal(int(d * SR)), 2500, 9000); t = np.arange(len(n)) / SR
    return n * (t / d) ** .6 * np.exp(-((t - d * .7) / (d * .35)) ** 2)
def ratchet(d=.55):
    x = np.zeros(int(d * SR)); tk = 0.0; gap = .06
    while tk < d - .01: c = X.click(1.3 + tk, .7); s = int(tk * SR); x[s:s + len(c)] += c[:len(x) - s]; tk += gap; gap = max(.016, gap * .85)
    return x
def hum_off(): t = tt(.5); return (np.sin(2 * np.pi * 60 * t) + .4 * np.sin(2 * np.pi * 120 * t)) * np.exp(-t / .12) * .4
def swell(d): t = tt(d); return bpf(rng.standard_normal(len(t)), 800, 8000) * (t / d) ** 3
def boing(f=300, d=.35): t = tt(d); return np.sin(2 * np.pi * np.cumsum(f * (1 + .25 * np.sin(2 * np.pi * 14 * t) * np.exp(-t / .1))) / SR) * np.exp(-t / .1)

def foley():
    for e in EVJ['ev']:
        t, ty = e['t'], e['type']
        if ty == 'ring': add(FX, bell_ring(max(e.get('dur', .4), .3) + .15), t, .55)
        elif ty == 'flash': add(FX, X.thump(1, 90), t, .35); add(FX, X.click(.7, 1), t, .25)
        elif ty == 'tick': w = S.hit('woodblock', 'a' if int(round(t * 10)) % 2 else 'b', .6); add(FX, w, t, .22, .5)
        elif ty == 'press': add(FX, X.click(.8, 1), t, .4, .3); add(FX, boing(260, .3), t + .01, .18, .3)
        elif ty == 'push': add(FX, X.whoosh(.26, 1), t, .3)
        elif ty == 'shrink': add(FX, X.whoosh(.34, 1)[::-1].copy(), t, .25)
        elif ty == 'flick': add(FX, static(), t, .18)
        elif ty == 'stamp':
            add(FX, X.thump(1, 80 if e.get('kind') == 'fail' else 110), t, .55); add(FX, paper_tap(), t, .5)
        elif ty == 'crack': add(FX, glass(), t, .55, -.4)
        elif ty == 'flip': add(FX, flip(), t, .35, .5)
        elif ty == 'leaves': add(FX, rustle(.45), t, .35, -.3)
        elif ty == 'appleFall': add(FX, slide(1500, 520, e.get('dur', .9) * .95, .01), t, .09, -.1)
        elif ty == 'step': add(FX, lpf(rng.standard_normal(int(.03 * SR)), 900) * np.exp(-np.arange(int(.03 * SR)) / 250), t, .35, .2); add(FX, squeak(), t, .05, .2)
        elif ty == 'catch': add(FX, X.thump(1, 150), t, .45); add(FX, X.clack(.8, 1), t, .35); add(FX, rustle(.15), t, .2)
        elif ty == 'cheer': add(FX, X.pop(1), t, .3); add(FX, boing(420, .3), t, .12)
        elif ty == 'cloudIn': add(FX, bit_sweep(200, 90, .25), t, .14, -.5)
        elif ty == 'rain':
            d = e['dur']; n = bit_noise(d, 4 if e.get('heavy') else 5, 8 if e.get('heavy') else 5, 800, 7000)
            env = np.minimum(1, tt(d)[:len(n)] / .05) * np.minimum(1, (d - tt(d)[:len(n)]) / .1)
            add(AMB, n * env, t, .11 if e.get('heavy') else .05)
        elif ty == 'dash': add(FX, bit_sweep(250, 1100, .14), t, .14, .3)
        elif ty == 'zip': add(FX, bit_sweep(400, 1800, .12), t, .14, .3); add(FX, X.whoosh(.2, 1), t, .2, .3)
        elif ty == 'pour': add(FX, bit_noise(.6, 3, 10, 300, 5000) * np.exp(-tt(.6)[:int(.6 * SR)] / .25), t, .5); add(FX, X.thump(1, 60), t, .45)
        elif ty == 'wah': pass   # 在配乐里（方波下滑）
        elif ty == 'drip': add(FX, bit_sweep(1300, 800, .06), t, .1)
        elif ty == 'brush': add(FX, shk(), t, .55, .35 * e.get('dir', 1))
        elif ty == 'foam':
            for k in range(3): add(FX, X.pop(1), t + k * .04, .06, rng.random() - .5)
        elif ty == 'shine': add(FX, X.ding(1), t, .25)
        elif ty == 'speed': add(FX, ratchet(), t, .3); add(FX, X.whoosh(.3, 1), t, .3)
        elif ty == 'bannerOut': add(FX, X.whoosh(.25, 1), t, .25, .5)
        elif ty == 'crouch': add(FX, rustle(.2), t, .2)
        elif ty == 'jump': add(FX, X.whoosh(.2, 1), t, .3)
        elif ty == 'switch': add(FX, X.click(.55, 1), t, .7); add(FX, X.clack(.6, 1), t, .4)
        elif ty == 'flood': add(FX, X.rumble(1.2, 1), t, .35); add(FX, lpf(X.whoosh(.6, 1), 900), t, .4)
        elif ty == 'cut': add(FXS, X.click(.45, 1), t, .8); add(FXS, X.click(.35, 1), t + .05, .6); add(FXS, X.thump(1, 55), t + .05, .45); add(FXS, hum_off(), t, .05)
        elif ty == 'hb': add(FXS, lpf(X.heartbeat(1), 220), t, .3)
        elif ty == 'slideIn': add(FXS, swell(.25), t, .16)
        elif ty == 'slam': add(FX, X.thump(1, 70), t, .7); add(FX, paper_tap(), t, .6)
        elif ty == 'land': add(FX, X.thump(1, 120), t, .45)
        elif ty == 'bonk': add(FX, bit_sweep(220, 110, .14, .5), t, .2, -.5); add(FX, S.hit('woodblock', 'c', .8), t, .3, -.5)
        elif ty == 'snap': add(FX, X.whoosh(.2, 1)[::-1].copy(), t - .12, .3)
        elif ty == 'confetti':
            for k in range(9): add(FX, X.pop(1), t + k * .035, .1, rng.random() * 1.6 - .8)
        elif ty == 'claps':
            for k in range(14): add(FX, S.hit('claps', 'solo', .5 + rng.random() * .4), t + .05 + k * .085 + rng.random() * .03, .22, rng.random() * 1.4 - .7)
        elif ty == 'yawn': add(FX, lpf(chip(330, .55, .5, a=.08, dec=.2, sus=.8, rel=.15, glide=170), 1200), t, .12)
        elif ty == 'zzz':   # 轻轻的鼾声"呼——"
            d = .9; tq = tt(d); n = lpf(rng.standard_normal(len(tq)), 500) * (np.abs(np.sin(np.pi * 24 * tq)) ** 2) * np.sin(np.pi * tq / d) ** 2
            add(FX, n, t, .22, .4)
    # 环境床：舞台空气（静默段只剩极低底噪）、蜡笔纸面、水墨夜虫
    air = lpf(rng.standard_normal(N), 700) * .004
    AMB[:, 0] += air; AMB[:, 1] += np.roll(air, 300)
    g1a, g1b = int(bt('g1', 0) * SR), int(SEG['g1']['t1'] * SR); pa = bpf(rng.standard_normal(g1b - g1a), 3000, 9000) * .006
    AMB[g1a:g1b] += pa[:, None]
    a, b = int(bt('g4', 2) * SR), int(SEG['g4']['t1'] * SR) + int(.3 * SR); t = np.arange(b - a) / SR
    cr = np.sin(2 * np.pi * 4300 * t) * (np.sin(2 * np.pi * 28 * t) > .3) * (np.sin(2 * np.pi * 1.6 * t) > 0) * .006
    AMB[a:b, 0] += cr; AMB[a:b, 1] += np.roll(cr, 900)

def main():
    music(); foley()
    # 断电：s4 第 1 拍起所有音乐瞬间归零（30 ms），到 BOSS 前 6 帧才回来（只有拟音心跳）
    cut0, cut1 = int(bt('s4', 1) * SR), int(SEG['boss']['t0'] * SR)
    gate = np.ones(N, np.float32); r = int(.03 * SR); gate[cut0:cut0 + r] = np.linspace(1, 0, r); gate[cut0 + r:cut1] = 0
    for B in (DR, BS, BR, CO, LD, FX): B *= gate[:, None]
    amb_g = np.ones(N, np.float32); amb_g[cut0:cut1] = .08; AMB[:] *= amb_g[:, None]
    # 混音（混响之后再切一次，静默段里不留混响尾巴）
    music_bus = DR * .95 + BS * .62 + BR * 1.0 + CO * 1.35 + LD * 1.4
    music_bus = S.room(music_bus, size=.25, mix=.1) * gate[:, None]
    fx_bus = S.room(FX * 1.0, size=.15, mix=.06) * gate[:, None] + S.room(AMB * 1.0 + FXS, size=.15, mix=.06)
    mix = music_bus * .8 + fx_bus * .9
    # 响度层级：s0（开场铃）−3.5 dB，end 段（终止和弦 + 响铃 + 摇篮和弦）−4 dB
    shp = np.ones(N, np.float32); xf = int(.06 * SR)
    a = int(SEG['g1']['t0'] * SR); shp[:a] = 10 ** (-3.5 / 20); shp[a:a + xf] = np.linspace(10 ** (-3.5 / 20), 1, xf)
    e0 = int(SEG['end']['t0'] * SR); shp[e0:] = 10 ** (-4 / 20)
    # BOSS 砸入：静默后第一声 +4 dB（保持 0.4 s，0.2 s 回到 0 dB）——全片最响的一声
    b0 = int(SEG['boss']['t0'] * SR); gb = 10 ** (4 / 20); h = int(.4 * SR); rr = int(.2 * SR)
    shp[b0:b0 + h] = gb; shp[b0 + h:b0 + h + rr] = np.linspace(gb, 1, rr)
    # SPEED UP! 大和弦（s3 第 1 拍）与水墨关第 0 拍（144 BPM 第一下）各让 2.5 dB，避免和 BOSS 抢最响
    def duck(t0, d, db):
        g0 = int(t0 * SR); gg = 10 ** (db / 20); L = int(d * SR)
        shp[g0 - xf:g0] *= np.linspace(1, gg, xf); shp[g0:g0 + L] *= gg; shp[g0 + L:g0 + L + xf] *= np.linspace(gg, 1, xf)
    duck(bt('s3', 1), .5, -2.5); duck(SEG['g4']['t0'], .35, -2.5)
    mix = mix * shp[:, None]
    # 低频平衡：20–120 Hz 收一点
    lo = np.stack([lpf(mix[:, c], 120) for c in range(2)], 1); mix = mix - lo * .3
    # 响度预置：按 400 ms 门限块的 RMS 估到约 −15，再用前瞻限幅压住峰值（mux 的 loudnorm 只需微调，不会削顶）
    blk = int(.4 * SR); ms = np.array([np.mean(mix[i:i + blk] ** 2) for i in range(0, N - blk, blk // 4)])
    ms = ms[ms > 1e-7]; ms = ms[10 * np.log10(ms) > 10 * np.log10(ms.mean()) - 10]
    g = 10 ** ((-15.5 - 10 * np.log10(ms.mean())) / 20); mix = mix * g
    for _ in range(2):
        for c in range(2): mix[:, c] = X.limit(mix[:, c], .68, look=.004)
    mix = np.clip(mix, -.7, .7)
    print('pre-gain %+.1f dB, peak %.2f' % (20 * np.log10(g), np.abs(mix).max()))
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
    stems = {'drums': DR, 'bass': BS, 'brass': BR, 'colour': CO, 'lead': LD, 'fx': FX, 'amb': AMB}
    for k, v in stems.items(): sf.write(os.path.join(HERE, 'out', f'stem_{k}.wav'), (v / (np.abs(v).max() + 1e-9) * .9).astype(np.float32), SR, subtype='FLOAT')
    json.dump({'music_hits': LOG, 'sr': SR, 'n': N}, open(os.path.join(HERE, 'out', 'score.json'), 'w'), indent=1)
    print('mix →', os.path.join(HERE, 'out', 'mix.wav'), f'{N / SR:.3f}s', 'peak-normalised')

if __name__ == '__main__':
    main()
