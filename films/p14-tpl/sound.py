# -*- coding: utf-8 -*-
"""云海浮标 的声音：远风 + 远处水面 + 片名落定时一声玻璃铃 + 很低的持续音，全部用 engine/audio。
由 engine/native/prepare.mjs 调用：PYTHONPATH = 仓库根，BNE_OUT = 输出 wav，BNE_DUR = 片长（秒），BNE_FILM = 作品目录。
玻璃铃的时刻读 film.json 的 events（id = "title" 的帧号）——画面与声音用同一个帧号，改一处两边一起动。
混音按 −16 LUFS 出；交付响度（−14 LUFS、真峰值 ≤ −1 dBTP）由渲染入口按实测线性增益统一做。"""
import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf

from engine.audio import ambience, dsp, mixing, synth

FILM = Path(os.environ.get('BNE_FILM', Path(__file__).resolve().parent))
SPEC = json.loads((FILM / 'film.json').read_text(encoding='utf-8'))
D = float(os.environ.get('BNE_DUR', SPEC['dur']))
OUT = Path(os.environ.get('BNE_OUT', FILM / 'media' / 'mix.wav'))
LAND = next(e['frame'] for e in SPEC['events'] if e['id'] == 'title') / SPEC['fps']

y = np.zeros((dsp.N(D), 2))
wind, _ = ambience.wind(D, 11, 'far')
y += wind * .02
y += ambience.water(D, 12, 'far') * .004
t = dsp.T(D)
drone = sum(np.sin(2 * np.pi * f * t) * g for f, g in [(98.0, 1), (147.0, .5), (196.0, .25)])
dsp.place(y, drone * np.minimum(1, t / 1.2) * .01, 0, 1, 0)
dsp.place(y, synth.glass_tone(880, 1.8, decay=.35, octave=.2), LAND, .05, -.25)   # 铃在左：片名在画左

y = dsp.fade(y, .2, .6)
y, gain, _ = mixing.loudness_to(y, -16.0, -1.5)
OUT.parent.mkdir(parents=True, exist_ok=True)
sf.write(OUT, y, dsp.SR, subtype='PCM_24')
print(f'{OUT}  {D:.2f}s  玻璃铃 {LAND:.3f}s  总增益 {gain:+.1f} dB')
