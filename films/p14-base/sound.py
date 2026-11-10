# -*- coding: utf-8 -*-
"""浮标 的声音：远风 + 远处水面 + 字幕出现时一声玻璃铃 + 很低的持续音，全部用 engine/audio。
由 engine/native/prepare.mjs 调用：PYTHONPATH = 仓库根，BNE_OUT = 输出 wav，BNE_DUR = 片长（秒）。"""
import os
from pathlib import Path

import numpy as np
import soundfile as sf

from engine.audio import ambience, dsp, mixing, synth

D = float(os.environ.get('BNE_DUR', '3'))
OUT = Path(os.environ.get('BNE_OUT', 'media/mix.wav'))
y = np.zeros((dsp.N(D), 2))

wind, _ = ambience.wind(D, 11, 'far')
y += wind * .02
y += ambience.water(D, 12, 'far') * .004
t = dsp.T(D)
drone = sum(np.sin(2 * np.pi * f * t) * g for f, g in [(98.0, 1), (147.0, .5), (196.0, .25)])
dsp.place(y, drone * np.minimum(1, t / 1.2) * .01, 0, 1, 0)
dsp.place(y, synth.glass_tone(880, 1.8, decay=.35, octave=.2), .5, .05, .15)

y = dsp.fade(y, .2, .4)
y, gain, _ = mixing.loudness_to(y, -16.0, -1.5)
OUT.parent.mkdir(parents=True, exist_ok=True)
sf.write(OUT, y, dsp.SR, subtype='PCM_24')
print(f'{OUT}  {D:.2f}s  总增益 {gain:+.1f} dB')
