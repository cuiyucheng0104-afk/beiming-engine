"""《三打白骨精》混音：仅音效——拟音（布 / 皮 / 竹 / 木 / 骨 / 纸）+ 舞台锣鼓击节（锣、镲、木鱼、板鼓、堂鼓，真采样）+ 环境（山风、妖气、灯芯、后台）
无配音、无旋律配乐。所有声音按 events.json 的时间点落在对应的帧上。
用法：LIB=<库路径> python mix.py   → mix.wav"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar')); sys.path.insert(0, LIB)
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, noise, norm, brown, creak, whoosh, compress, limit, add
from core.audio import sampler as S
from scipy.signal import fftconvolve
D = os.path.dirname(os.path.abspath(__file__))
EVJ = json.load(open(os.path.join(D, 'events.json'))); DUR = EVJ['dur']; ev = EVJ.get('events') or EVJ.get('ev') or EVJ.get('EV')
N = int(DUR * SR) + SR
fx = np.zeros((N, 2)); perc = np.zeros((N, 2)); amb = np.zeros((N, 2))
rng = np.random.default_rng(23); S.seed(11)
TT = {e['type']: e['t'] for e in ev}

def room_ir(d=.7, damp=3000):
    n = int(d * SR); e = np.exp(-np.arange(n) / SR / (d / 6.9)); ir = np.stack([lp(rng.standard_normal(n), damp) * e, lp(rng.standard_normal(n), damp) * e], 1)
    ir[0] = 1; return ir / np.abs(ir).sum(0) * 6
def verb(x, ir, mix=.25):
    y = np.stack([fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1); return x * (1 - mix) + y * mix
def warp(x, semis):
    """可变速重采样：semis(t) 半音曲线（锣的滑音）"""
    x = np.asarray(x, np.float64); n = len(x); t = np.arange(int(n * 1.6) + SR) / SR
    ph = np.concatenate([[0], np.cumsum(2 ** (semis(t) / 12.0))[:-1]]); ph = ph[ph < n - 1]; i = ph.astype(int); f = ph - i
    return (x[i] * (1 - f) + x[i + 1] * f)
def trim(x, d, fo=.06):
    n = int(d * SR); x = x[:n].copy() if len(x) > n else np.pad(x, (0, n - len(x))); m = int(fo * SR)
    if m: x[-m:] *= np.linspace(1, 0, m)
    return x

# ================= 锣鼓（真采样，只作击节音效）=================
def big_gong(v=.8, drop=-3.0): x = S.hit('gong2', 'big', v); y = warp(x, lambda t: drop * np.clip(t / .4, 0, 1) ** .7); return y + .22 * lp(y, 260)
def small_gong(v=.7, rise=1.6): return warp(S.hit('gong2', 'small', v), lambda t: rise * np.clip(t / .12, 0, 1))
def cymbal(v=.7, d=.9): return trim(S.hit('sus_cymbal', 'stick', v), d, .3)
def crash_c(v=.8, d=2.6): return trim(S.hit('crash', None, v), d, .8)
def bangu(v=.6): return trim(S.hit('woodblock', 'a', v), .25, .05)
def muyu(v=.6): return trim(S.hit('log_drum', 'hi', v), .35, .06)
def tanggu(v=.6, d=1.2):
    x = S.hit('frame_drum', 'large', v); y = S.hit('bass_drum', None, v * .7); n = max(len(x), len(y))
    return trim(np.pad(x, (0, n - len(x))) + .6 * np.pad(y, (0, n - len(y))), d, .3)
def heart(v=.6): x = trim(S.hit('frame_drum', 'large_muted', v), .5, .1); return x + .5 * np.pad(x, (int(.16 * SR), 0))[:len(x)] * .6

# ================= 拟音 =================
def woodclap(v=1.):       # 醒木
    d = .5; tt = t_(d); x = hp(noise(d), 900) * env_exp(d, .002) * 1.2
    x += sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * env_exp(d, tau) for f, a, tau in [(1150, .7, .03), (2350, .5, .018), (3500, .3, .01), (620, .4, .05)])
    return norm(x + np.sin(2 * np.pi * 140 * tt) * env_exp(d, .04) * .8) * v
def match_(v=1.):
    d = .5; tt = t_(d); am = lp((rng.random(len(tt)) > .7) * 1.0, 60)
    x = bp(noise(d), 1800, 6500) * am * np.minimum(1, tt / .03) * np.exp(-np.maximum(0, tt - .18) / .05)
    return norm(x + lp(noise(d), 1500) * np.sin(np.clip((tt - .15) / .35, 0, 1) * np.pi) * .6) * v
def fwoomp(v=1., d=.8, f=900):
    tt = t_(d); e = np.minimum(1, tt / .06) * np.exp(-tt / (d / 3)); return norm(lp(noise(d), f) * e + np.sin(2 * np.pi * 70 * tt) * e * .4) * v
def rodtap(v=1., f=1800):
    d = .12; tt = t_(d)
    x = hp(noise(d), 1500) * env_exp(d, .003) + sum(a * np.sin(2 * np.pi * ff * tt) * env_exp(d, tau) for ff, a, tau in [(f, .5, .01), (f * 1.78, .3, .006)]) + lp(noise(d), 500) * env_exp(d, .015) * .6
    return norm(x) * v
def flap(v=1., d=.18):
    tt = t_(d); return norm(bp(noise(d), 600, 5000) * np.sin(np.pi * tt / d) ** 2 * (1 + .6 * np.sin(2 * np.pi * 30 * tt))) * v
def press(v=1.):          # 皮影拍上布：皮片一翻 + 低沉的"噗"
    d = .3; tt = t_(d); return norm(np.pad(flap(1, .12), (0, len(tt) - len(t_(.12)))) * .7 + lp(noise(d), 220) * env_exp(d, .04) + np.sin(2 * np.pi * 85 * tt) * env_exp(d, .05) * .6) * v
def leather_step(v=1.):
    d = .07; tt = t_(d); return norm(bp(noise(d), 900, 4000) * env_exp(d, .006) + np.sin(2 * np.pi * 380 * tt) * env_exp(d, .01) * .5) * v
def thud(v=1., f=75, d=.35):
    tt = t_(d); return norm(lp(noise(d), 300) * env_exp(d, .03) + np.sin(2 * np.pi * f * tt * (1 - .3 * tt)) * env_exp(d, .07)) * v
def thwack(v=1.):
    d = .25; tt = t_(d); return norm(bp(noise(d), 300, 2500) * env_exp(d, .02) + np.sin(2 * np.pi * 160 * tt * (1 - tt)) * env_exp(d, .05)) * v
def swish(d=.3, v=1.):    # 棒风：比 whoosh 更尖、更快
    tt = t_(d); f = np.linspace(700, 3200, len(tt)); out = bp(noise(d), 500, 6000) * (np.sin(np.pi * tt / d) ** 3)
    return norm(out + .2 * hp(noise(d), 3000) * (tt / d) ** 4) * v
def ting(v=1., f=2400):   # 金属小"叮"（棒从耳中取出）
    d = 1.2; tt = t_(d); return norm(sum(a * np.sin(2 * np.pi * f * k * tt) * env_exp(d, tau) for k, a, tau in [(1, 1, .5), (2.76, .5, .25), (5.4, .25, .12), (8.9, .12, .06)])) * v
def shing(v=1.):          # 火眼金睛：一记亮的"铮" + 上扫的气流
    d = 1.4; tt = t_(d); sweep = np.sin(2 * np.pi * np.cumsum(np.linspace(1800, 5200, len(tt))) / SR) * np.sin(np.pi * np.clip(tt / .5, 0, 1)) * env_exp(d, .25) * .35
    bell = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(1320, 1, .6), (2650, .6, .35), (3960, .35, .2), (6100, .2, .1)])
    return norm(bell + sweep + hp(noise(d), 5000) * env_exp(d, .05) * .3) * v
def grow(d=.35, v=1.):    # 棒子变长：上扫的金属 + 风
    tt = t_(d); f = np.linspace(300, 1400, len(tt)); tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d)
    return norm(tone * .5 + bp(noise(d), 800, 5000) * np.sin(np.pi * tt / d) ** 2) * v
def rattle(d=1., v=1., dens=26, f0=900):   # 骨头 / 珠子：一串木质短响
    out = np.zeros(int(d * SR))
    for k in range(int(d * dens)):
        s = int(rng.random() * (len(out) - 3000)); dd = .03; tt = t_(dd); f = f0 * (.7 + rng.random() * .8)
        c = (hp(noise(dd), 1200) * env_exp(dd, .003) + np.sin(2 * np.pi * f * tt) * env_exp(dd, .008)) * (.3 + rng.random() * .7); out[s:s + len(c)] += c
    return norm(out * np.minimum(1, t_(d) / .05) * np.minimum(1, (d - t_(d)) / .15)) * v
def spirit(d=1.5, v=1.):  # 真身离布：空洞上升的气声（不是人声）
    tt = t_(d); out = np.zeros(len(tt))
    for f0, a in [(420, 1), (640, .6), (980, .35)]:
        f = f0 * (1 + 1.4 * (tt / d) ** 1.5); out += a * np.sin(2 * np.pi * np.cumsum(f) / SR + 2 * np.sin(2 * np.pi * 5 * tt))
    air = bp(noise(d), 1500, 7000) * (tt / d)
    return norm((out * .25 + air) * np.sin(np.pi * tt / d) ** 1.5) * v
def swell(d=.55, v=1.):   # 反向吸气：巨影压上布之前
    tt = t_(d); return norm((lp(noise(d), 1800) + .4 * np.sin(2 * np.pi * 55 * tt)) * (tt / d) ** 3) * v
def cloudwhoosh(d=1.3, v=1.):
    tt = t_(d); return norm(whoosh(d, 1) + .25 * bp(noise(d), 4000, 9000) * np.sin(np.pi * tt / d)) * v
def ring(d, v=1.):        # 紧箍：高频紧绷的嗡声，随木鱼越来越紧
    tt = t_(d); f = 2350 * (1 + .12 * tt / d); x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .6 * np.sin(2 * np.pi * np.cumsum(f * 1.013) / SR)
    return norm(x * (.3 + .7 * tt / d) * np.minimum(1, tt / .4) * np.minimum(1, (d - tt) / .08)) * v
def pop_(v=1.):           # 铆钉崩开
    d = .04; tt = t_(d); return norm(hp(noise(d), 2500) * env_exp(d, .002) + np.sin(2 * np.pi * 1700 * tt) * env_exp(d, .006) * .6) * v
def paper(d, v=1.):
    tt = t_(d); am = lp(rng.random(len(tt)), 18) ** 2; return norm(bp(noise(d), 2000, 8000) * am * np.sin(np.pi * tt / d)) * v
def cloth(v=1., d=.5):
    tt = t_(d); am = lp(rng.random(len(tt)), 25); return norm(bp(noise(d), 1200, 6000) * am * np.sin(np.pi * tt / d)) * v
def breath(v=1.):
    d = 1.1; tt = t_(d); return norm(bp(noise(d), 300, 2200) * np.sin(np.pi * tt / d) ** 1.5) * v
# —— 环境底 ——
def crackle_bed(d, dens=1.):
    out = np.zeros(int(d * SR))
    for _ in range(int(d * 14 * dens)):
        s = int(rng.random() * (len(out) - 2000)); c = hp(noise(.01), 2500) * env_exp(.01, .0015) * (.3 + rng.random()); out[s:s + len(c)] += c
    return out
def wind_bed(d):
    tt = t_(d); m = lp(rng.random(len(tt)), 1.5); m = (m - m.min()) / (np.ptp(m) + 1e-9)
    w = bp(noise(d), 180, 900) * (.35 + .65 * m) + .25 * bp(noise(d), 900, 2400) * m ** 3
    return w * np.minimum(1, tt / 1.2) * np.minimum(1, (d - tt) / .8)
def cold_bed(d):          # 妖气：低频嗡 + 微颤 + 冷风
    tt = t_(d); trem = 1 + .3 * np.sin(2 * np.pi * 3.1 * tt)
    x = (np.sin(2 * np.pi * 55 * tt) + .6 * np.sin(2 * np.pi * 58.3 * tt) + .5 * np.sin(2 * np.pi * 110.7 * tt) + .3 * np.sin(2 * np.pi * 166 * tt)) * .3 * trem + bp(noise(d), 300, 1400) * .6
    return x * np.minimum(1, tt / 1.2) * np.minimum(1, (d - tt) / .03)        # 硬切（静场）
def room_bed(d):
    tt = t_(d); return (lp(brown(d), 250) * .6 + crackle_bed(d, .5) * .4) * np.minimum(1, tt / .5) * np.minimum(1, (d - tt) / .4)

rt = lambda: rng.uniform(-.25, .25)
for e in ev:
    ty, t, v, d = e['type'], e['t'], e.get('v', 1), e.get('d', .5)
    if ty == 'clap': add(fx, woodclap(v), t, .95)
    elif ty == 'match': add(fx, match_(v), t, .5, .3)
    elif ty == 'ignite': add(fx, fwoomp(v, 1.0, 900), t, .45, .3)
    elif ty == 'rodtap': add(fx, rodtap(v), t, .35, rt())
    elif ty == 'liftoff': add(fx, flap(v), t, .28, rt())
    elif ty == 'press': add(fx, press(v), t, .42, rt())
    elif ty == 'flip': add(fx, flap(v, .12), t, .3, rt())
    elif ty == 'hop': add(fx, flap(v, .2), t, .32)
    elif ty == 'land': add(fx, thud(v, 70, .3), t, .5); add(fx, leather_step(1), t + .01, .3)
    elif ty in ('patter', 'steps'):
        if ty == 'patter': add(fx, leather_step(v), t, .13, .3)
        else:
            k = 0.
            while k < d: add(fx, leather_step(.8), t + k, .2); k += .07
    elif ty == 'cloud': add(fx, cloudwhoosh(d, v), t, .4)
    elif ty == 'swell': add(fx, swell(d, v), t, .4, .35)
    elif ty == 'shing': add(fx, shing(v), t, .42)
    elif ty == 'bones': add(fx, rattle(d, v, 30, 1100), t, .32, .3)
    elif ty == 'drone': tt = t_(d); add(amb, lp(noise(d), 200) * np.sin(np.pi * np.clip(tt / d, 0, 1)) * .8, t, .35)
    elif ty == 'ting': add(fx, ting(v), t, .25)
    elif ty == 'grow': add(fx, grow(d, v), t, .35)
    elif ty == 'staffin': add(fx, grow(d, v)[::-1].copy(), t, .25)
    elif ty == 'swish': add(fx, swish(d, v), t, .5 * v)
    elif ty == 'gong': add(perc, big_gong(min(1, .75 * v), -3.2), t, .95 * v)
    elif ty == 'cymbal': add(perc, cymbal(.75 * v, 1.1), t, .6 * v, .25)
    elif ty == 'crash': add(perc, crash_c(.9, 3.0), t, .75, .15)
    elif ty == 'tanggu': add(perc, tanggu(.8, 1.6), t, .9)
    elif ty == 'thwack': add(fx, thwack(v), t, .6 * v)
    elif ty == 'fall': add(fx, thud(v, 60, .45), t, .55); add(fx, flap(.8, .15), t - .03, .3)
    elif ty == 'spirit': add(fx, spirit(d, v), t, .32, .35)
    elif ty == 'clapper': add(perc, bangu(.7 * v), t, .75, -.2)
    elif ty == 'kneel': add(fx, thud(v, 90, .25), t, .4)
    elif ty == 'canetap': add(fx, rodtap(v, 900), t, .3, .35)
    elif ty == 'stafftap': add(fx, rodtap(v, 700), t, .34, .35)
    elif ty == 'beads': add(fx, rattle(.18, v, 60, 2200), t, .18, .35)
    elif ty == 'muyu': add(perc, muyu(.7 * v), t, .8, -.3)
    elif ty == 'tai': add(perc, small_gong(.6 * v, 1.6), t, .55, .2)
    elif ty == 'ring': add(fx, ring(d, v), t, .09)
    elif ty == 'thud': add(fx, thud(v, 65, .35), t, .5)
    elif ty == 'creak':
        k = 0.
        while k < d: add(fx, creak(1 + k / max(d, .01) * .5), t + k, .2 * v * (.6 + .4 * k / max(d, .01))); k += .12
    elif ty == 'heart': add(perc, heart(.8 * v), t, .9 * v)
    elif ty == 'pop': add(fx, pop_(v), t, .35, rng.uniform(-.5, .5))
    elif ty == 'flaps':
        for k in range(7): add(fx, flap(.6 + .4 * rng.random(), .14), t + k * d / 7, .26, rng.uniform(-.6, .6))
    elif ty == 'bonefall': add(fx, rattle(.8, 1, 40, 700), t, .5, .15); add(fx, thud(.8, 80, .3), t, .35)
    elif ty == 'paper': add(fx, paper(d, v), t, .35, -.1)
    elif ty == 'sleeve': add(fx, cloth(1, .45), t, .45)
    elif ty == 'kowtow': add(fx, thud(.9, 95, .25), t, .38)
    elif ty == 'whoosh': add(fx, whoosh(d, 1), t, .3)
    elif ty == 'cloth': add(fx, cloth(1, .7), t, .25)
    elif ty == 'rack': add(fx, rattle(.35, 1, 16, 600), t, .28 * v, -.4)
    elif ty == 'breath': add(fx, breath(1), t, .12, .5)
    elif ty == 'wind': add(amb, wind_bed(d), t, .16 * v)
    elif ty == 'cold': add(amb, cold_bed(d), t, .11)
    elif ty == 'room': add(amb, room_bed(d), t, .12)
# 灯芯底噪：灯亮着就有极轻的噼啪（静场里只剩它）
lamp_on = TT.get('ignite', 1.25)
add(amb, crackle_bed(DUR - lamp_on - .5, .7), lamp_on + .2, .16)

fx = verb(fx, room_ir(.6), .18); perc = verb(perc, room_ir(1.1), .22)
mix = fx + perc * .9 + amb
mix = np.stack([lp(mix[:, c], 15000) for c in range(2)], 1)     # 15 kHz 以上本来就会被 AAC 切掉，先滤掉，减少编码过冲
# —— 母带：总线轻压缩 → 4× 过采样真峰值限幅（−4 dBTP，给 AAC 编码过冲留余量：低频闷响被压平后 AAC 会多冲约 3 dB）→ 按实测响度校准到约 −14 LUFS ——
import soxr, subprocess, re as _re
pre = np.stack([compress(mix[:, c], .3, 2.4, .003, .12) for c in range(2)], 1)[:int(DUR * SR)]
def master(g):
    up = soxr.resample(pre * g, SR, SR * 4)
    up = np.stack([limit(up[:, c], 10 ** (-4.0 / 20), .006) for c in range(2)], 1)
    return soxr.resample(up, SR * 4, SR)[:len(pre)]
def lufs(x):
    p = os.path.join(D, 'out', '_lufs.wav'); os.makedirs(os.path.dirname(p), exist_ok=True); sf.write(p, x.astype(np.float32), SR)
    o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(_re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
g = 1.0
for _ in range(4):
    mix = master(g); I = lufs(mix); print(f'master gain {20 * np.log10(g):5.1f} dB -> {I:.1f} LUFS')
    if abs(I + 14.2) < .3: break
    g *= 10 ** ((-14.2 - I) / 20)
sf.write(os.path.join(D, 'mix.wav'), mix.astype(np.float32), SR)
def rms(a, b): x = mix[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
print('mix.wav', mix.shape, 'peak', np.abs(mix).max().round(3))
for a, b, n in [(0, 7.8, 'open'), (8, 16, 'ridge'), (17, 23, 'girl'), (27.5, 30, 'hit1'), (43, 47.6, 'spell'), (54.05, 56.0, 'silence'), (58.0, 60, 'hit3'), (72, 76, 'bows'), (82, 87.5, 'back'), (89, 92.5, 'end')]:
    print(f'{n:8s} {rms(a, b):6.1f} dB')
