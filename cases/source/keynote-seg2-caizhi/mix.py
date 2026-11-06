"""片段二「材料变奏」配乐与音效。
所有时刻来自 timeline.json（由 timeline.js 导出）：画面事件 → 声音事件一一对应，起音点落在拍上。
输出 out/mix.wav（48 kHz 立体声）与分轨 out/stem_music.wav、out/stem_foley.wav（供 cuecheck）。
D 宫五声（D E F# A B），主题动机：D4(1) E4(½) F#4(½) A4(2) | B4(1) A4(½) F#4(½) E4(1) D4(1)。
"""
import sys, os, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt

LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, compress, bp, lp, hp, t_, env_exp

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
BEAT, DUR = TL['BEAT'], TL['DUR']
b = lambda n: n * BEAT
N = int(round(DUR * SR)) + SR * 2
rng = np.random.default_rng(2026)
S.seed(7)

music = np.zeros((N, 2), np.float32)
foley = np.zeros((N, 2), np.float32)
amb = np.zeros((N, 2), np.float32)

def nz(d): return rng.standard_normal(int(round(d * SR)))
def nrm(x, p=1.0):
    m = np.abs(x).max(); return x * (p / m) if m > 0 else x
def fade(x, a=.004, r=.01):
    x = x.copy(); na, nr = int(a * SR), int(r * SR)
    if na: x[:na] *= np.linspace(0, 1, na)
    if nr: x[-nr:] *= np.linspace(1, 0, nr)
    return x
def sine(f, d, ph=0): return np.sin(2 * np.pi * f * t_(d) + ph)

# ---------------- 拟音（程序化，按材料） ----------------
def water_drop(v=1):
    d = .14; tt = t_(d)
    f = 900 + 1500 * (1 - np.exp(-tt / .012))                 # 上扬的"叮"
    tink = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .028)
    thud = lp(nz(d), 380) * env_exp(d, .018) * .6
    return nrm(fade(tink + thud, .0005)) * v

def thump(f=80, d=.35, v=1):
    tt = t_(d); fr = f * (1 + .6 * np.exp(-tt / .02))
    return nrm(np.sin(2 * np.pi * np.cumsum(fr) / SR) * env_exp(d, .09) + lp(nz(d), 300) * env_exp(d, .015) * .5) * v

def paper_crackle(d=.12, v=1):
    x = np.zeros(int(d * SR)); k = rng.integers(0, len(x) - 50, 22)
    for i in k: x[i:i + 40] += rng.standard_normal(40) * np.exp(-np.arange(40) / 8) * rng.uniform(.3, 1)
    return nrm(bp(x, 1800, 7500)) * v

def muyu(f=640, v=1):   # 木鱼：空腔木头
    d = .22; tt = t_(d)
    body = (np.sin(2 * np.pi * f * tt) * env_exp(d, .045) + .5 * np.sin(2 * np.pi * f * 2.42 * tt) * env_exp(d, .02))
    clk = hp(nz(d), 2500) * env_exp(d, .0018)
    return nrm(fade(body + clk * .5, .0003)) * v

def bangzi(v=1, f=1650):  # 梆子：硬木对击，又高又脆
    d = .12; tt = t_(d)
    x = (np.sin(2 * np.pi * f * tt) * env_exp(d, .022) + .6 * np.sin(2 * np.pi * f * 1.73 * tt) * env_exp(d, .012)
         + .35 * np.sin(2 * np.pi * f * 2.9 * tt) * env_exp(d, .007))
    clk = hp(nz(d), 3000) * env_exp(d, .0012) * .9
    return nrm(fade(x + clk, .0002)) * v

def ban(v=1):   # 拍板：两片硬木拍合
    d = .1; x = hp(nz(d), 900) * env_exp(d, .006) + np.sin(2 * np.pi * 1150 * t_(d)) * env_exp(d, .02) * .5
    return nrm(fade(x, .0002)) * v

def brush_stroke(d=.5, v=1, lo=900, hi=5200):  # 毛笔擦纸：带通噪声 + 刷毛颗粒
    n = nz(d); g = np.zeros_like(n)
    k = rng.integers(0, len(n) - 200, int(d * 260))
    for i in k: g[i:i + 120] += np.hanning(120) * rng.uniform(.2, 1)
    x = bp(n, lo, hi) * (.6 + .9 * g)
    tt = t_(d); e = np.minimum(1, tt / .03) * (1 - tt / d) ** 1.2
    return nrm(x * e) * v

def rustle_to(d, v=1):  # 长段沙沙声（几笔起伏），在 d 处干净收住
    tt = t_(d); n = nz(d); g = np.zeros_like(n)
    for i in rng.integers(0, len(n) - 200, int(d * 180)): g[i:i + 160] += np.hanning(160) * rng.uniform(.2, 1)
    x = bp(n, 700, 5500) * (.5 + g)
    sw = .55 + .45 * np.sin(2 * np.pi * tt / (BEAT * 1.0) - np.pi / 2) ** 2      # 一拍一笔的起伏
    e = np.minimum(1, tt / .25) * sw * (1 - np.clip((tt - (d - .02)) / .02, 0, 1))
    return nrm(x * e) * v

def dot(v=1, dull=False):
    d = .07; x = bp(nz(d), 1500 if not dull else 400, 5000 if not dull else 1800) * env_exp(d, .01)
    x += lp(nz(d), 300) * env_exp(d, .008) * .6
    return nrm(fade(x, .0003)) * v

def slide_to(d, v=1):  # 卷轴纸张滑开，到 d 截止
    tt = t_(d); x = bp(nz(d), 500, 3200) * (.3 + .7 * (tt / d)) * (1 + .3 * np.sin(2 * np.pi * 23 * tt))
    x *= np.minimum(1, tt / .05); x[-int(.006 * SR):] *= np.linspace(1, 0, int(.006 * SR))
    return nrm(x) * v

def wood_knock(v=1):
    d = .25; tt = t_(d)
    x = np.sin(2 * np.pi * 420 * tt) * env_exp(d, .03) + .6 * np.sin(2 * np.pi * 980 * tt) * env_exp(d, .015) + hp(nz(d), 2000) * env_exp(d, .002)
    return nrm(fade(x + thump(110, d, .5)[:len(x)], .0002)) * v

def grind(d, v=1):   # 矿物颜料研磨：细沙 + 研钵画圈
    tt = t_(d); n = nz(d); g = np.zeros_like(n)
    for i in rng.integers(0, len(n) - 400, int(d * 420)): L = rng.integers(80, 360); g[i:i + L] += rng.uniform(.3, 1) * np.hanning(L)
    x = bp(n, 2200, 9000) * g + bp(nz(d), 300, 900) * .25
    circ = .6 + .4 * np.sin(2 * np.pi * 3.2 * tt) ** 2
    e = np.minimum(1, tt / .03) * (1 - tt / d) ** .8 * circ
    return nrm(x * e) * v

def dab(v=1):  # 湿笔点色
    d = .12; x = lp(nz(d), 700) * env_exp(d, .02) + bp(nz(d), 2500, 6000) * env_exp(d, .004) * .4
    return nrm(fade(x, .0003)) * v

def whoosh_up(d, v=1):  # 纸张上扬的风声（逐渐变亮变响）
    tt = t_(d); n = nz(d); out = np.zeros_like(n); K = 8
    for k in range(K):
        a, c = k * len(n) // K, (k + 1) * len(n) // K
        f = 300 * (12 ** ((k + .5) / K)); out[a:c] = bp(n, f * .6, min(f * 1.8, 20000))[a:c]
    return nrm(out * (tt / d) ** 1.5) * v

def slap(v=1):  # 纸"啪"
    d = .2; x = hp(nz(d), 600) * env_exp(d, .007) + lp(nz(d), 220) * env_exp(d, .03) * .8
    return nrm(fade(x, .0002)) * v

def snip(v=1, k=0):  # 剪刀咔嚓：刃口摩擦扫频 + 一点金属余响 + 纤维断裂
    d = .09; tt = t_(d); n = nz(d)
    sweep = np.zeros_like(n); seg = 6
    for i in range(seg):
        a, c = i * len(n) // seg, (i + 1) * len(n) // seg; f = 2500 + 6500 * i / seg
        sweep[a:c] = bp(n, f * .8, min(f * 1.3, 22000))[a:c]
    sweep *= env_exp(d, .014)
    ring = (np.sin(2 * np.pi * (4150 + 60 * (k % 3)) * tt) * .35 + np.sin(2 * np.pi * 6230 * tt) * .2) * env_exp(d, .03)
    crack = hp(nz(d), 1500) * env_exp(d, .0012) * 1.4
    return nrm(fade(sweep + ring + crack, .0002)) * v

def scrap_tick(v=1):
    d = .03; return nrm(fade(hp(nz(d), 2500) * env_exp(d, .004), .0002)) * v

def flop(v=1):
    d = .18; return nrm(lp(nz(d), 900) * np.sin(np.pi * t_(d) / d) ** 2) * v

def snap(v=1):  # 窗扇打开"啪"
    d = .25; x = hp(nz(d), 1200) * env_exp(d, .004) * 1.2 + bp(nz(d), 300, 2500) * env_exp(d, .03) * .6
    return nrm(fade(x, .0002)) * v

def match_strike(v=1):  # 火柴：粗擦（0.42 s）→ 末尾点燃的"嗤"
    d = b(.5); tt = t_(d); n = nz(d)
    scr = bp(n, 1800, 7000) * (np.abs(np.sin(2 * np.pi * 9 * tt)) ** 3 * .7 + .3) * np.minimum(1, tt / .02)
    cr = np.zeros_like(n)
    for i in rng.integers(0, len(n) - 60, 40): cr[i:i + 50] += rng.standard_normal(50) * np.exp(-np.arange(50) / 9)
    x = scr * .7 + hp(cr, 2000) * .5
    ign = bp(nz(d), 600, 4000) * np.clip((tt - d * .6) / (d * .4), 0, 1) ** 2 * 1.3
    return nrm(x + ign) * v

def xiaoluo(v=1):  # 小锣：音高上扬的"台"
    d = 2.2; tt = t_(d)
    f0 = 880 * (1 + .07 * (1 - np.exp(-tt / .09)))
    ph = 2 * np.pi * np.cumsum(f0) / SR
    x = (np.sin(ph) * env_exp(d, .55) + .55 * np.sin(1.47 * ph + .4) * env_exp(d, .35) + .35 * np.sin(2.13 * ph) * env_exp(d, .22)
         + .2 * np.sin(2.93 * ph) * env_exp(d, .12))
    x += hp(nz(d), 3000) * env_exp(d, .004) * .6
    return nrm(fade(x, .0002, .1)) * v

def fwoomp(v=1):
    d = .6; tt = t_(d); return nrm(lp(nz(d), 260) * (tt / .08 if True else 1).clip(0, 1) * np.exp(-tt / .18)) * v

def flame_bed(d, v=1):
    tt = t_(d); x = hp(nz(d), 2500) * .25 + lp(nz(d), 140) * .6
    cr = np.zeros(len(tt))
    for i in rng.integers(0, len(cr) - 80, int(d * 6)): cr[i:i + 60] += rng.standard_normal(60) * np.exp(-np.arange(60) / 10) * rng.uniform(.3, 1)
    x = x * (1 + .3 * np.sin(2 * np.pi * 7.1 * tt)) + hp(cr, 1500) * .8
    return nrm(x * np.minimum(1, tt / .6)) * v

def cloth_thup(v=1):
    d = .16; return nrm(fade(lp(nz(d), 300) * env_exp(d, .025) + thump(70, d, .5)[:int(d * SR)], .0002)) * v

def water_bed(d, v=1):
    tt = t_(d); x = bp(nz(d), 300, 1400) * (1 + .5 * np.sin(2 * np.pi * .4 * tt)) + bp(nz(d), 1500, 4000) * .15
    return nrm(x * np.minimum(1, tt / 1.5) * np.minimum(1, (d - tt) / 1.5)) * v

# ---------------- 乐器 ----------------
def qin(pitch, dur=None, vel=.7, **kw): return P.pluck('guqin', pitch, dur, vel, **kw)
def qinh(pitch, vel=.6): return P.pluck('guqin', pitch, None, vel, harmonic=True)
def pipa(pitch, dur=None, vel=.7, **kw): return P.pluck('pipa', pitch, dur, vel, **kw)
def flute(pitch, dur, vel=.55, attack=.12):
    x = S.note('flute', pitch, dur, vel=vel, attack=attack, release=.35)
    br = bp(nz(len(x) / SR), 1800, 6000) * .05 * np.minimum(1, t_(len(x) / SR) / .1)[:len(x)]
    return x + br[:len(x)].astype(np.float32)
def erhu(pitch, dur, vel=.6): return S.note('erhu', pitch, dur, vel=vel, attack=.06, release=.3)
def zheng(pitch, vel=.6): return S.note('dan_tranh', pitch, 2.5, vel=vel)
def hit(inst, var, vel): return S.hit(inst, var, vel)

M = lambda x, at, g=1, pan=0: add(music, x, at, g, pan)
Fo = lambda x, at, g=1, pan=0: add(foley, x, at, g, pan)

# ---------------- 拟音：逐事件 ----------------
for e in TL['EV']:
    t, ty = e['t'], e['type']
    if ty == 'drop':
        Fo(water_drop(), t, .45, .1); M(qinh('D5', .62), t, .45, .15)
    elif ty == 'flute_breath':
        M(flute('F#5', .62, .5, attack=.08), t, .32, -.2)
    elif ty == 'seal':
        Fo(thump(78, .7), t, .6); Fo(paper_crackle(.1), t, .15); Fo(muyu(610), t, .75, .1)
        M(qin('D2', 4.0, .95), t, .95, -.1); M(qin('A2', 4.0, .7), t + .012, .6, .1)
        M(hit('gran_cassa', 'hit', .75), t, 1.0)
    elif ty == 'brush_rustle':
        d = e['end'] - t; Fo(rustle_to(d), t, .16, -.15)
    elif ty == 'qin_harm':
        M(qinh(e['note'], .6), t, .7, .2)
    elif ty == 'brush_write':
        Fo(brush_stroke(.5), t, .3, .2); Fo(dot(.6), t, .2)
    elif ty == 'dot':
        Fo(dot(), t, .16, .3)
    elif ty == 'dot_cloth':
        Fo(dot(dull=True), t, .22, .3)
    elif ty == 'scroll_slide':
        Fo(slide_to(e['end'] - t), t, .13, -.25)
    elif ty == 'wood_knock':
        Fo(wood_knock(), t, .26, -.25)
    elif ty == 'grind_bed':
        d = e['end'] - t; x = grind(d) * .5; x *= np.minimum(1, t_(d) / .5)[:len(x)]; add(amb, x, t, .05, 0)
    elif ty == 'grind':
        Fo(grind(e['end'] - t), t, .2, -.2)
    elif ty == 'grind_sweep':
        Fo(grind(e['end'] - t), t, .22, .2)
    elif ty == 'dab':
        Fo(dab(), t, .3, .15)
    elif ty == 'pipa_sweep':
        M(P.strum('pipa', ['D3', 'A3', 'D4', 'A4'], 1.6, .75, spread=.018), t, .38, 0)
    elif ty == 'pipa_harm':
        M(P.pluck('pipa', 'A5', None, .55, harmonic=True), t, .45, .3)
    elif ty == 'cym_brush':
        M(hit('sus_cymbal', 'hit', .25), t, .18, .3)
    elif ty == 'seal_ban':
        Fo(thump(90, .35), t, .55); Fo(ban(), t, .4, .15); Fo(paper_crackle(.08), t, .2)
    elif ty == 'paper_rise':
        Fo(whoosh_up(e['end'] - t), t, .35)
    elif ty == 'paper_slap':
        Fo(slap(), t, .5); M(hit('gran_cassa', 'hit', .55), t, .6)
    elif ty == 'snip':
        k = e['k']; Fo(snip(1, k), t, .3 + .08 * (k % 4 == 3), (-.35 + .7 * k / 19))
    elif ty == 'scrap_land':
        Fo(scrap_tick(), t, .08, rng.uniform(-.5, .5))
    elif ty == 'paper_flop':
        Fo(flop(), t, .3)
    elif ty == 'unfold_snap':
        Fo(snap(), t, .5)
    elif ty == 'zheng_gliss':
        for i, p in enumerate(['D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5', 'F#5', 'A5', 'B5', 'D6']):
            M(zheng(p, .45 + .03 * i), t + i * .028, .5, -.3 + .06 * i)
    elif ty == 'match':
        Fo(match_strike(), t, .45, -.2)
    elif ty == 'xiaoluo':
        M(xiaoluo(), t, .38, -.1)
    elif ty == 'flame_whoomp':
        Fo(fwoomp(), t, .5, -.2)
    elif ty == 'flame_bed':
        add(amb, flame_bed(e['end'] - t + .5), t, .06, -.2)
    elif ty == 'aft_hit':
        Fo(bangzi(1), t, .4, .2); M(hit('frame_drum', 'large', .7), t, .7)
    elif ty == 'cloth_thup':
        Fo(cloth_thup(), t, .35, .3); Fo(bangzi(.6, 1500), t, .2, .3)
    elif ty == 'final':
        Fo(bangzi(1.0, 1700), t, .5, .1); M(xiaoluo() * .7, t, .45, -.1)
        M(hit('frame_drum', 'large', .8), t, .7); M(qin('D3', 4, .75), t, .55); M(qinh('D4', .55), t + .003, .4, .2)

# ---------------- 音乐：段落写法 ----------------
# A7 水墨：笛的放大变奏（音值加倍，长音带气息）；古琴只落在画面事件上（见上）
for beat, p, dur, v in [(5, 'D5', 1, .5), (6, 'E5', .5, .5), (6.5, 'F#5', .5, .52), (7, 'A5', 3, .58),
                        (10, 'B5', 1, .55), (11, 'A5', .5, .52), (11.5, 'F#5', .5, .5), (12, 'E5', 1, .5), (13, 'D5', 3, .5)]:
    M(flute(p, b(dur) * .96, v), b(beat), .4, -.15)
M(qin('A3', 3, .5, bend=[(0, -2), (.25, -2), (.5, 0)]), b(8), .45, .2)
M(qin('D3', 3, .55), b(11), .4, -.1)
M(qin('F#3', 3, .5, bend=[(0, -2), (.2, -2), (.45, 0)]), b(13), .4, .15)
add(amb, water_bed(b(13.5)), b(4), .05, .2)

# A8 壁画：节拍回来；琵琶节奏化变奏（长音轮指），框鼓在拍上
for beat, p, dur, trem in [(16, 'D4', 1, 0), (17, 'E4', .5, 0), (17.5, 'F#4', .5, 0), (18, 'A4', 2, 14),
                           (20, 'B4', 1, 0), (21, 'A4', .5, 0), (21.5, 'F#4', .5, 0), (22, 'E4', 1, 0), (23, 'D4', 1, 13),
                           (24, 'A4', .5, 0), (24.5, 'B4', .5, 0), (25, 'D5', 1, 14), (26, 'A4', 1, 0)]:
    kw = dict(trem=trem) if trem else {}
    M(pipa(p, b(dur) + .3, .75, **kw), b(beat), .7, .1)
for k in range(16, 27):
    acc = (k - 16) % 4 == 0
    M(hit('frame_drum', 'large' if acc else 'small', .6 if acc else .38), b(k), .7 if acc else .45, -.05)
for k, p in [(16, 'D2'), (20, 'D2'), (24, 'A2')]:
    M(qin(p, 3.2, .7), b(k), .45, -.1)

# A9 纸：剪刀就是十六分音符的打击乐；筝唱动机第一小节（加装饰），框鼓托底
for beat, p, v in [(29, 'D5', .55), (29.75, 'E5', .4), (30, 'E5', .5), (30.5, 'F#5', .52), (31, 'A5', .6), (31.5, 'A5', .4), (32, 'A5', .45), (32.5, 'B5', .4)]:
    M(zheng(p, v), b(beat), .7, .2)
M(S.note('dan_tranh_trem', 'A5', b(1.4), vel=.45, attack=.05, release=.4), b(31), .35, .2)
for k in [28, 30, 32]:
    M(hit('frame_drum', 'large', .5), b(k), .6)
for beat, p, v in [(35, 'B4', .55), (36, 'A4', .6)]:
    M(zheng(p, v), b(beat), .5, .1)
M(qin('A2', 4, .6), b(34), .45)

# A10 偶：梆子打板，二胡唱动机第二小节落主音 D
bz = [39, 40, 40.5, 41, 41.75, 42, 42.5, 43, 43.5, 44, 44.5, 45, 45.5, 45.75, 46, 46.5]
for k in bz:
    on = abs(k - round(k)) < 1e-6
    Fo(bangzi(.9 if on else .55, 1650 if on else 1880), b(k), .3 if on else .18, .25)
M(erhu('A4', b(3) * .97, .45), b(40), .5, -.1)
for beat, p, dur, v in [(43, 'B4', 1, .62), (44, 'A4', .5, .58), (44.5, 'F#4', .5, .58), (45, 'E4', 1, .6), (46, 'D4', 1.8, .62)]:
    M(erhu(p, b(dur) * .97, v), b(beat), .55, -.1)
for k in [38, 42, 46]:
    M(hit('frame_drum', 'large', .5), b(k), .45)
M(qinh('A4', .5), b(38) + .004, .35, .25)
M(qin('D2', 5, .6), b(38), .4)

# ---------------- 混音 ----------------
music = S.room(music, size=.5, mix=.22)
foley = S.room(foley, size=.28, mix=.1)
mix = music * .95 + foley * 1.0 + amb * 1.0

# 刻意静默：b3 前收尾到 b4 之间整条总线清零（含混响尾巴）
def gate(x, t0, t1, fo=.03, fi=.001):
    a, c = int(t0 * SR), int(t1 * SR); g = np.ones(len(x))
    g[a:c] = 0; n = int(fo * SR); g[a - n:a] = np.linspace(1, 0, n); m = int(fi * SR); g[c - m:c] = np.linspace(0, 1, m)
    return x * g[:, None]
mix = gate(mix, b(3) - .03, b(4) - .0005)
music, foley = gate(music, b(3) - .03, b(4) - .0005), gate(foley, b(3) - .03, b(4) - .0005)

mix = mix[:int(round(DUR * SR))]

# 母带：测 LUFS（ffmpeg ebur128）→ 提增益 → 前瞻限幅（4 倍过采样估真峰值），迭代到 −14 LUFS、真峰值 ≤ −1.5 dBTP
import subprocess, tempfile, re
from scipy.signal import resample_poly
def measure(x):
    f = tempfile.mktemp(suffix='.wav'); sf.write(f, x.astype(np.float32), SR, subtype='FLOAT')
    r = subprocess.run(['ffmpeg', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    os.remove(f)
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1]); tp = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', r)[-1])
    return I, tp
def tlimit(x, ceil):
    y = x.copy()
    for c in range(2):
        up = resample_poly(y[:, c], 4, 1); pk = np.abs(up).reshape(-1, 4).max(1)[:len(y)]
        from scipy.ndimage import maximum_filter1d, uniform_filter1d
        n = int(.004 * SR); m = maximum_filter1d(pk, size=2 * n + 1); g = np.minimum(1, ceil / np.maximum(m, 1e-9))
        g = np.minimum(g, uniform_filter1d(g, size=n)); y[:, c] *= g
    return y
src = mix.copy(); gain = 1.0
for it in range(5):
    y = tlimit(src * gain, 10 ** (-1.8 / 20)); I, tp = measure(y)
    print(f'  master pass {it}: gain {20*np.log10(gain):+.1f} dB → {I:.1f} LUFS, TP {tp:.1f} dBTP')
    if abs(I + 14) < .15: break
    gain *= 10 ** ((-14 - I) / 20)
mix = y
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
sf.write(os.path.join(HERE, 'out', 'stem_music.wav'), music[:len(mix)].astype(np.float32), SR, subtype='FLOAT')
sf.write(os.path.join(HERE, 'out', 'stem_foley.wav'), foley[:len(mix)].astype(np.float32), SR, subtype='FLOAT')
pk = np.abs(mix).max(); rms = np.sqrt((mix ** 2).mean())
print(f'mix {len(mix)/SR:.3f}s peak {20*np.log10(pk):.1f} dBFS rms {20*np.log10(rms):.1f} dBFS')
print('\n'.join(S.credits(['flute', 'erhu', 'dan_tranh', 'dan_tranh_trem', 'frame_drum', 'gran_cassa', 'sus_cymbal'])))
