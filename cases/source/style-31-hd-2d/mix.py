"""港口集市 — 原创配乐 + 拟音 + 环境声 → out/mix.wav
配乐：竖琴、长笛、手鼓、弦乐拨奏为主，定音鼓 / 圆号 / 钟琴 / 管钟只在关键拍上出现。90 BPM，所有音符从 timeline.json 的拍点算出。
用法：$LIB/.venv/bin/python mix.py   （LIB 由环境变量给出，build.sh 会设）
"""
import json, os, sys
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S                       # noqa: E402
from core.audio.sfx import (SR, add, limit, noise, brown, lp, hp, bp, t_, env_exp, norm,   # noqa: E402
                            whoosh, creak, ignite, ding)

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SPB = TL['spb']; DUR = TL['dur']; C = TL['cues']; POPS = TL['pops']
def B(b): return b * SPB
N = int(round(DUR * SR))
S.seed(31)
rng = np.random.default_rng(31)
CUE_LOG = []           # (名字, 秒)：配乐里每个"卡拍"的落点，给 cuecheck.py 用
def cue(name, b): CUE_LOG.append({'name': name, 'beat': b, 't': B(b)})

# ———————————————————————— 配乐 ————————————————————————
ev = []
def n(b, inst, p, dur_b, vel, pan=0, gain=1.0, **kw):
    d = dict(t=B(b), inst=inst, pitch=p, dur=dur_b * SPB, vel=vel, pan=pan); d.update(kw)
    if gain != 1.0: d['gain'] = gain
    ev.append(d)
def hit(b, inst, var, vel, pan=0, gain=1.0): ev.append(dict(t=B(b), inst=inst, pitch=var, dur=None, vel=vel, pan=pan, gain=gain))
def arp(b0, notes, step, vel, inst='harp', pan=-.25, ring=2.0, gain=1.0):
    for k, p in enumerate(notes): n(b0 + k * step, inst, p, ring, vel * (1 - .04 * (k % 4)), pan, gain)

# A 雨（0–6 拍）D 小调：竖琴低音分解 + 大提琴拨奏持续音 + 闷手鼓
arp(0, ['D3', 'A3', 'D4', 'F4', 'A4', 'F4', 'D4', 'A3'], .5, .5)
arp(4, ['A#2', 'F3', 'A#3', 'D4'], .5, .5)
for b in (0, 2): n(b, 'cellos_pizz', 'D2', 2, .7, .1)
n(4, 'contrabass_pizz', 'A#1', 2, .7, .1)
for b in (1, 3, 5): hit(b, 'frame_drum', 'large_muted', .45, -.1)
n(.5, 'glockenspiel', 'A6', 2, .35, .3); cue('cardIn', .5)                         # 章节牌落定：一粒钟琴
hit(2, 'sus_cymbal', 'hit', .35, .2); cue('lightning', 2)                           # 闪电
for k in range(10): n(3 + k * .125, 'timpani', 'D3', .5, .8 if k == 0 else .35 + .35 * np.sin(np.pi * k / 10), 0, .8)   # 第一击重，雷声的起头卡在拍上   # 雷：定音鼓滚奏
cue('thunder', 3)
# B 过云（6–12 拍）降 B → F 大调，长笛主题在第 8 拍进
arp(6, ['A#2', 'F3', 'A#3', 'D4', 'F4', 'D4', 'A#3', 'F3'], .5, .5, ring=1.5); cue('cloudGo', 6)
arp(8, ['F2', 'C3', 'F3', 'A3', 'C4', 'A3', 'F3', 'C3'], .5, .52, ring=1.5)
n(6, 'cellos_pizz', 'A#2', 2, .65, .1); n(8, 'cellos_pizz', 'F2', 2, .7, .1); n(10, 'cellos_pizz', 'C3', 2, .65, .1)
for b, p in [(7, 'D5'), (7.5, 'F5'), (9, 'C5'), (11, 'A4')]: n(b, 'violins_pizz', p, 1, .45, .35)
for b in (6, 8, 10): hit(b, 'frame_drum', 'large', .5, -.1)
for b in (7, 9, 11, 11.5): hit(b, 'frame_drum', 'small_muted', .35, .15)
for b, p, d in [(8, 'A4', 1.5), (9.5, 'C5', .5), (10, 'D5', 1), (11, 'E5', .5), (11.5, 'F5', .5)]: n(b, 'flute', p, d, .55, -.05, **({'maxlat': .015} if b == 10 else {}))   # 第 10 拍的长笛少补偿，别抢在竖琴前（原实测 −41 ms）
cue('sunLH', 8); cue('rainHalf', 10)
# 第 10 拍（雨只剩右半边）：一粒清楚的竖琴高音 + 钟琴，起音卡在拍上
n(10, 'harp', 'F5', 1.5, .8, .45, 1.3); n(10, 'glockenspiel', 'C7', 1.5, .45, .5, .8)
# C 点灯（12–19.5 拍）D 大调：每盏灯一个钟琴 + 竖琴高音，逐盏上行；手鼓与拨奏越来越密
n(12, 'harp', 'D3', 2, .72, -.2); n(12, 'glockenspiel', 'D6', 1.5, .6, .3, 1.3); n(12, 'harp', 'D5', 1.5, .8, .1, 1.2); n(12.02, 'harp', 'A3', 2, .45, -.2); n(12.04, 'harp', 'F#4', 2, .45, -.2); cue('cut1', 12)
GL = ['A5', 'B5', 'D6', 'E6', 'F#6', 'A6', 'B6', 'D7', 'E7', 'F#7', 'A7']
HP = ['A4', 'B4', 'D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6', 'F#6', 'A6']
for i, b in enumerate(POPS):
    pan = next(e.get('pan', 0) for e in EV if e['type'] == 'pop' and e['i'] == i)
    n(b, 'glockenspiel', GL[i], 2, .5 + .02 * i, pan, .9); n(b, 'harp', HP[i], 1.5, .55, pan); cue(f'pop{i}', b)
for b, p in [(12, 'D2'), (14, 'D2'), (16, 'A1'), (17, 'D2'), (18, 'A1'), (18.5, 'D2')]: n(b, 'contrabass_pizz' if p == 'A1' else 'cellos_pizz', p, 1, .7, .1)
# 拨奏弦乐：四分 → 八分 → 十六分
pat = ['D5', 'A4', 'F#4', 'A4']
for k, b in enumerate(np.arange(14, 16, 1.0)): n(b, 'violins_pizz', pat[k % 4], 1, .45, .3)
for k, b in enumerate(np.arange(16, 18, .5)): n(b, 'violins_pizz', pat[k % 4], .5, .5, .3)
for k, b in enumerate(np.arange(18, 19, .25)): n(b, 'violins_pizz', ['D5', 'E5', 'F#5', 'A5'][k % 4], .25, .55, .3)
for k, b in enumerate(np.arange(16, 19, .5)): n(b + .25, 'violas_pizz', ['A3', 'D4'][k % 2], .25, .4, -.3)
# 手鼓：每拍 → 八分 → 十六分渐强
for b in (12, 13, 14, 15): hit(b, 'frame_drum', 'large', .7 if b == 12 else .45, -.1)
for b in np.arange(16, 18, .5): hit(b, 'frame_drum', 'large' if b % 1 == 0 else 'small', .5, -.1)
for k, b in enumerate(np.arange(18, 19, .25)): hit(b, 'frame_drum', 'small', .45 + .08 * k, .1)
# 长笛：第 12–16 拍主题的大调版
for b, p, d in [(12, 'F#5', 1.5), (13.5, 'A5', .5), (14, 'B5', 1), (15, 'A5', 1), (16, 'D6', 1.5), (17.5, 'E6', .5), (18, 'F#6', 1)]: n(b, 'flute', p, d, .55, -.05)
# 第 19 拍：集市全亮，全奏重音
for p in ['D2', 'A2', 'D3', 'A3', 'D4', 'F#4', 'A4', 'D5']: n(19, 'harp', p, 1, .7, -.15)
n(19, 'timpani', 'D3', 1, .75, 0); hit(19, 'sus_cymbal', 'hit', .5, .2); hit(19, 'frame_drum', 'large', .8, -.1)
n(19, 'tubular_bells', 'D5', 1, .55, .25); n(19, 'glockenspiel', 'D7', 1, .55, .3); n(19, 'contrabass_pizz', 'D2', 1, .85, 0); n(19, 'flute', 'A6', .5, .55, -.05)
n(19, 'horn', 'D3', .5, .55, -.3); n(19, 'horn', 'A3', .5, .5, -.3)
cue('festoon', 19)
STOP_B = C['stop']; cue('stop', STOP_B)
# D 出港（21–28.5 拍）：静默后第一声——降 B 大调全奏；C；D 大调解决
cue('cut2', 21)
n(21, 'timpani', 'A#2', 2, .9, 0, 1.2); hit(21, 'gran_cassa', 'hit', .8, 0, 1.0); n(21, 'contrabass_pizz', 'A#1', 2, .95, 0)
for p in ['A#2', 'F3', 'A#3', 'D4']: n(21, 'horn', p, 2, .65, -.25)
n(21, 'cellos', 'A#2', 2, .6, .2, attack=.02); n(21, 'tubular_bells', 'A#4', 3, .65, .3); n(21, 'flute', 'F6', 2, .5, -.05)
for k, p in enumerate(['A#2', 'D3', 'F3', 'A#3', 'D4', 'F4', 'A#4', 'D5', 'F5', 'A#5', 'D6', 'F6']): n(21 + k * .055, 'harp', p, 2, .55 + .02 * k, -.3 + .05 * k)   # 竖琴刮奏
arp(22, ['A#2', 'F3', 'D4', 'F4'], .25, .5, ring=1.2); n(22, 'glockenspiel', 'F6', 1.5, .45, .3); cue('beam', 22)   # 光柱开转：一粒钟琴卡拍（嗡鸣是渐起的）
cue('sail', 23)
n(23, 'timpani', 'C3', 2, .7, 0); n(23, 'contrabass_pizz', 'C2', 2, .85, 0)
for p in ['C3', 'G3', 'C4', 'E4']: n(23, 'horn', p, 2, .6, -.25)
for k, p in enumerate(['C3', 'G3', 'C4', 'E4', 'G4', 'C5']): n(23 + k * .06, 'harp', p, 2, .6, -.2)
arp(24, ['C3', 'G3', 'E4', 'G4'], .25, .5, ring=1.2)
for b, p, d in [(23, 'E5', 1), (24, 'G5', 1)]: n(b, 'flute', p, d, .58, -.05)
cue('beamHit', 25)
n(25, 'timpani', 'D3', 2, .75, 0); n(25, 'contrabass_pizz', 'D2', 2, .85, 0); n(25, 'glockenspiel', 'D7', 2, .45, .3); n(25, 'glockenspiel', 'A6', 2, .4, .3)
for p in ['D3', 'A3', 'D4', 'F#4']: n(25, 'horn', p, 2, .6, -.25)
for k, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5']): n(25 + k * .06, 'harp', p, 2, .6, -.2)
n(25, 'flute', 'A5', 2, .6, -.05)
arp(26, ['D3', 'A3', 'F#4', 'A4'], .25, .5, ring=1.2)
cue('resolve', 27)
n(27, 'flute', 'D6', 1.5, .55, -.05); n(27, 'cellos', 'D3', 1.5, .5, .2, attack=.05); n(27, 'contrabass_pizz', 'D2', 1.5, .7, 0)
arp(27, ['D3', 'A3', 'D4', 'F#4', 'A4', 'D5'], .25, .5, ring=1.5); hit(27, 'triangle', 'open', .35, .3)
for b in (21, 23, 25, 27): hit(b, 'frame_drum', 'large', .7, -.1)
for b in (22, 24, 26): hit(b, 'frame_drum', 'small', .45, .1)

def render_aligned(evs, dur):
    """同 sampler.render，但把每个音的"听感起音"（包络第一次到达前 150 ms 峰值的 -12 dB）对齐到拍点上：
    采样的起头有几毫秒到几十毫秒的上升，不补偿的话拍点上的声音会晚到。"""
    buf = np.zeros((int(dur * SR), 2), np.float32); lats = []
    for e in evs:
        I = S.load(e['inst']); kw = {k: e[k] for k in ('release', 'attack') if e.get(k) is not None}
        x = S.hit(I, e.get('pitch'), e.get('vel', .8), e.get('dur')) if I.kind == 'hit' else S.note(I, e['pitch'], e.get('dur') or .5, e.get('vel', .8), **kw)
        a_ = np.abs(x[:int(.15 * SR)]); sm = np.convolve(a_, np.ones(48) / 48, 'same'); k = int(np.argmax(sm > sm.max() * .25))
        lat = min(k / SR, e.get('maxlat', .04)); lats.append(lat)
        add(buf, x, e['t'] - lat, e.get('gain', 1.0), e.get('pan', 0.0))
    print(f'onset compensation: mean {np.mean(lats) * 1000:.1f} ms, max {np.max(lats) * 1000:.1f} ms')
    return buf
music = render_aligned(ev, DUR + 2)
# 第 19.5 拍硬停：干声切断（15 ms），只留混响尾巴；静默里只有极低的海浪
ts = int(B(STOP_B) * SR); te = int(B(C['cut2']) * SR)
g = np.ones(len(music)); g[ts:ts + 720] = np.linspace(1, 0, 720); g[ts + 720:te] = 0
dry = music * g[:, None]
music = S.room(dry, size=.5, mix=.22)
# 混响尾在静默里自然消散，但到第 20.75 拍前收干净，让第 21 拍从近静默里出来
tail = np.ones(len(music)); a = int(B(20.0) * SR); b_ = int(B(20.75) * SR); tail[a:b_] = np.linspace(1, 0, b_ - a) ** 2; tail[b_:te] = 0
music *= tail[:, None]
music = music[:N]

# ———————————————————————— 环境声 ————————————————————————
T = np.arange(N) / SR
def envp(points):   # 分段线性增益曲线 [(秒, 增益)]
    xs, ys = zip(*points); return np.interp(T, xs, ys)
amb = np.zeros((N, 2))
# 雨：宽带噪声 + 落在瓦和水上的滴答；8.000 s 硬停；声像随雨幕从左移到右
rn = bp(noise(DUR), 900, 9000) * .5 + bp(noise(DUR), 300, 1200) * .25
drops = np.zeros(N); idx = rng.integers(0, int(B(12) * SR), 9000); drops[idx] = rng.uniform(.2, 1, len(idx)); drops = bp(drops, 2000, 7000) * 2
rain = (rn + drops)[:N]
rg = envp([(0, .9), (B(10), .85), (B(10) + .3, .5), (B(12) - .001, .5), (B(12), 0), (DUR, 0)])
cut = int(B(12) * SR); rg[cut - 240:cut] *= np.linspace(1, 0, 240)
rpan = envp([(0, 0), (B(6), 0), (B(12), .6), (DUR, .6)])
amb[:, 0] += rain * rg * np.cos((rpan + 1) * np.pi / 4) * 1.41; amb[:, 1] += rain * rg * np.sin((rpan + 1) * np.pi / 4) * 1.41
# 风：云过时呼啸起
wind = bp(brown(DUR), 200, 1400)[:N] * (1 + .5 * np.sin(2 * np.pi * .4 * T))
wg = envp([(0, .15), (B(6), .2), (B(7.5), .7), (B(10), .45), (B(12), .1), (B(19.5), .08), (B(19.5) + .01, 0), (B(21), 0), (B(21) + .4, .12), (DUR, .15)])
amb[:, 0] += wind * wg * .8; amb[:, 1] += np.roll(wind, 900) * wg * .8
# 海浪：全片都有；静默里只剩它（极低）
wv = lp(brown(DUR), 500)[:N] * (.6 + .4 * np.sin(2 * np.pi * .18 * T) ** 2)
wvg = envp([(0, .25), (B(12), .35), (B(19.5), .35), (B(19.5) + .05, .07), (B(21), .07), (B(21) + .3, .4), (DUR, .45)])
amb[:, 0] += wv * wvg; amb[:, 1] += np.roll(wv, 2400) * wvg
# 集市人声：带通噪声 + 颤动的低语（点灯后渐起，静默时切断，出港段远一些）
mur = np.zeros(N)
for k in range(14):
    f0 = rng.uniform(250, 900); seg = bp(noise(DUR), f0 * .8, f0 * 1.4)[:N]; am = np.clip(np.sin(2 * np.pi * rng.uniform(1.5, 4) * T + rng.uniform(0, 6)), 0, 1) ** 2 * np.clip(np.sin(2 * np.pi * rng.uniform(.15, .4) * T + rng.uniform(0, 6)), 0, 1)
    mur += seg * am
mg = envp([(0, 0), (B(12), 0), (B(12) + .5, .25), (B(19), .4), (B(19) + .2, .65), (B(19.5), .6), (B(19.5) + .015, 0), (B(21), 0), (B(21) + .8, .18), (DUR, .2)])
amb[:, 0] += mur * mg * .7; amb[:, 1] += np.roll(mur, 700) * mg * .7

# ———————————————————————— 拟音（从 window.EV 驱动） ————————————————————————
fol = np.zeros((N, 2))
def crack(v=1.0):
    d = .5; x = hp(noise(d), 1500) * env_exp(d, .05) + bp(noise(d), 300, 3000) * env_exp(d, .12) * .6
    return norm(x) * v
def thunder(v=1.0):
    d = 3.2; tt = t_(d); x = lp(brown(d), 160) * np.minimum(1, tt / .25) * env_exp(d, 1.0) + lp(noise(d), 600) * env_exp(d, .25) * .4 + lp(noise(d), 1200) * env_exp(d, .05) * .9
    return norm(x) * v
def plip(v=1.0):
    d = .25; tt = t_(d); f = 1500 * np.exp(-tt / .03) + 380; x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .05)
    return norm(x + hp(noise(d), 4000) * env_exp(d, .004) * .3) * v
def fwump(v=1.0):   # 纸灯点着：一口气的火
    d = .45; tt = t_(d); x = lp(noise(d), 1500) * np.minimum(1, tt / .015) * env_exp(d, .09) + np.sin(2 * np.pi * 95 * tt * (1 - .4 * tt)) * env_exp(d, .07) * .5
    return norm(x) * v
def crackle(d, v=1.0):
    x = np.zeros(int(d * SR)); k = rng.integers(0, len(x), int(d * 40)); x[k] = rng.uniform(.3, 1, len(k)); return norm(bp(x, 1500, 6000)) * v
def tick(v=1.0):
    d = .05; tt = t_(d); return norm(np.sin(2 * np.pi * 3200 * tt) * env_exp(d, .008) + hp(noise(d), 5000) * env_exp(d, .003)) * v
def boom(v=1.0):    # 灯塔点燃：低沉的"轰" + 空气 + 高处微光
    d = 3.0; tt = t_(d)
    sub = np.sin(2 * np.pi * np.cumsum(62 * np.exp(-tt / .6) + 40) / SR) * env_exp(d, .9)
    air = bp(noise(d), 200, 2500) * env_exp(d, .35) * .5
    shim = sum(np.sin(2 * np.pi * f * tt + p) * env_exp(d, .9) for f, p in [(2349, 0), (3136, 1), (4699, 2), (3729, 3)]) * .12 * np.minimum(1, tt / .3)
    ig = np.zeros(len(tt)); g0 = ignite(1); ig[:len(g0)] = g0[:len(tt)]
    return norm(sub + air + shim + .6 * ig) * v
def hum(d, v=1.0):
    tt = t_(d); x = (np.sin(2 * np.pi * 55 * tt) + .5 * np.sin(2 * np.pi * 110 * tt) + .25 * np.sin(2 * np.pi * 165 * tt)) * (1 + .3 * np.sin(2 * np.pi * .9 * tt))
    return x * np.minimum(1, tt / .5) * v
def flap(v=1.0):    # 帆布"啪"地展开
    d = .4; tt = t_(d); x = bp(noise(d), 250, 2500) * env_exp(d, .06) + bp(noise(d), 120, 600) * env_exp(d, .12) * .8
    for k in (.05, .11): s = int(k * SR); x[s:] += bp(noise(d), 400, 3000)[:len(x) - s] * env_exp(d - k, .03)[:len(x) - s] * .5
    return norm(x) * v
def rustle(v=1.0):
    d = .3; return norm(bp(noise(d), 1500, 6000) * np.sin(np.pi * t_(d) / d) ** 2) * v
def wash(d, v=1.0):
    tt = t_(d); return norm(bp(noise(d), 300, 2500)) * np.minimum(1, tt / .6) * (.7 + .3 * np.sin(2 * np.pi * 1.1 * tt)) * v

def at(name): return next(e['t'] for e in EV if e['type'] == name)
add(fol, ding(.18), at('cardIn'), .5, -.6)
add(fol, crack(1), at('lightning'), .9, .3); add(fol, crack(.6), at('lightning') + .2, .6, .35)
add(fol, thunder(1), at('thunder'), 1.0, .1)
add(fol, whoosh(1.4, 1), at('cloudGo') - .25, .7, -.4)
add(fol, whoosh(1.0, .7), at('sunLH') - .2, .4, .3)
add(fol, plip(1), at('rainHalf'), .45, .5); add(fol, tick(1), at('rainHalf'), .15, .5)   # 雨势收窄：右边一声水滴
add(fol, rustle(.6), B(12.4), .35, -.2)                                     # 摊主举杆
add(fol, plip(1), at('drip'), .6, -.1)                                       # 最后一滴雨落在灯笼上
for e in EV:
    if e['type'] == 'pop':
        p = e.get('pan', 0); g_ = 1 - e['i'] * .035
        add(fol, fwump(1), e['t'], .55 * g_, p); add(fol, tick(1), e['t'], .25 * g_, p)
        add(fol, crackle(DUR - e['t'], 1) * envp([(0, 1), (DUR, 1)])[:int((DUR - e['t']) * SR)], e['t'] + .08, .05, p)
add(fol, sum(np.pad(tick(1), (int(k * .012 * SR), int(.5 * SR)))[:int(.5 * SR)] for k in range(30)), at('festoon'), .35, 0)   # 整串彩灯一齐"嗒"
# 静默：所有拟音在 13.000 s 截断
fol[int(at('stop') * SR):int(at('cut2') * SR)] = 0
add(fol, boom(1), at('cut2'), 1.15, 0)                                       # 全片最重要的一声
for k, dt in enumerate((.06, .12, .2)): add(fol, tick(1), at('cut2') + dt, .3, -.3)
add(fol, hum(DUR - at('beam'), 1), at('beam'), .1, -.3); add(fol, tick(1), at('beam'), .3, -.3)   # 灯罩开转的机括声
for k, tb in enumerate((B(22.4), B(22.6), B(22.85))): add(fol, creak(.8), tb, .4, .2)   # 拉帆绳
add(fol, flap(1), at('sail'), .9, .1)
add(fol, wash(DUR - at('sail'), 1), at('sail') + .2, .18, .1)
for tb in (B(24.3), B(26.2)): add(fol, creak(.6), tb, .3, .15)
add(fol, whoosh(.9, 1), at('beamHit') - .45, .55, -.2)
add(fol, ding(.15), at('beamHit'), .35, 0)

# ———————————————————————— 混音 ————————————————————————
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-12)
def db(x): return 20 * np.log10(rms(x))
music *= 10 ** ((-19 - db(music)) / 20)
amb *= 10 ** ((-29 - db(amb)) / 20)
fol *= 10 ** ((-25 - db(fol)) / 20)
mix = music + amb + fol
mix = np.tanh(mix * 1.1) / 1.1
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
fade = int(.35 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
for nm, x in [('music', music), ('amb', amb), ('foley', fol)]: sf.write(os.path.join(HERE, 'out', 'stems', nm + '.wav'), x.astype(np.float32), SR)
json.dump(CUE_LOG, open(os.path.join(HERE, 'out', 'score_cues.json'), 'w'), indent=1)
# 低频检查：20–120 Hz 相对其余频段
spec = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fr = np.fft.rfftfreq(len(mix), 1 / SR)
lo = spec[(fr > 20) & (fr < 120)].sum(); rest = spec[(fr >= 120) & (fr < 16000)].sum()
print(f'mix.wav {len(mix) / SR:.3f}s  music {db(music):.1f} amb {db(amb):.1f} foley {db(fol):.1f} dB  low/rest {10 * np.log10(lo / rest):.1f} dB')
print('instruments:', sorted({e['inst'] for e in ev}))
