"""mix.py — 《Lumen》原创配乐 + 拟音 + 环境 → out/mix.wav（以及 out/score.json 供核对）
配乐：D 利底亚，90 BPM。合成 pad / sub / 正弦脉冲 / glitch（numpy）+ 颤音琴、马林巴、钟琴、沙锤、大鼓（VCSL 采样）+ 拨弦（pluck.py harp 物理模型）。
产品的声音是一家人：所有点亮音同一调式、居中；定格 13.333–14.667 s 所有轨道数字归零，之后第一声是全片最重的 "3" 落定。
用法：$LIB/.venv/bin/python mix.py   （LIB 环境变量或默认 @@LEMO_ROOT@@）
"""
import os, sys, json, numpy as np, soundfile as sf
D = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, add, limit
from core.audio import sampler as S, pluck as P

TL = json.load(open(os.path.join(D, 'timeline.json'))); K = TL['K']; B = TL['beat']; BAR = TL['bar']; DUR = TL['dur']
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
bt = lambda b: b * B
N = int(round(DUR * SR))
mus = np.zeros((N, 2)); low = np.zeros((N, 2)); fol = np.zeros((N, 2)); amb = np.zeros((N, 2))
rng = np.random.default_rng(90); S.seed(90)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
placed = {}          # 关键声音实际落下的采样位置 → 核对用
def mark(k, t): placed.setdefault(k, []).append(round(int(t * SR) / SR, 6))

def sine(f, d, tau, ph=0.0): return np.sin(2 * np.pi * f * t_(d) + ph) * env_exp(d, tau)
def breath(t, t0): return .5 + .5 * np.cos(2 * np.pi * (t - t0) / BAR)

# ───────────────────────── 合成音色 ─────────────────────────
def pad_note(m, d, att=.5, rel=.8, bright=1.0):
    """detuned 锯齿 ×3 → 低通；+ 正弦基音。音符低于 MIDI 48 不用"""
    tt = t_(d + rel); f = hz(m); x = np.zeros_like(tt)
    for c in (-7, 0, 6):
        ph = rng.random(); x += 2 * ((tt * f * 2 ** (c / 1200) + ph) % 1) - 1
    x = lp(x, 900 + 900 * bright, 2) * .35 + np.sin(2 * np.pi * f * tt) * .5
    e = np.minimum(1, tt / att) * np.where(tt < d, 1, np.exp(-(tt - d) / (rel / 4)))
    return (x * e).astype(np.float32)

def sub_drop(f0, f1, d, tau, drive=1.5):
    """sub 冲击：频率下坠的正弦 + 2、3 次谐波（小喇叭也听得见）"""
    tt = t_(d); f = f1 + (f0 - f1) * np.exp(-tt / .18); ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) + .35 * np.sin(2 * ph) + .18 * np.sin(3 * ph)
    return norm(np.tanh(x * drive) * env_exp(d, tau))

def pulse(m=38, v=1.0):  # 低频正弦脉冲（D2）
    d = .32; return norm(sine(hz(m), d, .07) + .4 * sine(hz(m) * 2, d, .04) + .15 * sine(hz(m) * 3, d, .03)) * v

def glitch(v=1.0, d=.09):
    tt = t_(d); f = 600 + 2400 * rng.random()
    sq = np.sign(np.sin(2 * np.pi * f * tt)); crush = np.repeat(np.round(noise(d)[::10] * 2) / 2, 10)[:len(tt)]
    gate = (np.floor(tt * 90) % 2 == 0)
    return norm((sq * .4 + bp(crush, 1500, 9000)) * gate * env_exp(d, .03)) * v

def riser(d, lo=400, hi=7000):
    n = noise(d); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        u = i / L; f = lo * (hi / lo) ** u; w = min(480, L - i)
        out[i:i + w] = bp(n[max(0, i - 1500):i + w], f * .8, min(f * 1.25, SR / 2 - 100))[-w:]
    return norm(out * (t_(d) / d) ** 2.2)

# ───────────────────────── 拟音音色（产品一家：毡、玻璃、光） ─────────────────────────
def felt(v=1.0, f=330):
    d = .1; return norm(sine(f, d, .016) + lp(noise(d), 1500) * env_exp(d, .006) * .6 + sine(f * 2.01, d, .01) * .3) * v
def glass(m, v=1.0, d=.9):
    f = hz(m); x = sine(f, d, d * .35) + sine(2 * f, d, d * .17) * .3 + sine(2.76 * f, d, d * .09) * .2 + hp(noise(d), 6000) * env_exp(d, .002) * .25
    return norm(x) * v
def tick(v=1.0, f=4200):
    d = .025; return norm(hp(noise(d), 3000) * env_exp(d, .0018) + sine(f, d, .003) * .5) * v
def shimmer(d, v=1.0, lo=4000, hi=10000):
    """光扫：高频带噪 + 利底亚高音泛音的微光"""
    tt = t_(d); x = bp(noise(d), lo, hi) * .6
    for m in (98, 102, 105, 109):
        x += np.sin(2 * np.pi * hz(m) * tt + rng.random() * 6) * .05 * (1 + np.sin(2 * np.pi * (3 + rng.random() * 4) * tt))
    e = np.minimum(1, tt / .25) * np.minimum(1, (d - tt) / .35).clip(0)
    return norm(x * e) * v
def whoosh(d=.33, v=1.0):
    n = noise(d); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        u = i / L; f = 500 * (4500 / 500) ** u; w = min(480, L - i)
        out[i:i + w] = bp(n[max(0, i - 1500):i + w], f * .7, min(f * 1.4, SR / 2 - 100))[-w:]
    return norm(out * np.sin(np.pi * t_(d) / d) ** 1.4) * v
def thump(v=1.0, f=62):
    d = .35; tt = t_(d); return norm(np.sin(2 * np.pi * f * tt * (1 - .25 * tt)) * env_exp(d, .07) + lp(noise(d), 300) * env_exp(d, .015) * .5) * v
def crt_off(v=1.0, d=.42):
    tt = t_(d); f = 200 + 3200 * np.exp(-tt / .07); x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .12)
    x += hp(noise(d), 5000) * env_exp(d, .004) * .6
    return norm(x) * v
def grains(v=1.0, n=7, span=.15):
    d = span + .03; out = np.zeros(int(d * SR))
    for k in range(n):
        s = int(rng.random() * span * SR); gd = .006 + rng.random() * .01; g = bp(noise(gd), 2500 + 5000 * rng.random(), 11000) * np.hanning(int(round(gd * SR)))
        out[s:s + len(g)] += g * (.4 + rng.random() * .6)
    return norm(out) * v
def zip_down(v=1.0, d=.16):
    tt = t_(d); f = 2600 * np.exp(-tt / .05) + 300; return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .05)) * v
def pop_up(v=1.0, d=.22):
    tt = t_(d); f = 220 + 700 * (1 - np.exp(-tt / .04)); return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .07)) * v

# ───────────────────────── 配乐 ─────────────────────────
used = set()
def put(buf, x, t, g=1.0, pan=0.0): add(buf, x, t, g, pan)
def samp(buf, inst, pitch, dur, vel, t, g=1.0, pan=0.0, **kw):
    used.add(inst); add(buf, S.note(inst, pitch, dur, vel, **kw), t, g, pan)

# Pad：b4 空五度进（J-cut 跟圆闭合）；加法：b8 加 E4，b10 加 F#4，b15 加 C#5，b18 加 G#4 → b20 定格硬切；b22 全和弦；b26 解决到 D 大
PADS = [(50, 4, 20, .5), (57, 4, 20, .42), (64, 8, 20, .26), (66, 10, 20, .24), (73, 15, 20, .17), (68, 18, 20, .2),
        (50, 22, 26.4, .55), (57, 22, 26.4, .45), (64, 22, 26.4, .3), (66, 22, 26.4, .28), (68, 22, 26.4, .22), (73, 22, 26.4, .2),
        (50, 26, 31, .5), (57, 26, 31, .42), (66, 26, 31, .3), (69, 26, 31, .26), (74, 26, 31, .14)]
for m, b0, b1, v in PADS:
    t0, t1 = bt(b0), min(bt(b1), DUR); att = .9 if b0 in (4, 26) else (.02 if b0 == 22 else .6)
    x = pad_note(m, t1 - t0, att=att, rel=.9 if b1 < 30 else 1.5)
    tt = t0 + t_(len(x) / SR); x = x * (.78 + .22 * breath(tt, K['lit'] if b0 < 22 else K['hit']))
    if b0 >= 26: x = x * np.exp(-np.maximum(0, tt - bt(28)) / 1.1)          # 片尾呼吸着淡下去
    put(mus, x * v * .5, t0, 1, (m - 62) / 40)

# Sub / 低频冲击
put(low, sub_drop(48, 36.7, 1.6, .45, 1.2), K['pulse0'], .55); mark('pulse0', K['pulse0'])
put(low, sub_drop(44, 36.7, .9, .25, 1.0), K['traceEnd'], .35)
put(low, sub_drop(55, 36.7, 2.2, .6, 1.6), K['lit'], .8); mark('lit', K['lit'])
put(low, sub_drop(60, 36.7, 1.4, .35, 1.6), K['snap'], .38); mark('snap', K['snap'])
put(low, sub_drop(72, 29.1, 3.6, .9, 2.4), K['hit'], 2.3); mark('hit', K['hit'])     # 全片最重
put(low, sub_drop(46, 36.7, 1.8, .5, 1.0), K['name'], .45); mark('name', K['name'])
# 正弦脉冲：b8–b20 四分；b22–b26 半拍速（减速）
for b in np.arange(8, 20, 1.0): put(low, pulse(38, .5 + .25 * ((b - 8) / 12)), bt(b), .5)
for b in np.arange(23, 26.1, 2.0): put(low, pulse(38, .5), bt(b), .45)

# 点阵音符（颤音琴 → 马林巴 → 钟琴）：每个音符点亮一批点
for n in TL['notes']:
    inst = n['inst']; vel = {'vibraphone': .62, 'marimba': .6, 'glockenspiel': .42}[inst]
    dur = {'vibraphone': 1.4, 'marimba': .5, 'glockenspiel': .6}[inst]
    samp(mus, inst, n['midi'], dur, vel, n['t'], g={'vibraphone': .55, 'marimba': .5, 'glockenspiel': .32}[inst], pan=((n['midi'] % 5) - 2) * .04)
    mark('dot', n['t'])
# 弓奏颤音琴：b8 Lumen 亮起的和弦（L-cut 进累积段）
for m, v in ((57, .5), (64, .45), (66, .4), (73, .35)): samp(mus, 'vibraphone_bowed', m, BAR * 1.4, v, K['lit'], .32, (m - 64) / 30, attack=.04)
# 沙锤：b12 起十六分（加速段），b15–b18 继续
for b in np.arange(12, 18, .25):
    used.add('shaker'); put(mus, S.hit('shaker', 'down' if (b * 4) % 2 == 0 else 'up', .35 + .2 * ((b * 4) % 4 == 0)), bt(b), .2, .25)
# 三十二分 glitch 碎片（加速顶点）
for b in np.arange(13.5, 14.5, .125):
    if rng.random() < .55: put(mus, glitch(.5), bt(b) + B / 16, .12, rng.uniform(-.5, .5))
put(mus, riser(bt(14.5) - bt(12.5)), bt(12.5), .14)
# 落格：钟琴 D6+A6 + 拨弦琶音
for m in (86, 93): samp(mus, 'glockenspiel', m, 1.6, .5, K['snap'], .38)
used.add('pluck:harp')
for i, m in enumerate((62, 69, 76, 78, 85)): put(mus, P.pluck('harp', m, 2.2, .55), K['snap'] + i * B / 4, .3, -.3 + i * .15)
# 吸附段 ostinato：马林巴八分
OST = [62, 69, 76, 69, 78, 69, 76, 73]
for k, b in enumerate(np.arange(15.5, 18, .5)): samp(mus, 'marimba', OST[k % 8], .4, .48, bt(b), .32, (-.2, .2)[k % 2])
for b, m in ((16, 81), (17, 78)): put(mus, P.pluck('harp', m, 1.6, .45), bt(b), .25, .2)
# 噪声段 riser（b18→b20，在定格那一刻被切断）
put(mus, riser(bt(20) - bt(18), 300, 9000), bt(18), .22)
for b in (18, 18.5, 19.75): put(mus, glitch(.6, .07), bt(b), .14, rng.uniform(-.4, .4))
# "3" 落定：大鼓 + 毡槌低音 + 全和弦 + 钟琴 + 玻璃
used.update(['gran_cassa'])
put(mus, S.hit('gran_cassa', 'hit', 1.0), K['hit'], 1.2)
samp(mus, 'marimba', 38, 1.5, .9, K['hit'], .6)
samp(mus, 'vibraphone', 50, 3.0, .85, K['hit'], .5)
for m, v in ((57, .6), (64, .55), (66, .5), (68, .45), (73, .45)): samp(mus, 'vibraphone_bowed', m, BAR * 1.2, v, K['hit'], .3, (m - 64) / 25, attack=.01)
samp(mus, 'glockenspiel', 86, 2.2, .6, K['hit'], .38)
put(mus, glass(98, 1, 2.0), K['hit'], .12)
# 收尾：名字 —— 弓奏和弦 + 拨弦 + 钟琴回应
for m, v in ((62, .45), (66, .42), (69, .4), (74, .32)): samp(mus, 'vibraphone_bowed', m, 2.2, v, K['name'], .3, (m - 66) / 25, attack=.05)
for i, m in enumerate((62, 66, 69, 74)): put(mus, P.pluck('harp', m, 2.5, .5), K['name'] + i * B / 4, .3, -.2 + i * .13)
samp(mus, 'glockenspiel', 93, 2.0, .42, K['glk1'], .3, .1); mark('close2', K['glk1'])
samp(mus, 'glockenspiel', 90, 2.0, .36, K['glk2'], .26, -.1)
samp(mus, 'vibraphone', 74, 1.5, .45, K['glk2'], .3)

# ───────────────────────── 拟音（全部由 events.json 驱动） ─────────────────────────
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'trace':
        x = shimmer(e['dur'] + .2, 1, 4500, 9000); put(fol, x, t - .1, .1, .2); mark('trace', t)
    elif ty == 'close': put(fol, glass(86, 1, 1.4), t, .3); put(fol, felt(.5, 290), t, .2); mark('close', t)
    elif ty == 'reveal': put(fol, shimmer(e['dur'] + .5, 1, 3000, 8000), t - .4, .13, -.2); put(fol, whoosh(e['dur'], .5), t, .12, .3); mark('reveal', t)   # J：光声先到
    elif ty == 'lit': put(fol, glass(93, 1, 1.6), t, .2); put(fol, felt(1, 220), t, .3)
    elif ty == 'dot':
        k = min(6, 1 + e['n'] // 10)
        put(fol, felt(.6, 300 + 40 * (e['midi'] % 4)), t, .11)
        if e['n'] > 3: put(fol, grains(.6, k, min(.12, e['div'] * B * .8)), t, .05 + .01 * k, rng.uniform(-.3, .3))
    elif ty == 'gridtick': put(fol, tick(.8, 3600 + 300 * e['i']), t, .16, (e['i'] - 1.5) * .3); mark('gridtick', t)
    elif ty == 'whip': put(fol, whoosh(e['dur'] + .05, 1), t, .38, -.2); mark('whip', t)
    elif ty == 'snap': put(fol, thump(1, 70), t, .16, e['pan']); put(fol, felt(1, 260), t, .16, e['pan']); put(fol, tick(.7), t, .1, e['pan']); mark('snap_' + e['view'], t)
    elif ty == 'crt':
        for p, dl in ((-.45, 0), (.25, .02), (.55, .04)): put(fol, crt_off(1), t + dl, .17, p)
        mark('crt', t)
    elif ty == 'burst': put(fol, grains(1, 14, .2), t, .3); put(fol, pop_up(.8, .16), t, .14); mark('burst', t)
    elif ty == 'grain': put(fol, grains(.8, 6, .12), t, .14, rng.uniform(-.25, .25))
    elif ty == 'lock':
        m = {'W': 81, '0': 86, '.': 78}[e['ch']]; put(fol, felt(1, 340), t, .26); put(fol, glass(m, 1, .5), t, .12); mark('lock_' + e['ch'], t)
    elif ty == 'hit': put(fol, felt(1, 180), t, .5); put(fol, shimmer(1.6, 1, 4000, 9000), t, .045); mark('hit_fol', t)
    elif ty == 'put': put(fol, zip_down(1), t, .14, (e['i'] - 1.5) * -.25); put(fol, felt(.8, 360 - 20 * e['i']), t, .16); mark('put', t)
    elif ty == 'name': put(fol, pop_up(1), t, .18)
    elif ty == 'trace2': put(fol, shimmer(e['dur'] + .3, 1, 4500, 9000), t, .08, -.1)
    elif ty == 'label': put(fol, tick(.6, 3000), t, .12); put(fol, felt(.6, 420), t, .1); mark('label', t)
    elif ty == 'close2': put(fol, glass(86, 1, 1.4), t, .22)

# ───────────────────────── 环境：安静房间 + 很低的风扇 ─────────────────────────
room = lp(brown(DUR), 280) * .5 + bp(noise(DUR), 120, 900) * .05
tt = np.arange(N) / SR; room = room[:N] * (.6 + .4 * np.minimum(1, tt / 2.0))
amb[:, 0] += room * .9; amb[:, 1] += np.roll(room, 997) * .9

# ───────────────────────── 混音 ─────────────────────────
mus = S.room(mus, size=.55, mix=.2)
mix = mus * 1.0 + low * .36 + fol * .9 + amb * .006
# 定格：所有轨道数字归零（3 ms 斜坡防爆音），落定那一拍从零起
f0, f1 = int(K['freeze'] * SR), int(K['hit'] * SR); ramp = int(.003 * SR)
mix[f0 - ramp:f0] *= np.linspace(1, 0, ramp)[:, None]; mix[f0:f1] = 0
pk = np.abs(mix).max(); mix = mix / pk * .9
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
mix[f0:f1] = 0
fo = int(.45 * SR); mix[-fo:] *= (np.cos(np.linspace(0, np.pi / 2, fo)) ** 2)[:, None]   # 片尾余音收住，不留硬切
os.makedirs(os.path.join(D, 'out'), exist_ok=True)
sf.write(os.path.join(D, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
json.dump({'keys': placed, 'notes': sorted(set(n['t'] for n in TL['notes'])), 'used': sorted(used)}, open(os.path.join(D, 'out', 'score.json'), 'w'), indent=1)
# 低频平衡：20–120 Hz 相对其余频段
from scipy.signal import welch
f, p = welch(mix.mean(1), SR, nperseg=8192)
lo = 10 * np.log10(p[(f >= 20) & (f < 120)].sum()); rest = 10 * np.log10(p[(f >= 120) & (f < 16000)].sum())
print('mix.wav', mix.shape, f'低频(20–120Hz) 相对其余 {lo - rest:+.1f} dB', '定格段最大值', float(np.abs(mix[f0:f1]).max()))
