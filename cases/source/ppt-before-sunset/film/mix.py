"""《日落之前》声音：配音（电话滤波 / 同传压低原声）+ 代码合成音效 + Music3 分幕配乐，输出 out/mix.wav 和 srt"""
import math, wave
import numpy as np
from scipy.signal import butter, sosfilt
import build as b

SR = b.SR; T, at, end, DUR, SCD = b.T, b.at, b.end, b.DUR, b.SCD
N = int(b.TOTAL * SR)

def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def put(buf, x, t0, g=1.0):
    a = int(t0 * SR)
    if a < 0: x = x[-a:]; a = 0
    m = min(len(x), N - a)
    if m > 0: buf[a:a + m] += x[:m] * g
def tt(d): return np.arange(int(d * SR)) / SR
R = np.random.default_rng(7)
def noise(d): return R.standard_normal(int(d * SR))

# ---------------------------------------------------------------- 音效
def thunk():                                   # 章节印章 / 片名落下
    t = tt(.5); return (np.sin(2 * np.pi * (90 - 40 * t) * t) * np.exp(-t * 18) * .8 + lp(noise(.5), 900) * np.exp(-t * 30) * .5)
def buzz(d=1.8):                               # 镜腿来电振动
    t = tt(d); g = ((t % .6) < .38).astype(float)
    return lp(np.sign(np.sin(2 * np.pi * 150 * t)), 600) * g * .12 * (np.sin(2 * np.pi * 7 * t) ** 2 + .3)
def chime(f=(1320, 1760), dt=.09, k=.22):
    x = np.zeros(int(SR * .6))
    for i, fr in enumerate(f):
        s = int(SR * dt * i); t = tt(.4); x[s:s + len(t)] += np.sin(2 * np.pi * fr * t) * np.exp(-t * 12) * k
    return x
def busy():                                    # 挂断忙音
    x = np.zeros(int(SR * 1.6))
    for i in range(3):
        s = int(SR * .5 * i); t = tt(.25); x[s:s + len(t)] += (np.sin(2 * np.pi * 480 * t) + np.sin(2 * np.pi * 620 * t)) * .05
    return bp(x, 300, 3400)
def glitch():
    n = noise(.5); g = (R.random(len(n) // 300 + 1) > .45).repeat(300)[:len(n)]
    return np.round(n * g * 4) / 4 * .14
def scuffle():
    t = tt(.9); return bp(noise(.9), 300, 3000) * (np.abs(np.sin(2 * np.pi * 6 * t)) ** 3) * .25
def shutter():
    n = noise(.12); e = np.exp(-tt(.12) * 60)
    return np.concatenate([n * e * .5, np.zeros(int(SR * .03)), n[:int(SR * .06)] * e[:int(SR * .06)] * .35])
def stone():
    t = tt(.3); return (bp(noise(.3), 800, 5000) * np.exp(-t * 50) * .5 + np.sin(2 * np.pi * 220 * t) * np.exp(-t * 30) * .2)
def creak():
    t = tt(1.4); f = 180 + 60 * np.sin(2 * np.pi * .7 * t) + 20 * R.standard_normal(len(t)).cumsum() / 400
    saw = ((np.cumsum(f / SR)) % 1 - .5) * (R.random(len(t)) > .3)
    return bp(saw, 300, 2500) * np.sin(np.pi * t / 1.4) * .18
def boom(d=2.0, f0=55):
    t = tt(d); return np.sin(2 * np.pi * (f0 * t - 8 * t * t)) * np.exp(-t * 2.4) * .8 + lp(noise(d), 300) * np.exp(-t * 6) * .4
def crash():
    t = tt(2.5)
    hit = boom(2.5, 48)
    wood = np.zeros(len(t))
    for k in range(26):                       # 木头断裂的噼啪
        s = int(SR * abs(R.normal(.12, .3))); m = int(SR * R.uniform(.02, .08))
        if s + m < len(t): wood[s:s + m] += bp(R.standard_normal(m), 600, 6000) * np.exp(-np.arange(m) / SR * 60) * R.uniform(.3, .9)
    debris = bp(noise(2.5), 1500, 7000) * np.exp(-t * 2.2) * .18
    return hit * .9 + wood * .7 + debris
def scratch(seg):                              # 树枝划沙
    x = bp(R.standard_normal(len(seg)), 1200, 6500) * .16
    return x * (.6 + .4 * np.abs(np.sin(np.cumsum(np.ones(len(seg))) / SR * 2 * np.pi * 9)))
def knock():
    t = tt(.4); return np.sin(2 * np.pi * 300 * t) * np.exp(-t * 35) * .3 + bp(noise(.4), 500, 3000) * np.exp(-t * 60) * .2
def whoosh(d=1.0):
    t = tt(d); return lp(noise(d), 1800) * np.sin(np.pi * t / d) ** 2 * .22

def engine(t0, t1, keys, f_scale=1.0, base=.22, cutoff=1400):
    """keys: [(相对秒, 转速, 增益)]；谐波 + 点火颗粒 + 进排气噪"""
    d = t1 - t0; t = tt(d)
    kt = np.array([k[0] for k in keys]); rpm = np.interp(t, kt, [k[1] for k in keys]); g = np.interp(t, kt, [k[2] for k in keys])
    f = rpm / 60 * 2 * f_scale
    ph = np.cumsum(2 * np.pi * f / SR) + np.cumsum(R.standard_normal(len(t))) * 2e-4
    x = sum(a * np.sin(k * ph + k * .7) for k, a in enumerate([1, .7, .5, .35, .25, .16, .1], 1))
    x *= 1 + .3 * np.sin(ph / 2) + .12 * R.standard_normal(len(t))
    x = lp(x + bp(R.standard_normal(len(t)), 80, 700) * .6, cutoff, 3)
    return x / 5 * g * base, t0

def starter(d=.7):                             # 起动机咔咔转
    t = tt(d); g = (np.sin(2 * np.pi * 11 * t) > 0).astype(float)
    return bp(noise(d), 200, 1800) * g * .25 + np.sin(2 * np.pi * 70 * t) * g * .15

def siren(t0, t1):
    t = tt(t1 - t0); f = np.where((t % 1.4) < .7, 760, 590)
    f = lp(f.astype(float), 6)
    x = np.sin(np.cumsum(2 * np.pi * f / SR)) + .4 * np.sin(np.cumsum(2 * np.pi * f * 2 / SR))
    env = np.minimum(1, t / 3) * np.minimum(1, (t[-1] - t) / 2)
    return lp(x, 2200) * env * .045

def wind():
    t = np.arange(N) / SR
    x = lp(R.standard_normal(N), 700) * 3.0
    gust = .55 + .45 * np.sin(2 * np.pi * .07 * t + 1) * np.sin(2 * np.pi * .023 * t)
    lvl = np.interp(t, [0, 2, SCD['call'][1], SCD['call'][2], SCD['ride'][1], SCD['map'][2], SCD['boss'][1], SCD['ridge'][1], SCD['ridge'][2],
                        SCD['mine'][1] + 1, SCD['store'][1], SCD['recap'][1], SCD['hero'][1], b.TOTAL],
                    [0, .9, .5, .35, .9, .7, .2, .9, .8, .15, .3, .1, .6, .3])
    return x * gust * lvl * .045

# ---------------------------------------------------------------- 配音
PHONE = {'y01', 'g01', 'y02'}
def voices():
    vo = np.zeros(N); duck_es = np.ones(N)
    for k, _ in b.ORDER:
        x = b.rd(b.VO + f'wav/{k}.wav').astype(np.float64)
        if k in PHONE:                                   # 电话：带通 + 轻失真
            x = np.tanh(bp(x, 320, 3300, 3) * 2.2) * .62
        if k[0] == 't':                                  # 眼镜同传：干净、略靠前
            x = hp(x, 160) * 1.0
        g = 1.0 if k[0] in 'nt' else 1.05
        if k == 'y02':                                   # “旧矿——”被掐断
            cut = int((b.DROP - T[k]) * SR); x = x[:cut]; x[-200:] *= np.linspace(1, 0, 200)
        put(vo, x, T[k], g)
    for k in ('t01', 't02', 't03'):                      # 同传响起时，西语原声退到后面
        e = 'e' + k[1:]
        a, z = int(T[k] * SR), int(end(e) * SR)
        r = np.ones(N); r[a:z] = .42
        sm = int(.15 * SR); r = np.convolve(r, np.ones(sm) / sm, 'same')
        es = np.zeros(N); put(es, b.rd(b.VO + f'wav/{e}.wav'), T[e], 1.05)
        vo -= es * (1 - r)
    return vo

# ---------------------------------------------------------------- 配乐
def track(name, alt=None):
    for n in ([name] + ([alt] if alt else [])):
        try: return b.rd(b.MUS + n).astype(np.float64)
        except Exception: pass
    return None

def fit(x, L, xf):
    if len(x) >= L: return x[:L].copy()
    y = x.copy()
    while len(y) < L:
        f = np.linspace(0, 1, xf); y[-xf:] = y[-xf:] * (1 - f) + x[:xf] * f; y = np.concatenate([y, x[xf:]])
    return y[:L]

def music():
    out = np.zeros(N); xf = int(SR * 2.0)
    sneak = track('sneak_s7.wav'); s8 = track('sneak_s8.wav')
    if sneak is not None and s8 is not None:
        f = np.linspace(0, 1, xf); sneak = np.concatenate([sneak[:-xf], sneak[-xf:] * (1 - f) + s8[:xf] * f, s8[xf:]])
    endm = track('end_s8.wav')
    e7 = track('end_s7.wav')
    if endm is not None and e7 is not None:
        f = np.linspace(0, 1, xf); endm = np.concatenate([e7[:-xf], e7[-xf:] * (1 - f) + endm[:xf] * f, endm[xf:]])
    elif endm is None: endm = e7
    ride = track('ride_s8.wav'); clim = track('climax_s7.wav')
    ride = ride[int(8 * SR):]                                   # 跳过前 8 秒安静段，起势落在骑行镜头
    clim = clim[int((8.0 - (b.CRASH - (T['c06'] - .9))) * SR):]  # 第 8 秒的鼓点对准撞门
    cues = [(0.6, b.DROP + 1.2, track('open_s8.wav', 'open_s7.wav'), .55, 2.5),
            (b.DROP + .2, SCD['map'][2] + .4, ride, .6, 1.5),
            (SCD['boss'][1] - .4, T['c06'] - .6, sneak, .6, 2.0),
            (T['c06'] - .9, SCD['crash'][2] + 1.0, clim, .7, .6),
            (SCD['store'][1] - .5, b.TOTAL, endm, .62, 2.5)]
    for s, e, x, g, fi in cues:
        if x is None: continue
        a, z = int(s * SR), min(N, int(e * SR)); L = z - a
        seg = fit(x, L, xf) * g
        fin, fout = int(fi * SR), int(1.5 * SR)
        seg[:fin] *= np.linspace(0, 1, fin) ** 1.5; seg[-fout:] *= np.linspace(1, 0, fout)
        out[a:z] += seg
    return out

# ---------------------------------------------------------------- 总混
def audio():
    vo = voices(); fx = np.zeros(N)
    put(fx, thunk(), 2.0, .8)
    for t0, *_ in b.CHAP: put(fx, thunk(), t0, .35)
    ring = T['y01'] - 2.6; opn = T['y01'] - 1.8
    put(fx, buzz(1.8), ring, 1.0); put(fx, chime((990, 1320)), opn, .8); put(fx, chime((1320, 1760, 2093)), T['y01'] - .7, .6)
    put(fx, scuffle(), T['g01'] - .2, .9)
    put(fx, glitch(), b.DROP, 1.0); put(fx, busy(), b.DROP + .25, 1.0)
    # 摩托：两次没打着，第三次起动，一路开过荒原，到岔路口刹停
    r0 = b.SCD['ride'][1] - 1.2
    put(fx, starter(.6), r0 - 1.6, .8); put(fx, starter(.5), r0 - .8, .8)
    x, t0 = engine(r0, SCD['ask'][1] + 3.0, [(0, 900, 0), (.15, 2600, 1), (.8, 3800, 1.1), (2, 4200, 1), (8, 4300, 1), (10.5, 3000, .7), (12.8, 1000, .25), (14.5, 900, 0)])
    put(fx, x, t0, 1.0)
    # 镜片窗打开
    for t_ in (end('c02') - .1, T['c08'] + .2): put(fx, chime((1175, 1568)), t_, .7)
    # 树枝划沙
    sc = np.zeros(N)
    for pts, a, z in b.STROKES:
        seg = scratch(np.zeros(int((z - a) * SR))); put(sc, seg, a, 1.0)
    fx += sc
    put(fx, stone(), b.RED_T + .3, 1.0)
    put(fx, shutter(), b.SHUT, 1.2); put(fx, chime((1568, 2093)), b.SHUT + .7, .4)
    put(fx, boom(2.0, 45), SCD['boss'][1] + .2, .5)
    put(fx, creak(), T['n08'] + .2, 1.0)
    put(fx, boom(1.8, 60), at('n09', .45), .6)
    # 水车：两次打火，第二次轰鸣；撞门
    put(fx, starter(.7), T['c06'] - 2.0, 1.0)
    put(fx, starter(.5), T['c06'] - 1.0, 1.0)
    x, t0 = engine(T['c06'] - .45, b.SCD['crash'][2] + 1.0, [(0, 400, 0), (.15, 1400, 1.2), (1.2, 2200, 1.3), (2.0, 2600, 1.3), (5, 2300, .7), (9, 1600, .35), (12, 1200, 0)], f_scale=.6, base=.3, cutoff=900)
    put(fx, x, t0, 1.0)
    put(fx, whoosh(.6), b.CRASH - .5, 1.0); put(fx, crash(), b.CRASH, 1.0)
    put(fx, siren(at('n10', .3), SCD['crash'][2] + 1.5), at('n10', .3), 1.0)
    put(fx, chime((1046, 1568), .12, .25), T['t04'] + .05, 1.0)          # 支付成功
    for mi, *_ in b.RECAP_MARK:                                           # 回顾：太阳经过三个点
        tt_ = T['n12'] - .2 + (end('n12') + .4 - T['n12']) * (mi / (b.SUNSET + 14))
        put(fx, chime((1318, 1760)), tt_, .5)
    put(fx, thunk(), SCD['hero'][1] + .6, .6)
    put(fx, knock(), T['y08'] - .9, 1.0)                                  # 水瓶放上长椅
    # 转场的太阳：每个对位转场一阵风声
    for s in b.SC[1:]:
        put(fx, whoosh(1.2), s[1] - .6, .6)
    fx += wind()
    mu = music()
    env = np.abs(vo); k = int(SR * .3)
    env = np.convolve(env, np.ones(k) / k, 'same'); duck = 1 - .55 * np.clip(env / (env.max() * .12 + 1e-6), 0, 1)
    mix = vo * 1.0 + fx * .85 + mu * duck
    # 限幅：先整体抬到接近目标响度，再压掉印章/撞击这类尖峰
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    mix = mix / (np.percentile(np.abs(vo), 99.5) + 1e-6) * .62
    env = uniform_filter1d(maximum_filter1d(np.abs(mix), int(SR * .006)), int(SR * .03))
    mix = mix * np.minimum(1, .7 / (env + 1e-9))
    mix = np.clip(mix, -.8, .8)
    w = wave.open(b.OUT + 'mix.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes()); w.close()

def srt():
    def ts(x): h, r = divmod(x, 3600); m_, s = divmod(r, 60); return f'{int(h):02d}:{int(m_):02d}:{int(s):02d},{int((s % 1) * 1000):03d}'
    items = [(s, e, c) for c, s, e in b.NARR]
    for k in b.DIAL + ['t01', 't02', 't03', 't04']:
        x = b.LINES[k]; e = b.DEND.get(k, end(k) + .3)
        body = (x['es'] + '\n' + (x['zh'] if k != 'g01' else '（西班牙语）')) if 'es' in x else x['zh']
        if k[0] == 't': body = '【眼镜翻译】' + x['zh'] if k != 't04' else '【眼镜】支付成功'
        items.append((T[k], e, f"{x['who']}：{body}" if k[0] != 't' else body))
    items.sort()
    open(b.P + '日落之前_故事介绍.srt', 'w').write('\n'.join(f'{i + 1}\n{ts(s)} --> {ts(e)}\n{c}\n' for i, (s, e, c) in enumerate(items)))

if __name__ == '__main__':
    audio(); srt(); print('ok')
