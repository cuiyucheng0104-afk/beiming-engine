#!/usr/local/bin/python3
"""混音：配音 + 分段配乐（配音时自动压低）+ 代码合成音效 → out/mix.wav，再与画面合成成片。"""
import json, subprocess, wave
from pathlib import Path
import numpy as np
from scipy import signal

P = Path(__file__).resolve().parent
SR = 44100
TLJ = json.load(open(P / 'timeline.json')); SH = TLJ['shots']; TOTAL = TLJ['total']
N = int((TOTAL + 1) * SR)
LINES = {x['id']: x for x in json.load(open(P / 'lines.json'))}
rng = np.random.default_rng(1)
by = {s['name']: s for s in SH}

def rd(path):
    out = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(path), '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True).stdout
    return np.frombuffer(out, np.float32).reshape(-1, 2).copy()

def put(buf, x, t, g=1.0):
    i = int(t * SR)
    if i >= len(buf): return
    x = x[:len(buf) - i]
    if x.ndim == 1: x = np.repeat(x[:, None], 2, 1)
    buf[i:i + len(x)] += x * g

def lp(x, f, o=4): return signal.sosfilt(signal.butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=4): return signal.sosfilt(signal.butter(o, f, 'high', fs=SR, output='sos'), x)
def bp(x, a, b, o=3): return signal.sosfilt(signal.butter(o, [a, b], 'band', fs=SR, output='sos'), x)
def noise(d): return rng.standard_normal(int(d * SR)).astype(np.float32)
def env(d, a=0.01, r=None):
    n = int(d * SR); t = np.arange(n) / SR
    e = np.minimum(t / max(a, 1e-4), 1.0)
    return e * (np.exp(-t / r) if r else 1.0)

def shot_t(name, t=0.0): return by[name]['start'] + t
def line_t(name, lid): return by[name]['start'] + by[name]['lines'][lid]

# ---------------- 配音 ----------------
vo = np.zeros((N, 2), np.float32); mask = np.zeros(N, np.float32)
for s in SH:
    for lid, t in s['lines'].items():
        x = rd(P / 'vo' / f'{lid}.wav')
        g = 1.0
        if LINES[lid]['who'] == '乐奇':   # 乐奇：轻微的“耳机里”质感，偏亮、略窄
            m = x.mean(1); x = np.stack([m * 0.92, m * 0.92], 1); x[:, 0] = hp(x[:, 0], 140); x[:, 1] = hp(x[:, 1], 140)
        if lid == 'i2':                   # 电话里的许岚
            m = bp(x.mean(1), 300, 3400); x = np.stack([m, m], 1) * 1.3
        if lid == 'h1':                   # 庄园广播：带一点房间回声
            m = bp(x.mean(1), 400, 4000); e = np.zeros_like(m); d = int(0.11 * SR); e[d:] = m[:-d] * 0.45
            m = m + e; x = np.stack([m, m], 1)
        put(vo, x, s['start'] + t, g)
        i0 = int((s['start'] + t - 0.15) * SR); i1 = int((s['start'] + t + len(x) / SR + 0.2) * SR)
        mask[max(i0, 0):i1] = 1
duck = signal.lfilter([1 - 0.9995], [1, -0.9995], mask)   # 平滑的闪避包络
duck = np.clip(duck * 1.6, 0, 1)

# ---------------- 配乐 ----------------
mus = np.zeros((N, 2), np.float32)
MD = P / 'music'
def cue(f):
    p = MD / f
    return rd(p) if p.exists() else None

def place(x, t0, t1, fi=0.6, fo=1.5, xf=2.0, g=1.0, offset=0.0):
    """把 x（单条或多条交替）铺在 [t0,t1]，不够长就交叉淡化接下一条。"""
    xs = [c for c in (x if isinstance(x, list) else [x]) if c is not None]
    if not xs: return
    need = int((t1 - t0) * SR); xn = int(xf * SR)
    out = xs[0][int(offset * SR):].copy(); k = 1
    while len(out) < need:
        nx = xs[k % len(xs)]; k += 1
        ramp = np.linspace(0, 1, xn)[:, None]
        out = np.concatenate([out[:-xn], out[-xn:] * (1 - ramp) + nx[:xn] * ramp, nx[xn:]])
    out = out[:need].copy()
    n = len(out); a = np.ones(n)
    fi_n = int(fi * SR); fo_n = int(fo * SR)
    if fi_n: a[:fi_n] = np.linspace(0, 1, fi_n)
    if fo_n: a[-fo_n:] *= np.linspace(1, 0, fo_n)
    put(mus, out * a[:, None], t0, g)

alarm0 = shot_t('s_alarm'); enter0 = shot_t('s_enter1'); paint0 = shot_t('s_count')
run0 = shot_t('s_escape'); sil0 = shot_t('s_silence'); fly0 = shot_t('s_fly')
bye_end = line_t('s_cliff', 'i8') + 0.9
rotor0 = sil0 + 3.2
place([cue('m1_manor.wav'), cue('m1_manor_b.wav')], 0.0, alarm0 + 0.3, fi=1.5, fo=0.4)
place(cue('m3_tense.wav'), alarm0, enter0 + 0.8, fi=0.05, fo=0.6)
place([cue('m2_chase.wav'), cue('m2_chase_b.wav')], paint0 - 0.2, run0 + 0.4, fi=0.3, fo=0.6)
place(cue('m3_tense.wav'), run0, bye_end, fi=0.2, fo=0.12, offset=4.0)
place(cue('m4_hero.wav'), rotor0 + 2.0, TOTAL + 0.5, fi=2.5, fo=3.5)
mg = 0.55 * (1 - 0.55 * duck)
mus *= mg[:, None]

# ---------------- 音效 ----------------
fx = np.zeros((N, 2), np.float32)
def thunder(t, g=0.9):
    d = 3.0; x = lp(noise(d), 180) * env(d, 0.02, 0.9) + lp(noise(d), 1200) * env(d, 0.002, 0.08) * 0.5
    put(fx, x, t, g)
def rainbed(t0, t1, g=0.05):
    put(fx, hp(noise(t1 - t0), 2500) * np.minimum(1, np.minimum(np.arange(int((t1 - t0) * SR)) / SR / 0.5, (t1 - t0 - np.arange(int((t1 - t0) * SR)) / SR) / 0.5)), t0, g)
def blip(t, f=1600, g=0.25, d=0.06):
    tt = np.arange(int(d * SR)) / SR; put(fx, np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.015), t, g)
def metal(t, g=0.35):
    d = 1.2; tt = np.arange(int(d * SR)) / SR
    x = sum(np.sin(2 * np.pi * f * tt) * np.exp(-tt / r) * a for f, r, a in [(880, .5, 1), (1847, .25, .5), (2950, .12, .35), (420, .3, .6)])
    put(fx, x * env(d, 0.001), t, g)
def whoosh(t, d=1.0, g=0.4, f0=300, f1=3000):
    x = noise(d); n = len(x); out = np.zeros(n)
    for k in range(8):
        a, b = k * n // 8, (k + 1) * n // 8; fc = f0 * (f1 / f0) ** (k / 7)
        out[a:b] = bp(x, fc * 0.7, min(fc * 1.4, SR / 2 - 100))[a:b]
    put(fx, out * np.sin(np.linspace(0, np.pi, n)) ** 2, t, g)
def boom(t, g=0.9):
    d = 2.0; tt = np.arange(int(d * SR)) / SR
    put(fx, (np.sin(2 * np.pi * (55 - 20 * tt) * tt) * np.exp(-tt / 0.5) + lp(noise(d), 300) * np.exp(-tt / 0.3)), t, g)
def crackle(t0, d, g=0.3, rate=60):
    x = np.zeros(int(d * SR))
    for k in rng.uniform(0, d, int(d * rate)):
        i = int(k * SR); n = int(rng.uniform(0.003, 0.02) * SR)
        c = hp(rng.standard_normal(n), 1500)[:len(x) - i]
        x[i:i + len(c)] += c * rng.uniform(0.3, 1)
    put(fx, x, t0, g)
def wind(t0, t1, g=0.12):
    n = int((t1 - t0) * SR); x = lp(noise(t1 - t0), 500)
    m = 0.6 + 0.4 * np.sin(np.arange(n) / SR * 0.7 * 2 * np.pi)
    a = np.minimum(1, np.minimum(np.arange(n) / SR / 1.0, (n - np.arange(n)) / SR / 1.0))
    put(fx, x * m * a, t0, g)

thunder(1.3); thunder(4.4, 0.6); thunder(shot_t('s_car', 3.2), 0.7)
rainbed(shot_t('s_car'), shot_t('s_gallery'), 0.04)
# 展签亮起
metal(2.8, 0.25)
for k in range(4): blip(line_t('s_gallery', 'b1') + 0.3 + k * 0.45, 1250, 0.12)
# 识物对齐完成
blip(shot_t('s_appraise', 3.2), 2200, 0.15); blip(shot_t('s_appraise', 3.28), 2900, 0.12)
# 警报
t = alarm0
while t < enter0:
    for f, d in ((880, 0.22), (660, 0.22)):
        tt = np.arange(int(d * SR)) / SR; put(fx, signal.square(2 * np.pi * f * tt) * 0.5 * env(d, 0.005), t, 0.07); t += 0.25
# 入画①：灰泥崩裂
crackle(enter0, by['s_enter1']['dur'], 0.35, 90); whoosh(enter0 + 0.4, 1.6, 0.45, 200, 2500)
# 数人头：每出一个编号一声
for k in range(13): blip(line_t('s_count', 'e2') + 0.2 + (k + 1) * 0.16, 1400, 0.1)
for k in range(2): blip(line_t('s_count', 'e2') + 0.2 + 13 * 0.16 + 0.4 + k * 0.35, 700, 0.18, 0.12)
metal(line_t('s_shoe', 'e5'), 0.3)
# 入画②：油画龟裂
crackle(shot_t('s_knight'), 1.9, 0.25, 140); whoosh(shot_t('s_knight', 0.2), 1.6, 0.3, 400, 4000)
# 马蹄
t = shot_t('s_ride'); t1 = shot_t('s_cubist')
while t < t1 - 0.3:
    for off in (0, 0.09, 0.2):
        d = 0.12; tt = np.arange(int(d * SR)) / SR
        put(fx, lp(noise(d), 400) * np.exp(-tt / 0.03) + np.sin(2 * np.pi * 90 * tt) * np.exp(-tt / 0.04), t + off, 0.35)
    t += 0.42
# 入画③：碎面
t0 = shot_t('s_cubist')
for k in range(14):
    tt = np.arange(int(0.25 * SR)) / SR; f = rng.uniform(1500, 4000)
    put(fx, np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.06), t0 + k * 0.1, 0.08)
whoosh(t0, 1.4, 0.3, 3000, 300)
metal(shot_t('s_feet', 0.1), 0.3)
# 飞车
rainbed(shot_t('s_escape'), shot_t('s_landed'), 0.05)
lift = line_t('s_gate', 'h6') + 0.5
whoosh(lift - 0.6, 1.8, 0.7, 150, 2500); boom(lift + 0.5, 0.6)
boom(shot_t('s_landed'), 0.8); crackle(shot_t('s_landed'), 0.6, 0.4, 200)
# 导航到达
blip(line_t('s_call', 'i3') + 2.6, 1800, 0.2); blip(line_t('s_call', 'i3') + 2.7, 2400, 0.2)
blip(line_t('s_cliff', 'i5') + 2.2, 2000, 0.15)
# 悬崖风 + 寂静 + 旋翼
wind(shot_t('s_call'), bye_end + 0.5, 0.06)
wind(bye_end - 0.2, rotor0 + 1.0, 0.11)
d = TOTAL - rotor0; n = int(d * SR); tt = np.arange(n) / SR
rise = np.clip(tt / 3.0, 0, 1) ** 2 * np.clip((by['s_news']['start'] - rotor0 - tt) / 2.0, 0, 1)
rate = 8 + 6 * np.clip(tt / 4, 0, 1)
chop = (0.5 + 0.5 * np.sin(2 * np.pi * np.cumsum(rate) / SR)) ** 4
x = lp(noise(d), 250) * chop * 1.4 + lp(noise(d), 1500) * chop * 0.25
put(fx, x * rise, rotor0, 0.7)
# 新闻打字
for i, s in enumerate(['黑荆棘庄园 · 接受国际调查', '乐奇第一视角记录 · 成为关键证据', '铜羊首 · 经正式程序返还中国']):
    t0 = shot_t('s_news', 0.4 + i * 1.7)
    for k in range(len(s)): blip(t0 + k / 18, rng.uniform(2500, 3500), 0.05, 0.02)
DUR = json.load(open(P / 'vo' / 'dur.json'))
metal(line_t('s_museum', 'k2') + DUR['k2'] * 0.6, 0.3)

mix = vo * 1.0 + mus + fx * 0.8
peak = np.abs(mix).max(); mix = mix / max(peak, 1e-6) * 0.95
pcm = (np.clip(mix, -1, 1) * 32767).astype('<i2')
with wave.open(str(P / 'out' / 'mix_raw.wav'), 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('mix ok', round(TOTAL, 2))
