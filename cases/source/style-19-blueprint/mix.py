# 配乐 + 拟音 + 底噪 → out/mix.wav；同时写 out/cues_audio.json 供 cuecheck.py 核对拍点。
# 所有时间都来自 events.json（由 timeline.js / film.js 导出的同一张帧对齐拍网格）。
import sys, os, json
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as Pk
from core.audio.sfx import SR, add, limit, whoosh, thump, noise, brown, lp, hp, bp, env_exp, t_, norm

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json'))); DUR = E['dur']; N = int(round(DUR * SR))
EV = E['ev']; G = next(e for e in EV if e['type'] == 'grid'); BF, FPS = G['bf'], G['fps']
def BFr(b):
    n = len(BF) - 1
    if b <= 0: return b * 16
    if b >= n: return BF[n] + (b - n) * 16
    i = int(np.floor(b)); f = b - i
    return BF[i] + f * (BF[i + 1] - BF[i])
def Bt(b): return round(BFr(b)) / FPS            # 与画面完全相同的取整
S.seed(19); rng = np.random.default_rng(19)
onsets, sfxc = [], []

# ———————————————————— 配乐（D 小调 → D 大调，90 BPM，2/4）————————————————————
score = []
def n(b, inst, pitch, durb, vel, pan=0., gain=1., **kw):
    t = Bt(b); d = max(.05, Bt(b + durb) - t)
    score.append(dict(t=t, inst=inst, pitch=pitch, dur=d, vel=vel, pan=pan, gain=gain, **kw)); onsets.append((t, inst))
def mb(b, pitch, durb, vel, pan=.35):
    t = Bt(b); score.append(dict(t=t, pluck=('music_box', pitch, max(.4, Bt(b + durb) - t) + .6, vel), pan=pan)); onsets.append((t, 'music_box'))

# 低音合成：锯齿谐波 + 低通，带 2/3 次谐波让小喇叭也听得见
syn = np.zeros((N, 2), np.float32)
def synth(b, pitch, durb, vel=.5, att=.04, rel=.25, pan=0.):
    t0 = Bt(b); d = Bt(b + durb) - t0; f0 = S.hz(pitch); tt = t_(d + rel)
    x = sum(np.sin(2 * np.pi * f0 * k * tt + k) / k ** 1.3 for k in range(1, 7))
    e = np.minimum(1, tt / att) * np.where(tt < d, 1, np.exp(-(tt - d) / (rel / 4)))
    x = lp(x * e, 1400) * vel
    add(syn, x.astype(np.float32), t0, .9, pan); onsets.append((t0, 'synth'))

# A 段 b0–b6：低音合成 D + 羽管键琴二声部创意曲 + 马林巴一拍后卡农
synth(0, 'D2', 4, .55, att=.3); synth(4, 'Bb1', 1, .5); synth(5, 'A1', 1, .5)
RH_A = [(1, 'D5'), (1.5, 'A4'), (2, 'F5'), (2.5, 'A4'), (3, 'E5'), (3.5, 'A4'), (4, 'D5'), (4.5, 'F4'), (5, 'C#5'), (5.5, 'E4')]
for b, p in RH_A: n(b, 'harpsichord', p, .5, .62 if b % 1 == 0 else .5, .25)
for b, p in [(2, 'D4'), (2.5, 'A3'), (3, 'F4'), (3.5, 'A3'), (4, 'E4'), (4.5, 'D4'), (5, 'D4'), (5.5, 'C#4')]: n(b, 'marimba', p, .5, .5, -.3)
for b, p in [(3, 'D3'), (4, 'Bb2'), (5, 'A2')]: n(b, 'harpsichord', p, 1, .55, -.15)
n(5, 'harpsichord', 'E3', .5, .45, -.15); n(5.5, 'harpsichord', 'G3', .5, .45, -.15)

# B 段 b6–b12：Dm | Gm | Bb | A —— 加巴松断奏与拨弦
for p in ['D3', 'A3', 'D4']: n(6, 'harpsichord', p, 1, .66, -.1)
RH_B = [(6, 'D5'), (6.5, 'A4'), (7, 'F5'), (7.5, 'A4'), (8, 'G5'), (8.5, 'D5'), (9, 'Bb5'), (9.5, 'D5'), (10, 'F5'), (10.5, 'D5'), (11, 'E5'), (11.5, 'C#5')]
for b, p in RH_B: n(b, 'harpsichord', p, .5, .6 if b % 1 == 0 else .48, .25)
for b, p in [(7, 'D3'), (7.5, 'F3'), (8, 'G2'), (8.5, 'Bb2'), (9, 'D3'), (9.5, 'Bb2'), (10, 'Bb2'), (10.5, 'D3'), (11, 'A2'), (11.5, 'E3')]: n(b, 'bassoon_stac', p, .5, .62, -.25)
for b, p in [(6, 'D3'), (8, 'G2'), (10, 'Bb2'), (11, 'A2')]: n(b, 'cellos_pizz', p, 1, .62, .1)
synth(6, 'D2', 2, .42); synth(8, 'G1', 2, .42); synth(10, 'Bb1', 1, .42); synth(11, 'A1', 1, .42)
for b, p in [(6.5, 'A3'), (7.5, 'F4'), (8.5, 'Bb3'), (9.5, 'D4'), (10.5, 'F4'), (11.5, 'E4')]: n(b, 'marimba', p, .5, .32, -.35)

# C 段 b12–b14：渐慢，乐器一个个退出
for i, p in enumerate(['A5', 'C#6', 'E6', 'A6']): n(12 + i * .25, 'glockenspiel', p, 1, .48 - i * .03, .3)
for p in ['A2', 'E3', 'G3', 'C#4']: n(12, 'harpsichord', p, 1, .58, -.1)
n(12, 'bassoon', 'A2', 1, .5, -.2, attack=.03)
n(13, 'harpsichord', 'Bb4', .5, .5, .2); n(13.5, 'harpsichord', 'A4', .5, .42, .2)
# b14：一记干的和弦，立刻止音 → 静默
for p in ['A2', 'D3', 'E3', 'A3']: score.append(dict(t=Bt(14), inst='harpsichord', pitch=p, dur=.12, vel=.62, pan=0, release=.08))
onsets.append((Bt(14), 'harpsichord'))
# 静默 b14 → b15：不写任何音符

# E 段 b15–b23：b15 只有第一声擒纵（拟音）；之后一层层加入
OST = {'Dm': ['D4', 'A4', 'F4', 'A4'], 'Dm2': ['D4', 'A4', 'E4', 'A4'], 'Bb': ['Bb3', 'F4', 'D4', 'F4'], 'Gm': ['G3', 'D4', 'Bb3', 'D4'], 'A': ['A3', 'E4', 'C#4', 'E4']}
def harm(b): return 'Dm' if b < 17 else 'Dm2' if b < 19 else 'Bb' if b < 21 else 'Gm' if b < 22 else 'A'
b = 16.0
while b < 23 - 1e-6:
    h = harm(b); k = int(round((b - 16) * 2)) % 4
    n(b, 'marimba', OST[h][k], .5, .46 if k == 0 else .38, -.3); b += .5
ROOT = {'Dm': 'D2', 'Dm2': 'D2', 'Bb': 'Bb1', 'Gm': 'G1', 'A': 'A1'}
for bb in range(17, 23): synth(bb, ROOT[harm(bb)], .45, .5, att=.01, rel=.15)
# b19 切特写：羽管键琴十六分（加速感）
ARP = {'Bb': ['Bb4', 'D5', 'F5', 'D5'], 'Gm': ['G4', 'Bb4', 'D5', 'Bb4'], 'A': ['A4', 'C#5', 'E5', 'G5'], 'Dm2': ['A4', 'D5', 'F5', 'D5']}
b = 19.0
while b < 23 - 1e-6:
    h = harm(b); k = int(round((b - 19) * 4)) % 4
    n(b, 'harpsichord', ARP[h][k], .25, .5 if k == 0 else .4, .3); b += .25
for bb, p in [(20, 'F3'), (21, 'E3'), (21.5, 'D3'), (22, 'C#3')]: n(bb, 'bassoon', p, 1 if bb % 1 == 0 and bb != 21 else .5, .55, -.2, attack=.02)
for bb, p in [(21, 'G2'), (22, 'A2')]: n(bb, 'cellos_pizz', p, 1, .6, .1)
n(21, 'glockenspiel', 'D6', 1, .38, .35); n(22, 'glockenspiel', 'E6', 1, .38, .35)

# F 段 b23–b27：主题增值（巴松 + 八音盒）→ b26 D 大调终止（落章）
for bb, p, d in [(23, 'D3', 1), (24, 'F3', 1), (25, 'E3', .5), (25.5, 'C#3', .5)]:
    n(bb, 'bassoon', p, d, .58, -.2, attack=.02); mb(bb, S.name(S.midi(p) + 36), d, .55)
for bb, p in [(23, 'D4'), (23.5, 'A4'), (24, 'D4'), (24.5, 'Bb4'), (25, 'C#4'), (25.5, 'E4')]: n(bb, 'marimba', p, .5, .36, -.3)
for bb, p in [(23, 'D2'), (24, 'G1'), (25, 'A1')]: synth(bb, p, .9, .45)
CAD = ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4', 'F#4', 'A4']
for j, p in enumerate(CAD): score.append(dict(t=Bt(26) + j * .018, inst='harpsichord', pitch=p, dur=1.0, vel=.66, pan=-.2 + .05 * j))
onsets.append((Bt(26), 'harpsichord'))
for p in ['D3', 'F#3', 'A3', 'D4']: n(26, 'marimba', p, 1, .5, -.3)
for p in ['F#6', 'A6', 'D7']: n(26, 'glockenspiel', p, 1, .42, .3)
n(26, 'bassoon', 'D2', 1, .55, -.2, attack=.02); n(26, 'contrabass_pizz', 'D2', 1, .7, .05); n(26, 'cellos_pizz', 'D3', 1, .6, .1)
synth(26, 'D1', 1.2, .55); synth(26, 'D2', 1.2, .35)
mb(26, 'D6', 1, .5); mb(27, 'A6', .5, .35); mb(27, 'D7', .5, .3)

plk = [e for e in score if 'pluck' in e]
mus = S.render([e for e in score if 'pluck' not in e], dur=DUR + .5)[:N]
for e in plk:
    pre, p, d, v = e['pluck']; add(mus, Pk.pluck(pre, p, d, v), e['t'], .7, e.get('pan', 0))
mus = S.room(mus, size=.32, mix=.16)
mus = mus + syn[:len(mus)] * .20
mus = np.stack([hp(mus[:, 0], 38), hp(mus[:, 1], 38)], 1)

# ———————————————————— 拟音（全部由 window.EV 驱动）————————————————————
fx = np.zeros((N, 2), np.float32)
def grain(d, lo=2000, hi=6000):
    x = bp(noise(d), lo, hi, 2); tt = t_(d)
    m = .55 + .45 * np.abs(np.sin(2 * np.pi * (35 + 25 * rng.random()) * tt + rng.random() * 6))
    return x * m
def pen(d, v=1., teeth=0):
    d = max(.06, d); x = grain(d); tt = t_(d)
    e = np.minimum(1, tt / .015) * np.minimum(1, (d - tt) / .03 + .02)
    if teeth: e = e * (.35 + .65 * (.5 + .5 * np.cos(2 * np.pi * teeth / d * tt)) ** 3)
    return norm(x * e) * v
def squeak(d):
    tt = t_(d); f = 2350 + 180 * np.sin(2 * np.pi * 3.1 * tt) + 90 * np.sin(2 * np.pi * 11 * tt)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * (.5 + .5 * np.sin(2 * np.pi * 7 * tt) ** 2)
    return x * np.sin(np.pi * tt / d) * .5
def tsq(d):
    x = bp(noise(d), 300, 1600) * np.sin(np.pi * t_(d) / d) ** .6
    return norm(x) * .8
def stroke(v=1.):
    d = .04 + .02 * rng.random(); return pen(d, v)
def tick(k, first=False):
    d = .5 if first else .22; tt = t_(d)
    fs = [(3900, 1, .012), (5600, .6, .007), (2600, .5, .02), (7400, .25, .004)] if k % 2 == 0 else [(3100, 1, .014), (4400, .6, .008), (2100, .5, .022), (6200, .25, .005)]
    x = sum(a * np.sin(2 * np.pi * f * tt + rng.random() * 6) * env_exp(d, tau * (2.2 if first else 1)) for f, a, tau in fs)
    x = x + hp(noise(d), 3000) * env_exp(d, .0015) * 1.2
    x = norm(x)
    if first:   # 第一声：近、重、有身体，带一点室内余响
        body = np.sin(2 * np.pi * 73 * tt * (1 - .2 * tt)) * env_exp(d, .09) * .9 + lp(noise(d), 500) * env_exp(d, .012) * .6
        sub = np.sin(2 * np.pi * S.hz('D1') * tt) * env_exp(d, .22) * .55
        x = norm(x * .9 + body + sub)
    return x
def slap():
    d = .25; x = lp(noise(d), 2500) * env_exp(d, .018) + np.sin(2 * np.pi * 120 * t_(d)) * env_exp(d, .03) * .6
    return norm(x)
def flick(d):
    tt = t_(d); x = bp(noise(d), 900, 5000) * (np.sin(np.pi * tt / d) ** 2) * (.6 + .4 * (rng.random(len(tt)) > .97))
    return norm(x)
def stamp_s():
    d = .5; tt = t_(d)
    x = np.sin(2 * np.pi * 92 * tt * (1 - .3 * tt)) * env_exp(d, .06) + lp(noise(d), 900) * env_exp(d, .02) * .8 + bp(noise(d), 600, 2000) * env_exp(d, .06) * .25
    return norm(x)
def clickc(v=1.):
    d = .025; tt = t_(d); return norm(hp(noise(d), 4000) * env_exp(d, .002) + np.sin(2 * np.pi * 5200 * tt) * env_exp(d, .004) * .5) * v

for e in EV:
    ty, t = e['type'], e['t']
    if ty == 'pen':
        add(fx, pen(e['dur'], 1, e.get('teeth', 0)), t, .16 * e.get('v', 1) * (.7 + .3 * min(2, e.get('len', 1))), rng.uniform(-.3, .3)); sfxc.append(('pen', t))
    elif ty == 'compass':
        add(fx, pen(e['dur'], .7), t, .14, .1); add(fx, squeak(e['dur']), t, .05, .1); sfxc.append(('compass', t))
    elif ty == 'tsq':
        add(fx, tsq(e['dur']), t, .3, -.2); add(fx, thump(.5, 160), t + e['dur'] - .05, .12); sfxc.append(('tsq', t))
    elif ty == 'hatch':
        k = e['n']
        for i in range(k): add(fx, stroke(), t + e['dur'] * i / k, .14 * e.get('v', 1), rng.uniform(-.2, .2))
        sfxc.append(('hatch', t))
    elif ty == 'letter':
        k = int(e['n'] * 2.2)
        for i in range(k): add(fx, stroke(), t + e['dur'] * (i + rng.random() * .5) / k, .1 * e.get('v', 1), rng.uniform(-.2, .2))
        sfxc.append(('letter', t))
    elif ty == 'count':
        tt = t
        while tt < t + e['dur']: add(fx, clickc(.5), tt, .06, .3); tt += .045
        sfxc.append(('count', t))
    elif ty == 'dot': add(fx, clickc(), t, .1, .2); sfxc.append(('dot', t))
    elif ty == 'flip': add(fx, flick(e['dur']), t, .2, .1); sfxc.append(('flip', t))
    elif ty == 'flipland': add(fx, slap() * .5, t, .14); sfxc.append(('flipland', t))
    elif ty == 'whoosh': add(fx, lp(whoosh(e['dur']), 2500), t, .14 * e.get('v', 1)); sfxc.append(('whoosh', t))
    elif ty == 'slap': add(fx, slap(), t, .34); sfxc.append(('slap', t))
    elif ty == 'peel':
        d = e['dur']; tt = t_(d); x = bp(noise(d), 1200, 4000) * np.sin(np.pi * tt / d) * (rng.random(len(tt)) > .9)
        add(fx, lp(x, 5000), t, .05); sfxc.append(('peel', t))
    elif ty == 'tick':
        first = e.get('first', False)
        add(fx, tick(e['n'], first), t, .95 if first else .42, -.08 if e['n'] % 2 else .08); sfxc.append(('tick', t))
        add(fx, clickc(.4), t + .006, .05, .3)                 # 小齿轮咬合的细咔
        if not first:
            s = S.hit('woodblock', 'a' if e['n'] % 2 == 0 else 'b', .3)  # 木质身体
            add(fx, s[:int(.15 * SR)] if len(s) > int(.15 * SR) else s, t, .06)
    elif ty == 'sign':
        d = e['dur']
        for a, b_ in [(0, .3), (.33, .55), (.6, 1)]: add(fx, pen(d * (b_ - a), .9), t + d * a, .14, -.1)
        sfxc.append(('sign', t))
    elif ty == 'stamp': add(fx, stamp_s(), t, .55); sfxc.append(('stamp', t))
fx = fx.astype(np.float32)
# 第一声擒纵加一点房间余响
fxr = S.room(fx, size=.25, mix=.1)

# 底噪：极轻的制图室空气（静默段 b14+0.25 → b15 拿掉，只剩纸声）
bed = lp(brown(DUR + .1), 500)[:N] * .006
tt = np.arange(N) / SR
gate = np.ones(N); s0, s1 = Bt(14) + .25, Bt(15)
gate[(tt >= s0) & (tt < s1)] = 0
gate = np.convolve(gate, np.ones(2400) / 2400, mode='same')
bed = (bed * gate)[:, None] * np.ones((1, 2))

mus = mus * gate[:len(mus), None]          # 音乐在静默段真正归零（只留纸声）
mix = mus * .62 + fxr * 1.0 + bed
# 片尾 0.25 s 淡出
fl = int(.25 * SR); mix[-fl:] *= np.linspace(1, 0, fl)[:, None]
mix = np.stack([limit(mix[:, 0], .5), limit(mix[:, 1], .5)], 1).astype(np.float32)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR)
sf.write(os.path.join(HERE, 'out', 'music.wav'), mus.astype(np.float32), SR)
# 静默段电平
i0, i1 = int((Bt(14) + .3) * SR), int((Bt(15) - .02) * SR)
rms = lambda x: float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12))
json.dump({'music_onsets': sorted(onsets), 'sfx_cues': sorted(sfxc, key=lambda x: x[1]), 'silence': [Bt(14) + .3, Bt(15)],
           'silence_rms_db': rms(mix[i0:i1]), 'body_rms_db': rms(mix)}, open(os.path.join(HERE, 'out', 'cues_audio.json'), 'w'))
print('mix', mix.shape, 'peak', float(np.abs(mix).max()), 'silence rms', round(rms(mix[i0:i1]), 1), 'dB / whole', round(rms(mix), 1), 'dB')
