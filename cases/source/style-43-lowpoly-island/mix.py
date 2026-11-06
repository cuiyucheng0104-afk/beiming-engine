"""风车的一天 — 配乐 + 拟音 + 环境声 → out/mix.wav
读取 events.json（由页面 window.EV 导出，时间源 = timeline.js）。
乐器：卡林巴（FreePats 采样 + pluck.py 模态合成叠层）、马林巴、手铃、管钟、钟琴、木鱼、沙锤、弓奏颤音琴（VCSL / FreePats，CC0）；
numpy 合成：软 pad（失谐锯齿 + 低通）、软合成低音、风、海浪、鸟、蟋蟀、全部拟音。无钢琴、无弦乐。
输出：out/mix.wav（总混音）、out/stem_music.wav / stem_foley.wav / stem_amb.wav、out/score_events.json（每个音实际下音时刻，供 cuecheck.py 核对）
"""
import os, sys, json
import numpy as np
import soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, lp, hp, bp, noise, brown, norm, t_, env_exp, creak, thump, limit, compress

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
D = json.load(open(os.path.join(HERE, 'events.json')))
DUR = D['dur']; EV = D['ev']
META = next(e for e in EV if e['type'] == 'meta'); BEAT = META['beat']; TT = META['T']
b = lambda n: round(n * BEAT, 6)
N = int(round(DUR * SR)) + SR // 2
S.seed(43); rng = np.random.default_rng(43)
ev = lambda ty: [e for e in EV if e['type'] == ty]

mus = np.zeros((N, 2), np.float32); fol = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32)
LOG = []   # (t, role, midi)

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)

# —— 乐器层 ——
def kal(t, m, vel=.7, dur=1.6, pan=0., gain=1., role='kalimba'):
    """卡林巴：采样（F3–C#5 内）+ 模态合成叠层；超出采样范围时用模态合成 + 拇指琴（mbira）"""
    if 53 <= m <= 73: x = S.note('kalimba', m, dur, vel)
    else: x = S.note('mbira', m, dur, vel * .8)
    y = P.pluck('kalimba', m, dur + .6, vel * .9)
    n = max(len(x), len(y)); z = np.zeros(n, np.float32); z[:len(x)] += x * .8; z[:len(y)] += y * .55
    add(mus, z, t, gain, pan); LOG.append((t, role, m))

def inst(name, t, m, dur, vel, pan=0., gain=1., role=None, **kw):
    x = S.note(name, m, dur, vel, **kw); add(mus, x, t, gain, pan); LOG.append((t, role or name, m))

def hitm(name, t, var, vel, pan=0., gain=1., bus=None, role=None):
    x = S.hit(name, var, vel); add(mus if bus is None else bus, x, t, gain, pan)
    if role: LOG.append((t, role, None))

def saw(f, d, det=0.):
    tt = t_(d); ph = 2 * np.pi * f * (1 + det) * tt + rng.random() * 6.28
    out = np.zeros_like(tt); k = 1
    while k * f < 5000 and k < 40: out += np.sin(k * ph) / k; k += 1
    return out

def pad(t, notes, d, att=.5, rel=.8, cut=1400, g=.16, pan_w=.35):
    """软 pad：每音 3 个失谐锯齿（±7 音分）→ 低通 → 慢速起伏；音高 ≥ MIDI 48"""
    tot = d + rel; tt = t_(tot); L = np.zeros(len(tt)); R = np.zeros(len(tt))
    for i, m in enumerate(notes):
        assert m >= 48, m
        f = mtof(m)
        for j, det in enumerate((-.004, 0., .004)):
            x = saw(f, tot, det)
            p = ((i + j) % 3 - 1) * pan_w
            L += x * np.cos((p + 1) * np.pi / 4); R += x * np.sin((p + 1) * np.pi / 4)
    e = np.minimum(1, tt / att) * np.where(tt > d, np.exp(-(tt - d) / (rel / 4)), 1.) * (1 + .08 * np.sin(2 * np.pi * .35 * tt))
    L = lp(L, cut) * e; R = lp(R, cut) * e
    pk = max(np.abs(L).max(), np.abs(R).max()) + 1e-9
    s = int(t * SR); n = min(len(L), N - s)
    mus[s:s + n, 0] += (L[:n] / pk * g).astype(np.float32); mus[s:s + n, 1] += (R[:n] / pk * g).astype(np.float32)

def bass(t, m, d, g=.13):
    """软合成低音：正弦 + 2、3 次谐波（小音箱也听得见），慢起音"""
    f = mtof(m); tt = t_(d + .5)
    x = np.sin(2 * np.pi * f * tt) + .45 * np.sin(4 * np.pi * f * tt) + .22 * np.sin(6 * np.pi * f * tt)
    e = np.minimum(1, tt / .03) * np.where(tt > d, np.exp(-(tt - d) / .12), np.exp(-tt / (d * 1.6)))
    add(mus, (x * e * g).astype(np.float32), t, 1., 0.); LOG.append((t, 'bass', m))

# —— 白天（F 大调五声）——
F = dict(F3=53, G3=55, A3=57, Bb3=58, C4=60, D4=62, E4=64, F4=65, G4=67, A4=69, Bb4=70, C5=72, D5=74, E5=76, F5=77, G5=79, A5=81, C6=84)
# 第 1 小节：晨光
kal(b(1), 72, .82, 2.0, 0., 1.1, 'sunhit')
kal(b(2), 69, .6, 1.5, -.2)
kal(b(3), 65, .55, 1.2, .2); kal(b(3.5), 67, .5, 1.0, .1)
# 第 2 小节（转台启动）：四分音符
for i, m in enumerate([65, 69, 72, 67]): kal(b(4 + i), m, .62 + (i == 0) * .12, 1.0, (-.25, .25)[i % 2])
pad(b(4), [53, 57, 60, 67], 4 * BEAT, att=.6, rel=.4, cut=1300, g=.13)
bass(b(4), 41, 2 * BEAT); bass(b(6), 41, 2 * BEAT, .11)
# 第 3 小节：八分音符（最快） + 马林巴 + 沙锤；正午手铃
arp3 = [62, 65, 69, 72, 74, 72, 69, 65]
for i in range(8): kal(b(8 + i * .5), arp3[i], .55 + .1 * (i % 2 == 0), .7, (-.3, .3)[i % 2], .9)
pad(b(8), [50, 53, 57, 60], 4 * BEAT, att=.25, rel=.4, cut=1600, g=.13)
bass(b(8), 38, 2 * BEAT); bass(b(10), 38, 2 * BEAT, .11)
for i, m in enumerate([50, 57, 50, 57]): inst('marimba', b(8 + i), m, .5, .45, -.1, .7, 'marimba')
for k in range(12): hitm('shaker', b(8 + k * .5), 'down' if k % 2 == 0 else 'up', .35 + .1 * (k % 2 == 0), .35, .5)
inst('hand_chimes', b(10), 81, 2.5, .7, .1, .9, 'noon')
for i, m in enumerate([84, 81, 79, 77]): kal(b(10 + i * .5 + .25), m, .42, .6, .4, .55, 'kal_hi')   # 正午的高音装饰（十六分后半）
# 第 4 小节：转台长减速 → 音乐密度递减（八分 → 四分 → 二分）+ 木鱼时钟渐弱
for i, m in enumerate([58, 62, 65, 69]): kal(b(12 + i * .5), m, .58 - i * .02, .8, (-.3, .3)[i % 2])   # 八分
kal(b(14), 72, .52, 1.0, .2); kal(b(15), 67, .48, 1.2, -.1)                                              # 四分 → 停
pad(b(12), [58, 62, 65, 69], 2 * BEAT, att=.2, rel=.3, cut=1500, g=.12)
pad(b(14), [60, 65, 67, 72], 2 * BEAT - .02, att=.2, rel=.08, cut=1200, g=.11)
bass(b(12), 46, 2 * BEAT); bass(b(14), 48, 1.5 * BEAT, .1)
for i in range(4): hitm('woodblock', b(12 + i), 'a', .6 - i * .1, .3, .55, role='clock')
for k in range(4): hitm('shaker', b(12 + k * .5), 'down' if k % 2 == 0 else 'up', .3, .35, .4)

# —— 夜（F 小调）——
# 第一扇窗：静默后的第一声
inst('hand_chimes', b(18), 65, 3.0, .85, 0., 1.25, 'win0_chime')
kal(b(18), 53, .75, 2.4, -.1, 1.0, 'win0_low')
pad(b(18), [53, 56, 60, 67], 5 * BEAT, att=.35, rel=.25, cut=900, g=.12)
inst('vibraphone_bowed', b(18), 72, 5 * BEAT - .1, .5, .25, .55, 'bowed', release=.25)
bass(b(18), 41, 3 * BEAT, .1)
wins = ev('win')
for w in wins[1:]:
    kal(w['t'], w['note'], .62, 1.1, (w['i'] % 3 - 1) * .35, .95, 'win')
    if w['note'] >= 60: inst('hand_chimes', w['t'], w['note'], 1.2, .4, (w['i'] % 3 - 1) * .3, .45, 'win_chime')
for i, m in enumerate([41, 48, 44, 48]): inst('marimba', b(19 + i), m + 12, .5, .38, -.15, .55, 'marimba')
# 屏息：pad 在 23 拍收掉
# 顶灯：Db 大九（bVI）+ 管钟 + 低音
inst('tubular_bells', b(24), 65, 4.5, .85, 0., 1.0, 'lamp_bell')
pad(b(24), [49, 53, 56, 60, 63], 4 * BEAT, att=.05, rel=.3, cut=1700, g=.16)
inst('vibraphone_bowed', b(24), 68, 4 * BEAT - .1, .55, -.25, .55, 'bowed', release=.3)
for j, m in enumerate([61, 65, 68, 72]): kal(b(24) + j * .028, m, .6, 1.8, (j - 1.5) * .25, .8, 'lamp_strum' if j == 0 else 'strum')
bass(b(24), 37, 4 * BEAT, .15)
for e in ev('star'): inst('glockenspiel', e['t'], e['note'], 1.6, .45, (e['i'] % 2 - .5) * .7, .5, 'star')
for e in ev('letter'): kal(e['t'], e['note'], .66, 1.0, (e['i'] - 2) * .2, 1.0, 'letter')
kal(b(27 + 2 / 3), 80, .45, 1.0, .2, .7, 'kal_fill')
# 终和弦 Fm(add9)
pad(b(28), [53, 56, 60, 67], DUR - b(28) - .1, att=.08, rel=.6, cut=1300, g=.15)
for j, m in enumerate([53, 60, 67, 72]): kal(b(28) + j * .03, m, .6, 2.4, (j - 1.5) * .25, .85, 'final' if j == 0 else 'strum')
inst('hand_chimes', b(28), 84, 2.3, .6, .2, .8, 'final_chime')
inst('vibraphone_bowed', b(28), 72, DUR - b(28) - .3, .45, 0., .5, 'bowed', release=.4)
bass(b(28), 41, DUR - b(28) - .2, .12)

# 混响后做"数字静默"：停住那一刻起到第一扇窗前，以及顶灯前半拍
mus = S.room(mus, size=.42, mix=.2).astype(np.float32)
def gate(t0, t1, fo=.012):
    s0, s1, k = int(t0 * SR), int(t1 * SR), int(fo * SR)
    mus[s0 - k:s0] *= np.linspace(1, 0, k)[:, None]; mus[s0:s1] = 0
gate(TT['stop'], TT['win0'] - .001)
# 屏息：前半拍 −30 dB 余音，后半拍数字零
s0, s1, s2 = int(b(23) * SR), int(b(23.5) * SR), int(b(24) * SR)
mus[s0:s1] *= np.linspace(1, .03, s1 - s0)[:, None]; mus[s1:s2] = 0

# —— 拟音 ——
def whump(f0=55, v=1.):
    d = .5; tt = t_(d); x = np.sin(2 * np.pi * f0 * tt * (1 + .4 * np.exp(-tt * 20))) * np.exp(-tt / .12)
    return norm(x + lp(noise(d), 300) * np.exp(-tt / .03) * .4) * v
def hum(d=.45, v=1.):
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * tt) for f, a in [(100, 1), (200, .5), (300, .35), (400, .15)])
    return (x * np.minimum(1, tt / .01) * np.exp(-tt / .15) * v / 2).astype(np.float32)
def tink(f=4200, v=1.):
    d = .35; tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * k * tt) * np.exp(-tt / tau) for k, a, tau in [(1, 1, .09), (2.76, .5, .05), (5.4, .25, .02)])
    return norm(x) * v
def bubble(v=1.):
    d = .09; tt = t_(d); f = 380 + 1700 * (tt / d) ** 1.5
    return norm(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / d)) * v
def splash(v=1.):
    d = .3; tt = t_(d); x = bp(noise(d), 900, 6000) * np.exp(-tt / .06)
    for k in range(5):
        s = int((.02 + rng.random() * .2) * SR); dd = tink(2500 + rng.random() * 3000, .25); x[s:s + len(dd)] += dd[:len(x) - s]
    return norm(x) * v
def chirp(f0, v=1.):
    d = .16; tt = t_(d); f = f0 * (1 - .35 * tt / d); mod = np.sin(2 * np.pi * 70 * tt) * 300
    return norm(np.sin(2 * np.pi * np.cumsum(f + mod) / SR) * np.sin(np.pi * tt / d) ** 2) * v
def clunk(v=1.):
    d = .4; tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * tt) * np.exp(-tt / tau) for f, a, tau in [(140, 1, .07), (310, .6, .04), (720, .35, .02)])
    return norm(x + hp(noise(d), 1500) * np.exp(-tt / .006) * .5) * v

for e in ev('creak'):
    t = e['t']; g = (.16 if e.get('night') else .2) * (.7 + .3 * rng.random())
    add(fol, creak(1.), t, g, .1)
add(fol, creak(1.), TT['sunHit'], .2, .1)                                          # 叶片起转
x = bp(noise(1.0), 500, 4000) * np.sin(np.pi * t_(1.0)) ** 2; add(fol, norm(x) * .5, TT['sunHit'] - .45, .25, -.2)   # 晨光扫过的风声
from core.audio.sfx import whoosh
add(fol, whoosh(.8), TT['turn0'] - .4, .22, -.4)                                    # 转台起步
add(fol, clunk(1.), TT['stop'], .42, 0.); add(fol, thump(1., 60), TT['stop'], .3, 0.)   # 转台刹停（木）
add(fol, creak(1.), TT['stop'] - .08, .3, .1)                                      # 叶片刹停
for e in ev('bird'):
    for j in range(2 if e['k'] % 2 else 1): add(fol, chirp(3200 + 500 * ((e['k'] + j) % 3), 1.), e['t'] + j * .11, .09, (e['k'] % 3 - 1) * .6)
for w in wins:
    big = w['i'] == 0
    add(fol, whump(52 if big else 70, 1.), w['t'], .5 if big else .22, 0.)
    add(fol, hum(.9 if big else .4), w['t'], .35 if big else .14, 0.)
    add(fol, tink(4300 + 300 * (w['i'] % 4), 1.), w['t'], .12 if big else .08, (w['i'] % 3 - 1) * .4)
L = TT['lamp']
add(fol, whump(44, 1.), L, .65, 0.); add(fol, hum(1.4, 1.), L, .4, 0.); add(fol, tink(5200, 1.), L, .16, .1)
x = lp(noise(.8), 900) * np.exp(-t_(.8) / .2); add(fol, norm(x) * .4, L, .35, 0.)        # 灯亮的"呼"
add(fol, creak(1.), L + .4, .12, .15)                                               # 叶片重新起转
for e in ev('waterline'):                                                            # 水线铺开：一声轻柔的水面"嘶"
    d = .45; x = bp(noise(d), 1800, 7000) * np.sin(np.pi * t_(d) / d) ** 2; add(fol, norm(x), e['t'], .05, 0.)
for e in ev('star'): add(fol, tink(6200 + 400 * e['i'], 1.), e['t'], .05, (e['i'] % 2 - .5))
for e in ev('letter'):
    te = e['t']; add(fol, bubble(1.), te - .28 * .55 - .07, .1, (e['i'] - 2) * .2); add(fol, splash(1.), te - .28 * .55, .07, (e['i'] - 2) * .2)

# —— 环境声 ——
def envk(keys):
    xs, ys = zip(*keys); tt = np.arange(N) / SR; return np.interp(tt, xs, ys).astype(np.float32)
waves = hp(lp(brown(N / SR), 700), 110, 2); waves = norm(waves); swell = 1 + .35 * np.sin(2 * np.pi * .13 * np.arange(N) / SR)
wenv = envk([(0, .3), (9.5, .3), (10.3, .1), (11.1, .12), (11.6, .2), (19.0, .22), (DUR, .16)])
amb[:, 0] += waves * swell * wenv * .5; amb[:, 1] += np.roll(waves, 2400) * swell * wenv * .5
wind = bp(noise(N / SR), 300, 1500, 2); wind2 = bp(noise(N / SR), 300, 1500, 2)
gust = 1 + .5 * np.sin(2 * np.pi * .21 * np.arange(N) / SR) * np.sin(2 * np.pi * .07 * np.arange(N) / SR + 1)
wd = envk([(0, .1), (.6, .2), (3, .22), (6, .28), (9.4, .24), (10.0, .05), (11.2, .04), (14.9, .045), (15.0, .1), (16.0, .3), (DUR, .26)])
amb[:, 0] += norm(wind) * gust * wd * .35; amb[:, 1] += norm(wind2) * gust * wd * .35
# 蟋蟀
cr = np.zeros(N, np.float32)
t0 = TT['stop'] + .9; t = t0
while t < DUR:
    for k in range(3):
        s = int((t + k * .045) * SR); d = .03; tt = t_(d); c = np.sin(2 * np.pi * 4600 * tt) * np.sin(np.pi * tt / d) ** 2
        n = min(len(c), N - s)
        if n > 0: cr[s:s + n] += c[:n]
    t += .42 + rng.random() * .25
cre = envk([(0, 0), (t0, 0), (t0 + 1.5, 1), (DUR, 1)])
amb[:, 0] += cr * cre * .05; amb[:, 1] += np.roll(cr, 9000) * cre * .04
amb *= np.minimum(1, np.arange(N) / (.15 * SR))[:, None]   # 第 0 帧不突兀

# —— 混合 ——
def ch(f, x): return np.stack([f(x[:, 0]), f(x[:, 1])], 1)
mus = ch(lambda x: compress(hp(x, 50, 2), .35, 2.5), mus); fol = ch(lambda x: hp(x, 45, 2), fol)
mix = mus * 1.0 + fol * 1.0 + amb * .9
end = int((DUR - .6) * SR); n_end = int(DUR * SR)
fade = np.ones(N, np.float32); fade[end:n_end] = np.linspace(1, 0, n_end - end) ** 1.5; fade[n_end:] = 0
mix *= fade[:, None]; mus *= fade[:, None]; fol *= fade[:, None]; amb *= fade[:, None]
pk = np.abs(mix).max(); g = .9 / pk
mix = ch(lambda x: limit(x * g, .95), mix)
mix = mix[:int(round(DUR * SR))]
sf.write(os.path.join(OUT, 'mix.wav'), mix, SR, subtype='PCM_24')
for nm, x in (('music', mus), ('foley', fol), ('amb', amb)): sf.write(os.path.join(OUT, f'stem_{nm}.wav'), (x * g)[:len(mix)].astype(np.float32), SR)
json.dump([{'t': round(t, 6), 'role': r, 'midi': m} for t, r, m in sorted(LOG, key=lambda z: z[0])], open(os.path.join(OUT, 'score_events.json'), 'w'), ensure_ascii=False, indent=0)
# 低频能量占比
from scipy.signal import welch
f_, p_ = welch(mix[:, 0], SR, nperseg=8192); lo = p_[(f_ > 20) & (f_ < 120)].sum(); rest = p_[(f_ >= 120) & (f_ < 8000)].sum()
print(f'mix.wav {len(mix) / SR:.3f}s peak gain {g:.2f}; low/rest = {10 * np.log10(lo / rest):.1f} dB; score notes {len(LOG)}')
