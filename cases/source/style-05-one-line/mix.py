"""混音：笔尖在纸上的声音（由笔速合成，全片最重要的声音）+ 拟音（落笔、翅膀、窗角、墨点、合拢、落款）
+ 房间声 + 远处城市低鸣 + 竖琴配乐。全部由 events.json（window.EV）驱动，声音就落在它的那一帧上。
python mix.py → out/mix.wav（48k 立体声；响度交给 mux.sh 的两遍 loudnorm）"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, add, bp, lp, hp, limit, whoosh

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json'))); ev = E['ev']
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json'))); HT = TL['HT']
DUR = E['dur']; N = int(round(DUR * SR))
rng = np.random.default_rng(23)
get = lambda typ: [e for e in ev if e['type'] == typ]
T = np.arange(N) / SR
STOP0, STOP1 = HT['stop'], HT['resume']

def smooth(x, ms):
    n = max(1, int(SR * ms / 1000)); return np.convolve(x, np.ones(n) / n, 'same')

# ---------- 笔尖沙沙声：快 = 亮而响，慢 = 闷，纤维颗粒密度 ∝ 速度，声像跟笔尖在屏幕上的位置 ----------
tr = get('track')[0]['data']
tt = np.array([r[0] for r in tr]); v = np.array([r[1] for r in tr], float); px = np.array([r[2] for r in tr]); kz = np.array([r[4] for r in tr])
seg = [r[3] for r in tr]
steam = np.array([s == 'steam' for s in seg], float); city = np.array([s == 'city' for s in seg], float)
V = np.interp(T, tt, v); PX = np.interp(T, tt, px); STM = np.interp(T, tt, steam); CTY = np.interp(T, tt, city)
amp = smooth(np.clip(V / 520, 0, 1.6) ** .5, 25)
dens = np.clip(V / 520, 0, 2) * 95 + (V > 5) * 25
hits = rng.random(N) < dens / SR; idx = np.nonzero(hits)[0]
grain = np.zeros(N); grain[idx] = rng.standard_normal(len(idx)) * (.5 + rng.random(len(idx)))
grain = bp(grain, 2500, 9000, 2)
white = rng.standard_normal(N)
hi = bp(white, 2200, 7500, 2); lo = bp(white, 700, 2400, 2)
bright = np.clip(V / 700, 0, 1)
scr = amp * ((.55 + .45 * bright) * hi + (1 - bright) * .8 * lo) + amp * 1.6 * grain
scr *= 1 - .45 * STM                       # 画热气时手更轻
scr *= 1 + .15 * CTY                       # 城市段更硬、更密
scr = lp(scr, 9000, 2) * .13
pan = (PX - .5) * 1.1
pen = np.stack([scr * np.sqrt(np.clip(.5 - pan / 2, 0, 1)), scr * np.sqrt(np.clip(.5 + pan / 2, 0, 1))], 1).astype(np.float32)

sfx = np.zeros((N, 2), np.float32)
sfx += pen
d_ = lambda d: np.arange(int(d * SR)) / SR
# 落笔：木质小「嗒」+ 纸的闷响
for e in get('touch'):
    t = d_(.25); tick = np.sin(2 * np.pi * 2300 * t) * np.exp(-t / .004) * .5 + bp(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / .006) * .6
    add(sfx, ((tick + np.sin(2 * np.pi * 140 * t) * np.exp(-t / .03) * .5) * .24).astype(np.float32), e['t'], 1.0, -.6)
# 翅膀：两下很轻的纸面扑动（鸟成形、鸟身）
for e in get('wing'):
    w = whoosh(.22, 1.0) * .05; add(sfx, w.astype(np.float32), e['t'] - .06, 1.0, .1)
# 城市段的窗角/楼角：极短的笔尖「嗒」，随加速越来越密
for c in get('corners')[0]['data']:
    if c['seg'] != 'city': continue
    t = d_(.03); k = (bp(rng.standard_normal(len(t)), 3000, 8000) * np.exp(-t / .003)) * .05
    add(sfx, k.astype(np.float32), c['t'], 1.0, rng.uniform(-.3, .3))
# 停笔墨点：几乎听不见的湿润膨胀（静默里唯一的东西）
for e in get('blot'):
    t = d_(e['dur']); wet = lp(rng.standard_normal(len(t)), 700, 2) * np.sin(np.pi * np.clip(t / e['dur'], 0, 1)) ** 2
    add(sfx, (wet * .012).astype(np.float32), e['t'] + .05, 1.0, -.2)
# 重启：笔尖重新咬住纸的一下摩擦
for e in get('resume'):
    t = d_(.12); bite = bp(rng.standard_normal(len(t)), 1200, 5000) * np.exp(-t / .03) * .09
    add(sfx, bite.astype(np.float32), e['t'], 1.0, -.4)
# 合拢：最后一点，笔尖轻轻一按再抬起
for e in get('close'):
    t = d_(.2); tick = np.sin(2 * np.pi * 1900 * t) * np.exp(-t / .005) * .35 + bp(rng.standard_normal(len(t)), 1800, 6000) * np.exp(-t / .008) * .4
    add(sfx, (tick * .15).astype(np.float32), e['t'], 1.0, .05)
    # 纸面落定：整张纸被轻轻按住的一下闷响 + 纸纤维的短促沙声（合拢那一帧）
    t = d_(.45); thump = np.sin(2 * np.pi * 95 * t) * np.exp(-t / .07) * .55 + lp(rng.standard_normal(len(t)), 900, 2) * np.exp(-t / .05) * .5
    rust = bp(rng.standard_normal(len(t)), 1800, 7000) * np.exp(-t / .09) * (1 - np.exp(-t / .006)) * .35
    add(sfx, ((thump + rust) * .12).astype(np.float32), e['t'], 1.0, 0.0)
# 落款书写：细碎的写字声
for e in get('sign'):
    d = e['dur'] + .1; t = d_(d)
    burst = (np.abs(np.sin(2 * np.pi * 3.2 * t)) ** .6) * np.sin(np.pi * t / d)
    s = bp(rng.standard_normal(len(t)), 2400, 8000) * burst * .05
    add(sfx, s.astype(np.float32), e['t'], 1.0, .45)

# ---------- 环境：清晨房间声 + 城市段远处的低鸣；停笔时全部清零 ----------
room = lp(np.cumsum(rng.standard_normal(N)) * .002, 400, 2); room = room - smooth(room, 500)
room = room / (np.abs(room).max() + 1e-9) * .006
air = hp(lp(rng.standard_normal(N), 3000, 2), 300, 2) * .0012          # 一点点空气
hum = lp(rng.standard_normal(N), 160, 2); hum = hum / (np.abs(hum).max() + 1e-9) * .012
cityenv = np.clip((T - HT['c0'] + .4) / .8, 0, 1) * np.clip((STOP0 - T) / .02, 0, 1)
amb = room + air + hum * cityenv
gate = np.ones(N); gate[(T >= STOP0) & (T < STOP1)] = 0
f = int(.02 * SR); i0 = int(STOP0 * SR); gate[i0 - f:i0] = np.linspace(1, 0, f)
i1 = int(STOP1 * SR); gate[i1:i1 + int(.25 * SR)] = np.linspace(0, 1, int(.25 * SR))   # 房间声随重启慢慢回来
amb *= gate
sfx += np.stack([amb, amb], 1).astype(np.float32)

# ---------- 音乐 ----------
mus, msr = sf.read(os.path.join(HERE, 'out', 'music.wav')); mus = mus.astype(np.float32)
m = np.zeros((N, 2), np.float32); n = min(N, len(mus)); m[:n] = mus[:n]
# 结尾淡出最后 0.6 s（竖琴余音不被硬切）
fo = int(.6 * SR); m[-fo:] *= np.linspace(1, 0, fo)[:, None]; sfx[-fo:] *= np.linspace(1, 0, fo)[:, None]

mix = m * .5 + sfx * 1.0
# 立体声联动的前视限幅：只削最尖的几处拨弦起音（约 2 dB），让两遍 loudnorm 后真峰值稳在 −1.2 dBTP 以下
from scipy.ndimage import maximum_filter1d, uniform_filter1d
_n = int(.004 * SR); _pk = maximum_filter1d(np.abs(mix).max(1), size=2 * _n + 1)
_g = uniform_filter1d(np.minimum(1, .38 / np.maximum(_pk, 1e-9)), size=_n)
mix = mix * _g[:, None]
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
def db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)
for i in range(0, int(np.ceil(DUR))):
    sl = slice(i * SR, min(N, (i + 1) * SR))
    print(f'{i:2d}s  music {db(m[sl] * .5):6.1f}  pen {db(pen[sl]):6.1f}  amb {db(amb[sl]):6.1f}  mix {db(mix[sl]):6.1f}')
print('mix.wav', mix.shape, 'peak', round(float(np.abs(mix).max()), 3))
