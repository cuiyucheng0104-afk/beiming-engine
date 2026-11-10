# -*- coding: utf-8 -*-
"""《Hello》声音：拨弦（类古琴，D 宫五声）落在画面打点上，拟音跟着笔走（毛笔擦纸、笔头触纸、钤印），房间底噪托底。
时刻全部来自页面导出的 events.json / timeline.json（engine/render/events.mjs 写出），全部合成、不用外部采样。
运行：在仓库根目录 $BEIMING_PY films/p15-f/mix.py（需要 numpy、scipy、numba、soundfile）；engine/render/build.mjs 会自动调用。
写出：out/mix.wav（48 kHz 立体声，已定到 −14 LUFS、真峰值 ≤ −1.5 dBTP）、out/stems/{music,foley,amb}.wav（未定响度）、
      out/score_onsets.json（哪个音对哪个画面打点，cuecheck 读它）。
声音设计（模版示范的几条，见同目录 README.md "工艺对照"）：
  · 声画同源：笔落定的拍点上一定有一个拨弦起音，cuecheck 逐个核对（偏差 0 ms）；拟音只做"笔在纸上"的质感，不抢音乐
  · 三层：环境（房间底噪）、拟音（笔、印）、音乐（拨弦与泛音）；远山用泛音（轻、远），主峰用低音散音（重、近）
  · 呼吸：题字前那一拍只剩房间底噪（近静默，留底噪免得像掉音），之后的题字与钤印才显得出来
  · 最重要的一声是钤印（B 类：靠前面的安静反衬，不靠最响）：木质闷击 + 纸响 + 一声很轻的铜磬余音
  · 声像跟画面位置走（主峰在左、印在右）；音乐过长混响，拟音只给一点房间感
方法参考："以古琴为主、五声调式、笔画落在拨弦上、静默是真的静、拟音按材质（毛笔是带笔毛颗粒的带通噪声，印是木质闷击加纸响）"
  见 cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md §7（lemo-opuscar@bebbbe1，MIT，LemoLab）；本文件按描述自己写，未复制其代码。
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))   # 仓库根：engine/ 在这里
from engine.audio import cues as CU
from engine.audio.dsp import SR, N, T, rng, bp, lp, hp, fade, pink, place, smoothstep, make_ir, reverb, rms, db
from engine.audio.synth import glass_tone
from engine.audio.mixing import loudness_to
from engine.audio.meter import integrated, true_peak

FILM = CU.load(HERE)
CUE_T = FILM.timeline['t']
DUR = FILM.dur
L = N(DUR)
R = rng(2026)
ON = CU.Onsets()
music, foley, air, room_tone = (np.zeros((L, 2)) for _ in range(4))
HZ = {'D2': 73.42, 'A2': 110.0, 'D3': 146.83, 'E3': 164.81, 'A3': 220.0, 'F#4': 369.99, 'A4': 440.0, 'D6': 1174.66}


# ———— 乐器 ————
def pluck(f, d=3.2, amp=1.0, decay=1.6, bright=0.55, slide=0.0, slide_t=(0.10, 0.55)):
    """拨弦：加法合成，k 次谐波衰减随 k 加快、略带非谐性；起音一小段带通噪声（指甲触弦）；slide 是起音后上滑的半音数（吟）"""
    t = T(d)
    ph = 2 * np.pi * np.cumsum(f * 2 ** (slide * smoothstep(slide_t[0], slide_t[1], t) / 12)) / SR
    x = np.zeros_like(t)
    for k in range(1, 14):
        inh = np.sqrt(1 + 0.00012 * k * k)
        if f * k * inh > 9000:
            break
        x += k ** -1.15 * bright ** (0.35 * (k - 1)) * np.exp(-t / (decay / (1 + 0.55 * (k - 1)))) * np.sin(k * inh * ph + 0.7 * k)
    x *= smoothstep(0, 0.003, t)
    nail = bp(R.standard_normal(len(t)), 700, 4200) * np.exp(-t / 0.012) * 0.07
    return (x + nail) * amp


def harmonic(f, d=3.6, amp=1.0, decay=1.7):
    """泛音：近乎纯的基频加一点八度，软起音、长衰减、轻微颤动"""
    t = T(d)
    x = np.sin(2 * np.pi * f * t) + 0.22 * np.sin(2 * np.pi * 2 * f * t + 0.4) + 0.05 * np.sin(2 * np.pi * 3 * f * t)
    return x * smoothstep(0, 0.006, t) * np.exp(-t / decay) * (1 + 0.03 * np.sin(2 * np.pi * 4.5 * t)) * amp


def bristles(d, bright=1.0, dry=0.0):
    """毛笔擦纸：带通噪声打底，加一层稀疏的笔毛颗粒（越枯越多），包络随行笔起落"""
    n, t = N(d), T(d)
    body = bp(R.standard_normal(n), 900, 5200 * bright)
    grain = np.zeros(n)
    idx = R.integers(0, n, size=max(1, int(d * 90 * (0.5 + dry))))
    grain[idx] = R.uniform(-1, 1, len(idx))
    grain = bp(grain, 1800, 7000)
    env = np.sin(np.pi * t / d) ** 0.6 * (0.75 + 0.25 * np.sin(2 * np.pi * 7 * t))
    return (body * 0.6 + grain * (0.6 + dry) * 3.0) * env


# ———— 拟音与音乐：按事件类型分派（顺序与 events.json 一致，随机数序列因此确定） ————
LAND = {'s1': ('pluck', 'A2', 1.0, 1.9), 's2': ('pluck', 'D3', 0.8, 1.5), 's3': ('harmonic', 'A4', 0.5, 1.8)}
breath = []


def room(e):
    d = e['t1'] - e['t']
    x = hp(lp(pink(N(d), R), 2400), 90)
    x = x / (np.abs(x).max() + 1e-12)
    place(room_tone, fade(np.stack([x, np.roll(x, 397)], 1), 0.4, 0.6) * 0.012, e['t'])


def touch(e):
    t = T(0.25)
    tok = lp(R.standard_normal(len(t)), 1400) * np.exp(-t / 0.02) * 0.12 + np.sin(2 * np.pi * 160 * t) * np.exp(-t / 0.05) * 0.18
    place(foley, tok, e['t'], pan=e['pan'])
    place(music, pluck(HZ['D2'], 3.4, 0.9, decay=2.2, bright=0.45, slide=2), ON.mark(e['t'], e['cue']), pan=e['pan'])


def stroke(e):
    light = e.get('light', 0)
    x = bristles(e['dur'] + 0.08, bright=1.3 if light else (0.75 if e.get('wet') else 1.0), dry=0.6 if light else 0.3)
    pan = np.linspace(e['pan0'], e['pan1'], len(x))
    place(foley, x * (0.05 if light else 0.09), e['t'], pan=pan)


def land(e):
    kind, note, amp, decay = LAND[e['cue']]
    x = pluck(HZ[note], 3.6, amp, decay=decay) if kind == 'pluck' else harmonic(HZ[note], 3.8, amp, decay=decay)
    place(music, x, ON.mark(e['t'], e['cue']), pan=e['pan'])


def mist(e):
    d = e['t1'] - e['t'] + 0.6
    t = T(d)
    x = bp(pink(N(d), R), 250, 1800) * np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2
    x = x / (np.abs(x).max() + 1e-12)
    place(air, np.stack([x, np.roll(x, 911)], 1) * 0.018, e['t'])


def breathe(e):
    breath.append((e['t'], e['t1']))       # 呼吸段：不放任何声音，最后量一下它有多安静


def write(e):
    place(foley, bristles(e['dur'] + 0.05, bright=1.35, dry=0.5) * 0.045, e['t'], pan=e['pan'])


def title(e):
    t0 = ON.mark(e['t'], e['cue'])
    place(music, pluck(HZ['D3'], 3.8, 0.75, decay=2.0), t0, pan=e['pan'] - 0.1)
    place(music, harmonic(HZ['A4'], 3.8, 0.32), t0 + 0.018, pan=e['pan'])
    place(music, harmonic(HZ['F#4'], 3.6, 0.22), t0 + 0.036, pan=e['pan'] + 0.1)


def seal(e):
    t0 = ON.mark(e['t'], e['cue'])
    t = T(0.6)
    f = 95 - 30 * smoothstep(0, 0.08, t)
    thump = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09) * 0.55
    tap = bp(R.standard_normal(len(t)), 200, 1800) * np.exp(-t / 0.012) * 0.35
    crackle = np.zeros(len(t))
    for _ in range(14):
        i = int(R.uniform(0.004, 0.05) * SR)
        crackle[i] += R.uniform(-1, 1)
    place(foley, thump + tap + bp(crackle, 2000, 6500) * 0.6, t0, pan=e['pan'])
    place(music, glass_tone(HZ['D6'], 2.8, 0.9, bright=0.5) * 0.1, t0 + 0.005, pan=e['pan'])


missing = CU.dispatch(FILM.events, {'room': room, 'touch': touch, 'stroke': stroke, 'land': land, 'mist': mist,
                                    'breath': breathe, 'write': write, 'title': title, 'seal': seal})
if missing:
    sys.exit(f'没有处理器的事件类型：{missing}（在 mix.py 里加处理函数，或从 timeline.js 去掉这类事件）')



def hush(x):
    """呼吸段：音乐、拟音、风声连同混响尾巴在 0.3 秒里收掉，段尾 0.1 秒里放回；房间底噪不动（近静默，不是数字零）"""
    t = np.arange(len(x)) / SR
    g = np.ones(len(x))
    for a, b in breath:
        g *= 1 - smoothstep(a - 0.3, a, t) * (1 - smoothstep(b - 0.04, b + 0.06, t))
    return x * g[:, None]


music = hush(reverb(music, make_ir(rt=2.6, pre=0.02, seed=3), wet=0.32))
foley = hush(reverb(foley, make_ir(rt=0.7, pre=0.006, seed=4), wet=0.12))
amb = hush(air) + room_tone
pre = music + foley * 0.9 + amb
mix, gain, _ = loudness_to(pre, -14.0, -1.5)            # 响度在这里定；封装时的两遍 loudnorm 只剩线性微调
out = os.path.join(HERE, 'out')
CU.write(out, mix, {'music': music, 'foley': foley, 'amb': amb})
ON.dump(os.path.join(out, 'score_onsets.json'))
quiet = ' · '.join(f'呼吸段 {a:.2f}–{b:.2f} s RMS {float(db(rms(mix[N(a):N(b)]))):.1f} dBFS' for a, b in breath)
print(f'mix.wav {mix.shape[0] / SR:.3f} s · {integrated(mix):.1f} LUFS · 真峰值 {float(db(true_peak(mix))):.1f} dBTP · '
      f'全片 RMS {float(db(rms(mix))):.1f} dBFS · {quiet} · 音乐打点 {len(ON.tags)} 个')
