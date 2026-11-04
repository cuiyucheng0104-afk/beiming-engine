# -*- coding: utf-8 -*-
"""《北冥》配乐（5.0–10.0 s）：VSCO 2 CE 弦乐长音为主体（采样器与编配工具见 engine/audio/sampler.py、orchestra.py），竖琴、圆号、钟琴、吊镲渐强点缀。

和声（低音一直是 D 持续音，像海平线）：
  5.0  D(add9)  开放五度 + 九音：神秘、打开          vc D3 · va A3 · vn2 E4 · vn1 A4
  6.4  D6       鲲腹从头顶滑过：温柔                  va B3 · vn2 F#4 · vn1 B4
  7.4  G/D (IV) 导航线升上天空：温暖、有希望          va B3 · vn2 G4 · vn1 D5
  8.2  C/D (bVII) 混合利底亚的“托举”，圆号进、吊镲渐强 va C4 · vn2 G4 · vn1 E5
  9.0  D 大三和弦（顶点，片名）：三条上声部同时上行一个全音（C→D、G→A、E→F#），F# 第一次出现＝天亮
  9.6  渐入空气感：低声部收掉，留高音 A5/D6 + 弓奏颤音琴 A5/E6 的泛音空气
顶声部 A4–B4–D5–E5–F#5 是 D 宫五声音阶一路上行（扶摇直上）。
力度：两层采样按力度曲线交叉淡化（弱奏层暗、强奏层亮），音量由同一条曲线控制。
"""
import os
from functools import partial

import numpy as np

from engine.audio import sampler as S, orchestra as O
from engine.audio.dsp import SR, N, smoothstep, undb, db, place, make_ir, reverb, hp, lp, peq, shelf, tp_limit

S.ROOT = S.ROOT or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'samples')
USED = O.USED

# 音乐强度曲线（全局秒，0..1）
# 8.88–8.95 顶点前“吸一口气”（略收），9.02 新和弦全力进；9.35 之后往空气里散
DYN = [(4.9, 0.0), (5.05, 0.16), (5.6, 0.2), (6.4, 0.28), (7.4, 0.42), (8.2, 0.57), (8.75, 0.71),
       (8.88, 0.69), (8.95, 0.66), (9.02, 1.0), (9.35, 0.92), (9.6, 0.72), (9.8, 0.52), (10.0, 0.38)]
HORN_DYN = [(8.1, 0.0), (8.3, 0.22), (8.9, 0.6), (9.02, 0.88), (9.4, 0.7), (9.75, 0.25), (10.0, 0.0)]

sus = partial(O.sus, dyn=DYN)
pluck = O.pluck


def render(dur=10.0, seed=2026):
    """返回 (立体声配乐（含混响）, 各声部干声字典, 和声事件表)"""
    S.seed(seed)
    n = N(dur)
    keys = ['vn1', 'vn2', 'va', 'vc', 'cb', 'hn', 'harp', 'glock', 'cym', 'air']
    B = {k: np.zeros((n, 2)) for k in keys}

    # —— 弦乐长音（重叠约 0.35 s 做连奏；新音 attack 0.35–0.5 s）——
    sus(B['vc'], 'cellos', 'D3', 4.95, 9.85, 0.45, attack=0.35, release=0.7)
    sus(B['vc'], 'cellos', 'G3', 7.38, 9.02, 0.52, gain_db=-3, attack=0.4, release=0.22)   # 内声部 G3→A3 也跟着上行
    sus(B['vc'], 'cellos', 'A3', 8.96, 9.80, 0.52, gain_db=-3, attack=0.12, release=0.6)
    sus(B['cb'], 'contrabass', 'D2', 8.88, 9.82, 0.55, gain_db=-3, attack=0.15, release=0.6, desks=1)

    sus(B['va'], 'violas', 'A3', 4.97, 6.75, 0.25, attack=0.35)
    sus(B['va'], 'violas', 'B3', 6.38, 8.55, 0.25, attack=0.45)
    sus(B['va'], 'violas', 'C4', 8.18, 9.02, 0.25, attack=0.35, release=0.22)
    sus(B['va'], 'violas', 'D4', 8.93, 9.92, 0.25, attack=0.12)
    sus(B['va'], 'violas', 'F#4', 8.93, 9.88, 0.32, gain_db=-2, attack=0.12)

    sus(B['vn2'], 'violins', 'E4', 4.98, 6.75, -0.12, attack=0.35)
    sus(B['vn2'], 'violins', 'F#4', 6.38, 7.75, -0.12, attack=0.45)
    sus(B['vn2'], 'violins', 'G4', 7.38, 9.02, -0.12, attack=0.4, release=0.22)
    sus(B['vn2'], 'violins', 'A4', 8.93, 9.94, -0.12, attack=0.12)
    sus(B['vn2'], 'violins', 'D5', 8.93, 9.90, -0.05, gain_db=-4, attack=0.12)

    sus(B['vn1'], 'violins', 'A4', 5.00, 6.75, -0.45, attack=0.35)
    sus(B['vn1'], 'violins', 'B4', 6.38, 7.75, -0.45, attack=0.45)
    sus(B['vn1'], 'violins', 'D5', 7.38, 8.50, -0.45, attack=0.4)
    sus(B['vn1'], 'violins', 'E5', 8.18, 9.02, -0.45, attack=0.35, release=0.22)
    sus(B['vn1'], 'violins', 'F#5', 8.93, 9.98, -0.45, attack=0.12)
    sus(B['vn1'], 'violins', 'A5', 8.95, 9.98, -0.55, gain_db=-3, attack=0.15)

    # —— 圆号：8.2 跟着 C/D 进来（C4 E4 G4），9.0 同样平行上行到 D4 F#4 A4 ——
    for p0, p1, pan in [('C4', 'D4', -0.05), ('E4', 'F#4', 0.08), ('G4', 'A4', 0.18)]:
        sus(B['hn'], 'horn', p0, 8.18, 9.0, pan, attack=0.35, release=0.2, dyn=HORN_DYN, vels=(0.38, 0.88),
            xf=(0.25, 0.85), desks=1, rng_db=18)
        sus(B['hn'], 'horn', p1, 8.96, 9.95, pan, attack=0.08, release=0.5, dyn=HORN_DYN, vels=(0.38, 0.88),
            xf=(0.25, 0.85), desks=1, rng_db=18)

    # —— 竖琴：8.58–8.96 C 五声音阶（= C/D 的音）加速上行滑奏，9.00 落在 D 大三和弦的分解和弦 ——
    gl = ['D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6']
    for i, p in enumerate(gl):
        u = i / (len(gl) - 1)
        t = 8.58 + 0.38 * (u ** 0.78)
        pluck(B['harp'], 'harp', p, t, 0.42 + 0.30 * u, -0.65 + 0.3 * u, dur=1.4)
    for i, p in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5', 'F#5']):
        pluck(B['harp'], 'harp', p, 9.0 + 0.018 * i, 0.54 - 0.02 * i, -0.5 + 0.1 * i, dur=1.4)

    # —— 钟琴：9.0 两点“日光” ——
    pluck(B['glock'], 'glockenspiel', 'A6', 9.02, 0.32, 0.35, gain_db=-2, dur=1.0)
    pluck(B['glock'], 'glockenspiel', 'D7', 9.07, 0.28, 0.42, gain_db=-4, dur=1.0)

    # —— 吊镲渐强：取 VCSL 渐强样本峰值前 1.0 s，峰值对准 9.0，峰后快速收（像用手捂住）——
    USED.add('sus_cymbal')
    cy = S.hit('sus_cymbal', 'cresc', 0.5).astype(float)
    e = np.sqrt(np.convolve(cy ** 2, np.ones(2400) / 2400, 'same'))
    pk = int(np.argmax(e))
    seg = cy[max(0, pk - N(1.0)):pk + N(0.9)].copy()
    tt = np.arange(len(seg)) / SR
    seg *= smoothstep(0, 0.45, tt) ** 1.5
    seg *= np.where(tt < 1.0, 1.0, np.exp(-(tt - 1.0) / 0.22))
    place(B['cym'], seg, 9.0 - 1.0, 1.0, 0.2)

    # —— 空气感收尾：弓奏颤音琴 A5/E6 + 小提琴 D6 弱奏（只用弱层）——
    sus(B['air'], 'vibraphone_bowed', 'A5', 9.28, 9.98, -0.35, attack=0.35, release=0.5, desks=1,
        dyn=[(9.2, 0.6), (9.6, 0.85), (10.0, 0.7)], vels=(0.8, 0.8))
    sus(B['air'], 'vibraphone_bowed', 'E6', 9.34, 9.98, 0.35, gain_db=-3, attack=0.35, release=0.5, desks=1,
        dyn=[(9.2, 0.6), (9.6, 0.85), (10.0, 0.7)], vels=(0.8, 0.8))
    sus(B['air'], 'violins', 'D6', 9.30, 9.99, -0.15, gain_db=-4, attack=0.4, release=0.5, desks=1,
        dyn=[(9.2, 0.55), (9.6, 0.8), (10.0, 0.7)], vels=(0.3, 0.3))

    # —— 各声部音色与混响（一个“天空里的大厅”）——
    # VSCO 强奏层的小提琴很亮（质心约 4 kHz），按画面的暖色往下压
    B['vn1'] = shelf(B['vn1'], 3200, -4.0, 'high')
    B['vn2'] = shelf(B['vn2'], 3200, -4.0, 'high')
    B['va'] = shelf(B['va'], 3000, -2.0, 'high')
    hall = make_ir(rt=3.2, pre=0.03, tone=(0.9, 1.0, 0.78, 0.5), seed=31)
    wet = {'vn1': 0.42, 'vn2': 0.42, 'va': 0.42, 'vc': 0.40, 'cb': 0.35, 'hn': 0.62, 'harp': 0.5,
           'glock': 0.55, 'cym': 0.6, 'air': 0.75}
    bal = {'vn1': 2.0, 'vn2': 1.0, 'va': -1.0, 'vc': -2.5, 'cb': 3.0, 'hn': -5.0, 'harp': -2.0,
           'glock': -2.0, 'cym': -9.0, 'air': 0.0}
    # 9.6 后渐入空气感：低声部和圆号在 9.45–9.9 收掉，只留高音小提琴、竖琴余音和“空气”层
    tt = np.arange(n) / SR
    sink = (1 - smoothstep(9.45, 9.9, tt))[:, None]
    for k in ['vc', 'cb', 'va', 'hn']:
        B[k] = B[k] * sink
    B['vn2'] = B['vn2'] * (1 - 0.6 * smoothstep(9.5, 9.95, tt))[:, None]
    # 竖琴拨弦的瞬态比弦乐高十几 dB，单独用前视限制器削掉 4 dB 尖峰（音色不变），免得母带限制器在顶点前后狠压
    hpk = float(np.abs(B['harp']).max())
    if hpk > 0:
        B['harp'], _ = tp_limit(B['harp'], float(db(hpk)) - 4.0, look=0.002, rel=0.06)
    dry = np.zeros((n, 2))
    send = np.zeros((n, 2))
    for k in keys:
        B[k] = B[k] * undb(bal[k])
        dry += B[k]
        send += B[k] * wet[k]
    mus = dry + reverb(send, hall, wet=1.0, dry=0.0, cross=0.35, hp_in=110.0)
    mus = lp(hp(mus, 38, 2), 11000, 2)
    mus = peq(mus, 280, -1.5, 0.8)
    harmony = [
        {'t': 5.0, 'chord': 'D(add9)', 'notes': ['D3', 'A3', 'E4', 'A4']},
        {'t': 6.4, 'chord': 'D6', 'notes': ['D3', 'B3', 'F#4', 'B4']},
        {'t': 7.4, 'chord': 'G/D', 'notes': ['D3', 'B3', 'G4', 'D5']},
        {'t': 8.2, 'chord': 'C/D', 'notes': ['D3', 'C4', 'G4', 'E5', '圆号 C4 E4 G4']},
        {'t': 8.58, 'chord': '竖琴滑奏', 'notes': gl},
        {'t': 9.0, 'chord': 'D', 'notes': ['D2', 'D3', 'A3', 'D4', 'F#4', 'A4', 'D5', 'F#5', 'A5', '圆号 D4 F#4 A4', '钟琴 A6 D7']},
        {'t': 9.3, 'chord': '空气感', 'notes': ['颤音琴(弓奏) A5 E6', '小提琴 D6 弱奏']},
    ]
    return mus, B, harmony
