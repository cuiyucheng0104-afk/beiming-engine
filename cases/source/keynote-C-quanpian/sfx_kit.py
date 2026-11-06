"""全片共用音效库：每种"打开"动作一个类型，按类型调用。分章导演在 sfx/<章>.json 里写 {"type": "<类型>", ...}，mix.py 调用这里合成。
- 开头 mix.py（现 kaitou_mix.py）里的纸"唰"、"啵"、木头摩擦、打字"嗒"、开关"咔"等全部整理成函数；另补剪刀、橡皮章嘭、门轴纸响、合书啪、纸板连击、电流变化等。
- 每个函数签名 fn(r, **参数) → 单声道 float32（48 kHz），峰值归一到 1；r 是本事件自己的随机数发生器（种子 = 类型 + 时刻），所以混音结果与先后次序无关、可复现。
- KIT[类型] = Sound(fn, anchor, level, duck, 说明, 参数说明)：
    anchor 'onset' = 声音起音（峰值 −30 dB 处）对准事件时刻；'end' = 声音结束（"止于落点"的唰、嘘）对准事件时刻；
           函数 = 声音内部某一点（例如转盘最后那一下棘轮）对准事件时刻
    level  = 0 dB 时的线性增益（已按开头混音校准）；清单里的 gain 是在它之上加减的 dB
    duck   = 这一下对配乐的额外侧链闪避深度（dB，负数；0 = 只靠总线侧链）
命令行：python sfx_kit.py           列出全部类型
        python sfx_kit.py demo out.wav   每种类型各响一次（每 0.75 s 一个），试听用"""
import sys
from dataclasses import dataclass
import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000


def t_(d): return np.arange(int(round(d * SR))) / SR
def env_exp(d, tau): return np.exp(-t_(d) / tau)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, min(hi, SR / 2 - 100)], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def norm(x, p=1.0): x = np.asarray(x, np.float64); m = np.abs(x).max(); return (x * (p / m) if m > 0 else x)
def noise(r, d): return r.standard_normal(int(round(d * SR)))
def mixa(*parts):
    """把若干 (信号, 起点秒, 增益) 叠成一条"""
    L = max(int(round(o * SR)) + len(x) for x, o, g in parts); out = np.zeros(L)
    for x, o, g in parts: s = int(round(o * SR)); out[s:s + len(x)] += np.asarray(x) * g
    return out
def fade(x, fi=.003, fo=.01):
    x = np.array(x, np.float64); a, z = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if z and z < len(x): x[-z:] *= np.linspace(1, 0, z)
    return x


@dataclass
class Sound:
    fn: object
    anchor: object = 'onset'      # 'onset' | 'end' | 函数(参数) → 秒（声音里"落点"距开头的秒数）
    level: float = .5
    duck: float = 0.0
    desc: str = ''
    params: str = ''


KIT = {}
def sound(name, anchor='onset', level=.5, duck=0.0, desc='', params=''):
    def deco(fn): KIT[name] = Sound(fn, anchor, level, duck, desc, params); return fn
    return deco


# ———————————————— 纸 ————————————————
@sound('swish', anchor='end', level=.3, desc='纸的"唰"：带通噪声上扫，止于落点（翻页、封面翻起）', params='dur=.42 秒')
def swish(r, dur=.42):
    n = noise(r, dur); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        hi = min(L, i + 480); f = 500 + 3500 * (i / L) ** 1.6; out[i:hi] = bp(n[max(0, i - 2000):hi], f * .6, f * 1.5)[-(hi - i):]
    return norm(fade(out * (np.arange(L) / L) ** 2, .005, .004))

@sound('page_land', level=.42, duck=-4, desc='书页拍到书页堆上的纸拍（翻页落定）', params='v=1')
def page_land(r, v=1.0):
    d = .22; tt = t_(d)
    slap = bp(noise(r, d), 700, 4500) * env_exp(d, .012)
    body = np.sin(2 * np.pi * 120 * tt * (1 - .3 * tt)) * env_exp(d, .035)
    tr = hp(noise(r, d), 3000) * env_exp(d, .0015)
    return norm(slap * .9 + body * .6 + tr * .35) * v

@sound('board', level=.75, duck=-6, desc='硬纸板落定"嘭"（封面落定、大件立起）', params='v=1')
def board(r, v=1.0):
    d = .35; tt = t_(d)
    return norm(np.sin(2 * np.pi * 85 * tt * (1 - .3 * tt)) * env_exp(d, .06) + lp(noise(r, d), 500) * env_exp(d, .018) * .8 + bp(noise(r, d), 1500, 5000) * env_exp(d, .004) * .4) * v

@sound('creak', level=.12, desc='书脊 / 纸铰链"吱呀"', params='dur=.25')
def creak(r, dur=.25):
    tt = t_(dur); f0 = 85
    saw = 2 * ((np.cumsum(np.full(len(tt), f0 * (1 + .25 * np.sin(2 * np.pi * 7 * tt)))) / SR) % 1) - 1
    return norm(bp(saw, 500, 2600) * np.abs(np.sin(2 * np.pi * 19 * tt)) ** 3 * np.sin(np.pi * tt / dur))

@sound('pop', level=.5, duck=-4, desc='立体书"啵"：折页、卡片立起（短正弦下滑 + 纸褶噪声）', params='pitch=1（0.8–2，越大越高）')
def pop(r, pitch=1.0):
    d = .16; tt = t_(d); f = (900 - 500 * tt / d) * pitch
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .035)
    crink = bp(noise(r, d), 2000, 7000) * env_exp(d, .02) * (1 + .6 * np.sin(2 * np.pi * 90 * tt))
    tr = hp(noise(r, d), 3000) * env_exp(d, .001)
    return norm(tone * .8 + crink * .45 + tr * .3)

@sound('tick', level=.3, desc='短"嗒"（纸边、小机关）', params='pitch=1')
def tick(r, pitch=1.0, v=1.0):
    d = .04; tt = t_(d)
    return norm(hp(noise(r, d), 2500) * env_exp(d, .0012) + np.sin(2 * np.pi * 2600 * pitch * tt) * env_exp(d, .004) * .7 + np.sin(2 * np.pi * 900 * pitch * tt) * env_exp(d, .006) * .4) * v

@sound('type', level=.32, desc='打字短"嗒"（每个字一下；音高随字微变）', params='i=字序号（决定音高）')
def type_(r, i=0):
    return tick(r, 1 + .06 * ((i * 5) % 7))

@sound('paper_tap', level=.67, duck=-9, desc='纸边落定"嗒"：低木块 + 3–9 kHz 纸边咔嗒 + 短高音（满编配器里也穿得出来）', params='k=0/1/2（高音音高）')
def paper_tap(r, k=0):
    d = .06; tt = t_(d)
    body = tick(r, .55) * .8; snap = bp(noise(r, d), 3000, 9000) * env_exp(d, .0025); tone = np.sin(2 * np.pi * (1650 + 250 * k) * tt) * env_exp(d, .009)
    return norm(mixa((body, 0, 1), (snap, 0, .9), (tone, 0, .45)))

@sound('slide', anchor='end', level=.28, desc='纸片滑出"嘘"：渐强，止于落点', params='dur=.25')
def slide(r, dur=.25):
    n = bp(noise(r, dur), 1500, 7000); return norm(fade(n * (np.arange(len(n)) / len(n)) ** 1.8, .003, .012))

@sound('shuffle', anchor='end', level=.18, desc='纸面平推"沙"（卡片让位、滑动），止于落点', params='dur=.24')
def shuffle(r, dur=.24):
    n = bp(noise(r, dur), 900, 6000)
    return norm(fade(n * (.4 + .6 * np.arange(len(n)) / len(n)), .01, .012))

@sound('flap', level=.4, duck=-4, desc='纸张 / 文件夹翻开"扑"', params='size=1（0.5 小纸 – 2 大张）')
def flap(r, size=1.0):
    d = .28; tt = t_(d)
    air = lp(noise(r, d), 1200 / size) * np.sin(np.pi * np.clip(tt / .12, 0, 1)) * env_exp(d, .06)
    slap = bp(noise(r, d), 800, 5000) * np.exp(-np.clip(tt - .1, 0, None) / .01) * (tt > .1)
    return norm(air * .8 + slap * .7)

@sound('cascade', level=.45, duck=-5, desc='纸板层层弹开的连击（城市生长、纸塔弹起）：n 下"啵/嗒"逐渐升调，总长 dur', params='n=6, dur=1.0, pitch=1')
def cascade(r, n=6, dur=1.0, pitch=1.0):
    parts = []
    for k in range(int(n)):
        o = dur * (k / max(1, n - 1)) ** .85 if n > 1 else 0
        parts.append((pop(r, pitch * (.9 + .12 * k)) * .8, o, 1.0)); parts.append((board(r, .5) * .35, o, 1.0))
    return norm(mixa(*parts))

@sound('door', level=.4, duck=-4, desc='门轴纸响：纸铰链吱——再一声纸板轻拍（门打开）', params='dur=.45')
def door(r, dur=.45):
    c = creak(r, dur) * .9; t2 = page_land(r, .5) * .5
    return norm(mixa((c, 0, 1), (t2, dur * .85, 1)))

@sound('book_close', level=.9, duck=-10, desc='合书"啪"：大面积纸板拍合 + 低频 + 一口被挤出的空气', params='v=1')
def book_close(r, v=1.0):
    d = .5; tt = t_(d)
    slap = bp(noise(r, d), 400, 6000) * env_exp(d, .02)
    low = np.sin(2 * np.pi * 70 * tt * (1 - .35 * tt)) * env_exp(d, .07)
    crack = hp(noise(r, d), 2500) * env_exp(d, .002)
    puff = lp(noise(r, d), 900) * env_exp(d, .09) * .5
    return norm(slap * 1.0 + low * .9 + crack * .5 + puff) * v

# ———————————————— 木 / 机关 ————————————————
@sound('rasp', level=.62, desc='拉片的木头摩擦"嘎——"（起音干脆，dur 是拉动时长）', params='dur=.5')
def rasp(r, dur=.5):
    tt = t_(dur); L = len(tt); out = np.zeros(L)
    rate = 38 + 14 * np.sin(np.pi * tt / dur)
    ph = np.cumsum(rate) / SR; idx = np.where(np.diff(np.floor(ph)) > 0)[0]
    for i in idx:
        g = int(.006 * SR); u = np.arange(g) / SR
        if i + g < L: out[i:i + g] += r.standard_normal(g) * np.exp(-u / .0015) * (.6 + .4 * r.random())
    body = bp(out, 450, 1800) * 1.3 + bp(out, 2200, 5000) * .5
    e = np.minimum(1, tt / .004) * np.minimum(1, (dur - tt) / .08)
    att = np.zeros(L); n = int(.03 * SR); att[:n] = hp(r.standard_normal(n), 1200) * np.exp(-np.arange(n) / SR / .004)
    return norm(body * e + att * .8)

@sound('detent', level=.5, duck=-4, desc='拉片到档的木卡扣"咔哒"（第三章四个档位）', params='pitch=1')
def detent(r, pitch=1.0):
    d = .12; tt = t_(d)
    k1 = hp(noise(r, d), 1500) * env_exp(d, .002); wood = sum(a * np.sin(2 * np.pi * f * pitch * tt) * env_exp(d, tau) for f, a, tau in [(620, .7, .025), (1450, .45, .012), (2900, .25, .006)])
    return norm(mixa((k1 + wood, 0, 1), (k1 * .5, .028, 1)))

@sound('ratchet', level=.3, desc='纸轨齿 / 转盘棘轮"嗒"', params='pitch=1')
def ratchet(r, pitch=1.0):
    return tick(r, .75 * pitch)

@sound('turntable', anchor=lambda p: p.get('dur', .3) - .04, level=.35, duck=-3, desc='纸转盘转 90°：纸面摩擦 + 止于到位的棘轮（第二章 2d）', params='dur=.3')
def turntable(r, dur=.3):
    fr = bp(noise(r, dur), 600, 4000) * np.sin(np.pi * np.arange(int(round(dur * SR))) / (dur * SR)) * .5
    return norm(mixa((fr, 0, 1), (tick(r, .7), dur - .04, 1.2)))

@sound('press', level=.7, desc='铅字落纸：木块 + 低频"咚"（size 0 小 – 4 大）', params='size=2')
def press(r, size=2):
    d = .22; tt = t_(d); size = int(min(max(size, 0), 4))
    f0 = [210, 170, 120, 90, 70][size]
    body = np.sin(2 * np.pi * f0 * tt * (1 - .4 * tt)) * env_exp(d, .035 + .012 * size)
    wb = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(1100 - 120 * size, .7, .02), (2400, .3, .008)])
    tr = hp(noise(r, d), 2500) * env_exp(d, .0012)
    return norm(wb * .7 + body * (.35 + .12 * size) + tr * .25)

@sound('stamp', level=.62, duck=-4, desc='橡皮章"嘭"：闷响 + 纸拍（标题、印字）', params='pitch=1')
def stamp(r, pitch=1.0):
    d = .2; tt = t_(d)
    return norm(np.sin(2 * np.pi * 150 * pitch * tt * (1 - .5 * tt)) * env_exp(d, .03) * .9 + bp(noise(r, d), 600, 3500) * env_exp(d, .008) * .6)

@sound('stamp_ink', level=.7, duck=-6, desc='等距地面印字的橡皮章"嘭"：更重、带印泥粘离的"嗒"（第六章，一个字一下）', params='pitch=1')
def stamp_ink(r, pitch=1.0):
    d = .3; tt = t_(d)
    thud = np.sin(2 * np.pi * 110 * pitch * tt * (1 - .45 * tt)) * env_exp(d, .045)
    pad = bp(noise(r, d), 300, 2500) * env_exp(d, .012)
    peel = bp(noise(r, .05), 2500, 8000) * env_exp(.05, .006)
    return norm(mixa((thud, 0, 1), (pad, 0, .7), (peel, .09, .35)))

@sound('scissors', level=.5, duck=-4, desc='剪刀"咔嚓"：两片刀刃合拢的金属擦 + 纸被剪断（第三章剪纸，可做十六分音符节奏型）', params='v=1, open=False（True = 张开的"嚓"，更轻）')
def scissors(r, v=1.0, open=False):
    d = .09; tt = t_(d)
    blade = bp(noise(r, d), 3500, 12000) * np.exp(-tt / .018) * (1 - np.exp(-tt / .002))
    ring = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(4200, .35, .02), (6900, .2, .012)])
    cut = bp(noise(r, d), 1200, 5000) * np.exp(-np.clip(tt - .012, 0, None) / .006) * (tt > .012)
    x = blade * .7 + ring + (0 if open else cut * .9)
    return norm(x) * (v * (.55 if open else 1))

@sound('step', level=.25, desc='纸人小脚步（第六章背影小人）', params='pitch=1')
def step(r, pitch=1.0):
    d = .06; tt = t_(d)
    return norm(bp(noise(r, d), 800 * pitch, 4000) * env_exp(d, .008) + np.sin(2 * np.pi * 260 * pitch * tt) * env_exp(d, .012) * .4)

# ———————————————— 灯 / 电 ————————————————
@sound('switch', level=.55, desc='台灯金属开关"咔哒"（两段点击）')
def switch(r):
    d = .09; out = np.zeros(int(d * SR))
    for k, (o, f) in enumerate([(0, 2400), (.018, 1700)]):
        s = int(o * SR); L = int(.04 * SR); u = np.arange(L) / SR
        c = hp(noise(r, .04), 1800) * np.exp(-u / .0015) + np.sin(2 * np.pi * f * u) * np.exp(-u / .005) * .6 + np.sin(2 * np.pi * 320 * u) * np.exp(-u / .01) * .4
        out[s:s + L] += c * (1 if k == 0 else .6)
    return norm(out)

@sound('current', level=.25, desc='电流变化：灯管嗡声由 from 变到 to（含一阵细碎电流噼啪），dur 秒', params='frm=1, to=.3, dur=.6')
def current(r, frm=1.0, to=.3, dur=.6):
    tt = t_(dur); a = frm + (to - frm) * np.clip(tt / (dur * .6), 0, 1) ** .7
    hum = (np.sin(2 * np.pi * 50 * tt) * .5 + np.sin(2 * np.pi * 100 * tt) * .4 + np.sin(2 * np.pi * 150 * tt) * .25 + np.sin(2 * np.pi * 250 * tt) * .12) * a
    crackle = hp(noise(r, dur), 2500) * (r.random(len(tt)) > .9965) * np.exp(-tt / (dur * .5)) * 4
    surge = bp(noise(r, dur), 80, 400) * np.exp(-tt / .08) * .6
    return norm(fade(hum + lp(crackle, 9000) * .5 + surge, .004, .08))

@sound('lamp_switch', level=.6, duck=-5, desc='台灯调光 = 开关"咔"+电流变化（共用层在台灯变化时自动加；也可手写）', params='frm=1, to=.3')
def lamp_switch(r, frm=1.0, to=.3):
    return norm(mixa((switch(r), 0, 1), (current(r, frm, to, .7), .01, .45)))

@sound('swivel', level=.3, desc='台灯转向：金属关节摩擦 + 弹簧（共用层在台灯转向时自动加）', params='dur=.3')
def swivel(r, dur=.3):
    tt = t_(dur); f0 = 160
    saw = 2 * ((np.cumsum(np.full(len(tt), f0 * (1 + .4 * tt / dur))) / SR) % 1) - 1
    fr = bp(saw, 900, 4000) * np.abs(np.sin(2 * np.pi * 13 * tt)) ** 2 * np.sin(np.pi * tt / dur)
    spring = np.sin(2 * np.pi * 1900 * tt) * env_exp(dur, .05) * .15
    return norm(fr + spring + hp(noise(r, dur), 4000) * .03)

@sound('spot', level=.55, duck=-6, desc='追光灯"咣"一下打亮（木偶段、强调）', params='v=1')
def spot(r, v=1.0):
    d = .6; tt = t_(d)
    clunk = lp(noise(r, d), 700) * env_exp(d, .02) + np.sin(2 * np.pi * 95 * tt) * env_exp(d, .05)
    buzz = (np.sin(2 * np.pi * 100 * tt) + .4 * np.sin(2 * np.pi * 300 * tt)) * (1 - np.exp(-tt / .05)) * env_exp(d, .25) * .2
    return norm(clunk + buzz) * v

# ———————————————— 材料（第三章）————————————————
@sound('brush', anchor='end', level=.3, desc='毛笔擦纸沙沙（水墨晕开），止于落点', params='dur=.5')
def brush(r, dur=.5):
    tt = t_(dur); n = bp(noise(r, dur), 1800, 9000) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 6 * tt)))
    return norm(fade(n * np.sin(np.pi * np.clip(tt / dur, 0, 1)) ** .7, .02, .02))

@sound('sand', level=.25, desc='矿物颜料研磨的细沙声（壁画纹样生长）', params='dur=.6')
def sand(r, dur=.6):
    tt = t_(dur); grains = hp(noise(r, dur), 3000) * (r.random(len(tt)) > .97) * 3
    return norm(fade(lp(grains, 12000) + bp(noise(r, dur), 2000, 6000) * .3, .02, .05))

@sound('felt', level=.55, duck=-4, desc='毛毡 / 布幕闷"噗"', params='v=1')
def felt(r, v=1.0):
    d = .25; tt = t_(d)
    return norm(lp(noise(r, d), 600) * env_exp(d, .03) + np.sin(2 * np.pi * 130 * tt) * env_exp(d, .04) * .6) * v

@sound('burst', level=.9, duck=-12, desc='暖光迸开"轰"：低频 + 纸火呼啸（燃比娃，全片最强一下的拟音层）', params='dur=1.2')
def burst(r, dur=1.2):
    tt = t_(dur)
    sub = np.sin(2 * np.pi * 48 * tt * (1 - .2 * tt)) * env_exp(dur, .4)
    roar = lp(noise(r, dur), 1500) * env_exp(dur, .35)
    flare = bp(noise(r, dur), 2000, 9000) * env_exp(dur, .12) * .6
    return norm(sub + roar * .8 + flare)

@sound('whoosh', level=.35, desc='空气"呼"：扫频带通（镜头大动作、卡片滑过）', params='dur=.35')
def whoosh(r, dur=.35):
    n = noise(r, dur); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        hi = min(L, i + 480); f = 600 + 2600 * np.sin(np.pi * i / L); out[i:hi] = bp(n[max(0, i - 2000):hi], f * .7, f * 1.3)[-(hi - i):]
    return norm(out * np.sin(np.pi * np.arange(L) / L) ** 2)

# ———————————————— 带音高的点缀（用采样；跟作曲协调，别和主旋律撞音）————————————————
def _S():
    sys.path.insert(0, __import__('os').environ.get('LIB', '@@LEMO_ROOT@@'))
    from core.audio import sampler as S
    return S

@sound('chime', level=.3, desc='钟琴一声（纸塔窗亮起等；note 用 E 羽五声：E G A B D）', params='note="E6"')
def chime(r, note='E6'):
    return norm(_S().note('glockenspiel', note, .9, .55))

@sound('woodblock', level=.4, desc='木鱼块（木偶段节奏、梆子感）', params='var="a"')
def woodblock(r, var='a'):
    return norm(_S().hit('woodblock', var, .7))

@sound('gong', level=.35, desc='小锣一声', params='var="small"')
def gong(r, var='small'):
    return norm(_S().hit('gong2', var, .55))

@sound('pipa', level=.45, desc='琵琶一拨（物理建模）', params='note="E5"')
def pipa(r, note='E5'):
    sys.path.insert(0, __import__('os').environ.get('LIB', '@@LEMO_ROOT@@'))
    from core.audio import pluck as P
    return norm(P.pluck('pipa', note, .9, .8))


def render(typ, seed=0, **p):
    """按类型合成一条单声道声音。seed 决定随机细节（mix.py 用 类型 + 时刻 做种子）"""
    if typ not in KIT: raise KeyError(f'sfx_kit 里没有类型 "{typ}"；可用：{", ".join(sorted(KIT))}')
    r = np.random.default_rng(seed)
    return np.asarray(KIT[typ].fn(r, **p), np.float32)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'demo':
        import soundfile as sf
        names = sorted(KIT); out = np.zeros((int((len(names) * .75 + 1.5) * SR), 2), np.float32)
        for i, n in enumerate(names):
            x = render(n, i) * KIT[n].level; s = int((.3 + i * .75) * SR); out[s:s + len(x)] += x[:len(out) - s, None]
        sf.write(sys.argv[2] if len(sys.argv) > 2 else 'sfx_demo.wav', out * .8, SR); print('demo', ', '.join(names))
    else:
        for n in sorted(KIT): k = KIT[n]; print(f'{n:12s} [{k.anchor if isinstance(k.anchor, str) else "mark":5s}] level {k.level:.2f} duck {k.duck:+.0f} dB  {k.desc}  参数: {k.params or "—"}')
