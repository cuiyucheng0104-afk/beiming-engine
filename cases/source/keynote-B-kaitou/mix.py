"""方案 B《片库之夜》20 秒开头：配乐与音效。读 events.json（timeline.js → window.EV 导出），
音乐按 108 BPM 网格写成（马林巴 + 钢琴相位错位，颤音琴、低音提琴拨弦点缀），音效逐事件放置。
一次性画面事件的声音放在画面帧时刻（events.json 里的 t 已经是帧时刻）；铅笔点放在精确的音乐网格上。
输出 out/mix.wav（48 kHz 立体声）与 out/stems/*.wav。运行：$LIB/.venv/bin/python mix.py"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar'))
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, bp, lp, hp, t_, norm, limit

S.seed(108)
rng = np.random.default_rng(477)
E = json.load(open(os.path.join(HERE, 'events.json')))
DUR, EV = E['dur'], E['ev']
N = int(round(DUR * SR))
grid = next(e for e in EV if e['type'] == 'grid')
B = grid['beat']; EI = B / 2
g = lambda n: n * B
ev = lambda ty: [e for e in EV if e['type'] == ty]
one = lambda ty: ev(ty)[0]
FPS = 30

stems = {k: np.zeros((N, 2), np.float32) for k in ('music', 'hum', 'foley', 'taps')}
def noise(d): return rng.standard_normal(int(round(d * SR)))
def fade(x, a=.002, b=.006):
    x = x.copy(); ka, kb = max(1, int(a * SR)), max(1, int(b * SR))
    x[:ka] *= np.linspace(0, 1, ka); x[-kb:] *= np.linspace(1, 0, kb); return x

# ═════════ 音乐 ═════════
PAT = ['D5', 'G4', 'B4', 'G4', 'E5', 'G4', 'D5', 'A4', 'D5', 'G4', 'B4', 'G4', 'C5', 'G4', 'B4', 'A4']
REST = (one('rest')['t'], g(28))                 # g27.5–g28 半拍全静默
TCLU = one('clu')['t']
def in_rest(t): return REST[0] - 1e-6 <= t < REST[1] - 1e-4
score = []
# 马林巴：g4 进入（第 5 根灯管），两小节 16 个八分音符的短句，左声像
k = 0
while True:
    t = g(4) + k * EI
    if t >= DUR: break
    if not in_rest(t):
        bar = t / (4 * B)
        v = .46 + .2 * min(1, (t - g(4)) / (g(8) - g(4)))
        if t >= g(28): v = .6 if t < g(28) + EI / 2 else .5
        if k % 2 == 0: v += .05
        score.append((t, 'marimba', PAT[(k) % 16], .5, min(.85, v), -.38))
    k += 1
# 钢琴：g8 进入，与马林巴同一短句同一位置开始；41 个八分对马林巴 40 个 → 在 g28 恰好领先一个八分、重新落回网格（锁相）
Ep = (g(28) - g(8)) / 41
k0 = 8                                            # g8 时马林巴正在短句第 8 个音
for j in range(41):
    t = g(8) + j * Ep
    if in_rest(t): continue
    v = .38 + .14 * min(1, j / 16)
    score.append((t, 'piano', PAT[(k0 + j) % 16], .45, v, .38))
j = 0
while True:
    t = g(28) + j * EI
    if t >= DUR: break
    v = .5 if j == 0 else .42
    score.append((t, 'piano', PAT[(k0 + 41 + j) % 16], .45, v, .38))
    j += 1
# 低音提琴拨弦：G →（Em, C, D）→ G add9 → C（开放）
for b, p in [(8, 'G2'), (16, 'E2'), (18, 'E2'), (20, 'C2'), (22, 'C2'), (24, 'D2'), (25, 'D2'), (26, 'D2'), (27, 'D2'),
             (30, 'G2'), (32, 'C2'), (34, 'C2'), (35, 'G2')]:
    score.append((g(b), 'contrabass_pizz', p, 1.2, .78, 0))
score.append((TCLU, 'contrabass_pizz', 'G1', 2.0, .9, 0))
# 和弦（g28）：钢琴 G add9 + 马林巴三和弦 + 颤音琴
for p, v in [('G2', .72), ('D3', .66), ('A3', .6), ('B3', .62), ('D4', .6)]: score.append((TCLU, 'piano', p, 2.2, v, .15))
for p in ['G3', 'B3', 'D4']: score.append((TCLU, 'marimba', p, 1.2, .7, -.2))
for p in ['G4', 'B4', 'D5', 'A5']: score.append((TCLU, 'vibraphone', p, 3.0, .62, .1))
# 落片：颤音琴轻点；放大镜：弓奏颤音琴的玻璃长音
sl = one('slide')['t']
for p in ['B4', 'D5']: score.append((sl, 'vibraphone', p, 2.0, .45, .2))
lp_ = one('loupe_move')
score.append(dict(t=lp_['t'], inst='vibraphone_bowed', pitch='D6', dur=2.4, vel=.42, pan=.3, attack=.4))
score.append(dict(t=lp_['t'] + .3, inst='vibraphone_bowed', pitch='A5', dur=2.0, vel=.32, pan=-.2, attack=.5))
# 底片套：每张一个颤音琴单音；第三张留余音
for e, p in zip(ev('sleeve'), ['B4', 'D5', 'E5']):
    score.append((e['t'], 'vibraphone', p, 3.0, .6, (e['k'] - 1) * .4))
score.append((ev('sleeve')[2]['t'], 'vibraphone', 'A5', 3.0, .45, .3))
# 结尾：钢琴 C add9（IV，开放，不收死）
for p, v in [('C3', .5), ('G3', .45), ('D4', .45), ('E4', .45)]: score.append((g(32), 'piano', p, 3.0, v, .1))

mus = S.render(score, dur=DUR, master=False)
mus = S.room(mus, size=.38, mix=.16)
stems['music'] += mus * .8

# ═════════ 电流嗡（98 Hz ≈ G2，与调性同为 G） ═════════
lamps = ev('lamp')
tt = np.arange(N) / SR
lev_all = np.zeros(N)
hum = np.zeros(N)
for e in lamps:
    t0, fl = e['t'], e['flick']
    lev = np.zeros(N); s0 = int(round(t0 * SR))
    for f, v in enumerate(fl):
        a, b = s0 + int(f / FPS * SR), s0 + int((f + 1) / FPS * SR); lev[a:b] = v
    lev[s0 + int(len(fl) / FPS * SR):] = 1
    lev = np.convolve(lev, np.ones(96) / 96, 'same')
    f0 = 98 * (1 + (e['k'] - 3.5) * .0016)
    ph = rng.random() * 6
    sig = sum(a * np.sin(2 * np.pi * f0 * h * tt + ph * h) for h, a in [(1, 1), (2, .55), (3, .38), (4, .22), (5, .16), (7, .08)])
    hum += sig * lev / np.sqrt(len(lamps)); lev_all += lev
hum = np.tanh(hum * 1.4) * .5
duck = np.ones(N)
for e in ev('pan')[:1]:
    a, b = int(e['t'] * SR), int(e['t1'] * SR); duck[a:b] = np.linspace(1, .6, b - a); duck[b:] = .6
p2 = ev('pan')[1]; a, b = int(p2['t'] * SR), int(p2['t1'] * SR); duck[a:b] = np.linspace(.6, 1, b - a); duck[b:] = 1
# 返修：半拍静默里电流嗡再压 4.5 dB（20 ms 斜坡进，入簇那一帧回到原位，被和弦盖住）
ra, rb, rk = int(REST[0] * SR), int(REST[1] * SR), int(.02 * SR)
duck[ra - rk:ra] *= np.linspace(1, 10 ** (-4.5 / 20), rk); duck[ra:rb] *= 10 ** (-4.5 / 20)
room_t = bp(rng.standard_normal(N), 90, 900) * .02 * np.clip(lev_all / 3, 0, 1)
stems['hum'][:, 0] += ((hum * .11) * duck + room_t).astype(np.float32)
stems['hum'][:, 1] += ((hum * .11) * duck + np.roll(room_t, 300)).astype(np.float32)

# ═════════ 拟音 ═════════
def starter(v=1.):
    d = .35; tt_ = t_(d)
    tick = hp(noise(d), 3000) * np.exp(-tt_ / .0018)
    ping = sum(np.sin(2 * np.pi * f * tt_) * np.exp(-tt_ / k) for f, k in [(2900, .012), (4700, .008), (6100, .005)])
    thump = np.sin(2 * np.pi * 70 * tt_) * np.exp(-tt_ / .045) * np.clip(tt_ / .003, 0, 1)
    tick2 = np.zeros_like(tt_); s = int(.028 * SR); tk = hp(noise(.01), 2500) * np.exp(-t_(.01) / .0012); tick2[s:s + len(tk)] = tk[:len(tick2) - s]
    return norm(tick * 1.0 + ping * .35 + thump * .55 + tick2 * .35) * v
def buzz(d, lvl):
    tt_ = t_(d); x = (np.abs(np.sin(2 * np.pi * 50 * tt_)) ** 6) * bp(noise(d), 600, 5000)
    return x * lvl * np.hanning(len(tt_)) ** .3
def plastic_click(v=1., bright=1.):
    d = .25; tt_ = t_(d)
    tick = bp(noise(d), 2000, 9000) * np.exp(-tt_ / .0022)
    ring = sum(a * np.sin(2 * np.pi * f * bright * tt_) * np.exp(-tt_ / k) for f, a, k in [(3150, .5, .05), (5230, .35, .035), (7400, .2, .02)])
    body = np.sin(2 * np.pi * 420 * tt_) * np.exp(-tt_ / .012)
    return norm(tick + ring * .5 + body * .5) * v
def friction(d, lo, hi, shape):
    x = bp(noise(d), lo, hi); n = len(x); u = np.linspace(0, 1, n)
    return x * shape(u)
def pencil_tap(n, v=1.):
    d = .14; tt_ = t_(d)
    click = bp(noise(d), 1800, 7000) * np.exp(-tt_ / .0016)
    paper = bp(noise(d), 220, 900) * np.exp(-tt_ / .012)
    x = click * 1.0 + paper * .7
    m = min(n - 1, 14)
    for j in range(m):                       # 多点的一下：主击后紧跟细碎点刺（≤ 40 ms）
        s = int((.004 + .036 * (j + rng.random()) / max(1, m)) * SR); tk = bp(noise(.01), 2500, 8000) * np.exp(-t_(.01) / .0012)
        x[s:s + len(tk)] += tk[:len(x) - s] * (.55 - .25 * j / max(1, m)) * rng.uniform(.6, 1)
    return fade(norm(x) * v, .0005, .01)
def wood_knock(v=1.):
    d = .3; tt_ = t_(d)
    body = sum(a * np.sin(2 * np.pi * f * tt_) * np.exp(-tt_ / k) for f, a, k in [(880, 1, .03), (1960, .4, .015), (3300, .2, .008)])
    return norm(body + bp(noise(d), 2000, 8000) * np.exp(-tt_ / .002) * .6) * v
def scratch(d, v=1., rate=9):
    tt_ = t_(d); x = bp(noise(d), 1800, 7500)
    am = .5 + .5 * np.abs(np.sin(np.pi * rate * tt_ + rng.random() * 3)) ** 1.5
    return fade(x * am * v, .006, .02)
def sweep(d, v=1., lo=500, hi=4000):
    x = bp(noise(d), lo, hi); u = np.linspace(0, 1, len(x)); return x * np.sin(np.pi * u) ** 1.5 * v
def slap(v=1.):
    d = .3; tt_ = t_(d)
    burst = bp(noise(d), 900, 6000) * np.exp(-tt_ / .006)
    body = np.sin(2 * np.pi * 185 * tt_) * np.exp(-tt_ / .02)
    tick = hp(noise(d), 4000) * np.exp(-tt_ / .0012)
    return norm(burst + body * .6 + tick * .8) * v

F = stems['foley']; TP = stems['taps']
for e in lamps:
    add(F, starter(.9 + .1 * rng.random()), e['t'], .85, (e['tube'] - 3.5) / 6)
    for f, v in enumerate(e['flick']):                    # 频闪：与画面逐帧同步的嗞嗞
        add(F, buzz(1 / FPS, (1 - v) * .5 + .15), e['t'] + f / FPS, .25, (e['tube'] - 3.5) / 6)
sm = one('slide_move')
d = sm['t1'] - sm['t']
add(F, friction(d, 700, 4200, lambda u: (u ** 1.2) * (1 - u ** 8) * .5 + .02), sm['t'], .18, -.4)
add(F, plastic_click(1.0), sm['t1'], .9, .05)
for e in ev('label'): add(F, plastic_click(.35, 1.4), e['t'], .35, -.2)
lm = one('loupe_move'); d = lm['t1'] - lm['t']
add(F, friction(d, 3000, 10000, lambda u: np.sin(np.pi * u) ** 1.5), lm['t'], .06, .3)
lt = one('loupe')['t']; tt_ = t_(.2)
add(F, norm(np.sin(2 * np.pi * 300 * tt_) * np.exp(-tt_ / .03) + bp(noise(.2), 1500, 6000) * np.exp(-tt_ / .004) * .4), lt, .3, 0)
for e in ev('pan'):
    d = e['t1'] - e['t']; x = sweep(d, 1., 400, 3500)
    n_ = len(x); L = x * np.linspace(1, .3, n_) if e['dir'] > 0 else x * np.linspace(.3, 1, n_); R = x * np.linspace(.3, 1, n_) if e['dir'] > 0 else x * np.linspace(1, .3, n_)
    s = int(e['t'] * SR); F[s:s + n_, 0] += L[:N - s] * .13; F[s:s + n_, 1] += R[:N - s] * .13
for e in ev('tap'):
    b = e['beat']; v = 1.0 if b < 20 else .88 if b < 22 else .78 if b < 24 else .7
    add(TP, pencil_tap(e['n'], v), e['t'], .62, ((e['i'] * 37) % 11 - 5) / 12)
add(F, wood_knock(1.), one('n477')['t'], .55, -.5)
sw = one("swarm"); d = sw["t1"] - sw["t"]; n_ = int(round(d * SR)); d = n_ / SR; x = np.zeros(n_)
u = np.linspace(0, 1, n_)
rate = 60 + 1500 * u ** 2; pos = np.where(rng.random(n_) < rate / SR)[0]
x[pos] = rng.standard_normal(len(pos)) * (.3 + .7 * u[pos])
x = bp(np.convolve(x, np.exp(-np.arange(60) / 8)), 2500, 9000)[:n_] * 1.2 + bp(noise(d), 1500, 6000) * u ** 2.5 * .25
# 返修：g27.5 起的半拍真正静下来——群声降 12 dB 并高通到 4 kHz 以上，只留一层极轻的尾音
r0 = int(round((REST[0] - sw['t']) * SR)); kx = int(.02 * SR)
if 0 < r0 < n_:
    tail = hp(x[r0 - kx:], 4000) * 10 ** (-12 / 20)
    w = np.linspace(0, 1, kx)
    x[r0 - kx:r0] = x[r0 - kx:r0] * (1 - w) + tail[:kx] * w; x[r0:] = tail[kx:]
x[-int(.002 * SR):] *= np.linspace(1, 0, int(.002 * SR))      # 硬止于入簇的那一帧
add(F, x, sw['t'], .38, .1)
add(F, slap(.9), TCLU, .6, 0)
for e in ev('name'): add(F, scratch(e['dur'], .5, 14), e['t'], .06, ((e['i'] % 4) - 1.5) / 4)
r = one('ring'); add(F, scratch(r['dur'], 1., 4), r['t'], .15, -.5)
nt = one('note'); add(F, scratch(nt['t1'] - nt['t'], 1., 7), nt['t'], .15, -.5)
add(F, sweep(.35, 1., 600, 4500), one('merge')['t'], .18, 0)
for e in ev('outline'): add(F, scratch(e['dur'], .8, 3), e['t'], .1, ((e['k'] % 2) - .5) * .7)
add(F, plastic_click(.3, 1.3), one('caption')['t'], .25, 0)
for e in ev('sleeve_fly'): add(F, friction(e['t1'] - e['t'], 2500, 10000, lambda u: u ** 2), e['t'], .12, -.25 + .3 * e['k'])   # 从左下那一叠抽出
for e in ev('sleeve'):
    add(F, slap(1.), e['t'], .7, (e['k'] - 1) * .35)
    d = min(e['settle'], DUR - e['t'] + .01)
    add(F, friction(d, 2000, 9000, lambda u: np.exp(-u * 3) * .6), e['t'] + .01, .12, (e['k'] - 1) * .35)

# ═════════ 混音 ═════════
# 静默半拍：除点群群声外全部清空（防止残响漏进）
a, b = int(REST[0] * SR), int(REST[1] * SR)
k = int(.03 * SR)
for key in ('music', 'taps'):
    stems[key][a:a + k] *= np.linspace(1, 0, k)[:, None]; stems[key][a + k:b] = 0
mix = stems['music'] * 1.0 + stems['hum'] * 1.0 + stems['foley'] * 1.0 + stems['taps'] * 1.0
mix = np.stack([hp(mix[:, 0], 32), hp(mix[:, 1], 32)], 1)
mix = np.stack([limit(mix[:, 0], .9), limit(mix[:, 1], .9)], 1).astype(np.float32)
ke = int(.12 * SR); mix[-ke:] *= np.linspace(1, 0, ke)[:, None] ** 1.5
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
for kname, x in stems.items(): sf.write(os.path.join(HERE, 'out', 'stems', kname + '.wav'), x, SR, subtype='FLOAT')
# 峰值控制：mux 要做到 −14 LUFS 且真峰值 ≤ −1.2 dBTP，峰值与响度之差须 < 12 dB。量响度 → 按目标比值再限幅（两轮）
import subprocess, tempfile
def lufs(x):
    f = tempfile.mktemp(suffix='.wav'); sf.write(f, x, SR, subtype='FLOAT')
    o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    os.remove(f); return float(o.rsplit('I:', 1)[1].split('LUFS')[0])
for _ in range(3):
    L = lufs(mix); ceil = 10 ** ((L + 9.8) / 20)
    if np.abs(mix).max() <= ceil * 1.01: break
    mix = np.stack([limit(mix[:, 0], ceil, .002), limit(mix[:, 1], ceil, .002)], 1).astype(np.float32)
    print('limit', round(L, 2), 'LUFS, ceil', round(20 * np.log10(ceil), 2), 'dBFS')
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
print('mix ok', mix.shape, 'peak', float(np.abs(mix).max()))
