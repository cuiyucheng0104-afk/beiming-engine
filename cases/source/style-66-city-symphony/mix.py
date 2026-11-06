"""混音：配乐（tools/music.py → out/music.wav）+ 环境层 + 拟音（全部由 window.EV 驱动，events.json）→ out/mix.wav。
拟音都写成配乐的一部分：音量压在音乐下，音色和打击乐同声部（STYLE §7 只要音乐；用户要求每个动作有声音，这是两者的折中）。
用法：python mix.py（先跑 events.mjs 和 tools/music.py）"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sfx as X
from core.audio.sfx import SR, add, lp, hp, bp, noise, env_exp, t_, norm, brown

E = json.load(open(os.path.join(HERE, 'events.json')))
DUR = E['dur']; EV = E['ev']; FPS = 24
music, sr = sf.read(os.path.join(HERE, 'out', 'music.wav'), dtype='float32'); assert sr == SR
N = int(np.ceil(DUR * SR))
fx = np.zeros((N, 2), np.float32)
amb = np.zeros((N, 2), np.float32)
rng = np.random.default_rng(66)


def shutter(v=1.0):
    """相机快门：反光镜一下 + 帘幕一下，相隔 38 ms"""
    d = .09; x = np.zeros(int(d * SR))
    a = hp(noise(.006), 2500) * env_exp(.006, .0012); b = X.click(.62, 1.0)[:int(.05 * SR)] * .6
    x[:len(a)] += a; x[:len(b)] += b
    o = int(.038 * SR); c = hp(noise(.005), 3200) * env_exp(.005, .001) * .7; x[o:o + len(c)] += c
    return norm(x) * v


def relay(v=1.0):
    """路灯熄灭：继电器咔哒 + 低频闷响"""
    x = np.zeros(int(.5 * SR)); c = X.clack(.7, .8); x[:len(c)] += c
    th = X.thump(1.0, 52); x[:len(th)] += th * .9
    return norm(x) * v


def downsweep(d=.7, v=1.0):
    n = noise(d); out = np.zeros_like(n); L = len(n)
    for i in range(0, L, 480):
        hi = min(L, i + 480); f = 3200 * (1 - i / L) ** 2 + 180
        out[i:hi] = bp(n[max(0, i - 2000):hi], f * .7, f * 1.3)[-(hi - i):]
    return norm(out * np.sin(np.pi * t_(d) / d) ** 1.5 * np.exp(-t_(d) * 2)) * v


def shimmer(d=.6, up=True, v=1.0):
    tt = t_(d); f0, f1 = (1800, 6400) if up else (6400, 1800)
    f = f0 + (f1 - f0) * (tt / d) ** 1.5
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .4 + hp(noise(d), 5000) * .6
    return norm(x * np.sin(np.pi * tt / d) ** 2) * v


def bed_city(d):
    b = bp(brown(d), 60, 900) * .7 + bp(noise(d), 300, 2400) * .12
    tt = t_(d); mod = .8 + .2 * np.sin(2 * np.pi * .7 * tt) * np.sin(2 * np.pi * .23 * tt + 1)
    return norm(b * mod)


def place_bed(x, f0, f1, gain, fin=.25, fout=.06, steps=None):
    t0, t1 = f0 / FPS, f1 / FPS; n = int((t1 - t0) * SR); x = x[:n].copy()
    e = np.ones(n); a = int(fin * SR); z = int(fout * SR)
    e[:a] = np.linspace(0, 1, a); e[-z:] *= np.linspace(1, 0, z)
    if steps:
        for fs, g in steps:
            k = int((fs / FPS - t0) * SR)
            if 0 <= k < n:
                r = min(n - k, int(.05 * SR)); cur = e[k - 1] if k > 0 else 1
                e[k:k + r] *= np.linspace(1, g, r); e[k + r:] *= g
    add(amb, (x * e).astype(np.float32), t0, gain, 0)
    add(amb, (np.roll(x, 777) * e).astype(np.float32), t0, gain * .6, .5)


light_steps = [(e['f'], g) for e, g in zip([e for e in EV if e['type'] == 'light_off'], (.7, .65, .6))]
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'cut':
        pan = .25 if 'FLASH' in e.get('shot', '') else -.1
        add(fx, shutter(), t, .2 if e.get('flash') else .32, pan)
    elif ty == 'cell':
        add(fx, X.click(1.5 + .1 * (e['i'] % 4), 1.0), t, .07, -.6 + 1.2 * ((e['i'] % 4) / 3))
    elif ty == 'whoosh':
        g = {'train': .42, 'train_in': .38, 'river': .34, 'drive': .3, 'lcut': .26}[e['what']]
        add(fx, X.whoosh(e['dur'], 1.0), t, g, -.3 if e['what'] == 'train' else .2)
    elif ty == 'brake':
        add(fx, downsweep(.75), t, .3, 0)
    elif ty == 'ring_freeze':
        add(fx, X.step(.8), t + 0.0, .12, .7)
    elif ty == 'ring_rewind':
        add(fx, shimmer(.45, up=False), t, .1, .7)
    elif ty == 'laser':
        add(fx, shimmer(.7, up=True), t, .14, -.3); add(fx, shimmer(.7, up=True), t, .1, .4)
    elif ty == 'lights_on':
        add(fx, shimmer(.45, up=True), t, .16, .1)
    elif ty == 'light_off':
        add(fx, relay(), t, .5, -.2 + .2 * e['group'])
    elif ty == 'stop':
        add(fx, relay(), t, .62, 0)
    elif ty == 'last':
        add(fx, X.click(.9, 1.0), t, .22, .15); add(fx, X.thump(1.0, 60), t, .16, .15)
    elif ty == 'bed':
        f0, f1 = e['f'], e['f1']
        d = (f1 - f0) / FPS + .1
        if e['kind'] == 'dawn':
            place_bed(norm(lp(hp(noise(d), 120), 900)), f0, f1 + 2, .05, fin=.8, fout=.25)
        elif e['kind'] == 'city':
            place_bed(bed_city(d), f0, f1, .14, fin=.55, fout=.05)
        elif e['kind'] == 'night':
            nb = norm(lp(brown(d), 500) * .8 + bp(noise(d), 800, 3000) * .1)
            place_bed(nb, f0, f1, .1, fin=.2, fout=.4, steps=light_steps)

mix = music[:N] + fx * .9 + amb
# 近乎静默再压深：12.0 s 起把刹车和弦的尾巴按 dB 线性压下去，重音前 2 帧几乎无声；重音那一帧起恢复原样
t_hit = next(e['t'] for e in EV if e['type'] == 'hit' and e.get('what') == 'night')
t_hush = next(e['t'] for e in EV if e['type'] == 'hush')
tt = np.arange(N) / SR
db = np.interp(tt, [t_hush + .45, t_hit - .3, t_hit - 2 / FPS, t_hit - 1e-6], [0, -9, -22, -22])
db[tt >= t_hit] = 0
mix = mix * (10 ** (db / 20)).astype(np.float32)[:, None]
mix = X.limit(mix, .95) if mix.ndim == 1 else np.stack([X.limit(mix[:, 0], .95), X.limit(mix[:, 1], .95)], 1)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
sf.write(os.path.join(HERE, 'out', 'fx.wav'), (fx + amb).astype(np.float32), SR, subtype='FLOAT')
print(f'mix.wav {N / SR:.3f} s; 拟音事件 {sum(1 for e in EV if e["type"] not in ("hit", "title", "quote", "hush"))} 个')
