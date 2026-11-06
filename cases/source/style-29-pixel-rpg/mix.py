"""mix.py — 《宝箱怪》原创芯片配乐 + 拟音 → out/mix.wav（48 kHz 立体声）+ out/score.json（音乐事件实际落点，cuecheck 用）

全部时间都来自 timeline.json（由 timeline.js 导出）与 events.json（由 index.html 的 window.EV 导出）。
帧 f 的采样点 = f × 2000（48000 / 24），所以每个音都精确落在帧上。

乐器（只取 STYLE.md 声音调色板）：
  方波 12.5 / 25 / 50 % 占空比（polyBLEP）、4-bit 32 级三角波贝斯、15 位 LFSR 噪声鼓、32 步 wavetable 和声、SNES 式回声（3 抽头 + 环内低通）；
  16-bit 主机本来就是采样音源：小号 / 圆号 / 定音鼓 / 钟琴用 sampler.py 的真实采样（VSCO 2 CE、VCSL，CC0），再过低通 + 量化，像卡带里的 BRR 采样；
  友情主题的八音盒用 pluck.py 的 music_box 物理模型。
唯一的有机声：11.25 s 的心跳（不做 bit-crush）。
两段真零静默（含回声尾巴）：timeline.SILENCE。
"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P   # noqa: E402
from core.audio import sfx as X                   # noqa: E402

S.seed(29)
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
SR = 48000; FPS = TL['FPS']; SPF = SR // FPS                # 2000 采样 / 帧
NF = TL['NFRAMES']; N = NF * SPF
A, B, CUE = TL['A'], TL['B'], TL['CUE']
fA = lambda n: A['f0'] + n * A['fpb']
fB = lambda bar, beat=0: B['f0'] + bar * B['meter'] * B['fpb'] + beat * B['fpb']
bA = A['fpb'] / FPS            # 0.625 s
bB = B['fpb'] / FPS            # 0.41667 s
e8 = bB / 2; s16 = bB / 4
rng = np.random.default_rng(29)

# ───────────────────────── 基础 ─────────────────────────
NAMES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def midi(n):
    if isinstance(n, (int, float)): return n
    k = NAMES[n[0]]; i = 1
    while i < len(n) and n[i] in '#b': k += 1 if n[i] == '#' else -1; i += 1
    return k + 12 * (int(n[i:]) + 1)
def hz(n): return 440.0 * 2 ** ((midi(n) - 69) / 12)
def ns(d): return max(1, int(round(d * SR)))
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x, axis=0)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x, axis=0)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, b], 'band', fs=SR, output='sos'), x, axis=0)

def phase(f0, n, vib=0.0, vrate=5.5, vdel=.2, glide=None):
    t = np.arange(n) / SR
    f = np.full(n, float(f0))
    if glide is not None: f = f0 * (glide / f0) ** np.clip(t / (n / SR), 0, 1)
    if vib: f = f * (1 + vib * np.sin(2 * np.pi * vrate * t) * np.clip((t - vdel) / .2, 0, 1))
    dt = f / SR
    return np.cumsum(dt) % 1.0, dt
def _blep(t, dt):
    y = np.zeros_like(t)
    m = t < dt; x = t[m] / dt[m]; y[m] = x + x - x * x - 1
    m = t > 1 - dt; x = (t[m] - 1) / dt[m]; y[m] = x * x + x + x + 1
    return y
def pulse(f, d, duty=.5, **kw):
    ph, dt = phase(hz(f) if isinstance(f, str) else f, ns(d), **kw)
    y = np.where(ph < duty, 1.0, -1.0) + _blep(ph, dt) - _blep((ph - duty) % 1.0, dt)
    return y - (2 * duty - 1)
TRI32 = np.concatenate([np.arange(15, -1, -1), np.arange(0, 16)]) / 7.5 - 1      # 4-bit 三角波
def tri(f, d, **kw):
    ph, _ = phase(hz(f) if isinstance(f, str) else f, ns(d), **kw); return TRI32[(ph * 32).astype(int) % 32]
WAVE = np.array([8, 12, 14, 15, 15, 13, 11, 9, 8, 9, 11, 12, 11, 8, 5, 4, 4, 5, 7, 8, 7, 4, 2, 0, 0, 1, 3, 5, 6, 6, 7, 8]) / 7.5 - 1
def wave(f, d, **kw):
    ph, _ = phase(hz(f) if isinstance(f, str) else f, ns(d), **kw); return WAVE[(ph * 32).astype(int) % 32]
def _lfsr(short):
    reg, out = 1, np.empty(93 if short else 32767)
    for i in range(len(out)):
        b = (reg ^ (reg >> (6 if short else 1))) & 1; reg = (reg >> 1) | (b << 14); out[i] = reg & 1
    return out * 2 - 1
LF_L, LF_S = _lfsr(False), _lfsr(True)
def lfsr(d, rate=12000, short=False, off=0):
    tab = LF_S if short else LF_L
    return tab[((np.arange(ns(d)) * rate / SR).astype(int) + off) % len(tab)]

def env(d, a=.004, dk=.08, s=.6, r=.04, steps=0):
    n = ns(d); t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(dk, 1e-6)))
    e = e * np.clip((d - t) / max(r, 1e-6), 0, 1)
    if steps: e = np.round(e * steps) / steps                                   # 硬件音量阶
    return e
def expd(d, tau): return np.exp(-np.arange(ns(d)) / SR / tau)
def crush(x, bits=8, hold=1):
    if hold > 1: x = np.repeat(x[::hold], hold)[:len(x)]
    q = 2 ** (bits - 1); return np.round(np.clip(x, -1, 1) * q) / q
def snesify(x, cut=7000, bits=11):
    """把真实采样做成卡带里的样子：32 kHz 主机的低通 + 采样位深量化"""
    x = lp(np.asarray(x, np.float64), cut, 4); return crush(x / (np.abs(x).max() + 1e-9), bits) * np.abs(x).max()
def nrm(x, p=1.0):
    m = np.abs(x).max(); return x * (p / m) if m > 0 else x
def rmsn(x, r=.25):
    v = np.sqrt(np.mean(np.asarray(x, np.float64) ** 2) + 1e-12); return x * (r / v)

# 立体声总线 (N,2)；at 用帧号或秒，都换成整采样（四舍五入）
def bus(): return np.zeros((N, 2))
def put(Bf, x, at_s, g=1.0, pan=0.0):
    s = int(round(at_s * SR)); x = np.asarray(x, np.float64)
    if s >= N: return
    if s < 0: x = x[-s:]; s = 0
    e = min(N, s + len(x)); l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
    Bf[s:e, 0] += x[:e - s] * g * l; Bf[s:e, 1] += x[:e - s] * g * r
def F(f): return f / FPS            # 帧 → 秒（精确：f×2000 采样）

def echo(Bf, taps=(.18, .27, .37), gains=(.5, .38, .3), fb=.42, lpf=3000, wet=.42):
    """SNES 式回声：3 抽头 + 反馈环内低通"""
    x = Bf.mean(1); L = len(x); D = int(round(taps[2] * SR))
    sos = butter(2, lpf, 'low', fs=SR, output='sos'); zi = np.zeros((sos.shape[0], 2))
    w = np.zeros(L); lw = np.zeros(L)
    for s in range(0, L, D):
        e = min(L, s + D)
        w[s:e] = x[s:e] + (fb * lw[s - D:e - D] if s >= D else 0)
        lw[s:e], zi = sosfilt(sos, w[s:e], zi=zi)
    def dl(sig, tt):
        k = int(round(tt * SR)); o = np.zeros(L); o[k:] = sig[:L - k]; return o
    wl = gains[0] * dl(lw, taps[0]) + gains[2] * dl(lw, taps[2])
    wr = gains[1] * dl(lw, taps[1]) - gains[2] * .8 * dl(lw, taps[2])
    return Bf + wet * np.stack([wl, wr], 1)

# 静默分段：每段“活着”的采样区间 [a, b)。静默窗口前 1 帧就收尾（给 AAC 的 1024 采样帧留余量，成片里窗口才是真零）
FADE = 64
LIVE, _a = [], 0
for _f0, _f1 in TL['SILENCE']:
    LIVE.append((_a, _f0 * SPF - SPF)); _a = _f1 * SPF
LIVE.append((_a, None))
def seg_echo(Bf, **kw):
    """回声逐段做：回声与反馈环都不跨静默（静默后不会再冒出静默前的尾巴）"""
    out = np.zeros_like(Bf)
    for a, b in LIVE:
        b = len(Bf) if b is None else b
        x = np.zeros_like(Bf); x[a:b] = Bf[a:b]
        y = echo(x, **kw); out[a:b] += y[a:b]
    return out

KEYEV = []   # 音乐事件实际落点（秒），cuecheck 读
def mark(name, f): KEYEV.append({'name': name, 'f': f, 't': F(f)})

# ───────────────────────── 采样乐器（真实录音） ─────────────────────────
_sc = {}
def smp(inst, p, d, vel=.8, rel=None, cut=7000):
    k = (inst, p, round(d, 4), vel, rel)
    if k not in _sc: _sc[k] = snesify(S.note(inst, p, d, vel=vel, release=rel), cut)
    return _sc[k]
def timp(p, vel=.9): return snesify(S.note('timpani', p, 1.6, vel=vel), 6000)

# ───────────────────────── 芯片鼓 ─────────────────────────
def kick(v=1.):
    d = .16; ph, _ = phase(1, ns(d)); t = np.arange(ns(d)) / SR
    f = 50 + 110 * np.exp(-t / .025); y = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return crush(y * expd(d, .05), 6) * v
def snare(v=1., d=.14):
    return (lfsr(d, 14000) * .8 + tri(190, d) * .35) * env(d, .001, .045, 0, .02, steps=15) * v
def hat(v=1., d=.04):
    return lfsr(d, 30000, short=True) * env(d, .001, .012, 0, .01, steps=15) * v
def cymb(v=1., d=.9):
    return hp(lfsr(d, 26000), 3000) * expd(d, .28) * v

# ═════════════════════════ 配乐 ═════════════════════════
MUS = bus()

# —— A 段：地牢华尔兹 96 BPM 3/4，D 小调；第 4 拍停在属和弦（A7） ——
def secA():
    # 三角波贝斯（每小节第 1 拍）+ 12.5% 方波琶音（第 2、3 拍的八分）
    for bar, (root, arp) in enumerate([('D2', ['F4', 'A4', 'D5', 'A4']), ('G2', ['Bb4', 'D5', 'G5', 'D5'])]):
        f0 = fA(bar * 3)
        if bar == 0:
            put(MUS, tri(root, bA * .9) * env(bA * .9, .003, .3, .5, .08), F(f0), .34)
            for i, p in enumerate(arp):
                t = F(f0) + bA + i * bA / 2
                put(MUS, pulse(p, bA * .42, .125) * env(bA * .42, .002, .07, .25, .03, 15), t, .07, -.3 + .2 * (i % 2))
        else:   # 第 2 小节只有第 1 拍（G），第 2 拍起停在 A7
            put(MUS, tri(root, bA * .9) * env(bA * .9, .003, .3, .5, .08), F(f0), .34)
            for i, p in enumerate(arp[:2]):
                put(MUS, pulse(p, bA * .42, .125) * env(bA * .42, .002, .07, .25, .03, 15), F(f0) + i * bA / 2 + bA / 2 * 0, .07, -.2)
    # 25% 方波旋律：A4 D5 F5-E5 | D5 | E5（属音，延长 + 颤音）
    mel = [(fA(0), 'A4', bA * .95), (fA(1), 'D5', bA * .95), (fA(2), 'F5', bA * .48), (fA(2) + 7.5, 'E5', bA * .48), (fA(3), 'D5', bA * .95)]
    for f0, p, d in mel:
        put(MUS, pulse(p, d, .25, vib=.004) * env(d, .004, .15, .55, .05, 15), F(f0), .12, .1)
    # 第 4 拍（停步）：A7 —— 贝斯 A2、12.5% 和弦 C#4 E4 G4、旋律 E5 长音颤音
    stop = fA(4); mark('A_dominant', stop)
    put(MUS, tri('A2', bA * 1.9) * env(bA * 1.9, .003, .4, .55, .1), F(stop), .34)
    for i, p in enumerate(['C#4', 'E4', 'G4']):
        put(MUS, pulse(p, bA * .9, .125) * env(bA * .9, .003, .2, .4, .12, 15), F(stop), .045, -.4 + .4 * i)
    put(MUS, pulse('E5', bA * 1.0, .25, vib=.012, vrate=6, vdel=.15) * env(bA, .004, .25, .6, .15, 15), F(stop), .12, .1)
    # 第 5 拍（快推）：低音三角波 16 分颤（A1/A2）+ 方波小二度颤抖 —— 预备
    push = fA(5); mark('A_push', push)
    for i in range(6):
        put(MUS, tri('A1' if i % 2 == 0 else 'Bb1', bA / 6) * env(bA / 6, .002, .05, .7, .01), F(push) + i * bA / 6, .3 + .03 * i)
    for i in range(10):
        put(MUS, pulse('Bb4' if i % 2 else 'A4', bA / 10, .125) * env(bA / 10, .001, .02, .6, .005, 15), F(push) + i * bA / 10, .025 + .004 * i, .3)

# —— B 段：144 BPM 4/4 ——
def stinger():
    f0 = fB(0, 0); mark('chomp_stinger', f0)
    put(MUS, timp('A2', 1.), F(f0), 1.0, -.1)
    put(MUS, timp('D3', .9), F(f0), .6, .1)
    put(MUS, smp('horn_stac', 'D4', .4, .95), F(f0), 1.6, -.3)
    put(MUS, smp('horn_stac', 'G#4', .4, .95), F(f0), 1.4, .3)        # 三全音刺音
    put(MUS, smp('trumpet_stac', 'D5', .3, .9), F(f0), 2.6, 0)
    for p in ['D5', 'G#5']: put(MUS, pulse(p, .3, .5) * env(.3, .001, .08, .3, .05, 15), F(f0), .08)
    put(MUS, kick(1.), F(f0), .55); put(MUS, cymb(.8), F(f0), .22)
    # 漩涡三拍：16 分方波半音上行 + LFSR 军鼓 16 分渐强
    k = 0
    for beat in (1, 2, 3):
        for q in range(4):
            t = F(fB(0, beat)) + q * s16
            put(MUS, pulse(midi('D4') + k * 2, s16 * .9, .25) * env(s16 * .9, .001, .03, .5, .01, 15), t, .06 + .004 * k, .4 * np.sin(k))
            put(MUS, snare(.25 + .05 * k, .09), t, .25, -.15)
            k += 1
    mark('swirl_fill', fB(0, 1))

BAT_CH = [('Dm', 'D2'), ('Dm', 'D2'), ('Bb', 'Bb1'), ('Bb', 'Bb1'), ('C', 'C2'), ('C', 'C2'), ('A', 'A1'), ('A', 'A1')]   # 每拍
CHORD = {'Dm': ['D4', 'F4', 'A4'], 'Bb': ['D4', 'F4', 'Bb4'], 'C': ['E4', 'G4', 'C5'], 'A': ['E4', 'A4', 'C#5'], 'F': ['F4', 'A4', 'C5'], 'Gm': ['D4', 'G4', 'Bb4']}
def battle():
    mark('battle_downbeat', fB(1, 0))
    put(MUS, cymb(.9), F(fB(1, 0)), .25)
    # 两小节（bar1–2）全编制
    for i, (ch, root) in enumerate(BAT_CH):
        bar, beat = 1 + i // 4, i % 4
        t = F(fB(bar, beat))
        # 三角波八分八度贝斯
        for h, oc in enumerate([0, 12]):
            p = midi(root) + 12 + oc
            put(MUS, tri(p, e8 * .85) * env(e8 * .85, .002, .06, .7, .02), t + h * e8, .36)
        # 鼓：1、3 拍底鼓，2、4 拍军鼓，八分踩镲
        put(MUS, kick(.9) if beat in (0, 2) else snare(.8), t, .5 if beat in (0, 2) else .32, 0 if beat in (0, 2) else -.1)
        for h in range(2): put(MUS, hat(.6 if h else .35), t + h * e8, .16, .35)
        # wavetable 和声：反拍短和弦
        for j, p in enumerate(CHORD[ch]):
            put(MUS, wave(p, e8 * .6) * env(e8 * .6, .002, .05, .5, .02, 15), t + e8, .05, -.5 + .5 * j)
    # 50% 方波主旋律（八分格）
    lead = [(1, 0, 'D5', 3), (1, 3, 'F5', 1), (1, 4, 'A5', 2), (1, 6, 'G5', 1), (1, 7, 'F5', 1),
            (2, 0, 'E5', 2), (2, 2, 'C5', 1), (2, 3, 'D5', 1), (2, 4, 'E5', 2), (2, 6, 'C#5', 2)]
    for bar, slot, p, ln in lead:
        d = ln * e8 * .92
        put(MUS, pulse(p, d, .5, vib=.006 if ln > 1 else 0, vdel=.12) * env(d, .003, .1, .6, .03, 15), F(fB(bar, 0)) + slot * e8, .1, .15)
        put(MUS, pulse(midi(p) - 12, d, .25) * env(d, .003, .1, .5, .03, 15), F(fB(bar, 0)) + slot * e8 + .012, .035, -.3)   # 低八度厚度
    mark('battle_phrase2', fB(2, 0))

def strip():
    """bar3：抽层 —— 鼓与旋律离开，只剩贝斯 + 颤音方波；每拍再走一层"""
    mark('strip', fB(3, 0))
    for beat in range(3):
        t = F(fB(3, beat)); g = [.3, .22, .14][beat]
        for h in range(2): put(MUS, tri('D3', e8 * .8) * env(e8 * .8, .002, .06, .7, .02), t + h * e8, g)
        if beat < 2:                 # 和声长音：第 1、2 拍
            for j, p in enumerate(CHORD['Dm']): put(MUS, wave(p, bB * .95) * env(bB * .95, .01, .2, .6, .05, 15), t, .03 * (1 - beat * .5), -.4 + .4 * j)
        n = 8                        # 发抖：32 分小二度颤音，渐弱
        for i in range(n):
            put(MUS, pulse('A4' if i % 2 == 0 else 'Bb4', bB / n * .9, .125) * env(bB / n * .9, .001, .02, .6, .005, 15), t + i * bB / n, .045 * (1 - beat * .3), .3)

def friendship():
    """bar5：F 大调友情主题 —— 八音盒（pluck 物理模型）+ 钟琴采样 + 三角波半速"""
    mark('friend_theme', fB(5, 0))
    mel = [(0, 'C6'), (.5, 'F6'), (1, 'A6'), (2, 'G6'), (3, 'F6'), (3.5, 'E6')]
    for b, p in mel:
        t = F(fB(5, 0)) + b * bB
        put(MUS, P.pluck('music_box', p, 1.2, .7), t, .9, .2)
        put(MUS, smp('glockenspiel', midi(p) + 12 if midi(p) + 12 <= 108 else p, .6, .45, cut=9000), t, .12, -.3)
    for b, p, ln in [(0, 'F2', 2), (2, 'Bb1', 1), (3, 'C2', 1)]:
        d = ln * bB * .95
        put(MUS, tri(midi(p) + 12, d) * env(d, .004, .4, .6, .08), F(fB(5, b)), .3)
    # 软 wavetable 和弦垫（F → Bb → C）
    for b, ch, ln in [(0, 'F', 2), (2, 'Gm', 1), (3, 'C', 1)]:
        d = ln * bB * .95
        for j, p in enumerate(CHORD[ch]): put(MUS, wave(p, d) * env(d, .03, .3, .5, .1, 15), F(fB(5, b)), .022, -.4 + .4 * j)
    # 接住钥匙：道具小号角（拍 2）
    f0 = fB(5, 2); mark('item_fanfare', f0)
    for i, p in enumerate(['C5', 'F5', 'A5', 'C6']):
        d = s16 * .9 if i < 3 else bB * 1.2
        put(MUS, smp('trumpet_stac' if i < 3 else 'trumpet', p, d, .8), F(f0) + i * s16 * .5, .9 if i < 3 else .55, .1)
        put(MUS, pulse(p, d, .25) * env(d, .002, .08, .5, .04, 15), F(f0) + i * s16 * .5, .06, -.1)

def crescendo():
    """bar6：EXP 渐强 —— 三角波半音爬到属音，12.5% 方波 16 分上行琶音，军鼓八分渐强；拍 3 切真零"""
    mark('exp_build', fB(6, 0))
    bass = ['F2', 'G2', 'A2', 'Bb2', 'B2', 'C3']
    arps = [['F4', 'A4', 'C5', 'F5'], ['G4', 'Bb4', 'D5', 'G5'], ['A4', 'C5', 'E5', 'A5']]
    for i, p in enumerate(bass):
        t = F(fB(6, 0)) + i * e8
        put(MUS, tri(midi(p) + 12, e8 * .85) * env(e8 * .85, .002, .06, .7, .02), t, .34)
        put(MUS, snare(.3 + .12 * i, .1), t, .18 + .04 * i, -.1)
        put(MUS, hat(.6), t + s16, .1 + .02 * i, .35)
    for b in range(3):
        for q in range(4):
            p = arps[b][q]; t = F(fB(6, b)) + q * s16
            put(MUS, pulse(midi(p) + 12, s16 * .85, .125) * env(s16 * .85, .001, .03, .5, .01, 15), t, .04 + .012 * (b * 4 + q), .3 - .2 * (q % 2))

FANF = [  # (bar, 八分位置, 音, 八分长度) —— LEVEL UP 号角，F 大调；第二句停在属（G5 / C 和弦），bar9 回主
    (7, 0, 'F5', 1), (7, 1, 'A5', 1), (7, 2, 'C6', 3), (7, 5, 'A5', 1), (7, 6, 'Bb5', 1), (7, 7, 'C6', 1),
    (8, 0, 'D6', 2), (8, 2, 'C6', 1), (8, 3, 'Bb5', 1), (8, 4, 'A5', 2), (8, 6, 'G5', 2),
    (9, 0, 'F5', 3)]
FAN_CH = {(7, 0): 'F', (7, 2): 'F', (7, 4): 'Bb', (7, 6): 'C', (8, 0): 'Bb', (8, 2): 'F', (8, 4): 'C', (8, 6): 'C', (9, 0): 'F'}
FAN_B = {(7, 0): 'F2', (7, 2): 'F2', (7, 4): 'Bb1', (7, 6): 'C2', (8, 0): 'Bb1', (8, 2): 'A1', (8, 4): 'C2', (8, 6): 'C2', (9, 0): 'F1'}
def fanfare():
    f0 = fB(7, 0); mark('levelup_fanfare', f0)
    # 静默后第一声：定音鼓 + 镲 + 底鼓 + 铜管和弦
    put(MUS, timp('F2', 1.), F(f0), 1.1, -.1); put(MUS, timp('C3', .8), F(f0), .5, .15)
    put(MUS, cymb(1., 1.4), F(f0), .3); put(MUS, kick(1.), F(f0), .6)
    for p, pan in [('F3', -.35), ('A3', .35), ('C4', -.1), ('F4', .2)]:
        put(MUS, smp('horn', p, bB * 3.6, .85, rel=.4), F(f0), .55, pan)
    # 旋律：小号（真实采样）+ 50% 方波双
    for bar, slot, p, ln in FANF:
        d = ln * e8 * .95 if bar < 9 else bB * 1.5
        t = F(fB(bar, 0)) + slot * e8
        tp = 'trumpet' if ln >= 2 else 'trumpet_stac'
        pp = p if midi(p) <= midi('C6') else midi(p) - 12           # 小号音域上限 C6
        put(MUS, smp(tp, pp, d, .85 if bar < 9 else .6, rel=.25), t, (1.3 if tp == 'trumpet' else 2.2) * (.75 if bar == 9 else 1), .1)
        put(MUS, pulse(p, d, .5, vib=.008 if ln > 1 else 0, vdel=.1) * env(d, .002, .12, .6, .04, 15), t, .085 * (.6 if bar == 9 else 1), -.15)
    # 和声：圆号长音换和弦 + wavetable 八分；三角波贝斯八分；鼓
    for (bar, slot), ch in FAN_CH.items():
        t = F(fB(bar, 0)) + slot * e8
        ln = 2 if bar < 9 else 4
        if bar < 9:
            for h in range(ln):
                for j, p in enumerate(CHORD[ch]): put(MUS, wave(p, e8 * .6) * env(e8 * .6, .002, .05, .5, .02, 15), t + h * e8, .04, -.5 + .5 * j)
        rt = FAN_B[(bar, slot)]
        for h in range(ln if bar < 9 else 1):
            dd = e8 * .85 if bar < 9 else bB * 1.4
            put(MUS, tri(midi(rt) + 12 + (12 if h % 2 else 0), dd) * env(dd, .002, .08 if bar < 9 else .4, .7 if bar < 9 else .3, .03 if bar < 9 else .25), t + h * e8, .36)
    for bar in (7, 8):
        for beat in range(4):
            t = F(fB(bar, beat))
            put(MUS, kick(.9) if beat in (0, 2) else snare(.8), t, .45 if beat in (0, 2) else .3)
            for h in range(2): put(MUS, hat(.6 if h else .35), t + h * e8, .14, .35)
    mark('fanfare_phrase2', fB(8, 0))
    for p, pan in [('Bb2', -.3), ('D3', .3), ('F3', 0)]: put(MUS, smp('horn', p, bB * 1.9, .7, rel=.3), F(fB(8, 0)), .45, pan)
    for p, pan in [('C3', -.3), ('E3', .3), ('G3', 0)]: put(MUS, smp('horn', p, bB * 1.9, .7, rel=.3), F(fB(8, 2)), .45, pan)
    # 马赛克（bar8 拍 2）：12.5% 方波 16 分下行琶音
    mark('mosaic_arp', fB(8, 2))
    for i, p in enumerate(['C7', 'G6', 'E6', 'C6', 'G5', 'E5', 'C5', 'G4']):
        put(MUS, pulse(p, s16 * .8, .125) * env(s16 * .8, .001, .03, .5, .01, 15), F(fB(8, 2)) + i * s16, .06, .4 - .1 * i)
    # bar9：回主 —— 华尔兹动机的大调版收束（八音盒 C6 F6 A6 → F6），F 大调和弦
    mark('final_chord', fB(9, 0))
    for p, pan in [('F3', -.3), ('A3', .3), ('C4', 0)]: put(MUS, smp('horn', p, bB * 1.2, .55, rel=.35), F(fB(9, 0)), .4, pan)
    put(MUS, timp('F2', .55), F(fB(9, 0)), .7); put(MUS, cymb(.5, 1.0), F(fB(9, 0)), .14)
    for i, p in enumerate(['C6', 'F6', 'A6']):
        put(MUS, P.pluck('music_box', p, 1.0, .6), F(fB(9, 0)) + i * s16 * .5, .7, -.2 + .2 * i)

secA(); stinger(); battle(); strip(); friendship(); crescendo(); fanfare()
MUS = seg_echo(MUS)

# ═════════════════════════ 拟音（由 window.EV 驱动） ═════════════════════════
FX = bus()      # bit-crush 过的游戏音效（带一点洞穴回声）
ORG = bus()     # 有机声（心跳），不处理
AMB = bus()

def fx_step(v=1.):
    d = .09; y = bp(X.noise(d), 180, 1400) * expd(d, .018) + np.sin(2 * np.pi * 90 * np.arange(ns(d)) / SR) * expd(d, .02) * .6
    return crush(nrm(y), 7, 2) * v
def fx_glint(v=1.):
    out = np.zeros(ns(.32))
    for i, p in enumerate(['E6', 'G#6', 'B6', 'E7']):
        y = tri(p, .12) * expd(.12, .04); s = int(i * .035 * SR); out[s:s + len(y)] += y[:len(out) - s]
    return out * .7 * v
def fx_creak(v=1.): return crush(nrm(X.creak(1.)), 6, 3) * v
def fx_zoom(): return pulse(500, .14, .25, glide=1600) * env(.14, .002, .1, .5, .03, 15) * .5
def fx_cloth(v=1.): d = .16; return crush(nrm(bp(X.noise(d), 800, 3500)) * env(d, .03, .05, .3, .06), 6, 2) * .4 * v
def fx_woodclick(p=1.):
    d = .05; t = np.arange(ns(d)) / SR
    y = np.sin(2 * np.pi * 700 * p * t) * expd(d, .008) + bp(X.noise(d), 1500, 4000) * expd(d, .004) * .6
    return crush(nrm(y), 6, 2)
def fx_chomp():
    d = .5; t = np.arange(ns(d)) / SR
    low = np.sin(2 * np.pi * np.cumsum(45 + 120 * np.exp(-t / .04)) / SR) * expd(d, .12)
    teeth = (bp(X.noise(d), 1800, 5000) * expd(d, .015)) * 1.4
    clack = np.zeros(ns(d)); c = fx_woodclick(1.6); clack[:len(c)] += c
    return crush(nrm(low + teeth + clack * .8), 6, 2)
def fx_bang(): return np.concatenate([pulse('B5', .05, .5) * env(.05, .001, .02, .7, .005, 15), pulse('E6', .1, .5) * env(.1, .001, .05, .5, .02, 15)]) * .45
def fx_hop(kind=None):
    if kind == 'chest':
        y = np.zeros(ns(.12)); c = fx_woodclick(.75); y[:len(c)] += c; return y * .7
    return pulse(300, .13, .25, glide=900) * env(.13, .002, .08, .4, .03, 15) * .45
def fx_swirl(d):
    t = np.arange(ns(d)) / SR; k = t / d
    sweep = pulse(180, d, .25, glide=2400, vib=.03, vrate=11, vdel=0) * (.2 + .8 * k)
    nz = lfsr(d, 8000)
    hi = np.zeros_like(nz); cut = 400 + 6000 * k ** 2
    # 分段低通扫频
    seg = ns(.04)
    for s in range(0, len(nz), seg):
        hi[s:s + seg] = lp(nz[max(0, s - seg):s + seg], min(20000, cut[min(s, len(cut) - 1)]))[-len(nz[s:s + seg]):]
    y = sweep * .35 + hi * .4 * k
    return crush(y * np.clip((d - t) / .02, 0, 1), 7, 2)
def fx_win(v=1.): return np.concatenate([pulse('A5', .025, .25), pulse('E6', .045, .25)]) * env(.07, .001, .03, .6, .01, 15) * .32 * v
def fx_blip(kind):
    if kind == 'mimic': return crush(pulse('E6', .045, .125) * env(.045, .001, .02, .5, .01, 7), 5) * .42
    return pulse('A5', .03, .25) * env(.03, .001, .015, .5, .008, 15) * .28
def fx_clack(): y = fx_woodclick(1.2); return np.concatenate([y, np.zeros(ns(.03)), fx_woodclick(1.0) * .7]) * .6
def fx_cursor(p=0):
    f = 1046.5 * 2 ** (p * 2 / 12); return pulse(f, .045, .5) * env(.045, .001, .02, .6, .01, 15) * .32
def fx_tremble(d):
    out = np.zeros(ns(d)); per = 1 / 12
    for i in range(int(d / per)):
        c = fx_woodclick(1.5 + .2 * (i % 2)) * .35; s = int(i * per * SR); out[s:s + len(c)] += c[:len(out) - s]
    return out
def fx_confirm(): return np.concatenate([pulse('E6', .04, .5) * env(.04, .001, .02, .7, .005, 15), pulse('A6', .07, .5) * env(.07, .001, .03, .6, .025, 15)]) * .38
def fx_sheath():
    d = .11; t = np.arange(ns(d)) / SR
    y = bp(X.noise(d), 3000, 7000) * env(d, .005, .04, .5, .03) + np.sin(2 * np.pi * 2600 * t) * expd(d, .03) * .3
    return crush(nrm(y), 7, 2) * .35
def fx_heart(): return nrm(lp(X.heartbeat(1.), 300)) * .9
def fx_spit():
    d = .16; y = lp(X.noise(d), 1200) * expd(d, .03) * .8 + pulse(260, d, .5, glide=700) * env(d, .002, .06, .3, .03, 15) * .5
    return crush(nrm(y), 6, 2) * .6
def fx_spin(d):
    t = np.arange(ns(d)) / SR
    return pulse(1500, d, .125, glide=1100) * (.5 + .5 * np.sign(np.sin(2 * np.pi * 14 * t))) * env(d, .02, .3, .7, .05, 15) * .07
def fx_clink():
    y = smp('glockenspiel', 'C7', .4, .8, cut=10000) * 1.4
    j = smp('glockenspiel', 'G7', .3, .6, cut=10000) * .8
    out = np.zeros(max(len(y), len(j) + ns(.05))); out[:len(y)] += y; out[ns(.05):ns(.05) + len(j)] += j
    return out * .8
def fx_tick(k): return pulse(660 * 2 ** (k * 2 / 12), .035, .5) * env(.035, .001, .015, .6, .008, 15) * .3
def fx_flash():
    out = np.zeros(ns(.6))
    for i, p in enumerate(['F5', 'A5', 'C6', 'F6', 'A6', 'C7', 'F7']):
        y = tri(p, .18) * expd(.18, .06); s = int(i * .03 * SR); out[s:s + len(y)] += y[:len(out) - s]
    return out * .3 + hp(lfsr(.6, 22000, True), 5000) * expd(.6, .12) * .05
def fx_whoosh(v=1.): return crush(nrm(X.whoosh(.35, 1.)), 7, 2) * .35 * v
def fx_mosaic(d):
    """马赛克：bit-drop —— 一格一格往下掉的方波 + 越来越粗的采样保持"""
    out = np.zeros(ns(d)); n = 12; st = d / n
    for i in range(n):
        y = pulse(880 * 2 ** (-i / 6) if i < 6 else 880 * 2 ** (-(11 - i) / 6), st, .5) * .12
        s = int(i * st * SR); out[s:s + len(y)] += y[:len(out) - s]
    return crush(out, 5, 4)
def fx_pop():
    y = crush(nrm(X.pop(1.)), 6, 2) * .4; b = pulse('C7', .06, .25) * env(.06, .001, .03, .5, .01, 15) * .2
    out = np.zeros(max(len(y), ns(.03) + len(b))); out[:len(y)] += y; out[ns(.03):ns(.03) + len(b)] += b; return out
def fx_drip():
    d = .35; t = np.arange(ns(d)) / SR
    y = np.sin(2 * np.pi * np.cumsum(1500 * np.exp(-t / .02) + 600) / SR) * expd(d, .03)
    return crush(y, 8) * .25
def amb_bed(d, fin=.05, fout=.3):
    t = np.arange(ns(d)) / SR
    wind = lp(X.brown(d), 260) * (0.8 + .2 * np.sin(2 * np.pi * .3 * t))
    crack = (rng.random(ns(d)) > .9993) * rng.uniform(.3, 1., ns(d)); crack = bp(crack, 1500, 6000) * 4
    y = wind * .35 + crack * .25
    return y * np.clip(t / fin, 0, 1) * np.clip((d - t) / fout, 0, 1)

EC = {}   # 洞穴回声的拟音（脚步、滴水）
def fxput(Bf, x, f, g=1., pan=0.): put(Bf, x, F(f), g, pan)
for e in EVJ['ev']:
    f, ty, v, pan = e['f'], e['type'], e.get('v', 1.), e.get('pan', 0.)
    if ty == 'amb':
        if f == 0: put(AMB, amb_bed(e['dur'] + .02, .3, .02), 0, .55)           # 咬合那一帧切断（遇敌）
        else: put(AMB, amb_bed(e['dur'] + .25, .25, .6), F(f - 6), .55)        # 马赛克峰值前 6 帧先进（J-cut）
    elif ty == 'drip': fxput(FX, fx_drip(), f, .8, pan)
    elif ty == 'step': fxput(FX, fx_step(v), f, .55, pan)
    elif ty == 'glint': fxput(FX, fx_glint(v), f, .55, pan)
    elif ty == 'creak': fxput(FX, fx_creak(v), f, .45, pan)
    elif ty == 'zoom': fxput(FX, fx_zoom(), f, .9)
    elif ty == 'cloth': fxput(FX, fx_cloth(v), f, .9, pan)
    elif ty == 'rattle':
        for k in range(0, int(round(e['dur'] * FPS)), 2): fxput(FX, fx_woodclick(1.1 + .1 * (k % 4 == 0)) * .35, f + k, 1., pan)
    elif ty == 'chomp': fxput(FX, fx_chomp(), f, 1.1)
    elif ty == 'bang': fxput(FX, fx_bang(), f + 1, .9, pan)
    elif ty == 'hop': fxput(FX, fx_hop(e.get('kind')), f, v, pan)
    elif ty == 'swirl': fxput(FX, fx_swirl(e['dur']), f, .8)
    elif ty == 'win': fxput(FX, fx_win(v), f, 1.)
    elif ty == 'blip': fxput(FX, fx_blip(e['kind']), f, 1., .3 if e['kind'] == 'sys' else -.4)
    elif ty == 'clack': fxput(FX, fx_clack(), f, .7, pan)
    elif ty == 'cursor': fxput(FX, fx_cursor(e.get('p', 0)), f, 1.)
    elif ty == 'tremble': fxput(FX, fx_tremble(e['dur']), f, 1., pan)
    elif ty == 'confirm': fxput(FX, fx_confirm(), f, 1.)
    elif ty == 'sheath': fxput(FX, fx_sheath(), f, 1., pan)
    elif ty == 'heartbeat': fxput(ORG, fx_heart(), f, 1.)
    elif ty == 'spit': fxput(FX, fx_spit(), f, 1., pan)
    elif ty == 'spin': fxput(FX, fx_spin(e['dur']), f, 1.)
    elif ty == 'clink': fxput(FX, fx_clink(), f, 1., pan)
    elif ty == 'tick': fxput(FX, fx_tick(e['k']), f, 1.)
    elif ty == 'flash': fxput(FX, fx_flash(), f, 1.)
    elif ty == 'whoosh': fxput(FX, fx_whoosh(v), f, 1.)
    elif ty == 'mosaic': fxput(FX, fx_mosaic(e['dur']), f, 1.)
    elif ty == 'pop': fxput(FX, fx_pop(), f, 1., -.2)
    else: raise SystemExit('未处理的事件类型: ' + ty)
FX = FX + .35 * (seg_echo(FX, taps=(.14, .23, .31), gains=(.45, .35, .25), fb=.3, lpf=2500, wet=1.) - FX)   # 洞穴里的短回声

# ═════════════════════════ 总线 ═════════════════════════
# 音乐在关键拟音下让 3 dB（咬合、升级刺音是音乐自己的，不让）
duck = np.ones(N)
for e in EVJ['ev']:
    if e['type'] in ('chomp', 'clink', 'spit'):
        s = e['f'] * SPF; a, r = ns(.01), ns(.25)
        seg = np.concatenate([np.linspace(1, .7, a), np.full(ns(.08), .7), np.linspace(.7, 1, r)])
        duck[s:s + len(seg)] = np.minimum(duck[s:s + len(seg)], seg[:N - s])
MIX = MUS * .9 * duck[:, None] + FX * .95 + ORG + AMB

# 真零静默（含回声尾巴）：所有总线在窗口前 1 帧用 64 采样淡出，之后硬清零到窗口结束
t = np.arange(N) / SR
for f0, f1 in TL['SILENCE']:
    b = f0 * SPF - SPF
    MIX[b - FADE:b] *= np.linspace(1, 0, FADE, endpoint=False)[:, None]
    MIX[b:f1 * SPF] = 0.
# 收尾：最后 120 ms 余韵归零
MIX *= np.clip((N / SR - t) / .12, 0, 1)[:, None]
MIX[N - SPF:] = 0
# 母带：立体声联动限幅（压掉号角 / 咬合最尖的 7.5 dB 峰值，峰值响度比 ≤ 12 dB，mux 拉到 −14 LUFS 时真峰值不过 −1.2 dB）
from scipy.ndimage import maximum_filter1d, uniform_filter1d
MIX *= .9 / max(1e-9, np.abs(MIX).max())
ceil = .9 * 10 ** (-7.5 / 20); look = ns(.004)
pk = maximum_filter1d(np.abs(MIX).max(1), size=2 * look + 1)
g = np.minimum(1, ceil / np.maximum(pk, 1e-9)); g = np.minimum.accumulate(g[::-1])[::-1] * 0 + g
g = uniform_filter1d(maximum_filter1d(1 - g, size=ns(.03)), size=ns(.01)); g = 1 - g     # 快攻 10 ms、保持 30 ms 的增益曲线
MIX *= g[:, None]
MIX *= .89 / max(1e-9, np.abs(MIX).max())
for c in range(2): MIX[:, c] = X.limit(MIX[:, c], .9)

os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), MIX.astype(np.float32), SR, subtype='PCM_24')
for nm, Bf in [('music', MUS), ('foley', FX + ORG + AMB)]:
    sf.write(os.path.join(HERE, 'out', f'stem_{nm}.wav'), (Bf / max(1e-9, np.abs(Bf).max()) * .9).astype(np.float32), SR)
json.dump({'sr': SR, 'fps': FPS, 'music': KEYEV}, open(os.path.join(HERE, 'out', 'score.json'), 'w'), ensure_ascii=False, indent=1)
pk = np.abs(MIX).max(); print(f'out/mix.wav {N / SR:.3f}s  peak {20 * np.log10(pk + 1e-9):.1f} dBFS  music events {len(KEYEV)}')
