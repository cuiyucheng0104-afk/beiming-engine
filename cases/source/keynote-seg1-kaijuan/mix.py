"""片段一「开卷」配乐与音效：读 events.json（由 timeline.js → index.html 的 window.EV 导出），
逐事件放置主题化的声音，混成 out/mix.wav（48 kHz 立体声）。另存分轨 out/stems/*.wav 便于检查。
运行：$LIB/.venv/bin/python mix.py   （需 LIB 环境变量或默认 ~/lemo-opuscar）"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', os.path.expanduser('~/lemo-opuscar'))
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, bp, lp, hp, t_, env_exp, norm, limit

S.seed(72)
rng = np.random.default_rng(1960)
E = json.load(open(os.path.join(HERE, 'events.json')))
DUR, EV = E['dur'], E['ev']
N = int(round(DUR * SR))
music = np.zeros((N, 2), np.float32)
perc = np.zeros((N, 2), np.float32)
foley = np.zeros((N, 2), np.float32)
amb = np.zeros((N, 2), np.float32)

def noise(d): return rng.standard_normal(int(round(d * SR)))
def fade_end(x, ms=8):
    k = int(ms * SR / 1000); x = x.copy(); x[-k:] *= np.linspace(1, 0, k) ** 2; return x
def grains(d, rate, lo, hi, tau=.002):
    """毛笔的笔毛颗粒：随机短脉冲经带通"""
    n = int(round(d * SR)); x = np.zeros(n)
    k = rng.poisson(rate * d); pos = rng.integers(0, max(1, n - 200), k)
    x[pos] = rng.standard_normal(k) * rng.uniform(.3, 1, k)
    ker = np.exp(-np.arange(int(tau * SR * 6)) / (tau * SR))
    return bp(np.convolve(x, ker)[:n], lo, hi)

# ───────── 拟音 ─────────
def water_drop():
    d = .5; tt = t_(d)
    f = 900 + 1700 * (1 - np.exp(-tt / .012))                     # 气泡共振音高上扬："叮"
    tink = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .045)
    plop = lp(noise(d), 420) * np.exp(-tt / .022)
    thud = np.sin(2 * np.pi * 135 * tt) * np.exp(-tt / .05)
    tick = hp(noise(d), 3500) * np.exp(-tt / .0025)
    return norm(tink * .9 + plop * .55 + thud * .45 + tick * .35)

def soak(d):
    tt = t_(d); e = np.sqrt(np.clip(tt / .08, 0, 1)) * np.exp(-tt / (d * .5))
    return norm(bp(noise(d), 1600, 6500) * e + grains(d, 260, 2500, 8000) * e * .6)

def rustle(d, lo=1100, hi=7200, shape=1.4):
    """毛笔擦纸：沙沙声渐强，最后 8 ms 收住（止于拍上）"""
    tt = t_(d); e = (np.clip(tt / d, 0, 1) ** shape) * (.35 + .65 * np.clip(tt / .05, 0, 1))
    am = 1 + .35 * np.sin(2 * np.pi * 9 * tt + rng.random() * 6) * np.sin(2 * np.pi * 2.3 * tt)
    x = bp(noise(d), lo, hi) * .55 + grains(d, 900, lo * 1.5, hi) * 1.2
    return fade_end(norm(x * e * am), 8)

def stroke(d, w):
    d = max(.06, d); tt = t_(d + .05)
    e = np.clip(tt / .012, 0, 1) * np.where(tt < d, 1, np.exp(-(tt - d) / .02))
    lo = 500 + 900 * (1 - w)
    x = bp(noise(d + .05), lo, 5200) * .5 + grains(d + .05, 500 + 700 * w, lo * 1.4, 6500) * 1.1
    return norm(x * e) * (.35 + .65 * w)

def stamp(v=1.):
    """印泥压纸的闷响 + 纸面细碎声"""
    d = .45; tt = t_(d)
    body = np.sin(2 * np.pi * (92 + 30 * np.exp(-tt / .02)) * tt) * np.exp(-tt / .085)
    press = lp(noise(d), 520) * np.exp(-tt / .028)
    crk = np.zeros_like(tt)
    for _ in range(7):
        s = int(rng.uniform(.012, .09) * SR); c = hp(noise(.01), 2500) * np.exp(-t_(.01) / .0015) * rng.uniform(.2, .6)
        crk[s:s + len(c)] += c[:len(crk) - s]
    return norm(body * .9 + press * .7 + crk * .5) * v

def pshift(x, r):
    """把采样整体变调 r 倍（重采样，时长随之变 1/r，木头敲击的质感保留）"""
    import soxr
    return soxr.resample(x.astype(np.float64), SR, SR / r)

_WB = {}
def wb(var):
    if var not in _WB: _WB[var] = norm(S.hit('woodblock', var, .8).astype(np.float64))
    return _WB[var]
WB_HZ = {'a': 1383., 'b': 2865., 'c': 1360.}        # 实测木鱼采样的主峰

def muyu(pitch, v=1., k=0):
    """木鱼：真实木鱼（woodblock）采样变调到五声音高的上八度（下移约 1–1.5 个八度，空腔感更重、尾巴更长，
    像寺院木鱼而不是电子 click），再垫一层很轻的同音高木腔共振，让音高听得出来"""
    var = 'a' if k % 2 == 0 else 'c'
    f0 = S.hz(pitch)
    x = pshift(wb(var), 2 * f0 / WB_HZ[var])
    d = .32; tt = t_(d)
    tau = .07 * (400 / f0) ** .45
    body = sum(a * np.sin(2 * np.pi * f0 * r * tt + rng.random()) * np.exp(-tt / (tau * kk))
               for r, a, kk in [(1, 1, 1), (2, .25, .5)])
    y = np.zeros(max(len(x), len(body))); y[:len(x)] += norm(x) * .85; y[:len(body)] += norm(body) * .22
    return norm(y) * v * rng.uniform(.9, 1.)

def bangzi(v=1.):
    """梆子：两根硬木相击——claves 与高音木鱼两支真实采样叠在一起"""
    x = S.hit('claves', None, .85).astype(np.float64); y2 = pshift(wb('b'), .82)
    y = np.zeros(max(len(x), len(y2))); y[:len(x)] += norm(x) * .7; y[:len(y2)] += norm(y2) * .5
    return norm(y) * v

def ban(v=1.):
    """板：檀板"啪"的一声带一点双击——低调的 claves + 木鱼采样，第二击晚 7 ms"""
    x = pshift(S.hit('claves', None, .9).astype(np.float64), .72); y2 = pshift(wb('c'), .9)
    one = np.zeros(max(len(x), len(y2))); one[:len(x)] += norm(x) * .7; one[:len(y2)] += norm(y2) * .55
    y = one.copy(); s = int(.007 * SR); y[s:] += one[:-s] * .55
    return norm(y) * v

def unroll(d):
    """卷轴纸绢滑开：带通扫频 + 摩擦颗粒，渐强，在落定的拍上收住"""
    tt = t_(d); u = tt / d
    x = np.zeros(len(tt)); n = noise(d)
    for i in range(0, len(tt), 480):
        f = 650 + 2000 * u[i] ** 1.3; hi = min(len(tt), i + 480)
        x[i:hi] = bp(n[max(0, i - 2400):hi], f * .6, f * 1.6)[-(hi - i):]
    fl = 1 + .25 * np.sin(2 * np.pi * 17 * tt)
    e = u ** 1.7 * fl
    y = x * e + grains(d, 700, 1500, 7000) * e * .8
    return fade_end(norm(y), 5)

def wood_knock(v=1.):
    x = S.hit('log_drum', 'lo', .8).astype(np.float64)
    d = .3; tt = t_(d)
    syn = np.sin(2 * np.pi * 410 * tt) * np.exp(-tt / .04) + .5 * np.sin(2 * np.pi * 1180 * tt) * np.exp(-tt / .015) + hp(noise(d), 1500) * np.exp(-tt / .003)
    y = np.zeros(max(len(x), len(syn))); y[:len(x)] += norm(x) * .7; y[:len(syn)] += norm(syn) * .5
    return norm(y) * v

def brush_air(d=.24):
    """甩笔破空：毛笔带着墨划过空气（宽带噪声扫频 + 笔毛颗粒），峰值在末端"""
    tt = t_(d); u = tt / d
    x = np.zeros(len(tt)); n = noise(d)
    for i in range(0, len(tt), 480):
        f = 500 + 2600 * u[i] ** 1.5; hi = min(len(tt), i + 480)
        x[i:hi] = bp(n[max(0, i - 2400):hi], f * .55, f * 1.7)[-(hi - i):]
    e = u ** 2.2
    return norm(x * e + grains(d, 1400, 1500, 8000) * e * .7)

def splat(v=1.):
    d = .08; tt = t_(d)
    return norm(hp(noise(d), 2200) * np.exp(-tt / .003) + np.sin(2 * np.pi * rng.uniform(600, 900) * tt) * np.exp(-tt / .009) * .7) * v

def abacus(n=1):
    """算盘珠：硬木珠相碰的"嗒"，n 粒连着"""
    d = .2; tt = t_(d); out = np.zeros(int(.4 * SR))
    for k in range(n):
        f = rng.uniform(.95, 1.06)
        one = sum(a * np.sin(2 * np.pi * fr * f * tt) * np.exp(-tt / tau) for fr, a, tau in [(2900, .8, .009), (4650, .5, .006), (1250, .6, .014)]) + hp(noise(d), 4000) * np.exp(-tt / .0012) * .6
        s = int(k * .036 * SR); out[s:s + len(one)] += one * (1 - .15 * k)
    return norm(out)

def fine_tick(v=1.):
    d = .06; tt = t_(d)
    return norm(bp(noise(d), 2000, 9000) * np.exp(-tt / .008)) * v

# ───────── 放置 ─────────
def pan_of(e): return float(e.get('pan', 0) or 0)

# 笔画声：合并重叠的细碎笔段，免得毛刷声过密
strokes = sorted([e for e in EV if e['type'] == 'stroke'], key=lambda e: e['t'])
merged = []
for e in strokes:
    if merged and e['t'] <= merged[-1]['t'] + merged[-1]['d'] + .004:
        m = merged[-1]; m['d'] = max(m['d'], e['t'] + e['d'] - m['t']); m['w'] = max(m['w'], e['w'])
    else: merged.append(dict(e))

for e in EV:
    t, ty, pn = e['t'], e['type'], pan_of(e)
    if ty == 'drop':
        add(foley, water_drop(), t, .6, 0)
        for k in range(5): add(foley, splat(.25), t + .03 + k * .013 * (1 + rng.random()), .25, rng.uniform(-.3, .3))
    elif ty == 'soak': add(foley, soak(e['d']), t, .07, 0)
    elif ty == 'rustle':
        d = e['t1'] - t; add(foley, rustle(d), t, .26 * e.get('g', 1), pn)
    elif ty == 'seal0':
        add(foley, stamp(1.), t, .5, pn)
    elif ty == 'unroll':
        d = e['t1'] - t; add(foley, unroll(d), t, .24, pn)
    elif ty == 'land':
        add(foley, wood_knock(), t, .62, pn)
    elif ty == 'flick':
        x = brush_air(.24); add(foley, x, t - .24 + .012, .55, pn)
    elif ty == 'splat': add(foley, splat(), t, .2 * e.get('g', 1), pn)
    elif ty == 'seal':
        last = e.get('last')
        add(foley, stamp(1.), t, .32 if not last else .6, pn)
        if e.get('pitch'): add(perc, muyu(e['pitch'], 1., e.get('idx', 0)), t, .4, pn * .7)
    elif ty == 'abacus': add(foley, abacus(e['n']), t, .085, .25)
    elif ty == 'num':
        add(foley, abacus(1), t, .2, pn); add(foley, fine_tick(), t, .12, pn)
    elif ty == 'big25': add(foley, stroke(e['d'], 1.), t, .3, pn)
    elif ty == 'wetin': add(foley, fine_tick(), t, .035, pn)
    elif ty == 'gong':
        g = S.hit('gong', None, .95).astype(np.float64); add(perc, norm(g), t, .32, 0)
        g2 = S.hit('gong2', 'big', .8).astype(np.float64); add(perc, norm(g2), t, .17, .1)
    elif ty == 'ban': add(perc, ban(), t, .5, -.1)
    elif ty == 'bangzi': add(perc, bangzi(), t, .3, .3)
    elif ty == 'roll':
        d = e['t1'] - t
        r = S.hit('gran_cassa', 'roll', .8, dur=d + .05).astype(np.float64)
        r = norm(r)[:int(d * SR)]
        r *= np.linspace(.15, 1, len(r)) ** 1.6
        add(perc, fade_end(r, 12), t, .42, 0)
    elif ty == 'mus':
        inst, p, d, v = e['inst'], e.get('pitch'), e['dur'], e['vel']
        if inst == 'guqin':
            kw = {}
            if e.get('harmonic'): kw['harmonic'] = True
            if e.get('vib'): kw['vib'] = tuple(e['vib'])
            x = P.pluck('guqin', p, d, v, **kw)
            add(music, x, t, .8 if not e.get('harmonic') else .7, pn)
        elif p is None:
            x = S.hit(inst, None, v); add(perc, x, t, .8, pn)
        else:
            x = S.note(inst, p, d, v); add(perc, x, t, .9, pn)

for e in merged: add(foley, stroke(e['d'], e['w']), e['t'], .085 * (.5 + e['w']), pan_of(e))

# 环境：极低的纸房间底噪，2.5 s 墨滴落下后才出现（前面是真静默）
t0 = 2.5; d = DUR - t0
bed = lp(np.cumsum(noise(d)) * .02, 1400) ; bed = hp(bed, 60); bed = norm(bed) * np.clip(t_(d) / 1.5, 0, 1)
add(amb, bed, t0, .006, 0); add(amb, np.roll(bed, 4800), t0, .006, .5)

# ───────── 混音 ─────────
music_w = S.room(music, size=.55, mix=.24)
perc_w = S.room(perc, size=.42, mix=.16)
foley_w = S.room(foley, size=.22, mix=.07)
mix = music_w * 1.0 + perc_w * .9 + foley_w * 1.0 + amb
peak = np.abs(mix).max()

# ───────── 母带：分总线限幅 + 把响度推到 −14 LUFS，再用 4 倍过采样的前视限幅把真峰值压到 −3 dBTP，
# 这样 mux.sh 的 loudnorm 几乎不用再动增益，真峰值也不会超 ─────────
import subprocess, tempfile, re, soxr
def lufs(x):
    f = tempfile.mktemp(suffix='.wav'); sf.write(f, x.astype(np.float32), SR)
    o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    os.remove(f); return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
def tp_limit(x, ceil_db=-3.0, look=.004, rel=.18, ret_gain=False):
    c = 10 ** (ceil_db / 20)
    up = soxr.resample(x, SR, SR * 4)
    pk = np.abs(up).max(1).reshape(-1, 4).max(1)[:len(x)]
    pk = np.pad(pk, (0, len(x) - len(pk)), mode='edge')
    from scipy.ndimage import maximum_filter1d
    n = int(look * SR); m = maximum_filter1d(pk, size=2 * n + 1)
    g = np.minimum(1, c / np.maximum(m, 1e-9))
    a = np.exp(-1 / (rel * SR)); out = g.copy()          # 起控快、释放平滑
    for i in range(1, len(g)): out[i] = g[i] if g[i] < out[i - 1] else a * out[i - 1] + (1 - a) * g[i]
    return (x * out[:, None], out) if ret_gain else x * out[:, None]

# 分总线先限幅：拟音的瞬态（印泥、水滴、墨点）很尖，单独用快释放压掉，不让总限幅器去"拉"锣和古琴的长尾；
# 打击乐总线用慢释放轻压。最后总线再做一次真峰值限幅，压缩量很小（见下面打印的诊断）。
nf = .89 / peak
SIL = int(2.5 * SR) - 24
G = 1.0
for it in range(5):
    fol = tp_limit(foley_w * nf * G, -5.0, look=.003, rel=.06)
    per = tp_limit(perc_w * .9 * nf * G, -3.0, look=.004, rel=.3)
    mix = music_w * nf * G + per + fol + amb * nf * G
    mix, gm = tp_limit(mix, -2.0, rel=.25, ret_gain=True)
    mix[:SIL] = 0
    L0 = lufs(mix); G *= 10 ** ((-14.0 - L0) / 20)
mix = np.clip(mix, -.98, .98)
print('master LUFS', round(lufs(mix), 2))
grm = 20 * np.log10(np.maximum(gm, 1e-9))
grf = 20 * np.log10(np.maximum(tp_limit(foley_w * nf * G, -5.0, look=.003, rel=.06, ret_gain=True)[1], 1e-9))
grp = 20 * np.log10(np.maximum(tp_limit(perc_w * .9 * nf * G, -3.0, look=.004, rel=.3, ret_gain=True)[1], 1e-9))
for a_, b_ in [(2.4, 3.0), (6.6, 7.2), (20.7, 29.8), (29.95, 31.0), (31.0, 33.3)]:
    i0, i1 = int(a_ * SR), int(b_ * SR)
    print(f'{a_:5.2f}–{b_:5.2f} s 最大压缩：总 {grm[i0:i1].min():+.1f} dB｜拟音 {grf[i0:i1].min():+.1f}｜打击 {grp[i0:i1].min():+.1f}')
# 锣尾：总限幅增益在 30.1–33.3 s 的最快变化（dB / 10 ms），越小越不会把锣尾"调制"出金属失真
gd = grm[int(30.1 * SR):int(33.3 * SR)][::480]; print('锣尾增益最快变化', round(float(np.abs(np.diff(gd)).max()), 2), 'dB/10ms，削波样本', int((np.abs(mix) >= .98).sum()))
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='PCM_24')
for nm, x in [('music', music_w), ('perc', perc_w), ('foley', foley_w)]:
    sf.write(os.path.join(HERE, 'out', 'stems', nm + '.wav'), (x / max(1e-9, np.abs(x).max()) * .8).astype(np.float32), SR)
print('mix.wav', mix.shape, 'peak', np.abs(mix).max().round(3), 'strokes merged', len(strokes), '→', len(merged))
