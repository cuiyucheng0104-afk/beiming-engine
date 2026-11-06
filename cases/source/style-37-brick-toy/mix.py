# 配乐 + 拟音 + 环境 → out/mix.wav；并写 out/cues_audio.json 供拍点核对
# 全部时间来自 events.json（由 timeline.js / main.js 导出）：网格、动作、撞击。
import sys, os, json
import numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit, click, clack, crash, whoosh, creak, thump, step, ding, noise, brown, lp, hp, bp, env_exp, t_, norm

HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json'))); DUR = E['dur']; N = int(round(DUR * SR)) + 1
EV = E['ev']
GRID = next(e for e in EV if e['type'] == 'grid')['grid']
gb, gt = np.array([g[0] for g in GRID]), np.array([g[1] for g in GRID])
def Bt(b): return float(np.interp(b, gb, gt))          # 拍 → 秒（与画面同一张帧对齐网格）
S.seed(11); rng = np.random.default_rng(5)
onsets = []                                              # (时间, 声部) 供核对

# ———————————————————— 配乐 ————————————————————
score = []
def n(b, inst, pitch, durb, vel, pan=0., gain=1., **kw):
    t = Bt(b); d = Bt(b + durb) - t
    score.append(dict(t=t, inst=inst, pitch=pitch, dur=d, vel=vel, pan=pan, gain=gain, **kw)); onsets.append((t, inst))
CH = {'F': ['F3', 'C4', 'A3', 'C4'], 'Bb': ['Bb2', 'F3', 'D4', 'F3'], 'C': ['C3', 'G3', 'E4', 'G3'], 'Dm': ['D3', 'A3', 'F4', 'A3']}
def ostinato(b0, b1, chords, vel=.45, pan=-.25):
    b = b0
    while b < b1 - 1e-6:
        ch = chords(b); pat = CH[ch]; k = int(round((b - b0) * 2)) % 4
        n(b, 'marimba', pat[k], .5, vel * (1.08 if k == 0 else .92), pan)
        b += .5

# A 段（b0–b8）：马林巴八分音型 + 拨弦低音；b2 木琴主题进入（焦点落在「家」字砖）
ostinato(0, 8, lambda b: 'F' if b < 4 else 'Bb' if b < 6 else 'C', vel=.4)
for b, p in [(0, 'F2'), (2, 'C2'), (4, 'Bb1'), (6, 'C2')]: n(b, 'contrabass_pizz', p, 1.5, .62, .1)
THEME = [(0, 'A5', .5), (.5, 'C6', .5), (1, 'F6', .5), (1.5, 'E6', .5), (2, 'D6', .5), (2.5, 'F6', .5), (3, 'D6', .5), (3.5, 'Bb5', .5), (4, 'C6', .5), (4.5, 'E6', .5), (5, 'G6', 1)]
for db, p, d in THEME: n(2 + db, 'xylophone', p, d, .55, .2)
n(7, 'glockenspiel', 'C7', 1.5, .5, .3); n(7, 'glockenspiel', 'G6', 1.5, .4, .3)       # 伸懒腰的亮点
for k, b in enumerate([4, 5, 6]): n(b, 'woodblock', None, .3, .35 + k * .05, -.4)        # 三步：木鱼跟脚

# B 段（b8–b16）：桌震 → 定音鼓心跳 + 半音下行拨弦 → 崩塌后的下行减速
n(8, 'timpani', 'F2', 1.5, .8, 0); n(8, 'contrabass_pizz', 'F1', 1, .7)
for b in [9, 10]: n(b, 'timpani', 'F2', .5, .45, 0)
for i, (b, p) in enumerate([(9, 'D3'), (9.5, 'C#3'), (10, 'C3'), (10.5, 'B2')]): n(b, 'cellos_pizz', p, .5, .55 + i * .05, -.15)
for i in range(16):   # b11–b12 定音鼓滚奏渐强
    n(11 + i / 16, 'timpani', 'C3', .1, .25 + .5 * i / 16, 0, gain=.8)
n(11, 'sus_cymbal', None, 1, .25, .2)
n(12, 'timpani', 'F2', 2, .95, 0); n(12, 'contrabass_pizz', 'F1', 1, .8)
for b, p, v in [(12, 'F6', .7), (12.25, 'D6', .66), (12.5, 'Bb5', .62), (12.75, 'G5', .58), (13, 'F5', .55), (13.5, 'D5', .5), (14, 'Bb4', .45)]:
    n(b, 'marimba', p, .5, v, .15)
n(15, 'marimba', 'G4', .8, .38, .15); n(14, 'cellos_pizz', 'Bb2', .8, .4); n(15, 'cellos_pizz', 'C3', .8, .3)
# b16–b18：静默（不写任何音符）

# C 段（b18–b28）：b18 只有那一声咔哒；之后每块零件落下一个上行音，越来越快
UP = {20: 'F4', 21: 'G4', 22: 'A4', 23: 'Bb4', 24: 'C5', 24.5: 'D5', 25: 'E5', 25.5: 'F5', 26: 'G5', 26.5: 'A5'}
for b, p in UP.items():
    n(b, 'marimba', p, .6, .62, .1); n(b, 'xylophone', S.name(S.midi(p) + 12), .4, .4 + (b - 20) * .03, .25)
for b, p in [(20, 'F2'), (22, 'D2'), (24, 'Bb1'), (25, 'C2'), (26, 'C2')]: n(b, 'contrabass_pizz', p, 1, .6, .1)
ostinato(22, 27, lambda b: 'Dm' if b < 24 else 'Bb' if b < 26 else 'C', vel=.3, pan=-.3)
for b in np.arange(22.5, 27, 1.0):   # 班卓（物理建模拨弦）反拍
    ch = 'Dm' if b < 24 else 'Bb' if b < 26 else 'C'
    for j, p in enumerate(CH[ch][1:]): score.append(dict(t=Bt(b) + j * .012, pluck=('banjo', p, .35, .32), pan=.35))
    onsets.append((Bt(b), 'banjo'))
for b in [24, 26]: n(b, 'glockenspiel', 'F6' if b == 24 else 'A6', 1, .35, -.3)
# b27–b28：音乐抽空，只剩咔哒

# 高潮（b28）：F 大调 add9 大和弦——马林巴滚奏、钢片琴、木琴、圆号、拨弦、定音鼓、吊镲
for p in ['F3', 'A3', 'C4', 'F4']:
    for i in range(16): n(28 + i * .125, 'marimba', p, .2, .7 * (1 - i / 20), -.2 + .13 * ['F3', 'A3', 'C4', 'F4'].index(p), gain=.55)
for p in ['F6', 'A6', 'C7']: n(28, 'glockenspiel', p, 3, .62, .25)
for j, p in enumerate(['F5', 'A5', 'C6', 'G6']): n(28 + j * .06, 'xylophone', p, 1, .6, .3)
for p in ['F3', 'A3', 'C4', 'G4']: score.append(dict(t=Bt(28), inst='horn', pitch=p, dur=Bt(31) - Bt(28), vel=.62, pan=-.1, attack=.04, gain=.8))
for j, p in enumerate(['F4', 'A4', 'C5', 'F5']): n(28 + j * .05, 'violins_pizz', p, 1, .6, .2)
n(28, 'contrabass_pizz', 'F1', 2, .85); n(28, 'timpani', 'F2', 2, .85); n(28, 'sus_cymbal', None, 2, .5, -.2)
score.append(dict(t=Bt(28), pluck=('music_box', 'C7', 2.5, .5), pan=.4))

# D 段（b29–b38）：尤克里里反拍 + 马林巴 + 陶笛主题再现 + 圆号铺底，b36 收
UKE = {'F': ['F4', 'A4', 'C5', 'F5'], 'Bb': ['F4', 'Bb4', 'D5', 'F5'], 'C': ['E4', 'G4', 'C5', 'E5']}
hc = lambda b: 'F' if b < 31 else 'Bb' if b < 33 else 'C' if b < 35 else 'F'
for b in np.arange(29.5, 36, 1.0):
    for j, p in enumerate(UKE[hc(b)]): score.append(dict(t=Bt(b) + j * .018, inst='ukulele', pitch=p, dur=.35, vel=.5, pan=.3))
    onsets.append((Bt(b), 'ukulele'))
ostinato(30, 36, lambda b: hc(b), vel=.36, pan=-.25)
for b in [30, 31, 32, 33, 34, 35]: n(b, 'contrabass_pizz', {'F': 'F2', 'Bb': 'Bb1', 'C': 'C2'}[hc(b)], 1, .6, .1)
for db, p, d in THEME[:-1]: n(30 + db, 'ocarina', p.replace('6', '5') if p.endswith('6') else p.replace('5', '4'), d, .5, -.05, gain=.75)
n(35, 'ocarina', 'G5', 1, .5, -.05, gain=.75)
for b, ps, d in [(32, ['F3', 'C4', 'A4'], 2), (34, ['E3', 'C4', 'G4'], 2)]:
    for p in ps: score.append(dict(t=Bt(b), inst='horn', pitch=p, dur=Bt(b + d) - Bt(b), vel=.5, pan=-.1, attack=.25, gain=.7))
# 收尾 b36
n(36, 'ocarina', 'F5', 2.2, .5, -.05, gain=.75)
for p in ['F6', 'C7']: n(36, 'glockenspiel', p, 3, .6, .2)
for p in ['F3', 'F4']: n(36, 'marimba', p, 1, .55, -.2)
for p in ['F3', 'A3', 'C4']: score.append(dict(t=Bt(36), inst='horn', pitch=p, dur=DUR - Bt(36) - .1, vel=.52, pan=-.1, attack=.05, gain=.7))
n(36, 'contrabass_pizz', 'F1', 2, .7)
for j, p in enumerate(UKE['F']): score.append(dict(t=Bt(36) + j * .025, inst='ukulele', pitch=p, dur=1.5, vel=.55, pan=.3))
score.append(dict(t=Bt(36), pluck=('music_box', 'F6', 3, .45), pan=.4))

def render_score(evs):
    buf = np.zeros((N, 2))
    for e in evs:
        if 'pluck' in e:
            pr, p, d, v = e['pluck']; x = P.pluck(pr, p, d, vel=v); add(buf, x, e['t'], .55, e['pan']); continue
        if e['inst'] in ('contrabass_pizz', 'timpani'): e = dict(e, gain=e.get('gain', 1.) * .75)
        if e['pitch'] is None: x = S.hit(e['inst'], None, e['vel'], e['dur'] + .6)
        else: x = S.note(e['inst'], e['pitch'], e['dur'], vel=e['vel'], attack=e.get('attack', 0))
        add(buf, x, e['t'], e.get('gain', 1.) * .5, e['pan'])
    return buf
mus = render_score(score)
mus = S.room(mus, size=.32, mix=.16)
# 静默段硬保证：b16–b18 音乐为零（尾音在 b16 前 60 ms 收掉）
a, b_ = int((Bt(16) - .06) * SR), int(Bt(18) * SR)
fade = np.linspace(1, 0, int(.06 * SR)); mus[a:a + len(fade)] *= fade[:, None]; mus[a + len(fade):b_] = 0
# b27–b28 抽空：只留极弱的余音
a, b_ = int((Bt(27) - .03) * SR), int(Bt(28) * SR)
fade = np.linspace(1, .05, int(.05 * SR)); mus[a:a + len(fade)] *= fade[:, None]; mus[a + len(fade):b_] *= .05

# ———————————————————— 拟音（从 window.EV） ————————————————————
fx = np.zeros((N, 2)); amb = np.zeros((N, 2))
def clink(v=1.):   # 瓷杯：高频非谐分音 + 短噪声
    d = .5; tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * tt) * env_exp(d, tau) for f, a, tau in [(2350, 1, .09), (3910, .6, .06), (5230, .45, .045), (7120, .25, .03)])
    return norm(x + hp(noise(d), 3000) * env_exp(d, .004) * .6) * v
def scrape(v=1.):
    d = .45; return norm(bp(noise(d), 1800, 5200) * np.sin(np.pi * t_(d) / d) * (1 + .5 * np.sin(2 * np.pi * 31 * t_(d)))) * v
def gush(d, v=1.):   # 水：低通棕噪声的涌动 + 一阵塑料圆板的细碎咔哒（水是积木做的）
    tt = t_(d); body = lp(brown(d), 1800) * np.minimum(1, tt / .08) * np.exp(-tt / (d * .45))
    out = body * .8; rr = np.random.default_rng(9)
    for k in range(60):
        s = int((rr.random() ** 1.6) * d * .8 * SR); c = click(2.2 + rr.random() * .8, .12 + rr.random() * .25)
        out[s:s + len(c)] += c[:len(out) - s]
    return norm(out) * v
def drip(v=1.):
    d = .25; tt = t_(d); f = 900 + 1700 * np.minimum(1, tt / .03)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .035); c = click(2.6, .2); x[:len(c)] += c[:len(x)] * .3
    return norm(x) * v
def splash(v=1., d=.45):
    tt = t_(d); x = bp(noise(d), 700, 6500) * env_exp(d, .07)
    rr = np.random.default_rng(int(v * 1000))
    for k in range(5):
        s = int(rr.random() * .25 * SR); c = drip(.25 + rr.random() * .3)
        x[s:s + len(c)] += c[:len(x) - s] * .4
    return norm(x) * v

cues = []
for e in EV:
    ty, t, v = e['type'], e['t'], e.get('v', 1.)
    pan = float(rng.uniform(-.25, .25))
    if ty == 'step': add(fx, step(v), t, .35, 0); cues.append(('step', t))
    elif ty == 'creak': add(fx, creak(v), t - .05, .2, 0); cues.append(('stretch', t))
    elif ty == 'bump':
        add(fx, thump(1, 64), t, .5, 0); add(fx, lp(noise(.25), 500) * env_exp(.25, .04), t, .35, 0)
        for k in range(6): add(fx, clack(1.2 + k * .1, .4), t + .02 + k * .025, .25, (k % 3 - 1) * .4)
    elif ty == 'clink': add(fx, clink(v), t, .45, .35)
    elif ty == 'scrape': add(fx, scrape(v), t, .3, .35)
    elif ty == 'cupland':
        add(fx, thump(1, 96), t, .45, .3); add(fx, clink(1.), t, .45, .3); cues.append(('cupland', t))
    elif ty == 'gush': add(fx, gush(e['d'], 1.), t, .55, .2)
    elif ty == 'crash': add(fx, crash(1.), t, .6, 0); add(fx, thump(.8, 80), t, .25, 0)
    elif ty == 'whoosh': add(fx, whoosh(max(.12, e.get('d', .35)), v), t, .3, pan)
    elif ty == 'clack': add(fx, clack(float(rng.uniform(.8, 1.3)), v), t, .38, pan)
    elif ty == 'land': add(fx, clack(.9, .9), t, .5, -.3); add(fx, thump(.5, 110), t, .3, -.3); cues.append(('raft', t))
    elif ty == 'drip': add(fx, drip(1.), t, .1, .3); cues.append(('drip', t))
    elif ty == 'click':
        first = e.get('beat') == 18
        x = click(1.0 if first else float(rng.uniform(.92, 1.12)), 1.)
        add(fx, x, t, (.95 if first else .5) * v, 0 if first else pan)
        if first: add(fx, thump(.5, 150), t, .35, 0)   # 第一声咔哒加一点木质的“托底”，限幅后依然是全片最醒目的一声
        if e.get('n', 1) > 1: add(fx, click(1.15, .8), t + .012, .35 * v, -pan)
        cues.append((f"build:{e['id']}" if e.get('beat') is not None else 'click', t))
    elif ty == 'ding': add(fx, ding(.8), t, .25, 0)
    elif ty == 'hopland': add(fx, clack(.8, 1.), t, .55, 0); add(fx, splash(.9), t, .5, .1); cues.append(('hop', t))
    elif ty == 'stroke': add(fx, splash(.8, .5), t, .45, .3); add(fx, clack(.6, .6), t, .25, .3); cues.append(('stroke', t))
# 环境：房间底噪（全程）+ 时钟滴答（每两拍一下，b18 让位给第一声咔哒）+ 水面细流（倒水后，b16 前淡出；b29 起船行）
room = lp(brown(DUR + .1), 260)[:N] * .018; amb[:, 0] += room; amb[:, 1] += np.roll(room, 997)
for b in np.arange(0, 38, 2):
    if b == 18: continue
    tick = hp(noise(.02), 3200) * env_exp(.02, .002); add(amb, tick, Bt(b), .05, .6)
def bed(t0, t1, lvl):
    d = t1 - t0; x = bp(noise(d), 500, 4000) * .5 + lp(brown(d), 700) * .5
    e = np.minimum(1, t_(d) / .3) * np.minimum(1, (d - t_(d)) / .5); add(amb, norm(x) * e * lvl, t0, 1., .1)
bed(Bt(11.5), Bt(16) - .05, .05); bed(Bt(29), DUR, .04)

# ———————————————————— 混音 ————————————————————
from scipy.ndimage import maximum_filter1d, uniform_filter1d
key = np.zeros(N)   # 关键拟音处把音乐让开一点
for e in EV:
    if e['type'] in ('crash', 'bump', 'cupland') or (e['type'] == 'click' and e.get('beat') == 18):
        s = int(e['t'] * SR); key[s:s + int(.25 * SR)] = 1
duck = 1 - .35 * np.clip(uniform_filter1d(maximum_filter1d(key, int(.05 * SR)), int(.08 * SR)), 0, 1)
mus = np.stack([hp(mus[:, c], 38) for c in range(2)], 1)
mix = mus * 1.45 * duck[:, None] + fx * .9 + amb
end = int((DUR - .35) * SR); mix[end:] *= np.linspace(1, 0, len(mix) - end)[:, None]
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
# 母带前处理：真峰值限幅（4 倍过采样）+ 增益分级，让混音本身就落在 −14 LUFS / −1.6 dBTP 附近，
# mux.sh 的两遍 loudnorm 只需做线性微调（否则高密度咔哒的瞬态会让它退回动态模式、真峰值超标）
import subprocess, tempfile
from scipy.signal import resample_poly
from scipy.ndimage import minimum_filter1d
def lufs(x):
    with tempfile.NamedTemporaryFile(suffix='.wav') as f:
        sf.write(f.name, x.astype(np.float32), SR)
        r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f.name, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = float([l for l in r.splitlines() if l.strip().startswith('I:')][-1].split()[1])
    P = float([l for l in r.splitlines() if l.strip().startswith('Peak:')][-1].split()[1])
    return I, P
def tp_limit(x, ceil_db):
    c = 10 ** (ceil_db / 20); up = resample_poly(x, 4, 1, axis=0); n = int(.0015 * SR * 4)
    env = maximum_filter1d(np.abs(up).max(1), 2 * n + 1)
    g = uniform_filter1d(minimum_filter1d(np.minimum(1, c / np.maximum(env, 1e-9)), 2 * n + 1), n)
    return resample_poly(up * g[:, None], 1, 4, axis=0)[:len(x)]
src = mix.copy(); I0, _ = lufs(src); gain = -14.1 - I0
for it in range(4):
    mix = tp_limit(src * 10 ** (gain / 20), -2.0); I, P = lufs(mix)
    print('master pass %d: gain %+.2f dB → %.2f LUFS, %.2f dBTP' % (it, gain, I, P))
    if abs(I + 14.1) < .15: break
    gain += -14.1 - I
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
json.dump({'music_onsets': sorted(onsets), 'sfx_cues': cues, 'silence': [Bt(16), Bt(18)]}, open(os.path.join(HERE, 'out', 'cues_audio.json'), 'w'))
# 低频平衡：20–120 Hz 相对其余频段
spec = np.abs(np.fft.rfft(mix.mean(1))) ** 2; fr = np.fft.rfftfreq(len(mix), 1 / SR)
lo = spec[(fr > 20) & (fr < 120)].sum(); hi = spec[(fr >= 120) & (fr < 16000)].sum()
print('mix peak %.3f rms %.4f  low/rest %.1f dB' % (np.abs(mix).max(), np.sqrt((mix ** 2).mean()), 10 * np.log10(lo / hi)))
