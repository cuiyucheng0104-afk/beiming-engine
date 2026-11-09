# -*- coding: utf-8 -*-
"""{{TITLE}} · 声音：远风铺底 + 片名出现时一声玻璃音，全部程序化合成（engine/audio），同一个种子永远同一段声音。

用法（在仓库根目录）：python films/{{NAME}}/sound.py   → films/{{NAME}}/out/mix.wav（48 kHz 立体声 24 bit）
依赖：requirements.txt（numpy / scipy / numba / soundfile / soxr）。时长读 film.json，和画面对齐。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)

import numpy as np
import soundfile as sf

from engine.audio.dsp import SR, N, T, fade, stereo, make_ir, reverb
from engine.audio.synth import glass_tone
from engine.audio.ambience import wind
from engine.audio.mixing import at, loudness_to

FILM = json.load(open(os.path.join(HERE, 'film.json'), encoding='utf-8'))
D = float(FILM['dur'])
n = N(D)

# 远风：立体声，首尾淡入淡出
bed, _ = wind(D, seed=7, kind='far')
bed = fade(bed[:n], 0.4, 0.6) * 0.5

# 片名淡入（画面 0.8 s 起）时一声玻璃音，稍偏右，进一点混响
TITLE_AT = 0.85
tone = glass_tone(660.0, d=D - TITLE_AT, decay=0.5, octave=0.25) * 0.35
hit = at(stereo(tone, 0.25), TITLE_AT, n)
hit = reverb(hit, make_ir(rt=2.2, seed=3, length=D), wet=0.35)[:n]

mix = bed + hit
mix, gain_db, _ = loudness_to(mix, -18.0, -2.0)   # 封装时 engine/render/mux.sh 还会线性归一到 −14 LUFS

out = os.path.join(HERE, 'out')
os.makedirs(out, exist_ok=True)
path = os.path.join(out, 'mix.wav')
sf.write(path, mix.astype(np.float32), SR, subtype='PCM_24')
print(f'{path}  {len(mix) / SR:.3f} s  增益 {gain_db:+.1f} dB')
