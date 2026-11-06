"""混音：配乐（music/score.wav）+ 按材质合成的拟音（纸、墨、羽、木、印泥）+ 环境床（纸面空气、瀑布、高空风、夜风）。
所有拟音从 events.json（window.EV）驱动，落在帧上。静默窗口把整条总线归零（音乐、环境、混响尾）。
用法：$LIB/.venv/bin/python mix.py <工程目录>  → out/mix.wav（48k 立体声，未做响度归一，mux.sh 做 −14 LUFS）"""
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.ndimage import uniform_filter1d
from core.audio.sfx import SR, t_, noise, bp, lp, hp, brown, creak, add, limit
from core.audio import sampler as S

HERE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(__file__))
ev = json.load(open(os.path.join(HERE, 'events.json')))
DUR, E = ev['dur'], ev['ev']
N = int(round(DUR * SR))
rng = np.random.default_rng(23)


def sw(d, a=.5, b=.5):
    """不对称的起落包络"""
    t = t_(d); x = np.clip(t / d, 0, 1)
    return np.where(x < a, (x / a) ** 1.5, ((1 - x) / (1 - a)) ** b)


def grains(d, rate, lo=2500, hi=9000, tau=.003):
    """鬃毛颗粒：随机的极短高频点"""
    n = len(t_(d)); x = np.zeros(n)
    k = int(rate * d)
    for _ in range(k):
        s = int(rng.random() * (n - 300)); L = int(.012 * SR); tt = np.arange(L) / SR
        seg = rng.standard_normal(L) * np.exp(-tt / tau) * (.3 + rng.random() * .7)
        x[s:s + L] += seg[:max(0, min(L, n - s))]
    return bp(x, lo, hi)


# ───── 拟音（按材质） ─────
def brushair(d, v=1.):       # 毛笔破空：带通噪声 + 鬃毛颗粒，渐强到落笔
    t = t_(d); x = bp(noise(d), 900, 6000) * (t / d) ** 2.2
    return (x + grains(d, 260) * (t / d) ** 1.5 * .6) * v * .7
def strokehit(v=1.):          # 落笔：湿闷响 + 纸面一拍
    d = .9; t = t_(d)
    thud = lp(noise(d), 260) * np.exp(-t / .07) * 2.2 + np.sin(2 * np.pi * (58 + 30 * np.exp(-t / .03)) * t) * np.exp(-t / .16) * .8
    slap = bp(noise(d), 1500, 6000) * np.exp(-t / .018) * .7
    return (thud + slap) * v
def bleed(d, v=1.):           # 湿墨渗纸：极细的嘶 + 偶发的湿点
    t = t_(d); x = bp(noise(d), 2500, 9000) * np.exp(-t / (d * .45)) * .25
    return (x + grains(d, 40, 1500, 6000, .006) * np.exp(-t / (d * .5)) * .3) * v
def brush(d, v=1.):           # 一笔：湿毛笔擦纸
    t = t_(d); x = bp(noise(d), 1100, 6500) * np.sin(np.pi * np.clip(t / d, 0, 1)) ** 1.3
    return (x * .6 + grains(d, 120) * .35) * v
def dryfall(d, v=1.):         # 干笔下拖：鬃毛跳纸
    t = t_(d); g = grains(d, 900, 1800, 8000, .002)
    am = .5 + .5 * (np.sin(2 * np.pi * 23 * t) > 0)
    return (g * am * .8 + bp(noise(d), 2500, 7000) * .25) * sw(d, .1, 1.2) * v
def wet_tick(v=1., f0=1500):  # 苔点：短"嗒"+ 湿闷
    d = .25; t = t_(d)
    tone = np.sin(2 * np.pi * np.cumsum(f0 * np.exp(-t / .015) + 300) / SR) * np.exp(-t / .03)
    return (tone * .5 + lp(noise(d), 1200) * np.exp(-t / .02) * .6) * v
def wash(d, v=1.):            # 淡墨大刷：宽笔湿扫
    t = t_(d); return bp(noise(d), 350, 2600) * sw(d, .25, 1.5) * v * .5
def feather_air(d, v=1., lo=180, hi=1600, flut=34):   # 羽翼扇风：低中频噪声 + 羽片颤动
    t = t_(d); x = bp(noise(d), lo, hi) * (1 + .45 * np.sin(2 * np.pi * flut * t))
    return x * sw(d, .35, 1.3) * v
def flap(v=1.):    return feather_air(.42, v * 1.3, 140, 1400)
def wingbeat(v=1.): return feather_air(.32, v, 160, 1500, 30)
def wingup(v=1.):  return feather_air(.33, v * .6, 300, 2500, 40)
def drop(v=1.):               # 墨滴落纸："叮" + 湿闷
    d = .5; t = t_(d)
    tone = np.sin(2 * np.pi * np.cumsum(1500 * np.exp(-t / .018) + 420) / SR) * np.exp(-t / .05)
    return (tone * .55 + lp(noise(d), 700) * np.exp(-t / .03) * .7 + bp(noise(d), 3000, 9000) * np.exp(-t / .01) * .2) * v
def dropfall(d, v=1.):
    t = t_(d); return bp(noise(d), 2000, 7000) * (t / d) ** 3 * v * .25
def spread(d, v=1.):          # 墨晕外扩：湿嘶 + 低音渐起
    t = t_(d); hiss = bp(noise(d), 600, 5000) * (.3 + .7 * (t / d)) * .35
    sw_ = lp(brown(d), 160) * (t / d) ** 2 * .9
    return (hiss + sw_) * np.minimum(1, (d - t) / .08) * v
def needle(v=1.):
    return grains(.12, 260, 3000, 9000, .0015) * v
def land(v=1.):               # 脚落木枝：闷响 + 枝的木质
    d = .5; t = t_(d)
    return (np.sin(2 * np.pi * (140 + 60 * np.exp(-t / .01)) * t) * np.exp(-t / .05) + bp(noise(d), 300, 1800) * np.exp(-t / .03) * .7) * v
def ruffle(d, v=1.):          # 抖羽
    t = t_(d); x = bp(noise(d), 800, 5000) * (np.abs(np.sin(2 * np.pi * 14 * t)) ** 2)
    return x * sw(d, .2, 1.5) * v * .7
def seal(v=1.):               # 钤印：木印闷响 + 纸噼啪
    d = .8; t = t_(d)
    thud = np.sin(2 * np.pi * (110 + 80 * np.exp(-t / .01)) * t) * np.exp(-t / .08)
    knock = bp(noise(d), 600, 2400) * np.exp(-t / .012) * .7
    crack = grains(d, 70, 2500, 9000, .002) * np.exp(-t / .15) * .5
    return (thud + knock + crack) * v
def turn(d, v=1.):
    t = t_(d); return bp(noise(d), 600, 3500) * sw(d, .5, 1) * v * .4

FX = {
    'brushair': lambda e: brushair(e['dur'], e.get('gain', 1)), 'strokehit': lambda e: strokehit(e.get('gain', 1)),
    'bleed': lambda e: bleed(e['dur'], e.get('gain', 1)), 'brush': lambda e: brush(e['dur'], e.get('gain', 1)),
    'dryfall': lambda e: dryfall(e['dur'], e.get('gain', 1)), 'moss': lambda e: wet_tick(.8, 1300 + 300 * rng.random()),
    'wash': lambda e: wash(e['dur'], 1), 'crowndot': lambda e: wet_tick(.45, 2400),
    'wingup': lambda e: wingup(1), 'flap': lambda e: flap(e.get('gain', 1)), 'wingbeat': lambda e: wingbeat(e.get('gain', 1)),
    'dropfall': lambda e: dropfall(e['dur']), 'drop': lambda e: drop(1), 'spread': lambda e: spread(e['dur'], 1),
    'branch': lambda e: dryfall(e['dur'], .9) + brush(e['dur'], .6), 'needle': lambda e: needle(e.get('gain', 1)),
    'brake': lambda e: feather_air(e['dur'], 1.1, 120, 1300, 22), 'land': lambda e: land(1), 'creak': lambda e: creak(.5),
    'ruffle': lambda e: ruffle(e['dur'], 1), 'write': lambda e: dryfall(e['dur'], .35) + brush(e['dur'], .45), 'seal': lambda e: seal(1),
    'turn': lambda e: turn(e['dur'], 1), 'settle': lambda e: ruffle(e['dur'], .55),
}
# 拟音落点（声像随画面）
PAN = {'strokehit': .1, 'moss': .25, 'drop': -.25, 'branch': -.4, 'land': -.2, 'creak': -.2, 'seal': .15, 'write': .2, 'dryfall': -.05}
WFX = {'strokehit': .9, 'brushair': .55, 'flap': .7, 'wingbeat': .45, 'drop': .8, 'spread': .5, 'seal': .9, 'land': .7}

fx = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32)
for e in E:
    k = e['type']
    if k in FX:
        x = FX[k](e).astype(np.float32)
        add(fx, x, e['t'], WFX.get(k, .55), PAN.get(k, 0))
    elif k == 'amb':
        t0, t1 = e['t0'], e['t1']; d = t1 - t0; t = t_(d)
        if e['kind'] == 'air':    x = bp(noise(d), 300, 2500) * .012 + lp(brown(d), 300) * .05
        elif e['kind'] == 'water': x = (bp(noise(d), 250, 2600) * .22 + bp(noise(d), 2500, 7000) * .06) * (.8 + .2 * np.sin(2 * np.pi * t / 2.3))
        elif e['kind'] == 'wind':  x = (bp(brown(d), 150, 1200) * .6 + bp(noise(d), 1500, 5000) * .02) * (.25 + .75 * (t / d) ** 1.4)
        else:                      x = lp(brown(d), 420) * .3 * (.75 + .25 * np.sin(2 * np.pi * t / 4.1))
        fi = int((.04 if e['kind'] == 'wind' else .5) * SR); fo = int((.9 if e['kind'] == 'water' else .4) * SR)
        x[:fi] *= np.linspace(0, 1, fi); x[-fo:] *= np.linspace(1, 0, fo)
        add(amb, x.astype(np.float32), t0, .5, -.1 if e['kind'] == 'water' else 0)

# ───── 配乐 ─────
mu, sr = sf.read(os.path.join(HERE, 'music', 'score.wav'), dtype='float32')
mus = np.zeros((N, 2), np.float32); L = min(N, len(mu)); mus[:L] = mu[:L]
mus = S.room(mus, size=.55, mix=.16)                   # 一点空间（静默里会被整体归零）

# ───── 平衡 ─────
mix = mus * 1.0 + fx * .55 + amb * .38
# 静默：整条总线（音乐、环境、混响尾）归零，60 ms 淡出；静默后第一声（鹤唳）不受影响
for e in E:
    if e['type'] != 'silence': continue
    a, b = int(round(e['t0'] * SR)), int(round(e['t1'] * SR)); f = int(.06 * SR)
    mix[a - f:a] *= np.linspace(1, 0, f)[:, None] ** 2; mix[a:b] = 0
# 结尾 0.6 s 淡出
f = int(.6 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None] ** 1.5
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)

def rms(x): return np.sqrt(np.mean(x ** 2) + 1e-12)
db = lambda a, b: 20 * np.log10(rms(mix[int(a * SR):int(b * SR)]) + 1e-9)
print('mix.wav', round(N / SR, 2), 's, peak', round(20 * np.log10(np.abs(mix).max()), 2), 'dBFS')
for a, b, n in [(0, 4.17, '山'), (4.17, 8.33, '生鹤'), (8.34, 9.16, '静默'), (9.167, 12.54, '飞越'), (12.54, 14.04, '墨晕'), (14.04, 19, '落枝')]:
    print(f'  {n:4s} {db(a, b):7.1f} dB')
# 低频占比
from scipy.signal import welch
f_, p = welch(mix.mean(1), SR, nperseg=8192)
lo = p[(f_ >= 20) & (f_ < 120)].sum(); rest = p[(f_ >= 120) & (f_ < 8000)].sum()
print('  20–120 Hz 相对其余', round(10 * np.log10(lo / rest), 1), 'dB')
