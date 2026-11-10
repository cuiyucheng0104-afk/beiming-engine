# -*- coding: utf-8 -*-
"""《概念样片》声音：玻璃质的音乐打点 + 拟音（毛笔、钤印、纸面底噪）→ out/mix.wav、out/stems/、out/score_onsets.json。
时刻全部来自页面导出的 events.json / timeline.json（node engine/render/events.mjs films/p15-base），全部合成、无外部采样。
运行：在仓库根目录 $BEIMING_PY films/p15-base/mix.py（需要 numpy、scipy、numba、soundfile）；engine/render/build.mjs 会自动调用。
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..')))   # 仓库根：engine/ 在这里
from engine.audio import cues as CU
from engine.audio.dsp import SR, N, T, rng, bp, lp, fade, norm, pink, place
from engine.audio.synth import glass_tone

FILM = CU.load(HERE)
TEMPO, CUE_T = FILM.tempo, FILM.timeline['t']
DUR = FILM.dur
L = N(DUR)
R = rng(2026)
ON = CU.Onsets()
music, foley, amb = np.zeros((L, 2)), np.zeros((L, 2)), np.zeros((L, 2))

# ———— 音乐：每个打点一个玻璃音（五声音阶），片名一组和弦，钤印一个低音 ————
HZ = {'s1': 587.3, 's2': 659.3, 's3': 784.0}
for k, f in HZ.items():
    place(music, glass_tone(f, 1.4, 0.3, octave=0.2) * 0.5, ON.mark(CUE_T[k], k), pan=-0.3 + 0.3 * list(HZ).index(k))
for i, f in enumerate([392.0, 493.9, 587.3]):
    place(music, glass_tone(f, 1.0, 0.45, bright=0.6) * 0.32, ON.mark(CUE_T['title'], 'title' if i == 0 else None), pan=(i - 1) * 0.4)
place(music, glass_tone(196.0, 0.6, 0.35, octave=0.5) * 0.6, ON.mark(CUE_T['seal'], 'seal'))


# ———— 拟音：按事件类型分派（顺序与 events.json 一致，随机数序列确定） ————
def brush(e):
    d = e['dur']; n = N(d); tt = T(d)
    x = bp(R.standard_normal(n), 900, 5200) * np.sin(np.pi * tt / d) ** 0.7 * (0.7 + 0.3 * np.sin(2 * np.pi * 9 * tt))
    place(foley, fade(x, 0.01, 0.06) * 0.22, e['t'], pan=e.get('pan', 0))


def stamp(e):
    d = 0.35; tt = T(d)
    body = np.sin(2 * np.pi * 95 * tt) * np.exp(-tt / 0.06)
    tap = bp(R.standard_normal(N(d)), 300, 2400) * np.exp(-tt / 0.012)
    place(foley, norm(body + tap * 0.6) * 0.5, e['t'], pan=e.get('pan', 0))


def swell(e):
    d = e['dur']; tt = T(d)
    x = lp(R.standard_normal(N(d)), 1400) * np.sin(np.pi * tt / d) ** 2
    place(foley, x * 0.05, e['t'] - d, pan=0.0)        # 在片名落定前扬起、落定时收住


def room(e):
    d = e['t1'] - e['t']
    x = lp(pink(N(d), R), 2500)
    place(amb, fade(norm(x), 0.3, 0.4) * 0.012, e['t'])


missing = CU.dispatch(FILM.events, {'stroke': brush, 'seal': stamp, 'title': swell, 'room': room})
if missing:
    sys.exit(f'没有处理器的事件类型：{missing}')

mix = norm(music + foley + amb, 0.89)                  # 留余量；响度由 mux.sh 统一到 −14 LUFS
out = os.path.join(HERE, 'out')
CU.write(out, mix, {'music': music, 'foley': foley, 'amb': amb})
ON.dump(os.path.join(out, 'score_onsets.json'))
print(f'mix.wav {mix.shape[0] / SR:.3f} s · 峰值 {np.abs(mix).max():.3f} · 音乐打点 {len(ON.tags)} 个')
