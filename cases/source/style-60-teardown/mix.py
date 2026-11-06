"""《按一下》配乐 + 拟音 + 混音 → out/mix.wav（+ out/stems/、out/score.json）。
120 BPM，D 小调；精密打击：马林巴、颤音琴（硬槌/弓奏）、钟琴、玻璃、爵士低音拨弦 + 正弦泛音、numpy 合成底鼓与金属 tick、木块、响棒。
"咔哒"是全片动机：咔 = 木块高音 + 塑料 click + 金属 tick；哒 = 响棒 + 低 thock + 底鼓。拟音全部由 events.json（window.EV）驱动。
运行：$LIB/.venv/bin/python mix.py（LIB 默认 @@LEMO_ROOT@@）
"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB') or '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, noise, lp, hp, bp, env_exp, t_, norm, limit

S.seed(60)
rng = np.random.default_rng(60)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EVJ['dur']; EV = EVJ['ev']
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
T, BEAT = TL['T'], TL['BEAT']
BAR = 4 * BEAT
N = int((DUR + .05) * SR)
def buf(): return np.zeros((N, 2), np.float32)
def bt(n): return round(n * BEAT, 4)           # 拍号 → 秒
CUES = []                                      # (时间, 名称)：cuecheck 用
def cue(t, name): CUES.append((round(t, 4), name))

PAN = {'plunger': .45, 'cam': .35, 'rear': .1, 'front': -.5, 'spring': -.35, 'refill': -.15}

# ================= 配乐 =================
ev = []            # 采样音符 (t, inst, pitch, dur, vel, pan, gain)
kicks = []         # (t, gain)
ticks = []         # 精密 tick (t, gain, pan)
CH = {  # 每小节的和弦（小节号从 1 起，1 小节 = 2 s）
    2: ['D3', 'F3', 'A3', 'C4', 'E4'], 3: ['D3', 'F3', 'A3', 'C4', 'E4'], 4: ['A#2', 'D3', 'F3', 'A3', 'C4'],
    5: ['D3', 'F3', 'A3', 'C4', 'E4'], 6: ['A#2', 'D3', 'F3', 'A3', 'C4'], 7: ['G2', 'A#2', 'D3', 'F3', 'A3'],
    9: ['A#2', 'D3', 'F3', 'A3', 'C4'], 10: ['A2', 'C#3', 'E3', 'G3', 'A3'],
}
ROOT = {2: 'D2', 3: 'D2', 4: 'A#1', 5: 'D2', 6: 'A#1', 7: 'G1', 9: 'A#1', 10: 'A1'}
def up(p, n): return S.name(S.midi(p) + 12 * n)
def bar0(b): return (b - 1) * BAR

# A · 0–2：只有精密 tick（八分），越来越近
for i in range(4):
    ticks.append((bt(i), .25 + .05 * i, .3)); ticks.append((bt(i) + BEAT / 2, .18, -.3))

# 动机"咔哒"：马林巴 A4（咔）→ D4（哒）
def motif(t_ka, t_da, vel=.55, gain=1.0):
    ev.append((t_ka, 'marimba', 'A4', .3, vel, .25, gain)); ev.append((t_da, 'marimba', 'D4', .6, vel + .08, -.1, gain))

motif(T['ka1'], T['da1'], .5, .8)
kicks.append((T['da1'], .6))

# A→B · 小节 2（2–4）：低音进、马林巴八分、木块在 2/4 拍
for b in (2, 3):
    t0 = bar0(b); c = CH[b]
    for k in (0, 1.5, 2, 3):
        ev.append((t0 + k * BEAT, 'jazz_bass', ROOT[b], BEAT * .9, .72, 0, 1.2))
    for i in range(8):
        t = t0 + i * BEAT / 2
        ev.append((t, 'marimba', up(c[[0, 2, 4, 2, 1, 2, 3, 2][i]], 1), .3, .36 + .1 * (i % 2 == 0), [-.3, .3][i % 2], .8))
    for k in (1, 3): ev.append((t0 + k * BEAT, 'woodblock', 'a', None, .5, .3, .45))
    kicks.append((t0 + 2 * BEAT, .6))
    for i in range(8): ticks.append((t0 + i * BEAT / 2, .22, .3 * (-1) ** i))
kicks.append((bar0(3), .6))

# B · 波浪抬起：每个零件起飞一个上行颤音琴音 + 钟琴点（3.0 4.0 5.0 5.5 6.0 6.25）
WAVE = [('plunger', 'D4'), ('cam', 'F4'), ('rear', 'A4'), ('front', 'C5'), ('spring', 'D5'), ('refill', 'F5')]
for part, p in WAVE:
    t = TL['UP'][part]
    ev.append((t, 'vibraphone_hard', p, 1.2, .62, PAN[part], .65))
    ev.append((t, 'glockenspiel', up(p, 1), .8, .35, PAN[part], .35))
    cue(t, 'lift-' + part)
# 加速：小节 3 后半起 tick 变十六分；小节 4（6–8）律动铺满
for i in range(8): ticks.append((bar0(3) + 2 * BEAT + i * BEAT / 4, .2 + .06 * (i % 2 == 0), .25))
for b in (4, 5, 6):
    t0 = bar0(b); c = CH[b]
    for i in range(16):
        t = t0 + i * BEAT / 4
        ev.append((t, 'marimba', up(c[[0, 2, 4, 2, 1, 3, 4, 3][i % 8]], 1 + (i % 8 == 2)), .25, .34 + .16 * (i % 4 == 0), [-.35, .35][i % 2], .75))
        ticks.append((t, .16 + .1 * (i % 2 == 0), -.25))
    for k in (0, 1.5, 2, 3, 3.5): ev.append((t0 + k * BEAT, 'jazz_bass', ROOT[b], BEAT * .85, .74, 0, 1.2))
    for k in (0, 2): kicks.append((t0 + k * BEAT, .6))
    for k in (1, 3): ev.append((t0 + k * BEAT, 'claves', None, None, .5, .2, .5))
# 小节 7 前半（12–12.5）：律动继续，12.5 合奏刺（属和弦 A7，不解决），然后静默
t0 = bar0(7); c = CH[7]
for i in range(4):
    t = t0 + i * BEAT / 4
    ev.append((t, 'marimba', up(c[[0, 2, 4, 2][i]], 1), .25, .4, [-.35, .35][i % 2], .75)); ticks.append((t, .2, -.25))
ev.append((t0, 'jazz_bass', 'G1', BEAT * .9, .74, 0, 1.2)); kicks.append((t0, .85))
ts = T['stab']
STAB = .45   # 刺降 3 dB：静默后的内部咔必须是全片最响的一下
for j, p in enumerate(['A2', 'E3', 'G3', 'C#4', 'E4', 'A4']): ev.append((ts + j * .012, 'marimba', p, .5, .7, -.4 + .16 * j, 1.0 * STAB))
ev.append((ts, 'vibraphone_hard', 'C#5', .5, .6, .2, .7 * STAB)); ev.append((ts, 'jazz_bass', 'A1', .45, .8, 0, 1.3 * STAB)); kicks.append((ts, 1.0 * STAB))
cue(ts, 'stab')

# E · 缝内（14–17）：弓奏颤音琴 Dm(add9)、玻璃、长低音；半拍感
tg = T['gapIn']
for j, p in enumerate(['D4', 'F4', 'A4', 'E5']): ev.append((tg + j * .03, 'vibraphone_bowed', p, 3.1, .45, -.45 + .3 * j, .85))
ev.append((tg, 'jazz_bass', 'D2', 2.0, .72, 0, 1.1)); ev.append((bt(32), 'jazz_bass', 'A#1', 1.0, .7, 0, 1.0))
for k, p in [(0, 'A5'), (1.0, 'F5'), (2.0, 'E5'), (2.5, 'D5')]: ev.append((tg + k, 'glass', p, 1.3, .45, .3 - .2 * k, .55 if k == 0 else .4))
for k in (0, 2): kicks.append((tg + k, .5 if k == 0 else .2))
for i in range(6): ticks.append((tg + i * BEAT, .12, .4 * (-1) ** i))

# F · 合拢（17–18）：十六分马林巴回归，加速；18 起 A7，18.5 咔，19.0 哒 → D 大三和弦
t0 = T['pull']
for i in range(8):
    t = t0 + i * BEAT / 4; c = CH[9]
    ev.append((t, 'marimba', up(c[[0, 2, 4, 2, 1, 3, 4, 3][i]], 1 + (i == 2)), .25, .38 + .03 * i, [-.35, .35][i % 2], .8)); ticks.append((t, .2, -.25))
kicks.append((t0, .6)); ev.append((t0, 'jazz_bass', 'A#1', BEAT * 1.8, .75, 0, 1.2))
t1 = bar0(10)
kicks.append((t1, .85)); ev.append((t1, 'jazz_bass', 'A1', BEAT * 1.9, .75, 0, 1.2))
for i in range(4): ticks.append((t1 + i * BEAT / 2, .14, .3))
motif(T['ka2'], T['da2'], .55, .9)
td = T['da2']
kicks.append((td, .5))
for j, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5']): ev.append((td + j * .04, 'marimba', p, 1.2, .6, -.5 + .2 * j, .55))
for p in ['D4', 'F#4', 'A4']: ev.append((td, 'vibraphone_hard', p, 1.0, .5, 0, .7))
ev.append((td, 'jazz_bass', 'D2', 1.0, .8, 0, 1.0)); ev.append((td + .25, 'glockenspiel', 'D6', .6, .4, .3, .45))

ev = [(e[0], e[1], e[2], e[3], e[4], e[5], e[6] * (.45 if e[1] == 'jazz_bass' else 1)) for e in ev]
music = np.asarray(S.render([e for e in ev if e[0] < DUR], dur=N / SR, master=False), np.float32)
music = np.pad(music, ((0, max(0, N - len(music))), (0, 0)))[:N]

# 低音的 2、3 次谐波：小音箱上也听得见（按低音音符叠正弦）
harm = buf()
for e in ev:
    if e[1] != 'jazz_bass' or e[0] >= DUR: continue
    f = S.hz(e[2]); d = min(e[3] + .15, 2.2); tt = t_(d)
    x = (np.sin(2 * np.pi * 2 * f * tt) * .5 + np.sin(2 * np.pi * 3 * f * tt) * .25) * env_exp(d, .25) * np.minimum(1, tt / .005)
    add(harm, x.astype(np.float32), e[0], .07 * e[4], 0)

def kick(v=1.0):
    d = .4; tt = t_(d); f = 60 + 95 * np.exp(-tt / .03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return norm(np.sin(ph) * env_exp(d, .14) + np.sin(2 * ph) * .25 * env_exp(d, .04) + hp(noise(d), 3000) * env_exp(d, .002) * .25) * v
def mtick(v=1.0, f=7200):        # 精密 tick：极短的高频金属
    d = .025; tt = t_(d)
    return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .0025) + hp(noise(d), 7000) * env_exp(d, .0008) * .5) * v
pulse = buf()
for t, v in kicks: add(pulse, kick(1), t, .24 * v)
for t, v, p in ticks: add(pulse, mtick(1, 7200 + 600 * rng.random()), t, .07 * v / .25, p)

# ================= 拟音 =================
fol = buf()
def plastic_click(p=1.0, v=1.0):          # 按钮到底：塑料 click + 金属簧片
    d = .1; tt = t_(d); pp = p * (.95 + .1 * rng.random())
    x = hp(noise(d), 3500) * env_exp(d, .0012) * .9 + np.sin(2 * np.pi * 3100 * pp * tt) * env_exp(d, .005) * .5
    x += sum(a * np.sin(2 * np.pi * f * pp * tt) * env_exp(d, tau) for f, a, tau in [(1250, .7, .012), (2400, .4, .008), (640, .45, .018)])
    return norm(x) * v
def thock(v=1.0, f=210):                   # 哒：笔芯锁定的低 thock
    d = .14; tt = t_(d)
    x = np.sin(2 * np.pi * f * tt * (1 - .25 * tt)) * env_exp(d, .025) + lp(noise(d), 1200) * env_exp(d, .008) * .6 + hp(noise(d), 4000) * env_exp(d, .001) * .5
    return norm(x) * v
def metal(f=2400, v=1.0, d=.9):           # 小金属件：非谐鸣响
    tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * k * tt) * env_exp(d, tau) for k, a, tau in [(1, 1, .35), (2.76, .5, .18), (5.4, .25, .09), (8.9, .12, .05)])
    return norm(x + hp(noise(d), 5000) * env_exp(d, .002) * .6) * v
def swoosh(d=.6, v=1.0, rise=True, lo=300, hi=3600):
    n = noise(d); out = np.zeros_like(n); tt = t_(d)
    for i in range(0, len(n), 480):
        j = min(len(n), i + 480); u = i / len(n); u = u if rise else 1 - u
        f = lo + hi * u ** 1.5; out[i:j] = bp(n[max(0, i - 2400):j], f * .6, f * 1.4)[-(j - i):]
    return norm(out * np.sin(np.pi * tt / d) ** 1.5) * v
def friction(d=.25, v=1.0):                # 按钮下压时的细摩擦
    tt = t_(d); return norm(bp(noise(d), 2000, 7000) * np.sin(np.pi * tt / d) ** 2) * v
def zip_(d=.3, v=1.0, rate=45):            # 螺纹松开 / 拧紧：细密的棘齿
    tt = t_(d); g = (np.sin(2 * np.pi * rate * tt) > .6).astype(float)
    return norm(bp(noise(d), 2500, 8000) * g * np.sin(np.pi * tt / d)) * v
def clack(p=1.0, v=1.0):                   # 空心塑料件落位
    d = .12; tt = t_(d)
    x = hp(noise(d), 1500) * env_exp(d, .003) * .7 + sum(a * np.sin(2 * np.pi * f * p * tt) * env_exp(d, tau) for f, a, tau in [(820, .7, .02), (1650, .45, .012), (380, .5, .03)])
    return norm(x) * v
def boing(v=1.0):                          # 弹簧：短促的金属弹响
    d = .35; tt = t_(d); f = 1900 * (1 + .04 * np.sin(2 * np.pi * 38 * tt) * env_exp(d, .06))
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .07) + hp(noise(d), 5000) * env_exp(d, .002) * .4) * v
def pen(d=.45, v=1.0):                     # 尺寸线 / 引线：细笔 hiss
    tt = t_(d); return norm(bp(noise(d), 3500, 9500) * np.sin(np.pi * tt / d) ** 2 * (1 + .3 * np.sin(2 * np.pi * 31 * tt))) * v
def ltick(v=1.0, f=5200):
    d = .03; tt = t_(d); return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .003) + hp(noise(d), 6000) * env_exp(d, .001) * .4) * v
def wood(v=1.0, shift=0):                  # 木块（采样），可下移调
    x = S.hit('woodblock', 'a', .85)
    if shift:
        import soxr; x = soxr.resample(x, SR, int(SR * 2 ** (shift / 12)))
    return norm(x) * v

def ka(t, big=1.0, pan=0.0):
    add(fol, plastic_click(1, 1), t, .5 * big, pan); add(fol, wood(1), t, .3 * big, pan); add(fol, mtick(1, 6400), t, .2 * big, pan)
def da(t, pan=0.0, g=1.0):
    add(fol, thock(1), t, .45 * g, pan); add(fol, S.hit('claves', None, .7), t, .25 * g, pan); add(fol, metal(3300, 1, .25), t, .06 * g, pan)

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'pressStart': add(fol, friction(.25), t, .06, .1)
    elif ty == 'ka': ka(t, .55 if t < 10 else .4); cue(t, 'ka')
    elif ty == 'da': da(t, -.2, .5 if t < 10 else .42); cue(t, 'da')
    elif ty == 'whip': add(fol, swoosh(.5, 1, True, 500, 4200), t, .22 if t < 10 else .16, -.4 if t < 10 else .4)
    elif ty == 'pullback': add(fol, swoosh(.9, 1, False, 250, 2600), t, .16, 0)
    elif ty == 'lift':
        p = PAN[e['part']]
        add(fol, ltick(1, 4200 + 400 * rng.random()), t, .09, p)                    # 脱扣小 click
        add(fol, swoosh(.7, 1, True), t, .14, p)                                    # 抬起的气流
        if e['part'] in ('rear', 'front'): add(fol, zip_(.3, 1), t, .07, p)         # 螺纹松开
        if e['part'] == 'spring': add(fol, boing(1), t + .05, .05, p)               # 弹簧松开伸长
    elif ty == 'label': add(fol, ltick(1, 4800 + 300 * e['n']), t, .12, .5); add(fol, pen(.36), t, .05, .4); cue(t, f"label{e['n']}")
    elif ty == 'dim': add(fol, pen(.45), t, .08, -.2); add(fol, ltick(1, 6000), t + .44, .07, -.2); cue(t, f"dim{e['n']}")
    elif ty == 'stab': pass
    elif ty == 'dive': add(fol, swoosh(.9, 1, False, 150, 1200), t, .009, .1)    # 近静默里只有几乎听不见的气流（−14 dB）
    elif ty == 'note': add(fol, ltick(.8, 5600), t, .012, .4)                      # 缝内标签：极轻的 tick（−12 dB）
    elif ty == 'tooth':
        if e['n'] == 0:                     # 全片最重要的声音：从内部听的"咔"
            big = buf()
            d = .9; tt = t_(d)
            sub = np.sin(2 * np.pi * 64 * tt * (1 - .15 * tt)) * env_exp(d, .16) + np.sin(2 * np.pi * 128 * tt) * env_exp(d, .1) * .45
            add(big, norm(sub), t, .42)
            add(big, wood(1, -12), t, .55, .05)
            add(big, plastic_click(.55, 1), t, .5, 0)
            add(big, metal(880, 1, 2.2), t, .14, .15)
            add(big, hp(noise(.02), 3000) * env_exp(.02, .002), t, .3)
            bh = big.copy(); bh[:, 0] = hp(bh[:, 0], 180); bh[:, 1] = hp(bh[:, 1], 180)
            BIG = (big + S.room(bh, size=.95, mix=.7, damp=.4)).astype(np.float32)   # RT60 ≈ 3.2 s：全片最长的混响尾
        else:                               # 第二、三齿：降 4 dB
            g4 = .45
            add(fol, wood(1, -7), t, .3 * g4, .1); add(fol, plastic_click(.7, 1), t, .3 * g4); add(fol, metal(1320 if e['n'] == 1 else 1180, 1, 1.2), t, .07 * g4, .2)
        cue(t, f"tooth{e['n']}")
    elif ty == 'pull': add(fol, swoosh(.8, 1, False, 300, 3600), t, .18, 0); cue(t, 'pull')
    elif ty == 'land':
        p, k = PAN[e['part']], e['part']
        if k == 'refill': add(fol, metal(2900, 1, .35), t, .06, p)
        elif k == 'spring': add(fol, boing(.8), t, .03, p)
        elif k == 'front': add(fol, zip_(.22, 1, 60), t - .22, .05, p); add(fol, clack(1.1, 1), t, .18, p)
        elif k == 'rear': add(fol, zip_(.22, 1, 60), t - .22, .05, p); add(fol, clack(.85, 1), t, .12, p)
        elif k == 'cam': add(fol, clack(1.5, 1), t, .12, p)
        elif k == 'plunger': add(fol, metal(2400, 1, .5), t, .12, p); add(fol, plastic_click(1.2, .8), t, .12, p)
        cue(t, 'land-' + k)

# 房间底噪：全程很轻；缝内抬高并加一层空气
tt = np.arange(N) / SR
bed = lp(np.cumsum(noise(N / SR)) * .002, 300); bed -= np.convolve(bed, np.ones(4800) / 4800, 'same'); bed = norm(bed)
air = norm(bp(noise(N / SR), 300, 2400))
inside = np.clip((tt - T['hush']) / .8, 0, 1) * np.clip((T['pull'] + .3 - tt) / .5, 0, 1)
amb = (bed * .012 + air * .003 * inside)[:, None] * np.ones((1, 2), np.float32)

# 静默：12.75 后音乐（采样 + 律动）全部收掉，14.00 由内部的"咔"重新打开
def gate(a, z, fa=.25, fz=.005):
    g = np.ones(N, np.float32); i0, i1 = int(a * SR), int(z * SR)
    g[i0:i1] = 0; g[max(0, i0 - int(fa * SR)):i0] *= np.linspace(1, 0, min(i0, int(fa * SR))); g[i1:i1 + int(fz * SR)] *= np.linspace(0, 1, int(fz * SR))
    return g[:, None]
G = gate(T['hush'], T['gapIn'] - .002, fa=.3)
music *= G; pulse *= G; harm *= G

# ================= 混音 =================
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-12)
mus = music + pulse + harm
for ch in range(2): mus[:, ch] = hp(mus[:, ch], 48, 4); fol[:, ch] = hp(fol[:, ch], 38, 4)
mus = S.room(mus, size=.35, mix=.12)
mus *= gate(T['hush'], T['gapIn'] - .002, fa=.3)          # 混响尾也收掉：13.0–14.0 只剩底噪
body = mus * .85 + fol * 1.0 + amb
# 结尾：最后 0.35 s 自然收尾（不硬切）
fe = int(.35 * SR); body[-fe:] *= (np.linspace(1, 0, fe) ** 1.5)[:, None]

# ================= 母带：自己做到 −14 LUFS，让 mux 的 loudnorm 只做 ≈0 dB 的线性增益 =================
from scipy.signal import lfilter, resample_poly
def lufs(x):                                   # ITU-R BS.1770-4 整合响度（K 计权 + 绝对/相对门限）
    K = np.tan(np.pi * 1681.974450955533 / SR); Vh = 10 ** (3.999843853973347 / 20); Vb = Vh ** .4996667741545416; Q = .7071752369554196
    a0 = 1 + K / Q + K * K; b1_ = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]; a1_ = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    K = np.tan(np.pi * 38.13547087602444 / SR); Q = .5003270373238773; a0 = 1 + K / Q + K * K
    b2_ = [1, -2, 1]; a2_ = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    y = lfilter(b2_, a2_, lfilter(b1_, a1_, x, axis=0), axis=0)
    blk, hop = int(.4 * SR), int(.1 * SR)
    z = np.array([np.mean(y[i:i + blk] ** 2, 0).sum() for i in range(0, len(y) - blk + 1, hop)])
    l = -.691 + 10 * np.log10(z + 1e-12); z = z[l > -70]
    rel = -.691 + 10 * np.log10(z.mean()) - 10; l = -.691 + 10 * np.log10(z + 1e-12)
    return float(-.691 + 10 * np.log10(z[l > rel].mean()))
def tpk(x): return float(20 * np.log10(np.abs(resample_poly(x, 4, 1, axis=0)).max() + 1e-12))   # 4× 过采样真峰值
db = lambda v: 10 ** (v / 20)
TARGET, BODY_CEIL, BIG_PK = -14.0, -5.6, -1.7
for it in range(3):                             # 主体：响度到 −14，再把所有峰压到 −5.5 dBFS 以下（给 14.0 的咔留出 3 dB 以上）
    body *= db(TARGET - lufs(body))
    pre = body.copy()
    for ch in range(2): body[:, ch] = limit(body[:, ch], db(BODY_CEIL))
    gr = 20 * np.log10(np.maximum(np.abs(body), 1e-9) / np.maximum(np.abs(pre), 1e-9))
    if it == 0:
        g1 = gr.min(1); hot = [(round(i / SR, 2), round(float(g1[i]), 1)) for i in np.argsort(g1)[::4800][:0]]
        tt_ = np.arange(len(g1)) / SR; bins = {}
        for i in np.where(g1 < -2)[0][::200]: k_ = round(tt_[i] * 4) / 4; bins[k_] = min(bins.get(k_, 0), round(float(g1[i]), 1))
        print('  GR>2 dB by 0.25 s:', sorted(bins.items()))
    print(f'  limiter pass {it}: pre-peak {20 * np.log10(np.abs(pre).max()):.1f} dBFS, max GR {gr.min():.1f} dB, samples with GR>1 dB {np.mean(gr < -1) * 100:.2f}%, >3 dB {np.mean(gr < -3) * 100:.2f}%')
# 内部的咔：单独加回去，峰值放在 −2.2 dBFS
for ch in range(2): BIG[:, ch] = hp(BIG[:, ch], 38, 4)
BIG *= db(BIG_PK) / (np.abs(BIG).max() + 1e-12)
mix = body + BIG
w0, w1 = int(13.99 * SR), int(14.6 * SR)
BIG *= db(BIG_PK) / np.abs(mix[w0:w1]).max(); mix = body + BIG
# 静默核对：13.25–13.95 的 RMS 必须 ≤ −42 dBFS（成片 ≤ −40），否则把这一段底噪整体再压
def rms_db(a, b): return 20 * np.log10(np.sqrt(np.mean(mix[int(a * SR):int(b * SR)] ** 2)) + 1e-12)
if rms_db(13.25, 13.95) > -42:
    k = db(-42 - rms_db(13.25, 13.95)); i0, i1 = int(13.02 * SR), int(13.995 * SR); env = np.ones(len(mix), np.float32)
    env[i0:i1] = k; ramp = int(.02 * SR); env[i0 - ramp:i0] = np.linspace(1, k, ramp); env[i1:i1 + ramp] = np.linspace(k, 1, ramp)
    mix *= env[:, None]
mix *= db(TARGET - lufs(mix))
for nm, a, b in [('stab 12.5', 12.45, 12.9), ('inner ka 14.0', 13.99, 14.6), ('tooth 15.0', 14.99, 15.4), ('tooth 16.0', 15.99, 16.4), ('ka 18.5', 18.45, 18.9), ('da 19.0', 18.95, 19.4), ('ka 1.5', 1.45, 1.9), ('da 2.0', 1.95, 2.4)]:
    seg_ = mix[int(a * SR):int(b * SR)]; print(f'  peak {nm:14s} {20 * np.log10(np.abs(seg_).max() + 1e-12):6.1f} dBFS')
print(f'master: {lufs(mix):.2f} LUFS  true peak {tpk(mix):.2f} dBTP  silence 13.25–13.95 rms {rms_db(13.25, 13.95):.1f} dBFS  max outside 14.0 window {20 * np.log10(max(np.abs(mix[:w0]).max(), np.abs(mix[w1:]).max())):.1f} dBFS')
os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
for nm, x in [('music', mus), ('foley', fol), ('amb', amb), ('inner_ka', BIG)]: sf.write(os.path.join(HERE, f'out/stems/{nm}.wav'), x.astype(np.float32), SR, subtype='PCM_24')
json.dump({'bpm': TL['BPM'], 'cues': sorted(CUES)}, open(os.path.join(HERE, 'out/score.json'), 'w'), ensure_ascii=False, indent=1)
# 频段能量：20–60 Hz / 20–120 Hz 相对全频
from scipy.signal import welch
f, P = welch(mix.mean(1), SR, nperseg=8192); tot = P.sum()
def band(a, b): return 10 * np.log10(P[(f >= a) & (f < b)].sum() / tot)
loud = [(round(i / 10, 1), round(20 * np.log10(rms(mix[i * SR // 10:(i + 1) * SR // 10]) + 1e-9), 1)) for i in range(int(DUR * 10))]
top = sorted(loud, key=lambda x: -x[1])[:6]
print(f'mix.wav {len(mix) / SR:.2f}s  peak {np.abs(mix).max():.2f}  sub20-60 {band(20, 60):.1f} dB  low20-120 {band(20, 120):.1f} dB')
print('silence 13.1–13.9 rms dB:', round(20 * np.log10(rms(mix[int(13.1 * SR):int(13.9 * SR)])), 1), ' 14.0–14.3:', round(20 * np.log10(rms(mix[int(14.0 * SR):int(14.3 * SR)])), 1))
print('loudest 0.1s windows:', top)
print(S.credits(sorted({e[1] for e in ev} | {'woodblock', 'claves'})))
