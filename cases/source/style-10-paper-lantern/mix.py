"""夜班火车回家 —— 原创配乐 + 拟音 + 环境 → out/mix.wav
所有时间来自 events.json（由 timeline.js 经 index.html 的 window.EV 导出）。运行：$LIB/.venv/bin/python mix.py
乐器：八音盒（pluck.py music_box）、竖琴 / 钟琴 / 玻璃琴 / 弓奏颤音琴（sampler.py, CC0）、numpy 合成的刷声与汽笛。
"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, bp, lp, hp, noise, norm, t_, env_exp, brown, whoosh, creak, thump, click, limit

S.seed(7)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EVJ['dur']; EV = EVJ['ev']
B = [e['t'] for e in sorted([e for e in EV if e['type'] == 'beat'], key=lambda e: e['k'])]
E8 = 60 / 96 / 2
ev = lambda ty: [e for e in EV if e['type'] == ty]
one = lambda ty: ev(ty)[0]['t']
N = int(round((DUR + .5) * SR))
mus = np.zeros((N, 2), np.float32); fol = np.zeros((N, 2), np.float32); amb = np.zeros((N, 2), np.float32)
CUES = []   # 声音落点（给 tools/cuecheck.py）

STOP, HOUSE = one('stop'), one('house')

def put(buf, x, t, g=1., pan=0., tag=None):
    add(buf, x.astype(np.float32), t, g, pan)
    if tag: CUES.append({'t': round(t, 5), 'tag': tag})

def choke(x, t0, tend, rel=.06):
    """在 tend 处把音掐断（停车时音乐切断）"""
    n0 = int(round((tend - t0) * SR))
    if n0 < len(x):
        r = int(rel * SR); y = x.copy(); y[n0:n0 + r] *= np.linspace(1, 0, min(r, len(y) - n0)); y[n0 + r:] = 0; return y
    return x

def mb(p, t, vel=.6, pan=0., dur=2.6, tag=None, g=1.):
    x = P.pluck('music_box', p, dur, vel)
    if t < STOP < t + dur: x = choke(x, t, STOP)
    put(mus, x, t, .55 * g, pan, tag)

def smp(inst, p, t, dur, vel=.5, pan=0., g=1., tag=None, **kw):
    x = S.note(inst, p, dur, vel, **kw)
    if t < STOP < t + dur + 2: x = choke(x, t, STOP)
    put(mus, x, t, g, pan, tag)

# ================= 配乐（D 大调，96 BPM）=================
# 第 2 小节：六层透光，一层一个八音盒音（光＝音）
for i, (e, p) in enumerate(zip(ev('layer'), ['D5', 'F#5', 'A5', 'D6', 'F#6', 'A6'])):
    mb(p, e['t'], .5 + .05 * i, -.4 + .16 * i, tag=f'layer{i}')
mb('E6', B[7], .45, .2); mb('D6', B[7] + E8, .4, -.1)
for p in ['D4', 'A4']: smp('vibraphone_bowed', p, B[4], 2.3, .32, -.2 if p == 'D4' else .25, .5, attack=.6, release=.8)
smp('harp', 'D3', B[4], 2.4, .45, -.2, .7)

# 第 3–5 小节：和弦 Bm – G – A，旋律八音盒，竖琴分解，弓奏颤音琴垫底
CH = {3: (['B2', 'F#3', 'D4', 'F#3'], ['B3', 'D4', 'F#4']), 4: (['G2', 'D3', 'G3', 'B3', 'D4', 'B3', 'G3', 'D3'], ['G3', 'B3', 'D4']),
      5: (['A2', 'E3', 'A3', 'C#4', 'E4', 'C#4', 'A3', 'E3'], ['A3', 'C#4', 'E4'])}
for bar, (arp, pad) in CH.items():
    t0 = B[4 * (bar - 1)]; step = 60 / 96 if len(arp) == 4 else E8
    for j, p in enumerate(arp): smp('harp', p, t0 + j * step, 1.6, .38 + (.08 if j == 0 else 0), -.3 + .6 * (j % 2), .8)
    for p in pad: smp('vibraphone_bowed', p, t0, 2.5, .28, .1, .42, attack=.5, release=.5)
MEL = [(B[8], 'F#6', .62), (B[9], 'D6', .5), (B[10], 'B5', .58), (B[11], 'C#6', .5), (B[11] + E8, 'D6', .5),
       (B[12], 'B5', .6), (B[13], 'G5', .5), (B[14], 'A5', .55), (B[14] + E8, 'B5', .5), (B[15], 'D6', .58),
       (B[16], 'E6', .55), (B[18], 'C#6', .5), (B[19], 'E6', .55)]
for t, p, v in MEL: mb(p, t, v, .15, tag='mel')
# 第 5 小节：车窗一格一格亮 —— 钟琴一窗一音
for e, p in zip(ev('win'), ['A5', 'C#6', 'E6', 'A6', 'C#7', 'E7']):
    smp('glockenspiel', p, e['t'], 1.6, .42, -.35 + .14 * e['i'], .55, tag=f"win{e['i']}")
# 8.75 进隧道：一记手鼓单击（软）
put(mus, S.hit('frame_drum', 'large', .45), one('tunnel_in'), .5, 0, 'tunnel')
# 第 6 小节渐慢：G → A7sus4，13.9 停车时全部掐断
for p in ['G2', 'D3', 'B3']: smp('harp', p, B[20], 1.5, .45, -.2, .8)
mb('B5', B[20], .55, .1, tag='rit1')
for p in ['A2', 'D4', 'G4']: smp('harp', p, B[21], 1.5, .42, .2, .8)
mb('D6', B[21], .5, .1, tag='rit2'); mb('E6', B[21] + .375, .42, .1)
for p in ['G3', 'B3', 'D4']: smp('vibraphone_bowed', p, B[20], .66, .28, 0, .4, attack=.2, release=.3)
for p in ['A3', 'D4', 'G4']: smp('vibraphone_bowed', p, B[21], 1.0, .28, 0, .4, attack=.2, release=.3)

# 刷声（火车节奏，合成）：第 3 小节四分 → 第 4 小节八分 → 第 5 小节十六分 → 渐慢
def brush(v=1., d=.11):
    n = noise(d); tt = t_(d); e = np.minimum(1, tt / .006) * np.exp(-tt / (d * .32))
    return norm(bp(n, 1800, 7000) * e) * v
for e in ev('clack'):
    t = e['t']; strong = any(abs(t - b) < 1e-4 for b in B)
    put(mus, brush(.9 if strong else .55, .13 if strong else .08), t, .16 + .05 * e['d'], .25 if strong else -.25, 'brush')

# 第 7 小节 —— 静默后的第一声：八音盒高音 + 玻璃琴 + 暖垫
mb('A6', HOUSE, .9, 0, dur=3.2, tag='house', g=1.25)
smp('glass', 'D6', HOUSE, 2.6, .62, .2, .75); smp('glass', 'A5', HOUSE, 2.6, .55, -.2, .6)
smp('harp', 'D2', HOUSE, 3, .5, 0, .8)
for p in ['D4', 'F#4', 'A4']: smp('vibraphone_bowed', p, HOUSE, 3.4, .3, .1, .45, attack=1.0, release=1.2)
mb('F#6', one('door'), .6, .1, tag='door'); smp('harp', 'A3', one('door'), 1.5, .4, -.2, .7)
# 张臂：竖琴上行刮奏，最后一个音落在 16.25
ARMS = one('arms'); gl = ['D4', 'E4', 'F#4', 'G4', 'A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'A5', 'D6']
for j, p in enumerate(gl): smp('harp', p, ARMS - (len(gl) - 1 - j) * .024, 1.4, .36 + .03 * j, -.5 + j / len(gl), .62)
CUES.append({'t': ARMS, 'tag': 'arms_gliss_end'})
mb('D6', ARMS, .62, 0, tag='arms')
mb('E6', B[26], .5, .1); mb('F#6', B[26] + E8, .5, .1)
for p in ['G3', 'B3', 'D4']: smp('vibraphone_bowed', p, B[27], 1.3, .26, 0, .4, attack=.4, release=.6)
# 第 8 小节尾句：G – A – D
mb('B5', B[27], .6, -.1, tag='seal'); smp('harp', 'G2', B[27], 2, .42, -.2, .7)
mb('C#6', B[28], .5, .1); mb('E6', B[28] + E8, .48, .1); smp('harp', 'A2', B[28], 2, .38, .2, .7)
LAST = one('last')
for p, v in [('D6', .7), ('A5', .5)]: mb(p, LAST, v, 0, dur=3.0, tag='last')
for j, p in enumerate(['D3', 'A3', 'F#4', 'D5']): smp('harp', p, LAST + j * .03, 3, .42, -.3 + .2 * j, .7)
smp('glass', 'D5', LAST, 1.6, .45, 0, .5)
for p in ['D4', 'A4']: smp('vibraphone_bowed', p, LAST, 1.6, .24, 0, .38, attack=.3, release=.8)

mus = S.room(mus, size=.5, mix=.24)
# 停车后把混响尾巴也收掉：13.9 → 14.05 淡出，直到 15.0 之前音乐总线为零
g = np.ones(N, np.float32); a0, a1, a2 = int(STOP * SR), int((STOP + .15) * SR), int(HOUSE * SR) - 1
g[a0:a1] = np.linspace(1, 0, a1 - a0); g[a1:a2] = 0; mus *= g[:, None]

# ================= 环境 =================
def bed(x, t0, t1, g, fi=.4, fo=.4, pan=0.):
    n0, n1 = int(t0 * SR), int(t1 * SR); seg_ = x[:n1 - n0].copy(); L = len(seg_)
    e = np.ones(L); fiN = int(fi * SR); foN = int(fo * SR)
    e[:fiN] = np.linspace(0, 1, fiN)[:L] if fiN else 1; e[max(0, L - foN):] *= np.linspace(1, 0, min(foN, L))
    add(amb, (seg_ * e).astype(np.float32), t0, g, pan)
room_tone = lp(brown(DUR + .5), 260) * .9 + lp(noise(DUR + .5), 900) * .05
bed(room_tone, 0, DUR + .4, .035, fi=.05)
# 夜风（灯亮后）
wind = noise(DUR); wl = np.zeros_like(wind)
for i in range(0, len(wind), 4800):
    f = 500 + 300 * np.sin(i / SR * .7); seg_ = bp(wind[max(0, i - 4800):i + 4800], f * .6, f * 1.4)[-min(4800, len(wind) - i):]; wl[i:i + len(seg_)] = seg_
wl *= .6 + .4 * np.sin(np.arange(len(wl)) / SR * .9)
bed(wl, 2.6, STOP, .03, fi=1.2, fo=.25); bed(wl[int(4 * SR):], HOUSE, DUR, .022, fi=1.0, fo=1.0)
# 虫鸣（静默段关掉）
def crickets(t0, t1, g, seed):
    r = np.random.default_rng(seed); t = t0 + r.random() * .4
    while t < t1 - .2:
        d = .045; tt = t_(d); f = 4300 + r.random() * 500
        ch = np.sin(2 * np.pi * f * tt) * (np.abs(np.sin(2 * np.pi * 60 * tt)) ** 2) * np.sin(np.pi * tt / d)
        for k in range(3): add(amb, (ch * g).astype(np.float32), t + k * .07, 1, r.random() * 1.6 - .8)
        t += .5 + r.random() * .9
crickets(.3, 1.2, .006, 1); crickets(3.0, STOP - .3, .008, 2); crickets(HOUSE + .4, DUR, .009, 3)
# 隧道里的低轰
rum = lp(brown(4.0), 140)
bed(rum, one("tunnel_in"), one("tunnel_out") + .3, .07, fi=.35, fo=.35)

# ================= 拟音（逐个 EV）=================
def shimmer(d=1.2):
    tt = t_(d); x = sum(np.sin(2 * np.pi * f * (1 + .25 * tt / d) * tt) * a for f, a in [(880, .5), (1320, .35), (1760, .25), (2640, .15)])
    return norm(x * np.minimum(1, tt / .9) * np.exp(-np.maximum(0, tt - .9) * 6) + hp(noise(d), 5000) * .15 * tt / d)
def paper(d=.16, v=1., lo=1800, hi=6500):
    tt = t_(d); return norm(bp(noise(d), lo, hi) * np.sin(np.pi * tt / d) ** 1.5 * (1 + .5 * np.sin(2 * np.pi * 31 * tt))) * v
def rail(v=1., dark=0.):
    d = .07; tt = t_(d); x = hp(noise(d), 900) * env_exp(d, .004) + np.sin(2 * np.pi * 1850 * tt) * env_exp(d, .012) * .5 + np.sin(2 * np.pi * 140 * tt) * env_exp(d, .02) * .6
    x = norm(x); return lp(x, 4000 - 2800 * dark) * v
def whistle(d=.9, pitch=1.):
    tt = t_(d); bend = 1 - .04 * np.exp(-tt / .06); vib = 1 + .004 * np.sin(2 * np.pi * 6 * tt)
    x = sum(np.sin(2 * np.pi * f * pitch * bend * vib * tt) * a for f, a in [(587, .5), (740, .45), (880, .4), (1175, .12)])
    x += bp(noise(d), 600, 3000) * .35
    e = np.minimum(1, tt / .05) * np.minimum(1, (d - tt) / .15)
    return norm(x * e)
def squeal(d=.75):
    tt = t_(d); f = 2900 * (1 - .12 * tt / d); x = np.sin(2 * np.pi * np.cumsum(f * (1 + .01 * np.sin(2 * np.pi * 9 * tt))) / SR) + bp(noise(d), 2000, 5000) * .5
    return norm(x * np.minimum(1, tt / .15) * np.minimum(1, (d - tt) / .1) * (.6 + .4 * np.sin(2 * np.pi * 3 * tt)))
def hiss(d=.6):
    tt = t_(d); return norm(hp(noise(d), 2500) * np.exp(-tt / .17) * np.minimum(1, tt / .01))

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'click':
        put(fol, click(.55, 1.), t, .3, .1, 'click')
        put(fol, lp(click(.35), 2500), t + .012, .35, .1)
        put(fol, shimmer(1.25), t + .02, .07, -.1)
    elif ty == 'layer': put(fol, paper(.14, 1.), t, .07, -.5 + .2 * e['i'], f"paper{e['i']}")
    elif ty == 'whistle_far':
        w = lp(whistle(1.1, 1.0), 1800); put(fol, w, t, .07, -.25, 'whistle_far'); put(fol, lp(whistle(1.1), 1200), t + .18, .03, .3)
    elif ty == 'hop': put(fol, paper(.22, 1., 900, 3500), t, .06, .3 if e['i'] == 2 else -.3, 'hop')
    elif ty == 'clack':
        g = [.05, .09, .16][0 if e['d'] == 0 else 1 if e['d'] < 1 else 2]
        put(fol, rail(1., .8 if e['tun'] else (1 - e['d']) * .7), t, g, -.2, 'clack')
        put(fol, rail(.6, .9 if e['tun'] else .5), t + .055, g * .6, .2)
    elif ty == 'tunnel_in': put(fol, lp(whoosh(.7), 2500), t - .1, .2, .2, None); CUES.append({'t': t, 'tag': 'tunnel_in'})
    elif ty == 'win': put(fol, paper(.05, 1., 3000, 9000), t, .05, -.3 + .12 * e['i'])
    elif ty == 'tunnel_out': put(fol, whoosh(.5), t - .08, .16, .3)
    elif ty == 'whistle':
        put(fol, whistle(.32), t, .22, .2, 'whistle'); put(fol, whistle(.62), t + .4, .2, .2)
    elif ty == 'brake': put(fol, squeal(STOP - t), t, .06, .3, 'brake')
    elif ty == 'stop':
        put(fol, hiss(.6), t, .2, .35, 'stop'); put(fol, thump(.8, 85), t, .3, .2); put(fol, rail(1., .3), t + .02, .2, .1)
    elif ty == 'house':
        tt = t_(1.2); put(fol, norm(lp(noise(1.2), 600) * np.sin(np.pi * tt / 1.2) ** 2) , t, .03, .3, 'house_fol')
    elif ty == 'door': put(fol, creak(1.), t, .1, .35, 'door'); put(fol, creak(.6), t + .18, .06, .35)
    elif ty == 'arms': put(fol, paper(.28, 1., 1200, 5000), t, .08, .3, 'arms')
    elif ty == 'strip': put(fol, paper(.62, 1., 1500, 6000), t, .07, .3, 'strip')
    elif ty == 'seal': put(fol, thump(.9, 210), t, .15, .3, 'seal'); put(fol, paper(.06, 1., 2500, 8000), t, .08, .3)

# ================= 总线 =================
# 近静默：停车的汽声/车钩在 STOP+0.12 起 0.15 s 淡出；屋子底噪在静默段再压 10 dB（15.0 后 0.4 s 回来）
def gate(t0, t1, lo, fo, t2, fi):
    g = np.ones(N, np.float32); i0, i1, i2, i3 = (int(round(x * SR)) for x in (t0, t0 + fo, t2, t2 + fi))
    g[i0:i1] = np.linspace(1, lo, i1 - i0); g[i1:i2] = lo; g[i2:i3] = np.linspace(lo, 1, i3 - i2); return g[:, None]
fol *= gate(STOP + .12, None, 0., .15, HOUSE - .002, .002)
amb *= gate(STOP + .1, None, 10 ** (-10 / 20), .3, HOUSE, .4)
out = mus * 1.0 + fol * 1.0 + amb * 1.0
# 静默段核对：13.9 后 0.35 s 起到 15.0，只剩底噪
out = out[:int(round(DUR * SR))]
from core.audio.sfx import compress
out = np.stack([limit(compress(out[:, c], thr=.08, ratio=2.5, att=.002, rel=.12), .89) for c in (0, 1)], 1)
# 峰值管理：按 BS.1770 估出整体响度，把样本峰压到响度 +11.5 dB 以内，mux 拉到 −14 LUFS 后真峰仍 ≤ −1.2 dB
from scipy.signal import lfilter
def lufs(x):
    y = lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, .73248077421585], x, axis=0)
    y = lfilter([1, -2, 1], [1, -1.99004745483398, .99007225036621], y, axis=0)
    blk, hop = int(.4 * SR), int(.1 * SR)
    z = np.array([(y[i:i + blk] ** 2).mean(0).sum() for i in range(0, len(y) - blk, hop)])
    l = -.691 + 10 * np.log10(z + 1e-15); z = z[l > -70]; rel = -.691 + 10 * np.log10(z.mean()) - 10
    z = z[-.691 + 10 * np.log10(z) > rel]; return -.691 + 10 * np.log10(z.mean())
for _ in range(2):
    ceil = 10 ** ((lufs(out) + 11.5) / 20)
    out = np.stack([limit(out[:, c], ceil) for c in (0, 1)], 1)
print('估计响度', round(lufs(out), 1), 'LUFS，峰值', round(20 * np.log10(np.abs(out).max()), 1), 'dBFS')
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), out.astype(np.float32), SR)
for nm, x in [('music', mus), ('foley', fol), ('amb', amb)]: sf.write(os.path.join(HERE, 'out', f'stem_{nm}.wav'), x[:len(out)].astype(np.float32), SR)
json.dump(sorted(CUES, key=lambda c: c['t']), open(os.path.join(HERE, 'out', 'audio_cues.json'), 'w'), ensure_ascii=False, indent=0)
rms = lambda x: 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12)
a, b = int((STOP + .2) * SR), int(HOUSE * SR)
print('mix.wav', out.shape, 'peak', round(float(np.abs(out).max()), 3), 'rms', round(rms(out), 1), 'dB | 静默段 rms', round(rms(out[a:b]), 1), 'dB | 15.0 后 0.5 s rms', round(rms(out[b:b + SR // 2]), 1), 'dB')
