# 《纸龙》配乐 + 拟音 + 环境声 → out/mix.wav，并导出 out/score_onsets.json（拍点核对用）
# 乐器：钢片琴（numpy 模态合成）、小提琴/大提琴/低音提琴拨弦、竖琴、钟琴、颤音琴、定音鼓、三角铁、木鱼（真实采样，CC0）、八音盒（pluck.py 物理建模）
# 节奏层：纸张翻动/纸摇沙（合成）。全部时间来自 timeline.js 与 events.json。
import json, os, sys, subprocess
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, limit
from scipy.signal import butter, sosfilt, fftconvolve

TL = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', f"import('{HERE}/timeline.js').then(m=>console.log(JSON.stringify({{SECS:m.SECS,T:m.T,CUTS:m.CUTS,DUR:m.DUR}})))"]))
SEC = {s['id']: s for s in TL['SECS']}; T = TL['T']; DUR = TL['DUR']; N = int(round(DUR * SR))
def b(sec, beat): s = SEC[sec]; return round(s['t'] + beat * 60 / s['bpm'], 6)
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
rng = np.random.default_rng(41); S.seed(41)

def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def tt(d): return np.arange(int(d * SR)) / SR
def noise(n): return rng.standard_normal(n)
def ex(t, a, r): return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / max(r, 1e-4))
def sm(*xs):
    n = max(len(x) for x in xs); return sum(np.pad(np.asarray(x, float), (0, n - len(x))) for x in xs)
def norm(x, p=1.0): return x / (np.abs(x).max() + 1e-9) * p
def hz(m): return 440 * 2 ** ((m - 69) / 12)
NAMES = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def mi(p):
    if isinstance(p, (int, float)): return p
    k = NAMES[p[0]]; i = 1
    if p[1] == '#': k += 1; i = 2
    elif p[1] == 'b': k -= 1; i = 2
    return 12 * (int(p[i:]) + 1) + k

music = np.zeros((N, 2), np.float32); sfx = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32)
ONSETS = []
def put(buf, x, t, g=1.0, pan=0.0):
    add(buf, np.asarray(x, np.float32), t, g, pan)

# ---------- 乐器 ----------
def celesta(p, dur=1.2, vel=.7):
    """钢片琴：毡锤击钢片 + 木共鸣箱。基音为主、2.76 倍泛音带出钟声，越高越短。"""
    f = hz(mi(p)); d = max(dur, .4) + 1.6; t = tt(d); k = (523 / f) ** .45
    x = (np.sin(2 * np.pi * f * t) * np.exp(-t / (1.3 * k)) + .2 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / (.5 * k))
         + .3 * np.sin(2 * np.pi * 2.756 * f * t + 1) * np.exp(-t / (.18 * k)) + .1 * np.sin(2 * np.pi * 5.4 * f * t) * np.exp(-t / .05))
    x *= np.minimum(1, t / .0025)
    x[int(dur * SR):] *= np.exp(-(t[int(dur * SR):] - dur) / .25) if dur < d else 1
    x += lp(noise(len(t)), 1800) * np.exp(-t / .006) * .25           # 毡锤
    return x * vel * .5
def mbox(p, vel=.6, dur=1.6): return P.pluck('music_box', p, dur, vel)
SAMPLED = []
def N_(t, inst, p, dur=.6, vel=.6, pan=0., g=1.):
    SAMPLED.append((t, inst, p, dur, vel, pan, g)); ONSETS.append({'t': t, 'inst': inst})
def C_(t, p, dur=.8, vel=.6, pan=0., g=1.):
    put(music, celesta(p, dur, vel), t, g * .9, pan); ONSETS.append({'t': t, 'inst': 'celesta'})
def MB(t, p, vel=.6, pan=0., g=1.):
    put(music, mbox(p, vel), t, g * .55, pan); ONSETS.append({'t': t, 'inst': 'music_box'})

# ===== A 翻开（0–2.4） =====
for bt, p, v in [(0, 'B5', .35), (.5, 'D6', .32), (1, 'G6', .5), (2, 'F#6', .45), (2.5, 'E6', .38), (3, 'D6', .5), (3.5, 'B5', .5)]:
    C_(b('open', bt), p, .7, v, .15)
N_(b('open', 1), 'harp', 'G3', 1.2, .35, -.3); N_(b('open', 2), 'harp', 'D4', 1.0, .3, -.3)
N_(b('open', 3), 'harp', 'G4', .6, .4, -.2); N_(b('open', 3.5), 'harp', 'B4', .6, .42, -.2)

# ===== B 城堡（2.4–7.2）：拨弦低音 + 反拍拨弦和弦 + 钢片琴旋律 =====
bass = ['G2', 'D3', 'F#2', 'D3', 'E2', 'B2', 'C3', 'G2']
chords = [['D5', 'G5'], ['D5', 'G5'], ['D5', 'F#5', 'A5'], ['D5', 'F#5', 'A5'], ['E5', 'G5', 'B5'], ['E5', 'G5', 'B5'], ['E5', 'G5', 'C6'], ['E5', 'G5', 'C6']]
for i in range(8):
    N_(b('castle', i), 'cellos_pizz', bass[i], .5, .62 if i % 2 == 0 else .5, -.25)
    if i % 2 == 0: N_(b('castle', i), 'contrabass_pizz', mi(bass[i]) - 12, .6, .45, -.1)
    for p in chords[i]: N_(b('castle', i + .5), 'violins_pizz', p, .3, .42, .3)
mel = [(0, 'D6', .8), (.5, 'B5', .5), (.75, 'C6', .45), (1, 'D6', .6), (1.5, 'G6', .55), (2, 'F#6', .7), (2.5, 'E6', .5), (3, 'D6', .55), (3.5, 'A5', .5),
       (4, 'G6', .8), (5, 'F#6', .6), (5.5, 'E6', .5), (6, 'E6', .6), (6.5, 'D6', .5), (7, 'C6', .55), (7.5, 'B5', .5)]
for bt, p, v in mel: C_(b('castle', bt), p, .5, v, .1)
N_(b('castle', 0), 'glockenspiel', 'G6', 1.5, .35, .2)
N_(b('castle', 4), 'timpani', 'E2', 1.0, .5, 0); N_(b('castle', 4), 'glockenspiel', 'B6', 1.2, .3, .2)
for i in (5, 6, 7): N_(b('castle', i), 'woodblock', 'a' if i % 2 else 'b', None, .35, .35)

# ===== C 纸龙（7.2–10.8）：低音固定音型 → 竖琴刮奏 → 十六分音符钢片琴（加速） → 定音鼓滚奏 → 硬截断 =====
N_(b('dragon', 0), 'timpani', 'A2', 1.5, .45, 0); N_(b('dragon', 0), 'vibraphone', 'A4', 1.6, .3, -.2); N_(b('dragon', 0), 'vibraphone', 'C5', 1.6, .28, .2)
for k, p in enumerate(['A2', 'E3', 'A3', 'E3']): N_(b('dragon', k * .5), 'cellos_pizz', p, .4, .55, -.2)
N_(b('dragon', 1), 'harp', 'E4', .8, .45, .3); N_(b('dragon', 1), 'harp', 'G4', .8, .4, .3)
gl = ['A3', 'C4', 'E4', 'G4', 'A4', 'C5', 'E5', 'G5', 'A5']           # 刮奏：落在 emerge 上
for k, p in enumerate(gl[:-1]): N_(round(b('dragon', 2) - (len(gl) - 1 - k) * .0375, 6), 'harp', p, .5, .35 + k * .04, -.3 + k * .07)
N_(b('dragon', 2), 'harp', 'A5', 1.0, .6, .3); C_(b('dragon', 2), 'A6', .8, .55, .2); N_(b('dragon', 2), 'timpani', 'D3', 1.0, .55, 0)
arps = {2: ['D6', 'F#6', 'A6', 'C7'], 3: ['A6', 'F#6', 'D6', 'C6'], 4: ['B5', 'D6', 'F#6', 'A6'], 5: ['C6', 'E6', 'G6', 'B6']}
for bt, ns in arps.items():
    for j, p in enumerate(ns): C_(b('dragon', bt + j * .25), p, .25, .42 + .06 * (j == 0) + (bt - 2) * .03, -.2 + j * .13)
lowb = {2: ['D3', 'A2'], 3: ['D3', 'A2'], 4: ['B2', 'F#3'], 5: ['C3', 'G3']}
for bt, ns in lowb.items():
    for j, p in enumerate(ns): N_(b('dragon', bt + j * .5), 'cellos_pizz', p, .4, .6, -.2)
    N_(b('dragon', bt), 'contrabass_pizz', mi(ns[0]) - 12, .5, .45, -.1)
    N_(b('dragon', bt + .5), 'violins_pizz', ns[0][:-1] + '5', .3, .4, .3)
roll_t = np.arange(b('dragon', 4), b('dragon', 6) - .03, .045)
for k, t in enumerate(roll_t): SAMPLED.append((round(float(t), 6), 'timpani', 'D3', .2, .18 + .5 * k / len(roll_t), 0, 1.0))
N_(b('dragon', 5.5), 'triangle', 'roll', .55, .25, .4)

# ===== D 静默（10.8–12.0）：没有音乐 =====

# ===== E 夜（12.0–16.8）：静默后第一声 + 漂浮 + 烟花 =====
t0 = b('night', 0)
N_(t0, 'timpani', 'G2', 2.5, .75, 0); N_(t0, 'contrabass_pizz', 'G1', 1.5, .55, -.1); N_(t0, 'glockenspiel', 'G6', 2.5, .55, .25)
for j, p in enumerate(['G2', 'D3', 'G3', 'B3', 'D4', 'G4', 'B4', 'D5']): N_(round(t0 + j * .0375, 6), 'harp', p, 2.0, .55, -.4 + j * .1)
for p in ['G5', 'B5', 'D6', 'G6']: C_(t0, p, 1.8, .55, .1)
for p in ['G4', 'B4', 'D5']: N_(t0, 'vibraphone', p, 2.4, .4, -.15)
N_(b('night', 1), 'vibraphone', 'C5', 1.2, .35, .2); N_(b('night', 1), 'vibraphone', 'E5', 1.2, .33, .2); C_(b('night', 1), 'E6', .6, .45, .1)
C_(b('night', 1.5), 'B5', .5, .4, -.1)
N_(b('night', 2), 'cellos_pizz', 'D3', .6, .6, -.2); N_(b('night', 2), 'contrabass_pizz', 'D2', .6, .5, -.1)
for p in ['D4', 'F#4', 'A4']: N_(b('night', 2), 'harp', p, 1.0, .45, -.2)
C_(b('night', 2), 'F#6', .6, .5, .1); C_(b('night', 2), 'A6', .6, .42, .2); N_(b('night', 2), 'glockenspiel', 'A6', 1.0, .35, .2)
C_(b('night', 2.25), 'D6', .3, .4, 0); C_(b('night', 3), 'E6', .4, .45, .1); C_(b('night', 3.25), 'D6', .3, .4, 0)
N_(b('night', 3.5), 'glockenspiel', 'D7', 1.2, .45, .3); C_(b('night', 3.5), 'B6', .6, .45, .2)
fwc = {4: ('G', ['G2', 'D3'], ['D5', 'G5', 'B5'], ['G6', 'B6', 'D7']), 5: ('Em', ['E2', 'B2'], ['E5', 'G5', 'B5'], ['G6', 'B6', 'E7']),
       6: ('C', ['C3', 'G3'], ['E5', 'G5', 'C6'], ['G6', 'C7', 'E7']), 7: ('D', ['D3', 'A3'], ['F#5', 'A5', 'D6'], ['A6', 'D7', 'F#7'])}
for bt, (_, bs, ch, br) in fwc.items():
    for j in range(2): N_(b('night', bt + j * .5), 'cellos_pizz', bs[j], .4, .65, -.2)
    N_(b('night', bt), 'contrabass_pizz', mi(bs[0]) - 12, .5, .5, -.1)
    for p in ch: N_(b('night', bt), 'violins_pizz', p, .3, .5, .3)
    lo = mi(br[0]) - 12                                           # 发射：两个十六分音符上行
    C_(b('night', bt), lo, .2, .45, -.1); C_(b('night', bt + .25), lo + 4, .2, .45, 0)
    bw = b('night', bt + .5)                                     # 炸开：钟琴 + 钢片琴高音和弦 + 三角铁
    for p in br: C_(bw, p, .9, .5, .15)
    N_(bw, 'glockenspiel', br[-1] if mi(br[-1]) <= mi('C8') else br[1], 1.4, .55 if bt < 7 else .7, .25)
    N_(bw, 'triangle', 'open', 1.2, .35 if bt < 7 else .55, .4)
N_(b('night', 7.5), 'timpani', 'D3', 1.5, .7, 0); N_(b('night', 7.5), 'contrabass_pizz', 'D2', .6, .55, -.1)
for p in ['D4', 'F#4', 'A4', 'D5']: N_(b('night', 7.5), 'vibraphone', p, 1.4, .38, -.1)

# ===== F 合书（16.8–19.8，80 BPM，减速）：八音盒 + 竖琴 =====
for j, p in enumerate(['G2', 'D3', 'G3', 'B3']): N_(round(b('close', 0) + j * .05, 6), 'harp', p, 1.8, .45, -.3)
N_(b('close', 0), 'contrabass_pizz', 'G1', .8, .4, -.1)
for bt, p in [(0, 'D6'), (.5, 'B5'), (1, 'C6'), (1.5, 'A5'), (2, 'G5'), (3, 'G6')]: MB(b('close', bt), p, .6, .2)
N_(b('close', 1), 'harp', 'D3', 1.0, .4, -.3); N_(b('close', 1), 'harp', 'F#3', 1.0, .35, -.3)
N_(b('close', 2), 'timpani', 'G2', 1.8, .4, 0); N_(b('close', 2), 'contrabass_pizz', 'G1', .8, .45, -.1); N_(b('close', 2), 'harp', 'G2', 2.0, .5, -.3)
for p in ['G4', 'B4', 'D5']: N_(b('close', 2), 'vibraphone', p, 1.6, .3, .1)
C_(b('close', 3), 'G6', 1.2, .5, .15); N_(b('close', 3), 'glockenspiel', 'G6', 1.0, .35, .25)

# 纸张节奏层（"纸张翻动声做节奏"）：B 段反拍纸刷、C 段十六分纸摇沙、E 段烟花段八分
def riffle(v=1.0, d=.07):
    t = tt(d); x = bp(noise(len(t)), 2500, 9000) * ex(t, .004, d * .35)
    for _ in range(6): i = rng.integers(0, max(1, len(t) - 200)); x[i:i + 60] += noise(60) * .6
    return x * v
for i in range(8): put(music, riffle(.05), b('castle', i + .5), 1, .2); ONSETS.append({'t': b('castle', i + .5), 'inst': 'paper'})
for k in range(16):
    t = b('dragon', 2 + k * .25); put(music, riffle(.07 if k % 4 == 0 else .04), t, 1, -.2 + .4 * (k % 2)); ONSETS.append({'t': t, 'inst': 'paper'})
for k in range(8):
    t = b('night', 4 + k * .5); put(music, riffle(.06 if k % 2 == 0 else .035), t, 1, .2); ONSETS.append({'t': t, 'inst': 'paper'})

samp = S.render(SAMPLED, dur=DUR + 3, master=False)[:N]
music += samp
music = S.room(music, size=.42, mix=.2)
# 静默段：硬截断 + 尾音收短（10.8 后音乐 30 ms 内掐断，12.0 前保持空白）
cut0, cut1 = int(T['stop'] * SR), int(b('night', 0) * SR - 48)
fadeN = int(.03 * SR); music[cut0:cut0 + fadeN] *= np.linspace(1, 0, fadeN)[:, None]; music[cut0 + fadeN:cut1] = 0
# 结尾淡出
fo = int(.5 * SR); music[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5

# ---------- 拟音 ----------
def sweep(f0, f1, d):
    t = tt(d); f = f0 + (f1 - f0) * (t / d); return np.sin(2 * np.pi * np.cumsum(f) / SR)
def crinkle(d, g=1., dens=180, lo=1800, hi=9000):
    n = int(d * SR); x = np.zeros(n)
    for _ in range(max(1, int(dens * d))):
        i = rng.integers(0, max(1, n - 400)); L = int(rng.integers(40, 300)); x[i:i + L] += noise(len(x[i:i + L])) * np.exp(-np.arange(len(x[i:i + L])) / (L / 4)) * rng.uniform(.3, 1)
    return bp(x, lo, hi) * g
def swish(d, g=1., f0=500, f1=3500):
    t = tt(d); n = len(t); x = noise(n); y = np.zeros(n); B = 10
    for k in range(B):
        a, c = k * n // B, (k + 1) * n // B; fc = f0 + (f1 - f0) * (k + .5) / B
        y[a:c] = bp(x, fc * .6, min(fc * 1.6, 20000))[a:c]
    return y * np.sin(np.pi * t / t[-1]) ** 1.5 * g
def pop(g=1., f=700):
    d = .2; t = tt(d); x = sweep(f, f * .45, d) * ex(t, .001, .04) + bp(noise(len(t)), 1200, 5000) * ex(t, .003, .025) * .5
    return (x + np.pad(crinkle(.1, .35), (0, len(t) - int(.1 * SR)))) * g
def thumpc(g=1., f=70, d=.6):
    t = tt(d); return (np.sin(2 * np.pi * f * t * (1 - .2 * t)) * ex(t, .002, .1) + lp(noise(len(t)), 700) * ex(t, .001, .03) * .6) * g
def tick(g=1., f=3200):
    t = tt(.05); return (np.sin(2 * np.pi * f * t) * ex(t, .0005, .006) + hp(noise(len(t)), 2500) * ex(t, .0003, .003) * .5) * g
def bell(f, d=.8, g=1.):
    t = tt(d); return sum(np.sin(2 * np.pi * f * k * t) * np.exp(-t * (4 + k * 3)) / k ** 1.6 for k in (1, 2, 3, 4.2)) * np.minimum(1, t / .002) * g
def whistle(d, f0, f1, g=1.):
    t = tt(d); f = f0 * (f1 / f0) ** (t / d); x = np.sin(2 * np.pi * np.cumsum(f) / SR) * (1 + .3 * noise(len(t)) * .1)
    return (x * .6 + bp(noise(len(t)), 3000, 9000) * .4) * np.sin(np.pi * t / d) ** .7 * g
SFX_ON = []
for e in EV:
    t, ty, g = e['t'], e['type'], e.get('g', 1.0); SFX_ON.append({'t': t, 'type': ty})
    if ty == 'creak':
        d = .55; q = tt(d); rate = 30 + 70 * (q / d); clk = (np.sin(2 * np.pi * np.cumsum(rate) / SR) > .96).astype(float)
        put(sfx, bp(clk + noise(len(q)) * .04, 250, 1100, 3) * np.sin(np.pi * q / d) ** .5 * .9, t, .9 * g, -.1)
    elif ty == 'swish': put(sfx, swish(.55, .7, 400, 3000), t - .25, g, .1)         # 峰值落在 t
    elif ty == 'pop': put(sfx, pop(.55, 600 * e.get('p', 1)), t, g, float(rng.uniform(-.4, .4)))
    elif ty == 'popbig': put(sfx, sm(pop(.8, 480), thumpc(.5, 90, .2)), t, g, 0)
    elif ty == 'flutter':
        for k in range(6): put(sfx, crinkle(.04, .5, 400, 2000, 8000), t + k * .03, g * (1 - k * .12), .3)
    elif ty == 'tab':
        d = .3; q = tt(d); put(sfx, bp(noise(len(q)), 900, 4500) * np.sin(np.pi * q / d) * .35 + crinkle(d, .3, 120), t, g, .25)
    elif ty == 'chain':
        d = e['d']
        for k in range(int(d / .07)): put(sfx, bell(float(rng.uniform(2600, 3600)), .15, .06), t + k * .07 + float(rng.uniform(0, .02)), g, float(rng.uniform(-.2, .2)))
    elif ty == 'thump': put(sfx, sm(thumpc(.9, 75, .7), crinkle(.12, .35, 300, 600, 5000)), t, g, 0)
    elif ty == 'tap': put(sfx, sm(tick(.25 * g, 2200), crinkle(.04, .12, 300)), t, 1, .35)
    elif ty == 'rustle':
        d = e['d']; q = tt(d); put(sfx, crinkle(d, .45, 260, 700, 7000) * (q / d) ** 1.5, t, g, .45)
    elif ty == 'crease': put(sfx, crinkle(.12, .7, 500, 1500, 9000) * ex(tt(.12), .002, .04), t, g, .45)
    elif ty == 'swoosh': put(sfx, swish(.6, .8, 300, 2600), t - .2, g, .3)
    elif ty == 'flap': put(sfx, lp(noise(int(.07 * SR)), 1500) * ex(tt(.07), .005, .02) * .25 + crinkle(.07, .12, 200), t, g, float(rng.uniform(-.3, .3)))
    elif ty == 'settle': put(sfx, crinkle(.08, .25, 300, 1500, 7000) * ex(tt(.08), .002, .025), t, g, 0)
    elif ty == 'tick': put(sfx, tick(.18, 4200), t, g, 0)
    elif ty == 'nibble':
        for k in range(3): put(sfx, crinkle(.05, .35, 600, 1200, 8000) * ex(tt(.05), .001, .015), t + k * .05, g, .1)
    elif ty == 'page':                                                       # 静默后第一声：全片最重要
        d = 1.2; q = tt(d); x = swish(d, 1.0, 250, 3200) + crinkle(d, .35, 90) * np.sin(np.pi * q / d)
        x[:int(.06 * SR)] += crinkle(.06, .9, 900, 1500, 10000)
        put(sfx, x, t, 1.25 * g, 0); put(sfx, lp(noise(int(1.0 * SR)), 300) * ex(tt(1.0), .25, .3) * .5, t, g, 0)
    elif ty == 'leafland': put(sfx, sm(thumpc(.45, 85, .4), lp(noise(int(.25 * SR)), 900) * ex(tt(.25), .01, .06) * .5), t, g, 0)
    elif ty == 'moon': put(sfx, bp(noise(int(.25 * SR)), 600, 2500) * ex(tt(.25), .05, .08) * .2, t - .2, g, .4); put(sfx, bell(2093, .9, .12), t, g, .4)
    elif ty == 'launch': put(sfx, sm(whistle(.3, 700, 2400, .3), lp(noise(int(.06 * SR)), 900) * ex(tt(.06), .002, .02) * .6), t, g, -.1)
    elif ty == 'burst':
        big = e.get('big'); d = 1.4 if big else 1.0; q = tt(d)
        x = thumpc(.6 if big else .4, 60, .5)[:len(q)] if True else 0
        x = sm(x, crinkle(d, .9 if big else .6, 500 if big else 350, 900, 10000) * np.exp(-q / (.35 if big else .25)))
        put(sfx, x, t, g, float(.3 if e['k'] % 2 else -.3))
        for k in range(14 if big else 8): put(sfx, bell(float(rng.choice([2093, 2637, 3136, 3951, 4186])), .5, .05), t + float(rng.uniform(.05, .9)), g, float(rng.uniform(-.7, .7)))
    elif ty == 'fold':
        for k in range(3): put(sfx, crinkle(.09, .45, 500, 2500, 10000) * ex(tt(.09), .002, .03), t + k * .06, g, float(rng.uniform(-.3, .3)))
    elif ty == 'dive': x = swish(.5, .6, 2800, 400); put(sfx, x, t - .3, g, .4)
    elif ty == 'close':
        put(sfx, sm(thumpc(1.0, 62, .9), lp(noise(int(.3 * SR)), 1200) * ex(tt(.3), .002, .05) * .6), t, g, 0)
        put(sfx, lp(noise(int(.6 * SR)), 2500) * ex(tt(.6), .03, .15) * .25, t + .02, g, 0)  # 气流 puff
    elif ty == 'tailin': put(sfx, crinkle(.08, .3, 300, 1500, 8000) * ex(tt(.08), .002, .02), t, g, -.5); put(sfx, bell(3136, .8, .1), t, g, -.5)
    else: raise SystemExit(f'unknown event type {ty}')

# ---------- 环境声 ----------
def brown(n): w = np.cumsum(noise(n)); w -= np.linspace(w[0], w[-1], n); return w / (np.abs(w).max() + 1e-9)
room = lp(brown(N), 500) * .05; amb[:, 0] += room; amb[:, 1] += lp(brown(N), 500) * .05
# 钟表：每拍一声（滴/答），在音乐里很轻，静默段成为唯一的节拍器
for s in TL['SECS']:
    for k in range(int(s['beats'])):
        t = round(s['t'] + k * 60 / s['bpm'], 6)
        if s['id'] == 'hush' and k == 0: continue                    # 截断的那一拍留白
        lvl = .1 if s['id'] in ('open', 'hush', 'close') else .035
        put(amb, tick(lvl, 2600 if k % 2 == 0 else 2300), t, 1, -.55)
# 白天纸世界：轻风 + 稀疏纸哨鸟鸣
day = (np.arange(N) / SR > 2.2) & (np.arange(N) / SR < T['turn'])
air = hp(noise(N), 3000) * .012 * day; amb[:, 0] += air; amb[:, 1] += air
for t in [3.3, 4.5, 5.9, 6.6, 8.0, 9.1]:
    d = .18; q = tt(d); f = 3200 + 900 * np.sin(2 * np.pi * 9 * q); put(amb, np.sin(2 * np.pi * np.cumsum(f) / SR) * ex(q, .01, .05) * .03, t, 1, .6)
# 夜：风 + 蟋蟀
nt = np.arange(N) / SR; nmask = np.clip((nt - b('night', 2)) / .6, 0, 1) * (1 - np.clip((nt - T['shut']) / .6, 0, 1))
wind = bp(noise(N), 250, 900) * (.5 + .5 * np.sin(2 * np.pi * .3 * nt)) * .03 * nmask; amb[:, 0] += wind; amb[:, 1] += wind * .8
for k in range(40):
    t = b('night', 2) + k * .11 + rng.uniform(0, .05)
    if t > T['shut']: break
    q = tt(.05); put(amb, np.sin(2 * np.pi * 4600 * q) * (np.sin(2 * np.pi * 60 * q) > 0) * ex(q, .002, .015) * .012, t, 1, .7 if k % 2 else -.6)
# 静默段：只保留房间底噪和钟（环境的白天层已在 turn 前结束）

# ---------- 混音 ----------
mix = music * 1.0 + sfx * .9 + amb * 1.0
# 关键拟音处音乐让位（平滑 0.15 s）
duck = np.ones(N)
for e in EV:
    if e['type'] in ('page', 'close', 'thump', 'popbig'):
        i0 = int((e['t'] - .02) * SR); i1 = int((e['t'] + .35) * SR); duck[max(0, i0):min(N, i1)] = np.minimum(duck[max(0, i0):min(N, i1)], .78)
from scipy.ndimage import uniform_filter1d
duck = uniform_filter1d(duck, int(.15 * SR)); mix = (music * duck[:, None]) + sfx * .9 + amb
mix = np.stack([limit(mix[:, 0], .95), limit(mix[:, 1], .95)], 1)
mix = mix / (np.abs(mix).max() + 1e-9) * .89
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
sf.write(os.path.join(HERE, 'out', 'music.wav'), (music / (np.abs(music).max() + 1e-9) * .8).astype(np.float32), SR)
json.dump({'music': sorted(ONSETS + [{'t': s[0], 'inst': s[1]} for s in SAMPLED if s[1] == 'timpani' and False], key=lambda o: o['t']), 'sfx': SFX_ON}, open(os.path.join(HERE, 'out', 'score_onsets.json'), 'w'), indent=0)
# 频段能量（20–120 Hz 相对其余）
spec = np.abs(np.fft.rfft(mix[:, 0] + mix[:, 1])) ** 2; fr = np.fft.rfftfreq(N, 1 / SR)
lo = spec[(fr > 20) & (fr < 120)].sum(); rest = spec[(fr >= 120) & (fr < 16000)].sum()
print(f'mix.wav {DUR}s  low/rest = {10 * np.log10(lo / rest):.1f} dB  sampled notes = {len(SAMPLED)}  onsets = {len(ONSETS)}')
used = sorted({s[1] for s in SAMPLED}); print('instruments:', used)
json.dump(used, open(os.path.join(HERE, 'out', 'instruments.json'), 'w'))
