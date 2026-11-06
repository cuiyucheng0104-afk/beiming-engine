"""冰淇淋车 · 配乐与拟音 → out/mix.wav（48 kHz 立体声）。
时间全部来自 events.json（events.mjs 从 main.js / timeline.js 导出）：网格（BPM 120、一拍 0.5 s、b6 = 第 1 小节下拍）和每个可见动作的事件。
乐器：真实采样（core/audio/sampler.py：马林巴、竖琴、钢片琴、手拍、沙锤、踩镲、军鼓滚奏、镲片）+ 物理建模（pluck.py：八音盒）
     + numpy 合成（slap bass、Rhodes 电钢、合成铜管、软底鼓、蹲-弹的 boing、全部拟音）。
用法（在库根目录）：$LIB/.venv/bin/python -I <工程>/mix.py
"""
import sys, os, json
import numpy as np
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import soundfile as sf
from core.audio import sampler as S, pluck as P
from core.audio import sfx as X
from core.audio.sfx import SR, add, limit, lp, hp, bp, t_, env_exp, norm

HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, 'events.json')))
EV = D['ev']; DUR = D['dur']
G = next(e for e in EV if e['type'] == 'grid')
BEAT = G['beat']
CUE = {e['name']: e['beat'] for e in EV if e['type'] == 'cue'}
b = lambda n: n * BEAT
S.seed(71)
rng = np.random.default_rng(71)
N = int((DUR + 0.02) * SR)
MUS = np.zeros((N, 2), np.float32); SFX = np.zeros((N, 2), np.float32); AMB = np.zeros((N, 2), np.float32)
ONSETS = []          # 音乐里每个音的起点，给 tools/cuecheck.py
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)


def put(buf, x, t, g=1.0, pan=0.0, tag=None):
    add(buf, np.asarray(x, np.float32), t, g, pan)
    if tag: ONSETS.append({'t': round(t, 6), 'what': tag})


def samp(inst, pitch, dur, vel, t, g=1.0, pan=0.0, tag=None, **kw):
    put(MUS, S.note(inst, pitch, dur, vel, **kw), t, g, pan, tag or inst)


def perc(inst, var, vel, t, g=1.0, pan=0.0, dur=None, buf=None, tag=None):
    put(MUS if buf is None else buf, S.hit(inst, var, vel, dur), t, g, pan, tag or inst)


# ---------------- 合成乐器 ----------------
def slap(m, d, kind='T', vel=.8):
    """slap bass：加法合成拨弦（高次谐波衰减更快）+ 拇指击弦 / 勾弦的瞬态；kind T=拇指 P=勾弦（更亮）G=闷音"""
    L = d + .25; t = t_(L); f = hz(m); y = np.zeros_like(t)
    nh = int(min(28, 9000 / f))
    for n in range(1, nh + 1):
        a = (1 / n ** (0.75 if kind == 'P' else 1.0)) * (1.6 if n == 2 else 1.0)
        tau = (0.55 if kind != 'G' else .05) / (1 + (0.32 if kind == 'P' else 0.5) * n)
        y += a * np.sin(2 * np.pi * n * f * t + n * 0.7) * np.exp(-t / max(tau, .012))
    y += 0.55 * np.sin(2 * np.pi * f * t) * np.exp(-t / .5)          # 基音的身体
    tr = bp(rng.standard_normal(len(t)), 900, 5000) * np.exp(-t / .004) * (1.3 if kind != 'G' else .8)
    y = np.tanh(1.4 * (y / (np.abs(y).max() + 1e-9) + tr)) * vel
    off = t > d; y[off] *= np.exp(-(t[off] - d) / .035)
    y[:48] *= np.linspace(0, 1, 48)
    return y


def rhodes(m, d, vel=.6):
    """FM 电钢：1:1 调制、指数衰减的调制指数 + 14:1 的 tine 叮声 + 轻微颤音"""
    L = d + .6; t = t_(L); f = hz(m)
    I = (0.6 + 2.2 * vel) * np.exp(-t / .22) + .25
    y = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * f * t))
    y += .22 * vel * np.sin(2 * np.pi * f * 14 * t) * np.exp(-t / .025)
    y *= np.exp(-t / (1.2 + 60 / m)) * (1 + .12 * np.sin(2 * np.pi * 5.2 * t))
    off = t > d; y[off] *= np.exp(-(t[off] - d) / .09)
    y[:96] *= np.linspace(0, 1, 96)
    return y * vel


def rh_chord(ms, d, vel, t0, g=1.0, pan=0.0, tag='rhodes'):
    for i, m in enumerate(ms):
        put(MUS, rhodes(m, d, vel), t0, g * .32, pan + (i - 1.5) * .12)
    ONSETS.append({'t': round(t0, 6), 'what': tag})


def brass(ms, d, vel=.8, att=.025, scoop=.35):
    """合成铜管：每个音三根失谐锯齿（加法合成，带限），滤波截止随包络张开，起音带一点下滑音"""
    L = d + .2; t = t_(L); out = np.zeros_like(t)
    env_f = np.minimum(1, t / .05) * (0.55 + 0.45 * np.exp(-np.maximum(0, t - .05) / .25))
    fc = 500 + 3800 * vel * env_f
    bend = 2 ** (-scoop / 12 * np.exp(-t / .035))
    for m in ms:
        for det in (-.07, 0, .07):
            f = hz(m + det); ph = 2 * np.pi * np.cumsum(f * bend) / SR
            for n in range(1, int(min(40, 9000 / f)) + 1):
                out += (1 / n) * np.sin(n * ph + det * 40 * n) / np.sqrt(1 + (n * f / fc) ** 4)
    amp = np.minimum(1, t / att) * np.where(t < d, 1, np.exp(-(t - d) / .07))
    y = out * amp
    return y / (np.abs(y).max() + 1e-9) * vel


def kick(v=.8):
    t = t_(.45); f = 48 + 75 * np.exp(-t / .03)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .16)
    y += .3 * hp(rng.standard_normal(len(t)), 2500) * np.exp(-t / .002)
    y += .25 * np.sin(2 * np.pi * 2 * np.cumsum(f) / SR) * np.exp(-t / .05)   # 二次谐波，小音箱也听得见
    return y * v


def boing(f0, v=1.0, L=.42, wob=.06):
    """蹲-弹的"弹簧"：音高从下往上滑到 f0，带衰减的颤动"""
    t = t_(L); f = f0 * (0.62 + 0.38 * (1 - np.exp(-t / .05))) * (1 + wob * np.sin(2 * np.pi * 15 * t) * np.exp(-t / .16))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = (np.sin(ph) + .35 * np.sin(2 * ph) + .12 * np.sin(3 * ph)) * np.exp(-t / (L * .38))
    y[:48] *= np.linspace(0, 1, 48)
    return y * v


def thump_lo(v=1.0, f=70, L=.25):
    t = t_(L); fr = f * (1 + .8 * np.exp(-t / .02))
    return np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / (L * .3)) * v


def speaker(x):
    """车顶小喇叭：带通 + 一点饱和"""
    return np.tanh(2.2 * bp(x, 700, 5200)) * .6


# ---------------- 和声与网格 ----------------
EM9 = (40, [55, 59, 62, 66]); A13 = (45, [55, 59, 61, 66]); CM9 = (36, [59, 62, 64, 67])
B7S = (35, [57, 64, 66, 71]); B7 = (35, [57, 63, 66, 71]); D69 = (38, [57, 59, 64, 66]); E69 = (40, [56, 61, 64, 66, 71])
def chord_at(beat):
    if beat < 22: return EM9 if (beat - 6) % 4 < 2 else A13
    if beat < 24: return CM9
    if beat < 25: return B7S
    if beat < 26: return B7
    if beat < 30: return B7
    if beat < 34: return EM9 if int(beat - 30) % 2 == 0 else A13
    if beat < 35: return CM9
    if beat < 36: return D69
    return E69
def tones(beat):     # 当前和弦的和弦音（给调音的拟音和琶音用）
    r, v = chord_at(beat); s = sorted({(x - r) % 12 for x in v} | {0})
    return [r + 12 * 3 + x for x in s]   # 抬到中高音区


# ---------------- 叫卖小调（原创动机）：车上八音盒 → 乐队的马林巴 → 加速 → 结尾回声 ----------------
HOOK_X = [76, None, 79, 83, 81, None, 78, None]     # E5 . G5 B5 A5 . F#5 .
HOOK_Y = [79, 78, 76, 74, 76, None, None, None]     # G5 F#5 E5 D5 E5 . . .
def hook_notes(bar, step):
    """(拍内偏移, midi, 时值拍数)；step=0.5 正常八分音符，0.25 = 加倍速度"""
    out = []
    for i, m in enumerate(bar):
        if m is None: continue
        j = i + 1; L = 1
        while j < len(bar) and bar[j] is None: L += 1; j += 1
        out.append((i * step, m, L * step))
    return out

# Intro b0–b6：八音盒从车上的小喇叭放出来（diegetic），声像跟车，越开越近越响；E5 正好落在 b6 乐队进来的下拍
eng = [e for e in EV if e['type'] == 'engine']
def truck_pan(t):
    c = min(eng, key=lambda e: abs(e['t'] - t)) if eng else {'pan': 0}
    return c['pan']
mb = np.zeros(N, np.float32); mbp = []
for bt, m, L in hook_notes(HOOK_X, .5) + [(4 + o, mm, l) for o, mm, l in hook_notes(HOOK_Y, .5) if o < 2]:
    t0 = b(bt); prox = .45 + .55 * min(1, t0 / b(4))
    x = P.pluck('music_box', m, b(L) + .3, vel=.75)
    put(SFX, speaker(x), t0, .95 * prox, truck_pan(t0), 'musicbox')
    put(SFX, speaker(P.pluck('music_box', m - 12, b(L) + .3, vel=.5)), t0, .4 * prox, truck_pan(t0))
# 进场前的过门：b5–b6 手拍 16 分渐强 + bass 从 E1 滑到 E2
for k in range(4):
    perc('claps', 'solo', .45 + .12 * k, b(5 + k * .25), .32 + .1 * k, -.2 + .13 * k, tag='claps_fill')
tt_ = t_(b(1)); f = hz(28) * 2 ** ((12 * (tt_ / b(1)) ** 1.5) / 12)
sl = np.tanh(1.5 * (np.sin(2 * np.pi * np.cumsum(f) / SR) + .4 * np.sin(4 * np.pi * np.cumsum(f) / SR))) * np.minimum(1, tt_ / .3) * .5
put(MUS, sl, b(5), .55, 0, 'bass_slide')

# ---------------- A 段 b6–b14：全乐队 funk vamp ----------------
BASS_A = [(0, 0, 'T', 1.5), (3, 12, 'P', .8), (4, 0, 'G', .5), (6, 0, 'T', 1), (7, 10, 'P', .8),
          (8, 0, 'T', 1.5), (11, 12, 'P', .8), (12, 0, 'G', .5), (14, -2, 'T', 1), (15, -3, 'T', 1)]
def bass_bar(bar0, pat, vel=.8, g=1.0):
    for s16, off, kind, L in pat:
        beat = bar0 + s16 / 4; r = chord_at(beat)[0]
        if r < 38: r += 12
        m = r + off
        put(MUS, slap(m, b(L / 4) * .95, kind, vel * (.6 if kind == 'G' else 1)), b(beat), .42 * g, -.05, 'bass')

def drums_bar(bar0, dense=False, g=1.0):
    for s16 in range(16):
        t0 = b(bar0 + s16 / 4)
        if s16 in (0, 10) or (dense and s16 in (7, 8)): put(MUS, kick(.9 if s16 == 0 else .7), t0, .5 * g, 0, 'kick')
        if s16 in (4, 12): perc('claps', 'group' if dense else 'solo', .8, t0, .55 * g, .15)
        if dense and s16 in (0, 8): perc('claps', 'solo', .55, t0, .3 * g, -.2)
        if s16 % 2 == 0 or dense: perc('hihat', 'closed', .55 if s16 % 4 == 2 else .35, t0, (.22 if s16 % 2 == 0 else .13) * g, .35)
        perc('shaker', 'down' if s16 % 2 == 0 else 'up', .5, t0, (.16 if dense else .1) * g, -.4)
    if not dense: perc('hihat', 'open', .45, b(bar0 + 3.5), .16 * g, .35)

for bar0 in (6, 10):
    bass_bar(bar0, BASS_A); drums_bar(bar0)
    for half in (0, 2):
        r, v = chord_at(bar0 + half)
        for s16 in (2, 5) if half == 0 else (2, 7):       # Rhodes 反拍和弦
            rh_chord(v, b(.6), .55, b(bar0 + half + s16 / 4), .9)
    # 合成铜管 stab：反拍推进
    put(MUS, brass(chord_at(bar0 + 1.5)[1], b(.4), .75), b(bar0 + 1.5), .26, .2, 'brass')
    put(MUS, brass(chord_at(bar0 + 3.5)[1], b(.35), .7), b(bar0 + 3.5), .22, .2, 'brass')
# 马林巴接过叫卖小调：A 段第 1 小节 X、第 2 小节 Y（八音盒在下面轻轻重叠，像车还在放）
for bar0, hk in ((6, HOOK_X), (10, HOOK_Y)):
    for o, m, L in hook_notes(hk, .5):
        samp('marimba', m - 12, b(L), .78, b(bar0 + o), .55, -.25, 'marimba_hook')
        samp('glockenspiel', m + 12, b(L), .35, b(bar0 + o), .06, .3)
put(MUS, brass(EM9[1], b(.5), .9), b(6), .3, .2, 'brass_downbeat')    # 乐队进场的第一下
perc('clash', 'short', .55, b(6), .16, .3)

# ---------------- B 段 b14–b26：剖面流水线，律动减薄成"机器" ----------------
BASS_B = [(0, 0, 'T', 2), (6, 12, 'P', .8), (8, 0, 'T', 2), (14, 7, 'P', .8)]
for bar0 in (14, 18, 22):
    bass_bar(bar0, BASS_B, .7, .85)
    for s16 in range(0, 16, 2): perc('shaker', 'down', .45, b(bar0 + s16 / 4), .14, -.4)
    perc('claps', 'solo', .55, b(bar0 + 3), .24, .15)
    for half in (0, 2):
        rh_chord(chord_at(bar0 + half)[1], b(1.4), .45, b(bar0 + half), .8)
    # 马林巴 16 分琶音：像传送带一样一格一格往前
    for s16 in range(16):
        beat = bar0 + s16 / 4; ts = tones(beat - 12 * 0)
        ts = [x - 12 for x in tones(beat)]
        m = ts[[0, 1, 2, 3, 2, 1][s16 % 6] % len(ts)] + (12 if (s16 // 8) % 2 else 0)
        samp('marimba', m, b(.25), .45 + (.2 if s16 % 4 == 0 else 0), b(beat), .3, .25 * (1 if s16 % 2 else -1), 'marimba_arp')
# b24–b26 蓄势：铜管长音渐强 + 军鼓滚奏渐强，b26 一下短促的 B7（不解决）→ 全曲停
x = brass(B7S[1], b(1) - .02, .55, att=.4, scoop=0); put(MUS, x, b(24), .22, .15, 'brass_swell')
x = brass(B7[1], b(1) - .03, .75, att=.3, scoop=0); put(MUS, x, b(25), .28, .15, 'brass_swell')
roll = S.hit('snare2', 'roll', .6, b(2)); roll = roll[:int(b(2) * SR)] * np.linspace(.15, 1.0, len(roll[:int(b(2) * SR)])) ** 2
put(MUS, roll, b(24), .5, -.1, 'snare_roll')
put(MUS, brass(B7[1], .14, .95, att=.008, scoop=0), b(CUE['musicStop']), .36, .15, 'stop_stab')
put(MUS, slap(47, .12, 'P', .9), b(CUE['musicStop']), .45, 0, 'stop_bass')
put(MUS, kick(1.0)[:int(.2 * SR)], b(CUE['musicStop']), .5, 0, 'stop_kick')
# 剖面里三个工序各有一个和弦音的"叮"（callout 出现的那一拍）
for k, m in (('cream', 83), ('cone', 86), ('sprinkle', 88), ('finished', 91)):
    samp('glockenspiel', m, .6, .55, b(CUE[k]), .16, .2, 'glock_' + k)

# ---------------- 静默 b26–b30：只剩房间底噪、车身吱呀、弹簧收紧（拟音在下面） ----------------

# ---------------- C 段 b30–b34：弹出！全乐队 + 加倍密度（加速） ----------------
P0 = b(CUE['pop'])
put(MUS, brass(EM9[1] + [71, 74], b(.9), 1.0, att=.006, scoop=.6), P0, .38, .1, 'POP_brass')   # 返修：−2.4 dB，给真峰值留余量
put(MUS, kick(1.0), P0, .36, 0, 'POP_kick')
perc('clash', 'crash', .9, P0, .35, .2, tag='POP_crash')
perc('claps', 'group', 1.0, P0, .45, -.1, tag='POP_claps')
for i, m in enumerate([52, 55, 59, 62, 64, 66, 69, 71, 74, 76, 79, 83, 86, 88]):   # 竖琴上行刮奏（E Dorian）
    samp('harp', m, .8, .7, P0 + i * .018, .3, -.5 + i * .07, 'POP_harp' if i == 0 else None)
BASS_C = [(s, (0 if s % 4 in (0, 1) else 12), 'T' if s % 2 == 0 else 'P', 1) for s in range(16)]
bass_bar(30, BASS_C, .85, 1.0); drums_bar(30, dense=True, g=1.1)
for bt in (30, 31, 32, 33):
    rh_chord(chord_at(bt)[1], b(.4), .6, b(bt + .5), .8)
    if bt > 30: put(MUS, brass(chord_at(bt)[1], b(.3), .8), b(bt), .26, .2, 'brass')
    put(MUS, brass(chord_at(bt)[1], b(.2), .7), b(bt + .75), .18, .2, 'brass')
for bar0, hk in ((30, HOOK_X), (32, HOOK_Y)):          # 叫卖小调加倍速度（16 分音符）：明显的加速
    for o, m, L in hook_notes(hk, .25):
        samp('marimba', m - 12, b(L), .85, b(bar0 + o), .55, -.25, 'marimba_fast')
        samp('glockenspiel', m + 12, b(L), .45, b(bar0 + o), .09, .3)
samp('glockenspiel', 83, .9, .7, b(CUE['callout']), .2, .3, 'glock_today')       # "今日限定"叮（Em9 的 B）
samp('glockenspiel', 88, .9, .6, b(CUE['callout']) + .06, .14, .35)

# ---------------- D 段 b34–b38.5：Cmaj9 → D6/9 → E6/9 收束，八音盒回声 ----------------
for bt, (r, v) in ((34, CM9), (35, D69), (36, E69)):
    L = b(1) if bt < 36 else DUR - b(36)
    put(MUS, brass([x + 12 for x in v[-3:]] if bt < 36 else [x + 12 for x in v[-4:]], L - .03, .8, att=.03), b(bt), .26, .15, 'brass_cad')
    rh_chord(v, L, .55, b(bt), .9)
    put(MUS, slap(r + 12 if r < 38 else r, L * .9, 'T', .85), b(bt), .45, 0, 'bass')
    put(MUS, kick(.8), b(bt), .4, 0, 'kick')
    perc('claps', 'group', .7, b(bt), .35, .1)
    if bt < 36:
        for s in range(4): perc('hihat', 'closed', .4, b(bt + s / 4), .12, .35)
perc('clash', 'crash', .7, b(36), .3, -.2, tag='cad_crash')
for i, m in enumerate([64, 68, 71, 73, 76, 80, 83]):   # 竖琴 E 大调上行
    samp('harp', m, 1.5, .6, b(36) + i * .03, .2, -.3 + i * .1)
for o, m, L in [(0, 76, 1), (.5, 80, 1), (1, 83, 1), (1.5, 85, 2)]:   # 八音盒尾句（E 大调里的叫卖小调变体），首尾呼应
    put(MUS, P.pluck('music_box', m, b(L) + .4, vel=.7), b(36.5 + o), .55, .35, 'musicbox_tail')

# ---------------- 拟音（全部从 window.EV 驱动） ----------------
def sq_sound(size, beat):
    ts = tones(beat)
    k = {'s': 4, 'm': 3, 'l': 2, 'b': 1, 'truck': 0, 'giant': 0}[size]
    return ts, k
groups = {}
for e in EV:
    if e['type'] == 'sq': groups.setdefault(round(e['t'], 4), []).append(e)
ring = {}
for t0 in sorted(groups):
    es = groups[t0]; beat = t0 / BEAT
    big = [e for e in es if e['size'] in ('truck', 'giant')]
    ts = tones(beat)
    # 同一时刻的道具 = 一圈波浪打到一圈道具：音高按圈数在和弦音上往上走（整片广场被波浪"弹"成一段上行琶音）
    w0 = max([w for w in (CUE['wave1'], CUE['wave2'], CUE['wave3']) if b(w) <= t0 + 1e-6], default=CUE['wave1'])
    k = int(round((t0 - b(w0)) / (BEAT / 2)))
    pan = float(np.mean([e.get('pan', 0) for e in es]))
    if big:
        sz = big[0]['size']; f0 = hz(ts[0] - 12)
        add(SFX, thump_lo(1, 62, .35), t0 - .1, .55, pan)                     # 预备的低闷声（蹲下）
        add(SFX, boing(f0, 1, .7, .09), t0, .5 if sz == 'truck' else .45, pan)
        for i, m in enumerate(ts[:5]): add(SFX, S.note('harp', m, .7, .6), t0 + i * .03, .14, pan - .2 + i * .1)
        add(SFX, X.whoosh(.3, .5), t0 - .05, .06, pan)
        ONSETS.append({'t': round(t0, 6), 'what': 'sq_big'})
        continue
    m = ts[min(k, len(ts) - 1) % len(ts)] + 12 * (k // len(ts))
    n = len(es); gg = min(1.6, .55 + .25 * np.sqrt(n))
    add(SFX, thump_lo(.8, 80, .2), t0 - .06, .2 * gg, pan)
    add(SFX, boing(hz(m), .8, .36), t0, .17 * gg, pan)
    add(SFX, S.note('harp', m + 12, .5, .55), t0, .1 * gg, pan * .8)
    ONSETS.append({'t': round(t0, 6), 'what': 'sq_arp'})

for e in EV:
    t0, ty, pan = e['t'], e['type'], e.get('pan', 0)
    if ty == 'frame_open':
        x = bp(rng.standard_normal(int(1.0 * SR)), 1800, 7000) * np.sin(np.pi * np.linspace(0, 1, int(1.0 * SR))) ** 2
        add(SFX, x, t0, .05, 0)
    elif ty == 'frame_close':
        L = e['d']; x = bp(rng.standard_normal(int(L * SR)), 1500, 6000) * np.sin(np.pi * np.linspace(0, 1, int(L * SR))) ** 1.5
        add(SFX, x, t0, .045, 0)
    elif ty == 'engine':
        v = e['v']; x = thump_lo(1, 55, .09) * .8 + bp(rng.standard_normal(int(.09 * SR)), 180, 900) * env_exp(.09, .018) * .5
        add(SFX, x, t0, .16 * v, pan)
    elif ty == 'brake':
        L = e['d']; t = t_(L); f = 2350 * (1 + .012 * np.sin(2 * np.pi * 7 * t)) * (1 - .06 * t / L)
        sq_ = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, t / .15) * np.exp(-t / .6) * (t < L - .02)
        ty_ = bp(rng.standard_normal(len(t)), 250, 1400) * (1 - t / L) ** 1.5
        add(SFX, sq_ * .5 + ty_ * .6, t0, .1, pan)
    elif ty == 'nod':
        add(SFX, X.thump(.8, 58), t0 + .03, .25, pan)
    elif ty == 'wave':
        L = e['d']; x = X.whoosh(L * .6, 1.0); add(SFX, x, t0, .1, -.3); add(SFX, x, t0 + .08, .08, .3)
        r = lp(X.brown(L), 160) * np.sin(np.pi * np.linspace(0, 1, int(L * SR))) ; add(SFX, r, t0, .12, 0)
    elif ty == 'horn':
        for k, (m1, m2) in enumerate(((71, 76), (71, 76))):
            add(SFX, speaker(brass([m1, m2], .1, .8, att=.008, scoop=.1)), t0 + k * .25, .2, pan)
        ONSETS.append({'t': t0, 'what': 'horn'})
    elif ty == 'latch':
        add(SFX, X.click(.8, 1), t0, .3, pan); add(SFX, X.click(1.2, .7), t0 + .03, .15, pan)
    elif ty == 'lift':
        x = hp(rng.standard_normal(int(.55 * SR)), 2500) * np.exp(-np.linspace(0, 4, int(.55 * SR))); add(SFX, x, t0, .06, 0)
        add(SFX, X.whoosh(.45, .7), t0, .08, .2)
    elif ty == 'lower':
        add(SFX, X.whoosh(e['d'], .6), t0, .08, -.2)
    elif ty == 'clunk':
        add(SFX, X.thump(1, 75), t0, .4, 0); add(SFX, X.clack(.8, 1), t0, .3, 0)
    elif ty == 'motor':
        L = e['d']; t = t_(L); f = 98 * (1 + .015 * np.sin(2 * np.pi * 3 * t))
        ph = 2 * np.pi * np.cumsum(f) / SR; x = sum(np.sin(n * ph) / n for n in range(1, 14))
        x = bp(x, 120, 1600) * np.minimum(1, t / .2) * np.minimum(1, (L - t) / .5) * (1 + .3 * np.sin(2 * np.pi * 9 * t))
        add(SFX, x, t0, .035, pan)
    elif ty == 'callout':
        add(SFX, X.pop(.8), t0, .22, pan)
    elif ty == 'bigcallout':
        add(SFX, X.pop(1), t0, .35, pan); add(SFX, boing(hz(71), .8, .3), t0, .12, pan)
    elif ty == 'belt':
        L = e['d']; t = t_(L); x = bp(rng.standard_normal(len(t)), 500, 2400) * (1 + .7 * np.sin(2 * np.pi * 24 * t)) * np.sin(np.pi * t / L)
        add(SFX, x, t0, .05, pan)
        for k in range(4): add(SFX, X.click(1.4, .5), t0 + k * L / 4, .06, pan)
    elif ty == 'clack':
        add(SFX, X.clack(1.3, 1), t0, .25, pan)
    elif ty == 'extrude':
        L = e['d']; t = t_(L); x = rng.standard_normal(len(t))
        fc = 1700 - 1100 * t / L
        y = np.zeros_like(x); a = 0.0
        al = 1 - np.exp(-2 * np.pi * fc / SR)
        for i in range(len(x)): a += al[i] * (x[i] - a); y[i] = a
        y *= (1 + .8 * np.sin(2 * np.pi * 11 * t)) * np.minimum(1, t / .05) * np.minimum(1, (L - t) / .3)
        add(SFX, norm(y), t0, .1, pan)
        add(SFX, X.pop(.6), t0 + .02, .1, pan)
    elif ty == 'shake':
        x = S.hit('shaker', 'roll', .7, e['d']); add(SFX, x, t0, .5, pan)
    elif ty == 'tick':
        add(SFX, X.click(1.8 + .4 * rng.random(), e.get('v', .7)), t0, .04, pan + rng.uniform(-.1, .1))
    elif ty == 'ding':
        add(SFX, S.note('glockenspiel', 95, .8, .6), t0, .12, pan); add(SFX, X.ding(.8), t0, .05, pan)
    elif ty == 'creak':
        add(SFX, X.creak(e['v']), t0, .28 * e['v'], 0)
    elif ty == 'spring_wind':
        L = e['d']; t = t_(L)
        tone = np.sin(2 * np.pi * np.cumsum(190 + 260 * (t / L) ** 1.6) / SR) * (t / L) * np.minimum(1, (L - t) / .35) * .3
        add(SFX, tone, t0, .05, 0)
        tk = 0.0; k = 0
        while tk < L - .3:
            add(SFX, X.click(2.4, .5), t0 + tk, .05 * (1 - tk / L) + .015, .2 * (-1) ** k); k += 1; tk += .16 * (1 - .7 * tk / L)
    elif ty == 'bigpop':                         # 静默后的第一声：全片最重要的一声（拟音层，配合上面的音乐层）
        add(SFX, thump_lo(1, 48, .8), t0, .38, 0)   # 返修：−2.4 dB
        add(SFX, X.pop(1), t0, .42, 0)
        add(SFX, boing(hz(52), 1, 1.0, .12), t0, .4, 0)
        add(SFX, boing(hz(64), 1, .8, .1), t0 + .01, .3, .2)
        add(SFX, X.whoosh(.5, 1), t0 - .02, .2, 0)
    elif ty == 'patter':
        add(SFX, X.click(2.2 + .6 * rng.random(), .6), t0, .03, pan)
        if rng.random() < .3: add(SFX, S.note('glockenspiel', int(rng.choice([88, 91, 95, 98])), .3, .3), t0, .02, pan)

# ---------------- 环境层 ----------------
tt = np.arange(N) / SR
def amb_level(t):
    k = np.interp(t, [0, 1.0, b(6), b(14), b(26) - .05, b(26) + .4, b(30) - .01, b(30), b(34), DUR - .6, DUR],
                     [0, 1.0, 1.0, .6, .45, .0, .0, .55, .6, .5, 0])
    return k
lv = amb_level(tt)
foun = bp(rng.standard_normal(N), 900, 5000) * (0.6 + 0.4 * np.abs(np.sin(2 * np.pi * 1.7 * tt) * np.sin(2 * np.pi * .43 * tt)))
foun2 = bp(rng.standard_normal(N), 250, 900) * .4
AMB[:, 0] += (foun * .013 + foun2 * .01) * lv; AMB[:, 1] += (np.roll(foun, 911) * .013 + foun2 * .01) * lv
room_tone = lp(X.brown(N / SR), 500) * .006 * np.interp(tt, [0, .5, DUR - .5, DUR], [0, 1, 1, 0])
AMB[:, 0] += room_tone; AMB[:, 1] += np.roll(room_tone, 1200)
def chirp(f0, d):
    t = t_(d); f = f0 * (1 + .35 * np.sin(np.pi * t / d)); return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / d) ** 2
for t0 in (0.35, 0.47, 1.3, 1.42, 2.4, 4.6, 4.72, 6.4, 17.2, 17.32, 18.1):
    for k in range(int(2 + 2 * rng.random())):
        x = chirp(3600 + 1500 * rng.random(), .07); a = float(amb_level(t0)); add(AMB, x, t0 + k * .09, .04 * a, rng.uniform(-.8, .8))

# ---------------- 混音 ----------------
MUS[:] = S.room(MUS, size=.32, mix=.14)
SFX[:] = S.room(SFX, size=.25, mix=.08)
# 音乐总线：静默段里真的没有音乐（只剩停顿和弦的自然尾音）
for ch in (0, 1): MUS[:, ch] += .45 * hp(MUS[:, ch], 2600)          # 存在感：2.6 kHz 以上约 +3 dB（slap 和铜管要"亮"）
mix = MUS * 0.9 + SFX * 1.0 + AMB
pk = np.abs(mix).max(1); w = int(.25 * SR)
print('pre-limit peaks:', ', '.join(f'{i * .25:.2f}s {pk[i * w:(i + 1) * w].max():.2f}' for i in range(len(pk) // w) if pk[i * w:(i + 1) * w].max() > .95))
fade = np.interp(tt, [0, .05, DUR - .5, DUR], [0, 1, 1, 0]).astype(np.float32)
mix *= fade[:, None]
# 真峰值限幅（返修）：4 倍过采样估计采样间峰值，天花板 −1.9 dBTP；
# 这样峰值/响度比 ≤ 12.4 dB，mux 的 loudnorm 可以走线性增益（不进动态模式），成片真峰值有 ≥0.4 dB 余量
from scipy.signal import resample_poly
from scipy.ndimage import maximum_filter1d, uniform_filter1d
def tp_limit(x, ceil=.80, look=.005):
    n = int(look * SR)
    up = np.abs(resample_poly(x, 4, 1))[:4 * len(x)].reshape(-1, 4).max(1)
    m = maximum_filter1d(np.maximum(up, np.abs(x)), size=2 * n + 1)
    g = np.minimum(1, ceil / np.maximum(m, 1e-9)); g = uniform_filter1d(g, size=n)
    g = np.minimum(g, uniform_filter1d(g, size=n))
    return x * g
mix = np.stack([tp_limit(mix[:, 0]), tp_limit(mix[:, 1])], 1).astype(np.float32)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
for nm, x in (('music', MUS), ('sfx', SFX), ('amb', AMB)):
    sf.write(os.path.join(HERE, 'out', f'stem_{nm}.wav'), np.clip(x, -1, 1), SR, subtype='PCM_16')
json.dump(sorted(ONSETS, key=lambda o: o['t']), open(os.path.join(HERE, 'out', 'music_onsets.json'), 'w'), ensure_ascii=False, indent=0)
# 频段能量（TECHNIQUE §5：20–120 Hz 相对其余约 −3 dB）
from numpy.fft import rfft, rfftfreq
m = mix.mean(1); Sp = np.abs(rfft(m)) ** 2; fr = rfftfreq(len(m), 1 / SR)
lo = Sp[(fr >= 20) & (fr < 120)].sum(); rest = Sp[(fr >= 120) & (fr < 16000)].sum()
print(f'mix.wav {len(m) / SR:.2f}s peak {np.abs(mix).max():.3f}  low(20-120)/rest = {10 * np.log10(lo / rest):+.1f} dB  onsets {len(ONSETS)}')
