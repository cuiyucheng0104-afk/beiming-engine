"""《本周天气》配乐 + 拟音 → out/mix.wav（48 kHz 立体声；mux.sh 负责 −14 LUFS）
配乐：120 BPM D 小调新闻主题，拍网格与画面同源（events.json 里的 meta：bpm / t0，来自 timeline.js）。
编制取自 STYLE.md §8：跳弓小提琴 root-fifth-octave 八分音符、低音提琴拨弦、圆号长音、低通 16 分锯齿脉冲（numpy 合成）、
底鼓 1/3 拍、军鼓 2/4 拍；片头铜管齐奏 + 定音鼓；串联单每行钟琴；每次打勾一个铜管 hit；硬切与擦除定音鼓；
盖章后低音 drone；k31–k33 整拍静默；k33 全片最重一击；最后一条转 D 大调齐奏。合成弦（supersaw 低通）贯穿台风段与结尾。
运行：$LIB/.venv/bin/python mix.py"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, os.path.join(LIB, 'core/audio'))
import sfx as X
import sampler as S

SR = X.SR
S.seed(44)
X._rng = np.random.default_rng(44)
EVD = json.load(open(os.path.join(HERE, 'events.json')))
DUR, EV = EVD['dur'], EVD['ev']
META = next(e for e in EV if e['type'] == 'meta')
SPB = 60 / META['bpm']; T0 = META['t0']
def B(k): return round(T0 + k * SPB, 4)
N = int((DUR + 1.5) * SR)
music = np.zeros((N, 2), np.float32); fx = np.zeros((N, 2), np.float32); bed = np.zeros((N, 2), np.float32)
HITS = []                      # 音乐命中记录（cuecheck 用）

K_SIL0, K_SIL1 = 31, 33        # 静默：B(31)–B(33)

# —— 和声：小节线在 k = 1 + 4n ——
CH = {'Dm': [50, 53, 57], 'Bb': [46, 50, 53], 'Gm': [43, 46, 50], 'A': [45, 49, 52], 'C': [48, 52, 55], 'D': [50, 54, 57]}
def chord(k):
    if k < 9: return 'Dm'
    if k < 13: return 'Bb'
    if k < 17: return 'Gm'
    if k < 21: return 'A'
    if k < 25: return 'Dm'
    if k < 27: return 'Bb'
    if k < 29: return 'C'
    if k < 33: return 'A'
    if k < 35: return 'Bb'
    if k < 37: return 'C'
    if k < 38: return 'A'          # k37 属和弦（收束条推入）→ k38 主和弦齐奏
    return 'D'
def state(k):
    if k < 5: return 'sting'
    if k < 13: return 'run'
    if k < 17: return 'ty'
    if k < 21: return 'spec'
    if k < 23: return 'post'
    if k < 25: return 'recap'
    if k < 29: return 'fast'
    if k < K_SIL0: return 'recap'
    if k < K_SIL1: return 'sil'
    return 'final'

M = []
def ev(t, inst, pitch, dur, vel, pan=0, gain=1.0, **kw): M.append(dict(t=t, inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan, gain=gain, **kw))
def hit(name, k): HITS.append({'name': name, 'k': k, 't': B(k)})
def stab(k, notes, v=.9, d=.32, tuba=False, g=1.0):
    t = B(k)
    for ins, o, pan, gg in [('trumpet_stac', 12, .18, .85), ('horn_stac', 0, -.22, 1.0), ('trombone_stac', 0, .05, 1.0)]:
        for n in notes: ev(t, ins, n + o, d, v, pan, gg * g)
    if tuba: ev(t, 'tuba_stac', notes[0] - 12, d, v, 0, 1.0 * g)
def timp(k, p='D3', v=.85, g=1.0): ev(B(k), 'timpani', p, 1.2, v, 0, g); hit('timp', k)

# ============ 片头 ============
for i, p in enumerate([62, 65, 69, 74]): ev(0.0 + i * .02, 'violins_trem', p, .26, .3 + i * .05, (i - 1.5) * .2, .45, attack=.2)
stab(0, [62, 65, 69], .95, .55, tuba=True, g=.95); hit('stab_slam', 0)
timp(0, 'D3', .98, 1.3); ev(B(0), 'bass_drum', None, None, .95, 0, 1.2); ev(B(0), 'crash', None, None, .75, .1, .75)
ev(B(0), 'horn', 50, 2.2, .45, -.2, .6, attack=.05); ev(B(0), 'horn', 57, 2.2, .42, .2, .55, attack=.05)
for i, p in enumerate([86, 93]): ev(B(3) + i * .06, 'glockenspiel', p, .8, .5, .3 - i * .3, .7)
hit('glock_glint', 3)
ev(B(3), 'sus_cymbal', 'cresc', None, .5, 0, .35)          # 色带擦除前的镲片渐强
# 合成弦上滑（片头 → 串联单）
# ============ 主题（k5 起）============
for k8 in np.arange(5, 39, .5):                               # 八分音符网格
    k = float(k8); st = state(k); ch = CH[chord(k)]; t = B(k)
    off = (k - 1) % 4                                          # 小节内位置
    r, f5 = ch[0], ch[2]
    pat = [r + 24, f5 + 12, r + 36, f5 + 12]
    if st in ('run', 'ty', 'spec', 'recap'):
        v = .44 if k8 % 1 == 0 else .33
        ev(t, 'violins_spic', pat[int(k * 2) % 4] - (12 if st in ('ty', 'spec') else 0), .2, v, .25, .55)
    if st == 'fast':                                           # 加速：16 分
        for j in range(2):
            ev(t + j * SPB / 4, 'violins_spic', pat[(int(k * 4) + j) % 4], .14, .4 if j == 0 else .3, .25, .5)
    if k % 1 == 0 and st in ('run', 'ty', 'spec', 'recap', 'fast'):
        ev(t, 'contrabass_pizz', r - 12 if r >= 48 else r, .45, .75 if off == 0 else .52, -.1, .7)
    if k % 1 == 0 and st == 'post' and off in (0, 2):
        ev(t, 'contrabass_pizz', r - 12, .45, .6, -.1, .8)
# 圆号长音 / 小提琴震音 / drone
for kb in range(5, 31, 4):
    st = state(kb); ch = CH[chord(kb)]
    if st in ('run', 'recap', 'ty', 'spec'):
        ev(B(kb), 'horn', ch[1] + 12, 2.0, .32, -.25, .5, attack=.25); ev(B(kb), 'horn', ch[2], 2.0, .3, .25, .45, attack=.25)
    if st in ('ty', 'spec'):
        for j, p in enumerate(ch): ev(B(kb), 'violins_trem', p + 12, 2.0, .3, (j - 1) * .3, .38, attack=.4)
ev(B(25), 'horn', 58, 1.0, .35, -.25, .5, attack=.1); ev(B(27), 'horn', 60, 1.0, .35, -.25, .5, attack=.1); ev(B(29), 'horn', 61, 1.0, .35, -.25, .5, attack=.1)
ev(B(21), 'contrabass', 38, 2.0, .55, -.1, .8, attack=.05); ev(B(21), 'cellos', 50, 2.0, .5, .15, .6, attack=.05)   # 盖章后 drone
# 打击乐（底鼓用 numpy 合成，见下）
KICKS, HATS = [], []
for k8 in np.arange(5, 31, .25):
    k = float(k8); st = state(k); off = (k - 1) % 4
    if st in ('run', 'ty', 'spec', 'recap'):
        if off in (0, 2): KICKS.append((B(k), .9))
        if off in (1, 3): ev(B(k), 'snare2', 'on', None, .45, .05, .45)
        if k % .5 == 0 and st != 'run': HATS.append((B(k), .35 if k % 1 else .5))
    if st == 'fast':
        if k % 1 == 0: KICKS.append((B(k), 1.0))
        if off in (1, 3): ev(B(k), 'snare2', 'on', None, .55, .05, .55)
        HATS.append((B(k), .55 if k % .5 == 0 else .35))
    if st == 'post' and off == 0: KICKS.append((B(k), .7))
# 钟琴：串联单落行、打勾、NEXT
for k, p in zip([6, 7, 8], [81, 84, 86]): ev(B(k), 'glockenspiel', p, .8, .6, .2, .75); hit('glock_row', k)
for k in (11, 30): ev(B(k), 'glockenspiel', 81, .6, .38, .3, .5); hit('glock_next', k)
for k in (24, 29.5):
    ev(B(k), 'glockenspiel', 86, .9, .65, .25, .8); ev(B(k), 'glockenspiel', 93, .9, .55, -.2, .6)
    stab(k, CH[chord(k)][:1] + [CH[chord(k)][1] + 12, CH[chord(k)][2]], .78, .28); hit('stab_tick', k)
# 定音鼓：每次擦除、硬切、盖章
for k in (5, 13, 17, 23, 25, 27, 29): timp(k, 'D3' if k in (5, 13, 23, 29) else 'A2', .82, 1.05)
timp(21, 'D3', .9, 1.15); ev(B(21), 'bass_drum', None, None, .6, 0, .7)
stab(15, [50, 57], .7, .3, g=.8); hit('stab_name', 15)                       # 名字推上
ev(B(16), 'vibraphone_hard', 81, 1.2, .45, .3, .5)                            # 声纳之上的金属亮点
# ============ 静默后：全片最重一击（k33）→ D 大调 ============
stab(33, [58, 62, 65], 1.0, .8, tuba=True, g=1.8); hit('stab_flip', 33)
timp(33, 'F2', 1.0, 1.6); ev(B(33), 'bass_drum', None, None, 1.0, 0, 1.6); ev(B(33), 'crash', None, None, .95, -.1, 1.0); ev(B(33), 'gong', None, None, .7, .1, .55)
for p, pan in [(46, -.3), (53, .3), (58, -.1), (62, .2)]: ev(B(33), 'horn', p, 1.0, .6, pan, .6, attack=.02)
for p in (34, 46): ev(B(33), 'contrabass', p, 1.0, .7, 0, .8, attack=.01)
stab(34, [60, 64, 67], .5, .2, g=.5); timp(34, 'G3', .55, .55); hit('stab_delta', 34)
stab(35, [48, 55], .85, .4, tuba=True); timp(35, 'D3', .9, 1.2); ev(B(35), 'bass_drum', None, None, .8, 0, 1.0); hit('stab_stamp2', 35)
for p, pan in [(48, -.3), (55, .3), (64, -.1), (67, .2)]: ev(B(35), 'horn', p, 1.0, .5, pan, .55, attack=.05)
for k8 in np.arange(33, 38, .5):
    k = float(k8); ch = CH[chord(k)]; ev(B(k), 'violins_spic', [ch[0] + 24, ch[2] + 12, ch[0] + 36, ch[2] + 12][int(k * 2) % 4], .2, .42, .25, .5)
    if k % 1 == 0: ev(B(k), 'contrabass_pizz', ch[0] - 12, .45, .65, -.1, .85)
KICKS += [(B(35), 1.0)]
# k37：A 大调属和弦（收束条推入、角标闪光），三声钟琴随三个勾上行
stab(37, [57, 61, 64], .7, .35, g=.75); hit('stab_end', 37)
timp(37, 'A2', .7, .9)
for p, pan in [(45, -.3), (57, .3), (61, -.1), (64, .15)]: ev(B(37), 'horn', p, .5, .45, pan, .5, attack=.03)
for k, p in zip([37.25, 37.5, 37.75], [81, 85, 88]): ev(B(k), 'glockenspiel', p, .6, .5, .2, .6); hit('glock_done', k)
KICKS += [(B(37), .8)]
# k38：D 大调齐奏收束（三格同时亮起）
stab(38, [62, 66, 69], .9, .9, tuba=True, g=.8); hit('stab_button', 38)          # 比 k33 轻：静默后那一击保持全片最重
timp(38, 'D3', .9, 1.0); ev(B(38), 'crash', None, None, .75, .1, .65); ev(B(38), 'bass_drum', None, None, .8, 0, .8); KICKS += [(B(38), .8)]
for p, pan in [(50, -.35), (57, .35), (62, -.15), (66, .15), (69, 0)]: ev(B(38), 'horn', p, 1.6, .58, pan, .62, attack=.03)
for p in (38, 50): ev(B(38), 'contrabass', p, 1.6, .6, 0, .7, attack=.02)
for i, p in enumerate([86, 90, 93, 98]): ev(B(38) + i * SPB / 4, 'glockenspiel', p, 1.0, .55, .3 - i * .2, .65)

# 起音补偿：逐个（乐器, 音高）实测 10% 起音延迟，提前放置，让发声前沿正好落在拍点
LAT = {}
for m_ in M:
    key = (m_['inst'], m_['pitch'])
    if key in LAT: continue
    y = S.render([(0.2, m_['inst'], m_['pitch'], .3, .8, 0)], dur=.8, master=False).mean(1); e = np.abs(y)
    LAT[key] = max(0.0, (np.argmax(e > e.max() * .1) / SR) - .2)
S.seed(44)
for m_ in M: m_['t'] = max(0.0, m_['t'] - LAT[(m_['inst'], m_['pitch'])])
print('onset comp ms: max %.1f' % (1000 * max(LAT.values())))
print('sampler events', len(M))
mus = S.render(M, dur=N / SR, master=False)
music[:len(mus)] += mus[:N]

# —— numpy 合成层 ——
tt = np.arange(N) / SR
def hz(m): return 440 * 2 ** ((m - 69) / 12)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def place(buf, x, t, g=1.0, pan=0.0): X.add(buf, x.astype(np.float32), t, g, pan)
# 底鼓：正弦下扫 120→45 Hz + 二次谐波（小喇叭上也能听到）
def kick(v):
    d = .32; q = np.arange(int(d * SR)) / SR; f = 45 + 75 * np.exp(-q * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-q * 9) + .35 * np.sin(2 * ph) * np.exp(-q * 14) + X.hp(X.noise(d), 3000) * np.exp(-q * 120) * .25) * v
for t, v in KICKS: place(music, kick(v), t, .38)
def hat(v):
    d = .05; q = np.arange(int(d * SR)) / SR
    return X.hp(X.noise(d), 7000, 4) * np.exp(-q * 70) * v
for t, v in HATS: place(music, hat(v), t, .26, .3)
# 16 分锯齿脉冲（低通 900 Hz），run / ty / spec / recap / fast
def saw(f, d):
    q = np.arange(int(d * SR)) / SR; return 2 * ((q * f) % 1) - 1
for k8 in np.arange(5, 31, .25):
    k = float(k8); st = state(k)
    if st not in ('run', 'ty', 'spec', 'recap', 'fast'): continue
    r = CH[chord(k)][0]; f = hz(r - 12 if r >= 48 else r)
    d = SPB / 4 * .9; q = np.arange(int(d * SR)) / SR
    x = lp(saw(f, d) + .6 * saw(f * 2.003, d), 900) * np.exp(-q * 14)
    place(music, x, B(k), .16 * (1.15 if (k * 4) % 2 == 0 else .8), .15 if (k * 4) % 2 else -.15)
# 合成弦（supersaw 7 声部微失谐，低通，慢起）
def synstr(notes, t0, d, g, att=.35, rel=.4, cut=2400):
    n = int((d + rel) * SR); q = np.arange(n) / SR; y = np.zeros(n)
    for m in notes:
        for j, dt in enumerate(np.linspace(-.12, .12, 7)):
            ph = (q * hz(m) * 2 ** (dt / 12) + hash_(m * 7 + j)) % 1; y += 2 * ph - 1
    y = lp(y / (len(notes) * 7), cut, 2)
    e = np.minimum(1, q / att) * np.where(q < d, 1, np.exp(-(q - d) / (rel / 4)))
    l = y * e; place(music, l, t0, g, -.35); place(music, l[::-1][::-1] * .9, t0 + .011, g, .35)
def hash_(n): return (np.sin(n * 127.1 + 311.7) * 43758.5453) % 1
synstr([62, 65, 69, 74], B(1), B(5) - B(1), .22, att=1.6, cut=1800)                 # 片头上滑铺底
for kb in (13, 17):
    ch = CH[chord(kb)]; synstr([c + 12 for c in ch], B(kb), 2.0, .2, cut=2000)
synstr([50, 57, 62], B(21), 1.0, .2, att=.05, cut=1500)
synstr([58, 62, 65], B(25), 1.0, .2, att=.1); synstr([60, 64, 67], B(27), 1.0, .2, att=.1); synstr([61, 64, 69], B(29), .98, .2, att=.1)
synstr([58, 62, 65, 70], B(33), 1.0, .3, att=.01, cut=3000); synstr([60, 64, 67, 72], B(35), 1.0, .28, att=.05, cut=3000)
synstr([57, 61, 64, 69], B(37), .5, .24, att=.05, rel=.1, cut=2800); synstr([62, 66, 69, 74], B(38), 1.5, .3, att=.02, rel=.9, cut=3200)
# k33 低频冲击（sub boom），带 2、3 次谐波
q = np.arange(int(1.4 * SR)) / SR; f = 38 + 30 * np.exp(-q * 6); ph = 2 * np.pi * np.cumsum(f) / SR
place(music, (np.sin(ph) + .4 * np.sin(2 * ph) + .2 * np.sin(3 * ph)) * np.exp(-q * 3.2), B(33), .5); hit('boom', 33)

music = S.room(music, size=.38, mix=.14)
# 低频平衡：20–120 Hz 压低约 3.5 dB（TECHNIQUE §5），并切掉 35 Hz 以下
for c in range(2):
    low = sosfilt(butter(2, 120, 'low', fs=SR, output='sos'), music[:, c]); music[:, c] -= .33 * low
    music[:, c] = sosfilt(butter(2, 35, 'high', fs=SR, output='sos'), music[:, c])
# 静默：B(31)–B(33) 整体抽空（30 ms 斜坡），之后重新进入
a0, a1 = int(B(K_SIL0) * SR), int(B(K_SIL1) * SR)
fade = int(.03 * SR)
g = np.ones(N, np.float32); g[a0:a1] = 0; g[a0 - fade:a0] = np.linspace(1, 0, fade)
music *= g[:, None]

# ============ 拟音（由 window.EV 驱动）============
def flap(v=1.0):
    d = .035; q = np.arange(int(d * SR)) / SR
    x = X.bp(X.noise(d), 1600, 6000) * np.exp(-q * 260) + np.sin(2 * np.pi * 950 * q) * np.exp(-q * 160) * .5 + np.sin(2 * np.pi * 180 * q) * np.exp(-q * 90) * .4
    return X.norm(x) * v
def ping(v=1.0):
    d = 1.2; q = np.arange(int(d * SR)) / SR; x = np.sin(2 * np.pi * 1320 * q) * np.exp(-q * 4.5)
    y = x.copy(); s = int(.23 * SR); y[s:] += x[:-s] * .4; s2 = int(.46 * SR); y[s2:] += x[:-s2] * .16
    return y * v
def stampfx(v=1.0):
    th = X.thump(1, 58); cl = X.lp(X.clack(.7), 2500)
    out = np.zeros(max(len(th), len(cl))); out[:len(th)] += th; out[:len(cl)] += cl * .6; return out * v
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'swish': place(fx, X.whoosh(.26, 1), max(0, t - .02), .5 * e.get('v', 1), -.3)
    elif ty == 'slam': place(fx, X.thump(1, 55), t, .8); place(fx, X.lp(X.clack(.6), 3000), t, .35)
    elif ty == 'letter': place(fx, X.click(.8 + e['i'] * .12), t, .32, -.2 + e['i'] * .13)
    elif ty == 'wordmark': place(fx, X.whoosh(.3, 1), t - .26, .2)
    elif ty == 'glint': place(fx, X.ding(1), t, .12, .3)
    elif ty == 'whoosh': d = e.get('d', .35); place(fx, X.whoosh(d, 1), t, .5, -.2)
    elif ty == 'bugland': place(fx, X.click(1.1), t, .3, .6)
    elif ty == 'wipe': place(fx, flap(1), t, .25, .4)
    elif ty == 'row': place(fx, flap(1), t, .45, .3)
    elif ty == 'hl': place(fx, X.pop(1), t, .18, .3)
    elif ty == 'count':
        for j in range(6): place(fx, X.click(1.6), t - .4 + j * .08, .15, -.4)
    elif ty == 'next': place(fx, X.pop(1), t, .22, .4)
    elif ty == 'dim': place(fx, X.whoosh(.2, 1), t - .18, .1)
    elif ty == 'strapin': place(fx, X.click(.9), t, .3, -.5); place(fx, X.pop(1), t, .14, -.5)     # 分类标签闪白
    elif ty == 'key': place(fx, X.click(1.7), t, .1, .4)
    elif ty == 'typed': place(fx, X.click(1.3), t, .22, .4)
    elif ty == 'name': place(fx, X.whoosh(.25, 1), t - .23, .3, .4)
    elif ty == 'sonar': place(fx, ping(1), t, .3, -.1)
    elif ty == 'cut': place(fx, X.thump(.5, 75), t, .3)
    elif ty == 'title': place(fx, X.whoosh(.22, 1), t - .2, .2)
    elif ty == 'thr': place(fx, X.click(1.4), t, .25)
    elif ty == 'roll': place(fx, X.click(1.9), t, .16, -.2)
    elif ty == 'bar': place(fx, X.clack(1), t, .2, -.2)
    elif ty == 'badge': place(fx, X.pop(1), t, .3, .1)
    elif ty == 'cell': place(fx, X.click(1 + e['i'] * .15), t, .35, .4)
    elif ty == 'stamp': place(fx, stampfx(1), t, .75)
    elif ty == 'chip': place(fx, X.hp(X.whoosh(.2, 1), 1500), t - .18, .3, .4)
    elif ty == 'sweep': place(fx, X.ding(1), t, .07, -.3); place(fx, X.hp(X.whoosh(.3, 1), 2000), t - .05, .15, -.3)
    elif ty == 'tick':
        place(fx, X.click(1.2), t, .45, .3)
        if e.get('double'): place(fx, X.click(1.05), t, .4, -.1)
    elif ty == 'insert': place(fx, flap(1), t, .4, .35)
    elif ty == 'presstick': place(fx, X.click(1.8), t, .14, -.35)
    elif ty == 'press': place(fx, X.hp(X.whoosh(.25, 1), 1200), t - .26, .22, -.35); place(fx, X.clack(1), t, .55, -.35)
    elif ty == 'donetick': place(fx, X.click(1.2 + e['i'] * .1), t, .7, -.2 + e['i'] * .3)
    elif ty == 'button': place(fx, X.thump(1, 60), t, .35); place(fx, X.ding(1), t, .1, .4)
    elif ty == 'measure': place(fx, X.whoosh(.32, 1), t - .3, .4, -.2)
    elif ty == 'label': place(fx, X.pop(1), t, .3, .3)
    elif ty == 'flip': place(fx, flap(1), t, .6)
    elif ty == 'flap':
        for j in range(e['n']): place(fx, flap(.8 + .2 * X._rng.random()), t + j * .006, .22, -.6 + j * .2)
    elif ty == 'settle': place(fx, X.clack(1), t, .4, -.4 + e['i'] * .4)
    elif ty == 'delta': place(fx, X.thump(1, 65), t, .6, .5)
    elif ty == 'stamp2': place(fx, stampfx(1), t, .8, .4)
    elif ty == 'rule': place(fx, X.whoosh(.22, 1), t - .2, .18, .5); place(fx, X.click(1.5), t, .3, .5)
# 环境床
def bedsnd(name, d):
    d = round(d * SR) / SR; q = X.t_(d); n = len(q)
    if name == 'room': x = X.lp(X.brown(d), 500) * .04
    elif name == 'storm': x = X.lp(X.brown(d), 900) * (.6 + .4 * np.sin(2 * np.pi * .6 * q)) * .5
    elif name == 'wind': x = X.bp(X.noise(d), 300, 2200) * (.5 + .5 * np.sin(2 * np.pi * 1.3 * q) ** 2) * .22
    elif name == 'hiss': x = X.hp(X.noise(d), 4000) * .05 + X.lp(X.brown(d), 300) * .15
    elif name == 'ticks':
        x = np.zeros(n)
        for j in range(int(d / (SPB / 4))):
            c = X.click(2.2, .5 + .5 * X._rng.random()); s = int(j * SPB / 4 * SR); x[s:s + len(c)] += c[:n - s] * .25
    e = np.minimum(1, q / .08) * np.minimum(1, (d - q) / .08)
    return x * e
for e in EV:
    if e['type'] == 'bed': place(bed, bedsnd(e['name'], e['t1'] - e['t']), e['t'], 1.0 if e['name'] != 'room' else .7)

mix = (music * .85 + fx * .9 + bed * .55) * .55
# 母带：+11.5 dB → 3:1 压缩（链接立体声，阈值 −10 dBFS）→ 前瞻限幅 0.82，峰值/响度比 ≤ 12 dB，mux 拉到 −14 LUFS 时真峰值不超 −1.2 dB
mix *= 10 ** (11.5 / 20)
lk = np.abs(mix).max(axis=1); envl = np.zeros_like(lk); aa, rr = np.exp(-1 / (.003 * SR)), np.exp(-1 / (.15 * SR)); e_ = 0.0
for i in range(len(lk)):
    c_ = lk[i]; e_ = aa * e_ + (1 - aa) * c_ if c_ > e_ else rr * e_ + (1 - rr) * c_; envl[i] = e_
thr = 10 ** (-12 / 20); gr = np.where(envl > thr, (thr * (envl / thr) ** (1 / 3)) / np.maximum(envl, 1e-9), 1.0)
mix *= gr[:, None]
from scipy.signal import resample_poly
up = np.abs(resample_poly(mix, 4, 1, axis=0)).max(axis=1)[:len(mix) * 4]   # 4× 过采样测真峰值
pk = np.maximum(np.abs(mix).max(axis=1), up.reshape(-1, 4).max(axis=1))
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
n_ = int(.005 * SR); gl = np.minimum(1, .82 / np.maximum(maximum_filter1d(pk, 2 * n_ + 1), 1e-9)); gl = uniform_filter1d(minimum_filter1d(gl, 2 * n_ + 1), n_)
mix *= gl[:, None]
mix = mix[:int(DUR * SR)]
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out/mix.wav'), mix, SR, subtype='PCM_24')
sf.write(os.path.join(HERE, 'out/music.wav'), (music * .85)[:int(DUR * SR)], SR, subtype='PCM_24')
json.dump(HITS, open(os.path.join(HERE, 'out/hits.json'), 'w'), indent=1)
print('mix', mix.shape, 'peak', float(np.abs(mix).max()))
print('\n'.join(S.credits(sorted({m['inst'] for m in M}))))
