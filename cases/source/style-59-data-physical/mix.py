"""《一年的雨》配乐 + 拟音 → out/mix.wav（以及 out/stems/、out/cues_audio.json）
读 out/timeline.json（tools/export.mjs 从 timeline.js 导出）和 events.json（core/render/events.mjs 从页面的 window.EV 导出）。
100 BPM，F 大调五声。音高 = 数据：每月首颗落定那一拍，钢片琴（numpy 合成 + 钟琴采样叠层）奏出该月的音，旋律就是降水曲线。
乐器：VCSL 木琴 / 钟琴 / 弓奏颤音琴 / 颤音琴 / 管钟、VSCO 2 CE 定音鼓 / 大鼓 / 圆号、FreePats 玻璃琴（均 CC0）；
pluck.py 物理建模拨弦低音与竖琴；钢片琴、冲击、空气底、全部玻璃/铜珠拟音为 numpy 合成。
"""
import os, sys, json
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P, sfx as X
SR = X.SR
TL = json.load(open(os.path.join(HERE, 'out/timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
EV = EVJ['ev']
DUR, BEAT, BAR, T = TL['DUR'], TL['BEAT'], TL['BAR'], TL['T']
PENTA = TL['PENTA']
N = int((DUR + 1.0) * SR)
rng = np.random.default_rng(59); S.seed(59)
MUS, PUL, FX, HIT, BED = (np.zeros((N, 2)) for _ in range(5))
USED = set(); CUES = []          # CUES：每个关键音乐事件的时间，给 cuecheck.py 核对

def b(n): return n * BEAT
def sos(kind, f, o=2): return butter(o, f, kind, fs=SR, output='sos')
def lpf(x, f, o=2): return sosfilt(sos('low', min(f, SR * .45), o), x, axis=0)
def hpf(x, f, o=2): return sosfilt(sos('high', f, o), x, axis=0)
def bpf(x, a, c, o=2): return sosfilt(sos('band', [a, min(c, SR * .45)], o), x, axis=0)
def tv(d): return np.arange(int(d * SR)) / SR
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def mi(p): return S.midi(p)
def put(buf, x, at, g=1.0, pan=0.0):
    x = np.asarray(x, np.float64)
    if x.ndim == 2:
        s = int(round(at * SR))
        if s >= len(buf): return
        if s < 0: x = x[-s:]; s = 0
        e = min(len(buf), s + len(x)); buf[s:e] += x[:e - s] * g
    else: X.add(buf, x, at, g, pan)
def inst(buf, t, name, pitch, dur, vel, g=1.0, pan=0.0, **kw):
    USED.add(name); I = S.load(name)
    x = S.hit(I, pitch, vel, dur) if I.kind == 'hit' else S.note(I, pitch, dur, vel, **kw)
    put(buf, x, t, g, pan)
def pl(buf, t, preset, pitch, dur, vel, g=1.0, pan=0.0, **kw):
    put(buf, P.pluck(preset, pitch, dur, vel, **kw), t, g, pan)
def stereo(x, w=.0007): d = int(w * SR); return np.stack([x, np.concatenate([np.zeros(d), x[:-d]]) if d else x], 1)

# —— 合成乐器 ——
def celesta(p, vel=.7, d=2.2):
    """钢片琴：被毡锤敲击的钢片 + 木共鸣箱；近谐波分音、强基音、柔软的锤头"""
    m = mi(p) if isinstance(p, str) else p; f = hz(m); t = tv(d)
    k = 1.0 / (1 + max(0, m - 72) / 18)             # 越高衰减越快
    x = sum(a * np.sin(2 * np.pi * f * r * t + rng.random() * 6) * np.exp(-t / (tau * k)) for r, a, tau in [(1, 1, 1.5), (2.0, .16, .5), (3.99, .07, .2), (5.42, .025, .08)])
    ham = bpf(rng.standard_normal(len(t)), 900, 4500) * np.exp(-t / .004) * .12
    box = np.sin(2 * np.pi * f * t) * np.exp(-t / .06) * .2 * np.minimum(1, t / .002)
    a = np.minimum(1, t / .0015)
    return (x * a + ham + box) * vel * .5
def bass(p, d, vel=.8, cut=380):
    m = mi(p) if isinstance(p, str) else p; f = hz(m); t = tv(d)
    x = np.sin(2 * np.pi * f * t) + .35 * np.sin(4 * np.pi * f * t) + .18 * np.sin(6 * np.pi * f * t)   # 2、3 次谐波：小喇叭也听得到
    e = np.minimum(1, t / .01) * np.exp(-t / (d * .6))
    return lpf(x, cut) * e * vel * .45
def punch(vel=1.0, d=.9):
    t = tv(d)
    b1 = np.sin(2 * np.pi * np.cumsum(66 * (1 + 1.3 * np.exp(-t / .025))) / SR) * np.exp(-t / .26)
    b2 = np.sin(2 * np.pi * np.cumsum(104 * (1 + .8 * np.exp(-t / .02))) / SR) * np.exp(-t / .14) * .6
    kn = bpf(rng.standard_normal(len(t)), 90, 400) * np.exp(-t / .045) * .7
    y = b1 + b2 + kn; return (y + .25 * np.tanh(2.5 * y)) * vel
def air(d, v=1.0, f0=400, f1=2400):
    n = rng.standard_normal(int(d * SR)); out = np.zeros_like(n); blk = 256
    for i in range(0, len(n), blk):
        u = i / len(n); f = f0 * (f1 / f0) ** np.sin(np.pi * u * .5)
        s = max(0, i - 3000); y = sosfilt(sos('band', [f * .7, min(f * 1.4, SR * .45)]), n[s:i + blk]); out[i:i + blk] = y[-(min(blk, len(n) - i)):]
    return out * np.sin(np.pi * np.clip(tv(d) / d, 0, 1)) ** 2 * v

# —— 材料自己的声音 ——
def glass_tok(v=1.0, size=1.0):
    """玻璃珠落在玻璃上：极短的瞬态 + 2–8 kHz 非谐波分音（玻璃比金属更"清"，衰减更短）"""
    d = .08; t = tv(d); p = (.9 + rng.random() * .2) / size
    tr = hpf(rng.standard_normal(len(t)), 2500) * np.exp(-t / .0009)
    res = sum(a * np.sin(2 * np.pi * f * p * t + rng.random() * 6) * np.exp(-t / tau) for f, a, tau in [(2650, .55, .018), (4170, .45, .013), (6320, .3, .009), (8150, .15, .006), (1180, .18, .01)])
    return (tr * .6 + res) * v
def brass_tick(v=1.0):
    """铜珠：更亮、更长一点的金属"叮" """
    d = .16; t = tv(d); p = .95 + rng.random() * .1
    tr = hpf(rng.standard_normal(len(t)), 3500) * np.exp(-t / .001)
    res = sum(a * np.sin(2 * np.pi * f * p * t + rng.random() * 6) * np.exp(-t / tau) for f, a, tau in [(3120, .5, .05), (5230, .4, .035), (7480, .25, .02), (2040, .2, .03)])
    return (tr * .6 + res) * v
def paper(v=1.0):
    d = .05; t = tv(d); return bpf(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / .006) * v

# ———————————————— 拟音（全部从 window.EV 驱动） ————————————————
months = {e['m']: e for e in EV if e['type'] == 'month'}
def foley():
    for e in EV:
        t, ty = e['t'], e['type']
        if ty == 'bead':
            if e['mode'] == 'unit':
                pan = .12 * np.sin(e['k'] * 1.7)
                put(FX, brass_tick(.9) if e['brass'] else glass_tok(.9), t, .34, pan)
            elif e['mode'] == 'feed':
                mo = months[e['m']]; dens = mo['n'] / max(mo['d'], .05)           # 每秒落珠数
                g = .5 / np.sqrt(max(1.0, dens / 10))                              # 越密越轻：一阵玻璃雨
                pan = np.clip(np.sin((e['m'] + 1) * np.pi / 6) * .5, -.6, .6) + (rng.random() - .5) * .2
                put(FX, brass_tick(.8) if e['brass'] else glass_tok(.85, .9 + rng.random() * .25), t, g * (.7 + .3 * rng.random()), pan)
        elif ty == 'month':
            # 雨声的"沙"：高频颗粒噪声，密度越大越响（一拍长）
            d = e['d'] + .15; dens = e['n'] / max(e['d'], .05)
            n = bpf(rng.standard_normal(int(d * SR)), 3000, 9000) * np.sin(np.pi * np.clip(tv(d) / d, 0, 1)) ** .7
            put(FX, stereo(n), t, .012 * np.sqrt(dens / 10))
        elif ty == 'whoosh':
            put(FX, stereo(air(e['d'], e.get('v', .6), 300, 1800)), t - .1, .32)
        elif ty == 'text':
            put(FX, paper(e.get('v', .6)), t - IN_, .09, .3)
        elif ty == 'last':
            put(FX, glass_tok(1.0, 1.0) + .6 * glass_tok(.8, 1.4), t, 1.0, 0)   # 近距、清脆
            put(FX, brass_tick(.4), t + .004, .3, .1)
        elif ty == 'bounce':
            put(FX, glass_tok(.5, 1.1), t, .35, .05)
IN_ = TL['IN']

# 空气底：极轻的录音棚空气，全片不断（静默时也在）
def bed():
    n = rng.standard_normal(N); x = lpf(np.cumsum(n) * .02 - lpf(np.cumsum(n) * .02, 40), 1800) + bpf(rng.standard_normal(N), 200, 3000) * .3
    x = x / np.abs(x).max()
    put(BED, stereo(x * .02, .003), 0, 1.0)

# ———————————————— 配乐 ————————————————
def score():
    # 1) 单位段：第 1–9 颗沿 F 五声攀升（钢片琴），第 10 颗铜珠 = 钟琴高八度的 F（标尺会唱）
    unit = sorted([e for e in EV if e['type'] == 'bead' and e['mode'] == 'unit'], key=lambda e: e['k'])
    for e in unit:
        if e['brass']:
            inst(MUS, e['t'], 'glockenspiel', 'F7', 1.6, .7, .5, .25); inst(MUS, e['t'], 'glockenspiel', 'F6', 1.6, .55, .4, -.1)
            put(MUS, celesta('F5', .7, 2.4), e['t'], .7, 0); CUES.append(('brass10', e['t']))
        else:
            p = PENTA[e['k']]; put(MUS, celesta(p, .55 + .03 * e['k'], 1.8), e['t'], .7, -.15 + .04 * e['k'])
            if e['k'] == 0: CUES.append(('bead1', e['t']))
    # 弓奏颤音琴长音铺底：bar1 F(add9)，bar2 Dm7
    for t0, ch, d in [(0, ['F4', 'A4', 'C5', 'G5'], BAR + .2), (BAR, ['D4', 'F4', 'A4', 'C5'], BAR + .3)]:
        for i, p in enumerate(ch): inst(MUS, t0 + .02 * i, 'vibraphone_bowed', p, d, .32, .32, -.3 + .2 * i, attack=.5 if t0 == 0 else .25, release=.6)

    # 2) 进料段：每月首颗那一拍 = 该月的数据音（钢片琴 + 钟琴叠层）
    for m in range(12):
        e = months[m]; p = e['note']; t = e['t']
        put(MUS, celesta(p, .85, 2.0), t, .8, np.clip(np.sin((m + 1) * np.pi / 6) * .4, -.4, .4))
        if mi(p) >= mi('G5'): inst(MUS, t, 'glockenspiel', p, 1.2, .35, .22, .1)
        CUES.append((f'month{m + 1}', t))
        # 本月的铜珠：钟琴滑奏，从 F5 攀到本月的数据音（雨越多，滑奏越长、越高）
        brass = sorted([x['t'] for x in EV if x['type'] == 'bead' and x['mode'] == 'feed' and x['m'] == m and x['brass']])
        top = PENTA.index(p)
        for h, tb in enumerate(brass):
            idx = int(round((h + 1) / len(brass) * top)) if brass else 0
            inst(MUS, tb, 'glockenspiel', PENTA[idx], .5, .3, .10, .3 * np.sin(h))
    # 和声（每小节两拍一和弦）与低音
    HARM = [(8, 'F', ['C4', 'F4', 'A4']), (12, 'Bb', ['Bb3', 'D4', 'F4', 'C5']), (16, 'Gm', ['Bb3', 'D4', 'F4', 'G4']), (18, 'C', ['C4', 'E4', 'G4', 'Bb4']),
            (20, 'Csus', ['C4', 'F4', 'G4'])]
    ROOT = {'F': 'F2', 'Bb': 'Bb1', 'Gm': 'G1', 'C': 'C2', 'Csus': 'C2'}
    XYL = {'F': ['F5', 'C6', 'A5', 'C6'], 'Bb': ['F5', 'D6', 'Bb5', 'D6'], 'Gm': ['G5', 'D6', 'Bb5', 'D6'], 'C': ['G5', 'E6', 'C6', 'E6'], 'Csus': ['G5', 'F6', 'C6', 'F6']}
    for i, (bt, name, ch) in enumerate(HARM):
        bend = HARM[i + 1][0] if i + 1 < len(HARM) else 22
        for j, p in enumerate(ch): inst(MUS, b(bt) + .01 * j, 'vibraphone_bowed', p, b(bend - bt) + .1, .26, .26, -.3 + .2 * j, attack=.2, release=.3)
        for beat in range(bt, bend):
            # 拨弦低音（pluck.py）每拍 + 一点合成低音的 2、3 次谐波
            pl(PUL, b(beat), 'upright_bass_pizz', ROOT[name], .55, .78 if beat % 2 == 0 else .62, .9, 0)
            put(PUL, bass(mi(ROOT[name]) + 12, .5, .5), b(beat), .5, 0)
    # 木琴固定音型：旱季八分 → 雨季十六分（按细分加速）→ 回八分 → 四分（减速）
    def sub(beat):
        if beat < 12: return 2
        if beat < 18: return 4
        if beat < 20: return 2
        return 1
    for beat in range(8, 22):
        name = [h for h in HARM if h[0] <= beat][-1][1]
        n = sub(beat); pat = XYL[name]
        for s in range(n):
            t = b(beat) + s * BEAT / n; p = pat[(s + beat * n) % 4]
            vel = (.62 if s == 0 else .42) * (.85 if n == 4 else 1.0)
            inst(MUS, t, 'xylophone', p, .25, vel, .30 if n == 4 else .36, .35 if s % 2 else -.2)
    CUES.append(('accel16', b(12))); CUES.append(('decel8', b(18)))
    # 转：圆号 Csus4 + 定音鼓滚奏渐强，在抽空处戛然而止
    for p, pan in (('C3', -.3), ('F3', 0), ('G3', .3)): inst(MUS, b(20), 'horn', p, b(2) + .1, .55, .5, pan, attack=.15)
    for k in range(int(2 / .25)):
        tk = b(20) + k * BEAT / 4; inst(MUS, tk, 'timpani', 'C3', .3, .25 + .5 * k / 8, .35 + .4 * k / 8, -.1)
    CUES.append(('reveal', b(20)))

    # 3) 最后一颗：静默后的第一声 —— 全片最重
    t = T['last']; CUES.append(('last', t))
    put(HIT, stereo(punch(1.15)), t, .95)
    inst(HIT, t, 'bass_drum', None, None, 1.0, .85); inst(HIT, t, 'timpani', 'F2', 3.0, 1.0, .9)
    inst(HIT, t, 'tubular_bells', 'C5', 4.0, .8, .55, .2); inst(HIT, t, 'tubular_bells', 'F4', 4.0, .7, .45, -.2)
    put(HIT, celesta('F6', 1.0, 3.0), t, .8, .1); put(HIT, celesta('F5', .9, 3.0), t, .7, -.1)
    inst(HIT, t, 'glockenspiel', 'F7', 2.5, .7, .35, .3)
    inst(HIT, t + .01, 'glass', 'F5', 3.5, .7, .5, -.25); inst(HIT, t + .01, 'glass', 'C6', 3.5, .6, .4, .25)
    # 余响的和声：F(add9) 弓奏颤音琴 + 低音
    for j, p in enumerate(['F4', 'A4', 'C5', 'G5']): inst(MUS, t + .05 + .03 * j, 'vibraphone_bowed', p, DUR - t + .4, .3, .3, -.3 + .2 * j, attack=.8, release=.8)
    put(PUL, bass('F2', 2.8, .55, 300), t, .7)
    # 4) 回顾：钢片琴把 12 个月的音用十六分音符再走一遍（b26–b29）
    for m in range(12):
        tr = T['recap'] + m * BEAT / 4; put(MUS, celesta(TL['MONTH_NOTE'][m], .5 + .02 * m, 1.6), tr, .55, -.4 + m * .07)
    CUES.append(('recap', T['recap']))
    # 5) 结尾：b30 竖琴（pluck）琶音 + 颤音琴 Fmaj7
    tf = T['final']; CUES.append(('final', tf))
    for i, p in enumerate(['F3', 'C4', 'F4', 'A4', 'C5', 'E5', 'F5']): pl(MUS, tf + i * .045, 'harp', p, 2.4, .62, .5, -.3 + .1 * i)
    for j, p in enumerate(['F4', 'A4', 'C5', 'E5']): inst(MUS, tf + .02 * j, 'vibraphone', p, 2.0, .45, .42, -.2 + .13 * j)
    put(PUL, bass('F1', 2.0, .6, 260), tf, .6)

foley(); bed(); score()

# 抽空：音乐、低音、拟音在 b22–b24 降 30 dB（40 ms 斜坡）；空气底保留
def suck(t0, t1, db=-30, ramp=.04):
    g = np.ones(N); lo = 10 ** (db / 20)
    s0, s1, r = int(t0 * SR), int(t1 * SR), int(ramp * SR)
    g[s0:s1] = lo; g[s0:s0 + r] = np.linspace(1, lo, r); g[s1 - 2:s1] = lo
    return g[:, None]
for e in EV:
    if e['type'] == 'suck':
        G = suck(e['t'], e['t'] + e['d']); MUS *= G; PUL *= G; FX *= G
        CUES.append(('suck', e['t']))

# —— 混音 ——
def rms(x): return np.sqrt(np.mean(x ** 2) + 1e-12)
MUS = hpf(MUS, 40); PUL = hpf(PUL, 32); HIT = hpf(HIT, 34, 4)
HITc = np.stack([X.compress(HIT[:, c], thr=.5, ratio=2.5, att=.002, rel=.12) for c in range(2)], 1)
mix = MUS * .8 + PUL * .95 + FX * 1.3 + HITc * 1.25 + BED * 1.5
# 低频架子：62 Hz 以下 −4 dB
low = lpf(mix, 62); mix = mix - low * (1 - 10 ** (-4 / 20))
# 尾部 0.5 s 淡出（结尾和弦不会被硬切）
fe = int((DUR - .5) * SR); ee = int(DUR * SR); env = np.ones(N); env[fe:ee] = np.linspace(1, 0, ee - fe) ** 1.5; env[ee:] = 0
mix *= env[:, None]
mix = mix[:int(DUR * SR)]
pk = np.abs(mix).max(); mix = mix / pk
# 母带：+4.5 dB 后前视限幅到 −2 dBFS（只压冲击的尖峰），留给 mux.sh 做 −14 LUFS 两遍响度归一
pre = 10 ** (4.5 / 20); mix = np.stack([X.limit(mix[:, c] * pre, 10 ** (-2 / 20), .004) for c in range(2)], 1); pk = pk / pre
os.makedirs(os.path.join(HERE, 'out/stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
for nm, x in (('music', MUS), ('pulse', PUL), ('foley', FX), ('hits', HIT), ('bed', BED)):
    sf.write(os.path.join(HERE, f'out/stems/{nm}.wav'), (x[:int(DUR * SR)] / pk * 10 ** (-3 / 20)).astype(np.float32), SR, subtype='FLOAT')
json.dump(sorted(CUES, key=lambda c: c[1]), open(os.path.join(HERE, 'out/cues_audio.json'), 'w'), indent=0)
# 低频平衡：20–120 Hz 相对 120 Hz–8 kHz
lo_e = rms(bpf(mix[:, 0], 20, 120)); hi_e = rms(bpf(mix[:, 0], 120, 8000))
print(f'mix.wav {len(mix) / SR:.2f}s  low/rest {20 * np.log10(lo_e / hi_e):+.1f} dB')
cr = S.credits(sorted(USED)); cr = cr if isinstance(cr, list) else str(cr).splitlines()
open(os.path.join(HERE, 'out/instrument_credits.txt'), 'w').write('\n'.join(cr) + '\n')
print('instruments:', ', '.join(sorted(USED)))
