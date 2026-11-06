"""方案 C《打开》20 秒开头：配乐（国风电子放克，120 BPM，E 羽五声）+ 拟音 + 环境，全部从 events.json（timeline.js 导出）生成。
输出 out/mix.wav（48 kHz 立体声）与 out/cues.json（每条卡点声音的计划时刻与分轨实测起音，给 tools/cuecheck.py）。
运行：$LIB/.venv/bin/python mix.py"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, noise, brown, bp, lp, hp, env_exp, t_, norm, limit
S.seed(5)
R = np.random.default_rng(31)

EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EVJ['dur']; EV = EVJ['ev']
BPM = 120; BEAT = 60 / BPM; E16 = BEAT / 4
def bt(bar, beat=1, s16=0): return (bar - 1) * 4 * BEAT + (beat - 1) * BEAT + s16 * E16
def evs(typ): return [e for e in EV if e['type'] == typ]
def ev1(typ): return evs(typ)[0]['t']
N = int(round(DUR * SR))
bus = {k: np.zeros((N, 2), np.float32) for k in ('drums', 'music', 'lead', 'sfx', 'amb')}
CUES = []

def onset_index(x, db=-30):
    a = np.abs(x); return int(np.argmax(a > a.max() * 10 ** (db / 20)))
def put(name, x, at, gain=1.0, pan=0.0, busn='sfx', cue=True):
    """把单声道 x 放到 at 秒。cue=True：把起音（峰值 −30 dB 处）对准 at，并记下给对拍检查"""
    x = np.asarray(x, np.float32)
    if cue:
        i = onset_index(x); at0 = at - i / SR
        CUES.append({'name': name, 'plan': round(at, 4), 'x': x * gain, 'at0': at0})
        at = at0
    add(bus[busn], x, at, gain, pan)
def fade(x, fi=.003, fo=.01):
    x = np.array(x, np.float32); a, z = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if z and z < len(x): x[-z:] *= np.linspace(1, 0, z)
    return x
def pitchenv(x, semis):
    """时变移调：semis(t) 半音（数组，长度同 x），用相位累积重采样"""
    rate = 2 ** (semis / 12); ph = np.cumsum(rate); ph -= ph[0]
    ph = ph[ph < len(x) - 1]; return np.interp(ph, np.arange(len(x)), x).astype(np.float32)

# ———————————————— 乐器 ————————————————
def suona(pitch, dur, vel=.8, scoop=-1.5, scoop_t=.06, vib=(5.6, .28, .14), slide_from=None, slide_t=.09, fall=0.0, swell=False):
    """唢呐感：双簧管采样 + 滑音/颤音/尾音下滑 + 过载 + 1–3.5 kHz 鼻音峰"""
    src = S.note('oboe', pitch, dur + .25, vel)
    n = len(src); tt = np.arange(n) / SR
    st = np.zeros(n)
    if slide_from is not None:   # 从另一个音滑上来（半音差）
        st += np.where(tt < slide_t, slide_from * np.clip(1 - tt / slide_t, 0, 1) ** 1.5, 0)
    elif scoop:
        st += np.where(tt < scoop_t, scoop * np.clip(1 - tt / scoop_t, 0, 1) ** 2, 0)
    f, d, t0 = vib; st += np.where(tt > t0, d * np.minimum(1, (tt - t0) / .15) * np.sin(2 * np.pi * f * (tt - t0)), 0)
    if fall: st += np.where(tt > dur - .12, fall * ((tt - (dur - .12)) / .2) ** 2, 0)
    y = pitchenv(src, st)
    y = np.tanh(y * 3.2) / np.tanh(3.2)
    y = y * .55 + bp(y, 1000, 3500) * 1.1 + hp(y, 3500) * .25
    if swell: y *= np.linspace(.55, 1.15, len(y)) ** 1.4
    return fade(y, .004, .03)

def erhu(pitch, dur, vel=.6, slide_from=None):
    x = S.note('erhu', pitch, dur, vel, attack=.03)
    if slide_from is not None:
        tt = np.arange(len(x)) / SR; st = np.where(tt < .14, slide_from * np.clip(1 - tt / .14, 0, 1) ** 1.6, 0)
        st += np.where(tt > .25, .18 * np.sin(2 * np.pi * 5.2 * (tt - .25)), 0); x = pitchenv(x, st)
    return fade(x, .01, .05)

# ———————————————— 拟音（纸、印刷、木、金属）————————————————
def tss(d):
    """鸭嘴笔划线：细高频摩擦，随线长线性展开"""
    n = bp(noise(d + .04), 3500, 11000); e = np.minimum(1, t_(d + .04) / .01) * np.r_[np.ones(int(d * SR)), np.linspace(1, 0, len(n) - int(d * SR))]
    return n * e * (.8 + .2 * np.sin(2 * np.pi * 31 * t_(d + .04)))
def press(size, v=1.0):
    """铅字落纸：干脆的木块 + 低频"咚"（字越大越低越重）"""
    wb = S.hit('woodblock', ['c', 'b', 'a', 'a', 'a'][min(size, 4)], .55 + .1 * size)
    f0 = [210, 170, 120, 90, 70][min(size, 4)]; d = .22; tt = t_(d)
    body = np.sin(2 * np.pi * f0 * tt * (1 - .4 * tt)) * env_exp(d, .035 + .012 * size)
    tr = hp(noise(d), 2500) * env_exp(d, .0012)
    L = max(len(wb), len(body)); out = np.zeros(L)
    out[:len(wb)] += wb * .7; out[:len(body)] += body * (.35 + .12 * size); out[:len(tr)] += tr * .25
    return norm(out) * v
def stamp(pitch=1.0):
    """橡皮章：闷"嘭" + 纸拍"""
    d = .2; tt = t_(d)
    body = np.sin(2 * np.pi * 150 * pitch * tt * (1 - .5 * tt)) * env_exp(d, .03)
    slap = bp(noise(d), 600, 3500) * env_exp(d, .008)
    return norm(body * .9 + slap * .6)
def switch():
    """台灯金属开关：两段"咔哒" """
    d = .09; tt = t_(d); out = np.zeros(int(d * SR))
    for k, (o, f) in enumerate([(0, 2400), (.018, 1700)]):
        s = int(o * SR); L = int(.04 * SR); u = np.arange(L) / SR
        c = hp(noise(.04), 1800) * np.exp(-u / .0015) + np.sin(2 * np.pi * f * u) * np.exp(-u / .005) * .6 + np.sin(2 * np.pi * 320 * u) * np.exp(-u / .01) * .4
        out[s:s + L] += c * (1 if k == 0 else .6)
    return norm(out)
def swish(d=.4):
    """翻封面的纸板"唰"：带通噪声上扫，止于落点"""
    n = noise(d); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        hi = min(L, i + 480); f = 500 + 3500 * (i / L) ** 1.6; out[i:hi] = bp(n[max(0, i - 2000):hi], f * .6, f * 1.5)[-(hi - i):]
    e = (np.arange(L) / L) ** 2
    return norm(out * e)
def board(v=1.0):
    """硬纸板落定"嘭" """
    d = .35; tt = t_(d)
    return norm(np.sin(2 * np.pi * 85 * tt * (1 - .3 * tt)) * env_exp(d, .06) + lp(noise(d), 500) * env_exp(d, .018) * .8 + bp(noise(d), 1500, 5000) * env_exp(d, .004) * .4) * v
def creak(d=.25):
    tt = t_(d); f0 = 85
    saw = 2 * ((np.cumsum(np.full(len(tt), f0 * (1 + .25 * np.sin(2 * np.pi * 7 * tt)))) / SR) % 1) - 1
    return norm(bp(saw, 500, 2600) * np.abs(np.sin(2 * np.pi * 19 * tt)) ** 3 * np.sin(np.pi * tt / d))
def popup(pitch=1.0):
    """立体书"啵"：短正弦下滑 + 纸褶噪声"""
    d = .16; tt = t_(d); f = (900 - 500 * tt / d) * pitch
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .035)
    crink = bp(noise(d), 2000, 7000) * env_exp(d, .02) * (1 + .6 * np.sin(2 * np.pi * 90 * tt))
    tr = hp(noise(d), 3000) * env_exp(d, .001)
    return norm(tone * .8 + crink * .45 + tr * .3)
def tick(pitch=1.0, v=1.0):
    d = .04; tt = t_(d)
    return norm(hp(noise(d), 2500) * env_exp(d, .0012) + np.sin(2 * np.pi * 2600 * pitch * tt) * env_exp(d, .004) * .7 + np.sin(2 * np.pi * 900 * pitch * tt) * env_exp(d, .006) * .4) * v
def rasp(d=.5):
    """拉片的木头摩擦：周期性颗粒摩擦经木腔共鸣，起音干脆"""
    tt = t_(d); L = len(tt); out = np.zeros(L)
    rate = 38 + 14 * np.sin(np.pi * tt / d)
    ph = np.cumsum(rate) / SR; idx = np.where(np.diff(np.floor(ph)) > 0)[0]
    for i in idx:
        g = int(.006 * SR); u = np.arange(g) / SR
        if i + g < L: out[i:i + g] += R.standard_normal(g) * np.exp(-u / .0015) * (.6 + .4 * R.random())
    body = bp(out, 450, 1800) * 1.3 + bp(out, 2200, 5000) * .5
    e = np.minimum(1, tt / .004) * np.minimum(1, (d - tt) / .08)
    att = np.zeros(L); n = int(.03 * SR); att[:n] = hp(R.standard_normal(n), 1200) * np.exp(-np.arange(n) / SR / .004)
    return norm(body * e + att * .8)
def slide(d=.25):
    """纸片滑出"嘘"：渐强，到点"""
    n = bp(noise(d), 1500, 7000); return n * (np.arange(len(n)) / len(n)) ** 1.8

# ———————————————— 拟音落位 ————————————————
for e in evs('rule'):
    put('rule', tss(e['dur']), e['t'], .05 if e['dir'] == 'h' else .035, -.6 + 1.2 * R.random())
for e in evs('num'):
    sz = e['size']; put('num', press(sz), e['t'], .62 + .05 * sz, [-.45, .5, -.35, -.5, -.3, -.1][e['i']])
    if e.get('signal'):   # 25：全片唯一"会唱"的落点
        put('num25', S.note('glockenspiel', 'E6', .8, .55), e['t'], .32, .5, busn='music')
put('slide', slide(ev1('reflow') - ev1('slide')) * .5, ev1('slide'), .25, 0, cue=False)
put('reflow', press(2), ev1('reflow'), .7, -.1)
t25 = ev1('reflow25')
put('reflow25', S.note('glockenspiel', 'B5', .7, .5), t25, .28 * 10 ** (5 / 20), .45, busn='music')   # 返修：+5 dB，混音里要听得见
for e in evs('title'):
    put('title', stamp([1, 1.12, 1.26][e['i']]), e['t'], .62, [-.3, 0, .3][e['i']])
put('lamp', switch(), ev1('lamp'), .55, -.55)
put('cover_lift', creak(.3), ev1('cover_lift'), .12, 0)
t_open = ev1('open')
sw = swish(.42); add(bus['sfx'], sw, t_open - len(sw) / SR, .3, .1)
put('open', board(), t_open, .75, 0)
for e in evs('fold'):
    put('fold', popup([.85, 1.0, 1.15][e['i']]), e['t'], .5, [0, -.35, .2][e['i']])
for e in evs('card'):
    put('card', popup([1.3, 1.45, 1.6][e['i']]), e['t'], .45, [-.4, 0, .4][e['i']])
    put('card_pipa', P.pluck('pipa', e['note'], .9, .8), e['t'], .5, [-.4, 0, .4][e['i']], busn='music')
put('label', popup(1.9), ev1('label'), .3, 0)
for e in evs('type'):
    put('type', tick(1 + .06 * ((e['i'] * 5) % 7), .9), e['t'], .32, -.25 + .05 * e['i'])
t_pull = ev1('pull')
put('pull', rasp(evs('pull')[0]['dur'] + .05), t_pull, .62, .35)
def cloud_tap(k):
    """纸云落定"嗒"：低木块 + 亮的纸边咔嗒（3–9 kHz），在完整主题里也要穿得出来"""
    d = .06; tt = t_(d)
    body = tick(.55, 1) * .8
    snap = bp(noise(d), 3000, 9000) * env_exp(d, .0025)
    tone = np.sin(2 * np.pi * (1650 + 250 * k) * tt) * env_exp(d, .009)
    out = np.zeros(max(len(body), len(snap))); out[:len(body)] += body; out[:len(snap)] += snap * .9; out[:len(tone)] += tone * .45
    return norm(out)
for e in evs('cloud'):
    s = fade(slide(.25), .003, .012); add(bus['sfx'], s, e['t'] - .035 - len(s) / SR, .18 * 10 ** (4 / 20), [-.3, .3, 0][e['i']])   # "嘘" +4 dB，提前 35 ms 收住，让"嗒"有干净的起音
    put('cloud', cloud_tap(e['i']), e['t'], .3 * 10 ** (7 / 20), [-.3, .3, 0][e['i']])                         # "嗒" +7 dB + 高频
t_part = ev1('part')
s = fade(slide(.24), .003, .012); add(bus['sfx'], s, t_part - .035 - len(s) / SR, .14, 0)                                                   # 三张卡片让路：纸面平推"沙"，止于第一齿
put('part', tick(.62, 1) * .6, t_part, .22, -.2)
for e in evs('tick'):
    put('tick', tick(.75 + .03 * e['i'], 1), e['t'], .3, 0)

# ———————————————— 环境 ————————————————
amb = bus['amb']; tt = np.arange(N) / SR
t_hum = ev1('hum_in'); t_lamp = ev1('lamp')
paper = bp(noise(DUR), 4000, 11000) * .0016 * np.clip(1 - (tt - t_lamp) / .4, 0, 1)        # 纸面底噪：几乎听不见的纤维沙沙
room = lp(brown(DUR), 300) * .05 * np.clip((tt - t_hum) / .8, 0, 1) ** 1.5
hum = (np.sin(2 * np.pi * 50 * tt) * .5 + np.sin(2 * np.pi * 100 * tt) * .35 + np.sin(2 * np.pi * 150 * tt) * .12) * .006
hum *= np.clip((tt - t_hum) / .5, 0, 1) * (1 + .25 * np.clip((tt - t_lamp) / .05, 0, 1))
for ch in (0, 1): amb[:, ch] += (paper + room + hum).astype(np.float32)
clock = tick(.5, 1) * .5
for k in range(int(t_lamp / BEAT), int(DUR / BEAT)): add(amb, lp(clock, 3000), k * BEAT, .03, .7)

# ———————————————— 配乐 ————————————————
dr = []    # (t, inst, var, vel, pan)
def D(t, v, vel, pan=0, inst='drum_kit'): dr.append((t, inst, v, vel, pan))
# 前奏：拍手 2、4 拍（第 1–3 小节）；第 3 小节加闭镲八分
for bar in (1, 2, 3):
    for beat in (2, 4): D(bt(bar, beat), 'solo', .8, .15, 'claps')
for k in range(8): D(bt(3) + k * .25, 'closed', .3 + .12 * (k % 2 == 0), -.2, 'hihat')
# 第 4 小节：最后一拍鼓组加花（通通鼓十六分 + 军鼓）
for k, tm in enumerate(['tom_1', 'tom_2', 'tom_3', 'tom_4']): D(bt(4, 4, k), tm, .62 + .08 * k, [.35, .1, -.15, -.35][k])
D(bt(4, 4, 3), 'snare_1', .55, 0)
# 放克律动
KICK = [0, 3, 6, 10, 11]; GHOST = [7, 9, 15]
def groove(bar, last=16, fill=False):
    t0 = bt(bar)
    for s in range(last):
        t = t0 + s * E16
        if s in KICK: D(t, 'kick_drum_left', .85 if s == 0 else .7, 0)
        if s in (4, 12): D(t, 'snare_1', .78, .05); D(t, 'group', .5, -.1, 'claps')
        if s in GHOST: D(t, 'snare_rest_1', .22, .05)
        if s == 14: D(t, 'hi_hat_open', .42, -.25)
        elif s != 15: D(t, 'hi_hat_closed', .48 if s % 2 == 0 else .3, -.25)
for bar in (5, 6, 7): groove(bar)
groove(8, last=12)                       # 第 8 小节最后一拍：全静
for bar in (9, 10): groove(bar, last=16 if bar == 9 else 12)
D(bt(5), 'crash_left', .8, .3); D(bt(9), 'crash_right', .85, -.3); D(bt(7), 'ride_bell_left', .4, .3)
# 结尾：第 10 小节最后一拍军鼓滚奏渐强，不收
for k in range(12): D(bt(10, 4) + k * E16 / 3, 'snare_1', .35 + .045 * k, 0)
D(bt(10, 4), 'crash_left', .35, .3)
for t, inst, v, vel, pan in dr:
    x = S.hit(inst, v, vel); put('drum', x, t, .8 if inst == 'drum_kit' else (1.1 if inst == 'claps' else .7), pan, busn='drums', cue=False)

# 贝斯
BA = [(0, 'E1', 2, .9), (3, 'E1', 1, .45), (4, 'E2', 1, .8), (6, 'D2', 1, .7), (7, 'E2', 1, .8), (10, 'G1', 1, .8), (11, 'A1', 1, .75), (12, 'B1', 2, .85), (14, 'D2', 1, .7), (15, 'E2', 1, .6)]
BB = [(0, 'E1', 2, .9), (3, 'E1', 1, .45), (4, 'E2', 1, .8), (6, 'G1', 1, .7), (7, 'A1', 1, .8), (8, 'B1', 2, .8), (10, 'D2', 1, .75), (11, 'E2', 1, .8), (12, 'D2', 1, .7), (13, 'B1', 1, .7), (14, 'A1', 1, .7), (15, 'G1', 1, .7)]
def bass(bar, pat, last=16):
    for s, p, d, v in pat:
        if s >= last: continue
        x = S.note('electric_bass', p, d * E16 * .92, v, release=.04)
        x = np.tanh(x * 1.6) / np.tanh(1.6) + hp(x, 200) * .3          # 2、3 次谐波，小喇叭上也听得到
        put('bass', fade(x, .002, .02), bt(bar) + s * E16, .62, 0, busn='music', cue=False)
put('bass', fade(S.note('electric_bass', 'E1', 1.4, .55, release=.3), .02, .2), bt(4, 2), .45, 0, busn='music', cue=False)
for bar, pat in [(5, BA), (6, BB), (7, BA), (8, BB), (9, BA)]: bass(bar, pat, last=12 if bar == 8 else 16)
BEND = [(0, 'E1', 2, .9), (3, 'E1', 1, .45), (4, 'E2', 1, .8), (6, 'D2', 1, .7), (7, 'E2', 1, .8), (8, 'G1', 2, .8), (10, 'A1', 1, .75), (11, 'B1', 1, .8), (12, 'B1', 1, .8), (13, 'D2', 1, .8), (14, 'E2', 1, .85), (15, 'G2', 1, .85)]
bass(10, BEND)

# 琵琶反拍（第 5–10 小节，第 8 小节最后一拍除外）
for bar in (5, 6, 7, 8, 9, 10):
    for s in (2, 10):
        put('pipa', P.strum('pipa', ['B4', 'E5'], .3, .5, spread=.012), bt(bar) + s * E16, .35, -.35, busn='music', cue=False)
# 筝：第 4 小节五声上行刮奏
GL = ['E3', 'G3', 'A3', 'B3', 'D4', 'E4', 'G4', 'A4', 'B4', 'D5', 'E5', 'G5', 'A5', 'B5']
for k, p in enumerate(GL):
    put('zheng', S.note('dan_tranh', p, 1.2, .35 + .03 * k), bt(4, 2) + k * (1.0 / len(GL)), .4, -.5 + k / len(GL), busn='music', cue=False)
# 筝：第 6 小节末下行小过门
for k, p in enumerate(['E5', 'D5', 'B4', 'A4']): put('zheng', S.note('dan_tranh', p, .5, .5), bt(6, 4) + k * E16, .4, .4, busn='music', cue=False)
# 长笛：第 6 小节一句短花音
for k, (p, d) in enumerate([('G5', .125), ('A5', .125), ('B5', .125), ('D6', .375)]):
    put('flute', fade(S.note('flute', p, d, .55), .005, .03), bt(6, 3, 2) + k * E16, .3, .35, busn='music', cue=False)
# 二胡对位（第 7–8 小节）
for t, p, d, sl in [(bt(7, 1), 'B4', .5, -2), (bt(7, 2), 'A4', .5, None), (bt(7, 3), 'G4', 1.0, -2), (bt(8, 1), 'E4', 1.0, -1.5), (bt(8, 3), 'D4', .45, None), (bt(8, 3, 2), 'E4', .25, -2)]:
    put('erhu', erhu(p, d, .55, sl), t, .5, -.3, busn='music', cue=False)

# 唢呐感主旋律
lead = []
lead += [(bt(2, 1), 'E5', .25, dict(scoop=-2)), (bt(2, 1, 2), 'G5', .25, {}), (bt(2, 2), 'A5', .45, dict(fall=-1.5))]   # 呼
lead += [(bt(3, 1), 'D5', .25, {}), (bt(3, 1, 2), 'E5', .25, {}), (bt(3, 2), 'B4', .7, dict(fall=-1))]               # 应
TH = [(0, 'E5', 3, dict(slide_from=-2)), (3, 'G5', 1, {}), (4, 'A5', 2, {}), (6, 'G5', 1, {}), (7, 'E5', 1, {}), (8, 'D5', 2, {}), (10, 'E5', 2, {}), (12, 'B4', 4, {}),
      (16, 'E5', 2, {}), (18, 'G5', 2, {}), (20, 'A5', 2, {}), (22, 'B5', 2, dict(slide_from=-2)), (24, 'D6', 3, dict(slide_from=-3, slide_t=.12)), (27, 'B5', 1, {}), (28, 'B5', 4.2, dict(swell=True))]
for s, p, d, kw in TH: lead.append((bt(9) + s * E16, p, d * E16 * .95, kw))
for t, p, d, kw in lead:
    put('suona', suona(p, d, .78, **kw), t, .15, .12, busn='lead', cue=False)
# 二胡低八度轻轻托住主题（第 9–10 小节）
for s, p, d, kw in TH:
    q = {'E5': 'E4', 'G5': 'G4', 'A5': 'A4', 'B5': 'B4', 'D6': 'D5', 'D5': 'D4', 'B4': 'B4'}[p]
    put('erhu2', erhu(q, d * E16 * .95, .4, kw.get('slide_from')), bt(9) + s * E16, .22, -.35, busn='music', cue=False)
# 结尾：筝摇指 + 第 9 小节小锣
put('gong', S.hit('gong2', 'small', .55), bt(9), .35, .4, busn='music', cue=False)
put('zheng_trem', S.note('dan_tranh_trem', 'B4', 1.1, .4, attack=.3), bt(10, 2, 2), .3, -.4, busn='music', cue=False)

# ———————————————— 一拍静默：第 8 小节第 4 拍，所有音乐停 ————————————————
t_sil = ev1('silence'); g = np.ones(N, np.float32)
a, b = int(t_sil * SR), int(t_pull * SR) - int(.004 * SR)
g[a:b] = 0; g[a - int(.03 * SR):a] = np.linspace(1, 0, int(.03 * SR))
for k in ('drums', 'music', 'lead'): bus[k] *= g[:, None]
# ———————————————— 侧链闪避：三层纸云落定的 40 ms 里，主旋律与民乐让开 ————————————————
duck = np.ones(N, np.float32)
for tt_ in [e['t'] for e in evs('cloud')] + [ev1('part')]:
    i0 = int(tt_ * SR); a_, h_, r_ = int(.006 * SR), int(.07 * SR), int(.04 * SR); dep = 10 ** (-10 / 20)
    env = np.r_[np.linspace(1, dep, a_), np.full(h_, dep), np.linspace(dep, 1, r_)].astype(np.float32)
    s0 = i0 - int(.03 * SR); duck[s0:s0 + len(env)] = np.minimum(duck[s0:s0 + len(env)], env)   # 落点前 30 ms 先让开，起音更干净
for k in ('music', 'lead'): bus[k] *= duck[:, None]

# ———————————————— 混音 ————————————————
def room(x, size, mix): return S.room(x, size=size, mix=mix)
drums = room(bus['drums'], .25, .08); music = room(bus['music'], .4, .14); lead_b = room(bus['lead'], .45, .16)
for k in ('drums', 'music', 'lead'): pass
# 静默拍里混响尾巴也要停
drums *= g[:, None]; music *= (g * duck)[:, None]; lead_b *= (g * duck)[:, None]
STEMS = {'drums': drums, 'music': music, 'lead': lead_b, 'sfx': bus['sfx'], 'amb': bus['amb']}
if os.environ.get('STEMS'):
    os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
    for k, v in STEMS.items(): sf.write(os.path.join(HERE, 'out', 'stems', k + '.wav'), v, SR, subtype='FLOAT')
mix = drums * 1.0 + music * .95 + lead_b * 1.05 + bus['sfx'] * 1.0 + bus['amb'] * 1.0
# 低频平衡：20–120 Hz 不要过重
low = np.stack([lp(mix[:, c], 120) for c in (0, 1)], 1)
mix = mix - low * .25
mix[-int(.01 * SR):] *= np.linspace(1, 0, int(.01 * SR))[:, None]     # 20.0 s 处被"剪断"，只留 10 ms 防爆音
pk = np.abs(mix).max(); mix = mix / pk * .89 * 10 ** (5.0 / 20)       # 先抬到接近 −14 LUFS，再用前瞻限幅压住瞬态
for _ in range(2): mix = np.stack([limit(mix[:, c], .76, .004) for c in (0, 1)], 1)
mix = mix.astype(np.float32)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
# 卡点声音：在各自"分轨"上测起音（与混音同一缩放无关，只测时刻）
out = []
for c in CUES:
    x = c['x']; i = onset_index(x); out.append({'name': c['name'], 'plan': c['plan'], 'onset': round(c['at0'] + i / SR, 5)})
json.dump(out, open(os.path.join(HERE, 'out', 'cues.json'), 'w'), ensure_ascii=False, indent=0)
print('mix', mix.shape, 'peak', float(np.abs(mix).max()), 'cues', len(out))
