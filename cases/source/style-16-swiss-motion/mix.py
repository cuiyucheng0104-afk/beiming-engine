"""TEMPO 配乐 + 拟音 → out/mix.wav，并把每个音乐起音写进 out/score.json（给 cuecheck.py 核对）。
极简电子，120 BPM：kick（合成 + MuldjordKit 采样）、拍手/闭镲/军鼓（VCSL 采样）、numpy 合成 stab 与贝斯、
马林巴 16 分音型与钟琴（VCSL 采样）、红点的正弦歌（音高跟随红点高度）。第 7 小节真静默。
用法：$LIB/.venv/bin/python mix.py   （先跑 events.mjs 与 tools/export_timeline.mjs）"""
import os, sys, json
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, norm, add, limit

S.seed(1616)
rng = np.random.default_rng(16)
def noise(d): return rng.standard_normal(int(round(d * SR)))

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))
T, HARM, E16, E8, BEAT = TL['T'], TL['HARM'], TL['E16'], TL['E8'], TL['BEAT']
DUR = TL['DUR']; N = int((DUR + 0.6) * SR)
mus = np.zeros((N, 2)); drm = np.zeros((N, 2)); fol = np.zeros((N, 2)); dotb = np.zeros((N, 2))
ONSETS = []                       # (t, 声部)
def on(t, inst): ONSETS.append((round(t, 6), inst))

# ================= 乐器 =================
def kick_syn(v=1.0):
    d = .42; tt = t_(d); f = 46 + 120 * np.exp(-tt / .03)
    body = .8 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .12)          # 主体再压约 2 dB：低频别压过其他频段
    body += .25 * np.sin(2 * 2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .06)     # 2 次谐波：小音箱也听得见
    click = hp(noise(d), 3000) * env_exp(d, .0015) * .5 + bp(noise(d), 180, 900) * env_exp(d, .012) * .9
    return norm(body + click) * v
def kick_smp(v):                  # MuldjordKit 底鼓：40 Hz 高通 + 45–85 Hz 再压约 3 dB
    x = hp(S.hit('drum_kit', 'kick_drum_left', v), 40, 2); return x - .3 * bp(x, 45, 85)
def KICK(t, v=1.0):
    add(drm, kick_syn(v), t, .42); add(drm, kick_smp(min(1, .55 + .4 * v)), t, .30); on(t, 'kick')
def CLAP(t, v=.8): add(drm, S.hit('claps', 'group', v), t, .75, .05); on(t, 'clap')
def HAT(t, v=.5, pan=.25): add(drm, S.hit('hihat', 'closed', v, dur=.09), t, .55, pan); on(t, 'hat')
def SNR(t, v=.5): add(drm, S.hit('snare2', 'on', v, dur=.18), t, .40, -.1); on(t, 'snare')

def saw(f, d):
    ph = np.cumsum(np.full(int(round(d * SR)), f / SR)); return 2 * (ph % 1) - 1
def stab(chord, d=.25, v=1.0, rel=.08):
    L = d + rel; tt = t_(L); x = np.zeros(len(tt))
    for p in chord:
        f = S.hz(p)
        for det in (-.006, .006): x += saw(f * (1 + det), L)
    bright, dark = lp(x, 7500, 2), lp(x, 1400, 2)
    fe = np.exp(-tt / .045); y = fe * bright + (1 - fe) * dark
    amp = np.minimum(1, tt / .003) * np.exp(-tt / (d * .9 + .05)) * np.clip((L - tt) / rel, 0, 1)
    return norm(y * amp) * v
def STAB(t, name, d=.25, v=1.0, rel=.08):
    x = stab(HARM[name], d, v, rel); add(mus, x, t, .42, -.15); add(mus, x, t + .011, .22, .35); on(t, 'stab')
def bassn(p, d, v=1.0):
    f = S.hz(p); L = d + .05; tt = t_(L); ph = 2 * np.pi * f * tt
    x = .7 * np.sin(ph) + .5 * np.sin(2 * ph) + .3 * np.sin(3 * ph)
    amp = np.minimum(1, tt / .004) * np.exp(-tt / (d + .1)) * np.clip((L - tt) / .05, 0, 1)
    return np.tanh(1.6 * x * amp) / np.tanh(1.6) * v
def BASS(t, p, d=.2, v=.9): add(mus, bassn(p, d, v), t, .34); on(t, 'bass')
def MAR(t, p, v=.35, pan=-.3): add(mus, S.note('marimba', p, .3, vel=v), t, .55, pan); on(t, 'marimba')
def GLK(t, p, v=.5, d=1.2): add(mus, S.note('glockenspiel', p, d, vel=v), t, .38, .3); on(t, 'glock')

OST = [['A4', 'E5', 'C5', 'E5'], ['G4', 'E5', 'D5', 'E5'], ['A4', 'E5', 'C5', 'G5'], ['B4', 'E5', 'D5', 'E5']]
def ostinato(a, b, v0=.34, v1=None):
    t = a; k = 0
    while t < b - 1e-6:
        bt = int(round(t / BEAT)) % 4; pat = OST[bt]; vv = v0 if v1 is None else v0 + (v1 - v0) * (t - a) / (b - a)
        for j in range(4): MAR(t + j * E16, pat[j], vv * (1.25 if j == 0 else .85))
        t += BEAT; k += 1

# ================= 乐谱（cue map）=================
# 第 1–2 小节：kick 四踩；第 2 小节加反拍闭镲
for b in np.arange(0, 4, BEAT): KICK(b, 1.0 if b % 2 == 0 else .85)
for b in np.arange(2.25, 4, BEAT): HAT(b, .55)
# 第 3–5 小节前半（TEMPO）：+拍手 2、4 拍，贝斯反拍 8 分，马林巴 16 分，钟琴每字母一个音
for b in np.arange(4, 9, BEAT): KICK(b, .95)
for b in np.arange(4.5, 9, 1.0): CLAP(b, .8)
for b in np.arange(4, 9, E16):
    if abs((b / E8) - round(b / E8)) > 1e-6: HAT(b, .3, .3)
    elif abs(((b - .25) / BEAT) - round((b - .25) / BEAT)) < 1e-6: HAT(b, .55, .2)
for b in np.arange(4.25, 9, BEAT): BASS(b, 'A2', .2)
ostinato(4, 9, .30, .40)
for i, tl in enumerate(T['letters']): GLK(tl, HARM['glockLetters'][i], .55)
# 加速（9–12）：stab 进场；四分 → 八分 → 十六分；军鼓 roll 与噪声上扬
names = ['am9'] * 4 + ['fmaj9'] * 4 + ['g69'] * 3
bassp = ['A2'] * 4 + ['F2'] * 4 + ['G2'] * 3
for i, (tb, _) in enumerate(T['big'][:-1]):
    d = .22 if i < 4 else .15 if i < 8 else .09
    STAB(tb, names[i], d, .95); KICK(tb, .9); BASS(tb, bassp[i], d)
for b in [9.5, 10.5, 11.0, 11.5]: CLAP(b, .75)
for b in np.arange(9, 12, E16): HAT(b, .25 + .3 * (b - 9) / 3, .3)
for b in np.arange(10.5, 11.5, E16): SNR(b, .25 + .35 * (b - 10.5))
for b in np.arange(11.5, 12, E16 / 2): SNR(b, .6 + .35 * (b - 11.5) * 2)
ostinato(9, 10.5, .40, .45)
d = 1.5; tt = t_(d); rz = np.zeros(len(tt)); nz = noise(d)
for i in range(0, len(tt), 960):                     # 噪声上扬：中心频率 600 → 6000 Hz
    f = 600 * 10 ** (i / len(tt)); seg = bp(nz[max(0, i - 4000):i + 960], f * .7, min(f * 1.4, 20000))[-960:]; rz[i:i + len(seg)] = seg[:len(rz) - i]
rz = norm(rz) * (tt / d) ** 2
add(mus, rz, 10.5, .22)
# 12.0：下拍一记合奏重击，然后硬切
STAB(12.0, 'e7sus', .1, 1.0, .04); KICK(12.0, 1.0); CLAP(12.0, .9); BASS(12.0, 'E2', .1)
# 14.0：红点的歌（正弦，音高跟随红点高度，声像跟随横坐标）+ 弓奏颤音琴打底
pts = next(e for e in EV['ev'] if e['type'] == 'dotpath')['pts']
pt = np.array([p[0] for p in pts]); px = np.array([p[1] for p in pts]); py = np.array([p[2] for p in pts])
y0, y3 = py[0], py[-1]
def midi_of(y): return 76 + (y - y0) * (72 - 76) / (y3 - y0)     # 入场 E5，落到 O 上时 C5，最高处约 C6
d = (T['dotLand'] - T['dotIn']) + .9; tt = t_(d); tabs = T['dotIn'] + tt
ty = np.interp(np.minimum(tabs, T['dotLand']), pt, py); tx = np.interp(np.minimum(tabs, T['dotLand']), pt, px)
f = 440 * 2 ** ((midi_of(ty) - 69) / 12); ph = 2 * np.pi * np.cumsum(f) / SR
song = np.sin(ph) + .12 * np.sin(2 * ph) + .04 * np.sin(3 * ph)
amp = np.minimum(1, tt / .012) * np.where(tabs < T['dotLand'], 1, np.exp(-(tabs - T['dotLand']) / .22))
song *= amp * .24; pan = np.clip((tx - 960) / 960, -.8, .8)
dotb[int(T['dotIn'] * SR):int(T['dotIn'] * SR) + len(song), 0] += song * np.cos((pan + 1) * np.pi / 4) * 1.414
dotb[int(T['dotIn'] * SR):int(T['dotIn'] * SR) + len(song), 1] += song * np.sin((pan + 1) * np.pi / 4) * 1.414
on(T['dotIn'], 'dotsong')
add(mus, S.note('vibraphone_bowed', 'E5', 1.6, vel=.7, release=.8), T['dotIn'], .30, .4); on(T['dotIn'], 'vibraphone')
sub = np.sin(2 * np.pi * 55 * t_(1.4)) * env_exp(1.4, .45) * np.minimum(1, t_(1.4) / .004)
add(mus, sub, T['dotIn'], .08)
# 16.0：镲和马林巴轻轻回来
for b in np.arange(16.25, 17, E8): HAT(b, .22 + .25 * (b - 16), .2)
ostinato(16, 17, .24, .38)
# 17.0：全乐队回归
for b in np.arange(17, 18, BEAT): KICK(b, .95)
CLAP(17.5, .8)
for b in np.arange(17, 18, E16): HAT(b, .35, .25)
for b in np.arange(17.25, 18, BEAT): BASS(b, 'A2', .2)
STAB(17.0, 'am9', .3, .95); ostinato(17, 18, .38, .42)
# 18.0：终止和弦（一个小节的余响）
STAB(18.0, 'final', 1.3, 1.0, .5); KICK(18.0, 1.0); CLAP(18.0, .7); BASS(18.0, 'A1', 1.3, .7)
for i, p in enumerate(['A3', 'E4', 'A4', 'C5', 'E5']): add(mus, S.note('marimba', p, 1.5, vel=.5), 18.0 + i * .0, .45, -.4 + .2 * i)
on(18.0, 'marimba'); GLK(18.0, 'A6', .7, 2.0); GLK(18.0, 'E6', .45, 2.0)

# ================= 拟音（干、近、无混响；由 window.EV 驱动）=================
def thunk(v=1.0, big=False):
    d = .16 if big else .12; tt = t_(d)
    return norm(np.sin(2 * np.pi * (120 if big else 140) * tt) * env_exp(d, .03) + bp(noise(d), 300, 1600) * env_exp(d, .006) * .6) * v
def slide(d=.25):
    tt = t_(d); return norm(bp(noise(d), 600, 4800) * (tt / d) ** 1.6 * np.exp(-np.maximum(0, tt - d * .92) / .01))
def tss():                        # 直线笔落纸：3 ms 起音，峰值就在十六分点上（不再是提前 35 ms 的渐强）
    d = .07; tt = t_(d); return norm(bp(noise(d), 3500, 10000) * np.minimum(1, tt / .003) * np.exp(-tt / .022))
def block(p=1.0):
    d = .06; tt = t_(d)
    return norm(hp(noise(d), 1500) * env_exp(d, .002) + np.sin(2 * np.pi * 1750 * p * tt) * env_exp(d, .008) * .7 + np.sin(2 * np.pi * 640 * p * tt) * env_exp(d, .012) * .4)
def clack(big=False):
    d = .11 if big else .07; tt = t_(d); q = .94 + rng.random() * .12
    x = hp(noise(d), 2500) * env_exp(d, .0012) * .9
    x += sum(a * np.sin(2 * np.pi * f * q * tt + rng.random() * 6) * env_exp(d, tau) for f, a, tau in [(3300, .45, .010), (5100, .25, .006), (1250, .35, .016)])
    x += np.sin(2 * np.pi * (150 if big else 420) * q * tt) * env_exp(d, .03 if big else .012) * (.9 if big else .35)
    return norm(x)
def knife(d=.25):
    n = noise(d); tt = t_(d); out = np.zeros_like(n); hop = 240
    for i in range(0, len(n), hop):
        f = 1500 + 4500 * (i / len(n)) ** 1.5; seg = bp(n[max(0, i - 1200):i + hop], f * .8, min(f * 1.25, 20000))[-hop:]; out[i:i + len(seg)] = seg
    out *= np.minimum(1, tt / (d * .7)) ** 1.5
    return norm(out) * .6
def snick():
    d = .08; tt = t_(d); return norm(np.sin(2 * np.pi * 4200 * tt) * env_exp(d, .012) + hp(noise(d), 4000) * env_exp(d, .003))
def collapse():
    d = .12; tt = t_(d); return norm(lp(noise(d), 1200) * env_exp(d, .03) + np.sin(2 * np.pi * 180 * tt) * env_exp(d, .025) * .5)
def paper():
    d = .25; tt = t_(d)
    return norm(lp(noise(d), 900) * env_exp(d, .03) + np.sin(2 * np.pi * 110 * tt) * env_exp(d, .04) * .6 + hp(noise(d), 3000) * env_exp(d, .006) * .4)
def typ():
    d = .05; tt = t_(d); return norm(hp(noise(d), 2000) * env_exp(d, .003) + np.sin(2 * np.pi * 2600 * tt) * env_exp(d, .006) * .4)
def tick():
    d = .03; tt = t_(d); return norm(np.sin(2 * np.pi * 3600 * tt) * env_exp(d, .004) + hp(noise(d), 5000) * env_exp(d, .001) * .5)
def felt(v=1.0):                  # 毛毡槌：靠"木腔 + 毡面"的中频音色突出，不靠低频能量
    d = .6; tt = t_(d)
    body = np.sin(2 * np.pi * 96 * tt * (1 - .15 * tt)) * env_exp(d, .09) * .55
    knock = (np.sin(2 * np.pi * 410 * tt) * env_exp(d, .035) * .55 + np.sin(2 * np.pi * 1130 * tt) * env_exp(d, .012) * .35)
    puff = bp(noise(d), 250, 1600) * env_exp(d, .018) * .6
    return norm(hp(body + knock + puff, 70, 2)) * v
def touch(i):
    d = .09; tt = t_(d); f = 300 + 40 * i
    return norm(np.sin(2 * np.pi * f * tt) * env_exp(d, .02) + lp(noise(d), 900) * env_exp(d, .008) * .5)
def stamp():
    d = .3; tt = t_(d)
    return norm(np.sin(2 * np.pi * 85 * tt) * env_exp(d, .05) + bp(noise(d), 200, 2200) * env_exp(d, .015) * .8 + hp(noise(d), 4000) * env_exp(d, .004) * .2)

for e in EV['ev']:
    ty, t, g = e['type'], e['t'], e.get('g', 1.0); pan = float(rng.uniform(-.2, .2))
    if ty == 'thunk': add(fol, thunk(1, e.get('big')), t, .34 * g, pan)
    elif ty == 'slide': d = e['d']; add(fol, slide(d), t - d, .13 * g, pan)
    elif ty == 'tss': add(fol, tss(), t, .10 * g, pan)
    elif ty == 'block': add(fol, block(e.get('p', 1)), t, .26, pan)
    elif ty == 'clack': add(fol, clack(e.get('big')), t, .24 if e.get('big') else .15, -.4 + .2 * e.get('i', 2))
    elif ty == 'knife': d = e['d']; add(fol, knife(d), t - d, .2 * g, .1); add(fol, snick(), t, .22 * g, .1)
    elif ty == 'collapse': add(fol, collapse(), t, .18 * g)
    elif ty == 'paper': add(fol, paper(), t, .24 * g, pan)
    elif ty == 'type': add(fol, typ(), t, .14 * g, pan)
    elif ty == 'tick': add(fol, tick(), t, .10 * g, .5)
    elif ty == 'stop': add(fol, clack(True), t, .4); add(fol, thunk(1, True), t, .5)
    elif ty == 'felt': add(fol, felt(), t, .62 * g)
    elif ty == 'readout': add(fol, typ(), t, .06 * g, .5)
    elif ty == 'touch': add(fol, touch(e.get('i', 0)), t, .2, float(np.clip((t - 15.5) * -.5, -.6, .6)))
    elif ty == 'snick': add(fol, snick(), t, .18)
    elif ty == 'stamp': add(fol, stamp(), t, .3)

# ================= 混音 =================
DRY = mus + hp(drm.T, 60).T
# 红点出现时鼓全撤（14–16 本来就没有鼓）；全停：12.0 那一下之后硬切到真静默，直到 14.0
gate = np.ones(N); a, b = int(12.10 * SR), int(12.14 * SR)
gate[a:b] = np.linspace(1, 0, b - a); gate[b:int(T['dotIn'] * SR)] = 0
mix = (hp(DRY.T, 32).T + fol * 2.6) * gate[:, None] + dotb
for c in range(2): mix[:, c] = mix[:, c] - .72 * lp(mix[:, c], 130, 2)        # 低搁架：20–120 Hz 压到约 −3 dB
mix *= 1.5                                                                       # 压一点峰值因数：mux 的 loudnorm 之后真峰值要 ≤ −1.2 dB
for c in range(2): mix[:, c] = limit(mix[:, c], .9, .004)
assert np.isfinite(mix).all()
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
json.dump(sorted(ONSETS), open(os.path.join(HERE, 'out', 'score.json'), 'w'))

def db(x): return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
print('peak %.2f dBFS' % (20 * np.log10(np.abs(mix).max())))
for a_, b_ in [(0, 2), (2, 4), (4, 9), (9, 12), (12.2, 13.99), (14, 16), (16, 17), (17, 18), (18, 19.75)]:
    s, e = int(a_ * SR), int(b_ * SR)
    print(f'{a_:5.2f}-{b_:5.2f} mix {db(mix[s:e]):7.1f}  music {db((DRY * gate[:, None])[s:e]):7.1f}  foley {db((fol * gate[:, None])[s:e]):7.1f}  dot {db(dotb[s:e]):7.1f}')
from scipy.signal import welch
fq, P = welch(mix[:, 0], SR, nperseg=8192); lo = P[(fq > 20) & (fq < 120)].sum(); rest = P[(fq >= 120) & (fq < 16000)].sum()
print('low(20-120)/rest = %.1f dB' % (10 * np.log10(lo / rest)))
print('instruments:', sorted(set(i for _, i in ONSETS)))
def lowr(x):
    fq, P = welch(x, SR, nperseg=8192); return 10 * np.log10(P[(fq > 20) & (fq < 120)].sum() / (P[(fq >= 120) & (fq < 16000)].sum() + 1e-20) + 1e-20)
print('low/rest per bus: drums %.1f  music %.1f  foley %.1f  dot %.1f' % (lowr(drm[:, 0]), lowr(mus[:, 0]), lowr(fol[:, 0]), lowr(dotb[:, 0])))
