"""《落成之夜》原创配乐：1929 年的 hot jazz / 交响爵士小乐队，144 BPM，E♭ 大调。
真实采样（core/audio/sampler.py）+ 拨弦物理建模（pluck.py 班卓）+ numpy 合成（单簧管滑音的时变重采样）。
所有拍点来自 ../timeline.json。输出：out/score.wav、out/stems/*.wav、music/score.json（每个画面事件对应的音乐落点）。
运行：$LIB/.venv/bin/python music/score.py"""
import sys, os, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); PROJ = os.path.dirname(HERE)
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@'); sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add
from scipy.signal import butter, sosfilt

S.seed(1929); rng = np.random.default_rng(1929)
TL = json.load(open(os.path.join(PROJ, 'timeline.json')))
B, DUR, HIT, FLOORS, SPARKS = TL['B'], TL['DUR'], TL['HIT'], TL['FLOORS'], TL['SPARKS']
N = int(round((DUR + .2) * SR))
bt = lambda b: b * B
sw = lambda b: np.floor(b) + (2 / 3 if abs(b - np.floor(b) - .5) < 1e-6 else b - np.floor(b))   # 摇摆八分（只用于不卡画面的音）
M = S.midi
def buf(): return np.zeros((N, 2), np.float32)
ST = {k: buf() for k in ['reeds', 'brass', 'rhythm', 'drums', 'perc', 'party']}
USED, KEYS = set(), {}
def key(name, b): KEYS[name] = round(bt(b), 6)

# 持续音采样起音慢：提前一点放，让“听感起点”落在网格上
LEAD = {'clarinet': .1, 'trombone': .03, 'trumpet': .025, 'alto_sax': .04, 'tenor_sax_nv': .04, 'trumpet_mute': .015}
def onset(x):              # 采样的听感起点：平滑包络首次超过峰值 10% 的位置（≤120 ms）
    e = np.convolve(np.abs(x[:int(.4 * SR)]), np.ones(48) / 48, 'same'); return min(.12, int(np.argmax(e > .1 * e.max())) / SR) if e.max() > 0 else 0
def nt(st, b, inst, pitch, beats, vel=.7, pan=0., gain=1., **kw):
    USED.add(inst); x = S.note(inst, pitch, beats * B, vel, **kw); add(ST[st], x, max(0, bt(b) - onset(x)), gain, pan); return x
def ht(st, b, inst, var=None, vel=.7, pan=0., gain=1., dur=None):
    USED.add(inst); x = S.hit(inst, var, vel, dur); add(ST[st], x, max(0, bt(b) - onset(x)), gain, pan); return x
def chord(st, b, inst, pitches, beats, vel=.7, pan=0., gain=1., spread=.5, **kw):
    n = len(pitches)
    for i, p in enumerate(pitches): nt(st, b, inst, p, beats, vel * (1 - .04 * i), pan + (i - (n - 1) / 2) / max(1, n - 1) * spread, gain, **kw)
def banjo(st, b, pitches, vel=.6, beats=.45, gain=1., up=False):
    USED.add('pluck:banjo'); x = P.strum('banjo', pitches, beats * B, vel, spread=.012, up=up); add(ST[st], x, bt(b), gain, .28)

# ---------- 单簧管滑音：多源时变重采样（每 5 个半音一个源，交叉淡化），曲线 = 画面金线的绘制进度 ----------
def gliss(st, b0, b1, p0, p1, curve, vel=.7, hold=1.0, pan=-.15, gain=1.):
    USED.add('clarinet')
    d = bt(b1 - b0) + hold * B; n = int(d * SR); tt = np.arange(n) / SR
    u = np.clip(tt / bt(b1 - b0), 0, 1); pt = p0 + (p1 - p0) * curve(u)          # 目标音高（MIDI，连续）
    bases = np.arange(p0, p1 + 5, 5.0); out = np.zeros(n)
    wsum = np.zeros(n)
    for q in bases:
        w = np.clip(1 - np.abs(pt - q) / 5.0, 0, 1)
        if w.max() <= 0: continue
        ratio = 2 ** ((pt - q) / 12); ph = np.cumsum(ratio) - ratio[0]
        src = S.note('clarinet', float(q), ph[-1] / SR + .5, vel, release=.2)
        y = np.interp(ph, np.arange(len(src)), src)
        out += y * w; wsum += w
    out /= np.maximum(wsum, 1e-6)
    env = np.minimum(1, tt / .05) * np.clip(1 - (tt - (d - .15)) / .15, 0, 1) * (.75 + .25 * u)
    add(ST[st], (out * env).astype(np.float32), bt(b0) - LEAD['clarinet'], gain, pan)

# ---------- 合成刷子 ----------
def swish(st, b, v=.4, beats=.6, pan=.15):
    n = int(beats * B * SR); x = sosfilt(butter(2, [1800, 9000], 'band', fs=SR, output='sos'), rng.standard_normal(n))
    tt = np.arange(n) / SR; d = n / SR; env = np.minimum(1, tt / (d * .5)) * np.exp(-np.maximum(0, tt - d * .5) / (d * .2))
    add(ST[st], (x * env * .16 * v).astype(np.float32), bt(b), 1, pan)

# ---------- 和弦（低音根音, 中声部） ----------
CH = {
    'Eb6': ('Eb2', ['G3', 'C4', 'Eb4', 'Bb3']), 'Cm7': ('C2', ['G3', 'Bb3', 'Eb4']), 'Fm7': ('F2', ['Ab3', 'C4', 'Eb4']),
    'Bb7': ('Bb1', ['Ab3', 'D4', 'F4']), 'Ab6': ('Ab1', ['Ab3', 'C4', 'F4']), 'Ab9': ('Ab1', ['Gb3', 'C4', 'Eb4', 'Bb3']),
    'EbG': ('G1', ['G3', 'Bb3', 'Eb4']), 'EbBb': ('Bb1', ['G3', 'Bb3', 'Eb4']), 'Bb13': ('Bb1', ['Ab3', 'D4', 'G4']),
}
BANJO = {'Eb6': ['Bb3', 'Eb4', 'G4', 'C5'], 'Cm7': ['Bb3', 'Eb4', 'G4', 'C5'], 'Fm7': ['Ab3', 'C4', 'Eb4', 'F4'], 'Bb7': ['Ab3', 'D4', 'F4', 'Bb4'],
         'Ab6': ['Ab3', 'C4', 'Eb4', 'F4'], 'Ab9': ['Gb3', 'C4', 'Eb4', 'Bb4'], 'EbG': ['G3', 'Bb3', 'Eb4', 'G4'], 'EbBb': ['Bb3', 'Eb4', 'G4', 'Bb4'], 'Bb13': ['Ab3', 'D4', 'G4', 'Bb4']}
def ride(b0, b1, vel=.32, st='drums'):        # 摇摆 ride：每拍 + 2、4 拍后的摇摆八分
    b = b0
    while b < b1 - 1e-6:
        ht(st, b, 'drum_kit', 'ride_left', vel * (1.1 if int(b) % 2 else .9), .35, .55)
        if int(b) % 2 == 1: ht(st, b + 2 / 3, 'drum_kit', 'ride_left', vel * .7, .35, .5)
        b += 1

# ======================= A 刻线（b0–b10） =======================
ht('rhythm', 0, 'jazz_bass', 'Eb1', .8, -.05, 1.2); key('ignite', 0)
ht('perc', 0, 'gran_cassa', 'hit', .35, 0, .7)
# 悬镲渐强：峰值对齐 b4
cr = S.hit('sus_cymbal', 'cresc', .55); USED.add('sus_cymbal'); pk = int(np.argmax(np.abs(cr)))
s0 = pk - int(bt(4) * SR); seg_ = cr[max(0, s0):pk + int(.05 * SR)].copy(); seg_[-int(.05 * SR):] *= np.linspace(1, 0, int(.05 * SR))
add(ST['perc'], seg_.astype(np.float32), max(0, -s0 / SR), .55, .2)
# 单簧管：b0 低音起，b0→b4 两个八度滑音，曲线与金线完全一致（seg^2.1），落在 B♭5
gliss('reeds', 0, 4, M('Eb4'), M('Bb5'), lambda u: u ** 2.1, vel=.75, hold=1.6, gain=1.6)
# b4 立面展开：铜管和弦
def stab(b, tp, tb, bass, vel=.8, beats=.5, crash=0, name=None):
    for i, p in enumerate(tp): nt('brass', b, 'trumpet_stac', p, beats, vel * (1 - .06 * i), .18 - .12 * i)
    for i, p in enumerate(tb): nt('brass', b, 'trombone_stac', p, beats, vel * .9 * (1 - .05 * i), -.2 + .1 * i)
    if bass: ht('rhythm', b, 'jazz_bass', bass, .85, -.05, 1.1)
    if crash: ht('drums', b, 'crash', None, crash, .1, .55)
    if name: key(name, b)
stab(4, ['Eb5', 'C5', 'G4'], ['Bb3', 'G3', 'Eb3'], 'Eb1', .9, .6, crash=.5, name='unfold')
ht('drums', 4, 'bass_drum', None, .55, 0, .9); nt('brass', 4, 'tuba_stac', 'Eb2', .6, .7, 0, .8)
# 三级退台：主题前四个音藏在顶声部（E♭–G–B♭–C）
stab(5, ['G5', 'Eb5'], ['C4', 'G3', 'C3'], 'C2', .7, .45, name='step1')
stab(6, ['Bb5', 'F5'], ['Eb4', 'C4', 'Ab3'], 'Ab1', .75, .45, name='step2')
stab(7, ['C6', 'Ab5'], ['Eb4', 'C4', 'F3'], 'F1', .82, .45, name='step3')
for b in (5, 6, 7): ht('drums', b, 'snare2', 'stick', .35, .1, .6)
ride(4, 8, .26)
for b in (5, 7): ht('drums', b, 'hihat', 'pedal', .4, -.2, .6)
# b8 楼冠：B♭7 长音 + 竖琴上行刮奏（加速）+ 每根光芒一记钟琴
chord('brass', 8, 'trombone', ['F3', 'Ab3', 'D4'], 2, .45, 0, .8); ht('rhythm', 8, 'jazz_bass', 'Bb1', .7, -.05, 1.0)
arp = [n for o in range(2, 7) for n in (f'Bb{o}', f'D{o + 1}' if False else f'D{o}', f'F{o}', f'Ab{o}')]
arp = sorted({M(x) for x in arp if M('Bb2') <= M(x) <= M('Bb6')})
for i, m in enumerate(arp):
    u = i / (len(arp) - 1); b = 8 + 1.9 * (u ** .75)
    nt('perc', b, 'harp', m, 1.5, .5 + .25 * u, -.3 + .6 * u, .8)
for i, (b, p) in enumerate(zip([8, 8.5, 9, 9.5], ['Bb5', 'D6', 'F6', 'Ab6'])):
    nt('perc', b, 'glockenspiel', p, 1.2, .55 + .08 * i, .25, .8); key(f'ray{i}', b)
ht('drums', 8, 'sus_cymbal', 'roll', .3, .1, .35, dur=bt(2))

# ======================= B 攀升（b10–b20）：groove，分拍加速 =======================
PROG_B = [(10, 'Eb6'), (12, 'Eb6'), (14, 'Cm7'), (16, 'Fm7'), (18, 'Bb7')]
def chord_at(b, prog):
    c = prog[0][1]
    for pb, name in prog:
        if b + 1e-6 >= pb: c = name
    return c
bassB = [(10, 'Eb2'), (11, 'G2'), (12, 'Bb2'), (13, 'G2'), (14, 'C2'), (15, 'Eb2'), (16, 'F2'), (17, 'Ab2'), (18, 'Bb1'), (18.5, 'Bb1'), (19, 'C2'), (19.5, 'D2')]
for i, (b, p) in enumerate(bassB):
    nb = bassB[i + 1][0] if i + 1 < len(bassB) else 20
    nt('rhythm', b, 'jazz_bass', p, (nb - b) * .92, .78 if b == int(b) else .7, -.05, 1.05)
for b in np.arange(10, 18, 1.0):
    banjo('rhythm', b, BANJO[chord_at(b, PROG_B)], .62 if int(b) % 2 else .48, .4)
for b in np.arange(18, 20, .5):
    banjo('rhythm', b, BANJO['Bb7'], .55 + .1 * (b - 18), .3, up=bool((b * 2) % 2))
ride(10, 18, .3)
for b in (11, 13, 15, 17, 19): ht('drums', b, 'hihat', 'pedal', .45, -.2, .65); ht('drums', b, 'snare2', 'taps', .3, .1, .45)
for b in (10, 12, 14, 16): swish('drums', b, .5, 1.6)
# 木琴计数：每格一级，音阶上行（一束光 = 一个音）
XY = ['Eb5', 'F5', 'G5', 'Ab5', 'Bb5', 'C6', 'D6', 'Eb6', 'F6', 'G6', 'Bb6']
for i, (b, lab) in enumerate(FLOORS):
    nt('perc', b, 'xylophone', XY[i], .8, .62 + .03 * i, .2, .95); key(f'floor{i}', b)
key('cutDial', HIT['cutDial'])
# 弱音小号：主题前三个音（伏笔）
for b, p, d in [(12, 'Eb5', .9), (13, 'G5', .9), (14, 'Bb5', 1.7)]: nt('brass', b, 'trumpet_mute', p, d, .62, -.25, 1.0)
nt('brass', 15.67, 'trumpet_mute', 'G5', .3, .5, -.25, .8); nt('brass', 16, 'trumpet_mute', 'F5', 1.4, .52, -.25, .85)
# 长号软垫
for b, name in [(12, 'Eb6'), (14, 'Cm7'), (16, 'Fm7')]: chord('brass', b, 'trombone', CH[name][1][:2], 1.9, .32, -.1, .55)
# 分拍加速：铜管八分音符半音阶冲刺 + 军鼓八分
for i, b in enumerate(np.arange(18, 20, .5)):
    nt('brass', b, 'trumpet_stac', ['D5', 'Eb5', 'E5', 'F5'][i], .45, .6 + .07 * i, .15)
    nt('brass', b, 'alto_sax', ['Bb4', 'C5', 'C#5', 'D5'][i], .42, .5 + .06 * i, -.15, .8)
    nt('brass', b, 'trombone_stac', ['F3', 'G3', 'Ab3', 'A3'][i], .45, .55 + .07 * i, -.25)
    ht('drums', b, 'snare2', 'stick', .3 + .1 * i, .1, .6)
# b20 叮：stop-time
stab(20, ['G5', 'Eb5', 'Bb4'], ['D4', 'Bb3', 'Eb3'], 'Eb1', .78, .3)
nt('perc', 20, 'tubular_bells', 'Eb5', 3, .75, .1, 1.0); nt('perc', 20, 'glockenspiel', 'Eb6', 2, .6, .2, .7); nt('perc', 20, 'vibraphone_hard', 'Bb5', 2.5, .55, -.2, .7)
key('ding', 20)

# ======================= C 门（b20–b28） =======================
# 门后的乐队（低通，越来越近）：B♭7 上的 vamp
partyB = [(21, 'Bb1'), (22, 'D2'), (23, 'F2'), (23.5, 'Ab2')]
for i, (b, p) in enumerate(partyB): nt('party', b, 'jazz_bass', p, .9, .8, 0, 1.1)
for b in (21, 22, 23, 23.5): banjo('party', b, BANJO['Bb7'], .6, .4)
for b in (21, 22, 23): ht('party', b, 'drum_kit', 'ride_left', .35, .2, .6)
for b, p in [(21.67, 'D5'), (22.67, 'F5'), (23.5, 'Ab5')]: nt('party', b, 'trumpet_stac', p, .4, .65, .1, .9)
for b in (21, 22, 23): nt('party', b, 'upright', 'Bb2', .8, .5, -.2, .8); nt('party', b + .5, 'upright', 'Ab3', .4, .4, -.1, .6); nt('party', b + .5, 'upright', 'D4', .4, .4, -.1, .6)
x = S.hit('snare', 'roll', .6); USED.add('snare'); seg2 = x[:int(bt(2) * SR)] * np.linspace(.15, 1, int(bt(2) * SR)) ** 2
add(ST['party'], seg2.astype(np.float32), bt(22), .7, .1)
# 门闩：定音鼓一下、两下（我们这一侧，不滤波）
ht('perc', 22, 'timpani', 'drum2', .65, -.1, 1.0); ht('perc', 23, 'timpani', 'drum2', .8, .1, 1.1); key('latch1', 22); key('latch2', 23)
ht('drums', 22, 'bass_drum', None, .4, 0, .7); ht('drums', 23, 'bass_drum', None, .5, 0, .8)
# b24 全奏
def tutti(b, tp, sx, tb, bass, beats, vel=.9, crash=.0, bd=0, stac=False):
    ti = 'trumpet_stac' if stac else 'trumpet'; bi = 'trombone_stac' if stac else 'trombone'
    for i, p in enumerate(tp): nt('brass', b, ti, p, beats, vel * (1 - .05 * i), .22 - .14 * i, 1.0)
    for i, p in enumerate(sx): nt('reeds', b, 'alto_sax' if i < 2 else 'tenor_sax_nv', p, beats, vel * .8, -.3 + .2 * i, .8)
    for i, p in enumerate(tb): nt('brass', b, bi, p, beats, vel * .85, -.25 + .12 * i, .95)
    if bass: ht('rhythm', b, 'jazz_bass', bass, .9, -.05, 1.15); nt('brass', b, 'tuba_stac', bass[:-1] + str(int(bass[-1]) + 1), .6, .75, 0, .8)
    if crash: ht('drums', b, 'crash', None, crash, .15, .7)
    if bd: ht('drums', b, 'bass_drum', None, bd, 0, 1.0)
tutti(24, ['Bb5', 'G5', 'F5'], ['C5', 'Bb4', 'G4'], ['Eb4', 'C4', 'G3', 'Eb3'], 'Eb1', .95, .78, crash=.7, bd=.7)
nt('reeds', 24, 'clarinet', 'Eb6', .9, .7, -.4, .7); ht('perc', 24, 'gran_cassa', 'hit', .55, 0, .8)
banjo('rhythm', 24, BANJO['Eb6'], .75, .5); chord('rhythm', 24, 'upright', ['Eb2', 'Eb3', 'G3', 'Bb3', 'C4'], .9, .7, -.1, .8)
key('doorsOpen', 24)
tutti(25.5, ['Bb5', 'Gb5', 'Eb5'], ['C5', 'Bb4', 'Gb4'], ['C4', 'Ab3', 'Gb3'], 'Ab1', .45, .8, stac=True)
banjo('rhythm', 25.5, BANJO['Ab9'], .65, .4)
tutti(26, ['Bb5', 'G5', 'Eb5'], ['C5', 'Bb4', 'G4'], ['C4', 'G3', 'Eb3'], 'G1', .9, .9, crash=.55, bd=.6); key('doorsStop', 26)
banjo('rhythm', 26, BANJO['EbG'], .7, .5)
tutti(27, ['G5', 'D5', 'Ab4'], ['F5', 'C5', 'Ab4'], ['Ab3', 'D3', 'Bb2'], 'Bb1', .3, .95, crash=.0, bd=.7, stac=True); key('cutoff', 27)
ht('drums', 27, 'snare2', 'stick', .7, .1, .8)
ride(24, 27, .38)
ht('drums', 25, 'snare2', 'stick', .5, .1, .7)
# b27.3 → b32：静默（只有混音里的风与火箭）

# ======================= E 万花筒（b32–b46）：主题完整陈述 =======================
PROG_E = [(32, 'Eb6'), (34, 'Ab9'), (36, 'EbG'), (38, 'Ab6'), (39, 'Bb7'), (40, 'EbBb'), (41, 'Eb6'), (42, 'Ab6'), (43, 'Bb13'), (44, 'Eb6')]
MEL = [(32, 'Eb5', 1), (33, 'G5', .6), (33.67, 'Bb5', .33), (34, 'C6', 1.6), (35.67, 'Bb5', .33),
       (36, 'G5', .45), (36.5, 'Bb5', .45), (37, 'G5', .45), (37.5, 'Bb5', .45), (38, 'Ab5', .45), (38.5, 'C6', .45), (39, 'Ab5', .45), (39.5, 'C6', .45),
       (40, 'Bb5', 2), (42, 'C6', .9), (43, 'Bb5', .45), (43.5, 'G5', .45)]
TONES = {'Eb6': [3, 7, 10, 0], 'Ab9': [8, 0, 3, 6, 10], 'EbG': [3, 7, 10], 'Ab6': [8, 0, 3, 5], 'Bb7': [10, 2, 5, 8], 'EbBb': [3, 7, 10], 'Bb13': [10, 2, 8, 7], 'Eb6x': [3, 7, 10, 0]}
def below(m, name, k):    # 旋律下方第 k 个和弦音
    tones = TONES[name]; c = m - 1; got = 0
    while c > m - 24:
        if c % 12 in tones: got += 1
        if got == k: return c
        c -= 1
    return m - 12
for b, p, d in MEL:
    m = M(p); name = chord_at(b, PROG_E); short = d < .5
    nt('brass', b, 'trumpet_stac' if short else 'trumpet', m, d, .86, .12, 1.0)
    nt('brass', b, 'trumpet_stac' if short else 'trumpet', m, d, .7, -.12, .55)
    nt('reeds', b, 'clarinet', m + 12 if m + 12 <= M('F#6') else m, d, .6, -.35, .5)
    nt('reeds', b, 'alto_sax', min(below(m, name, 1), M('G#5')), d, .7, -.2, .75)
    nt('reeds', b, 'tenor_sax_nv', below(m, name, 2), d, .66, .25, .7)
# 长号背景 + 每朵烟花一记
for b, name, d in [(32, 'Eb6', 2), (34, 'Ab9', 2), (36, 'EbG', 2), (38, 'Ab6', 1), (39, 'Bb7', 1), (40, 'EbBb', 1), (41, 'Eb6', 1), (42, 'Ab6', 1), (43, 'Bb13', 1)]:
    chord('brass', b, 'trombone', CH[name][1][:3], d * .95, .62 if b in (32, 34, 36, 40) else .5, -.1, .85)
key('burst1', 32); key('burst2', 34); key('burst3', 36); key('lock', 40)
# 低音：行走 + 大号两拍
walkE = [(32, 'Eb2'), (33, 'G2'), (34, 'Ab2'), (35, 'Gb2'), (36, 'G2'), (37, 'Bb2'), (38, 'Ab2'), (39, 'Bb2'), (40, 'Bb1'), (41, 'Eb2'), (42, 'Ab1'), (43, 'Bb1')]
for b, p in walkE: nt('rhythm', b, 'jazz_bass', p, .92, .8, -.05, 1.1)
for b in (32, 34, 36, 38, 40, 42): nt('brass', b, 'tuba_stac', CH[chord_at(b, PROG_E)][0], .7, .7, 0, .75)
for b in np.arange(32, 44, 1.0):
    name = chord_at(b, PROG_E); banjo('rhythm', b, BANJO[name], .66 if int(b) % 2 else .55, .42)
    if int(b) % 2 == 1: chord('rhythm', b, 'upright', CH[name][1], .45, .45, .1, .55)
    else: nt('rhythm', b, 'upright', CH[name][0][:-1] + str(int(CH[name][0][-1]) + 1), .8, .5, -.1, .55)
# 鼓：b32–b36 摇摆 ride + 反拍；b36–b40 直八分“满”；b40 起回到 ride
ride(32, 36, .4); ride(40, 44, .36)
for b in (33, 35, 41, 43): ht('drums', b, 'snare2', 'stick', .55, .1, .7); ht('drums', b, 'hihat', 'pedal', .5, -.2, .6)
for i, b in enumerate(np.arange(36, 40, .5)):
    ht('drums', b, 'snare2', 'stick', .35 + .06 * i, .1, .7); ht('drums', b, 'hihat', 'closed', .4 + .04 * i, -.25, .55)
for i, b in enumerate(SPARKS): nt('perc', b, 'glockenspiel', ['G6', 'Bb6', 'G6', 'Bb6', 'Ab6', 'C7', 'Ab6'][i], .5, .45, .3, .55); key(f'spark{i}', b)
# 第一朵：全片最重要的一声
ht('drums', 32, 'bass_drum', None, 1.0, 0, 1.5); ht('perc', 32, 'gran_cassa', 'hit', 1.0, 0, 1.4); ht('perc', 32, 'gong', None, .7, 0, .9)
ht('drums', 32, 'crash', None, .9, .15, .8); nt('perc', 32, 'timpani', 'Eb2', 2, .9, 0, 1.0); chord('rhythm', 32, 'upright', ['Eb1', 'Eb2', 'G3', 'Bb3', 'Eb4'], 1.5, .8, 0, .8)
for b, v in [(34, .75), (36, .85)]:
    ht('drums', b, 'bass_drum', None, v, 0, 1.0); ht('drums', b, 'crash', None, v * .8, -.15 if b == 34 else .2, .7); ht('perc', b, 'gran_cassa', 'hit', v * .7, 0, .8)
# b40 咬合：锣 + 镲 + 大鼓 + 钟琴
ht('perc', 40, 'gong', None, .6, 0, .8); ht('drums', 40, 'crash', None, .85, 0, .8); ht('drums', 40, 'bass_drum', None, .85, 0, 1.0)
nt('perc', 40, 'glockenspiel', 'Bb6', 1.5, .7, .2, .7); nt('perc', 40, 'tubular_bells', 'Bb4', 3, .6, -.2, .8)
# b40 咬合加厚：铜管 + 萨克斯长和弦（全奏层），定音鼓
tutti(40, ['G5', 'Eb5'], ['G4', 'Eb4', 'Bb3'], ['Bb3', 'G3', 'Eb3'], None, 1.9, .82)
nt('perc', 40, 'timpani', 'Bb2', 1.5, .85, 0, 1.0)
# b42 光泽：竖琴上行刮奏 + 悬镲渐强到 b44
harp = sorted({M(f'{n}{o}') for o in range(3, 8) for n in ('Eb', 'G', 'Bb', 'C') if M('Eb4') <= M(f'{n}{o}') <= M('Eb7')})
for i, m in enumerate(harp):
    u = i / (len(harp) - 1); nt('perc', 42 + 1.3 * (u ** .8), 'harp', m, 1.2, .5 + .3 * u, -.4 + .8 * u, .85)
key('sheen', 42)
cr2 = S.hit('sus_cymbal', 'cresc', .5); pk2 = int(np.argmax(np.abs(cr2))); s2 = pk2 - int(bt(2) * SR)
add(ST['perc'], cr2[s2:pk2].astype(np.float32), bt(42), .45, -.15)
# b44 收尾 button + 余响
tutti(44, ['Bb5', 'G5', 'F5'], ['C5', 'Bb4', 'G4'], ['Eb4', 'C4', 'G3', 'Eb3'], 'Eb1', .5, 1.0, crash=1.0, bd=.95, stac=True)
nt('reeds', 44, 'clarinet', 'Eb6', .45, .75, -.4, .7); banjo('rhythm', 44, BANJO['Eb6'], .8, .6)
chord('rhythm', 44, 'upright', ['Eb1', 'Eb2', 'Bb2', 'G3', 'C4', 'F4'], 2, .75, 0, .8)
nt('perc', 44, 'tubular_bells', 'Eb5', 4, .8, .15, 1.0); nt('perc', 44, 'glockenspiel', 'Eb6', 3, .6, .25, .6); ht('perc', 44, 'gran_cassa', 'hit', .7, 0, .9)
ht('perc', 44, 'gong', None, .75, 0, 1.0); nt('perc', 44, 'timpani', 'Eb2', 2, .9, 0, 1.0)
nt('brass', 44.5, 'trombone', 'Eb3', 1.4, .6, -.2, .7); nt('brass', 44.5, 'trombone', 'Bb3', 1.4, .55, -.05, .6); nt('brass', 44.5, 'trumpet', 'G5', 1.4, .55, .2, .55)
key('final', 44)
# 单簧管颤音（E♭6 / F6）余响
for i, b in enumerate(np.arange(44.5, 45.9, 1 / 6)):
    nt('reeds', b, 'clarinet', 'Eb6' if i % 2 == 0 else 'F6', 1 / 6 + .02, .42 * (1 - i / 10), -.35, .55)

# ---------------- 门后乐队：时变低通（随门闩逐步打开） ----------------
def lp_sweep(x, keys):
    bands = [250, 450, 800, 1400, 2600, 6000]; outs = []
    for f in bands: sos = butter(4, f, 'low', fs=SR, output='sos'); outs.append(np.stack([sosfilt(sos, x[:, 0]), sosfilt(sos, x[:, 1])], 1))
    outs.append(x)
    tt = np.arange(len(x)) / SR; kt = [bt(k[0]) for k in keys]; kv = [np.log(k[1]) for k in keys]
    lc = np.interp(tt, kt, kv); lb = np.log(np.array(bands + [16000.]))
    idx = np.clip(np.searchsorted(lb, lc) - 1, 0, len(lb) - 2); fr = np.clip((lc - lb[idx]) / (lb[idx + 1] - lb[idx]), 0, 1)
    y = np.zeros_like(x); stk = np.stack(outs)
    for j in range(len(lb) - 1):
        m = idx == j; y[m] = stk[j][m] * (1 - fr[m])[:, None] + stk[j + 1][m] * fr[m][:, None]
    return y
ST['party'] = lp_sweep(ST['party'], [(20, 260), (21.9, 300), (22.05, 520), (22.95, 620), (23.05, 1100), (23.8, 2400), (24, 16000)]).astype(np.float32) * 1.2

# ---------------- 汇总 ----------------
os.makedirs(os.path.join(PROJ, 'out/stems'), exist_ok=True)
mix = sum(ST.values())
a_, b_ = int(bt(27.4) * SR), int(bt(32) * SR) - int(.006 * SR)
mix[a_:b_] *= np.linspace(1, 0, b_ - a_)[:, None] ** 8   # 切断后的尾音迅速收干；b32 之前绝对安静（只留混音里的风与火箭）
mix[b_ - int(.4 * SR):b_] = 0; mix[b_:b_ + int(.006 * SR)] *= np.linspace(0, 1, int(.006 * SR))[:, None]
for k, v in ST.items(): sf.write(os.path.join(PROJ, f'out/stems/{k}.wav'), v, SR)
pk = np.abs(mix).max(); mix = mix / pk * .85 if pk > .85 else mix
sf.write(os.path.join(PROJ, 'out/score.wav'), mix, SR)
json.dump({'keys': KEYS, 'used': sorted(USED)}, open(os.path.join(HERE, 'score.json'), 'w'), indent=1, ensure_ascii=False)
print('score', round(len(mix) / SR, 2), 's · peak', round(float(pk), 3), '· keys', len(KEYS), '· instruments', len(USED))
