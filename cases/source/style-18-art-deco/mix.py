"""《落成之夜》混音：配乐 out/score.wav + 由 events.json（window.EV）驱动的逐帧拟音 + 环境床 → out/mix.wav
运行：$LIB/.venv/bin/python mix.py（先 node core/render/events.mjs <工程> 与 music/score.py）"""
import sys, os, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio.sfx import SR, add, bp, lp, hp, t_, env_exp, norm, brown, thump, whoosh, limit, compress
from scipy.signal import butter, sosfilt

rng = np.random.default_rng(1929)
def noise(d): return rng.standard_normal(int(round(d * SR)))
EV = json.load(open(os.path.join(HERE, 'events.json'))); DUR = EV['dur']; ev = EV['ev']
TL = json.load(open(os.path.join(HERE, 'timeline.json'))); B = TL['B']; bt = lambda b: b * B
N = int(round((DUR + .05) * SR))
st = lambda: np.zeros((N, 2), np.float32)
fx, bed = st(), st()

# ---------------- 材质拟音 ----------------
def metal(f0=2400, d=.35, v=1.0, tau=.08):
    tt = t_(d); parts = [(1, 1), (2.76, .5), (5.4, .3), (8.9, .15)]
    x = sum(a * np.sin(2 * np.pi * f0 * r * tt + rng.random() * 6) * env_exp(d, tau / (r ** .5)) for r, a in parts)
    return norm(x + hp(noise(d), 3000) * env_exp(d, .004) * .6) * v
def wood(f=180, v=1.0, d=.25):
    tt = t_(d); return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .03) + bp(noise(d), 400, 2200) * env_exp(d, .012) * .8) * v
def switch(v=1.0):          # 刀闸“咔嚓”+ 灯丝嗡
    d = .7; tt = t_(d); x = wood(240, 1, d) * .6 + metal(1500, d, .5, .05)
    fil = (np.sin(2 * np.pi * 60 * tt) + .4 * np.sin(2 * np.pi * 180 * tt)) * np.minimum(1, tt / .08) * np.exp(-tt / .45) * .35
    return norm(x + fil) * v
def relay(v=1.0, f=3200):   # 继电器 tick
    d = .05; tt = t_(d); return norm(hp(noise(d), 2500) * env_exp(d, .003) + np.sin(2 * np.pi * f * tt) * env_exp(d, .006) * .4) * v
def bulbchunk(v=1.0):       # 灯泡点亮：低沉的“咚”+ 灯丝
    d = .35; tt = t_(d); return norm(np.sin(2 * np.pi * 95 * tt) * env_exp(d, .05) + (np.sin(2 * np.pi * 120 * tt) * .5 + lp(noise(d), 600) * .3) * np.exp(-tt / .15) * np.minimum(1, tt / .02)) * v
def clang(v=1.0, f=420):    # 青铜门闩 + 链条
    d = .9; x = metal(f, d, 1, .25) + metal(f * 1.47, d, .5, .18)
    ch = np.zeros(int(d * SR))
    for i in range(7): s0 = int((.03 + i * .045 + rng.random() * .02) * SR); c = metal(2600 + rng.random() * 1500, .05, .4 * (1 - i / 8), .01); ch[s0:s0 + len(c)] += c[:len(ch) - s0]
    return norm(x + ch * .8 + lp(noise(d), 300) * env_exp(d, .03) * .5) * v
def spring(v=1.0):          # 门到底：弹簧“嘣”+ 木门撞止
    d = .6; tt = t_(d); f = 210 * (1 + .25 * np.exp(-tt / .05))
    tw = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .16) * (1 + .5 * np.sin(2 * np.pi * 28 * tt))
    return norm(tw * .6 + wood(130, 1, d)) * v
def doorswing(d=.85, v=1.0):  # 双门对开：门轴摩擦 + 气流
    tt = t_(d); fr = 90 + 60 * tt / d
    cr = bp(2 * ((np.cumsum(fr) / SR) % 1) - 1, 300, 2400) * (np.abs(np.sin(2 * np.pi * 17 * tt)) ** 4)
    return norm(cr * .5 * np.sin(np.pi * tt / d) + whoosh(d, 1) * .8) * v
def scribe(b0, b1, v=.3):   # 金线刻划：随线速变化的金属嘶声
    d = bt(b1 - b0); tt = t_(d); u = np.clip(tt / d, 0, 1); speed = 2.1 * np.maximum(u, 1e-3) ** 1.1
    x = bp(noise(d), 3500, 9000) * (.2 + speed) / 2.3
    ring = np.sin(2 * np.pi * (1800 + 2600 * u ** 2.1) * tt) * .08 * speed
    return (x + ring) * np.minimum(1, tt / .05) * v
def crackle(d=1.2, v=1.0, dens=60):
    out = np.zeros(int(d * SR)); n = int(dens * d)
    for _ in range(n):
        s0 = int(rng.random() ** 1.6 * (d - .03) * SR); c = hp(noise(.012), 2500) * env_exp(.012, .002) * (.3 + rng.random()); out[s0:s0 + len(c)] += c
    return out * np.exp(-t_(d) / (d * .5)) * v
def boom(v=1.0, big=False):  # 烟花爆：低频 + 爆裂 + 噼啪尾
    d = 2.6 if big else 1.8; tt = t_(d); out = np.zeros(int(d * SR))
    sub = np.sin(2 * np.pi * (52 if big else 64) * tt * (1 - .2 * tt)) * env_exp(d, .35 if big else .22)
    blast = lp(noise(d), 1800) * env_exp(d, .07) + bp(noise(d), 200, 900) * env_exp(d, .2) * .5
    out += norm(sub * 1.1 + blast) + crackle(d, .5, 90 if big else 50) * 1.2
    return norm(out) * v
def whistle(d, v=1.0):     # 火箭哨音上扬
    tt = t_(d); f = 700 + 2100 * (tt / d) ** 1.4 + 18 * np.sin(2 * np.pi * 9 * tt)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .6 + bp(noise(d), 1500, 5000) * .15
    return x * np.minimum(1, tt / .15) * np.minimum(1, (d - tt) / .04) * (.4 + .6 * tt / d) * v
def fuse(d, v=1.0):
    tt = t_(d); return (hp(noise(d), 2500) * .3 + crackle(d, .6, 120)) * np.minimum(1, tt / .1) * v
def bell(v=1.0):           # 电梯铃：E♭6 + B♭5 两个音
    d = 2.0; tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(1244.5, 1, .7), (932.3, .7, .8), (2489, .35, .3), (3734, .15, .15), (1864.7, .2, .4)])
    return norm(x * np.minimum(1, tt / .002)) * v
def shimmer(d=1.3, v=1.0):  # 光泽：玻璃般的上行闪光
    tt = t_(d); out = np.zeros(len(tt))
    for k in range(14):
        t0 = k / 14 * d * .8; f = 2200 * 2 ** (k / 7); s0 = int(t0 * SR); dd = d - t0
        y = np.sin(2 * np.pi * f * t_(dd)) * env_exp(dd, .25) * .3; m = min(len(y), len(out) - s0); out[s0:s0 + m] += y[:m]
    return norm(out) * v
def clunk(v=1.0):          # 万花筒咬合：铁件 + 棘轮
    d = .8; tt = t_(d); x = np.sin(2 * np.pi * 66 * tt) * env_exp(d, .12) + lp(noise(d), 900) * env_exp(d, .03) + metal(620, d, .7, .2) + metal(1240, d, .4, .12)
    r = np.zeros(len(x))
    for i in range(6): s0 = int(i * .016 * SR); r[s0:s0 + 300] += hp(noise(300 / SR), 2000) * .5
    return norm(x + r * .5) * v
def wind(d, v=1.0, lo=150, hi=900):
    b = bp(brown(d) + noise(d) * .15, lo, hi); g = 1 + .5 * np.sin(2 * np.pi * t_(d) * .23 + 1) * np.sin(2 * np.pi * t_(d) * .41)
    return norm(b * g) * v
def crowd(d, v=1.0):
    out = np.zeros(int(round(d * SR)))
    for k in range(10):
        f = 300 + rng.random() * 700; n = bp(noise(d), f, f * 2.2); out += n * np.clip(lp(np.abs(noise(d)), 4) * 6, 0, 1)
    return norm(out) * v
def fade(x, a=.05, b=.2):
    n = len(x); e = np.ones(n); ia, ib = int(a * SR), int(b * SR)
    if ia: e[:ia] = np.linspace(0, 1, ia)
    if ib: e[-ib:] = np.linspace(1, 0, ib)
    return x * e

# ---------------- 事件 → 拟音（每个可见动作一声） ----------------
for e in ev:
    t, ty = e['t'], e['type']
    if ty == 'ignite': add(fx, switch(.7), t, 1, 0); add(fx, crackle(.6, .4, 40), t, .8, 0)
    elif ty == 'scribe': add(fx, scribe(e['b'], e['b1'], .5), t, .35, .05)
    elif ty == 'unfold': w = whoosh(.6, 1); add(fx, w, t, .45, -.6); add(fx, w, t, .45, .6); add(fx, metal(1900, .4, .5, .06), t, .6, 0)
    elif ty == 'switch': add(fx, switch(.6), t, .7, -.3); add(fx, switch(.6), t + .01, .7, .3)
    elif ty == 'stamp': add(fx, metal(820 + 140 * e['i'], .45, .9, .09), t, .55, 0); add(fx, thump(.7, 75), t, .5, 0)
    elif ty == 'ray':
        for k in range(3): add(fx, relay(.6, 3600 + 300 * e['i']), t + k * .022, .45, (-.4 if k % 2 else .4))
    elif ty == 'crane': d = bt(e['b1'] - e['b']); add(fx, fade(whoosh(d, 1), .2, .1), t, .5, 0); add(fx, fade(wind(d, 1, 300, 2500), .3, .1), t, .25, 0)
    elif ty == 'cut': add(fx, whoosh(.35, 1), t - .12, .35, 0); add(fx, relay(.8, 2600), t, .6, 0)
    elif ty == 'floor':
        k = e['i']; add(fx, relay(.9, 2800 + 90 * k), t, .7, -.2 + .04 * k); add(fx, bulbchunk(.8), t, .55, .1)
    elif ty == 'ding': add(fx, bell(1), t, .8, .1)
    elif ty == 'pull': d = bt(e['b1'] - e['b']); add(fx, fade(whoosh(d, 1), .1, .2), t, .3, 0)
    elif ty == 'latch': add(fx, clang(1, 380 + 60 * e['i']), t, 1.0 + .3 * e['i'], 0)
    elif ty == 'doors': add(fx, doorswing(.84, 1), t, .8, -.5); add(fx, doorswing(.84, 1), t + .015, .8, .5)
    elif ty == 'dolly': d = bt(e['b1'] - e['b']); add(fx, fade(whoosh(d, 1), .3, .4), t, .3, 0)
    elif ty == 'doorstop': add(fx, spring(1), t, .55, -.5); add(fx, spring(1), t + .02, .55, .5)
    elif ty == 'fuse': add(fx, fade(fuse(bt(TL['HIT']['rocket']) - t + .2, 1), .05, .1), t, .14, 0)
    elif ty == 'rocket': d = bt(e['b1'] - e['b']) - .03; add(fx, whistle(d, 1), t, .2, 0); add(fx, thump(.6, 90), t, .25, 0)
    elif ty == 'burst': add(fx, boom(1, e['i'] == 0), t, [2.6, 1.3, 1.5][e['i']], [0, -.25, .25][e['i']])
    elif ty == 'spark': add(fx, crackle(.35, .8, 70), t, .5, (-.5 if e['i'] % 2 else .5)); add(fx, relay(.7, 3000), t, .5, 0)
    elif ty == 'lock': add(fx, clunk(1), t, 1.3, 0)
    elif ty == 'plaque': add(fx, whoosh(.5, 1), t + .05, .2, 0)
    elif ty == 'sheen': add(fx, shimmer(1.4, 1), t, .3, 0)
    elif ty == 'final': add(fx, switch(1), t, 1.0, 0); add(fx, bulbchunk(1), t, .9, 0)
    elif ty == 'chase':
        for k in range(16): add(fx, relay(.4 * (1 - k / 18), 3400), t + k / 18, .4, np.sin(k) * .6)

# ---------------- 环境床 ----------------
def place(x, t0, g, pan=0): add(bed, x, t0, g, pan)
place(fade(lp(brown(bt(10) + .3), 260), .3, .3), 0, .16)                              # A：城市夜气
tr = np.zeros(int(bt(10) * SR))
for k in range(3): s0 = int((.6 + k * 1.3) * SR); c = bp(noise(1.6), 500, 1600) * np.sin(np.pi * t_(1.6) / 1.6) ** 2; tr[s0:s0 + len(c)] += c[:len(tr) - s0] * .25
place(tr, 0, .12, .3)                                                                 # 远处车声
dB = bt(21) - bt(10); tt = t_(dB)
place(fade((np.sin(2 * np.pi * 58 * tt) * .5 + np.sin(2 * np.pi * 116 * tt) * .25 + lp(noise(dB), 300) * .3), .2, .3), bt(10), .14)   # B：电梯井低频
cw = crowd(bt(28) - bt(20.5), 1); cf = np.interp(t_(len(cw) / SR), [0, bt(24) - bt(20.5) - .05, bt(24) - bt(20.5) + .05, len(cw) / SR], [0, 1, 1, 1])
cw_l = sosfilt(butter(4, 500, 'low', fs=SR, output='sos'), cw); mixc = np.where(t_(len(cw) / SR) < bt(24) - bt(20.5), cw_l, cw * .6)
place(fade(mixc * cf, .4, .5), bt(20.5), .22)                                          # C：门后人声（门开后变清）
place(fade(wind(bt(46) - bt(25), 1), .8, .6), bt(25), .2)                              # D/E：天台风
bed2 = st(); add(bed2, fade(wind(bt(32) - bt(27.5), 1, 200, 1400), .3, .05), bt(27.5), .035)   # D：屏息时风是主角（不受环境床总衰减）
cheer = bp(crowd(3.5, 1), 300, 3000) * np.exp(-t_(3.5) / 1.6) * np.minimum(1, t_(3.5) / .4)
place(cheer, bt(32) + .25, .12)                                                       # 远处城市的欢呼（极轻）

# ---------------- 总混 ----------------
mus, _ = sf.read(os.path.join(HERE, 'out/score.wav')); mus = mus[:N] if len(mus) >= N else np.pad(mus, ((0, N - len(mus)), (0, 0)))
mus = mus.astype(np.float32) * .9
# 静默段（b27.5–b32）音乐为零；关键拟音处让一让音乐（−3 dB）
duck = np.ones(N)
for e in ev:
    if e['type'] in ('latch', 'ding', 'lock'):
        s0 = int(e['t'] * SR); n = int(.25 * SR); duck[s0:s0 + n] = np.minimum(duck[s0:s0 + n], .72)
duck = np.convolve(duck, np.ones(480) / 480, 'same')
out = mus * duck[:, None] + fx * .3 + bed * .22 + bed2
# 段落总线：开门全奏（b24–b27）让出约 3 dB，烟花段（b32 之后）抬 1 dB，让高潮整体明显比开门段更大
sec = np.interp(np.arange(N) / SR, [0, bt(23.9), bt(24) - .004, bt(27.6), bt(27.9), bt(32.4), bt(32.8), DUR + 1], [1, 1, .71, .71, 1, 1, 1.12, 1.12])
out = out * sec[:, None]
for c in range(2): out[:, c] = compress(out[:, c], .6, 1.8, .005, .12)
pk = np.abs(out).max(); out = out / pk * .8
for c in range(2): out[:, c] = limit(out[:, c], .8 * 10 ** (-6 / 20))   # 削掉最尖的 6 dB 瞬态：峰值因子 ≤ 约 12.5 dB，−14 LUFS 时真峰才压得住 −1.2 dBTP
out = out / np.abs(out).max() * .8
for c in range(2): out[:, c] = limit(out[:, c], .9)
def tp_limit(x, ceil_db=-2.5, os=4, look=.004):   # 4 倍过采样估真峰，按真峰压，给 AAC 编码的过冲留余量
    from scipy.signal import resample_poly
    from scipy.ndimage import maximum_filter1d, uniform_filter1d, minimum_filter1d
    tp = np.abs(resample_poly(x, os, 1))[:len(x) * os].reshape(-1, os).max(1)
    n = int(look * SR); m = maximum_filter1d(tp, 2 * n + 1)
    g = np.minimum(1, 10 ** (ceil_db / 20) / np.maximum(m, 1e-9)); g = minimum_filter1d(uniform_filter1d(g, n), n)
    return x * g
for c in range(2): out[:, c] = tp_limit(out[:, c])
end = int(DUR * SR); out = out[:end]; out[-int(.25 * SR):] *= np.linspace(1, 0, int(.25 * SR))[:, None]
np.save(os.path.join(HERE, "out/layers.npy"), np.stack([mus[:end].mean(1), fx[:end].mean(1) * .3, (bed[:end] * .22 + bed2[:end]).mean(1)])); sf.write(os.path.join(HERE, 'out/mix.wav'), out.astype(np.float32), SR)
print('mix', round(len(out) / SR, 3), 's · events', len(ev))
