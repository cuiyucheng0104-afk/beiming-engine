"""《见龙》全片配乐（代码配乐：真实乐器采样 sampler.py + 物理建模拨弦 pluck.py）
输出 music/score.wav：194.5 s，48 kHz 立体声，24 bit，峰值 −3 dBFS（真峰值也压在 −3 dB 以内）。

用法（在任意目录）：
    LIB=@@LEMO_ROOT@@; $LIB/.venv/bin/python @@WORKSPACE_ROOT@@/Desktop/见龙/jianlong/music/score.py

时间：全部按 timeline.json 的全片秒写（绝对时刻），段落交界、旁白起止都从 timeline.json / data/words.json 读来核对。
调式：现在段 D 羽（D F G A C，悬疑）→ 闪回 F 宫（同一组音，以 F 为主，温暖）→ 见龙 D 宫（D E F# A B，同一个主音由暗转明）。
主题「老调」：守村老人哼的那支曲子，S03 二胡初现，S05 镜片回放（手铃），闪回里箫（长笛低音区代替）接着唱，S18 转成大调全奏。
给旁白让中频：旁白在说话时，配乐 700–3500 Hz 再自降约 6 dB（动态均衡，跟旁白真实波形走），旋律句尽量放在旁白的空档里。
确定性：sampler 轮换种子 S.seed(SEED)；pluck 模块自带固定种子；调用顺序固定 → 每次重跑结果一致。
"""
import os, sys, json
import numpy as np, soundfile as sf, soxr
from scipy.signal import butter, sosfilt, sosfiltfilt, resample_poly
from scipy.ndimage import uniform_filter1d, maximum_filter1d

LIB = '@@LEMO_ROOT@@'
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P          # noqa: E402
from core.audio.sfx import SR, add, limit                # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open('@@WORKSPACE_ROOT@@/Desktop/见龙/timeline.json'))
WAV = '@@WORKSPACE_ROOT@@/Desktop/见龙/旁白/wav'
TOTAL = TL['total']                     # 194.5
N = int(round(TOTAL * SR))
SEED = 20261102
S.seed(SEED)

# —— 总线：每条总线自己的混响 ——
BUS = {  # name: (room size, wet mix, damp)
    'dry':  (.45, .18, .55),   # 现在段：小室、雨夜
    'perc': (.55, .16, .60),   # 低音打击
    'warm': (.62, .26, .50),   # 闪回民乐
    'xiao': (.62, .30, .45),   # 箫（长笛低音区 + 低通）
    'big':  (.72, .24, .50),   # 归位、见龙全奏
}
EV = {k: [] for k in BUS}      # sampler 事件
PL = {k: [] for k in BUS}      # pluck 事件
RAW = {k: [] for k in BUS}     # 已经算好的单声道片段（渐强类采样对齐峰值）


def n(bus, t, inst, pitch, dur, vel, pan=0.0, gain=1.0, attack=None, release=None):
    e = dict(t=t, inst=inst, pitch=pitch, dur=dur, vel=vel, pan=pan, gain=gain)
    if attack is not None: e['attack'] = attack
    if release is not None: e['release'] = release
    EV[bus].append(e)


def h(bus, t, inst, var, vel, pan=0.0, gain=1.0, dur=None):
    EV[bus].append(dict(t=t, inst=inst, pitch=var, dur=dur, vel=vel, pan=pan, gain=gain))


def q(bus, t, preset, pitch, dur, vel, pan=0.0, gain=1.0, **kw):
    PL[bus].append((t, preset, pitch, dur, vel, pan, gain, kw))


def line(bus, t0, inst, notes, vel, pan=0.0, legato=1.08, gain=1.0, release=None):
    """notes = [(音, 秒), …] 顺次排；返回结束时刻"""
    t = t0
    for p, d in notes:
        if p is not None: n(bus, t, inst, p, d * legato, vel, pan, gain, release=release)
        t += d
    return t


def swell_to(bus, t_peak, inst, var, vel, pan=0.0, gain=1.0, tail=.35):
    """渐强类采样（吊镲渐强、大鼓渐强）：把采样的最响点对准 t_peak，最响点后 tail 秒淡出"""
    x = S.hit(inst, var, vel).astype(np.float32)
    e = np.sqrt(uniform_filter1d(x ** 2, int(.05 * SR)))
    k = int(np.argmax(e)); cut = min(len(x), k + int(tail * SR))
    x = x[:cut].copy(); f = min(int(tail * SR), len(x)); x[-f:] *= np.linspace(1, 0, f) ** 2
    RAW[bus].append((t_peak - k / SR, x, gain, pan))


# =====================================================================
# A. S01–S05  0–52 s  雨夜悬疑（D 羽，无固定拍，稀疏）
# =====================================================================
# S01 0–9.5：黑场雨声 → 1.0 镜片描框 → 2.85 对焦 → 3.7 片名刀刻 → 4.5 旁白
n('dry', 1.2, 'vibraphone_bowed', 'A5', 6.8, .30, .30, attack=1.6)          # 镜片亮起的一丝高音
n('dry', 2.0, 'cellos', 'D3', 16.5, .40, -.20, attack=2.2)                    # 低音 D 一直托到 S02 末
n('dry', 2.4, 'cellos', 'A3', 7.1, .30, .20, attack=2.0)
n('perc', 3.70, 'timpani', 'D3', 2.5, .55, 0)                                 # 片名落下的低音一击
h('perc', 3.70, 'gran_cassa', 'hit', .32)
h('perc', 3.72, 'gong', None, .22, .10)
n('perc', 3.70, 'contrabass_pizz', 'D2', 2.0, .60, -.10)
n('dry', 5.6, 'harp', 'D6', 3.0, .26, .40)
n('dry', 7.3, 'harp', 'A5', 3.0, .24, -.35)

# S02 9.5–19：入村，低音拨弦像脚步一样慢慢走；18.5「还亮着」→ 一声暖手铃
for t, p in zip([9.5, 11.5, 13.5, 15.5, 17.5], ['D2', 'D2', 'C2', 'D2', 'A1']):
    n('perc', t, 'contrabass_pizz', p, 1.6, .44, -.10)
n('dry', 9.5, 'cellos', 'C4', 5.0, .22, .25, attack=1.2)
n('dry', 14.5, 'cellos', 'A3', 4.6, .22, .25, attack=1.2)
n('dry', 12.0, 'vibraphone_bowed', 'G5', 3.2, .22, .35, attack=1.0)
n('dry', 15.2, 'vibraphone_bowed', 'F5', 3.0, .20, -.30, attack=1.0)
n('dry', 18.50, 'hand_chimes', 'F5', 3.0, .34, .20)

# S03 19–34.5：穿窗进屋，雨声退到窗外；古琴零星；29.6 旁白「老调」落下后，二胡第一次唱出老调
n('dry', 19.0, 'cellos', 'D3', 10.6, .28, -.15, attack=1.6)
n('dry', 22.0, 'cellos', 'F3', 7.4, .18, .20, attack=2.0)
q('warm', 19.30, 'guqin', 'D3', 4.0, .55, -.10)
q('warm', 22.60, 'guqin', 'A3', 3.5, .40, .10)
q('warm', 25.10, 'guqin', 'G3', 3.5, .40, -.05, bend=[(0, 0), (.5, 0), (.9, 2)])
q('warm', 27.80, 'guqin', 'D4', 3.0, .38, .10, harmonic=True)
OLD = [('A4', .9), ('C5', .45), ('D5', 1.2), ('C5', .45), ('A4', .45), ('G4', .9), ('A4', 1.1)]   # 老调（D 羽）
line('dry', 29.70, 'erhu', OLD, .36, -.15, release=.9)
q('warm', 29.70, 'guqin', 'D3', 3.0, .38, .15)
q('warm', 32.80, 'guqin', 'G3', 2.5, .30, .15)
n('dry', 29.7, 'cellos', 'D3', 5.6, .20, .10, attack=1.5)

# S04 34.5–42.5：嘱托。高音颤弓 + 低音小二度压着，38.9 全部收掉——「要记住」（40.0–40.56）在静里说出，随后一记低音
n('dry', 35.3, 'violins_trem', 'A5', 3.6, .20, .30, attack=2.0, release=.35)
n('dry', 35.0, 'cellos', 'D3', 3.9, .32, -.15, attack=.8, release=.4)
n('dry', 36.5, 'cellos', 'Eb3', 2.4, .20, .15, attack=1.2, release=.4)
n('perc', 40.62, 'timpani', 'D3', 3.0, .75, 0)
h('perc', 40.62, 'gran_cassa', 'hit', .45)
h('perc', 40.64, 'gong', None, .28, -.10)
n('perc', 40.62, 'contrabass_pizz', 'D2', 2.5, .68, 0)
n('dry', 41.2, 'cellos', 'D3', 10.8, .20, -.10, attack=1.4)                    # 低音一直托进 S05

# S05 42.5–52：雨夜檐下，镜片回放老调 → 鹿影浮现。老调交给高音手铃（像镜片里放出来），弓奏颤音琴铺光
n('dry', 42.8, 'vibraphone_bowed', 'D6', 7.5, .22, .35, attack=1.6)
n('dry', 43.6, 'glass', 'A5', 4.0, .22, -.40)
for t, p, pan in [(44.6, 'A5', -.3), (45.8, 'C6', .3), (46.6, 'D6', -.2), (48.2, 'C6', .3),
                  (49.0, 'A5', -.3), (49.8, 'G5', .2), (51.0, 'A5', 0)]:
    n('dry', t, 'hand_chimes', p, 2.5, .25, pan)
line('xiao', 50.95, 'flute', [('A4', .5), ('G4', .35), ('D4', .9)], .30, -.10)  # 箫一口气，引进 S06

# =====================================================================
# B. S06–S09  52–85 s  渐紧（D 羽，拍子立起来：S06 每秒一拍 → S07 八分音符 → 绝境处压低）
# =====================================================================
# S06 52–61.5：应验
for i, p in enumerate(['D2', 'D2', 'A1', 'D2', 'C2', 'D2', 'A1', 'D2', 'F2', 'D2']):
    n('perc', 52.0 + i, 'contrabass_pizz', p, .9, .52 if i % 3 == 0 else .42, -.10)
for t in [52.0, 55.0, 58.0, 61.0]:
    h('perc', t, 'log_drum', 'lo', .30, .15)
n('perc', 52.0, 'timpani', 'D3', 2.0, .50, 0)
n('dry', 52.0, 'cellos', 'D3', 9.4, .30, -.15, attack=.8)
n('dry', 56.0, 'cellos', 'A3', 5.4, .24, .15, attack=1.2)
n('dry', 57.0, 'horn', 'D3', 4.3, .30, .05, attack=1.0)                      # 传说落了地
n('dry', 52.5, 'vibraphone_bowed', 'A5', 8.5, .17, .30, attack=1.5)

# S07 61.5–70：绝境。八分音符、3+3+2 重音，低音小二度；67.0 起全部收掉，只剩一根低音（绝境处压低）
for i in range(11):                                   # 61.5 … 66.5
    t = 61.5 + .5 * i; acc = (i % 8) in (0, 3, 6)
    n('perc', t, 'contrabass_pizz', 'D2', .45, .62 if acc else .42, -.10)
for t in [61.5, 63.0, 64.5, 65.5]:
    h('perc', t, 'toms', 'low_mallet', .42, .20)
n('perc', 61.5, 'timpani', 'D3', 2.0, .60, 0)
n('dry', 61.5, 'cellos', 'D3', 5.6, .38, -.15, attack=.4, release=.5)
n('dry', 62.5, 'cellos', 'Eb3', 4.6, .26, .15, attack=.8, release=.5)
swell_to('perc', 66.9, 'gran_cassa', 'cresc', .42, 0, tail=.30)                 # 泥石流的低频涌上来，67.0 断
n('perc', 67.0, 'contrabass', 'D2', 3.4, .32, 0, attack=.5)
n('dry', 67.2, 'cellos', 'D3', 3.3, .16, -.10, attack=.8)
h('dry', 67.2, 'sus_cymbal', 'bow', .14, .30, dur=3.4)

# S08 70–75：头灯山路横移。竖琴低音型轻轻走，古琴回应口诀「项横生，眼朝东」
for i in range(10):
    n('dry', 70.0 + .5 * i, 'harp', ['D3', 'A3', 'C4', 'A3'][i % 4], .6, .25, -.20 + .1 * (i % 4))
n('dry', 70.0, 'cellos', 'D3', 5.0, .24, -.10, attack=.6)
q('warm', 71.30, 'guqin', 'A3', 2.0, .45, .15)
q('warm', 73.30, 'guqin', 'D4', 1.2, .45, .10)
q('warm', 73.80, 'guqin', 'C4', 1.2, .40, .05)
q('warm', 74.30, 'guqin', 'A3', 2.5, .42, 0, bend=[(0, 0), (.4, 0), (.8, -2)])

# S09 75–85：老人醒来指白石低吟。只留低音长音和零星竖琴，83.9 古琴一声后归于寂静
n('dry', 75.0, 'cellos', 'D3', 8.6, .26, -.15, attack=1.0)
n('dry', 77.5, 'cellos', 'A3', 6.0, .20, .15, attack=1.5)
for t, p in [(76.0, 'D4'), (79.0, 'A4'), (82.0, 'C5')]:
    n('dry', t, 'harp', p, 2.5, .24, .25)
n('dry', 81.0, 'vibraphone_bowed', 'A5', 4.4, .18, .30, attack=1.5)
q('warm', 83.95, 'guqin', 'D3', 2.5, .36, 0)

# S10 85–89：心跳段，配乐静默（由总包络在 85.9–89.0 归零），只留音效里的心跳

# =====================================================================
# C. S11  89–99.5 s  归位起势（D 羽 → 98.0 全奏，99.5 落向 F，转入闪回）
# =====================================================================
n('big', 89.0, 'timpani', 'D3', 3.0, .85, 0)                                   # 静默后的第一声
h('big', 89.0, 'gran_cassa', 'hit', .60)
n('big', 89.0, 'tubular_bells', 'D5', 4.0, .42, .20)
n('big', 89.0, 'contrabass_pizz', 'D2', 2.0, .70, 0)
h('big', 89.02, 'gong', None, .32, -.10)
n('big', 89.0, 'cellos', 'D3', 9.2, .34, -.20, attack=.3)
n('big', 89.0, 'cellos', 'A3', 9.2, .28, .20, attack=.6)
for i in range(16):                                   # 89.5 … 97.0 竖琴上行音型，逐渐加力
    n('big', 89.5 + .5 * i, 'harp', ['D3', 'A3', 'D4', 'F4', 'A4', 'F4', 'D4', 'A3'][i % 8], .7, .30 + .012 * i, -.30 + .08 * (i % 8))
for i in range(8):
    n('big', 90.0 + i, 'contrabass_pizz', ['D2', 'A1', 'D2', 'C2'][i % 4], .9, .50, -.10)
n('big', 92.0, 'violins', 'D5', 6.2, .24, .30, attack=2.5)
n('big', 94.0, 'violins', 'A5', 4.2, .24, -.30, attack=2.0)
n('big', 93.5, 'horn', 'A3', 4.6, .34, .10, attack=1.5)
n('big', 95.0, 'horn', 'D4', 3.2, .34, -.10, attack=1.2)
for t, v in [(96.5, .40), (97.0, .45), (97.4, .50), (97.7, .55), (97.85, .60)]:
    n('big', t, 'timpani', 'A2', .8, v, 0)
swell_to('big', 98.0, 'sus_cymbal', 'cresc', .45, 0, tail=.8)
# 98.0（旁白 97.97 刚说完）全奏落下
n('big', 98.0, 'timpani', 'D3', 2.0, .90, 0)
h('big', 98.0, 'gran_cassa', 'hit', .65)
n('big', 98.0, 'tubular_bells', 'D5', 3.0, .55, .20)
n('big', 98.0, 'tubular_bells', 'A4', 3.0, .45, -.20)
for p, pan in [('D3', -.15), ('A3', .15), ('D4', 0)]:
    n('big', 98.0, 'horn', p, 1.4, .50, pan, release=.7)
for p, pan in [('D5', .25), ('A5', -.25)]:
    n('big', 98.0, 'violins', p, 1.4, .40, pan, release=.7)
for p, pan in [('D3', -.2), ('A3', .2)]:
    n('big', 98.0, 'cellos', p, 1.4, .45, pan, release=.7)
n('big', 98.0, 'contrabass', 'D2', 1.4, .40, 0, release=.7)
# 99.5：刻线褪成宣纸——全奏散去，落到 F 上，古琴泛音开门
q('warm', 99.55, 'guqin', 'F4', 5.0, .50, 0, harmonic=True)
n('warm', 99.55, 'hand_chimes', 'C6', 3.0, .22, .30)

# =====================================================================
# D. S12–S17  99.5–176 s  闪回：温暖民乐（F 宫；古琴、箫、大提琴；每段大字落下时古琴一声低音）
# =====================================================================
def cello_pad(segs, vel=.28, vel2=.20):
    for t, a, b, d in segs:
        n('warm', t, 'cellos', a, d, vel, -.20, attack=2.0)
        n('warm', t + .2, 'cellos', b, d - .2, vel2, .20, attack=2.0)

# S12 角·救命田 99.5–113.5（大字 102.1，旁白 102.5–112.47）
cello_pad([(99.6, 'F3', 'C4', 6.6), (106.0, 'D3', 'A3', 4.2), (110.0, 'F3', 'C4', 3.6)])
line('xiao', 100.40, 'flute', [('C5', .5), ('D5', .5), ('F5', 1.0)], .34, .10)
q('warm', 102.10, 'guqin', 'F2', 5.0, .58, 0)
q('warm', 104.00, 'guqin', 'C4', 3.0, .34, .15)
q('warm', 106.00, 'guqin', 'D3', 3.0, .38, -.10)
q('warm', 108.00, 'guqin', 'A3', 3.0, .34, .10, bend=[(0, 0), (.4, 0), (.8, 3)])
q('warm', 110.00, 'guqin', 'F4', 3.0, .34, 0, harmonic=True)
line('xiao', 112.50, 'flute', [('A4', .45), ('C5', .8)], .32, .10)

# S13 爪·退豪绅 113.5–124.5（大字 114.5，旁白 115.5–123.55）：多一层低沉手鼓，古琴落指更重
for t in np.arange(113.5, 124.0, 2.0):
    h('warm', float(t), 'frame_drum', 'large_muted', .30, -.15)
cello_pad([(113.6, 'D3', 'A3', 5.4), (119.0, 'F3', 'C4', 5.5)], .30, .22)
q('warm', 114.50, 'guqin', 'D2', 5.0, .62, 0)
q('warm', 116.50, 'guqin', 'A3', 2.5, .40, .15)
q('warm', 118.50, 'guqin', 'G3', 2.5, .40, -.10, bend=[(0, 0), (.4, 0), (.7, 2)])
q('warm', 120.50, 'guqin', 'D4', 2.5, .40, .10)
q('warm', 122.50, 'guqin', 'C4', 1.5, .36, 0)
q('warm', 123.60, 'guqin', 'D4', .6, .46, .10)
q('warm', 123.85, 'guqin', 'C4', .6, .42, .05)
q('warm', 124.10, 'guqin', 'A3', 2.5, .46, 0, bend=[(0, 0), (.3, 0), (.6, -2)])

# S14 眼·守望灯台 124.5–139（大字 125.5，旁白 126.5–137.99）：手铃每 3 秒一盏「灯」，四百年接力
cello_pad([(124.6, 'C3', 'G3', 7.0), (131.5, 'F3', 'C4', 7.5)])
for t, p in [(125.6, 'C6'), (128.6, 'A5'), (131.6, 'C6'), (134.6, 'D6'), (137.6, 'C6')]:
    n('warm', t, 'hand_chimes', p, 2.5, .26, .30)
q('warm', 125.50, 'guqin', 'C3', 5.0, .56, 0)
q('warm', 129.00, 'guqin', 'G3', 3.0, .34, -.10)
q('warm', 133.00, 'guqin', 'A4', 3.0, .34, .10, harmonic=True)
q('warm', 136.00, 'guqin', 'F3', 3.0, .34, 0)
line('xiao', 138.05, 'flute', [('G4', .4), ('A4', .4), ('C5', .9)], .34, .10)

# S15 脊·接力山路 139–152（大字 140，旁白 141–150.76）：大提琴拨弦一步一步往上走，一代接一代
n('warm', 139.2, 'cellos', 'F3', 12.5, .22, -.20, attack=2.0)
walk = ['F2', 'C3', 'D3', 'F3', 'C3', 'D3', 'F3', 'G3', 'D3', 'F3', 'G3']
for i, p in enumerate(walk):
    n('warm', 140.0 + i, 'cellos_pizz', p, .9, .36, .15)
q('warm', 140.00, 'guqin', 'F2', 5.0, .56, 0)
q('warm', 143.50, 'guqin', 'C4', 3.0, .34, .10)
q('warm', 146.50, 'guqin', 'D4', 3.0, .34, -.10)
q('warm', 149.50, 'guqin', 'F4', 3.0, .34, 0, harmonic=True)
line('xiao', 150.80, 'flute', [('C5', .5), ('D5', .5), ('C5', .8)], .34, .10)

# S16 鳞·褪鳞成薪 152–164（大字 153，旁白 154–163.08）：筝（越南筝代替）中高音下行，像满山落叶
cello_pad([(152.1, 'F3', 'A3', 6.0), (158.0, 'D3', 'A3', 6.0)])
for t in [153.5, 156.5, 159.5, 162.0]:
    for j, p in enumerate(['A5', 'G5', 'F5', 'D5', 'C5']):
        n('warm', t + .18 * j, 'dan_tranh', p, 1.8, .22 - .015 * j, .35 - .15 * j)
q('warm', 153.00, 'guqin', 'F2', 5.0, .54, 0)
q('warm', 155.50, 'guqin', 'A3', 3.0, .30, .10)
q('warm', 160.00, 'guqin', 'C4', 3.0, .30, -.10)
line('xiao', 163.10, 'flute', [('F5', .4), ('D5', .4), ('C5', .7)], .32, .10)

# S17 心·白石立约 164–176（大字 165，旁白 166–174.94）：最暖的一段，慢慢加厚，尾部定音鼓推进 S18
cello_pad([(164.1, 'F3', 'C4', 6.0), (170.0, 'D3', 'A3', 6.0)], .32, .24)
n('warm', 168.0, 'horn', 'C4', 6.0, .24, .10, attack=2.0)
n('warm', 170.5, 'violas', 'F4', 5.4, .18, -.25, attack=2.5)
q('warm', 165.00, 'guqin', 'F2', 5.0, .58, 0)
q('warm', 167.50, 'guqin', 'C4', 3.0, .34, .10)
q('warm', 170.00, 'guqin', 'D4', 3.0, .34, -.10, bend=[(0, 0), (.4, 0), (.8, 2)])
q('warm', 172.50, 'guqin', 'F4', 3.0, .34, 0, harmonic=True)
for t, v in [(174.95, .40), (175.30, .48), (175.60, .56), (175.85, .64)]:
    n('perc', t, 'timpani', 'A2', .8, v, 0)
swell_to('big', 176.0, 'sus_cymbal', 'cresc', .40, 0, tail=1.0)
line('dry', 175.00, 'erhu', [('A4', .3), ('B4', .3), ('D5', 1.2)], .42, -.10, release=.8)   # 转入 D 宫

# =====================================================================
# E. S18  176–188 s  见龙：全片最高处（D 宫）
# =====================================================================
n('big', 176.0, 'timpani', 'D3', 3.0, .90, 0)
h('big', 176.0, 'gran_cassa', 'hit', .70)
h('big', 176.02, 'gong', None, .42, -.10)
n('big', 176.0, 'tubular_bells', 'D5', 4.0, .52, .20)
n('big', 176.0, 'tubular_bells', 'A4', 4.0, .40, -.20)
# 低声部：D → B → A → D（185.8）
for t, cb, c1, d in [(176.0, 'D2', 'D3', 4.5), (180.5, 'B1', 'B2', 2.5), (183.0, 'A1', 'A2', 2.8)]:
    n('big', t, 'contrabass', cb, d, .34, 0, attack=.3)
    n('big', t, 'cellos', c1, d, .38, -.20, attack=.4)
    n('big', t, 'cellos', {'D3': 'A3', 'B2': 'F#3', 'A2': 'E3'}[c1], d, .32, .20, attack=.5)
for p, pan in [('D3', -.2), ('F#3', .1), ('A3', .25)]:
    n('big', 176.0, 'horn', p, 4.4, .38, pan, attack=.3)
# 高声部（在旁白频带之上）：D 大 → B 小 → A 挂留
for t, ps, d in [(176.0, ['D5', 'F#5', 'A5'], 4.5), (180.5, ['B4', 'D5', 'F#5'], 2.5), (183.0, ['A4', 'E5', 'B5'], 2.8)]:
    for j, p in enumerate(ps):
        n('big', t, 'violins', p, d, .26, (-.3, 0, .3)[j], attack=.9)
# 176.3–178.5：旁白前，老调转成大调（二胡 + 圆号低八度）
MAJ = [('A4', .5), ('B4', .3), ('D5', .9), ('B4', .3), ('A4', .3)]
line('dry', 176.30, 'erhu', MAJ, .50, -.10, release=.6)
line('big', 176.30, 'horn', [('A3', .5), ('B3', .3), ('D4', .9), ('B3', .3), ('A3', .3)], .36, .15)
n('big', 180.5, 'glockenspiel', 'F#6', 2.0, .24, .30)
n('big', 183.0, 'glockenspiel', 'E6', 2.0, .24, -.30)
# 185.0 起推，185.8（旁白 185.75 说完）最高处
for t, v in [(185.00, .50), (185.30, .60), (185.55, .70)]:
    n('big', t, 'timpani', 'A2', .7, v, 0)
swell_to('big', 185.8, 'gran_cassa', 'roll', .45, 0, tail=.4)
n('big', 185.8, 'timpani', 'D3', 3.0, 1.0, 0)
h('big', 185.8, 'gran_cassa', 'hit', .80)
h('big', 185.8, 'crash', None, .40, .20)
h('big', 185.82, 'gong', None, .50, -.10)
n('big', 185.8, 'tubular_bells', 'D5', 4.0, .68, .25)
n('big', 185.8, 'tubular_bells', 'A4', 4.0, .58, -.25)
for p, pan in [('D3', -.2), ('A3', 0), ('D4', .15), ('F#4', .3)]:
    n('big', 185.8, 'horn', p, 2.2, .56, pan, release=1.4)
for p, pan in [('D5', -.3), ('F#5', -.1), ('A5', .1), ('D6', .3)]:
    n('big', 185.8, 'violins', p, 2.2, .48, pan, release=1.4)
for p, pan in [('D3', -.2), ('A3', .2)]:
    n('big', 185.8, 'cellos', p, 2.2, .52, pan, release=1.4)
n('big', 185.8, 'contrabass', 'D2', 2.2, .44, 0, release=1.4)
line('dry', 185.80, 'erhu', [('D5', .6), ('E5', .4), ('F#5', .4), ('A5', 1.3)], .62, -.05, release=1.2)

# =====================================================================
# F. S19  188–194.5 s  片尾余音收住
# =====================================================================
q('warm', 188.10, 'guqin', 'D5', 5.0, .42, 0, harmonic=True)
n('warm', 188.0, 'cellos', 'D3', 5.8, .22, -.10, attack=.6)
n('warm', 188.2, 'cellos', 'A3', 5.4, .16, .15, attack=1.0)
q('warm', 191.90, 'guqin', 'A4', 3.0, .38, .10, harmonic=True)
line('xiao', 192.30, 'flute', [('D5', 1.6)], .28, 0)
q('warm', 193.00, 'guqin', 'D3', 2.0, .28, 0)


# =====================================================================
# 渲染
# =====================================================================
def render_bus(b):
    buf = S.render(EV[b], dur=TOTAL, master=False) if EV[b] else np.zeros((N, 2), np.float32)
    buf = buf[:N] if len(buf) >= N else np.pad(buf, ((0, N - len(buf)), (0, 0)))
    for t, pr, p, d, v, pan, g, kw in PL[b]:
        add(buf, P.pluck(pr, p, d, v, **kw), t, g, pan)
    for t, x, g, pan in RAW[b]:
        add(buf, x, t, g, pan)
    if b == 'xiao':                                   # 长笛 → 箫色：压掉高频的亮，留气声
        sos = butter(2, 4200, 'low', fs=SR, output='sos'); buf = sosfilt(sos, buf, axis=0).astype(np.float32)
    size, mix, damp = BUS[b]
    return S.room(buf, size=size, mix=mix, damp=damp)


GAIN = {'dry': 1.0, 'perc': 1.0, 'warm': 1.0, 'xiao': .9, 'big': 1.0}
mix = np.zeros((N, 2), np.float32)
for b in BUS:
    mix += render_bus(b) * GAIN[b]

# —— 总包络（dB）：落实情绪曲线；S10 静默；片尾收住 ——
# mix.py 按整轨 RMS 把配乐对齐到旁白下 6 dB，所以这里只管段与段之间的相对起伏：S18 最高、S11 次之，闪回温暖但听得见
AUTO = [(0, 1), (52.0, 1), (61.5, 2), (66.9, 2), (67.4, -3), (70.0, 0), (75.0, 1), (83.9, 1), (85.3, -14), (85.9, -90),
        (88.98, -90), (89.0, -1), (97.9, 2), (99.0, 2), (99.8, 6), (170.0, 6), (175.6, 7), (176.0, 1), (185.7, 1),
        (185.8, 2), (188.0, 2), (189.2, 3), (192.5, 2), (194.35, -90), (TOTAL, -90)]
tt = np.arange(N) / SR
g = 10 ** (np.interp(tt, [a for a, _ in AUTO], [b for _, b in AUTO]) / 20)
g[g < 10 ** (-80 / 20)] = 0.0
mix *= g[:, None].astype(np.float32)

# —— 给旁白让中频：旁白说话时 700–3500 Hz 再降约 6 dB ——
voice = np.zeros(N, np.float32)
for s in TL['segments']:
    v = s.get('vo')
    if not v: continue
    x, sr = sf.read(f"{WAV}/{v['id']}.wav", dtype='float32', always_2d=True); x = x.mean(1)
    if sr != SR: x = soxr.resample(x, sr, SR)
    a = int(round(v['start'] * SR)); voice[a:a + len(x)] += x[:max(0, N - a)]
e = np.sqrt(uniform_filter1d(voice.astype(np.float64) ** 2, int(.03 * SR)) + 1e-12)
on = (20 * np.log10(e) > 20 * np.log10(np.sqrt(np.mean(voice[np.abs(voice) > 1e-3] ** 2))) - 20).astype(np.float64)
on = maximum_filter1d(on, int(.25 * SR))                     # 字间小停顿不放开
on = uniform_filter1d(on, int(.15 * SR))                      # 起落平滑
mid = sosfiltfilt(butter(2, [700, 3500], 'band', fs=SR, output='sos'), mix, axis=0)
mix = (mix - (.5 * on)[:, None] * mid).astype(np.float32)    # −6 dB 左右（零相位带通相减 ≈ 中频凹陷）

# —— 低频平衡：20–120 Hz 相对其余频段不超过约 −3 dB ——
def band_db(x, lo, hi):
    y = sosfilt(butter(4, [lo, hi], 'band', fs=SR, output='sos'), x.mean(1)); return 10 * np.log10(np.mean(y ** 2) + 1e-20)
lo_db, rest_db = band_db(mix, 20, 120), band_db(mix, 120, 12000)
if lo_db - rest_db > -3:
    k = 10 ** ((-3 - (lo_db - rest_db)) / 20)
    low = sosfiltfilt(butter(2, 120, 'low', fs=SR, output='sos'), mix, axis=0)
    mix = (mix + (k - 1) * low).astype(np.float32)

# —— 母带：轻限幅（削掉过尖的瞬态），再按 4× 过采样真峰值归一到 −3 dBFS ——
peak_cap = np.sqrt(np.mean(mix ** 2)) * 10 ** (20 / 20)     # 峰值最多高出整体 RMS 20 dB
mix = np.stack([limit(mix[:, c] / peak_cap, .99) * peak_cap for c in range(2)], 1).astype(np.float32)
tp = np.abs(resample_poly(mix, 4, 1, axis=0)).max()
mix *= np.float32(10 ** (-3.2 / 20) / tp)
mix[-int(.15 * SR):] = 0
out = os.path.join(HERE, 'music', 'score.wav')
sf.write(out, mix, SR, subtype='PCM_24')
used = sorted({e['inst'] for b in EV for e in EV[b]})
print(out, f'{len(mix) / SR:.3f}s', f'峰值 {20 * np.log10(np.abs(mix).max()):.2f} dBFS',
      f'真峰值 {20 * np.log10(np.abs(resample_poly(mix, 4, 1, axis=0)).max()):.2f} dBTP')
print('采样乐器：', ', '.join(used)); print('拨弦建模：', ', '.join(sorted({p[1] for b in PL for p in PL[b]})))
