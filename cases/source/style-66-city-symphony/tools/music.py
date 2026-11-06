"""配乐（原创）：加法简约主义的"城市交响"。从 timeline.json 的整数帧拍点生成，和画面共用一张表。
乐器：VSCO 2 CE / VCSL 真实采样（CC0）——马林巴、小提琴拨奏/跳弓、大提琴跳弓/拨奏、柔音与全管风琴、管风琴踏板、
     圆号、长笛断奏、大鼓、吊镲、钟琴；pluck.py 物理建模竖琴拨弦（熄灯的下行音）；numpy 合成电子脉冲。
结构：八分琶音 → 三连音压八分 → 十六分全奏 → 刹车（琶音全停成一个 Fmaj9 长和弦）→ 近乎静默 → 全管风琴重音 →
     十六分 + 圆号对 → 闪回 → 减速 → 硬停（干声 15 ms 切断，只留混响）→ 最后一盏灯的钟琴。
输出：out/music.wav（48 kHz 立体声）、out/score.json（每个音的起点，给 cuecheck 用）。
用法：python tools/music.py"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, lp, hp

TL = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS = TL['FPS']; NF = TL['NF']; DUR = NF / FPS
BEATS = {(b['bar'], b['beat']): b for b in TL['BEATS']}
S.seed(66)


def F(bar, beat=1, frac=0.0):
    b = BEATS[(bar, beat)]; return int(np.floor(b['f'] + frac * b['len'] + .5))   # 与 JS Math.round 一致


def tb(bar, beat=1, frac=0.0): return F(bar, beat, frac) / FPS
def blen(bar, beat=1): return BEATS[(bar, beat)]['len'] / FPS


EV = []        # 采样乐器事件
EXTRA = []     # (t, mono 数组, gain, pan) —— 合成或 pluck
ON = []        # 起点记录


BARGAIN = {1: .78, 2: .82, 3: 1.12, 4: 1.3, 5: 1.45}     # 早高峰逐小节变响（加法织体之外再推一把）


def bg(t):
    f = t * FPS; g = 1.0
    for (bar, beat), b in BEATS.items():
        if beat == 1 and b['f'] <= f + 1e-6 and bar in BARGAIN: g = BARGAIN[bar]
    return g if f < BEATS[(6, 1)]['f'] - 1e-6 else 1.0


def ev(t, inst, pitch, dur, vel, pan=0, gain=1.0, tag='', **kw):
    EV.append(dict(t=t, inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan, gain=gain * bg(t), **kw))
    ON.append(dict(t=round(t, 6), f=round(t * FPS, 4), inst=inst, tag=tag))


def extra(t, x, gain, pan, inst, tag=''):
    EXTRA.append((t, x, gain * bg(t), pan)); ON.append(dict(t=round(t, 6), f=round(t * FPS, 4), inst=inst, tag=tag))


# ── 电子脉冲（numpy）：两只微失谐锯齿 + 随包络关上的低通 ──
def pulse_note(midi, d=.16, bright=1800, v=1.0):
    n = int(d * SR); t = np.arange(n) / SR; f = 440 * 2 ** ((midi - 69) / 12)
    saw = sum(2 * ((t * f * c) % 1) - 1 for c in (1.0, 1.0035, .9965)) / 3
    env = np.minimum(1, t / .002) * np.exp(-t / (d * .38))
    x = saw * env
    # 简单的时变低通：分两段混合
    x = .65 * lp(x, bright) + .35 * lp(x, bright * .35)
    return (hp(x, 60) * v).astype(np.float32)


CH = {   # 琶音音 + 低音
    1: (['A3', 'E4', 'B4', 'C5'], 'A1'), 2: (['F3', 'C4', 'E4', 'A4'], 'F1'), 3: (['G3', 'C4', 'D4', 'E4'], 'C2'),
    4: (['G3', 'C4', 'D4', 'G4'], 'G1'), 5: (['A3', 'C4', 'E4', 'A4'], 'A1'),
    7: (['A4', 'C5', 'E5', 'B5'], 'A1'), 8: (['F4', 'A4', 'C5', 'E5'], 'F1'),
}
CH4b = (['G3', 'B3', 'D4', 'G4'], 'G1'); CH8b = (['G4', 'B4', 'D5', 'G5'], 'G1')


def chord_of(bar, beat):
    if bar == 4 and beat >= 3: return CH4b
    if bar == 8 and beat >= 3: return CH8b
    return CH[bar]


def arp(bar, per_beat, pat, inst, vel, pan, gain, octv=0, beats=(1, 2, 3, 4), tag='arp'):
    k = 0
    for bt in beats:
        tones = chord_of(bar, bt)[0]
        for j in range(per_beat):
            p = pat[k % len(pat)]; k += 1
            t = tb(bar, bt, j / per_beat)
            ev(t, inst, S.midi(tones[p % 4]) + 12 * (octv + p // 4), blen(bar, bt) / per_beat * .9, vel, pan, gain, tag=tag)


def cresc_to(t_peak, vel=.6, gain=1.0, pan=0):
    """吊镲渐强：把采样的峰对准 t_peak"""
    x = S.hit('sus_cymbal', 'cresc', vel)
    pk = int(np.argmax(np.convolve(np.abs(x), np.ones(480) / 480, 'same')))
    t0 = t_peak - pk / SR
    EXTRA.append((max(0, t0), x[max(0, int(-t0 * SR)):] if t0 < 0 else x, gain, pan))
    ON.append(dict(t=round(t_peak, 5), f=round(t_peak * FPS, 3), inst='sus_cymbal', tag='cresc_peak'))


# ════ 1–2 黎明：开场重音 + 马林巴八分琶音 + 拨奏 + 柔音管风琴垫 ════
ev(0, 'bass_drum', None, None, .7, 0, .9, tag='hit')
ev(0, 'organ_soft', 'A2', 4.4, .55, -.1, .55, tag='hit', attack=.02)
for p in ['E3', 'B3', 'C4']: ev(0, 'organ_soft', p, 2.2, .5, .15, .35, tag='hit')
ev(0, 'organ_pedal', 'A1', 2.3, .6, 0, .6, tag='hit')
ev(tb(2), 'organ_soft', 'F2', 2.3, .5, -.1, .5, tag='downbeat', attack=.15)
for p in ['C3', 'A3', 'E4']: ev(tb(2), 'organ_soft', p, 2.3, .45, .15, .32, tag='downbeat', attack=.15)
ev(tb(2), 'organ_pedal', 'F1', 2.3, .55, 0, .55, tag='downbeat')
for bar in (1, 2):
    arp(bar, 2, [0, 1, 2, 1, 3, 2, 1, 2], 'marimba', .62, -.25, .9)
    for bt in (1, 2, 3, 4):
        ev(tb(bar, bt), 'violins_pizz', S.midi(chord_of(bar, bt)[0][0]) + 12, .3, .55, .3, .55, tag='beat')
ev(tb(1, 2), 'marimba', 'A5', .6, .72, -.05, .7, tag='title')           # 标题落定
# 第 2 小节后半：电子脉冲先进来两拍，悬镲推进第 3 小节
for j in range(4):
    extra(tb(2, 3, j / 2) if j < 2 else tb(2, 4, (j - 2) / 2), pulse_note(45, .14, 1200, .5), .35, 0, 'pulse')
cresc_to(tb(3), .55, .7, .2)

# ════ 3 早高峰：+ 大提琴跳弓八分 + 脉冲八分 ════
ev(tb(3), 'bass_drum', None, None, .62, 0, .8, tag='downbeat')
ev(tb(3), 'organ_pedal', 'C2', 4 * blen(3), .55, 0, .55, tag='downbeat')
arp(3, 2, [0, 1, 2, 3, 2, 1, 2, 3], 'marimba', .64, -.25, .9)
for bt in (1, 2, 3, 4):
    for j in range(2):
        t = tb(3, bt, j / 2)
        ev(t, 'cellos_spic', S.midi(chord_of(3, bt)[1]) + 12, .18, .66, .2, .8, tag='eighth')
        extra(t, pulse_note(48, .13, 1500, .55), .32, 0, 'pulse')
    ev(tb(3, bt), 'violins_pizz', S.midi(chord_of(3, bt)[0][1]) + 12, .3, .55, .3, .5, tag='beat')

# ════ 4：+ 小提琴跳弓三连音压在八分上（3:2）════
ev(tb(4), 'organ_pedal', 'G1', 4 * blen(4), .55, 0, .55, tag='downbeat')
arp(4, 2, [0, 1, 2, 3, 2, 1, 2, 3], 'marimba', .66, -.25, .9)
for bt in (1, 2, 3, 4):
    tones = chord_of(4, bt)[0]
    for j in range(3):
        ev(tb(4, bt, j / 3), 'violins_spic', S.midi(tones[(j + 1) % 4]) + 12, .14, .58, .35, .5, tag='triplet')
    for j in range(2):
        t = tb(4, bt, j / 2)
        ev(t, 'cellos_spic', S.midi(chord_of(4, bt)[1]) + 12, .16, .68, .2, .8, tag='eighth')
        extra(t, pulse_note(43, .12, 1700, .6), .34, 0, 'pulse')
cresc_to(tb(5), .6, .75, -.2)

# ════ 5 网格：全编制十六分 ════
ev(tb(5), 'bass_drum', None, None, .7, 0, .85, tag='downbeat')
ev(tb(5), 'organ_pedal', 'A1', 4 * blen(5), .6, 0, .6, tag='downbeat')
arp(5, 4, [0, 1, 2, 3, 2, 1, 3, 2], 'marimba', .66, -.2, .85)
arp(5, 4, [2, 3, 1, 3], 'flute_stac', .42, .35, .3, octv=1)
for bt in (1, 2, 3, 4):
    for j in range(4):
        t = tb(5, bt, j / 4)
        extra(t, pulse_note(45 + (12 if j == 2 else 0), .1, 2000, .6), .34, 0, 'pulse')
        if j % 2 == 0: ev(t, 'cellos_spic', 'A2', .14, .7, .2, .8, tag='eighth')
    for j in range(3): ev(tb(5, bt, j / 3), 'violins_spic', S.midi(['C5', 'E5', 'A5'][j]), .12, .55, .35, .45, tag='triplet')
cresc_to(tb(6), .7, .8, .1)

# ════ 6 刹车：琶音全停，一个 Fmaj9 长和弦，然后近乎静默 ════
hold = tb(6, 3) - tb(6) - .1
ev(tb(6), 'organ_soft', 'F2', hold, .6, -.1, .55, tag='brake', release=.45)
for p, g in [('C3', .4), ('A3', .38), ('E4', .34), ('G4', .3)]: ev(tb(6), 'organ_soft', p, hold, .55, .15, g, tag='brake', release=.45)
ev(tb(6), 'violins', 'E5', hold, .4, .3, .3, tag='brake', attack=.05, release=.5)
ev(tb(6), 'violins', 'G5', hold, .35, -.3, .22, tag='brake', attack=.05, release=.5)
ev(tb(6), 'cellos', 'F2', hold, .45, .1, .35, tag='brake', release=.5)
ev(tb(6), 'flute', 'A5', hold * .9, .35, .25, .22, tag='brake', release=.4)

# ════ 7 入夜：全管风琴重音（静默后第一声）════
ev(tb(7), 'organ', 'A2', 1.3, .95, -.1, .7, tag='night_hit')
for p in ['E3', 'A3', 'C4', 'E4']: ev(tb(7), 'organ', p, 1.3, .9, .12, .5, tag='night_hit')
ev(tb(7), 'organ_pedal', 'A1', tb(8) - tb(7) + .1, .8, 0, .85, tag='night_hit')
ev(tb(7), 'gran_cassa', 'hit', None, .9, 0, 1.0, tag='night_hit')
ev(tb(7), 'crash', None, None, .55, .2, .45, tag='night_hit')
ev(tb(7), 'horn', 'A3', tb(8) - tb(7), .55, -.3, .5, tag='horn', attack=.12)
ev(tb(7), 'horn', 'E4', tb(8) - tb(7), .5, .3, .45, tag='horn', attack=.12)
for bar in (7, 8):
    arp(bar, 4, [0, 1, 2, 3, 2, 1, 3, 2], 'marimba', .68, -.2, .85, beats=(1, 2, 3, 4) if bar == 7 else (1, 2))
    for bt in ((1, 2, 3, 4) if bar == 7 else (1, 2, 3, 4)):
        for j in range(4):
            t = tb(bar, bt, j / 4)
            bass = S.midi(chord_of(bar, bt)[1]) + 24
            extra(t, pulse_note(bass + (12 if j == 2 else 0), .1, 2200, .65), .36, 0, 'pulse')
        for j in range(2):
            ev(tb(bar, bt, j / 2), 'violins_spic', S.midi(chord_of(bar, bt)[0][j * 2]), .14, .6, .35, .45, tag='eighth')
ev(tb(8), 'organ_pedal', 'F1', tb(8, 3) - tb(8), .7, 0, .7, tag='downbeat')
ev(tb(8, 3), 'organ_pedal', 'G1', tb(9) - tb(8, 3), .7, 0, .7, tag='flash')
ev(tb(8), 'horn', 'F3', tb(8, 3) - tb(8), .55, -.3, .5, tag='horn')
ev(tb(8), 'horn', 'C4', tb(8, 3) - tb(8), .5, .3, .45, tag='horn')
ev(tb(8, 3), 'horn', 'G3', tb(9) - tb(8, 3), .62, -.3, .55, tag='horn')
ev(tb(8, 3), 'horn', 'D4', tb(9) - tb(8, 3), .6, .3, .5, tag='horn')
ev(tb(8), 'bass_drum', None, None, .6, 0, .7, tag='downbeat')
# 闪回两拍：马林巴每十六分、最后一拍跟着每 2 帧的剪切连击
for k, bt in enumerate((3, 4)):
    for j in range(4):
        ev(tb(8, bt, j / 4), 'marimba', S.midi(CH8b[0][(j + k) % 4]) + 12, .08, .7, -.2, .75, tag='flash16')
for j in range(6):
    t = (F(8, 4) + 2 * j) / FPS
    ev(t, 'violins_spic', S.midi(['G5', 'D5', 'B4', 'G4', 'D4', 'B3'][j]), .07, .62, .3, .4, tag='flash2f')
ev(tb(8, 3), 'gran_cassa', 'roll', tb(9) - tb(8, 3), .55, 0, .55, tag='flash')
cresc_to(tb(9), .75, .9, 0)

# ════ 9 熄灯：减速，每拍一个下行拨弦 ════
ev(tb(9), 'gran_cassa', 'hit', None, .65, 0, .8, tag='dean')
ev(tb(9), 'organ_soft', 'E2', tb(10) - tb(9), .55, -.1, .5, tag='dean')
for p, g in [('C3', .35), ('G3', .3), ('E4', .26)]: ev(tb(9), 'organ_soft', p, tb(9, 3) - tb(9), .5, .15, g, tag='dean')
for p, g in [('D3', .35), ('F3', .3), ('C4', .26)]: ev(tb(9, 3), 'organ_soft', p, tb(10) - tb(9, 3), .45, .15, g, tag='dean')
ev(tb(9), 'cellos_pizz', 'E2', 1.0, .7, .1, .7, tag='dean')
ev(tb(9, 3), 'cellos_pizz', 'D2', 1.0, .65, .1, .65, tag='light_off')
for bt, p in zip((1, 2, 3, 4), ['E5', 'D5', 'C5', 'A4']):
    t = tb(9, bt)
    extra(t, P.pluck('harp', p, 1.6, .7), .55, -.15, 'pluck_harp', 'light_off' if bt > 1 else 'dean')
    ev(t, 'violins_pizz', p, .4, .55, .2, .45, tag='light_off' if bt > 1 else 'dean')
    ev(t, 'marimba', S.midi(p) - 12, .3, .5, -.25, .55, tag='light_off' if bt > 1 else 'dean')
# 脉冲逐拍变稀：第 1 拍八分，第 2 拍四分，之后停
for j in range(2): extra(tb(9, 1, j / 2), pulse_note(40, .14, 1200, .45), .28, 0, 'pulse')
extra(tb(9, 2), pulse_note(40, .16, 900, .35), .24, 0, 'pulse')

# ════ 渲染 ════
N = int((DUR + 2.5) * SR)
dry = S.render(EV, dur=N / SR, master=False)
for t, x, g, pan in EXTRA: add(dry, x, t, g, pan)
# 硬停：第 10 小节强拍，干声 15 ms 内切断；混响由切断后的信号产生 → 只剩尾巴
i0 = int(round(tb(10) * SR)); fade = int(.015 * SR)
dry[i0:i0 + fade] *= np.linspace(1, 0, fade)[:, None]; dry[i0 + fade:] = 0
body = S.room(dry, size=.7, mix=.28)
ON.append(dict(t=round(tb(10), 5), f=float(F(10)), inst='ALL', tag='hard_stop'))
# 尾声：最后一盏灯 —— 一声钟琴 + 极弱的未解决 Fmaj7/A
coda = []
t_last = tb(10, 2)
coda.append(dict(t=t_last, inst='glockenspiel', pitch='A6', dur=1.2, vel=.42, pan=.15, gain=.6))
for p, g in [('A2', .3), ('F3', .26), ('C4', .22), ('E4', .2)]:
    coda.append(dict(t=t_last, inst='organ_soft', pitch=p, dur=1.6, vel=.35, pan=-.1, gain=g, attack=.08))
ON.append(dict(t=round(t_last, 5), f=float(F(10, 2)), inst='glockenspiel', tag='last'))
cw = S.room(S.render(coda, dur=N / SR, master=False), size=.78, mix=.36)
mix = body + cw
mix = mix[:int(np.ceil(DUR * SR))]
fo = int(.12 * SR); mix[-fo:] *= np.linspace(1, 0, fo)[:, None]
pk = np.abs(mix).max(); mix = mix / pk * .89
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'music.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
json.dump(sorted(ON, key=lambda o: o['t']), open(os.path.join(HERE, 'out', 'score.json'), 'w'), indent=0, ensure_ascii=False)
print(f'music.wav {len(mix) / SR:.3f} s, {len(EV)} 采样音 + {len(EXTRA)} 合成/拨弦, peak→-1 dBFS')
